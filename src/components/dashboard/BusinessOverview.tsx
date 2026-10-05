import { useEffect, useState, useCallback } from 'react'
import { RefreshCw, TrendingUp, Receipt, Boxes, AlertTriangle, Store } from 'lucide-react'
import { api } from '../../lib/apiClient'
import type { PosBranch } from '../../store/store'
import { posAccent, branchLabel, branchLogo, branchShortLabel } from '../../lib/branchTheme'
import { formatCurrency } from '../../lib/retail'
import { BRAND_EN } from '../../lib/brand'
import type { TabKey } from '../../pages/Dashboard'

const BRANCHES: PosBranch[] = ['pos1', 'pos2', 'pos3']

type BranchStats = {
  todaySales: number
  bills: number
  stockValue: number
  lowStock: number
  lowStockItems: string[]
}

const emptyStats = (): BranchStats => ({ todaySales: 0, bills: 0, stockValue: 0, lowStock: 0, lowStockItems: [] })

interface BusinessOverviewProps {
  onNavigate: (tab: TabKey, branch?: PosBranch) => void
}

export default function BusinessOverview({ onNavigate }: BusinessOverviewProps) {
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<Record<PosBranch, BranchStats>>({ pos1: emptyStats(), pos2: emptyStats(), pos3: emptyStats() })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)

      const results = await Promise.all(BRANCHES.map(async (branch) => {
        // the admin reads each branch explicitly (this view is admin-only; the server validates every branch id)
        const [{ orders }, { products }] = await Promise.all([
          api<{ orders: Array<Record<string, any>> }>('GET', '/api/orders', { query: { from: todayStart.toISOString(), limit: 1000 }, branchId: branch }),
          api<{ products: Array<Record<string, any>> }>('GET', '/api/products', { branchId: branch }),
        ])

        // Same definition as POS Analytics: completed/paid bills, excluding website (online) requests
        const validOrders = (orders || []).filter((o) => {
          const status = String(o.status || '').trim().toLowerCase()
          const type = String(o.order_type || '').trim().toLowerCase()
          return (status === 'completed' || status === 'paid') && type !== 'online_request' && type !== 'whatsapp_request'
        })
        const todaySales = validOrders.reduce((sum, o) => sum + (Number(o.total) || 0), 0)
        const stockValue = (products || []).reduce((sum, p) => sum + (Number(p.price) || 0) * (Number(p.stock_quantity) || 0), 0)
        const low = (products || []).filter((p) => (Number(p.stock_quantity) || 0) <= (Number(p.low_stock_alert) > 0 ? Number(p.low_stock_alert) : 5))

        return [branch, {
          todaySales,
          bills: validOrders.length,
          stockValue,
          lowStock: low.length,
          lowStockItems: low.slice(0, 3).map((p) => p.name),
        }] as [PosBranch, BranchStats]
      }))

      setStats(Object.fromEntries(results) as Record<PosBranch, BranchStats>)
    } catch (err) {
      console.error('[BusinessOverview] load error', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const sumOf = (pick: (x: BranchStats) => number) => BRANCHES.reduce((n, b) => n + pick(stats[b]), 0)
  const combinedSales = sumOf((x) => x.todaySales)
  const combinedBills = sumOf((x) => x.bills)
  const combinedStockValue = sumOf((x) => x.stockValue)
  const alertBranches = BRANCHES.filter((b) => stats[b].lowStock > 0)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-black text-[#1A0E0E]">Business Overview</h2>
            <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-black uppercase">Live Aggregation</span>
          </div>
          <p className="text-xs text-gray-500 font-semibold mt-1">Consolidated real-time operational metrics across {BRANCHES.map((b) => branchShortLabel(b)).join(', ')}.</p>
        </div>
        <button onClick={() => void load()} className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 text-xs font-bold text-gray-600 hover:bg-gray-50 cursor-pointer">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-black uppercase tracking-wide text-gray-400">Today's Consolidated Sales</p>
            <TrendingUp size={15} className="text-emerald-600" />
          </div>
          <p className="text-xl font-black text-[#1A0E0E]">{formatCurrency(combinedSales)}</p>
          <p className="text-[10px] text-emerald-600 font-bold mt-1">Across all active retail branches</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-black uppercase tracking-wide text-gray-400">Total Invoices Issued</p>
            <Receipt size={15} className="text-[#8A6A0A]" />
          </div>
          <p className="text-xl font-black text-[#1A0E0E]">{combinedBills}</p>
          <p className="text-[10px] text-gray-400 font-bold mt-1">Completed POS checkout orders today</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-black uppercase tracking-wide text-gray-400">Consolidated Stock Value</p>
            <Boxes size={15} className="text-violet-600" />
          </div>
          <p className="text-xl font-black text-[#1A0E0E]">{formatCurrency(combinedStockValue)}</p>
          <p className="text-[10px] text-violet-600 font-bold mt-1">Retail inventory across {BRANCHES.length} locations</p>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-[10px] font-black uppercase tracking-wider text-gray-400">Operating Branch Nodes</p>
          <p className="text-[10px] text-gray-400 font-semibold">Autonomous Branch Workspaces</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {BRANCHES.map((b) => {
            const accent = posAccent(b)
            const s = stats[b]
            return (
              <div key={b} className={`bg-white border-2 ${accent.border} rounded-2xl p-4 shadow-sm`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2.5">
                    <div className={`w-10 h-10 rounded-xl ${accent.bgLight} p-1.5 flex items-center justify-center`}>
                      <img src={branchLogo(b)} alt={BRAND_EN} className="w-full h-full object-contain" />
                    </div>
                    <div>
                      <p className="text-sm font-black text-[#1A0E0E]">{branchLabel(b)}</p>
                      <p className="text-[10px] text-gray-400 font-semibold">{BRAND_EN}</p>
                    </div>
                  </div>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black uppercase ${accent.bgLight} ${accent.text}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${accent.bg}`} /> Operational
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  <div className={`${accent.bgLight} rounded-xl p-2 text-center`}>
                    <p className="text-[9px] font-black uppercase text-gray-500">Today Sales</p>
                    <p className="text-xs font-black text-[#1A0E0E]">{formatCurrency(s.todaySales)}</p>
                  </div>
                  <div className={`${accent.bgLight} rounded-xl p-2 text-center`}>
                    <p className="text-[9px] font-black uppercase text-gray-500">Bills</p>
                    <p className="text-xs font-black text-[#1A0E0E]">{s.bills}</p>
                  </div>
                  <div className={`${accent.bgLight} rounded-xl p-2 text-center`}>
                    <p className="text-[9px] font-black uppercase text-gray-500">Low Stock</p>
                    <p className={`text-xs font-black ${s.lowStock > 0 ? 'text-red-600' : 'text-[#1A0E0E]'}`}>{s.lowStock} items</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => onNavigate('billing', b)}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-black text-white ${accent.bg} hover:opacity-90 cursor-pointer`}
                  >
                    <Store size={13} /> Store Dashboard &amp; POS
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {alertBranches.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-xs font-black text-amber-900">Attention Required Across Branches</p>
              <ul className="mt-1.5 space-y-1">
                {alertBranches.map((b) => (
                  <li key={b} className="text-xs text-amber-700 font-semibold">
                    <span className="font-black">{branchLabel(b)}:</span> {stats[b].lowStock} item{stats[b].lowStock === 1 ? '' : 's'} at or below minimum stock threshold
                    {stats[b].lowStockItems.length > 0 && ` (${stats[b].lowStockItems.join(', ')}${stats[b].lowStock > 3 ? ', …' : ''})`}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
