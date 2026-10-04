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
  loginFailuresPerIp: { max: 5, windowMs: 15 * 60_000 },
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
