import { useEffect, useState } from 'react'
import { api } from './apiClient'
import { canonicalPhone } from './phone'
import type { PosBranch } from '../store/store'

// POS phone suggestions: helpers and the hook behind components/pos/CustomerSuggestions.tsx

export type CustomerSuggestion = { phone: string; name: string | null }

/** The digits typed so far as the start of a mobile (+91 / 91 / 0 in front dropped); same rule as the server. */
export function phonePrefix(raw: string): string {
  let d = raw.replace(/\D/g, '')
  if ((/^\s*\+/.test(raw) || d.length > 10) && d.startsWith('91')) d = d.slice(2)
  return d.replace(/^0+/, '')
}

/** A counter placeholder ("Customer", "Walk-in Customer") is not a name to fill in. */
export const isRealName = (name?: string | null): name is string =>
  !!name && name.trim() !== '' && !/^(walk[- ]?in )?customer$/i.test(name.trim())

// one answer per branch + prefix for this page view (the POS shows the phone in two places)
const cache = new Map<string, CustomerSuggestion[]>()
export const clearCustomerSuggestCache = () => cache.clear()

/** From the 4th digit until the number is complete: this branch's customers whose number starts with it (debounced). */
export function useCustomerSuggestions(phone: string, branch: PosBranch, enabled: boolean): CustomerSuggestion[] {
  const prefix = phonePrefix(phone)
  const active = enabled && prefix.length >= 4 && !canonicalPhone(phone)
  const key = active ? `${branch}:${prefix}` : ''
  const [result, setResult] = useState<{ key: string; rows: CustomerSuggestion[] } | null>(null)
  const cached = active ? cache.get(key) : undefined
  useEffect(() => {
    if (!active || cache.has(key)) return
    let live = true
    const t = setTimeout(() => {
      api<{ customers: CustomerSuggestion[] }>('POST', '/api/customers/suggest', { body: { phone: prefix }, branchId: branch })
        .then((r) => { cache.set(key, r.customers); if (live) setResult({ key, rows: r.customers }) })
        .catch(() => { if (live) setResult(null) }) // rate limited / offline: no list rather than a wrong one
    }, 250)
    return () => { live = false; clearTimeout(t) }
  }, [active, key, prefix, branch])
  if (!active) return []
  return cached ?? (result?.key === key ? result.rows : [])
}

