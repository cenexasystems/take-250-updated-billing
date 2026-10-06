# YG Enterprises Billing

React + Vite point-of-sale and inventory administration for YG Enterprises, with three isolated branches (Branch 1, Branch 2, Branch 3), a passcode-only login and three portals: **Admin**, **Manager** and **Staff**. Data lives in **Neon Postgres**, served through a small Express API (`server/`, deployed as one Vercel function in `api/index.ts`). Files go to **Vercel Blob**.

The screens, invoices, PDFs, thermal receipts, CSV exports and barcode labels are the original app's; only the login, the three portals, the branch badge / switcher, the Change passcodes section, the black-and-gold colours and the backend plumbing differ.

## How access works

| Portal | Branches | Can do |
|---|---|---|
| Admin | all three (switcher in the sidebar and POS header) | everything, incl. Analytics Dashboard, cross-branch views, Change passcodes |
| Manager | one (locked) | the admin's tools for that branch, **no** Analytics Dashboard, no passcode management, no cross-branch views |
| Staff | one (locked) | the original staff permissions (POS, stock, advance orders, order history), no deletes / settings / expenses |

One passcode opens exactly one portal. Passcodes are stored only as bcrypt hashes. The session is an `httpOnly`, `sameSite=strict`, `Secure` cookie (8 h); the **branch always comes from that cookie** for Staff and Manager. The browser never sends a branch for them, and the API rejects any attempt (body, query or header). Only the Admin selects a branch (`?branch_id=`, validated against the `branches` table). The full rules are in [docs/ROLE_MATRIX.md](docs/ROLE_MATRIX.md); the code-level source of truth is `server/lib/permissions.ts` (API, default deny) and `src/lib/permissions.ts` (UI), and `npm run test:api` checks that they agree.

Isolation is also enforced by the database itself: every table has a `branch_id`, children reference parents with composite `(id, branch_id)` foreign keys, invoice numbers and barcodes have per-branch ranges / prefixes (barcode prefixes PB, P2, P3), and `register_branch()` allocates all of that for a future branch.

## Local setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill it in (see below).
3. Create the schema and the three branches: `npm run db:migrate`
4. Set the seven passcodes (hashed, from the `SEED_PASSCODE_*` variables): `npm run db:seed`
5. Run the API and the app together: `npm run dev:full` (API + built app on <http://localhost:4310>), or `npm run dev` for the Vite dev server only (needs the API running on the same origin).

`npm run db:reset -- --yes` **drops everything** in the `public` schema and re-applies the migrations. Development databases only.

## Environment

Server only (never prefix with `VITE_`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon connection string. **Use the pooled (`-pooler`) URL in production and on Vercel.** |
| `JWT_SECRET` | at least 32 random characters, signs the session cookie |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob read/write token (product images, invoice PDFs, logos) |
| `SEED_PASSCODE_ADMIN`, `SEED_PASSCODE_MANAGER_BRANCH1..3`, `SEED_PASSCODE_STAFF_BRANCH1..3` | initial passcodes for `npm run db:seed` only (min 8 chars, all different). Remove them after seeding and change them from Admin → Change passcodes |
| `LOGIN_SLOWDOWN_STEP_MS`, `LOGIN_SLOWDOWN_MAX_MS` | optional; default 200 ms per failure beyond 10 system-wide, capped at 4000 ms |

Public (bundled into the frontend): `VITE_WHATSAPP_NUMBER`.

> **Direct Neon URL, tests only.** `npm run test:api` and `npm run test:isolation` run one long transaction that is rolled back. Neon's pooled endpoint drops a connection that stays open for several minutes, so `scripts/test-env.ts` automatically swaps `-pooler` out of `DATABASE_URL` for those two scripts. Nothing else uses the direct URL; production keeps the pooled one.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | type-check + production build |
| `npm run typecheck:server` | type-check the API |
| `npm run test:isolation` | database isolation tests (rolled back) |
| `npm run test:api` | API tests: every route × every role, forged branches, tokens, passcode changes, rate limits, barcodes, uploads, polling (rolled back) |
| `npm run test:e2e` | real-browser tests (Playwright, Chromium) across all branches and roles; screenshots in `e2e-report/` |
| `npm run db:migrate` / `db:seed` / `db:reset` | schema, passcodes, full reset |
| `npm run db:reset-dev -- --yes` | restores a clean **dev** state: removes leftovers of interrupted test runs and puts the invoice / barcode counters back to "highest number used". Add `--hard` to also drop the schema, re-migrate and re-seed |

`test:isolation` and `test:api` repair those counters at the start and restore them in a `finally` block (also on Ctrl+C), so an interrupted run cannot leave them moved; `db:reset-dev` is the fallback after a hard kill.

`GET /api/health` (no login) checks the database connection and returns only `{status, database, environment}`; it answers 503 "Database unavailable" or lists the **names** of missing settings, never a secret.

## Deploying on Vercel (preview or production)

Step-by-step preview checklist (Neon preview branch, env vars, Blob store, migrate + seed, smoke tests): [docs/VERCEL_PREVIEW.md](docs/VERCEL_PREVIEW.md).

1. Create the project from this repository. Framework: **Vite** (already in `vercel.json`).
2. **Storage → Blob → Create store** and connect it to the project: this adds `BLOB_READ_WRITE_TOKEN`.
3. **Settings → Environment Variables** (Production and Preview): `DATABASE_URL` (pooled Neon URL), `JWT_SECRET`, `VITE_WHATSAPP_NUMBER`. Use a separate Neon branch for Preview.
4. Rewrites are in `vercel.json`: `/api/*` → the Express function `api/index.ts`; every other path → `index.html` (the SPA). API responses are sent with `Cache-Control: no-store`, and the service worker never caches `/api`.
5. Once, against that database from your machine: `npm run db:migrate && npm run db:seed` (with the `SEED_PASSCODE_*` variables in your local `.env`).
6. Deploy. Old customer-storefront URLs (`/login`, `/register`, `/profile`, `/products`, `/cart`, …) redirect to the passcode login.

`TRUST_PROXY` is not needed on Vercel (the platform's forwarded IP header is trusted automatically via `VERCEL=1`).

## Barcodes and branches

Generated barcodes are `<prefix><P|V><8 digits>` (e.g. `PBP10000001`) with an independent sequence per branch; the prefix identifies the branch and a database trigger rejects a mismatch. Manufacturer barcodes are unique per branch only. Scanning always looks up inside the current branch, so another branch's barcode is "not found".

Label settings and custom label sizes are kept in the browser's `localStorage` under `yg:barcode-settings:<branch_id>` and `yg:label-sizes:<branch_id>`, and are cleared on login, logout and every branch switch.

Brand assets are located in `public/` (`yg-logo*.png`, `branch-placeholder.svg` for Branch 3 until its real logo is added in Store Settings).
