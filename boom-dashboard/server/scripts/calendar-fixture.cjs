#!/usr/bin/env node
/**
 * The team calendar is one feed, typed, and gated by page permission.
 *
 *     cd server && PORT=3011 node index.js &
 *     node scripts/calendar-fixture.cjs
 *
 * Seeds an artist, a release, a contract, a task for John, a task for a
 * seeded User, and an approved unpaid invoice; reads GET /calendar as the
 * Superadmin (everything, everyone's tasks) and as a User holding only
 * /releases (no payments, no renewals, own tasks only). Deletes everything.
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const pool = require('./../db');

const BASE = 'http://localhost:3011';
const TAG = `CalFixture-${Date.now()}`;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : `— ${detail}`); };
const tokenFor = (u) => jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const get = async (path, token) => {
  const r = await fetch(BASE + '/api' + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

(async () => {
  const made = { users: [], artists: [], releases: [], contracts: [], tasks: [], expenses: [] };
  try {
    const { rows: [john] } = await pool.query(`SELECT id, email, name, role FROM users WHERE email = 'john@deanst.co'`);
    check('John exists', !!john);
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (name, email, role, password_hash) VALUES ($1, $2, 'User', 'x') RETURNING id, email, name, role`,
      [TAG, `${TAG.toLowerCase()}@example.test`]);
    made.users.push(u.id);
    await pool.query(`INSERT INTO user_page_permissions (user_id, page) VALUES ($1, '/releases') ON CONFLICT DO NOTHING`, [u.id]);

    const { rows: [a] } = await pool.query(`INSERT INTO artists (name) VALUES ($1) RETURNING id`, [`${TAG} Artist`]); made.artists.push(a.id);
    const { rows: [r] } = await pool.query(`INSERT INTO releases (artist_id, project_name, release_date) VALUES ($1, $2, CURRENT_DATE + 9) RETURNING id`, [a.id, `${TAG} Song`]); made.releases.push(r.id);
    const { rows: [c] } = await pool.query(`INSERT INTO contracts (artist_id, type, date_signed, expiration_date, status) VALUES ($1, 'Recording', CURRENT_DATE - 30, CURRENT_DATE + 60, 'Active') RETURNING id`, [a.id]); made.contracts.push(c.id);
    const { rows: [t1] } = await pool.query(`INSERT INTO tasks (user_id, description, due_date, status) VALUES ($1, $2, CURRENT_DATE + 3, 'To Do') RETURNING id`, [john.id, `${TAG} john task`]); made.tasks.push(t1.id);
    const { rows: [t2] } = await pool.query(`INSERT INTO tasks (user_id, description, due_date, status) VALUES ($1, $2, CURRENT_DATE + 4, 'To Do') RETURNING id`, [u.id, `${TAG} user task`]); made.tasks.push(t2.id);
    const { rows: [t3] } = await pool.query(`INSERT INTO tasks (user_id, description, due_date, status) VALUES ($1, $2, CURRENT_DATE + 1, 'Done') RETURNING id`, [john.id, `${TAG} done task`]); made.tasks.push(t3.id);
    const due = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const { rows: [e] } = await pool.query(
      `INSERT INTO expenses (payee, category, amount, currency, invoice_date, description, status, payment_status, scheduled_payment_date, rush_requested, artist, song)
       VALUES ($1, 'Marketing', 1500, 'USD', CURRENT_DATE, $1, 'approved', 'Unpaid', $2, true, $3, $4) RETURNING id`,
      [`${TAG} Vendor`, due, `${TAG} Artist`, `${TAG} Song`]); made.expenses.push(e.id);
    const { rows: [paid] } = await pool.query(
      `INSERT INTO expenses (payee, category, amount, currency, invoice_date, description, status, payment_status, scheduled_payment_date)
       VALUES ($1, 'Marketing', 900, 'USD', CURRENT_DATE, $1, 'approved', 'Paid', $2) RETURNING id`, [`${TAG} PaidVendor`, due]); made.expenses.push(paid.id);

    // ── Superadmin: everything ──
    const full = await get('/calendar', tokenFor(john));
    check('GET /calendar 200 for the Superadmin', full.status === 200, full.status);
    const ev = full.body?.events || [];
    const find = (pred) => ev.find(pred);
    const rel = find((x) => x.id === `release-${r.id}`);
    check('the release is on its date, linking to /releases', rel && rel.type === 'release' && rel.to === '/releases' && /^\d{4}-\d{2}-\d{2}$/.test(rel.date), JSON.stringify(rel));
    const exp = find((x) => x.id === `contract-exp-${c.id}`);
    check('the contract expiry is a renewal, linking to /renewals', exp && exp.type === 'contract_expiry' && exp.to === '/renewals' && /expires/.test(exp.title));
    const sig = find((x) => x.id === `contract-sign-${c.id}`);
    check('the signing date links to /contracts', sig && sig.type === 'contract_signed' && sig.to === '/contracts');
    const mine = find((x) => x.id === `task-${t1.id}`);
    check("John's own task links to /my-work with no assignee line", mine && mine.to === '/my-work' && mine.subtitle === null);
    const theirs = find((x) => x.id === `task-${t2.id}`);
    check("the User's task is on the TEAM calendar for the Superadmin, linking to their member page", theirs && theirs.to === `/team/${u.id}` && /Assigned to/.test(theirs.subtitle || ''));
    check('a Done task is not a date', !find((x) => x.id === `task-${t3.id}`));
    const pay = find((x) => x.id === `payment-${e.id}`);
    check('the approved unpaid invoice is a payment due on its scheduled date, linking to /bk/payments', pay && pay.type === 'payment_due' && pay.to === '/bk/payments' && pay.date === due, JSON.stringify(pay));
    check('titled by payee and amount, marked Rush, subtitled by artist · song', pay && /Vendor — \$1,500 due/.test(pay.title) && pay.meta === 'Rush' && /Artist · .*Song/.test(pay.subtitle));
    check('a PAID invoice is not a due date', !find((x) => x.id === `payment-${paid.id}`));
    check('sources: every feed (deals included), tasks = team', JSON.stringify(full.body?.sources) === JSON.stringify({ releases: true, contracts: true, renewals: true, payments: true, deals: true, tasks: 'team' }), JSON.stringify(full.body?.sources));

    // ── User with /releases only ──
    const narrow = await get('/calendar', tokenFor(u));
    check('GET /calendar 200 for the User', narrow.status === 200, narrow.status);
    const nev = narrow.body?.events || [];
    check('the release is there', nev.some((x) => x.id === `release-${r.id}`));
    check('NO payment due — /bk/payments is not theirs', !nev.some((x) => x.type === 'payment_due'));
    check('NO renewal and NO signing — /renewals and /contracts are not theirs', !nev.some((x) => x.type.startsWith('contract')));
    check('their own task, not John\'s', nev.some((x) => x.id === `task-${t2.id}`) && !nev.some((x) => x.id === `task-${t1.id}`));
    check('sources say so: payments false, renewals false, contracts false, tasks own',
      JSON.stringify(narrow.body?.sources) === JSON.stringify({ releases: true, contracts: false, renewals: false, payments: false, deals: false, tasks: 'own' }), JSON.stringify(narrow.body?.sources));
  } catch (err) {
    console.error('FIXTURE ERROR', err); results.push({ name: 'no exception', ok: false });
  } finally {
    await pool.query(`DELETE FROM expenses WHERE id = ANY($1)`, [made.expenses]).catch(() => {});
    await pool.query(`DELETE FROM tasks WHERE id = ANY($1)`, [made.tasks]).catch(() => {});
    await pool.query(`DELETE FROM contracts WHERE id = ANY($1)`, [made.contracts]).catch(() => {});
    await pool.query(`DELETE FROM releases WHERE id = ANY($1)`, [made.releases]).catch(() => {});
    await pool.query(`DELETE FROM artists WHERE id = ANY($1)`, [made.artists]).catch(() => {});
    await pool.query(`DELETE FROM user_page_permissions WHERE user_id = ANY($1)`, [made.users]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [made.users]).catch(() => {});
    await pool.end();
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed`);
    process.exit(passed === results.length ? 0 : 1);
  }
})();
