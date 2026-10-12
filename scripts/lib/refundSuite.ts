// Refund by payment mode (migration 0015) and payment-mode revenue, written once and run by scripts/test-api.ts (TEST
// database, inside its rolled-back transaction) and by the in-memory-Postgres harness. Every check runs for pos1..pos3.
import type { Actor, ReturnsCtx } from './returnsSuite'

export type RefundCtx = Omit<ReturnsCtx, 'concurrent'>
const MODES = ['cash', 'card', 'qr', 'other'] as const
const r2 = (v: number) => Math.round(v * 100) / 100
const sumOf = (m: Record<string, number> | null | undefined) => r2(Object.values(m ?? {}).reduce((s, v) => s + Number(v), 0))
const norm = (m: Record<string, number> | null | undefined) => JSON.stringify(Object.fromEntries(Object.entries(m ?? {}).filter(([, v]) => Number(v) !== 0).map(([k, v]) => [k, Number(v)]).sort()))

/** the analytics rule: per mode = paid - refunded on the bill; the rest of the bill's net goes to Other */
export function modeRevenue(rows: Array<{ total: number | string; returned_amount?: number | string; paid_by_mode?: Record<string, number>; refunds_by_mode?: Record<string, number> }>) {
  const out = { cash: 0, card: 0, qr: 0, other: 0 }
  let net = 0
  for (const o of rows) {
    const n = Math.max(0, Number(o.total) - Number(o.returned_amount || 0)); net += n
    let explained = 0
    for (const m of MODES) { const v = Number(o.paid_by_mode?.[m] || 0) - Number(o.refunds_by_mode?.[m] || 0); out[m] += v; explained += v }
    out.other += n - explained
  }
  return { ...Object.fromEntries(MODES.map((m) => [m, r2(out[m])])) as Record<typeof MODES[number], number>, net: r2(net) }
}

export async function refundSuite(c: RefundCtx) {
  const { call, q, check, cookies } = c
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0]
  const num = (v: unknown) => Number(v)

  for (const b of c.branches.filter((x) => !c.only || x === c.only)) {
    const n = b.slice(-1)
    const staff = `staff${n}` as Actor, mgr = `manager${n}` as Actor
    const other = c.branches.find((x) => x !== b)!
    const L = `[${b}] refund-mode:`
    const P = num((await one(`INSERT INTO products (name, category, price, stock_quantity, stock, branch_id, is_active) VALUES ($1, 'Rf Cat', 500, 100, 100, $2, true) RETURNING id`, [`Rf Item ${n}`, b])).id)
    const sell = async (extra: Record<string, unknown>, qty = 2) => {
      const r = await call('POST', '/api/pos/sale', { cookie: cookies[staff], body: { customer_name: `Rf Customer ${n}`, phone: '9876500066', payment_method: 'cash',
        items: [{ product_id: P, quantity: qty, unit_price: 500, line_total: 500 * qty, name: `Rf Item ${n}` }], ...extra } })
      if (r.status !== 201) check(false, `${L} fixture sale`, `${r.status} ${JSON.stringify(r.body)}`)
      return r.body as { order_id: string; invoice_no: string }
    }
    const line = async (orderId: string) => num((await one(`SELECT id FROM order_items WHERE order_id = $1`, [orderId])).id)
    const listed = async (orderId: string, as: Actor = mgr) => ((await call('GET', '/api/orders', { cookie: cookies[as], query: { limit: '1000' } })).body.orders as any[]).find((o) => o.id === orderId)
    const preview = (orderId: string, item: number, mode: string, qty = 1) => call('POST', `/api/orders/${orderId}/return/preview`, { cookie: cookies[staff], body: { items: [{ order_item_id: item, quantity: qty }], refund_mode: mode } })
    const ret = (orderId: string, item: number, mode: string, qty = 1, as: Actor = staff) => call('POST', `/api/orders/${orderId}/return`, { cookie: cookies[as],
      body: { items: [{ order_item_id: item, quantity: qty, restock: true }], reason: 'Wrong size', refund_mode: mode, idempotency_key: `rf-${b}-${Math.random().toString(36).slice(2)}` } })

    // ================= 1. split bill Cash 600 + Card 400 (2 x 500); return 1 item as Cash, on the ORIGINAL date
    const split = { payment_method: 'split', split_details: { payments: [{ method: 'cash', amount: 600 }, { method: 'card', amount: 400 }] } }
    const s1 = await sell(split)
    await q(`UPDATE orders SET created_at = now() - interval '1 day' WHERE id = $1`, [s1.order_id]) // the sale was yesterday
    const today = await sell({ payment_method: 'card' }, 1) // a bill of today, which a return must not touch
    const i1 = await line(s1.order_id)
    let o1 = await listed(s1.order_id)
    check(norm(o1.paid_by_mode) === norm({ cash: 600, card: 400 }), `${L} the split bill is paid Cash 600 + Card 400`, JSON.stringify(o1.paid_by_mode))
    const pvCash = await preview(s1.order_id, i1, 'cash'), pvOrig = await preview(s1.order_id, i1, 'original')
    check(pvCash.status === 200 && num(pvCash.body.refund_amount) === 500 && norm(pvCash.body.refunds) === norm({ cash: 500 }), `${L} preview (Cash): ₹500 all to Cash`, JSON.stringify(pvCash.body.refunds))
    check(norm(pvOrig.body.refunds) === norm({ cash: 300, card: 200 }) && sumOf(pvOrig.body.refunds) === 500, `${L} preview (Original): ₹500 split Cash 300 + Card 200 in proportion, adds up`, JSON.stringify(pvOrig.body.refunds))
    const before = modeRevenue([o1]), todayBefore = await listed(today.order_id)
    const r1 = await ret(s1.order_id, i1, 'cash')
    check(r1.status === 201 && r1.body.refund_mode === 'cash' && norm(r1.body.refunds) === norm({ cash: 500 }), `${L} return 1 of 2 refunded as Cash: refunds {cash: 500} stored`, JSON.stringify(r1.body.refunds))
    const stored = (await q(`SELECT mode, amount FROM order_return_refunds WHERE return_id = $1`, [r1.body.return_id])).map((x) => `${x.mode}=${num(x.amount)}`)
    check(JSON.stringify(stored) === JSON.stringify(['cash=500']), `${L} the refund per mode is a row in order_return_refunds (same transaction)`, JSON.stringify(stored))
    o1 = await listed(s1.order_id)
    const after = modeRevenue([o1])
    check(after.cash === before.cash - 500 && after.card === before.card && after.net === before.net - 500, `${L} Cash drops by 500, Card unchanged, Net drops by 500`, JSON.stringify({ before, after }))
    check(r2(after.cash + after.card + after.qr + after.other) === after.net, `${L} the mode amounts add up to the net exactly`)
    const todayAfter = await listed(today.order_id)
    check(norm(todayAfter.refunds_by_mode) === '{}' && num(todayAfter.returned_amount) === 0 && todayAfter.created_at === todayBefore.created_at && new Date(o1.created_at) < new Date(todayAfter.created_at) && num(o1.returned_amount) === 500,
      `${L} the refund sits on the original (yesterday's) bill; today's bills are unchanged`)

    // ================= 2. same bill shape, return with Original (SPLIT)
    const s2 = await sell(split), i2 = await line(s2.order_id)
    const r2r = await ret(s2.order_id, i2, 'original')
    check(r2r.status === 201 && norm(r2r.body.refunds) === norm({ cash: 300, card: 200 }) && sumOf(r2r.body.refunds) === num(r2r.body.refund_amount), `${L} Original (SPLIT): refund divided Cash 300 + Card 200 and adds up`, JSON.stringify(r2r.body.refunds))
    // odd amounts: the last mode takes the rounding remainder
    const s2b = await sell({ payment_method: 'split', split_details: { payments: [{ method: 'cash', amount: 333.33 }, { method: 'qr', amount: 666.67 }] } }), i2b = await line(s2b.order_id)
    const r2b = await ret(s2b.order_id, i2b, 'original')
    check(sumOf(r2b.body.refunds) === num(r2b.body.refund_amount) && num(r2b.body.refunds.cash) === 166.67 && num(r2b.body.refunds.qr) === 333.33, `${L} Original on 333.33 / 666.67: parts round to the paisa and add up exactly (last mode takes the remainder)`, JSON.stringify(r2b.body.refunds))

    // ================= 3. refunded as QR and as Other; the modes always add up to the net
    const s3 = await sell(split), i3 = await line(s3.order_id)
    const r3a = await ret(s3.order_id, i3, 'qr'), r3b = await ret(s3.order_id, i3, 'other')
    check(norm(r3a.body.refunds) === norm({ qr: 500 }) && norm(r3b.body.refunds) === norm({ other: 500 }), `${L} QR and Other refunds go to their own mode`, `${JSON.stringify(r3a.body.refunds)} ${JSON.stringify(r3b.body.refunds)}`)
    const o3 = await listed(s3.order_id), m3 = modeRevenue([o3])
    check(m3.cash === 600 && m3.card === 400 && m3.qr === -500 && m3.other === -500 && m3.net === 0 && r2(m3.cash + m3.card + m3.qr + m3.other) === m3.net, `${L} QR and Other cards each drop by 500; cards still add up to the net (0)`, JSON.stringify(m3))
    const over = await ret(s3.order_id, i3, 'cash')
    check(over.status === 400, `${L} the over-return guard still refuses a third unit of a 2-unit line`, String(over.status))
    // single-mode bill: Original = that mode
    const s4 = await sell({ payment_method: 'card' }), i4 = await line(s4.order_id)
    const r4 = await ret(s4.order_id, i4, 'original')
    check(norm(r4.body.refunds) === norm({ card: 500 }), `${L} on a single-mode (Card) bill, Original = Card`, JSON.stringify(r4.body.refunds))
    const s5 = await sell({ payment_method: 'qr' }), i5 = await line(s5.order_id)
    const pv5 = await preview(s5.order_id, i5, 'cash')
    const o5 = await listed(s5.order_id)
    check(norm(pv5.body.refunds) === norm({ cash: 500 }) && num(o5.paid_by_mode.cash || 0) === 0, `${L} a cash refund on a QR bill is allowed (the screen warns: no cash was received)`)

    // ================= 4. advance order: deposit QR 300, balance split Cash 300 + Card 400; return as Cash, then Original
    const adv = await call('POST', '/api/advance-orders', { cookie: cookies[staff], body: { customer_name: `Rf Adv ${n}`, phone: '9876500067', product_name: 'Rf', total_amount: 1000, deposit_amount: 300, expected_delivery_date: '2030-01-01', payment_method: 'upi',
      products: [{ product_id: P, name: `Rf Item ${n}`, quantity: 2, unit: 'piece', unit_type: 'unit', base_price: 500, line_total: 1000 }] } })
    const done = await call('POST', `/api/advance-orders/${adv.body.order.id}/complete`, { cookie: cookies[staff], body: { payment_method: 'cash', final_amount: 700, split_details: { payments: [{ method: 'cash', amount: 300 }, { method: 'card', amount: 400 }] } } })
    const billId = done.body.result?.order_id
    let ob = await listed(billId)
    check(done.status === 200 && norm(ob.paid_by_mode) === norm({ qr: 300, cash: 300, card: 400 }) && sumOf(ob.paid_by_mode) === num(ob.total), `${L} advance bill paid: deposit QR 300 + balance Cash 300 + Card 400 (= total)`, JSON.stringify(ob?.paid_by_mode))
    const ib = await line(billId)
    const rb1 = await ret(billId, ib, 'cash')
    check(rb1.status === 201 && norm(rb1.body.refunds) === norm({ cash: 500 }), `${L} a return on the advance bill refunded as Cash`, JSON.stringify(rb1.body))
    const rb2 = await ret(billId, ib, 'original')
    check(norm(rb2.body.refunds) === norm({ cash: 150, card: 200, qr: 150 }) && sumOf(rb2.body.refunds) === 500, `${L} Original on the advance bill divides over deposit (QR) and balance modes: QR 150 + Cash 150 + Card 200`, JSON.stringify(rb2.body.refunds))
    ob = await listed(billId)
    const mb = modeRevenue([ob])
    check(mb.net === 0 && mb.cash === 300 - 500 - 150 && mb.card === 200 && mb.qr === 150 && r2(mb.cash + mb.card + mb.qr + mb.other) === mb.net, `${L} advance bill mode totals still add up to its net`, JSON.stringify(mb))
    const advRow = ((await call('GET', '/api/advance-orders', { cookie: cookies[staff] })).body.orders as any[]).find((a) => a.id === adv.body.order.id)
    check(num(advRow.deposit_amount) === 300 && num(advRow.total_amount) === 1000 && advRow.bill_returned === true && advRow.deposit_method === 'upi', `${L} the advance order and its deposit are unchanged; "Bill returned" is set`)

    // ================= 5. Returns list: refund per mode, totals per mode by RETURN date, mode filter, branch only
    const rl = await call('GET', '/api/returns', { cookie: cookies[mgr], query: { limit: '1000' } })
    const mine = (rl.body.returns as any[]).filter((x) => [s1.order_id, s2.order_id, s2b.order_id, s3.order_id, s4.order_id, billId].includes(x.order_id))
    const exp = { cash: 0, card: 0, qr: 0, other: 0 }
    for (const x of rl.body.returns as any[]) for (const m of MODES) exp[m] += Number(x.refunds?.[m] || 0)
    check(rl.status === 200 && mine.length === 8 && mine.every((x) => sumOf(x.refunds) === num(x.refund_amount)), `${L} Returns list: every return carries its refund per mode, adding up to its amount`, String(mine.length))
    check(MODES.every((m) => r2(exp[m]) === r2(rl.body.totals[m])) && r2(MODES.reduce((s, m) => s + rl.body.totals[m], 0)) === r2(rl.body.totals.refund), `${L} Returns list totals per mode add up to the total refunded`, JSON.stringify(rl.body.totals))
    const onlyQr = await call('GET', '/api/returns', { cookie: cookies[mgr], query: { mode: 'qr', limit: '1000' } })
    check((onlyQr.body.returns as any[]).every((x) => num(x.refunds?.qr) > 0) && (onlyQr.body.returns as any[]).some((x) => x.return_id === r3a.body.return_id || x.id === r3a.body.return_id), `${L} the mode filter lists returns refunded (partly) to that mode`)
    check(!((await call('GET', '/api/returns', { cookie: cookies[`manager${other.slice(-1)}` as Actor], query: { limit: '1000' } })).body.returns as any[]).some((x) => x.order_id === s1.order_id), `${L} another branch's Returns list does not show these`)
    check((await call('GET', '/api/returns', { cookie: cookies[staff] })).status === 403, `${L} Staff cannot open the Returns list (403); Staff can return (above)`)
    check((await call('POST', `/api/orders/${s4.order_id}/return/preview`, { cookie: cookies[staff], query: { branch_id: other }, body: { items: [{ order_item_id: i4, quantity: 1 }] } })).status === 400, `${L} a forged branch_id on a return is refused`)
    const crossRet = await call('POST', `/api/orders/${s4.order_id}/return`, { cookie: cookies[`staff${other.slice(-1)}` as Actor], body: { items: [{ order_item_id: i4, quantity: 1 }], reason: 'Wrong size', refund_mode: 'cash' } })
    check(crossRet.status === 404, `${L} another branch cannot return this bill`, String(crossRet.status))

    // ================= 6. returns made before 0015 (no per-mode rows) are split at read time, nothing rewritten
    const s6 = await sell(split), i6 = await line(s6.order_id)
    const r6 = await ret(s6.order_id, i6, 'original')
    await q(`DELETE FROM order_return_refunds WHERE return_id = $1`, [r6.body.return_id]) // what an older return looks like
    const legacy = (await one(`SELECT public.return_refund_split($1, $2) AS s, refund_mode FROM order_returns WHERE id = $1`, [r6.body.return_id, b]))
    check(legacy.refund_mode === 'original' && norm(legacy.s) === norm({ cash: 300, card: 200 }), `${L} an older 'original' return is split at read time from the bill's modes`, JSON.stringify(legacy.s))
    await q(`UPDATE order_returns SET refund_mode = 'cash' WHERE id = $1`, [r6.body.return_id])
    check(norm((await one(`SELECT public.return_refund_split($1, $2) AS s`, [r6.body.return_id, b])).s) === norm({ cash: 500 }), `${L} an older 'cash' return reads as Cash`)

    // ================= 7. Order History row: coupon code and delivery stored and listed; a plain bill shows neither
    await q(`INSERT INTO coupons (code, percentage, branch_id) VALUES ($1, 10, $2)`, [`RFC${n}`, b])
    const s7 = await sell({ coupon_code: `RFC${n}`, coupon_percentage: 10, discount_amount: 100, delivery_charge: 40 })
    const o7 = await listed(s7.order_id), o7p = await listed(today.order_id)
    check(o7.coupon_code === `RFC${n}` && num(o7.discount_amount) === 100 && num(o7.delivery_charge) === 40 && num(o7.coupon_percentage) === 10, `${L} Order History row has coupon RFC${n} (10 %), discount 100, delivery 40`)
    check(!o7p.coupon_code && num(o7p.delivery_charge) === 0 && num(o7p.discount_amount) === 0, `${L} a bill without them shows none`)
  }
}
