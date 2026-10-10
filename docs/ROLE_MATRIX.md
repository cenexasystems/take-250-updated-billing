# Role matrix (Phase 2, Step 1 - for approval before any endpoint is built)

Derived from the ORIGINAL app (commit 2292c52). Important: the original enforced roles **only in the browser**
(Supabase RLS was `USING (true)`), so the "original check" column cites the UI check each row comes from.
The new API enforces every row server-side, default deny.

Legend: Y = allowed, N = 403, "own" = locked to the branch in the JWT (never from the client), "any" = Admin picks one of the 3 branches (validated against `branches`).

| # | Endpoint group | Admin | Manager | Staff | Original check it comes from |
|---|---|---|---|---|---|
| 1 | Login (passcode), logout, session | Y | Y | Y | `AdminLogin.tsx`; `AdminGuard` (role admin or staff) |
| 2 | Branch list + own branding (name, logo, theme) read | Y any | Y own | Y own | `applyActiveTheme`, `branchTheme.ts` |
| 3 | Catalog read (products, variants, categories). Staff reads it to SELL; the purchase cost is never sent to Staff | Y any | Y own | Y own | `staffAllowedTabs` has billing + inventory; POS catalogue |
| 4 | Product create / edit / variant edit (AddProductModal, Catalog "Edit", AddEditProductView) | Y any | Y own | **N** (2026 change) | no role check on these buttons in `InventoryTable`/`CatalogModal` (only Delete is gated) |
| 5 | **Delete** product / variant (`delete_inventory_item`) | Y any | Y own | **N** | `InventoryTable.tsx:547` `role === 'admin'` |
| 6 | Categories manage + the inline "add category" in product forms | Y any | Y own | N | `categories` tab is in `ADMIN_REMOVED_TABS` (hidden for all); only the category pickers inside product forms remain, covered by row 4 |
| 7 | Inventory list, stock history drawer, full low-stock list | Y any | Y own | **N** (2026 change). Staff keeps ONLY the narrow `GET /api/inventory/low-stock-alerts` (name, quantity, threshold) for the alert popup + sound | `staffAllowedTabs`; `useLowStockMonitor(role admin or staff)` |
| 8 | Adjust stock, quick price edit | Y any | Y own | **N** (2026 change) | ungated in `AdjustStockModal`, `QuickPriceModal` |
| 9 | Inventory analytics view + stock-ledger CSV exports (`InventoryAnalyticsView`) | Y any | Y own | **N** (2026 change) | ungated inside the inventory tab (NOT the Analytics Dashboard, see row 22) |
| 10 | **Barcode: generate / receive stock** (`create_barcode_and_receive_stock`) | Y any | Y own | **N** (2026 change) | "Global Add Barcode CTA (admin & staff)" comment + button ungated in `InventoryTable` |
| 11 | **Barcode: print data / labels / settings drawer** | Y any | Y own | **N** (2026 change) | Print button + `BarcodePrintModal` ungated |
| 12 | **Barcode: scan lookup** (POS scan bar, global scanner listener) | Y any | Y own | Y own | `BarcodeScannerInput`, `useHardwareBarcodeScanner`; lookup is `.eq('branch', branch)` |
| 13 | Barcode registry write on product save (editor upsert) | Y any | Y own | **N** (2026 change) | `AddEditProductView` upsert, ungated |
| 14 | Barcode Hub tab | N (hidden) | N | N | `barcode_hub` in `ADMIN_REMOVED_TABS`, not in `staffAllowedTabs`. **No endpoint** beyond rows 10-13 |
| 15 | POS sale (`complete_pos_sale_with_inventory`), invoice number | Y any | Y own | Y own | `/pos` `PosGuard`; billing tab |
| 16 | Coupon **validate/apply** at POS | Y any | Y own | Y own | applying a coupon in Pos is ungated |
| 17 | Coupons **manage** (create/edit/delete, Coupons tab) | Y any | Y own | N | `coupons` in admin nav only |
| 18 | Order history: list / view / print / share | Y any | Y own | Y own | `history` in `staffAllowedTabs` |
| 19 | Order **status change** | Y any | Y own | N | `role === 'admin' ? <select> : <span>` (`Dashboard.tsx:3603, 3674`) |
| 20 | Order **delete** | Y any | Y own | N | delete button `role === 'admin'`. The staff branch of `deleteOrder` (prompt for hard-coded `<removed>`) is unreachable dead code, see Flag 1 |
| 21 | Advance orders: create, list, update status, timeline, complete (`complete_advance_order_v2`). **Delete: Admin / Manager only** | Y any | Y own | Y own (no delete, 2026 change) | `advance_orders` in `staffAllowedTabs`; `AdvanceOrders.tsx` has no role gate |
| 22 | **Analytics Dashboard** (`pos_analytics` tab, `/pos-analytics`, `BillingAnalytics`, `analyticsExport`, their data endpoints incl. the order delete inside BillingAnalytics) | Y any | **N** | N | `pos_analytics` admin nav + `/pos-analytics` `AdminOnlyGuard`; `BillingAnalytics` `isAdmin`. Manager exclusion per your rule |
| 23 | Expenses (categories, entries, summary metrics) | Y any | Y own | N | `/expenses` under `AdminOnlyGuard`; `expenses` only in admin nav |
| 24 | Store settings read (own branch) | Y any | Y own | Y own | needed by theme/invoice for everyone |
| 25 | Store settings **write** + logo/branding upload | Y any | Y own | N | `store_settings` admin nav only; `StoreSettingsView` target selector `role === 'admin'` |
| 26 | Attendance + staff roster | N (hidden) | N | N | `attendance` in `ADMIN_REMOVED_TABS` and not in staff list; screens unreachable. Kept in DB, **no endpoint** unless you say otherwise |
| 27 | WhatsApp Center (`/whatsapp-center`) | Y any | Y own | N | `AdminOnlyGuard` route |
| 28 | **Passcode management** (Change passcodes) | Y | **N** | N | `StaffMemberships` / `credentialService` (global view), Admin-only; Manager exclusion per your rule |
| 29 | **Cross-branch views** (`business_overview`, `staff_memberships` global tabs, Cross-Branch Sales, Consolidated Stock, BusinessReports, any all-branches aggregate, branch "all" scope) | Y | **N** | N | `GLOBAL_TABS`, `isGlobalView = role==='admin' && activeBranch==='all'` |
| 30 | Branch Hub (own-branch landing tile page) | N | N | Y own | `branch_hub` only in staff nav; in `ADMIN_REMOVED_TABS` for admin. Manager follows Admin, so N |
| 31 | Customer user list / "Make Admin" (`users` tab, `profiles`) | legacy | N | N | reachable only via `?tab=users`, storefront-era Supabase `profiles` table that does not exist in the Neon schema. **No endpoint**, see Flag 5 |
| 32 | File upload: product-images (product forms), invoices (POS) | Y any | Y own | Y own for invoices only; product-images **N** (2026 change) | product/POS flows ungated |
| 33 | File upload: branding | Y any | Y own | N | follows row 25 |
| 34 | File upload: avatars | Y any | Y own | N | admin profile only |
| 35 | Public invoice lookup (`get_public_invoice_by_number`, `/invoice/:id`) | public | public | public | `DigitalInvoice` route has no guard; rate-limited per IP, one bill, generic not-found |
| 36 | Polling endpoints replacing the 6 realtime subscriptions | per row's data | per row | per row | each returns only the caller's branch (Admin: selected branch) |

## Flags / ambiguities (need your decision)

1. **Hard-coded `<removed>`** (`Dashboard.tsx:950`): "staff deletes an order after typing the admin password". The Delete button is only rendered for admin, so staff can never reach it. I propose **no staff delete endpoint** and removing the dependency on that string. Confirm.
2. **Expenses summary** for Manager: I treat the Expenses ledger (and its summary cards) as NOT "Analytics Dashboard", so Manager gets it. Say if you want it excluded.
3. **Inventory analytics view / stock-ledger CSV** (row 9): same reasoning, it is not in your Analytics list, so Manager and Staff keep it exactly as in the original.
4. **Manager and Store Settings / WhatsApp Center**: Admin-equivalent, own branch only. Manager cannot see the Admin's branch selector (it is a fixed badge, like Staff).
5. **Rows 14, 26, 31** are hidden in the original even for Admin. I will build no endpoints for them (attendance DB tables stay). Say if attendance should get endpoints anyway for a later phase.
6. **Staff creating products / editing prices / adjusting stock / generating barcodes** is allowed because the original UI never gated it. Only Delete is Admin-only. Kept as in the original.
7. **Manager logo/theme edits** change only their own branch's row; Branch 3 placeholder branding is editable by Admin and Manager of Branch 3.

## Staff change (2026): Billing, Advance Orders, Order History and the low-stock alert only

Staff row, final:

| Area | Staff |
|---|---|
| Sidebar | Store Hub, Store Dashboard & POS, Advance Orders, Order History. **No Stock & Inventory.** |
| POS | sell, scan (`/api/barcodes/lookup`), coupons lookup, unregistered item, invoice upload, finalize own bill |
| Catalog | read only (`products`, `variants`, `categories`), no purchase cost |
| Stock / price / product / variant / category / barcode generate-print-receive | **403** |
| Advance orders | view, create, update, complete; **delete 403** |
| Order history | view own branch; status change / cancel as decided earlier (rows 19-20: delete is Admin / Manager only) |
| Low-stock alert | popup + sound, fed by `GET /api/inventory/low-stock-alerts` (name, variant, quantity, threshold of the token's branch only) |
