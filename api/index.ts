// Vercel serverless entry: one Express app serves every /api/* route (see vercel.json rewrites).
import { put } from '@vercel/blob'
import { createApp } from '../server/app.js'
import { poolDb } from '../server/lib/db.js'

export default createApp({
  db: poolDb(),
  blobPut: async (pathname, body, opts) => {
    const r = await put(pathname, body, { access: 'public', contentType: opts.contentType, addRandomSuffix: false, token: process.env.BLOB_READ_WRITE_TOKEN })
    return { url: r.url }
  },
})
