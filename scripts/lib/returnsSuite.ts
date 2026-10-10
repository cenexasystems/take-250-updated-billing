// Order-return tests, written once and run by two drivers: scripts/test-api.ts (the TEST database, inside its rolled-back
// transaction) and the in-memory-Postgres harness. Everything is branch-driven: every check runs for pos1, pos2 and pos3.
export type Actor = 'admin' | 'manager1' | 'manager2' | 'manager3' | 'staff1' | 'staff2' | 'staff3'
export interface ReturnsCtx {
  branches: readonly string[]
  cookies: Record<Actor, string>
  call: (method: string, path: string, o?: { cookie?: string; body?: unknown; query?: Record<string, string> }) => Promise<{ status: number; body: any }>
  q: (sql: string, params?: unknown[]) => Promise<any[]>
  check: (ok: boolean, label: string, detail?: string) => void
  /** false when requests share one transaction (test-api's savepoints): the race test then runs one after the other */
  concurrent: boolean
  /** run for this branch only (the other branches are still used as the "foreign" branch) */
  only?: string
}

const day = (offset: number) => { const d = new Date(Date.now() + offset * 86400000); return d.toISOString().slice(0, 10) }

export async function returnsSuite(c: ReturnsCtx) {
  const { call, q, check, cookies } = c
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0]
  const num = (v: unknown) => Number(v)
  const FAKE = '00000000-0000-4000-8000-000000000000'

  for (const b of c.branches.filter((x) => !c.only || x === c.only)) {
    const n = b.slice(-1)
    const staff = `staff${n}` as Actor, mgr = `manager${n}` as Actor
    const other = c.branches.find((x) => x !== b)!
    const otherStaff = `staff${other.slice(-1)}` as Actor
    const asAdmin = { cookie: cookies.admin, query: { branch_id: b } }
    const L = `[${b}]`

    // ---- fixtures: two products (₹400 and ₹300), one product with a variant
    const mk = async (name: string, price: number, stock: number) =>
      num((await one(`INSERT INTO products (name, category, price, stock_quantity, stock, branch_id, is_active) VALUES ($1, 'Ret Cat', $2, $3::numeric, $3::int, $4, true) RETURNING id`, [name, price, stock, b])).id)
    const A = await mk(`Ret A ${n}`, 400, 10), B = await mk(`Ret B ${n}`, 300, 10)
    const PV = await mk(`Ret V ${n}`, 200, 0)
    const V = (await one(`INSERT INTO product_variants (product_id, variant_name, price, stock, branch_id, is_active) VALUES ($1, 'Large', 200, 6, $2, true) RETURNING id`, [PV, b])).id
    await q(`UPDATE products SET has_variants = true, stock_quantity = 6, stock = 6 WHERE id = $1`, [PV])
    const stock = async (id: number) => num((await one(`SELECT stock_quantity::numeric s FROM products WHERE id = $1`, [id])).s)
    const vstock = async () => num((await one(`SELECT stock::numeric s FROM product_variants WHERE id = $1`, [V])).s)
    const sell = async (extra: Record<string, unknown> = {}, items?: unknown[]) => {
      const r = await call('POST', '/api/pos/sale', { cookie: cookies[staff], body: {
        customer_name: 'Ret Customer', phone: '9876543210', payment_method: 'cash',
        items: items ?? [{ product_id: A, quantity: 1, unit_price: 400, name: `Ret A ${n}` }, { product_id: B, quantity: 2, unit_price: 300, name: `Ret B ${n}` }], ...extra } })
      if (r.status !== 201) check(false, `${L} fixture sale`, `status ${r.status} ${JSON.stringify(r.body)}`)
      return r.body as { order_id: string; invoice_no: string }
    }
    const items = async (orderId: string) => (await q(`SELECT id, name, quantity::numeric q, line_total::numeric lt FROM order_items WHERE order_id = $1 ORDER BY id`, [orderId])).map((x) => ({ id: num(x.id), name: x.name as string, q: num(x.q), lt: num(x.lt) }))
    const key = () => `ret-${Math.random().toString(36).slice(2)}-${Date.now()}`
    const ret = (as: Actor, orderId: string, lines: Array<{ order_item_id: number; quantity: number; restock?: boolean }>, extra: Record<string, unknown> = {}, adminQuery = false) =>
      call('POST', `/api/orders/${orderId}/return`, { cookie: cookies[as], query: adminQuery ? { branch_id: b } : undefined,
        body: { items: lines.map((l) => ({ restock: true, ...l })), reason: 'Wrong size', idempotency_key: key(), ...extra } })

    // ================= 1. partial return, ₹1,000 bill: 1 of the 2 B units
    const s1 = await sell()
    const i1 = await items(s1.order_id); const ia = i1.find((x) => x.name.startsWith('Ret A'))!, ib = i1.find((x) => x.name.startsWith('Ret B'))!
    const o1 = await one(`SELECT total::numeric t, invoice_no, created_at FROM orders WHERE id = $1`, [s1.order_id])
    check(num(o1.t) === 1000, `${L} the fixture bill is ₹1,000`, String(o1.t))
    const aBefore = await stock(A), bBefore = await stock(B)
    const pv = await call('POST', `/api/orders/${s1.order_id}/return/preview`, { cookie: cookies[staff], body: { items: [{ order_item_id: ib.id, quantity: 1 }] } })
    check(pv.status === 200 && num(pv.body.refund_amount) === 300, `${L} the preview (SQL) says ₹300 for 1 of 2 B units`, JSON.stringify(pv.body))
    check((await stock(B)) === bBefore && (await q(`SELECT 1 FROM order_returns WHERE order_id = $1`, [s1.order_id])).length === 0, `${L} the preview wrote nothing`)
    const r1 = await ret(staff, s1.order_id, [{ order_item_id: ib.id, quantity: 1 }])
    check(r1.status === 201 && num(r1.body.refund_amount) === 300 && r1.body.order_status === 'partially_returned', `${L} STAFF returns 1 of 2: refund 300, status partially_returned`, JSON.stringify(r1.body).slice(0, 200))
    check((await stock(B)) === bBefore + 1 && (await stock(A)) === aBefore, `${L} only item B was restocked (+1), item A untouched`)
    check(/^RET-POS\d-\d{6}$/.test(r1.body.return_no) && r1.body.return_no.startsWith(`RET-POS${n}-`) && r1.body.invoice_no === o1.invoice_no, `${L} return number is RET-POS${n}-nnnnnn and names the original invoice ${o1.invoice_no}`, r1.body.return_no)
    const mv = await q(`SELECT movement_type, quantity_delta::numeric d, quantity_before::numeric b, quantity_after::numeric a, created_by_name, reference_type, reference_id FROM inventory_movements WHERE reference_id = $1`, [r1.body.return_no])
    check(mv.length === 1 && mv[0].movement_type === 'RETURN' && num(mv[0].d) === 1 && num(mv[0].a) === bBefore + 1 && mv[0].created_by_name === 'staff' && mv[0].reference_type === 'order_return', `${L} one RETURN ledger row (+1) written by role staff, referencing the return`, JSON.stringify(mv))
    const o1b = await one(`SELECT total::numeric t, invoice_no, status, returned_amount::numeric ra, created_at FROM orders WHERE id = $1`, [s1.order_id])
    check(num(o1b.t) === 1000 && o1b.invoice_no === o1.invoice_no && num(o1b.ra) === 300 && o1b.status === 'partially_returned' && String(o1b.created_at) === String(o1.created_at), `${L} the original bill keeps its number, total and date; only status and returned_amount moved`)
    check((await items(s1.order_id)).map((x) => `${x.name}:${x.q}:${x.lt}`).join() === i1.map((x) => `${x.name}:${x.q}:${x.lt}`).join(), `${L} the original bill lines are unchanged`)
    // -- Return modal data for Staff: lines, bought + returned only
    const info = await call('GET', `/api/orders/${s1.order_id}/returns`, { cookie: cookies[staff] })
    const bl = info.body.items?.find((x: any) => x.order_item_id === ib.id)
    check(info.status === 200 && bl?.quantity === 2 && bl?.returned_quantity === 1 && info.body.returns.length === 1, `${L} GET /returns: bought 2, returned 1, history of 1 return`)
    check(info.body.items.every((x: any) => Object.keys(x).sort().join() === 'is_manual,name,order_item_id,quantity,returned_quantity,variant_name'), `${L} the modal endpoint carries no prices or customer data`)
    // -- over-return
    const bad = await ret(staff, s1.order_id, [{ order_item_id: ib.id, quantity: 2 }])
    check(bad.status === 400 && /only 1 left/.test(bad.body.error), `${L} returning 2 when 1 is left is rejected`, JSON.stringify(bad.body))
    check((await stock(B)) === bBefore + 1, `${L} the rejected return changed no stock`)
    // -- status of a part-returned bill cannot be edited
    check((await call('PATCH', `/api/orders/${s1.order_id}/status`, { cookie: cookies[mgr], body: { status: 'pending' } })).status === 409, `${L} a part-returned bill's status is frozen (409)`)
    // -- second return finishes the bill
    const r2 = await ret(mgr, s1.order_id, [{ order_item_id: ib.id, quantity: 1 }, { order_item_id: ia.id, quantity: 1 }])
    check(r2.status === 201 && num(r2.body.refund_amount) === 700 && r2.body.order_status === 'returned', `${L} MANAGER returns the rest: 700, status returned`, JSON.stringify(r2.body).slice(0, 200))
    check(num((await one(`SELECT returned_amount::numeric ra FROM orders WHERE id = $1`, [s1.order_id])).ra) === 1000, `${L} total refunded is exactly the ₹1,000 paid`)
    check((await stock(A)) === aBefore + 1 && (await stock(B)) === bBefore + 2, `${L} stock is fully back (A +1, B +2)`)
    check((await ret(staff, s1.order_id, [{ order_item_id: ia.id, quantity: 1 }])).status === 400, `${L} a fully returned bill cannot be returned again`)

    // ================= 2. double submit
    const s2 = await sell(); const i2 = await items(s2.order_id); const b2 = i2.find((x) => x.name.startsWith('Ret B'))!
    const k2 = key(); const bb = await stock(B)
    const d1 = await ret(staff, s2.order_id, [{ order_item_id: b2.id, quantity: 1 }], { idempotency_key: k2 })
    const d2 = await ret(staff, s2.order_id, [{ order_item_id: b2.id, quantity: 1 }], { idempotency_key: k2 })
    check(d1.status === 201 && d2.status === 201 && d2.body.return_no === d1.body.return_no && d2.body.replayed === true, `${L} the same key twice returns the FIRST return`, JSON.stringify([d1.status, d2.status, d2.body.replayed]))
    check((await stock(B)) === bb + 1 && num((await one(`SELECT count(*)::int n FROM order_returns WHERE order_id = $1`, [s2.order_id])).n) === 1 && num((await one(`SELECT count(*)::int n FROM inventory_movements WHERE reference_id = $1`, [d1.body.return_no])).n) === 1, `${L} double submit: stock +1 once, one return row, one ledger row`)
    // two different keys racing for the LAST unit: exactly one wins
    const raceA = () => ret(staff, s2.order_id, [{ order_item_id: b2.id, quantity: 1 }]), raceB = () => ret(mgr, s2.order_id, [{ order_item_id: b2.id, quantity: 1 }])
    const race = c.concurrent ? await Promise.all([raceA(), raceB()]) : [await raceA(), await raceB()]
    check(race.filter((r) => r.status === 201).length === 1 && race.filter((r) => r.status === 400).length === 1 && (await stock(B)) === bb + 2, `${L} two simultaneous returns of the last unit: one wins, the other is refused, stock +1`, JSON.stringify(race.map((r) => r.status)))

    // ================= 3. damaged item: no stock, DAMAGE row
    const s3 = await sell(); const i3 = await items(s3.order_id); const a3 = i3.find((x) => x.name.startsWith('Ret A'))!
    const aa = await stock(A)
    const dm = await ret(staff, s3.order_id, [{ order_item_id: a3.id, quantity: 1, restock: false }], { reason: 'Defective / damaged' })
    check(dm.status === 201 && num(dm.body.refund_amount) === 400 && (await stock(A)) === aa, `${L} a damaged return refunds ₹400 but adds no stock`, JSON.stringify(dm.body).slice(0, 160))
    const dmv = await q(`SELECT movement_type, quantity_delta::numeric d FROM inventory_movements WHERE reference_id = $1`, [dm.body.return_no])
    check(dmv.length === 1 && dmv[0].movement_type === 'DAMAGE' && num(dmv[0].d) === 0, `${L} a DAMAGE ledger row, no RETURN row`, JSON.stringify(dmv))

    // ================= 4. discounted + coupon + GST bill: refunds are proportional and add up to what was paid
    const cc0 = num((await one(`SELECT usage_count FROM coupons WHERE branch_id = $1 AND upper(code) = 'RETC${n}'`, [b]))?.usage_count ?? -1)
    if (cc0 < 0) await q(`INSERT INTO coupons (code, percentage, branch_id) VALUES ($1, 10, $2)`, [`RETC${n}`, b])
    const u0 = num((await one(`SELECT usage_count FROM coupons WHERE branch_id = $1 AND upper(code) = $2`, [b, `RETC${n}`])).usage_count)
    const s4 = await sell({ coupon_code: `RETC${n}`, coupon_percentage: 10, discount_amount: 100, total_gst: 90, gst_enabled: true })
    const o4 = await one(`SELECT total::numeric t FROM orders WHERE id = $1`, [s4.order_id])
    check(num(o4.t) === 990, `${L} the discounted bill (₹1,000 - ₹100 coupon + ₹90 GST) totals ₹990`, String(o4.t))
    check(num((await one(`SELECT usage_count FROM coupons WHERE branch_id = $1 AND upper(code) = $2`, [b, `RETC${n}`])).usage_count) === u0 + 1, `${L} the sale used the coupon once`)
    const i4 = await items(s4.order_id); const a4 = i4.find((x) => x.name.startsWith('Ret A'))!, b4 = i4.find((x) => x.name.startsWith('Ret B'))!
    const p4 = await ret(staff, s4.order_id, [{ order_item_id: b4.id, quantity: 1 }])
    check(p4.status === 201 && num(p4.body.refund_amount) === 297, `${L} 1 of 2 B units on the discounted bill refunds ₹297.00 (share of coupon discount and GST)`, JSON.stringify(p4.body).slice(0, 160))
    check(num((await one(`SELECT usage_count FROM coupons WHERE branch_id = $1 AND upper(code) = $2`, [b, `RETC${n}`])).usage_count) === u0 + 1, `${L} a part return keeps the coupon use`)
    const p4b = await ret(mgr, s4.order_id, [{ order_item_id: b4.id, quantity: 1 }, { order_item_id: a4.id, quantity: 1 }])
    check(p4b.status === 201 && num(p4b.body.refund_amount) === 693 && p4b.body.order_status === 'returned', `${L} the rest refunds ₹693: ₹990 in total, never more than was paid`, JSON.stringify(p4b.body).slice(0, 160))
    check(num((await one(`SELECT returned_amount::numeric ra, total::numeric t FROM orders WHERE id = $1`, [s4.order_id])).ra) === 990, `${L} returned_amount equals the bill total`)
    check(num((await one(`SELECT usage_count FROM coupons WHERE branch_id = $1 AND upper(code) = $2`, [b, `RETC${n}`])).usage_count) === u0, `${L} a FULL return frees the coupon use, once`)

    // ================= 5. yesterday's sales reduce, today's do not
    const s5 = await sell({ billing_date: day(-1) }); const i5 = await items(s5.order_id)
    const todayNet = async () => num((await one(`SELECT COALESCE(sum(total - returned_amount), 0)::numeric s FROM orders WHERE branch_id = $1 AND created_at::date = CURRENT_DATE AND lower(status) <> 'cancelled'`, [b])).s)
    const yNet = async () => num((await one(`SELECT COALESCE(sum(total - returned_amount), 0)::numeric s FROM orders WHERE branch_id = $1 AND created_at::date = CURRENT_DATE - 1 AND lower(status) <> 'cancelled'`, [b])).s)
    const t0 = await todayNet(), y0 = await yNet()
    const y1 = await ret(staff, s5.order_id, [{ order_item_id: i5.find((x) => x.name.startsWith('Ret A'))!.id, quantity: 1 }])
    check(y1.status === 201 && num(y1.body.refund_amount) === 400, `${L} return of yesterday's bill refunds ₹400`)
    check((await yNet()) === y0 - 400 && (await todayNet()) === t0, `${L} YESTERDAY's net sales fell by 400 and TODAY's did not change (no negative sale on the return date)`, `${y0}->${await yNet()}, ${t0}->${await todayNet()}`)
    check(num((await one(`SELECT count(*)::int n FROM orders WHERE branch_id = $1 AND total < 0`, [b])).n) === 0, `${L} no negative bill exists`)
    const an = await call('GET', '/api/analytics/orders', { cookie: cookies.admin, query: { branch_id: b } })
    const arow = an.body.orders?.find((x: any) => x.id === s5.order_id)
    check(an.status === 200 && !!arow && num(arow.returned_amount) === 400 && num(arow.total) === 1000, `${L} the analytics feed carries total 1000 and returned_amount 400 on the ORIGINAL bill`)

    // ================= 6. variant item restocks the variant and its parent
    const sv = await sell({}, [{ product_id: PV, variant_id: V, quantity: 2, unit_price: 200, name: `Ret V ${n}` }])
    const iv = (await items(sv.order_id))[0]; const vb = await vstock()
    const rv = await ret(staff, sv.order_id, [{ order_item_id: iv.id, quantity: 1 }])
    check(rv.status === 201 && (await vstock()) === vb + 1 && (await stock(PV)) === vb + 1, `${L} a variant return restocks the variant (+1) and the parent total`, JSON.stringify(rv.body).slice(0, 120))
    check(num((await one(`SELECT count(*)::int n FROM inventory_movements WHERE reference_id = $1 AND variant_id = $2 AND movement_type = 'RETURN'`, [rv.body.return_no, V])).n) === 1, `${L} the variant RETURN row names the variant`)

    // ================= 7. delete after returns never restocks twice
    const s7 = await sell(); const i7 = await items(s7.order_id); const b7 = i7.find((x) => x.name.startsWith('Ret B'))!
    const bs = await stock(B)           // after the sale (-2)
    await ret(staff, s7.order_id, [{ order_item_id: b7.id, quantity: 1 }])
    check((await stock(B)) === bs + 1, `${L} part return: B +1`)
    const del = await call('DELETE', `/api/orders/${s7.order_id}`, asAdmin)
    check(del.status === 200 && (await stock(B)) === bs + 2, `${L} the Admin deleting the part-returned bill restocks only the unreturned unit (B ends +2, not +3)`, `stock ${await stock(B)} vs ${bs + 2}`)
    const s8 = await sell(); const i8 = await items(s8.order_id)
    const bs8 = await stock(B), as8 = await stock(A)
    await ret(staff, s8.order_id, i8.map((x) => ({ order_item_id: x.id, quantity: x.q })))
    const del8 = await call('DELETE', `/api/orders/${s8.order_id}`, asAdmin)
    check(del8.status === 200 && (await stock(B)) === bs8 + 2 && (await stock(A)) === as8 + 1, `${L} deleting a fully returned bill restocks nothing more`)

    // ================= 8. who may do what
    const s9 = await sell(); const i9 = await items(s9.order_id)
    check((await call('POST', `/api/orders/${s9.order_id}/cancel`, { cookie: cookies[staff], body: {} })).status === 404, `${L} there is no cancel endpoint`)
    check((await call('DELETE', `/api/orders/${s9.order_id}`, { cookie: cookies[staff] })).status === 403 && (await call('DELETE', `/api/orders/${s9.order_id}`, { cookie: cookies[mgr] })).status === 403, `${L} Staff and Manager cannot delete a bill`)
    check((await call('PATCH', `/api/orders/${s9.order_id}/status`, { cookie: cookies[staff], body: { status: 'pending' } })).status === 403, `${L} Staff cannot change a status`)
    check((await call('PATCH', `/api/orders/${s9.order_id}/status`, { cookie: cookies[mgr], body: { status: 'cancelled' } })).status === 400, `${L} nobody can set Cancelled`)
    const xb = await call('POST', `/api/orders/${s9.order_id}/return`, { cookie: cookies[otherStaff], body: { items: [{ order_item_id: i9[0].id, quantity: 1 }], reason: 'Wrong size' } })
    check(xb.status === 404, `${L} another branch's staff gets 404 on this bill's return`, String(xb.status))
    check((await call('GET', `/api/orders/${s9.order_id}/returns`, { cookie: cookies[otherStaff] })).status === 404 && (await call('POST', `/api/orders/${s9.order_id}/return/preview`, { cookie: cookies[otherStaff], body: { items: [{ order_item_id: i9[0].id, quantity: 1 }] } })).status === 404, `${L} nor can it read or preview it`)
    check((await call('POST', `/api/orders/${s9.order_id}/return`, { cookie: cookies[staff], query: { branch_id: other }, body: { items: [{ order_item_id: i9[0].id, quantity: 1 }], reason: 'Wrong size' } })).status === 400, `${L} a forged ?branch_id is refused`)
    check((await call('POST', `/api/orders/${s9.order_id}/return`, { cookie: cookies[staff], body: { branch_id: other, items: [{ order_item_id: i9[0].id, quantity: 1 }], reason: 'Wrong size' } })).status === 400, `${L} a branch_id in the body is refused`)
    check((await call('POST', `/api/orders/${s9.order_id}/return`, { cookie: cookies[staff], body: { items: [{ order_item_id: i9[0].id, quantity: 1 }], reason: '' } })).status === 400, `${L} a reason is required`)
    check((await call('POST', `/api/orders/${s9.order_id}/return`, { cookie: cookies[staff], body: { items: [{ order_item_id: i9[0].id, quantity: -1 }], reason: 'Wrong size' } })).status === 400, `${L} a negative quantity is refused`)
    check((await call('POST', `/api/orders/${s9.order_id}/return`, { body: { items: [{ order_item_id: i9[0].id, quantity: 1 }], reason: 'Wrong size' } })).status === 401, `${L} a return needs a session`)
    const foreignItem = await one(`SELECT id FROM order_items WHERE branch_id <> $1 LIMIT 1`, [b])
    if (foreignItem) check((await ret(staff, s9.order_id, [{ order_item_id: num(foreignItem.id), quantity: 1 }])).status === 400, `${L} an item of ANOTHER bill (another branch) cannot be returned through this one`)
    const ad = await ret('admin', s9.order_id, [{ order_item_id: i9[0].id, quantity: 1 }], {}, true)
    check(ad.status === 201, `${L} ADMIN (on this branch) can return`, JSON.stringify(ad.body).slice(0, 120))
    const pend = await sell({ status: 'pending' }); const ip = await items(pend.order_id)
    check((await ret(staff, pend.order_id, [{ order_item_id: ip[0].id, quantity: 1 }])).status === 400, `${L} a pending bill cannot be returned`)
    check((await call('POST', `/api/orders/${FAKE}/return`, { cookie: cookies[staff], body: { items: [{ order_item_id: 1, quantity: 1 }], reason: 'Wrong size' } })).status === 404, `${L} an unknown bill is a 404`)

    // ================= 9. the ledger: Manager and Admin see RETURN rows, Staff has no ledger
    const lm = await call('GET', '/api/inventory/movements', { cookie: cookies[mgr], query: { movement_type: 'RETURN', product_id: String(B) } })
    check(lm.status === 200 && lm.body.movements.some((m: any) => m.reference_id === r1.body.return_no && m.movement_type === 'RETURN'), `${L} Manager sees the RETURN row in the movement ledger`)
    const la = await call('GET', '/api/inventory/movements', { cookie: cookies.admin, query: { branch_id: b, movement_type: 'DAMAGE' } })
    check(la.status === 200 && la.body.movements.some((m: any) => m.reference_id === dm.body.return_no), `${L} Admin sees the DAMAGE row`)
    check((await call('GET', '/api/inventory/movements', { cookie: cookies[staff] })).status === 403, `${L} Staff has no ledger access`)

    // ================= 10. history list
    const hist = await call('GET', `/api/orders/${s1.order_id}/returns`, { cookie: cookies[mgr] })
    check(hist.status === 200 && hist.body.returns.length === 2 && hist.body.order.status === 'returned' && hist.body.items.every((x: any) => x.returned_quantity === x.quantity), `${L} return history shows both returns and every line fully returned`)
    // ================= 11. POS "add unregistered item": it can only create / re-price its OWN placeholder rows
    const real = await mk(`Same Name ${n}`, 777, 5)
    const u1 = await call('POST', '/api/pos/unregistered-product', { cookie: cookies[staff], body: { name: `Same Name ${n}`, price: 55 } })
    check(u1.status === 200 || u1.status === 201, `${L} staff can add an unregistered item`, JSON.stringify(u1.body))
    const placeholder = await one(`SELECT id, category, category_id, stock_quantity::numeric s, price::numeric p, is_active FROM products WHERE id = $1`, [u1.body.id])
    check(num(placeholder.id) !== real && placeholder.category === 'Unregistered' && num(placeholder.s) === 0 && num(placeholder.p) === 55, `${L} the placeholder is its own row: category "Unregistered", stock 0, the typed price`, JSON.stringify(placeholder))
    const u2 = await call('POST', '/api/pos/unregistered-product', { cookie: cookies[staff], body: { name: `Same Name ${n}`, price: 99 } })
    check(u2.body.id === u1.body.id && num((await one(`SELECT price::numeric p FROM products WHERE id = $1`, [u1.body.id])).p) === 99, `${L} re-adding the same name re-prices only that placeholder`)
    check(num((await one(`SELECT price::numeric p FROM products WHERE id = $1`, [real])).p) === 777 && num((await one(`SELECT stock_quantity::numeric s FROM products WHERE id = $1`, [real])).s) === 5, `${L} a REAL product with the same name keeps its price and stock`)
    check((await call('POST', '/api/pos/unregistered-product', { cookie: cookies[staff], body: { name: 'x', price: -5 } })).status === 400 && (await call('POST', '/api/pos/unregistered-product', { cookie: cookies[staff], body: { name: 'x', price: 1, category: 'Cat', stock_quantity: 99, id: real } })).status === 400, `${L} no negative price; no extra fields (category, stock, id) are accepted`)
    const mp = await call('GET', '/api/products', { cookie: cookies[mgr] })
    check(mp.body.products.some((x: any) => x.id === u1.body.id && x.category === 'Unregistered'), `${L} Manager sees the placeholder in the catalog, tagged category "Unregistered"`)
    const ap = await call('GET', '/api/products', { cookie: cookies.admin, query: { branch_id: b } })
    check(ap.body.products.some((x: any) => x.id === u1.body.id && x.category === 'Unregistered'), `${L} Admin sees it too`)
    check(!(await call('GET', '/api/products', { cookie: cookies[otherStaff] })).body.products.some((x: any) => x.id === u1.body.id), `${L} another branch never sees it`)

    // ================= 12. the Returns list (Admin + Manager): newest RETURN time first, totals for the cash drawer
    const rl = await call('GET', '/api/returns', { cookie: cookies[mgr] })
    const list: any[] = rl.body.returns ?? []
    check(rl.status === 200 && list.length >= 5 && list.every((x) => x.return_no.startsWith(`RET-POS${n}-`)), `${L} Manager lists this branch's returns only`, String(rl.status))
    check(list.every((x, i) => i === 0 || new Date(list[i - 1].created_at).getTime() >= new Date(x.created_at).getTime()), `${L} the list is ordered by RETURN time, newest first`)
    const mine = list.find((x) => x.return_no === r1.body.return_no)
    check(!!mine && mine.invoice_no === o1.invoice_no && num(mine.refund_amount) === 300 && mine.refund_mode === 'cash' && mine.created_by_role === 'staff' && mine.reason === 'Wrong size' && /Ret B/.test(mine.items?.[0]?.name ?? ''), `${L} a row carries return no, original invoice, items, refund, mode, reason and role`, JSON.stringify(mine))
    check(Math.abs(rl.body.totals.refund - list.reduce((t, x) => t + num(x.refund_amount), 0)) < 0.005 && Math.abs(rl.body.totals.cash + rl.body.totals.original - rl.body.totals.refund) < 0.005, `${L} the totals add up to the rows (cash + original = refunded)`)
    check((await call('GET', '/api/returns', { cookie: cookies.admin, query: { branch_id: b } })).body.returns.length === list.length, `${L} Admin sees the same list for the selected branch`)
    check((await call('GET', '/api/returns', { cookie: cookies[staff] })).status === 403, `${L} Staff has no Returns list (403)`)
    check(!(await call('GET', '/api/returns', { cookie: cookies[`manager${other.slice(-1)}` as Actor] })).body.returns.some((x: any) => x.return_no === r1.body.return_no), `${L} another branch's manager never sees it`)
    check((await call('GET', '/api/returns', { cookie: cookies[mgr], query: { to: new Date(Date.now() - 30 * 86400000).toISOString() } })).body.returns.length === 0, `${L} the date filter works on the return date (nothing 30 days ago)`)
    check((await call('GET', '/api/returns', { cookie: cookies[mgr], query: { mode: 'original' } })).body.returns.every((x: any) => x.refund_mode === 'original'), `${L} the refund-mode filter works`)
    check((await call('GET', '/api/returns', { cookie: cookies[mgr], query: { branch_id: other } })).status === 400, `${L} a forged ?branch_id is refused`)

    // ================= 13. a return on an ADVANCE-ORDER bill is allowed; the advance order record itself does not change
    const adv = await call('POST', '/api/advance-orders', { cookie: cookies[staff], body: { customer_name: 'Ret Adv', phone: '9876500011', product_name: 'Custom blouse', total_amount: 500, deposit_amount: 100, expected_delivery_date: '2030-01-01', payment_method: 'cash' } })
    const advId = adv.body.order?.id
    const done = await call('POST', `/api/advance-orders/${advId}/complete`, { cookie: cookies[staff], body: { payment_method: 'cash', final_amount: 400 } })
    check(adv.status === 201 && done.status === 200, `${L} fixture: an advance order is created and completed`, `${adv.status}/${done.status} ${JSON.stringify(done.body).slice(0, 100)}`)
    const advBefore = (await call('GET', '/api/advance-orders', { cookie: cookies[mgr] })).body.orders.find((o: any) => o.id === advId)
    check(advBefore?.bill_returned === false, `${L} before any return the advance order shows no return flag`)
    const advBillId = advBefore.completed_order_id
    const advItems = await items(advBillId)
    const advRet = await ret(staff, advBillId, [{ order_item_id: advItems[0].id, quantity: 1 }])
    check(advRet.status === 201 && num(advRet.body.refund_amount) > 0, `${L} STAFF can return the advance-order bill`, JSON.stringify(advRet.body).slice(0, 140))
    const advAfter = (await call('GET', '/api/advance-orders', { cookie: cookies[mgr] })).body.orders.find((o: any) => o.id === advId)
    check(advAfter.bill_returned === true, `${L} the advance order now carries the "bill returned" flag (the UI shows the note)`)
    const keep = ['status', 'deposit_amount', 'total_amount', 'remaining_balance', 'completed_order_id', 'invoice_number', 'final_payment_method', 'deposit_id']
    check(keep.every((k) => String(advAfter[k]) === String(advBefore[k])), `${L} deposits and the advance order record are unchanged by the return`, keep.filter((k) => String(advAfter[k]) !== String(advBefore[k])).join())
    check((await call('GET', '/api/advance-orders', { cookie: cookies[mgr] })).body.orders.filter((o: any) => o.id !== advId).every((o: any) => o.bill_returned === false), `${L} other advance orders show no flag`)

    // another branch's return numbers are separate counters
    check(num((await one(`SELECT count(*)::int n FROM order_returns r JOIN orders o ON o.id = r.order_id AND o.branch_id = r.branch_id WHERE r.branch_id <> o.branch_id`)).n) === 0, `${L} every return belongs to its bill's own branch`)
  }
  check(num((await one(`SELECT count(*)::int n FROM (SELECT branch_id, return_no FROM order_returns GROUP BY 1,2 HAVING count(*) > 1) x`)).n) === 0, 'return numbers are unique per branch')
}
