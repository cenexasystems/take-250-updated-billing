import { z } from 'zod'
import { actorName } from '../lib/auth.js'
import { notFound } from '../lib/errors.js'
import { route } from '../lib/route.js'

const money = z.number().finite().min(0)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const status = z.enum(['pending_deposit', 'ready_for_delivery', 'waiting_final_payment', 'completed', 'cancelled'])

export const advanceRoutes = [
  route({
    method: 'get', path: '/api/advance-orders', perm: 'advance.read',
    async handler({ db, branch }) {
      // bill_returned: a return was processed on the completed bill (the advance order record itself is never changed by a return)
      const r = await db.query(
        `SELECT a.*, EXISTS (SELECT 1 FROM public.order_returns r WHERE r.order_id = a.completed_order_id AND r.branch_id = a.branch_id) AS bill_returned
           FROM public.advance_orders a WHERE a.branch_id = $1 ORDER BY a.created_at DESC`, [branch])
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
      // one random key per form from the browser: a repeated request (double tap, slow-network retry) returns the first
      // advance order instead of creating another (see advance_orders_branch_idempotency_key)
      idempotency_key: z.string().trim().min(8).max(100).optional(),
    }).strict(),
    async handler({ db, branch, body, session }) {
      // NOTE: `SELECT * FROM fn()`, never `SELECT (fn()).*`: Postgres expands the second form into one call of fn() PER COLUMN,
      // which made a single tap insert 25 identical advance orders (one per column of the table).
      const key = body.idempotency_key
      const existing = async () => (key ? (await db.query(`SELECT * FROM public.advance_orders WHERE branch_id = $1 AND idempotency_key = $2`, [branch, key])).rows[0] : undefined)
      const again = await existing()
      if (again) return { order: again, replayed: true }
      try {
        return await db.tx(async (t) => {
          const r = await t.query(
            `SELECT * FROM public.create_advance_order($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`,
            [body.customer_name, body.phone, body.address, body.product_name, body.category, body.description, body.total_amount, body.deposit_amount,
             body.expected_delivery_date, body.remarks, body.payment_method, session!.role, JSON.stringify(body.products), branch])
          // reference_number is accepted but not stored: the original database had no such column on advance orders
          // (its update call failed silently), so an exact copy keeps ignoring it.
          if (key) await t.query(`UPDATE public.advance_orders SET idempotency_key = $1 WHERE id = $2 AND branch_id = $3`, [key, r.rows[0].id, branch])
          return { order: { ...r.rows[0], ...(key ? { idempotency_key: key } : {}) } }
        })
      } catch (e) {
        // the same key at the same instant: the second transaction fails on the unique key and is rolled back
        const x = e as { code?: string; constraint?: string }
        if (key && x?.code === '23505' && String(x.constraint || '').includes('idempotency_key')) { const first = await existing(); if (first) return { order: first, replayed: true } }
        throw e
      }
    },
  }),  route({
    method: 'post', path: '/api/advance-orders/:id/status', perm: 'advance.write',
    body: z.object({ status, remarks: z.string().max(1000).default('') }).strict(),
    async handler({ db, branch, body, params }) {
      const r = await db.query(`SELECT * FROM public.update_advance_order_status($1, $2, $3, $4)`, [params.id, body.status, body.remarks, branch])
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
    async handler({ db, branch, body, params, session }) {
      return db.tx(async (t) => {
        const r = await t.query(
          `SELECT * FROM public.complete_advance_order_v2($1, $2, $3, $4, $5, $6, $7, $8)`,
          [params.id, body.payment_method, body.final_amount, body.coupon_code ?? null, body.coupon_percentage, body.manual_discount, body.remarks, branch])
        // the bill this produced belongs to this login session (it may re-save the split payment text, nothing else)
        await t.query(`UPDATE public.orders SET created_by_role = $1, created_by_sid = $2 WHERE id = $3 AND branch_id = $4`, [session!.role, session!.sid, r.rows[0].order_id, branch])
        return { result: r.rows[0] }
      })
    },
  }),
  // after a split-payment completion the screen stores the readable "Split (...)" text, as the original did
  route({
    method: 'patch', path: '/api/advance-orders/:id/final-method', perm: 'advance.write',
    body: z.object({ final_payment_method: z.string().trim().min(1).max(200) }).strict(),
    async handler({ db, branch, body, params }) {
      const r = await db.query(`UPDATE public.advance_orders SET final_payment_method = $1 WHERE id = $2 AND branch_id = $3 AND status = 'completed'`, [body.final_payment_method, params.id, branch])
      if (!r.rowCount) throw notFound()
      return { ok: true }
    },
  }),
  route({
    method: 'delete', path: '/api/advance-orders/:id', perm: 'advance.delete',
    async handler({ db, branch, params, session }) {
      return db.tx(async (t) => {
        const adv = await t.query(`SELECT completed_order_id FROM public.advance_orders WHERE id = $1 AND branch_id = $2`, [params.id, branch])
        if (!adv.rows[0]) throw notFound()
        // a completed deposit already took stock out: put it back (with reversing ledger rows) before its bill disappears
        if (adv.rows[0].completed_order_id) {
          const bill = await t.query(`SELECT status FROM public.orders WHERE id = $1 AND branch_id = $2`, [adv.rows[0].completed_order_id, branch])
          if (bill.rows[0] && bill.rows[0].status !== 'cancelled') {
            await t.query(`SELECT public.cancel_order($1, $2, $3, $4)`, [adv.rows[0].completed_order_id, branch, actorName(session!), 'Completed deposit deleted'])
          }
        }
        await t.query(`DELETE FROM public.advance_orders WHERE id = $1 AND branch_id = $2`, [params.id, branch])
        if (adv.rows[0].completed_order_id) await t.query(`DELETE FROM public.orders WHERE id = $1 AND branch_id = $2`, [adv.rows[0].completed_order_id, branch])
        return { ok: true }
      })
    },
  }),
]

