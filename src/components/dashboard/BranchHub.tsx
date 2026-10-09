import { useEffect } from 'react'
import { Store, Phone, MapPin, ShoppingCart, Boxes, AlertTriangle, FileText } from 'lucide-react'
import { useAdminAuthStore, useProductStore, useSettingsStore, resolveBranch, type PosBranch } from '../../store/store'
import { BRAND_EN } from '../../lib/brand'
import { branchLabel, posAccent } from '../../lib/branchTheme'
import BranchLogo from '../common/BranchLogo'
import type { TabKey } from '../../pages/Dashboard'

interface BranchHubProps {
  onNavigate: (tab: TabKey) => void
}

/** Staff landing page for a branch: branch details, quick links and low-stock alert. */
export default function BranchHub({ onNavigate }: BranchHubProps) {
  const activeBranch = useAdminAuthStore((s) => s.activeBranch)
  const branch = resolveBranch(activeBranch)
  const accent = posAccent(branch)
  const products = useProductStore((s) => s.products)
  const { settings, fetchSettings } = useSettingsStore()

  useEffect(() => { void fetchSettings(branch) }, [fetchSettings, branch])

  const lowStockCount = products.filter((p) => p.isActive && (Number(p.stockQuantity) || 0) <= 5).length

  const quickOps: { label: string; tab: TabKey; icon: React.ReactNode; primary?: boolean }[] = [
    { label: 'Open Store Dashboard & POS', tab: 'billing', icon: <ShoppingCart size={15} />, primary: true },
    { label: 'Stock Control', tab: 'inventory', icon: <Boxes size={15} /> },
    { label: 'Advance Orders', tab: 'advance_orders', icon: <FileText size={15} /> },
  ]

  return (
    <div className="space-y-5">
      {/* Branch header card */}
      <div className={`bg-white border-2 ${accent.border} rounded-2xl p-5 shadow-sm`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={`w-14 h-14 rounded-xl ${accent.bgLight} border ${accent.border} p-2 flex items-center justify-center shrink-0`}>
              <BranchLogo branch={branch} alt={BRAND_EN} className="w-full h-full object-contain" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg font-black text-[#1A0E0E]">{BRAND_EN} — {branchLabel(branch)}</h2>
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ${accent.bgLight} ${accent.text}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${accent.bg}`} /> Active
                </span>
              </div>
              {settings && (
                <p className="text-xs text-gray-500 font-semibold flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                  <span className="flex items-center gap-1"><Phone size={12} /> {settings.phone}</span>
                  <span className="flex items-center gap-1"><MapPin size={12} /> {settings.address}</span>
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-gray-100">
          <p className="text-[10px] font-black uppercase tracking-wider text-gray-400 mb-2">Quick Operations</p>
          <div className="flex flex-wrap gap-2">
            {quickOps.map((op) => (
              <button
                key={op.tab}
                onClick={() => onNavigate(op.tab)}
                className={op.primary
                  ? `flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-black text-white ${accent.bg} hover:opacity-90 cursor-pointer`
                  : 'flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold text-gray-700 border border-gray-200 hover:bg-gray-50 cursor-pointer'}
              >
                {op.icon} {op.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {lowStockCount > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-black text-amber-900">Inventory Alerts</p>
            <p className="text-xs text-amber-700 font-semibold mt-0.5">
              {lowStockCount} item{lowStockCount === 1 ? '' : 's'} at or below minimum stock threshold in this store.{' '}
              <button onClick={() => onNavigate('inventory')} className="underline font-black cursor-pointer">Open Stock Control</button>
            </p>
          </div>
        </div>
      )}
      <p className="text-[10px] text-gray-400 font-semibold flex items-center gap-1.5">
        <Store size={11} /> Isolated stock ledger and invoice sequence for this POS counter.
      </p>
    </div>
  )
}
