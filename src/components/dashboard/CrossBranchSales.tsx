import { useEffect, useState, useCallback } from 'react'
import { RefreshCw, Store } from 'lucide-react'
import { supabase, isSupabaseConfigured } from '../../lib/supabase'
import type { PosBranch } from '../../store/store'
import { posAccent, branchLabel, branchLogo, branchShortLabel } from '../../lib/branchTheme'
import { formatCurrency } from '../../lib/retail'
import { BRAND_EN } from '../../lib/brand'
import type { TabKey } from '../../pages/Dashboard'

const BRANCHES: PosBranch[] = ['pos1', 'pos2', 'pos3']

type BranchSales = {
  revenue: number
  txns: number
  avgBasket: number
  marginPct: number
}

const empty = (): BranchSales => ({ revenue: 0, txns: 0, avgBasket: 0, marginPct: 0 })

interface CrossBranchSalesProps {
  onNavigate: (tab: TabKey, branch?: PosBranch) => void
}

export default function CrossBranchSales({ onNavigate }: CrossBranchSalesProps) {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<Record<PosBranch, BranchSales>>({ pos1: empty(), pos2: empty(), pos3: empty() })

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const monthStart = new Date()
      monthStart.setDate(1)
      monthStart.setHours(0, 0, 0, 0)

      const results = await Promise.all(BRANCHES.map(async (branch) => {
        const [{ data: orders }, { data: products }] = await Promise.all([
          supabase.from('orders').select('total, subtotal, status').eq('branch', branch).gte('created_at', monthStart.toISOString()).limit(5000),
          supabase.from('products').select('price, purchase_price').eq('branch', branch).eq('is_active', true),
        ])

        const rows = (orders || []).filter((o) => String(o.status || '').toLowerCase() !== 'cancelled')
        const revenue = rows.reduce((sum, o) => sum + (Number(o.total) || 0), 0)
        const txns = rows.length
        const avgBasket = txns > 0 ? revenue / txns : 0

        const priced = (products || []).filter((p) => Number(p.price) > 0)
        const marginPct = priced.length > 0
          ? priced.reduce((sum, p) => {
              const price = Number(p.price) || 0
              const cost = Number(p.purchase_price) || 0
              return sum + (price > 0 ? ((price - cost) / price) * 100 : 0)
            }, 0) / priced.length
          : 0

        return [branch, { revenue, txns, avgBasket, marginPct }] as [PosBranch, BranchSales]
      }))

      setData(Object.fromEntries(results) as Record<PosBranch, BranchSales>)
    } catch (err) {
      console.error('[CrossBranchSales] load error', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const totalRevenue = data.pos1.revenue + data.pos2.revenue

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-[#1A0E0E]">Cross-Branch Sales Performance</h2>
          <p className="text-xs text-gray-500 font-semibold mt-1">Comparative sales analytics between {branchShortLabel('pos1')} and {branchShortLabel('pos2')} (month to date).</p>
        </div>
        <button onClick={() => void load()} className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 text-xs font-bold text-gray-600 hover:bg-gray-50 cursor-pointer">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {BRANCHES.map((b) => {
          const accent = posAccent(b)
          const s = data[b]
          const share = totalRevenue > 0 ? (s.revenue / totalRevenue) * 100 : 0
          return (
            <div key={b} className={`bg-white border-2 ${accent.border} rounded-2xl p-4 shadow-sm`}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2.5">
                  <div className={`w-9 h-9 rounded-xl ${accent.bgLight} p-1.5 flex items-center justify-center`}>
                    <img src={branchLogo(b)} alt={BRAND_EN} className="w-full h-full object-contain" />
                  </div>
                  <p className="text-sm font-black text-[#1A0E0E]">{branchLabel(b)}</p>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${accent.bgLight} ${accent.text}`}>{share.toFixed(0)}% Share</span>
              </div>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500 font-semibold">Total Revenue (MTD)</span>
                  <span className="font-black text-[#1A0E0E]">{formatCurrency(s.revenue)}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500 font-semibold">Transactions Count</span>
                  <span className="font-black text-[#1A0E0E]">{s.txns} Bills</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500 font-semibold">Average Basket Value</span>
                  <span className={`font-black ${accent.text}`}>{formatCurrency(s.avgBasket)}</span>
                </div>
                <div className="flex items-center justify-between text-xs pb-2 border-b border-gray-100">
                  <span className="text-gray-500 font-semibold">Gross Margin Estimate</span>
                  <span className="font-black text-emerald-600">{s.marginPct.toFixed(1)}%</span>
                </div>
              </div>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => onNavigate('billing', b)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-black text-white ${accent.bg} hover:opacity-90 cursor-pointer`}
                >
                  <Store size={13} /> Store Dashboard
                </button>
                <button
                  onClick={() => onNavigate('branch_hub', b)}
                  className="flex-1 py-2 rounded-xl text-xs font-bold text-gray-700 border border-gray-200 hover:bg-gray-50 cursor-pointer"
                >
                  Branch Hub
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
