import type { Db } from './db.js'
import { notFound } from './errors.js'

const IDENT = /^[a-z][a-z0-9_]*$/

/** Column names come from strict zod schemas (a fixed whitelist), never from raw client keys; this is a
 * second guard so a bad schema can't turn into SQL injection. Values are always bound parameters. */
function cols(data: Record<string, unknown>, jsonCols: readonly string[]) {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined)
  for (const k of keys) if (!IDENT.test(k)) throw new Error('bad column name')
  const vals = keys.map((k) => (jsonCols.includes(k) && data[k] !== null ? JSON.stringify(data[k]) : data[k]))
  return { keys, vals }
}

export async function insertRow(db: Db, table: string, branch: string, data: Record<string, unknown>, jsonCols: readonly string[] = []) {
  if (!IDENT.test(table)) throw new Error('bad table name')
  const { keys, vals } = cols(data, jsonCols)
  const names = [...keys, 'branch_id']
  const params = [...vals, branch]
  const sql = `INSERT INTO public.${table} (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`
  return (await db.query(sql, params)).rows[0]
}

/** UPDATE ... WHERE id AND branch_id: a row of another branch simply is not found. */
export async function updateRow(db: Db, table: string, id: string | number, branch: string, data: Record<string, unknown>, jsonCols: readonly string[] = [], touch = true) {
  if (!IDENT.test(table)) throw new Error('bad table name')
  const { keys, vals } = cols(data, jsonCols)
  const sets = keys.map((k, i) => `"${k}" = $${i + 1}`)
  if (touch) sets.push('updated_at = now()')
  if (!sets.length) {
    const r = await db.query(`SELECT * FROM public.${table} WHERE id = $1 AND branch_id = $2`, [id, branch])
    if (!r.rows[0]) throw notFound()
    return r.rows[0]
  }
  const sql = `UPDATE public.${table} SET ${sets.join(', ')} WHERE id = $${keys.length + 1} AND branch_id = $${keys.length + 2} RETURNING *`
  const r = await db.query(sql, [...vals, id, branch])
  if (!r.rows[0]) throw notFound()
  return r.rows[0]
}
