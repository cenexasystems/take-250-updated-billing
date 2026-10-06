/**
 * Restores a clean DEV state without touching the schema or the real passcodes:
 *   - deletes leftovers of interrupted test runs (the "E2E ..." rows the browser test creates, old login attempts)
 *   - puts every branch's invoice and barcode counters back to "highest number used in the data"
 *
 *   npm run db:reset-dev -- --yes            clean leftovers + repair counters (safe, keeps real data)
 *   npm run db:reset-dev -- --yes --hard     ALSO drops the public schema, re-runs db:migrate and db:seed (everything is lost)
 *
 * Development / preview databases only: it refuses to run when NODE_ENV or VERCEL_ENV says production.
 */
import './test-env' // DATABASE_URL -> Neon's direct endpoint (short admin task, no pooler needed)
import { spawnSync } from 'node:child_process'
import { getPool } from '../server/lib/db'
import { repairSequences } from './lib/devState'

const maskedTarget = () => {
  try {
    const u = new URL(process.env.DATABASE_URL || '')
    return `${u.hostname}${u.pathname}` // host + database name only: never the user, password or query string
  } catch { return '(DATABASE_URL is not set or not a URL)' }
}

async function main() {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') {
    console.error('Refusing to run: NODE_ENV/VERCEL_ENV is production.')
    process.exitCode = 1
    return
  }
  if (!process.argv.includes('--yes')) {
    console.error(`Refusing to run without --yes. Target database: ${maskedTarget()}`)
    process.exitCode = 1
    return
  }
  console.log(`Target: ${maskedTarget()}`)

  if (process.argv.includes('--hard')) {
    const run = (script: string) => spawnSync('npx', ['tsx', script, ...(script.includes('db-reset') ? ['--yes'] : [])], { stdio: 'inherit', shell: true }).status ?? 1
    if (run('scripts/db-reset.ts') !== 0 || run('scripts/seed-passcodes.ts') !== 0) { process.exitCode = 1; return }
    console.log('hard reset done: schema re-created, migrations applied, passcodes seeded')
    return
  }

  const pool = getPool()
  try {
    const cleanups: Array<[string, string]> = [
      ['barcode_registry (E2E)', `DELETE FROM barcode_registry WHERE product_id IN (SELECT id FROM products WHERE name LIKE 'E2E %')`],
      ['inventory_movements (E2E)', `DELETE FROM inventory_movements WHERE product_id IN (SELECT id FROM products WHERE name LIKE 'E2E %')`],
      ['products (E2E)', `DELETE FROM products WHERE name LIKE 'E2E %'`],
      ['categories (E2E)', `DELETE FROM categories WHERE name_en = 'E2E'`],
      ['orders (E2E)', `DELETE FROM orders WHERE customer_name LIKE 'E2E %'`],
      ['advance_orders (E2E)', `DELETE FROM advance_orders WHERE customer_name LIKE 'E2E %'`],
      ['expenses (E2E)', `DELETE FROM expenses WHERE description LIKE 'E2E %'`],
      ['login_attempts (rate-limit counters)', `DELETE FROM login_attempts`],
    ]
    for (const [label, sql] of cleanups) {
      try { console.log(`${String((await pool.query(sql)).rowCount ?? 0).padStart(5)}  removed from ${label}`) }
      catch (e) { console.log(`    -  ${label}: ${(e as Error).message.split('\n')[0]}`) }
    }
    const fixed = await repairSequences(pool)
    console.log(fixed.length ? `counters repaired:\n  ${fixed.join('\n  ')}` : 'counters already correct')
    console.log('dev state is clean')
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'Reset failed')
  process.exitCode = 1
})
