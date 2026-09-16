// A stubbed api for scripts/payments-dom-entry.jsx.
//
// /bk/settlement-groups mirrors the real route's two refusals — fewer than two
// invoices, and two different vendors — because the whole point of the harness
// is what the page does when the declaration CANNOT be made. A stub that always
// said yes would prove nothing about the case that matters.
export const calls = { get: [], post: [], put: [], del: [] }
export const failPuts = { on: false }

const VENDOR_A = 'Slippy Clouds Ltd'
const VENDOR_B = 'Majed LLC'
const VENDOR_C = 'Spade Group Ltd.'
// `family_amount` is what the page totals with (groupByCurrencyByFamily), so the
// stub carries it: a parent's family_amount is the WHOLE billed invoice, not its
// own slice. Without it the harness would total $2,000 where production totals
// $2,400 and the headline sum would be "verified" against a shape the server
// never sends.
const row = (id, payee, amount, over = {}) => ({
  id, payee, amount, family_amount: amount, currency: 'USD',
  invoice_number: `INV-${id}`, invoice_date: '2026-08-01',
  scheduled_payment_date: '2026-09-01',
  payment_status: 'Unpaid', payment_method: 'Wire', status: 'approved',
  artist: 'nikko', song: 'a song', category: 'Marketing',
  vendor_email: 'v@example.com', parent_id: null, settlement_group: null,
  has_invoice: true, has_proof: false, ...over,
})
// Two vendors so the mixed-selection branch has something to refuse, and one
// SPLIT CHILD so the harness can prove the group is posted on family ROOTS.
// Each scenario gets its OWN rows. Marking paid mutates the page's local state,
// so a second scenario reusing the first one's invoices would silently be
// testing a selection of already-paid rows — which is how the two-vendor case
// quietly passed for the wrong reason on the first run of this harness.
const DATA = [
  // one vendor, two invoices, one of them a split parent
  row(101, VENDOR_A, 800, { family_amount: 1200 }),   // 800 own + 400 child
  row(102, VENDOR_A, 1200),
  row(103, VENDOR_A, 400, { parent_id: 101 }),   // child of 101
  // two vendors
  row(201, VENDOR_B, 2000),
  row(301, VENDOR_C, 500),
  // the failing batch
  row(302, VENDOR_C, 700),
  row(303, VENDOR_C, 900),
]

const api = {
  get: async (url) => {
    calls.get.push(String(url))
    if (String(url).startsWith('/bk/payments')) return { data: { success: true, data: DATA } }
    return { data: { success: true, data: [] } }
  },
  put: async (url, body) => {
    calls.put.push({ url: String(url), body })
    if (failPuts.on) {
      const e = new Error('boom')
      e.response = { status: 500, data: { success: false, error: 'simulated failure' } }
      throw e
    }
    return { data: { success: true, data: {} } }
  },
  post: async (url, body) => {
    calls.post.push({ url: String(url), body })
    if (String(url) === '/bk/settlement-groups') {
      const ids = [...new Set(body?.expense_ids || [])]
      const rows = ids.map(i => DATA.find(d => d.id === i)).filter(Boolean)
      if (rows.length < 2) {
        const e = new Error('x')
        e.response = { status: 400, data: { success: false, error: 'Pick at least two invoices — a group of one is not a payment group.' } }
        throw e
      }
      if (new Set(rows.map(r => r.payee)).size > 1) {
        const e = new Error('x')
        e.response = { status: 400, data: { success: false, error: 'Those invoices are from different vendors — one payment cannot settle invoices from two vendors.' } }
        throw e
      }
      return { data: { success: true, data: { group: 'sg_test01', members: ids } } }
    }
    return { data: { success: true, data: {} } }
  },
  delete: async (url) => { calls.del.push(String(url)); return { data: { success: true, data: {} } } },
}
export default api
