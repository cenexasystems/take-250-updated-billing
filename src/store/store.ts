import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { fetchAllCategories, fetchAllProducts } from '../services/productService'
import { fetchAllVariants, type ProductVariant } from '../services/variantService'
import { BRAND_ADDRESS, BRAND_EMAIL, BRAND_EN, BRAND_OWNER_NAME, BRAND_PHONE_DISPLAY } from '../lib/brand'
import { cleanIdentityField } from '../lib/identity'
import {
  calculateLineTotal,
  normalizeSelectedQuantity,
  normalizeUnitType,
  toNumber,
  type QuantityOption,
  type UnitType,
} from '../lib/retail'

import { useAlarmStore } from './alarmStore'
import { alarmSound } from '../lib/alarmAudio'
import { api } from '../lib/apiClient'
import { clearBarcodePreferences } from '../lib/barcode'

export type { ProductVariant }

/** Shared state for authentication, products, billing, and settings. */

// --- Types ---
export interface Product {
  id: string | number // Support both legacy numeric IDs and new UUIDs
  name: string
  nameTa?: string
  tamilName?: string
  category: string
  categoryId?: number | string | null
  remedy: string[]
  price: number
  offerPrice?: number | null
  unitType: UnitType
  unitLabel: string
  baseQuantity: number
  stockQuantity: number
  stockUnit: string
  allowDecimalQuantity: boolean
  predefinedOptions: QuantityOption[]
  isActive: boolean
  sortOrder: number
  unit: string
  rating: number
  stock: number
  description: string
  descriptionTa?: string
  benefits: string
  benefitsTa?: string
  image: string
  imageUrl?: string
  source?: 'catalogue' | 'manual'
  note?: string | null
  hasVariants?: boolean

  // POS inventory fields
  sku?: string
  barcode?: string
  brand?: string
  purchasePrice?: number
  mrp?: number
  gstPercent?: number
  openingStock?: number
  lowStockAlert?: number
  supplier?: string
  size?: string
  color?: string
}

interface ProductState {
  products: Product[]
  loading: boolean
  error: string | null
  lastFetch: number
  lastFetchScope: string | null
  fetchProducts: (branch?: PosBranch, force?: boolean) => Promise<void>
  /** Re-fetches whichever branch's catalog is currently loaded. */
  refreshProducts: () => Promise<void>
}

export interface StoreSettings {
  name: string
  ownerName: string
  phone: string
  email: string
  address: string
  businessType: string
  instagramId: string
  logoUrl: string | null
  themeColor: string
  websiteUrl?: string
  gstEnabled: boolean
}

interface SettingsState {
  settings: StoreSettings | null
  settingsByBranch: Partial<Record<PosBranch, StoreSettings>>
  loading: boolean
  fetchSettings: (branch?: PosBranch) => Promise<void>
}

interface VariantStoreState {
  variantsMap: Record<string, ProductVariant[]>
  fetched: boolean
  fetchedScope: string | null
  fetchVariants: (branch?: PosBranch) => Promise<void>
  refetchVariants: (branch?: PosBranch) => Promise<void>
  getVariants: (productId: string) => ProductVariant[]
  getDefaultVariant: (productId: string) => ProductVariant | null
  hasVariants: (productId: string | number) => boolean
}

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>
  }
  return {}
}

const readString = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback)

const LEGACY_CATEGORY_NAMES = new Set<string>()

const mapDbProduct = (input: unknown, categoriesById: Record<string, string> = {}): Product => {
  const p = asRecord(input)
  const categoryId = typeof p.category_id === 'string' || typeof p.category_id === 'number' ? p.category_id : null
  const image = readString(p.image_url) || readString(p.image) || '/product-placeholder.svg'
  const remedy = Array.isArray(p.remedy)
    ? p.remedy.filter((entry): entry is string => typeof entry === 'string')
    : []

  return {
    id: String(p.id || ''),
    name: readString(p.name, 'Product'),
    nameTa: readString(p.name_ta) || readString(p.tamil_name),
    tamilName: readString(p.tamil_name) || readString(p.name_ta),
    category: categoriesById[String(categoryId)] || (() => {
      const legacyCategory = readString(p.category).trim()
      return LEGACY_CATEGORY_NAMES.has(legacyCategory.toLowerCase()) ? '' : legacyCategory
    })(),
    categoryId,
    remedy,
    price: toNumber(p.price, 0),
    offerPrice: p.offer_price != null ? toNumber(p.offer_price, 0) : null,
    unitType: normalizeUnitType(p.unit_type, 'unit'),
    unitLabel: readString(p.unit_label, 'piece'),
    baseQuantity: toNumber(p.base_quantity, 1),
    stockQuantity: toNumber(p.stock_quantity, 0),
    stockUnit: readString(p.stock_unit, 'piece'),
    allowDecimalQuantity: Boolean(p.allow_decimal_quantity),
    predefinedOptions: Array.isArray(p.predefined_options) ? p.predefined_options as QuantityOption[] : [],
    isActive: p.is_active !== false,
    sortOrder: toNumber(p.sort_order, 0),
    unit: readString(p.unit, '100g'),
    rating: toNumber(p.rating, 4.7),
    stock: Math.floor(toNumber(p.stock_quantity ?? p.stock, 0)),
    description: readString(p.description),
    descriptionTa: readString(p.description_ta),
    benefits: readString(p.benefits),
    benefitsTa: readString(p.benefits_ta),
    image,
    imageUrl: image,
    hasVariants: Boolean(p.has_variants),

    // POS inventory mapping
    sku: readString(p.sku),
    barcode: readString(p.barcode),
    brand: readString(p.brand),
    purchasePrice: toNumber(p.purchase_price, 0),
    mrp: toNumber(p.mrp, 0),
    gstPercent: toNumber(p.gst_percent, 0),
    openingStock: toNumber(p.opening_stock, 0),
    lowStockAlert: toNumber(p.low_stock_alert, 5),
    supplier: readString(p.supplier),
    size: readString(p.size),
    color: readString(p.color),
  }
}

// --- Product Store ---
// `branch` scopes the fetch to one POS counter's isolated catalog; omitted, it
// returns the combined catalog (used by the public storefront).
let productFetchRequestId = 0
export const useProductStore = create<ProductState>((set, get) => ({
  products: [],
  loading: false,
  error: null,
  lastFetch: 0,
  lastFetchScope: null,
  fetchProducts: async (branch, force = false) => {
    const scope = branch ?? 'all'
    if (!force && scope === get().lastFetchScope && Date.now() - get().lastFetch < 300000 && get().products.length > 0) return
    const requestId = ++productFetchRequestId

    // Switching branch drops the previous branch's catalog immediately, so it
    // can't be shown (or billed) under the new branch while the fetch is in flight.
    set(scope === get().lastFetchScope
      ? { loading: true, error: null }
      : { loading: true, error: null, products: [], lastFetch: 0, lastFetchScope: scope })
    try {
      const [{ data, error }, { data: categoryData }] = await Promise.all([
        fetchAllProducts(branch),
        fetchAllCategories(branch),
      ])

      if (error) throw error

      if (requestId !== productFetchRequestId) return

      const categoriesById = Object.fromEntries(
        (categoryData || []).map(category => [String(category.id), String(category.name_en || '').trim()]),
      )
      const normalized = (data || []).map(product => mapDbProduct(product, categoriesById))

      set({ products: normalized, loading: false, lastFetch: Date.now(), lastFetchScope: scope })
    } catch (err) {
      if (requestId !== productFetchRequestId) return
      set({
        error: err instanceof Error ? err.message : 'Unable to fetch products',
        loading: false,
      })
    }
  },
  refreshProducts: () => {
    const scope = get().lastFetchScope
    if (!scope) return Promise.resolve()
    return get().fetchProducts(scope === 'all' ? undefined : (scope as PosBranch), true)
  },
}))

/** Drops every branch-scoped cache (catalog, variants, low-stock list). Called on logout and
 * whenever the active branch changes so no data from the previous branch can be shown. */
export function resetBranchScopedStores() {
  productFetchRequestId++
  variantFetchRequestId++
  useProductStore.setState({ products: [], loading: false, error: null, lastFetch: 0, lastFetchScope: null })
  useVariantStore.setState({ variantsMap: {}, fetched: false, fetchedScope: null })
  useAlarmStore.getState().setLowStockItems([])
  clearBarcodePreferences() // label settings / custom sizes never carry over to another branch or session
}

// --- Variant Store ---
let variantFetchRequestId = 0
export const useVariantStore = create<VariantStoreState>()((set, get) => ({
  variantsMap: {},
  fetched: false,
  fetchedScope: null,
  fetchVariants: async (branch) => {
    const scope = branch || 'all'
    if (get().fetched && get().fetchedScope === scope) return
    const requestId = ++variantFetchRequestId
    // Switching branch drops the previous branch's variants immediately (never shown under the new branch).
    if (get().fetchedScope !== scope) set({ variantsMap: {}, fetched: false, fetchedScope: scope })
    const { data } = await fetchAllVariants(branch)
    if (requestId !== variantFetchRequestId) return
    const map: Record<string, ProductVariant[]> = {}
    for (const v of data) {
      if (!map[v.productId]) map[v.productId] = []
      map[v.productId].push(v)
    }
    set({ variantsMap: map, fetched: true, fetchedScope: scope })
  },
  refetchVariants: async (branch) => {
    const scope = branch || 'all'
    const requestId = ++variantFetchRequestId
    set(get().fetchedScope !== scope ? { variantsMap: {}, fetched: false, fetchedScope: scope } : { fetched: false, fetchedScope: scope })
    const { data } = await fetchAllVariants(branch)
    if (requestId !== variantFetchRequestId) return
    const map: Record<string, ProductVariant[]> = {}
    for (const v of data) {
      if (!map[v.productId]) map[v.productId] = []
      map[v.productId].push(v)
    }
    set({ variantsMap: map, fetched: true, fetchedScope: scope })
  },
  getVariants: (productId) => get().variantsMap[String(productId)] || [],
  getDefaultVariant: (productId) => {
    const variants = get().variantsMap[String(productId)] || []
    return variants.find(v => v.isDefault) || variants[0] || null
  },
  hasVariants: (productId) => (get().variantsMap[String(productId)] || []).length > 0,
}))

// --- Store Settings State ---
export const useSettingsStore = create<SettingsState>()((set) => ({
  settings: null,
  settingsByBranch: {},
  loading: false,
  fetchSettings: async (branch) => {
    const { role, branch: lockedBranch, activeBranch } = useAdminAuthStore.getState()
    // Staff and manager can only ever read their own branch's settings (the server enforces it), so never file
    // another branch's request under the wrong key; the admin reads whichever branch is asked for.
    if (role && role !== 'admin' && branch && branch !== lockedBranch) return
    const queryBranch: PosBranch = branch ?? (role === 'admin' ? resolveBranch(activeBranch) : lockedBranch ?? 'pos1')
    set({ loading: true })
    {
      let data: Record<string, any> | null = null
      try {
        data = (await api<{ settings: Record<string, any> }>('GET', '/api/settings', { branchId: queryBranch })).settings
      } catch { data = null }
      if (data) {
        // Legacy placeholder identities (CLAD / Chaji / Purple Boutique) seeded by
        // very early migrations are replaced with the Take250 brand
        // constants, so a stale store_settings row can never leak onto an
        // invoice, receipt, WhatsApp message or the admin UI.
        const name = cleanIdentityField(data.name) || BRAND_EN
        const ownerName = cleanIdentityField(data.owner_name) || BRAND_OWNER_NAME
        const phone = cleanIdentityField(data.phone) || BRAND_PHONE_DISPLAY
        const email = cleanIdentityField(data.email) || BRAND_EMAIL
        const address = cleanIdentityField(data.address) || BRAND_ADDRESS
        const resolved: StoreSettings = {
          name,
          ownerName,
          phone,
          email,
          address,
          businessType: data.business_type || '',
          instagramId: data.instagram_id || '',
          logoUrl: data.logo_url || null,
          themeColor: data.theme_color || '#0A0A0A',
          gstEnabled: data.gst_enabled
        }
        set((state) => ({
          settings: resolved,
          settingsByBranch: { ...state.settingsByBranch, [queryBranch]: resolved },
          loading: false
        }))
        return
      }
    }
    // Fallback/Demo settings
    const fallback: StoreSettings = {
      name: BRAND_EN,
      ownerName: BRAND_OWNER_NAME,
      phone: BRAND_PHONE_DISPLAY,
      email: BRAND_EMAIL,
      address: BRAND_ADDRESS,
      businessType: '',
      instagramId: '',
      logoUrl: null,
      themeColor: '#0A0A0A',
      gstEnabled: false
    }
    set((state) => ({
      settings: fallback,
      settingsByBranch: branch ? { ...state.settingsByBranch, [branch]: fallback } : state.settingsByBranch,
      loading: false
    }))
  }
}))

// --- Admin Auth Store ---
export type AdminRole = 'admin' | 'manager' | 'staff' | null
export type PosBranch = 'pos1' | 'pos2' | 'pos3'
export type ActiveBranch = PosBranch | 'all' | null

/** Branch rows as served by /api/auth/me (name, labels and colours are data, so a new branch needs no code). */
export interface BranchInfo {
  id: string
  name: string
  short_label: string
  subtitle: string
  theme_color: string
  logo_url: string
  barcode_prefix: string
  sort_order: number
}
export const useBranchStore = create<{ branches: BranchInfo[]; setBranches: (b: BranchInfo[]) => void }>()((set) => ({
  branches: [],
  setBranches: (branches) => set({ branches }),
}))

/** Normalizes the dashboard's active-branch selection to a concrete branch for
 * branch-scoped queries (defaults to POS 1 when viewing the global 'all' aggregate). */
export const resolveBranch = (activeBranch: ActiveBranch): PosBranch => (activeBranch === 'pos2' || activeBranch === 'pos3' ? activeBranch : 'pos1')

interface AdminAuthState {
  isLoggedIn: boolean
  role: AdminRole
  adminId: string | null
  /** Staff: the single branch they're locked to. Admin: null (they can view any branch). */
  branch: PosBranch | null
  /** What the dashboard is currently showing: a specific branch, or 'all' (admin global view). */
  activeBranch: ActiveBranch
  /** Passcode-only sign in. Throws ApiClientError (message is safe to show) when the passcode is wrong or throttled. */
  login: (passcode: string) => Promise<AdminRole>
  logout: () => void
  /** Re-checks the server session (httpOnly cookie) on page load; clears the local session if it is gone. */
  restoreSession: () => Promise<void>
  /** Local-only sign out (the server already says the session is invalid). */
  expireSession: () => void
  setActiveBranch: (branch: ActiveBranch) => void
}

export const useAdminAuthStore = create<AdminAuthState>()(
  persist(
    (set, get) => ({
      isLoggedIn: false,
      role: null,
      adminId: null,
      branch: null,
      activeBranch: null,
      login: async (passcode: string) => {
        const res = await api<{ role: Exclude<AdminRole, null>; branch: PosBranch | null }>('POST', '/api/auth/login', { body: { passcode } })
        resetBranchScopedStores()
        useSettingsStore.setState({ settings: null, settingsByBranch: {} })
        useAlarmStore.getState().resetSilencedState()
        set({ isLoggedIn: true, role: res.role, adminId: res.role, branch: res.branch, activeBranch: res.role === 'admin' ? 'all' : res.branch })
        try {
          const me = await api<{ branches: BranchInfo[] }>('GET', '/api/auth/me')
          useBranchStore.getState().setBranches(me.branches)
        } catch { /* labels fall back to the built-in ones */ }
        return res.role
      },
      logout: () => {
        void api('POST', '/api/auth/logout').catch(() => undefined) // clears the httpOnly cookie
        get().expireSession()
      },
      expireSession: () => {
        alarmSound.stopAlert()
        useAlarmStore.getState().resetSilencedState()
        resetBranchScopedStores()
        useSettingsStore.setState({ settings: null, settingsByBranch: {} })
        useBranchStore.getState().setBranches([])
        set({ isLoggedIn: false, role: null, adminId: null, branch: null, activeBranch: null })
      },
      restoreSession: async () => {
        if (!get().isLoggedIn) return
        try {
          const me = await api<{ role: Exclude<AdminRole, null>; branch: PosBranch | null; branches: BranchInfo[] }>('GET', '/api/auth/me')
          useBranchStore.getState().setBranches(me.branches)
          // the server is the source of truth for role and branch
          if (me.role !== get().role || me.branch !== get().branch) {
            resetBranchScopedStores()
            set({ role: me.role, branch: me.branch, adminId: me.role, activeBranch: me.role === 'admin' ? 'all' : me.branch })
          }
        } catch {
          // apiClient already expired the session on a 401; a network error leaves the local session for a retry
        }
      },
      setActiveBranch: (branch: ActiveBranch) => {
        const { role, branch: staffBranch } = get()
        // Staff and managers cannot leave their assigned branch or view the global aggregate; only the admin switches.
        if (role !== 'admin') {
          if (staffBranch) set({ activeBranch: staffBranch })
          return
        }
        if (branch !== get().activeBranch) resetBranchScopedStores()
        set({ activeBranch: branch })
      },
    }),
    {
      name: 'yg-enterprises-admin-session',
      // Using sessionStorage so the session is cleared when the tab is closed
      storage: {
        getItem: (name) => {
          const str = sessionStorage.getItem(name)
          if (!str) return null
          return JSON.parse(str)
        },
        setItem: (name, value) => {
          sessionStorage.setItem(name, JSON.stringify(value))
        },
        removeItem: (name) => {
          sessionStorage.removeItem(name)
        }
      }
    }
  )
)
