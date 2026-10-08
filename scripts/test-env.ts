// Loads .env, then points the tests at Neon's DIRECT endpoint. The pooled (-pooler) endpoint drops a connection that
// stays open for several minutes, and the API tests deliberately run in ONE long transaction that is rolled back.
import 'dotenv/config'
if (process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED
else if (process.env.DATABASE_URL) process.env.DATABASE_URL = process.env.DATABASE_URL.replace('-pooler', '')
