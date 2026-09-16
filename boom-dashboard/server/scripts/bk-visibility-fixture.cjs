#!/usr/bin/env node
/**
 * Who can read and delete what, on the bookkeeping endpoints.
 *
 * Two holes from the June audit, both still open on 2026-09-01:
 *
 *   DELETE / restore /bk/entries/:id had NO visibility check at all. Any account
 *   that could reach /api/bk/* could soft-delete any expense by id — and the
 *   delete cascades to the split children and unlinks the bank rows matched to
 *   it.
 *
 *   /bk/entries, /bk/invoices and /bk/vendors applied no rep scoping, while
 *   /bk/payments always has. So scoping the Payments dashboard bought nothing:
 *   the same rows were readable through the endpoint that page itself calls.
 *
 * Plus one found while fixing them: `isBkAdmin` was never defined in
 * routes/bookkeeping.js, so `GET /vendors/:payee/payment-details` — the only
 * route that decrypts a vendor's bank details — threw and answered 500 to
 * everyone, Superadmins included.
 *
 * The fixture asserts BOTH directions, because a permission change is only half
 * tested by the half that refuses: the bookkeeping roles must see exactly what
 * they saw before, and a rep-scoped User must see only their own rows.
 *
 *     cd server && PORT=3011 node index.js &
 *     node scripts/bk-visibility-fixture.cjs
 *
 * Creates its own users and expenses in the dev database and deletes them at
 * the end, pass or fail.
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const BASE = process.env.API_BASE || 'http://127.0.0.1:3011/api';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : `— ${detail}`);
};

const tokenFor = (u) => jwt.sign(
  { id: u.id, email: u.email, name: u.name, role: u.role, tv: u.token_version || 0 },
  process.env.JWT_SECRET, { expiresIn: '1h' });

const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// The bookkeeping page grants the router gate accepts. A User needs one to get
// past the door at all — which is the point: these tests are about what happens
// AFTER that grant, which is where the holes were.
const GRANT = '/bk/ledger';

(async () => {
  const made = { users: [], expenses: [] };
  try {
    const mkUser = async (name, role, boomRep) => {
      const { rows: [u] } = await pool.query(
        `INSERT INTO users (name, email, role, password_hash, boom_rep, token_version)
         VALUES ($1, $2, $3, 'x', $4, 0) RETURNING id, name, email, role, boom_rep, token_version`,
        [name, `${name.toLowerCase()}@viz-fixture.test`, role, boomRep || null]);
      made.users.push(u.id);
      if (role === 'User') {
        await pool.query(
          `INSERT INTO user_page_permissions (user_id, page) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`, [u.id, GRANT]).catch(() => {});
      }
      return u;
    };
    const mkExpense = async (payee, rep) => {
      const { rows: [e] } = await pool.query(
        `INSERT INTO expenses (invoice_date, payee, category, artist, amount, currency,
                               payment_method, status, payment_status, boom_rep, created_by)
         VALUES ('2026-09-01', $1, 'Recording', 'Jerri', 100, 'USD', 'ACH', 'approved', 'Unpaid', $2, 'fixture')
         RETURNING id`, [payee, rep]);
      made.expenses.push(e.id);
      return e.id;
    };

    const admin = await mkUser('VizAdmin', 'Superadmin', null);
    const scoped = await mkUser('VizUser', 'User', 'Felipe');   // rep-scoped
    const mine = await mkExpense('VIZ FIXTURE MINE', 'Felipe');
    const theirs = await mkExpense('VIZ FIXTURE THEIRS', 'Jesse');

    const adminTok = tokenFor(admin);
    const userTok = tokenFor(scoped);

    // ── 1. The reads ──────────────────────────────────────────────────────
    const list = async (token, path) => {
      const r = await call('GET', path, token);
      const rows = r.body?.data || [];
      return { status: r.status, ids: rows.map((x) => x.id), rows };
    };

    const aEntries = await list(adminTok, '/bk/entries?status=approved');
    check('admin still sees both rows on /bk/entries',
      aEntries.status === 200 && aEntries.ids.includes(mine) && aEntries.ids.includes(theirs),
      `${aEntries.status}, ${aEntries.ids.length} rows`);

    const uEntries = await list(userTok, '/bk/entries?status=approved');
    check('a rep-scoped User sees only their own row on /bk/entries',
      uEntries.status === 200 && uEntries.ids.includes(mine) && !uEntries.ids.includes(theirs),
      `${uEntries.status}, ${uEntries.ids.length} rows`);

    const uInv = await list(userTok, '/bk/invoices');
    check('…and only their own on /bk/invoices',
      uInv.status === 200 && !uInv.ids.includes(theirs), `${uInv.status}, ${uInv.ids.length} rows`);

    const uVend = await call('GET', '/bk/vendors', userTok);
    const vendPayees = (uVend.body?.data || []).map((v) => v.payee);
    check('…and the vendor directory does not name the other rep’s vendor',
      uVend.status === 200 && !vendPayees.includes('VIZ FIXTURE THEIRS'),
      `${uVend.status}, ${vendPayees.length} vendors`);
    const aVend = await call('GET', '/bk/vendors', adminTok);
    const aPayees = (aVend.body?.data || []).map((v) => v.payee);
    check('…while an admin still sees both vendors',
      aPayees.includes('VIZ FIXTURE MINE') && aPayees.includes('VIZ FIXTURE THEIRS'),
      `${aPayees.length} vendors`);

    // Payments was already scoped — assert it still is, so this change cannot
    // have loosened the one endpoint that was right.
    const uPay = await list(userTok, '/bk/payments');
    check('/bk/payments is still scoped', uPay.status === 200 && !uPay.ids.includes(theirs),
      `${uPay.status}, ${uPay.ids.length} rows`);

    // ── 2. The label-level surfaces ───────────────────────────────────────
    for (const path of ['/bk/analytics', '/bk/approval-history', '/bk/w9s', '/bk/1099']) {
      const u = await call('GET', path, userTok);
      const a = await call('GET', path, adminTok);
      check(`${path} refuses a User and answers an admin`, u.status === 403 && a.status === 200,
        `user ${u.status}, admin ${a.status}`);
    }

    // ── 3. The delete that had no gate ────────────────────────────────────
    const del = await call('DELETE', `/bk/entries/${theirs}`, userTok);
    const { rows: [after] } = await pool.query('SELECT deleted FROM expenses WHERE id = $1', [theirs]);
    check('a User cannot delete another rep’s entry', del.status === 403 && after.deleted !== true,
      `${del.status}, deleted=${after.deleted}`);

    const delMine = await call('DELETE', `/bk/entries/${mine}`, userTok);
    const { rows: [minAfter] } = await pool.query('SELECT deleted FROM expenses WHERE id = $1', [mine]);
    check('…but can still delete their own', delMine.status === 200 && minAfter.deleted === true,
      `${delMine.status}, deleted=${minAfter.deleted}`);

    const restoreTheirs = await call('POST', `/bk/entries/${theirs}/restore`, userTok);
    check('and cannot restore another rep’s entry either', restoreTheirs.status === 403, restoreTheirs.status);

    const adminDel = await call('DELETE', `/bk/entries/${theirs}`, adminTok);
    check('an admin can still delete anything', adminDel.status === 200, adminDel.status);

    // ── 4. The gate that did not exist ────────────────────────────────────
    const pd = await call('GET', `/bk/vendors/${encodeURIComponent('VIZ FIXTURE MINE')}/payment-details`, adminTok);
    check('payment-details no longer throws for an admin',
      pd.status !== 500 && !/isBkAdmin is not defined/.test(JSON.stringify(pd.body || {})),
      `${pd.status} ${JSON.stringify(pd.body).slice(0, 90)}`);
    const pdUser = await call('GET', `/bk/vendors/${encodeURIComponent('VIZ FIXTURE MINE')}/payment-details`, userTok);
    check('…and refuses a User with 403, not a crash', pdUser.status === 403, pdUser.status);
  } catch (err) {
    check('fixture ran to completion', false, err.message);
  } finally {
    if (made.expenses.length) {
      await pool.query('DELETE FROM bk_audit_log WHERE entry_id = ANY($1::int[])', [made.expenses]).catch(() => {});
      await pool.query('DELETE FROM expenses WHERE id = ANY($1::int[])', [made.expenses]).catch(() => {});
    }
    if (made.users.length) {
      // Every FK a fixture user can pick up just by making requests. Deleting a
      // user is not one statement in this schema (CLAUDE.md's own gotcha #12),
      // and a fixture that leaves its users behind fails the NEXT run on the
      // email unique index rather than on anything real — which is exactly how
      // this one first "failed".
      for (const t of ['user_page_permissions', 'user_visible_reps', 'activity_log', 'user_login_logs']) {
        await pool.query(`DELETE FROM ${t} WHERE user_id = ANY($1::int[])`, [made.users]).catch(() => {});
      }
      const gone = await pool.query('DELETE FROM users WHERE id = ANY($1::int[]) RETURNING id', [made.users])
        .catch((e) => { console.log('fixture users NOT removed:', e.message); return { rowCount: 0 }; });
      if (gone.rowCount !== made.users.length) {
        console.log(`WARNING: ${made.users.length - gone.rowCount} fixture user(s) left behind`);
      }
    }
    await pool.end();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
