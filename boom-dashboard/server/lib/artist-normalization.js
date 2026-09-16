const pool = require('../db');

// Resolve a raw multi-artist string ("Ezra feat. Kendrick") to its
// registered base artist ("Ezra"), when one exists. Returns the raw
// string unchanged when no mapping applies. Called at insert time
// from every entry-creation path so future rows normalize automatically —
// mappings are registered by the Multi-Artist flag on /flags.
//
// Lookup key = LOWER(TRIM(raw)) — matches the source_key convention
// used by the flag's apply endpoint when it upserts into
// artist_normalization.
async function applyArtistNormalization(raw) {
  const s = String(raw || '').trim();
  if (!s) return raw;
  const key = s.toLowerCase();
  const { rows } = await pool.query(
    `SELECT base_artist FROM artist_normalization WHERE source_key = $1`,
    [key]
  ).catch(() => ({ rows: [] }));
  return rows[0]?.base_artist || raw;
}

module.exports = { applyArtistNormalization };
