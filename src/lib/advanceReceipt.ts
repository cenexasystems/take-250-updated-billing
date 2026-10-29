import { jsPDF } from 'jspdf'
import { BRAND_EN, THEME_PALETTE } from './brand'
import { printLogoFor, thermalLogoFor } from './branchLogo'
import { formatCurrency } from './retail'
import { formatDateDMY } from './formatDate'
import type { AdvanceOrder } from '../services/advanceOrderService'
import { getBranchProfile } from './branchProfile'
import { formatPhoneForDisplay } from './phone'
import { hasCartBreakdown, invoiceDocFromAdvance, type InvoiceRow, type StoredAdvance } from './invoiceDoc'

const esc = (value: string) => value.replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char] || char))

// jsPDF's built-in Helvetica font does not include the ₹ Unicode glyph (U+20B9).
// Using the Intl formatter directly causes the ₹ character to render as "1" or a
// replacement box in PDF viewers. This PDF-safe formatter outputs "Rs." instead.
const pdfMoney = (value: number | string): string => {
  const formatted = typeof value === 'string' ? value : formatCurrency(value) // a discount line comes as "-₹20.00"
  if (formatted.startsWith('-')) return `-${formatted.slice(1).replace(/^[₹\u20b9]\s*/, 'Rs. ')}`
  // Replace leading ₹ (with optional non-breaking space) with "Rs. "
  return formatted.replace(/^[₹\u20b9]\s*/, 'Rs. ')
}

/**
 * The money lines of an advance receipt, from the shared invoice builder (src/lib/invoiceDoc.ts) and the STORED order:
 * an order made from the POS cart lists Subtotal, discounts, taxable amount, CGST / SGST, delivery, then the total,
 * the deposit (date, mode) and the balance due. An older order (no stored breakdown) keeps Total / Deposit / Balance.
 */
export function advanceReceiptLines(order: AdvanceOrder): Array<{ label: string; value: string; kind: InvoiceRow['kind'] | 'total' | 'deposit' | 'balance' }> {
  const doc = invoiceDocFromAdvance(order as unknown as StoredAdvance)
  const deposit = doc.advance?.deposits[0]
  const head = hasCartBreakdown(order as unknown as StoredAdvance)
    ? doc.rows.map((r) => ({ label: r.label, value: `${r.kind === 'discount' ? '-' : ''}${formatCurrency(r.amount)}`, kind: r.kind }))
    : []
  return [
    ...head,
    { label: head.length ? 'TOTAL' : 'Total order amount', value: formatCurrency(doc.total), kind: 'total' as const },
    { label: head.length && deposit ? deposit.label : 'Deposit paid', value: formatCurrency(Number(order.deposit_amount)), kind: 'deposit' as const },
    { label: head.length ? 'Balance due' : 'Remaining balance', value: formatCurrency(doc.advance?.balance?.amount ?? Number(order.remaining_balance)), kind: 'balance' as const },
  ]
}

export function advanceReceiptPdf(order: AdvanceOrder) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  doc.setFillColor(THEME_PALETTE.primary); doc.rect(0, 0, 210, 5, 'F')
  try { doc.addImage(printLogoFor(order.branch), 'PNG', 16, 9, 16, 16) } catch (_err) { /* ignore missing logo */ }
  doc.setTextColor('#111111'); doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text(BRAND_EN.toUpperCase(), 38, 20)
  doc.setTextColor('#6b7280'); doc.setFontSize(8); doc.text('ADVANCE RECEIPT - NOT A TAX INVOICE', 38, 26)

  doc.setFont('helvetica', 'normal'); doc.text(getBranchProfile(order.branch).address, 194, 20, { align: 'right', maxWidth: 76 }); doc.text(getBranchProfile(order.branch).phone, 194, 30, { align: 'right' })
  doc.setDrawColor('#D4AF37'); doc.line(16, 38, 194, 38)
  doc.setTextColor('#111827'); doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text(order.deposit_id, 16, 51)
  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor('#6b7280'); doc.text(`Created: ${new Date(order.created_at).toLocaleString('en-IN')}`, 194, 51, { align: 'right' })
  const rows = [
    ['Customer', order.customer_name], ['Phone', formatPhoneForDisplay(order.phone)], ['Address', order.address || '-'], ['Product', order.product_name],
    ['Category', order.category || '-'], ['Expected delivery', formatDateDMY(order.expected_delivery_date)],
    ...(order.reference_number ? [['Reference No', order.reference_number]] : []),
    ...(order.remarks ? [['Remarks', order.remarks]] : []),
  ]
  let y = 66
  rows.forEach(([label, value]) => { doc.setFont('helvetica', 'bold'); doc.setTextColor('#6b7280'); doc.text(label.toUpperCase(), 16, y); doc.setFont('helvetica', 'normal'); doc.setTextColor('#111827'); doc.text(String(value), 64, y, { maxWidth: 126 }); y += 10 })
  // money lines: the shared breakdown (an older order: Total / Deposit / Balance, exactly as before)
  const lines = advanceReceiptLines(order)
  const step = lines.length > 3 ? 8 : 11
  const boxH = lines.length > 3 ? 8 + lines.length * step : 42
  y += 4; doc.setFillColor('#FBFAF6'); doc.roundedRect(16, y, 178, boxH, 3, 3, 'F')
  lines.forEach((line, index) => {
    const rowY = y + (lines.length > 3 ? 9 : 11) + index * step
    const strong = line.kind === 'balance' || line.kind === 'total'
    doc.setFont('helvetica', strong ? 'bold' : 'normal')
    doc.setFontSize(line.kind === 'tax' ? 8 : 9)
    doc.setTextColor(line.kind === 'balance' || line.kind === 'discount' ? THEME_PALETTE.accentDark : '#374151')
    doc.text(line.label, 22, rowY)
    doc.text(pdfMoney(line.value), 188, rowY, { align: 'right' })
  })
  doc.setFontSize(9)
  doc.setFont('helvetica', 'bold'); doc.setTextColor('#b45309'); doc.setFontSize(9); doc.text('This receipt records an advance payment only. It is not a final invoice.', 105, y + boxH + 13, { align: 'center' })
  return new File([doc.output('blob')], `Advance-Receipt-${order.deposit_id}.pdf`, { type: 'application/pdf' })
}

/** thermal money lines: the shared breakdown, or (older order) Total Amount / Deposit Paid / Balance Due as before */
function thermalMoney(order: AdvanceOrder): string {
  const lines = advanceReceiptLines(order)
  if (lines.length === 3) {
    return `<div class="r"><span>Total Amount</span><span class="bold">${esc(formatCurrency(order.total_amount))}</span></div>
<div class="r"><span>Deposit Paid</span><span class="bold">${esc(formatCurrency(order.deposit_amount))}</span></div>
<div class="r balance-row"><span>Balance Due</span><span>${esc(formatCurrency(order.remaining_balance))}</span></div>`
  }
  return lines.map((l) => l.kind === 'balance'
    ? `<div class="r balance-row"><span>${esc(l.label)}</span><span>${esc(l.value)}</span></div>`
    : l.kind === 'total'
      ? `<div class="line"></div><div class="r"><span class="bold">${esc(l.label)}</span><span class="bold">${esc(l.value)}</span></div>`
      : `<div class="r"${l.kind === 'tax' ? ' style="font-size:11px;"' : ''}><span>${esc(l.label)}</span><span${l.kind === 'deposit' ? ' class="bold"' : ''}>${esc(l.value)}</span></div>`).join('\n')
}

export function printAdvanceReceipt(order: AdvanceOrder) {
  try {
    const frame = document.createElement('iframe')
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0;visibility:hidden;'
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('tabindex', '-1')
    frame.setAttribute('data-gramm', 'false')
    frame.setAttribute('data-gramm_editor', 'false')
    frame.setAttribute('data-enable-grammarly', 'false')
    frame.setAttribute('spellcheck', 'false')
    document.body.appendChild(frame)

    const doc = frame.contentWindow?.document
    if (!doc) {
      if (frame.parentNode) frame.parentNode.removeChild(frame)
      return
    }

    // the DEPOSIT's own mode (it used to show the final payment's mode)
    const depositMethod = String((order as unknown as { deposit_method?: string }).deposit_method || order.final_payment_method || '')
    const depositPayment = depositMethod ? (depositMethod === 'upi' ? 'UPI / QR' : depositMethod.toUpperCase()) : 'Cash'

    const html = `<!doctype html><html lang="en" data-gramm="false" data-gramm_editor="false" data-enable-grammarly="false" spellcheck="false"><head><title>Advance Receipt ${esc(order.deposit_id)}</title>
<meta charset="utf-8">
<meta name="grammarly" content="off">
<meta name="robots" content="noindex,nofollow">
<style>
  @page { size: 80mm auto; margin: 0; }
  @media print { @page { size: 80mm auto; margin: 0; } }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Arial, sans-serif;
    font-size: 12px;
    width: 72mm;
    padding: 4mm;
    color: #111;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .c { text-align: center; }
  .r { display: flex; justify-content: space-between; gap: 4px; margin: 5px 0; word-break: break-word; }
  .r span:first-child { flex-shrink: 0; max-width: 55%; }
  .r span:last-child { text-align: right; flex: 1; }
  .line { border-top: 1px dashed #555; margin: 8px 0; }
  .big { font-size: 15px; font-weight: bold; }
  .bold { font-weight: bold; }
  .warn { font-size: 9px; font-weight: bold; margin-top: 10px; text-align: center; }
  .label { font-size: 10px; color: #555; }
  .balance-row { font-size: 14px; font-weight: bold; }
</style>
</head><body>
<div class="c" style="margin-bottom: 6px;">
  <img src="${thermalLogoFor(order.branch)}" style="width: 50px; height: 50px; object-fit: contain; margin: 0 auto; display: block;" alt="Logo" />
</div>
<div class="c big">${esc(BRAND_EN)}</div>
<div class="c" style="font-size:10px;color:#555;">${esc(getBranchProfile(order.branch).address)}</div>
<div class="c" style="font-size:10px;color:#555;">${esc(getBranchProfile(order.branch).phone)}</div>
<div class="line"></div>
<div class="c big">ADVANCE RECEIPT</div>
<div class="c" style="font-size:10px;">Not a final tax invoice</div>
<div class="line"></div>
<div><span class="bold">${esc(order.deposit_id)}</span></div>
<div style="font-size:10px;color:#555;">${new Date(order.created_at).toLocaleString('en-IN')}</div>
<div class="line"></div>
<div class="r"><span class="label">Customer</span><span class="bold">${esc(order.customer_name)}</span></div>
<div class="r"><span class="label">Phone</span><span>${esc(formatPhoneForDisplay(order.phone))}</span></div>
${order.address ? `<div class="r"><span class="label">Address</span><span>${esc(order.address)}</span></div>` : ''}
<div class="r"><span class="label">Product</span><span>${esc(order.product_name)}</span></div>
${order.category ? `<div class="r"><span class="label">Category</span><span>${esc(order.category)}</span></div>` : ''}
<div class="r"><span class="label">Delivery</span><span>${esc(formatDateDMY(order.expected_delivery_date))}</span></div>
<div class="r"><span class="label">Payment</span><span>${esc(depositPayment)}</span></div>
${order.reference_number ? `<div class="r"><span class="label">Ref No</span><span>${esc(order.reference_number)}</span></div>` : ''}
${order.remarks ? `<div class="r"><span class="label">Remarks</span><span>${esc(order.remarks)}</span></div>` : ''}
<div class="line"></div>
${thermalMoney(order)}
<div class="line"></div>
<div class="warn">ADVANCE PAYMENT ONLY &mdash; NOT A FINAL INVOICE</div>
</body></html>`

    doc.open()
    doc.write(html)
    doc.close()

    const cleanup = () => {
      try {
        if (frame.parentNode) {
          frame.parentNode.removeChild(frame)
        }
      } catch {}
    }

    setTimeout(() => {
      try {
        if (frame.contentWindow) {
          frame.contentWindow.onbeforeunload = null
          frame.contentWindow.onunload = null
          frame.contentWindow.onafterprint = cleanup
          frame.contentWindow.focus()
          frame.contentWindow.print()
        }
      } catch (err) {
        console.warn('[advanceReceipt] Print error:', err)
      } finally {
        setTimeout(cleanup, 2000)
      }
    }, 300)
  } catch (err) {
    console.warn('[advanceReceipt] Failed to print advance receipt:', err)
  }
}

export function downloadFile(file: File) { const url = URL.createObjectURL(file); const link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 500) }
