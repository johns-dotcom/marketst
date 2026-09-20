// The Ledger's data for scripts/ledger-dom-entry.jsx, at the api boundary.
// Reuses the vendor-form fixture rows (ledgervendor-api-stub ROWS: an ACH
// parent + split child, a wire, PayPal, bulk) and adds the second-pass
// endpoints: row history, templates, entry creation.
//   full   the rows
//   empty  no rows — the desktop empty state must render, not "No entries found."
import { ROWS } from './ledgervendor-api-stub.js'
export const calls = { get: [], post: [], put: [], del: [] }
const scenario = () => globalThis.__LEDGER_SCENARIO__ || 'full'
const ok = (data) => Promise.resolve({ data: { success: true, data } })

// Two rows with the fields the attention predicate reads: one flagged, one
// with no document and no W-9; the rest of the fixture rows all carry both.
const rows = () => ROWS.map((r) => ({ has_invoice: true, has_w9: true, in_quickbooks: 'Yes', payment_status: r.payment_status || 'Unpaid', ...r }))
  .concat([
    { id: 9101, invoice_date: '2026-08-02', payee: 'Flagged Vendor', artist: 'Jerri', song: 'Song A', amount: '150.00', currency: 'USD', category: 'Marketing', invoice_number: 'FL-1', status: 'approved', payment_status: 'Paid', payment_date: '2026-08-10', flagged: true, flag_reason: 'Check the rate', has_invoice: true, has_w9: true, in_quickbooks: 'Yes' },
    { id: 9102, invoice_date: '2026-07-15', payee: 'Undocumented Co', artist: 'Kaia', song: 'Song B', amount: '90.00', currency: 'USD', category: 'Recording', invoice_number: 'UD-2', status: 'approved', payment_status: 'Unpaid', has_invoice: false, has_w9: false, in_quickbooks: 'No' },
  ])

const api = {
  get(url, opts) {
    calls.get.push(url)
    if (/\/bk\/entries\/\d+\/history/.test(url)) return ok([{ id: 1, ts: '2026-09-01T10:00:00Z', user_name: 'Sam Chen', action: 'Edited', field: 'amount', old_value: '650', new_value: '700' }])
    if (/\/bk\/entries\/\d+\/receipts/.test(url)) return ok([])
    if (url.startsWith('/bk/entries?')) return ok(scenario() === 'empty' ? [] : rows())
    if (url === '/bk/templates') return ok([{ id: 1, name: 'Studio rent', fields: { payee: 'Wharf Studios', amount: '2500', currency: 'USD', category: 'Rent' }, uses: 3 }])
    if (url.startsWith('/artists')) return ok([{ id: 1, name: 'Jerri' }, { id: 2, name: 'Kaia' }])
    if (url.startsWith('/releases')) return ok([])
    if (url.startsWith('/flags')) return ok([])
    if (url.startsWith('/statements')) return ok([])
    if (url.startsWith('/categories')) return ok({ expense: ['Marketing', 'Recording', 'Rent'], income: ['Royalties'], expense_groups: [], expense_order: ['Marketing', 'Recording', 'Rent'] })
    if (url.startsWith('/fx')) return ok({})
    if (url.startsWith('/reps')) return ok(['John'])
    return ok([])
  },
  post(url, body) { calls.post.push({ url, body }); return ok({ id: 9999, ...(body && typeof body === 'object' && !(body instanceof FormData) ? body : {}) }) },
  put(url, body) { calls.put.push({ url, body }); return ok(body) },
  patch(url, body) { calls.put.push({ url, body }); return ok(body) },
  delete(url) { calls.del.push(url); return ok({}) },
}
export default api
