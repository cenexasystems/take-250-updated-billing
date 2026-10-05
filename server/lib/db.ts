import pg from 'pg'

// bigint ids / counts come back as JS numbers (what the original client returned); all ids here are far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v))
// numeric columns (prices, totals, stock) too: the screens do arithmetic on them and the original client received numbers
pg.types.setTypeParser(1700, (v) => Number(v))

// Server-only. DATABASE_URL must never be exposed to the browser (no VITE_ prefix) or written to logs.
let pool: pg.Pool | null = null

export function getPool(): pg.Pool {
  if (pool) return pool
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set')
  }
  // Neon's pooled endpoint multiplexes connections, so keep each serverless instance small.
  pool = new pg.Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000, keepAlive: true, keepAliveInitialDelayMillis: 10_000 })
  return pool
}

export const query = <T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) =>
  getPool().query<T>(text, params)

/** What the API handlers talk to. Only parameterized queries go through it. */
export interface Db {
  query<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>
  /** Runs fn in one transaction (committed on success, rolled back on throw). */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>
}

export function poolDb(): Db {
  const make = (run: (text: string, params?: unknown[]) => Promise<pg.QueryResult<any>>): Db => ({
    query: (text, params) => run(text, params) as any,
    tx: async (fn) => {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        const r = await fn(make((t, p) => client.query(t, p as any[])))
        await client.query('COMMIT')
        return r
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw e
      } finally {
        client.release()
      }
    },
  })
  return make((t, p) => getPool().query(t, p as any[]))
}

/** Test helper: every statement runs on ONE client (already inside BEGIN); tx() becomes a savepoint,
 * so the whole API test run can be rolled back. */
export function singleClientDb(client: pg.PoolClient): Db {
  let n = 0
  const db: Db = {
    query: (text, params) => client.query(text, params as any[]) as any,
    tx: async (fn) => {
      const name = `api_sp_${n++}`
      await client.query(`SAVEPOINT ${name}`)
      try {
        const r = await fn(db)
        await client.query(`RELEASE SAVEPOINT ${name}`)
        return r
      } catch (e) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`)
        throw e
      }
    },
  }
  return db
}
