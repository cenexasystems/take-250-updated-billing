import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ApiError, notFound } from '../lib/errors.js'
import { enforce, LIMITS, record } from '../lib/rateLimit.js'
import { route } from '../lib/route.js'
import type { PermKey } from '../lib/permissions.js'

// ---------------------------------------------------------------- uploads (Vercel Blob)
const IMAGE = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] // no SVG: it can carry scripts
const UPLOAD_KINDS: Array<{ kind: 'product-images' | 'invoices' | 'branding' | 'avatars'; types: string[]; maxBytes: number }> = [
  { kind: 'product-images', types: IMAGE, maxBytes: 5 * 1024 * 1024 },
  { kind: 'invoices', types: [...IMAGE, 'application/pdf'], maxBytes: 8 * 1024 * 1024 },
  { kind: 'branding', types: IMAGE, maxBytes: 3 * 1024 * 1024 },
  { kind: 'avatars', types: IMAGE, maxBytes: 2 * 1024 * 1024 },
]
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' }

const uploadRoutes = UPLOAD_KINDS.map((k) =>
  route({
    method: 'post', path: `/api/uploads/${k.kind}`, perm: `uploads.${k.kind}` as PermKey, status: 201, raw: true,
    query: z.object({ filename: z.string().max(120).optional() }).strict(),
    async handler({ req, deps, branch, query }) {
      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      if (!k.types.includes(contentType)) throw new ApiError(415, 'Unsupported file type')
      const body = req.body as Buffer
      if (!Buffer.isBuffer(body) || body.length === 0) throw new ApiError(400, 'Empty upload')
      if (body.length > k.maxBytes) throw new ApiError(413, 'File too large')
      const base = (query.filename || 'file').replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'file'
      // every path starts with the branch id taken from the token / validated admin selector
      const pathname = `${branch}/${k.kind}/${randomUUID()}-${base}.${EXT[contentType]}`
      const out = await deps.blobPut(pathname, body, { contentType })
      return { url: out.url, path: pathname }
    },
  })
)

// ---------------------------------------------------------------- polling (replaces realtime subscriptions)
const STAMP_TABLES: Array<[string, string]> = [
  ['products', 'updated_at'], ['product_variants', 'updated_at'], ['categories', 'updated_at'], ['coupons', 'updated_at'],
  ['orders', 'updated_at'], ['advance_orders', 'updated_at'], ['store_settings', 'updated_at'], ['expenses', 'updated_at'],
  ['inventory_movements', 'created_at'], ['barcode_registry', 'updated_at'],
]

const pollRoutes = [
  // The client compares these stamps between polls and refetches only what changed. Branch-scoped only.
  route({
    method: 'get', path: '/api/poll/stamps', perm: 'poll.stamps',
    async handler({ db, branch }) {
      const sql = STAMP_TABLES.map(([t, c]) => `SELECT '${t}' AS t, count(*)::int AS n, max(${c}) AS last FROM public.${t} WHERE branch_id = $1`).join(' UNION ALL ')
      const r = await db.query<{ t: string; n: number; last: string | null }>(sql, [branch])
      return { stamps: Object.fromEntries(r.rows.map((x) => [x.t, { count: x.n, last: x.last }])), server_time: new Date().toISOString() }
    },
  }),
]

// ---------------------------------------------------------------- public invoice lookup
const NOT_FOUND = 'Invoice not found'
const REF = /^[A-Za-z0-9_\- ]{1,64}$/

// ---------------------------------------------------------------- health (deploy smoke test / uptime monitor)
const HEALTH_DB_TIMEOUT_MS = 4000

const healthRoutes = [
  route({
    method: 'get', path: '/api/health', perm: 'health.check',
    async handler({ db }) {
      // Answers "is this deployment wired up?" and nothing else: no secrets, no connection string, no error text,
      // no data. Only the NAMES of missing settings are listed, never their values.
      const ping = db.query('SELECT 1 AS ok')
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), HEALTH_DB_TIMEOUT_MS) })
      try {
        await Promise.race([ping, timeout])
      } catch {
        ping.catch(() => undefined)
        throw new ApiError(503, 'Database unavailable')
      } finally {
        clearTimeout(timer)
      }
      const missing = ['JWT_SECRET', ...(process.env.VERCEL ? ['BLOB_READ_WRITE_TOKEN'] : [])].filter((k) => !process.env[k])
      if (missing.length) throw new ApiError(503, `Server settings missing: ${missing.join(', ')}`)
      return { status: 'ok', database: 'up', environment: process.env.VERCEL_ENV || (process.env.VERCEL ? 'vercel' : 'local') }
    },
  }),
]

const publicRoutes = [
  route({
    method: 'get', path: '/api/public/invoice/:ref', perm: 'public.invoice',
    async handler({ db, ip, params }) {
      // DB-backed per-IP limit; every lookup counts, hit or miss
      await enforce(db, 'invoice', ip, { ip: LIMITS.invoiceLookupsPerIp }, false)
      await record(db, 'invoice', ip, true)

      const ref = (params.ref || '').trim()
      if (!REF.test(ref)) throw notFound(NOT_FOUND) // same answer as a miss: nothing to learn from the format

      const order = (await db.query(`SELECT * FROM public.get_public_invoice_by_number($1) LIMIT 1`, [ref])).rows[0]
      if (order) {
        const items = await db.query(`SELECT * FROM public.order_items WHERE order_id = $1 AND branch_id = $2 ORDER BY id`, [order.id, order.branch_id])
        return { kind: 'order', order, items: items.rows }
      }
      const stripped = ref.replace(/^(INV|PB)[-_ ]*/i, '')
      const adv = (await db.query(
        `SELECT * FROM public.advance_orders WHERE invoice_number = ANY($1) OR deposit_id = ANY($1) LIMIT 2`, [[ref, stripped]])).rows
      // exactly one bill, or the generic miss (never "one of several")
      if (adv.length === 1) return { kind: 'advance', order: adv[0], items: [] }
      throw notFound(NOT_FOUND)
    },
  }),
]

export const miscRoutes = [...uploadRoutes, ...pollRoutes, ...healthRoutes, ...publicRoutes]
