import { create } from 'zustand'

export type DashboardTab =
  | 'billing'
  | 'pos'
  | 'inventory'
  | 'advance_orders'
  | 'expenses'
  | 'history'
  | 'pos_analytics'
  | 'coupons'
  | 'whatsapp'
  | 'products'
  | 'categories'
  | 'users'
  | 'overview'
  | 'branch_hub'
  | 'business_overview'
  | 'cross_branch_sales'
  | 'consolidated_stock'
  | 'staff_memberships'
  | 'business_reports'
  | 'attendance'
  | 'store_settings'

interface NavigationState {
  currentTab: DashboardTab
  setCurrentTab: (tab: DashboardTab) => void
}

export const useNavigationStore = create<NavigationState>((set) => ({
  currentTab: 'billing',
  setCurrentTab: (tab) => set({ currentTab: tab }),
}))
