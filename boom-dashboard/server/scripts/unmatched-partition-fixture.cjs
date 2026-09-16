/**
 * The three reasons a paid row has no bank line must PARTITION.
 *
 * Every paid, unmatched row belongs to exactly one of:
 *   discrepancy  a statement covers the date and the money isn't on it
 *   awaiting     dated past the newest statement — nothing is wrong yet
 *   missing      inside the covered span, in a month nobody uploaded
 *
 * A row in none of them is work no queue shows. A row in two is work counted
 * twice. This repo has shipped a band and its list disagreeing more than once,
 * so the partition is asserted rather than reasoned about.
 *
 * ── Dates are DERIVED, never hard-coded ──
 * The first version of this fixture hard-coded April as "after the newest
 * statement" and failed. The predicate was right: the dev database already held
 * BofA statements for March, June and July from earlier fixtures, so April is
 * inside that span and is genuinely a missing month. A fixture that assumes an
 * empty world fails the more dangerous way round — it accuses correct code.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');
const {
  noBankEvidenceSql, paidUnmatchedSql, awaitingStatementSql, missingStatementSql,
} = require('../lib/bank-evidence');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'PT' + (process.pid % 10000);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };

(async () => {
  const made = { exp: [], stmt: [] };
  const stmt = async (acct, s, e) => {
    const { rows: [r] } = await pool.query(
      `INSERT INTO bank_statements (filename, account, period_start, period_end, status, created_at)
       VALUES ($1,$2,$3,$4,'ready',NOW()) RETURNING id`, [`${TAG}-${acct}-${s}.pdf`, acct, s, e]);
    made.stmt.push(r.id); return r.id;
  };
  const exp = async (date, method) => {
    const { rows: [r] } = await pool.query(
      `INSERT INTO expenses (payee, amount, currency, category, invoice_date, status,
         payment_status, payment_date, payment_method)
       VALUES ($1, 100,'USD','Services',$2,'approved','Paid',$2,$3) RETURNING id`,
      [`Part ${TAG}`, date, method]);
    made.exp.push(r.id); return r.id;
  };
  const state = async (id) => {
    const { rows: [r] } = await pool.query(
      `SELECT ${noBankEvidenceSql('e')} AS discrepancy,
              ${awaitingStatementSql('e')} AS awaiting,
              ${missingStatementSql('e')} AS missing,
              ${paidUnmatchedSql('e')} AS unmatched
         FROM expenses e WHERE e.id = $1`, [id]);
    return r;
  };
  const day = (base, n) => {
    const x = new Date(base); x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };

  try {
    const { rows: [pre] } = await pool.query(`
      SELECT MAX(period_end) FILTER (WHERE account <> 'paypal') AS bofa
        FROM bank_statements WHERE status = 'ready' AND period_end IS NOT NULL`);
    const base = pre.bofa ? new Date(pre.bofa) : new Date('2026-01-01T00:00:00Z');
    console.log(`        existing non-PayPal coverage ends ${base.toISOString().slice(0, 10)}`);

    // A period well beyond everything that already exists, so "after the newest"
    // cannot be moved by leftover data. Its own month is covered; the months
    // BETWEEN the old coverage and it are not.
    const FS = day(base, 60), FE = day(base, 89);
    await stmt('bofa', FS, FE);
    console.log(`        fixture period ${FS} → ${FE} is now the newest\n`);

    console.log('1. every paid unmatched row lands in exactly ONE state');
    for (const [date, want, why] of [
      [day(base, 70), 'discrepancy', 'inside the fixture period'],
      [FE,            'discrepancy', 'last day of a covered period'],
      [day(new Date(FE + 'T00:00:00Z'), 2), 'discrepancy', 'inside the 3-day settle skirt'],
      [day(new Date(FE + 'T00:00:00Z'), 5), 'awaiting',    'past the skirt, past everything'],
      [day(base, 30), 'missing',     'between old coverage and the fixture period'],
    ]) {
      const r = await state(await exp(date, null));
      const on = ['discrepancy', 'awaiting', 'missing'].filter((k) => r[k]);
      ok(on.length === 1 && on[0] === want,
         `${date}  ${why.padEnd(40)} → ${on.join('+') || 'NONE'} (want ${want})`);
    }

    console.log('\n2. each account is judged on its OWN coverage');
    // A PayPal payment must not be called a discrepancy because BofA happens to
    // hold a statement for that month — the two are separate ledgers of fact.
    const ppDate = day(base, 70);
    const pp = await exp(ppDate, 'PayPal');
    const before = await state(pp);
    ok(before.discrepancy === false,
       `a PayPal payment inside a BOFA period is not a discrepancy (${JSON.stringify({ d: before.discrepancy, a: before.awaiting, m: before.missing })})`);
    await stmt('paypal', FS, FE);
    const after = await state(pp);
    ok(after.discrepancy === true && after.awaiting === false && after.missing === false,
       'and becomes one the moment the PayPal statement for that period is uploaded');

    console.log('\n3. an UNPAID row is in none of them');
    const { rows: [u] } = await pool.query(
      `INSERT INTO expenses (payee, amount, currency, category, invoice_date, status, payment_status)
       VALUES ($1,100,'USD','Services',$2,'approved','Unpaid') RETURNING id`, [`Unpaid ${TAG}`, day(base, 70)]);
    made.exp.push(u.id);
    const ru = await state(u.id);
    ok(!ru.unmatched && !ru.discrepancy && !ru.awaiting && !ru.missing,
       'unpaid rows are not in the queue at all');

    console.log('\n4. the partition holds over the WHOLE ledger, not just fixtures');
    const { rows: [t] } = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE ${paidUnmatchedSql('e')})::int AS unmatched,
             COUNT(*) FILTER (WHERE ${noBankEvidenceSql('e')})::int AS discrepancy,
             COUNT(*) FILTER (WHERE ${awaitingStatementSql('e')})::int AS awaiting,
             COUNT(*) FILTER (WHERE ${missingStatementSql('e')})::int AS missing,
             COUNT(*) FILTER (WHERE ${noBankEvidenceSql('e')} AND ${awaitingStatementSql('e')})::int AS ov_da,
             COUNT(*) FILTER (WHERE ${noBankEvidenceSql('e')} AND ${missingStatementSql('e')})::int AS ov_dm,
             COUNT(*) FILTER (WHERE ${awaitingStatementSql('e')} AND ${missingStatementSql('e')})::int AS ov_am
        FROM expenses e
       WHERE (e.deleted IS NULL OR e.deleted = FALSE)
         AND (e.voided IS NULL OR e.voided = FALSE)`);
    console.log(`        unmatched ${t.unmatched} = discrepancy ${t.discrepancy} + awaiting ${t.awaiting} + missing ${t.missing}`);
    ok(t.unmatched > 0, `the set is non-empty (${t.unmatched}) — an empty one would satisfy the sum vacuously`);
    ok(t.discrepancy + t.awaiting + t.missing === t.unmatched,
       `the three sum to the whole set (${t.discrepancy}+${t.awaiting}+${t.missing} = ${t.unmatched})`);
    ok(t.ov_da === 0 && t.ov_dm === 0 && t.ov_am === 0,
       `and no row is in two of them (${t.ov_da}/${t.ov_dm}/${t.ov_am})`);
    ok(t.awaiting > 0 && t.missing > 0 && t.discrepancy > 0,
       'all three states are populated, so the sum is not carried by one of them');
  } finally {
    for (const id of made.exp) await pool.query('DELETE FROM expenses WHERE id=$1', [id]).catch(() => {});
    for (const id of made.stmt) await pool.query('DELETE FROM bank_statements WHERE id=$1', [id]).catch(() => {});
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
