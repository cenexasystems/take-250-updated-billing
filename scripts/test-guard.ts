// Safety for test:api, test:isolation and test:e2e. Loads .env, then points the run at TEST_DATABASE_URL (a separate Neon
// branch) and REFUSES to start when that is the same database as the one the app or Vercel uses.
//   TEST_DATABASE_URL        the Neon branch made for tests (pooled or direct string; the direct endpoint is used)
//   PREVIEW_DATABASE_URL     optional: the Vercel preview branch string, so it can never be used by mistake
//   PRODUCTION_DATABASE_URL  optional: the production string, same
// DATABASE_URL and DATABASE_URL_UNPOOLED from .env are always treated as protected.
// The pooled (-pooler) endpoint drops a connection that stays open for several minutes and the API tests run in ONE
// long transaction that is rolled back, so the direct endpoint is used.
import 'dotenv/config'

const identity = (raw?: string): string | null => {
  if (!raw) return null
  try {
    const u = new URL(raw)
    return `${u.hostname.replace('-pooler', '').toLowerCase()}${u.pathname}`
  } catch { return raw.trim() }
}

const protectedUrls: Array<[string, string | null]> = [
  ['DATABASE_URL', identity(process.env.DATABASE_URL)],
  ['DATABASE_URL_UNPOOLED', identity(process.env.DATABASE_URL_UNPOOLED)],
  ['PREVIEW_DATABASE_URL', identity(process.env.PREVIEW_DATABASE_URL)],
  ['PRODUCTION_DATABASE_URL', identity(process.env.PRODUCTION_DATABASE_URL)],
]

const fail = (msg: string): never => {
  console.error(`\nREFUSING TO RUN THE TESTS: ${msg}\n`)
  process.exit(2)
}

const test = process.env.TEST_DATABASE_URL
if (!test) {
  if (process.env.TEST_ALLOW_DATABASE_URL === '1' && process.env.DATABASE_URL) {
    // explicit, loud opt-out for a development database that is not shared with anyone
    console.warn('WARNING: TEST_DATABASE_URL is not set; TEST_ALLOW_DATABASE_URL=1 lets this run use DATABASE_URL. Use a separate Neon branch.')
    process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL.replace('-pooler', '')
  } else {
    fail('TEST_DATABASE_URL is not set. Create a Neon branch just for tests and put its connection string in .env as TEST_DATABASE_URL.')
  }
} else {
  const id = identity(test)
  const hit = protectedUrls.find(([, p]) => p && p === id)
  if (hit) fail(`TEST_DATABASE_URL points at the same database as ${hit[0]}. Tests and e2e must use their own Neon branch.`)
  process.env.DATABASE_URL = test.replace('-pooler', '')
  // anything below that falls back to the old variable must not see the real one
  delete process.env.DATABASE_URL_UNPOOLED
}
