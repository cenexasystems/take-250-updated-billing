-- 0018 (2026-10-18): Store Settings "Low stock alert" switch, per branch.
--
-- store_settings.low_stock_alert_enabled: true (default) = the low-stock popup and its sound work as before; false = they
-- are off for that branch (the Staff alert endpoint answers an empty list, the screens stop asking for alerts). The column
-- defaults to true, so every existing branch keeps today's behaviour and a branch made later by register_branch() gets
-- true too (its store_settings insert uses the default). Written only by the Admin-only settings update; read through
-- the existing settings read. Nothing applied is edited and no row is rewritten. Safe to re-run.
BEGIN;

ALTER TABLE public.store_settings ADD COLUMN IF NOT EXISTS low_stock_alert_enabled boolean NOT NULL DEFAULT true;

COMMIT;
