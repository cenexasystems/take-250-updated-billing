import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Lock, Eye, EyeOff, AlertCircle, ShieldCheck, Store, Briefcase } from 'lucide-react'
import { useAdminAuthStore } from '../store/store'
import { api } from '../lib/apiClient'
import { BRAND_EN, BRAND_TA, BRAND_LOGO, BRAND_LOGO_POS1, BRAND_LOGO_POS2, BRAND_LOGO_POS3 } from '../lib/brand'
import { combinedBranchSubtitle } from '../lib/branchTheme'
import { useLangStore } from '../store/langStore'
import { alarmSound } from '../lib/alarmAudio'
import CenexaFooter from '../components/common/CenexaFooter'

type Portal = 'staff' | 'manager' | 'admin'
type Tile = { id: string; label: string; subtitle: string; logo: string }

// Shown until the public branch list arrives (and if it cannot be loaded); the server's list wins.
const FALLBACK_TILES: Tile[] = [
  { id: 'pos1', label: 'Take250 Karanthai', subtitle: 'Dress & Footwear', logo: BRAND_LOGO_POS1 },
  { id: 'pos2', label: 'Take250 Kinathukadavu', subtitle: 'Dress & Footwear', logo: BRAND_LOGO_POS2 },
  { id: 'pos3', label: 'Take250 Pollachi', subtitle: "Women's Wear", logo: BRAND_LOGO_POS3 },
]

export default function AdminLogin() {
  const navigate = useNavigate()
  const location = useLocation()
  const { lang } = useLangStore()
  const l = (en: string, ta: string) => lang === 'ta' ? ta : en
  const login = useAdminAuthStore((state) => state.login)

  const [portal, setPortal] = useState<Portal>('staff')
  const [tiles, setTiles] = useState<Tile[]>(FALLBACK_TILES)
  const [site, setSite] = useState<string>(FALLBACK_TILES[0].id)
  const [passcode, setPasscode] = useState('')
  const [showPasscode, setShowPasscode] = useState(false)

  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const from = (location.state as { from?: Location })?.from?.pathname || '/dashboard'

  useEffect(() => {
    let alive = true
    api<{ branches: Array<{ id: string; short_label: string; subtitle: string; logo_url: string | null }> }>('GET', '/api/public/branches')
      .then((res) => {
        if (!alive || !res.branches.length) return
        const next = res.branches.map((b) => ({
          id: b.id,
          label: b.short_label || b.id,
          subtitle: b.subtitle || '',
          logo: b.logo_url || FALLBACK_TILES.find((t) => t.id === b.id)?.logo || BRAND_LOGO,
        }))
        setTiles(next)
        setSite((current) => (next.some((t) => t.id === current) ? current : next[0].id))
      })
      .catch(() => undefined)
    return () => { alive = false }
  }, [])

  const needsBranch = portal !== 'admin'
  const chosen = tiles.find((t) => t.id === site)
  const portalName = portal === 'staff' ? l('Staff', 'ஊழியர்') : portal === 'manager' ? l('Manager', 'மேலாளர்') : l('Admin', 'நிர்வாகி')

  // The tab and branch tile only RESTRICT sign-in: the passcode must belong to exactly that portal. The server still
  // decides the role and branch from the passcode alone.
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    void alarmSound.unlock()
    setError('')
    setLoading(true)
    try {
      const role = await login(passcode, { as: portal, site: needsBranch ? site : undefined })
      const destination = role === 'admin' && from !== '/pos' ? from : '/dashboard'
      navigate(destination, { replace: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      // the wrong-portal case is answered exactly like a wrong passcode, so the hint covers both
      setError(msg === 'Invalid passcode'
        ? l('Invalid passcode. Check the portal and branch you selected.', 'தவறான கடவுக்குறியீடு. தேர்ந்தெடுத்த பிரிவு மற்றும் கிளையை சரிபார்க்கவும்.')
        : msg || l('Invalid passcode', 'தவறான கடவுக்குறியீடு'))
    } finally {
      setLoading(false)
    }
  }

  const tabClass = (active: boolean) =>
    `flex-1 min-w-0 flex items-center justify-center gap-1.5 rounded-xl px-1.5 py-2.5 text-[10px] sm:text-[11px] font-black uppercase tracking-wide leading-tight text-center transition-colors cursor-pointer ${
      active ? 'bg-[#7A1220] text-[#D4AF37] shadow-sm' : 'text-[#6B7280] hover:text-[#111111]'
    }`

  return (
    <div className="relative h-[100dvh] max-h-[100dvh] min-h-[100dvh] bg-white font-sans flex flex-col justify-between overflow-hidden">
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 flex flex-col items-center">
        {/* One centred card at every screen size (the original login's look): logo, tagline, brand, portal tabs, branches, passcode */}
        <div className="my-auto w-full max-w-[480px] rounded-3xl border border-gray-200/90 bg-white p-5 sm:p-7 text-[#111111] shadow-[0_25px_60px_-12px_rgba(0,0,0,0.18),0_12px_28px_-6px_rgba(0,0,0,0.10)]">
          {/* Brand */}
          <div className="mb-5 flex flex-col items-center text-center">
            <div className="mb-3 h-20 w-20 rounded-2xl bg-[#7A1220] border border-[#D4AF37]/60 p-1.5 flex items-center justify-center shadow-md">
              <img src={BRAND_LOGO} alt={BRAND_EN} className="w-full h-full object-contain rounded-xl" />
            </div>
            <p className="text-[11px] font-black uppercase tracking-[0.26em] text-[#8A6A0A] leading-relaxed">{combinedBranchSubtitle()}</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-[#7A1220]">{BRAND_EN}</h1>
            {BRAND_TA && BRAND_TA !== BRAND_EN && (
              <p className="mt-0.5 text-xs font-semibold text-[#7A786F]">{BRAND_TA}</p>
            )}
          </div>

          {/* Portal tabs */}
          <div role="tablist" className="mb-4 flex gap-1 rounded-2xl border border-[#E8D399] bg-[#FBFAF6] p-1">
            <button type="button" role="tab" aria-selected={portal === 'staff'} onClick={() => { setPortal('staff'); setError('') }} className={tabClass(portal === 'staff')}>
              <Store size={14} className="shrink-0" /> <span>{l('Staff POS Login', 'ஊழியர் POS நுழைவு')}</span>
            </button>
            <button type="button" role="tab" aria-selected={portal === 'manager'} onClick={() => { setPortal('manager'); setError('') }} className={tabClass(portal === 'manager')}>
              <Briefcase size={14} className="shrink-0" /> <span>{l('Manager Login', 'மேலாளர் நுழைவு')}</span>
            </button>
            <button type="button" role="tab" aria-selected={portal === 'admin'} onClick={() => { setPortal('admin'); setError('') }} className={tabClass(portal === 'admin')}>
              <ShieldCheck size={14} className="shrink-0" /> <span>{l('Admin Orchestrator', 'நிர்வாக மையம்')}</span>
            </button>
          </div>

          {/* Server-level error */}
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-600 px-3.5 py-2.5 rounded-xl text-[12px] mb-3.5 flex items-center gap-2">
              <AlertCircle size={14} className="shrink-0" />
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} noValidate className="space-y-3.5">
            {needsBranch && (
              <div>
                <label className="flex items-center gap-1.5 text-[10px] font-bold text-[#6B7280] uppercase tracking-wide mb-1.5">
                  <Store size={13} />
                  {l('Select Branch', 'கிளையைத் தேர்ந்தெடுக்கவும்')}
                  <span className="text-red-500 font-black">*</span>
                </label>
                <div className={`grid gap-2 ${tiles.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
                  {tiles.map((t) => {
                    const active = t.id === site
                    return (
                      <button
                        key={t.id}
                        type="button"
                        aria-pressed={active}
                        data-branch={t.id}
                        onClick={() => { setSite(t.id); setError('') }}
                        className={`flex flex-col items-center gap-1.5 rounded-xl border-2 px-1.5 py-2.5 text-center transition-colors cursor-pointer ${
                          active ? 'border-[#111111] bg-[#EDEDED]' : 'border-[#E8D399] bg-[#FBFAF6] hover:border-[#D4AF37]'
                        }`}
                      >
                        <span className="h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-black border border-[#D4AF37]/40 flex items-center justify-center">
                          <img src={t.logo} alt="" className="h-full w-full object-contain" />
                        </span>
                        <span className="min-w-0 w-full">
                          <span className={`block text-[10px] sm:text-[11px] font-black leading-tight break-words ${active ? 'text-[#111111]' : 'text-[#3F3F3A]'}`}>{t.label}</span>
                          {t.subtitle && <span className="mt-0.5 block text-[9px] font-semibold leading-tight text-[#7A786F] break-words">{t.subtitle}</span>}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <div>
              <label className="flex items-center gap-1.5 text-[10px] font-bold text-[#6B7280] uppercase tracking-wide mb-1">
                <Lock size={13} />
                {needsBranch && chosen ? `${chosen.label} ${portalName} ` : `${portalName} `}
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
              disabled={loading || !passcode || (needsBranch && !site)}
              className="group flex w-full items-center justify-center gap-2 rounded-xl bg-[#7A1220] border border-[#D4AF37] py-3 font-black text-xs sm:text-sm text-[#D4AF37] shadow-lg shadow-black/20 transition-all hover:bg-[#1A1A1A] hover:scale-[1.01] active:scale-[0.99] disabled:opacity-60 cursor-pointer"
            >
              {loading ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-[#D4AF37]/30 border-t-[#D4AF37] rounded-full animate-spin inline-block" />
                  {l('Signing in...', 'உள்நுழைகிறது...')}
                </>
              ) : (
                <>
                  <Lock size={14} />
                  {portal === 'admin'
                    ? l('Open Admin Orchestrator', 'நிர்வாக மையத்தைத் திறக்க')
                    : portal === 'manager'
                      ? `${l('Open', 'திற')} ${chosen?.label ?? ''} ${l('Manager', 'மேலாளர்')}`.trim()
                      : `${l('Launch', 'துவக்கு')} ${chosen?.label ?? ''}`.trim()}
                </>
              )}
            </button>

            <p className="text-center text-[10px] leading-relaxed text-[#888888]">
              {l('Branch POS access with an isolated stock ledger and dedicated invoice sequence.', 'கிளை நுழைவு')}
            </p>
          </form>
        </div>
      </div>
      <CenexaFooter />
    </div>
  )
}
