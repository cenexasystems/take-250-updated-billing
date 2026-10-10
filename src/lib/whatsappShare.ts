import { create } from 'zustand'
import { formatInvoiceNo } from './retail'
import { toWhatsAppUrl } from './phone'

/**
 * WhatsApp billing = the PDF itself, nothing else: no text, no link.
 *   phone / tablet (a browser that can share files): the system share sheet gets ONE file and no title / text / url fields;
 *     the person picks WhatsApp and the customer there (a share sheet cannot pre-select a number).
 *   desktop (or a browser that cannot share files): the PDF is downloaded, a short instruction is shown, and WhatsApp opens
 *     on the customer's number with NO prefilled text, so the PDF is attached by hand.
 * Always call it straight from the click handler (the share sheet needs that tap), and never automatically.
 */

export type ShareToastState = { kind: 'ok' | 'err'; text: string } | null
export const useShareToast = create<{ toast: ShareToastState; show: (t: NonNullable<ShareToastState>) => void; clear: () => void }>((set) => ({
  toast: null,
  show: (toast) => { set({ toast }); setTimeout(() => set((s) => (s.toast === toast ? { toast: null } : s)), 6000) },
  clear: () => set({ toast: null }),
}))

export type WhatsAppShareResult = 'shared' | 'cancelled' | 'downloaded'

/** Same bytes, named like the bill: INV10000003.pdf (an advance receipt keeps its own name). */
export const pdfNamed = (file: File, name: string): File => new File([file], name, { type: 'application/pdf' })
export const invoicePdfShareName = (invoiceNo: string) => `${formatInvoiceNo(invoiceNo)}.pdf`

const isTouchDevice = () =>
  typeof navigator !== 'undefined' &&
  (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

const canShareFile = (file: File) => {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  try { return isTouchDevice() && typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] }) } catch { return false }
}

const downloadPdf = (file: File) => {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url; a.download = file.name; a.style.display = 'none'
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

export async function sharePdfOnWhatsApp(file: File, phone?: string | null): Promise<WhatsAppShareResult> {
  if (canShareFile(file)) {
    try {
      // files ONLY: no title, text or url, so nothing but the PDF reaches WhatsApp
      await (navigator as Navigator & { share: (d: ShareData) => Promise<void> }).share({ files: [file] })
      return 'shared'
    } catch (e) {
      // the person closed the share sheet: not an error
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled'
      // share failed for another reason: fall through to the download path
    }
  }
  downloadPdf(file)
  useShareToast.getState().show({ kind: 'ok', text: 'Invoice downloaded. Attach it in WhatsApp.' })
  window.open(toWhatsAppUrl(phone || ''), '_blank', 'noopener,noreferrer')
  return 'downloaded'
}
