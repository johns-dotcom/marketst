#!/usr/bin/env node
/**
 * Settings, two halves: my profile / sign-ins / notification prefs, and the
 * People endpoint with access rows and sign-out-everywhere. Server on :3011.
 *
 *     cd server && PORT=3011 node index.js &
 *     node scripts/settings-fixture.cjs
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const pool = require('./../db');
const BASE = 'http://localhost:3011/api';
const TAG = `SetFx${Date.now()}`;
const results = [];
const check = (n, ok, d) => { results.push({ n, ok }); console.log(ok ? 'PASS' : 'FAIL', n, d === undefined ? '' : `— ${d}`); };
const api = async (method, path, token, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
(async () => {
  const made = { users: [] };
  let originalTitle = null;
  try {
    const login = await api('POST', '/auth/login', null, { email: 'john@deanst.co', password: process.env.PW_JOHN });
    const T = login.body?.data?.token; check('login', !!T);

    // ── my settings ──
    await pool.query(`UPDATE users SET notification_prefs = NULL WHERE email = 'john@deanst.co'`);
    const me = await api('GET', '/settings/me', T);
    check('GET /settings/me returns the profile with title and phone fields', me.status === 200 && 'title' in me.body.data && 'phone' in me.body.data);
    originalTitle = me.body.data.title;
    const put = await api('PUT', '/settings/me', T, { title: `${TAG} title`, phone: '+1 555 0100' });
    check('PUT /settings/me saves title and phone', put.status === 200 && put.body.data.title === `${TAG} title` && put.body.data.phone === '+1 555 0100');
    const blank = await api('PUT', '/settings/me', T, { name: '' });
    check('an empty name is refused', blank.status === 400);
    const sess = await api('GET', '/settings/me/sessions', T);
    check('GET /settings/me/sessions lists sign-ins (this login included)', sess.status === 200 && Array.isArray(sess.body.data) && sess.body.data.length >= 1 && 'logged_in_at' in sess.body.data[0]);
    const prefs0 = await api('GET', '/settings/me/notifications', T);
    check('notification prefs default to all false and report delivery', prefs0.status === 200 && Object.values(prefs0.body.data).every((v) => v === false) && 'gmail' in prefs0.body.delivery);
    const prefs1 = await api('PUT', '/settings/me/notifications', T, { payments_due: true, bogus: true });
    check('PUT saves known keys only', prefs1.body.data.payments_due === true && !('bogus' in prefs1.body.data));
    const prefs2 = await api('GET', '/settings/me/notifications', T);
    check('…and reads them back', prefs2.body.data.payments_due === true && prefs2.body.data.tasks_assigned === false);

    // ── people ──
    const created = await api('POST', '/settings/users', T, { name: `${TAG} Person`, email: `${TAG.toLowerCase()}@example.test`, role: 'User', department: 'Finance', pages: ['/bk/approvals', '/bk/payments'] });
    const uid = created.body?.data?.id; if (uid) made.users.push(uid);
    check('a User is created with starting pages', created.status === 201 && created.body.data.pages_granted === 2);
    const people = await api('GET', '/settings/people', T);
    const row = (people.body?.data || []).find((p) => p.id === uid);
    const john = (people.body?.data || []).find((p) => p.email === 'john@deanst.co');
    check('GET /settings/people lists everyone with rows, last sign-in and open tasks', people.status === 200 && row && Array.isArray(row.pages) && row.pages.length === 2 && 'last_sign_in' in row && typeof row.open_tasks === 'number', JSON.stringify(row).slice(0, 160));
    check('John has no rows (Superadmin) and a last sign-in', john && john.pages === null && !!john.last_sign_in);
    check('a person created by an admin has no password yet, so People flags the invite as pending', row && row.invite_pending === true);
    const { rows: [u] } = await pool.query('SELECT id, email, name, role, token_version FROM users WHERE id = $1', [uid]);
    const theirs = jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, tv: u.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    check('their token works before', (await api('GET', '/auth/me', theirs)).status === 200);
    const out = await api('POST', `/settings/users/${uid}/logout-all`, T);
    check('POST /settings/users/:id/logout-all succeeds', out.status === 200);
    check('…and their old token is now stale', (await api('GET', '/auth/me', theirs)).status === 401);
    const tmpl = await api('GET', '/settings/permission-templates', T);
    check('the permission-templates routes are gone', tmpl.status === 404);
    const asUser = await api('GET', '/settings/people', jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, tv: (u.token_version || 0) + 1 }, process.env.JWT_SECRET, { expiresIn: '1h' }));
    check('a User cannot read /settings/people', asUser.status === 403);
  } catch (err) {
    console.error('FIXTURE ERROR', err); results.push({ n: 'no exception', ok: false });
  } finally {

    await pool.query(`UPDATE users SET title = $1, phone = NULL, notification_prefs = NULL WHERE email = 'john@deanst.co'`, [originalTitle]).catch(() => {});
    await pool.query('DELETE FROM user_invites WHERE user_id = ANY($1)', [made.users]).catch(() => {});
    await pool.query(`DELETE FROM user_page_permissions WHERE user_id = ANY($1)`, [made.users]).catch(() => {});
    await pool.query(`DELETE FROM user_login_logs WHERE user_id = ANY($1)`, [made.users]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [made.users]).catch(() => {});
    await pool.end();
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed`);
    process.exit(passed === results.length ? 0 : 1);
  }
})();
