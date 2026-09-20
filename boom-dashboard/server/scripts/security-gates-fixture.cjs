#!/usr/bin/env node
/**
 * The doors the 2026-09-20 security pass shut, asserted in BOTH directions:
 * the caller who should get through still does, and the one who should not
 * gets a 403/401 — not a crash, not a silent success.
 *
 *     cd server && PORT=3011 MAIL_DRY_RUN=1 node index.js &
 *     node scripts/security-gates-fixture.cjs
 *
 * Creates its own users, expenses, tasks, events and invoices in the dev
 * database and deletes them at the end, pass or fail.
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const BASE = process.env.API_BASE || 'http://127.0.0.1:3011/api';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : `— ${detail}`); };
const tokenFor = (u, extra = {}) => jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, tv: u.token_version || 0, ...extra }, process.env.JWT_SECRET, { expiresIn: '1h' });
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, headers: r.headers };
};
const TAG = 'secgate';

(async () => {
  const made = { users: [], expenses: [], tasks: [], events: [], invoices: [] };
  try {
    const mkUser = async (name, role, rep) => {
      const { rows: [u] } = await pool.query(`INSERT INTO users (name, email, role, password_hash, boom_rep, token_version) VALUES ($1, $2, $3, 'x', $4, 0) RETURNING id, name, email, role, token_version`, [`${TAG} ${name}`, `${TAG}-${name.toLowerCase()}@example.test`, role, rep || null]);
      made.users.push(u.id);
      if (role === 'User') for (const p of ['/bk/ledger', '/flags', '/team', '/my-work', '/calendar', '/bk/invoices']) await pool.query('INSERT INTO user_page_permissions (user_id, page) VALUES ($1, $2) ON CONFLICT DO NOTHING', [u.id, p]).catch(() => {});
      return u;
    };
    const superadmin = await mkUser('Super', 'Superadmin');
    const admin = await mkUser('Admin', 'Admin');
    const userA = await mkUser('Alpha', 'User', 'Alpha Rep');
    const userB = await mkUser('Beta', 'User', 'Beta Rep');
    const [S, A, UA, UB] = [superadmin, admin, userA, userB].map((u) => tokenFor(u));

    // ── 1. Only a session token authenticates ──
    const noTv = jwt.sign({ id: superadmin.id, email: superadmin.email, role: 'Superadmin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    check('a JWT without tv (never revocable) is refused', (await call('GET', '/settings/me', noTv)).status === 401);
    const stateShaped = jwt.sign({ uid: superadmin.id, kind: 'shared', purpose: 'oauth' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    check('an OAuth state-shaped JWT (no id) is refused', (await call('GET', '/settings/me', stateShaped)).status === 401);
    check('a real session token still works', (await call('GET', '/settings/me', S)).status === 200);

    // ── 2. ?token= only on GET file routes ──
    const q = (p) => fetch(`${BASE}${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(S)}`).then((r) => r.status);
    check('?token= on a plain API GET is refused', (await q('/bk/entries')) === 401);
    check('?token= on a file route is accepted', (await q('/bk/entries/999999999/file/invoice')) !== 401);
    check('?token= on an export route is accepted', (await q('/bk/export?source=invoices')) !== 401);
    const postQ = await fetch(`${BASE}/bk/entries?token=${encodeURIComponent(S)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    check('?token= on a POST is refused even on a file-ish path', postQ.status === 401);

    // ── 3. Register tiering ──
    const regAdminByAdmin = await call('POST', '/auth/register', A, { name: `${TAG} X`, email: `${TAG}-x1@example.test`, password: 'Passw0rd!Passw0rd!', role: 'Admin' });
    check('an Admin cannot register an Admin', regAdminByAdmin.status === 403, regAdminByAdmin.status);
    const regBad = await call('POST', '/auth/register', S, { name: `${TAG} X`, email: `${TAG}-x2@example.test`, password: 'Passw0rd!Passw0rd!', role: 'Owner' });
    check('an unknown role is refused', regBad.status === 400, regBad.status);
    const regUser = await call('POST', '/auth/register', A, { name: `${TAG} Made`, email: `${TAG}-made@example.test`, password: 'Passw0rd!Passw0rd!', role: 'User' });
    if (regUser.body?.data?.id) made.users.push(regUser.body.data.id); else if (regUser.body?.data?.user?.id) made.users.push(regUser.body.data.user.id);
    check('an Admin still registers a User', regUser.status === 201, `${regUser.status} ${JSON.stringify(regUser.body).slice(0, 120)}`);

    // ── 4. Impersonation leaves a trail ──
    const { rows: [{ n: auditBefore }] } = await pool.query(`SELECT COUNT(*)::int AS n FROM security_audit_log WHERE event_type = 'impersonate'`);
    const imp = await call('POST', `/auth/impersonate/${userA.id}`, S);
    const impClaims = imp.body?.data?.token ? jwt.decode(imp.body.data.token) : null;
    check('impersonation mints a token that names the impersonator', imp.status === 200 && impClaims && impClaims.imp === superadmin.id && impClaims.id === userA.id, JSON.stringify(impClaims));
    const { rows: [{ n: auditAfter }] } = await pool.query(`SELECT COUNT(*)::int AS n FROM security_audit_log WHERE event_type = 'impersonate'`);
    check('…and writes one security_audit_log row', auditAfter === auditBefore + 1, `${auditBefore} → ${auditAfter}`);

    // ── 5. Per-row checks on ledger edits and documents ──
    const mkExp = async (rep) => { const { rows: [e] } = await pool.query(`INSERT INTO expenses (payee, amount, category, invoice_date, status, payment_status, boom_rep, created_by) VALUES ($1, 100, 'Marketing', CURRENT_DATE, 'approved', 'Unpaid', $2, 'fixture') RETURNING id`, [`${TAG} Vendor ${rep}`, rep]); made.expenses.push(e.id); return e.id; };
    const alphaRow = await mkExp('Alpha Rep');
    const betaRow = await mkExp('Beta Rep');
    const editOther = await call('PUT', `/bk/entries/${betaRow}`, UA, { notes: 'hijack' });
    check('a rep-scoped User cannot edit a row they cannot see', editOther.status === 403, editOther.status);
    const editOwn = await call('PUT', `/bk/entries/${alphaRow}`, UA, { notes: 'mine' });
    check('…and still edits their own', editOwn.status === 200, `${editOwn.status} ${JSON.stringify(editOwn.body).slice(0, 100)}`);
    check('a User cannot open a document on another rep\'s row', (await call('GET', `/bk/entries/${betaRow}/file/invoice`, UA)).status === 403);
    check('a User cannot open a W-9 even on their own row', (await call('GET', `/bk/entries/${alphaRow}/file/w9`, UA)).status === 403);
    const adminW9 = await call('GET', `/bk/entries/${alphaRow}/file/w9`, A);
    check('an Admin reaches the W-9 route (404: none uploaded, not 403)', adminW9.status === 404, adminW9.status);
    check('a User cannot list receipts on another rep\'s row', (await call('GET', `/bk/entries/${betaRow}/receipts`, UA)).status === 403);
    const srcPost = await call('POST', '/bk/entries', UA, { payee: `${TAG} Sneak`, amount: 5, category: 'Marketing', invoice_date: '2026-09-20', entry_source: 'signing', boom_rep: 'Alpha Rep' });
    if (srcPost.body?.data?.id) made.expenses.push(srcPost.body.data.id);
    if (srcPost.status === 201 || srcPost.status === 200) {
      const { rows: [r] } = await pool.query('SELECT status, entry_source FROM expenses WHERE id = $1', [srcPost.body.data.id]);
      check('a User posting entry_source does not get an auto-approved row', r.status !== 'approved' && r.entry_source !== 'signing', JSON.stringify(r));
    } else check('a User posting entry_source does not get an auto-approved row', true, `refused ${srcPost.status}`);

    // ── 6. Label bank block ──
    const labelUser = await call('GET', '/label', UA);
    const labelAdmin = await call('GET', '/label', A);
    check('a User reads the label without the bank block', labelUser.status === 200 && !('bank_routing_ach' in (labelUser.body?.data || {})) && !('bank_account_last4' in (labelUser.body?.data || {})), Object.keys(labelUser.body?.data || {}).join(','));
    check('…and still sees the identity lines', labelUser.status === 200 && 'display_name' in (labelUser.body?.data || {}));
    check('an Admin still reads the bank block', labelAdmin.status === 200 && 'bank_routing_ach' in (labelAdmin.body?.data || {}));

    // ── 7. Tasks, events, invoices, flags ──
    const { rows: [t] } = await pool.query(`INSERT INTO tasks (user_id, assigned_by, description) VALUES ($1, $1, $2) RETURNING id`, [userA.id, `${TAG} task`]); made.tasks.push(t.id);
    check('a User cannot edit someone else\'s task', (await call('PUT', `/team/tasks/${t.id}`, UB, { description: 'stolen' })).status === 403);
    check('…the assignee still can', (await call('PUT', `/team/tasks/${t.id}`, UA, { description: `${TAG} task edited` })).status === 200);
    check('…and so can an Admin', (await call('PUT', `/team/tasks/${t.id}`, A, { priority: 'High' })).status === 200);
    const { rows: [ev] } = await pool.query(`INSERT INTO calendar_events (title, event_date, created_by) VALUES ($1, CURRENT_DATE, $2) RETURNING id`, [`${TAG} event`, userA.id]); made.events.push(ev.id);
    check('a User cannot delete someone else\'s calendar event', (await call('DELETE', `/calendar/${ev.id}`, UB)).status === 403);
    check('…the creator can', (await call('DELETE', `/calendar/${ev.id}`, UA)).status === 200);
    const { rows: [inv] } = await pool.query(`INSERT INTO boom_invoices (invoice_number, bill_to, description, amount) VALUES ($1, $2, $3, 10) RETURNING id`, [900000 + Math.floor(Math.random() * 90000), `${TAG} client`, `${TAG} invoice`]); made.invoices.push(inv.id);
    check('a User cannot edit a label-issued invoice', (await call('PUT', `/invoices/${inv.id}`, UA, { description: 'x' })).status === 403);
    check('a User cannot delete one', (await call('DELETE', `/invoices/${inv.id}`, UA)).status === 403);
    check('a User cannot assign a flag to someone else', (await call('POST', '/flags/assign', UA, { kind: 'label_incomplete', key: '*', user_id: userB.id })).status === 403);
    const self = await call('POST', '/flags/assign', UA, { kind: 'label_incomplete', key: '*', user_id: userA.id });
    check('…but may take one themselves', self.status === 200, `${self.status} ${JSON.stringify(self.body).slice(0, 100)}`);
    if (self.body?.data?.task_id) made.tasks.push(self.body.data.task_id);
    check('a User cannot unassign someone else\'s flag', (await call('DELETE', `/flags/assign?kind=label_incomplete&key=*`, UB)).status === 403);
    check('…the assignee can', (await call('DELETE', `/flags/assign?kind=label_incomplete&key=*`, UA)).status === 200);
    const flagsUser = await call('GET', '/flags', UA);
    const kinds = (flagsUser.body?.data?.categories || flagsUser.body?.categories || []).map((c) => c.kind);
    check('a User\'s flag list carries no ledger-derived categories', flagsUser.status === 200 && !kinds.some((k) => /duplicate_|ledger_|artist_/.test(k)), kinds.join(','));

    // ── 8. Admin password reset ends the old sessions ──
    const { rows: [tvBefore] } = await pool.query('SELECT token_version FROM users WHERE id = $1', [userB.id]);
    const pw = await call('PUT', `/settings/users/${userB.id}`, S, { name: userB.name, email: userB.email, role: 'User', password: 'NewPassw0rd!NewPassw0rd!' });
    const { rows: [tvAfter] } = await pool.query('SELECT token_version FROM users WHERE id = $1', [userB.id]);
    check('an admin-set password bumps token_version', pw.status === 200 && Number(tvAfter.token_version) === Number(tvBefore.token_version || 0) + 1, `${pw.status} ${tvBefore.token_version} → ${tvAfter.token_version}`);
    check('…so the old token is dead', (await call('GET', '/settings/me', UB)).status === 401);

    // ── 9. Public vendor oracles ──
    await pool.query(`INSERT INTO vendor_payment_details (vendor_email, vendor_name, method, account_last4, holder_name) VALUES ($1, $2, 'ACH', '4321', 'Jane Q Vendor') ON CONFLICT (vendor_email) DO UPDATE SET holder_name = 'Jane Q Vendor', account_last4 = '4321'`, [`${TAG}-vendor@example.test`, `${TAG} Vendor`]);
    const onFile = await fetch(`${BASE}/vendor/payment-on-file?email=${TAG}-vendor@example.test`).then((r) => r.json());
    check('payment-on-file confirms method + last4 and no longer the account holder\'s name', onFile.on_file === true && onFile.last4 === '4321' && !('holder_name' in onFile), JSON.stringify(onFile));
    const sim = await fetch(`${BASE}/vendor/check-similar?vendor_name=${encodeURIComponent(`${TAG} Vendor Alpha Rep`)}&amount=100`).then((r) => r.json());
    check('check-similar answers nothing to a vendor name without the email', sim.similar === null, JSON.stringify(sim));
    const fd = new FormData(); fd.append('file', new Blob([Buffer.from('%PDF-1.4 x')], { type: 'application/pdf' }), 'payload');
    const noExt = await fetch(`${BASE}/vendor/validate-invoice`, { method: 'POST', body: fd });
    check('an upload with no file extension is refused, not buffered and read', noExt.status === 400, noExt.status);
  } catch (err) {
    check('fixture ran to completion', false, err.stack);
  } finally {
    await pool.query(`DELETE FROM vendor_payment_details WHERE vendor_email = $1`, [`${TAG}-vendor@example.test`]).catch(() => {});
    await pool.query(`DELETE FROM flag_assignments WHERE assigned_to = ANY($1::int[])`, [made.users]).catch(() => {});
    if (made.tasks.length) await pool.query('DELETE FROM tasks WHERE id = ANY($1::int[])', [made.tasks]).catch(() => {});
    await pool.query('DELETE FROM tasks WHERE user_id = ANY($1::int[]) OR assigned_by = ANY($1::int[])', [made.users]).catch(() => {});
    if (made.events.length) await pool.query('DELETE FROM calendar_events WHERE id = ANY($1::int[])', [made.events]).catch(() => {});
    if (made.invoices.length) await pool.query('DELETE FROM boom_invoices WHERE id = ANY($1::int[])', [made.invoices]).catch(() => {});
    if (made.expenses.length) { await pool.query('DELETE FROM bk_audit_log WHERE entry_id = ANY($1::int[])', [made.expenses]).catch(() => {}); await pool.query('DELETE FROM expenses WHERE id = ANY($1::int[])', [made.expenses]).catch(() => {}); }
    await pool.query(`DELETE FROM expenses WHERE payee LIKE '${TAG}%'`).catch(() => {});
    for (const t of ['user_page_permissions', 'user_visible_reps', 'activity_log', 'user_login_logs', 'security_audit_log']) await pool.query(`DELETE FROM ${t} WHERE user_id = ANY($1::int[])`, [made.users]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE email LIKE '${TAG}-%@example.test'`).catch((e) => console.log('users NOT removed:', e.message));
    await pool.end();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
