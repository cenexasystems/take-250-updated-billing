-- 0014 (2026-10-11): per-customer usage limit on coupons.
--
-- coupons.per_customer_limit: how many times ONE customer (canonical phone) may use the coupon in its branch.
-- NULL (every existing coupon) = no per-customer limit: behaviour unchanged. The total usage limit is unchanged.
-- A use = a bill of this branch with this coupon and this phone that is not cancelled or fully returned (the same rule as
-- the existing "Used" status), so a fully returned bill gives the use back.
-- Customer-specific coupons (sent with the toggle on) now follow per_customer_limit, 1 when it is blank (as before).
--
-- Nothing applied is edited, no row is rewritten. Re-created: assert_coupon_redeemable() and coupon_status_for_phone()
-- (both from 0012; see the diff). Safe to re-run.
BEGIN;

ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS per_customer_limit integer;
ALTER TABLE public.coupons DROP CONSTRAINT IF EXISTS coupons_per_customer_limit_check;
ALTER TABLE public.coupons ADD CONSTRAINT coupons_per_customer_limit_check CHECK (per_customer_limit IS NULL OR per_customer_limit >= 1);

-- status of one coupon for one phone: Used once the customer reached the per-customer limit (1 when none is set, as before)
CREATE OR REPLACE FUNCTION public.coupon_status_for_phone(p_branch text, p_coupon_id bigint, p_phone text)
 RETURNS text LANGUAGE sql STABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
           WHEN (SELECT count(*) FROM public.orders o
                  WHERE o.branch_id = c.branch_id AND o.coupon_id = c.id
                    AND public.canonical_phone(o.phone) = public.canonical_phone(p_phone)
                    AND o.status NOT IN ('cancelled', 'returned')) >= COALESCE(c.per_customer_limit, 1) THEN 'used'
           WHEN NOT c.is_active OR (c.expiry_date IS NOT NULL AND c.expiry_date < now()) THEN 'expired'
           WHEN c.usage_limit IS NOT NULL AND c.usage_count >= c.usage_limit THEN 'limit_reached'
           ELSE 'active'
         END
    FROM public.coupons c
   WHERE c.id = p_coupon_id AND c.branch_id = p_branch
$function$;

-- the coupon rules (POS sale: full; any other bill insert, e.g. advance-order completion: customer rules only)
CREATE OR REPLACE FUNCTION public.assert_coupon_redeemable(p_branch text, p_code text, p_phone text, p_full boolean DEFAULT true)
 RETURNS bigint LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  c public.coupons;
  v_phone text := public.canonical_phone(p_phone);
  v_restricted boolean;
  v_limit integer;
  v_uses integer;
BEGIN
  IF p_code IS NULL OR BTRIM(p_code) = '' THEN RETURN NULL; END IF;
  SELECT * INTO c FROM public.coupons
   WHERE branch_id = p_branch AND UPPER(BTRIM(code)) = UPPER(BTRIM(p_code))
   FOR UPDATE;
  IF NOT FOUND THEN
    IF p_full THEN RAISE EXCEPTION 'Invalid coupon code: this coupon does not belong to this branch'; END IF;
    RETURN NULL;
  END IF;
  IF p_full THEN
    IF NOT c.is_active THEN RAISE EXCEPTION 'This coupon is not active'; END IF;
    IF c.expiry_date IS NOT NULL AND c.expiry_date < now() THEN RAISE EXCEPTION 'This coupon has expired'; END IF;
    IF c.usage_limit IS NOT NULL AND c.usage_count >= c.usage_limit THEN RAISE EXCEPTION 'Coupon usage limit has been reached'; END IF;
  END IF;
  v_restricted := EXISTS (SELECT 1 FROM public.coupon_sends s WHERE s.branch_id = p_branch AND s.coupon_id = c.id AND s.customer_specific);
  IF v_restricted THEN
    IF v_phone IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.coupon_sends s
          WHERE s.branch_id = p_branch AND s.coupon_id = c.id AND s.customer_specific AND s.phone = v_phone) THEN
      RAISE EXCEPTION 'This coupon only works for the customer it was sent to. Check the mobile number on the bill.';
    END IF;
  END IF;
  -- 0014: per-customer limit (a customer = canonical phone). A customer-specific coupon without one allows 1 use per phone.
  -- Counted under the coupon row lock taken above, so two bills at the same moment cannot both pass.
  v_limit := COALESCE(c.per_customer_limit, CASE WHEN v_restricted THEN 1 END);
  IF v_limit IS NOT NULL THEN
    IF v_phone IS NULL THEN
      RAISE EXCEPTION 'Enter the customer''s phone number to use this coupon';
    END IF;
    SELECT count(*)::int INTO v_uses FROM public.orders o
     WHERE o.branch_id = p_branch AND o.coupon_id = c.id
       AND public.canonical_phone(o.phone) = v_phone
       AND o.status NOT IN ('cancelled', 'returned');
    IF v_uses >= v_limit THEN
      RAISE EXCEPTION 'You have already used this coupon the maximum number of times';
    END IF;
  END IF;
  RETURN c.id;
END;
$function$;

COMMIT;
