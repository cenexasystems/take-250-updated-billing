import React from 'react'
import { BRAND_ICON, THEME_PALETTE } from '../lib/brand'
import { formatPhoneForDisplay } from '../lib/phone'
import { formatCurrency, formatQuantityValue, formatInvoiceNo } from '../lib/retail'
import type { InvoiceDoc } from '../lib/invoiceDoc'
import type { PosBranch } from '../store/store'
import { getBranchProfile } from '../lib/branchProfile'

export interface InvoiceProps {
  /** the shared invoice data (src/lib/invoiceDoc.ts): every output draws the same rows from it */
  doc: InvoiceDoc
  userId?: string
  onPrintReceipt?: () => void
}

export const Invoice: React.FC<InvoiceProps> = ({ doc, userId }) => {
  const { invoiceNo, date, customerName, phone, address, items, total, status, branch } = doc
  const formattedInvoiceNo = formatInvoiceNo(invoiceNo)
  const dateStr = (() => {
    try { return new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) }
    catch { return new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) }
  })()

  const statusColor = status === 'completed' ? THEME_PALETTE.accentDark : status === 'cancelled' ? '#b91c1c' : '#b45309'
  const row = { display: 'flex', justifyContent: 'space-between', marginBottom: 6 } as const
  const profile = getBranchProfile(branch)

  return (
    <div
      id="invoice-print-root"
      className="w-full max-w-[680px] mx-auto bg-white text-[#111111] box-border flex flex-col p-4 sm:p-8 print:p-0 print:max-w-full overflow-hidden border border-[#E8D399]/40 shadow-xl rounded-3xl print:min-h-[290mm]"
      style={{
        fontFamily: "'Inter', 'Segoe UI', sans-serif",
      }}
    >
      {/* ── HEADER ────────────────────────────────────────────────── */}
      <div className="invoice-header" style={{ textAlign: 'center', borderBottom: '1px solid #E8D399', paddingBottom: 20, marginBottom: 20 }}>
        <div style={{ width: 100, height: 100, margin: '0 auto 16px auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <img src={branch ? profile.logo : BRAND_ICON} alt={profile.name} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        </div>
        <div style={{ fontSize: 24, fontWeight: 900, color: THEME_PALETTE.primary, letterSpacing: 2, textTransform: 'uppercase' }}>
          {profile.name}
        </div>
        <div style={{ fontSize: 11, color: '#4b5563', marginTop: 4, fontWeight: 500, paddingLeft: 8, paddingRight: 8 }}>
          {profile.address}
        </div>
        <div style={{ fontSize: 11, color: '#4b5563', marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span>📞 {profile.phone}</span>
          <span>✉️ {profile.email}</span>
        </div>
      </div>

      {/* ── META ROW (Properly partitioned bill details) ─────────── */}
      <div className="invoice-meta grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div style={{ minWidth: 0, padding: '12px 14px', borderRadius: 12, background: '#FBFAF6', border: '1px solid #E8D399' }}>
          <div style={{ fontSize: 9, fontWeight: 800, color: '#6B7280', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Bill Details</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#666', textTransform: 'uppercase' }}>Invoice No</span>
            <span style={{ fontSize: 13, fontWeight: 900, color: THEME_PALETTE.primary }}>#{formattedInvoiceNo}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#666', textTransform: 'uppercase' }}>Date</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>{dateStr}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#666', textTransform: 'uppercase' }}>Status</span>
            <span
              style={{
                display: 'inline-block', padding: '2px 8px', borderRadius: 99,
                background: statusColor + '10', color: statusColor,
                fontSize: 9, fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', border: `1px solid ${statusColor}40`
              }}
            >
              {status.replace(/_/g, ' ')}
            </span>
          </div>
          {userId && (
            <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px dashed #e5e7eb', display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 9, fontWeight: 800, color: '#6B7280', textTransform: 'uppercase' }}>User ID</span>
              <span style={{ fontSize: 10, fontWeight: 600, color: '#555' }}>{userId}</span>
            </div>
          )}
        </div>

        <div style={{ minWidth: 0, padding: '12px 14px', borderRadius: 12, background: '#FBFAF6', border: '1px solid #E8D399', overflowWrap: 'anywhere' }}>
          <div style={{ fontSize: 9, fontWeight: 800, color: '#6B7280', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Customer Information</div>
          <div style={{ fontSize: 9, fontWeight: 800, color: '#6B7280', textTransform: 'uppercase', letterSpacing: 0.7, marginTop: 4 }}>Customer Name</div>
          <div style={{ fontSize: 13, fontWeight: 800, color: THEME_PALETTE.primary, lineHeight: 1.35, wordBreak: 'break-word' }}>{customerName || 'Walk-in Customer'}</div>
          <div style={{ fontSize: 9, fontWeight: 800, color: '#6B7280', textTransform: 'uppercase', letterSpacing: 0.7, marginTop: 6 }}>Mobile Number</div>
          <div style={{ fontSize: 12, color: '#555', lineHeight: 1.4, wordBreak: 'break-word' }}>{formatPhoneForDisplay(phone) || '—'}</div>
          {address && <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4, lineHeight: 1.4, wordBreak: 'break-word' }}>{address}</div>}
          {!doc.payment.split && <div style={{ fontSize: 10, color: '#6B7280', marginTop: 4 }}>Payment Mode: {doc.payment.label}</div>}
          {doc.payment.split && (
            <div style={{ fontSize: 10, color: '#6B7280', marginTop: 4 }} data-testid="invoice-payment-split">
              <div style={{ fontWeight: 700 }}>Payment (Split)</div>
              {doc.payment.parts.map((p, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', maxWidth: 200 }}><span>{p.label}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(p.amount)}</span></div>
              ))}
            </div>
          )}
        </div>
      </div>

      {doc.returns && (
        <div style={{ textAlign: 'center', marginBottom: 14 }} data-testid="invoice-return-status">
          <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 99, background: '#b4530910', color: '#b45309', fontSize: 9, fontWeight: 800, letterSpacing: 0.8, border: '1px solid #b4530940' }}>
            {doc.returns.badge}
          </span>
          <div style={{ fontSize: 10, color: '#6b7280', marginTop: 4 }}>{doc.returns.records.join(' · ')}</div>
        </div>
      )}

      {/* ── DIVIDER ──────────────────────────────────────────────── */}
      <div style={{ borderTop: '1px dashed #d0d0d0', marginBottom: 20 }} />

      {/* ── ITEMS TABLE ──────────────────────────────────────────── */}
      <div className="w-full overflow-x-auto">
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 320 }}>
          <thead>
            <tr style={{ background: THEME_PALETTE.primary, borderRadius: 8 }}>
              <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: THEME_PALETTE.onDark, textTransform: 'uppercase', letterSpacing: 0.8, width: 28 }}>#</th>
              <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: THEME_PALETTE.onDark, textTransform: 'uppercase', letterSpacing: 0.8 }}>Item / SKU</th>
              <th style={{ padding: '8px 10px', textAlign: 'center', fontSize: 10, fontWeight: 800, color: THEME_PALETTE.onDark, textTransform: 'uppercase', letterSpacing: 0.8, width: 45 }}>Qty</th>
              <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 10, fontWeight: 800, color: THEME_PALETTE.onDark, textTransform: 'uppercase', letterSpacing: 0.8, width: 75 }}>Rate</th>
              <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 10, fontWeight: 800, color: THEME_PALETTE.onDark, textTransform: 'uppercase', letterSpacing: 0.8, width: 85 }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((normalized, idx) => {
              const displayName = normalized.tamil_name || normalized.name
              return (
                <tr key={idx} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ padding: '10px 8px', fontSize: 11, color: '#6B7280', verticalAlign: 'top' }}>{idx + 1}</td>
                  <td style={{ padding: '10px 8px', verticalAlign: 'top' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: THEME_PALETTE.primary }}>{normalized.name}</div>
                    {displayName && displayName !== normalized.name && <div style={{ fontSize: 10, color: '#6B7280', marginTop: 2 }}>{displayName}</div>}
                    <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>
                      {normalized.unit} · {formatCurrency(normalized.base_price)}
                    </div>
                    {normalized.returnNote && <div style={{ fontSize: 10, color: '#b45309', marginTop: 2, fontWeight: 700 }} data-testid="invoice-return-note">{normalized.returnNote}</div>}
                  </td>
                  <td style={{ padding: '10px 8px', fontSize: 12, fontWeight: 600, textAlign: 'center', verticalAlign: 'top' }}>{formatQuantityValue(normalized.quantity)}</td>
                  <td style={{ padding: '10px 8px', fontSize: 12, fontWeight: 600, textAlign: 'right', verticalAlign: 'top', color: '#555', fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(normalized.base_price)}</td>
                  <td style={{ padding: '10px 8px', fontSize: 13, fontWeight: 800, textAlign: 'right', verticalAlign: 'top', color: THEME_PALETTE.primary, fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(normalized.line_total)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ── TOTALS ───────────────────────────────────────────────── */}
      <div className="invoice-totals" style={{ marginTop: 24, borderTop: '2px solid #D4AF37', paddingTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ minWidth: 240, width: '100%', maxWidth: 300 }}>
            {doc.rows.map((r, i) => r.kind === 'discount' ? (
              <div key={i} style={row}>
                <span style={{ fontSize: 12, color: THEME_PALETTE.accentDark, fontWeight: 600 }}>{r.label}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: THEME_PALETTE.accentDark, fontVariantNumeric: 'tabular-nums' }}>−{formatCurrency(r.amount)}</span>
              </div>
            ) : r.kind === 'tax' ? (
              <div key={i} style={row}>
                <span style={{ fontSize: 10, color: '#666' }}>{r.label}</span>
                <span style={{ fontSize: 10, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>+{formatCurrency(r.amount)}</span>
              </div>
            ) : (
              <div key={i} style={row}>
                <span style={{ fontSize: 12, color: '#666' }}>{r.label}</span>
                <span style={{ fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(r.amount)}</span>
              </div>
            ))}
            <div
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                borderTop: '2px solid #D4AF37', paddingTop: 10, marginTop: 4,
              }}
            >
              <span style={{ fontSize: 15, fontWeight: 900, color: THEME_PALETTE.primary, textTransform: 'uppercase', letterSpacing: 0.5 }}>Total</span>
              <span style={{ fontSize: 20, fontWeight: 900, color: THEME_PALETTE.primary, fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(total)}</span>
            </div>
            {doc.advance && (
              <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed #d0d0d0' }} data-testid="invoice-advance">
                {doc.advance.deposits.map((d, i) => (
                  <div key={i} style={row}><span style={{ fontSize: 12, color: '#666' }}>{d.label}</span><span style={{ fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(d.amount)}</span></div>
                ))}
                {doc.advance.balance && (
                  <>
                    <div style={row}><span style={{ fontSize: 12, color: '#666' }}>{doc.advance.balance.label}</span><span style={{ fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(doc.advance.balance.amount)}</span></div>
                    {doc.advance.balance.parts.map((p, i) => (
                      <div key={i} style={{ ...row, paddingLeft: 12 }}><span style={{ fontSize: 10, color: '#666' }}>{p.label}</span><span style={{ fontSize: 10, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(p.amount)}</span></div>
                    ))}
                  </>
                )}
              </div>
            )}
            {doc.returns && (
              <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed #d0d0d0' }} data-testid="invoice-returns-totals">
                <div style={row}><span style={{ fontSize: 12, color: '#b45309', fontWeight: 600 }}>Returned</span><span style={{ fontSize: 12, fontWeight: 700, color: '#b45309', fontVariantNumeric: 'tabular-nums' }}>−{formatCurrency(doc.returns.returned)}</span></div>
                <div style={row}><span style={{ fontSize: 13, fontWeight: 900, color: THEME_PALETTE.primary }}>Net amount</span><span style={{ fontSize: 14, fontWeight: 900, color: THEME_PALETTE.primary, fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(doc.returns.net)}</span></div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── FOOTER ───────────────────────────────────────────────── */}
      <div
        className="invoice-footer mt-auto"
        style={{
          marginTop: 'auto',
          paddingTop: 16,
          paddingBottom: 4,
          borderTop: '1px dashed #d0d0d0',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 800, color: THEME_PALETTE.primary, letterSpacing: 0.5 }}>
          Thank you for shopping at {profile.name}!
        </div>
      </div>
    </div>
  )
}
