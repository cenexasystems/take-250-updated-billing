import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { clearSessionCookie, setSessionCookie, signSession, targetLabel, type Role } from '../lib/auth.js'
import { ApiError } from '../lib/errors.js'
import { validatePasscodeStrength } from '../lib/passcodePolicy.js'
import { route } from '../lib/route.js'
import { enforce, LIMITS, loginDelayMs, record } from '../lib/rateLimit.js'

const BCRYPT_COST = 10

interface PasscodeRow { role: Role; branch_id: string | null; passcode_hash: string; token_version: number }

async function loadPasscodes(db: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> }): Promise<PasscodeRow[]> {
  // A manager / staff passcode of a deactivated branch can no longer sign in.
  const r = await db.query(
    `SELECT p.role, p.branch_id, p.passcode_hash, p.token_version FROM public.passcodes p
     LEFT JOIN public.branches b ON b.id = p.branch_id
     WHERE p.branch_id IS NULL OR b.is_active ORDER BY p.id`
  )
  return r.rows
}

export const authRoutes = [
  route({
    method: 'post', path: '/api/auth/login', perm: 'auth.login',
    body: z.object({ passcode: z.string().min(1).max(200) }).strict(),
    async handler({ db, body, ip, res }) {
      await enforce(db, 'login', ip, { ip: LIMITS.loginFailuresPerIp }, true)
      // system-wide slowdown (never a block): many failures anywhere make every attempt slower, real users still get in
      const delay = await loginDelayMs(db)
      if (delay > 0) await new Promise((r) => setTimeout(r, delay))
      const rows = await loadPasscodes(db)
      // Compare against EVERY stored hash (no early exit) so timing does not reveal which role matched.
      const matches = await Promise.all(rows.map((r) => bcrypt.compare(body.passcode, r.passcode_hash)))
      const hit = rows.filter((_, i) => matches[i])
      if (hit.length !== 1) {
        await record(db, 'login', ip, false)
        throw new ApiError(401, 'Invalid passcode')
      }
      const row = hit[0]
      await record(db, 'login', ip, true, targetLabel({ role: row.role, branch: row.branch_id }))
      setSessionCookie(res, signSession({ role: row.role, branch: row.branch_id, tv: row.token_version, sid: randomUUID() }))
      return { role: row.role, branch: row.branch_id }
    },
  }),

  route({
    method: 'post', path: '/api/auth/logout', perm: 'auth.logout',
    async handler({ res }) {
      clearSessionCookie(res)
      return { ok: true }
    },
  }),

  route({
    method: 'get', path: '/api/auth/me', perm: 'auth.me',
    async handler({ db, session }) {
      const s = session!
      const branches = await db.query(
        `SELECT id, name, short_label, subtitle, theme_color, logo_url, barcode_prefix, sort_order FROM public.branches
         WHERE is_active AND ($1::text IS NULL OR id = $1) ORDER BY sort_order, id`, [s.branch])
      return { role: s.role, branch: s.branch, branches: branches.rows }
    },
  }),

  route({
    method: 'get', path: '/api/branches', perm: 'branches.read',
    async handler({ db, session }) {
      const r = await db.query(
        `SELECT id, name, short_label, subtitle, theme_color, logo_url, barcode_prefix, sort_order FROM public.branches
         WHERE is_active AND ($1::text IS NULL OR id = $1) ORDER BY sort_order, id`, [session!.branch])
      return { branches: r.rows }
    },
  }),

  // ---- Admin only: passcode management ----
  route({
    method: 'get', path: '/api/admin/passcodes', perm: 'passcodes.list',
    async handler({ db }) {
      const r = await db.query(`SELECT role, branch_id AS target_branch, updated_at FROM public.passcodes ORDER BY role, branch_id NULLS FIRST`)
      return { passcodes: r.rows }
    },
  }),

  route({
    method: 'put', path: '/api/admin/passcodes', perm: 'passcodes.change',
    body: z.object({
      target_role: z.enum(['admin', 'manager', 'staff']),
      // the passcode being changed; this is NOT a request scope, so it is not named branch_id
      target_branch: z.string().regex(/^[a-z0-9_]{2,32}$/).nullish(),
      new_passcode: z.string().min(1).max(200),
      current_admin_passcode: z.string().min(1).max(200),
    }).strict(),
    async handler({ db, body, session, ip, res }) {
      const actor = targetLabel(session!)
      await enforce(db, 'passcode_change', ip, { ip: LIMITS.passcodeChangeFailures, target: { ...LIMITS.passcodeChangeFailures, key: actor } }, true)

      const rows = await loadPasscodes(db)
      const adminRow = rows.find((r) => r.role === 'admin')
      const okCurrent = adminRow ? await bcrypt.compare(body.current_admin_passcode, adminRow.passcode_hash) : false
      if (!okCurrent) {
        await record(db, 'passcode_change', ip, false, actor)
        throw new ApiError(403, 'Current admin passcode is incorrect')
      }

      const targetBranch = body.target_role === 'admin' ? null : body.target_branch ?? null
      if (body.target_role !== 'admin' && !targetBranch) throw new ApiError(400, 'target_branch is required for manager and staff')
      if (body.target_role === 'admin' && body.target_branch) throw new ApiError(400, 'The admin passcode has no branch')
      const target = rows.find((r) => r.role === body.target_role && r.branch_id === targetBranch)
      if (!target) throw new ApiError(404, 'No such passcode')

      const weak = validatePasscodeStrength(body.new_passcode)
      if (weak) throw new ApiError(400, weak)

      // unique across ALL 7 passcodes (including the one being replaced)
      const same = await Promise.all(rows.map((r) => bcrypt.compare(body.new_passcode, r.passcode_hash)))
      if (same.some(Boolean)) throw new ApiError(409, 'That passcode is not available. Choose a different one.')

      const hash = await bcrypt.hash(body.new_passcode, BCRYPT_COST)
      const upd = await db.query<{ token_version: number }>(
        `UPDATE public.passcodes SET passcode_hash = $1, token_version = token_version + 1, updated_at = now()
         WHERE role = $2 AND branch_id IS NOT DISTINCT FROM $3 RETURNING token_version`,
        [hash, body.target_role, targetBranch])
      await record(db, 'passcode_change', ip, true, actor)

      // Every older session of the changed role/branch is now invalid. The admin changing their OWN passcode keeps working.
      if (body.target_role === 'admin') setSessionCookie(res, signSession({ role: 'admin', branch: null, tv: upd.rows[0].token_version, sid: session!.sid }))
      return { ok: true, role: body.target_role, target_branch: targetBranch }
    },
  }),
]
