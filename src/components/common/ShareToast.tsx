import { X } from 'lucide-react'
import { useShareToast } from '../../lib/whatsappShare'

/** The same small toast the Order History uses after a status change, for WhatsApp sending (with its follow-up buttons). */
export default function ShareToast() {
  const toast = useShareToast((s) => s.toast)
  const clear = useShareToast((s) => s.clear)
  if (!toast) return null
  const tone = toast.kind === 'ok' ? 'bg-emerald-600 text-white' : toast.kind === 'warn' ? 'bg-amber-600 text-white' : 'bg-red-600 text-white'
  return (
    <div role="status" data-testid="share-toast" className={`fixed bottom-5 left-1/2 z-[130] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-xl px-4 py-3 text-sm font-bold shadow-xl ${tone}`}>
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1">{toast.text}</p>
        {toast.sticky && (
          <button type="button" onClick={clear} aria-label="Close" className="shrink-0 rounded-lg p-0.5 hover:bg-white/15 cursor-pointer"><X size={16} /></button>
        )}
      </div>
      {toast.actions && toast.actions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {toast.actions.map((a) => a.href ? (
            <a key={a.label} href={a.href} target={a.href.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer"
              className="rounded-lg bg-white/15 px-2.5 py-1 text-xs font-black hover:bg-white/25" data-testid="share-toast-action">{a.label}</a>
          ) : (
            <button key={a.label} type="button" onClick={a.onClick}
              className="rounded-lg bg-white/15 px-2.5 py-1 text-xs font-black hover:bg-white/25 cursor-pointer" data-testid="share-toast-action">{a.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}
