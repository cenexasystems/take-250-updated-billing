/**
 * Shared dev-database hygiene for the test scripts and `npm run db:reset-dev`.
 *
 * Sequence values (setval/nextval) are NOT transactional: a test that rolls back its transaction still leaves the
 * counters moved, and a run that is killed before its `finally` leaves them wherever they were. Two layers:
 *   - snapshot/restore: every test takes a snapshot first and restores it in a `finally`
 *   - repair: derives the correct value of the invoice and barcode counters from the data itself, so even a
 *     hard-killed run (no `finally`) can be healed by the next run or by `npm run db:reset-dev`
 */
export interface Queryable { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> }

export type SequenceSnapshot = Map<string, string | null> // sequence -> last value, or null if never called

export async function snapshotSequences(db: Queryable): Promise<SequenceSnapshot> {
  const names = (await db.query(`SELECT sequencename AS n FROM pg_sequences WHERE schemaname = 'public'`)).rows.map((r) => r.n as string)
  const snap: SequenceSnapshot = new Map()
  for (const n of names) {
    const r = (await db.query(`SELECT last_value::text AS v, is_called FROM public."${n}"`)).rows[0]
    snap.set(n, r.is_called ? r.v : null)
  }
  return snap
}

export async function restoreSequences(db: Queryable, snap: SequenceSnapshot): Promise<void> {
  for (const [n, last] of snap) {
    try {
      if (last === null) await db.query(`SELECT setval('public."${n}"', (SELECT min_value FROM pg_sequences WHERE schemaname = 'public' AND sequencename = $1), false)`, [n])
      else await db.query(`SELECT setval('public."${n}"', $1::bigint, true)`, [last])
    } catch (e) {
      console.error(`could not restore sequence ${n}: ${(e as Error).message}`) // keep restoring the others
    }
  }
}

/** Puts each branch's invoice and barcode counters where the data says they are (next number = highest used + 1). */
export async function repairSequences(db: Queryable): Promise<string[]> {
  const fixed: string[] = []
  const branches = (await db.query(`SELECT id, invoice_start::text AS s, invoice_end::text AS e FROM public.branches ORDER BY id`)).rows
  const setTo = async (seq: string, usedMax: string | null) => {
    const cur = (await db.query(`SELECT last_value::text AS v, is_called, (SELECT min_value::text FROM pg_sequences WHERE schemaname='public' AND sequencename=$1) AS lo FROM public."${seq}"`, [seq])).rows[0]
    const want = usedMax // null = nothing used yet
    const have = cur.is_called ? cur.v : null
    if (want === have) return
    if (want === null) await db.query(`SELECT setval('public."${seq}"', $1::bigint, false)`, [cur.lo])
    else await db.query(`SELECT setval('public."${seq}"', $1::bigint, true)`, [want])
    fixed.push(`${seq}: ${have ?? 'unused'} -> ${want ?? 'unused'}`)
  }
  for (const b of branches) {
    const inv = (await db.query(
      `SELECT max(invoice_no::bigint)::text AS m FROM public.orders WHERE branch_id = $1 AND invoice_no ~ '^[0-9]{1,15}$' AND invoice_no::bigint BETWEEN $2::bigint AND $3::bigint`,
      [b.id, b.s, b.e])).rows[0].m as string | null
    await setTo(`invoice_number_seq_${b.id}`, inv)
    for (const [kind, letter] of [['product', 'P'], ['variant', 'V']] as const) {
      const bc = (await db.query(
        `SELECT max(substring(barcode_value from '^[A-Z0-9]{2}${letter}([0-9]{8})$')::bigint)::text AS m FROM public.barcode_registry WHERE branch_id = $1`,
        [b.id])).rows[0].m as string | null
      await setTo(`barcode_${kind}_seq_${b.id}`, bc)
    }
  }
  return fixed
}
