import { api } from './apiClient'

// Files go to Vercel Blob through the API. The server prefixes every path with the session's branch
// (an admin's selected branch), so nothing here names a branch.
const upload = async (kind: 'product-images' | 'invoices' | 'branding', file: Blob, filename: string, contentType: string, branchId?: string): Promise<string> => {
  const res = await api<{ url: string }>('POST', `/api/uploads/${kind}`, {
    query: { filename },
    raw: { data: file, type: contentType },
    branchId,
  })
  return res.url
}

export const uploadProductImage = async (file: File) => {
  const safeName = file.name.toLowerCase().replace(/[^a-z0-9.\-_]/g, '-').replace(/-+/g, '-')
  return upload('product-images', file, safeName, file.type || 'image/jpeg')
}

export const uploadInvoicePdf = async (file: File, invoiceNo: string): Promise<string> => {
  const safeInvoiceNo = invoiceNo.toLowerCase().replace(/[^a-z0-9.\-_]/g, '-').replace(/-+/g, '-')
  return upload('invoices', file, `${safeInvoiceNo}.pdf`, 'application/pdf')
}

/** Store Settings logo. `branch` is the branch being edited (only an admin can pick one; others always use their own). */
export const uploadBrandingLogo = async (file: File, branch: string): Promise<string> =>
  upload('branding', file, `logo-${Date.now()}.${file.name.split('.').pop() || 'png'}`, file.type || 'image/png', branch)
