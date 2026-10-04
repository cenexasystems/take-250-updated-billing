import express, { type Express } from 'express'
import type { Deps } from './lib/route.js'
import { registerRoutes, type Route } from './lib/route.js'
import { adminRoutes } from './routes/admin.js'
import { advanceRoutes } from './routes/advance.js'
import { authRoutes } from './routes/auth.js'
import { barcodeRoutes } from './routes/barcodes.js'
import { catalogRoutes } from './routes/catalog.js'
import { inventoryRoutes } from './routes/inventory.js'
import { miscRoutes } from './routes/misc.js'
import { salesRoutes } from './routes/sales.js'

export const allRoutes: Route<any, any>[] = [
  ...authRoutes, ...catalogRoutes, ...inventoryRoutes, ...barcodeRoutes,
  ...salesRoutes, ...advanceRoutes, ...adminRoutes, ...miscRoutes,
]

export function createApp(deps: Deps): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    next()
  })
  // JSON for API bodies, raw bytes (size-capped) only for the upload routes
  app.use(express.json({ limit: '1mb' }))
  app.use(express.raw({ type: ['image/*', 'application/pdf'], limit: '9mb' }))
  registerRoutes(app, allRoutes, deps)
  // Anything not registered above does not exist (default deny); never reveals framework details.
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }) })
  // body-parser failures (bad JSON, too large) must not leak internals either
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err?.status === 413 ? 413 : 400
    res.status(status).json({ error: status === 413 ? 'Request too large' : 'Invalid request' })
  })
  return app
}
