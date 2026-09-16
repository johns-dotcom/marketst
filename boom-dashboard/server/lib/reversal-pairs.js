/**
 * Reversal pairing — one definition, shared by the statement flags and the P&L.
 *
 * A reversal is a credit that undoes an earlier debit: the payment bounced, was
 * returned, or was refunded. Both legs are the SAME non-event, so on a cash-basis
 * P&L neither is income nor expense. Counting only one side — which is what
 * happens today — overstates the books by the full amount.
 *
 * Why this lives in lib/ rather than inside the flag query: the detection used to
 * exist only in routes/statements.js, so routes/reports.js had no idea reversals
 * existed. Report accuracy then depended on a person completing a two-step manual
 * chore ("unmatch it, then dismiss both sides"), with nothing downstream to notice
 * when they stopped halfway. Measured cost of that on 2026-08-06: 7 pairs with the
 * debit still counted, $326,434.43 of overstated expense. Same reason
 * lib/normalize-bank-payee.js and lib/bank-evidence.js were extracted.
 *
 * ── Why this rule is STRICTER than the flag query it replaces ──────────────────
 *
 * The old SQL matched the counterparty with
 *
 *     LOWER(COALESCE(d.payee_guess, '')) = LOWER(COALESCE(c.payee_guess, ''))
 *
 * which is TRUE when BOTH sides are empty. So any payee-less debit paired with any
 * payee-less reversal credit of the same amount within the window. That produced
 * four "Reversed/refunded:  $100.00" flags (blank payee) against tx3314, an
 * ordinary PayPal "General Payment" whose real reversals were other, already
 * dismissed rows.
 *
 * Tolerable for a warning a human reads. NOT tolerable here, because this decides
 * reported totals — excluding tx3314 would have deleted $100 of real expense from
 * the P&L with no trace. A pair must therefore carry a POSITIVE counterparty
 * signal; absence of evidence never pairs.
 */

const REVERSAL_WINDOW_DAYS = 21;

// ── Card refunds ────────────────────────────────────────────────────────────
//
// A card refund does not announce itself. BofA renders it as an ordinary
// CHECKCARD credit — same merchant, same amount, no "REFUND" or "REVERSAL"
// anywhere in the line:
//
//   CHECKCARD 0313 Yolanda Martinez CLEVELAND TX 2469...273 CKCD 5999   debit
//   CHECKCARD 0316 Yolanda Martinez CLEVELAND TX 7469...247             credit
//
// REVERSAL_RE never saw those, so $5,000 out and $5,000 back both counted.
//
// Widening is safe here for a reason specific to cards: a CHECKCARD credit from
// a merchant can only be money coming back. You cannot receive revenue on a card
// line — income arrives by wire, ACH, Zelle or deposit. So merchant + amount +
// direction is sufficient evidence, where for a wire it would not be.
const CARD_LINE = /\bcheckcard\b|\bpurchase\s+\d{4}\b/i;

// Merchant identity from a card line. NOT normalizeBankPayee: that function is
// load-bearing for report-dismissal fingerprints and learned payee lessons, and
// changing it would silently re-key every stored dismissal. It also leaves card
// furniture behind — the debit above reduces to
// "yolanda martinez cleveland tx ckcd xxxx xxxx xxxx" against the credit's
// "yolanda martinez cleveland tx", so the two never compared equal.
const CARD_NOISE = /^(checkcard|purchase|ckcd|pos|recurring|debit|credit|card)$/;
function cardMerchant(description) {
  return String(description || '')
    .toLowerCase()
    .replace(/^\s*(checkcard|purchase)\s+\d{4}\s*/, '')   // the leading verb + MMDD
    .split(/[^a-z0-9]+/)
    .filter((w) => w
      && !/\d/.test(w)          // reference numbers, auth codes, masked digits
      && !/^x+$/.test(w)        // XXXX runs from a masked card number
      && !CARD_NOISE.test(w))
    .join(' ')
    .trim();
}


// A credit that says it is giving money back. Anchored with \b so "refundable"
// in a vendor name doesn't qualify. Mirrors the SQL `~* '\mrevers|\mrefund'`.
const REVERSAL_RE = /\brevers(al|ed|es)?\b|\brefund(ed|s|able)?\b|\bchargeback\b|\breturned\b/i;

// BofA writes the two legs as
//   "TRANSFER MARKET STREET:Venable LLP Confirmation# 0650505782"
//   "REVERSAL MARKET STREET:Venable LLP Confirmation# 0175270684"
// The verb and the confirmation number both differ, so neither payee equality nor
// a substring test finds the pair. Strip both ends and compare what's left — the
// counterparty. This is what made a $600 Laszewo reversal invisible while its
// debit stayed matched and the invoice stayed Paid.
function normalizeCounterparty(description) {
  return String(description || '')
    .toLowerCase()
    .replace(/^(transfer|reversal)\s+[^:]*:\s*/, '')
    .replace(/\s*confirmation#.*$/, '')
    .trim();
}

/**
 * Positive counterparty evidence that this credit undoes this debit.
 * Every branch requires a non-empty value on BOTH sides — see the header.
 */
function counterpartyMatch(debit, credit) {
  // Card lines compare on merchant identity, with the card furniture stripped.
  // Two words minimum: a single generic token ("amazon", "google") is not enough
  // to net two transactions out of the books.
  if (CARD_LINE.test(debit.description || '') && CARD_LINE.test(credit.description || '')) {
    const dm = cardMerchant(debit.description);
    const cm = cardMerchant(credit.description);
    if (dm && dm === cm && dm.split(' ').filter(Boolean).length >= 2) return true;
  }

  const dPayee = String(debit.payee_guess || '').trim().toLowerCase();
  const cPayee = String(credit.payee_guess || '').trim().toLowerCase();
  if (dPayee && cPayee && dPayee === cPayee) return true;

  // The credit's description names the debit's payee ("REVERSAL ... LASZEWO LLC").
  if (dPayee.length >= 3 && String(credit.description || '').toLowerCase().includes(dPayee)) return true;

  const dNorm = normalizeCounterparty(debit.description);
  const cNorm = normalizeCounterparty(credit.description);
  if (dNorm && cNorm && dNorm === cNorm && dNorm.length >= 3) return true;

  return false;
}

const dayDiff = (a, b) => (new Date(a) - new Date(b)) / 86400000;
const cents = (n) => Math.round(Number(n || 0) * 100);

/**
 * Pair reversal credits to the debits they undo, ONE-TO-ONE.
 *
 * The one-to-one part is load-bearing. Four credits matched the single $100 debit
 * tx3314 under the old rule; had each pair excluded its debit independently the
 * same row would have been subtracted repeatedly. Every row here is consumed at
 * most once, and the closest-in-time candidate wins so a vendor paid the same
 * amount twice pairs each reversal with the payment it actually followed.
 *
 * @param {Array} debits   candidate debit rows  {id, txn_date, amount, payee_guess, description, account}
 * @param {Array} credits  candidate credit rows (same shape)
 * @param {object} [opts]  {requireSameAccount = true}
 * @returns {Array<{debit, credit, gapDays}>}
 */
function pairReversals(debits, credits, opts = {}) {
  const requireSameAccount = opts.requireSameAccount !== false;

  // A credit is admissible if it SAYS it is a reversal, or if it is a card line
  // — where a credit from a merchant can only be money coming back. Card lines
  // still have to clear counterpartyMatch's two-word merchant test below, so
  // this widens the gate without weakening the evidence.
  const revCredits = credits.filter((c) => REVERSAL_RE.test(c.description || '')
    || CARD_LINE.test(c.description || ''));
  if (!revCredits.length || !debits.length) return [];

  // Score every admissible (debit, credit) combination, then take them greedily
  // by closest gap. Deterministic on ties via id, so a re-run can't reshuffle.
  const candidates = [];
  for (const c of revCredits) {
    for (const d of debits) {
      if (cents(d.amount) !== cents(c.amount)) continue;
      const gap = dayDiff(c.txn_date, d.txn_date);
      if (gap < 0 || gap > REVERSAL_WINDOW_DAYS) continue;
      if (requireSameAccount && d.account && c.account && d.account !== c.account) continue;
      if (!counterpartyMatch(d, c)) continue;
      candidates.push({ debit: d, credit: c, gapDays: gap });
    }
  }
  candidates.sort((a, b) => a.gapDays - b.gapDays
    || a.debit.id - b.debit.id || a.credit.id - b.credit.id);

  const usedDebits = new Set();
  const usedCredits = new Set();
  const pairs = [];
  for (const cand of candidates) {
    if (usedDebits.has(cand.debit.id) || usedCredits.has(cand.credit.id)) continue;
    usedDebits.add(cand.debit.id);
    usedCredits.add(cand.credit.id);
    pairs.push(cand);
  }
  return pairs;
}

module.exports = {
  REVERSAL_RE,
  REVERSAL_WINDOW_DAYS,
  normalizeCounterparty,
  counterpartyMatch,
  pairReversals,
};
