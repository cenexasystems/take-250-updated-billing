-- 0002: core schema. Generated from the final state of the legacy Supabase migration chain
-- with Supabase auth / RLS / storage / realtime removed and the branch text column replaced
-- by a branch_id foreign key to public.branches.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS public.store_settings_id_seq START 1 INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS public.categories_id_seq START 1 INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS public.coupons_id_seq START 1 INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS public.deposit_number_seq START 1 INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS public.expense_categories_id_seq START 1 INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS public.inventory_movements_id_seq START 1 INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS public.order_items_id_seq START 1 INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS public.products_id_seq START 1 INCREMENT 1;

CREATE TABLE public.advance_order_payments (
  branch_id text NOT NULL REFERENCES public.branches(id),
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  advance_order_id uuid NOT NULL,
  payment_type text NOT NULL,
  amount numeric(12,2) NOT NULL,
  payment_method text NOT NULL,
  remarks text DEFAULT ''::text NOT NULL,
  received_by uuid,
  received_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT advance_order_payments_amount_check CHECK ((amount >= (0)::numeric)),
  CONSTRAINT advance_order_payments_payment_method_check CHECK ((payment_method = ANY (ARRAY['cash'::text, 'upi'::text, 'card'::text]))),
  CONSTRAINT advance_order_payments_payment_type_check CHECK ((payment_type = ANY (ARRAY['deposit'::text, 'remaining'::text]))),
  CONSTRAINT advance_order_payments_pkey PRIMARY KEY (id),
  CONSTRAINT advance_order_payments_advance_order_id_payment_type_key UNIQUE (branch_id, advance_order_id, payment_type)
);

CREATE TABLE public.advance_order_timeline (
  branch_id text NOT NULL REFERENCES public.branches(id),
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  advance_order_id uuid NOT NULL,
  event_type text NOT NULL,
  label text NOT NULL,
  remarks text DEFAULT ''::text NOT NULL,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT advance_order_timeline_pkey PRIMARY KEY (id)
);

CREATE TABLE public.advance_orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  deposit_id text NOT NULL,
  customer_name text NOT NULL,
  phone text NOT NULL,
  address text DEFAULT '#189, N.S.C. Bose Road, (Opp. Bus Depot, Hotel Sankar Cafe Building), Chennai - 600 001'::text NOT NULL,
  product_name text NOT NULL,
  products jsonb DEFAULT '[]'::jsonb NOT NULL,
  category text DEFAULT ''::text NOT NULL,
  description text DEFAULT ''::text NOT NULL,
  total_amount numeric(12,2) NOT NULL,
  deposit_amount numeric(12,2) NOT NULL,
  remaining_balance numeric(12,2) GENERATED ALWAYS AS (total_amount - deposit_amount) STORED,
  expected_delivery_date date NOT NULL,
  status text DEFAULT 'pending_deposit'::text NOT NULL,
  remarks text DEFAULT ''::text NOT NULL,
  created_by uuid,
  created_by_name text DEFAULT ''::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone,
  completed_order_id uuid,
  invoice_number text,
  final_payment_method text,
  branch_id text NOT NULL REFERENCES public.branches(id),
  CONSTRAINT advance_deposit_less_than_total CHECK ((deposit_amount < total_amount)),
  CONSTRAINT advance_orders_deposit_amount_check CHECK ((deposit_amount > (0)::numeric)),
  CONSTRAINT advance_orders_status_check CHECK ((status = ANY (ARRAY['pending_deposit'::text, 'ready_for_delivery'::text, 'waiting_final_payment'::text, 'completed'::text, 'cancelled'::text]))),
  CONSTRAINT advance_orders_total_amount_check CHECK ((total_amount > (0)::numeric)),
  CONSTRAINT advance_orders_pkey PRIMARY KEY (id),
  CONSTRAINT advance_orders_completed_order_id_key UNIQUE (branch_id, completed_order_id),
  CONSTRAINT advance_orders_deposit_id_key UNIQUE (branch_id, deposit_id),
  CONSTRAINT advance_orders_invoice_number_key UNIQUE (invoice_number),
  CONSTRAINT advance_orders_branch_invoice_number_key UNIQUE (branch_id, invoice_number)
);

CREATE TABLE public.attendance_records (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  staff_member_id uuid NOT NULL,
  branch_id text NOT NULL REFERENCES public.branches(id),
  attendance_date date DEFAULT CURRENT_DATE NOT NULL,
  clock_in timestamp with time zone,
  clock_out timestamp with time zone,
  status text DEFAULT 'present'::text NOT NULL,
  note text DEFAULT ''::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT attendance_records_status_check CHECK ((status = ANY (ARRAY['present'::text, 'absent'::text, 'half_day'::text, 'leave'::text]))),
  CONSTRAINT attendance_records_pkey PRIMARY KEY (id),
  CONSTRAINT attendance_records_staff_member_id_attendance_date_key UNIQUE (branch_id, staff_member_id, attendance_date)
);

CREATE TABLE public.barcode_registry (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  barcode_value text NOT NULL,
  entity_type text NOT NULL,
  product_id bigint NOT NULL,
  variant_id uuid,
  is_active boolean DEFAULT true NOT NULL,
  created_by_name text DEFAULT ''::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  branch_id text NOT NULL REFERENCES public.branches(id),
  CONSTRAINT barcode_registry_pkey PRIMARY KEY (id),
  CONSTRAINT barcode_registry_entity_type_check CHECK ((entity_type = ANY (ARRAY['product'::text, 'variant'::text]))),
  CONSTRAINT chk_barcode_entity_target CHECK (((entity_type = 'product'::text AND variant_id IS NULL) OR (entity_type = 'variant'::text AND variant_id IS NOT NULL)))
);

CREATE TABLE public.categories (
  id bigint DEFAULT nextval('categories_id_seq'::regclass) NOT NULL,
  name_en text NOT NULL,
  name_ta text DEFAULT ''::text NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  branch_id text NOT NULL REFERENCES public.branches(id),
  CONSTRAINT categories_pkey PRIMARY KEY (id)
);

CREATE TABLE public.coupons (
  id bigint DEFAULT nextval('coupons_id_seq'::regclass) NOT NULL,
  code text NOT NULL,
  percentage numeric(5,2) NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  expiry_date timestamp with time zone,
  usage_limit integer,
  usage_count integer DEFAULT 0 NOT NULL,
  min_order_value numeric(12,2) DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  branch_id text NOT NULL REFERENCES public.branches(id),
  CONSTRAINT coupons_percentage_check CHECK (((percentage > (0)::numeric) AND (percentage <= (100)::numeric))),
  CONSTRAINT coupons_usage_count_check CHECK ((usage_count >= 0)),
  CONSTRAINT coupons_usage_limit_check CHECK (((usage_limit IS NULL) OR (usage_limit > 0))),
  CONSTRAINT coupons_pkey PRIMARY KEY (id)
);

CREATE TABLE public.expense_categories (
  id bigint DEFAULT nextval('expense_categories_id_seq'::regclass) NOT NULL,
  name text NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  branch_id text NOT NULL REFERENCES public.branches(id),
  CONSTRAINT expense_categories_pkey PRIMARY KEY (id)
);

CREATE TABLE public.expenses (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  expense_date date DEFAULT CURRENT_DATE NOT NULL,
  category_id bigint,
  category_name text NOT NULL,
  amount numeric(12,2) NOT NULL,
  description text DEFAULT ''::text,
  payment_mode text DEFAULT 'cash'::text,
  recorded_by_name text DEFAULT 'Staff'::text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  branch_id text NOT NULL REFERENCES public.branches(id),
  CONSTRAINT expenses_amount_check CHECK ((amount > (0)::numeric)),
  CONSTRAINT expenses_pkey PRIMARY KEY (id)
);

CREATE TABLE public.inventory_movements (
  id bigint DEFAULT nextval('inventory_movements_id_seq'::regclass) NOT NULL,
  product_id bigint,
  variant_id uuid,
  movement_type text NOT NULL,
  quantity_delta numeric NOT NULL,
  quantity_before numeric NOT NULL,
  quantity_after numeric NOT NULL,
  reference_type text,
  reference_id text,
  note text DEFAULT ''::text,
  created_by_name text DEFAULT ''::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  branch_id text NOT NULL REFERENCES public.branches(id),
  barcode_id uuid,
  unit_cost numeric,
  CONSTRAINT inventory_movements_movement_type_check CHECK ((movement_type = ANY (ARRAY['INITIAL_BARCODE_STOCK'::text, 'RESTOCK'::text, 'SALE'::text, 'RETURN'::text, 'DAMAGE'::text, 'CORRECTION'::text, 'VOID'::text]))),
  CONSTRAINT inventory_movements_pkey PRIMARY KEY (id)
);

CREATE TABLE public.order_items (
  branch_id text NOT NULL REFERENCES public.branches(id),
  id bigint DEFAULT nextval('order_items_id_seq'::regclass) NOT NULL,
  order_id uuid NOT NULL,
  product_id bigint,
  variant_id uuid,
  product_name text DEFAULT 'Product'::text NOT NULL,
  name text DEFAULT 'Product'::text NOT NULL,
  product_tamil_name text,
  tamil_name text,
  quantity numeric(12,3) DEFAULT 0 NOT NULL,
  unit text DEFAULT 'piece'::text NOT NULL,
  unit_type text DEFAULT 'unit'::text NOT NULL,
  base_quantity numeric(12,3) DEFAULT 1 NOT NULL,
  base_price numeric(12,2) DEFAULT 0 NOT NULL,
  line_total numeric(12,2) DEFAULT 0 NOT NULL,
  image_url text,
  is_manual boolean DEFAULT false NOT NULL,
  discount numeric(12,2) DEFAULT 0 NOT NULL,
  gst_amount numeric(12,2) DEFAULT 0 NOT NULL,
  gst_rate numeric(5,2) DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  variant_name text,
  unit_price numeric(12,2) DEFAULT 0 NOT NULL,
  source text DEFAULT 'catalogue'::text NOT NULL,
  note text,
  category text,
  CONSTRAINT order_items_pkey PRIMARY KEY (id)
);

CREATE TABLE public.orders (
  coupon_id bigint,
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  invoice_no text NOT NULL,
  user_id uuid,
  customer_name text DEFAULT 'Customer'::text NOT NULL,
  phone text DEFAULT '+91 98844 10700, +91 97878 08090'::text NOT NULL,
  address text DEFAULT ''::text NOT NULL,
  items jsonb DEFAULT '[]'::jsonb NOT NULL,
  subtotal numeric(12,2) DEFAULT 0 NOT NULL,
  shipping numeric(12,2) DEFAULT 0 NOT NULL,
  total numeric(12,2) DEFAULT 0 NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  order_mode text DEFAULT 'offline'::text NOT NULL,
  order_type text DEFAULT 'pos_sale'::text NOT NULL,
  delivery_charge numeric(12,2) DEFAULT 0 NOT NULL,
  discount_amount numeric(12,2) DEFAULT 0 NOT NULL,
  manual_discount_amount numeric(12,2) DEFAULT 0 NOT NULL,
  manual_discount_type text DEFAULT 'flat'::text NOT NULL,
  manual_discount_value numeric(12,2) DEFAULT 0 NOT NULL,
  coupon_code text,
  coupon_percentage numeric(5,2) DEFAULT 0 NOT NULL,
  total_gst numeric(12,2) DEFAULT 0 NOT NULL,
  gst_amount numeric(12,2) DEFAULT 0 NOT NULL,
  gst_enabled boolean DEFAULT false NOT NULL,
  payment_method text DEFAULT 'cash'::text NOT NULL,
  payment_mode text DEFAULT 'cash'::text NOT NULL,
  split_details jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  remarks text DEFAULT ''::text NOT NULL,
  reference_number text DEFAULT ''::text NOT NULL,
  billing_date timestamp with time zone,
  branch_id text NOT NULL REFERENCES public.branches(id),
  CONSTRAINT orders_pkey PRIMARY KEY (id),
  CONSTRAINT orders_invoice_no_key UNIQUE (invoice_no),
  CONSTRAINT orders_branch_invoice_no_key UNIQUE (branch_id, invoice_no)
);

CREATE TABLE public.product_variants (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  product_id bigint NOT NULL,
  variant_name text NOT NULL,
  size_label text,
  weight_value numeric(12,3),
  weight_unit text,
  sku text,
  barcode text,
  purchase_price numeric(12,2),
  mrp numeric(12,2),
  price numeric(12,2) DEFAULT 0 NOT NULL,
  stock numeric(12,3) DEFAULT 0 NOT NULL,
  is_default boolean DEFAULT false NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  image_url text,
  group_name text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  branch_id text NOT NULL REFERENCES public.branches(id),
  CONSTRAINT product_variants_pkey PRIMARY KEY (id)
);

CREATE TABLE public.products (
  id bigint DEFAULT nextval('products_id_seq'::regclass) NOT NULL,
  name text NOT NULL,
  name_ta text DEFAULT ''::text NOT NULL,
  tamil_name text DEFAULT ''::text NOT NULL,
  category text DEFAULT ''::text NOT NULL,
  category_id bigint,
  remedy text[] DEFAULT '{}'::text[] NOT NULL,
  price numeric(12,2) DEFAULT 0 NOT NULL,
  offer_price numeric(12,2),
  purchase_price numeric(12,2) DEFAULT 0 NOT NULL,
  mrp numeric(12,2) DEFAULT 0 NOT NULL,
  gst_percent numeric(5,2) DEFAULT 0 NOT NULL,
  unit_type text DEFAULT 'unit'::text NOT NULL,
  unit_label text DEFAULT 'piece'::text NOT NULL,
  unit text DEFAULT 'piece'::text NOT NULL,
  base_quantity numeric(12,3) DEFAULT 1 NOT NULL,
  stock_quantity numeric(12,3) DEFAULT 0 NOT NULL,
  opening_stock numeric(12,3) DEFAULT 0 NOT NULL,
  stock integer DEFAULT 0 NOT NULL,
  stock_unit text DEFAULT 'piece'::text NOT NULL,
  low_stock_alert numeric(12,3) DEFAULT 5 NOT NULL,
  allow_decimal_quantity boolean DEFAULT false NOT NULL,
  predefined_options jsonb DEFAULT '[]'::jsonb NOT NULL,
  description text DEFAULT ''::text NOT NULL,
  description_ta text DEFAULT ''::text NOT NULL,
  benefits text DEFAULT ''::text NOT NULL,
  benefits_ta text DEFAULT ''::text NOT NULL,
  image text,
  image_url text,
  sku text,
  barcode text,
  brand text,
  supplier text,
  size text,
  color text,
  rating numeric(3,1) DEFAULT 5 NOT NULL,
  has_variants boolean DEFAULT false NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  branch_id text NOT NULL REFERENCES public.branches(id),
  CONSTRAINT products_unit_type_check CHECK ((unit_type = ANY (ARRAY['unit'::text, 'weight'::text, 'volume'::text, 'bundle'::text]))),
  CONSTRAINT products_pkey PRIMARY KEY (id)
);

CREATE TABLE public.staff_members (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  branch_id text NOT NULL REFERENCES public.branches(id),
  name text NOT NULL,
  role text DEFAULT 'staff'::text NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT staff_members_pkey PRIMARY KEY (id)
);

CREATE TABLE public.store_settings (
  id smallint DEFAULT nextval('store_settings_id_seq'::regclass) NOT NULL,
  name text DEFAULT 'YG ENTERPRISES'::text NOT NULL,
  owner_name text DEFAULT ''::text NOT NULL,
  phone text DEFAULT '+60 11-3312 7107'::text NOT NULL,
  email text DEFAULT 'ygenterprises2000@gmail.com'::text NOT NULL,
  address text DEFAULT 'FR-02-05A TAMARIND SUITE, Persiaran Multimedia, CYBER 10, 63000 Cyberjaya, Selangor'::text NOT NULL,
  gst_enabled boolean DEFAULT false NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  branch_id text NOT NULL REFERENCES public.branches(id),
  business_type text DEFAULT ''::text NOT NULL,
  instagram_id text DEFAULT ''::text NOT NULL,
  logo_url text,
  theme_color text DEFAULT '#0A0A0A'::text NOT NULL,
  website_url text DEFAULT 'https://ygenterprises.co.in'::text NOT NULL,
  CONSTRAINT store_settings_pkey PRIMARY KEY (id)
);

-- Parent keys that include branch_id so children can reference them with a composite key.
-- (id alone is already unique; these exist only to make cross-branch references impossible.)
ALTER TABLE public.advance_orders ADD CONSTRAINT advance_orders_id_branch_key UNIQUE (id, branch_id);
ALTER TABLE public.barcode_registry ADD CONSTRAINT barcode_registry_id_branch_key UNIQUE (id, branch_id);
ALTER TABLE public.categories ADD CONSTRAINT categories_id_branch_key UNIQUE (id, branch_id);
ALTER TABLE public.coupons ADD CONSTRAINT coupons_id_branch_key UNIQUE (id, branch_id);
ALTER TABLE public.expense_categories ADD CONSTRAINT expense_categories_id_branch_key UNIQUE (id, branch_id);
ALTER TABLE public.orders ADD CONSTRAINT orders_id_branch_key UNIQUE (id, branch_id);
ALTER TABLE public.product_variants ADD CONSTRAINT product_variants_id_branch_key UNIQUE (id, branch_id);
ALTER TABLE public.products ADD CONSTRAINT products_id_branch_key UNIQUE (id, branch_id);
ALTER TABLE public.staff_members ADD CONSTRAINT staff_members_id_branch_key UNIQUE (id, branch_id);

-- Composite foreign keys: a child row can only point at a parent in the SAME branch.
-- ON DELETE SET NULL (col) nulls only the reference, never the child's branch_id.
ALTER TABLE public.products ADD CONSTRAINT products_category_fk FOREIGN KEY (category_id, branch_id) REFERENCES public.categories (id, branch_id) ON DELETE SET NULL (category_id);
ALTER TABLE public.product_variants ADD CONSTRAINT product_variants_product_fk FOREIGN KEY (product_id, branch_id) REFERENCES public.products (id, branch_id) ON DELETE CASCADE;
ALTER TABLE public.order_items ADD CONSTRAINT order_items_order_fk FOREIGN KEY (order_id, branch_id) REFERENCES public.orders (id, branch_id) ON DELETE CASCADE;
ALTER TABLE public.order_items ADD CONSTRAINT order_items_product_fk FOREIGN KEY (product_id, branch_id) REFERENCES public.products (id, branch_id) ON DELETE SET NULL (product_id);
ALTER TABLE public.order_items ADD CONSTRAINT order_items_variant_fk FOREIGN KEY (variant_id, branch_id) REFERENCES public.product_variants (id, branch_id) ON DELETE SET NULL (variant_id);
ALTER TABLE public.orders ADD CONSTRAINT orders_coupon_fk FOREIGN KEY (coupon_id, branch_id) REFERENCES public.coupons (id, branch_id) ON DELETE SET NULL (coupon_id);
ALTER TABLE public.advance_orders ADD CONSTRAINT advance_orders_completed_order_fk FOREIGN KEY (completed_order_id, branch_id) REFERENCES public.orders (id, branch_id) ON DELETE SET NULL (completed_order_id);
ALTER TABLE public.advance_order_timeline ADD CONSTRAINT advance_order_timeline_order_fk FOREIGN KEY (advance_order_id, branch_id) REFERENCES public.advance_orders (id, branch_id) ON DELETE CASCADE;
ALTER TABLE public.advance_order_payments ADD CONSTRAINT advance_order_payments_order_fk FOREIGN KEY (advance_order_id, branch_id) REFERENCES public.advance_orders (id, branch_id) ON DELETE CASCADE;
ALTER TABLE public.attendance_records ADD CONSTRAINT attendance_records_staff_fk FOREIGN KEY (staff_member_id, branch_id) REFERENCES public.staff_members (id, branch_id) ON DELETE CASCADE;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_category_fk FOREIGN KEY (category_id, branch_id) REFERENCES public.expense_categories (id, branch_id) ON DELETE SET NULL (category_id);
ALTER TABLE public.inventory_movements ADD CONSTRAINT inventory_movements_product_fk FOREIGN KEY (product_id, branch_id) REFERENCES public.products (id, branch_id) ON DELETE SET NULL (product_id);
ALTER TABLE public.inventory_movements ADD CONSTRAINT inventory_movements_variant_fk FOREIGN KEY (variant_id, branch_id) REFERENCES public.product_variants (id, branch_id) ON DELETE SET NULL (variant_id);
-- Barcodes: a barcode can only point at a product / variant of its OWN branch. RESTRICT as in the original
-- app (delete_inventory_item removes the registry rows first); a movement keeps its row if its barcode goes.
ALTER TABLE public.barcode_registry ADD CONSTRAINT barcode_registry_product_fk FOREIGN KEY (product_id, branch_id) REFERENCES public.products (id, branch_id) ON DELETE RESTRICT;
ALTER TABLE public.barcode_registry ADD CONSTRAINT barcode_registry_variant_fk FOREIGN KEY (variant_id, branch_id) REFERENCES public.product_variants (id, branch_id) ON DELETE RESTRICT;
ALTER TABLE public.inventory_movements ADD CONSTRAINT inventory_movements_barcode_fk FOREIGN KEY (barcode_id, branch_id) REFERENCES public.barcode_registry (id, branch_id) ON DELETE SET NULL (barcode_id);

-- indexes (every branch_id column is indexed)
CREATE INDEX IF NOT EXISTS advance_order_payments_order_idx ON public.advance_order_payments USING btree (advance_order_id, received_at);
CREATE INDEX IF NOT EXISTS advance_order_timeline_order_idx ON public.advance_order_timeline USING btree (advance_order_id, created_at);
CREATE INDEX IF NOT EXISTS advance_orders_branch_idx ON public.advance_orders USING btree (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS advance_orders_created_idx ON public.advance_orders USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS advance_orders_delivery_idx ON public.advance_orders USING btree (expected_delivery_date);
CREATE INDEX IF NOT EXISTS advance_orders_status_idx ON public.advance_orders USING btree (status);
CREATE INDEX IF NOT EXISTS idx_advance_orders_created_at ON public.advance_orders USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_advance_orders_invoice_number ON public.advance_orders USING btree (invoice_number);
CREATE INDEX IF NOT EXISTS idx_advance_orders_status ON public.advance_orders USING btree (status);
CREATE INDEX IF NOT EXISTS attendance_records_branch_date_idx ON public.attendance_records USING btree (branch_id, attendance_date DESC);
CREATE INDEX IF NOT EXISTS categories_branch_idx ON public.categories USING btree (branch_id);
CREATE UNIQUE INDEX IF NOT EXISTS categories_branch_name_unique ON public.categories USING btree (branch_id, lower(btrim(name_en)));
CREATE INDEX IF NOT EXISTS coupons_branch_active_idx ON public.coupons USING btree (branch_id, is_active, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS coupons_branch_code_upper_unique ON public.coupons USING btree (branch_id, upper(btrim(code)));
CREATE INDEX IF NOT EXISTS expense_categories_branch_active_idx ON public.expense_categories USING btree (branch_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS expense_categories_branch_name_unique ON public.expense_categories USING btree (branch_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_expense_categories_active ON public.expense_categories USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_expenses_branch ON public.expenses USING btree (branch_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON public.expenses USING btree (category_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON public.expenses USING btree (expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_inv_movements_prod ON public.inventory_movements USING btree (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inv_movements_type ON public.inventory_movements USING btree (movement_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inv_movements_var ON public.inventory_movements USING btree (variant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_movements_branch_idx ON public.inventory_movements USING btree (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON public.order_items USING btree (order_id);
CREATE INDEX IF NOT EXISTS idx_orders_billing_date ON public.orders USING btree (billing_date);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_invoice_no ON public.orders USING btree (invoice_no);
CREATE INDEX IF NOT EXISTS orders_branch_idx ON public.orders USING btree (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_created_at_idx ON public.orders USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS orders_phone_idx ON public.orders USING btree (phone);
CREATE INDEX IF NOT EXISTS product_variants_branch_idx ON public.product_variants USING btree (branch_id);
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_product_name_unique ON public.product_variants USING btree (branch_id, product_id, lower(btrim(variant_name))) WHERE (is_active = true);
CREATE INDEX IF NOT EXISTS variants_product_id_idx ON public.product_variants USING btree (product_id);
CREATE INDEX IF NOT EXISTS products_active_sort_idx ON public.products USING btree (is_active, sort_order);
CREATE INDEX IF NOT EXISTS products_branch_idx ON public.products USING btree (branch_id);
CREATE INDEX IF NOT EXISTS products_category_id_idx ON public.products USING btree (category_id);
CREATE UNIQUE INDEX IF NOT EXISTS products_category_name_unique ON public.products USING btree (branch_id, category_id, lower(btrim(name))) WHERE (is_active = true);
CREATE INDEX IF NOT EXISTS staff_members_branch_idx ON public.staff_members USING btree (branch_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS store_settings_branch_unique ON public.store_settings USING btree (branch_id);
CREATE INDEX IF NOT EXISTS order_items_branch_idx ON public.order_items USING btree (branch_id, order_id);
CREATE INDEX IF NOT EXISTS advance_order_timeline_branch_idx ON public.advance_order_timeline USING btree (branch_id, advance_order_id);
CREATE INDEX IF NOT EXISTS advance_order_payments_branch_idx ON public.advance_order_payments USING btree (branch_id, advance_order_id);
CREATE INDEX IF NOT EXISTS orders_coupon_idx ON public.orders USING btree (branch_id, coupon_id) WHERE coupon_id IS NOT NULL;

-- barcode_registry: unique per branch (a manufacturer barcode may exist in several branches, as in the original app).
-- Values GENERATED by generate_barcode_value (<prefix><P|V><8 digits>) are additionally unique across all branches;
-- the branch-prefix trigger in 0003 guarantees such a value only ever belongs to its own branch.
CREATE UNIQUE INDEX IF NOT EXISTS barcode_registry_branch_value_unique ON public.barcode_registry USING btree (branch_id, barcode_value);
CREATE UNIQUE INDEX IF NOT EXISTS barcode_registry_generated_value_unique ON public.barcode_registry USING btree (barcode_value) WHERE barcode_value ~ '^[A-Z][A-Z0-9][PV][0-9]{8}$';
CREATE INDEX IF NOT EXISTS idx_barcode_registry_val ON public.barcode_registry USING btree (barcode_value);
CREATE INDEX IF NOT EXISTS idx_barcode_registry_prod ON public.barcode_registry USING btree (product_id);
CREATE INDEX IF NOT EXISTS idx_barcode_registry_var ON public.barcode_registry USING btree (variant_id) WHERE variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS barcode_registry_branch_idx ON public.barcode_registry USING btree (branch_id);
CREATE INDEX IF NOT EXISTS inventory_movements_barcode_idx ON public.inventory_movements USING btree (barcode_id) WHERE barcode_id IS NOT NULL;

COMMIT;
