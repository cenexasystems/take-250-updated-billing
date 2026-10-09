/** Parses what the API / database may hand over for a date: null, '', 'YYYY-MM-DD', a full ISO timestamp, a Date,
 *  or 'dd/mm/yyyy'. Returns null (never an "Invalid Date") when it is not a real date. A plain calendar date is read
 *  as that day in the viewer's own calendar, so it never slips a day because of the time zone. */
export function parseDateSafe(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const s = String(value).trim()
  if (!s) return null
  const calendar = (y: number, m: number, d: number) => {
    const date = new Date(y, m - 1, d)
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(s)
  if (iso) return calendar(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s)
  if (dmy) return calendar(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]))
  const fallback = new Date(s)
  return Number.isNaN(fallback.getTime()) ? null : fallback
}

/** dd/mm/yyyy, or `empty` ("—") when there is no usable date. */
export function formatDateDMY(value: unknown, empty = '—'): string {
  const d = parseDateSafe(value)
  if (!d) return empty
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}
