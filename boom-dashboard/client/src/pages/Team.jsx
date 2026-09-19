import { useState, useEffect, useRef } from 'react'
import { Plus, Trash2, Check, ChevronDown, Send, LayoutList, Columns, AtSign, X, TrendingUp, Loader, Users, UserPlus, Pencil, Copy } from 'lucide-react'
import { Link } from 'react-router-dom'
import api from '../api'
import { useAuth } from '../context/AuthContext'
import useHotkeys from '../hooks/useHotkeys'
import { formatDate, isPastLocal, daysUntilLocal } from '../utils'
import PageHeader from '../components/PageHeader'
import EmailPreviewModal from '../components/EmailPreviewModal'
import { PersonModal, DeleteConfirm, BoomRepsPanel } from '../components/PeopleAdmin'
import { PRESETS } from '../lib/navPresets'

const PRIORITY_DOT = {
  'Urgent': 'bg-red-600',
  'High': 'bg-boom-500',
  'Medium': 'bg-amber-400',
  'Low': 'bg-gray-300',
}

const TASK_CATEGORIES = ['General', 'Release', 'Marketing', 'A&R', 'Finance', 'Legal', 'Operations']
const CATEGORY_STYLE = {
  'General':    'bg-gray-100 text-gray-600',
  'Release':    'bg-blue-100 text-blue-700',
  'Marketing':  'bg-pink-100 text-pink-700',
  'A&R':        'bg-violet-100 text-violet-700',
  'Finance':    'bg-emerald-100 text-emerald-700',
  'Legal':      'bg-amber-100 text-amber-700',
  'Operations': 'bg-orange-100 text-orange-700',
}

const LEVEL_INDENT = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }
const LEVEL_LABEL  = { 1: 'Executive', 2: 'Executive', 3: 'Senior', 4: 'Mid', 5: 'Junior', 6: 'Intern' }

export default function Team() {
  const { user: currentUser } = useAuth()
  const [team, setTeam] = useState([])
  const [expandedId, setExpandedId] = useState(null)
  const [tasksMap, setTasksMap] = useState({})
  const [deptFilter, setDeptFilter] = useState('')
  const [showTaskForm, setShowTaskForm] = useState(false)
  const [pendingEmail, setPendingEmail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [taskForm, setTaskForm] = useState({ description: '', priority: 'Medium', due_date: '' })
  // People (2026-09-19): admins land on the DIRECTORY — accounts, roles, access,
  // last sign-in — the one list that used to be split across Settings › Users,
  // Settings › Permissions and this page. Everyone else lands on tasks.
  const isAdminUser = currentUser?.role === 'Admin' || currentUser?.role === 'Superadmin'
  const [viewMode, setViewMode] = useState(isAdminUser ? 'directory' : 'people') // 'directory' | 'people' | 'workload' | 'velocity'
  const [people, setPeople] = useState(null)
  const [personModal, setPersonModal] = useState(null) // null | { type: 'add' | 'edit' | 'delete', user }
  const [directoryNote, setDirectoryNote] = useState('')
  const fetchPeople = () => api.get('/settings/people').then((r) => setPeople(r.data?.data || [])).catch(() => setPeople([]))
  useEffect(() => { if (isAdminUser) fetchPeople() }, [isAdminUser]) // eslint-disable-line react-hooks/exhaustive-deps
  // Which presets a person's rows add up to (a preset "holds" when every one of its pages is granted).
  const presetsOf = (pages) => (!pages ? [] : PRESETS.filter((pr) => pr.paths.every((x) => pages.includes(x))).map((pr) => pr.label))
  const ago = (ts) => { if (!ts) return 'never'; const d = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000); return d === 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
  const [workloadData, setWorkloadData] = useState([])
  const [velocityData, setVelocityData] = useState(null)
  const [velocityLoading, setVelocityLoading] = useState(false)

  // Global "New Task" form with @ mention
  const [showNewTask, setShowNewTask] = useState(false)

  const VIEW_MODES = [...(isAdminUser ? ['directory'] : []), 'people', 'workload', 'velocity']
  useHotkeys([
    { key: 'n', handler: () => setShowNewTask(true) },
    ...VIEW_MODES.map((m, i) => ({ key: String(i + 1), handler: () => setViewMode(m) })),
  ])
  const [newTaskForm, setNewTaskForm] = useState({ description: '', priority: 'Medium', due_date: '', category: '' })
  const [newTaskAssignee, setNewTaskAssignee] = useState(null)
  const [showMention, setShowMention] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [savingNewTask, setSavingNewTask] = useState(false)
  const newTaskInputRef = useRef(null)

  const myLevel = currentUser?.hierarchy_level ?? 99

  useEffect(() => { fetchTeam() }, [])

  const mentionResults = mentionQuery !== null
    ? team.filter(m => m.name.toLowerCase().includes(mentionQuery)).slice(0, 15)
    : []

  const handleNewTaskDescChange = (e) => {
    const val = e.target.value
    setNewTaskForm(f => ({ ...f, description: val }))
    const lastAt = val.lastIndexOf('@')
    if (lastAt !== -1) {
      const after = val.slice(lastAt + 1)
      if (!after.includes(' ')) {
        setShowMention(true)
        setMentionQuery(after.toLowerCase())
      } else {
        setShowMention(false)
      }
    } else {
      setShowMention(false)
      setMentionQuery('')
    }
  }

  const selectMention = (member) => {
    const desc = newTaskForm.description
    const lastAt = desc.lastIndexOf('@')
    setNewTaskForm(f => ({ ...f, description: desc.slice(0, lastAt) }))
    setNewTaskAssignee(member)
    setShowMention(false)
    setMentionQuery('')
    newTaskInputRef.current?.focus()
  }

  const clearAssignee = () => {
    setNewTaskAssignee(null)
  }

  const handleSaveNewTask = async (e) => {
    e.preventDefault()
    if (!newTaskForm.description.trim() || !newTaskAssignee) return
    setSavingNewTask(true)
    try {
      const response = await api.post('/team/tasks', {
        user_id: newTaskAssignee.id,
        description: newTaskForm.description.trim(),
        priority: newTaskForm.priority,
        category: newTaskForm.category || null,
        due_date: newTaskForm.due_date || null,
      })
      setTasksMap(prev => ({
        ...prev,
        [newTaskAssignee.id]: [...(prev[newTaskAssignee.id] || []), response.data.data],
      }))
      setNewTaskForm({ description: '', priority: 'Medium', due_date: '', category: '' })
      setNewTaskAssignee(null)
      setShowNewTask(false)
      if (response.data?.pending_email) setPendingEmail(response.data.pending_email)
    } catch (err) {
      console.error('Failed to create task', err)
    } finally {
      setSavingNewTask(false)
    }
  }

  const fetchWorkload = async () => {
    try {
      const res = await api.get('/team/workload')
      setWorkloadData(res.data.data || [])
    } catch (err) { console.error('Failed to load workload', err) }
  }

  const fetchVelocity = async () => {
    setVelocityLoading(true)
    try {
      const res = await api.get('/team/velocity')
      setVelocityData(res.data.data || null)
    } catch (err) { console.error('Failed to load velocity', err) }
    setVelocityLoading(false)
  }

  const isAdmin = currentUser?.role === 'Admin' || currentUser?.role === 'Superadmin'

  const fetchTeam = async () => {
    try {
      setLoading(true)
      const response = await api.get('/team')
      const members = response.data.data || []
      setTeam(members)
      const taskResults = await Promise.all(
        members.map(m => api.get(`/team/${m.id}/tasks`).catch(() => ({ data: { data: [] } })))
      )
      const map = {}
      members.forEach((m, i) => { map[m.id] = taskResults[i].data.data || [] })
      setTasksMap(map)
    } catch (err) {
      setError('Failed to load team')
    } finally {
      setLoading(false)
    }
  }

  const handleExpand = (id) => {
    setExpandedId(expandedId === id ? null : id)
    setShowTaskForm(false)
  }

  // What action can current user take toward a target member?
  const getAction = (targetLevel) => {
    if (targetLevel < myLevel) return 'request'   // target is above me
    return 'assign'                                // target is same or below
  }

  // Can current user delete tasks on this member?
  const canDelete = (targetLevel) => targetLevel >= myLevel

  const handleAddTask = async (e) => {
    e.preventDefault()
    if (!expandedId) return
    try {
      const response = await api.post('/team/tasks', { user_id: expandedId, ...taskForm })
      setTasksMap(prev => ({
        ...prev,
        [expandedId]: [...(prev[expandedId] || []), response.data.data]
      }))
      setTaskForm({ description: '', priority: 'Medium', due_date: '' })
      setShowTaskForm(false)
      if (response.data?.pending_email) setPendingEmail(response.data.pending_email)
    } catch (err) {
      console.error('Failed to add task:', err)
    }
  }

  const handleToggleStatus = async (memberId, taskId, currentStatus) => {
    const order = ['To Do', 'In Progress', 'Done']
    const nextStatus = order[(order.indexOf(currentStatus) + 1) % order.length]
    try {
      const response = await api.put(`/team/tasks/${taskId}`, { status: nextStatus })
      setTasksMap(prev => ({
        ...prev,
        [memberId]: prev[memberId].map(t => t.id === taskId ? response.data.data : t)
      }))
    } catch (err) {
      console.error('Failed to update task:', err)
    }
  }

  const handleDeleteTask = async (memberId, taskId) => {
    if (!window.confirm('Delete this task?')) return
    try {
      await api.delete(`/team/tasks/${taskId}`)
      setTasksMap(prev => ({
        ...prev,
        [memberId]: prev[memberId].filter(t => t.id !== taskId)
      }))
    } catch (err) {
      console.error('Failed to delete task:', err)
    }
  }

  const isOverdue = (dueDate, status) => {
    if (status === 'Done' || !dueDate) return false
    return isPastLocal(dueDate)
  }

  const getSummary = (id) => {
    const t = tasksMap[id] || []
    return {
      total: t.length,
      todo: t.filter(x => x.status === 'To Do').length,
      progress: t.filter(x => x.status === 'In Progress').length,
      done: t.filter(x => x.status === 'Done').length,
      overdue: t.filter(x => isOverdue(x.due_date, x.status)).length,
      requests: t.filter(x => x.task_type === 'request' && x.status !== 'Done').length,
    }
  }

  const departments = [...new Set(team.map(m => m.department).filter(Boolean))]
  const filtered = team.filter(m => !deptFilter || m.department === deptFilter)
  const allTasks = Object.values(tasksMap).flat()
  const activeCount = allTasks.filter(t => t.status !== 'Done').length

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-boom-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Loading team...</p>
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <PageHeader
        title="People"
        subtitle={`${team.length} ${team.length === 1 ? 'person' : 'people'} · ${activeCount} active tasks`}
        actions={<>
          {viewMode === 'directory' && isAdminUser && (
            <button onClick={() => setPersonModal({ type: 'add' })} data-invite
              className="flex items-center gap-1.5 text-xs font-semibold text-white bg-gray-900 hover:bg-gray-800 px-3 py-1.5 rounded-lg transition-colors"
            ><UserPlus size={13} /> Add a person</button>
          )}
          {viewMode === 'people' && (
            <button
              onClick={() => setShowNewTask(v => !v)}
              className="flex items-center gap-1.5 text-xs font-semibold text-white bg-boom-600 hover:bg-boom-700 px-3 py-1.5 rounded-lg transition-colors"
            ><Plus size={13} /> New Task</button>
          )}
          <div className="flex items-center gap-1 bg-gray-100 p-1 rounded-lg">
            {isAdminUser && (
              <button
                onClick={() => setViewMode('directory')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${viewMode === 'directory' ? 'bg-card shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
              ><Users size={13} /> Directory</button>
            )}
            <button
              onClick={() => setViewMode('people')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${viewMode === 'people' ? 'bg-card shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
            ><LayoutList size={13} /> Tasks</button>
            <button
              onClick={() => { setViewMode('workload'); fetchWorkload() }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${viewMode === 'workload' ? 'bg-card shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
            ><Columns size={13} /> Workload</button>
            {isAdmin && (
              <button
                onClick={() => { setViewMode('velocity'); fetchVelocity() }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${viewMode === 'velocity' ? 'bg-card shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
              ><TrendingUp size={13} /> Velocity</button>
            )}
          </div>
        </>}
      />

      {/* Global New Task form */}
      {showNewTask && viewMode === 'people' && (
        <div className="mb-6 bg-card border border-rule rounded-xl p-4 shadow-sm">
          <form onSubmit={handleSaveNewTask} className="space-y-3">
            <div className="relative">
              <input
                ref={newTaskInputRef}
                autoFocus
                type="text"
                placeholder="What needs to be done? Type @ to assign to someone"
                value={newTaskForm.description}
                onChange={handleNewTaskDescChange}
                onKeyDown={e => { if (e.key === 'Escape') { setShowMention(false); setShowNewTask(false) } }}
                className="w-full text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-boom-500 placeholder:text-gray-300 bg-card"
              />
              {/* @ mention dropdown */}
              {showMention && mentionResults.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-1 bg-card border border-rule rounded-xl shadow-lg z-50 overflow-hidden">
                  <div className="flex items-center gap-1.5 px-3 py-2 border-b border-divider">
                    <AtSign size={11} className="text-gray-400" />
                    <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Assign to</span>
                  </div>
                  {mentionResults.map(m => (
                    <button
                      key={m.id}
                      type="button"
                      onMouseDown={e => { e.preventDefault(); selectMention(m) }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-surface-50 transition-colors text-left"
                    >
                      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${m.id === currentUser?.id ? 'bg-boom-100 text-boom-700' : 'bg-gray-100 text-gray-500'}`}>
                        {m.name?.charAt(0)?.toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <span className="text-xs font-medium text-gray-800 block leading-tight">{m.name}</span>
                        <span className="text-[10px] text-gray-400">{m.department}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Assignee chip + meta */}
            <div className="flex items-center gap-2 flex-wrap">
              {newTaskAssignee ? (
                <div className="flex items-center gap-1.5 bg-boom-50 text-boom-700 text-xs font-semibold px-2.5 py-1 rounded-full">
                  <AtSign size={11} />
                  {newTaskAssignee.name}
                  <button type="button" onClick={clearAssignee} className="ml-0.5 hover:text-boom-900">
                    <X size={11} />
                  </button>
                </div>
              ) : (
                <span className="text-xs text-gray-300 italic">No assignee — type @ to assign</span>
              )}
              <select
                value={newTaskForm.category}
                onChange={e => setNewTaskForm(f => ({ ...f, category: e.target.value }))}
                className="text-xs border border-rule rounded px-2 py-1 text-gray-600 bg-card"
              >
                <option value="">Category</option>
                {TASK_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <select
                value={newTaskForm.priority}
                onChange={e => setNewTaskForm(f => ({ ...f, priority: e.target.value }))}
                className="text-xs border border-rule rounded px-2 py-1 text-gray-600 bg-card"
              >
                <option>Low</option><option>Medium</option><option>High</option><option>Urgent</option>
              </select>
              <input
                type="date"
                value={newTaskForm.due_date}
                onChange={e => setNewTaskForm(f => ({ ...f, due_date: e.target.value }))}
                className="text-xs border border-rule rounded px-2 py-1 text-gray-600"
              />
              <div className="flex-1" />
              <button type="button" onClick={() => setShowNewTask(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
              <button
                type="submit"
                disabled={savingNewTask || !newTaskForm.description.trim() || !newTaskAssignee}
                className="text-xs font-semibold text-white bg-boom-600 hover:bg-boom-700 disabled:opacity-40 px-3 py-1.5 rounded-lg transition-colors"
              >
                {savingNewTask ? 'Saving…' : 'Assign Task'}
              </button>
            </div>
          </form>
        </div>
      )}

      {error && <div className="text-sm text-red-600 text-center py-12">{error}</div>}

      {/* Department Tabs — only in People view */}
      {viewMode === 'people' && (
        <div className="flex gap-0 border-b border-divider mb-6">
          {['', ...departments].map((d, i) => (
            <button
              key={i}
              onClick={() => setDeptFilter(d)}
              className={`text-xs font-medium px-4 py-2.5 -mb-px transition-colors ${
                deptFilter === d
                  ? 'text-boom-600 border-b-2 border-boom-500'
                  : 'text-gray-400 border-b-2 border-transparent hover:text-gray-600'
              }`}
            >{d || 'Everyone'}</button>
          ))}
        </div>
      )}

      {/* ── WORKLOAD BOARD ── */}
      {viewMode === 'workload' && (() => {
        const CAPACITY = (score) =>
          score === 0  ? { label: 'Available',  cls: 'bg-gray-100 text-gray-400',       bar: 'bg-gray-300'    } :
          score <= 3   ? { label: 'Light',       cls: 'bg-emerald-50 text-emerald-600',  bar: 'bg-emerald-400' } :
          score <= 7   ? { label: 'Active',      cls: 'bg-amber-50 text-amber-600',      bar: 'bg-amber-400'   } :
          score <= 12  ? { label: 'Heavy',       cls: 'bg-orange-50 text-orange-600',    bar: 'bg-orange-500'  } :
                         { label: 'Overloaded',  cls: 'bg-red-50 text-red-600',          bar: 'bg-red-500'     }

        return (
          <div className="space-y-1.5">
            {(workloadData.length > 0 ? workloadData : team.map(m => ({ ...m, releases: [] }))).map(member => {
              const memberTasks  = tasksMap[member.id] || []
              const todo         = memberTasks.filter(t => t.status === 'To Do').length
              const inProgress   = memberTasks.filter(t => t.status === 'In Progress').length
              const done         = memberTasks.filter(t => t.status === 'Done').length
              const overdue      = memberTasks.filter(t => isOverdue(t.due_date, t.status)).length
              const releaseCount = member.releases?.length ?? 0
              const avgCompletion = releaseCount > 0
                ? Math.round(member.releases.reduce((s, r) => s + r.completion, 0) / releaseCount)
                : null
              const isSelf = member.id === currentUser?.id

              const loadScore = (overdue * 3) + (inProgress * 2) + (todo * 1) + (releaseCount * 2)
              const capacity  = CAPACITY(loadScore)
              const totalTasks = todo + inProgress + done

              return (
                <div
                  key={member.id}
                  className={`flex items-center gap-5 rounded-xl border transition-colors overflow-hidden ${
                    isSelf ? 'bg-boom-50 border-boom-100' : 'bg-card border-divider hover:border-rule'
                  }`}
                >
                  {/* Load strip */}
                  <div className={`w-1 self-stretch flex-shrink-0 ${capacity.bar}`} />

                  {/* Avatar + identity */}
                  <div className="flex items-center gap-3 w-36 flex-shrink-0 py-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold ${
                      isSelf ? 'bg-boom-500 text-white' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {member.name?.charAt(0)?.toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <Link
                        to={`/team/${member.id}`}
                        className={`text-xs font-semibold truncate block transition-colors ${isSelf ? 'text-boom-700 hover:text-boom-800' : 'text-gray-800 hover:text-boom-600'}`}
                      >
                        {member.name}
                      </Link>
                      <p className="text-[10px] text-gray-400 truncate">{member.department}</p>
                    </div>
                  </div>

                  {/* Task breakdown */}
                  <div className="w-52 flex-shrink-0 py-3">
                    {totalTasks === 0 ? (
                      <p className="text-[11px] text-gray-300">No tasks</p>
                    ) : (
                      <div className="space-y-1.5">
                        {/* Stacked bar */}
                        <div className="flex h-1.5 rounded-full overflow-hidden gap-px w-full bg-gray-100">
                          {inProgress > 0 && (
                            <div className="bg-boom-500 rounded-full" style={{ width: `${(inProgress / totalTasks) * 100}%` }} />
                          )}
                          {todo > 0 && (
                            <div className="bg-gray-300 rounded-full" style={{ width: `${(todo / totalTasks) * 100}%` }} />
                          )}
                          {done > 0 && (
                            <div className="bg-emerald-400 rounded-full" style={{ width: `${(done / totalTasks) * 100}%` }} />
                          )}
                        </div>
                        {/* Legend */}
                        <div className="flex items-center gap-3">
                          {inProgress > 0 && (
                            <span className="flex items-center gap-1 text-[10px] text-gray-500">
                              <span className="w-1.5 h-1.5 rounded-full bg-boom-500 flex-shrink-0" />
                              {inProgress} active
                            </span>
                          )}
                          {todo > 0 && (
                            <span className="flex items-center gap-1 text-[10px] text-gray-400">
                              <span className="w-1.5 h-1.5 rounded-full bg-gray-300 flex-shrink-0" />
                              {todo} to do
                            </span>
                          )}
                          {overdue > 0 && (
                            <span className="flex items-center gap-1 text-[10px] text-red-500 font-semibold">
                              <span className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" />
                              {overdue} overdue
                            </span>
                          )}
                          {done > 0 && (
                            <span className="flex items-center gap-1 text-[10px] text-gray-300">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" />
                              {done} done
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Release chips */}
                  <div className="flex-1 flex items-center gap-2 flex-wrap min-w-0 py-3">
                    {releaseCount === 0 ? (
                      <span className="text-[11px] text-gray-300">No releases</span>
                    ) : (
                      member.releases.map(r => {
                        const daysUntil = daysUntilLocal(r.release_date) ?? -1
                        const isPast    = daysUntil < 0
                        const isUrgent  = !isPast && daysUntil <= 7
                        return (
                          <Link
                            key={r.id}
                            to="/releases"
                            state={{ highlightId: r.id }}
                            className="flex items-center gap-2.5 bg-gray-50 border border-divider rounded-lg px-2.5 py-1.5 hover:border-boom-200 hover:bg-boom-50 transition-all flex-shrink-0"
                          >
                            <div className="w-1 h-7 bg-gray-200 rounded-full overflow-hidden flex-shrink-0">
                              <div
                                className={`w-full rounded-full ${r.completion === 100 ? 'bg-emerald-500' : 'bg-boom-500'}`}
                                style={{ height: `${r.completion}%`, marginTop: `${100 - r.completion}%` }}
                              />
                            </div>
                            <div className="min-w-0">
                              <p className="text-[11px] font-semibold text-gray-800 truncate max-w-[100px] leading-tight">{r.project_name}</p>
                              <p className="text-[10px] text-gray-400 truncate max-w-[100px]">{r.artist_name}</p>
                            </div>
                            <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                              <span className={`text-[10px] font-bold ${r.completion === 100 ? 'text-emerald-500' : 'text-gray-400'}`}>{r.completion}%</span>
                              <span className={`text-[9px] font-medium ${isUrgent ? 'text-red-500' : isPast ? 'text-gray-300' : 'text-gray-400'}`}>
                                {isPast ? `${Math.abs(daysUntil)}d ago` : daysUntil === 0 ? 'Today' : `${daysUntil}d`}
                              </span>
                            </div>
                          </Link>
                        )
                      })
                    )}
                  </div>

                  {/* Capacity badge + avg */}
                  <div className="flex items-center gap-3 flex-shrink-0 pr-4 py-3">
                    {avgCompletion !== null && (
                      <div className="text-right">
                        <p className={`text-sm font-bold ${avgCompletion === 100 ? 'text-emerald-500' : 'text-gray-600'}`}>{avgCompletion}%</p>
                        <p className="text-[10px] text-gray-400">avg</p>
                      </div>
                    )}
                    <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full ${capacity.cls}`}>
                      {capacity.label}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )
      })()}

      {/* ── VELOCITY ── */}
      {viewMode === 'velocity' && isAdmin && (() => {
        if (velocityLoading) {
          return (
            <div className="flex items-center justify-center py-16">
              <div className="flex flex-col items-center gap-3">
                <Loader className="animate-spin text-boom-500" size={24} />
                <p className="text-sm text-gray-400">Loading velocity data...</p>
              </div>
            </div>
          )
        }
        if (!velocityData) return null

        const { velocity, totals } = velocityData
        const maxMonthly = Math.max(...velocity.flatMap(v => v.monthly.map(m => m.count)), 1)

        return (
          <div className="space-y-6">
            {/* Team summary cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="card px-4 py-3 text-center">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Total Releases</p>
                <p className="text-2xl font-black text-gray-900 mt-1">{totals.totalReleases}</p>
              </div>
              <div className="card px-4 py-3 text-center">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Last 30 Days</p>
                <p className="text-2xl font-black text-boom-600 mt-1">{totals.last30}</p>
              </div>
              <div className="card px-4 py-3 text-center">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Last 90 Days</p>
                <p className="text-2xl font-black text-gray-900 mt-1">{totals.last90}</p>
              </div>
              <div className="card px-4 py-3 text-center">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Avg Checklist</p>
                <p className={`text-2xl font-black mt-1 ${totals.avgCompletion >= 80 ? 'text-emerald-600' : totals.avgCompletion >= 50 ? 'text-amber-500' : 'text-red-500'}`}>{totals.avgCompletion}%</p>
              </div>
            </div>

            {/* Per-member velocity table */}
            <div className="card overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead>
                  <tr className="bg-gray-50 border-b border-rule">
                    <th className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider px-4 py-3">Team Member</th>
                    <th className="text-center text-[10px] font-bold text-gray-400 uppercase tracking-wider px-3 py-3">Total</th>
                    <th className="text-center text-[10px] font-bold text-gray-400 uppercase tracking-wider px-3 py-3">Released</th>
                    <th className="text-center text-[10px] font-bold text-gray-400 uppercase tracking-wider px-3 py-3">Upcoming</th>
                    <th className="text-center text-[10px] font-bold text-gray-400 uppercase tracking-wider px-3 py-3">30d</th>
                    <th className="text-center text-[10px] font-bold text-gray-400 uppercase tracking-wider px-3 py-3">90d</th>
                    <th className="text-center text-[10px] font-bold text-gray-400 uppercase tracking-wider px-3 py-3">Avg Checklist</th>
                    <th className="text-center text-[10px] font-bold text-gray-400 uppercase tracking-wider px-3 py-3">On-Time</th>
                    <th className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider px-3 py-3">12-Month Trend</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {velocity.filter(v => v.total > 0).map(v => (
                    <tr key={v.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-500">
                            {v.name?.charAt(0)?.toUpperCase()}
                          </div>
                          <div>
                            <Link to={`/team/${v.id}`} className="text-sm font-semibold text-gray-900 hover:text-boom-600 transition-colors">{v.name}</Link>
                            <p className="text-[10px] text-gray-400">{v.department}</p>
                          </div>
                        </div>
                      </td>
                      <td className="text-center px-3 py-3">
                        <span className="text-sm font-bold text-gray-900">{v.total}</span>
                      </td>
                      <td className="text-center px-3 py-3">
                        <span className="text-sm font-semibold text-emerald-600">{v.released}</span>
                      </td>
                      <td className="text-center px-3 py-3">
                        <span className="text-sm font-semibold text-blue-600">{v.upcoming}</span>
                      </td>
                      <td className="text-center px-3 py-3">
                        <span className={`text-sm font-bold ${v.last30 > 0 ? 'text-boom-600' : 'text-gray-300'}`}>{v.last30}</span>
                      </td>
                      <td className="text-center px-3 py-3">
                        <span className={`text-sm font-semibold ${v.last90 > 0 ? 'text-gray-700' : 'text-gray-300'}`}>{v.last90}</span>
                      </td>
                      <td className="text-center px-3 py-3">
                        <div className="flex items-center justify-center gap-2">
                          <div className="w-12 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${v.avgCompletion >= 80 ? 'bg-emerald-500' : v.avgCompletion >= 50 ? 'bg-amber-400' : 'bg-red-400'}`} style={{ width: `${v.avgCompletion}%` }} />
                          </div>
                          <span className="text-xs font-bold text-gray-600">{v.avgCompletion}%</span>
                        </div>
                      </td>
                      <td className="text-center px-3 py-3">
                        {v.onTimeRate !== null ? (
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                            v.onTimeRate >= 80 ? 'bg-emerald-50 text-emerald-600' :
                            v.onTimeRate >= 50 ? 'bg-amber-50 text-amber-600' :
                            'bg-red-50 text-red-600'
                          }`}>{v.onTimeRate}%</span>
                        ) : (
                          <span className="text-xs text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-end gap-px h-6">
                          {v.monthly.map((m, i) => (
                            <div key={i} className="flex-1 flex flex-col items-center" title={`${m.label}: ${m.count}`}>
                              <div
                                className={`w-full rounded-sm transition-all ${m.count > 0 ? 'bg-boom-400' : 'bg-gray-100'}`}
                                style={{ height: `${Math.max((m.count / maxMonthly) * 24, m.count > 0 ? 4 : 2)}px` }}
                              />
                            </div>
                          ))}
                        </div>
                        <div className="flex justify-between mt-1">
                          <span className="text-[8px] text-gray-300">{v.monthly[0]?.label}</span>
                          <span className="text-[8px] text-gray-300">{v.monthly[11]?.label}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Recent releases per person */}
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
              {velocity.filter(v => v.recentReleases.length > 0).map(v => (
                <div key={v.id} className="card p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-[10px] font-bold text-gray-500">
                      {v.name?.charAt(0)?.toUpperCase()}
                    </div>
                    <span className="text-xs font-semibold text-gray-900">{v.name}</span>
                    <span className="text-[10px] text-gray-400">· Recent releases</span>
                  </div>
                  <div className="space-y-1.5">
                    {v.recentReleases.map(r => (
                      <Link key={r.id} to={`/releases/${r.id}`}
                        className="flex items-center justify-between p-2 rounded-lg hover:bg-gray-50 transition-colors">
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-gray-800 truncate">{r.project_name}</p>
                          <p className="text-[10px] text-gray-400">{r.artist_name} · {r.release_type}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className={`text-[10px] font-bold ${r.completion === 100 ? 'text-emerald-500' : 'text-gray-400'}`}>{r.completion}%</span>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* ── PEOPLE LIST ── */}
      {viewMode === 'directory' && isAdminUser && (
        <div data-directory>
          {people === null ? <p className="text-sm text-gray-400 py-8 text-center">Loading…</p> : (
            <div className="border border-rule rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-rule text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                    <th className="text-left px-4 py-3">Name</th>
                    <th className="text-left px-4 py-3">Role</th>
                    <th className="text-left px-4 py-3">Department</th>
                    <th className="text-left px-4 py-3">Access</th>
                    <th className="text-left px-4 py-3">Last sign-in</th>
                    <th className="text-right px-4 py-3">Open tasks</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {people.map((u) => {
                    const pres = presetsOf(u.pages)
                    const access = u.role === 'Superadmin' ? 'everything'
                      : u.pages && u.pages.length ? `${pres.length ? pres.join(' + ') + ' · ' : ''}${u.pages.length} page${u.pages.length === 1 ? '' : 's'}`
                      : u.role === 'User' ? 'Home and Settings only' : `${u.role} defaults`
                    const canManage = currentUser?.role === 'Superadmin' || (u.role !== 'Admin' && u.role !== 'Superadmin')
                    return (
                      <tr key={u.id} className="hover:bg-gray-50 transition-colors" data-person={u.id}>
                        <td className="px-4 py-3">
                          <Link to={`/team/${u.id}`} className="flex items-center gap-2.5 group">
                            <div className="w-7 h-7 rounded-full bg-boom-100 flex items-center justify-center flex-shrink-0"><span className="text-[11px] font-bold text-boom-700">{u.name?.charAt(0)?.toUpperCase()}</span></div>
                            <div className="min-w-0">
                              <p className="font-medium text-gray-900 group-hover:text-boom-700 truncate">{u.name}{u.id === currentUser?.id ? <span className="text-[9px] font-bold tracking-wider ml-1.5 px-1 py-0.5 rounded bg-gray-100 text-gray-500">YOU</span> : null}</p>
                              <p className="text-[11px] text-gray-400 truncate">{u.email}{u.title ? ` · ${u.title}` : ''}</p>
                            </div>
                          </Link>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold ${u.role === 'Superadmin' ? 'bg-purple-50 text-purple-700' : u.role === 'Admin' ? 'bg-boom-50 text-boom-700' : u.role === 'Approver' ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-600'}`}>{u.role}</span>
                        </td>
                        <td className="px-4 py-3 text-gray-500">{u.department || '—'}</td>
                        <td className="px-4 py-3 text-gray-600 text-xs" data-access>{access}</td>
                        <td className="px-4 py-3 text-gray-500 text-xs" data-last-signin>{u.invite_pending ? <span className="text-amber-700 font-medium">invite pending</span> : ago(u.last_sign_in)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-gray-700">{u.open_tasks || 0}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 justify-end">
                            {canManage && <button onClick={() => setPersonModal({ type: 'edit', user: u })} className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg" title="Edit"><Pencil size={14} /></button>}
                            <Link to={`/team/${u.id}`} className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg" title="Open"><ChevronDown size={14} className="-rotate-90" /></Link>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[11px] text-gray-400 mt-2">Access is what a person can open: a role's defaults, or the pages granted to them. Open a person to change it.</p>
          <div className="mt-8"><BoomRepsPanel /></div>
          {personModal?.type === 'add' && <PersonModal currentUserRole={currentUser?.role} onClose={() => setPersonModal(null)} onSaved={(saved, pending) => { fetchPeople(); fetchTeam(); if (pending) setPendingEmail(pending) }} />}
          {personModal?.type === 'edit' && <PersonModal currentUserRole={currentUser?.role} user={personModal.user} onClose={() => setPersonModal(null)} onSaved={() => { fetchPeople(); fetchTeam() }} />}
          {personModal?.type === 'delete' && <DeleteConfirm user={personModal.user} onClose={() => setPersonModal(null)} onDeleted={() => { fetchPeople(); fetchTeam() }} />}
        </div>
      )}

      {viewMode === 'people' && (
      <div>
        {filtered.map((member, idx) => {
          const s = getSummary(member.id)
          const expanded = expandedId === member.id
          const memberTasks = tasksMap[member.id] || []
          const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0
          const action = getAction(member.hierarchy_level)
          const deletable = canDelete(member.hierarchy_level)
          const isSelf = member.id === currentUser?.id

          return (
            <div key={member.id} className={idx > 0 ? 'border-t border-gray-50' : ''}>
              {/* Member Row */}
              <button
                onClick={() => handleExpand(member.id)}
                className={`w-full text-left py-3.5 pr-3 pl-3 grid items-center gap-4 transition-colors ${
                  expanded ? 'bg-surface-50' : 'hover:bg-surface-50/50'
                }`}
                style={{ gridTemplateColumns: '40px 1fr 160px 110px 24px' }}
              >
                {/* Avatar */}
                <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 text-sm font-bold transition-all ${
                  s.overdue > 0 ? 'bg-red-100 text-red-600'
                  : expanded ? 'bg-boom-500 text-white'
                  : isSelf ? 'bg-boom-100 text-boom-700'
                  : 'bg-gray-100 text-gray-500'
                }`}>
                  {member.name?.charAt(0)?.toUpperCase()}
                </div>

                {/* Name + badges */}
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      to={`/team/${member.id}`}
                      onClick={e => e.stopPropagation()}
                      className="text-sm font-semibold text-gray-900 hover:text-boom-600 transition-colors"
                    >{member.name}</Link>
                    {isSelf && <span className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">YOU</span>}
                    {member.role === 'Admin' && <span className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-red-50 text-boom-600">ADMIN</span>}
                    {member.role === 'Approver' && <span className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">APPROVER</span>}
                    {member.role === 'Superadmin' && <span className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-violet-50 text-violet-600">SUPERADMIN</span>}
                    {member.role !== 'Superadmin' && member.hierarchy_level <= 2 && <span className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-violet-50 text-violet-600">EXEC</span>}
                  </div>
                  <span className="text-[11px] text-gray-400">{member.department}</span>
                </div>

                {/* Progress Bar */}
                <div className="flex items-center gap-2.5">
                  <div className="flex-1 h-1 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${pct === 100 ? 'bg-emerald-500' : 'bg-boom-500'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className={`text-[11px] font-semibold min-w-[28px] text-right ${pct === 100 ? 'text-emerald-500' : 'text-gray-400'}`}>
                    {s.total > 0 ? `${pct}%` : '—'}
                  </span>
                </div>

                {/* Task Count Pills */}
                <div className="flex gap-1 justify-end flex-wrap">
                  {s.requests > 0 && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-violet-50 text-violet-600">{s.requests} req</span>}
                  {s.overdue > 0 && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-600">{s.overdue}</span>}
                  {s.progress > 0 && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-boom-50 text-boom-600">{s.progress}</span>}
                  {s.todo > 0 && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">{s.todo}</span>}
                </div>

                <ChevronDown size={14} className={`text-gray-300 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
              </button>

              {/* Expanded Tasks */}
              {expanded && (
                <div className="bg-surface-50 pb-4 pl-16 pr-4">
                  {/* Add/Request button */}
                  <div className="mb-3">
                    {!showTaskForm ? (
                      <button
                        onClick={() => setShowTaskForm(true)}
                        className={`text-xs font-medium flex items-center gap-1.5 transition-colors ${
                          action === 'request' ? 'text-violet-600 hover:text-violet-700' : 'text-boom-600 hover:text-boom-700'
                        }`}
                      >
                        {action === 'request' ? <><Send size={12} /> Request task</> : <><Plus size={13} /> Assign task</>}
                      </button>
                    ) : (
                      <form onSubmit={handleAddTask} className={`bg-card rounded-lg border p-3 space-y-2 ${action === 'request' ? 'border-violet-200' : 'border-rule'}`}>
                        {action === 'request' && (
                          <div className="flex items-center gap-1.5 text-[10px] font-semibold text-violet-600 uppercase tracking-wider">
                            <Send size={10} /> Request — {member.name} will see this as a request
                          </div>
                        )}
                        <input
                          type="text"
                          placeholder={action === 'request' ? 'Describe what you need...' : 'Task description...'}
                          value={taskForm.description}
                          onChange={(e) => setTaskForm({ ...taskForm, description: e.target.value })}
                          required autoFocus
                          className="w-full text-sm border-0 outline-none placeholder-gray-300 font-medium"
                        />
                        <div className="flex items-center gap-2">
                          <select
                            value={taskForm.priority}
                            onChange={(e) => setTaskForm({ ...taskForm, priority: e.target.value })}
                            className="text-xs border border-rule rounded px-2 py-1 text-gray-600 bg-card"
                          >
                            <option>Low</option><option>Medium</option><option>High</option><option>Urgent</option>
                          </select>
                          <input
                            type="date"
                            value={taskForm.due_date}
                            onChange={(e) => setTaskForm({ ...taskForm, due_date: e.target.value })}
                            className="text-xs border border-rule rounded px-2 py-1 text-gray-600"
                          />
                          <div className="flex-1" />
                          <button type="button" onClick={() => setShowTaskForm(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                          <button type="submit" className={`text-xs font-semibold text-white px-3 py-1 rounded transition-colors ${action === 'request' ? 'bg-violet-500 hover:bg-violet-600' : 'bg-boom-500 hover:bg-boom-600'}`}>
                            {action === 'request' ? 'Send Request' : 'Assign'}
                          </button>
                        </div>
                      </form>
                    )}
                  </div>

                  {memberTasks.length === 0 ? (
                    <p className="text-xs text-gray-300 py-3">No tasks yet</p>
                  ) : (
                    <div className="space-y-1.5">
                      {memberTasks.map(task => {
                        const overdue = isOverdue(task.due_date, task.status)
                        const done = task.status === 'Done'
                        const isRequest = task.task_type === 'request'
                        // Can delete if: you created it OR target is at/below your level
                        const canDeleteTask = task.assigned_by === currentUser?.id || deletable

                        return (
                          <div
                            key={task.id}
                            className={`flex items-center gap-3 px-3.5 py-2.5 bg-card rounded-lg border transition-colors group ${
                              overdue ? 'border-red-200' : isRequest && !done ? 'border-violet-200' : 'border-divider'
                            }`}
                          >
                            {/* Checkbox / Request icon */}
                            {isRequest && !done ? (
                              <button onClick={() => handleToggleStatus(member.id, task.id, task.status)} className="flex-shrink-0">
                                <div className="w-[18px] h-[18px] rounded flex items-center justify-center bg-violet-100">
                                  <Send size={10} className="text-violet-500" />
                                </div>
                              </button>
                            ) : (
                              <button
                                onClick={() => handleToggleStatus(member.id, task.id, task.status)}
                                className={`w-[18px] h-[18px] rounded flex-shrink-0 flex items-center justify-center transition-all ${
                                  done ? 'bg-boom-500' : task.status === 'In Progress' ? 'border-2 border-boom-500 bg-card' : 'border-2 border-gray-300 bg-card'
                                }`}
                              >
                                {done && <Check size={11} className="text-white" strokeWidth={3} />}
                                {task.status === 'In Progress' && <div className="w-1.5 h-1.5 rounded-sm bg-boom-500" />}
                              </button>
                            )}

                            {/* Description */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className={`text-[13px] font-medium leading-snug ${done ? 'text-gray-300 line-through' : 'text-gray-800'}`}>
                                  {task.description}
                                </span>
                                {task.category && (
                                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0 ${CATEGORY_STYLE[task.category] || 'bg-gray-100 text-gray-600'}`}>
                                    {task.category}
                                  </span>
                                )}
                              </div>
                              {(isRequest || task.assigned_by_name) && (
                                <span className="text-[10px] text-gray-400 block mt-0.5">
                                  {isRequest && <span className="text-violet-500 font-semibold">REQUEST </span>}
                                  {task.assigned_by_name && `from ${task.assigned_by_name}`}
                                </span>
                              )}
                            </div>

                            {/* Priority dot */}
                            <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_DOT[task.priority] || 'bg-gray-300'}`} />

                            {/* Due date */}
                            {task.due_date && (
                              <span className={`text-[11px] font-medium flex-shrink-0 ${overdue ? 'text-red-500' : done ? 'text-gray-300' : 'text-gray-400'}`}>
                                {formatDate(task.due_date)}
                              </span>
                            )}

                            {/* Delete — only shown if permitted */}
                            {canDeleteTask && (
                              <button
                                onClick={() => handleDeleteTask(member.id, task.id)}
                                className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-300 hover:text-red-500 transition-all"
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      )}
      {pendingEmail && (
        <EmailPreviewModal
          open
          title="Send task assignment notification"
          subtitle={pendingEmail.context?.assigneeName ? `Assignee: ${pendingEmail.context.assigneeName}` : undefined}
          previewKind={pendingEmail.kind}
          previewContext={pendingEmail.context}
          initialTo={pendingEmail.to}
          initialCc={pendingEmail.cc}
          initialSubject={pendingEmail.subject}
          initialHtml={pendingEmail.html}
          team={team}
          onClose={() => setPendingEmail(null)}
          onSent={() => setPendingEmail(null)}
          onSkipped={() => setPendingEmail(null)}
          skipLabel="Skip email"
        />
      )}
    </div>
  )
}
