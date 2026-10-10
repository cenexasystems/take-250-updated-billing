import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Printer, RotateCcw, X } from 'lucide-react'
import { api } from '../../lib/apiClient'
import { formatCurrency, formatInvoiceNo } from '../../lib/retail'
import { printReturnReceipt } from '../../lib/thermalPrint'
import type { PosBranch } from '../../store/store'

// Same list as the server (server/routes/sales.ts RETURN_REASONS).
export const RETURN_REASONS = ['Wrong size', 'Defective / damaged', 'Customer changed mind', 'Wrong item billed', 'Other'] as const

type Line = { order_item_id: number; name: string; variant_name: string | null; quantity: number; returned_quantity: number; is_manual: boolean }
type ReturnRecord = {
  return_id: string; order_id: string; return_no: string; invoice_no: string; refund_amount: number; refund_mode: 'cash' | 'original'; reason: string; note: string
  created_by_role: string; created_at: string; order_status: string
  items: Array<{ order_item_id: number; name: string; quantity: number; restocked: boolean; refund_amount: number }>
}
type Info = { order: { id: string; invoice_no: string; status: string; payment_method: string; payment_mode: string }; items: Line[]; returns: ReturnRecord[] }

interface Props {
  orderId: string
  branch: PosBranch
  onClose: () => void
  /** called after a successful return so the page can refresh the bill, stock and reports */
  onReturned: (r: ReturnRecord) => void
}

const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `ret-${Date.now()}-${Math.random().toString(36).slice(2)}`)

export default function ReturnModal({ orderId, branch, onClose, onReturned }: Props) {
  const [info, setInfo] = useState<Info | null>(null)
  const [loadError, setLoadError] = useState('')
  const [qty, setQty] = useState<Record<number, number>>({})
  const [restock, setRestock] = useState<Record<number, boolean>>({})
  const [reason, setReason] = useState<string>(RETURN_REASONS[0])
  const [note, setNote] = useState('')
  const [mode, setMode] = useState<'cash' | 'original'>('cash')
  const [refund, setRefund] = useState<number | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<ReturnRecord | null>(null)
  // one key per attempt: a double tap or a retry after a slow network returns the FIRST return instead of making another
  const keyRef = useRef(newKey())

  const load = useCallback(async () => {
    try {
      const res = await api<Info>('GET', `/api/orders/${orderId}/returns`, { branchId: branch })
      setInfo(res)
    } catch (e) { setLoadError(e instanceof Error ? e.message : 'Could not load the bill') }
  }, [orderId, branch])
  useEffect(() => { void load() }, [load])

  const selected = useMemo(() => (info?.items ?? []).filter((i) => (qty[i.order_item_id] ?? 0) > 0)
    .map((i) => ({ order_item_id: i.order_item_id, quantity: qty[i.order_item_id], restock: i.is_manual ? false : restock[i.order_item_id] !== false })), [info, qty, restock])

  // the refund amount comes from the SQL function (dry run), never from browser maths
  useEffect(() => {
    setConfirming(false)
    if (!selected.length) { setRefund(null); return }
    let alive = true
    const t = setTimeout(async () => {
      try {
        const r = await api<{ refund_amount: number }>('POST', `/api/orders/${orderId}/return/preview`, { body: { items: selected }, branchId: branch })
        if (alive) { setRefund(Number(r.refund_amount)); setError('') }
      } catch (e) { if (alive) { setRefund(null); setError(e instanceof Error ? e.message : 'Could not work out the refund') } }
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [selected, orderId, branch])

  const setLineQty = (l: Line, v: number) => {
    const left = l.quantity - l.returned_quantity
    const clean = Number.isFinite(v) ? Math.min(left, Math.max(0, v)) : 0
    setQty((p) => ({ ...p, [l.order_item_id]: clean }))
  }

  const submit = async () => {
    if (busy || !selected.length) return
    setBusy(true); setError('')
    try {
      const rec = await api<ReturnRecord>('POST', `/api/orders/${orderId}/return`, {
        body: { items: selected, reason, note: note.trim(), refund_mode: mode, idempotency_key: keyRef.current }, branchId: branch })
      setDone(rec)
      onReturned(rec)
      void load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The return could not be saved')
      setConfirming(false)
    } finally { setBusy(false) }
  }

  const print = (r: ReturnRecord) => printReturnReceipt({
    returnNo: r.return_no, originalInvoiceNo: r.invoice_no, date: r.created_at, branch, reason: r.reason, note: r.note, refundMode: r.refund_mode,
    items: r.items.map((i) => ({ name: i.name, qty: i.quantity, refund: Number(i.refund_amount), restocked: i.restocked })), refundTotal: Number(r.refund_amount),
  })

  const modeLabel = (m: string) => (m === 'cash' ? 'Cash' : 'Original payment')

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Return items">
      <div className="w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain rounded-2xl bg-white p-5 shadow-2xl border border-[#E8D399]">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-black text-[#111111]">Return items{info ? ` · ${formatInvoiceNo(info.order.invoice_no)}` : ''}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="h-9 w-9 shrink-0 rounded-xl border border-[#E5E7EB] text-[#111111] cursor-pointer"><X size={16} className="mx-auto" /></button>
        </div>

        {loadError && <p className="mt-3 text-sm font-bold text-red-600">{loadError}</p>}
        {!info && !loadError && <p className="mt-3 text-sm font-semibold text-[#6B7280]">Loading…</p>}

        {info && done && (
          <div className="mt-3 space-y-3" data-testid="return-done">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-bold text-emerald-700">
              Return {done.return_no} saved. Refund {formatCurrency(Number(done.refund_amount))} ({modeLabel(done.refund_mode)}). Bill is now {done.order_status === 'returned' ? 'Returned' : 'Partially Returned'}.
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => print(done)} className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-[#E5E7EB] text-sm font-black text-[#111111] cursor-pointer"><Printer size={14} /> Print return receipt</button>
              <button type="button" onClick={onClose} className="h-11 flex-1 rounded-xl bg-[#111111] text-sm font-black text-white cursor-pointer">Done</button>
            </div>
          </div>
        )}

        {info && !done && (
          <>
            {!['completed', 'partially_returned'].includes(info.order.status) ? (
              <p className="mt-3 text-sm font-bold text-red-600">Only a completed bill can be returned (this bill is {info.order.status.replace('_', ' ')}).</p>
            ) : (
              <>
                <p className="mt-1 text-xs font-semibold text-[#6B7280]">Choose how many units come back. Ticked items go back into this store's stock; untick for damaged items (no stock added, logged as damage).</p>
                <div className="mt-3 divide-y divide-[#E5E7EB]/60 rounded-xl border border-[#E5E7EB]">
                  {info.items.map((l) => {
                    const left = l.quantity - l.returned_quantity
                    const q = qty[l.order_item_id] ?? 0
                    return (
                      <div key={l.order_item_id} className="p-3" data-testid="return-line">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-[13px] font-black text-[#111111] break-words">{l.name}{l.variant_name ? ` (${l.variant_name})` : ''}</p>
                            <p className="text-[11px] font-semibold text-[#6B7280]">Bought {l.quantity} · Already returned {l.returned_quantity} · Left {left}</p>
                          </div>
                          {left > 0 && (
                            <div className="flex shrink-0 items-center gap-1">
                              <button type="button" aria-label="Less" onClick={() => setLineQty(l, q - 1)} className="h-9 w-9 rounded-lg border border-[#E5E7EB] text-sm font-black cursor-pointer">−</button>
                              <input aria-label={`Quantity to return of ${l.name}`} type="number" inputMode="decimal" min={0} max={left} step="any" value={q}
                                onChange={(e) => setLineQty(l, Number(e.target.value))} className="h-9 w-14 rounded-lg border border-[#E5E7EB] text-center text-sm font-black outline-none focus:border-[#D4AF37]" />
                              <button type="button" aria-label="More" onClick={() => setLineQty(l, q + 1)} className="h-9 w-9 rounded-lg border border-[#E5E7EB] text-sm font-black cursor-pointer">+</button>
                            </div>
                          )}
                        </div>
                        {left > 0 && q > 0 && !l.is_manual && (
                          <label className="mt-2 flex items-center gap-2 text-[12px] font-bold text-[#374151] cursor-pointer">
                            <input type="checkbox" checked={restock[l.order_item_id] !== false} onChange={(e) => setRestock((p) => ({ ...p, [l.order_item_id]: e.target.checked }))} />
                            Return to stock
                          </label>
                        )}
                        {left === 0 && <p className="mt-1 text-[11px] font-black uppercase text-red-600">Fully returned</p>}
                      </div>
                    )
                  })}
                </div>

                <label className="mt-3 block text-[10px] font-black uppercase tracking-wide text-[#6B7280]">Reason</label>
                <select value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-[#E5E7EB] bg-white px-3 text-sm font-bold outline-none focus:border-[#D4AF37]">
                  {RETURN_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <label className="mt-3 block text-[10px] font-black uppercase tracking-wide text-[#6B7280]">Note (optional)</label>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={2} className="mt-1 w-full rounded-xl border border-[#E5E7EB] px-3 py-2 text-sm outline-none focus:border-[#D4AF37]" />
                <label className="mt-3 block text-[10px] font-black uppercase tracking-wide text-[#6B7280]">Refund mode</label>
                <select value={mode} onChange={(e) => setMode(e.target.value as 'cash' | 'original')} className="mt-1 h-11 w-full rounded-xl border border-[#E5E7EB] bg-white px-3 text-sm font-bold outline-none focus:border-[#D4AF37]">
                  <option value="cash">Cash</option>
                  <option value="original">Original payment mode ({String(info.order.payment_method || info.order.payment_mode || 'cash').toUpperCase()})</option>
                </select>

                <div className="mt-3 flex items-center justify-between rounded-xl border border-[#E8D399] bg-[#FBFAF6] px-3 py-3">
                  <span className="text-[11px] font-black uppercase text-[#6B7280]">Refund amount</span>
                  <span className="text-lg font-black text-[#111111]" data-testid="return-refund">{refund === null ? '—' : formatCurrency(refund)}</span>
                </div>
                {error && <p className="mt-2 text-xs font-bold text-red-600" role="alert">{error}</p>}

                {confirming ? (
                  <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3">
                    <p className="text-xs font-bold text-red-700">Refund {refund === null ? '' : formatCurrency(refund)} for {selected.length} item line(s)? This cannot be undone.</p>
                    <div className="mt-2 flex gap-2">
                      <button type="button" disabled={busy} onClick={() => setConfirming(false)} className="h-11 flex-1 rounded-xl border border-[#E5E7EB] bg-white text-sm font-black text-[#111111] cursor-pointer disabled:opacity-60">Back</button>
                      <button type="button" disabled={busy} onClick={() => void submit()} className="h-11 flex-1 rounded-xl bg-red-600 text-sm font-black text-white cursor-pointer hover:bg-red-700 disabled:opacity-60">{busy ? 'Saving…' : 'Confirm return'}</button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex gap-2">
                    <button type="button" onClick={onClose} className="h-11 flex-1 rounded-xl border border-[#E5E7EB] text-sm font-black text-[#111111] cursor-pointer">Close</button>
                    <button type="button" disabled={!selected.length || refund === null} onClick={() => setConfirming(true)} className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#111111] text-sm font-black text-white cursor-pointer disabled:opacity-50"><RotateCcw size={14} /> Return</button>
                  </div>
                )}
              </>
            )}

            {info.returns.length > 0 && (
              <div className="mt-4">
                <p className="text-[10px] font-black uppercase tracking-wide text-[#6B7280]">Earlier returns on this bill</p>
                <div className="mt-1 divide-y divide-[#E5E7EB]/60 rounded-xl border border-[#E5E7EB]">
                  {info.returns.map((r) => (
                    <div key={r.return_id} className="flex items-center justify-between gap-2 p-2.5 text-[12px]" data-testid="return-history">
                      <div className="min-w-0">
                        <p className="font-black text-[#111111]">{r.return_no} · {formatCurrency(Number(r.refund_amount))}</p>
                        <p className="font-semibold text-[#6B7280]">{new Date(r.created_at).toLocaleString('en-IN')} · {r.reason} · {r.created_by_role}</p>
                      </div>
                      <button type="button" onClick={() => print(r)} aria-label={`Print ${r.return_no}`} className="h-9 w-9 shrink-0 rounded-lg border border-[#E5E7EB] cursor-pointer"><Printer size={14} className="mx-auto" /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
