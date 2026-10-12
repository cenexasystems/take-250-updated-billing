import type { Db } from './db.js'

/**
 * What an invoice shows besides the bill row and its lines (one helper for the signed-in and the public invoice):
 *   returns: per bill line the returned / damaged quantity, and each return's number and date (quantities and amounts only)
 *   advance: for a bill made by completing an advance order, the deposit(s) (amount, mode, date) and the balance payment
 * Both are read inside the bill's own branch.
 */
export async function invoiceExtras(db: Db, branch: string, orderId: string) {
  const items = await db.query(
    `SELECT i.order_item_id, SUM(i.quantity)::numeric AS returned, COALESCE(SUM(i.quantity) FILTER (WHERE NOT i.restocked), 0)::numeric AS damaged
       FROM public.order_return_items i JOIN public.order_returns r ON r.id = i.return_id AND r.branch_id = i.branch_id
      WHERE r.order_id = $1 AND r.branch_id = $2
      GROUP BY i.order_item_id`, [orderId, branch])
  const records = await db.query(
    `SELECT return_no, created_at FROM public.order_returns WHERE order_id = $1 AND branch_id = $2 ORDER BY created_at, return_no`, [orderId, branch])
  const adv = (await db.query(`SELECT id, deposit_id FROM public.advance_orders WHERE completed_order_id = $1 AND branch_id = $2`, [orderId, branch])).rows[0]
  let advance = null
  if (adv) {
    const pays = (await db.query(
      `SELECT payment_type, amount, payment_method, received_at FROM public.advance_order_payments
        WHERE advance_order_id = $1 AND branch_id = $2 ORDER BY received_at`, [adv.id, branch])).rows
    const bal = pays.find((p) => p.payment_type === 'remaining')
    advance = {
      deposit_id: String(adv.deposit_id),
      deposits: pays.filter((p) => p.payment_type === 'deposit').map((p) => ({ amount: Number(p.amount), method: String(p.payment_method), received_at: p.received_at })),
      balance: bal ? { amount: Number(bal.amount), method: String(bal.payment_method), received_at: bal.received_at } : null,
    }
  }
  return {
    returns: records.rows.length
      ? {
          items: items.rows.map((x) => ({ order_item_id: Number(x.order_item_id), returned: Number(x.returned), damaged: Number(x.damaged) })),
          records: records.rows.map((x) => ({ return_no: String(x.return_no), created_at: x.created_at })),
        }
      : null,
    advance,
  }
}
