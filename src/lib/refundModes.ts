/** Refund / payment modes as the database stores them (0015): cash, card, qr, other; 'original' = the bill's own mode(s). */
export type PayMode = 'cash' | 'card' | 'qr' | 'other'
export type RefundMode = PayMode | 'original'
export const PAY_MODES: PayMode[] = ['cash', 'card', 'qr', 'other']
export const payModeLabel = (m: string) => (m === 'cash' ? 'Cash' : m === 'card' ? 'Card' : m === 'qr' ? 'QR' : 'Other')

/** {"cash": 180, "card": 120} -> [{ label: 'Cash', amount: 180 }, ...] in the fixed mode order; without a split: one line */
export function refundModeLines(refunds: Record<string, number> | null | undefined, mode?: string, total?: number): Array<{ label: string; amount: number }> {
  const lines = PAY_MODES.filter((m) => Number(refunds?.[m] || 0) > 0).map((m) => ({ label: payModeLabel(m), amount: Number(refunds?.[m]) }))
  if (lines.length) return lines
  return mode && total !== undefined ? [{ label: mode === 'original' ? 'Original payment mode' : payModeLabel(mode), amount: total }] : []
}

/** "Cash ₹180.00 + Card ₹120.00" */
export const refundModeText = (refunds: Record<string, number> | null | undefined, fmt: (n: number) => string, mode?: string, total?: number) =>
  refundModeLines(refunds, mode, total).map((l) => `${l.label} ${fmt(l.amount)}`).join(' + ')
