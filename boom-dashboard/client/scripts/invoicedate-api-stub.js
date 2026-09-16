// A stubbed api for scripts/invoicedate-dom-entry.jsx.
//
// `/invoices/due-date` is the one that matters: the page computes NO date of its
// own, so what it shows is whatever this returns — and the assertion worth
// making is about the PARAMS it asked with. The stub therefore answers with the
// date it was asked about, which is exactly what the server does.
export const calls = { get: [], post: [], put: [], del: [] }

const ok = (data) => Promise.resolve({ data: { success: true, data } })

// One saved invoice, dated well away from today so "loaded its own date" and
// "defaulted to today" can never be the same answer.
export const EXISTING = {
  id: 7, invoice_number: 42, bill_to: 'Acme Ltd', bill_to_address: '1 Road',
  description: 'Mastering', amount: 500, currency: 'USD',
  payment_terms: 'Net 30', due_date: '2026-03-03', due_by: 'March 3, 2026 (Net 30)',
  payment_status: 'Unpaid', line_items: [{ description: 'Mastering', amount: 500 }],
  invoice_date: '2026-02-01',
  created_at: '2026-02-01T18:00:00.000Z',
}

const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return t.toISOString().slice(0, 10)
}

const api = {
  get: (url, cfg) => {
    calls.get.push({ url, params: cfg?.params })
    if (url.startsWith('/invoices/terms')) {
      return ok({ terms: [
        { label: 'Net 30', days: 30 }, { label: 'Net 45', days: 45 },
        { label: 'Due on receipt', days: 0 }, { label: 'Custom', custom: true },
      ], default: 'Net 30' })
    }
    if (url.startsWith('/invoices/due-date')) {
      // Mirrors the server: the anchor is `date`, else the invoice's own date,
      // else today. Returning the anchor back is what lets the harness prove
      // which one the page asked about.
      const p = cfg?.params || {}
      const anchor = p.date || (p.invoice_id ? EXISTING.invoice_date : '2026-09-15')
      const days = /45/.test(p.terms || '') ? 45 : 30
      const due = p.custom || addDays(anchor, days)
      return ok({ terms: p.terms || 'Net 30', due_date: due, due_by: `${due} (${p.terms || 'Net 30'})`, invoice_date: anchor, error: null })
    }
    if (url.startsWith('/invoices/next-number')) return ok({ next_number: 43 })
    if (url.startsWith('/invoices')) return ok([EXISTING])
    return ok(null)
  },
  post: (url, body) => { calls.post.push({ url, body }); return ok({ ...EXISTING, id: 8 }) },
  put: (url, body) => { calls.put.push({ url, body }); return ok({ ...EXISTING, ...body }) },
  delete: (url) => { calls.del.push(url); return ok({}) },
}

export default api
