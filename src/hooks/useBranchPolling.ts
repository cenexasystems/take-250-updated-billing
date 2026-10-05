import { useEffect, useRef } from 'react'
import { api } from '../lib/apiClient'
import { useAdminAuthStore } from '../store/store'

/** Tables the server reports a change stamp for (see GET /api/poll/stamps). */
export type StampTable =
  | 'products' | 'product_variants' | 'categories' | 'coupons' | 'orders' | 'advance_orders'
  | 'store_settings' | 'expenses' | 'inventory_movements' | 'barcode_registry'

type Stamps = Record<string, { count: number; last: string | null }>

const DEFAULT_INTERVAL_MS = 12_000 // inside the 10-15 s window

/**
 * Polling that replaces the realtime subscriptions. Every ~12 s it asks the server for the change stamps of ONE
 * branch (an admin names the branch being worked in; staff and manager always get their own from the session),
 * and calls `onChange` with the tables whose stamp moved since the last poll.
 *
 *  - paused while the browser tab is hidden, and checked immediately when it becomes visible again
 *  - keyed by branch: switching branch (or logging out / in) throws the old baseline away, so a stamp of one
 *    branch is never compared with another's and no change is ever reported from a stale branch
 *  - the first poll for a branch only records the baseline (the screen has just loaded its own data)
 */
export function useBranchPolling(
  branch: string | null | undefined,
  tables: StampTable[],
  onChange: (changed: StampTable[]) => void,
  options: { enabled?: boolean; intervalMs?: number } = {},
) {
  const { enabled = true, intervalMs = DEFAULT_INTERVAL_MS } = options
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const tablesRef = useRef(tables)
  tablesRef.current = tables
  const sessionKey = useAdminAuthStore((s) => `${s.isLoggedIn}:${s.role}:${s.branch}`)

  useEffect(() => {
    if (!enabled || !branch) return
    let cancelled = false
    let baseline: Stamps | null = null
    let inFlight = false

    const poll = async () => {
      if (cancelled || inFlight || document.hidden) return
      inFlight = true
      try {
        const res = await api<{ stamps: Stamps }>('GET', '/api/poll/stamps', { branchId: branch })
        if (cancelled) return // the branch / session changed while this request was in flight: drop its answer
        if (baseline) {
          const changed = tablesRef.current.filter((t) => {
            const a = baseline![t]
            const b = res.stamps[t]
            return !!b && (!a || a.count !== b.count || a.last !== b.last)
          })
          if (changed.length) onChangeRef.current(changed)
        }
        baseline = res.stamps
      } catch {
        // offline or session ended: the next tick tries again (a 401 already signs the app out)
      } finally {
        inFlight = false
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), intervalMs)
    const onVisible = () => { if (!document.hidden) void poll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [branch, enabled, intervalMs, sessionKey])
}
