import { z } from 'zod'
import { actorName } from '../lib/auth.js'
import { notFound } from '../lib/errors.js'
import { route } from '../lib/route.js'
import { insertRow, updateRow } from '../lib/sql.js'

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const stamp = z.string().regex(/^\d{4}-\d{2}-\d{2}([T ][0-9:.+Z-]+)?$/)

const settingsFields = {
  name: z.string().trim().min(1).max(200), owner_name: z.string().max(200), phone: z.string().max(100), email: z.string().max(200),
  address: z.string().max(1000), gst_enabled: z.boolean(), business_type: z.string().max(200), instagram_id: z.string().max(200),
  logo_url: z.string().max(2000).nullable(), theme_color: z.string().regex(/^#[0-9a-fA-F]{6}$/), website_url: z.string().max(300),
}

export const adminRoutes = [
  // ---- store settings (own branch) ----
  route({
    method: 'get', path: '/api/settings', perm: 'settings.read',
    async handler({ db, branch }) {
      const r = await db.query(`SELECT * FROM public.store_settings WHERE branch_id = $1`, [branch])
      if (!r.rows[0]) throw notFound()
      return { settings: r.rows[0] }
    },
  }),
  route({
    method: 'put', path: '/api/settings', perm: 'settings.write',
    body: z.object(settingsFields).partial().strict(),
    async handler({ db, branch, body }) {
      const cur = await db.query(`SELECT id FROM public.store_settings WHERE branch_id = $1`, [branch])
      if (!cur.rows[0]) throw notFound()
      return { settings: await updateRow(db, 'store_settings', cur.rows[0].id, branch!, body) }
    },
  }),

  // ---- expenses (Admin + Manager) ----
  route({
    method: 'get', path: '/api/expenses', perm: 'expenses.read',
    query: z.object({ from: day.optional(), to: day.optional(), category_id: z.coerce.number().int().positive().optional() }).strict(),
    async handler({ db, branch, query }) {
      const r = await db.query(
        `SELECT * FROM public.expenses WHERE branch_id = $1 AND ($2::date IS NULL OR expense_date >= $2) AND ($3::date IS NULL OR expense_date <= $3)
           AND ($4::bigint IS NULL OR category_id = $4) ORDER BY expense_date DESC, created_at DESC`, [branch, query.from ?? null, query.to ?? null, query.category_id ?? null])
      return { expenses: r.rows }
    },
  }),
  route({
    method: 'get', path: '/api/expenses/metrics', perm: 'expenses.read',
    async handler({ db, branch }) {
      const r = await db.query(`SELECT public.get_expense_summary_metrics(CURRENT_DATE, $1) AS m`, [branch])
      return { metrics: r.rows[0].m }
    },
  }),
  route({
    method: 'post', path: '/api/expenses', perm: 'expenses.write', status: 201,
    body: z.object({
      expense_date: day, category_id: z.number().int().positive().nullable(), category_name: z.string().trim().min(1).max(200),
      amount: z.number().finite().gt(0), description: z.string().max(1000).default(''), payment_mode: z.string().max(30).default('cash'),
    }).strict(),
    async handler({ db, branch, body, session }) {
      return { expense: await insertRow(db, 'expenses', branch!, { ...body, recorded_by_name: actorName(session!) }) }
    },
  }),
  route({
    method: 'patch', path: '/api/expenses/:id', perm: 'expenses.write',
    body: z.object({
      expense_date: day, category_id: z.number().int().positive().nullable(), category_name: z.string().trim().min(1).max(200),
      amount: z.number().finite().gt(0), description: z.string().max(1000), payment_mode: z.string().max(30),
    }).partial().strict(),
    async handler({ db, branch, body, params }) {
      return { expense: await updateRow(db, 'expenses', params.id, branch!, body) }
    },
  }),
  route({
    method: 'delete', path: '/api/expenses/:id', perm: 'expenses.write',
    async handler({ db, branch, params }) {
      const r = await db.query(`DELETE FROM public.expenses WHERE id = $1 AND branch_id = $2`, [params.id, branch])
      if (!r.rowCount) throw notFound()
      return { ok: true }
    },
  }),
  route({
    method: 'get', path: '/api/expense-categories', perm: 'expenses.read',
    async handler({ db, branch }) {
      const r = await db.query(`SELECT * FROM public.expense_categories WHERE branch_id = $1 ORDER BY name`, [branch])
      return { categories: r.rows }
    },
  }),
  route({
    method: 'post', path: '/api/expense-categories', perm: 'expenses.write', status: 201,
    body: z.object({ name: z.string().trim().min(1).max(100) }).strict(),
    async handler({ db, branch, body }) {
      return { category: await insertRow(db, 'expense_categories', branch!, { name: body.name, is_active: true }) }
    },
  }),
  route({
    method: 'patch', path: '/api/expense-categories/:id', perm: 'expenses.write',
    body: z.object({ name: z.string().trim().min(1).max(100) }).strict(),
    async handler({ db, branch, body, params }) {
      return { category: await updateRow(db, 'expense_categories', Number(params.id), branch!, { name: body.name }) }
    },
  }),
  route({
    method: 'delete', path: '/api/expense-categories/:id', perm: 'expenses.write',
    async handler({ db, branch, params }) {
      const r = await db.query(`DELETE FROM public.expense_categories WHERE id = $1 AND branch_id = $2`, [Number(params.id), branch])
      if (!r.rowCount) throw notFound()
      return { ok: true }
    },
  }),

  // ---- Analytics Dashboard data: Admin only ----
  route({
    method: 'get', path: '/api/analytics/orders', perm: 'analytics.read',
    query: z.object({ from: stamp.optional(), to: stamp.optional(), limit: z.coerce.number().int().min(1).max(20000).default(5000) }).strict(),
    async handler({ db, branch, query }) {
      const r = await db.query(
        `SELECT * FROM public.orders WHERE branch_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at <= $3)
         ORDER BY created_at DESC LIMIT ${query.limit}`, [branch, query.from ?? null, query.to ?? null])
      return { orders: r.rows }
    },
  }),
  route({
    method: 'get', path: '/api/analytics/order-items', perm: 'analytics.read',
    query: z.object({ from: stamp.optional(), to: stamp.optional(), limit: z.coerce.number().int().min(1).max(50000).default(20000) }).strict(),
    async handler({ db, branch, query }) {
      const r = await db.query(
        `SELECT i.* FROM public.order_items i JOIN public.orders o ON o.id = i.order_id AND o.branch_id = i.branch_id
         WHERE i.branch_id = $1 AND ($2::timestamptz IS NULL OR o.created_at >= $2) AND ($3::timestamptz IS NULL OR o.created_at <= $3)
         ORDER BY i.id DESC LIMIT ${query.limit}`, [branch, query.from ?? null, query.to ?? null])
      return { items: r.rows }
    },
  }),
  route({
    method: 'get', path: '/api/analytics/expenses', perm: 'analytics.read',
    query: z.object({ from: day.optional(), to: day.optional() }).strict(),
    async handler({ db, branch, query }) {
      const r = await db.query(
        `SELECT * FROM public.expenses WHERE branch_id = $1 AND ($2::date IS NULL OR expense_date >= $2) AND ($3::date IS NULL OR expense_date <= $3)
         ORDER BY expense_date DESC`, [branch, query.from ?? null, query.to ?? null])
      return { expenses: r.rows }
    },
  }),

  // ---- Cross-branch views: Admin only (no branch selector, all branches) ----
  route({
    method: 'get', path: '/api/global/overview', perm: 'global.read',
    async handler({ db }) {
      const r = await db.query(
        `SELECT b.id AS branch_id, b.short_label,
           (SELECT count(*)::int FROM public.orders o WHERE o.branch_id = b.id AND o.created_at >= date_trunc('day', now())) AS orders_today,
           (SELECT COALESCE(sum(o.total - o.returned_amount),0) FROM public.orders o WHERE o.branch_id = b.id AND o.created_at >= date_trunc('day', now()) AND lower(o.status) <> 'cancelled') AS sales_today,
           (SELECT COALESCE(sum(o.returned_amount),0) FROM public.orders o WHERE o.branch_id = b.id AND o.created_at >= date_trunc('day', now()) AND lower(o.status) <> 'cancelled') AS returned_today,
           (SELECT count(*)::int FROM public.products p WHERE p.branch_id = b.id AND p.is_active) AS active_products,
           (SELECT count(*)::int FROM public.products p WHERE p.branch_id = b.id AND p.is_active AND p.stock_quantity <= p.low_stock_alert) AS low_stock_products
         FROM public.branches b WHERE b.is_active ORDER BY b.sort_order`)
      return { branches: r.rows }
    },
  }),
  route({
    method: 'get', path: '/api/global/sales', perm: 'global.read',
    query: z.object({ from: stamp.optional(), to: stamp.optional() }).strict(),
    async handler({ db, query }) {
      const r = await db.query(
        `SELECT branch_id, (created_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS orders, COALESCE(sum(total),0) AS total, COALESCE(sum(returned_amount),0) AS returned,
                COALESCE(sum(total - returned_amount),0) AS net_total
         FROM public.orders WHERE lower(status) <> 'cancelled' AND ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::timestamptz IS NULL OR created_at <= $2)
         GROUP BY branch_id, 2 ORDER BY 2 DESC, branch_id`, [query.from ?? null, query.to ?? null])
      return { sales: r.rows }
    },
  }),
  route({
    method: 'get', path: '/api/global/stock', perm: 'global.read',
    async handler({ db }) {
      const r = await db.query(
        `SELECT branch_id, name, category, sku, barcode, stock_quantity, low_stock_alert, purchase_price, price FROM public.products
         WHERE is_active ORDER BY branch_id, name`)
      return { products: r.rows }
    },
  }),
  route({
    method: 'get', path: '/api/global/reports/orders', perm: 'global.read',
    query: z.object({ from: stamp.optional(), to: stamp.optional(), limit: z.coerce.number().int().min(1).max(50000).default(20000) }).strict(),
    async handler({ db, query }) {
      const r = await db.query(
        `SELECT * FROM public.orders WHERE ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::timestamptz IS NULL OR created_at <= $2)
         ORDER BY created_at DESC LIMIT ${query.limit}`, [query.from ?? null, query.to ?? null])
      return { orders: r.rows }
    },
  }),
  route({
    method: 'get', path: '/api/global/reports/order-items', perm: 'global.read',
    query: z.object({ from: stamp.optional(), to: stamp.optional(), limit: z.coerce.number().int().min(1).max(100000).default(50000) }).strict(),
    async handler({ db, query }) {
      const r = await db.query(
        `SELECT i.* FROM public.order_items i JOIN public.orders o ON o.id = i.order_id
         WHERE ($1::timestamptz IS NULL OR o.created_at >= $1) AND ($2::timestamptz IS NULL OR o.created_at <= $2) ORDER BY i.id DESC LIMIT ${query.limit}`,
        [query.from ?? null, query.to ?? null])
      return { items: r.rows }
    },
  }),
]

