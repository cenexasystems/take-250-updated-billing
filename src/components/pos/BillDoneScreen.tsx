import { ArrowLeft, Download, MessageCircle, Plus, Printer, RefreshCw } from 'lucide-react'
import { Invoice } from '../Invoice'
import CenexaFooter from '../common/CenexaFooter'
import type { InvoiceDoc } from '../../lib/invoiceDoc'
import { formatPhoneForDisplay } from '../../lib/phone'
import { formatCurrency, formatInvoiceNo } from '../../lib/retail'
import { useLangStore } from '../../store/langStore'

/**
 * The screen after a bill is made: "Bill Generated Successfully", the financial summary, Print Receipt / WhatsApp Invoice /
 * Download Invoice / New Sale and the items sold, with the A4 invoice as the print view. Shown after a POS sale and after
 * an advance order is completed (moved here unchanged from the POS so both use the same screen).
 */
export default function BillDoneScreen({
  invoiceNo, date, customerName, paymentMode, phone, total, summary = [], amountReceived, receivedLabel, balanceReturned,
  items, doc, onPrint, onWhatsApp, onDownload, onNewSale, onClose, closeLabel = 'Back',
}: {
  invoiceNo: string
  date: string
  customerName: string
  paymentMode: string
  phone?: string
  total: number
  /** extra lines under Grand Total (an advance order: the deposit paid) */
  summary?: Array<{ label: string; value: number }>
  amountReceived: number
  receivedLabel?: string
  balanceReturned: number
  items: Array<{ key: string; label: string; amount: number }>
  /** the invoice (shared invoice data): the print view */
  doc: InvoiceDoc
  onPrint: () => void
  onWhatsApp: () => void
  onDownload: () => void
  onNewSale: () => void
  /** when set, the header button closes the screen instead of starting a new sale */
  onClose?: () => void
  closeLabel?: string
}) {
  const lang = useLangStore((st) => st.lang)
  const l = (en: string, ta: string) => (lang === 'ta' ? ta : en)
  return (
      <div className="mobile-page-shell print:bg-white print:min-h-0 min-h-[100dvh] flex flex-col justify-between">
        {/* Screen UI */}
        <div className="flex-1 max-w-2xl mx-auto px-4 py-6 print:hidden space-y-4 w-full">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-textMain">{l('Bill Generated Successfully', 'பில் உருவாக்கப்பட்டது')}</h1>
              <p className="text-xs text-textMuted mt-0.5">Transaction recorded and inventory updated</p>
            </div>
            <button onClick={onClose ?? onNewSale} data-testid="bill-done-header-button"
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#111111] hover:bg-[#3d4f3a] text-white font-bold text-sm shadow-sm cursor-pointer">
              {onClose ? <><ArrowLeft size={15} /> {closeLabel}</> : <><Plus size={15} /> New Sale</>}
            </button>
          </div>

          {/* Bill Details Section */}
          <div className="rounded-2xl border border-[#E8D399] bg-[#FBFAF6] p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Bill Number:</span>
                <span className="px-2.5 py-0.5 rounded-lg bg-brand-black text-[#D4AF37] font-black text-xs font-mono">
                  #{formatInvoiceNo(invoiceNo)}
                </span>
              </div>
              <div className="text-xs font-semibold text-gray-600">
                {new Date(date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-2.5 text-xs">
              <div>
                <span className="text-[10px] text-gray-400 font-bold uppercase block">Customer</span>
                <span className="font-bold text-gray-900 truncate block">{customerName || 'Walk-in Customer'}</span>
              </div>
              <div>
                <span className="text-[10px] text-gray-400 font-bold uppercase block">Payment Mode</span>
                <span className="font-bold text-gray-900 uppercase block">{paymentMode || 'POS'}</span>
              </div>
              {phone && (
                <div>
                  <span className="text-[10px] text-gray-400 font-bold uppercase block">Phone</span>
                  <span className="font-semibold text-gray-700 block">{formatPhoneForDisplay(phone)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Payment receipt */}
          <div className="surface-panel p-5 rounded-xl border border-gray-100 bg-white shadow-sm mb-4">
            <p className="text-xs font-black uppercase tracking-widest text-textMuted mb-3">{l('Financial Summary', 'நிதி சுருக்கம்')}</p>
            <div className="space-y-2.5">
              <div className="flex justify-between items-center pb-2.5 border-b border-gray-100">
                <p className="text-sm font-bold text-textMuted">{l('Grand Total', 'மொத்த தொகை')}</p>
                <p className="text-2xl font-black text-textMain tabular-nums">{formatCurrency(total)}</p>
              </div>
              {summary.map((row) => (
                <div key={row.label} className="flex justify-between items-center">
                  <p className="text-sm font-bold text-textMuted">{row.label}</p>
                  <p className="text-base font-black text-textMain tabular-nums">{formatCurrency(row.value)}</p>
                </div>
              ))}
              <div className="flex justify-between items-center">
                <p className="text-sm font-bold text-textMuted">{receivedLabel ?? l('Amount Received', 'பெற்ற தொகை')}</p>
                <p className="text-xl font-black text-textMain tabular-nums">{formatCurrency(amountReceived)}</p>
              </div>
              {balanceReturned > 0 ? (
                <div className="flex justify-between items-center rounded-xl bg-blue-50 border border-blue-200 px-4 py-3">
                  <p className="text-sm font-black text-blue-700">{l('Balance Returned', 'திரும்பிய பணம்')}</p>
                  <p className="text-2xl font-black text-blue-700 tabular-nums">{formatCurrency(balanceReturned)}</p>
                </div>
              ) : (
                <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-center">
                  <p className="text-sm font-black text-green-700">✅ {l('Exact Amount Received', 'சரியான தொகை')}</p>
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <button onClick={onPrint}
              className="flex flex-col md:flex-row items-center justify-center gap-2 py-3 px-2 rounded-xl border-2 border-gray-200 hover:border-[#111111] text-textMain font-bold text-[12px] md:text-sm transition-colors text-center leading-tight">
              <Printer size={16} className="shrink-0" /> {l('Print Receipt', 'ரசீது அச்சிடு')}
            </button>
            <button onClick={onWhatsApp}
              className="flex flex-col md:flex-row items-center justify-center gap-2 py-3 px-2 rounded-xl bg-green-500 hover:bg-green-600 text-white font-bold text-[12px] md:text-sm transition-colors text-center leading-tight">
              <MessageCircle size={16} className="shrink-0" /> WhatsApp Invoice
            </button>
            <button onClick={onDownload}
              className="flex flex-col md:flex-row items-center justify-center gap-2 py-3 px-2 rounded-xl border-2 border-gray-200 hover:border-[#111111] text-textMain font-bold text-[12px] md:text-sm transition-colors text-center leading-tight">
              <Download size={16} className="shrink-0" /> {l('Download Invoice', 'இன்வாய்ஸ் பதிவிறக்கு')}
            </button>
            <button onClick={onNewSale}
              className="flex flex-col md:flex-row items-center justify-center gap-2 py-3 px-2 rounded-xl bg-[#111111] hover:bg-[#3d4f3a] text-white font-bold text-[12px] md:text-sm transition-colors text-center leading-tight">
              <RefreshCw size={16} className="shrink-0" /> New Sale
            </button>
          </div>

          {/* Items summary */}
          <div className="surface-panel p-4 rounded-xl border border-gray-100 bg-white shadow-sm mt-4">
            <p className="text-xs font-bold text-textMuted uppercase tracking-wide mb-3">{l('Items Sold', 'விற்ற பொருட்கள்')}</p>
            <div className="space-y-1.5">
              {items.map(item => (
                <div key={item.key} className="flex justify-between text-sm">
                  <span className="text-textMain">{item.label}</span>
                  <span className="font-bold">{formatCurrency(item.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Print view — full A4 invoice */}
        <div className="hidden print:block">
          <Invoice doc={doc} />
        </div>
        <CenexaFooter />
      </div>
  )
}
