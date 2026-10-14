/** CSV cell escaping without any browser API (also used by the API tests). See csv.ts. */
export const csvCell = (value: unknown): string => {
  const s = value === null || value === undefined ? '' : String(value)
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return `"${guarded.replace(/"/g, '""')}"`
}

/** Join one row's cells. Pass raw values -- do NOT pre-quote them. */
export const csvRow = (cells: readonly unknown[]): string => cells.map(csvCell).join(',')
