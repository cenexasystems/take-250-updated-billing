-- 0009: completing an advance order also takes stock out for deposits identified by product name only (typed on the Advance Orders screen).
-- Same stock lock, shortage check, deduction and SALE ledger row as before; exact-name, one active variant-free product per branch, else untracked.
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
  v_barcode_id     uuid;
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

    -- Deposits typed on the Advance Orders screen carry only a product NAME (no ids). Match it to ONE active,
    -- variant-free product of this branch by exact name so it is deducted and logged like any other sale line.
    -- Zero matches (a service / custom job), several matches, or a product with variants -> left untracked, as before.
    IF v_product_id IS NULL AND v_variant_id IS NULL AND NOT coalesce((v_item ->> 'is_manual')::boolean, FALSE) THEN
      SELECT min(p.id) INTO v_product_id
      FROM public.products p
      WHERE p.branch_id = v_branch AND p.is_active
        AND lower(btrim(p.name)) = lower(v_name)
        AND NOT coalesce(p.has_variants, FALSE)
        AND NOT EXISTS (SELECT 1 FROM public.product_variants pv WHERE pv.product_id = p.id AND pv.branch_id = v_branch)
      HAVING count(*) = 1;
    END IF;

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
      SELECT id INTO v_barcode_id FROM public.barcode_registry
      WHERE variant_id = v_variant_id AND branch_id = v_branch AND is_active = TRUE LIMIT 1;

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
      SELECT id INTO v_barcode_id FROM public.barcode_registry
      WHERE product_id = v_product_id AND variant_id IS NULL AND branch_id = v_branch AND is_active = TRUE LIMIT 1;

      UPDATE public.products
      SET stock_quantity = greatest(0, stock_quantity - v_quantity),
          stock = greatest(0, floor(stock_quantity - v_quantity))::integer,
          updated_at = v_now
      WHERE id = v_product_id AND branch_id = v_branch;
    END IF;

    INSERT INTO public.inventory_movements (
      product_id, variant_id, barcode_id, movement_type,
      quantity_delta, quantity_before, quantity_after,
      reference_type, reference_id, note, branch_id
    ) VALUES (
      v_product_id, v_variant_id, v_barcode_id, 'SALE',
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
