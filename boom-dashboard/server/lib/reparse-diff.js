/**
 * Which parsed rows does a statement not already have?
 *
 * Extracted from routes/statements.js so it can be tested directly. It got that
 * treatment the hard way: on 2026-08-06 a re-parse DOUBLED a live statement
 * (July 2026 → 930 rows) because this comparison keyed on `description`.
 *
 * Two rules, both learned from that:
 *
 * 1. IDENTITY IS date + amount + direction, NOTHING ELSE. `description` and
 *    `reference` are parser OUTPUT, not properties of the transaction. The
 *    deterministic parser and the AI describe the same wire differently (the
 *    former keeps the wrapped continuation lines), so any key including them
 *    reports every row as new the first time the parser changes.
 *
 * 2. COMPARE COUNTS, NOT SETS. A statement legitimately holds many identical
 *    rows — the July statement has 95 rows across 15 groups of same-day,
 *    same-amount fees. A Set discards multiplicity, so it cannot tell "we have
 *    all 15" from "we have 1 of 15". Each parsed row consumes one existing row;
 *    only the surplus is missing.
 */

// Accepts a Date (from pg) or an ISO-ish string; compares on the calendar day.
function isoDay(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d || '').slice(0, 10);
}

// The columns keyOf reads. Any SELECT feeding rows into keyOf/diffReparseRows/
// findExtras must include ALL of these — omitting one doesn't error, it silently
// changes identity. Leaving `currency` out of two queries made every non-USD row
// read as USD: the extras audit reported a permanent 206-row phantom mismatch
// across the PayPal statements, and a re-parse would have inserted a duplicate
// for each of them. Exported so a caller can assert against it.
const KEY_COLUMNS = ['txn_date', 'amount', 'direction', 'currency'];

// Currency is part of identity: a PayPal statement legitimately holds EUR 100.00
// and USD 100.00 on the same day, and they are not the same transaction.
// Normalised so a stored NULL (older rows) matches a parsed 'USD' — without that,
// every BofA row would look new the first time this ran.
const keyOf = (r) => [
  isoDay(r.txn_date),
  Number(r.amount).toFixed(2),
  r.direction,
  String(r.currency || 'USD').toUpperCase(),
].join('|');

const tally = (rows) => rows.reduce((m, r) => m.set(keyOf(r), (m.get(keyOf(r)) || 0) + 1), new Map());

/**
 * @param {Array} existing rows already stored for this statement
 * @param {Array} parsedRows rows the parser just produced
 * @returns {{missing: Array, onlyInDb: Array}}
 *   missing  — parsed rows with no counterpart left in the database; insert these
 *   onlyInDb — stored rows the parse didn't account for; REPORT, never delete
 *              (they carry matches, bookings and dismissals)
 */
function diffReparseRows(existing, parsedRows) {
  const unconsumed = tally(existing);
  const missing = [];
  for (const r of parsedRows) {
    const k = keyOf(r);
    const left = unconsumed.get(k) || 0;
    if (left > 0) unconsumed.set(k, left - 1);
    else missing.push(r);
  }

  const unmatchedByDb = tally(parsedRows);
  const onlyInDb = existing.filter((r) => {
    const k = keyOf(r);
    const left = unmatchedByDb.get(k) || 0;
    if (left > 0) { unmatchedByDb.set(k, left - 1); return false; }
    return true;
  });

  return { missing, onlyInDb };
}

/**
 * The payment's OWN identifier, read off the descriptor.
 *
 * This does NOT contradict rule 1 above. A wire TRN and a transfer
 * Confirmation# are PRINTED ON THE STATEMENT and reproduced identically by both
 * parsers — unlike `description`, which the deterministic parser and the AI
 * write differently for the same wire. So a reference can refine a comparison
 * WITHIN a date+amount+direction+currency group; it must never replace the
 * group key, which is what doubled a live statement in August.
 *
 * "CO ID:" and "ID:" are deliberately NOT read: those identify the ORIGINATOR,
 * so every payment a company sends carries the same one and keying on them
 * would call thirteen separate payments one payment thirteen times.
 */
function refFromDescription(desc) {
  const s = String(desc || '');
  const m = s.match(/TRN:\s*([A-Z0-9]{8,})/i)
    || s.match(/Confirmation#\s*([A-Za-z0-9]{6,})/i)
    || s.match(/Conf#\s*([A-Za-z0-9]{6,})/i);
  return m ? m[1] : null;
}

/**
 * Rows that hold the WRONG PAYMENT'S DETAILS.
 *
 * The count-based diff above is blind to this by construction: if the app holds
 * one payment twice and a different payment of the same day and amount not at
 * all, the surplus and the shortfall cancel and the statement audits clean. That
 * is not hypothetical — it is how $14,150 came to be filed against the wrong
 * vendors and reported nothing:
 *
 *   06/12  $10,000  statement: a wire to one payee + a transfer to another
 *                   app:       the wire, twice
 *
 * The money is right, the month reconciles to the cent, and the P&L attributes
 * ten thousand dollars to a company that was never paid it.
 *
 * Detection is deliberately narrow, because the repair rewrites live rows:
 *
 *   • only inside one date+amount+direction+currency group
 *   • only when the surplus row's reference DUPLICATES another row's in that
 *     same group — that is what makes it provably a copy rather than merely
 *     unrecognised
 *   • only when exactly one statement line in the group is unaccounted for, so
 *     there is no choice about which payment the row should have been
 *
 * Anything ambiguous is returned as `unclear` and left alone.
 */
function findMisfiled(existing, parsedRows) {
  const groups = new Map();
  const put = (r, side) => {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, { db: [], pdf: [] });
    groups.get(k)[side].push(r);
  };
  for (const r of existing) put(r, 'db');
  for (const r of parsedRows) put(r, 'pdf');

  // Inside a group every row already shares date, amount, direction and
  // currency, so the descriptions can be compared directly to find which
  // statement line nothing represents. Whitespace only — the two parsers wrap
  // continuation lines differently, and anything cleverer would start deciding
  // identity, which is rule 1's job and not this function's.
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const count = (arr, fn) => arr.reduce((m, r) => {
    const v = fn(r); if (!v) return m;
    return m.set(v, (m.get(v) || 0) + 1);
  }, new Map());

  const repairs = [];
  const unclear = [];
  for (const [k, g] of groups) {
    if (!g.db.length || !g.pdf.length) continue;

    // THE SAME EXTRACTOR ON BOTH SIDES. The stored `reference` COLUMN is not
    // usable here: it is whatever the parse that ingested the row chose to put
    // there, and the AI path fills it with things the deterministic parser never
    // emits (`ST-P4H2H9U8S3B7` off a DES: field). Comparing the column against
    // text-extracted references made every such row look like a surplus — nine
    // false findings across five months, each one a proposal to rewrite a
    // correct row. Read both sides out of the description or not at all.
    const dbRefs = count(g.db, (r) => refFromDescription(r.description));
    const pdfRefs = count(g.pdf, (r) => refFromDescription(r.description));

    // A reference the app holds more often than the statement prints it. This is
    // the whole test: references are printed on the statement, so holding one
    // twice where it is charged once is not an interpretation, it is a surplus.
    const surplus = [];
    for (const [ref, n] of dbRefs) {
      const over = n - (pdfRefs.get(ref) || 0);
      if (over <= 0) continue;
      // The LATER rows are the copies: the original was ingested with the
      // statement, the copy arrived afterwards.
      const holders = g.db.filter((r) => refFromDescription(r.description) === ref).sort((a, b) => a.id - b.id);
      surplus.push(...holders.slice(holders.length - over).map((r) => ({ row: r, ref })));
    }
    if (!surplus.length) continue;

    // Which statement lines does nothing in the app represent? By reference
    // where there is one, else by description — a fee or card charge carries no
    // reference of its own and must still be findable.
    const dbDescs = count(g.db, (r) => norm(r.description));
    const orphans = [];
    const seen = new Map();
    for (const p of g.pdf) {
      const ref = refFromDescription(p.description);
      if (ref) {
        const used = seen.get(ref) || 0;
        if (used < (dbRefs.get(ref) || 0)) { seen.set(ref, used + 1); continue; }
        seen.set(ref, used + 1);
      } else {
        const d = norm(p.description);
        const used = seen.get(d) || 0;
        if (used < (dbDescs.get(d) || 0)) { seen.set(d, used + 1); continue; }
        seen.set(d, used + 1);
      }
      orphans.push(p);
    }

    // Pair only when there is no choice to make. Two surplus rows and two
    // unrepresented lines is a real finding, but which goes with which is a
    // guess, and a guess here rewrites who was paid.
    if (surplus.length === 1 && orphans.length === 1) {
      repairs.push({ row: surplus[0].row, should_be: orphans[0], group: k, duplicate_of_reference: surplus[0].ref });
    } else {
      for (const s of surplus) {
        unclear.push({
          row: s.row, group: k, reference: s.ref,
          reason: orphans.length === 0
            ? 'the statement prints this reference fewer times than the app holds it, but every line in this group is already represented'
            : `${surplus.length} row(s) hold a duplicated reference and ${orphans.length} statement line(s) are unrepresented, so the pairing is a guess`,
        });
      }
    }
  }
  return { repairs, unclear };
}

module.exports = {
  diffReparseRows, keyOf, isoDay, KEY_COLUMNS, refFromDescription, findMisfiled,
};
