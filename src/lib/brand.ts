export const BRAND_EN = 'YG ENTERPRISES'
export const BRAND_TA = 'YG ENTERPRISES'
export const BRAND_SHORT = 'YG'
export const BRAND_MONOGRAM = 'YG'

// Branch-specific barcode prefixes for inventory differentiation
export function getBarcodePrefix(branch?: string): string {
  if (branch === 'pos2') return 'YG2'
  return 'YG1' // Default to POS1
}

// Branch-specific barcode settings
export interface BarcodeSettingsConfig {
  printerType: 'label' | 'regular'
  selectedSizeId: string
  showSalePrice: boolean
  showCompanyName: boolean
  showItemName: boolean
  showDiscount: boolean
}

export function getDefaultBarcodeSettings(branch?: string): BarcodeSettingsConfig {
  if (branch === 'pos2') {
    // POS2: Fireworks/Crackers - Large carton labels with discounts
    return {
      printerType: 'regular',
      selectedSizeId: '1_100x50',
      showSalePrice: true,
      showCompanyName: true,
      showItemName: true,
      showDiscount: true
    }
  }
  // POS1: Wedding Cards/Bags - Standard thermal labels (default)
  return {
    printerType: 'label',
    selectedSizeId: '2_50x25',
    showSalePrice: true,
    showCompanyName: true,
    showItemName: true,
    showDiscount: false
  }
}

/** The ONE shared black-and-gold palette. Every branch references it (see BRANCH_PALETTE in branchTheme.ts),
 * so a branch can get its own colours later by changing data, not components. */
export const THEME_PALETTE = {
  primary: '#0A0A0A',        // black: sidebar, header, dark buttons (white / gold text on top)
  accent: '#D4AF37',         // gold: highlights, borders, primary-button text on black, focus rings
  accentDark: '#8A6A0A',     // gold dark enough for TEXT on white / cream (>= 4.5:1)
  accentBorder: '#E8D399',
  surface: '#FBFAF6',
  text: '#111111',
  onDark: '#FFFFFF',
  onGold: '#0A0A0A',         // text ON gold is black (white on gold fails contrast)
} as const

/** Colours the app used before the black-and-gold theme. A saved Store Settings colour equal to one of these
 * is treated as "never customised" and shows the shared palette instead; any other saved colour still wins. */
export const LEGACY_THEME_COLORS = ['#7a1220', '#8b1a1a', '#b8860b', '#1f6f5c', '#5a0e17', '#5c0d18']

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
