import { useAdminAuthStore } from '../store/store'

/** Thin client for the /api backend. The session is an httpOnly cookie, so nothing here ever sees a token.
 * The client NEVER names a branch for staff / manager (the server takes it from the cookie). Only the admin
 * selects a branch, via ?branch_id=, and only on routes that are branch-scoped. */
export class ApiClientError extends Error {
  status: number
  /** seconds until a 429 lockout ends (sign-in screen countdown) */
  retryAfter?: number
  constructor(status: number, message: string, retryAfter?: number) {
    super(message)
    this.status = status
    this.retryAfter = retryAfter
  }
}

type Query = Record<string, string | number | boolean | null | undefined>

// routes that are not branch-scoped: never send a branch selector to them
const NO_BRANCH_PREFIXES = ['/api/auth', '/api/branches', '/api/admin', '/api/global', '/api/public']

function withQuery(path: string, query?: Query): string {
  if (!query) return path
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const qs = p.toString()
  return qs ? `${path}?${qs}` : path
}

export async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, opts: { body?: unknown; query?: Query; raw?: { data: Blob | ArrayBuffer; type: string }; branchId?: string | null } = {}): Promise<T> {
  const { role, activeBranch } = useAdminAuthStore.getState()
  const query: Query = { ...(opts.query ?? {}) }
  // Only the ADMIN ever names a branch (to select which one to work in). `opts.branchId` lets an admin screen that
  // works on a specific branch say so; for staff and manager it is ignored, and the server uses the cookie's branch.
  if (role === 'admin' && !NO_BRANCH_PREFIXES.some((p) => path.startsWith(p))) {
    const selected = opts.branchId ?? (activeBranch && activeBranch !== 'all' ? activeBranch : null)
    if (selected) query.branch_id = selected
  }
  const headers: Record<string, string> = {}
  let body: BodyInit | undefined
  if (opts.raw) { headers['Content-Type'] = opts.raw.type; body = opts.raw.data as BodyInit }
  else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body) }

  const res = await fetch(withQuery(path, query), { method, headers, body, credentials: 'same-origin' })
  let json: unknown = null
  try { json = await res.json() } catch { /* empty body */ }
  if (!res.ok) {
    const message = (json as { error?: string } | null)?.error || `Request failed (${res.status})`
    // an expired / replaced session ends the local session too (not for the login call itself)
    if (res.status === 401 && path !== '/api/auth/login') useAdminAuthStore.getState().expireSession()
    const retry = Number((json as { retry_after?: number } | null)?.retry_after)
    throw new ApiClientError(res.status, message, Number.isFinite(retry) && retry > 0 ? retry : undefined)
  }
  return json as T
}
