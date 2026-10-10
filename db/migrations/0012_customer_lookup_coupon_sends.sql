-- 0012: POS customer lookup + sending coupons (Admin) + customer-specific coupons.
--
-- Customer data stays per branch: no customer table, no copied rows, no cross-branch keys. A "customer" is a phone
-- number that appears on a bill (orders) or an advance order of a branch. The only cross-branch read is
-- customer_other_branches(): the display NAMES of other branches where the number appears, nothing else.
--
-- Coupons stay branch-owned. coupon_sends records which coupon was sent to which phone (only after the PDF was shared).
-- Coupon usage per customer = the bill's phone + the bill's coupon_id (both already stored on every bill; coupon_id is
-- resolved by set_order_coupon_id inside the bill's own branch). Indexed below on the canonical phone.
--
-- Customer-specific rule: a coupon is RESTRICTED only when Admin sent it with customer_specific = true. A restricted
-- coupon is redeemable only on bills whose phone matches one of its customer-specific sends, once per phone.
-- A coupon never sent, or sent with the toggle off, behaves exactly as before for everyone.
--
-- Next free number after 0011. Nothing applied is edited. Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE). No row is rewritten.
-- Re-created existing objects: set_order_coupon_id() (same lookup + the customer-specific check) and
-- complete_pos_sale_with_inventory() (identical to 0003 plus step 0).
BEGIN;

-- ------------------------------------------------------------ one canonical phone format: the 10-digit Indian mobile
-- "+91 88831 73358", "91 8883173358", "088831 73358", "88831 73358", "8883173358" -> '8883173358'; anything else -> NULL
-- (a number typed with "+" must be +91 and ten digits: "+91 8883 1733" is a partial number, not 9188831733)
CREATE OR REPLACE FUNCTION public.canonical_phone(p text)
 RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT CASE
           WHEN plus THEN CASE WHEN d ~ '^91[6-9][0-9]{9}$' THEN substr(d, 3) END -- "+..." must be +91 and 10 digits
           WHEN d ~ '^[6-9][0-9]{9}$' THEN d
           WHEN d ~ '^91[6-9][0-9]{9}$' THEN substr(d, 3)
           WHEN d ~ '^0[6-9][0-9]{9}$' THEN substr(d, 2)
           ELSE NULL
         END
    FROM (SELECT regexp_replace(COALESCE(p, ''), '[^0-9]', '', 'g') AS d, btrim(COALESCE(p, '')) LIKE '+%' AS plus) s
$function$;

CREATE INDEX IF NOT EXISTS orders_branch_phone_idx ON public.orders (branch_id, public.canonical_phone(phone));
CREATE INDEX IF NOT EXISTS advance_orders_branch_phone_idx ON public.advance_orders (branch_id, public.canonical_phone(phone));
CREATE INDEX IF NOT EXISTS orders_coupon_phone_idx ON public.orders (branch_id, coupon_id, public.canonical_phone(phone)) WHERE coupon_id IS NOT NULL;

-- ------------------------------------------------------------ coupon sends (per branch)
CREATE TABLE IF NOT EXISTS public.coupon_sends (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id         text        NOT NULL REFERENCES public.branches(id),
  coupon_id         bigint      NOT NULL,
  phone             text        NOT NULL CHECK (phone ~ '^[6-9][0-9]{9}$'),
  customer_name     text        NOT NULL DEFAULT '' CHECK (length(customer_name) <= 200),
  sent_by_role      text        NOT NULL CHECK (sent_by_role IN ('admin', 'manager', 'staff')),
  sent_at           timestamptz NOT NULL DEFAULT now(),
  customer_specific boolean     NOT NULL DEFAULT false,
  CONSTRAINT coupon_sends_id_branch_key UNIQUE (id, branch_id),
  CONSTRAINT coupon_sends_coupon_fk FOREIGN KEY (coupon_id, branch_id) REFERENCES public.coupons (id, branch_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS coupon_sends_branch_phone_idx ON public.coupon_sends (branch_id, phone, sent_at DESC);
CREATE INDEX IF NOT EXISTS coupon_sends_restricted_idx ON public.coupon_sends (branch_id, coupon_id, phone) WHERE customer_specific;

-- ------------------------------------------------------------ status of one coupon for one phone (computed here only)
-- used          : a bill of this branch with this coupon and this phone that was not cancelled or fully returned
-- expired       : not used, and past its expiry date (or switched off by Admin)
-- limit_reached : not used, not expired, usage_count >= usage_limit
-- active        : otherwise
CREATE OR REPLACE FUNCTION public.coupon_status_for_phone(p_branch text, p_coupon_id bigint, p_phone text)
 RETURNS text LANGUAGE sql STABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
           WHEN EXISTS (SELECT 1 FROM public.orders o
                         WHERE o.branch_id = c.branch_id AND o.coupon_id = c.id
                           AND public.canonical_phone(o.phone) = public.canonical_phone(p_phone)
                           AND o.status NOT IN ('cancelled', 'returned')) THEN 'used'
           WHEN NOT c.is_active OR (c.expiry_date IS NOT NULL AND c.expiry_date < now()) THEN 'expired'
           WHEN c.usage_limit IS NOT NULL AND c.usage_count >= c.usage_limit THEN 'limit_reached'
           ELSE 'active'
         END
    FROM public.coupons c
   WHERE c.id = p_coupon_id AND c.branch_id = p_branch
$function$;

-- ------------------------------------------------------------ the coupon rules used by the sale function and the order trigger
-- p_full = true  (POS sale): unknown code, inactive, expired, usage limit reached and the customer-specific rule.
-- p_full = false (any other bill insert, e.g. completing an advance order): ONLY the customer-specific rule, so those
--                paths behave exactly as before for every coupon that is not customer-specific.
-- Returns the coupon id of THIS branch (NULL when there is no code, or no such code and p_full = false).
CREATE OR REPLACE FUNCTION public.assert_coupon_redeemable(p_branch text, p_code text, p_phone text, p_full boolean DEFAULT true)
 RETURNS bigint LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  c public.coupons;
  v_phone text := public.canonical_phone(p_phone);
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
  IF EXISTS (SELECT 1 FROM public.coupon_sends s WHERE s.branch_id = p_branch AND s.coupon_id = c.id AND s.customer_specific) THEN
    IF v_phone IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.coupon_sends s
          WHERE s.branch_id = p_branch AND s.coupon_id = c.id AND s.customer_specific AND s.phone = v_phone) THEN
      RAISE EXCEPTION 'This coupon only works for the customer it was sent to. Check the mobile number on the bill.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.orders o
                WHERE o.branch_id = p_branch AND o.coupon_id = c.id
                  AND public.canonical_phone(o.phone) = v_phone
                  AND o.status NOT IN ('cancelled', 'returned')) THEN
      RAISE EXCEPTION 'This coupon has already been used by this customer';
    END IF;
  END IF;
  RETURN c.id;
END;
$function$;

-- orders.coupon_id is still looked up by code within the order's own branch only; a customer-specific coupon is now
-- also checked here, so no path that creates a bill (POS sale, advance-order completion, ...) can bypass it.
CREATE OR REPLACE FUNCTION public.set_order_coupon_id()
 RETURNS trigger LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.coupon_code IS NOT NULL AND BTRIM(NEW.coupon_code) <> '' THEN
    NEW.coupon_id := public.assert_coupon_redeemable(NEW.branch_id, NEW.coupon_code, NEW.phone, false);
  END IF;
  RETURN NEW;
END;
$function$;

-- ------------------------------------------------------------ the ONE cross-branch read of the POS lookup
-- Display names of the OTHER branches where this number is on a bill or an advance order. Nothing else: no customer
-- name, bills, amounts, coupons or counts. The caller's branch comes from the token, never from the client.
CREATE OR REPLACE FUNCTION public.customer_other_branches(p_branch text, p_phone text)
 RETURNS TABLE (branch_name text) LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT b.name
    FROM public.branches b
   WHERE b.id <> p_branch
     AND public.canonical_phone(p_phone) IS NOT NULL
     AND (EXISTS (SELECT 1 FROM public.orders o WHERE o.branch_id = b.id AND public.canonical_phone(o.phone) = public.canonical_phone(p_phone))
       OR EXISTS (SELECT 1 FROM public.advance_orders a WHERE a.branch_id = b.id AND public.canonical_phone(a.phone) = public.canonical_phone(p_phone)))
   ORDER BY b.sort_order, b.id
$function$;

-- ------------------------------------------------------------ POS sale: same function as 0003 plus step 0 (coupon rules)
CREATE OR REPLACE FUNCTION public.complete_pos_sale_with_inventory(p_customer_name text, p_phone text, p_address text, p_items jsonb, p_shipping numeric DEFAULT 0, p_status text DEFAULT 'completed'::text, p_order_mode text DEFAULT 'offline'::text, p_order_type text DEFAULT 'pos_sale'::text, p_delivery_charge numeric DEFAULT 0, p_discount_amount numeric DEFAULT 0, p_manual_discount_amount numeric DEFAULT 0, p_manual_discount_type text DEFAULT 'flat'::text, p_manual_discount_value numeric DEFAULT 0, p_coupon_code text DEFAULT NULL::text, p_coupon_percentage numeric DEFAULT 0, p_payment_method text DEFAULT 'cash'::text, p_split_details jsonb DEFAULT '{}'::jsonb, p_total_gst numeric DEFAULT 0, p_gst_enabled boolean DEFAULT false, p_remarks text DEFAULT NULL::text, p_reference_number text DEFAULT NULL::text, p_billing_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_branch text DEFAULT 'pos1'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID := NULL::uuid;
  v_invoice_no TEXT;
  v_order_id UUID;
  v_subtotal NUMERIC := 0;
  v_total NUMERIC := 0;
  v_item JSONB;
  v_product_id BIGINT;
  v_variant_id UUID;
  v_quantity NUMERIC;
  v_unit_price NUMERIC;
  v_line_total NUMERIC;
  v_product_name TEXT;
  v_name_ta TEXT;
  v_unit TEXT;
  v_unit_type TEXT;
  v_base_quantity NUMERIC;
  v_is_manual BOOLEAN;
  v_discount NUMERIC;
  v_gst_amount NUMERIC;
  v_gst_rate NUMERIC;
  v_image_url TEXT;
  v_variant_name TEXT;
  v_source TEXT;
  v_note TEXT;
  v_category TEXT;
  v_current_stock NUMERIC;
  v_created_at TIMESTAMPTZ := COALESCE(p_billing_date, NOW());
  v_barcode_id UUID;
  v_branch TEXT := public.resolve_branch(p_branch);
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order items cannot be empty';
  END IF;

  -- 0. coupon rules of THIS branch (0012): unknown code, inactive, expired, usage limit reached, or a customer-specific
  --    coupon used with another phone / used again -> rejected here, before any stock moves. Locks the coupon row.
  PERFORM public.assert_coupon_redeemable(v_branch, p_coupon_code, p_phone, true);

  -- 1. Atomic Pre-Validation of Available Stock for All Items (branch-scoped)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := NULLIF(v_item ->> 'product_id', '')::BIGINT;
    v_variant_id := NULLIF(v_item ->> 'variant_id', '')::UUID;
    v_quantity := COALESCE((v_item ->> 'quantity')::NUMERIC, 0);
    v_is_manual := COALESCE((v_item ->> 'is_manual')::BOOLEAN, FALSE);
    v_product_name := COALESCE(v_item ->> 'product_name', v_item ->> 'name', 'Product');

    IF NOT v_is_manual AND v_quantity > 0 THEN
      IF v_variant_id IS NOT NULL THEN
        SELECT stock INTO v_current_stock FROM public.product_variants WHERE id = v_variant_id AND branch_id = v_branch FOR UPDATE;
        IF v_current_stock IS NULL OR v_current_stock < v_quantity THEN
          RAISE EXCEPTION 'Insufficient stock for % (Available: %, Requested: %)', v_product_name, COALESCE(v_current_stock, 0), v_quantity;
        END IF;
      ELSIF v_product_id IS NOT NULL THEN
        SELECT stock_quantity INTO v_current_stock FROM public.products WHERE id = v_product_id AND branch_id = v_branch FOR UPDATE;
        IF v_current_stock IS NULL OR v_current_stock < v_quantity THEN
          RAISE EXCEPTION 'Insufficient stock for % (Available: %, Requested: %)', v_product_name, COALESCE(v_current_stock, 0), v_quantity;
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- 2. Calculate Subtotal & Generate Invoice Number (from this branch's sequence)
  v_invoice_no := public.get_next_invoice_no(v_branch);

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_quantity := COALESCE((v_item ->> 'quantity')::NUMERIC, 0);
    v_unit_price := COALESCE(
      (v_item ->> 'unit_price')::NUMERIC,
      (v_item ->> 'base_price')::NUMERIC,
      (v_item ->> 'price')::NUMERIC,
      0
    );
    v_line_total := COALESCE((v_item ->> 'line_total')::NUMERIC, ROUND(v_quantity * v_unit_price, 2));
    v_subtotal := v_subtotal + v_line_total;
  END LOOP;

  v_total := GREATEST(0, ROUND(v_subtotal + COALESCE(p_shipping, 0) + COALESCE(p_delivery_charge, 0) - COALESCE(p_discount_amount, 0), 2));

  -- 3. Insert Order Record
  INSERT INTO public.orders (
    invoice_no, user_id, customer_name, phone, address, items,
    subtotal, shipping, total, status, order_mode, order_type,
    delivery_charge, discount_amount, manual_discount_amount,
    manual_discount_type, manual_discount_value, coupon_code,
    coupon_percentage, total_gst, gst_amount, gst_enabled,
    payment_method, payment_mode, split_details, remarks,
    reference_number, billing_date, branch_id, created_at, updated_at
  )
  VALUES (
    v_invoice_no, v_user_id, COALESCE(NULLIF(BTRIM(p_customer_name), ''), 'Customer'),
    COALESCE(p_phone, ''), COALESCE(p_address, ''), p_items,
    v_subtotal, COALESCE(p_shipping, 0), v_total, COALESCE(p_status, 'completed'),
    COALESCE(p_order_mode, 'offline'), COALESCE(p_order_type, 'pos_sale'),
    COALESCE(p_delivery_charge, 0), COALESCE(p_discount_amount, 0),
    COALESCE(p_manual_discount_amount, 0), COALESCE(p_manual_discount_type, 'flat'),
    COALESCE(p_manual_discount_value, 0), p_coupon_code,
    COALESCE(p_coupon_percentage, 0), COALESCE(p_total_gst, 0),
    COALESCE(p_total_gst, 0), COALESCE(p_gst_enabled, FALSE),
    COALESCE(p_payment_method, 'cash'), COALESCE(p_payment_method, 'cash'),
    COALESCE(p_split_details, '{}'::JSONB), COALESCE(p_remarks, ''),
    COALESCE(p_reference_number, ''), p_billing_date, v_branch, v_created_at, NOW()
  )
  RETURNING id INTO v_order_id;

  -- 4. Insert Order Items, Deduct Stock (branch-scoped) & Record SALE Movements
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := NULLIF(v_item ->> 'product_id', '')::BIGINT;
    v_variant_id := NULLIF(v_item ->> 'variant_id', '')::UUID;
    v_quantity := COALESCE((v_item ->> 'quantity')::NUMERIC, 0);
    v_unit_price := COALESCE((v_item ->> 'unit_price')::NUMERIC, (v_item ->> 'base_price')::NUMERIC, 0);
    v_line_total := COALESCE((v_item ->> 'line_total')::NUMERIC, ROUND(v_quantity * v_unit_price, 2));
    v_product_name := COALESCE(v_item ->> 'product_name', v_item ->> 'name', 'Product');
    v_name_ta := COALESCE(v_item ->> 'product_tamil_name', v_item ->> 'tamil_name', '');
    v_unit := COALESCE(v_item ->> 'unit', 'piece');
    v_unit_type := COALESCE(v_item ->> 'unit_type', 'unit');
    v_base_quantity := COALESCE((v_item ->> 'base_quantity')::NUMERIC, 1);
    v_is_manual := COALESCE((v_item ->> 'is_manual')::BOOLEAN, FALSE);
    v_discount := COALESCE((v_item ->> 'discount')::NUMERIC, 0);
    v_gst_amount := COALESCE((v_item ->> 'gst_amount')::NUMERIC, 0);
    v_gst_rate := COALESCE((v_item ->> 'gst_rate')::NUMERIC, 0);
    v_image_url := v_item ->> 'image_url';
    v_variant_name := v_item ->> 'variant_name';
    v_source := COALESCE(v_item ->> 'source', 'catalogue');
    v_note := v_item ->> 'note';
    v_category := v_item ->> 'category';

    INSERT INTO public.order_items (
      order_id, product_id, variant_id, product_name, name,
      product_tamil_name, tamil_name, quantity, unit, unit_type,
      base_quantity, base_price, unit_price, line_total, image_url,
      is_manual, discount, gst_amount, gst_rate, variant_name,
      source, note, category, created_at
    )
    VALUES (
      v_order_id, v_product_id, v_variant_id, v_product_name, v_product_name,
      v_name_ta, v_name_ta, v_quantity, v_unit, v_unit_type,
      v_base_quantity, v_unit_price, v_unit_price, v_line_total, v_image_url,
      v_is_manual, v_discount, v_gst_amount, v_gst_rate, v_variant_name,
      v_source, v_note, v_category, v_created_at
    );

    -- Deduct Stock and Insert SALE Movement (branch-scoped)
    IF NOT v_is_manual AND v_quantity > 0 THEN
      IF v_variant_id IS NOT NULL THEN
        SELECT stock INTO v_current_stock FROM public.product_variants WHERE id = v_variant_id AND branch_id = v_branch;
        SELECT id INTO v_barcode_id FROM public.barcode_registry WHERE variant_id = v_variant_id AND branch_id = v_branch AND is_active = TRUE LIMIT 1;

        UPDATE public.product_variants
        SET stock = GREATEST(0, stock - v_quantity), updated_at = NOW()
        WHERE id = v_variant_id AND branch_id = v_branch;

        -- Parent aggregate update
        UPDATE public.products
        SET stock_quantity = (SELECT COALESCE(SUM(stock), 0) FROM public.product_variants WHERE product_id = v_product_id AND is_active = TRUE),
            stock = FLOOR((SELECT COALESCE(SUM(stock), 0) FROM public.product_variants WHERE product_id = v_product_id AND is_active = TRUE))::INTEGER,
            updated_at = NOW()
        WHERE id = v_product_id AND branch_id = v_branch;

        INSERT INTO public.inventory_movements (
          product_id, variant_id, barcode_id, movement_type,
          quantity_delta, quantity_before, quantity_after,
          reference_type, reference_id, note, branch_id
        )
        VALUES (
          v_product_id, v_variant_id, v_barcode_id, 'SALE',
          -v_quantity, v_current_stock, GREATEST(0, v_current_stock - v_quantity),
          'order', v_invoice_no, 'POS Sale checkout', v_branch
        );

      ELSIF v_product_id IS NOT NULL THEN
        SELECT stock_quantity INTO v_current_stock FROM public.products WHERE id = v_product_id AND branch_id = v_branch;
        SELECT id INTO v_barcode_id FROM public.barcode_registry WHERE product_id = v_product_id AND variant_id IS NULL AND branch_id = v_branch AND is_active = TRUE LIMIT 1;

        UPDATE public.products
        SET stock_quantity = GREATEST(0, stock_quantity - v_quantity),
            stock = GREATEST(0, stock - FLOOR(v_quantity)::INTEGER),
            updated_at = NOW()
        WHERE id = v_product_id AND branch_id = v_branch;

        INSERT INTO public.inventory_movements (
          product_id, variant_id, barcode_id, movement_type,
          quantity_delta, quantity_before, quantity_after,
          reference_type, reference_id, note, branch_id
        )
        VALUES (
          v_product_id, NULL, v_barcode_id, 'SALE',
          -v_quantity, v_current_stock, GREATEST(0, v_current_stock - v_quantity),
          'order', v_invoice_no, 'POS Sale checkout', v_branch
        );
      END IF;
    END IF;
  END LOOP;

  -- 5. Increment Coupon Usage Count (coupons are scoped to this branch)
  IF p_coupon_code IS NOT NULL AND BTRIM(p_coupon_code) <> '' THEN
    UPDATE public.coupons
    SET usage_count = usage_count + 1, updated_at = NOW()
    WHERE UPPER(BTRIM(code)) = UPPER(BTRIM(p_coupon_code)) AND branch_id = v_branch;
  END IF;

  RETURN jsonb_build_object(
    'order_id', v_order_id,
    'invoice_no', v_invoice_no,
    'total', v_total
  );
END;
$function$;

COMMIT;
