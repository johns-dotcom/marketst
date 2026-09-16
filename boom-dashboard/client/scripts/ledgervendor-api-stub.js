// A stubbed api for scripts/ledgervendor-dom-entry.jsx.
//
// Fixtured rather than proxied because the rows this is about DO NOT EXIST YET
// anywhere: `payment_snapshot` started being written on 2026-08-31 and the newest
// production submission predates that deploy, so every one of the 383 live
// vendor rows has a null snapshot. A harness pointed at real data would render
// thirteen empty columns and call them verified.
//
// So the fixture is what a submission through the CURRENT form produces — one
// ACH parent with the full payment block, a split child that must inherit its
// family's answers, a Wire row, a PayPal row, and a bulk-deal row for the
// duplicate-badge check.
export const calls = { get: [], post: [], put: [], del: [] }

const base = {
  category: 'Recording', currency: 'USD', status: 'approved',
  payment_status: 'Unpaid', payment_method: 'ACH', payment_terms: 'Net 30',
  deleted: false, voided: false, in_quickbooks: 'No', is_reimbursement: false,
  cobrand: false, is_bulk_deal: false, recoupable: true, ufr: 'No',
  has_invoice: true, has_w9: true, has_proof: false, has_receipt: false,
  receipt_count: 0, vendor_file_count: 0, off_roster_artist: false,
  parent_id: null, entry_source: null, vendor_submitted: true,
}

export const ROWS = [
  {
    ...base,
    id: 9001, invoice_date: '2026-09-01', payee: 'Salmon Studios Limited',
    vendor_name: 'Salmon Studios Ltd (trading as Salmon)', vendor_email: 'accounts@salmonstudios.net',
    vendor_address: '12 Wharf Road, London', vendor_bank: 'Lead Bank',
    artist: 'Jerri', song: 'Nightcrawl', amount: '700.00', invoice_number: 'SS-1611',
    boom_rep: 'John', description: 'Mix and master',
    vendor_cc_emails: 'ap@salmonstudios.net, hannah@salmonstudios.net',
    vendor_file_count: 3,
    payment_last4: '8613',
    payment_snapshot: {
      method: 'ACH', holder_name: 'Salmon Studios Limited', bank_name: 'Lead Bank',
      last4: '8613', account_type: 'Checking', bank_address: '1 Bank Plaza, Kansas City MO',
    },
    payment_check: { method: 'ACH', verdict: 'mismatch', typed_last4: '8613', doc_last4: '4409' },
  },
  // A split child of the row above. Its own columns are blank in the database —
  // the submission belongs to the invoice, not to our internal division of it —
  // so the cells have to resolve through the parent or the child rows read as a
  // vendor who answered nothing.
  {
    ...base,
    id: 9002, parent_id: 9001, invoice_date: '2026-09-01', payee: 'Salmon Studios Limited',
    artist: 'Kaia', song: 'Nightcrawl', amount: '300.00', invoice_number: 'SS-1611',
    vendor_name: null, vendor_email: null, vendor_cc_emails: null,
    payment_snapshot: null, payment_check: null, payment_last4: null, vendor_file_count: 0,
  },
  {
    ...base,
    id: 9003, invoice_date: '2026-08-30', payee: 'CW Media Group SRL',
    vendor_name: 'CW MEDIA GROUP SRL', vendor_email: 'billing@cwmedia.ro',
    artist: 'Oxis', song: 'Interlude', amount: '1200.00', invoice_number: 'CW-88',
    payment_method: 'Wire', off_roster_artist: true, payment_last4: '4630',
    payment_snapshot: {
      method: 'Wire', holder_name: 'CW Media Group SRL', bank_name: 'Banca Transilvania',
      last4: '4630', wire_scope: 'International',
      bank_address: 'Str. G. Baritiu 8, Cluj-Napoca',
      beneficiary_address: 'Str. Memorandumului 28, Cluj-Napoca',
      intermediary_bank: 'Citibank N.A. New York',
    },
    payment_check: { method: 'Wire', verdict: 'match', typed_last4: '4630', doc_last4: '4630' },
  },
  {
    ...base,
    id: 9004, invoice_date: '2026-08-28', payee: 'Grayson Szumilas',
    vendor_name: 'Grayson Szumilas', vendor_email: 'grayson@example.com',
    artist: 'May Zoean', song: 'Loose', amount: '250.00', invoice_number: 'G-12',
    payment_method: 'PayPal',
    payment_snapshot: { method: 'PayPal', holder_name: 'Grayson Szumilas', bank_name: null, paypal: 'grayson@example.com' },
    payment_check: { method: 'PayPal', verdict: 'absent', typed_last4: '.com', doc_last4: null, doc_other_methods: ['Wire'] },
  },
  // Not a vendor submission, and a bulk deal — the duplicate-badge case.
  {
    ...base,
    id: 9005, invoice_date: '2026-08-20', payee: 'Dean Street Media',
    vendor_submitted: false, vendor_name: null, is_bulk_deal: true,
    bulk_deal_quantity: 12, bulk_deal_unit: 'videos',
    artist: 'Jerri', song: '', amount: '4800.00', invoice_number: 'DS-3',
    payment_snapshot: null, payment_check: null,
  },
]

const ok = (data) => ({ data: { success: true, data } })

const api = {
  get: async (url) => {
    calls.get.push({ url })
    if (url.startsWith('/bk/entries?')) return ok(ROWS)
    if (url.startsWith('/artists')) return ok([{ id: 1, name: 'Jerri' }, { id: 2, name: 'Kaia' }])
    if (url.startsWith('/releases')) return ok([])
    if (url.startsWith('/flags')) return ok({})
    if (url.startsWith('/statements')) return ok([])
    if (url.startsWith('/categories')) {
      return ok({ expense: ['Recording', 'Marketing'], income: [], expense_groups: [], expense_order: ['Recording', 'Marketing'], income_groups: [], income_order: [] })
    }
    return ok([])
  },
  post: async (url, body) => {
    calls.post.push({ url, body })
    if (/\/split$/.test(url)) return ok({ parent_id: 9001, child_ids: [9102] })
    return ok({})
  },
  put: async (url, body) => { calls.put.push({ url, body }); return ok({}) },
  delete: async (url) => { calls.del.push({ url }); return ok({}) },
}

export default api
