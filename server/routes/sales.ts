import { z } from 'zod'
import type { Db } from '../lib/db.js'
import { ApiError, notFound } from '../lib/errors.js'
import { route } from '../lib/route.js'
import { insertRow, updateRow } from '../lib/sql.js'

const money = z.number().finite().min(0)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}([T ][0-9:.+Z-]+)?$/)
const splitPart = z.object({ method: z.enum(['cash', 'qr', 'upi', 'card']), amount: z.number().finite().positive().max(10_000_000) }).strict()
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
  // a split bill keeps payment_method = 'split' and the breakdown here: { payments: [{ method, amount }, ...] }
  split_details: z.object({ payments: z.array(splitPart).min(2).max(3).optional() }).strict().default({}),
  total_gst: money.default(0),
  gst_enabled: z.boolean().default(false),
  remarks: z.string().max(1000).nullish(),
  reference_number: z.string().max(100).nullish(),
  billing_date: date.nullish(),
  // one random key per bill from the browser: a repeated request (double tap, retry after a slow network) returns the
  // first bill instead of creating another (see orders_branch_idempotency_key)
  idempotency_key: z.string().trim().min(8).max(100).optional(),
}).strict()

const isKeyConflict = (e: unknown) => {
  const x = e as { code?: string; constraint?: string }
  return x?.code === '23505' && String(x.constraint || '').includes('idempotency_key')
}

/** The bill already made for this key (same shape the sale function returns), or null. */
async function saleForKey(db: Db, branch: string, key: string) {
  const r = await db.query(`SELECT id, invoice_no, total FROM public.orders WHERE branch_id = $1 AND idempotency_key = $2`, [branch, key])
  const o = r.rows[0]
  return o ? { order_id: o.id, invoice_no: o.invoice_no, total: Number(o.total), replayed: true } : null
}

export const RETURN_REASONS = ['Wrong size', 'Defective / damaged', 'Customer changed mind', 'Wrong item billed', 'Other'] as const
const returnLines = z.object({
  items: z.array(z.object({ order_item_id: z.number().int().positive(), quantity: z.number().finite().gt(0).max(100000), restock: z.boolean().default(true) }).strict()).min(1).max(200),
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
    async handler({ db, branch, body, session }) {
      const { idempotency_key: key, ...b } = body
      const again = key ? await saleForKey(db, branch!, key) : null
      if (again) return again
      try {
        return await db.tx(async (t) => {
          const r = await t.query(
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
          const sale = r.rows[0].r as { order_id: string; total?: number }
          // The sale function only knows the coupon discount and counts delivery twice (shipping + delivery_charge); the grand total
          // is subtotal - coupon - manual discount + GST + delivery (never below zero), exactly what the POS shows. Set it here, in the
          // same transaction, so the bill is right even if the POS's follow-up "finalize" call never arrives.
          const fixed = (await t.query(
            `UPDATE public.orders
                SET total = GREATEST(0, ROUND(GREATEST(0, subtotal - discount_amount - manual_discount_amount) + total_gst
                                              + CASE WHEN delivery_charge > 0 THEN delivery_charge ELSE shipping END, 2))
              WHERE id = $1 AND branch_id = $2 RETURNING total`, [sale.order_id, branch])).rows[0]
          sale.total = Number(fixed.total)
          // Split payment: the parts must add up to the bill (an error here rolls the whole sale back, stock included)
          const parts = b.split_details.payments
          if (b.payment_method === 'split') {
            if (!parts) throw new ApiError(400, 'A split payment needs its payment breakdown')
            if (new Set(parts.map((p) => (p.method === 'upi' ? 'qr' : p.method))).size !== parts.length) throw new ApiError(400, 'Use a different payment method for each part of a split payment')
            const paid = Math.round(parts.reduce((s, p) => s + p.amount, 0) * 100) / 100
            if (Math.abs(paid - sale.total) > 0.01) throw new ApiError(400, `Split amounts (₹${paid.toFixed(2)}) must add up to the grand total (₹${sale.total.toFixed(2)})`)
          } else if (parts) {
            throw new ApiError(400, 'A payment breakdown is only allowed for a split payment')
          }
          // remember who made the bill (only this login session may re-save its totals: finalize) and its idempotency key.
          // Two identical requests at the same instant: the second one fails on the unique key here and its whole
          // transaction (stock deduction included) is rolled back; it then returns the first bill below.
          await t.query(`UPDATE public.orders SET created_by_role = $1, created_by_sid = $2, idempotency_key = $3 WHERE id = $4 AND branch_id = $5`, [session!.role, session!.sid, key ?? null, sale.order_id, branch])
          return r.rows[0].r
        })
      } catch (e) {
        if (key && isKeyConflict(e)) { const first = await saleForKey(db, branch!, key); if (first) return first }
        throw e
      }
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
  // POS quick-apply chips: the active coupon codes (+ percentage) of this branch (what the original POS listed for every role)
  route({
    method: 'get', path: '/api/coupons/available', perm: 'coupons.lookup',
    async handler({ db, branch }) {
      const r = await db.query(`SELECT code, percentage FROM public.coupons WHERE branch_id = $1 AND is_active ORDER BY created_at DESC LIMIT 20`, [branch])
      return { coupons: r.rows }
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
      order_mode: z.string().max(30).optional(), exclude_order_type: z.string().max(30).optional(),
      // history screen filters: same matching the screen used to build itself (digits-only / zero-stripped variants)
      q: z.string().max(100).optional(), invoice: z.string().max(100).optional(), phone: z.string().max(100).optional(), customer: z.string().max(100).optional(),
      from: date.optional(), to: date.optional(), include_items: z.enum(['1', 'true']).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200), offset: z.coerce.number().int().min(0).default(0),
    }).strict(),
    async handler({ db, branch, query }) {
      const p: unknown[] = [branch]
      const bind = (v: unknown) => { p.push(v); return `$${p.length}` }
      const like = (col: string, v: string) => `${col} ILIKE '%' || ${bind(v)} || '%'`
      const conds: string[] = ['o.branch_id = $1']
      if (query.search) conds.push(`(${like('o.invoice_no', query.search)} OR ${like('o.customer_name', query.search)} OR ${like('o.phone', query.search)})`)
      if (query.status) conds.push(`lower(o.status) = ${bind(query.status)}`)
      if (query.order_type) conds.push(`o.order_type = ${bind(query.order_type)}`)
      if (query.order_mode) conds.push(`o.order_mode = ${bind(query.order_mode)}`)
      if (query.exclude_order_type) conds.push(`o.order_type <> ${bind(query.exclude_order_type)}`)
      if (query.from) conds.push(`o.created_at >= ${bind(query.from)}::timestamptz`)
      if (query.to) conds.push(`o.created_at <= ${bind(query.to)}::timestamptz`)
      if (query.q) {
        const q = query.q.trim(); const digits = q.replace(/\D/g, ''); const nz = digits.replace(/^0+/, '')
        const or = [like('o.invoice_no', q), like('o.customer_name', q), like('o.phone', q)]
        if (digits && digits !== q) { or.push(like('o.invoice_no', digits)); if (digits.length >= 4) or.push(like('o.phone', digits)) }
        if (nz && nz !== digits && nz !== q) or.push(like('o.invoice_no', nz))
        conds.push(`(${or.join(' OR ')})`)
      }
      if (query.invoice) {
        const v = query.invoice.trim(); const digits = v.replace(/\D/g, ''); const nz = digits.replace(/^0+/, '')
        const or = [like('o.invoice_no', v)]
        if (digits && digits !== v) or.push(like('o.invoice_no', digits))
        if (nz && nz !== digits && nz !== v) or.push(like('o.invoice_no', nz))
        conds.push(`(${or.join(' OR ')})`)
      }
      if (query.phone) {
        const v = query.phone.trim(); const digits = v.replace(/\D/g, '')
        conds.push(digits && digits.length >= 4 ? `(${like('o.phone', v)} OR ${like('o.phone', digits)})` : like('o.phone', v))
      }
      if (query.customer) conds.push(like('o.customer_name', query.customer.trim()))
      const where = conds.join(' AND ')
      const items = query.include_items
        ? `, COALESCE((SELECT json_agg(to_jsonb(i) || jsonb_build_object('returned_quantity', COALESCE((SELECT SUM(r.quantity) FROM public.order_return_items r WHERE r.order_item_id = i.id AND r.branch_id = i.branch_id), 0)) ORDER BY i.id) FROM public.order_items i WHERE i.order_id = o.id AND i.branch_id = o.branch_id), '[]'::json) AS order_items`
        : ''
      const rows = await db.query(`SELECT o.*${items} FROM public.orders o WHERE ${where} ORDER BY o.created_at DESC LIMIT ${query.limit} OFFSET ${query.offset}`, p)
      const total = await db.query(`SELECT count(*)::int AS n FROM public.orders o WHERE ${where}`, p)
      return { orders: rows.rows, total: total.rows[0].n }
    },
  }),
  // The original POS re-saves the bill's totals / payment / remarks / billing date right after the sale function ran.
  // Same step, same fields, but only on a bill of THIS branch, made by THIS login session and role, in the last 30 minutes.
  route({
    method: 'patch', path: '/api/orders/:id/finalize', perm: 'pos.sale',
    body: z.object({
      subtotal: money, total: money, total_gst: money, gst_amount: money, discount_amount: money, manual_discount_amount: money,
      delivery_charge: money, payment_mode: z.string().max(200), payment_method: z.string().max(200),
      remarks: z.string().max(1000), reference_number: z.string().max(100), billing_date: date,
    }).partial().strict(),
    async handler({ db, branch, body, params, session }) {
      const keys = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined)
      if (!keys.length) return { ok: true }
      const sets = keys.map((k, i) => `"${k}" = $${i + 1}`)
      const vals = keys.map((k) => (body as Record<string, unknown>)[k])
      // ALL of: the token's branch, the same login session and role that made the bill, younger than 30 minutes
      const r = await db.query(
        `UPDATE public.orders SET ${sets.join(', ')}, updated_at = now()
         WHERE id = $${keys.length + 1} AND branch_id = $${keys.length + 2}
           AND created_by_sid = $${keys.length + 3} AND created_by_role = $${keys.length + 4}
           AND created_at > now() - interval '30 minutes'`, [...vals, params.id, branch, session!.sid, session!.role])
      if (!r.rowCount) throw notFound('Bill not found, or too old to edit')
      return { ok: true }
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
    body: z.object({ status: z.enum(['pending', 'completed']) }).strict(),
    async handler({ db, branch, body, params }) {
      return db.tx(async (t) => {
        const cur = (await t.query(`SELECT status FROM public.orders WHERE id = $1 AND branch_id = $2 FOR UPDATE`, [params.id, branch])).rows[0]
        if (!cur) throw notFound()
        // a bill cancelled earlier (before the cancel action was removed) and a returned bill stay as they are: a return is its own record
        if (['cancelled', 'returned', 'partially_returned'].includes(cur.status)) throw new ApiError(409, `A ${cur.status.replace('_', ' ')} order cannot be changed`)
        return { order: await updateRow(t, 'orders', params.id, branch!, { status: body.status }) }
      })
    },
  }),
  // ---- returns (replace the old cancel action) ----
  // Everything money- or stock-related happens in SQL (process_order_return): one transaction, row locks, idempotent.
  // Narrowest read the Return modal needs: the bill's lines with bought / already-returned quantities. No prices, no customer data.
  route({
    method: 'get', path: '/api/orders/:id/returns', perm: 'orders.return',
    async handler({ db, branch, params }) {
      const o = (await db.query(`SELECT id, invoice_no, status, payment_method, payment_mode FROM public.orders WHERE id = $1 AND branch_id = $2`, [params.id, branch])).rows[0]
      if (!o) throw notFound()
      const items = await db.query(
        `SELECT i.id AS order_item_id, i.name, i.variant_name, i.quantity, i.is_manual,
                COALESCE((SELECT SUM(r.quantity) FROM public.order_return_items r WHERE r.order_item_id = i.id AND r.branch_id = i.branch_id), 0) AS returned_quantity
           FROM public.order_items i WHERE i.order_id = $1 AND i.branch_id = $2 AND i.quantity > 0 ORDER BY i.id`, [params.id, branch])
      const returns = await db.query(`SELECT public.order_return_json(r.id, r.branch_id) AS r FROM public.order_returns r WHERE r.order_id = $1 AND r.branch_id = $2 ORDER BY r.created_at, r.return_no`, [params.id, branch])
      return { order: o, items: items.rows.map((x) => ({ ...x, quantity: Number(x.quantity), returned_quantity: Number(x.returned_quantity) })), returns: returns.rows.map((x) => x.r) }
    },
  }),
  // the refund amount shown BEFORE confirming: the same SQL, dry run (nothing written)
  route({
    method: 'post', path: '/api/orders/:id/return/preview', perm: 'orders.return', body: returnLines,
    async handler({ db, branch, body, params, session }) {
      // another branch's (or a made-up) bill is a plain 404, never an SQL error text
      if (!(await db.query(`SELECT 1 FROM public.orders WHERE id = $1 AND branch_id = $2`, [params.id, branch])).rows[0]) throw notFound()
      const r = await db.query(`SELECT public.process_order_return($1, $2, $3::jsonb, '', '', 'cash', $4, NULL, true) AS r`, [params.id, branch, JSON.stringify(body.items), session!.role])
      return r.rows[0].r
    },
  }),
  route({
    method: 'post', path: '/api/orders/:id/return', perm: 'orders.return', status: 201,
    body: returnLines.extend({
      reason: z.enum(RETURN_REASONS), note: z.string().trim().max(300).default(''),
      refund_mode: z.enum(['cash', 'original']).default('cash'), idempotency_key: z.string().min(8).max(80).optional(),
    }).strict(),
    async handler({ db, branch, body, params, session }) {
      return db.tx(async (t) => {
        if (!(await t.query(`SELECT 1 FROM public.orders WHERE id = $1 AND branch_id = $2`, [params.id, branch])).rows[0]) throw notFound()
        const r = await t.query(`SELECT public.process_order_return($1, $2, $3::jsonb, $4, $5, $6, $7, $8, false) AS r`,
          [params.id, branch, JSON.stringify(body.items), body.reason, body.note, body.refund_mode, session!.role, body.idempotency_key ?? null])
        return r.rows[0].r
      })
    },
  }),
  route({
    method: 'delete', path: '/api/orders/:id', perm: 'orders.delete',
    async handler({ db, branch, params, session }) {
      return db.tx(async (t) => {
        // deleting a live bill must not leak stock: it is cancelled (restocked, ledger reversed) first, then removed
        const cur = (await t.query(`SELECT status FROM public.orders WHERE id = $1 AND branch_id = $2 FOR UPDATE`, [params.id, branch])).rows[0]
        if (!cur) throw notFound()
        // (a fully returned bill already has all its stock back; a part-returned one gets only its never-returned units, see cancel_order)
        if (!['cancelled', 'returned'].includes(cur.status)) await t.query(`SELECT public.cancel_order($1, $2, $3, $4)`, [params.id, branch, session!.role, 'Order deleted'])
        // same sequence the history screen ran: release a linked advance order, then delete the bill (items cascade)
        await t.query(`UPDATE public.advance_orders SET completed_order_id = NULL, invoice_number = NULL, status = 'cancelled' WHERE completed_order_id = $1 AND branch_id = $2`, [params.id, branch])
        const r = await t.query(`DELETE FROM public.orders WHERE id = $1 AND branch_id = $2`, [params.id, branch])
        if (!r.rowCount) throw notFound()
        return { ok: true }
      })
    },
  }),
]

