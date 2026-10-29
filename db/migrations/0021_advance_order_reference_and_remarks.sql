-- 0021 (2026-10-29): advance_orders — store reference_number and propagate it + remarks to the final bill.
--
-- Root-cause summary
-- ─────────────────
-- reference_number: the advance_orders table never had this column.  The API route accepted the value
--   (Zod allowed it) and even patched the in-memory object that was returned to the browser, but the
--   comment in advance.ts confirmed it was intentionally discarded ("reference_number is accepted but
--   not stored: the original database had no such column").  create_advance_order() had no parameter
--   for it; the INSERT never included it.
-- remarks: the column existed on advance_orders and was stored correctly on creation, but
--   complete_advance_order_v2 never included either field in the INSERT INTO public.orders, so the
--   final bill (which is what Order History and every invoice renderer read) always showed blank/dash.
--
-- Changes
-- ───────
-- 1. New column: advance_orders.reference_number text NULL DEFAULT NULL.
--    Nullable so every existing row is unchanged.  Old rows have NULL; normalised to '' by the
--    advanceOrderService TypeScript layer, so nothing breaks on screen.
-- 2. create_advance_order() gets a new optional p_reference_number parameter (default NULL);
--    when non-empty after trim() it is written into the new column.
-- 3. complete_advance_order_v2() copies v_advance.reference_number and v_advance.remarks onto the
--    orders row so every output that reads orders (Order History, View Invoice, PDF, thermal,
--    digital page) sees them.  Billing maths are not changed.
-- Safe to re-run (IF NOT EXISTS on ALTER; CREATE OR REPLACE on functions).

BEGIN;

-- 1. New column
ALTER TABLE public.advance_orders
  ADD COLUMN IF NOT EXISTS reference_number text;


-- 2. create_advance_order — accept and store reference_number
--
-- The function signature gains one optional trailing parameter so every existing call-site that
-- already passes 14 positional args keeps working without any change.
CREATE OR REPLACE FUNCTION public.create_advance_order(
  p_customer_name          text,
  p_phone                  text,
  p_address                text,
  p_product_name           text,
  p_category               text,
  p_description            text,
  p_total_amount           numeric,
  p_deposit_amount         numeric,
  p_expected_delivery_date date,
  p_remarks                text,
  p_payment_method         text,
  p_created_by_name        text,
  p_products               jsonb  DEFAULT '[]'::jsonb,
  p_branch                 text   DEFAULT 'pos1'::text,
  p_reference_number       text   DEFAULT NULL::text
)
 RETURNS advance_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order      public.advance_orders;
  v_now        timestamptz := now();
  v_deposit_id text;
  v_branch     text := public.resolve_branch(p_branch);
  v_ref        text := nullif(trim(coalesce(p_reference_number, '')), '');
BEGIN
  IF trim(coalesce(p_customer_name,'')) = '' THEN RAISE EXCEPTION 'Customer name is required'; END IF;
  IF trim(coalesce(p_phone,'')) = ''         THEN RAISE EXCEPTION 'Phone number is required'; END IF;
  IF trim(coalesce(p_product_name,'')) = ''  THEN RAISE EXCEPTION 'Product name is required'; END IF;
  IF coalesce(p_total_amount,0) <= 0         THEN RAISE EXCEPTION 'Total amount must be greater than zero'; END IF;
  IF coalesce(p_deposit_amount,0) <= 0 OR p_deposit_amount >= p_total_amount
    THEN RAISE EXCEPTION 'Deposit must be greater than zero and less than the total amount'; END IF;
  IF lower(coalesce(p_payment_method,'')) NOT IN ('cash','upi','card')
    THEN RAISE EXCEPTION 'Select a valid deposit payment method'; END IF;

  v_deposit_id := 'DEP-' || to_char(v_now at time zone 'Asia/Kolkata','YYYYMMDD') || '-'
               || lpad(nextval('public.deposit_number_seq')::text, 4, '0');

  INSERT INTO public.advance_orders(
    deposit_id, customer_name, phone, address, product_name, products,
    category, description, total_amount, deposit_amount, expected_delivery_date,
    remarks, reference_number,
    created_by, created_by_name, created_at, updated_at, branch_id
  ) VALUES (
    v_deposit_id,
    trim(p_customer_name),
    trim(p_phone),
    trim(coalesce(p_address,'')),
    trim(p_product_name),
    CASE WHEN jsonb_typeof(coalesce(p_products,'[]'::jsonb)) = 'array'
         THEN coalesce(p_products,'[]'::jsonb)
         ELSE '[]'::jsonb END,
    trim(coalesce(p_category,'')),
    trim(coalesce(p_description,'')),
    round(p_total_amount, 2),
    round(p_deposit_amount, 2),
    p_expected_delivery_date,
    trim(coalesce(p_remarks,'')),
    v_ref,
    NULL::uuid,
    trim(coalesce(p_created_by_name,'')),
    v_now, v_now,
    v_branch
  )
  RETURNING * INTO v_order;

  INSERT INTO public.advance_order_payments(
    advance_order_id, payment_type, amount, payment_method, remarks, received_by, received_at
  ) VALUES (
    v_order.id, 'deposit', v_order.deposit_amount, lower(p_payment_method),
    coalesce(p_remarks,''), NULL::uuid, v_now
  );

  INSERT INTO public.advance_order_timeline(advance_order_id, event_type, label, created_by, created_at) VALUES
    (v_order.id, 'created',          'Created',          NULL::uuid, v_now),
    (v_order.id, 'deposit_received', 'Deposit Received', NULL::uuid, v_now);

  RETURN v_order;
END;
$function$;


-- 3. complete_advance_order_v2 — copy reference_number + remarks onto the final bill
--
-- Full replacement of the function last written in 0013.  The billing maths
-- (total, discount, GST, delivery, stock, split details) are NOT changed.  The only additions are:
--   + reference_number  in the INSERT column list
--   + remarks           in the INSERT column list
--   + their VALUES (v_bill_ref / v_bill_remarks)
CREATE OR REPLACE FUNCTION public.complete_advance_order_v2(
  p_order_id          uuid,
  p_payment_method    text,
  p_final_amount      numeric,
  p_coupon_code       text    DEFAULT NULL::text,
  p_coupon_percentage numeric DEFAULT 0,
  p_manual_discount   numeric DEFAULT 0,
  p_remarks           text    DEFAULT ''::text,
  p_branch            text    DEFAULT NULL::text
)
 RETURNS TABLE(order_id uuid, invoice_no text, completed_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_advance        public.advance_orders;
  v_order_id       uuid := gen_random_uuid();
  v_invoice        text;
  v_now            timestamptz := now();
  v_items          jsonb;
  v_bill_items     jsonb;
  v_item           jsonb;
  v_total_discount numeric := 0;
  v_branch         text;
  v_raw_product    text;
  v_raw_variant    text;
  v_product_id     bigint;
  v_variant_id     uuid;
  v_quantity       numeric;
  v_name           text;
  v_stock          numeric;
  v_tracked        boolean;
  v_barcode_id     uuid;
  v_cart           boolean;
  v_bill_remarks   text;
  v_bill_ref       text;
BEGIN
  IF lower(coalesce(p_payment_method, '')) NOT IN ('cash', 'upi', 'card') THEN
    RAISE EXCEPTION 'Select a valid payment method';
  END IF;

  SELECT * INTO v_advance FROM public.advance_orders
    WHERE id = p_order_id AND branch_id = public.resolve_branch(p_branch)
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Advance order not found';
  END IF;

  v_branch := public.resolve_branch(v_advance.branch_id);

  IF v_advance.status = 'cancelled' THEN
    RAISE EXCEPTION 'A cancelled order cannot be completed';
  END IF;

  IF v_advance.completed_order_id IS NOT NULL OR v_advance.invoice_number IS NOT NULL THEN
    IF v_advance.status != 'completed' THEN
      UPDATE public.advance_orders
        SET status     = 'completed',
            updated_at = v_now
        WHERE id = p_order_id;
    END IF;
    RETURN QUERY SELECT
      coalesce(v_advance.completed_order_id, gen_random_uuid()),
      coalesce(v_advance.invoice_number, 'INV00000000'),
      coalesce(v_advance.completed_at, v_now);
    RETURN;
  END IF;

  v_cart := v_advance.cart_subtotal > 0;

  v_total_discount := p_manual_discount + (v_advance.remaining_balance - p_manual_discount - p_final_amount);
  IF v_total_discount < 0 THEN v_total_discount := 0; END IF;

  v_items := CASE
    WHEN jsonb_typeof(v_advance.products) = 'array' AND jsonb_array_length(v_advance.products) > 0
      THEN v_advance.products
    ELSE jsonb_build_array(jsonb_build_object(
        'name', v_advance.product_name, 'category', v_advance.category,
        'description', v_advance.description, 'quantity', 1,
        'base_price', v_advance.total_amount, 'line_total', v_advance.total_amount,
        'unit', 'piece', 'unit_type', 'unit', 'source', 'advance_order'))
  END;
  v_bill_items := v_items;

  FOR i IN 0 .. jsonb_array_length(v_items) - 1 LOOP
    v_item        := v_items -> i;
    v_raw_product := btrim(coalesce(v_item ->> 'product_id', ''));
    v_raw_variant := btrim(coalesce(v_item ->> 'variant_id', ''));
    v_product_id  := CASE WHEN v_raw_product ~ '^[0-9]+$' THEN v_raw_product::bigint END;
    v_variant_id  := CASE
      WHEN v_raw_variant ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN v_raw_variant::uuid END;
    v_quantity := greatest(coalesce(nullif(v_item ->> 'quantity', '')::numeric, 1), 0);
    v_name     := coalesce(nullif(btrim(v_item ->> 'name'), ''), 'Product');
    v_tracked  := FALSE;
    v_stock    := NULL;

    IF v_product_id IS NULL AND v_variant_id IS NULL
       AND NOT coalesce((v_item ->> 'is_manual')::boolean, FALSE) THEN
      SELECT min(p.id) INTO v_product_id
      FROM public.products p
      WHERE p.branch_id = v_branch AND p.is_active
        AND lower(btrim(p.name)) = lower(v_name)
        AND NOT coalesce(p.has_variants, FALSE)
        AND NOT EXISTS (SELECT 1 FROM public.product_variants pv
                         WHERE pv.product_id = p.id AND pv.branch_id = v_branch)
      HAVING count(*) = 1;
    END IF;

    IF v_variant_id IS NOT NULL THEN
      SELECT pv.stock, pv.product_id INTO v_stock, v_product_id
      FROM public.product_variants pv
      WHERE pv.id = v_variant_id AND pv.branch_id = v_branch FOR UPDATE;
      IF NOT FOUND THEN v_variant_id := NULL; v_product_id := NULL; END IF;
    END IF;

    IF v_product_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.products p WHERE p.id = v_product_id AND p.branch_id = v_branch
    ) THEN v_product_id := NULL; v_variant_id := NULL; END IF;

    IF v_product_id IS NOT NULL
       AND NOT coalesce((v_item ->> 'is_manual')::boolean, FALSE)
       AND NOT EXISTS (SELECT 1 FROM public.products p
                        WHERE p.id = v_product_id
                          AND lower(btrim(coalesce(p.category, ''))) = 'unregistered')
       AND v_quantity > 0 THEN
      v_tracked := TRUE;
      IF v_variant_id IS NULL THEN
        SELECT p.stock_quantity INTO v_stock FROM public.products p
          WHERE p.id = v_product_id AND p.branch_id = v_branch FOR UPDATE;
      END IF;
      IF coalesce(v_stock, 0) < v_quantity THEN
        RAISE EXCEPTION
          'Not enough stock to complete this order: % (in stock: %, needed: %). Restock it in Inventory, then complete the order.',
          v_name, coalesce(v_stock, 0), v_quantity;
      END IF;
    END IF;

    v_items := jsonb_set(v_items, ARRAY[i::text],
      v_item || jsonb_build_object(
        '_product_id', v_product_id,
        '_variant_id', v_variant_id,
        '_tracked',    v_tracked));
  END LOOP;

  v_invoice := public.get_next_invoice_no(v_branch);

  -- 0020: combined values written onto the orders row
  v_bill_remarks := coalesce(nullif(trim(coalesce(p_remarks, '')), ''), v_advance.remarks, '');
  v_bill_ref     := coalesce(v_advance.reference_number, '');

  INSERT INTO public.orders (
    id, invoice_no, customer_name, phone, address, user_id,
    items, subtotal, total, status, order_mode, order_type,
    shipping, delivery_charge, discount_amount, manual_discount_amount,
    coupon_code, coupon_percentage, manual_discount_type, manual_discount_value,
    total_gst, gst_amount, gst_enabled,
    payment_mode, payment_method,
    remarks, reference_number,
    branch_id, created_at, updated_at
  ) VALUES (
    v_order_id, v_invoice,
    v_advance.customer_name, v_advance.phone, v_advance.address, NULL::uuid,
    v_bill_items,
    CASE WHEN v_cart THEN v_advance.cart_subtotal ELSE v_advance.total_amount END,
    greatest(0, v_advance.total_amount - v_total_discount),
    'completed', 'offline', 'advance_order',
    0, v_advance.cart_delivery_charge,
    v_advance.cart_coupon_discount + greatest(0, v_total_discount - p_manual_discount),
    v_advance.cart_manual_discount + p_manual_discount,
    coalesce(p_coupon_code, v_advance.cart_coupon_code),
    CASE WHEN p_coupon_code IS NULL AND v_advance.cart_coupon_code IS NOT NULL
         THEN v_advance.cart_coupon_percentage ELSE p_coupon_percentage END,
    CASE WHEN v_cart AND p_manual_discount = 0 THEN v_advance.cart_manual_discount_type ELSE 'flat' END,
    CASE WHEN v_cart AND p_manual_discount = 0 THEN v_advance.cart_manual_discount_value
         ELSE v_advance.cart_manual_discount + p_manual_discount END,
    v_advance.cart_total_gst, v_advance.cart_total_gst, v_advance.cart_total_gst > 0,
    lower(p_payment_method), lower(p_payment_method),
    v_bill_remarks, v_bill_ref,
    v_branch,
    v_now, v_now
  );

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) LOOP
    v_product_id := nullif(v_item ->> '_product_id', '')::bigint;
    v_variant_id := nullif(v_item ->> '_variant_id', '')::uuid;
    v_quantity   := greatest(coalesce(nullif(v_item ->> 'quantity', '')::numeric, 1), 0);

    INSERT INTO public.order_items (
      order_id, product_id, variant_id, variant_name, category,
      product_name, name, quantity, unit, unit_type,
      base_price, line_total, is_manual
    ) VALUES (
      v_order_id, v_product_id, v_variant_id, nullif(v_item ->> 'variant_name', ''),
      nullif(v_item ->> 'category', ''),
      coalesce(nullif(trim(v_item->>'name'), ''), 'Product'),
      coalesce(nullif(trim(v_item->>'name'), ''), 'Product'),
      v_quantity,
      coalesce(nullif(v_item->>'unit', ''), 'piece'),
      coalesce(nullif(v_item->>'unit_type', ''), 'unit'),
      greatest(coalesce((v_item->>'base_price')::numeric, 0), 0),
      greatest(coalesce((v_item->>'line_total')::numeric, 0), 0),
      false
    );

    CONTINUE WHEN NOT coalesce((v_item ->> '_tracked')::boolean, FALSE);

    IF v_variant_id IS NOT NULL THEN
      SELECT stock INTO v_stock FROM public.product_variants WHERE id = v_variant_id AND branch_id = v_branch;
      SELECT id INTO v_barcode_id FROM public.barcode_registry
        WHERE variant_id = v_variant_id AND branch_id = v_branch AND is_active = TRUE LIMIT 1;
      UPDATE public.product_variants
        SET stock = greatest(0, stock - v_quantity), updated_at = v_now
        WHERE id = v_variant_id AND branch_id = v_branch;
      UPDATE public.products
        SET stock_quantity = (SELECT coalesce(sum(stock), 0) FROM public.product_variants
                              WHERE product_id = v_product_id AND branch_id = v_branch AND is_active = TRUE),
            stock = floor((SELECT coalesce(sum(stock), 0) FROM public.product_variants
                           WHERE product_id = v_product_id AND branch_id = v_branch AND is_active = TRUE))::integer,
            updated_at = v_now
        WHERE id = v_product_id AND branch_id = v_branch;
    ELSE
      SELECT stock_quantity INTO v_stock FROM public.products WHERE id = v_product_id AND branch_id = v_branch;
      SELECT id INTO v_barcode_id FROM public.barcode_registry
        WHERE product_id = v_product_id AND variant_id IS NULL AND branch_id = v_branch AND is_active = TRUE LIMIT 1;
      UPDATE public.products
        SET stock_quantity = greatest(0, stock_quantity - v_quantity),
            stock          = greatest(0, floor(stock_quantity - v_quantity))::integer,
            updated_at     = v_now
        WHERE id = v_product_id AND branch_id = v_branch;
    END IF;

    INSERT INTO public.inventory_movements (
      product_id, variant_id, barcode_id, movement_type,
      quantity_delta, quantity_before, quantity_after,
      reference_type, reference_id, note, branch_id
    ) VALUES (
      v_product_id, v_variant_id, v_barcode_id, 'SALE',
      -v_quantity, v_stock, greatest(0, v_stock - v_quantity),
      'order', v_invoice,
      'Advance order completed (' || v_advance.deposit_id || ')',
      v_branch
    );
  END LOOP;

  INSERT INTO public.advance_order_payments (
    advance_order_id, payment_type, amount, payment_method, remarks, received_by, received_at
  ) VALUES (
    p_order_id, 'remaining', p_final_amount,
    lower(p_payment_method), coalesce(p_remarks, ''), NULL::uuid, v_now
  );

  UPDATE public.advance_orders SET
    status               = 'completed',
    completed_at         = v_now,
    completed_order_id   = v_order_id,
    invoice_number       = v_invoice,
    final_payment_method = lower(p_payment_method),
    remarks              = CASE WHEN trim(coalesce(p_remarks, '')) = '' THEN remarks ELSE p_remarks END,
    updated_at           = v_now
  WHERE id = p_order_id;

  INSERT INTO public.advance_order_timeline (
    advance_order_id, event_type, label, remarks, created_by, created_at
  ) VALUES
    (p_order_id, 'remaining_payment_received', 'Remaining Payment Received', coalesce(p_remarks, ''), NULL::uuid, v_now),
    (p_order_id, 'invoice_generated',          'Invoice Generated',          v_invoice,               NULL::uuid, v_now);

  RETURN QUERY SELECT v_order_id, v_invoice, v_now;
END;
$function$;

COMMIT;
