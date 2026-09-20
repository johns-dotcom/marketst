// The artist stats feed. Spotify for Artists has no API, so:
//   spotify      Spotify Web API (client credentials, the keys releases already use):
//                followers, popularity, top tracks — one row per artist per day
//   chartmetric  optional, paid: monthly listeners (CHARTMETRIC_REFRESH_TOKEN)
// Runs daily from lib/integrations-worker.js, and on demand from the profile.
// Env: ARTIST_STATS_DRY_RUN=1 makes both sources return deterministic numbers (fixtures).
const pool = require('../db');
const spotify = require('../services/spotify');
const { request } = require('./http-json');

const DRY = () => process.env.ARTIST_STATS_DRY_RUN === '1';
const spotifyConfigured = () => !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) || DRY();
const chartmetricConfigured = () => !!process.env.CHARTMETRIC_REFRESH_TOKEN || DRY();
const today = () => new Date().toISOString().slice(0, 10);

const spGet = async (path, token) => {
  const r = await request(`https://api.spotify.com/v1${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 429) throw new Error(`Spotify rate limit (retry after ${r.headers['retry-after'] || '?'}s)`);
  if (r.status >= 400) throw new Error(`Spotify ${path}: HTTP ${r.status}`);
  return r.json;
};

// Which Spotify artist this is: the stored id, then artists.spotify_url, then
// a Spotify link on the profile, then a name search. The answer is stored.
async function resolveSpotifyId(artist, token) {
  if (artist.spotify_id) return artist.spotify_id;
  const fromUrl = (u) => { const m = /artist\/([a-zA-Z0-9]+)/.exec(String(u || '')); return m ? m[1] : null; };
  let id = fromUrl(artist.spotify_url);
  if (!id) { const { rows } = await pool.query(`SELECT url FROM artist_links WHERE artist_id = $1 AND LOWER(platform) = 'spotify' LIMIT 1`, [artist.id]).catch(() => ({ rows: [] })); id = fromUrl(rows[0]?.url); }
  if (!id && !DRY()) {
    const q = await spGet(`/search?q=${encodeURIComponent(artist.name)}&type=artist&limit=5`, token);
    const items = q?.artists?.items || [];
    const exact = items.find((a) => a.name.toLowerCase() === artist.name.toLowerCase());
    id = (exact || items[0])?.id || null;
  }
  if (!id && DRY()) id = `dry${artist.id}`;
  if (id) await pool.query('UPDATE artists SET spotify_id = $2 WHERE id = $1 AND spotify_id IS NULL', [artist.id, id]).catch(() => {});
  return id;
}

async function fetchSpotify(artist, token) {
  const id = await resolveSpotifyId(artist, token);
  if (!id) return null;
  if (DRY()) return { id, followers: 1000 + artist.id * 7 + Number(today().slice(-2)), popularity: 40 + (artist.id % 30), top_tracks: [{ id: 't1', name: 'Dry Track', popularity: 50, album: 'Dry Album', preview: null, url: null }], raw: { dry: true } };
  const [a, top] = await Promise.all([spGet(`/artists/${id}`, token), spGet(`/artists/${id}/top-tracks?market=US`, token).catch(() => ({ tracks: [] }))]);
  return {
    id, followers: a?.followers?.total ?? null, popularity: a?.popularity ?? null,
    top_tracks: (top?.tracks || []).slice(0, 10).map((t) => ({ id: t.id, name: t.name, popularity: t.popularity, album: t.album?.name, url: t.external_urls?.spotify, image: t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || null })),
    raw: { genres: a?.genres || [], image: a?.images?.[0]?.url || null, url: a?.external_urls?.spotify || null },
  };
}

// ─── Chartmetric ─────────────────────────────────────────────────────────
let cmToken = null, cmExpiry = 0;
async function cmAccess() {
  if (cmToken && Date.now() < cmExpiry) return cmToken;
  const r = await request('https://api.chartmetric.com/api/token', { method: 'POST', body: { refreshtoken: process.env.CHARTMETRIC_REFRESH_TOKEN } });
  if (r.status >= 400 || !r.json?.token) throw new Error(`Chartmetric token: HTTP ${r.status}`);
  cmToken = r.json.token; cmExpiry = Date.now() + (Number(r.json.expires_in || 3600) - 60) * 1000;
  return cmToken;
}
const cmGet = async (path) => {
  const r = await request(`https://api.chartmetric.com/api${path}`, { headers: { Authorization: `Bearer ${await cmAccess()}` } });
  if (r.status === 429) throw new Error('Chartmetric rate limit');
  if (r.status >= 400) throw new Error(`Chartmetric ${path}: HTTP ${r.status}`);
  return r.json?.obj ?? r.json;
};
// Chartmetric's id for this artist, looked up from the Spotify id (their
// /artist/spotify/:id/get-ids), stored on the artist once found.
async function resolveChartmetricId(artist, spotifyId) {
  if (artist.chartmetric_id) return artist.chartmetric_id;
  if (!spotifyId && !DRY()) return null;
  if (DRY()) { const dryId = `cm${artist.id}`; await pool.query('UPDATE artists SET chartmetric_id = $2 WHERE id = $1 AND chartmetric_id IS NULL', [artist.id, dryId]).catch(() => {}); return dryId; }
  const obj = await cmGet(`/artist/spotify/${encodeURIComponent(spotifyId)}/get-ids`).catch(() => null);
  const first = Array.isArray(obj) ? obj[0] : obj;
  const id = first?.chartmetric_ids?.[0] ?? first?.cm_artist ?? first?.id ?? null;
  if (id) await pool.query('UPDATE artists SET chartmetric_id = $2 WHERE id = $1 AND chartmetric_id IS NULL', [artist.id, String(id)]).catch(() => {});
  return id ? String(id) : null;
}
async function fetchChartmetric(artist, spotifyId) {
  const id = await resolveChartmetricId(artist, spotifyId);
  if (!id) return null;
  if (DRY()) return { id, monthly_listeners: 50000 + artist.id * 101 + Number(today().slice(-2)) * 10, raw: { dry: true } };
  const a = await cmGet(`/artist/${encodeURIComponent(id)}`);
  const st = a?.cm_statistics || a?.statistics || {};
  return { id, monthly_listeners: st.sp_monthly_listeners ?? st.spotify_monthly_listeners ?? null, followers: st.sp_followers ?? null, popularity: st.sp_popularity ?? null, raw: { rank: a?.cm_artist_rank ?? null, score: a?.cm_artist_score ?? null } };
}

async function upsert(artistId, source, row) {
  await pool.query(`INSERT INTO artist_stats (artist_id, source, day, followers, popularity, monthly_listeners, top_tracks, raw, fetched_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, NOW())
    ON CONFLICT (artist_id, source, day) DO UPDATE SET followers = EXCLUDED.followers, popularity = EXCLUDED.popularity, monthly_listeners = EXCLUDED.monthly_listeners, top_tracks = EXCLUDED.top_tracks, raw = EXCLUDED.raw, fetched_at = NOW()`,
    [artistId, source, today(), row.followers ?? null, row.popularity ?? null, row.monthly_listeners ?? null, JSON.stringify(row.top_tracks || null), JSON.stringify(row.raw || null)]);
}

async function refreshArtist(artist) {
  const out = { artist_id: artist.id, spotify: null, chartmetric: null, error: null };
  try {
    let spotifyId = artist.spotify_id || null;
    if (spotifyConfigured()) {
      const token = DRY() ? 'dry' : await spotify.getAccessToken();
      const s = await fetchSpotify(artist, token);
      if (s) { await upsert(artist.id, 'spotify', s); spotifyId = s.id; out.spotify = { followers: s.followers, popularity: s.popularity }; }
    }
    if (chartmetricConfigured()) {
      const c = await fetchChartmetric(artist, spotifyId);
      if (c) { await upsert(artist.id, 'chartmetric', c); out.chartmetric = { monthly_listeners: c.monthly_listeners }; }
    }
  } catch (e) { out.error = e.message; }
  return out;
}

async function refreshAll() {
  if (!spotifyConfigured() && !chartmetricConfigured()) return { skipped: 'no source configured' };
  const { rows } = await pool.query(`SELECT id, name, spotify_id, spotify_url, chartmetric_id FROM artists WHERE (archived = false OR archived IS NULL) AND name !~* '^(various|unknown|tbd)' ORDER BY id`);
  const out = { artists: rows.length, spotify: 0, chartmetric: 0, errors: [] };
  for (const a of rows) {
    const r = await refreshArtist(a);
    if (r.spotify) out.spotify += 1; if (r.chartmetric) out.chartmetric += 1; if (r.error) out.errors.push({ id: a.id, name: a.name, error: r.error });
    if (!DRY()) await new Promise((res) => setTimeout(res, 250)); // gentle on both rate limits
  }
  return out;
}

async function history(artistId, days = 90) {
  const { rows } = await pool.query(`SELECT source, day, followers, popularity, monthly_listeners, top_tracks, raw, fetched_at FROM artist_stats WHERE artist_id = $1 AND day >= CURRENT_DATE - $2::int ORDER BY day ASC`, [artistId, days]);
  const by = (src) => rows.filter((r) => r.source === src);
  const sp = by('spotify'), cm = by('chartmetric');
  const latest = (list) => (list.length ? list[list.length - 1] : null);
  const first = (list) => (list.length ? list[0] : null);
  const delta = (list, key) => (list.length > 1 && latest(list)[key] != null && first(list)[key] != null ? latest(list)[key] - first(list)[key] : null);
  return {
    sources: { spotify: spotifyConfigured(), chartmetric: chartmetricConfigured() },
    spotify: latest(sp) ? { ...latest(sp), followers_delta: delta(sp, 'followers'), popularity_delta: delta(sp, 'popularity'), series: sp.map((r) => ({ day: r.day, followers: r.followers, popularity: r.popularity })) } : null,
    chartmetric: latest(cm) ? { ...latest(cm), listeners_delta: delta(cm, 'monthly_listeners'), series: cm.map((r) => ({ day: r.day, monthly_listeners: r.monthly_listeners })) } : null,
    days,
  };
}

module.exports = { refreshAll, refreshArtist, history, spotifyConfigured, chartmetricConfigured, DRY };
