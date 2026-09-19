#!/usr/bin/env node
/**
 * GET /api/artist-budgets/:key/simple — the two-total sheet, against the real
 * database.
 *
 * What is at risk is the PARTITION: every ledger dollar on the artist lands in
 * exactly one of Advance / Total marketing / Other, a marketing row lands under
 * its release or under "not tied to a release", paid is Spent and unpaid is
 * Open, and the totals add up. And the index must treat the two typed totals as
 * THE budget, not add a detail-grid category budget on top.
 *
 *     cd server && PORT=3011 node index.js &
 *     node scripts/artist-budget-simple-fixture.cjs
 *
 * Seeds its own artist, release and rows (tagged __simple-fixture__); deletes
 * them, pass or fail.
 */
require('dotenv').config();
const pool = require('./../db');

const BASE = 'http://localhost:3011';
const EMAIL = 'john@deanst.co';
const PASSWORD = process.env.PW_JOHN;
const TAG = '__simple-fixture__';
const NAME = 'Simple Fixture Artist';
const KEY = 'simplefixtureartist';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : `— ${detail}`);
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;
const api = async (method, path, token, body) => {
  const r = await fetch(BASE + '/api' + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

(async () => {
  const made = { artists: [], releases: [], expenses: [] };
  try {
    const login = await api('POST', '/auth/login', null, { email: EMAIL, password: PASSWORD });
    const token = login.body?.data?.token;
    check('login', !!token, login.status);

    const { rows: [a] } = await pool.query(`INSERT INTO artists (name) VALUES ($1) RETURNING id`, [NAME]);
    made.artists.push(a.id);
    const { rows: [rel] } = await pool.query(
      `INSERT INTO releases (artist_id, project_name, release_date) VALUES ($1, $2, CURRENT_DATE + 20) RETURNING id`, [a.id, `${TAG} Night Drive`]);
    made.releases.push(rel.id);
    const { rows: [rel2] } = await pool.query(
      `INSERT INTO releases (artist_id, project_name, release_date) VALUES ($1, $2, CURRENT_DATE - 200) RETURNING id`, [a.id, `${TAG} Older One`]);
    made.releases.push(rel2.id);

    const mk = async (f) => {
      const cols = Object.keys(f);
      const { rows: [e] } = await pool.query(
        `INSERT INTO expenses (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, cols.map((c) => f[c]));
      made.expenses.push(e.id); return e.id;
    };
    const base = { payee: TAG, artist: NAME, currency: 'USD', invoice_date: '2026-09-01', status: 'approved', description: TAG };
    await mk({ ...base, category: 'Advance', amount: 400, payment_status: 'Paid', payment_date: '2026-09-02' });
    await mk({ ...base, category: 'Marketing', amount: 250, payment_status: 'Paid', payment_date: '2026-09-02', release_id: rel.id });
    await mk({ ...base, category: 'Advertisements', amount: 60, payment_status: 'Paid', payment_date: '2026-09-02', release_id: rel.id });
    await mk({ ...base, category: 'Marketing', amount: 100, payment_status: 'Unpaid' });                       // marketing, no release, unpaid
    await mk({ ...base, category: 'Tour/Live', amount: 50, payment_status: 'Paid', payment_date: '2026-09-02' }); // other
    await mk({ ...base, category: 'Marketing', amount: 999, payment_status: 'Paid', voided: true });           // voided: ignored

    // Type the totals and one release budget — the same calls the sheet makes.
    check('PUT /advance accepts the total', (await api('PUT', `/artist-budgets/${KEY}/advance`, token, { amount: 1000 })).status === 200);
    check('PUT /marketing accepts the total', (await api('PUT', `/artist-budgets/${KEY}/marketing`, token, { amount: 800 })).status === 200);
    check('PUT /release accepts a release budget', (await api('PUT', `/artist-budgets/${KEY}/release`, token, { release_id: rel.id, amount: 300 })).status === 200);
    check('an unknown section is still refused', (await api('PUT', `/artist-budgets/${KEY}/nonsense`, token, { amount: 1 })).status === 400);

    const r = await api('GET', `/artist-budgets/${KEY}/simple`, token);
    const d = r.body?.data;
    check('GET /simple answers', r.status === 200 && !!d, r.status);
    check('titled by the roster spelling', d.artist === NAME, d.artist);
    check('Advance: budget 1000, spent 400, left 600', near(d.advance.budget, 1000) && near(d.advance.spent, 400) && near(d.advance.left, 600), JSON.stringify(d.advance));
    check('Total marketing: budget 800, spent 310 (two categories), open 100, left 490',
      near(d.marketing.budget, 800) && near(d.marketing.spent, 310) && near(d.marketing.open, 100) && near(d.marketing.left, 490), JSON.stringify({ b: d.marketing.budget, s: d.marketing.spent, o: d.marketing.open, l: d.marketing.left }));
    check('allocated 300 of 800, 500 unallocated, not over', near(d.marketing.allocated, 300) && near(d.marketing.unallocated, 500) && d.marketing.over_allocated === false);
    const nd = d.marketing.releases.find((x) => x.release_id === rel.id);
    const old = d.marketing.releases.find((x) => x.release_id === rel2.id);
    check('both of the artist\'s releases are rows, newest first', d.marketing.releases.length === 2 && d.marketing.releases[0].release_id === rel.id, d.marketing.releases.map((x) => x.title).join(' | '));
    check('the release with spend: budget 300, spent 310, left −10', nd && near(nd.budget, 300) && near(nd.spent, 310) && near(nd.left, -10), JSON.stringify(nd));
    check('the release with nothing: zeros, still listed', old && near(old.budget, 0) && near(old.spent, 0));
    check('marketing not tied to a release: 100 open', near(d.marketing.unassigned.open, 100) && near(d.marketing.unassigned.spent, 0));
    check('Other spend: 50, naming Tour/Live', near(d.other.spent, 50) && d.other.categories.some((c) => c.category === 'Tour/Live'));
    check('the voided row counted nowhere', near(d.advance.spent + d.marketing.spent + d.other.spent, 760));
    check('Totals: budget 1800, spent 760, open 100, left 1040', near(d.totals.budget, 1800) && near(d.totals.spent, 760) && near(d.totals.open, 100) && near(d.totals.left, 1040), JSON.stringify(d.totals));

    // Over-allocation flips when releases exceed the total.
    await api('PUT', `/artist-budgets/${KEY}/release`, token, { release_id: rel2.id, amount: 600 });
    const d2 = (await api('GET', `/artist-budgets/${KEY}/simple`, token)).body.data;
    check('900 allocated against 800 → over_allocated', near(d2.marketing.allocated, 900) && d2.marketing.over_allocated === true);

    // The index treats the two totals as THE budget, even with a category budget on the detail grid.
    await api('PUT', `/artist-budgets/${KEY}/category`, token, { category: 'Marketing', amount: 12345 });
    const idx = await api('GET', '/artist-budgets', token);
    const card = (idx.body?.data?.artists || []).find((x) => x.artist_key === KEY);
    check('index card budget = advance + marketing (1800), not plus the category budget', card && near(card.budget, 1800), card && card.budget);
    check('index card carries the roster spelling and the spend', card && card.artist === NAME && near(card.spent, 760));

    // Clearing a total deletes its row.
    await api('PUT', `/artist-budgets/${KEY}/advance`, token, { amount: 0 });
    const { rows: adv } = await pool.query(`SELECT 1 FROM artist_budget_sections WHERE artist_key = $1 AND section = 'advance'`, [KEY]);
    check('a zero total deletes the row rather than storing 0', adv.length === 0);
  } catch (err) {
    console.error('FIXTURE ERROR', err);
    results.push({ name: 'no exception', ok: false });
  } finally {
    await pool.query(`DELETE FROM artist_budget_sections WHERE artist_key = $1`, [KEY]).catch(() => {});
    await pool.query(`DELETE FROM artist_budget_categories WHERE artist_key = $1`, [KEY]).catch(() => {});
    await pool.query(`DELETE FROM artist_budget_releases WHERE artist_key = $1`, [KEY]).catch(() => {});
    await pool.query(`DELETE FROM expenses WHERE id = ANY($1)`, [made.expenses]).catch(() => {});
    await pool.query(`DELETE FROM releases WHERE id = ANY($1)`, [made.releases]).catch(() => {});
    await pool.query(`DELETE FROM artists WHERE id = ANY($1)`, [made.artists]).catch(() => {});
    await pool.end();
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed`);
    process.exit(passed === results.length ? 0 : 1);
  }
})();
