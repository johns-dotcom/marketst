import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { UserPlus, X, Check } from 'lucide-react'
import api from '../api'

// Assign reviewers to an expense — same review_assignments the home-page
// Needs-review inbox uses, exposed as a row-level control so flags can be
// routed to people right where they're raised (artist pages + song
// subpages). Multi-select; saving replaces the full assignee set.
//
// The team list is cached module-wide so fifty rows don't fire fifty
// /team requests.
let teamPromise = null
const getTeam = () => {
  if (!teamPromise) {
    teamPromise = api.get('/team')
      .then(r => (r.data?.data || r.data || []).map(u => ({ id: u.id, name: u.name })))
      .catch(() => { teamPromise = null; return [] })
  }
  return teamPromise
}

export default function AssignReviewersButton({ entryId, assignees = [], onChange }) {
  const [menu, setMenu] = useState(null) // { top, left, draft:Set, saving }
  const [team, setTeam] = useState([])
  const btnRef = useRef(null)
  const popRef = useRef(null)

  const openMenu = (e) => {
    e.stopPropagation()
    getTeam().then(setTeam)
    const r = btnRef.current?.getBoundingClientRect()
    setMenu({
      top: Math.min((r?.bottom || 0) + 6, window.innerHeight - 60),
      left: Math.min(Math.max(8, (r?.left || 0) - 110), window.innerWidth - 240),
      draft: new Set((assignees || []).map(a => a.user_id)),
      saving: false,
    })
  }

  useEffect(() => {
    if (!menu) return
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return
      setMenu(null)
    }
    const onKey = (e) => { if (e.key === 'Escape') setMenu(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const toggle = (uid) => setMenu(prev => {
    if (!prev) return prev
    const draft = new Set(prev.draft)
    draft.has(uid) ? draft.delete(uid) : draft.add(uid)
    return { ...prev, draft }
  })

  const save = async () => {
    if (!menu || menu.saving) return
    setMenu(prev => prev ? { ...prev, saving: true } : prev)
    try {
      const r = await api.post('/artist-campaigns/review-assign', { entry_id: entryId, user_ids: [...menu.draft] })
      onChange?.(entryId, r.data?.data?.assignees || [])
      setMenu(null)
    } catch (err) {
      alert('Failed to save assignees: ' + (err.response?.data?.error || err.message))
      setMenu(prev => prev ? { ...prev, saving: false } : prev)
    }
  }

  const count = (assignees || []).length

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={openMenu}
        className={`relative p-1 ${count > 0 ? 'text-boom-600 hover:text-boom-700' : 'text-gray-300 hover:text-boom-600'}`}
        title={count > 0
          ? `Reviewers: ${assignees.map(a => a.name).join(', ')} — click to change`
          : 'Assign users to review this item'}
      >
        <UserPlus size={13} />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[12px] h-3 px-0.5 rounded-full bg-boom-600 text-white text-[8px] font-bold leading-3 text-center">
            {count}
          </span>
        )}
      </button>
      {menu && createPortal(
        <div
          ref={popRef}
          onClick={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
          style={{ position: 'fixed', top: menu.top, left: menu.left, zIndex: 60, width: 230 }}
          className="bg-card border border-rule rounded-lg shadow-lg p-2 text-xs"
        >
          <div className="flex items-center justify-between px-1 pb-1.5">
            <span className="font-bold text-gray-900">Assign reviewers</span>
            <button onClick={() => setMenu(null)} className="text-gray-300 hover:text-gray-600"><X size={13} /></button>
          </div>
          <div className="max-h-52 overflow-y-auto">
            {team.map(u => (
              <label key={u.id} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-gray-50/80 cursor-pointer">
                <input
                  type="checkbox"
                  checked={menu.draft.has(u.id)}
                  onChange={() => toggle(u.id)}
                  className="h-3.5 w-3.5 rounded border-gray-300 text-boom-600 focus:ring-boom-500"
                />
                <span className="text-gray-800">{u.name}</span>
              </label>
            ))}
            {team.length === 0 && <p className="px-1.5 py-1 text-gray-400 italic">Loading…</p>}
          </div>
          <div className="flex justify-end gap-2 pt-1.5 mt-1 border-t border-divider">
            <button onClick={() => setMenu(null)} className="btn-secondary text-[11px] px-2 py-1">Cancel</button>
            <button onClick={save} disabled={menu.saving} className="btn-primary text-[11px] px-2 py-1 inline-flex items-center gap-1">
              <Check size={11} /> {menu.saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
