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
| 17 | Coupons **manage** (create/edit/delete, Coupons tab) | Y any | **N** (2026 change) | N | `coupons` in admin nav only |
| 17b | Coupon **send** (Send button on each coupon: PDF to a customer, records `coupon_sends`; `POST /api/coupons/:id/sends`) | Y own selected branch | **N** | **N** | new (2026): `coupons.send` |
| 17c | **Customer lookup** at POS (status line under the phone field + that customer's sent coupons of THIS branch with status; `POST /api/customers/lookup`) | Y own selected branch | Y own | Y own | new (2026): `customers.lookup`, rate limited per user and IP |
| 17d | **Phone suggestions** at POS (from the 4th digit, max 8 matching numbers of THIS branch with names; a full existing number fills the name; `POST /api/customers/suggest`) | Y own selected branch | Y own | Y own | new (2026): same permission as the lookup (`customers.lookup`), rate limited per user and IP |
| 18 | Order history: list / view / print / share | Y any | Y own | Y own | `history` in `staffAllowedTabs` |
| 19 | Order **status change** (Pending / Completed. There is no Cancelled any more) | Y any | Y own (Pending / Completed only) | **N** (view only) | `role === 'admin' ? <select> : <span>` (`Dashboard.tsx:3603, 3674`) |
| 20 | Order **delete** | Y any | **N** (2026 change) | N | delete button `role === 'admin'`. The staff branch of `deleteOrder` (prompt for hard-coded `<removed>`) is unreachable dead code, see Flag 1 |
| 20c | **Returns list** (Order History > Returns button: every return by RETURN date, totals, CSV; `GET /api/returns`) | Y own selected branch | Y own | **N** | new (2026): for daily cash reconciliation |
| 20b | Order **return** (Return button on a completed bill: items back to stock or damaged, refund, RET- receipt; `POST /api/orders/:id/return`, `/return/preview`, `GET /api/orders/:id/returns`) | Y any | Y own | Y own | new (2026): replaces the cancel action. Staff may return but nothing else in Order History |
| 21 | Advance orders: create, list, update status, timeline, complete (`complete_advance_order_v2`). **Delete: Admin only** | Y any | Y own (no delete, 2026 change) | Y own (no delete, 2026 change) | `advance_orders` in `staffAllowedTabs`; `AdvanceOrders.tsx` has no role gate |
| 22 | **Analytics Dashboard** (`pos_analytics` tab, `/pos-analytics`, `BillingAnalytics`, `analyticsExport`, their data endpoints incl. the order delete inside BillingAnalytics) | Y any | **N** | N | `pos_analytics` admin nav + `/pos-analytics` `AdminOnlyGuard`; `BillingAnalytics` `isAdmin`. Manager exclusion per your rule |
| 23 | Expenses (categories, entries, summary metrics) | Y any | Y own | N | `/expenses` under `AdminOnlyGuard`; `expenses` only in admin nav |
| 24 | Store settings read (own branch) | Y any | Y own | Y own | needed by theme/invoice for everyone |
| 25 | Store settings **write** + logo/branding upload | Y any | **N** (2026 change) | N | `store_settings` admin nav only; `StoreSettingsView` target selector `role === 'admin'` |
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
| Order history | view own branch, **view only + Return** (no status change, no cancel, no delete; see "Order Returns replace Cancellation" below) |
| Low-stock alert | popup + sound, fed by `GET /api/inventory/low-stock-alerts` (name, variant, quantity, threshold of the token's branch only) |


## Manager change (2026): no Coupons, Store Settings or delete

Manager row, final (everything else is unchanged):

| Area | Manager |
|---|---|
| Sidebar | Store Dashboard & POS, Stock & Inventory, Expenses Ledger, Advance & Custom Orders, Order History. **No Coupons, no Store Settings** (deep links redirect to billing) |
| Coupons manage (list, create, edit, delete, activate) | **403** (Admin only). Applying a code at billing keeps `GET /api/coupons/lookup` and `/api/coupons/available` (Manager and Staff, own branch) |
| Store settings write, logo / branding upload | **403** (Admin only). `GET /api/settings` (own branch, display data) stays for bills, PDFs, thermal receipts, sidebar logo and theme |
| Advance order delete, Order delete (incl. the delete on WhatsApp Center online requests) | **403** (Admin only) |
| Still Manager | advance orders view / create / update / complete, order history view / print / status / cancel, inventory, expenses, WhatsApp Center, product image upload |

## Order Returns replace Cancellation (2026)

- **Cancel is removed** (UI, `POST /api/orders/:id/cancel` and the `cancelled` status). Old cancelled bills stay as read-only history.
- **Staff in Order History: view only + Return.** No status change, no delete, no cancel (403 / 404).
- **Manager** keeps the Pending / Completed dropdown; **Admin** also keeps Delete.
- **Return** is allowed to Staff, Manager and Admin, own branch only (Admin follows the branch switcher). Branch comes from the token.
- **Stock can only be put back by**: a return (RETURN row), the Admin deleting a bill (only the never-returned units, see `cancel_order()` in migration 0011), or the advance-order delete. A return and a delete cannot restock the same unit twice.
- Ledger (Movement Audit / Stock History) is Admin and Manager only; Staff has no ledger.

## Customer lookup and coupon sending (2026)

- **Customer data stays per branch.** No customer table, no copied rows, no cross-branch foreign keys. A customer is a phone number on a bill or advance order of the branch.
- **POS lookup** (`POST /api/customers/lookup`, Staff / Manager / Admin, branch from the token, Admin from the switcher, the client never sends a branch): returns ONLY `{ exists_in_this_branch, name, coupons, other_branches }`. `coupons` = this branch's sent coupons for that phone with status (Active / Used / Expired / Limit reached, computed in SQL). `other_branches` = display names of other branches where the number appears, from the one SQL function `customer_other_branches()`; no name, bills, amounts, coupons or counts from those branches. The phone goes in the body (never the URL) and is never logged. Partial / malformed numbers get a 400 with no data. Rate limit: 60 per user (role + branch) and 120 per IP per 5 minutes, database-backed.
- **POS phone suggestions** (`POST /api/customers/suggest`, Staff / Manager / Admin, same branch rule as the lookup): the digits typed so far go in the body (never the URL, never logged); from 4 digits, up to 8 of THIS branch's customers whose number starts with them (bills, advance orders, online requests), as `{ phone, name }` only. Fewer than 4 digits: an empty list. Rate limit: 300 per user and 600 per IP per 5 minutes, database-backed.
- **Product cost, net profit and margin** (Admin Analytics > Products, its CSV and PDF; one calculation in `src/lib/productProfit.ts`): `GET /api/orders?include_items=1` adds `unit_cost` (the line's CURRENT purchase price: the size's, else the product's; 0 = never entered = null) to each bill line for the **Admin only**; Manager and Staff never receive it. Total Cost = unit_cost x units sold net of returns (on the original sale date); Net Profit = Revenue - Total Cost; Margin = Net Profit / Revenue (one decimal, "-" without revenue). A product with any sold unit lacking a purchase price shows "Add purchase price" for all three and is left out of the totals (with a note). Bills keep no cost snapshot.
- **Return refund mode (0017)**: a new return is refunded to ONE mode - Cash, GPay / QR (stored `qr`), Card or Other; "original" (split back to the bill's modes) is rejected by the API and by `process_order_return`. Other needs a typed label (1-40 characters, control characters removed), stored in `order_returns.refund_mode_label` and shown in the Returns list / CSV, return receipt and Order History. Old returns stored as "original" keep their split. Same roles as before (`orders.return`, `returns.list`).
- **Low stock alert switch (0018)**: `store_settings.low_stock_alert_enabled` (default true) per branch, read by Admin / Manager / Staff through `GET /api/settings`, written only by the Admin (`settings.write`; Manager and Staff 403). When off: `GET /api/inventory/low-stock-alerts` returns an empty list, the screens make no low-stock alert requests for that branch, the popup / sound and the Store Hub banner are hidden. Stock list highlighting and reports are unchanged.
- **Sending coupons: Admin only** (`POST /api/coupons/:id/sends`, 403 for Manager and Staff), for the branch selected in the switcher. The PDF is made in the browser and shared as a file only; the send is recorded only after the share / download succeeded.
- **Customer-specific coupons:** only when Admin turns the toggle on in the send modal. Such a coupon is redeemable only on bills whose phone matches one of its customer-specific sends, once per phone; enforced in SQL (`assert_coupon_redeemable`, called by `complete_pos_sale_with_inventory` and the `orders` insert trigger). Coupons never sent, or sent with the toggle off, behave exactly as before.
- **Coupons stay branch-owned:** another branch's coupon is never visible or valid here (the sale function rejects an unknown code).
- Manager and Staff keep `GET /api/coupons/lookup` and `/api/coupons/available` for billing; coupon management stays Admin only.

## Online shop and enquiry dashboard (2026, migration 0016)

| Area | Admin | Manager | Staff | Public (no sign-in) |
|---|---|---|---|---|
| `/shop` page: choose a branch, browse its "show online" products, cart, send a request | - | - | - | **Y** (any active branch) |
| `GET /api/shop/branches`, `GET /api/shop/catalogue/:shop`, `POST /api/shop/enquiries` (`shop.public`, allow-listed) | Y | Y | Y | **Y**: rate limited per IP (reads 300 / 10 min, requests 5 / 15 min), honeypot, idempotency key |
| Online catalogue of a branch: show online, online price, description, sort, image (`shop.catalogue`, `/api/shop-admin/catalogue*`) | **Y** (branch in the switcher) | **N** (403) | **N** (403) | N |
| Enquiry dashboard: list (all branches or one), status, delivery charge, admin note, CSV (`shop.enquiries`, `/api/shop-admin/enquiries*`) | **Y** | **N** (403) | **N** (403) | N |
| New-request popup + sound + sidebar badge | **Y** (only while an Admin tab is open) | N | N | N |

- A request is an **enquiry**, not a bill: no stock movement, no order, no revenue. No payment; the delivery charge is agreed by phone and entered by the Admin.
- The public catalogue never contains cost price, exact stock (only "In stock / Out of stock"), SKU or barcode. The request is re-priced in SQL (`create_shop_enquiry`); any price / name / total sent by the browser is ignored.
- The branch a customer picks is checked against the **active** branches; a product must belong to that branch and be "show online".
- The root address stays the passcode login; old-route redirects and the staff portals are unchanged. Only `/shop` is public.
- The legacy WhatsApp Center (`online_request` bills, Admin + Manager) and the Analytics "Online Bills" (POS sales marked Online) are unchanged and separate from shop requests.

