import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useShortcuts } from '../context/ShortcutsContext'
import { useToast } from '../context/ToastContext'
import { GOTO, PAGE_KEYS, keyLabel } from '../lib/shortcuts'

const typing = (el) => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)

// g, then a letter → a page (lib/shortcuts.GOTO), filtered to pages this person
// can open. Listens in the CAPTURE phase: page hotkeys register before Layout's
// (children's effects run first), so a bubble-phase listener would let the
// second letter reach the page as well — `g f` would jump to Flags AND focus
// the filter on the page you were leaving. While armed a small panel lists the
// letters; Escape or 1.5s disarms.
export default function GoToChords() {
  const navigate = useNavigate()
  const { canView } = useAuth()
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    let timer = null
    const disarm = () => { setArmed(false); if (timer) { clearTimeout(timer); timer = null } }
    const onKey = (e) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      // A walkthrough drives its own navigation; a chord mid-tour would pull the page out from under it.
      if (document.querySelector('[data-tour-overlay]')) return
      if (!armedRef.current) {
        if (e.key === 'g' && !e.shiftKey) {
          e.preventDefault(); e.stopPropagation()
          armedRef.current = true; setArmed(true)
          timer = setTimeout(() => { armedRef.current = false; disarm() }, 1500)
        }
        return
      }
      // Second key of the chord.
      e.preventDefault(); e.stopPropagation()
      armedRef.current = false; disarm()
      if (e.key === 'Escape') return
      const hit = GOTO.find(([letter, path]) => letter === e.key.toLowerCase() && (!canView || canView(path)))
      if (hit) navigate(hit[1])
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); if (timer) clearTimeout(timer) }
  }, [navigate, canView])
  if (!armed) return null
  const list = GOTO.filter(([, path]) => !canView || canView(path))
  return (
    <div className="fixed bottom-4 left-4 z-[300] card px-3 py-2 shadow-xl text-[11px] text-ink" data-goto-panel role="status">
      <p className="font-bold text-gray-400 uppercase tracking-wider text-[10px] mb-1">Go to…</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-0.5">
        {list.map(([letter, , label]) => (
          <span key={letter} className="inline-flex items-center gap-1.5"><kbd className="rounded border border-rule bg-gray-100 px-1 font-bold">{letter.toUpperCase()}</kbd> {label}</span>
        ))}
      </div>
    </div>
  )
}
// Module-level so the capture listener (created once per navigate/canView) can read it synchronously.
const armedRef = { current: false }

// Global chrome the shortcuts need: ⌘Z runs the page's registered undo, a
// one-time toast says ? exists, and every [data-key] control gets its key
// appended to its tooltip ("Mark paid · P") so the keys are discoverable where
// the mouse already is.
export function useShortcutChrome(user) {
  const { runUndo } = useShortcuts()
  const { toast } = useToast()
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing(e.target)) { if (runUndo()) e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [runUndo])
  useEffect(() => {
    if (!user) return
    try {
      if (localStorage.getItem('shortcuts_hint_v1')) return
      localStorage.setItem('shortcuts_hint_v1', new Date().toISOString())
      const t = setTimeout(() => toast.info('Press ? for keyboard shortcuts — j and k move, g then a letter jumps to a page'), 2500)
      return () => clearTimeout(t)
    } catch { return undefined }
  }, [user?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const stamp = () => {
      for (const el of document.querySelectorAll('[data-key]:not([data-key-hinted])')) {
        const k = el.getAttribute('data-key'); if (!k) continue
        const label = keyLabel({ key: k, meta: false, shift: false })
        const t = el.getAttribute('title') || el.getAttribute('aria-label') || ''
        if (!new RegExp(`· ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(t)) el.setAttribute('title', t ? `${t} · ${label}` : `Key: ${label}`)
        el.setAttribute('data-key-hinted', '1')
      }
    }
    stamp()
    const mo = new MutationObserver(() => { clearTimeout(mo._t); mo._t = setTimeout(stamp, 120) })
    mo.observe(document.body, { childList: true, subtree: true })
    return () => { clearTimeout(mo._t); mo.disconnect() }
  }, [])
}

export const pageKeysFor = (path) => PAGE_KEYS[path] || []
