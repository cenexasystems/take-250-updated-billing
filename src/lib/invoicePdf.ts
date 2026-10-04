import { jsPDF } from 'jspdf'
import html2canvas from 'html2canvas'
import { BRAND_EN, THEME_PALETTE } from './brand'
import { formatCurrency, formatQuantityValue, normalizeStructuredOrderItem, normalizeUnitLabel, formatInvoiceNo } from './retail'
import { LOGO_BASE64_POS1, LOGO_BASE64_POS2 } from './logoBase64'
import type { PosBranch } from '../store/store'
import { getBranchProfile } from './branchProfile'
import { formatPhoneForDisplay } from './phone'

export type InvoicePdfData = {
  invoiceNo: string
  date: string
  customerName: string
  phone: string
  address: string
  branch?: PosBranch
  items: Array<Record<string, unknown>>
  subtotal: number
  shipping: number
  total: number
  discountAmount?: number
  manualDiscountAmount?: number
  gstAmount?: number
  couponCode?: string | null
  paymentMode?: string
}

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

  try {
    doc.addImage(data.branch === 'pos2' ? LOGO_BASE64_POS2 : LOGO_BASE64_POS1, 'PNG', left, y, 30, 30)
  } catch {
    doc.setTextColor(primaryColor)
    doc.setFontSize(16)
    doc.text(BRAND_EN, left, y + 15)
  }
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(THEME_PALETTE.primary)
  doc.text(BRAND_EN, left + 35, y + 10)
  doc.setFontSize(8)
  doc.setTextColor('#555')
  doc.setFont('helvetica', 'normal')
  const profile = getBranchProfile(data.branch)
  doc.text(profile.address, left + 35, y + 17, { maxWidth: 80 })
  doc.text(`Phone: ${profile.phone}`, left + 35, y + 25)
  doc.setTextColor(THEME_PALETTE.primary)
  doc.setFont('helvetica', 'bold')
  doc.text(`Date: ${new Date(data.date).toLocaleDateString('en-IN')}`, right - 2, y + 2, { align: 'right' })
  const paymentText = `Payment: ${data.paymentMode || 'POS'}`.replace(/[₹\u20b9]/g, 'Rs. ')
  doc.text(paymentText, right - 2, y + 8, { align: 'right', maxWidth: 100 })
  y += 28

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

  data.items.forEach((raw, index) => {
    const item = normalizeStructuredOrderItem(raw)
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
    doc.text(`${formatQuantityValue(item.quantity)}`, 139, y, { align: 'center' })
    doc.text(money(item.base_price), 164, y, { align: 'right' })
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    doc.setTextColor(ink)
    doc.text(money(item.line_total), right - 3, y, { align: 'right' })
    y += Math.max(14, (nameLines.length + 1) * 4 + 4)
    doc.setDrawColor('#e8eaed')
    doc.line(left, y - 3, right, y - 3)
  })

  y = Math.max(y + 6, 150)
  const rows: Array<[string, string, string, number]> = [['Subtotal', money(data.subtotal), ink, 9]]
  if ((data.discountAmount || 0) > 0) rows.push([`Coupon${data.couponCode ? ` (${data.couponCode})` : ''}`, `-${money(data.discountAmount || 0)}`, THEME_PALETTE.accentDark, 11])
  if ((data.manualDiscountAmount || 0) > 0) rows.push(['Discount', `-${money(data.manualDiscountAmount || 0)}`, THEME_PALETTE.accentDark, 9])
  if ((data.gstAmount || 0) > 0) rows.push(['GST', money(data.gstAmount || 0), ink, 7])
  rows.push(['Delivery', (data.shipping || 0) > 0 ? money(data.shipping) : 'FREE', ink, 9])
  rows.forEach(([label, value, color, fontSize]) => {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(fontSize)
    doc.setTextColor(color === THEME_PALETTE.accentDark ? THEME_PALETTE.accentDark : '#18202a')
    doc.text(label, 142, y, { align: 'right' })
    doc.text(value, right - 3, y, { align: 'right' })
    y += 7
  })
  doc.setDrawColor('#D4AF37')
  doc.setLineWidth(1)
  doc.line(left + 20, y - 3, right - 3, y - 3)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.setTextColor(THEME_PALETTE.primary)
  doc.text('TOTAL', 142, y + 6, { align: 'right' })
  doc.text(money(data.total), right - 3, y + 6, { align: 'right' })

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
