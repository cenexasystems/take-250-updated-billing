/**
 * API tests. Boots the real Express app on a local port against DATABASE_URL, inside ONE database
 * transaction that is rolled back at the end (passcodes, data, rate-limit rows, token versions: nothing
 * is left behind), and restores every sequence it advanced.
 *   npm run test:api
 *
 * Section A is generated from the central permission table x every registered route x every role.
 */
import './test-env'
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
      check(same(NAV_ORDER.manager, NAV_ORDER.admin.filter((t) => t !== 'pos_analytics')), 'manager sidebar = admin sidebar minus the Analytics Dashboard')
      check(same(NAV_ORDER.staff, ['branch_hub', 'billing', 'inventory', 'advance_orders', 'history']), 'staff sidebar equals the original staff list')
      check(UI_ROLES.every((r) => NAV_ORDER[r].every((t) => canOpenTab(r, t))), 'every sidebar entry is openable by its own role')
      check(FEATURE_ACCESS['branch.switch'].join() === 'admin', 'only the admin has the branch switcher')
    }

    // ================================================================== B. login / session cookie
    {
      const ok = await call('POST', '/api/auth/login', { body: { passcode: PASS.staff1 } })
      const sc = ok.cookies.join(';')
      check(/HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc) && /Path=\//.test(sc), 'session cookie is httpOnly + sameSite=strict')
      const maxAge = Number(/Max-Age=(\d+)/.exec(sc)?.[1])
      check(maxAge > 0 && maxAge <= 8 * 3600, 'session cookie expiry is short (<= 8h)', `${maxAge}`)
      process.env.COOKIE_INSECURE = ''
      const sec = await call('POST', '/api/auth/login', { body: { passcode: PASS.staff1 } })
      process.env.COOKIE_INSECURE = '1'
      check(/;\s*Secure/i.test(sec.cookies.join(';')), 'session cookie is Secure unless local-http mode is on')
      check(!JSON.stringify(ok.body).includes('token'), 'login response does not contain the token')
      const bad1 = await call('POST', '/api/auth/login', { body: { passcode: 'definitely-wrong-passcode' } })
      const bad2 = await call('POST', '/api/auth/login', { body: { passcode: PASS.staff1 + 'x' } })
      check(bad1.status === 401 && bad2.status === 401 && JSON.stringify(bad1.body) === JSON.stringify(bad2.body) && bad1.body.error === 'Invalid passcode', 'wrong passcodes get one generic 401 message')
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
    }

    // ================================================================== C. a passcode never opens another branch / higher role
    {
      const m = await call('GET', '/api/products', { cookie: cookies.manager1 })
      check(m.body.products.every((p: any) => p.branch_id === 'pos1') && m.body.products.some((p: any) => p.id === prod.pos1), 'manager1 passcode sees only branch 1 products')
      for (const b of ['pos2', 'pos3'] as const) {
        check((await call('GET', `/api/products/${prod[b]}`, { cookie: cookies.staff1 })).status === 404, `staff1 cannot read a ${b} product by id`)
        check((await call('GET', `/api/products/${prod[b]}`, { cookie: cookies.manager1 })).status === 404, `manager1 cannot read a ${b} product by id`)
        const patch = await call('PATCH', `/api/products/${prod[b]}`, { cookie: cookies.staff1, body: { price: 1 } })
        check(patch.status === 404 && (await one(`SELECT price::numeric p FROM products WHERE id = $1`, [prod[b]])).p == 100, `staff1 cannot edit a ${b} product`)
        check((await call('PATCH', `/api/variants/${variant[b]}`, { cookie: cookies.manager1, body: { price: 1 } })).status === 404, `manager1 cannot edit a ${b} variant`)
      }
      for (const [a, other] of [['staff2', 'pos1'], ['manager3', 'pos2'], ['staff3', 'pos1']] as [Actor, B][]) {
        const r = await call('GET', '/api/inventory/low-stock', { cookie: cookies[a] })
        check(r.body.products.every((p: any) => p.id !== prod[other]), `${a} low-stock list contains nothing from ${other}`)
      }
      // staff passcode can never act as manager / admin
      const sv = await call('PUT', '/api/admin/passcodes', { cookie: cookies.staff1, body: { target_role: 'staff', target_branch: 'pos1', new_passcode: 'Another-Pass-123', current_admin_passcode: PASS.admin } })
      check(sv.status === 403, 'staff cannot manage passcodes even with the admin passcode in the body')
      check((await call('DELETE', '/api/inventory/items', { cookie: cookies.staff1, query: { product_id: String(prod.pos1) } })).status === 403, 'staff cannot delete inventory items')
      check((await call('PATCH', `/api/orders/${'00000000-0000-4000-8000-000000000000'}/status`, { cookie: cookies.staff1, body: { status: 'completed' } })).status === 403, 'staff cannot change order status')
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
          check(r.status === 400, `${a}: forged ${label} is rejected`, `status ${r.status}`)
        }
        // even a branch id equal to their OWN is refused: the client never names a branch
        check((await call('POST', '/api/products', { cookie: cookies[a], body: { name: 'Forged', branch_id: own } })).status === 400, `${a}: even own branch_id in the body is refused`)
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
      check((await call('POST', '/api/products', { cookie: cookies.staff1, body: { name: 'X', is_admin: true } })).status === 400, 'unknown product field rejected (zod strict)')
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
        const a = `staff${b.slice(-1)}` as Actor
        const before = await stockOf(prod[b])
        const r = await call('POST', '/api/barcodes/receive', { cookie: cookies[a], body: { product_id: prod[b], quantity_received: 4, unit_cost: 50 } })
        gen[b] = r.body
        check(r.status === 200 && r.body.is_new_barcode === true && r.body.barcode_value.startsWith({ pos1: 'PBP', pos2: 'P2P', pos3: 'P3P' }[b]), `${a} generates a ${b} barcode through the API`, r.body?.error ?? '')
        check((await stockOf(prod[b])) === before + 4, `receive-stock changes ${b} stock only through its own token`)
        const mv = (await one(`SELECT created_by_name, branch_id FROM inventory_movements WHERE barcode_id = $1 ORDER BY id DESC LIMIT 1`, [r.body.barcode_id])) ?? {}
        check(mv.branch_id === b && mv.created_by_name === 'Staff', `${b} receipt is stamped with the token's branch and role name`)
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
          check((await call('GET', '/api/barcodes/print-data', { cookie: cookies[`staff${o.slice(-1)}` as Actor], query: { product_id: String(prod[b]) } })).status === 404, `print-data for a ${b} product from ${o} -> not found`)
        }
      }
      // never adds another branch's item: receive/print/receive by foreign product id
      const x = await call('POST', '/api/barcodes/receive', { cookie: cookies.staff3, body: { product_id: prod.pos1, quantity_received: 9 } })
      check(x.status === 400 && (await stockOf(prod.pos1)) === 14, 'staff3 cannot receive stock against a branch 1 product')
      check((await call('POST', '/api/barcodes/receive', { cookie: cookies.staff1, body: { product_id: prod.pos1, quantity_received: 1, branch_id: 'pos2' } })).status === 400, 'receive-stock refuses a client branch_id')
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
      check(list.status === 200 && list.body.records.every((r: any) => r.product_id === prod.pos2), 'barcode list shows only the token\'s branch')
      check((await call('POST', `/api/barcodes/${gen.pos1.barcode_id}/deactivate`, { cookie: cookies.staff2 })).status === 404, 'staff2 cannot deactivate a branch 1 barcode')
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
      check((await call('DELETE', `/api/orders/${sale.body.order_id}`, { cookie: cookies.manager3 })).status === 404, 'manager3 cannot delete a branch 1 order')
      // coupons
      check((await call('GET', '/api/coupons/lookup', { cookie: cookies.staff1, query: { code: 'api10' } })).body.coupon?.percentage == 10, 'coupon lookup (case-insensitive) in own branch')
      await client.query(`INSERT INTO coupons (code, percentage, branch_id) VALUES ('ONLY2', 5, 'pos2')`)
      check((await call('GET', '/api/coupons/lookup', { cookie: cookies.staff1, query: { code: 'ONLY2' } })).status === 404, 'a branch 2 coupon code is not found at branch 1')
      check((await call('GET', '/api/coupons', { cookie: cookies.staff1 })).status === 403, 'staff cannot list/manage coupons')
      check((await call('GET', '/api/coupons', { cookie: cookies.manager1 })).body.coupons.every((c: any) => c.branch_id === 'pos1'), 'manager1 coupon list is branch 1 only')
      // unregistered item
      const un = await call('POST', '/api/pos/unregistered-product', { cookie: cookies.staff3, body: { name: 'Loose item', price: 25 } })
      check(un.status === 200 && (await one(`SELECT branch_id FROM products WHERE id = $1`, [un.body.id])).branch_id === 'pos3', 'unregistered product is created in the token\'s branch')
    }

    // ================================================================== H. advance orders, expenses, settings
    {
      const adv = await call('POST', '/api/advance-orders', { cookie: cookies.staff1, body: { customer_name: 'A', phone: '99', product_name: 'Card', total_amount: 100, deposit_amount: 20, expected_delivery_date: '2030-01-01', payment_method: 'cash' } })
      check(adv.status === 201 && adv.body.order.branch_id === 'pos1', 'staff1 creates an advance order in branch 1', adv.body?.error ?? '')
      const id = adv.body.order.id
      check((await call('GET', '/api/advance-orders', { cookie: cookies.staff2 })).body.orders.length === 0, 'staff2 sees no branch 1 advance orders')
      check((await call('POST', `/api/advance-orders/${id}/status`, { cookie: cookies.staff2, body: { status: 'ready_for_delivery' } })).status >= 400, 'staff2 cannot change a branch 1 advance order')
      check((await call('POST', `/api/advance-orders/${id}/complete`, { cookie: cookies.manager3, body: { payment_method: 'cash', final_amount: 80 } })).status >= 400, 'manager3 cannot complete a branch 1 advance order')
      check((await call('GET', `/api/advance-orders/${id}/history`, { cookie: cookies.staff3 })).status === 404, 'staff3 cannot read a branch 1 advance order history')
      check((await call('POST', `/api/advance-orders/${id}/status`, { cookie: cookies.staff1, body: { status: 'ready_for_delivery' } })).status === 200, 'staff1 updates its own advance order')
      check((await call('DELETE', `/api/advance-orders/${id}`, { cookie: cookies.staff2 })).status === 404, 'staff2 cannot delete a branch 1 advance order')

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
      const put = await call('PUT', '/api/settings', { cookie: cookies.manager2, body: { theme_color: '#112233', name: 'Branch Two Shop' } })
      check(put.status === 200 && put.body.settings.branch_id === 'pos2' && put.body.settings.theme_color === '#112233', 'manager2 store-settings write lands in branch 2 (token branch)')
      check((await one(`SELECT theme_color FROM store_settings WHERE branch_id = 'pos1'`)).theme_color === before1.theme_color, 'branch 1 settings untouched by manager2')
      check((await call('PUT', '/api/settings', { cookie: cookies.staff1, body: { name: 'x' } })).status === 403, 'staff cannot write store settings')
      check((await call('PUT', '/api/settings', { cookie: cookies.manager1, body: { theme_color: 'red' } })).status === 400, 'invalid theme colour rejected (zod)')
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
      const r1 = await up('staff1', 'product-images')
      check(r1.status === 201 && r1.body.path.startsWith('pos1/product-images/') && r1.body.path.endsWith('.png'), 'staff1 product image path starts with pos1/')
      const r2 = await up('manager2', 'branding')
      check(r2.status === 201 && r2.body.path.startsWith('pos2/branding/'), 'manager2 branding upload path starts with pos2/')
      check((await up('staff1', 'branding')).status === 403, 'staff cannot upload branding')
      check((await up('staff1', 'avatars')).status === 403, 'staff cannot upload avatars')
      check((await up('staff3', 'invoices', { raw: { buf: Buffer.from('%PDF-1.4'), type: 'application/pdf' } })).body.path?.startsWith('pos3/invoices/'), 'staff3 invoice PDF path starts with pos3/')
      check((await up('admin', 'avatars')).status === 400, 'admin upload without a branch selector -> 400')
      const a3 = await up('admin', 'avatars', { cookie: cookies.admin, query: { branch_id: 'pos3', filename: 'x.png' } })
      check(a3.status === 201 && a3.body.path.startsWith('pos3/avatars/'), 'admin upload path uses the selected, validated branch')
      const trav = await up('staff1', 'product-images', { query: { filename: '../../pos2/evil.png' } })
      check(trav.status === 201 && trav.body.path.startsWith('pos1/product-images/') && !trav.body.path.includes('..') && trav.body.path.split('/').length === 3, 'path traversal in the filename cannot leave the branch prefix')
      check((await up('staff1', 'product-images', { raw: { buf: Buffer.from('<svg/>'), type: 'image/svg+xml' } })).status === 415, 'SVG upload refused (415)')
      check((await up('staff1', 'product-images', { raw: { buf: Buffer.from('x'), type: 'text/html' } })).status === 415, 'HTML upload refused (415)')
      check((await up('staff1', 'product-images', { raw: { buf: Buffer.alloc(6 * 1024 * 1024, 1), type: 'image/png' } })).status === 413, 'oversized image refused (413)')
      check((await up('staff1', 'product-images', { body: undefined, raw: { buf: Buffer.alloc(0), type: 'image/png' } })).status === 400, 'empty upload refused')
      check((await up('staff1', 'product-images', { query: { filename: 'a.png', branch_id: 'pos2' } })).status === 400, 'upload refuses a client branch_id')
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
      check((await call('POST', '/api/categories', { cookie: cookies.staff1, body: { name_en: 'temp cat' } })).body.existing === true, 'creating the same name again returns the existing category')
      const pp = await call('POST', '/api/products', { cookie: cookies.staff1, body: { name: 'In Temp', category: 'Temp Cat', category_id: cc.body.category.id, price: 5 } })
      check(pp.status === 201, 'staff creates a product in that category')
      const dup = await call('POST', '/api/products', { cookie: cookies.staff1, body: { name: 'In Temp', category: 'Temp Cat', category_id: cc.body.category.id, price: 5 } })
      check(dup.status === 409 && dup.body.error === 'A product with this name already exists in the selected category.', 'duplicate product name gives the original message', dup.body?.error ?? '')
      check((await call('DELETE', `/api/categories/${cc.body.category.id}`, { cookie: cookies.staff1 })).status === 403, 'staff cannot delete a category')
      check((await call('DELETE', `/api/categories/${cc.body.category.id}`, { cookie: cookies.manager2 })).status === 404, 'manager2 cannot delete a branch 1 category')
      check((await call('DELETE', `/api/categories/${cc.body.category.id}`, { cookie: cookies.manager1 })).status === 200, 'manager1 deletes its category')
      const moved = await one(`SELECT category, category_id FROM products WHERE id = $1`, [pp.body.product.id])
      check(moved.category === 'Uncategorized' && moved.category_id === null, 'the products of a deleted category become Uncategorized')
      const dv = await call('POST', '/api/variants', { cookie: cookies.staff1, body: { product_id: prod.pos1, variant_name: 'Large', price: 1 } })
      check(dv.status === 409 && dv.body.error === 'A variant with this name already exists for this product.', 'duplicate variant name gives the original message', dv.body?.error ?? '')
      const dc = await call('POST', '/api/coupons', { cookie: cookies.manager1, body: { code: ' api10 ', percentage: 5 } })
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

    // ================================================================== N. login rate limits (run last: they lock logins)
    {
      const ip = '192.0.2.50'
      const codes: number[] = []
      for (let i = 0; i < 5; i++) codes.push((await call('POST', '/api/auth/login', { ip, body: { passcode: `wrong-guess-${i}-xxxx` } })).status)
      check(codes.every((c) => c === 401), '5 wrong passcodes from one IP are answered 401')
      const locked = await call('POST', '/api/auth/login', { ip, body: { passcode: PASS.manager1 } })
      check(locked.status === 429 && Number(locked.headers.get('retry-after')) > 0, 'the 6th attempt from that IP is locked out (429 + Retry-After) even with a CORRECT passcode')
      check(locked.cookies.length === 0, 'a locked-out attempt never sets a cookie')
      const other = await call('POST', '/api/auth/login', { ip: '192.0.2.51', body: { passcode: PASS.manager1 } })
      check(other.status === 200, 'a different IP can still sign in')
      check((await one(`SELECT count(*)::int n FROM login_attempts WHERE bucket = 'login' AND ip = $1 AND success = false`, [ip])).n === 5, 'failed attempts are recorded in login_attempts (database-backed)')
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
