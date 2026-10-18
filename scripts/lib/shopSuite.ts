// The public online shop and the Admin enquiry dashboard (migration 0016), written once and run by scripts/test-api.ts
// (TEST database, inside its rolled-back transaction) and by the in-memory-Postgres harness. Every check runs per branch.
import type { Actor, ReturnsCtx } from './returnsSuite'
import { csvCell } from '../../src/lib/csvCell'
import { shopInviteText, shopLink, whatsappShareUrl, whatsappToUrl } from '../../src/lib/shopLink'
import { formatMargin, missingCostNote, productProfit, profitTotals } from '../../src/lib/productProfit'

export type ShopCtx = Omit<ReturnsCtx, 'concurrent'>
type CallOpts = { cookie?: string; body?: unknown; query?: Record<string, string>; ip?: string }

export async function shopSuite(c: ShopCtx) {
  const { q, check, cookies } = c
  const call = c.call as unknown as (m: string, p: string, o?: CallOpts) => Promise<{ status: number; body: any }>
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0]
  const num = (v: unknown) => Number(v)
  const branches = c.branches.filter((x) => !c.only || x === c.only)
  let first = true

  for (const b of branches) {
    const n = b.slice(-1)
    const other = c.branches.find((x) => x !== b)!
    const L = `[${b}] shop:`
    const mgr = `manager${n}` as Actor, staff = `staff${n}` as Actor
    const mk = async (name: string, extra: Record<string, unknown>) => num((await one(
      `INSERT INTO products (name, category, price, stock_quantity, stock, branch_id, is_active, purchase_price, sku, barcode, show_online, online_price, has_variants)
       VALUES ($1, 'Shop Cat', $2, $3::numeric, $3::int, $4, true, 200, $5, $6, $7, $8, $9) RETURNING id`,
      [name, extra.price ?? 500, extra.stock ?? 10, extra.branch ?? b, `SKU-SHOP-${n}-${name}`, `BC-SHOP-${n}-${name.length}${Math.random().toString(36).slice(2, 6)}`,
       extra.show ?? true, extra.online ?? null, extra.variants ?? false])).id)
    const P1 = await mk(`Shop Kurti ${n}`, {})
    const P2 = await mk(`Shop Hidden ${n}`, { show: false })
    const P3 = await mk(`Shop Saree ${n}`, { variants: true, stock: 5 })
    const S = (await one(`INSERT INTO product_variants (product_id, variant_name, size_label, price, stock, branch_id, is_active) VALUES ($1, 'S', 'S', 300, 5, $2, true) RETURNING id`, [P3, b])).id
    const M = (await one(`INSERT INTO product_variants (product_id, variant_name, size_label, price, stock, branch_id, is_active) VALUES ($1, 'M', 'M', 350, 0, $2, true) RETURNING id`, [P3, b])).id
    const P4 = await mk(`Shop Sold Out ${n}`, { stock: 0 })
    const P5 = await mk(`Shop Offer ${n}`, { online: 450 })
    const O1 = await mk(`Shop Other ${n}`, { branch: other })
    const ip = `10.${n}.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`
    await q(`DELETE FROM login_attempts WHERE bucket IN ('shop_read', 'shop_enquiry')`)

    // ================= 1. branches + catalogue: show-online products of an ACTIVE branch, no internal data
    const br = await call('GET', '/api/shop/branches', {})
    check(br.status === 200 && br.body.branches.some((x: any) => x.id === b) && br.body.branches.every((x: any) => JSON.stringify(Object.keys(x).sort()) === '["id","logo","name","subtitle"]'),
      `${L} branches: id, name, subtitle and logo only`, JSON.stringify(br.body.branches?.[0]))
    const cat = await call('GET', `/api/shop/catalogue/${b}`, {})
    const ids = (cat.body.products as any[]).map((p) => p.id)
    check(cat.status === 200 && [P1, P3, P4, P5].every((x) => ids.includes(x)) && !ids.includes(P2) && !ids.includes(O1), `${L} the catalogue lists only this branch's "show online" products`, JSON.stringify(ids))
    const txt = JSON.stringify(cat.body)
    check(!/purchase|sku|barcode|stock_quantity|"stock"|SKU-SHOP|BC-SHOP|"200"|cost/i.test(txt) && (cat.body.products as any[]).every((p) => JSON.stringify(Object.keys(p).sort()) === '["category","description","id","image","in_stock","name","price","variants"]'),
      `${L} no cost price, exact stock, SKU or barcode in the catalogue`, txt.slice(0, 200))
    const byId = (id: number) => (cat.body.products as any[]).find((p) => p.id === id)
    check(byId(P5).price === 450 && byId(P1).price === 500 && byId(P4).in_stock === false && byId(P3).variants.length === 2 && byId(P3).variants.find((v: any) => v.name === 'M').in_stock === false && byId(P3).price === 300,
      `${L} online price used (450), normal price as fallback (500), sizes with their own price, "out of stock" without numbers`)
    check(/public, max-age=30/.test(String((cat as any).headers?.get?.('cache-control') ?? '')), `${L} the catalogue carries a short cache header`, String((cat as any).headers?.get?.('cache-control')))
    check((await call('GET', '/api/shop/catalogue/nope', {})).status === 404, `${L} an unknown shop is refused`)
    await q(`UPDATE branches SET is_active = false WHERE id = $1`, [other])
    const inactive = await call('GET', `/api/shop/catalogue/${other}`, {})
    const brNow = await call('GET', '/api/shop/branches', {})
    await q(`UPDATE branches SET is_active = true WHERE id = $1`, [other])
    check(inactive.status === 404 && !brNow.body.branches.some((x: any) => x.id === other), `${L} an inactive branch is not listed and its catalogue is refused`)

    // ================= 2. sending a request: re-priced on the server, forged values ignored
    const stockBefore = await one(`SELECT (SELECT COALESCE(sum(stock_quantity), 0) FROM products WHERE branch_id = $1)::numeric s, (SELECT COALESCE(sum(stock), 0) FROM product_variants WHERE branch_id = $1)::numeric v,
                                         (SELECT count(*) FROM orders WHERE branch_id = $1)::int o, (SELECT count(*) FROM inventory_movements WHERE branch_id = $1)::int m`, [b])
    const key = () => `shop-${b}-${Math.random().toString(36).slice(2)}-${Date.now()}`
    const body = (extra: Record<string, unknown> = {}) => ({ shop: b, customer_name: `Shop Customer ${n}`, phone: '+91 98765 00088', address: '12, Gandhi Road', note: 'Call after 6',
      items: [{ product_id: P1, quantity: 2, price: 1, name: 'FORGED' }, { product_id: P3, variant_id: S, quantity: 1, unit_price: 0 }], total: 1, idempotency_key: key(), ...extra })
    const send = (extra: Record<string, unknown> = {}, ipx = ip) => call('POST', '/api/shop/enquiries', { body: body(extra), ip: ipx })
    const k1 = key()
    const e1 = await send({ idempotency_key: k1 })
    const no1 = e1.body.enquiry?.enquiry_no
    check(e1.status === 201 && new RegExp(`^ENQ-POS${n}-\\d{6}$`).test(no1) && num(e1.body.enquiry.items_total) === 1300, `${L} request accepted: ${no1}, total re-priced on the server (2 x 500 + 1 x 300 = 1300)`, JSON.stringify(e1.body))
    check(e1.body.enquiry.items.map((i: any) => `${i.name}|${i.variant_name ?? ''}|${num(i.unit_price)}|${i.quantity}`).join(',') === `Shop Kurti ${n}||500|2,Shop Saree ${n}|S|300|1`, `${L} the forged price, name and total were ignored; names and prices are the catalogue's`, JSON.stringify(e1.body.enquiry.items))
    check(!/9876500088|Gandhi|"id"|branch_id/.test(JSON.stringify(e1.body)), `${L} the confirmation carries no phone, address or internal ids`)
    const row1 = await one(`SELECT phone, status, (SELECT count(*) FROM shop_enquiry_items i WHERE i.enquiry_id = e.id)::int n FROM shop_enquiries e WHERE enquiry_no = $1`, [no1])
    check(row1.phone === '9876500088' && row1.status === 'new' && row1.n === 2, `${L} stored with the canonical phone, status New, two snapshot lines`)
    const again = await send({ idempotency_key: k1 })
    check(again.status === 201 && again.body.enquiry.enquiry_no === no1 && num((await one(`SELECT count(*)::int n FROM shop_enquiries WHERE branch_id = $1 AND idempotency_key = $2`, [b, k1])).n) === 1, `${L} a double submit with the same key creates ONE request`)
    const e2 = await send({}, `${ip}9`)
    const n1 = num(no1.slice(-6)), n2 = num(String(e2.body.enquiry?.enquiry_no).slice(-6))
    check(e2.status === 201 && n2 === n1 + 1, `${L} the next request is numbered sequentially (${n1} -> ${n2})`)
    // refusals
    const refuse = async (label: string, extra: Record<string, unknown>, re: RegExp) => {
      const r = await send(extra, `${ip}${Math.floor(Math.random() * 9)}`)
      check(r.status === 400 && re.test(r.body.error ?? ''), `${L} ${label}`, `${r.status} ${r.body.error}`)
    }
    await q(`DELETE FROM login_attempts WHERE bucket = 'shop_enquiry'`)
    await refuse('a hidden product cannot be ordered', { items: [{ product_id: P2, quantity: 1 }] }, /no longer available/)
    await refuse("another branch's product cannot be ordered", { items: [{ product_id: O1, quantity: 1 }] }, /no longer available/)
    await refuse('an out-of-stock product is refused', { items: [{ product_id: P4, quantity: 1 }] }, /out of stock/)
    await q(`DELETE FROM login_attempts WHERE bucket = 'shop_enquiry'`)
    await refuse('a product with sizes needs a size', { items: [{ product_id: P3, quantity: 1 }] }, /choose a size/)
    await refuse('an out-of-stock size is refused', { items: [{ product_id: P3, variant_id: M, quantity: 1 }] }, /out of stock/)
    await refuse('more than the stock is refused (without saying the number)', { items: [{ product_id: P1, quantity: 50 }] }, /^Not enough stock of .* Please choose fewer\.$/)
    await q(`DELETE FROM login_attempts WHERE bucket = 'shop_enquiry'`)
    await refuse('an invalid phone is refused', { phone: '12345' }, /10-digit mobile/)
    await refuse('an empty name is refused', { customer_name: '   ' }, /name/)
    await refuse('an empty address is refused', { address: '' }, /address/)
    await q(`DELETE FROM login_attempts WHERE bucket = 'shop_enquiry'`)
    const emptyCart = await send({ items: [] }, `${ip}7`)
    check(emptyCart.status === 400, `${L} an empty cart is refused`)
    const unknownShop = await call('POST', '/api/shop/enquiries', { body: body({ shop: 'nope' }), ip: `${ip}6` })
    check(unknownShop.status === 404, `${L} a request to an unknown shop is refused`)
    const forged = await call('POST', '/api/shop/enquiries', { body: { ...body(), branch_id: other }, ip: `${ip}5` })
    check(forged.status === 400, `${L} a branch_id field is refused (the shop comes only from "shop")`)
    const honey = await send({ website: 'http://spam' }, `${ip}4`)
    check(honey.status === 400 && num((await one(`SELECT count(*)::int n FROM shop_enquiries WHERE branch_id = $1`, [b])).n) === 2, `${L} the honeypot rejects a bot and stores nothing`)
    // XSS / control characters: stored as text (React escapes on output), control characters removed
    const xss = await send({ customer_name: '<script>alert(1)</script>\u0007Ravi', address: '<img src=x onerror=alert(1)>' }, `${ip}3`)
    const xr = await one(`SELECT customer_name, address FROM shop_enquiries WHERE enquiry_no = $1`, [xss.body.enquiry?.enquiry_no])
    check(xss.status === 201 && xr.customer_name === '<script>alert(1)</script> Ravi' && !/[\u0000-\u001f]/.test(xr.customer_name), `${L} customer text is stored as plain text, control characters removed`, JSON.stringify(xr))
    // rate limit: 5 requests per 15 minutes per IP (every attempt counts)
    await q(`DELETE FROM login_attempts WHERE bucket = 'shop_enquiry'`)
    const rl: number[] = []
    for (let i = 0; i < 6; i++) rl.push((await send({ items: [{ product_id: P1, quantity: 1 }] }, `${ip}0`)).status)
    check(JSON.stringify(rl) === '[201,201,201,201,201,429]', `${L} the 6th request from one IP within 15 minutes is refused (429)`, JSON.stringify(rl))
    await q(`DELETE FROM login_attempts WHERE bucket = 'shop_enquiry'`)
    // no stock, order or revenue change
    const stockAfter = await one(`SELECT (SELECT COALESCE(sum(stock_quantity), 0) FROM products WHERE branch_id = $1)::numeric s, (SELECT COALESCE(sum(stock), 0) FROM product_variants WHERE branch_id = $1)::numeric v,
                                        (SELECT count(*) FROM orders WHERE branch_id = $1)::int o, (SELECT count(*) FROM inventory_movements WHERE branch_id = $1)::int m`, [b])
    check(JSON.stringify(stockBefore) === JSON.stringify(stockAfter), `${L} no stock, order or stock-movement row changed`, `${JSON.stringify(stockBefore)} -> ${JSON.stringify(stockAfter)}`)

    // ================= 3. Admin dashboard and catalogue; Manager / Staff refused
    const all = await call('GET', '/api/shop-admin/enquiries', { cookie: cookies.admin })
    check(all.status === 200 && (all.body.enquiries as any[]).some((e) => e.enquiry_no === no1) && num(all.body.new_count) >= 1, `${L} Admin lists requests of all branches`)
    const onlyOther = await call('GET', '/api/shop-admin/enquiries', { cookie: cookies.admin, query: { in_branch: other } })
    check(onlyOther.status === 200 && !(onlyOther.body.enquiries as any[]).some((e) => e.branch_id === b), `${L} filtered to ${other}: none of ${b}'s requests`)
    const mine = await call('GET', '/api/shop-admin/enquiries', { cookie: cookies.admin, query: { in_branch: b } })
    const newHere = num((await one(`SELECT count(*)::int n FROM shop_enquiries WHERE branch_id = $1 AND status = 'new'`, [b])).n)
    const pulseNow = await call('GET', '/api/shop-admin/enquiries/pulse', { cookie: cookies.admin })
    check(num(mine.body.new_by_branch?.[b]) === newHere && num(pulseNow.body.new_by_branch?.[b]) === newHere && num(pulseNow.body.new_count) >= newHere,
      `${L} New counts per branch (${b}: ${newHere}) for the badge inside a branch`, JSON.stringify(pulseNow.body.new_by_branch))
    check(mine.status === 200 && (mine.body.enquiries as any[]).some((e) => e.enquiry_no === no1) && (mine.body.enquiries as any[]).every((e) => e.branch_id === b), `${L} Admin filtered to ${b} sees only ${b}'s requests`)
    const empty = await call('GET', '/api/shop-admin/enquiries', { cookie: cookies.admin, query: { in_branch: b, q: 'no-such-customer-zz' } })
    check(empty.status === 200 && Array.isArray(empty.body.enquiries) && empty.body.enquiries.length === 0, `${L} an empty result is an empty list (200), not an error`)
    // the dashboard is all-branches: like every global route, a branch SELECTOR on it is refused, which is why the screen
    // never sends one (the client keeps the enquiry routes on its no-branch list; the browser test covers Admin inside a branch)
    for (const path of ['/api/shop-admin/enquiries', '/api/shop-admin/enquiries/pulse']) {
      const sel = await call('GET', path, { cookie: cookies.admin, query: { branch_id: b } })
      check(sel.status === 400 && sel.body.code === 'branch_unreadable', `${L} ${path} still refuses a branch selector, like every all-branches route`)
    }
    const search = await call('GET', '/api/shop-admin/enquiries', { cookie: cookies.admin, query: { q: '98765 00088' } })
    check((search.body.enquiries as any[]).some((e) => e.enquiry_no === no1), `${L} search by phone finds the request`)
    for (const who of [mgr, staff]) {
      const codes = [
        (await call('GET', '/api/shop-admin/enquiries', { cookie: cookies[who] })).status,
        (await call('GET', '/api/shop-admin/enquiries', { cookie: cookies[who], query: { branch_id: other } })).status,
        (await call('GET', '/api/shop-admin/enquiries', { cookie: cookies[who], query: { in_branch: other } })).status,
        (await call('GET', '/api/shop-admin/enquiries/pulse', { cookie: cookies[who] })).status,
        (await call('PATCH', `/api/shop-admin/enquiries/${e1.body.enquiry ? (await one(`SELECT id FROM shop_enquiries WHERE enquiry_no = $1`, [no1])).id : 'x'}`, { cookie: cookies[who], body: { status: 'contacted' } })).status,
        (await call('GET', '/api/shop-admin/catalogue', { cookie: cookies[who] })).status,
        (await call('GET', '/api/shop-admin/catalogue', { cookie: cookies[who], query: { branch_id: other } })).status,
        (await call('PATCH', `/api/shop-admin/catalogue/${P1}`, { cookie: cookies[who], body: { show_online: false } })).status,
      ]
      check(codes.every((x) => x === 403), `${L} ${who} gets 403 on the catalogue and enquiry endpoints (forged branch_id too)`, JSON.stringify(codes))
    }
    const id1 = (await one(`SELECT id FROM shop_enquiries WHERE enquiry_no = $1`, [no1])).id
    const st = await call('PATCH', `/api/shop-admin/enquiries/${id1}`, { cookie: cookies.admin, body: { status: 'contacted', delivery_charge: 60, admin_note: 'Will deliver Friday' } })
    const hist = (await call('GET', `/api/shop-admin/enquiries/${id1}/history`, { cookie: cookies.admin })).body.history as any[]
    check(st.status === 200 && st.body.enquiry.status === 'contacted' && num(st.body.enquiry.delivery_charge) === 60 && st.body.enquiry.admin_note === 'Will deliver Friday', `${L} status, delivery charge and admin note saved`, JSON.stringify(st.body))
    check(hist.length === 2 && hist[0].new_status === 'new' && hist[0].changed_by_role === 'customer' && hist[1].old_status === 'new' && hist[1].new_status === 'contacted' && hist[1].changed_by_role === 'admin', `${L} the status change is in the history`, JSON.stringify(hist))
    check((await call('PATCH', `/api/shop-admin/enquiries/${id1}`, { cookie: cookies.admin, body: { status: 'shipped' } })).status === 400, `${L} an unknown status is refused`)
    // 0019: delivery date (optional): saved, listed, cleared; impossible / too early / too late refused; Admin only
    const day = async (offset: string) => (await one(`SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date + ${offset}, 'YYYY-MM-DD') AS d`)).d as string
    const in3 = await day("3"), past = await day("-400"), tooLate = await day("400")
    const pd = (v: unknown, who: Actor | 'admin' = 'admin') => call('PATCH', `/api/shop-admin/enquiries/${id1}`, { cookie: cookies[who as Actor], body: { delivery_date: v } })
    const okD = await pd(in3)
    const listedD = ((await call('GET', '/api/shop-admin/enquiries', { cookie: cookies.admin, query: { in_branch: b } })).body.enquiries as any[]).find((x) => x.id === id1)
    check(okD.status === 200 && okD.body.enquiry.delivery_date === in3 && listedD?.delivery_date === in3, `${L} a delivery date is saved and listed (${in3})`, JSON.stringify(okD.body))
    const bad = [await pd('2026-02-30'), await pd(past), await pd(tooLate), await pd('tomorrow')]
    check(bad.every((r) => r.status === 400) && /valid date/.test(bad[0].body.error) && /before the request date/.test(bad[1].body.error) && /one year/.test(bad[2].body.error),
      `${L} an impossible date, a date before the request, more than a year ahead, or text is refused`, bad.map((r) => `${r.status} ${r.body?.error}`).join(' | '))
    check(((await call('GET', '/api/shop-admin/enquiries', { cookie: cookies.admin, query: { in_branch: b } })).body.enquiries as any[]).find((x) => x.id === id1)?.delivery_date === in3, `${L} a refused date leaves the saved one unchanged`)
    check((await pd(in3, mgr)).status === 403 && (await pd(in3, staff)).status === 403, `${L} Manager and Staff cannot set a delivery date (403)`)
    const clr = await pd(null)
    check(clr.status === 200 && clr.body.enquiry.delivery_date === null, `${L} the delivery date can be cleared`)
    await pd(in3)
    const pulse = await call('GET', '/api/shop-admin/enquiries/pulse', { cookie: cookies.admin, query: { since: '2000-01-01T00:00:00Z' } })
    check(pulse.status === 200 && (pulse.body.fresh as any[]).some((e) => e.enquiry_no) && typeof pulse.body.latest === 'string', `${L} the Admin notification poll reports new requests`)
    const later = await call('GET', '/api/shop-admin/enquiries/pulse', { cookie: cookies.admin, query: { since: pulse.body.latest } })
    check(later.body.fresh.length === 0, `${L} after "latest", nothing is reported again (full timestamp precision)`, JSON.stringify(later.body.fresh))
    // catalogue management
    const cl = await call('GET', '/api/shop-admin/catalogue', { cookie: cookies.admin, query: { branch_id: b } })
    check(cl.status === 200 && (cl.body.products as any[]).every((p) => typeof p.show_online === 'boolean') && !(cl.body.products as any[]).some((p) => p.id === O1), `${L} Admin catalogue lists this branch only`)
    const pt = await call('PATCH', `/api/shop-admin/catalogue/${P2}`, { cookie: cookies.admin, query: { branch_id: b }, body: { show_online: true, online_price: 999, online_description: 'Now online', online_sort: 1 } })
    check(pt.status === 200 && pt.body.product.show_online === true && num(pt.body.product.online_price) === 999, `${L} Admin shows a product online with its own online price`)
    const bulk = await call('POST', '/api/shop-admin/catalogue/bulk', { cookie: cookies.admin, query: { branch_id: b }, body: { ids: [P1, P2, O1], show_online: false } })
    const shownNow = (await q(`SELECT id, show_online FROM products WHERE id = ANY($1::bigint[])`, [[P1, P2, O1]])).reduce((a: any, r: any) => ({ ...a, [r.id]: r.show_online }), {})
    check(bulk.status === 200 && bulk.body.updated === 2 && shownNow[P1] === false && shownNow[P2] === false && shownNow[O1] === true, `${L} bulk hide changes only this branch's products`, JSON.stringify(shownNow))
    check((await call('PATCH', `/api/shop-admin/catalogue/${O1}`, { cookie: cookies.admin, query: { branch_id: b }, body: { show_online: false } })).status === 404, `${L} another branch's product cannot be edited from ${b}`)

    // ================= customers of this branch, for "Send to a customer" on WhatsApp (Admin only)
    const ord = (br: string, name: string, phone: string, daysAgo: number) => q(
      `INSERT INTO orders (invoice_no, customer_name, phone, subtotal, total, branch_id, created_at) VALUES (public.get_next_invoice_no($1), $2, $3, 1, 1, $1, now() - make_interval(days => $4::int))`,
      [br, name, phone, daysAgo])
    const recentP = `97${n}00111${n}1`, walkinP = `95${n}00333${n}3`, oldP = `96${n}00222${n}2`, otherP = `94${n}00444${n}4`
    await ord(b, 'Lakshmi', `+91 ${recentP.slice(0, 5)} ${recentP.slice(5)}`, 2)
    await ord(b, 'Walk-in Customer', walkinP, 1)
    await ord(b, 'Old Friend', oldP, 60)
    await ord(other, 'Other Branch Person', otherP, 1)
    const recent = await call('GET', '/api/shop-admin/customers', { cookie: cookies.admin, query: { branch_id: b } })
    const rc = (recent.body?.customers ?? []) as Array<{ phone: string; name: string | null }>
    const find = (list: typeof rc, ph: string) => list.find((x) => x.phone === ph)
    check(recent.status === 200 && find(rc, recentP)?.name === 'Lakshmi' && !!find(rc, walkinP) && find(rc, walkinP)?.name === null && !!find(rc, '9876500088') && !find(rc, oldP) && !find(rc, otherP),
      `${L} recent customers: this branch's buyers and online customers of the last 30 days (canonical phone, placeholder names blank), not older ones, not other branches`, JSON.stringify(rc).slice(0, 300))
    check(rc.indexOf(find(rc, walkinP)!) < rc.indexOf(find(rc, recentP)!), `${L} recent customers are listed newest first`)
    check(String((recent as any).headers?.get?.('cache-control') ?? '') === 'no-store', `${L} the customer list is never cached`)
    const everyone = await call('GET', '/api/shop-admin/customers', { cookie: cookies.admin, query: { branch_id: b, range: 'all' } })
    const ec = (everyone.body?.customers ?? []) as typeof rc
    check(everyone.status === 200 && find(ec, oldP)?.name === 'Old Friend' && !!find(ec, recentP) && !find(ec, otherP), `${L} all customers include older ones, still only this branch`)
    const custCodes = [
      (await call('GET', '/api/shop-admin/customers', { cookie: cookies[mgr] })).status,
      (await call('GET', '/api/shop-admin/customers', { cookie: cookies[mgr], query: { branch_id: other } })).status,
      (await call('GET', '/api/shop-admin/customers', { cookie: cookies[staff], query: { range: 'all' } })).status,
    ]
    check(custCodes.every((x) => x === 403), `${L} manager / staff cannot list customers (403, forged branch too)`, JSON.stringify(custCodes))
    check((await call('GET', '/api/shop-admin/customers', { cookie: cookies.admin })).status === 400, `${L} Admin must have a branch selected to list its customers`)

    // ================= POS phone suggestions (from the 4th digit) and name for a full number, this branch only
    const sug = async (who: Actor, phone: string) => call('POST', '/api/customers/suggest', { cookie: cookies[who], body: { phone }, ...(who === 'admin' ? { query: { branch_id: b } } : {}) })
    const s5 = await sug(staff, recentP.slice(0, 5))
    const s5list = (s5.body?.customers ?? []) as Array<{ phone: string; name: string | null }>
    check(s5.status === 200 && s5list.some((x) => x.phone === recentP && x.name === 'Lakshmi') && !s5list.some((x) => x.phone === otherP) && s5list.length <= 8 && s5list.every((x) => x.phone.startsWith(recentP.slice(0, 5))),
      `${L} staff: 5 typed digits suggest this branch's matching numbers with names (max 8)`, JSON.stringify(s5list).slice(0, 200))
    const s4 = await sug(mgr, `+91 ${walkinP.slice(0, 4)}`)
    check(s4.status === 200 && (s4.body.customers as any[]).some((x) => x.phone === walkinP && x.name === null), `${L} manager: "+91" + 4 digits works; a walk-in placeholder name comes back blank`, JSON.stringify(s4.body).slice(0, 160))
    check(((await sug(staff, recentP.slice(0, 3))).body.customers as any[]).length === 0, `${L} fewer than 4 digits: no suggestions`)
    check((await sug('admin', oldP.slice(0, 6))).body.customers.some((x: any) => x.phone === oldP && x.name === 'Old Friend'), `${L} admin (branch selected) gets suggestions too, including older customers`)
    const otherStaff = `staff${other.slice(-1)}` as Actor
    check(!((await sug(otherStaff, recentP.slice(0, 6))).body.customers as any[]).some((x) => x.phone === recentP), `${L} another branch's staff never sees ${b}'s numbers`)

    // ================= bill lines carry the current purchase price for Admin / Manager (product-wise profit), never for Staff
    const ordId = (await one(`INSERT INTO orders (invoice_no, customer_name, phone, subtotal, total, branch_id, status) VALUES (public.get_next_invoice_no($1), 'Profit Test', $2, 1000, 1000, $1, 'completed') RETURNING id`, [b, recentP])).id
    await q(`INSERT INTO order_items (branch_id, order_id, product_id, product_name, name, quantity, unit_price, line_total) VALUES ($1, $2, $3, 'Shop Kurti', 'Shop Kurti', 2, 500, 1000)`, [b, ordId, P1])
    const itemsFor = async (who: Actor) => {
      const r = await call('GET', '/api/orders', { cookie: cookies[who], query: { include_items: '1', limit: '50', ...(who === 'admin' ? { branch_id: b } : {}) } })
      return ((r.body?.orders ?? []) as any[]).find((o) => o.id === ordId)?.order_items?.[0]
    }
    const ai = await itemsFor('admin'), mi = await itemsFor(mgr), si = await itemsFor(staff)
    check(num(ai?.unit_cost) === 200, `${L} Admin gets the line's purchase price (unit_cost 200) for product profit`, JSON.stringify({ a: ai?.unit_cost }))
    check(!!mi && !('unit_cost' in mi) && !!si && !('unit_cost' in si), `${L} Manager and Staff never receive a purchase price on bill lines (Admin only)`)
    // a size's own purchase price wins over the product's (cost is per size line)
    const P3v = (await one(`SELECT id FROM product_variants WHERE product_id = $1 AND branch_id = $2 ORDER BY created_at LIMIT 1`, [P3, b]))?.id
    if (P3v) {
      await q(`UPDATE products SET purchase_price = 500 WHERE id = $1`, [P3]); await q(`UPDATE product_variants SET purchase_price = 700 WHERE id = $1`, [P3v])
      await q(`INSERT INTO order_items (branch_id, order_id, product_id, variant_id, product_name, name, quantity, unit_price, line_total) VALUES ($1, $2, $3, $4, 'Shop Saree', 'Shop Saree', 1, 1000, 1000)`, [b, ordId, P3, P3v])
      const vi = (((await call('GET', '/api/orders', { cookie: cookies.admin, query: { include_items: '1', limit: '50', branch_id: b } })).body?.orders ?? []) as any[]).find((o) => o.id === ordId)?.order_items?.find((i: any) => i.variant_id === P3v)
      check(num(vi?.unit_cost) === 700, `${L} a size line costs at the size's purchase price (700), not the product's (500)`, JSON.stringify(vi?.unit_cost))
    }
    // a product whose purchase price was never entered (stored as 0): no cost, so no made-up profit
    const P0 = await mk(`Shop NoCost ${n}`, {})
    await q(`UPDATE products SET purchase_price = 0 WHERE id = $1`, [P0])
    await q(`INSERT INTO order_items (branch_id, order_id, product_id, product_name, name, quantity, unit_price, line_total) VALUES ($1, $2, $3, 'Shop NoCost', 'Shop NoCost', 1, 300, 300)`, [b, ordId, P0])
    const r0 = await call('GET', '/api/orders', { cookie: cookies.admin, query: { include_items: '1', limit: '50', branch_id: b } })
    const noCost = ((r0.body?.orders ?? []) as any[]).find((o) => o.id === ordId)?.order_items?.find((i: any) => i.product_id === P0 || Number(i.product_id) === P0)
    check(!!noCost && noCost.unit_cost === null, `${L} a purchase price of 0 (never entered) is sent as "no cost", not 0`, JSON.stringify(noCost?.unit_cost))

    // ================= 4. once: CSV formula cells, a future branch gets its counter
    if (first) {
      first = false
      check(csvCell('=HYPERLINK("http://x")').startsWith(`"'=`) && csvCell('+1').startsWith(`"'+`) && csvCell('-2').startsWith(`"'-`) && csvCell('@SUM(A1)').startsWith(`"'@`) && csvCell('Ravi') === '"Ravi"',
        'shop: CSV cells starting with = + - @ are neutralised')
      // the customer link (copy / WhatsApp / QR) is built from the open address and always ends with /shop
      const origins = ['https://take250.vercel.app', 'https://take250-git-feature-x-team.vercel.app/', 'http://localhost:5173', 'https://take250.in/dashboard?tab=online_shop#x']
      const links = origins.map(shopLink)
      check(links.every((l) => l.endsWith('/shop') && !l.includes('//shop') && !/[?#]/.test(l)) && links[0] === 'https://take250.vercel.app/shop' && links[1] === 'https://take250-git-feature-x-team.vercel.app/shop' && links[3] === 'https://take250.in/shop',
        'shop: the copied link is <origin>/shop on production, preview and local addresses', links.join(' '))
      const inv = whatsappToUrl('9811100077', shopInviteText(links[0], 'Meena'))
      check(inv === `https://wa.me/919811100077?text=${encodeURIComponent('Hi Meena, you can now order from TAKE250 online: https://take250.vercel.app/shop')}` && shopInviteText(links[0]).startsWith('Hi, you can'),
        'shop: "Send to a customer" opens that customer\'s WhatsApp chat with the /shop link typed in', inv)
      // product cost / net profit / margin: the one shared calculation (table, cards, totals, CSV, PDF)
      const pp = productProfit({ qty: 3, revenue: 3000, cost: 1800, costedQty: 3 })
      check(pp.cost === 1800 && pp.profit === 1200 && pp.margin === 40 && formatMargin(pp.margin) === '40.0%' && !pp.missing, 'profit: purchase 600, selling 1000, qty 3 -> cost 1800, profit 1200, margin 40.0%', JSON.stringify(pp))
      const none = productProfit({ qty: 2, revenue: 900, cost: 0, costedQty: 0 }), part = productProfit({ qty: 3, revenue: 3000, cost: 600, costedQty: 1 })
      check(none.missing && none.cost === null && none.profit === null && none.margin === null && part.missing, 'profit: no purchase price (or only some units priced) -> no cost, no profit, no margin (never revenue as profit, never 0 as cost)')
      const eq = productProfit({ qty: 1, revenue: 450, cost: 450, costedQty: 1 })
      check(!eq.missing && eq.profit === 0 && eq.margin === 0 && formatMargin(eq.margin) === '0.0%' && formatMargin(null) === '-', 'profit: purchase price = selling price -> 0.0%; no revenue -> "-"')
      const tt = profitTotals([{ revenue: 3000, ...pp }, { revenue: 900, ...none }, { revenue: 450, ...eq }])
      check(tt.revenue === 3450 && tt.cost === 2250 && tt.profit === 1200 && tt.margin === 34.8 && tt.missingCount === 1 && missingCostNote(2) === '2 products have no purchase price; they are excluded from profit and margin totals.',
        'profit totals leave out products without a purchase price, and say how many', JSON.stringify(tt))
      const wa = whatsappShareUrl(links[0])
      check(wa === 'https://wa.me/?text=https%3A%2F%2Ftake250.vercel.app%2Fshop' && decodeURIComponent(new URL(wa).searchParams.get('text') || '').endsWith('/shop'),
        'shop: the WhatsApp share link carries the encoded /shop link', wa)
      await q(`SAVEPOINT shop_new_branch`)
      let counter: any = null
      try {
        await q(`SELECT public.register_branch('pos9', 'Branch 9', 'Test 9', NULL, '#000000', '/branch-placeholder.svg', '', 9, 'Q9')`)
        counter = await one(`SELECT last_no FROM shop_enquiry_counters WHERE branch_id = 'pos9'`)
      } catch (e) { check(false, 'shop: register_branch() for a test branch', (e as Error).message) }
      await q(`ROLLBACK TO SAVEPOINT shop_new_branch`)
      check(counter && num(counter.last_no) === 0, 'shop: register_branch() creates the request counter of a new branch')
    }
  }
}
