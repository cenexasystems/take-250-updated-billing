/**
 * Builds every logo / icon file from the two source logos in branding/:
 *   branding/take250-shirt-shop.jpg   -> Branch 1 and Branch 2 (and the app icon / login logo)
 *   branding/take250-womens-wear.jpg  -> Branch 3
 * Writes public/yg-logo*.png, the PWA / favicon / apple-touch icons (file names unchanged so the manifest,
 * index.html and vercel.json need no edits) and src/lib/logoBase64.ts (logos embedded for PDF / print contexts).
 *   node scripts/make-branding-assets.mjs
 */
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const PUB = path.join(ROOT, 'public')
const SRC = { shirt: path.join(ROOT, 'branding/take250-shirt-shop.jpg'), women: path.join(ROOT, 'branding/take250-womens-wear.jpg') }
const BLACK = { r: 0, g: 0, b: 0, alpha: 1 }

/** Crops the black margin off a logo (anything brighter than the near-black background counts as logo). */
async function tightCrop(file, padRatio = 0.04) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  let minX = info.width, maxX = 0, minY = info.height, maxY = 0
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 3
    if (data[i] > 45 || data[i + 1] > 45 || data[i + 2] > 45) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
  }
  const w = maxX - minX + 1, h = maxY - minY + 1
  const pad = Math.round(Math.max(w, h) * padRatio)
  const left = Math.max(0, minX - pad), top = Math.max(0, minY - pad)
  const width = Math.min(info.width - left, w + 2 * pad), height = Math.min(info.height - top, h + 2 * pad)
  return sharp(file).extract({ left, top, width, height }).png().toBuffer()
}

const squareOnBlack = (buf, size, emblem) =>
  sharp(buf).resize(emblem, emblem, { fit: 'contain', background: BLACK, kernel: sharp.kernel.lanczos3 }).toBuffer()
    .then((e) => sharp({ create: { width: size, height: size, channels: 4, background: BLACK } })
      .composite([{ input: e, left: Math.round((size - emblem) / 2), top: Math.round((size - emblem) / 2) }]).png({ compressionLevel: 9 }).toBuffer())

const write = (name, buf) => { fs.writeFileSync(path.join(PUB, name), buf); console.log(`public/${name}  ${(buf.length / 1024).toFixed(0)} KB`) }

const shirt = await tightCrop(SRC.shirt)
const women = await tightCrop(SRC.women, 0.01)

// full logos (UI headers, brand pages)
const big = (buf) => sharp(buf).resize({ width: 768, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer()
const shirtBig = await big(shirt)
const womenBig = await big(women)
write('yg-logo.png', shirtBig)
write('yg-logo-source.png', shirtBig)
write('yg-logo-pos1.png', shirtBig)
write('yg-logo-pos2.png', shirtBig)
write('yg-logo-pos3.png', womenBig)

// app icons (the shirt-shop mark: one icon for the whole app)
write('yg-icon.png', await squareOnBlack(shirt, 512, 470))
write('yg-icon-512.png', await squareOnBlack(shirt, 512, 470))
write('yg-icon-192.png', await squareOnBlack(shirt, 192, 176))
write('yg-icon-maskable-512.png', await squareOnBlack(shirt, 512, 360)) // inside the maskable safe zone
write('yg-icon-maskable-192.png', await squareOnBlack(shirt, 192, 135))
write('apple-touch-icon.png', await squareOnBlack(shirt, 180, 150))
write('yg-favicon.png', await squareOnBlack(shirt, 64, 60))

// embedded copies for jsPDF / print / WhatsApp contexts
const embed = async (buf) => 'data:image/png;base64,' + (await sharp(buf).resize({ width: 384, withoutEnlargement: true }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()).toString('base64')
const b1 = await embed(shirt)
const b3 = await embed(women)

// Thermal-printer versions: a thermal head prints black dots on white paper, so the black background must become
// white and ALL the artwork (white lettering, gold, pink) must become black. Each pixel's brightest colour channel
// decides: bright (artwork) -> black, near-black (background) -> white, anti-aliased edges stay smooth.
async function thermal(buf) {
  const { data, info } = await sharp(buf).resize({ width: 320, withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const out = Buffer.alloc(info.width * info.height)
  for (let i = 0; i < out.length; i++) {
    const m = Math.max(data[i * 3], data[i * 3 + 1], data[i * 3 + 2])
    out[i] = 255 - Math.min(255, Math.round(Math.max(0, m - 24) * 1.45))
  }
  const png = await sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } }).png({ compressionLevel: 9 }).toBuffer()
  return { dataUrl: 'data:image/png;base64,' + png.toString('base64'), png }
}
const t1 = await thermal(shirt)
const t3 = await thermal(women)
fs.mkdirSync(path.join(ROOT, 'branding/preview'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'branding/preview/thermal-shirt-shop.png'), t1.png)
fs.writeFileSync(path.join(ROOT, 'branding/preview/thermal-womens-wear.png'), t3.png)
const ts = `// Branch logos embedded as base64 for jsPDF/print/WhatsApp contexts that can't load /public files
// directly (jsPDF.addImage, exports rendered outside the app's own origin).
// GENERATED by scripts/make-branding-assets.mjs from branding/*.jpg: do not edit by hand.
export const LOGO_BASE64_POS1 = '${b1}'

// Branch 2 shares the shirt-shop logo with Branch 1
export const LOGO_BASE64_POS2 = LOGO_BASE64_POS1

export const LOGO_BASE64_POS3 = '${b3}'

// Thermal-printer versions (black artwork on white, see scripts/make-branding-assets.mjs): used by the 80 mm receipts only
export const LOGO_THERMAL_POS1 = '${t1.dataUrl}'
export const LOGO_THERMAL_POS2 = LOGO_THERMAL_POS1
export const LOGO_THERMAL_POS3 = '${t3.dataUrl}'

/** @deprecated use LOGO_BASE64_POS1 / 2 / 3 directly */
export const LOGO_BASE64 = LOGO_BASE64_POS1
`
fs.writeFileSync(path.join(ROOT, 'src/lib/logoBase64.ts'), ts)
console.log(`src/lib/logoBase64.ts  ${(ts.length / 1024).toFixed(0)} KB`)
