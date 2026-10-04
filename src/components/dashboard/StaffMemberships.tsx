import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, User, KeyRound, Eye, EyeOff, Save, Loader2 } from 'lucide-react'
import { posAccent, branchLabel, branchName } from '../../lib/branchTheme'
import { api } from '../../lib/apiClient'
import { can } from '../../lib/permissions'
import { useAdminAuthStore, type PosBranch } from '../../store/store'

type PasscodeSlot = { role: 'admin' | 'manager' | 'staff'; target_branch: PosBranch | null; updated_at: string }

type RosterEntry = {
  key: string
  label: string
  role: 'ADMIN' | 'MANAGER' | 'STAFF'
  branch: PosBranch | 'all'
  slot: PasscodeSlot
}

const ROLE_ORDER = { admin: 0, manager: 1, staff: 2 } as const

function buildRoster(slots: PasscodeSlot[]): RosterEntry[] {
  return [...slots]
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || String(a.target_branch).localeCompare(String(b.target_branch)))
    .map((slot) => ({
      key: `${slot.role}-${slot.target_branch ?? 'all'}`,
      label: slot.role === 'admin' ? 'Admin' : `${slot.role === 'manager' ? 'Manager' : 'Staff'} — ${branchName(slot.target_branch!)}`,
      role: slot.role === 'admin' ? 'ADMIN' : slot.role === 'manager' ? 'MANAGER' : 'STAFF',
      branch: slot.target_branch ?? 'all',
      slot,
    }))
}

function PasscodeRow({ entry, currentAdminPasscode, onChanged }: { entry: RosterEntry; currentAdminPasscode: string; onChanged: () => void }) {
  const accent = entry.branch === 'all' ? null : posAccent(entry.branch)
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const handleSave = async () => {
    setSaving(true)
    setMessage(null)
    try {
      await api('PUT', '/api/admin/passcodes', {
        body: {
          target_role: entry.slot.role,
          ...(entry.slot.target_branch ? { target_branch: entry.slot.target_branch } : {}),
          new_passcode: value,
          current_admin_passcode: currentAdminPasscode,
        },
      })
      setMessage({ type: 'success', text: 'Passcode updated. That portal is signed out and must use the new passcode.' })
      setValue('')
      onChanged()
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to update passcode' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <li className="p-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2.5 min-w-[160px]">
        <div className={`w-8 h-8 rounded-full flex items-center justify-center font-black text-[11px] shrink-0 ${accent ? `${accent.bgLight} ${accent.text}` : 'bg-[#FBF6E9] text-[#8A6A0A]'}`}>
          {entry.label.slice(0, 1).toUpperCase()}
        </div>
        <div>
          <p className="text-xs font-black text-[#1A0E0E]">{entry.label}</p>
          <p className="text-[10px] text-gray-400 font-semibold">{entry.branch === 'all' ? 'Admin Orchestrator' : branchLabel(entry.branch)}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-1 min-w-[220px]">
        <div className="relative flex-1">
          <input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => { setValue(e.target.value); setMessage(null) }}
            placeholder="New passcode"
            autoComplete="new-password"
            className="w-full h-9 pl-3 pr-9 rounded-xl border border-gray-200 bg-[#FBFAF6] text-xs font-bold outline-none focus:border-gray-400"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 cursor-pointer"
            aria-label={show ? 'Hide passcode' : 'Show passcode'}
          >
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <button
          onClick={() => void handleSave()}
          disabled={saving || value.length < 8 || !currentAdminPasscode}
          className={`flex items-center gap-1.5 px-3 h-9 rounded-xl text-[11px] font-black text-white shrink-0 disabled:opacity-40 cursor-pointer ${accent ? accent.bg : 'bg-[#7A1220]'}`}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save
        </button>
      </div>
      {message && (
        <p className={`w-full text-[10px] font-bold ${message.type === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>{message.text}</p>
      )}
    </li>
  )
}

export default function StaffMemberships() {
  // Admin only (the API enforces the same rule; this keeps the section out of every other portal's UI)
  const role = useAdminAuthStore((s) => s.role)
  const [slots, setSlots] = useState<PasscodeSlot[]>([])
  const [loadError, setLoadError] = useState('')
  const [currentAdminPasscode, setCurrentAdminPasscode] = useState('')
  const [showCurrent, setShowCurrent] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await api<{ passcodes: PasscodeSlot[] }>('GET', '/api/admin/passcodes')
      setSlots(res.passcodes)
      setLoadError('')
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load passcodes')
    }
  }, [])

  useEffect(() => { if (can(role, 'passcodes.manage')) void load() }, [role, load])

  if (!can(role, 'passcodes.manage')) return null
  const roster = buildRoster(slots)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-[#1A0E0E]">Staff &amp; Memberships</h2>
          <p className="text-xs text-gray-500 font-semibold mt-1">Configured login accounts and the branch each one is restricted to.</p>
        </div>
        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-black uppercase">
          <ShieldCheck size={13} /> {roster.length} Accounts Configured
        </span>
      </div>

      {loadError && <p className="text-xs font-bold text-red-600">{loadError}</p>}

      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
        <div className="p-4 border-b border-gray-200 bg-[#FAFAFA]">
          <p className="text-xs font-black uppercase tracking-wider text-gray-800">Active Staff Roster ({roster.length})</p>
        </div>
        <ul className="divide-y divide-gray-100">
          {roster.map((entry) => {
            const accent = entry.branch === 'all' ? null : posAccent(entry.branch)
            return (
              <li key={entry.key} className="p-4 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center font-black text-xs ${accent ? `${accent.bgLight} ${accent.text}` : 'bg-[#FBF6E9] text-[#8A6A0A]'}`}>
                    {entry.label.slice(0, 1).toUpperCase()}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-black text-[#1A0E0E]">{entry.label}</p>
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wide ${entry.role !== 'STAFF' ? 'bg-[#FBF6E9] text-[#8A6A0A] border border-[#E8D399]' : 'bg-gray-100 text-gray-600 border border-gray-200'}`}>
                        {entry.role}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 font-semibold flex items-center gap-1 mt-0.5">
                      <User size={11} /> Passcode login
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className={`text-xs font-black ${accent ? accent.text : 'text-[#8A6A0A]'}`}>
                    {entry.branch === 'all' ? 'All Branches' : branchLabel(entry.branch)}
                  </p>
                  <p className="text-[10px] text-gray-400 font-semibold flex items-center gap-1 justify-end mt-0.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Branch-Restricted Login
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
        <div className="p-4 border-b border-gray-200 bg-[#FAFAFA] flex items-center gap-2">
          <KeyRound size={15} className="text-[#7A1220]" />
          <div>
            <p className="text-xs font-black uppercase tracking-wider text-gray-800">Change Passcodes</p>
            <p className="text-[10px] text-gray-400 font-semibold">Set a new passcode for any portal — that portal is signed out and uses the new passcode from its next login.</p>
          </div>
        </div>
        <div className="p-4 border-b border-gray-100">
          <label className="block text-[10px] font-bold uppercase tracking-wide text-[#6B7280] mb-1">Your current admin passcode (required for every change)</label>
          <div className="relative max-w-sm">
            <input
              type={showCurrent ? 'text' : 'password'}
              value={currentAdminPasscode}
              onChange={(e) => setCurrentAdminPasscode(e.target.value)}
              placeholder="Current admin passcode"
              autoComplete="current-password"
              className="w-full h-9 pl-3 pr-9 rounded-xl border border-gray-200 bg-[#FBFAF6] text-xs font-bold outline-none focus:border-gray-400"
            />
            <button
              type="button"
              onClick={() => setShowCurrent((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 cursor-pointer"
              aria-label={showCurrent ? 'Hide passcode' : 'Show passcode'}
            >
              {showCurrent ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
        <ul className="divide-y divide-gray-100">
          {roster.map((entry) => (
            <PasscodeRow key={`pc-${entry.key}`} entry={entry} currentAdminPasscode={currentAdminPasscode} onChanged={() => void load()} />
          ))}
        </ul>
      </div>

      <p className="text-[10px] text-gray-400 font-semibold">
        Passcodes must be at least 8 characters and different from every other portal's passcode. They are stored only as hashes; changing one signs that portal out everywhere.
      </p>
    </div>
  )
}
