import { put, BlobAccessError, BlobError, BlobStoreNotFoundError, BlobStoreSuspendedError } from '@vercel/blob'
import { ApiError, logServerError } from './errors.js'
import type { Deps } from './route.js'

// Vercel Blob is the only file store: a serverless function has no writable disk to fall back to.
export const STORAGE_NOT_CONFIGURED = 'Image storage is not configured. Connect Vercel Blob to this project (BLOB_READ_WRITE_TOKEN) and redeploy.'

/** True when the Blob token is set (the value itself is never read out or logged). */
export const blobConfigured = (): boolean => !!process.env.BLOB_READ_WRITE_TOKEN

/** The production writer used by api/index.ts: public store, the server-built path, no random suffix (the path is already unique). */
export const vercelBlobPut: Deps['blobPut'] = async (pathname, body, opts) => {
  const token = process.env.BLOB_READ_WRITE_TOKEN
  if (!token) throw new ApiError(503, STORAGE_NOT_CONFIGURED, { code: 'storage_not_configured' })
  const r = await put(pathname, body, { access: 'public', contentType: opts.contentType, addRandomSuffix: false, token })
  return { url: r.url }
}

/**
 * Turns a failed Blob write into a clear answer instead of "Server error". The real cause goes to the server log
 * (Blob error text names the problem, never the token, a phone number or a passcode).
 */
export function blobFailure(where: string, err: unknown): ApiError {
  if (err instanceof ApiError) {
    if (err.extra?.code === 'storage_not_configured') console.error(`[api] ${where}: BLOB_READ_WRITE_TOKEN is not set (connect a Vercel Blob store to this project)`)
    return err
  }
  logServerError(where, err)
  const msg = String((err as Error)?.message ?? '')
  if (err instanceof BlobAccessError || err instanceof BlobStoreNotFoundError || err instanceof BlobStoreSuspendedError
      || (err instanceof BlobError && /credentials|token/i.test(msg))) {
    return new ApiError(503, STORAGE_NOT_CONFIGURED, { code: 'storage_not_configured' })
  }
  return new ApiError(502, 'The file could not be stored. Please try again.', { code: 'storage_failed' })
}
