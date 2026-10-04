import { z } from 'zod'
import { actorName } from '../lib/auth.js'
import { badRequest } from '../lib/errors.js'
import { route } from '../lib/route.js'

const idParam = z.coerce.number().int().positive()
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}([T ][0-9:.+Z-]+)?$/)

export const inventoryRoutes = [
  // stock-ledger list + search (InventoryAnalyticsView, StockHistoryDrawer). Not the Analytics Dashboard.
  route({
    method: 'get', path: '/api/inventory/movements', perm: 'inventory.read',
    query: z.object({
      product_id: idParam.optional(), variant_id: z.string().uuid().optional(),
      movement_type: z.enum(['INITIAL_BARCODE_STOCK', 'RESTOCK', 'SALE', 'RETURN', 'DAMAGE', 'CORRECTION', 'VOID']).optional(),
      from: date.optional(), to: date.optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200), offset: z.coerce.number().int().min(0).default(0),
    }).strict(),
    async handler({ db, branch, query }) {
      const where = `m.branch_id = $1 AND ($2::bigint IS NULL OR m.product_id = $2) AND ($3::uuid IS NULL OR m.variant_id = $3)
        AND ($4::text IS NULL OR m.movement_type = $4) AND ($5::timestamptz IS NULL OR m.created_at >= $5) AND ($6::timestamptz IS NULL OR m.created_at <= $6)`
      const p = [branch, query.product_id ?? null, query.variant_id ?? null, query.movement_type ?? null, query.from ?? null, query.to ?? null]
      const rows = await db.query(
        `SELECT m.id, m.product_id, m.variant_id, m.barcode_id, m.movement_type, m.quantity_delta, m.quantity_before, m.quantity_after,
                m.unit_cost, m.reference_type, m.reference_id, m.note, m.created_by_name, m.created_at,
                CASE WHEN pr.id IS NULL THEN NULL ELSE json_build_object('id', pr.id, 'name', pr.name, 'name_ta', pr.name_ta, 'image_url', pr.image_url) END AS product,
                CASE WHEN v.id IS NULL THEN NULL ELSE json_build_object('id', v.id, 'variant_name', v.variant_name, 'sku', v.sku) END AS variant
         FROM public.inventory_movements m
         LEFT JOIN public.products pr ON pr.id = m.product_id AND pr.branch_id = m.branch_id
         LEFT JOIN public.product_variants v ON v.id = m.variant_id AND v.branch_id = m.branch_id
         WHERE ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT ${query.limit} OFFSET ${query.offset}`, p)
      const total = await db.query(`SELECT count(*)::int AS n FROM public.inventory_movements m WHERE ${where}`, p)
      return { movements: rows.rows, total: total.rows[0].n }
    },
  }),

  // polling source for the low-stock alarm (replaces the realtime subscription)
  route({
    method: 'get', path: '/api/inventory/low-stock', perm: 'inventory.read',
    async handler({ db, branch }) {
      const products = await db.query(
        `SELECT id, name, stock_quantity, low_stock_alert, barcode, has_variants, category, category_id
         FROM public.products WHERE branch_id = $1 AND is_active AND NOT has_variants`, [branch])
      const variants = await db.query(
        `SELECT v.id, v.variant_name, v.stock, v.barcode, v.product_id, v.is_active,
                json_build_object('name', p.name, 'category', p.category, 'category_id', p.category_id, 'is_active', p.is_active, 'low_stock_alert', p.low_stock_alert) AS products
         FROM public.product_variants v JOIN public.products p ON p.id = v.product_id AND p.branch_id = v.branch_id
         WHERE v.branch_id = $1 AND v.is_active`, [branch])
      return { products: products.rows, variants: variants.rows }
    },
  }),

  route({
    method: 'post', path: '/api/inventory/adjust', perm: 'inventory.adjust',
    body: z.object({
      product_id: z.number().int().positive(), variant_id: z.string().uuid().nullish(),
      new_quantity: z.number().finite().min(0),
      reason: z.enum(['RESTOCK', 'RETURN', 'DAMAGE', 'CORRECTION', 'VOID']).default('RESTOCK'),
      note: z.string().max(500).default(''),
    }).strict(),
    async handler({ db, branch, body, session }) {
      const r = await db.query(
        `SELECT public.adjust_inventory_stock($1, $2, $3, $4, $5, $6, $7) AS r`,
        [body.product_id, body.variant_id ?? null, body.new_quantity, body.reason, body.note, actorName(session!), branch])
      return r.rows[0].r
    },
  }),

  // The product editor writes a ledger row next to its stock edit (what it inserted directly before).
  route({
    method: 'post', path: '/api/inventory/movements', perm: 'inventory.adjust', status: 201,
    body: z.object({
      product_id: z.number().int().positive(), variant_id: z.string().uuid().nullish(),
      movement_type: z.enum(['RESTOCK', 'CORRECTION']),
      quantity_delta: z.number().finite(), quantity_before: z.number().finite(), quantity_after: z.number().finite(),
      unit_cost: z.number().finite().min(0).nullish(),
      reference_type: z.enum(['PRODUCT_UPDATE', 'PRODUCT_CREATION']),
      note: z.string().max(500).default(''),
    }).strict(),
    async handler({ db, branch, body, session }) {
      // composite foreign keys reject a product / variant of another branch
      const r = await db.query(
        `INSERT INTO public.inventory_movements (product_id, variant_id, movement_type, quantity_delta, quantity_before, quantity_after,
           unit_cost, reference_type, note, created_by_name, branch_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [body.product_id, body.variant_id ?? null, body.movement_type, body.quantity_delta, body.quantity_before, body.quantity_after,
         body.unit_cost ?? null, body.reference_type, body.note, actorName(session!), branch])
      return { id: r.rows[0].id }
    },
  }),

  route({
    method: 'patch', path: '/api/inventory/price', perm: 'inventory.adjust',
    body: z.object({
      entity_type: z.enum(['product', 'variant']), id: z.union([z.number().int().positive(), z.string().uuid()]),
      new_price: z.number().finite().min(0), new_cost_price: z.number().finite().min(0).optional(),
    }).strict(),
    async handler({ db, branch, body }) {
      const table = body.entity_type === 'variant' ? 'product_variants' : 'products'
      if (body.entity_type === 'product' && typeof body.id !== 'number') throw badRequest('Product id must be a number')
      if (body.entity_type === 'variant' && typeof body.id !== 'string') throw badRequest('Variant id must be a uuid')
      const r = await db.query(
        `UPDATE public.${table} SET price = $1, purchase_price = COALESCE($2, purchase_price), updated_at = now() WHERE id = $3 AND branch_id = $4`,
        [body.new_price, body.new_cost_price ?? null, body.id, branch])
      if (!r.rowCount) throw badRequest('Item not found in this branch')
      return { ok: true }
    },
  }),

  route({
    method: 'delete', path: '/api/inventory/items', perm: 'inventory.delete',
    query: z.object({ product_id: idParam, variant_id: z.string().uuid().optional() }).strict(),
    async handler({ db, branch, query }) {
      await db.query(`SELECT public.delete_inventory_item($1, $2, $3)`, [query.product_id, query.variant_id ?? null, branch])
      return { ok: true }
    },
  }),
]
