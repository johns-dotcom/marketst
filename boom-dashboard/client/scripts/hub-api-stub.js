// Data for the artist-hub harness: one roster artist with a budget sheet and
// a campaigns card, stubbed at the api boundary. What the three new profile
// tabs read: GET /artists/:id (the profile), /artist-budgets/:key/simple (the
// Budget tab), /artist-campaigns (the Campaigns tab finds its own card).
export const calls = { get: [] }
const ok = (data, extra = {}) => Promise.resolve({ data: { success: true, data, ...extra } })
const line = (budget, spent, open = 0) => ({ budget, spent, open, left: budget - spent, over: spent > budget })

export const ARTIST = {
  id: 12, name: 'Rosa Vale', genre: 'Pop', status: 'Active',
  releases: [], contracts: [], deals: [], links: [], files: [], expenses: [], income: [],
  totalExpenses: 0, budget: null,
}
export const SHEET = {
  artist_key: 'rosavale', artist: 'Rosa Vale', artist_id: 12,
  advance: line(25000, 25000),
  marketing: { ...line(40000, 18200, 3000), allocated: 30000, unallocated: 10000, over_allocated: false,
    releases: [{ release_id: 9, title: 'Night Drive', release_date: '2026-09-25', ...line(20000, 12400, 3000) }],
    unassigned: line(0, 0, 0) },
  other: { ...line(0, 1250), categories: [{ category: 'Tour/Live', spent: 1250 }] },
  totals: { budget: 65000, spent: 44450, open: 3000, left: 20550, over: false },
}
export const CAMPAIGNS = { artists: [
  { artist_key: 'rosavale', artist: 'Rosa Vale', settled: 18200, committed: 3000, committed_count: 1, committed_unpaid: 3000, planned_budget: 40000 },
  { artist_key: 'darci', artist: 'Darci', settled: 900, committed: 0, committed_count: 0, planned_budget: 0 },
] }

const scenario = () => globalThis.__HUB_SCENARIO__ || 'full'
const api = {
  get(url) {
    calls.get.push(url)
    if (/^\/artists\/12\/devlog/.test(url)) return ok([])
    if (/^\/artists\/12/.test(url)) return ok(ARTIST)
    if (/\/artist-budgets\/rosavale\/simple/.test(url)) return ok(SHEET)
    if (/^\/artist-campaigns(\?|$)/.test(url)) return ok(scenario() === 'nocampaign' ? { artists: [CAMPAIGNS.artists[1]] } : CAMPAIGNS)
    return ok([])
  },
  post() { return ok({}) }, put() { return ok({}) }, delete() { return ok({}) },
}
export default api
