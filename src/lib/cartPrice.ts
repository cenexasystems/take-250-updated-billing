// ONE rule for the unit price of a POS cart line, whatever added it (barcode scan, search, catalogue, size picker):
// the chosen size's own price, else the product's offer price, else the product's price. Sizes carry no offer price of
// their own, so a product's offer price never applies to a size line. A cashier can still edit the rate afterwards.
export type PriceSource = { price: number | string; offerPrice?: number | string | null }
export type SizePrice = { price?: number | string | null } | null | undefined

export function cartUnitPrice(product: PriceSource, size?: SizePrice): number {
  const sizePrice = size ? Number(size.price) : NaN
  if (size && Number.isFinite(sizePrice) && sizePrice > 0) return sizePrice
  const offer = Number(product.offerPrice || 0)
  return offer > 0 ? offer : Number(product.price) || 0
}

/** A barcode lookup record (GET /api/barcodes/lookup) as the POS adds it: the registered size (id, name, its own price
 *  and stock) or, for a product barcode, the product. Shared by the scanner box and the camera / external scan. */
export type ScanRecord = {
  product_id: number; variant_id?: string | null
  product: { name: string; name_ta?: string; price: number | string; offer_price?: number | string | null; image_url?: string; category?: string }
  variant?: { id: string; variant_name?: string; price?: number | string | null; stock?: number | string | null } | null
}
export function scanPayload(record: ScanRecord, barcode: string) {
  const prod = record.product
  const size = record.variant ?? null
  return {
    product_id: record.product_id,
    variant_id: record.variant_id || null,
    product_name: prod.name,
    name_ta: prod.name_ta,
    variant_name: size?.variant_name,
    price: Number(prod.price) || 0,
    offer_price: prod.offer_price ? Number(prod.offer_price) : undefined,
    // the size's own price: cartUnitPrice() uses it before any product price
    variant_price: size ? Number(size.price) || 0 : null,
    stock: size ? (Number(size.stock) || 0) : 999,
    barcode,
    image_url: prod.image_url,
    category: prod.category,
  }
}
