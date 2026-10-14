import { z } from 'zod'
import { ApiError, notFound } from '../lib/errors.js'
import { enforce, LIMITS, record } from '../lib/rateLimit.js'
import { route } from '../lib/route.js'
import type { Db } from '../lib/db.js'

/**
 * The public online shop (/shop) and the Admin's online catalogue + enquiry dashboard (migration 0016).
 * A customer request is an ENQUIRY, not a bill: nothing here touches stock, orders or revenue.
 *
 * Public (allow-listed 'shop.public', no sign-in): the branch the customer chose travels in the URL path / as `shop`
 * (a `branch` field is refused for non-admins everywhere) and is checked against the ACTIVE branches. The catalogue
 * never contains cost price, exact stock, SKU or barcode; the request is re-priced in SQL (create_shop_enquiry), any
 * client price / name / total is dropped by the schema. Phone numbers are never logged.
 */

const SHOP_ID = /^[a-z0-9_]{2,32}$/
// customer text: control characters become spaces (React escapes the rest on output)
// eslint-disable-next-line no-control-regex -- strips control characters from customer text
const clean = (max: number) => z.string().max(max * 2).transform((v) => v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max))
export const ENQUIRY_STATUSES = ['new', 'contacted', 'confirmed', 'delivered', 'cancelled'] as const

async function activeShop(db: Db, id: string) {
  if (!SHOP_ID.test(id)) throw notFound('This shop is not available')
  const b = (await db.query(`SELECT id FROM public.branches WHERE id = $1 AND is_active`, [id])).rows[0]
  if (!b) throw notFound('This shop is not available')
  return String(b.id)
}

async function readLimit(db: Db, ip: string) {
  await enforce(db, 'shop_read', ip, { ip: LIMITS.shopReadsPerIp }, false)
  await record(db, 'shop_read', ip, true)
}

/** a branch's "show online" products, customer view: price + in stock only */
async function catalogue(db: Db, branch: string) {
  const r = await db.query(
    `SELECT p.id, p.name, p.category, COALESCE(NULLIF(p.online_description, ''), NULLIF(p.description, ''), '') AS description,
            COALESCE(NULLIF(p.image_url, ''), NULLIF(p.image, '')) AS image, p.has_variants,
            public.shop_unit_price(p, NULL::public.product_variants) AS price, (p.stock_quantity > 0) AS in_stock,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'name', COALESCE(NULLIF(v.size_label, ''), v.variant_name),
                                                          'price', public.shop_unit_price(p, v), 'in_stock', v.stock > 0,
                                                          'image', NULLIF(v.image_url, '')) ORDER BY v.sort_order, v.variant_name)
                        FROM public.product_variants v WHERE v.product_id = p.id AND v.branch_id = p.branch_id AND v.is_active), '[]'::jsonb) AS variants
       FROM public.products p
      WHERE p.branch_id = $1 AND p.is_active AND p.show_online
      ORDER BY p.online_sort NULLS LAST, p.name`, [branch])
  return r.rows.map((p) => {
    const variants = (p.variants as Array<{ id: string; name: string; price: number; in_stock: boolean; image: string | null }>).map((v) => ({ ...v, price: Number(v.price) }))
    const hasSizes = Boolean(p.has_variants) && variants.length > 0
    return {
      id: Number(p.id), name: String(p.name), category: String(p.category || ''), description: String(p.description || ''), image: p.image ? String(p.image) : null,
      price: hasSizes ? Math.min(...variants.map((v) => v.price)) : Number(p.price),
      in_stock: hasSizes ? variants.some((v) => v.in_stock) : Boolean(p.in_stock),
      variants: hasSizes ? variants : [],
    }
  })
}

const enquiryBody = z.object({
  shop: z.string().trim().max(32),
  customer_name: clean(120),
  phone: z.string().max(40),
  address: clean(500),
  note: clean(500).default(''),
  // only these three fields of a line are read; anything else (price, name, total) is dropped
  items: z.array(z.object({ product_id: z.number().int().positive(), variant_id: z.string().uuid().nullish(), quantity: z.number().int().min(1).max(99) })).min(1).max(30),
  idempotency_key: z.string().trim().min(8).max(100),
  // honeypot: a hidden field people never fill in
  website: z.string().max(200).optional(),
})

const isKeyConflict = (e: unknown) => {
  const x = e as { code?: string; constraint?: string }
  return x?.code === '23505' && String(x.constraint || '').includes('idempotency_key')
}

const publicRoutes = [
  route({
    method: 'get', path: '/api/shop/branches', perm: 'shop.public',
    async handler({ db, ip, res }) {
      await readLimit(db, ip)
      res.setHeader('Cache-Control', 'public, max-age=60')
      const r = await db.query(
        `SELECT b.id, b.short_label AS name, b.subtitle, COALESCE(NULLIF(s.logo_url, ''), b.logo_url) AS logo
           FROM public.branches b LEFT JOIN public.store_settings s ON s.branch_id = b.id
          WHERE b.is_active ORDER BY b.sort_order, b.id`)
      return { branches: r.rows.map((b) => ({ id: String(b.id), name: String(b.name), subtitle: String(b.subtitle || ''), logo: String(b.logo || '') })) }
    },
  }),
  route({
    method: 'get', path: '/api/shop/catalogue/:shop', perm: 'shop.public',
    async handler({ db, ip, res, params }) {
      await readLimit(db, ip)
      const branch = await activeShop(db, params.shop)
      res.setHeader('Cache-Control', 'public, max-age=30')
      return { products: await catalogue(db, branch) }
    },
  }),
  route({
    method: 'post', path: '/api/shop/enquiries', perm: 'shop.public', status: 201, body: enquiryBody,
    async handler({ db, ip, res, body }) {
      res.setHeader('Cache-Control', 'no-store')
      await enforce(db, 'shop_enquiry', ip, { ip: LIMITS.shopEnquiriesPerIp }, false)
      await record(db, 'shop_enquiry', ip, true) // every attempt counts
      if (body.website) throw new ApiError(400, 'The request could not be sent')
      const branch = await activeShop(db, body.shop)
      const args = [branch, body.customer_name, body.phone, body.address, body.note, JSON.stringify(body.items), body.idempotency_key]
      try {
        const r = await db.query(`SELECT public.create_shop_enquiry($1, $2, $3, $4, $5, $6::jsonb, $7) AS r`, args)
        return { enquiry: r.rows[0].r }
      } catch (e) {
        if (isKeyConflict(e)) {
          const first = (await db.query(`SELECT public.shop_enquiry_json(id, branch_id) AS r FROM public.shop_enquiries WHERE branch_id = $1 AND idempotency_key = $2`, [branch, body.idempotency_key])).rows[0]
          if (first) return { enquiry: { ...first.r, replayed: true } }
        }
        throw e
      }
    },
  }),
]

const adminRoutes = [
  // ---- online catalogue of the branch in the switcher
  route({
    method: 'get', path: '/api/shop-admin/catalogue', perm: 'shop.catalogue',
    async handler({ db, branch }) {
      const r = await db.query(
        `SELECT p.id, p.name, p.category, p.price, p.offer_price, p.online_price, p.online_description, p.online_sort, p.show_online,
                COALESCE(NULLIF(p.image_url, ''), NULLIF(p.image, '')) AS image, p.has_variants, p.stock_quantity,
                (SELECT count(*)::int FROM public.product_variants v WHERE v.product_id = p.id AND v.branch_id = p.branch_id AND v.is_active) AS variant_count
           FROM public.products p WHERE p.branch_id = $1 AND p.is_active
          ORDER BY p.show_online DESC, p.online_sort NULLS LAST, p.name`, [branch])
      return { products: r.rows }
    },
  }),
  route({
    method: 'patch', path: '/api/shop-admin/catalogue/:id', perm: 'shop.catalogue',
    body: z.object({
      show_online: z.boolean(), online_price: z.number().finite().min(0).max(10_000_000).nullable(),
      online_description: z.string().max(1000).nullable(), online_sort: z.number().int().min(-100000).max(100000).nullable(),
      image_url: z.string().max(1000).nullable(),
    }).partial().strict(),
    async handler({ db, branch, body, params }) {
      const keys = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined)
      if (!keys.length) return { ok: true }
      const sets = keys.map((k, i) => `"${k}" = $${i + 1}`)
      const r = await db.query(`UPDATE public.products SET ${sets.join(', ')}, updated_at = now() WHERE id = $${keys.length + 1} AND branch_id = $${keys.length + 2}
                                RETURNING id, show_online, online_price, online_description, online_sort, image_url`,
        [...keys.map((k) => (body as Record<string, unknown>)[k]), Number(params.id), branch])
      if (!r.rows[0]) throw notFound()
      return { product: r.rows[0] }
    },
  }),
  route({
    method: 'post', path: '/api/shop-admin/catalogue/bulk', perm: 'shop.catalogue',
    body: z.object({ ids: z.array(z.number().int().positive()).min(1).max(1000), show_online: z.boolean() }).strict(),
    async handler({ db, branch, body }) {
      const r = await db.query(`UPDATE public.products SET show_online = $1, updated_at = now() WHERE branch_id = $2 AND id = ANY($3::bigint[])`, [body.show_online, branch, body.ids])
      return { updated: r.rowCount ?? 0 }
    },
  }),

  // ---- enquiry dashboard: all branches, or one (in_branch), Admin only
  route({
    method: 'get', path: '/api/shop-admin/enquiries', perm: 'shop.enquiries',
    query: z.object({
      status: z.enum(ENQUIRY_STATUSES).optional(), in_branch: z.string().regex(SHOP_ID).optional(),
      from: z.string().max(40).optional(), to: z.string().max(40).optional(), q: z.string().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(300),
    }).strict(),
    async handler({ db, query }) {
      const p: unknown[] = []
      const bind = (v: unknown) => { p.push(v); return `$${p.length}` }
      const conds: string[] = ['true']
      if (query.status) conds.push(`e.status = ${bind(query.status)}`)
      if (query.in_branch) conds.push(`e.branch_id = ${bind(query.in_branch)}`)
      if (query.from) conds.push(`e.created_at >= ${bind(query.from)}::timestamptz`)
      if (query.to) conds.push(`e.created_at <= ${bind(query.to)}::timestamptz`)
      if (query.q) {
        const v = query.q.trim(); const digits = v.replace(/\D/g, '')
        const or = [`e.enquiry_no ILIKE '%' || ${bind(v)} || '%'`, `e.customer_name ILIKE '%' || ${bind(v)} || '%'`]
        if (digits.length >= 3) or.push(`e.phone LIKE '%' || ${bind(digits.length > 10 ? digits.slice(-10) : digits)} || '%'`)
        conds.push(`(${or.join(' OR ')})`)
      }
      const r = await db.query(
        `SELECT e.id, e.branch_id, b.short_label AS branch_name, e.enquiry_no, e.customer_name, e.phone, e.address, e.note, e.status,
                e.items_total, e.delivery_charge, e.admin_note, e.created_at, e.updated_at,
                COALESCE((SELECT jsonb_agg(jsonb_build_object('name', i.name, 'variant_name', i.variant_name, 'quantity', i.quantity,
                                                              'unit_price', i.unit_price, 'line_total', i.line_total) ORDER BY i.id)
                            FROM public.shop_enquiry_items i WHERE i.enquiry_id = e.id AND i.branch_id = e.branch_id), '[]'::jsonb) AS items
           FROM public.shop_enquiries e JOIN public.branches b ON b.id = e.branch_id
          WHERE ${conds.join(' AND ')} ORDER BY e.created_at DESC LIMIT ${query.limit}`, p)
      const counts = await db.query(`SELECT count(*) FILTER (WHERE status = 'new')::int AS new_count FROM public.shop_enquiries`)
      return { enquiries: r.rows, new_count: counts.rows[0].new_count }
    },
  }),
  // the Admin's notification poll (~12 s): New count + the requests that arrived after `since`, any branch
  route({
    method: 'get', path: '/api/shop-admin/enquiries/pulse', perm: 'shop.enquiries',
    query: z.object({ since: z.string().max(40).optional() }).strict(),
    async handler({ db, query }) {
      // latest as TEXT: full microsecond precision, so "after since" never re-reports the newest request
      const n = (await db.query(`SELECT count(*) FILTER (WHERE status = 'new')::int AS n, max(created_at)::text AS latest FROM public.shop_enquiries`)).rows[0]
      const fresh = query.since
        ? (await db.query(
            `SELECT e.id, e.enquiry_no, e.branch_id, b.short_label AS branch_name, e.customer_name, e.created_at
               FROM public.shop_enquiries e JOIN public.branches b ON b.id = e.branch_id
              WHERE e.created_at > $1::timestamptz ORDER BY e.created_at DESC LIMIT 10`, [query.since])).rows.map((r) => ({ ...r, created_at: r.created_at }))
        : []
      return { new_count: n.n, latest: n.latest, fresh }
    },
  }),
  route({
    method: 'patch', path: '/api/shop-admin/enquiries/:id', perm: 'shop.enquiries',
    body: z.object({
      status: z.enum(ENQUIRY_STATUSES), admin_note: clean(1000), delivery_charge: z.number().finite().min(0).max(1_000_000).nullable(),
    }).partial().strict(),
    async handler({ db, body, params, session }) {
      if (!/^[0-9a-f-]{36}$/i.test(params.id)) throw notFound()
      const e = (await db.query(`SELECT id, branch_id FROM public.shop_enquiries WHERE id = $1`, [params.id])).rows[0]
      if (!e) throw notFound()
      return db.tx(async (t) => {
        if (body.status) await t.query(`SELECT public.set_shop_enquiry_status($1, $2, $3, $4)`, [e.id, e.branch_id, body.status, session!.role])
        if (body.admin_note !== undefined) await t.query(`UPDATE public.shop_enquiries SET admin_note = $1, updated_at = now() WHERE id = $2 AND branch_id = $3`, [body.admin_note, e.id, e.branch_id])
        if (body.delivery_charge !== undefined) await t.query(`UPDATE public.shop_enquiries SET delivery_charge = $1, updated_at = now() WHERE id = $2 AND branch_id = $3`, [body.delivery_charge, e.id, e.branch_id])
        const row = (await t.query(`SELECT id, status, admin_note, delivery_charge, updated_at FROM public.shop_enquiries WHERE id = $1 AND branch_id = $2`, [e.id, e.branch_id])).rows[0]
        return { enquiry: row }
      })
    },
  }),
  route({
    method: 'get', path: '/api/shop-admin/enquiries/:id/history', perm: 'shop.enquiries',
    async handler({ db, params }) {
      if (!/^[0-9a-f-]{36}$/i.test(params.id)) throw notFound()
      const r = await db.query(`SELECT old_status, new_status, changed_at, changed_by_role FROM public.shop_enquiry_status_history WHERE enquiry_id = $1 ORDER BY changed_at, id`, [params.id])
      return { history: r.rows }
    },
  }),
]

export const shopRoutes = [...publicRoutes, ...adminRoutes]
