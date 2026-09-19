// The simple artist budget sheet's data, stubbed at the api boundary, plus a
// record of every write so the harness can assert what a typed cell posts.
export const calls = { get: [], post: [], put: [], del: [] }
const ok = (data) => Promise.resolve({ data: { success: true, data } })

const line = (budget, spent, open = 0) => ({
  budget, spent, open, left: Math.round((budget - spent) * 100) / 100,
  count: spent ? 1 : 0, open_count: open ? 1 : 0, over: budget > 0 && spent > budget,
})

export const STATE = {
  artist_key: 'rosavale',
  artist: 'Rosa Vale',
  advance: line(25000, 25000),
  marketing: {
    ...line(40000, 18200, 3000),
    allocated: 30000, unallocated: 10000, over_allocated: false,
    releases: [
      { release_id: 9, title: 'Night Drive', release_date: '2026-09-25', ...line(20000, 12400, 3000) },
      { release_id: 7, title: 'Late Message', release_date: '2026-06-12', ...line(10000, 5800) },
    ],
    unassigned: line(0, 0, 0),
  },
  other: { ...line(0, 1250), categories: [{ category: 'Tour/Live', spent: 1250 }] },
  totals: { budget: 65000, spent: 44450, open: 3000, left: 20550, over: false },
}

// An artist with nothing at all — the "New budget" landing state.
export const EMPTY = {
  artist_key: 'newkid', artist: 'newkid',
  advance: line(0, 0), marketing: { ...line(0, 0), allocated: 0, unallocated: 0, over_allocated: false, releases: [], unassigned: line(0, 0) },
  other: { ...line(0, 0), categories: [] },
  totals: { budget: 0, spent: 0, open: 0, left: 0, over: false },
}

const scenario = () => globalThis.__SIMPLE_SCENARIO__ || 'full'
// Writes mutate the stub so the reload after a save shows the new value.
const state = () => (scenario() === 'empty' ? EMPTY : STATE)

const api = {
  get(url) {
    calls.get.push(url)
    if (/\/artist-budgets\/[^/]+\/simple/.test(url)) return ok(state())
    return ok([])
  },
  put(url, body) {
    calls.put.push({ url, body })
    const st = state()
    if (/\/advance$/.test(url)) { st.advance = { ...st.advance, budget: body.amount, left: body.amount - st.advance.spent }; st.totals.budget = st.advance.budget + st.marketing.budget }
    if (/\/marketing$/.test(url)) { st.marketing = { ...st.marketing, budget: body.amount, left: body.amount - st.marketing.spent, unallocated: body.amount - st.marketing.allocated, over_allocated: st.marketing.allocated > body.amount }; st.totals.budget = st.advance.budget + st.marketing.budget }
    if (/\/release$/.test(url)) {
      const r = st.marketing.releases.find((x) => x.release_id === body.release_id)
      if (r) { r.budget = body.amount; r.left = body.amount - r.spent }
      st.marketing.allocated = st.marketing.releases.reduce((t, x) => t + x.budget, 0)
      st.marketing.unallocated = st.marketing.budget - st.marketing.allocated
      st.marketing.over_allocated = st.marketing.budget > 0 && st.marketing.allocated > st.marketing.budget
    }
    return ok({})
  },
  post(url, body) { calls.post.push({ url, body }); return ok({}) },
  delete(url) { calls.del.push(url); return ok({}) },
}
export default api
