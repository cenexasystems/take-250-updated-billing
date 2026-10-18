-- 0019 (2026-10-18): Online Enquiries "Delivery date" (Admin only).
--
-- shop_enquiries.delivery_date: the date the shop promised to deliver, optional. Nullable, default NULL, so every existing
-- request is unchanged. Written only by the Admin-only PATCH /api/shop-admin/enquiries/:id, which checks it is a real date,
-- not before the request date and not more than one year ahead (India time). Nothing applied is edited. Safe to re-run.
BEGIN;

ALTER TABLE public.shop_enquiries ADD COLUMN IF NOT EXISTS delivery_date date;

COMMIT;
