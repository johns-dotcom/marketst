/**
 * Creator payments: paid vs not-yet, and the column the page reads.
 *
 * ── The bug this starts with ──
 * `GET /api/creators` never selected `payment_status`, and the page branches on
 * it: `recoupState` is "payment_status is not 'Paid', therefore unpaid". So all
 * five live creator payments rendered **Unpaid** while being Paid in the
 * database. Test 1 asserts the column is now in the payload — which is the whole
 * reason there was nothing to "mark as paid".
 *
 * ── And the state that did not exist ──
 * Rows were created `payment_status = 'Paid'` unconditionally with the date
 * defaulting to today, so "we owe this creator" was unrecordable and nothing
 * could be marked paid because everything already was. Both states exist now,
 * PAID still the default.
 *
 * The invariant worth naming: `payment_status` and `payment_date` MOVE TOGETHER.
 * Paid with no date, or a date on an unpaid row, reads one way to recoupState and
 * another to every date-bounded report.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');

const BASE = 'http://localhost:3011';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'CP' + (process.pid % 100000);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const TODAY = new Date().toISOString().slice(0, 10);
// pg hands back a JS Date for DATE columns, and String(aDate) is
// "Thu Aug 27 2026 …" — slicing that gives "Thu Aug 2". Format the DAY properly.
const day = (d) => {
  if (!d) return null;
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return String(d).slice(0, 10);
};

(async () => {
  const made = [];
  let token = null;
  const H = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token });
  const j = async (path, opts) => {
    const r = await fetch(BASE + '/api' + path, { headers: H(), ...opts });
    let body = null; try { body = await r.json() } catch {}
    return { code: r.status, body };
  };
  const creator = (over = {}) => ({
    payee: `Creator ${TAG}`, vendor_email: `c${TAG}@example.com`, paypal_handle: `@c${TAG}`,
    artist: 'Fixture Artist', song: 'Fixture Song', amount: 250,
    social_handles: [{ platform: 'Instagram', handle: `@c${TAG}` }], ...over,
  });
  const rowOf = async (id) => (await pool.query(
    'SELECT payment_status, payment_date, description FROM expenses WHERE id = $1', [id])).rows[0];
  const listed = async (id) => {
    const r = await j('/creators');
    return (r.body?.data?.rows || r.body?.data || []).find((x) => x.id === id);
  };

  try {
    const L = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'john@deanst.co', password: process.env.PW_JOHN }),
    });
    token = (await L.json())?.data?.token;
    if (!token) { console.error('login failed'); process.exit(1); }
    console.log('logged in against the DEV database\n');

    console.log('1. the list returns payment_status — without it every row read Unpaid');
    const a = await j('/creators', { method: 'POST', body: JSON.stringify(creator()) });
    ok(a.code === 201, `created (${a.code})`);
    made.push(a.body?.data?.id);
    const la = await listed(a.body.data.id);
    ok(!!la, 'the new payment is in the list');
    ok(la && 'payment_status' in la, 'and the row carries payment_status');
    ok(la?.payment_status === 'Paid', `which reads 'Paid' (${la?.payment_status}) — the default is unchanged`);

    console.log('\n2. a payment can be logged as NOT yet paid');
    const b = await j('/creators', { method: 'POST', body: JSON.stringify(creator({ payment_status: 'Unpaid' })) });
    ok(b.code === 201, `created unpaid (${b.code})`);
    made.push(b.body?.data?.id);
    const rb = await rowOf(b.body.data.id);
    ok(rb.payment_status === 'Unpaid', `payment_status is Unpaid (${rb.payment_status})`);
    ok(rb.payment_date === null, 'and there is NO payment date — an unpaid row cannot carry one');

    console.log('\n3. marking it paid moves both columns together');
    const p = await j(`/creators/${b.body.data.id}`, { method: 'PUT', body: JSON.stringify({ payment_status: 'Paid' }) });
    ok(p.code === 200, `marked paid (${p.code})`);
    const rp = await rowOf(b.body.data.id);
    ok(rp.payment_status === 'Paid', 'payment_status is Paid');
    ok(day(rp.payment_date) === TODAY, `and dated today (${day(rp.payment_date)})`);

    console.log('\n4. and back again — the undo for marking the wrong one');
    const u = await j(`/creators/${b.body.data.id}`, { method: 'PUT', body: JSON.stringify({ payment_status: 'Unpaid' }) });
    ok(u.code === 200, `un-paid (${u.code})`);
    const ru = await rowOf(b.body.data.id);
    ok(ru.payment_status === 'Unpaid' && ru.payment_date === null,
      'both columns moved back — no orphan date left behind');

    console.log('\n5. a bad status is refused');
    const bad = await j(`/creators/${b.body.data.id}`, { method: 'PUT', body: JSON.stringify({ payment_status: 'Sort of' }) });
    ok(bad.code === 400, `refused (${bad.code}) ${String(bad.body?.error || '').slice(0, 60)}`);
    ok((await rowOf(b.body.data.id)).payment_status === 'Unpaid', 'and nothing changed');

    console.log('\n6. a batch can be unpaid, and deal_name is gone');
    const batch = await j('/creators/batch', { method: 'POST', body: JSON.stringify({
      payment_status: 'Unpaid',
      deal_name: 'Summer push',            // sent deliberately — must be IGNORED now
      payments: [creator({ payee: `Batch A ${TAG}` }), creator({ payee: `Batch B ${TAG}` })],
    }) });
    ok(batch.code === 201, `batch created (${batch.code}) ${batch.code !== 201 ? JSON.stringify(batch.body).slice(0, 120) : ''}`);
    // /batch answers with a COUNT and summary, not the rows — so the ids come
    // from the ledger by payee. Assuming a shape is how the first run of this
    // fixture died on `.map is not a function`.
    ok(batch.body?.data?.created === 2, `it reports two created (${batch.body?.data?.created})`);
    const { rows: bIds } = await pool.query(
      "SELECT id FROM expenses WHERE payee LIKE $1 ORDER BY id", [`Batch % ${TAG}`]);
    const ids = bIds.map((x) => x.id);
    made.push(...ids);
    ok(ids.length === 2, `two rows written (${ids.length})`);
    for (const id of ids) {
      const r = await rowOf(id);
      ok(r.payment_status === 'Unpaid' && r.payment_date === null,
        `row ${id} is unpaid with no date`);
      ok(r.description === null, `and its description is NOT the deal name (${JSON.stringify(r.description)})`);
    }

    console.log('\n7. a paid batch still gets today, as before');
    const paidBatch = await j('/creators/batch', { method: 'POST', body: JSON.stringify({
      payments: [creator({ payee: `Batch C ${TAG}` })],
    }) });
    ok(paidBatch.code === 201, `batch created (${paidBatch.code})`);
    const { rows: [pRow] } = await pool.query(
      "SELECT id FROM expenses WHERE payee = $1", [`Batch C ${TAG}`]);
    const pid = pRow?.id;
    if (pid) {
      made.push(pid);
      const r = await rowOf(pid);
      ok(r.payment_status === 'Paid' && day(r.payment_date) === TODAY,
        `paid and dated today (${r.payment_status}, ${day(r.payment_date)})`);
    }
  } catch (err) {
    console.error('\nFIXTURE ERROR:', err.message);
    fail += 1;
  } finally {
    await pool.query('DELETE FROM expenses WHERE id = ANY($1::int[])', [made.filter(Boolean)]).catch(() => {});
    await pool.query("DELETE FROM expenses WHERE payee LIKE $1", [`%${TAG}%`]).catch(() => {});
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
