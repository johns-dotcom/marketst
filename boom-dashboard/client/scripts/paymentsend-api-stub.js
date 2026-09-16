// A stubbed api for scripts/paymentsend-dom-entry.jsx.
//
// FIXTURED, not proxied, and deliberately so: this harness is about TIMING, and
// the bug only exists in the window between a request being answered and its
// response arriving. A real server hands you whatever latency it happens to
// have that second; here the harness decides, so the race runs the same way
// every time. Nothing here sends an email — the send is stubbed at the api
// boundary, which is exactly the layer the bug lives above.
//
// ── The race, as the server would produce it ──
// GET /bk/payments captures the row's state AT THE MOMENT THE REQUEST ARRIVES
// and resolves GET_LATENCY_MS later with that captured copy. That is what a
// database read does. So a GET issued before the send commits still answers
// "not sent" a second after it did, and the page has to be right anyway.
export const calls = { get: [], post: [], put: [], del: [] }

// Wide on purpose: the send has to complete INSIDE this window on every run,
// not on the runs where the network happens to cooperate.
const GET_LATENCY_MS = Number(process.env.GET_LATENCY_MS || 2500)

// One paid invoice with no proof yet — the state John's row was in before he
// dropped the screenshot on it.
export const state = {
  row: {
    id: 1611,
    payee: 'Salmon Studios Limited',
    vendor_email: 'accounts@salmonstudios.net',
    vendor_name: 'Salmon Studios Limited',
    amount: '700.00',
    currency: 'USD',
    invoice_number: 'SS-1611',
    invoice_date: '2026-07-21',
    due_date: '2026-08-20',
    scheduled_payment_date: '2026-08-20',
    payment_status: 'Paid',
    payment_date: '2026-08-20',
    payment_method: 'Wire',
    payment_terms: 'Net 30',
    paid_by: 'John',
    payment_ref: null,
    category: 'Recording',
    artist: '',
    song: '',
    boom_rep: null,
    parent_id: null,
    status: 'approved',
    has_invoice: true,
    has_proof: false,
    has_w9: true,
    confirmation_sent: false,
    rush_requested: false,
    on_hold: false,
    deleted: false,
    voided: false,
    notes: '',
    vendor_bank: 'Lead Bank',
    // What the vendor submitted, which the detail panel shows read-only.
    vendor_address: '3 Wharf Road, London E1',
    vendor_cc_emails: 'ap@salmonstudios.net',
    social_handles: [{ platform: 'instagram', handle: '@salmonstudios' }],
    off_roster_artist: false,
    w9_tin_last4: '4417',
    w9_tax_classification: 'C Corporation',
    vendor_file_count: 2,
    payment_last4: '6012',
    paypal_handle: null,
    payment_snapshot: {
      method: 'Wire Domestic', account_type: 'checking', holder_name: 'Salmon Studios Ltd',
      bank_name: 'Lead Bank', bank_address: '1 Lead Plaza, Kansas City MO',
      beneficiary_address: '3 Wharf Road, London E1', wire_scope: 'domestic', last4: '6012',
    },
    payment_check: { verdict: 'match' },
    // What the vendor BILLED, which the split dialog divides. Equal to the
    // row's own amount here because nothing has been split off it yet.
    family_amount: 700,
    is_split: false,
    parent_id: null,
  },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (data) => ({ data: { success: true, data } })

// PARTIAL=1 serves a family the page can only half see: a $700 invoice already
// split, with one $350 slice inside the dashboard's unpaid + 14-days-paid window
// and the other outside it. The row still reports the true family_amount,
// because the server computes that over the whole family.
const PARTIAL = process.env.PARTIAL === '1'
// FAMILY=1 serves BOTH rows of a split invoice, which is the only fixture that
// can tell "patched the family" apart from "patched the row I clicked" — with a
// single row on screen the two are indistinguishable.
const FAMILY = process.env.FAMILY === '1'

// QUEUE=1 serves a whole queue rather than one invoice: seven rows chosen so
// that every priority band is occupied and one vendor holds three of them.
//
// The load-bearing pair is Borough (rush, due in 20 days) against Cobalt
// (no rush, 3 days overdue). Due-date-ascending puts Cobalt first; Priority
// puts Borough first. Without a pair the two sorts disagree about, a green
// result would only prove the list rendered in SOME order.
//
// Dates are computed against the real clock because isOverdue / isDueSoon do
// too — a hardcoded date would silently drift out of its band and take the
// assertions with it.
const QUEUE = process.env.QUEUE === '1'
const iso = (offsetDays) => {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}
const queueRow = (o) => ({
  currency: 'USD', status: 'approved', payment_status: 'Unpaid',
  parent_id: null, is_split: false, deleted: false, voided: false,
  // has_w9 false / w9_entry_id set is the ordinary case and the one the naive
  // row-level flag gets wrong: the vendor IS covered, by a form filed on a
  // different invoice. The server resolves w9_entry_id through lib/w9-owner.
  has_invoice: true, has_proof: false, has_w9: false, w9_entry_id: 7001, confirmation_sent: false,
  rush_requested: false, on_hold: false, category: 'Recording',
  // Method and email are defaulted PRESENT so that "blocked" is a property a
  // row opts into. Left unset they defaulted to null and seven of the nine
  // rows were blocked, which tests nothing.
  payment_method: 'ACH',
  invoice_date: iso(-45), vendor_email: 'ap@example.test',
  ...o,
  family_amount: Number(o.amount),
})
const QUEUE_ROWS = [
  // Band 0 — rush AND overdue. Two of them, to check the ordering INSIDE a
  // band is oldest-obligation-first rather than whatever order they arrived in.
  queueRow({ id: 9001, payee: 'Fathom Live', amount: '900.00', invoice_number: 'FL-1',
    scheduled_payment_date: iso(-30), rush_requested: true }),
  queueRow({ id: 9002, payee: 'Acme Audio', amount: '1000.00', invoice_number: 'AC-1',
    scheduled_payment_date: iso(-10), rush_requested: true }),
  // Band 1 — rush, not yet due. Must outrank Cobalt below.
  queueRow({ id: 9003, payee: 'Borough Mastering', amount: '2000.00', invoice_number: 'BM-1',
    scheduled_payment_date: iso(20), rush_requested: true, payment_method: 'Wire' }),
  // Band 2 — overdue, no rush.
  queueRow({ id: 9004, payee: 'Cobalt Studios', amount: '700.00', invoice_number: 'CO-1',
    scheduled_payment_date: iso(-3), has_w9: false, w9_entry_id: null }),
  // Band 3 — due within 7 days.
  queueRow({ id: 9005, payee: 'Delta Films', amount: '400.00', invoice_number: 'DE-1',
    scheduled_payment_date: iso(3) }),
  // Band 4 — scheduled. Acme's second invoice: the vendor group has to gather
  // rows that priority order scatters across the page.
  queueRow({ id: 9006, payee: 'Acme Audio', amount: '500.00', invoice_number: 'AC-2',
    scheduled_payment_date: iso(40), payment_method: 'ACH' }),
  // Band 5 — held. Acme's third: excluded from the vendor total and from
  // "Pay all", which is the only way to see that a hold survives batching.
  queueRow({ id: 9007, payee: 'Acme Audio', amount: '300.00', invoice_number: 'AC-3',
    scheduled_payment_date: iso(-5), on_hold: true, hold_reason: 'disputed' }),
  // Band 6 — paid, inside the 14-day window.
  // Blocked: no payment method — cannot decide how to send it.
  queueRow({ id: 9009, payee: 'Quill & Co', amount: '640.00', invoice_number: 'QU-1',
    scheduled_payment_date: iso(9), payment_method: null }),
  // Blocked: no vendor email — payable, but the confirmation has nowhere to go.
  queueRow({ id: 9010, payee: 'Rowan Session', amount: '520.00', invoice_number: 'RO-1',
    scheduled_payment_date: iso(11), payment_method: 'ACH', vendor_email: null }),
  // Paid, no proof: the Send button is suppressed and the row used to go quiet.
  queueRow({ id: 9011, payee: 'Thorn Audio', amount: '310.00', invoice_number: 'TH-1',
    scheduled_payment_date: iso(-16), payment_status: 'Paid', payment_date: iso(-4),
    payment_method: 'ACH', has_proof: false }),
  // Rush, not yet due, and NOT in dollars. The chip badges show one converted
  // figure, so an all-USD fixture cannot tell a correct conversion from no
  // conversion at all — every row would convert to itself. Dated after BM-1 so
  // it sorts below it inside the Rush band and disturbs no ordering assertion.
  queueRow({ id: 9012, payee: 'Eurosound Ltd', amount: '1000.00', currency: 'EUR',
    invoice_number: 'EU-1', scheduled_payment_date: iso(25), rush_requested: true }),
  queueRow({ id: 9008, payee: 'Echo Print', amount: '250.00', invoice_number: 'EC-1',
    scheduled_payment_date: iso(-12), payment_status: 'Paid', payment_date: iso(-2),
    // Proof present and no confirmation sent — a PENDING confirmation, which is
    // what makes the CC-the-rep control and the bulk send button render at all.
    has_proof: true }),
]

const getHandlers = [
  ['/bk/payments', async () => {
    // Snapshot NOW, answer LATER — a read of the row as it was when the query ran.
    const snapshot = PARTIAL
      ? { ...state.row, amount: '350.00', artist: 'Jerri', is_split: true, family_amount: 700 }
      : { ...state.row }
    await sleep(GET_LATENCY_MS)
    if (QUEUE) return ok(QUEUE_ROWS)
    if (FAMILY) {
      return ok([
        { ...state.row, amount: '350.00', artist: 'Jerri', is_split: true, family_amount: 700 },
        { ...state.row, id: 1612, parent_id: state.row.id, amount: '350.00', artist: 'Kaia',
          is_split: true, family_amount: 700, invoice_number: 'SS-1611' },
      ])
    }
    return ok([snapshot])
  }],
  ['/bk/vendors', async () => ok([])],
  ['/bk/artist-names', async () => ok({ names: [] })],
  ['/artists', async () => ok([])],
  ['/categories', async () => ok({ expense: ['Recording', 'Marketing'], income: [], expense_groups: [], expense_order: ['Recording', 'Marketing'], income_groups: [], income_order: [] })],
  ['/reps', async () => ok([])],
  // A real rate. With `{}` nothing converts, so a chip over a mixed set would
  // silently fall back and the conversion under test would never run.
  // 0.92 EUR per USD, so €1,000 is $1,086.96.
  ['/fx/rates', async () => ok({ rates: { EUR: 0.92 } })],
  ['/settings/me', async () => ok({})],
]

const api = {
  get: async (url) => {
    calls.get.push({ url })
    const hit = getHandlers.find(([p]) => url.startsWith(p))
    return hit ? hit[1]() : ok([])
  },
  post: async (url, body) => {
    calls.post.push({ url, body })
    if (/\/file\/proof$/.test(url)) {
      state.row.has_proof = true
      return ok({ ok: true })
    }
    if (/confirmation-preview$/.test(url)) {
      return ok({
        to: state.row.vendor_email, cc: '', subject: 'Payment Confirmation - Salmon Studios Limited',
        message: '', html: '<p>preview</p>', amount: 700, currency: 'USD',
        invoiceNumber: 'SS-1611', paymentDate: '2026-08-20', paymentMethod: 'Wire',
        hasInvoice: true, hasProof: true, boomRep: null,
      })
    }
    // The write the page is arguing with. No email leaves this process.
    if (/send-confirmation$/.test(url)) {
      state.row.confirmation_sent = true
      return ok({ ok: true })
    }
    if (/mark-sent$/.test(url)) {
      state.row.confirmation_sent = true
      return ok({ ok: true })
    }
    // Splitting is a real write on a real endpoint; the stub records the
    // payload so the harness can assert the ARITHMETIC that was sent, which is
    // the part a UI test can otherwise miss entirely.
    if (/\/split$/.test(url)) {
      state.row.is_split = true
      return ok({ parent_id: state.row.id, child_ids: [9101] })
    }
    return ok({})
  },
  put: async (url, body) => {
    calls.put.push({ url, body })
    // The server applies an edit only if `expect` still matches. Mirroring that
    // here is the whole point of the undo scenarios: a stub that always says yes
    // cannot tell a guarded undo from an unguarded one.
    if (/\/bk\/entries\//.test(url) && body && body.expect) {
      const { field, value } = body.expect
      const current = state.row[field] ?? null
      if ((current ?? null) !== (value ?? null)) {
        const err = new Error('conflict')
        err.response = { status: 409, data: { success: false, conflict: {
          field, expected: value, actual: current } } }
        throw err
      }
    }
    if (/\/bk\/entries\//.test(url) && body) {
      for (const k of Object.keys(body)) {
        if (k !== 'expect') state.row[k] = body[k]
      }
    }
    // Mirror the server's family cascade so the harness can tell a page that
    // patches its siblings from one that only looks like it did.
    if (/\/bk\/entries\//.test(url) && body && 'scheduled_payment_date' in body) {
      state.row.scheduled_payment_date = body.scheduled_payment_date
    }
    return ok({ ...state.row })
  },
  delete: async (url) => { calls.del.push({ url }); return ok({}) },
}

export default api
