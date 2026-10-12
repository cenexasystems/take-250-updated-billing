-- 0015 (2026-10-12): refund by payment mode.
--
-- A return can now be refunded to Cash, Card, QR or Other, or to the "original" modes of the bill (a split bill: divided
-- in proportion to what each mode paid; the last mode takes the rounding remainder, so the parts add up exactly).
-- The refund per mode is stored in order_return_refunds, written by process_order_return in the same transaction.
-- Returns made before this migration have no rows there: return_refund_split() derives their split at read time from
-- their refund_mode ('cash' -> cash, 'original' -> the bill's modes), so no existing row is rewritten.
--
-- A bill's payment modes (order_paid_by_mode): the deposit(s) of the advance order it completed, in their own modes, plus
-- the rest of the total in the bill's own mode(s) (split_details for a split, else payment_method). Modes are normalised to
-- cash / card / qr / other ('upi' -> qr; 'online', 'split' without a breakdown, or anything else -> other). The parts
-- always add up to orders.total.
--
-- Nothing applied is edited. Re-created: process_order_return() and order_return_json() (both from 0011; see the diff).
-- The order_returns refund_mode CHECK is widened. Safe to re-run.
BEGIN;

ALTER TABLE public.order_returns DROP CONSTRAINT IF EXISTS order_returns_mode_check;
ALTER TABLE public.order_returns ADD CONSTRAINT order_returns_mode_check CHECK (refund_mode IN ('cash', 'card', 'qr', 'other', 'original'));

CREATE TABLE IF NOT EXISTS public.order_return_refunds (
  id         bigserial     PRIMARY KEY,
  branch_id  text          NOT NULL REFERENCES public.branches(id),
  return_id  uuid          NOT NULL,
  mode       text          NOT NULL,
  amount     numeric(12,2) NOT NULL,
  CONSTRAINT order_return_refunds_mode_check CHECK (mode IN ('cash', 'card', 'qr', 'other')),
  CONSTRAINT order_return_refunds_amount_check CHECK (amount >= 0),
  CONSTRAINT order_return_refunds_one_per_mode UNIQUE (return_id, mode),
  CONSTRAINT order_return_refunds_return_fk FOREIGN KEY (return_id, branch_id) REFERENCES public.order_returns (id, branch_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS order_return_refunds_return_idx ON public.order_return_refunds (branch_id, return_id);

-- any stored payment word -> cash / card / qr / other
CREATE OR REPLACE FUNCTION public.payment_mode_key(p text)
 RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT CASE lower(btrim(COALESCE(p, '')))
           WHEN 'cash' THEN 'cash' WHEN 'card' THEN 'card' WHEN 'qr' THEN 'qr' WHEN 'upi' THEN 'qr'
           ELSE 'other' END
$function$;

-- divide p_amount over the modes of p_parts ({"cash": 600, "card": 400}) in proportion; fixed mode order, the last mode
-- with a share takes the remainder, so the result adds up to p_amount exactly. No parts (or all zero): all to 'other'.
CREATE OR REPLACE FUNCTION public.allocate_by_mode(p_amount numeric, p_parts jsonb)
 RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
AS $function$
DECLARE
  v_modes text[] := ARRAY['cash', 'card', 'qr', 'other'];
  v_total numeric := 0;
  v_last  text;
  v_left  numeric := ROUND(COALESCE(p_amount, 0), 2);
  v_out   jsonb := '{}'::jsonb;
  v_m     text;
  v_share numeric;
BEGIN
  FOREACH v_m IN ARRAY v_modes LOOP
    IF COALESCE((p_parts ->> v_m)::numeric, 0) > 0 THEN v_total := v_total + (p_parts ->> v_m)::numeric; v_last := v_m; END IF;
  END LOOP;
  IF v_total <= 0 OR v_last IS NULL THEN RETURN jsonb_build_object('other', v_left); END IF;
  FOREACH v_m IN ARRAY v_modes LOOP
    CONTINUE WHEN COALESCE((p_parts ->> v_m)::numeric, 0) <= 0;
    IF v_m = v_last THEN v_share := v_left;
    ELSE v_share := ROUND(ROUND(COALESCE(p_amount, 0), 2) * (p_parts ->> v_m)::numeric / v_total, 2);
    END IF;
    v_out := v_out || jsonb_build_object(v_m, v_share);
    v_left := v_left - v_share;
  END LOOP;
  RETURN v_out;
END;
$function$;

-- what a bill took in, per mode; adds up to orders.total
CREATE OR REPLACE FUNCTION public.order_paid_by_mode(p_order_id uuid, p_branch text)
 RETURNS jsonb LANGUAGE plpgsql STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders;
  v_out jsonb := '{}'::jsonb;
  v_dep numeric := 0;
  v_rest numeric;
  v_parts numeric := 0;
  r record;
  v_add jsonb;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id AND branch_id = p_branch;
  IF NOT FOUND OR COALESCE(o.total, 0) <= 0 THEN RETURN '{}'::jsonb; END IF;
  -- deposits of the advance order this bill completed, in their own modes
  FOR r IN
    SELECT public.payment_mode_key(p.payment_method) AS k, SUM(p.amount) AS a
      FROM public.advance_order_payments p JOIN public.advance_orders a ON a.id = p.advance_order_id AND a.branch_id = p.branch_id
     WHERE a.completed_order_id = o.id AND a.branch_id = o.branch_id AND p.payment_type = 'deposit'
     GROUP BY 1
  LOOP
    v_out := v_out || jsonb_build_object(r.k, COALESCE((v_out ->> r.k)::numeric, 0) + r.a);
    v_dep := v_dep + r.a;
  END LOOP;
  v_rest := GREATEST(0, ROUND(o.total - v_dep, 2));
  -- the rest: the split breakdown, else the bill's single mode
  IF jsonb_typeof(o.split_details -> 'payments') = 'array' AND jsonb_array_length(o.split_details -> 'payments') >= 2 THEN
    FOR r IN
      SELECT public.payment_mode_key(e ->> 'method') AS k, SUM((e ->> 'amount')::numeric) AS a
        FROM jsonb_array_elements(o.split_details -> 'payments') e GROUP BY 1
    LOOP
      v_out := v_out || jsonb_build_object(r.k, COALESCE((v_out ->> r.k)::numeric, 0) + r.a);
      v_parts := v_parts + r.a;
    END LOOP;
    -- a cent of rounding between the breakdown and the rest goes to 'other', so the parts still add up to the total
    IF ROUND(v_rest - v_parts, 2) <> 0 THEN
      v_out := v_out || jsonb_build_object('other', COALESCE((v_out ->> 'other')::numeric, 0) + ROUND(v_rest - v_parts, 2));
    END IF;
  ELSIF v_rest > 0 THEN
    v_out := v_out || jsonb_build_object(public.payment_mode_key(o.payment_method),
                                         COALESCE((v_out ->> public.payment_mode_key(o.payment_method))::numeric, 0) + v_rest);
  END IF;
  RETURN v_out;
END;
$function$;

-- one return's refund per mode: the stored rows (0015 on), else (older returns) derived from its refund_mode
CREATE OR REPLACE FUNCTION public.return_refund_split(p_return_id uuid, p_branch text)
 RETURNS jsonb LANGUAGE sql STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT jsonb_object_agg(f.mode, f.amount) FROM public.order_return_refunds f WHERE f.return_id = p_return_id AND f.branch_id = p_branch),
    (SELECT CASE WHEN r.refund_mode = 'original' THEN public.allocate_by_mode(r.refund_amount, public.order_paid_by_mode(r.order_id, r.branch_id))
                 ELSE jsonb_build_object(r.refund_mode, r.refund_amount) END
       FROM public.order_returns r WHERE r.id = p_return_id AND r.branch_id = p_branch),
    '{}'::jsonb)
$function$;

-- a bill's refunds per mode (all its returns), for Order History and the analytics mode cards
CREATE OR REPLACE FUNCTION public.order_refunds_by_mode(p_order_id uuid, p_branch text)
 RETURNS jsonb LANGUAGE sql STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_object_agg(k, s), '{}'::jsonb) FROM (
    SELECT e.key AS k, SUM(e.value::numeric) AS s
      FROM public.order_returns r, jsonb_each_text(public.return_refund_split(r.id, r.branch_id)) e
     WHERE r.order_id = p_order_id AND r.branch_id = p_branch
     GROUP BY e.key) x
$function$;

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
    'refunds', public.return_refund_split(r.id, r.branch_id),
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'order_item_id', i.order_item_id, 'name', i.item_name, 'variant_name', oi.variant_name, 'quantity', i.quantity,
        'restocked', i.restocked, 'refund_amount', i.refund_amount) ORDER BY i.id)
      FROM public.order_return_items i LEFT JOIN public.order_items oi ON oi.id = i.order_item_id AND oi.branch_id = i.branch_id
      WHERE i.return_id = r.id AND i.branch_id = r.branch_id), '[]'::jsonb))
  FROM public.order_returns r JOIN public.orders o ON o.id = r.order_id AND o.branch_id = r.branch_id
  WHERE r.id = p_return_id AND r.branch_id = p_branch;
$function$;

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
  v_paid_modes jsonb;
  v_refunds  jsonb;
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
  -- 0015: refund to one payment mode, or 'original' = back to the modes the bill was paid with (in proportion)
  IF p_refund_mode NOT IN ('cash', 'card', 'qr', 'other', 'original') THEN RAISE EXCEPTION 'Refund mode must be cash, card, qr, other or original'; END IF;
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

  -- the refund per payment mode (0015), computed here: one mode gets it all, 'original' divides it like the bill was paid
  v_paid_modes := public.order_paid_by_mode(v_order.id, v_branch);
  v_refunds := CASE WHEN p_refund_mode = 'original' THEN public.allocate_by_mode(v_total, v_paid_modes)
                    ELSE jsonb_build_object(p_refund_mode, v_total) END;

  IF p_dry_run THEN
    FOR v_i IN 1 .. array_length(v_ids, 1) LOOP
      v_lines := v_lines || jsonb_build_object('order_item_id', v_ids[v_i], 'quantity', v_qs[v_i], 'restock', v_rs[v_i], 'refund_amount', v_refs[v_i]);
    END LOOP;
    RETURN jsonb_build_object('dry_run', true, 'refund_amount', v_total, 'lines', v_lines, 'refunds', v_refunds, 'paid_by_mode', v_paid_modes);
  END IF;

  INSERT INTO public.order_return_counters (branch_id, last_no) VALUES (v_branch, 1)
    ON CONFLICT (branch_id) DO UPDATE SET last_no = public.order_return_counters.last_no + 1
    RETURNING last_no INTO v_n;
  v_return_no := 'RET-' || upper(v_branch) || '-' || LPAD(v_n::text, 6, '0');
  INSERT INTO public.order_returns (branch_id, return_no, order_id, invoice_no, reason, note, refund_mode, refund_amount, created_by_role, idempotency_key)
    VALUES (v_branch, v_return_no, v_order.id, v_order.invoice_no, BTRIM(p_reason), COALESCE(BTRIM(p_note), ''), p_refund_mode, v_total, COALESCE(NULLIF(p_by, ''), 'unknown'), p_idempotency_key)
    RETURNING id INTO v_return_id;
  INSERT INTO public.order_return_refunds (branch_id, return_id, mode, amount)
    SELECT v_branch, v_return_id, key, value::numeric FROM jsonb_each_text(v_refunds) WHERE value::numeric > 0;

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

COMMIT;
