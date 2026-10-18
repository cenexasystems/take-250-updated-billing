// Product-wise cost, net profit and margin: ONE calculation for the Analytics table, its mobile cards, the totals,
// the CSV and the PDF (src/pages/Dashboard.tsx, src/services/analyticsExport.ts).
//
// Input per product (or product + size) line, net of returns (returned units leave qty, revenue and cost on the
// ORIGINAL sale date): qty and revenue sold, `cost` = sum of purchase price x units over the units whose line has a
// purchase price, `costedQty` = those units. The purchase price is the line's size's, else the product's; 0 / empty
// means "never entered" and arrives as no cost. A product with ANY sold unit lacking a purchase price is "missing":
// no cost, profit or margin is shown for it (never revenue as profit, never 0 as cost) and it is left out of totals.

export type ProductCostInput = { qty: number; revenue: number; cost: number; costedQty: number }
export type ProductProfit = { missing: boolean; cost: number | null; profit: number | null; margin: number | null }
export type ProfitTotals = { revenue: number; cost: number; profit: number; margin: number | null; missingCount: number; pricedCount: number }

const r2 = (v: number) => Math.round(v * 100) / 100
const r1 = (v: number) => Math.round(v * 10) / 10

export function productProfit(p: ProductCostInput): ProductProfit {
  if (p.qty <= 0) {
    // everything sold was returned: nothing sold, nothing to cost
    return { missing: false, cost: 0, profit: r2(p.revenue), margin: p.revenue > 0 ? 100 : null }
  }
  if (p.costedQty <= 0 || p.costedQty < p.qty - 1e-9) return { missing: true, cost: null, profit: null, margin: null }
  const cost = r2(p.cost)
  const profit = r2(p.revenue - cost)
  return { missing: false, cost, profit, margin: p.revenue > 0 ? r1((profit / p.revenue) * 100) : null }
}

/** Totals over the products that have a purchase price (rows already through productProfit); the rest are counted, not added. */
export function profitTotals(rows: Array<{ revenue: number } & ProductProfit>): ProfitTotals {
  let revenue = 0, cost = 0, missingCount = 0, pricedCount = 0
  for (const row of rows) {
    if (row.missing) { missingCount++; continue }
    pricedCount++
    revenue += row.revenue
    cost += row.cost ?? 0
  }
  revenue = r2(revenue); cost = r2(cost)
  const profit = r2(revenue - cost)
  return { revenue, cost, profit, margin: revenue > 0 ? r1((profit / revenue) * 100) : null, missingCount, pricedCount }
}

/** "40.0%", or "-" when there is no revenue. */
export const formatMargin = (margin: number | null): string => (margin === null ? '-' : `${margin.toFixed(1)}%`)

/** The note under the table / in the exports, or '' when every product has a purchase price. */
export const missingCostNote = (n: number): string =>
  n <= 0 ? '' : n === 1
    ? '1 product has no purchase price; it is excluded from profit and margin totals.'
    : `${n} products have no purchase price; they are excluded from profit and margin totals.`

export const ADD_PURCHASE_PRICE = 'Add purchase price'
