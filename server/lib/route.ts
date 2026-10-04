import type { Express, Request, Response, NextFunction } from 'express'
import type { ZodTypeAny, z } from 'zod'
import { authenticate, type Session } from './auth.js'
import type { Db } from './db.js'
import { ApiError, logServerError, mapDbError } from './errors.js'
import { permOf, type PermKey } from './permissions.js'
import { clientIp } from './rateLimit.js'

export interface Deps {
  db: Db
  /** Vercel Blob upload; injectable so tests never touch the network. */
  blobPut: (pathname: string, body: Buffer, opts: { contentType: string }) => Promise<{ url: string }>
}

export interface Ctx<B = any, Q = any> {
  req: Request
  res: Response
  db: Db
  deps: Deps
  session: Session | null
  /** The ONE branch this request may touch (null for global / none scope). Never read from the client
   * for manager/staff; for admin it is the validated ?branch_id= selector. */
  branch: string | null
  body: B
  query: Q
  params: Record<string, string>
  ip: string
}

export interface Route<B extends ZodTypeAny = ZodTypeAny, Q extends ZodTypeAny = ZodTypeAny> {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete'
  path: string
  perm: PermKey
  body?: B
  query?: Q
  status?: number
  /** Skip JSON body parsing (binary uploads). */
  raw?: boolean
  handler: (ctx: Ctx<z.infer<B>, z.infer<Q>>) => Promise<unknown>
}

export function route<B extends ZodTypeAny = ZodTypeAny, Q extends ZodTypeAny = ZodTypeAny>(r: Route<B, Q>): Route<any, any> {
  return r as unknown as Route<any, any>
}

const BRANCH_KEY = /^(branch|branch[_-]?id|branchid|x-branch(-id)?|target[_-]?branch[_-]?id)$/i

/** Finds any key that tries to name a branch, at any depth. */
function findBranchKey(v: unknown, depth = 0): string | null {
  if (depth > 8 || v === null || typeof v !== 'object' || Buffer.isBuffer(v)) return null
  if (Array.isArray(v)) {
    for (const x of v) { const k = findBranchKey(x, depth + 1); if (k) return k }
    return null
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (BRANCH_KEY.test(k)) return k
    const inner = findBranchKey(val, depth + 1)
    if (inner) return inner
  }
  return null
}

const BRANCH_HEADERS = ['x-branch', 'x-branch-id', 'x-branchid', 'branch', 'branch-id', 'x-pos-branch']

export function registerRoutes(app: Express, routes: Route<any, any>[], deps: Deps) {
  const seen = new Set<string>()
  for (const r of routes) {
    const spec = permOf(r.perm)
    if (!spec) throw new Error(`Route ${r.method} ${r.path} has no entry in the permission table (default deny)`)
    const sig = `${r.method} ${r.path}`
    if (seen.has(sig)) throw new Error(`Duplicate route ${sig}`)
    seen.add(sig)

    const wrapped = async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const ip = clientIp(req)
        let session: Session | null = null
        if (spec.roles !== 'public') {
          session = await authenticate(req, deps.db)
          if (!session) throw new ApiError(401, 'Not signed in')
          if (!spec.roles.includes(session.role)) throw new ApiError(403, 'Forbidden')
        }

        // ---- branch isolation: the client never chooses a branch ----
        const isAdmin = session?.role === 'admin'
        let selector: string | null = null
        for (const h of BRANCH_HEADERS) {
          if (req.headers[h] !== undefined) throw new ApiError(400, 'Branch headers are not accepted')
        }
        const q = (req.query ?? {}) as Record<string, unknown>
        for (const k of Object.keys(q)) {
          if (BRANCH_KEY.test(k)) {
            // the ONLY allowed use: an admin selecting which branch to work in
            if (isAdmin && k === 'branch_id' && spec.scope === 'branch' && typeof q[k] === 'string') selector = q[k] as string
            else throw new ApiError(400, 'branch_id is not accepted here')
          }
        }
        if (findBranchKey(req.body)) throw new ApiError(400, 'branch_id is not accepted in the request body')

        let branch: string | null = null
        if (spec.scope === 'branch') {
          if (!session) throw new ApiError(401, 'Not signed in')
          if (isAdmin) {
            if (!selector) throw new ApiError(400, 'Select a branch (branch_id)')
            const ok = await deps.db.query('SELECT 1 FROM public.branches WHERE id = $1 AND is_active', [selector])
            if (ok.rows.length !== 1) throw new ApiError(400, 'Unknown branch')
            branch = selector
          } else {
            branch = session.branch
          }
        }

        // ---- validation (strict schemas: unknown keys are rejected) ----
        const body = r.body ? parseOr400(r.body, req.body ?? {}) : undefined
        const { branch_id: _drop, ...restQuery } = q
        const query = r.query ? parseOr400(r.query, restQuery) : restQuery

        const out = await r.handler({ req, res, db: deps.db, deps, session, branch, body, query, params: req.params as Record<string, string>, ip })
        if (res.headersSent) return
        res.status(r.status ?? 200).json(out === undefined ? { ok: true } : out)
      } catch (err) {
        if (res.headersSent) return
        const api = err instanceof ApiError ? err : mapDbError(err)
        if (api) {
          if (api.extra?.retryAfter) res.setHeader('Retry-After', String(api.extra.retryAfter))
          res.status(api.status).json({ error: api.message })
          return
        }
        logServerError(`${r.method.toUpperCase()} ${r.path}`, err)
        res.status(500).json({ error: 'Server error' })
      }
    }
    app[r.method](r.path, wrapped)
  }
}

function parseOr400<T extends ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const res = schema.safeParse(input)
  if (!res.success) {
    // paths + messages only: never echo submitted values (they may be passcodes)
    throw new ApiError(400, `Invalid request: ${res.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`)
  }
  return res.data
}
