// The Home page's data, stubbed at the api boundary. Scenario picked by
// window.__HOME_SCENARIO__ (set by the entry before render):
//
//   admin   every loop section present, real-looking numbers
//   anr     the server withheld every money section (null) — only releases
//   empty   every section present and ZERO — the empty sentences must show
//   down    /dashboard/loop fails — the tiles must not render as zeros
export const calls = { get: [], post: [], put: [], del: [] }

const scenario = () => globalThis.__HOME_SCENARIO__ || 'admin'
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
  },
  anr: {
    approvals: null, payments: null, bank: null,
    releases:  { count: 3, under_half: 1, next: { id: 9, project_name: 'Night Drive', artist_name: 'Rosa Vale', release_date: '2026-09-25' }, to: '/releases' },
    onboarding: { count: 2, steps_open: 5, next: { id: 12, name: 'Rosa Vale', open: 3 }, to: '/artists?onboarding=1' },
  },
  empty: {
    approvals: { count: 0, usd: 0, oldest_days: null, to: '/bk/approvals' },
    payments:  { count: 0, usd: 0, rush: 0, overdue: 0, to: '/bk/payments' },
    bank:      { open: 0, open_usd: 0, accounts: [], overdue_accounts: [], to: '/bk/statements' },
    releases:  { count: 0, under_half: 0, next: null, to: '/releases' },
    onboarding: { count: 0, steps_open: 0, next: null, to: '/artists?onboarding=1' },
  },
}

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
    if (url.startsWith('/dashboard/notifications')) return ok([])
    if (url.startsWith('/dashboard/activity')) return ok([])
    if (url.startsWith('/team/my-work')) return ok({ tasks: [{ id: 1, status: 'To Do', due_date: null }, { id: 2, status: 'Done', due_date: null }] })
    if (url.startsWith('/releases')) return ok([])
    if (url.startsWith('/statements')) return ok({ statements: [], months: [] })
    return ok([])
  },
  post(url, body) { calls.post.push({ url, body }); return ok({}) },
  put(url, body) { calls.put.push({ url, body }); return ok({}) },
  delete(url) { calls.del.push(url); return ok({}) },
}
export default api
