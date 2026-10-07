/**
 * Branch isolation test. Runs against DATABASE_URL inside ONE transaction that is rolled back,
 * and restores every sequence it advanced, so the database ends exactly as it started.
 *   npm run test:isolation
 *
 * Proves: same codes/names work in every branch, barcodes (generation, scan lookup, receive-stock) stay inside their branch, stock/invoices never mix, every cross-branch
 * reference is rejected by the database itself, and branch-scoped queries only see their branch.
 */
import './test-env'
import type { PoolClient } from 'pg'
import { getPool } from '../server/lib/db'
import { repairSequences, restoreSequences, snapshotSequences } from './lib/devState'

const BRANCHES = ['pos1', 'pos2', 'pos3'] as const
type B = (typeof BRANCHES)[number]

let passed = 0
let failed = 0
const results: string[] = []
const record = (ok: boolean, label: string, detail = '') => {
  ok ? passed++ : failed++
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}

async function run() {
  const pool = getPool()
  const c: PoolClient = await pool.connect()
  c.on('error', (e) => console.error('database connection error:', e.message)) // see test-api.ts
  let sp = 0

  const ok = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    const name = `sp${sp++}`
    await c.query(`SAVEPOINT ${name}`)
    try {
      const r = await fn()
      await c.query(`RELEASE SAVEPOINT ${name}`)
      record(true, label)
      return r
    } catch (e) {
      await c.query(`ROLLBACK TO SAVEPOINT ${name}`)
      record(false, label, (e as Error).message.split('\n')[0])
      return undefined
    }
  }
  // expects the database to REJECT the statement
  const rejected = async (label: string, fn: () => Promise<unknown>) => {
    const name = `sp${sp++}`
    await c.query(`SAVEPOINT ${name}`)
    try {
      await fn()
      await c.query(`ROLLBACK TO SAVEPOINT ${name}`)
      record(false, label, 'was ACCEPTED, should be rejected')
    } catch (e) {
      await c.query(`ROLLBACK TO SAVEPOINT ${name}`)
      record(true, label, `rejected: ${(e as Error).message.split('\n')[0].slice(0, 90)}`)
    }
  }
  const one = async <T = any>(sql: string, p: unknown[] = []): Promise<T> => (await c.query(sql, p)).rows[0] as T
  const all = async <T = any>(sql: string, p: unknown[] = []): Promise<T[]> => (await c.query(sql, p)).rows as T[]

  // -- sequences: setval/nextval are not transactional. Heal leftovers of an earlier killed run first, snapshot, and
  //    restore in the finally block (also on Ctrl+C / SIGTERM) so an interrupted run cannot leave counters moved.
  const healed = await repairSequences(pool)
  if (healed.length) console.warn('repaired counters left over from an earlier interrupted run:\n  ' + healed.join('\n  '))
  const seqSnapshot = await snapshotSequences(pool)
  let restored = false
  const restoreOnce = async () => { if (restored) return; restored = true; await restoreSequences(pool, seqSnapshot) }
  const onSignal = (sig: NodeJS.Signals) => { void restoreOnce().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143)) }
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal)
  const baseline = await one(`SELECT (SELECT count(*) FROM products)::int p, (SELECT count(*) FROM orders)::int o, (SELECT count(*) FROM categories)::int c, (SELECT count(*) FROM coupons)::int cp, (SELECT count(*) FROM branches)::int b`)

  await c.query('BEGIN')
  try {
    const branchRows = await all(`SELECT id, invoice_start, invoice_end FROM branches ORDER BY id`)
    const range = Object.fromEntries(branchRows.map((r) => [r.id, [Number(r.invoice_start), Number(r.invoice_end)]])) as Record<B, [number, number]>

    // ---------- 1. same codes / names in every branch ----------
    const productId = {} as Record<B, number>
    const categoryId = {} as Record<B, number>
    const couponId = {} as Record<B, number>
    for (const b of BRANCHES) {
      categoryId[b] = (await ok(`same category name "Test Cat" in ${b}`, async () => (await one(`INSERT INTO categories (name_en, branch_id) VALUES ('Test Cat', $1) RETURNING id`, [b])).id))!
      couponId[b] = (await ok(`same coupon code "SAVE10" in ${b}`, async () => (await one(`INSERT INTO coupons (code, percentage, branch_id) VALUES ('SAVE10', 10, $1) RETURNING id`, [b])).id))!
      productId[b] = (await ok(`same product name + SKU "TEST-001" in ${b}`, async () =>
        (await one(`INSERT INTO products (name, category, category_id, price, stock_quantity, stock, sku, branch_id, is_active) VALUES ('Test Product', 'Test Cat', $2, 100, 10, 10, 'TEST-001', $1, true) RETURNING id`, [b, categoryId[b]])).id))!
    }
    await rejected('duplicate category name inside ONE branch', () => c.query(`INSERT INTO categories (name_en, branch_id) VALUES ('test cat', 'pos1')`))
    await rejected('duplicate coupon code inside ONE branch', () => c.query(`INSERT INTO coupons (code, percentage, branch_id) VALUES (' save10 ', 10, 'pos1')`))
    await rejected('unknown branch_id', () => c.query(`INSERT INTO categories (name_en, branch_id) VALUES ('X', 'nope')`))

    // ---------- 2. same product sold in each branch: stock stays separate ----------
    const invoices: Record<B, string> = {} as Record<B, string>
    const qty: Record<B, number> = { pos1: 2, pos2: 3, pos3: 4 }
    for (const b of BRANCHES) {
      await ok(`sell ${qty[b]} x same product in ${b}`, async () => {
        const r = await one(
          `SELECT public.complete_pos_sale_with_inventory('Cust','1','',$1::jsonb,0,'completed','offline','pos_sale',0,0,0,'flat',0,NULL,0,'cash','{}'::jsonb,0,false,NULL,NULL,NULL,$2) AS r`,
          [JSON.stringify([{ product_id: productId[b], quantity: qty[b], unit_price: 100, name: 'Test Product' }]), b]
        )
        invoices[b] = r.r.invoice_no
      })
    }
    for (const b of BRANCHES) {
      const row = await one(`SELECT stock_quantity::int AS s FROM products WHERE id = $1`, [productId[b]])
      record(row.s === 10 - qty[b], `stock in ${b} is ${10 - qty[b]} (own sale only)`, `actual ${row.s}`)
      const mv = await all(`SELECT branch_id, quantity_delta::int AS d FROM inventory_movements WHERE product_id = $1`, [productId[b]])
      record(mv.length === 1 && mv[0].branch_id === b && mv[0].d === -qty[b], `inventory movement for ${b} recorded in ${b} only`)
    }
    await rejected('bill a product from another branch (stock check)', () =>
      c.query(`SELECT public.complete_pos_sale_with_inventory('C','1','',$1::jsonb,0,'completed','offline','pos_sale',0,0,0,'flat',0,NULL,0,'cash','{}'::jsonb,0,false,NULL,NULL,NULL,'pos3')`,
        [JSON.stringify([{ product_id: productId.pos1, quantity: 1, unit_price: 100, name: 'x' }])]))
    await rejected('sale with NULL branch', () =>
      c.query(`SELECT public.complete_pos_sale_with_inventory('C','1','',$1::jsonb,0,'completed','offline','pos_sale',0,0,0,'flat',0,NULL,0,'cash','{}'::jsonb,0,false,NULL,NULL,NULL,NULL)`,
        [JSON.stringify([{ product_id: productId.pos1, quantity: 1, unit_price: 100, name: 'x' }])]))

    // ---------- 3. invoice numbers ----------
    for (const b of BRANCHES) {
      const n = Number(invoices[b])
      record(n >= range[b][0] && n <= range[b][1], `invoice ${invoices[b]} is inside ${b}'s range`, `${range[b][0]}..${range[b][1]}`)
    }
    record(new Set(Object.values(invoices)).size === 3, 'invoice numbers are distinct across branches')
    const ranges = Object.values(range)
    const overlap = ranges.some((a, i) => ranges.some((b, j) => i < j && a[0] <= b[1] && b[0] <= a[1]))
    record(!overlap, 'branch invoice ranges do not overlap')
    const orderPos2 = await one(`SELECT id FROM orders WHERE branch_id = 'pos2'`)
    await rejected('order filed under a number from ANOTHER branch\'s range', () =>
      c.query(`INSERT INTO orders (invoice_no, customer_name, subtotal, total, branch_id) VALUES ($1, 'x', 1, 1, 'pos1')`, [invoices.pos2]))
    await rejected('duplicate invoice number (global uniqueness)', () =>
      c.query(`INSERT INTO orders (invoice_no, customer_name, subtotal, total, branch_id) VALUES ($1, 'x', 1, 1, 'pos2')`, [invoices.pos2]))
    await rejected('invoice sequence cannot run past its branch block', async () => {
      await c.query(`SELECT setval('public.invoice_number_seq_pos1', $1)`, [range.pos1[1]])
      await c.query(`SELECT nextval('public.invoice_number_seq_pos1')`)
    })
    await ok('register_branch() allocates the next free, non-overlapping block', async () => {
      await c.query(`SELECT public.register_branch('zz_test', 'Zz Test', 'Zz')`)
      const r = await one(`SELECT invoice_start, invoice_end FROM branches WHERE id = 'zz_test'`)
      const clash = await one(`SELECT count(*)::int n FROM branches WHERE id <> 'zz_test' AND int8range(invoice_start, invoice_end, '[]') && int8range($1::bigint, $2::bigint, '[]')`, [r.invoice_start, r.invoice_end])
      if (clash.n !== 0) throw new Error('allocated range overlaps another branch')
      const inv = await one(`SELECT public.get_next_invoice_no('zz_test') AS n`)
      if (Number(inv.n) !== Number(r.invoice_start)) throw new Error('first invoice should be the block start')
    })
    await rejected('register_branch() with an already-used invoice block', () => c.query(`SELECT public.register_branch('zz_dup', 'Zz Dup', 'Zz', 1)`))

    // ---------- 4. cross-branch references ----------
    const o1 = (await one(`SELECT id FROM orders WHERE branch_id = 'pos1'`)).id
    const variant = {} as Record<B, string>
    for (const b of BRANCHES) {
      variant[b] = (await one(`INSERT INTO product_variants (product_id, variant_name, price, stock, branch_id, is_active) VALUES ($1, 'Large', 100, 5, $2, true) RETURNING id`, [productId[b], b])).id
    }
    await rejected('order_item -> product of another branch', () =>
      c.query(`INSERT INTO order_items (order_id, product_id, product_name, quantity, base_price, line_total) VALUES ($1, $2, 'x', 1, 1, 1)`, [o1, productId.pos2]))
    await rejected('order_item -> variant of another branch', () =>
      c.query(`INSERT INTO order_items (order_id, variant_id, product_name, quantity, base_price, line_total) VALUES ($1, $2, 'x', 1, 1, 1)`, [o1, variant.pos2]))
    await ok('order_item -> product of the SAME branch is accepted (control)', () =>
      c.query(`INSERT INTO order_items (order_id, product_id, product_name, quantity, base_price, line_total) VALUES ($1, $2, 'x', 1, 1, 1)`, [o1, productId.pos1]))
    const item = await one(`SELECT branch_id FROM order_items WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [o1])
    record(item.branch_id === 'pos1', 'order_item inherits branch_id from its order')
    await rejected('order -> coupon of another branch', () =>
      c.query(`INSERT INTO orders (invoice_no, customer_name, subtotal, total, branch_id, coupon_id) VALUES ($1, 'x', 1, 1, 'pos1', $2)`, [String(range.pos1[0] + 500), couponId.pos2]))
    await ok('order coupon code is resolved inside its own branch only', async () => {
      const r = await one(`INSERT INTO orders (invoice_no, customer_name, subtotal, total, branch_id, coupon_code) VALUES ($1, 'x', 1, 1, 'pos3', 'SAVE10') RETURNING coupon_id`, [String(range.pos3[0] + 500)])
      if (r.coupon_id !== couponId.pos3) throw new Error(`coupon_id ${r.coupon_id} is not pos3's coupon ${couponId.pos3}`)
    })
    await rejected('product -> category of another branch', () =>
      c.query(`INSERT INTO products (name, category, category_id, price, branch_id, is_active) VALUES ('P', 'x', $1, 1, 'pos1', true)`, [categoryId.pos2]))
    await rejected('variant -> product of another branch', () =>
      c.query(`INSERT INTO product_variants (product_id, variant_name, price, stock, branch_id, is_active) VALUES ($1, 'V', 1, 1, 'pos1', true)`, [productId.pos2]))
    await rejected('inventory movement -> product of another branch', () =>
      c.query(`INSERT INTO inventory_movements (product_id, movement_type, quantity_delta, quantity_before, quantity_after, branch_id) VALUES ($1, 'RESTOCK', 1, 0, 1, 'pos1')`, [productId.pos2]))
    await rejected('inventory movement -> variant of another branch', () =>
      c.query(`INSERT INTO inventory_movements (variant_id, movement_type, quantity_delta, quantity_before, quantity_after, branch_id) VALUES ($1, 'RESTOCK', 1, 0, 1, 'pos1')`, [variant.pos2]))

    const staff = {} as Record<B, string>
    const expCat = {} as Record<B, number>
    for (const b of BRANCHES) {
      staff[b] = (await one(`INSERT INTO staff_members (name, role, branch_id) VALUES ('Same Name', 'cashier', $1) RETURNING id`, [b])).id
      expCat[b] = (await one(`SELECT id FROM expense_categories WHERE branch_id = $1 AND name = 'Rent'`, [b])).id
    }
    record(true, 'same staff name in all 3 branches')
    await rejected('attendance -> staff member of another branch', () =>
      c.query(`INSERT INTO attendance_records (staff_member_id, branch_id, attendance_date, status) VALUES ($1, 'pos1', CURRENT_DATE, 'present')`, [staff.pos2]))
    await ok('same staff + same date attendance in different branches', async () => {
      for (const b of BRANCHES) await c.query(`INSERT INTO attendance_records (staff_member_id, branch_id, attendance_date, status) VALUES ($1, $2, CURRENT_DATE, 'present')`, [staff[b], b])
    })
    await rejected('expense -> expense category of another branch', () =>
      c.query(`INSERT INTO expenses (expense_date, category_id, category_name, amount, branch_id) VALUES (CURRENT_DATE, $1, 'Rent', 10, 'pos1')`, [expCat.pos2]))
    await ok('same expense category name exists in every branch (default seed)', async () => {
      const n = await one(`SELECT count(DISTINCT branch_id)::int n FROM expense_categories WHERE name = 'Rent'`)
      if (n.n < 3) throw new Error('missing')
    })

    // advance orders
    const adv = {} as Record<B, string>
    for (const b of BRANCHES) {
      adv[b] = (await one(`SELECT (public.create_advance_order('Cust','999','','Card','Cat','',100,20,CURRENT_DATE+3,'','cash','tester','[]'::jsonb,$1)).id AS id`, [b])).id
    }
    record(true, 'advance orders created in all 3 branches')
    const dep = await all(`SELECT branch_id, deposit_id FROM advance_orders ORDER BY branch_id`)
    record(new Set(dep.map((d) => d.deposit_id)).size === 3, 'advance order numbers (deposit ids) are distinct across branches')
    await rejected('advance order -> completed order of another branch', () =>
      c.query(`UPDATE advance_orders SET completed_order_id = $1 WHERE id = $2`, [orderPos2.id, adv.pos1]))
    await ok('advance timeline/payment rows inherit the parent branch', async () => {
      const t = await all(`SELECT DISTINCT t.branch_id AS tb, a.branch_id AS ab FROM advance_order_timeline t JOIN advance_orders a ON a.id = t.advance_order_id`)
      const p = await all(`SELECT DISTINCT p.branch_id AS pb, a.branch_id AS ab FROM advance_order_payments p JOIN advance_orders a ON a.id = p.advance_order_id`)
      if (t.some((r) => r.tb !== r.ab) || p.some((r) => r.pb !== r.ab)) throw new Error('child branch differs from parent')
    })
    await ok('timeline insert cannot be forced into another branch', async () => {
      const r = await one(`INSERT INTO advance_order_timeline (advance_order_id, event_type, label, branch_id) VALUES ($1, 'x', 'x', 'pos3') RETURNING branch_id`, [adv.pos1])
      if (r.branch_id !== 'pos1') throw new Error(`stored under ${r.branch_id}`)
    })

    // functions called with the wrong branch
    await rejected('adjust_inventory_stock on another branch\'s product', () =>
      c.query(`SELECT public.adjust_inventory_stock($1, NULL, 99, 'RESTOCK', '', 't', 'pos1')`, [productId.pos2]))
    await rejected('adjust_inventory_stock without a branch', () =>
      c.query(`SELECT public.adjust_inventory_stock($1, NULL, 99, 'RESTOCK', '', 't')`, [productId.pos1]))
    await ok('adjust_inventory_stock in its own branch', () => c.query(`SELECT public.adjust_inventory_stock($1, NULL, 50, 'RESTOCK', '', 't', 'pos1')`, [productId.pos1]))
    const s2 = await one(`SELECT stock_quantity::int AS s FROM products WHERE id = $1`, [productId.pos2])
    record(s2.s === 7, 'pos2 stock untouched by pos1 restock', `pos2 stock ${s2.s}`)
    await rejected('update_advance_order_status on another branch\'s order', () =>
      c.query(`SELECT * FROM public.update_advance_order_status($1, 'ready_for_delivery', '', 'pos1')`, [adv.pos2]))
    await rejected('add_advance_order_event on another branch\'s order', () =>
      c.query(`SELECT public.add_advance_order_event($1, 'x', 'x', '', 'pos1')`, [adv.pos2]))
    await rejected('complete_advance_order_v2 on another branch\'s order', () =>
      c.query(`SELECT * FROM public.complete_advance_order_v2($1, 'cash', 80, NULL, 0, 0, '', 'pos1')`, [adv.pos2]))
    await rejected('punch_attendance for another branch\'s staff', () =>
      c.query(`SELECT * FROM public.punch_attendance($1, 'in', 'pos1')`, [staff.pos2]))
    await rejected('delete_inventory_item on another branch\'s product', () =>
      c.query(`SELECT public.delete_inventory_item($1, NULL, 'pos1')`, [productId.pos2]))

    // ---------- 5. branch-scoped queries see only their branch ----------
    for (const b of BRANCHES) {
      const t = await one(`SELECT (SELECT count(*) FROM products WHERE branch_id=$1 AND name='Test Product')::int p,
        (SELECT count(*) FROM products WHERE branch_id=$1 AND branch_id <> $1)::int bad_p,
        (SELECT count(DISTINCT branch_id) FROM orders WHERE branch_id=$1)::int ob,
        (SELECT count(*) FROM coupons WHERE branch_id=$1 AND code='SAVE10')::int cp,
        (SELECT count(*) FROM categories WHERE branch_id=$1 AND name_en='Test Cat')::int cc`, [b])
      record(t.p === 1 && t.cp === 1 && t.cc === 1 && t.ob === 1, `queries filtered to ${b} return exactly ${b}'s rows`)
    }
    await ok('expense summary is per-branch', async () => {
      await c.query(`INSERT INTO expenses (expense_date, category_id, category_name, amount, branch_id) VALUES (CURRENT_DATE, $1, 'Rent', 100, 'pos1')`, [expCat.pos1])
      const a = await one(`SELECT public.get_expense_summary_metrics(CURRENT_DATE,'pos1') AS m`)
      const b2 = await one(`SELECT public.get_expense_summary_metrics(CURRENT_DATE,'pos2') AS m`)
      if (Number(a.m.today) !== 100 || Number(b2.m.today) !== 0) throw new Error(`pos1=${a.m.today} pos2=${b2.m.today}`)
    })

    // ---------- 6. public invoice lookup ----------
    for (const b of BRANCHES) {
      const r = await all(`SELECT branch_id, invoice_no FROM public.get_public_invoice_by_number($1)`, [invoices[b]])
      record(r.length === 1 && r[0].branch_id === b && r[0].invoice_no === invoices[b], `public lookup of ${invoices[b]} returns only the ${b} bill`)
    }
    for (const probe of ['', '1', '0', '%', 'PB-', String(range.pos1[0] - 1), '10000001 OR 1=1']) {
      const r = await all(`SELECT 1 FROM public.get_public_invoice_by_number($1)`, [probe])
      record(r.length === 0, `public lookup of ${JSON.stringify(probe)} returns nothing`)
    }

    // ---------- 7. barcodes ----------
    const PREFIX: Record<B, string> = { pos1: 'PB', pos2: 'P2', pos3: 'P3' }
    const recv = async (productId: number, variantId: string | null, q: number, branch: string | null, custom: string | null = null) =>
      (await one(`SELECT public.create_barcode_and_receive_stock($1, $2::uuid, $3, 50, 'tester', $4, '', $5) AS r`, [productId, variantId, q, custom, branch])).r
    const stockOf = async (id: number) => Number((await one(`SELECT stock_quantity::numeric AS s FROM products WHERE id = $1`, [id])).s)
    const varStockOf = async (id: string) => Number((await one(`SELECT stock::numeric AS s FROM product_variants WHERE id = $1`, [id])).s)
    // the exact lookup the POS scan / print flows use: ONE branch + the scanned value
    const lookup = (branch: string, value: string) =>
      all(`SELECT r.id, r.product_id, r.variant_id, p.name FROM barcode_registry r JOIN products p ON p.id = r.product_id AND p.branch_id = r.branch_id
           WHERE r.branch_id = $1 AND r.barcode_value = $2 AND r.is_active = true`, [branch, value.trim().toUpperCase()])

    // 7a. same product in three branches -> three different barcodes, each with its own branch prefix
    const productCode = {} as Record<B, string>
    const productBarcodeId = {} as Record<B, string>
    for (const b of BRANCHES) {
      await ok(`generate a product barcode in ${b}`, async () => {
        const r = await recv(productId[b], null, 5, b)
        productCode[b] = r.barcode_value
        productBarcodeId[b] = r.barcode_id
        if (!r.is_new_barcode) throw new Error('expected a NEW barcode')
      })
    }
    record(new Set(Object.values(productCode)).size === 3, 'same product in 3 branches gets 3 different barcodes', Object.values(productCode).join(' / '))
    for (const b of BRANCHES) record(productCode[b]?.startsWith(`${PREFIX[b]}P`) && /^[A-Z0-9]{2}P\d{8}$/.test(productCode[b]), `${b} product barcode carries prefix ${PREFIX[b]}`, productCode[b])
    const variantCode = {} as Record<B, string>
    for (const b of BRANCHES) {
      await ok(`generate a variant barcode in ${b}`, async () => {
        const r = await recv(productId[b], variant[b], 2, b)
        variantCode[b] = r.barcode_value
        if (!r.barcode_value.startsWith(`${PREFIX[b]}V`)) throw new Error(`variant barcode ${r.barcode_value}`)
      })
    }
    await ok('re-receiving stock re-uses the existing barcode (no new one)', async () => {
      const r = await recv(productId.pos1, null, 1, 'pos1')
      if (r.is_new_barcode || r.barcode_value !== productCode.pos1) throw new Error(`got ${r.barcode_value}`)
    })

    // 7b. per-branch sequences are independent
    const num = (code: string) => Number(code.slice(3))
    const extra = {} as Record<'pos1' | 'pos2', number>
    for (const b of ['pos1', 'pos2'] as const) {
      extra[b] = (await one(`INSERT INTO products (name, category, price, stock_quantity, stock, branch_id, is_active) VALUES ('Test Product 2', 'x', 1, 0, 0, $1, true) RETURNING id`, [b])).id
    }
    const p1b = (await recv(extra.pos1, null, 1, 'pos1')).barcode_value as string
    const p1c = (await one(`SELECT public.generate_barcode_value('product','pos1') AS v`)).v as string
    const p2b = (await recv(extra.pos2, null, 1, 'pos2')).barcode_value as string
    record(num(p1b) === num(productCode.pos1) + 1 && num(p1c) === num(p1b) + 1, 'pos1 sequence advances on its own', `${productCode.pos1} -> ${p1b} -> ${p1c}`)
    record(num(p2b) === num(productCode.pos2) + 1, 'pos2 sequence is NOT advanced by pos1 activity', `${productCode.pos2} -> ${p2b}`)

    // 7c. receive-stock via barcode changes only that branch's stock
    {
      const before = { pos1: await stockOf(productId.pos1), pos2: await stockOf(productId.pos2), pos3: await stockOf(productId.pos3) }
      const vBefore = { pos1: await varStockOf(variant.pos1), pos2: await varStockOf(variant.pos2), pos3: await varStockOf(variant.pos3) }
      await ok('receive 7 units against pos2\'s barcode', () => recv(productId.pos2, null, 7, 'pos2'))
      const after = { pos1: await stockOf(productId.pos1), pos2: await stockOf(productId.pos2), pos3: await stockOf(productId.pos3) }
      record(after.pos2 === before.pos2 + 7, 'pos2 stock rose by exactly 7', `${before.pos2} -> ${after.pos2}`)
      record(after.pos1 === before.pos1 && after.pos3 === before.pos3, 'pos1 and pos3 stock unchanged by a pos2 receipt')
      record((await varStockOf(variant.pos1)) === vBefore.pos1 && (await varStockOf(variant.pos3)) === vBefore.pos3, 'pos1 / pos3 variant stock unchanged by a pos2 receipt')
      const mv = await all(`SELECT branch_id, movement_type, reference_type, reference_id, barcode_id, quantity_delta::int AS d FROM inventory_movements WHERE product_id = $1 AND reference_type = 'barcode_receipt' ORDER BY id DESC LIMIT 1`, [productId.pos2])
      record(mv.length === 1 && mv[0].branch_id === 'pos2' && mv[0].d === 7 && mv[0].reference_id === productCode.pos2 && mv[0].barcode_id === productBarcodeId.pos2 && ['INITIAL_BARCODE_STOCK', 'RESTOCK'].includes(mv[0].movement_type),
        'barcode receipt movement is recorded in pos2 with its barcode', mv[0] ? `${mv[0].movement_type}` : 'none')
    }
    await rejected('receive stock for pos2\'s product through pos1', () => recv(productId.pos2, null, 5, 'pos1'))
    await rejected('receive stock for pos2\'s variant through pos1', () => recv(productId.pos2, variant.pos2, 5, 'pos1'))
    await rejected('receive stock with NO branch', () => recv(productId.pos1, null, 5, null))
    await rejected('receive stock for an unknown branch', () => recv(productId.pos1, null, 5, 'nope'))
    await rejected('generate_barcode_value for an unknown branch', () => c.query(`SELECT public.generate_barcode_value('product','nope')`))

    // 7d. sales and stock adjustments stamp the movement with the barcode of the SAME branch
    await ok('a POS sale records the branch\'s barcode on its SALE movement', async () => {
      await c.query(`SELECT public.complete_pos_sale_with_inventory('Cust','1','',$1::jsonb,0,'completed','offline','pos_sale',0,0,0,'flat',0,NULL,0,'cash','{}'::jsonb,0,false,NULL,NULL,NULL,'pos2')`,
        [JSON.stringify([{ product_id: productId.pos2, quantity: 1, unit_price: 100, name: 'Test Product' }])])
      const m = await one(`SELECT barcode_id FROM inventory_movements WHERE product_id = $1 AND movement_type = 'SALE' ORDER BY id DESC LIMIT 1`, [productId.pos2])
      if (m.barcode_id !== productBarcodeId.pos2) throw new Error(`barcode_id ${m.barcode_id}`)
    })
    await ok('adjust_inventory_stock records the branch\'s barcode', async () => {
      await c.query(`SELECT public.adjust_inventory_stock($1, NULL, 20, 'CORRECTION', '', 't', 'pos3')`, [productId.pos3])
      const m = await one(`SELECT barcode_id FROM inventory_movements WHERE product_id = $1 AND movement_type = 'CORRECTION' ORDER BY id DESC LIMIT 1`, [productId.pos3])
      if (m.barcode_id !== productBarcodeId.pos3) throw new Error(`barcode_id ${m.barcode_id}`)
    })

    // 7e. a barcode can only reference a product / variant of its own branch (composite foreign keys)
    await rejected('barcode_registry (pos1) -> product of pos2', () =>
      c.query(`INSERT INTO barcode_registry (barcode_value, entity_type, product_id, branch_id) VALUES ('PBP90000001', 'product', $1, 'pos1')`, [productId.pos2]))
    await rejected('barcode_registry (pos1) -> variant of pos2', () =>
      c.query(`INSERT INTO barcode_registry (barcode_value, entity_type, product_id, variant_id, branch_id) VALUES ('PBV90000001', 'variant', $1, $2, 'pos1')`, [productId.pos1, variant.pos2]))
    await rejected('barcode_registry (pos2) -> pos2 product + pos1 variant', () =>
      c.query(`INSERT INTO barcode_registry (barcode_value, entity_type, product_id, variant_id, branch_id) VALUES ('P2V90000002', 'variant', $1, $2, 'pos2')`, [productId.pos2, variant.pos1]))
    await rejected('barcode_registry for an unknown branch', () =>
      c.query(`INSERT INTO barcode_registry (barcode_value, entity_type, product_id, branch_id) VALUES ('7000000000003', 'product', $1, 'nope')`, [productId.pos1]))
    await rejected('movement in pos1 pointing at pos2\'s barcode', () =>
      c.query(`INSERT INTO inventory_movements (product_id, barcode_id, movement_type, quantity_delta, quantity_before, quantity_after, branch_id) VALUES ($1, $2, 'RESTOCK', 1, 0, 1, 'pos1')`, [productId.pos1, productBarcodeId.pos2]))
    await rejected('product-type barcode that targets a variant', () =>
      c.query(`INSERT INTO barcode_registry (barcode_value, entity_type, product_id, variant_id, branch_id) VALUES ('PBP90000004', 'product', $1, $2, 'pos1')`, [productId.pos1, variant.pos1]))

    // 7f. branch prefix must match the branch; generated values are unique everywhere
    await rejected('barcode with pos2\'s prefix filed under pos1', () =>
      c.query(`INSERT INTO barcode_registry (barcode_value, entity_type, product_id, branch_id) VALUES ('P2P90000005', 'product', $1, 'pos1')`, [productId.pos1]))
    await rejected('barcode with pos3\'s prefix filed under pos2 (variant)', () =>
      c.query(`INSERT INTO barcode_registry (barcode_value, entity_type, product_id, variant_id, branch_id) VALUES ('P3V90000006', 'variant', $1, $2, 'pos2')`, [productId.pos2, variant.pos2]))
    await rejected('lower-case prefix cannot dodge the prefix check', () =>
      c.query(`INSERT INTO barcode_registry (barcode_value, entity_type, product_id, branch_id) VALUES ('p2p90000007', 'product', $1, 'pos1')`, [productId.pos1]))
    await rejected('changing a barcode\'s branch to one with another prefix', () =>
      c.query(`UPDATE barcode_registry SET barcode_value = 'P3P90000008' WHERE id = $1`, [productBarcodeId.pos1]))
    await rejected('barcode prefix letter that does not match entity type (PBV on a product)', () =>
      c.query(`INSERT INTO barcode_registry (barcode_value, entity_type, product_id, branch_id) VALUES ('PBV90000009', 'product', $1, 'pos1')`, [productId.pos1]))
    await ok('a unique index makes generated barcode values unique across ALL branches', async () => {
      const i = await one(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'barcode_registry_generated_value_unique'`)
      if (!i || !/UNIQUE/.test(i.indexdef) || /branch_id/.test(i.indexdef)) throw new Error('global unique index missing')
    })
    await rejected('duplicate generated barcode value', () =>
      c.query(`INSERT INTO barcode_registry (barcode_value, entity_type, product_id, branch_id) VALUES ($1, 'product', $2, 'pos1')`, [productCode.pos1, extra.pos1]))
    await rejected('duplicate barcode value inside ONE branch (manufacturer code)', async () => {
      await c.query(`INSERT INTO barcode_registry (barcode_value, entity_type, product_id, branch_id) VALUES ('8901234567890', 'product', $1, 'pos1')`, [extra.pos1])
      await c.query(`INSERT INTO barcode_registry (barcode_value, entity_type, product_id, branch_id) VALUES (' 8901234567890 ', 'product', $1, 'pos1')`, [productId.pos1])
    })
    await ok('the same manufacturer barcode may exist in two branches (as in the original app)', async () => {
      await c.query(`INSERT INTO barcode_registry (barcode_value, entity_type, product_id, branch_id) VALUES ('5012345678900', 'product', $1, 'pos1')`, [productId.pos1])
      await c.query(`INSERT INTO barcode_registry (barcode_value, entity_type, product_id, branch_id) VALUES ('5012345678900', 'product', $1, 'pos3')`, [productId.pos3])
    })

    // 7g. scanning is looked up inside ONE branch only
    for (const b of BRANCHES) {
      const r = await lookup(b, productCode[b])
      record(r.length === 1 && r[0].product_id === productId[b], `scan of ${productCode[b]} in ${b} finds ${b}'s product`)
    }
    for (const [from, at] of [['pos1', 'pos3'], ['pos3', 'pos1'], ['pos2', 'pos1'], ['pos1', 'pos2']] as [B, B][]) {
      const r = await lookup(at, productCode[from])
      record(r.length === 0, `${from} barcode ${productCode[from]} scanned at ${at} is "not found"`, `${r.length} rows`)
      const v = await lookup(at, variantCode[from])
      record(v.length === 0, `${from} variant barcode ${variantCode[from]} scanned at ${at} is "not found"`)
    }
    {
      const r1 = await lookup('pos1', '5012345678900')
      const r3 = await lookup('pos3', '5012345678900')
      const r2 = await lookup('pos2', '5012345678900')
      record(r1.length === 1 && r1[0].product_id === productId.pos1 && r3.length === 1 && r3[0].product_id === productId.pos3 && r2.length === 0,
        'a shared manufacturer barcode resolves to each branch\'s OWN product (and to nothing in a branch without it)')
    }
    {
      const r = await lookup('pos1', ` ${productCode.pos1.toLowerCase()} `)
      record(r.length === 1, 'scan lookup normalises case / whitespace')
    }
    {
      const orphan = await all(`SELECT 1 FROM barcode_registry r JOIN products p ON p.id = r.product_id WHERE p.branch_id <> r.branch_id`)
      const orphanV = await all(`SELECT 1 FROM barcode_registry r JOIN product_variants v ON v.id = r.variant_id WHERE v.branch_id <> r.branch_id`)
      record(orphan.length === 0 && orphanV.length === 0, 'no barcode_registry row points outside its own branch')
    }

    // 7h. register_branch() allocates a prefix + independent sequences for any future branch
    await ok('register_branch() allocates a free, unique barcode prefix and its own sequences', async () => {
      const r = await one(`SELECT barcode_prefix FROM branches WHERE id = 'zz_test'`)
      const taken = await one(`SELECT count(*)::int n FROM branches WHERE id <> 'zz_test' AND barcode_prefix = $1`, [r.barcode_prefix])
      if (!/^[A-Z][A-Z0-9]$/.test(r.barcode_prefix) || taken.n !== 0) throw new Error(`prefix ${r.barcode_prefix}`)
      const seqs = await one(`SELECT count(*)::int n FROM pg_sequences WHERE schemaname = 'public' AND sequencename IN ('barcode_product_seq_zz_test', 'barcode_variant_seq_zz_test')`)
      if (seqs.n !== 2) throw new Error('missing per-branch barcode sequences')
      const zp = (await one(`INSERT INTO products (name, category, price, stock_quantity, stock, branch_id, is_active) VALUES ('Zz Product', 'x', 1, 0, 0, 'zz_test', true) RETURNING id`)).id
      const z = await recv(zp, null, 3, 'zz_test')
      if (z.barcode_value !== `${r.barcode_prefix}P10000001`) throw new Error(`first barcode ${z.barcode_value}`)
    })
    await rejected('register_branch() with a barcode prefix that is already used', () =>
      c.query(`SELECT public.register_branch('zz_dup2', 'Zz Dup2', 'Zz', NULL, '#111111', '/branch-placeholder.svg', '', 0, 'PB')`))
    await rejected('register_branch() with a malformed barcode prefix', () =>
      c.query(`SELECT public.register_branch('zz_dup3', 'Zz Dup3', 'Zz', NULL, '#111111', '/branch-placeholder.svg', '', 0, 'ABC')`))
    await ok('the three seeded branches use PB / P2 / P3', async () => {
      const rows = await all(`SELECT id, barcode_prefix FROM branches WHERE id IN ('pos1','pos2','pos3') ORDER BY id`)
      if (JSON.stringify(rows.map((x) => x.barcode_prefix)) !== JSON.stringify(['PB', 'P2', 'P3'])) throw new Error(JSON.stringify(rows))
    })

    // 7i. deleting an item removes ITS barcodes only
    await ok('delete_inventory_item removes that branch\'s barcodes and leaves the others', async () => {
      await c.query(`SELECT public.delete_inventory_item($1, NULL, 'pos3')`, [productId.pos3])
      const gone = await one(`SELECT count(*)::int n FROM barcode_registry WHERE product_id = $1`, [productId.pos3])
      const kept = await one(`SELECT count(*)::int n FROM barcode_registry WHERE branch_id IN ('pos1','pos2') AND product_id IN ($1, $2)`, [productId.pos1, productId.pos2])
      if (gone.n !== 0 || kept.n < 2) throw new Error(`gone=${gone.n} kept=${kept.n}`)
    })
    await rejected('delete_inventory_item on another branch\'s product (barcodes survive)', () =>
      c.query(`SELECT public.delete_inventory_item($1, NULL, 'pos1')`, [productId.pos2]))
    await rejected('a product that still has a barcode cannot be deleted directly (RESTRICT, as in the original)', () =>
      c.query(`DELETE FROM products WHERE id = $1`, [productId.pos1]))
  } finally {
    await c.query('ROLLBACK').catch(() => undefined)
    await restoreOnce() // sequences advanced during the test
    const after = await one(`SELECT (SELECT count(*) FROM products)::int p, (SELECT count(*) FROM orders)::int o, (SELECT count(*) FROM categories)::int c, (SELECT count(*) FROM coupons)::int cp, (SELECT count(*) FROM branches)::int b`)
    record(JSON.stringify(after) === JSON.stringify(baseline), 'cleanup: database is exactly as it was before the test (rolled back, sequences restored)')
    c.release()
  }
  results.forEach((l) => console.log(l))
  console.log(`\n${passed} passed, ${failed} failed`)
  await pool.end()
  process.exitCode = failed ? 1 : 0
}

run().catch((e) => {
  console.error('Test run crashed:', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
