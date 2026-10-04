/**
 * Branch isolation test. Runs against DATABASE_URL inside ONE transaction that is rolled back,
 * and restores every sequence it advanced, so the database ends exactly as it started.
 *   npm run test:isolation
 *
 * Proves: same codes/names work in every branch, stock/invoices never mix, every cross-branch
 * reference is rejected by the database itself, and branch-scoped queries only see their branch.
 */
import 'dotenv/config'
import type { PoolClient } from 'pg'
import { getPool } from '../server/lib/db'

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

  // -- snapshot sequences (setval is not transactional, so restore them at the end)
  const seqNames = (await all<{ sequencename: string }>(`SELECT sequencename FROM pg_sequences WHERE schemaname='public'`)).map((r) => r.sequencename)
  const seqState = new Map<string, { last: string | null }>()
  for (const n of seqNames) { const r = await one(`SELECT last_value::text AS v, is_called FROM public."${n}"`); seqState.set(n, { last: r.is_called ? r.v : null }) }
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
    await rejected('duplicate SKU inside ONE branch', () => c.query(`INSERT INTO products (name, category, price, sku, branch_id, is_active) VALUES ('Other', 'x', 1, 'test-001', 'pos1', true)`))
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
  } finally {
    await c.query('ROLLBACK')
    // restore sequences advanced during the test
    for (const [n, st] of seqState) {
      if (st.last === null) await c.query(`SELECT setval('public."${n}"', (SELECT min_value FROM pg_sequences WHERE schemaname='public' AND sequencename=$1), false)`, [n])
      else await c.query(`SELECT setval('public."${n}"', $1::bigint, true)`, [st.last])
    }
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
