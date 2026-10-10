import { useShareToast } from '../../lib/whatsappShare'

/** The same small toast the Order History uses after a status change, for the WhatsApp PDF fallback. */
export default function ShareToast() {
  const toast = useShareToast((s) => s.toast)
  if (!toast) return null
  return (
    <div role="status" data-testid="share-toast" className={`fixed bottom-5 left-1/2 z-[130] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-xl px-4 py-3 text-sm font-bold shadow-xl ${toast.kind === 'ok' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'}`}>
      {toast.text}
    </div>
  )
}
