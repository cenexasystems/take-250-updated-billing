import { jsPDF } from 'jspdf'
import html2canvas from 'html2canvas'
import { BRAND_EN, BRAND_ADDRESS, BRAND_PHONE_DISPLAY, THEME_PALETTE } from '../lib/brand'
import { LOGO_BASE64 } from '../lib/logoBase64'
import { formatCurrency } from '../lib/retail'

export interface AnalyticsExportData {
  totalCompletedRevenue: number
  /** refunds paid on the bills in this period (already deducted from totalCompletedRevenue) */
  totalReturned?: number
  netProfit: number
  isProfitable: boolean
  totalExpenses: number
  completedOrders: number
  posRevenue: number
  offlineOrderCount: number
  onlinePosRevenue: number
  onlineBillCount: number
  manualRevenue: number
  totalProductsSold: number
  averageRevenuePerBill: number
  bestProduct: string
  bestCategory: string
  weeklySales: Array<{ day: string; date: string; revenue: number }>
  monthlyTrend?: Array<{ month: string; key: string; revenue: number }>
  todaySales: number
  todayCompletedOrdersCount: number
  todayItemsSold: number
  todayAvgOrderValue: number
  todayHourlyTrend: Array<{ hour: string; key: string; revenue: number }>
  todayTopProducts: Array<{ name: string; qty: number; revenue: number }>
  todayBills?: Array<{ invoice_no?: string; id?: string; customer_name?: string; total: number; created_at: string; status: string; order_mode?: string }>
  topProducts: Array<{ name: string; variant?: string; qty: number; revenue: number; billCount: number }>
  topCategories: Array<{ name: string; qty: number; revenue: number }>
  categoryDist?: Array<{ name: string; value: number }>
  topCoupons: Array<{ code: string; usage: number; discounts: number }>
  totalCouponDiscounts: number
  totalCouponOrders: number
  couponUsageRate: number
  couponDailyTrend?: Array<{ day: string; date: string; orders: number; discounts: number }>
}

export type AnalyticsTabKey = 'revenue' | 'today' | 'products' | 'categories' | 'coupons' | string

interface ExportOptions {
  data: AnalyticsExportData
  activeTab: AnalyticsTabKey
  datePreset: string
  dateFrom?: string
  dateTo?: string
}

const getFilterLabel = (preset: string, from?: string, to?: string) => {
  if (from || to) return `Custom Range (${from || 'Start'} to ${to || 'End'})`
  switch (preset) {
    case 'today': return 'Today'
    case 'week': return 'This Week'
    case 'month': return 'This Month'
    case 'year': return 'This Year'
    default: return 'All Time'
  }
}

/**
 * Export Analytics to CSV format based on the selected tab and active date filter
 */
export function exportAnalyticsToCSV({ data, activeTab, datePreset, dateFrom, dateTo }: ExportOptions) {
  const filterText = getFilterLabel(datePreset, dateFrom, dateTo)
  const rows: string[][] = []

  // Brand and Metadata Header
  rows.push([`${BRAND_EN} - POS & Store Analytics Report`])
  rows.push([`Exported on: ${new Date().toLocaleString('en-IN')}`])
  rows.push([`Active View: ${activeTab.toUpperCase()}`])
  rows.push([`Filter Period: ${filterText}`])
  rows.push([])

  if (activeTab === 'revenue') {
    rows.push(['--- REVENUE & PROFIT SUMMARY ---'])
    rows.push(['Metric', 'Value'])
    rows.push(['Net Revenue (INR, after returns)', data.totalCompletedRevenue.toFixed(2)])
    rows.push(['Returned (INR, deducted on the original sale dates)', (data.totalReturned ?? 0).toFixed(2)])
    rows.push(['Total Expenses (INR)', data.totalExpenses.toFixed(2)])
    rows.push(['Net Profit / Loss (INR)', data.netProfit.toFixed(2)])
    rows.push(['Completed Bills Count', String(data.completedOrders)])
    rows.push(['Offline (Walk-in) Revenue (INR)', data.posRevenue.toFixed(2)])
    rows.push(['Offline Bills Count', String(data.offlineOrderCount)])
    rows.push(['Online Revenue (INR)', data.onlinePosRevenue.toFixed(2)])
    rows.push(['Online Bills Count', String(data.onlineBillCount)])
    rows.push(['Total Items Sold', String(Math.round(data.totalProductsSold))])
    rows.push(['Average Revenue Per Bill (INR)', data.averageRevenuePerBill.toFixed(2)])
    rows.push(['Top Performing Product', data.bestProduct])
    rows.push([])

    rows.push(['--- WEEKLY REVENUE TREND ---'])
    rows.push(['Day', 'Date', 'Revenue (INR)'])
    data.weeklySales.forEach((item) => {
      rows.push([item.day, item.date, item.revenue.toFixed(2)])
    })
    rows.push([])

    rows.push(['--- TOP PRODUCTS BY REVENUE ---'])
    rows.push(['Rank', 'Product Name', 'Quantity Sold', 'Revenue (INR)', 'Bill Count'])
    data.topProducts.slice(0, 20).forEach((item, index) => {
      rows.push([String(index + 1), item.name, String(Math.round(item.qty)), item.revenue.toFixed(2), String(item.billCount)])
    })
  } else if (activeTab === 'today') {
    rows.push(['--- TODAY\'S SALES OVERVIEW ---'])
    rows.push(['Metric', 'Value'])
    rows.push(['Today\'s Revenue (INR)', data.todaySales.toFixed(2)])
    rows.push(['Today\'s Completed Orders', String(data.todayCompletedOrdersCount)])
    rows.push(['Today\'s Items Sold', String(Math.round(data.todayItemsSold))])
    rows.push(['Today\'s Average Order Value (INR)', data.todayAvgOrderValue.toFixed(2)])
    rows.push([])

    rows.push(['--- TODAY\'S HOURLY SALES TREND ---'])
    rows.push(['Hour Slot', 'Revenue (INR)'])
    data.todayHourlyTrend.forEach((item) => {
      rows.push([item.hour, item.revenue.toFixed(2)])
    })
    rows.push([])

    rows.push(['--- TOP PRODUCTS SOLD TODAY ---'])
    rows.push(['Rank', 'Product Name', 'Units Sold', 'Revenue (INR)'])
    data.todayTopProducts.forEach((item, index) => {
      rows.push([String(index + 1), item.name, String(Math.round(item.qty)), item.revenue.toFixed(2)])
    })
  } else if (activeTab === 'products') {
    rows.push(['--- PRODUCT PERFORMANCE BREAKDOWN ---'])
    rows.push(['Rank', 'Product Name', 'Variant', 'Units Sold', 'Revenue (INR)', 'Bill Count'])
    data.topProducts.forEach((item, index) => {
      rows.push([
        String(index + 1),
        item.name,
        item.variant || '-',
        String(Math.round(item.qty)),
        item.revenue.toFixed(2),
        String(item.billCount),
      ])
    })
    rows.push([])

    rows.push(['--- CATEGORY PERFORMANCE ---'])
    rows.push(['Rank', 'Category Name', 'Units Sold', 'Revenue (INR)'])
    data.topCategories.forEach((cat, index) => {
      rows.push([String(index + 1), cat.name, String(Math.round(cat.qty)), cat.revenue.toFixed(2)])
    })
  } else if (activeTab === 'coupons') {
    rows.push(['--- COUPON PERFORMANCE SUMMARY ---'])
    rows.push(['Metric', 'Value'])
    rows.push(['Total Discount Given via Coupons (INR)', data.totalCouponDiscounts.toFixed(2)])
    rows.push(['Total Coupon Usage Count', String(data.totalCouponOrders)])
    rows.push(['Coupon Usage Rate (%)', `${data.couponUsageRate.toFixed(1)}%`])
    rows.push([])

    rows.push(['--- COUPON USAGE LIST ---'])
    rows.push(['Rank', 'Coupon Code', 'Times Used', 'Total Discounts (INR)'])
    data.topCoupons.forEach((coupon, index) => {
      rows.push([String(index + 1), coupon.code, String(coupon.usage), coupon.discounts.toFixed(2)])
    })
  }

  // Convert array rows to CSV with proper escaping
  const csvContent = rows
    .map((row) =>
      row
        .map((col) => {
          const str = String(col ?? '')
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`
          }
          return str
        })
        .join(',')
    )
    .join('\r\n')

  const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `TAKE250_Analytics_${activeTab}_${datePreset || 'all'}_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Export Analytics to a luxury formatted PDF including rendered Chart Diagrams
 */
export async function exportAnalyticsToPDF({
  data,
  activeTab,
  datePreset,
  dateFrom,
  dateTo,
}: ExportOptions): Promise<void> {
  const filterText = getFilterLabel(datePreset, dateFrom, dateTo)
  const nowStr = new Date().toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  // Find max weekly revenue for bar height normalization
  const maxWeeklyRev = Math.max(1, ...data.weeklySales.map((s) => s.revenue))
  const maxHourlyRev = Math.max(1, ...data.todayHourlyTrend.map((s) => s.revenue))
  const totalCatRev = Math.max(1, data.topCategories.reduce((sum, c) => sum + c.revenue, 0))

  // Create an offscreen container specifically styled for clean A4 printing
  const container = document.createElement('div')
  container.style.position = 'fixed'
  container.style.left = '-9999px'
  container.style.top = '0'
  container.style.width = '794px' // Standard A4 at 96 DPI
  container.style.backgroundColor = '#FFFFFF'
  container.style.color = THEME_PALETTE.primary
  container.style.fontFamily = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif"
  container.style.padding = '28px 32px'
  container.style.boxSizing = 'border-box'

  container.innerHTML = `
    <div style="width: 100%; box-sizing: border-box;">
      <!-- Header Banner -->
      <div style="display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #D4AF37; padding-bottom: 14px; margin-bottom: 18px;">
        <div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <div style="width: 44px; height: 44px; border-radius: 10px; background: ${THEME_PALETTE.primary}; border: 1.5px solid #D4AF37; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: 2px; box-sizing: border-box; flex-shrink: 0;">
              <img src="${LOGO_BASE64}" style="width: 100%; height: 100%; object-fit: contain; display: block;" alt="Logo" />
            </div>
            <div>
              <h1 style="margin: 0; font-size: 20px; font-weight: 900; letter-spacing: 0.5px; color: ${THEME_PALETTE.primary}; text-transform: uppercase; line-height: 1.15;">${BRAND_EN}</h1>
              <p style="margin: 3px 0 0 0; font-size: 10px; font-weight: 700; color: ${THEME_PALETTE.accentDark};">Executive POS & Store Analytics Intelligence</p>
            </div>
          </div>
          <p style="margin: 6px 0 0 0; font-size: 9px; color: #666; padding-left: 2px;">${BRAND_ADDRESS ? `${BRAND_ADDRESS} • ` : ''}Tel: ${BRAND_PHONE_DISPLAY}</p>
        </div>
        <div style="text-align: right; display: flex; flex-direction: column; align-items: flex-end;">
          <span style="display: inline-block; padding: 4px 10px; background: ${THEME_PALETTE.primary}; color: ${THEME_PALETTE.onDark}; font-size: 9.5px; font-weight: 800; border-radius: 6px; text-transform: uppercase; margin-bottom: 4px; letter-spacing: 0.5px;">
            ${activeTab.toUpperCase()} VIEW
          </span>
          <p style="margin: 0; font-size: 9.5px; font-weight: 700; color: #333;">Period: <span style="color: ${THEME_PALETTE.primary}; font-weight: 900;">${filterText}</span></p>
          <p style="margin: 2px 0 0 0; font-size: 8.5px; color: #6B7280;">Generated: ${nowStr}</p>
        </div>
      </div>

      <!-- KPI Summary Cards Grid -->
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 18px;">
        <div style="background: #FBF9F4; border: 1px solid #E8D399; border-radius: 12px; padding: 12px 14px; min-height: 84px; display: flex; flex-direction: column; justify-content: space-between; box-sizing: border-box;">
          <div style="font-size: 8.5px; font-weight: 800; text-transform: uppercase; color: #666; margin-bottom: 4px; letter-spacing: 0.3px;">${(data.totalReturned ?? 0) > 0 ? 'Net Revenue' : 'Total Revenue'}</div>
          <div style="font-size: 16px; font-weight: 900; color: ${THEME_PALETTE.primary}; line-height: 1.2;">${formatCurrency(data.totalCompletedRevenue)}</div>
          <div style="font-size: 8px; color: #047857; font-weight: 700; margin-top: 4px;">${(data.totalReturned ?? 0) > 0 ? `After returns: ${formatCurrency(data.totalReturned ?? 0)} returned` : 'POS & Walk-in sales'}</div>
        </div>
        <div style="background: ${data.isProfitable ? '#ECFDF5' : '#FFF1F2'}; border: 1px solid ${data.isProfitable ? '#A7F3D0' : '#FECDD3'}; border-radius: 12px; padding: 12px 14px; min-height: 84px; display: flex; flex-direction: column; justify-content: space-between; box-sizing: border-box;">
          <div style="font-size: 8.5px; font-weight: 800; text-transform: uppercase; color: ${data.isProfitable ? '#065F46' : '#9F1239'}; margin-bottom: 4px; letter-spacing: 0.3px;">${data.isProfitable ? 'Net Profit' : 'Net Loss'}</div>
          <div style="font-size: 16px; font-weight: 900; color: ${data.isProfitable ? '#047857' : '#E11D48'}; line-height: 1.2;">${formatCurrency(Math.abs(data.netProfit))}</div>
          <div style="font-size: 8px; color: #666; font-weight: 700; margin-top: 4px;">Rev − ${formatCurrency(data.totalExpenses)} Exp</div>
        </div>
        <div style="background: #FBF9F4; border: 1px solid #E8D399; border-radius: 12px; padding: 12px 14px; min-height: 84px; display: flex; flex-direction: column; justify-content: space-between; box-sizing: border-box;">
          <div style="font-size: 8.5px; font-weight: 800; text-transform: uppercase; color: #666; margin-bottom: 4px; letter-spacing: 0.3px;">Completed Bills</div>
          <div style="font-size: 16px; font-weight: 900; color: ${THEME_PALETTE.primary}; line-height: 1.2;">${data.completedOrders} Orders</div>
          <div style="font-size: 8px; color: ${THEME_PALETTE.accentDark}; font-weight: 700; margin-top: 4px;">Avg ${formatCurrency(data.averageRevenuePerBill)}/bill</div>
        </div>
        <div style="background: #FBF9F4; border: 1px solid #E8D399; border-radius: 12px; padding: 12px 14px; min-height: 84px; display: flex; flex-direction: column; justify-content: space-between; box-sizing: border-box;">
          <div style="font-size: 8.5px; font-weight: 800; text-transform: uppercase; color: #666; margin-bottom: 4px; letter-spacing: 0.3px;">Total Items Sold</div>
          <div style="font-size: 16px; font-weight: 900; color: ${THEME_PALETTE.primary}; line-height: 1.2;">${Math.round(data.totalProductsSold)} Pcs</div>
          <div style="font-size: 8px; color: #4F46E5; font-weight: 700; margin-top: 4px;">Top: ${data.bestProduct.slice(0, 14)}</div>
        </div>
      </div>

      <!-- CHART DIAGRAM SECTION WITH DEDICATED AXIS AND NO OVERLAP -->
      <div style="background: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 14px; padding: 14px 16px; margin-bottom: 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.03);">
        <!-- Chart Header -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <div>
            <h3 style="margin: 0; font-size: 12px; font-weight: 900; color: ${THEME_PALETTE.primary}; text-transform: uppercase; letter-spacing: 0.5px;">
              ${activeTab === 'today' ? "Today's Hourly Sales Velocity Diagram" : 'Weekly Revenue Trend & Performance Chart'}
            </h3>
            <p style="margin: 2px 0 0 0; font-size: 9px; color: #6B7280;">Visual daily distribution of sales revenue</p>
          </div>
          <div style="font-size: 9.5px; font-weight: 800; color: ${THEME_PALETTE.accentDark}; background: #FBFAF6; border: 1px solid #E8D399; padding: 3px 8px; border-radius: 6px;">
            ${activeTab === 'today' ? `Peak Hour: ${formatCurrency(maxHourlyRev)}` : `Week Peak: ${formatCurrency(maxWeeklyRev)}`}
          </div>
        </div>

        <!-- Rendered Bar Chart Graphic -->
        ${
          activeTab === 'today'
            ? `
          <!-- Bars Container (Fixed Height 85px) -->
          <div style="display: flex; align-items: flex-end; justify-content: space-between; height: 85px; padding: 0 4px; box-sizing: border-box;">
            ${data.todayHourlyTrend
              .filter((_, idx) => idx >= 8 && idx <= 22)
              .map((h) => {
                const barHeight = Math.max(3, Math.round((h.revenue / maxHourlyRev) * 54))
                return `
                <div style="display: flex; flex-direction: column; align-items: center; justify-content: flex-end; flex: 1; margin: 0 2px; height: 100%;">
                  <span style="font-size: 7.5px; font-weight: 800; color: ${h.revenue > 0 ? THEME_PALETTE.primary : '#6B7280'}; margin-bottom: 4px; line-height: 1;">
                    ${h.revenue > 0 ? '₹' + Math.round(h.revenue) : ''}
                  </span>
                  <div style="width: 100%; max-width: 22px; height: ${barHeight}px; background: ${h.revenue > 0 ? THEME_PALETTE.primary : '#F3F4F6'}; border-radius: 3px 3px 0 0;"></div>
                </div>
              `
              })
              .join('')}
          </div>

          <!-- X-Axis Divider -->
          <div style="width: 100%; height: 1.5px; background: ${THEME_PALETTE.primary}; margin: 0;"></div>

          <!-- X-Axis Labels -->
          <div style="display: flex; justify-content: space-between; padding: 6px 4px 0 4px;">
            ${data.todayHourlyTrend
              .filter((_, idx) => idx >= 8 && idx <= 22)
              .map(
                (h) => `
              <div style="display: flex; flex-direction: column; align-items: center; flex: 1; margin: 0 2px;">
                <span style="font-size: 7.5px; font-weight: 700; color: #555; white-space: nowrap; line-height: 1;">${h.hour}</span>
              </div>
            `
              )
              .join('')}
          </div>
        `
            : `
          <!-- Bars Container (Fixed Height 85px) -->
          <div style="display: flex; align-items: flex-end; justify-content: space-between; height: 85px; padding: 0 8px; box-sizing: border-box;">
            ${data.weeklySales
              .map((w) => {
                const barHeight = Math.max(3, Math.round((w.revenue / maxWeeklyRev) * 54))
                return `
                <div style="display: flex; flex-direction: column; align-items: center; justify-content: flex-end; flex: 1; margin: 0 6px; height: 100%;">
                  <span style="font-size: 8.5px; font-weight: 800; color: ${w.revenue > 0 ? THEME_PALETTE.primary : '#6B7280'}; margin-bottom: 4px; line-height: 1;">
                    ${w.revenue > 0 ? '₹' + Math.round(w.revenue).toLocaleString('en-IN') : '—'}
                  </span>
                  <div style="width: 100%; max-width: 44px; height: ${barHeight}px; background: ${w.revenue > 0 ? THEME_PALETTE.primary : '#E5E7EB'}; border-radius: 4px 4px 0 0;"></div>
                </div>
              `
              })
              .join('')}
          </div>

          <!-- X-Axis Divider -->
          <div style="width: 100%; height: 1.5px; background: ${THEME_PALETTE.primary}; margin: 0;"></div>

          <!-- X-Axis Labels -->
          <div style="display: flex; justify-content: space-between; padding: 6px 8px 0 8px;">
            ${data.weeklySales
              .map(
                (w) => `
              <div style="display: flex; flex-direction: column; align-items: center; flex: 1; margin: 0 6px;">
                <span style="font-size: 9px; font-weight: 800; color: #111; line-height: 1.2;">${w.day}</span>
                <span style="font-size: 8px; font-weight: 600; color: #666; margin-top: 2px; line-height: 1;">${w.date.slice(5)}</span>
              </div>
            `
              )
              .join('')}
          </div>
        `
        }
      </div>

      <!-- TWO COLUMN SECTION: TOP PRODUCTS & CATEGORY BREAKDOWN -->
      <div style="display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 14px; margin-bottom: 20px; align-items: stretch;">
        <!-- Top Products List -->
        <div style="background: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 14px; padding: 14px; display: flex; flex-direction: column; justify-content: space-between;">
          <div>
            <h3 style="margin: 0 0 10px 0; font-size: 11.5px; font-weight: 900; color: ${THEME_PALETTE.primary}; text-transform: uppercase; letter-spacing: 0.3px;">
              Top Performing Products
            </h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 8.5px;">
              <thead>
                <tr style="border-bottom: 1.5px solid #E5E7EB; text-align: left; color: #666; text-transform: uppercase; font-size: 7.5px;">
                  <th style="padding: 4px 0;">#</th>
                  <th style="padding: 4px 0;">Product</th>
                  <th style="padding: 4px 0; text-align: right;">Qty</th>
                  <th style="padding: 4px 0; text-align: right;">Revenue</th>
                </tr>
              </thead>
              <tbody>
                ${data.topProducts
                  .slice(0, 5)
                  .map(
                    (p, idx) => `
                  <tr style="border-bottom: 1px solid #F3F4F6;">
                    <td style="padding: 5px 0; font-weight: 800; color: #6B7280;">${idx + 1}</td>
                    <td style="padding: 5px 0; font-weight: 700; color: #111; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${p.name}</td>
                    <td style="padding: 5px 0; text-align: right; font-weight: 800; color: #4B5563;">${Math.round(p.qty)} pcs</td>
                    <td style="padding: 5px 0; text-align: right; font-weight: 900; color: ${THEME_PALETTE.primary};">${formatCurrency(p.revenue)}</td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Category Breakdown Bar Diagram -->
        <div style="background: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 14px; padding: 14px; display: flex; flex-direction: column; justify-content: space-between;">
          <div>
            <h3 style="margin: 0 0 10px 0; font-size: 11.5px; font-weight: 900; color: ${THEME_PALETTE.primary}; text-transform: uppercase; letter-spacing: 0.3px;">
              Category Revenue Share
            </h3>
            <div style="display: flex; flex-direction: column; gap: 8px;">
              ${data.topCategories
                .slice(0, 5)
                .map((c) => {
                  const percent = Math.round((c.revenue / totalCatRev) * 100) || 0
                  return `
                  <div>
                    <div style="display: flex; justify-content: space-between; font-size: 8px; font-weight: 700; margin-bottom: 2px;">
                      <span style="color: #111;">${c.name}</span>
                      <span style="color: ${THEME_PALETTE.primary}; font-weight: 900;">${formatCurrency(c.revenue)} (${percent}%)</span>
                    </div>
                    <div style="width: 100%; height: 5px; background: #F3F4F6; border-radius: 3px; overflow: hidden;">
                      <div style="width: ${percent}%; height: 100%; background: #D4AF37; border-radius: 3px;"></div>
                    </div>
                  </div>
                `
                })
                .join('')}
            </div>
          </div>
        </div>
      </div>

      <!-- COUPON & DISCOUNTS LEDGER SUMMARY -->
      ${
        data.topCoupons.length > 0
          ? `
        <div style="background: #FBFAF6; border: 1px solid #E8D399; border-radius: 12px; padding: 10px 12px; margin-bottom: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <div style="font-size: 10px; font-weight: 900; color: ${THEME_PALETTE.primary}; text-transform: uppercase;">Coupon & Promotional Discount Insights</div>
            <div style="font-size: 8.5px; font-weight: 800; color: ${THEME_PALETTE.accentDark};">Total Savings: ${formatCurrency(data.totalCouponDiscounts)}</div>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            ${data.topCoupons
              .slice(0, 4)
              .map(
                (cp) => `
              <div style="background: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 6px; padding: 4px 8px; font-size: 8px;">
                <span style="font-family: monospace; font-weight: 900; color: ${THEME_PALETTE.primary}; background: #F3F4F6; padding: 1px 3px; border-radius: 3px;">${cp.code}</span>
                <span style="color: #666; margin-left: 4px;">${cp.usage} uses • <b>${formatCurrency(cp.discounts)}</b></span>
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      `
          : ''
      }

      <!-- Footer Stamp -->
      <div style="border-top: 1px solid #E5E7EB; padding-top: 8px; display: flex; justify-content: space-between; align-items: center; font-size: 7.5px; color: #6B7280;">
        <div>${BRAND_EN} POS System • Confidential Store Performance Report</div>
        <div>Page 1 of 1</div>
      </div>
    </div>
  `

  document.body.appendChild(container)

  try {
    const canvas = await html2canvas(container, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: '#FFFFFF',
    })

    const imgData = canvas.toDataURL('image/jpeg', 0.95)
    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
    })

    const pdfWidth = 210
    const pdfHeight = (canvas.height * pdfWidth) / canvas.width

    pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, Math.min(297, pdfHeight))
    pdf.save(`TAKE250_Analytics_Report_${activeTab}_${datePreset || 'all'}_${new Date().toISOString().slice(0, 10)}.pdf`)
  } catch (error) {
    console.error('Failed to generate Analytics PDF:', error)
    throw error
  } finally {
    document.body.removeChild(container)
  }
}
