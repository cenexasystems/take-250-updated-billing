/**
 * The customer link of the online shop, always built from the address the Admin has open (preview or production),
 * never typed by hand. Whatever page or path the origin string carries, the result is `<origin>/shop`.
 */
export function shopLink(origin: string): string {
  let base: string
  try {
    base = new URL(origin).origin
  } catch {
    base = origin.replace(/[?#].*$/, '').replace(/\/+$/, '')
  }
  return `${base}/shop`
}

/** WhatsApp share (the Admin picks the chat): "Click here to order from here: <link>". */
export const orderFromHereText = (link: string): string => `Click here to order from here: ${link}`
export const whatsappShareUrl = (link: string): string => `https://wa.me/?text=${encodeURIComponent(orderFromHereText(link))}`

/** The invitation sent to one customer (the Admin still taps Send in WhatsApp). */
export const shopInviteText = (link: string, name?: string | null): string =>
  `Hi${name ? ` ${name}` : ''}! ${orderFromHereText(link)}`

/** WhatsApp chat with one customer (10-digit Indian mobile), the invitation typed in. */
export const whatsappToUrl = (phone10: string, text: string): string => `https://wa.me/91${phone10}?text=${encodeURIComponent(text)}`
