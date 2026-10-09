# Vercel preview deploy: checklist

For this setup: Neon Postgres (project region **us-east-2**), Express API as one Vercel function (`api/index.ts`), Vercel Blob for files, Windows + PowerShell on your machine.
Nothing below needs a passcode, token or connection string pasted into a chat, a commit or a screenshot. Keep them in the Vercel dashboard and in your own PowerShell session.

## 0. Before you start

- [ ] `main` (or the branch you deploy) is pushed to GitHub and the Vercel project exists (Framework **Vite**, already set in `vercel.json`).
- [ ] Locally green: `npm run build`, `npm run test:isolation`, `npm run test:api`.
- [ ] You know which Neon project is **production** and which is **dev**. The preview must never point at either.

## 1. Neon: a dedicated preview branch

1. Neon Console → your project → **Branches** → **Create branch**. Name it `preview`.
   - **Parent:** pick a parent that has **no real data** (an empty or migrated-only branch). A branch copies its parent's rows, including the passcode hashes, so branching from dev or production would give the preview the same passcodes and real data.
   - If you only have one populated branch, branch from it anyway and then run step 4 with `--force` so every passcode is replaced, and delete test rows (`npm run db:reset-dev -- --yes`, see step 4).
2. Open the new branch → **Connect** → turn **Connection pooling ON** → copy the connection string. Its host contains `-pooler`. This is the preview `DATABASE_URL`.
3. Keep that string only in (a) Vercel, step 3 below, and (b) your PowerShell session for step 4.

Optional, not recommended here: the Neon–Vercel integration creates a database branch for every preview deployment. Each of those would be empty and need migrating and seeding, so use the single fixed `preview` branch instead.

## 2. Vercel Blob store

1. Vercel dashboard → the project → **Storage** → **Create Database** → **Blob** → name it e.g. `yg-billing-preview`.
2. Access must be **Public**: the API stores files with `access: 'public'` and the app shows them by URL (product images, logos, invoice PDFs).
3. **Connect to Project**, tick **Preview** (and Production later, ideally with its own separate store). Connecting adds `BLOB_READ_WRITE_TOKEN` to those environments automatically.
4. Known limit: Vercel rejects request bodies over **4.5 MB** before the function runs, so the API and the app both cap every upload at **4 MB** ("Image too large, max 4 MB"). The only PDFs uploaded are the invoice PDFs the browser generates (a few hundred KB); the heavier screenshot-style PDF is only ever downloaded, never uploaded.

## 3. Vercel environment variables (scope: Preview only)

Project → **Settings → Environment Variables**. For each one, untick Production and Development, tick **Preview**.

| Name | Value | Notes |
|---|---|---|
| `DATABASE_URL` | the **pooled** (`-pooler`) string of the Neon `preview` branch | never the dev or production string |
| `JWT_SECRET` | a new random value, at least 32 chars | generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Different from production; changing it later signs everyone out |
| `BLOB_READ_WRITE_TOKEN` | added by step 2 | do not type it in; just check it is listed under Preview |

Do **not** set on Vercel: `COOKIE_INSECURE` (it would drop the `Secure` flag), `SEED_PASSCODE_*` (seeding is done from your machine), `TRUST_PROXY` (not needed on Vercel).
Changing an env var only affects **new** deployments: redeploy after any change.

## 4. Migrate and seed the preview database (from your machine)

`.env` holds your dev database, so point this PowerShell window at the preview one. `dotenv` never overrides variables that are already set, so the values below win over `.env`.

```powershell
cd "C:\TAKE -250 UPDATED\yg-billing"

# preview database (paste the pooled string between the quotes; do not echo it)
$env:DATABASE_URL = '<preview pooled connection string>'

# the 7 preview passcodes: 8+ characters, all different, NOT the dev ones
$env:SEED_PASSCODE_ADMIN            = '<new>'
$env:SEED_PASSCODE_MANAGER_BRANCH1  = '<new>'
$env:SEED_PASSCODE_MANAGER_BRANCH2  = '<new>'
$env:SEED_PASSCODE_MANAGER_BRANCH3  = '<new>'
$env:SEED_PASSCODE_STAFF_BRANCH1    = '<new>'
$env:SEED_PASSCODE_STAFF_BRANCH2    = '<new>'
$env:SEED_PASSCODE_STAFF_BRANCH3    = '<new>'

npm run db:migrate      # expect: apply 0001 ... 0004, "Migrations complete."
npm run db:seed         # expect: set admin / set manager / pos1 ... (7 lines). Add -- --force if the branch already had passcodes
```

- [ ] `db:migrate` printed `apply` (first time) or `skip` (already done) for all four files and no `FAILED`.
- [ ] `db:seed` printed 7 lines and no "Seed aborted".
- [ ] Close the PowerShell window afterwards so the passcodes and the URL leave the session (or run `Remove-Item Env:DATABASE_URL, Env:SEED_PASSCODE_*`).
- [ ] If migrate times out on the pooled host, retry with the same string minus `-pooler` (the direct host). That is only for this one-off command; Vercel keeps the pooled string.
- [ ] Never run `npm run db:reset`, `db:reset-dev` or the test scripts with the **production** string set. `db:reset` and `db:reset-dev` refuse only when `NODE_ENV` / `VERCEL_ENV` says production, which a shell on your machine never does, so the check is on you. The tests insert and roll back, but do not run them against a database that holds real data.

## 5. Deploy

1. Push a branch / open a pull request, or **Deployments → Redeploy** (needed after step 3 if a deployment already exists).
2. Wait for **Ready**. Open the deployment's URL.
3. Deployment Protection: preview URLs normally need a Vercel login. Open the URL while signed in to Vercel, or for command-line checks use the project's **Protection Bypass for Automation** secret (header `x-vercel-protection-bypass`). Do not turn protection off for a database that holds real data.
4. Region: functions run in `iad1` (Washington) by default, close to Neon `us-east-2`. Nothing to change.

## 6. Post-deploy smoke test

Let `URL` be the preview address, e.g. `https://yg-billing-git-xyz.vercel.app`.

### A. Plumbing (30 seconds, no login)

- [ ] `curl.exe -s URL/api/health` → `{"status":"ok","database":"up","environment":"preview"}`. Nothing else in the body.
  - `503 Database unavailable` → wrong or unreachable `DATABASE_URL`, or the Neon branch is suspended (retry once, a cold start can take a second).
  - `503 Server settings missing: JWT_SECRET, ...` → add the named variable, redeploy.
- [ ] `curl.exe -s -o NUL -w "%{http_code}" URL/api/auth/me` → `401` (the API answers and rejects anonymous callers).
- [ ] `curl.exe -sI URL/api/health` shows `Cache-Control: no-store`.
- [ ] Open `URL/cart`, `URL/login`, `URL/products`: each lands on the passcode login, not a blank page.

### B. Login and portals (use the preview passcodes)

- [ ] Wrong passcode → "Incorrect passcode", stays on the login.
- [ ] Admin passcode → global view. Header badge "ADMIN"; branch switcher lists All Branches + 3 branches; Analytics Dashboard and **Change passcodes** present.
- [ ] Manager Branch 2 passcode → badge "MANAGER · Branch 2", no switcher, **no** Analytics Dashboard, no passcode section.
- [ ] Staff Branch 3 passcode → badge "STAFF · Branch 3", only POS / Stock / Advance Orders / Order History. `URL/expenses` and `/dashboard?tab=pos_analytics` bounce back.
- [ ] Browser dev tools → Application → Cookies: `yg_session` is **HttpOnly**, **Secure**, **SameSite=Strict**; `document.cookie` in the console does not show it.
- [ ] Logout, then reload: you are at the passcode login.

### B2. Take250 branding (the migrations seed it, so a fresh preview must already show it)

- [ ] Login page: Take250 shirt-shop logo, no Jute / Fireworks / YG text anywhere.
- [ ] Header badge / branch switcher names: `Take250 Karanthai`, `Take250 Kinathukadavu`, `Take250 Pollachi`.
- [ ] Admin → Store Settings per branch: shop name `Take250 Shop - Dress & Footwear` (Branches 1, 2) / `Take250 Women's Wear` (Branch 3), owner `M. Ramkumar`, phones `+91 88831 73358, +91 73393 44149`, email `take250shop@gmail.com`, Instagram `take.250shop`, and the right address for each branch.
- [ ] Open any bill (`/invoice/<number>`): that branch's logo, name and address only.

### C. Data and isolation (create a few rows; delete them after)

- [ ] As Admin (Branch 1): Add / Edit Products → create "Preview Test Item", then Stock → Add Barcode / receive 10. The barcode starts `PB`.
- [ ] As Admin switched to Branch 2: the item is **not** there. Create one; its barcode starts `P2`. Branch 3 → `P3`.
- [ ] As Staff Branch 1 on POS: scan the Branch 2 barcode → "not found". Scan the Branch 1 barcode → added. Complete a sale (name, 10-digit mobile, cash) → "Bill Generated Successfully". Stock drops by 1.
- [ ] Print Receipt opens the thermal preview: black logo on white (no solid black badge), shop name, address, `Ph:` both numbers, email. Branch 1 = Karanthai address, Branch 2 = Kinathukadavu (Coimbatore 642109), Branch 3 = women's wear logo and "No. 853, Bhagvati Palayam, Pollachi - 642109".
- [ ] Open the bill (`/invoice/<number>`): total is a real amount (not NaN), **PDF Invoice** downloads and opens.
- [ ] Order History (Branch 1) shows that bill; Branch 2's staff session does not.
- [ ] Advance Orders: create one (deposit less than total), it appears in the list.
- [ ] Manager Branch 1: Expenses → Record Expense (250). It shows in the ledger; Staff has no Expenses.
- [ ] Public link `URL/invoice/<number>` works in a private window without logging in.

### D. Blob uploads (the one thing never tested locally)

- [ ] Admin → Store Settings → upload a small PNG as the branch logo and Save. The logo shows in the header and on the thermal preview.
- [ ] Open the logo's address in a new tab: it is a `…public.blob.vercel-storage.com/pos1/branding/…` URL and loads without a login.
- [ ] Add a product image (about 1 MB). Then try one over 4 MB: the app must say "Image too large, max 4 MB" without sending it.
- [ ] Vercel dashboard → Storage → Blob lists the files under `pos1/…`, `pos2/…`: paths always start with the branch id.

### E. Polling and sessions

- [ ] Two browsers (or one normal + one private window), both Staff Branch 1 (each signs in separately). Create a product in one; within about 15 s it appears in the other without a reload. A change made in Branch 2 never appears in Branch 1.
- [ ] Hide a tab for a minute (switch tabs): Network shows no `poll/stamps` requests while hidden; they resume on return.
- [ ] Wait for or force a 401 (clear the cookie in dev tools): the next click returns to the login with no stale data on screen.

### F. Abuse and limits

- [ ] 10 wrong passcodes in 10 minutes from one device on the SAME tab + branch → the screen shows "Too many attempts. Try again in 4:5x" (counting down) and the button is disabled; it clears itself after 5 minutes. Another branch or role from the same network is not affected. To unlock sooner: Admin → Staff & Memberships → Login Lockouts → Clear lockouts. Do this last, and from a device you can spare.
- [ ] `curl.exe -s -X POST URL/api/products -H "content-type: application/json" -d "{}"` → `401`.
- [ ] Vercel → **Logs** (Runtime Logs) for the deployment: no stack traces, and no passcode, token or connection string anywhere in them.

### G. Clean up

- [ ] Delete the test products, bills and expenses through the app (Admin has the delete actions), or wipe the whole preview branch from your PowerShell session (still holding the preview `DATABASE_URL` and the seven `SEED_PASSCODE_*`): `npm run db:reset-dev -- --yes --hard`. That drops the schema, re-runs the migrations and re-seeds the passcodes from your session variables.
- [ ] Admin → **Change passcodes**: replace the seeded preview passcodes with ones only you know.
- [ ] Note the preview URL, the Neon branch name and the Blob store name somewhere safe.

## 7. If something fails

| Symptom | Likely cause |
|---|---|
| Every page is "Vercel Authentication" | Deployment Protection (step 5.3), not the app |
| `/api/health` 503 "Database unavailable" | `DATABASE_URL` wrong / not Preview-scoped / not redeployed; Neon branch suspended |
| `/api/health` 503 "Server settings missing" | the named variable is missing for the Preview environment; redeploy after adding |
| Login always "Incorrect passcode" | the preview database was not seeded (step 4), or seeded with different passcodes |
| Login works, then logged out at once | `JWT_SECRET` changed between requests, or `COOKIE_INSECURE=1` set on Vercel |
| Upload fails with 413 | file over 4 MB (app limit; Vercel's own limit is 4.5 MB) |
| Upload fails with 500 | Blob store not connected to **Preview**, or not Public |
| First request after idle is slow | Neon autosuspend + function cold start; the second request is fast |
