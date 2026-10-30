/** Each branch's own shop address: /shop/<slug> opens that branch's products straight away (no shop picker). */
export const SHOP_SLUG: Record<string, string> = { pos1: 'karanthai', pos2: 'kinathukadavu', pos3: 'pollachi' }

/** The branch id of a /shop/<slug> address (the place name, or the branch id itself), or null when it is not a branch. */
export function branchFromShopSlug(slug: string | null | undefined): string | null {
  const s = String(slug ?? '').trim().toLowerCase()
  if (!s) return null
  if (SHOP_SLUG[s]) return s
  return Object.keys(SHOP_SLUG).find((id) => SHOP_SLUG[id] === s) ?? null
}

/**
 * The customer link of the online shop, always built from the address the Admin has open (preview or production),
 * never typed by hand. Whatever page or path the origin string carries, the result is `<origin>/shop`, or
 * `<origin>/shop/<slug>` for one branch.
 */
export function shopLink(origin: string, branch?: string | null): string {
  let base: string
  try {
    base = new URL(origin).origin
  } catch {
    base = origin.replace(/[?#].*$/, '').replace(/\/+$/, '')
  }
  const slug = branch ? SHOP_SLUG[branch] ?? branch : ''
  return slug ? `${base}/shop/${slug}` : `${base}/shop`
}

/** WhatsApp share (the Admin picks the chat): "Click here to order from here: <link>". */
export const orderFromHereText = (link: string): string => `Click here to order from here: ${link}`
export const whatsappShareUrl = (link: string): string => `https://wa.me/?text=${encodeURIComponent(orderFromHereText(link))}`

/** The invitation sent to one customer (the Admin still taps Send in WhatsApp). */
export const shopInviteText = (link: string, name?: string | null): string =>
  `Hi${name ? ` ${name}` : ''}! ${orderFromHereText(link)}`

/** WhatsApp chat with one customer (10-digit Indian mobile), the invitation typed in. */
export const whatsappToUrl = (phone10: string, text: string): string => `https://wa.me/91${phone10}?text=${encodeURIComponent(text)}`
