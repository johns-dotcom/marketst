// The spotlight tour engine. Mounted once in Layout; steps come from tours/index.js.
//
// Auto-start: the welcome tour on first sign-in (never completed), then each
// page's tour the first time that page is opened — only after welcome is done,
// only for pages the person can open, one tour at a time. Completion is stored
// per user on the server (users.tours_done), so it follows them across
// devices. Replaying is always possible from the help modal (?).
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'
import api from '../api'
import { useAuth } from '../context/AuthContext'
import { TOURS, tourById, tourForPath } from '../tours'

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

  const tours = useMemo(() => TOURS.filter((t) => canView(t.path)), [canView])
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
  const finish = useCallback(async (completed) => {
    const t = active?.tour; setActive(null)
    if (!t || completed === null) return
    try {
      const r = await api.put('/settings/me/tours', { id: t.id, version: t.version, skipped: !completed })
      setDone(r.data?.data || { ...(done || {}), [t.id]: { version: t.version } })
    } catch { setDone((d) => ({ ...(d || {}), [t.id]: { version: t.version } })) }
  }, [active, done])

  // Auto-start. Welcome first; then the page tour once per page per session.
  useEffect(() => {
    if (!user || done === null || active) return undefined
    const welcome = tourById('welcome')
    if (welcome && !isDone(welcome) && !startedOnPath.current.has('welcome')) {
      startedOnPath.current.add('welcome')
      const t = setTimeout(() => setActive({ tour: welcome, index: 0 }), 600); return () => clearTimeout(t)
    }
    if (welcome && !isDone(welcome)) return undefined
    const pt = tourForPath(location.pathname)
    if (pt && canView(pt.path) && !isDone(pt) && !startedOnPath.current.has(pt.id)) {
      startedOnPath.current.add(pt.id)
      const t = setTimeout(() => setActive({ tour: pt, index: 0 }), 900)
      return () => clearTimeout(t)
    }
    return undefined
  }, [user?.id, done, location.pathname, active, isDone, canView])

  const value = useMemo(() => ({ startTour, tours, done: done || {}, active, doneVersion, isDone, pageTour: tourForPath(location.pathname) }), [startTour, tours, done, active, doneVersion, isDone, location.pathname])
  return (
    <TourContext.Provider value={value}>
      {children}
      {active && <TourOverlay tour={active.tour} index={active.index} setIndex={(i) => setActive((a) => (a ? { ...a, index: i } : a))} onFinish={finish} />}
    </TourContext.Provider>
  )
}

function TourOverlay({ tour, index, setIndex, onFinish }) {
  const [rect, setRect] = useState(null)
  const [tick, setTick] = useState(0)
  const steps = tour.steps
  // Steps whose target is on screen. Re-evaluated on every render tick, so a
  // step never shows an empty spotlight.
  const present = useMemo(() => steps.map((s) => visible(document.querySelector(s.target))), [steps, tick]) // eslint-disable-line react-hooks/exhaustive-deps
  const order = present.map((ok, i) => (ok ? i : -1)).filter((i) => i >= 0)
  useEffect(() => { if (order.length === 0) onFinish(null) }, [order.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const pos = Math.max(0, order.indexOf(index))
  const stepIdx = order[pos] ?? 0
  const step = steps[stepIdx]
  const measure = useCallback(() => {
    const el = step ? document.querySelector(step.target) : null
    if (!el || !visible(el)) { setRect(null); return }
    const r = el.getBoundingClientRect()
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
  }, [step])
  useLayoutEffect(() => {
    const el = step ? document.querySelector(step.target) : null
    if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch { /* jsdom */ } }
    const t = setTimeout(measure, 320); measure()
    const onChange = () => { measure(); setTick((x) => x + 1) }
    window.addEventListener('resize', onChange); window.addEventListener('scroll', onChange, true)
    return () => { clearTimeout(t); window.removeEventListener('resize', onChange); window.removeEventListener('scroll', onChange, true) }
  }, [measure, step])
  const next = () => { if (pos + 1 >= order.length) onFinish(true); else setIndex(order[pos + 1]) }
  const back = () => { if (pos > 0) setIndex(order[pos - 1]) }
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onFinish(false); else if (e.key === 'ArrowRight' || e.key === 'Enter') next(); else if (e.key === 'ArrowLeft') back() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }) // eslint-disable-line react-hooks/exhaustive-deps
  if (!step) return null
  const pad = 8
  const vw = window.innerWidth || 1200, vh = window.innerHeight || 800
  const below = rect ? rect.top + rect.height + 16 + 190 < vh : true
  const cardTop = rect ? (below ? rect.top + rect.height + 14 : Math.max(12, rect.top - 14 - 200)) : vh / 2 - 100
  const cardLeft = rect ? Math.min(Math.max(12, rect.left), Math.max(12, vw - 372)) : vw / 2 - 180
  return (
    <div className="fixed inset-0 z-[200]" data-tour-overlay data-tour-id={tour.id} data-tour-step={stepIdx} aria-live="polite">
      {rect ? (
        <div className="absolute rounded-lg pointer-events-none transition-all duration-200" data-tour-spotlight
          style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2, boxShadow: '0 0 0 9999px rgba(17, 24, 39, 0.55)', outline: '2px solid rgba(255,255,255,0.9)' }} />
      ) : <div className="absolute inset-0 bg-gray-900/55" />}
      <div className="absolute w-[360px] max-w-[calc(100vw-24px)] bg-card border border-rule rounded-xl shadow-2xl p-4" style={{ top: cardTop, left: cardLeft }} data-tour-card role="dialog" aria-label={step.title}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{tour.title} · {pos + 1} of {order.length}</p>
            <h3 className="text-sm font-semibold text-gray-900 mt-0.5">{step.title}</h3>
          </div>
          <button onClick={() => onFinish(false)} className="text-gray-400 hover:text-gray-700 p-1 -m-1 rounded" aria-label="Skip the tour" data-tour-skip><X size={14} /></button>
        </div>
        <p className="text-[13px] text-gray-600 mt-2 leading-relaxed">{step.body}</p>
        <div className="flex items-center justify-between mt-4">
          <button onClick={() => onFinish(false)} className="text-xs text-gray-400 hover:text-gray-700">Skip</button>
          <div className="flex items-center gap-1.5">
            {pos > 0 && <button onClick={back} className="inline-flex items-center gap-1 text-xs font-semibold border border-rule rounded-lg px-2.5 py-1.5 hover:bg-gray-50" data-tour-back><ChevronLeft size={12} /> Back</button>}
            <button onClick={next} className="inline-flex items-center gap-1 text-xs font-semibold bg-gray-900 text-white rounded-lg px-3 py-1.5 hover:bg-gray-800" data-tour-next>{pos + 1 >= order.length ? 'Done' : 'Next'} {pos + 1 < order.length && <ChevronRight size={12} />}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
