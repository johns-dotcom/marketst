/**
 * Is this statement PROVED, and is one missing?
 *
 * ── What was already here, and what I got wrong about it ──
 * `/statements/flags` has reconciled statements for a while: a standalone check
 * (opening + credits − debits = closing) and a chained fallback (the previous
 * statement's closing stands in for a missing opening). Measured 2026-09-02, all
 * seven BofA statements tie to the cent — six of them through the chain. An
 * earlier reading of mine called ten of thirteen "unprovable" by looking at
 * `beginning_balance` alone; that was measuring the wrong column.
 *
 * Two things that reading did surface, and they are the reason this file exists:
 *
 * ── 1. "No flag" is not the same as "proved" ──
 * Both checks SKIP rather than fail when they cannot run, and a skip is
 * invisible. On the six PayPal statements — 890 transactions, $596,616 of debits
 * — NEITHER check runs: the chained one is disabled by unconverted foreign rows,
 * and the standalone one hits `continue` on a null opening balance BEFORE
 * reaching the "cannot verify" warning that was written for exactly this case.
 * So PayPal is unchecked and silent about it. This module makes the verdict an
 * explicit value — proved, proved-by-chain, or unprovable WITH THE REASON — so
 * the absence of a complaint stops being read as evidence.
 *
 * ── 2. A tie can be vacuous ──
 * Every PayPal statement's credits equal its debits to the cent (72,758.73 in
 * and 72,758.73 out; 327,140.39 both ways, five months running) because each
 * payment appears twice — the payment and the leg that funded it. With a closing
 * balance of 0.00 the arithmetic becomes 0 + X − X = 0, which "ties" no matter
 * what is missing: drop ten rows and, given that structure, they cancel in pairs
 * and it still ties. A check that cannot fail is not a check, so this one refuses
 * to call that proof.
 *
 * ── 3. Nothing notices a statement that never came ──
 * The gap flag fires BETWEEN two statements. It cannot fire for the newest one,
 * so an account simply stopping is invisible: on 2026-09-02 the last BofA period
 * ended 31 July and the last PayPal period 28 July, and nothing anywhere said
 * August was outstanding. `expectedNext` closes that.
 *
 * Everything here is PURE. It reads statement rows and returns verdicts; it
 * writes nothing, re-parses nothing, and touches no transaction — see the note
 * on the backfill route for why that separation is load-bearing.
 */

const CENT = 0.05;                  // the tolerance the flags surface already uses

/** 'YYYY-MM-DD' from a Date or a date-ish value, in UTC. */
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const dayNum = (d) => (d ? Math.floor(new Date(day(d)).getTime() / 86400000) : null);

/**
 * Count Saturdays and Sundays between two dates, exclusive of both ends.
 *
 * Statement periods run business day to business day, so consecutive statements
 * are routinely a Friday and the following Monday — a two-day "gap" that is a
 * weekend, not missing money. Four of the five gaps on production are exactly
 * that, and a check that reported them would be ignored within a week.
 */
function weekendDaysBetween(endDate, startDate) {
  const a = dayNum(endDate);
  const b = dayNum(startDate);
  if (a == null || b == null || b <= a + 1) return 0;
  let weekend = 0;
  for (let t = a + 1; t < b; t += 1) {
    const dow = new Date(t * 86400000).getUTCDay();
    if (dow === 0 || dow === 6) weekend += 1;
  }
  return weekend;
}

/** Days between two statements that are NOT a weekend — the real hole. */
function businessGapBetween(prevEnd, nextStart) {
  const a = dayNum(prevEnd);
  const b = dayNum(nextStart);
  if (a == null || b == null) return 0;
  const raw = b - a - 1;
  if (raw <= 0) return raw;                    // 0 = contiguous, negative = overlap
  return raw - weekendDaysBetween(prevEnd, nextStart);
}

/**
 * Can this statement's arithmetic be trusted, and on what basis?
 *
 * @param {object} s     { id, account, filename, beginning_balance, ending_balance,
 *                         credits_usd, debits_usd, foreign_unconverted, txn_count }
 * @param {object|null} prev  the same account's previous statement, if any
 * @returns {{ status: 'proved'|'proved_by_chain'|'unprovable', reason: string|null,
 *             opening: number|null, opening_from: 'printed'|'chain'|null,
 *             expected: number|null, drift: number|null }}
 */
function verdictFor(s, prev = null, pairing = null) {
  const num = (v) => (v == null ? null : Number(v));
  const closing = num(s.ending_balance);
  const credits = Number(s.credits_usd ?? 0);
  const debits = Number(s.debits_usd ?? 0);

  // Unconverted foreign rows come FIRST, before any arithmetic. The totals
  // cannot be added up in dollars while they exist, so a tie computed over them
  // would be a number, not a proof — and this is the ordering bug that made the
  // existing "cannot verify" warning unreachable for every PayPal statement.
  if (Number(s.foreign_unconverted || 0) > 0) {
    // It cannot be added up in dollars — but it may still be provable by its
    // PAIRING, which is how a PayPal statement holds together. See
    // pairingFromCounts for what that does and does not establish.
    const why = `${s.foreign_unconverted} foreign transaction${s.foreign_unconverted === 1 ? '' : 's'} `
      + 'with no printed USD amount, so the statement cannot be added up in dollars';
    if (pairing && pairing.complete && pairing.pairs > 0) {
      return {
        status: 'proved_by_pairing',
        reason: `${why} — but all ${pairing.pairs} payments match a funding leg of the same amount and `
          + 'currency, so no row was dropped on its own. A pair missing on both sides would not show up '
          + 'here, and nothing printed on the statement could catch that.',
        opening: null, opening_from: null, expected: null, drift: null, pairing,
      };
    }
    if (pairing && !pairing.complete) {
      const bits = pairing.currencies
        .map((c) => `${c.currency}: ${c.unpaired_debits} payment${c.unpaired_debits === 1 ? '' : 's'} with no `
          + `funding leg, ${c.unpaired_credits} funding leg${c.unpaired_credits === 1 ? '' : 's'} with no payment`)
        .join('; ');
      return {
        status: 'unprovable',
        reason: `${why}, and its pairing does not hold either — ${bits}. Either rows were lost in the `
          + 'parse, or these are genuinely one-sided entries; both are worth looking at.',
        opening: null, opening_from: null, expected: null, drift: null, pairing,
      };
    }
    return { status: 'unprovable', reason: why,
      opening: null, opening_from: null, expected: null, drift: null, pairing: pairing || null };
  }
  if (closing == null) {
    return { status: 'unprovable', reason: 'no closing balance was captured from the statement',
      opening: null, opening_from: null, expected: null, drift: null };
  }

  const printed = num(s.beginning_balance);
  const chained = prev && prev.ending_balance != null ? Number(prev.ending_balance) : null;
  const opening = printed != null ? printed : chained;
  const opening_from = printed != null ? 'printed' : (chained != null ? 'chain' : null);
  if (opening == null) {
    return { status: 'unprovable',
      reason: 'no opening balance on the statement and no earlier statement to carry one forward from',
      opening: null, opening_from: null, expected: null, drift: null };
  }

  // A tie that cannot fail. Zero in, zero out, zero on both balances proves
  // nothing about what is on the page — see the header for why PayPal lands here
  // five months running.
  if (Math.abs(credits) < CENT && Math.abs(debits) < CENT && Math.abs(closing) < CENT) {
    return { status: 'unprovable',
      reason: 'the statement totals and both balances are zero, so the arithmetic holds no matter '
        + 'what is missing — it is not evidence',
      opening, opening_from, expected: opening, drift: 0 };
  }
  // The same trap one step along: every amount cancels and the balances are
  // zero. 0 + X − X = 0 for any X, so rows can go missing in pairs and it still
  // "ties". PayPal's structure — a payment plus the leg that funded it —
  // produces exactly this.
  if (Math.abs(closing) < CENT && Math.abs(opening) < CENT && Math.abs(credits - debits) < CENT
      && (credits > CENT || debits > CENT)) {
    return { status: 'unprovable',
      reason: `money in and money out are identical ($${credits.toFixed(2)}) against zero balances, `
        + 'so the total cancels itself — anything missing in pairs would still balance',
      opening, opening_from, expected: opening, drift: 0 };
  }

  const expected = opening + credits - debits;
  const drift = expected - closing;
  if (Math.abs(drift) > CENT) {
    return { status: 'unprovable',
      reason: `opening $${opening.toFixed(2)} + in $${credits.toFixed(2)} − out $${debits.toFixed(2)} `
        + `= $${expected.toFixed(2)}, but the statement closes at $${closing.toFixed(2)} `
        + `— off by $${Math.abs(drift).toFixed(2)}, which is money the parse did not account for`,
      opening, opening_from, expected, drift };
  }
  return {
    status: opening_from === 'printed' ? 'proved' : 'proved_by_chain',
    reason: opening_from === 'printed' ? null
      : 'proved against the previous statement\'s closing balance rather than its own opening one — '
        + 'a gap in coverage would silently disable this',
    opening, opening_from, expected, drift,
  };
}

/**
 * Which statement should be here and is not.
 *
 * Cadence is INFERRED rather than configured, from the median distance between
 * the period ends this account already has. A configured cadence is one more
 * thing to keep true; the statements themselves already say how often they
 * arrive, and if they ever change the inference follows.
 *
 * `grace` exists because a statement is not late the moment its period closes —
 * it has to be issued and downloaded. Default 5 days.
 *
 * @returns {{ overdue: boolean, days_since: number, expected_by: string|null,
 *             cadence_days: number|null, last_period_end: string|null }}
 */
function expectedNext(statements, today = new Date(), grace = 5) {
  const ends = statements
    .map((s) => s.period_end).filter(Boolean)
    .map(day).sort();
  if (!ends.length) {
    return { overdue: false, days_since: 0, expected_by: null, cadence_days: null, last_period_end: null };
  }
  const last = ends[ends.length - 1];
  const deltas = [];
  for (let i = 1; i < ends.length; i += 1) deltas.push(dayNum(ends[i]) - dayNum(ends[i - 1]));
  // Median, not mean: one re-uploaded or partial period should not drag the
  // expectation. With a single statement there is nothing to infer, so fall
  // back to a month.
  const cadence = deltas.length
    ? deltas.slice().sort((a, b) => a - b)[Math.floor(deltas.length / 2)]
    : 30;
  const daysSince = dayNum(today) - dayNum(last);
  const expectedBy = day(new Date((dayNum(last) + cadence + grace) * 86400000));
  return {
    overdue: daysSince > cadence + grace,
    days_since: daysSince,
    expected_by: expectedBy,
    cadence_days: cadence,
    last_period_end: last,
  };
}

/**
 * PayPal's statements prove themselves a different way: by PAIRING.
 *
 * There is no balance to tie against — every PayPal statement stores a 0.00
 * close and no open, because the PDF prints no balance section — and the rows
 * cannot be added up in dollars, because 16 to 62 of them per statement are
 * foreign with no printed USD settlement (PayPal shows the conversion as its own
 * line in the source currency, not a dollar amount).
 *
 * But the document has a structure, and the structure is checkable. Every
 * payment arrives with the leg that funded it, in the same currency for the same
 * amount:
 *
 *     General Payment                AUD 829.38   debit
 *     General Currency Conversion    AUD 829.38   credit
 *     General Payment                USD 300.00   debit
 *     Bank Deposit to PP Account     USD 300.00   credit
 *
 * So: match debit amounts against credit amounts as a MULTISET, per currency. A
 * row lost in the parse leaves its partner unmatched, and that is visible.
 * Measured on production 2026-09-02: five of six statements pair perfectly, and
 * February leaves 26 rows unmatched — which is the discriminating power the
 * balance check never had here, since credits equalling debits was guaranteed by
 * the structure whatever was missing.
 *
 * ── What this does NOT prove, said plainly ──
 * A pair that is missing on BOTH sides is invisible to it. Nothing internal to
 * the document can catch that — only a printed total or a transaction count
 * could, and PayPal's statement gives neither. So this is evidence, not proof of
 * completeness, and the verdict says so rather than reading as a tick.
 *
 * Takes GROUPED counts, not rows: the caller aggregates in SQL, so a 226-row
 * statement costs one grouped row per (currency, direction, amount) instead of
 * 226 objects over the wire.
 *
 * @param {Array<{currency: string, direction: string, cents: number, n: number}>} groups
 */
function pairingFromCounts(groups) {
  const byCurrency = new Map();
  for (const g of groups || []) {
    const cur = String(g.currency || 'USD').toUpperCase();
    if (!byCurrency.has(cur)) byCurrency.set(cur, { debit: new Map(), credit: new Map() });
    const side = g.direction === 'credit' ? 'credit' : 'debit';
    const bag = byCurrency.get(cur)[side];
    const cents = Number(g.cents);
    bag.set(cents, (bag.get(cents) || 0) + Number(g.n));
  }
  const currencies = [];
  let unpairedDebits = 0;
  let unpairedCredits = 0;
  let paired = 0;
  for (const [cur, sides] of byCurrency) {
    let dLeft = 0;
    let cLeft = 0;
    let matched = 0;
    const credit = new Map(sides.credit);
    for (const [cents, n] of sides.debit) {
      const have = credit.get(cents) || 0;
      const take = Math.min(have, n);
      matched += take;
      credit.set(cents, have - take);
      dLeft += n - take;
    }
    for (const n of credit.values()) if (n > 0) cLeft += n;
    unpairedDebits += dLeft;
    unpairedCredits += cLeft;
    paired += matched;
    if (dLeft || cLeft) currencies.push({ currency: cur, unpaired_debits: dLeft, unpaired_credits: cLeft });
  }
  return {
    complete: unpairedDebits === 0 && unpairedCredits === 0,
    pairs: paired,
    unpaired_debits: unpairedDebits,
    unpaired_credits: unpairedCredits,
    currencies,
  };
}

module.exports = {
  verdictFor, expectedNext, businessGapBetween, weekendDaysBetween, pairingFromCounts, day, CENT,
};
