// Mock API resolver — called by the axios adapter in src/api.js when the
// current user is flagged `is_test = true`. Each matcher returns the JSON
// envelope the real backend would have returned.
//
// Design rules:
//   1. Never make a real network request.
//   2. Mutations return a plausible success response — state is kept in a
//      session-scoped in-memory store, so the user's clicks feel real during
//      the demo. Refreshing the tab resets the world. That's the contract.
//   3. Unmatched URLs fall through to a safe `{ success: true, data: [] }`.

import {
  FAKE_ARTISTS, FAKE_RELEASES, FAKE_EXPENSES, FAKE_APPROVALS, FAKE_DEALS,
  FAKE_CONTRACTS, FAKE_TEAM, FAKE_TASKS, FAKE_VENDORS,
  FAKE_DASHBOARD_STATS, FAKE_NOTIFICATIONS, FAKE_ACTIVITY,
} from './fakeData'
// The shipped vocabularies, served as-is in demo mode — same lists the server
// seeds bk_categories from.
import { CATEGORIES as MOCK_CATEGORIES, INCOME_CATEGORIES as MOCK_INCOME_CATEGORIES } from '../constants'

// Session store — cloneable so mutations don't leak into source arrays
const clone = (v) => JSON.parse(JSON.stringify(v))
const store = {
  artists:       clone(FAKE_ARTISTS),
  releases:      clone(FAKE_RELEASES),
  expenses:      clone(FAKE_EXPENSES),
  approvals:     clone(FAKE_APPROVALS),
  deals:         clone(FAKE_DEALS),
  contracts:     clone(FAKE_CONTRACTS),
  team:          clone(FAKE_TEAM),
  tasks:         clone(FAKE_TASKS),
  vendors:       clone(FAKE_VENDORS),
  dashboardStats:clone(FAKE_DASHBOARD_STATS),
  notifications: clone(FAKE_NOTIFICATIONS),
  activity:      clone(FAKE_ACTIVITY),
}
// expose for debugging
if (typeof window !== 'undefined') window.__bmMock = store

const ok = (data = null) => ({ success: true, data })
const notFound = () => ({ success: false, error: 'Not found in demo mode' })

// Shape parity for the bank-evidence columns that server/lib/bank-evidence.js
// adds to the expense list endpoints. Demo mode has no bank statements, so
// both fields are falsy — which is the honest answer and makes
// BankEvidenceDot render nothing rather than a misleading red dot on every
// paid row. Present as explicit keys (not undefined) so the response shape
// matches the real backend; shape drift here has white-paged test users before.
const withBankEvidence = (e) => ({ ...e, bank_evidence: e.bank_evidence ?? null, bank_expected: e.bank_expected ?? false })

// Strip leading slash + baseURL artefacts so matchers get a normalised path
function normalise(url) {
  if (!url) return '/'
  let u = url.split('?')[0]
  if (u.startsWith('http')) u = u.replace(/^https?:\/\/[^/]+/, '')
  if (u.startsWith('/api')) u = u.slice(4)
  if (!u.startsWith('/')) u = '/' + u
  return u
}

// Parse ?a=1&b=2 into a plain object
function parseQuery(url) {
  const q = (url || '').split('?')[1]
  if (!q) return {}
  const out = {}
  for (const pair of q.split('&')) {
    const [k, v] = pair.split('=')
    out[decodeURIComponent(k)] = v ? decodeURIComponent(v) : ''
  }
  return out
}

// Build a fake weekly series for the paid / submissions charts. Reads
// `from` and `to` off the URL so range-picker changes on the client are
// reflected in the mock response. Defaults to trailing 12 weeks when
// nothing's passed.
function mockWeeklyData(url, { includeAmounts = false } = {}) {
  const q = parseQuery(url)
  const isValidIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  const today = new Date()
  const day = today.getDay() // 0 = Sun
  const daysSinceMonday = day === 0 ? 6 : day - 1
  const defaultTo   = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysSinceMonday)
  const defaultFrom = new Date(defaultTo); defaultFrom.setDate(defaultTo.getDate() - 11 * 7)
  const parseIsoToDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }
  const anchor = (raw, fallback) => isValidIso(raw) ? parseIsoToDate(raw) : fallback
  const toMonday = (d) => { const c = new Date(d); const dd = c.getDay(); c.setDate(c.getDate() - (dd === 0 ? 6 : dd - 1)); return c }
  const start = toMonday(anchor(q.from, defaultFrom))
  const end   = toMonday(anchor(q.to,   defaultTo))
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const weeks = []
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 7)) {
    const s = new Date(d)
    const e = new Date(s); e.setDate(s.getDate() + 6)
    const vendor = Math.floor((includeAmounts ? 2 : 5) + Math.random() * (includeAmounts ? 8 : 12))
    const admin  = Math.floor((includeAmounts ? 1 : 3) + Math.random() * (includeAmounts ? 6 : 9))
    const row = { week_start: iso(s), week_end: iso(e), vendor, admin, total: vendor + admin }
    if (includeAmounts) {
      const va = vendor * (2000 + Math.random() * 6000)
      const aa = admin  * (2000 + Math.random() * 6000)
      row.vendor_amount = Math.round(va)
      row.admin_amount  = Math.round(aa)
      row.total_amount  = Math.round(va + aa)
    }
    weeks.push(row)
  }
  return weeks
}

// Pattern matching — ordered; first match wins
const MATCHERS = [
  // ── Dashboard ────────────────────────────────────────────────────────────
  // FX rates — same shape the real /api/fx/rates returns, hardcoded to
  // the same fallback table the FxRatesContext uses so demo USD-equivalents
  // are consistent.
  { m: /^\/fx\/rates/, fn: () => ok({
    rates: {
      USD: 1, EUR: 0.92, GBP: 0.79, CAD: 1.37, AUD: 1.51, MXN: 17.2,
      JPY: 156, BRL: 5.6, CHF: 0.91, SEK: 10.7, NOK: 10.8, DKK: 6.86,
    },
    fetchedAt: new Date().toISOString(),
    source: 'mock',
  }) },
  { m: /^\/dashboard\/stats/,         fn: () => ok(store.dashboardStats) },
  { m: /^\/dashboard\/notifications/, fn: () => ok(store.notifications) },
  { m: /^\/dashboard\/activity/,      fn: () => ok(store.activity) },
  // Reports — empty-but-valid shapes so the page renders zero states.
  { m: /^\/reminders/, fn: () => ok([]) },
  // Category vocabularies. Test users get the shipped lists and can't create —
  // the shape must match { expense, income, custom } or every category
  // dropdown in demo mode falls back to the constants silently.
  { m: /^\/categories/, fn: (method) => (method === 'GET'
    ? ok({ expense: MOCK_CATEGORIES, income: MOCK_INCOME_CATEGORIES, custom: [] })
    : ({ status: 403, data: { success: false, error: 'Test users cannot change categories' } })) },
  // Report dismissals. Order matters: 'dismissals' must precede 'dismiss',
  // or the shorter pattern swallows the list request and returns null data.
  // The Sheets export writes to a real Google Drive. A demo user must not be
  // able to touch the live spreadsheet, and a stub URL would open a broken tab,
  // so this refuses in the same shape the server uses for a config failure.
  { m: /^\/reports\/export-google-sheet/, fn: () => ({ status: 403, data: { success: false, error: 'Test users cannot export to Google Sheets' } }) },
  // Month reassignment moves a reported total, so demo users don't get it.
  { m: /^\/reports\/reassign-month/, fn: () => ({ status: 403, data: { success: false, error: 'Test users cannot reassign months' } }) },
  { m: /^\/reports\/classify/, fn: () => ({ status: 403, data: { success: false, error: 'Test users cannot reclassify P&L lines' } }) },
  { m: /^\/reports\/rename-category/, fn: () => ({ status: 403, data: { success: false, error: 'Test users cannot rename categories' } }) },
  { m: /^\/reports\/dismissals/,       fn: () => ok([]) },
  { m: /^\/reports\/dismiss\/restore/, fn: () => ok({ restored: 0 }) },
  { m: /^\/reports\/dismiss/,          fn: () => ok() },
  { m: /^\/reports\/pnl\/detail/, fn: () => ok({ rows: [], total: 0, dismissed: { count: 0, total: 0 } }) },
  // Spend by Artist. Sub-path first so /export doesn't fall through to the
  // JSON matcher and hand a blob-expecting caller an object.
  { m: /^\/reports\/spend-by-artist\/export/, fn: () => ({
    status: 200,
    data: new Blob(['Market Street — Spend by Artist (demo export placeholder)'],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  }) },
  // Shape must mirror the real payload exactly — the tab reads ties_to_pnl and
  // refuses to render numbers when it is false, so `true` here is required, and
  // every total must be a NUMBER (the page formats them and sums nothing).
  { m: /^\/reports\/spend-by-artist/, fn: () => ok({
    from: '2026-01-01', to: '2026-12-31', basis: 'bank',
    // Rows carry `advances` and `total_out` beside `total` — the Advances and
    // Total out columns read them, and one of these artists exists ONLY for an
    // advance (no operating spend), which is a real shape on the live report and
    // the one most likely to break a client that assumes `total` is non-zero.
    artists: [
      { key: 'novablaze', name: 'Nova Blaze', spellings: ['Nova Blaze'], total: 42500,
        advances: 25000, total_out: 67500,
        by_category: { Marketing: 25000, Recording: 17500 } },
      { key: 'milavarela', name: 'Mila Varela', spellings: ['Mila Varela', 'mila varela'], total: 18250,
        advances: 0, total_out: 18250,
        by_category: { Marketing: 12000, 'Music Video': 6250 } },
      { key: 'cassrole', name: 'Cass Role', spellings: ['Cass Role'], total: 0,
        advances: 40000, total_out: 40000, by_category: {} },
    ],
    categories: ['Marketing', 'Recording', 'Music Video'],
    unattributed: { total: 21000, by_category: { Marketing: 15000, 'Bank Fees': 6000 } },
    attributed_total: 60750, total: 81750, coverage_pct: 74.31,
    advances: {
      total: 70000, attributed_total: 65000, unattributed: 5000,
      artists: [
        { key: 'cassrole', name: 'Cass Role', spellings: ['Cass Role'], total: 40000 },
        { key: 'novablaze', name: 'Nova Blaze', spellings: ['Nova Blaze'], total: 25000 },
      ],
      other_total: 30000,
      other_by_category: { 'Partner - Tyler': 20000, Reimbursements: 10000 },
    },
    total_out: 151750,
    ties_to_pnl: true, pnl_expense_total: 81750,
    excluded: {
      below_line: 100000, non_recurring: 0,
      dismissed:  { total: 12000, count: 2 },
      reversals:  { total: 3500, count: 1 },
      unverified: { total: 4200, count: 3 },
    },
    coverage: {},
  }) },
  // Must appear BEFORE the /reports/pnl catch-all is irrelevant here (different
  // path), but it MUST exist at all: without a matcher this fell through to the
  // generic `ok([])`, and an array is truthy — so the page read `[].total` and
  // rendered the literal text "undefined line items match" for every test user.
  // ── /bk/advertising ──
  // Three matchers, and they must sit ABOVE any /reports catch-all. Shapes mirror
  // routes/reports.js exactly: `charges` and `campaigns` are ARRAYS the page maps
  // over, and `months` drives the month strip AND the default month — a missing
  // one left `months === null` forever and the page never left its skeleton.
  // ── vendor payment details ──
  // The public on-file check. A demo user must never be shown a real vendor's
  // details, and this shape is what the form branches on.
  { m: /^\/vendor\/payment-on-file/, fn: () => ({ on_file: false }) },
  // The admin reveal. Refused outright for test users — there is no such thing as
  // a safe fake account number to hand back from a route whose entire purpose is
  // disclosing one.
  { m: /^\/bk\/vendors\/[^/]+\/payment-details/, fn: () => ({
    status: 403, data: { success: false, error: 'Test users cannot view payment details' } }) },
  { m: /^\/reports\/ad-months/, fn: () => ok({ from: null, to: null, months: [], total: 0 }) },
  { m: /^\/reports\/ad-charges/, fn: () => ok({
    month: new Date().toISOString().slice(0, 7),
    charges: [], credits: [], campaigns: [],
    open_cents: 0, allocatable_cents: 0, allocated_cents: 0,
    pool_usd: 0, open_usd: 0, by_category: {},
  }) },
  // A test user must not be able to write, so the dry run comes back empty and the
  // apply is refused rather than faked.
  // The matcher signature is (method, url, body, groups) — `body` is already
  // parsed by the adapter. A dry run answers with an empty plan; anything that
  // would WRITE is refused, so a demo user cannot restructure a ledger family.
  { m: /^\/reports\/ad-allocate/, fn: (method, url, body) => (
    method === 'POST' && body?.dry_run
      ? ok({ month: body?.month || null, per_campaign: [], per_charge: [],
             total: 0, open_before: 0, open_after: 0, dry_run: true })
      : { status: 403, data: { success: false, error: 'Test users cannot allocate ad spend' } }) },
  { m: /^\/reports\/search/, fn: () => ok({
    rows: [], total: 0, truncated: false,
    counted_total: 0, dismissed_count: 0, reversed_count: 0,
    breakdown: {
      counted: { n: 0, usd: 0, expense_usd: 0, income_usd: 0, expense_n: 0, income_n: 0 },
      dismissed: { n: 0, usd: 0 }, reversed: { n: 0, usd: 0 },
      unverified: { n: 0, usd: 0 }, unpaid: { n: 0, usd: 0 },
    },
    cells: [],
  }) },
  { m: /^\/reports\/pnl/, fn: () => ok({
    months: [], income: {}, expenses: {},
    income_totals: { series: {}, total: 0 }, expense_totals: { series: {}, total: 0 },
    net: { series: {}, total: 0 },
    below: {
      income: {}, expenses: {},
      income_totals: { series: {}, total: 0 }, expense_totals: { series: {}, total: 0 },
      net: { series: {}, total: 0 },
    },
    // Non-recurring (asset sales) and contra recoveries — same shape as `below`,
    // or the P&L tab reads undefined keys and white-pages for test users.
    non_recurring: {
      income: {}, expenses: {},
      income_totals: { series: {}, total: 0 }, expense_totals: { series: {}, total: 0 },
      net: { series: {}, total: 0 },
    },
    contra: {},
    unverified: { series: {}, total: 0, count: 0, dismissed_count: 0 },
    dismissed: {
      count: 0, total: 0, series: {}, by_cell: {},
      categories: [], category_count: 0, category_total: 0, item_count: 0,
    },
    reversals: { count: 0, total: 0, credit_total: 0, series: {}, by_cell: {}, pairs: [] },
    coverage: {}, artists: [], artist: null, basis: 'bank',
  }) },
  // Balance sheet. Drawdowns moved out of `liabilities` into `funding`
  // (2026-08-07) — they're how the business was funded, not a bill it owes.
  // Every key the page reads must be present or the tab white-pages; `equity`
  // stays as the server's deprecated alias of net_assets.
  { m: /^\/reports\/balance-sheet/, fn: () => ok({
    as_of: '2026-01-01',
    assets: { cash: [], cash_total: 0, accounts_receivable: { total: 0, count: 0, breakdown: [], breakdown_label: 'client' }, total: 0 },
    liabilities: { accounts_payable: { total: 0, count: 0, breakdown: [], breakdown_label: 'category' }, total: 0 },
    net_assets: { total: 0, note: 'Assets − Liabilities' },
    excluded: { lines: [], line_count: 0, line_total: 0, item_count: 0, item_total: 0, total: 0 },
    funding: {
      hidden: false,
      drawdowns: { total: 0, count: 0, breakdown: [], breakdown_label: 'source' },
      accumulated_deficit: { total: 0 },
      total: 0,
      memo: { recoupable: { total: 0, count: 0 } },
    },
    equity: { total: 0, note: 'deprecated — use net_assets' },
  }) },
  // Bank statements — test users get an empty reconciliation surface.
  // Sub-paths (upload/match/tx) before the list catch-all.
  // Unmatch from the Ledger's bank-evidence popover. Unreachable in demo mode
  // (withBankEvidence always returns null, so no dot renders and there is
  // nothing to click) — present so a shape change upstream can't turn an
  // unreachable path into an unhandled request.
  { m: /^\/statements\/tx\/\d+\/match/, fn: () => ({ status: 403, data: { success: false, error: 'Test users cannot change bank matches' } }) },
  // The Bank Ledger's per-line answers. Demo mode has no statements, so these are
  // unreachable — present because they are money-moving writes and an unhandled
  // request from a test user is worse than a refusal.
  { m: /^\/statements\/tx\/\d+\/(dismiss|unbook|no-invoice|rematch|attach|book-income|unbook-income)/,
    fn: () => ({ status: 403, data: { success: false, error: 'Test users cannot change bank lines' } }) },
  // ONE statement, for the Bank Ledger's statement lens. The page reads
  // `statement.beginning_balance` / `ending_balance` for its tie-out and branches
  // on each transaction's direction / dismissed / match_method / matched_*_id, so
  // every key has to exist even with nothing in the list — a missing `transactions`
  // would throw on `.filter` before the page could render its empty state.
  { m: /^\/statements\/\d+$/, fn: () => ok({
    statement: { id: 0, account: 'bofa', filename: 'No statements in demo mode',
      status: 'ready', period_start: null, period_end: null,
      beginning_balance: null, ending_balance: null },
    transactions: [], paid_no_match: [], category_usage: {},
  }) },
  // Duplicate-payment pairs. Demo mode has no statements, so a pair cannot
  // exist and the flags hub simply omits the section; the two writes refuse,
  // like every other money-moving action here.
  { m: /^\/statements\/duplicate-pairs\/merge/, fn: () => ({ status: 403, data: { success: false, error: 'Test users cannot merge duplicate payments' } }) },
  { m: /^\/statements\/duplicate-pairs\/reject/, fn: () => ({ status: 403, data: { success: false, error: 'Test users cannot change duplicate pairs' } }) },
  { m: /^\/statements\/duplicate-pairs/, fn: () => ok({ pairs: [], count: 0, total: 0 }) },
  { m: /^\/statements\/vendors/, fn: () => ok([]) },
  // Real shape is { flags, acked } (BkStatements and the Flags hub both
  // handle the bare-array legacy form too).
  { m: /^\/statements\/flags/, fn: () => ok({ flags: [], acked: [] }) },
  { m: /^\/bk\/vendor-duplicates/, fn: () => ok([]) },
  { m: /^\/statements\/all/, fn: () => ok({ statement: { id: 'all', account: 'all', filename: 'All statements' }, transactions: [], paid_no_match: [], category_usage: {} }) },
  { m: /^\/statements\/months/, fn: () => ok([]) },
  // Extra items. Demo mode has no statements, so nothing can be checked — the
  // shape must still match the real audit or the page renders against undefined.
  { m: /^\/statements\/extras/, fn: () => ok({ statements: [], total_extra: 0, total_value: 0, checked: 0, unverifiable: 0 }) },
  { m: /^\/statements\/\d+\/extras\/remove/, fn: () => ({ status: 403, data: { success: false, error: 'Test users cannot modify statements' } }) },
  { m: /^\/statements\/\d+\/extras/, fn: () => ok({ id: 0, reconciles: false, reason: 'Demo mode has no statements.', groups: [], extraCount: 0, extraValue: 0, held: 0, expected: 0, missingCount: 0 }) },
  { m: /^\/statements\/upload/, fn: () => ({ status: 403, data: { success: false, error: 'Test users cannot upload statements' } }) },
  { m: /^\/statements\/tx\//, fn: () => ok({}) },
  { m: /^\/statements\/\d+\/(match|confirm-paid)/, fn: () => ok({ matched: 0, scanned: 0, confirmed: 0, failures: [] }) },
  { m: /^\/statements\/\d+/, fn: () => ok({ statement: null, transactions: [], paid_no_match: [] }) },
  { m: /^\/statements/, fn: () => ok([]) },
  // Analytics — pageview pings no-op; the summary returns an empty shape
  // so the admin page renders its zero states for demo users.
  { m: /^\/analytics\/pageview/, fn: () => ok({}) },
  { m: /^\/analytics\/summary/, fn: () => ok({
    days: 30, totals: { views: 0, users: 0 }, topPages: [], topUsers: [], logins: [], daily: [], actions: [],
  }) },
  // Mention mark-read must precede (and the bell needs the OBJECT shape —
  // { total_count, mentions, smart_alerts, releases, contracts } — not the
  // legacy array; the array made every field undefined).
  { m: /^\/notifications\/mentions\/read/, fn: () => ok({}) },
  { m: /^\/notifications/, fn: () => ok({ total_count: 0, mentions: [], smart_alerts: [], releases: [], contracts: [] }) },

  // ── Releases ─────────────────────────────────────────────────────────────
  // Specific routes must precede the /^\/releases/ catch-all.
  { m: /^\/releases\/duplicates/, fn: () => ok([]) },
  { m: /^\/releases\/sync-artwork/, fn: () => ok({
    updated: 0, total: 0, remaining: 0, searched: 0, search_found: 0,
  }) },
  { m: /^\/releases\/merge/, fn: () => ok({ merged_count: 0 }) },
  { m: /^\/releases\/(\d+)/, fn: (_, url, _m, args) => {
    const id = Number(args[0])
    const r = store.releases.find(x => x.id === id)
    return r ? ok(r) : notFound()
  }},
  // Flat array shape matches the real backend's { success, data: [...] }
  // envelope. Was previously double-nested which threw in Dashboard's filter.
  { m: /^\/releases/, fn: () => ok(store.releases) },

  // ── Artists ──────────────────────────────────────────────────────────────
  { m: /^\/artists\/export/, fn: () => ok([]) },
  { m: /^\/artists\/duplicates/, fn: () => ok([]) },
  { m: /^\/artists\/merge/, fn: () => ok({}) },
  // PATCH /artists/:id/name — inline rename from the duplicate-artists
  // flag. Session-only: mutates the in-memory artists store so demo mode
  // shows the change without needing a real DB round-trip.
  { m: /^\/artists\/(\d+)\/name/, fn: (method, _url, body, args) => {
    if (method !== 'PATCH') return ok({})
    const id = Number(args?.[0])
    const artist = (store.artists || []).find(a => a.id === id)
    if (!artist) return { status: 404, data: { success: false, error: 'Artist not found' } }
    const next = String(body?.name || '').trim()
    if (!next) return { status: 400, data: { success: false, error: 'name required' } }
    const prev = artist.name
    artist.name = next
    return ok({ id, name: next, previous_name: prev })
  }},
  // Budget tab — more-specific matchers first so they don't fall through to the catch-all
  { m: /^\/artists\/(\d+)\/budget\/items\/(\d+)/, fn: () => ok({}) },
  { m: /^\/artists\/(\d+)\/budget\/items/, fn: () => ok({ id: 1 }) },
  // Archive toggle — flip the archived flag on the demo store so the
  // archived section + restore action both work in test-user mode.
  { m: /^\/artists\/(\d+)\/archive/, fn: (method, _url, body, args) => {
    const id = Number(args[0])
    const a = store.artists.find(x => x.id === id)
    if (!a) return ok({})
    if (typeof body?.archived === 'boolean') a.archived = body.archived
    return ok({ id, name: a.name, archived: a.archived })
  }},
  { m: /^\/artists\/(\d+)\/budget/, fn: (_, url, _m, args) => {
    const id = Number(args[0])
    const a = store.artists.find(x => x.id === id)
    return ok({
      artist: a ? { id: a.id, name: a.name } : { id, name: 'Artist' },
      dealSummary: { totalAdvance: 0, total: 0, lines: [] },
      budgetItems: [],
      ledgerRows: [],
    })
  }},
  { m: /^\/artists\/(\d+)/, fn: (_, url, _m, args) => {
    const id = Number(args[0])
    const a = store.artists.find(x => x.id === id)
    if (!a) return notFound()
    const releases = store.releases.filter(r => r.artist_id === id)
    return ok({ ...a, releases })
  }},
  { m: /^\/artists/, fn: () => ok(store.artists) },

  // ── Deals ────────────────────────────────────────────────────────────────
  { m: /^\/deals/, fn: () => ok(store.deals) },

  // ── Contracts ────────────────────────────────────────────────────────────
  // Sub-route BEFORE the catch-all: linked-data roll-up returns a static
  // empty shape so the LinkedDataPanel renders its "no data" branches
  // cleanly for demo users.
  { m: /^\/contracts\/\d+\/linked/, fn: () => ok({
    releases: { total: 0, during_term: 0, recent: [] },
    expenses: { count: 0, total: 0, recoupable_total: 0, recoupable_count: 0, ufr_total: 0, ufr_count: 0, unpaid_total: 0, unpaid_count: 0, by_category: [] },
    income: { total: 0, during_term: 0, by_type: [] },
  }) },
  { m: /^\/contracts/, fn: () => ok(store.contracts) },
  { m: /^\/pending-contracts/, fn: () => ok([]) },
  { m: /^\/renewals/, fn: () => ok(
    store.contracts.filter(c => {
      if (c.status !== 'Active' || !c.expiration_date) return false
      const days = (new Date(c.expiration_date) - new Date()) / (1000 * 60 * 60 * 24)
      return days <= 365
    })
  ) },

  // ── Bookkeeping ──────────────────────────────────────────────────────────
  { m: /^\/bk\/admin\/corrupt-invoices/, fn: () => ok([]) },
  // Payment terms on the create-invoice page. Sub-path matchers before any
  // catch-all, and the SHAPES mirror routes/invoices.js — a test user hitting the
  // generic fallback would get an array where the page reads `.terms`, and the
  // selector would silently fall back to a single hardcoded option.
  { m: /^\/invoices\/terms/, fn: () => ok({
    terms: [
      { label: 'Due on receipt', days: 0, custom: false },
      { label: 'Net 15', days: 15, custom: false },
      { label: 'Net 30', days: 30, custom: false },
      { label: 'Net 45', days: 45, custom: false },
      { label: 'Net 60', days: 60, custom: false },
      { label: 'Net 90', days: 90, custom: false },
      { label: 'Custom', days: null, custom: true },
    ],
    default: 'Net 30',
  }) },
  { m: /^\/invoices\/due-date/, fn: (_m, url) => {
    const q = new URLSearchParams(String(url).split('?')[1] || '')
    const terms = q.get('terms') || 'Net 30'
    // `invoice_date` is the anchor the server counted from, and the page PRINTS it
    // on the document. Omitting it here would leave the test-user preview with no
    // date at all. The real route derives it in the company's timezone; en-CA
    // formats as 'YYYY-MM-DD'.
    const date = q.get('date') || new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())
    const DAYS = { 'due on receipt': 0, 'net 15': 15, 'net 30': 30, 'net 45': 45, 'net 60': 60, 'net 90': 90 }
    if (/^custom$/i.test(terms)) {
      const c = q.get('custom')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(c || '')) return ok({ terms, due_date: null, due_by: null, invoice_date: date, error: 'a custom due date is required' })
      return ok({ terms, due_date: c, due_by: c, invoice_date: date, error: null })
    }
    const n = DAYS[terms.toLowerCase()] ?? 30
    if (!n) return ok({ terms, due_date: null, due_by: 'UPON RECEIPT', invoice_date: date, error: null })
    const [y, mo, d] = date.split('-').map(Number)
    const out = new Date(Date.UTC(y, mo - 1, d) + n * 86400000).toISOString().slice(0, 10)
    return ok({ terms, due_date: out, due_by: `${out} (${terms})`, invoice_date: date, error: null })
  } },
  // Per-entry flag toggle — matches POST /bk/entries/:id/flag. Must appear
  // BEFORE the /bk/entries catch-all so /flag doesn't fall through as a
  // vanilla POST. Mutates the demo expense in place so filters + chips
  // reflect the toggle inside the session.
  // Bulk edit. Mutates the demo store so the ledger's bulk bar visibly does
  // something in a test session, and returns the SAME shape the real route does —
  // `previous` is what the page's undo replays, so an empty or missing key there
  // would make undo a silent no-op rather than an error.
  { m: /^\/bk\/entries\/bulk/, fn: (_method, _url, body) => {
    const ids = Array.isArray(body?.ids) ? body.ids.map(Number) : []
    const field = String(body?.field || '')
    const value = body?.value
    const previous = []
    for (const id of ids) {
      const idx = store.expenses.findIndex(x => x.id === id)
      if (idx < 0) continue
      const before = store.expenses[idx][field]
      if (before === value) continue
      previous.push({ id, value: before ?? null })
      store.expenses[idx] = { ...store.expenses[idx], [field]: value }
    }
    return ok({
      field, value, changed: previous.length,
      already: ids.length - previous.length, requested: ids.length,
      skipped: 0, relinked: 0, previous,
    })
  }},
  // Settlement groups — "these invoices were sent in ONE payment".
  //
  // Mutates the demo store so the Ledger's One payment button and the group chip
  // both do something in a test session, and enforces the SAME two refusals a
  // person will actually hit: fewer than two invoices, and two different vendors.
  // A mock that always succeeds would hide the only interesting part of the
  // control — the message it shows when the selection cannot be one payment.
  { m: /^\/bk\/settlement-groups\/(.+)$/, fn: (method, _url, _body, args) => {
    const group = decodeURIComponent(String(args?.[0] || ''))
    if (method !== 'DELETE') return ok(null)
    const cleared = []
    store.expenses = store.expenses.map(e => {
      if (e.settlement_group !== group) return e
      cleared.push(e.id)
      return { ...e, settlement_group: null }
    })
    return ok({ group, cleared })
  }},
  { m: /^\/bk\/settlement-groups$/, fn: (_method, _url, body) => {
    const ids = [...new Set((Array.isArray(body?.expense_ids) ? body.expense_ids : []).map(Number))]
    const rows = ids.map(id => store.expenses.find(x => x.id === id)).filter(Boolean)
    if (rows.length < 2) {
      return { status: 400, data: { success: false,
        error: 'Pick at least two invoices — a group of one is not a payment group.' } }
    }
    const key = (p) => String(p || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
    if (new Set(rows.map(r => key(r.payee))).size > 1) {
      return { status: 400, data: { success: false,
        error: 'Those invoices are from different vendors — one payment cannot settle invoices from two vendors.' } }
    }
    const group = 'sg_' + Math.random().toString(16).slice(2, 14)
    store.expenses = store.expenses.map(e => (ids.includes(e.id) ? { ...e, settlement_group: group } : e))
    return ok({ group, members: rows.map(r => r.id), orphaned: [] })
  }},
  { m: /^\/bk\/entries\/(\d+)\/flag/, fn: (_method, _url, body, args) => {
    const id = Number(args?.[0])
    const idx = store.expenses.findIndex(x => x.id === id)
    if (idx < 0) return ok(null)
    const prev = store.expenses[idx]
    const flagged = !!(body && body.flagged)
    const reason = body && body.flag_reason != null ? String(body.flag_reason).slice(0, 500).trim() || null : null
    const next = {
      ...prev,
      flagged,
      flagged_at: flagged ? new Date().toISOString() : null,
      flagged_by_name: flagged ? 'You' : null,
      flag_reason: flagged ? (reason ?? prev.flag_reason ?? null) : null,
    }
    store.expenses[idx] = next
    // ok() already wraps in { success, data } — double-wrapping made
    // consumers spread a junk `data` key into the entry row.
    return ok(next)
  }},
  // Per-row comment threads — must precede the /bk/entries catch-all.
  // GET returns an empty thread; POST echoes the comment back so the
  // demo UI renders it in-session. (No double-wrap: ok() adds the
  // envelope — the old { data: [] } shape crashed the thread popover.)
  { m: /^\/bk\/entries\/\d+\/comments/, fn: (method, _url, body) => method === 'POST'
      ? ok({ id: Date.now(), user_id: 0, user_name: 'You', comment: body?.comment || '', created_at: new Date().toISOString() })
      : ok([]) },
  { m: /^\/bk\/entries/, fn: (method, url, body) => {
    if (method === 'GET') return ok(store.expenses.map(withBankEvidence))
    if (method === 'POST' && url.endsWith('/approve')) return ok()
    if (method === 'POST' && url.endsWith('/reject'))  return ok()
    // Explicit shape: the archive reads data.children_restored off this, and
    // the catch-all's null would only work by accident.
    if (method === 'POST' && url.endsWith('/unreject')) return ok({ id: 0, status: 'pending', children_restored: 0 })
    return ok()
  }},
  // ── Recoupment audit ──────────────────────────────────────────────────────
  // Shapes mirror routes/bookkeeping.js exactly. The page reads `totals` to draw
  // its tiles and `pile.by_category` to build its list, so a wrong shape here is
  // a white page for a test user — that has happened before with array-vs-object
  // drift, which is why every key below is present even though the demo has
  // nothing to report.
  // Release spend plans. Shapes mirror routes/spend-plans.js. Every key the page
  // reads is present even though a test user has no sheet: `totals`, `lines` and
  // each queue row's `money` / `lines` / `suggestions` are all dereferenced
  // during render, so a missing one is a white page rather than an empty state.
  // Sub-path matchers first — the bare /spend-plans catch-all is last.
  { m: /^\/spend-plans\/by-artist/, fn: () => ok({
    artists: [],
    totals: { artists: 0, campaigns: 0, planned: 0, owed: 0, ledger_paid: 0, ledger_open: 0 },
    unlinked: { count: 0, total: 0 },
  }) },
  { m: /^\/spend-plans\/summary/, fn: () => ok({
    by_status: [],
    totals: { plans: 0, linked: 0, sheet_total: 0, last_import: null },
    lines: { lines: 0, committed: 0, sheet_paid: 0, sheet_unknown: 0, prose_lines: 0 },
  }) },
  { m: /^\/spend-plans\/queue/, fn: () => ({ status: 200,
    data: { success: true, data: [], total: 0 } }) },
  { m: /^\/spend-plans\/release\/(\d+)/, fn: () => ok({
    release_id: 0, plans: [], lines: [],
    plan: { lines_total: 0, committed: 0, sheet_paid: 0, sheet_unknown: 0,
      prose_lines: 0, sheet_total: 0 },
    actual: { spent: 0, open: 0, rows: [] },
    variance: 0,
  }) },
  { m: /^\/spend-plans\/import/, fn: () => ({ status: 403,
    data: { success: false, error: 'Test users cannot import a spend sheet' } }) },
  { m: /^\/spend-plans\/(\d+)\/(link|unlink|skip)/, fn: () => ({ status: 403,
    data: { success: false, error: 'Test users cannot change spend plan matching' } }) },

  // Artist spend sheets. Shapes mirror routes/artist-budgets.js: the pages read
  // `sections[].categories`, `rows[]` and every key of `totals`, so a missing one
  // is a white page for a test user rather than an empty state.
  { m: /^\/artist-budgets\/[^/]+\/export/, fn: () => ({ status: 403,
    data: { success: false, error: 'Test users cannot export' } }) },
  { m: /^\/artist-budgets\/[^/]+$/, fn: (method) => (method === 'PUT'
    ? ({ status: 403, data: { success: false, error: 'Test users cannot set a budget' } })
    : ok({
      artist_key: 'demo', artist: 'Demo Artist', sections: [], rows: [], open_rows: [],
      totals: { budget: 0, spent: 0, open: 0, committed: 0, variance: 0,
        verified: 0, awaiting: 0, unverified: 0, unpaid: 0,
        count: 0, open_count: 0, pct: null, legacy_budget: 0, over_committed: false },
    })) },
  { m: /^\/artist-budgets\/[^/]+\/[^/]+$/, fn: () => ({ status: 403,
    data: { success: false, error: 'Test users cannot set a budget' } }) },
  { m: /^\/artist-budgets/, fn: () => ok({
    artists: [],
    totals: { artists: 0, with_budget: 0, budget: 0, spent: 0, open: 0,
      committed: 0, open_count: 0 },
    sections: [],
  }) },
  { m: /^\/bk\/recoupment-audit/, fn: () => ok({
    advances: [], pile: {
      by_category: [], total_usd: 0, total_items: 0,
      covered_usd: 0, covered_items: 0, remaining_usd: 0, remaining_items: 0, rules: [],
    },
    artist_options: [...new Set(store.expenses.map(e => e.artist).filter(Boolean))],
    double_claims: [], no_document: [], partial_families: [],
    totals: {
      advances_usd: 0, advances_items: 0, pile_usd: 0, pile_items: 0,
      double_claims_usd: 0, double_claims_groups: 0, double_claims_cross_artist: 0,
      no_document_usd: 0, no_document_items: 0,
      partial_families_usd: 0, partial_families_count: 0, partial_families_items: 0,
    },
  }) },
  // Rules are a real list in the demo so the chips and the delete button render;
  // POST/DELETE are in-session no-ops that keep the response shape.
  { m: /^\/bk\/recoupment-class-rules/, fn: (method) => method === 'POST'
      ? ok({ made: [] })
      : (method === 'DELETE' ? ok({ scope: 'category', rule_key: '' }) : ok([])) },
  { m: /^\/bk\/recoup-review/, fn: (method) => method === 'POST'
      ? ok({ reviewed: 0, recoupable: true, artist: null, requested: 0, skipped: 0 })
      : ok([]) },
  { m: /^\/bk\/approvals/, fn: () => ok(store.approvals) },
  { m: /^\/bk\/bulk-approve/, fn: (_, __, body) => {
    const ids = new Set((body?.ids || []).map(Number))
    store.approvals = store.approvals.filter(a => !ids.has(a.id))
    return ok({ approved: ids.size })
  }},
  { m: /^\/bk\/payments\/send-approval-email/, fn: (_, __, body) => {
    const ids = (body?.ids || [])
    const total = store.expenses.filter(e => ids.includes(e.id)).reduce((s, e) => s + e.amount, 0)
    return ok({ count: ids.length, to: 'demo@boom', cc: null, totals: { USD: total }, artists: 3 })
  }},
  // Installments — mirror the real backend shape so the modal renders without
  // axios throwing. Demo store doesn't persist real installments; we keep a
  // local map keyed by expense id so add/delete feel real within a session.
  { m: /^\/bk\/payments\/(\d+)\/installments/, fn: (method, _url, body, args) => {
    const id = Number(args?.[0])
    const e = store.expenses.find(x => x.id === id) || {}
    store.__installments = store.__installments || {}
    const list = store.__installments[id] = store.__installments[id] || []
    const familyTotal = Number(e.amount || 0)
    if (method === 'POST') {
      const amt = parseFloat(body?.get ? body.get('amount') : body?.amount) || 0
      const inst = {
        id: Date.now(),
        expense_id: id,
        amount: amt,
        payment_date: (body?.get ? body.get('payment_date') : body?.payment_date) || null,
        payment_method: (body?.get ? body.get('payment_method') : body?.payment_method) || null,
        payment_ref: (body?.get ? body.get('payment_ref') : body?.payment_ref) || null,
        paid_by: (body?.get ? body.get('paid_by') : body?.paid_by) || 'Demo User',
        proof_filename: null, has_proof: false, notes: null,
        created_at: new Date().toISOString(), created_by: 'Demo User',
      }
      list.push(inst)
      const paid = list.reduce((s, r) => s + Number(r.amount || 0), 0)
      const status = paid + 0.005 >= familyTotal ? 'Paid' : 'Partial'
      return ok({ installment: inst, summary: { paid, count: list.length, status, familyTotal } })
    }
    // GET
    const paid = list.reduce((s, r) => s + Number(r.amount || 0), 0)
    return ok({
      rootId: id, familyTotal,
      installmentsTotal: paid,
      remaining: Math.max(0, familyTotal - paid),
      installments: list,
    })
  }},
  { m: /^\/bk\/installments\/(\d+)/, fn: (method, _url, _body, args) => {
    const instId = Number(args?.[0])
    store.__installments = store.__installments || {}
    let summary = { paid: 0, count: 0, status: 'Unpaid', familyTotal: 0 }
    if (method === 'DELETE') {
      for (const [expId, list] of Object.entries(store.__installments)) {
        const next = list.filter(i => i.id !== instId)
        if (next.length !== list.length) {
          store.__installments[expId] = next
          const e = store.expenses.find(x => x.id === Number(expId)) || {}
          const familyTotal = Number(e.amount || 0)
          const paid = next.reduce((s, r) => s + Number(r.amount || 0), 0)
          summary = {
            paid, count: next.length,
            status: next.length === 0 ? 'Unpaid' : (paid + 0.005 >= familyTotal ? 'Paid' : 'Partial'),
            familyTotal,
          }
          break
        }
      }
      return ok({ summary })
    }
    return ok()
  }},

  { m: /^\/bk\/payments\/(\d+)\/confirmation-preview/, fn: (_, url, body, args) => {
    const id = Number(args?.[0])
    const e = store.expenses.find(x => x.id === id) || {}
    const subject = body?.subject != null
      ? String(body.subject)
      : `Payment Confirmation - ${e.vendor_name || e.payee || 'Vendor'}${e.invoice_number ? ` (#${e.invoice_number})` : ''}`
    const message = body?.message != null ? String(body.message) : ''
    const html = `<div style="font-family:sans-serif;padding:24px;color:#111;"><h2>Payment Confirmation</h2><p>Hi ${e.vendor_name || e.payee || 'Vendor'},</p>${message ? `<p>${message.replace(/</g,'&lt;')}</p>` : ''}<p>Amount: ${e.amount || 0} ${e.currency || 'USD'}</p><p>(demo preview)</p></div>`
    return ok({
      to: body?.to != null ? String(body.to) : (e.vendor_email || 'vendor@example.com'),
      cc: body?.cc != null ? String(body.cc) : '',
      subject, message, html,
      vendorName: e.vendor_name || e.payee,
      amount: e.amount, currency: e.currency || 'USD',
      invoiceNumber: e.invoice_number, paymentDate: e.payment_date, paymentMethod: e.payment_method,
      boomRep: e.boom_rep || null, hasInvoice: true, hasProof: true,
    })
  }},
  // Bulk rush — must come BEFORE the per-row pattern even though the
  // per-row regex uses \d+ (it won't match "rush"), because keeping the
  // more-specific path first is the convention enforced for matcher
  // ordering elsewhere in this file.
  { m: /^\/bk\/payments\/rush\/bulk/, fn: (method, _url, body) => {
    if (method !== 'POST') return ok({ rushed: [], rushedCount: 0, skipped: 0, invisible: 0 })
    const ids = Array.isArray(body?.ids) ? body.ids.map(Number) : []
    const reason = (body?.reason || '').slice(0, 500) || null
    const rushed = []
    for (const id of ids) {
      const e = store.expenses.find(x => x.id === id)
      if (!e) continue
      if (e.payment_status === 'Paid') continue
      if (e.rush_requested) continue
      e.rush_requested = true
      e.rush_requested_at = new Date().toISOString()
      e.rush_requested_by = 'You'
      e.rush_reason = reason
      rushed.push(e)
    }
    return ok({
      rushed,
      rushedCount: rushed.length,
      skipped: ids.length - rushed.length,
      invisible: 0,
    })
  }},
  // Rush-payment request — session-only in demo mode, so the badge flips
  // on/off locally without hitting a server. POST sets the rush_* fields
  // AND clears the hold_* fields (mutex mirror of the server); DELETE
  // clears rush only.
  { m: /^\/bk\/payments\/(\d+)\/rush/, fn: (method, _url, body, args) => {
    const id = Number(args[0])
    const e = store.expenses.find(x => x.id === id)
    if (!e) return { status: 404, data: { success: false, error: 'Not found' } }
    if (method === 'POST') {
      e.rush_requested = true
      e.rush_requested_at = new Date().toISOString()
      e.rush_requested_by = 'You'
      e.rush_reason = (body?.reason || '').slice(0, 500) || null
      e.on_hold = false
      e.hold_at = null
      e.hold_by = null
      e.hold_reason = null
      return ok(e)
    }
    if (method === 'DELETE') {
      e.rush_requested = false
      e.rush_requested_at = null
      e.rush_requested_by = null
      e.rush_reason = null
      return ok(e)
    }
    return ok(e)
  }},
  // Bulk hold — mirror of /payments/rush/bulk. Must come before the
  // per-row /(\d+)/hold matcher so \d+ doesn't accidentally swallow the
  // "hold" literal.
  { m: /^\/bk\/payments\/hold\/bulk/, fn: (method, _url, body) => {
    if (method !== 'POST') return ok({ held: [], heldCount: 0, skipped: 0, invisible: 0 })
    const ids = Array.isArray(body?.ids) ? body.ids.map(Number) : []
    const reason = (body?.reason || '').slice(0, 500) || null
    const held = []
    for (const id of ids) {
      const e = store.expenses.find(x => x.id === id)
      if (!e) continue
      if (e.payment_status === 'Paid') continue
      if (e.on_hold) continue
      e.on_hold = true
      e.hold_at = new Date().toISOString()
      e.hold_by = 'You'
      e.hold_reason = reason
      // Mutex: bulk hold clears rush on the same rows.
      e.rush_requested = false
      e.rush_requested_at = null
      e.rush_requested_by = null
      e.rush_reason = null
      held.push(e)
    }
    return ok({
      held,
      heldCount: held.length,
      skipped: ids.length - held.length,
      invisible: 0,
    })
  }},
  // Per-row hold — mirror of /payments/:id/rush. Session-only.
  { m: /^\/bk\/payments\/(\d+)\/hold/, fn: (method, _url, body, args) => {
    const id = Number(args[0])
    const e = store.expenses.find(x => x.id === id)
    if (!e) return { status: 404, data: { success: false, error: 'Not found' } }
    if (method === 'POST') {
      e.on_hold = true
      e.hold_at = new Date().toISOString()
      e.hold_by = 'You'
      e.hold_reason = (body?.reason || '').slice(0, 500) || null
      // Mutex with rush.
      e.rush_requested = false
      e.rush_requested_at = null
      e.rush_requested_by = null
      e.rush_reason = null
      return ok(e)
    }
    if (method === 'DELETE') {
      e.on_hold = false
      e.hold_at = null
      e.hold_by = null
      e.hold_reason = null
      return ok(e)
    }
    return ok(e)
  }},
  // Per-entry send-confirmation / mark-sent / mark-unsent. Session-scoped:
  // flip the entry's confirmation_sent flag so the UI reflects the click.
  { m: /^\/bk\/payments\/(\d+)\/send-confirmation/, fn: (_, _url, _body, args) => {
    const id = Number(args[0])
    const e = store.expenses.find(x => x.id === id)
    if (!e) return { status: 404, data: { success: false, error: 'Not found' } }
    e.confirmation_sent = true
    return ok({ sent: true, to: e.vendor_email || 'vendor@example.com', entry: e })
  }},
  { m: /^\/bk\/payments\/(\d+)\/mark-sent/, fn: (_, _url, _body, args) => {
    const id = Number(args[0])
    const e = store.expenses.find(x => x.id === id)
    if (!e) return { status: 404, data: { success: false, error: 'Not found' } }
    e.confirmation_sent = true
    return ok(e)
  }},
  { m: /^\/bk\/payments\/(\d+)\/mark-unsent/, fn: (_, _url, _body, args) => {
    const id = Number(args[0])
    const e = store.expenses.find(x => x.id === id)
    if (!e) return { status: 404, data: { success: false, error: 'Not found' } }
    e.confirmation_sent = false
    return ok(e)
  }},
  // Bulk actions — approximate the real-backend response shape. The demo
  // store honors the mutation so subsequent list fetches reflect it.
  { m: /^\/bk\/payments\/send-confirmations-bulk/, fn: (_, __, body) => {
    const ids = Array.isArray(body?.ids) ? body.ids.map(Number) : []
    const emails = new Set()
    for (const id of ids) {
      const e = store.expenses.find(x => x.id === id)
      if (!e) continue
      e.confirmation_sent = true
      if (e.vendor_email) emails.add(e.vendor_email)
    }
    return ok({ sent: ids.length, vendors: emails.size, errors: [] })
  }},
  { m: /^\/bk\/payments\/mark-unsent-bulk/, fn: (_, __, body) => {
    const ids = Array.isArray(body?.ids) ? body.ids.map(Number) : []
    const email = String(body?.vendor_email || '').toLowerCase()
    const payee = String(body?.payee || '').toLowerCase()
    let touched = 0
    const affectedIds = []
    for (const e of store.expenses) {
      if (!e.confirmation_sent) continue
      const matchId    = ids.length ? ids.includes(e.id) : false
      const matchEmail = email && String(e.vendor_email || '').toLowerCase() === email
      const matchPayee = payee && String(e.payee || '').toLowerCase() === payee
      if (matchId || matchEmail || matchPayee) {
        e.confirmation_sent = false
        touched++
        affectedIds.push(e.id)
      }
    }
    return ok({ reset: touched, ids: affectedIds })
  }},
  // Export — real backend streams an .xlsx blob. In demo mode there's no
  // xlsx to hand back; return ok([]) so the broad payments matcher doesn't
  // swallow the request and hand the caller a filtered array of expenses
  // (which the download-as-file code would then treat as garbage bytes).
  // The caller's .catch will fire; that's acceptable for demo mode.
  { m: /^\/bk\/payments\/export/, fn: () => ok([]) },
  // Chart data — both endpoints. Reads optional `from` / `to` query
  // params so the mock respects the range picker on the client; falls
  // back to a trailing-12-weeks window when neither is provided. Both
  // include USD amount totals so the chart tooltip + footer render
  // consistently in demo mode.
  { m: /^\/bk\/payments\/paid-per-week/,        fn: (_, url) => ok({ weeks: mockWeeklyData(url, { includeAmounts: true }) }) },
  { m: /^\/bk\/payments\/submissions-per-week/, fn: (_, url) => ok({ weeks: mockWeeklyData(url, { includeAmounts: true }) }) },
  // PUT /bk/payments/:id — the pay/unpay mutation on the Payment Dashboard.
  // Session-scoped: flip payment_status / payment_date / paid_by so the
  // row moves between "paid" / "unpaid" without a page refresh.
  { m: /^\/bk\/payments\/(\d+)(?:\?|$)/, fn: (method, _url, body, args) => {
    const id = Number(args[0])
    const e = store.expenses.find(x => x.id === id)
    if (!e) return { status: 404, data: { success: false, error: 'Not found' } }
    if (method === 'PUT' && body) {
      if ('payment_status' in body) e.payment_status = body.payment_status
      if ('payment_date'   in body) e.payment_date   = body.payment_date
      if ('paid_by'        in body) e.paid_by        = body.paid_by
      if ('payment_method' in body) e.payment_method = body.payment_method
      if ('payment_ref'    in body) e.payment_ref    = body.payment_ref
    }
    return ok(e)
  }},
  { m: /^\/bk\/payments(?:\?|$)/,  fn: (_method, url) => {
    // ?bank=unverified mirrors the real backend: the "paid, no bank match"
    // worklist, which opts OUT of the 14-day scope. Test users have no bank
    // statements at all, so withBankEvidence() leaves bank_expected false and
    // this correctly returns an empty worklist rather than flagging every
    // paid row.
    if (/[?&]bank=unverified/.test(url)) {
      return ok(store.expenses.filter(e =>
        e.status === 'approved' && e.payment_status === 'Paid' && !e.bank_evidence && e.bank_expected))
    }
    // Mirror the real backend's scope: unpaid OR paid-in-last-14-days, and
    // exclude the internal sources that are spend records rather than invoices
    // awaiting payment. bank_statement rows are created BY booking a debit that
    // has already left the account — they were 90% of this list before the
    // server excluded them.
    const QUEUE_EXCLUDED = ['recoupments', 'artist_campaigns', 'bank_statement']
    const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)
    return ok(store.expenses.filter(e => {
      if (e.status !== 'approved') return false
      if (QUEUE_EXCLUDED.includes(e.entry_source)) return false
      if (e.payment_status !== 'Paid') return true
      return e.payment_date && e.payment_date >= cutoff
    }).map(withBankEvidence))
  }},
  // Recoupment notes — session-scoped map. Matches the real backend shape so
  // the Recoupments artist-detail UI works in demo mode.
  { m: /^\/bk\/recoupments\/notes/, fn: (method, url, body) => {
    store.__recoupmentNotes = store.__recoupmentNotes || {}  // { artistKey: { artistNote, songNotes: {} } }
    if (method === 'GET') {
      const q = url.split('?')[1] || ''
      const params = new URLSearchParams(q)
      const aKey = (params.get('artist') || '').trim().toLowerCase()
      const bucket = store.__recoupmentNotes[aKey] || { artistNote: '', songNotes: {} }
      return ok({ artistKey: aKey, artistNote: bucket.artistNote, songNotes: { ...bucket.songNotes } })
    }
    if (method === 'PUT') {
      const aKey = (body?.artist || '').trim().toLowerCase()
      if (!aKey) return ok({})
      const songKey = (body?.song == null || String(body?.song).trim() === '') ? null : String(body.song).trim().toLowerCase()
      const note = String(body?.note || '')
      const bucket = store.__recoupmentNotes[aKey] || { artistNote: '', songNotes: {} }
      if (songKey == null) bucket.artistNote = note.trim() ? note : ''
      else if (note.trim()) bucket.songNotes[songKey] = note
      else delete bucket.songNotes[songKey]
      store.__recoupmentNotes[aKey] = bucket
      return ok({ artistKey: aKey, songKey, note })
    }
    return ok({})
  }},
  // Unified per-artist meta — shared by Recoupments + Artist Campaigns.
  // Session-scoped { artistKey -> meta } map so dismiss / priority demo
  // edits stick within a session without hitting the real backend.
  // Returns the merged row on PUT so the page's optimistic update matches
  // what a real server would echo back.
  { m: /^\/bk\/artist-meta/, fn: (method, _url, body) => {
    store.__artistMeta = store.__artistMeta || {}
    if (method === 'GET') return ok({ ...store.__artistMeta })
    if (method === 'PUT') {
      const aKey = (body?.artist || '').trim().toLowerCase()
      if (!aKey) return ok({})
      const prev = store.__artistMeta[aKey] || { artist_key: aKey }
      const next = { ...prev }
      if (Object.prototype.hasOwnProperty.call(body || {}, 'dismissed')) {
        next.dismissed = !!body.dismissed
        next.dismissed_at = next.dismissed ? new Date().toISOString() : null
      }
      if (Object.prototype.hasOwnProperty.call(body || {}, 'priority')) {
        next.priority = body.priority || null
        next.priority_updated_at = new Date().toISOString()
      }
      if (Object.prototype.hasOwnProperty.call(body || {}, 'flagged')) {
        next.flagged = !!body.flagged
        next.flagged_at = next.flagged ? new Date().toISOString() : null
        next.flagged_by_name = next.flagged ? 'You' : null
        if (!next.flagged) next.flag_reason = null
      }
      if (Object.prototype.hasOwnProperty.call(body || {}, 'flag_reason')) {
        next.flag_reason = body.flag_reason || null
      }
      if (Object.prototype.hasOwnProperty.call(body || {}, 'complete')) {
        next.complete = !!body.complete
        next.complete_at = next.complete ? new Date().toISOString() : null
        next.complete_by_name = next.complete ? 'You' : null
      }
      store.__artistMeta[aKey] = next
      return ok(next)
    }
    return ok({})
  }},
  // Song-campaign status — session-only mirror of the server table.
  // Store keyed by "artistKey|songKey" so the client's songStatus map
  // hydrates the same way it does in prod. GET returns rows that have
  // either finished=true OR non-empty notes.
  { m: /^\/bk\/song-status/, fn: (method, _url, body) => {
    store.__songStatus = store.__songStatus || {}
    if (method === 'GET') {
      const out = {}
      for (const [k, v] of Object.entries(store.__songStatus)) {
        if (v?.finished || (v?.notes && v.notes.length > 0) || v?.flagged) out[k] = v
      }
      return ok(out)
    }
    if (method === 'PUT') {
      const artist = String(body?.artist || '').trim()
      const song   = String(body?.song   || '').trim()
      if (!artist || !song) return ok({})
      const aKey = artist.toLowerCase().replace(/[^a-z0-9]/g, '')
      const sKey = song.toLowerCase().trim()
      if (!aKey || !sKey) return ok({})
      const key = `${aKey}|${sKey}`
      const prev = store.__songStatus[key] || { artist_key: aKey, song_key: sKey }
      const next = { ...prev }
      if (Object.prototype.hasOwnProperty.call(body || {}, 'finished')) {
        next.finished = !!body.finished
        next.finished_at = next.finished ? new Date().toISOString() : null
        next.finished_by_name = next.finished ? 'You' : null
      }
      if (Object.prototype.hasOwnProperty.call(body || {}, 'notes')) {
        const notesRaw = String(body.notes ?? '').slice(0, 4000)
        next.notes = notesRaw || null
        next.notes_updated_at = new Date().toISOString()
        next.notes_updated_by_name = 'You'
      }
      if (Object.prototype.hasOwnProperty.call(body || {}, 'flagged')) {
        next.flagged = !!body.flagged
        next.flagged_at = next.flagged ? new Date().toISOString() : null
        next.flagged_by_name = next.flagged ? 'You' : null
        if (!next.flagged) next.flag_reason = null
      }
      if (Object.prototype.hasOwnProperty.call(body || {}, 'flag_reason')) {
        next.flag_reason = body.flag_reason || null
      }
      store.__songStatus[key] = next
      return ok(next)
    }
    return ok({})
  }},
  { m: /^\/bk\/vendor-w9-status/, fn: () => ok({ has_w9: false, w9_entry_id: null }) },
  // Vendor-ZIP builds a real archive server-side; in demo mode there's
  // nothing to zip, so respond with an empty envelope. The caller uses
  // responseType:'blob' — the mock adapter always returns JSON so the
  // download will be a tiny placeholder rather than a broken filtered list.
  { m: /^\/bk\/vendor-zip/, fn: () => ok([]) },

  // ── NDAs ─────────────────────────────────────────────────────────────────
  // PUT must return the merged row so the server-response check in CreateNDA
  // doesn't flag a mismatch.
  { m: /^\/ndas\/(\d+)/, fn: (method, _url, body, args) => {
    const id = Number(args[0])
    store.ndas = store.ndas || []
    if (method === 'DELETE') { store.ndas = store.ndas.filter(n => n.id !== id); return ok({}) }
    const existing = store.ndas.find(n => n.id === id) || { id }
    const merged = { ...existing, ...(body || {}), id }
    store.ndas = store.ndas.map(n => n.id === id ? merged : n)
    if (!store.ndas.find(n => n.id === id)) store.ndas.push(merged)
    return ok(merged)
  }},
  { m: /^\/ndas/, fn: (method, _url, body) => {
    store.ndas = store.ndas || []
    if (method === 'POST') {
      const next = { id: Date.now(), created_at: new Date().toISOString(), created_by: 'Demo', ...(body || {}) }
      store.ndas.unshift(next)
      return ok(next)
    }
    return ok(store.ndas)
  }},
  // Clearances — mirror of /ndas. Test users don't get a real XLSX
  // generated (no template path), so /download just returns an empty blob.
  { m: /^\/clearances\/catalog/, fn: () => ok([]) },
  { m: /^\/clearances\/(\d+)\/download/, fn: () => ok(new Blob([], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })) },
  { m: /^\/clearances\/(\d+)/, fn: (method, _url, body, args) => {
    const id = Number(args[0])
    store.clearances = store.clearances || []
    if (method === 'DELETE') { store.clearances = store.clearances.filter(n => n.id !== id); return ok({}) }
    const existing = store.clearances.find(n => n.id === id) || { id }
    const merged = { ...existing, ...(body || {}), id, updated_at: new Date().toISOString() }
    store.clearances = store.clearances.map(n => n.id === id ? merged : n)
    if (!store.clearances.find(n => n.id === id)) store.clearances.push(merged)
    return ok(merged)
  }},
  { m: /^\/clearances/, fn: (method, _url, body) => {
    store.clearances = store.clearances || []
    if (method === 'POST') {
      const next = { id: Date.now(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), created_by: 'Demo', ...(body || {}) }
      store.clearances.unshift(next)
      return ok(next)
    }
    return ok(store.clearances)
  }},
  // Saved vendor emails — sub-path must appear BEFORE the /bk/vendors
  // catch-all. GET returns the demo list; POST adds; DELETE removes.
  { m: /^\/bk\/vendors\/emails/, fn: (method, url, body) => {
    store.vendorEmails = store.vendorEmails || []
    if (method === 'POST') {
      const next = { id: Date.now(), vendor_name: body?.payee || '', email: body?.email || '', label: body?.label || null, created_by: 'Demo', created_at: new Date().toISOString() }
      store.vendorEmails.push(next)
      return ok(next)
    }
    if (method === 'DELETE') {
      const id = Number(String(url).split('/').pop())
      store.vendorEmails = store.vendorEmails.filter(v => v.id !== id)
      return ok({})
    }
    const payee = decodeURIComponent(String(url).split('/').pop().split('?')[0] || '').toLowerCase()
    return ok(store.vendorEmails.filter(v => (v.vendor_name || '').toLowerCase() === payee))
  }},
  // Added-expense vendors page needs the nested object shape.
  { m: /^\/bk\/vendors\/unified/, fn: () => ok({ vendors: [], unlinked: [] }) },
  { m: /^\/bk\/vendors\/added-expenses/, fn: () => ok({ vendors: [], dupePairs: [], nameVariants: [] }) },
  { m: /^\/bk\/vendors/,   fn: () => ok(store.vendors) },
  { m: /^\/bk\/invoices/, fn: (_, url) => {
    // Filter by status when the client sends ?status=rejected|pending;
    // default (or ?status=approved) returns the store's expenses. Demo
    // store has no rejected rows, so ?status=rejected returns [].
    const m = String(url || '').match(/[?&]status=([^&]+)/)
    const status = m ? decodeURIComponent(m[1]).toLowerCase() : 'approved'
    if (status !== 'approved') {
      return ok((store.expenses || []).filter(e => (e.status || 'approved').toLowerCase() === status))
    }
    return ok(store.expenses)
  }},
  { m: /^\/bk\/lookup/,    fn: () => ok([]) },
  { m: /^\/bk\/bulk-deals/, fn: () => ok([]) },
  { m: /^\/bk\/history/,   fn: () => ok([]) },
  { m: /^\/bk\/approval-history/, fn: () => ok([]) },
  { m: /^\/bk\//,          fn: () => ok([]) },

  // ── Team / tasks ─────────────────────────────────────────────────────────
  // Real backend shapes:
  //   GET /team          → array of users
  //   GET /team/users    → array of users
  //   GET /team/my-work  → { releases, upcoming, tasks, activity }
  //   GET /team/velocity → array (admin only IRL)
  // Specific routes first so they beat the /^\/team/ catch-all.
  { m: /^\/team\/users/,    fn: () => ok(store.team) },
  { m: /^\/team\/my-work/,  fn: () => ok({
    releases: [],
    upcoming: [],
    tasks: store.tasks,
    activity: store.activity,
  }) },
  { m: /^\/team\/velocity/, fn: () => ok([]) },
  { m: /^\/team\/workload/, fn: () => ok([]) },
  { m: /^\/team\/tasks/,    fn: () => ok({ id: Date.now() }) }, // create/update/delete
  { m: /^\/team/,           fn: () => ok(store.team) },

  // ── Financials ───────────────────────────────────────────────────────────
  // Real backend shapes:
  //   GET /financials          → { artists, totals, bookkeeping_connected }
  //   GET /financials/summary  → { trends, topVendors, categories,
  //                                budgetAlerts, thisMonth:{total,count},
  //                                lastMonth:{total,count} }
  // The page renders summary.thisMonth.total with no optional chaining, so
  // both inner objects must always exist.
  { m: /^\/financials\/summary/, fn: () => ok({
    trends: [],
    topVendors: [],
    categories: [],
    budgetAlerts: [],
    thisMonth: { total: 0, count: 0 },
    lastMonth: { total: 0, count: 0 },
  }) },
  // KPI drill-down rows — empty in demo mode so the modal opens with
  // a "no invoices" state.
  { m: /^\/financials\/exec\/rows/, fn: () => ok({
    bucket: 'this_week', from: null, to: null, paid_only: true,
    rows: [], total_usd: 0, row_count: 0,
  }) },
  // Top-spend sub-breakdown — empty in demo mode. Nested view opens
  // with a "no categorized spend" message instead of a 404.
  { m: /^\/financials\/exec\/subbreakdown/, fn: () => ok({
    dimension: 'artist', value: '', categories: [],
  }) },
  // Multi-sheet Excel export — placeholder blob so demo mode doesn't
  // 404 the download. Real endpoint returns a populated workbook.
  { m: /^\/financials\/export/, fn: () => ({
    status: 200,
    data: new Blob(
      ['Market Street — Financials (demo export placeholder)'],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    ),
  }) },
  // Month detail — zeroed envelope. Placed BEFORE /exec (both start
  // with /financials/) so the more specific path wins in matcher
  // order. Test users see the layout without pretend numbers.
  { m: /^\/financials\/month\/([^/?]+)/, fn: (_, __, ___, args) => {
    const m = String(args?.[0] || '')
    const [y, mm] = m.split('-').map(n => parseInt(n, 10))
    const fmtLabel = (yy, mo) => new Date(yy, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    const validYm = Number.isFinite(y) && Number.isFinite(mm)
    const label = validYm ? fmtLabel(y, mm) : m
    // Prev / next month strings — same logic as the server so the
    // hop-nav buttons in the header don't 404 in demo mode.
    const prevD = validYm ? new Date(y, mm - 2, 1) : null
    const nextD = validYm ? new Date(y, mm,     1) : null
    const monthStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    return ok({
      month: m,
      month_label: label,
      prev_month:       prevD ? monthStr(prevD) : m,
      next_month:       nextD ? monthStr(nextD) : m,
      prev_month_label: prevD ? fmtLabel(prevD.getFullYear(), prevD.getMonth() + 1) : label,
      next_month_label: nextD ? fmtLabel(nextD.getFullYear(), nextD.getMonth() + 1) : label,
      summary: {
        total_usd: 0, paid_usd: 0, unpaid_usd: 0,
        total_count: 0, paid_count: 0, unpaid_count: 0,
        artist_count: 0, vendor_count: 0,
        received_count: 0, received_usd: 0,
        avg_invoice_usd: 0,
      },
      prev_summary: { total_usd: 0, paid_usd: 0, unpaid_usd: 0, total_count: 0, received_usd: 0 },
      daily: [],
      artists: [], categories: [], vendors: [], invoices: [],
    })
  }},
  // Exec dashboard — zeroed envelope. Test users see the layout but
  // no numbers, avoiding the "why does demo show real money" question.
  { m: /^\/financials\/exec/, fn: () => ok({
    kpi: {
      this_week: 0, last_week: 0, mtd: 0, last_mtd: 0, ytd: 0, last_ytd: 0,
      unpaid_total: 0, unpaid_count: 0,
    },
    weeks: [],
    breakdowns: { artist: [], song: [], category: [] },
    aging: { '0-30': { count: 0, usd: 0 }, '30-60': { count: 0, usd: 0 }, '60-90': { count: 0, usd: 0 }, '90+': { count: 0, usd: 0 }, not_yet_due: { count: 0, usd: 0 } },
    upcoming: { in_7: { count: 0, usd: 0 }, in_30: { count: 0, usd: 0 }, in_60: { count: 0, usd: 0 } },
    category_trend: { months: [], categories: [] },
    recoupment: [],
    vendors: { rows: [], grand_total: 0 },
    velocity: { buckets: [], median_days: 0, mean_days: 0, paid_count: 0 },
    methods: [],
    reps: [],
    forecast: {
      weekly_avg_usd: 0,
      in_30: { committed: 0, projected: 0 },
      in_60: { committed: 0, projected: 0 },
      in_90: { committed: 0, projected: 0 },
    },
    filters: { applied: false, artist: null, category: null, rep: null },
  }) },
  // Filter-options envelope — empty so the dropdowns render but have
  // no entries. Test users can still click the field to see the UI.
  { m: /^\/financials\/filter-options/, fn: () => ok({
    artists: [], categories: [], reps: [],
  }) },
  // Budgets — recording budget feature. Session-only store, matches
  // the server response shape { data: [...] } for list, and { data:
  // { ...budget, sections: {...} } } for detail. Full CRUD supported
  // in demo mode so test users can play with the UI.
  { m: /^\/budgets\/expense\/(\d+)\/section/, fn: () => ok({}) },
  { m: /^\/budgets\/(\d+)\/actuals/, fn: () => ok({
    match_name: null, by_section: {}, unmapped: [], all: [], summary: {}, section_labels: [],
  }) },
  { m: /^\/budgets\/(\d+)\/(approve|lock|reopen)/, fn: (_, __, ___, args) => {
    const st = args?.[1] === 'approve' ? 'approved' : args?.[1] === 'lock' ? 'locked' : 'draft'
    return ok({ id: Number(args?.[0]), status: st })
  }},
  { m: /^\/budgets\/(\d+)\/line-items(?:\/(\d+))?/, fn: (method, _url, body, args) => {
    if (method === 'DELETE') return ok({})
    if (method === 'PUT')    return ok({ id: Number(args?.[1]), ...body })
    return ok({ id: Math.floor(Math.random() * 1e9), budget_id: Number(args?.[0]), ...body,
                amount: (Number(body?.qty) || 0) * (Number(body?.unit_price) || 0) })
  }},
  { m: /^\/budgets\/(\d+)/, fn: (method, _url, body, args) => {
    if (method === 'DELETE') return ok({})
    if (method === 'PUT')    return ok({ id: Number(args?.[0]), ...body, sections: { producers: [], studio: [], mixing_mastering: [], musicians: [], travel: [], other: [] } })
    // GET
    return ok({
      id: Number(args?.[0]),
      artist_id: null, release_id: null, artist_name: 'Demo Artist', artist_display: 'Demo Artist',
      project_title: 'Demo Project', type: 'budget', currency: 'USD',
      advance_amount: 0, fund_amount: 0, proposed_tracks: 12, contingency_pct: 7.5,
      status: 'draft',
      sections: { producers: [], studio: [], mixing_mastering: [], musicians: [], travel: [], other: [] },
      section_totals: { producers: 0, studio: 0, mixing_mastering: 0, musicians: 0, travel: 0, other: 0 },
      sections_subtotal: 0, contingency_amount: 0, total_budget: 0,
    })
  }},
  { m: /^\/budgets/, fn: (method, _url, body) => {
    if (method === 'POST') return ok({ id: Math.floor(Math.random() * 1e9), ...body, status: 'draft' })
    return ok([])
  }},

  { m: /^\/financials/, fn: () => ok({
    artists: [],
    totals: { budget: 0, spent: 0, variance: 0, unpaid: 0, income: 0, net_pl: 0 },
    bookkeeping_connected: false,
  }) },

  // ── Salary / recoupments / calendar ─────────────────────────────────────
  // Salary: GET list is an array; employee create/edit/delete echo a row so
  // the demo UI updates instead of silently failing.
  { m: /^\/salary\/history/, fn: () => ok([]) },
  { m: /^\/salary/, fn: (method, _url, body) => {
    if (method === 'POST' || method === 'PUT') return ok({ id: Date.now(), ...(body || {}) })
    if (method === 'DELETE') return ok({})
    return ok([])
  }},
  { m: /^\/recoupments/, fn: () => ok(store.expenses.filter(e => e.recoupable)) },

  // ── Email preview/send (EmailPreviewModal) ──────────────────────────────
  { m: /^\/email\/preview/, fn: (_m, _url, body) => ok({
    to: '', cc: '', subject: 'Demo mode', message: '',
    html: '<p style="font-family:sans-serif">Demo mode — emails are not sent for test accounts.</p>',
    attachmentLabels: [], kind: body?.kind || null,
  }) },
  { m: /^\/email\/send/, fn: () => ok({ to: '', cc: '' }) },

  // ── Artist Campaigns — sub-routes BEFORE the catch-all ─────────────────
  // `/link`, `/dismiss`, `/restore` are POST-only mutations against
  // influencer_campaigns / flag_dismissals. Demo store has neither, so the
  // matchers just acknowledge so the optimistic UI flow finishes.
  // Review inbox + chat — object shapes, must precede the index catch-all
  // (which returns a flat array and made these features white-page/no-op).
  { m: /^\/artist-campaigns\/review-feed/, fn: () => ok({ flags: [], comments: [], assignments: {} }) },
  { m: /^\/artist-campaigns\/review-assign/, fn: (_m, _url, body) => ok({ assignments: { [body?.entry_id]: [] } }) },
  { m: /^\/artist-campaigns\/chat\/messages\//, fn: (method, _url, body) => (
    method === 'DELETE' ? ok({}) : ok({ id: Date.now(), body: body?.body || '', edited_at: new Date().toISOString() })
  ) },
  { m: /^\/artist-campaigns\/chat\/[^/]+\/read/, fn: () => ok({}) },
  { m: /^\/artist-campaigns\/chat\//, fn: (method, _url, body) => {
    if (method === 'POST') return ok({
      id: Date.now(), user_id: 0, user_name: 'Demo', body: body?.body || '',
      created_at: new Date().toISOString(), edited_at: null, deleted: false,
    })
    return ok({ messages: [], last_read_id: 0 })
  }},
  { m: /^\/artist-campaigns\/link/, fn: () => ok({ id: null, expense_id: null }) },
  { m: /^\/artist-campaigns\/dismiss/, fn: () => ok({}) },
  { m: /^\/artist-campaigns\/restore/, fn: () => ok({}) },
  { m: /^\/artist-campaigns\/not-campaign/, fn: () => ok({}) },
  // Rename-song — matched BEFORE the catch-all /:artist route below so
  // the URL doesn't fall through to the artist-detail handler. Demo
  // mode reports zero rows changed since the in-memory expenses store
  // isn't wired to reflect the rename here.
  { m: /^\/artist-campaigns\/[^/?]+\/rename-song/, fn: () => ok({ ledger_rows: 0, release_rows: 0 }) },
  // Excel export — real server returns a .xlsx blob; demo mode returns
  // a stub blob so the download flow triggers without a 404. The blob
  // is a minimal well-formed placeholder; test users get a file they can
  // save, just not a populated workbook.
  { m: /^\/artist-campaigns\/export/, fn: () => ({
    status: 200,
    data: new Blob(
      ['Market Street — Artist Campaigns (demo export placeholder)'],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    ),
  }) },
  // Artist priority meta moved to /bk/artist-meta (shared with Recoupments
  // — same artist priority shows on both pages). That matcher lives above.
  // `/:artist[/:song]` returns the per-artist detail (ledger + campaigns).
  // The mock store has no influencer_campaigns, so campaigns is always [].
  { m: /^\/artist-campaigns\/([^/?]+)/, fn: (method, url, body, m) => {
    const artist = decodeURIComponent(m[0] || '')
    // Mirrors the real route, which excludes statement-born rows from all
    // seven of its expense queries (server/lib/ledger-source.js). The demo
    // store has two `entry_source: 'bank_statement'` rows and one carries an
    // artist, so without this the mock page shows a row the live page won't.
    const ledger = (store.expenses || []).filter(e =>
      (e.artist || '').toLowerCase() === artist.toLowerCase()
      && e.entry_source !== 'bank_statement'
    )
    // Return releases from the demo store so the artist page renders
    // song subpage cards even when no expenses are on file yet.
    const artistRow = (store.artists || []).find(a =>
      (a.name || '').toLowerCase() === artist.toLowerCase()
    )
    const releases = artistRow
      ? (store.releases || []).filter(r => r.artist_id === artistRow.id).map(r => ({
          id: r.id,
          project_name: r.project_name,
          release_date: r.release_date,
          release_type: r.release_type,
        }))
      : []
    return ok({
      artist,
      artist_id: artistRow?.id || null,
      ledger,
      campaigns: [],
      releases,
      dismissed_count: 0,
    })
  } },
  // Index → one row per artist with any expense. Empty in the demo store.
  { m: /^\/artist-campaigns/, fn: () => ok([]) },
  { m: /^\/calendar/,    fn: () => ok([]) },
  { m: /^\/catalog/,     fn: () => ok({ data: store.artists, total: store.artists.length }) },

  // ── Requests / activity ─────────────────────────────────────────────────
  { m: /^\/requests/,   fn: () => ok([]) },
  { m: /^\/activity/,   fn: () => ok(store.activity) },
  { m: /^\/marketing/,  fn: () => ok([]) },
  // Data-quality flags. Test users see a clean world — no duplicates, no
  // missing metadata — so buckets/categories are empty and dismiss/restore
  // are no-op successes. Sub-paths first, then the catch-all.
  { m: /^\/flags\/artist-issues\/dismiss/, fn: () => ok({ dismissed: true }) },
  { m: /^\/flags\/artist-issues\/restore/, fn: () => ok({ restored: true }) },
  { m: /^\/flags\/artist-issues/,          fn: () => ok({ buckets: [], dismissed: [] }) },
  { m: /^\/flags\/group\/dismiss/,         fn: () => ok({ dismissed: true }) },
  { m: /^\/flags\/artist-multi\/apply/,    fn: () => ok({ renamed: 0 }) },
  // GET /api/flags returns the categories ARRAY directly, not { categories }.
  // The old object form here meant the Flags hub always fell into its catch
  // and rendered empty for test users.
  { m: /^\/flags/,                         fn: () => ok([]) },
  { m: /^\/dsp/,        fn: () => ok([]) },
  { m: /^\/import/,     fn: () => ok([]) },
  { m: /^\/search/,     fn: () => ok([]) },

  // ── Vendor submit (admin side) ──────────────────────────────────────────
  // Specific first — the roster matcher must beat the catch-all below.
  { m: /^\/vendor\/roster/, fn: () => ok({ artists: (store.artists || []).map(a => a.name).filter(Boolean).sort() }) },
  { m: /^\/vendor\//,   fn: () => ok({ on_file: false }) },

  // ── Settings read-only (identity + prefs) ───────────────────────────────
  // auth/me and settings/me/password routes are NOT mocked — they pass through.
  // Sub-path before /settings/permissions so 'permission-templates' isn't
  // swallowed (it isn't — different prefix — but keep them adjacent).
  { m: /^\/settings\/permission-templates/, fn: (method, _url, body) => {
    if (method === 'POST') return ok({ id: Date.now(), name: body?.name || '', pages: body?.pages || [], created_by: 'Demo', updated_at: new Date().toISOString() })
    if (method === 'DELETE') return ok({})
    return ok([])
  }},
  { m: /^\/settings\/permissions/, fn: () => ok([]) },
  // User rep allow-list — session-scoped { user_id: [reps] } map.
  // GET returns the current map; POST adds; DELETE removes. Test users
  // won't see real non-admins so this stays an empty map in practice,
  // but the matcher prevents white-page risk if a test user opens
  // Settings → Permissions.
  { m: /^\/settings\/visible-reps/, fn: (method, _url, body) => {
    store.__visibleReps = store.__visibleReps || {}
    if (method === 'GET') return ok({ ...store.__visibleReps })
    const uid = String(body?.user_id || '')
    const rep = String(body?.visible_rep || '').trim()
    if (!uid || !rep) return ok({})
    if (method === 'POST') {
      const list = store.__visibleReps[uid] || []
      if (!list.includes(rep)) store.__visibleReps[uid] = [...list, rep].sort()
      return ok({})
    }
    if (method === 'DELETE') {
      store.__visibleReps[uid] = (store.__visibleReps[uid] || []).filter(r => r !== rep)
      return ok({})
    }
    return ok({})
  }},
  { m: /^\/settings\/users/, fn: () => ok([]) },
  { m: /^\/settings\/test-users/, fn: () => ok([]) },
  // Market Street Reps registry. /reps is the public list consumed by every
  // dropdown across the app; /settings/reps is the admin CRUD view.
  // Demo store starts with a couple of names so test-user
  // dropdowns aren't empty.
  { m: /^\/reps$/, fn: () => {
    store.__boomReps = store.__boomReps || [
      { name: 'John', active: true }, { name: 'Demo Alex', active: true },
    ]
    return ok(store.__boomReps.filter(r => r.active).map(r => r.name))
  } },
  { m: /^\/settings\/reps(\/|$)/, fn: (method, url, body) => {
    store.__boomReps = store.__boomReps || [
      { name: 'John', active: true }, { name: 'Demo Alex', active: true },
    ]
    if (method === 'GET') return ok(store.__boomReps.slice())
    if (method === 'POST') {
      const name = String(body?.name || '').trim()
      if (!name) return ok({})
      const existing = store.__boomReps.find(r => r.name.toLowerCase() === name.toLowerCase())
      if (existing) existing.active = true
      else store.__boomReps.push({ name, active: true })
      return ok({})
    }
    if (method === 'PATCH') {
      // URL = /settings/reps/<name>
      const m = url.match(/\/settings\/reps\/([^/?]+)/)
      const name = m ? decodeURIComponent(m[1]) : ''
      const rep = store.__boomReps.find(r => r.name === name)
      if (rep && typeof body?.active === 'boolean') rep.active = body.active
      return ok({})
    }
    return ok({})
  } },
]

export function resolveMock(method, url, body) {
  const path = normalise(url)
  for (const { m, fn } of MATCHERS) {
    const mx = path.match(m)
    if (mx) {
      try { return fn(method, url, body, mx.slice(1)) }
      catch (err) {
        console.warn('[demo mock] matcher threw', err)
        return ok([])
      }
    }
  }
  // Unknown — return a safe shape so the UI doesn't error out.
  return ok([])
}
