/**
 * Seeds the 7 passcodes (bcrypt-hashed) from environment variables.
 *   npm run db:seed            -> inserts missing passcodes, leaves existing ones untouched
 *   npm run db:seed -- --force -> overwrites all 7 (e.g. emergency reset)
 *
 * Passcodes are never logged. The script aborts without writing anything if any value is
 * missing, too weak (< 8 chars etc.) or duplicated by another role/branch.
 */
import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { getPool } from '../server/lib/db'
import { validatePasscodeStrength } from '../server/lib/passcodePolicy'

const BCRYPT_COST = 10

type Entry = { envKey: string; role: 'admin' | 'manager' | 'staff'; branchId: string | null }

const ENTRIES: Entry[] = [
  { envKey: 'SEED_PASSCODE_ADMIN', role: 'admin', branchId: null },
  ...[1, 2, 3].flatMap((n): Entry[] => [
    { envKey: `SEED_PASSCODE_MANAGER_BRANCH${n}`, role: 'manager', branchId: `pos${n}` },
    { envKey: `SEED_PASSCODE_STAFF_BRANCH${n}`, role: 'staff', branchId: `pos${n}` },
  ]),
]

async function main() {
  const force = process.argv.includes('--force')
  const problems: string[] = []
  const values = new Map<string, string>()

  for (const e of ENTRIES) {
    const value = process.env[e.envKey]
    if (value === undefined || value === '') {
      problems.push(`${e.envKey}: not set`)
      continue
    }
    const weak = validatePasscodeStrength(value)
    if (weak) problems.push(`${e.envKey}: ${weak}`)
    values.set(e.envKey, value)
  }
  const seen = new Map<string, string>()
  for (const [key, value] of values) {
    const other = seen.get(value)
    if (other) problems.push(`${key}: duplicates ${other} (passcodes must be unique)`)
    else seen.set(value, key)
  }
  if (problems.length) {
    console.error('Seed aborted, nothing was written:')
    problems.forEach((p) => console.error(`  - ${p}`))
    process.exitCode = 1
    return
  }

  const pool = getPool()
  const existing = await pool.query<{ role: string; branch_id: string | null }>('SELECT role, branch_id FROM public.passcodes')
  const has = (e: Entry) => existing.rows.some((r) => r.role === e.role && r.branch_id === e.branchId)

  for (const e of ENTRIES) {
    if (has(e) && !force) {
      console.log(`keep   ${e.role}${e.branchId ? ` / ${e.branchId}` : ''} (already set)`)
      continue
    }
    const hash = await bcrypt.hash(values.get(e.envKey)!, BCRYPT_COST)
    if (has(e)) {
      await pool.query(
        'UPDATE public.passcodes SET passcode_hash = $1, updated_at = now() WHERE role = $2 AND branch_id IS NOT DISTINCT FROM $3',
        [hash, e.role, e.branchId]
      )
    } else {
      await pool.query('INSERT INTO public.passcodes (role, branch_id, passcode_hash) VALUES ($1, $2, $3)', [e.role, e.branchId, hash])
    }
    console.log(`set    ${e.role}${e.branchId ? ` / ${e.branchId}` : ''}`)
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : 'Seed failed')
    process.exitCode = 1
  })
  .finally(() => getPool().end())
