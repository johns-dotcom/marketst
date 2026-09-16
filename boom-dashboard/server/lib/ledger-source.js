/**
 * Where a ledger row came from — one SQL definition.
 *
 * `expenses.entry_source` records how a row was born: 'bank_statement' (booked
 * off a bank statement by routes/statements.js), 'recoupments' /
 * 'artist_campaigns' (created on those pages), or NULL for the hand-entered and
 * vendor-submitted invoices that predate the column.
 *
 * ── Why statement rows have to be excluded from the recoupment surfaces ──────
 *
 * `expenses.recoupable` is `BOOLEAN DEFAULT TRUE` (server/index.js) — team
 * policy is that everything is recoupable unless someone says otherwise. But
 * `bookDebitAsEntry` in routes/statements.js does not list `recoupable` in its
 * INSERT, so every row booked from a statement is born recoupable and lands on
 * the Recoupments page having never been looked at by a person. The Artist
 * Campaigns queries had no source filter at all, so they took the whole ledger.
 *
 * This is a QUERY rule, not a data fix. Nothing rewrites `recoupable`, because
 * the intent is temporary: once ledger matching is trustworthy enough that
 * statement rows carry a real artist and a real category, they belong on these
 * pages. Reverting is then deleting the call sites — not trying to reconstruct
 * which rows a person had deliberately marked non-recoupable.
 *
 * ── IS DISTINCT FROM, not <> ─────────────────────────────────────────────────
 *
 * THE TRAP: most ledger rows have `entry_source IS NULL`. In SQL,
 * `entry_source <> 'bank_statement'` evaluates to NULL for those rows — not
 * true — so a naive inequality filters out every hand-entered invoice and
 * EMPTIES the page instead of narrowing it. `NOT IN (...)` has the same hole.
 * `IS DISTINCT FROM` is null-safe and is the only form that should appear here.
 *
 * (routes/bookkeeping.js's payments-queue exclusion spells this out the long
 * way as `(e.entry_source IS NULL OR e.entry_source NOT IN (...))`, which is
 * correct but says in twelve words what IS DISTINCT FROM says in three.)
 */

const BANK_SOURCE = 'bank_statement';

/**
 * A payment to a creator, entered on /bk/creators without an invoice.
 *
 * ── Why this is a ledger row and not its own table ──────────────────────────
 * Everything it has to do already exists on `expenses`: Recoupments and Artist
 * Campaigns filter with excludeBankRows, the P&L reduces over the ledger, and
 * statement matching keys on expense ids. A separate store would mean a second
 * code path through all four.
 *
 * ── What makes it different from every other hand-added row ─────────────────
 * It has no invoice and never will — that is the point of it. The app normally
 * REFUSES to match a bank line to an undocumented hand-added expense
 * (UNDOCUMENTED_ADDED_SQL in routes/statements.js), because doing so reports the
 * payment as invoice-backed with nothing behind it.
 *
 * A creator payment is exempt from that refusal and is NOT counted as
 * invoice-backed. It matches, it explains the bank line, and it lands in its own
 * disposition. Explained and documented are different claims, and this is a row
 * that is honestly the first and never the second.
 */
const CREATOR_SOURCE = 'creator_payment';

/**
 * SQL predicate: true for every row EXCEPT those booked from a bank statement.
 * Null-safe — see the note above; do not rewrite this as `<>` or `NOT IN`.
 *
 * @param {string} alias  table alias for `expenses` in the calling query
 * @returns {string}      e.g. "e.entry_source IS DISTINCT FROM 'bank_statement'"
 */
const excludeBankRows = (alias = 'e') =>
  `${alias}.entry_source IS DISTINCT FROM '${BANK_SOURCE}'`;

/**
 * SQL predicate: true only for creator payments.
 *
 * Plain equality is correct here and IS DISTINCT FROM is not — this asks "is it
 * this one thing", where a NULL source is genuinely a no. The null-safety trap
 * applies to EXCLUSION, which is what the two functions around it do.
 */
const isCreatorRow = (alias = 'e') =>
  `${alias}.entry_source = '${CREATOR_SOURCE}'`;

/**
 * SQL predicate: true for every row EXCEPT a creator payment. Null-safe.
 *
 * The Vendors directory is DERIVED from `expenses.payee` — there is no vendor
 * table — so without this every creator we ever pay $40 becomes a vendor
 * alongside the 418 real ones that have W9s, payment terms and aliases. John
 * chose to keep them out; creators get their own directory on /bk/creators,
 * where email, PayPal handle and socials have somewhere to live.
 *
 * `GROUP BY payee` appears in seven places. This belongs on the four that build
 * the DIRECTORY, not on the ones that answer a question about a specific payee.
 */
const excludeCreatorRows = (alias = 'e') =>
  `${alias}.entry_source IS DISTINCT FROM '${CREATOR_SOURCE}'`;

/**
 * The match_method to write when MOVING an existing expense onto a bank row.
 *
 * Three call sites move a record from one transaction to another — the
 * funding-pair sweep's moveInvoice branch, POST /tx/:id/rematch, and the manual
 * POST /tx/:ppId/funding-pair — and all three hard-coded 'rematch'.
 *
 * That is correct for an invoice and WRONG for a creator payment. 'rematch'
 * lands in `bucket.matched`, which is the bucket `invoice_backed_pct` reduces
 * over, so moving a creator payment across would report it as invoice-backed
 * with no invoice behind it. The whole point of the 'creator' disposition is
 * that this claim is never made.
 *
 * It matters most in the sweep, which runs unattended on every statement
 * upload: PayPal payments are ALWAYS bank-funded, so a creator payment matched
 * on the PayPal side and a booked bank pull is the ordinary case, not an edge
 * one.
 *
 * Resolved in SQL, inside the same UPDATE, so the lookup cannot race the write
 * and no caller can forget it.
 *
 * @param {string} expenseParam  the placeholder holding the expense id ('$1')
 * @param {string} intended      what to use when it is not a creator payment
 */
const movedMatchMethodSql = (expenseParam, intended) =>
  `CASE WHEN (SELECT src.entry_source FROM expenses src WHERE src.id = ${expenseParam})
             = '${CREATOR_SOURCE}'
        THEN 'creator' ELSE '${intended}' END`;

module.exports = {
  excludeBankRows, excludeCreatorRows, isCreatorRow, movedMatchMethodSql,
  BANK_SOURCE, CREATOR_SOURCE,
};
