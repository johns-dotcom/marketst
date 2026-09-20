import { useState, useEffect } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  PieChart,
  Pie,
  Cell
} from 'recharts'
import { AlertCircle, AlertTriangle, Info, CalendarDays, ChevronRight, Filter, X, CheckSquare, ExternalLink, Music2, RefreshCw, Inbox, CreditCard, Landmark, Disc3, UserPlus, FilePlus2, TrendingUp, Music, Activity, CheckCircle2, Flag } from 'lucide-react'
import { Link } from 'react-router-dom'
import api from '../api'
import { formatDate, isPastLocal, daysUntilLocal } from '../utils'
import Skeleton from '../components/Skeleton'
import PageHeader from '../components/PageHeader'
import ReconciledBadge from '../components/ReconciledBadge'
import { useAuth } from '../context/AuthContext'
import useHotkeys from '../hooks/useHotkeys'
import { humanizeAction } from '../lib/activityText'
import { groupOf } from './Calendar'

// Turn whatever the user stored in `spotify_uri` into a clickable https URL.
// Returns null for anything we can't confidently parse — we'd rather fall
// through to the internal release page than send people to a wrong URL.
function spotifyWebUrl(uri) {
  if (!uri || typeof uri !== 'string') return null
  const s = uri.trim()
  if (!s) return null

  // Already a Spotify URL (http or https, with or without query params).
  if (/^https?:\/\/(open\.|play\.)?spotify\.(com|link|app\.link)\//i.test(s)) {
    return s.replace(/^http:\/\//i, 'https://')
  }

  // Protocol-less URL: "open.spotify.com/album/xyz" — browsers would treat
  // this as a relative path, so we have to prepend https:// ourselves.
  if (/^(open\.|play\.)?spotify\.(com|link)\//i.test(s)) {
    return 'https://' + s
  }

  // spotify:TYPE:ID URI — case-insensitive, extra colon segments ignored.
  const m = s.match(/^spotify:(album|track|episode|show|artist|playlist):([A-Za-z0-9]+)/i)
  if (m) return `https://open.spotify.com/${m[1].toLowerCase()}/${m[2]}`

  // Bare IDs, apple music links pasted into the wrong field, etc. — bail.
  return null
}

// Dots for the week list, by the calendar's own groups
const WEEK_DOT = { release: 'bg-blue-500', deadline: 'bg-amber-500', payment: 'bg-teal-600', renewal: 'bg-red-500', contract: 'bg-emerald-500', dsp: 'bg-purple-500', signed: 'bg-emerald-600', manual: 'bg-gray-500' }
function relativeTime(ts) {
  if (!ts) return ''
  const ms = Date.now() - new Date(ts).getTime()
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d}d ago`
}

function relativeDateLabel(dateStr) {
  if (!dateStr) return ''
  const d = new Date(String(dateStr).slice(0, 10))
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const days = Math.round((today - d) / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const GENRE_COLORS = [
  '#334155', '#6366F1', '#0EA5E9', '#10B981', '#F59E0B',
  '#EC4899', '#8B5CF6', '#64748B'
]

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-card border border-rule rounded-lg px-3 py-2 shadow-elevated">
        <p className="text-xs font-medium text-gray-500 mb-1">{label}</p>
        {payload.map((entry, i) => (
          <p key={i} className="text-sm" style={{ color: entry.color }}>
            <span className="font-semibold">{entry.value}</span>
            <span className="text-gray-400 ml-1">{entry.name === 'releases' ? 'this year' : 'last year'}</span>
          </p>
        ))}
      </div>
    )
  }
  return null
}

const CustomPieLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent }) => {
  if (percent < 0.05) return null
  const RADIAN = Math.PI / 180
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5
  const x = cx + radius * Math.cos(-midAngle * RADIAN)
  const y = cy + radius * Math.sin(-midAngle * RADIAN)
  return (
    <text x={x} y={y} fill="white" textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={600}>
      {`${(percent * 100).toFixed(0)}%`}
    </text>
  )
}

const fmtUsd = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n) || 0)

// One tile of the loop. A count and a dollar figure with ONE destination, and
// when there is nothing to do it says so in a sentence that tells a new
// teammate what would fill it — a "0" over a blank table teaches nothing.
function LoopTile({ to, icon: Icon, label, value, money, sub, empty, tone = 'text-boom-500', testId }) {
  const isEmpty = !value
  return (
    <Link to={to} data-tile={testId} className="card px-5 py-4 hover:shadow-md hover:border-gray-300 transition-all group flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <Icon size={18} className={isEmpty ? 'text-gray-300' : tone} strokeWidth={1.5} />
        {money != null && !isEmpty && (
          <span className="text-xs font-semibold text-gray-700 tabular-nums">{fmtUsd(money)}</span>
        )}
      </div>
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">{label}</p>
      {isEmpty ? (
        <p className="text-xs text-gray-500 mt-1.5 leading-snug">{empty}</p>
      ) : (
        <>
          <p className="text-2xl font-bold text-gray-900 tabular-nums leading-tight mt-0.5">{value}</p>
          {sub && <p className="text-xs text-gray-400 mt-0.5 leading-snug">{sub}</p>}
        </>
      )}
      <span className="mt-auto pt-2 text-[11px] font-medium text-boom-600 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5">
        Open <ChevronRight size={12} />
      </span>
    </Link>
  )
}

function bankSubline(bank) {
  if (!bank) return null
  const late = bank.overdue_accounts || []
  if (late.length) {
    const a = bank.accounts.find((x) => x.account === late[0])
    const since = a ? `${a.days_since} days since the last one` : ''
    return `${late.join(', ')} statement overdue${since ? ' · ' + since : ''}`
  }
  if (!bank.accounts?.length) return 'No statement uploaded yet'
  const newest = bank.accounts.slice().sort((a, b) => b.days_since - a.days_since)[0]
  return `last statement ${newest.days_since} days ago`
}

function greeting(name) {
  const h = new Date().getHours()
  const g = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  return `${g}, ${name?.split(' ')[0]}.`
}

export default function Dashboard() {
  const { user, canView } = useAuth()
  const [stats, setStats] = useState(null)
  const [loop, setLoop] = useState(null)
  const [notifications, setNotifications] = useState([])
  const [activity, setActivity] = useState([])
  const [myTasks, setMyTasks] = useState(null)
  const [latestReleases, setLatestReleases] = useState([])
  const [week, setWeek] = useState(null)   // the calendar feed, next 7 days; null = not read
  const [syncingArt, setSyncingArt] = useState(false)
  const [artSyncMsg, setArtSyncMsg] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Chart filters
  const [filterYear, setFilterYear] = useState('')
  const [filterGenre, setFilterGenre] = useState('')
  const [filterFormat, setFilterFormat] = useState('')
  const [chartLoading, setChartLoading] = useState(false)

  useEffect(() => {
    fetchData()
  }, [user?.id]) // re-fetch when switching view-as users

  // Refetch stats when filters change
  useEffect(() => {
    if (!stats) return // skip initial load
    fetchStats()
  }, [filterYear, filterGenre, filterFormat])

  const fetchStats = async () => {
    try {
      setChartLoading(true)
      const params = new URLSearchParams()
      if (filterYear) params.set('year', filterYear)
      if (filterGenre) params.set('genre', filterGenre)
      if (filterFormat) params.set('format', filterFormat)
      const statsRes = await api.get(`/dashboard/stats?${params.toString()}`)
      setStats(statsRes.data.data)
    } catch (err) {
      console.error('Failed to refetch stats:', err)
    } finally {
      setChartLoading(false)
    }
  }

  const fetchData = async () => {
    try {
      // The four loop tiles come from ONE endpoint, permission-filtered on the
      // server (a section is null for a page the user could not open). A failed
      // loop read leaves `loop` null and the tiles simply do not render — never
      // a row of zeros claiming there is nothing to do.
      const [statsRes, notificationsRes, activityRes, tasksRes, loopRes, latestRes, calRes] = await Promise.all([
        api.get('/dashboard/stats'),
        api.get('/dashboard/notifications'),
        api.get('/dashboard/activity'),
        api.get('/team/my-work').catch(() => ({ data: { data: { tasks: [] } } })),
        api.get('/dashboard/loop').catch(() => ({ data: { data: null } })),
        // Latest releases for the "Latest Releases" row — past 14 days.
        // `in_catalog=any` bypasses the default pipeline-only filter so we
        // pick up releases that have already been auto-moved to catalog.
        api.get(`/releases?archived=false&in_catalog=any&date_from=${(() => {
          const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - 14)
          return d.toISOString().slice(0, 10)
        })()}`).catch(() => ({ data: { data: [] } })),
        // The team calendar's feed — already typed and permission-gated server-side.
        api.get('/calendar').catch(() => ({ data: null })),
      ])

      setStats(statsRes.data.data)
      setNotifications(notificationsRes.data.data || [])
      setActivity(activityRes.data.data || [])
      const tasks = tasksRes.data.data?.tasks || []
      const now = new Date(); now.setHours(0,0,0,0)
      setMyTasks({
        total: tasks.filter(t => t.status !== 'Done').length,
        overdue: tasks.filter(t => t.status !== 'Done' && isPastLocal(t.due_date)).length,
        dueToday: tasks.filter(t => t.status !== 'Done' && daysUntilLocal(t.due_date) === 0).length,
      })
      setLoop(loopRes.data?.data || null)
      // Next 7 days, today included, from the same feed the Calendar page draws.
      if (calRes?.data?.events) {
        const local = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        const t0 = new Date(); const from = local(t0); const to = local(new Date(t0.getTime() + 6 * 86400000))
        // Second gate, as the tiles have: the server withholds by permission,
        // and the client drops anything whose page this user cannot open.
        const pageFor = (t) => (t === 'release' || t.startsWith('dsp')) ? '/releases' : t === 'payment_due' ? '/bk/payments' : t === 'contract_expiry' ? '/renewals' : t === 'contract_signed' ? '/contracts' : null
        setWeek(calRes.data.events
          .filter((e) => e.date >= from && e.date <= to)
          .filter((e) => { const pg = pageFor(e.type); return !pg || canView(pg) })
          .sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type)))
      } else setWeek(null)

      // Latest releases — released in the past 14 days (inclusive of today).
      // Server already scoped with date_from; cap today as the upper bound so
      // future-dated rows (if any slipped in) don't show up.
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const todayStr = today.toISOString().slice(0, 10)
      const allReleases = latestRes.data?.data || []
      const latest = allReleases
        .filter(r => r.release_date && String(r.release_date).slice(0, 10) <= todayStr)
        .sort((a, b) => String(b.release_date).localeCompare(String(a.release_date)))
      setLatestReleases(latest)
    } catch (err) {
      setError('Failed to load dashboard data')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const handleSyncLatestArt = async () => {
    setSyncingArt(true)
    setArtSyncMsg('')
    let totalUpdated = 0
    try {
      // First request uses force=true to wipe existing (potentially wrong)
      // covers in the 14-day window so every release gets re-evaluated from
      // scratch — Phase 1 for URI'd rows, strict-match Phase 2 for the rest.
      // Subsequent batches don't force (nothing left to wipe). Hard cap on
      // iterations so a misbehaving backend can never hang the UI.
      let first = true
      let lastRemaining = null
      for (let iter = 0; iter < 10; iter++) {
        const res = await api.post('/releases/sync-artwork', { days: 14, force: first })
        first = false
        const { updated, remaining, total } = res.data.data
        totalUpdated += updated
        if (remaining === 0 || total === 0) break
        // No-progress guard: if the remaining count isn't dropping, the
        // backend has nothing more it can match — stop rather than spin.
        if (lastRemaining !== null && remaining >= lastRemaining) break
        lastRemaining = remaining
        await new Promise(r => setTimeout(r, 500))
      }
      await fetchData()
      setArtSyncMsg(totalUpdated > 0 ? `Updated ${totalUpdated}` : 'All up to date')
      setTimeout(() => setArtSyncMsg(''), 5000)
    } catch (err) {
      console.error('sync-artwork failed:', err)
      setArtSyncMsg('Sync failed')
      setTimeout(() => setArtSyncMsg(''), 6000)
    } finally {
      setSyncingArt(false)
    }
  }

  useHotkeys([
    { key: 'r', handler: () => fetchData() },
  ])

  const hasActiveFilters = filterGenre || filterFormat
  const clearFilters = () => {
    setFilterGenre('')
    setFilterFormat('')
  }

  if (loading) {
    return (
      <div className="space-y-8">
        <Skeleton.PageHeader />
        <Skeleton.StatCards count={4} />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Skeleton.Block h="h-64" className="lg:col-span-2" />
          <Skeleton.Block h="h-64" />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-24">
        <p className="text-sm text-red-600">{error}</p>
      </div>
    )
  }

  // Every loop section present AND zero, and no open task → one line instead
  // of six grey sentences. Sections the server withheld (null) do not count
  // either way; a failed loop read (loop null) never collapses.
  const loopAllClear = !!loop && (myTasks?.total || 0) === 0
    && (!loop.approvals || loop.approvals.count === 0)
    && (!loop.payments || loop.payments.count === 0)
    && (!loop.bank || (loop.bank.open === 0 && !(loop.bank.overdue_accounts?.length)))
    && (!loop.releases || loop.releases.count === 0)
    && (!loop.onboarding || loop.onboarding.count === 0)
    && (!loop.flags || loop.flags.count === 0)
  // Everyone's recent work except mine: what the rest of the team did.
  const teamActivity = activity.filter((a) => Number(a.user_id) !== Number(user?.id)).slice(0, 20)
  const quickActions = [
    canView('/bk/add') && { to: '/bk/add', icon: FilePlus2, label: 'Add invoice', hint: 'one that did not come through the vendor form', testId: 'add-invoice' },
    canView('/releases') && { to: '/releases?add=1', icon: Music, label: 'Add release', hint: 'a date in the pipeline', testId: 'add-release' },
    canView('/deals') && { to: '/deals?new=1', icon: TrendingUp, label: 'New deal', hint: 'the start of signing an artist', testId: 'new-deal' },
  ].filter(Boolean)
  const chartData = stats?.releasesByMonth || []
  const genreData = stats?.releasesByGenre || []
  const thisWeek = stats?.thisWeek || []
  const nextWeek = stats?.nextWeek || []
  const selectedYear = stats?.selectedYear || new Date().getFullYear()
  const availableYears = stats?.availableYears || []
  const availableGenres = stats?.availableGenres || []
  const availableFormats = stats?.availableFormats || []

  const getSeverityIcon = (severity) => {
    if (severity === 'critical') return <AlertCircle className="text-red-500" size={15} />
    if (severity === 'warning') return <AlertTriangle className="text-amber-500" size={15} />
    return <Info className="text-blue-500" size={15} />
  }

  const getSeverityStyle = (severity) => {
    if (severity === 'critical') return 'border-l-2 border-l-red-400 bg-red-50/50'
    if (severity === 'warning') return 'border-l-2 border-l-amber-400 bg-amber-50/50'
    return 'border-l-2 border-l-blue-400 bg-blue-50/50'
  }

  return (
    <div className="space-y-8">
      {/* Personalized greeting */}
      <div>
        <h1 className="text-3xl font-black text-gray-900 tracking-tight">{greeting(user?.name)}</h1>
        <div className="flex flex-wrap items-center gap-2 mt-1">
          <p className="text-sm text-gray-400">Here's what's happening at Market Street.</p>
          {/* Books-closed watermark. Self-hiding for anyone who can't see
              statements, so it needs no isAdmin guard here. Links, because
              the only people who see it can open the page. */}
          <ReconciledBadge linkTo />
        </div>
      </div>

      {/* The loop. Vendor submits → approve → pay → the bank proves it →
          reports read from that. One tile per step, each opening the page
          that resolves it, each rendered only if the server returned the
          section AND this user can open the destination. */}
      {loopAllClear ? (
        <div className="card px-5 py-3 flex items-center gap-3" data-loop-clear data-tour="home-loop">
          <CheckCircle2 size={18} className="text-emerald-500 flex-shrink-0" strokeWidth={1.5} />
          <p className="text-sm text-gray-700">
            <span className="font-semibold">All clear.</span>{' '}
            {[
              'no open tasks',
              loop.approvals && 'nothing awaiting approval',
              loop.payments && 'nothing due this week',
              loop.bank && 'no bank lines to review',
              loop.releases && 'nothing releasing in 30 days',
              loop.onboarding && 'nobody mid-onboarding',
              loop.flags && 'nothing flagged',
            ].filter(Boolean).join(', ')}.
          </p>
          <span className="ml-auto text-[11px] text-gray-400 whitespace-nowrap">Tiles return when something needs doing</span>
        </div>
      ) : (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4" data-tour="home-loop">
        <LoopTile
          to="/my-work" icon={CheckSquare} label="My tasks" testId="tasks"
          value={myTasks?.total || 0}
          sub={myTasks?.overdue > 0 ? `${myTasks.overdue} overdue` : myTasks?.dueToday > 0 ? `${myTasks.dueToday} due today` : 'nothing overdue'}
          empty="No open tasks. Anyone can assign you one from My Work."
        />
        {loop?.approvals && canView('/bk/approvals') && (
          <LoopTile
            to={loop.approvals.to} icon={Inbox} label="Awaiting approval" testId="approvals" tone="text-amber-500"
            value={loop.approvals.count} money={loop.approvals.usd}
            sub={loop.approvals.oldest_days != null ? `oldest ${loop.approvals.oldest_days} day${loop.approvals.oldest_days === 1 ? '' : 's'}` : null}
            empty="Nothing waiting. Vendors submit at /submit; you can add one under Invoices › Add."
          />
        )}
        {loop?.payments && canView('/bk/payments') && (
          <LoopTile
            to={loop.payments.to} icon={CreditCard} label="Due this week" testId="payments" tone="text-boom-500"
            value={loop.payments.count} money={loop.payments.usd}
            sub={[loop.payments.rush ? `${loop.payments.rush} rush` : null, loop.payments.overdue ? `${loop.payments.overdue} overdue` : null].filter(Boolean).join(' · ') || 'none rush, none overdue'}
            empty="Nothing due in the next 7 days. Approved invoices land here on their due date."
          />
        )}
        {loop?.bank && (canView('/bk/bank-matching') || canView('/bk/statements')) && (
          <LoopTile
            to={loop.bank.to} icon={Landmark} label="Bank lines for review" testId="bank" tone="text-sky-600"
            value={loop.bank.open} money={loop.bank.open_usd}
            sub={bankSubline(loop.bank)}
            empty={loop.bank.accounts?.length
              ? (loop.bank.overdue_accounts?.length ? bankSubline(loop.bank) : 'Every bank line is answered. Upload the next statement when it arrives.')
              : 'No statement uploaded yet. Bank › Statements takes the PDF.'}
          />
        )}
        {loop?.onboarding && canView('/artists') && (
          <LoopTile
            to={loop.onboarding.to} icon={UserPlus} label="Onboarding" testId="onboarding" tone="text-emerald-600"
            value={loop.onboarding.count}
            sub={loop.onboarding.count
              ? `${loop.onboarding.steps_open} step${loop.onboarding.steps_open === 1 ? '' : 's'} open${loop.onboarding.next ? ` · next: ${loop.onboarding.next.name}` : ''}`
              : null}
            empty="Nobody is mid-onboarding. A deal moved to Signed starts it."
          />
        )}
        {/* Flags — the register's open count for this person (only kinds whose
            page they could open), and how many appeared since they last opened
            Flags. The one push the register has besides My Work. */}
        {loop?.flags && canView('/flags') && (
          <LoopTile
            to={loop.flags.to || '/flags'} icon={Flag} label="Flags" testId="flags" tone="text-rose-500"
            value={loop.flags.count} money={loop.flags.usd}
            sub={[
              loop.flags.new ? `${loop.flags.new} new since you looked` : null,
              loop.flags.high ? `${loop.flags.high} high` : null,
              loop.flags.setup ? `${loop.flags.setup} setup` : null,
            ].filter(Boolean).join(' · ') || (loop.flags.oldest_days ? `oldest ${loop.flags.oldest_days} day${loop.flags.oldest_days === 1 ? '' : 's'}` : null)}
            empty="Nothing flagged. Every check ran clean; the sweep runs hourly."
          />
        )}
        {loop?.releases && canView('/releases') && (
          <LoopTile
            to={loop.releases.to} icon={Disc3} label="Releasing in 30 days" testId="releases" tone="text-violet-500"
            value={loop.releases.count}
            sub={loop.releases.under_half
              ? `${loop.releases.under_half} under half done on the checklist`
              : loop.releases.next ? `next: ${loop.releases.next.artist_name || '—'} — ${loop.releases.next.project_name}` : null}
            empty="Nothing scheduled in the next 30 days. Add a release from Releases › Pipeline."
          />
        )}
      </div>
      )}

      {/* Quick actions — the things people come here to start, each only for
          someone who can open its page. */}
      {quickActions.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap" data-quick-actions>
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mr-1">Start</span>
          {quickActions.map((a) => (
            <Link key={a.to} to={a.to} data-action={a.testId} title={a.hint}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-700 bg-card border border-rule rounded-lg px-3 py-1.5 hover:border-gray-300 hover:shadow-sm transition-all">
              <a.icon size={13} className="text-gray-400" /> {a.label}
            </Link>
          ))}
        </div>
      )}

      {/* Next 7 days + Recent activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card p-5" data-week>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><CalendarDays size={16} className="text-gray-400" /> Next 7 days</h2>
            <Link to="/calendar" className="text-xs text-boom-600 hover:text-boom-700 font-medium flex items-center gap-0.5">Calendar <ChevronRight size={14} /></Link>
          </div>
          {week === null ? (
            <p className="text-sm text-gray-400 py-6 text-center">The calendar could not be read.</p>
          ) : week.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">Nothing dated in the next week. Release dates, payment due dates, task deadlines and renewals land here from their own pages.</p>
          ) : (
            <ul className="divide-y divide-divider">
              {Object.entries(week.reduce((m, e) => { (m[e.date] = m[e.date] || []).push(e); return m }, {})).map(([date, evs]) => (
                <li key={date} className="py-2 flex gap-3" data-week-day={date}>
                  <div className="w-14 flex-shrink-0 text-right">
                    <p className="text-[10px] font-bold text-gray-400 uppercase">{new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' })}</p>
                    <p className="text-sm font-semibold text-gray-900 tabular-nums leading-tight">{new Date(date + 'T12:00:00').getDate()}</p>
                  </div>
                  <ul className="flex-1 min-w-0 space-y-1">
                    {evs.map((e) => (
                      <li key={e.id} className="flex items-center gap-2 min-w-0" data-week-event={e.type}>
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${WEEK_DOT[groupOf(e.type)] || 'bg-gray-400'}`} />
                        {e.to
                          ? <Link to={e.to} className="text-sm text-gray-800 hover:underline truncate">{e.title}</Link>
                          : <span className="text-sm text-gray-800 truncate">{e.title}</span>}
                        {e.meta && <span className="text-[10px] text-gray-400 flex-shrink-0">{e.meta}</span>}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>

        {canView('/activity') && (
          <div className="card p-5" data-activity>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><Activity size={16} className="text-gray-400" /> Recent activity</h2>
              <Link to="/activity" className="text-xs text-boom-600 hover:text-boom-700 font-medium flex items-center gap-0.5">All activity <ChevronRight size={14} /></Link>
            </div>
            {notifications.length > 0 && (
              <ul className="space-y-1.5 mb-3" data-alerts>
                {notifications.map((n, idx) => (
                  <li key={idx} className={`p-2 rounded-lg ${getSeverityStyle(n.severity)} flex gap-2 items-start`}>
                    <span className="flex-shrink-0 mt-0.5">{getSeverityIcon(n.severity)}</span>
                    <p className="text-xs text-gray-600 leading-relaxed"><span className="font-semibold text-gray-700">{n.type}</span> — {n.message}</p>
                  </li>
                ))}
              </ul>
            )}
            {teamActivity.length === 0 ? (
              <p className="text-sm text-gray-400 py-6 text-center">{activity.length ? 'Nothing from the rest of the team yet — only your own actions so far.' : 'Nothing logged yet. Approvals, payments, signings and releases show up here as the team works.'}</p>
            ) : (
              <ul className="divide-y divide-divider">
                {teamActivity.map((a) => (
                  <li key={a.id} className="py-1.5 flex items-baseline gap-2 text-sm" data-activity-row>
                    <span className="font-semibold text-gray-800 whitespace-nowrap">{(a.user_name || 'Someone').split(' ')[0]}</span>
                    <span className="text-gray-600 truncate">{humanizeAction(a).toLowerCase()}{a.detail ? ` — ${a.detail}` : ''}</span>
                    <span className="ml-auto text-[10px] text-gray-400 whitespace-nowrap tabular-nums">{relativeTime(a.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Latest Releases — past 14 days */}
      {canView('/releases') && latestReleases.length > 0 && (
        <div className="card p-5 hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                <Music2 size={15} className="text-boom-500" />
                Latest Releases
              </h2>
              <p className="text-[11px] text-gray-400 mt-0.5">Out in the past 14 days</p>
            </div>
            <div className="flex items-center gap-3">
              {artSyncMsg && <span className="text-[11px] text-gray-400">{artSyncMsg}</span>}
              <button
                onClick={handleSyncLatestArt}
                disabled={syncingArt}
                title="Pull Spotify cover art for the releases in this row"
                className="p-1.5 text-gray-300 hover:text-green-500 rounded-lg hover:bg-green-50 transition-colors disabled:opacity-40"
              >
                <RefreshCw size={13} className={syncingArt ? 'animate-spin' : ''} />
              </button>
              <Link to="/catalog" className="text-xs text-boom-600 hover:text-boom-700 font-medium flex items-center gap-0.5">
                Open Catalog <ChevronRight size={14} />
              </Link>
            </div>
          </div>

          <div className="flex gap-3 overflow-x-auto pb-2" style={{ scrollbarWidth: 'thin' }}>
            {latestReleases.map(r => {
              // Only honor a real Spotify URL here. Presave links are for
              // pre-release and often dead once a track is out, so we'd rather
              // fall through to the internal release page than send a user to
              // a 404 behind the green Spotify badge.
              const spotifyUrl = spotifyWebUrl(r.spotify_uri)
              const hasArt = r.cover_art_url && r.cover_art_url !== 'not_found'
              const card = (
                <div className="group w-40 flex-shrink-0">
                  <div className="relative aspect-square rounded-lg overflow-hidden bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center shadow-sm group-hover:shadow-md transition-shadow">
                    {hasArt ? (
                      <img src={r.cover_art_url} alt={`${r.project_name} cover art`}
                        className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform"
                        loading="lazy"
                        onError={e => { e.target.style.display = 'none' }} />
                    ) : (
                      <Music2 size={28} className="text-gray-300" />
                    )}
                    {spotifyUrl && (
                      <div className="absolute bottom-1.5 right-1.5 w-7 h-7 rounded-full bg-[#1DB954] text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-md">
                        <ExternalLink size={13} />
                      </div>
                    )}
                  </div>
                  <div className="mt-2 text-xs font-semibold text-gray-900 truncate">{r.project_name || 'Untitled'}</div>
                  <div className="text-[11px] text-gray-500 truncate">{r.artist_name || '—'}</div>
                  <div className="text-[10px] text-gray-400 mt-0.5">{relativeDateLabel(r.release_date)}</div>
                </div>
              )
              return spotifyUrl ? (
                <a key={r.id} href={spotifyUrl} target="_blank" rel="noopener noreferrer" title={`Listen on Spotify — ${r.project_name}`}>
                  {card}
                </a>
              ) : (
                <Link key={r.id} to={`/releases/${r.id}`} title={r.project_name}>
                  {card}
                </Link>
              )
            })}
          </div>
        </div>
      )}

      {/* Charts Row — release-shaped, so only for somebody who can open
          Releases, and only once there is something to chart: two empty
          charts were half the page for a new label. */}
      {canView('/releases') && (chartData.some(d => d.releases > 0 || d.lastYear > 0) || genreData.length > 0) && <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Release Pipeline Chart */}
        <div className="lg:col-span-2 card p-5 hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900">Releases per Month — {selectedYear}</h2>
            {chartData.some(d => d.lastYear > 0) && (
              <div className="flex items-center gap-4 text-xs text-gray-500">
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm bg-boom-500" />
                  {selectedYear}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm bg-gray-300" />
                  {selectedYear - 1}
                </span>
              </div>
            )}
          </div>

          {/* Filter Bar */}
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <div className="flex items-center gap-1.5 text-xs text-gray-400">
              <Filter size={13} />
              <span>Filters</span>
            </div>

            <select
              value={filterYear}
              onChange={(e) => setFilterYear(e.target.value)}
              className="text-xs border border-rule rounded-md px-2.5 py-1.5 text-gray-700 bg-card focus:outline-none focus:ring-1 focus:ring-boom-500 focus:border-boom-500 cursor-pointer"
            >
              <option value="">All Years</option>
              {availableYears.map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>

            <select
              value={filterGenre}
              onChange={(e) => setFilterGenre(e.target.value)}
              className="text-xs border border-rule rounded-md px-2.5 py-1.5 text-gray-700 bg-card focus:outline-none focus:ring-1 focus:ring-boom-500 focus:border-boom-500 cursor-pointer"
            >
              <option value="">All Genres</option>
              {availableGenres.map(g => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>

            <select
              value={filterFormat}
              onChange={(e) => setFilterFormat(e.target.value)}
              className="text-xs border border-rule rounded-md px-2.5 py-1.5 text-gray-700 bg-card focus:outline-none focus:ring-1 focus:ring-boom-500 focus:border-boom-500 cursor-pointer"
            >
              <option value="">All Formats</option>
              {availableFormats.map(f => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>

            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 ml-1 transition-colors"
              >
                <X size={12} />
                Clear
              </button>
            )}

            {chartLoading && (
              <div className="w-3.5 h-3.5 border border-boom-500 border-t-transparent rounded-full animate-spin ml-auto" />
            )}
          </div>

          {chartData.some(d => d.releases > 0 || d.lastYear > 0) ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                <XAxis
                  dataKey="month"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: '#9CA3AF' }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: '#9CA3AF' }}
                  allowDecimals={false}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
                <Bar dataKey="releases" fill="#334155" radius={[4, 4, 0, 0]} barSize={24} />
                {chartData.some(d => d.lastYear > 0) && (
                  <Bar dataKey="lastYear" fill="#D1D5DB" radius={[4, 4, 0, 0]} barSize={24} name="lastYear" />
                )}
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-60 text-gray-400 text-sm">
              No releases match these filters
            </div>
          )}
        </div>

        {/* Genre Breakdown */}
        <div className="card p-5 hover:shadow-md transition-shadow">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Releases by Genre</h2>
          {genreData.length > 0 ? (
            <div>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie
                    data={genreData}
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    innerRadius={40}
                    dataKey="count"
                    nameKey="genre"
                    labelLine={false}
                    label={CustomPieLabel}
                  >
                    {genreData.map((_, idx) => (
                      <Cell key={idx} fill={GENRE_COLORS[idx % GENRE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value, name) => [`${value} releases`, name]}
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #E5E7EB' }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-3">
                {genreData.map((g, idx) => (
                  <div key={g.genre} className="flex items-center gap-2 text-xs">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: GENRE_COLORS[idx % GENRE_COLORS.length] }} />
                    <span className="text-gray-600 truncate">{g.genre}</span>
                    <span className="text-gray-400 ml-auto tabular-nums">{g.count}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
              No genre data available
            </div>
          )}
        </div>
      </div>}

      {/* Flag rollups (Missing Genre, Duplicate Releases, Duplicate Artists)
          moved to the dedicated /duplicates Flags page so the home dashboard
          stays focused on activity + status. */}
    </div>
  )
}
