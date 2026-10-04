import { supabase } from '../lib/supabase'
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
   */
  async receiveStockWithBarcode(payload: CreateBarcodeAndReceivePayload): Promise<CreateBarcodeResponse> {
    const { data, error } = await supabase.rpc('create_barcode_and_receive_stock', {
      p_product_id: payload.product_id,
      p_variant_id: payload.variant_id || null,
      p_quantity_received: payload.quantity_received,
      p_unit_cost: payload.unit_cost ?? null,
      p_created_by_name: payload.created_by_name || 'Admin',
      p_custom_barcode: payload.custom_barcode || null,
      p_note: payload.note || ''
    })

    if (error) {
      console.error('[barcodeService.receiveStockWithBarcode] RPC error:', error)
      throw new Error(error.message || 'Failed to receive stock with barcode')
    }

    return data as CreateBarcodeResponse
  },

  /**
   * Lookup barcode value in registry and resolve product + variant info.
   */
  async lookupBarcode(barcodeValue: string, branch: PosBranch): Promise<BarcodeRegistryRecord | null> {
    // Normalize to uppercase so hardware scanners emitting lowercase still match
    const cleanValue = (barcodeValue ?? '').trim().toUpperCase()
    if (!cleanValue) return null

    // 1. Direct registry lookup (case-insensitive via ilike)
    let registryQuery = supabase
      .from('barcode_registry')
      .select(`
        id, barcode_value, entity_type, product_id, variant_id, is_active, created_by_name, created_at, updated_at,
        product:products (id, name, name_ta, price, offer_price, image_url, category),
        variant:product_variants (id, variant_name, price, stock, sku)
      `)
      .ilike('barcode_value', cleanValue)
      .eq('is_active', true)
    registryQuery = registryQuery.eq('branch', branch)
    const { data, error } = await registryQuery.maybeSingle()

    if (error) {
      console.warn('[barcodeService.lookupBarcode] Query error:', error)
    }

    if (data) {
      // Cast array-joined relations if Supabase returned them as single objects
      const p = Array.isArray(data.product) ? data.product[0] : data.product
      const v = Array.isArray(data.variant) ? data.variant[0] : data.variant
      return {
        ...data,
        product: p,
        variant: v
      } as BarcodeRegistryRecord
    }

    // 2. Fallback: Check product_variants.barcode (case-insensitive)
    let variantQuery = supabase
      .from('product_variants')
      .select('id, product_id, variant_name, price, stock, sku, barcode, product:products (id, name, name_ta, price, offer_price, image_url, category)')
      .ilike('barcode', cleanValue)
    variantQuery = variantQuery.eq('branch', branch)
    const { data: varData } = await variantQuery.maybeSingle()

    if (varData) {
      const p = Array.isArray(varData.product) ? varData.product[0] : varData.product
      return {
        id: `var-${varData.id}`,
        barcode_value: cleanValue,
        entity_type: 'variant',
        product_id: varData.product_id,
        variant_id: varData.id,
        is_active: true,
        created_by_name: 'System',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        product: p,
        variant: {
          id: varData.id,
          variant_name: varData.variant_name,
          price: varData.price,
          stock: varData.stock,
          sku: varData.sku
        }
      } as BarcodeRegistryRecord
    }

    // 3. Fallback: Check products.barcode (case-insensitive)
    let productQuery = supabase
      .from('products')
      .select('id, name, name_ta, price, offer_price, image_url, category, barcode, stock_quantity')
      .ilike('barcode', cleanValue)
    productQuery = productQuery.eq('branch', branch)
    const { data: prodData } = await productQuery.maybeSingle()

    if (prodData) {
      return {
        id: `prod-${prodData.id}`,
        barcode_value: cleanValue,
        entity_type: 'product',
        product_id: prodData.id,
        variant_id: null,
        is_active: true,
        created_by_name: 'System',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        product: prodData,
        variant: null
      } as BarcodeRegistryRecord
    }

    return null
  },

  /**
   * Fetch all barcodes in the registry with pagination and search.
   */
  async fetchRegistry(params?: { search?: string; limit?: number; offset?: number }): Promise<{ records: BarcodeRegistryRecord[]; total: number }> {
    let query = supabase
      .from('barcode_registry')
      .select(`
        id, barcode_value, entity_type, product_id, variant_id, is_active, created_by_name, created_at, updated_at,
        product:products (id, name, name_ta, price, offer_price, image_url, category),
        variant:product_variants (id, variant_name, price, stock, sku)
      `, { count: 'exact' })
      .order('created_at', { ascending: false })

    if (params?.search?.trim()) {
      query = query.ilike('barcode_value', `%${params.search.trim()}%`)
    }

    if (params?.limit) {
      const from = params.offset || 0
      const to = from + params.limit - 1
      query = query.range(from, to)
    }

    const { data, error, count } = await query

    if (error) {
      console.error('[barcodeService.fetchRegistry] Error:', error)
      throw error
    }

    const records = (data || []).map((row) => ({
      ...row,
      product: Array.isArray(row.product) ? row.product[0] : row.product,
      variant: Array.isArray(row.variant) ? row.variant[0] : row.variant
    })) as BarcodeRegistryRecord[]

    return { records, total: count || 0 }
  },

  /**
   * Deactivate a barcode in the registry.
   */
  async deactivateBarcode(id: string): Promise<void> {
    const { error } = await supabase
      .from('barcode_registry')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (error) throw error
  }
}
