// A stubbed api for scripts/tax1099-dom-entry.jsx.
//
// The payload shape is copied from what the live endpoint returned in
// server/scripts/tax1099-fixture.cjs, not invented — the page's whole job is
// sorting vendors into three buckets by fields that endpoint sets, so a guessed
// shape would only prove the guess.
export const calls = { get: [], post: [], put: [], del: [] }

// Two batches' worth of unread W-9s, so the page's scan LOOP is exercised
// rather than a single call. A loop that never terminates hangs the button.
let remaining = 14

const V = (payee, over) => ({
  payee, total: 5000, vendor_email: `${payee.replace(/\W+/g, '.').toLowerCase()}@example.com`,
  needs_1099: true, exempt: false, exempt_code: null, exempt_reason: null,
  w9_on_file: true, has_tin: true, tin_last4: '3333', tin_type: 'EIN',
  // The entry that HOLDS the form — not the vendor, not the invoice being paid.
  // A wrong id here opens somebody else's document, so the harness asserts the
  // URL, not just that a button exists.
  w9_entry_id: 4321, w9_filename: 'w9-ready-vendor.pdf',
  tax_classification: 'Individual/sole proprietor', entity_type_known: true,
  address: '1 Test Street, Los Angeles CA 90001', categories: { Marketing: 5000 },
  ...over,
})

export const ROWS = [
  V('Ready Vendor'),
  V('No TIN Vendor', { has_tin: false, tin_last4: null, tin_type: null, total: 6000 }),
  V('No W9 Vendor', { w9_on_file: false, has_tin: false, tin_last4: null, entity_type_known: false,
    tax_classification: null, total: 7000, w9_entry_id: null, w9_filename: null }),
  // On file, but the owning entry could not be resolved: shows as present
  // rather than claiming they never sent one, and offers nothing to open.
  V('Unresolved W9', { w9_entry_id: null, w9_filename: null, total: 5500 }),
  V('Corp Vendor', { exempt: true, exempt_code: 'corporation', tax_classification: 'C corporation', total: 9000,
    exempt_reason: 'C corporation — corporations are generally not 1099-reportable. Confirm with your accountant.' }),
  V('Foreign Vendor', { exempt: true, exempt_code: 'foreign', tax_classification: 'Foreign (W-8)', has_tin: false, tin_last4: null, total: 4000,
    exempt_reason: 'Foreign payee (W-8 on file) — not a 1099 recipient; a 1042-S may apply instead. Ask your accountant.' }),
  V('Law Corp', { exempt: false, exempt_code: 'corp_but_reportable', tax_classification: 'S corporation', total: 7000,
    categories: { Legal: 7000 },
    exempt_reason: 'S corporation, but "Legal" spend is reportable to a corporation anyway (attorney fees and medical payments are the standard exceptions). Left IN the run.' }),
  V('Under Threshold', { needs_1099: false, total: 100 }),
]

const META = {
  basis: 'cash — payments made in the calendar year, by payment_date',
  threshold: 2000,
  threshold_note: 'OBBBA raised the 1099-NEC/MISC threshold to $2,000 for payments made after 2025. Confirm with your accountant.',
  reportable_count: 4, reportable_total: 25000,
  missing_w9: 1, missing_tin: 2, missing_address: 0,
  unfilable_count: 2, unfilable_total: 13000,
  needs_entity_review: 1, entity_type_captured: true,
  exempt_count: 2, exempt_total: 13000,
  exempt_note: 'Excluded because the W-9 says so (corporation, or a foreign W-8 payee). Attorney and medical payments to a corporation stay IN the run — each exclusion carries its reason.',
  excludes: ['reimbursements', 'unpaid invoices', 'voided and deleted rows',
    'vendors whose W-9 reports a corporation (except attorney / medical spend)'],
}

const ok = (data, extra) => ({ data: { success: true, data, ...(extra || {}) } })

const api = {
  get: async (url) => {
    calls.get.push({ url })
    if (url.startsWith('/bk/1099')) return { data: { success: true, data: ROWS, meta: META } }
    return ok([])
  },
  post: async (url, body) => {
    calls.post.push({ url, body })
    if (/scan-w9-tax/.test(url)) {
      const scanned = Math.min(10, remaining)
      remaining -= scanned
      return ok({ scanned, remaining, results: [] })
    }
    return ok({})
  },
  put: async (url, body) => { calls.put.push({ url, body }); return ok({}) },
  delete: async (url) => { calls.del.push({ url }); return ok({}) },
}
export default api
