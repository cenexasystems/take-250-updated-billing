-- 0011 (2026-10-10): order returns replace order cancellation.
-- (The request said "0007"; 0007-0010 are already applied, so this is the next free number. Nothing applied is edited.)
-- Safe to re-run: IF NOT EXISTS / CREATE OR REPLACE / DROP IF EXISTS everywhere. Adds nullable/defaulted columns, three
-- tables and functions; the only existing objects re-created are the order status CHECK (new values added), the
-- cancel_order() function (now return-aware, still used by the Admin "delete order" and the duplicate-clean-up script)
-- and nothing else. No row is rewritten.
--
-- Run against a Neon BRANCH first:   DATABASE_URL_UNPOOLED=<direct url of the branch> npm run db:migrate
BEGIN;

-- ============================================================ 1. orders: statuses + a running refund total
-- returned_amount = everything refunded so far on THIS bill (goods + tax, never delivery). Reports subtract it from the
-- bill's own total, so a return reduces the day of the ORIGINAL sale and never creates a negative sale on the return date.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS returned_amount   numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS last_returned_at  timestamptz;
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_returned_amount_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_returned_amount_check CHECK (returned_amount >= 0);

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_check;
-- 'cancelled' stays allowed ONLY so the rows that already carry it remain valid history. NOT VALID: old rows are not re-checked.
ALTER TABLE public.orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending', 'completed', 'cancelled', 'partially_returned', 'returned')) NOT VALID;

-- composite key the return items point at (same pattern as every other branch-scoped table)
ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_id_branch_key;
ALTER TABLE public.order_items ADD CONSTRAINT order_items_id_branch_key UNIQUE (id, branch_id);

-- ============================================================ 2. credit records
CREATE TABLE IF NOT EXISTS public.order_return_counters (
  branch_id text PRIMARY KEY REFERENCES public.branches(id),
  last_no   integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.order_returns (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  branch_id        text        NOT NULL REFERENCES public.branches(id),
  return_no        text        NOT NULL,                 -- RET-POS1-000001 (own counter per branch)
  order_id         uuid        NOT NULL,
  invoice_no       text        NOT NULL,                 -- the ORIGINAL invoice, copied so the receipt always names it
  reason           text        NOT NULL,
  note             text        NOT NULL DEFAULT '',
  refund_mode      text        NOT NULL DEFAULT 'cash',
  refund_amount    numeric(12,2) NOT NULL DEFAULT 0,
  created_by_role  text        NOT NULL,
  idempotency_key  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_returns_pkey PRIMARY KEY (id),
  CONSTRAINT order_returns_id_branch_key UNIQUE (id, branch_id),
  CONSTRAINT order_returns_no_key UNIQUE (branch_id, return_no),
  CONSTRAINT order_returns_amount_check CHECK (refund_amount >= 0),
  CONSTRAINT order_returns_mode_check CHECK (refund_mode IN ('cash', 'original')),
  CONSTRAINT order_returns_order_fk FOREIGN KEY (order_id, branch_id) REFERENCES public.orders (id, branch_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS order_returns_branch_idempotency_key
  ON public.order_returns (branch_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_returns_order_idx ON public.order_returns (branch_id, order_id);

CREATE TABLE IF NOT EXISTS public.order_return_items (
  id             bigserial   PRIMARY KEY,
  branch_id      text        NOT NULL REFERENCES public.branches(id),
  return_id      uuid        NOT NULL,
  order_item_id  bigint      NOT NULL,
  product_id     bigint,
  variant_id     uuid,
  item_name      text        NOT NULL DEFAULT '',
  quantity       numeric(12,3) NOT NULL,
  restocked      boolean     NOT NULL DEFAULT true,       -- false = damaged: no stock added, a DAMAGE movement is logged
  refund_amount  numeric(12,2) NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_return_items_qty_check CHECK (quantity > 0),
  CONSTRAINT order_return_items_amount_check CHECK (refund_amount >= 0),
  CONSTRAINT order_return_items_return_fk FOREIGN KEY (return_id, branch_id) REFERENCES public.order_returns (id, branch_id) ON DELETE CASCADE,
  CONSTRAINT order_return_items_item_fk FOREIGN KEY (order_item_id, branch_id) REFERENCES public.order_items (id, branch_id) ON DELETE CASCADE,
  CONSTRAINT order_return_items_product_fk FOREIGN KEY (product_id, branch_id) REFERENCES public.products (id, branch_id) ON DELETE SET NULL (product_id),
  CONSTRAINT order_return_items_variant_fk FOREIGN KEY (variant_id, branch_id) REFERENCES public.product_variants (id, branch_id) ON DELETE SET NULL (variant_id)
);
CREATE INDEX IF NOT EXISTS order_return_items_item_idx ON public.order_return_items (branch_id, order_item_id);
CREATE INDEX IF NOT EXISTS order_return_items_return_idx ON public.order_return_items (branch_id, return_id);

-- The last line of defence for "cannot return more than was bought": even a hand-written INSERT cannot over-return.
CREATE OR REPLACE FUNCTION public.order_return_items_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_bought   numeric;
  v_returned numeric;
BEGIN
  SELECT quantity INTO v_bought FROM public.order_items WHERE id = NEW.order_item_id AND branch_id = NEW.branch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item does not belong to this bill'; END IF;
  SELECT COALESCE(SUM(quantity), 0) INTO v_returned FROM public.order_return_items WHERE order_item_id = NEW.order_item_id AND branch_id = NEW.branch_id;
  IF v_returned + NEW.quantity > v_bought + 0.0005 THEN
    RAISE EXCEPTION 'Cannot return more than was bought (bought %, already returned %, now %)', v_bought, v_returned, NEW.quantity;
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS order_return_items_guard ON public.order_return_items;
CREATE TRIGGER order_return_items_guard BEFORE INSERT ON public.order_return_items FOR EACH ROW EXECUTE FUNCTION public.order_return_items_guard();

-- ============================================================ 3. one JSON shape for a return (receipt, history, API result)
CREATE OR REPLACE FUNCTION public.order_return_json(p_return_id uuid, p_branch text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'return_id', r.id, 'return_no', r.return_no, 'order_id', r.order_id, 'invoice_no', r.invoice_no,
    'refund_amount', r.refund_amount, 'refund_mode', r.refund_mode, 'reason', r.reason, 'note', r.note,
    'created_by_role', r.created_by_role, 'created_at', r.created_at,
    'order_status', o.status, 'order_returned_amount', o.returned_amount,
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'order_item_id', i.order_item_id, 'name', i.item_name, 'variant_name', oi.variant_name, 'quantity', i.quantity,
        'restocked', i.restocked, 'refund_amount', i.refund_amount) ORDER BY i.id)
      FROM public.order_return_items i LEFT JOIN public.order_items oi ON oi.id = i.order_item_id AND oi.branch_id = i.branch_id
      WHERE i.return_id = r.id AND i.branch_id = r.branch_id), '[]'::jsonb))
  FROM public.order_returns r JOIN public.orders o ON o.id = r.order_id AND o.branch_id = r.branch_id
  WHERE r.id = p_return_id AND r.branch_id = p_branch;
$function$;

-- ============================================================ 4. the return itself (one transaction, row locks, idempotent)
-- p_items: [{"order_item_id": 12, "quantity": 1, "restock": true}, ...]
-- Refund per item (computed here, never in the browser):
--   goods paid  = subtotal of all lines - coupon discount - manual discount (never below 0)
--   pool        = goods paid + GST of the bill        (delivery is never refunded)
--   item paid   = ROUND(line_total / subtotal * pool, 2)             <- the item's share of discount AND of GST
--   refund      = ROUND(item paid * qty returned / qty bought, 2); the LAST units of a line get "item paid - refunded so far",
--                 so the parts always add up to exactly what was paid, and the bill total is capped at pool - already refunded.
-- p_dry_run = true only calculates (the modal's "refund amount" preview); nothing is written, nothing is locked for long.
CREATE OR REPLACE FUNCTION public.process_order_return(
  p_order_id uuid, p_branch text, p_items jsonb, p_reason text, p_note text DEFAULT ''::text, p_refund_mode text DEFAULT 'cash'::text,
  p_by text DEFAULT ''::text, p_idempotency_key text DEFAULT NULL::text, p_dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_branch   text := public.resolve_branch(p_branch);
  v_order    public.orders;
  v_existing public.order_returns;
  v_item     public.order_items;
  v_req      record;
  v_sum      numeric;
  v_pool     numeric;
  v_ret_q    numeric;
  v_ret_amt  numeric;
  v_left     numeric;
  v_paid     numeric;
  v_refund   numeric;
  v_total    numeric := 0;
  v_cap      numeric;
  v_ids      bigint[]  := ARRAY[]::bigint[];
  v_qs       numeric[] := ARRAY[]::numeric[];
  v_rs       boolean[] := ARRAY[]::boolean[];
  v_refs     numeric[] := ARRAY[]::numeric[];
  v_n        integer;
  v_return_id uuid;
  v_return_no text;
  v_before   numeric;
  v_after    numeric;
  v_barcode  uuid;
  v_status   text;
  v_i        integer;
  v_lines    jsonb := '[]'::jsonb;
  v_note     text;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id AND branch_id = v_branch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;

  -- double submit: the same key returns the FIRST return and changes nothing
  IF p_idempotency_key IS NOT NULL AND NOT p_dry_run THEN
    SELECT * INTO v_existing FROM public.order_returns WHERE branch_id = v_branch AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_existing.order_id <> p_order_id THEN RAISE EXCEPTION 'This request key was already used for another bill'; END IF;
      RETURN public.order_return_json(v_existing.id, v_branch) || jsonb_build_object('replayed', true);
    END IF;
  END IF;

  IF v_order.status NOT IN ('completed', 'partially_returned') THEN
    RAISE EXCEPTION 'Only a completed bill can be returned (this bill is %)', v_order.status;
  END IF;
  IF NOT p_dry_run AND (p_reason IS NULL OR BTRIM(p_reason) = '') THEN RAISE EXCEPTION 'A reason is required'; END IF;
  IF p_refund_mode NOT IN ('cash', 'original') THEN RAISE EXCEPTION 'Refund mode must be cash or original'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'Select at least one item to return'; END IF;

  SELECT COALESCE(SUM(line_total), 0) INTO v_sum FROM public.order_items WHERE order_id = v_order.id AND branch_id = v_branch;
  v_pool := GREATEST(0, v_sum - v_order.discount_amount - v_order.manual_discount_amount) + v_order.total_gst;

  FOR v_req IN
    SELECT (e->>'order_item_id')::bigint AS id, SUM((e->>'quantity')::numeric) AS q, bool_and(COALESCE((e->>'restock')::boolean, true)) AS rs
    FROM jsonb_array_elements(p_items) e
    GROUP BY 1 ORDER BY 1
  LOOP
    CONTINUE WHEN v_req.q IS NULL OR v_req.q <= 0;
    SELECT * INTO v_item FROM public.order_items WHERE id = v_req.id AND order_id = v_order.id AND branch_id = v_branch FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Item does not belong to this bill'; END IF;
    SELECT COALESCE(SUM(quantity), 0), COALESCE(SUM(refund_amount), 0) INTO v_ret_q, v_ret_amt
      FROM public.order_return_items WHERE order_item_id = v_item.id AND branch_id = v_branch;
    v_left := v_item.quantity - v_ret_q;
    IF v_req.q > v_left + 0.0005 THEN
      RAISE EXCEPTION 'Cannot return % of "%": only % left to return', trim_scale(v_req.q), v_item.name, trim_scale(v_left);
    END IF;
    v_paid := CASE WHEN v_sum > 0 THEN ROUND(v_item.line_total / v_sum * v_pool, 2) ELSE 0 END;
    IF v_req.q >= v_left - 0.0005 THEN v_refund := v_paid - v_ret_amt;
    ELSE v_refund := ROUND(v_paid * v_req.q / v_item.quantity, 2);
    END IF;
    v_refund := GREATEST(0, LEAST(v_refund, v_paid - v_ret_amt));
    v_ids := v_ids || v_item.id; v_qs := v_qs || v_req.q; v_rs := v_rs || v_req.rs; v_refs := v_refs || v_refund;
    v_total := v_total + v_refund;
  END LOOP;
  IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN RAISE EXCEPTION 'Select at least one item to return'; END IF;

  -- never refund more than the bill took in for goods + tax
  v_cap := GREATEST(0, ROUND(v_pool, 2) - v_order.returned_amount);
  IF v_total > v_cap THEN
    v_n := array_length(v_ids, 1);
    v_refs[v_n] := GREATEST(0, v_refs[v_n] - (v_total - v_cap));
    v_total := (SELECT COALESCE(SUM(x), 0) FROM unnest(v_refs) x);
  END IF;

  IF p_dry_run THEN
    FOR v_i IN 1 .. array_length(v_ids, 1) LOOP
      v_lines := v_lines || jsonb_build_object('order_item_id', v_ids[v_i], 'quantity', v_qs[v_i], 'restock', v_rs[v_i], 'refund_amount', v_refs[v_i]);
    END LOOP;
    RETURN jsonb_build_object('dry_run', true, 'refund_amount', v_total, 'lines', v_lines);
  END IF;

  INSERT INTO public.order_return_counters (branch_id, last_no) VALUES (v_branch, 1)
    ON CONFLICT (branch_id) DO UPDATE SET last_no = public.order_return_counters.last_no + 1
    RETURNING last_no INTO v_n;
  v_return_no := 'RET-' || upper(v_branch) || '-' || LPAD(v_n::text, 6, '0');
  INSERT INTO public.order_returns (branch_id, return_no, order_id, invoice_no, reason, note, refund_mode, refund_amount, created_by_role, idempotency_key)
    VALUES (v_branch, v_return_no, v_order.id, v_order.invoice_no, BTRIM(p_reason), COALESCE(BTRIM(p_note), ''), p_refund_mode, v_total, COALESCE(NULLIF(p_by, ''), 'unknown'), p_idempotency_key)
    RETURNING id INTO v_return_id;

  v_note := 'Return ' || v_return_no || ' of ' || v_order.invoice_no || ': ' || BTRIM(p_reason);
  FOR v_i IN 1 .. array_length(v_ids, 1) LOOP
    SELECT * INTO v_item FROM public.order_items WHERE id = v_ids[v_i] AND branch_id = v_branch;
    INSERT INTO public.order_return_items (branch_id, return_id, order_item_id, product_id, variant_id, item_name, quantity, restocked, refund_amount)
      VALUES (v_branch, v_return_id, v_item.id, v_item.product_id, v_item.variant_id,
              v_item.name || COALESCE(' (' || NULLIF(v_item.variant_name, '') || ')', ''), v_qs[v_i], v_rs[v_i] AND NOT v_item.is_manual, v_refs[v_i]);

    CONTINUE WHEN v_item.is_manual OR v_item.product_id IS NULL;    -- loose / unregistered items have no stock

    IF v_item.variant_id IS NOT NULL THEN
      SELECT stock INTO v_before FROM public.product_variants WHERE id = v_item.variant_id AND branch_id = v_branch FOR UPDATE;
      CONTINUE WHEN NOT FOUND;
      v_after := CASE WHEN v_rs[v_i] THEN v_before + v_qs[v_i] ELSE v_before END;
      SELECT id INTO v_barcode FROM public.barcode_registry WHERE variant_id = v_item.variant_id AND branch_id = v_branch AND is_active = TRUE LIMIT 1;
      IF v_rs[v_i] THEN
        UPDATE public.product_variants SET stock = v_after, updated_at = NOW() WHERE id = v_item.variant_id AND branch_id = v_branch;
        UPDATE public.products
        SET stock_quantity = (SELECT COALESCE(SUM(stock), 0) FROM public.product_variants WHERE product_id = v_item.product_id AND branch_id = v_branch AND is_active = TRUE),
            stock = FLOOR((SELECT COALESCE(SUM(stock), 0) FROM public.product_variants WHERE product_id = v_item.product_id AND branch_id = v_branch AND is_active = TRUE))::INTEGER,
            updated_at = NOW()
        WHERE id = v_item.product_id AND branch_id = v_branch;
      END IF;
    ELSE
      SELECT stock_quantity INTO v_before FROM public.products WHERE id = v_item.product_id AND branch_id = v_branch FOR UPDATE;
      CONTINUE WHEN NOT FOUND;
      v_after := CASE WHEN v_rs[v_i] THEN v_before + v_qs[v_i] ELSE v_before END;
      SELECT id INTO v_barcode FROM public.barcode_registry WHERE product_id = v_item.product_id AND variant_id IS NULL AND branch_id = v_branch AND is_active = TRUE LIMIT 1;
      IF v_rs[v_i] THEN
        UPDATE public.products SET stock_quantity = v_after, stock = stock + FLOOR(v_qs[v_i])::INTEGER, updated_at = NOW()
        WHERE id = v_item.product_id AND branch_id = v_branch;
      END IF;
    END IF;
    INSERT INTO public.inventory_movements (product_id, variant_id, barcode_id, movement_type, quantity_delta, quantity_before, quantity_after,
                                            reference_type, reference_id, note, created_by_name, branch_id)
    VALUES (v_item.product_id, v_item.variant_id, v_barcode,
            CASE WHEN v_rs[v_i] THEN 'RETURN' ELSE 'DAMAGE' END,
            CASE WHEN v_rs[v_i] THEN v_qs[v_i] ELSE 0 END, v_before, v_after,
            'order_return', v_return_no,
            CASE WHEN v_rs[v_i] THEN v_note ELSE v_note || ' (' || v_qs[v_i] || ' unit(s) came back damaged: not added to stock)' END,
            COALESCE(NULLIF(p_by, ''), 'unknown'), v_branch);
  END LOOP;

  -- the bill itself keeps its invoice number, items and totals: only its status and its running refund total move
  v_status := CASE WHEN EXISTS (
      SELECT 1 FROM public.order_items oi
      WHERE oi.order_id = v_order.id AND oi.branch_id = v_branch AND oi.quantity > 0
        AND oi.quantity > COALESCE((SELECT SUM(ri.quantity) FROM public.order_return_items ri WHERE ri.order_item_id = oi.id AND ri.branch_id = v_branch), 0) + 0.0005
    ) THEN 'partially_returned' ELSE 'returned' END;
  UPDATE public.orders SET status = v_status, returned_amount = returned_amount + v_total, last_returned_at = NOW(), updated_at = NOW()
   WHERE id = v_order.id AND branch_id = v_branch;
  -- a bill that is now fully returned frees its coupon use (once: only an open bill can become 'returned')
  IF v_status = 'returned' AND v_order.coupon_code IS NOT NULL AND BTRIM(v_order.coupon_code) <> '' THEN
    UPDATE public.coupons SET usage_count = GREATEST(0, usage_count - 1), updated_at = NOW()
     WHERE UPPER(BTRIM(code)) = UPPER(BTRIM(v_order.coupon_code)) AND branch_id = v_branch;
  END IF;

  RETURN public.order_return_json(v_return_id, v_branch);
END;
$function$;

-- ============================================================ 5. cancel_order(): return-aware
-- There is no cancel action in the app any more. This function stays ONLY as the internal "put the stock back" step of the
-- Admin's permanent order delete and of db/maintenance/duplicates_cancel.sql. It can no longer restock twice:
--   * it refuses a bill that is already cancelled OR fully returned,
--   * for a partly returned bill it restocks only the units that were never returned.
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
  v_qty       numeric;
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
  IF v_order.status = 'returned' THEN
    RAISE EXCEPTION 'Order % is already fully returned', v_order.invoice_no;
  END IF;

  FOR v_item IN
    SELECT * FROM public.order_items
    WHERE order_id = v_order.id AND branch_id = v_branch AND NOT is_manual AND quantity > 0
    ORDER BY id
  LOOP
    v_qty := v_item.quantity - COALESCE((SELECT SUM(quantity) FROM public.order_return_items WHERE order_item_id = v_item.id AND branch_id = v_branch), 0);
    CONTINUE WHEN v_qty <= 0;
    IF v_item.variant_id IS NOT NULL THEN
      SELECT stock INTO v_before FROM public.product_variants WHERE id = v_item.variant_id AND branch_id = v_branch FOR UPDATE;
      IF FOUND THEN
        v_after := v_before + v_qty;
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
        VALUES (v_item.product_id, v_item.variant_id, v_barcode, 'CANCELLATION_RESTOCK', v_qty, v_before, v_after,
                'order_cancel', v_order.invoice_no, 'Order removed: ' || COALESCE(NULLIF(BTRIM(p_reason), ''), 'no reason given'), COALESCE(p_cancelled_by, ''), v_branch);
        v_restocked := v_restocked + 1;
      END IF;
    ELSIF v_item.product_id IS NOT NULL THEN
      SELECT stock_quantity INTO v_before FROM public.products WHERE id = v_item.product_id AND branch_id = v_branch FOR UPDATE;
      IF FOUND THEN
        v_after := v_before + v_qty;
        SELECT id INTO v_barcode FROM public.barcode_registry WHERE product_id = v_item.product_id AND variant_id IS NULL AND branch_id = v_branch AND is_active = TRUE LIMIT 1;
        UPDATE public.products
        SET stock_quantity = v_after, stock = stock + FLOOR(v_qty)::INTEGER, updated_at = NOW()
        WHERE id = v_item.product_id AND branch_id = v_branch;
        INSERT INTO public.inventory_movements (product_id, variant_id, barcode_id, movement_type, quantity_delta, quantity_before, quantity_after,
                                                reference_type, reference_id, note, created_by_name, branch_id)
        VALUES (v_item.product_id, NULL, v_barcode, 'CANCELLATION_RESTOCK', v_qty, v_before, v_after,
                'order_cancel', v_order.invoice_no, 'Order removed: ' || COALESCE(NULLIF(BTRIM(p_reason), ''), 'no reason given'), COALESCE(p_cancelled_by, ''), v_branch);
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

COMMIT;
