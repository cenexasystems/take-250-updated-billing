import { api, ApiClientError } from '../lib/apiClient'
import type { PosBranch } from '../store/store'

export interface BarcodeRegistryRecord {
  id: string
  barcode_value: string
  entity_type: 'product' | 'variant'
  product_id: number
  variant_id?: string | null
  is_active: boolean
  created_by_name: string
  created_at: string
  updated_at: string
  product?: {
    id: number
    name: string
    name_ta?: string
    price: number
    offer_price?: number
    image_url?: string
    category?: string
  }
  variant?: {
    id: string
    variant_name: string
    price?: number
    stock?: number
    sku?: string
  } | null
}

export interface CreateBarcodeAndReceivePayload {
  product_id: number
  variant_id?: string | null
  quantity_received: number
  unit_cost?: number | null
  created_by_name?: string
  custom_barcode?: string | null
  note?: string
}

export interface CreateBarcodeResponse {
  success: boolean
  barcode_id: string
  barcode_value: string
  is_new_barcode: boolean
  movement_type: string
  quantity_before: number
  quantity_received: number
  quantity_after: number
  product_id: number
  variant_id?: string | null
  product_name: string
  variant_name?: string
}

export const barcodeService = {
  /**
   * Receive stock and create/reuse barcode in a single atomic transaction.
   * The server takes the branch from the session and records who received it; neither is sent from here.
   */
  async receiveStockWithBarcode(payload: CreateBarcodeAndReceivePayload): Promise<CreateBarcodeResponse> {
    return api<CreateBarcodeResponse>('POST', '/api/barcodes/receive', {
      body: {
        product_id: payload.product_id,
        variant_id: payload.variant_id || null,
        quantity_received: payload.quantity_received,
        unit_cost: payload.unit_cost ?? null,
        custom_barcode: payload.custom_barcode || null,
        note: payload.note || '',
      },
    })
  },

  /**
   * Lookup barcode value in registry and resolve product + variant info.
   * Looked up ONLY inside the current branch: another branch's barcode is simply "not found".
   */
  async lookupBarcode(barcodeValue: string, branch: PosBranch): Promise<BarcodeRegistryRecord | null> {
    // Normalize to uppercase so hardware scanners emitting lowercase still match
    const cleanValue = (barcodeValue ?? '').trim().toUpperCase()
    if (!cleanValue) return null
    try {
      const res = await api<{ record: BarcodeRegistryRecord }>('GET', '/api/barcodes/lookup', { query: { code: cleanValue }, branchId: branch })
      return res.record
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) return null
      throw err
    }
  },

  /**
   * Fetch all barcodes in the registry with pagination and search.
   */
  async fetchRegistry(params?: { search?: string; limit?: number; offset?: number }): Promise<{ records: BarcodeRegistryRecord[]; total: number }> {
    return api<{ records: BarcodeRegistryRecord[]; total: number }>('GET', '/api/barcodes', {
      query: { search: params?.search?.trim() || undefined, limit: params?.limit, offset: params?.offset },
    })
  },

  /**
   * Deactivate a barcode in the registry.
   */
  async deactivateBarcode(id: string): Promise<void> {
    await api('POST', `/api/barcodes/${id}/deactivate`)
  },

  /** Data for the label / sheet print flows: the active barcode of one item in this branch (null when it has none). */
  async fetchPrintData(productId: number, variantId?: string | null): Promise<BarcodeRegistryRecord | null> {
    try {
      const res = await api<{ record: BarcodeRegistryRecord }>('GET', '/api/barcodes/print-data', { query: { product_id: productId, variant_id: variantId || undefined } })
      return res.record
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) return null
      throw err
    }
  },

  /** The product editor's barcode field: register (or move) a barcode value inside this branch. */
  async registerBarcode(productId: number, barcodeValue: string, variantId?: string | null): Promise<void> {
    await api('PUT', '/api/barcodes/register', { body: { product_id: productId, variant_id: variantId || null, barcode_value: barcodeValue } })
  },
}
