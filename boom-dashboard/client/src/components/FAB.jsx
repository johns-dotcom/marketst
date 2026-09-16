import { useState } from 'react'
import { Plus, X, CheckSquare, Music, DollarSign } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

/**
 * Floating Action Button — visible on mobile only.
 * Expands to show quick actions: New Task, New Release, Add Invoice.
 * Actions targeting pages the User can't view are hidden so the FAB
 * doesn't advertise routes they'd get redirected away from on tap.
 */
export default function FAB() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const { canView } = useAuth()

  // Base path (strip ?query and #hash) so canView matches the same
  // path shape the permissions matrix stores.
  const basePath = (p) => (p || '').split(/[?#]/)[0]

  const actions = [
    // ?new=task tells the My Work page to open the add-task form on mount.
    { label: 'New Task', icon: CheckSquare, path: '/my-work?new=task', color: 'bg-blue-500' },
    { label: 'Add Release', icon: Music, path: '/releases', color: 'bg-violet-500' },
    { label: 'Add Invoice', icon: DollarSign, path: '/bk/add', color: 'bg-emerald-500' },
  ].filter(a => canView(basePath(a.path)))

  // Nothing to offer — hide the FAB entirely so a bare-permissions User
  // doesn't see a stray + button that opens an empty menu.
  if (actions.length === 0) return null

  return (
    <div
      className="fixed bottom-20 right-4 z-40 sm:hidden flex flex-col-reverse items-end gap-2"
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* Action buttons */}
      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 bg-black/20 -z-10" onClick={() => setOpen(false)} />
          {actions.map(a => {
            const Icon = a.icon
            return (
              <button
                key={a.label}
                onClick={() => { setOpen(false); navigate(a.path) }}
                className="flex items-center gap-2 pl-3 pr-4 py-2.5 bg-white rounded-full shadow-lg border border-gray-200 text-sm font-semibold text-gray-700 active:scale-95 transition-transform"
              >
                <div className={`w-7 h-7 ${a.color} rounded-full flex items-center justify-center`}>
                  <Icon size={14} className="text-white" />
                </div>
                {a.label}
              </button>
            )
          })}
        </>
      )}

      {/* Main FAB */}
      <button
        onClick={() => setOpen(v => !v)}
        className={`w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all active:scale-90 ${
          open ? 'bg-gray-900 rotate-45' : 'bg-boom-600'
        }`}
      >
        {open ? <X size={24} className="text-white" /> : <Plus size={24} className="text-white" />}
      </button>
    </div>
  )
}
