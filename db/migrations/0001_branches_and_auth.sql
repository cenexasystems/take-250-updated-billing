-- 0001: branches, passcodes, login rate limiting.
-- Run order: 0001 -> 0002 -> 0003 -> 0004 (scripts/migrate.ts does this and tracks what ran).

BEGIN;

-- A branch is a row, not a hard-coded string. The id is a stable slug ('pos1', 'pos2', 'pos3')
-- so existing data/URLs keep their meaning. Branding lives here so adding a branch needs no code change.
CREATE TABLE public.branches (
  id            text PRIMARY KEY CHECK (id ~ '^[a-z0-9_]{2,32}$'),
  name          text NOT NULL UNIQUE,          -- "Branch 1"
  short_label   text NOT NULL,                 -- chip / nav label
  subtitle      text NOT NULL DEFAULT '',      -- tagline on login, headers
  theme_color   text NOT NULL DEFAULT '#8B1A1A',
  logo_url      text NOT NULL DEFAULT '/branch-placeholder.svg',
  -- Each branch owns a private block of 10,000,000 invoice numbers (8-digit format, so at most 9
  -- branches). The exclusion constraint makes two branches' ranges overlapping impossible.
  invoice_start bigint NOT NULL CHECK (invoice_start BETWEEN 1 AND 99999999),
  invoice_end   bigint NOT NULL CHECK (invoice_end BETWEEN 1 AND 99999999),
  -- Two-character barcode prefix. Generated barcodes are <prefix><P|V><8 digits> (PBP10000001), so the
  -- prefix alone tells which branch a barcode belongs to and no two branches can ever generate the same value.
  barcode_prefix text NOT NULL UNIQUE CHECK (barcode_prefix ~ '^[A-Z][A-Z0-9]$'),
  sort_order    integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT branches_invoice_range_valid CHECK (invoice_start <= invoice_end),
  CONSTRAINT branches_invoice_ranges_disjoint EXCLUDE USING gist (int8range(invoice_start, invoice_end, '[]') WITH &&)
);

-- Validates a branch id; raises for unknown/inactive branches instead of silently
-- falling back to another branch (the legacy functions coerced anything but 'pos2' to 'pos1').
CREATE OR REPLACE FUNCTION public.resolve_branch(p_branch text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  IF p_branch IS NULL OR NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND is_active) THEN
    RAISE EXCEPTION 'Unknown branch: %', COALESCE(p_branch, '<null>') USING ERRCODE = '22023';
  END IF;
  RETURN p_branch;
END;
$function$;

-- 7 rows: admin (branch_id NULL), manager x3, staff x3. Hashes only, never plain text.
CREATE TABLE public.passcodes (
  id            serial PRIMARY KEY,
  role          text NOT NULL CHECK (role IN ('admin', 'manager', 'staff')),
  branch_id     text REFERENCES public.branches(id),
  passcode_hash text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT passcodes_branch_matches_role CHECK (
    (role = 'admin' AND branch_id IS NULL) OR (role <> 'admin' AND branch_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX passcodes_role_branch_unique ON public.passcodes (role, branch_id) WHERE branch_id IS NOT NULL;
CREATE UNIQUE INDEX passcodes_single_admin ON public.passcodes (role) WHERE role = 'admin';
CREATE INDEX passcodes_branch_id_idx ON public.passcodes (branch_id);

-- DB-backed login rate limiting (works across serverless instances).
CREATE TABLE public.login_attempts (
  id           bigserial PRIMARY KEY,
  ip           text NOT NULL,
  success      boolean NOT NULL DEFAULT false,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_ip_time_idx ON public.login_attempts (ip, attempted_at DESC);

COMMIT;
