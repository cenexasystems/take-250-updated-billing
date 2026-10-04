import jwt from 'jsonwebtoken'
import type { Request, Response } from 'express'
import type { Db } from './db.js'

export type Role = 'admin' | 'manager' | 'staff'
export const ROLES: Role[] = ['admin', 'manager', 'staff']

export interface Session {
  role: Role
  /** null for the admin (all branches); the locked branch for manager / staff. */
  branch: string | null
  tv: number
}

export const COOKIE_NAME = 'yg_session'
export const SESSION_TTL_SECONDS = 8 * 60 * 60 // short-lived: one working day at most

export function jwtSecret(): string {
  const s = process.env.JWT_SECRET
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be set (at least 32 characters)')
  return s
}

export function signSession(s: Session): string {
  return jwt.sign({ role: s.role, branch: s.branch, tv: s.tv }, jwtSecret(), { algorithm: 'HS256', expiresIn: SESSION_TTL_SECONDS })
}

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}

function cookieFlags(): string {
  // Secure everywhere except explicit local http development / tests.
  const secure = process.env.COOKIE_INSECURE === '1' ? '' : '; Secure'
  return `; Path=/; HttpOnly; SameSite=Strict${secure}`
}

export function setSessionCookie(res: Response, token: string) {
  res.append('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}${cookieFlags()}; Max-Age=${SESSION_TTL_SECONDS}`)
}

export function clearSessionCookie(res: Response) {
  res.append('Set-Cookie', `${COOKIE_NAME}=${cookieFlags()}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`)
}

/** Verifies the JWT AND that its token_version still matches the passcode row (so a passcode change
 * or role reset invalidates every older session of that role/branch). Returns null for anything wrong. */
export async function authenticate(req: Request, db: Db): Promise<Session | null> {
  const token = readCookie(req, COOKIE_NAME)
  if (!token) return null
  let payload: jwt.JwtPayload
  try {
    const p = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] })
    if (typeof p === 'string') return null
    payload = p
  } catch {
    return null
  }
  const role = payload.role
  const branch = payload.branch ?? null
  const tv = payload.tv
  if (!ROLES.includes(role) || !Number.isInteger(tv)) return null
  if ((role === 'admin') !== (branch === null)) return null
  const r = await db.query<{ token_version: number }>(
    `SELECT p.token_version FROM public.passcodes p
     WHERE p.role = $1 AND p.branch_id IS NOT DISTINCT FROM $2
       AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM public.branches b WHERE b.id = p.branch_id AND b.is_active))`,
    [role, branch]
  )
  if (r.rows.length !== 1 || r.rows[0].token_version !== tv) return null
  return { role, branch, tv }
}

export function targetLabel(s: { role: Role; branch: string | null }) {
  return `${s.role}:${s.branch ?? 'all'}`
}

/** Display name stored in created_by_name columns. Taken from the token, never from the client. */
export function actorName(s: Session): string {
  return s.role === 'admin' ? 'Admin' : s.role === 'manager' ? 'Manager' : 'Staff'
}
