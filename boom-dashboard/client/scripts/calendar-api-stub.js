// Data for the calendar harness: one event of every type within the current
// month, plus the server's `sources` block. Scenario `gated` withholds
// payments and narrows tasks to the caller's own; `empty` has nothing.
export const calls = { get: [], post: [], del: [] }
const ok = (data) => Promise.resolve({ data })
const now = new Date()
const iso = (day) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

export const EVENTS = [
  { id: 'release-9', type: 'release', title: 'Night Drive', subtitle: 'Rosa Vale', date: iso(12), meta: 'Single', sourceId: 9, to: '/releases' },
  { id: 'task-3', type: 'deadline', title: 'Send the artwork', subtitle: null, date: iso(12), meta: 'High', sourceId: 3, to: '/my-work' },
  { id: 'task-4', type: 'deadline', title: 'Book the studio', subtitle: 'Assigned to Sam', date: iso(14), meta: 'Medium', sourceId: 4, to: '/team/2' },
  { id: 'payment-77', type: 'payment_due', title: 'Northgate Studios — $1,500 due', subtitle: 'Rosa Vale · Night Drive', date: iso(15), meta: 'Rush', sourceId: 77, to: '/bk/payments' },
  { id: 'contract-exp-5', type: 'contract_expiry', title: 'Rosa Vale — Recording expires', subtitle: null, date: iso(20), sourceId: 5, to: '/renewals' },
  { id: 'contract-sign-5', type: 'contract_signed', title: 'Rosa Vale — Recording signed', subtitle: null, date: iso(2), sourceId: 5, to: '/contracts' },
  { id: 'dsp-live-1', type: 'dsp_live', title: 'Night Drive — live on Spotify', subtitle: 'Rosa Vale', date: iso(12), sourceId: 9, to: '/releases' },
  { id: 'event-1', type: 'manual', title: 'Team offsite', subtitle: null, date: iso(22), sourceId: 1, deletable: true },
]
const FULL = { events: EVENTS, sources: { releases: true, contracts: true, renewals: true, payments: true, tasks: 'team' } }
const GATED = { events: EVENTS.filter((e) => e.type !== 'payment_due' && e.id !== 'task-4'), sources: { releases: true, contracts: false, renewals: true, payments: false, tasks: 'own' } }
const EMPTY = { events: [], sources: FULL.sources }

const scenario = () => globalThis.__CAL_SCENARIO__ || 'full'
const api = {
  get(url) {
    calls.get.push(url)
    if (url.startsWith('/calendar')) return ok(scenario() === 'gated' ? GATED : scenario() === 'empty' ? EMPTY : FULL)
    return ok({ success: true, data: [] })
  },
  post(url, body) { calls.post.push({ url, body }); return ok({ id: 99, ...body }) },
  delete(url) { calls.del.push(url); return ok({ success: true }) },
}
export default api
