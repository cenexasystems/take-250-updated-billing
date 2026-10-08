/**
 * Applies db/migrations/*.sql to the database in DATABASE_URL, in filename order.
 * Already-applied files are tracked in public.schema_migrations and skipped.
 *   npm run db:migrate
 */
import './admin-env'
import fs from 'node:fs'
import path from 'node:path'
import { getPool } from '../server/lib/db'

const dir = path.resolve(process.cwd(), 'db/migrations')

async function main() {
  const pool = getPool()
  await pool.query(
    'CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
  )
  const done = new Set((await pool.query<{ name: string }>('SELECT name FROM public.schema_migrations')).rows.map((r) => r.name))
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    if (done.has(file)) {
      console.log(`skip  ${file}`)
      continue
    }
    const client = await pool.connect()
    try {
      // Each file carries its own BEGIN/COMMIT.
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8').replace(/^\uFEFF/, ''))
      await client.query('INSERT INTO public.schema_migrations (name) VALUES ($1)', [file])
      console.log(`apply ${file}`)
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      console.error(`FAILED ${file}: ${err instanceof Error ? err.message : 'unknown error'}`)
      process.exitCode = 1
      return
    } finally {
      client.release()
    }
  }
  console.log('Migrations complete.')
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : 'Migration failed')
    process.exitCode = 1
  })
  .finally(() => getPool().end())
