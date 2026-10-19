import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Lock, Eye, EyeOff, AlertCircle, ShieldCheck } from 'lucide-react'
import { useAdminAuthStore } from '../store/store'
import { ApiClientError } from '../lib/apiClient'
import { BRAND_EN, BRAND_LOGO } from '../lib/brand'
import { useLangStore } from '../store/langStore'
import { alarmSound } from '../lib/alarmAudio'

/**
 * Sign-in: a brand card and a passcode card on a dark page. It never says which portals or how many branches exist:
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
    <div className="relative h-[100dvh] max-h-[100dvh] min-h-[100dvh] bg-[#141517] bg-[radial-gradient(ellipse_at_top,rgba(212,175,55,0.10),transparent_60%)] font-sans flex flex-col overflow-hidden">
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 flex flex-col items-center">
        <div className="my-auto w-full max-w-[460px] space-y-6 py-6">
          {/* brand card */}
          <div className="rounded-[20px] bg-white px-6 py-7 text-center shadow-[0_20px_50px_-12px_rgba(0,0,0,0.6)]">
            <div className="mx-auto h-24 w-24 rounded-2xl bg-[#0A0A0A] border border-[#D4AF37]/60 p-1.5 flex items-center justify-center shadow-md">
              <img src={BRAND_LOGO} alt={BRAND_EN} className="w-full h-full object-contain rounded-xl" />
            </div>
            <h1 className="mt-4 text-[26px] leading-none font-black tracking-tight text-[#0A0A0A]">{BRAND_EN}</h1>
            <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.25em] text-[#8A6A0A]">{l('Billing & POS System', 'பில்லிங் & POS அமைப்பு')}</p>
          </div>

          {/* sign-in card. It never names roles, portals or branches: the passcode alone decides where it opens. */}
          <div className="rounded-[20px] bg-white p-6 sm:p-8 text-[#111111] shadow-[0_20px_50px_-12px_rgba(0,0,0,0.6)]">
            <div className="mb-6 flex items-center gap-3.5">
              <div className="h-12 w-12 shrink-0 rounded-xl bg-[#FBF3D9] flex items-center justify-center text-[#8A6A0A]">
                <ShieldCheck size={22} />
              </div>
              <div>
                <h2 className="text-[17px] font-black text-[#0A0A0A]">{l('Secure Login', 'பாதுகாப்பான உள்நுழைவு')}</h2>
                <p className="text-[13px] text-[#6B7280]">{l('Enter your passcode to continue', 'தொடர உங்கள் கடவுக்குறியீட்டை உள்ளிடவும்')}</p>
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
                <Lock size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#9CA3AF]" aria-hidden="true" />
                <input
                  type={showPasscode ? 'text' : 'password'}
                  autoComplete="current-password"
                  autoFocus
                  aria-label={l('Passcode', 'கடவுக்குறியீடு')}
                  placeholder={l('Passcode', 'கடவுக்குறியீடு')}
                  className="w-full h-14 rounded-xl border border-gray-300 bg-white pl-10 pr-12 text-[15px] font-semibold outline-none transition-shadow placeholder:font-normal placeholder:text-[#9CA3AF] focus:border-[#D4AF37] focus:ring-4 focus:ring-[#D4AF37]/20 text-[#111111]"
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
                className="group flex w-full h-14 items-center justify-center gap-2 rounded-xl bg-[#0A0A0A] border border-[#D4AF37]/70 font-black text-[15px] text-[#D4AF37] shadow-lg shadow-black/20 transition-all hover:bg-[#1F1F1F] active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
              >
                {loading ? (
                  <>
                    <span className="w-3.5 h-3.5 border-2 border-[#D4AF37]/30 border-t-[#D4AF37] rounded-full animate-spin inline-block" />
                    {l('Signing in...', 'உள்நுழைகிறது...')}
                  </>
                ) : (
                  l('Login', 'உள்நுழைக')
                )}
              </button>
            </form>
            <p className="mt-5 text-center text-[12px] leading-relaxed text-[#9CA3AF]">{l('Your passcode opens your own counter and branch.', 'உங்கள் கடவுக்குறியீடு உங்கள் கவுண்டர் மற்றும் கிளையைத் திறக்கும்.')}</p>
          </div>

          <p className="text-center text-[11px] font-bold uppercase tracking-[0.25em] text-[#6B7280] select-none">Powered by Cenexa Systems</p>
        </div>
      </div>
    </div>
  )
}
