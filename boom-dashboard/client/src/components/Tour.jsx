// The spotlight tour engine. Mounted once in Layout; steps come from tours/index.js.
//
// Auto-start: the welcome tour on first sign-in (never completed), then each
// page's tour the first time that page is opened — only after welcome is done,
// only for pages the person can open, one tour at a time. Completion is stored
// per user on the server (users.tours_done), so it follows them across
// devices. Replaying is always possible from the help modal (?).
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { X, ChevronLeft, ChevronRight, SkipForward, Loader } from 'lucide-react'
import api from '../api'
import { useAuth } from '../context/AuthContext'
import { TOURS, tourById, tourForPath, WELCOME_COVERS } from '../tours'

const TourContext = createContext(null)
const NOOP = { startTour: () => false, tours: [], done: {}, active: null, doneVersion: () => null, isDone: () => false, pageTour: null }
export const useTour = () => useContext(TourContext) || NOOP

const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }

export function TourProvider({ children }) {
  const { user, canView } = useAuth()
  const location = useLocation()
  const [done, setDone] = useState(null)      // { id: { version, at } } | null until loaded
  const [active, setActive] = useState(null)  // { tour, index }
  const startedOnPath = useRef(new Set())

  useEffect(() => {
    if (!user) return
    api.get('/settings/me').then((r) => setDone(r.data?.data?.tours_done || {})).catch(() => setDone({}))
  }, [user?.id])

  const role = user?.role
  const allowed = useCallback((t) => !!t && canView(t.path) && (!t.roles || t.roles.includes(role)), [canView, role])
  const tours = useMemo(() => TOURS.filter(allowed), [allowed])
  const doneVersion = useCallback((id) => done?.[id]?.version || null, [done])
  const isDone = useCallback((t) => doneVersion(t.id) === t.version, [doneVersion])

  const startTour = useCallback((id) => {
    const t = tourById(id); if (!t) return false
    setActive({ tour: t, index: 0 })
    return true
  }, [])
  // completed: true = Done, false = Skip, null = nothing was on screen to show
  // (a tour started for a page you are not on) — closed without recording,
  // so it still offers itself the first time that page is opened.
  const finish = useCallback(async (completed, skippedPaths = []) => {
    const t = active?.tour; setActive(null)
    if (!t || completed === null) return
    // Finishing the welcome walk also completes every page tour it ran, so
    // those pages do not offer their tour again the moment they are opened. A
    // page the person chose to skip keeps its first-open tour — for a later
    // session, not the moment this one ends.
    const covers = t.id === 'welcome' && completed ? WELCOME_COVERS.filter((c) => !skippedPaths.includes(c.path)) : []
    if (t.id === 'welcome' && completed) WELCOME_COVERS.filter((c) => skippedPaths.includes(c.path)).forEach((c) => startedOnPath.current.add(c.id))
    const batch = [{ id: t.id, version: t.version, skipped: !completed }, ...covers.map((c) => ({ id: c.id, version: c.version, skipped: false }))]
    try {
      const r = await api.put('/settings/me/tours', batch.length > 1 ? { tours: batch } : batch[0])
      setDone(r.data?.data || Object.fromEntries(batch.map((b) => [b.id, { version: b.version }])))
    } catch { setDone((d) => ({ ...(d || {}), ...Object.fromEntries(batch.map((b) => [b.id, { version: b.version }])) })) }
  }, [active, done])

  // Auto-start. Welcome first; then the page tour once per page per session.
  useEffect(() => {
    if (!user || done === null || active) return undefined
    const welcome = tourById('welcome')
    if (welcome && !isDone(welcome) && !startedOnPath.current.has('welcome')) {
      const t = setTimeout(() => { startedOnPath.current.add('welcome'); setActive({ tour: welcome, index: 0 }) }, 600); return () => clearTimeout(t)
    }
    if (welcome && !isDone(welcome)) return undefined
    const pt = tourForPath(location.pathname)
    if (pt && allowed(pt) && !isDone(pt) && !startedOnPath.current.has(pt.id)) {
      const t = setTimeout(() => { startedOnPath.current.add(pt.id); setActive({ tour: pt, index: 0 }) }, 900)
      return () => clearTimeout(t)
    }
    return undefined
  }, [user?.id, done, location.pathname, active, isDone, allowed])

  const value = useMemo(() => ({ startTour, tours, done: done || {}, active, doneVersion, isDone, pageTour: (() => { const pt = tourForPath(location.pathname); return allowed(pt) ? pt : null })() }), [startTour, tours, done, active, doneVersion, isDone, location.pathname, allowed])
  return (
    <TourContext.Provider value={value}>
      {children}
      {active && <TourOverlay tour={active.tour} index={active.index} setIndex={(i) => setActive((a) => (a ? { ...a, index: i } : a))} onFinish={finish} canView={canView} role={user?.role} />}
    </TourContext.Provider>
  )
}

// How long a step may wait for its page to render its anchor before it is
// skipped. Harnesses shorten it.
const WAIT_MS = () => (typeof window !== 'undefined' && window.__TOUR_WAIT_MS__) || 4000

function TourOverlay({ tour, index, setIndex, onFinish, canView, role }) {
  const location = useLocation()
  const navigate = useNavigate()
  const steps = tour.steps
  // Which steps this person may take: a step on a page they cannot open is
  // dropped up front, so the count is honest.
  const eligible = useMemo(() => steps.map((st, i) => ({ st, i })).filter(({ st }) => canView(st.path || tour.path) && (!st.needs || canView(st.needs)) && (!st.roles || st.roles.includes(role))), [steps, tour.path, canView, role])
  const order = eligible.map((e) => e.i)
  const pos = Math.max(0, order.indexOf(index) === -1 ? 0 : order.indexOf(index))
  const stepIdx = order[pos]
  const step = steps[stepIdx]
  const wantPath = step?.path || null
  const onPage = !wantPath || location.pathname === wantPath || (tour.match && tour.match.test(location.pathname))
  const [rect, setRect] = useState(null)
  const [waiting, setWaiting] = useState(false)
  const navigatedFor = useRef(null)
  // Skip this page: jump to the first later step on a different page.
  const nextPagePos = order.findIndex((idx, k) => k > pos && (steps[idx].path || tour.path) !== (step?.path || tour.path))
  const skippedPaths = useRef([])   // pages the person chose to skip in a multipage walk

  useEffect(() => { if (order.length === 0) onFinish(null) }, [order.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Go to the step's page once per step.
  useEffect(() => {
    if (!step || onPage || navigatedFor.current === stepIdx) return
    navigatedFor.current = stepIdx
    navigate(wantPath)
  }, [step, stepIdx, onPage, wantPath, navigate])

  // Find and measure the anchor; wait for it after a navigation; skip the
  // step if the page never renders it.
  useLayoutEffect(() => {
    if (!step) return undefined
    if (step.target === null) { setRect(null); setWaiting(false); return undefined }
    let cancelled = false
    const started = Date.now()
    setWaiting(true)
    const tryMeasure = () => {
      if (cancelled) return
      const el = onPage ? document.querySelector(step.target) : null
      if (el && visible(el)) {
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch { /* jsdom */ }
        const r = el.getBoundingClientRect()
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height }); setWaiting(false)
        setTimeout(() => { if (!cancelled) { const r2 = el.getBoundingClientRect(); setRect({ top: r2.top, left: r2.left, width: r2.width, height: r2.height }) } }, 350)
        return
      }
      if (Date.now() - started > WAIT_MS()) {
        setWaiting(false); setRect(null)
        // Never reached the page (a guard sent us elsewhere): drop the whole page, not one step at a time.
        const to = !onPage && nextPagePos !== -1 ? nextPagePos : pos + 1
        if (to < order.length) setIndex(order[to]); else onFinish(true, skippedPaths.current)
        return
      }
      setTimeout(tryMeasure, 150)
    }
    tryMeasure()
    const onChange = () => { const el = document.querySelector(step.target); if (el && visible(el)) { const r = el.getBoundingClientRect(); setRect({ top: r.top, left: r.left, width: r.width, height: r.height }) } }
    window.addEventListener('resize', onChange); window.addEventListener('scroll', onChange, true)
    return () => { cancelled = true; window.removeEventListener('resize', onChange); window.removeEventListener('scroll', onChange, true) }
  }, [step, stepIdx, onPage]) // eslint-disable-line react-hooks/exhaustive-deps

  const next = () => { if (pos + 1 >= order.length) onFinish(true, skippedPaths.current); else setIndex(order[pos + 1]) }
  const back = () => { if (pos > 0) setIndex(order[pos - 1]) }
  const skipPage = () => {
    if (step?.path && !skippedPaths.current.includes(step.path)) skippedPaths.current.push(step.path)
    if (nextPagePos === -1) onFinish(true, skippedPaths.current); else setIndex(order[nextPagePos])
  }
  useEffect(() => {
    // Keys typed into a field, or Enter on a focused button (which also clicks), are not tour shortcuts.
    const onKey = (e) => {
      const el = e.target
      if (el && (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(el.tagName) || el.isContentEditable)) return
      if (e.key === 'Escape') onFinish(false)
      else if ((e.key === 'ArrowRight' || e.key === 'Enter') && !waiting) next()
      else if (e.key === 'ArrowLeft') back()
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }) // eslint-disable-line react-hooks/exhaustive-deps
  if (!step) return null
  const pad = 8
  const vw = window.innerWidth || 1200, vh = window.innerHeight || 800
  const spot = rect && step.target !== null && !waiting
  const below = spot ? rect.top + rect.height + 16 + 200 < vh : true
  const cardTop = spot ? (below ? rect.top + rect.height + 14 : Math.max(12, rect.top - 14 - 210)) : Math.max(24, vh / 2 - 120)
  const cardLeft = spot ? Math.min(Math.max(12, rect.left), Math.max(12, vw - 372)) : Math.max(12, vw / 2 - 180)
  const pageLabel = step.page || (wantPath ? ({ '/': 'Home' }[wantPath] || wantPath.replace(/^\//, '').replace(/^bk\//, '').replace(/-/g, ' ')) : null)
  return (
    <div className="fixed inset-0 z-[200]" data-tour-overlay data-tour-id={tour.id} data-tour-step={stepIdx} data-tour-waiting={waiting ? '1' : '0'} aria-live="polite">
      {spot ? (
        <div className="absolute rounded-lg pointer-events-none transition-all duration-200" data-tour-spotlight
          style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2, boxShadow: '0 0 0 9999px rgba(17, 24, 39, 0.55)', outline: '2px solid rgba(255,255,255,0.9)' }} />
      ) : <div className="absolute inset-0 bg-gray-900/55" />}
      <div className="absolute w-[360px] max-w-[calc(100vw-24px)] bg-card border border-rule rounded-xl shadow-2xl p-4" style={{ top: cardTop, left: cardLeft }} data-tour-card role="dialog" aria-label={step.title}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{tour.title} · {pos + 1} of {order.length}{tour.multipage && pageLabel ? ` · ${pageLabel}` : ''}</p>
            <h3 className="text-sm font-semibold text-gray-900 mt-0.5">{step.title}</h3>
          </div>
          <button onClick={() => onFinish(false)} className="text-gray-400 hover:text-gray-700 p-1 -m-1 rounded" aria-label="Skip the tour" data-tour-skip><X size={14} /></button>
        </div>
        {waiting
          ? <p className="text-[13px] text-gray-500 mt-2 inline-flex items-center gap-2" data-tour-loading><Loader size={12} className="animate-spin" /> Opening {pageLabel || 'the page'}…</p>
          : <p className="text-[13px] text-gray-600 mt-2 leading-relaxed">{step.body}</p>}
        <div className="flex items-center justify-between mt-4 gap-2">
          <div className="flex items-center gap-2">
            <button onClick={() => onFinish(false)} className="text-xs text-gray-400 hover:text-gray-700" data-tour-skip-all>Skip tour</button>
            {tour.multipage && nextPagePos !== -1 && <button onClick={skipPage} className="text-xs text-gray-400 hover:text-gray-700 inline-flex items-center gap-1" data-tour-skip-page><SkipForward size={11} /> Skip this page</button>}
          </div>
          <div className="flex items-center gap-1.5">
            {pos > 0 && <button onClick={back} className="inline-flex items-center gap-1 text-xs font-semibold border border-rule rounded-lg px-2.5 py-1.5 hover:bg-gray-50" data-tour-back><ChevronLeft size={12} /> Back</button>}
            <button onClick={next} disabled={waiting} className="inline-flex items-center gap-1 text-xs font-semibold bg-gray-900 text-white rounded-lg px-3 py-1.5 hover:bg-gray-800 disabled:opacity-40" data-tour-next>{pos + 1 >= order.length ? 'Done' : 'Next'} {pos + 1 < order.length && <ChevronRight size={12} />}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
