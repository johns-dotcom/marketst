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
import { TOURS, tourById, tourForPath } from '../tours'

const TourContext = createContext(null)
const NOOP = { startTour: () => false, tours: [], done: {}, active: null, doneVersion: () => null, isDone: () => false, pageTour: null }
export const useTour = () => useContext(TourContext) || NOOP

const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
// A target is a comma-separated list of selectors in PREFERENCE order; the
// first selector with a VISIBLE match wins — an element hidden by a
// responsive class (display:none) has no size and does not count.
const findTarget = (target) => {
  for (const sel of String(target).split(',')) {
    const s = sel.trim(); if (!s) continue
    let list = []; try { list = document.querySelectorAll(s) } catch { list = [] }
    for (const el of list) if (visible(el)) return el
  }
  return null
}
// matchMedia as state; false where the API is missing (jsdom).
export function useMedia(query) {
  const has = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  const [m, setM] = useState(() => (has ? window.matchMedia(query).matches : false))
  useEffect(() => {
    if (!has) return undefined
    const mq = window.matchMedia(query); const h = (e) => setM(e.matches); setM(mq.matches)
    mq.addEventListener?.('change', h); return () => mq.removeEventListener?.('change', h)
  }, [query, has])
  return m
}
// Small screens: the card is a bottom sheet. The sidebar is a drawer below lg.
export const SMALL = '(max-width: 639px)'
export const DRAWER = '(max-width: 1023px)'

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
  const finish = useCallback(async (completed) => {
    const t = active?.tour; setActive(null)
    if (!t || completed === null) return
    // The welcome walk shows ONE orientation step per page; each page's own
    // tour (the deeper steps) still runs the first time that page is opened.
    // Only the page the walk ends on is held back this session, so a second
    // tour does not pounce the moment the walk closes.
    if (t.id === 'welcome') { const here = tourForPath(location.pathname); if (here) startedOnPath.current.add(here.id) }
    const batch = [{ id: t.id, version: t.version, skipped: !completed }]
    try {
      const r = await api.put('/settings/me/tours', batch.length > 1 ? { tours: batch } : batch[0])
      setDone(r.data?.data || Object.fromEntries(batch.map((b) => [b.id, { version: b.version }])))
    } catch { setDone((d) => ({ ...(d || {}), ...Object.fromEntries(batch.map((b) => [b.id, { version: b.version }])) })) }
  }, [active, done, location.pathname])

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
  const [missing, setMissing] = useState(false)   // on the page, but its anchor never rendered (no data yet)
  const small = useMedia(SMALL)
  const drawer = useMedia(DRAWER)
  const navigatedFor = useRef(null)
  // Skip this page: jump to the first later step on a different page.
  const nextPagePos = order.findIndex((idx, k) => k > pos && (steps[idx].path || tour.path) !== (step?.path || tour.path))
  // Skip this family: the first later step outside this page's family (a step with no family is its own).
  const famOf = (st) => st?.family || `page:${st?.path || tour.path}`
  const nextFamilyPos = order.findIndex((idx, k) => k > pos && famOf(steps[idx]) !== famOf(step))
  const skipFamily = () => { if (step?.path && !skippedPaths.current.includes(step.path)) skippedPaths.current.push(step.path); if (nextFamilyPos === -1) onFinish(true, skippedPaths.current); else setIndex(order[nextFamilyPos]) }
  const skippedPaths = useRef([])   // pages the person chose to skip in a multipage walk

  useEffect(() => { if (order.length === 0) onFinish(null) }, [order.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // A single-page tour whose page is LEFT (a sidebar click, a g-chord, a link)
  // closes without recording — before this it stayed up over the new page and,
  // finding no anchors there, read "appears once there is something to show",
  // which was the wrong explanation. The welcome walk drives its own navigation
  // and is excluded; it drops pages it cannot reach itself.
  useEffect(() => {
    if (tour.multipage) return
    const here = tour.match ? tour.match.test(location.pathname) : location.pathname === tour.path
    if (!here) onFinish(null)
  }, [location.pathname]) // eslint-disable-line react-hooks/exhaustive-deps

  // Go to the step's page once per step.
  useEffect(() => {
    if (!step || onPage || navigatedFor.current === stepIdx) return
    navigatedFor.current = stepIdx
    navigate(wantPath)
  }, [step, stepIdx, onPage, wantPath, navigate])

  // A step can ask the host to prepare something while it shows — today
  // `prepare: 'sidebar'` opens the mobile drawer so the sidebar is on screen.
  // Layout listens for the event; on desktop there is nothing to do.
  const prepares = !!step?.prepare && drawer
  useEffect(() => {
    if (!step?.prepare || !onPage) return undefined
    const fire = (active) => window.dispatchEvent(new CustomEvent('tour:prepare', { detail: { prepare: step.prepare, active } }))
    fire(true); return () => fire(false)
  }, [step?.prepare, stepIdx, onPage])

  // Find and measure the anchor; wait for it after a navigation; skip the
  // step if the page never renders it.
  useLayoutEffect(() => {
    if (!step) return undefined
    setMissing(false)
    if (step.target === null) { setRect(null); setWaiting(false); return undefined }
    let cancelled = false
    const started = Date.now()
    setWaiting(true)
    const tryMeasure = () => {
      if (cancelled) return
      const el = onPage ? findTarget(step.target) : null
      if (el) {
        // On a phone the sheet covers the bottom, so bring the anchor to the top.
        try { el.scrollIntoView({ block: small ? 'start' : 'center', behavior: 'smooth' }) } catch { /* jsdom */ }
        const r = el.getBoundingClientRect()
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height }); setWaiting(false)
        setTimeout(() => { if (!cancelled) { const r2 = el.getBoundingClientRect(); setRect({ top: r2.top, left: r2.left, width: r2.width, height: r2.height }) } }, 350)
        return
      }
      if (Date.now() - started > WAIT_MS()) {
        setWaiting(false); setRect(null)
        // Never reached the page (a guard sent us elsewhere): drop the whole page, not one step at a time.
        if (!onPage) { const to = nextPagePos !== -1 ? nextPagePos : order.length; if (to < order.length) setIndex(order[to]); else onFinish(true, skippedPaths.current); return }
        // On the page, anchor never rendered (it needs data): SHOW the step,
        // centered, and let the person move on themselves — never skip it.
        setMissing(true)
        return
      }
      setTimeout(tryMeasure, 150)
    }
    // A drawer takes ~200ms to slide in; measure after it has.
    if (prepares) setTimeout(tryMeasure, 260); else tryMeasure()
    const onChange = () => { const el = findTarget(step.target); if (el) { const r = el.getBoundingClientRect(); setRect({ top: r.top, left: r.left, width: r.width, height: r.height }) } }
    window.addEventListener('resize', onChange); window.addEventListener('scroll', onChange, true)
    return () => { cancelled = true; window.removeEventListener('resize', onChange); window.removeEventListener('scroll', onChange, true) }
  }, [step, stepIdx, onPage, small, prepares]) // eslint-disable-line react-hooks/exhaustive-deps

  const next = () => { if (pos + 1 >= order.length) onFinish(true, skippedPaths.current); else setIndex(order[pos + 1]) }
  const back = () => { if (pos > 0) setIndex(order[pos - 1]) }
  const skipPage = () => {
    if (step?.path && !skippedPaths.current.includes(step.path)) skippedPaths.current.push(step.path)
    if (nextPagePos === -1) onFinish(true, skippedPaths.current); else setIndex(order[nextPagePos])
  }
  useEffect(() => {
    // Keys typed into a field are not tour shortcuts. Enter on a focused
    // button or link is not either (it also clicks) — but the ARROWS are, even
    // then: clicking Next leaves focus on the Next button, and a guard that
    // dropped every key while a button had focus killed the arrows after the
    // first click (John, 2026-09-20: "allow the arrow keys to go through the
    // walkthroughs"). Arrows never mean anything to a button, so they are safe.
    const onKey = (e) => {
      const el = e.target
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return
      const onControl = !!(el && /^(BUTTON|A)$/.test(el.tagName))
      if (e.key === 'Escape') onFinish(false)
      else if (e.key === 'ArrowRight') { e.preventDefault(); if (!waiting) next() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); back() }
      else if (e.key === 'Enter' && !onControl && !waiting) next()
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }) // eslint-disable-line react-hooks/exhaustive-deps
  if (!step) return null
  const pad = 8
  const vw = window.innerWidth || 1200, vh = window.innerHeight || 800
  const spot = rect && step.target !== null && !waiting && !missing
  // Where this step sits within its page, for the multipage counter.
  const samePage = order.filter((idx) => (steps[idx].path || tour.path) === (step.path || tour.path))
  const pagePos = samePage.indexOf(stepIdx) + 1
  const below = spot ? rect.top + rect.height + 16 + 200 < vh : true
  const cardTop = spot ? (below ? rect.top + rect.height + 14 : Math.max(12, rect.top - 14 - 210)) : Math.max(24, vh / 2 - 120)
  const cardLeft = spot ? Math.min(Math.max(12, rect.left), Math.max(12, vw - 372)) : Math.max(12, vw / 2 - 180)
  const pageLabel = (step.familyLabel && step.page && step.familyLabel !== step.page ? `${step.familyLabel} › ${step.page}` : step.page) || (wantPath ? ({ '/': 'Home' }[wantPath] || wantPath.replace(/^\//, '').replace(/^bk\//, '').replace(/-/g, ' ')) : null)
  return (
    <div className="fixed inset-0 z-[200]" data-tour-overlay data-tour-id={tour.id} data-tour-step={stepIdx} data-tour-waiting={waiting ? '1' : '0'} data-tour-anchor-missing={missing ? '1' : '0'} aria-live="polite">
      {spot ? (
        <div className="absolute rounded-lg pointer-events-none transition-all duration-200" data-tour-spotlight
          style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2, boxShadow: '0 0 0 9999px rgba(17, 24, 39, 0.55)', outline: '2px solid rgba(255,255,255,0.9)' }} />
      ) : <div className="absolute inset-0 bg-gray-900/55" />}
      <div className={small
        ? 'fixed inset-x-0 bottom-0 bg-card border-t border-rule rounded-t-2xl shadow-2xl p-4 pb-[max(1rem,env(safe-area-inset-bottom))]'
        : 'absolute w-[360px] max-w-[calc(100vw-24px)] bg-card border border-rule rounded-xl shadow-2xl p-4'}
        style={small ? undefined : { top: cardTop, left: cardLeft }} data-tour-card data-tour-sheet={small ? '1' : '0'} role="dialog" aria-label={step.title}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider" data-tour-counter>{tour.title} · {pos + 1} of {order.length}{tour.multipage && pageLabel ? ` · ${pageLabel}${samePage.length > 1 ? ` ${pagePos} of ${samePage.length}` : ''}` : ''}</p>
            <h3 className="text-sm font-semibold text-gray-900 mt-0.5">{step.title}</h3>
          </div>
          <button onClick={() => onFinish(false)} className="text-gray-400 hover:text-gray-700 p-1 -m-1 rounded" aria-label="Skip the tour" data-tour-skip><X size={14} /></button>
        </div>
        {waiting
          ? <p className="text-[13px] text-gray-500 mt-2 inline-flex items-center gap-2" data-tour-loading><Loader size={12} className="animate-spin" /> Opening {pageLabel || 'the page'}…</p>
          : <p className="text-[13px] text-gray-600 mt-2 leading-relaxed">{step.body}</p>}
        {missing && !waiting && <p className="text-[11px] text-amber-700 mt-2 inline-flex items-center gap-1.5" data-tour-missing><Loader size={11} /> This part of the page appears once there is something to show here.</p>}
        <div className="flex items-center justify-between mt-4 gap-2 flex-wrap">
          <div className="flex items-center gap-3 sm:gap-2">
            <button onClick={() => onFinish(false)} className="text-xs text-gray-400 hover:text-gray-700" data-tour-skip-all>Skip tour</button>
            {tour.multipage && nextPagePos !== -1 && <button onClick={skipPage} className="text-xs text-gray-400 hover:text-gray-700 inline-flex items-center gap-1" data-tour-skip-page><SkipForward size={11} /> Skip this page</button>}
            {tour.multipage && step?.family && nextFamilyPos !== -1 && nextFamilyPos !== nextPagePos && <button onClick={skipFamily} className="text-xs text-gray-400 hover:text-gray-700 inline-flex items-center gap-1" data-tour-skip-family><SkipForward size={11} /> Skip {step.familyLabel || 'this family'}</button>}
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
