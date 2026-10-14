-- 0016 (2026-10-14): public online shop (/shop) + Admin enquiry dashboard.
--
-- Customers browse a branch's "show online" products and send a REQUEST (an enquiry), not a bill: no payment, no stock
-- movement, no order, no revenue. The shop phones the customer; the Admin tracks the request through its statuses and
-- may add a delivery charge later. Every table carries branch_id with composite keys, like the rest of the schema.
--
-- products: show_online (default false: every existing product stays hidden), online_price (NULL = the normal price),
-- online_description, online_sort. Nothing else about products changes; no existing row is rewritten.
-- Nothing applied is edited. Re-created: register_branch() (from 0004, + the new branch's request counter). Safe to re-run.
BEGIN;

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS show_online        boolean NOT NULL DEFAULT false;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS online_price       numeric(12,2);
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS online_description text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS online_sort        integer;
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_online_price_check;
ALTER TABLE public.products ADD CONSTRAINT products_online_price_check CHECK (online_price IS NULL OR online_price >= 0);
CREATE INDEX IF NOT EXISTS products_branch_online_idx ON public.products (branch_id, online_sort, name) WHERE show_online;

-- ============================================================ request numbers: one counter row per branch
CREATE TABLE IF NOT EXISTS public.shop_enquiry_counters (
  branch_id text PRIMARY KEY REFERENCES public.branches(id),
  last_no   integer NOT NULL DEFAULT 0
);
INSERT INTO public.shop_enquiry_counters (branch_id, last_no) SELECT id, 0 FROM public.branches ON CONFLICT (branch_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.shop_enquiries (
  id              uuid          NOT NULL DEFAULT gen_random_uuid(),
  branch_id       text          NOT NULL REFERENCES public.branches(id),
  enquiry_no      text          NOT NULL,                      -- ENQ-POS1-000001: the branch is in the number, so it is globally unique
  customer_name   text          NOT NULL,
  phone           text          NOT NULL,                      -- canonical 10-digit mobile
  address         text          NOT NULL,
  note            text          NOT NULL DEFAULT '',
  status          text          NOT NULL DEFAULT 'new',
  items_total     numeric(12,2) NOT NULL DEFAULT 0,
  delivery_charge numeric(12,2),
  admin_note      text          NOT NULL DEFAULT '',
  idempotency_key text,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT shop_enquiries_pkey PRIMARY KEY (id),
  CONSTRAINT shop_enquiries_id_branch_key UNIQUE (id, branch_id),
  CONSTRAINT shop_enquiries_no_key UNIQUE (enquiry_no),
  CONSTRAINT shop_enquiries_branch_no_key UNIQUE (branch_id, enquiry_no),
  CONSTRAINT shop_enquiries_status_check CHECK (status IN ('new', 'contacted', 'confirmed', 'delivered', 'cancelled')),
  CONSTRAINT shop_enquiries_phone_check CHECK (phone ~ '^[6-9][0-9]{9}$'),
  CONSTRAINT shop_enquiries_amounts_check CHECK (items_total >= 0 AND (delivery_charge IS NULL OR delivery_charge >= 0)),
  CONSTRAINT shop_enquiries_text_check CHECK (length(customer_name) BETWEEN 1 AND 120 AND length(address) BETWEEN 1 AND 500
                                              AND length(note) <= 500 AND length(admin_note) <= 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_enquiries_branch_idempotency_key ON public.shop_enquiries (branch_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS shop_enquiries_branch_created_idx ON public.shop_enquiries (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS shop_enquiries_created_idx ON public.shop_enquiries (created_at DESC);

-- the lines, as a SNAPSHOT (name, size, unit price, quantity): later price changes or a deleted product never alter a request
CREATE TABLE IF NOT EXISTS public.shop_enquiry_items (
  id           bigserial     PRIMARY KEY,
  branch_id    text          NOT NULL REFERENCES public.branches(id),
  enquiry_id   uuid          NOT NULL,
  product_id   bigint,
  variant_id   uuid,
  name         text          NOT NULL,
  variant_name text,
  unit_price   numeric(12,2) NOT NULL,
  quantity     integer       NOT NULL,
  line_total   numeric(12,2) NOT NULL,
  CONSTRAINT shop_enquiry_items_qty_check CHECK (quantity BETWEEN 1 AND 99),
  CONSTRAINT shop_enquiry_items_amount_check CHECK (unit_price >= 0 AND line_total >= 0),
  CONSTRAINT shop_enquiry_items_enquiry_fk FOREIGN KEY (enquiry_id, branch_id) REFERENCES public.shop_enquiries (id, branch_id) ON DELETE CASCADE,
  CONSTRAINT shop_enquiry_items_product_fk FOREIGN KEY (product_id, branch_id) REFERENCES public.products (id, branch_id) ON DELETE SET NULL (product_id),
  CONSTRAINT shop_enquiry_items_variant_fk FOREIGN KEY (variant_id, branch_id) REFERENCES public.product_variants (id, branch_id) ON DELETE SET NULL (variant_id)
);
CREATE INDEX IF NOT EXISTS shop_enquiry_items_enquiry_idx ON public.shop_enquiry_items (branch_id, enquiry_id);

CREATE TABLE IF NOT EXISTS public.shop_enquiry_status_history (
  id              bigserial   PRIMARY KEY,
  branch_id       text        NOT NULL REFERENCES public.branches(id),
  enquiry_id      uuid        NOT NULL,
  old_status      text,
  new_status      text        NOT NULL,
  changed_at      timestamptz NOT NULL DEFAULT now(),
  changed_by_role text        NOT NULL,
  CONSTRAINT shop_enquiry_status_history_enquiry_fk FOREIGN KEY (enquiry_id, branch_id) REFERENCES public.shop_enquiries (id, branch_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS shop_enquiry_status_history_idx ON public.shop_enquiry_status_history (branch_id, enquiry_id, changed_at);

-- ============================================================ the public catalogue: price and "in stock" only
-- online price = products.online_price, else the size's own price (a product with sizes), else offer price, else price
CREATE OR REPLACE FUNCTION public.shop_unit_price(p_product public.products, p_variant public.product_variants)
 RETURNS numeric LANGUAGE sql IMMUTABLE
AS $function$
  SELECT ROUND(COALESCE(p_product.online_price,
                        CASE WHEN p_variant.id IS NOT NULL THEN p_variant.price END,
                        NULLIF(p_product.offer_price, 0), p_product.price), 2)
$function$;

-- ============================================================ create a request: validates, re-prices from the catalogue, inserts atomically
-- p_items: [{"product_id": 12, "variant_id": null, "quantity": 2}, ...]. Client prices, names and totals are never read.
CREATE OR REPLACE FUNCTION public.create_shop_enquiry(
  p_branch text, p_customer_name text, p_phone text, p_address text, p_note text, p_items jsonb, p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_branch   public.branches;
  v_phone    text := public.canonical_phone(p_phone);
  v_existing public.shop_enquiries;
  v_req      record;
  v_p        public.products;
  v_v        public.product_variants;
  v_price    numeric;
  v_stock    numeric;
  v_total    numeric := 0;
  v_lines    jsonb := '[]'::jsonb;
  v_n        integer;
  v_no       text;
  v_id       uuid;
  v_name     text := BTRIM(regexp_replace(COALESCE(p_customer_name, ''), '[[:cntrl:]]', ' ', 'g'));
  v_address  text := BTRIM(regexp_replace(COALESCE(p_address, ''), '[[:cntrl:]]', ' ', 'g'));
  v_note     text := BTRIM(regexp_replace(COALESCE(p_note, ''), '[[:cntrl:]]', ' ', 'g'));
BEGIN
  SELECT * INTO v_branch FROM public.branches WHERE id = p_branch AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'This shop is not available'; END IF;

  -- double tap / retry: the same key returns the FIRST request
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.shop_enquiries WHERE branch_id = v_branch.id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN public.shop_enquiry_json(v_existing.id, v_branch.id) || jsonb_build_object('replayed', true); END IF;
  END IF;

  IF v_name = '' THEN RAISE EXCEPTION 'Please enter your name'; END IF;
  IF v_phone IS NULL THEN RAISE EXCEPTION 'Please enter a valid 10-digit mobile number'; END IF;
  IF v_address = '' THEN RAISE EXCEPTION 'Please enter the delivery address'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'Your cart is empty'; END IF;
  IF jsonb_array_length(p_items) > 30 THEN RAISE EXCEPTION 'Too many different items in one request (max 30)'; END IF;

  -- the same product + size twice is one line
  FOR v_req IN
    SELECT (e->>'product_id')::bigint AS pid, NULLIF(e->>'variant_id', '')::uuid AS vid, SUM((e->>'quantity')::integer) AS q
      FROM jsonb_array_elements(p_items) e GROUP BY 1, 2 ORDER BY 1, 2
  LOOP
    IF v_req.q IS NULL OR v_req.q < 1 OR v_req.q > 99 THEN RAISE EXCEPTION 'Quantity must be between 1 and 99'; END IF;
    SELECT * INTO v_p FROM public.products WHERE id = v_req.pid AND branch_id = v_branch.id AND is_active AND show_online;
    IF NOT FOUND THEN RAISE EXCEPTION 'An item in your cart is no longer available. Please remove it and try again.'; END IF;
    v_v := NULL;
    IF v_p.has_variants OR v_req.vid IS NOT NULL THEN
      IF v_req.vid IS NULL THEN RAISE EXCEPTION 'Please choose a size for %', v_p.name; END IF;
      SELECT * INTO v_v FROM public.product_variants WHERE id = v_req.vid AND product_id = v_p.id AND branch_id = v_branch.id AND is_active;
      IF NOT FOUND THEN RAISE EXCEPTION 'The chosen size of % is no longer available', v_p.name; END IF;
      v_stock := v_v.stock;
    ELSE
      v_stock := v_p.stock_quantity;
    END IF;
    IF v_stock <= 0 THEN RAISE EXCEPTION '% is out of stock', v_p.name || COALESCE(' (' || v_v.variant_name || ')', ''); END IF;
    IF v_req.q > v_stock THEN RAISE EXCEPTION 'Not enough stock of % for that quantity. Please choose fewer.', v_p.name || COALESCE(' (' || v_v.variant_name || ')', ''); END IF;
    v_price := public.shop_unit_price(v_p, v_v);
    v_lines := v_lines || jsonb_build_object('product_id', v_p.id, 'variant_id', v_v.id, 'name', v_p.name, 'variant_name', v_v.variant_name,
                                             'unit_price', v_price, 'quantity', v_req.q, 'line_total', ROUND(v_price * v_req.q, 2));
    v_total := v_total + ROUND(v_price * v_req.q, 2);
  END LOOP;

  INSERT INTO public.shop_enquiry_counters (branch_id, last_no) VALUES (v_branch.id, 1)
    ON CONFLICT (branch_id) DO UPDATE SET last_no = public.shop_enquiry_counters.last_no + 1
    RETURNING last_no INTO v_n;
  v_no := 'ENQ-' || upper(v_branch.id) || '-' || LPAD(v_n::text, 6, '0');
  INSERT INTO public.shop_enquiries (branch_id, enquiry_no, customer_name, phone, address, note, status, items_total, idempotency_key)
    VALUES (v_branch.id, v_no, LEFT(v_name, 120), v_phone, LEFT(v_address, 500), LEFT(v_note, 500), 'new', v_total, p_idempotency_key)
    RETURNING id INTO v_id;
  INSERT INTO public.shop_enquiry_items (branch_id, enquiry_id, product_id, variant_id, name, variant_name, unit_price, quantity, line_total)
    SELECT v_branch.id, v_id, (l->>'product_id')::bigint, NULLIF(l->>'variant_id', '')::uuid, l->>'name', l->>'variant_name',
           (l->>'unit_price')::numeric, (l->>'quantity')::integer, (l->>'line_total')::numeric
      FROM jsonb_array_elements(v_lines) l;
  INSERT INTO public.shop_enquiry_status_history (branch_id, enquiry_id, old_status, new_status, changed_by_role)
    VALUES (v_branch.id, v_id, NULL, 'new', 'customer');
  RETURN public.shop_enquiry_json(v_id, v_branch.id);
END;
$function$;

-- what the confirmation screen needs, nothing more (no phone, no address, no internal ids beyond the request number)
CREATE OR REPLACE FUNCTION public.shop_enquiry_json(p_id uuid, p_branch text)
 RETURNS jsonb LANGUAGE sql STABLE
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'enquiry_no', e.enquiry_no, 'created_at', e.created_at, 'branch', b.short_label, 'customer_name', e.customer_name,
    'items_total', e.items_total,
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', i.name, 'variant_name', i.variant_name, 'quantity', i.quantity,
                                                           'unit_price', i.unit_price, 'line_total', i.line_total) ORDER BY i.id)
                         FROM public.shop_enquiry_items i WHERE i.enquiry_id = e.id AND i.branch_id = e.branch_id), '[]'::jsonb))
  FROM public.shop_enquiries e JOIN public.branches b ON b.id = e.branch_id
  WHERE e.id = p_id AND e.branch_id = p_branch
$function$;

-- ============================================================ status change (Admin): writes the history in the same statement
CREATE OR REPLACE FUNCTION public.set_shop_enquiry_status(p_id uuid, p_branch text, p_status text, p_role text)
 RETURNS text LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_old text;
BEGIN
  SELECT status INTO v_old FROM public.shop_enquiries WHERE id = p_id AND branch_id = p_branch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_old = p_status THEN RETURN p_status; END IF;
  UPDATE public.shop_enquiries SET status = p_status, updated_at = now() WHERE id = p_id AND branch_id = p_branch;
  INSERT INTO public.shop_enquiry_status_history (branch_id, enquiry_id, old_status, new_status, changed_by_role)
    VALUES (p_branch, p_id, v_old, p_status, COALESCE(NULLIF(p_role, ''), 'unknown'));
  RETURN p_status;
END;
$function$;

CREATE OR REPLACE FUNCTION public.register_branch(
  p_id text, p_name text, p_short_label text,
  p_invoice_block integer DEFAULT NULL,           -- 1..9 = numbers N*10,000,000+1 .. (N+1)*10,000,000-1; NULL = first free block
  p_theme_color text DEFAULT '#0A0A0A', p_logo_url text DEFAULT '/branch-placeholder.svg',
  p_subtitle text DEFAULT '', p_sort_order integer DEFAULT 0,
  p_barcode_prefix text DEFAULT NULL              -- 2 chars, e.g. 'P4'; NULL = first free 'P2'..'P9'
) RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_block integer := p_invoice_block;
  v_start bigint;
  v_end   bigint;
  v_prefix text := upper(btrim(p_barcode_prefix));
BEGIN
  IF EXISTS (SELECT 1 FROM public.branches WHERE id = p_id) THEN
    RETURN p_id;
  END IF;

  IF v_block IS NULL THEN
    SELECT n INTO v_block FROM generate_series(1, 9) AS n
    WHERE NOT EXISTS (
      SELECT 1 FROM public.branches b
      WHERE int8range(b.invoice_start, b.invoice_end, '[]') && int8range(n * 10000000 + 1, (n + 1) * 10000000 - 1, '[]')
    ) ORDER BY n LIMIT 1;
    IF v_block IS NULL THEN
      RAISE EXCEPTION 'No free invoice number block left (8-digit invoice numbers allow at most 9 branches)';
    END IF;
  END IF;
  IF v_block NOT BETWEEN 1 AND 9 THEN
    RAISE EXCEPTION 'invoice block must be between 1 and 9';
  END IF;
  IF v_prefix IS NULL OR v_prefix = '' THEN
    SELECT 'P' || n INTO v_prefix FROM generate_series(2, 9) AS n
    WHERE NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.barcode_prefix = 'P' || n) ORDER BY n LIMIT 1;
    IF v_prefix IS NULL THEN
      RAISE EXCEPTION 'No free barcode prefix left; pass p_barcode_prefix explicitly';
    END IF;
  END IF;
  v_start := v_block::bigint * 10000000 + 1;
  v_end   := (v_block::bigint + 1) * 10000000 - 1;

  -- the exclusion constraint on branches rejects an overlapping explicit block
  INSERT INTO public.branches (id, name, short_label, subtitle, theme_color, logo_url, invoice_start, invoice_end, sort_order, barcode_prefix)
  VALUES (p_id, p_name, p_short_label, p_subtitle, p_theme_color, p_logo_url, v_start, v_end, p_sort_order, v_prefix);

  -- bounded, non-cycling sequence: running past the block raises instead of entering another branch's range
  EXECUTE format('CREATE SEQUENCE public.%I START %s MINVALUE %s MAXVALUE %s NO CYCLE',
                 'invoice_number_seq_' || p_id, v_start, v_start, v_end);

  -- independent barcode numbering per branch (8 digits: PBP10000001 .. PBP99999999, never cycles)
  EXECUTE format('CREATE SEQUENCE public.%I START 10000001 MINVALUE 10000001 MAXVALUE 99999999 NO CYCLE', 'barcode_product_seq_' || p_id);
  EXECUTE format('CREATE SEQUENCE public.%I START 10000001 MINVALUE 10000001 MAXVALUE 99999999 NO CYCLE', 'barcode_variant_seq_' || p_id);

  INSERT INTO public.store_settings (branch_id, theme_color) VALUES (p_id, p_theme_color);

  INSERT INTO public.expense_categories (name, branch_id)
  SELECT n, p_id FROM unnest(ARRAY['Maintenance','Marketing','Other','Rent','Salaries','Supplies']) AS n;

  -- 0016: the online-shop request counter of the new branch (ENQ-<BRANCH>-000001 ...)
  INSERT INTO public.shop_enquiry_counters (branch_id, last_no) VALUES (p_id, 0) ON CONFLICT (branch_id) DO NOTHING;

  RETURN p_id;
END;
$function$;

COMMIT;
