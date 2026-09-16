/**
 * Bank evidence for a ledger row — "did this payment actually leave the bank?"
 *
 * The statements subsystem already knows this; the answer just never left
 * that page. These SQL fragments let any expense list endpoint carry the
 * answer, so the Ledger / Payments / Approvals / Invoices views can show it
 * without each one hand-rolling the join.
 *
 * Two derived fields:
 *
 *   bank_evidence  — the matching bank transaction as JSON, or NULL. Matches
 *                    are recorded against the FAMILY ROOT (the statements
 *                    matcher only ever considers `parent_id IS NULL` rows —
 *                    see FAMILY_SQL in routes/statements.js), so children
 *                    resolve through COALESCE(parent_id, id) and a split
 *                    inherits its parent's evidence.
 *
 *   bank_expected  — whether a ready statement SHOULD have shown this
 *                    payment: its period covers the payment date (±3 days for
 *                    settle lag) and the account is method-compatible.
 *
 * Both keys off `payment_date` ALONE. It once fell back to
 * scheduled_payment_date via COALESCE, which broke every list endpoint using
 * this file — `expenses.payment_date` is DATE but `scheduled_payment_date` is
 * **TEXT**, and Postgres rejects `COALESCE(date, text)` at plan time, so the
 * query failed for all rows regardless of data (Ledger, Payments and Vendor
 * detail all returned "COALESCE types date and text cannot be matched").
 *
 * Dropping the fallback is also the correct semantics, not just the safe fix:
 * an unpaid row should never be "expected" on a statement, and every consumer
 * already requires paid — BankEvidenceDot only shows the rose state when
 * payment_status is 'Paid', and noBankEvidenceSql below tests it explicitly.
 * The fallback contributed nothing except the type hazard.
 *
 * If you ever need a date fallback here, cast deliberately and defensively —
 * scheduled_payment_date is free text and a bare ::date will throw on any
 * malformed value.
 *
 * Both are needed to say anything useful. `bank_evidence IS NULL` alone is
 * not a problem — the statement may simply not be uploaded yet. Only
 * `paid AND no evidence AND expected` is the "paid, no bank match" condition,
 * which is the same test the statements Flags page applies.
 *
 * ── The PayPal trap ──
 * Every PayPal payment is bank-funded, so it appears on BOTH statements: the
 * PayPal debit and the BofA pull that funded it. The funding-pair sweep
 * dismisses the bank leg and keeps the PayPal side canonical, so the match
 * lives on the PayPal transaction. A naive "is there a BofA debit for this?"
 * check would therefore report every PayPal-funded invoice as unverified.
 *
 * That is what METHOD_COMPATIBLE_SQL prevents, and it is a literal
 * translation of methodCompatible() in routes/statements.js:
 *
 *     paypal account  → payment_method is 'paypal' or blank
 *     other accounts  → payment_method is anything but 'paypal'
 *
 * Keep the two in sync. If the funding model changes, this is the second
 * place to fix.
 */

// Settle lag: a ledger payment date sits 1-3 business days off the bank date,
// so a statement period counts as covering it with a 3-day skirt either side.
const SETTLE_LAG_DAYS = 3;

// ── One payment can settle several invoices ─────────────────────────────────
//
// `bank_transactions.matched_expense_id` holds ONE invoice — the primary — while
// `bank_txn_invoice_links` holds every invoice that payment settled, including
// that primary. So "is this invoice settled" is now two questions, and BOTH
// helpers below have to ask both, or a vendor paid for two invoices in one
// transfer keeps showing one of them as unpaid-by-the-bank forever.
//
// Adding it here rather than at the five call sites is the point: the ledger dot,
// the Payments worklist, Flags' paid-no-match and the vendors To-attach count all
// read this file, so they move together. Teaching them one at a time is exactly
// how two surfaces come to disagree about the same invoice.
//
// ── Why this is behind a flag ───────────────────────────────────────────────
//
// runMigrations() runs in the BACKGROUND after app.listen, so between a deploy
// starting and the migration finishing this table does not exist — and a query
// naming a missing table fails at PARSE time, taking down every list endpoint
// that embeds these fragments. That has bitten three times.
//
// So the fragments degrade: until a one-time probe confirms the table is there,
// they emit exactly the SQL they emitted before this feature, which is correct
// for every row that predates it. `markLinksReady` is called once at boot.
let linksReady = false;

/**
 * Probe for the link table once, and let the fragments include it thereafter.
 * Safe to call repeatedly; never throws.
 * @param {object} pool  pg pool
 */
async function markLinksReady(pool) {
  try {
    const { rows } = await pool.query(`SELECT to_regclass('public.bank_txn_invoice_links') AS t`);
    linksReady = !!rows[0]?.t;
  } catch { linksReady = false; }
  return linksReady;
}
const linksAreReady = () => linksReady;

// "a bank transaction `bt` settles expense `e`" — through the primary column, or
// through a link row. Written once and used by both helpers below.
//
// The link branch also requires the transaction to STILL hold a match, and that
// is what makes this safe to add to a codebase with seven separate places that
// clear `matched_expense_id`. Rather than teaching all seven to delete links —
// where missing one leaves an invoice looking settled by a payment that settles
// nothing — a link is only meaningful while its row has a match. Unlinking
// anywhere, by any path, makes every link on that row inert in the same instant.
const SETTLES_SQL = (bt, e) => linksReady
  ? `(${bt}.matched_expense_id = COALESCE(${e}.parent_id, ${e}.id)
      OR (${bt}.matched_expense_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM bank_txn_invoice_links bl
                       WHERE bl.txn_id = ${bt}.id
                         AND bl.expense_id = COALESCE(${e}.parent_id, ${e}.id))))`
  : `${bt}.matched_expense_id = COALESCE(${e}.parent_id, ${e}.id)`;

// `s` must be the bank_statements alias, `e` the expenses alias.
const METHOD_COMPATIBLE_SQL = (s, e) => `
  (CASE WHEN ${s}.account = 'paypal'
        THEN LOWER(COALESCE(${e}.payment_method, '')) IN ('paypal', '')
        ELSE LOWER(COALESCE(${e}.payment_method, '')) <> 'paypal' END)`;

/**
 * Derived bank-evidence columns for an expense list SELECT.
 *
 * @param {string} e  alias of the `expenses` table in the query (e.g. 'e')
 * @returns {string}  SQL fragment — a leading comma is NOT included
 */
const bankEvidenceCols = (e = 'e') => `
  (SELECT json_build_object(
            -- txn_id makes the evidence ACTIONABLE, not just informative: it is
            -- what the Ledger passes to DELETE /statements/tx/:id/match when a
            -- match turns out to be wrong. Without it the only way to undo a bad
            -- pairing was to find the transaction from the statements side.
            --
            -- Note which id this is. The WHERE below resolves through
            -- COALESCE(parent_id, id), so a CHILD of a split family returns its
            -- FAMILY ROOT's transaction — the one match the family actually has.
            -- That is deliberate: Egoflow's three children share one bank row,
            -- and a per-child id would present one match as three.
            'txn_id', bet.id,
            'account', bes.account,
            'txn_date', bet.txn_date,
            'amount', bet.amount,
            'statement_id', bet.statement_id,
            -- period_start so a consumer can NAME the statement ("BofA March
            -- 2026") with the shared stmtLabel() instead of printing a raw id.
            -- Added for the Bank Ledger, which lists the 2,326 entries created
            -- by booking a bank debit and needs to say which file each came
            -- from; additive, so every other consumer of this helper is
            -- unaffected and gains the option.
            'period_start', bes.period_start,
            'method', bet.match_method)
     FROM bank_transactions bet
     JOIN bank_statements bes ON bes.id = bet.statement_id AND bes.status = 'ready'
    WHERE ${SETTLES_SQL('bet', e)}
      AND bet.dismissed = false
    ORDER BY bet.matched_at DESC NULLS LAST
    LIMIT 1) AS bank_evidence,
  EXISTS (
    SELECT 1 FROM bank_statements bxs
     WHERE bxs.status = 'ready'
       AND bxs.period_start IS NOT NULL AND bxs.period_end IS NOT NULL
       AND ${e}.payment_date
             BETWEEN bxs.period_start - ${SETTLE_LAG_DAYS} AND bxs.period_end + ${SETTLE_LAG_DAYS}
       AND ${METHOD_COMPATIBLE_SQL('bxs', e)}
  ) AS bank_expected`;

/**
 * WHERE-clause predicate for "marked Paid but the bank never showed it" —
 * the condition behind the Payments dashboard filter and the statements
 * `paid-no-match` flag. Same three-part test as above.
 *
 * @param {string} e  alias of the `expenses` table
 */
const noBankEvidenceSql = (e = 'e') => `(
  ${e}.payment_status = 'Paid'
  AND ${e}.payment_date IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM bank_transactions nbt
     JOIN bank_statements nbs ON nbs.id = nbt.statement_id AND nbs.status = 'ready'
    WHERE ${SETTLES_SQL('nbt', e)}
      AND nbt.dismissed = false)
  AND EXISTS (
    SELECT 1 FROM bank_statements nxs
     WHERE nxs.status = 'ready'
       AND nxs.period_start IS NOT NULL AND nxs.period_end IS NOT NULL
       AND ${e}.payment_date
             BETWEEN nxs.period_start - ${SETTLE_LAG_DAYS} AND nxs.period_end + ${SETTLE_LAG_DAYS}
       AND ${METHOD_COMPATIBLE_SQL('nxs', e)})
)`;

// ── Why a paid row has no bank line: three answers, not one ─────────────────
//
// `noBankEvidenceSql` above answers ONE of them — paid, unmatched, and a ready
// statement covers the date, so the money should be visible and isn't. That is a
// real discrepancy and the only one worth chasing.
//
// The other two look identical in the ledger and are completely different work:
//
//   AWAITING   the payment is dated LATER than the newest statement we hold for
//              a compatible account. Nothing is wrong; the statement has not
//              been issued yet. Measured 2026-08-24: 135 rows, $206,735, every
//              one of them August, against a BofA latest of 31 Jul and a PayPal
//              latest of 28 Jul.
//
//   MISSING    the payment falls INSIDE the span we hold and still no statement
//              covers it — a month somebody never uploaded. 2 rows, $1,300
//              today. This is the one that must never hide: without the split it
//              sits in "not in yet" forever and the missing month is never
//              noticed. There are no coverage gaps right now, which is exactly
//              why the distinction has to be built before one appears.
//
// The three PARTITION the paid-and-unmatched set — every such row is in exactly
// one, asserted in scripts/unmatched-partition-fixture.cjs. A row in none of
// them would be work that no queue shows.
//
// `noBankEvidenceSql` is deliberately NOT rewritten in terms of these. It has
// three live consumers (the Ledger's bank=unverified filter, the vendors
// directory's to-attach count, and the Flags page) and restating a shipped money
// predicate to tidy it is how one of them quietly changes meaning.

/** Paid, dated, and nothing on any ready statement settles it. */
const paidUnmatchedSql = (e = 'e') => `(
  ${e}.payment_status = 'Paid'
  AND ${e}.payment_date IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM bank_transactions nbt
     JOIN bank_statements nbs ON nbs.id = nbt.statement_id AND nbs.status = 'ready'
    WHERE ${SETTLES_SQL('nbt', e)}
      AND nbt.dismissed = false)
)`;

/** Does a ready, method-compatible statement period cover this payment date? */
const statementCoversSql = (e = 'e') => `EXISTS (
  SELECT 1 FROM bank_statements cxs
   WHERE cxs.status = 'ready'
     AND cxs.period_start IS NOT NULL AND cxs.period_end IS NOT NULL
     AND ${e}.payment_date
           BETWEEN cxs.period_start - ${SETTLE_LAG_DAYS} AND cxs.period_end + ${SETTLE_LAG_DAYS}
     AND ${METHOD_COMPATIBLE_SQL('cxs', e)})`;

/**
 * The newest statement date we hold for an account compatible with this row.
 *
 * Carries the same +3 settle skirt the coverage test uses, so the boundary
 * between "not in yet" and "a month is missing" sits exactly where the boundary
 * between covered and uncovered does. Without that they disagree by three days
 * and rows fall between the two sections.
 */
const latestStatementEndSql = (e = 'e') => `(
  SELECT MAX(lxs.period_end) + ${SETTLE_LAG_DAYS}
    FROM bank_statements lxs
   WHERE lxs.status = 'ready' AND lxs.period_end IS NOT NULL
     AND ${METHOD_COMPATIBLE_SQL('lxs', e)})`;

/** Paid, unmatched, and dated past the newest statement — nothing is wrong yet. */
const awaitingStatementSql = (e = 'e') => `(
  ${paidUnmatchedSql(e)}
  AND NOT ${statementCoversSql(e)}
  AND ${e}.payment_date > COALESCE(${latestStatementEndSql(e)}, DATE '1900-01-01')
)`;

/**
 * Paid, unmatched, uncovered — and NOT in the future. The statement for that
 * month was never uploaded.
 *
 * COALESCE to a far-future date, not to 1900: with no statements at all for a
 * compatible account, nothing is missing yet — everything is awaiting. Defaulting
 * the other way would report every paid row as a missing statement on a fresh
 * database.
 */
const missingStatementSql = (e = 'e') => `(
  ${paidUnmatchedSql(e)}
  AND NOT ${statementCoversSql(e)}
  AND ${e}.payment_date <= COALESCE(${latestStatementEndSql(e)}, DATE '1900-01-01')
)`;

module.exports = {
  bankEvidenceCols, noBankEvidenceSql, SETTLE_LAG_DAYS,
  markLinksReady, linksAreReady, SETTLES_SQL,
  paidUnmatchedSql, statementCoversSql, awaitingStatementSql, missingStatementSql,
};
