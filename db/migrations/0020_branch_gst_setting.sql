-- 0020: GST per branch in Store Settings. GST is ON at 5% for every branch; each branch's Admin can change the switch and
-- the rate (Admin > Store Settings), and the POS of that branch starts every bill with that branch's setting.
-- store_settings.gst_percent: the branch's default GST rate for a bill (0 - 100). store_settings.gst_enabled already exists
-- (it was never switched on). Existing bills are not touched. Safe to re-run.
BEGIN;

ALTER TABLE public.store_settings ADD COLUMN IF NOT EXISTS gst_percent numeric(5,2) NOT NULL DEFAULT 5;
ALTER TABLE public.store_settings DROP CONSTRAINT IF EXISTS store_settings_gst_percent_range;
ALTER TABLE public.store_settings ADD CONSTRAINT store_settings_gst_percent_range CHECK (gst_percent >= 0 AND gst_percent <= 100);

-- the new default for a branch made later, and 5% / ON for the branches that exist now
ALTER TABLE public.store_settings ALTER COLUMN gst_enabled SET DEFAULT true;
UPDATE public.store_settings SET gst_enabled = true, gst_percent = 5, updated_at = now();

COMMIT;
