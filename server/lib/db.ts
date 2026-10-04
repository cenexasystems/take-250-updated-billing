import pg from 'pg'

// Server-only. DATABASE_URL must never be exposed to the browser (no VITE_ prefix).
let pool: pg.Pool | null = null

export function getPool(): pg.Pool {
  if (pool) return pool
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set')
  }
  // Neon's pooled endpoint multiplexes connections, so keep each serverless instance small.
  pool = new pg.Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000 })
  return pool
}

export const query = <T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) =>
  getPool().query<T>(text, params)
