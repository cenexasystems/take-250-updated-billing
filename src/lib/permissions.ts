/**
 * UI permission config: the single place that says what each portal may see and do.
 * Mirrors docs/ROLE_MATRIX.md and the server's permission table (server/lib/permissions.ts); the API enforces the
 * same rules, so hiding something here is convenience, never security. scripts/test-api.ts checks that the two
 * tables agree.
 *
 *  admin   original admin: all branches, global views, analytics, passcode management
 *  manager original admin powers locked to ONE branch; no analytics, no passcode management, no cross-branch views
 *  staff   original staff permissions, locked to one branch
 */
export type Role = 'admin' | 'manager' | 'staff'
export const ROLES: Role[] = ['admin', 'manager', 'staff']

export type TabKey =
  | 'overview' | 'whatsapp' | 'pos_analytics' | 'billing' | 'advance_orders' | 'inventory' | 'expenses' | 'products' | 'categories'
  | 'coupons' | 'users' | 'history' | 'branch_hub' | 'business_overview' | 'cross_branch_sales' | 'consolidated_stock'
  | 'staff_memberships' | 'business_reports' | 'barcode_hub' | 'attendance' | 'store_settings'

/** Tabs the original hid even from the admin (ADMIN_REMOVED_TABS): nobody gets them. */
export const REMOVED_TABS: TabKey[] = ['branch_hub', 'categories', 'attendance', 'barcode_hub', 'cross_branch_sales', 'consolidated_stock', 'business_reports']

/** Who may open each tab. Removed tabs are listed with an empty role list except branch_hub (the original staff landing tile page). */
export const TAB_ACCESS: Record<TabKey, Role[]> = {
  billing: ['admin', 'manager', 'staff'],
  inventory: ['admin', 'manager', 'staff'],
  advance_orders: ['admin', 'manager', 'staff'],
  history: ['admin', 'manager', 'staff'],
  branch_hub: ['staff'],
  expenses: ['admin', 'manager'],
  coupons: ['admin', 'manager'],
  store_settings: ['admin', 'manager'],
  whatsapp: ['admin', 'manager'],
  products: ['admin', 'manager'],
  overview: ['admin', 'manager'],
  users: [], // customer-user list: no endpoint (default deny)
  // Admin only: analytics, passcodes, cross-branch
  pos_analytics: ['admin'],
  staff_memberships: ['admin'],
  business_overview: ['admin'],
  // removed in the original for everyone
  categories: [], attendance: [], barcode_hub: [], cross_branch_sales: [], consolidated_stock: [], business_reports: [],
}

/** Sidebar order (the original's), per portal. Manager = admin's list minus the Analytics Dashboard. */
export const NAV_ORDER: Record<Role, TabKey[]> = {
  admin: ['billing', 'inventory', 'expenses', 'advance_orders', 'history', 'pos_analytics', 'coupons', 'store_settings'],
  manager: ['billing', 'inventory', 'expenses', 'advance_orders', 'history', 'coupons', 'store_settings'],
  staff: ['branch_hub', 'billing', 'inventory', 'advance_orders', 'history'],
}
export const GLOBAL_NAV: TabKey[] = ['business_overview', 'staff_memberships']

export type Feature =
  | 'inventory.delete' | 'orders.status' | 'orders.delete' | 'settings.write' | 'coupons.manage'
  | 'branch.switch' | 'passcodes.manage' | 'analytics.view' | 'global.view' | 'expenses.use'

export const FEATURE_ACCESS: Record<Feature, Role[]> = {
  'inventory.delete': ['admin', 'manager'],
  'orders.status': ['admin', 'manager'],
  'orders.delete': ['admin', 'manager'],
  'settings.write': ['admin', 'manager'],
  'coupons.manage': ['admin', 'manager'],
  'expenses.use': ['admin', 'manager'],
  'branch.switch': ['admin'],
  'passcodes.manage': ['admin'],
  'analytics.view': ['admin'],
  'global.view': ['admin'],
}

/** Each UI feature and the server permission key that guards its API call (checked by the API tests). */
export const FEATURE_SERVER_PERM: Record<Feature, string[]> = {
  'inventory.delete': ['inventory.delete'],
  'orders.status': ['orders.status', 'orders.cancel'],
  'orders.delete': ['orders.delete'],
  'settings.write': ['settings.write'],
  'coupons.manage': ['coupons.write', 'coupons.read'],
  'expenses.use': ['expenses.read', 'expenses.write'],
  'branch.switch': [],
  'passcodes.manage': ['passcodes.list', 'passcodes.change', 'lockouts.clear'],
  'analytics.view': ['analytics.read'],
  'global.view': ['global.read'],
}

export const canOpenTab = (role: Role | null, tab: TabKey): boolean => !!role && TAB_ACCESS[tab].includes(role)
export const can = (role: Role | null, feature: Feature): boolean => !!role && FEATURE_ACCESS[feature].includes(role)
/** Admin or Manager: the original "admin powers" (delete, status change, settings...). Manager stays branch-locked. */
export const hasAdminPowers = (role: Role | null): boolean => role === 'admin' || role === 'manager'
export const roleLabel = (role: Role | null): string => (role === 'admin' ? 'ADMIN' : role === 'manager' ? 'MANAGER' : 'STAFF')
