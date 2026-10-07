export const BRAND_EN = 'TAKE250'
export const BRAND_TA = 'TAKE250'
export const BRAND_SHORT = 'T250'
export const BRAND_MONOGRAM = 'T250'

// Branch-specific barcode prefixes for inventory differentiation
export function getBarcodePrefix(branch?: string): string {
  if (branch === 'pos3') return 'T253'
  if (branch === 'pos2') return 'T252'
  return 'T251' // Default to POS1
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

export function getDefaultBarcodeSettings(_branch?: string): BarcodeSettingsConfig {
  // Clothing and footwear in every branch: the standard thermal label (50 x 25 mm) is the default;
  // each branch can still change it in the label settings (kept per branch in this browser).
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

export const BRAND_SUBTITLE = 'Dress & Footwear'
export const BRAND_LOGO = '/yg-logo.png'
export const BRAND_ICON = '/yg-icon.png'
export const BRAND_FAVICON = '/yg-favicon.png'

// Per-branch logos: Branches 1 and 2 are the Take250 shirt shop, Branch 3 is Take250 Women's Wear.
export const BRAND_LOGO_POS1 = '/yg-logo-pos1.png'
export const BRAND_LOGO_POS2 = '/yg-logo-pos2.png'
export const BRAND_LOGO_POS3 = '/yg-logo-pos3.png'
export const BRAND_PRODUCTION_DOMAIN = 'https://cen-gen-pos.vercel.app'

// Owner / personal contact
export const BRAND_OWNER_NAME = 'M. Ramkumar'
export const BRAND_OWNER_PHONE_DISPLAY = '+91 88831 73358'
export const BRAND_OWNER_PHONE_E164 = '918883173358'

// Official shop contact (used for receipts, billing, and customer WhatsApp)
export const BRAND_PRIMARY_PHONE_DISPLAY = '+91 88831 73358'
export const BRAND_PRIMARY_PHONE_E164 = '918883173358'
export const BRAND_SECONDARY_PHONE_DISPLAY = '+91 73393 44149'
export const BRAND_SECONDARY_PHONE_E164 = '917339344149'
export const BRAND_THIRD_PHONE_DISPLAY = BRAND_SECONDARY_PHONE_DISPLAY
export const BRAND_THIRD_PHONE_E164 = BRAND_SECONDARY_PHONE_E164

export const BRAND_PHONE_DISPLAY = BRAND_PRIMARY_PHONE_DISPLAY
export const BRAND_PHONE_E164 = BRAND_PRIMARY_PHONE_E164

export const BRAND_WHATSAPP = BRAND_PRIMARY_PHONE_DISPLAY
export const WHATSAPP_NUM = BRAND_PRIMARY_PHONE_E164
export const BRAND_WHATSAPP_LINK = `https://wa.me/${BRAND_PRIMARY_PHONE_E164}`

// Fallbacks only: every branch's own details come from Store Settings (see migration 0005)
export const BRAND_EMAIL = 'take250shop@gmail.com'
export const BRAND_ADDRESS = '' // never another branch's address: each branch's own comes from Store Settings
export const BRAND_WEBSITE = 'https://www.instagram.com/take.250shop/'
export const BRAND_LOCATION_LINK = '#'

// Instagram shown on invoices, receipts and WhatsApp messages: one account for all branches
export function getInstagramUrls(_branch?: string): string {
  return 'https://www.instagram.com/take.250shop/'
}

export const BRAND_INSTAGRAM = '' // Deprecated: use getInstagramUrls(branch)
export const BRAND_INSTAGRAM_URL = '' // Deprecated: use getInstagramUrls(branch)