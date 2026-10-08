# Migration 0007: duplicate-proof bills, cancel + restock, CGST / SGST

File: `db/migrations/0007_idempotency_cancel_cgst_sgst.sql`. It only **adds** things (nullable columns, indexes, one trigger, one function) and is safe to run twice. Run it on a Neon **branch first**, never straight on the main database.

## What it changes
| Area | Change |
|---|---|
| Duplicates | `orders.idempotency_key` and `advance_orders.idempotency_key`, each with a unique index on `(branch_id, idempotency_key)` |
| Cancel | `orders.cancelled_at`, `cancelled_by`, `cancel_reason`; status CHECK (`pending`, `completed`, `cancelled`, added `NOT VALID` so old rows are left alone); stock-movement type `CANCELLATION_RESTOCK`; function `public.cancel_order()` |
| Tax | `orders.taxable_amount`, `cgst_amount`, `sgst_amount` (all `NUMERIC(12,2)`), a trigger that keeps them right on every insert and update, and a backfill of old bills: `cgst = floor(gst/2*100)/100`, `sgst = gst - cgst` |

Invoice numbers already come from per-branch sequences and DEP numbers from `deposit_number_seq` (never `MAX()+1`), so nothing changes there.

## Environment variables
| Name | Where | What |
|---|---|---|
| `DATABASE_URL` | Vercel and `.env` | the **pooled** (`-pooler`) string: what the running app uses |
| `DATABASE_URL_UNPOOLED` | `.env` (and Vercel only if you run migrations from there) | the **direct** string: `npm run db:migrate`, `db:seed`, `db:reset` and the tests use it when it is set, otherwise they fall back to `DATABASE_URL` |

The app talks to Neon through the `pg` driver (a normal connection pool over the pooled string), not through `@neondatabase/serverless`, so every multi-step write already runs as a real `BEGIN ... COMMIT` transaction. Nothing needs to change for that.

## Step by step (PowerShell)
1. **Make a Neon branch.** Neon Console → your project → Branches → **Create branch**, name it `test-0007`, parent = your main branch (it copies the data instantly). Open the branch → **Connect** and copy two strings: the **pooled** one and the **direct** one (pooling switched off).
2. **Migrate the branch** (this window only; nothing is saved):
   ```powershell
   cd "C:\TAKE -250 UPDATED\yg-billing"
   $env:DATABASE_URL_UNPOOLED = '<direct string of branch test-0007>'
   npm run db:migrate
   ```
   Expect `apply 0007_idempotency_cancel_cgst_sgst.sql` then `Migrations complete.` Running it again prints `skip`.
3. **Try the app on the branch.** In the same window:
   ```powershell
   $env:DATABASE_URL = '<pooled string of branch test-0007>'
   npm run dev:full        # http://localhost:4310
   ```
   Make a bill, tap Complete Sale twice quickly (one bill), cancel it as Manager (stock goes back), and open a bill with GST (CGST and SGST show as two lines).
4. **Look at the duplicates already in your data.** Neon Console → the branch → SQL Editor → paste `db/maintenance/duplicates_review.sql` and run it. It only reads. Check the list.
5. **Dry-run the clean-up on the branch.** Paste `db/maintenance/duplicates_cancel.sql`. It ends with `ROLLBACK`, so it only shows what *would* happen. When the output is right, change the last line to `COMMIT` and run it again on the branch, then check the stock.
6. **Main database.** Only when the branch behaved: set `$env:DATABASE_URL_UNPOOLED` to the **main** direct string and run `npm run db:migrate` again, **then** deploy the new code (the new code needs the new columns). The clean-up script on main is a separate, deliberate step.
7. Delete the `test-0007` branch when you are done.

## Rolling back
Nothing is destructive, so the app keeps working if you stop here. To undo completely, run on the branch/main: `DROP TRIGGER set_order_gst_split_trigger ON public.orders; DROP FUNCTION public.set_order_gst_split(); DROP FUNCTION public.cancel_order(uuid, text, text, text);` and drop the added columns. (Do not do this after real bills were cancelled: the cancelled status and movements would be lost.)
