-- 0008 (2026-10-08): one barcode = exactly one item. Fixes "scanning any variant returns the FIRST variant's price".
--
-- Cause: product_variants.barcode (the column the printed labels are read from) had no uniqueness rule, so several
-- variants could carry the same text; the scan fell back to "first row found" (LIMIT 1, no ORDER BY) and returned the
-- same variant for every label. The registry could also be silently re-pointed from one variant to another.
--
-- This migration (all safe to re-run):
--   1. normalises every barcode (trimmed, UPPER CASE, empty = none);
--   2. repairs existing duplicates with public.fix_duplicate_barcodes() (keeps one owner per code, see below);
--   3. makes duplicates impossible: unique indexes + triggers that also refuse a code that belongs to a DIFFERENT item
--      in the same branch (another variant, a product, or a registry entry of another item).
-- Codes stay unique PER BRANCH only (a manufacturer barcode may exist in several branches, as before).
BEGIN;

-- ---------------------------------------------------------------- 1. normalising trigger function
CREATE OR REPLACE FUNCTION public.normalize_item_barcode()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.barcode := NULLIF(upper(btrim(NEW.barcode)), '');
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------- 2. repair of existing data (callable again at any time)
-- Rules, in this order:
--   * every barcode is trimmed and upper-cased;
--   * several ACTIVE variants of a branch with the same code: ONE keeps it (the one the registry points at, else the
--     oldest), the others lose the code and need a new one + a reprinted label (their stock is untouched);
--   * a code that is both a variant code and a product code: the product copy goes when the product has variants
--     (a product-level code on a multi-variant product cannot say which variant is being sold), else the variant copy goes;
--   * several active products with the same code: the oldest keeps it;
--   * finally the registry is made to say what the column says (the label is printed from the column).
-- Returns how many rows each step touched.
CREATE OR REPLACE FUNCTION public.fix_duplicate_barcodes()
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  n_norm int := 0; n_var int := 0; n_cross int := 0; n_prod int := 0; n_reg int := 0; k int;
BEGIN
  UPDATE public.product_variants SET barcode = NULLIF(upper(btrim(barcode)), '') WHERE barcode IS DISTINCT FROM NULLIF(upper(btrim(barcode)), '');
  GET DIAGNOSTICS k = ROW_COUNT; n_norm := n_norm + k;
  UPDATE public.products SET barcode = NULLIF(upper(btrim(barcode)), '') WHERE barcode IS DISTINCT FROM NULLIF(upper(btrim(barcode)), '');
  GET DIAGNOSTICS k = ROW_COUNT; n_norm := n_norm + k;

  -- variants sharing a code (same branch, both active): keep one
  WITH ranked AS (
    SELECT v.id,
           row_number() OVER (
             PARTITION BY v.branch_id, v.barcode
             ORDER BY (EXISTS (SELECT 1 FROM public.barcode_registry r
                               WHERE r.branch_id = v.branch_id AND r.is_active AND r.variant_id = v.id AND upper(btrim(r.barcode_value)) = v.barcode)) DESC,
                      v.created_at, v.id) AS rn
    FROM public.product_variants v
    WHERE v.barcode IS NOT NULL AND v.is_active
  )
  UPDATE public.product_variants v SET barcode = NULL, updated_at = now()
  FROM ranked WHERE v.id = ranked.id AND ranked.rn > 1;
  GET DIAGNOSTICS n_var = ROW_COUNT;

  -- a code held by a variant AND a product (same branch)
  UPDATE public.products p SET barcode = NULL, updated_at = now()
  WHERE p.barcode IS NOT NULL AND p.is_active
    AND EXISTS (SELECT 1 FROM public.product_variants v WHERE v.branch_id = p.branch_id AND v.is_active AND v.barcode = p.barcode)
    AND (p.has_variants OR EXISTS (SELECT 1 FROM public.product_variants x WHERE x.product_id = p.id AND x.branch_id = p.branch_id AND x.is_active));
  GET DIAGNOSTICS k = ROW_COUNT; n_cross := n_cross + k;
  UPDATE public.product_variants v SET barcode = NULL, updated_at = now()
  WHERE v.barcode IS NOT NULL AND v.is_active
    AND EXISTS (SELECT 1 FROM public.products p WHERE p.branch_id = v.branch_id AND p.is_active AND p.barcode = v.barcode);
  GET DIAGNOSTICS k = ROW_COUNT; n_cross := n_cross + k;

  -- products sharing a code: keep the oldest
  WITH ranked AS (
    SELECT p.id,
           row_number() OVER (
             PARTITION BY p.branch_id, p.barcode
             ORDER BY (EXISTS (SELECT 1 FROM public.barcode_registry r
                               WHERE r.branch_id = p.branch_id AND r.is_active AND r.variant_id IS NULL AND r.product_id = p.id AND upper(btrim(r.barcode_value)) = p.barcode)) DESC,
                      p.created_at, p.id) AS rn
    FROM public.products p
    WHERE p.barcode IS NOT NULL AND p.is_active
  )
  UPDATE public.products p SET barcode = NULL, updated_at = now()
  FROM ranked WHERE p.id = ranked.id AND ranked.rn > 1;
  GET DIAGNOSTICS n_prod = ROW_COUNT;

  -- the registry follows the column
  UPDATE public.barcode_registry r SET entity_type = 'variant', product_id = v.product_id, variant_id = v.id, updated_at = now()
  FROM public.product_variants v
  WHERE r.is_active AND v.is_active AND v.branch_id = r.branch_id AND v.barcode = upper(btrim(r.barcode_value)) AND r.variant_id IS DISTINCT FROM v.id;
  GET DIAGNOSTICS k = ROW_COUNT; n_reg := n_reg + k;
  UPDATE public.barcode_registry r SET entity_type = 'product', product_id = p.id, variant_id = NULL, updated_at = now()
  FROM public.products p
  WHERE r.is_active AND p.is_active AND p.branch_id = r.branch_id AND p.barcode = upper(btrim(r.barcode_value)) AND (r.variant_id IS NOT NULL OR r.product_id <> p.id);
  GET DIAGNOSTICS k = ROW_COUNT; n_reg := n_reg + k;

  RETURN jsonb_build_object('normalised', n_norm, 'variant_duplicates_cleared', n_var, 'variant_vs_product_cleared', n_cross, 'product_duplicates_cleared', n_prod, 'registry_repointed', n_reg);
END;
$function$;

SELECT public.fix_duplicate_barcodes();

-- ---------------------------------------------------------------- 3. duplicates become impossible
-- (only ACTIVE rows count: a soft-deleted variant does not hold its code for ever)
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_branch_barcode_unique
  ON public.product_variants (branch_id, barcode) WHERE barcode IS NOT NULL AND is_active;
CREATE UNIQUE INDEX IF NOT EXISTS products_branch_barcode_unique
  ON public.products (branch_id, barcode) WHERE barcode IS NOT NULL AND is_active;

-- A code may only belong to ONE item of the branch, wherever it is written: variant column, product column or registry.
CREATE OR REPLACE FUNCTION public.assert_item_barcode_free()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.barcode IS NULL OR NOT NEW.is_active THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'product_variants' THEN
    IF EXISTS (SELECT 1 FROM public.product_variants x WHERE x.branch_id = NEW.branch_id AND x.is_active AND x.barcode = NEW.barcode AND x.id <> NEW.id)
       OR EXISTS (SELECT 1 FROM public.products p WHERE p.branch_id = NEW.branch_id AND p.is_active AND p.barcode = NEW.barcode)
       OR EXISTS (SELECT 1 FROM public.barcode_registry r WHERE r.branch_id = NEW.branch_id AND r.is_active AND upper(btrim(r.barcode_value)) = NEW.barcode AND r.variant_id IS DISTINCT FROM NEW.id) THEN
      RAISE EXCEPTION 'This barcode is already used by another item in this branch.' USING ERRCODE = '23505', CONSTRAINT = 'barcode_in_use';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM public.products x WHERE x.branch_id = NEW.branch_id AND x.is_active AND x.barcode = NEW.barcode AND x.id <> NEW.id)
       OR EXISTS (SELECT 1 FROM public.product_variants v WHERE v.branch_id = NEW.branch_id AND v.is_active AND v.barcode = NEW.barcode)
       OR EXISTS (SELECT 1 FROM public.barcode_registry r WHERE r.branch_id = NEW.branch_id AND r.is_active AND upper(btrim(r.barcode_value)) = NEW.barcode
                  AND NOT (r.variant_id IS NULL AND r.product_id = NEW.id)) THEN
      RAISE EXCEPTION 'This barcode is already used by another item in this branch.' USING ERRCODE = '23505', CONSTRAINT = 'barcode_in_use';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- the registry side: a code cannot be registered to an item while the column of a DIFFERENT item holds it
CREATE OR REPLACE FUNCTION public.assert_registry_barcode_free()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_code text := upper(btrim(NEW.barcode_value));
BEGIN
  IF NOT NEW.is_active THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.product_variants v WHERE v.branch_id = NEW.branch_id AND v.is_active AND v.barcode = v_code AND v.id IS DISTINCT FROM NEW.variant_id)
     OR EXISTS (SELECT 1 FROM public.products p WHERE p.branch_id = NEW.branch_id AND p.is_active AND p.barcode = v_code
                AND NOT (NEW.variant_id IS NULL AND p.id = NEW.product_id)) THEN
    RAISE EXCEPTION 'This barcode is already used by another item in this branch.' USING ERRCODE = '23505', CONSTRAINT = 'barcode_in_use';
  END IF;
  RETURN NEW;
END;
$function$;

-- trigger names sort so the normalising one runs first
DROP TRIGGER IF EXISTS product_variants_barcode_1_norm ON public.product_variants;
CREATE TRIGGER product_variants_barcode_1_norm BEFORE INSERT OR UPDATE OF barcode ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION public.normalize_item_barcode();
DROP TRIGGER IF EXISTS product_variants_barcode_2_check ON public.product_variants;
CREATE TRIGGER product_variants_barcode_2_check BEFORE INSERT OR UPDATE OF barcode, is_active ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION public.assert_item_barcode_free();

DROP TRIGGER IF EXISTS products_barcode_1_norm ON public.products;
CREATE TRIGGER products_barcode_1_norm BEFORE INSERT OR UPDATE OF barcode ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.normalize_item_barcode();
DROP TRIGGER IF EXISTS products_barcode_2_check ON public.products;
CREATE TRIGGER products_barcode_2_check BEFORE INSERT OR UPDATE OF barcode, is_active ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.assert_item_barcode_free();

DROP TRIGGER IF EXISTS barcode_registry_free_check ON public.barcode_registry;
CREATE TRIGGER barcode_registry_free_check BEFORE INSERT OR UPDATE OF barcode_value, product_id, variant_id, is_active ON public.barcode_registry
  FOR EACH ROW EXECUTE FUNCTION public.assert_registry_barcode_free();

COMMIT;
