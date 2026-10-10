import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { CalendarDays, CheckCircle2, Clock3, Download, Eye, FileText, MessageCircle, PackageCheck, Printer, RefreshCw, Search, X, Trash2 } from 'lucide-react'
import { api } from '../lib/apiClient'
import { formatCurrency } from '../lib/retail'
import { invoicePdfFile } from '../lib/invoicePdf'
import { printThermalReceipt } from '../lib/thermalPrint'
import { buildAdvanceDepositWhatsAppMessage, buildProfessionalWhatsAppMessage, publicInvoiceUrl } from '../lib/whatsappMessage'
import { formatPhoneForDisplay, toWhatsAppUrl } from '../lib/phone'
import { advanceReceiptPdf, downloadFile, printAdvanceReceipt } from '../lib/advanceReceipt'
import { useAdminAuthStore, useProductStore, resolveBranch } from '../store/store'
import { fetchVariantsByProduct, type ProductVariant } from '../services/variantService'
import { formatDateDMY } from '../lib/formatDate'
import { can } from '../lib/permissions'
import { getPeriodBounds } from '../lib/dateRanges'
import {
  addAdvanceEvent, completeAdvanceOrder, createAdvanceOrder, getAdvanceOrderHistory, listAdvanceOrders, updateAdvanceStatus, deleteAdvanceOrder,
  type AdvanceOrder, type AdvancePayment, type AdvancePaymentMethod, type AdvanceStatus, type AdvanceTimeline,
} from '../services/advanceOrderService'

// Custom Malaysian Ringgit icon
const RMIcon = ({ size = 20, className = '' }: { size?: number; className?: string }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-label="Indian Rupee">
    <rect x="2" y="2" width="20" height="20" rx="4" />
    <text x="12" y="16" textAnchor="middle" fontSize="9" fontWeight="bold" stroke="none" fill="currentColor" fontFamily="Arial, sans-serif">₹</text>
  </svg>
)

type DateFilter = 'all' | 'today' | 'week' | 'month' | 'year' | 'custom'
type StatusFilter = 'all' | 'pending' | 'ready' | 'completed' | 'cancelled'

const STATUS_LABELS: Record<AdvanceStatus, string> = {
  pending_deposit: 'Pending Deposit', ready_for_delivery: 'Ready for Delivery', waiting_final_payment: 'Waiting for Final Payment', completed: 'Completed', cancelled: 'Cancelled',
}
const STATUS_STYLES: Record<AdvanceStatus, string> = {
  pending_deposit: 'bg-amber-50 text-amber-700 border-amber-200', ready_for_delivery: 'bg-blue-50 text-blue-700 border-blue-200',
  waiting_final_payment: 'bg-violet-50 text-violet-700 border-violet-200', completed: 'bg-emerald-50 text-emerald-700 border-emerald-200', cancelled: 'bg-red-50 text-red-700 border-red-200',
}
const initialForm = { customerName: '', phone: '', address: '', productName: '', category: '', description: '', totalAmount: '', depositAmount: '', expectedDeliveryDate: '', status: 'pending_deposit' as AdvanceStatus, remarks: '', reference_number: '', paymentMethod: 'cash' as AdvancePaymentMethod }

type AdvanceOrdersProps = {
  onOrderCompleted?: (order?: AdvanceOrder) => void
  onOrderDeleted?: (orderId: string, completedOrderId?: string | null) => void
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="mb-1.5 block text-[11px] font-black uppercase tracking-wide text-[#6B7280]">{label}</span>{children}</label> }
const inputClass = 'w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 py-2.5 text-sm text-[#273126] outline-none transition focus:border-[#7e22ce] focus:ring-2 focus:ring-violet-100'

export default function AdvanceOrders({ onOrderCompleted, onOrderDeleted }: AdvanceOrdersProps = {}) {
  const role = useAdminAuthStore(state => state.role)
  const branch = useAdminAuthStore(state => resolveBranch(state.activeBranch))
  const products = useProductStore(state => state.products)
  const [orders, setOrders] = useState<AdvanceOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState(initialForm)
  const [saving, setSaving] = useState(false)
  const [variantChoices, setVariantChoices] = useState<ProductVariant[]>([])
  const [variantId, setVariantId] = useState('')
  const variantReq = useRef(0)
  const pickProduct = (product?: { id: string | number; hasVariants?: boolean }) => {
    const req = ++variantReq.current
    setVariantId(''); setVariantChoices([])
    if (!product?.hasVariants) return
    void fetchVariantsByProduct(String(product.id), branch).then(list => { if (req === variantReq.current) setVariantChoices(list.filter(v => v.isActive)) })
  }
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [dateFilter, setDateFilter] = useState<DateFilter>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [selected, setSelected] = useState<AdvanceOrder | null>(null)
  const [timeline, setTimeline] = useState<AdvanceTimeline[]>([])
  const [payments, setPayments] = useState<AdvancePayment[]>([])
  const [paymentOrder, setPaymentOrder] = useState<AdvanceOrder | null>(null)
  const [paymentForm, setPaymentForm] = useState({ method: 'cash' as AdvancePaymentMethod | 'split', remarks: '' })
  const [splitP1Type, setSplitP1Type] = useState<'cash' | 'upi' | 'card'>('cash')
  const [splitP1Amount, setSplitP1Amount] = useState('')
  const [splitP2Type, setSplitP2Type] = useState<'cash' | 'upi' | 'card'>('upi')
  const [couponInput, setCouponInput] = useState('')
  const [appliedCoupon, setAppliedCoupon] = useState<{ code: string; percentage: number } | null>(null)
  const [couponError, setCouponError] = useState('')
  const [availableCoupons, setAvailableCoupons] = useState<{ code: string; percentage: number }[]>([])
  const [manualDiscount, setManualDiscount] = useState('')
  const [manualDiscountType, setManualDiscountType] = useState<'rm' | '%'>('rm')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setOrders(await listAdvanceOrders(branch)) } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load advance orders') } finally { setLoading(false) }
  }, [branch])
  useEffect(() => { void load() }, [load])

  const handleDeleteOrder = async (orderId: string, orderName: string) => {
    if (!window.confirm(`Are you sure you want to delete advance order "${orderName}"? This action cannot be undone.`)) return
    try {
      const target = orders.find(o => o.id === orderId)
      const completedOrderId = target?.completed_order_id || null
      await deleteAdvanceOrder(orderId)
      setOrders(orders => orders.filter(o => o.id !== orderId))
      onOrderDeleted?.(orderId, completedOrderId)
      setNotice('Order deleted successfully')
      setTimeout(() => setNotice(''), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete order')
    }
  }

  // Fetch active coupons for the payment modal
  useEffect(() => {
    api<{ coupons: { code: string; percentage: number }[] }>('GET', '/api/coupons/available', { branchId: branch })
      .then((d) => setAvailableCoupons(d.coupons))
      .catch(() => undefined)
  }, [branch])

  const applyCoupon = () => {
    const code = couponInput.trim().toUpperCase()
    const found = availableCoupons.find(c => c.code.toUpperCase() === code)
    if (!found) { setCouponError('Invalid or inactive coupon code.'); return }
    setAppliedCoupon(found)
    setCouponError('')
  }

  const removeCoupon = () => { setAppliedCoupon(null); setCouponInput(''); setCouponError('') }

  // Close modals or drawer on Escape key
  useEffect(() => {
    if (!selected && !createOpen && !paymentOrder) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selected) setSelected(null)
        else if (paymentOrder) setPaymentOrder(null)
        else if (createOpen) setCreateOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selected, createOpen, paymentOrder])

  // Prevent background scroll when modal or drawer is open
  useEffect(() => {
    const isAnyOpen = !!(selected || createOpen || paymentOrder)
    if (isAnyOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [selected, createOpen, paymentOrder])

  const openDetails = async (order: AdvanceOrder) => {
    setSelected(order); setTimeline([]); setPayments([])
    try { const history = await getAdvanceOrderHistory(order.id); setTimeline(history.timeline); setPayments(history.payments) } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load order details') }
  }

  const periodOrders = useMemo(() => orders.filter(order => {
    if (dateFilter === 'custom') {
      const createdAt = new Date(order.created_at)
      const createdKey = `${createdAt.getFullYear()}-${String(createdAt.getMonth() + 1).padStart(2, '0')}-${String(createdAt.getDate()).padStart(2, '0')}`
      return (!dateFrom || createdKey >= dateFrom) && (!dateTo || createdKey <= dateTo)
    }
    if (dateFilter === 'all') return true
    const created = new Date(order.created_at)
    const { start, end } = getPeriodBounds(dateFilter)
    return created >= start && created <= end
  }), [orders, dateFilter, dateFrom, dateTo])

  const analytics = useMemo(() => ({
    total: periodOrders.length,
    pending: periodOrders.filter(o => o.status === 'pending_deposit' || o.status === 'waiting_final_payment').length,
    pendingDepositReceived: periodOrders.filter(o => o.status === 'pending_deposit').reduce((sum, o) => sum + o.deposit_amount, 0),
    outstanding: periodOrders.filter(o => !['completed', 'cancelled'].includes(o.status)).reduce((sum, o) => sum + o.remaining_balance, 0),
    value: periodOrders.filter(o => o.status !== 'cancelled').reduce((sum, o) => sum + o.total_amount, 0),
    ready: periodOrders.filter(o => o.status === 'ready_for_delivery').length,
    completed: periodOrders.filter(o => o.status === 'completed').length,
  }), [periodOrders])

  const filtered = useMemo(() => periodOrders.filter(order => {
    const query = search.trim().toLowerCase()
    const searchable = [order.deposit_id, order.customer_name, order.phone, order.product_name, STATUS_LABELS[order.status]].join(' ').toLowerCase()
    if (query && !searchable.includes(query)) return false
    if (statusFilter === 'pending' && !['pending_deposit', 'waiting_final_payment'].includes(order.status)) return false
    if (statusFilter === 'ready' && order.status !== 'ready_for_delivery') return false
    if (statusFilter === 'completed' && order.status !== 'completed') return false
    if (statusFilter === 'cancelled' && order.status !== 'cancelled') return false
    return true
  }), [periodOrders, search, statusFilter])

  // Double-tap protection: `createLock` is set synchronously (state would only change after the next render, so a quick
  // second tap on a slow phone could still get through) and `createKey` is the idempotency key of THIS form: a retry
  // after a slow or lost response returns the first advance order instead of creating another.
  const createLock = useRef(false)
  const createKey = useRef<{ key: string; fp: string } | null>(null) // bound to the form's content: an edited form gets a new key

  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (createLock.current) return
    setError(''); setNotice('')
    const total = Number(form.totalAmount); const deposit = Number(form.depositAmount)
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(deposit) || deposit <= 0 || deposit >= total) { setError('Deposit must be greater than ₹0 and less than the total order amount.'); return }
    // a product with sizes/variants must say which one, so stock is taken from the right variant at completion
    const chosenVariant = variantChoices.find(v => v.id === variantId)
    if (variantChoices.length > 0 && !chosenVariant) { setError('Select the variant (size) for this product.'); return }
    createLock.current = true; setSaving(true)
    const createFp = JSON.stringify([variantId, form.customerName, form.phone, form.productName, total, deposit, form.expectedDeliveryDate, form.address, form.remarks])
    if (!createKey.current || createKey.current.fp !== createFp) createKey.current = { key: crypto.randomUUID(), fp: createFp }
    try {
      const created = await createAdvanceOrder({ ...form, totalAmount: total, depositAmount: deposit, referenceNumber: form.reference_number, createdByName: role || 'Staff', products: [{ ...(chosenVariant ? { product_id: Number(chosenVariant.productId), variant_id: chosenVariant.id, variant_name: chosenVariant.variantName } : {}), name: form.productName, category: form.category, description: form.description, quantity: 1, base_price: total, line_total: total, unit: 'piece', unit_type: 'unit', source: 'advance_order' }], branch, idempotencyKey: createKey.current.key })
      createKey.current = null // saved: the next advance order is a new one
      setOrders(current => current.some(o => o.id === created.id) ? current : [created, ...current]); setForm(initialForm); pickProduct(undefined); setCreateOpen(false); setNotice(`${created.deposit_id} created. Deposit is tracked separately and has not been added to revenue.`)

      // Redirect to WhatsApp with advance deposit receipt
      const advanceMsg = buildAdvanceDepositWhatsAppMessage({
        customerName: created.customer_name,
        depositId: created.deposit_id,
        productName: created.product_name,
        totalAmount: created.total_amount,
        depositAmount: created.deposit_amount,
        remainingBalance: created.remaining_balance,
        expectedDeliveryDate: created.expected_delivery_date,
        paymentMethod: form.paymentMethod,
        branch: created.branch,
      })
      window.open(toWhatsAppUrl(created.phone, advanceMsg), '_blank', 'noopener,noreferrer')
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to create advance order') } finally { createLock.current = false; setSaving(false) }
  }

  // Every time the payment window opens it starts clean: a manual adjustment / split typed for another order (or left in
  // the window after closing it) must never carry over into the next bill.
  const openPayment = (order: AdvanceOrder) => {
    setManualDiscount(''); setManualDiscountType('rm'); setAppliedCoupon(null); setCouponInput(''); setCouponError('')
    setPaymentForm({ method: 'cash', remarks: '' }); setSplitP1Amount(''); setError('')
    setPaymentOrder(order)
  }

  const changeStatus = async (order: AdvanceOrder, status: AdvanceStatus) => {
    if (order.status === 'cancelled') {
      setError('A cancelled order cannot be modified.')
      return
    }
    if (order.status === 'completed' || order.invoice_number || order.completed_order_id) {
      setError('This order is already completed and has an official invoice.')
      return
    }
    if (status === 'completed') { openPayment(order); return }
    try { const updated = await updateAdvanceStatus(order.id, status); setOrders(rows => rows.map(row => row.id === order.id ? updated : row)); if (selected?.id === order.id) void openDetails(updated) } catch (err) { setError(err instanceof Error ? err.message : 'Unable to update status') }
  }

  const receivePayment = async (event: FormEvent) => {
    event.preventDefault(); if (!paymentOrder) return; setSaving(true); setError('')
    try {
      // Advance orders use fixed payment amounts - no coupon application allowed
      const manualDiscountNum = Math.max(0, Number(manualDiscount) || 0)
      const manualDisc = manualDiscountType === '%'
        ? Math.round(paymentOrder.remaining_balance * (manualDiscountNum / 100) * 100) / 100
        : manualDiscountNum
      const finalAmount = Math.max(0, paymentOrder.remaining_balance - manualDisc)
      const parts = [paymentForm.remarks]
      if (manualDisc > 0) parts.push(`Manual Adjustment: ${manualDiscountType === '%' ? manualDiscountNum + '%' : '₹' + manualDiscountNum.toFixed(2)} = -INR ${manualDisc.toFixed(2)}`)
      const remarksWithCoupon = parts.filter(Boolean).join(' | ')

      const labelFor = (t: 'cash' | 'upi' | 'card') => t === 'upi' ? 'QR' : t === 'card' ? 'Card' : 'Cash'
      let finalMethodStr: string = paymentForm.method
      if (paymentForm.method === 'split') {
        const p1Amt = Number(splitP1Amount) || 0
        if (!splitP1Amount.trim() || p1Amt <= 0) { setError('Enter Payment 1 amount for split payment'); setSaving(false); return }
        if (p1Amt >= finalAmount) { setError('Payment 1 amount must be less than the remaining balance — select a single payment method instead'); setSaving(false); return }
        if (splitP1Type === splitP2Type) { setError('Payment 1 and Payment 2 must use different methods'); setSaving(false); return }
        const p2Amt = Math.max(0, finalAmount - p1Amt)
        finalMethodStr = `Split (${labelFor(splitP1Type)} ₹${p1Amt} + ${labelFor(splitP2Type)} ₹${p2Amt})`
      }

      const rpcMethod: AdvancePaymentMethod = paymentForm.method === 'split' ? splitP1Type : paymentForm.method
      const result = await completeAdvanceOrder(
        paymentOrder.id,
        rpcMethod,
        finalAmount,
        null, // No coupon codes for advance orders
        0, // No coupon percentage
        manualDisc,
        remarksWithCoupon
      )

      if (paymentForm.method === 'split') {
        try {
          await api('PATCH', `/api/orders/${result.order_id}/finalize`, { body: { payment_mode: finalMethodStr, payment_method: finalMethodStr }, branchId: branch })
          await api('PATCH', `/api/advance-orders/${paymentOrder.id}/final-method`, { body: { final_payment_method: finalMethodStr }, branchId: branch })
        } catch { /* best effort db update */ }
      }

      const completed: AdvanceOrder = { ...paymentOrder, status: 'completed', remaining_balance: finalAmount, completed_at: result.completed_at, completed_order_id: result.order_id, invoice_number: result.invoice_no, final_payment_method: finalMethodStr }
      setOrders(rows => rows.map(row => row.id === completed.id ? completed : row)); onOrderCompleted?.(completed); setPaymentOrder(null); setPaymentForm({ method: 'cash', remarks: '' }); setSplitP1Amount(''); setAppliedCoupon(null); setCouponInput(''); setCouponError(''); setManualDiscount(''); setManualDiscountType('rm'); setNotice(`${result.invoice_no} generated once. The full ${formatCurrency(completed.total_amount)} is now recognized as revenue.`)

      // Redirect to WhatsApp with final invoice URL + Instagram + Feedback form
      whatsappInvoice(completed)
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to complete payment') } finally { setSaving(false) }
  }

  const productRows = (order: AdvanceOrder) => order.products.length ? order.products : [{ name: order.product_name, quantity: 1, base_price: order.total_amount, line_total: order.total_amount, unit: 'piece', unit_type: 'unit' }]
  const invoiceFile = (order: AdvanceOrder) => invoicePdfFile({ invoiceNo: order.invoice_number || order.deposit_id, date: order.completed_at || new Date().toISOString(), customerName: order.customer_name, phone: order.phone, address: order.address, branch: order.branch, items: productRows(order), subtotal: order.total_amount, shipping: 0, total: order.total_amount, paymentMode: order.final_payment_method || 'Paid' })
  const printFinal = (order: AdvanceOrder) => printThermalReceipt({ invoiceNo: order.invoice_number || order.deposit_id, date: order.completed_at || new Date().toISOString(), customerName: order.customer_name, phone: order.phone, branch: order.branch, items: productRows(order).map(item => ({ name: String(item.name || 'Product'), qty: Number(item.quantity || 1), unit: String(item.unit || 'piece'), price: Number(item.base_price || 0), line_total: Number(item.line_total || 0) })), subtotal: order.total_amount, shipping: 0, total: order.total_amount, paymentMode: order.final_payment_method || 'Paid' })
  
  const whatsappDepositReceipt = (order: AdvanceOrder) => {
    const message = buildAdvanceDepositWhatsAppMessage({
      customerName: order.customer_name,
      depositId: order.deposit_id,
      productName: order.product_name,
      totalAmount: order.total_amount,
      depositAmount: order.deposit_amount,
      remainingBalance: order.remaining_balance,
      expectedDeliveryDate: order.expected_delivery_date,
      branch: order.branch,
    })
    window.open(toWhatsAppUrl(order.phone, message), '_blank', 'noopener,noreferrer')
  }

  const whatsappInvoice = (order: AdvanceOrder) => {
    const invNum = order.invoice_number || order.deposit_id
    const message = buildProfessionalWhatsAppMessage({
      customerName: order.customer_name,
      phone: order.phone,
      invoiceNumber: invNum,
      invoiceUrl: publicInvoiceUrl(invNum),
    })
    window.open(toWhatsAppUrl(order.phone, message), '_blank', 'noopener,noreferrer')
  }

  const addEvent = async (order: AdvanceOrder, eventType: string, label: string) => {
    try { await addAdvanceEvent(order.id, eventType, label); await openDetails(order); setNotice(`${label} added to ${order.deposit_id}.`) } catch (err) { setError(err instanceof Error ? err.message : 'Unable to add timeline event') }
  }

  const cards = [
    ['Pending Deposit Amount Received', formatCurrency(analytics.pendingDepositReceived), `${periodOrders.filter(o => o.status === 'pending_deposit').length} bills with pending deposits`, RMIcon, 'text-emerald-700 bg-emerald-50'],
    ['Needed to Receive (Pending)', formatCurrency(analytics.outstanding), `${analytics.pending} Bills with Balance Due`, RMIcon, 'text-amber-700 bg-amber-50'],
    ['Total Advance Orders Value', formatCurrency(analytics.value), `${analytics.total} Total Advance Orders`, FileText, 'text-fuchsia-700 bg-fuchsia-50'],
    ['Ready for Delivery', analytics.ready, 'Ready for customer pickup/delivery', PackageCheck, 'text-blue-700 bg-blue-50'],
    ['Pending Orders', analytics.pending, 'Awaiting balance or confirmation', Clock3, 'text-rose-700 bg-rose-50'],
  ] as const

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-[.18em] text-emerald-600">Separate from sales</p><h2 className="text-2xl font-black text-[#273126]">Advance Orders</h2><p className="mt-1 text-sm text-[#6B7280]">Deposits are tracked separately. Full order value is recognized once final payment is completed.</p></div><div className="flex gap-2"><button onClick={() => setCreateOpen(true)} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-black text-white">+ New Advance Order</button><button onClick={() => void load()} className="rounded-xl border bg-white p-3 text-[#647064]" title="Refresh"><RefreshCw size={18}/></button></div></div>
    {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>}
    {notice && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">{notice}</div>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{cards.map(([label, value, helper, Icon, color]) => <div key={label} className="rounded-2xl border border-[#ECE9E2] bg-white p-4 shadow-sm"><div className="flex items-center justify-between"><p className="text-[10px] font-black uppercase tracking-wide text-[#879086]">{label}</p><div className={`rounded-xl p-2 ${color}`}><Icon size={19}/></div></div><p className="mt-3 text-2xl font-black text-[#273126]">{value}</p><p className="mt-2 border-t pt-2 text-[11px] text-[#647064]">{helper}</p></div>)}</div>
    <div className="rounded-2xl border border-[#ECE9E2] bg-white p-4 shadow-sm"><div className="flex flex-wrap gap-3"><label className="relative min-w-[240px] flex-1"><Search className="absolute left-3 top-3 text-[#9CA3AF]" size={17}/><input className={`${inputClass} pl-10`} value={search} onChange={e => setSearch(e.target.value)} placeholder="Search Deposit ID, customer, phone, product or status"/></label><div className="flex flex-wrap gap-2">{(['all','pending','ready','completed','cancelled'] as StatusFilter[]).map(value => <button key={value} onClick={() => setStatusFilter(value)} className={`rounded-lg px-3 py-2 text-xs font-black capitalize ${statusFilter === value ? 'bg-[#7A1220] text-white' : 'bg-[#F5F3F7] text-[#626B61]'}`}>{value === 'all' ? 'All' : value}</button>)}</div></div><div className="mt-3 border-t pt-3"><p className="mb-2 text-xs font-black text-[#647064]">Filter by Date</p><div className="flex flex-wrap gap-2">{(['today','week','month','year','all'] as const).map(value => <button key={value} onClick={() => {setDateFilter(value);setDateFrom('');setDateTo('')}} className={`rounded-lg px-3 py-2 text-xs font-bold ${dateFilter === value ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-700'}`}>{value === 'all' ? 'All' : value === 'week' ? 'This Week' : value === 'month' ? 'This Month' : value === 'year' ? 'This Year' : 'Today'}</button>)}<button onClick={() => setDateFilter('custom')} className={`rounded-lg px-3 py-2 text-xs font-bold ${dateFilter === 'custom' ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-700'}`}>Custom</button></div><div className="mt-3 grid gap-3 sm:grid-cols-2"><Field label="From Date"><input type="date" className={inputClass} value={dateFrom} onChange={e=>{setDateFrom(e.target.value);setDateFilter('custom')}}/></Field><Field label="To Date"><input type="date" className={inputClass} value={dateTo} onChange={e=>{setDateTo(e.target.value);setDateFilter('custom')}}/></Field></div></div></div>
    <div className="overflow-hidden rounded-2xl border border-[#ECE9E2] bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-[#F8F7F4] text-[10px] font-black uppercase tracking-wider text-[#737B72]">
            <tr>
              {['Deposit ID / Created','Customer','Product','Total / Deposit / Balance','Delivery','Status','Actions'].map(h => (
                <th key={h} className="px-4 py-3.5 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F0EEE9]">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-[#6B7280]">Loading advance orders...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-[#6B7280]">No advance orders match these filters.</td></tr>
            ) : (
              filtered.map(order => (
                <tr key={order.id} className="hover:bg-violet-50/30 transition-colors">
                  <td className="px-4 py-3.5 align-middle whitespace-nowrap">
                    <p className="font-black text-violet-700">{order.deposit_id}</p>
                    <p className="text-[11px] text-[#8B9389]">
                      {new Date(order.created_at).toLocaleDateString('en-IN')} • {new Date(order.created_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}
                    </p>
                  </td>
                  <td className="px-4 py-3.5 align-middle whitespace-nowrap">
                    <p className="font-bold text-[#273126]">{order.customer_name}</p>
                    <p className="text-xs text-[#727970]">{formatPhoneForDisplay(order.phone)}</p>
                  </td>
                  <td className="max-w-[180px] px-4 py-3.5 align-middle">
                    <p className="truncate font-semibold text-[#273126]">{order.product_name}</p>
                    <p className="truncate text-xs text-[#858C83]">{order.category || 'Uncategorised'}</p>
                  </td>
                  <td className="px-4 py-3.5 text-xs align-middle whitespace-nowrap">
                    <p className="text-gray-700">Total: <b>{formatCurrency(order.total_amount)}</b></p>
                    <p className="text-violet-700">Paid: <b>{formatCurrency(order.deposit_amount)}</b></p>
                    <p className="text-red-600 font-bold">Balance: <b>{formatCurrency(order.remaining_balance)}</b></p>
                  </td>
                  <td className="px-4 py-3.5 align-middle whitespace-nowrap">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
                      <CalendarDays size={14} className="text-gray-400 shrink-0" />
                      <span>{formatDateDMY(order.expected_delivery_date)}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3.5 align-middle whitespace-nowrap">
                    <select
                      value={order.status}
                      disabled={order.status === 'completed' || order.status === 'cancelled' || !!order.invoice_number || !!order.completed_order_id}
                      onChange={e => void changeStatus(order, e.target.value as AdvanceStatus)}
                      className={`rounded-xl border px-2.5 py-1.5 text-xs font-black outline-none shadow-xs transition-colors cursor-pointer disabled:opacity-80 disabled:cursor-not-allowed ${STATUS_STYLES[order.status]}`}
                    >
                      <option value="pending_deposit">Pending Deposit</option>
                      <option value="waiting_final_payment">Waiting for Final Payment</option>
                      <option value="completed">Completed (receive payment)</option>
                      <option value="ready_for_delivery">Ready to Collect</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </td>
                  <td className="px-4 py-3.5 align-middle whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      {/* Receive Balance Button (strictly when no invoice exists, not completed, not cancelled, and pending/ready) */}
                      {!order.invoice_number &&
                        !order.completed_order_id &&
                        order.status !== 'completed' &&
                        order.status !== 'cancelled' &&
                        ['pending_deposit', 'waiting_final_payment', 'ready_for_delivery'].includes(order.status) && (
                        <button
                          type="button"
                          onClick={() => openPayment(order)}
                          className="flex items-center gap-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1.5 text-xs font-black shadow-xs transition-all active:scale-95 cursor-pointer whitespace-nowrap"
                          title="Receive Remaining Balance"
                        >
                          <span>Receive Balance</span>
                        </button>
                      )}

                      {/* View Details Icon */}
                      <button
                        type="button"
                        onClick={() => void openDetails(order)}
                        className="w-8 h-8 rounded-lg bg-[#F4F2F6] hover:bg-violet-100 text-violet-700 flex items-center justify-center transition-colors cursor-pointer shrink-0"
                        title="View Details"
                      >
                        <Eye size={15}/>
                      </button>

                      {/* Delete Icon (Admin / Manager only: Staff cannot delete advance orders) */}
                      {can(role, 'advance.delete') && (
                      <button
                        type="button"
                        onClick={() => handleDeleteOrder(order.id, order.customer_name)}
                        className="w-8 h-8 rounded-lg bg-[#F4F2F6] hover:bg-red-100 text-red-600 flex items-center justify-center transition-colors cursor-pointer shrink-0"
                        title="Delete Order"
                      >
                        <Trash2 size={15}/>
                      </button>
                      )}

                      {/* Print Receipt / Invoice */}
                      <button
                        type="button"
                        onClick={() => order.status === 'completed' ? printFinal(order) : printAdvanceReceipt(order)}
                        className="w-8 h-8 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 flex items-center justify-center transition-colors cursor-pointer shrink-0"
                        title={order.status === 'completed' ? "Print Final Receipt" : "Print Advance Receipt"}
                      >
                        <Printer size={15}/>
                      </button>

                      {/* Download PDF Receipt / Invoice */}
                      <button
                        type="button"
                        onClick={() => downloadFile(order.status === 'completed' ? invoiceFile(order) : advanceReceiptPdf(order))}
                        className="w-8 h-8 rounded-lg bg-violet-50 hover:bg-violet-100 text-violet-700 flex items-center justify-center transition-colors cursor-pointer shrink-0"
                        title={order.status === 'completed' ? "Download PDF Invoice" : "Download PDF Receipt"}
                      >
                        <Download size={15}/>
                      </button>

                      {/* WhatsApp Share */}
                      <button
                        type="button"
                        onClick={() => order.status === 'completed' ? whatsappInvoice(order) : whatsappDepositReceipt(order)}
                        className="w-8 h-8 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 flex items-center justify-center transition-colors cursor-pointer shrink-0"
                        title={order.status === 'completed' ? "Share Final Invoice via WhatsApp" : "Share Advance Receipt via WhatsApp"}
                      >
                        <MessageCircle size={15}/>
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>

    {createOpen && createPortal(
      <div className="fixed inset-0 top-0 left-0 right-0 bottom-0 w-screen h-screen h-[100dvh] z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150">
        <form onSubmit={create} className="max-h-[calc(100dvh-2rem)] w-full max-w-4xl overflow-y-auto overscroll-contain rounded-3xl bg-white p-6 shadow-2xl border border-[#E8D399]">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h3 className="text-xl font-black text-[#7A1220]">Create Advance Order</h3>
              <p className="text-xs text-amber-700">Creates an advance receipt only - no revenue or final invoice.</p>
            </div>
            <button type="button" onClick={() => setCreateOpen(false)} className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-700 transition cursor-pointer">
              <X size={18} />
            </button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Customer Name *"><input required className={inputClass} value={form.customerName} onChange={e=>setForm({...form,customerName:e.target.value})}/></Field>
            <Field label="Phone Number *"><input required type="tel" inputMode="tel" autoComplete="tel" className={inputClass} value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})}/></Field>
            <Field label="Address"><textarea className={inputClass} value={form.address} onChange={e=>setForm({...form,address:e.target.value})}/></Field>
            <Field label="Product Name *"><input required list="advance-products" className={inputClass} value={form.productName} onChange={e=>{const product=products.find(p=>p.name===e.target.value);setForm({...form,productName:e.target.value,category:product?.category||form.category});pickProduct(product)}}/><datalist id="advance-products">{products.map(p=><option key={p.id} value={p.name}/>)}</datalist></Field>
            {variantChoices.length > 0 && (
              <Field label="Variant / Size *"><select required className={inputClass} value={variantId} onChange={e=>setVariantId(e.target.value)}><option value="">Select variant</option>{variantChoices.map(v=><option key={v.id} value={v.id}>{v.variantName}{v.sizeLabel && v.sizeLabel!==v.variantName ? ` (${v.sizeLabel})` : ''} - in stock: {v.stock}</option>)}</select></Field>
            )}
            <Field label="Category"><input className={inputClass} value={form.category} onChange={e=>setForm({...form,category:e.target.value})}/></Field>
            <Field label="Description"><textarea className={inputClass} value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></Field>
            <Field label="Total Order Amount *"><input required min="0.01" step="0.01" type="number" className={inputClass} value={form.totalAmount} onChange={e=>setForm({...form,totalAmount:e.target.value})}/></Field>
            <Field label="Deposit Amount Received *"><input required min="0" step="0.01" type="number" className={inputClass} value={form.depositAmount} onChange={e=>setForm({...form,depositAmount:e.target.value})}/></Field>
            <Field label="Remaining Balance (automatic)"><div className="rounded-xl bg-violet-50 px-4 py-3 font-black text-violet-800">{formatCurrency(Math.max(0, Number(form.totalAmount||0)-Number(form.depositAmount||0)))}</div></Field>
            <Field label="Deposit Payment Method"><select className={inputClass} value={form.paymentMethod} onChange={e=>setForm({...form,paymentMethod:e.target.value as AdvancePaymentMethod})}><option value="cash">Cash</option><option value="upi">QR</option><option value="card">Card</option></select></Field>
            <Field label="Expected Delivery Date *"><input required type="date" className={inputClass} value={form.expectedDeliveryDate} onChange={e=>setForm({...form,expectedDeliveryDate:e.target.value})}/></Field>
            <Field label="Order Status"><select disabled className={inputClass} value="pending_deposit"><option value="pending_deposit">Pending Deposit</option></select></Field>
            <div className="md:col-span-2"><Field label="Reference Number"><input className={inputClass} value={form.reference_number} onChange={e=>setForm({...form,reference_number:e.target.value})} placeholder="e.g. PO-001, booking ref (optional)"/></Field></div>
            <div className="md:col-span-2"><Field label="Remarks"><textarea className={inputClass} value={form.remarks} onChange={e=>setForm({...form,remarks:e.target.value})} placeholder="e.g. special instructions, colour, size notes"/></Field></div>
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <button type="button" onClick={()=>setCreateOpen(false)} className="rounded-xl border px-5 py-2.5 font-bold cursor-pointer hover:bg-gray-50 transition">Cancel</button>
            <button disabled={saving} className="rounded-xl bg-[#7e22ce] px-5 py-2.5 font-black text-white shadow-md disabled:opacity-50 cursor-pointer hover:bg-[#6b1cb1] transition">{saving?'Creating...':'Create & Save Advance Receipt'}</button>
          </div>
        </form>
      </div>,
      document.body
    )}

    {paymentOrder && createPortal(
      <div className="fixed inset-0 top-0 left-0 right-0 bottom-0 w-screen h-screen h-[100dvh] z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150">
        <form onSubmit={receivePayment} className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-3xl bg-white p-6 shadow-2xl border border-[#E8D399]">
          <div className="mb-5 flex items-start justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-wider text-emerald-600 font-mono">{paymentOrder.deposit_id}</p>
              <h3 className="text-xl font-black text-[#273126]">Receive Remaining Payment</h3>
            </div>
            <button type="button" onClick={()=>setPaymentOrder(null)} className="w-7 h-7 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-700 transition cursor-pointer">
              <X size={16}/>
            </button>
          </div>
          <div className="mb-6 rounded-2xl bg-emerald-50 py-5 text-center">
            {(() => {
              const couponDisc = appliedCoupon ? Math.round(paymentOrder.remaining_balance * (appliedCoupon.percentage / 100) * 100) / 100 : 0;
              const manualNum = Math.max(0, Number(manualDiscount) || 0);
              const manualDisc = manualDiscountType === '%' ? Math.round(paymentOrder.remaining_balance * (manualNum / 100) * 100) / 100 : manualNum;
              const finalAmt = Math.max(0, paymentOrder.remaining_balance - couponDisc - manualDisc);
              return (
                <>
                  <p className="text-[11px] font-black uppercase tracking-widest text-emerald-600">Remaining Amount</p>
                  <p className={`mt-1 font-black text-emerald-800 ${(couponDisc > 0 || manualDisc > 0) ? 'text-xl line-through opacity-60' : 'text-4xl'}`}>{formatCurrency(paymentOrder.remaining_balance)}</p>
                  {(couponDisc > 0 || manualDisc > 0) && (
                    <>
                      <div className="mt-2 space-y-0.5 text-xs text-emerald-700">
                        {couponDisc > 0 && <p>Coupon {appliedCoupon!.code} ({appliedCoupon!.percentage}%): -{formatCurrency(couponDisc)}</p>}
                        {manualDisc > 0 && <p>Manual Discount: -{formatCurrency(manualDisc)}</p>}
                      </div>
                      <p className="mt-3 text-3xl font-black text-emerald-950">You Pay: {formatCurrency(finalAmt)}</p>
                    </>
                  )}
                </>
              )
            })()}
          </div>
          <div className="space-y-4">
            <Field label="Manual Adjustment (Admin Only)">
              <div className="flex gap-2 items-center">
                <select value={manualDiscountType} onChange={e=>setManualDiscountType(e.target.value as 'rm'|'%')} className="rounded-xl border border-[#E5E7EB] bg-white px-3 py-2.5 text-sm font-black text-[#273126] outline-none focus:border-[#7e22ce] focus:ring-2 focus:ring-violet-100 cursor-pointer">
                  <option value="rm">₹</option>
                  <option value="%">%</option>
                </select>
                <input type="number" min="0" step="0.01" className={`${inputClass} flex-1`} value={manualDiscount} onChange={e=>setManualDiscount(e.target.value)} placeholder="0" />
              </div>
            </Field>
            <Field label="Payment Method">
              <select className={inputClass} value={paymentForm.method} onChange={e=>setPaymentForm({...paymentForm,method:e.target.value as AdvancePaymentMethod | 'split'})}>
                <option value="cash">Cash</option>
                <option value="upi">QR</option>
                <option value="card">Card</option>
                <option value="split">Split (Multiple Methods)</option>
              </select>
            </Field>
            {paymentForm.method === 'split' && (
              <div className="border border-violet-200 rounded-xl p-3 bg-violet-50/50 space-y-3">
                <p className="text-[10px] font-black text-violet-800 uppercase tracking-wider">
                  Split Payment — {splitP1Type === 'cash' ? 'Cash' : splitP1Type === 'upi' ? 'QR' : 'Card'} + {splitP2Type === 'cash' ? 'Cash' : splitP2Type === 'upi' ? 'QR' : 'Card'} (₹)
                </p>
                <div>
                  <span className="block text-[9px] font-black text-gray-500 uppercase tracking-wider mb-1">Payment 1</span>
                  <div className="flex gap-1.5 items-center">
                    <select
                      value={splitP1Type}
                      onChange={e => {
                        const val = e.target.value as 'cash' | 'upi' | 'card'
                        setSplitP1Type(val)
                        if (val === splitP2Type) setSplitP2Type(val === 'cash' ? 'upi' : 'cash')
                      }}
                      className="h-9 px-2 bg-white border border-gray-200 rounded-lg text-xs font-black uppercase outline-none"
                    >
                      <option value="cash">Cash</option>
                      <option value="upi">QR</option>
                      <option value="card">Card</option>
                    </select>
                    <input
                      type="number"
                      step="0.01"
                      value={splitP1Amount}
                      onChange={e => setSplitP1Amount(e.target.value)}
                      placeholder="0.00"
                      className="flex-1 h-9 px-3 bg-white border border-gray-200 rounded-xl text-xs font-black text-right outline-none focus:border-violet-600"
                    />
                  </div>
                </div>
                <div>
                  <span className="block text-[9px] font-black text-gray-500 uppercase tracking-wider mb-1">Payment 2</span>
                  <div className="flex gap-1.5 items-center">
                    <select
                      value={splitP2Type}
                      onChange={e => {
                        const val = e.target.value as 'cash' | 'upi' | 'card'
                        setSplitP2Type(val)
                        if (val === splitP1Type) setSplitP1Type(val === 'cash' ? 'upi' : 'cash')
                      }}
                      className="h-9 px-2 bg-white border border-gray-200 rounded-lg text-xs font-black uppercase outline-none"
                    >
                      <option value="cash">Cash</option>
                      <option value="upi">QR</option>
                      <option value="card">Card</option>
                    </select>
                    <div className="flex-1 h-9 px-3 bg-gray-100 border border-gray-200 rounded-xl text-xs font-black text-gray-700 text-right flex items-center justify-end">
                      {formatCurrency(Math.max(0, (paymentOrder?.remaining_balance || 0) - (Number(splitP1Amount) || 0)))}
                    </div>
                  </div>
                </div>
              </div>
            )}
            <Field label="Payment Notes">
              <textarea className={inputClass} value={paymentForm.remarks} onChange={e=>setPaymentForm({...paymentForm,remarks:e.target.value})} placeholder="Notes about this payment (optional)"/>
            </Field>
            <p className="mt-2 rounded-xl bg-amber-50 p-3 text-[11px] font-semibold text-amber-800">Confirmation marks the order Completed, creates one official invoice, and recognizes the full {formatCurrency(paymentOrder.total_amount)} as revenue.</p>
            <button disabled={saving} className="mt-5 w-full rounded-xl bg-emerald-600 py-3.5 font-black text-white shadow-lg shadow-emerald-600/30 transition-transform active:scale-95 disabled:opacity-50 cursor-pointer hover:bg-emerald-700">
              {saving?'Processing...':'Confirm Final Payment'}
            </button>
          </div>
        </form>
      </div>,
      document.body
    )}

    {selected && createPortal(
      <div className="fixed inset-0 z-[9999] flex h-[100dvh] w-screen justify-end bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
        {/* Backdrop click dismiss */}
        <div className="absolute inset-0" onClick={() => setSelected(null)} />

        {/* Drawer Panel covering full view height */}
        <div className="relative z-10 flex h-[100dvh] min-h-0 w-full max-w-xl flex-col border-l border-[#E8D399] bg-white shadow-2xl animate-in slide-in-from-right duration-200">
          {/* Sticky Drawer Header */}
          <div className="shrink-0 px-6 py-4 border-b border-gray-200 bg-[#7A1220] text-white flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-[#1A1A1A] border border-[#D4AF37] flex items-center justify-center text-[#D4AF37] shrink-0">
                <FileText size={18} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-black text-[#D4AF37] tracking-wider font-mono">{selected.deposit_id}</span>
                  <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded border ${STATUS_STYLES[selected.status]}`}>
                    {STATUS_LABELS[selected.status]}
                  </span>
                </div>
                <h3 className="text-base font-black text-white tracking-wide">Order Details</h3>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors cursor-pointer shrink-0"
              title="Close (Esc)"
            >
              <X size={16} />
            </button>
          </div>

          {/* Scrollable Drawer Body */}
          <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-y-contain p-6 space-y-6">
            <div className="grid grid-cols-2 gap-3">
              {[
                ['Customer', selected.customer_name],
                ['Phone', formatPhoneForDisplay(selected.phone)],
                ['Address', selected.address || '-'],
                ['Product', selected.product_name],
                ['Category', selected.category || '-'],
                ['Total', formatCurrency(selected.total_amount)],
                ['Deposit Paid', formatCurrency(selected.deposit_amount)],
                ['Remaining Balance', formatCurrency(selected.remaining_balance)],
                ['Delivery Date', formatDateDMY(selected.expected_delivery_date)],
                ['Created Date', new Date(selected.created_at).toLocaleDateString('en-IN')],
                ['Created Time', new Date(selected.created_at).toLocaleTimeString('en-IN')],
                ['Created By', selected.created_by_name || '-'],
                ['Current Status', STATUS_LABELS[selected.status]],
                ['Invoice Number', selected.invoice_number || 'Not generated'],
                ['Reference No', selected.reference_number || '—'],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl bg-[#F8F7F4] p-3 border border-gray-100">
                  <p className="text-[10px] font-black uppercase text-[#858C83]">{k}</p>
                  <p className="mt-1 break-words text-sm font-bold text-[#273126]">{v}</p>
                </div>
              ))}
            </div>

            {selected.remarks && (
              <div className="rounded-xl border border-violet-200 bg-violet-50 p-3.5">
                <p className="text-[10px] font-black uppercase text-violet-600">Remarks</p>
                <p className="mt-1 text-sm text-[#273126] font-medium">{selected.remarks}</p>
              </div>
            )}

            {selected.description && (
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-3.5">
                <p className="text-[10px] font-black uppercase text-[#858C83]">Description</p>
                <p className="mt-1 text-sm text-gray-800">{selected.description}</p>
              </div>
            )}

            <div>
              <h4 className="text-sm font-black text-gray-900">Quick Timeline Updates</h4>
              <div className="mt-2 flex flex-wrap gap-2">
                {[
                  ['order_confirmed', 'Order Confirmed'],
                  ['order_packed', 'Order Packed'],
                  ['ready_for_delivery', 'Ready for Delivery'],
                  ['customer_contacted', 'Customer Contacted'],
                  ['delivered', 'Delivered'],
                ].map(([type, label]) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => void addEvent(selected, type, label)}
                    className="rounded-lg border border-violet-200 bg-violet-50 hover:bg-violet-100 px-3 py-2 text-xs font-black text-violet-700 transition cursor-pointer"
                  >
                    + {label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <h4 className="text-sm font-black text-gray-900">Payment History</h4>
              <div className="mt-2 space-y-2">
                {payments.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">No payments recorded yet.</p>
                ) : (
                  payments.map((payment) => (
                    <div key={payment.id} className="flex justify-between items-center rounded-xl bg-emerald-50 border border-emerald-100 p-3 text-sm">
                      <span className="font-bold capitalize text-emerald-900">{payment.payment_type} — {payment.payment_method}</span>
                      <span className="font-black text-emerald-800">{formatCurrency(Number(payment.amount))}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div>
              <h4 className="text-sm font-black text-gray-900">Order Timeline</h4>
              <div className="mt-3 border-l-2 border-violet-200 pl-4 space-y-4">
                {timeline.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">No timeline events recorded.</p>
                ) : (
                  timeline.map((event) => (
                    <div key={event.id} className="relative pb-2 before:absolute before:-left-[21px] before:top-1.5 before:h-2.5 before:w-2.5 before:rounded-full before:bg-violet-600">
                      <p className="text-sm font-black text-gray-900">{event.label}</p>
                      <p className="text-xs text-[#81887F]">{new Date(event.created_at).toLocaleString('en-IN')}</p>
                      {event.remarks && <p className="mt-1 text-xs text-gray-600 bg-white/70 p-2 rounded-lg border border-gray-100">{event.remarks}</p>}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Sticky Drawer Footer */}
          <div className="shrink-0 px-6 py-4 border-t border-gray-200 bg-[#FBFAF6] flex items-center justify-between gap-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => downloadFile(selected.status === 'completed' ? invoiceFile(selected) : advanceReceiptPdf(selected))}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 bg-white text-xs font-bold text-gray-700 hover:bg-gray-100 cursor-pointer transition shadow-xs"
                title={selected.status === 'completed' ? 'Download PDF Invoice' : 'Download PDF Receipt'}
              >
                <Download size={14} /> PDF
              </button>
              <button
                type="button"
                onClick={() => selected.status === 'completed' ? whatsappInvoice(selected) : whatsappDepositReceipt(selected)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-bold hover:bg-emerald-100 cursor-pointer transition shadow-xs"
                title="Share via WhatsApp"
              >
                <MessageCircle size={14} /> WhatsApp
              </button>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="px-5 py-2 rounded-xl bg-[#7A1220] text-white text-xs font-black hover:bg-gray-800 cursor-pointer transition"
            >
              Close
            </button>
          </div>
        </div>
      </div>,
      document.body
    )}
  </div>
}
