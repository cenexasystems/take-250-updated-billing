import { useState } from 'react'
import { MessageCircle, X } from 'lucide-react'
import { api } from '../../lib/apiClient'
import { couponPdfFile } from '../../lib/couponPdf'
import { canonicalPhone } from '../../lib/phone'
import { sendPdfOnWhatsApp } from '../../lib/whatsappShare'
import Toggle from '../common/Toggle'
import CustomerLookupStatus, { clearCustomerLookupCache, useCustomerLookup } from '../pos/CustomerLookupStatus'
import type { PosBranch } from '../../store/store'

export type SendableCoupon = { id: number; code: string; percentage: number; expiry_date: string | null; usage_limit: number | null; per_customer_limit?: number | null; min_order_value: number }

/**
 * Admin: send one coupon of the selected branch to a customer as a PDF FILE (no text, title or link), with the same share
 * helper and desktop fallback as the invoice. The send is recorded only after the share / download succeeded.
 */
export default function SendCouponModal({ coupon, branch, onClose, onSent }: { coupon: SendableCoupon; branch: PosBranch; onClose: () => void; onSent?: () => void }) {
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [specific, setSpecific] = useState(false) // OFF by default: the coupon keeps working for everyone
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const lookup = useCustomerLookup(phone, branch)
  const canonical = canonicalPhone(phone)

  const send = async () => {
    setError(''); setDone('')
    if (!canonical) { setError('Enter a full 10-digit mobile number'); return }
    setBusy(true)
    try {
      const customerName = name.trim() || (lookup?.exists_in_this_branch ? lookup.name || '' : '')
      const file = couponPdfFile({
        branch, code: coupon.code, percentage: Number(coupon.percentage), expiryDate: coupon.expiry_date,
        usageLimit: coupon.usage_limit, perCustomerLimit: coupon.per_customer_limit ?? null, minOrderValue: Number(coupon.min_order_value || 0), customerName, phone: canonical,
      })
      // coupons have no public page: no "Copy invoice link"
      const shared = await sendPdfOnWhatsApp({ file, phone: canonical, label: 'Coupon' })
      if (shared === 'cancelled') { setError('Sharing was cancelled. Nothing was recorded.'); return }
      if (shared === 'failed') { setError('The coupon PDF could not be prepared. Nothing was recorded.'); return }
      await api('POST', `/api/coupons/${coupon.id}/sends`, { body: { phone: canonical, customer_name: customerName, customer_specific: specific }, branchId: branch })
      clearCustomerLookupCache()
      setDone(`${coupon.code} sent to ${customerName ? `${customerName} · ` : ''}+91 ${canonical}.`)
      onSent?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the coupon')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Send coupon" data-testid="send-coupon-modal">
      <div className="w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain rounded-2xl bg-white p-5 shadow-2xl border border-[#E8D399]">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-black text-[#111111]">Send coupon · <span className="font-mono uppercase tracking-wider text-[#7A1220]">{coupon.code}</span></h3>
          <button type="button" onClick={onClose} aria-label="Close" className="h-9 w-9 shrink-0 rounded-xl border border-[#E5E7EB] text-[#111111] cursor-pointer"><X size={16} className="mx-auto" /></button>
        </div>
        <p className="mt-1 text-xs font-semibold text-[#6B7280]">The coupon goes as a PDF file only. It is recorded once the PDF has been shared or downloaded.</p>

        <div className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="send-coupon-phone" className="block text-[11px] font-bold uppercase tracking-wider text-gray-700">Customer phone <span className="text-red-500">*</span></label>
            <input
              id="send-coupon-phone" type="tel" inputMode="tel" autoComplete="off"
              value={phone} onChange={(e) => { setPhone(e.target.value); setError(''); setDone('') }}
              placeholder="Enter WhatsApp number"
              className="w-full rounded-xl border border-gray-300 bg-[#FAFAFA] px-3.5 py-2.5 text-[13px] font-bold text-[#111111] outline-none transition-all focus:border-[#7A1220] focus:bg-white focus:ring-1 focus:ring-[var(--theme-primary)]"
            />
            <CustomerLookupStatus lookup={lookup} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="send-coupon-name" className="block text-[11px] font-bold uppercase tracking-wider text-gray-700">Customer name</label>
            <input
              id="send-coupon-name" type="text" value={name} maxLength={200}
              onChange={(e) => setName(e.target.value)}
              placeholder={lookup?.exists_in_this_branch && lookup.name ? lookup.name : 'Optional'}
              className="w-full rounded-xl border border-gray-300 bg-[#FAFAFA] px-3.5 py-2.5 text-[13px] font-bold text-[#111111] outline-none transition-all focus:border-[#7A1220] focus:bg-white focus:ring-1 focus:ring-[var(--theme-primary)]"
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="send-coupon-specific" className="text-[11px] font-bold uppercase tracking-wider text-gray-700">Only for this customer</label>
              <Toggle id="send-coupon-specific" checked={specific} onChange={setSpecific} label="Only for this customer" />
            </div>
            {specific && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-[12px] font-bold text-amber-800" role="alert" data-testid="send-coupon-warning">
                This coupon will only work for the phones it was sent to. Use a dedicated coupon for this.
              </div>
            )}
          </div>
        </div>

        {error && <p className="mt-3 text-sm font-bold text-red-600" role="alert">{error}</p>}
        {done && <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-bold text-emerald-700" data-testid="send-coupon-done">{done}</div>}

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onClose} className="h-11 flex-1 rounded-xl border border-[#E5E7EB] text-sm font-black text-[#111111] cursor-pointer">{done ? 'Done' : 'Cancel'}</button>
          <button type="button" onClick={() => void send()} disabled={busy || !canonical}
            className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#25D366] text-sm font-black text-white cursor-pointer disabled:cursor-not-allowed disabled:opacity-50">
            <MessageCircle size={15} /> {busy ? 'Preparing…' : 'Generate & share PDF'}
          </button>
        </div>
      </div>
    </div>
  )
}
