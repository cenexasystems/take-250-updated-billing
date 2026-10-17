import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, Download, Minus, Plus, Search, ShoppingBag, Trash2, X } from 'lucide-react'
import { THEME_PALETTE } from '../lib/brand'
import { formatCurrency } from '../lib/retail'
import { canonicalPhone } from '../lib/phone'

/**
 * The public online shop (/shop): no sign-in. A customer picks a branch, browses its "show online" products, and sends a
 * REQUEST (an enquiry): no payment, no stock change; the shop phones them to confirm and to agree the delivery charge.
 * Talks to /api/shop/* with plain fetch and NO cookies, so a signed-in staff browser behaves exactly like a customer's.
 * The cart lives in this browser (localStorage, per branch).
 */

type ShopBranch = { id: string; name: string; subtitle: string; logo: string }
type Variant = { id: string; name: string; price: number; in_stock: boolean; image: string | null }
type Product = { id: number; name: string; category: string; description: string; image: string | null; price: number; in_stock: boolean; variants: Variant[] }
type CartLine = { key: string; product_id: number; variant_id: string | null; name: string; variant_name: string | null; unit_price: number; quantity: number; image: string | null }
type Confirmation = { enquiry_no: string; created_at: string; branch: string; customer_name: string; items_total: number; items: Array<{ name: string; variant_name: string | null; quantity: number; unit_price: number; line_total: number }> }

const BRANCH_KEY = 'take250.shop.branch'
const cartKey = (b: string) => `take250.shop.cart.${b}`
const read = <T,>(k: string, fallback: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : fallback } catch { return fallback } }
const write = (k: string, v: unknown) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode: the cart lives for this visit only */ } }
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `shop-${Date.now()}-${Math.random().toString(36).slice(2)}`)

async function shopFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, credentials: 'omit', headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error || (res.status === 429 ? 'Too many requests. Please try again in a few minutes.' : 'Something went wrong. Please try again.'))
  return body as T
}

/** the confirmation card as a PNG (drawn on a canvas: no extra library) */
function confirmationPng(c: Confirmation): Promise<Blob | null> {
  const w = 720, lineH = 34
  const h = 380 + c.items.length * lineH
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const g = canvas.getContext('2d')
  if (!g) return Promise.resolve(null)
  g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, w, h)
  g.fillStyle = THEME_PALETTE.primary; g.fillRect(0, 0, w, 150)
  g.fillStyle = '#D4AF37'; g.font = 'bold 22px Arial'; g.fillText(`${c.branch} · Order Request`, 32, 46)
  g.font = 'bold 44px Arial'; g.fillText(c.enquiry_no, 32, 108)
  g.fillStyle = '#FFFFFF'; g.font = '16px Arial'; g.fillText(new Date(c.created_at).toLocaleString('en-IN'), 32, 136)
  g.fillStyle = '#111111'; g.font = 'bold 18px Arial'; g.fillText(`Name: ${c.customer_name}`.slice(0, 60), 32, 190)
  let y = 236
  g.font = '17px Arial'
  for (const i of c.items) {
    g.fillStyle = '#111111'; g.fillText(`${i.name}${i.variant_name ? ` (${i.variant_name})` : ''} × ${i.quantity}`.slice(0, 52), 32, y)
    g.textAlign = 'right'; g.fillText(formatCurrency(Number(i.line_total)), w - 32, y); g.textAlign = 'left'
    y += lineH
  }
  g.strokeStyle = '#D4AF37'; g.lineWidth = 2; g.beginPath(); g.moveTo(32, y - 14); g.lineTo(w - 32, y - 14); g.stroke()
  g.font = 'bold 20px Arial'; g.fillText('Total (excluding delivery)', 32, y + 16); g.textAlign = 'right'; g.fillText(formatCurrency(Number(c.items_total)), w - 32, y + 16); g.textAlign = 'left'
  g.fillStyle = '#6B7280'; g.font = '16px Arial'; g.fillText('The shop will contact you shortly to confirm the order and the delivery charge.', 32, y + 60)
  g.fillText('Keep this request ID when you talk to the shop.', 32, y + 86)
  return new Promise((res) => canvas.toBlob(res, 'image/png'))
}

export default function Shop() {
  const [branches, setBranches] = useState<ShopBranch[]>([])
  const [branchId, setBranchId] = useState<string | null>(() => read<string | null>(BRANCH_KEY, null))
  const [products, setProducts] = useState<Product[]>([])
  const [cart, setCart] = useState<CartLine[]>([])
  const [view, setView] = useState<'shop' | 'cart' | 'checkout' | 'done'>('shop')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [detail, setDetail] = useState<Product | null>(null)
  const [size, setSize] = useState<Record<number, string>>({})
  const [added, setAdded] = useState<CartLine | null>(null)
  const [switchTo, setSwitchTo] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false) // the shop list is open while a shop is still selected
  const [form, setForm] = useState({ name: '', phone: '', address: '', note: '', website: '' })
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState<Confirmation | null>(null)
  const keyRef = useRef(newKey())

  useEffect(() => { document.title = 'Take250 Online Shop' }, [])
  useEffect(() => {
    shopFetch<{ branches: ShopBranch[] }>('/api/shop/branches')
      .then((r) => { setBranches(r.branches); if (branchId && !r.branches.some((b) => b.id === branchId)) { setBranchId(null); write(BRANCH_KEY, null) } })
      .catch((e) => setError(e instanceof Error ? e.message : 'The shop is not available right now'))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadCatalogue = useCallback(async (b: string) => {
    setLoading(true); setError('')
    try { setProducts((await shopFetch<{ products: Product[] }>(`/api/shop/catalogue/${encodeURIComponent(b)}`)).products) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load the products'); setProducts([]) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { if (branchId) { setCart(read<CartLine[]>(cartKey(branchId), [])); void loadCatalogue(branchId) } }, [branchId, loadCatalogue])
  const saveCart = (next: CartLine[]) => { setCart(next); if (branchId) write(cartKey(branchId), next) }

  const branch = branches.find((b) => b.id === branchId) ?? null
  const categories = useMemo(() => ['All', ...Array.from(new Set(products.map((p) => p.category).filter(Boolean))).sort()], [products])
  const shown = products.filter((p) => (category === 'All' || p.category === category) && (!search.trim() || `${p.name} ${p.category}`.toLowerCase().includes(search.trim().toLowerCase())))
  const count = cart.reduce((s, l) => s + l.quantity, 0)
  const total = Math.round(cart.reduce((s, l) => s + l.unit_price * l.quantity, 0) * 100) / 100

  const pickBranch = (id: string) => {
    if (branchId && id !== branchId && read<CartLine[]>(cartKey(branchId), []).length) { setSwitchTo(id); return }
    setBranchId(id); write(BRANCH_KEY, id); setView('shop'); setCategory('All'); setSearch(''); setChoosing(false)
  }
  const confirmSwitch = (clear: boolean) => {
    if (clear && branchId) write(cartKey(branchId), null)
    if (clear && switchTo) { setBranchId(switchTo); write(BRANCH_KEY, switchTo); setView('shop'); setCategory('All') }
    setSwitchTo(null); setChoosing(false)
  }
  const addToCart = (p: Product) => {
    const v = p.variants.length ? p.variants.find((x) => x.id === size[p.id]) : null
    if (p.variants.length && !v) { setError(`Please choose a size for ${p.name}`); return }
    const key = `${p.id}:${v?.id ?? ''}`
    const line: CartLine = { key, product_id: p.id, variant_id: v?.id ?? null, name: p.name, variant_name: v?.name ?? null, unit_price: v?.price ?? p.price, quantity: 1, image: v?.image || p.image }
    const existing = cart.find((l) => l.key === key)
    saveCart(existing ? cart.map((l) => (l.key === key ? { ...l, quantity: Math.min(99, l.quantity + 1) } : l)) : [...cart, line])
    setError(''); setDetail(null); setAdded(line)
  }
  const setQty = (key: string, q: number) => saveCart(q <= 0 ? cart.filter((l) => l.key !== key) : cart.map((l) => (l.key === key ? { ...l, quantity: Math.min(99, q) } : l)))

  const send = async () => {
    setError('')
    if (!form.name.trim()) { setError('Please enter your name'); return }
    if (!canonicalPhone(form.phone)) { setError('Please enter a valid 10-digit mobile number'); return }
    if (!form.address.trim()) { setError('Please enter the delivery address'); return }
    setSending(true)
    try {
      const res = await shopFetch<{ enquiry: Confirmation }>('/api/shop/enquiries', { method: 'POST', body: JSON.stringify({
        shop: branchId, customer_name: form.name, phone: form.phone, address: form.address, note: form.note,
        items: cart.map((l) => ({ product_id: l.product_id, variant_id: l.variant_id, quantity: l.quantity })),
        idempotency_key: keyRef.current, website: form.website }) })
      setDone(res.enquiry); saveCart([]); keyRef.current = newKey(); setView('done')
    } catch (e) { setError(e instanceof Error ? e.message : 'The request could not be sent') }
    finally { setSending(false) }
  }
  const saveImage = async () => {
    if (!done) return
    const blob = await confirmationPng(done)
    if (!blob) { setError('Could not create the image. Please take a screenshot instead.'); return }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${done.enquiry_no}.png`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }

  const gold = '#D4AF37'
  const header = (
    <header className="sticky top-0 z-30 bg-[#111111] text-white shadow-md">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
        <button type="button" onClick={() => { setView('shop') }} className="flex min-w-0 items-center gap-2.5 text-left cursor-pointer">
          {branch?.logo ? <img src={branch.logo} alt="" className="h-10 w-10 shrink-0 rounded-full border border-[#D4AF37]/50 bg-black object-contain" data-testid="shop-logo" /> : <ShoppingBag className="h-8 w-8 text-[#D4AF37]" />}
          <div className="min-w-0">
            <p className="truncate text-[15px] font-black tracking-wide text-[#D4AF37]">{branch?.name ?? 'TAKE250'}</p>
            <p className="truncate text-[11px] font-semibold text-white/70">{branch ? branch.subtitle || 'Online shop' : 'Online shop'}</p>
          </div>
        </button>
        {branch && (
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={() => setChoosing(true)} className="rounded-full border border-white/20 px-3 py-1.5 text-[11px] font-black text-white/90 cursor-pointer" data-testid="shop-change-branch">Change shop</button>
            <button type="button" onClick={() => setView('cart')} className="relative rounded-full bg-[#D4AF37] p-2.5 text-[#111111] cursor-pointer" aria-label={`Cart, ${count} item(s)`} data-testid="shop-cart-button">
              <ShoppingBag size={18} />
              {count > 0 && <span className="absolute -right-1 -top-1 min-w-[20px] rounded-full bg-white px-1 text-center text-[11px] font-black text-[#111111]" data-testid="shop-cart-count">{count}</span>}
            </button>
          </div>
        )}
      </div>
    </header>
  )
  // switching shop with items in the cart (shown over the shop list)
  const switchDialog = switchTo && (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" role="dialog" aria-modal="true" aria-label="Change shop">
      <div className="w-full max-w-md rounded-t-3xl bg-white p-5 sm:rounded-3xl">
        <p className="text-base font-black text-[#111111]">Change shop?</p>
        <p className="mt-1 text-sm text-[#374151]">Your cart has items from this shop. Changing the shop clears the cart.</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => confirmSwitch(false)} className="h-12 rounded-xl border border-[#E5E7EB] bg-white text-sm font-black text-[#111111] cursor-pointer">Keep my cart</button>
          <button type="button" onClick={() => confirmSwitch(true)} className="h-12 rounded-xl bg-[#111111] text-sm font-black text-[#D4AF37] cursor-pointer" data-testid="shop-switch-clear">Clear cart and change</button>
        </div>
      </div>
    </div>
  )
  const errorBox = error && <p className="mx-4 mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-700" role="alert" data-testid="shop-error">{error}</p>

  // ---- branch selector
  // (html, body and #root are locked to the screen for the POS: each shop view scrolls in its own full-height .app-scroll)
  if (!branchId || !branch || choosing) {
    return (
      <div className="app-scroll h-[100dvh] overflow-x-hidden overflow-y-auto overscroll-contain bg-[#FBFAF6]" data-testid="shop-home">
        {header}
        {errorBox}
        <main className="mx-auto max-w-3xl px-4 py-6">
          <h1 className="text-2xl font-black text-[#111111]">Welcome to TAKE250</h1>
          <p className="mt-1 text-sm font-semibold text-[#6B7280]">Choose your nearest shop to see its products.</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {branches.map((b) => (
              <button key={b.id} type="button" onClick={() => pickBranch(b.id)} className="flex items-center gap-3 rounded-2xl border border-[#E8D399] bg-white p-4 text-left shadow-sm hover:border-[#D4AF37] cursor-pointer" data-testid="shop-branch">
                <img src={b.logo} alt="" className="h-14 w-14 shrink-0 rounded-full border border-[#E8D399] bg-black object-contain" />
                <div className="min-w-0"><p className="font-black text-[#111111]">{b.name}</p><p className="text-[12px] font-semibold text-[#6B7280]">{b.subtitle}</p></div>
              </button>
            ))}
          </div>
        </main>
        {switchDialog}
      </div>
    )
  }

  return (
    <div className="app-scroll h-[100dvh] overflow-x-hidden overflow-y-auto overscroll-contain bg-[#FBFAF6] pb-24" data-testid="shop-page">
      {header}
      {errorBox}

      {view === 'shop' && (
        <main className="mx-auto max-w-3xl px-4 py-4" data-testid="shop-catalogue">
          <label className="relative block">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#9CA3AF]" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products" className="h-11 w-full rounded-xl border border-[#E5E7EB] bg-white pl-9 pr-3 text-sm font-semibold outline-none focus:border-[#D4AF37]" data-testid="shop-search" />
          </label>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {categories.map((c) => (
              <button key={c} type="button" onClick={() => setCategory(c)} className={`shrink-0 rounded-full px-3.5 py-1.5 text-[12px] font-black cursor-pointer ${category === c ? 'bg-[#111111] text-[#D4AF37]' : 'border border-[#E5E7EB] bg-white text-[#374151]'}`}>{c}</button>
            ))}
          </div>
          {loading && <p className="mt-6 text-center text-sm font-semibold text-[#6B7280]">Loading…</p>}
          {!loading && shown.length === 0 && <p className="mt-6 text-center text-sm font-semibold text-[#6B7280]">No products to show yet.</p>}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {shown.map((p) => (
              <div key={p.id} className="flex flex-col overflow-hidden rounded-2xl border border-[#E5E7EB] bg-white shadow-sm" data-testid="shop-product">
                <button type="button" onClick={() => setDetail(p)} className="aspect-square w-full bg-[#F3F4F6] cursor-pointer" aria-label={`View ${p.name}`}>
                  {p.image ? <img src={p.image} alt="" className="h-full w-full object-cover" loading="lazy" /> : <ShoppingBag className="mx-auto h-10 w-10 text-[#D1D5DB]" />}
                </button>
                <div className="flex flex-1 flex-col p-3">
                  <p className="line-clamp-2 text-[13px] font-black text-[#111111]">{p.name}</p>
                  <p className="mt-0.5 text-[14px] font-black" style={{ color: THEME_PALETTE.accentDark }}>{p.variants.length > 1 ? 'from ' : ''}{formatCurrency(p.price)}</p>
                  <span className={`mt-1 w-fit rounded-full px-2 py-0.5 text-[10px] font-black ${p.in_stock ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`} data-testid="shop-stock">{p.in_stock ? 'In stock' : 'Out of stock'}</span>
                  {p.variants.length > 0 && (
                    <select value={size[p.id] ?? ''} onChange={(e) => setSize((s) => ({ ...s, [p.id]: e.target.value }))} className="mt-2 h-9 rounded-lg border border-[#E5E7EB] bg-white px-2 text-[12px] font-bold" aria-label={`Size of ${p.name}`} data-testid="shop-size">
                      <option value="">Choose size</option>
                      {p.variants.map((v) => <option key={v.id} value={v.id} disabled={!v.in_stock}>{v.name} · {formatCurrency(v.price)}{v.in_stock ? '' : ' (out of stock)'}</option>)}
                    </select>
                  )}
                  <button type="button" disabled={!p.in_stock} onClick={() => addToCart(p)} className="mt-auto block w-full rounded-xl bg-[#111111] py-2 text-center text-[12px] font-black text-[#D4AF37] disabled:opacity-40 cursor-pointer" style={{ marginTop: 'auto' }} data-testid="shop-add">{p.in_stock ? 'Add to cart' : 'Out of stock'}</button>
                </div>
              </div>
            ))}
          </div>
        </main>
      )}

      {view === 'cart' && (
        <main className="mx-auto max-w-3xl px-4 py-4" data-testid="shop-cart">
          <button type="button" onClick={() => setView('shop')} className="mb-3 inline-flex items-center gap-1 text-sm font-black text-[#111111] cursor-pointer"><ArrowLeft size={16} /> Continue shopping</button>
          <h1 className="text-xl font-black text-[#111111]">Your cart</h1>
          {cart.length === 0 && <p className="mt-6 text-sm font-semibold text-[#6B7280]">Your cart is empty.</p>}
          <div className="mt-3 space-y-2">
            {cart.map((l) => (
              <div key={l.key} className="flex items-center gap-3 rounded-2xl border border-[#E5E7EB] bg-white p-3" data-testid="shop-cart-line">
                <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-[#F3F4F6]">{l.image && <img src={l.image} alt="" className="h-full w-full object-cover" />}</div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-black text-[#111111]">{l.name}</p>
                  {l.variant_name && <p className="text-[11px] font-semibold text-[#6B7280]">Size: {l.variant_name}</p>}
                  <p className="text-[12px] font-black" style={{ color: THEME_PALETTE.accentDark }}>{formatCurrency(l.unit_price)}</p>
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => setQty(l.key, l.quantity - 1)} className="h-8 w-8 rounded-lg border border-[#E5E7EB] cursor-pointer" aria-label="Less"><Minus size={14} className="mx-auto" /></button>
                  <span className="w-7 text-center text-sm font-black" data-testid="shop-qty">{l.quantity}</span>
                  <button type="button" onClick={() => setQty(l.key, l.quantity + 1)} className="h-8 w-8 rounded-lg border border-[#E5E7EB] cursor-pointer" aria-label="More"><Plus size={14} className="mx-auto" /></button>
                  <button type="button" onClick={() => setQty(l.key, 0)} className="ml-1 h-8 w-8 rounded-lg text-red-600 cursor-pointer" aria-label="Remove"><Trash2 size={15} className="mx-auto" /></button>
                </div>
              </div>
            ))}
          </div>
          {cart.length > 0 && (
            <div className="mt-4 rounded-2xl border border-[#E8D399] bg-white p-4">
              <div className="flex justify-between text-base font-black text-[#111111]"><span>Total</span><span data-testid="shop-total">{formatCurrency(total)}</span></div>
              <p className="mt-1 text-[12px] font-semibold text-[#6B7280]">Excluding delivery; delivery charge confirmed by the shop.</p>
              <button type="button" onClick={() => setView('checkout')} className="mt-3 h-12 w-full rounded-xl bg-[#111111] text-sm font-black text-[#D4AF37] cursor-pointer" data-testid="shop-to-checkout">Checkout</button>
            </div>
          )}
        </main>
      )}

      {view === 'checkout' && (
        <main className="mx-auto max-w-3xl px-4 py-4" data-testid="shop-checkout">
          <button type="button" onClick={() => setView('cart')} className="mb-3 inline-flex items-center gap-1 text-sm font-black text-[#111111] cursor-pointer"><ArrowLeft size={16} /> Back to cart</button>
          <h1 className="text-xl font-black text-[#111111]">Your details</h1>
          <div className="mt-3 space-y-3 rounded-2xl border border-[#E5E7EB] bg-white p-4">
            <label className="block text-[11px] font-black uppercase text-[#6B7280]">Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} autoComplete="name" className="mt-1 h-11 w-full rounded-xl border border-[#E5E7EB] px-3 text-sm font-semibold outline-none focus:border-[#D4AF37]" data-testid="shop-name" /></label>
            <label className="block text-[11px] font-black uppercase text-[#6B7280]">Mobile number<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} type="tel" inputMode="tel" autoComplete="tel" placeholder="10-digit mobile number" className="mt-1 h-11 w-full rounded-xl border border-[#E5E7EB] px-3 text-sm font-semibold outline-none focus:border-[#D4AF37]" data-testid="shop-phone" /></label>
            <label className="block text-[11px] font-black uppercase text-[#6B7280]">Delivery address<textarea value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} maxLength={500} rows={3} autoComplete="street-address" className="mt-1 w-full rounded-xl border border-[#E5E7EB] px-3 py-2 text-sm font-semibold outline-none focus:border-[#D4AF37]" data-testid="shop-address" /></label>
            <label className="block text-[11px] font-black uppercase text-[#6B7280]">Note (optional)<textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={500} rows={2} className="mt-1 w-full rounded-xl border border-[#E5E7EB] px-3 py-2 text-sm font-semibold outline-none focus:border-[#D4AF37]" data-testid="shop-note" /></label>
            {/* honeypot: hidden from people, filled in by bots */}
            <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 opacity-0" />
            <p className="text-[11px] font-semibold text-[#6B7280]">We use these details only to process your request.</p>
          </div>
          <div className="mt-4 rounded-2xl border border-[#E8D399] bg-white p-4">
            <div className="flex justify-between text-sm font-black text-[#111111]"><span>{count} item(s)</span><span>{formatCurrency(total)}</span></div>
            <p className="mt-1 text-[12px] font-semibold text-[#6B7280]">Excluding delivery; delivery charge confirmed by the shop. No payment now.</p>
            <button type="button" disabled={sending || !cart.length} onClick={() => void send()} className="mt-3 h-12 w-full rounded-xl bg-[#111111] text-sm font-black text-[#D4AF37] disabled:opacity-50 cursor-pointer" data-testid="shop-send">{sending ? 'Sending…' : 'Send request'}</button>
          </div>
        </main>
      )}

      {view === 'done' && done && (
        <main className="mx-auto max-w-3xl px-4 py-6" data-testid="shop-done">
          <div className="overflow-hidden rounded-3xl border-2 border-[#D4AF37] bg-white shadow-xl">
            <div className="bg-[#111111] p-5 text-white">
              <p className="text-[12px] font-black uppercase tracking-widest" style={{ color: gold }}>{done.branch} · Order Request</p>
              <p className="mt-1 text-3xl font-black tracking-wide" style={{ color: gold }} data-testid="shop-enquiry-no">{done.enquiry_no}</p>
              <p className="mt-1 text-[12px] text-white/70">{new Date(done.created_at).toLocaleString('en-IN')}</p>
            </div>
            <div className="p-5">
              <p className="flex items-center gap-2 text-base font-black text-emerald-700"><Check size={18} /> The shop will contact you shortly</p>
              <div className="mt-3 space-y-1">
                {done.items.map((i, k) => (
                  <div key={k} className="flex justify-between gap-3 text-sm"><span className="text-[#111111]">{i.name}{i.variant_name ? ` (${i.variant_name})` : ''} × {i.quantity}</span><span className="font-bold">{formatCurrency(Number(i.line_total))}</span></div>
                ))}
              </div>
              <div className="mt-3 flex justify-between border-t border-[#E8D399] pt-3 text-base font-black text-[#111111]"><span>Total</span><span>{formatCurrency(Number(done.items_total))}</span></div>
              <p className="text-[12px] font-semibold text-[#6B7280]">Excluding delivery; delivery charge confirmed by the shop.</p>
            </div>
          </div>
          <button type="button" onClick={() => void saveImage()} className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#111111] text-sm font-black text-[#D4AF37] cursor-pointer" data-testid="shop-save-image"><Download size={16} /> Save as image</button>
          <p className="mt-2 text-center text-[12px] font-semibold text-[#6B7280]">You can also take a screenshot of this page.</p>
          <button type="button" onClick={() => { setDone(null); setView('shop') }} className="mt-3 h-11 w-full rounded-xl border border-[#E5E7EB] bg-white text-sm font-black text-[#111111] cursor-pointer">Back to the shop</button>
        </main>
      )}

      {/* product detail */}
      {detail && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 sm:items-center" role="dialog" aria-modal="true" aria-label={detail.name} data-testid="shop-detail" onClick={() => setDetail(null)}>
          <div className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3"><h2 className="text-lg font-black text-[#111111]">{detail.name}</h2><button type="button" onClick={() => setDetail(null)} aria-label="Close" className="cursor-pointer"><X size={20} /></button></div>
            <div className="mt-3 aspect-square w-full overflow-hidden rounded-2xl bg-[#F3F4F6]">{detail.image && <img src={detail.image} alt="" className="h-full w-full object-cover" />}</div>
            <p className="mt-3 text-xl font-black" style={{ color: THEME_PALETTE.accentDark }}>{formatCurrency(detail.variants.find((v) => v.id === size[detail.id])?.price ?? detail.price)}</p>
            <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-black ${detail.in_stock ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>{detail.in_stock ? 'In stock' : 'Out of stock'}</span>
            {detail.description && <p className="mt-3 whitespace-pre-line text-sm text-[#374151]">{detail.description}</p>}
            {detail.variants.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {detail.variants.map((v) => (
                  <button key={v.id} type="button" disabled={!v.in_stock} onClick={() => setSize((s) => ({ ...s, [detail.id]: v.id }))}
                    className={`rounded-xl border px-3 py-2 text-[12px] font-black disabled:opacity-40 cursor-pointer ${size[detail.id] === v.id ? 'border-[#111111] bg-[#111111] text-[#D4AF37]' : 'border-[#E5E7EB] bg-white text-[#111111]'}`} data-testid="shop-detail-size">{v.name}</button>
                ))}
              </div>
            )}
            <button type="button" disabled={!detail.in_stock} onClick={() => addToCart(detail)} className="mt-4 h-12 w-full rounded-xl bg-[#111111] text-sm font-black text-[#D4AF37] disabled:opacity-40 cursor-pointer" data-testid="shop-detail-add">Add to cart</button>
          </div>
        </div>
      )}

      {/* added: Checkout or Continue shopping */}
      {added && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" role="dialog" aria-modal="true" aria-label="Added to cart" data-testid="shop-added">
          <div className="w-full max-w-md rounded-t-3xl bg-white p-5 sm:rounded-3xl">
            <p className="flex items-center gap-2 text-base font-black text-[#111111]"><Check size={18} className="text-emerald-600" /> Added to your cart</p>
            <p className="mt-1 text-sm text-[#374151]">{added.name}{added.variant_name ? ` (${added.variant_name})` : ''}</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setAdded(null)} className="h-12 rounded-xl border border-[#E5E7EB] bg-white text-sm font-black text-[#111111] cursor-pointer">Continue shopping</button>
              <button type="button" onClick={() => { setAdded(null); setView('cart') }} className="h-12 rounded-xl bg-[#111111] text-sm font-black text-[#D4AF37] cursor-pointer">Checkout</button>
            </div>
          </div>
        </div>
      )}

      {switchDialog}
    </div>
  )
}
