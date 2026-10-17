// Vercel serverless entry: one Express app serves every /api/* route (see vercel.json rewrites).
import { createApp } from '../server/app.js'
import { vercelBlobPut } from '../server/lib/blob.js'
import { poolDb } from '../server/lib/db.js'

export default createApp({ db: poolDb(), blobPut: vercelBlobPut })
