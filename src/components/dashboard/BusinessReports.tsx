import { useState } from 'react'
import { FileText, Calendar, Download, Loader2 } from 'lucide-react'
import { supabase, isSupabaseConfigured } from '../../lib/supabase'
import { branchLabel, branchShortLabel } from '../../lib/branchTheme'
import type { PosBranch } from '../../store/store'
import { buildCsv, downloadCsvFile } from '../../lib/csv'

const BRANCHES: PosBranch[] = ['pos1', 'pos2']

function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  downloadCsvFile(filename, buildCsv(header, rows))
}

export default function BusinessReports() {
  const [exporting, setExporting] = useState<string | null>(null)

  const exportMonthlyConsolidatedSales = async () => {
    if (!isSupabaseConfigured) return
    setExporting('sales')
    try {
      const monthStart = new Date()
      monthStart.setDate(1)
      monthStart.setHours(0, 0, 0, 0)

      const { data } = await supabase
        .from('orders')
        .select('invoice_no, branch, customer_name, created_at, total, subtotal, discount_amount, payment_method, status')
        .gte('created_at', monthStart.toISOString())
        .order('created_at', { ascending: false })
        .limit(5000)

      const rows = (data || []).map((o) => [
        o.invoice_no || '',
        branchLabel((o.branch as PosBranch) || 'pos1'),
        o.customer_name || 'Walk-in Customer',
        new Date(o.created_at).toISOString().slice(0, 10),
        Number(o.subtotal || 0).toFixed(2),
        Number(o.discount_amount || 0).toFixed(2),
        Number(o.total || 0).toFixed(2),
        o.payment_method || '',
        o.status || '',
      ])
      downloadCsv(
        `Monthly_Consolidated_Sales_${new Date().toISOString().slice(0, 10)}.csv`,
        ['Invoice No', 'Branch', 'Customer', 'Date', 'Subtotal', 'Discount', 'Total', 'Payment Method', 'Status'],
        rows
      )
    } catch (err) {
      console.error('[BusinessReports] sales export error', err)
    } finally {
      setExporting(null)
    }
  }

  const exportGstSummary = async () => {
    if (!isSupabaseConfigured) return
    setExporting('gst')
    try {
      const { data } = await supabase
        .from('order_items')
        .select('order_id, gst_rate, gst_amount, line_total, orders!inner(branch, invoice_no, created_at)')
        .gt('gst_amount', 0)
        .order('order_id', { ascending: false })
        .limit(5000)

      type Row = { gst_rate: number; gst_amount: number; line_total: number; orders: { branch: string; invoice_no: string; created_at: string } | { branch: string; invoice_no: string; created_at: string }[] }
      const rows = ((data || []) as unknown as Row[]).map((r) => {
        const order = Array.isArray(r.orders) ? r.orders[0] : r.orders
        return [
          order?.invoice_no || '',
          branchLabel((order?.branch as PosBranch) || 'pos1'),
          order?.created_at ? new Date(order.created_at).toISOString().slice(0, 10) : '',
          `${Number(r.gst_rate || 0)}%`,
          Number(r.line_total || 0).toFixed(2),
          Number(r.gst_amount || 0).toFixed(2),
        ]
      })
      downloadCsv(
        `Tax_GST_Summary_${new Date().toISOString().slice(0, 10)}.csv`,
        ['Invoice No', 'Branch', 'Date', 'GST Rate', 'Taxable Value', 'GST Amount'],
        rows
      )
    } catch (err) {
      console.error('[BusinessReports] gst export error', err)
    } finally {
      setExporting(null)
    }
  }

  const exportInventoryLedger = async () => {
    if (!isSupabaseConfigured) return
    setExporting('inventory')
    try {
      const results = await Promise.all(BRANCHES.map(async (branch) => {
        const { data } = await supabase
          .from('products')
          .select('name, category, sku, price, purchase_price, stock_quantity, is_active')
          .eq('branch', branch)
          .eq('is_active', true)
        return (data || []).map((p) => [
          branchLabel(branch),
          p.name,
          p.category || '',
          p.sku || '',
          Number(p.stock_quantity || 0),
          Number(p.purchase_price || 0).toFixed(2),
          Number(p.price || 0).toFixed(2),
          (Number(p.price || 0) * Number(p.stock_quantity || 0)).toFixed(2),
        ])
      }))
      downloadCsv(
        `Consolidated_Inventory_Ledger_${new Date().toISOString().slice(0, 10)}.csv`,
        ['Branch', 'Product', 'Category', 'SKU', 'Stock Qty', 'Cost Price', 'Sell Price', 'Retail Value'],
        results.flat()
      )
    } catch (err) {
      console.error('[BusinessReports] inventory export error', err)
    } finally {
      setExporting(null)
    }
  }

  const reports = [
    {
      key: 'sales',
      icon: <FileText size={20} />,
      iconBg: 'bg-amber-50 text-amber-600',
      title: 'Monthly Consolidated Sales',
      description: `Combined ledger of ${branchShortLabel('pos1')} & ${branchShortLabel('pos2')} sales, discounts, and payment methods.`,
      onExport: exportMonthlyConsolidatedSales,
    },
    {
      key: 'gst',
      icon: <Calendar size={20} />,
      iconBg: 'bg-emerald-50 text-emerald-600',
      title: 'Tax & GST Summary Report',
      description: 'GST breakdown by rate tier for input/output tax reconciliations.',
      onExport: exportGstSummary,
    },
    {
      key: 'inventory',
      icon: <FileText size={20} />,
      iconBg: 'bg-violet-50 text-violet-600',
      title: 'Consolidated Inventory Ledger',
      description: 'Current stock counts, retail values, cost values, and estimated margins.',
      onExport: exportInventoryLedger,
    },
  ]

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-black text-[#1A0E0E]">Business Reports &amp; Financial Statements</h2>
        <p className="text-xs text-gray-500 font-semibold mt-1">Generate consolidated financial audits, GST filings, and sales reports.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {reports.map((r) => (
          <div key={r.key} className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm flex flex-col">
            <div className={`w-11 h-11 rounded-xl ${r.iconBg} flex items-center justify-center mb-3`}>
              {r.icon}
            </div>
            <h3 className="text-sm font-black text-[#1A0E0E]">{r.title}</h3>
            <p className="text-xs text-gray-500 font-semibold mt-1 mb-4 flex-1">{r.description}</p>
            <button
              onClick={r.onExport}
              disabled={exporting === r.key}
              className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl text-xs font-bold text-gray-700 border border-gray-200 hover:bg-gray-50 cursor-pointer disabled:opacity-60"
            >
              {exporting === r.key ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              Export CSV
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
