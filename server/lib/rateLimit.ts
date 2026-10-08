import type { Request } from 'express'
import type { Db } from './db.js'
import { ApiError } from './errors.js'

export type Bucket = 'login' | 'passcode_change' | 'invoice'

/** Client IP. Forwarded headers are only trusted on Vercel (platform-set) or when TRUST_PROXY=1. */
export function clientIp(req: Request): string {
  const trusted = process.env.VERCEL === '1' || process.env.TRUST_PROXY === '1'
  if (trusted) {
    const xff = (req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for']) as string | undefined
    const first = xff?.split(',')[0]?.trim()
    if (first) return first.slice(0, 64)
  }
  return (req.socket.remoteAddress || 'unknown').slice(0, 64)
}

interface Limit { ip?: { max: number; windowMs: number }; target?: { max: number; windowMs: number; key: string }; global?: { max: number; windowMs: number } }

export const LIMITS = {
  // Sign-in lockout. The counter is keyed on IP + the portal picked on the login screen (role + branch), so a staff
  // member typing a wrong passcode does not lock the manager at the same shop (shared Wi-Fi / 4G = one public IP).
  // A second, wider guard per IP (all portals together) stops a client from dodging the per-portal limit by changing
  // the selection, which the client controls. A lockout lasts lockMs from the LAST counted failure (attempts made while
  // locked are refused without being counted, so it never extends itself) and then the counter is reset.
  loginPerPortal: { max: 10, windowMs: 10 * 60_000 },
  loginPerIp: { max: 30, windowMs: 10 * 60_000 },
  loginLockMs: 5 * 60_000,
  // Distributed guessing guard: passcodes carry no username, so a per-account lockout is not possible at login.
  // It is a SLOWDOWN, never a block, so an attacker cannot lock every real user out: once the whole system has
  // seen `freeFailures` failed logins in the window, every login attempt waits stepMs more per extra failure (up to maxMs).
  loginSlowdown: { freeFailures: 10, windowMs: 15 * 60_000 },
  passcodeChangeFailures: { max: 5, windowMs: 15 * 60_000 },
  invoiceLookupsPerIp: { max: 30, windowMs: 10 * 60_000 },
}

async function recentCount(db: Db, bucket: Bucket, windowMs: number, where: { ip?: string; target?: string }, failuresOnly: boolean) {
  const params: unknown[] = [bucket, windowMs / 1000]
  let sql = `SELECT count(*)::int AS n, EXTRACT(EPOCH FROM (min(attempted_at) + ($2 || ' seconds')::interval - now()))::int AS retry
             FROM public.login_attempts WHERE bucket = $1 AND attempted_at > now() - ($2 || ' seconds')::interval`
  if (failuresOnly) sql += ' AND success = false'
  if (where.ip !== undefined) { params.push(where.ip); sql += ` AND ip = $${params.length}` }
  if (where.target !== undefined) { params.push(where.target); sql += ` AND target = $${params.length}` }
  const r = await db.query<{ n: number; retry: number | null }>(sql, params)
  return { n: r.rows[0].n, retry: Math.max(1, r.rows[0].retry ?? 1) }
}

/** Throws 429 when any configured limit is already reached. Counts failures only (login, passcode change)
 * or every call (invoice, where failuresOnly = false). */
export async function enforce(db: Db, bucket: Bucket, ip: string, limit: Limit, failuresOnly: boolean) {
  const checks: Array<Promise<{ n: number; retry: number; max: number }>> = []
  if (limit.ip) checks.push(recentCount(db, bucket, limit.ip.windowMs, { ip }, failuresOnly).then((r) => ({ ...r, max: limit.ip!.max })))
  if (limit.target) checks.push(recentCount(db, bucket, limit.target.windowMs, { target: limit.target.key }, failuresOnly).then((r) => ({ ...r, max: limit.target!.max })))
  if (limit.global) checks.push(recentCount(db, bucket, limit.global.windowMs, {}, failuresOnly).then((r) => ({ ...r, max: limit.global!.max })))
  const results = await Promise.all(checks)
  const hit = results.find((r) => r.n >= r.max)
  if (hit) throw new ApiError(429, 'Too many attempts. Please try again later.', { retryAfter: hit.retry })
}

export async function record(db: Db, bucket: Bucket, ip: string, success: boolean, target = '') {
  await db.query('INSERT INTO public.login_attempts (ip, success, bucket, target) VALUES ($1, $2, $3, $4)', [ip, success, bucket, target])
  // keep the table small: drop anything older than a day (cheap, indexed)
  if (Math.random() < 0.02) await db.query(`DELETE FROM public.login_attempts WHERE attempted_at < now() - interval '1 day'`)
}

/** Pure: how long a login attempt is delayed when the system saw `failures` failed logins in the window. */
export function slowdownMs(failures: number): number {
  const step = Number(process.env.LOGIN_SLOWDOWN_STEP_MS ?? 200)
  const max = Number(process.env.LOGIN_SLOWDOWN_MAX_MS ?? 4000)
  return Math.min(max, Math.max(0, failures - LIMITS.loginSlowdown.freeFailures + 1) * step)
}

/** Delay to apply to the current login attempt, from the global failure count (database-backed). */
export async function loginDelayMs(db: Db): Promise<number> {
  const r = await recentCount(db, 'login', LIMITS.loginSlowdown.windowMs, {}, true)
  return slowdownMs(r.n)
}

// ---------------------------------------------------------------- sign-in lockout (database-backed, shared by every serverless instance)

/** Counter key: the portal chosen on the login screen ("staff:pos1", "manager:pos3", "admin", or "any" when none was
 *  sent, as the current login screen does) plus the device id. */
export function loginKey(as?: string | null, site?: string | null, device?: string | null): string {
  const portal = !as ? 'any' : as === 'admin' ? 'admin' : `${as}:${site ?? '?'}`
  // + this browser's random device id: phones sharing one public IP (4G, shop Wi-Fi) are counted separately
  return device ? `${portal}|${device}` : portal
}

/** Throws 429 {retryAfter} while this IP (+ portal) is locked out. An expired lockout is cleared here, so the counter starts again from zero. */
export async function enforceLogin(db: Db, ip: string, key: string) {
  const scopes: Array<{ max: number; target: string | null }> = [
    { max: LIMITS.loginPerPortal.max, target: key },
    { max: LIMITS.loginPerIp.max, target: null },
  ]
  const where = `bucket = 'login' AND success = false AND ip = $1 AND ($2::text IS NULL OR target = $2)`
  for (const sc of scopes) {
    const r = await db.query<{ n: number; remaining: number | null }>(
      `SELECT count(*) FILTER (WHERE attempted_at > now() - ($3::int * interval '1 millisecond'))::int AS n,
              EXTRACT(EPOCH FROM (max(attempted_at) + ($4::int * interval '1 millisecond') - now()))::float AS remaining
       FROM public.login_attempts WHERE ${where}`,
      [ip, sc.target, LIMITS.loginPerPortal.windowMs, LIMITS.loginLockMs])
    const { n, remaining } = r.rows[0]
    if (n < sc.max) continue
    if (remaining !== null && remaining > 0) throw new ApiError(429, 'Too many attempts', { retryAfter: Math.ceil(remaining) })
    // lockout over: forget these failures so the next window starts clean
    await db.query(`DELETE FROM public.login_attempts WHERE ${where}`, [ip, sc.target])
  }
}
export async function recordLoginFailure(db: Db, ip: string, key: string) {
  await record(db, 'login', ip, false, key)
}

/** A good sign-in on a selected portal resets that portal's counter for this IP (not the whole IP: see loginPerIp). */
export async function resetLoginFailures(db: Db, ip: string, key: string) {
  if (key.startsWith('any')) return // no selected portal: a guesser could otherwise reset its own counter with one known passcode
  await db.query(`DELETE FROM public.login_attempts WHERE bucket = 'login' AND success = false AND ip = $1 AND target = $2`, [ip, key])
}

/** Admin: forget sign-in failures, for one branch's portals (staff/manager of that branch) or for everything. */
export async function clearLoginLockouts(db: Db, site?: string): Promise<number> {
  const r = site
    ? await db.query(`DELETE FROM public.login_attempts WHERE bucket = 'login' AND success = false AND target LIKE $1`, [`%:${site}|%`])
    : await db.query(`DELETE FROM public.login_attempts WHERE bucket = 'login' AND success = false`)
  return r.rowCount ?? 0
}