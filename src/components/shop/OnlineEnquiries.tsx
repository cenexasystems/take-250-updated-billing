import { useCallback, useEffect, useState } from 'react'
import { Download, MessageCircle, Phone, RefreshCw } from 'lucide-react'
import { api } from '../../lib/apiClient'
import { buildCsv, downloadCsvFile } from '../../lib/csv'
import { formatCurrency } from '../../lib/retail'
import { formatPhoneForDisplay } from '../../lib/phone'
import { useBranchStore } from '../../store/store'
import { useShopAlertStore } from '../../store/shopAlertStore'

const ENQUIRY_STATUS_LABEL: Record<string, string> = { new: 'New', contacted: 'Contacted', confirmed: 'Order Confirmed', delivered: 'Delivered', cancelled: 'Cancelled' }
const STATUSES = Object.keys(ENQUIRY_STATUS_LABEL)
type Item = { name: string; variant_name: string | null; quantity: number; unit_price: number; line_total: number }
type Enquiry = {
  id: string; branch_id: string; branch_name: string; enquiry_no: string; customer_name: string; phone: string; address: string; note: string
  status: string; items_total: number; delivery_charge: number | null; admin_note: string; created_at: string; items: Item[]
}
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Admin: every online-shop request (all branches, or one), in the app's table style. Customer text is shown as text (React escapes it). */
export default function OnlineEnquiries() {
  const branches = useBranchStore((s) => s.branches)
  const focusId = useShopAlertStore((s) => s.focusId)
  const focus = useShopAlertStore((s) => s.focus)
  const setNewCount = useShopAlertStore((s) => s.setNewCount)
  const [rows, setRows] = useState<Enquiry[]>([])
  const [status, setStatus] = useState('')
  const [shop, setShop] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, { note?: string; delivery?: string }>>({})

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const query: Record<string, string | number> = { limit: 500 }
      if (status) query.status = status
      if (shop) query.in_branch = shop
      if (from) query.from = new Date(`${from}T00:00:00`).toISOString()
      if (to) query.to = new Date(`${to}T23:59:59.999`).toISOString()
      if (q.trim()) query.q = q.trim()
      const res = await api<{ enquiries: Enquiry[]; new_count: number }>('GET', '/api/shop-admin/enquiries', { query })
      setRows(res.enquiries); setNewCount(res.new_count)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load the requests') }
    finally { setLoading(false) }
  }, [status, shop, from, to, q, setNewCount])
  useEffect(() => { void load() }, [load])
  // reload when a new request arrives (the notification poll bumps the New count)
  const newCount = useShopAlertStore((s) => s.newCount)
  useEffect(() => { void load() }, [newCount]) // eslint-disable-line react-hooks/exhaustive-deps

  // opened from the notification: scroll to and highlight that request
  useEffect(() => {
    if (!focusId) return
    const t = setTimeout(() => document.getElementById(`enq-${focusId}`)?.scrollIntoView({ block: 'center' }), 300)
    return () => clearTimeout(t)
  }, [focusId, rows])

  const save = async (e: Enquiry, body: Record<string, unknown>) => {
    setSaving(e.id); setError('')
    try {
      const res = await api<{ enquiry: Partial<Enquiry> }>('PATCH', `/api/shop-admin/enquiries/${e.id}`, { body })
      setRows((rs) => rs.map((r) => (r.id === e.id ? { ...r, ...res.enquiry } : r)))
      if ('status' in body) void load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save') }
    finally { setSaving(null) }
  }

  const exportCsv = () => {
    const header = ['Request ID', 'Date & Time', 'Branch', 'Customer', 'Phone', 'Address', 'Items', 'Items total (INR)', 'Delivery charge (INR)', 'Status', 'Customer note', 'Admin note']
    const body = rows.map((e) => [e.enquiry_no, new Date(e.created_at).toLocaleString('en-IN'), e.branch_name, e.customer_name, formatPhoneForDisplay(e.phone), e.address,
      e.items.map((i) => `${i.name}${i.variant_name ? ` (${i.variant_name})` : ''} x${i.quantity} @ ${Number(i.unit_price).toFixed(2)}`).join('; '),
      Number(e.items_total).toFixed(2), e.delivery_charge === null ? '' : Number(e.delivery_charge).toFixed(2), ENQUIRY_STATUS_LABEL[e.status] ?? e.status, e.note, e.admin_note])
    downloadCsvFile(`online_requests_${localDay(new Date())}.csv`, buildCsv(header, body)) // buildCsv neutralises = + - @ cells
  }

  const input = 'mt-1 w-full h-11 rounded-xl bg-[#F9FAFB] border border-gray-200 px-2.5 text-xs font-bold text-gray-800 focus:outline-none focus:border-[#D4AF37]'
  return (
    <div className="space-y-4 sm:space-y-6 rounded-[20px] sm:rounded-[28px] border border-[#E5E7EB]/60 bg-[#FBFAF6] p-3 sm:p-6 lg:p-7 shadow-sm" data-testid="online-enquiries">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.24em] text-[#10B981]">Online shop</p>
          <h2 className="mt-1 text-xl font-black text-[#111111]">Online Enquiries <span className="text-[11px] font-semibold text-[#374151]">(requests, not bills)</span></h2>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1.5 rounded-xl border border-[#E5E7EB] bg-white px-4 py-2 text-[13px] font-bold text-[#111111] cursor-pointer"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh</button>
          {rows.length > 0 && <button type="button" onClick={exportCsv} className="inline-flex items-center gap-1.5 rounded-xl bg-[#111111] px-4 py-2 text-[13px] font-bold text-white cursor-pointer"><Download size={14} /> Export CSV</button>}
        </div>
      </div>

      <div className="rounded-2xl border border-[#E5E7EB]/60 bg-white p-3 sm:p-4 shadow-sm space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <label className="text-[10px] font-black uppercase text-gray-500">Status
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={input} data-testid="enq-filter-status">
              <option value="">All statuses</option>{STATUSES.map((s) => <option key={s} value={s}>{ENQUIRY_STATUS_LABEL[s]}</option>)}
            </select>
          </label>
          <label className="text-[10px] font-black uppercase text-gray-500">Branch
            <select value={shop} onChange={(e) => setShop(e.target.value)} className={input} data-testid="enq-filter-branch">
              <option value="">All branches</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.short_label || b.name}</option>)}
            </select>
          </label>
          <label className="text-[10px] font-black uppercase text-gray-500">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={input} /></label>
          <label className="text-[10px] font-black uppercase text-gray-500">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={input} /></label>
          <label className="col-span-2 sm:col-span-1 text-[10px] font-black uppercase text-gray-500">Search<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ID, name or phone" className={input} data-testid="enq-search" /></label>
        </div>
        <p className="text-[11px] font-bold text-[#374151]">{rows.length} request(s)</p>
        {error && <p className="text-xs font-bold text-red-600" role="alert">{error}</p>}

        <div className="overflow-x-auto rounded-xl border border-[#E5E7EB]/60 bg-[#FBFAF6]">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-[#F9FAFB] text-[10px] uppercase tracking-wider text-[#374151]">
              <tr>{['Request ID', 'Date & Time', 'Branch', 'Customer', 'Address', 'Items', 'Total', 'Delivery', 'Status', 'Notes'].map((h) => <th key={h} className="px-2 py-3 font-black">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-[#E5E7EB]/30 bg-white">
              {rows.map((e) => {
                const wa = `91${e.phone}`
                const draft = drafts[e.id] ?? {}
                return (
                  <tr key={e.id} id={`enq-${e.id}`} className={`align-top ${focusId === e.id ? 'bg-[#FBF3D9]' : 'hover:bg-[#F9FAFB]'}`} data-testid="enq-row" onClick={() => focusId === e.id && focus(null)}>
                    <td className="whitespace-nowrap px-2 py-3 text-[11px] font-black text-[#111111]">{e.enquiry_no}</td>
                    <td className="whitespace-nowrap px-2 py-3 text-[11px] text-[#374151]">{new Date(e.created_at).toLocaleString('en-IN')}</td>
                    <td className="whitespace-nowrap px-2 py-3 text-[11px] font-semibold text-[#374151]">{e.branch_name}</td>
                    <td className="px-2 py-3 text-[11px]">
                      <p className="font-black text-[#111111] break-words" data-testid="enq-customer">{e.customer_name}</p>
                      <p className="font-semibold text-[#374151]">{formatPhoneForDisplay(e.phone)}</p>
                      <div className="mt-1 flex gap-1.5">
                        <a href={`tel:+${wa}`} className="inline-flex items-center gap-1 rounded-lg border border-[#E5E7EB] px-2 py-1 text-[10px] font-black text-[#111111]" data-testid="enq-call"><Phone size={11} /> Call</a>
                        <a href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-lg bg-[#25D366] px-2 py-1 text-[10px] font-black text-white" data-testid="enq-wa"><MessageCircle size={11} /> WhatsApp</a>
                      </div>
                    </td>
                    <td className="min-w-[160px] px-2 py-3 text-[11px] text-[#374151] break-words whitespace-pre-line">{e.address}</td>
                    <td className="min-w-[180px] px-2 py-3 text-[11px] text-[#374151]">
                      {e.items.map((i, k) => <p key={k}>{i.name}{i.variant_name ? ` (${i.variant_name})` : ''} × {i.quantity} · {formatCurrency(Number(i.unit_price))}</p>)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-3 text-[11px] font-black text-[#111111]">{formatCurrency(Number(e.items_total))}</td>
                    <td className="px-2 py-3 text-[11px]">
                      <input type="number" min={0} step="0.01" aria-label={`Delivery charge for ${e.enquiry_no}`} placeholder="Not set"
                        value={draft.delivery ?? (e.delivery_charge === null ? '' : String(e.delivery_charge))}
                        onChange={(ev) => setDrafts((d) => ({ ...d, [e.id]: { ...d[e.id], delivery: ev.target.value } }))}
                        onBlur={() => { if (draft.delivery === undefined) return; const v = draft.delivery.trim(); void save(e, { delivery_charge: v === '' ? null : Number(v) }) }}
                        className="h-9 w-24 rounded-lg border border-gray-200 px-2 text-xs font-bold" data-testid="enq-delivery" />
                    </td>
                    <td className="px-2 py-3">
                      <select value={e.status} disabled={saving === e.id} onChange={(ev) => void save(e, { status: ev.target.value })} className="h-9 rounded-lg border border-gray-200 bg-white px-2 text-[11px] font-black text-[#111111]" data-testid="enq-status" aria-label={`Status of ${e.enquiry_no}`}>
                        {STATUSES.map((s) => <option key={s} value={s}>{ENQUIRY_STATUS_LABEL[s]}</option>)}
                      </select>
                    </td>
                    <td className="min-w-[180px] px-2 py-3 text-[11px]">
                      {e.note && <p className="mb-1 text-[#374151] break-words"><span className="font-black">Customer:</span> {e.note}</p>}
                      <textarea rows={2} maxLength={1000} placeholder="Admin note" aria-label={`Admin note for ${e.enquiry_no}`}
                        value={draft.note ?? e.admin_note}
                        onChange={(ev) => setDrafts((d) => ({ ...d, [e.id]: { ...d[e.id], note: ev.target.value } }))}
                        onBlur={() => { if (draft.note !== undefined && draft.note !== e.admin_note) void save(e, { admin_note: draft.note }) }}
                        className="w-full rounded-lg border border-gray-200 px-2 py-1 text-xs" data-testid="enq-admin-note" />
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && !loading && <tr><td colSpan={10} className="px-4 py-8 text-center text-[#374151]">No requests</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
