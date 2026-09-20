#!/usr/bin/env node
// The artist stats feed with both sources in dry run.
//   cd server && ARTIST_STATS_DRY_RUN=1 PORT=3011 node index.js &
//   node scripts/artist-stats-fixture.cjs
require('dotenv').config();
const pool = require('../db');
const BASE = 'http://localhost:3011/api';
const TAG = `StFx${Date.now()}`;
const results = [];
const check = (n, ok, d) => { results.push({ n, ok }); console.log(ok ? 'PASS' : 'FAIL', n, d === undefined ? '' : `— ${d}`); };
const api = async (method, path, token, body) => { const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const made = { artists: [] };
(async () => {
  try {
    const login = await api('POST', '/auth/login', null, { email: 'john@deanst.co', password: process.env.PW_JOHN });
    const T = login.body?.data?.token; if (!T) throw new Error('login failed');
    const a = (await pool.query(`INSERT INTO artists (name, genre, spotify_url) VALUES ($1, 'Test', 'https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb') RETURNING id`, [`${TAG} Artist`])).rows[0]; made.artists.push(a.id);
    let h = await api('GET', `/artists/${a.id}/stats`, T);
    check('stats: empty history before any refresh, sources reported', h.status === 200 && h.body.data.spotify === null && h.body.data.sources.spotify === true);
    const r = await api('POST', `/artists/${a.id}/stats/refresh`, T);
    check('refresh one artist: writes today’s Spotify and Chartmetric rows', r.status === 200 && r.body.data.spotify?.followers > 0 && r.body.data.chartmetric?.monthly_listeners > 0, JSON.stringify(r.body.data.spotify));
    const row = (await pool.query('SELECT spotify_id, chartmetric_id FROM artists WHERE id = $1', [a.id])).rows[0];
    check('…the Spotify id is taken from spotify_url and stored, Chartmetric id resolved and stored', row.spotify_id === '4Z8W4fKeB5YxbusRsdQVPb' && !!row.chartmetric_id, JSON.stringify(row));
    const again = await api('POST', `/artists/${a.id}/stats/refresh`, T);
    const n = (await pool.query(`SELECT COUNT(*)::int AS n FROM artist_stats WHERE artist_id = $1`, [a.id])).rows[0].n;
    check('refreshing twice the same day upserts (one row per source per day)', again.status === 200 && n === 2);
    // backdated rows → deltas + series
    await pool.query(`INSERT INTO artist_stats (artist_id, source, day, followers, popularity) VALUES ($1, 'spotify', CURRENT_DATE - 7, 900, 40)`, [a.id]);
    await pool.query(`INSERT INTO artist_stats (artist_id, source, day, monthly_listeners) VALUES ($1, 'chartmetric', CURRENT_DATE - 7, 40000)`, [a.id]);
    h = await api('GET', `/artists/${a.id}/stats`, T);
    check('history: latest, deltas over the window and a series for each source', h.body.data.spotify.series.length === 2 && h.body.data.spotify.followers_delta === h.body.data.spotify.followers - 900 && h.body.data.chartmetric.listeners_delta === h.body.data.chartmetric.monthly_listeners - 40000);
    const list = await api('GET', `/artists?search=${encodeURIComponent(TAG)}`, T);
    const me = (list.body?.data || list.body?.artists || []).find?.((x) => x.id === a.id) || (Array.isArray(list.body?.data?.artists) ? list.body.data.artists.find((x) => x.id === a.id) : null);
    check('roster list carries spotify_followers and monthly_listeners for the card', !!me && me.spotify_followers > 0 && me.monthly_listeners > 0, me ? JSON.stringify({ f: me.spotify_followers, m: me.monthly_listeners }) : JSON.stringify(list.body).slice(0, 200));
    const all = await api('POST', '/artists/stats/refresh', T);
    check('refresh all (admin): reports counts', all.status === 200 && all.body.data.artists >= 1 && all.body.data.spotify >= 1, JSON.stringify(all.body.data).slice(0, 160));
    const w = await require('../lib/integrations-worker').tick(new Date());
    check('the integrations ticker runs without a connected QuickBooks or DocuSign', w && typeof w === 'object');
  } catch (e) { console.error('FIXTURE THREW', e); results.push({ n: 'threw', ok: false }); }
  finally {
    await pool.query('DELETE FROM artist_stats WHERE artist_id = ANY($1::int[])', [made.artists]).catch(() => {});
    await pool.query('DELETE FROM artists WHERE id = ANY($1::int[])', [made.artists]).catch(() => {});
    await pool.query(`DELETE FROM integration_jobs WHERE job = 'artist_stats' AND period = to_char((NOW() AT TIME ZONE 'America/Los_Angeles')::date, 'YYYY-MM-DD')`).catch(() => {});
    await pool.end();
    const passed = results.filter((r) => r.ok).length;
    console.log(`${passed}/${results.length} passed`); process.exit(passed === results.length ? 0 : 1);
  }
})();
