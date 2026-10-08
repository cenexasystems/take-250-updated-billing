-- REVIEW ONLY: this script changes nothing. Run it in the Neon SQL editor (on a Neon BRANCH first), read the result,
-- then decide whether to run duplicates_cancel.sql.
--
-- A "duplicate" is a second (third, ...) record of the SAME sale made within the same minute: same branch, same
-- customer, same phone and (for bills) the same items and total. The FIRST record of each group is the real one.

-- ---------------------------------------------------------------- 1. POS bills made more than once
WITH g AS (
  SELECT o.*,
         row_number() OVER w AS rn,
         count(*)     OVER w2 AS copies
  FROM public.orders o
  WINDOW w  AS (PARTITION BY o.branch_id, lower(btrim(o.customer_name)), regexp_replace(o.phone, '\D', '', 'g'), md5(o.items::text), o.total, date_trunc('minute', o.created_at) ORDER BY o.created_at, o.invoice_no),
         w2 AS (PARTITION BY o.branch_id, lower(btrim(o.customer_name)), regexp_replace(o.phone, '\D', '', 'g'), md5(o.items::text), o.total, date_trunc('minute', o.created_at))
)
SELECT branch_id, invoice_no, customer_name, phone, total, status, created_at, copies,
       CASE WHEN rn = 1 THEN 'KEEP (first)' ELSE 'DUPLICATE' END AS verdict
FROM g
WHERE copies > 1 AND status <> 'cancelled'
ORDER BY branch_id, date_trunc('minute', created_at), customer_name, rn;

-- stock that would go back to the shelf if the DUPLICATE bills above were cancelled
WITH g AS (
  SELECT o.id, o.branch_id, o.invoice_no,
         row_number() OVER w AS rn, count(*) OVER w2 AS copies
  FROM public.orders o
  WHERE o.status <> 'cancelled'
  WINDOW w  AS (PARTITION BY o.branch_id, lower(btrim(o.customer_name)), regexp_replace(o.phone, '\D', '', 'g'), md5(o.items::text), o.total, date_trunc('minute', o.created_at) ORDER BY o.created_at, o.invoice_no),
         w2 AS (PARTITION BY o.branch_id, lower(btrim(o.customer_name)), regexp_replace(o.phone, '\D', '', 'g'), md5(o.items::text), o.total, date_trunc('minute', o.created_at))
)
SELECT g.branch_id, i.product_name, sum(i.quantity) AS quantity_to_restock
FROM g JOIN public.order_items i ON i.order_id = g.id AND i.branch_id = g.branch_id
WHERE g.copies > 1 AND g.rn > 1 AND NOT i.is_manual
GROUP BY g.branch_id, i.product_name
ORDER BY g.branch_id, i.product_name;

-- ---------------------------------------------------------------- 2. advance / deposit orders made more than once
WITH g AS (
  SELECT a.*,
         row_number() OVER w AS rn,
         count(*)     OVER w2 AS copies
  FROM public.advance_orders a
  WINDOW w  AS (PARTITION BY a.branch_id, lower(btrim(a.customer_name)), regexp_replace(a.phone, '\D', '', 'g'), lower(btrim(a.product_name)), a.total_amount, a.deposit_amount, a.expected_delivery_date, date_trunc('minute', a.created_at) ORDER BY a.created_at, a.deposit_id),
         w2 AS (PARTITION BY a.branch_id, lower(btrim(a.customer_name)), regexp_replace(a.phone, '\D', '', 'g'), lower(btrim(a.product_name)), a.total_amount, a.deposit_amount, a.expected_delivery_date, date_trunc('minute', a.created_at))
)
SELECT branch_id, deposit_id, customer_name, phone, product_name, total_amount, deposit_amount, status, created_at, copies,
       CASE WHEN rn = 1 THEN 'KEEP (first)' ELSE 'DUPLICATE' END AS verdict
FROM g
WHERE copies > 1 AND status <> 'cancelled'
ORDER BY branch_id, date_trunc('minute', created_at), customer_name, rn;

-- ---------------------------------------------------------------- 3. repeated timeline events on advance orders
-- The same bug that made one tap create many advance orders also repeated the history events of a status change.
-- These are exact copies (same order, event, label and second).
SELECT advance_order_id, event_type, label, created_at, count(*) AS copies
FROM public.advance_order_timeline
GROUP BY advance_order_id, event_type, label, created_at
HAVING count(*) > 1
ORDER BY created_at DESC;

-- ---------------------------------------------------------------- 4. totals
SELECT
  (SELECT count(*) FROM public.orders WHERE status <> 'cancelled')          AS live_bills,
  (SELECT count(*) FROM public.advance_orders WHERE status <> 'cancelled')  AS live_advance_orders;
