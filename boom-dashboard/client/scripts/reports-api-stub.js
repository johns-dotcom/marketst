// The Reports page's data, stubbed at the api boundary. Scenario via
// globalThis.__REPORTS_SCENARIO__:
//   full     six months of P&L on the ledger default, charts, compare, pack
//   empty    every series zero — the charts must say so, not draw nothing
//   bs       the balance sheet with no statement (cash unknown)
//   vendors  the Vendors tab
//   budget   the Budget vs actual tab
export const calls = { get: [], post: [], put: [], del: [] }
const scenario = () => globalThis.__REPORTS_SCENARIO__ || 'full'
const ok = (data) => Promise.resolve({ data: { success: true, data } })
const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']
const series = (vals) => Object.fromEntries(MONTHS.map((m, i) => [m, vals[i] || 0]))
const sum = (s) => Object.values(s).reduce((a, b) => a + b, 0)

function pnl(basis, from, scale = 1) {
  const empty = scenario() === 'empty'
  const mk = (vals) => series(empty ? [] : vals.map((v) => v * scale))
  const income = { Royalties: mk([1000, 1200, 900, 1500, 1100, 1300]) }
  const expenses = { Marketing: mk([400, 500, 450, 600, 520, 610]), Recording: mk([200, 0, 300, 0, 250, 0]), 'Bank Fees': mk([10, 10, 10, 10, 10, 10]) }
  const tot = (map) => { const s = series([]); for (const line of Object.values(map)) for (const m of MONTHS) s[m] += line[m]; return { series: s, total: sum(s) } }
  const it = tot(income), et = tot(expenses)
  const net = series([]); for (const m of MONTHS) net[m] = it.series[m] - et.series[m]
  const zero = { series: series([]), total: 0 }
  const months = MONTHS
  return {
    months, income, expenses, income_totals: it, expense_totals: et, net: { series: net, total: sum(net) },
    below: { income: {}, expenses: {}, income_totals: zero, expense_totals: zero, net: zero },
    non_recurring: { income: {}, expenses: {}, income_totals: zero, expense_totals: zero, net: zero },
    contra: {}, unverified: { series: series([]), total: 0, count: 0, dismissed_count: 0 },
    evidence: { invoice: et.total, invoice_n: 12, invented: 0, invented_n: 0, none: 0, none_n: 0, below_line: 0, non_recurring: 0 },
    dismissed: { count: 0, total: 0, series: series([]), by_cell: {}, categories: [], category_count: 0, category_total: 0, item_count: 0 },
    reversals: { count: 0, total: 0, series: series([]), pairs: [] },
    reassigned: { count: 0, total: 0, moved_out: { count: 0, total: 0, rows: [] } },
    coverage: { pct: 100 }, artists: ['Rosa Vale', 'Night Owls'], artist: null, category_usage: {},
    basis, basis_label: { bank: 'Bank statements', ledger: 'Ledger — paid', accrual: 'Accrual — invoiced' }[basis],
    by_artist: { total: et.total, artists: empty ? [] : [{ key: 'rosavale', name: 'Rosa Vale', total: et.total * 0.6, by_category: {} }, { key: 'nightowls', name: 'Night Owls', total: et.total * 0.3, by_category: {} }], unattributed: { total: et.total * 0.1 }, ties_to_pnl: true, pnl_expense_total: et.total },
    advances_by_artist: { total: 0, artists: [] },
    from,
  }
}

const api = {
  get(url, opts) {
    const params = opts?.params || {}
    calls.get.push({ url, params })
    if (url === '/reports/basis') return ok({ default: 'ledger', reconciled_through: null, statements: 0, bases: {} })
    if (url === '/reports/pnl') return ok(pnl(params.basis || 'bank', params.from, params.from < '2026-01-01' ? 0.8 : 1))
    if (url === '/reports/intake') return ok({ months: MONTHS, series: Object.fromEntries(MONTHS.map((m, i) => [m, { count: scenario() === 'empty' ? 0 : 3 + i, usd: scenario() === 'empty' ? 0 : 700 + i * 50, pending_usd: 100, pending_count: 1, approved_usd: 300, paid_usd: 300 }])), total: 4500, count: 33 })
    if (url === '/reports/spend-by') return ok({ months: MONTHS, dim: params.dim, basis: params.basis, basis_label: 'Ledger — paid', count: 2, total: 3100, rows: [
      { key: params.dim === 'rep' ? 'Sam' : 'Northgate Studios', series: series([300, 300, 300, 300, 300, 300]), total: 1800, count: 6, top_category: 'Recording' },
      { key: params.dim === 'rep' ? 'Rosa' : 'Blue Room PR', series: series([200, 200, 200, 300, 200, 200]), total: 1300, count: 6, top_category: 'Marketing' },
    ] })
    if (url === '/reports/budget-vs-actual') return ok({ basis: 'ledger', basis_label: 'Ledger — paid', budgeted: 2, over: 1, rows: [
      { key: 'rosavale', name: 'Rosa Vale', artist_id: 1, budget_marketing: 5000, spent_marketing_range: 1200, spent_marketing_life: 5600, left_marketing: -600, over_marketing: true, budget_advance: 10000, advance_paid_life: 10000, left_advance: 0, has_budget: true },
      { key: 'nightowls', name: 'Night Owls', artist_id: 2, budget_marketing: 2000, spent_marketing_range: 400, spent_marketing_life: 900, left_marketing: 1100, over_marketing: false, budget_advance: 0, advance_paid_life: 0, left_advance: null, has_budget: true },
    ], totals: { budget_marketing: 7000, spent_marketing_range: 1600, spent_marketing_life: 6500, budget_advance: 10000, advance_paid_life: 10000 } })
    if (url.startsWith('/reports/balance-sheet')) return ok({ as_of: '2026-06-30', assets: { cash: [], cash_total: 0, accounts_receivable: { total: 1200, count: 1, aging: { current: 1200, d60: 0, d90: 0, over90: 0 }, breakdown: [], breakdown_label: 'client' }, total: 1200 },
      liabilities: { accounts_payable: { total: 800, count: 2, aging: { current: 800, d60: 0, d90: 0, over90: 0 }, breakdown: [], breakdown_label: 'category' }, total: 800 },
      net_assets: { total: 400, note: 'Assets − Liabilities' }, excluded: { lines: [], line_count: 0, line_total: 0, item_count: 0, item_total: 0, total: 0 },
      funding: { hidden: false, drawdowns: { total: 0, count: 0, breakdown: [] }, accumulated_deficit: { total: 400, note: '' }, total: 400, memo: { recoupable: { total: 0, count: 0 } } }, equity: { total: 400 },
      proof: { balances: null, cash_known: false, note: 'No bank statement has been uploaded, so cash is UNKNOWN — not zero.', sources: [{ line: 'Accounts receivable', from: 'issued invoices unpaid' }, { line: 'Accounts payable', from: 'approved bills unpaid' }] } })
    if (url === '/reports/pack/settings') return ok({ id: 1, enabled: false, day: 5, recipients: '', basis: 'bank', last_sent_period: null, last_sent_at: null, last_error: null })
    if (url.startsWith('/reports/pack.xlsx')) return Promise.resolve({ data: new Uint8Array([80, 75]) })
    if (url.startsWith('/reports/dismissals')) return ok([])
    if (url === '/categories') return ok({ expense: ['Marketing', 'Recording'], income: ['Royalties'], expense_groups: [], expense_order: ['Marketing', 'Recording'] })
    if (url.startsWith('/statements/months')) return ok({ months: [] })
    return ok([])
  },
  post(url, body) { calls.post.push({ url, body }); return ok({ sent_to: ['acct@example.test'], filename: 'marketst-accountant-pack.xlsx' }) },
  put(url, body) { calls.put.push({ url, body }); return ok({ id: 1, enabled: !!body.enabled, day: body.day || 5, recipients: body.recipients || '', basis: body.basis || 'bank' }) },
  delete(url) { calls.del.push(url); return ok({}) },
}
export default api
