import { api } from '../lib/apiClient'
import type { PosBranch } from '../store/store'

type Result<T> = Promise<{ data: T[] | null; error: { message: string } | null }>

const asResult = async <T>(run: () => Promise<T[]>): Result<T> => {
  try { return { data: await run(), error: null } } catch (e) { return { data: null, error: { message: e instanceof Error ? e.message : 'Request failed' } } }
}

// The API serves the caller's branch only. `branch` selects which branch an ADMIN is looking at (staff and manager
// are locked to theirs by the session, so the argument never reaches the server for them).
export function fetchAllCategories(branch?: PosBranch): Result<{ id: number; name_en: string }> {
  return asResult(async () => (await api<{ categories: Array<{ id: number; name_en: string }> }>('GET', '/api/categories', { branchId: branch })).categories)
}

export function fetchAllProducts(branch?: PosBranch): Result<Record<string, unknown>> {
  return asResult(async () => (await api<{ products: Array<Record<string, unknown>> }>('GET', '/api/products', { branchId: branch })).products)
}

export async function updateItemPrice(params: {
  entityType: 'product' | 'variant'
  id: number | string
  newPrice: number
  newCostPrice?: number
  branch: PosBranch
}): Promise<void> {
  if (params.newPrice < 0) throw new Error('Price cannot be negative')
  await api('PATCH', '/api/inventory/price', {
    body: {
      entity_type: params.entityType,
      id: params.entityType === 'product' ? Number(params.id) : String(params.id),
      new_price: params.newPrice,
      ...(params.newCostPrice !== undefined && params.newCostPrice >= 0 ? { new_cost_price: params.newCostPrice } : {}),
    },
    branchId: params.branch,
  })
}

export async function getOrCreateUnregisteredProduct(
  name: string,
  price: number,
  branch: PosBranch
): Promise<{ id: number; name: string; price: number; category: string }> {
  return api('POST', '/api/pos/unregistered-product', { body: { name: name.trim(), price: Number(price) }, branchId: branch })
}
