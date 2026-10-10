import { jsPDF } from 'jspdf'
import { BRAND_EN, THEME_PALETTE } from './brand'
import { formatCurrency } from './retail'
import { printLogoFor } from './branchLogo'
import type { PosBranch } from '../store/store'
import { getBranchProfile } from './branchProfile'
import { formatPhoneForDisplay } from './phone'

/** Only the fields the coupon form / list already has (code, discount %, expiry, usage limit, minimum order). */
export type CouponPdfData = {
  branch: PosBranch
  code: string
  percentage: number
  expiryDate: string | null
  usageLimit: number | null
  minOrderValue: number
  /** the customer it is sent to (name optional) */
  customerName?: string
  phone?: string
}

// same as the invoice PDF: Helvetica has no ₹ glyph
const money = (value: number): string => formatCurrency(Number(value || 0)).replace(/\s+/g, ' ').replace(/^[₹₹]\s*/, 'Rs. ')

export const couponPdfName = (code: string) => `COUPON-${code.trim().toUpperCase()}.pdf`

/** A4 coupon in the invoice PDF's style (black and gold, branch logo, shop name, address, phone). */
export function createCouponPdf(data: CouponPdfData): Blob {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageWidth = 210
  const left = 16
  const right = 194
  const ink = '#18202a'
  const code = data.code.trim().toUpperCase()
  let y = 16

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(THEME_PALETTE.primary)
  doc.text('DISCOUNT COUPON', left, y)
  doc.text(`Code: ${code}`, right, y, { align: 'right' })
  y += 7
  doc.setDrawColor('#D4AF37')
  doc.setLineWidth(0.5)
  doc.line(left, y, right, y)
  y += 10

  // header block, as on the invoice: 26 mm logo, shop name / address / phone beside it
  const profile = getBranchProfile(data.branch)
  const logoSize = 26
  const textX = left + logoSize + 6
  const addressLines = doc.splitTextToSize(profile.address, 120) as string[]
  const shopPhoneY = y + 14 + addressLines.length * 3.6 + 1.5
  try {
    doc.addImage(printLogoFor(data.branch), 'PNG', left, y - 3, logoSize, logoSize)
  } catch {
    doc.setTextColor(THEME_PALETTE.accentDark)
    doc.setFontSize(16)
    doc.text(BRAND_EN, left, y + 10)
  }
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(THEME_PALETTE.primary)
  doc.text(profile.name || BRAND_EN, textX, y + 7)
  doc.setFontSize(8)
  doc.setTextColor('#555')
  doc.setFont('helvetica', 'normal')
  doc.text(addressLines, textX, y + 14)
  doc.text(`Phone: ${profile.phone}`, textX, shopPhoneY)
  y = Math.max(y + logoSize + 3, shopPhoneY + 4) + 8

  // the code, large, on the black band with gold
  const bandH = 46
  doc.setFillColor(THEME_PALETTE.primary)
  doc.roundedRect(left, y, right - left, bandH, 3, 3, 'F')
  doc.setDrawColor('#D4AF37')
  doc.setLineWidth(0.8)
  doc.roundedRect(left + 3, y + 3, right - left - 6, bandH - 6, 2, 2, 'S')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor('#D4AF37')
  doc.text('COUPON CODE', pageWidth / 2, y + 12, { align: 'center' })
  doc.setFontSize(code.length > 14 ? 26 : 34)
  doc.setTextColor(THEME_PALETTE.onDark)
  doc.text(code, pageWidth / 2, y + 28, { align: 'center' })
  doc.setFontSize(13)
  doc.setTextColor('#D4AF37')
  doc.text(`${Number(data.percentage)}% OFF`, pageWidth / 2, y + 38, { align: 'center' })
  y += bandH + 12

  // details: only the fields that exist on a coupon
  const rows: Array<[string, string]> = [
    ['Discount', `${Number(data.percentage)}% off`],
    ['Minimum order', Number(data.minOrderValue) > 0 ? money(data.minOrderValue) : 'No minimum'],
    ['Valid till', data.expiryDate ? new Date(data.expiryDate).toLocaleDateString('en-IN') : 'No expiry'],
    ['Usage limit', data.usageLimit ? `${data.usageLimit} use${data.usageLimit === 1 ? '' : 's'} in total` : 'Unlimited'],
  ]
  const customer = String(data.customerName || '').trim()
  const phone = data.phone ? formatPhoneForDisplay(data.phone) : ''
  const boxH = 8 + rows.length * 9 + (phone ? 10 : 0)
  doc.setFillColor('#FBFAF6')
  doc.setDrawColor('#D4AF37')
  doc.setLineWidth(0.5)
  doc.roundedRect(left, y, right - left, boxH, 2, 2, 'FD')
  let ry = y + 10
  rows.forEach(([label, value]) => {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    doc.setTextColor(THEME_PALETTE.primary)
    doc.text(label.toUpperCase(), left + 6, ry)
    doc.setFontSize(11)
    doc.setTextColor(ink)
    doc.text(value, right - 6, ry, { align: 'right' })
    ry += 9
  })
  if (phone) {
    doc.setDrawColor('#E8D399')
    doc.line(left + 6, ry - 4, right - 6, ry - 4)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    doc.setTextColor(THEME_PALETTE.primary)
    doc.text('ISSUED TO', left + 6, ry + 3)
    doc.setFontSize(11)
    doc.setTextColor(ink)
    doc.text(customer ? `${customer} · ${phone}` : phone, right - 6, ry + 3, { align: 'right' })
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

export function couponPdfFile(data: CouponPdfData): File {
  return new File([createCouponPdf(data)], couponPdfName(data.code), { type: 'application/pdf' })
}
