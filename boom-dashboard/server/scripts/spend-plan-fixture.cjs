/**
 * The plan is the commitment, the ledger is the actual, and neither overwrites
 * the other.
 *
 * ── What this exists to stop ──
 * The sheet and the ledger disagree on every one of the 111 (artist, song) pairs
 * they share. That makes "reconcile them" a choice about which record to
 * believe, and this file pins the choice that was made: `release_spend_plans`
 * carries what was COMMITTED, `expenses` carries what MOVED, the variance is
 * reported, and importing writes nothing to the ledger.
 *
 * It also pins the three arithmetic rules borrowed from surfaces that have each
 * been got wrong before, because every one of them is invisible until the data
 * has the right shape:
 *
 *   EVERY ROW COUNTS    the split writers shrink the PARENT to its own slice
 *                       and put the rest on children, so the family sums to the
 *                       invoice only if the parent is included. Section 3 builds
 *                       a $900 family as 300 + 300 + 300 and asserts $900. This
 *                       is the assertion that earned its keep: the route was
 *                       written leaf-only and reported $600.
 *
 *   usdOf PER ROW       never the stored `amount_usd`. Section 4 books GBP with
 *                       a locked rate and asserts the converted figure.
 *
 *   ROUND AT THE ROW    the actual is sliced two ways at once (paid vs open),
 *                       and both must add to the same total. Amounts are chosen
 *                       so the conversions do NOT divide evenly — £1,000.03 at
 *                       0.79 is 1,266.4936... — because a fixture whose numbers
 *                       are all clean cannot tell correct rounding from the kind
 *                       that broke the artist spend sheets by a cent in
 *                       production within a minute of shipping.
 *
 * ── Running ──
 *   cd server
 *   PORT=3011 node index.js &
 *   node scripts/spend-plan-fixture.cjs
 *
 * Boot from `server/` so dotenv reads `./.env` and it runs against the dev
 * database. It creates its own artist, release, plan and expenses, and deletes
 * all of them on the way out.
 */

require('dotenv').config();
const pool = require('./../db');

// Hardcoded, as the other fixtures are, and NOT `process.env.PORT` — dotenv has
// already run by this line and `.env` sets PORT=3001, so reading it points the
// fixture at the dev server you did not start and every call fails as a bare
// "fetch failed" with a healthy server sitting on 3011.
const BASE = 'http://localhost:3011';
const EMAIL = 'john@deanst.co';
const PASSWORD = process.env.PW_JOHN;

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `  — ${detail}` : ''}`); }
};
const eq = (label, actual, expected) =>
  ok(label, Math.abs(Number(actual) - Number(expected)) < 0.005, `got ${actual}, want ${expected}`);

const TAG = 'spendplan-fixture';
// Same rule the API keys artists on, so the fixture asks for the card by the key
// the server will have built.
const artistKeyOf = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
let gbp = 0, eur = 0;

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = await r.json();
  const token = (j.data || j).token;
  if (!token) throw new Error(`login failed: ${JSON.stringify(j).slice(0, 200)}`);
  return token;
}

async function cleanup() {
  await pool.query(`DELETE FROM expenses WHERE notes = $1`, [TAG]);
  await pool.query(`DELETE FROM release_spend_plans WHERE source_column LIKE 'FIXT%'`);
  await pool.query(`DELETE FROM releases WHERE project_name = $1`, [TAG]);
  await pool.query(`DELETE FROM artists WHERE name = $1`, [TAG]);
}

(async function main() {
  if (!PASSWORD) throw new Error('PW_JOHN is not set in server/.env');
  await cleanup();

  const token = await login();
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // ── Setup ──────────────────────────────────────────────────────────────────
  const { rows: [artist] } = await pool.query(
    `INSERT INTO artists (name) VALUES ($1) RETURNING id`, [TAG]);
  const { rows: [release] } = await pool.query(
    `INSERT INTO releases (artist_id, project_name) VALUES ($1, $2) RETURNING id`,
    [artist.id, TAG]);

  // The plan: $5,000 printed, of which $1,500 is still owed.
  const { rows: [plan] } = await pool.query(`
    INSERT INTO release_spend_plans
      (release_id, source_header, source_column, parsed_left, parsed_right,
       match_status, match_order, sheet_total, total_source)
    VALUES ($1, $2, 'FIXT1', $3, $4, 'matched', 'manual', 5000, 'printed')
    RETURNING id`, [release.id, `${TAG} - song`, TAG, 'song']);
  await pool.query(`
    INSERT INTO release_spend_plan_lines (plan_id, source_row, amount, note, status, status_raw)
    VALUES ($1, 2, 2500, 'marquee', 'paid', 'Paid'),
           ($1, 3, 1500, 'showcase', 'not_yet', 'Not Yet '),
           ($1, 4, 1000, 'fb ads', NULL, 'Tyler ')`, [plan.id]);

  const addExpense = async (over = {}) => {
    const v = {
      amount: 0, currency: 'USD', fx: null, status: 'Paid', parent: null, ...over,
    };
    const { rows: [e] } = await pool.query(`
      INSERT INTO expenses
        (payee, artist, song, amount, currency, fx_rate_to_usd, category,
         payment_status, payment_date, release_id, parent_id, notes)
      VALUES ('Fixture Vendor', $1, 'song', $2, $3, $4, 'Marketing',
              $5, CURRENT_DATE, $6, $7, $8)
      RETURNING id`,
      [TAG, v.amount, v.currency, v.fx, v.status, release.id, v.parent, TAG]);
    return e.id;
  };

  // ── 1. Baseline: paid and open are separate ────────────────────────────────
  console.log('\n1. SPENT and OPEN are separate');
  await addExpense({ amount: 1200, status: 'Paid' });
  await addExpense({ amount: 800, status: 'Pending' });

  let r = await fetch(`${BASE}/api/spend-plans/release/${release.id}`, { headers: H });
  let d = (await r.json()).data;
  eq('actual.spent is the paid row only', d.actual.spent, 1200);
  eq('actual.open is the unpaid row only', d.actual.open, 800);
  ok('an unpaid invoice is NOT counted as spend', d.actual.spent !== 2000);

  // ── 2. The plan side, and the variance ─────────────────────────────────────
  console.log('\n2. The plan is the commitment');
  eq('plan.sheet_total is the printed figure', d.plan.sheet_total, 5000);
  eq('plan.committed is the not_yet lines', d.plan.committed, 1500);
  eq("plan.sheet_paid is the sheet's own claim", d.plan.sheet_paid, 2500);
  eq('plan.sheet_unknown is the unmapped status', d.plan.sheet_unknown, 1000);
  eq('variance = printed total - actual spent', d.variance, 5000 - 1200);
  ok("the sheet's paid figure is NOT mixed into the ledger's",
     d.actual.spent !== d.plan.sheet_paid);

  // ── 3. Split families ──────────────────────────────────────────────────────
  console.log('\n3. A split family counts ONCE, and that means every row');
  const parent = await addExpense({ amount: 300, status: 'Paid' });
  await addExpense({ amount: 300, status: 'Paid', parent });
  await addExpense({ amount: 300, status: 'Paid', parent });

  r = await fetch(`${BASE}/api/spend-plans/release/${release.id}`, { headers: H });
  d = (await r.json()).data;
  eq('a 900 family adds 900 — parent slice included', d.actual.spent, 1200 + 900);
  ok('the parent IS counted, because it holds its own slice',
     d.actual.rows.some(x => x.id === parent));
  eq('the family contributes exactly the invoice, not twice it',
     d.actual.rows.filter(x => x.amount_usd === 300).length, 3);

  // ── 4. usdOf per row, rounded at the row ───────────────────────────────────
  console.log('\n4. Foreign rows convert per row, and the slices still add up');
  // 1000.03 GBP at a locked 0.79 = 1265.8607594936709 -> 1265.86
  await addExpense({ amount: 1000.03, currency: 'GBP', fx: 0.79, status: 'Paid' });
  // 500.07 EUR at a locked 0.91 = 549.5274725274725 -> 549.53
  await addExpense({ amount: 500.07, currency: 'EUR', fx: 0.91, status: 'Pending' });

  r = await fetch(`${BASE}/api/spend-plans/release/${release.id}`, { headers: H });
  d = (await r.json()).data;
  gbp = Math.round((1000.03 / 0.79) * 100) / 100;
  eur = Math.round((500.07 / 0.91) * 100) / 100;
  eq('GBP row converted at its locked rate', d.actual.spent, 2100 + gbp);
  eq('EUR row converted at its locked rate', d.actual.open, 800 + eur);
  const rowSum = Math.round(d.actual.rows.reduce((s, x) => s + x.amount_usd, 0) * 100) / 100;
  eq('spent + open equals the sum of the rows', d.actual.spent + d.actual.open, rowSum);

  // ── 5. Nothing here writes to the ledger ───────────────────────────────────
  console.log('\n5. The plan surfaces never write to expenses');
  const before = await pool.query(
    `SELECT COUNT(*)::int c, COALESCE(SUM(amount),0)::float s FROM expenses WHERE release_id = $1`,
    [release.id]);
  await fetch(`${BASE}/api/spend-plans/${plan.id}/unlink`, { method: 'POST', headers: H });
  await fetch(`${BASE}/api/spend-plans/${plan.id}/link`, {
    method: 'POST', headers: H, body: JSON.stringify({ release_id: release.id }),
  });
  await fetch(`${BASE}/api/spend-plans/${plan.id}/skip`, { method: 'POST', headers: H });
  const after = await pool.query(
    `SELECT COUNT(*)::int c, COALESCE(SUM(amount),0)::float s FROM expenses WHERE release_id = $1`,
    [release.id]);
  ok('link / unlink / skip left the ledger byte-identical',
     before.rows[0].c === after.rows[0].c && before.rows[0].s === after.rows[0].s,
     `${JSON.stringify(before.rows[0])} -> ${JSON.stringify(after.rows[0])}`);

  // ── 6. Link and unlink actually move the row ───────────────────────────────
  console.log('\n6. The queue answers stick');
  await fetch(`${BASE}/api/spend-plans/${plan.id}/link`, {
    method: 'POST', headers: H, body: JSON.stringify({ release_id: release.id }),
  });
  let { rows: [row] } = await pool.query(
    'SELECT release_id, match_status, match_order FROM release_spend_plans WHERE id = $1', [plan.id]);
  ok('link sets matched + manual', row.match_status === 'matched' && row.match_order === 'manual',
     JSON.stringify(row));
  await fetch(`${BASE}/api/spend-plans/${plan.id}/unlink`, { method: 'POST', headers: H });
  ({ rows: [row] } = await pool.query(
    'SELECT release_id, match_status FROM release_spend_plans WHERE id = $1', [plan.id]));
  ok('unlink returns it to the queue', row.release_id === null && row.match_status === 'unmatched',
     JSON.stringify(row));

  const bad = await fetch(`${BASE}/api/spend-plans/${plan.id}/link`, {
    method: 'POST', headers: H, body: JSON.stringify({ release_id: 999999999 }),
  });
  ok('linking to a release that does not exist is refused', bad.status === 400, `status ${bad.status}`);

  // ── 7. Two blocks on one release count the release's actual ONCE ───────────
  console.log('\n7. A release with two blocks is not counted twice');
  // Nine releases on the live sheet carry two blocks — the operator made a
  // second column for the same project. by-artist added the release's ledger
  // actual once PER PLAN, so those artists' paid figure was inflated.
  const { rows: [plan2] } = await pool.query(`
    INSERT INTO release_spend_plans
      (release_id, source_header, source_column, match_status, match_order, sheet_total, total_source)
    VALUES ($1, $2, 'FIXT2', 'matched', 'manual', 1000, 'printed')
    RETURNING id`, [release.id, `${TAG} - song (second block)`]);
  await pool.query(`
    INSERT INTO release_spend_plan_lines (plan_id, source_row, amount, note, status)
    VALUES ($1, 2, 1000, 'extra block', 'paid')`, [plan2.id]);
  await fetch(`${BASE}/api/spend-plans/${plan.id}/link`, {
    method: 'POST', headers: H, body: JSON.stringify({ release_id: release.id }),
  });

  r = await fetch(`${BASE}/api/spend-plans/by-artist?artist_key=${encodeURIComponent(artistKeyOf(TAG))}`, { headers: H });
  let ba = (await r.json()).data;
  const card = (ba.artists || [])[0];
  ok('the artist card exists', !!card, JSON.stringify(ba.totals));
  if (card) {
    eq('both blocks are listed as campaigns', card.campaigns.length, 2);
    eq('planned is the SUM of both blocks', card.planned, 5000 + 1000);
    // The release's ledger actual, counted once. Section 4 left it at
    // 2100 + gbp paid and 800 + eur open.
    eq('ledger paid counts the release ONCE, not once per block',
       card.ledger_paid, 2100 + gbp);
    eq('ledger open counts the release ONCE too', card.ledger_open, 800 + eur);
  }

  // ── 8. The queue and the unlinked count agree ──────────────────────────────
  console.log('\n8. A skipped block leaves the queue');
  const { rows: [plan3] } = await pool.query(`
    INSERT INTO release_spend_plans
      (source_header, source_column, match_status, sheet_total, total_source)
    VALUES ($1, 'FIXT3', 'unmatched', 250, 'printed') RETURNING id`, [`${TAG} - unlinked`]);
  // Search by header, not by position: the queue is ordered by sheet_total and
  // paginated, so a small fixture block sorts past page one on a real database.
  // Asserting "it is in the first 200" then fails for a reason that has nothing
  // to do with the rule, and — worse — makes the NEXT assertion ("it left the
  // queue") pass vacuously, because it was never on the page to begin with.
  // `total` is a COUNT over the whole filter and is the figure that matters.
  const queueHas = async (id, qs = '') => {
    const res = await fetch(
      `${BASE}/api/spend-plans/queue?limit=200&q=${encodeURIComponent(TAG)}${qs}`, { headers: H });
    const j = await res.json();
    return { hit: (j.data || []).some((x) => x.id === id), total: j.total };
  };
  let q1 = await queueHas(plan3.id);
  ok('an unmatched block is in the default queue', q1.hit);
  await fetch(`${BASE}/api/spend-plans/${plan3.id}/skip`, { method: 'POST', headers: H });
  let q2 = await queueHas(plan3.id);
  ok('after skipping it is NOT in the default queue', !q2.hit);
  eq('and the queue total dropped by exactly one', q2.total, q1.total - 1);
  const q3 = await queueHas(plan3.id, '&status=skipped');
  ok('it is still reachable with ?status=skipped', q3.hit);

  // ── 9. A re-import re-matches the unanswered, never the answered ───────────
  console.log('\n9. Re-importing promotes only what nobody has answered');
  // The whole point of merging duplicate releases is that the NEXT import picks
  // the block up. applyImport wrote no matching columns on conflict at first,
  // so a duplicate_release block stayed one forever and that advice was false.
  const { applyImport } = require('./../lib/spendPlan');
  const mk = (col, status, releaseId) => ({
    sourceColumn: col, header: `${TAG} ${col}`, left: TAG, right: 'song',
    status, matchOrder: status === 'matched' ? 'artist_song' : null,
    releaseId, suggestions: [], sheetTotal: 100, totalSource: 'printed',
    lines: [{ sourceRow: 2, amount: 100, amountRaw: null, note: 'x', status: 'paid', statusRaw: 'Paid' }],
  });
  const client2 = await pool.connect();
  try {
    // First run: one unanswered duplicate_release block, one a person answered.
    await applyImport(client2, [mk('FIXT4', 'duplicate_release', null), mk('FIXT5', 'duplicate_release', null)], null);
    await client2.query(
      `UPDATE release_spend_plans SET match_status='skipped', matched_at=NOW() WHERE source_column='FIXT5'`);
    // Second run: the releases got merged, so both now resolve.
    await applyImport(client2, [mk('FIXT4', 'matched', release.id), mk('FIXT5', 'matched', release.id)], null);
    const { rows: after } = await client2.query(
      `SELECT source_column, match_status, release_id FROM release_spend_plans
        WHERE source_column IN ('FIXT4','FIXT5') ORDER BY source_column`);
    const a4 = after.find((x) => x.source_column === 'FIXT4');
    const a5 = after.find((x) => x.source_column === 'FIXT5');
    ok('an UNANSWERED block is promoted on re-import',
       a4 && a4.match_status === 'matched' && a4.release_id === release.id, JSON.stringify(a4));
    ok('an ANSWERED block is left exactly as the person left it',
       a5 && a5.match_status === 'skipped' && a5.release_id === null, JSON.stringify(a5));
  } finally { client2.release(); }

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exitCode = fail ? 1 : 0;
})().catch(async (err) => {
  console.error('\nFIXTURE ERROR:', err.message, '\n');
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
