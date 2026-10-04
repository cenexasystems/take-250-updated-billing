const clamp255 = (n: number) => Math.max(0, Math.min(255, n))

export function normalizeHex(hex: string): string {
  const h = hex.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(h)) return '#' + h.split('').map((c) => c + c).join('').toUpperCase()
  if (/^[0-9a-fA-F]{6}$/.test(h)) return '#' + h.toUpperCase()
  return '#0A0A0A'
}

function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex).slice(1)
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((n) => clamp255(Math.round(n)).toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** Mixes `hex` toward `target` by `amount` (0 = hex, 1 = target). */
export function mixHex(hex: string, target: string, amount: number): string {
  const [r1, g1, b1] = hexToRgb(hex)
  const [r2, g2, b2] = hexToRgb(target)
  return rgbToHex([
    r1 + (r2 - r1) * amount,
    g1 + (g2 - g1) * amount,
    b1 + (b2 - b1) * amount,
  ])
}

/** A pale tint of `hex` for light backgrounds (mixed toward white). */
export const tintHex = (hex: string, amount = 0.88) => mixHex(hex, '#FFFFFF', amount)

/** A darker shade of `hex` for hover/contrast states (mixed toward black). */
export const shadeHex = (hex: string, amount = 0.32) => mixHex(hex, '#000000', amount)
