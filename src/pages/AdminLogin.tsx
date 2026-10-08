import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Lock, Eye, EyeOff, AlertCircle } from 'lucide-react'
import { useAdminAuthStore } from '../store/store'
import { ApiClientError } from '../lib/apiClient'
import { BRAND_EN, BRAND_LOGO } from '../lib/brand'
import { useLangStore } from '../store/langStore'
import { alarmSound } from '../lib/alarmAudio'
import CenexaFooter from '../components/common/CenexaFooter'

/**
 * Sign-in: the logo and a passcode field, nothing else. It never says which portals or how many branches exist:
 * one passcode opens exactly one portal and the server decides which (role and branch come from the passcode).
 */
export default function AdminLogin() {
  const navigate = useNavigate()
  const location = useLocation()
  const { lang } = useLangStore()
  const l = (en: string, ta: string) => lang === 'ta' ? ta : en
  const login = useAdminAuthStore((state) => state.login)

  const [passcode, setPasscode] = useState('')
  const [showPasscode, setShowPasscode] = useState(false)

  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // lockout countdown ("Try again in M:SS"); the server decides how long, the screen only counts down
  const [lockUntil, setLockUntil] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const lockSecs = lockUntil ? Math.max(0, Math.ceil((lockUntil - now) / 1000)) : 0
  const lockText = `${Math.floor(lockSecs / 60)}:${String(lockSecs % 60).padStart(2, '0')}`
  useEffect(() => {
    if (!lockUntil) return
    const t = setInterval(() => {
      const n = Date.now()
      setNow(n)
      if (n >= lockUntil) { setLockUntil(null); clearInterval(t) }
    }, 500)
    return () => clearInterval(t)
  }, [lockUntil])

  const from = (location.state as { from?: Location })?.from?.pathname || '/dashboard'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    void alarmSound.unlock()
    setError('')
    setLoading(true)
    try {
      const role = await login(passcode)
      const destination = role === 'admin' && from !== '/pos' ? from : '/dashboard'
      navigate(destination, { replace: true })
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 429) {
        setNow(Date.now())
        setLockUntil(Date.now() + (err.retryAfter ?? 300) * 1000)
        return
      }
      const msg = err instanceof Error ? err.message : ''
      setError(msg === 'Incorrect passcode' || !msg ? l('Incorrect passcode', 'தவறான கடவுக்குறியீடு') : msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative h-[100dvh] max-h-[100dvh] min-h-[100dvh] bg-white font-sans flex flex-col justify-between overflow-hidden">
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 flex flex-col items-center">
        <div className="my-auto w-full max-w-[420px] rounded-3xl border border-gray-200/90 bg-white p-6 sm:p-8 text-[#111111] shadow-[0_25px_60px_-12px_rgba(0,0,0,0.18),0_12px_28px_-6px_rgba(0,0,0,0.10)]">
          <div className="mb-6 flex justify-center">
            <div className="h-36 w-36 rounded-3xl bg-[#7A1220] border border-[#D4AF37]/60 p-2 flex items-center justify-center shadow-md">
              <img src={BRAND_LOGO} alt={BRAND_EN} className="w-full h-full object-contain rounded-2xl" />
            </div>
          </div>

          {lockSecs > 0 && (
            <div role="alert" className="bg-amber-50 border border-amber-200 text-amber-800 px-3.5 py-2.5 rounded-xl text-[12px] mb-3.5 flex items-center gap-2">
              <AlertCircle size={14} className="shrink-0" />
              <span>{l('Too many attempts.', 'அதிக முயற்சிகள்.')} <b>{l('Try again in', 'மீண்டும் முயற்சிக்கவும்:')} {lockText}</b></span>
            </div>
          )}
          {error && lockSecs === 0 && (
            <div role="alert" className="bg-red-50 border border-red-200 text-red-600 px-3.5 py-2.5 rounded-xl text-[12px] mb-3.5 flex items-center gap-2">
              <AlertCircle size={14} className="shrink-0" />
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} noValidate className="space-y-3.5">
            <div className="relative">
              <input
                type={showPasscode ? 'text' : 'password'}
                autoComplete="current-password"
                autoFocus
                aria-label={l('Passcode', 'கடவுக்குறியீடு')}
                placeholder={l('Enter passcode', 'கடவுக்குறியீட்டை உள்ளிடவும்')}
                className="w-full rounded-xl border-2 border-[#E8D399] bg-[#FBFAF6] px-3.5 py-3 pr-11 text-sm font-semibold outline-none transition-colors placeholder:text-[#AAA69C] focus:border-[#7A1220] focus:bg-white text-[#111111]"
                value={passcode}
                onChange={(e) => { setPasscode(e.target.value); setError('') }}
                disabled={loading}
                required
              />
              <button
                type="button"
                onClick={() => setShowPasscode(!showPasscode)}
                className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-[#6B7280] hover:bg-[#F9FAFB] hover:text-[#111111] cursor-pointer"
                aria-label={showPasscode ? l('Hide passcode', 'கடவுக்குறியீட்டை மறை') : l('Show passcode', 'கடவுக்குறியீட்டை காட்டு')}
              >
                {showPasscode ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>

            <button
              type="submit"
              disabled={loading || !passcode || lockSecs > 0}
              className="group flex w-full items-center justify-center gap-2 rounded-xl bg-[#7A1220] border border-[#D4AF37] py-3 font-black text-sm text-[#D4AF37] shadow-lg shadow-black/20 transition-all hover:bg-[#1A1A1A] hover:scale-[1.01] active:scale-[0.99] disabled:opacity-60 cursor-pointer"
            >
              {loading ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-[#D4AF37]/30 border-t-[#D4AF37] rounded-full animate-spin inline-block" />
                  {l('Signing in...', 'உள்நுழைகிறது...')}
                </>
              ) : (
                <>
                  <Lock size={14} />
                  {l('Sign In', 'நுழைக')}
                </>
              )}
            </button>
          </form>
        </div>
      </div>
      <CenexaFooter />
    </div>
  )
}
