// Data for the onboarding harness: one signed artist mid-onboarding, one
// onboarded, and the roster list with both. Scenario `open` (default) and
// `complete`; `noemail` has no artist email so the payment step asks for one.
export const calls = { get: [], post: [], put: [] }
const ok = (data) => Promise.resolve({ data: { success: true, data } })
const scenario = () => globalThis.__ONB_SCENARIO__ || 'open'

const step = (key, label, done, detail, to, to_label, extra = {}) => ({ key, label, done, detail, to, to_label, ...extra })
export const OPEN = {
  artist_id: 12, name: 'Rosa Vale', email: 'rosa@example.test', signed_at: '2026-09-18T10:00:00Z', onboarded_at: null,
  deal: { id: 5, advance: 25000, deal_type: 'Master License', term_months: 24, royalty_split: 50 },
  steps: [
    step('contract', 'Contract on file', true, 'Licensing · to 2028', '/contracts', 'Open'),
    step('payment', 'Payment details and W-9', false, 'No payment details · No W-9', '/artists/12', 'Send link or type in', { on_file: false, w9: false, email: 'rosa@example.test' }),
    step('advance', 'Advance paid', false, '$25,000 due 2026-10-18', '/bk/payments', 'Payments'),
    step('budget', 'Budget set', true, '$25,000 · $40,000', '/artist-budgets/rosavale?name=Rosa%20Vale', 'Open the sheet'),
    step('release', 'First release in the pipeline', false, 'No release yet', '/releases?add=1&artist=Rosa%20Vale', 'Add release'),
  ],
  open: 3, total: 5, complete: false,
}
export const DONE = { ...OPEN, onboarded_at: '2026-10-02T09:00:00Z', steps: OPEN.steps.map((s) => ({ ...s, done: true })), open: 0, complete: true }
export const NOEMAIL = { ...OPEN, email: null, steps: OPEN.steps.map((s) => (s.key === 'payment' ? { ...s, detail: "Add the artist's email first", email: null } : s)) }
export const ARTIST = { id: 12, name: 'Rosa Vale', genre: 'Pop', releases: [], contracts: [], deals: [], links: [], files: [], expenses: [], income: [], totalExpenses: 0, budget: null, signed_at: '2026-09-18T10:00:00Z' }
export const ROSTER = [{ id: 12, name: 'Rosa Vale', genre: 'Pop', total_releases: 0 }, { id: 13, name: 'Darci', genre: 'Pop', total_releases: 4 }]

const api = {
  get(url) {
    calls.get.push(url)
    if (url === '/artists/onboarding') return ok(scenario() === 'complete' ? [] : [OPEN])
    if (/^\/artists\/12\/onboarding/.test(url)) return ok(scenario() === 'complete' ? DONE : scenario() === 'noemail' ? NOEMAIL : OPEN)
    if (/^\/artists\/12\/devlog/.test(url)) return ok([])
    if (/^\/artists\/12/.test(url)) return ok(ARTIST)
    if (url.startsWith('/artists')) return Promise.resolve({ data: { success: true, data: ROSTER, total: 2 } })
    return ok([])
  },
  post(url, body) { calls.post.push({ url, body }); if (/payment-details/.test(url)) return ok({ on_file: true, method: body.payment_method, last4: '4421' }); return ok({}) },
  put(url, body) { calls.put.push({ url, body }); return ok({ id: 12, email: body.email || null }) },
  delete() { return ok({}) },
}
export default api
