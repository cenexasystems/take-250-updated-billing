// Scanned barcode of a product with sizes must add that SIZE at the size's own price (never the product's price or offer
// price). Written once, run by scripts/test-api.ts (part 8) and the in-memory harness, on every branch.
import fs from 'node:fs'
import type { Actor, ReturnsCtx } from './returnsSuite'
import { cartUnitPrice, scanPayload, type ScanRecord } from '../../src/lib/cartPrice'

export type PosPriceCtx = Omit<ReturnsCtx, 'concurrent'>
type CallOpts = { cookie?: string; body?: unknown; query?: Record<string, string> }

export async function posPriceSuite(c: PosPriceCtx) {
  const { q, check, cookies } = c
  const call = c.call as unknown as (m: string, p: string, o?: CallOpts) => Promise<{ status: number; body: any }>
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0]
  const num = (v: unknown) => Number(v)
  const branches = c.branches.filter((x) => !c.only || x === c.only)

  // the shared rule, once
  check(cartUnitPrice({ price: 199, offerPrice: 199 }, { price: 1599 }) === 1599 && cartUnitPrice({ price: 249, offerPrice: 199 }, null) === 199 && cartUnitPrice({ price: 249, offerPrice: null }) === 249
    && cartUnitPrice({ price: 249, offerPrice: 199 }, { price: 0 }) === 199,
    'cart price: a size uses its own price; no size -> offer price, else price (one function for every add path)')

  for (const b of branches) {
    const n = b.slice(-1), L = `[${b}] scan price:`
    const staff = `staff${n}` as Actor, other = c.branches.find((x) => x !== b)!
    // "lalith": product price 249 / offer 199; sizes XS 1599 (registered in barcode_registry) and M 299 (size barcode)
    const pid = num((await one(`INSERT INTO products (name, category, price, offer_price, stock_quantity, stock, branch_id, is_active, has_variants, purchase_price, sku)
      VALUES ($1, 'Scan Cat', 249, 199, 0, 0, $2, true, true, 100, $3) RETURNING id`, [`Scan Lalith ${n}`, b, `SKU-SCAN-${n}`])).id)
    const xs = (await one(`INSERT INTO product_variants (product_id, variant_name, size_label, price, stock, branch_id, is_active) VALUES ($1, 'XS', 'XS', 1599, 10, $2, true) RETURNING id`, [pid, b])).id
    const m = (await one(`INSERT INTO product_variants (product_id, variant_name, size_label, price, stock, branch_id, is_active, barcode) VALUES ($1, 'M', 'M', 299, 10, $2, true, $3) RETURNING id`, [pid, b, `T25166916${n}4`])).id
    await q(`INSERT INTO barcode_registry (barcode_value, entity_type, product_id, variant_id, branch_id, created_by_name) VALUES ($1, 'variant', $2, $3, $4, 'test')`, [`T25182528${n}9`, pid, xs, b])
    const plain = num((await one(`INSERT INTO products (name, category, price, offer_price, stock_quantity, stock, branch_id, is_active, barcode, sku) VALUES ($1, 'Scan Cat', 500, 450, 10, 10, $2, true, $3, $4) RETURNING id`, [`Scan Plain ${n}`, b, `PLAIN-SCAN-${n}`, `SKU-PLAIN-${n}`])).id)

    const look = (code: string, who: Actor = staff) => call('GET', '/api/barcodes/lookup', { cookie: cookies[who], query: { code } })
    const lx = await look(`T25182528${n}9`), lm = await look(`T25166916${n}4`), lp = await look(`PLAIN-SCAN-${n}`)
    check(lx.status === 200 && lx.body.record.variant_id === xs && num(lx.body.record.variant.price) === 1599 && num(lx.body.record.variant.stock) === 10, `${L} the XS barcode (registry) returns size XS with its own price 1599 and stock`, JSON.stringify(lx.body?.record?.variant))
    check(lm.status === 200 && lm.body.record.variant_id === m && num(lm.body.record.variant.price) === 299, `${L} the M barcode (size barcode) returns size M with its own price 299`, JSON.stringify(lm.body?.record?.variant))
    check((await look(`T25182528${n}9`, `staff${other.slice(-1)}` as Actor)).status === 404, `${L} another branch's barcode is "not found"`)

    // what the POS puts in the cart for each scan (the shared builder + rule the screen uses)
    const price = (r: any) => { const p = scanPayload(r as ScanRecord, 'x'); return cartUnitPrice({ price: p.price, offerPrice: p.offer_price }, p.variant_id ? { price: p.variant_price } : null) }
    check(price(lx.body.record) === 1599 && price(lm.body.record) === 299 && price(lp.body.record) === 450 && num(lp.body.record.product_id) === plain && !lp.body.record.variant_id, `${L} scan XS adds 1599, scan M adds 299 (not the product's 199); a product without sizes keeps its offer price 450`)

    // the sale stores the line at that price and takes the stock from that size
    const sale = async (items: unknown[]) => call('POST', '/api/pos/sale', { cookie: cookies[staff], body: { customer_name: `Scan Customer ${n}`, phone: '9876500044', payment_method: 'cash', items } })
    const s1 = await sale([
      { product_id: pid, variant_id: xs, quantity: 2, unit_price: 1599, line_total: 3198, name: `Scan Lalith ${n}`, variant_name: 'XS' },
      { product_id: pid, variant_id: m, quantity: 1, unit_price: 299, line_total: 299, name: `Scan Lalith ${n}`, variant_name: 'M' }])
    const lines = await q(`SELECT variant_id, unit_price, quantity FROM order_items WHERE order_id = $1 ORDER BY unit_price DESC`, [s1.body.order_id])
    const stock = await q(`SELECT id, stock FROM product_variants WHERE id = ANY($1::uuid[]) ORDER BY price DESC`, [[xs, m]])
    check(s1.status === 201 && lines.length === 2 && lines[0].variant_id === xs && num(lines[0].unit_price) === 1599 && num(lines[0].quantity) === 2 && lines[1].variant_id === m && num(lines[1].unit_price) === 299
      && num(stock[0].stock) === 8 && num(stock[1].stock) === 9,
      `${L} the bill stores XS x2 at 1599 and M x1 at 299 as separate lines; stock comes off each size (XS 10 -> 8, M 10 -> 9)`, JSON.stringify({ lines, stock }))
    // an edited rate is still taken as typed (the server stores the line price the POS sends)
    const s2 = await sale([{ product_id: pid, variant_id: xs, quantity: 1, unit_price: 1500, line_total: 1500, name: `Scan Lalith ${n}`, variant_name: 'XS' }])
    check(s2.status === 201 && num((await one(`SELECT unit_price FROM order_items WHERE order_id = $1`, [s2.body.order_id])).unit_price) === 1500, `${L} an edited rate (1500) is still stored as typed`)

    // the read-only affected-bills report: a line charged the product's offer price for a size is listed, correct lines are not
    const bad = await sale([{ product_id: pid, variant_id: m, quantity: 1, unit_price: 199, line_total: 199, name: `Scan Lalith ${n}`, variant_name: 'M' }])
    const report = fs.readFileSync(new URL('../../db/reports/affected_variant_price_bills.sql', import.meta.url), 'utf8').replace(/^--.*$/gm, '').replace(/;\s*$/, '')
    const hits = (await q(report)).filter((r: any) => r.branch_id === b)
    const badNo = (await one(`SELECT invoice_no FROM orders WHERE id = $1`, [bad.body.order_id])).invoice_no
    check(hits.some((r: any) => r.invoice_no === badNo && num(r.charged_unit_price) === 199 && num(r.size_price) === 299) && !hits.some((r: any) => r.invoice_no !== badNo && r.item === `Scan Lalith ${n}`),
      `${L} the affected-bills report lists the size line charged 199 (size price 299) and none of the correct ones`, JSON.stringify(hits).slice(0, 200))
  }
}
