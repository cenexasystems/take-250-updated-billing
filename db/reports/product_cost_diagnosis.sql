-- READ-ONLY diagnosis (changes no data): for each product / size sold in a branch, what the Analytics Products tab sees.
-- One row per (branch, line name, size, variant link): how many bill lines, whether the line still points at a size,
-- whether the product exists, is active, is a POS "Unregistered" placeholder or was deleted, and which costs are entered.
-- Edit the name list at the bottom (or remove that line to list everything).
--   psql "$DATABASE_URL" -f db/reports/product_cost_diagnosis.sql
SELECT o.branch_id,
       i.name                                            AS line_name,
       COALESCE(i.variant_name, '')                      AS size,
       (i.variant_id IS NOT NULL)                        AS has_variant_id,
       count(*)                                          AS bill_lines,
       sum(i.quantity)                                   AS units,
       CASE WHEN i.is_manual OR lower(btrim(COALESCE(p.category, i.category, ''))) = 'unregistered' OR p.category_id = 4 THEN 'unregistered placeholder'
            WHEN i.product_id IS NULL OR p.id IS NULL THEN 'deleted product'
            WHEN NOT p.is_active THEN 'inactive product'
            ELSE 'in catalogue' END                      AS product_state,
       p.has_variants,
       NULLIF(p.purchase_price, 0)                       AS product_cost,
       NULLIF(v.purchase_price, 0)                       AS size_cost,
       p.price                                           AS product_price,
       v.price                                           AS size_price
  FROM public.order_items i
  JOIN public.orders o ON o.id = i.order_id AND o.branch_id = i.branch_id
  LEFT JOIN public.products p ON p.id = i.product_id AND p.branch_id = i.branch_id
  LEFT JOIN public.product_variants v ON v.id = i.variant_id AND v.branch_id = i.branch_id
 WHERE o.status NOT IN ('cancelled')
   AND lower(i.name) IN ('pant bnn', 'testttt', 'testrttt', 'lalith')
 GROUP BY 1, 2, 3, 4, 7, 8, 9, 10, 11, 12
 ORDER BY o.branch_id, i.name, size;
