import { z } from 'zod'
import { actorName } from '../lib/auth.js'
import { ApiError, notFound } from '../lib/errors.js'
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
        `SELECT a.*, EXISTS (SELECT 1 FROM public.order_returns r WHERE r.order_id = a.completed_order_id AND r.branch_id = a.branch_id) AS bill_returned,
                -- the deposit's own mode and time, for the advance receipt ("Deposit paid (date, mode)")
                d.payment_method AS deposit_method, d.received_at AS deposit_at
           FROM public.advance_orders a
           LEFT JOIN public.advance_order_payments d ON d.advance_order_id = a.id AND d.branch_id = a.branch_id AND d.payment_type = 'deposit'
          WHERE a.branch_id = $1 ORDER BY a.created_at DESC`, [branch])
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
      products: z.array(z.object({}).passthrough()).max(200).default([]), reference_number: z.string().trim().max(100).default(''),
      // one random key per form from the browser: a repeated request (double tap, slow-network retry) returns the first
      // advance order instead of creating another (see advance_orders_branch_idempotency_key)
      idempotency_key: z.string().trim().min(8).max(100).optional(),
      // 0013: an order made from the POS cart sends the cart's breakdown; item prices stay real and
      // subtotal - coupon - manual (never below 0) + GST + delivery must equal total_amount
      cart: z.object({
        subtotal: z.number().finite().gt(0), coupon_code: z.string().trim().max(60).nullish(), coupon_percentage: z.number().finite().min(0).max(100).default(0),
        coupon_discount: z.number().finite().min(0).default(0), manual_discount: z.number().finite().min(0).default(0),
        manual_discount_type: z.enum(['flat', 'percent']).default('flat'), manual_discount_value: z.number().finite().min(0).default(0),
        total_gst: z.number().finite().min(0).default(0), delivery_charge: z.number().finite().min(0).default(0),
      }).strict().optional(),
    }).strict(),
    async handler({ db, branch, body, session }) {
      const cart = body.cart
      // the cart's manual discount is allowed like coupon, GST and delivery: it is stored (cart_manual_discount*) and
      // complete_advance_order_v2 carries it onto the final bill. A manual adjustment at COMPLETION stays refused (below).
      const r2 = (v: number) => Math.round(v * 100) / 100
      const total = cart ? r2(Math.max(0, r2(cart.subtotal) - r2(cart.coupon_discount) - r2(cart.manual_discount)) + r2(cart.total_gst) + r2(cart.delivery_charge)) : body.total_amount
      if (cart && Math.abs(total - body.total_amount) > 0.01) throw new ApiError(400, `The bill breakdown (₹${total.toFixed(2)}) does not match the order total (₹${body.total_amount.toFixed(2)})`)
      // Strip control characters (but keep standard whitespace/newlines) then clamp length
      const sanitiseRef = (v: string) => v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, 100)
      const sanitiseRem = (v: string) => v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, 1000)
      const ref = sanitiseRef(body.reference_number || '')
      const rem = sanitiseRem(body.remarks || '')
      // NOTE: `SELECT * FROM fn()`, never `SELECT (fn()).*`: Postgres expands the second form into one call of fn() PER COLUMN,
      // which made a single tap insert 25 identical advance orders (one per column of the table).
      const key = body.idempotency_key
      const existing = async () => (key ? (await db.query(`SELECT * FROM public.advance_orders WHERE branch_id = $1 AND idempotency_key = $2`, [branch, key])).rows[0] : undefined)
      const again = await existing()
      if (again) return { order: again, replayed: true }
      try {
        return await db.tx(async (t) => {
          // a coupon from the cart: the same rules as a POS sale (this branch's coupon, active, not expired, total and
          // per-customer limit, customer-specific phone); completing the order checks the customer rules again
          if (cart?.coupon_code) await t.query(`SELECT public.assert_coupon_redeemable($1, $2, $3, true)`, [branch, cart.coupon_code, body.phone])
          const r = await t.query(
            // 15th param = p_reference_number (new in 0021 migration)
            `SELECT * FROM public.create_advance_order($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)`,
            [body.customer_name, body.phone, body.address, body.product_name, body.category, body.description, total, body.deposit_amount,
             body.expected_delivery_date, rem, body.payment_method, session!.role, JSON.stringify(body.products), branch, ref || null])
          if (key) await t.query(`UPDATE public.advance_orders SET idempotency_key = $1 WHERE id = $2 AND branch_id = $3`, [key, r.rows[0].id, branch])
          if (cart) {
            const saved = await t.query(
              `UPDATE public.advance_orders SET cart_subtotal = $1, cart_coupon_code = $2, cart_coupon_percentage = $3, cart_coupon_discount = $4,
                      cart_manual_discount = $5, cart_manual_discount_type = $6, cart_manual_discount_value = $7, cart_total_gst = $8, cart_delivery_charge = $9
                WHERE id = $10 AND branch_id = $11 RETURNING *`,
              [r2(cart.subtotal), cart.coupon_code || null, cart.coupon_percentage, r2(cart.coupon_discount), r2(cart.manual_discount), cart.manual_discount_type,
               cart.manual_discount_value, r2(cart.total_gst), r2(cart.delivery_charge), r.rows[0].id, branch])
            return { order: { ...saved.rows[0], deposit_method: body.payment_method, deposit_at: saved.rows[0].created_at } }
          }
          return { order: { ...r.rows[0], ...(key ? { idempotency_key: key } : {}), deposit_method: body.payment_method, deposit_at: r.rows[0].created_at } }
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
      // a split balance payment: stored on the bill (orders.split_details) like a POS split, so every invoice can list it
      split_details: z.object({ payments: z.array(z.object({ method: z.enum(['cash', 'upi', 'card']), amount: z.number().finite().positive() }).strict()).min(2).max(3) }).strict().optional(),
    }).strict(),
    async handler({ db, branch, body, params, session }) {
      // no manual adjustment on advance orders: the balance is paid in full (a coupon is applied when the order is made)
      if (body.manual_discount > 0) throw new ApiError(400, 'Manual adjustment is not allowed on advance orders.')
      if (!body.coupon_code) {
        const adv = (await db.query(`SELECT remaining_balance, status FROM public.advance_orders WHERE id = $1 AND branch_id = $2`, [params.id, branch])).rows[0]
        if (adv && adv.status !== 'completed' && Math.abs(Number(adv.remaining_balance) - body.final_amount) > 0.01) {
          throw new ApiError(400, `The balance of ₹${Number(adv.remaining_balance).toFixed(2)} must be paid in full`)
        }
      }
      return db.tx(async (t) => {
        const r = await t.query(
          `SELECT * FROM public.complete_advance_order_v2($1, $2, $3, $4, $5, $6, $7, $8)`,
          [params.id, body.payment_method, body.final_amount, body.coupon_code ?? null, body.coupon_percentage, body.manual_discount, body.remarks, branch])
        // the bill this produced belongs to this login session (it may re-save the split payment text, nothing else)
        await t.query(`UPDATE public.orders SET created_by_role = $1, created_by_sid = $2 WHERE id = $3 AND branch_id = $4`, [session!.role, session!.sid, r.rows[0].order_id, branch])
        const parts = body.split_details?.payments
        if (parts) {
          if (new Set(parts.map((p) => p.method)).size !== parts.length) throw new ApiError(400, 'Use a different payment method for each part of a split payment')
          const paid = Math.round(parts.reduce((s, p) => s + p.amount, 0) * 100) / 100
          if (Math.abs(paid - body.final_amount) > 0.01) throw new ApiError(400, `Split amounts (₹${paid.toFixed(2)}) must add up to the balance (₹${body.final_amount.toFixed(2)})`)
          const label = `Split (${parts.map((p) => `${p.method === 'upi' ? 'QR' : p.method === 'card' ? 'Card' : 'Cash'} ₹${p.amount}`).join(' + ')})`
          await t.query(`UPDATE public.orders SET payment_method = 'split', payment_mode = 'split', split_details = $1::jsonb WHERE id = $2 AND branch_id = $3`,
            [JSON.stringify({ payments: parts }), r.rows[0].order_id, branch])
          await t.query(`UPDATE public.advance_orders SET final_payment_method = $1 WHERE id = $2 AND branch_id = $3`, [label, params.id, branch])
        }
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

