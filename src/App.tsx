import './index.css'
import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuthStore, useProductStore, useVariantStore, useAdminAuthStore, useSettingsStore, resolveBranch } from './store/store'
import { BRAND_EN } from './lib/brand'
import { hasAdminPowers } from './lib/permissions'
import { clearLocalOrders } from './lib/ordersFallback'
import { isSupabaseConfigured, supabase } from './lib/supabase'
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
const Login = lazyWithRetry(() => import('./pages/Login'))
const AdminLogin = lazyWithRetry(() => import('./pages/AdminLogin'))

function LoadingSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bgMain">
      <span className="h-10 w-10 animate-spin rounded-full border-4 border-[#E5E7EB] border-t-[#D4AF37]" />
    </div>
  )
}

function PublicOnlyRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((state) => state.user)
  const loading = useAuthStore((state) => state.loading)

  if (loading) return <LoadingSpinner />
  return user ? <Navigate to="/dashboard" replace /> : <>{children}</>
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
  const initialize = useAuthStore((state) => state.initialize)
  const fetchProducts = useProductStore((state) => state.fetchProducts)
  const refreshProducts = useProductStore((state) => state.refreshProducts)
  const fetchVariants = useVariantStore((state) => state.fetchVariants)
  const { isLoggedIn, role, activeBranch, branch: staffBranch } = useAdminAuthStore()
  const fetchSettings = useSettingsStore((state) => state.fetchSettings)
  const settingsByBranch = useSettingsStore((state) => state.settingsByBranch)

  const isLoginRoute = location.pathname === '/admin-login' || location.pathname === '/login'
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
    void fetchSettings('pos1')
    void fetchSettings('pos2')
  }, [fetchSettings])

  useEffect(() => {
    applyActiveTheme(activeBranch, role, settingsByBranch, staffBranch)
  }, [activeBranch, role, settingsByBranch, staffBranch])

  useEffect(() => {
    if (!isSupabaseConfigured) {
      void initialize()
      return
    }

    clearLocalOrders()

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
        void initialize()
      }
    })

    void initialize()

    return () => subscription.unsubscribe()
  }, [initialize])

  // The product/variant stores are shared by every page, and every page shows a
  // single POS branch, so they must only ever hold one branch's catalog.
  const catalogBranch = hasStaffOrAdminAccess ? resolveBranch(activeBranch) : null

  useEffect(() => {
    if (!catalogBranch) return
    void fetchProducts(catalogBranch)
    void fetchVariants(catalogBranch)
  }, [catalogBranch, fetchProducts, fetchVariants])

  useEffect(() => {
    if (!isSupabaseConfigured) {
      return
    }

    const productChannel = supabase
      .channel('admin-products-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => {
        void refreshProducts()
      })
      .subscribe()

    return () => {
      void supabase.removeChannel(productChannel)
    }
  }, [refreshProducts])

  return (
    <div className="ios-app-shell w-full max-w-[100vw] bg-bgMain print:block print:h-auto print:overflow-visible">
      <main className="h-full print:block print:h-auto print:min-h-0 print:overflow-visible">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route
            path="/login"
            element={
              <PublicOnlyRoute>
                <Suspense fallback={<LoadingSpinner />}>
                  <Login />
                </Suspense>
              </PublicOnlyRoute>
            }
          />
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

