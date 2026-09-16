/**
 * Extra items: rows the app holds that the statement itself does not support.
 *
 * This is possible only because a deterministic parse can PROVE what a statement
 * contains — opening + net = closing, and every section total matching its
 * printed figure. Once a parse reconciles to the cent, it is ground truth, and
 * anything the app holds beyond it is surplus.
 *
 * Found the hard way. The July 2026 BofA statement charges 84 "External transfer
 * fee - 3 Day" $1.00 debits; the app held 113. Twenty-nine duplicates from the
 * original AI import, each matched to its own ledger expense, overstating fees by
 * $29 — invisible for months because nothing had ever checked a statement against
 * its own arithmetic.
 *
 * Two rules this module exists to enforce:
 *
 * 1. NO GROUND TRUTH, NO OPINION. If the parse doesn't reconcile, there are no
 *    extras — not "probably none", none reported at all. Deleting real
 *    transactions because a parser had a bad day is far worse than leaving
 *    duplicates in place.
 * 2. REMOVE THE LEAST MEANINGFUL COPIES. Within a group of indistinguishable
 *    rows, the ones carrying no match, booking, dismissal or flag go first, and
 *    newest before oldest. The surviving rows keep the reconciliation work.
 */

const { keyOf, isoDay } = require('./reparse-diff');

/**
 * Compare what a statement proves against what the app holds.
 *
 * @param {Array} statementRows rows from a RECONCILED parse (ground truth)
 * @param {Array} dbRows rows currently stored for the statement
 * @returns {{groups: Array, extraCount: number, extraValue: number, missingCount: number}}
 *   groups — one per date+amount+direction where the app holds more than the
 *   statement supports, each with the specific rows proposed for removal.
 */
function findExtras(statementRows, dbRows) {
  const expected = new Map();
  statementRows.forEach((r) => expected.set(keyOf(r), (expected.get(keyOf(r)) || 0) + 1));

  const held = new Map();
  dbRows.forEach((r) => {
    const k = keyOf(r);
    if (!held.has(k)) held.set(k, []);
    held.get(k).push(r);
  });

  const groups = [];
  let missingCount = 0;
  for (const [k, rows] of held) {
    const want = expected.get(k) || 0;
    if (rows.length <= want) continue;
    const extra = rows.length - want;
    const [date, amount, direction] = k.split('|');
    // Least meaningful first, so the surplus comes off the front and the rows
    // that keep the reconciliation work survive.
    const ordered = [...rows].sort(byRemovalPreference);
    groups.push({
      key: k,
      txn_date: date,
      amount: Number(amount),
      direction,
      expected: want,
      held: rows.length,
      extra,
      remove: ordered.slice(0, extra),
      // The rows that stay. Needed to answer the question that matters after
      // removal: is the LEDGER entry behind a deleted row a duplicate of the
      // one behind a surviving row, or a distinct payment that merely looked
      // the same?
      keep: ordered.slice(extra),
    });
  }

  // Rows the statement has that the app lacks. Reported for completeness — a
  // re-parse is what adds those, and this module never inserts anything.
  for (const [k, want] of expected) {
    const have = (held.get(k) || []).length;
    if (have < want) missingCount += want - have;
  }

  groups.sort((a, b) => b.extra - a.extra || String(a.txn_date).localeCompare(String(b.txn_date)));
  const removals = groups.flatMap((g) => g.remove);
  return {
    groups,
    extraCount: removals.length,
    extraValue: round2(removals.reduce((s, r) => s + Math.abs(Number(r.amount)), 0)),
    missingCount,
  };
}

// State weight: 0 = carries nothing, higher = more meaning worth keeping. A
// match/booking outranks a dismissal or flag because it links to real money in
// the ledger.
function stateWeight(r) {
  let w = 0;
  if (r.dismissed) w += 1;
  if (r.flagged) w += 1;
  if (r.matched_expense_id || r.matched_income_id) w += 4;
  return w;
}

function byRemovalPreference(a, b) {
  const d = stateWeight(a) - stateWeight(b);
  if (d) return d;                      // least state first
  const at = String(a.created_at || '');
  const bt = String(b.created_at || '');
  if (at !== bt) return bt.localeCompare(at); // newest first
  return (b.id || 0) - (a.id || 0);
}

const round2 = (n) => Math.round(n * 100) / 100;

module.exports = { findExtras, stateWeight, byRemovalPreference, isoDay };
