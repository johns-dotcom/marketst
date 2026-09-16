// A stubbed api for scripts/statementrecon-dom-entry.jsx.
//
// Fixtured rather than proxied, because what is under test is ARITHMETIC: the
// page total, a month subtotal and a statement's own bar are three reductions
// that must agree, and the only way to assert they do is to know the answer
// before the page renders it. Against live data you can read the three numbers
// and still not know which one is wrong.
//
// The /statements payload deliberately carries the OLD, WRONG columns
// (`matched`, `debits`, `coverage`, `open_debits`) at values that cannot be
// confused with the right ones — 89% against a true 15%. If the page ever
// prints one of them again, the harness sees 89 and fails.
export const calls = { get: [], post: [], put: [], del: [] }

// Set by the harness before the second mount, to prove a FAILED reconciliation
// request renders as "unknown" and never as "0 left, 100%".
export const control = { reconFails: false }

// ── 601 · BofA, May ──────────────────────────────────────────────────────────
// in scope $20,000: accounted $3,000 (15%), left $17,000, excluded $900.
// Four booked lines still owed an invoice are the bulk of it — the exact shape
// the old bar hid by counting a booked row as matched.
const R601 = {
  debits: {
    matched: { n: 1, value: 2000 },
    creator: { n: 1, value: 500 },
    no_invoice_due: { n: 1, value: 500 },
    needs_invoice: { n: 4, value: 15000 },
    open: { n: 1, value: 2000 },
    excluded: { n: 1, value: 900 },
  },
  credits: {
    booked: { n: 1, value: 3000 },
    open: { n: 2, value: 250 },
    excluded: { n: 0, value: 0 },
  },
}

// ── 602 · PayPal, May ────────────────────────────────────────────────────────
// in scope $10,000, half of it still with no ledger entry at all.
const R602 = {
  debits: {
    matched: { n: 1, value: 5000 },
    creator: { n: 0, value: 0 },
    no_invoice_due: { n: 0, value: 0 },
    needs_invoice: { n: 0, value: 0 },
    open: { n: 1, value: 5000 },
    excluded: { n: 0, value: 0 },
  },
  credits: { booked: { n: 0, value: 0 }, open: { n: 0, value: 0 }, excluded: { n: 0, value: 0 } },
}

// ── 603 · BofA, April ────────────────────────────────────────────────────────
// Finished. Its month must read 100% / clear while May reads 27%, or the two
// month rows are being fed by the same number.
const R603 = {
  debits: {
    matched: { n: 1, value: 1000 },
    creator: { n: 0, value: 0 },
    no_invoice_due: { n: 0, value: 0 },
    needs_invoice: { n: 0, value: 0 },
    open: { n: 0, value: 0 },
    excluded: { n: 0, value: 0 },
  },
  credits: { booked: { n: 0, value: 0 }, open: { n: 0, value: 0 }, excluded: { n: 0, value: 0 } },
}

export const RECON = { 601: R601, 602: R602, 603: R603 }

export const STATEMENTS = [
  // debits/matched/coverage/open_debits are the OLD columns, left deliberately
  // at values the new arithmetic can never produce.
  { id: 601, account: 'bofa', status: 'ready', period_start: '2026-05-01', period_end: '2026-05-31',
    filename: 'eStmt_2026-05-31.pdf', debits: 9, matched: 8, dismissed: 1, open_debits: 1, r2_key: null },
  { id: 602, account: 'paypal', status: 'ready', period_start: '2026-05-01', period_end: '2026-05-31',
    filename: 'pp-2026-05.csv', debits: 2, matched: 1, dismissed: 0, open_debits: 1, r2_key: null },
  { id: 603, account: 'bofa', status: 'ready', period_start: '2026-04-01', period_end: '2026-04-30',
    filename: 'eStmt_2026-04-30.pdf', debits: 1, matched: 1, dismissed: 0, open_debits: 0, r2_key: null },
]

// Both accounts present in May so `missing` is empty and the reconcile gate
// turns purely on open lines — the condition under test.
const MONTHS = [
  { month_key: '2026-05', accounts: ['bofa', 'paypal'], debits: 11, matched: 9, dismissed: 1,
    open_debits: 2, open_credits: 2, coverage: 91, reconciled_by: null, reconciled_at: null },
  { month_key: '2026-04', accounts: ['bofa', 'paypal'], debits: 1, matched: 1, dismissed: 0,
    open_debits: 0, open_credits: 0, coverage: 100, reconciled_by: null, reconciled_at: null },
]

const ok = (data) => Promise.resolve({ data: { success: true, data } })

const api = {
  get: (url, cfg) => {
    calls.get.push({ url, cfg })
    if (url === '/statements') return ok(STATEMENTS)
    if (url === '/statements/reconciliation') {
      if (control.reconFails) return Promise.reject(new Error('reconciliation is down'))
      return ok({ by_statement: RECON })
    }
    if (url === '/statements/months') return ok(MONTHS)
    // The bands these feed are out of scope here; each is written to render
    // nothing rather than to throw.
    if (url === '/statements/integrity') return ok(null)
    if (url === '/statements/flags') return ok({ flags: [], acked: [] })
    if (url === '/statements/extras') return ok([])
    if (url === '/reminders') return ok([])
    return ok([])
  },
  post: (url, body) => { calls.post.push({ url, body }); return ok({}) },
  put: (url, body) => { calls.put.push({ url, body }); return ok({}) },
  delete: (url) => { calls.del.push({ url }); return ok({}) },
}

export default api
