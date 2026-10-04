import fs from 'node:fs'
import path from 'node:path'

const SKIP = new Set(['components/Invoice.tsx', 'lib/invoicePdf.ts', 'lib/advanceReceipt.ts', 'services/analyticsExport.ts', 'pages/DigitalInvoice.tsx'])
const gray = { 50: '#F9FAFB', 100: '#F3F4F6', 200: '#E5E7EB', 300: '#D1D5DB', 400: '#9CA3AF', 500: '#6B7280', 600: '#4B5563', 700: '#374151', 800: '#1F2937', 900: '#111827' }
const NAMED = { white: '#FFFFFF', black: '#000000', 'brand-black': '#0A0A0A', 'brand-dark': '#1F1F1F', 'brand-gold': '#D4AF37', 'gold': '#D4AF37', 'gold-dark': '#8A6A0A', 'gold-light': '#FBF6E9', 'brand-goldLight': '#FBF6E9', bgMain: '#FBFAF6', cardBg: '#FFFFFF', textMain: '#1A0E0E', textMuted: '#6B7280', posOne: '#343434', posTwo: '#343434', 'posOne-dark': '#1F1F1F', 'posTwo-dark': '#1F1F1F', 'posOne-light': '#F1EDE0', 'posTwo-light': '#F1EDE0', 'maroon': '#0A0A0A' }
for (const [k, v] of Object.entries(gray)) NAMED[`gray-${k}`] = v
for (const [k, v] of Object.entries(gray)) NAMED[`slate-${k}`] = v

const VAR = { 'var(--theme-primary)': '#0A0A0A', 'var(--theme-primary-dark)': '#1F1F1F' }
const ARB_REMAP = { '#7A1220': '#0A0A0A', '#8B1A1A': '#0A0A0A', '#5C0D18': '#1F1F1F' } // classes the CSS override rules point at the theme

const lum = (hex) => { const h = hex.slice(1); const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const resolve = (tok) => {
  if (tok.startsWith('[')) { const inner = tok.slice(1, -1); if (VAR[inner]) return VAR[inner]; if (/^#[0-9a-fA-F]{6}$/.test(inner)) { const u = inner.toUpperCase(); return ARB_REMAP[u] || u } return null }
  return NAMED[tok] || null
}

function* files(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* files(p); else if (/\.tsx$/.test(e.name)) yield p } }

const out = []
const goldOnLight = []
for (const f of files('src')) {
  const rel = f.replace(/\\/g, '/').replace(/^src\//, '')
  if (SKIP.has(rel)) continue
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    const re = /(?:className=|clsx\(|`|')([^'"`]*\b(?:text|bg)-[^'"`]*)['"`]/g
    let m
    while ((m = re.exec(line))) {
      const cls = m[1].split(/\s+/)
      const base = cls.filter((c) => !/^(hover:|focus:|active:|group-hover:|disabled:|placeholder:|peer-|md:|sm:|lg:|xl:|print:|focus-within:|data-)/.test(c))
      const t = base.find((c) => /^text-(\[#[0-9a-fA-F]{6}\]|\[var\([^)]*\)\]|white|black|gray-\d+|brand-[a-zA-Z]+|gold(-dark|-light)?|textMain|textMuted|slate-\d+)$/.test(c))
      const b = base.find((c) => /^bg-(\[#[0-9a-fA-F]{6}\]|\[var\([^)]*\)\]|white|black|gray-\d+|brand-[a-zA-Z]+|gold(-dark|-light)?|bgMain|cardBg|pos(One|Two)(-light|-dark)?|slate-\d+)$/.test(c))
      const tc = t && resolve(t.slice(5))
      if (t && b) {
        const bc = resolve(b.slice(3))
        if (tc && bc) { const r = ratio(tc, bc); if (r < 4.5) out.push({ rel, line: i + 1, t, b, r: r.toFixed(2) }) }
      } else if (t && tc) {
        // text colour with no background in the same element: it sits on the page / a parent surface.
        // Flag gold-ish or light text that would be unreadable on white / cream.
        const rw = ratio(tc, '#FFFFFF')
        if (rw < 4.5 && lum(tc) > 0.35) goldOnLight.push({ rel, line: i + 1, t, r: rw.toFixed(2), src: line.trim().slice(0, 110) })
      }
    }
  })
}
console.log('=== text+background pairs below 4.5:1 ===')
for (const x of out) console.log(`${x.rel}:${x.line}  ${x.t} on ${x.b}  ${x.r}`)
console.log(`(${out.length})`)
console.log('=== light/gold text with no background in the same element (needs a dark parent) ===')
for (const x of goldOnLight) console.log(`${x.rel}:${x.line}  ${x.t}  ${x.r}  | ${x.src}`)
console.log(`(${goldOnLight.length})`)
