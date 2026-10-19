import { useCallback, useEffect, useState } from 'react'
import { Download, MessageCircle, Phone, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../../lib/apiClient'
import { buildCsv, downloadCsvFile } from '../../lib/csv'
import { formatCurrency } from '../../lib/retail'
import { formatPhoneForDisplay } from '../../lib/phone'
import { getPeriodRange } from '../../lib/dateRanges'
import { useBranchStore } from '../../store/store'
import { useShopAlertStore } from '../../store/shopAlertStore'

const ENQUIRY_STATUS_LABEL: Record<string, string> = { new: 'New', contacted: 'Contacted', confirmed: 'Order Confirmed', delivered: 'Delivered', cancelled: 'Cancelled' }
const STATUSES = Object.keys(ENQUIRY_STATUS_LABEL)
type Item = { name: string; variant_name: string | null; quantity: number; unit_price: number; line_total: number }
type Enquiry = {
  id: string; branch_id: string; branch_name: string; enquiry_no: string; customer_name: string; phone: string; address: string; note: string
  status: string; items_total: number; delivery_charge: number | null; delivery_date?: string | null; admin_note: string; created_at: string; items: Item[]
}
type Period = 'all' | 'today' | 'week' | 'month' | 'year' | 'custom'
const PERIODS: Array<{ id: Exclude<Period, 'custom'>; label: string }> = [
  { id: 'all', label: 'All Time' }, { id: 'today', label: 'Today' }, { id: 'week', label: 'This Week' }, { id: 'month', label: 'This Month' }, { id: 'year', label: 'This Year' },
]
// column widths: fixed, so rows never jump when a cell's content changes (the table scrolls sideways inside its box)
const COLS: Array<[string, number]> = [['Request ID', 130], ['Date & Time', 150], ['Branch', 150], ['Customer', 190], ['Address', 220], ['Items', 230], ['Total', 100], ['Delivery', 160], ['Status', 150], ['Notes', 220], ['', 90]]
const ITEMS_SHOWN = 2
/** 'YYYY-MM-DD' -> 'dd/mm/yyyy' */
const dmy = (iso?: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '')
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * Admin: online-shop requests in the app's table style. Inside a branch (`branch` set) only that branch's requests; the
 * Global Admin view (`branch` null) shows all branches with a branch filter. Customer text is shown as text (React escapes it).
 */
export default function OnlineEnquiries({ branch = null }: { branch?: string | null }) {
  const branches = useBranchStore((s) => s.branches)
  const focusId = useShopAlertStore((s) => s.focusId)
  const focus = useShopAlertStore((s) => s.focus)
  const setNewCount = useShopAlertStore((s) => s.setNewCount)
  const [rows, setRows] = useState<Enquiry[]>([])
  const [status, setStatus] = useState('')
  const [shop, setShop] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [period, setPeriod] = useState<Period>('all') // quick period; typing a date by hand makes it 'custom'
  const [open, setOpen] = useState<Record<string, { address?: boolean; items?: boolean }>>({}) // expanded cells per row
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, { note?: string; delivery?: string; date?: string }>>({})

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const query: Record<string, string | number> = { limit: 500 }
      if (status) query.status = status
      const only = branch ?? shop
      if (only) query.in_branch = only
      if (from) query.from = new Date(`${from}T00:00:00`).toISOString()
      if (to) query.to = new Date(`${to}T23:59:59.999`).toISOString()
      if (q.trim()) query.q = q.trim()
      const res = await api<{ enquiries: Enquiry[]; new_count: number; new_by_branch?: Record<string, number> }>('GET', '/api/shop-admin/enquiries', { query })
      setRows(res.enquiries); setNewCount(res.new_count, res.new_by_branch)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load the requests') }
    finally { setLoading(false) }
  }, [branch, status, shop, from, to, q, setNewCount])
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

  const remove = async (e: Enquiry) => {
    if (!window.confirm(`Delete request ${e.enquiry_no} from ${e.customer_name}? This cannot be undone.`)) return
    setSaving(e.id); setError('')
    try {
      await api('DELETE', `/api/shop-admin/enquiries/${e.id}`)
      setRows((rs) => rs.filter((r) => r.id !== e.id))
      if (focusId === e.id) focus(null)
      void load() // refresh the New counts
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not delete') }
    finally { setSaving(null) }
  }

  const exportCsv = () => {
    const header = ['Request ID', 'Date & Time', 'Branch', 'Customer', 'Phone', 'Address', 'Items', 'Items total (INR)', 'Delivery date', 'Delivery charge (INR)', 'Status', 'Customer note', 'Admin note']
    const body = rows.map((e) => [e.enquiry_no, new Date(e.created_at).toLocaleString('en-IN'), e.branch_name, e.customer_name, formatPhoneForDisplay(e.phone), e.address,
      e.items.map((i) => `${i.name}${i.variant_name ? ` (${i.variant_name})` : ''} x${i.quantity} @ ${Number(i.unit_price).toFixed(2)}`).join('; '),
      Number(e.items_total).toFixed(2), dmy(e.delivery_date), e.delivery_charge === null ? '' : Number(e.delivery_charge).toFixed(2), ENQUIRY_STATUS_LABEL[e.status] ?? e.status, e.note, e.admin_note])
    downloadCsvFile(`online_requests_${localDay(new Date())}.csv`, buildCsv(header, body)) // buildCsv neutralises = + - @ cells
  }

  const pickPeriod = (pr: Exclude<Period, 'custom'>) => {
    setPeriod(pr)
    if (pr === 'all') { setFrom(''); setTo(''); return }
    const r = getPeriodRange(pr)
    setFrom(r.from); setTo(r.to)
  }
  const toggle = (id: string, cell: 'address' | 'items') => setOpen((o) => ({ ...o, [id]: { ...o[id], [cell]: !o[id]?.[cell] } }))

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
            {branch ? (
              // inside a branch: only this branch's requests (Global Admin shows every branch)
              <div className={`${input} flex items-center normal-case text-[#111111]`} data-testid="enq-branch-locked">{branches.find((b) => b.id === branch)?.short_label || branch}</div>
            ) : (
              <select value={shop} onChange={(e) => setShop(e.target.value)} className={input} data-testid="enq-filter-branch">
                <option value="">All branches</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.short_label || b.name}</option>)}
              </select>
            )}
          </label>
          <label className="text-[10px] font-black uppercase text-gray-500">From<input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPeriod('custom') }} className={input} data-testid="enq-from" /></label>
          <label className="text-[10px] font-black uppercase text-gray-500">To<input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPeriod('custom') }} className={input} data-testid="enq-to" /></label>
          <label className="col-span-2 sm:col-span-1 text-[10px] font-black uppercase text-gray-500">Search<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ID, name or phone" className={input} data-testid="enq-search" /></label>
        </div>
        {/* quick periods, as on the Analytics screen: they fill From / To (All Time clears them) */}
        <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-[#F8F8F8] p-2" data-testid="enq-periods">
          <span className="text-[10px] font-bold uppercase text-[#6B7280] ml-1 mr-1">Period:</span>
          {PERIODS.map((pr) => (
            <button key={pr.id} type="button" onClick={() => pickPeriod(pr.id)} aria-pressed={period === pr.id} data-testid={`enq-period-${pr.id}`}
              className={`px-4 py-1.5 rounded-full text-[11px] font-bold uppercase transition-all cursor-pointer ${period === pr.id ? 'bg-[#7A1220] text-white shadow-sm' : 'text-[#6B7280] hover:text-[#111111]'}`}>
              {pr.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] font-bold text-[#374151]">{rows.length} request(s){branch ? ' for this branch · open Global Admin to see every branch' : ''}</p>
        {error && <p className="text-xs font-bold text-red-600" role="alert">{error}</p>}

        <div className="overflow-x-auto rounded-xl border border-[#E5E7EB]/60 bg-[#FBFAF6]">
          <table className="table-fixed text-left text-[13px]" style={{ width: COLS.reduce((w, [, px]) => w + px, 0) }} data-testid="enq-table">
            <colgroup>{COLS.map(([h, px]) => <col key={h} style={{ width: px }} />)}</colgroup>
            <thead className="bg-[#F9FAFB] text-[10px] uppercase tracking-wider text-[#374151]">
              <tr>{COLS.map(([h]) => <th key={h} className="px-2 py-3 font-black">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-[#E5E7EB]/30 bg-white">
              {rows.map((e) => {
                const wa = `91${e.phone}`
                const draft = drafts[e.id] ?? {}
                return (
                  <tr key={e.id} id={`enq-${e.id}`} className={`align-top ${focusId === e.id ? 'bg-[#FBF3D9]' : 'hover:bg-[#F9FAFB]'}`} data-testid="enq-row" onClick={() => focusId === e.id && focus(null)}>
                    <td className="whitespace-nowrap px-2 py-3 text-[11px] font-black text-[#111111]">{e.enquiry_no}</td>
                    <td className="whitespace-nowrap px-2 py-3 text-[11px] text-[#374151]">{new Date(e.created_at).toLocaleString('en-IN')}</td>
                    <td className="truncate px-2 py-3 text-[11px] font-semibold text-[#374151]" title={e.branch_name}>{e.branch_name}</td>
                    <td className="px-2 py-3 text-[11px]">
                      {/* one left-aligned stack: name, phone, then Call and WhatsApp side by side (same size, same line) */}
                      <div className="flex flex-col items-start gap-1" data-testid="enq-customer-cell">
                        <p className="w-full truncate font-black text-[#111111]" title={e.customer_name} data-testid="enq-customer">{e.customer_name}</p>
                        <p className="font-semibold text-[#374151]" data-testid="enq-phone">{formatPhoneForDisplay(e.phone)}</p>
                        <div className="flex items-center gap-1.5">
                          <a href={`tel:+${wa}`} className="inline-flex h-7 w-[84px] items-center justify-center gap-1 rounded-lg border border-[#E5E7EB] bg-white text-[10px] font-black text-[#111111]" data-testid="enq-call"><Phone size={11} /> Call</a>
                          <a href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer" className="inline-flex h-7 w-[84px] items-center justify-center gap-1 rounded-lg border border-[#25D366] bg-[#25D366] text-[10px] font-black text-white" data-testid="enq-wa"><MessageCircle size={11} /> WhatsApp</a>
                        </div>
                      </div>
                    </td>
                    <td className="px-2 py-3 text-[11px] text-[#374151]">
                      {/* first ~2 lines; a click shows the whole address, another click folds it again */}
                      <button type="button" onClick={(ev) => { ev.stopPropagation(); toggle(e.id, 'address') }} aria-expanded={!!open[e.id]?.address} title={open[e.id]?.address ? 'Show less' : 'Show the full address'}
                        className={`w-full text-left break-words whitespace-pre-line cursor-pointer ${open[e.id]?.address ? 'block' : 'line-clamp-2'}`} data-testid="enq-address">{e.address}</button>
                      {e.address.length > 60 && (
                        <button type="button" onClick={(ev) => { ev.stopPropagation(); toggle(e.id, 'address') }} className="mt-0.5 text-[10px] font-black text-[#8A6A0A] cursor-pointer" data-testid="enq-address-toggle">{open[e.id]?.address ? 'less' : 'more'}</button>
                      )}
                    </td>
                    <td className="px-2 py-3 text-[11px] text-[#374151]">
                      {(open[e.id]?.items ? e.items : e.items.slice(0, ITEMS_SHOWN)).map((i, k) => <p key={k} className="truncate" title={`${i.name}${i.variant_name ? ` (${i.variant_name})` : ''} × ${i.quantity}`}>{i.name}{i.variant_name ? ` (${i.variant_name})` : ''} × {i.quantity} · {formatCurrency(Number(i.unit_price))}</p>)}
                      {e.items.length > ITEMS_SHOWN && (
                        <button type="button" onClick={(ev) => { ev.stopPropagation(); toggle(e.id, 'items') }} className="mt-0.5 text-[10px] font-black text-[#8A6A0A] cursor-pointer" data-testid="enq-items-toggle">
                          {open[e.id]?.items ? 'less' : `+${e.items.length - ITEMS_SHOWN} more`}
                        </button>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-3 text-[11px] font-black text-[#111111]">{formatCurrency(Number(e.items_total))}</td>
                    <td className="px-2 py-3 text-[11px]" data-testid="enq-delivery-cell">
                      <label className="block text-[9px] font-black uppercase text-gray-500">Delivery date
                        <input type="date" aria-label={`Delivery date for ${e.enquiry_no}`} min={localDay(new Date(e.created_at))}
                          value={draft.date ?? (e.delivery_date ?? '')}
                          onChange={(ev) => setDrafts((d) => ({ ...d, [e.id]: { ...d[e.id], date: ev.target.value } }))}
                          onBlur={() => { if (draft.date === undefined || draft.date === (e.delivery_date ?? '')) return; void save(e, { delivery_date: draft.date || null }).then(() => setDrafts((d) => ({ ...d, [e.id]: { ...d[e.id], date: undefined } }))) }}
                          className="mt-0.5 h-9 w-full rounded-lg border border-gray-200 px-2 text-xs font-bold normal-case" data-testid="enq-delivery-date" />
                      </label>
                      {e.delivery_date && (() => {
                        const today = localDay(new Date())
                        const open = !['delivered', 'cancelled'].includes(e.status)
                        const tag = open && e.delivery_date === today ? 'Today' : open && e.delivery_date < today ? 'Overdue' : ''
                        return (
                          <p className="mt-0.5 flex items-center gap-1 font-semibold text-[#374151]" data-testid="enq-delivery-date-text">
                            {dmy(e.delivery_date)}
                            {tag && <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-black ${tag === 'Today' ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-red-50 text-red-700 border-red-200'}`} data-testid="enq-delivery-badge">{tag}</span>}
                          </p>
                        )
                      })()}
                      <label className="mt-1 block text-[9px] font-black uppercase text-gray-500">Delivery charge
                        <input type="number" min={0} step="0.01" aria-label={`Delivery charge for ${e.enquiry_no}`} placeholder="Not set"
                          value={draft.delivery ?? (e.delivery_charge === null ? '' : String(e.delivery_charge))}
                          onChange={(ev) => setDrafts((d) => ({ ...d, [e.id]: { ...d[e.id], delivery: ev.target.value } }))}
                          onBlur={() => { if (draft.delivery === undefined) return; const v = draft.delivery.trim(); void save(e, { delivery_charge: v === '' ? null : Number(v) }) }}
                          className="mt-0.5 h-9 w-full rounded-lg border border-gray-200 px-2 text-xs font-bold normal-case" data-testid="enq-delivery" />
                      </label>
                    </td>
                    <td className="px-2 py-3">
                      <select value={e.status} disabled={saving === e.id} onChange={(ev) => void save(e, { status: ev.target.value })} className="h-9 rounded-lg border border-gray-200 bg-white px-2 text-[11px] font-black text-[#111111]" data-testid="enq-status" aria-label={`Status of ${e.enquiry_no}`}>
                        {STATUSES.map((s) => <option key={s} value={s}>{ENQUIRY_STATUS_LABEL[s]}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-3 text-[11px]">
                      {e.note && <p className="mb-1 line-clamp-2 text-[#374151] break-words" title={e.note}><span className="font-black">Customer:</span> {e.note}</p>}
                      {e.delivery_date && <p className="mb-1 text-[#374151]" data-testid="enq-note-delivery"><span className="font-black">Delivery:</span> {dmy(e.delivery_date)}</p>}
                      <textarea rows={2} maxLength={1000} placeholder="Admin note" aria-label={`Admin note for ${e.enquiry_no}`}
                        value={draft.note ?? e.admin_note}
                        onChange={(ev) => setDrafts((d) => ({ ...d, [e.id]: { ...d[e.id], note: ev.target.value } }))}
                        onBlur={() => { if (draft.note !== undefined && draft.note !== e.admin_note) void save(e, { admin_note: draft.note }) }}
                        className="w-full rounded-lg border border-gray-200 px-2 py-1 text-xs" data-testid="enq-admin-note" />
                    </td>
                    <td className="px-2 py-3">
                      <button type="button" disabled={saving === e.id} onClick={(ev) => { ev.stopPropagation(); void remove(e) }} aria-label={`Delete ${e.enquiry_no}`}
                        className="inline-flex h-9 items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2.5 text-[11px] font-black text-red-700 hover:bg-red-100 cursor-pointer disabled:opacity-50" data-testid="enq-delete">
                        <Trash2 size={12} /> Delete
                      </button>
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && !loading && <tr><td colSpan={COLS.length} className="px-4 py-8 text-center text-[#374151]">No requests</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
