import { LOGO_BASE64_POS1, LOGO_BASE64_POS2 } from './logoBase64'
import { useBranchStore, useSettingsStore } from '../store/store'

const absolute = (url: string) => (/^(data:|https?:|blob:)/i.test(url) ? url : new URL(url, window.location.origin).href)

/** The logo printed on a branch's thermal receipt, invoice PDF and advance receipt. Order, same for every branch:
 *  1. the logo saved in that branch's Store Settings,
 *  2. the built-in logo of branches 1 and 2,
 *  3. the logo from the branch's configuration row (branch 3 starts with the placeholder until its real logo is set). */
export function printLogoFor(branch?: string | null): string {
  const id = branch === 'pos2' || branch === 'pos3' ? branch : 'pos1'
  const custom = useSettingsStore.getState().settingsByBranch[id]?.logoUrl
  if (custom) return absolute(custom)
  if (id === 'pos1') return LOGO_BASE64_POS1
  if (id === 'pos2') return LOGO_BASE64_POS2
  const configured = useBranchStore.getState().branches.find((b) => b.id === id)?.logo_url
  return absolute(configured || '/branch-placeholder.svg')
}
