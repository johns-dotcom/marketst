import { useState, useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Clock, CheckSquare, ChevronRight, Plus, Trash2, Check, Circle, Loader, X, Search, UserPlus, UserMinus, ArrowUpDown, AtSign, ChevronDown, Pencil, CalendarDays, MessageSquare, Sun } from 'lucide-react'
import api from '../api'
import { formatDate, isPastLocal, daysUntilLocal } from '../utils'
import Skeleton from '../components/Skeleton'
import MyWorkRail from '../components/MyWorkRail'
import TaskList from '../components/mywork/TaskList'
import TaskDetail from '../components/mywork/TaskDetail'
import useAutosave from '../components/mywork/useAutosave'
import { useAuth } from '../context/AuthContext'
import EmailPreviewModal from '../components/EmailPreviewModal'

const PRIORITY_DOT = {
  'Urgent': 'bg-red-600',
  'High':   'bg-boom-500',
  'Medium': 'bg-amber-400',
  'Low':    'bg-gray-300',
}

// Single-click toggle: any non-Done status -> Done; Done -> To Do.
// "In Progress" is still a valid state but it's set via the edit form, not
// the status circle — making the circle a one-click 'mark done' control.
const STATUS_CYCLE = { 'To Do': 'Done', 'In Progress': 'Done', 'Done': 'To Do' }
const STATUS_STYLE = {
  'To Do':       'bg-gray-100 text-gray-500',
  'In Progress': 'bg-blue-100 text-blue-700',
  'Done':        'bg-emerald-100 text-emerald-700',
}

function greeting(name) {
  const h = new Date().getHours()
  const g = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  return `${g}, ${name?.split(' ')[0]}.`
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

function relativeDate(dateStr) {
  if (!dateStr) return null
  // Local-calendar diff — new Date('YYYY-MM-DD') is UTC midnight, which
  // made tasks due TODAY read "Yesterday" in US timezones.
  const diff = daysUntilLocal(dateStr)
  if (diff == null) return null
  if (diff < -1) return `${Math.abs(diff)}d ago`
  if (diff === -1) return 'Yesterday'
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff <= 7) return `In ${diff} days`
  return formatDate(dateStr)
}

const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

// Group rendering config. Each bucket has a label + order + accent color for
// the left stripe on rows. Buckets always render in `order` sequence so
// Overdue → Today → This Week is the natural scanning top-down.
const DUE_BUCKETS = {
  overdue: { label: 'Overdue',      order: 0, accent: 'text-red-600'    },
  today:   { label: 'Today',        order: 1, accent: 'text-amber-600'  },
  week:    { label: 'This Week',    order: 2, accent: 'text-blue-600'   },
  later:   { label: 'Later',        order: 3, accent: 'text-gray-500'   },
  none:    { label: 'No Due Date',  order: 4, accent: 'text-gray-400'   },
}
const PRIORITY_BUCKETS = {
  Urgent:  { label: 'Urgent', order: 0, accent: 'text-red-600'    },
  High:    { label: 'High',   order: 1, accent: 'text-amber-600'  },
  Medium:  { label: 'Medium', order: 2, accent: 'text-blue-600'   },
  Low:     { label: 'Low',    order: 3, accent: 'text-gray-500'   },
  None:    { label: 'No Priority', order: 4, accent: 'text-gray-400' },
}
// Category buckets are derived dynamically from TASK_CATEGORIES so adding a
// new category to the list automatically picks up its own group.
const CATEGORY_BUCKETS = (() => {
  const out = {}
  TASK_CATEGORIES.forEach((c, i) => { out[c] = { label: c, order: i, accent: 'text-gray-600' } })
  out.None = { label: 'No Category', order: TASK_CATEGORIES.length, accent: 'text-gray-400' }
  return out
})()

function bucketByCategory(task) {
  return task.category && CATEGORY_BUCKETS[task.category] ? task.category : 'None'
}

function bucketByDue(task) {
  // Local-calendar day diff — new Date('YYYY-MM-DD') is UTC midnight,
  // which shifted every bucket back a day in US timezones.
  const diff = daysUntilLocal(task.due_date)
  if (diff == null) return 'none'
  if (diff < 0) return 'overdue'
  if (diff === 0) return 'today'
  if (diff <= 7) return 'week'
  return 'later'
}
function bucketByPriority(task) {
  const p = task.priority
  return (p && PRIORITY_BUCKETS[p]) ? p : 'None'
}

// Priority-based left-stripe color — used on rows regardless of bucket axis,
// so the urgency of each task is readable without reading the group header.
const PRIORITY_STRIPE = {
  Urgent: 'bg-red-500',
  High:   'bg-amber-400',
  Medium: 'bg-blue-400',
  Low:    'bg-gray-300',
}

function CalendarView({ tasks, releases, onEditTask }) {
  const today = new Date()
  today.setHours(0,0,0,0)

  // Build 28 days (4 weeks) starting from the current week's Monday
  const startOfWeek = new Date(today)
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay()) // Sunday

  const days = []
  for (let i = 0; i < 28; i++) {
    const d = new Date(startOfWeek)
    d.setDate(d.getDate() + i)
    days.push(d)
  }

  const toKey = (d) => d.toISOString().slice(0, 10)
  const todayKey = toKey(today)

  // Index tasks and releases by date
  const tasksByDate = {}
  tasks.forEach(t => {
    if (!t.due_date || t.status === 'Done') return
    const key = String(t.due_date).slice(0, 10)
    if (!tasksByDate[key]) tasksByDate[key] = []
    tasksByDate[key].push(t)
  })

  const releasesByDate = {}
  releases.forEach(r => {
    if (!r.release_date) return
    const key = String(r.release_date).slice(0, 10)
    if (!releasesByDate[key]) releasesByDate[key] = []
    releasesByDate[key].push(r)
  })

  return (
    <div className="border border-rule rounded-xl overflow-hidden bg-card mb-4">
      {/* Day headers */}
      <div className="grid grid-cols-7 bg-gray-50 border-b border-rule">
        {DAY_NAMES.map(d => (
          <div key={d} className="px-2 py-2 text-center text-[10px] font-bold text-gray-400 uppercase tracking-wider">{d}</div>
        ))}
      </div>
      {/* Calendar grid */}
      <div className="grid grid-cols-7">
        {days.map((d, i) => {
          const key = toKey(d)
          const isToday = key === todayKey
          const isPast = d < today
          const dayTasks = tasksByDate[key] || []
          const dayReleases = releasesByDate[key] || []
          const isCurrentMonth = d.getMonth() === today.getMonth()

          return (
            <div
              key={i}
              className={`min-h-[80px] p-1.5 border-r border-b border-divider ${
                isToday ? 'bg-boom-50/40' : isPast ? 'bg-gray-50/50' : ''
              }`}
            >
              <p className={`text-[11px] font-bold mb-1 ${
                isToday ? 'text-boom-600' : isCurrentMonth ? 'text-gray-700' : 'text-gray-300'
              }`}>
                {d.getDate()}
                {isToday && <span className="ml-1 text-[9px] font-normal">Today</span>}
              </p>

              {/* Releases */}
              {dayReleases.map(r => (
                <div
                  key={`r-${r.id}`}
                  className="text-[10px] px-1.5 py-0.5 rounded mb-0.5 truncate bg-boom-100 text-boom-700 font-semibold"
                  title={`Release: ${r.artist_name} — ${r.project_name}`}
                >
                  {r.project_name}
                </div>
              ))}

              {/* Tasks */}
              {dayTasks.map(t => (
                <div
                  key={`t-${t.id}`}
                  onClick={() => onEditTask && onEditTask(t)}
                  className={`text-[10px] px-1.5 py-0.5 rounded mb-0.5 truncate cursor-pointer ${
                    t.priority === 'Urgent' ? 'bg-red-100 text-red-700' :
                    t.priority === 'High' ? 'bg-amber-100 text-amber-700' :
                    'bg-gray-100 text-gray-600'
                  }`}
                  title={t.description}
                >
                  {t.description}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const BLANK_FORM = { description: '', priority: 'Medium', due_date: '', category: '' }

export default function MyWork() {
  const { user } = useAuth()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('tasks')

  // ── The two-pane state ──
  //
  // `bucket` replaces the five stacked bands. `selectedId` is which note is
  // open. Both are plain state: the URL does not carry them because a task is
  // not a page, and a shareable link to "whatever I had selected" is not a
  // thing anybody wants.
  const [bucket, setBucket] = useState('open')
  const [selectedId, setSelectedId] = useState(null)
  const [listQuery, setListQuery] = useState('')
  const [dragId, setDragId] = useState(null)

  // The body autosaves. `change` captures the task id AT THE KEYSTROKE, so
  // clicking another task before the debounce fires cannot write this task's
  // text onto that one — see components/mywork/useAutosave.js, which is
  // asserted against exactly that race.
  const autosave = useAutosave(async (id, patch) => {
    await api.put(`/team/tasks/${id}`, patch)
    // ── Patch the ONE task, never refetch ─────────────────────────────────────
    // This used to `await fetchData()` after every write, with a comment arguing
    // that optimistic local state would be a second source of truth. That was
    // wrong, and badly so: `fetchData` sets `loading = true`, which takes the
    // early return and renders the SKELETON — so every 600ms of typing tore the
    // textarea out of the DOM, dropped focus, and replaced what had been typed
    // with whatever the server last knew. That is the "lags every letter".
    //
    // A single patch is not a second source of truth; it is the same truth, and
    // it is what the server just confirmed. The row preview and the detail pane
    // both read `data.tasks`, so they still cannot disagree.
    setData(prev => (prev ? {
      ...prev,
      tasks: (prev.tasks || []).map(t => (t.id === id ? { ...t, ...patch } : t)),
    } : prev))
  })

  // Task creation
  const [showAddTask, setShowAddTask] = useState(false)
  const [taskForm, setTaskForm] = useState(BLANK_FORM)
  const [savingTask, setSavingTask] = useState(false)
  const [pendingEmail, setPendingEmail] = useState(null)
  const [teamRoster, setTeamRoster] = useState([])
  useEffect(() => {
    api.get('/team').then(r => {
      const list = Array.isArray(r.data?.data) ? r.data.data : (Array.isArray(r.data) ? r.data : [])
      setTeamRoster(list.filter(u => u && u.email))
    }).catch(() => {})
  }, [])

  // Open the add-task form when navigated to with ?new=task (mobile FAB
  // → New Task uses this so the page lands ready to type a description).
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.get('new') === 'task') {
      // The mobile FAB lands here. It used to open the deleted form; now it does
      // what the button does. Fired once — the URL is cleaned below.
      setTab('tasks')
      newTask()
      // Clean the URL so a refresh doesn't re-open the form.
      navigate('/my-work', { replace: true })
    }
  }, [location.search])

  // @ mention / assignment
  const [teamMembers, setTeamMembers] = useState([])
  const [assignedToUser, setAssignedToUser] = useState(null)
  const [showMention, setShowMention] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const descInputRef = useRef(null)

  // Task mutations
  const [togglingId, setTogglingId] = useState(null)
  const [deletingId, setDeletingId] = useState(null)

  // Quick-add
  const [quickAdd, setQuickAdd] = useState('')
  const quickAddRef = useRef(null)

  // Edit task
  const [editingTask, setEditingTask] = useState(null)
  const [editForm, setEditForm] = useState({})
  const [savingEdit, setSavingEdit] = useState(false)

  const startEdit = (task) => {
    setEditingTask(task.id)
    setEditForm({
      description: task.description || '',
      priority: task.priority || 'Medium',
      category: task.category || '',
      due_date: task.due_date ? task.due_date.slice(0, 10) : '',
      release_id: task.release_id || '',
    })
  }

  const saveEdit = async () => {
    if (!editingTask) return
    setSavingEdit(true)
    try {
      await api.put(`/team/tasks/${editingTask}`, {
        description: editForm.description.trim(),
        priority: editForm.priority,
        category: editForm.category || null,
        due_date: editForm.due_date || null,
        release_id: editForm.release_id || null,
      })
      await fetchData()
      setEditingTask(null)
    } catch {
      alert('Failed to save')
    } finally {
      setSavingEdit(false)
    }
  }

  // Pinned tasks
  const [pinnedIds, setPinnedIds] = useState(() => {
    try { return JSON.parse(localStorage.getItem('pinned_tasks') || '[]') } catch { return [] }
  })
  const togglePin = (id) => {
    setPinnedIds(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      localStorage.setItem('pinned_tasks', JSON.stringify(next))
      return next
    })
  }

  // Filters
  // Completed digest — collapsed by default, framed as "done this week"
  // so the graveyard doesn't dominate the page; older items behind a
  // secondary "show all" toggle.
  const [showDone, setShowDone] = useState(false)
  const [showAllDone, setShowAllDone] = useState(false)
  const [showCalendar, setShowCalendar] = useState(false)

  // Task notes
  const [notesTaskId, setNotesTaskId] = useState(null)
  const [notesText, setNotesText] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)

  const openNotes = (task) => {
    setNotesTaskId(task.id)
    setNotesText(task.notes || '')
  }
  const saveNotes = async () => {
    if (!notesTaskId) return
    setSavingNotes(true)
    try {
      await api.put(`/team/tasks/${notesTaskId}`, { notes: notesText })
      await fetchData()
      setNotesTaskId(null)
    } catch {} finally { setSavingNotes(false) }
  }
  const [filterCategory, setFilterCategory] = useState('All')
  const [filterPriority, setFilterPriority] = useState('All')
  const [filterAssignedBy, setFilterAssignedBy] = useState('All')

  // Group-by toggle — persisted. Default is due date.
  const [groupBy, setGroupBy] = useState(() => localStorage.getItem('mywork_group_by') || 'due')
  useEffect(() => { localStorage.setItem('mywork_group_by', groupBy) }, [groupBy])
  // Collapse for the filter row. Filters start hidden; shown when the user
  // clicks the Filter button or when any filter is already active.
  const [showFilters, setShowFilters] = useState(false)

  // Keyboard nav
  const [activeIdx, setActiveIdx] = useState(-1)

  // Drag reorder
  const [draggedTaskId, setDraggedTaskId] = useState(null)
  // `customOrder` / localStorage `task_order` removed 2026-08-27 — task order is
  // `tasks.sort_order` on the server now, so it follows the person rather than
  // the browser. The stale key is left in localStorage rather than swept: it is
  // a few bytes and deleting a user's data to tidy up is not worth the risk.

  // Release assignment
  const [showAssignPanel, setShowAssignPanel] = useState(false)
  const [unassigned, setUnassigned] = useState([])
  const [loadingUnassigned, setLoadingUnassigned] = useState(false)
  const [assigningId, setAssigningId] = useState(null)
  const [releaseSearch, setReleaseSearch] = useState('')

  const fetchUnassigned = async () => {
    setLoadingUnassigned(true)
    try {
      const res = await api.get('/releases')
      const all = res.data.data || []
      setUnassigned(all.filter(r => !r.assigned_to_id && !r.archived))
    } catch (err) {
      console.error('Failed to load releases', err)
    } finally {
      setLoadingUnassigned(false)
    }
  }

  const assignRelease = async (releaseId) => {
    setAssigningId(releaseId)
    try {
      await api.put(`/releases/${releaseId}/assign`, { assigned_to: user.id })
      setUnassigned(prev => prev.filter(r => r.id !== releaseId))
      await fetchData()
    } catch (err) {
      alert('Failed to assign release')
    } finally {
      setAssigningId(null)
    }
  }

  const [unassigningId, setUnassigningId] = useState(null)
  const [releaseSort, setReleaseSort] = useState({ by: 'date', dir: 'asc' })
  const [taskSort, setTaskSort] = useState({ by: 'due', dir: 'asc' })
  const unassignRelease = async (releaseId) => {
    setUnassigningId(releaseId)
    try {
      await api.put(`/releases/${releaseId}/assign`, { assigned_to: null })
      await fetchData()
    } catch (err) {
      alert('Failed to unassign release')
    } finally {
      setUnassigningId(null)
    }
  }

  const fetchData = async () => {
    setLoading(true)
    try {
      const res = await api.get('/team/my-work')
      setData(res.data.data)
    } catch (err) {
      console.error('Failed to load my work', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchData() }, [user?.id]) // re-fetch when switching view-as users

  useEffect(() => {
    api.get('/team').then(res => setTeamMembers(res.data.data || [])).catch(() => {})
  }, [])

  // ══ DEAD SINCE THE TWO-PANE REBUILD — reachable from nothing ═══════════════
  //
  // Everything from here to `quickAddTask` below belonged to the add-task FORM,
  // which the rebuild deleted while leaving its machinery behind:
  //   handleDescriptionChange · selectMention · mentionResults · showMention
  //   createTask · taskForm · BLANK_FORM · savingTask · assignedToUser · quickAddTask
  // Each has exactly ONE reference — its own declaration. `createTask` is the
  // dangerous one: it looks like the create path and is not. The live path is
  // `newTask` below.
  //
  // Assignment is BACK (2026-08-27) but NOT through any of this: the @mention now
  // lives on the detail pane's title and goes through `assignTask` →
  // PUT /team/tasks/:id/assign, which is the only path that can hand over a task
  // that already EXISTS. This cluster only ever worked at creation time, which is
  // why it could not be revived as-is.
  //
  // Left in place rather than deleted because it is a working reference for the
  // roster filtering and the mention parsing, and deleting ~120 lines in the same
  // change as a bug fix is how a fix becomes an incident. It is safe to remove on
  // its own.
  const handleDescriptionChange = (e) => {
    const val = e.target.value
    setTaskForm(f => ({ ...f, description: val }))

    // Detect @ mention: find last @ that isn't followed by a space
    const lastAt = val.lastIndexOf('@')
    if (lastAt !== -1) {
      const after = val.slice(lastAt + 1)
      if (!after.includes(' ')) {
        setMentionQuery(after.toLowerCase())
        setShowMention(true)
        return
      }
    }
    setShowMention(false)
    setMentionQuery('')
  }

  const selectMention = (member) => {
    const desc = taskForm.description
    const lastAt = desc.lastIndexOf('@')
    const newDesc = desc.slice(0, lastAt) + ''
    setTaskForm(f => ({ ...f, description: newDesc }))
    setAssignedToUser(member)
    setShowMention(false)
    setMentionQuery('')
    descInputRef.current?.focus()
  }

  const clearAssignment = () => {
    setAssignedToUser(null)
  }

  const mentionResults = mentionQuery !== null
    ? teamMembers.filter(m =>
        m.name.toLowerCase().includes(mentionQuery)
      ).slice(0, 15)
    : []

  // ── Hand a task to somebody (@mention in the detail pane) ─────────────────
  // Restores the flow the two-pane rebuild dropped. It used to live in the
  // add-task form's description field, so it only worked at CREATION; now it
  // works on any task, via PUT /team/tasks/:id/assign.
  //
  // The task LEAVES this list when it moves — /team/my-work is scoped
  // `WHERE user_id = $1` — so it is removed locally and the selection moves on.
  // Leaving it on screen would show a task that the next refresh makes vanish.
  const assignTask = async (taskId, member) => {
    if (!member?.id) return
    try {
      const r = await api.put(`/team/tasks/${taskId}/assign`, { user_id: member.id })
      if (r.data?.pending_email) setPendingEmail(r.data.pending_email)
      if (String(member.id) !== String(user.id)) {
        setData((prev) => (prev
          ? { ...prev, tasks: (prev.tasks || []).filter((t) => t.id !== taskId) }
          : prev))
        setSelectedId((cur) => (cur === taskId ? null : cur))
      }
    } catch (e) {
      console.error('Failed to assign task', e)
      alert('Could not hand that over: ' + (e.response?.data?.error || e.message))
    }
  }

  // ── New Task ──────────────────────────────────────────────────────────────
  // Creates the row IMMEDIATELY and opens it in the detail pane, which is what
  // the two-pane design called for and what Notes does: a new note is a new note,
  // not a form to fill in before you are allowed one.
  //
  // It also replaces a button that did nothing. `setShowAddTask(true)` gated a
  // form that the rebuild deleted, so `showAddTask` had exactly ONE use — its own
  // declaration — and clicking New Task set a flag nothing read.
  const [creating, setCreating] = useState(false)
  const newTask = async () => {
    if (creating) return
    setCreating(true)
    try {
      const r = await api.post('/team/tasks', {
        user_id: user.id,
        // NOT empty. `POST /team/tasks` refuses a falsy description — "Description
        // required" — and it is right to: that guard protects the assignment path,
        // which emails the person a task was assigned to. My jsdom stub happily
        // accepted '' and the real server would have 400'd, which is the trap of a
        // test that agrees with you.
        description: 'New task',
        priority: 'Medium',
        category: 'General',
        status: 'To Do',
      })
      const created = r.data?.data || r.data
      const id = created?.id
      // Patched in rather than refetched: fetchData sets loading, which renders
      // the skeleton and would throw away the pane we are about to point at —
      // the same trap that made the notes box lag every letter.
      if (id) {
        setData((prev) => (prev
          ? { ...prev, tasks: [{ ...created, status: created.status || 'To Do' }, ...(prev.tasks || [])] }
          : prev))
        setTab('tasks')
        setBucket('open')
        setListQuery('')
        setSelectedId(id)
      } else {
        // No id back means we cannot select it; a refetch at least shows it.
        await fetchData()
      }
    } catch (e) {
      console.error('Failed to create task', e)
      alert('Failed to create task: ' + (e.response?.data?.error || e.message))
    } finally { setCreating(false) }
  }

  const createTask = async () => {
    if (!taskForm.description.trim() && !assignedToUser) return
    if (!taskForm.description.trim()) return
    setSavingTask(true)
    try {
      const r = await api.post('/team/tasks', {
        user_id: assignedToUser ? assignedToUser.id : user.id,
        description: taskForm.description.trim(),
        priority: taskForm.priority,
        category: taskForm.category || null,
        due_date: taskForm.due_date || null,
        status: 'To Do',
      })
      if (r.data?.pending_email) setPendingEmail(r.data.pending_email)
      setTaskForm(BLANK_FORM)
      setAssignedToUser(null)
      setShowAddTask(false)
      await fetchData()
    } catch {
      alert('Failed to create task')
    } finally {
      setSavingTask(false)
    }
  }

  // Natural-language quick add: "!urgent / !high / !low" sets priority,
  // "#operations" sets category, "today / tomorrow / friday …" sets the
  // due date (next occurrence). Tokens are stripped from the saved
  // description; anything unparsed stays plain text.
  const parseQuickAdd = (raw) => {
    let text = ` ${raw} `
    const out = { priority: 'Medium', category: null, due_date: null }
    const pm = text.match(/\s!(urgent|high|medium|low|u|h|m|l)\b/i)
    if (pm) {
      const map = { u: 'Urgent', urgent: 'Urgent', h: 'High', high: 'High', m: 'Medium', medium: 'Medium', l: 'Low', low: 'Low' }
      out.priority = map[pm[1].toLowerCase()]
      text = text.replace(pm[0], ' ')
    }
    const cm = text.match(/\s#([\w-]{2,})/)
    if (cm) {
      out.category = cm[1][0].toUpperCase() + cm[1].slice(1)
      text = text.replace(cm[0], ' ')
    }
    const dm = text.match(/\s(today|tod|tomorrow|tmrw?|tmr|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/i)
    if (dm) {
      const w = dm[1].toLowerCase()
      const d = new Date()
      if (w === 'today' || w === 'tod') { /* today */ }
      else if (w.startsWith('tom') || w.startsWith('tmr')) d.setDate(d.getDate() + 1)
      else {
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
        const idx = days.findIndex(x => x.startsWith(w.slice(0, 3)))
        if (idx >= 0) {
          let delta = (idx - d.getDay() + 7) % 7
          if (delta === 0) delta = 7 // "friday" said on a Friday means next week
          d.setDate(d.getDate() + delta)
        }
      }
      out.due_date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      text = text.replace(dm[0], ' ')
    }
    out.description = text.replace(/\s+/g, ' ').trim()
    return out
  }
  const quickAddParsed = quickAdd.trim() ? parseQuickAdd(quickAdd) : null

  const quickAddTask = async () => {
    if (!quickAdd.trim()) return
    const parsed = parseQuickAdd(quickAdd)
    if (!parsed.description) return
    try {
      await api.post('/team/tasks', {
        user_id: user.id,
        description: parsed.description,
        priority: parsed.priority,
        status: 'To Do',
        ...(parsed.category ? { category: parsed.category } : {}),
        ...(parsed.due_date ? { due_date: parsed.due_date } : {}),
      })
      setQuickAdd('')
      await fetchData()
    } catch {}
  }

  const updateProgress = async (taskId, progress) => {
    try {
      await api.put(`/team/tasks/${taskId}`, { progress })
      // allTasks is derived from data.tasks, so update data — there's no setAllTasks setter.
      setData(prev => prev ? { ...prev, tasks: (prev.tasks || []).map(t => t.id === taskId ? { ...t, progress } : t) } : prev)
    } catch (err) {
      console.error('Failed to update task progress:', err)
    }
  }

  const toggleStatus = async (task) => {
    setTogglingId(task.id)
    try {
      const next = STATUS_CYCLE[task.status] || 'To Do'
      await api.put(`/team/tasks/${task.id}`, { status: next })
      await fetchData()
    } catch (err) {
      alert('Failed to update task')
    } finally {
      setTogglingId(null)
    }
  }

  const deleteTask = async (taskId) => {
    setDeletingId(taskId)
    try {
      await api.delete(`/team/tasks/${taskId}`)
      await fetchData()
    } catch (err) {
      alert('Failed to delete task')
    } finally {
      setDeletingId(null)
    }
  }

  // ── To Do Today actions ───────────────────────────────────────────────
  const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const setTaskDue = async (task, date) => {
    try {
      await api.put(`/team/tasks/${task.id}`, { due_date: date })
      setData(prev => prev ? { ...prev, tasks: (prev.tasks || []).map(t => t.id === task.id ? { ...t, due_date: date } : t) } : prev)
    } catch { alert('Failed to update task') }
  }
  const snoozeTask = (task) => {
    const d = new Date(); d.setDate(d.getDate() + 1)
    return setTaskDue(task, ymdLocal(d))
  }
  const startTask = async (task) => {
    try {
      await api.put(`/team/tasks/${task.id}`, { status: 'In Progress' })
      setData(prev => prev ? { ...prev, tasks: (prev.tasks || []).map(t => t.id === task.id ? { ...t, status: 'In Progress' } : t) } : prev)
    } catch { alert('Failed to update task') }
  }
  const [reschedulingAll, setReschedulingAll] = useState(false)
  const rescheduleAllOverdue = async (overdueTasks) => {
    if (reschedulingAll || !overdueTasks.length) return
    setReschedulingAll(true)
    const todayStr = ymdLocal(new Date())
    for (const t of overdueTasks) {
      try { await api.put(`/team/tasks/${t.id}`, { due_date: todayStr }) } catch {}
    }
    await fetchData()
    setReschedulingAll(false)
  }

  // Cross-app "also today" strip — review items assigned to me + unread
  // mentions, fetched once. The statement-cutoff countdown is computed
  // locally (statements go out on the 20th).
  const [todayStrip, setTodayStrip] = useState({ reviews: 0, mentions: 0 })
  useEffect(() => {
    api.get('/artist-campaigns/review-feed').then(r => {
      const d = r.data?.data || {}
      const assignments = d.assignments || {}
      const ids = new Set([...(d.flags || []).map(f => f.id), ...(d.comments || []).map(c => c.id)])
      let count = 0
      ids.forEach(id => { if ((assignments[id] || []).some(a => a.user_id === user?.id)) count++ })
      setTodayStrip(s => ({ ...s, reviews: count }))
    }).catch(() => {})
    api.get('/notifications')
      .then(r => setTodayStrip(s => ({ ...s, mentions: (r.data?.data?.mentions || []).length })))
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])
  const cutoffDays = (() => {
    const now = new Date()
    const t = new Date(now.getFullYear(), now.getMonth(), 20)
    if (now.getDate() > 20) t.setMonth(t.getMonth() + 1)
    return Math.ceil((t - now) / 86400000)
  })()

  // ── Derivations and the selection effect, ABOVE the loading return ────────
  //
  // These sat BELOW `if (loading) return …`, which put a useEffect after an early
  // return. React counts hooks per render: the loading render stopped before that
  // effect and the render after the fetch reached it, so the hook count changed
  // and React threw "Rendered more hooks than during the previous render" — a
  // WHITE PAGE the moment data arrived.
  //
  // `npm run smoke` could never catch it. It renders with renderToString, where
  // effects never fire, so the page only ever renders its loading branch — the
  // one branch in which the bug does not exist. Reproduced instead by mounting
  // in jsdom, where effects run (client/scripts/mywork-dom-check.mjs).
  //
  // Every derivation here is null-safe (`data?.x || []`), so running them before
  // the data arrives costs a few empty arrays and keeps the hook order fixed.
  const allTasks = data?.tasks || []
  const openTasks = allTasks.filter(t => t.status !== 'Done')
  const completedTasks = allTasks.filter(t => t.status === 'Done')
  // Aliases the two-pane block reads. `tasks` is the WHOLE set on purpose: the
  // All bucket must show every task the endpoint returned, and a list that
  // quietly filters one out is the failure this page cannot have.
  const tasks = allTasks
  const doneTasks = completedTasks

  // What the list column shows: bucket, then the search box, then pinned first.
  // Ordering only — nothing is dropped that the bucket admits, so the count on
  // the segmented control and the rows beneath it always describe one set.
  const paneTasks = (() => {
    const base = bucket === 'open' ? openTasks : bucket === 'done' ? doneTasks : tasks
    const q = listQuery.trim().toLowerCase()
    const matched = q
      ? base.filter(t => [t.description, t.notes, t.category]
          .some(v => String(v || '').toLowerCase().includes(q)))
      : base
    return [...matched].sort((a, b) => {
      const ap = pinnedIds.includes(a.id) ? 0 : 1
      const bp = pinnedIds.includes(b.id) ? 0 : 1
      if (ap !== bp) return ap - bp
      // `sort_order` from the server — the order this person arranged, which now
      // follows them between browsers instead of living in localStorage. NULL
      // means never dragged and sorts last, so an untouched list keeps its
      // due-date order and only placed rows jump the queue.
      const ao = a.sort_order ?? null, bo = b.sort_order ?? null
      if (ao !== bo) {
        if (ao === null) return 1
        if (bo === null) return -1
        return ao - bo
      }
      return (a.due_date || '9999').localeCompare(b.due_date || '9999')
    })
  })()
  const selectedTask = tasks.find(t => t.id === selectedId) || null

  // Open the first task when nothing is selected, and follow the bucket when
  // the selected one leaves it — an empty detail pane beside a full list reads
  // as broken.
  useEffect(() => {
    if (!paneTasks.length) { if (selectedId !== null) setSelectedId(null); return }
    if (!paneTasks.some(t => t.id === selectedId)) setSelectedId(paneTasks[0].id)
  }, [bucket, paneTasks.length, selectedId])  // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton.PageHeader />
        <div className="card p-6">
          <div className="flex gap-6 mb-4">
            <Skeleton.Line w="w-20" h="h-4" />
            <Skeleton.Line w="w-24" h="h-4" />
          </div>
          <Skeleton.TaskList count={4} />
        </div>
      </div>
    )
  }

  const releases = data?.releases || []
  const upcoming = data?.upcoming || []
  const activity = data?.activity || []

  const today = new Date(); today.setHours(0,0,0,0)
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1)
  const overdue = openTasks.filter(t => isPastLocal(t.due_date))
  const dueToday = openTasks.filter(t => daysUntilLocal(t.due_date) === 0)
  const inProgress = openTasks.filter(t => t.status === 'In Progress')


  // "To Do Today" combines the three buckets that need attention before EOD:
  // anything overdue (most overdue first), anything due today (highest
  // priority first), and anything actively in progress that isn't already
  // captured by the first two. Dedup by id so a task that's both overdue AND
  // in progress only renders once, anchored to its more urgent bucket.
  const PRIORITY_RANK = { Urgent: 0, High: 1, Medium: 2, Low: 3 }
  const todoToday = (() => {
    const seen = new Set()
    const result = []
    const byPriority = (a, b) => (PRIORITY_RANK[a.priority] ?? 99) - (PRIORITY_RANK[b.priority] ?? 99)
    const byDateAsc = (a, b) => new Date(a.due_date) - new Date(b.due_date)
    const overdueSorted    = [...overdue].sort(byDateAsc)
    const dueTodaySorted   = [...dueToday].sort(byPriority)
    const inProgressSorted = [...inProgress].sort(byPriority)
    for (const t of [...overdueSorted, ...dueTodaySorted, ...inProgressSorted]) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      result.push(t)
    }
    return result
  })()

  const allAssigners = [...new Set(openTasks.map(t => t.assigned_by_name).filter(Boolean))].sort()

  // Filter tasks
  const visibleTasks = openTasks.filter(t => {
    if (filterCategory !== 'All' && (t.category || '') !== filterCategory) return false
    if (filterPriority !== 'All' && t.priority !== filterPriority) return false
    if (filterAssignedBy !== 'All' && (t.assigned_by_name || 'Self') !== filterAssignedBy) return false
    return true
  })

  const RELEASE_SORT_OPTIONS = [
    { key: 'date',       label: 'Date' },
    { key: 'artist',     label: 'Artist' },
    { key: 'name',       label: 'Title' },
    { key: 'completion', label: 'Completion' },
  ]

  const TASK_SORT_OPTIONS = [
    { key: 'due',      label: 'Due Date' },
    { key: 'priority', label: 'Priority' },
    { key: 'status',   label: 'Status' },
    { key: 'name',     label: 'Title' },
  ]

  const PRIORITY_ORDER = { 'Urgent': 0, 'High': 1, 'Medium': 2, 'Low': 3 }
  const STATUS_ORDER   = { 'In Progress': 0, 'To Do': 1, 'Done': 2 }

  const cycleSort = (key) => {
    setReleaseSort(prev =>
      prev.by === key
        ? { by: key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { by: key, dir: 'asc' }
    )
  }

  const cycleTaskSort = (key) => {
    setTaskSort(prev =>
      prev.by === key
        ? { by: key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { by: key, dir: 'asc' }
    )
  }

  const sortedReleases = [...releases].sort((a, b) => {
    let aVal, bVal
    if (releaseSort.by === 'date')       { aVal = new Date(a.release_date); bVal = new Date(b.release_date) }
    if (releaseSort.by === 'artist')     { aVal = a.artist_name?.toLowerCase(); bVal = b.artist_name?.toLowerCase() }
    if (releaseSort.by === 'name')       { aVal = a.project_name?.toLowerCase(); bVal = b.project_name?.toLowerCase() }
    if (releaseSort.by === 'completion') { aVal = a.completion; bVal = b.completion }
    if (aVal < bVal) return releaseSort.dir === 'asc' ? -1 : 1
    if (aVal > bVal) return releaseSort.dir === 'asc' ? 1 : -1
    return 0
  })

  const sortedTasks = [...visibleTasks].sort((a, b) => {
    // Pinned always first
    const aPinned = pinnedIds.includes(a.id) ? 0 : 1
    const bPinned = pinnedIds.includes(b.id) ? 0 : 1
    if (aPinned !== bPinned) return aPinned - bPinned

    // The SAME `sort_order` the pane sorts on. This read a `customOrder` id-list
    // from localStorage, which after the reorder moved server-side had no writer
    // left — so it silently froze at whatever that browser last held, and this
    // list and the pane could order the same tasks differently.
    const aOrder = a.sort_order ?? null
    const bOrder = b.sort_order ?? null
    if (aOrder !== bOrder) {
      if (aOrder === null) return 1
      if (bOrder === null) return -1
      return aOrder - bOrder
    }

    let aVal, bVal
    if (taskSort.by === 'due')      { aVal = a.due_date ? new Date(a.due_date) : new Date('9999'); bVal = b.due_date ? new Date(b.due_date) : new Date('9999') }
    if (taskSort.by === 'priority') { aVal = PRIORITY_ORDER[a.priority] ?? 99; bVal = PRIORITY_ORDER[b.priority] ?? 99 }
    if (taskSort.by === 'status')   { aVal = STATUS_ORDER[a.status] ?? 99; bVal = STATUS_ORDER[b.status] ?? 99 }
    if (taskSort.by === 'name')     { aVal = a.description?.toLowerCase(); bVal = b.description?.toLowerCase() }
    if (aVal < bVal) return taskSort.dir === 'asc' ? -1 : 1
    if (aVal > bVal) return taskSort.dir === 'asc' ? 1 : -1
    return 0
  })

  // Build bucketed task groups. Sort within each bucket is inherited from
  // sortedTasks (pinned → custom drag order → taskSort), so users who've
  // manually reordered still see their order inside a bucket.
  const taskGroups = (() => {
    const cfg = groupBy === 'priority' ? PRIORITY_BUCKETS
              : groupBy === 'category' ? CATEGORY_BUCKETS
              : DUE_BUCKETS
    const bucket = groupBy === 'priority' ? bucketByPriority
                 : groupBy === 'category' ? bucketByCategory
                 : bucketByDue
    const byKey = {}
    for (const t of sortedTasks) {
      const k = bucket(t)
      if (!byKey[k]) byKey[k] = []
      byKey[k].push(t)
    }
    return Object.entries(cfg)
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([k, meta]) => ({ key: k, ...meta, tasks: byKey[k] || [] }))
      .filter(g => g.tasks.length > 0)
  })()

  // Reorder, against the list that is ON SCREEN.
  //
  // This used to index into `sortedTasks` — the OLD grouped list, which the
  // two-pane rebuild stopped rendering. So `indexOf` was resolved against rows
  // the user could not see, and returned -1 for anything the pane showed but
  // that list did not (every Done task, for one), which returned early and made
  // dragging do nothing at all. That is why reordering "didn't exist".
  const handleTaskDrop = async (dragId, dropId) => {
    const ids = paneTasks.map(t => t.id)
    const fromIdx = ids.indexOf(dragId)
    const toIdx = ids.indexOf(dropId)
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return
    const newOrder = [...ids]
    newOrder.splice(fromIdx, 1)
    newOrder.splice(toIdx, 0, dragId)
    // Optimistic: the row moves under the cursor, then the write confirms it.
    // Waiting on the round-trip makes a drag feel broken even when it works.
    setData(prev => (prev ? {
      ...prev,
      tasks: (prev.tasks || []).map(t => {
        const i = newOrder.indexOf(t.id)
        return i === -1 ? t : { ...t, sort_order: i }
      }),
    } : prev))
    try {
      await api.put('/team/tasks/reorder', { ids: newOrder })
    } catch (err) {
      console.error('Failed to save task order', err)
      // Put the server's answer back rather than leaving a lie on screen.
      fetchData()
    }
  }

  // Keyboard shortcuts — disabled for now, use quick-add bar directly

  // To Do Today leads the tab strip because it's the highest-priority view —
  // overdue + due-today + in-progress, deduped. Always rendered (even when
  // the count is zero) so the user has a predictable place to land; the tab
  // content shows an "all clear" empty state when there's nothing due.
  const TABS = [
    { id: 'today',    label: 'To Do Today', count: todoToday.length },
    { id: 'tasks',    label: 'My Tasks',    count: openTasks.length },
    { id: 'releases', label: 'My Releases', count: releases.length },
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-black text-gray-900 tracking-tight">{greeting(user?.name)}</h1>
          {(openTasks.length > 0 || releases.length > 0) ? (
            <div className="flex items-center gap-2.5 mt-3 flex-wrap">
              {overdue.length > 0 && (
                <span className="inline-flex items-center gap-1.5 text-xs font-bold bg-red-500 text-white px-3 py-1 rounded-full">
                  {overdue.length} overdue
                </span>
              )}
              {dueToday.length > 0 && (
                <span className="inline-flex items-center gap-1.5 text-xs font-bold bg-amber-500 text-white px-3 py-1 rounded-full">
                  {dueToday.length} due today
                </span>
              )}
              {inProgress.length > 0 && (
                <span className="inline-flex items-center gap-1.5 text-xs font-bold bg-blue-500 text-white px-3 py-1 rounded-full">
                  {inProgress.length} in progress
                </span>
              )}
              {openTasks.length > 0 && !overdue.length && !dueToday.length && !inProgress.length && (
                <span className="text-sm text-gray-400">{openTasks.length} open task{openTasks.length !== 1 ? 's' : ''}</span>
              )}
              {releases.length > 0 && (
                <span className="text-sm text-gray-400">{releases.length} release{releases.length !== 1 ? 's' : ''}</span>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-400 mt-1">Your workspace is clear. Time to create.</p>
          )}
        </div>
      </div>

      {/* Two-column command-center layout: tasks/releases on the left,
          the cross-app "Waiting on you" rail on the right. Stacks on
          small screens. */}
      {/* Below lg this is a flex column with the rail ordered FIRST (it
          renders as a compact horizontal strip there — see MyWorkRail),
          so "waiting on you" items aren't buried under the task list. */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)] lg:gap-5 lg:items-start">
      <div className="space-y-6 min-w-0 order-2 lg:order-none">

      {/* Upcoming deadline alert */}
      {upcoming.length > 0 && (
        <div className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 flex items-start gap-3">
          <Clock size={15} className="text-orange-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-orange-800">
              {upcoming.length} release{upcoming.length !== 1 ? 's' : ''} dropping in the next 14 days
            </p>
            <div className="flex flex-wrap gap-2 mt-2">
              {upcoming.map(r => {
                const d = daysUntilLocal(r.release_date) ?? -1
                return (
                  <Link
                    key={r.id}
                    to="/releases"
                    state={{ highlightId: r.id }}
                    className="inline-flex items-center gap-1.5 text-xs font-medium bg-card border border-orange-200 rounded-lg px-2.5 py-1.5 hover:border-orange-400 transition-colors"
                  >
                    <span className="text-gray-800">{r.project_name}</span>
                    <span className="text-gray-400">·</span>
                    <span className={d <= 3 ? 'text-red-500 font-bold' : 'text-orange-500'}>{d}d</span>
                    <span className="text-gray-400">·</span>
                    <span className="text-orange-600 font-bold">{r.completion}%</span>
                  </Link>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Main Card */}
      <div className="card overflow-hidden">
        <div className="flex items-center border-b border-divider px-3 sm:px-6 flex-wrap gap-y-2">
          <div className="flex flex-1">
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
          {/* Tab-level actions */}
          {tab === 'releases' && (
            <div className="flex items-center gap-2 ml-auto pb-px">
              {/* Sort controls */}
              <div className="flex items-center gap-1 border border-rule rounded-lg px-1.5 py-1">
                <ArrowUpDown size={11} className="text-gray-400 flex-shrink-0" />
                {RELEASE_SORT_OPTIONS.map(opt => (
                  <button
                    key={opt.key}
                    onClick={() => cycleSort(opt.key)}
                    className={`text-[10px] font-semibold px-1.5 py-0.5 rounded transition-all ${
                      releaseSort.by === opt.key
                        ? 'bg-gray-900 text-white'
                        : 'text-gray-400 hover:text-gray-600'
                    }`}
                  >
                    {opt.label}{releaseSort.by === opt.key ? (releaseSort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </button>
                ))}
              </div>
              <button
                onClick={() => {
                  const next = !showAssignPanel
                  setShowAssignPanel(next)
                  if (next) { setReleaseSearch(''); fetchUnassigned() }
                }}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-boom-600 hover:text-boom-700 transition-colors px-2.5 py-1.5 rounded-lg hover:bg-boom-50"
              >
                <UserPlus size={13} /> Assign Release
              </button>
            </div>
          )}
          {tab === 'tasks' && (
            <div className="flex items-center gap-2 ml-auto pb-px flex-wrap justify-end">
              {/* Group-by segmented control. Replaces the sort bar — grouping
                  is the primary axis now, with tasks sorted by due date asc
                  within each bucket. */}
              <div className="flex items-center gap-1 border border-rule rounded-lg p-0.5 bg-gray-50">
                <span className="hidden sm:inline text-[10px] font-bold text-gray-400 uppercase tracking-wider px-2">Group</span>
                {[
                  { key: 'due',      label: 'Due Date' },
                  { key: 'priority', label: 'Priority' },
                  { key: 'category', label: 'Category' },
                ].map(opt => (
                  <button
                    key={opt.key}
                    onClick={() => setGroupBy(opt.key)}
                    className={`text-[10px] font-semibold px-2 py-1 rounded transition-all ${
                      groupBy === opt.key
                        ? 'bg-gray-900 text-white'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {/* Filter button — shows a dot when any filter is active */}
              {openTasks.length > 2 && (() => {
                const anyActive = filterCategory !== 'All' || filterPriority !== 'All' || filterAssignedBy !== 'All'
                return (
                  <button
                    onClick={() => setShowFilters(v => !v)}
                    className={`inline-flex items-center gap-1.5 text-xs font-semibold transition-colors px-2.5 py-1.5 rounded-lg ${
                      showFilters || anyActive ? 'text-boom-600 bg-boom-50' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'
                    }`}
                    title="Filter tasks"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>
                    Filter
                    {anyActive && <span className="w-1.5 h-1.5 rounded-full bg-boom-500" />}
                  </button>
                )
              })()}
              <button
                onClick={() => setShowCalendar(v => !v)}
                className={`inline-flex items-center gap-1.5 text-xs font-semibold transition-colors px-2.5 py-1.5 rounded-lg ${
                  showCalendar ? 'text-boom-600 bg-boom-50' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'
                }`}
                title="Toggle calendar view"
              >
                <CalendarDays size={13} />
              </button>
              <button
                onClick={newTask}
                disabled={creating}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-boom-600 hover:bg-boom-700 transition-colors px-3 py-1.5 rounded-lg"
              >
                <Plus size={13} /> {creating ? 'Adding…' : 'New Task'}
              </button>
            </div>
          )}
        </div>

        <div className="p-3 sm:p-6">

          {/* TO DO TODAY — overdue + due-today + in-progress, deduped. The
              priority left-stripe + circle status + state badge layout mirrors
              the My Tasks rows so the user reads them the same way. Clicking
              the description (or pencil) jumps to My Tasks and opens the full
              inline edit form, since the today view stays read-only-ish
              (status toggle is the only direct edit). */}
          {tab === 'today' && (() => {
            // ── Triage partition ──────────────────────────────────────
            // Overdue leads (most-late first), then due today, then
            // in-progress-only. Each task renders in exactly one section.
            const overdueIds = new Set(overdue.map(t => t.id))
            const dueTodayIds = new Set(dueToday.map(t => t.id))
            const overdueSorted = [...overdue].sort((a, b) => new Date(a.due_date) - new Date(b.due_date))
            const dueTodayOnly = dueToday.filter(t => !overdueIds.has(t.id))
            const inProgressOnly = inProgress.filter(t => !overdueIds.has(t.id) && !dueTodayIds.has(t.id))
            const daysLate = (t) => Math.max(1, -(daysUntilLocal(t.due_date) ?? -1))
            // "Plan your day" suggestions — top-priority open tasks with
            // no due date, offered when nothing is actually due today.
            const prioOrder = { Urgent: 0, High: 1, Medium: 2, Low: 3 }
            const suggestions = allTasks
              .filter(t => t.status !== 'Done' && t.status !== 'In Progress' && !t.due_date)
              .sort((a, b) => (prioOrder[a.priority] ?? 9) - (prioOrder[b.priority] ?? 9))
              .slice(0, 5)

            const stripHasContent = todayStrip.reviews > 0 || todayStrip.mentions > 0 || cutoffDays <= 7

            const renderRow = (task, badge) => {
              const isInProgress = task.status === 'In Progress'
              const isToggling = togglingId === task.id
              const linkedRelease = releases.find(r => r.id === task.release_id)
              return (
                <div
                  key={`tdt-${task.id}`}
                  className="flex items-center gap-3 py-3 hover:bg-gray-50/60 dark:hover:bg-gray-800/40 transition-colors group"
                >
                  <span className={`w-1 h-7 rounded-full flex-shrink-0 ${PRIORITY_STRIPE[task.priority] || 'bg-gray-200'}`} />
                  <button
                    onClick={() => toggleStatus(task)}
                    disabled={isToggling}
                    className="flex-shrink-0 w-5 h-5 flex items-center justify-center text-gray-300 hover:text-boom-500 transition-colors"
                    title="Mark as Done"
                  >
                    {isToggling ? (
                      <Loader size={14} className="animate-spin text-gray-300" />
                    ) : isInProgress ? (
                      <div className="w-4 h-4 rounded-full border-2 border-blue-400 flex items-center justify-center">
                        <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                      </div>
                    ) : (
                      <Circle size={16} className="text-gray-300 group-hover:text-gray-400" />
                    )}
                  </button>
                  <button
                    onClick={() => { setTab('tasks'); startEdit(task) }}
                    className="flex-1 text-left min-w-0"
                  >
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">
                      {task.description}
                    </p>
                    {linkedRelease && (
                      <p className="text-[11px] text-gray-400 truncate mt-0.5">
                        {linkedRelease.artist_name} — {linkedRelease.project_name}
                      </p>
                    )}
                  </button>
                  {badge}
                  {/* Day-management actions — hover-reveal: Start (To Do
                      only) + snooze to tomorrow. */}
                  {!isInProgress && (
                    <button
                      onClick={() => startTask(task)}
                      className="flex-shrink-0 opacity-0 group-hover:opacity-100 text-[10px] font-bold text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded transition-opacity"
                      title="Move to In Progress"
                    >
                      Start
                    </button>
                  )}
                  <button
                    onClick={() => snoozeTask(task)}
                    className="flex-shrink-0 opacity-0 group-hover:opacity-100 text-[10px] font-bold text-gray-500 hover:text-gray-700 bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded transition-opacity"
                    title="Snooze — push the due date to tomorrow"
                  >
                    Tmrw
                  </button>
                  <button
                    onClick={() => { setTab('tasks'); startEdit(task) }}
                    className="flex-shrink-0 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-gray-600 transition-opacity"
                    title="Edit"
                  >
                    <Pencil size={13} />
                  </button>
                </div>
              )
            }

            const sectionHeader = (label, count, cls) => (
              <div className={`flex items-center gap-2 pt-3 pb-1.5 text-[10px] font-bold uppercase tracking-wider ${cls}`}>
                {label}
                <span className="bg-current/10 px-1.5 py-0.5 rounded-full">{count}</span>
              </div>
            )

            const suggestionsBlock = suggestions.length > 0 && dueTodayOnly.length === 0 && (
              <div className="mt-2">
                <div className="flex items-center gap-2 pt-3 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                  Plan your day — suggested
                </div>
                <div className="divide-y divide-divider">
                  {suggestions.map(task => (
                    <div key={`sug-${task.id}`} className="flex items-center gap-3 py-2.5 group">
                      <span className={`w-1 h-6 rounded-full flex-shrink-0 ${PRIORITY_STRIPE[task.priority] || 'bg-gray-200'}`} />
                      <p className="flex-1 text-sm text-gray-700 truncate">{task.description}</p>
                      <span className="text-[10px] font-bold text-gray-400 uppercase">{task.priority}</span>
                      <button
                        onClick={() => setTaskDue(task, ymdLocal(new Date()))}
                        className="flex-shrink-0 text-[10px] font-bold text-boom-600 hover:text-boom-700 bg-boom-50 hover:bg-boom-100 px-2 py-1 rounded"
                        title="Set this task's due date to today"
                      >
                        + Today
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )

            const stripBlock = stripHasContent && (
              <div className="flex items-center gap-3 flex-wrap px-3 py-2 mb-3 rounded-lg bg-gray-50/80 border border-divider text-[11px] font-semibold">
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Also today</span>
                {todayStrip.reviews > 0 && (
                  <Link to="/artist-campaigns" className="text-amber-700 hover:text-amber-800">
                    ⚑ {todayStrip.reviews} review{todayStrip.reviews === 1 ? '' : 's'} assigned to you
                  </Link>
                )}
                {todayStrip.mentions > 0 && (
                  <span className="text-boom-700">@ {todayStrip.mentions} unread mention{todayStrip.mentions === 1 ? '' : 's'}</span>
                )}
                {cutoffDays <= 7 && (
                  <Link to="/recoupments/planning" className="text-sky-700 hover:text-sky-800">
                    ⏳ statement cutoff {cutoffDays === 0 ? 'today' : `in ${cutoffDays} day${cutoffDays === 1 ? '' : 's'}`}
                  </Link>
                )}
              </div>
            )

            if (todoToday.length === 0) {
              return (
                <div>
                  {stripBlock}
                  <div className="text-center py-10">
                    <div className="w-12 h-12 mx-auto rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center mb-3">
                      <Check size={20} strokeWidth={2.5} />
                    </div>
                    <p className="text-sm font-semibold text-gray-700">All clear for today.</p>
                    <p className="text-xs text-gray-400 mt-1">
                      Nothing overdue, due today, or in progress. {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.
                    </p>
                  </div>
                  {suggestionsBlock}
                </div>
              )
            }

            return (
              <div>
                <div className="flex items-center justify-between gap-3 pb-3 mb-3 border-b border-divider flex-wrap">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center flex-shrink-0">
                      <Sun size={16} strokeWidth={2.4} />
                    </div>
                    <div className="min-w-0">
                      <h2 className="text-sm font-bold text-gray-900">To Do Today</h2>
                      <p className="text-[11px] text-gray-400">
                        {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                      </p>
                    </div>
                  </div>
                </div>

                {stripBlock}

                {/* Rollover banner — one click reschedules everything late. */}
                {overdueSorted.length > 1 && (
                  <div className="flex items-center gap-3 px-3 py-2 mb-2 rounded-lg bg-red-50 border border-red-100">
                    <span className="text-xs font-semibold text-red-700">
                      {overdueSorted.length} tasks rolled over from previous days.
                    </span>
                    <button
                      onClick={() => rescheduleAllOverdue(overdueSorted)}
                      disabled={reschedulingAll}
                      className="ml-auto text-[11px] font-bold text-red-700 hover:text-red-800 bg-red-100 hover:bg-red-200 px-2.5 py-1 rounded disabled:opacity-50"
                    >
                      {reschedulingAll ? 'Rescheduling…' : 'Reschedule all → today'}
                    </button>
                  </div>
                )}

                {overdueSorted.length > 0 && (
                  <div>
                    {sectionHeader('Overdue', overdueSorted.length, 'text-red-600')}
                    <div className="divide-y divide-divider">
                      {overdueSorted.map(task => renderRow(task, (
                        <span className="text-[10px] font-bold uppercase tracking-wide text-red-600 bg-red-50 px-2 py-1 rounded flex-shrink-0">
                          {daysLate(task)}d late
                        </span>
                      )))}
                    </div>
                  </div>
                )}
                {dueTodayOnly.length > 0 && (
                  <div>
                    {sectionHeader('Due today', dueTodayOnly.length, 'text-amber-700')}
                    <div className="divide-y divide-divider">
                      {dueTodayOnly.map(task => renderRow(task, (
                        <span className="text-[10px] font-bold uppercase tracking-wide text-amber-700 bg-amber-50 px-2 py-1 rounded flex-shrink-0">
                          Today
                        </span>
                      )))}
                    </div>
                  </div>
                )}
                {inProgressOnly.length > 0 && (
                  <div>
                    {sectionHeader('In progress', inProgressOnly.length, 'text-blue-700')}
                    <div className="divide-y divide-divider">
                      {inProgressOnly.map(task => renderRow(task, (
                        <span className="text-[10px] font-bold uppercase tracking-wide text-blue-700 bg-blue-50 px-2 py-1 rounded flex-shrink-0">
                          In Progress
                        </span>
                      )))}
                    </div>
                  </div>
                )}

                {suggestionsBlock}
              </div>
            )
          })()}

          {/* MY RELEASES */}
          {tab === 'releases' && (
            <div className="space-y-4">

              {/* Assign panel */}
              {showAssignPanel && (
                <div className="border border-rule rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 bg-surface-50 border-b border-divider">
                    <p className="text-xs font-bold text-gray-600 uppercase tracking-wider">Unassigned Releases</p>
                    <button onClick={() => setShowAssignPanel(false)} className="text-gray-400 hover:text-gray-600">
                      <X size={14} />
                    </button>
                  </div>

                  <div className="p-3 border-b border-divider">
                    <div className="relative">
                      <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                      <input
                        type="text"
                        placeholder="Search releases…"
                        value={releaseSearch}
                        onChange={e => setReleaseSearch(e.target.value)}
                        className="w-full pl-7 pr-3 py-1.5 text-sm border border-rule rounded-lg focus:outline-none focus:ring-1 focus:ring-boom-500 placeholder:text-gray-300"
                      />
                    </div>
                  </div>

                  <div className="max-h-64 overflow-y-auto">
                    {loadingUnassigned ? (
                      <div className="flex items-center justify-center py-8">
                        <div className="w-5 h-5 border-2 border-boom-500 border-t-transparent rounded-full animate-spin" />
                      </div>
                    ) : (() => {
                      const filtered = unassigned.filter(r =>
                        !releaseSearch ||
                        r.project_name?.toLowerCase().includes(releaseSearch.toLowerCase()) ||
                        r.artist_name?.toLowerCase().includes(releaseSearch.toLowerCase())
                      )
                      if (!filtered.length) return (
                        <p className="text-xs text-gray-400 text-center py-6">
                          {unassigned.length === 0 ? 'All releases are assigned.' : 'No matches.'}
                        </p>
                      )
                      return filtered.map(r => {
                        const daysUntil = r.release_date
                          ? Math.ceil((new Date(r.release_date) - new Date()) / 86400000)
                          : null
                        const isAssigning = assigningId === r.id
                        return (
                          <div key={r.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-50 border-b border-gray-50 last:border-0">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-800 truncate">{r.project_name}</p>
                              <p className="text-xs text-gray-400">{r.artist_name}{r.release_date ? ` · ${formatDate(r.release_date)}` : ''}</p>
                            </div>
                            {daysUntil !== null && (
                              <span className={`text-xs flex-shrink-0 ${daysUntil <= 7 ? 'text-red-500 font-semibold' : 'text-gray-400'}`}>
                                {daysUntil < 0 ? `${Math.abs(daysUntil)}d ago` : `${daysUntil}d`}
                              </span>
                            )}
                            <button
                              onClick={() => assignRelease(r.id)}
                              disabled={isAssigning}
                              className="flex-shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-boom-600 hover:text-boom-700 px-2.5 py-1 rounded-lg border border-boom-200 hover:bg-boom-50 transition-colors disabled:opacity-40"
                            >
                              {isAssigning
                                ? <Loader size={11} className="animate-spin" />
                                : <><Plus size={11} /> Assign</>
                              }
                            </button>
                          </div>
                        )
                      })
                    })()}
                  </div>
                </div>
              )}

              {!sortedReleases.length ? (
                <div className="text-center py-16">
                  <p className="text-base font-semibold text-gray-800">No releases yet</p>
                  <p className="text-sm text-gray-400 mt-1 mb-4">Releases assigned to you will show up here with checklist progress.</p>
                  <Link
                    to="/releases"
                    className="inline-flex items-center gap-1.5 text-sm font-semibold text-boom-600 hover:text-boom-700 px-4 py-2 rounded-xl border border-boom-200 hover:bg-boom-50 transition-colors"
                  >
                    Assign yourself a release
                  </Link>
                </div>
              ) : (
                <div className="space-y-2">
                  {sortedReleases.map(r => {
                    const daysUntil = daysUntilLocal(r.release_date) ?? -1
                    const isPast = daysUntil < 0
                    const isUrgent = !isPast && daysUntil <= 7
                    const isUnassigning = unassigningId === r.id
                    return (
                      <div key={r.id} className="flex items-center gap-2 group">
                        <Link
                          to="/releases"
                          state={{ highlightId: r.id }}
                          className="flex-1 flex items-center gap-4 p-3 rounded-lg border border-divider hover:border-boom-300 hover:bg-boom-50/30 transition-all min-w-0"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-gray-900 truncate">{r.project_name}</p>
                            <p className="text-xs text-gray-400">{r.artist_name} · {formatDate(r.release_date)}</p>
                          </div>
                          <div className="flex items-center gap-3 flex-shrink-0">
                            <div className="flex items-center gap-2" title={`${Math.round((r.completion || 0) / 100 * 14)}/14 checklist items`}>
                              <div className="w-24 h-2 bg-gray-100 rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full transition-all ${r.completion === 100 ? 'bg-emerald-500' : r.completion >= 50 ? 'bg-boom-500' : 'bg-amber-400'}`}
                                  style={{ width: `${r.completion}%` }}
                                />
                              </div>
                              <span className={`text-xs font-bold w-10 tabular-nums ${r.completion === 100 ? 'text-emerald-600' : 'text-gray-400'}`}>{r.completion}%</span>
                            </div>
                            <span className={`text-xs font-medium w-16 text-right ${isUrgent ? 'text-red-500' : isPast ? 'text-gray-300' : 'text-gray-400'}`}>
                              {isPast ? `${Math.abs(daysUntil)}d ago` : daysUntil === 0 ? 'Today' : `${daysUntil}d`}
                            </span>
                            {r.priority === 'high priority' && (
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-600">HIGH</span>
                            )}
                          </div>
                        </Link>
                        <button
                          onClick={() => unassignRelease(r.id)}
                          disabled={isUnassigning}
                          title="Unassign myself"
                          className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 p-1.5 text-gray-300 hover:text-red-400 hover:bg-red-50 rounded-lg"
                        >
                          {isUnassigning ? <Loader size={13} className="animate-spin" /> : <UserMinus size={13} />}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* MY TASKS */}
          {/* ── The tasks tab: two panes, Notes-style ────────────────────
              Was five stacked bands — To Do Today, Overdue, Due today, In
              progress, Completed — each row carrying coloured chips for 7
              categories, 4 priorities and 3 statuses. That is the formatting
              John did not like: reading eight open tasks should not mean
              decoding a legend.

              Now a list and a detail pane. The list is the page; the detail is
              where the note lives and autosaves. Everything the old bands could
              do still happens — status on the dot, the rest in the detail pane
              (see components/mywork/TaskDetail.jsx). */}
          {tab === 'tasks' && (
            <div className="flex flex-col lg:flex-row gap-0 border border-rule rounded-xl overflow-hidden min-h-[520px]">
              <div className="lg:w-[300px] lg:flex-shrink-0 lg:border-r border-divider flex flex-col min-h-0">
                <div className="flex items-center gap-1 px-2 py-2 border-b border-divider">
                  {[['open', 'Open'], ['done', 'Done'], ['all', 'All']].map(([id, label]) => (
                    <button key={id} onClick={() => setBucket(id)}
                      className={`text-[11px] font-bold px-2.5 py-1 rounded-md transition-colors ${
                        bucket === id ? 'bg-boom-600 text-white' : 'text-gray-500 hover:bg-gray-100'}`}>
                      {label}
                      <span className={bucket === id ? 'text-white/70 ml-1' : 'text-gray-300 ml-1'}>
                        {id === 'open' ? openTasks.length : id === 'done' ? doneTasks.length : tasks.length}
                      </span>
                    </button>
                  ))}
                  <div className="relative ml-auto">
                    <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input value={listQuery} onChange={(e) => setListQuery(e.target.value)}
                      placeholder="Search"
                      className="pl-6 pr-2 py-1 text-[11px] border border-rule rounded-md w-28 bg-card" />
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                  <TaskList
                    tasks={paneTasks}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onToggleStatus={toggleStatus}
                    pinnedIds={pinnedIds}
                    onDragStart={setDragId}
                    onDrop={(id) => { if (dragId && dragId !== id) handleTaskDrop(dragId, id); setDragId(null) }}
                    relativeDate={relativeDate}
                    isOverdue={isPastLocal}
                    emptyText={listQuery ? 'Nothing matches.' : 'No tasks here.'}
                  />
                </div>
              </div>

              <div className="flex-1 flex flex-col min-w-0 min-h-[420px]">
                <TaskDetail
                  task={selectedTask}
                  onEdit={autosave.change}
                  onFlush={autosave.flush}
                  onPrime={autosave.prime}
                  onToggleStatus={toggleStatus}
                  onDelete={deleteTask}
                  onSnooze={snoozeTask}
                  onTogglePin={togglePin}
                  pinned={selectedTask ? pinnedIds.includes(selectedTask.id) : false}
                  releases={releases}
                  relativeDate={relativeDate}
                  isOverdue={isPastLocal}
                  team={teamMembers}
                  onAssign={assignTask}
                />
              </div>
            </div>
          )}

        </div>
      </div>

      </div>{/* end main content column */}
      {/* Right rail — the cross-app "waiting on you" feed. First (as a
          horizontal strip) on phones, right column on desktop. */}
      <div className="order-1 lg:order-none min-w-0">
        <MyWorkRail />
      </div>
      </div>{/* end command-center grid */}
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
          team={teamRoster}
          onClose={() => setPendingEmail(null)}
          onSent={() => setPendingEmail(null)}
          onSkipped={() => setPendingEmail(null)}
          skipLabel="Skip email"
        />
      )}
    </div>
  )
}
