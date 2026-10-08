// Loads .env for the admin scripts (db:migrate, db:seed, db:reset). Schema changes should go over Neon's DIRECT
// (non-pooled) connection: if DATABASE_URL_UNPOOLED is set it is used for these scripts, otherwise DATABASE_URL is.
// The running app (Vercel) keeps using the POOLED DATABASE_URL.
import 'dotenv/config'
if (process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED
