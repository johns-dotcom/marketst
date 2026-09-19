#!/usr/bin/env node
/**
 * A budget typed by hand, for an artist with no ledger rows, must be listed
 * under the ROSTER'S spelling — on the index card and on the sheet header.
 *
 * Both used to fall back to the artist KEY ("rosavale") when no expense row
 * supplied a spelling, which is exactly the state a budget started from the
 * "New budget" button is in. Roster lookup is the fallback now; a name on
 * neither the ledger nor the roster still reads as its key (the client carries
 * the typed spelling for that case).
 *
 *     cd server && PORT=3011 node index.js &
 *     node scripts/artist-budget-name-fixture.cjs
 *
 * Seeds one roster artist and one budget cell, deletes both, pass or fail.
 */
require('dotenv').config();
const pool = require('./../db');

const BASE = 'http://localhost:3011';
const EMAIL = 'john@deanst.co';
const PASSWORD = process.env.PW_JOHN;
const NAME = 'Fixture Rosa Vale';        // a spelling with a capital and spaces
const KEY = 'fixturerosavale';           // artistBucketKey(NAME)
const OFF = 'Fixture Nobody Knows';      // on neither roster nor ledger
const OFF_KEY = 'fixturenobodyknows';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : `— ${detail}`);
};
const api = async (method, path, token, body) => {
  const r = await fetch(BASE + '/api' + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

(async () => {
  const made = { artists: [] };
  try {
    const login = await api('POST', '/auth/login', null, { email: EMAIL, password: PASSWORD });
    const token = login.body?.data?.token;
    check('login', !!token, login.status);

    const { rows: [a] } = await pool.query(`INSERT INTO artists (name) VALUES ($1) RETURNING id`, [NAME]);
    made.artists.push(a.id);

    // Before any budget: the sheet already names the artist from the roster.
    const sheet0 = await api('GET', `/artist-budgets/${KEY}`, token);
    check('an empty sheet is titled by the roster spelling, not the key', sheet0.body?.data?.artist === NAME, sheet0.body?.data?.artist);
    check('and offers every category as a row', (sheet0.body?.data?.sections || []).some((s) => (s.categories || []).length > 0));

    // Type a budget in one cell — the same call the grid makes.
    const put = await api('PUT', `/artist-budgets/${KEY}/category`, token, { category: 'Marketing', amount: 1500 });
    check('typing a budget saves', put.status === 200, put.status);

    const idx = await api('GET', '/artist-budgets', token);
    const card = (idx.body?.data?.artists || []).find((x) => x.artist_key === KEY);
    check('the index lists the artist, with no ledger spend', !!card && card.spent === 0);
    check('the card carries the roster spelling', card && card.artist === NAME, card && card.artist);
    check('the card carries the budget', card && card.budget === 1500 && card.has_budget === true, card && card.budget);

    const sheet1 = await api('GET', `/artist-budgets/${KEY}`, token);
    check('the sheet still carries the roster spelling once a budget exists', sheet1.body?.data?.artist === NAME);
    check('the sheet carries the roster id, so its breadcrumb can link to the profile', sheet1.body?.data?.artist_id === a.id, sheet1.body?.data?.artist_id);
    const simple = await api('GET', `/artist-budgets/${KEY}/simple`, token);
    check('the simple sheet carries the roster id too', simple.body?.data?.artist_id === a.id);

    // GET /artists/resolve — a NAME to the roster row, folded like every money surface folds
    const res1 = await api('GET', `/artists/resolve?name=${encodeURIComponent('  fixture ROSA vale ')}`, token);
    check('/artists/resolve folds spelling and whitespace to the roster row', res1.status === 200 && res1.body?.data?.id === a.id && res1.body?.data?.name === NAME, JSON.stringify(res1.body));
    const res2 = await api('GET', `/artists/resolve?name=${encodeURIComponent('Nobody Called This')}`, token);
    check('an unknown name is a 404, not a guess', res2.status === 404);
    const res3 = await api('GET', `/artists/resolve?name=N%2FA`, token);
    check('a placeholder is refused (400)', res3.status === 400);

    // An off-roster name with no rows: the server has nothing to name it by.
    const off = await api('GET', `/artist-budgets/${OFF_KEY}`, token);
    check('an artist on neither roster nor ledger is titled by its key (the client fills the typed spelling)', off.body?.data?.artist === OFF_KEY, off.body?.data?.artist);
  } catch (err) {
    console.error('FIXTURE ERROR', err);
    results.push({ name: 'no exception', ok: false });
  } finally {
    await pool.query(`DELETE FROM artist_budget_categories WHERE artist_key IN ($1, $2)`, [KEY, OFF_KEY]).catch(() => {});
    await pool.query(`DELETE FROM artists WHERE id = ANY($1)`, [made.artists]).catch(() => {});
    await pool.end();
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed`);
    process.exit(passed === results.length ? 0 : 1);
  }
})();
