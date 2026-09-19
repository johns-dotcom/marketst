#!/usr/bin/env node
/**
 * GET /api/dashboard/loop — the Home page's four tiles, against the real
 * database.
 *
 * What is at risk is the GATE and the PREDICATES. A section must be null for
 * somebody who could not open the page behind it (the client's canView is a
 * second gate, not the only one), and each count must move by exactly one when
 * exactly one qualifying row is added — not by two for a split family, not at
 * all for a voided invoice, not for a debit somebody already answered.
 *
 *     cd server && PORT=3011 node index.js &
 *     node scripts/home-loop-fixture.cjs
 *
 * Seeds its own rows (tagged __loop-fixture__) and deletes them at the end,
 * pass or fail. Compares DELTAS, so it runs against a database holding real
 * data as well as an empty one.
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const BASE = process.env.API_BASE || 'http://127.0.0.1:3011/api';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = '__loop-fixture__';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : `— ${detail}`);
};
const tokenFor = (u) => jwt.sign(
  { id: u.id, email: u.email, name: u.name, role: u.role, tv: u.token_version || 0 },
  process.env.JWT_SECRET, { expiresIn: '1h' });
const call = async (path, token) => {
  const r = await fetch(BASE + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const loop = async (token) => (await call('/dashboard/loop', token)).body?.data;

(async () => {
  const made = { users: [], expenses: [], statements: [], releases: [], artists: [] };
  try {
    const mkUser = async (name, role, pages) => {
      const { rows: [u] } = await pool.query(
        `INSERT INTO users (name, email, role, password_hash)
         VALUES ($1, $2, $3, 'x') RETURNING id, name, email, role`,
        [name, `${name.toLowerCase()}@loop-fixture.test`, role]);
      made.users.push(u.id);
      for (const p of pages || []) {
        await pool.query('INSERT INTO user_page_permissions (user_id, page) VALUES ($1, $2) ON CONFLICT DO NOTHING', [u.id, p]);
      }
      return u;
    };
    const admin = await mkUser('LoopAdmin', 'Superadmin');
    const anr = await mkUser('LoopAnr', 'User', ['/releases', '/catalog', '/artists']);
    const noRows = await mkUser('LoopNone', 'User', []);
    const T = tokenFor(admin);

    // ── 1. shape and gate ──
    const before = await loop(T);
    check('admin receives all four sections', before && ['approvals', 'payments', 'bank', 'releases'].every((k) => before[k] && typeof before[k] === 'object'),
      Object.keys(before || {}).join(', '));
    const anrLoop = await loop(tokenFor(anr));
    check('an A&R User gets releases and NOTHING money-shaped', anrLoop && anrLoop.releases && anrLoop.approvals === null && anrLoop.payments === null && anrLoop.bank === null);
    const noneLoop = await loop(tokenFor(noRows));
    check('a User with no rows gets every section null', noneLoop && Object.values(noneLoop).every((v) => v === null));

    // Recent activity on Home is the Activity page in miniature: gated on /activity.
    const actAs = async (token) => { const r = await fetch(BASE + '/dashboard/activity', { headers: { authorization: `Bearer ${token}` } }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const actAdmin = await actAs(T); const actAnr = await actAs(tokenFor(anr));
    check('the Superadmin gets the activity feed (an array)', actAdmin.status === 200 && Array.isArray(actAdmin.body?.data));
    check('a User without /activity gets an EMPTY feed, not a 403 and not the rows', actAnr.status === 200 && Array.isArray(actAnr.body?.data) && actAnr.body.data.length === 0, JSON.stringify(actAnr.body).slice(0, 120));
    const unauth = await fetch(BASE + '/dashboard/loop');
    check('no token → 401', unauth.status === 401, unauth.status);

    // ── 2. approvals: one pending root moves the count by one; a child and a voided row do not ──
    const mkExpense = async (fields) => {
      const cols = Object.keys(fields);
      const { rows: [e] } = await pool.query(
        `INSERT INTO expenses (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        cols.map((c) => fields[c]));
      made.expenses.push(e.id);
      return e.id;
    };
    const base = { payee: TAG, category: 'Marketing', amount: 100, currency: 'USD', invoice_date: '2026-09-01', description: TAG };
    const pendingId = await mkExpense({ ...base, status: 'pending', amount: 250, created_at: new Date(Date.now() - 3 * 86400000) });
    await mkExpense({ ...base, status: 'pending', amount: 999, parent_id: pendingId });          // child: hidden
    await mkExpense({ ...base, status: 'pending', amount: 500, voided: true });                    // voided: hidden
    const a1 = await loop(T);
    check('approvals.count moved by exactly 1 (root only; child and voided ignored)', a1.approvals.count === before.approvals.count + 1, `${before.approvals.count} → ${a1.approvals.count}`);
    check('approvals.usd moved by the root amount only', Math.abs((a1.approvals.usd - before.approvals.usd) - 250) < 0.01, `+${(a1.approvals.usd - before.approvals.usd).toFixed(2)}`);
    check('approvals.oldest_days is at least 3', a1.approvals.oldest_days >= 3, a1.approvals.oldest_days);

    // ── 3. payments: due tomorrow + rush counts; on hold and far-future do not ──
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const farOff = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await mkExpense({ ...base, status: 'approved', payment_status: 'Unpaid', scheduled_payment_date: tomorrow, rush_requested: true, amount: 300 });
    await mkExpense({ ...base, status: 'approved', payment_status: 'Unpaid', scheduled_payment_date: yesterday, amount: 40 });
    await mkExpense({ ...base, status: 'approved', payment_status: 'Unpaid', scheduled_payment_date: tomorrow, on_hold: true, amount: 1000 });
    await mkExpense({ ...base, status: 'approved', payment_status: 'Unpaid', scheduled_payment_date: farOff, amount: 1000 });
    await mkExpense({ ...base, status: 'approved', payment_status: 'Paid', scheduled_payment_date: tomorrow, amount: 1000 });
    const p1 = await loop(T);
    check('payments.count moved by 2 (due tomorrow + overdue); held, far-off and paid ignored', p1.payments.count === before.payments.count + 2, `${before.payments.count} → ${p1.payments.count}`);
    check('payments.usd moved by 340', Math.abs((p1.payments.usd - before.payments.usd) - 340) < 0.01, `+${(p1.payments.usd - before.payments.usd).toFixed(2)}`);
    check('payments.rush moved by 1', p1.payments.rush === before.payments.rush + 1);
    check('payments.overdue moved by 1', p1.payments.overdue === before.payments.overdue + 1);

    // ── 4. bank: one unanswered debit counts; a dismissed one and a credit do not; a stale account is overdue ──
    const { rows: [st] } = await pool.query(
      `INSERT INTO bank_statements (account, filename, period_start, period_end, status)
       VALUES ('loopfx', $1, CURRENT_DATE - 100, CURRENT_DATE - 70, 'ready') RETURNING id`, [TAG]);
    made.statements.push(st.id);
    await pool.query(`INSERT INTO bank_transactions (statement_id, txn_date, description, amount, direction, currency, dismissed)
                      VALUES ($1, CURRENT_DATE - 80, $2, 77.5, 'debit', 'USD', false),
                             ($1, CURRENT_DATE - 80, $2, 12, 'debit', 'USD', true),
                             ($1, CURRENT_DATE - 80, $2, 500, 'credit', 'USD', false)`, [st.id, TAG]);
    const b1 = await loop(T);
    check('bank.open moved by exactly 1 (dismissed debit and credit ignored)', b1.bank.open === before.bank.open + 1, `${before.bank.open} → ${b1.bank.open}`);
    check('bank.open_usd moved by 77.50', Math.abs((b1.bank.open_usd - before.bank.open_usd) - 77.5) < 0.01);
    const acct = b1.bank.accounts.find((a) => a.account === 'loopfx');
    check('the new account is listed with its last period end', !!acct && acct.statements === 1, JSON.stringify(acct));
    check('an account 70 days silent is overdue (one statement implies a month + 5 grace)', !!acct && acct.overdue === true && b1.bank.overdue_accounts.includes('loopfx'));
    check('bank tile points at the review queue when something is open', b1.bank.to === '/bk/bank-matching');

    // ── 5. releases: one in 10 days with an empty checklist; one archived and one in 60 days ignored ──
    const { rows: [ar] } = await pool.query(`INSERT INTO artists (name) VALUES ($1) RETURNING id`, [TAG]);
    made.artists.push(ar.id);
    const mkRelease = async (days, extra = {}) => {
      const cols = ['artist_id', 'project_name', 'release_date', ...Object.keys(extra)];
      const vals = [ar.id, `${TAG} ${days}`, new Date(Date.now() + days * 86400000).toISOString().slice(0, 10), ...Object.values(extra)];
      const { rows: [r] } = await pool.query(
        `INSERT INTO releases (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, vals);
      made.releases.push(r.id);
      return r.id;
    };
    await mkRelease(10);
    await mkRelease(12, { archived: true });
    await mkRelease(60);
    const r1 = await loop(T);
    check('releases.count moved by exactly 1 (archived and 60-day ignored)', r1.releases.count === before.releases.count + 1, `${before.releases.count} → ${r1.releases.count}`);
    check('releases.under_half moved by 1 (empty checklist)', r1.releases.under_half === before.releases.under_half + 1);
    check('releases.next names a release within the window', r1.releases.next && r1.releases.next.release_date && r1.releases.next.release_date <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));

    // ── 6. the A&R user sees the release, still nothing else ──
    const anr2 = await loop(tokenFor(anr));
    check('A&R User sees the new release in their count', anr2.releases.count === r1.releases.count && anr2.approvals === null);
  } catch (err) {
    console.error('FIXTURE ERROR', err);
    results.push({ name: 'no exception', ok: false });
  } finally {
    // cleanup — order matters for FKs
    await pool.query('DELETE FROM bank_transactions WHERE statement_id = ANY($1)', [made.statements]).catch(() => {});
    await pool.query('DELETE FROM bank_statements WHERE id = ANY($1)', [made.statements]).catch(() => {});
    await pool.query('DELETE FROM expenses WHERE id = ANY($1)', [made.expenses]).catch(() => {});
    await pool.query('DELETE FROM releases WHERE id = ANY($1)', [made.releases]).catch(() => {});
    await pool.query('DELETE FROM artists WHERE id = ANY($1)', [made.artists]).catch(() => {});
    await pool.query('DELETE FROM user_page_permissions WHERE user_id = ANY($1)', [made.users]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]).catch(() => {});
    await pool.end();
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed`);
    process.exit(passed === results.length ? 0 : 1);
  }
})();
