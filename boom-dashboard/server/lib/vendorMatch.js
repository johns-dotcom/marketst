// Tiered fuzzy vendor-name matcher, shared by the ledger-diff reconciliation
// and the bank-statement matcher. External sources (bookkeepers, bank feeds)
// record vendor names slightly differently than Market Street's ledger:
// "10FIFTY LLC (UKG CENTRAL)" vs "10FIFTY LLC", "ACME CO." vs "Acme Co LLC",
// "Jane M Doe" vs "Doe Jane M". Strongest signal first; every step returns a
// score so callers can prefer better matches among multiple candidates.
function vendorsMatch(a, b) {
  const A = (a || '').toLowerCase().trim();
  const B = (b || '').toLowerCase().trim();
  if (!A || !B) return { match: false, score: 0, reason: 'empty' };
  if (A === B) return { match: true, score: 1.0, reason: 'exact' };
  // Strip parenthetical asides — "10FIFTY LLC (UKG CENTRAL)" -> "10fifty llc"
  const stripParens = (s) => s.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  const Ap = stripParens(A);
  const Bp = stripParens(B);
  if (Ap && Bp && Ap === Bp) return { match: true, score: 0.95, reason: 'parentheticals' };
  // Substring containment — one fully contains the other after parens strip
  if (Ap && Bp && (Ap.includes(Bp) || Bp.includes(Ap))) {
    return { match: true, score: 0.88, reason: 'substring' };
  }
  // Drop common business-suffix noise then compare ("acme co" ≡ "acme co llc")
  const stripSuffixes = (s) => s
    .replace(/[.,]/g, ' ')
    .replace(/\b(llc|llp|ltd|limited|inc|incorporated|corp|corporation|co|company|gmbh|ag|sa|sl|bv|pty|plc|sàrl|sarl|kg|holdings?|group|enterprises?|partners?)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const As = stripSuffixes(Ap);
  const Bs = stripSuffixes(Bp);
  if (As && Bs && As === Bs) return { match: true, score: 0.92, reason: 'suffixes' };
  if (As && Bs && (As.includes(Bs) || Bs.includes(As)) && Math.min(As.length, Bs.length) >= 4) {
    return { match: true, score: 0.85, reason: 'suffix-substring' };
  }
  // Token-set Jaccard — same vendor with shuffled words / typos in one
  // ("Jane M Doe" vs "Doe Jane M"). Tokens >= 2 chars to skip noise.
  const tokens = (s) => new Set((s || '').split(/\s+/).filter(t => t.length >= 2));
  const At = tokens(As || Ap);
  const Bt = tokens(Bs || Bp);
  if (At.size >= 2 && Bt.size >= 2) {
    let inter = 0;
    for (const t of At) if (Bt.has(t)) inter++;
    const jaccard = inter / (At.size + Bt.size - inter);
    if (jaccard >= 0.7) return { match: true, score: 0.6 + 0.3 * jaccard, reason: `tokens-${jaccard.toFixed(2)}` };
  }
  return { match: false, score: 0, reason: 'no-match' };
}


/**
 * Are these two spellings of the SAME vendor? — the squashed view.
 *
 * ── Why this sits next to vendorsMatch instead of inside it ──
 * vendorsMatch compares WORDS. That is right for most of what it does and blind
 * to the one shape a bank descriptor produces constantly: the spaces are gone.
 * "KYRAJOHNSON" against "Kyra Johnson" is one token against two, every rule in
 * vendorsMatch works on space-separated words, and the pair scores 0.00 — the
 * same score as two strangers. Ten live matches sit in that state, and they look
 * identical to a genuinely wrong match unless something answers this question
 * separately.
 *
 * So this is deliberately NARROW. It is not a similarity score and not a second
 * opinion on vendorsMatch — it is the answer to "is this literally the same
 * name, written differently", used to keep provably-fine pairs out of a review
 * queue a person has to work by hand.
 *
 * ── Two rules, and why not a third ──
 * Measured against all 237 live name-disagreeing matches: clears 18, every one
 * of them the same vendor, none of them a wrong match.
 *
 *   1. Equal once accents, spacing, punctuation and legal suffixes are gone.
 *      涛 汪 / 涛汪 · F4LMANAGEMENT LTD / F4L Management Ltd · KYRAJOHNSON / Kyra Johnson
 *   2. One character apart, on squashed forms of 5+ characters.
 *      Seddy OU / Sedyy OÜ · OMNON Music / OMNOM Music · HARRYBURBUR / Harry Burbury
 *
 * There is NO nickname rule, and that is a finding rather than an omission.
 * "Katherine Stephenson" / "Kate Stephenson" is the only live case, and it fails
 * a prefix test ("kath" vs "kate"); every formulation loose enough to catch it
 * also merges "Chris" into "Christina". One card in a queue beats a rule that
 * silently merges two people.
 *
 * ── Not routed through lib/funding-pairs.js ──
 * That file squashes too (`squashedHit`), and sharing the helper would mean
 * sharing its `nameTokens` — a different suffix list and a 3-character minimum
 * token. Changing those changes `namesRecipient` and `descriptorMentions`, both
 * shipped and both load-bearing on money. funding-pairs.js already keeps those
 * two apart from each other for exactly this reason; this is the same argument
 * one level out.
 *
 * @returns {string|null} why they are the same name, or null. A reason rather
 *   than a boolean because every caller has to be able to SHOW its evidence —
 *   an auto-cleared row that cannot say why it was cleared is indistinguishable
 *   from a row that was never checked.
 */

// Legal-entity noise. Matches the vocabulary vendorsMatch strips above, plus the
// non-anglophone forms that turn up on Market Street's roster ("Sedyy OÜ", "CW Media
// Group S.R.L.") — punctuation is already gone by the time this runs, so
// "S.R.L." arrives as "srl".
const SQUASH_SUFFIX = new Set([
  'llc', 'llp', 'ltd', 'limited', 'inc', 'incorporated', 'corp', 'corporation',
  'co', 'company', 'gmbh', 'ag', 'sa', 'sl', 'bv', 'pty', 'plc', 'sarl', 'kg',
  'ou', 'srl', 'oy', 'ab', 'as', 'nv', 'spa', 'pte',
]);

// NFKD then drop combining marks: "Ö" becomes "O", "Barrón" becomes "barron".
// \p{M} rather than a hand-written range, so this covers every script — the
// live ledger carries CJK payees, and a Latin-only rule would leave them
// permanently unclearable.
const squashTokens = (s) => String(s || '')
  .normalize('NFKD')
  .replace(/\p{M}/gu, '')
  .toLowerCase()
  .split(/[^\p{L}\p{N}]+/u)
  .filter((w) => w && !SQUASH_SUFFIX.has(w));

const squashName = (s) => squashTokens(s).join('');

// Private on purpose. Three copies of this already live in routes/ (flags,
// bookkeeping, artists); a lib must not import from a route, and exporting a
// fourth public one invites a fifth.
function squashLev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  // Length alone settles it past the only threshold any caller uses.
  if (Math.abs(a.length - b.length) > 1) return 2;
  const n = b.length;
  const v = new Array(n + 1);
  for (let j = 0; j <= n; j++) v[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = v[0];
    v[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = v[j];
      v[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, v[j], v[j - 1]);
      prev = tmp;
    }
  }
  return v[n];
}

// 5, not 4. Below this a single edit stops being a typo and starts being a
// different name — "Neo" and "Nero", "S7" and "S8". Every live case this needs
// to catch is 5 or longer ("seddy" is exactly 5).
const MIN_LEV_LEN = 5;

function sameSquashedName(a, b) {
  const A = squashName(a);
  const B = squashName(b);
  if (!A || !B) return null;
  if (A === B) return 'the same name once spacing, punctuation, accents and legal suffixes are removed';
  if (A.length >= MIN_LEV_LEN && B.length >= MIN_LEV_LEN && squashLev(A, B) <= 1) {
    return `one character apart once squashed (${A} / ${B})`;
  }
  return null;
}

module.exports = { vendorsMatch, sameSquashedName, squashName };
