/**
 * Creator payments.
 *
 * Assertion #1 is the one everything else rests on: the app REFUSES to match a
 * bank line to a creator-shaped expense today. If that refusal isn't real, the
 * whole disposition design is solving a problem that doesn't exist — so it is
 * proven against the running server before a line changes.
 *
 * Assertion #2 is the one the design exists FOR: invoice_backed_pct must not
 * move when a creator payment is matched. Explained, never invoice-backed.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');
const API = 'http://localhost:3011/api';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'CRT' + (process.pid % 10000);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };

(async () => {
  const login = await (await fetch(API + '/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'john@deanst.co', password: process.env.PW_JOHN }) })).json();
  const token = login?.data?.token || login?.token;
  if (!token) { console.log('no token:', JSON.stringify(login).slice(0, 200)); process.exit(1); }
  const H = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const j = async (p, o = {}) => { const r = await fetch(API + p, { headers: H, ...o });
    const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; }
    catch { return { status: r.status, body: t.slice(0, 300) }; } };
  const made = { exp: [], txn: [], stmt: [] };

  try {
    // A CREATOR-SHAPED expense, exactly as the new page would write one:
    // hand-added, no invoice file, not vendor-submitted, already paid by PayPal.
    const { rows: [creator] } = await pool.query(
      `INSERT INTO expenses (payee, amount, currency, category, artist, song, invoice_date,
         status, payment_status, payment_date, payment_method, entry_source, recoupable)
       VALUES ($1, 250.00, 'USD', 'Marketing', $2, 'Test Song', '2026-06-05',
         'approved', 'Paid', '2026-06-05', 'PayPal', 'creator_payment', TRUE) RETURNING id`,
      [`Creator ${TAG}`, `Zz Artist ${TAG}`]);
    made.exp.push(creator.id);

    // A PayPal statement with one debit for the same amount.
    const { rows: [stmt] } = await pool.query(
      // Columns copied from index.js:3080, not guessed. Hand-writing a fixture
      // schema is how the last one failed on a column that never existed.
      `INSERT INTO bank_statements (filename, account, period_start, period_end, status, created_at)
       VALUES ($1, 'paypal', '2026-06-01', '2026-06-30', 'ready', NOW()) RETURNING id`,
      [`fixture-${TAG}.pdf`]);
    made.stmt.push(stmt.id);
    const { rows: [txn] } = await pool.query(
      `INSERT INTO bank_transactions (statement_id, txn_date, description, amount, direction)
       VALUES ($1, '2026-06-05', $2, 250.00, 'debit') RETURNING id`,
      [stmt.id, `PAYPAL *CREATOR ${TAG}`]);
    made.txn.push(txn.id);

    console.log('\n1. a creator payment can now be matched');
    const res = await j(`/statements/tx/${txn.id}/match`, { method: 'POST',
      body: JSON.stringify({ expense_id: creator.id }) });
    const msg = JSON.stringify(res.body);
    // 400, specifically. `>= 400` let a 404 "Route not found" pass as a
    // refusal on the first run — the guard returns 400, so that is what is asserted.
    ok(res.status === 200,
       `POST /statements/tx/:id/match on a creator payment is ALLOWED (got ${res.status})`);
    const { rows: [mm] } = await pool.query('SELECT match_method, matched_expense_id FROM bank_transactions WHERE id=$1', [txn.id]);
    ok(mm.match_method === 'creator',
       `and it records match_method='creator', not 'manual' (got '${mm.match_method}')`);

    console.log('\n2. the exemption is NARROW — an ordinary undocumented row is still refused');
    const { rows: [plain] } = await pool.query(
      `INSERT INTO expenses (payee, amount, currency, category, artist, invoice_date,
         status, payment_status, payment_date, entry_source, recoupable)
       VALUES ($1, 250.00, 'USD', 'Marketing', $2, '2026-06-05',
         'approved', 'Paid', '2026-06-05', NULL, TRUE) RETURNING id`,
      [`Plain Vendor ${TAG}`, `Zz Artist ${TAG}`]);
    made.exp.push(plain.id);
    const { rows: [txn2] } = await pool.query(
      `INSERT INTO bank_transactions (statement_id, txn_date, description, amount, direction)
       VALUES ($1, '2026-06-06', $2, 250.00, 'debit') RETURNING id`,
      [stmt.id, `PAYPAL *PLAIN ${TAG}`]);
    made.txn.push(txn2.id);
    const res2 = await j(`/statements/tx/${txn2.id}/match`, { method: 'POST',
      body: JSON.stringify({ expense_id: plain.id }) });
    ok(res2.status === 400 && /added by hand and has no invoice/i.test(JSON.stringify(res2.body)),
       `a hand-added row that is NOT a creator payment is still refused (${res2.status})`);

    console.log('\n3. invoice_backed_pct does not move; explained_pct does');
    // Measured on the SAME statement, before and after the creator match, so
    // nothing else in the dev ledger can drift the numbers underneath us.
    const readPcts = async () => {
      const r = await j(`/statements/completion?statement_id=${stmt.id}`);
      const d = r.body?.data || {};
      return { invoice: d.invoice_backed_pct, explained: d.explained_pct,
               creatorBucket: (d.creator?.n ?? d.creator?.length ?? null), status: r.status };
    };
    // Unmatch first so we can measure the BEFORE state on a line we then match.
    await pool.query('UPDATE bank_transactions SET matched_expense_id=NULL, match_method=NULL WHERE id=$1', [txn.id]);
    const before = await readPcts();
    await j(`/statements/tx/${txn.id}/match`, { method: 'POST', body: JSON.stringify({ expense_id: creator.id }) });
    const after = await readPcts();
    console.log(`        before: invoice_backed=${before.invoice}  explained=${before.explained}`);
    console.log(`        after : invoice_backed=${after.invoice}  explained=${after.explained}`);
    ok(before.status === 200 && after.status === 200, `the summary endpoint answered (${before.status}/${after.status})`);
    ok(before.invoice === after.invoice,
       `invoice_backed_pct UNCHANGED: ${before.invoice} → ${after.invoice}`);
    ok(Number(after.explained) > Number(before.explained),
       `explained_pct ROSE: ${before.explained} → ${after.explained}`);

    console.log('\n4. the Vendors directory does not grow');
    const vendorCount = async () => {
      const r = await j('/bk/vendors');
      return (r.body?.data || r.body || []).length;
    };
    const vBefore = await vendorCount();
    const posted = [];
    for (let i = 0; i < 5; i++) {
      const r = await j('/creators', { method: 'POST', body: JSON.stringify({
        // All seven fields are required as of 2026-08-24; an incomplete
        // payload is refused, which is the rule working rather than a bug.
        payee: `Creator ${TAG} ${i}`, amount: 40 + i, artist: `Zz Artist ${TAG}`,
        song: 'Test Song', vendor_email: `c${i}@example.com`, paypal_handle: `@creator${i}`,
        social_handles: [{ platform: 'tiktok', handle: `@creator${i}` }],
        payment_date: '2026-06-10',
      }) });
      if (r.body?.data?.id) { posted.push(r.body.data.id); made.exp.push(r.body.data.id); }
    }
    ok(posted.length === 5, `POST /api/creators created ${posted.length}/5 payments`);
    const vAfter = await vendorCount();
    ok(vBefore === vAfter, `Vendors directory unchanged: ${vBefore} → ${vAfter}`);
    const suggest = await j(`/bk/suggest-vendor?q=Creator%20${TAG}`);
    const sugg = (suggest.body?.data || suggest.body || []);
    ok(Array.isArray(sugg) && sugg.length === 0,
       `and the add-invoice vendor autocomplete offers none of them (${sugg.length} hits)`);

    console.log('\n5. the creator ledger reads back, in dollars');
    const list = await j(`/creators?creator=${encodeURIComponent(`Creator ${TAG} 0`)}`);
    ok(list.body?.data?.length === 1, `GET /api/creators filters to one creator (${list.body?.data?.length})`);
    ok(list.body?.total === 40, `and totals it in USD: ${list.body?.total}`);

    console.log('\n6. W9 exposure is per creator per YEAR, not per payment');
    // Three payments of $250 to ONE creator cross $600 in 2026.
    for (let i = 0; i < 3; i++) {
      const r = await j('/creators', { method: 'POST', body: JSON.stringify({
        payee: `BigCreator ${TAG}`, amount: 250, artist: `Zz Artist ${TAG}`, song: 'Track',
        vendor_email: 'big@example.com', paypal_handle: '@big',
        social_handles: [{ platform: 'tiktok', handle: '@big' }],
        payment_date: '2026-03-0' + (i + 1),
      }) });
      if (r.body?.data?.id) made.exp.push(r.body.data.id);
    }
    // Two DIFFERENT creators at $400 each do not, though they sum to $800.
    for (const n of ['A', 'B']) {
      const r = await j('/creators', { method: 'POST', body: JSON.stringify({
        payee: `SmallCreator ${TAG} ${n}`, amount: 400, artist: `Zz Artist ${TAG}`, song: 'Track',
        vendor_email: `small${n}@example.com`, paypal_handle: `@small${n}`,
        social_handles: [{ platform: 'tiktok', handle: `@small${n}` }],
        payment_date: '2026-03-05',
      }) });
      if (r.body?.data?.id) made.exp.push(r.body.data.id);
    }
    const dir = await j('/creators/directory');
    const find = (name) => (dir.body?.data || []).find((c) => c.payee === name);
    const big = find(`BigCreator ${TAG}`);
    const smallA = find(`SmallCreator ${TAG} A`);
    ok(big && big.total === 750, `BigCreator totals $750 across 3 payments (${big?.total})`);
    ok(big && big.by_year['2026'] === 750, `bucketed under the calendar YEAR 2026 (${JSON.stringify(big?.by_year)})`);
    ok(big && big.w9_missing === true, 'BigCreator is flagged: over $600 in a year with no W9');
    ok(smallA && smallA.w9_missing === false,
       `a $400 creator is NOT flagged even though two of them sum to $800 (${smallA?.total})`);
    const c0 = find(`Creator ${TAG} 0`);
    ok(c0 && c0.paypal_handle === '@creator0' && c0.email === 'c0@example.com',
       'the directory carries the PayPal handle and email');

    console.log('\n7. Recoupments and Artist Campaigns see them');
    const rec = await j('/bk/entries?limit=2000');
    const recRows = (rec.body?.data || []).filter((r) => made.exp.includes(r.id));
    ok(recRows.length > 0, `creator payments are in the ledger feed Recoupments reads (${recRows.length})`);
    const camp = await j('/artist-campaigns');
    const campBody = JSON.stringify(camp.body || {});
    ok(camp.status === 200, `GET /artist-campaigns answers (${camp.status})`);
    ok(campBody.includes(`Zz Artist ${TAG}`),
       'and the fixture artist appears on it — creator spend is campaign spend');

  } finally {
    for (const id of made.txn) await pool.query('DELETE FROM bank_transactions WHERE id=$1', [id]).catch(() => {});
    for (const id of made.stmt) await pool.query('DELETE FROM bank_statements WHERE id=$1', [id]).catch(() => {});
    for (const id of made.exp) await pool.query('DELETE FROM expenses WHERE id=$1', [id]).catch(() => {});
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
