/**
 * Marking invoices paid — singly and as one batch — actually works.
 *
 * ── The hole this closes ──
 * From 2026-07-07 (771ddfb) to 2026-08-31, `PUT /api/bk/payments/:id` returned
 * **500 on every call**:
 *
 *     COALESCE types date and text cannot be matched
 *
 * `scheduled_payment_date` is a TEXT column and the statement did
 * `COALESCE($4::date, scheduled_payment_date)`. Postgres rejects that AT PLAN
 * TIME, so it failed for every row, with every payload, whether or not $4 was
 * supplied. The Payments page could not mark anything paid — one row or five.
 *
 * Two things kept it hidden for eight weeks:
 *   • the client caught the error and said "Failed to bulk update", throwing
 *     away the one sentence that named the cause;
 *   • the Ledger marks paid through a DIFFERENT route (PUT /entries/:id), which
 *     has no such cast, so the obvious path kept working.
 *
 * lib/bank-evidence.js had already hit this exact error and documented it in its
 * header. The lesson was written down in one file while the hazard survived in
 * another — which is what this fixture is for.
 *
 * ── Run ──
 *     cd server
 *     PORT=3011 node index.js &
 *     node scripts/mark-paid-fixture.cjs
 *
 * Writes only rows it creates, and deletes them in `finally`.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');

const BASE = 'http://localhost:3011';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'MP' + (process.pid % 100000);
const PAYEE = `MarkPaid Fixture ${TAG}`;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };

const mk = async (n) => {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const { rows } = await pool.query(
      `INSERT INTO expenses (invoice_date, payee, amount, currency, status, payment_status, created_at)
       VALUES (NOW(), $1, 2000, 'USD', 'approved', 'Unpaid', NOW()) RETURNING id`, [PAYEE]);
    ids.push(rows[0].id);
  }
  return ids;
};

(async () => {
  let token = null;
  try {
    const L = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'john@deanst.co', password: process.env.PW_JOHN }),
    });
    token = (await L.json())?.data?.token;
    if (!token) { console.error('login failed — is the dev server up on :3011?'); process.exit(1); }

    const put = (id, body) => fetch(`${BASE}/api/bk/payments/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    }).then(async (r) => ({ code: r.status, j: await r.json().catch(() => null) }));

    // ── 1. one invoice ────────────────────────────────────────────────────────
    console.log('1. a single invoice can be marked paid');
    const [one] = await mk(1);
    const r1 = await put(one, { payment_status: 'Paid', payment_date: '2026-08-31' });
    ok(r1.code === 200, `PUT /bk/payments/:id -> ${r1.code} ${r1.code !== 200 ? JSON.stringify(r1.j) : ''}`);
    const { rows: after1 } = await pool.query('SELECT payment_status, payment_date FROM expenses WHERE id = $1', [one]);
    ok(after1[0]?.payment_status === 'Paid', `and the row IS paid (${after1[0]?.payment_status})`);
    ok(!!after1[0]?.payment_date, 'with a payment date stamped');

    // ── 2. five at once, the way the batch modal does it ─────────────────────
    console.log('\n2. five invoices marked paid in parallel — the batch path');
    const many = await mk(5);
    const res = await Promise.all(many.map((id) =>
      put(id, { payment_status: 'Paid', payment_date: '2026-08-31' })));
    const bad = res.filter((r) => r.code !== 200);
    ok(bad.length === 0,
      `all five returned 200 (${res.length - bad.length}/5)`
      + (bad.length ? ` — first error: ${JSON.stringify(bad[0].j)}` : ''));
    const { rows: paid } = await pool.query(
      `SELECT COUNT(*)::int n FROM expenses WHERE id = ANY($1) AND payment_status = 'Paid'`, [many]);
    ok(paid[0].n === 5, `and all five are Paid in the database (${paid[0].n}/5)`);

    // ── 3. the exact parameter that broke it ─────────────────────────────────
    // $4 is scheduled_payment_date. The old statement failed even when it was
    // NOT supplied — the plan is rejected before any value is considered — so
    // both cases are asserted.
    console.log('\n3. scheduled_payment_date, the parameter that caused it');
    const [sched] = await mk(1);
    const r3 = await put(sched, { scheduled_payment_date: '2026-09-30' });
    ok(r3.code === 200, `supplying it -> ${r3.code} ${r3.code !== 200 ? JSON.stringify(r3.j) : ''}`);
    const { rows: s3 } = await pool.query('SELECT scheduled_payment_date FROM expenses WHERE id = $1', [sched]);
    ok(String(s3[0]?.scheduled_payment_date || '').startsWith('2026-09-30'),
      `and it is stored (${s3[0]?.scheduled_payment_date})`);
    const r3b = await put(sched, { payment_status: 'Unpaid' });
    ok(r3b.code === 200, `omitting it -> ${r3b.code} (the old bug failed here too)`);
    const { rows: s3b } = await pool.query('SELECT scheduled_payment_date FROM expenses WHERE id = $1', [sched]);
    ok(String(s3b[0]?.scheduled_payment_date || '').startsWith('2026-09-30'),
      'and omitting it does not wipe the stored value');
  } catch (err) {
    console.error('\nFIXTURE ERROR:', err.message);
    fail += 1;
  } finally {
    const d = await pool.query('DELETE FROM expenses WHERE payee = $1 RETURNING id', [PAYEE]).catch(() => ({ rowCount: 0 }));
    console.log(`\ncleaned up ${d.rowCount} fixture row(s)`);
    await pool.end();
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
