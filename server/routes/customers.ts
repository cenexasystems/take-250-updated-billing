import { z } from 'zod'
import { ApiError, notFound } from '../lib/errors.js'
import { enforce, LIMITS, record } from '../lib/rateLimit.js'
import { route } from '../lib/route.js'

/**
 * POS customer lookup and coupon sending (0012).
 * Customer data stays per branch: every query below is pinned to the token's branch (Admin: the switcher), except the ONE
 * cross-branch read, customer_other_branches(), which returns other branches' display names and nothing else.
 * The phone travels in the request BODY (never the URL, so it is not in access logs) and is never logged.
 */

const phoneBody = z.string().max(40)

/** Canonical 10-digit mobile via the SQL rule (one definition for storing and matching), or null. */
async function canonical(db: { query: (s: string, p: unknown[]) => Promise<{ rows: any[] }> }, phone: string): Promise<string | null> {
  return (await db.query(`SELECT public.canonical_phone($1) AS p`, [phone])).rows[0]?.p ?? null
}

/** This branch's sent coupons for one phone: the latest send per coupon, with the status computed in SQL. */
async function sentCoupons(db: { query: (s: string, p: unknown[]) => Promise<{ rows: any[] }> }, branch: string, phone: string) {
  const r = await db.query(
    `SELECT code, status FROM (
       SELECT DISTINCT ON (s.coupon_id) c.code, public.coupon_status_for_phone(s.branch_id, s.coupon_id, s.phone) AS status, s.sent_at
         FROM public.coupon_sends s JOIN public.coupons c ON c.id = s.coupon_id AND c.branch_id = s.branch_id
        WHERE s.branch_id = $1 AND s.phone = $2
        ORDER BY s.coupon_id, s.sent_at DESC) x
      ORDER BY sent_at DESC LIMIT 20`, [branch, phone])
  return r.rows as Array<{ code: string; status: 'active' | 'used' | 'expired' | 'limit_reached' }>
}

export const customerRoutes = [
  route({
    method: 'post', path: '/api/customers/lookup', perm: 'customers.lookup',
    body: z.object({ phone: phoneBody }).strict(),
    async handler({ db, branch, body, session, ip }) {
      // every call counts (hit, miss or malformed), per user (role + branch) and per IP
      const user = `${session!.role}:${session!.branch ?? 'admin'}`
      await enforce(db, 'customer_lookup', ip, { ip: LIMITS.customerLookupsPerIp, target: { ...LIMITS.customerLookupsPerUser, key: user } }, false)
      await record(db, 'customer_lookup', ip, true, user)

      const phone = await canonical(db, body.phone)
      if (!phone) throw new ApiError(400, 'Enter a full 10-digit mobile number') // nothing is returned for a partial / malformed number

      const seen = (await db.query(
        `SELECT customer_name FROM (
           SELECT customer_name, created_at FROM public.orders WHERE branch_id = $1 AND public.canonical_phone(phone) = $2
           UNION ALL
           SELECT customer_name, created_at FROM public.advance_orders WHERE branch_id = $1 AND public.canonical_phone(phone) = $2) x
          ORDER BY (btrim(COALESCE(customer_name, '')) <> '' AND lower(btrim(customer_name)) NOT IN ('customer', 'walk-in customer')) DESC, created_at DESC
          LIMIT 1`, [branch, phone])).rows[0]
      const others = (await db.query(`SELECT branch_name FROM public.customer_other_branches($1, $2)`, [branch, phone])).rows
      return {
        exists_in_this_branch: !!seen,
        name: seen ? String(seen.customer_name || '').trim() || null : null,
        coupons: await sentCoupons(db, branch!, phone),
        other_branches: others.map((o) => String(o.branch_name)),
      }
    },
  }),
  // Admin "Send" on a coupon of the selected branch: recorded only AFTER the PDF was shared / downloaded in the browser.
  route({
    method: 'post', path: '/api/coupons/:id/sends', perm: 'coupons.send', status: 201,
    body: z.object({
      phone: phoneBody,
      customer_name: z.string().trim().max(200).default(''),
      customer_specific: z.boolean().default(false),
    }).strict(),
    async handler({ db, branch, body, params, session }) {
      const id = Number(params.id)
      if (!Number.isInteger(id) || id <= 0) throw notFound('Coupon not found')
      const phone = await canonical(db, body.phone)
      if (!phone) throw new ApiError(400, 'Enter a full 10-digit mobile number')
      const c = (await db.query(
        `SELECT id, is_active, (expiry_date IS NOT NULL AND expiry_date < now()) AS expired,
                (usage_limit IS NOT NULL AND usage_count >= usage_limit) AS exhausted
           FROM public.coupons WHERE id = $1 AND branch_id = $2`, [id, branch])).rows[0]
      if (!c) throw notFound('Coupon not found')
      if (!c.is_active) throw new ApiError(400, 'This coupon is not active')
      if (c.expired) throw new ApiError(400, 'This coupon has expired')
      if (c.exhausted) throw new ApiError(400, 'Coupon usage limit has been reached')
      const r = await db.query(
        `INSERT INTO public.coupon_sends (branch_id, coupon_id, phone, customer_name, sent_by_role, customer_specific)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, coupon_id, phone, customer_name, sent_by_role, sent_at, customer_specific`,
        [branch, id, phone, body.customer_name, session!.role, body.customer_specific])
      return { send: r.rows[0] }
    },
  }),
]
