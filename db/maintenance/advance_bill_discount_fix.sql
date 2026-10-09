-- REVIEW ONLY. Not run by any migration. Ends in ROLLBACK: change it to COMMIT only after you have read the output.
--
-- Bills made by "Receive Remaining Payment" before migration 0010 stored a manual adjustment twice: once in
-- orders.discount_amount (shown as "Coupon") and again in orders.manual_discount_amount (shown as "Manual Discount").
-- The bill TOTAL was right (subtotal - one adjustment); only the two discount columns disagree.
--
-- This script moves the doubled amount out of the coupon column for those bills. Nothing else changes: the total, the
-- manual adjustment, stock and the ledger are untouched. It only touches advance-order bills where coupon = manual,
-- and refuses to continue if it would change anything else.
--
-- Run first (read-only) to see the rows:
--   SELECT branch_id, invoice_no, subtotal, discount_amount, manual_discount_amount, total FROM orders
--   WHERE order_type = 'advance_order' AND manual_discount_amount > 0 AND discount_amount = manual_discount_amount;

BEGIN;

-- back-up of what is about to change
CREATE TEMP TABLE _advance_bill_discount_backup AS
SELECT id, branch_id, invoice_no, subtotal, discount_amount, manual_discount_amount, total
FROM public.orders
WHERE order_type = 'advance_order' AND manual_discount_amount > 0 AND discount_amount = manual_discount_amount;

SELECT * FROM _advance_bill_discount_backup ORDER BY invoice_no;

UPDATE public.orders o
SET discount_amount = 0, updated_at = now()
FROM _advance_bill_discount_backup b
WHERE o.id = b.id AND o.branch_id = b.branch_id;

-- after: coupon 0, manual unchanged, total unchanged, and subtotal - coupon - manual = total
SELECT o.branch_id, o.invoice_no, o.subtotal, o.discount_amount AS coupon, o.manual_discount_amount AS manual, o.total,
       (o.subtotal - o.discount_amount - o.manual_discount_amount = o.total) AS adds_up
FROM public.orders o JOIN _advance_bill_discount_backup b ON b.id = o.id AND b.branch_id = o.branch_id
ORDER BY o.invoice_no;

ROLLBACK;  -- change to COMMIT after review
