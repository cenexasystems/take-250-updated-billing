// The public online shop and the Admin enquiry dashboard (migration 0016), written once and run by scripts/test-api.ts
// (TEST database, inside its rolled-back transaction) and by the in-memory-Postgres harness. Every check runs per branch.
import type { Actor, ReturnsCtx } from './returnsSuite'
import { csvCell } from '../../src/lib/csvCell'
import { shopLink, whatsappShareUrl } from '../../src/lib/shopLink'

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
    const search = await call('GET', '/api/shop-admin/enquiries', { cookie: cookies.admin, query: { q: '98765 00088' } })
    check((search.body.enquiries as any[]).some((e) => e.enquiry_no === no1), `${L} search by phone finds the request`)
    for (const who of [mgr, staff]) {
      const codes = [
        (await call('GET', '/api/shop-admin/enquiries', { cookie: cookies[who] })).status,
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
