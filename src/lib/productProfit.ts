// Product-wise cost, net profit and margin: ONE calculation for the Analytics Products table, its mobile cards, the
// summary tiles, the categories, the CSV and the PDF (src/pages/Dashboard.tsx, src/services/analyticsExport.ts) and the
// API tests. The server resolves each bill line's cost and state (GET /api/orders?include_items=1, Admin only):
//   unit_cost   = the line's size's purchase price, else the product's, else (a line without a size of a product that has
//                 sizes) the sizes' costs averaged by units sold; 0 / empty = never entered = null. CURRENT costs (bills keep
//                 no cost snapshot).
//   item_state  = 'ok' | 'unregistered' (a POS "Unregistered" placeholder) | 'deleted' (the product was removed)
// Here: units are net of returns and stay on the ORIGINAL sale; revenue is the line total for the units kept, less the
// bill's coupon + manual discount spread over its lines in proportion (GST and delivery are not product revenue).

export type CostSource = 'variant' | 'product' | 'sizes_avg' | null
export type ItemState = 'ok' | 'unregistered' | 'deleted'
export type ProductCostInput = { qty: number; revenue: number; cost: number; costedQty: number }
export type ProductProfit = { missing: boolean; cost: number | null; profit: number | null; margin: number | null }
export type ProfitTotals = { revenue: number; cost: number; profit: number; margin: number | null; missingCount: number; noCostCount: number; pricedCount: number }

/** One sold line, ready for analytics. */
export type AnalyticsLine = {
  order_id: string; key: string; name: string; variant: string; category: string
  qty: number; revenue: number; is_manual: boolean
  unit_cost: number | null; cost_source: CostSource; item_state: ItemState
}
/** One Products-table row (product + size). */
export type ProductRow = Omit<ProductCostInput, 'cost'> & ProductProfit & {
  key: string; name: string; variant: string; billCount: number; state: ItemState; sources: CostSource[]
}

const r2 = (v: number) => Math.round(v * 100) / 100
const r1 = (v: number) => Math.round(v * 10) / 10
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }

export function productProfit(p: ProductCostInput): ProductProfit {
  if (p.qty <= 0) return { missing: false, cost: 0, profit: r2(p.revenue), margin: p.revenue > 0 ? 100 : null } // all returned
  if (p.costedQty <= 0 || p.costedQty < p.qty - 1e-9) return { missing: true, cost: null, profit: null, margin: null }
  const cost = r2(p.cost)
  const profit = r2(p.revenue - cost)
  return { missing: false, cost, profit, margin: p.revenue > 0 ? r1((profit / p.revenue) * 100) : null }
}

type RawItem = Record<string, unknown>
type RawOrder = { id: string; discount_amount?: unknown; manual_discount_amount?: unknown; order_items?: unknown }

/** A bill's lines for analytics (see the header): net units, revenue after the bill's discounts, cost and state. */
export function analyticsLines(order: RawOrder): AnalyticsLine[] {
  const items = (Array.isArray(order.order_items) ? order.order_items : []) as RawItem[]
  const gross = items.reduce((s, i) => s + n(i.line_total), 0)
  const discount = n(order.discount_amount) + n(order.manual_discount_amount)
  const share = gross > 0 ? Math.max(0, gross - discount) / gross : 1
  return items.map((i) => {
    const bought = n(i.quantity)
    const left = Math.max(0, bought - n(i.returned_quantity))
    const rawName = String(i.name || i.product_name || 'Product').trim() || 'Product'
    let name = rawName, variant = String(i.variant_name || '').trim()
    if (!variant) { const d = rawName.indexOf(' - '); if (d > 0) { name = rawName.slice(0, d); variant = rawName.slice(d + 3) } }
    const pid = i.product_id === null || i.product_id === undefined ? '' : String(i.product_id)
    const vid = i.variant_id ? String(i.variant_id) : ''
    const state = (i.item_state === 'unregistered' || i.item_state === 'deleted' ? i.item_state : 'ok') as ItemState
    return {
      order_id: String(i.order_id || order.id),
      key: vid ? `v:${vid}` : pid ? `p:${pid}|${variant.toLowerCase()}` : `n:${name.toLowerCase()}|${variant.toLowerCase()}`,
      name, variant, category: String(i.category || ''),
      qty: left,
      revenue: bought > 0 ? r2(n(i.line_total) * (left / bought) * share) : 0,
      is_manual: Boolean(i.is_manual),
      unit_cost: i.unit_cost === null || i.unit_cost === undefined ? null : n(i.unit_cost),
      cost_source: (i.cost_source as CostSource) ?? null,
      item_state: state,
    }
  })
}

/** Lines -> Products-table rows (one per product + size), each with its cost / profit / margin, most units first. */
export function productRows(lines: AnalyticsLine[]): ProductRow[] {
  const map = new Map<string, { key: string; name: string; variant: string; qty: number; revenue: number; cost: number; costedQty: number; orders: Set<string>; state: ItemState; sources: Set<CostSource> }>()
  for (const l of lines) {
    const row = map.get(l.key) ?? { key: l.key, name: l.name, variant: l.variant, qty: 0, revenue: 0, cost: 0, costedQty: 0, orders: new Set<string>(), state: l.item_state, sources: new Set<CostSource>() }
    row.qty += l.qty; row.revenue = r2(row.revenue + l.revenue); row.orders.add(l.order_id)
    if (l.item_state !== 'ok') row.state = l.item_state
    if (l.unit_cost !== null && l.item_state === 'ok') { row.cost += l.unit_cost * l.qty; row.costedQty += l.qty; row.sources.add(l.cost_source) }
    map.set(l.key, row)
  }
  return Array.from(map.values()).map((r) => {
    const base = { qty: r.qty, revenue: r.revenue, cost: r.cost, costedQty: r.costedQty }
    // an unregistered or deleted item has no cost to read: "No cost", left out of the totals
    const pf: ProductProfit = r.state !== 'ok' ? { missing: true, cost: null, profit: null, margin: null } : productProfit(base)
    return { key: r.key, name: r.name, variant: r.variant, billCount: r.orders.size, state: r.state, sources: Array.from(r.sources), ...base, ...pf }
  }).sort((a, b) => b.qty - a.qty)
}

/** Totals over the rows that have a cost; rows without one are counted, not added. */
export function profitTotals(rows: Array<{ revenue: number; state?: ItemState } & ProductProfit>): ProfitTotals {
  let revenue = 0, cost = 0, missingCount = 0, noCostCount = 0, pricedCount = 0
  for (const row of rows) {
    if (row.state && row.state !== 'ok') { noCostCount++; continue }
    if (row.missing) { missingCount++; continue }
    pricedCount++
    revenue += row.revenue
    cost += row.cost ?? 0
  }
  revenue = r2(revenue); cost = r2(cost)
  const profit = r2(revenue - cost)
  return { revenue, cost, profit, margin: revenue > 0 ? r1((profit / revenue) * 100) : null, missingCount, noCostCount, pricedCount }
}

/** "40.0%", or "-" when there is no revenue. */
export const formatMargin = (margin: number | null): string => (margin === null ? '-' : `${margin.toFixed(1)}%`)

/** The note under the table / in the exports, or '' when every product has a purchase price. */
export const missingCostNote = (count: number): string =>
  count <= 0 ? '' : count === 1
    ? '1 product has no purchase price; it is excluded from profit and margin totals.'
    : `${count} products have no purchase price; they are excluded from profit and margin totals.`
export const noCostNote = (count: number): string =>
  count <= 0 ? '' : `${count} unregistered or deleted item${count === 1 ? ' has' : 's have'} no cost; ${count === 1 ? 'it is' : 'they are'} excluded from profit and margin totals (their revenue is kept).`
export const CURRENT_COST_NOTE = 'Costs are the current purchase prices: bills made before a cost was set use today\'s cost.'

export const ADD_PURCHASE_PRICE = 'Add purchase price'
export const NO_COST = 'No cost'
export const STATE_BADGE: Record<Exclude<ItemState, 'ok'>, string> = { unregistered: 'Unregistered item', deleted: 'Deleted product' }
