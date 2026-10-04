import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Lock, Eye, EyeOff, AlertCircle, ShieldCheck } from 'lucide-react'
import { useAdminAuthStore } from '../store/store'
import { BRAND_EN, BRAND_TA, BRAND_LOGO } from '../lib/brand'
import { combinedBranchSubtitle } from '../lib/branchTheme'
import { useLangStore } from '../store/langStore'
import { alarmSound } from '../lib/alarmAudio'
import CenexaFooter from '../components/common/CenexaFooter'

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

  const from = (location.state as { from?: Location })?.from?.pathname || '/dashboard'

  // One passcode opens exactly one portal (Admin, or a branch's Manager / Staff): the server decides which.
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
      // the server's message is generic ("Invalid passcode") or a throttle notice; never echoes the passcode
      setError(err instanceof Error ? err.message : l('Invalid passcode', 'தவறான கடவுக்குறியீடு'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative h-[100dvh] max-h-[100dvh] min-h-[100dvh] bg-white font-sans flex flex-col justify-between overflow-hidden">
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-3 sm:p-5 lg:p-6 flex flex-col items-center">
        <div className="my-auto relative grid w-full max-w-4xl max-h-[92vh] overflow-hidden rounded-3xl border border-gray-200/90 bg-[var(--theme-primary-dark)] shadow-[0_25px_60px_-12px_rgba(0,0,0,0.25),0_12px_28px_-6px_rgba(0,0,0,0.15)] lg:grid-cols-[0.85fr_1.15fr]">
        <div className="hidden flex-col justify-between items-center bg-[#7A1220] border-r border-[#D4AF37]/20 p-8 lg:p-10 text-white lg:flex overflow-y-auto">
          <div className="w-full flex items-center justify-between">
            <p className="text-[11px] font-black uppercase tracking-[0.26em] text-[#D4AF37]">{combinedBranchSubtitle()}</p>
          </div>
          <div className="my-auto flex flex-col items-center justify-center py-6 w-full">
            <div className="relative p-6 sm:p-8 rounded-3xl bg-[var(--theme-primary-dark)] border border-[#D4AF37]/40 shadow-[0_20px_50px_rgba(0,0,0,0.5),0_0_40px_rgba(212,175,55,0.15)] flex items-center justify-center max-w-[280px] w-full aspect-square">
              <img
                src={BRAND_LOGO}
                alt={BRAND_EN}
                className="w-full h-full object-contain filter drop-shadow-[0_10px_20px_rgba(0,0,0,0.6)]"
              />
            </div>
          </div>
          <div className="w-full flex items-center justify-center gap-2 text-xs font-bold text-[#D4AF37]">
            <ShieldCheck size={15} /> Secure retail workspace
          </div>
        </div>
        <div className="p-5 sm:p-7 lg:p-8 bg-white text-[#111111] overflow-y-auto flex flex-col justify-center">
          {/* Brand */}
          <div className="mb-4 sm:mb-5 flex flex-col items-center text-center lg:items-start lg:text-left">
            {/* Mobile-only logo (since left panel is hidden on mobile) */}
            <div className="mb-3 lg:hidden flex justify-center">
              <div className="w-16 h-16 rounded-2xl bg-[#7A1220] border border-[#D4AF37]/50 p-2 flex items-center justify-center shadow-md">
                <img src={BRAND_LOGO} alt={BRAND_EN} className="w-full h-full object-contain" />
              </div>
            </div>
            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#8A6A0A]">{combinedBranchSubtitle()}</p>
            <h1 className="mt-1 text-2xl sm:text-3xl font-black tracking-tight text-[#7A1220]">{BRAND_EN}</h1>
            {BRAND_TA && BRAND_TA !== BRAND_EN && (
              <p className="mt-0.5 text-xs font-semibold text-[#7A786F]">{BRAND_TA}</p>
            )}
          </div>

          {/* Server-level error */}
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-600 px-3.5 py-2.5 rounded-xl text-[12px] mb-3.5 flex items-center gap-2">
              <AlertCircle size={14} />
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} noValidate className="space-y-3.5">
            <div>
              <label className="flex items-center gap-1.5 text-[10px] font-bold text-[#6B7280] uppercase tracking-wide mb-1">
                <Lock size={13} />
                {l('Passcode', 'கடவுக்குறியீடு')}
                <span className="text-red-500 font-black">*</span>
              </label>
              <div className="relative">
                <input
                  type={showPasscode ? 'text' : 'password'}
                  autoComplete="current-password"
                  autoFocus
                  placeholder={l('Enter passcode', 'கடவுக்குறியீட்டை உள்ளிடவும்')}
                  className="w-full rounded-xl border-2 border-[#E8D399] bg-[#FBFAF6] px-3.5 py-2.5 sm:py-3 pr-11 text-xs sm:text-sm font-semibold outline-none transition-colors placeholder:text-[#AAA69C] focus:border-[#7A1220] focus:bg-white text-[#111111]"
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
            </div>

            <button
              type="submit"
              disabled={loading || !passcode}
              className="group flex w-full items-center justify-center gap-2 rounded-xl bg-[#7A1220] border border-[#D4AF37] py-3 font-black text-xs sm:text-sm text-[#D4AF37] shadow-lg shadow-black/20 transition-all hover:bg-[#1A1A1A] hover:scale-[1.01] active:scale-[0.99] disabled:opacity-60 cursor-pointer"
            >
              {loading ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-[#D4AF37]/30 border-t-[#D4AF37] rounded-full animate-spin inline-block" />
                  {l('Signing in...', 'உள்நுழைகிறது...')}
                </>
              ) : (
                <>
                  <ShieldCheck size={14} />
                  {l('Sign In', 'நுழைக')}
                </>
              )}
            </button>

            <p className="text-center text-[10px] leading-relaxed text-[#888888]">
              {l('Branch POS access with an isolated stock ledger and dedicated invoice sequence.', 'கிளை நுழைவு')}
            </p>
          </form>
        </div>
      </div>
      </div>
      <CenexaFooter />
    </div>
  )
}
