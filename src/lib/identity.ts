/**
 * Legacy placeholder identities that were seeded into `store_settings` by very
 * early migrations (Purple Boutique, CLAD, Chaji Mens Wear). They must never
 * reach a customer-facing surface (invoice header, thermal receipt, advance
 * receipt, WhatsApp message) — Take250 branding is the only identity
 * this app ships.
 *
 * A field is treated as "empty" when it matches one of these markers, so the
 * brand constants in ./brand are used instead. This keeps the app correct even
 * on a database where the repair migration has not been applied yet.
 *
 * This module intentionally has NO imports so both `../store/store` and
 * `./branchProfile` can use it without creating a circular import.
 */
const LEGACY_IDENTITY_MARKERS: RegExp[] = [
  /clad/i,
  /purple\s*boutique/i,
  /mypurpleboutique05@gmail\.com/i,
  /chandrums1552004@gmail\.com/i,
  /chandru\s*ajitha/i,
  /chaji/i,
  /7010312145/,
  /8925094465/,
  /9344159498/,
  /manapparai/i,
  /tamarind\s*suite/i,
  /cyberjaya/i,
  /\+?60\s*11[-\s]?3312\s*7107/,
]

/** Returns '' when the value is blank or a known legacy placeholder. */
export function cleanIdentityField(value: string | null | undefined): string {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (LEGACY_IDENTITY_MARKERS.some((marker) => marker.test(trimmed))) return ''
  return trimmed
}
