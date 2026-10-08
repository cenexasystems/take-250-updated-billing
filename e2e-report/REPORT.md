# Browser test report

251 passed, 0 failed (2026-10-08T14:59:18.689Z)

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
| PASS | login | the login screen names no role, portal, branch, shop or product line |
| PASS | login | the login screen has no tabs and no branch tiles |
| PASS | login | the login screen is one logo and one passcode field |
| PASS | login | a wrong passcode shows "Incorrect passcode" and stays on the login |
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
| PASS | setup | a fourth variant with an existing barcode is refused (409) |
| PASS | staff pos1 | staff sees POS, Stock, Advance Orders, Order History |
| PASS | staff pos1 | staff sees none of Expenses / Analytics / Coupons / Settings / Passcodes / Global |
| PASS | staff pos1 | staff header badge reads just STAFF and the screen never says Branch 1/2/3 |
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
| PASS | staff pos1 | the staff POS screen never says Branch 1/2/3 and shows no branch switcher |
| PASS | staff pos1 | POS sale completes in pos1 and shows a bill number |
| PASS | staff pos1 | the bill total is ₹100.00 |
| PASS | staff pos1 | the bill is stored in pos1 with the right total |
| PASS | staff pos1 | the sale reduced stock by exactly 1 in this branch (60 -> 59) |
| PASS | staff pos1 | thermal receipt preview contains the bill number |
| PASS | staff pos1 | thermal receipt prints pos1's built-in Take250 logo |
| PASS | staff pos1 | thermal receipt prints pos1's own address only |
| PASS | staff pos1 | thermal logo for pos1 is black artwork on white (corner 255,255,255, dark 16%) |
| PASS | staff pos1 | bill view shows #INV10000004, the item and TOTAL ₹100.00 (no NaN) |
| PASS | staff pos1 | bill view shows pos1's own address and no other branch's |
| PASS | staff pos1 | bill view shows the shared Instagram, phone and email |
| PASS | staff pos1 | bill view shows pos1's logo (yg-logo-pos1) |
| PASS | staff pos1 | bill view has no trace of the old business name |
| PASS | staff pos1 | tapping Complete Sale twice made exactly ONE bill |
| PASS | staff pos1 | a bill with GST shows CGST ₹9.00 and SGST ₹9.01 (not one GST line) |
| PASS | staff pos1 | the database stores cgst_amount 9.00 and sgst_amount 9.01 |
| PASS | staff pos1 | scanning E2E-SAL-XXXL adds variant XXXL at ₹300 |
| PASS | staff pos1 | scanning E2E-SAL-XL adds variant XL at ₹100 |
| PASS | staff pos1 | scanning E2E-SAL-XXL adds variant XXL at ₹200 |
| PASS | staff pos1 | the cart holds three different variant lines at 100, 200 and 300 (not three times the first price) |
| PASS | staff pos1 | PDF invoice downloads as a real PDF for pos1 |
| PASS | staff pos1 | Order History lists the new bill |
| PASS | staff pos1 | staff have no Cancelled option in Order History |
| PASS | staff pos1 | Order History shows none of the other branches' bills |
| PASS | staff pos1 | advance order created in pos1 through the screen |
| PASS | staff pos1 | the advance order appears in the list |
| PASS | manager pos1 | manager sees the admin tools (Expenses, Coupons, Store Settings, ...) |
| PASS | manager pos1 | manager has NO Analytics Dashboard in the menu |
| PASS | manager pos1 | manager has no passcode / cross-branch entries |
| PASS | manager pos1 | manager has no branch switcher (fixed branch badge) |
| PASS | manager pos1 | manager header badge reads just MANAGER and the screen never says Branch 1/2/3 |
| PASS | manager pos1 | manager is blocked from /pos-analytics |
| PASS | manager pos1 | manager is blocked from /dashboard?tab=pos_analytics |
| PASS | manager pos1 | manager is blocked from /dashboard?tab=staff_memberships |
| PASS | manager pos1 | manager is blocked from /dashboard?tab=business_overview |
| PASS | manager pos1 | the API answers 403 to the manager for analytics / passcodes / global |
| PASS | manager pos1 | expense recorded in pos1 through the screen |
| PASS | manager pos1 | the expense shows in the ledger |
| PASS | manager pos1 | the ledger holds none of the other branches' expenses |
| PASS | manager pos1 | the manager cancels a bill from Order History in pos1 (reason and who are stored) |
| PASS | manager pos1 | cancelling put the item back in stock (+1) |
| PASS | manager pos1 | a cancelled bill's status can no longer be changed (dropdown disabled) |
| PASS | manager pos1 | Store Settings shows pos1's own profile (not Branch 1) |
| PASS | manager pos1 | manager has no branch tabs in Store Settings |
| PASS | staff pos2 | staff sees POS, Stock, Advance Orders, Order History |
| PASS | staff pos2 | staff sees none of Expenses / Analytics / Coupons / Settings / Passcodes / Global |
| PASS | staff pos2 | staff header badge reads just STAFF and the screen never says Branch 1/2/3 |
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
| PASS | staff pos2 | the staff POS screen never says Branch 1/2/3 and shows no branch switcher |
| PASS | staff pos2 | POS sale completes in pos2 and shows a bill number |
| PASS | staff pos2 | the bill total is ₹101.00 |
| PASS | staff pos2 | the bill is stored in pos2 with the right total |
| PASS | staff pos2 | the sale reduced stock by exactly 1 in this branch (60 -> 59) |
| PASS | staff pos2 | thermal receipt preview contains the bill number |
| PASS | staff pos2 | thermal receipt prints pos2's built-in Take250 logo |
| PASS | staff pos2 | thermal receipt prints pos2's own address only |
| PASS | staff pos2 | thermal logo for pos2 is black artwork on white (corner 255,255,255, dark 16%) |
| PASS | staff pos2 | bill view shows #INV50000001, the item and TOTAL ₹101.00 (no NaN) |
| PASS | staff pos2 | bill view shows pos2's own address and no other branch's |
| PASS | staff pos2 | bill view shows the shared Instagram, phone and email |
| PASS | staff pos2 | bill view shows pos2's logo (yg-logo-pos2) |
| PASS | staff pos2 | bill view has no trace of the old business name |
| PASS | staff pos2 | PDF invoice downloads as a real PDF for pos2 |
| PASS | staff pos2 | Order History lists the new bill |
| PASS | staff pos2 | staff have no Cancelled option in Order History |
| PASS | staff pos2 | Order History shows none of the other branches' bills |
| PASS | staff pos2 | advance order created in pos2 through the screen |
| PASS | staff pos2 | the advance order appears in the list |
| PASS | manager pos2 | manager sees the admin tools (Expenses, Coupons, Store Settings, ...) |
| PASS | manager pos2 | manager has NO Analytics Dashboard in the menu |
| PASS | manager pos2 | manager has no passcode / cross-branch entries |
| PASS | manager pos2 | manager has no branch switcher (fixed branch badge) |
| PASS | manager pos2 | manager header badge reads just MANAGER and the screen never says Branch 1/2/3 |
| PASS | manager pos2 | manager is blocked from /pos-analytics |
| PASS | manager pos2 | manager is blocked from /dashboard?tab=pos_analytics |
| PASS | manager pos2 | manager is blocked from /dashboard?tab=staff_memberships |
| PASS | manager pos2 | manager is blocked from /dashboard?tab=business_overview |
| PASS | manager pos2 | the API answers 403 to the manager for analytics / passcodes / global |
| PASS | manager pos2 | expense recorded in pos2 through the screen |
| PASS | manager pos2 | the expense shows in the ledger |
| PASS | manager pos2 | the ledger holds none of the other branches' expenses |
| PASS | manager pos2 | the manager cancels a bill from Order History in pos2 (reason and who are stored) |
| PASS | manager pos2 | cancelling put the item back in stock (+1) |
| PASS | manager pos2 | a cancelled bill's status can no longer be changed (dropdown disabled) |
| PASS | manager pos2 | Store Settings shows pos2's own profile (not Branch 1) |
| PASS | manager pos2 | manager has no branch tabs in Store Settings |
| PASS | staff pos3 | staff sees POS, Stock, Advance Orders, Order History |
| PASS | staff pos3 | staff sees none of Expenses / Analytics / Coupons / Settings / Passcodes / Global |
| PASS | staff pos3 | staff header badge reads just STAFF and the screen never says Branch 1/2/3 |
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
| PASS | staff pos3 | the staff POS screen never says Branch 1/2/3 and shows no branch switcher |
| PASS | staff pos3 | POS sale completes in pos3 and shows a bill number |
| PASS | staff pos3 | the bill total is ₹102.00 |
| PASS | staff pos3 | the bill is stored in pos3 with the right total |
| PASS | staff pos3 | the sale reduced stock by exactly 1 in this branch (60 -> 59) |
| PASS | staff pos3 | thermal receipt preview contains the bill number |
| PASS | staff pos3 | thermal receipt prints pos3's built-in Take250 logo |
| PASS | staff pos3 | thermal receipt prints pos3's own address only |
| PASS | staff pos3 | thermal logo for pos3 is black artwork on white (corner 255,255,255, dark 23%) |
| PASS | staff pos3 | bill view shows #INV90000001, the item and TOTAL ₹102.00 (no NaN) |
| PASS | staff pos3 | bill view shows pos3's own address and no other branch's |
| PASS | staff pos3 | bill view shows the shared Instagram, phone and email |
| PASS | staff pos3 | bill view shows pos3's logo (yg-logo-pos3) |
| PASS | staff pos3 | bill view has no trace of the old business name |
| PASS | staff pos3 | PDF invoice downloads as a real PDF for pos3 |
| PASS | staff pos3 | Order History lists the new bill |
| PASS | staff pos3 | staff have no Cancelled option in Order History |
| PASS | staff pos3 | Order History shows none of the other branches' bills |
| PASS | staff pos3 | advance order created in pos3 through the screen |
| PASS | staff pos3 | the advance order appears in the list |
| PASS | manager pos3 | manager sees the admin tools (Expenses, Coupons, Store Settings, ...) |
| PASS | manager pos3 | manager has NO Analytics Dashboard in the menu |
| PASS | manager pos3 | manager has no passcode / cross-branch entries |
| PASS | manager pos3 | manager has no branch switcher (fixed branch badge) |
| PASS | manager pos3 | manager header badge reads just MANAGER and the screen never says Branch 1/2/3 |
| PASS | manager pos3 | manager is blocked from /pos-analytics |
| PASS | manager pos3 | manager is blocked from /dashboard?tab=pos_analytics |
| PASS | manager pos3 | manager is blocked from /dashboard?tab=staff_memberships |
| PASS | manager pos3 | manager is blocked from /dashboard?tab=business_overview |
| PASS | manager pos3 | the API answers 403 to the manager for analytics / passcodes / global |
| PASS | manager pos3 | expense recorded in pos3 through the screen |
| PASS | manager pos3 | the expense shows in the ledger |
| PASS | manager pos3 | the ledger holds none of the other branches' expenses |
| PASS | manager pos3 | the manager cancels a bill from Order History in pos3 (reason and who are stored) |
| PASS | manager pos3 | cancelling put the item back in stock (+1) |
| PASS | manager pos3 | a cancelled bill's status can no longer be changed (dropdown disabled) |
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
| PASS | polling | tab A (Order History) shows the new bill by itself, no reload (4 s) |
| PASS | polling | tab C (POS catalogue) shows the new product by itself, no reload (5 s) |
| PASS | polling | a change in another branch never appears in this branch's tab |
| PASS | lockout | a locked device shows "Try again in M:SS" (about 5 minutes) |
| PASS | lockout | the lockout message replaces "Incorrect passcode" and the page stays on the login |
| PASS | lockout | the sign-in button is disabled while locked |
| PASS | lockout | another device on the same network can still sign in |
| PASS | lockout | the admin clears the lockouts |
| PASS | lockout | the locked-out device signs in right after the admin cleared the lockouts |
| PASS | logos | Branch 1 and Branch 2 print the same (shirt shop) logo |
| PASS | logos | Branch 3 prints its own (women's wear) logo |
| PASS | summary | no uncaught page errors / console errors in any flow |

## Screenshots
- 01-login-page.png
- 02-login-final.png
- 03-login-wrong-passcode.png
- 04-staff-pos1-inventory.png
- 05-staff-pos1-wrong-branch-scan.png
- 06-staff-pos1-pos-before-sale.png
- 07-staff-pos1-bill-generated.png
- 08-thermal-preview-pos1.png
- 09-staff-pos1-bill-view.png
- 10-pos-variants-scanned.png
- 11-staff-pos1-advance-form.png
- 12-staff-pos1-advance-orders.png
- 13-manager-pos1-expenses.png
- 14-manager-pos1-cancelled-bill.png
- 15-staff-pos2-inventory.png
- 16-staff-pos2-wrong-branch-scan.png
- 17-staff-pos2-pos-before-sale.png
- 18-staff-pos2-bill-generated.png
- 19-thermal-preview-pos2.png
- 20-staff-pos2-bill-view.png
- 21-staff-pos2-advance-form.png
- 22-staff-pos2-advance-orders.png
- 23-manager-pos2-expenses.png
- 24-manager-pos2-cancelled-bill.png
- 25-staff-pos3-inventory.png
- 26-staff-pos3-wrong-branch-scan.png
- 27-staff-pos3-pos-before-sale.png
- 28-staff-pos3-bill-generated.png
- 29-thermal-preview-pos3.png
- 30-staff-pos3-bill-view.png
- 31-staff-pos3-advance-form.png
- 32-staff-pos3-advance-orders.png
- 33-manager-pos3-expenses.png
- 34-manager-pos3-cancelled-bill.png
- 35-admin-global.png
- 36-admin-change-passcodes.png
- 37-admin-branch1-inventory.png
- 38-admin-branch2-inventory.png
- 39-admin-branch3-inventory.png
- 40-admin-analytics.png
- 41-polling-pos-tab.png
- 42-polling-history-tab-updated.png
- 43-polling-catalogue-tab-updated.png
- 44-login-locked.png