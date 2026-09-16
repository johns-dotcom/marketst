/**
 * Does a row name an artist, and which one — ONE definition.
 *
 * ── Why this file exists ──
 * There were two answers to "does this row name an artist", and they disagreed:
 *
 *   routes/reports.js   artistBucketKey() → placeholders become '' (unattributed)
 *   routes/statements.js needsArtist()    → String(artist).trim() === '' only
 *
 * So an entry carrying the literal string "unknown" or "N/A" was ATTRIBUTED as far
 * as the vendor page, the vendors directory count and the needs-artist queue were
 * concerned, and UNATTRIBUTED as far as the P&L, Spend by Artist and the artist
 * drill were concerned. John found it on Karen Curry, 2026-08-18: "these items
 * were booked to artists yet still show up in the not attributed to an artist
 * section". Entry 4286 held artist = "unknown"; the vendor page printed that as
 * though it were a name and reported nothing left to do, while the report counted
 * the money as nobody's.
 *
 * Live ledger when this was written: 43 entries / $272,931.32 carry a placeholder —
 * "n/a" (23), "N/A" (15), "unknown" (4), "NA" (1). On the P&L basis "N/A" and "NA"
 * had previously ranked as the #1 and #8 "artists" at $190,875 between them.
 *
 * ── The client keeps a mirror, deliberately ──
 * client/src/utils.js holds the same set for the Bank Matching artist lens, because
 * one copy runs in the API and one in the browser. If they drift, the same spend is
 * an artist on one screen and unattributed on the other. Keep them identical.
 */

// Stricter than `LOWER(TRIM())`: punctuation and spacing go too, so "Nobody
// Serious" and "nobody-serious" are one artist. That is the right rule for "how
// many artists are there" and the wrong one for "is this the artist the filter
// asked for" — the latter stays on artistEq in reports.js.
// On the live ledger this key collapses 197 raw spellings to 127.
const artistKeyOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Things typed into the artist field that carry no artist information. Normalized
// keys, so "N/A", "n/a" and "NA" are all one entry here.
//
// "unknown" WAS here and was removed 2026-08-19 on John's explicit call, after
// being shown the consequence: he wanted it usable as a real artist name, and
// with it on this list the artist pickers accepted it and then never offered it
// back, while every report counted rows filed under it as unattributed.
//
// So a row whose artist is "unknown" now COUNTS as attributed — it appears on
// Spend by Artist as an artist called "unknown" and leaves the placeholder
// queue. That is the trade he chose. Do not put it back without asking him:
// six live rows and $239,858 moved on this one word.
//
// The list is mirrored in client/src/utils.js and routes/bookkeeping.js
// (ARTIST_PLACEHOLDERS, which filters the pickers). All three must stay
// identical or the same spend is an artist on one screen and nobody on another.
const PLACEHOLDER_ARTIST_KEYS = new Set([
  'na', 'nan', 'none', 'null', 'unassigned', 'tbd', 'tba',
  'various', 'variousartists', 'misc', 'miscellaneous', 'other', 'general',
]);

/** '' means unattributed — empty, or a placeholder standing in for a name. */
const artistBucketKey = (raw) => {
  const k = artistKeyOf(raw);
  return PLACEHOLDER_ARTIST_KEYS.has(k) ? '' : k;
};

/**
 * Is this a real artist name?
 *
 * The one question every surface should ask. `!namesAnArtist(x)` is the correct
 * test for "this row still needs an artist" — an emptiness check lets a
 * placeholder masquerade as an answer, which is how a row could read as done on
 * one page and unattributed on another.
 */
const namesAnArtist = (raw) => artistBucketKey(raw) !== '';

/**
 * What to SHOW for a row's artist, or null when there is nothing to show.
 *
 * Placeholders return null rather than their stored text: printing "unknown" in an
 * artist column states an attribution that no report agrees with. The stored value
 * is left alone — this is a display and predicate rule, not a data migration.
 */
const artistLabel = (raw) => (namesAnArtist(raw) ? String(raw).trim() : null);

module.exports = { artistKeyOf, PLACEHOLDER_ARTIST_KEYS, artistBucketKey, namesAnArtist, artistLabel };
