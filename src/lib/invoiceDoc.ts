import { formatCurrency, formatInvoiceNo, formatPaymentMode, formatQuantityValue, normalizeStructuredOrderItem, paymentParts, roundTo, splitGst, type StructuredOrderItem } from './retail'
/** a branch id (pos1, pos2, ...); kept as a plain string so this module also runs in the API tests (no browser store) */
type PosBranch = string

/**
 * ONE data shape for every invoice output (screen, A4 PDF, 80 mm thermal, digital page, advance final bill), built from
 * the STORED bill (orders row + its lines) and, when present, its returns and its advance-order payments. The renderers
 * only draw what is in here, so the breakdown cannot drift apart between outputs. Nothing is re-calculated differently
 * from billing: every amount is read from the bill; the only derived values are display helpers (the GST rate label and
 * "net amount" = total - returned).
 */

/** The bill as stored (orders row). Optional fields fall back to 0 / empty. */
export type StoredBill = {
  invoice_no: string
  created_at: string
  customer_name?: string | null
  phone?: string | null
  address?: string | null
  branch?: PosBranch | string | null
  branch_id?: string | null
  status?: string | null
  subtotal: number | string
  discount_amount?: number | string | null
  coupon_code?: string | null
  coupon_percentage?: number | string | null
  manual_discount_amount?: number | string | null
  manual_discount_type?: string | null
  manual_discount_value?: number | string | null
  total_gst?: number | string | null
  gst_amount?: number | string | null
  taxable_amount?: number | string | null
  cgst_amount?: number | string | null
  sgst_amount?: number | string | null
  delivery_charge?: number | string | null
  shipping?: number | string | null
  total: number | string
  payment_mode?: string | null
  payment_method?: string | null
  split_details?: unknown
  returned_amount?: number | string | null
}

/** Returns and advance payments of a bill, as the API sends them (GET /api/orders/:id, public invoice). */
export type InvoiceExtras = {
  returns?: {
    items: Array<{ order_item_id: number; returned: number; damaged: number }>
    records: Array<{ return_no: string; created_at: string }>
  } | null
  advance?: {
    /** the advance order this bill completed (DEP-...) */
    deposit_id?: string
    deposits: Array<{ amount: number; method: string; received_at: string }>
    balance: { amount: number; method: string; received_at?: string } | null
  } | null
}

export type InvoiceLine = StructuredOrderItem & { order_item_id?: number; returnNote?: string }
export type InvoiceRow = { kind: 'subtotal' | 'discount' | 'taxable' | 'tax' | 'delivery'; label: string; amount: number }
export type InvoiceDoc = {
  invoiceNo: string
  date: string
  branch?: PosBranch
  customerName: string
  phone: string
  address: string
  status: string
  items: InvoiceLine[]
  /** Subtotal first, then only the non-zero rows; TOTAL is `total` */
  rows: InvoiceRow[]
  total: number
  /** single: label "Cash" (parts empty), drawn as today; split: "Payment (Split)" + one part per mode */
  payment: { split: boolean; label: string; parts: Array<{ label: string; amount: number }> }
  /** advance-order bill: deposits (date, mode) and the balance paid at completion */
  advance: { reference?: string; deposits: Array<{ label: string; amount: number }>; balance: { label: string; amount: number; parts: Array<{ label: string; amount: number }> } | null } | null
  /** partially / fully returned bill */
  returns: { badge: string; returned: number; net: number; records: string[] } | null
}

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
const pct = (v: number) => `${roundTo(v, 2)}%`
const day = (iso: string) => { try { return new Date(iso).toLocaleDateString('en-IN') } catch { return '' } }
const modeLabel = (m: string) => formatPaymentMode(m) || m

/** "Split (Cash ₹500 + QR ₹597.6)" / "Cash ₹100.00 + QR ₹900.00" written by older screens -> parts */
function partsFromText(text: string): Array<{ label: string; amount: number }> {
  const out: Array<{ label: string; amount: number }> = []
  for (const m of text.matchAll(/(cash|qr|upi|card)\s*(?:₹|rs\.?)?\s*([\d,]+(?:\.\d+)?)/gi)) out.push({ label: modeLabel(m[1]), amount: n(m[2].replace(/,/g, '')) })
  return out.length > 1 ? out : []
}

function paymentOf(bill: StoredBill) {
  const split = paymentParts(bill.split_details)
  if (split.length > 1) return { split: true, label: 'Split', parts: split.map((p) => ({ label: modeLabel(p.method), amount: p.amount })) }
  const raw = String(bill.payment_mode || bill.payment_method || '').trim()
  const fromText = partsFromText(raw)
  if (fromText.length) return { split: true, label: 'Split', parts: fromText }
  return { split: false, label: formatPaymentMode(raw) || 'Cash', parts: [] }
}

/** GST rate label, only when the stored GST is exactly that rate of the taxable amount (GST may also be a flat amount). */
function gstRate(gst: number, taxable: number): number | null {
  if (gst <= 0 || taxable <= 0) return null
  const rate = Math.round((gst / taxable) * 100 * 4) / 4 // nearest 0.25 %
  return rate > 0 && Math.abs(roundTo(taxable * rate / 100) - gst) <= 0.01 ? rate : null
}

/** "Deposit paid (11/10/2026, Cash)": the same words on the advance receipt and on the final invoice */
const depositLabel = (at: string | null | undefined, method: string | null | undefined) =>
  `Deposit paid (${[at ? day(at) : '', method ? modeLabel(method) : ''].filter(Boolean).join(', ')})`.replace(' ()', '')

/** The advance order as stored (advance_orders row, 0013 cart_* breakdown) + its deposit payment. */
export type StoredAdvance = {
  deposit_id: string
  created_at: string
  customer_name?: string | null
  phone?: string | null
  address?: string | null
  branch?: string | null
  branch_id?: string | null
  status?: string | null
  product_name?: string | null
  products?: Array<Record<string, unknown>> | null
  total_amount: number | string
  deposit_amount: number | string
  remaining_balance?: number | string | null
  cart_subtotal?: number | string | null
  cart_coupon_code?: string | null
  cart_coupon_percentage?: number | string | null
  cart_coupon_discount?: number | string | null
  cart_manual_discount?: number | string | null
  cart_manual_discount_type?: string | null
  cart_manual_discount_value?: number | string | null
  cart_total_gst?: number | string | null
  cart_delivery_charge?: number | string | null
  /** the deposit payment's mode and time (advance_order_payments, payment_type 'deposit') */
  deposit_method?: string | null
  deposit_at?: string | null
}

/** true for an order made from the POS cart after 0013 (it carries its own breakdown); older orders only have a total */
export const hasCartBreakdown = (a: StoredAdvance) => n(a.cart_subtotal) > 0

/**
 * The advance receipt (at creation / deposit), from the SAME builder as every invoice: the stored cart breakdown as rows,
 * TOTAL = the order total, then the deposit (date, mode) and the balance due. An older order (no breakdown) has
 * Subtotal = TOTAL; the receipt then keeps its old Total / Deposit / Balance layout (see hasCartBreakdown).
 */
export function invoiceDocFromAdvance(a: StoredAdvance): InvoiceDoc {
  const cart = hasCartBreakdown(a)
  const items = Array.isArray(a.products) && a.products.length
    ? a.products
    : [{ name: a.product_name || 'Advance order item', quantity: 1, unit: 'piece', unit_type: 'unit', base_price: n(a.total_amount), line_total: n(a.total_amount) }]
  const doc = invoiceDocFromBill({
    invoice_no: a.deposit_id, created_at: a.created_at, customer_name: a.customer_name, phone: a.phone, address: a.address,
    branch: a.branch || a.branch_id, status: a.status || 'pending_deposit',
    subtotal: cart ? n(a.cart_subtotal) : n(a.total_amount),
    discount_amount: n(a.cart_coupon_discount), coupon_code: a.cart_coupon_code ?? null, coupon_percentage: n(a.cart_coupon_percentage),
    manual_discount_amount: n(a.cart_manual_discount), manual_discount_type: a.cart_manual_discount_type ?? 'flat', manual_discount_value: n(a.cart_manual_discount_value),
    total_gst: n(a.cart_total_gst), delivery_charge: n(a.cart_delivery_charge), total: n(a.total_amount),
    payment_mode: a.deposit_method ?? null,
  }, items)
  const remaining = a.remaining_balance === null || a.remaining_balance === undefined ? roundTo(n(a.total_amount) - n(a.deposit_amount)) : n(a.remaining_balance)
  doc.advance = {
    reference: a.deposit_id,
    deposits: [{ label: depositLabel(a.deposit_at || a.created_at, a.deposit_method), amount: n(a.deposit_amount) }],
    balance: { label: 'Balance due', amount: remaining, parts: [] },
  }
  return doc
}

export function invoiceDocFromBill(bill: StoredBill, rawItems: Array<Record<string, unknown>>, extras: InvoiceExtras = {}): InvoiceDoc {
  const subtotal = n(bill.subtotal)
  const coupon = n(bill.discount_amount)
  const manual = n(bill.manual_discount_amount)
  const gst = n(bill.total_gst) || n(bill.gst_amount)
  const delivery = n(bill.delivery_charge) > 0 ? n(bill.delivery_charge) : n(bill.shipping) // the server's total formula
  const total = n(bill.total)

  const rows: InvoiceRow[] = [{ kind: 'subtotal', label: 'Subtotal', amount: subtotal }]
  if (coupon > 0) {
    const cp = n(bill.coupon_percentage)
    const code = String(bill.coupon_code || '').trim()
    rows.push({ kind: 'discount', label: `Discount (${[code ? `Coupon ${code}` : 'Coupon', cp > 0 ? pct(cp) : ''].filter(Boolean).join(', ')})`, amount: coupon })
  }
  if (manual > 0) {
    const type = String(bill.manual_discount_type || '').toLowerCase()
    const v = n(bill.manual_discount_value)
    rows.push({ kind: 'discount', label: `Discount (Manual${type.startsWith('percent') && v > 0 ? `, ${pct(v)}` : ''})`, amount: manual })
  }
  if (gst > 0) {
    const taxable = n(bill.taxable_amount) > 0 ? n(bill.taxable_amount) : Math.max(0, roundTo(subtotal - coupon - manual))
    const { cgst, sgst } = n(bill.cgst_amount) + n(bill.sgst_amount) > 0 ? { cgst: n(bill.cgst_amount), sgst: n(bill.sgst_amount) } : splitGst(gst)
    const rate = gstRate(gst, taxable)
    rows.push({ kind: 'taxable', label: 'Taxable amount', amount: taxable })
    rows.push({ kind: 'tax', label: `CGST${rate ? ` @ ${pct(rate / 2)}` : ''}`, amount: cgst })
    rows.push({ kind: 'tax', label: `SGST${rate ? ` @ ${pct(rate / 2)}` : ''}`, amount: sgst })
  }
  if (delivery > 0) rows.push({ kind: 'delivery', label: 'Delivery', amount: delivery })

  // lines, with "Returned 1 of 3" under a returned one
  const back = new Map((extras.returns?.items ?? []).map((r) => [Number(r.order_item_id), r]))
  const items: InvoiceLine[] = rawItems.map((raw) => {
    const line: InvoiceLine = { ...normalizeStructuredOrderItem(raw) }
    const id = Number(raw.order_item_id ?? raw.id)
    if (back.size && Number.isFinite(id)) {
      line.order_item_id = id
      const r = back.get(id)
      if (r && n(r.returned) > 0) line.returnNote = `Returned ${formatQuantityValue(n(r.returned))} of ${formatQuantityValue(line.quantity)}${n(r.damaged) > 0 ? ' (damaged)' : ''}`
    }
    return line
  })

  const status = String(bill.status || 'completed')
  let returns: InvoiceDoc['returns'] = null
  const returned = n(bill.returned_amount)
  if ((status === 'partially_returned' || status === 'returned') && extras.returns && extras.returns.records.length) {
    const units = items.reduce((s, l) => s + n(l.quantity), 0)
    const backUnits = extras.returns.items.reduce((s, r) => s + n(r.returned), 0)
    returns = {
      badge: status === 'returned' ? 'RETURNED' : `PARTIALLY RETURNED: ${formatQuantityValue(backUnits)} of ${formatQuantityValue(units)} items`,
      returned,
      net: roundTo(Math.max(0, total - returned)),
      records: extras.returns.records.map((r) => `${r.return_no}, ${day(r.created_at)}`),
    }
  }

  const payment = paymentOf(bill)
  let advance: InvoiceDoc['advance'] = null
  if (extras.advance) {
    const bal = extras.advance.balance
    advance = {
      reference: extras.advance.deposit_id,
      deposits: extras.advance.deposits.map((d) => ({ label: depositLabel(d.received_at, d.method), amount: n(d.amount) })),
      balance: bal ? {
        label: `Balance paid at completion (${payment.parts.length ? 'Split' : modeLabel(bal.method)})`,
        amount: n(bal.amount),
        parts: payment.parts,
      } : null,
    }
  }

  return {
    invoiceNo: String(bill.invoice_no || ''),
    date: bill.created_at,
    branch: (bill.branch || bill.branch_id || undefined) as PosBranch | undefined,
    customerName: String(bill.customer_name || '').trim() || 'Walk-in Customer',
    phone: String(bill.phone || ''),
    address: String(bill.address || ''),
    status,
    items,
    rows,
    total,
    payment,
    advance,
    returns,
  }
}

/** Plain-text money for the PDF (Helvetica has no ₹ glyph). */
export const pdfMoney = (value: number): string => formatCurrency(Number(value || 0)).replace(/\s+/g, ' ').replace(/^[₹₹]\s*/, 'Rs. ')
export const invoiceFileName = (doc: InvoiceDoc) => `Invoice-${formatInvoiceNo(doc.invoiceNo)}.pdf`
