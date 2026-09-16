/**
 * Which document a ledger row has, and where to fetch it.
 *
 * Lived inside Duplicates.jsx until the Reports page needed the same thing.
 * Copying it would have meant two answers to "does this row have a file" — the
 * duplicated-rule problem that produced the reversal bug (a pairing rule in
 * statements.js that reports.js knew nothing about). One definition instead.
 *
 * The endpoint GET /api/bk/entries/:id/file/:type serves invoice | w9 | proof |
 * receipt. `file_entry_id` matters for split families and shared W9s: the file
 * hangs off the invoice, not off the slice of it you clicked, so the server tells
 * us which entry actually holds it and we ask for that one.
 */

// Preference order. A row with no invoice may still have proof of payment or a
// receipt, and the button should say what it actually opens rather than always
// claiming "invoice".
export const DOC_TYPES = [
  { type: 'invoice', has: 'has_invoice', name: 'invoice_filename', label: 'invoice' },
  { type: 'proof', has: 'has_proof', name: 'proof_filename', label: 'proof of payment' },
  { type: 'receipt', has: 'has_receipt', name: 'receipt_filename', label: 'receipt' },
]

export const pickDoc = (row) => DOC_TYPES.find((d) => row && row[d.has]) || null

export const fileUrl = (entry, type = 'invoice') => {
  const id = entry.file_entry_id || entry.expense_id || entry.id
  return `/api/bk/entries/${id}/file/${type}?token=${localStorage.getItem('token')}`
}
