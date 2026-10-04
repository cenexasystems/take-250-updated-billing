import { api } from '../lib/apiClient'
import type { PosBranch } from '../store/store'

export type ProductVariant = {
  id: string
  productId: string
  variantName: string
  sizeLabel: string | null   // display label: "25g", "250ml", "Cycle Brand"
  weightValue: number | null // numeric for filtering
  weightUnit: string | null  // "g", "ml", "kg", "L"
  sku: string | null
  barcode: string | null
  purchasePrice: number | null
  mrp: number | null
  price: number
  stock: number
  isDefault: boolean
  isActive: boolean
  sortOrder: number
  imageUrl: string | null
  groupName: string | null   // Brand name for Type D (Brand+Weight) products e.g. "Sithanathan"
}

export type VariantInput = {
  productId: string
  variantName: string
  sizeLabel?: string | null
  weightValue?: number | null
  weightUnit?: string | null
  sku?: string | null
  barcode?: string | null
  purchasePrice?: number | null
  mrp?: number | null
  price: number
  stock: number
  isDefault?: boolean
  sortOrder?: number
  imageUrl?: string | null
  /** Required when creating a new variant — which branch it belongs to.
   * Ignored on update (a variant's branch never changes after creation). */
  branch?: PosBranch
}

function mapVariant(r: Record<string, unknown>): ProductVariant {
  return {
    id:          String(r.id || ''),
    productId:   String(r.product_id || ''),
    variantName: String(r.variant_name || ''),
    sizeLabel:   r.size_label ? String(r.size_label) : null,
    weightValue: r.weight_value != null ? Number(r.weight_value) : null,
    weightUnit:  r.weight_unit ? String(r.weight_unit) : null,
    sku:         r.sku ? String(r.sku) : null,
    barcode:     r.barcode ? String(r.barcode) : null,
    purchasePrice: r.purchase_price != null ? Number(r.purchase_price) : null,
    mrp:         r.mrp != null ? Number(r.mrp) : null,
    price:       Number(r.price ?? 0),
    stock:       Number(r.stock ?? 0),
    isDefault:   r.is_default === true,
    isActive:    r.is_active !== false,
    sortOrder:   Number(r.sort_order ?? 0),
    imageUrl:    r.image_url ? String(r.image_url) : null,
    groupName:   r.group_name ? String(r.group_name) : null,
  }
}

// ── Read ──────────────────────────────────────────────────────────

const msg = (e: unknown) => (e instanceof Error ? e.message : 'Request failed')

export async function fetchAllVariants(branch?: PosBranch): Promise<{ data: ProductVariant[]; error: string | null }> {
  try {
    const res = await api<{ variants: Array<Record<string, unknown>> }>('GET', '/api/variants', { branchId: branch })
    return { data: res.variants.map(mapVariant), error: null }
  } catch (e) {
    return { data: [], error: msg(e) }
  }
}

export async function fetchVariantsByProduct(productId: string, branch: PosBranch): Promise<ProductVariant[]> {
  try {
    const res = await api<{ variants: Array<Record<string, unknown>> }>('GET', '/api/variants', { query: { product_id: productId }, branchId: branch })
    return res.variants.map(mapVariant)
  } catch {
    return []
  }
}

// ── Write (admin / manager / staff product editor) ────────────────

export async function createVariant(input: VariantInput): Promise<{ data: ProductVariant | null; error: string | null }> {
  try {
    const res = await api<{ variant: Record<string, unknown> }>('POST', '/api/variants', {
      body: {
        product_id:   Number(input.productId),
        variant_name: input.variantName,
        size_label:   input.sizeLabel ?? null,
        weight_value: input.weightValue ?? null,
        weight_unit:  input.weightUnit ?? null,
        sku:          input.sku ?? null,
        barcode:      input.barcode ?? null,
        purchase_price: input.purchasePrice ?? null,
        mrp:          input.mrp ?? null,
        price:        input.price,
        stock:        input.stock ?? 0,
        is_default:   input.isDefault ?? false,
        sort_order:   input.sortOrder ?? 0,
        image_url:    input.imageUrl ?? null,
        is_active:    true,
      },
      branchId: input.branch,
    })
    return { data: mapVariant(res.variant), error: null }
  } catch (e) {
    return { data: null, error: msg(e) }
  }
}

export async function updateVariant(
  id: string,
  updates: Partial<VariantInput>,
  branch: PosBranch,
): Promise<{ error: string | null }> {
  const payload: Record<string, unknown> = {}
  if (updates.variantName !== undefined) payload.variant_name = updates.variantName
  if (updates.sizeLabel   !== undefined) payload.size_label   = updates.sizeLabel
  if (updates.weightValue !== undefined) payload.weight_value = updates.weightValue
  if (updates.weightUnit  !== undefined) payload.weight_unit  = updates.weightUnit
  if (updates.sku           !== undefined) payload.sku            = updates.sku
  if (updates.barcode       !== undefined) payload.barcode        = updates.barcode
  if (updates.purchasePrice !== undefined) payload.purchase_price = updates.purchasePrice
  if (updates.mrp           !== undefined) payload.mrp            = updates.mrp
  if (updates.price         !== undefined) payload.price          = updates.price
  if (updates.stock         !== undefined) payload.stock          = updates.stock
  if (updates.isDefault     !== undefined) payload.is_default     = updates.isDefault
  if (updates.sortOrder     !== undefined) payload.sort_order     = updates.sortOrder
  if (updates.imageUrl      !== undefined) payload.image_url      = updates.imageUrl
  try {
    await api('PATCH', `/api/variants/${id}`, { body: payload, branchId: branch })
    return { error: null }
  } catch (e) {
    return { error: msg(e) }
  }
}

export async function deleteVariant(id: string, branch: PosBranch): Promise<{ error: string | null }> {
  try {
    await api('PATCH', `/api/variants/${id}`, { body: { is_active: false }, branchId: branch })
    return { error: null }
  } catch (e) {
    return { error: msg(e) }
  }
}

export async function setDefaultVariant(
  variantId: string,
  _productId: string,
  branch: PosBranch,
): Promise<{ error: string | null }> {
  try {
    await api('POST', `/api/variants/${variantId}/default`, { branchId: branch })
    return { error: null }
  } catch (e) {
    return { error: msg(e) }
  }
}
