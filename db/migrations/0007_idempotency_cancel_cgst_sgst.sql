-- 0007 (2026-10-08): duplicate-proof bills, order cancel with restock, CGST / SGST split.
-- Safe to re-run: every statement is IF NOT EXISTS / CREATE OR REPLACE / DROP IF EXISTS. Adds nullable columns and a
-- trigger only: nothing existing is rewritten except the (re-created) stock-movement type list.
--
-- Run against a Neon BRANCH first (see docs/NEON_MIGRATION_0007.md):
--   DATABASE_URL_UNPOOLED=<direct url of the branch> npm run db:migrate
BEGIN;

-- ============================================================ 1. duplicate bills (idempotency)
-- The browser sends one random key per bill / advance order. A second request with the same key (double tap,
-- retry after a slow network) can never create a second row: the unique index rejects it and the API returns the first.
-- Invoice numbers come from per-branch sequences and DEP numbers from deposit_number_seq (never MAX()+1).
ALTER TABLE public.orders          ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.advance_orders  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- unique per branch (keys are random UUIDs, the branch part only keeps one shop's keys from ever meeting another's)
CREATE UNIQUE INDEX IF NOT EXISTS orders_branch_idempotency_key
  ON public.orders (branch_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS advance_orders_branch_idempotency_key
  ON public.advance_orders (branch_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ============================================================ 2. cancel + restock
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cancelled_at   timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cancelled_by   text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cancel_reason  text;

-- allowed statuses (NOT VALID: new and changed rows are checked, old rows are left as they are)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_status_check' AND conrelid = 'public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_status_check CHECK (status IN ('pending', 'completed', 'cancelled')) NOT VALID;
  END IF;
END $$;

-- the stock ledger gets a movement type for a cancellation (originals are never edited or deleted)
ALTER TABLE public.inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_movement_type_check;
ALTER TABLE public.inventory_movements ADD CONSTRAINT inventory_movements_movement_type_check
  CHECK (movement_type = ANY (ARRAY['INITIAL_BARCODE_STOCK', 'RESTOCK', 'SALE', 'RETURN', 'DAMAGE', 'CORRECTION', 'VOID', 'CANCELLATION_RESTOCK']));

-- One transaction (the caller's): lock the bill, refuse a second cancel, put every item back in stock, write a
-- reversing CANCELLATION_RESTOCK movement per item, give a coupon use back, mark the bill cancelled.
CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id uuid, p_branch text, p_cancelled_by text DEFAULT ''::text, p_reason text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_branch    text := public.resolve_branch(p_branch);
  v_order     public.orders;
  v_item      record;
  v_before    numeric;
  v_after     numeric;
  v_barcode   uuid;
  v_restocked integer := 0;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id AND branch_id = v_branch FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_order.status = 'cancelled' THEN
    RAISE EXCEPTION 'Order % is already cancelled', v_order.invoice_no;
  END IF;

  FOR v_item IN
    SELECT * FROM public.order_items
    WHERE order_id = v_order.id AND branch_id = v_branch AND NOT is_manual AND quantity > 0
    ORDER BY id
  LOOP
    IF v_item.variant_id IS NOT NULL THEN
      SELECT stock INTO v_before FROM public.product_variants WHERE id = v_item.variant_id AND branch_id = v_branch FOR UPDATE;
      IF FOUND THEN
        v_after := v_before + v_item.quantity;
        SELECT id INTO v_barcode FROM public.barcode_registry WHERE variant_id = v_item.variant_id AND branch_id = v_branch AND is_active = TRUE LIMIT 1;
        UPDATE public.product_variants SET stock = v_after, updated_at = NOW() WHERE id = v_item.variant_id AND branch_id = v_branch;
        IF v_item.product_id IS NOT NULL THEN
          UPDATE public.products
          SET stock_quantity = (SELECT COALESCE(SUM(stock), 0) FROM public.product_variants WHERE product_id = v_item.product_id AND branch_id = v_branch AND is_active = TRUE),
              stock = FLOOR((SELECT COALESCE(SUM(stock), 0) FROM public.product_variants WHERE product_id = v_item.product_id AND branch_id = v_branch AND is_active = TRUE))::INTEGER,
              updated_at = NOW()
          WHERE id = v_item.product_id AND branch_id = v_branch;
        END IF;
        INSERT INTO public.inventory_movements (product_id, variant_id, barcode_id, movement_type, quantity_delta, quantity_before, quantity_after,
                                                reference_type, reference_id, note, created_by_name, branch_id)
        VALUES (v_item.product_id, v_item.variant_id, v_barcode, 'CANCELLATION_RESTOCK', v_item.quantity, v_before, v_after,
                'order_cancel', v_order.invoice_no, 'Order cancelled: ' || COALESCE(NULLIF(BTRIM(p_reason), ''), 'no reason given'), COALESCE(p_cancelled_by, ''), v_branch);
        v_restocked := v_restocked + 1;
      END IF;
    ELSIF v_item.product_id IS NOT NULL THEN
      SELECT stock_quantity INTO v_before FROM public.products WHERE id = v_item.product_id AND branch_id = v_branch FOR UPDATE;
      IF FOUND THEN
        v_after := v_before + v_item.quantity;
        SELECT id INTO v_barcode FROM public.barcode_registry WHERE product_id = v_item.product_id AND variant_id IS NULL AND branch_id = v_branch AND is_active = TRUE LIMIT 1;
        UPDATE public.products
        SET stock_quantity = v_after, stock = stock + FLOOR(v_item.quantity)::INTEGER, updated_at = NOW()
        WHERE id = v_item.product_id AND branch_id = v_branch;
        INSERT INTO public.inventory_movements (product_id, variant_id, barcode_id, movement_type, quantity_delta, quantity_before, quantity_after,
                                                reference_type, reference_id, note, created_by_name, branch_id)
        VALUES (v_item.product_id, NULL, v_barcode, 'CANCELLATION_RESTOCK', v_item.quantity, v_before, v_after,
                'order_cancel', v_order.invoice_no, 'Order cancelled: ' || COALESCE(NULLIF(BTRIM(p_reason), ''), 'no reason given'), COALESCE(p_cancelled_by, ''), v_branch);
        v_restocked := v_restocked + 1;
      END IF;
    END IF;
  END LOOP;

  IF v_order.coupon_code IS NOT NULL AND BTRIM(v_order.coupon_code) <> '' THEN
    UPDATE public.coupons SET usage_count = GREATEST(0, usage_count - 1), updated_at = NOW()
    WHERE UPPER(BTRIM(code)) = UPPER(BTRIM(v_order.coupon_code)) AND branch_id = v_branch;
  END IF;

  UPDATE public.orders
  SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = COALESCE(p_cancelled_by, ''), cancel_reason = COALESCE(p_reason, ''), updated_at = NOW()
  WHERE id = v_order.id AND branch_id = v_branch;

  RETURN jsonb_build_object('order_id', v_order.id, 'invoice_no', v_order.invoice_no, 'restocked_items', v_restocked, 'status', 'cancelled');
END;
$function$;

-- ============================================================ 3. CGST / SGST
-- GST on a bill is one amount (total_gst, added on top of the discounted goods value). It is split in two halves:
-- CGST rounds DOWN to the paisa, SGST takes the rest, so CGST + SGST always equals the GST exactly.
-- The rates do not differ per item in this app (GST is entered per bill), so order_items needs no extra columns.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS taxable_amount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cgst_amount    numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS sgst_amount    numeric(12,2) NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.set_order_gst_split()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.cgst_amount    := floor(COALESCE(NEW.total_gst, 0) / 2 * 100) / 100;
  NEW.sgst_amount    := COALESCE(NEW.total_gst, 0) - NEW.cgst_amount;
  NEW.taxable_amount := GREATEST(0, COALESCE(NEW.subtotal, 0) - COALESCE(NEW.discount_amount, 0) - COALESCE(NEW.manual_discount_amount, 0));
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS set_order_gst_split_trigger ON public.orders;
CREATE TRIGGER set_order_gst_split_trigger
  BEFORE INSERT OR UPDATE OF subtotal, total_gst, discount_amount, manual_discount_amount ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.set_order_gst_split();

-- backfill every existing bill (idempotent: the same formula, so a re-run changes nothing)
UPDATE public.orders
SET cgst_amount    = floor(COALESCE(total_gst, 0) / 2 * 100) / 100,
    sgst_amount    = COALESCE(total_gst, 0) - floor(COALESCE(total_gst, 0) / 2 * 100) / 100,
    taxable_amount = GREATEST(0, COALESCE(subtotal, 0) - COALESCE(discount_amount, 0) - COALESCE(manual_discount_amount, 0))
WHERE cgst_amount IS DISTINCT FROM floor(COALESCE(total_gst, 0) / 2 * 100) / 100
   OR sgst_amount IS DISTINCT FROM COALESCE(total_gst, 0) - floor(COALESCE(total_gst, 0) / 2 * 100) / 100
   OR taxable_amount IS DISTINCT FROM GREATEST(0, COALESCE(subtotal, 0) - COALESCE(discount_amount, 0) - COALESCE(manual_discount_amount, 0));

COMMIT;
