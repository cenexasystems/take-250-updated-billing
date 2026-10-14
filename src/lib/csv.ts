/**
 * Shared CSV export helpers.
 *
 * Every exporter in the app previously hand-rolled its own escaping, and they
 * disagreed with each other: some quoted every cell, some pre-quoted only the
 * text ones, one omitted the UTF-8 BOM entirely, and two used data: URIs that
 * cannot carry a BOM. These helpers make the behaviour uniform.
 */

/**
 * Escape a single CSV cell per RFC 4180.
 *
 * Doubles embedded quotes and wraps every value in quotes -- including
 * numbers -- so a field containing a comma, a quote or a newline can never
 * shift the columns.
 *
 * A leading '=', '+', '-', '@' or tab makes Excel/LibreOffice evaluate the
 * cell as a formula, which turns a product legitimately named "=SUM(A1)" into
 * a value the user did not type. Prefixing those with an apostrophe forces
 * text interpretation and neutralises the injection.
 */
export { csvCell, csvRow } from './csvCell'
import { csvRow } from './csvCell'

/**
 * Build a complete CSV document, prefixed with a UTF-8 BOM.
 *
 * The BOM is what makes Excel read the file as UTF-8 rather than the local
 * codepage; without it Tamil text and the rupee sign come out as mojibake.
 * Rows are CRLF-terminated, which Excel on Windows expects.
 */
export const buildCsv = (
  header: readonly unknown[],
  rows: readonly (readonly unknown[])[],
): string => '﻿' + [header, ...rows].map(csvRow).join('\r\n')

/**
 * Trigger a browser download of a CSV string.
 *
 * Uses a Blob + object URL rather than a data: URI: a data: URI cannot carry a
 * BOM reliably and breaks on long non-ASCII payloads. The object URL is revoked
 * on a short delay so the download has begun before the blob is released.
 */
export const downloadCsvFile = (filename: string, csv: string): void => {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
