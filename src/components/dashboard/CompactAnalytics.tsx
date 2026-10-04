import {
  BarChart,
  Bar,
  Cell,
  CartesianGrid,
  LineChart,
  Line,
  PieChart,
  Pie,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ChevronDown, Sparkles } from 'lucide-react'
import { formatCurrency, toNumber } from '../../lib/retail'

type MonthlyPoint = { month: string; revenue: number }
type ChannelPoint = { name: string; value: number; color: string }
type CategoryPoint = { name: string; qty: number; revenue: number }
type WeeklyPoint = { day: string; date: string; revenue: number }

export type CompactAnalyticsModel = {
  monthlyTrend: MonthlyPoint[]
  channelDistribution: ChannelPoint[]
  topCategories: CategoryPoint[]
  weeklySales: WeeklyPoint[]
}

type CompactAnalyticsProps = {
  analytics: CompactAnalyticsModel
}

function TooltipCard({ active, payload, label, currency = false }: {
  active?: boolean
  payload?: Array<{ value?: number; payload?: Record<string, unknown> }>
  label?: string
  currency?: boolean
}) {
  if (!active || !payload || payload.length === 0) return null

  const rawValue = payload[0]?.value
  const value = currency ? formatCurrency(toNumber(rawValue as number | string, 0)) : toNumber(rawValue as number | string, 0)

  return (
    <div className="rounded-xl border border-[#E7DED0] bg-white/95 px-3 py-2 shadow-[0_12px_30px_rgba(34,49,38,0.12)] backdrop-blur-sm">
      <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#7A846F]">{String(label || '')}</p>
      <p className="mt-1 text-sm font-black text-[#223126]">{value}</p>
    </div>
  )
}

const chartAxis = { fill: '#6B7661', fontSize: 11 }

export default function CompactAnalytics({ analytics }: CompactAnalyticsProps) {
  return (
    <section className="space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-[#E7DED0] bg-white/90 backdrop-blur-sm p-4 shadow-[0_10px_24px_rgba(34,49,38,0.05)]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-[15px] font-black text-[#223126]">Revenue Trend</h3>
              <p className="text-[11px] text-[#7A846F] mt-1">Completed revenue only</p>
            </div>
            <div className="inline-flex items-center gap-1 rounded-full bg-[#F7F8F4] px-3 py-1 text-[10px] font-black uppercase tracking-[0.22em] text-[#6B7661]">
              <Sparkles size={12} className="text-[#D4AF37]" /> Premium
            </div>
          </div>
          <div className="h-[224px] w-full min-w-0">
            <ResponsiveContainer width="100%" height={224} minWidth={0} minHeight={0}>
              <LineChart data={analytics.monthlyTrend}>
                <CartesianGrid vertical={false} stroke="#ECE5DA" strokeDasharray="3 6" />
                <XAxis dataKey="month" tick={chartAxis} axisLine={false} tickLine={false} />
                <YAxis tick={chartAxis} axisLine={false} tickLine={false} width={32} />
                <Tooltip content={<TooltipCard currency />} />
                <Line type="monotone" dataKey="revenue" stroke="#8A6A0A" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-2xl border border-[#E7DED0] bg-white/90 backdrop-blur-sm p-4 shadow-[0_10px_24px_rgba(34,49,38,0.05)]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-[15px] font-black text-[#223126]">Online vs Offline</h3>
              <p className="text-[11px] text-[#7A846F] mt-1">Order mix by completed revenue</p>
            </div>
          </div>
          <div className="h-[224px] w-full min-w-0">
            <ResponsiveContainer width="100%" height={224} minWidth={0} minHeight={0}>
              <PieChart>
                <Pie data={analytics.channelDistribution} dataKey="value" nameKey="name" innerRadius={58} outerRadius={84} paddingAngle={4} stroke="rgba(255,255,255,0.85)" strokeWidth={2}>
                  {analytics.channelDistribution.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                </Pie>
                <Tooltip content={<TooltipCard currency />} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[12px] font-bold">
            {analytics.channelDistribution.map((entry) => (
              <div key={entry.name} className="flex items-center gap-2 rounded-xl bg-[#F7F8F4] px-3 py-2 text-[#223126]">
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: entry.color }} />
                <span>{entry.name}: {formatCurrency(entry.value)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <details className="group rounded-2xl border border-[#E7DED0] bg-white/80 backdrop-blur-sm px-4 py-3 shadow-[0_10px_24px_rgba(34,49,38,0.04)]">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] font-black text-[#223126]">
          <span>More insights</span>
          <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-[0.22em] text-[#6B7661] group-open:text-[#111111]">
            Expand <ChevronDown size={12} className="transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <div className="mt-3 grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="rounded-2xl border border-[#E7DED0] bg-[#FBFCF9] p-4">
            <h4 className="text-[13px] font-black text-[#223126] mb-3">Top Categories</h4>
            <div className="h-[208px] w-full min-w-0">
              <ResponsiveContainer width="100%" height={208} minWidth={0} minHeight={0}>
                <BarChart data={analytics.topCategories} layout="vertical" margin={{ left: 8, right: 8 }}>
                  <CartesianGrid horizontal={false} stroke="#ECE5DA" strokeDasharray="3 6" />
                  <XAxis type="number" tick={chartAxis} axisLine={false} tickLine={false} width={30} />
                  <YAxis type="category" dataKey="name" tick={{ ...chartAxis, fontSize: 10.5 }} axisLine={false} tickLine={false} width={110} />
                  <Tooltip content={<TooltipCard />} />
                  <Bar dataKey="qty" fill="#D4AF37" radius={[0, 8, 8, 0]} barSize={14} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-2xl border border-[#E7DED0] bg-[#FBFCF9] p-4">
            <h4 className="text-[13px] font-black text-[#223126] mb-3">Weekly Sales</h4>
            <div className="h-[208px] w-full min-w-0">
              <ResponsiveContainer width="100%" height={208} minWidth={0} minHeight={0}>
                <BarChart data={analytics.weeklySales}>
                  <CartesianGrid vertical={false} stroke="#ECE5DA" strokeDasharray="3 6" />
                  <XAxis dataKey="day" tick={chartAxis} axisLine={false} tickLine={false} />
                  <YAxis tick={chartAxis} axisLine={false} tickLine={false} width={30} />
                  <Tooltip content={<TooltipCard currency />} labelFormatter={(_value, payload) => String(payload?.[0]?.payload?.date || '')} />
                  <Bar dataKey="revenue" fill="#D4AF37" radius={[8, 8, 0, 0]} barSize={16} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </details>
    </section>
  )
}