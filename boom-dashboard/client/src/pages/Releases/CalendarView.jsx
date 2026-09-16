import { useState, useMemo } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { MONTHS, parseLocalDate, getCompletionPercentage } from './constants'

/**
 * Month-grid calendar view. Owns its own currently-viewed month state; the
 * parent supplies the filtered release list and a callback for when the
 * user clicks one of the release chips rendered inside a day cell.
 */
export default function CalendarView({ filteredReleases, onReleaseClick }) {
  const [calendarDate, setCalendarDate] = useState(() => new Date())
  const calYear  = calendarDate.getFullYear()
  const calMonth = calendarDate.getMonth()

  const getDaysInMonth    = (y, m) => new Date(y, m + 1, 0).getDate()
  const getFirstDayOfMonth = (y, m) => new Date(y, m, 1).getDay()

  const prevMonth = () => setCalendarDate(new Date(calYear, calMonth - 1, 1))
  const nextMonth = () => setCalendarDate(new Date(calYear, calMonth + 1, 1))

  const releasesByDay = useMemo(() => {
    const map = {}
    filteredReleases.forEach(r => {
      if (!r.release_date) return
      const d = parseLocalDate(r.release_date)
      if (d && d.getFullYear() === calYear && d.getMonth() === calMonth) {
        const day = d.getDate()
        if (!map[day]) map[day] = []
        map[day].push(r)
      }
    })
    return map
  }, [filteredReleases, calYear, calMonth])

  return (
    <div className="card overflow-hidden">
      {/* Calendar header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-divider">
        <button onClick={prevMonth} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <ChevronLeft size={18} />
        </button>
        <h2 className="text-sm font-semibold text-gray-900">
          {MONTHS[calMonth]} {calYear}
        </h2>
        <button onClick={nextMonth} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <ChevronRight size={18} />
        </button>
      </div>

      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 border-b border-divider">
        {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
          <div key={d} className="py-2 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7">
        {/* Empty cells for days before month starts */}
        {Array.from({ length: getFirstDayOfMonth(calYear, calMonth) }).map((_, i) => (
          <div key={`empty-${i}`} className="min-h-[80px] border-b border-r border-divider bg-gray-50/50" />
        ))}

        {/* Day cells */}
        {Array.from({ length: getDaysInMonth(calYear, calMonth) }).map((_, i) => {
          const day = i + 1
          const today = new Date()
          const isToday = today.getFullYear() === calYear && today.getMonth() === calMonth && today.getDate() === day
          const dayReleases = releasesByDay[day] || []

          return (
            <div
              key={day}
              className={`min-h-[80px] border-b border-r border-divider p-2 ${
                isToday ? 'bg-red-50/30' : 'hover:bg-gray-50/50'
              }`}
            >
              <div className={`text-xs font-semibold mb-1.5 w-6 h-6 flex items-center justify-center rounded-full ${
                isToday ? 'bg-red-500 text-white' : 'text-gray-500'
              }`}>
                {day}
              </div>
              <div className="space-y-1">
                {dayReleases.map(r => {
                  const pct = getCompletionPercentage(r)
                  return (
                    <button
                      key={r.id}
                      onClick={() => onReleaseClick(r)}
                      className={`w-full text-left px-1.5 py-1 rounded text-xs font-medium truncate transition-all hover:opacity-80 ${
                        pct === 100
                          ? 'bg-emerald-100 text-emerald-800'
                          : r.priority === 'high priority'
                          ? 'bg-red-100 text-red-800'
                          : r.priority === 'priority'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                      title={`${r.artist_name} — ${r.project_name} (${pct}%)`}
                    >
                      {r.artist_name} — {r.project_name}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {/* Legend */}
      <div className="px-5 py-3 border-t border-divider flex items-center gap-4 flex-wrap">
        <span className="text-xs text-gray-400 font-medium">Legend:</span>
        <span className="flex items-center gap-1.5 text-xs text-gray-600"><span className="w-3 h-3 rounded bg-emerald-100 inline-block" /> Complete</span>
        <span className="flex items-center gap-1.5 text-xs text-gray-600"><span className="w-3 h-3 rounded bg-red-100 inline-block" /> High Priority</span>
        <span className="flex items-center gap-1.5 text-xs text-gray-600"><span className="w-3 h-3 rounded bg-amber-100 inline-block" /> Priority</span>
        <span className="flex items-center gap-1.5 text-xs text-gray-600"><span className="w-3 h-3 rounded bg-gray-100 inline-block" /> Standard</span>
      </div>
    </div>
  )
}
