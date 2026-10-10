import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Download, RefreshCw } from 'lucide-react'
import { api } from '../../lib/apiClient'
import { buildCsv, downloadCsvFile } from '../../lib/csv'
import { formatCurrency, formatInvoiceNo } from '../../lib/retail'
import type { PosBranch } from '../../store/store'

type ReturnRow = {
  id: string; return_no: string; order_id: string; invoice_no: string; refund_amount: number; refund_mode: 'cash' | 'original'
  reason: string; note: string; created_by_role: string; created_at: string
  items: Array<{ name: string; quantity: number; restocked: boolean; refund_amount: number }>
}
type Totals = { refund: number; cash: number; original: number }

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const itemsText = (r: ReturnRow) => r.items.map((i) => `${i.name} x${i.quantity}${i.restocked ? '' : ' (damaged)'}`).join('; ')
const modeLabel = (m: string) => (m === 'cash' ? 'Cash' : 'Original payment')

/** Every return of this branch, newest RETURN time first (not the sale date), so the day's refunds can be matched with the cash drawer. */
export default function ReturnsList({ branch, onBack }: { branch: PosBranch; onBack: () => void }) {
  const [from, setFrom] = useState(localDay())
  const [to, setTo] = useState(localDay())
  const [mode, setMode] = useState<'' | 'cash' | 'original'>('')
  const [rows, setRows] = useState<ReturnRow[]>([])
  const [totals, setTotals] = useState<Totals>({ refund: 0, cash: 0, original: 0 })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const query: Record<string, string | number> = { limit: 1000 }
      if (from) query.from = new Date(`${from}T00:00:00`).toISOString()
      if (to) query.to = new Date(`${to}T23:59:59.999`).toISOString()
      if (mode) query.mode = mode
      const res = await api<{ returns: ReturnRow[]; totals: Totals }>('GET', '/api/returns', { query, branchId: branch })
      setRows(res.returns); setTotals(res.totals)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load the returns') }
    finally { setLoading(false) }
  }, [from, to, mode, branch])
  useEffect(() => { void load() }, [load])

  const exportCsv = () => {
    const header = ['Return No', 'Original Invoice', 'Items', 'Refund (INR)', 'Refund Mode', 'Reason', 'Note', 'By (role)', 'Return Date & Time']
    const body = rows.map((r) => [r.return_no, formatInvoiceNo(r.invoice_no), itemsText(r), Number(r.refund_amount).toFixed(2), modeLabel(r.refund_mode), r.reason, r.note, r.created_by_role, new Date(r.created_at).toLocaleString('en-IN')])
    body.push(['TOTAL', '', '', totals.refund.toFixed(2), `Cash ${totals.cash.toFixed(2)} / Original ${totals.original.toFixed(2)}`, '', '', '', ''])
    downloadCsvFile(`returns_${from || 'all'}_to_${to || 'all'}.csv`, buildCsv(header, body))
  }

  return (
    <div className="space-y-4 sm:space-y-6 rounded-[20px] sm:rounded-[28px] border border-[#E5E7EB]/60 bg-[#FBFAF6] p-3 sm:p-6 lg:p-7 shadow-sm" data-testid="returns-list">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.24em] text-[#10B981]">Billing history</p>
          <h2 className="mt-1 text-xl font-black text-[#111111]">Returns <span className="text-[11px] font-semibold text-[#374151]">(by return date)</span></h2>
        </div>
        <button type="button" onClick={onBack} className="inline-flex items-center gap-2 rounded-xl bg-[#111111] px-4 py-2 text-[13px] font-bold text-white shadow-sm hover:bg-[#1f281d] cursor-pointer">
          <ArrowLeft size={14} /> Order History
        </button>
      </div>

      <div className="rounded-2xl border border-[#E5E7EB]/60 bg-white p-3 sm:p-4 shadow-sm space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <label className="text-[10px] font-black uppercase text-gray-500">From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 w-full h-11 rounded-xl bg-[#F9FAFB] border border-gray-200 px-2.5 text-xs font-bold text-gray-800 focus:outline-none focus:border-[#D4AF37]" />
          </label>
          <label className="text-[10px] font-black uppercase text-gray-500">To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 w-full h-11 rounded-xl bg-[#F9FAFB] border border-gray-200 px-2.5 text-xs font-bold text-gray-800 focus:outline-none focus:border-[#D4AF37]" />
          </label>
          <label className="text-[10px] font-black uppercase text-gray-500">Refund mode
            <select value={mode} onChange={(e) => setMode(e.target.value as '' | 'cash' | 'original')} className="mt-1 w-full h-11 rounded-xl bg-[#F9FAFB] border border-gray-200 px-2.5 text-xs font-bold text-gray-800 focus:outline-none focus:border-[#D4AF37] cursor-pointer">
              <option value="">All modes</option>
              <option value="cash">Cash</option>
              <option value="original">Original payment</option>
            </select>
          </label>
          <div className="flex items-end">
            <button type="button" onClick={() => void load()} className="inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-[#E5E7EB] text-xs font-black text-[#111111] cursor-pointer"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh</button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2" data-testid="returns-totals">
          {[['Total refunded', totals.refund], ['Cash refunds', totals.cash], ['Original-mode refunds', totals.original]].map(([label, v]) => (
            <div key={String(label)} className="rounded-xl bg-[#FBFAF6] p-2 text-center">
              <p className="text-[9px] font-black uppercase text-gray-500">{label}</p>
              <p className="text-xs font-black text-[#1A0E0E]">{formatCurrency(Number(v))}</p>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between">
          <p className="text-[11px] font-bold text-[#374151]">{rows.length} return(s)</p>
          {rows.length > 0 && (
            <button type="button" onClick={exportCsv} className="inline-flex items-center gap-1 text-[11px] font-bold text-[#D4AF37] hover:text-[#b89528] transition-colors cursor-pointer">
              <Download size={11} /> Export CSV
            </button>
          )}
        </div>
        {error && <p className="text-xs font-bold text-red-600" role="alert">{error}</p>}

        <div className="overflow-x-auto rounded-xl border border-[#E5E7EB]/60 bg-[#FBFAF6]">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-[#F9FAFB] text-[10px] uppercase tracking-wider text-[#374151]">
              <tr>{['Return No', 'Original Invoice', 'Items', 'Refund', 'Mode', 'Reason', 'By', 'Return Time'].map((h) => <th key={h} className="px-2 py-3 font-black text-center">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-[#E5E7EB]/30 bg-white">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-[#F9FAFB] text-center" data-testid="returns-row">
                  <td className="whitespace-nowrap px-2 py-3 text-[11px] font-bold text-[#111111]">{r.return_no}</td>
                  <td className="whitespace-nowrap px-2 py-3 text-[11px] font-bold text-[#111111]">{formatInvoiceNo(r.invoice_no)}</td>
                  <td className="min-w-[160px] px-2 py-3 text-left text-[11px] font-semibold text-[#374151]">{itemsText(r)}</td>
                  <td className="whitespace-nowrap px-2 py-3 text-[11px] font-black text-[#111111]">{formatCurrency(Number(r.refund_amount))}</td>
                  <td className="whitespace-nowrap px-2 py-3 text-[11px] font-semibold text-[#374151]">{modeLabel(r.refund_mode)}</td>
                  <td className="px-2 py-3 text-[11px] font-semibold text-[#374151]">{r.reason}{r.note ? ` · ${r.note}` : ''}</td>
                  <td className="whitespace-nowrap px-2 py-3 text-[11px] font-semibold uppercase text-[#374151]">{r.created_by_role}</td>
                  <td className="whitespace-nowrap px-2 py-3 text-[11px] text-[#374151]">{new Date(r.created_at).toLocaleString('en-IN')}</td>
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-[#374151]">No returns in this period</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
