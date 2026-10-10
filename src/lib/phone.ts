export function normalizePhone(input: string): string | null {
  if (!input) return null

  // Strip everything except digits
  const raw = input.replace(/\D/g, '')
  if (!raw) return null

  let digits = raw

  if (digits.startsWith('91') && digits.length === 12) {
    // Already 91XXXXXXXXXX
  } else if (digits.length === 10 && /^[6-9]/.test(digits)) {
    digits = '91' + digits
  } else if (digits.startsWith('0') && (digits.length === 11)) {
    digits = '91' + digits.slice(1)
  } else {
    return null
  }

  // Indian mobile starts with 6-9
  if (!/^91[6-9]\d{9}$/.test(digits)) return null

  return digits
}

export function isValidPhone(input: string): boolean {
  return normalizePhone(input) !== null
}

export function getSubscriberDigits(input: string): string | null {
  const normalized = normalizePhone(input)
  return normalized ? normalized.slice(2) : null
}

/** Display valid Indian mobile numbers with the country code kept separate. */
export function formatPhoneForDisplay(input?: string | null): string {
  if (!input) return ''
  const normalized = normalizePhone(String(input))
  return normalized ? `+${normalized.slice(0, 2)} ${normalized.slice(2)}` : String(input).trim()
}

export function normalizePhoneForWhatsApp(input: string): string {
  if (!input) return ''
  const digits = input.replace(/\D/g, '')
  if (!digits) return ''

  if (digits.length >= 12 && digits.startsWith('91')) {
    return digits
  }
  if (digits.startsWith('0') && digits.length === 11) {
    return '91' + digits.slice(1)
  }
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return '91' + digits
  }
  return digits
}

/** WhatsApp chat with the customer's number. Deliberately has NO text parameter: bills go as a PDF, never as a message. */
export function toWhatsAppUrl(phone: string): string {
  const normalized = normalizePhoneForWhatsApp(phone) || normalizePhone(phone)
  const queryParams: string[] = []

  if (normalized) {
    queryParams.push(`phone=${normalized}`)
  }

  return `https://api.whatsapp.com/send${queryParams.length > 0 ? `?${queryParams.join('&')}` : ''}`
}

/**
 * Format phone number safely for CSV exports so Microsoft Excel, Google Sheets,
 * and Calc never convert it to exponential/scientific notation (e.g. 9.18123E+11)
 * or truncate leading zeros.
 */
export function formatPhoneForCSV(input?: string | null): string {
  if (!input) return ''
  const trimmed = String(input).trim()
  const digits = trimmed.replace(/\D/g, '')
  let mobile10 = digits
  if (digits.length === 12 && digits.startsWith('91')) {
    mobile10 = digits.slice(2)
  }
  if (mobile10.length === 10) {
    return `\t+91 ${mobile10}`
  }
  return `\t${trimmed}`
}
