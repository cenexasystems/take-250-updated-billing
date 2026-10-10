import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api, ApiClientError } from '../lib/apiClient'
import { Invoice } from '../components/Invoice'
import { Printer, ArrowLeft, MessageCircle } from 'lucide-react'
import { printThermalReceipt } from '../lib/thermalPrint'
import { invoicePdfFile, invoicePdfFileFromElement } from '../lib/invoicePdf'
import CenexaFooter from '../components/common/CenexaFooter'
import { THEME_PALETTE } from '../lib/brand'
import { uploadInvoicePdf } from '../lib/storage'
import { isUuid, normalizeStructuredOrderItem, formatInvoiceNo, formatPaymentMode } from '../lib/retail'
import { invoicePdfShareName, pdfNamed, sharePdfOnWhatsApp } from '../lib/whatsappShare'

function buildLookupCandidates(id: string): string[] {
  const raw = decodeURIComponent(id || '').trim()
  if (!raw) return []

  const candidates = new Set<string>()

  // 1. Stripped prefix (e.g. "INV00000030" -> "00000030") - highest priority because DB stores 8 digits without prefix
  const stripped = raw.replace(/^(INV|PB)[-_ ]*/i, '').trim()
  if (stripped) candidates.add(stripped)

  // 2. Numeric digits padded to 8 digits
  const digits = raw.replace(/\D/g, '')
  if (digits) {
    candidates.add(digits.padStart(8, '0'))
    candidates.add(digits)
    const unpadded = digits.replace(/^0+/, '')
    if (unpadded) candidates.add(unpadded)
  }

  // 3. Raw and uppercase
  candidates.add(raw)
  candidates.add(raw.toUpperCase())

  // 4. Formatted with INV prefix
  candidates.add(formatInvoiceNo(raw))

  return Array.from(candidates).filter(Boolean)
}

export default function DigitalInvoice() {
  const { id } = useParams()
  const navigate = useNavigate()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [invoice, setInvoice] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [downloadingPdf, setDownloadingPdf] = useState(false)
  const invoiceElementRef = useRef<HTMLDivElement>(null)

  const handleBack = () => {
    const currentPath = window.location.pathname
    const hasInternalHistory =
      (window.history.state && typeof window.history.state.idx === 'number' && window.history.state.idx > 0) ||
      (Boolean(document.referrer) && document.referrer.startsWith(window.location.origin))

    if (hasInternalHistory && window.history.length > 1) {
      navigate(-1)
      // Fallback in case navigate(-1) had no effect
      setTimeout(() => {
        if (window.location.pathname === currentPath) {
          navigate('/dashboard')
        }
      }, 200)
    } else {
      navigate('/dashboard')
    }
  }

  useEffect(() => {
    async function loadInvoice() {
      try {
        const rawId = decodeURIComponent(id || '').trim()
        if (!rawId) {
          throw new Error('Invoice not found')
        }

        const candidates = buildLookupCandidates(rawId)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let row: any = null

        // One public lookup per candidate, in priority order (the server rate-limits per IP, answers a miss with a
        // generic "not found", and returns exactly one bill: an order, or an advance order).
        for (const candidate of candidates) {
          try {
            const res = await api<{ kind: 'order' | 'advance'; order: any }>('GET', `/api/public/invoice/${encodeURIComponent(candidate)}`)
            if (res.kind === 'order') {
              row = { ...res.order, branch: res.order.branch_id }
            } else {
              const adv = res.order
              const advItems = Array.isArray(adv.products) && adv.products.length > 0
                ? adv.products
                : [{
                    name: adv.product_name || 'Advance Order Item',
                    quantity: 1,
                    unit: 'piece',
                    unit_type: 'unit',
                    base_price: adv.total_amount,
                    line_total: adv.total_amount,
                  }]
              row = {
                id: adv.completed_order_id || adv.id,
                invoice_no: adv.invoice_number || adv.deposit_id,
                customer_name: adv.customer_name,
                phone: adv.phone,
                address: adv.address || '',
                items: advItems,
                total: adv.total_amount,
                subtotal: adv.total_amount,
                delivery_charge: 0,
                discount_amount: 0,
                manual_discount_amount: 0,
                total_gst: 0,
                gst_amount: 0,
                status: adv.status,
                payment_mode: adv.final_payment_method || 'Advance Payment',
                created_at: adv.completed_at || adv.created_at,
                branch: adv.branch_id,
              }
            }
            break
          } catch (err) {
            if (err instanceof ApiClientError && err.status === 429) throw new Error('Too many lookups. Please try again in a few minutes.')
            // not found for this candidate: try the next one
          }
        }

        if (!row) throw new Error('Invoice not found')

        setInvoice(row)
      } catch (err: unknown) {
        if (err instanceof Error) {
          setError(err.message)
        } else {
          setError('Invoice not found')
        }
      } finally {
        setLoading(false)
      }
    }
    if (id) loadInvoice()
  }, [id])

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f9faf6] flex items-center justify-center">
        <span className="w-8 h-8 border-4 border-sand border-t-sageDark rounded-full animate-spin" />
      </div>
    )
  }

  if (error || !invoice) {
    return (
      <div className="min-h-screen bg-[#f9faf6] flex flex-col items-center justify-center text-center p-6">
        <h1 className="text-2xl font-bold text-sageDark mb-2">Invoice Not Found</h1>
        <p className="text-gray-500 mb-6">The requested invoice could not be found.</p>
        <button
          onClick={handleBack}
          className="inline-flex items-center gap-2 px-6 py-2 bg-sage text-white rounded-full font-bold hover:bg-sageDark transition cursor-pointer"
        >
          <ArrowLeft size={16} /> Back
        </button>
      </div>
    )
  }

  const invoiceItems = (Array.isArray(invoice.items) ? invoice.items : [])
    .map((item: Record<string, unknown>) => normalizeStructuredOrderItem(item))
  const subtotal = invoiceItems.reduce((sum: number, item: ReturnType<typeof normalizeStructuredOrderItem>) => sum + item.line_total, 0)
  // "Cash ₹100.00 + QR ₹900.00" for a split bill, "Cash" / "QR" / "Card" otherwise
  const payLabel = formatPaymentMode(invoice.payment_mode || invoice.payment_method, invoice.split_details)
  const deliveryCharge = Number(invoice.delivery_charge) || Number(invoice.shipping) || 0

  const downloadPdf = async () => {
    if (downloadingPdf) return

    // iOS detection: Safari on iOS requires window.open to be called synchronously inside user gesture
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

    let pdfWindow: Window | null = null
    if (isIOS) {
      pdfWindow = window.open('about:blank', '_blank')
      if (pdfWindow) {
        try {
          pdfWindow.document.title = `Invoice #${invoice.invoice_no}`
          pdfWindow.document.body.innerHTML = `
            <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#FBFAF6;color:#111;">
              <div style="text-align:center;padding:20px;">
                <div style="width:36px;height:36px;border:3px solid #E8D399;border-top-color:${THEME_PALETTE.primary};border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 16px auto;"></div>
                <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
                <h3 style="margin:0 0 6px 0;font-size:17px;font-weight:700;">Generating PDF Invoice...</h3>
                <p style="margin:0;font-size:13px;color:#666;">Please wait a moment</p>
              </div>
            </div>
          `
        } catch { /* ignore cross-origin */ }
      }
    }

    setDownloadingPdf(true)
    try {
      // Use jsPDF-based generation which is more reliable and matches tax invoice format
      const invoiceItems = (Array.isArray(invoice.items) ? invoice.items : [])
        .map((item: Record<string, unknown>) => normalizeStructuredOrderItem(item))

      const file = invoicePdfFile({
        invoiceNo: invoice.invoice_no,
        date: invoice.created_at,
        customerName: invoice.customer_name || 'Walk-in Customer',
        phone: invoice.phone || '',
        address: invoice.address || '',
        branch: invoice.branch as any,
        items: invoice.items || [],
        subtotal: invoiceItems.reduce((sum: number, item: any) => sum + (item.line_total || 0), 0),
        shipping: deliveryCharge,
        total: invoice.total || 0,
        discountAmount: invoice.discount_amount,
        manualDiscountAmount: invoice.manual_discount_amount,
        gstAmount: invoice.gst_amount,
        couponCode: invoice.coupon_code,
        paymentMode: payLabel,
      })

      if (!file || file.size === 0) {
        console.error('Generated PDF file is empty')
        alert('Failed to generate PDF. Please try again.')
        return
      }

      const url = URL.createObjectURL(file)

      if (!url) {
        console.error('Failed to create object URL for PDF')
        alert('Failed to download PDF. Please try again.')
        return
      }

      if (isIOS) {
        if (pdfWindow && !pdfWindow.closed) {
          pdfWindow.location.href = url
        } else {
          window.location.href = url
        }
      } else {
        const link = document.createElement('a')
        link.href = url
        link.download = file.name
        link.style.display = 'none'
        document.body.appendChild(link)

        // Trigger click and wait a bit before cleaning up
        link.click()
        setTimeout(() => {
          document.body.removeChild(link)
          URL.revokeObjectURL(url)
        }, 100)
      }

      setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (err) {
      console.error('Failed to download invoice PDF:', err)
      alert(`Error: ${err instanceof Error ? err.message : 'Failed to generate PDF'}`)
      if (pdfWindow && !pdfWindow.closed) {
        pdfWindow.close()
      }
    } finally {
      setDownloadingPdf(false)
    }
  }

  // WhatsApp = the invoice PDF only (no text, no link to this page), from the tap on the WhatsApp button.
  const shareViaWhatsApp = () => {
    const pdfUrl = invoice.pdf_url || invoice.invoice_pdf_url
    const shareItems = (Array.isArray(invoice.items) ? invoice.items : []).map((item: Record<string, unknown>) => normalizeStructuredOrderItem(item))
    const pdf = pdfNamed(invoicePdfFile({
      invoiceNo: invoice.invoice_no,
      date: invoice.created_at,
      customerName: invoice.customer_name || 'Walk-in Customer',
      phone: invoice.phone || '',
      address: invoice.address || '',
      branch: invoice.branch as any,
      items: invoice.items || [],
      subtotal: shareItems.reduce((sum: number, item: any) => sum + (item.line_total || 0), 0),
      shipping: deliveryCharge,
      total: invoice.total || 0,
      discountAmount: invoice.discount_amount,
      manualDiscountAmount: invoice.manual_discount_amount,
      gstAmount: invoice.gst_amount,
      couponCode: invoice.coupon_code,
      paymentMode: payLabel,
    }), invoicePdfShareName(invoice.invoice_no))
    void sharePdfOnWhatsApp(pdf, invoice.phone)

    // Proactively upload invoice PDF in background if needed
    if (!pdfUrl) {
      void (async () => {
        try {
          const invoiceItems = (Array.isArray(invoice.items) ? invoice.items : [])
            .map((item: Record<string, unknown>) => normalizeStructuredOrderItem(item))

          const file = invoicePdfFile({
            invoiceNo: invoice.invoice_no,
            date: invoice.created_at,
            customerName: invoice.customer_name || 'Walk-in Customer',
            phone: invoice.phone || '',
            address: invoice.address || '',
            branch: invoice.branch as any,
            items: invoice.items || [],
            subtotal: invoiceItems.reduce((sum: number, item: any) => sum + (item.line_total || 0), 0),
            shipping: deliveryCharge,
            total: invoice.total || 0,
            discountAmount: invoice.discount_amount,
            manualDiscountAmount: invoice.manual_discount_amount,
            gstAmount: invoice.gst_amount,
            couponCode: invoice.coupon_code,
            paymentMode: payLabel,
          })
          await uploadInvoicePdf(file, invoice.invoice_no)
        } catch { /* best-effort background upload */ }
      })()
    }
  }

  const printReceipt = () => {
    printThermalReceipt({
      invoiceNo: invoice.invoice_no,
      date: invoice.created_at,
      customerName: invoice.customer_name,
      phone: invoice.phone,
      branch: invoice.branch,
      items: (invoice.items || []).map((item: Record<string, unknown>) => ({
        name: item.name || item.product_name,
        qty: item.qty || item.quantity,
        unit: item.unit,
        price: item.price || item.base_price || 0,
        line_total: item.line_total
      })),
      subtotal,
      shipping: deliveryCharge,
      couponDiscount: invoice.discount_amount || 0,
      manualDiscount: invoice.manual_discount_amount || 0,
      totalGst: invoice.total_gst || invoice.gst_amount || 0,
      total: invoice.total > 0 ? invoice.total : (subtotal + (invoice.delivery_charge || 0) + (invoice.total_gst || invoice.gst_amount || 0) - (invoice.discount_amount || 0) - (invoice.manual_discount_amount || 0)),
      paymentMode: payLabel,
    })
  }

  return (
    <div className="digital-invoice-page bg-[#f9faf6] font-sans h-[100dvh] max-h-[100dvh] flex flex-col justify-between overflow-hidden print:h-auto print:max-h-none print:overflow-visible print:bg-white print:m-0 print:p-0">
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain print:overflow-visible">
        {/* Top action bar — uses position fixed so it always works on iOS regardless of scroll context */}
      <div className="bg-[#f9faf6]/95 backdrop-blur-sm p-4 fixed top-0 left-0 right-0 z-50 print:hidden flex items-center justify-between safe-area-inset-top" style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }}>
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center gap-2 text-[#7A1220] hover:text-[#8A6A0A] font-semibold text-sm transition-colors bg-white border border-[#E8D399] px-4 py-2 rounded-full shadow-sm cursor-pointer active:scale-95 touch-manipulation select-none"
        >
          <ArrowLeft size={16} /> Back
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={downloadPdf}
            disabled={downloadingPdf}
            className="flex items-center gap-2 bg-[#7A1220] text-white border border-[#D4AF37] px-4 py-2 rounded-full font-bold text-sm shadow-md hover:bg-[#1A1A1A] transition-all cursor-pointer active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation select-none"
          >
            <Printer size={16} /> {downloadingPdf ? 'Generating...' : <><span className="hidden sm:inline">PDF Invoice</span><span className="sm:hidden">PDF</span></>}
          </button>
          <button
            type="button"
            onClick={shareViaWhatsApp}
            className="flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-full font-bold text-sm shadow-md hover:bg-emerald-700 transition-colors cursor-pointer active:scale-95 touch-manipulation select-none"
          >
            <MessageCircle size={16} /> WhatsApp
          </button>
        </div>
      </div>

      {/* Spacer to push content below fixed bar */}
      <div className="h-16 print:hidden" style={{ height: 'max(64px, calc(64px + env(safe-area-inset-top)))' }} />

      <div className="max-w-3xl mx-auto pb-12 print:mt-0 print:mb-0 print:p-0 print:max-w-full px-2 sm:px-0">
        <div ref={invoiceElementRef} className="bg-white shadow-xl rounded-2xl print:shadow-none print:rounded-none border border-sand/20 print:border-none print:m-0 print:p-0">
          <Invoice
            invoiceNo={invoice.invoice_no}
            date={invoice.created_at}
            customerName={invoice.customer_name}
            phone={invoice.phone}
            address={invoice.address}
            branch={invoice.branch}
            items={invoice.items || []}
            subtotal={subtotal}
            shipping={deliveryCharge}
            discountAmount={invoice.discount_amount || 0}
            manualDiscountAmount={invoice.manual_discount_amount || 0}
            gstAmount={invoice.total_gst || invoice.gst_amount || 0}
            couponCode={invoice.coupon_code}
            total={invoice.total > 0 ? invoice.total : (subtotal + (invoice.delivery_charge || 0) + (invoice.total_gst || invoice.gst_amount || 0) - (invoice.discount_amount || 0) - (invoice.manual_discount_amount || 0))}
            status={invoice.status}
            paymentMode={payLabel}
          />
        </div>
      </div>
      </div>
      <CenexaFooter />
    </div>
  )
}
