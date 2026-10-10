/**
 * API tests. Boots the real Express app on a local port against DATABASE_URL, inside ONE database
 * transaction that is rolled back at the end (passcodes, data, rate-limit rows, token versions: nothing
 * is left behind), and restores every sequence it advanced.
 *   npm run test:api
 *
 * Section A is generated from the central permission table x every registered route x every role.
 */
import './test-guard'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import type { PoolClient } from 'pg'
import { allRoutes, createApp } from '../server/app'
import { getPool, singleClientDb } from '../server/lib/db'
import { repairSequences, restoreSequences, snapshotSequences } from './lib/devState'
import { PERMISSIONS, type PermKey } from '../server/lib/permissions'
import { slowdownMs } from '../server/lib/rateLimit'
import { registerRoutes } from '../server/lib/route'
import { FEATURE_ACCESS, FEATURE_SERVER_PERM, NAV_ORDER, REMOVED_TABS, ROLES as UI_ROLES, TAB_ACCESS, canOpenTab, type TabKey } from '../src/lib/permissions'

process.env.JWT_SECRET = `test-${randomBytes(24).toString('hex')}`
process.env.COOKIE_INSECURE = '1'
process.env.TRUST_PROXY = '1'
process.env.LOGIN_SLOWDOWN_STEP_MS = '20' // fast steps for the test; production default is 200 ms per failure, capped at 4 s
process.env.LOGIN_SLOWDOWN_MAX_MS = '400'

const SECRET = process.env.JWT_SECRET
const BRANCHES = ['pos1', 'pos2', 'pos3'] as const
type B = (typeof BRANCHES)[number]
type Actor = 'admin' | 'manager1' | 'manager2' | 'manager3' | 'staff1' | 'staff2' | 'staff3'
const PASS: Record<Actor, string> = {
  admin: 'Adm1n-Test-Pass-A', manager1: 'Mgr1-Test-Pass-B', manager2: 'Mgr2-Test-Pass-C', manager3: 'Mgr3-Test-Pass-D',
  staff1: 'Stf1-Test-Pass-E', staff2: 'Stf2-Test-Pass-F', staff3: 'Stf3-Test-Pass-G',
}
const ROLE_OF = (a: Actor) => (a === 'admin' ? 'admin' : a.startsWith('manager') ? 'manager' : 'staff') as 'admin' | 'manager' | 'staff'
const BRANCH_OF = (a: Actor): B | null => (a === 'admin' ? null : (`pos${a.slice(-1)}` as B))

// The run is split in two so one database connection never has to stay open for the whole (slow, remote) run:
//   --part=1  sections A to M      --part=2  sections M2 and N (billing safety, then the login lockouts, which must run last)
// With no argument everything runs in one go. npm run test:api runs both parts.
const PART = (process.argv.find((a) => a.startsWith('--part=')) || '').slice('--part='.length)

let passed = 0
let failed = 0
const results: string[] = []
const check = (ok: boolean, label: string, detail = '') => {
  ok ? passed++ : failed++
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? `  (${detail})` : ''}`)
}

async function run() {
  const pool = getPool()
  const client: PoolClient = await pool.connect()
  // Neon can reset a long-held connection; without a listener that error would kill the process before the finally block restores the counters
  client.on('error', (e) => console.error('database connection error:', e.message))
  const db = singleClientDb(client)
  const rows = async <T = any>(sql: string, p: unknown[] = []): Promise<T[]> => (await client.query(sql, p)).rows as T[]
  const one = async <T = any>(sql: string, p: unknown[] = []): Promise<T> => (await rows<T>(sql, p))[0]

  // sequences are not transactional: heal leftovers of an earlier killed run, remember the state, and restore it in the
  // finally block (also on Ctrl+C / SIGTERM) so an interrupted run cannot leave counters moved
  const healed = await repairSequences(pool)
  if (healed.length) console.warn('repaired counters left over from an earlier interrupted run:\n  ' + healed.join('\n  '))
  const seqSnapshot = await snapshotSequences(pool)
  let restored = false
  const restoreOnce = async () => { if (restored) return; restored = true; await restoreSequences(pool, seqSnapshot) }
  const onSignal = (sig: NodeJS.Signals) => { void restoreOnce().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143)) }
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal)
  const base = await one(`SELECT (SELECT count(*) FROM products)::int p, (SELECT count(*) FROM orders)::int o, (SELECT count(*) FROM expenses)::int e,
    (SELECT count(*) FROM login_attempts)::int l, (SELECT string_agg(md5(passcode_hash) || token_version::text, ',' ORDER BY id) FROM passcodes) pc`)

  const blobCalls: Array<{ pathname: string; type: string; size: number }> = []
  const app = createApp({
    db,
    blobPut: async (pathname, body, o) => { blobCalls.push({ pathname, type: o.contentType, size: body.length }); return { url: `https://blob.test/${pathname}` } },
  })
  const server = await new Promise<import('node:http').Server>((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  await client.query('BEGIN')
  let ipN = 0
  const freshIp = () => `10.20.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`
  let spN = 0

  type Res = { status: number; body: any; headers: Headers; cookies: string[] }
  async function call(method: string, path: string, o: { cookie?: string; body?: unknown; query?: Record<string, string>; headers?: Record<string, string>; ip?: string; raw?: { buf: Buffer; type: string } } = {}): Promise<Res> {
    const qs = o.query ? `?${new URLSearchParams(o.query).toString()}` : ''
    const headers: Record<string, string> = { 'x-forwarded-for': o.ip ?? freshIp(), ...(o.headers ?? {}) }
    if (o.cookie) headers.cookie = o.cookie
    let body: any
    if (o.raw) { headers['content-type'] = o.raw.type; body = o.raw.buf } else if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body) }
    // each request runs in its own savepoint: a database error inside one request must not poison the shared test transaction
    const sp = `req_${spN++}`
    await client.query(`SAVEPOINT ${sp}`)
    const r = await fetch(origin + path + qs, { method: method.toUpperCase(), headers, body })
    const text = await r.text()
    let json: any = null
    try { json = text ? JSON.parse(text) : null } catch { json = text }
    try { await client.query(`RELEASE SAVEPOINT ${sp}`) } catch { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); await client.query(`RELEASE SAVEPOINT ${sp}`) }
    return { status: r.status, body: json, headers: r.headers, cookies: r.headers.getSetCookie() }
  }
  const cookieOf = (r: Res) => { const m = /yg_session=([^;]*)/.exec(r.cookies.join(';')); return m && m[1] ? `yg_session=${m[1]}` : '' }

  try {
    // ------------------------------------------------------------------ setup: known passcodes (rolled back at the end)
    const hashes: Record<string, string> = {}
    for (const a of Object.keys(PASS) as Actor[]) hashes[a] = await bcrypt.hash(PASS[a], 4)
    for (const a of Object.keys(PASS) as Actor[]) {
      await client.query(`UPDATE passcodes SET passcode_hash = $1, token_version = 1 WHERE role = $2 AND branch_id IS NOT DISTINCT FROM $3`, [hashes[a], ROLE_OF(a), BRANCH_OF(a)])
    }
    const cookies = {} as Record<Actor, string>
    for (const a of Object.keys(PASS) as Actor[]) {
      const r = await call('POST', '/api/auth/login', { body: { passcode: PASS[a] } })
      cookies[a] = cookieOf(r)
      check(r.status === 200 && r.body.role === ROLE_OF(a) && r.body.branch === BRANCH_OF(a) && !!cookies[a], `login as ${a}`, `status ${r.status}`)
    }

    // seed one category / product / variant / coupon per branch straight into the database
    const prod = {} as Record<B, number>
    const variant = {} as Record<B, string>
    const cat = {} as Record<B, number>
    for (const b of BRANCHES) {
      cat[b] = (await one(`INSERT INTO categories (name_en, branch_id) VALUES ('Api Cat', $1) RETURNING id`, [b])).id
      prod[b] = (await one(`INSERT INTO products (name, category, category_id, price, stock_quantity, stock, sku, branch_id, is_active, has_variants) VALUES ('Api Product', 'Api Cat', $2, 100, 10, 10, 'API-1', $1, true, false) RETURNING id`, [b, cat[b]])).id
      variant[b] = (await one(`INSERT INTO product_variants (product_id, variant_name, price, stock, branch_id, is_active) VALUES ($1, 'Large', 100, 5, $2, true) RETURNING id`, [prod[b], b])).id
      await client.query(`INSERT INTO coupons (code, percentage, branch_id) VALUES ('API10', 10, $1)`, [b])
    }
    const stockOf = async (id: number) => Number((await one(`SELECT stock_quantity::numeric s FROM products WHERE id = $1`, [id])).s)
    const asAdmin = (b: B) => ({ cookie: cookies.admin, query: { branch_id: b } })

    if (PART !== '2') {
    // ================================================================== A. matrix-driven: permission table x routes x roles
    const SUBST = (p: string) => p.replace(/:[a-z]+/g, '999999999')
    const actorsByRole: Record<string, Actor> = { admin: 'admin', manager: 'manager1', staff: 'staff1' }
    let combos = 0
    for (const r of allRoutes) {
      const spec = PERMISSIONS[r.perm]
      const hasBody = r.method === 'post' || r.method === 'put' || r.method === 'patch'
      const anon = await call(r.method, SUBST(r.path), { body: hasBody ? {} : undefined })
      combos++
      if (spec.roles === 'public') check(anon.status !== 401 && anon.status !== 403, `matrix: ${r.method.toUpperCase()} ${r.path} is public (anonymous passes the gate)`, `status ${anon.status}`)
      else check(anon.status === 401, `matrix: ${r.method.toUpperCase()} ${r.path} anonymous -> 401`, `status ${anon.status}`)
      for (const role of ['admin', 'manager', 'staff'] as const) {
        const actor = actorsByRole[role]
        const query = role === 'admin' && spec.scope === 'branch' ? { branch_id: 'pos1' } : undefined
        const resp = await call(r.method, SUBST(r.path), { cookie: cookies[actor], body: hasBody ? {} : undefined, query })
        combos++
        const allowed = spec.roles === 'public' || spec.roles.includes(role)
        if (allowed) check(resp.status !== 401 && resp.status !== 403, `matrix: ${r.method.toUpperCase()} ${r.path} ${role} allowed`, `status ${resp.status}`)
        else check(resp.status === 403, `matrix: ${r.method.toUpperCase()} ${r.path} ${role} -> 403`, `status ${resp.status}`)
      }
    }
    check(true, `matrix covered ${allRoutes.length} routes, ${combos} route x role combinations`)
    const usedPerms = new Set(allRoutes.map((r) => r.perm))
    const unused = (Object.keys(PERMISSIONS) as PermKey[]).filter((k) => !usedPerms.has(k))
    check(unused.length === 0, 'every permission key is used by at least one route', unused.join(','))
    {
      let threw = false
      try { registerRoutes((await import('express')).default(), [{ method: 'get', path: '/x', perm: 'nope.nope' as PermKey, handler: async () => ({}) }], { db, blobPut: async () => ({ url: '' }) }) } catch { threw = true }
      check(threw, 'default deny: a route without a permission-table entry cannot be registered')
      const un = await call('GET', '/api/does-not-exist', { cookie: cookies.admin })
      check(un.status === 404, 'default deny: unknown /api path -> 404')
    }
    // never offered to anyone (matrix flags 4): no endpoints for attendance, branch hub, customer users, staff order-delete code
    const forbiddenPaths = ['/api/attendance', '/api/staff-members', '/api/branch-hub', '/api/users', '/api/profiles', '/api/credentials']
    for (const p of forbiddenPaths) check((await call('GET', p, { cookie: cookies.admin })).status === 404, `no endpoint ${p} (default deny, even for admin)`)

    // ================================================================== A2. the UI permission config agrees with the server table
    {
      const same = (a: readonly string[], b: readonly string[]) => [...a].sort().join() === [...b].sort().join()
      for (const [feature, perms] of Object.entries(FEATURE_SERVER_PERM)) {
        for (const p of perms) {
          const server = PERMISSIONS[p as PermKey].roles
          check(server !== 'public' && same(server, FEATURE_ACCESS[feature as keyof typeof FEATURE_ACCESS]), `UI feature "${feature}" has the same roles as server permission "${p}"`)
        }
      }
      const tabPerm: Partial<Record<TabKey, PermKey>> = { pos_analytics: 'analytics.read', staff_memberships: 'passcodes.list', business_overview: 'global.read', expenses: 'expenses.read', coupons: 'coupons.read', store_settings: 'settings.write', billing: 'pos.sale', inventory: 'inventory.read', advance_orders: 'advance.read', history: 'orders.read' }
      for (const [tab, perm] of Object.entries(tabPerm) as [TabKey, PermKey][]) {
        const server = PERMISSIONS[perm].roles
        const extra = TAB_ACCESS[tab].filter((r) => server === 'public' || !server.includes(r))
        check(extra.length === 0, `tab "${tab}" is never shown to a role the server would refuse (${perm})`, extra.join(','))
      }
      check(!canOpenTab('manager', 'pos_analytics') && !canOpenTab('staff', 'pos_analytics') && canOpenTab('admin', 'pos_analytics'), 'Analytics Dashboard tab: admin only')
      check(!canOpenTab('manager', 'staff_memberships') && !canOpenTab('manager', 'business_overview'), 'manager has no passcode tab and no cross-branch tab')
      check(UI_ROLES.every((r) => REMOVED_TABS.every((t) => !canOpenTab(r, t) || t === 'branch_hub')), 'tabs the original removed are open to nobody (branch_hub only for staff)')
      check(canOpenTab('staff', 'branch_hub') && !canOpenTab('manager', 'branch_hub') && !canOpenTab('admin', 'branch_hub'), 'branch hub follows the original: staff only')
      check(same(NAV_ORDER.manager, NAV_ORDER.admin.filter((t) => !['pos_analytics', 'coupons', 'store_settings'].includes(t))), 'manager sidebar = admin sidebar minus Analytics Dashboard, Coupons and Store Settings')
      check(!canOpenTab('manager', 'coupons') && !canOpenTab('staff', 'coupons') && canOpenTab('admin', 'coupons') && !canOpenTab('manager', 'store_settings') && !canOpenTab('staff', 'store_settings') && canOpenTab('admin', 'store_settings'), 'Coupons and Store Settings tabs: admin only')
      check(same(NAV_ORDER.staff, ['branch_hub', 'billing', 'advance_orders', 'history']), 'staff sidebar: Store Hub, POS, Advance Orders, Order History (no Stock & Inventory)')
      check(!canOpenTab('staff', 'inventory') && canOpenTab('manager', 'inventory') && canOpenTab('admin', 'inventory'), 'Stock & Inventory tab: admin and manager only')
      check(UI_ROLES.every((r) => NAV_ORDER[r].every((t) => canOpenTab(r, t))), 'every sidebar entry is openable by its own role')
      check(FEATURE_ACCESS['branch.switch'].join() === 'admin', 'only the admin has the branch switcher')
    }

    // ================================================================== B. login / session cookie
    {
      const ok = await call('POST', '/api/auth/login', { body: { passcode: PASS.staff1 } })
      const sc = ok.cookies.find((c) => c.startsWith('yg_session=')) || '' // (the login response also carries the device cookie)
      check(/HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc) && /Path=\//.test(sc), 'session cookie is httpOnly + sameSite=strict')
      const maxAge = Number(/Max-Age=(\d+)/.exec(sc)?.[1])
      check(maxAge > 0 && maxAge <= 8 * 3600, 'session cookie expiry is short (<= 8h)', `${maxAge}`)
      process.env.COOKIE_INSECURE = ''
      const sec = await call('POST', '/api/auth/login', { body: { passcode: PASS.staff1 } })
      process.env.COOKIE_INSECURE = '1'
      check(/;\s*Secure/i.test(sec.cookies.find((c) => c.startsWith('yg_session=')) || ''), 'session cookie is Secure unless local-http mode is on')
      check(!JSON.stringify(ok.body).includes('token'), 'login response does not contain the token')
      const bad1 = await call('POST', '/api/auth/login', { body: { passcode: 'definitely-wrong-passcode' } })
      const bad2 = await call('POST', '/api/auth/login', { body: { passcode: PASS.staff1 + 'x' } })
      check(bad1.status === 401 && bad2.status === 401 && JSON.stringify(bad1.body) === JSON.stringify(bad2.body) && bad1.body.error === 'Incorrect passcode', 'wrong passcodes get one generic 401 message')
      check(!JSON.stringify(bad1.body).includes('definitely-wrong'), 'error responses never echo the submitted passcode')
      const me = await call('GET', '/api/auth/me', { cookie: cookies.staff2 })
      check(me.status === 200 && me.body.role === 'staff' && me.body.branch === 'pos2' && me.body.branches.length === 1 && me.body.branches[0].id === 'pos2', 'staff2 /me shows only branch 2')
      const meAdmin = await call('GET', '/api/auth/me', { cookie: cookies.admin })
      check(meAdmin.body.branches.length === 3, 'admin /me lists all 3 branches')
      const lo = await call('POST', '/api/auth/logout', { cookie: cookies.staff1 })
      check(lo.status === 200 && /Max-Age=0/.test(lo.cookies.join(';')), 'logout clears the cookie')
      check((await call('POST', '/api/auth/login', { body: { passcode: PASS.staff1, extra: 1 } })).status === 400, 'login rejects unknown body fields (zod strict)')
      check((await call('POST', '/api/auth/login', { body: { passcode: 12345678 } })).status === 400, 'login rejects a non-string passcode (zod)')
      check((await call('POST', '/api/auth/login', { body: {} })).status === 400, 'login rejects a missing passcode (zod)')

      // ---- the login screen's portal selection (tab + branch tile) can only make sign-in stricter
      const L = (body: Record<string, unknown>) => call('POST', '/api/auth/login', { body })
      const right = await L({ passcode: PASS.staff1, as: 'staff', site: 'pos1' })
      check(right.status === 200 && right.body.role === 'staff' && right.body.branch === 'pos1', 'right passcode on the right tab + branch tile signs in')
      const adm = await L({ passcode: PASS.admin, as: 'admin' })
      check(adm.status === 200 && adm.body.role === 'admin' && adm.body.branch === null, 'admin passcode on the Admin tab signs in')
      const mgr = await L({ passcode: PASS.manager3, as: 'manager', site: 'pos3' })
      check(mgr.status === 200 && mgr.body.role === 'manager' && mgr.body.branch === 'pos3', 'manager 3 passcode on the Manager tab + Branch 3 tile signs in')
      const generic = JSON.stringify({ error: 'Incorrect passcode' })
      const refused = [
        ['staff1 passcode on another branch tile', { passcode: PASS.staff1, as: 'staff', site: 'pos2' }],
        ['staff1 passcode on the Manager tab', { passcode: PASS.staff1, as: 'manager', site: 'pos1' }],
        ['staff1 passcode on the Admin tab', { passcode: PASS.staff1, as: 'admin' }],
        ['admin passcode on the Staff tab', { passcode: PASS.admin, as: 'staff', site: 'pos1' }],
        ['admin passcode on the Admin tab with a branch tile', { passcode: PASS.admin, as: 'admin', site: 'pos1' }],
        ['manager1 passcode on the Staff tab', { passcode: PASS.manager1, as: 'staff', site: 'pos1' }],
        ['a staff tab without any branch tile', { passcode: PASS.staff1, as: 'staff' }],
        ['an unknown branch tile', { passcode: PASS.staff1, as: 'staff', site: 'pos9' }],
      ] as const
      for (const [label, body] of refused) {
        const r = await L({ ...body })
        check(r.status === 401 && JSON.stringify(r.body) === generic && !r.cookies.some((c) => c.startsWith('yg_session=')), `${label} is refused with the same generic 401 and no cookie`, `${r.status} ${JSON.stringify(r.body)}`)
      }
      check((await L({ passcode: PASS.staff1, as: 'owner' })).status === 400, 'login rejects an unknown portal name (zod)')
      check((await L({ passcode: PASS.staff1, as: 'staff', site: 'POS 1; DROP' })).status === 400, 'login rejects a malformed branch tile id (zod)')
    }

    // ================================================================== C. a passcode never opens another branch / higher role
    {
      const m = await call('GET', '/api/products', { cookie: cookies.manager1 })
      check(m.body.products.every((p: any) => p.branch_id === 'pos1') && m.body.products.some((p: any) => p.id === prod.pos1), 'manager1 passcode sees only branch 1 products')
      for (const b of ['pos2', 'pos3'] as const) {
        check((await call('GET', `/api/products/${prod[b]}`, { cookie: cookies.staff1 })).status === 404, `staff1 cannot read a ${b} product by id`)
        check((await call('GET', `/api/products/${prod[b]}`, { cookie: cookies.manager1 })).status === 404, `manager1 cannot read a ${b} product by id`)
        const patch = await call('PATCH', `/api/products/${prod[b]}`, { cookie: cookies.manager1, body: { price: 1 } })
        check(patch.status === 404 && (await one(`SELECT price::numeric p FROM products WHERE id = $1`, [prod[b]])).p == 100, `manager1 cannot edit a ${b} product`)
        check((await call('PATCH', `/api/products/${prod[b]}`, { cookie: cookies.staff1, body: { price: 1 } })).status === 403, `staff1 cannot edit any product (403)`)
        check((await call('PATCH', `/api/variants/${variant[b]}`, { cookie: cookies.manager1, body: { price: 1 } })).status === 404, `manager1 cannot edit a ${b} variant`)
      }
      for (const [a, other] of [['staff2', 'pos1'], ['manager3', 'pos2'], ['staff3', 'pos1']] as [Actor, B][]) {
        if (a.startsWith('staff')) {
          // staff has no stock list: only the narrow alert endpoint, which carries nothing from another branch
          check((await call('GET', '/api/inventory/low-stock', { cookie: cookies[a] })).status === 403, `${a} cannot read the full low-stock list (403)`)
          const al = await call('GET', '/api/inventory/low-stock-alerts', { cookie: cookies[a] })
          check(al.status === 200 && al.body.items.every((x: any) => x.id !== `p-${prod[other]}`), `${a} low-stock alerts contain nothing from ${other}`)
          continue
        }
        const r = await call('GET', '/api/inventory/low-stock', { cookie: cookies[a] })
        check(r.body.products.every((p: any) => p.id !== prod[other]), `${a} low-stock list contains nothing from ${other}`)
      }
      // staff passcode can never act as manager / admin
      const sv = await call('PUT', '/api/admin/passcodes', { cookie: cookies.staff1, body: { target_role: 'staff', target_branch: 'pos1', new_passcode: 'Another-Pass-123', current_admin_passcode: PASS.admin } })
      check(sv.status === 403, 'staff cannot manage passcodes even with the admin passcode in the body')
      check((await call('DELETE', '/api/inventory/items', { cookie: cookies.staff1, query: { product_id: String(prod.pos1) } })).status === 403, 'staff cannot delete inventory items')
      check((await call('PATCH', `/api/orders/${'00000000-0000-4000-8000-000000000000'}/status`, { cookie: cookies.staff1, body: { status: 'completed' } })).status === 404, 'staff may change order status (an unknown bill is a plain 404, not 403)')
      check((await call('DELETE', `/api/orders/${'00000000-0000-4000-8000-000000000000'}`, { cookie: cookies.staff1 })).status === 403, 'staff has no order-delete endpoint (403)')
    }

    // ================================================================== D. forged branch_id (body / query / header / nested)
    {
      const forged: Array<[string, (a: Actor, victim: B) => Parameters<typeof call>[2]]> = [
        ['body branch_id', (a, v) => ({ cookie: cookies[a], body: { name: 'Forged', branch_id: v } })],
        ['body branch', (a, v) => ({ cookie: cookies[a], body: { name: 'Forged', branch: v } })],
        ['nested body branchId', (a, v) => ({ cookie: cookies[a], body: { name: 'Forged', meta: { items: [{ branchId: v }] } } })],
        ['query branch_id', (a, v) => ({ cookie: cookies[a], body: { name: 'Forged' }, query: { branch_id: v } })],
        ['query branch', (a, v) => ({ cookie: cookies[a], body: { name: 'Forged' }, query: { branch: v } })],
        ['header x-branch-id', (a, v) => ({ cookie: cookies[a], body: { name: 'Forged' }, headers: { 'x-branch-id': v } })],
        ['header x-branch', (a, v) => ({ cookie: cookies[a], body: { name: 'Forged' }, headers: { 'x-branch': v } })],
      ]
      const before = await one(`SELECT count(*)::int n FROM products WHERE name = 'Forged'`)
      for (const a of ['staff1', 'manager1', 'staff2', 'manager3'] as Actor[]) {
        const own = BRANCH_OF(a)!
        const victim = BRANCHES.find((b) => b !== own)!
        for (const [label, mk] of forged) {
          const r = await call('POST', '/api/products', mk(a, victim))
          // staff may not create products at all (403 comes before any branch check); managers get the forged-branch 400
          check(r.status === (a.startsWith('staff') ? 403 : 400), `${a}: forged ${label} is rejected`, `status ${r.status}`)
        }
        // even a branch id equal to their OWN is refused: the client never names a branch
        check((await call('POST', '/api/products', { cookie: cookies[a], body: { name: 'Forged', branch_id: own } })).status === (a.startsWith('staff') ? 403 : 400), `${a}: even own branch_id in the body is refused`)
        // a forged branch on a read staff DOES keep (the POS catalog) is still refused
        for (const [label, extra] of [['header x-branch-id', { headers: { 'x-branch-id': victim } }], ['query branch', { query: { branch: victim } }]] as const) {
          check((await call('GET', '/api/products', { cookie: cookies[a], ...extra } as any)).status === 400, `${a}: GET /api/products with a forged ${label} is refused`)
        }
        check((await call('GET', '/api/products', { cookie: cookies[a], query: { branch_id: victim } })).status === 400, `${a}: GET with ?branch_id= is refused`)
      }
      const after = await one(`SELECT count(*)::int n FROM products WHERE name = 'Forged'`)
      check(after.n === before.n, 'no forged product was created in any branch')
      // sale body with a branch hidden inside an item
      const sale = await call('POST', '/api/pos/sale', { cookie: cookies.staff1, body: { items: [{ product_id: prod.pos2, quantity: 1, unit_price: 100, branch_id: 'pos2' }] } })
      check(sale.status === 400 && (await stockOf(prod.pos2)) === 10, 'branch hidden inside a sale item is refused, pos2 stock untouched')
      // Admin: selector only, validated
      check((await call('GET', '/api/products', { cookie: cookies.admin })).status === 400, 'admin without branch_id on a branch route -> 400')
      check((await call('GET', '/api/products', { cookie: cookies.admin, query: { branch_id: 'nope' } })).status === 400, 'admin with an unknown branch_id -> 400')
      check((await call('GET', '/api/products', { cookie: cookies.admin, query: { branch_id: "pos1' OR '1'='1" } })).status === 400, 'admin branch_id injection attempt -> 400')
      for (const b of BRANCHES) {
        const r = await call('GET', '/api/products', asAdmin(b))
        check(r.status === 200 && r.body.products.length > 0 && r.body.products.every((p: any) => p.branch_id === b), `admin ?branch_id=${b} sees only ${b}`)
      }
      check((await call('POST', '/api/products', { cookie: cookies.admin, query: { branch_id: 'pos2' }, body: { name: 'Forged', branch_id: 'pos3' } })).status === 400, 'admin: branch_id in the BODY is refused (selector is query-only)')
      check((await call('GET', '/api/global/overview', { cookie: cookies.admin, query: { branch_id: 'pos1' } })).status === 400, 'branch_id is refused on a global route')
      // strict zod: unknown fields
      check((await call('POST', '/api/products', { cookie: cookies.manager1, body: { name: 'X', is_admin: true } })).status === 400, 'unknown product field rejected (zod strict)')
    }

    // ================================================================== E. tokens: expired / tampered / stale
    {
      const good = cookies.staff1.replace('yg_session=', '')
      const probe = async (token: string) => (await call('GET', '/api/auth/me', { cookie: `yg_session=${token}` })).status
      check((await probe(good)) === 200, 'a fresh token works (control)')
      const expired = jwt.sign({ role: 'staff', branch: 'pos1', tv: 1 }, SECRET, { algorithm: 'HS256', expiresIn: -10 })
      check((await probe(expired)) === 401, 'expired JWT is rejected')
      const [h, p, s] = good.split('.')
      const tamperedSig = `${h}.${p}.${s.slice(0, -2)}${s.slice(-2) === 'AA' ? 'BB' : 'AA'}`
      check((await probe(tamperedSig)) === 401, 'JWT with a tampered signature is rejected')
      const upgraded = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), role: 'admin', branch: null })).toString('base64url')
      check((await probe(`${h}.${upgraded}.${s}`)) === 401, 'JWT with role edited to admin (signature kept) is rejected')
      const rebranched = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), branch: 'pos2' })).toString('base64url')
      check((await probe(`${h}.${rebranched}.${s}`)) === 401, 'JWT with branch edited to pos2 (signature kept) is rejected')
      check((await probe(jwt.sign({ role: 'admin', branch: null, tv: 1 }, 'some-other-secret-0123456789012345678901', { algorithm: 'HS256' }))) === 401, 'JWT signed with another secret is rejected')
      const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"role":"admin","branch":null,"tv":1}').toString('base64url')}.`
      check((await probe(none)) === 401, 'alg=none JWT is rejected')
      check((await probe(jwt.sign({ role: 'staff', branch: 'pos1', tv: 99 }, SECRET, { algorithm: 'HS256', expiresIn: 60 }))) === 401, 'correctly signed JWT with a stale token_version is rejected')
      check((await probe(jwt.sign({ role: 'staff', branch: null, tv: 1 }, SECRET, { algorithm: 'HS256', expiresIn: 60 }))) === 401, 'signed staff JWT without a branch is rejected')
      check((await probe(jwt.sign({ role: 'admin', branch: 'pos1', tv: 1 }, SECRET, { algorithm: 'HS256', expiresIn: 60 }))) === 401, 'signed admin JWT carrying a branch is rejected')
      check((await probe(jwt.sign({ role: 'root', branch: null, tv: 1 }, SECRET, { algorithm: 'HS256', expiresIn: 60 }))) === 401, 'JWT with an unknown role is rejected')
      check((await call('GET', '/api/auth/me', { headers: { authorization: `Bearer ${good}` } })).status === 401, 'a Bearer header is not accepted (cookie only)')
      check((await probe('garbage')) === 401, 'garbage token is rejected')
    }

    // ================================================================== F. barcodes: branch from token, scan is branch-scoped
    {
      const gen = {} as Record<B, any>
      for (const b of BRANCHES) {
        const a = `manager${b.slice(-1)}` as Actor // generating barcodes / receiving stock is Admin / Manager work
        const before = await stockOf(prod[b])
        const r = await call('POST', '/api/barcodes/receive', { cookie: cookies[a], body: { product_id: prod[b], quantity_received: 4, unit_cost: 50 } })
        gen[b] = r.body
        check(r.status === 200 && r.body.is_new_barcode === true && r.body.barcode_value.startsWith({ pos1: 'PBP', pos2: 'P2P', pos3: 'P3P' }[b]), `${a} generates a ${b} barcode through the API`, r.body?.error ?? '')
        check((await stockOf(prod[b])) === before + 4, `receive-stock changes ${b} stock only through its own token`)
        const mv = (await one(`SELECT created_by_name, branch_id FROM inventory_movements WHERE barcode_id = $1 ORDER BY id DESC LIMIT 1`, [r.body.barcode_id])) ?? {}
        check(mv.branch_id === b && mv.created_by_name === 'Manager', `${b} receipt is stamped with the token's branch and role name`)
      }
      check(new Set(Object.values(gen).map((g: any) => g.barcode_value)).size === 3, 'same product in 3 branches got 3 different barcodes via the API')
      const others = (b: B) => BRANCHES.filter((x) => x !== b)
      for (const b of BRANCHES) {
        const own = `staff${b.slice(-1)}` as Actor
        const ok = await call('GET', '/api/barcodes/lookup', { cookie: cookies[own], query: { code: gen[b].barcode_value } })
        check(ok.status === 200 && ok.body.record.product_id === prod[b], `scan of ${gen[b].barcode_value} at ${b} finds the ${b} item`)
        for (const o of others(b)) {
          for (const actor of [`staff${o.slice(-1)}`, `manager${o.slice(-1)}`] as Actor[]) {
            const r = await call('GET', '/api/barcodes/lookup', { cookie: cookies[actor], query: { code: gen[b].barcode_value } })
            check(r.status === 404 && r.body.error === 'Barcode not found', `${b} barcode scanned as ${actor} returns not found`, `status ${r.status}`)
          }
          check((await call('GET', '/api/barcodes/lookup', { cookie: cookies.admin, query: { branch_id: o, code: gen[b].barcode_value } })).status === 404, `${b} barcode scanned by admin working in ${o} returns not found`)
          check((await call('GET', '/api/barcodes/print-data', { cookie: cookies[`manager${o.slice(-1)}` as Actor], query: { product_id: String(prod[b]) } })).status === 404, `print-data for a ${b} product from ${o} -> not found`)
        }
      }
      // never adds another branch's item: receive/print/receive by foreign product id
      const x = await call('POST', '/api/barcodes/receive', { cookie: cookies.manager3, body: { product_id: prod.pos1, quantity_received: 9 } })
      check(x.status === 400 && (await stockOf(prod.pos1)) === 14, 'manager3 cannot receive stock against a branch 1 product')
      check((await call('POST', '/api/barcodes/receive', { cookie: cookies.manager1, body: { product_id: prod.pos1, quantity_received: 1, branch_id: 'pos2' } })).status === 400, 'receive-stock refuses a client branch_id')
      const reg = await call('PUT', '/api/barcodes/register', { cookie: cookies.manager1, body: { product_id: prod.pos2, barcode_value: '8901234567890' } })
      check(reg.status === 409 || reg.status === 400, 'manager1 cannot register a barcode on a branch 2 product', `status ${reg.status}`)
      const m1 = await call('PUT', '/api/barcodes/register', { cookie: cookies.manager1, body: { product_id: prod.pos1, barcode_value: '8901234567890' } })
      const m2 = await call('PUT', '/api/barcodes/register', { cookie: cookies.manager2, body: { product_id: prod.pos2, barcode_value: '8901234567890' } })
      check(m1.status === 200 && m2.status === 200, 'the same manufacturer barcode can be registered once per branch')
      const s1 = await call('GET', '/api/barcodes/lookup', { cookie: cookies.staff1, query: { code: '8901234567890' } })
      const s2 = await call('GET', '/api/barcodes/lookup', { cookie: cookies.staff2, query: { code: '8901234567890' } })
      const s3 = await call('GET', '/api/barcodes/lookup', { cookie: cookies.staff3, query: { code: '8901234567890' } })
      check(s1.body.record?.product_id === prod.pos1 && s2.body.record?.product_id === prod.pos2 && s3.status === 404, 'a shared manufacturer barcode resolves to each branch\'s own product only')
      check((await call('PUT', '/api/barcodes/register', { cookie: cookies.manager1, body: { product_id: prod.pos1, barcode_value: 'P2P55555555' } })).status === 400, 'a barcode with another branch\'s prefix is rejected (trigger)')
      check((await call('GET', '/api/barcodes/lookup', { cookie: cookies.staff1, query: { code: gen.pos1.barcode_value.toLowerCase() + ' ' } })).status === 200, 'scan lookup tolerates case and spaces')
      const list = await call('GET', '/api/barcodes', { cookie: cookies.manager2 })
      const listIds = (list.body.records ?? []).map((r: any) => r.id)
      const foreign = await one(`SELECT count(*)::int n FROM barcode_registry WHERE id = ANY($1::uuid[]) AND branch_id <> 'pos2'`, [listIds])
      check(list.status === 200 && foreign.n === 0 && list.body.records.some((r: any) => r.product_id === prod.pos2), "barcode list shows only the token's branch (the shop's own real barcodes may be in it)")
      check((await call('POST', `/api/barcodes/${gen.pos1.barcode_id}/deactivate`, { cookie: cookies.manager2 })).status === 404, 'manager2 cannot deactivate a branch 1 barcode')
      check((await call('POST', `/api/barcodes/${gen.pos1.barcode_id}/deactivate`, { cookie: cookies.staff2 })).status === 403, 'staff2 cannot deactivate any barcode (403)')
    }

    // ================================================================== G. billing through the API (maths stays in SQL)
    {
      const before = { 1: await stockOf(prod.pos1), 2: await stockOf(prod.pos2) }
      const sale = await call('POST', '/api/pos/sale', { cookie: cookies.staff1, body: { items: [{ product_id: prod.pos1, quantity: 2, unit_price: 100, name: 'Api Product' }], payment_method: 'cash' } })
      const rng = await one(`SELECT invoice_start, invoice_end FROM branches WHERE id = 'pos1'`)
      check(sale.status === 201 && Number(sale.body.invoice_no) >= Number(rng.invoice_start) && Number(sale.body.invoice_no) <= Number(rng.invoice_end), 'staff1 sale creates a branch-1 invoice number', sale.body?.error ?? '')
      check((await stockOf(prod.pos1)) === before[1] - 2, 'sale reduced branch 1 stock')
      const cross = await call('POST', '/api/pos/sale', { cookie: cookies.staff1, body: { items: [{ product_id: prod.pos2, quantity: 1, unit_price: 100, name: 'x' }] } })
      check(cross.status >= 400 && (await stockOf(prod.pos2)) === before[2], 'staff1 cannot bill a branch 2 product (rejected, stock untouched)', `status ${cross.status}`)
      const ord = await one(`SELECT branch_id, total::numeric t FROM orders WHERE invoice_no = $1`, [sale.body.invoice_no])
      check(ord.branch_id === 'pos1' && Number(ord.t) === 200, 'order stored in branch 1 with the SQL-computed total')
      check((await call('POST', '/api/pos/sale', { cookie: cookies.staff1, body: { items: [{ product_id: prod.pos1, quantity: 1 }], total: 1 } })).status === 400, 'a client-supplied total is refused (zod strict): the server never trusts maths from the client')
      check((await call('POST', '/api/pos/sale', { cookie: cookies.staff1, body: { items: [] } })).status === 400, 'empty sale rejected (zod)')
      check((await call('POST', '/api/pos/sale', { cookie: cookies.staff1, body: { items: [{ product_id: prod.pos1, quantity: 1 }], shipping: -5 } })).status === 400, 'negative shipping rejected (zod)')
      // order history is branch scoped
      const h2 = await call('GET', '/api/orders', { cookie: cookies.staff2 })
      check(h2.status === 200 && h2.body.orders.every((o: any) => o.branch_id === 'pos2') && !h2.body.orders.some((o: any) => o.invoice_no === sale.body.invoice_no), 'staff2 order history never shows branch 1 bills')
      const g = await call('GET', `/api/orders/${sale.body.order_id}`, { cookie: cookies.staff3 })
      check(g.status === 404, 'staff3 cannot open a branch 1 order by id')
      check((await call('GET', `/api/orders/${sale.body.order_id}`, { cookie: cookies.staff1 })).body.items.length >= 1, 'staff1 can open its own order with items')
      // status / delete: manager yes (own branch only), staff no
      check((await call('PATCH', `/api/orders/${sale.body.order_id}/status`, { cookie: cookies.manager2, body: { status: 'cancelled' } })).status === 404, 'manager2 cannot change a branch 1 order status')
      check((await call('PATCH', `/api/orders/${sale.body.order_id}/status`, { cookie: cookies.manager1, body: { status: 'pending' } })).status === 200, 'manager1 can change its own order status')
      check((await call('DELETE', `/api/orders/${sale.body.order_id}`, { cookie: cookies.admin, query: { branch_id: 'pos3' } })).status === 404, 'admin on branch 3 cannot delete a branch 1 order')
      // coupons
      check((await call('GET', '/api/coupons/lookup', { cookie: cookies.staff1, query: { code: 'api10' } })).body.coupon?.percentage == 10, 'coupon lookup (case-insensitive) in own branch')
      await client.query(`INSERT INTO coupons (code, percentage, branch_id) VALUES ('ONLY2', 5, 'pos2')`)
      check((await call('GET', '/api/coupons/lookup', { cookie: cookies.staff1, query: { code: 'ONLY2' } })).status === 404, 'a branch 2 coupon code is not found at branch 1')
      check((await call('GET', '/api/coupons', { cookie: cookies.staff1 })).status === 403, 'staff cannot list/manage coupons')
      check((await call('GET', '/api/coupons', { cookie: cookies.admin, query: { branch_id: 'pos1' } })).body.coupons.every((c: any) => c.branch_id === 'pos1'), 'admin coupon list for branch 1 is branch 1 only')
      // unregistered item
      const un = await call('POST', '/api/pos/unregistered-product', { cookie: cookies.staff3, body: { name: 'Loose item', price: 25 } })
      check(un.status === 200 && (await one(`SELECT branch_id FROM products WHERE id = $1`, [un.body.id])).branch_id === 'pos3', 'unregistered product is created in the token\'s branch')
    }

    // ================================================================== H. advance orders, expenses, settings
    {
      const adv = await call('POST', '/api/advance-orders', { cookie: cookies.staff1, body: { customer_name: 'A', phone: '99', product_name: 'Card', total_amount: 100, deposit_amount: 20, expected_delivery_date: '2030-01-01', payment_method: 'cash' } })
      check(adv.status === 201 && adv.body.order.branch_id === 'pos1', 'staff1 creates an advance order in branch 1', adv.body?.error ?? '')
      const id = adv.body.order.id
      check((await call('GET', '/api/advance-orders', { cookie: cookies.staff2 })).body.orders.every((o: any) => o.branch_id === 'pos2' && o.id !== id), 'staff2 sees no branch 1 advance orders')
      check((await call('POST', `/api/advance-orders/${id}/status`, { cookie: cookies.staff2, body: { status: 'ready_for_delivery' } })).status >= 400, 'staff2 cannot change a branch 1 advance order')
      check((await call('POST', `/api/advance-orders/${id}/complete`, { cookie: cookies.manager3, body: { payment_method: 'cash', final_amount: 80 } })).status >= 400, 'manager3 cannot complete a branch 1 advance order')
      check((await call('GET', `/api/advance-orders/${id}/history`, { cookie: cookies.staff3 })).status === 404, 'staff3 cannot read a branch 1 advance order history')
      check((await call('POST', `/api/advance-orders/${id}/status`, { cookie: cookies.staff1, body: { status: 'ready_for_delivery' } })).status === 200, 'staff1 updates its own advance order')
      check((await call('DELETE', `/api/advance-orders/${id}`, { cookie: cookies.staff2 })).status === 403, 'staff2 cannot delete advance orders at all (403)')
      check((await call('DELETE', `/api/advance-orders/${id}`, { cookie: cookies.staff1 })).status === 403, 'staff1 cannot delete its own advance order either (403)')
      check((await call('DELETE', `/api/advance-orders/${id}`, { cookie: cookies.admin, query: { branch_id: 'pos2' } })).status === 404, 'admin on branch 2 cannot delete a branch 1 advance order (404)')

      // expenses: staff never, manager own branch, admin any
      const ex = await call('POST', '/api/expenses', { cookie: cookies.manager2, body: { expense_date: '2030-01-01', category_id: null, category_name: 'Rent', amount: 50 } })
      check(ex.status === 201 && ex.body.expense.branch_id === 'pos2' && ex.body.expense.recorded_by_name === 'Manager', 'manager2 records an expense in branch 2 (recorder name from token)')
      check((await call('GET', '/api/expenses', { cookie: cookies.manager1 })).body.expenses.every((e: any) => e.branch_id === 'pos1'), 'manager1 expense list is branch 1 only')
      check((await call('DELETE', `/api/expenses/${ex.body.expense.id}`, { cookie: cookies.manager1 })).status === 404, 'manager1 cannot delete a branch 2 expense')
      check((await call('GET', '/api/expenses/metrics', { cookie: cookies.manager2 })).body.metrics !== undefined, 'manager keeps the expense summary metrics (Expenses screen)')
      check((await call('GET', '/api/expenses', { cookie: cookies.staff1 })).status === 403, 'staff cannot read expenses')
      check((await call('POST', '/api/expenses', { cookie: cookies.manager2, body: { expense_date: '2030-01-01', category_id: null, category_name: 'x', amount: -1 } })).status === 400, 'negative expense rejected (zod)')

      // settings
      const before1 = await one(`SELECT theme_color FROM store_settings WHERE branch_id = 'pos1'`)
      const put = await call('PUT', '/api/settings', { cookie: cookies.admin, query: { branch_id: 'pos2' }, body: { theme_color: '#112233', name: 'Branch Two Shop' } })
      check(put.status === 200 && put.body.settings.branch_id === 'pos2' && put.body.settings.theme_color === '#112233', 'admin store-settings write lands in the selected branch 2')
      check((await one(`SELECT theme_color FROM store_settings WHERE branch_id = 'pos1'`)).theme_color === before1.theme_color, 'branch 1 settings untouched by the branch 2 write')
      check((await call('PUT', '/api/settings', { cookie: cookies.staff1, body: { name: 'x' } })).status === 403, 'staff cannot write store settings')
      check((await call('PUT', '/api/settings', { cookie: cookies.admin, query: { branch_id: 'pos1' }, body: { theme_color: 'red' } })).status === 400, 'invalid theme colour rejected (zod)')
      check((await call('GET', '/api/settings', { cookie: cookies.staff3 })).body.settings.branch_id === 'pos3', 'staff3 reads branch 3 settings')
      const pa = await call('PUT', '/api/settings', { cookie: cookies.admin, query: { branch_id: 'pos3' }, body: { name: 'Branch Three' } })
      check(pa.body.settings.branch_id === 'pos3', 'admin writes settings for the selected branch only')
    }

    // ================================================================== I. analytics / passcodes / cross-branch: admin only
    {
      const adminOnly: Array<[string, string, any?]> = [
        ['GET', '/api/analytics/orders'], ['GET', '/api/analytics/order-items'], ['GET', '/api/analytics/expenses'],
        ['GET', '/api/global/overview'], ['GET', '/api/global/sales'], ['GET', '/api/global/stock'],
        ['GET', '/api/global/reports/orders'], ['GET', '/api/global/reports/order-items'], ['GET', '/api/admin/passcodes'],
        ['PUT', '/api/admin/passcodes', { target_role: 'staff', target_branch: 'pos1', new_passcode: 'short', current_admin_passcode: PASS.admin }], // weak on purpose: admin gets 400, never a real change
      ]
      for (const [m, p, body] of adminOnly) {
        for (const a of ['manager1', 'manager2', 'manager3', 'staff1', 'staff2', 'staff3'] as Actor[]) {
          const r = await call(m, p, { cookie: cookies[a], body })
          check(r.status === 403, `${m} ${p} -> 403 for ${a}`, `status ${r.status}`)
        }
        const q = p.startsWith('/api/analytics') ? { branch_id: 'pos1' } : undefined
        check((await call(m, p, { cookie: cookies.admin, body, query: q })).status !== 403, `${m} ${p} is open to admin`)
      }
      const ov = await call('GET', '/api/global/overview', { cookie: cookies.admin })
      check(ov.body.branches.length === 3, 'admin global overview covers all 3 branches')
      const an = await call('GET', '/api/analytics/orders', { cookie: cookies.admin, query: { branch_id: 'pos2' } })
      check(an.status === 200 && an.body.orders.every((o: any) => o.branch_id === 'pos2'), 'admin analytics for ?branch_id=pos2 contains only branch 2')
    }

    // ================================================================== J. uploads (Vercel Blob, branch-prefixed)
    {
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
      const up = (a: Actor, kind: string, extra: Parameters<typeof call>[2] = {}) => call('POST', `/api/uploads/${kind}`, { cookie: cookies[a], raw: { buf: png, type: 'image/png' }, query: { filename: 'Logo Image.png' }, ...extra })
      const r1 = await up('manager1', 'product-images')
      check(r1.status === 201 && r1.body.path.startsWith('pos1/product-images/') && r1.body.path.endsWith('.png'), 'manager1 product image path starts with pos1/')
      const r2 = await up('admin', 'branding', { query: { filename: 'Logo Image.png', branch_id: 'pos2' } })
      check(r2.status === 201 && r2.body.path.startsWith('pos2/branding/'), 'admin branding upload (branch 2) path starts with pos2/')
      check((await up('staff1', 'product-images')).status === 403, 'staff cannot upload product images (no product forms for staff)')
      check((await up('staff1', 'branding')).status === 403, 'staff cannot upload branding')
      check((await up('staff1', 'avatars')).status === 403, 'staff cannot upload avatars')
      check((await up('staff3', 'invoices', { raw: { buf: Buffer.from('%PDF-1.4'), type: 'application/pdf' } })).body.path?.startsWith('pos3/invoices/'), 'staff3 invoice PDF path starts with pos3/')
      check((await up('admin', 'avatars')).status === 400, 'admin upload without a branch selector -> 400')
      const a3 = await up('admin', 'avatars', { cookie: cookies.admin, query: { branch_id: 'pos3', filename: 'x.png' } })
      check(a3.status === 201 && a3.body.path.startsWith('pos3/avatars/'), 'admin upload path uses the selected, validated branch')
      const trav = await up('manager1', 'product-images', { query: { filename: '../../pos2/evil.png' } })
      check(trav.status === 201 && trav.body.path.startsWith('pos1/product-images/') && !trav.body.path.includes('..') && trav.body.path.split('/').length === 3, 'path traversal in the filename cannot leave the branch prefix')
      check((await up('manager1', 'product-images', { raw: { buf: Buffer.from('<svg/>'), type: 'image/svg+xml' } })).status === 415, 'SVG upload refused (415)')
      check((await up('manager1', 'product-images', { raw: { buf: Buffer.from('x'), type: 'text/html' } })).status === 415, 'HTML upload refused (415)')
      check((await up('manager1', 'product-images', { raw: { buf: Buffer.alloc(6 * 1024 * 1024, 1), type: 'image/png' } })).status === 413, 'oversized image refused (413)')
      const over = await up('manager1', 'product-images', { raw: { buf: Buffer.alloc(4 * 1024 * 1024 + 1, 1), type: 'image/png' } })
      check(over.status === 413 && over.body.error === 'Image too large, max 4 MB', 'an image of 4 MB + 1 byte is refused with "Image too large, max 4 MB"', `${over.status} ${JSON.stringify(over.body)}`)
      check((await up('manager1', 'product-images', { raw: { buf: Buffer.alloc(4 * 1024 * 1024, 1), type: 'image/png' } })).status === 201, 'an image of exactly 4 MB is accepted')
      const bigPdf = await up('staff1', 'invoices', { raw: { buf: Buffer.alloc(4 * 1024 * 1024 + 1, 1), type: 'application/pdf' } })
      check(bigPdf.status === 413 && bigPdf.body.error === 'PDF too large, max 4 MB', 'a PDF over 4 MB is refused with "PDF too large, max 4 MB"')
      check((await up('admin', 'branding', { query: { filename: 'x.jpg', branch_id: 'pos1' }, raw: { buf: Buffer.alloc(4 * 1024 * 1024 + 1, 1), type: 'image/jpeg' } })).status === 413, 'branding images share the same 4 MB cap')
      check((await up('manager1', 'product-images', { body: undefined, raw: { buf: Buffer.alloc(0), type: 'image/png' } })).status === 400, 'empty upload refused')
      check((await up('manager1', 'product-images', { query: { filename: 'a.png', branch_id: 'pos2' } })).status === 400, 'upload refuses a client branch_id')
      check(blobCalls.every((c) => /^pos[123]\//.test(c.pathname)), 'every blob path in the run starts with a branch id')
    }

    // ================================================================== K. polling endpoints are branch scoped
    {
      const s1a = await call('GET', '/api/poll/stamps', { cookie: cookies.staff1 })
      await client.query(`INSERT INTO products (name, price, branch_id) VALUES ('Poll probe', 1, 'pos2')`)
      const s1b = await call('GET', '/api/poll/stamps', { cookie: cookies.staff1 })
      const s2 = await call('GET', '/api/poll/stamps', { cookie: cookies.staff2 })
      check(s1a.body.stamps.products.count === s1b.body.stamps.products.count, 'a branch 2 change does not move branch 1 poll stamps')
      check(s2.body.stamps.products.count === s1b.body.stamps.products.count + 0 || s2.body.stamps.products.count >= 1, 'branch 2 stamps are its own')
      const pCount = await one(`SELECT (SELECT count(*)::int FROM products WHERE branch_id='pos1') a, (SELECT count(*)::int FROM products WHERE branch_id='pos2') b`)
      check(s1b.body.stamps.products.count === pCount.a && s2.body.stamps.products.count === pCount.b, 'poll stamp counts equal each branch\'s own row counts')
      check(Object.keys(s1b.body.stamps).length >= 8 && !JSON.stringify(s1b.body).includes('pos2'), 'poll response carries no other branch identifiers')
      check((await call('GET', '/api/poll/stamps', { cookie: cookies.admin })).status === 400, 'admin poll needs a branch selector')
      check((await call('GET', '/api/poll/stamps', { cookie: cookies.admin, query: { branch_id: 'pos3' } })).status === 200, 'admin poll with a selected branch works')
    }

    // ================================================================== K2. routes added for the frontend rewiring (4a)
    {
      // available coupon chips: this branch's codes only, for every role
      await client.query(`INSERT INTO coupons (code, percentage, branch_id) VALUES ('ONLY3', 7, 'pos3')`)
      const av1 = await call('GET', '/api/coupons/available', { cookie: cookies.staff1 })
      check(av1.status === 200 && av1.body.coupons.some((c: any) => c.code === 'API10' && Number(c.percentage) === 10) && !av1.body.coupons.some((c: any) => ['ONLY2', 'ONLY3'].includes(c.code)), "POS coupon chips show only this branch's active codes (staff)")
      check((await call('GET', '/api/coupons/available', { cookie: cookies.manager3 })).body.coupons.some((c: any) => c.code === 'ONLY3'), 'manager3 sees its own branch coupon code')

      // finalize: same fields the original POS re-saved, own branch, recent bills only
      const sale = await call('POST', '/api/pos/sale', { cookie: cookies.staff1, body: { items: [{ product_id: prod.pos1, quantity: 1, unit_price: 100, name: 'Api Product' }] } })
      const fin = await call('PATCH', `/api/orders/${sale.body.order_id}/finalize`, { cookie: cookies.staff1, body: { subtotal: 100, total: 95, payment_mode: 'Split (Cash 50 + QR 45)', remarks: 'hello', billing_date: '2030-02-03T10:00:00Z' } })
      const row = await one(`SELECT total::numeric t, payment_mode, remarks FROM orders WHERE id = $1`, [sale.body.order_id])
      check(fin.status === 200 && Number(row.t) === 95 && row.payment_mode.startsWith('Split') && row.remarks === 'hello', 'finalize re-saves totals / payment / remarks of a fresh bill in its own branch', `status ${fin.status} ${JSON.stringify(fin.body)} sale ${JSON.stringify(sale.body)}`)
      check((await call('PATCH', `/api/orders/${sale.body.order_id}/finalize`, { cookie: cookies.staff2, body: { total: 1 } })).status === 404, 'staff2 cannot finalize a branch 1 bill')
      check((await call('PATCH', `/api/orders/${sale.body.order_id}/finalize`, { cookie: cookies.staff1, body: { total: 1, branch_id: 'pos2' } })).status === 400, 'finalize refuses a client branch_id')
      check((await call('PATCH', `/api/orders/${sale.body.order_id}/finalize`, { cookie: cookies.staff1, body: { invoice_pdf_url: 'x' } })).status === 400, 'finalize only accepts its whitelisted fields')
      await client.query(`UPDATE orders SET created_at = now() - interval '2 hours' WHERE id = $1`, [sale.body.order_id])
      check((await call('PATCH', `/api/orders/${sale.body.order_id}/finalize`, { cookie: cookies.staff1, body: { total: 2 } })).status === 404, 'an old bill can no longer be finalized')

      // finalize is limited to: this token's branch + the SAME login session and role that made the bill + under 30 minutes
      {
        const mk = await call('POST', '/api/pos/sale', { cookie: cookies.staff1, body: { items: [{ product_id: prod.pos1, quantity: 1, unit_price: 100, name: 'Api Product' }] } })
        const oid = mk.body.order_id as string
        const meta = await one(`SELECT created_by_role r, created_by_sid s FROM orders WHERE id = $1`, [oid])
        check(meta.r === 'staff' && typeof meta.s === 'string' && meta.s.length >= 8, 'a bill remembers the role and login session that made it')
        const second = cookieOf(await call('POST', '/api/auth/login', { body: { passcode: PASS.staff1 } }))
        check((await call('PATCH', `/api/orders/${oid}/finalize`, { cookie: second, body: { total: 1 } })).status === 404, 'another login session of the same user cannot finalize this bill')
        check((await call('PATCH', `/api/orders/${oid}/finalize`, { cookie: cookies.manager1, body: { total: 1 } })).status === 404, 'a manager of the same branch cannot finalize a staff bill')
        check((await call('PATCH', `/api/orders/${oid}/finalize`, { cookie: cookies.admin, query: { branch_id: 'pos1' }, body: { total: 1 } })).status === 404, 'the admin cannot finalize a bill made by someone else\'s session')
        check((await call('PATCH', `/api/orders/${oid}/finalize`, { cookie: cookies.staff2, body: { total: 1 } })).status === 404, "another branch's staff cannot finalize it")
        check(Number((await one(`SELECT total::numeric t FROM orders WHERE id = $1`, [oid])).t) === 100, 'none of those attempts changed the bill')
        check((await call('PATCH', `/api/orders/${oid}/finalize`, { cookie: cookies.staff1, body: { total: 90, id: 'x' } })).status === 400, 'finalize rejects any field outside its whitelist (id)')
        check((await call('PATCH', `/api/orders/${oid}/finalize`, { cookie: cookies.staff1, body: { status: 'cancelled' } })).status === 400, 'finalize cannot change the bill status')
        check((await call('PATCH', `/api/orders/${oid}/finalize`, { cookie: cookies.staff1, body: { total: 90 } })).status === 200, 'the creating session can finalize it')
        await client.query(`UPDATE orders SET created_at = now() - interval '31 minutes' WHERE id = $1`, [oid])
        check((await call('PATCH', `/api/orders/${oid}/finalize`, { cookie: cookies.staff1, body: { total: 80 } })).status === 404, 'even the creating session is refused after 30 minutes')
        check(Number((await one(`SELECT total::numeric t FROM orders WHERE id = $1`, [oid])).t) === 90, 'the old bill kept its last saved total')
      }

      // history filters (digits-only / partial invoice, phone, customer, exclude type)
      const inv = sale.body.invoice_no as string
      const part = await call('GET', '/api/orders', { cookie: cookies.manager1, query: { q: inv.slice(-4) } })
      check(part.body.orders.some((o: any) => o.invoice_no === inv), 'history search by the last digits of an invoice finds the bill')
      const none = await call('GET', '/api/orders', { cookie: cookies.manager2, query: { q: inv } })
      check(none.body.orders.length === 0, 'the same search in another branch finds nothing')
      const typed = await call('GET', '/api/orders', { cookie: cookies.manager1, query: { exclude_order_type: 'pos_sale' } })
      check(typed.body.orders.every((o: any) => o.order_type !== 'pos_sale'), 'exclude_order_type works')
      check((await call('GET', '/api/orders', { cookie: cookies.manager1, query: { q: "x'; DROP TABLE orders;--" } })).status === 200 && (await one(`SELECT count(*)::int n FROM orders`)).n > 0, 'a hostile search string is just text (parameterized)')

      // advance order: final payment text is stored for the order's own branch only
      const adv = await call('POST', '/api/advance-orders', { cookie: cookies.staff1, body: { customer_name: 'A', phone: '9', product_name: 'Card', total_amount: 100, deposit_amount: 20, expected_delivery_date: '2030-01-01', payment_method: 'cash', reference_number: 'REF-1' } })
      check(adv.status === 201, 'advance order accepts (and ignores) a reference number like the original', adv.body?.error ?? '')
      const done = await call('POST', `/api/advance-orders/${adv.body.order.id}/complete`, { cookie: cookies.staff1, body: { payment_method: 'cash', final_amount: 80 } })
      check(done.status === 200 && !!done.body.result.invoice_no, 'staff1 completes the advance order', done.body?.error ?? '')
      check((await call('PATCH', `/api/advance-orders/${adv.body.order.id}/final-method`, { cookie: cookies.staff2, body: { final_payment_method: 'Split (x)' } })).status === 404, 'staff2 cannot set the final payment text of a branch 1 advance order')
      check((await call('PATCH', `/api/advance-orders/${adv.body.order.id}/final-method`, { cookie: cookies.staff1, body: { final_payment_method: 'Split (Cash 40 + QR 40)' } })).status === 200, 'staff1 stores the split payment text')

      // categories: deleting one moves its products to "Uncategorized" (what the screen used to do itself)
      const cc = await call('POST', '/api/categories', { cookie: cookies.manager1, body: { name_en: 'Temp Cat' } })
      check(cc.status === 201 && !cc.body.existing, 'manager creates a category')
      check((await call('POST', '/api/categories', { cookie: cookies.manager1, body: { name_en: 'temp cat' } })).body.existing === true, 'creating the same name again returns the existing category')
      const pp = await call('POST', '/api/products', { cookie: cookies.manager1, body: { name: 'In Temp', category: 'Temp Cat', category_id: cc.body.category.id, price: 5 } })
      check(pp.status === 201, 'manager creates a product in that category')
      const dup = await call('POST', '/api/products', { cookie: cookies.manager1, body: { name: 'In Temp', category: 'Temp Cat', category_id: cc.body.category.id, price: 5 } })
      check(dup.status === 409 && dup.body.error === 'A product with this name already exists in the selected category.', 'duplicate product name gives the original message', dup.body?.error ?? '')
      check((await call('DELETE', `/api/categories/${cc.body.category.id}`, { cookie: cookies.staff1 })).status === 403, 'staff cannot delete a category')
      check((await call('DELETE', `/api/categories/${cc.body.category.id}`, { cookie: cookies.manager2 })).status === 404, 'manager2 cannot delete a branch 1 category')
      check((await call('DELETE', `/api/categories/${cc.body.category.id}`, { cookie: cookies.manager1 })).status === 200, 'manager1 deletes its category')
      const moved = await one(`SELECT category, category_id FROM products WHERE id = $1`, [pp.body.product.id])
      check(moved.category === 'Uncategorized' && moved.category_id === null, 'the products of a deleted category become Uncategorized')
      const dv = await call('POST', '/api/variants', { cookie: cookies.manager1, body: { product_id: prod.pos1, variant_name: 'Large', price: 1 } })
      check(dv.status === 409 && dv.body.error === 'A variant with this name already exists for this product.', 'duplicate variant name gives the original message', dv.body?.error ?? '')
      const dc = await call('POST', '/api/coupons', { cookie: cookies.admin, query: { branch_id: 'pos1' }, body: { code: ' api10 ', percentage: 5 } })
      check(dc.status === 409 && /already exists/.test(dc.body.error), 'duplicate coupon code is reported as already existing', dc.body?.error ?? '')
    }

    // ================================================================== L. public invoice lookup (rate limited, generic, one bill)
    {
      const inv = {} as Record<B, string>
      for (const b of BRANCHES) {
        const a = `staff${b.slice(-1)}` as Actor
        inv[b] = (await call('POST', '/api/pos/sale', { cookie: cookies[a], body: { items: [{ product_id: prod[b], quantity: 1, unit_price: 100, name: 'Api Product' }] } })).body.invoice_no
      }
      const ip = '203.0.113.7'
      for (const b of BRANCHES) {
        const r = await call('GET', `/api/public/invoice/${inv[b]}`, { ip })
        check(r.status === 200 && r.body.kind === 'order' && r.body.order.invoice_no === inv[b] && r.body.order.branch_id === b, `public lookup of ${inv[b]} returns exactly the ${b} bill (no login needed)`)
      }
      const miss = await call('GET', '/api/public/invoice/99999999', { ip })
      const bad = await call('GET', `/api/public/invoice/${encodeURIComponent("1' OR '1'='1")}`, { ip })
      const long = await call('GET', `/api/public/invoice/${'9'.repeat(200)}`, { ip })
      const half = await call('GET', `/api/public/invoice/${inv.pos1.slice(0, 4)}`, { ip })
      const same = [miss, bad, long, half].every((r) => r.status === 404 && JSON.stringify(r.body) === JSON.stringify({ error: 'Invoice not found' }))
      check(same, 'misses, malformed refs and partial numbers all return the identical generic 404')
      check((await call('GET', `/api/public/invoice/${inv.pos1}`, { ip, cookie: cookies.staff3 })).body.order.branch_id === 'pos1', 'public lookup ignores the caller\'s own branch (it is a customer link)')
      // rate limit: 30 lookups / 10 min / IP
      const ip2 = '203.0.113.99'
      let last = 0
      for (let i = 0; i < 30; i++) last = (await call('GET', '/api/public/invoice/99999999', { ip: ip2 })).status
      check(last === 404, '30 lookups from one IP are answered')
      const lim = await call('GET', `/api/public/invoice/${inv.pos1}`, { ip: ip2 })
      check(lim.status === 429 && Number(lim.headers.get('retry-after')) > 0, 'the 31st lookup from the same IP is rate limited (429 + Retry-After), even for a valid bill')
      check((await call('GET', `/api/public/invoice/${inv.pos1}`, { ip: '203.0.113.100' })).status === 200, 'another IP is not affected by the lockout')
      const stored = await one(`SELECT count(*)::int n FROM login_attempts WHERE bucket = 'invoice' AND ip = $1`, [ip2])
      check(stored.n >= 30, 'the invoice limit is stored in the database (works across serverless instances)')

      // ---- /api/health: DB ping for the deploy smoke test, never any secret
      const h = await call('GET', '/api/health', { ip: '203.0.113.150' })
      check(h.status === 200 && h.body.status === 'ok' && h.body.database === 'up', 'GET /api/health answers 200 {status ok, database up} without a login')
      const hText = JSON.stringify(h.body) + [...h.headers.entries()].map(([k, v]) => `${k}:${v}`).join(' ')
      const secrets = [process.env.DATABASE_URL, process.env.JWT_SECRET, process.env.BLOB_READ_WRITE_TOKEN, PASS.admin, PASS.staff1].filter((s): s is string => !!s && s.length >= 8)
      check(!secrets.some((s) => hText.includes(s)) && !/postgres(ql)?:\/\//i.test(hText) && !/neon\.tech/i.test(hText), '/api/health response contains no connection string, secret or passcode')
      check(Object.keys(h.body).sort().join(',') === 'database,environment,status', '/api/health returns only status, database and environment', Object.keys(h.body).join(','))
      // a broken database: 503 with a generic message, the driver error text (host, user, password) never leaks
      const brokenDb = { ...db, query: async () => { throw new Error('connect ECONNREFUSED postgresql://neondb_owner:hunter2secret@ep-test-pooler.neon.tech/neondb') } } as typeof db
      const brokenApp = createApp({ db: brokenDb, blobPut: async () => ({ url: 'x' }) })
      const brokenServer = await new Promise<import('node:http').Server>((res) => { const s = brokenApp.listen(0, '127.0.0.1', () => res(s)) })
      try {
        const br = await fetch(`http://127.0.0.1:${(brokenServer.address() as AddressInfo).port}/api/health`)
        const brText = await br.text()
        check(br.status === 503 && /Database unavailable/.test(brText) && !/hunter2secret|neondb_owner|neon\.tech|postgresql:/i.test(brText), '/api/health answers 503 "Database unavailable" when the database is down, with no driver error text', `${br.status} ${brText.slice(0, 80)}`)
      } finally { brokenServer.close() }
    }

    // ================================================================== M. passcode management
    {
      const A = (body: Record<string, unknown>, o: Parameters<typeof call>[2] = {}) => call('PUT', '/api/admin/passcodes', { cookie: cookies.admin, body, ...o })
      const list = await call('GET', '/api/admin/passcodes', { cookie: cookies.admin })
      check(list.status === 200 && list.body.passcodes.length === 7 && !JSON.stringify(list.body).includes('$2'), 'admin lists the 7 passcode slots, never any hash')
      check((await A({ target_role: 'staff', target_branch: 'pos2', new_passcode: 'New-Staff2-Pass-9', current_admin_passcode: 'wrong-current-pass' })).status === 403, 'changing a passcode needs the CURRENT admin passcode')
      check((await A({ target_role: 'staff', target_branch: 'pos2', new_passcode: 'short' , current_admin_passcode: PASS.admin })).status === 400, 'weak new passcode rejected (passcodePolicy)')
      check((await A({ target_role: 'staff', target_branch: 'pos2', new_passcode: '12345678', current_admin_passcode: PASS.admin })).status === 400, 'sequential-digit passcode rejected')
      check((await A({ target_role: 'staff', target_branch: 'pos2', new_passcode: PASS.manager3, current_admin_passcode: PASS.admin })).status === 409, 'a passcode already used by another role/branch is refused')
      check((await A({ target_role: 'staff', target_branch: 'pos2', new_passcode: PASS.staff2, current_admin_passcode: PASS.admin })).status === 409, 'reusing the same passcode is refused')
      check((await A({ target_role: 'staff', new_passcode: 'New-Staff2-Pass-9', current_admin_passcode: PASS.admin })).status === 400, 'manager/staff target needs target_branch')
      check((await A({ target_role: 'staff', target_branch: 'pos9', new_passcode: 'New-Staff9-Pass-9', current_admin_passcode: PASS.admin })).status === 404, 'unknown target is refused')
      check((await A({ target_role: 'admin', target_branch: 'pos1', new_passcode: 'New-Admin-Pass-99', current_admin_passcode: PASS.admin })).status === 400, 'the admin passcode has no branch')
      const tvBefore = await rows(`SELECT role, branch_id, token_version FROM passcodes ORDER BY id`)
      const old = cookies.staff2
      const ch = await A({ target_role: 'staff', target_branch: 'pos2', new_passcode: 'New-Staff2-Pass-9', current_admin_passcode: PASS.admin })
      check(ch.status === 200, 'admin changes the branch 2 staff passcode', ch.body?.error ?? '')
      const tvAfter = await rows(`SELECT role, branch_id, token_version FROM passcodes ORDER BY id`)
      const bumped = tvAfter.filter((r, i) => r.token_version !== tvBefore[i].token_version)
      check(bumped.length === 1 && bumped[0].role === 'staff' && bumped[0].branch_id === 'pos2', 'only the changed role/branch had its token_version bumped')
      check((await call('GET', '/api/auth/me', { cookie: old })).status === 401, 'the old staff2 session is invalidated by the change')
      check((await call('GET', '/api/auth/me', { cookie: cookies.staff1 })).status === 200 && (await call('GET', '/api/auth/me', { cookie: cookies.manager2 })).status === 200, 'other roles\' sessions (staff1, manager2) keep working')
      check((await call('POST', '/api/auth/login', { body: { passcode: PASS.staff2 } })).status === 401, 'the old passcode no longer logs in')
      const nl = await call('POST', '/api/auth/login', { body: { passcode: 'New-Staff2-Pass-9' } })
      check(nl.status === 200 && nl.body.role === 'staff' && nl.body.branch === 'pos2', 'the new passcode logs in as staff of branch 2')
      // the admin changing their OWN passcode: all other admin sessions die, this one is re-issued
      const adminOld = cookies.admin
      const own = await A({ target_role: 'admin', new_passcode: 'New-Admin-Pass-99', current_admin_passcode: PASS.admin })
      check(own.status === 200, 'admin changes their own passcode')
      const fresh = cookieOf(own)
      check(!!fresh && (await call('GET', '/api/auth/me', { cookie: fresh })).status === 200, 'the admin\'s current session continues with a re-issued token')
      check((await call('GET', '/api/auth/me', { cookie: adminOld })).status === 401, 'an older admin session is invalidated')
      cookies.admin = fresh
      // failed "current passcode" attempts are limited per actor (target) and per IP
      const ipP = '198.51.100.5'
      let lockStatus = 0
      for (let i = 0; i < 5; i++) await call('PUT', '/api/admin/passcodes', { cookie: cookies.admin, ip: ipP, body: { target_role: 'staff', target_branch: 'pos1', new_passcode: 'Zzz-Staff1-New-77', current_admin_passcode: 'wrong-wrong-wrong' } })
      lockStatus = (await call('PUT', '/api/admin/passcodes', { cookie: cookies.admin, ip: ipP, body: { target_role: 'staff', target_branch: 'pos1', new_passcode: 'Zzz-Staff1-New-77', current_admin_passcode: 'New-Admin-Pass-99' } })).status
      check(lockStatus === 429, 'after 5 wrong current-passcode attempts the change endpoint locks (even with the right passcode)')
      const viaOtherIp = await call('PUT', '/api/admin/passcodes', { cookie: cookies.admin, ip: '198.51.100.6', body: { target_role: 'staff', target_branch: 'pos1', new_passcode: 'Zzz-Staff1-New-77', current_admin_passcode: 'New-Admin-Pass-99' } })
      check(viaOtherIp.status === 429, 'the per-target (admin actor) lockout also applies from another IP')
      PASS.admin = 'New-Admin-Pass-99'
    }

    }
    if (PART !== '1') {
    // ================================================================== M2. duplicate-proof bills, cancel + restock, CGST / SGST
    {
      const mkProduct = async (b: B, stock = 20, name = 'Idem Product') => Number((await one(`INSERT INTO products (name, category, price, stock_quantity, stock, branch_id, is_active) VALUES ($3, 'x', 50, $2::int, $2::int, $1, true) RETURNING id`, [b, stock, name])).id)
      const stockOfP = async (id: number) => Number((await one(`SELECT stock_quantity::numeric s FROM products WHERE id = $1`, [id])).s)
      const pid = await mkProduct('pos1')
      const bill = (extra: Record<string, unknown> = {}, qty = 2) => ({ customer_name: 'Idem Customer', phone: '9876543210', items: [{ product_id: pid, quantity: qty, unit_price: 50, name: 'Idem Product' }], payment_method: 'cash', ...extra })
      const sale = (a: Actor, body: Record<string, unknown>) => call('POST', '/api/pos/sale', { cookie: cookies[a], body })

      // ---- 1. a repeated request can never make a second bill
      const k1 = 'idem-key-aaaaaaaa'
      const s1 = await sale('staff1', bill({ idempotency_key: k1 }))
      const s2 = await sale('staff1', bill({ idempotency_key: k1 }))
      check(s1.status === 201 && s2.status === 201 && s2.body.order_id === s1.body.order_id && s2.body.invoice_no === s1.body.invoice_no && s2.body.replayed === true && !s1.body.replayed, 'the same idempotency key returns the FIRST bill, not a second one')
      check((await one(`SELECT count(*)::int n FROM orders WHERE branch_id = 'pos1' AND idempotency_key = $1`, [k1])).n === 1, 'exactly one bill row exists for that key')
      check((await stockOfP(pid)) === 18, 'the repeated request took stock only once (20 - 2)')
      const s3 = await sale('staff1', bill({ idempotency_key: 'idem-key-bbbbbbbb' }))
      check(s3.status === 201 && s3.body.order_id !== s1.body.order_id && !s3.body.replayed, 'a different key makes a new bill')
      const s4 = await sale('staff1', bill())
      const s5 = await sale('staff1', bill())
      check(s4.status === 201 && s5.status === 201 && s4.body.order_id !== s5.body.order_id, 'requests without a key keep working exactly as before')
      check((await call('POST', '/api/pos/sale', { cookie: cookies.staff1, body: bill({ idempotency_key: 'short' }) })).status === 400, 'a too-short idempotency key is rejected (zod)')
      const pid2 = await mkProduct('pos2')
      const other = await sale('staff2', { ...bill({ idempotency_key: k1 }), items: [{ product_id: pid2, quantity: 1, unit_price: 50, name: 'Idem Product' }] })
      check(other.status === 201 && other.body.order_id !== s1.body.order_id, 'the same key in another branch is a different bill (keys are per branch, never shared)')
      await client.query('SAVEPOINT dupkey')
      let dupErr = ''
      try { await client.query(`INSERT INTO orders (invoice_no, customer_name, subtotal, total, branch_id, idempotency_key) VALUES (public.get_next_invoice_no('pos1'), 'x', 1, 1, 'pos1', $1)`, [k1]) } catch (e) { dupErr = String((e as { code?: string }).code) }
      await client.query('ROLLBACK TO SAVEPOINT dupkey')
      check(dupErr === '23505', 'the database itself refuses a second row with the same key (unique index), even if two requests arrive at once', dupErr)
      // invoice numbers keep coming from the branch sequence
      check(Number(s3.body.invoice_no) > Number(s1.body.invoice_no) && Number(s5.body.invoice_no) > Number(s4.body.invoice_no), 'invoice numbers still come from the branch sequence (increasing, no gaps made by a replay)')

      // ---- the same for advance (deposit) orders
      const adv = (extra: Record<string, unknown> = {}) => ({ customer_name: 'Idem Adv', phone: '9876500000', product_name: 'Custom card', total_amount: 500, deposit_amount: 100, expected_delivery_date: '2030-01-01', payment_method: 'cash', ...extra })
      const a1 = await call('POST', '/api/advance-orders', { cookie: cookies.staff1, body: adv({ idempotency_key: 'adv-key-aaaaaaaa' }) })
      const a2 = await call('POST', '/api/advance-orders', { cookie: cookies.staff1, body: adv({ idempotency_key: 'adv-key-aaaaaaaa' }) })
      check(a1.status === 201 && a2.status === 201 && a2.body.order.id === a1.body.order.id && a2.body.order.deposit_id === a1.body.order.deposit_id && a2.body.replayed === true, 'the same key returns the FIRST advance order (same DEP number)', JSON.stringify({ a1: [a1.status, a1.body?.order?.id, a1.body?.order?.deposit_id, a1.body?.error], a2: [a2.status, a2.body?.order?.id, a2.body?.order?.deposit_id, a2.body?.replayed, a2.body?.error] }))
      check((await one(`SELECT count(*)::int n FROM advance_orders WHERE branch_id = 'pos1' AND idempotency_key = 'adv-key-aaaaaaaa'`)).n === 1, 'exactly one advance order row exists for that key')
      check((await one(`SELECT count(*)::int n FROM advance_orders WHERE customer_name = 'Idem Adv'`)).n === 1, 'ONE advance order was created by the two requests (a call of the create function makes exactly one row; `SELECT (fn()).*` used to make one per column)')
      const a3 = await call('POST', '/api/advance-orders', { cookie: cookies.staff1, body: adv({ idempotency_key: 'adv-key-bbbbbbbb' }) })
      const depNo = (r: Res) => Number(String(r.body.order.deposit_id).split('-').pop())
      check(a3.status === 201 && a3.body.order.id !== a1.body.order.id && depNo(a3) > depNo(a1), 'a different key makes a new advance order with the next DEP number from the sequence')
      const noKey = await call('POST', '/api/advance-orders', { cookie: cookies.staff1, body: adv({ customer_name: 'Idem NoKey' }) })
      check(noKey.status === 201 && (await one(`SELECT count(*)::int n FROM advance_orders WHERE customer_name = 'Idem NoKey'`)).n === 1, 'advance orders without a key keep working, one row per request')
      const ev = await call('POST', `/api/advance-orders/${noKey.body.order.id}/status`, { cookie: cookies.staff1, body: { status: 'ready_for_delivery' } })
      const evRows = await one(`SELECT count(*)::int n FROM advance_order_timeline WHERE advance_order_id = $1 AND event_type = 'status_ready_for_delivery'`, [noKey.body.order.id]).catch(() => ({ n: -1 }))
      check(ev.status === 200 && (await one(`SELECT count(*)::int n FROM advance_orders WHERE customer_name = 'Idem NoKey'`)).n === 1, 'an advance status change touches one order and stays one row', JSON.stringify([ev.status, evRows]))

      // ---- 2. cancel + restock
      const before = await stockOfP(pid)                         // 18 - 2 - 2 - 2 (s3, s4, s5) = 12
      const c0 = await sale('staff1', bill({ idempotency_key: 'cancel-key-aaaaaa' }, 3))
      check((await stockOfP(pid)) === before - 3, 'a 3-item bill takes 3 from stock')
      check((await call('POST', `/api/orders/${c0.body.order_id}/cancel`, { cookie: cookies.staff2, body: { reason: 'x' } })).status === 404, "another branch's staff cannot cancel it (404)")
      { const sb = await sale('staff1', bill({}, 1)); const before = await stockOfP(pid); const sc = await call('POST', `/api/orders/${sb.body.order_id}/cancel`, { cookie: cookies.staff1, body: { reason: 'staff cancel' } })
        check(sc.status === 200 && sc.body.order.status === 'cancelled' && (await stockOfP(pid)) === before + 1, 'staff can cancel a bill of their own branch: stock goes back', JSON.stringify([sc.status, sc.body?.error])) }
      check((await call('POST', `/api/orders/${c0.body.order_id}/cancel`, { body: {} })).status === 401, 'cancel needs a session (401)')
      check((await call('POST', `/api/orders/${c0.body.order_id}/cancel`, { cookie: cookies.manager2, body: {} })).status === 404, 'another branch\'s manager cannot cancel it (404)')
      check((await stockOfP(pid)) === before - 3, 'refused cancels changed nothing')
      const x1 = await call('POST', `/api/orders/${c0.body.order_id}/cancel`, { cookie: cookies.manager1, body: { reason: 'wrong size' } })
      check(x1.status === 200 && x1.body.order.status === 'cancelled' && x1.body.restocked_items === 1, 'manager cancels a bill', JSON.stringify(x1.body).slice(0, 160))
      check((await stockOfP(pid)) === before, 'cancelling put the 3 items back in stock')
      const o1 = await one(`SELECT status, cancelled_at, cancelled_by, cancel_reason FROM orders WHERE id = $1`, [c0.body.order_id])
      check(o1.status === 'cancelled' && !!o1.cancelled_at && o1.cancelled_by === 'manager' && o1.cancel_reason === 'wrong size', 'status, cancelled_at, cancelled_by and cancel_reason are stored')
      const mv = await rows(`SELECT movement_type, quantity_delta::numeric d, quantity_before::numeric b, quantity_after::numeric a, reference_type, note FROM inventory_movements WHERE reference_id = $1 AND product_id = $2 ORDER BY id`, [c0.body.invoice_no, pid])
      check(mv.length === 2 && mv[0].movement_type === 'SALE' && Number(mv[0].d) === -3 && mv[1].movement_type === 'CANCELLATION_RESTOCK' && Number(mv[1].d) === 3 && Number(mv[1].b) === before - 3 && Number(mv[1].a) === before && /wrong size/.test(mv[1].note), 'the original SALE movement stays and a reversing CANCELLATION_RESTOCK movement is added', JSON.stringify(mv))
      const x2 = await call('POST', `/api/orders/${c0.body.order_id}/cancel`, { cookie: cookies.manager1, body: {} })
      check(x2.status === 409 && (await stockOfP(pid)) === before, 'a second cancel is refused (409) and never restocks twice')
      check((await one(`SELECT count(*)::int n FROM inventory_movements WHERE reference_id = $1 AND movement_type = 'CANCELLATION_RESTOCK'`, [c0.body.invoice_no])).n === 1, 'only one reversing movement exists')
      check((await call('PATCH', `/api/orders/${c0.body.order_id}/status`, { cookie: cookies.manager1, body: { status: 'completed' } })).status === 409, 'a cancelled bill cannot be re-opened (status change refused)')
      check((await call('PATCH', `/api/orders/${c0.body.order_id}/status`, { cookie: cookies.manager1, body: { status: 'cancelled' } })).status === 409, 'cancelling through the status route twice is refused too')
      check((await call('PATCH', `/api/orders/${c0.body.order_id}/status`, { cookie: cookies.manager1, body: { status: 'shipped' } })).status === 400, 'an unknown status is rejected (zod + CHECK)')
      // cancel through the status dropdown path
      const c1 = await sale('staff1', bill({}, 2))
      const st = await call('PATCH', `/api/orders/${c1.body.order_id}/status`, { cookie: cookies.manager1, body: { status: 'cancelled' } })
      check(st.status === 200 && st.body.order.status === 'cancelled' && (await stockOfP(pid)) === before, 'setting the status to cancelled restocks too (same transaction)')
      // delete of a LIVE bill restocks first; delete of a cancelled one does not restock again
      const c2 = await sale('staff1', bill({}, 4))
      check((await stockOfP(pid)) === before - 4, 'another bill took 4')
      check((await call('DELETE', `/api/orders/${c2.body.order_id}`, { cookie: cookies.admin, query: { branch_id: 'pos1' } })).status === 200 && (await stockOfP(pid)) === before, 'deleting a live bill puts its items back (no stock leak)')
      check((await one(`SELECT count(*)::int n FROM orders WHERE id = $1`, [c2.body.order_id])).n === 0, 'and the bill is gone')
      check((await call('DELETE', `/api/orders/${c0.body.order_id}`, { cookie: cookies.admin, query: { branch_id: 'pos1' } })).status === 200 && (await stockOfP(pid)) === before, 'deleting an already-cancelled bill does not restock a second time')
      // variants, manual items and coupons
      const pv = await mkProduct('pos1', 5, 'Idem Variant Product')
      const vid = (await one(`INSERT INTO product_variants (product_id, variant_name, price, stock, branch_id, is_active) VALUES ($1, 'Large', 50, 5, 'pos1', true) RETURNING id`, [pv])).id
      await client.query(`INSERT INTO coupons (code, percentage, branch_id) VALUES ('IDEM5', 5, 'pos1')`)
      const cv = await sale('staff1', { customer_name: 'Idem Customer', phone: '9876543210', coupon_code: 'IDEM5', coupon_percentage: 5, payment_method: 'cash',
        items: [{ product_id: pv, variant_id: vid, quantity: 2, unit_price: 50, name: 'Idem Variant Product' }, { name: 'Loose item', quantity: 1, unit_price: 10, is_manual: true }] })
      check(Number((await one(`SELECT stock::numeric s FROM product_variants WHERE id = $1`, [vid])).s) === 3 && (await stockOfP(pv)) === 3, 'a variant sale takes the variant stock and updates the parent')
      check(Number((await one(`SELECT usage_count FROM coupons WHERE code = 'IDEM5' AND branch_id = 'pos1'`)).usage_count) === 1, 'the coupon use was counted')
      const xv = await call('POST', `/api/orders/${cv.body.order_id}/cancel`, { cookie: cookies.manager1, body: {} })
      check(xv.status === 200 && xv.body.restocked_items === 1, 'cancelling restocks the variant item only (the manual item has no stock)', JSON.stringify(xv.body).slice(0, 120))
      check(Number((await one(`SELECT stock::numeric s FROM product_variants WHERE id = $1`, [vid])).s) === 5 && (await stockOfP(pv)) === 5, 'variant and parent stock are back')
      check(Number((await one(`SELECT usage_count FROM coupons WHERE code = 'IDEM5' AND branch_id = 'pos1'`)).usage_count) === 0, 'the coupon use was given back')

      // ---- 3. CGST / SGST
      await client.query(`UPDATE products SET stock_quantity = 200, stock = 200 WHERE id = $1`, [pid]) // plenty of stock for the many small bills below
      const gstSale = async (gst: number, extra: Record<string, unknown> = {}) => {
        const r = await sale('staff1', bill({ total_gst: gst, gst_enabled: true, ...extra }, 2))
        return one(`SELECT total_gst::numeric g, cgst_amount::numeric c, sgst_amount::numeric s, taxable_amount::numeric t, subtotal::numeric sub FROM orders WHERE id = $1`, [r.body.order_id])
      }
      const sp = (r: any) => [Number(r.c), Number(r.s)]
      const g1 = await gstSale(18.01); check(sp(g1).join() === '9,9.01' && Math.round((Number(g1.c) + Number(g1.s)) * 100) === 1801, 'GST 18.01 -> CGST 9.00 + SGST 9.01 (CGST rounds down, SGST takes the rest)', JSON.stringify(g1))
      const g2 = await gstSale(0.01); check(sp(g2).join() === '0,0.01', 'GST 0.01 -> CGST 0.00 + SGST 0.01')
      const g3 = await gstSale(100); check(sp(g3).join() === '50,50', 'GST 100 -> 50.00 + 50.00')
      const g4 = await gstSale(33.33); check(sp(g4).join() === '16.66,16.67' && Number(g4.c) + Number(g4.s) === 33.33, 'GST 33.33 -> 16.66 + 16.67 (always adds up to the GST)')
      const g5 = await gstSale(0); check(sp(g5).join() === '0,0', 'no GST -> 0 + 0')
      check(Number(g1.sub) === 100 && Number(g1.t) === 100, 'taxable amount = goods value before GST (100)')
      const g6 = await gstSale(9, { discount_amount: 10, manual_discount_amount: 5 }); check(Number(g6.t) === 85, 'taxable amount is after coupon and manual discounts (100 - 10 - 5)', JSON.stringify(g6))
      const gb = await sale('staff1', bill({ total_gst: 5, gst_enabled: true }, 2))
      const fin = await call('PATCH', `/api/orders/${gb.body.order_id}/finalize`, { cookie: cookies.staff1, body: { subtotal: 100, total: 112.35, total_gst: 12.35, gst_amount: 12.35, discount_amount: 0, manual_discount_amount: 0 } })
      const g7 = await one(`SELECT cgst_amount::numeric c, sgst_amount::numeric s FROM orders WHERE id = $1`, [gb.body.order_id])
      check(fin.status === 200 && sp(g7).join() === '6.17,6.18', 'the split is recalculated when the POS finalizes the bill (12.35 -> 6.17 + 6.18)', JSON.stringify([fin.status, fin.body, g7]))
      const lst = await call('GET', '/api/orders', { cookie: cookies.manager1, query: { limit: '5' } })
      check(lst.body.orders.every((o: any) => typeof o.cgst_amount === 'number' && typeof o.sgst_amount === 'number' && typeof o.taxable_amount === 'number'), 'orders come back with numeric cgst_amount, sgst_amount and taxable_amount')

      // ---- 4. the clean-up scripts (db/maintenance): review lists the duplicates, cancel restocks them, nothing is deleted
      const dpid = await mkProduct('pos1', 30, 'Dup Cleanup Product')
      const dupBody = { customer_name: 'Dup Cleanup Customer', phone: '9000011111', payment_method: 'cash', items: [{ product_id: dpid, quantity: 2, unit_price: 50, name: 'Dup Cleanup Product' }] }
      const d1 = await sale('staff1', dupBody); const d2 = await sale('staff1', dupBody); const d3 = await sale('staff1', dupBody)
      await call('POST', '/api/advance-orders', { cookie: cookies.staff1, body: adv({ customer_name: 'Dup Cleanup Adv', phone: '9000022222' }) })
      await call('POST', '/api/advance-orders', { cookie: cookies.staff1, body: adv({ customer_name: 'Dup Cleanup Adv', phone: '9000022222' }) })
      check((await stockOfP(dpid)) === 24, 'three identical bills took 6 from stock (30 - 6)')
      const fs = await import('node:fs')
      const reviewSql = fs.readFileSync('db/maintenance/duplicates_review.sql', 'utf8')
      const rev = (await client.query(reviewSql)) as unknown as Array<{ rows: any[] }>
      const dupBills = rev[0].rows.filter((r) => r.customer_name === 'Dup Cleanup Customer')
      check(dupBills.length === 3 && dupBills.filter((r) => r.verdict === 'DUPLICATE').length === 2 && dupBills.filter((r) => r.verdict === 'KEEP (first)').length === 1, 'duplicates_review.sql lists the 3 identical bills: 1 to keep, 2 duplicates', JSON.stringify(dupBills.map((r) => r.verdict)))
      check(rev[1].rows.some((r) => r.product_name === 'Dup Cleanup Product' && Number(r.quantity_to_restock) === 4), 'duplicates_review.sql shows the stock that would go back (4)')
      const dupAdv = rev[2].rows.filter((r) => r.customer_name === 'Dup Cleanup Adv')
      check(dupAdv.length === 2 && dupAdv.filter((r) => r.verdict === 'DUPLICATE').length === 1, 'duplicates_review.sql lists the 2 identical advance orders (1 duplicate)')
      check((await stockOfP(dpid)) === 24 && (await one(`SELECT count(*)::int n FROM orders WHERE customer_name = 'Dup Cleanup Customer' AND status = 'cancelled'`)).n === 0, 'the review script changed nothing')
      const cancelSql = fs.readFileSync('db/maintenance/duplicates_cancel.sql', 'utf8').replace(/^BEGIN;$/m, '').replace(/^ROLLBACK;.*$/m, '')
      await client.query(cancelSql)
      check((await stockOfP(dpid)) === 28, 'duplicates_cancel.sql put the 2 duplicate bills\' items back (24 + 4)')
      const left = await rows(`SELECT invoice_no, status FROM orders WHERE customer_name = 'Dup Cleanup Customer' ORDER BY invoice_no`)
      check(left.length === 3 && left[0].invoice_no === d1.body.invoice_no && left[0].status === 'completed' && left.slice(1).every((r) => r.status === 'cancelled'), 'the first bill is kept; the two duplicates are cancelled (not deleted)', JSON.stringify(left))
      const advLeft = await rows(`SELECT status FROM advance_orders WHERE customer_name = 'Dup Cleanup Adv' ORDER BY deposit_id`)
      check(advLeft.length === 2 && advLeft[0].status === 'pending_deposit' && advLeft[1].status === 'cancelled', 'the duplicate advance order is cancelled, the first kept')
      check(d2.status === 201 && d3.status === 201, 'setup bills were created')

      // ---- 5. bill totals, split payments, the deposit-order bill and plain delivery dates
      const tpid = await mkProduct('pos1', 100, 'Totals Product')
      const tb = (extra: Record<string, unknown> = {}) => ({ customer_name: 'Totals Customer', phone: '9876543211', items: [{ product_id: tpid, quantity: 2, unit_price: 50, name: 'Totals Product' }], payment_method: 'cash', ...extra }) // goods value 100
      const made = async (extra: Record<string, unknown>) => {
        const r = await sale('staff1', tb(extra))
        const o = r.status === 201 ? await one(`SELECT total::numeric t, subtotal::numeric s, discount_amount::numeric d, manual_discount_amount::numeric m, payment_method pm, split_details sd FROM orders WHERE id = $1`, [r.body.order_id]) : null
        return { r, o }
      }
      const n0 = await made({})
      check(n0.r.status === 201 && Number(n0.o.t) === 100 && Number(n0.o.d) === 0 && Number(n0.o.m) === 0, 'no discount: total 100, no coupon, no manual discount', JSON.stringify(n0.o))
      const n1 = await made({ discount_amount: 10 }); check(Number(n1.o.t) === 90 && Number(n1.o.d) === 10 && Number(n1.o.m) === 0, 'coupon only: 100 - 10 = 90', JSON.stringify(n1.o))
      const n2 = await made({ manual_discount_amount: 15 }); check(Number(n2.o.t) === 85 && Number(n2.o.d) === 0 && Number(n2.o.m) === 15, 'manual discount only: 100 - 15 = 85', JSON.stringify(n2.o))
      const n3 = await made({ shipping: 20, delivery_charge: 20 }); check(Number(n3.o.t) === 120, 'delivery is added once (120), even though the POS sends it as shipping and delivery charge', JSON.stringify(n3.o))
      const n4 = await made({ discount_amount: 10, manual_discount_amount: 5, total_gst: 9, shipping: 20, delivery_charge: 20 }); check(Number(n4.o.t) === 114, 'coupon + manual + GST + delivery: 100 - 10 - 5 + 9 + 20 = 114', JSON.stringify(n4.o))
      const stockBefore = await stockOfP(tpid); const billsBefore = (await one(`SELECT count(*)::int n FROM orders WHERE customer_name = 'Totals Customer'`)).n
      const sOk = await made({ payment_method: 'split', split_details: { payments: [{ method: 'cash', amount: 40 }, { method: 'qr', amount: 60 }] } })
      check(sOk.r.status === 201 && sOk.o.pm === 'split' && sOk.o.sd.payments.length === 2 && sOk.o.sd.payments[0].method === 'cash' && sOk.o.sd.payments[1].amount === 60, 'split payment (cash 40 + QR 60): payment_method stays "split", the breakdown is saved as structured data', JSON.stringify([sOk.r.status, sOk.r.body, sOk.o]))
      const sBad = await sale('staff1', tb({ payment_method: 'split', split_details: { payments: [{ method: 'cash', amount: 40 }, { method: 'qr', amount: 50 }] } }))
      check(sBad.status === 400 && /add up to the grand total/.test(String(sBad.body.error)), 'split amounts that do not add up to the total are refused', JSON.stringify([sBad.status, sBad.body]))
      check((await stockOfP(tpid)) === stockBefore - 2 && (await one(`SELECT count(*)::int n FROM orders WHERE customer_name = 'Totals Customer'`)).n === billsBefore + 1, 'the refused split made no bill and took no stock (only the good split did)')
      check((await sale('staff1', tb({ payment_method: 'split' }))).status === 400, 'a split without its breakdown is refused')
      check((await sale('staff1', tb({ payment_method: 'split', split_details: { payments: [{ method: 'cash', amount: 40 }, { method: 'cash', amount: 60 }] } }))).status === 400, 'a split must use two different methods')
      check((await sale('staff1', tb({ payment_method: 'cash', split_details: { payments: [{ method: 'cash', amount: 40 }, { method: 'qr', amount: 60 }] } }))).status === 400, 'a payment breakdown on a non-split bill is refused')
      check((await sale('staff1', tb({ payment_method: 'Split (Cash ₹40.00 + QR ₹60.00)' }))).status === 400, 'a long text in payment_method is still refused (30 characters) - the breakdown now travels as structured data')
      // the deposit-order bill: completing it must not invent a coupon or a doubled discount
      const dep = (extra: Record<string, unknown> = {}) => call('POST', '/api/advance-orders', { cookie: cookies.staff1, body: adv({ customer_name: 'Totals Deposit', phone: '9876500111', product_name: 'Totals Product', total_amount: 500, deposit_amount: 100, ...extra }) })
      const dA = await dep(); const dB = await dep()
      const doneA = await call('POST', `/api/advance-orders/${dA.body.order.id}/complete`, { cookie: cookies.staff1, body: { payment_method: 'cash', final_amount: 400 } })
      const billA = await one(`SELECT total::numeric t, subtotal::numeric s, discount_amount::numeric d, manual_discount_amount::numeric m FROM orders WHERE invoice_no = $1 AND branch_id = 'pos1'`, [doneA.body.result.invoice_no])
      check(doneA.status === 200 && Number(billA.t) === 500 && Number(billA.s) === 500 && Number(billA.d) === 0 && Number(billA.m) === 0, 'deposit order, no adjustment: bill total 500, no coupon, no manual discount', JSON.stringify([doneA.status, billA]))
      const doneB = await call('POST', `/api/advance-orders/${dB.body.order.id}/complete`, { cookie: cookies.staff1, body: { payment_method: 'cash', final_amount: 350, manual_discount: 50 } })
      const billB = await one(`SELECT total::numeric t, discount_amount::numeric d, manual_discount_amount::numeric m FROM orders WHERE invoice_no = $1 AND branch_id = 'pos1'`, [doneB.body.result.invoice_no])
      check(doneB.status === 200 && Number(billB.t) === 450 && Number(billB.d) === 0 && Number(billB.m) === 50, 'deposit order with a 50 manual adjustment: stored once (coupon 0, manual 50, total 450), not shown as coupon AND discount', JSON.stringify(billB))
      const advList = await call('GET', '/api/advance-orders', { cookie: cookies.staff1 })
      const listed = (advList.body.orders as any[]).find((o) => o.id === dA.body.order.id)
      check(listed && /^\d{4}-\d{2}-\d{2}$/.test(String(listed.expected_delivery_date)), 'a delivery date comes back as plain YYYY-MM-DD (it used to become a full timestamp that the screen showed as "Invalid Date")', JSON.stringify(listed?.expected_delivery_date))
    }
    // ================================================================== O. MANAGER: no Coupons management, Store Settings writes, branding upload or delete (Admin only)
    {
      const FAKE = '00000000-0000-4000-8000-000000000000'
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
      for (const b of BRANCHES) {
        const n = b.slice(-1); const mgr = `manager${n}` as Actor; const staff = `staff${n}` as Actor
        const adminOnly: Array<[string, string, string, unknown?, boolean?]> = [
          ['GET', '/api/coupons', 'coupon management list'],
          ['POST', '/api/coupons', 'create a coupon', { code: `MGR${n}X`, percentage: 5 }],
          ['PATCH', `/api/coupons/${FAKE}`, 'edit / activate a coupon', { is_active: false }],
          ['DELETE', `/api/coupons/${FAKE}`, 'delete a coupon'],
          ['PUT', '/api/settings', 'store settings write (profile, theme, contact, address)', { theme_color: '#112233' }],
          ['POST', '/api/uploads/branding', 'branding / logo upload', undefined, true],
          ['DELETE', `/api/advance-orders/${FAKE}`, 'delete an advance order'],
          ['DELETE', `/api/orders/${FAKE}`, 'delete an order'],
        ]
        for (const [method, path, what, body, raw] of adminOnly) {
          for (const a of [mgr, staff]) {
            const x = await call(method, path, { cookie: cookies[a], body, ...(raw ? { raw: { buf: png, type: 'image/png' }, query: { filename: 'l.png' } } : {}) })
            check(x.status === 403, `${a} (${b}) ${what}: ${method} ${path.replace(FAKE, ':id')} -> 403`, `status ${x.status}`)
          }
          const ad = await call(method, path, { cookie: cookies.admin, body, ...(raw ? { raw: { buf: png, type: 'image/png' }, query: { filename: 'l.png', branch_id: b } } : { query: { branch_id: b } }) })
          check(ad.status !== 403 && ad.status !== 401, `admin keeps ${method} ${path.replace(FAKE, ':id')} on ${b} (not 403)`, `status ${ad.status}`)
        }
        check([400, 403].includes((await call('GET', '/api/coupons', { cookie: cookies[mgr], query: { branch_id: BRANCHES.find((o) => o !== b)! } })).status), `${mgr}: forged branch_id on coupons refused`)
        // what Manager and Staff keep: apply a coupon at billing, read branch display settings
        await client.query(`INSERT INTO coupons (code, percentage, branch_id) VALUES ($1, 10, $2) ON CONFLICT DO NOTHING`, [`CPN${n}`, b])
        for (const a of [mgr, staff]) {
          const lk = await call('GET', '/api/coupons/lookup', { cookie: cookies[a], query: { code: `cpn${n}` } })
          check(lk.status === 200 && Number(lk.body.coupon?.percentage) === 10, `${a}: coupon code validation still works at billing`, JSON.stringify(lk.body).slice(0, 120))
          check(!Array.isArray(lk.body.coupons), `${a}: validation returns one coupon, not a list`)
          const av = await call('GET', '/api/coupons/available', { cookie: cookies[a] })
          check(av.status === 200 && av.body.coupons.every((c: any) => Object.keys(c).every((k) => ['code', 'percentage'].includes(k))), `${a}: billing coupon chips carry only code and percentage`, JSON.stringify(av.body).slice(0, 160))
          const st = await call('GET', '/api/settings', { cookie: cookies[a] })
          check(st.status === 200 && st.body.settings.branch_id === b && !!st.body.settings.name, `${a}: branch settings READ still works`)
          check(['name', 'address', 'phone', 'logo_url', 'theme_color'].every((k) => k in st.body.settings), `${a}: settings carry the invoice / theme display fields`)
        }
        check((await call('POST', '/api/uploads/product-images', { cookie: cookies[mgr], raw: { buf: png, type: 'image/png' }, query: { filename: 'p.png' } })).status === 201, `${mgr}: product image upload unchanged`)
        const adv = await call('POST', '/api/advance-orders', { cookie: cookies[mgr], body: { customer_name: 'M', phone: '99', product_name: 'Card', total_amount: 100, deposit_amount: 20, expected_delivery_date: '2030-01-01', payment_method: 'cash' } })
        check(adv.status === 201, `${mgr}: still creates an advance order`)
        check((await call('POST', `/api/advance-orders/${adv.body.order.id}/status`, { cookie: cookies[mgr], body: { status: 'ready_for_delivery' } })).status === 200, `${mgr}: still updates it`)
        check((await call('GET', '/api/orders', { cookie: cookies[mgr] })).status === 200, `${mgr}: order history view`)
        check((await call('GET', '/api/inventory/movements', { cookie: cookies[mgr] })).status !== 403 && (await call('GET', '/api/expenses', { cookie: cookies[mgr] })).status === 200, `${mgr}: inventory and expenses unchanged`)
        check((await call('GET', '/api/analytics/orders', { cookie: cookies[mgr] })).status === 403, `${mgr}: analytics still excluded`)
        const dl = await call('DELETE', `/api/advance-orders/${adv.body.order.id}`, { cookie: cookies.admin, query: { branch_id: b } })
        check(dl.status === 200, `admin deletes that advance order on ${b}`, `status ${dl.status}`)
      }
    }

    // ================================================================== N. STAFF: billing, advance orders, order history and the low-stock alert only
    {
      const SECRETS = ['purchase_price', 'unit_cost', 'cost_price']
      const FAKE = '00000000-0000-4000-8000-000000000000'
      for (const b of BRANCHES) {
        const n = b.slice(-1); const staff = `staff${n}` as Actor; const mgr = `manager${n}` as Actor
        // --- everything that manages stock, prices, products, barcodes or deletes an advance order is 403 for Staff
        const forbidden: Array<[string, string, string, unknown?]> = [
          ['GET', '/api/inventory/movements', 'stock history / ledger / ledger CSV'],
          ['GET', '/api/inventory/low-stock', 'full stock list for the old monitor'],
          ['POST', '/api/inventory/adjust', 'adjust stock', {}],
          ['POST', '/api/inventory/movements', 'write a stock movement', {}],
          ['PATCH', '/api/inventory/price', 'price edit', {}],
          ['DELETE', '/api/inventory/items', 'delete an item'],
          ['GET', '/api/barcodes', 'barcode registry list'],
          ['GET', '/api/barcodes/print-data', 'label / print data'],
          ['POST', '/api/barcodes/receive', 'generate barcode + receive stock', {}],
          ['PUT', '/api/barcodes/register', 'register a barcode', {}],
          ['POST', `/api/barcodes/${FAKE}/deactivate`, 'deactivate a barcode', {}],
          ['POST', '/api/products', 'create a product', {}],
          ['PATCH', `/api/products/${prod[b]}`, 'edit a product', {}],
          ['POST', '/api/variants', 'create a variant', {}],
          ['PATCH', `/api/variants/${FAKE}`, 'edit a variant', {}],
          ['POST', `/api/variants/${FAKE}/default`, 'set the default variant', {}],
          ['POST', '/api/categories', 'create a category', {}],
          ['PATCH', `/api/categories/${cat[b]}`, 'edit a category', {}],
          ['DELETE', `/api/categories/${cat[b]}`, 'delete a category'],
          ['POST', '/api/uploads/product-images', 'upload a product image'],
          ['DELETE', `/api/advance-orders/${FAKE}`, 'delete an advance order'],
        ]
        for (const [method, path, what, body] of forbidden) {
          const st = await call(method as any, path, { cookie: cookies[staff], body })
          check(st.status === 403, `${staff} (${b}) ${what}: ${method} ${path.replace(FAKE, ':id')} -> 403`, `status ${st.status}`)
          if (method === 'DELETE' && path.includes('/api/categories/')) continue // (a real delete would remove the category later tests use)
          const mg = await call(method as any, path, { cookie: cookies[mgr], body })
          if (path.startsWith('/api/advance-orders/')) check(mg.status === 403, `${mgr} (${b}) cannot delete an advance order either (Admin only since the manager change)`, `status ${mg.status}`)
          else check(mg.status !== 403 && mg.status !== 401, `${mgr} (${b}) keeps ${method} ${path.replace(FAKE, ':id')} (not 403)`, `status ${mg.status}`)
        }
        // --- what Staff keeps: sell from the POS, scan, advance orders, order history, the low-stock alert
        const own = (rowsList: any[]) => rowsList.every((r) => r.branch_id === b)
        const cat1 = await call('GET', '/api/products', { cookie: cookies[staff] })
        check(cat1.status === 200 && cat1.body.products.length > 0 && own(cat1.body.products), `${staff}: POS product catalog of ${b} only`)
        check(cat1.body.products.every((x: any) => SECRETS.every((k) => !(k in x))), `${staff}: the catalog never carries the purchase cost`)
        check(!!cat1.body.products[0] && 'price' in cat1.body.products[0] && 'stock_quantity' in cat1.body.products[0], `${staff}: the catalog still has price and stock level (needed to sell)`)
        const vr = await call('GET', '/api/variants', { cookie: cookies[staff] })
        check(vr.status === 200 && own(vr.body.variants) && vr.body.variants.every((x: any) => !('purchase_price' in x)), `${staff}: variants of ${b} only, without cost`)
        check((await call('GET', '/api/categories', { cookie: cookies[staff] })).status === 200, `${staff}: category list for the POS filter`)
        const mgrCat = await call('GET', '/api/products', { cookie: cookies[mgr] })
        check(mgrCat.body.products.some((x: any) => 'purchase_price' in x), `${mgr}: the manager's catalog still carries purchase_price (unchanged)`)
        // scan lookup
        const code = await call('POST', '/api/barcodes/receive', { cookie: cookies[mgr], body: { product_id: prod[b], quantity_received: 1, unit_cost: 5 } })
        const scan = await call('GET', '/api/barcodes/lookup', { cookie: cookies[staff], query: { code: code.body.barcode_value } })
        check(scan.status === 200 && scan.body.record.product_id === prod[b], `${staff}: barcode scan lookup works in the POS`)
        // POS sale: stock goes down by the quantity sold
        const before = await stockOf(prod[b])
        const sale = await call('POST', '/api/pos/sale', { cookie: cookies[staff], body: { items: [{ product_id: prod[b], quantity: 2, unit_price: 100, name: 'Api Product' }], payment_method: 'cash' } })
        check(sale.status === 201 && (await stockOf(prod[b])) === before - 2, `${staff}: a POS sale works and stock drops by 2 (${before} -> ${before - 2})`, `status ${sale.status} ${sale.body?.error ?? ''}`)
        // advance orders: create / view / update, no delete
        const adv = await call('POST', '/api/advance-orders', { cookie: cookies[staff], body: { customer_name: 'N', phone: '99', product_name: 'Card', total_amount: 100, deposit_amount: 20, expected_delivery_date: '2030-01-01', payment_method: 'cash' } })
        check(adv.status === 201, `${staff}: creates an advance order`)
        check((await call('GET', '/api/advance-orders', { cookie: cookies[staff] })).body.orders.some((o: any) => o.id === adv.body.order.id), `${staff}: sees it in the list`)
        check((await call('POST', `/api/advance-orders/${adv.body.order.id}/status`, { cookie: cookies[staff], body: { status: 'ready_for_delivery' } })).status === 200, `${staff}: updates its status`)
        check((await call('DELETE', `/api/advance-orders/${adv.body.order.id}`, { cookie: cookies[staff] })).status === 403, `${staff}: cannot delete it (403)`)
        // order history
        const oh = await call('GET', '/api/orders', { cookie: cookies[staff] })
        check(oh.status === 200 && own(oh.body.orders), `${staff}: order history of ${b} only`)
        check((await call('DELETE', `/api/orders/${sale.body.order_id}`, { cookie: cookies[staff] })).status === 403, `${staff}: cannot delete an order`)
        // low-stock alert: narrow, branch-scoped, no cost / barcode / history
        await client.query(`UPDATE products SET stock_quantity = 2, stock = 2, low_stock_alert = 5 WHERE id = $1`, [prod[b]])
        const al = await call('GET', '/api/inventory/low-stock-alerts', { cookie: cookies[staff] })
        const item = al.body.items?.find((x: any) => x.id === `p-${prod[b]}`)
        check(al.status === 200 && !!item && item.quantity === 2 && item.threshold === 5 && item.name === 'Api Product', `${staff}: low-stock alert lists the low item with name, quantity and threshold`, JSON.stringify(al.body).slice(0, 160))
        check(al.body.items.every((x: any) => Object.keys(x).sort().join() === 'id,name,quantity,threshold,variant_name'), `${staff}: the alert carries only id, name, variant name, quantity and threshold`)
        check(al.body.items.every((x: any) => BRANCHES.filter((o) => o !== b).every((o) => x.id !== `p-${prod[o]}`)), `${staff}: the alert never lists another branch's items`)
        check((await call('GET', '/api/inventory/low-stock-alerts', { cookie: cookies[staff], query: { branch_id: BRANCHES.find((o) => o !== b)! } })).status === 400, `${staff}: a forged branch_id on the alert endpoint is refused`)
        check((await call('GET', '/api/inventory/low-stock-alerts', { cookie: cookies[mgr] })).status === 200, `${mgr}: may read the alert endpoint too`)
        await client.query(`UPDATE products SET stock_quantity = 10, stock = 10 WHERE id = $1`, [prod[b]])
      }
      check((await call('GET', '/api/inventory/low-stock-alerts', { cookie: cookies.admin, query: { branch_id: 'pos1' } })).status === 200, 'admin: low-stock alerts for a selected branch')
      check((await call('GET', '/api/inventory/low-stock-alerts')).status === 401, 'low-stock alerts need a session (401)')
    }
    // ================================================================== M3. one barcode = exactly one item (variants never share a code)
    {
      const mkProd = async (b: B, name: string, extra = '') => Number((await one(`INSERT INTO products (name, category, price, stock_quantity, stock, branch_id, is_active, has_variants${extra ? ', barcode' : ''}) VALUES ($2, 'x', 100, 0, 0, $1, true, true${extra ? ', $3' : ''}) RETURNING id`, extra ? [b, name, extra] : [b, name])).id)
      const mkVar = (a: Actor, product_id: number, variant_name: string, price: number, barcode?: string | null) =>
        call('POST', '/api/variants', { cookie: cookies[a], body: { product_id, variant_name, price, stock: 5, ...(barcode !== undefined ? { barcode } : {}) } })
      const scan = (a: Actor, code: string) => call('GET', '/api/barcodes/lookup', { cookie: cookies[a], query: { code } })
      const sal = await mkProd('pos1', 'Salwar Barcode Test')

      // 1. three variants, each with its own code: every scan returns ITS variant and ITS price
      const xl = await mkVar('manager1', sal, 'XL', 100, 'sal-xl-1'); const xxl = await mkVar('manager1', sal, 'XXL', 200, ' Sal-XXL-1 '); const xxxl = await mkVar('manager1', sal, 'XXXL', 300, 'SAL-XXXL-1')
      check(xl.status === 201 && xxl.status === 201 && xxxl.status === 201, 'three variants with their own barcodes are created')
      check(xl.body.variant.barcode === 'SAL-XL-1' && xxl.body.variant.barcode === 'SAL-XXL-1', 'barcodes are stored trimmed and in upper case')
      for (const [code, name, price] of [['sal-xl-1', 'XL', 100], ['SAL-XXL-1', 'XXL', 200], ['sal-xxxl-1', 'XXXL', 300]] as const) {
        const r = await scan('staff1', code)
        check(r.status === 200 && r.body.record.variant?.variant_name === name && Number(r.body.record.variant.price) === price, `scanning ${code} returns variant ${name} at ${price} (not the first variant)`, JSON.stringify(r.body.record?.variant))
      }

      // 2. a second variant can NOT take a code that already belongs to another item
      const dupSame = await mkVar('manager1', sal, 'Dup1', 50, 'SAL-XL-1')
      const dupCase = await mkVar('manager1', sal, 'Dup2', 50, '  sal-xl-1 ')
      check(dupSame.status === 409 && /already used by another item/.test(dupSame.body.error), 'creating a variant with an existing barcode is refused (409, clear message)', JSON.stringify(dupSame.body))
      check(dupCase.status === 409, 'the same code in another case / with spaces is refused too')
      const patchDup = await call('PATCH', `/api/variants/${xxl.body.variant.id}`, { cookie: cookies.manager1, body: { barcode: 'sal-xl-1' } })
      check(patchDup.status === 409, 'changing a variant to another variant\'s barcode is refused (409)')
      check((await call('PATCH', `/api/variants/${xxl.body.variant.id}`, { cookie: cookies.manager1, body: { barcode: 'SAL-XXL-1', price: 210 } })).status === 200, 'saving a variant with its OWN barcode again is fine')
      check((await scan('staff1', 'SAL-XXL-1')).body.record.variant.price == 210, 'the scan returns the updated price of that variant')

      // 3. product-level code vs variant code (same branch): refused both ways
      const prodPatch = await call('PATCH', `/api/products/${sal}`, { cookie: cookies.manager1, body: { barcode: 'SAL-XL-1' } })
      check(prodPatch.status === 409, 'a product cannot take a barcode that a variant already has (409)')
      const other = await mkProd('pos1', 'Other product', 'PROD-ONLY-9')
      check((await mkVar('manager1', sal, 'Dup3', 50, 'PROD-ONLY-9')).status === 409, 'a variant cannot take a barcode that a product already has (409)')
      check(other > 0, 'setup product exists')

      // 4. every branch has its own codes: the same manufacturer code in another branch is fine and stays separate
      const sal2 = await mkProd('pos2', 'Salwar Barcode Test')
      const b2 = await mkVar('manager2', sal2, 'XL', 999, 'SAL-XL-1')
      check(b2.status === 201, 'the same code in ANOTHER branch is allowed (codes are unique per branch)')
      check(Number((await scan('staff2', 'SAL-XL-1')).body.record.variant.price) === 999 && Number((await scan('staff1', 'SAL-XL-1')).body.record.variant.price) === 100, 'each branch scans its own variant')

      // 5. the registry can no longer be silently re-pointed from one variant to another
      const reg = (a: Actor, product_id: number, variant_id: string | null, barcode_value: string) => call('PUT', '/api/barcodes/register', { cookie: cookies[a], body: { product_id, variant_id, barcode_value } })
      check((await reg('manager1', sal, xl.body.variant.id, 'sal-xl-1')).status === 200, 'registering a variant\'s own code again is fine (idempotent)')
      const steal = await reg('manager1', sal, xxl.body.variant.id, 'SAL-XL-1')
      check(steal.status === 409, 'registering a code that belongs to ANOTHER variant is refused (409), not re-pointed', JSON.stringify(steal.body))
      check((await scan('staff1', 'SAL-XL-1')).body.record.variant.variant_name === 'XL', 'the code still scans as XL')
      check((await reg('manager1', sal, xxxl.body.variant.id, 'brand-new-77')).status === 200 && (await scan('staff1', 'BRAND-NEW-77')).body.record.variant.variant_name === 'XXXL', 'a new code can be registered for a variant and scans as that variant')

      // 6. the generated way (Add Barcode for each variant) stays correct
      const gp = await mkProd('pos1', 'Generated Variants')
      const gv = [await mkVar('manager1', gp, 'Green', 40), await mkVar('manager1', gp, 'Blue', 45)]
      const gcodes: string[] = []
      for (const v of gv) gcodes.push((await call('POST', '/api/barcodes/receive', { cookie: cookies.manager1, body: { product_id: gp, variant_id: v.body.variant.id, quantity_received: 2, unit_cost: 10 } })).body.barcode_value)
      check(new Set(gcodes).size === 2 && gcodes.every((c) => /^PBV\d{8}$/.test(c)), 'Add Barcode makes a different PBV code for each variant', gcodes.join(','))
      check((await scan('staff1', gcodes[0])).body.record.variant.variant_name === 'Green' && (await scan('staff1', gcodes[1])).body.record.variant.variant_name === 'Blue', 'each generated code scans as its own variant')
      const colCodes = (await rows(`SELECT barcode FROM product_variants WHERE product_id = $1 ORDER BY variant_name`, [gp])).map((r) => r.barcode)
      check(colCodes.join() === [gcodes[1], gcodes[0]].join(), 'the printed-label column and the registry agree', colCodes.join())

      // 7. a removed (inactive) variant lets go of its code
      check((await call('PATCH', `/api/variants/${xl.body.variant.id}`, { cookie: cookies.manager1, body: { is_active: false } })).status === 200, 'a variant can be deactivated')
      const reuse = await mkVar('manager1', sal, 'XL new', 120, 'SAL-XL-1')
      check(reuse.status === 409 || reuse.status === 201, 'reusing the code of a deactivated variant is decided by the registry (see next check)')
      await client.query(`UPDATE barcode_registry SET is_active = false WHERE branch_id = 'pos1' AND barcode_value = 'SAL-XL-1'`)
      const reuse2 = await mkVar('manager1', sal, 'XL again', 120, 'SAL-XL-1')
      check(reuse2.status === 201 && (await scan('staff1', 'SAL-XL-1')).body.record.variant.variant_name === 'XL again', 'once its registry entry is also inactive the code can be given to a new variant and scans as it')

      // 8. old data: the repair function clears duplicates and the unique index can then be built
      await client.query('SAVEPOINT legacy')
      await client.query(`ALTER TABLE product_variants DISABLE TRIGGER USER`)
      await client.query(`ALTER TABLE products DISABLE TRIGGER USER`)
      await client.query(`ALTER TABLE barcode_registry DISABLE TRIGGER USER`)
      await client.query(`DROP INDEX public.product_variants_branch_barcode_unique`)
      await client.query(`DROP INDEX public.products_branch_barcode_unique`)
      const lp = await mkProd('pos3', 'Legacy P')
      const legV = [] as string[]
      for (const n of ['L1', 'L2', 'L3']) legV.push((await one(`INSERT INTO product_variants (product_id, variant_name, price, stock, branch_id, is_active, barcode) VALUES ($1, $2, 10, 1, 'pos3', true, ' leg-1 ') RETURNING id`, [lp, n])).id)
      await client.query(`INSERT INTO barcode_registry (barcode_value, entity_type, product_id, variant_id, is_active, branch_id) VALUES ('LEG-1', 'variant', $1, $2, true, 'pos3')`, [lp, legV[1]])
      const sp2 = await mkProd('pos3', 'Legacy S', 'leg-3'); const sv = (await one(`INSERT INTO product_variants (product_id, variant_name, price, stock, branch_id, is_active, barcode) VALUES ($1, 'SV', 10, 1, 'pos3', true, 'LEG-3') RETURNING id`, [sp2])).id
      const qp = await one(`INSERT INTO products (name, category, price, stock_quantity, stock, branch_id, is_active, has_variants, barcode) VALUES ('Legacy Q', 'x', 10, 1, 1, 'pos3', true, false, 'LEG-2') RETURNING id`)
      const rp = await mkProd('pos3', 'Legacy R'); const wv = (await one(`INSERT INTO product_variants (product_id, variant_name, price, stock, branch_id, is_active, barcode) VALUES ($1, 'W', 10, 1, 'pos3', true, 'LEG-2') RETURNING id`, [rp])).id
      const fixed = (await one(`SELECT public.fix_duplicate_barcodes() AS r`)).r
      const after = await rows(`SELECT id, barcode FROM product_variants WHERE id = ANY($1::uuid[])`, [[...legV, sv, wv]])
      const bc = (id: string) => after.find((r) => r.id === id)?.barcode
      check(bc(legV[1]) === 'LEG-1' && bc(legV[0]) === null && bc(legV[2]) === null, 'repair: of three variants sharing a code, the one the registry points at keeps it, the others lose it', JSON.stringify(fixed))
      check((await one(`SELECT barcode FROM products WHERE id = $1`, [sp2])).barcode === null && bc(sv) === 'LEG-3', 'repair: a code on a multi-variant product AND its variant stays with the variant')
      check((await one(`SELECT barcode FROM products WHERE id = $1`, [qp.id])).barcode === 'LEG-2' && bc(wv) === null, 'repair: a code on a plain product AND a variant stays with the product')
      let built = true
      try { await client.query(`CREATE UNIQUE INDEX product_variants_branch_barcode_unique ON public.product_variants (branch_id, barcode) WHERE barcode IS NOT NULL AND is_active`); await client.query(`CREATE UNIQUE INDEX products_branch_barcode_unique ON public.products (branch_id, barcode) WHERE barcode IS NOT NULL AND is_active`) } catch { built = false }
      check(built, 'after the repair the unique indexes can be created (no duplicates left)')
      await client.query('ROLLBACK TO SAVEPOINT legacy')
      check((await one(`SELECT count(*)::int n FROM pg_indexes WHERE indexname IN ('product_variants_branch_barcode_unique', 'products_branch_barcode_unique')`)).n === 2, 'the simulation was rolled back: the real indexes are still there')
    }
    // ================================================================== N. login rate limits (run last: they lock logins)
    {
      // The sign-in lockout counts one DEVICE (a random yg_dev cookie the server hands out) per IP, so phones sharing
      // a public IP (4G, shop Wi-Fi) do not lock each other out; a wider per-IP guard catches clients that drop the cookie.
      const D = (n: number) => `yg_dev=${n.toString(16).padStart(24, '0')}`
      const L2 = (ip: string, dev: number | null, body: Record<string, unknown>) => call('POST', '/api/auth/login', { ip, cookie: dev === null ? undefined : D(dev), body })
      const ip = '192.0.2.50'
      const codes: Array<{ status: number; error?: string }> = []
      for (let i = 0; i < 10; i++) { const r = await L2(ip, 1, { passcode: `wrong-guess-${i}-xxxx` }); codes.push({ status: r.status, error: r.body?.error }) }
      check(codes.every((c) => c.status === 401 && c.error === 'Incorrect passcode'), '10 wrong passcodes from one device are each answered 401 "Incorrect passcode"')
      const locked = await L2(ip, 1, { passcode: PASS.manager1 })
      check(locked.status === 429 && Number(locked.headers.get('retry-after')) > 0, 'the 11th attempt from that device is locked out (429 + Retry-After) even with a CORRECT passcode')
      check(locked.body.error === 'Too many attempts' && locked.body.retry_after >= 290 && locked.body.retry_after <= 300, 'the lockout answer carries retry_after in seconds (about 5 minutes) for the "Try again in M:SS" countdown', JSON.stringify(locked.body))
      check(locked.cookies.length === 0, 'a locked-out attempt never sets a session cookie')
      const sameIp = await L2(ip, 2, { passcode: PASS.manager1 })
      check(sameIp.status === 200, 'ANOTHER device on the SAME IP can still sign in (shared Wi-Fi / 4G does not lock everyone)')
      const otherIp = await L2('192.0.2.51', 1, { passcode: PASS.manager1 })
      check(otherIp.status === 200, 'the same device id from a different IP is not locked either')
      check((await one(`SELECT count(*)::int n FROM login_attempts WHERE bucket = 'login' AND ip = $1 AND success = false`, [ip])).n === 10, 'failed attempts are recorded in login_attempts (database-backed); attempts made while locked are not added')
      const fresh = await L2('192.0.2.52', null, { passcode: 'wrong-guess-yyyyyy' })
      const devSet = fresh.cookies.find((c) => c.startsWith('yg_dev=')) || ''
      check(fresh.status === 401 && /yg_dev=[a-f0-9]{24}/.test(devSet) && /HttpOnly/i.test(devSet) && /SameSite=Strict/i.test(devSet), 'a client without a device cookie is given one (httpOnly, SameSite=Strict) and still gets the plain 401')
      check(!/yg_session/.test(fresh.cookies.join(';')), 'the device cookie is not a session')

      // ---- the lockout ends by itself after 5 minutes, and the old failures are forgotten
      await client.query(`UPDATE login_attempts SET attempted_at = attempted_at - interval '4 minutes' WHERE ip = $1`, [ip])
      const still = await L2(ip, 1, { passcode: PASS.manager1 })
      check(still.status === 429 && still.body.retry_after >= 50 && still.body.retry_after <= 70, 'after 4 minutes the lockout still has about 1 minute to go', JSON.stringify(still.body))
      await client.query(`UPDATE login_attempts SET attempted_at = attempted_at - interval '2 minutes' WHERE ip = $1`, [ip])
      const back = await L2(ip, 1, { passcode: PASS.manager1 })
      check(back.status === 200, 'after 5 minutes the lockout has cleared itself and the right passcode signs in')
      check((await one(`SELECT count(*)::int n FROM login_attempts WHERE bucket = 'login' AND ip = $1 AND success = false`, [ip])).n === 0, 'the expired failures were deleted and the counter restarted from zero')

      // ---- an (optional) portal selection makes the key IP + role + branch + device
      const ipS = '192.0.2.60'
      for (let i = 0; i < 10; i++) await L2(ipS, 3, { passcode: `staff1-guess-${i}-xx`, as: 'staff', site: 'pos1' })
      check((await L2(ipS, 3, { passcode: PASS.staff1, as: 'staff', site: 'pos1' })).status === 429, 'Staff Branch 1 is locked after 10 wrong passcodes from this device')
      check((await L2(ipS, 3, { passcode: PASS.manager1, as: 'manager', site: 'pos1' })).status === 200, 'Manager Branch 1 from the SAME device is not locked (the counter is per role)')
      // ---- a good sign-in on a selected portal resets that portal's counter
      const ipR = '192.0.2.61'
      for (let i = 0; i < 4; i++) await L2(ipR, 4, { passcode: `wrong-${i}-xxxxxx`, as: 'staff', site: 'pos3' })
      check((await L2(ipR, 4, { passcode: PASS.staff3, as: 'staff', site: 'pos3' })).status === 200, 'a right passcode after a few wrong ones signs in')
      check((await one(`SELECT count(*)::int n FROM login_attempts WHERE bucket = 'login' AND ip = $1 AND success = false`, [ipR])).n === 0, 'a successful sign-in on a selected portal resets that counter')
      // without a selected portal a success must NOT reset (a guesser could clear its own counter with one known passcode)
      const ipN = '192.0.2.62'
      for (let i = 0; i < 3; i++) await L2(ipN, 5, { passcode: `wrong-${i}-xxxxxx` })
      await L2(ipN, 5, { passcode: PASS.staff3 })
      check((await one(`SELECT count(*)::int n FROM login_attempts WHERE bucket = 'login' AND ip = $1 AND success = false`, [ipN])).n === 3, 'a sign-in without a selected portal does not reset the counter')
      // ---- dropping or changing the (client-controlled) device cookie cannot dodge the limit: a wider per-IP guard counts everything
      const ipW = '192.0.2.63'
      for (let d = 10; d < 13; d++) for (let i = 0; i < 10; i++) await L2(ipW, d, { passcode: `dodge-${d}-${i}-xxxx` })
      check((await L2(ipW, 13, { passcode: PASS.manager2 })).status === 429, '30 failures from one IP lock the whole IP, so new device ids or no cookie do not dodge the limit')
      check((await L2(ipW, null, { passcode: PASS.manager2 })).status === 429, 'a client with no device cookie is locked by the same IP guard')
      // ---- admin clears lockouts without redeploying
      const ipC = '192.0.2.64'
      for (let i = 0; i < 10; i++) await L2(ipC, 20, { passcode: `clear-${i}-xxxxxxx` })
      check((await L2(ipC, 20, { passcode: PASS.manager2 })).status === 429, 'this device is locked')
      check((await call('POST', '/api/admin/login-lockouts/clear', { body: {} })).status === 401, 'clearing lockouts needs a session (401 without)')
      check((await call('POST', '/api/admin/login-lockouts/clear', { cookie: cookies.manager1, body: {} })).status === 403, 'a manager cannot clear lockouts (403)')
      check((await call('POST', '/api/admin/login-lockouts/clear', { cookie: cookies.staff1, body: {} })).status === 403, 'staff cannot clear lockouts (403)')
      check((await call('POST', '/api/admin/login-lockouts/clear', { cookie: cookies.admin, body: { site: 'POS 2' } })).status === 400, 'clear rejects a malformed branch id (zod)')
      const cl = await call('POST', '/api/admin/login-lockouts/clear', { cookie: cookies.admin, body: {} })
      check(cl.status === 200 && cl.body.cleared >= 10, 'the admin clears the lockouts', JSON.stringify(cl.body))
      check((await L2(ipC, 20, { passcode: PASS.manager2 })).status === 200, 'the locked device signs in again right after the admin cleared the lockouts')
      check((await L2(ipW, 13, { passcode: PASS.manager2 })).status === 200, 'the IP that was locked by the wider guard is free again')
      check((await one(`SELECT count(*)::int n FROM login_attempts WHERE bucket = 'login' AND success = false`)).n === 0, 'clearing forgets every failed sign-in')
      const sel = await call('POST', '/api/admin/login-lockouts/clear', { cookie: cookies.admin, body: { site: 'pos1' } })
      check(sel.status === 200 && sel.body.site === 'pos1', 'clearing can also be limited to one branch id (API)')
      // distributed guessing across many IPs is SLOWED, never blocked: real users must still be able to sign in
      const seq = [0, 5, 9, 10, 11, 15, 30, 1000].map((n) => slowdownMs(n))
      check(seq[0] === 0 && seq[1] === 0 && seq[2] === 0, 'no slowdown below the free failure count')
      check(seq[3] > 0 && seq[4] > seq[3] && seq[5] > seq[4] && seq[6] >= seq[5], 'the delay grows with every additional failure')
      check(seq[7] === Number(process.env.LOGIN_SLOWDOWN_MAX_MS) && Math.max(...seq) === seq[7], 'the delay is capped (never an unbounded wait)')
      const failuresBefore = (await one(`SELECT count(*)::int n FROM login_attempts WHERE bucket = 'login' AND success = false AND attempted_at > now() - interval '15 minutes'`)).n
      for (let i = 0; i < 45; i++) await call('POST', '/api/auth/login', { ip: `198.18.${Math.floor(i / 200)}.${(i % 200) + 1}`, body: { passcode: `spray-${i}-aaaaaa` } })
      const failuresNow = (await one(`SELECT count(*)::int n FROM login_attempts WHERE bucket = 'login' AND success = false AND attempted_at > now() - interval '15 minutes'`)).n
      check(failuresNow >= failuresBefore + 45 && failuresNow >= 40, 'the spray produced 40+ failures system-wide', `${failuresNow}`)
      const t0 = Date.now()
      const g = await call('POST', '/api/auth/login', { ip: '198.19.0.1', body: { passcode: PASS.manager1 } })
      const took = Date.now() - t0
      check(g.status === 200 && g.body.role === 'manager', 'after 40+ failures system-wide a REAL user with the right passcode still signs in (no lockout)', `status ${g.status}`)
      check(took >= slowdownMs(failuresNow) - 50, 'but that attempt was slowed down', `took ${took} ms, expected >= ${slowdownMs(failuresNow)} ms`)
      const g2 = await call('POST', '/api/auth/login', { ip: '198.19.0.2', body: { passcode: PASS.staff1 } })
      check(g2.status === 200, 'other real users are not locked out either')
      const bad = await call('POST', '/api/auth/login', { ip: '198.19.0.3', body: { passcode: 'wrong-again-xxxxx' } })
      check(bad.status === 401, 'a wrong passcode under slowdown is still a plain 401 (not 429)')
    }
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    server.close()
    await restoreOnce()
    const after = await one(`SELECT (SELECT count(*) FROM products)::int p, (SELECT count(*) FROM orders)::int o, (SELECT count(*) FROM expenses)::int e,
      (SELECT count(*) FROM login_attempts)::int l, (SELECT string_agg(md5(passcode_hash) || token_version::text, ',' ORDER BY id) FROM passcodes) pc`)
    check(JSON.stringify(after) === JSON.stringify(base), 'cleanup: database, real passcodes and sequences are exactly as before the run')
    client.release()
  }
  results.forEach((l) => console.log(l))
  console.log(`\n${passed} passed, ${failed} failed`)
  await pool.end()
  process.exitCode = failed ? 1 : 0
}

run().catch((e) => {
  results.forEach((l) => console.log(l))
  console.error('API test run crashed:', e instanceof Error ? e.stack : e)
  process.exitCode = 1
})
