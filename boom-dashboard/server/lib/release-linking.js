// Shared helpers for keeping expenses.release_id in sync with releases.
//
// The link is what powers the ledger's "song → release" jump icon plus every
// release-scoped rollup on Financials / Recoupments. Two failure modes we've
// hit in the wild:
//   1. Expense was created BEFORE the release existed → release_id stayed
//      NULL and nothing ever came back to fix it.
//   2. Ledger song text was written with a subtle formatting difference vs
//      the release's project_name — curly apostrophe, double-space,
//      leading/trailing whitespace, straight vs em-dash. Pure LOWER+TRIM
//      misses these.
//
// The functions here fix both: `autoLinkRelease` handles individual writes,
// `relinkExpensesForRelease` handles retroactive linking whenever a release
// is created or renamed, and `normalizeSongMatch` is the shared fuzzy pass.
//
// Design note: kept intentionally SIMPLE. No Levenshtein / trigram / Claude
// call. All matches are still deterministic string equality — we only widen
// what counts as "equal". Widening beyond this (e.g., stripping "(feat. X)"
// or "(remix)" suffixes) would cross into judgment calls that legitimately
// belong to a human review, so we don't.

const pool = require('../db');

// Normalize a song title for equality-based fuzzy matching. Only touches
// safely-normalizable characters — anything that could change meaning (an
// actual word, punctuation inside the title, etc.) is preserved.
function normalizeSongMatch(s) {
  if (s == null) return '';
  return String(s)
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")   // curly / modifier apostrophes → straight
    .replace(/[“”]/g, '"')          // curly double quotes → straight
    .replace(/[–—]/g, '-')          // en/em dash → hyphen
    .replace(/[ ]/g, ' ')                // non-breaking space → regular space
    .replace(/\s+/g, ' ')                     // collapse whitespace
    .trim();
}

// Same for artist names — even though the artist normalization lib handles
// most cases, keeping this local helper means the two passes below stay
// symmetric.
function normalizeArtistMatch(s) {
  if (s == null) return '';
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Link (or unlink) a single expense to a release based on its artist +
// song. Two-pass:
//   Pass 1 (SQL): exact LOWER(TRIM(...)) equality on both artist and song.
//     Fast, hits the vast majority of cases with a single query.
//   Pass 2 (JS): if Pass 1 misses, load all releases for the same artist
//     and compare normalized song strings in JS. Handles the fuzzy cases
//     that LOWER+TRIM can't reach.
// Empty song clears the link — matches the previous behavior so renaming
// a song from a matching one to a non-matching one unhooks the row.
async function autoLinkRelease(entryId, artistName, songName) {
  if (!songName || !songName.trim()) {
    try { await pool.query('UPDATE expenses SET release_id = NULL WHERE id = $1', [entryId]); } catch (_) {}
    return null;
  }
  try {
    // Pass 1 — exact case-insensitive match
    const { rows: exact } = await pool.query(`
      SELECT r.id FROM releases r
      JOIN artists a ON r.artist_id = a.id
      WHERE LOWER(TRIM(a.name)) = LOWER(TRIM($1))
        AND LOWER(TRIM(r.project_name)) = LOWER(TRIM($2))
      LIMIT 1
    `, [artistName || '', songName]);
    let newId = exact.length ? exact[0].id : null;

    // Pass 2 — normalized fallback (quotes / whitespace / dashes)
    if (!newId && artistName && artistName.trim()) {
      const { rows: candidates } = await pool.query(`
        SELECT r.id, r.project_name FROM releases r
        JOIN artists a ON r.artist_id = a.id
        WHERE LOWER(TRIM(a.name)) = LOWER(TRIM($1))
      `, [artistName]);
      const target = normalizeSongMatch(songName);
      const hit = candidates.find(c => normalizeSongMatch(c.project_name) === target);
      if (hit) newId = hit.id;
    }

    await pool.query('UPDATE expenses SET release_id = $1 WHERE id = $2', [newId, entryId]);
    return newId;
  } catch (_) {
    return null;
  }
}

// Retroactively link any orphan expenses to this release. Called whenever
// a release is created OR renamed so old expenses that predate the release
// (or that were typed with a slightly different casing) pick up the link
// automatically. Only touches rows with release_id IS NULL — never
// overwrites an existing link.
async function relinkExpensesForRelease(releaseId) {
  const { rows: releaseRows } = await pool.query(
    `SELECT r.id, r.project_name, a.name AS artist_name
       FROM releases r JOIN artists a ON r.artist_id = a.id
      WHERE r.id = $1`,
    [releaseId]
  );
  if (!releaseRows.length) return { linked: 0 };
  const { artist_name, project_name } = releaseRows[0];

  // Pass 1 — SQL UPDATE for the exact case-insensitive rows
  const exact = await pool.query(`
    UPDATE expenses
       SET release_id = $1
     WHERE release_id IS NULL
       AND (deleted = false OR deleted IS NULL)
       AND artist IS NOT NULL AND TRIM(artist) <> ''
       AND song   IS NOT NULL AND TRIM(song)   <> ''
       AND LOWER(TRIM(artist)) = LOWER(TRIM($2))
       AND LOWER(TRIM(song))   = LOWER(TRIM($3))
  `, [releaseId, artist_name, project_name]);

  // Pass 2 — pull remaining orphans for this artist and match in JS
  const { rows: candidates } = await pool.query(`
    SELECT id, song FROM expenses
     WHERE release_id IS NULL
       AND (deleted = false OR deleted IS NULL)
       AND song IS NOT NULL AND TRIM(song) <> ''
       AND LOWER(TRIM(artist)) = LOWER(TRIM($1))
  `, [artist_name]);
  const target = normalizeSongMatch(project_name);
  let fuzzy = 0;
  for (const c of candidates) {
    if (normalizeSongMatch(c.song) === target) {
      await pool.query('UPDATE expenses SET release_id = $1 WHERE id = $2', [releaseId, c.id]);
      fuzzy++;
    }
  }
  return { linked: (exact.rowCount || 0) + fuzzy };
}

module.exports = {
  normalizeSongMatch,
  normalizeArtistMatch,
  autoLinkRelease,
  relinkExpensesForRelease,
};
