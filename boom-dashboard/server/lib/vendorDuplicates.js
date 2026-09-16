/**
 * Duplicate-vendor detection — the SUGGESTION side only.
 *
 * Deliberately separate from lib/vendorMatch.js, which is shared with the bank
 * matcher (statements.js:615 is its name-evidence tier) and the ledger-diff
 * reconciliation. The two jobs want opposite error trade-offs:
 *
 *   the MATCHER      a wrong match writes a silent false payment record that
 *                    nothing downstream contradicts → favour precision
 *   this DETECTOR    a wrong suggestion costs one "not duplicates" click, while
 *                    a miss leaves a vendor permanently split across two rows
 *                    → favour recall, and use ORDERING to manage the noise
 *
 * So none of the loosening here may leak into vendorsMatch. It is called for
 * the tiers that already work; everything added is local.
 *
 * ── What was missing, measured on 874 live vendor names ──────────────────────
 *
 * The old detector returned 12 pairs. Three defects, each independent:
 *
 * D1  It bucketed the pairwise scan by `norm(payee)[0]`, so two names starting
 *     with different letters were NEVER COMPARED. 60 pairs the existing scorer
 *     already matches were hidden by that alone — "SPOTIFY USA INC" ~ "PURCHASE
 *     SPOTIFY USA INC NY", "NETFLIX.COM" ~ "PAYPAL NETFLIX.COM", and the case
 *     that prompted this: "Kate Stephenson" ~ "Zelle payment to Kate Stephenson
 *     for…", which vendorsMatch scores 0.88. The blocking was the only reason
 *     nobody was asked.
 *
 * D2  vendorsMatch's last tier is token-set Jaccard gated at >= 0.7. For two
 *     tokens on each side the ONLY possible values are 0, 1/3 and 1 — and 1 is
 *     already caught by the norm-equal test above it. So for two-word names,
 *     which is nearly every personal-name vendor, that tier is dead code.
 *     "Kate Stephenson" vs "Katherine Stephenson" scored no-match.
 *
 * D3  Its substring tier fires at 0.88 on ANY containment, with no length or
 *     word-boundary guard — note the asymmetry, since suffix-substring BELOW it
 *     scores lower yet requires min length 4. Removing the blocking without
 *     fixing this floods the list: "ads" ~ "CROSSROADS", "Raf" ~ "alrafat
 *     abiyyu", "Angel" ~ "TST BLONDIE LOS ANGELES".
 */

const { vendorsMatch } = require('./vendorMatch');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (s) => norm(s).split(' ').filter(Boolean);

// Words that mark a string as a BANK DESCRIPTOR rather than a vendor name, so a
// containment can be labelled for what it is: "the vendor's name wrapped in a
// payment description". Only used for the reason text — never to gate a match.
const DESCRIPTOR_WORDS = /\b(zelle|payment|payments|transfer|purchase|checkcard|ckcd|wire|ach|deposit|withdrawal|via|from|to|for)\b/;

// A token has to be this long to be a blocking key. Below it the index degrades
// into "every vendor sharing the word 'the'".
const BLOCK_TOKEN_MIN = 4;
// A token appearing in more vendors than this is not identifying — it is noise
// ("purchase" is in 200+ descriptors). Skipping it keeps the candidate set small
// without losing pairs, because a real duplicate shares a distinctive token too.
const BLOCK_TOKEN_MAX_VENDORS = 200;

/**
 * Is this containment trustworthy, or just two strings that happen to overlap?
 *
 * Two shapes count, and the OR matters — an early return on the first branch
 * rejected "Angel" ⊂ "Angel Melendez" and "Clipix" ⊂ "Clipix Corp", which are
 * real:
 *
 *   TRUNCATION   the shorter side is a PREFIX of the longer and >= 8 chars.
 *                Banks truncate descriptors to a fixed width, so the cut lands
 *                mid-word and a boundary test would reject the most common
 *                legitimate case in the data: "Slingshot Creative L" ⊂
 *                "Slingshot Creative LLC", "Salmon Studios Limit" ⊂ "…Limited",
 *                "Ferrara & Pisarek PL" ⊂ "…PLLC". 42 live matches have that
 *                shape, every one of them correct.
 *
 *   WHOLE WORD   the containment lands on non-alphanumeric boundaries on both
 *                sides and the shorter side is >= 4 chars. This is what keeps
 *                "SPOTIFY USA INC" ⊂ "PURCHASE SPOTIFY USA INC NY" while
 *                rejecting "ads" ⊂ "crossroads" and "angel" ⊂ "los angeles".
 *
 * Validated against 16 named cases and 125 live substring-derived matches:
 * 5 junk pairs blocked, 11 wanted pairs kept, 0 misclassifications.
 */
// The business-suffix noise vendorsMatch strips before its own comparison. Kept
// in step with stripSuffixes() there — see why in containmentConfidence.
const BUSINESS_SUFFIX = /\b(llc|llp|ltd|limited|inc|incorporated|corp|corporation|co|company|gmbh|ag|sa|sl|bv|pty|plc|sarl|kg|holdings?|group|enterprises?|partners?)\b/g;
const stripSuffixes = (s) => norm(s).replace(BUSINESS_SUFFIX, '').replace(/\s+/g, ' ').trim();

function confidenceOf(long, short) {
  if (!long || !short || !long.includes(short)) return 'none';
  if (long.startsWith(short) && short.length >= 8) return 'confident';
  if (short.length >= 4) {
    const i = long.indexOf(short);
    const before = i === 0 ? ' ' : long[i - 1];
    const after = (i + short.length >= long.length) ? ' ' : long[i + short.length];
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return 'confident';
    // Overlapping but not on a boundary and not a long prefix. Still shown when
    // there is enough of it to be worth a human glance — see the `weak` tier.
    return 'weak';
  }
  return 'none';
}

function containmentConfidence(a, b) {
  // Tested against BOTH the plain normalised pair and the suffix-stripped pair,
  // taking the strongest result.
  //
  // Because vendorsMatch has two containment tiers that compare different
  // strings: `substring` on the raw (paren-stripped) names, and
  // `suffix-substring` AFTER dropping llc/ltd/inc/group/…. Testing only the
  // plain pair silently rejected everything the second tier found — measured, it
  // lost "Sushi Sushi Tunes LLC" ~ "SUSHI SUSHI LLC", a merge a human had
  // already confirmed, because "sushi sushi llc" is not a substring of "sushi
  // sushi tunes llc" until both `llc`s are gone. A guard has to be evaluated
  // against the same strings the tier matched on.
  const pairs = [[norm(a), norm(b)], [stripSuffixes(a), stripSuffixes(b)]];
  let best = 'none';
  for (const [A, B] of pairs) {
    if (!A || !B) continue;
    const [long, short] = A.length <= B.length ? [B, A] : [A, B];
    const c = confidenceOf(long, short);
    if (c === 'confident') return 'confident';
    if (c === 'weak') best = 'weak';
  }
  return best;
}

/**
 * Same surname, and one first name is a short form of the other.
 *
 * The D2 fix. Anchored on an EXACT surname match, because that is the part
 * people do not abbreviate, then requires the first names to share a prefix of
 * at least 3 letters:
 *
 *   suggests   Kate/Katherine ("kat")  Rob/Robert ("rob")  Jen/Jennifer ("jen")
 *              Chris/Christopher       Dave/David          Kim/Kimberly
 *   never      "John Smith" ~ "Jane Smith" — "jo"/"ja" share one letter, and
 *              two different people sharing a surname is the failure mode that
 *              matters most here.
 *   misses     Mike/Michael, Bill/William, Bob/Robert — phonetic short forms
 *              share too little. A nickname table would catch them; John's call
 *              was to skip it rather than carry a list that only knows the
 *              names somebody thought to add.
 *
 * Capped at 3 tokens a side so company names with a shared last word ("Dean
 * Street Media Group" vs "Orpheus Media Group") cannot come through here.
 */
function surnameShortForm(a, b) {
  const A = tokens(a), B = tokens(b);
  if (A.length < 2 || B.length < 2 || A.length > 3 || B.length > 3) return null;
  if (A[A.length - 1] !== B[B.length - 1]) return null;
  const fa = A[0], fb = B[0];
  if (fa === fb) return null;

  let shared = 0;
  while (shared < Math.min(fa.length, fb.length) && fa[shared] === fb[shared]) shared++;
  if (shared >= 3) {
    return `same surname — "${fa}" and "${fb}" share their first ${shared} letters`;
  }
  // "K Stephenson" vs "Katherine Stephenson": an initial is a legitimate short
  // form, but ONLY as an initial — 1-2 chars, matching first letter.
  if ((fa.length <= 2 && fb[0] === fa[0]) || (fb.length <= 2 && fa[0] === fb[0])) {
    return 'same surname — one first name is just an initial';
  }
  return null;
}

/**
 * Candidate pairs, via a token inverted index rather than a first-letter bucket.
 *
 * The blocking key is "shares a distinctive token", which is what actually makes
 * two vendor names candidates — and it is the fix for D1, because a name wrapped
 * in a descriptor shares tokens with the bare name while starting with a
 * different letter. On the live 874 names this yields ~1,500 candidate pairs in
 * ~15ms, against 381k for an unblocked scan.
 *
 * Norm-equal names are added unconditionally: two vendors can be the same after
 * normalisation while sharing no token >= 4 chars ("A&B" / "a b").
 */
function candidatePairs(vendors) {
  const index = new Map();
  const byNorm = new Map();
  vendors.forEach((v, i) => {
    const n = norm(v.payee);
    if (n) {
      if (!byNorm.has(n)) byNorm.set(n, []);
      byNorm.get(n).push(i);
    }
    for (const t of new Set(tokens(v.payee))) {
      if (t.length < BLOCK_TOKEN_MIN) continue;
      if (!index.has(t)) index.set(t, []);
      index.get(t).push(i);
    }
  });

  const pairs = new Set();
  const add = (i, j) => pairs.add(i < j ? `${i}:${j}` : `${j}:${i}`);
  for (const list of index.values()) {
    if (list.length > BLOCK_TOKEN_MAX_VENDORS) continue;
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) add(list[x], list[y]);
    }
  }
  for (const list of byNorm.values()) {
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) add(list[x], list[y]);
    }
  }
  return [...pairs].map((k) => k.split(':').map(Number));
}

/**
 * Score one pair. Returns { score, reason, tier } or null.
 *
 * `tier` is what the caller acts on:
 *   'exact'  — norm-equal. The ONLY tier the endpoint may auto-merge, unchanged
 *              from before this module existed.
 *   'strong' — a confident containment, a suffix/parenthetical variant, or a
 *              surname short form. Suggest, never auto-apply.
 *   'weak'   — overlapping mid-word. Suggested LAST rather than dropped.
 *
 * Demote-don't-drop is deliberate. A hard filter would have hidden
 * "LAWRENCE H. KATZ, P." ~ "Law Offices of Lawrence H. Katz," — four live rows,
 * genuinely one firm — and "Dean Street Media In" ~ "Dean St". In a list a human
 * reviews, ordering is the tool; exclusion throws the answer away. Below 4 chars
 * is still dropped outright: that is where "ads" and "Raf" live, and no amount
 * of ordering makes them useful.
 */
function scorePair(a, b) {
  const nA = norm(a), nB = norm(b);
  // Non-Latin names normalise to '' — empty must never equal empty, or every
  // pair of CJK/Cyrillic vendors reads as "same name".
  if (!nA || !nB) return null;

  if (nA === nB) {
    return { score: 100, reason: 'same name — case/punctuation variant', tier: 'exact' };
  }

  const nick = surnameShortForm(a, b);
  if (nick) return { score: 78, reason: nick, tier: 'strong' };

  const m = vendorsMatch(a, b);
  if (!m.match || m.score < 0.75) return null;

  if (m.reason === 'substring' || m.reason === 'suffix-substring') {
    const conf = containmentConfidence(a, b);
    if (conf === 'none') return null;
    const [long, short] = nA.length <= nB.length ? [nB, nA] : [nA, nB];
    // Name inside a payment description — worth saying, because the fix is
    // usually "this was never a vendor, it is a descriptor".
    const wrapped = DESCRIPTOR_WORDS.test(long) && !DESCRIPTOR_WORDS.test(short);
    if (conf === 'weak') {
      return {
        score: 68,
        reason: 'weaker — one name appears inside the other, but mid-word',
        tier: 'weak',
      };
    }
    return {
      score: Math.round(m.score * 100),
      reason: wrapped
        ? 'one name is the other wrapped in a bank descriptor'
        : `similar name (${m.reason})`,
      tier: 'strong',
    };
  }

  return { score: Math.round(m.score * 100), reason: `similar name (${m.reason})`, tier: 'strong' };
}

module.exports = {
  norm,
  tokens,
  candidatePairs,
  scorePair,
  containmentConfidence,
  surnameShortForm,
};
