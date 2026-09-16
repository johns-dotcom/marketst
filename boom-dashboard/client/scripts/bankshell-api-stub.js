// A stubbed api for scripts/bankshell-dom-entry.jsx.
//
// Fixtured rather than proxied because the thing under test is a COUNT of
// requests: the whole point of the shared store is that four tabs cost one
// /statements/:id, and you cannot assert "exactly one read" against a live
// server whose other callers are also reading.
//
// Two statements, one of which ties and one of which does not, because the
// tie-out has two renderings and only one of them is the happy path.
export const calls = { get: [], post: [], put: [], del: [] }

export const STATEMENTS = [
  { id: 501, account: 'bofa', status: 'ready', period_start: '2026-05-01', period_end: '2026-05-31',
    beginning_balance: '1000.00', ending_balance: '820.00', filename: 'eStmt_2026-05-31.pdf' },
  { id: 502, account: 'paypal', status: 'ready', period_start: '2026-06-01', period_end: '2026-06-30',
    beginning_balance: null, ending_balance: '0.00', filename: 'pp-2026-06.csv' },
  { id: 503, account: 'bofa', status: 'parsing', period_start: '2026-07-01', period_end: '2026-07-31',
    beginning_balance: null, ending_balance: null, filename: 'eStmt_2026-07-31.pdf' },
]

// 501: opened 1000 + in 100 − out 280 = 820, which is exactly what it prints.
const TX_501 = [
  { id: 9101, statement_id: 501, txn_date: '2026-05-04', direction: 'debit', amount: '200.00', usd: 200,
    payee_guess: 'TONE PAY INC', description: 'Payment', matched_expense_id: 77, match_method: 'created',
    dismissed: false, currency: 'USD' },
  { id: 9102, statement_id: 501, txn_date: '2026-05-09', direction: 'debit', amount: '80.00', usd: 80,
    payee_guess: 'PAYPAL', description: 'Transfer', matched_expense_id: null, dismissed: false, currency: 'USD' },
  { id: 9103, statement_id: 501, txn_date: '2026-05-12', direction: 'credit', amount: '100.00', usd: 100,
    payee_guess: 'ROYALTY DEPOSIT', description: 'Deposit', matched_income_id: 5, dismissed: false, currency: 'USD' },
]

// 502: PayPal, no balances to tie against — the branch that must NOT read as a
// failed check.
const TX_502 = [
  { id: 9201, statement_id: 502, txn_date: '2026-06-02', direction: 'debit', amount: '50.00', usd: 50,
    payee_guess: 'EGOFLOW', description: 'Invoice 22', matched_expense_id: 81, match_method: 'match',
    dismissed: false, currency: 'USD' },
]

const DETAIL = {
  501: { statement: STATEMENTS[0], transactions: TX_501 },
  502: { statement: STATEMENTS[1], transactions: TX_502 },
}

const COMPLETION = {
  left_all: 14, left_all_value: 23552.4,
  needs_invoice_txn_ids: [9101],
  by_statement: { 501: { left: 2, left_value: 280 }, 502: { left: 0, left_value: 0 } },
  matched: { n: 1, value: 50 }, invoice_backed_pct: 40, explained_pct: 80,
}

const ok = (data) => Promise.resolve({ data: { success: true, data } })

const api = {
  get: (url, cfg) => {
    calls.get.push({ url, params: cfg?.params })
    if (url === '/statements') return ok(STATEMENTS)
    const m = /^\/statements\/(\d+)$/.exec(url)
    if (m) return ok(DETAIL[m[1]] || null)
    if (url.startsWith('/statements/completion')) return ok(COMPLETION)
    if (url === '/statements/all') return ok({ statement: null, transactions: [...TX_501, ...TX_502] })
    if (url.startsWith('/statements/rematch-candidates')) return ok({ pairs: [] })
    if (url.startsWith('/statements/rule-suggestions')) return ok([])
    if (url.startsWith('/statements/auto-decisions')) return ok([])
    if (url === '/statements/rules') return ok([])
    if (url === '/statements/category-rules') return ok([])
    if (url.startsWith('/statements/funding-pairs')) return ok({ proposals: [], unnamed: [] })
    if (url === '/bk/artist-names') return ok([])
    if (url === '/artists') return ok([])
    if (url === '/categories') return ok({ expense: [], income: [], expense_groups: [], expense_order: [] })
    if (url === '/reps') return ok([])
    if (url === '/flags') return ok({})
    return ok([])
  },
  post: (url, body) => { calls.post.push({ url, body }); return ok({}) },
  put: (url, body) => { calls.put.push({ url, body }); return ok({}) },
  delete: (url) => { calls.del.push({ url }); return ok({}) },
  defaults: { headers: { common: {} } },
  interceptors: { request: { use() {} }, response: { use() {} } },
}

export default api
