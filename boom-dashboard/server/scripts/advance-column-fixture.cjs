/**
 * Advances as their own column on Spend by Artist.
 *
 * An advance is below the line — recoupable money, not trading spend — so it is
 * outside `expenseTotals` and outside `by_artist` by design. It is also the
 * largest artist-attributable outflow the label makes ($1,482,835 Jan–Jul 2026),
 * and the report about artist spend showed none of it. This adds a column
 * BESIDE spend rather than folding it in, and these are the properties that has
 * to hold:
 *
 *   1. Operating spend does not move. `by_artist.total` still equals the P&L
 *      expense total and `ties_to_pnl` stays true — the invariant the whole
 *      report rests on. Adding a rollup must be additive, not a reclassification.
 *   2. The advance column and the rest of the below-line section ADD UP to the
 *      below-line expense total. Nothing may sit in neither.
 *   3. Every cell equals its own drill. An Advances cell that opens rows summing
 *      to something else is worse than no drill; that is this file's oldest rule.
 *   4. An artist's row-total drill still EXCLUDES advances, or the Spend column
 *      stops matching what it opens.
 *   5. An artist with an advance and NO operating spend appears at all.
 *   6. A refund of an advance REDUCES that artist's advances, because the P&L
 *      reports the line net ($1,482,835 net against $1,505,835 gross).
 *   7. `total_out` = spend + advances, per row and in total.
 *
 * Dev database, over the dev server on :3011.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');
const http = require('http');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'AV' + (process.pid % 100000);
const MONTH = '2033-03';
const FROM = `${MONTH}-01`, TO = `${MONTH}-31`;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const cents = (n) => Math.round(Number(n || 0) * 100);

function req(method, path, body, token) {
  return new Promise((res, rej) => {
    const d = body ? JSON.stringify(body) : null;
    const r = http.request('http://localhost:3011' + path, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {},
        d ? { 'Content-Length': Buffer.byteLength(d) } : {}),
    }, (x) => { let s = ''; x.on('data', (c) => (s += c)); x.on('end', () => { try { res({ code: x.statusCode, j: JSON.parse(s) }) } catch { res({ code: x.statusCode, j: s.slice(0, 300) }) } }) });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}

(async () => {
  const made = { exp: [], stmt: [], txn: [], inc: [] };
  const ART_A = `Adv Artist A ${TAG}`;      // advance + operating spend
  const ART_B = `Adv Artist B ${TAG}`;      // advance ONLY
  try {
    const L = await req('POST', '/api/auth/login',
      { email: 'john@deanst.co', password: process.env.PW_JOHN });
    const token = L.j?.data?.token;
    if (!token) { console.error('login failed'); process.exit(1); }
    console.log('logged in against the DEV database\n');

    const { rows: [st] } = await pool.query(`
      INSERT INTO bank_statements (filename, account, period_start, period_end, status, created_at)
      VALUES ($1,'bofa',$2,$3,'ready',NOW()) RETURNING id`, [`${TAG}.pdf`, FROM, TO]);
    made.stmt.push(st.id);

    const spend = async (artist, category, amount, day) => {
      const d = `${MONTH}-${String(day).padStart(2, '0')}`;
      const { rows: [e] } = await pool.query(`
        INSERT INTO expenses (payee, artist, amount, currency, category, invoice_date, status,
          payment_status, payment_date, entry_source)
        VALUES ($1,$2,$3,'USD',$4,$5,'approved','Paid',$5,'bank_statement') RETURNING id`,
        [`Payee ${TAG}`, artist, amount, category, d]);
      made.exp.push(e.id);
      const { rows: [t] } = await pool.query(`
        INSERT INTO bank_transactions (statement_id, txn_date, description, amount, direction,
          currency, payee_guess, matched_expense_id, match_method, dismissed)
        VALUES ($1,$2,$3,$4,'debit','USD',$5,$6,'created',FALSE) RETURNING id`,
        [st.id, d, `DEBIT ${TAG} ${category}`, amount, `Payee ${TAG}`, e.id]);
      made.txn.push(t.id);
      return e.id;
    };

    // A: $1,000 of Marketing (operating) + $10,000 of Advance (below the line)
    await spend(ART_A, 'Marketing', 1000.00, 5);
    await spend(ART_A, 'Advance', 10000.00, 6);
    // B: an advance and NOTHING else — the row that keying off operating spend drops
    await spend(ART_B, 'Advance', 7500.00, 7);
    // Nobody's advance
    await spend(null, 'Advance', 2500.00, 8);
    // Something else below the line, to prove the column does not swallow it
    await spend(ART_A, 'Reimbursements', 400.00, 9);

    const SB = async () => (await req('GET',
      `/api/reports/spend-by-artist?from=${FROM}&to=${TO}`, null, token)).j.data;
    const PNL = async () => (await req('GET',
      `/api/reports/pnl?from=${FROM}&to=${TO}`, null, token)).j.data;
    // `total` is the drill's OWN figure and the one the client shows against the
    // cell. Do not re-sum `rows`: the drill deliberately lifts recoveries out of
    // that list and reports them under `recoveries`, because a deposit listed
    // among payments reads as money going out. Summing `rows` made this fixture
    // accuse correct code of a $1,500 discrepancy that was only ever in the test.
    const drill = async (q) => {
      const r = await req('GET', `/api/reports/pnl/detail?${q}&from=${FROM}&to=${TO}`, null, token);
      const d = r.j.data || {};
      const rows = d.rows || [];
      return {
        n: rows.length,
        usd: Number(d.total || 0),
        rowsUsd: rows.reduce((s, x) => s + Number(x.usd || 0), 0),
        rec: Number(d.recoveries?.total || 0),
        recN: d.recoveries?.count || 0,
      };
    };

    const d = await SB();
    const p = await PNL();
    const rowA = (d.artists || []).find((a) => (a.spellings || []).includes(ART_A));
    const rowB = (d.artists || []).find((a) => (a.spellings || []).includes(ART_B));

    console.log('1. operating spend does not move');
    ok(d.ties_to_pnl === true, `ties_to_pnl is still true`);
    ok(cents(d.total) === cents(p.expense_totals.total),
      `by_artist.total ${d.total} === P&L expense total ${p.expense_totals.total}`);
    ok(!!rowA && cents(rowA.total) === cents(1000),
      `artist A's SPEND is the operating 1000.00 only (${rowA ? rowA.total : 'ABSENT'})`);
    ok(cents(d.total) === cents(1000),
      `and the whole report's spend is 1000.00 — the advances are NOT in it (${d.total})`);

    console.log('\n2. the below-line section is fully accounted for');
    const below = cents(p.below.expense_totals.total);
    ok(cents(d.advances.total) + cents(d.advances.other_total) === below,
      `advances ${d.advances.total} + other ${d.advances.other_total} = below-line ${p.below.expense_totals.total}`);
    ok(cents(d.advances.other_total) === cents(400),
      `Reimbursements stayed OUT of the advance column (${d.advances.other_total})`);
    ok(cents(d.advances.total) === cents(20000),
      `advances total 20000.00 (${d.advances.total})`);
    ok(cents(d.advances.unattributed) === cents(2500),
      `the advance naming nobody is on the unattributed row (${d.advances.unattributed})`);

    console.log('\n3. an advance-only artist still appears');
    ok(!!rowB, `artist B is listed (advance ${rowB ? rowB.advances : 'ABSENT'})`);
    ok(!!rowB && cents(rowB.total) === 0 && cents(rowB.advances) === cents(7500),
      'with zero spend and a 7500.00 advance');
    ok(!!rowB && cents(rowB.total_out) === cents(7500), 'and total_out equal to the advance');

    console.log('\n4. total_out is spend + advances');
    ok(!!rowA && cents(rowA.total_out) === cents(11000), `artist A total_out 11000.00 (${rowA.total_out})`);
    ok(cents(d.total_out) === cents(d.total) + cents(d.advances.total),
      `report total_out ${d.total_out} = ${d.total} + ${d.advances.total}`);

    console.log('\n5. every cell equals its own drill');
    const dAdvA = await drill(`kind=artist&key=${encodeURIComponent(rowA.key)}&category=Advance`);
    ok(cents(dAdvA.usd) === cents(rowA.advances),
      `artist A Advances cell ${rowA.advances} === its drill ${dAdvA.usd} over ${dAdvA.n} rows`);
    const dTotA = await drill(`kind=artist&key=${encodeURIComponent(rowA.key)}`);
    ok(cents(dTotA.usd) === cents(rowA.total),
      `artist A SPEND cell ${rowA.total} === its drill ${dTotA.usd} — advances excluded, as the column says`);
    const dAdvB = await drill(`kind=artist&key=${encodeURIComponent(rowB.key)}&category=Advance`);
    ok(cents(dAdvB.usd) === cents(rowB.advances),
      `artist B Advances cell ${rowB.advances} === its drill ${dAdvB.usd}`);
    const dUnAdv = await drill('kind=artist&key=&category=Advance');
    ok(cents(dUnAdv.usd) === cents(d.advances.unattributed),
      `the unattributed Advances cell ${d.advances.unattributed} === its drill ${dUnAdv.usd}`);

    console.log('\n6. a refund of an advance reduces that artist, net');
    // Booked as income of a contra type that reverses an advance, the way the P&L
    // already nets one — see contraOf in reports.js.
    // The column is `contra_of` (reports.js reportSections). The first version of
    // this fixture queried a `contra_category` that does not exist, the .catch()
    // swallowed the error, and the whole section reported SKIP — a vacuous pass
    // dressed as a limitation. If no mapping exists, make one, so the branch is
    // always exercised rather than explained away.
    let { rows: [cls] } = await pool.query(
      `SELECT name FROM bk_categories WHERE kind='income' AND contra_of = 'Advance' LIMIT 1`);
    let madeCls = null;
    if (!cls) {
      const nm = `Advance Refund ${TAG}`;
      await pool.query(
        `INSERT INTO bk_categories (kind, name, report_section, contra_of, section_set)
         VALUES ('income',$1,'below_line','Advance',TRUE)`, [nm]);
      madeCls = nm;
      cls = { name: nm };
      console.log(`      (seeded income type "${nm}" mapped as a contra of Advance)`);
    }
    {
      const day = `${MONTH}-20`;
      const { rows: [ai] } = await pool.query(`
        INSERT INTO artist_income (artist_name, income_type, amount, income_date, description)
        VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [ART_A, cls.name, 1500, day, `Refund ${TAG}`]);
      made.inc.push(ai.id);
      const { rows: [t] } = await pool.query(`
        INSERT INTO bank_transactions (statement_id, txn_date, description, amount, direction,
          currency, payee_guess, matched_income_id, dismissed)
        VALUES ($1,$2,$3,$4,'credit','USD',$5,$6,FALSE) RETURNING id`,
        [st.id, day, `CREDIT ${TAG} refund`, 1500, ART_A, ai.id]);
      made.txn.push(t.id);
      const d2 = await SB();
      const rowA2 = (d2.artists || []).find((a) => a.key === rowA.key);
      ok(cents(d2.advances.total) === cents(20000 - 1500),
        `the refund nets off the advance total (${d2.advances.total})`);
      const p2 = await PNL();
      ok(cents(d2.advances.total) + cents(d2.advances.other_total) === cents(p2.below.expense_totals.total),
        'and the section still adds up after the refund');
      const dAdvA2 = await drill(`kind=artist&key=${encodeURIComponent(rowA.key)}&category=Advance`);
      ok(cents(dAdvA2.usd) === cents(rowA2.advances),
        `the cell still equals its drill with a recovery in it (${rowA2.advances} vs ${dAdvA2.usd})`);
      // And the refund is DISCLOSED rather than just netted away, which is the
      // property that makes the netting readable.
      ok(dAdvA2.recN === 1 && cents(dAdvA2.rec) === cents(-1500),
        `the refund is listed separately as a recovery (${dAdvA2.recN} row, ${dAdvA2.rec})`);
      ok(cents(dAdvA2.rowsUsd) === cents(10000),
        `the payment rows still show the gross 10000.00 (${dAdvA2.rowsUsd}) — gross list, net total, both stated`);
    }

    console.log('\n7. the export carries the columns');
    const X = await req('GET', `/api/reports/spend-by-artist/export?from=${FROM}&to=${TO}`, null, token);
    ok(X.code === 200, `export builds (${X.code})`);
  } catch (err) {
    console.error('\nFIXTURE ERROR:', err.message);
    fail += 1;
  } finally {
    await pool.query('DELETE FROM bank_transactions WHERE statement_id = ANY($1::int[])', [made.stmt]).catch(() => {});
    await pool.query('DELETE FROM expenses WHERE parent_id = ANY($1::int[])', [made.exp]).catch(() => {});
    await pool.query('DELETE FROM expenses WHERE id = ANY($1::int[])', [made.exp]).catch(() => {});
    await pool.query('DELETE FROM artist_income WHERE id = ANY($1::int[])', [made.inc]).catch(() => {});
    await pool.query("DELETE FROM bk_categories WHERE kind='income' AND name LIKE $1", [`Advance Refund AV%`]).catch(() => {});
    await pool.query('DELETE FROM bank_statements WHERE id = ANY($1::int[])', [made.stmt]).catch(() => {});
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
