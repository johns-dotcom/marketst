#!/usr/bin/env node
/**
 * Connected mailboxes. Server on :3011 booted with MAIL_DRY_RUN=1 so nothing
 * reaches Gmail; every send still resolves a mailbox and writes mail_log.
 *
 *     cd server && MAIL_DRY_RUN=1 PORT=3011 node index.js &
 *     node scripts/mail-fixture.cjs
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const pool = require('./../db');
const paymentCrypto = require('../lib/payment-crypto');
const mail = require('../lib/mail');
const BASE = 'http://localhost:3011/api';
const TAG = `MailFx${Date.now()}`;
const results = [];
const check = (n, ok, d) => { results.push({ n, ok }); console.log(ok ? 'PASS' : 'FAIL', n, d === undefined ? '' : `— ${d}`); };
const api = async (method, path, token, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
(async () => {
  const made = { users: [], mailboxes: [] };
  let savedPurposes = null;
  try {
    savedPurposes = (await pool.query('SELECT purpose, mailbox_id FROM mailbox_purposes')).rows;
    const login = await api('POST', '/auth/login', null, { email: 'john@deanst.co', password: process.env.PW_JOHN });
    const T = login.body?.data?.token; check('login', !!T);
    const { rows: [u] } = await pool.query(`INSERT INTO users (name, email, role, password_hash, notification_prefs) VALUES ($1, $2, 'User', 'x', '{"tasks_assigned": true, "approvals_waiting": true}') RETURNING id, email, name, role`, [`${TAG} User`, `${TAG.toLowerCase()}@example.test`]); made.users.push(u.id);
    const U = jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

    // a shared mailbox as the callback would store it
    const { rows: [mb] } = await pool.query(`INSERT INTO mailboxes (address, display_name, kind, refresh_token_enc, source, status, connected_by) VALUES ($1, 'Market Street AP', 'shared', $2, 'oauth', 'active', $3) RETURNING id`,
      [`${TAG.toLowerCase()}-ap@marketst.test`, paymentCrypto.isConfigured() ? paymentCrypto.encrypt('fake-refresh-token') : null, (await pool.query(`SELECT id FROM users WHERE email='john@deanst.co'`)).rows[0].id]); made.mailboxes.push(mb.id);
    const put = await api('PUT', '/mail/purposes', T, { payments: mb.id, team: mb.id });
    check('an admin assigns purposes to a shared mailbox', put.status === 200 && put.body.data.find((p) => p.key === 'payments').mailbox.id === mb.id && put.body.data.find((p) => p.key === 'team').connected === true, JSON.stringify(put.body).slice(0, 160));
    check('a User cannot assign purposes', (await api('PUT', '/mail/purposes', U, { payments: mb.id })).status === 403);
    const st = await api('GET', '/mail/status', U);
    check('GET /mail/status is readable by anyone and names the five purposes', st.status === 200 && st.body.data.length === 5 && st.body.data.find((p) => p.key === 'payments').connected === true);
    check('a User cannot connect a SHARED mailbox', (await api('GET', '/mail/connect?kind=shared', U)).status === 403);
    const conn = await api('GET', '/mail/connect?kind=personal', U);
    check('a User asking to connect their own gets a Google URL (or a 503 naming the missing client)', (conn.status === 200 && /accounts\.google\.com/.test(conn.body.data.url) && /state=/.test(conn.body.data.url)) || (conn.status === 503 && /GMAIL_CLIENT_ID/.test(conn.body.error)), conn.status);
    const badState = await fetch(`${BASE}/mail/oauth/callback?code=x&state=garbage`, { redirect: 'manual' });
    check('the callback with a bad state redirects to Settings, never stores anything', badState.status === 302 && /mail=badstate/.test(badState.headers.get('location') || ''));

    // sending: dry run resolves the mailbox and logs
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM mail_log WHERE mailbox_id = $1', [mb.id])).rows[0].n;
    const test = await api('POST', `/mail/mailboxes/${mb.id}/test`, T);
    check('a test send resolves the mailbox (dry run)', test.status === 200 && test.body.data.dry_run === true && test.body.data.mailbox === `${TAG.toLowerCase()}-ap@marketst.test`, JSON.stringify(test.body));
    const { rows: logs } = await pool.query('SELECT * FROM mail_log WHERE mailbox_id = $1 ORDER BY id DESC', [mb.id]);
    check('…and writes a mail_log row with purpose, kind, recipient and the sender', logs.length === before + 1 && logs[0].status === 'dry_run' && logs[0].kind === 'test' && logs[0].to_addr === 'john@deanst.co' && !!logs[0].sent_by);
    check("a User cannot test a shared mailbox that is not theirs", (await api('POST', `/mail/mailboxes/${mb.id}/test`, U)).status === 403);
    // sendMail by purpose, and the not-connected sentence
    const r1 = await mail.sendMail({ purpose: 'payments', kind: 'payment_confirmation', to: 'vendor@example.test', subject: 'x', html: '<p>x</p>' });
    check('sendMail routes by purpose', r1.dry_run === true && r1.mailbox === `${TAG.toLowerCase()}-ap@marketst.test`);
    let err = null; try { await mail.sendMail({ purpose: 'clients', to: 'a@b.c', subject: 'x', html: 'x' }); } catch (e) { err = e; }
    check('an unassigned purpose throws a sentence pointing at Settings', err && err.code === 'MAIL_NOT_CONNECTED' && /Clients mail is not connected/.test(err.message), err && err.message);
    // invite send
    const created = await api('POST', '/settings/users', T, { name: `${TAG} Invitee`, email: `${TAG.toLowerCase()}-inv@example.test`, role: 'User', department: 'Marketing' });
    const iid = created.body?.data?.id; if (iid) made.users.push(iid);
    const sent = await api('POST', `/settings/users/${iid}/invite?send=1`, T);
    check('an invite can be emailed through the Team purpose', sent.status === 200 && sent.body.data.emailed === true && /^\/invite\//.test(sent.body.data.path));
    const { rows: [inv] } = await pool.query(`SELECT * FROM mail_log WHERE kind = 'invite' AND to_addr = $1 ORDER BY id DESC LIMIT 1`, [`${TAG.toLowerCase()}-inv@example.test`]);
    check('…logged as kind invite against the user', inv && inv.entity_type === 'user' && String(inv.entity_id) === String(iid));
    // notifications delivery reads the Team purpose
    const prefs = await api('GET', '/settings/me/notifications', U);
    check('notification prefs report delivery on now that Team mail is connected', prefs.body.delivery.gmail === true);
    // immediate task mail
    const task = await api('POST', '/team/tasks', T, { user_id: u.id, description: `${TAG} do the thing`, priority: 'High' });
    check('assigning a task to someone who opted in emails them right away (no preview to click)', task.status === 201 && task.body.pending_email === null, JSON.stringify(task.body).slice(0, 120));
    const { rows: [tl] } = await pool.query(`SELECT * FROM mail_log WHERE kind = 'task_assigned' AND to_addr = $1 ORDER BY id DESC LIMIT 1`, [u.email]);
    check('…and the log has it', !!tl && tl.status === 'dry_run');
    await pool.query('DELETE FROM tasks WHERE description LIKE $1', [`${TAG}%`]);
    // scheduler: claims a period once
    const { tick } = require('../lib/notifier');
    const nine = new Date(); nine.setUTCHours(16, 0, 0, 0); // 09:00 Los Angeles in PDT
    await pool.query(`DELETE FROM mail_jobs WHERE job = 'approvals_waiting'`);
    const t1 = await tick(nine); const t2 = await tick(nine);
    check('the hourly tick runs approvals_waiting once per day (second tick is a no-op)', 'approvals_waiting' in t1 && !('approvals_waiting' in t2), JSON.stringify([t1, t2]));
    const { rows: jobs } = await pool.query(`SELECT * FROM mail_jobs WHERE job = 'approvals_waiting'`);
    check('…recorded in mail_jobs', jobs.length === 1);
    // disconnect frees purposes
    const del = await api('DELETE', `/mail/mailboxes/${mb.id}`, T);
    check('disconnecting a shared mailbox leaves its purposes unassigned (and says which)', del.status === 200 && del.body.data.unassigned.sort().join() === 'payments,team', JSON.stringify(del.body));
    made.mailboxes = [];
    const st2 = await api('GET', '/mail/status', T);
    check('status now shows payments not connected', st2.body.data.find((p) => p.key === 'payments').connected === false);
  } catch (err) { console.error('FIXTURE ERROR', err); results.push({ n: 'no exception', ok: false }); }
  finally {
    await pool.query(`DELETE FROM mail_log WHERE to_addr LIKE $1 OR to_addr = 'vendor@example.test' OR kind = 'test' AND to_addr = 'john@deanst.co'`, [`%${TAG.toLowerCase()}%`]).catch(() => {});
    await pool.query(`DELETE FROM mail_jobs WHERE job = 'approvals_waiting'`).catch(() => {});
    await pool.query('DELETE FROM mailboxes WHERE id = ANY($1)', [made.mailboxes]).catch(() => {});
    if (savedPurposes) { await pool.query('DELETE FROM mailbox_purposes').catch(() => {}); for (const p of savedPurposes) await pool.query('INSERT INTO mailbox_purposes (purpose, mailbox_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [p.purpose, p.mailbox_id]).catch(() => {}); }
    await pool.query('DELETE FROM user_invites WHERE user_id = ANY($1)', [made.users]).catch(() => {});
    await pool.query('DELETE FROM user_page_permissions WHERE user_id = ANY($1)', [made.users]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]).catch(() => {});
    await pool.end();
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed`);
    process.exit(passed === results.length ? 0 : 1);
  }
})();
