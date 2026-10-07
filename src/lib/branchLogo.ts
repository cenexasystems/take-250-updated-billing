import { LOGO_BASE64_POS1, LOGO_BASE64_POS2, LOGO_BASE64_POS3, LOGO_THERMAL_POS1, LOGO_THERMAL_POS2, LOGO_THERMAL_POS3 } from './logoBase64'
import { useBranchStore, useSettingsStore, type PosBranch } from '../store/store'

const absolute = (url: string) => (/^(data:|https?:|blob:)/i.test(url) ? url : new URL(url, window.location.origin).href)

/** The logo printed on a branch's thermal receipt, invoice PDF and advance receipt. Order, same for every branch:
 *  1. the logo saved in that branch's Store Settings,
 *  2. the built-in logo of branches 1, 2 (shirt shop) and 3 (women's wear),
 *  3. for any further branch: the logo from its configuration row, else the placeholder. */
export function printLogoFor(branch?: string | null): string {
  const id: string = branch || 'pos1'
  const custom = useSettingsStore.getState().settingsByBranch[id as PosBranch]?.logoUrl
  if (custom) return absolute(custom)
  if (id === 'pos1') return LOGO_BASE64_POS1
  if (id === 'pos2') return LOGO_BASE64_POS2
  if (id === 'pos3') return LOGO_BASE64_POS3
  const configured = useBranchStore.getState().branches.find((b) => b.id === id)?.logo_url
  return absolute(configured || '/branch-placeholder.svg')
}

/** Logo for the 80 mm thermal receipts only. A thermal head prints black on white, so the built-in logos come as
 *  black artwork on a white background (a black-background logo would print as one solid black badge). A logo
 *  uploaded in Store Settings is used as uploaded: upload one with a white or transparent background for thermal use. */
export function thermalLogoFor(branch?: string | null): string {
  const id: string = branch || 'pos1'
  const custom = useSettingsStore.getState().settingsByBranch[id as PosBranch]?.logoUrl
  if (custom) return absolute(custom)
  if (id === 'pos1') return LOGO_THERMAL_POS1
  if (id === 'pos2') return LOGO_THERMAL_POS2
  if (id === 'pos3') return LOGO_THERMAL_POS3
  return printLogoFor(id)
}