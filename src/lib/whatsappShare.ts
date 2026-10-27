import { create } from 'zustand'
import { formatInvoiceNo } from './retail'
import type { InvoiceDoc } from './invoiceDoc'
import { canonicalPhone } from './phone'
import { getBranchProfile } from './branchProfile'
import { orderFromHereText, shopLink } from './shopLink'
import { uploadInvoicePdf } from './storage'
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

/** "Click here to order from here: <the shop of this deployment>" closes every message sent to a customer */
const orderLine = () => orderFromHereText(shopLink(window.location.origin))
const thanksLine = (branch?: string | null) =>
  // the branch's own place name (Karanthai / Kinathukadavu / Pollachi): two branches share the Store Settings shop name
  `Thank you for shopping at ${branch ? branchLabel(branch as PosBranch) : getBranchProfile(branch).name}!`
const rupees = (v: number) => `₹${(Number(v) || 0).toFixed(2)}`
const MAX_ITEM_LINES = 15

/**
 * The bill as plain lines for the chat, from the SAME InvoiceDoc every invoice output draws: the items, then Subtotal,
 * each discount (coupon / manual with its percentage), taxable amount, CGST / SGST with the rate and amount, delivery,
 * TOTAL, and for an advance order the deposits and the balance. Nothing is calculated here.
 */
export function invoiceSummaryLines(doc: InvoiceDoc): string[] {
  const lines: string[] = []
  const items = doc.items.slice(0, MAX_ITEM_LINES)
  items.forEach((it, i) => lines.push(`${i + 1}. ${it.name} x ${it.quantity}: ${rupees(it.line_total)}`))
  if (doc.items.length > items.length) lines.push(`+ ${doc.items.length - items.length} more item(s)`)
  if (lines.length) lines.push('')
  doc.rows.forEach((r) => lines.push(`${r.label}: ${r.kind === 'discount' ? '-' : ''}${rupees(r.amount)}`))
  lines.push(`TOTAL: ${rupees(doc.total)}`)
  // how it was paid (an advance bill lists its deposit and balance payments below instead)
  if (!doc.advance) {
    if (doc.payment.split) { lines.push('Payment (Split):'); doc.payment.parts.forEach((p) => lines.push(`  ${p.label}: ${rupees(p.amount)}`)) }
    else lines.push(`Payment: ${doc.payment.label}`)
  }
  if (doc.returns) lines.push(`${doc.returns.badge}`, `Returned: ${rupees(doc.returns.returned)}`, `Net amount: ${rupees(doc.returns.net)}`)
  if (doc.advance) {
    doc.advance.deposits.forEach((d) => lines.push(`${d.label}: ${rupees(d.amount)}`))
    if (doc.advance.balance) lines.push(`${doc.advance.balance.label}: ${rupees(doc.advance.balance.amount)}`)
  }
  return lines
}

/** link absent: the message carries only the lines (an advance order still waiting for its balance gets no invoice link) */
const chatLinkUrl = (number: string, head: string[], linkLabel: string, link: string | null) =>
  `${waChatUrl(number)}?text=${encodeURIComponent([...head, '', ...(link ? [`${linkLabel}: ${link}`, ''] : []), orderLine()].join('\n'))}`
/** an advance order that still has a balance due: it is not a final invoice, so its message never carries an invoice link */
const awaitingBalance = (doc: InvoiceDoc | null | undefined) => doc?.advance?.balance?.label === 'Balance due'

/**
 * A document to the customer's OWN chat as a LINK: opens wa.me/91XXXXXXXXXX (straight into that number's chat, no contact
 * search) with a ready message "Click here to download <document>: <link>" and "Click here to order from here: <shop link>",
 * so one tap on Send delivers it. A web page cannot attach a file to a chosen chat (only the share sheet takes files, and
 * it always asks for the contact), so the PDF file stays one tap away ("Send PDF file instead").
 * No valid mobile number: the PDF flow, unchanged. Call it straight from the click (the chat window is opened synchronously).
 */
export function sendInvoiceToChat(opts: {
  phone?: string | null
  invoiceNo: string
  total?: number | null
  /**
   * the bill as the invoice shows it: its items and full breakdown go into the message (else only the total). A function
   * fetches the STORED bill first (a returned / advance bill), the chat tab is then opened on the click and filled after.
   */
  doc?: InvoiceDoc | (() => Promise<InvoiceDoc | null>)
  /** the bill's branch: its place name opens the message */
  branch?: string | null
  /** the bill's public page (invoicePageLink); left out (null) it is a calculations-only message. A bill with a balance due never carries it. */
  link?: string | null
  /** the PDF, for "Send PDF file instead" */
  file: File | Promise<File> | (() => File | Promise<File>)
  label?: string
  /** what the page is: an invoice (default) or an advance receipt */
  kind?: 'invoice' | 'advance receipt'
}): void {
  const number = whatsAppNumber(opts.phone)
  const kind = opts.kind || 'invoice'
  const toast = useShareToast.getState()
  const pdfFlow = () => void sendPdfOnWhatsApp({ file: opts.file, phone: opts.phone, label: opts.label || 'Invoice', link: opts.link })
  const noNumber = (doc: InvoiceDoc | null) => {
    if (!opts.link || awaitingBalance(doc)) toast.show({ kind: 'warn', text: 'No valid mobile number on this bill, so no chat was opened.' })
    else pdfFlow()
  }
  if (!number) {
    if (typeof opts.doc === 'function') void opts.doc().then(noNumber, () => noNumber(null))
    else noNumber(opts.doc ?? null)
    return
  }
  const no = kind === 'invoice' ? formatInvoiceNo(opts.invoiceNo) : opts.invoiceNo
  const urlFor = (doc: InvoiceDoc | null) => chatLinkUrl(number, [
    thanksLine(opts.branch),
    `${kind === 'invoice' && !awaitingBalance(doc) ? 'Invoice' : 'Advance receipt'}: ${no}`,
    ...(doc ? ['', ...invoiceSummaryLines(doc)]
      : opts.total != null && Number.isFinite(Number(opts.total)) ? [`${kind === 'invoice' ? 'Total' : 'Advance paid'}: ₹${Number(opts.total).toFixed(2)}`] : []),
  ], `Click here to download ${kind}`, opts.link && !awaitingBalance(doc) ? opts.link : null)
  const done = (url: string, doc: InvoiceDoc | null) => toast.show({
    kind: 'ok', sticky: true,
    text: `WhatsApp chat with +91 ${number.slice(2)} opened with ${kind} ${no}. Tap Send in WhatsApp.`,
    // no PDF fallback on a message that must not carry the invoice
    actions: [{ label: 'Open chat again', href: url }, ...(opts.link && !awaitingBalance(doc) ? [{ label: 'Send PDF file instead', onClick: pdfFlow }] : [])],
  })

  if (typeof opts.doc !== 'function') {
    const url = urlFor(opts.doc ?? null)
    const w = window.open(url, '_blank')
    if (w) { try { w.opener = null } catch { /* cross-origin already */ } }
    else window.location.href = url // a blocked window (some in-app browsers): go in this tab
    done(url, opts.doc ?? null)
    return
  }
  // the bill is fetched first: open the chat tab NOW (on the click), fill it once the stored bill is here
  const load = opts.doc
  const tab = window.open('', '_blank')
  void (async () => {
    let doc: InvoiceDoc | null = null
    try { doc = await load() } catch (e) {
      try { tab?.close() } catch { /* already closed */ }
      toast.show({ kind: 'err', text: `Could not load the ${kind}${e instanceof Error && e.message ? `: ${e.message}` : ''}` })
      return
    }
    const url = urlFor(doc)
    if (tab) { try { tab.opener = null; tab.location.href = url } catch { /* the tab was closed */ } }
    done(url, doc) // "Open chat again" is there when the tab was blocked
  })()
}

/**
 * A document with no public page of its own (coupon, return receipt): its PDF is stored (the branch's invoices folder in
 * Vercel Blob, under an unguessable name) and the customer gets the link to it, as "Click here to download <label>: <link>".
 * Call it straight from the click: the chat tab is opened first, then the PDF is made and stored.
 * Resolves 'shared' once the chat is opened, 'failed' when the PDF or the link could not be made. With no valid mobile
 * number it falls back to the PDF flow.
 */
export async function sendStoredPdfLinkToChat(opts: {
  phone?: string | null
  branch?: string | null
  file: File | Promise<File> | (() => File | Promise<File>)
  /** what the file is, lower case: "coupon", "return receipt" */
  label: string
  /** the lines above the link (no thank-you line is added) */
  head: string[]
  /** the stored file's name without extension */
  storeName: string
}): Promise<WhatsAppShareResult> {
  const number = whatsAppNumber(opts.phone)
  const toast = useShareToast.getState()
  const title = opts.label.charAt(0).toUpperCase() + opts.label.slice(1)
  if (!number) return sendPdfOnWhatsApp({ file: opts.file, phone: opts.phone, label: title })
  const tab = window.open('', '_blank') // on the click, before anything is awaited (a window opened later is blocked)
  const closeTab = () => { try { tab?.close() } catch { /* already closed */ } }
  let file: File
  try { file = await (typeof opts.file === 'function' ? opts.file() : opts.file) } catch (e) {
    closeTab()
    toast.show({ kind: 'err', text: `Could not prepare the ${opts.label} PDF${e instanceof Error && e.message ? `: ${e.message}` : ''}` })
    return 'failed'
  }
  let link: string
  try { link = await uploadInvoicePdf(file, opts.storeName, opts.branch ?? undefined) } catch (e) {
    closeTab()
    toast.show({
      kind: 'err', sticky: true, actions: [{ label: 'Send PDF file instead', onClick: () => void sendPdfOnWhatsApp({ file, phone: opts.phone, label: title }) }],
      text: `Could not make the ${opts.label} link${e instanceof Error && e.message ? `: ${e.message}` : ''}`,
    })
    return 'failed'
  }
  const url = chatLinkUrl(number, opts.head, `Click here to download ${opts.label}`, link)
  if (tab) { try { tab.opener = null; tab.location.href = url } catch { /* the tab was closed */ } }
  toast.show({
    kind: 'ok', sticky: true,
    text: `WhatsApp chat with +91 ${number.slice(2)} opened with the ${opts.label} link. Tap Send in WhatsApp.`,
    actions: [{ label: 'Open chat', href: url }, { label: 'Send PDF file instead', onClick: () => void sendPdfOnWhatsApp({ file, phone: opts.phone, label: title }) }],
  })
  return 'shared'
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
