import { useSettingsStore, type PosBranch } from '../store/store'
import {
  BRAND_ADDRESS,
  BRAND_EMAIL,
  BRAND_EN,
  BRAND_LOGO_POS1,
  BRAND_LOGO_POS2,
  BRAND_PRIMARY_PHONE_DISPLAY,
  getInstagramUrls,
} from './brand'
import { cleanIdentityField } from './identity'
import { printLogoFor } from './branchLogo'

export interface BranchProfile {
  name: string
  address: string
  phone: string
  email: string
  logo: string
  /** One Instagram URL per line */
  instagramUrls: string
}

const toBranch = (branch?: string | null): PosBranch => (branch === 'pos2' || branch === 'pos3' ? branch : 'pos1')

/** "@a, b https://instagram.com/c/" → lines of instagram URLs. Empty input → '' */
export function instagramUrlsFromIds(raw: string | null | undefined): string {
  const handles = String(raw || '')
    .split(/[\s,]+/)
    .map((h) => h.replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/\/+$/, '').trim())
    .filter(Boolean)
  return handles.map((h) => `https://www.instagram.com/${h}/`).join('\n')
}

/**
 * Shop details for a branch as saved in Admin → Store Settings, falling back to the
 * built-in brand constants for any field left empty. Used by invoices, receipts,
 * WhatsApp messages and branch logos so edits in Store Settings actually take effect.
 */
export function getBranchProfile(branch?: string | null): BranchProfile {
  const b = toBranch(branch)
  const s = useSettingsStore.getState().settingsByBranch[b]
  return {
    name: cleanIdentityField(s?.name) || BRAND_EN,
    address: cleanIdentityField(s?.address) || BRAND_ADDRESS,
    phone: cleanIdentityField(s?.phone) || BRAND_PRIMARY_PHONE_DISPLAY,
    email: cleanIdentityField(s?.email) || BRAND_EMAIL,
    logo: s?.logoUrl || (b === 'pos3' ? printLogoFor(b) : b === 'pos2' ? BRAND_LOGO_POS2 : BRAND_LOGO_POS1),
    instagramUrls: instagramUrlsFromIds(s?.instagramId) || getInstagramUrls(b),
  }
}
