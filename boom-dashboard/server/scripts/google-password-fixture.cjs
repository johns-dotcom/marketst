#!/usr/bin/env node
/**
 * An invited person who signed in with Google has no password. They can set
 * their FIRST password without a current one (2026-09-22); changing an
 * existing one still needs it; the invite is spent by the first password (and
 * by a Google sign-in); People shows them as "Google, no password", not as
 * invite pending, once they have signed in.
 *
 *     cd server && PORT=3011 MAIL_DRY_RUN=1 node index.js &
 *     node scripts/google-password-fixture.cjs
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const BASE = process.env.API_BASE || 'http://127.0.0.1:3011/api';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : `— ${detail}`); };
const tokenFor = (u) => jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const call = async (m, p, t, b) => { const r = await fetch(BASE + p, { method: m, headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...(b ? { 'content-type': 'application/json' } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const TAG = 'gpwfx';

(async () => {
  const made = { users: [] };
  try {
    const { rows: [sup] } = await pool.query(`INSERT INTO users (name, email, role, password_hash, token_version) VALUES ($1,$2,'Superadmin','x',0) RETURNING id,name,email,role`, [`${TAG} Super`, `${TAG}-super@example.test`]); made.users.push(sup.id);
    const S = tokenFor(sup);
    // Invite a person; they never open the link — they sign in with Google instead.
    const created = await call('POST', '/settings/users', S, { name: `${TAG} Person`, email: `${TAG}-person@example.test`, role: 'User', department: 'Marketing', pages: ['/releases'] });
    const u = created.body?.data; if (u) made.users.push(u.id);
    check('the invited account has no password and an unused invite', created.status === 201 && (await pool.query('SELECT password_hash FROM users WHERE id = $1', [u.id])).rows[0].password_hash === null && (await pool.query('SELECT used_at FROM user_invites WHERE user_id = $1', [u.id])).rows[0]?.used_at === null);
    // A Google sign-in is what the route does after Google verifies the token: a login log + the invite spent. Emulate its writes.
    await pool.query('INSERT INTO user_login_logs (user_id, ip_address, user_agent) VALUES ($1, $2, $3)', [u.id, '10.0.0.9', 'fixture']);
    await pool.query('UPDATE user_invites SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [u.id]);
    const T = tokenFor({ ...u, role: 'User' });
    const me = await call('GET', '/auth/me', T);
    check('/auth/me and /settings/me say has_password false', me.body?.data?.has_password === false && (await call('GET', '/settings/me', T)).body?.data?.has_password === false);
    const people = await call('GET', '/settings/people', S);
    const row = (people.body?.data || []).find((p) => p.id === u.id);
    check('People shows them as Google-only, NOT invite pending, once they signed in', row && row.invite_pending === false && row.google_only === true, JSON.stringify({ pending: row?.invite_pending, google: row?.google_only }));
    check('a short first password is refused', (await call('POST', '/auth/change-password', T, { new_password: 'short' })).status === 400);
    const first = await call('POST', '/auth/change-password', T, { new_password: 'correct-horse-battery' });
    check('setting the FIRST password needs no current password and does not sign this session out', first.status === 200 && first.body.first_password === true && (await call('GET', '/auth/me', T)).status === 200, JSON.stringify(first.body));
    const { rows: [after] } = await pool.query('SELECT password_hash, token_version FROM users WHERE id = $1', [u.id]);
    check('…the hash is stored and matches', after.password_hash && await bcrypt.compare('correct-horse-battery', after.password_hash));
    check('…and they can now sign in with it', (await call('POST', '/auth/login', null, { email: u.email, password: 'correct-horse-battery' })).status === 200);
    check('has_password is true now; People no longer says Google-only', (await call('GET', '/settings/me', T)).body.data.has_password === true && (await call('GET', '/settings/people', S)).body.data.find((p) => p.id === u.id).google_only === false);
    check('changing an EXISTING password without the current one is refused', (await call('POST', '/auth/change-password', T, { new_password: 'another-long-password' })).status === 400);
    check('…and with a wrong current one', (await call('POST', '/auth/change-password', T, { current_password: 'nope-nope-nope', new_password: 'another-long-password' })).status === 401);
    const chg = await call('POST', '/auth/change-password', T, { current_password: 'correct-horse-battery', new_password: 'another-long-password' });
    check('…and works with the right one, signing other sessions out (token_version bumped)', chg.status === 200 && chg.body.first_password === false && Number((await pool.query('SELECT token_version FROM users WHERE id = $1', [u.id])).rows[0].token_version) === Number(after.token_version || 0) + 1);
    // A second invited person who sets the first password directly (no Google) — the invite is spent too.
    const c2 = await call('POST', '/settings/users', S, { name: `${TAG} Two`, email: `${TAG}-two@example.test`, role: 'User', department: 'Marketing', pages: ['/releases'] });
    const u2 = c2.body?.data; if (u2) made.users.push(u2.id);
    await call('POST', '/auth/change-password', tokenFor({ ...u2, role: 'User' }), { new_password: 'a-perfectly-fine-password' });
    check('the first password spends the invite link', (await pool.query('SELECT used_at FROM user_invites WHERE user_id = $1', [u2.id])).rows[0]?.used_at !== null);
  } catch (err) {
    check('fixture ran to completion', false, err.stack);
  } finally {
    for (const t of ['user_page_permissions', 'user_invites', 'activity_log', 'user_login_logs', 'security_audit_log']) await pool.query(`DELETE FROM ${t} WHERE user_id = ANY($1::int[])`, [made.users]).catch(() => {});
    await pool.query(`DELETE FROM user_invites WHERE created_by = ANY($1::int[])`, [made.users]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}-%@example.test`]).catch((e) => console.log('users NOT removed:', e.message));
    await pool.end();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
