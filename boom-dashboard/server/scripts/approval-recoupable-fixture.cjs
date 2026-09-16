/**
 * "Recoupable? yes/no" on the approvals checklist, and it must be REQUIRED.
 *
 * ── Why this question and not another checkbox ──
 * `expenses.recoupable` is BOOLEAN DEFAULT TRUE. So a row reads recoupable
 * whether a person decided it or nobody ever looked, and those two are
 * indistinguishable — which is precisely why no recoupable total in this app can
 * be proved today (1,292 rows read recoupable by default; only the 179 marked NOT
 * recoupable ever took an act). Asking at approval turns the default into a
 * decision for every invoice from here on.
 *
 * The answer is written to the COLUMN, not just recorded in the checklist JSON,
 * because the column is what Recoupments, the artist spend sheets and the
 * recoupment audit all read.
 *
 * ── Old behaviour proved first ──
 * Test 1 posts a checklist with everything answered EXCEPT recoupable and
 * asserts it is refused. Before this change that same payload approved the
 * invoice, which is the hole being closed.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');

const BASE = 'http://localhost:3011';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'AR' + (process.pid % 100000);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };

(async () => {
  const made = [];
  let token = null;
  const mkEntry = async (recoupable = null) => {
    const { rows: [r] } = await pool.query(`
      INSERT INTO expenses (payee, amount, currency, category, artist, song, invoice_number,
        invoice_date, status, payment_status, vendor_submitted, recoupable)
      VALUES ($1, 100, 'USD', 'Services', 'Fixture Artist', 'Fixture Song', $2,
        CURRENT_DATE, 'pending', 'Unpaid', TRUE, COALESCE($3, TRUE)) RETURNING id, recoupable`,
      [`Approval Vendor ${TAG}`, `${TAG}-${made.length + 1}`, recoupable]);
    made.push(r.id);
    return r;
  };
  const approve = async (id, checklist) => {
    const r = await fetch(`${BASE}/api/bk/entries/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ checklist }),
    });
    let j = null; try { j = await r.json() } catch {}
    return { code: r.status, j };
  };
  const FULL = { artist: true, song: true, amount: true, category: true,
    bulk_deal: false, cobrand: false, recoupable: true, campaign: true };
  // Everything answered EXCEPT the one under test, per section.
  const without = (k) => { const x = { ...FULL }; delete x[k]; return x };
  const rowOf = async (id) => (await pool.query(
    'SELECT status, recoupable, approval_checklist FROM expenses WHERE id = $1', [id])).rows[0];

  try {
    const L = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'john@deanst.co', password: process.env.PW_JOHN }),
    });
    token = (await L.json())?.data?.token;
    if (!token) { console.error('login failed'); process.exit(1); }
    console.log('logged in against the DEV database\n');

    console.log('1. an unanswered recoupable is REFUSED');
    const a = await mkEntry();
    const r1 = await approve(a.id, without('recoupable'));
    ok(r1.code === 400, `approve without recoupable -> ${r1.code}`);
    ok(/recoupable/i.test(String(r1.j?.error || '')),
      `and says which answer is missing: ${String(r1.j?.error || '').slice(0, 100)}`);
    const after1 = await rowOf(a.id);
    ok(after1.status === 'pending', 'the invoice is still pending — the refusal wrote nothing');

    console.log('\n2. answering NO writes false to the column');
    const b = await mkEntry();
    ok(b.recoupable === true, 'the entry starts recoupable=true, because that is the column default');
    const r2 = await approve(b.id, { ...FULL, recoupable: false });
    ok(r2.code === 200, `approved (${r2.code}) ${r2.code !== 200 ? JSON.stringify(r2.j).slice(0, 120) : ''}`);
    const after2 = await rowOf(b.id);
    ok(after2.status === 'approved', 'status is approved');
    ok(after2.recoupable === false, `expenses.recoupable is now FALSE (${after2.recoupable})`);
    ok(after2.approval_checklist?.recoupable === false,
      'and the checklist records the same answer, so the row and its record agree');
    ok(!!after2.approval_checklist?.by && !!after2.approval_checklist?.at,
      'stamped with who answered and when');

    console.log('\n3. answering YES is also an answer, not a default');
    const c = await mkEntry();
    const r3 = await approve(c.id, { ...FULL, recoupable: true });
    ok(r3.code === 200, `approved (${r3.code})`);
    const after3 = await rowOf(c.id);
    ok(after3.recoupable === true && after3.approval_checklist?.recoupable === true,
      'recoupable stays true AND the checklist proves somebody said so — which is the whole difference');

    console.log('\n4. a NOT-recoupable entry can be approved as recoupable, and vice versa');
    // The stored value must not constrain the answer: it is the default, not a
    // decision, and the approver overrides it either way.
    const d = await mkEntry(false);
    ok(d.recoupable === false, 'entry created NOT recoupable');
    const r4 = await approve(d.id, { ...FULL, recoupable: true });
    ok(r4.code === 200, `approved as recoupable (${r4.code})`);
    ok((await rowOf(d.id)).recoupable === true, 'the answer overrode the stored value');

    console.log('\n5. the other answers still work as before');
    const e = await mkEntry();
    const r5 = await approve(e.id, { ...FULL, recoupable: true, cobrand: true });
    ok(r5.code === 200, `cobrand + recoupable together (${r5.code})`);
    const after5 = await pool.query('SELECT category, cobrand, recoupable FROM expenses WHERE id = $1', [e.id]);
    ok(after5.rows[0].cobrand === true && after5.rows[0].category === 'Marketing',
      'cobrand still forces category = Marketing');
    ok(after5.rows[0].recoupable === true, 'and recoupable landed alongside it');

    console.log('\n6. campaign is required too');
    const g = await mkEntry();
    const rg = await approve(g.id, without('campaign'));
    ok(rg.code === 400 && /campaign/i.test(String(rg.j?.error || '')),
      `approve without campaign -> ${rg.code} ${String(rg.j?.error || '').slice(0, 70)}`);
    ok((await rowOf(g.id)).status === 'pending', 'and nothing was written');

    const h = await mkEntry();
    const rh = await approve(h.id, { ...FULL, campaign: false });
    ok(rh.code === 200, `answering NO is accepted (${rh.code})`);
    const afterH = await pool.query('SELECT artist_campaign FROM expenses WHERE id = $1', [h.id]);
    ok(afterH.rows[0].artist_campaign === 'No',
      `artist_campaign is the text 'No' (${JSON.stringify(afterH.rows[0].artist_campaign)})`);

    console.log('\n7. cobrand yes MEANS campaign yes');
    // Answered cobrand, campaign left out entirely — the implication has to
    // count as the answer or the approver is asked for something they cannot
    // change.
    const i2 = await mkEntry();
    const ri = await approve(i2.id, { ...without('campaign'), cobrand: true });
    ok(ri.code === 200, `cobrand yes with NO campaign answer is accepted (${ri.code}) `
      + `${ri.code !== 200 ? String(ri.j?.error || '').slice(0, 80) : ''}`);
    const afterI = await pool.query(
      'SELECT artist_campaign, cobrand, category, approval_checklist FROM expenses WHERE id = $1', [i2.id]);
    ok(afterI.rows[0].artist_campaign === 'Yes', `artist_campaign forced to 'Yes' (${afterI.rows[0].artist_campaign})`);
    ok(afterI.rows[0].approval_checklist?.campaign === true, 'and the checklist records campaign: true');
    ok(afterI.rows[0].approval_checklist?.campaign_implied_by_cobrand === true,
      'flagged as implied, so the record says WHY it is yes');
    ok(afterI.rows[0].category === 'Marketing', 'cobrand still forces the category too');

    // And the contradiction is not storable.
    const j2 = await mkEntry();
    const rj2 = await approve(j2.id, { ...FULL, cobrand: true, campaign: false });
    ok(rj2.code === 200, `cobrand=true with campaign=false is accepted (${rj2.code})`);
    const afterJ = await pool.query('SELECT artist_campaign FROM expenses WHERE id = $1', [j2.id]);
    ok(afterJ.rows[0].artist_campaign === 'Yes',
      `…and OVERRIDDEN to 'Yes' rather than stored as the contradiction (${afterJ.rows[0].artist_campaign})`);

    console.log('\n8. a non-boolean is not an answer');
    for (const [label, val] of [['a string', 'yes'], ['null', null], ['a number', 1]]) {
      const f = await mkEntry();
      const rr = await approve(f.id, { ...FULL, recoupable: val });
      ok(rr.code === 400, `${label.padEnd(10)} -> ${rr.code} (must be 400)`);
    }
  } catch (err) {
    console.error('\nFIXTURE ERROR:', err.message);
    fail += 1;
  } finally {
    await pool.query('DELETE FROM expenses WHERE id = ANY($1::int[])', [made]).catch(() => {});
    await pool.query('DELETE FROM bk_audit_log WHERE entry_payee LIKE $1', [`%${TAG}%`]).catch(() => {});
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
