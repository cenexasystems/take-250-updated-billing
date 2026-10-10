import type { Role } from './auth.js'

/**
 * CENTRAL PERMISSION TABLE. Every route declares one key from here; a route whose key is missing
 * cannot be registered (default deny). Derived from docs/ROLE_MATRIX.md (approved).
 *
 *  scope 'branch'  -> handler runs against ONE branch: the token's branch for manager/staff,
 *                     the validated ?branch_id= selector for admin.
 *  scope 'global'  -> all-branches data, admin only.
 *  scope 'none'    -> not branch data.
 */
export type Scope = 'branch' | 'global' | 'none'
export type Allowed = Role[] | 'public'

const A: Role[] = ['admin']
const AM: Role[] = ['admin', 'manager']
const AMS: Role[] = ['admin', 'manager', 'staff']

export const PERMISSIONS = {
  // session
  'auth.login':            { roles: 'public' as Allowed, scope: 'none' as Scope },
  'auth.logout':           { roles: 'public' as Allowed, scope: 'none' as Scope },
  'auth.me':               { roles: AMS, scope: 'none' as Scope },
  'branches.read':         { roles: AMS, scope: 'none' as Scope },
  // admin only: passcode management (matrix row 28)
  'passcodes.list':        { roles: A, scope: 'none' as Scope },
  'passcodes.change':      { roles: A, scope: 'none' as Scope },
  'lockouts.clear':        { roles: A, scope: 'none' as Scope },
  // store settings (rows 24, 25)
  'settings.read':         { roles: AMS, scope: 'branch' as Scope },
  'settings.write':        { roles: AM, scope: 'branch' as Scope },
  // catalog (rows 3, 4, 6). Staff only READS the catalog (the POS needs it to sell); creating / editing products, variants and
  // categories is Admin / Manager. categories.create is the inline "add category" inside product forms.
  'categories.read':       { roles: AMS, scope: 'branch' as Scope },
  'categories.create':     { roles: AM, scope: 'branch' as Scope },
  'categories.manage':     { roles: AM, scope: 'branch' as Scope },
  'products.read':         { roles: AMS, scope: 'branch' as Scope },
  'products.write':        { roles: AM, scope: 'branch' as Scope },
  'variants.read':         { roles: AMS, scope: 'branch' as Scope },
  'variants.write':        { roles: AM, scope: 'branch' as Scope },
  // inventory (rows 5, 7, 8, 9): stock list, ledger, adjust, price edits, receive stock are Admin / Manager only.
  // inventory.alerts is the ONE narrow read Staff keeps: name, quantity and threshold of low-stock items, nothing else.
  'inventory.read':        { roles: AM, scope: 'branch' as Scope },
  'inventory.alerts':      { roles: AMS, scope: 'branch' as Scope },
  'inventory.adjust':      { roles: AM, scope: 'branch' as Scope },
  'inventory.delete':      { roles: AM, scope: 'branch' as Scope },
  // barcodes (rows 10-13): Staff keeps only the POS scan lookup; list, label data, generate, receive stock, register are Admin / Manager.
  'barcodes.lookup':       { roles: AMS, scope: 'branch' as Scope },
  'barcodes.read':         { roles: AM, scope: 'branch' as Scope },
  'barcodes.write':        { roles: AM, scope: 'branch' as Scope },
  // POS + coupons (rows 15-17)
  'pos.sale':              { roles: AMS, scope: 'branch' as Scope },
  'pos.unregistered':      { roles: AMS, scope: 'branch' as Scope },
  'coupons.lookup':        { roles: AMS, scope: 'branch' as Scope },
  'coupons.read':          { roles: AM, scope: 'branch' as Scope },
  'coupons.write':         { roles: AM, scope: 'branch' as Scope },
  // orders (rows 18-20)
  'orders.read':           { roles: AMS, scope: 'branch' as Scope },
  'orders.status':         { roles: AMS, scope: 'branch' as Scope },
  'orders.delete':         { roles: AM, scope: 'branch' as Scope },
  'orders.cancel':         { roles: AMS, scope: 'branch' as Scope },
  // advance orders (row 21)
  'advance.read':          { roles: AMS, scope: 'branch' as Scope },
  'advance.write':         { roles: AMS, scope: 'branch' as Scope },
  'advance.delete':        { roles: AM, scope: 'branch' as Scope },
  // expenses (row 23)
  'expenses.read':         { roles: AM, scope: 'branch' as Scope },
  'expenses.write':        { roles: AM, scope: 'branch' as Scope },
  // analytics dashboard data (row 22): admin only
  'analytics.read':        { roles: A, scope: 'branch' as Scope },
  // cross-branch views (row 29): admin only
  'global.read':           { roles: A, scope: 'global' as Scope },
  // uploads (rows 32-34)
  'uploads.product-images': { roles: AM, scope: 'branch' as Scope }, // only product forms upload these
  'uploads.invoices':      { roles: AMS, scope: 'branch' as Scope },
  'uploads.branding':      { roles: AM, scope: 'branch' as Scope },
  'uploads.avatars':       { roles: AM, scope: 'branch' as Scope },
  // polling replacement for realtime (row 36)
  'poll.stamps':           { roles: AMS, scope: 'branch' as Scope },
  // deploy smoke test / uptime monitor: DB ping + missing setting NAMES only, never a secret
  'health.check':          { roles: 'public' as Allowed, scope: 'none' as Scope },
  // public invoice lookup (row 35): rate limited, no auth
  'public.invoice':        { roles: 'public' as Allowed, scope: 'none' as Scope },
} as const

export type PermKey = keyof typeof PERMISSIONS
export const permOf = (k: PermKey): { roles: Allowed; scope: Scope } => PERMISSIONS[k]
