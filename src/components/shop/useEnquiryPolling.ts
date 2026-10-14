import { useEffect } from 'react'
import { api } from '../../lib/apiClient'
import { alarmSound } from '../../lib/alarmAudio'
import { useShopAlertStore, type FreshEnquiry } from '../../store/shopAlertStore'

const INTERVAL_MS = 12_000 // same rhythm as the change polling (paused while the tab is hidden)

/**
 * Admin only: polls for new online-shop requests of ANY branch. A new one shows this popup (the low-stock alarm's style
 * and sound, with the same "Tap for Sound" unlock) and bumps the sidebar badge. Acknowledging stops the sound; "Open"
 * goes to the Enquiry dashboard on that request. Works only while an Admin session is open in a browser tab.
 */
export function useEnquiryPolling(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let since: string | null = null
    let first = true
    let inFlight = false
    const poll = async () => {
      if (cancelled || inFlight || document.hidden) return
      inFlight = true
      try {
        const res = await api<{ new_count: number; latest: string | null; fresh: FreshEnquiry[] }>('GET', '/api/shop-admin/enquiries/pulse', { query: since ? { since } : {} })
        if (cancelled) return
        useShopAlertStore.getState().setNewCount(res.new_count)
        if (!first && res.fresh.length) {
          useShopAlertStore.getState().addPopup(res.fresh)
          alarmSound.startAlert()
        }
        // the newest request's exact time (or, with none yet, the beginning): the next poll reports only what came after it
        since = res.latest || since || '1970-01-01T00:00:00Z'
        first = false
      } catch { /* offline / signed out: the next tick tries again */ }
      finally { inFlight = false }
    }
    void poll()
    const t = window.setInterval(() => void poll(), INTERVAL_MS)
    const onVisible = () => { if (!document.hidden) void poll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { cancelled = true; window.clearInterval(t); document.removeEventListener('visibilitychange', onVisible) }
  }, [enabled])
}
