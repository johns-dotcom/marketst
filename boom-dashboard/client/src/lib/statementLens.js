// The statement lens: what a bank line IS, and whether a month adds up.
//
// Extracted from BkLedger.jsx rather than left inline, for one reason: these are
// the page's money rules, and money rules in this codebase have a habit of
// existing in three places and being fixed in one. They are also pure, which
// means they can be tested against real statement payloads in node instead of by
// looking at a screen.

/**
 * Every bank line has exactly one of five dispositions.
 *
 *   booked     an entry this app INVENTED from the line. It has a ledger id and
 *              `match_method = 'created'`, but no document behind it. These are
 *              the only lines the Bank Ledger could show before the lens existed.
 *   matched    a real invoice settles it. The expense is an invoice, so it lives
 *              on the INVOICED half of the ledger, not the bank half.
 *   creator    a creator payment settles it — real, entered by a person, and
 *              deliberately never counted as invoice-backed. Explained and
 *              documented are different claims.
 *   income     a credit booked into artist_income.
 *   dismissed  a sweep or a person said this line needs no entry.
 *   open       nothing has been decided.
 *
 * Order matters. `dismissed` is checked first because a dismissed line can still
 * carry a stale `matched_expense_id`, and reporting it as matched would put a
 * resolved line back in front of somebody. `created` is checked before the bare
 * `matched_expense_id` because a booking has both and is not a match — that
 * distinction is the whole point of the Bank Matching page.
 */
export function dispositionOf(t) {
  if (!t) return 'open';
  if (t.dismissed) return 'dismissed';
  if (t.match_method === 'created' && t.matched_expense_id) return 'booked';
  // A creator payment: entered by a person on /bk/creators, matched to this
  // line, and never invoice-backed because no invoice exists. Checked BEFORE
  // the bare `matched_expense_id` for the same reason `created` is — it has one
  // too, and reporting it as `matched` would put it in the bucket
  // invoice_backed_pct reduces over on the server.
  if (t.match_method === 'creator' && t.matched_expense_id) return 'creator';
  if (t.matched_expense_id) return 'matched';
  if (t.matched_income_id) return 'income';
  return 'open';
}

/**
 * A transaction's value in dollars, unsigned.
 *
 * `usd` is the conversion the statements endpoint already did at request time;
 * `amount_usd` is the stored column, which falls back to face value on a foreign
 * row and once reported $6,159,482 against a page showing $5,772,443. Face
 * `amount` is the last resort. Absolute, because direction is a separate field
 * and a debit stored as a negative would otherwise subtract from a debit total.
 */
export function txUsd(t) {
  return Math.abs(Number(t?.usd ?? t?.amount_usd ?? t?.amount ?? 0));
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Summarise one statement: both directions, every disposition, and the tie-out.
 *
 * The tie-out is `beginning + credits − debits = ending`, against the balances
 * the statement itself prints. `parsePdfRows` already refuses a parse that does
 * not reconcile against those figures, so agreement here is confirmation rather
 * than a fresh claim — and DISagreement means rows changed after upload, which is
 * worth saying loudly.
 *
 * `hasBalances` is false for accounts parsed without them: all four live PayPal
 * statements have a null beginning and a 0.00 ending. A check that always fails
 * for a reason that is not a problem trains people to ignore the check, so those
 * statements report that there is nothing to tie against.
 *
 * Rounds ONCE, at the end. Summing rounded parts has broken a tie-out here by
 * exactly a cent before.
 *
 * @param {object} statement   bank_statements row
 * @param {object[]} transactions
 */
export function summariseStatement(statement, transactions) {
  const st = statement || {};
  const list = Array.isArray(transactions) ? transactions : [];

  const side = () => ({ n: 0, usd: 0, by: {} });
  const moneyOut = side();
  const moneyIn = side();
  for (const t of list) {
    const s = t.direction === 'credit' ? moneyIn : moneyOut;
    const d = dispositionOf(t);
    const v = txUsd(t);
    s.n += 1;
    s.usd += v;
    s.by[d] = s.by[d] || { n: 0, usd: 0 };
    s.by[d].n += 1;
    s.by[d].usd += v;
  }
  moneyOut.usd = round2(moneyOut.usd);
  moneyIn.usd = round2(moneyIn.usd);
  for (const s of [moneyOut, moneyIn]) {
    for (const k of Object.keys(s.by)) s.by[k].usd = round2(s.by[k].usd);
  }

  const begin = st.beginning_balance == null ? null : Number(st.beginning_balance);
  const end = st.ending_balance == null ? null : Number(st.ending_balance);
  const hasBalances = begin != null && end != null && !(begin === 0 && end === 0);
  const computed = hasBalances ? round2(begin + moneyIn.usd - moneyOut.usd) : null;
  const drift = hasBalances ? round2(computed - end) : null;

  return {
    statement: st,
    moneyOut,
    moneyIn,
    hasBalances,
    begin,
    end,
    computed,
    drift,
    // EXACT, on the rounded value. The statement parser reconciles with a 0.02
    // tolerance because it is checking numbers it just read out of a PDF, where a
    // rounding artifact is a parse problem and not a data one. Here the rows are
    // already in the database: nothing is being extracted, so a cent of drift is
    // a cent that genuinely does not add up, and this codebase has already had a
    // tie-out broken by exactly $0.01 from summing rounded parts. Comparing the
    // rounded figure rather than the raw float is what makes `=== 0` safe.
    ties: hasBalances && drift === 0,
  };
}

/**
 * The lines a statement has that the Bank Ledger has no editable row for.
 *
 * A booked debit already appears above as a full ledger row, so it is excluded —
 * but ONLY when the ledger row is actually present. A booked line whose entry was
 * deleted, or whose row the current filters exclude, still belongs in this list:
 * the alternative is a line that exists on the statement and appears nowhere on a
 * page claiming to account for the month.
 *
 * @param {object[]} transactions
 * @param {Set|Map} haveRowFor   ids of transactions with a ledger row on screen
 * @param {'out'|'in'|'both'} direction
 */
export function extraTransactions(transactions, haveRowFor, direction = 'out') {
  const list = Array.isArray(transactions) ? transactions : [];
  const has = (id) => (haveRowFor?.has ? haveRowFor.has(id) : false);
  const wantOut = direction === 'out' || direction === 'both';
  const wantIn = direction === 'in' || direction === 'both';
  return list
    .filter((t) => {
      const isCredit = t.direction === 'credit';
      if (isCredit ? !wantIn : !wantOut) return false;
      return !(dispositionOf(t) === 'booked' && has(t.id));
    })
    .sort((a, b) => String(b.txn_date || '').localeCompare(String(a.txn_date || '')));
}
