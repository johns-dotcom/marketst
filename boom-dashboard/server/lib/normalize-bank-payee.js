/**
 * Canonical normalizer for bank-descriptor payees.
 *
 * Bank descriptors carry per-transaction noise — card codes, phone numbers,
 * reference digits — so the SAME recurring charge arrives spelled differently
 * every month:
 *
 *   FACEBK *BXJJYTMFP2 650-543-4800  →  facebk
 *   FACEBK *2THTXF                   →  facebk
 *
 * Dropping those tokens is what makes a descriptor stable enough to key
 * anything durable on: match memory, dismissal fingerprints, vendor rollups.
 *
 * Lived in routes/statements.js as a module-local until routes/reports.js
 * needed the same normalization for report-dismissal fingerprints. Two
 * copies would drift, and a drifted fingerprint silently stops matching —
 * the dismissal quietly comes back. One definition, imported by both.
 *
 * A case-preserving cousin (displayBankPayee) stays in statements.js: it
 * answers a different question — what vendor name a booked entry should
 * carry — and the client mirrors it for prefill.
 */

const normalizeBankPayee = (s) => String(s || '').toLowerCase()
  .replace(/[*#]/g, ' ')
  .split(/\s+/)
  .filter((w) => w && !(w.length >= 4 && (w.match(/\d/g) || []).length >= 2)
    && !(w.length >= 5 && /\d/.test(w) && /[a-z]/i.test(w)) // mixed alnum ≥5 = card code ("2THTXF")
    && !/^\d{4,}$/.test(w))
  .join(' ')
  .trim();

module.exports = { normalizeBankPayee };
