-- 0004: register_branch() + the three initial branches.
-- Adding a branch later needs no code change:
--   SELECT public.register_branch('pos4', 'Branch 4', 'Branch 4');   -- next free invoice block + barcode prefix + barcode sequences are allocated
-- then set its passcodes from the Admin portal.

BEGIN;

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

  RETURN p_id;
END;
$function$;

SELECT public.register_branch('pos1', 'Branch 1', 'Jute & Wedding POS', 1, '#0A0A0A', '/yg-logo-pos1.png',
  'Wedding Card, Wedding Bag and Jute Bag Manufacturing', 1, 'PB');
SELECT public.register_branch('pos2', 'Branch 2', 'Fireworks POS', 5, '#0A0A0A', '/yg-logo-pos2.png',
  'Fireworks & Crackers', 2, 'P2');
-- Branch 3: placeholder branding, edit the row (or Store Settings) to replace it.
SELECT public.register_branch('pos3', 'Branch 3', 'Branch 3', 9, '#0A0A0A', '/branch-placeholder.svg',
  'Replace this tagline', 3, 'P3');

UPDATE public.store_settings SET business_type = 'Wedding Cards, Bags & Jute Bag Manufacturing' WHERE branch_id = 'pos1';
UPDATE public.store_settings SET business_type = 'Fireworks & Crackers' WHERE branch_id = 'pos2';

COMMIT;
