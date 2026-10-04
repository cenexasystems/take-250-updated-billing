import type { PosBranch } from '../../store/store'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { Users, Calendar, Clock, LogIn, LogOut, Plus, Trash2, CheckCircle2 } from 'lucide-react'
import { useAdminAuthStore, resolveBranch } from '../../store/store'
import { posAccent } from '../../lib/branchTheme'
import {
  fetchStaffMembers, createStaffMember, deactivateStaffMember,
  fetchAttendanceForDate, fetchAttendanceForMonth, punchAttendance, overrideAttendanceStatus,
  type StaffMember, type AttendanceRecord,
} from '../../services/attendanceService'

const todayStr = () => new Date().toISOString().slice(0, 10)
const fmtTime = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'

const STATUS_OPTIONS: AttendanceRecord['status'][] = ['present', 'absent', 'half_day', 'leave']
const STATUS_LABEL: Record<AttendanceRecord['status'], string> = {
  present: 'Present', absent: 'Absent', half_day: 'Half Day', leave: 'Leave',
}

// ── Staff-side: pick your name, punch in/out ───────────────────────────
function StaffPunchPanel() {
  const activeBranch = useAdminAuthStore((s) => s.activeBranch)
  const branch = resolveBranch(activeBranch)
  const accent = posAccent(branch)
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [record, setRecord] = useState<AttendanceRecord | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const storageKey = `yg_enterprises_last_staff_${branch}`

  useEffect(() => {
    fetchStaffMembers(branch).then((list) => {
      setStaff(list)
      const remembered = localStorage.getItem(storageKey)
      if (remembered && list.some((s) => s.id === remembered)) setSelectedId(remembered)
      else if (list.length > 0) setSelectedId(list[0].id)
    }).catch((err) => setError(err instanceof Error ? err.message : 'Failed to load staff list'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch])

  const loadToday = useCallback(async (staffId: string) => {
    if (!staffId) { setRecord(null); return }
    const rows = await fetchAttendanceForDate(branch, todayStr())
    setRecord(rows.find((r) => r.staff_member_id === staffId) || null)
  }, [branch])

  useEffect(() => { void loadToday(selectedId) }, [selectedId, loadToday])

  const handleSelect = (id: string) => {
    setSelectedId(id)
    localStorage.setItem(storageKey, id)
  }

  const handlePunch = async (action: 'in' | 'out') => {
    if (!selectedId) return
    setLoading(true)
    setError('')
    try {
      const row = await punchAttendance(selectedId, action)
      setRecord(row)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Punch failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-md mx-auto space-y-5">
      <div className={`bg-white border-2 ${accent.border} rounded-2xl p-5 shadow-sm text-center`}>
        <Clock size={28} className={`mx-auto mb-2 ${accent.text}`} />
        <h2 className="text-lg font-black text-[#1A0E0E]">Staff Attendance</h2>
        <p className="text-xs text-gray-500 font-semibold mt-1">Choose your name, then punch in when your shift starts.</p>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-600 text-xs font-bold px-3 py-2.5 rounded-xl">{error}</div>}

      <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm space-y-4">
        <div>
          <label className="block text-[10px] font-black uppercase tracking-wide text-gray-500 mb-1.5">Your Name</label>
          {staff.length === 0 ? (
            <p className="text-xs text-gray-400 font-semibold">No staff added yet — ask your admin to add you in Staff Management.</p>
          ) : (
            <select
              value={selectedId}
              onChange={(e) => handleSelect(e.target.value)}
              className="w-full h-11 px-3 rounded-xl border-2 border-gray-200 bg-[#FBFAF6] text-sm font-bold text-[#1A0E0E] outline-none focus:border-gray-400 cursor-pointer"
            >
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}
            </select>
          )}
        </div>

        {selectedId && (
          <>
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="bg-[#FBFAF6] rounded-xl p-3">
                <p className="text-[9px] font-black uppercase text-gray-500">Clock In</p>
                <p className="text-sm font-black text-emerald-700">{fmtTime(record?.clock_in ?? null)}</p>
              </div>
              <div className="bg-[#FBFAF6] rounded-xl p-3">
                <p className="text-[9px] font-black uppercase text-gray-500">Clock Out</p>
                <p className="text-sm font-black text-red-600">{fmtTime(record?.clock_out ?? null)}</p>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => handlePunch('in')}
                disabled={loading || !!record?.clock_in}
                className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-black text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 cursor-pointer"
              >
                <LogIn size={16} /> Punch In
              </button>
              <button
                onClick={() => handlePunch('out')}
                disabled={loading || !record?.clock_in || !!record?.clock_out}
                className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-black text-white bg-red-600 hover:bg-red-700 disabled:opacity-40 cursor-pointer"
              >
                <LogOut size={16} /> Punch Out
              </button>
            </div>

            {record?.clock_in && record?.clock_out && (
              <p className="flex items-center justify-center gap-1.5 text-xs font-bold text-emerald-700">
                <CheckCircle2 size={14} /> Shift complete for today
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── Admin-side: Today's Attendance / Monthly Report / Staff Management ──
function TodaysAttendance({ branch }: { branch: PosBranch }) {
  const accent = posAccent(branch)
  const [date, setDate] = useState(todayStr())
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [records, setRecords] = useState<AttendanceRecord[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [staffList, attendance] = await Promise.all([
        fetchStaffMembers(branch),
        fetchAttendanceForDate(branch, date),
      ])
      setStaff(staffList)
      setRecords(attendance)
    } finally {
      setLoading(false)
    }
  }, [branch, date])

  useEffect(() => { void load() }, [load])

  const recordFor = (staffId: string) => records.find((r) => r.staff_member_id === staffId) || null

  const counts = useMemo(() => {
    const present = records.filter((r) => r.status === 'present' && r.clock_in).length
    const absent = staff.length - records.filter((r) => r.clock_in || r.status !== 'present').length >= 0
      ? staff.filter((s) => recordFor(s.id)?.status === 'absent').length
      : 0
    const leaveHalf = records.filter((r) => r.status === 'leave' || r.status === 'half_day').length
    return { total: staff.length, present, absent, leaveHalf }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff, records])

  const setOverride = async (staffId: string, status: AttendanceRecord['status']) => {
    await overrideAttendanceStatus(branch, staffId, date, status)
    void load()
  }

  return (
    <div className="space-y-4">
      <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm flex flex-wrap items-center justify-between gap-4">
        <label className="flex items-center gap-2 text-xs font-bold text-gray-600">
          <span className={`w-8 h-8 rounded-lg ${accent.bgLight} ${accent.text} flex items-center justify-center`}><Calendar size={15} /></span>
          <span>
            <span className="block text-[9px] font-black uppercase tracking-wide text-gray-400">Select Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="text-sm font-black text-[#1A0E0E] outline-none bg-transparent" />
          </span>
        </label>
        <div className="flex items-center gap-5 text-center">
          <div><p className="text-[9px] font-black uppercase text-gray-400">Total</p><p className="text-base font-black text-[#1A0E0E]">{counts.total}</p></div>
          <div><p className="text-[9px] font-black uppercase text-gray-400">Present</p><p className="text-base font-black text-emerald-600">{counts.present}</p></div>
          <div><p className="text-[9px] font-black uppercase text-gray-400">Absent</p><p className="text-base font-black text-red-600">{counts.absent}</p></div>
          <div><p className="text-[9px] font-black uppercase text-gray-400">Leave/Half</p><p className="text-base font-black text-amber-600">{counts.leaveHalf}</p></div>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
        <table className="w-full text-left text-xs">
          <thead className="bg-[#FAFAFA] border-b border-gray-200 text-[10px] font-black uppercase tracking-wider text-gray-500">
            <tr>
              <th className="p-3">Staff Member</th>
              <th className="p-3">Role</th>
              <th className="p-3">Clock In</th>
              <th className="p-3">Clock Out</th>
              <th className="p-3">Override Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {!loading && staff.length === 0 && (
              <tr><td colSpan={5} className="p-8 text-center text-gray-400 font-semibold">No staff added yet. Add staff in the Staff Management tab.</td></tr>
            )}
            {staff.map((s) => {
              const rec = recordFor(s.id)
              return (
                <tr key={s.id} className="hover:bg-[#FBFAF6]">
                  <td className="p-3 flex items-center gap-2 font-bold text-[#1A0E0E]">
                    <span className={`w-7 h-7 rounded-full ${accent.bgLight} ${accent.text} flex items-center justify-center text-[10px] font-black`}>{s.name.slice(0, 1).toUpperCase()}</span>
                    {s.name}
                  </td>
                  <td className="p-3 text-gray-500 font-semibold">{s.role}</td>
                  <td className="p-3 font-bold text-emerald-700">{fmtTime(rec?.clock_in ?? null)}</td>
                  <td className="p-3 font-bold text-red-600">{fmtTime(rec?.clock_out ?? null)}</td>
                  <td className="p-3">
                    <div className="flex gap-1 flex-wrap">
                      {STATUS_OPTIONS.map((opt) => (
                        <button
                          key={opt}
                          onClick={() => void setOverride(s.id, opt)}
                          className={`px-2 py-1 rounded-lg text-[10px] font-black uppercase border cursor-pointer ${
                            (rec?.status || 'present') === opt
                              ? `${accent.bg} text-white border-transparent`
                              : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                          }`}
                        >
                          {STATUS_LABEL[opt]}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function MonthlyReport({ branch }: { branch: PosBranch }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [records, setRecords] = useState<AttendanceRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const [y, m] = month.split('-').map(Number)
    const start = `${month}-01`
    const end = new Date(y, m, 0).toISOString().slice(0, 10)
    Promise.all([fetchStaffMembers(branch), fetchAttendanceForMonth(branch, start, end)])
      .then(([s, r]) => { setStaff(s); setRecords(r) })
      .finally(() => setLoading(false))
  }, [branch, month])

  return (
    <div className="space-y-4">
      <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm flex items-center gap-2">
        <span className="text-[9px] font-black uppercase tracking-wide text-gray-400">Month</span>
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="text-sm font-black text-[#1A0E0E] outline-none bg-transparent" />
      </div>
      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
        <table className="w-full text-left text-xs">
          <thead className="bg-[#FAFAFA] border-b border-gray-200 text-[10px] font-black uppercase tracking-wider text-gray-500">
            <tr>
              <th className="p-3">Staff Member</th>
              <th className="p-3 text-center">Present</th>
              <th className="p-3 text-center">Absent</th>
              <th className="p-3 text-center">Half Day</th>
              <th className="p-3 text-center">Leave</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {!loading && staff.length === 0 && (
              <tr><td colSpan={5} className="p-8 text-center text-gray-400 font-semibold">No staff added yet.</td></tr>
            )}
            {staff.map((s) => {
              const mine = records.filter((r) => r.staff_member_id === s.id)
              const count = (status: AttendanceRecord['status']) => mine.filter((r) => r.status === status).length
              return (
                <tr key={s.id}>
                  <td className="p-3 font-bold text-[#1A0E0E]">{s.name}</td>
                  <td className="p-3 text-center font-black text-emerald-600">{count('present')}</td>
                  <td className="p-3 text-center font-black text-red-600">{count('absent')}</td>
                  <td className="p-3 text-center font-black text-amber-600">{count('half_day')}</td>
                  <td className="p-3 text-center font-black text-violet-600">{count('leave')}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StaffManagement({ branch }: { branch: PosBranch }) {
  const accent = posAccent(branch)
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [name, setName] = useState('')
  const [role, setRole] = useState('staff')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try { setStaff(await fetchStaffMembers(branch)) } finally { setLoading(false) }
  }, [branch])

  useEffect(() => { void load() }, [load])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    try {
      await createStaffMember(branch, name, role)
      setName('')
      setRole('staff')
      await load()
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async (id: string) => {
    if (!window.confirm('Remove this staff member from the roster?')) return
    await deactivateStaffMember(id)
    await load()
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
      <form onSubmit={handleAdd} className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm space-y-3 h-fit">
        <p className="text-xs font-black uppercase tracking-wide text-gray-500 flex items-center gap-1.5"><Plus size={14} /> Add Staff</p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Staff name"
          className="w-full h-10 px-3 rounded-xl border border-gray-200 bg-[#FBFAF6] text-sm font-bold outline-none focus:border-gray-400"
        />
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="Role (e.g. staff, manager)"
          className="w-full h-10 px-3 rounded-xl border border-gray-200 bg-[#FBFAF6] text-sm font-bold outline-none focus:border-gray-400"
        />
        <button
          type="submit"
          disabled={saving || !name.trim()}
          className={`w-full py-2.5 rounded-xl text-xs font-black text-white ${accent.bg} hover:opacity-90 disabled:opacity-50 cursor-pointer`}
        >
          Add to Roster
        </button>
      </form>

      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
        <div className="p-3 border-b border-gray-200 bg-[#FAFAFA]">
          <p className="text-xs font-black uppercase tracking-wide text-gray-700">Staff Roster ({staff.length})</p>
        </div>
        {!loading && staff.length === 0 ? (
          <p className="p-8 text-center text-gray-400 text-xs font-semibold">No staff added yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {staff.map((s) => (
              <li key={s.id} className="p-3 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className={`w-8 h-8 rounded-full ${accent.bgLight} ${accent.text} flex items-center justify-center text-xs font-black`}>{s.name.slice(0, 1).toUpperCase()}</span>
                  <div>
                    <p className="text-sm font-black text-[#1A0E0E]">{s.name}</p>
                    <p className="text-[10px] text-gray-400 font-semibold uppercase">{s.role}</p>
                  </div>
                </div>
                <button onClick={() => void handleRemove(s.id)} className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 cursor-pointer" title="Remove">
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export default function AttendanceView() {
  const role = useAdminAuthStore((s) => s.role)
  const activeBranch = useAdminAuthStore((s) => s.activeBranch)
  const branch = resolveBranch(activeBranch)
  const [adminTab, setAdminTab] = useState<'today' | 'monthly' | 'staff'>('today')

  if (role === 'staff') {
    return <StaffPunchPanel />
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-black text-[#1A0E0E] flex items-center gap-2"><Users size={20} /> Attendance &amp; Staff</h2>
      <div className="flex gap-2">
        {[
          { key: 'today' as const, label: "Today's Attendance" },
          { key: 'monthly' as const, label: 'Monthly Report' },
          { key: 'staff' as const, label: 'Staff Management' },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setAdminTab(t.key)}
            className={`px-4 py-2 rounded-xl text-xs font-black cursor-pointer ${
              adminTab === t.key ? 'bg-[#1A0E0E] text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {adminTab === 'today' && <TodaysAttendance branch={branch} />}
      {adminTab === 'monthly' && <MonthlyReport branch={branch} />}
      {adminTab === 'staff' && <StaffManagement branch={branch} />}
    </div>
  )
}
