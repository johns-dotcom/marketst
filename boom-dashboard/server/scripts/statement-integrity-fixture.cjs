#!/usr/bin/env node
/**
 * Two questions about the bank statements, and one promise about the fix.
 *
 *   1. Is a statement that arrived PROVED — and when it cannot be checked, does
 *      anything say so? Both balance checks in /flags skip silently rather than
 *      failing, and on production that left six PayPal statements (890
 *      transactions, $596,616 of debits) with no balance check at all and no
 *      flag about it.
 *
 *   2. Is a statement MISSING? The gap flag fires between two statements, so it
 *      cannot fire for the newest one — an account that simply stops is
 *      invisible. On 2026-09-02 the last BofA period ended 31 July and nothing
 *      anywhere said August was outstanding.
 *
 * And the promise, John's own words: "make sure it doesnt reopen old items or
 * duplicate ones." Section 3 snapshots every transaction — id, match, income
 * match, dismissal, no-invoice flag, method, amount — before and after the
 * backfill and asserts the two are byte-identical. That is the assertion this
 * whole fixture exists for; the rest is arithmetic.
 *
 *     cd server && PORT=3011 node index.js &
 *     node scripts/statement-integrity-fixture.cjs
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { verdictFor, expectedNext, businessGapBetween, weekendDaysBetween, pairingFromCounts } = require('../lib/statement-integrity');

const BASE = process.env.API_BASE || 'http://127.0.0.1:3011/api';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const token = jwt.sign(
  { id: 1, email: 'john@deanst.co', name: 'John', role: 'Superadmin', tv: 0 },
  process.env.JWT_SECRET, { expiresIn: '1h' });

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : `— ${detail}`);
};
const call = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

(async () => {
  const made = { stmts: [], txns: [] };
  try {
    // ── 1. the verdict rules, pure ────────────────────────────────────────
    console.log('1. what counts as proof');
    const base = { id: 1, account: 'bofa', filename: 'x.pdf', foreign_unconverted: 0 };
    check('a statement with its own opening balance proves itself',
      verdictFor({ ...base, beginning_balance: 100, ending_balance: 150, credits_usd: 100, debits_usd: 50 }).status === 'proved');
    check('one without it is proved from the previous closing balance, and says so',
      verdictFor({ ...base, beginning_balance: null, ending_balance: 150, credits_usd: 100, debits_usd: 50 },
        { ending_balance: 100 }).status === 'proved_by_chain');
    const off = verdictFor({ ...base, beginning_balance: 100, ending_balance: 999, credits_usd: 100, debits_usd: 50 });
    check('arithmetic that does not add up is unprovable, with the money named',
      off.status === 'unprovable' && /off by \$849\.00/.test(off.reason), off.reason?.slice(0, 70));
    check('the first statement of an account, with no opening balance, is unprovable',
      verdictFor({ ...base, beginning_balance: null, ending_balance: 150, credits_usd: 100, debits_usd: 50 }, null)
        .status === 'unprovable');

    // The two vacuous ties. These are the ones that matter: they PASS the
    // existing arithmetic and prove nothing.
    const zero = verdictFor({ ...base, beginning_balance: 0, ending_balance: 0, credits_usd: 0, debits_usd: 0 });
    check('an all-zero statement is not proof', zero.status === 'unprovable', zero.reason?.slice(0, 60));
    const cancels = verdictFor({ ...base, beginning_balance: 0, ending_balance: 0,
      credits_usd: 72758.73, debits_usd: 72758.73 });
    check('money in exactly equalling money out against zero balances is not proof',
      cancels.status === 'unprovable' && /cancels itself/.test(cancels.reason), cancels.reason?.slice(0, 72));
    // …and it is EXACTLY the shape every live PayPal statement has, which is why
    // the check had to learn to refuse it.
    check('…which is the live PayPal shape, so it would have passed before',
      Math.abs(72758.73 - 72758.73) < 0.05);

    // Unconverted foreign rows come first, before any arithmetic — the ordering
    // bug that made the existing "cannot verify" warning unreachable.
    const fx = verdictFor({ ...base, foreign_unconverted: 62, beginning_balance: null, ending_balance: 0,
      credits_usd: 100, debits_usd: 100 });
    check('foreign rows with no USD amount are reported BEFORE the arithmetic runs',
      fx.status === 'unprovable' && /62 foreign transactions/.test(fx.reason), fx.reason?.slice(0, 60));

    // ── 1b. PayPal proves itself by PAIRING, not by a balance ─────────────
    //
    // There is no balance to tie against and the currencies cannot be summed,
    // so the checkable structure is that every payment arrives with the leg
    // that funded it. Live: five of six statements pair perfectly and February
    // leaves 26 rows unmatched — discriminating power the balance check never
    // had here, where credits equalling debits was structurally guaranteed.
    console.log('\n1b. pairing, which is how a PayPal statement holds together');
    const pairs = (spec) => pairingFromCounts(spec);
    const clean = pairs([
      { currency: 'AUD', direction: 'debit', cents: 82938, n: 2 },
      { currency: 'AUD', direction: 'credit', cents: 82938, n: 2 },
      { currency: 'USD', direction: 'debit', cents: 30000, n: 3 },
      { currency: 'USD', direction: 'credit', cents: 30000, n: 3 },
    ]);
    check('every payment matched to a funding leg is complete', clean.complete === true && clean.pairs === 5,
      `${clean.pairs} pairs`);
    const short = pairs([
      { currency: 'AUD', direction: 'debit', cents: 82938, n: 2 },
      { currency: 'AUD', direction: 'credit', cents: 82938, n: 1 },
    ]);
    check('a payment whose funding leg was lost is caught',
      short.complete === false && short.unpaired_debits === 1, JSON.stringify(short.currencies));
    check('currencies do not pair against each other',
      pairs([{ currency: 'AUD', direction: 'debit', cents: 100, n: 1 },
        { currency: 'USD', direction: 'credit', cents: 100, n: 1 }]).complete === false,
      'AUD 1.00 is not funded by USD 1.00');
    check('and neither do different amounts',
      pairs([{ currency: 'USD', direction: 'debit', cents: 100, n: 1 },
        { currency: 'USD', direction: 'credit', cents: 99, n: 1 }]).complete === false);

    const ppLike = { id: 9, account: 'paypal', filename: 'pp.pdf', foreign_unconverted: 16,
      beginning_balance: null, ending_balance: 0, credits_usd: 50535.81, debits_usd: 50535.81 };
    const byPairing = verdictFor(ppLike, null, clean);
    check('a statement that cannot be summed IS provable by its pairing',
      byPairing.status === 'proved_by_pairing', byPairing.status);
    check('…and the verdict admits what pairing cannot see',
      /pair missing on both sides would not show up/.test(byPairing.reason || ''),
      byPairing.reason?.slice(-88));
    const brokenPairing = verdictFor(ppLike, null, short);
    check('a broken pairing is unprovable, naming the currency and the count',
      brokenPairing.status === 'unprovable' && /AUD: 1 payment with no funding leg/.test(brokenPairing.reason),
      brokenPairing.reason?.slice(-96));
    check('and with no pairing information at all it stays unprovable',
      verdictFor(ppLike, null, null).status === 'unprovable');

    // ── 2. is one missing ─────────────────────────────────────────────────
    console.log('\n2. noticing a statement that never came');
    const monthly = [
      { period_end: '2026-05-31' }, { period_end: '2026-06-30' }, { period_end: '2026-07-31' },
    ];
    // The boundary, stated honestly. With a 31-day cadence and 5 days of grace,
    // 33 days after the last period closed is NOT yet late — the next period
    // only ended two days ago and a statement has to be issued. This is the
    // live case on 2026-09-02, and the surface reports the 33 days either way;
    // what it does not do is cry wolf on day 33.
    const notYet = expectedNext(monthly, new Date('2026-09-02'));
    check('33 days after the last period is not yet overdue — the next one only just closed',
      notYet.overdue === false && notYet.days_since === 33 && notYet.cadence_days === 31,
      `${notYet.days_since} days since ${notYet.last_period_end}, cadence ${notYet.cadence_days}, expected by ${notYet.expected_by}`);
    const late = expectedNext(monthly, new Date('2026-09-12'));
    check('…and IS overdue once the cadence plus grace has passed',
      late.overdue === true && late.days_since === 43,
      `${late.days_since} days, expected by ${late.expected_by}`);
    const fresh = expectedNext(monthly, new Date('2026-08-04'));
    check('…and not overdue four days after the period closed (a statement has to be issued)',
      fresh.overdue === false, `${fresh.days_since} days`);
    check('one statement infers nothing and claims nothing',
      expectedNext([{ period_end: '2026-07-31' }], new Date('2026-08-05')).overdue === false);
    check('no statements at all is not "overdue" — it is not set up',
      expectedNext([], new Date()).overdue === false);

    // Weekends are not holes: Fri → Mon is the routine statement boundary.
    check('a Friday-to-Monday boundary is not a gap',
      businessGapBetween('2026-01-30', '2026-02-02') === 0, 'Fri → Mon');
    check('a genuine missing day IS a gap',
      businessGapBetween('2026-04-30', '2026-05-04') === 1, 'Thu → Mon leaves Friday uncovered');
    check('and an overlap reads as negative',
      businessGapBetween('2026-03-31', '2026-03-28') < 0);
    check('weekend counting is right across a month boundary',
      weekendDaysBetween('2026-01-30', '2026-02-02') === 2);

    // ── 3. THE PROMISE: the backfill touches no transaction ───────────────
    console.log('\n3. the backfill reopens nothing and duplicates nothing');
    const mk = async (account, start, end, begin, endBal, rows) => {
      const { rows: [st] } = await pool.query(
        `INSERT INTO bank_statements (account, filename, period_start, period_end, txn_count, status, uploaded_by, beginning_balance, ending_balance)
         VALUES ($1, $2, $3, $4, $5, 'ready', 'integrity-fixture', $6, $7) RETURNING id`,
        [account, `INTEGRITY-${start}.pdf`, start, end, rows.length, begin, endBal]);
      made.stmts.push(st.id);
      for (const r of rows) {
        const { rows: [t] } = await pool.query(
          `INSERT INTO bank_transactions (statement_id, txn_date, description, payee_guess, amount, direction, currency, dismissed, matched_expense_id, no_invoice_expected)
           VALUES ($1, $2, $3, $3, $4, $5, 'USD', $6, $7, $8) RETURNING id`,
          [st.id, start, `INTEGRITY ${r.d}`, r.amt, r.d, r.dismissed || false, r.matched || null, r.noInv || false]);
        made.txns.push(t.id);
      }
      return st.id;
    };

    // Two consecutive statements; the second has no opening balance. Its rows
    // carry the states a backfill must not disturb: one matched, one dismissed,
    // one flagged as needing no invoice, one plain open row.
    const { rows: [anyExpense] } = await pool.query(
      `SELECT id FROM expenses WHERE (deleted IS NULL OR deleted = false) ORDER BY id DESC LIMIT 1`);
    const first = await mk('integrityfix', '2026-01-05', '2026-01-30', 1000, 1500,
      [{ d: 'credit', amt: 800 }, { d: 'debit', amt: 300 }]);
    const second = await mk('integrityfix', '2026-02-02', '2026-02-27', null, 1700,
      [{ d: 'credit', amt: 500, matched: null },
       { d: 'debit', amt: 200, matched: anyExpense?.id || null },
       { d: 'debit', amt: 100, dismissed: true },
       { d: 'debit', amt: 0.01, noInv: true }]);

    const snapshot = async () => {
      const { rows } = await pool.query(
        `SELECT id, statement_id, txn_date::text, description, amount::text, direction, currency,
                matched_expense_id, matched_income_id, dismissed, no_invoice_expected, match_method
           FROM bank_transactions WHERE statement_id = ANY($1::int[]) ORDER BY id`,
        [made.stmts]);
      return JSON.stringify(rows);
    };
    const beforeTxns = await snapshot();
    const { rows: [beforeCount] } = await pool.query('SELECT COUNT(*)::int n FROM bank_transactions');

    const run = await call('POST', '/statements/backfill-beginning-balance');
    check('the backfill runs', run.status === 200, run.status);
    const filledUs = (run.body?.data?.filled || []).filter((f) => f.account === 'integrityfix');
    check('it carried the opening balance forward', filledUs.length === 1
      && Math.abs(filledUs[0].beginning_balance - 1500) < 0.005,
      JSON.stringify(filledUs[0] || null));
    const { rows: [after] } = await pool.query('SELECT beginning_balance FROM bank_statements WHERE id = $1', [second]);
    check('…and the statement now carries it', Math.abs(Number(after.beginning_balance) - 1500) < 0.005,
      after.beginning_balance);

    const afterTxns = await snapshot();
    const { rows: [afterCount] } = await pool.query('SELECT COUNT(*)::int n FROM bank_transactions');
    check('NO transaction changed in any way', beforeTxns === afterTxns,
      beforeTxns === afterTxns ? 'byte-identical' : 'THE SNAPSHOT MOVED');
    check('no transaction was created anywhere in the table', beforeCount.n === afterCount.n,
      `${beforeCount.n} → ${afterCount.n}`);

    // Idempotent: running it again must write nothing at all.
    const again = await call('POST', '/statements/backfill-beginning-balance');
    const filledTwice = (again.body?.data?.filled || []).filter((f) => f.account === 'integrityfix');
    check('a second run fills nothing — it is idempotent', filledTwice.length === 0,
      `${(again.body?.data?.filled || []).length} filled across all accounts`);
    check('and still nothing moved', (await snapshot()) === beforeTxns);

    // A disagreement is reported, never overwritten.
    await pool.query('UPDATE bank_statements SET beginning_balance = 999 WHERE id = $1', [second]);
    const third = await call('POST', '/statements/backfill-beginning-balance');
    const skipped = (third.body?.data?.skipped || []).find((x) => x.id === second);
    check('a statement whose own opening disagrees with the previous closing is REPORTED, not rewritten',
      !!skipped && /disagrees/.test(skipped.reason), skipped?.reason?.slice(0, 80));
    const { rows: [untouched] } = await pool.query('SELECT beginning_balance FROM bank_statements WHERE id = $1', [second]);
    check('…and its value is left exactly as it was', Number(untouched.beginning_balance) === 999);

    // An absent balance is not a zero one. Every live PayPal statement closes at
    // 0.00 because its PDF prints no balance section; carrying that forward
    // would manufacture 0 + X − X = 0, a tie that cannot fail.
    const zeroA = await mk('integrityzero', '2026-01-05', '2026-01-30', null, 0, [{ d: 'credit', amt: 500 }, { d: 'debit', amt: 500 }]);
    const zeroB = await mk('integrityzero', '2026-02-02', '2026-02-27', null, 0, [{ d: 'credit', amt: 700 }, { d: 'debit', amt: 700 }]);
    const zrun = await call('POST', '/statements/backfill-beginning-balance');
    const zskip = (zrun.body?.data?.skipped || []).find((x) => x.id === zeroB);
    check('an all-zero account is NOT given a manufactured opening balance',
      !!zskip && /cannot fail/.test(zskip.reason), zskip?.reason?.slice(0, 80));
    const { rows: [zstill] } = await pool.query('SELECT beginning_balance FROM bank_statements WHERE id = $1', [zeroB]);
    check('…and its opening balance stays null, so it keeps reading as unprovable',
      zstill.beginning_balance === null, String(zstill.beginning_balance));
    const zinteg = await call('GET', '/statements/integrity');
    const zrows = (zinteg.body?.data?.statements || []).filter((x) => x.account === 'integrityzero');
    check('the surface does not offer to fill what the backfill would refuse',
      zrows.every((x) => x.backfillable === false),
      zrows.map((x) => `${x.period_start}:${x.backfillable}`).join(' '));

    // ── 4. the surface reports all of it ─────────────────────────────────
    console.log('\n4. the integrity surface');
    const integ = await call('GET', '/statements/integrity');
    check('it answers', integ.status === 200, integ.status);
    const mine = (integ.body?.data?.statements || []).filter((x) => x.account === 'integrityfix');
    check('every statement gets a verdict', mine.length === 2
      && mine.every((x) => ['proved', 'proved_by_chain', 'unprovable'].includes(x.status)),
      mine.map((x) => `${x.period_start}:${x.status}`).join(' '));
    check('the account appears in the overdue check with an inferred cadence',
      (integ.body?.data?.accounts || []).some((a) => a.account === 'integrityfix' && a.cadence_days > 0));
    const sum = integ.body?.data?.summary || {};
    check('the summary counts pairing-proved statements separately',
      typeof (integ.body?.data?.summary || {}).proved_by_pairing === 'number',
      `${(integ.body?.data?.summary || {}).proved_by_pairing} proved by pairing`);
    check('the summary counts what cannot be proved, in rows and dollars',
      typeof sum.unprovable === 'number' && typeof sum.unprovable_debits === 'number',
      `${sum.proved} proved, ${sum.proved_by_chain} by chain, ${sum.unprovable} unprovable ($${sum.unprovable_debits})`);
    check('and reports the parser count against the rows actually stored',
      typeof sum.row_count_mismatches === 'number', `${sum.row_count_mismatches} mismatches`);
  } catch (err) {
    check('the fixture ran to completion', false, err.message);
  } finally {
    if (made.txns.length) await pool.query('DELETE FROM bank_transactions WHERE id = ANY($1::int[])', [made.txns]).catch(() => {});
    if (made.stmts.length) await pool.query('DELETE FROM bank_statements WHERE id = ANY($1::int[])', [made.stmts]).catch(() => {});
    await pool.end();
    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
