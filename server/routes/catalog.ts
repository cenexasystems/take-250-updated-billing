import { z } from 'zod'
import { route } from '../lib/route.js'
import { insertRow, updateRow } from '../lib/sql.js'
import { notFound } from '../lib/errors.js'

const money = z.number().finite().min(0)
const idParam = z.coerce.number().int().positive()

const productFields = {
  name: z.string().trim().min(1).max(200),
  name_ta: z.string().max(200),
  tamil_name: z.string().max(200),
  category: z.string().max(200),
  category_id: z.number().int().positive().nullable(),
  remedy: z.array(z.string().max(200)).max(50),
  price: money,
  offer_price: money.nullable(),
  purchase_price: money,
  mrp: money,
  gst_percent: z.number().min(0).max(100),
  unit_type: z.enum(['unit', 'weight', 'volume', 'bundle']),
  unit_label: z.string().max(50),
  unit: z.string().max(50),
  base_quantity: z.number().positive(),
  stock_quantity: money,
  opening_stock: money,
  stock: z.number().int().min(0),
  stock_unit: z.string().max(50),
  low_stock_alert: money,
  allow_decimal_quantity: z.boolean(),
  predefined_options: z.array(z.unknown()).max(100),
  description: z.string().max(5000),
  description_ta: z.string().max(5000),
  benefits: z.string().max(5000),
  benefits_ta: z.string().max(5000),
  image: z.string().max(2000).nullable(),
  image_url: z.string().max(2000).nullable(),
  sku: z.string().max(100).nullable(),
  barcode: z.string().max(100).nullable(),
  brand: z.string().max(200).nullable(),
  supplier: z.string().max(200).nullable(),
  size: z.string().max(100).nullable(),
  color: z.string().max(100).nullable(),
  rating: z.number().min(0).max(5),
  has_variants: z.boolean(),
  is_active: z.boolean(),
  sort_order: z.number().int(),
}
const PRODUCT_JSON = ['predefined_options'] as const
const productCreate = z.object(productFields).partial().required({ name: true }).strict()
const productUpdate = z.object(productFields).partial().strict()

const variantFields = {
  variant_name: z.string().trim().min(1).max(200),
  size_label: z.string().max(100).nullable(),
  weight_value: money.nullable(),
  weight_unit: z.string().max(20).nullable(),
  sku: z.string().max(100).nullable(),
  barcode: z.string().max(100).nullable(),
  purchase_price: money.nullable(),
  mrp: money.nullable(),
  price: money,
  stock: money,
  is_default: z.boolean(),
  is_active: z.boolean(),
  sort_order: z.number().int(),
  image_url: z.string().max(2000).nullable(),
  group_name: z.string().max(200).nullable(),
}
const variantCreate = z.object({ product_id: z.number().int().positive(), ...variantFields }).partial().required({ product_id: true, variant_name: true, price: true }).strict()
const variantUpdate = z.object(variantFields).partial().strict()

const categoryFields = {
  name_en: z.string().trim().min(1).max(200),
  name_ta: z.string().max(200),
  is_active: z.boolean(),
  sort_order: z.number().int(),
}

export const catalogRoutes = [
  // ---- categories ----
  route({
    method: 'get', path: '/api/categories', perm: 'categories.read',
    query: z.object({ with_counts: z.enum(['1', 'true']).optional(), active_only: z.enum(['1', 'true']).optional() }).strict(),
    async handler({ db, branch, query }) {
      const r = await db.query(
        `SELECT c.id, c.name_en, c.name_ta, c.is_active, c.sort_order, c.created_at, c.updated_at,
                (SELECT count(*)::int FROM public.products p WHERE p.category_id = c.id AND p.branch_id = c.branch_id) AS product_count
         FROM public.categories c WHERE c.branch_id = $1 AND ($2::boolean IS NOT TRUE OR c.is_active)
         ORDER BY c.sort_order, c.id`, [branch, !!query.active_only])
      return { categories: r.rows }
    },
  }),
  route({
    method: 'post', path: '/api/categories', perm: 'categories.create', status: 201,
    body: z.object(categoryFields).partial().required({ name_en: true }).strict(),
    async handler({ db, branch, body }) {
      // same name in the same branch returns the existing category (what the product forms did: look up, else insert)
      const found = await db.query(`SELECT * FROM public.categories WHERE branch_id = $1 AND lower(btrim(name_en)) = lower(btrim($2))`, [branch, body.name_en])
      if (found.rows[0]) return { category: found.rows[0], existing: true }
      return { category: await insertRow(db, 'categories', branch!, body) }
    },
  }),
  route({
    method: 'patch', path: '/api/categories/:id', perm: 'categories.manage',
    body: z.object(categoryFields).partial().strict(),
    async handler({ db, branch, body, params }) {
      return { category: await updateRow(db, 'categories', Number(params.id), branch!, body) }
    },
  }),
  route({
    method: 'delete', path: '/api/categories/:id', perm: 'categories.manage',
    async handler({ db, branch, params }) {
      return db.tx(async (t) => {
        const c = await t.query(`SELECT name_en FROM public.categories WHERE id = $1 AND branch_id = $2`, [Number(params.id), branch])
        if (!c.rows[0]) throw notFound()
        await t.query(`UPDATE public.products SET category = 'Uncategorized', category_id = NULL WHERE branch_id = $2 AND (category_id = $1 OR category = $3)`, [Number(params.id), branch, c.rows[0].name_en])
        await t.query(`DELETE FROM public.categories WHERE id = $1 AND branch_id = $2`, [Number(params.id), branch])
        return { ok: true }
      })
    },
  }),

  // ---- products ----
  route({
    method: 'get', path: '/api/products', perm: 'products.read',
    query: z.object({ include_inactive: z.enum(['1', 'true']).optional(), search: z.string().max(100).optional() }).strict(),
    async handler({ db, branch, query }) {
      const r = await db.query(
        `SELECT * FROM public.products WHERE branch_id = $1 AND ($2::boolean IS TRUE OR is_active)
           AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%' OR sku ILIKE '%' || $3 || '%' OR barcode ILIKE '%' || $3 || '%')
         ORDER BY sort_order, id`, [branch, !!query.include_inactive, query.search ?? null])
      return { products: r.rows }
    },
  }),
  route({
    method: 'get', path: '/api/products/:id', perm: 'products.read',
    async handler({ db, branch, params }) {
      const r = await db.query(`SELECT * FROM public.products WHERE id = $1 AND branch_id = $2`, [Number(params.id), branch])
      if (!r.rows[0]) throw notFound()
      return { product: r.rows[0] }
    },
  }),
  route({
    method: 'post', path: '/api/products', perm: 'products.write', status: 201, body: productCreate,
    async handler({ db, branch, body }) {
      return { product: await insertRow(db, 'products', branch!, body, PRODUCT_JSON) }
    },
  }),
  route({
    method: 'patch', path: '/api/products/:id', perm: 'products.write', body: productUpdate,
    async handler({ db, branch, body, params }) {
      return { product: await updateRow(db, 'products', Number(params.id), branch!, body, PRODUCT_JSON) }
    },
  }),

  // ---- variants ----
  route({
    method: 'get', path: '/api/variants', perm: 'variants.read',
    query: z.object({ product_id: idParam.optional(), include_inactive: z.enum(['1', 'true']).optional() }).strict(),
    async handler({ db, branch, query }) {
      const r = await db.query(
        `SELECT * FROM public.product_variants WHERE branch_id = $1 AND ($2::bigint IS NULL OR product_id = $2)
           AND ($3::boolean IS TRUE OR is_active) ORDER BY sort_order, created_at`, [branch, query.product_id ?? null, !!query.include_inactive])
      return { variants: r.rows }
    },
  }),
  route({
    method: 'post', path: '/api/variants', perm: 'variants.write', status: 201, body: variantCreate,
    async handler({ db, branch, body }) {
      return { variant: await insertRow(db, 'product_variants', branch!, body) }
    },
  }),
  route({
    method: 'patch', path: '/api/variants/:id', perm: 'variants.write', body: variantUpdate,
    async handler({ db, branch, body, params }) {
      return { variant: await updateRow(db, 'product_variants', params.id, branch!, body) }
    },
  }),
  route({
    method: 'post', path: '/api/variants/:id/default', perm: 'variants.write',
    async handler({ db, branch, params }) {
      return db.tx(async (t) => {
        const v = await t.query(`SELECT product_id FROM public.product_variants WHERE id = $1 AND branch_id = $2`, [params.id, branch])
        if (!v.rows[0]) throw notFound()
        await t.query(`UPDATE public.product_variants SET is_default = false WHERE product_id = $1 AND branch_id = $2`, [v.rows[0].product_id, branch])
        const r = await t.query(`UPDATE public.product_variants SET is_default = true, updated_at = now() WHERE id = $1 AND branch_id = $2 RETURNING *`, [params.id, branch])
        return { variant: r.rows[0] }
      })
    },
  }),
]
