/**
 * Two pieces of context for a bank row somebody is about to judge recoupable.
 *
 * Both are computed ONCE per request and applied in JS. The obvious version —
 * correlated subqueries on the row — re-scans `expenses` per row, and the review
 * queue is 1,919 rows against a 3,700-row table. This app has already paid for
 * that shape once: `/statements/all` took 17 seconds before it stopped
 * re-deriving per row.
 *
 * Neither of these decides anything. They are what a person needs in front of
 * them to answer well, and the reason they exist is that the row cannot say
 * either thing by itself.
 */

const { usdOf } = require('./usd');

/** Strip to letters and digits: "Oxis Music, LLC" → "oxismusicllc". */
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * An artist whose name the payee contains.
 *
 * Measured on the 1,919-row no-artist pile (2026-08-20): this fires on **9 rows**
 * in total, 4 of which are advances — Koastle LLC ×2 → Koastle, Oxis Music, LLC →
 * Oxis, May Zoean → May Zoean. Sushi Sushi Tunes LLC, Take & Thrown LLC,
 * FIRESTARTER, MiiNDS LLC, EVEN II and Noah Schippers get nothing, and that is
 * the honest answer: the payee simply does not name the artist.
 *
 * So this is a CONVENIENCE on a row a human is already reading, never a
 * mechanism. It is returned as `artist_proposal` and the client pre-fills the
 * picker with it; nothing writes it without somebody pressing the button.
 * `shared-descriptor-is-not-an-identity`: one 'PAYPAL' lesson filed 154 pulls
 * under the wrong vendor, and a payee is not an identity.
 *
 * Only the invoice side of the ledger is used as the vocabulary, because that is
 * where artists were typed by a person. Bank rows would feed the pile's own
 * guesses back into itself.
 *
 * The 4-character floor is not cosmetic: two-letter artist keys match inside
 * almost any company name ("3ee" is in "Three Fifteen Media" once squashed), and
 * a proposal that is wrong is worse than none — it invites a click.
 */
async function loadArtistProposals(pool) {
  const empty = { size: 0, propose: () => null };
  try {
    const { rows } = await pool.query(`
      SELECT e.artist, COUNT(*)::int AS n
        FROM expenses e
       WHERE e.entry_source IS DISTINCT FROM 'bank_statement'
         AND COALESCE(e.recoupable, FALSE) = TRUE
         AND COALESCE(TRIM(e.artist), '') <> ''
         AND (e.deleted IS NULL OR e.deleted = FALSE)
         AND (e.voided IS NULL OR e.voided = FALSE)
       GROUP BY e.artist`);
    // Longest key first: "may zoean" must win over a shorter key that also
    // matches, and the most-used spelling wins a tie so the proposal is the
    // name the rest of the page already shows.
    const index = rows
      .map((r) => ({ name: r.artist, key: squash(r.artist), n: r.n }))
      .filter((a) => a.key.length >= 4)
      .sort((a, b) => b.key.length - a.key.length || b.n - a.n);
    return {
      size: index.length,
      propose: (payee) => {
        const p = squash(payee);
        if (!p) return null;
        const hit = index.find((a) => p.includes(a.key));
        return hit ? hit.name : null;
      },
    };
  } catch (err) {
    console.error('artist proposals unavailable — the queue asks without them:', err.message);
    return empty;
  }
}

/**
 * Is there an invoice-side row for the same payee at the same amount?
 *
 * True on 28 of the 1,919 pile rows ($26,382.40). The one that matters: the
 * `Advance` row for Oxis Music, LLC at $10,000. That vendor has **eleven** ledger
 * rows at exactly $10,000 — a monthly arrangement, invoices 260101-1 through
 * 260901-1, eight of them already claimed for recoupment — so the bank row is
 * almost certainly one of those invoices booked a second time rather than a new
 * advance. Marking it recoupable claims the same $10,000 twice, and nothing else
 * on the row hints at it. The flag sends it to Bank Matching, which is where a
 * bank line gets tied to the invoice it paid.
 *
 * Deliberately payee + amount and nothing tighter. A date test would miss it: the
 * bank row's `payment_date` is when the money moved and the invoice's is whatever
 * was recorded, and a booked-from-bank row carries no invoice number to compare.
 * This is a "look before you answer" flag, not a match — matching is what
 * /bk/statements is for, and the flag links there.
 */
async function loadLedgerTwins(pool) {
  const empty = { size: 0, find: () => null };
  try {
    const { rows } = await pool.query(`
      SELECT e.id, e.payee, e.amount, e.currency, e.artist, e.ufr, e.invoice_number
        FROM expenses e
       WHERE e.entry_source IS DISTINCT FROM 'bank_statement'
         AND (e.deleted IS NULL OR e.deleted = FALSE)
         AND (e.voided IS NULL OR e.voided = FALSE)
         AND e.amount IS NOT NULL`);
    const byKey = new Map();
    for (const r of rows) {
      const k = `${squash(r.payee)}|${Number(r.amount).toFixed(2)}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push({
        id: r.id, payee: r.payee, artist: r.artist, ufr: r.ufr,
        invoice_number: r.invoice_number,
        amount: Number(r.amount), currency: r.currency,
      });
    }
    return {
      size: byKey.size,
      find: (payee, amount) => {
        if (amount == null) return null;
        const hits = byKey.get(`${squash(payee)}|${Number(amount).toFixed(2)}`);
        return hits && hits.length ? hits : null;
      },
    };
  } catch (err) {
    console.error('ledger twins unavailable — the queue asks without them:', err.message);
    return empty;
  }
}

/**
 * Attach both to a list of bank rows, in place, and return it.
 *
 * `amount_usd_calc` rides along because every caller sums these and the sum has
 * to come from `usdOf` — never `amount_usd`, which falls back to face value for a
 * foreign row and once reported $6,159,482 against a page showing $5,772,443.
 */
function attachRecoupContext(rows, { proposals, twins }) {
  for (const r of rows || []) {
    r.artist_proposal = (r.artist || '').trim() ? null : proposals.propose(r.payee);
    const t = twins.find(r.payee, r.amount);
    r.ledger_twin = t ? { count: t.length, rows: t.slice(0, 4) } : null;
    r.amount_usd_calc = usdOf(r.amount, r.currency, r.fx_rate_to_usd);
  }
  return rows;
}

module.exports = { loadArtistProposals, loadLedgerTwins, attachRecoupContext, squash };
