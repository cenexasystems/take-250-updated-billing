import { api, ApiClientError } from '../lib/apiClient'
import type { PosBranch } from '../store/store'

export interface InventoryStockItem {
  id: string // compound id: prod-{id} or var-{id}
  product_id: number
  variant_id?: string | null
  entity_type: 'product' | 'variant'
  name: string
  name_ta?: string
  variant_name?: string
  sku?: string
  barcode?: string
  stock: number
  price: number
  offer_price?: number
  purchase_price?: number
  cost_price?: number
  unit?: string
  unit_type?: string
  category?: string
  image_url?: string
  is_active: boolean
  low_stock_threshold?: number
  updated_at?: string
}

export interface InventoryMovement {
  id: number
  product_id: number
  variant_id?: string | null
  barcode_id?: string | null
  movement_type: 'INITIAL_BARCODE_STOCK' | 'RESTOCK' | 'SALE' | 'RETURN' | 'DAMAGE' | 'CORRECTION' | 'VOID'
  quantity_delta: number
  quantity_before: number
  quantity_after: number
  unit_cost?: number | null
  reference_type?: string | null
  reference_id?: string | null
  note?: string
  created_by_name: string
  created_at: string
  product?: {
    id: number
    name: string
    name_ta?: string
    image_url?: string
  }
  variant?: {
    id: string
    variant_name: string
    sku?: string
  }
}

export interface StockAdjustmentPayload {
  product_id: number
  branch: PosBranch
  variant_id?: string | null
  new_quantity: number
  reason: 'RESTOCK' | 'DAMAGE' | 'CORRECTION' | 'RETURN'
  note?: string
  created_by_name?: string
}

export interface CategoryRecord {
  id: number
  name_en: string
  name_ta?: string
  is_active: boolean
  sort_order: number
  product_count?: number
  created_at?: string
  updated_at?: string
}

export interface InventoryAnalyticsSummary {
  incomingStock: number
  unitsSold: number
  unitsDamaged: number
  unitsReturned: number
  netDelta: number
  totalMovementsCount: number
  movements: InventoryMovement[]
}

export const inventoryService = {
  /**
   * Fetch complete SKU/variant level inventory list.
   */
  async fetchInventoryItems(branch: PosBranch): Promise<InventoryStockItem[]> {
    // 1 + 2. Products and variants of this branch (the server takes the branch from the session)
    const [{ products }, { variants }] = await Promise.all([
      api<{ products: any[] }>('GET', '/api/products', { query: { include_inactive: 1 }, branchId: branch }),
      api<{ variants: any[] }>('GET', '/api/variants', { query: { include_inactive: 1 }, branchId: branch }),
    ])

    const items: InventoryStockItem[] = []
    const variantsByProduct = new Map<number, any[]>()

    for (const v of variants || []) {
      const list = variantsByProduct.get(v.product_id) || []
      list.push(v)
      variantsByProduct.set(v.product_id, list)
    }

    for (const p of products || []) {
      // Exclude ad-hoc non-inventory unregistered items
      if (
        (p.category && p.category.trim().toLowerCase() === 'unregistered') ||
        p.category_id === 4
      ) {
        continue
      }

      const threshold = Number(p.low_stock_alert) > 0 ? Number(p.low_stock_alert) : 5
      const prodVariants = variantsByProduct.get(p.id)

      if (prodVariants && prodVariants.length > 0) {
        // Multi-variant product: each variant is a sellable SKU
        for (const v of prodVariants) {
          items.push({
            id: `var-${v.id}`,
            product_id: p.id,
            variant_id: v.id,
            entity_type: 'variant',
            name: p.name,
            name_ta: p.name_ta,
            variant_name: v.variant_name,
            sku: v.sku || p.sku,
            barcode: v.barcode,
            stock: Number(v.stock) || 0,
            low_stock_threshold: threshold,
            price: Number(v.price) || Number(p.price) || 0,
            offer_price: p.offer_price ? Number(p.offer_price) : undefined,
            purchase_price: v.purchase_price ? Number(v.purchase_price) : (p.purchase_price ? Number(p.purchase_price) : undefined),
            cost_price: v.purchase_price ? Number(v.purchase_price) : (p.purchase_price ? Number(p.purchase_price) : undefined),
            unit: p.unit,
            unit_type: p.unit_type,
            category: p.category,
            image_url: p.image_url,
            is_active: v.is_active && p.is_active,
            updated_at: v.updated_at || p.updated_at
          })
        }
      } else {
        // Non-variant product
        items.push({
          id: `prod-${p.id}`,
          product_id: p.id,
          variant_id: null,
          entity_type: 'product',
          name: p.name,
          name_ta: p.name_ta,
          variant_name: undefined,
          sku: p.sku,
          barcode: p.barcode,
          stock: Number(p.stock_quantity) || 0,
          low_stock_threshold: threshold,
          price: Number(p.price) || 0,
          offer_price: p.offer_price ? Number(p.offer_price) : undefined,
          purchase_price: p.purchase_price ? Number(p.purchase_price) : undefined,
          cost_price: p.purchase_price ? Number(p.purchase_price) : undefined,
          unit: p.unit,
          unit_type: p.unit_type,
          category: p.category,
          image_url: p.image_url,
          is_active: p.is_active,
          updated_at: p.updated_at
        })
      }
    }

    return items.filter((i) => i.is_active !== false)
  },

  /**
   * Permanently delete a product or variant and its inventory movement ledger rows.
   */
  async deleteInventoryItem(productId: number, variantId: string | null | undefined, branch: PosBranch): Promise<void> {
    try {
      await api('DELETE', '/api/inventory/items', { query: { product_id: productId, variant_id: variantId || undefined }, branchId: branch })
    } catch (err) {
      throw new Error(err instanceof Error && err.message ? err.message : 'Failed to delete inventory item')
    }
  },

  /**
   * Adjust stock for an item with an audit log reason.
   */
  async adjustStock(payload: StockAdjustmentPayload) {
    // the server checks the item belongs to this branch and records who did it (taken from the session)
    return api('POST', '/api/inventory/adjust', {
      body: {
        product_id: payload.product_id,
        variant_id: payload.variant_id || null,
        new_quantity: payload.new_quantity,
        reason: payload.reason,
        note: payload.note || '',
      },
      branchId: payload.branch,
    })
  },

  /**
   * Fetch movement audit ledger logs.
   */
  async fetchMovements(params: {
    branch: PosBranch
    product_id?: number
    variant_id?: string | null
    movement_type?: string
    start_date?: string
    end_date?: string
    limit?: number
    offset?: number
  }): Promise<{ movements: InventoryMovement[]; total: number }> {
    const res = await api<{ movements: InventoryMovement[]; total: number }>('GET', '/api/inventory/movements', {
      query: {
        product_id: params.product_id, variant_id: params.variant_id || undefined, movement_type: params.movement_type,
        from: params.start_date, to: params.end_date, limit: params.limit ?? 1000, offset: params.offset ?? 0,
      },
      branchId: params.branch,
    })
    return { movements: res.movements, total: res.total }
  },

  /**
   * Aggregate stock movements math for Analytics & Reports.
   */
  async fetchInventoryAnalytics(branch: PosBranch, startDate?: string, endDate?: string): Promise<InventoryAnalyticsSummary> {
    const movements: InventoryMovement[] = []
    const pageSize = 1000
    let offset = 0
    let total = 0
    do {
      const page = await this.fetchMovements({
        branch,
        start_date: startDate,
        end_date: endDate,
        limit: pageSize,
        offset,
      })
      movements.push(...page.movements)
      total = page.total
      offset += page.movements.length
    } while (offset < total && offset > 0)

    let incomingStock = 0
    let unitsSold = 0
    let unitsDamaged = 0
    let unitsReturned = 0

    for (const m of movements) {
      const delta = Number(m.quantity_delta) || 0
      if (m.movement_type === 'INITIAL_BARCODE_STOCK') {
        incomingStock += delta
      } else if (m.movement_type === 'RESTOCK') {
        if (delta > 0) {
          incomingStock += delta
        }
      } else if (m.movement_type === 'SALE') {
        unitsSold += Math.abs(delta)
      } else if (m.movement_type === 'DAMAGE') {
        unitsDamaged += Math.abs(delta)
      } else if (m.movement_type === 'RETURN') {
        unitsReturned += Math.abs(delta)
      }
    }

    const netDelta = incomingStock + unitsReturned - unitsSold - unitsDamaged

    return {
      incomingStock,
      unitsSold,
      unitsDamaged,
      unitsReturned,
      netDelta,
      totalMovementsCount: movements.length,
      movements,
    }
  },

  /**
   * Fetch all categories with product counts.
   */
  async fetchCategories(branch: PosBranch): Promise<CategoryRecord[]> {
    const res = await api<{ categories: CategoryRecord[] }>('GET', '/api/categories', { branchId: branch })
    return res.categories
  },

  /**
   * Create category.
   */
  async createCategory(payload: { name_en: string; name_ta?: string; sort_order?: number; is_active?: boolean }, branch: PosBranch): Promise<CategoryRecord> {
    const res = await api<{ category: CategoryRecord; existing?: boolean }>('POST', '/api/categories', {
      body: {
        name_en: payload.name_en.trim(),
        name_ta: payload.name_ta?.trim() || '',
        sort_order: payload.sort_order ?? 0,
        is_active: payload.is_active !== false,
      },
      branchId: branch,
    })
    if (res.existing) throw new Error(`A category named "${payload.name_en.trim()}" already exists.`)
    return { ...res.category, product_count: 0 }
  },

  /**
   * Update category.
   */
  async updateCategory(id: number, payload: Partial<{ name_en: string; name_ta?: string; sort_order?: number; is_active?: boolean }>, branch: PosBranch): Promise<CategoryRecord> {
    const body: Record<string, unknown> = {}
    if (payload.name_en !== undefined) body.name_en = payload.name_en.trim()
    if (payload.name_ta !== undefined) body.name_ta = payload.name_ta.trim() || ''
    if (payload.sort_order !== undefined) body.sort_order = payload.sort_order
    if (payload.is_active !== undefined) body.is_active = payload.is_active
    try {
      const res = await api<{ category: CategoryRecord }>('PATCH', `/api/categories/${id}`, { body, branchId: branch })
      return res.category
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) throw new Error(`A category named "${payload.name_en?.trim()}" already exists.`)
      throw err
    }
  },

  /**
   * Delete category.
   */
  async deleteCategory(id: number, branch: PosBranch): Promise<void> {
    await api('DELETE', `/api/categories/${id}`, { branchId: branch })
  }
}
