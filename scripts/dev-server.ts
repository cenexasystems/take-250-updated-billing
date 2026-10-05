/**
 * Local full-stack server: the same Express API that Vercel runs (server/app.ts) plus the BUILT app from dist/ on ONE
 * origin, so the httpOnly session cookie works exactly as in production. File uploads (Vercel Blob in production)
 * are stored in .local-uploads/ and served from /local-uploads/.
 *   npm run dev:full            (builds first)   -> http://localhost:4310
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import type { Server } from 'node:http'
import { createApp } from '../server/app'
import { poolDb } from '../server/lib/db'

export function startDevServer(port = 4310): Promise<{ server: Server; origin: string }> {
  // plain http on localhost: the Secure cookie flag would stop the browser from keeping the session
  process.env.COOKIE_INSECURE = '1'
  const uploadDir = path.resolve('.local-uploads')
  const api = createApp({
    db: poolDb(),
    blobPut: async (pathname, body) => {
      const file = path.join(uploadDir, pathname)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, body)
      return { url: `/local-uploads/${pathname}` }
    },
  })

  const app = express()
  app.use(api)
  app.use('/local-uploads', express.static(uploadDir))
  const dist = path.resolve('dist')
  app.use(express.static(dist))
  // SPA fallback (what vercel.json's rewrite does in production): every non-API GET gets index.html
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) res.sendFile(path.join(dist, 'index.html'))
    else next()
  })

  return new Promise((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => resolve({ server, origin: `http://localhost:${port}` }))
  })
}

if (process.argv[1] && /dev-server\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) {
  if (!fs.existsSync(path.resolve('dist/index.html'))) {
    console.error('dist/ is missing: run `npm run build` first (or use `npm run dev:full`).')
    process.exit(1)
  }
  startDevServer(Number(process.env.PORT || 4310)).then(({ origin }) => console.log(`YG Billing: ${origin}`))
}
