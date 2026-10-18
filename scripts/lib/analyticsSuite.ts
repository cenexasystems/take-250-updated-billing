// Analytics > Products: cost read per size, weighted fallback, missing cost, unregistered / deleted items, returns,
// discounts, branch isolation and roles - through the SAME shared calculation the screen and exports use
// (src/lib/productProfit.ts). Run by scripts/test-api.ts (part 8) and the in-memory harness, on every branch.
import type { Actor, ReturnsCtx } from './returnsSuite'
import { analyticsLines, productRows, profitTotals, type ProductRow } from '../../src/lib/productProfit'

export type AnalyticsCtx = Omit<ReturnsCtx, 'concurrent'>
type CallOpts = { cookie?: string; body?: unknown; query?: Record<string, string> }

export async function analyticsSuite(c: AnalyticsCtx) {
  const { q, check, cookies } = c
  const call = c.call as unknown as (m: string, p: string, o?: CallOpts) => Promise<{ status: number; body: any }>
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0]
  const num = (v: unknown) => Number(v)
  const branches = c.branches.filter((x) => !c.only || x === c.only)

  for (const b of branches) {
    const n = b.slice(-1), L = `[${b}] analytics:`, staff = `staff${n}` as Actor, mgr = `manager${n}` as Actor
    const other = c.branches.find((x) => x !== b)!
    const tag = `An${n}`
    const prod = async (name: string, f: { price?: number; cost?: number; sizes?: boolean } = {}) => num((await one(
      `INSERT INTO products (name, category, price, purchase_price, stock_quantity, stock, branch_id, is_active, has_variants, sku) VALUES ($1, 'An Cat', $2, $3, 50, 50, $4, true, $5, $6) RETURNING id`,
      [name, f.price ?? 1000, f.cost ?? 0, b, f.sizes ?? false, `SKU-${name}`])).id)
    const size = async (pid: number, name: string, price: number, cost: number | null) => (await one(
      `INSERT INTO product_variants (product_id, variant_name, size_label, price, purchase_price, stock, branch_id, is_active) VALUES ($1, $2, $2, $3, $4, 50, $5, true) RETURNING id`, [pid, name, price, cost, b])).id
    const sale = async (items: unknown[], extra: Record<string, unknown> = {}) => {
      const r = await call('POST', '/api/pos/sale', { cookie: cookies[staff], body: { customer_name: `${tag} Customer`, phone: '9876500033', payment_method: 'cash', items, ...extra } })
      if (r.status !== 201) check(false, `${L} fixture sale`, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)
      return r.body as { order_id: string }
    }
    const line = (pid: number | null, name: string, qty: number, price: number, vid?: string, vname?: string, manual = false) =>
      ({ product_id: pid, ...(vid ? { variant_id: vid, variant_name: vname } : {}), quantity: qty, unit_price: price, line_total: qty * price, name, ...(manual ? { is_manual: true, source: 'manual', category: 'Unregistered' } : {}) })
    const ordersAs = async (who: Actor | 'admin') => ((await call('GET', '/api/orders', { cookie: cookies[who as Actor], query: { include_items: '1', limit: '1000', ...(who === 'admin' ? { branch_id: b } : {}) } })).body?.orders ?? []) as any[]
    const rowsNow = async () => {
      const orders = (await ordersAs('admin')).filter((o) => ['completed', 'partially_returned', 'returned'].includes(o.status))
      return productRows(orders.flatMap((o) => analyticsLines(o)))
    }
    const rowOf = (rows: ProductRow[], name: string, variant = '') => rows.find((r) => r.name === name && r.variant === variant)

    // 1. sizes: cost 600, price 1000, 3 sold
    const kurta = await prod(`${tag} Kurta`, { sizes: true })
    const kM = await size(kurta, 'M', 1000, 600)
    const s1 = await sale([line(kurta, `${tag} Kurta`, 3, 1000, kM, 'M')])
    // 2. a line WITHOUT a size of a product with sizes and no product cost: sizes averaged by units sold (S 500 x1, L 700 x3)
    const shirt = await prod(`${tag} Shirt`, { sizes: true })
    const sS = await size(shirt, 'S', 900, 500), sL = await size(shirt, 'L', 900, 700)
    await sale([line(shirt, `${tag} Shirt`, 1, 900, sS, 'S'), line(shirt, `${tag} Shirt`, 3, 900, sL, 'L')])
    await sale([line(shirt, `${tag} Shirt`, 1, 900)])
    // 3. product-level cost; 4. no cost anywhere
    const plain = await prod(`${tag} Plain`, { price: 500, cost: 300 })
    const nocost = await prod(`${tag} NoCost`, { price: 400, cost: 0 })
    await sale([line(plain, `${tag} Plain`, 2, 500), line(nocost, `${tag} NoCost`, 1, 400)])
    // 5. unregistered POS item; 6. a product deleted after its sale
    const ph = await call('POST', '/api/pos/unregistered-product', { cookie: cookies[staff], body: { name: `${tag} Loose Pant`, price: 250 } })
    await sale([line(num(ph.body.id), `${tag} Loose Pant`, 1, 250, undefined, undefined, true)])
    const gone = await prod(`${tag} Gone`, { price: 600, cost: 200 })
    await sale([line(gone, `${tag} Gone`, 1, 600)])
    const del = await call('DELETE', '/api/inventory/items', { cookie: cookies.admin, query: { product_id: String(gone), branch_id: b } })
    // 7. a discounted bill: two lines of 1000 (cost 400 each), manual discount 200 -> revenue 900 each
    const disc = await prod(`${tag} Disc`, { price: 1000, cost: 400 })
    await sale([line(disc, `${tag} Disc`, 2, 1000)], { manual_discount_amount: 200, manual_discount_type: 'flat', manual_discount_value: 200 })

    const items = (await ordersAs('admin')).flatMap((o) => o.order_items ?? []) as any[]
    const kLine = items.find((i) => i.variant_id === kM), wLine = items.find((i) => Number(i.product_id) === shirt && !i.variant_id)
    check(num(kLine?.unit_cost) === 600 && kLine?.cost_source === 'variant' && kLine?.item_state === 'ok', `${L} a size line reads the size's Cost (600, source "variant")`, JSON.stringify({ c: kLine?.unit_cost, s: kLine?.cost_source }))
    check(num(wLine?.unit_cost) === 650 && wLine?.cost_source === 'sizes_avg', `${L} a line without a size (no product cost) uses the sizes' cost averaged by units sold: (500x1 + 700x3) / 4 = 650`, JSON.stringify({ c: wLine?.unit_cost, s: wLine?.cost_source }))

    let rows = await rowsNow()
    const k = rowOf(rows, `${tag} Kurta`, 'M')
    check(!!k && k.qty === 3 && k.revenue === 3000 && k.cost === 1800 && k.profit === 1200 && k.margin === 40, `${L} sizes, Cost 600, Price 1000, 3 sold: Revenue 3000, Total Cost 1800, Net Profit 1200, Margin 40.0%`, JSON.stringify(k))
    const pl = rowOf(rows, `${tag} Plain`), nc = rowOf(rows, `${tag} NoCost`)
    check(pl?.cost === 600 && pl?.profit === 400 && nc?.missing === true && nc.cost === null && nc.profit === null && nc.margin === null && nc.state === 'ok',
      `${L} product-level cost used (2 x 300); a line with no cost anywhere has no cost / profit / margin (never 100%)`, JSON.stringify({ pl, nc }))
    const up = rowOf(rows, `${tag} Loose Pant`), dp = rowOf(rows, `${tag} Gone`)
    check(!!ph.body?.id && del.status === 200 && up?.state === 'unregistered' && up.revenue === 250 && up.missing && dp?.state === 'deleted' && dp.revenue === 600 && dp.missing,
      `${L} the unregistered POS item and the deleted product are labelled, keep their revenue (250 / 600) and show no cost`, JSON.stringify({ up, dp, del: del.status }))
    const dr = rowOf(rows, `${tag} Disc`)
    check(dr?.revenue === 1800 && dr.cost === 800 && dr.profit === 1000 && dr.margin === 55.6, `${L} a discounted bill (2 x 1000, manual 200): revenue 1800 after the discount, cost 800, profit 1000, margin 55.6%`, JSON.stringify(dr))
    const t = profitTotals(rows.filter((r) => r.name.startsWith(tag)))
    const priced = rows.filter((r) => r.name.startsWith(tag) && r.state === 'ok' && !r.missing)
    check(t.missingCount === 1 && t.noCostCount === 2 && Math.abs(t.revenue - priced.reduce((s, r) => s + r.revenue, 0)) < 0.01 && Math.abs(t.cost - priced.reduce((s, r) => s + (r.cost ?? 0), 0)) < 0.01,
      `${L} totals cover only the rows with a cost (1 without a purchase price, 2 unregistered / deleted left out)`, JSON.stringify(t))

    // a return of 1 unit: quantity, revenue, cost, profit, margin on the ORIGINAL sale
    const kItem = num((await one(`SELECT id FROM order_items WHERE order_id = $1`, [s1.order_id])).id)
    const ret = await call('POST', `/api/orders/${s1.order_id}/return`, { cookie: cookies[staff], body: { items: [{ order_item_id: kItem, quantity: 1, restock: true }], reason: 'Wrong size', refund_mode: 'cash' } })
    rows = await rowsNow()
    const k2 = rowOf(rows, `${tag} Kurta`, 'M')
    check(ret.status === 201 && k2?.qty === 2 && k2.revenue === 2000 && k2.cost === 1200 && k2.profit === 800 && k2.margin === 40, `${L} after returning 1 unit: qty 2, revenue 2000, cost 1200, profit 800, 40.0% (on the original sale)`, JSON.stringify(k2))

    // branch isolation: another branch's analytics never shows these
    const otherNames = (await call('GET', '/api/orders', { cookie: cookies.admin, query: { include_items: '1', limit: '1000', branch_id: other } })).body.orders.flatMap((o: any) => o.order_items ?? []).map((i: any) => String(i.name))
    check(!otherNames.some((nm: string) => nm.startsWith(tag)), `${L} ${other}'s analytics data has none of ${b}'s sales`)
    // Manager / Staff never receive cost or item state
    const lm = (await ordersAs(mgr)).flatMap((o) => o.order_items ?? []).find((i: any) => i.variant_id === kM)
    const ls = (await ordersAs(staff)).flatMap((o) => o.order_items ?? []).find((i: any) => i.variant_id === kM)
    check(!!lm && !!ls && !('unit_cost' in lm) && !('item_state' in lm) && !('unit_cost' in ls) && !('cost_source' in ls), `${L} Manager and Staff never receive cost, cost source or item state`)
  }
}
