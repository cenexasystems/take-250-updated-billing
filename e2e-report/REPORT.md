# Browser test report

199 passed, 0 failed (2026-10-06T14:06:06.329Z)

| Result | Area | Check |
|---|---|---|
| PASS | login | /login -> passcode login (not blank) |
| PASS | login | /register -> passcode login (not blank) |
| PASS | login | /profile -> passcode login (not blank) |
| PASS | login | /products -> passcode login (not blank) |
| PASS | login | /products/1 -> passcode login (not blank) |
| PASS | login | /cart -> passcode login (not blank) |
| PASS | login | /checkout -> passcode login (not blank) |
| PASS | login | /favorites -> passcode login (not blank) |
| PASS | login | /gallery -> passcode login (not blank) |
| PASS | login | /whatever -> passcode login (not blank) |
| PASS | login | / -> passcode login (not blank) |
| PASS | login | /dashboard -> passcode login (not blank) |
| PASS | login | /pos -> passcode login (not blank) |
| PASS | login | /expenses -> passcode login (not blank) |
| PASS | login | /pos-analytics -> passcode login (not blank) |
| PASS | login | /admin -> passcode login (not blank) |
| PASS | login | a wrong passcode shows "Invalid passcode" and stays on the login |
| PASS | login | the wrong passcode is not echoed on the page |
| PASS | login | the right passcode signs in |
| PASS | login | the session cookie is httpOnly + SameSite=Strict |
| PASS | login | JavaScript cannot read the session cookie |
| PASS | login | the passcode is not stored in the browser |
| PASS | login | logout returns to the passcode login |
| PASS | login | after logout the old cookie is dead (401) |
| PASS | login | after logout /dashboard needs a passcode again |
| PASS | setup | fixture product + barcode in pos1 |
| PASS | setup | fixture product + barcode in pos2 |
| PASS | setup | fixture product + barcode in pos3 |
| PASS | setup | three branches, three different barcodes |
| PASS | staff pos1 | staff sees POS, Stock, Advance Orders, Order History |
| PASS | staff pos1 | staff sees none of Expenses / Analytics / Coupons / Settings / Passcodes / Global |
| PASS | staff pos1 | header badge reads "STAFF · Branch 1" |
| PASS | staff pos1 | staff has no branch switcher |
| PASS | staff pos1 | staff is blocked from /expenses |
| PASS | staff pos1 | staff is blocked from /pos-analytics |
| PASS | staff pos1 | staff is blocked from /whatsapp-center |
| PASS | staff pos1 | staff is blocked from /dashboard?tab=expenses |
| PASS | staff pos1 | staff is blocked from /dashboard?tab=pos_analytics |
| PASS | staff pos1 | staff is blocked from /dashboard?tab=store_settings |
| PASS | staff pos1 | staff is blocked from /dashboard?tab=coupons |
| PASS | staff pos1 | staff is blocked from /dashboard?tab=staff_memberships |
| PASS | staff pos1 | the API also answers 403 to staff for expenses / analytics / passcodes / global |
| PASS | staff pos1 | inventory shows this branch's item and its PB barcode |
| PASS | staff pos1 | inventory shows none of the other branches' items |
| PASS | staff pos1 | inventory shows none of the other branches' barcodes |
| PASS | staff pos1 | restock +10 in the browser changes this branch's stock (50 -> 60) |
| PASS | staff pos1 | the stock movement was recorded in this branch only |
| PASS | staff pos1 | the other branches' stock was not touched by this restock |
| PASS | staff pos1 | scanning another branch's barcode (P2P10000002) at pos1: "not found" and nothing added to the bill |
| PASS | staff pos1 | the API agrees: 404 for that barcode in this branch |
| PASS | staff pos1 | scanning this branch's barcode (PBP10000002) adds E2E Item 1 |
| PASS | staff pos1 | POS sale completes in pos1 and shows a bill number |
| PASS | staff pos1 | the bill total is ₹100.00 |
| PASS | staff pos1 | the bill is stored in pos1 with the right total |
| PASS | staff pos1 | the sale reduced stock by exactly 1 in this branch (60 -> 59) |
| PASS | staff pos1 | thermal receipt preview contains the bill number |
| PASS | staff pos1 | thermal receipt uses pos1's logo (built-in logo) |
| PASS | staff pos1 | bill view shows #INV10000003, the item and TOTAL ₹100.00 (no NaN) |
| PASS | staff pos1 | PDF invoice downloads as a real PDF for pos1 |
| PASS | staff pos1 | Order History lists the new bill |
| PASS | staff pos1 | Order History shows none of the other branches' bills |
| PASS | staff pos1 | advance order created in pos1 through the screen |
| PASS | staff pos1 | the advance order appears in the list |
| PASS | manager pos1 | manager sees the admin tools (Expenses, Coupons, Store Settings, ...) |
| PASS | manager pos1 | manager has NO Analytics Dashboard in the menu |
| PASS | manager pos1 | manager has no passcode / cross-branch entries |
| PASS | manager pos1 | manager has no branch switcher (fixed branch badge) |
| PASS | manager pos1 | header badge reads "MANAGER · Branch 1" |
| PASS | manager pos1 | manager is blocked from /pos-analytics |
| PASS | manager pos1 | manager is blocked from /dashboard?tab=pos_analytics |
| PASS | manager pos1 | manager is blocked from /dashboard?tab=staff_memberships |
| PASS | manager pos1 | manager is blocked from /dashboard?tab=business_overview |
| PASS | manager pos1 | the API answers 403 to the manager for analytics / passcodes / global |
| PASS | manager pos1 | expense recorded in pos1 through the screen |
| PASS | manager pos1 | the expense shows in the ledger |
| PASS | manager pos1 | the ledger holds none of the other branches' expenses |
| PASS | manager pos1 | Store Settings shows pos1's own profile (not Branch 1) |
| PASS | manager pos1 | manager has no branch tabs in Store Settings |
| PASS | staff pos2 | staff sees POS, Stock, Advance Orders, Order History |
| PASS | staff pos2 | staff sees none of Expenses / Analytics / Coupons / Settings / Passcodes / Global |
| PASS | staff pos2 | header badge reads "STAFF · Branch 2" |
| PASS | staff pos2 | staff has no branch switcher |
| PASS | staff pos2 | staff is blocked from /expenses |
| PASS | staff pos2 | staff is blocked from /pos-analytics |
| PASS | staff pos2 | staff is blocked from /whatsapp-center |
| PASS | staff pos2 | staff is blocked from /dashboard?tab=expenses |
| PASS | staff pos2 | staff is blocked from /dashboard?tab=pos_analytics |
| PASS | staff pos2 | staff is blocked from /dashboard?tab=store_settings |
| PASS | staff pos2 | staff is blocked from /dashboard?tab=coupons |
| PASS | staff pos2 | staff is blocked from /dashboard?tab=staff_memberships |
| PASS | staff pos2 | the API also answers 403 to staff for expenses / analytics / passcodes / global |
| PASS | staff pos2 | inventory shows this branch's item and its P2 barcode |
| PASS | staff pos2 | inventory shows none of the other branches' items |
| PASS | staff pos2 | inventory shows none of the other branches' barcodes |
| PASS | staff pos2 | restock +10 in the browser changes this branch's stock (50 -> 60) |
| PASS | staff pos2 | the stock movement was recorded in this branch only |
| PASS | staff pos2 | the other branches' stock was not touched by this restock |
| PASS | staff pos2 | scanning another branch's barcode (P3P10000002) at pos2: "not found" and nothing added to the bill |
| PASS | staff pos2 | the API agrees: 404 for that barcode in this branch |
| PASS | staff pos2 | scanning this branch's barcode (P2P10000002) adds E2E Item 2 |
| PASS | staff pos2 | POS sale completes in pos2 and shows a bill number |
| PASS | staff pos2 | the bill total is ₹101.00 |
| PASS | staff pos2 | the bill is stored in pos2 with the right total |
| PASS | staff pos2 | the sale reduced stock by exactly 1 in this branch (60 -> 59) |
| PASS | staff pos2 | thermal receipt preview contains the bill number |
| PASS | staff pos2 | thermal receipt uses pos2's logo (built-in logo) |
| PASS | staff pos2 | bill view shows #INV50000002, the item and TOTAL ₹101.00 (no NaN) |
| PASS | staff pos2 | PDF invoice downloads as a real PDF for pos2 |
| PASS | staff pos2 | Order History lists the new bill |
| PASS | staff pos2 | Order History shows none of the other branches' bills |
| PASS | staff pos2 | advance order created in pos2 through the screen |
| PASS | staff pos2 | the advance order appears in the list |
| PASS | manager pos2 | manager sees the admin tools (Expenses, Coupons, Store Settings, ...) |
| PASS | manager pos2 | manager has NO Analytics Dashboard in the menu |
| PASS | manager pos2 | manager has no passcode / cross-branch entries |
| PASS | manager pos2 | manager has no branch switcher (fixed branch badge) |
| PASS | manager pos2 | header badge reads "MANAGER · Branch 2" |
| PASS | manager pos2 | manager is blocked from /pos-analytics |
| PASS | manager pos2 | manager is blocked from /dashboard?tab=pos_analytics |
| PASS | manager pos2 | manager is blocked from /dashboard?tab=staff_memberships |
| PASS | manager pos2 | manager is blocked from /dashboard?tab=business_overview |
| PASS | manager pos2 | the API answers 403 to the manager for analytics / passcodes / global |
| PASS | manager pos2 | expense recorded in pos2 through the screen |
| PASS | manager pos2 | the expense shows in the ledger |
| PASS | manager pos2 | the ledger holds none of the other branches' expenses |
| PASS | manager pos2 | Store Settings shows pos2's own profile (not Branch 1) |
| PASS | manager pos2 | manager has no branch tabs in Store Settings |
| PASS | staff pos3 | staff sees POS, Stock, Advance Orders, Order History |
| PASS | staff pos3 | staff sees none of Expenses / Analytics / Coupons / Settings / Passcodes / Global |
| PASS | staff pos3 | header badge reads "STAFF · Branch 3" |
| PASS | staff pos3 | staff has no branch switcher |
| PASS | staff pos3 | staff is blocked from /expenses |
| PASS | staff pos3 | staff is blocked from /pos-analytics |
| PASS | staff pos3 | staff is blocked from /whatsapp-center |
| PASS | staff pos3 | staff is blocked from /dashboard?tab=expenses |
| PASS | staff pos3 | staff is blocked from /dashboard?tab=pos_analytics |
| PASS | staff pos3 | staff is blocked from /dashboard?tab=store_settings |
| PASS | staff pos3 | staff is blocked from /dashboard?tab=coupons |
| PASS | staff pos3 | staff is blocked from /dashboard?tab=staff_memberships |
| PASS | staff pos3 | the API also answers 403 to staff for expenses / analytics / passcodes / global |
| PASS | staff pos3 | inventory shows this branch's item and its P3 barcode |
| PASS | staff pos3 | inventory shows none of the other branches' items |
| PASS | staff pos3 | inventory shows none of the other branches' barcodes |
| PASS | staff pos3 | restock +10 in the browser changes this branch's stock (50 -> 60) |
| PASS | staff pos3 | the stock movement was recorded in this branch only |
| PASS | staff pos3 | the other branches' stock was not touched by this restock |
| PASS | staff pos3 | scanning another branch's barcode (PBP10000002) at pos3: "not found" and nothing added to the bill |
| PASS | staff pos3 | the API agrees: 404 for that barcode in this branch |
| PASS | staff pos3 | scanning this branch's barcode (P3P10000002) adds E2E Item 3 |
| PASS | staff pos3 | POS sale completes in pos3 and shows a bill number |
| PASS | staff pos3 | the bill total is ₹102.00 |
| PASS | staff pos3 | the bill is stored in pos3 with the right total |
| PASS | staff pos3 | the sale reduced stock by exactly 1 in this branch (60 -> 59) |
| PASS | staff pos3 | thermal receipt preview contains the bill number |
| PASS | staff pos3 | thermal receipt uses pos3's logo (Branch 3 placeholder) |
| PASS | staff pos3 | bill view shows #INV90000002, the item and TOTAL ₹102.00 (no NaN) |
| PASS | staff pos3 | PDF invoice downloads as a real PDF for pos3 |
| PASS | staff pos3 | Order History lists the new bill |
| PASS | staff pos3 | Order History shows none of the other branches' bills |
| PASS | staff pos3 | advance order created in pos3 through the screen |
| PASS | staff pos3 | the advance order appears in the list |
| PASS | manager pos3 | manager sees the admin tools (Expenses, Coupons, Store Settings, ...) |
| PASS | manager pos3 | manager has NO Analytics Dashboard in the menu |
| PASS | manager pos3 | manager has no passcode / cross-branch entries |
| PASS | manager pos3 | manager has no branch switcher (fixed branch badge) |
| PASS | manager pos3 | header badge reads "MANAGER · Branch 3" |
| PASS | manager pos3 | manager is blocked from /pos-analytics |
| PASS | manager pos3 | manager is blocked from /dashboard?tab=pos_analytics |
| PASS | manager pos3 | manager is blocked from /dashboard?tab=staff_memberships |
| PASS | manager pos3 | manager is blocked from /dashboard?tab=business_overview |
| PASS | manager pos3 | the API answers 403 to the manager for analytics / passcodes / global |
| PASS | manager pos3 | expense recorded in pos3 through the screen |
| PASS | manager pos3 | the expense shows in the ledger |
| PASS | manager pos3 | the ledger holds none of the other branches' expenses |
| PASS | manager pos3 | Store Settings shows pos3's own profile (not Branch 1) |
| PASS | manager pos3 | manager has no branch tabs in Store Settings |
| PASS | admin | admin lands on the global view (Business Overview, Staff & Memberships) |
| PASS | admin | the admin branch switcher lists All Branches + the three branches |
| PASS | admin | admin sees Change Passcodes with all 7 passcodes |
| PASS | admin | no passcode hash is shown anywhere |
| PASS | admin | header badge follows the switcher: ADMIN · Branch 1 |
| PASS | admin | branch 1 inventory shows only branch 1 items |
| PASS | admin | right after switching to branch 2 nothing of branch 1 is on screen |
| PASS | admin | branch 2 inventory shows only branch 2 items |
| PASS | admin | header badge: ADMIN · Branch 2 |
| PASS | admin | branch 2 order history shows only branch 2's bill |
| PASS | admin | admin on branch 2: Store Settings opens on branch 2's profile, not Branch 1 |
| PASS | admin | right after switching to branch 3 nothing of branch 2 is on screen |
| PASS | admin | branch 3 inventory shows only branch 3 items |
| PASS | admin | header badge: ADMIN · Branch 3 |
| PASS | admin | branch 3 order history shows only branch 3's bill |
| PASS | admin | admin on branch 3: Store Settings opens on branch 3's profile, not Branch 1 |
| PASS | admin | the admin can open the Analytics Dashboard |
| PASS | admin | a branch id in the request body is refused even for the admin |
| PASS | polling | tab B (same session) created a product and a bill |
| PASS | polling | tab A (Order History) shows the new bill by itself, no reload (5 s) |
| PASS | polling | tab C (POS catalogue) shows the new product by itself, no reload (5 s) |
| PASS | polling | a change in another branch never appears in this branch's tab |
| PASS | summary | no uncaught page errors / console errors in any flow |

## Screenshots
- 01-login-page.png
- 02-login-wrong-passcode.png
- 03-staff-pos1-inventory.png
- 04-staff-pos1-wrong-branch-scan.png
- 05-staff-pos1-pos-before-sale.png
- 06-staff-pos1-bill-generated.png
- 07-thermal-preview-pos1.png
- 08-staff-pos1-bill-view.png
- 09-staff-pos1-advance-form.png
- 10-staff-pos1-advance-orders.png
- 11-manager-pos1-expenses.png
- 12-staff-pos2-inventory.png
- 13-staff-pos2-wrong-branch-scan.png
- 14-staff-pos2-pos-before-sale.png
- 15-staff-pos2-bill-generated.png
- 16-thermal-preview-pos2.png
- 17-staff-pos2-bill-view.png
- 18-staff-pos2-advance-form.png
- 19-staff-pos2-advance-orders.png
- 20-manager-pos2-expenses.png
- 21-staff-pos3-inventory.png
- 22-staff-pos3-wrong-branch-scan.png
- 23-staff-pos3-pos-before-sale.png
- 24-staff-pos3-bill-generated.png
- 25-thermal-preview-pos3.png
- 26-staff-pos3-bill-view.png
- 27-staff-pos3-advance-form.png
- 28-staff-pos3-advance-orders.png
- 29-manager-pos3-expenses.png
- 30-admin-global.png
- 31-admin-change-passcodes.png
- 32-admin-branch1-inventory.png
- 33-admin-branch2-inventory.png
- 34-admin-branch3-inventory.png
- 35-admin-analytics.png
- 36-polling-pos-tab.png
- 37-polling-history-tab-updated.png
- 38-polling-catalogue-tab-updated.png