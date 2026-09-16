// A stubbed api for scripts/budgetsheet-dom-entry.jsx.
//
// Fixtured, not proxied, because every assertion about this grid is arithmetic
// the fixture has to KNOW the answer to in advance — what the totals row sums to
// after a filter, which rows a sort reorders, which cells a pasted column lands
// on. Live data moves every time a statement is uploaded.
//
// The numbers are chosen so the wrong answers are DIFFERENT numbers:
//   · the filtered total (3,700 spent) differs from the sheet total (4,350), so
//     a totals row that ignores the filter is visibly wrong rather than equal
//   · `label` carries a LEGACY section budget and no category, so a filter that
//     drops it silently loses 777 of budget
//   · `campaign` is inside budget on SPEND and over it on COMMITMENT, which is
//     the one case where variance and over-committed disagree
//   · spend and budget rank sections differently, so a sort proves it sorted
export const calls = { get: [], post: [], put: [], del: [] }

const cat = (section, category, budget, spent, open, count = 0, inCatalog = true) => {
  const committed = Math.round((spent + open) * 100) / 100
  return {
    section, category, budget, spent, open, committed,
    variance: Math.round((budget - spent) * 100) / 100,
    pct: budget > 0 ? Math.round((spent / budget) * 100) : null,
    count, open_count: open > 0 ? 1 : 0,
    note: null, updated_at: null, updated_by_name: null,
    unplanned: budget === 0 && committed > 0,
    over_committed: budget > 0 && committed > budget,
    in_catalog: inCatalog,
  }
}

const section = (key, label, cats, legacy = 0) => {
  const sum = (f) => Math.round(cats.reduce((t, c) => t + c[f], 0) * 100) / 100
  const budget = Math.round((sum('budget') + legacy) * 100) / 100
  const spent = sum('spent'); const open = sum('open')
  const committed = Math.round((spent + open) * 100) / 100
  return {
    key, label, budget, legacy_budget: legacy, note: null,
    updated_at: null, updated_by_name: null,
    spent, open, committed,
    variance: Math.round((budget - spent) * 100) / 100,
    pct: budget > 0 ? Math.round((spent / budget) * 100) : null,
    count: cats.reduce((t, c) => t + c.count, 0),
    open_count: cats.reduce((t, c) => t + c.open_count, 0),
    verified: spent, awaiting: 0, unverified: 0, unpaid: open,
    over_committed: budget > 0 && committed > budget,
    unplanned: budget === 0 && committed > 0,
    budgeted_count: cats.filter((c) => c.budget > 0).length,
    active_count: cats.filter((c) => c.budget > 0 || c.committed > 0).length,
    categories: cats,
  }
}

// 3,000 budget against 3,500 spent — Marketing is over on SPEND.
// Campaign as a whole is 4,000 against 3,750: under on spend, over once the 300
// of open invoices land. Variance positive, over_committed true.
const SECTIONS = [
  section('campaign', 'Campaign & promotion', [
    cat('campaign', 'Marketing', 3000, 3500, 200, 2),
    cat('campaign', 'Advertisements', 1000, 0, 0, 0),
    cat('campaign', 'Distribution', 0, 250, 100, 1),
  ]),
  section('record', 'Making the record', [
    cat('record', 'Recording', 0, 0, 0, 0),
    cat('record', 'Services', 500, 200, 0, 1),
  ]),
  section('artist', 'The artist', [
    cat('artist', 'Advance', 0, 400, 0, 1),
  ]),
  section('people', 'People & partners', [
    cat('people', 'Salary', 0, 0, 0, 0),
  ]),
  // No category row at all — its only money is a section budget typed before the
  // budget moved down a level. A filter must not be able to lose it.
  section('label', 'Running the label', [], 777),
]

const ROWS = [
  { id: 1, section: 'campaign', budget_category: 'Marketing', payee: 'Marquee Media', song: 'Red Eye',
    category: 'Marketing', amount: 3000, currency: 'USD', amount_usd_calc: 3000, is_open: false,
    payment_status: 'Paid', payment_date: '2026-05-04', invoice_date: '2026-04-28',
    bank_evidence: { txn_id: 9 }, bank_expected: true },
  { id: 2, section: 'campaign', budget_category: 'Marketing', payee: 'Showcase PR', song: null,
    category: 'Marketing', amount: 500, currency: 'USD', amount_usd_calc: 500, is_open: false,
    payment_status: 'Paid', payment_date: '2026-05-09', invoice_date: '2026-05-01',
    bank_evidence: null, bank_expected: false },
  { id: 3, section: 'campaign', budget_category: 'Marketing', payee: 'Late Vendor', song: null,
    category: 'Marketing', amount: 200, currency: 'USD', amount_usd_calc: 200, is_open: true,
    payment_status: 'Pending', payment_date: null, invoice_date: '2026-03-02',
    bank_evidence: null, bank_expected: false },
  { id: 4, section: 'campaign', budget_category: 'Distribution', payee: 'Distro Co', song: null,
    category: 'Distribution', amount: 250, currency: 'USD', amount_usd_calc: 250, is_open: false,
    payment_status: 'Paid', payment_date: '2026-06-01', invoice_date: '2026-05-20',
    bank_evidence: { txn_id: 11 }, bank_expected: true },
  { id: 5, section: 'campaign', budget_category: 'Distribution', payee: 'Distro Co', song: null,
    category: 'Distribution', amount: 100, currency: 'USD', amount_usd_calc: 100, is_open: true,
    payment_status: 'Pending', payment_date: null, invoice_date: '2026-06-10',
    bank_evidence: null, bank_expected: false },
  { id: 6, section: 'record', budget_category: 'Services', payee: 'Studio Hand', song: null,
    category: 'Services', amount: 200, currency: 'USD', amount_usd_calc: 200, is_open: false,
    payment_status: 'Paid', payment_date: '2026-02-11', invoice_date: '2026-02-01',
    bank_evidence: { txn_id: 3 }, bank_expected: true },
  { id: 7, section: 'artist', budget_category: 'Advance', payee: 'The Artist', song: null,
    category: 'Advance', amount: 400, currency: 'USD', amount_usd_calc: 400, is_open: false,
    payment_status: 'Paid', payment_date: '2026-01-15', invoice_date: '2026-01-10',
    bank_evidence: { txn_id: 1 }, bank_expected: true },
]

const sum = (f) => Math.round(SECTIONS.reduce((t, s) => t + s[f], 0) * 100) / 100

// ── The other partition ─────────────────────────────────────────────────────
// Deliberately NOT equal to the category budget: the two grains are the same
// money sliced two ways, and the page has to say so rather than pick a winner.
// The residual is bigger than every release put together, which is the live
// shape — 56% of an artist's spend names no release.
const RELEASES = [
  { release_id: 11, title: 'Red Eye', release_date: '2026-04-01', sheet_total: 2500,
    budget: 2000, spent: 1800, open: 0, committed: 1800, variance: 200, pct: 90,
    count: 2, open_count: 0, note: null, updated_at: null, updated_by_name: null,
    unplanned: false, over_committed: false },
  { release_id: 12, title: 'Last Call', release_date: null, sheet_total: null,
    budget: 0, spent: 450, open: 200, committed: 650, variance: 0, pct: null,
    count: 1, open_count: 1, note: null, updated_at: null, updated_by_name: null,
    unplanned: true, over_committed: false },
]
const UNASSIGNED = {
  release_id: null, title: 'No release named', budget: 0,
  spent: 2100, open: 100, committed: 2200, variance: 0, pct: null,
  count: 4, open_count: 1, unplanned: true, over_committed: false, read_only: true,
}

const SHEET = {
  artist_key: 'demoartist', artist: 'Demo Artist',
  sections: SECTIONS,
  releases: RELEASES,
  unassigned_release: UNASSIGNED,
  release_totals: {
    budget: 2000,
    spent: RELEASES.reduce((t, r) => t + r.spent, 0) + UNASSIGNED.spent,
    open: RELEASES.reduce((t, r) => t + r.open, 0) + UNASSIGNED.open,
    committed: RELEASES.reduce((t, r) => t + r.committed, 0) + UNASSIGNED.committed,
    with_budget: 1, releases: RELEASES.length, unassigned_spent: UNASSIGNED.spent,
  },
  rows: ROWS,
  open_rows: ROWS.filter((r) => r.is_open),
  totals: {
    budget: sum('budget'), spent: sum('spent'), open: sum('open'),
    committed: sum('committed'), variance: sum('variance'),
    verified: sum('verified'), awaiting: 0, unverified: 0, unpaid: sum('open'),
    count: SECTIONS.reduce((t, s) => t + s.count, 0),
    open_count: SECTIONS.reduce((t, s) => t + s.open_count, 0),
    pct: Math.round((sum('spent') / sum('budget')) * 100),
    legacy_budget: sum('legacy_budget'),
    over_committed: sum('committed') > sum('budget'),
  },
}

const ok = (data) => Promise.resolve({ data: { success: true, data } })

const api = {
  get: (url, cfg) => {
    calls.get.push(url + (cfg?.params ? '?' + JSON.stringify(cfg.params) : ''))
    if (url.startsWith('/spend-plans/by-artist')) return ok({ artists: [] })
    if (url.startsWith('/artist-budgets/')) return ok(SHEET)
    return ok(null)
  },
  post: (url, body) => { calls.post.push({ url, body }); return ok({}) },
  // Deliberately returns success WITHOUT changing SHEET: the page refetches after
  // a write, and a stub that also moved the numbers would make "it saved" and "it
  // re-read" indistinguishable. What is asserted is the REQUEST.
  put: (url, body) => { calls.put.push({ url, body }); return ok({}) },
  delete: (url) => { calls.del.push(url); return ok({}) },
}

export default api
export { SHEET, SECTIONS }
