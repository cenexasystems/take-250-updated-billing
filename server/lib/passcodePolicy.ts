export const PASSCODE_MIN_LENGTH = 8
// bcrypt only uses the first 72 bytes, so longer inputs would silently weaken the hash.
export const PASSCODE_MAX_LENGTH = 64

const COMMON = new Set([
  'password', 'passcode', 'password1', 'password123', 'qwertyui', 'qwerty123', 'letmein1',
  '12345678', '123456789', '1234567890', '87654321', '11111111', '00000000', 'abcd1234',
])

/** Returns a user-facing reason the passcode is not acceptable, or null when it is fine.
 * Never echoes the passcode itself. */
export function validatePasscodeStrength(passcode: unknown): string | null {
  if (typeof passcode !== 'string') return 'Passcode is required.'
  if (passcode !== passcode.trim()) return 'Passcode must not start or end with spaces.'
  if (passcode.length < PASSCODE_MIN_LENGTH) return `Passcode must be at least ${PASSCODE_MIN_LENGTH} characters.`
  if (passcode.length > PASSCODE_MAX_LENGTH) return `Passcode must be at most ${PASSCODE_MAX_LENGTH} characters.`
  if (/^(.)\1+$/.test(passcode)) return 'Passcode is too weak (one repeated character).'
  if (COMMON.has(passcode.toLowerCase())) return 'Passcode is too common.'
  if (/^\d+$/.test(passcode) && isSequentialDigits(passcode)) return 'Passcode is too weak (sequential digits).'
  return null
}

function isSequentialDigits(s: string): boolean {
  let up = true
  let down = true
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1)
    if (d !== 1) up = false
    if (d !== -1) down = false
  }
  return up || down
}
