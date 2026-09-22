// Data for the artist-hub harness: one roster artist with a budget sheet and
// a campaigns card, stubbed at the api boundary. What the three new profile
// tabs read: GET /artists/:id (the profile), /artist-budgets/:key/simple (the
// Budget tab), /artist-campaigns (the Campaigns tab finds its own card).
export const calls = { get: [], post: [], put: [] }
const ok = (data, extra = {}) => Promise.resolve({ data: { success: true, data, ...extra } })
const line = (budget, spent, open = 0) => ({ budget, spent, open, left: budget - spent, over: spent > budget })

export const ARTIST = {
  id: 12, name: 'Rosa Vale', genre: 'Pop', status: 'Active',
  releases: [], deals: [],
  // one Active contract with the CEO's terms attached (lib/contract-terms.js shape)
  contracts: [{ id: 5, artist_id: 12, type: 'Master License', status: 'Active', date_signed: '2025-11-22', expiration_date: '2026-11-22', royalty_split: 60, advance: 10000, num_releases: 3, options_total: 2, options_exercised: 0, term_years: 1, marketing_budget: 20000, signature_status: 'signed', signature_status_manual: true, file_count: 0,
    terms: { deliverables_total: 3, delivered: 1, remaining: 2, scheduled: 0, deliverables: [], options_total: 2, options_exercised: 0, options_remaining: 2, current_period: 1, period_end: '2026-11-22', days_to_period_end: 61, artist_split: 60, label_split: 40, marketing_budget: 20000, advance: 10000, term_years: 1, signature: 'signed', signature_source: 'manual' } }], links: [], files: [], expenses: [], income: [],
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
  post(url, body) { calls.post.push(url); if (/exercise-option/.test(url)) { const c = ARTIST.contracts[0]; return ok({ ...c, options_exercised: 1, terms: { ...c.terms, options_exercised: 1, options_remaining: 1, current_period: 2, period_end: '2027-11-22', days_to_period_end: 426 } }) } return ok({}) },
  put(url, body) { calls.put.push({ url, body }); return ok({}) }, delete() { return ok({}) },
}
export default api
