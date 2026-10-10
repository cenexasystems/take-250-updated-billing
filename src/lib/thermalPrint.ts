import { BRAND_EN } from './brand'
import { thermalLogoFor } from './branchLogo'
import { formatCurrency, formatInvoiceNo, formatQuantityValue } from './retail'
import type { InvoiceDoc } from './invoiceDoc'
import { formatPhoneForDisplay } from './phone'
import type { PosBranch } from '../store/store'
import { getBranchProfile } from './branchProfile'
import { useSettingsStore } from '../store/store'

/** The thermal receipt draws the shared invoice data (src/lib/invoiceDoc.ts), like the screen and the PDF. */
export type ThermalReceiptData = InvoiceDoc & {
  storeName?: string
  storePhone?: string
  storeAddress?: string
  storeEmail?: string
}

export function printThermalReceipt(data: ThermalReceiptData) {
  try {
    const profile = getBranchProfile(data.branch)
    // Embedded black-on-white logo prints instantly; a custom logo from Store Settings is used when one is uploaded
    const logoSrc = thermalLogoFor(data.branch)
    // Create an isolated print iframe protected from third-party extension observers
    const iframe = document.createElement('iframe')
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0.01;pointer-events:none;z-index:-1;'
    iframe.setAttribute('aria-hidden', 'true')
    iframe.setAttribute('tabindex', '-1')
    iframe.setAttribute('data-gramm', 'false')
    iframe.setAttribute('data-gramm_editor', 'false')
    iframe.setAttribute('data-enable-grammarly', 'false')
    iframe.setAttribute('spellcheck', 'false')
    document.body.appendChild(iframe)

    const doc = iframe.contentWindow?.document
    if (!doc) {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe)
      return
    }

    const dateStr = (() => {
      try { return new Date(data.date).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) }
      catch { return new Date().toLocaleString('en-IN') }
    })()

    const html = `
      <!DOCTYPE html>
      <html lang="en" data-gramm="false" data-gramm_editor="false" data-enable-grammarly="false" spellcheck="false">
        <head>
          <meta charset="UTF-8">
          <meta name="grammarly" content="off">
          <meta name="robots" content="noindex,nofollow">
          <title>Receipt - ${data.invoiceNo}</title>
        <style>
          @page {
            margin: 0;
            size: 80mm auto;
          }
          body {
            font-family: 'Courier New', Courier, monospace, sans-serif;
            font-size: 12px;
            color: #000;
            margin: 0;
            padding: 4mm;
            width: 80mm;
            box-sizing: border-box;
          }
          .text-center { text-align: center; }
          .text-right { text-align: right; }
          .text-left { text-align: left; }
          .font-bold { font-weight: bold; }
          .mb-1 { margin-bottom: 4px; }
          .mb-2 { margin-bottom: 8px; }
          .mt-1 { margin-top: 4px; }
          .mt-2 { margin-top: 8px; }
          .border-bottom { border-bottom: 1px dashed #000; padding-bottom: 4px; margin-bottom: 4px; }
          .border-top { border-top: 1px dashed #000; padding-top: 4px; margin-top: 4px; }
          table { width: 100%; border-collapse: collapse; }
          th, td { padding: 2px 0; vertical-align: top; }
          .item-name { font-size: 11px; padding-right: 4px; }
        </style>
      </head>
      <body>
        <div class="text-center mb-2">
          <img src="${logoSrc}" style="width: 64px; height: 64px; object-fit: contain; margin: 0 auto 8px auto; display: block;" alt="Logo" />
          <div class="font-bold" style="font-size: 16px; letter-spacing: 2px;">${data.storeName || getBranchProfile(data.branch).name || BRAND_EN}</div>
          <div style="font-size: 10px; margin-top: 2px;">${data.storeAddress || profile.address}</div>
          <div class="mt-1" style="font-size: 10px;">Ph: ${data.storePhone || profile.phone}</div>
          <div style="font-size: 9px; color: #333;">${data.storeEmail || profile.email}</div>
        </div>

        <div class="border-bottom border-top" style="font-size: 11px;">
          <div>Inv: #${formatInvoiceNo(data.invoiceNo)}</div>
          <div>Date: ${dateStr}</div>
          ${!data.payment.split ? `<div>Payment: ${data.payment.label}</div>` : `<div>Payment (Split)</div>${data.payment.parts.map((p) => `<div style="display:flex;justify-content:space-between;padding-left:8px;"><span>${p.label}</span><span>${formatCurrency(p.amount)}</span></div>`).join('')}`}
          ${data.returns ? `<div class="font-bold mt-1">${data.returns.badge}</div><div style="font-size: 9px;">${data.returns.records.join(' / ')}</div>` : ''}
          ${data.customerName ? `<div>Name: ${data.customerName}</div>` : ''}
          ${data.phone ? `<div>Tel: ${formatPhoneForDisplay(data.phone)}</div>` : ''}
        </div>

        <table class="border-bottom" style="width: 100%; table-layout: fixed; border-collapse: collapse;">
          <thead>
            <tr style="font-size: 10px; border-bottom: 1px dashed #000;">
              <th style="width: 50%; text-align: left; padding: 4px 0;">Item Name</th>
              <th style="width: 18%; text-align: center; padding: 4px 0;">Qty</th>
              <th style="width: 32%; text-align: right; padding: 4px 0;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${data.items.map(item => {
              const lineTotal = item.line_total
              const unit = item.unit && item.unit !== 'unit' && item.unit !== 'piece' ? item.unit : ''
              const rateDisplay = `${formatCurrency(item.base_price)}${unit ? `/${unit}` : ''}`
              return `
                <tr>
                  <td style="text-align: left; padding: 3px 2px 3px 0; vertical-align: top; word-break: break-word;">
                    <div style="font-size: 11px; font-weight: bold; line-height: 1.25;">${item.name}</div>
                    <div style="font-size: 9px; color: #444; margin-top: 1px;">@ ${rateDisplay}</div>
                    ${item.returnNote ? `<div style="font-size: 9px; font-weight: bold; margin-top: 1px;">${item.returnNote}</div>` : ''}
                  </td>
                  <td style="text-align: center; vertical-align: top; padding: 3px 0; font-size: 11px;">
                    ${formatQuantityValue(item.quantity)}
                  </td>
                  <td style="text-align: right; vertical-align: top; padding: 3px 0; font-size: 11px; font-weight: bold;">
                    ${formatCurrency(lineTotal)}
                  </td>
                </tr>
              `
            }).join('')}
          </tbody>
        </table>

        <div class="border-bottom" style="font-size: 12px;">
          <table style="width: 100%;">
            ${data.rows.filter((r) => r.kind !== 'subtotal' || data.rows.length > 1 || r.amount !== data.total).map((r) => `
              <tr${r.kind === 'tax' ? ' style="font-size: 10px;"' : ''}>
                <td class="text-left">${r.label}</td>
                <td class="text-right">${r.kind === 'discount' ? '-' : r.kind === 'tax' ? '+' : ''}${formatCurrency(r.amount)}</td>
              </tr>`).join('')}
            <tr class="font-bold" style="font-size: 14px;">
              <td class="text-left">Total</td>
              <td class="text-right">${formatCurrency(data.total)}</td>
            </tr>
            ${data.advance ? [
              ...data.advance.deposits.map((d) => `<tr style="font-size: 10px;"><td class="text-left">${d.label}</td><td class="text-right">${formatCurrency(d.amount)}</td></tr>`),
              data.advance.balance ? `<tr style="font-size: 10px;"><td class="text-left">${data.advance.balance.label}</td><td class="text-right">${formatCurrency(data.advance.balance.amount)}</td></tr>` : '',
              ...(data.advance.balance?.parts ?? []).map((p) => `<tr style="font-size: 10px;"><td class="text-left" style="padding-left: 8px;">${p.label}</td><td class="text-right">${formatCurrency(p.amount)}</td></tr>`),
            ].join('') : ''}
            ${data.returns ? `
              <tr><td class="text-left">Returned</td><td class="text-right">-${formatCurrency(data.returns.returned)}</td></tr>
              <tr class="font-bold"><td class="text-left">Net amount</td><td class="text-right">${formatCurrency(data.returns.net)}</td></tr>` : ''}
          </table>
        </div>

        <div class="text-center mt-2" style="font-size: 11px;">
          <div class="font-bold">Thank you for shopping at ${getBranchProfile(data.branch).name || BRAND_EN}!</div>
        </div>
      </body>
    </html>
  `

    doc.open()
    doc.write(html)
    doc.close()

    const cleanup = () => {
      try {
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe)
        }
      } catch {}
    }

    // Wait for resources to load, then print safely
    setTimeout(() => {
      try {
        if (iframe.contentWindow) {
          iframe.contentWindow.onbeforeunload = null
          iframe.contentWindow.onunload = null
          iframe.contentWindow.onafterprint = cleanup
          iframe.contentWindow.focus()
          iframe.contentWindow.print()
        }
      } catch (printErr) {
        console.warn('[thermalPrint] Print execution error:', printErr)
      } finally {
        setTimeout(cleanup, 2000)
      }
    }, 250)
  } catch (err) {
    console.warn('[thermalPrint] Failed to print receipt:', err)
  }
}

export interface ReturnReceiptData {
  returnNo: string
  originalInvoiceNo: string
  date: string
  branch?: PosBranch
  reason: string
  note?: string
  refundMode: 'cash' | 'original'
  createdByRole?: string
  items: Array<{ name: string; qty: number; refund: number; restocked?: boolean }>
  refundTotal: number
}

/** Return / credit receipt: the same 80 mm look as the sale receipt (same header, fonts and table), its own RET- number,
 * and the ORIGINAL invoice number it refers to. The original bill and its PDF are never touched. */
export function printReturnReceipt(data: ReturnReceiptData) {
  try {
    const profile = getBranchProfile(data.branch)
    const logoSrc = thermalLogoFor(data.branch)
    const iframe = document.createElement('iframe')
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0.01;pointer-events:none;z-index:-1;'
    iframe.setAttribute('aria-hidden', 'true')
    iframe.setAttribute('tabindex', '-1')
    document.body.appendChild(iframe)
    const doc = iframe.contentWindow?.document
    if (!doc) { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); return }
    const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
    const dateStr = (() => {
      try { return new Date(data.date).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) }
      catch { return new Date().toLocaleString('en-IN') }
    })()
    const html = `
      <!DOCTYPE html>
      <html lang="en"><head><meta charset="UTF-8"><meta name="robots" content="noindex,nofollow"><title>Return Receipt - ${esc(data.returnNo)}</title>
      <style>
        @page { margin: 0; size: 80mm auto; }
        body { font-family: 'Courier New', Courier, monospace, sans-serif; font-size: 12px; color: #000; margin: 0; padding: 4mm; width: 80mm; box-sizing: border-box; }
        .text-center { text-align: center; } .text-right { text-align: right; } .text-left { text-align: left; } .font-bold { font-weight: bold; }
        .mb-2 { margin-bottom: 8px; } .mt-1 { margin-top: 4px; } .mt-2 { margin-top: 8px; }
        .border-bottom { border-bottom: 1px dashed #000; padding-bottom: 4px; margin-bottom: 4px; }
        .border-top { border-top: 1px dashed #000; padding-top: 4px; margin-top: 4px; }
        table { width: 100%; border-collapse: collapse; } th, td { padding: 2px 0; vertical-align: top; }
      </style></head>
      <body>
        <div class="text-center mb-2">
          <img src="${logoSrc}" style="width: 64px; height: 64px; object-fit: contain; margin: 0 auto 8px auto; display: block;" alt="Logo" />
          <div class="font-bold" style="font-size: 16px; letter-spacing: 2px;">${esc(getBranchProfile(data.branch).name || BRAND_EN)}</div>
          <div style="font-size: 10px; margin-top: 2px;">${esc(profile.address)}</div>
          <div class="mt-1" style="font-size: 10px;">Ph: ${esc(profile.phone)}</div>
          <div style="font-size: 9px; color: #333;">${esc(profile.email)}</div>
        </div>
        <div class="text-center font-bold mb-2" style="font-size: 14px; letter-spacing: 1px;">RETURN RECEIPT</div>
        <div class="border-bottom border-top" style="font-size: 11px;">
          <div>Return: ${esc(data.returnNo)}</div>
          <div>Original Inv: #${esc(formatInvoiceNo(data.originalInvoiceNo))}</div>
          <div>Date: ${esc(dateStr)}</div>
          <div>Reason: ${esc(data.reason)}${data.note ? ` (${esc(data.note)})` : ''}</div>
          <div>Refund: ${data.refundMode === 'cash' ? 'Cash' : 'Original payment mode'}</div>
        </div>
        <table class="border-bottom" style="width: 100%; table-layout: fixed; border-collapse: collapse;">
          <thead><tr style="font-size: 10px; border-bottom: 1px dashed #000;">
            <th style="width: 50%; text-align: left; padding: 4px 0;">Item Name</th>
            <th style="width: 18%; text-align: center; padding: 4px 0;">Qty</th>
            <th style="width: 32%; text-align: right; padding: 4px 0;">Refund</th>
          </tr></thead>
          <tbody>
            ${data.items.map((it) => `
              <tr>
                <td style="text-align: left; padding: 3px 2px 3px 0; word-break: break-word;"><div style="font-size: 11px; font-weight: bold; line-height: 1.25;">${esc(it.name)}</div>${it.restocked === false ? '<div style="font-size: 9px; color: #444;">damaged, not restocked</div>' : ''}</td>
                <td style="text-align: center; padding: 3px 0; font-size: 11px;">${it.qty}</td>
                <td style="text-align: right; padding: 3px 0; font-size: 11px; font-weight: bold;">${formatCurrency(it.refund)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        <div class="border-bottom" style="font-size: 12px;"><table style="width: 100%;"><tr class="font-bold" style="font-size: 14px;">
          <td class="text-left">Total Refund</td><td class="text-right">${formatCurrency(data.refundTotal)}</td></tr></table></div>
        <div class="text-center mt-2" style="font-size: 11px;"><div class="font-bold">Goods returned to ${esc(getBranchProfile(data.branch).name || BRAND_EN)}. This is not a tax invoice.</div></div>
      </body></html>`
    doc.open(); doc.write(html); doc.close()
    const cleanup = () => { try { if (iframe.parentNode) iframe.parentNode.removeChild(iframe) } catch { /* already gone */ } }
    setTimeout(() => {
      try {
        if (iframe.contentWindow) { iframe.contentWindow.onafterprint = cleanup; iframe.contentWindow.focus(); iframe.contentWindow.print() }
      } catch (printErr) { console.warn('[thermalPrint] Return receipt print error:', printErr) }
      finally { setTimeout(cleanup, 2000) }
    }, 250)
  } catch (err) {
    console.warn('[thermalPrint] Failed to print return receipt:', err)
  }
}
