import { useEffect, useState } from 'react'
import { api } from '../../lib/apiClient'
import { canonicalPhone } from '../../lib/phone'
import type { PosBranch } from '../../store/store'

export type CouponStatus = 'active' | 'used' | 'expired' | 'limit_reached'
export type CustomerLookup = {
  exists_in_this_branch: boolean
  name: string | null
  /** this branch's coupons sent to the number, status computed by the server (SQL) */
  coupons: Array<{ code: string; status: CouponStatus }>
  /** display names of OTHER branches where the number is a customer (nothing else from those branches) */
  other_branches: string[]
}

// one answer per branch + number for this page view: the POS shows the phone in two places, and retyping the same number
// must not count again against the lookup rate limit
const cache = new Map<string, CustomerLookup>()
export const clearCustomerLookupCache = () => cache.clear()

/** Looks the number up once it is a full valid mobile (debounced). Partial / invalid numbers: nothing is requested. */
export function useCustomerLookup(phone: string, branch: PosBranch, refreshKey = 0): CustomerLookup | null {
  const canonical = canonicalPhone(phone)
  const key = canonical ? `${branch}:${canonical}` : ''
  const [result, setResult] = useState<{ key: string; data: CustomerLookup } | null>(null)
  useEffect(() => {
    if (!canonical) return
    const hit = refreshKey === 0 ? cache.get(key) : undefined
    if (hit) { setResult({ key, data: hit }); return }
    let live = true
    const t = setTimeout(() => {
      api<CustomerLookup>('POST', '/api/customers/lookup', { body: { phone: canonical }, branchId: branch })
        .then((data) => { cache.set(key, data); if (live) setResult({ key, data }) })
        .catch(() => { if (live) setResult(null) }) // rate limited / offline: show nothing rather than a wrong status
    }, 450)
    return () => { live = false; clearTimeout(t) }
  }, [canonical, key, branch, refreshKey])
  return canonical && result?.key === key ? result.data : null
}

export const COUPON_STATUS_BADGE: Record<CouponStatus, { label: string; className: string }> = {
  active: { label: 'Active', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  used: { label: 'Used', className: 'bg-gray-100 text-gray-600 border-gray-200' },
  expired: { label: 'Expired', className: 'bg-red-50 text-red-700 border-red-200' },
  limit_reached: { label: 'Limit reached', className: 'bg-amber-50 text-amber-800 border-amber-200' },
}

/** Status line under a phone field + that customer's sent coupons (this branch). Renders nothing until there is an answer. */
export default function CustomerLookupStatus({ lookup }: { lookup: CustomerLookup | null }) {
  if (!lookup) return null
  return (
    <div className="mt-1 space-y-1" data-testid="customer-lookup-status">
      {lookup.exists_in_this_branch ? (
        <p className="text-[11px] font-bold text-emerald-700" data-testid="customer-status-line">Existing customer - {lookup.name || 'Customer'}</p>
      ) : lookup.other_branches.length > 0 ? (
        <>
          <p className="text-[11px] font-bold text-[#374151]" data-testid="customer-status-line">New customer in this branch</p>
          <p className="text-[11px] font-semibold text-[#6B7280]" data-testid="customer-other-branches">Also a customer at {lookup.other_branches.join(', ')}</p>
        </>
      ) : (
        <p className="text-[11px] font-bold text-[#374151]" data-testid="customer-status-line">New customer</p>
      )}
      {lookup.coupons.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="customer-coupons">
          {lookup.coupons.map((c) => (
            <span key={c.code} className="inline-flex items-center gap-1" data-testid="customer-coupon">
              <span className="text-[11px] font-mono font-black uppercase tracking-wider text-[#7A1220]">{c.code}</span>
              <span className={`rounded-full px-2.5 py-0.5 text-[9px] font-black uppercase tracking-wider border ${COUPON_STATUS_BADGE[c.status].className}`}>{COUPON_STATUS_BADGE[c.status].label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
