import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Search, RefreshCw, Filter, ChevronLeft, ChevronRight,
  LogIn, Music, Users, FileText, TrendingUp, UserCheck,
  DollarSign, LayoutDashboard, Activity, X, Clock,
  ArrowDownUp, ArrowUp, ArrowDown,
} from 'lucide-react'
import api from '../api'
import { humanizeAction } from '../lib/activityText'
import PageHeader from '../components/PageHeader'
import usePageShortcuts from '../hooks/usePageShortcuts'
import { focusFilter } from '../hooks/useListKeys'

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDateTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (isNaN(d)) return '—'
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

function timeAgo(ts) {
  if (!ts) return ''
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return formatDateTime(ts)
}

// ─── Category config ─────────────────────────────────────────────────────────

const CATEGORIES = [
  { value: 'all',        label: 'All Activity',  icon: Activity,        color: 'text-gray-500',    bg: 'bg-gray-100' },
  { value: 'auth',       label: 'Sign-ins',       icon: LogIn,           color: 'text-blue-600',    bg: 'bg-blue-50' },
  { value: 'releases',   label: 'Releases',       icon: Music,           color: 'text-purple-600',  bg: 'bg-purple-50' },
  { value: 'artists',    label: 'Artists',        icon: Users,           color: 'text-amber-600',   bg: 'bg-amber-50' },
  { value: 'contracts',  label: 'Contracts',      icon: FileText,        color: 'text-emerald-600', bg: 'bg-emerald-50' },
  { value: 'deals',      label: 'Deals',          icon: TrendingUp,      color: 'text-rose-600',    bg: 'bg-rose-50' },
  { value: 'team',       label: 'Team',           icon: UserCheck,       color: 'text-indigo-600',  bg: 'bg-indigo-50' },
  { value: 'financials', label: 'Financials',     icon: DollarSign,      color: 'text-teal-600',    bg: 'bg-teal-50' },
  { value: 'other',      label: 'Other',          icon: LayoutDashboard, color: 'text-gray-500',    bg: 'bg-gray-100' },
]


const FIELD_LABELS = {
  payment_status: 'Status', payment_date: 'Date Paid', paid_by: 'Paid By',
  payment_method: 'Method', payment_terms: 'Terms', scheduled_payment_date: 'Due Date',
  payee: 'Payee', vendor_email: 'Email', vendor_name: 'Vendor Name',
  vendor_address: 'Address', category: 'Category', artist: 'Artist', song: 'Song',
  amount: 'Amount', currency: 'Currency', invoice_number: 'Inv #',
  invoice_date: 'Date', description: 'Description', notes: 'Notes',
  boom_rep: 'Rep', in_quickbooks: 'QB', uploaded_to_stem: 'Stem',
  cobrand: 'Cobrand', is_bulk_deal: 'Bulk Deal', is_reimbursement: 'Reimbursement',
  recoupable: 'Recoupable', confirmation_sent: 'Confirmation Sent',
}

function formatVal(v) {
  if (v === true) return 'Yes'
  if (v === false) return 'No'
  if (v == null || v === '') return '(empty)'
  return String(v)
}

function getActionDetail(row) {
  const endpoint = row.endpoint || ''
  const match = endpoint.match(/\/(\d+)(?:\/|$)/)
  const entryId = match ? `#${match[1]}` : null

  if (row.detail) {
    try {
      const parsed = JSON.parse(row.detail)
      // Check if it's the new before/after format (values have {from, to})
      const firstVal = Object.values(parsed)[0]
      if (firstVal && typeof firstVal === 'object' && 'from' in firstVal) {
        const parts = Object.entries(parsed).map(([k, { from, to }]) => {
          const label = FIELD_LABELS[k] || k
          return `Changed ${label.toLowerCase()} from "${formatVal(from)}" to "${formatVal(to)}"`
        })
        if (parts.length) return parts.join('. ')
      }
      // Fallback: old format with just {field: value}
      const parts = Object.entries(parsed).map(([k, v]) => {
        const label = FIELD_LABELS[k] || k
        return `${label}: ${formatVal(v)}`
      })
      if (parts.length) return parts.join(', ')
    } catch (_) {
      // Plain text detail — show as-is (strip technical prefixes)
      const text = row.detail
      if (text && !text.startsWith('{') && !text.startsWith('[')) return text
      return entryId || text
    }
  }

  return entryId ? `Entry ${entryId}` : null
}

function getCategoryForAction(action) {
  if (!action) return 'other'
  const a = action.toLowerCase()
  if (a.includes('sign') || a.includes('register')) return 'auth'
  if (a.includes('release') || a.includes('comment')) return 'releases'
  if (a.includes('artist') && !a.includes('split')) return 'artists'
  if (a.includes('contract') || a.includes('pending contract')) return 'contracts'
  if (a.includes('deal') && !a.includes('bulk deal')) return 'deals'
  if (a.includes('team') || a.includes('task') || a.includes('member')) return 'team'
  if (a.includes('invoice') || a.includes('ledger') || a.includes('payment') || a.includes('proof') ||
      a.includes('w9') || a.includes('receipt') || a.includes('vendor') || a.includes('expense') ||
      a.includes('salary') || a.includes('export') || a.includes('download') || a.includes('approv') ||
      a.includes('reject') || a.includes('split') || a.includes('bulk upload') || a.includes('ai-scan') ||
      a.includes('financial') || a.includes('income') || a.includes('budget') || a.includes('bulk deal')) return 'financials'
  return 'other'
}

// ─── Method config ────────────────────────────────────────────────────────────

const METHODS = [
  { value: 'GET',    label: 'GET',    color: 'text-sky-600',     bg: 'bg-sky-50',     activeBg: 'bg-sky-600',     activeBorder: 'border-sky-600' },
  { value: 'POST',   label: 'POST',   color: 'text-emerald-700', bg: 'bg-emerald-50', activeBg: 'bg-emerald-600', activeBorder: 'border-emerald-600' },
  { value: 'PUT',    label: 'PUT',    color: 'text-amber-700',   bg: 'bg-amber-50',   activeBg: 'bg-amber-500',   activeBorder: 'border-amber-500' },
  { value: 'DELETE', label: 'DELETE', color: 'text-red-600',     bg: 'bg-red-50',     activeBg: 'bg-red-500',     activeBorder: 'border-red-500' },
]

const METHOD_COLORS = {
  GET:    'bg-sky-50 text-sky-600',
  POST:   'bg-emerald-50 text-emerald-700',
  PUT:    'bg-amber-50 text-amber-700',
  PATCH:  'bg-amber-50 text-amber-700',
  DELETE: 'bg-red-50 text-red-600',
}

const DEPT_COLORS = {
  Operations: 'bg-blue-50 text-blue-700',
  Executive:  'bg-purple-50 text-purple-700',
  'A&R':      'bg-amber-50 text-amber-700',
  Marketing:  'bg-emerald-50 text-emerald-700',
  Finance:    'bg-rose-50 text-rose-700',
}

const DEPARTMENTS = ['Operations', 'Executive', 'A&R', 'Marketing', 'Finance']

const DATE_PRESETS = [
  { label: 'Today',     days: 0 },
  { label: 'Last 7d',   days: 7 },
  { label: 'Last 30d',  days: 30 },
  { label: 'All time',  days: null },
]

const PAGE_SIZE = 100

// ─── Component ───────────────────────────────────────────────────────────────

export default function ActivityHistory() {
  const [rows, setRows]             = useState([])
  const [total, setTotal]           = useState(0)
  const [users, setUsers]           = useState([])
  const [loading, setLoading]       = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError]           = useState(null)

  // Filters
  const [search, setSearch]           = useState('')
  const [userId, setUserId]           = useState('all')
  const [category, setCategory]       = useState('all')
  const [selectedMethods, setSelectedMethods] = useState([]) // [] = all
  const [department, setDepartment]   = useState('all')
  const [sort, setSort]               = useState('desc')     // 'desc' | 'asc'
  const [showViews, setShowViews]     = useState(false)     // page views are hidden by default

  usePageShortcuts('/activity', { s: () => setSort(s => s === 'desc' ? 'asc' : 'desc'), f: focusFilter })
  const [datePreset, setDatePreset]   = useState('Last 7d')
  const [fromDate, setFromDate]       = useState('')
  const [toDate, setToDate]           = useState('')
  const [customDates, setCustomDates] = useState(false)
  const [page, setPage]               = useState(1)

  const searchTimer = useRef(null)

  // Build from/to from preset or custom
  const getDateRange = useCallback(() => {
    if (customDates) return { from: fromDate || undefined, to: toDate || undefined }
    const preset = DATE_PRESETS.find(p => p.label === datePreset)
    if (!preset || preset.days === null) return {}
    const from = new Date()
    from.setDate(from.getDate() - preset.days)
    return { from: from.toISOString().split('T')[0] }
  }, [customDates, fromDate, toDate, datePreset])

  const fetchActivity = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    else setRefreshing(true)
    setError(null)

    try {
      const { from, to } = getDateRange()
      const params = {
        views: showViews ? '1' : '0',
        user_id:    userId,
        category,
        department: department !== 'all' ? department : undefined,
        methods:    selectedMethods.length > 0 ? selectedMethods.join(',') : undefined,
        sort,
        search:     search.trim() || undefined,
        from,
        to,
        page,
        limit: PAGE_SIZE,
      }
      Object.keys(params).forEach(k => params[k] === undefined && delete params[k])

      const res = await api.get('/activity', { params })
      setRows(res.data.data || [])
      setTotal(res.data.total || 0)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load activity')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [userId, category, selectedMethods, department, sort, search, page, getDateRange])

  // Fetch user list once
  useEffect(() => {
    api.get('/activity/users')
      .then(res => setUsers(res.data.data || []))
      .catch(() => {})
  }, [])

  // Debounce search
  useEffect(() => {
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      setPage(1)
      fetchActivity()
    }, 350)
    return () => clearTimeout(searchTimer.current)
  }, [search]) // eslint-disable-line

  // Immediate re-fetch on all non-search filters
  useEffect(() => {
    setPage(1)
    fetchActivity()
  }, [userId, category, selectedMethods, department, sort, datePreset, customDates, fromDate, toDate, showViews]) // eslint-disable-line

  // Page change
  useEffect(() => {
    fetchActivity(true)
  }, [page]) // eslint-disable-line

  // Toggle a single HTTP method on/off
  function toggleMethod(method) {
    setSelectedMethods(prev =>
      prev.includes(method) ? prev.filter(m => m !== method) : [...prev, method]
    )
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const hasFilters = (
    userId !== 'all' ||
    category !== 'all' ||
    selectedMethods.length > 0 ||
    department !== 'all' ||
    sort !== 'desc' ||
    search.trim() ||
    customDates ||
    datePreset !== 'Last 7d'
  )

  function clearFilters() {
    setUserId('all')
    setCategory('all')
    setSelectedMethods([])
    setDepartment('all')
    setSort('desc')
    setSearch('')
    setDatePreset('Last 7d')
    setCustomDates(false)
    setFromDate('')
    setToDate('')
    setPage(1)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">

      {/* Header */}
      <PageHeader tour="activity-header"
        title="Activity History"
        subtitle={loading ? 'Loading…' : `${total.toLocaleString()} event${total !== 1 ? 's' : ''} matching filters`}
        actions={
          <button
            onClick={() => fetchActivity(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-rule text-gray-600 hover:border-gray-300 hover:bg-gray-50 transition-all disabled:opacity-50"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
        }
      />

      {/* Category pills */}
      <div className="flex items-center gap-2 flex-wrap">
        {CATEGORIES.map(cat => {
          const Icon = cat.icon
          const active = category === cat.value
          return (
            <button
              key={cat.value}
              onClick={() => setCategory(cat.value)}
              className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border transition-all ${
                active
                  ? `${cat.bg} ${cat.color} border-current border-opacity-30`
                  : 'bg-card text-gray-500 border-rule hover:border-gray-300 hover:text-gray-700'
              }`}
            >
              <Icon size={12} />
              {cat.label}
            </button>
          )
        })}
      </div>

      {/* Method filter pills — hidden, too technical */}
      <div className="hidden flex items-center gap-2">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Method</span>
        <div className="flex items-center gap-1.5">
          {METHODS.map(m => {
            const active = selectedMethods.includes(m.value)
            return (
              <button
                key={m.value}
                onClick={() => toggleMethod(m.value)}
                className={`text-xs font-mono font-semibold px-2.5 py-1 rounded-md border transition-all ${
                  active
                    ? `${m.activeBg} text-white ${m.activeBorder}`
                    : `${m.bg} ${m.color} border-transparent hover:border-current hover:border-opacity-30`
                }`}
              >
                {m.label}
              </button>
            )
          })}
          {selectedMethods.length > 0 && (
            <button
              onClick={() => setSelectedMethods([])}
              className="text-xs text-gray-400 hover:text-gray-600 ml-1"
              title="Clear method filter"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Search */}
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            data-filter
            placeholder="Search user or action…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="text-sm pl-9 pr-3 py-2 border border-rule rounded-lg focus:outline-none focus:ring-2 focus:ring-boom-400 placeholder:text-gray-300 w-52"
          />
        </div>

        {/* User filter */}
        <select
          value={userId}
          onChange={e => setUserId(e.target.value)}
          className="text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-400 text-gray-700"
        >
          <option value="all">All users</option>
          {users.map(u => (
            <option key={u.id} value={String(u.id)}>{u.name}</option>
          ))}
        </select>

        {/* Department filter */}
        <select
          value={department}
          onChange={e => setDepartment(e.target.value)}
          className="text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-400 text-gray-700"
        >
          <option value="all">All departments</option>
          {DEPARTMENTS.map(d => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>

        {/* Date preset */}
        {!customDates && (
          <div className="flex items-center gap-px border border-rule rounded-lg overflow-hidden">
            {DATE_PRESETS.map(p => (
              <button
                key={p.label}
                onClick={() => setDatePreset(p.label)}
                className={`text-xs font-medium px-3 py-2 transition-colors ${
                  datePreset === p.label
                    ? 'bg-gray-900 text-white'
                    : 'text-gray-500 hover:bg-gray-50'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}

        {/* Custom date range toggle */}
        <button
          onClick={() => { setCustomDates(v => !v); setDatePreset('') }}
          className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border transition-all ${
            customDates
              ? 'bg-gray-900 text-white border-gray-900'
              : 'border-rule text-gray-500 hover:border-gray-300'
          }`}
        >
          <Filter size={12} />
          Custom
        </button>

        {customDates && (
          <>
            <input
              type="date"
              value={fromDate}
              onChange={e => setFromDate(e.target.value)}
              className="text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-400 text-gray-700"
            />
            <span className="text-xs text-gray-400">to</span>
            <input
              type="date"
              value={toDate}
              onChange={e => setToDate(e.target.value)}
              className="text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-400 text-gray-700"
            />
          </>
        )}

        {/* Sort toggle */}
        <button
          onClick={() => setSort(s => s === 'desc' ? 'asc' : 'desc')}
          className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border transition-all ${
            sort === 'asc'
              ? 'bg-gray-900 text-white border-gray-900'
              : 'border-rule text-gray-500 hover:border-gray-300 hover:text-gray-700'
          }`}
          title={sort === 'desc' ? 'Newest first — click for oldest first' : 'Oldest first — click for newest first'}
        >
          {sort === 'desc' ? <ArrowDown size={12} /> : <ArrowUp size={12} />}
          {sort === 'desc' ? 'Newest' : 'Oldest'}
        </button>
              <label className="inline-flex items-center gap-1.5 text-xs text-gray-500 ml-2 cursor-pointer select-none" data-show-views>
                <input type="checkbox" checked={showViews} onChange={(e) => { setShowViews(e.target.checked); setPage(1) }} style={{ accentColor: '#334155' }} />
                Show page views
              </label>

        {hasFilters && (
          <button
            onClick={clearFilters}
            className="inline-flex items-center gap-1 text-xs text-boom-600 hover:underline font-medium"
          >
            <X size={12} />
            Clear all
          </button>
        )}
      </div>

      {/* Active filter summary */}
      {(selectedMethods.length > 0 || department !== 'all') && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-400">Filtering by:</span>
          {selectedMethods.map(m => {
            const mc = METHODS.find(x => x.value === m)
            return (
              <span
                key={m}
                className={`inline-flex items-center gap-1 text-xs font-mono font-semibold px-2 py-0.5 rounded-md ${mc?.bg} ${mc?.color}`}
              >
                {m}
                <button onClick={() => toggleMethod(m)} className="ml-0.5 opacity-60 hover:opacity-100"><X size={10} /></button>
              </span>
            )
          })}
          {department !== 'all' && (
            <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-md ${DEPT_COLORS[department] || 'bg-gray-100 text-gray-600'}`}>
              {department}
              <button onClick={() => setDepartment('all')} className="ml-0.5 opacity-60 hover:opacity-100"><X size={10} /></button>
            </span>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 text-sm text-red-500 bg-red-50 border border-red-100 rounded-xl px-4 py-3">
          {error}
          <button onClick={() => fetchActivity()} className="ml-auto text-xs text-red-600 hover:underline">Retry</button>
        </div>
      )}

      {/* Table */}
      <div className="bg-card rounded-xl border border-rule overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-56">
            <div className="w-7 h-7 border-2 border-boom-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
            <Activity size={28} strokeWidth={1.5} />
            <p className="text-sm">No activity matches your filters</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-divider bg-gray-50">
                <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-5 py-3">User</th>
                <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-5 py-3">Action</th>
                <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-5 py-3">Details</th>
                <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-5 py-3">
                  <button
                    onClick={() => setSort(s => s === 'desc' ? 'asc' : 'desc')}
                    className="inline-flex items-center gap-1 hover:text-gray-700 transition-colors"
                    title="Toggle sort order"
                  >
                    Time
                    {sort === 'desc'
                      ? <ArrowDown size={11} className="text-gray-400" />
                      : <ArrowUp size={11} className="text-gray-400" />
                    }
                  </button>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {rows.map(row => {
                const cat = CATEGORIES.find(c => c.value === getCategoryForAction(row.action)) || CATEGORIES[0]
                const CatIcon = cat.icon
                return (
                  <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                    {/* User */}
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-full bg-boom-100 flex items-center justify-center flex-shrink-0">
                          <span className="text-xs font-bold text-boom-700">
                            {row.user_name?.charAt(0)?.toUpperCase() || '?'}
                          </span>
                        </div>
                        <div>
                          <p className="font-medium text-gray-900 whitespace-nowrap">{row.user_name || '—'}</p>
                          <button
                            onClick={() => { setDepartment(row.department); setUserId('all') }}
                            className={`inline-block text-[10px] font-medium px-1.5 py-0.5 rounded-full hover:opacity-80 transition-opacity cursor-pointer ${DEPT_COLORS[row.department] || 'bg-gray-100 text-gray-600'}`}
                            title={`Filter by ${row.department}`}
                          >
                            {row.department || row.role}
                          </button>
                        </div>
                      </div>
                    </td>

                    {/* Action */}
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <div className={`w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 ${cat.bg}`}>
                          <CatIcon size={12} className={cat.color} />
                        </div>
                        <div>
                          <span className="text-gray-800 font-medium">{humanizeAction(row)}</span>
                          {row.entry_payee && (
                            <span className="block text-[11px] text-gray-500 mt-0.5 truncate max-w-[220px]">
                              {row.entry_payee}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Details */}
                    <td className="px-5 py-3 max-w-xs">
                      {(() => {
                        const detail = getActionDetail(row)
                        return detail
                          ? <span className="text-xs text-gray-400 break-words">{detail}</span>
                          : <span className="text-gray-300">—</span>
                      })()}
                    </td>

                    {/* Time */}
                    <td className="px-5 py-3 whitespace-nowrap">
                      <p className="text-gray-800">{formatDateTime(row.created_at)}</p>
                      <p className="text-xs text-gray-400 flex items-center gap-1 mt-0.5">
                        <Clock size={10} />
                        {timeAgo(row.created_at)}
                      </p>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-500">
            Page {page} of {totalPages} · {total.toLocaleString()} total events
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="p-1.5 rounded-lg border border-rule text-gray-500 hover:bg-gray-50 disabled:opacity-40 transition-colors"
            >
              <ChevronLeft size={14} />
            </button>
            {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
              let p
              if (totalPages <= 7)          p = i + 1
              else if (page <= 4)           p = i + 1
              else if (page >= totalPages - 3) p = totalPages - 6 + i
              else                          p = page - 3 + i
              return (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={`w-8 h-8 text-xs rounded-lg border transition-colors ${
                    p === page
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'border-rule text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  {p}
                </button>
              )
            })}
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="p-1.5 rounded-lg border border-rule text-gray-500 hover:bg-gray-50 disabled:opacity-40 transition-colors"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
