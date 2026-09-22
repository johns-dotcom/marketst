import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTour } from './Tour'
import { useAuth } from '../context/AuthContext'
import { useShortcuts } from '../context/ShortcutsContext'
import { GLOBAL_KEYS, GOTO, PAGE_KEYS, keyLabel } from '../lib/shortcuts'

// The ? help. CONTEXT-AWARE (2026-09-20): the page you are on comes first,
// read from what the page actually bound (hooks/usePageShortcuts → the
// ShortcutsContext), so the list cannot advertise a dead key or go stale; then
// the global keys and the g-then-letter destinations you can open.

function Kbd({ shortcut }) {
  const parts = keyLabel(shortcut).match(/⌘|Ctrl|⇧|.+/g) || [keyLabel(shortcut)]
  return (
    <span style={{ display: 'inline-flex', gap: 3 }}>
      {parts.map((p, i) => (
        <kbd key={i} style={{
          background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 4,
          padding: '2px 6px', fontSize: 11, fontWeight: 700, fontFamily: 'system-ui, sans-serif',
          color: '#374151', lineHeight: '16px', minWidth: 20, textAlign: 'center',
          boxShadow: '0 1px 0 #d1d5db',
        }}>{p}</kbd>
      ))}
    </span>
  )
}

function Group({ title, rows, testId }) {
  if (!rows.length) return null
  return (
    <div style={{ marginTop: 16 }} data-help-group={testId || title}>
      <h3 style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#9ca3af', marginBottom: 8 }}>{title}</h3>
      <div style={{ background: '#fafafa', borderRadius: 8, border: '1px solid #f0f0f0', overflow: 'hidden' }}>
        {rows.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: i < rows.length - 1 ? '1px solid #f0f0f0' : 'none' }}>
            <span style={{ fontSize: 13, color: '#374151' }}>{s.label}</span>
            {s.kbd || <Kbd shortcut={s} />}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function KeyboardShortcutsHelp({ open, onClose }) {
  const { tours, startTour, isDone, doneVersion, pageTour, isUpdated } = useTour()
  const navigate = useNavigate()
  const { page } = useShortcuts()
  const { canView } = useAuth()
  const location = useLocation()
  useEffect(() => {
    if (!open) return
    const handler = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null
  // What the page bound; falls back to the vocabulary for this path so the help
  // still says something on a page that has not mounted its keys yet.
  const pageKeys = page?.keys || PAGE_KEYS[location.pathname] || []
  const pageName = pageTour?.title || location.pathname
  const goto = GOTO.filter(([, path]) => !canView || canView(path)).map(([letter, , label]) => ({ label, kbd: (
    <span style={{ display: 'inline-flex', gap: 3 }}>
      {['G', letter.toUpperCase()].map((p, i) => <kbd key={i} style={{ background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 4, padding: '2px 6px', fontSize: 11, fontWeight: 700, fontFamily: 'system-ui, sans-serif', color: '#374151', lineHeight: '16px', minWidth: 20, textAlign: 'center', boxShadow: '0 1px 0 #d1d5db' }}>{p}</kbd>)}
    </span>
  ) }))

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, width: 640, maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }} data-shortcuts-help>
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', top: 0, background: '#fff', borderRadius: '12px 12px 0 0', zIndex: 1 }}>
          <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>Keyboard Shortcuts</h2>
          <button onClick={onClose} style={{ background: '#f3f4f6', border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer', color: '#6b7280' }}>ESC</button>
        </div>

        <div style={{ padding: '8px 24px 24px' }}>
          {tours.length > 0 && (
            <div style={{ marginBottom: 18 }} data-tours-section>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: '#9ca3af', marginBottom: 8 }}>Tours</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {pageTour && (
                  <button onClick={() => { onClose(); setTimeout(() => startTour(pageTour.id), 150) }} data-tour-this-page
                    style={{ fontSize: 12, fontWeight: 700, padding: '5px 10px', borderRadius: 8, border: '1px solid #111827', background: '#111827', color: '#fff', cursor: 'pointer' }}>
                    Tour this page{isUpdated(pageTour) ? ' · updated' : doneVersion(pageTour.id) ? '' : ' · new'}
                  </button>
                )}
                {/* A pattern-matched tour (an artist's profile) needs a real instance: This page only. */}
                {tours.filter((t) => t.id !== pageTour?.id && !t.match).map((t) => (
                  <button key={t.id} onClick={() => {
                    // Another page's tour: go there first, then start it once it has rendered (the
                    // engine closes a single-page tour that finds itself on the wrong page).
                    onClose()
                    const here = t.id === 'welcome' || t.path === location.pathname
                    if (!here) navigate(t.path)
                    setTimeout(() => startTour(t.id), here ? 150 : 700)
                  }} data-tour-start={t.id}
                    style={{ fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', cursor: 'pointer' }}>
                    {t.title}{isUpdated(t) ? ' · updated' : ''}
                  </button>
                ))}
              </div>
              <p style={{ fontSize: 11, color: '#9ca3af', margin: '8px 0 0' }}>Tours never start on their own — play any from here or from the Walkthrough button in the top bar. “New” means you have not taken it; “updated” means the page changed since you did.</p>
            </div>
          )}
          {pageKeys.length
            ? <Group title={`This page · ${pageName}`} rows={pageKeys} testId="page" />
            : <div style={{ marginTop: 16, fontSize: 12, color: '#9ca3af' }} data-help-group="page-none">This page has no keys of its own yet — the global ones below still work.</div>}
          <Group title="Everywhere" rows={GLOBAL_KEYS} testId="global" />
          <Group title="Go to a page — press G, then the letter" rows={goto} testId="goto" />
          <p style={{ fontSize: 11, color: '#9ca3af', margin: '14px 0 0' }}>On every list page j and k move, Enter opens, e edits, x selects, f focuses the filter, n makes a new one, and . reloads. Hover a button to see its key.</p>
        </div>
      </div>
    </div>
  )
}
