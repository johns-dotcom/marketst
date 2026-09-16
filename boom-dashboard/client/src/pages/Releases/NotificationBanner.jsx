import { useState } from 'react'
import { Bell } from 'lucide-react'
import { daysUntil, getCompletionPercentage } from './constants'

/**
 * "Releases dropping soon" notification banner. Collapsible, with click-to-
 * jump chips that navigate the parent to the list + auto-expand that row's
 * checklist via the onJumpTo callback.
 */
export default function NotificationBanner({ notifications, onJumpTo }) {
  const [collapsed, setCollapsed] = useState(false)

  if (notifications.length === 0) return null

  return (
    <div className="rounded-xl border border-orange-100 bg-orange-50/60 px-5 py-3.5">
      <button
        onClick={() => setCollapsed(v => !v)}
        className="flex items-center justify-between w-full text-left"
      >
        <div className="flex items-center gap-2.5">
          <Bell size={13} className="text-orange-400 flex-shrink-0" />
          <p className="text-xs font-semibold text-orange-700 tracking-wide uppercase">
            {notifications.length} release{notifications.length !== 1 ? 's' : ''} dropping soon — checklists incomplete
          </p>
        </div>
        <span className="text-xs text-orange-400 flex-shrink-0 ml-2">
          {collapsed ? 'Show' : 'Hide'}
        </span>
      </button>
      {!collapsed && (
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {notifications.map(r => {
            const pct = getCompletionPercentage(r)
            const cd = daysUntil(r.release_date)
            return (
              <button
                key={r.id}
                onClick={() => onJumpTo(r.id)}
                className="inline-flex items-center gap-1 text-xs bg-card border border-orange-100 rounded-lg px-2.5 py-1 hover:border-orange-300 transition-colors text-gray-700"
              >
                {r.project_name}
                <span className="text-gray-300 mx-0.5">·</span>
                <span className={cd.cls}>{cd.label}</span>
                <span className="text-gray-300 mx-0.5">·</span>
                <span className="text-orange-500 font-semibold">{pct}%</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
