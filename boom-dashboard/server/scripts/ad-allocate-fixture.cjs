/**
 * Allocating ad charges to campaigns: the money must not move, and the
 * attribution must reach the surfaces John asked for.
 *
 * ── What this proves, in order of how badly it would hurt ──
 *   1. The P&L expense total is IDENTICAL before and after. Splitting a charge
 *      re-labels money; it must never create or destroy any. This is the check
 *      that catches a slice going missing.
 *   2. The family sums to the charge TO THE CENT, including a 3-way split of
 *      $422.00 which does not divide. `POST /bk/entries/:id/split` performs no
 *      such check — it sets the parent to `first.amount` and inserts the rest
 *      verbatim — so the ledger would silently gain a cent per charge.
 *   3. The pool falls by exactly what was allocated and the artist rises by
 *      exactly the same amount, in the same request.
 *   4. A real artist beats the still-live label-level rule (reports.js:
 *      `if (!artistBucketKey(p.artist) && labelRules.has(...))`).
 *   5. The slice reaches the recoupment surfaces — `entry_source` +
 *      `recoup_reviewed` are both set, which is what `withoutUnreviewedBankRows`
 *      requires. Writing to columns nobody reads would satisfy the letter of
 *      "mark them reviewed and recoupable" and none of the point.
 *   6. Over-allocation is REFUSED with the numbers, and writes nothing.
 *   7. Undo returns the money and the total is unchanged again.
 *
 * ── The OLD behaviour is proved to fail first ──
 * Test 0 hand-splits a bank-born charge through the existing shared writer and
 * asserts its children come out `entry_source IS NULL` and
 * `recoup_reviewed = false` — invisible to the gate. That gap is the reason this
 * endpoint writes its own INSERT instead of calling that route.
 *
 * Runs against the DEV database over the dev server on :3011, so auth, the route
 * and the transaction are all exercised — not just the SQL.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');
const http = require('http');

const BASE = 'http://localhost:3011';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'AD' + (process.pid % 100000);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const cents = (n) => Math.round(Number(n || 0) * 100);

function req(method, path, body, token) {
  return new Promise((res, rej) => {
    const d = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + path, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {},
        d ? { 'Content-Length': Buffer.byteLength(d) } : {}),
    }, (x) => {
      let s = '';
      x.on('data', (c) => (s += c));
      x.on('end', () => { try { res({ code: x.statusCode, j: JSON.parse(s) }); }
                          catch (e) { res({ code: x.statusCode, j: s.slice(0, 400) }); } });
    });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}

(async () => {
  const made = { exp: [], stmt: [], txn: [], camp: [], rule: [], artist: [], rel: [] };
  const MONTH = '2031-04';                 // far from any real or fixture data
  const PAYEE = `FIXTURE ADS ${TAG}`;
  const CAT = 'Advertisements';

  const mkExpense = async (amount, date, currency = 'USD', fx = null) => {
    const { rows: [r] } = await pool.query(`
      INSERT INTO expenses (payee, amount, currency, fx_rate_to_usd, category, invoice_date, status,
        payment_status, payment_date, entry_source, recoupable, recoup_reviewed)
      VALUES ($1,$2,$3,$4,$5,$6,'approved','Paid',$6,'bank_statement',TRUE,FALSE) RETURNING id`,
      [PAYEE, amount, currency, fx, CAT, date]);
    made.exp.push(r.id); return r.id;
  };
  const mkTxn = async (stmtId, expId, amount, date, currency = 'USD') => {
    const { rows: [r] } = await pool.query(`
      INSERT INTO bank_transactions (statement_id, txn_date, description, amount, direction,
        currency, payee_guess, matched_expense_id, match_method, dismissed)
      VALUES ($1,$2,$3,$4,'debit',$5,$6,$7,'created',FALSE) RETURNING id`,
      [stmtId, date, `PURCHASE ${TAG} FACEBK *X9`, amount, currency, PAYEE, expId]);
    made.txn.push(r.id); return r.id;
  };
  // `expense_totals.total` (sumSeries), plus the by_artist partition — the two
  // numbers a mis-split would break. Returning null here once made three
  // "unchanged" assertions pass VACUOUSLY (null === null), so this throws rather
  // than degrading if the shape ever moves again.
  const pnlTotal = async (token) => {
    const r = await req('GET', `/api/reports/pnl?from=${MONTH}-01&to=${MONTH}-30`, null, token);
    const d = r.j?.data;
    const total = d?.expense_totals?.total;
    if (typeof total !== 'number') {
      throw new Error(`/reports/pnl gave no expense_totals.total (keys: ${Object.keys(d || {}).join(',')})`);
    }
    const ba = d.by_artist || {};
    const parts = cents(ba.attributed_total ?? 0) + cents(ba.unattributed_total ?? 0)
      + cents(ba.label_level?.total ?? 0) + cents(ba.label_level?.allocated ?? 0);
    return { total: cents(total), by_artist: cents(ba.total ?? 0), parts };
  };
  const famSum = async (root) => {
    const { rows: [r] } = await pool.query(
      `SELECT ROUND(SUM(amount) * 100)::int AS c FROM expenses
        WHERE (id = $1 OR parent_id = $1) AND (deleted IS NULL OR deleted = FALSE)
          AND (voided IS NULL OR voided = FALSE)`, [root]);
    return r.c;
  };

  try {
    // ── login ──
    const L = await req('POST', '/api/auth/login',
      { email: 'john@deanst.co', password: process.env.PW_JOHN });
    const token = L.j?.data?.token;
    if (!token) { console.error('login failed:', L.code, JSON.stringify(L.j).slice(0, 200)); process.exit(1); }
    console.log('logged in against the DEV database\n');

    // ── the world: a vendor rule, a statement, three charges, one campaign ──
    const { rows: [rule] } = await pool.query(
      `INSERT INTO label_level_spend_rules (scope, rule_key, reason, created_by)
       VALUES ('vendor',$1,'fixture',NULL) RETURNING id`, [PAYEE]);
    made.rule.push(rule.id);

    const { rows: [st] } = await pool.query(`
      INSERT INTO bank_statements (filename, account, period_start, period_end, status, created_at)
      VALUES ($1,'bofa',$2,$3,'ready',NOW()) RETURNING id`,
      [`${TAG}.pdf`, `${MONTH}-01`, `${MONTH}-30`]);
    made.stmt.push(st.id);

    // 1313.17 + 422.00 + 200.00 = 1935.17
    const AMTS = [1313.17, 422.00, 200.00];
    const roots = [];
    for (let i = 0; i < AMTS.length; i += 1) {
      const d = `${MONTH}-${String(3 + i * 7).padStart(2, '0')}`;
      const e = await mkExpense(AMTS[i], d);
      await mkTxn(st.id, e, AMTS[i], d);
      roots.push(e);
    }
    const CHARGE_TOTAL = cents(AMTS.reduce((a, b) => a + b, 0));

    const { rows: [ar] } = await pool.query(
      `INSERT INTO artists (name) VALUES ($1) RETURNING id`, [`Fixture Artist ${TAG}`]);
    made.artist.push(ar.id);
    const { rows: [rel] } = await pool.query(
      `INSERT INTO releases (project_name, artist_id) VALUES ($1,$2) RETURNING id`,
      [`Fixture Song ${TAG}`, ar.id]);
    made.rel.push(rel.id);
    const mkCamp = async (name) => {
      const { rows: [c] } = await pool.query(`
        INSERT INTO influencer_campaigns (name, platform, artist_id, release_id, total_budget, campaign_date, status)
        VALUES ($1,'Facebook',$2,$3,1000,$4,'active') RETURNING id`,
        [`${name} ${TAG}`, ar.id, rel.id, `${MONTH}-15`]);
      made.camp.push(c.id); return c.id;
    };
    const campA = await mkCamp('Camp A');
    const campB = await mkCamp('Camp B');
    const campC = await mkCamp('Camp C');

    // ══ 0. the OLD behaviour, proved broken first ══════════════════════════
    console.log('0. the shared split writer leaves a bank-born slice outside the gate');
    const handExp = await mkExpense(500.00, `${MONTH}-20`);
    await mkTxn(st.id, handExp, 500.00, `${MONTH}-20`);
    const hs = await req('POST', `/api/bk/entries/${handExp}/split`, {
      artist_breakdown: [
        { artist: `Fixture Artist ${TAG}`, song: 'x', amount: 250 },
        { artist: `Fixture Artist ${TAG}`, song: 'y', amount: 250 },
      ],
    }, token);
    ok(hs.code === 200, `hand split accepted (${hs.code})`);
    const { rows: kids } = await pool.query(
      `SELECT entry_source, COALESCE(recoup_reviewed,FALSE) AS rr FROM expenses WHERE parent_id = $1`, [handExp]);
    for (const k of kids) made.exp.push(handExp);
    ok(kids.length === 1 && kids[0].entry_source === null,
      `its child has entry_source NULL — reads as a hand-entered invoice, not bank-born (got ${JSON.stringify(kids.map(k => k.entry_source))})`);
    ok(kids.every((k) => k.rr === false),
      'and recoup_reviewed = false, so the recoupment gate never opens for it');
    // Put it back so it does not disturb the pool arithmetic below.
    await req('DELETE', `/api/bk/entries/${handExp}/splits`, null, token);
    await pool.query('UPDATE expenses SET deleted = TRUE WHERE id = $1', [handExp]);
    await pool.query('UPDATE bank_transactions SET dismissed = TRUE WHERE matched_expense_id = $1', [handExp]);

    // ══ 1. the pool sees the charges ═══════════════════════════════════════
    console.log('\n1. the pool lists exactly the charges the report counts');
    const before = await req('GET', `/api/reports/ad-charges?month=${MONTH}`, null, token);
    ok(before.code === 200, `GET /ad-charges (${before.code})`);
    const B = before.j.data;
    const mine = B.charges.filter((c) => roots.includes(c.root_id));
    ok(mine.length === 3, `all three charges are listed (${mine.length})`);
    ok(mine.reduce((s, c) => s + c.open_cents, 0) === CHARGE_TOTAL,
      `unallocated = ${CHARGE_TOTAL / 100} (${mine.reduce((s, c) => s + c.open_cents, 0) / 100})`);
    ok(Math.abs(B.pool_usd - B.open_usd) < 0.005,
      `the listing and the P&L agree on the pool (${B.open_usd} vs ${B.pool_usd})`);
    ok(mine.every((c) => c.allocatable), 'every charge is allocatable');
    ok(mine[0].date <= mine[1].date && mine[1].date <= mine[2].date, 'oldest first');

    const pnlBefore = await pnlTotal(token);
    ok(pnlBefore.total > 0,
      `P&L expense total read before allocating (${pnlBefore.total / 100}) — non-zero, so the`
      + ' comparisons below cannot pass vacuously');

    // ══ 2. dry run then apply ══════════════════════════════════════════════
    console.log('\n2. the dry run is what gets written');
    const dry = await req('POST', '/api/reports/ad-allocate',
      { month: MONTH, campaign_id: campA, amount: 1500, dry_run: true }, token);
    ok(dry.code === 200 && dry.j.data.dry_run === true, `dry run (${dry.code})`);
    ok(dry.j.data.total === 1500, `plans exactly 1500.00 (${dry.j.data.total})`);
    const { rows: [none] } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM expenses WHERE campaign_id = $1', [campA]);
    ok(none.n === 0, 'and wrote nothing');

    const apply = await req('POST', '/api/reports/ad-allocate',
      { month: MONTH, campaign_id: campA, amount: 1500 }, token);
    ok(apply.code === 200, `apply (${apply.code}) ${apply.code !== 200 ? JSON.stringify(apply.j).slice(0, 200) : ''}`);
    ok(JSON.stringify(apply.j.data.per_charge) === JSON.stringify(dry.j.data.per_charge),
      'the applied plan is byte-identical to the previewed one');

    // ══ 3. the money did not move ══════════════════════════════════════════
    console.log('\n3. the money did not move');
    const pnlAfter = await pnlTotal(token);
    ok(pnlBefore.total === pnlAfter.total,
      `P&L expense total unchanged (${pnlBefore.total / 100} -> ${pnlAfter.total / 100})`);
    ok(pnlAfter.by_artist === pnlAfter.parts,
      `by_artist still partitions: attributed + unattributed + label_level = ${pnlAfter.parts / 100}`
      + ` = by_artist.total ${pnlAfter.by_artist / 100}`);
    for (let i = 0; i < roots.length; i += 1) {
      const s = await famSum(roots[i]);
      ok(s === cents(AMTS[i]), `charge ${AMTS[i]}: family sums to ${s / 100}`);
    }

    // ══ 4. the pool fell, the artist rose, by the same amount ══════════════
    console.log('\n4. the pool fell and the artist rose by the same amount');
    const mid = await req('GET', `/api/reports/ad-charges?month=${MONTH}`, null, token);
    const M = mid.j.data;
    const mineMid = M.charges.filter((c) => roots.includes(c.root_id));
    const openMid = mineMid.reduce((s, c) => s + c.open_cents, 0);
    ok(openMid === CHARGE_TOTAL - 150000,
      `unallocated fell by exactly 1500.00 (${(CHARGE_TOTAL - openMid) / 100})`);
    const spend = await req('GET',
      `/api/reports/spend-by-artist?from=${MONTH}-01&to=${MONTH}-30`, null, token);
    const rowsA = (spend.j?.data?.artists || spend.j?.data || []);
    const found = (Array.isArray(rowsA) ? rowsA : []).find(
      (a) => String(a.artist || a.name || '').includes(TAG));
    ok(!!found, `the artist now appears in spend-by-artist (${found ? (found.total ?? found.spend) : 'ABSENT'})`);
    ok(found && Math.abs(Number(found.total ?? found.spend) - 1500) < 0.02,
      `and at 1500.00 — a real artist beats the still-live label-level rule (${found ? (found.total ?? found.spend) : 'n/a'})`);

    // ══ 5. it reaches the recoupment gate ═════════════════════════════════
    console.log('\n5. the slice reaches the recoupment surfaces');
    const { rows: slices } = await pool.query(`
      SELECT id, parent_id, amount::float8 AS amount, artist, song, campaign_id, entry_source,
             COALESCE(recoup_reviewed,FALSE) AS rr, COALESCE(recoupable,FALSE) AS rc, release_id
        FROM expenses WHERE campaign_id = $1 AND (deleted IS NULL OR deleted = FALSE)`, [campA]);
    ok(slices.length >= 1, `${slices.length} slice(s) written`);
    ok(slices.every((s) => s.entry_source === 'bank_statement'),
      'every slice carries entry_source = bank_statement (inherited, not NULL)');
    ok(slices.every((s) => s.rr === true && s.rc === true),
      'every slice is recoup_reviewed AND recoupable — the gate withoutUnreviewedBankRows tests');
    ok(slices.every((s) => String(s.artist || '').includes(TAG)), 'every slice names the artist');
    ok(slices.every((s) => s.release_id === rel.id), 'and links the release from the campaign');
    ok(cents(slices.reduce((s, x) => s + x.amount, 0)) === 150000,
      `the slices total 1500.00 (${slices.reduce((s, x) => s + x.amount, 0)})`);

    // ══ 6. the cent-splitting case ════════════════════════════════════════
    console.log('\n6. $422.00 three ways, to the cent');
    // The 422.00 charge is untouched so far? 1500 drew 1313.17 + 186.83 of it.
    const c422 = mineMid.find((c) => c.charge_cents === 42200);
    ok(!!c422, 'the 422.00 charge is still listed');
    const open422 = c422.open_cents;
    const three = await req('POST', '/api/reports/ad-allocate', {
      month: MONTH,
      allocations: [{ campaign_id: campA, amount: 1 }, { campaign_id: campB, amount: 1 }, { campaign_id: campC, amount: 1 }],
      proportional: true,
    }, token);
    ok(three.code === 200, `proportional allocation of the whole remaining pool (${three.code}) ${three.code !== 200 ? JSON.stringify(three.j).slice(0, 200) : ''}`);
    ok(three.code === 200 && cents(three.j.data.total) === openMid,
      `apportions 100% of what was left — ${openMid / 100} (${three.code === 200 ? three.j.data.total : 'n/a'})`);
    for (let i = 0; i < roots.length; i += 1) {
      const s = await famSum(roots[i]);
      ok(s === cents(AMTS[i]), `charge ${AMTS[i]} still sums to ${s / 100} after a 3-way split`);
    }
    const pnlAfter3 = await pnlTotal(token);
    ok(pnlBefore.total === pnlAfter3.total,
      `P&L expense total STILL unchanged (${pnlAfter3.total / 100})`);
    ok(pnlAfter3.by_artist === pnlAfter3.parts,
      `and by_artist still partitions (${pnlAfter3.parts / 100})`);
    const zero = await req('GET', `/api/reports/ad-charges?month=${MONTH}`, null, token);
    const openEnd = zero.j.data.charges.filter((c) => roots.includes(c.root_id))
      .reduce((s, c) => s + c.open_cents, 0);
    ok(openEnd === 0, `the month is fully allocated (${openEnd} cents left)`);

    // ══ 6b. the two bugs a real payload found, which this fixture had missed ══
    // Both shipped past the version of this file that only checked totals, and
    // both are ordering/visibility rather than arithmetic — so they are asserted
    // on their own terms.
    console.log('\n6b. oldest-first, and a finished charge stays visible');
    // Fresh month, two charges, and an amount SMALLER than the older one: the draw
    // must come entirely from the older charge. The first version sorted on
    // String(pgDate) — "Tue May 04 …" — so it compared WEEKDAY NAMES and drew from
    // the 10th before the 4th.
    const M2 = '2031-06';
    const { rows: [st2] } = await pool.query(`
      INSERT INTO bank_statements (filename, account, period_start, period_end, status, created_at)
      VALUES ($1,'bofa',$2,$3,'ready',NOW()) RETURNING id`, [`${TAG}-b.pdf`, `${M2}-01`, `${M2}-30`]);
    made.stmt.push(st2.id);
    const older = await mkExpense(300.00, `${M2}-04`);   // a Wednesday
    await mkTxn(st2.id, older, 300.00, `${M2}-04`);
    const newer = await mkExpense(700.00, `${M2}-10`);   // a Tuesday — sorts FIRST as a string
    await mkTxn(st2.id, newer, 700.00, `${M2}-10`);
    const campD = await mkCamp('Camp D');

    const small = await req('POST', '/api/reports/ad-allocate',
      { month: M2, campaign_id: campD, amount: 100, dry_run: true }, token);
    ok(small.code === 200 && small.j.data.per_charge.length === 1,
      `100.00 draws from one charge (${small.code === 200 ? small.j.data.per_charge.length : small.code})`);
    ok(small.code === 200 && small.j.data.per_charge[0].root_id === older,
      'and it is the OLDEST charge, not whichever date sorts first as a string');

    // A month with exactly ONE charge, fully allocated. Deliberately independent of
    // the ordering test above: when the sort bug was present the draw landed on the
    // other charge, no charge was ever finished, and three assertions written
    // against this scenario passed VACUOUSLY. One charge, no ordering to get wrong.
    const M3 = '2031-07';
    const { rows: [st3] } = await pool.query(`
      INSERT INTO bank_statements (filename, account, period_start, period_end, status, created_at)
      VALUES ($1,'bofa',$2,$3,'ready',NOW()) RETURNING id`, [`${TAG}-c.pdf`, `${M3}-01`, `${M3}-30`]);
    made.stmt.push(st3.id);
    const solo = await mkExpense(250.00, `${M3}-09`);
    await mkTxn(st3.id, solo, 250.00, `${M3}-09`);
    const campE = await mkCamp('Camp E');

    const pre3 = await req('GET', `/api/reports/ad-charges?month=${M3}`, null, token);
    ok((pre3.j.data.charges || []).length === 1,
      `${M3} holds exactly one charge (${(pre3.j.data.charges || []).length})`);
    const full3 = await req('POST', '/api/reports/ad-allocate',
      { month: M3, campaign_id: campE, amount: 250 }, token);
    ok(full3.code === 200, `the whole 250.00 charge allocated (${full3.code})`);

    const after3 = await req('GET', `/api/reports/ad-charges?month=${M3}`, null, token);
    const kept = (after3.j.data.charges || []).find((c) => c.root_id === solo);
    ok(!!kept, 'the finished charge is STILL LISTED — it left the label-level bucket, not the page');
    ok(!!kept && kept.open_cents === 0 && kept.allocations.length === 1,
      `with nothing left and its allocation on it (open ${kept ? kept.open_cents : '?'},`
      + ` allocs ${kept ? kept.allocations.length : '?'})`);
    ok(!!kept && kept.allocatable === false && kept.blocked.includes('nothing unallocated'),
      'and it says why it can no longer be allocated');
    ok(after3.j.data.allocated_cents === 25000,
      `the month reports the full 250.00 as allocated (${after3.j.data.allocated_cents / 100})`);
    ok(after3.j.data.allocatable_cents === 0,
      `and nothing left to allocate (${after3.j.data.allocatable_cents})`);
    ok(await famSum(solo) === 25000, 'the charge total is untouched by being fully allocated');

    // ══ 7. over-allocation is refused ═════════════════════════════════════
    console.log('\n7. over-allocation is refused with the numbers');
    const over = await req('POST', '/api/reports/ad-allocate',
      { month: MONTH, campaign_id: campA, amount: 999999 }, token);
    ok(over.code === 400, `refused (${over.code})`);
    ok(typeof over.j.error === 'string' && /over-allocate/.test(over.j.error),
      `and says so with figures: ${String(over.j.error).slice(0, 120)}`);
    for (let i = 0; i < roots.length; i += 1) {
      ok(await famSum(roots[i]) === cents(AMTS[i]), `charge ${AMTS[i]} untouched by the refusal`);
    }

    // ══ 8. undo ═══════════════════════════════════════════════════════════
    console.log('\n8. undo returns the money');
    const { rows: [one] } = await pool.query(
      `SELECT id, parent_id, amount::float8 AS amount FROM expenses
        WHERE campaign_id = $1 AND (deleted IS NULL OR deleted = FALSE) LIMIT 1`, [campB]);
    ok(!!one, 'a slice to undo');
    const root = one.parent_id || one.id;
    const sumWas = await famSum(root);
    const un = await req('DELETE', `/api/reports/ad-allocate/${one.id}`, null, token);
    ok(un.code === 200, `undo (${un.code}) ${un.code !== 200 ? JSON.stringify(un.j).slice(0, 200) : ''}`);
    ok(await famSum(root) === sumWas, `the charge total is unchanged by the undo (${sumWas / 100})`);
    const backOpen = await req('GET', `/api/reports/ad-charges?month=${MONTH}`, null, token);
    const reopened = backOpen.j.data.charges.filter((c) => roots.includes(c.root_id))
      .reduce((s, c) => s + c.open_cents, 0);
    ok(reopened === cents(one.amount),
      `${one.amount} is back in the pool (${reopened / 100})`);
    const pnlAfterUndo = await pnlTotal(token);
    ok(pnlBefore.total === pnlAfterUndo.total,
      `P&L expense total unchanged by the undo (${pnlAfterUndo.total / 100})`);

    // ══ 9. the retired write path ═════════════════════════════════════════
    console.log('\n9. the reporting-side allocation is closed, and says where to go');
    const oldPost = await req('POST', '/api/reports/ad-pool',
      { artist: 'x', month: MONTH, amount: 1 }, token);
    ok(oldPost.code === 400 && /bk\/advertising/.test(JSON.stringify(oldPost.j)),
      `POST /ad-pool refuses and points at the new page (${oldPost.code})`);
    const oldGet = await req('GET', `/api/reports/ad-pool?month=${MONTH}`, null, token);
    ok(oldGet.code === 200, `GET /ad-pool still works, so an old row stays visible (${oldGet.code})`);
  } catch (err) {
    console.error('\nFIXTURE ERROR:', err.message);
    fail += 1;
  } finally {
    // Children first: they reference their parent.
    await pool.query('DELETE FROM expenses WHERE parent_id = ANY($1::int[])', [made.exp]).catch(() => {});
    await pool.query('DELETE FROM bank_transactions WHERE statement_id = ANY($1::int[])', [made.stmt]).catch(() => {});
    await pool.query('DELETE FROM expenses WHERE id = ANY($1::int[])', [made.exp]).catch(() => {});
    await pool.query('DELETE FROM bank_statements WHERE id = ANY($1::int[])', [made.stmt]).catch(() => {});
    await pool.query('DELETE FROM influencer_campaigns WHERE id = ANY($1::int[])', [made.camp]).catch(() => {});
    await pool.query('DELETE FROM label_level_spend_rules WHERE id = ANY($1::int[])', [made.rule]).catch(() => {});
    await pool.query('DELETE FROM releases WHERE id = ANY($1::int[])', [made.rel]).catch(() => {});
    await pool.query('DELETE FROM artists WHERE id = ANY($1::int[])', [made.artist]).catch(() => {});
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
