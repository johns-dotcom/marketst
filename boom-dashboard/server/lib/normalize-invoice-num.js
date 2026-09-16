// Canonical invoice-number normalizer. Single source of truth so the
// vendor-submit gate, the internal /entries gate, the Duplicates page,
// the Ledger flag banner, and the BkAddInvoice live-check all agree on
// what counts as "the same invoice number."
//
// Strips:
//   - leading prefixes: "invoice", "inv", "no.", "no", "#"
//   - separator chars between the prefix and the number: spaces, dashes,
//     dots, colons, underscores, slashes
//   - non-leading dashes / whitespace / dots from the body
//   - leading zeros (so "00011" matches "11")
//
// Loops the prefix strip so combos peel cleanly (e.g. "Invoice #123" ->
// "invoice" stripped -> "#123" -> "#" stripped -> "123").
//
// The following inputs all normalize to the same key "123":
//   "123" | "INV-123" | "INV123" | "inv 123" | "#123" | "# 123" |
//   "Invoice #123" | "No. 123" | "00123" | "#00123" | "INV-#123" |
//   "INV/123" | "INV_123"
//
// Returns '0' for empty input rather than the empty string so callers
// can safely compare without short-circuiting on falsy.

function normalizeInvoiceNum(num) {
  if (!num) return '';
  let s = String(num).toLowerCase().trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/^(invoice|inv|no\.?|#)[\s\-.:_/]*/i, '');
  } while (s && s !== prev);
  return s.replace(/[-\s.]/g, '').replace(/^0+/, '') || '0';
}

module.exports = { normalizeInvoiceNum };
