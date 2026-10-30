import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Download, MessageCircle, Send } from 'lucide-react'
import qrcode from 'qrcode-generator'
import { api } from '../../lib/apiClient'
import { canonicalPhone } from '../../lib/phone'
import { shopInviteText, shopLink, whatsappShareUrl, whatsappToUrl } from '../../lib/shopLink'
import type { PosBranch } from '../../store/store'

type Customer = { phone: string; name: string | null; last_at: string; visits: number }
const spaced = (p: string) => `${p.slice(0, 5)} ${p.slice(5)}`

const QR_PX = 640 // drawn large, shown small: the downloaded PNG stays sharp when printed

/** Top of the Admin "Online Shop" screen: the customer link, copy / WhatsApp share, and a QR code to download. */
export default function ShopLinkCard({ branch }: { branch?: PosBranch }) {
  // this branch's own link (/shop/<place>): customers land straight in this branch's shop
  const link = useMemo(() => shopLink(window.location.origin, branch), [branch])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [copied, setCopied] = useState(false)
  // send the link to one customer of this branch: recent (last 30 days) or everyone who has bought / asked here
  const [range, setRange] = useState<'recent' | 'all'>('recent')
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loadError, setLoadError] = useState('')
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState('')
  const [typed, setTyped] = useState('')

  useEffect(() => {
    if (!branch) return
    let cancelled = false
    api<{ customers: Customer[] }>('GET', '/api/shop-admin/customers', { query: { range }, branchId: branch })
      .then((r) => { if (!cancelled) { setCustomers(r.customers); setPicked(''); setLoadError('') } })
      .catch((e) => { if (!cancelled) { setCustomers([]); setLoadError(e instanceof Error ? e.message : 'Customers could not be loaded') } })
    return () => { cancelled = true }
  }, [branch, range])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    const digits = q.replace(/\D/g, '')
    return q ? customers.filter((c) => (c.name ?? '').toLowerCase().includes(q) || (digits.length > 0 && c.phone.includes(digits))) : customers
  }, [customers, search])
  const typedPhone = canonicalPhone(typed)
  const target = typedPhone ?? (picked || null)
  const targetName = typedPhone ? null : customers.find((c) => c.phone === picked)?.name ?? null

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const qr = qrcode(0, 'M')
    qr.addData(link)
    qr.make()
    const n = qr.getModuleCount()
    const quiet = 4 // modules of white border so phone cameras read it
    const cell = QR_PX / (n + quiet * 2)
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, QR_PX, QR_PX)
    ctx.fillStyle = '#111111'
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(Math.floor((c + quiet) * cell), Math.floor((r + quiet) * cell), Math.ceil(cell), Math.ceil(cell))
      }
    }
  }, [link])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
    } catch {
      // older browsers / no clipboard permission
      const ta = document.createElement('textarea')
      ta.value = link
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  const downloadPng = () => {
    canvasRef.current?.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `take250-shop-qr-${branch ?? 'all'}.png`
      a.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    }, 'image/png')
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-[#E8D399] bg-white p-3 sm:flex-row sm:items-center sm:p-4 shadow-sm" data-testid="shop-link-card">
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#6B7280]">Customer link</p>
        <p className="break-all rounded-xl bg-[#FBFAF6] px-3 py-2 text-sm font-black text-[#111111]" data-testid="shop-link">{link}</p>
        <p className="text-[11px] font-semibold text-[#6B7280]">Send this link to customers.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void copy()} className="inline-flex items-center gap-1.5 rounded-xl bg-[#111111] px-4 py-2 text-[13px] font-bold text-white cursor-pointer" data-testid="shop-link-copy">
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy link'}
          </button>
          <a href={whatsappShareUrl(link)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-xl bg-[#25D366] px-4 py-2 text-[13px] font-bold text-white" data-testid="shop-link-whatsapp">
            <MessageCircle size={14} /> Share on WhatsApp
          </a>
        </div>
        {branch && (
          <div className="space-y-2 rounded-xl border border-[#E5E7EB] bg-[#FBFAF6] p-3" data-testid="shop-link-send">
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#6B7280]">Send to a customer</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <select value={range} onChange={(e) => setRange(e.target.value as 'recent' | 'all')} aria-label="Which customers" className="h-10 rounded-xl border border-[#E5E7EB] bg-white px-3 text-[13px] font-bold text-[#111111]" data-testid="shop-link-range">
                <option value="recent">Recent customers (last 30 days)</option>
                <option value="all">All customers of this branch</option>
              </select>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or number" aria-label="Search customers" className="h-10 rounded-xl border border-[#E5E7EB] bg-white px-3 text-[13px] font-semibold" data-testid="shop-link-search" />
            </div>
            <select value={picked} onChange={(e) => { setPicked(e.target.value); setTyped('') }} aria-label="Customer" className="h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3 text-[13px] font-semibold text-[#111111]" data-testid="shop-link-customer">
              <option value="">{shown.length ? `Choose a customer (${shown.length})` : 'No customers found'}</option>
              {shown.map((c) => (
                <option key={c.phone} value={c.phone}>{`${c.name ?? 'No name'} · ${spaced(c.phone)} · last ${new Date(c.last_at).toLocaleDateString('en-IN')}`}</option>
              ))}
            </select>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} inputMode="tel" placeholder="or type a mobile number" aria-label="Mobile number" className="h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3 text-[13px] font-semibold" data-testid="shop-link-number" />
            {loadError && <p className="text-xs font-bold text-red-600" role="alert">{loadError}</p>}
            {typed.trim() !== '' && !typedPhone && <p className="text-xs font-bold text-red-600">Enter a valid 10-digit mobile number</p>}
            {target ? (
              <a href={whatsappToUrl(target, shopInviteText(link, targetName))} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-xl bg-[#25D366] px-4 py-2 text-[13px] font-bold text-white" data-testid="shop-link-send-wa">
                <Send size={14} /> Send on WhatsApp to {spaced(target)}
              </a>
            ) : (
              <button type="button" disabled className="inline-flex items-center gap-1.5 rounded-xl bg-[#25D366]/50 px-4 py-2 text-[13px] font-bold text-white" data-testid="shop-link-send-wa">
                <Send size={14} /> Send on WhatsApp
              </button>
            )}
            <p className="text-[11px] font-semibold text-[#6B7280]">WhatsApp opens with the message typed in; tap Send there.</p>
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-center gap-2">
        <canvas ref={canvasRef} width={QR_PX} height={QR_PX} className="h-36 w-36 rounded-lg border border-[#E5E7EB]" aria-label={`QR code for ${link}`} role="img" data-testid="shop-link-qr" />
        <button type="button" onClick={downloadPng} className="inline-flex items-center gap-1.5 rounded-xl border border-[#E5E7EB] bg-white px-3 py-1.5 text-[12px] font-bold text-[#111111] cursor-pointer" data-testid="shop-link-qr-download">
          <Download size={13} /> Download PNG
        </button>
      </div>
    </div>
  )
}
