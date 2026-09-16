import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ChevronLeft, Music, CheckSquare, Activity, Clock } from 'lucide-react'
import Breadcrumb from '../components/Breadcrumb'
import api from '../api'
import { formatDate, isPastLocal, daysUntilLocal } from '../utils'
import { useAuth } from '../context/AuthContext'

const PRIORITY_DOT = { 'Urgent': 'bg-red-600', 'High': 'bg-boom-500', 'Medium': 'bg-amber-400', 'Low': 'bg-gray-300' }
const STATUS_STYLE = {
  'To Do':       'bg-gray-100 text-gray-500',
  'In Progress': 'bg-blue-100 text-blue-700',
  'Done':        'bg-emerald-100 text-emerald-700',
}
const CATEGORY_STYLE = {
  'General':    'bg-gray-100 text-gray-600',
  'Release':    'bg-blue-100 text-blue-700',
  'Marketing':  'bg-pink-100 text-pink-700',
  'A&R':        'bg-violet-100 text-violet-700',
  'Finance':    'bg-emerald-100 text-emerald-700',
  'Legal':      'bg-amber-100 text-amber-700',
  'Operations': 'bg-orange-100 text-orange-700',
}

export default function TeamMember() {
  const { id } = useParams()
  const { user: currentUser } = useAuth()
  const [member, setMember] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('releases')

  useEffect(() => {
    const fetch = async () => {
      setLoading(true)
      try {
        const res = await api.get(`/team/${id}`)
        setMember(res.data.data)
      } catch (err) {
        console.error('Failed to load member', err)
      } finally {
        setLoading(false)
      }
    }
    fetch()
  }, [id])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-8 h-8 border-2 border-boom-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!member) {
    return <div className="text-center py-24 text-sm text-gray-400">Member not found.</div>
  }

  const isSelf = member.id === currentUser?.id
  const openTasks = (member.tasks || []).filter(t => t.status !== 'Done')
  const doneTasks = (member.tasks || []).filter(t => t.status === 'Done')
  const overdueTasks = openTasks.filter(t => isPastLocal(t.due_date))
  const avgCompletion = member.releases?.length > 0
    ? Math.round(member.releases.reduce((s, r) => s + r.completion, 0) / member.releases.length)
    : null
  const upcoming = (member.releases || []).filter(r => {
    const d = daysUntilLocal(r.release_date) ?? -1
    return d >= 0 && d <= 14
  })

  const TABS = [
    { id: 'releases',  label: 'Releases',  count: member.releases?.length },
    { id: 'tasks',     label: 'Tasks',     count: openTasks.length },
    { id: 'activity',  label: 'Activity',  count: null },
  ]

  return (
    <div className="space-y-6">
      <Breadcrumb items={[
        { label: 'Team', path: '/team' },
        { label: member.name },
      ]} />

      {/* Profile Header */}
      <div className="card p-6">
        <div className="flex items-start gap-5">
          <div className={`w-14 h-14 rounded-full flex items-center justify-center text-lg font-bold flex-shrink-0 ${
            isSelf ? 'bg-boom-100 text-boom-700' : 'bg-gray-100 text-gray-500'
          }`}>
            {member.name?.charAt(0)?.toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-gray-900">{member.name}</h1>
              {isSelf && <span className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">YOU</span>}
              {member.role === 'Admin' && <span className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-red-50 text-boom-600">ADMIN</span>}
              {member.role === 'Approver' && <span className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">APPROVER</span>}
              {member.role === 'Superadmin' && <span className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-violet-50 text-violet-600">SUPERADMIN</span>}
              {member.hierarchy_level <= 2 && <span className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-violet-50 text-violet-600">EXEC</span>}
            </div>
            <p className="text-sm text-gray-400 mt-0.5">{member.department} · {member.email}</p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-6 border-t border-divider">
          {[
            { label: 'Releases',       value: member.releases?.length ?? 0 },
            { label: 'Avg Completion', value: avgCompletion !== null ? `${avgCompletion}%` : '—' },
            { label: 'Open Tasks',     value: openTasks.length,  highlight: openTasks.length > 5 },
            { label: 'Overdue',        value: overdueTasks.length, highlight: overdueTasks.length > 0, highlightColor: 'text-red-500' },
          ].map(s => (
            <div key={s.label} className="text-center">
              <p className={`text-2xl font-bold ${s.highlight && s.highlightColor ? s.highlightColor : 'text-gray-900'}`}>{s.value}</p>
              <p className="text-xs text-gray-400 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Upcoming alert */}
        {upcoming.length > 0 && (
          <div className="mt-4 px-3 py-2 bg-orange-50 border border-orange-200 rounded-lg flex items-center gap-2">
            <Clock size={13} className="text-orange-500 flex-shrink-0" />
            <p className="text-xs text-orange-700 font-medium">
              {upcoming.length} release{upcoming.length !== 1 ? 's' : ''} dropping in the next 14 days with incomplete checklists
            </p>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="card overflow-hidden">
        <div className="flex border-b border-divider px-6">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 py-3.5 mr-6 text-xs font-semibold border-b-2 transition-all ${
                tab === t.id ? 'border-red-500 text-red-500' : 'border-transparent text-gray-400 hover:text-gray-600'
              }`}
            >
              {t.label}
              {t.count != null && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
                  tab === t.id ? 'bg-red-50 text-red-500' : 'bg-gray-100 text-gray-400'
                }`}>{t.count}</span>
              )}
            </button>
          ))}
        </div>

        <div className="p-6">
          {/* RELEASES TAB */}
          {tab === 'releases' && (
            <div>
              {!member.releases?.length ? (
                <p className="text-sm text-gray-400 text-center py-8">No releases assigned.</p>
              ) : (
                <div className="space-y-2">
                  {member.releases.map(r => {
                    const daysUntil = daysUntilLocal(r.release_date) ?? -1
                    const isPast = daysUntil < 0
                    const isUrgent = !isPast && daysUntil <= 7
                    return (
                      <Link
                        key={r.id}
                        to="/releases"
                        state={{ highlightId: r.id }}
                        className="flex items-center gap-4 p-3 rounded-lg border border-divider hover:border-boom-300 hover:bg-boom-50/30 transition-all"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-gray-900 truncate">{r.project_name}</p>
                          <p className="text-xs text-gray-400">{r.artist_name} · {formatDate(r.release_date)}</p>
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          <div className="flex items-center gap-2">
                            <div className="w-20 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${r.completion === 100 ? 'bg-emerald-500' : 'bg-boom-500'}`}
                                style={{ width: `${r.completion}%` }}
                              />
                            </div>
                            <span className="text-xs font-semibold text-gray-400 w-8 tabular-nums">{r.completion}%</span>
                          </div>
                          <span className={`text-xs font-medium w-16 text-right ${isUrgent ? 'text-red-500' : isPast ? 'text-gray-300' : 'text-gray-400'}`}>
                            {isPast ? `${Math.abs(daysUntil)}d ago` : daysUntil === 0 ? 'Today' : `${daysUntil}d`}
                          </span>
                          {r.priority === 'high priority' && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-600">HIGH</span>}
                        </div>
                      </Link>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* TASKS TAB */}
          {tab === 'tasks' && (
            <div>
              {!member.tasks?.length ? (
                <p className="text-sm text-gray-400 text-center py-8">No tasks.</p>
              ) : (
                <div className="space-y-2">
                  {member.tasks.map(task => {
                    const overdue = task.status !== 'Done' && isPastLocal(task.due_date)
                    return (
                      <div key={task.id} className={`flex items-center gap-3 p-3 rounded-lg border ${overdue ? 'border-red-200 bg-red-50/30' : 'border-divider'}`}>
                        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_DOT[task.priority] || 'bg-gray-300'}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className={`text-sm font-medium ${task.status === 'Done' ? 'line-through text-gray-300' : 'text-gray-800'}`}>{task.description}</p>
                            {task.category && (
                              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0 ${CATEGORY_STYLE[task.category] || 'bg-gray-100 text-gray-600'}`}>
                                {task.category}
                              </span>
                            )}
                          </div>
                          {task.assigned_by_name && (
                            <p className="text-xs text-gray-400 mt-0.5">from {task.assigned_by_name}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {task.due_date && (
                            <span className={`text-xs ${overdue ? 'text-red-500 font-semibold' : 'text-gray-400'}`}>{formatDate(task.due_date)}</span>
                          )}
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${STATUS_STYLE[task.status] || 'bg-gray-100 text-gray-500'}`}>{task.status}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* ACTIVITY TAB */}
          {tab === 'activity' && (
            <div>
              {!member.activity?.length ? (
                <p className="text-sm text-gray-400 text-center py-8">No activity recorded.</p>
              ) : (
                <div className="space-y-0 divide-y divide-gray-100">
                  {member.activity.map((entry, i) => (
                    <div key={i} className="flex items-start gap-3 py-3">
                      <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <span className="text-[10px] font-bold text-gray-500">{member.name?.charAt(0)?.toUpperCase()}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-700">{entry.detail}</p>
                        <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
                          <Clock size={10} />
                          {new Date(entry.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
