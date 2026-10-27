import { create } from 'zustand'
import { formatInvoiceNo } from './retail'
import { canonicalPhone } from './phone'
import { getBranchProfile } from './branchProfile'
import { shopLink } from './shopLink'
import { branchLabel } from './branchTheme'
import type { PosBranch } from '../store/store'

/**
 * ONE way to send a PDF (invoice, advance receipt, final invoice, return receipt, coupon) to a customer on WhatsApp.
 * Call it straight from the click handler, BEFORE any await: what needs the click (the share sheet, opening a window) is
 * decided and started synchronously; the PDF itself may still be made afterwards (`file` can be a function / promise).
 *
 *   a) the browser can share files (Android, iOS / iPadOS Safari, Windows Chrome / Edge with the Windows share sheet):
 *      the share sheet gets ONE file and no title / text / url. Closing the sheet is not an error. If the browser refuses
 *      the sheet because fetching the bill / making the PDF took too long after the tap, a "Send on WhatsApp" button
 *      shares the ready PDF on the next tap (no download dead end on a phone).
 *   b) otherwise (desktop browsers without file sharing): the PDF is downloaded, the customer's chat (91XXXXXXXXXX) is
 *      opened in a tab that was opened ON the click (so no popup blocker), with no prefilled text, and a lasting message
 *      explains how to attach the file, with "Download again", "Open WhatsApp app" (whatsapp://) and, where the bill has a
 *      public page, "Copy invoice link".
 *   c) no valid mobile number: the PDF is still downloaded and the message says so. Any failure shows an error message.
 * Nothing here claims the file was sent: only the WhatsApp Business API can put a file into a chat by itself.
 */

export type ShareAction = { label: string; href?: string; onClick?: () => void }
export type ShareToastState = { kind: 'ok' | 'err' | 'warn'; text: string; actions?: ShareAction[]; sticky?: boolean } | null
export const useShareToast = create<{ toast: ShareToastState; show: (t: NonNullable<ShareToastState>) => void; clear: () => void }>((set) => ({
  toast: null,
  show: (toast) => {
    set({ toast })
    // a desktop instruction stays until it is closed (the person needs it while attaching the file)
    if (!toast.sticky) setTimeout(() => set((s) => (s.toast === toast ? { toast: null } : s)), 6000)
  },
  clear: () => set({ toast: null }),
}))

export type WhatsAppShareResult = 'shared' | 'cancelled' | 'downloaded' | 'failed'

/** Same bytes, named like the bill: INV10000003.pdf (an advance receipt keeps its own name). */
export const pdfNamed = (file: File, name: string): File => new File([file], name, { type: 'application/pdf' })
export const invoicePdfShareName = (invoiceNo: string) => `${formatInvoiceNo(invoiceNo)}.pdf`
/** The public page of a bill (/invoice/INV10000003 or a deposit id), for "Copy invoice link". */
export const invoicePageLink = (ref: string) => `${window.location.origin}/invoice/${encodeURIComponent(/^\d+$/.test(ref) ? formatInvoiceNo(ref) : ref)}`

/** 91XXXXXXXXXX for a valid Indian mobile, else null */
export const whatsAppNumber = (phone?: string | null): string | null => { const c = canonicalPhone(phone); return c ? `91${c}` : null }
export const waChatUrl = (number: string) => `https://wa.me/${number}`
export const waAppUrl = (number: string) => `whatsapp://send?phone=${number}`

/** true when this browser can share a PDF FILE (decided without the real file, so it can run before any await) */
export function canShareFiles(): boolean {
  const nav = (typeof navigator !== 'undefined' ? navigator : undefined) as (Navigator & { canShare?: (d: ShareData) => boolean }) | undefined
  if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false
  try { return nav.canShare({ files: [new File(['%PDF-1.4'], 'probe.pdf', { type: 'application/pdf' })] }) } catch { return false }
}

export function downloadPdf(file: File) {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url; a.download = file.name; a.style.display = 'none'
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

const copy = async (text: string) => {
  try { await navigator.clipboard.writeText(text); useShareToast.getState().show({ kind: 'ok', text: 'Invoice link copied.' }) }
  catch { useShareToast.getState().show({ kind: 'err', text: 'Could not copy the link. Copy it from the invoice page instead.' }) }
}

/**
 * A bill to the customer's OWN chat: opens wa.me/91XXXXXXXXXX (straight into that number's chat, no contact search) with a
 * ready message carrying the invoice link, so one tap on Send delivers it. A web page cannot attach a file to a chosen chat
 * (only the share sheet takes files, and it always asks for the contact), so the PDF file stays one tap away
 * ("Send PDF file instead"). No valid mobile number on the bill: the PDF flow above, unchanged.
 * Call it straight from the click (the chat window is opened synchronously).
 */
export function sendInvoiceToChat(opts: {
  phone?: string | null
  invoiceNo: string
  total?: number | null
  /** the bill's branch: its Store Settings name opens the message */
  branch?: string | null
  /** the bill's public page (invoicePageLink) */
  link: string
  /** the PDF, for "Send PDF file instead" */
  file: File | Promise<File> | (() => File | Promise<File>)
  label?: string
}): void {
  const number = whatsAppNumber(opts.phone)
  const pdfFlow = () => void sendPdfOnWhatsApp({ file: opts.file, phone: opts.phone, label: opts.label || 'Invoice', link: opts.link })
  if (!number) { pdfFlow(); return }
  const no = formatInvoiceNo(opts.invoiceNo)
  const lines = [
    // the branch's own place name (Karanthai / Kinathukadavu / Pollachi): two branches share the Store Settings shop name
    `Thank you for shopping at ${opts.branch ? branchLabel(opts.branch as PosBranch) : getBranchProfile(opts.branch).name}!`,
    `Invoice: ${no}`,
    ...(opts.total != null && Number.isFinite(Number(opts.total)) ? [`Total: ₹${Number(opts.total).toFixed(2)}`] : []),
    '',
    `Click here to download invoice: ${opts.link}`,
    '',
    // the online shop of this deployment (the Vercel link), built from the address the app is open on
    `Click here to order from here: ${shopLink(window.location.origin)}`,
  ]
  const url = `${waChatUrl(number)}?text=${encodeURIComponent(lines.join('\n'))}`
  const w = window.open(url, '_blank')
  if (w) { try { w.opener = null } catch { /* cross-origin already */ } }
  else window.location.href = url // a blocked window (some in-app browsers): go in this tab
  useShareToast.getState().show({
    kind: 'ok', sticky: true,
    text: `WhatsApp chat with +91 ${number.slice(2)} opened with invoice ${no}. Tap Send in WhatsApp.`,
    actions: [{ label: 'Open chat again', href: url }, { label: 'Send PDF file instead', onClick: pdfFlow }],
  })
}

export async function sendPdfOnWhatsApp(opts: {
  file: File | Promise<File> | (() => File | Promise<File>)
  phone?: string | null
  /** what the file is, for the messages: "Invoice", "Advance receipt", "Return receipt", "Coupon" */
  label?: string
  /** the bill's public page; offered as "Copy invoice link" on desktop */
  link?: string | null
}): Promise<WhatsAppShareResult> {
  const label = opts.label || 'Invoice'
  const toast = useShareToast.getState()
  const sharing = canShareFiles()
  const number = whatsAppNumber(opts.phone)
  // desktop: open the chat tab NOW, on the click, before anything is awaited (a window opened later is blocked)
  const tab = !sharing && number ? window.open('', '_blank') : null
  let file: File
  try {
    file = await (typeof opts.file === 'function' ? opts.file() : opts.file)
  } catch (e) {
    try { tab?.close() } catch { /* already closed */ }
    toast.show({ kind: 'err', text: `Could not prepare the ${label.toLowerCase()} PDF${e instanceof Error && e.message ? `: ${e.message}` : ''}` })
    return 'failed'
  }

  if (sharing) {
    const share = () => (navigator as Navigator & { share: (d: ShareData) => Promise<void> }).share({ files: [file] })
    try {
      // files ONLY: no title, text or url, so nothing but the PDF reaches WhatsApp
      await share()
      return 'shared'
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled' // the sheet was closed: not an error
      // the tap's permission ran out while the bill was fetched / the PDF was made (iPhone Safari allows very little time).
      // On a phone a download is a dead end: keep the ready PDF and let ONE more tap open the share sheet (a fresh tap is allowed).
      if (e instanceof DOMException && e.name === 'NotAllowedError') {
        const retry = () => {
          share().then(() => toast.clear()).catch((err) => {
            if (err instanceof DOMException && err.name === 'AbortError') return
            downloadPdf(file)
            toast.show({ kind: 'warn', sticky: true, actions: [{ label: 'Download again', onClick: () => downloadPdf(file) }], text: `Sharing is not available here. ${file.name} was downloaded: send it on WhatsApp yourself.` })
          })
        }
        toast.show({ kind: 'ok', sticky: true, actions: [{ label: 'Send on WhatsApp', onClick: retry }, { label: 'Download', onClick: () => downloadPdf(file) }], text: `${label} PDF is ready. Tap "Send on WhatsApp" and choose WhatsApp.` })
        return 'downloaded'
      }
      // any other failure: fall back to the download below
    }
  }

  try { downloadPdf(file) } catch (e) {
    try { tab?.close() } catch { /* already closed */ }
    toast.show({ kind: 'err', text: `Could not download the ${label.toLowerCase()} PDF${e instanceof Error && e.message ? `: ${e.message}` : ''}` })
    return 'failed'
  }
  const actions: ShareAction[] = [{ label: 'Download again', onClick: () => downloadPdf(file) }]
  if (opts.link && !sharing) actions.push({ label: 'Copy invoice link', onClick: () => void copy(opts.link as string) })
  if (!number) {
    toast.show({ kind: 'warn', sticky: true, actions, text: `No valid mobile number on this ${label.toLowerCase()}, so no chat was opened. ${file.name} was downloaded: open WhatsApp and send it to the customer yourself.` })
    return 'downloaded'
  }
  if (tab) {
    try { tab.opener = null; tab.location.href = waChatUrl(number) } catch { /* the tab was closed */ }
  }
  actions.unshift({ label: 'Open chat', href: waChatUrl(number) }, { label: 'Open WhatsApp app', href: waAppUrl(number) })
  toast.show({ kind: 'ok', sticky: true, actions, text: `${label} downloaded. In the chat, click the attach (clip) icon, choose Document, and pick ${file.name}.` })
  return 'downloaded'
}
