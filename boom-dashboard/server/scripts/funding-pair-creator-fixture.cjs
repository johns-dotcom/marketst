/**
 * A creator payment must survive the PayPal funding-pair sweep with its own
 * disposition, and the money must be counted exactly once.
 *
 * PayPal payments are ALWAYS bank-funded (John's rule), so a creator payment
 * matched on the PayPal side while the bank pull carries a booking is the
 * ORDINARY case. The sweep runs unattended on GET /statements, and its
 * moveInvoice branch hard-coded match_method='rematch' — which feeds
 * bucket.matched, the bucket invoice_backed_pct reduces over.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');
const API = 'http://localhost:3011/api';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'FP' + (process.pid % 10000);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };

(async () => {
  const l = await (await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'john@deanst.co', password: process.env.PW_JOHN }) })).json();
  const H = { authorization: 'Bearer ' + (l.data?.token || l.token), 'content-type': 'application/json' };
  const j = async (p, o = {}) => { const r = await fetch(API + p, { headers: H, ...o });
    const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t.slice(0, 200) }; } };
  const made = { exp: [], txn: [], stmt: [] };

  try {
    // A creator with a name long enough to clear MIN_PREFIX (10) — the sweep's
    // naming guard, which exists because a $200 mispairing once deleted a real
    // booking. "shannonwestbrook" is 16.
    const NAME = 'Shannon Westbrook';
    const AMT = 137.50;

    const creator = (await j('/creators', { method: 'POST', body: JSON.stringify({
      // All seven fields are required as of 2026-08-24.
      payee: NAME, amount: AMT, artist: `Zz ${TAG}`, song: 'Track',
      vendor_email: 'shannon@example.com', paypal_handle: '@shannonw',
      social_handles: [{ platform: 'tiktok', handle: '@shannonw' }],
      payment_date: '2026-06-10',
    }) })).body?.data;
    if (!creator?.id) { console.log('could not create the creator payment — aborting'); process.exit(2); }
    made.exp.push(creator.id);

    // The PayPal statement line, matched to the creator payment.
    const { rows: [ppStmt] } = await pool.query(
      `INSERT INTO bank_statements (filename, account, period_start, period_end, status, created_at)
       VALUES ($1,'paypal','2026-06-01','2026-06-30','ready',NOW()) RETURNING id`, [`pp-${TAG}.pdf`]);
    made.stmt.push(ppStmt.id);
    const { rows: [ppTxn] } = await pool.query(
      `INSERT INTO bank_transactions (statement_id, txn_date, description, payee_guess, amount, direction)
       VALUES ($1,'2026-06-10',$2,$3,$4,'debit') RETURNING id`,
      [ppStmt.id, `PAYPAL PAYMENT ${NAME}`, NAME, AMT]);
    made.txn.push(ppTxn.id);
    const m = await j(`/statements/tx/${ppTxn.id}/match`, { method: 'POST', body: JSON.stringify({ expense_id: creator.id }) });
    ok(m.status === 200, `the creator payment matched the PayPal line (${m.status})`);

    // The BANK pull that funded it, already carrying an invented booking —
    // this is what makes the sweep take the moveInvoice branch.
    const { rows: [bkStmt] } = await pool.query(
      `INSERT INTO bank_statements (filename, account, period_start, period_end, status, created_at)
       VALUES ($1,'bofa','2026-06-01','2026-06-30','ready',NOW()) RETURNING id`, [`bk-${TAG}.pdf`]);
    made.stmt.push(bkStmt.id);
    const { rows: [booking] } = await pool.query(
      `INSERT INTO expenses (payee, amount, currency, category, invoice_date, status,
         payment_status, payment_date, entry_source)
       VALUES ($1,$2,'USD','Services','2026-06-11','approved','Paid','2026-06-11','bank_statement') RETURNING id`,
      [NAME, AMT]);
    made.exp.push(booking.id);
    const { rows: [bkTxn] } = await pool.query(
      `INSERT INTO bank_transactions (statement_id, txn_date, description, payee_guess, amount, direction,
         matched_expense_id, match_method, matched_at)
       VALUES ($1,'2026-06-11',$2,$3,$4,'debit',$5,'created',NOW()) RETURNING id`,
      [bkStmt.id, `PAYPAL DES:PURCHASE ID:SHANNONWESTBROOK PMT INFO:WEB`, NAME, AMT, booking.id]);
    made.txn.push(bkTxn.id);

    console.log('\n1. the sweep classifies this pair (dry run, writes nothing)');
    const pre = await j('/statements/funding-pairs/preview');
    const seen = JSON.stringify(pre.body || {}).includes(String(ppTxn.id));
    ok(pre.status === 200, `preview answered (${pre.status})`);
    ok(seen, 'the pair is one the sweep acts on — otherwise the rest proves nothing');

    console.log('\n2. the sweep runs, and the creator disposition SURVIVES the move');
    await j('/statements');   // GET /statements is what runs the live sweep
    const { rows: [bkAfter] } = await pool.query(
      'SELECT matched_expense_id, match_method, dismissed FROM bank_transactions WHERE id=$1', [bkTxn.id]);
    const { rows: [ppAfter] } = await pool.query(
      'SELECT matched_expense_id, match_method, dismissed FROM bank_transactions WHERE id=$1', [ppTxn.id]);
    console.log(`        bank  → expense ${bkAfter.matched_expense_id} method '${bkAfter.match_method}' dismissed=${bkAfter.dismissed}`);
    console.log(`        pp    → expense ${ppAfter.matched_expense_id} method '${ppAfter.match_method}' dismissed=${ppAfter.dismissed}`);
    const moved = bkAfter.matched_expense_id === creator.id;
    if (!moved && bkAfter.match_method === 'created') {
      console.log('\n  ABORT — the sweep did not run. It is throttled to once per 10 minutes');
      console.log('  (sweepsLastRun, routes/statements.js:1390). Restart the dev server and re-run.');
      console.log('  Reporting this rather than a FAIL, because a throttled sweep is not a broken one.');
      process.exit(2);
    }
    ok(moved, 'the creator payment moved onto the bank row (the sweep took the moveInvoice branch)');
    ok(bkAfter.match_method === 'creator',
       `and kept match_method='creator' — NOT 'rematch' (got '${bkAfter.match_method}')`);

    console.log('\n3. the money is counted ONCE');
    const counted = [bkAfter, ppAfter].filter((t) => !t.dismissed && t.matched_expense_id === creator.id).length;
    ok(counted === 1, `exactly ${counted} live transaction points at the creator payment`);
    // The above is true BEFORE the sweep too (pp holds it, bank holds its own
    // booking), so on its own it discriminates nothing. These are the two that
    // only hold once the money has actually been de-duplicated.
    ok(ppAfter.dismissed === true, 'the PayPal twin is closed — the bank row is where the report reads');
    const { rows: [bk] } = await pool.query('SELECT deleted FROM expenses WHERE id=$1', [booking.id]);
    ok(bk?.deleted === true, 'and the invented bank booking is gone, so the pull is not counted twice');

    console.log('\n4. and it is still not invoice-backed');
    const comp = await j(`/statements/completion?statement_id=${bkStmt.id}`);
    const d = comp.body?.data || {};
    console.log(`        invoice_backed=${d.invoice_backed_pct}%  explained=${d.explained_pct}%  creator=${JSON.stringify(d.creator)}`);
    ok(d.creator?.n === 1, `the bank statement's creator bucket holds it (n=${d.creator?.n})`);
    ok(d.invoice_backed_pct === 0,
       `invoice_backed_pct is ${d.invoice_backed_pct}% — the moved payment claims no document`);
    ok(d.explained_pct > 0, `explained_pct is ${d.explained_pct}% — the line IS accounted for`);

    console.log('\n5. the counterfactual: what \'rematch\' would have done');
    // No code is changed here. The bank row is set to the method the sweep used
    // to hard-code, and the SAME endpoint is asked again. This is the proof that
    // the bug was real rather than theoretical.
    await pool.query("UPDATE bank_transactions SET match_method='rematch' WHERE id=$1", [bkTxn.id]);
    const bad = (await j(`/statements/completion?statement_id=${bkStmt.id}`)).body?.data || {};
    console.log(`        with 'rematch': invoice_backed=${bad.invoice_backed_pct}%  creator=${JSON.stringify(bad.creator)}`);
    ok(bad.invoice_backed_pct === 100,
       `'rematch' reports the creator payment as ${bad.invoice_backed_pct}% invoice-backed — with no invoice anywhere`);
    ok(bad.creator?.n === 0, 'and empties the creator bucket');
    await pool.query("UPDATE bank_transactions SET match_method='creator' WHERE id=$1", [bkTxn.id]);
    const good = (await j(`/statements/completion?statement_id=${bkStmt.id}`)).body?.data || {};
    ok(good.invoice_backed_pct === 0 && good.creator?.n === 1,
       `back to 'creator': invoice_backed=${good.invoice_backed_pct}%, creator n=${good.creator?.n}`);

  } finally {
    for (const id of made.txn) await pool.query('DELETE FROM bank_transactions WHERE id=$1', [id]).catch(() => {});
    for (const id of made.stmt) await pool.query('DELETE FROM bank_statements WHERE id=$1', [id]).catch(() => {});
    for (const id of made.exp) await pool.query('DELETE FROM expenses WHERE id=$1', [id]).catch(() => {});
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
