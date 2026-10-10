// POS customer lookup + coupon sending (migration 0012), written once and run by scripts/test-api.ts (TEST database, inside
// its rolled-back transaction) and by the in-memory-Postgres harness. Every check runs for pos1, pos2 and pos3.
import type { Actor, ReturnsCtx } from './returnsSuite'

export type CouponCtx = Omit<ReturnsCtx, 'concurrent'>

const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10)

export async function couponSuite(c: CouponCtx) {
  const { call, q, check, cookies } = c
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0]
  const num = (v: unknown) => Number(v)
  const branchName = async (b: string) => String((await one(`SELECT name FROM branches WHERE id = $1`, [b])).name)
  const resetLookupLimit = () => q(`DELETE FROM login_attempts WHERE bucket = 'customer_lookup'`)

  for (const b of c.branches.filter((x) => !c.only || x === c.only)) {
    const n = b.slice(-1)
    const staff = `staff${n}` as Actor, mgr = `manager${n}` as Actor
    const others = c.branches.filter((x) => x !== b)
    const other = others[0]
    const L = `[${b}] coupons:`
    await resetLookupLimit()

    // ---- fixtures: one product; numbers unique to this branch's run
    const P = num((await one(`INSERT INTO products (name, category, price, stock_quantity, stock, branch_id, is_active) VALUES ($1, 'Cpn Cat', 1000, 100, 100, $2, true) RETURNING id`, [`Cpn Item ${n}`, b])).id)
    const X = `9${n}10000001`, Y = `9${n}10000002`, ONLY_HERE = `9${n}10000003`, NEVER = `9${n}10000004`
    const mkCoupon = async (code: string, extra: Record<string, unknown> = {}) =>
      num((await one(`INSERT INTO coupons (code, percentage, branch_id, expiry_date, usage_limit, usage_count, is_active) VALUES ($1, 10, $2, $3, $4, $5, $6) RETURNING id`,
        [code, b, extra.expiry_date ?? null, extra.usage_limit ?? null, extra.usage_count ?? 0, extra.is_active ?? true])).id)
    const GEN = `CGEN${n}`, SENTG = `CSENT${n}`, RESTR = `CRES${n}`, EXP = `CEXP${n}`, LIM = `CLIM${n}`, OFF = `COFF${n}`
    const id = {
      gen: await mkCoupon(GEN), sentg: await mkCoupon(SENTG), restr: await mkCoupon(RESTR),
      exp: await mkCoupon(EXP), lim: await mkCoupon(LIM, { usage_limit: 5 }), off: await mkCoupon(OFF, { is_active: false }),
    }
    const usage = async (cid: number) => num((await one(`SELECT usage_count FROM coupons WHERE id = $1`, [cid])).usage_count)
    const sell = (phone: string, code: string | null, as: Actor = staff, name = `Cpn Customer ${n}`) =>
      call('POST', '/api/pos/sale', { cookie: cookies[as], body: {
        customer_name: name, phone, payment_method: 'cash', items: [{ product_id: P, quantity: 1, unit_price: 1000, name: `Cpn Item ${n}` }],
        ...(code ? { coupon_code: code, coupon_percentage: 10, discount_amount: 100 } : {}) } })
    const lookup = (phone: string, as: Actor | 'admin' = staff, extra: { query?: Record<string, string>; body?: Record<string, unknown> } = {}) =>
      call('POST', '/api/customers/lookup', { cookie: cookies[as], query: as === 'admin' ? { branch_id: b, ...extra.query } : extra.query, body: { phone, ...extra.body } })
    const send = (cid: number, phone: string, specific = false, as: Actor | 'admin' = 'admin', query: Record<string, string> | null = { branch_id: b }) =>
      call('POST', `/api/coupons/${cid}/sends`, { cookie: cookies[as], query: query ?? undefined, body: { phone, customer_name: `Cpn Customer ${n}`, customer_specific: specific } })
    const counts = async () => (await q(`SELECT b.id AS branch_id, (SELECT count(*)::int FROM orders o WHERE o.branch_id = b.id) o, (SELECT count(*)::int FROM coupon_sends s WHERE s.branch_id = b.id) s FROM branches b WHERE b.id = ANY($1) ORDER BY b.id`, [others]))
      .map((r) => `${r.branch_id}:${r.o}/${r.s}`).join(' ')
    const othersBefore = await counts()

    // ================= 1. lookup: new customer, formats, nothing for partial numbers, exact response shape
    const r0 = await lookup(NEVER)
    check(r0.status === 200 && r0.body.exists_in_this_branch === false && r0.body.name === null && r0.body.coupons.length === 0, `${L} an unknown number is a new customer`, JSON.stringify(r0.body))
    check(JSON.stringify(Object.keys(r0.body).sort()) === JSON.stringify(['coupons', 'exists_in_this_branch', 'name', 'other_branches']), `${L} the response has ONLY exists_in_this_branch, name, coupons, other_branches`, Object.keys(r0.body).join())
    for (const bad of ['98765', `9${n}1000000`, '+91 9876 5432', 'abcdefghij', '5876543210', '']) {
      const r = await lookup(bad)
      check(r.status === 400 && r.body.exists_in_this_branch === undefined && r.body.coupons === undefined, `${L} partial / malformed "${bad}" returns nothing`, `${r.status} ${JSON.stringify(r.body)}`)
    }
    check((await sell(X, null)).status === 201, `${L} fixture: a bill for the customer`)
    const forms = [X, `+91 ${X.slice(0, 5)} ${X.slice(5)}`, `${X.slice(0, 5)} ${X.slice(5)}`, `91${X}`, `0${X}`, `+91-${X}`]
    const answers: Array<{ status: number; body: any }> = []
    for (const f of forms) answers.push(await lookup(f)) // one after the other: test-api runs every request in one transaction
    check(answers.every((a) => a.status === 200 && a.body.exists_in_this_branch === true && a.body.name === `Cpn Customer ${n}`), `${L} every phone format finds the same customer ("Existing customer - Cpn Customer ${n}")`, answers.map((a) => `${a.status}:${a.body.exists_in_this_branch}`).join())
    check(answers.every((a) => JSON.stringify(a.body) === JSON.stringify(answers[0].body)), `${L} all formats give the identical answer`)
    const hist = JSON.stringify(answers[0].body)
    check(!/invoice|total|amount|subtotal|address|"items"|order_id|created_at|1000/.test(hist), `${L} no bill history, amounts or addresses in the answer`, hist)

    // ================= 2. cross-branch: a number billed only in THIS branch, looked up in another
    check((await sell(ONLY_HERE, null, staff, `Secret Name ${n}`)).status === 201, `${L} fixture: a bill only in ${b}`)
    const otherStaff = `staff${other.slice(-1)}` as Actor
    await resetLookupLimit()
    const xr = await call('POST', '/api/customers/lookup', { cookie: cookies[otherStaff], body: { phone: ONLY_HERE } })
    const bName = await branchName(b)
    check(xr.status === 200 && xr.body.exists_in_this_branch === false && xr.body.name === null, `${L} in ${other} the number is a NEW customer in that branch`, JSON.stringify(xr.body))
    check(JSON.stringify(xr.body.other_branches) === JSON.stringify([bName]), `${L} in ${other}: "Also a customer at ${bName}"`, JSON.stringify(xr.body.other_branches))
    check(xr.body.coupons.length === 0 && !JSON.stringify(xr.body).includes(`Secret Name ${n}`) && !/1000|900|invoice|amount|count/i.test(JSON.stringify(xr.body)), `${L} in ${other}: no name, amounts, counts or coupons from ${b}`, JSON.stringify(xr.body))
    const own = await lookup(ONLY_HERE)
    check(own.body.exists_in_this_branch === true && own.body.other_branches.length === 0, `${L} in ${b} itself the number is an existing customer with no other branch`, JSON.stringify(own.body))

    // ================= 3. forged branch: the client never chooses the branch
    const fq = await call('POST', '/api/customers/lookup', { cookie: cookies[staff], query: { branch_id: other }, body: { phone: X } })
    check(fq.status === 400 && fq.body.exists_in_this_branch === undefined, `${L} staff: a forged ?branch_id is refused (no data)`, `${fq.status}`)
    const fb = await call('POST', '/api/customers/lookup', { cookie: cookies[mgr], body: { phone: X, branch_id: other } })
    check(fb.status === 400 && fb.body.exists_in_this_branch === undefined, `${L} manager: a branch_id in the body is refused (no data)`, `${fb.status}`)
    const adm = await lookup(X, 'admin')
    check(adm.status === 200 && adm.body.exists_in_this_branch === true, `${L} admin looks up in the branch selected in the switcher`)
    const admOther = await call('POST', '/api/customers/lookup', { cookie: cookies.admin, query: { branch_id: other }, body: { phone: X } })
    check(admOther.status === 200 && admOther.body.exists_in_this_branch === false, `${L} admin with another branch selected sees that branch's view only`, JSON.stringify(admOther.body))

    // ================= 4. sending: Admin only, selected branch only, nothing for others
    for (const who of [mgr, staff] as Actor[]) {
      const r = await send(id.sentg, X, false, who, null)
      check(r.status === 403, `${L} ${who} gets 403 on send`, String(r.status))
    }
    check((await send(id.sentg, X, false, 'admin', null)).status === 400, `${L} admin send without a selected branch is refused`)
    const foreign = num((await one(`INSERT INTO coupons (code, percentage, branch_id) VALUES ($1, 10, $2) RETURNING id`, [`CFOR${n}`, other])).id)
    check((await send(foreign, X)).status === 404, `${L} admin cannot send another branch's coupon from ${b}`)
    check((await send(id.sentg, '98765')).status === 400, `${L} send needs a full number`)
    check((await send(id.off, X)).status === 400, `${L} an inactive coupon cannot be sent`)
    const s1 = await send(id.sentg, `+91 ${X}`)
    check(s1.status === 201 && s1.body.send.phone === X && s1.body.send.customer_specific === false && s1.body.send.sent_by_role === 'admin', `${L} admin sends a general coupon (toggle OFF by default), phone stored canonical`, JSON.stringify(s1.body))
    const s2 = await send(id.restr, X, true)
    check(s2.status === 201 && s2.body.send.customer_specific === true, `${L} admin sends a customer-specific coupon`)
    check((await send(id.exp, X)).status === 201 && (await send(id.lim, X)).status === 201, `${L} fixtures: two more coupons sent`)
    await q(`UPDATE coupons SET expiry_date = $1 WHERE id = $2`, [day(-2), id.exp])
    await q(`UPDATE coupons SET usage_count = usage_limit WHERE id = $1`, [id.lim])
    check(num((await one(`SELECT count(*)::int n FROM coupon_sends s JOIN coupons cp ON cp.id = s.coupon_id WHERE s.branch_id = $1 AND cp.branch_id <> s.branch_id`, [b])).n) === 0, `${L} every send of ${b} points at a ${b} coupon`)

    // ================= 5. statuses (SQL): Active / Expired / Limit reached, then Used
    const st = async (phone = X) => Object.fromEntries(((await lookup(phone)).body.coupons as Array<{ code: string; status: string }>).map((x) => [x.code, x.status]))
    let s = await st()
    check(s[SENTG] === 'active' && s[RESTR] === 'active' && s[EXP] === 'expired' && s[LIM] === 'limit_reached' && !(GEN in s), `${L} statuses: sent general Active, customer-specific Active, Expired, Limit reached; unsent coupon not listed`, JSON.stringify(s))
    check(((await lookup(X)).body.coupons as any[]).every((x) => JSON.stringify(Object.keys(x).sort()) === '["code","status"]'), `${L} each listed coupon carries only code and status`)
    check(Object.keys(await st(Y)).length === 0, `${L} another phone sees none of these coupons`)

    // ================= 6. the sale function: customer-specific rule, expired, limit, inactive, foreign code
    const rY = await sell(Y, RESTR)
    check(rY.status === 400 && /only works for the customer/i.test(rY.body.error), `${L} customer-specific coupon is REJECTED for another phone`, `${rY.status} ${rY.body.error}`)
    const rNone = await sell('', RESTR)
    check(rNone.status === 400 && /only works for the customer/i.test(rNone.body.error), `${L} customer-specific coupon is rejected on a bill without a phone`, `${rNone.status} ${rNone.body.error}`)
    const u0 = await usage(id.restr)
    const rX = await sell(`+91 ${X.slice(0, 5)} ${X.slice(5)}`, RESTR)
    check(rX.status === 201, `${L} customer-specific coupon is ACCEPTED for the right phone (any format)`, `${rX.status} ${rX.body.error ?? ''}`)
    check(await usage(id.restr) === u0 + 1, `${L} its use is counted once`)
    const rX2 = await sell(X, RESTR)
    check(rX2.status === 400 && /already been used/i.test(rX2.body.error), `${L} the same customer cannot use it again ("already used")`, `${rX2.status} ${rX2.body.error}`)
    s = await st()
    check(s[RESTR] === 'used', `${L} status becomes Used`, JSON.stringify(s))
    const re = await sell(X, EXP)
    check(re.status === 400 && /expired/i.test(re.body.error), `${L} an expired coupon is rejected`, `${re.status} ${re.body.error}`)
    const rl = await sell(X, LIM)
    check(rl.status === 400 && /limit/i.test(rl.body.error), `${L} a coupon at its usage limit is rejected`, `${rl.status} ${rl.body.error}`)
    const ro = await sell(X, OFF)
    check(ro.status === 400 && /not active/i.test(ro.body.error), `${L} an inactive coupon is rejected`, `${ro.status} ${ro.body.error}`)
    const rf = await sell(X, `CFOR${n}`)
    check(rf.status === 400 && /does not belong to this branch/i.test(rf.body.error), `${L} ${other}'s coupon is rejected in ${b}`, `${rf.status} ${rf.body.error}`)

    // ================= 7. general coupons: exactly as before for everyone
    const g0 = await usage(id.gen)
    const g = [await sell(X, GEN), await sell(Y, GEN), await sell(Y, GEN), await sell('', GEN)]
    check(g.every((r) => r.status === 201), `${L} a never-sent coupon works for every phone, repeatedly, and without a phone`, g.map((r) => r.status).join())
    check(await usage(id.gen) === g0 + 4, `${L} its usage count goes up once per bill, as before`)
    const t0 = await usage(id.sentg)
    const t = [await sell(Y, SENTG), await sell(X, SENTG), await sell(X, SENTG)]
    check(t.every((r) => r.status === 201), `${L} a coupon sent with the toggle OFF still works for everyone (also another phone, also twice)`, t.map((r) => r.status).join())
    check(await usage(id.sentg) === t0 + 3, `${L} its usage count is counted as before`)
    check((await st())[SENTG] === 'used', `${L} the toggle-OFF coupon shows Used for the customer who used it`)
    const lk = await call('GET', '/api/coupons/lookup', { cookie: cookies[staff], query: { code: GEN.toLowerCase() } })
    check(lk.status === 200 && Number(lk.body.coupon?.percentage) === 10, `${L} the POS coupon validation endpoint behaves as before`)

    // ================= 8. advance-order completion: the customer-specific rule also applies, general coupons as before
    const adv = async (phone: string) => (await call('POST', '/api/advance-orders', { cookie: cookies[staff], body: { customer_name: `Cpn Adv ${n}`, phone, product_name: 'Custom blouse', total_amount: 500, deposit_amount: 100, expected_delivery_date: '2030-01-01', payment_method: 'cash' } })).body.order?.id
    const a1 = await adv(Y)
    const ac1 = await call('POST', `/api/advance-orders/${a1}/complete`, { cookie: cookies[staff], body: { payment_method: 'cash', final_amount: 360, coupon_code: RESTR, coupon_percentage: 10 } })
    check(ac1.status === 400 && /only works for the customer/i.test(ac1.body.error), `${L} completing an advance order with someone else's customer-specific coupon is rejected`, `${ac1.status} ${ac1.body.error}`)
    const a2 = await adv(Y)
    const ac2 = await call('POST', `/api/advance-orders/${a2}/complete`, { cookie: cookies[staff], body: { payment_method: 'cash', final_amount: 360, coupon_code: GEN, coupon_percentage: 10 } })
    check(ac2.status === 200, `${L} completing an advance order with a general coupon works as before`, `${ac2.status} ${ac2.body.error ?? ''}`)

    // ================= 9. isolation: nothing was written in the other branches; their lookups see none of this
    check(await counts() === othersBefore, `${L} billing and sending in ${b} created no rows in ${others.join(', ')}`, `${othersBefore} -> ${await counts()}`)
    await resetLookupLimit()
    const ox = await call('POST', '/api/customers/lookup', { cookie: cookies[otherStaff], body: { phone: X } })
    check(ox.status === 200 && ox.body.coupons.length === 0 && ox.body.exists_in_this_branch === false, `${L} in ${other} the customer has no coupons and no history (sends stay in ${b})`, JSON.stringify(ox.body))

    // ================= 10. rate limit (per user; database-backed). Last: it uses up this user's budget.
    await resetLookupLimit()
    let first429 = 0
    for (let i = 1; i <= 61 && !first429; i++) if ((await lookup(i % 2 ? X : '98765', mgr)).status === 429) first429 = i
    check(first429 === 61, `${L} the 61st lookup by the same user within 5 minutes is refused (429), malformed ones count too`, `first 429 at ${first429}`)
    check((await lookup(X, staff)).status === 200, `${L} another user of the branch is not blocked by it`)
    await resetLookupLimit()
  }
}
