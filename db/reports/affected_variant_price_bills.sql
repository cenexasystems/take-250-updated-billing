-- READ-ONLY report (changes no data): bill lines that may have been charged the PRODUCT's price / offer price instead of
-- the SIZE's own price, which a barcode scan did before the fix "pos: scanned barcode uses variant price".
--
-- A line is listed when it has a size (variant_id), the size has a price, the line's unit price equals the product's
-- offer price or price, and that differs from the size's price. Prices are compared with TODAY's catalogue, and a cashier
-- may have edited a rate on purpose, so each line is a candidate to check, not proof of an error.
-- Run with psql against the database you want to inspect, e.g.  psql "$DATABASE_URL" -f db/reports/affected_variant_price_bills.sql
SELECT o.branch_id,
       o.invoice_no,
       o.created_at::date              AS bill_date,
       o.status,
       i.name                          AS item,
       COALESCE(v.variant_name, i.variant_name) AS size,
       i.quantity,
       i.unit_price                    AS charged_unit_price,
       v.price                         AS size_price,
       p.price                         AS product_price,
       p.offer_price                   AS product_offer_price,
       ROUND((v.price - i.unit_price) * i.quantity, 2) AS difference_total
  FROM public.order_items i
  JOIN public.orders o            ON o.id = i.order_id   AND o.branch_id = i.branch_id
  JOIN public.product_variants v  ON v.id = i.variant_id AND v.branch_id = i.branch_id
  JOIN public.products p          ON p.id = COALESCE(i.product_id, v.product_id) AND p.branch_id = i.branch_id
 WHERE i.variant_id IS NOT NULL
   AND v.price > 0
   AND i.unit_price <> v.price
   AND i.unit_price IN (p.price, NULLIF(p.offer_price, 0))
 ORDER BY o.created_at DESC, o.invoice_no;
