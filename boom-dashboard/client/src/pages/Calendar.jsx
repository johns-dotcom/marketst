import { useState, useEffect, useMemo } from 'react'
import { ChevronLeft, ChevronRight, Plus, X, Music, FileText, CheckSquare, Calendar as CalendarIcon, Disc3, Trash2, Loader } from 'lucide-react'
import api from '../api'
import { useAuth } from '../context/AuthContext'
import useHotkeys from '../hooks/useHotkeys'
import Skeleton from '../components/Skeleton'

const EVENT_STYLES = {
  release:          { bg: 'bg-blue-50',    border: 'border-blue-200',   dot: 'bg-blue-500',    text: 'text-blue-700',    label: 'Release' },
  contract_expiry:  { bg: 'bg-red-50',     border: 'border-red-200',    dot: 'bg-red-500',     text: 'text-red-700',     label: 'Contract Expiry' },
  contract_signed:  { bg: 'bg-emerald-50', border: 'border-emerald-200',dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'Contract Signed' },
  deadline:         { bg: 'bg-amber-50',   border: 'border-amber-200',  dot: 'bg-amber-500',   text: 'text-amber-700',   label: 'Task' },
  dsp_live:         { bg: 'bg-purple-50',  border: 'border-purple-200', dot: 'bg-purple-500',  text: 'text-purple-700',  label: 'DSP Live' },
  dsp_submitted:    { bg: 'bg-indigo-50',  border: 'border-indigo-200', dot: 'bg-indigo-400',  text: 'text-indigo-600',  label: 'DSP Submitted' },
  manual:           { bg: 'bg-gray-50',    border: 'border-rule',   dot: 'bg-gray-500',    text: 'text-gray-700',    label: 'Event' },
}

const EVENT_ICONS = {
  release: Music,
  contract_expiry: FileText,
  contract_signed: FileText,
  deadline: CheckSquare,
  dsp_live: Disc3,
  dsp_submitted: Disc3,
  manual: CalendarIcon,
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

const ALL_TYPES = [
  { key: 'release', label: 'Releases' },
  { key: 'deadline', label: 'Tasks' },
  { key: 'contract_expiry', label: 'Contracts' },
  { key: 'contract_signed', label: 'Contracts' },
  { key: 'dsp_live', label: 'DSP' },
  { key: 'dsp_submitted', label: 'DSP' },
  { key: 'manual', label: 'Events' },
]

const FILTER_GROUPS = [
  { key: 'release', label: 'Releases', dot: 'bg-blue-500' },
  { key: 'deadline', label: 'Tasks', dot: 'bg-amber-500' },
  { key: 'contract', label: 'Contracts', dot: 'bg-red-500' },
  { key: 'dsp', label: 'DSP', dot: 'bg-purple-500' },
  { key: 'manual', label: 'Events', dot: 'bg-gray-500' },
]

function getStyle(type) {
  return EVENT_STYLES[type] || EVENT_STYLES.manual
}

export default function Calendar() {
  const { user } = useAuth()
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [month, setMonth] = useState(new Date().getMonth())
  const [year, setYear] = useState(new Date().getFullYear())
  const [selectedDate, setSelectedDate] = useState(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [addForm, setAddForm] = useState({ title: '', event_date: '', description: '', color: '' })
  const [activeFilters, setActiveFilters] = useState(new Set(FILTER_GROUPS.map(f => f.key)))

  const fetchEvents = async () => {
    try {
      const res = await api.get('/calendar')
      setEvents(res.data.events || [])
    } catch (err) {
      console.error('Failed to load calendar:', err)
    }
  }

  useEffect(() => {
    fetchEvents().then(() => setLoading(false))
  }, [])

  const toggleFilter = (key) => {
    setActiveFilters(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const filteredEvents = useMemo(() => {
    return events.filter(e => {
      const typeGroup = e.type.startsWith('contract') ? 'contract' : e.type.startsWith('dsp') ? 'dsp' : e.type
      return activeFilters.has(typeGroup)
    })
  }, [events, activeFilters])

  // Build calendar grid
  const firstDay = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0)
  const startPad = firstDay.getDay()
  const totalDays = lastDay.getDate()

  const weeks = []
  let currentWeek = new Array(startPad).fill(null)

  for (let d = 1; d <= totalDays; d++) {
    currentWeek.push(d)
    if (currentWeek.length === 7) {
      weeks.push(currentWeek)
      currentWeek = []
    }
  }
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) currentWeek.push(null)
    weeks.push(currentWeek)
  }

  const dateStr = (d) => `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const eventsForDay = (d) => filteredEvents.filter(e => e.date === dateStr(d))
  const today = new Date()
  const isToday = (d) => d === today.getDate() && month === today.getMonth() && year === today.getFullYear()

  const goToday = () => { setMonth(today.getMonth()); setYear(today.getFullYear()) }
  const prevMonth = () => { if (month === 0) { setMonth(11); setYear(y => y - 1) } else setMonth(m => m - 1) }
  const nextMonth = () => { if (month === 11) { setMonth(0); setYear(y => y + 1) } else setMonth(m => m + 1) }

  useHotkeys([
    { key: 'ArrowLeft', handler: prevMonth },
    { key: 'ArrowRight', handler: nextMonth },
    { key: 't', handler: goToday },
    { key: 'n', handler: () => setShowAddForm(true) },
  ])

  const selectedEvents = selectedDate ? filteredEvents.filter(e => e.date === selectedDate) : []

  const handleAddEvent = async (e) => {
    e.preventDefault()
    if (!addForm.title || !addForm.event_date) return
    try {
      await api.post('/calendar', addForm)
      setAddForm({ title: '', event_date: '', description: '', color: '' })
      setShowAddForm(false)
      fetchEvents()
    } catch (err) {
      console.error('Failed to add event:', err)
    }
  }

  const handleDeleteEvent = async (id) => {
    // Confirm like every other delete in the app — a mis-click on the
    // small trash icon permanently removed the event with no undo.
    if (!window.confirm('Delete this event?')) return
    try {
      await api.delete(`/calendar/${id}`)
      fetchEvents()
    } catch (err) {
      console.error('Failed to delete event:', err)
    }
  }

  // Upcoming events (next 14 days). Local date strings — toISOString() is
  // UTC, which dropped today's events from the panel every evening.
  const localStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const todayStr = localStr(today)
  const in14 = localStr(new Date(today.getTime() + 14 * 86400000))
  const upcoming = filteredEvents
    .filter(e => e.date >= todayStr && e.date <= in14)
    .sort((a, b) => a.date.localeCompare(b.date))

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton.PageHeader />
        <Skeleton.Block h="h-96" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-gray-900">Calendar</h1>
          <p className="text-sm text-gray-400 mt-0.5">{filteredEvents.length} events</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowAddForm(v => !v)}
            className="flex items-center gap-1.5 text-xs font-semibold text-white bg-boom-600 hover:bg-boom-700 px-3 py-1.5 rounded-lg transition-colors"
          ><Plus size={13} /> Add Event</button>
        </div>
      </div>

      {/* Add Event Form */}
      {showAddForm && (
        <div className="card p-4">
          <form onSubmit={handleAddEvent} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input type="text" value={addForm.title} onChange={e => setAddForm(f => ({ ...f, title: e.target.value }))}
                placeholder="Event title" required autoFocus
                className="text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-boom-500" />
              <input type="date" value={addForm.event_date} onChange={e => setAddForm(f => ({ ...f, event_date: e.target.value }))}
                required className="text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-boom-500" />
            </div>
            <input type="text" value={addForm.description} onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Description (optional)"
              className="w-full text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-boom-500" />
            <div className="flex items-center gap-2">
              <button type="submit" className="text-xs font-semibold text-white bg-boom-600 hover:bg-boom-700 px-4 py-2 rounded-lg transition-colors">Add</button>
              <button type="button" onClick={() => setShowAddForm(false)} className="text-xs text-gray-400 hover:text-gray-600 px-3 py-2">Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        {FILTER_GROUPS.map(f => (
          <button key={f.key} onClick={() => toggleFilter(f.key)}
            className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border transition-all ${
              activeFilters.has(f.key)
                ? 'bg-card border-rule text-gray-700 shadow-sm'
                : 'bg-gray-50 border-divider text-gray-300'
            }`}>
            <span className={`w-2 h-2 rounded-full ${f.dot} ${activeFilters.has(f.key) ? '' : 'opacity-30'}`} />
            {f.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
        {/* Calendar Grid */}
        <div className="xl:col-span-3 card overflow-hidden">
          {/* Month nav */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-divider">
            <div className="flex items-center gap-3">
              <button onClick={prevMonth} className="p-1 hover:bg-gray-100 rounded transition-colors"><ChevronLeft size={18} className="text-gray-500" /></button>
              <h2 className="text-sm font-bold text-gray-900 w-36 text-center">{MONTHS[month]} {year}</h2>
              <button onClick={nextMonth} className="p-1 hover:bg-gray-100 rounded transition-colors"><ChevronRight size={18} className="text-gray-500" /></button>
            </div>
            <button onClick={goToday} className="text-xs font-semibold text-gray-500 hover:text-gray-700 px-2 py-1 hover:bg-gray-100 rounded transition-colors">Today</button>
          </div>

          {/* Day headers */}
          <div className="grid grid-cols-7 border-b border-divider">
            {DAYS.map(d => (
              <div key={d} className="text-center text-[10px] font-bold text-gray-400 uppercase tracking-wider py-2">{d}</div>
            ))}
          </div>

          {/* Weeks */}
          {weeks.map((week, wi) => (
            <div key={wi} className="grid grid-cols-7 border-b border-gray-50 last:border-0">
              {week.map((day, di) => {
                if (!day) return <div key={di} className="min-h-[100px] bg-gray-50/50" />

                const dayEvents = eventsForDay(day)
                const isSelected = selectedDate === dateStr(day)
                const isPast = new Date(year, month, day) < new Date(today.getFullYear(), today.getMonth(), today.getDate())

                return (
                  <button key={di}
                    onClick={() => setSelectedDate(isSelected ? null : dateStr(day))}
                    className={`min-h-[100px] p-1.5 text-left border-r border-gray-50 last:border-0 transition-colors ${
                      isSelected ? 'bg-boom-50' : 'hover:bg-gray-50'
                    }`}>
                    <span className={`inline-flex items-center justify-center w-6 h-6 text-xs font-bold rounded-full mb-1 ${
                      isToday(day) ? 'bg-boom-600 text-white' :
                      isPast ? 'text-gray-300' : 'text-gray-700'
                    }`}>{day}</span>
                    <div className="space-y-0.5">
                      {dayEvents.slice(0, 3).map(ev => {
                        const style = getStyle(ev.type)
                        return (
                          <div key={ev.id} className={`${style.bg} ${style.border} border rounded px-1.5 py-0.5 truncate`}>
                            <span className={`text-[10px] font-medium ${style.text} leading-tight`}>{ev.title}</span>
                          </div>
                        )
                      })}
                      {dayEvents.length > 3 && (
                        <span className="text-[10px] text-gray-400 font-medium px-1">+{dayEvents.length - 3} more</span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        {/* Sidebar — selected day or upcoming */}
        <div className="space-y-4">
          {selectedDate ? (
            <div className="card p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-gray-900">
                  {new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                </h3>
                <button onClick={() => setSelectedDate(null)} className="text-gray-400 hover:text-gray-600"><X size={14} /></button>
              </div>
              {selectedEvents.length === 0 ? (
                <p className="text-xs text-gray-400 py-4 text-center">No events this day</p>
              ) : (
                <div className="space-y-2">
                  {selectedEvents.map(ev => {
                    const style = getStyle(ev.type)
                    const Icon = EVENT_ICONS[ev.type] || CalendarIcon
                    return (
                      <div key={ev.id} className={`${style.bg} ${style.border} border rounded-lg p-3`}>
                        <div className="flex items-start gap-2">
                          <Icon size={14} className={`${style.text} mt-0.5 flex-shrink-0`} />
                          <div className="flex-1 min-w-0">
                            <p className={`text-xs font-semibold ${style.text}`}>{ev.title}</p>
                            {ev.subtitle && <p className="text-[10px] text-gray-500 mt-0.5">{ev.subtitle}</p>}
                            {ev.meta && <p className="text-[10px] text-gray-400 mt-0.5">{ev.meta}</p>}
                          </div>
                          {ev.deletable && (
                            <button onClick={() => handleDeleteEvent(ev.sourceId)}
                              className="text-gray-300 hover:text-red-500 transition-colors flex-shrink-0">
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="card p-4">
              <h3 className="text-sm font-bold text-gray-900 mb-3">Upcoming (14 days)</h3>
              {upcoming.length === 0 ? (
                <p className="text-xs text-gray-400 py-4 text-center">Nothing upcoming</p>
              ) : (
                <div className="space-y-2">
                  {upcoming.slice(0, 15).map(ev => {
                    const style = getStyle(ev.type)
                    const Icon = EVENT_ICONS[ev.type] || CalendarIcon
                    const evDate = new Date(ev.date + 'T12:00:00')
                    const daysAway = Math.ceil((evDate - today) / 86400000)
                    return (
                      <button key={ev.id}
                        onClick={() => { setSelectedDate(ev.date); setMonth(evDate.getMonth()); setYear(evDate.getFullYear()) }}
                        className={`w-full text-left ${style.bg} ${style.border} border rounded-lg p-3 hover:shadow-sm transition-shadow`}>
                        <div className="flex items-start gap-2">
                          <Icon size={14} className={`${style.text} mt-0.5 flex-shrink-0`} />
                          <div className="flex-1 min-w-0">
                            <p className={`text-xs font-semibold ${style.text} truncate`}>{ev.title}</p>
                            {ev.subtitle && <p className="text-[10px] text-gray-500 mt-0.5 truncate">{ev.subtitle}</p>}
                          </div>
                          <span className="text-[10px] font-bold text-gray-400 flex-shrink-0">
                            {daysAway === 0 ? 'Today' : daysAway === 1 ? 'Tomorrow' : `${daysAway}d`}
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Legend */}
          <div className="card p-4">
            <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">Legend</h3>
            <div className="space-y-1.5">
              {FILTER_GROUPS.map(f => (
                <div key={f.key} className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${f.dot}`} />
                  <span className="text-xs text-gray-600">{f.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
