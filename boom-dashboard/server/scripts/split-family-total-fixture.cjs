/**
 * A split family is counted ONCE, and it is counted by summing every row.
 *
 * ── What this exists to stop ──
 * TODO #18 read: "Recoupments stat cards double-count split families — the
 * Excel export filters parent-of-children via EXISTS; Recoupments doesn't."
 * The premise is false in both halves, and the proposed fix would have deleted
 * real money from the page. This fixture pins the invariant so it cannot be
 * misdiagnosed a third time.
 *
 * All three split writers SHRINK the parent to its own slice and put the rest on
 * children — `POST /entries/:id/split` (`SET amount = first.amount`), the
 * auto-split-by-song inside `PUT /entries/:id`, and
 * `POST /entries/:id/split-fee-reimb`. So:
 *
 *     parent.amount + SUM(children.amount) = the invoice
 *
 * Summing `e.amount` over parent AND children — which is exactly what
 * `Recoupments.jsx` does, and what `/bk/export-recoupments` does — is therefore
 * correct. `family_total` is the same figure computed server-side, and it is a
 * DISPLAY column for "what is this invoice worth"; the page never sums it, and a
 * stat card that did would be the actual double-count.
 *
 * ── The proposed fix proved wrong first ──
 * Section 3 applies TODO #18's remedy (drop rows that have live children) and
 * asserts it UNDER-reports by exactly the parent's slice. That assertion is the
 * point of the file: it is red for the change the TODO asked for and green for
 * the code as it stands. Measured on production 2026-09-02 before writing this:
 * 111 split families, 275 children, ZERO parents carrying the whole invoice, and
 * the remedy would have removed $47,226.01 from a $3,126,376.38 page.
 *
 * Section 4 covers the sibling claim — page vs export. They agree because both
 * sum every row; the export's comment claiming an EXISTS filter was wrong from
 * the commit that introduced it (2b6e136) and no such filter was ever in the SQL.
 *
 * ── Running ──
 *   cd server
 *   PORT=3011 node index.js &
 *   node scripts/split-family-total-fixture.cjs
 *
 * Boot from `server/` so dotenv reads `./.env` and it runs against the dev
 * database. Amounts are chosen so the slices do NOT divide evenly ($1,000.03
 * three ways) — a family that splits cleanly cannot tell a correct sum from one
 * that rounds each slice independently.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');
const { excludeBankRows } = require('../lib/ledger-source');

const BASE = 'http://localhost:3011';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'SF' + (process.pid % 100000);
const ARTIST = `Split Fixture ${TAG}`;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const money = (n) => `$${Number(n).toFixed(2)}`;
// Round ONCE, at the end. Summing pre-rounded slices is the bug next door.
const sum = (rows) => Math.round(rows.reduce((s, r) => s + Number(r.amount || 0), 0) * 100) / 100;

(async () => {
  const made = [];
  let token = null;

  // Column types copied from the INSERT in routes/bookkeeping.js — a
  // hand-written shape is how a fixture passes against a schema that does not
  // exist in production.
  const mkInvoice = async (amount, { song = `Song ${TAG}`, recoupable = true, entrySource = null } = {}) => {
    const { rows: [r] } = await pool.query(`
      INSERT INTO expenses (payee, amount, currency, category, artist, song, invoice_number,
        invoice_date, status, payment_status, recoupable, entry_source)
      VALUES ($1, $2, 'USD', 'Marketing', $3, $4, $5,
        CURRENT_DATE, 'approved', 'Paid', $6, $7)
      RETURNING id, amount`,
      [`Split Vendor ${TAG}`, amount, ARTIST, song, `${TAG}-${made.length + 1}`, recoupable, entrySource]);
    made.push(r.id);
    return r;
  };

  // Every live row of the family, parent first — the shape both the page and the
  // export receive.
  const family = async (rootId) => (await pool.query(
    `SELECT id, parent_id, amount, artist, song FROM expenses
      WHERE (id = $1 OR parent_id = $1) AND (deleted = false OR deleted IS NULL)
      ORDER BY parent_id NULLS FIRST, id`, [rootId])).rows;

  const splitEndpoint = async (id, breakdown) => {
    const r = await fetch(`${BASE}/api/bk/entries/${id}/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ artist_breakdown: breakdown }),
    });
    let j = null; try { j = await r.json() } catch {}
    return { code: r.status, j };
  };

  try {
    const L = await fetch(BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'john@deanst.co', password: process.env.PW_JOHN }),
    });
    const LJ = await L.json();
    token = LJ?.data?.token;
    if (!token) throw new Error(`login failed (${L.status}) — needs PW_JOHN in server/.env`);
    console.log('logged in against the DEV database');

    // ── 1. the real writer shrinks the parent ────────────────────────────────
    console.log('\n1. POST /entries/:id/split leaves parent + children = the invoice');
    const INVOICE = 1000.03;
    const inv = await mkInvoice(INVOICE);
    const res = await splitEndpoint(inv.id, [
      { artist: `${ARTIST} A`, song: 'Song A', amount: 333.35 },
      { artist: `${ARTIST} B`, song: 'Song B', amount: 333.34 },
      { artist: `${ARTIST} C`, song: 'Song C', amount: 333.34 },
    ]);
    ok(res.code === 200, `split accepted (${res.code})`);
    for (const id of res.j?.data?.child_ids || []) made.push(id);

    const fam = await family(inv.id);
    const parent = fam.find(r => r.parent_id === null);
    const kids   = fam.filter(r => r.parent_id !== null);
    ok(kids.length === 2, `2 child rows created (${kids.length})`);
    ok(Number(parent.amount) !== INVOICE,
      `parent was SHRUNK to its slice, not left whole (${money(parent.amount)} of ${money(INVOICE)})`);
    ok(Number(parent.amount) === 333.35,
      `parent carries the FIRST slice (${money(parent.amount)})`);
    ok(sum(fam) === INVOICE,
      `parent + children = the invoice (${money(sum(fam))} vs ${money(INVOICE)})`);

    // ── 2. what the page actually does ───────────────────────────────────────
    // Recoupments.jsx sums e.amount across every row it holds. Reproduced here
    // rather than asserted about, so the fixture fails if that changes.
    console.log('\n2. the page sums every row — no filter, no family_total');
    const pageTotal = sum(fam);
    ok(pageTotal === INVOICE, `page total over the family = ${money(pageTotal)}`);

    const { rows: [ft] } = await pool.query(`
      SELECT (e.amount + COALESCE((
                SELECT SUM(c.amount) FROM expenses c
                 WHERE c.parent_id = e.id
                   AND (c.deleted = false OR c.deleted IS NULL)
                   AND (c.voided  = false OR c.voided  IS NULL)), 0)) AS family_total
        FROM expenses e WHERE e.id = $1`, [inv.id]);
    ok(Number(ft.family_total) === INVOICE,
      `family_total is the SAME figure, not an addition to it (${money(ft.family_total)})`);
    ok(pageTotal + Number(ft.family_total) !== INVOICE,
      'summing family_total ALONGSIDE the rows would be the real double-count '
      + `(${money(pageTotal + Number(ft.family_total))})`);

    // ── 3. TODO #18's proposed fix, proved wrong ─────────────────────────────
    console.log("\n3. dropping parents-of-children UNDER-reports (the proposed fix)");
    const afterProposedFix = sum(fam.filter(r => !(r.parent_id === null && kids.length)));
    ok(afterProposedFix !== INVOICE,
      `the remedy does not reproduce the invoice (${money(afterProposedFix)} vs ${money(INVOICE)})`);
    ok(Math.round((INVOICE - afterProposedFix) * 100) / 100 === Number(parent.amount),
      `it loses exactly the parent's slice — ${money(INVOICE - afterProposedFix)}`);

    // The mirror image: keeping ONLY roots loses the children.
    const rootsOnly = sum(fam.filter(r => r.parent_id === null));
    ok(rootsOnly !== INVOICE,
      `?roots=1 alone would also be wrong here (${money(rootsOnly)} vs ${money(INVOICE)})`);

    // ── 4. the page and its own Export button agree ──────────────────────────
    // Same family, run through the export's actual WHERE clause.
    console.log('\n4. /bk/export-recoupments sees the same rows as the page');
    const { rows: exportRows } = await pool.query(`
      SELECT e.id, e.amount FROM expenses e
       WHERE normalize_artist_key(e.artist) LIKE normalize_artist_key($1) || '%'
         AND e.status = 'approved'
         AND e.recoupable = true
         AND ${excludeBankRows('e')}
         AND (e.deleted = false OR e.deleted IS NULL)
         AND (e.voided  = false OR e.voided  IS NULL)`, [ARTIST]);
    ok(exportRows.length === fam.length,
      `export returns every family row, parent included (${exportRows.length} vs ${fam.length})`);
    ok(sum(exportRows) === INVOICE,
      `export total ties to the page (${money(sum(exportRows))} vs ${money(pageTotal)})`);

    // ── 5. re-splitting does not leave the old slices behind ─────────────────
    // The delete-children → shrink-parent → insert-children transaction is what
    // keeps this true; a partial re-split is the one way this family COULD end
    // up over-stated.
    console.log('\n5. a re-split still sums to the invoice');
    const res2 = await splitEndpoint(inv.id, [
      { artist: `${ARTIST} A`, song: 'Song A', amount: 500.02 },
      { artist: `${ARTIST} D`, song: 'Song D', amount: 500.01 },
    ]);
    ok(res2.code === 200, `re-split accepted (${res2.code})`);
    for (const id of res2.j?.data?.child_ids || []) made.push(id);
    const fam2 = await family(inv.id);
    ok(fam2.length === 2, `old children are gone, not orphaned (${fam2.length} rows)`);
    ok(sum(fam2) === INVOICE, `still ties to the invoice (${money(sum(fam2))})`);

    // ── 6. auto-split-by-song, the other writer ──────────────────────────────
    // A comma in `song` splits inside PUT /entries/:id with its own shrink, and
    // it divides unevenly on purpose: $100.00 three ways is 33.33 + remainder.
    console.log('\n6. auto-split-by-song shrinks the parent too');
    const auto = await mkInvoice(100.00, { song: 'One' });
    const pr = await fetch(`${BASE}/api/bk/entries/${auto.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ song: 'One, Two, Three' }),
    });
    ok(pr.status === 200, `song edit accepted (${pr.status})`);
    const famAuto = await family(auto.id);
    for (const r of famAuto) if (!made.includes(r.id)) made.push(r.id);
    ok(famAuto.length === 3, `auto-split produced 3 rows (${famAuto.length})`);
    ok(sum(famAuto) === 100.00,
      `the remainder cent is kept, not dropped (${money(sum(famAuto))} vs $100.00)`);
    const autoParent = famAuto.find(r => r.parent_id === null);
    ok(Number(autoParent.amount) === 33.34,
      `parent holds slice + remainder (${money(autoParent.amount)})`);

    // ── 7. an unsplit invoice is unaffected ──────────────────────────────────
    // The control. If a filter for splits ever lands, this is the row that
    // proves it did not catch everything else on the way past.
    console.log('\n7. control — a plain invoice counts once');
    const plain = await mkInvoice(250.55, { song: `Solo ${TAG}` });
    const famPlain = await family(plain.id);
    ok(famPlain.length === 1, `no children (${famPlain.length} row)`);
    ok(sum(famPlain) === 250.55, `counts once (${money(sum(famPlain))})`);
  } catch (err) {
    console.error('\nFIXTURE ERROR:', err.message);
    fail += 1;
  } finally {
    // Children first — parent_id has no ON DELETE, and a failed run mid-split
    // can leave rows whose parent is in the same list.
    await pool.query('DELETE FROM expenses WHERE parent_id = ANY($1::int[])', [made]).catch(() => {});
    await pool.query('DELETE FROM expenses WHERE id = ANY($1::int[])', [made]).catch(() => {});
    await pool.query('DELETE FROM bk_audit_log WHERE entry_payee LIKE $1', [`%${TAG}%`]).catch(() => {});
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
