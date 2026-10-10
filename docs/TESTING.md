# Running the tests safely

`npm run test:api`, `npm run test:isolation` and `npm run test:e2e` write to a real database (the API tests inside one rolled-back
transaction, `test:e2e` for real, with data named "E2E ..."). They must never point at the preview or production database.

1. In the Neon console create a branch just for tests (for example `test`) from `main`.
2. Put its connection string in `.env` as `TEST_DATABASE_URL` (the direct string is best; a pooled one is converted).
3. Apply the migrations to that branch only:
   `DATABASE_URL_UNPOOLED=<test branch direct string> npm run db:migrate`
4. Run `npm run test:api`, `npm run test:isolation`, `npm run test:e2e`.

`scripts/test-guard.ts` refuses to start (exit code 2) when
- `TEST_DATABASE_URL` is not set, or
- it points at the same host and database as `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `PREVIEW_DATABASE_URL` or `PRODUCTION_DATABASE_URL`
  (pooled and direct spellings of the same database count as the same). Put the preview / production strings in
  `PREVIEW_DATABASE_URL` / `PRODUCTION_DATABASE_URL` in your local `.env` so the guard can recognise them even when `DATABASE_URL` is something else.

`TEST_ALLOW_DATABASE_URL=1` lets one run fall back to `DATABASE_URL` (with a warning). Use it only for a development database nobody else uses.
