-- CLEAN-UP of duplicate bills / advance orders. NOT run automatically: run duplicates_review.sql first and check it.
--
-- What it does (everything in ONE transaction):
--   * every DUPLICATE POS bill (all but the first of each group) is CANCELLED through public.cancel_order():
--     its items go back into stock and a reversing CANCELLATION_RESTOCK movement is written per item
--     (the original SALE movements are kept: nothing is deleted from the ledger);
--   * every DUPLICATE advance order that is still 'pending_deposit' is marked 'cancelled' (nothing is deleted;
--     its deposit record stays for the audit trail: check the cash drawer, the deposit was only received once).
--
-- It ends with ROLLBACK so a first run changes nothing and only shows what WOULD happen.
-- When the output looks right, change the last line from ROLLBACK to COMMIT and run it again.
-- Needs migration 0007 (public.cancel_order). Use a Neon BRANCH before you try this on the main database.

BEGIN;

-- 1. duplicate POS bills -> cancelled + restocked
WITH g AS (
  SELECT o.id, o.branch_id, o.invoice_no,
         row_number() OVER w AS rn, count(*) OVER w2 AS copies
  FROM public.orders o
  WHERE o.status <> 'cancelled'
  WINDOW w  AS (PARTITION BY o.branch_id, lower(btrim(o.customer_name)), regexp_replace(o.phone, '\D', '', 'g'), md5(o.items::text), o.total, date_trunc('minute', o.created_at) ORDER BY o.created_at, o.invoice_no),
         w2 AS (PARTITION BY o.branch_id, lower(btrim(o.customer_name)), regexp_replace(o.phone, '\D', '', 'g'), md5(o.items::text), o.total, date_trunc('minute', o.created_at))
)
SELECT g.branch_id, g.invoice_no,
       public.cancel_order(g.id, g.branch_id, 'cleanup-script', 'Duplicate bill (same customer, items and total within the same minute)') AS result
FROM g
WHERE g.copies > 1 AND g.rn > 1
ORDER BY g.branch_id, g.invoice_no;

-- 2. duplicate advance orders still waiting for their deposit -> cancelled (kept, not deleted)
WITH g AS (
  SELECT a.id, a.branch_id, a.deposit_id, a.status,
         row_number() OVER w AS rn, count(*) OVER w2 AS copies
  FROM public.advance_orders a
  WHERE a.status <> 'cancelled'
  WINDOW w  AS (PARTITION BY a.branch_id, lower(btrim(a.customer_name)), regexp_replace(a.phone, '\D', '', 'g'), lower(btrim(a.product_name)), a.total_amount, a.deposit_amount, a.expected_delivery_date, date_trunc('minute', a.created_at) ORDER BY a.created_at, a.deposit_id),
         w2 AS (PARTITION BY a.branch_id, lower(btrim(a.customer_name)), regexp_replace(a.phone, '\D', '', 'g'), lower(btrim(a.product_name)), a.total_amount, a.deposit_amount, a.expected_delivery_date, date_trunc('minute', a.created_at))
)
UPDATE public.advance_orders a
SET status = 'cancelled',
    remarks = btrim(a.remarks || ' [cancelled: duplicate of an earlier advance order]'),
    updated_at = now()
FROM g
WHERE a.id = g.id AND a.branch_id = g.branch_id AND g.copies > 1 AND g.rn > 1 AND g.status = 'pending_deposit'
RETURNING a.branch_id, a.deposit_id, a.status;

-- 3. repeated history events (exact copies of one event): keep one of each. Only the history list is tidied; no money or stock row is touched.
DELETE FROM public.advance_order_timeline t
USING (
  SELECT ctid AS row_id, row_number() OVER (PARTITION BY advance_order_id, event_type, label, created_at ORDER BY ctid) AS rn
  FROM public.advance_order_timeline
) d
WHERE t.ctid = d.row_id AND d.rn > 1
RETURNING t.advance_order_id, t.event_type, t.label;

-- Optional, only if you really want the duplicate advance orders GONE (their timeline and payment rows go with them):
-- DELETE FROM public.advance_orders WHERE status = 'cancelled' AND remarks LIKE '%[cancelled: duplicate of an earlier advance order]%';

ROLLBACK;   -- <- change to COMMIT after reviewing the output above
