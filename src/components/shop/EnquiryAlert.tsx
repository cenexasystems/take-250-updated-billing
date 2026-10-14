import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { ShoppingBag, Volume2, VolumeX, ChevronRight } from 'lucide-react'
import { alarmSound } from '../../lib/alarmAudio'
import { useAlarmStore } from '../../store/alarmStore'
import { useShopAlertStore } from '../../store/shopAlertStore'

export default function EnquiryAlert() {
  const popup = useShopAlertStore((s) => s.popup)
  const clearPopup = useShopAlertStore((s) => s.clearPopup)
  const focus = useShopAlertStore((s) => s.focus)
  const navigate = useNavigate()
  const location = useLocation()
  const [blocked, setBlocked] = useState(() => alarmSound.isBlocked())
  useEffect(() => alarmSound.subscribe(() => setBlocked(alarmSound.isBlocked())), [])
  if (!popup.length) return null

  const stop = () => {
    alarmSound.stopAlert()
    // the low-stock alarm shares the speaker: keep it sounding if it is still unacknowledged
    if (useAlarmStore.getState().isAlarmActive) alarmSound.startAlert()
  }
  const acknowledge = () => { stop(); clearPopup() }
  const open = (id: string) => {
    stop(); clearPopup(); focus(id)
    if (location.pathname !== '/dashboard') navigate(`/dashboard?tab=online_enquiries&enquiry=${encodeURIComponent(id)}`)
  }
  const wake = () => { void alarmSound.unlock() }

  return createPortal(
    <div onClick={wake} onTouchStart={wake} className="fixed inset-0 z-[210] flex items-center justify-center bg-black/75 backdrop-blur-xs p-2 sm:p-4" role="dialog" aria-modal="true" aria-label="New online request" data-testid="enquiry-alert">
      <div onClick={(e) => { e.stopPropagation(); wake() }} className="bg-white rounded-2xl sm:rounded-3xl max-w-lg w-full shadow-2xl overflow-hidden border-2 border-[#D4AF37] flex flex-col max-h-[100dvh] sm:max-h-[90vh]">
        <div className="bg-[#111111] text-white px-5 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#D4AF37]/20 flex items-center justify-center animate-bounce"><ShoppingBag className="w-5 h-5 text-[#D4AF37]" /></div>
            <div>
              <h3 className="font-black text-sm tracking-wide">New Online Request{popup.length > 1 ? `s (${popup.length})` : ''}</h3>
              <p className="text-[11px] text-white/80 font-semibold">From the online shop · call the customer to confirm</p>
            </div>
          </div>
          {blocked ? (
            <button type="button" onClick={(e) => { e.stopPropagation(); wake() }} className="flex items-center gap-1.5 bg-yellow-300 hover:bg-yellow-400 text-yellow-950 px-3 py-1.5 rounded-full text-[11px] font-black animate-bounce shrink-0 cursor-pointer">
              <Volume2 className="w-3.5 h-3.5" /><span>Tap for Sound 🔊</span>
            </button>
          ) : (
            <div className="flex items-center gap-1.5 bg-white/15 px-2.5 py-1 rounded-full text-[10px] font-black animate-pulse shrink-0"><Volume2 className="w-3.5 h-3.5" /><span>Alert Sounding</span></div>
          )}
        </div>
        <div className="p-4 sm:p-5 overflow-y-auto space-y-2.5 flex-1 min-h-0 bg-[#FAFAFA]">
          {popup.map((e) => (
            <div key={e.id} className="p-3.5 rounded-2xl border border-[#E8D399] bg-[#FBFAF6] flex items-center justify-between gap-3" data-testid="enquiry-alert-item">
              <div className="min-w-0">
                <p className="font-black text-sm text-[#111111]">{e.enquiry_no}</p>
                <p className="text-[12px] font-semibold text-[#374151] truncate">{e.customer_name} · {e.branch_name}</p>
                <p className="text-[11px] text-[#6B7280]">{new Date(e.created_at).toLocaleString('en-IN')}</p>
              </div>
              <button type="button" onClick={() => open(e.id)} className="shrink-0 inline-flex items-center gap-1 rounded-xl bg-[#111111] text-[#D4AF37] px-3 py-2 text-xs font-black cursor-pointer">Open <ChevronRight size={13} /></button>
            </div>
          ))}
        </div>
        <div className="p-4 sm:p-5 border-t border-gray-200 bg-white flex items-center justify-end gap-3 shrink-0 pb-[max(1rem,calc(env(safe-area-inset-bottom)+0.75rem))]">
          <button type="button" onClick={acknowledge} className="w-full sm:w-auto h-11 px-6 rounded-2xl bg-[#111111] text-[#D4AF37] text-xs font-black tracking-wide flex items-center justify-center gap-2 cursor-pointer">
            <VolumeX className="w-4 h-4" /><span>Acknowledge</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
