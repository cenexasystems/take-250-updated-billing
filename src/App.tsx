import './index.css'
import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useProductStore, useVariantStore, useAdminAuthStore, useSettingsStore, useBranchStore, resolveBranch, type PosBranch } from './store/store'
import { BRAND_EN } from './lib/brand'
import { hasAdminPowers } from './lib/permissions'
import { useBranchPolling } from './hooks/useBranchPolling'
import { LowStockAlarmModal } from './components/dashboard/LowStockAlarmModal'
import { useLowStockMonitor } from './hooks/useLowStockMonitor'
import { applyActiveTheme } from './lib/branchTheme'

function lazyWithRetry<T extends React.ComponentType<any>>(
  factory: () => Promise<{ default: T }>
) {
  return lazy(async () => {
    try {
      return await factory()
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (
        errMsg.includes('Failed to fetch dynamically imported module') ||
        errMsg.includes('Importing a module script failed') ||
        errMsg.includes('MIME type') ||
        errMsg.includes('error loading dynamically imported module')
      ) {
        const lastReload = sessionStorage.getItem('chunk_reload_ts')
        const now = Date.now()
        if (!lastReload || now - Number(lastReload) > 10000) {
          sessionStorage.setItem('chunk_reload_ts', String(now))
          window.location.reload()
          return new Promise(() => {}) // Hold suspense while reloading
        }
      }
      throw err
    }
  })
}

const Dashboard = lazyWithRetry(() => import('./pages/Dashboard'))
const Pos = lazyWithRetry(() => import('./pages/Pos'))
const DigitalInvoice = lazyWithRetry(() => import('./pages/DigitalInvoice'))
const AdminLogin = lazyWithRetry(() => import('./pages/AdminLogin'))

function LoadingSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bgMain">
      <span className="h-10 w-10 animate-spin rounded-full border-4 border-[#E5E7EB] border-t-[#D4AF37]" />
    </div>
  )
}

function AdminGuard({ children }: { children: React.ReactNode }) {
  const { isLoggedIn, role } = useAdminAuthStore()
  const location = useLocation()
  if (!isLoggedIn || (role !== 'admin' && role !== 'manager' && role !== 'staff')) {
    return <Navigate to="/admin-login" state={{ from: location }} replace />
  }
  return <>{children}</>
}

function AdminOnlyGuard({ children }: { children: React.ReactNode }) {
  const { isLoggedIn, role } = useAdminAuthStore()
  const location = useLocation()
  if (!isLoggedIn) {
    return <Navigate to="/admin-login" state={{ from: location }} replace />
  }
  if (role !== 'admin') {
    return <Navigate to="/dashboard" replace />
  }
  return <>{children}</>
}

/** Admin or Manager (the original admin powers); Staff go back to the dashboard. */
function AdminOrManagerGuard({ children }: { children: React.ReactNode }) {
  const { isLoggedIn, role } = useAdminAuthStore()
  const location = useLocation()
  if (!isLoggedIn) {
    return <Navigate to="/admin-login" state={{ from: location }} replace />
  }
  if (!hasAdminPowers(role)) {
    return <Navigate to="/dashboard" replace />
  }
  return <>{children}</>
}

function PosGuard({ children }: { children: React.ReactNode }) {
  const { isLoggedIn } = useAdminAuthStore()
  const location = useLocation()
  if (!isLoggedIn) {
    return <Navigate to="/admin-login" state={{ from: location }} replace />
  }
  return <>{children}</>
}

function AppShell() {
  const location = useLocation()
  const fetchProducts = useProductStore((state) => state.fetchProducts)
  const fetchVariants = useVariantStore((state) => state.fetchVariants)
  const refreshProducts = useProductStore((state) => state.refreshProducts)
  const refetchVariants = useVariantStore((state) => state.refetchVariants)
  const { isLoggedIn, role, activeBranch, branch: staffBranch } = useAdminAuthStore()
  const fetchSettings = useSettingsStore((state) => state.fetchSettings)
  const settingsByBranch = useSettingsStore((state) => state.settingsByBranch)
  const branchRows = useBranchStore((state) => state.branches)

  const isLoginRoute = location.pathname === '/admin-login'
  const hasStaffOrAdminAccess = Boolean(isLoggedIn && (role === 'admin' || role === 'manager' || role === 'staff') && !isLoginRoute)
  // Alarm only for the branch being worked in (all branches in the admin's global view)
  useLowStockMonitor(hasStaffOrAdminAccess, role, activeBranch && activeBranch !== 'all' ? activeBranch : null)

  useEffect(() => {
    document.title = BRAND_EN
  }, [])

  // The session is an httpOnly cookie: confirm it is still valid (and which portal it opens) when the app loads.
  useEffect(() => {
    void useAdminAuthStore.getState().restoreSession()
  }, [])

  // Load both branches' Appearance colors once so the picked color themes
  // that branch's admin UI everywhere (sidebar, Branch Hub, global aggregate
  // pages) rather than just the Store Settings preview card.
  useEffect(() => {
    if (!isLoggedIn) return
    const ids: PosBranch[] = role === 'admin'
      ? (branchRows.length ? branchRows.map((b) => b.id as PosBranch) : ['pos1', 'pos2', 'pos3'])
      : staffBranch ? [staffBranch] : []
    ids.forEach((id) => void fetchSettings(id))
  }, [fetchSettings, isLoggedIn, role, staffBranch, branchRows])

  useEffect(() => {
    applyActiveTheme(activeBranch, role, settingsByBranch, staffBranch)
  }, [activeBranch, role, settingsByBranch, staffBranch])

  // The product/variant stores are shared by every page, and every page shows a
  // single POS branch, so they must only ever hold one branch's catalog.
  const catalogBranch = hasStaffOrAdminAccess ? resolveBranch(activeBranch) : null

  useEffect(() => {
    if (!catalogBranch) return
    void fetchProducts(catalogBranch)
    void fetchVariants(catalogBranch)
  }, [catalogBranch, fetchProducts, fetchVariants])

  // Polling (every ~12 s, paused while the tab is hidden) replaces the realtime products subscription of the original.
  // It reads the change stamps of the ONE branch on screen; switching branch starts a fresh baseline.
  useBranchPolling(catalogBranch, ['products', 'product_variants'], (changed) => {
    if (changed.includes('products')) void refreshProducts()
    if (changed.includes('product_variants') && catalogBranch) void refetchVariants(catalogBranch)
  }, { enabled: hasStaffOrAdminAccess })

  return (
    <div className="ios-app-shell w-full max-w-[100vw] bg-bgMain print:block print:h-auto print:overflow-visible">
      <main className="h-full print:block print:h-auto print:min-h-0 print:overflow-visible">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route
            path="/admin-login"
            element={
              <Suspense fallback={<LoadingSpinner />}>
                <AdminLogin />
              </Suspense>
            }
          />
          {/* Common Admin & Staff Portal Routes */}
          <Route
            element={
              <AdminGuard>
                <Suspense fallback={<LoadingSpinner />}>
                  <Dashboard />
                </Suspense>
              </AdminGuard>
            }
          >
            <Route path="/admin" element={<Dashboard />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/advance-orders" element={<Dashboard />} />
          </Route>

          {/* Admin + Manager Dedicated Routes (Manager is branch-locked) */}
          <Route
            element={
              <AdminOrManagerGuard>
                <Suspense fallback={<LoadingSpinner />}>
                  <Dashboard />
                </Suspense>
              </AdminOrManagerGuard>
            }
          >
            <Route path="/whatsapp-center" element={<Dashboard />} />
            <Route path="/expenses" element={<Dashboard />} />
            <Route path="/dashboard/expenses" element={<Dashboard />} />
          </Route>

          {/* Admin-Only Dedicated Routes: Analytics Dashboard */}
          <Route
            element={
              <AdminOnlyGuard>
                <Suspense fallback={<LoadingSpinner />}>
                  <Dashboard />
                </Suspense>
              </AdminOnlyGuard>
            }
          >
            <Route path="/pos-analytics" element={<Dashboard />} />
          </Route>
          <Route
            path="/pos"
            element={
              <PosGuard>
                <Suspense fallback={<LoadingSpinner />}>
                  <Pos />
                </Suspense>
              </PosGuard>
            }
          />
          <Route
            path="/invoice/:id"
            element={
              <Suspense fallback={<LoadingSpinner />}>
                <DigitalInvoice />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>

      {/* Global Low Stock Sound & Visual Alarm for Admin and Staff Panels */}
      {hasStaffOrAdminAccess && <LowStockAlarmModal />}
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  )
}

