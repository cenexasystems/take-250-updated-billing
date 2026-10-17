import type { Db } from './db.js'

export type BranchCustomer = { phone: string; name: string | null; last_at: string; visits: number }

/**
 * The customers of ONE branch. There is no customer table: a customer is a canonical phone on this branch's bills,
 * advance orders or online requests. One row per phone, newest first, with the latest real name (counter placeholders
 * such as "Walk-in Customer" are not names). Phones are never logged by the callers.
 *   prefix: only phones starting with these digits (POS suggestions); sinceDays: only customers seen in that window.
 */
export async function branchCustomers(db: Db, branch: string, opts: { prefix?: string; sinceDays?: number; limit: number }): Promise<BranchCustomer[]> {
  const r = await db.query<BranchCustomer>(
    `SELECT phone, name, last_at, visits FROM (
       SELECT p AS phone, (array_agg(nm ORDER BY at DESC) FILTER (WHERE nm IS NOT NULL))[1] AS name, max(at) AS last_at, count(*)::int AS visits
         FROM (
           SELECT public.canonical_phone(phone) p, customer_name n, created_at at FROM public.orders WHERE branch_id = $1 AND phone IS NOT NULL
           UNION ALL
           SELECT public.canonical_phone(phone), customer_name, created_at FROM public.advance_orders WHERE branch_id = $1 AND phone IS NOT NULL
           UNION ALL
           SELECT phone, customer_name, created_at FROM public.shop_enquiries WHERE branch_id = $1
         ) x
         CROSS JOIN LATERAL (SELECT CASE WHEN btrim(COALESCE(x.n, '')) = '' OR lower(btrim(x.n)) IN ('customer', 'walk-in customer', 'walk in customer') THEN NULL ELSE btrim(x.n) END AS nm) c
        WHERE p IS NOT NULL AND ($2::text IS NULL OR p LIKE $2::text || '%')
        GROUP BY p) y
      WHERE $3::int IS NULL OR last_at >= now() - make_interval(days => $3::int)
      ORDER BY last_at DESC
      LIMIT $4`, [branch, opts.prefix ?? null, opts.sinceDays ?? null, opts.limit])
  return r.rows.map((x) => ({ phone: String(x.phone), name: x.name ? String(x.name) : null, last_at: x.last_at, visits: Number(x.visits) }))
}
