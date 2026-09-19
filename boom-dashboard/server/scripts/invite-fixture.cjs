#!/usr/bin/env node
/** Invite links: fresh · short password · used · expired · resend · refusal until set. Server on :3011. */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const pool = require('./../db');
const { hashToken } = require('../lib/invites');
const BASE = 'http://localhost:3011/api';
const TAG = `InvFx${Date.now()}`;
const results = [];
const check = (n, ok, d) => { results.push({ n, ok }); console.log(ok ? 'PASS' : 'FAIL', n, d === undefined ? '' : `— ${d}`); };
const api = async (method, path, token, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
(async () => {
  const made = { users: [] };
  try {
    const login = await api('POST', '/auth/login', null, { email: 'john@deanst.co', password: process.env.PW_JOHN });
    const T = login.body?.data?.token; check('login', !!T);
    const email = `${TAG.toLowerCase()}@example.test`;
    const created = await api('POST', '/settings/users', T, { name: `${TAG} Person`, email, role: 'User', department: 'Marketing', pages: ['/releases'] });
    const uid = created.body?.data?.id; if (uid) made.users.push(uid);
    const inv = created.body?.invite;
    check('creating a person returns a one-time invite path', created.status === 201 && inv && /^\/invite\/[A-Za-z0-9_-]{20,}$/.test(inv.path) && inv.expires_at, JSON.stringify(inv));
    const token = inv.path.split('/invite/')[1];
    const { rows: [dbrow] } = await pool.query('SELECT token_hash, used_at FROM user_invites WHERE user_id = $1', [uid]);
    check('only the hash is stored', dbrow && dbrow.token_hash === hashToken(token) && dbrow.token_hash !== token);
    const { rows: [u0] } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [uid]);
    check('the account has no password yet', u0.password_hash === null);
    const people = await api('GET', '/settings/people', T);
    check('People shows the row as invite pending', (people.body.data || []).find((p) => p.id === uid)?.invite_pending === true);
    const refused = await api('POST', '/auth/login', null, { email, password: 'whatever123' });
    check('login is refused with a sentence about the invite', refused.status === 401 && /invite/i.test(refused.body?.error || ''), refused.body?.error);
    const who = await api('GET', `/auth/invite/${token}`);
    check('GET /auth/invite/:token says who it is for', who.status === 200 && who.body.data.email === email && who.body.data.name === `${TAG} Person`);
    check('a garbage token is 404', (await api('GET', '/auth/invite/nope')).status === 404);
    check('a short password is refused', (await api('POST', `/auth/invite/${token}`, null, { password: 'short' })).status === 400);
    const set = await api('POST', `/auth/invite/${token}`, null, { password: 'correct-horse-battery' });
    check('setting the password signs the person in', set.status === 200 && !!set.body.data?.token && set.body.data.user.email === email);
    check('…the JWT works', (await api('GET', '/auth/me', set.body.data.token)).status === 200);
    check('…the link is now used (410)', (await api('GET', `/auth/invite/${token}`)).status === 410);
    check('…and cannot set a password again', (await api('POST', `/auth/invite/${token}`, null, { password: 'another-long-one' })).status === 410);
    const ok = await api('POST', '/auth/login', null, { email, password: 'correct-horse-battery' });
    check('normal login now works', ok.status === 200 && !!ok.body.data?.token);
    check('People no longer shows invite pending', (await api('GET', '/settings/people', T)).body.data.find((p) => p.id === uid)?.invite_pending === false);
    // resend: a fresh token, the old (used) one untouched
    const re = await api('POST', `/settings/users/${uid}/invite`, T);
    check('an admin can issue a fresh link', re.status === 200 && re.body.data.path && re.body.data.path !== inv.path);
    const t2 = re.body.data.path.split('/invite/')[1];
    check('…which is valid', (await api('GET', `/auth/invite/${t2}`)).status === 200);
    await pool.query(`UPDATE user_invites SET expires_at = NOW() - INTERVAL '1 day' WHERE token_hash = $1`, [hashToken(t2)]);
    const exp = await api('GET', `/auth/invite/${t2}`);
    check('an expired link says so (410, reason expired)', exp.status === 410 && exp.body.reason === 'expired' && /expired/i.test(exp.body.error));
    const asUser = await api('POST', `/settings/users/${uid}/invite`, ok.body.data.token);
    check('a User cannot issue invites', asUser.status === 403);
  } catch (err) { console.error('FIXTURE ERROR', err); results.push({ n: 'no exception', ok: false }); }
  finally {
    await pool.query('DELETE FROM user_invites WHERE user_id = ANY($1)', [made.users]).catch(() => {});
    await pool.query('DELETE FROM user_page_permissions WHERE user_id = ANY($1)', [made.users]).catch(() => {});
    await pool.query('DELETE FROM user_login_logs WHERE user_id = ANY($1)', [made.users]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]).catch(() => {});
    await pool.end();
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed`);
    process.exit(passed === results.length ? 0 : 1);
  }
})();
