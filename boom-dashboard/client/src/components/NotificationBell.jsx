import { useState, useEffect, useRef } from 'react'
import { Bell, Music, FileText, X, CheckCheck, Zap, AlertTriangle, DollarSign, UserX, Clock, Inbox, Settings, AtSign } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import api from '../api'
import { useSocket } from '../context/SocketContext'

function formatDate(dateStr) {
  if (!dateStr) return ''
  const s = dateStr.split('T')[0]
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function ExpiryBadge({ days }) {
  if (days <= 30) return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-600">{days}d</span>
  if (days <= 60) return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-orange-100 text-orange-600">{days}d</span>
  return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-600">{days}d</span>
}

const SMART_ICONS = {
  contract_renewal: FileText,
  release_behind: AlertTriangle,
  budget_burn: DollarSign,
  task_overdue: Clock,
  release_unassigned: UserX,
}

const SEVERITY_STYLES = {
  critical: 'bg-red-50 border-red-200 text-red-800',
  high: 'bg-orange-50 border-orange-200 text-orange-800',
  medium: 'bg-amber-50 border-amber-200 text-amber-800',
}

const SEVERITY_DOT = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-amber-400',
}

const NOTIF_TYPES = [
  { key: 'smart_alerts',       label: 'Smart Alerts' },
  { key: 'releases',           label: 'Release Deadlines' },
  { key: 'contracts',          label: 'Contract Expirations' },
  { key: 'vendor_submissions', label: 'Vendor Submissions' },
  { key: 'budget_alerts',      label: 'Budget Warnings' },
  { key: 'reminders',          label: 'Reminders' },
]

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem('notif_prefs') || 'null') } catch { return null }
}

export default function NotificationBell() {
  const { on } = useSocket()
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [showPrefs, setShowPrefs] = useState(false)
  // Merge stored prefs over defaults so newly-added types (reminders)
  // default ON for users with an older saved prefs object.
  const [prefs, setPrefs] = useState(() => ({
    ...Object.fromEntries(NOTIF_TYPES.map(t => [t.key, true])),
    ...(loadPrefs() || {}),
  }))
  const [dismissedCount, setDismissedCount] = useState(() => {
    return parseInt(localStorage.getItem('notif_dismissed_count') || '0', 10)
  })
  const containerRef = useRef(null)
  const navigate = useNavigate()

  const togglePref = (key) => {
    setPrefs(prev => {
      const next = { ...prev, [key]: !prev[key] }
      localStorage.setItem('notif_prefs', JSON.stringify(next))
      return next
    })
  }

  const fetchNotifications = async () => {
    setLoading(true)
    try {
      const res = await api.get('/notifications')
      setData(res.data.data)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchNotifications()
    const interval = setInterval(fetchNotifications, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  // A chat @mention has to show up NOW, not on the next 5-minute tick — being
  // mentioned in a live conversation and hearing about it four minutes later is
  // the same as not hearing about it. The server emits `mention` to each
  // mentioned user the moment the message is stored (server/routes/chat.js);
  // this just re-reads /api/notifications, so the bell keeps ONE source of
  // truth rather than learning to merge a socket payload into its own state.
  useEffect(() => on('mention', fetchNotifications), [on])

  useEffect(() => {
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Mentions are excluded from the dismissed watermark: (a) Clear All must
  // not zero the badge while unread mentions still exist (mentions
  // intentionally ignore clear-all), and (b) reading a mention later
  // decrements total_count below a mention-inclusive watermark, hiding
  // future alerts until the total climbs back past the stale number.
  const totalCount = data?.total_count ?? 0
  // Mentions and reminders are cleared per-item (read / Done), so they sit
  // outside the clear-all watermark like mentions always have.
  const mentionCount = (data?.mentions || []).length
  const reminderCount = (data?.reminders || []).length
  const nonMentionCount = Math.max(0, totalCount - mentionCount - reminderCount)
  const count = Math.max(0, nonMentionCount - dismissedCount) + mentionCount + reminderCount

  const [cleared, setCleared] = useState(false)

  const handleClearAll = () => {
    setDismissedCount(nonMentionCount)
    localStorage.setItem('notif_dismissed_count', String(nonMentionCount))
    setCleared(true)
  }

  const handleReleaseClick = (releaseId) => {
    setOpen(false)
    navigate('/releases', { state: { highlightId: releaseId, tab: 'checklist' } })
  }

  const handleContractClick = () => {
    setOpen(false)
    navigate('/contracts')
  }

  const handleSmartClick = (alert) => {
    setOpen(false)
    if (alert.release_id) navigate(`/releases/${alert.release_id}`)
    else if (alert.artist_id) navigate(`/artists/${alert.artist_id}`)
    else if (alert.type === 'task_overdue') navigate('/team')
    else navigate('/contracts')
  }

  // @mentions are persisted server-side and cleared per-item on click —
  // they intentionally ignore the localStorage clear-all so a mention
  // can't be swept away unseen.
  const mentions = data?.mentions || []
  const handleMentionClick = async (m) => {
    setOpen(false)
    try { await api.post('/notifications/mentions/read', { ids: [m.id] }) } catch {}
    setData(prev => prev ? { ...prev, mentions: (prev.mentions || []).filter(x => x.id !== m.id), total_count: Math.max(0, (prev.total_count || 1) - 1) } : prev)
    if (m.room_path) navigate(m.room_path)
  }

  // Reminders clear via Done (advances next_due server-side), not clear-all.
  const reminders = prefs.reminders ? (data?.reminders || []) : []
  const handleReminderDone = async (r) => {
    try { await api.post(`/reminders/${r.id}/done`) } catch {}
    setData(prev => prev ? {
      ...prev,
      reminders: (prev.reminders || []).filter(x => x.id !== r.id),
      total_count: Math.max(0, (prev.total_count || 1) - 1),
    } : prev)
  }
  const handleReminderClick = (r) => {
    setOpen(false)
    if (r.link) navigate(r.link)
  }

  const smartAlerts = cleared || !prefs.smart_alerts ? [] : (data?.smart_alerts || [])
  const showReleases = !cleared && prefs.releases && data?.releases?.length > 0
  const showContracts = !cleared && prefs.contracts && data?.contracts?.length > 0
  const showVendor = !cleared && prefs.vendor_submissions && data?.vendor_submissions?.length > 0
  const showBudget = !cleared && prefs.budget_alerts && data?.budget_alerts?.length > 0
  const allEmpty = smartAlerts.length === 0 && !showReleases && !showContracts && !showVendor && !showBudget && mentions.length === 0 && reminders.length === 0

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => { setOpen(o => !o); if (!open) setCleared(false) }}
        className={`relative p-2 rounded-lg transition-colors ${
          open ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
        }`}
      >
        <Bell size={18} strokeWidth={1.75} />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center text-[10px] font-bold bg-red-500 text-white rounded-full px-1 leading-none">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-96 bg-white rounded-xl shadow-lg border border-gray-200 z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <span className="text-sm font-semibold text-gray-900">Notifications</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowPrefs(v => !v)}
                className={`text-gray-400 hover:text-gray-600 transition-colors ${showPrefs ? 'text-boom-600' : ''}`}
                title="Notification preferences"
              >
                <Settings size={13} />
              </button>
              {totalCount > 0 && count > 0 && (
                <button
                  onClick={handleClearAll}
                  className="flex items-center gap-1 text-[11px] font-medium text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <CheckCheck size={12} />
                  Clear
                </button>
              )}
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">
                <X size={14} />
              </button>
            </div>
          </div>

          {showPrefs && (
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/50">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Show notifications for</p>
              <div className="space-y-1.5">
                {NOTIF_TYPES.map(t => (
                  <label key={t.key} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={prefs[t.key]}
                      onChange={() => togglePref(t.key)}
                      className="rounded border-gray-300 text-boom-600 focus:ring-boom-500"
                      style={{ width: 14, height: 14 }}
                    />
                    <span className="text-xs text-gray-600">{t.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="max-h-[520px] overflow-y-auto">
            {loading && !data && (
              <div className="px-4 py-6 text-sm text-center text-gray-400">Loading...</div>
            )}

            {data && (totalCount === 0 || allEmpty) && (
              <div className="px-4 py-8 text-sm text-center text-gray-400">
                <Bell size={24} className="mx-auto mb-2 text-gray-300" />
                All clear — no pending alerts.
              </div>
            )}

            {/* Reminders — due personal reminders; Done advances the cycle */}
            {reminders.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 px-4 pt-3 pb-1.5">
                  <Clock size={11} className="text-amber-600" />
                  <span className="text-[10px] font-bold text-amber-600 uppercase tracking-wider">Reminders</span>
                </div>
                {reminders.map(r => (
                  <div key={r.id} className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-gray-50 border-b border-gray-50">
                    <button onClick={() => handleReminderClick(r)} className="flex-1 min-w-0 text-left">
                      <span className="block text-[13px] font-medium text-gray-900 truncate">{r.title}</span>
                      <span className="block text-[11px] text-gray-400">
                        due {formatDate(String(r.next_due))}{r.cadence !== 'once' ? ` · ${r.cadence}` : ''}
                      </span>
                    </button>
                    <button onClick={() => handleReminderDone(r)}
                      className="text-[11px] font-bold text-emerald-700 border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 rounded-md px-2 py-1 shrink-0">
                      Done
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* @Mentions — chat callouts, cleared per-item on click */}
            {mentions.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 px-4 pt-3 pb-1.5">
                  <AtSign size={11} className="text-boom-600" />
                  <span className="text-[10px] font-bold text-boom-600 uppercase tracking-wider">
                    Mentions
                  </span>
                </div>
                {mentions.map(m => (
                  <button
                    key={m.id}
                    onClick={() => handleMentionClick(m)}
                    className="w-full text-left px-4 py-2.5 hover:bg-boom-50 transition-colors"
                  >
                    <p className="text-sm font-medium text-gray-900">
                      {m.actor_name || 'Someone'} mentioned you{m.room_title ? ` in ${m.room_title}` : ''}
                    </p>
                    <p className="text-xs text-gray-500 truncate">“{m.snippet}”</p>
                  </button>
                ))}
              </div>
            )}

            {/* Smart Alerts */}
            {smartAlerts.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 px-4 pt-3 pb-1.5">
                  <Zap size={11} className="text-amber-500" />
                  <span className="text-[10px] font-bold text-amber-600 uppercase tracking-wider">
                    Smart Alerts
                  </span>
                </div>
                {smartAlerts.map(alert => {
                  const Icon = SMART_ICONS[alert.type] || AlertTriangle
                  const style = SEVERITY_STYLES[alert.severity] || SEVERITY_STYLES.medium
                  const dot = SEVERITY_DOT[alert.severity] || SEVERITY_DOT.medium
                  return (
                    <button
                      key={alert.id}
                      onClick={() => handleSmartClick(alert)}
                      className="w-full text-left px-4 py-2.5 hover:bg-gray-50 transition-colors"
                    >
                      <div className={`${style} border rounded-lg px-3 py-2.5 flex items-start gap-2.5`}>
                        <div className="flex-shrink-0 mt-0.5">
                          <Icon size={13} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium leading-relaxed">{alert.title}</p>
                        </div>
                        <span className={`w-2 h-2 rounded-full ${dot} flex-shrink-0 mt-1`} />
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            {/* Upcoming Releases */}
            {showReleases && (
              <div>
                <div className="flex items-center gap-1.5 px-4 pt-3 pb-1.5">
                  <Music size={11} className="text-gray-400" />
                  <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                    Upcoming Releases · Incomplete Checklists
                  </span>
                </div>
                {data.releases.map(r => (
                  <button
                    key={r.id}
                    onClick={() => handleReleaseClick(r.id)}
                    className="w-full text-left px-4 py-2.5 hover:bg-boom-50 transition-colors flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{r.project_name}</p>
                      <p className="text-xs text-gray-500">{r.artist_name} · {formatDate(r.release_date)}</p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        r.days_until <= 3 ? 'bg-red-100 text-red-600' :
                        r.days_until <= 7 ? 'bg-orange-100 text-orange-600' :
                        'bg-amber-100 text-amber-600'
                      }`}>{r.days_until}d</span>
                      <span className="text-xs font-semibold text-orange-600">{r.completion}%</span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Expiring Contracts */}
            {showContracts && (
              <div>
                <div className="flex items-center gap-1.5 px-4 pt-3 pb-1.5">
                  <FileText size={11} className="text-gray-400" />
                  <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                    Expiring Contracts
                  </span>
                </div>
                {data.contracts.map(c => (
                  <button
                    key={c.id}
                    onClick={handleContractClick}
                    className="w-full text-left px-4 py-2.5 hover:bg-boom-50 transition-colors flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{c.artist_name}</p>
                      <p className="text-xs text-gray-500">{c.type} · expires {formatDate(c.expiration_date)}</p>
                    </div>
                    <ExpiryBadge days={parseInt(c.days_until_expiry)} />
                  </button>
                ))}
              </div>
            )}

            {/* Vendor Submissions */}
            {showVendor && (
              <div>
                <div className="flex items-center gap-1.5 px-4 pt-3 pb-1.5">
                  <Inbox size={11} className="text-violet-500" />
                  <span className="text-[10px] font-bold text-violet-600 uppercase tracking-wider">
                    Vendor Submissions ({data.vendor_submissions.length})
                  </span>
                </div>
                {data.vendor_submissions.map(v => (
                  <button
                    key={v.id}
                    onClick={() => { setOpen(false); navigate('/bk/approvals') }}
                    className="w-full text-left px-4 py-2.5 hover:bg-boom-50 transition-colors flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{v.vendor_name || v.payee}</p>
                      <p className="text-xs text-gray-500">
                        {v.artist ? `${v.artist} · ` : ''}{v.invoice_number ? `#${v.invoice_number} · ` : ''}
                        {new Date(v.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </p>
                    </div>
                    <span className="text-xs font-bold text-gray-700 flex-shrink-0">
                      {parseFloat(v.amount).toLocaleString('en-US', { style: 'currency', currency: v.currency || 'USD', minimumFractionDigits: 0 })}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* Budget Alerts */}
            {showBudget && (
              <div>
                <div className="flex items-center gap-1.5 px-4 pt-3 pb-1.5">
                  <DollarSign size={11} className="text-gray-400" />
                  <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                    Budget Alerts
                  </span>
                </div>
                {data.budget_alerts.map(b => (
                  <button
                    key={b.id}
                    onClick={() => { setOpen(false); navigate(`/artists/${b.id}`) }}
                    className="w-full text-left px-4 py-2.5 hover:bg-boom-50 transition-colors flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{b.artist_name}</p>
                      <p className="text-xs text-gray-500">{b.pct_used}% of budget used</p>
                    </div>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      b.pct_used >= 95 ? 'bg-red-100 text-red-600' : 'bg-orange-100 text-orange-600'
                    }`}>{b.pct_used}%</span>
                  </button>
                ))}
              </div>
            )}

            <div className="h-2" />
          </div>
        </div>
      )}
    </div>
  )
}
