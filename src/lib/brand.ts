export const BRAND_EN = 'YG ENTERPRISES'
export const BRAND_TA = 'YG ENTERPRISES'
export const BRAND_SHORT = 'YG'
export const BRAND_MONOGRAM = 'YG'

export const BRAND_SUBTITLE = 'Wedding Card, Wedding Bag and Jute Bag Manufacturing'
export const BRAND_LOGO = '/yg-logo.png'
export const BRAND_ICON = '/yg-icon.png'
export const BRAND_FAVICON = '/yg-favicon.png'

// Per-branch logos: POS 1 (wedding cards/bags/jute bag manufacturing) and
// POS 2 (fireworks & crackers) are different enough businesses that they
// get their own marks wherever the UI is showing one specific branch.
export const BRAND_LOGO_POS1 = '/yg-logo-pos1.png'
export const BRAND_LOGO_POS2 = '/yg-logo-pos2.png'
export const BRAND_PRODUCTION_DOMAIN = 'https://cen-gen-pos.vercel.app'

// Owner / Personal contact
export const BRAND_OWNER_NAME = 'M. Gurumoorthy'
export const BRAND_OWNER_PHONE_DISPLAY = '+91 98844 10700'
export const BRAND_OWNER_PHONE_E164 = '919884410700'

// Official Shop contact (used for receipts, billing, and customer WhatsApp)
export const BRAND_PRIMARY_PHONE_DISPLAY = '+91 98844 10700'
export const BRAND_PRIMARY_PHONE_E164 = '919884410700'
export const BRAND_SECONDARY_PHONE_DISPLAY = '+91 97878 08090'
export const BRAND_SECONDARY_PHONE_E164 = '919787808090'
export const BRAND_THIRD_PHONE_DISPLAY = BRAND_SECONDARY_PHONE_DISPLAY
export const BRAND_THIRD_PHONE_E164 = BRAND_SECONDARY_PHONE_E164

export const BRAND_PHONE_DISPLAY = BRAND_PRIMARY_PHONE_DISPLAY
export const BRAND_PHONE_E164 = BRAND_PRIMARY_PHONE_E164

export const BRAND_WHATSAPP = BRAND_PRIMARY_PHONE_DISPLAY
export const WHATSAPP_NUM = BRAND_PRIMARY_PHONE_E164
export const BRAND_WHATSAPP_LINK = `https://wa.me/${BRAND_PRIMARY_PHONE_E164}`

export const BRAND_EMAIL = 'ygenterprises2000@gmail.com'
export const BRAND_ADDRESS = '#189, N.S.C. Bose Road, (Opp. Bus Depot, Hotel Sankar Cafe Building), Chennai - 600 001'
export const BRAND_WEBSITE = 'https://ygenterprises.co.in'
export const BRAND_LOCATION_LINK = '#'

// Instagram URLs shown on invoices, receipts and WhatsApp messages — same handles for both branches
export function getInstagramUrls(_branch?: string): string {
  return `https://www.instagram.com/yg_enterprises001/
https://www.instagram.com/ygenterprises7755/`
}

export const BRAND_INSTAGRAM = '' // Deprecated: use getInstagramUrls(branch)
export const BRAND_INSTAGRAM_URL = '' // Deprecated: use getInstagramUrls(branch)
