import { z } from 'zod'
import type { Db } from '../lib/db.js'
import { actorName } from '../lib/auth.js'
import { notFound } from '../lib/errors.js'
import { route } from '../lib/route.js'

const REGISTRY_SELECT = `
  r.id, r.barcode_value, r.entity_type, r.product_id, r.variant_id, r.is_active, r.created_by_name, r.created_at, r.updated_at,
  json_build_object('id', p.id, 'name', p.name, 'name_ta', p.name_ta, 'price', p.price, 'offer_price', p.offer_price, 'image_url', p.image_url, 'category', p.category) AS product,
  CASE WHEN v.id IS NULL THEN NULL ELSE json_build_object('id', v.id, 'variant_name', v.variant_name, 'price', v.price, 'stock', v.stock, 'sku', v.sku) END AS variant
  FROM public.barcode_registry r
  JOIN public.products p ON p.id = r.product_id AND p.branch_id = r.branch_id
  LEFT JOIN public.product_variants v ON v.id = r.variant_id AND v.branch_id = r.branch_id`

/** Branch-scoped scan lookup (the same three steps the original app used: registry, variant barcode, product barcode).
 * Every query carries the branch, so another branch's barcode is simply "not found". */
export async function lookupBarcode(db: Db, branch: string, raw: string) {
  const code = raw.trim().toUpperCase()
  if (!code) return null
  const reg = await db.query(`SELECT ${REGISTRY_SELECT} WHERE r.branch_id = $1 AND upper(r.barcode_value) = $2 AND r.is_active LIMIT 1`, [branch, code])
  if (reg.rows[0]) return reg.rows[0]

  const v = await db.query(
    `SELECT v.id, v.product_id, v.variant_name, v.price, v.stock, v.sku,
            json_build_object('id', p.id, 'name', p.name, 'name_ta', p.name_ta, 'price', p.price, 'offer_price', p.offer_price, 'image_url', p.image_url, 'category', p.category) AS product
     FROM public.product_variants v JOIN public.products p ON p.id = v.product_id AND p.branch_id = v.branch_id
     WHERE v.branch_id = $1 AND upper(v.barcode) = $2 LIMIT 1`, [branch, code])
  if (v.rows[0]) {
    const x = v.rows[0]
    return {
      id: `var-${x.id}`, barcode_value: code, entity_type: 'variant', product_id: x.product_id, variant_id: x.id, is_active: true,
      created_by_name: 'System', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      product: x.product, variant: { id: x.id, variant_name: x.variant_name, price: x.price, stock: x.stock, sku: x.sku },
    }
  }
  const p = await db.query(
    `SELECT id, name, name_ta, price, offer_price, image_url, category, barcode, stock_quantity FROM public.products
     WHERE branch_id = $1 AND upper(barcode) = $2 LIMIT 1`, [branch, code])
  if (p.rows[0]) {
    const x = p.rows[0]
    return {
      id: `prod-${x.id}`, barcode_value: code, entity_type: 'product', product_id: x.id, variant_id: null, is_active: true,
      created_by_name: 'System', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), product: x, variant: null,
    }
  }
  return null
}

export const barcodeRoutes = [
  route({
    method: 'get', path: '/api/barcodes/lookup', perm: 'barcodes.read',
    query: z.object({ code: z.string().min(1).max(100) }).strict(),
    async handler({ db, branch, query }) {
      const record = await lookupBarcode(db, branch!, query.code)
      if (!record) throw notFound('Barcode not found')
      return { record }
    },
  }),

  route({
    method: 'get', path: '/api/barcodes', perm: 'barcodes.read',
    query: z.object({ search: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }).strict(),
    async handler({ db, branch, query }) {
      const where = `r.branch_id = $1 AND ($2::text IS NULL OR r.barcode_value ILIKE '%' || $2 || '%')`
      const rows = await db.query(`SELECT ${REGISTRY_SELECT} WHERE ${where} ORDER BY r.created_at DESC LIMIT ${query.limit} OFFSET ${query.offset}`, [branch, query.search?.trim() || null])
      const total = await db.query(`SELECT count(*)::int AS n FROM public.barcode_registry r WHERE ${where}`, [branch, query.search?.trim() || null])
      return { records: rows.rows, total: total.rows[0].n }
    },
  }),

  // data for the label / sheet print flows
  route({
    method: 'get', path: '/api/barcodes/print-data', perm: 'barcodes.read',
    query: z.object({ product_id: z.coerce.number().int().positive(), variant_id: z.string().uuid().optional() }).strict(),
    async handler({ db, branch, query }) {
      const r = await db.query(
        `SELECT ${REGISTRY_SELECT} WHERE r.branch_id = $1 AND r.product_id = $2 AND r.variant_id IS NOT DISTINCT FROM $3 AND r.is_active
         ORDER BY r.created_at DESC LIMIT 1`, [branch, query.product_id, query.variant_id ?? null])
      if (!r.rows[0]) throw notFound('No barcode for this item')
      return { record: r.rows[0] }
    },
  }),

  route({
    method: 'post', path: '/api/barcodes/receive', perm: 'barcodes.write',
    body: z.object({
      product_id: z.number().int().positive(), variant_id: z.string().uuid().nullish(),
      quantity_received: z.number().finite().min(0), unit_cost: z.number().finite().min(0).nullish(),
      custom_barcode: z.string().trim().max(100).nullish(), note: z.string().max(500).default(''),
    }).strict(),
    async handler({ db, branch, body, session }) {
      const r = await db.query(
        `SELECT public.create_barcode_and_receive_stock($1, $2, $3, $4, $5, $6, $7, $8) AS r`,
        [body.product_id, body.variant_id ?? null, body.quantity_received, body.unit_cost ?? null, actorName(session!), body.custom_barcode || null, body.note, branch])
      return r.rows[0].r
    },
  }),

  // the product editor's "barcode" field: upsert on (branch, value), exactly as the original did
  route({
    method: 'put', path: '/api/barcodes/register', perm: 'barcodes.write',
    body: z.object({
      product_id: z.number().int().positive(), variant_id: z.string().uuid().nullish(),
      barcode_value: z.string().trim().min(1).max(100),
    }).strict(),
    async handler({ db, branch, body }) {
      const entity = body.variant_id ? 'variant' : 'product'
      const r = await db.query(
        `INSERT INTO public.barcode_registry (barcode_value, entity_type, product_id, variant_id, is_active, branch_id)
         VALUES ($1, $2, $3, $4, true, $5)
         ON CONFLICT (branch_id, barcode_value) DO UPDATE
           SET entity_type = EXCLUDED.entity_type, product_id = EXCLUDED.product_id, variant_id = EXCLUDED.variant_id, is_active = true, updated_at = now()
         RETURNING id, barcode_value, entity_type, product_id, variant_id`, [body.barcode_value, entity, body.product_id, body.variant_id ?? null, branch])
      return { record: r.rows[0] }
    },
  }),

  route({
    method: 'post', path: '/api/barcodes/:id/deactivate', perm: 'barcodes.write',
    async handler({ db, branch, params }) {
      const r = await db.query(`UPDATE public.barcode_registry SET is_active = false, updated_at = now() WHERE id = $1 AND branch_id = $2`, [params.id, branch])
      if (!r.rowCount) throw notFound()
      return { ok: true }
    },
  }),
]

