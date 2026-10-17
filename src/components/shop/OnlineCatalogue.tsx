import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, ImagePlus, Plus, RefreshCw } from 'lucide-react'
import { api } from '../../lib/apiClient'
import { formatCurrency } from '../../lib/retail'
import { uploadProductImage } from '../../lib/storage'
import Toggle from '../common/Toggle'
import ShopLinkCard from './ShopLinkCard'
import type { PosBranch } from '../../store/store'

type Row = {
  id: number; name: string; category: string; price: number; offer_price: number | null; online_price: number | null
  online_description: string | null; online_sort: number | null; show_online: boolean; image: string | null
  has_variants: boolean; stock_quantity: number; variant_count: number
}

/**
 * Admin: the online catalogue of the branch in the switcher. Each branch has its own: which products show online, their
 * online price (blank = the normal price), description, order and image (the existing product image upload). Name, price,
 * sizes and stock stay on the Stock & Inventory screens.
 */
export default function OnlineCatalogue({ branch, onOpenInventory }: { branch: PosBranch; onOpenInventory: () => void }) {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [drafts, setDrafts] = useState<Record<number, Partial<Record<'price' | 'desc' | 'sort', string>>>>({})
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadFor = useRef<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setRows((await api<{ products: Row[] }>('GET', '/api/shop-admin/catalogue', { branchId: branch })).products); setPicked(new Set()) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load the catalogue') }
    finally { setLoading(false) }
  }, [branch])
  useEffect(() => { void load() }, [load])

  const patch = async (id: number, body: Record<string, unknown>) => {
    setError('')
    try {
      const res = await api<{ product: Partial<Row> & { image_url?: string | null } }>('PATCH', `/api/shop-admin/catalogue/${id}`, { body, branchId: branch })
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...res.product, image: res.product.image_url ?? r.image } : r)))
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save') }
  }
  const bulk = async (show: boolean) => {
    if (!picked.size) return
    try {
      const res = await api<{ updated: number }>('POST', '/api/shop-admin/catalogue/bulk', { body: { ids: [...picked], show_online: show }, branchId: branch })
      setNotice(`${res.updated} product(s) ${show ? 'shown' : 'hidden'} online.`); void load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update') }
  }
  const onFile = async (f: File | undefined) => {
    const id = uploadFor.current
    if (!f || id === null) return
    try { const url = await uploadProductImage(f, branch); await patch(id, { image_url: url }); setNotice('Image updated.') }
    catch (e) { setError(e instanceof Error ? e.message : 'Image upload failed') }
    finally { if (fileRef.current) fileRef.current.value = '' }
  }
  const field = (r: Row, k: 'price' | 'desc' | 'sort', current: string) => drafts[r.id]?.[k] ?? current
  const setDraft = (id: number, k: 'price' | 'desc' | 'sort', v: string) => setDrafts((d) => ({ ...d, [id]: { ...d[id], [k]: v } }))
  const shownCount = rows.filter((r) => r.show_online).length

  return (
    <div className="space-y-4 sm:space-y-6 rounded-[20px] sm:rounded-[28px] border border-[#E5E7EB]/60 bg-[#FBFAF6] p-3 sm:p-6 lg:p-7 shadow-sm" data-testid="online-catalogue">
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
      <ShopLinkCard branch={branch} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.24em] text-[#10B981]">Online shop</p>
          <h2 className="mt-1 text-xl font-black text-[#111111]">Online Shop Catalogue <span className="text-[11px] font-semibold text-[#374151]">({shownCount} of {rows.length} shown online)</span></h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onOpenInventory} className="inline-flex items-center gap-1.5 rounded-xl border border-[#E5E7EB] bg-white px-4 py-2 text-[13px] font-bold text-[#111111] cursor-pointer" data-testid="open-inventory"><ExternalLink size={14} /> Edit products in Stock &amp; Inventory</button>
          <button type="button" onClick={onOpenInventory} className="inline-flex items-center gap-1.5 rounded-xl bg-[#111111] px-4 py-2 text-[13px] font-bold text-white cursor-pointer"><Plus size={14} /> Add a product</button>
          <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1.5 rounded-xl border border-[#E5E7EB] bg-white px-3 py-2 text-[13px] font-bold text-[#111111] cursor-pointer"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></button>
        </div>
      </div>

      <div className="rounded-2xl border border-[#E5E7EB]/60 bg-white p-3 sm:p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold text-[#374151]">{picked.size} selected</span>
          <button type="button" disabled={!picked.size} onClick={() => void bulk(true)} className="rounded-lg bg-[#111111] px-3 py-1.5 text-[11px] font-black text-[#D4AF37] disabled:opacity-40 cursor-pointer" data-testid="bulk-show">Show selected online</button>
          <button type="button" disabled={!picked.size} onClick={() => void bulk(false)} className="rounded-lg border border-[#E5E7EB] px-3 py-1.5 text-[11px] font-black text-[#111111] disabled:opacity-40 cursor-pointer" data-testid="bulk-hide">Hide selected</button>
        </div>
        {notice && <p className="text-xs font-bold text-emerald-700">{notice}</p>}
        {error && <p className="text-xs font-bold text-red-600" role="alert">{error}</p>}
        <div className="overflow-x-auto rounded-xl border border-[#E5E7EB]/60 bg-[#FBFAF6]">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-[#F9FAFB] text-[10px] uppercase tracking-wider text-[#374151]">
              <tr>
                <th className="px-2 py-3"><input type="checkbox" aria-label="Select all" checked={rows.length > 0 && picked.size === rows.length} onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>
                {['Image', 'Product', 'Normal price', 'Show online', 'Online price', 'Description', 'Sort'].map((h) => <th key={h} className="px-2 py-3 font-black">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E5E7EB]/30 bg-white">
              {rows.map((r) => (
                <tr key={r.id} className="align-top hover:bg-[#F9FAFB]" data-testid="cat-row">
                  <td className="px-2 py-3"><input type="checkbox" aria-label={`Select ${r.name}`} checked={picked.has(r.id)} onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n })} /></td>
                  <td className="px-2 py-3">
                    <button type="button" onClick={() => { uploadFor.current = r.id; fileRef.current?.click() }} title="Change image" className="relative h-14 w-14 overflow-hidden rounded-lg border border-[#E5E7EB] bg-[#F9FAFB] cursor-pointer">
                      {r.image ? <img src={r.image} alt="" className="h-full w-full object-cover" /> : <ImagePlus size={18} className="mx-auto text-[#9CA3AF]" />}
                    </button>
                  </td>
                  <td className="px-2 py-3 text-[12px]">
                    <p className="font-black text-[#111111]">{r.name}</p>
                    <p className="text-[11px] text-[#6B7280]">{r.category || '—'}{r.variant_count > 0 ? ` · ${r.variant_count} size(s)` : ''}</p>
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 text-[12px] font-semibold text-[#374151]">{formatCurrency(Number(r.offer_price || r.price))}</td>
                  <td className="px-2 py-3"><Toggle checked={r.show_online} onChange={(v) => void patch(r.id, { show_online: v })} label={`Show ${r.name} online`} /></td>
                  <td className="px-2 py-3">
                    <input type="number" min={0} step="0.01" placeholder="Normal" aria-label={`Online price of ${r.name}`} value={field(r, 'price', r.online_price === null ? '' : String(r.online_price))}
                      onChange={(e) => setDraft(r.id, 'price', e.target.value)}
                      onBlur={() => { const v = drafts[r.id]?.price; if (v === undefined) return; void patch(r.id, { online_price: v.trim() === '' ? null : Number(v) }) }}
                      className="h-9 w-24 rounded-lg border border-gray-200 px-2 text-xs font-bold" />
                  </td>
                  <td className="px-2 py-3">
                    <textarea rows={2} maxLength={1000} placeholder="Shown to customers" aria-label={`Online description of ${r.name}`} value={field(r, 'desc', r.online_description ?? '')}
                      onChange={(e) => setDraft(r.id, 'desc', e.target.value)}
                      onBlur={() => { const v = drafts[r.id]?.desc; if (v === undefined) return; void patch(r.id, { online_description: v.trim() || null }) }}
                      className="w-56 rounded-lg border border-gray-200 px-2 py-1 text-xs" />
                  </td>
                  <td className="px-2 py-3">
                    <input type="number" step="1" aria-label={`Sort order of ${r.name}`} value={field(r, 'sort', r.online_sort === null ? '' : String(r.online_sort))}
                      onChange={(e) => setDraft(r.id, 'sort', e.target.value)}
                      onBlur={() => { const v = drafts[r.id]?.sort; if (v === undefined) return; void patch(r.id, { online_sort: v.trim() === '' ? null : Math.trunc(Number(v)) }) }}
                      className="h-9 w-16 rounded-lg border border-gray-200 px-2 text-xs font-bold" />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && !loading && <tr><td colSpan={8} className="px-4 py-8 text-center text-[#374151]">No products in this branch yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
