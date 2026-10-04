-- 0003: business functions + triggers. Billing logic is unchanged; branch handling is
-- generalised from 'pos1'/'pos2' to any row in public.branches (public.resolve_branch).

BEGIN;

-- Per-branch invoice numbers (each branch has its own bounded range; sequences are created by public.register_branch).
-- Guards that an invoice number lies inside the owning branch's range (defence in depth: even a
-- buggy caller cannot file a bill under a number that belongs to another branch).
CREATE OR REPLACE FUNCTION public.assert_invoice_in_branch_range(p_branch text, p_number text)
 RETURNS void LANGUAGE plpgsql STABLE
AS $function$
BEGIN
  IF p_number IS NULL THEN RETURN; END IF;
  IF p_number !~ '^[0-9]{1,8}$' OR NOT EXISTS (
    SELECT 1 FROM public.branches
    WHERE id = p_branch AND p_number::bigint BETWEEN invoice_start AND invoice_end
  ) THEN
    RAISE EXCEPTION 'Invoice number % is outside the range of branch %', p_number, p_branch USING ERRCODE = '23514';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_order_invoice_range()
 RETURNS trigger LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM public.assert_invoice_in_branch_range(NEW.branch_id, NEW.invoice_no);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_advance_invoice_range()
 RETURNS trigger LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM public.assert_invoice_in_branch_range(NEW.branch_id, NEW.invoice_number);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_next_invoice_no(p_branch text DEFAULT 'pos1'::text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN LPAD(nextval(format('public.%I', 'invoice_number_seq_' || public.resolve_branch(p_branch)))::TEXT, 8, '0');
END;
$function$;

CREATE OR REPLACE FUNCTION public.add_advance_order_event(p_order_id uuid, p_event_type text, p_label text, p_remarks text DEFAULT ''::text, p_branch text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- p_branch is mandatory in practice: resolve_branch() raises on NULL / unknown branch.
  IF NOT EXISTS (SELECT 1 FROM public.advance_orders WHERE id = p_order_id AND branch_id = public.resolve_branch(p_branch)) THEN
    RAISE EXCEPTION 'Advance order not found';
  END IF;
  INSERT INTO public.advance_order_timeline (advance_order_id, event_type, label, remarks, created_by, created_at)
  VALUES (p_order_id, p_event_type, p_label, coalesce(p_remarks,''), NULL::uuid, now());
END;
$function$;

CREATE OR REPLACE FUNCTION public.adjust_inventory_stock(p_product_id bigint, p_variant_id uuid DEFAULT NULL::uuid, p_new_quantity numeric DEFAULT 0, p_reason text DEFAULT 'RESTOCK'::text, p_note text DEFAULT ''::text, p_created_by_name text DEFAULT ''::text, p_branch text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_expected_branch TEXT := public.resolve_branch(p_branch);
  v_qty_before NUMERIC := 0;
  v_delta NUMERIC := 0;
  v_branch TEXT;
BEGIN
  IF p_new_quantity < 0 THEN
    RAISE EXCEPTION 'Stock quantity cannot be negative';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id AND branch_id = v_expected_branch) THEN
    RAISE EXCEPTION 'Product does not belong to the selected branch';
  END IF;

  -- Verify variant if supplied
  IF p_variant_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.product_variants WHERE id = p_variant_id AND product_id = p_product_id) THEN
      RAISE EXCEPTION 'Variant does not belong to specified Product';
    END IF;

    SELECT stock, branch_id INTO v_qty_before, v_branch FROM public.product_variants WHERE id = p_variant_id FOR UPDATE;

    v_delta := p_new_quantity - v_qty_before;

    UPDATE public.product_variants
    SET stock = p_new_quantity, updated_at = NOW()
    WHERE id = p_variant_id;

    -- Refresh parent aggregate
    UPDATE public.products
    SET stock_quantity = (SELECT COALESCE(SUM(stock), 0) FROM public.product_variants WHERE product_id = p_product_id AND is_active = TRUE),
        stock = FLOOR((SELECT COALESCE(SUM(stock), 0) FROM public.product_variants WHERE product_id = p_product_id AND is_active = TRUE))::INTEGER,
        updated_at = NOW()
    WHERE id = p_product_id;
  ELSE
    SELECT stock_quantity, branch_id INTO v_qty_before, v_branch FROM public.products WHERE id = p_product_id FOR UPDATE;

    v_delta := p_new_quantity - v_qty_before;

    UPDATE public.products
    SET stock_quantity = p_new_quantity,
        stock = FLOOR(p_new_quantity)::INTEGER,
        updated_at = NOW()
    WHERE id = p_product_id;
  END IF;

  -- Record Movement
  INSERT INTO public.inventory_movements (
    product_id, variant_id, movement_type,
    quantity_delta, quantity_before, quantity_after,
    reference_type, note, created_by_name, branch_id
  )
  VALUES (
    p_product_id, p_variant_id, p_reason,
    v_delta, v_qty_before, p_new_quantity,
    'adjustment', COALESCE(p_note, ''), COALESCE(p_created_by_name, ''), v_branch
  );

  RETURN jsonb_build_object(
    'success', TRUE,
    'quantity_before', v_qty_before,
    'quantity_after', p_new_quantity,
    'delta', v_delta,
    'reason', p_reason
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_advance_order_v2(p_order_id uuid, p_payment_method text, p_final_amount numeric, p_coupon_code text DEFAULT NULL::text, p_coupon_percentage numeric DEFAULT 0, p_manual_discount numeric DEFAULT 0, p_remarks text DEFAULT ''::text, p_branch text DEFAULT NULL::text)
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
BEGIN
  IF lower(coalesce(p_payment_method, '')) NOT IN ('cash', 'upi', 'card') THEN
    RAISE EXCEPTION 'Select a valid payment method';
  END IF;

  SELECT * INTO v_advance FROM public.advance_orders WHERE id = p_order_id AND branch_id = public.resolve_branch(p_branch) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Advance order not found';
  END IF;

  -- The advance order's own branch is the single source of truth.
  v_branch := public.resolve_branch(v_advance.branch_id);

  IF v_advance.status = 'cancelled' THEN
    RAISE EXCEPTION 'A cancelled order cannot be completed';
  END IF;

  IF v_advance.completed_order_id IS NOT NULL OR v_advance.invoice_number IS NOT NULL THEN
    IF v_advance.status != 'completed' THEN
      UPDATE public.advance_orders
      SET status = 'completed',
          updated_at = v_now
      WHERE id = p_order_id;
    END IF;

    RETURN QUERY SELECT
      coalesce(v_advance.completed_order_id, gen_random_uuid()),
      coalesce(v_advance.invoice_number, 'INV00000000'),
      coalesce(v_advance.completed_at, v_now);
    RETURN;
  END IF;

  v_total_discount := p_manual_discount + (v_advance.remaining_balance - p_manual_discount - p_final_amount);
  IF v_total_discount < 0 THEN
    v_total_discount := 0;
  END IF;

  v_items := CASE
    WHEN jsonb_typeof(v_advance.products) = 'array' AND jsonb_array_length(v_advance.products) > 0
      THEN v_advance.products
    ELSE jsonb_build_array(
      jsonb_build_object(
        'name',        v_advance.product_name,
        'category',    v_advance.category,
        'description', v_advance.description,
        'quantity',    1,
        'base_price',  v_advance.total_amount,
        'line_total',  v_advance.total_amount,
        'unit',        'piece',
        'unit_type',   'unit',
        'source',      'advance_order'
      )
    )
  END;
  v_bill_items := v_items;

  -- 1. Resolve each item against THIS counter's catalog, lock its stock
  --    row and make sure there is enough. Resolved ids are written back
  --    into v_items so the later steps never look outside the branch.
  FOR i IN 0 .. jsonb_array_length(v_items) - 1 LOOP
    v_item := v_items -> i;
    v_raw_product := btrim(coalesce(v_item ->> 'product_id', ''));
    v_raw_variant := btrim(coalesce(v_item ->> 'variant_id', ''));
    v_product_id := CASE WHEN v_raw_product ~ '^[0-9]+$' THEN v_raw_product::bigint END;
    v_variant_id := CASE
      WHEN v_raw_variant ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN v_raw_variant::uuid
    END;
    v_quantity := greatest(coalesce(nullif(v_item ->> 'quantity', '')::numeric, 1), 0);
    v_name := coalesce(nullif(btrim(v_item ->> 'name'), ''), 'Product');
    v_tracked := FALSE;
    v_stock := NULL;

    IF v_variant_id IS NOT NULL THEN
      SELECT pv.stock, pv.product_id INTO v_stock, v_product_id
      FROM public.product_variants pv
      WHERE pv.id = v_variant_id AND pv.branch_id = v_branch
      FOR UPDATE;
      IF NOT FOUND THEN
        v_variant_id := NULL;
        v_product_id := NULL;
      END IF;
    END IF;

    IF v_product_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.id = v_product_id AND p.branch_id = v_branch
    ) THEN
      v_product_id := NULL;
      v_variant_id := NULL;
    END IF;

    IF v_product_id IS NOT NULL
       AND NOT coalesce((v_item ->> 'is_manual')::boolean, FALSE)
       AND NOT EXISTS (
         SELECT 1 FROM public.products p
         WHERE p.id = v_product_id AND lower(btrim(coalesce(p.category, ''))) = 'unregistered'
       )
       AND v_quantity > 0 THEN
      v_tracked := TRUE;
      IF v_variant_id IS NULL THEN
        SELECT p.stock_quantity INTO v_stock
        FROM public.products p
        WHERE p.id = v_product_id AND p.branch_id = v_branch
        FOR UPDATE;
      END IF;

      IF coalesce(v_stock, 0) < v_quantity THEN
        RAISE EXCEPTION 'Not enough stock to complete this order: % (in stock: %, needed: %). Restock it in Inventory, then complete the order.',
          v_name, coalesce(v_stock, 0), v_quantity;
      END IF;
    END IF;

    v_items := jsonb_set(
      v_items, ARRAY[i::text],
      v_item || jsonb_build_object(
        '_product_id', v_product_id,
        '_variant_id', v_variant_id,
        '_tracked',    v_tracked
      )
    );
  END LOOP;

  -- 2. Bill, numbered from this counter's sequence.
  v_invoice := public.get_next_invoice_no(v_branch);

  INSERT INTO public.orders (
    id, invoice_no, customer_name, phone, address, user_id,
    items, subtotal, total, status, order_mode, order_type,
    shipping, delivery_charge, discount_amount, manual_discount_amount,
    coupon_code, coupon_percentage, manual_discount_type, manual_discount_value,
    payment_mode, payment_method, branch_id, created_at, updated_at
  ) VALUES (
    v_order_id, v_invoice,
    v_advance.customer_name, v_advance.phone, v_advance.address, NULL::uuid,
    v_bill_items,
    v_advance.total_amount, greatest(0, v_advance.total_amount - v_total_discount),
    'completed', 'offline', 'advance_order',
    0, 0, v_total_discount, p_manual_discount,
    p_coupon_code, p_coupon_percentage, 'flat', p_manual_discount,
    lower(p_payment_method), lower(p_payment_method), v_branch,
    v_now, v_now
  );

  -- 3. Bill lines, stock deduction and stock ledger (all branch-scoped).
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) LOOP
    v_product_id := nullif(v_item ->> '_product_id', '')::bigint;
    v_variant_id := nullif(v_item ->> '_variant_id', '')::uuid;
    v_quantity := greatest(coalesce(nullif(v_item ->> 'quantity', '')::numeric, 1), 0);

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

      UPDATE public.product_variants
      SET stock = greatest(0, stock - v_quantity), updated_at = v_now
      WHERE id = v_variant_id AND branch_id = v_branch;

      UPDATE public.products
      SET stock_quantity = (SELECT coalesce(sum(stock), 0) FROM public.product_variants WHERE product_id = v_product_id AND branch_id = v_branch AND is_active = TRUE),
          stock = floor((SELECT coalesce(sum(stock), 0) FROM public.product_variants WHERE product_id = v_product_id AND branch_id = v_branch AND is_active = TRUE))::integer,
          updated_at = v_now
      WHERE id = v_product_id AND branch_id = v_branch;
    ELSE
      SELECT stock_quantity INTO v_stock FROM public.products WHERE id = v_product_id AND branch_id = v_branch;

      UPDATE public.products
      SET stock_quantity = greatest(0, stock_quantity - v_quantity),
          stock = greatest(0, floor(stock_quantity - v_quantity))::integer,
          updated_at = v_now
      WHERE id = v_product_id AND branch_id = v_branch;
    END IF;

    INSERT INTO public.inventory_movements (
      product_id, variant_id, movement_type,
      quantity_delta, quantity_before, quantity_after,
      reference_type, reference_id, note, branch_id
    ) VALUES (
      v_product_id, v_variant_id, 'SALE',
      -v_quantity, v_stock, greatest(0, v_stock - v_quantity),
      'order', v_invoice, 'Advance order completed (' || v_advance.deposit_id || ')', v_branch
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
  v_branch TEXT := public.resolve_branch(p_branch);
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order items cannot be empty';
  END IF;

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
          product_id, variant_id, movement_type,
          quantity_delta, quantity_before, quantity_after,
          reference_type, reference_id, note, branch_id
        )
        VALUES (
          v_product_id, v_variant_id, 'SALE',
          -v_quantity, v_current_stock, GREATEST(0, v_current_stock - v_quantity),
          'order', v_invoice_no, 'POS Sale checkout', v_branch
        );

      ELSIF v_product_id IS NOT NULL THEN
        SELECT stock_quantity INTO v_current_stock FROM public.products WHERE id = v_product_id AND branch_id = v_branch;

        UPDATE public.products
        SET stock_quantity = GREATEST(0, stock_quantity - v_quantity),
            stock = GREATEST(0, stock - FLOOR(v_quantity)::INTEGER),
            updated_at = NOW()
        WHERE id = v_product_id AND branch_id = v_branch;

        INSERT INTO public.inventory_movements (
          product_id, variant_id, movement_type,
          quantity_delta, quantity_before, quantity_after,
          reference_type, reference_id, note, branch_id
        )
        VALUES (
          v_product_id, NULL, 'SALE',
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

CREATE OR REPLACE FUNCTION public.create_advance_order(p_customer_name text, p_phone text, p_address text, p_product_name text, p_category text, p_description text, p_total_amount numeric, p_deposit_amount numeric, p_expected_delivery_date date, p_remarks text, p_payment_method text, p_created_by_name text, p_products jsonb DEFAULT '[]'::jsonb, p_branch text DEFAULT 'pos1'::text)
 RETURNS advance_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_order public.advance_orders; v_now timestamptz := now(); v_deposit_id text; v_branch text := public.resolve_branch(p_branch);
BEGIN
  IF trim(coalesce(p_customer_name,'')) = '' THEN RAISE EXCEPTION 'Customer name is required'; END IF;
  IF trim(coalesce(p_phone,'')) = '' THEN RAISE EXCEPTION 'Phone number is required'; END IF;
  IF trim(coalesce(p_product_name,'')) = '' THEN RAISE EXCEPTION 'Product name is required'; END IF;
  IF coalesce(p_total_amount,0) <= 0 THEN RAISE EXCEPTION 'Total amount must be greater than zero'; END IF;
  IF coalesce(p_deposit_amount,0) <= 0 OR p_deposit_amount >= p_total_amount THEN RAISE EXCEPTION 'Deposit must be greater than zero and less than the total amount'; END IF;
  IF lower(coalesce(p_payment_method,'')) NOT IN ('cash','upi','card') THEN RAISE EXCEPTION 'Select a valid deposit payment method'; END IF;
  v_deposit_id := 'DEP-' || to_char(v_now at time zone 'Asia/Kolkata','YYYYMMDD') || '-' || lpad(nextval('public.deposit_number_seq')::text,4,'0');
  INSERT INTO public.advance_orders(deposit_id,customer_name,phone,address,product_name,products,category,description,total_amount,deposit_amount,expected_delivery_date,remarks,created_by,created_by_name,created_at,updated_at,branch_id)
  VALUES(v_deposit_id,trim(p_customer_name),trim(p_phone),trim(coalesce(p_address,'')),trim(p_product_name),CASE WHEN jsonb_typeof(coalesce(p_products,'[]'::jsonb))='array' THEN coalesce(p_products,'[]'::jsonb) ELSE '[]'::jsonb END,trim(coalesce(p_category,'')),trim(coalesce(p_description,'')),round(p_total_amount,2),round(p_deposit_amount,2),p_expected_delivery_date,trim(coalesce(p_remarks,'')),NULL::uuid,trim(coalesce(p_created_by_name,'')),v_now,v_now,v_branch)
  RETURNING * INTO v_order;
  INSERT INTO public.advance_order_payments(advance_order_id,payment_type,amount,payment_method,remarks,received_by,received_at)
  VALUES(v_order.id,'deposit',v_order.deposit_amount,lower(p_payment_method),coalesce(p_remarks,''),NULL::uuid,v_now);
  INSERT INTO public.advance_order_timeline(advance_order_id,event_type,label,created_by,created_at) VALUES
    (v_order.id,'created','Created',NULL::uuid,v_now),
    (v_order.id,'deposit_received','Deposit Received',NULL::uuid,v_now);
  RETURN v_order;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_inventory_item(p_product_id bigint, p_variant_id uuid DEFAULT NULL::uuid, p_branch text DEFAULT 'pos1'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_branch text := public.resolve_branch(p_branch);
BEGIN
  IF p_variant_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.product_variants
      WHERE id = p_variant_id AND product_id = p_product_id AND branch_id = v_branch
    ) THEN
      RAISE EXCEPTION 'Variant does not belong to the selected product and POS branch';
    END IF;

    DELETE FROM public.inventory_movements
    WHERE variant_id = p_variant_id AND branch_id = v_branch;


    DELETE FROM public.product_variants
    WHERE id = p_variant_id AND product_id = p_product_id AND branch_id = v_branch;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.products WHERE id = p_product_id AND branch_id = v_branch
  ) THEN
    RAISE EXCEPTION 'Product does not belong to the selected POS branch';
  END IF;

  DELETE FROM public.inventory_movements
  WHERE branch_id = v_branch
    AND (product_id = p_product_id OR variant_id IN (
      SELECT id FROM public.product_variants
      WHERE product_id = p_product_id AND branch_id = v_branch
    ));


  DELETE FROM public.product_variants
  WHERE product_id = p_product_id AND branch_id = v_branch;

  DELETE FROM public.products
  WHERE id = p_product_id AND branch_id = v_branch;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_movements_for_product()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.inventory_movements WHERE product_id = OLD.id;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_movements_for_variant()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.inventory_movements WHERE variant_id = OLD.id;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ensure_one_default_variant()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.is_default THEN
    UPDATE public.product_variants
    SET is_default = FALSE, updated_at = NOW()
    WHERE product_id = NEW.product_id AND id <> NEW.id AND is_default;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_expense_summary_metrics(p_current_date date DEFAULT CURRENT_DATE, p_branch text DEFAULT 'pos1'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today NUMERIC(12,2) := 0;
  v_this_week NUMERIC(12,2) := 0;
  v_this_month NUMERIC(12,2) := 0;
  v_this_year NUMERIC(12,2) := 0;
  v_total_all_time NUMERIC(12,2) := 0;
  v_week_start DATE := date_trunc('week', p_current_date)::DATE;
  v_month_start DATE := date_trunc('month', p_current_date)::DATE;
  v_year_start DATE := date_trunc('year', p_current_date)::DATE;
  v_branch TEXT := public.resolve_branch(p_branch);
BEGIN
  SELECT
    COALESCE(SUM(CASE WHEN expense_date = p_current_date THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN expense_date >= v_week_start AND expense_date <= p_current_date THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN expense_date >= v_month_start AND expense_date <= p_current_date THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN expense_date >= v_year_start AND expense_date <= p_current_date THEN amount ELSE 0 END), 0),
    COALESCE(SUM(amount), 0)
  INTO
    v_today, v_this_week, v_this_month, v_this_year, v_total_all_time
  FROM public.expenses
  WHERE branch_id = v_branch;

  RETURN jsonb_build_object(
    'today', v_today,
    'this_week', v_this_week,
    'this_month', v_this_month,
    'this_year', v_this_year,
    'total_all_time', v_total_all_time
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_public_invoice_by_number(p_invoice_no text)
 RETURNS SETOF orders
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- Invoice numbers are globally unique (disjoint per-branch ranges), so a number resolves to
  -- exactly one bill. Only exact / prefix-stripped / UUID matches are accepted; no fuzzy
  -- zero-padding or partial matching that could land on another branch's bill.
  SELECT * FROM public.orders
  WHERE invoice_no = NULLIF(BTRIM(p_invoice_no), '')
     OR invoice_no = NULLIF(REGEXP_REPLACE(BTRIM(p_invoice_no), '^(INV|PB)[-_ ]*', '', 'i'), '')
     OR (
       p_invoice_no ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND id = p_invoice_no::UUID
     )
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.punch_attendance(p_staff_member_id uuid, p_action text, p_branch text DEFAULT NULL::text)
 RETURNS attendance_records
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_branch TEXT;
  v_row public.attendance_records;
BEGIN
  SELECT branch_id INTO v_branch FROM public.staff_members WHERE id = p_staff_member_id AND is_active = TRUE AND branch_id = public.resolve_branch(p_branch);
  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'Staff member not found';
  END IF;

  IF p_action NOT IN ('in', 'out') THEN
    RAISE EXCEPTION 'Invalid punch action';
  END IF;

  INSERT INTO public.attendance_records (staff_member_id, branch_id, attendance_date, clock_in, clock_out, status)
  VALUES (
    p_staff_member_id, v_branch, CURRENT_DATE,
    CASE WHEN p_action = 'in' THEN NOW() ELSE NULL END,
    CASE WHEN p_action = 'out' THEN NOW() ELSE NULL END,
    'present'
  )
  ON CONFLICT (staff_member_id, attendance_date) DO UPDATE SET
    clock_in = CASE
      WHEN p_action = 'in' AND public.attendance_records.clock_in IS NULL THEN NOW()
      ELSE public.attendance_records.clock_in
    END,
    clock_out = CASE WHEN p_action = 'out' THEN NOW() ELSE public.attendance_records.clock_out END,
    status = 'present',
    updated_at = NOW()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_category_name_to_products()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.name_en IS DISTINCT FROM OLD.name_en THEN
    UPDATE public.products SET category = NEW.name_en, updated_at = NOW() WHERE category_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_product_category_name()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.category_id IS NOT NULL THEN
    SELECT name_en INTO NEW.category FROM public.categories WHERE id = NEW.category_id;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_advance_order_status(p_order_id uuid, p_status text, p_remarks text DEFAULT ''::text, p_branch text DEFAULT NULL::text)
 RETURNS SETOF advance_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order public.advance_orders;
BEGIN
  SELECT * INTO v_order FROM public.advance_orders WHERE id = p_order_id AND branch_id = public.resolve_branch(p_branch) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Advance order % not found', p_order_id;
  END IF;

  IF (v_order.invoice_number IS NOT NULL OR v_order.completed_order_id IS NOT NULL) AND p_status != 'completed' THEN
    RAISE EXCEPTION 'Cannot change status of an order that already has an invoice generated';
  END IF;

  UPDATE public.advance_orders SET
    status     = p_status,
    remarks    = CASE WHEN trim(coalesce(p_remarks,'')) = '' THEN remarks ELSE p_remarks END,
    updated_at = now()
  WHERE id = p_order_id;

  INSERT INTO public.advance_order_timeline (advance_order_id, event_type, label, remarks, created_by, created_at)
  VALUES (
    p_order_id,
    p_status,
    CASE p_status
      WHEN 'pending_deposit'       THEN 'Status: Pending Deposit'
      WHEN 'waiting_final_payment' THEN 'Status: Waiting for Final Payment'
      WHEN 'ready_for_delivery'    THEN 'Status: Ready to Collect'
      WHEN 'completed'             THEN 'Order Completed'
      WHEN 'cancelled'             THEN 'Order Cancelled'
      ELSE p_status
    END,
    coalesce(p_remarks, ''),
    NULL::uuid,
    now()
  );

  RETURN QUERY SELECT * FROM public.advance_orders WHERE id = p_order_id;
END;
$function$;

-- Child rows take branch_id from their parent, so they can never disagree with it. The composite
-- foreign keys then guarantee every other reference (product, variant, ...) lives in the same branch.
CREATE OR REPLACE FUNCTION public.set_branch_from_order()
 RETURNS trigger LANGUAGE plpgsql
AS $function$
BEGIN
  SELECT branch_id INTO NEW.branch_id FROM public.orders WHERE id = NEW.order_id;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_branch_from_advance_order()
 RETURNS trigger LANGUAGE plpgsql
AS $function$
BEGIN
  SELECT branch_id INTO NEW.branch_id FROM public.advance_orders WHERE id = NEW.advance_order_id;
  RETURN NEW;
END;
$function$;

-- orders.coupon_id is looked up by code within the order's own branch only.
CREATE OR REPLACE FUNCTION public.set_order_coupon_id()
 RETURNS trigger LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.coupon_code IS NOT NULL AND BTRIM(NEW.coupon_code) <> '' THEN
    SELECT id INTO NEW.coupon_id FROM public.coupons
    WHERE branch_id = NEW.branch_id AND UPPER(BTRIM(code)) = UPPER(BTRIM(NEW.coupon_code));
  END IF;
  RETURN NEW;
END;
$function$;

-- triggers
CREATE TRIGGER check_order_invoice_range_trigger BEFORE INSERT OR UPDATE OF invoice_no, branch_id ON public.orders FOR EACH ROW EXECUTE FUNCTION check_order_invoice_range();
CREATE TRIGGER check_advance_invoice_range_trigger BEFORE INSERT OR UPDATE OF invoice_number, branch_id ON public.advance_orders FOR EACH ROW EXECUTE FUNCTION check_advance_invoice_range();
CREATE TRIGGER set_branch_from_order_trigger BEFORE INSERT ON public.order_items FOR EACH ROW EXECUTE FUNCTION set_branch_from_order();
CREATE TRIGGER set_branch_from_advance_order_trigger BEFORE INSERT ON public.advance_order_timeline FOR EACH ROW EXECUTE FUNCTION set_branch_from_advance_order();
CREATE TRIGGER set_branch_from_advance_order_trigger BEFORE INSERT ON public.advance_order_payments FOR EACH ROW EXECUTE FUNCTION set_branch_from_advance_order();
CREATE TRIGGER set_order_coupon_id_trigger BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION set_order_coupon_id();
CREATE TRIGGER sync_category_name_to_products_trigger AFTER UPDATE OF name_en ON public.categories FOR EACH ROW EXECUTE FUNCTION sync_category_name_to_products();
CREATE TRIGGER delete_movements_for_variant_trigger BEFORE DELETE ON public.product_variants FOR EACH ROW EXECUTE FUNCTION delete_movements_for_variant();
CREATE TRIGGER ensure_one_default_variant_trigger AFTER INSERT OR UPDATE OF is_default ON public.product_variants FOR EACH ROW EXECUTE FUNCTION ensure_one_default_variant();
CREATE TRIGGER delete_movements_for_product_trigger BEFORE DELETE ON public.products FOR EACH ROW EXECUTE FUNCTION delete_movements_for_product();
CREATE TRIGGER sync_product_category_name_trigger BEFORE INSERT OR UPDATE OF category_id ON public.products FOR EACH ROW EXECUTE FUNCTION sync_product_category_name();

COMMIT;
