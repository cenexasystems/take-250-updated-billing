export class ApiError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message)
  }
}

export const notFound = (what = 'Not found') => new ApiError(404, what)
export const badRequest = (msg: string) => new ApiError(400, msg)

/** Maps database errors to safe client messages. Messages raised by our own SQL functions
 * (RAISE EXCEPTION ...) are user-facing by design; everything else stays generic. */
export function mapDbError(err: unknown): ApiError | null {
  const e = err as { code?: string; message?: string; constraint?: string }
  if (!e || typeof e.code !== 'string') return null
  switch (e.code) {
    case '23505': {
      const c = String(e.constraint || '')
      if (c === 'products_category_name_unique') return new ApiError(409, 'A product with this name already exists in the selected category.')
      if (c === 'product_variants_product_name_unique') return new ApiError(409, 'A variant with this name already exists for this product.')
      if (c === 'barcode_in_use' || c === 'product_variants_branch_barcode_unique' || c === 'products_branch_barcode_unique') return new ApiError(409, 'This barcode is already used by another item in this branch.')
      if (c.startsWith('barcode_registry') || c.includes('barcode')) return new ApiError(409, 'This barcode is already registered to another item.')
      if (c === 'categories_branch_name_unique') return new ApiError(409, 'A category with this name already exists.')
      if (c === 'coupons_branch_code_upper_unique') return new ApiError(409, 'That coupon code already exists.')
      return new ApiError(409, 'That value already exists in this branch.')
    }
    case '23503': return new ApiError(409, 'Referenced record not found in this branch, or still in use.')
    case '23514': return new ApiError(400, e.message ? String(e.message).split('\n')[0] : 'Value rejected.')
    case '23502': return new ApiError(400, 'A required field is missing.')
    case '22P02': case '22003': case '22007': case '22008': return new ApiError(400, 'A value has the wrong format.')
    case '22023': case 'P0001': return new ApiError(400, e.message ? String(e.message).split('\n')[0] : 'Request rejected.')
    default: return null
  }
}

/** Never logs request bodies, cookies, tokens, passcodes or connection strings. */
export function logServerError(where: string, err: unknown) {
  const e = err as { code?: string; message?: string }
  const msg = String(e?.message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, '[redacted]').slice(0, 300)
  console.error(`[api] ${where}: ${e?.code ?? ''} ${msg}`)
}
