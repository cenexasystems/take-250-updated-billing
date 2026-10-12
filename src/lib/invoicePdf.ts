import { jsPDF } from 'jspdf'
import html2canvas from 'html2canvas'
import { BRAND_EN, THEME_PALETTE } from './brand'
import { formatCurrency, formatQuantityValue, normalizeUnitLabel, formatInvoiceNo } from './retail'
import type { InvoiceDoc } from './invoiceDoc'
import { printLogoFor } from './branchLogo'
import type { PosBranch } from '../store/store'
import { getBranchProfile } from './branchProfile'
import { formatPhoneForDisplay } from './phone'

/** The PDF draws the shared invoice data (src/lib/invoiceDoc.ts), like the screen and the thermal receipt. */
export type InvoicePdfData = InvoiceDoc

// jsPDF's built-in Helvetica font does not include the ₹ Unicode glyph (U+20B9).
// In ISO-8859-1 (WinAnsiEncoding), \u20B9 maps to character code 185 (0xB9), which renders
// as the superscript 1 (¹) glyph. Replacing with "Rs. " ensures clean and proper PDF formatting.
const money = (value: number): string => {
  const formatted = formatCurrency(Number(value || 0)).replace(/\s+/g, ' ')
  return formatted.replace(/^[₹\u20b9]\s*/, 'Rs. ')
}

/** Creates a compact A4 invoice that can be attached as a file to WhatsApp. */
export function createInvoicePdf(data: InvoicePdfData): Blob {
  const formattedNo = formatInvoiceNo(data.invoiceNo)
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageWidth = 210
  const left = 16
  const right = 194
  const primaryColor = THEME_PALETTE.accentDark // gold dark enough for text on white
  const ink = '#18202a'
  const muted = '#68717c'
  let y = 16

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(THEME_PALETTE.primary)
  doc.text('TAX INVOICE', left, y)
  doc.text(`Invoice: #${formattedNo}`, right, y, { align: 'right' })
  y += 7
  doc.setDrawColor('#D4AF37')
  doc.setLineWidth(0.5)
  doc.line(left, y, right, y)
  y += 10

  // header block: a 26 mm logo, the shop name / address / phone beside it. The block's height follows the address
  // (it can wrap to several lines) so the phone never runs into the BILL TO box below.
  const profile = getBranchProfile(data.branch)
  const logoSize = 26
  const textX = left + logoSize + 6
  const addressLines = doc.splitTextToSize(profile.address, 80) as string[]
  const shopPhoneY = y + 14 + addressLines.length * 3.6 + 1.5
  try {
    doc.addImage(printLogoFor(data.branch), 'PNG', left, y - 3, logoSize, logoSize)
  } catch {
    doc.setTextColor(primaryColor)
    doc.setFontSize(16)
    doc.text(BRAND_EN, left, y + 10)
  }
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(THEME_PALETTE.primary)
  doc.text(BRAND_EN, textX, y + 7)
  doc.setFontSize(8)
  doc.setTextColor('#555')
  doc.setFont('helvetica', 'normal')
  doc.text(addressLines, textX, y + 14)
  doc.text(`Phone: ${profile.phone}`, textX, shopPhoneY)
  doc.setTextColor(THEME_PALETTE.primary)
  doc.setFont('helvetica', 'bold')
  doc.text(`Date: ${new Date(data.date).toLocaleDateString('en-IN')}`, right - 2, y + 2, { align: 'right' })
  let payY = y + 8
  if (!data.payment.split) {
    doc.text(`Payment: ${data.payment.label}`.replace(/[₹\u20b9]/g, 'Rs. '), right - 2, payY, { align: 'right', maxWidth: 70 })
  } else {
    // split: a small block, one mode per line
    doc.text('Payment (Split)', right - 2, payY, { align: 'right' })
    doc.setFont('helvetica', 'normal')
    data.payment.parts.forEach((part) => { payY += 4.5; doc.text(`${part.label}   ${money(part.amount)}`, right - 2, payY, { align: 'right' }) })
    doc.setFont('helvetica', 'bold')
  }
  y = Math.max(y + logoSize + 3, shopPhoneY + 4, payY + 4) + 4

  // returned bill: one status line + the return numbers / dates, near the top
  if (data.returns) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor('#b45309')
    doc.text(data.returns.badge, pageWidth / 2, y, { align: 'center' })
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(muted)
    doc.text(data.returns.records.join('  ·  '), pageWidth / 2, y + 4.5, { align: 'center', maxWidth: right - left })
    y += 11
  }

  const customerName = String(data.customerName || 'Walk-in Customer').trim()
  const customerPhone = formatPhoneForDisplay(data.phone) || '—'
  const customerAddress = String(data.address || '').trim()
  const customerNameLines = doc.splitTextToSize(customerName, 165) as string[]
  const customerAddressLines = customerAddress
    ? doc.splitTextToSize(`Address: ${customerAddress}`, 165) as string[]
    : []
  const customerBoxHeight = 19 + customerNameLines.length * 4 + customerAddressLines.length * 4

  doc.setFillColor('#FBFAF6')
  doc.setDrawColor('#D4AF37')
  doc.setLineWidth(0.5)
  doc.roundedRect(left, y, right - left, customerBoxHeight, 2, 2, 'FD')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7)
  doc.setTextColor(THEME_PALETTE.primary)
  doc.text('BILL TO', left + 5, y + 7)
  doc.setFontSize(10)
  doc.setTextColor(ink)
  doc.text(customerNameLines, left + 5, y + 13)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(muted)
  const phoneY = y + 13 + customerNameLines.length * 4 + 2
  doc.text(`Mobile Number: ${customerPhone}`, left + 5, phoneY)
  if (customerAddressLines.length > 0) {
    doc.text(customerAddressLines, left + 5, phoneY + 5)
  }
  y += customerBoxHeight + 9

  doc.setFillColor(THEME_PALETTE.primary)
  doc.rect(left, y, right - left, 9, 'F')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7)
  doc.setTextColor(THEME_PALETTE.onDark)
  doc.text('#', left + 3, y + 6)
  doc.text('ITEM DESCRIPTION', left + 12, y + 6)
  doc.text('QTY', 139, y + 6, { align: 'center' })
  doc.text('RATE', 164, y + 6, { align: 'right' })
  doc.text('AMOUNT', right - 3, y + 6, { align: 'right' })
  y += 14

  data.items.forEach((item, index) => {
    if (y > 260) { doc.addPage(); y = 20 }
    const name = item.name || 'Item'
    const nameLines = doc.splitTextToSize(name, 105) as string[]
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    doc.setTextColor(ink)
    doc.text(String(index + 1), left + 3, y)
    doc.text(nameLines, left + 12, y)
    // Unit belongs with the item description (the QTY column stays a bare
    // number), matching the on-screen invoice's "m · ₹100.00" sub-line.
    const subY = y + nameLines.length * 4
    const unitLabel = normalizeUnitLabel(item.unit, item.unit_type)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(muted)
    doc.text(`${unitLabel} · ${money(item.base_price)}`, left + 12, subY)
    if (item.returnNote) { doc.setTextColor('#b45309'); doc.text(item.returnNote, left + 12, subY + 3.6); doc.setTextColor(muted) }
    doc.text(`${formatQuantityValue(item.quantity)}`, 139, y, { align: 'center' })
    doc.text(money(item.base_price), 164, y, { align: 'right' })
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    doc.setTextColor(ink)
    doc.text(money(item.line_total), right - 3, y, { align: 'right' })
    y += Math.max(14, (nameLines.length + 1) * 4 + 4 + (item.returnNote ? 3.6 : 0))
    doc.setDrawColor('#e8eaed')
    doc.line(left, y - 3, right, y - 3)
  })

  y = Math.max(y + 6, 150)
  // the shared rows: Subtotal, then only the non-zero ones (discounts, taxable amount, CGST / SGST, delivery)
  const roomFor = (h: number) => { if (y + h > 268) { doc.addPage(); y = 20 } }
  data.rows.forEach((r) => {
    roomFor(8)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(r.kind === 'tax' ? 8 : 9)
    doc.setTextColor(r.kind === 'discount' ? THEME_PALETTE.accentDark : ink)
    doc.text(r.label, 142, y, { align: 'right' })
    doc.text(r.kind === 'discount' ? `-${money(r.amount)}` : money(r.amount), right - 3, y, { align: 'right' })
    y += 8 // one fixed row height for every row, so no row can overlap the next
  })
  roomFor(14)
  doc.setDrawColor('#D4AF37')
  doc.setLineWidth(1)
  doc.line(left + 20, y - 3, right - 3, y - 3)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.setTextColor(THEME_PALETTE.primary)
  doc.text('TOTAL', 142, y + 6, { align: 'right' })
  doc.text(money(data.total), right - 3, y + 6, { align: 'right' })
  y += 15

  // advance-order bill: deposits and the balance paid at completion; returned bill: Returned and Net amount (below TOTAL)
  const extra = (label: string, value: string, opt: { size?: number; color?: string; bold?: boolean } = {}) => {
    roomFor(7)
    doc.setFont('helvetica', opt.bold ? 'bold' : 'normal')
    doc.setFontSize(opt.size ?? 9)
    doc.setTextColor(opt.color ?? ink)
    doc.text(label, 142, y, { align: 'right' })
    doc.text(value, right - 3, y, { align: 'right' })
    y += 7
  }
  if (data.advance) {
    if (data.advance.reference) extra('Advance order', data.advance.reference)
    data.advance.deposits.forEach((d) => extra(d.label, money(d.amount)))
    if (data.advance.balance) {
      extra(data.advance.balance.label, money(data.advance.balance.amount))
      data.advance.balance.parts.forEach((p) => extra(p.label, money(p.amount), { size: 8, color: muted }))
    }
  }
  if (data.returns) {
    extra('Returned', `-${money(data.returns.returned)}`, { color: '#b45309' })
    extra('Net amount', money(data.returns.net), { size: 11, color: THEME_PALETTE.primary, bold: true })
  }

  y = 275
  doc.setDrawColor('#D4AF37')
  doc.setLineWidth(0.5)
  doc.line(left, y, right, y)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(THEME_PALETTE.primary)
  doc.text('THANK YOU FOR SHOPPING WITH US', pageWidth / 2, y + 8, { align: 'center' })
  return doc.output('blob')
}

export function invoicePdfFile(data: InvoicePdfData): File {
  return new File([createInvoicePdf(data)], `Invoice-${formatInvoiceNo(data.invoiceNo)}.pdf`, { type: 'application/pdf' })
}

/** Captures the rendered invoice so the downloaded PDF matches the visible view and anchors footer to the bottom. */
export async function invoicePdfFileFromElement(
  element: HTMLElement,
  invoiceNo: string,
): Promise<File> {
  const formattedNo = formatInvoiceNo(invoiceNo)
  const invoiceRoot = (element.querySelector('#invoice-print-root') as HTMLElement) || element
  const canonicalWidth = 680
  const targetMinHeight = Math.round(canonicalWidth * (297 / 210)) // 962px (exact A4 ratio)

  try {
    const canvas = await html2canvas(invoiceRoot, {
      backgroundColor: '#ffffff',
      scale: 2,
      useCORS: true,
      logging: false,
      windowWidth: 1024,
      onclone: (_clonedDoc, clonedElement) => {
        const clonedInvoice =
          clonedElement.id === 'invoice-print-root'
            ? clonedElement
            : (clonedElement.querySelector('#invoice-print-root') as HTMLElement) || clonedElement
        clonedInvoice.style.width = `${canonicalWidth}px`
        clonedInvoice.style.minWidth = `${canonicalWidth}px`
        clonedInvoice.style.maxWidth = `${canonicalWidth}px`
        clonedInvoice.style.minHeight = `${targetMinHeight}px`
        clonedInvoice.style.boxSizing = 'border-box'
        clonedInvoice.style.margin = '0 auto'
      },
    })

    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
    const pageWidth = 210
    const pageHeight = 297
    const imageHeight = (canvas.height * pageWidth) / canvas.width
    const image = canvas.toDataURL('image/png')

    if (imageHeight <= pageHeight + 5) {
      doc.addImage(image, 'PNG', 0, 0, pageWidth, pageHeight, undefined, 'FAST')
    } else {
      let offset = 0
      let page = 0
      while (offset < imageHeight) {
        if (page > 0) doc.addPage()
        doc.addImage(image, 'PNG', 0, -offset, pageWidth, imageHeight, undefined, 'FAST')
        offset += pageHeight
        page += 1
      }
    }

    return new File([doc.output('blob')], `Invoice-${formattedNo}.pdf`, { type: 'application/pdf' })
  } catch (error) {
    console.error('Failed to generate invoice PDF from element:', error)
    throw error
  }
}
