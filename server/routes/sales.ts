import { z } from 'zod'
import { notFound } from '../lib/errors.js'
import { route } from '../lib/route.js'
import { insertRow, updateRow } from '../lib/sql.js'

const money = z.number().finite().min(0)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}([T ][0-9:.+Z-]+)?$/)
const statusWord = z.string().trim().toLowerCase().regex(/^[a-z_]{3,30}$/)

/** Billing maths lives in SQL (complete_pos_sale_with_inventory). The API only validates the shape,
 * adds the branch from the token and calls the function. */
const saleBody = z.object({
  customer_name: z.string().max(200).default('Customer'),
  phone: z.string().max(100).default(''),
  address: z.string().max(1000).default(''),
  items: z.array(z.object({}).passthrough()).min(1).max(500),
  shipping: money.default(0),
  status: statusWord.default('completed'),
  order_mode: z.string().max(30).default('offline'),
  order_type: z.string().max(30).default('pos_sale'),
  delivery_charge: money.default(0),
  discount_amount: money.default(0),
  manual_discount_amount: money.default(0),
  manual_discount_type: z.enum(['flat', 'percent', 'percentage']).default('flat'),
  manual_discount_value: money.default(0),
  coupon_code: z.string().max(60).nullish(),
  coupon_percentage: z.number().finite().min(0).max(100).default(0),
  payment_method: z.string().max(30).default('cash'),
  split_details: z.object({}).passthrough().default({}),
  total_gst: money.default(0),
  gst_enabled: z.boolean().default(false),
  remarks: z.string().max(1000).nullish(),
  reference_number: z.string().max(100).nullish(),
  billing_date: date.nullish(),
}).strict()

const couponFields = {
  code: z.string().trim().min(1).max(60),
  percentage: z.number().finite().gt(0).max(100),
  is_active: z.boolean(),
  expiry_date: date.nullable(),
  usage_limit: z.number().int().positive().nullable(),
  min_order_value: money,
}

export const salesRoutes = [
  route({
    method: 'post', path: '/api/pos/sale', perm: 'pos.sale', status: 201, body: saleBody,
    async handler({ db, branch, body }) {
      const b = body
      const r = await db.query(
        `SELECT public.complete_pos_sale_with_inventory(
           p_customer_name => $1, p_phone => $2, p_address => $3, p_items => $4::jsonb, p_shipping => $5, p_status => $6,
           p_order_mode => $7, p_order_type => $8, p_delivery_charge => $9, p_discount_amount => $10,
           p_manual_discount_amount => $11, p_manual_discount_type => $12, p_manual_discount_value => $13,
           p_coupon_code => $14, p_coupon_percentage => $15, p_payment_method => $16, p_split_details => $17::jsonb,
           p_total_gst => $18, p_gst_enabled => $19, p_remarks => $20, p_reference_number => $21, p_billing_date => $22, p_branch => $23) AS r`,
        [b.customer_name, b.phone, b.address, JSON.stringify(b.items), b.shipping, b.status, b.order_mode, b.order_type, b.delivery_charge,
         b.discount_amount, b.manual_discount_amount, b.manual_discount_type, b.manual_discount_value, b.coupon_code ?? null, b.coupon_percentage,
         b.payment_method, JSON.stringify(b.split_details), b.total_gst, b.gst_enabled, b.remarks ?? null, b.reference_number ?? null,
         b.billing_date ?? null, branch])
      return r.rows[0].r
    },
  }),

  // POS "add unregistered item": same steps as the original (find/create the 'Unregistered' category and product)
  route({
    method: 'post', path: '/api/pos/unregistered-product', perm: 'pos.unregistered',
    body: z.object({ name: z.string().trim().min(1).max(200), price: money }).strict(),
    async handler({ db, branch, body }) {
      return db.tx(async (t) => {
        let cat = (await t.query(`SELECT id FROM public.categories WHERE branch_id = $1 AND lower(btrim(name_en)) = 'unregistered'`, [branch])).rows[0]
        if (!cat) cat = await insertRow(t, 'categories', branch!, { name_en: 'Unregistered', name_ta: 'பதிவுசெய்யப்படாதது', is_active: true, sort_order: 999 })
        const existing = (await t.query(
          `SELECT id, name, price FROM public.products WHERE branch_id = $1 AND category_id = $2 AND lower(btrim(name)) = lower($3) LIMIT 1`,
          [branch, cat.id, body.name])).rows[0]
        if (existing) {
          if (Number(existing.price) !== body.price) await t.query(`UPDATE public.products SET price = $1, updated_at = now() WHERE id = $2 AND branch_id = $3`, [body.price, existing.id, branch])
          return { id: Number(existing.id), name: existing.name, price: body.price, category: 'Unregistered' }
        }
        const p = await insertRow(t, 'products', branch!, {
          name: body.name, category: 'Unregistered', category_id: cat.id, price: body.price, offer_price: null, stock_quantity: 0, stock: 0,
          unit_type: 'unit', unit_label: 'piece', unit: 'piece', base_quantity: 1, has_variants: false, is_active: true, sort_order: 999,
        })
        return { id: Number(p.id), name: p.name, price: Number(p.price), category: 'Unregistered' }
      })
    },
  }),

  // ---- coupons ----
  route({
    method: 'get', path: '/api/coupons/lookup', perm: 'coupons.lookup',
    query: z.object({ code: z.string().trim().min(1).max(60) }).strict(),
    async handler({ db, branch, query }) {
      const r = await db.query(
        `SELECT id, code, percentage, is_active, expiry_date, usage_limit, usage_count, min_order_value FROM public.coupons
         WHERE branch_id = $1 AND is_active AND upper(btrim(code)) = upper(btrim($2)) LIMIT 1`, [branch, query.code])
      if (!r.rows[0]) throw notFound('Invalid or expired coupon code')
      return { coupon: r.rows[0] }
    },
  }),
  route({
    method: 'get', path: '/api/coupons', perm: 'coupons.read',
    async handler({ db, branch }) {
      const r = await db.query(`SELECT * FROM public.coupons WHERE branch_id = $1 ORDER BY created_at DESC, id DESC`, [branch])
      return { coupons: r.rows }
    },
  }),
  route({
    method: 'post', path: '/api/coupons', perm: 'coupons.write', status: 201,
    body: z.object(couponFields).partial().required({ code: true, percentage: true }).strict(),
    async handler({ db, branch, body }) {
      return { coupon: await insertRow(db, 'coupons', branch!, body) }
    },
  }),
  route({
    method: 'patch', path: '/api/coupons/:id', perm: 'coupons.write',
    body: z.object(couponFields).partial().strict(),
    async handler({ db, branch, body, params }) {
      return { coupon: await updateRow(db, 'coupons', Number(params.id), branch!, body) }
    },
  }),
  route({
    method: 'delete', path: '/api/coupons/:id', perm: 'coupons.write',
    async handler({ db, branch, params }) {
      const r = await db.query(`DELETE FROM public.coupons WHERE id = $1 AND branch_id = $2`, [Number(params.id), branch])
      if (!r.rowCount) throw notFound()
      return { ok: true }
    },
  }),

  // ---- orders (history) ----
  route({
    method: 'get', path: '/api/orders', perm: 'orders.read',
    query: z.object({
      search: z.string().max(100).optional(), status: statusWord.optional(), order_type: z.string().max(30).optional(),
      from: date.optional(), to: date.optional(), include_items: z.enum(['1', 'true']).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200), offset: z.coerce.number().int().min(0).default(0),
    }).strict(),
    async handler({ db, branch, query }) {
      const where = `o.branch_id = $1 AND ($2::text IS NULL OR o.invoice_no ILIKE '%' || $2 || '%' OR o.customer_name ILIKE '%' || $2 || '%' OR o.phone ILIKE '%' || $2 || '%')
        AND ($3::text IS NULL OR lower(o.status) = $3) AND ($4::text IS NULL OR o.order_type = $4)
        AND ($5::timestamptz IS NULL OR o.created_at >= $5) AND ($6::timestamptz IS NULL OR o.created_at <= $6)`
      const p = [branch, query.search ?? null, query.status ?? null, query.order_type ?? null, query.from ?? null, query.to ?? null]
      const items = query.include_items
        ? `, COALESCE((SELECT json_agg(i ORDER BY i.id) FROM public.order_items i WHERE i.order_id = o.id AND i.branch_id = o.branch_id), '[]'::json) AS order_items`
        : ''
      const rows = await db.query(`SELECT o.*${items} FROM public.orders o WHERE ${where} ORDER BY o.created_at DESC LIMIT ${query.limit} OFFSET ${query.offset}`, p)
      const total = await db.query(`SELECT count(*)::int AS n FROM public.orders o WHERE ${where}`, p)
      return { orders: rows.rows, total: total.rows[0].n }
    },
  }),
  route({
    method: 'get', path: '/api/orders/:id', perm: 'orders.read',
    async handler({ db, branch, params }) {
      const o = await db.query(`SELECT * FROM public.orders WHERE id = $1 AND branch_id = $2`, [params.id, branch])
      if (!o.rows[0]) throw notFound()
      const items = await db.query(`SELECT * FROM public.order_items WHERE order_id = $1 AND branch_id = $2 ORDER BY id`, [params.id, branch])
      return { order: o.rows[0], items: items.rows }
    },
  }),
  route({
    method: 'patch', path: '/api/orders/:id/status', perm: 'orders.status',
    body: z.object({ status: statusWord }).strict(),
    async handler({ db, branch, body, params }) {
      return { order: await updateRow(db, 'orders', params.id, branch!, { status: body.status }) }
    },
  }),
  route({
    method: 'delete', path: '/api/orders/:id', perm: 'orders.delete',
    async handler({ db, branch, params }) {
      return db.tx(async (t) => {
        // same sequence the history screen ran: release a linked advance order, then delete the bill (items cascade)
        await t.query(`UPDATE public.advance_orders SET completed_order_id = NULL, invoice_number = NULL, status = 'cancelled' WHERE completed_order_id = $1 AND branch_id = $2`, [params.id, branch])
        const r = await t.query(`DELETE FROM public.orders WHERE id = $1 AND branch_id = $2`, [params.id, branch])
        if (!r.rowCount) throw notFound()
        return { ok: true }
      })
    },
  }),
]
