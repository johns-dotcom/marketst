/**
 * A statement's buckets must PARTITION it, and the old coverage bar did not.
 *
 * The statement library reported coverage as (matched + dismissed) / debits and
 * open work as debits - matched - dismissed. Both are wrong, in opposite and
 * compounding directions:
 *
 *   · `matched_expense_id IS NOT NULL` is true for a BOOKED row — an entry the
 *     app invented from the bank line with no document behind it — so a month
 *     full of undocumented bookings read as covered.
 *   · the subtraction double-counts any row that was dismissed AFTER being
 *     matched, so the remainder can read 0 while real work is waiting. This is
 *     the same trap /statements/ already warns about in SQL and the client-side
 *     "All transactions" strip still fell into.
 *
 * This builds one statement holding exactly one row of every disposition and
 * proves: each row lands in its intended bucket, the buckets sum back to the
 * statement on BOTH sides and in BOTH counts and money, and the two old
 * formulas disagree with the truth on the very same rows.
 *
 * Dates and the needs-invoice category are DERIVED or tagged, never assumed —
 * the dev database carries leftovers from earlier fixtures, and a fixture that
 * assumes an empty world fails the dangerous way round: it accuses correct code.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');
const ROOT = __dirname + '/..';
const { bucketKey, DEBIT_BUCKETS, CREDIT_BUCKETS, ACCOUNTED, LEFT } = require(`${ROOT}/lib/statement-buckets`);
const { usdOf } = require(`${ROOT}/lib/usd`);
const statementsRouter = require(`${ROOT}/routes/statements`);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'RC' + (process.pid % 10000);
let pass = 0; let fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const money = (v) => `$${Number(v).toFixed(2)}`;

(async () => {
  const made = { exp: [], stmt: [], inc: [], rule: null };
  try {
    // ── The world ────────────────────────────────────────────────────────────
    // A category nobody can have written a no-invoice rule for, so the
    // needs_invoice row cannot be reclassified by leftover dev-database state.
    const CAT = `Fixture ${TAG}`;
    const { rows: ruleHit } = await pool.query(
      `SELECT 1 FROM statement_no_invoice_rules WHERE LOWER(TRIM(pattern)) = LOWER($1)`, [CAT])
      .catch(() => ({ rows: [] }));
    ok(ruleHit.length === 0, `no pre-existing no-invoice rule claims "${CAT}"`);

    // A vendor rule that keys on the BANK DESCRIPTOR and matches no ledger
    // payee. This is the shape the first version of /reconciliation got wrong:
    // it selected `payee` and `category` for the predicate and not
    // `payee_guess`, so every row covered by a descriptor rule was reported as
    // still owing an invoice. 50 rows on one live statement.
    const DESCRIPTOR = `ACH DEBIT ${TAG} PAYROLL`;
    const { rows: [vr] } = await pool.query(
      `INSERT INTO statement_no_invoice_rules (scope, pattern, created_by)
       VALUES ('vendor', $1, 'fixture') RETURNING id`, [DESCRIPTOR]);
    made.rule = vr.id;

    const { rows: [st] } = await pool.query(
      `INSERT INTO bank_statements (filename, account, period_start, period_end, status, created_at)
       VALUES ($1, 'bofa', '2099-01-01', '2099-01-31', 'ready', NOW()) RETURNING id`,
      [`${TAG}-recon.pdf`]);
    made.stmt.push(st.id);

    const expense = async (label) => {
      const { rows: [r] } = await pool.query(
        `INSERT INTO expenses (payee, amount, currency, category, invoice_date, status, payment_status)
         VALUES ($1, 100, 'USD', $2, '2099-01-15', 'approved', 'Paid') RETURNING id`,
        [`${label} ${TAG}`, CAT]);
      made.exp.push(r.id); return r.id;
    };
    const { rows: [inc] } = await pool.query(
      `INSERT INTO artist_income (artist_name, description, amount, income_type, income_date)
       VALUES ($1, $2, 500, 'Distribution', '2099-01-20') RETURNING id`,
      [`Artist ${TAG}`, `Income ${TAG}`]);
    made.inc.push(inc.id);

    // One row per disposition. Amounts are distinct powers-of-ten-ish so a
    // mis-bucketed row shows up in the money assertion as well as the count.
    const txn = async (o) => {
      const { rows: [r] } = await pool.query(
        `INSERT INTO bank_transactions
           (statement_id, txn_date, description, payee_guess, amount, direction, currency,
            matched_expense_id, matched_income_id, match_method, dismissed, no_invoice_expected)
         VALUES ($1, '2099-01-10', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [st.id, `${TAG} ${o.want}`, o.payee_guess || `Payee ${TAG}`, o.amount, o.direction || 'debit',
          o.currency || 'USD', o.expense || null, o.income || null, o.method || null,
          !!o.dismissed, !!o.noInvoice]);
      return { id: r.id, ...o };
    };

    const rows = [
      // Money out
      await txn({ want: 'matched', amount: 1000, expense: await expense('Matched'), method: 'auto-ref' }),
      await txn({ want: 'creator', amount: 200, expense: await expense('Creator'), method: 'creator' }),
      await txn({ want: 'no_invoice_due', amount: 30, expense: await expense('Fee'), method: 'created', noInvoice: true }),
      await txn({ want: 'needs_invoice', amount: 4000, expense: await expense('Booked'), method: 'created' }),
      await txn({ want: 'open', amount: 50000, expense: null }),
      // Booked, NOT row-flagged, and its entry's category is claimed by nobody
      // — only its bank descriptor is. The one row that can tell a query which
      // selects `payee_guess` from one that does not.
      await txn({ want: 'no_invoice_due', amount: 70, expense: await expense('Payroll'),
        method: 'created', payee_guess: DESCRIPTOR }),
      // Dismissed AND matched. This row is the whole reason the subtraction
      // below is wrong, and the reason `dismissed` is tested first.
      await txn({ want: 'excluded', amount: 600, expense: await expense('Dropped'), method: 'auto-ref', dismissed: true }),
      // Money in
      await txn({ want: 'booked', amount: 7000, direction: 'credit', income: inc.id }),
      await txn({ want: 'open', amount: 80, direction: 'credit' }),
      await txn({ want: 'excluded', amount: 9, direction: 'credit', dismissed: true }),
      // A foreign row with no amount_usd, to prove the money side goes through
      // the canonical converter rather than the column /statements/ COALESCEs.
      await txn({ want: 'open', amount: 100000, currency: 'JPY' }),
    ];

    // ── Bucketing, against the REAL predicate ────────────────────────────────
    const noInvoiceExpected = await statementsRouter.makeNoInvoiceExpected();
    // The columns the endpoint selects. makeNoInvoiceExpected reads FIVE of
    // them and a caller that omits one gets a wrong answer with no error, so
    // the fixture drives the real column list rather than a convenient one.
    const COLS = `bt.id, bt.statement_id, bt.direction, bt.dismissed, bt.match_method,
             bt.amount, COALESCE(bt.currency, 'USD') AS currency, bt.amount_usd,
             bt.payee_guess, bt.matched_expense_id, bt.matched_income_id,
             e.payee, e.category`;
    const readBack = async (cols) => (await pool.query(`
      SELECT ${cols}
        FROM bank_transactions bt
        LEFT JOIN expenses e ON e.id = bt.matched_expense_id
       WHERE bt.statement_id = $1`, [st.id])).rows;
    const live = await readBack(COLS);
    ok(live.length === rows.length, `${live.length} rows read back (expected ${rows.length})`);

    console.log('\n1. every row lands in the bucket it was built for');
    const wantOf = new Map(rows.map((r) => [r.id, r.want]));
    for (const r of live) {
      const got = bucketKey(r, noInvoiceExpected);
      const want = wantOf.get(r.id);
      ok(got === want, `${r.direction.padEnd(6)} ${money(r.amount)} ${r.currency} → ${got}${got === want ? '' : ` (wanted ${want})`}`);
    }

    console.log('\n1b. and the column list is why — the OLD select gets one wrong');
    // Prove the previous statement FAILS before trusting the new one. Without
    // payee_guess the descriptor rule cannot fire, so the payroll row reads as
    // a booked line still owing an invoice.
    const oldCols = COLS.replace('bt.payee_guess, ', '');
    const before = await readBack(oldCols);
    const payrollId = rows.find((r) => r.payee_guess === DESCRIPTOR).id;
    const wasWrong = bucketKey(before.find((r) => r.id === payrollId), noInvoiceExpected);
    const nowRight = bucketKey(live.find((r) => r.id === payrollId), noInvoiceExpected);
    ok(wasWrong === 'needs_invoice', `without payee_guess the rules-covered row reads "${wasWrong}"`);
    ok(nowRight === 'no_invoice_due', `with it, the vendor rule fires and it reads "${nowRight}"`);

    console.log('\n2. the buckets partition the statement');
    const blank = (keys) => Object.fromEntries(keys.map((k) => [k, { n: 0, value: 0 }]));
    const side = { debits: blank(DEBIT_BUCKETS), credits: blank(CREDIT_BUCKETS) };
    for (const r of live) {
      const s = r.direction === 'credit' ? side.credits : side.debits;
      const b = s[bucketKey(r, noInvoiceExpected)];
      b.n += 1;
      b.value += Math.abs(usdOf(r.amount, r.currency));
    }
    for (const [name, key] of [['money out', 'debits'], ['money in', 'credits']]) {
      const dir = key === 'credits' ? 'credit' : 'debit';
      const mine = live.filter((r) => r.direction === dir);
      const n = Object.values(side[key]).reduce((s, b) => s + b.n, 0);
      const v = Object.values(side[key]).reduce((s, b) => s + b.value, 0);
      const trueV = mine.reduce((s, r) => s + Math.abs(usdOf(r.amount, r.currency)), 0);
      ok(n === mine.length, `${name}: buckets sum to ${n} rows, the statement holds ${mine.length}`);
      // Cents, not exact floats — the sum is the same additions in a different
      // order, and this is the figure the page prints.
      ok(Math.round(v * 100) === Math.round(trueV * 100),
        `${name}: buckets sum to ${money(v)}, the statement holds ${money(trueV)}`);
    }

    console.log('\n3. money out goes through usdOf, not amount_usd');
    const viaConverter = live.filter((r) => r.direction === 'debit')
      .reduce((s, r) => s + Math.abs(usdOf(r.amount, r.currency)), 0);
    const viaColumn = live.filter((r) => r.direction === 'debit')
      .reduce((s, r) => s + Math.abs(Number(r.amount_usd ?? r.amount)), 0);
    const jpy = live.find((r) => r.currency === 'JPY');
    ok(jpy && jpy.amount_usd === null, 'the ¥100,000 row carries no amount_usd, as a parsed row does');
    console.log(`        converter ${money(viaConverter)}   COALESCE(amount_usd, amount) ${money(viaColumn)}`);
    // Only assertable when the rate cache is warm; a cold cache makes usdOf fall
    // back to face value and the two agree honestly. Reported either way.
    if (Math.round(viaConverter * 100) !== Math.round(viaColumn * 100)) {
      ok(viaConverter < viaColumn, `¥100,000 is ${money(viaColumn - viaConverter)} less in dollars than the column claims`);
    } else {
      console.log('SKIP  fx cache is cold — usdOf fell back to face value, so the two agree');
    }

    console.log('\n4. the formulas this replaces disagree, on these very rows');
    const d = side.debits;
    const sum = (keys) => keys.reduce((s, k) => s + d[k].n, 0);
    const accounted = sum(ACCOUNTED);
    const left = sum(LEFT);
    const debits = sum(DEBIT_BUCKETS);
    // /statements/months and /statements/ both compute it this way.
    const { rows: [oldRow] } = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE direction = 'debit')::int AS debits,
             COUNT(*) FILTER (WHERE direction = 'debit' AND matched_expense_id IS NOT NULL)::int AS matched,
             COUNT(*) FILTER (WHERE direction = 'debit' AND dismissed)::int AS dismissed,
             COUNT(*) FILTER (WHERE direction = 'debit' AND matched_expense_id IS NULL AND dismissed = false)::int AS open_debits
        FROM bank_transactions WHERE statement_id = $1`, [st.id]);
    const oldCoverage = Math.round(((oldRow.matched + oldRow.dismissed) / oldRow.debits) * 100);
    const newCoverage = Math.round((accounted / (accounted + left)) * 100);
    console.log(`        old bar: ${oldCoverage}%   new bar: ${newCoverage}%   (${accounted} accounted, ${left} left, ${debits - accounted - left} excluded)`);
    ok(oldCoverage > newCoverage,
      `the old bar overstates this statement by ${oldCoverage - newCoverage} points — booked counted as matched`);

    // BkStatements' "All transactions" strip: debits - matched - dismissed.
    const oldOpen = oldRow.debits - oldRow.matched - oldRow.dismissed;
    console.log(`        old open: ${oldOpen}   really left: ${left}`);
    ok(oldOpen < left,
      `the subtraction reports ${oldOpen} open against ${left} real — the dismissed-and-matched row is subtracted twice`);
    ok(oldRow.open_debits === d.open.n,
      `open_debits (${oldRow.open_debits}) still equals the open bucket (${d.open.n}) — the reconcile gate is unchanged`);
  } catch (err) {
    fail++; console.log(`FAIL  threw: ${err.message}`);
    console.log(err.stack);
  } finally {
    if (made.stmt.length) await pool.query(`DELETE FROM bank_transactions WHERE statement_id = ANY($1)`, [made.stmt]).catch(() => {});
    if (made.stmt.length) await pool.query(`DELETE FROM bank_statements WHERE id = ANY($1)`, [made.stmt]).catch(() => {});
    if (made.exp.length) await pool.query(`DELETE FROM expenses WHERE id = ANY($1)`, [made.exp]).catch(() => {});
    if (made.inc.length) await pool.query(`DELETE FROM artist_income WHERE id = ANY($1)`, [made.inc]).catch(() => {});
    if (made.rule) await pool.query(`DELETE FROM statement_no_invoice_rules WHERE id = $1`, [made.rule]).catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
