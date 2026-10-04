import { useBranchStore, useSettingsStore, type PosBranch, type ActiveBranch, type AdminRole, type StoreSettings } from '../store/store'
import { normalizeHex, shadeHex, tintHex, mixHex } from './color'
import { BRAND_LOGO_POS1, BRAND_LOGO_POS2, LEGACY_THEME_COLORS, THEME_PALETTE } from './brand'

/** User-facing branch name, themed to what that branch actually sells
 * (not a generic "POS 1"/"POS 2") — keep this the single source of truth
 * for the branch name shown anywhere in the UI. */
const branchRow = (branch: PosBranch) => useBranchStore.getState().branches.find((b) => b.id === branch)

export const branchLabel = (branch: PosBranch) =>
  branch === 'pos3' ? (branchRow(branch)?.name || 'Branch 3') : branch === 'pos2' ? 'Fireworks & Crackers POS' : 'Jute & Wedding POS'

/** Short chip/badge form of branchLabel for tight spaces (nav pills, badges). */
export const branchShortLabel = (branch: PosBranch) =>
  branch === 'pos3' ? (branchRow(branch)?.short_label || 'Branch 3') : branch === 'pos2' ? 'Fireworks POS' : 'Jute & Wedding POS'

/** "Branch 1" / "Branch 2" / "Branch 3": the plain branch name used in the header role badge. */
export const branchName = (branch: PosBranch) => branchRow(branch)?.name || `Branch ${branch.slice(-1)}`

/** What this branch actually sells, for taglines/subtitles (matches the
 * wording baked into each branch's own logo art and Store Settings
 * business_type). */
export const branchSubtitle = (branch: PosBranch) =>
  branch === 'pos3' ? (branchRow(branch)?.subtitle || 'Branch 3') : branch === 'pos2' ? 'Fireworks & Crackers' : 'Wedding Card, Wedding Bag and Jute Bag Manufacturing'

/** Combined tagline for admin/global contexts that span both branches
 * (e.g. the Admin Orchestrator login tab) — showing only one branch's
 * business line there would be misleading since admin manages both. */
export const combinedBranchSubtitle = () => `${branchSubtitle('pos1')} + ${branchSubtitle('pos2')}`

export const branchLogo = (branch: PosBranch) =>
  useSettingsStore.getState().settingsByBranch[branch]?.logoUrl ||
  (branch === 'pos3' ? (branchRow(branch)?.logo_url || '/branch-placeholder.svg') : branch === 'pos2' ? BRAND_LOGO_POS2 : BRAND_LOGO_POS1)

/** Per-branch palette. All branches point at the SAME shared palette today; give a branch its own object here
 * (or just save a colour in Store Settings) to retheme it later without touching any component. */
export interface BranchPalette { primary: string }
const SHARED_BRANCH_PALETTE: BranchPalette = { primary: THEME_PALETTE.primary }
export const BRANCH_PALETTE: Record<string, BranchPalette> = {
  pos1: SHARED_BRANCH_PALETTE,
  pos2: SHARED_BRANCH_PALETTE,
  pos3: SHARED_BRANCH_PALETTE,
}
export const paletteFor = (branch?: string | null): BranchPalette => BRANCH_PALETTE[branch || ''] || SHARED_BRANCH_PALETTE

/** The colour a branch actually shows: a saved Store Settings colour wins unless it is one of the old
 * pre-theme defaults, in which case the shared palette is used. */
export function resolveBranchColor(branch: string | null | undefined, saved?: string | null): string {
  const s = (saved || '').trim().toLowerCase()
  if (s && !LEGACY_THEME_COLORS.includes(s)) return normalizeHex(s)
  return normalizeHex(paletteFor(branch).primary)
}

const luminance = (hex: string) => {
  const h = normalizeHex(hex).slice(1)
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** Hover / pressed shade: darker for normal colours, LIGHTER for near-black ones (black cannot get darker). */
export const hoverShade = (hex: string) => (luminance(hex) < 0.08 ? mixHex(hex, '#FFFFFF', 0.12) : shadeHex(hex, 0.28))
/** Branch accent surface (active nav item, chips): a step lighter than the primary so it stays visible on it. */
export const accentSurface = (hex: string) => (luminance(hex) < 0.08 ? mixHex(hex, '#FFFFFF', 0.17) : hex)

export const posAccent = (branch: PosBranch) => branch === 'pos2' || branch === 'pos3'
  ? { bg: 'bg-posTwo', bgLight: 'bg-posTwo-light', text: 'text-posTwo-dark', border: 'border-posTwo', hex: accentSurface(resolveBranchColor(branch)) }
  : { bg: 'bg-posOne', bgLight: 'bg-posOne-light', text: 'text-posOne-dark', border: 'border-posOne', hex: accentSurface(resolveBranchColor('pos1')) }

export const DEFAULT_BRANCH_COLOR: Record<PosBranch, string> = { pos1: THEME_PALETTE.primary, pos2: THEME_PALETTE.primary, pos3: THEME_PALETTE.primary }
export const DEFAULT_ADMIN_COLOR: string = THEME_PALETTE.primary

const ADMIN_THEME_STORAGE_KEY = 'yg_admin_theme_color'

export function getAdminThemeColor(): string {
  try {
    const saved = localStorage.getItem(ADMIN_THEME_STORAGE_KEY)
    if (saved && !LEGACY_THEME_COLORS.includes(saved.trim().toLowerCase())) return normalizeHex(saved)
  } catch { /* ignore */ }
  return DEFAULT_ADMIN_COLOR
}

export function setAdminThemeColor(hex: string): void {
  try {
    const normalized = normalizeHex(hex)
    localStorage.setItem(ADMIN_THEME_STORAGE_KEY, normalized)
  } catch { /* ignore */ }
}

/** Pushes each branch's saved Appearance color (Store Settings) onto the
 * `--pos-one*` / `--pos-two*` CSS custom properties that `bg-posOne`,
 * `text-posTwo-dark`, etc. resolve to (see tailwind.config.js), so the
 * picked color actually retheme's that branch's admin UI. */
export function applyBranchThemeVars(settingsByBranch: Partial<Record<PosBranch, StoreSettings>>) {
  const root = document.documentElement
  ;(['pos1', 'pos2'] as const).forEach((branch) => {
    const varPrefix = branch === 'pos2' ? '--pos-two' : '--pos-one'
    const color = resolveBranchColor(branch, settingsByBranch[branch]?.themeColor)
    root.style.setProperty(varPrefix, accentSurface(color))
    root.style.setProperty(`${varPrefix}-dark`, hoverShade(color))
    root.style.setProperty(`${varPrefix}-light`, tintHex(color))
  })
}

/** Determines active theme color based on current role, activeBranch, and saved preferences,
 * and sets root CSS variables so the ENTIRE theme changes dynamically. */
export function applyActiveTheme(
  activeBranch: ActiveBranch,
  role: AdminRole,
  settingsByBranch: Partial<Record<PosBranch, StoreSettings>>,
  staffBranch?: PosBranch | null
) {
  const root = document.documentElement

  // Update branch vars first
  applyBranchThemeVars(settingsByBranch)

  let activeColor = DEFAULT_ADMIN_COLOR

  if (role === 'staff' && staffBranch) {
    activeColor = resolveBranchColor(staffBranch, settingsByBranch[staffBranch]?.themeColor)
  } else if (activeBranch && activeBranch !== 'all') {
    activeColor = resolveBranchColor(activeBranch, settingsByBranch[activeBranch]?.themeColor)
  } else {
    // Admin global / all branches view
    activeColor = getAdminThemeColor()
  }

  const primaryDark = hoverShade(activeColor)
  const primaryLight = tintHex(activeColor, 0.90)
  const primaryBorder = mixHex(activeColor, THEME_PALETTE.accent, 0.35)

  root.style.setProperty('--theme-primary', activeColor)
  root.style.setProperty('--theme-primary-dark', primaryDark)
  root.style.setProperty('--theme-primary-light', primaryLight)
  root.style.setProperty('--theme-primary-border', primaryBorder)

  // Map brand-black variables to the active theme color
  root.style.setProperty('--brand-black', activeColor)
  root.style.setProperty('--brand-black-surface', primaryDark)
}
