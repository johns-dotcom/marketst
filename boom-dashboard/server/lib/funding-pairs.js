/**
 * What counts as a PayPal funding pair — ONE definition.
 *
 * ── The model ──
 * PayPal never spends a held balance (John's rule), so every PayPal payment is
 * funded by a pull from the bank account and the same money appears TWICE: the
 * per-payment record on the PayPal statement, and a pull on the bank statement.
 * One of the two copies has to be closed or the payment is counted twice.
 *
 * ── Why this file exists ──
 * The test lived in three places — the auto-closing sweep, the vendor page's own
 * pairing query, and the read-only cross-currency audit — and they disagreed
 * about the window and about the naming guard. John found the consequence on
 * 2026-08-18: two vendors showing "no bank pull found within 3 days" beside a
 * pull that was plainly right there.
 *
 *   Harry Seddon  PayPal GBP 70.05 (02-10)  ↔  pull $104.99 (02-11)   spread 10.8%
 *                 PayPal GBP 71.69 (03-05)  ↔  pull $100.00 (03-06)   spread  3.1%
 *   Strega        PayPal $1,200   (02-11)  ↔  pull $1,200  (02-05)   6 days apart
 *
 * The first can never match on amount. The second matches exactly and misses on
 * the date — and then misses AGAIN on the naming guard, because the bank prints
 * the reference truncated ("ID:STREGAENTER" for "StregaEntertainment Group").
 *
 * ── The two tiers, and why they are not treated alike ──
 * EXACT  same currency, same amount, within WINDOW_DAYS, recipient named.
 *        That is an equality, not an estimate — safe to close automatically.
 * FX     cross-currency: the amounts cannot be compared directly, so the
 *        evidence is a name plus a band around the converted value. Strong
 *        enough to PROPOSE, never strong enough to write unread. PayPal
 *        converts at its own spread, so the bank pays MORE than mid-market —
 *        which is why the band is asymmetric on purpose.
 */

const { normalizeBankPayee } = require('./normalize-bank-payee');
const { vendorsMatch } = require('./vendorMatch');

// 3 → 7. The old window was set from the clean cases, and PayPal eCheck
// settlement runs days behind the payment: the bank pull for Strega's $1,200 of
// 02-11 left on 02-05. 16 legs worth $12,325 sat outside a 3-day window, every
// one of them carrying a ledger entry, so every one was counted twice.
//
// Not wider than 7: past that the candidate lists start colliding — widening the
// audit to 10 days turned 74 clean proposals into 60 plus 14 more ambiguities,
// because a vendor paid twice in a month has two pulls of similar size and
// nothing left to tell them apart.
const WINDOW_DAYS = 7;

// The bank side has to LOOK like a PayPal funding pull. Same predicate in SQL
// and in JS so the sweep and the audit cannot select different rows.
const PULL_SQL = `(b.description ~* 'PAYPAL'
   OR (b.description ~* 'DES:' AND b.description ~* '(PMT INFO: ?WEB|IAT)'))`;
const looksLikePull = (description) => {
  const d = String(description || '');
  return /PAYPAL/i.test(d) || (/DES:/i.test(d) && /(PMT INFO: ?WEB|IAT)/i.test(d));
};

// Legal suffixes are dropped: a reference reads "ID:NRRDVISUALS" and the PayPal
// name is "NRRD Visuals LLC", so requiring "llc" too rejects a pair that plainly
// matches. Same suffix list vendorsMatch strips.
const SUFFIX = new Set(['llc', 'inc', 'ltd', 'corp', 'co', 'plc', 'gmbh', 'sarl', 'bv', 'pte', 'pty', 'llp']);
const nameTokens = (payeeGuess) => String(payeeGuess || '').toLowerCase().split(/\s+/)
  .map((w) => w.replace(/[^a-z0-9]/g, ''))
  .filter((w) => w.length >= 3 && !SUFFIX.has(w));

// A reference has to carry at least this many characters of the recipient's name
// before a PREFIX counts as naming them.
//
// 10 is chosen against the failure this guard exists for: on 2026-08-18 the
// sweep paired ELIOR745's pull with a $200 payment to Dylan Gold three days
// later, deleted the wrong booking, and $200 of real spend stopped being counted
// anywhere. "dylangold" is 9 characters — SHORTER than this floor — so no prefix
// rule can ever revive that pair, while "stregaenter" (11) passes. The threshold
// is deliberately set above the length of the name that caused the incident.
const MIN_PREFIX = 10;

/**
 * Does this bank pull actually NAME the PayPal recipient?
 *
 * Anything that DELETES a record has to clear this bar — amount and date alone
 * are a coincidence, and that coincidence has already cost real money.
 * Dismiss-only paths are recoverable; deleting a booking is not.
 */
function namesRecipient(description, payeeGuess, bankPayee) {
  const pn = normalizeBankPayee(payeeGuess);
  const bn = normalizeBankPayee(bankPayee);
  // BofA TRUNCATES the payee column to 16 characters — "CHRISTOPHER RAMO" is
  // "Christopher Ramos Cosinga" — so a whole-name test rejects the very rows
  // this is meant to pass.
  if (bn && pn && (pn.startsWith(bn) || bn.startsWith(pn) || vendorsMatch(payeeGuess, bankPayee).match)) return true;

  // …and the other shape, where the payee column says nothing and the name is
  // buried in the reference: "PAYPAL DES:PURCHASE ID:CHASEMANN8" is chase mann.
  //
  // Keeps BOTH branches — every token present, or a 10+ character contiguous run
  // of the squashed name. Deliberately not routed through descriptorMentions:
  // that one is stricter (contiguous only) because attribution and pairing are
  // different questions, and loosening either to share code would change a
  // shipped, tested behaviour.
  const hay = String(description || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const toks = nameTokens(payeeGuess);
  if (!toks.length) return false;

  // A name that survives tokenizing as ONE short token is not evidence.
  //
  // Found 2026-08-19 on Wendy Celestra's vendor page. "A Trần" tokenizes to a
  // single token: "A" is dropped at one character, and the diacritic strip in
  // nameTokens turns "Trần" into "trn". Three letters — and bank descriptors
  // are full of three-letter abbreviations, so "trn" duly appeared inside
  // "TRN:2026020900570468", the wire reference on a $150 payment to somebody
  // else entirely. Same amount, three days apart, and the guard said the
  // descriptor named the recipient.
  //
  // That is the dylangold shape again (the $200 mispairing that deleted a real
  // booking), and it is worse here because the EXACT tier auto-closes without
  // anyone reading it.
  //
  // Deliberately narrow: only a lone token of 3 characters or fewer. Raising
  // the general floor instead would have destroyed 11 correct live proposals
  // whose names merely CONTAIN a short token — "Anna Mae Madriaga",
  // "MPH Accessories", "Rosie Mae", "CW MEDIA GROUP S.R.L." — every one of
  // which also matches on a long token. Measured against the live deck: this
  // removes 1 of 90 proposals, and it is the wrong one.
  if (toks.length === 1 && toks[0].length <= 3) return false;

  if (toks.every((w) => hay.includes(w))) return true;
  return squashedHit(hay, toks, MIN_PREFIX);
}

/** Squashed name, and whether a >=`floor`-char prefix of it appears contiguously. */
const squashedHit = (hay, toks, floor) => {
  const squashed = toks.join('');
  if (squashed.length < floor) return false;
  for (let len = squashed.length; len >= floor; len -= 1) {
    if (hay.includes(squashed.slice(0, len))) return true;
  }
  return false;
};

// Attribution needs a HIGHER bar than pairing, and a different one.
//
// 8, and CONTIGUOUS only — no every-token branch. "Dean St" reduces to the single
// token "dean", which appears inside "Dean Street Media In", so a token test lets
// a short vendor name claim a longer company's rows. That is the substring trap
// CLAUDE.md names explicitly, and it is the bug John reported an hour ago
// ("some payments are appearing in the wrong vendor"). A contiguous run of the
// squashed name cannot reach that way: "dean" is 4 characters, under the floor,
// so it qualifies for nothing.
//
// 8 rather than 10 because real short names have to work: "chase mann" squashes to
// 9 characters and is printed in full as "ID:CHASEMANN8".
const MIN_ATTRIBUTION = 8;

/**
 * Does this statement DESCRIPTOR name this vendor?
 *
 * Separate from namesRecipient on purpose. That one also accepts a payee-COLUMN
 * prefix match, which is right when pairing two statement rows against each other
 * and wrong as "does this bank row belong to this vendor" — the payee column is
 * where the short-name reach lives.
 *
 * This is the only evidence that SURVIVES A LEDGER CHANGE, which is why the vendor
 * page leans on it: the statement is the master record, so deleting an invoice must
 * never make a bank line homeless.
 */
// Words a bank puts on EVERY line. A name that opens with one of these cannot be
// identified by it, and squashedHit walks prefixes down to 8 characters —
// "purchase" is exactly 8.
//
// Found 2026-08-19 from John: "not all of this bank activity is for this vendor
// (paypal netflix.com)". Some ledger vendors and aliases ARE whole bank
// descriptors — "PURCHASE 0306 Adobe Inc 800-8336687 CA", "PURCHASE 0323
// ANTHROPIC: CLAUDE TEAM ANTHROPIC.COMCA MARKET.ST ! Account" — and BofA
// prefixes every card charge with "PURCHASE". So each of those claimed every
// purchase on the statement. ANTHROPIC's vendor page was serving 100 of 802 rows
// totalling $401,568.76: DocuSign, Lyft, Railway, American Air, Netflix.
//
// A leading DATE goes too ("PURCHASE 0306 …"), because stripping the word alone
// would leave "0306…" to prefix-match the next line dated the same day.
const DESCRIPTOR_BOILERPLATE = new Set([
  'purchase', 'recurring', 'checkcard', 'transfer', 'wire', 'payment', 'des', 'iat',
  'pmt', 'info', 'web', 'ach', 'pp', 'id', 'indn', 'co', 'ref', 'trn', 'account',
]);

/**
 * Strip the statement boilerplate a name OPENS with, so it cannot be identified by
 * it. Only LEADING tokens go — "Dean Street Media" keeps every word.
 *
 * And only if what remains is still evidence. Some real vendors are named entirely
 * out of these words: "Wire Transfer Fee" reduces to "fee" and "236 Music Ltd" to
 * "music", both under the 8-character floor, and stripping cost them 66 and 1
 * correct matches. When the remainder cannot clear the floor the original name
 * stands — it was never the thing claiming the whole statement, because a short
 * name has no long prefix to over-match with.
 */
const withoutLeadingBoilerplate = (toks) => {
  let i = 0;
  while (i < toks.length && (DESCRIPTOR_BOILERPLATE.has(toks[i]) || /^\d{1,6}$/.test(toks[i]))) i += 1;
  return toks.slice(i);
};

// OUR OWN SIDE OF THE LINE IS NOT THE COUNTERPARTY.
//
// A BofA line carries both parties. The payee leads; then come fields describing
// US — `INDN:` (the ACH individual name) and the account trailer
// ("MARKET.ST ! Account 325"). Matching a vendor name against those
// attributes somebody else's payment to them:
//
//   "Park Avenue Secu DES:… INDN:LUIS FAVELA"   -> claimed by vendor LUIS FAVELA
//   "SCOTT SLATTERY DES:SALE ID: INDN:LUIS FAVELA"        (40 of his 43 rows)
//   "PURCHASE … MARKET.ST ! Account 325" -> claimed by market.st
//
// Measured 2026-08-19: 120 rows / $273,935 matched ONLY through INDN, and
// market.st plus New Technologies & Associates held 190 more through the
// account trailer. Every PayPal pull carries "INDN:JACOB ALLEN", so a vendor by
// that name would have claimed all 154 of them.
//
// Applied to the HAYSTACK, so every name test behind this file inherits it.
const ourSideStripped = (description) => String(description || '')
  // INDN: up to the next field marker, or end of line.
  .replace(/INDN:.*?(?=\s(?:CO\s?ID:|ID:|TRN:|REF|IAT|PMT|CCD|WEB|PPD)|$)/gis, ' ')
  // The account trailer BofA appends to card lines.
  .replace(/MARKET\s?STREET(\s+LLC)?.*$/gis, ' ')
  .replace(/CO\s?ID:\S*/gi, ' ');

/**
 * Is the name's squashed prefix present AT A WORD BOUNDARY of the descriptor?
 *
 * `squashedHit` flattens the descriptor to one string, so an 8-character prefix of
 * a long name can land in the MIDDLE of an unrelated word. That is the last known
 * cause of rows on the wrong vendor's page:
 *
 *   "francisc"  of Francisco Franco arias  inside  SAN FRANCISCO CA   93 Lyft rows
 *   "national"  of NATIONALRAI             inside  THE NATIONAL HOTEL  62 rows
 *
 * Raising the floor is not available: this file's own comment sets it at 8 because
 * "chase mann" squashes to 9 and has to keep reading "ID:CHASEMANN8".
 *
 * So the boundary decides, and the four live shapes pin the rule exactly:
 *
 *   chase mann        -> "chasemann"   in token "chasemann8"   ends on a DIGIT
 *   Strega…Group      -> "stregaenter" IS the token             ends at a boundary
 *   Dean Street Media -> spans dean|street|media                ends at a boundary
 *   Francisco…arias   -> "francisc" inside token "francisco"    ends on a LETTER -> no
 *
 * A trailing digit is allowed because that is what a handle looks like once the
 * bank has appended one; a trailing LETTER means the descriptor's own word simply
 * continues, and our name is not what is printed there.
 *
 * Applied to ATTRIBUTION only. `namesRecipient` keeps plain squashedHit: pairing
 * and attribution are different questions, the pairing side is measured clean, and
 * it is the side that auto-closes.
 */
const squashedHitAtBoundary = (hayTokens, toks, floor) => {
  const hay = hayTokens.join('');
  const starts = new Set();
  const ends = new Set();
  let at = 0;
  for (const t of hayTokens) { starts.add(at); at += t.length; ends.add(at); }
  const squashed = toks.join('');
  if (squashed.length < floor) return false;
  // WHERE THE MATCH CUTS THE NAME matters as much as where it cuts the descriptor.
  //
  // "francisco" is a whole word in "SAN FRANCISCO CA", so the boundary test alone
  // still passed it — and it is also exactly the first token of "Francisco Franco
  // arias", leaving two name tokens unaccounted for. That is not truncation, it is
  // one word of a three-word name.
  //
  // Truncation cuts INSIDE a token: "STREGAENTER" stops 8 characters into
  // "stregaentertainment". So a partial match is allowed only where it lands
  // mid-token. A partial match landing exactly on one of the name's own token
  // boundaries means the descriptor carries some of the name's words and not the
  // rest, which identifies nobody.
  // …with ONE exception, because the bank's own truncation lands on a boundary
  // often enough to matter: BofA cuts the payee column at 16 characters, and
  // "Francisco Franco arias" comes out as "FRANCISCO FRANCO" — all but the last
  // token, ending exactly on a name boundary. The first cut of this rule rejected
  // that and cost him all 94 of his rows.
  //
  // So a boundary match is allowed when it covers ALL BUT THE LAST token, and
  // refused when it leaves two or more unaccounted for. That is what separates the
  // truncation from the coincidence: "FRANCISCO FRANCO" is two of his three words,
  // "SAN FRANCISCO" gives only one, and "franciscofranco" appears in no Lyft line.
  const nameBoundaries = new Map();   // cumulative length -> tokens covered
  let acc = 0;
  toks.forEach((t, i) => { acc += t.length; nameBoundaries.set(acc, i + 1); });
  for (let len = squashed.length; len >= floor; len -= 1) {
    const covered = nameBoundaries.get(len);
    if (len !== squashed.length && covered !== undefined && covered < toks.length - 1) continue;
    const needle = squashed.slice(0, len);
    let i = hay.indexOf(needle);
    while (i !== -1) {
      const e = i + len;
      // Start on a word, and end either on a word boundary or on a digit the bank
      // appended to it.
      if (starts.has(i) && (ends.has(e) || /[0-9]/.test(hay[e] || ''))) return true;
      i = hay.indexOf(needle, i + 1);
    }
  }
  return false;
};

function descriptorMentions(description, name) {
  const hayTokens = (ourSideStripped(description).toLowerCase().match(/[a-z0-9]+/g) || []);
  const hay = hayTokens.join('');
  const toks = nameTokens(name);
  if (!toks.length || !hay) return false;
  const stripped = withoutLeadingBoilerplate(toks);
  // Enough left after the boilerplate to prefix-match on — the truncation case
  // ("STREGAENTER" for StregaEntertainment Group) needs that walk.
  if (stripped.join('').length >= MIN_ATTRIBUTION) {
    // A SINGLE-token name gets no prefix walk at all — it must appear in full.
    // "NATIONALRAI" is one token, and its 8-character prefix "national" is a whole
    // word in dozens of descriptors, so a boundary test alone still passes it. In
    // full it matches only its own rows. A multi-token name is different: the
    // truncation this walk exists for cuts INSIDE the name ("STREGAENTER" of
    // StregaEntertainment Group), and the boundary test is what keeps that honest.
    if (stripped.length === 1) return hay.includes(stripped[0]);
    return squashedHitAtBoundary(hayTokens, stripped, MIN_ATTRIBUTION);
  }
  // Not enough. The original may still match, but ONLY IN FULL — no prefix walk.
  //
  // Returning the original to squashedHit was the first fix's mistake and it
  // reinstated the whole bug for one shape: "PURCHASE Adobe Inc CA" strips to
  // "adobeca" (7, under the floor), fell back to the original, and prefix-matched
  // on "purchase" again — Adobe Inc's page stayed at 799 rows while ANTHROPIC's
  // dropped from 802 to 19.
  //
  // A whole-string match keeps the vendors that are legitimately NAMED out of
  // these words: "Wire Transfer Fee" appears verbatim on its own 66 rows, and
  // "236 Music Ltd" on its one. Neither needs a prefix, and neither can reach
  // another line with one.
  const whole = toks.join('');
  return whole.length >= MIN_ATTRIBUTION && hay.includes(whole);
}

/**
 * Days between two dates, ignoring the time of day.
 *
 * Accepts what the callers actually hold, which is the whole point: pg hands back
 * a Date, iso()-formatted rows hand back 'YYYY-MM-DD', and the vendor page
 * compares ONE OF EACH. The first version did String(d).slice(0, 10), which turns
 * a Date into "Wed Feb 11" — V8 parses that with a default year, so a 1-day gap
 * measured 9,131 and every window check silently passed. Two Dates compared fine
 * because both were mangled identically, which is why a same-shape test missed it.
 */
const dayStamp = (d) => {
  if (d instanceof Date) return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const p = new Date(d);
  return Number.isNaN(p.getTime()) ? NaN : Date.UTC(p.getUTCFullYear(), p.getUTCMonth(), p.getUTCDate());
};
const dayGap = (a, b) => {
  const g = Math.abs(dayStamp(a) - dayStamp(b));
  return Number.isFinite(g) ? Math.round(g / 86400000) : NaN;
};

/**
 * Classify one candidate (paypalRow, bankRow) pair.
 * @returns {'exact'|'fx'|null} null = not a pair at all.
 *
 * `usd` is the caller's converted value — passed in rather than computed here,
 * because usdOf reads the live rate cache and this module must stay pure enough
 * to test. Never `amount_usd`: it is NULL on every non-USD row.
 */
function pairTier(pp, bank, { ppUsd, bankUsd, under = 0.05, over = 0.20, namesOk } = {}) {
  if (!looksLikePull(bank.description)) return null;
  // NaN is NOT "inside the window" — an unreadable date means no pair, never a
  // free pass. That inversion is how a 1-day check accepted a 9,131-day gap.
  const gap = dayGap(pp.txn_date, bank.txn_date);
  if (!Number.isFinite(gap) || gap > WINDOW_DAYS) return null;
  // `namesOk` lets a caller supply a WIDER identity test than the descriptor
  // alone — in practice `namesOrLinked`, which also accepts an alias or a learned
  // link a person has already recorded.
  //
  // It exists because the two surfaces disagreed. The cross-currency audit and
  // every close gate use namesOrLinked; this function's built-in test is the
  // descriptor only, and the vendor page was its sole caller. So A Trần's two
  // payments were PROPOSED in the deck and reported as "no bank pull found within
  // a week" on her own vendor page — the one place John was looking. Her name
  // survives tokenizing as the single 3-character token "trn", which
  // namesRecipient rejects on purpose (it once matched a wire reference), and the
  // link she already has is what the wider test sees.
  //
  // Safe because pairTier proposes and never closes: the 'fx' tier is always
  // confirmed by a person, through a gate that applies namesOrLinked itself.
  const named = namesOk ? namesOk(pp, bank) : namesRecipient(bank.description, pp.payee_guess, bank.payee_guess);
  if (!named) return null;
  const sameCur = String(pp.currency || 'USD').toUpperCase() === String(bank.currency || 'USD').toUpperCase();
  if (sameCur && Number(pp.amount) === Number(bank.amount)) return 'exact';
  if (!(ppUsd > 0) || !(bankUsd > 0)) return null;
  return (bankUsd >= ppUsd * (1 - under) && bankUsd <= ppUsd * (1 + over)) ? 'fx' : null;
}

/**
 * Allocate PayPal payments to bank pulls, ONE pull to ONE payment.
 *
 * ── Why this is here ──
 * This file was created because the PAIR TEST lived in three places that
 * disagreed (see the header). It unified the test and left the ALLOCATION
 * behind, so the same drift reappeared one level up:
 *
 *   the sweep      ORDER BY b.id, |gap|   seenBank + usedPp   1:1 GLOBALLY
 *   the vendor page ORDER BY p.id, |gap|  usedBank only       1:1 within ONE VENDOR
 *
 * A page that allocates among one vendor's rows cannot know another vendor's
 * payment is the real twin, so it claims the pull too. Measured 2026-08-19 across
 * 712 vendor pages: 20 pulls worth $12,950 were claimed by more than one vendor,
 * 14 of them by genuinely different payments. One $200 pull appeared as the
 * funding leg on three people's pages, and the descriptor named exactly one of
 * them.
 *
 * ── The preference order, and why ──
 * 1. A person's `vendor_override` on the bank row. It already outranks every
 *    inference everywhere else; a claim settled by hand is not re-litigated.
 * 2. The descriptor NAMES the recipient — `namesRecipient`, unchanged, tested
 *    against every name the caller can offer for that payment. `ID:ANGEL` picks
 *    Angel Melendez over Blake Hall's identical $1,000 one day away.
 * 3. Nearest date.
 * 4. Nobody. A pull two payments want equally is CONTESTED, and saying so beats
 *    handing it to whichever page asked first — the same rule the cross-currency
 *    proposals already follow ("ONE candidate only").
 *
 * This decides only WHO WINS among candidates the caller already accepted. It
 * makes nothing eligible: every guard stays with the caller.
 *
 * @param {Array} legs   candidate pairs. Each needs `pp_id`, `bank_id`,
 *                       `bank_desc`, `bank_payee`, `pdate`, `bdate`, and
 *                       `names` — every name known for the PayPal side (its
 *                       payee_guess, and the ledger vendor its entry names).
 * @param {object} opts  `overrides`: Map(bank_id -> vendor a person assigned it
 *                       to); `vendorOf`: leg -> the vendor this leg would credit,
 *                       so an override can be honoured.
 * @returns {{ byPp: Map, byBank: Map, contested: Map }}
 *          contested: Map(bank_id -> [legs]) for pulls nobody won.
 */
/**
 * The preference ORDER over candidate pairs, scored and sorted — extracted so the
 * auto-closing sweep and the vendor page rank competitors identically while
 * keeping their own rules about what CONSUMES a pull.
 *
 * They cannot share the consumption policy: the page takes one pull per payment
 * and declares the rest contested, while the sweep's "both hold a real invoice"
 * branch deliberately consumes NOTHING, leaving both rows available. Sharing the
 * order is what stops them naming different owners; sharing the policy would
 * change what the sweep writes.
 *
 * Legs whose bank row a person assigned to somebody else are dropped outright.
 */
function scoreFundingLegs(legs, { overrides = new Map(), vendorOf = () => null } = {}) {
  const lc = (v) => String(v || '').trim().toLowerCase();
  const scored = legs.map((l) => {
    const ovr = overrides.get(l.bank_id);
    const mine = ovr ? lc(vendorOf(l)) === lc(ovr) : false;
    const named = (l.names || []).some((n) => namesRecipient(l.bank_desc, n, l.bank_payee));
    return { leg: l, overridden: !!ovr, mine, named, gap: dayGap(l.pdate, l.bdate) };
  });
  // A pull a person has assigned is off the table for everybody else, whether or
  // not their descriptor names them.
  return scored.filter((s) => !s.overridden || s.mine)
    .sort((a, b) => (b.mine - a.mine) || (b.named - a.named)
      // NaN sorts last rather than winning by accident — the dayStamp lesson above.
      || ((Number.isFinite(a.gap) ? a.gap : Infinity) - (Number.isFinite(b.gap) ? b.gap : Infinity))
      || (a.leg.pp_id - b.leg.pp_id));
}

function allocateFundingPairs(legs, { overrides = new Map(), vendorOf = () => null } = {}) {
  const usable = scoreFundingLegs(legs, { overrides, vendorOf });

  // Who else could take this pull, on the same footing? Only a rival that is
  // ALSO unnamed and equally close makes it a contest — a named winner or a
  // strictly nearer date is a decision, not a coin toss.
  const rivals = new Map();
  for (const s of usable) {
    const list = rivals.get(s.leg.bank_id) || [];
    list.push(s);
    rivals.set(s.leg.bank_id, list);
  }
  const byPp = new Map(), byBank = new Map(), contested = new Map();
  for (const s of usable) {
    if (byPp.has(s.leg.pp_id) || byBank.has(s.leg.bank_id)) continue;
    const others = (rivals.get(s.leg.bank_id) || [])
      .filter((o) => o.leg.pp_id !== s.leg.pp_id && !byPp.has(o.leg.pp_id));
    const tied = others.filter((o) => o.mine === s.mine && o.named === s.named && o.gap === s.gap);
    if (tied.length && !s.mine && !s.named) {
      contested.set(s.leg.bank_id, [s, ...tied].map((x) => x.leg));
      continue;
    }
    byPp.set(s.leg.pp_id, s.leg);
    byBank.set(s.leg.bank_id, s.leg);
  }
  return { byPp, byBank, contested };
}

module.exports = { WINDOW_DAYS, PULL_SQL, MIN_PREFIX, looksLikePull, namesRecipient, descriptorMentions, dayGap, pairTier, allocateFundingPairs, scoreFundingLegs, withoutLeadingBoilerplate, ourSideStripped };
