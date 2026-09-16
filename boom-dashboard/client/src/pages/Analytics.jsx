import { useState, useEffect, useMemo } from 'react'
import { BarChart3, Users, LogIn, MousePointerClick, Eye } from 'lucide-react'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts'
import api from '../api'
import PageHeader from '../components/PageHeader'
import Skeleton from '../components/Skeleton'
import { useAuth } from '../context/AuthContext'
import { formatDate } from '../utils'

const RANGES = [
  { days: 7,  label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
]

// Friendly names for the most common paths — falls back to the raw path.
const PATH_LABELS = {
  '/': 'Dashboard', '/my-work': 'My Work', '/releases': 'Release Tracker', '/catalog': 'Catalog',
  '/artists': 'Artist Roster', '/artists/:id': 'Artist Profile', '/deals': 'Deal Pipeline',
  '/contracts': 'Contracts', '/pending-contracts': 'Pending Contracts', '/renewals': 'Renewals',
  '/bk/ledger': 'Ledger', '/bk/approvals': 'Approvals', '/bk/payments': 'Payment Dashboard',
  '/bk/invoices': 'Invoices', '/bk/vendors': 'Vendors',
  // Removed as a page; the label stays so the pageviews it accumulated while
  // it existed render as a name instead of a bare path in the history below.
  '/bk/lookup': 'Expense Lookup (removed)',
  '/bk/add': 'Add Invoice', '/bk/reimburse': 'Add Reimbursement', '/bk/bulk-upload': 'Bulk Upload',
  '/bk/bulk-deals': 'Bulk Deals', '/bk/archive': 'Archive',
  '/recoupments': 'Recoupments', '/recoupments/planning': 'Recoupment Planning', '/recoupments/2025': '2025 Expenses',
  '/artist-campaigns': 'Artist Campaigns', '/financials': 'Financials', '/import': 'QB Import',
  '/team': 'Team', '/team/:id': 'Team Member', '/calendar': 'Calendar', '/salary': 'Salary',
  '/activity': 'Activity History', '/settings': 'Settings', '/manual': 'User Manual',
  '/analytics': 'Analytics', '/releases/:id': 'Release Detail',
}
const pageLabel = (path) => {
  if (PATH_LABELS[path]) return PATH_LABELS[path]
  // /artist-campaigns/<artist> and friends: label the family
  const base = Object.keys(PATH_LABELS).find(k => k !== '/' && path.startsWith(k + '/'))
  return base ? `${PATH_LABELS[base]} — subpage` : path
}

function StatCard({ icon: Icon, label, value, sub }) {
  return (
    <div className="card px-4 py-4">
      <div className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-wider text-gray-400 mb-1.5">
        <Icon size={12} /> {label}
      </div>
      <div className="text-2xl font-black text-gray-900 tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}

export default function Analytics() {
  const { user } = useAuth()
  const isAdmin = ['Admin', 'Superadmin'].includes(user?.role)
  const [days, setDays] = useState(30)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isAdmin) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    api.get('/analytics/summary', { params: { days } })
      .then(r => { if (!cancelled) setData(r.data?.data || null) })
      .catch(err => { if (!cancelled) setError(err.response?.data?.error || err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [days, isAdmin])

  // One row per person: views + active days + logins + actions merged by name.
  const userRows = useMemo(() => {
    if (!data) return []
    const map = new Map()
    const get = (name) => {
      if (!map.has(name)) map.set(name, { name, views: 0, active_days: 0, logins: 0, actions: 0, last_seen: null })
      return map.get(name)
    }
    for (const u of data.topUsers || []) Object.assign(get(u.name), { views: u.views, active_days: u.active_days, last_seen: u.last_seen })
    for (const l of data.logins || []) { const r = get(l.name); r.logins = l.logins; if (!r.last_seen) r.last_seen = l.last_login }
    for (const a of data.actions || []) get(a.name).actions = a.actions
    return [...map.values()].sort((x, y) => y.views - x.views || y.logins - x.logins)
  }, [data])

  const totalLogins = useMemo(() => (data?.logins || []).reduce((s, l) => s + l.logins, 0), [data])
  const totalActions = useMemo(() => (data?.actions || []).reduce((s, a) => s + a.actions, 0), [data])
  const maxPageViews = useMemo(() => Math.max(1, ...(data?.topPages || []).map(p => p.views)), [data])

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm text-gray-400">Admin access required</p>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Analytics"
        subtitle="Who's using the app, and where they spend their time."
      />

      {/* Range picker */}
      <div className="flex gap-1.5 mb-5 overflow-x-auto">
        {RANGES.map(r => (
          <button
            key={r.days}
            onClick={() => setDays(r.days)}
            className={`shrink-0 px-3.5 py-1.5 rounded-full text-xs font-bold border transition-colors ${
              days === r.days ? 'bg-gray-900 text-white border-transparent' : 'bg-card text-gray-600 border-rule hover:border-gray-300'
            }`}
          >
            Last {r.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="card p-4 mb-5 text-sm text-red-600">{error}</div>
      )}

      {loading ? (
        <div className="space-y-5">
          <Skeleton.StatCards count={4} />
          <Skeleton.Block h="h-64" />
          <Skeleton.Table rows={6} />
        </div>
      ) : data && (
        <div className="space-y-5">
          {/* Stat cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard icon={Eye} label="Page views" value={data.totals.views.toLocaleString()} sub={`last ${data.days} days`} />
            <StatCard icon={Users} label="Active users" value={data.totals.users} sub="viewed at least one page" />
            <StatCard icon={LogIn} label="Logins" value={totalLogins.toLocaleString()} sub="sessions started" />
            <StatCard icon={MousePointerClick} label="Actions" value={totalActions.toLocaleString()} sub="edits, approvals, uploads…" />
          </div>

          {/* Daily views chart */}
          <div className="card p-5">
            <h3 className="text-sm font-bold text-gray-700 mb-4 flex items-center gap-2">
              <BarChart3 size={14} className="text-boom-600" /> Daily activity
            </h3>
            {data.daily.length === 0 ? (
              <p className="text-sm text-gray-400 py-8 text-center">No page views recorded yet — data starts collecting now.</p>
            ) : (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.daily} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                    <defs>
                      <linearGradient id="viewsFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#334155" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="#334155" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(128,128,128,0.15)" />
                    <XAxis dataKey="day" tick={{ fontSize: 10 }} tickFormatter={d => d.slice(5)} />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip
                      formatter={(v, name) => [v, name === 'views' ? 'Page views' : 'Active users']}
                      labelFormatter={d => formatDate(d)}
                    />
                    <Area type="monotone" dataKey="views" stroke="#334155" strokeWidth={2} fill="url(#viewsFill)" />
                    <Area type="monotone" dataKey="users" stroke="#6366f1" strokeWidth={1.5} fillOpacity={0} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="grid lg:grid-cols-2 gap-5 items-start">
            {/* Top pages */}
            <div className="card overflow-hidden">
              <div className="px-5 py-3.5 border-b border-divider">
                <h3 className="text-sm font-bold text-gray-700">Most-used pages</h3>
              </div>
              {data.topPages.length === 0 ? (
                <p className="text-sm text-gray-400 p-6 text-center">Nothing yet.</p>
              ) : data.topPages.map(p => (
                <div key={p.path} className="px-5 py-2.5 border-b border-gray-50 last:border-b-0">
                  <div className="flex items-baseline justify-between gap-3 mb-1">
                    <span className="text-xs font-bold text-gray-900 truncate" title={p.path}>{pageLabel(p.path)}</span>
                    <span className="text-xs font-bold text-gray-700 tabular-nums whitespace-nowrap">
                      {p.views.toLocaleString()}
                      <span className="text-gray-400 font-semibold"> · {p.users} user{p.users === 1 ? '' : 's'}</span>
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                    <div className="h-full rounded-full bg-boom-500" style={{ width: `${Math.max(3, (p.views / maxPageViews) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>

            {/* Most active users */}
            <div className="card overflow-hidden">
              <div className="px-5 py-3.5 border-b border-divider">
                <h3 className="text-sm font-bold text-gray-700">Most active users</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[460px] text-xs">
                  <thead>
                    <tr className="bg-gray-50 border-b border-rule text-left">
                      <th className="px-5 py-2 font-bold text-gray-500">User</th>
                      <th className="px-3 py-2 font-bold text-gray-500 text-right">Views</th>
                      <th className="px-3 py-2 font-bold text-gray-500 text-right">Days active</th>
                      <th className="px-3 py-2 font-bold text-gray-500 text-right">Logins</th>
                      <th className="px-3 py-2 font-bold text-gray-500 text-right">Actions</th>
                      <th className="px-5 py-2 font-bold text-gray-500 text-right">Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {userRows.length === 0 ? (
                      <tr><td colSpan={6} className="px-5 py-6 text-center text-gray-400">Nothing yet.</td></tr>
                    ) : userRows.map(u => (
                      <tr key={u.name} className="border-b border-gray-50 last:border-b-0">
                        <td className="px-5 py-2 font-bold text-gray-900">{u.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{u.views.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{u.active_days || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{u.logins || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{u.actions || '—'}</td>
                        <td className="px-5 py-2 text-right text-gray-500 whitespace-nowrap">{u.last_seen ? formatDate(u.last_seen) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <p className="text-[11px] text-gray-400 px-1">
            Page views start collecting from the moment this feature deployed — older history shows logins and actions only. Views are kept for 180 days.
          </p>
        </div>
      )}
    </div>
  )
}
