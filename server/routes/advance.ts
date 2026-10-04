import { z } from 'zod'
import { notFound } from '../lib/errors.js'
import { route } from '../lib/route.js'
import { updateRow } from '../lib/sql.js'

const money = z.number().finite().min(0)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const status = z.enum(['pending_deposit', 'ready_for_delivery', 'waiting_final_payment', 'completed', 'cancelled'])

export const advanceRoutes = [
  route({
    method: 'get', path: '/api/advance-orders', perm: 'advance.read',
    async handler({ db, branch }) {
      const r = await db.query(`SELECT * FROM public.advance_orders WHERE branch_id = $1 ORDER BY created_at DESC`, [branch])
      return { orders: r.rows }
    },
  }),
  route({
    method: 'get', path: '/api/advance-orders/:id/history', perm: 'advance.read',
    async handler({ db, branch, params }) {
      const own = await db.query(`SELECT 1 FROM public.advance_orders WHERE id = $1 AND branch_id = $2`, [params.id, branch])
      if (!own.rows[0]) throw notFound()
      const t = await db.query(`SELECT * FROM public.advance_order_timeline WHERE advance_order_id = $1 AND branch_id = $2 ORDER BY created_at`, [params.id, branch])
      const p = await db.query(`SELECT * FROM public.advance_order_payments WHERE advance_order_id = $1 AND branch_id = $2 ORDER BY received_at`, [params.id, branch])
      return { timeline: t.rows, payments: p.rows }
    },
  }),
  route({
    method: 'post', path: '/api/advance-orders', perm: 'advance.write', status: 201,
    body: z.object({
      customer_name: z.string().trim().min(1).max(200), phone: z.string().trim().min(1).max(100), address: z.string().max(1000).default(''),
      product_name: z.string().trim().min(1).max(500), category: z.string().max(200).default(''), description: z.string().max(2000).default(''),
      total_amount: z.number().finite().gt(0), deposit_amount: z.number().finite().gt(0), expected_delivery_date: day,
      remarks: z.string().max(1000).default(''), payment_method: z.enum(['cash', 'upi', 'card']),
      products: z.array(z.object({}).passthrough()).max(200).default([]), reference_number: z.string().trim().max(100).optional(),
    }).strict(),
    async handler({ db, branch, body, session }) {
      return db.tx(async (t) => {
        const r = await t.query(
          `SELECT (public.create_advance_order($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)).* `,
          [body.customer_name, body.phone, body.address, body.product_name, body.category, body.description, body.total_amount, body.deposit_amount,
           body.expected_delivery_date, body.remarks, body.payment_method, session!.role, JSON.stringify(body.products), branch])
        let order = r.rows[0]
        if (body.reference_number) order = await updateRow(t, 'advance_orders', order.id, branch!, { reference_number: body.reference_number }, [], false)
        return { order }
      })
    },
  }),
  route({
    method: 'post', path: '/api/advance-orders/:id/status', perm: 'advance.write',
    body: z.object({ status, remarks: z.string().max(1000).default('') }).strict(),
    async handler({ db, branch, body, params }) {
      const r = await db.query(`SELECT (public.update_advance_order_status($1, $2, $3, $4)).*`, [params.id, body.status, body.remarks, branch])
      return { order: r.rows[0] }
    },
  }),
  route({
    method: 'post', path: '/api/advance-orders/:id/events', perm: 'advance.write', status: 201,
    body: z.object({ event_type: z.string().trim().min(1).max(60), label: z.string().trim().min(1).max(200), remarks: z.string().max(1000).default('') }).strict(),
    async handler({ db, branch, body, params }) {
      await db.query(`SELECT public.add_advance_order_event($1, $2, $3, $4, $5)`, [params.id, body.event_type, body.label, body.remarks, branch])
      return { ok: true }
    },
  }),
  route({
    method: 'post', path: '/api/advance-orders/:id/complete', perm: 'advance.write',
    body: z.object({
      payment_method: z.enum(['cash', 'upi', 'card']), final_amount: money,
      coupon_code: z.string().max(60).nullish(), coupon_percentage: z.number().finite().min(0).max(100).default(0),
      manual_discount: money.default(0), remarks: z.string().max(1000).default(''),
    }).strict(),
    async handler({ db, branch, body, params }) {
      const r = await db.query(
        `SELECT * FROM public.complete_advance_order_v2($1, $2, $3, $4, $5, $6, $7, $8)`,
        [params.id, body.payment_method, body.final_amount, body.coupon_code ?? null, body.coupon_percentage, body.manual_discount, body.remarks, branch])
      return { result: r.rows[0] }
    },
  }),
  route({
    method: 'delete', path: '/api/advance-orders/:id', perm: 'advance.delete',
    async handler({ db, branch, params }) {
      return db.tx(async (t) => {
        const adv = await t.query(`SELECT completed_order_id FROM public.advance_orders WHERE id = $1 AND branch_id = $2`, [params.id, branch])
        if (!adv.rows[0]) throw notFound()
        await t.query(`DELETE FROM public.advance_orders WHERE id = $1 AND branch_id = $2`, [params.id, branch])
        if (adv.rows[0].completed_order_id) await t.query(`DELETE FROM public.orders WHERE id = $1 AND branch_id = $2`, [adv.rows[0].completed_order_id, branch])
        return { ok: true }
      })
    },
  }),
]

