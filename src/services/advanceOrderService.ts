import { api, ApiClientError } from '../lib/apiClient'
import type { PosBranch } from '../store/store'

export type AdvanceStatus = 'pending_deposit' | 'ready_for_delivery' | 'waiting_final_payment' | 'completed' | 'cancelled'
export type AdvancePaymentMethod = 'cash' | 'upi' | 'card'

export type AdvanceOrder = {
  id: string
  deposit_id: string
  customer_name: string
  phone: string
  address: string
  product_name: string
  products: Array<Record<string, unknown>>
  category: string
  description: string
  total_amount: number
  deposit_amount: number
  remaining_balance: number
  expected_delivery_date: string
  status: AdvanceStatus
  remarks: string
  reference_number: string
  created_by_name: string
  created_at: string
  updated_at: string
  completed_at: string | null
  completed_order_id: string | null
  invoice_number: string | null
  final_payment_method: string | null
  branch: PosBranch
}

export type AdvanceTimeline = { id: number; advance_order_id: string; event_type: string; label: string; remarks: string; created_at: string }
export type AdvancePayment = { id: string; advance_order_id: string; payment_type: 'deposit' | 'remaining'; amount: number; payment_method: string; remarks: string; received_at: string }

const normalizeOrder = (row: Record<string, unknown>): AdvanceOrder => ({
  ...row,
  id: String(row.id || ''),
  deposit_id: String(row.deposit_id || ''),
  customer_name: String(row.customer_name || ''),
  phone: String(row.phone || ''),
  address: String(row.address || ''),
  product_name: String(row.product_name || ''),
  products: Array.isArray(row.products) ? (row.products as Array<Record<string, unknown>>) : [],
  category: String(row.category || ''),
  description: String(row.description || ''),
  total_amount: Number(row.total_amount || 0),
  deposit_amount: Number(row.deposit_amount || 0),
  remaining_balance: Number(row.remaining_balance ?? (Number(row.total_amount || 0) - Number(row.deposit_amount || 0))),
  expected_delivery_date: String(row.expected_delivery_date || ''),
  status: String(row.status || 'pending_deposit') as AdvanceStatus,
  remarks: String(row.remarks || ''),
  reference_number: String(row.reference_number || ''),
  created_by_name: String(row.created_by_name || ''),
  created_at: String(row.created_at || new Date().toISOString()),
  updated_at: String(row.updated_at || new Date().toISOString()),
  completed_at: row.completed_at ? String(row.completed_at) : null,
  completed_order_id: row.completed_order_id ? String(row.completed_order_id) : null,
  invoice_number: row.invoice_number ? String(row.invoice_number) : null,
  final_payment_method: row.final_payment_method ? String(row.final_payment_method) : null,
  branch: (['pos1', 'pos2', 'pos3'].includes(String(row.branch_id ?? row.branch)) ? String(row.branch_id ?? row.branch) : 'pos1') as PosBranch,
})

export async function deleteAdvanceOrder(orderId: string): Promise<void> {
  // the server deletes the advance order and, in the same transaction, the bill it produced (this branch only)
  await api('DELETE', `/api/advance-orders/${orderId}`)
}

export async function listAdvanceOrders(branch: PosBranch = 'pos1'): Promise<AdvanceOrder[]> {
  const res = await api<{ orders: Array<Record<string, unknown>> }>('GET', '/api/advance-orders', { branchId: branch })
  return res.orders.map(normalizeOrder)
}

export async function getAdvanceOrderHistory(orderId: string) {
  const res = await api<{ timeline: AdvanceTimeline[]; payments: AdvancePayment[] }>('GET', `/api/advance-orders/${orderId}/history`)
  return { timeline: res.timeline, payments: res.payments }
}

export async function createAdvanceOrder(input: {
  customerName: string; phone: string; address: string; productName: string; category: string; description: string
  totalAmount: number; depositAmount: number; expectedDeliveryDate: string; remarks: string; referenceNumber: string
  paymentMethod: AdvancePaymentMethod; createdByName: string; products?: Array<Record<string, unknown>>; branch?: PosBranch
}): Promise<AdvanceOrder> {
  const res = await api<{ order: Record<string, unknown> }>('POST', '/api/advance-orders', {
    body: {
      customer_name: input.customerName, phone: input.phone, address: input.address, product_name: input.productName,
      category: input.category, description: input.description, total_amount: input.totalAmount,
      deposit_amount: input.depositAmount, expected_delivery_date: input.expectedDeliveryDate, remarks: input.remarks,
      payment_method: input.paymentMethod, products: input.products || [],
      ...(input.referenceNumber.trim() ? { reference_number: input.referenceNumber.trim() } : {}),
    },
    branchId: input.branch,
  })
  const created = normalizeOrder(res.order)
  if (input.referenceNumber.trim()) created.reference_number = input.referenceNumber.trim()
  return created
}

export async function updateAdvanceStatus(orderId: string, status: AdvanceStatus, remarks = ''): Promise<AdvanceOrder> {
  const res = await api<{ order: Record<string, unknown> }>('POST', `/api/advance-orders/${orderId}/status`, { body: { status, remarks } })
  return normalizeOrder(res.order)
}

export async function addAdvanceEvent(orderId: string, eventType: string, label: string, remarks = '') {
  await api('POST', `/api/advance-orders/${orderId}/events`, { body: { event_type: eventType, label, remarks } })
}

export async function completeAdvanceOrder(
  orderId: string,
  paymentMethod: AdvancePaymentMethod,
  finalAmount: number,
  couponCode: string | null = null,
  couponPercentage: number = 0,
  manualDiscountAmount: number = 0,
  remarks = ''
) {
  try {
    const res = await api<{ result: { order_id: string; invoice_no: string; completed_at: string } }>('POST', `/api/advance-orders/${orderId}/complete`, {
      body: {
        payment_method: paymentMethod,
        final_amount: finalAmount,
        coupon_code: couponCode,
        coupon_percentage: couponPercentage,
        manual_discount: manualDiscountAmount,
        remarks,
      },
    })
    return res.result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof ApiClientError && (message.includes('already generated') || message.includes('already completed'))) {
      // Self-heal: order was already completed with invoice
      const existing = (await listAdvanceOrders()).find((o) => o.id === orderId)
      if (existing && (existing.invoice_number || existing.completed_order_id)) {
        return {
          order_id: existing.completed_order_id || existing.id,
          invoice_no: existing.invoice_number || 'INV-COMPLETED',
          completed_at: existing.completed_at || new Date().toISOString(),
        }
      }
      throw new Error('This order has already been completed.')
    }
    alert(`Backend Error: ${message}`)
    throw err
  }
}
