export type UnitType = 'unit' | 'weight' | 'volume' | 'bundle'

export type QuantityOption = {
  quantity: number
  unit: string
  label: string
}

export type StructuredOrderItem = {
  product_id:   string | null   // products.id (UUID or numeric string)
  variant_id:   string | null   // product_variants.id (UUID) — null for non-variant items
  variant_name: string | null   // snapshot of variant name at order time
  name: string
  tamil_name: string | null
  quantity: number
  unit: string
  unit_type: UnitType
  base_quantity: number
  base_price: number
  line_total: number
  image_url: string | null
  source?: 'catalogue' | 'manual'
  is_manual?: boolean
  category?: string | null
  note?: string | null
}

type UnitFactors = Record<string, number>

const WEIGHT_FACTORS: UnitFactors = {
  mg: 0.001,
  g: 1,
  kg: 1000,
}

const VOLUME_FACTORS: UnitFactors = {
  ml: 1,
  l: 1000,
}

const DISPLAY_NO_SPACE_UNITS = new Set(['mg', 'g', 'kg', 'ml', 'l'])

const DEFAULT_UNIT_LABEL: Record<UnitType, string> = {
  unit: 'piece',
  weight: 'g',
  volume: 'ml',
  bundle: 'bundle',
}

const INR_CURRENCY = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  currencyDisplay: 'symbol',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const clampTo = (value: number, min = 0) => (value < min ? min : value)

export const roundTo = (value: number, places = 2) => {
  const factor = 10 ** places
  return Math.round((value + Number.EPSILON) * factor) / factor
}

/** GST is one amount per bill, shown as two equal halves: CGST rounds DOWN to the paisa and SGST takes the rest, so
 *  CGST + SGST is always exactly the GST. Same rule as the database (orders.cgst_amount / sgst_amount). */
export const splitGst = (gst: unknown) => {
  const paise = Math.round((Number(gst) || 0) * 100)
  const cgstPaise = Math.floor(paise / 2)
  return { cgst: cgstPaise / 100, sgst: (paise - cgstPaise) / 100 }
}

export type PaymentPart = { method: 'cash' | 'qr' | 'card'; amount: number }

const methodName = (m: unknown): PaymentPart['method'] | null => {
  const k = String(m ?? '').trim().toLowerCase()
  return k === 'cash' ? 'cash' : k === 'qr' || k === 'upi' ? 'qr' : k === 'card' ? 'card' : null
}
const methodLabel = (m: PaymentPart['method']) => (m === 'qr' ? 'QR' : m === 'card' ? 'Card' : 'Cash')

/** The structured split breakdown saved with a bill (orders.split_details = { payments: [{ method, amount }] }). */
export const paymentParts = (splitDetails: unknown): PaymentPart[] => {
  const list = (splitDetails as { payments?: unknown } | null | undefined)?.payments
  if (!Array.isArray(list)) return []
  const parts: PaymentPart[] = []
  for (const p of list) {
    const method = methodName((p as { method?: unknown })?.method)
    const amount = Number((p as { amount?: unknown })?.amount)
    if (method && Number.isFinite(amount) && amount > 0) parts.push({ method, amount })
  }
  return parts
}

/** "Cash ₹100.00 + QR ₹900.00" for a split bill, otherwise "Cash" / "QR" / "Card" / what was stored (older bills). */
export const formatPaymentMode = (mode: unknown, splitDetails?: unknown): string => {
  const parts = paymentParts(splitDetails)
  if (parts.length > 1) return parts.map((p) => `${methodLabel(p.method)} ${formatCurrency(p.amount)}`).join(' + ')
  const raw = String(mode ?? '').trim()
  const single = methodName(raw)
  return single ? methodLabel(single) : raw
}

/** Subtotal - coupon - manual discount + GST + delivery, never below zero (the same rule the POS and the server use). */
export const billTotal = (b: { subtotal: number; coupon?: number; manual?: number; gst?: number; delivery?: number }) =>
  roundTo(Math.max(0, b.subtotal - (b.coupon || 0) - (b.manual || 0)) + (b.gst || 0) + (b.delivery || 0))

export const toNumber = (value: unknown, fallback = 0) => {
  if (value === null || value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const safeId = (id: unknown): number | null => {
  const n = Number(id)
  return Number.isFinite(n) && n !== 0 ? n : null
}

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

export const formatInvoiceNo = (invNo: unknown): string => {
  const raw = String(invNo || '').trim()
  const base = raw.replace(/^INV/i, '')
  if (!base) return 'INV10000001'
  if (/^\d{8}$/.test(base)) return `INV${base}`

  const matchDigits = base.match(/\d+/g)
  if (matchDigits) {
    const joined = matchDigits.join('')
    if (joined.length >= 8) return `INV${joined.slice(-8)}`
    return `INV${joined.padStart(8, '0')}`
  }

  let hash = 0
  for (let i = 0; i < base.length; i++) {
    hash = (hash << 5) - hash + base.charCodeAt(i)
    hash |= 0
  }
  return `INV${String(Math.abs(hash) % 89999999 + 10000000)}`
}



export const normalizeUnitType = (value: unknown, fallback: UnitType = 'unit'): UnitType => {
  const raw = String(value || '').trim().toLowerCase()
  if (raw === 'unit' || raw === 'weight' || raw === 'volume' || raw === 'bundle') {
    return raw
  }
  return fallback
}

export const normalizeOrderMode = (value: unknown): 'online' | 'offline' => {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, '')

  if (raw === 'offline') return 'offline'
  return 'online'
}

const normalizeUnitToken = (value: string) => {
  const token = value.trim().toLowerCase()
  if (!token) return ''
  if (token === 'liter' || token === 'litre' || token === 'liters' || token === 'litres') return 'l'
  if (token === 'milliliter' || token === 'millilitre' || token === 'milliliters' || token === 'millilitres') return 'ml'
  if (token === 'piece' || token === 'pieces' || token === 'pcs' || token === 'pc') return 'piece'
  if (token === 'bundles') return 'bundle'
  return token
}

export const inferUnitTypeFromLabel = (label: unknown): UnitType => {
  const unit = normalizeUnitToken(String(label || ''))
  if (unit in WEIGHT_FACTORS) return 'weight'
  if (unit in VOLUME_FACTORS) return 'volume'
  if (unit === 'bundle') return 'bundle'
  return 'unit'
}

export const normalizeUnitLabel = (label: unknown, unitType: UnitType) => {
  const token = normalizeUnitToken(String(label || ''))
  if (!token) return DEFAULT_UNIT_LABEL[unitType]
  return token
}

export const normalizeBaseQuantity = (value: unknown, unitType: UnitType) => {
  const parsed = toNumber(value, unitType === 'unit' || unitType === 'bundle' ? 1 : 0)
  if (parsed <= 0) {
    return unitType === 'unit' || unitType === 'bundle' ? 1 : 100
  }
  return roundTo(parsed, 3)
}

export const parseLegacyUnit = (rawUnit: unknown) => {
  const unitRaw = String(rawUnit || '').trim().toLowerCase()
  if (!unitRaw) {
    return {
      unitType: 'unit' as UnitType,
      unitLabel: 'piece',
      baseQuantity: 1,
    }
  }

  const match = unitRaw.match(/^([0-9]+(?:\.[0-9]+)?)\s*([a-z]+)$/i)
  if (match) {
    const unitLabel = normalizeUnitToken(match[2])
    const unitType = inferUnitTypeFromLabel(unitLabel)
    return {
      unitType,
      unitLabel: normalizeUnitLabel(unitLabel, unitType),
      baseQuantity: normalizeBaseQuantity(Number(match[1]), unitType),
    }
  }

  const inferredType = inferUnitTypeFromLabel(unitRaw)
  return {
    unitType: inferredType,
    unitLabel: normalizeUnitLabel(unitRaw, inferredType),
    baseQuantity: inferredType === 'unit' || inferredType === 'bundle' ? 1 : 100,
  }
}

const formatNumber = (value: number) => {
  const rounded = roundTo(value, 3)
  if (Number.isInteger(rounded)) {
    return String(rounded)
  }
  return String(rounded).replace(/\.0+$/, '').replace(/(\.[0-9]*?)0+$/, '$1')
}

const factorsForType = (unitType: UnitType): UnitFactors | null => {
  if (unitType === 'weight') return WEIGHT_FACTORS
  if (unitType === 'volume') return VOLUME_FACTORS
  return null
}

export const convertQuantityByUnitType = (
  quantity: number,
  fromUnit: unknown,
  toUnit: unknown,
  unitType: UnitType,
) => {
  const qty = toNumber(quantity, 0)
  const from = normalizeUnitToken(String(fromUnit || ''))
  const to = normalizeUnitToken(String(toUnit || ''))

  if (!Number.isFinite(qty)) return 0
  if (!from || !to || from === to) return qty

  const factors = factorsForType(unitType)
  if (!factors) {
    return qty
  }

  const fromFactor = factors[from]
  const toFactor = factors[to]
  if (!fromFactor || !toFactor) {
    return qty
  }

  return roundTo((qty * fromFactor) / toFactor, 6)
}

const parseOptionFromString = (
  value: string,
  unitType: UnitType,
  unitLabel: string,
): QuantityOption | null => {
  const raw = value.trim()
  if (!raw) return null

  const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]+)?$/)
  if (!match) return null

  const quantity = toNumber(match[1], 0)
  if (quantity <= 0) return null

  const parsedUnit = match[2] ? normalizeUnitToken(match[2]) : unitLabel
  const normalizedQty = convertQuantityByUnitType(quantity, parsedUnit, unitLabel, unitType)

  return {
    quantity: normalizeSelectedQuantity(normalizedQty, unitType, true, 0.001),
    unit: unitLabel,
    label: formatCompactQuantity(normalizedQty, unitLabel),
  }
}

export const normalizePredefinedOptions = (
  raw: unknown,
  unitType: UnitType,
  unitLabel: string,
): QuantityOption[] => {
  if (!Array.isArray(raw)) {
    return []
  }

  const options: QuantityOption[] = []
  raw.forEach((entry) => {
    if (typeof entry === 'number') {
      if (entry > 0) {
        options.push({
          quantity: normalizeSelectedQuantity(entry, unitType, true, 0.001),
          unit: unitLabel,
          label: formatCompactQuantity(entry, unitLabel),
        })
      }
      return
    }

    if (typeof entry === 'string') {
      const parsed = parseOptionFromString(entry, unitType, unitLabel)
      if (parsed) options.push(parsed)
      return
    }

    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>
      const value = toNumber(obj.quantity ?? obj.value, 0)
      if (value <= 0) return

      const inputUnit = normalizeUnitToken(String(obj.unit || unitLabel))
      const normalizedQty = convertQuantityByUnitType(value, inputUnit, unitLabel, unitType)
      const label = String(obj.label || '').trim() || formatCompactQuantity(normalizedQty, unitLabel)

      options.push({
        quantity: normalizeSelectedQuantity(normalizedQty, unitType, true, 0.001),
        unit: unitLabel,
        label,
      })
    }
  })

  const deduped = options.filter((option, index, arr) =>
    arr.findIndex((item) => item.quantity === option.quantity && item.unit === option.unit) === index,
  )

  return deduped.sort((a, b) => a.quantity - b.quantity)
}

export const normalizeSelectedQuantity = (
  value: unknown,
  unitType: UnitType,
  allowDecimalQuantity: boolean,
  fallback: number,
) => {
  const parsed = toNumber(value, fallback)
  if (parsed <= 0) return fallback

  if (unitType === 'unit' || unitType === 'bundle') {
    return Math.max(1, Math.round(parsed))
  }

  if (!allowDecimalQuantity) {
    return Math.max(1, Math.round(parsed))
  }

  return Math.max(0.001, roundTo(parsed, 3))
}

// qty = number of packs/units the customer is buying.
// basePrice is the admin-entered price for ONE pack/unit — the exact selling price.
// weight/volume labels (g, ml, kg, l) are display metadata only; they never enter this formula.
export const calculateLineTotal = (
  quantity: number | string,
  _unitType: UnitType,
  _baseQuantity: number | string,
  basePrice: number | string,
) => {
  const safeQuantity = toNumber(quantity, 0)
  const safePrice = clampTo(toNumber(basePrice, 0), 0)
  return roundTo(safePrice * Math.max(0, Math.round(safeQuantity)), 2)
}

// Single source of truth for variant product pricing.
// Variant = independent SKU: price is the flat price for that size; qty is number of units.
// NEVER multiply by weight/volume/baseQuantity.
export const variantLineTotal = (price: number, cartQty: number): number =>
  roundTo(price * Math.max(0, Math.round(cartQty)), 2)

export const formatCurrency = (value: number) => INR_CURRENCY.format(roundTo(value, 2)).replace(/\u00a0/g, ' ')

export const formatCompactQuantity = (quantity: number, unitLabel: string) => {
  const q = formatNumber(quantity)
  const unit = normalizeUnitToken(unitLabel)
  if (!unit) return q
  if (DISPLAY_NO_SPACE_UNITS.has(unit)) return `${q}${unit}`
  return `${q} ${unit}`
}

// Quantity without the unit suffix, for contexts that already display the
// unit separately (e.g. the invoice ITEM/SKU column prints "m · ₹100.00",
// so repeating "5 m" in the QTY column is redundant).
export const formatQuantityValue = (quantity: number) => formatNumber(quantity)

export const formatQuantityDisplay = (
  quantity: number,
  unitLabel: string,
  unitType: UnitType,
) => {
  const q = formatNumber(quantity)
  const unit = normalizeUnitToken(unitLabel)

  if (unitType === 'unit' && unit === 'piece') {
    return `${q} ${Number(q) === 1 ? 'piece' : 'pieces'}`
  }

  if (unitType === 'bundle' && unit === 'bundle') {
    return `${q} ${Number(q) === 1 ? 'bundle' : 'bundles'}`
  }

  return `${q} ${unit || DEFAULT_UNIT_LABEL[unitType]}`
}

// qty always means "how many packs/units" — always starts at 1.
export const getDefaultQuantityForProduct = (
  _input: { unitType: UnitType; baseQuantity: number; predefinedOptions?: QuantityOption[] },
) => 1

// Step is always 1 pack/unit — weight/volume labels are display-only.
export const getQuantityStepForProduct = (
  _input: { unitType: UnitType; baseQuantity: number; allowDecimalQuantity: boolean },
) => 1

export const calculateStockDeduction = (input: {
  quantity: number
  selectedUnit: string
  stockUnit: string
  unitType: UnitType
}) => {
  const converted = convertQuantityByUnitType(
    input.quantity,
    input.selectedUnit,
    input.stockUnit,
    input.unitType,
  )

  if (input.unitType === 'unit' || input.unitType === 'bundle') {
    return Math.max(0, Math.round(converted))
  }

  return Math.max(0, roundTo(converted, 3))
}

export const buildStructuredOrderItem = (input: {
  productId:   string | null   // products.id UUID — for variant items pass parentProductId
  variantId?:  string | null   // product_variants.id UUID
  variantName?: string | null  // snapshot for order history
  name: string
  tamilName?: string | null
  quantity: number
  unit: string
  unitType: UnitType
  baseQuantity: number
  basePrice: number
  imageUrl?: string | null
  source?: 'catalogue' | 'manual'
  isManual?: boolean
  is_manual?: boolean
  category?: string | null
  note?: string | null
}): StructuredOrderItem => {
  const safeQuantity = normalizeSelectedQuantity(
    input.quantity,
    input.unitType,
    input.unitType !== 'unit' && input.unitType !== 'bundle',
    input.unitType === 'unit' || input.unitType === 'bundle' ? 1 : normalizeBaseQuantity(input.baseQuantity, input.unitType),
  )

  const safeBaseQuantity = normalizeBaseQuantity(input.baseQuantity, input.unitType)
  const safeBasePrice = clampTo(toNumber(input.basePrice, 0), 0)
  const isManual = Boolean(input.isManual || input.is_manual || input.source === 'manual' || input.category === 'Unregistered')

  return {
    product_id:   input.productId,
    variant_id:   input.variantId   ? String(input.variantId)   : null,
    variant_name: input.variantName ? String(input.variantName) : null,
    name: String(input.name || 'Product'),
    tamil_name: input.tamilName ? String(input.tamilName) : null,
    quantity: safeQuantity,
    unit: normalizeUnitLabel(input.unit, input.unitType),
    unit_type: input.unitType,
    base_quantity: safeBaseQuantity,
    base_price: safeBasePrice,
    line_total: calculateLineTotal(safeQuantity, input.unitType, safeBaseQuantity, safeBasePrice),
    image_url: input.imageUrl ? String(input.imageUrl) : null,
    source: isManual ? 'manual' : (input.source || 'catalogue'),
    is_manual: isManual,
    category: input.category || null,
    note: input.note ? String(input.note) : null,
  }
}

export const normalizeStructuredOrderItem = (raw: Record<string, unknown>): StructuredOrderItem => {
  const unitType = normalizeUnitType(
    raw.unit_type || raw.unitType || inferUnitTypeFromLabel(raw.unit),
    'unit',
  )

  const unit = normalizeUnitLabel(raw.unit || raw.unit_label || raw.unitLabel, unitType)
  const basePrice = toNumber(raw.base_price ?? raw.basePrice ?? raw.offerPrice ?? raw.price, 0)
  const quantity = normalizeSelectedQuantity(
    raw.quantity ?? raw.qty,
    unitType,
    unitType !== 'unit' && unitType !== 'bundle',
    unitType === 'unit' || unitType === 'bundle' ? 1 : 0.001,
  )
  const baseQuantity = normalizeBaseQuantity(raw.base_quantity ?? raw.baseQuantity ?? 1, unitType)

  const lineTotalRaw = toNumber(raw.line_total ?? raw.lineTotal, 0)
  const lineTotal = Number.isFinite(lineTotalRaw)
    ? roundTo(lineTotalRaw, 2)
    : calculateLineTotal(quantity, unitType, baseQuantity, basePrice)

  // products.id may be a UUID or a number — return as string, not number
  const productIdValue = raw.product_id ?? raw.productId ?? raw.id
  const productId: string | null =
    productIdValue !== null && productIdValue !== undefined && String(productIdValue).trim()
      ? String(productIdValue).trim()
      : null

  return {
    product_id:   productId,
    variant_id:   raw.variant_id   ? String(raw.variant_id)   : null,
    variant_name: raw.variant_name ? String(raw.variant_name) : null,
    name: String(raw.name || 'Product'),
    tamil_name: raw.tamil_name ? String(raw.tamil_name) : (raw.nameTa ? String(raw.nameTa) : null),
    quantity,
    unit,
    unit_type: unitType,
    base_quantity: baseQuantity,
    base_price: basePrice,
    line_total: lineTotal,
    image_url: raw.image_url ? String(raw.image_url) : (raw.image ? String(raw.image) : null),
    source: raw.source === 'manual' || raw.is_manual === true ? 'manual' : 'catalogue',
    note: raw.note ? String(raw.note) : (raw.manual_note ? String(raw.manual_note) : null),
  }
}
