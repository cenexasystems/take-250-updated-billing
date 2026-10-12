import { jsPDF } from 'jspdf'
import { BRAND_EN, THEME_PALETTE } from './brand'
import { formatCurrency, formatInvoiceNo } from './retail'
import { printLogoFor } from './branchLogo'
import { getBranchProfile } from './branchProfile'
import type { ReturnReceiptData } from './thermalPrint'
import { refundModeLines } from './refundModes'

// same as the invoice PDF: Helvetica has no ₹ glyph
const money = (value: number): string => formatCurrency(Number(value || 0)).replace(/\s+/g, ' ').replace(/^[₹₹]\s*/, 'Rs. ')

/** A4 return receipt in the invoice PDF's style (for WhatsApp): RET- number, the original invoice, items, refund per mode. */
export function returnReceiptPdf(data: ReturnReceiptData): File {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageWidth = 210, left = 16, right = 194, ink = '#18202a', muted = '#68717c'
  let y = 16
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(THEME_PALETTE.primary)
  doc.text('RETURN RECEIPT - NOT A TAX INVOICE', left, y)
  doc.text(`Return: ${data.returnNo}`, right, y, { align: 'right' })
  y += 7; doc.setDrawColor('#D4AF37'); doc.setLineWidth(0.5); doc.line(left, y, right, y); y += 10
  const profile = getBranchProfile(data.branch)
  const addressLines = doc.splitTextToSize(profile.address, 120) as string[]
  try { doc.addImage(printLogoFor(data.branch), 'PNG', left, y - 3, 26, 26) } catch { doc.setFontSize(16); doc.text(BRAND_EN, left, y + 10) }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(THEME_PALETTE.primary); doc.text(profile.name || BRAND_EN, left + 32, y + 7)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor('#555'); doc.text(addressLines, left + 32, y + 14)
  doc.text(`Phone: ${profile.phone}`, left + 32, y + 14 + addressLines.length * 3.6 + 1.5)
  y += 34
  const meta: Array<[string, string]> = [
    ['Original invoice', `#${formatInvoiceNo(data.originalInvoiceNo)}`], ['Date', new Date(data.date).toLocaleString('en-IN')],
    ['Reason', data.note ? `${data.reason} (${data.note})` : data.reason],
  ]
  meta.forEach(([k, v]) => { doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(muted); doc.text(k.toUpperCase(), left, y); doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(ink); doc.text(v, left + 45, y, { maxWidth: 130 }); y += 7 })
  y += 4
  doc.setFillColor(THEME_PALETTE.primary); doc.rect(left, y, right - left, 9, 'F')
  doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(THEME_PALETTE.onDark)
  doc.text('ITEM', left + 3, y + 6); doc.text('QTY', 150, y + 6, { align: 'center' }); doc.text('REFUND', right - 3, y + 6, { align: 'right' })
  y += 15
  data.items.forEach((it) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(ink)
    doc.text(doc.splitTextToSize(it.name, 115) as string[], left + 3, y)
    doc.text(String(it.qty), 150, y, { align: 'center' }); doc.text(money(it.refund), right - 3, y, { align: 'right' })
    if (it.restocked === false) { doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(muted); doc.text('damaged, not restocked', left + 3, y + 4) }
    y += 10; doc.setDrawColor('#e8eaed'); doc.line(left, y - 4, right, y - 4)
  })
  y += 4
  doc.setDrawColor('#D4AF37'); doc.setLineWidth(1); doc.line(left + 80, y - 3, right - 3, y - 3)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(THEME_PALETTE.primary)
  doc.text('TOTAL REFUND', 142, y + 5, { align: 'right' }); doc.text(money(data.refundTotal), right - 3, y + 5, { align: 'right' })
  y += 13
  refundModeLines(data.refunds, data.refundMode, data.refundTotal).forEach((l) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(ink)
    doc.text(`Refund - ${l.label}`, 142, y, { align: 'right' }); doc.text(money(l.amount), right - 3, y, { align: 'right' }); y += 6
  })
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(THEME_PALETTE.primary)
  doc.line(left, 275, right, 275); doc.text(`Goods returned to ${profile.name || BRAND_EN}. This is not a tax invoice.`, pageWidth / 2, 283, { align: 'center' })
  return new File([doc.output('blob')], `${data.returnNo}.pdf`, { type: 'application/pdf' })
}
