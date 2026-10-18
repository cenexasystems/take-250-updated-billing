/** Refund / payment modes as the database stores them (0015): cash, card, qr, other. 'original' (the bill's own modes) is
 *  only on returns stored before 0017: a new return goes to ONE mode. */
export type PayMode = 'cash' | 'card' | 'qr' | 'other'
export type RefundMode = PayMode | 'original'
export const PAY_MODES: PayMode[] = ['cash', 'card', 'qr', 'other']
export const payModeLabel = (m: string) => (m === 'cash' ? 'Cash' : m === 'card' ? 'Card' : m === 'qr' ? 'QR' : 'Other')

/** The Return modal's Refund mode choices (0017): single modes only; the stored value stays 'qr' for GPay / QR. */
export const REFUND_MODE_CHOICES: Array<{ value: PayMode; label: string }> = [
  { value: 'cash', label: 'Cash' }, { value: 'qr', label: 'GPay / QR' }, { value: 'card', label: 'Card' }, { value: 'other', label: 'Other' },
]
export const OTHER_MODE_MAX = 40
/** The typed "Other" mode as stored: control characters out, spaces collapsed, at most 40 characters. */
// eslint-disable-next-line no-control-regex -- strips control characters from the typed mode
export const cleanModeLabel = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, OTHER_MODE_MAX)
const otherText = (label?: string | null) => (label ? `Other (${label})` : 'Other')

/** {"cash": 180, "card": 120} -> [{ label: 'Cash', amount: 180 }, ...] in the fixed mode order; without a split: one line.
 *  `otherLabel`: what was typed for "Other" (one return, or a bill's returns joined), shown as "Other (Store credit)". */
export function refundModeLines(refunds: Record<string, number> | null | undefined, mode?: string, total?: number, otherLabel?: string | null): Array<{ label: string; amount: number }> {
  const lines = PAY_MODES.filter((m) => Number(refunds?.[m] || 0) > 0).map((m) => ({ label: m === 'other' ? otherText(otherLabel) : payModeLabel(m), amount: Number(refunds?.[m]) }))
  if (lines.length) return lines
  return mode && total !== undefined ? [{ label: mode === 'original' ? 'Original payment mode' : mode === 'other' ? otherText(otherLabel) : payModeLabel(mode), amount: total }] : []
}

/** "Cash ₹180.00 + Card ₹120.00" */
export const refundModeText = (refunds: Record<string, number> | null | undefined, fmt: (n: number) => string, mode?: string, total?: number, otherLabel?: string | null) =>
  refundModeLines(refunds, mode, total, otherLabel).map((l) => `${l.label} ${fmt(l.amount)}`).join(' + ')
