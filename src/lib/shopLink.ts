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

/** WhatsApp share (the Admin picks the chat); the message is just the link. */
export const whatsappShareUrl = (link: string): string => `https://wa.me/?text=${encodeURIComponent(link)}`
