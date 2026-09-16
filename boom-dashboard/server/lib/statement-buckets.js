/**
 * Which disposition a bank line is in — the one definition.
 *
 * Bank Matching derives this on the client (its `dispOf` plus the server's
 * needs-invoice id set), /statements/completion derives it again in JS, and the
 * statement library's coverage bar derived a third, looser version in SQL:
 * (matched + dismissed) / debits. That third one counts a BOOKED row as matched
 * — an entry the app invented from the bank line with no document behind it —
 * so the library reported a month nearly clear while the queue one click away
 * held hundreds of rows of work on the same statements.
 *
 * Six buckets, and they PARTITION the debits. A caller can therefore sum them
 * and get the statement back, which is the property every band on these pages
 * has to hold and has failed to hold before.
 *
 *   matched         tied to an invoice a vendor actually sent
 *   creator         a creator payment — explained, undocumented by design
 *   no_invoice_due  booked, and a rule says no invoice is coming (bank fees)
 *   needs_invoice   booked, and a document SHOULD exist — this is NOT done
 *   open            no ledger entry at all
 *   excluded        dismissed — deliberately out of scope
 *
 * Three for money in. A credit matches artist_income, not an invoice.
 *
 * ORDER IS LOAD-BEARING, twice:
 *
 *   · `dismissed` is tested FIRST. The underlying counts overlap — a row can be
 *     dismissed after being matched — so anything later would double-count it,
 *     and an excluded row is excluded whatever was once done to it. Same reason
 *     /statements/ counts each bucket with its own FILTER instead of subtracting:
 *     "debits - matched - dismissed" quietly reports a remainder that doesn't
 *     exist.
 *   · `creator` is tested BEFORE the generic non-'created' test. A creator match
 *     is not 'created' either, so it would otherwise land in `matched` and be
 *     reported as invoice-backed, which is the one thing it never is.
 */

const DEBIT_BUCKETS = ['matched', 'creator', 'no_invoice_due', 'needs_invoice', 'open', 'excluded'];
const CREDIT_BUCKETS = ['booked', 'open', 'excluded'];

// Explained AND finished. Identical to Bank Matching's "Categorized" chip, which
// subtracts needs_invoice from its matched+booked+confirm set for this reason.
const ACCOUNTED = ['matched', 'creator', 'no_invoice_due'];
// Still work. Identical to its "For review" chip, which counts open rows PLUS
// the server's needs-invoice ids — booked is not matched.
const LEFT = ['needs_invoice', 'open'];
// Excluded is neither: out of the denominator, not on the wrong side of it.

/**
 * @param row  a bank_transactions row LEFT JOINed to its matched expense.
 *             makeNoInvoiceExpected reads FIVE things off it and a caller that
 *             selects four gets a wrong answer with no error: the row's own
 *             `id` and `payee_guess` (the bank descriptor), and the entry's
 *             `payee` and `category`. A vendor rule matches the ledger payee OR
 *             the descriptor, so omitting `payee_guess` — which the first
 *             version of /reconciliation did — reports rules-covered rows as
 *             still owing an invoice. It cost 50 rows on one live statement.
 * @param noInvoiceExpected  the predicate from routes/statements.js. Passed in
 *             rather than rebuilt here: it needs the pool, and a second copy of
 *             a money rule is how three readers of one rule start disagreeing.
 */
function bucketKey(row, noInvoiceExpected) {
  if (row.dismissed) return 'excluded';
  if (row.direction === 'credit') return row.matched_income_id ? 'booked' : 'open';
  if (!row.matched_expense_id) return 'open';
  if (row.match_method === 'creator') return 'creator';
  if (row.match_method !== 'created') return 'matched';
  return noInvoiceExpected(row) ? 'no_invoice_due' : 'needs_invoice';
}

module.exports = { bucketKey, DEBIT_BUCKETS, CREDIT_BUCKETS, ACCOUNTED, LEFT };
