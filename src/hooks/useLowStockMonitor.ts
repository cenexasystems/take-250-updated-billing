import { useEffect, useRef } from 'react'
import { api } from '../lib/apiClient'
import { useAlarmStore, type LowStockItem } from '../store/alarmStore'
import { useBranchStore, type PosBranch } from '../store/store'
import { alarmSound } from '../lib/alarmAudio'

/**
 * @param branch  Only products/variants of this branch raise the alarm ('pos1' | 'pos2').
 *                 Pass null for the admin's all-branches view.
 */
export function useLowStockMonitor(enabled: boolean = true, role?: string | null, branch?: PosBranch | null) {
  const setLowStockItems = useAlarmStore((state) => state.setLowStockItems)
  const isCheckingRef = useRef(false)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const branchRef = useRef(branch)
  branchRef.current = branch

  const checkStockLevels = async (force: boolean = false) => {
    if (!enabled || (isCheckingRef.current && !force)) return
    isCheckingRef.current = true

    try {
      // The branch being watched. The admin's all-branches view checks every branch (one call each, validated by the
      // server); staff and manager always get their own branch from the session.
      const checkedBranch = branchRef.current
      const allBranchIds = useBranchStore.getState().branches.map((b) => b.id as PosBranch)
      const targets: Array<PosBranch | undefined> = checkedBranch
        ? [checkedBranch]
        : role === 'admin' ? (allBranchIds.length ? allBranchIds : (['pos1', 'pos2', 'pos3'] as PosBranch[])) : [undefined]
      const results = await Promise.all(targets.map((b) =>
        api<{ products: Array<Record<string, any>>; variants: Array<Record<string, any>> }>('GET', '/api/inventory/low-stock', { branchId: b })
          .catch((err) => { console.warn('Low stock check warning:', err); return { products: [], variants: [] } })))
      const prods = results.flatMap((r) => r.products)
      const variants = results.flatMap((r) => r.variants)

      const flagged: LowStockItem[] = []

      // Check standard products (Only alert for actual inventory running low: 0 < stock <= threshold)
      for (const p of prods || []) {
        if (
          (p.category && p.category.trim().toLowerCase() === 'unregistered') ||
          p.category_id === 4
        ) {
          continue
        }
        const threshold = Number(p.low_stock_alert) > 0 ? Number(p.low_stock_alert) : 5
        const currentStock = Number(p.stock_quantity) || 0

        // Alert for products running low or out of stock (currentStock <= threshold)
        if (currentStock <= threshold) {
          flagged.push({
            id: `p-${p.id}`,
            name: p.name,
            stock: currentStock,
            alertThreshold: threshold,
            barcode: p.barcode,
            category: p.category,
          })
        }
      }

      // Check product variants (alert for variants running low or out of stock)
      for (const v of variants || []) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parentProd = v.products as any
        if (parentProd && parentProd.is_active === false) {
          continue
        }
        if (
          (parentProd?.category && parentProd.category.trim().toLowerCase() === 'unregistered') ||
          parentProd?.category_id === 4
        ) {
          continue
        }

        const threshold = 5
        const currentStock = Number(v.stock) || 0

        if (currentStock <= threshold) {
          flagged.push({
            id: `v-${v.id}`,
            name: parentProd?.name ? `${parentProd.name}` : 'Product Variant',
            variantName: v.variant_name,
            stock: currentStock,
            alertThreshold: threshold,
            barcode: v.barcode,
            category: parentProd?.category,
          })
        }
      }

      // A check that was in flight during logout must not restart the alarm
      if (!enabledRef.current || branchRef.current !== checkedBranch) return
      setLowStockItems(flagged)
    } catch (err) {
      console.warn('Stock monitor error:', err)
    } finally {
      isCheckingRef.current = false
    }
  }

  useEffect(() => {
    if (!enabled) {
      // Logged out (or lost staff/admin access): silence any ringing alarm and clear state
      alarmSound.stopAlert()
      useAlarmStore.setState({ lowStockItems: [], isAlarmActive: false, silencedItemIds: new Set() })
      return
    }

    // Immediately unblock and run fresh stock check on login or role switch
    isCheckingRef.current = false
    void checkStockLevels(true)

    // 15-second interval continuous stock monitor
    // Polling replaces the old realtime subscription: every 15 s while the tab is visible, and once more the
    // moment the tab becomes visible again. Each check only reads this branch's stock.
    const interval = setInterval(() => {
      if (!document.hidden) void checkStockLevels()
    }, 15000)
    const onVisible = () => { if (!document.hidden) void checkStockLevels(true) }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, role, branch])

  // Re-check stock levels when enabled changes from false to true (e.g., on login)
  useEffect(() => {
    if (enabled && !isCheckingRef.current) {
      isCheckingRef.current = false
      void checkStockLevels(true)
    }
  }, [enabled])
}
