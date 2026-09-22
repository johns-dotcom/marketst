// The Home page's data, stubbed at the api boundary. Scenario picked by
// window.__HOME_SCENARIO__ (set by the entry before render):
//
//   admin   every loop section present, real-looking numbers
//   anr     the server withheld every money section (null) — only releases
//   empty   every section present and ZERO — the empty sentences must show
//   down    /dashboard/loop fails — the tiles must not render as zeros
export const calls = { get: [], post: [], put: [], del: [] }

const scenario = () => globalThis.__HOME_SCENARIO__ || 'admin'
// The CEO's alerts (GET /dashboard/alerts): one release gap, one option period ending
const DEAL_ALERTS = [
  { kind: 'release_gap', key: '12', artist_id: 12, artist: 'Rosa Vale', severity: 'high', to: '/artists/12', title: 'Rosa Vale: no release in 4 months', detail: 'last release 2026-05-20 · 2 deliverables remaining', days: 125 },
  { kind: 'option_expiring', key: '5', artist_id: 12, artist: 'Rosa Vale', severity: 'medium', to: '/contracts?focus=5', title: 'Rosa Vale: option period ends in 61 days', detail: 'Master License · period 1 of 3 ends 2026-11-22 · 2 options left to exercise', days: 61 },
]
const ok = (data) => Promise.resolve({ data: { success: true, data } })

const LOOP = {
  admin: {
    approvals: { count: 7, usd: 18420, oldest_days: 4, to: '/bk/approvals' },
    payments:  { count: 5, usd: 12900, rush: 2, overdue: 1, to: '/bk/payments' },
    bank:      { open: 23, open_usd: 41005.5, to: '/bk/bank-matching',
                 accounts: [{ account: 'bofa', statements: 3, overdue: true, days_since: 41, expected_by: '2026-09-05', cadence_days: 31, last_period_end: '2026-08-08' }],
                 overdue_accounts: ['bofa'] },
    releases:  { count: 3, under_half: 1, next: { id: 9, project_name: 'Night Drive', artist_name: 'Rosa Vale', release_date: '2026-09-25' }, to: '/releases' },
    onboarding: { count: 2, steps_open: 5, next: { id: 12, name: 'Rosa Vale', open: 3 }, to: '/artists?onboarding=1' },
    flags:     { count: 6, high: 2, new: 3, usd: 4200, oldest_days: 9, setup: 1, swept_at: new Date().toISOString(), to: '/flags' },
  },
  anr: {
    approvals: null, payments: null, bank: null,
    releases:  { count: 3, under_half: 1, next: { id: 9, project_name: 'Night Drive', artist_name: 'Rosa Vale', release_date: '2026-09-25' }, to: '/releases' },
    onboarding: { count: 2, steps_open: 5, next: { id: 12, name: 'Rosa Vale', open: 3 }, to: '/artists?onboarding=1' },
    flags: null,
  },
  empty: {
    approvals: { count: 0, usd: 0, oldest_days: null, to: '/bk/approvals' },
    payments:  { count: 0, usd: 0, rush: 0, overdue: 0, to: '/bk/payments' },
    bank:      { open: 0, open_usd: 0, accounts: [], overdue_accounts: [], to: '/bk/statements' },
    releases:  { count: 0, under_half: 0, next: null, to: '/releases' },
    onboarding: { count: 0, steps_open: 0, next: null, to: '/artists?onboarding=1' },
    flags:     { count: 0, high: 0, new: 0, usd: 0, oldest_days: null, setup: 0, swept_at: new Date().toISOString(), to: '/flags' },
  },
}

const now = new Date()
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const plus = (n) => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n))
// The calendar feed: two inside the week, one beyond it, one yesterday.
const CAL = { events: [
  { id: 'release-9', type: 'release', title: 'Night Drive', subtitle: 'Rosa Vale', date: plus(2), meta: 'Single', to: '/releases' },
  { id: 'payment-77', type: 'payment_due', title: 'Northgate Studios — $1,500 due', date: plus(5), meta: 'Rush', to: '/bk/payments' },
  { id: 'task-3', type: 'deadline', title: 'Send the artwork', date: plus(0), meta: 'High', to: '/my-work' },
  { id: 'contract-exp-5', type: 'contract_expiry', title: 'Rosa Vale — Recording expires', date: plus(12), to: '/renewals' },
  { id: 'event-1', type: 'manual', title: 'Yesterday thing', date: plus(-1), deletable: true },
], sources: { releases: true, contracts: true, renewals: true, payments: true, tasks: 'team' } }
// Activity: rows by me (user 1) and by a teammate (user 2)
const ACTIVITY = [
  { id: 1, user_id: 2, user_name: 'Sam Chen', action: 'Approved invoice', detail: 'Northgate Studios $1,500', created_at: new Date(now.getTime() - 5 * 60000).toISOString() },
  { id: 2, user_id: 1, user_name: 'John', action: 'Added release', detail: 'Night Drive', created_at: new Date(now.getTime() - 9 * 60000).toISOString() },
  { id: 3, user_id: 2, user_name: 'Sam Chen', action: 'Signed deal', detail: 'Rosa Vale', created_at: new Date(now.getTime() - 3 * 3600000).toISOString() },
]
const ALERTS = [{ type: 'Release checklist', message: 'Night Drive releases in 2 days with 3 of 14 items done', severity: 'critical' }]

const STATS = {
  totalArtists: 0, totalReleases: 0, upcomingReleases: 0, teamMembers: 1,
  releasesByMonth: [], releasesByGenre: [], thisWeek: [], nextWeek: [],
  selectedYear: 2026, availableYears: [], availableGenres: [], availableFormats: [],
}

const api = {
  get(url) {
    calls.get.push(url)
    if (url.startsWith('/dashboard/loop')) {
      if (scenario() === 'down') return Promise.reject(new Error('loop down'))
      return ok(LOOP[scenario()])
    }
    if (url.startsWith('/dashboard/stats')) return ok(STATS)
    if (url.startsWith('/dashboard/alerts')) return scenario() === 'down' ? Promise.reject(new Error('alerts down')) : ok(scenario() === 'admin' ? DEAL_ALERTS : [])
    if (url.startsWith('/dashboard/notifications')) return ok(scenario() === 'admin' ? ALERTS : [])
    if (url.startsWith('/dashboard/activity')) return ok(scenario() === 'anr' || scenario() === 'empty' ? [] : ACTIVITY)
    if (url.startsWith('/calendar')) return scenario() === 'down' ? Promise.reject(new Error('cal down')) : Promise.resolve({ data: scenario() === 'empty' ? { events: [], sources: CAL.sources } : CAL })
    if (url.startsWith('/team/my-work')) return ok({ tasks: scenario() === 'empty' ? [] : [{ id: 1, status: 'To Do', due_date: null }, { id: 2, status: 'Done', due_date: null }] })
    if (url.startsWith('/releases')) return ok([])
    if (url.startsWith('/statements')) return ok({ statements: [], months: [] })
    return ok([])
  },
  post(url, body) { calls.post.push({ url, body }); return ok({}) },
  put(url, body) { calls.put.push({ url, body }); return ok({}) },
  delete(url) { calls.del.push(url); return ok({}) },
}
export default api
