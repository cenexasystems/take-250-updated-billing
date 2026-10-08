/**
 * DANGER: drops everything in the public schema of DATABASE_URL, then re-applies the migrations.
 * For fresh/dev databases only. Requires --yes.
 *   npm run db:reset -- --yes
 */
import './admin-env'
import { spawnSync } from 'node:child_process'
import { getPool } from '../server/lib/db'

async function main() {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') {
    console.error('Refusing to reset: NODE_ENV/VERCEL_ENV is production.')
    process.exitCode = 1
    return
  }
  if (!process.argv.includes('--yes')) {
    console.error('Refusing to reset: pass --yes to confirm (this deletes ALL data in the public schema).')
    process.exitCode = 1
    return
  }
  const pool = getPool()
  await pool.query('DROP SCHEMA public CASCADE')
  await pool.query('CREATE SCHEMA public')
  await pool.end()
  console.log('public schema recreated')
  const r = spawnSync('npx', ['tsx', 'scripts/migrate.ts'], { stdio: 'inherit', shell: true })
  process.exitCode = r.status ?? 1
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'Reset failed')
  process.exitCode = 1
})
