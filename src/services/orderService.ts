import { api } from '../lib/apiClient'
import type { StructuredOrderItem } from '../lib/retail'
import type { PosBranch } from '../store/store'

type CreateOrderInput = {
  customerName: string
  phone: string
  address: string
  items: StructuredOrderItem[]
  shipping: number
  status?: string
  orderMode?: 'online' | 'offline'
  orderType?: 'online_request' | 'pos_sale' | 'manual_sale'
  deliveryCharge?: number
  discountAmount?: number
  manualDiscountAmount?: number
  manualDiscountType?: 'flat' | 'percent'
  manualDiscountValue?: number
  couponCode?: string
  couponPercentage?: number

  // POS additions
  paymentMethod?: string
  splitDetails?: Record<string, unknown>
  totalGst?: number
  gstEnabled?: boolean
  branch?: PosBranch
  /** one random key per bill: a repeated request returns the first bill instead of making another */
  idempotencyKey?: string
}

type CreatedOrder = {
  orderId: string
  invoiceNo: string
  createdAt: string
}

export const createOrderWithStock = async (input: CreateOrderInput): Promise<CreatedOrder> => {
  const customerName   = input.customerName.trim() || 'Customer'
  const phone          = input.phone.trim()
  const address        = input.address.trim()
  const shipping       = Number(input.shipping || 0)
  const status         = input.status || 'pending'
  const orderMode      = input.orderMode || 'online'
  const orderType      = input.orderType || (status === 'pending' && orderMode === 'online' ? 'online_request' : 'pos_sale')
  const deliveryCharge = Number(input.deliveryCharge || 0)
  const discountAmount = Number(input.discountAmount || 0)
  const manualDiscountAmount = Number(input.manualDiscountAmount || 0)
  const manualDiscountType = input.manualDiscountType || 'flat'
  const manualDiscountValue = Number(input.manualDiscountValue || 0)
  const couponCode     = input.couponCode?.trim() || null
  const couponPercentage = Number(input.couponPercentage || 0)

  const totalGst        = Number(input.totalGst || 0)
  const gstEnabled      = Boolean(input.gstEnabled)
  const paymentMethod   = input.paymentMethod || 'cash'
  const splitDetails    = input.splitDetails || {}
  const branch          = input.branch || 'pos1'

  // The server calls complete_pos_sale_with_inventory for the session's branch; all billing maths happens in SQL.
  const row = await api<Record<string, unknown>>('POST', '/api/pos/sale', {
    body: {
      customer_name: customerName,
      phone,
      address,
      items: input.items,
      shipping,
      status,
      order_mode: orderMode,
      order_type: orderType,
      delivery_charge: deliveryCharge,
      discount_amount: discountAmount,
      manual_discount_amount: manualDiscountAmount,
      manual_discount_type: manualDiscountType,
      manual_discount_value: manualDiscountValue,
      coupon_code: couponCode,
      coupon_percentage: couponPercentage,
      payment_method: paymentMethod,
      split_details: splitDetails,
      total_gst: totalGst,
      gst_enabled: gstEnabled,
      ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
    },
    branchId: branch,
  })
  const orderId = String(row.order_id ?? row.orderId ?? row.id ?? '')
  const invoiceNo = String(row.invoice_no ?? row.invoiceNo ?? '')
  if (!orderId || !invoiceNo) {
    throw new Error('Order RPC returned an invalid payload')
  }

  // NOTE: coupon usage_count is already incremented atomically inside the sale function. Do NOT increment it again.
  return {
    orderId,
    invoiceNo,
    createdAt: new Date().toISOString(),
  }
}
