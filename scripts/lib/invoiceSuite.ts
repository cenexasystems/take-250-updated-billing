// Invoice breakdown, split payment and return details, written once and run by scripts/test-api.ts (TEST database,
// inside its rolled-back transaction) and by the in-memory-Postgres harness. Every check runs for pos1, pos2 and pos3.
// It checks the STORED bill (what the cashier entered), the invoice extras the API adds (returns, advance payments) and
// the shared invoice data (src/lib/invoiceDoc.ts) every output draws: rows present / absent and amounts adding up.
import { invoiceDocFromBill, type InvoiceDoc } from '../../src/lib/invoiceDoc'
import type { Actor, ReturnsCtx } from './returnsSuite'

export type InvoiceCtx = Omit<ReturnsCtx, 'concurrent'>

const r2 = (v: number) => Math.round(v * 100) / 100
/** Subtotal - discounts + taxes + delivery = TOTAL (taxable amount is information, not added) */
export const rowsAddUp = (d: InvoiceDoc) => Math.abs(r2(d.rows.reduce((s, r) => s + (r.kind === 'discount' ? -r.amount : r.kind === 'taxable' ? 0 : r.amount), 0)) - d.total) <= 0.01

export async function invoiceSuite(c: InvoiceCtx) {
  const { call, q, check, cookies } = c
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0]
  const num = (v: unknown) => Number(v)

  for (const b of c.branches.filter((x) => !c.only || x === c.only)) {
    const n = b.slice(-1)
    const staff = `staff${n}` as Actor, mgr = `manager${n}` as Actor
    const other = c.branches.find((x) => x !== b)!
    const L = `[${b}] invoice:`
    const P = num((await one(`INSERT INTO products (name, category, price, stock_quantity, stock, branch_id, is_active) VALUES ($1, 'Inv Cat', 400, 100, 100, $2, true) RETURNING id`, [`Inv Item ${n}`, b])).id)
    const sell = async (extra: Record<string, unknown>, qty = 3) => {
      const r = await call('POST', '/api/pos/sale', { cookie: cookies[staff], body: {
        customer_name: `Inv Customer ${n}`, phone: '9876500077', payment_method: 'cash',
        items: [{ product_id: P, quantity: qty, unit_price: 400, line_total: 400 * qty, name: `Inv Item ${n}` }], ...extra } })
      if (r.status !== 201) check(false, `${L} fixture sale`, `${r.status} ${JSON.stringify(r.body)}`)
      return r.body as { order_id: string; invoice_no: string }
    }
    const detail = async (id: string, as: Actor = staff) => (await call('GET', `/api/orders/${id}`, { cookie: cookies[as] })).body
    const docOf = async (id: string) => { const d = await detail(id); return invoiceDocFromBill(d.order, d.items, d.extras) }

    // ================= 1. manual discount + GST: stored as entered, every row shown, adds up
    // ₹1,200 - 10 % manual (₹120) = ₹1,080 taxable; GST 5 % = ₹54 -> CGST 27 + SGST 27; total ₹1,134
    const s1 = await sell({ manual_discount_amount: 120, manual_discount_type: 'percent', manual_discount_value: 10, total_gst: 54, gst_enabled: true })
    const o1 = await one(`SELECT subtotal, manual_discount_amount m, manual_discount_type t, manual_discount_value v, total_gst g, taxable_amount tx, cgst_amount cg, sgst_amount sg, total FROM orders WHERE id = $1`, [s1.order_id])
    check(num(o1.subtotal) === 1200 && num(o1.m) === 120 && o1.t === 'percent' && num(o1.v) === 10 && num(o1.g) === 54 && num(o1.tx) === 1080 && num(o1.cg) === 27 && num(o1.sg) === 27 && num(o1.total) === 1134,
      `${L} the bill stores what the cashier entered (subtotal 1200, manual 10 % = 120, taxable 1080, CGST 27 + SGST 27, total 1134)`, JSON.stringify(o1))
    const d1 = await docOf(s1.order_id)
    const lab1 = d1.rows.map((r) => `${r.label}=${r.amount}`)
    check(JSON.stringify(lab1) === JSON.stringify(['Subtotal=1200', 'Discount (Manual, 10%)=120', 'Taxable amount=1080', 'CGST @ 2.5%=27', 'SGST @ 2.5%=27']) && d1.total === 1134,
      `${L} rows: Subtotal, Discount (Manual, 10%), Taxable amount, CGST @ 2.5%, SGST @ 2.5%, TOTAL 1134`, lab1.join(' | '))
    check(rowsAddUp(d1), `${L} Subtotal - Discount + CGST + SGST = TOTAL`)
    check(!d1.payment.split && d1.payment.label === 'Cash' && !d1.returns && !d1.advance, `${L} single payment "Cash", no return or advance block`)

    // ================= 2. coupon discount bill shows the code (and percentage)
    await q(`INSERT INTO coupons (code, percentage, branch_id) VALUES ($1, 10, $2)`, [`INVC${n}`, b])
    const s2 = await sell({ coupon_code: `INVC${n}`, coupon_percentage: 10, discount_amount: 120, delivery_charge: 50 })
    const d2 = await docOf(s2.order_id)
    check(d2.rows.some((r) => r.label === `Discount (Coupon INVC${n}, 10%)` && r.amount === 120) && d2.rows.some((r) => r.label === 'Delivery' && r.amount === 50) && !d2.rows.some((r) => r.kind === 'taxable' || r.kind === 'tax'),
      `${L} coupon bill: "Discount (Coupon INVC${n}, 10%)" and Delivery, no tax rows`, d2.rows.map((r) => r.label).join(' | '))
    check(rowsAddUp(d2) && d2.total === 1130, `${L} coupon bill adds up (1200 - 120 + 50 = 1130)`, String(d2.total))

    // ================= 3. split payment: each mode and amount, adding up to the total
    const s3 = await sell({ payment_method: 'split', split_details: { payments: [{ method: 'cash', amount: 500 }, { method: 'qr', amount: 700 }] } })
    const d3 = await docOf(s3.order_id)
    check(d3.payment.split && JSON.stringify(d3.payment.parts) === JSON.stringify([{ label: 'Cash', amount: 500 }, { label: 'QR', amount: 700 }]), `${L} split bill: Payment (Split) Cash 500 + QR 700`, JSON.stringify(d3.payment))
    check(r2(d3.payment.parts.reduce((s, p) => s + p.amount, 0)) === d3.total, `${L} split parts add up to the total`)

    // ================= 4. plain bill: exactly Subtotal + TOTAL, single payment
    const s4 = await sell({}, 1)
    const d4 = await docOf(s4.order_id)
    check(d4.rows.length === 1 && d4.rows[0].kind === 'subtotal' && d4.total === 400 && !d4.payment.split && !d4.returns && d4.items.every((l) => !l.returnNote), `${L} a bill without discount, tax or returns has only Subtotal and TOTAL (as before)`, JSON.stringify(d4.rows))

    // ================= 5. returns: 1 of 3, then 2 of 3, then all
    const s5 = await sell({})
    const line = num((await one(`SELECT id FROM order_items WHERE order_id = $1`, [s5.order_id])).id)
    const ret = (qty: number, restock = true) => call('POST', `/api/orders/${s5.order_id}/return`, { cookie: cookies[staff], body: { items: [{ order_item_id: line, quantity: qty, restock }], reason: 'Wrong size', idempotency_key: `inv-${b}-${Math.random().toString(36).slice(2)}` } })
    check((await ret(1)).status === 201, `${L} fixture: first return (1 unit)`)
    let d5 = await docOf(s5.order_id)
    const rec1 = (await one(`SELECT return_no FROM order_returns WHERE order_id = $1`, [s5.order_id])).return_no
    check(d5.items[0].returnNote === 'Returned 1 of 3', `${L} the line says "Returned 1 of 3"`, String(d5.items[0].returnNote))
    check(d5.returns?.badge === 'PARTIALLY RETURNED: 1 of 3 items' && d5.returns.records.length === 1 && d5.returns.records[0].startsWith(`${rec1}, `), `${L} status line "PARTIALLY RETURNED: 1 of 3 items" and "${rec1}, <date>"`, JSON.stringify(d5.returns))
    check(d5.total === 1200 && d5.returns?.returned === 400 && d5.returns?.net === 800 && d5.rows[0].amount === 1200, `${L} TOTAL stays 1200; Returned 400, Net amount 800`, JSON.stringify(d5.returns))
    check((await ret(1, false)).status === 201, `${L} fixture: second return (1 unit, damaged)`)
    d5 = await docOf(s5.order_id)
    check(d5.items[0].returnNote === 'Returned 2 of 3 (damaged)' && d5.returns?.badge === 'PARTIALLY RETURNED: 2 of 3 items' && d5.returns.records.length === 2 && d5.returns.net === 400, `${L} after the second return: "Returned 2 of 3 (damaged)", 2 of 3 items, two return numbers, net 400`, `${d5.items[0].returnNote} / ${JSON.stringify(d5.returns)}`)
    check((await ret(1)).status === 201, `${L} fixture: last unit returned`)
    d5 = await docOf(s5.order_id)
    check(d5.returns?.badge === 'RETURNED' && d5.items[0].returnNote === 'Returned 3 of 3 (damaged)' && d5.returns.net === 0, `${L} a full return shows RETURNED, "Returned 3 of 3", net 0`, `${d5.returns?.badge} ${d5.items[0].returnNote}`)
    // staff sees quantities and amounts only, no cost / purchase prices
    const sd = await detail(s5.order_id, staff)
    check(!JSON.stringify(sd.extras).match(/purchase|cost/i), `${L} the invoice extras carry no cost or purchase price`)
    check((await call('GET', `/api/orders/${s5.order_id}`, { cookie: cookies[`staff${other.slice(-1)}` as Actor] })).status === 404, `${L} another branch cannot read this bill or its returns`)
    // the public digital invoice carries the same extras
    const pub = await call('GET', `/api/public/invoice/${s5.invoice_no}`, {})
    check(pub.status === 200 && pub.body.extras?.returns?.records?.length === 3 && pub.body.extras.returns.items[0].returned === 3, `${L} the digital invoice gets the same return details`, JSON.stringify(pub.body.extras))

    // ================= 6. advance order: deposit, completed with a manual discount and a split balance
    // total 1000, deposit 300 -> balance 700; manual discount 100 -> 600 paid as Cash 250 + Card 350
    const adv = await call('POST', '/api/advance-orders', { cookie: cookies[staff], body: { customer_name: `Inv Adv ${n}`, phone: '9876500078', product_name: 'Custom blouse', total_amount: 1000, deposit_amount: 300, expected_delivery_date: '2030-01-01', payment_method: 'upi' } })
    const aid = adv.body.order?.id
    const badSplit = await call('POST', `/api/advance-orders/${aid}/complete`, { cookie: cookies[mgr], body: { payment_method: 'cash', final_amount: 600, manual_discount: 100, split_details: { payments: [{ method: 'cash', amount: 250 }, { method: 'card', amount: 300 }] } } })
    check(badSplit.status === 400 && /add up/.test(badSplit.body.error), `${L} a split balance that does not add up is refused (nothing completed)`, `${badSplit.status} ${badSplit.body.error}`)
    const done = await call('POST', `/api/advance-orders/${aid}/complete`, { cookie: cookies[mgr], body: { payment_method: 'cash', final_amount: 600, manual_discount: 100, split_details: { payments: [{ method: 'cash', amount: 250 }, { method: 'card', amount: 350 }] } } })
    check(done.status === 200, `${L} advance order completed with a manual discount and a split balance`, `${done.status} ${done.body.error ?? ''}`)
    const billId = done.body.result?.order_id
    const ob = await one(`SELECT subtotal, manual_discount_amount m, total, payment_method pm, split_details sd FROM orders WHERE id = $1`, [billId])
    check(num(ob.subtotal) === 1000 && num(ob.m) === 100 && num(ob.total) === 900 && ob.pm === 'split' && ob.sd?.payments?.length === 2, `${L} the final bill stores subtotal 1000, manual 100, total 900 and the split`, JSON.stringify(ob))
    const d6 = await docOf(billId)
    check(JSON.stringify(d6.rows.map((r) => `${r.label}=${r.amount}`)) === JSON.stringify(['Subtotal=1000', 'Discount (Manual)=100']) && d6.total === 900 && rowsAddUp(d6), `${L} final invoice: Subtotal 1000, Discount (Manual) 100, TOTAL 900 (it used to show Subtotal = TOTAL)`, JSON.stringify(d6.rows))
    check(d6.advance?.deposits.length === 1 && d6.advance.deposits[0].amount === 300 && /^Advance paid \(.+, QR\)$/.test(d6.advance.deposits[0].label), `${L} the deposit is listed with its date and mode (QR)`, JSON.stringify(d6.advance?.deposits))
    check(d6.advance?.balance?.amount === 600 && d6.advance.balance.label === 'Balance paid at completion (Split)' && JSON.stringify(d6.advance.balance.parts) === JSON.stringify([{ label: 'Cash', amount: 250 }, { label: 'Card', amount: 350 }]), `${L} balance paid at completion 600, split Cash 250 + Card 350`, JSON.stringify(d6.advance?.balance))
    check(r2((d6.advance?.deposits[0].amount ?? 0) + (d6.advance?.balance?.amount ?? 0)) === d6.total, `${L} deposit + balance = TOTAL`)
    const finalLabel = (await one(`SELECT final_payment_method f FROM advance_orders WHERE id = $1`, [aid])).f
    check(/^Split \(Cash ₹250 \+ Card ₹350\)$/.test(finalLabel), `${L} the advance order keeps the readable split label`, finalLabel)
  }
}
