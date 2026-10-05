import { useEffect, useState } from 'react'
import { Store, Phone, MapPin, Palette, RotateCcw, Save, Upload, Trash2, Loader2, Shield } from 'lucide-react'
import { api } from '../../lib/apiClient'
import { uploadBrandingLogo } from '../../lib/storage'
import { useAdminAuthStore, useSettingsStore, resolveBranch, type PosBranch } from '../../store/store'
import { posAccent, branchShortLabel, branchLogo, getAdminThemeColor, setAdminThemeColor, applyActiveTheme } from '../../lib/branchTheme'
import { normalizeHex } from '../../lib/color'

// 20 curated elegant, deep, eye-friendly theme colors (rich wines, deep forest greens, executive navies, dark teals, royal plums, warm espresso & obsidian)
const PRESET_COLORS = [
  // Row 1: Deep Burgundies, Wines & Forest Greens
  '#7A1220', '#5A0E17', '#8B1A1A', '#6B1724', '#143D2B', '#1B4332', '#0F3F2E', '#1F382B',
  // Row 2: Executive Navies, Midnight Blues & Dark Teals
  '#0F172A', '#162A45', '#1E293B', '#132E4F', '#0D3B3B', '#134E4A', '#0F3D4A', '#1A3644',
  // Row 3: Royal Plums, Deep Violets, Warm Bronze & Charcoal
  '#3B183B', '#2E1065', '#4A2E12', '#18181B',
]

type SettingsTarget = 'pos1' | 'pos2' | 'pos3' | 'admin'

type FormState = {
  name: string
  ownerName: string
  businessType: string
  phoneNumber: string
  shopContactNumber: string
  email: string
  address: string
  instagramId: string
  themeColor: string
  logoUrl: string
}

const emptyForm: FormState = {
  name: '', ownerName: '', businessType: '', phoneNumber: '', shopContactNumber: '',
  email: '', address: '', instagramId: '', themeColor: '#0A0A0A', logoUrl: '',
}

export default function StoreSettingsView() {
  const { role, activeBranch, branch: staffBranch } = useAdminAuthStore()
  const defaultBranch = resolveBranch(activeBranch)

  // Staff and manager are locked to their branch; admin defaults to activeBranch or pos1
  const [target, setTarget] = useState<SettingsTarget>(
    role !== 'admin' ? (staffBranch || 'pos1') : defaultBranch
  )

  const effectiveBranch: PosBranch = target === 'admin' ? 'pos1' : target
  const accent = posAccent(effectiveBranch)
  const { settingsByBranch, fetchSettings } = useSettingsStore()
  const [form, setForm] = useState<FormState>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    void fetchSettings('pos1')
    void fetchSettings('pos2')
    void fetchSettings('pos3')
  }, [fetchSettings])

  // Sync form when target or settingsByBranch changes
  useEffect(() => {
    if (target === 'admin') {
      const adminColor = getAdminThemeColor()
      setForm((prev) => ({
        ...prev,
        themeColor: adminColor,
        name: 'YG ENTERPRISES (Admin Portal)',
      }))
      return
    }

    const currentBranchSettings = settingsByBranch[target]
    if (!currentBranchSettings) return

    const [phoneNumber = '', shopContactNumber = ''] = currentBranchSettings.phone.split(',').map((p) => p.trim())
    setForm({
      name: currentBranchSettings.name,
      ownerName: currentBranchSettings.ownerName,
      businessType: currentBranchSettings.businessType,
      phoneNumber,
      shopContactNumber: shopContactNumber || phoneNumber,
      email: currentBranchSettings.email,
      address: currentBranchSettings.address,
      instagramId: currentBranchSettings.instagramId,
      themeColor: currentBranchSettings.themeColor || '#0A0A0A',
      logoUrl: currentBranchSettings.logoUrl || '',
    })
  }, [target, settingsByBranch])

  const handleReset = () => {
    if (target === 'admin') {
      setForm((f) => ({ ...f, themeColor: getAdminThemeColor() }))
      setMessage(null)
      return
    }
    const currentBranchSettings = settingsByBranch[target]
    if (!currentBranchSettings) return
    const [phoneNumber = '', shopContactNumber = ''] = currentBranchSettings.phone.split(',').map((p) => p.trim())
    setForm({
      name: currentBranchSettings.name, ownerName: currentBranchSettings.ownerName, businessType: currentBranchSettings.businessType,
      phoneNumber, shopContactNumber: shopContactNumber || phoneNumber, email: currentBranchSettings.email,
      address: currentBranchSettings.address, instagramId: currentBranchSettings.instagramId, themeColor: currentBranchSettings.themeColor,
      logoUrl: currentBranchSettings.logoUrl || '',
    })
    setMessage(null)
  }

  const handleSave = async () => {
    setSaving(true)
    setMessage(null)
    try {
      if (target === 'admin') {
        const normalized = normalizeHex(form.themeColor)
        setAdminThemeColor(normalized)
        applyActiveTheme(activeBranch, role, settingsByBranch, staffBranch)
        setMessage({ type: 'success', text: 'Admin Portal appearance theme saved.' })
        setSaving(false)
        return
      }

      const branchToSave: PosBranch = target
      const phone = form.shopContactNumber && form.shopContactNumber !== form.phoneNumber
        ? `${form.phoneNumber}, ${form.shopContactNumber}`
        : form.phoneNumber
      const payload = {
        name: form.name.trim(),
        owner_name: form.ownerName.trim(),
        business_type: form.businessType.trim(),
        phone,
        email: form.email.trim(),
        address: form.address.trim(),
        instagram_id: form.instagramId.trim(),
        theme_color: normalizeHex(form.themeColor),
        logo_url: form.logoUrl || null,
      }
      // the server writes the row of the session's branch (an admin names the branch being edited)
      await api('PUT', '/api/settings', { body: payload, branchId: branchToSave })
      await fetchSettings(branchToSave)
      // Apply active theme immediately so the UI reflects the change right away
      applyActiveTheme(activeBranch, role, { ...settingsByBranch, [branchToSave]: { ...settingsByBranch[branchToSave]!, themeColor: form.themeColor } }, staffBranch)
      setMessage({ type: 'success', text: `${branchShortLabel(branchToSave)} settings & theme saved successfully.` })
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save settings' })
    } finally {
      setSaving(false)
    }
  }

  const handleLogoUpload = async (file: File) => {
    if (target === 'admin') return
    setUploading(true)
    setMessage(null)
    try {
      const url = await uploadBrandingLogo(file, target)
      setForm((f) => ({ ...f, logoUrl: url }))
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Logo upload failed' })
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Header and Branch Target Tabs */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-[#1A0E0E]">Store Settings &amp; Appearance</h2>
          <p className="text-xs text-gray-500 font-semibold mt-1">Configure profile and full theme color for each POS counter and Admin separately.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleReset} className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-gray-200 text-xs font-bold text-gray-600 hover:bg-gray-50 cursor-pointer">
            <RotateCcw size={13} /> Reset
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-black text-white ${accent.bg} hover:opacity-90 disabled:opacity-60 cursor-pointer shadow-sm`}
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save Changes
          </button>
        </div>
      </div>

      {/* Target Selector Tabs for Admin */}
      {role === 'admin' && (
        <div className="flex gap-2 bg-[#FBFAF6] p-1.5 rounded-2xl border border-gray-200/80 shadow-xs max-w-fit">
          <button
            type="button"
            onClick={() => { setTarget('pos1'); setMessage(null) }}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all cursor-pointer ${
              target === 'pos1'
                ? 'bg-[#111111] text-white shadow-xs'
                : 'text-gray-600 hover:text-gray-900 hover:bg-white'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-red-500" />
            POS 1 — Jute &amp; Wedding
          </button>
          <button
            type="button"
            onClick={() => { setTarget('pos2'); setMessage(null) }}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all cursor-pointer ${
              target === 'pos2'
                ? 'bg-[#111111] text-white shadow-xs'
                : 'text-gray-600 hover:text-gray-900 hover:bg-white'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            POS 2 — Fireworks &amp; Crackers
          </button>
          <button
            type="button"
            onClick={() => { setTarget('pos3'); setMessage(null) }}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all cursor-pointer ${
              target === 'pos3'
                ? 'bg-[#111111] text-white shadow-xs'
                : 'text-gray-600 hover:text-gray-900 hover:bg-white'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            {branchShortLabel('pos3')}
          </button>
          <button
            type="button"
            onClick={() => { setTarget('admin'); setMessage(null) }}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all cursor-pointer ${
              target === 'admin'
                ? 'bg-[#111111] text-white shadow-xs'
                : 'text-gray-600 hover:text-gray-900 hover:bg-white'
            }`}
          >
            <Shield size={13} />
            Admin Portal (Global)
          </button>
        </div>
      )}

      {message && (
        <div className={`rounded-xl px-3.5 py-2.5 text-xs font-bold ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-600 border border-red-200'}`}>
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Appearance Card — matching the design from the reference screenshot */}
        <div className="bg-white border border-gray-200 rounded-3xl p-6 shadow-sm space-y-4 lg:col-span-2 xl:col-span-1">
          <div>
            <p className="text-base font-black text-[#1A0E0E] flex items-center gap-2">
              <Palette size={18} className="text-[#B91C1C]" /> Appearance
            </p>
            <p className="text-xs text-gray-500 font-medium mt-1">
              Preferred colour theme — selected card colour + white stays the app theme
            </p>
          </div>

          {/* Preset Swatches Grid — 20 rounded square cards */}
          <div className="grid grid-cols-5 sm:grid-cols-8 gap-2.5 pt-1">
            {PRESET_COLORS.map((c) => {
              const isSelected = form.themeColor.toLowerCase() === c.toLowerCase()
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, themeColor: c }))}
                  className={`w-11 h-11 sm:w-12 sm:h-12 rounded-xl transition-all cursor-pointer relative flex items-center justify-center ${
                    isSelected
                      ? 'ring-3 ring-black ring-offset-2 scale-105 shadow-md'
                      : 'hover:scale-105 hover:shadow-xs'
                  }`}
                  style={{ backgroundColor: c }}
                  aria-label={c}
                />
              )
            })}
          </div>

          {/* Custom Colour Box */}
          <div className="pt-2">
            <label className="block text-[11px] font-black uppercase tracking-wider text-gray-600 mb-2">
              Custom Colour
            </label>
            <div className="flex items-center gap-3">
              <div className="relative shrink-0">
                <input
                  type="color"
                  value={form.themeColor}
                  onChange={(e) => setForm((f) => ({ ...f, themeColor: e.target.value }))}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
                <div
                  className="w-12 h-11 rounded-xl border border-gray-300 shadow-xs cursor-pointer"
                  style={{ backgroundColor: form.themeColor }}
                />
              </div>
              <input
                type="text"
                value={form.themeColor}
                onChange={(e) => setForm((f) => ({ ...f, themeColor: e.target.value }))}
                placeholder="#7A1220"
                className="flex-1 h-11 px-4 rounded-xl border border-gray-200 bg-[#FAFAFA] text-sm font-black text-[#111111] uppercase tracking-wider outline-none focus:border-gray-400"
              />
            </div>
          </div>

          {/* Card Preview Banner */}
          <div
            className="rounded-2xl p-5 text-white shadow-sm transition-colors duration-200"
            style={{ backgroundColor: form.themeColor }}
          >
            <p className="text-[10px] font-black uppercase tracking-[0.16em] opacity-90">
              Card Preview
            </p>
            <p className="text-sm sm:text-base font-black mt-1">
              Selected colour + white stays the app theme.
            </p>
          </div>

          <p className="text-[11px] text-gray-400 font-medium leading-relaxed">
            White backgrounds, layout and components are unchanged — only the accent colour follows this setting.
          </p>
        </div>

        {/* Profile & Shop Information (Shown when configuring POS 1 or POS 2) */}
        {target !== 'admin' && (
          <div className="space-y-4 lg:col-span-2 xl:col-span-1">
            {/* Shop Profile */}
            <div className="bg-white border border-gray-200 rounded-3xl p-6 shadow-sm space-y-3.5">
              <p className="text-xs font-black uppercase tracking-wide text-gray-700 flex items-center gap-1.5">
                <Store size={15} className={accent.text} /> {branchShortLabel(effectiveBranch)} Profile
              </p>
              <div className="flex items-center gap-3">
                <div className={`w-16 h-16 rounded-2xl ${accent.bgLight} border ${accent.border} p-1.5 flex items-center justify-center overflow-hidden shrink-0`}>
                  <img src={form.logoUrl || branchLogo(effectiveBranch)} alt="Logo" className="w-full h-full object-contain" />
                </div>
                <div className="flex flex-col gap-1">
                  <div className="flex gap-2">
                    <label className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 text-[11px] font-bold text-gray-600 hover:bg-gray-50 cursor-pointer">
                      {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} Replace Logo
                      <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && void handleLogoUpload(e.target.files[0])} />
                    </label>
                    {form.logoUrl && (
                      <button onClick={() => setForm((f) => ({ ...f, logoUrl: '' }))} className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-red-200 text-[11px] font-bold text-red-600 hover:bg-red-50 cursor-pointer">
                        <Trash2 size={12} /> Remove
                      </button>
                    )}
                  </div>
                  {!form.logoUrl && (
                    <p className="text-[10px] text-gray-400 font-semibold">Using {branchShortLabel(effectiveBranch)} default logo.</p>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-black uppercase tracking-wide text-gray-500 mb-1">Shop Name</label>
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="w-full h-10 px-3 rounded-xl border border-gray-200 bg-[#FBFAF6] text-sm font-bold outline-none focus:border-gray-400" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wide text-gray-500 mb-1">Owner Name</label>
                  <input value={form.ownerName} onChange={(e) => setForm((f) => ({ ...f, ownerName: e.target.value }))} className="w-full h-10 px-3 rounded-xl border border-gray-200 bg-[#FBFAF6] text-sm font-bold outline-none focus:border-gray-400" />
                </div>
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wide text-gray-500 mb-1">Business Type</label>
                  <input value={form.businessType} onChange={(e) => setForm((f) => ({ ...f, businessType: e.target.value }))} placeholder="e.g. Fireworks / Bags" className="w-full h-10 px-3 rounded-xl border border-gray-200 bg-[#FBFAF6] text-sm font-bold outline-none focus:border-gray-400" />
                </div>
              </div>
            </div>

            {/* Contact Details & Address */}
            <div className="bg-white border border-gray-200 rounded-3xl p-6 shadow-sm space-y-3.5">
              <p className="text-xs font-black uppercase tracking-wide text-gray-700 flex items-center gap-1.5">
                <Phone size={15} className={accent.text} /> Contact &amp; Location
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wide text-gray-500 mb-1">Primary Phone</label>
                  <input value={form.phoneNumber} onChange={(e) => setForm((f) => ({ ...f, phoneNumber: e.target.value }))} className="w-full h-10 px-3 rounded-xl border border-gray-200 bg-[#FBFAF6] text-sm font-bold outline-none focus:border-gray-400" />
                </div>
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wide text-gray-500 mb-1">Shop Contact / Landline</label>
                  <input value={form.shopContactNumber} onChange={(e) => setForm((f) => ({ ...f, shopContactNumber: e.target.value }))} className="w-full h-10 px-3 rounded-xl border border-gray-200 bg-[#FBFAF6] text-sm font-bold outline-none focus:border-gray-400" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wide text-gray-500 mb-1">Email ID</label>
                  <input value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className="w-full h-10 px-3 rounded-xl border border-gray-200 bg-[#FBFAF6] text-sm font-bold outline-none focus:border-gray-400" />
                </div>
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wide text-gray-500 mb-1">Instagram ID</label>
                  <input value={form.instagramId} onChange={(e) => setForm((f) => ({ ...f, instagramId: e.target.value }))} placeholder="@yourhandle" className="w-full h-10 px-3 rounded-xl border border-gray-200 bg-[#FBFAF6] text-sm font-bold outline-none focus:border-gray-400" />
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-black uppercase tracking-wide text-gray-500 mb-1">Shop Address</label>
                <textarea value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} rows={2} className="w-full px-3 py-2 rounded-xl border border-gray-200 bg-[#FBFAF6] text-sm font-bold outline-none focus:border-gray-400 resize-none" />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

