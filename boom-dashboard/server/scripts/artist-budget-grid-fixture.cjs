/**
 * The budget is typed on the CATEGORY rows, and a section is the sum of its own.
 *
 * ── What this exists to stop ──
 * The sheet used to store six numbers, one per section, in
 * `artist_budget_sections`. It now stores one per CATEGORY and DERIVES the
 * section. Both grains are still readable — the old table keeps its rows and its
 * write route — so the failure this pins is the one where a surface reads the
 * wrong half:
 *
 *   A SECTION IS ITS CHILDREN         section 2. The old read returned the
 *                                     stored section row, which is now always
 *                                     zero, so a page that kept it shows
 *                                     "no budget" over a budget somebody typed.
 *   THE INDEX AGREES WITH THE SHEET   section 3. `GET /artist-budgets` summed
 *                                     `artist_budget_sections` alone; a budget
 *                                     typed on the sheet made the two surfaces
 *                                     disagree one click apart.
 *   A PASTE IS ONE EDIT               section 5. The bulk write is a
 *                                     transaction: a bad cell in the middle
 *                                     must leave NOTHING written, not the rows
 *                                     before it.
 *   NOTHING BECOMES INVISIBLE         section 6. A legacy section row still
 *                                     counts, under its own name.
 *
 * Amounts are deliberately not clean: the EUR row converts to a fraction of a
 * cent (€500.21 ÷ 1.0817 = $462.4295…, since `fx_rate_to_usd` is quoted per USD
 * and `usdOf` divides), because rounding at the row is what makes the four state
 * buckets and the category buckets add to the same section figure, and a fixture
 * whose numbers all divide evenly cannot tell that apart from rounding late.
 *
 * ── Running ──
 *   cd server
 *   PORT=3011 node index.js &
 *   node scripts/artist-budget-grid-fixture.cjs
 *
 * Boot from `server/` so dotenv reads `./.env` and it runs against the dev
 * database. It creates its own artist and expenses and deletes them on the way
 * out.
 */

require('dotenv').config();
const pool = require('./../db');

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

const TAG = 'budgetgrid-fixture';
let madeArtist = null, madeRelease = null;
const KEY = TAG.toLowerCase().replace(/[^a-z0-9]/g, '');

let token = '';
const H = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
const GET = async (u) => (await fetch(`${BASE}/api${u}`, { headers: H() })).json();
const PUT = async (u, body) => {
  const r = await fetch(`${BASE}/api${u}`, { method: 'PUT', headers: H(), body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const sheet = () => GET(`/artist-budgets/${encodeURIComponent(KEY)}`).then((r) => r.data);
const sectionOf = (d, key) => d.sections.find((s) => s.key === key);
const catOf = (d, sKey, name) => sectionOf(d, sKey).categories.find((c) => c.category === name);

async function main() {
  const lg = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })).json();
  token = lg.data?.token;
  if (!token) { console.log('login failed:', JSON.stringify(lg).slice(0, 200)); process.exit(2); }

  const addExpense = async (v) => {
    const { rows: [e] } = await pool.query(`
      INSERT INTO expenses
        (payee, artist, song, amount, currency, fx_rate_to_usd, category,
         payment_status, payment_date, invoice_date, notes)
      VALUES ('Fixture Vendor', $1, 'song', $2, $3, $4, $5, $6,
              CASE WHEN $6 = 'Paid' THEN CURRENT_DATE ELSE NULL END, CURRENT_DATE, $7)
      RETURNING id`,
      [TAG, v.amount, v.currency || 'USD', v.fx || null, v.category, v.status, TAG]);
    return e.id;
  };

  // Marketing and Distribution are both in `campaign`; Advance is in `artist`.
  // Three sections are touched and three are left empty on purpose — the grid
  // has to render a section with no activity at all, because that is where you
  // type the budget for something that has not started.
  await addExpense({ amount: 1200, category: 'Marketing', status: 'Paid' });
  await addExpense({ amount: 800, category: 'Marketing', status: 'Pending' });
  await addExpense({ amount: 300.07, category: 'Distribution', status: 'Paid' });
  // `fx_rate_to_usd` is quoted PER USD and `usdOf` divides by it, so €500.21 at
  // 1.0817 is $462.4295... — a fraction of a cent, which is the point.
  await addExpense({ amount: 500.21, currency: 'EUR', fx: 1.0817, category: 'Advance', status: 'Paid' });

  const EUR_USD = Math.round((500.21 / 1.0817) * 100) / 100;   // 462.43

  console.log('\n1. THE ROWS ARE THERE BEFORE ANY BUDGET IS TYPED');
  let d = await sheet();
  ok('the sheet exists for an artist with no budget', !!d);
  eq('campaign spent', sectionOf(d, 'campaign').spent, 1500.07);
  eq('campaign open', sectionOf(d, 'campaign').open, 800);
  eq('artist spent (EUR rounded at the row)', sectionOf(d, 'artist').spent, EUR_USD);
  ok('a category with spend is a row', !!catOf(d, 'campaign', 'Marketing'));
  eq('the category carries its own open, not just spent',
    catOf(d, 'campaign', 'Marketing').open, 800);
  // The whole point of a budget grid: a row to type in before money moves.
  ok('a category with NO spend is still a row',
    !!catOf(d, 'record', 'Recording') && catOf(d, 'record', 'Recording').spent === 0);
  ok('an untouched section still renders', !!sectionOf(d, 'people'));
  ok('every category sums to its section spent',
    Math.abs(sectionOf(d, 'campaign').categories.reduce((t, c) => t + c.spent, 0)
      - sectionOf(d, 'campaign').spent) < 0.005);
  ok('every category sums to its section open',
    Math.abs(sectionOf(d, 'campaign').categories.reduce((t, c) => t + c.open, 0)
      - sectionOf(d, 'campaign').open) < 0.005);

  console.log('\n2. A SECTION IS THE SUM OF ITS CATEGORIES');
  // The assertion that fails against the old code: it read the stored section
  // row, which nothing writes any more, so this would be 0.
  await PUT(`/artist-budgets/${KEY}/category`, { category: 'Marketing', amount: 2000 });
  await PUT(`/artist-budgets/${KEY}/category`, { category: 'Distribution', amount: 250 });
  d = await sheet();
  eq('the category cell holds what was typed', catOf(d, 'campaign', 'Marketing').budget, 2000);
  eq('the SECTION is their sum, not a stored number', sectionOf(d, 'campaign').budget, 2250);
  eq('the total is the sum of the sections', d.totals.budget, 2250);
  eq('variance measures against SPENT, not committed',
    sectionOf(d, 'campaign').variance, 2250 - 1500.07);
  eq('the category variance does too', catOf(d, 'campaign', 'Marketing').variance, 800);
  eq('percent is spent over budget', catOf(d, 'campaign', 'Marketing').pct, 60);
  ok('a budgeted category is not unplanned', catOf(d, 'campaign', 'Marketing').unplanned === false);
  ok('spend with no budget IS unplanned', catOf(d, 'artist', 'Advance').unplanned === true);
  // 2,000 budget, 1,200 spent, 800 open → inside on spend, exactly at it on
  // commitment. Nudge it over rather than testing the boundary.
  await PUT(`/artist-budgets/${KEY}/category`, { category: 'Marketing', amount: 1900 });
  d = await sheet();
  ok('over-committed is flagged while variance is still positive',
    catOf(d, 'campaign', 'Marketing').over_committed === true
    && catOf(d, 'campaign', 'Marketing').variance > 0);

  console.log('\n3. THE INDEX AGREES WITH THE SHEET');
  const idx = (await GET('/artist-budgets')).data;
  const mine = idx.artists.find((a) => a.artist_key === KEY);
  ok('the artist is on the index', !!mine);
  eq('the index shows the budget typed on the sheet', mine.budget, 1900 + 250);
  ok('the index calls it budgeted', mine.has_budget === true);

  console.log('\n4. ZERO CLEARS THE CELL');
  await PUT(`/artist-budgets/${KEY}/category`, { category: 'Distribution', amount: 0 });
  d = await sheet();
  eq('the cell is empty', catOf(d, 'campaign', 'Distribution').budget, 0);
  eq('the section drops by exactly that much', sectionOf(d, 'campaign').budget, 1900);
  ok('the cleared category reads as unplanned again',
    catOf(d, 'campaign', 'Distribution').unplanned === true);
  const { rows: stored } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM artist_budget_categories
      WHERE artist_key = $1 AND category = 'Distribution'`, [KEY]);
  ok('a zero is a DELETED row, not a stored 0', stored[0].n === 0);

  console.log('\n5. A PASTE IS ONE EDIT');
  const bad = await PUT(`/artist-budgets/${KEY}/categories`, { items: [
    { category: 'Marketing', amount: 4444 },
    { category: 'Not A Category', amount: 10 },
    { category: 'Advance', amount: 5555 },
  ] });
  ok('an unknown category refuses the paste', bad.status === 400);
  ok('it names the offending cell', /Not A Category/.test(bad.body.error || ''));
  d = await sheet();
  eq('the cell BEFORE the bad one was not written', catOf(d, 'campaign', 'Marketing').budget, 1900);
  eq('nor the one after it', catOf(d, 'artist', 'Advance').budget, 0);

  const good = await PUT(`/artist-budgets/${KEY}/categories`, { items: [
    { category: 'Marketing', amount: 3000 },
    { category: 'Distribution', amount: 400 },
    { category: 'Advance', amount: 600 },
    { category: 'Recording', amount: 0 },
  ] });
  ok('a clean paste is accepted', good.status === 200);
  d = await sheet();
  eq('every pasted cell landed', catOf(d, 'campaign', 'Marketing').budget, 3000);
  eq('across sections', catOf(d, 'artist', 'Advance').budget, 600);
  eq('the campaign section is the new sum', sectionOf(d, 'campaign').budget, 3400);
  eq('the sheet total is every section', d.totals.budget, 4000);
  eq('a zero in a paste clears rather than stores', catOf(d, 'record', 'Recording').budget, 0);

  // Case is not an identity. "marketing" and "Marketing" are one cell.
  await PUT(`/artist-budgets/${KEY}/categories`, { items: [{ category: 'mArKeTiNg', amount: 111 }] });
  d = await sheet();
  eq('a differently-cased name writes the SAME cell', catOf(d, 'campaign', 'Marketing').budget, 111);
  const { rows: dupes } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM artist_budget_categories
      WHERE artist_key = $1 AND LOWER(category) = 'marketing'`, [KEY]);
  ok('it did not create a second row', dupes[0].n === 1);
  const twice = await PUT(`/artist-budgets/${KEY}/categories`, { items: [
    { category: 'Marketing', amount: 1 }, { category: 'marketing', amount: 2 },
  ] });
  ok('one cell twice in one paste is refused, not silently last-wins', twice.status === 400);

  console.log('\n6. A LEGACY SECTION BUDGET STILL COUNTS');
  await pool.query(
    `INSERT INTO artist_budget_sections (artist_key, section, amount)
     VALUES ($1, 'people', 777) ON CONFLICT (artist_key, section) DO UPDATE SET amount = 777`,
    [KEY]);
  d = await sheet();
  eq('it is reported under its own name', sectionOf(d, 'people').legacy_budget, 777);
  eq('and added to the section it was typed on', sectionOf(d, 'people').budget, 777);
  eq('and to the sheet total', d.totals.budget, 111 + 400 + 600 + 777);

  console.log('\n7. A BUDGET IS ZERO OR MORE');
  const neg = await PUT(`/artist-budgets/${KEY}/category`, { category: 'Marketing', amount: -5 });
  ok('a negative budget is refused', neg.status === 400);
  const nan = await PUT(`/artist-budgets/${KEY}/category`, { category: 'Marketing', amount: 'abc' });
  ok('a non-number is refused', nan.status === 400);
  d = await sheet();
  eq('and the cell is untouched', catOf(d, 'campaign', 'Marketing').budget, 111);

  console.log('\n8. EVERY KEY THE GRID READS');
  // The page renders these directly. A missing one is a blank column or a
  // crash, and neither shows up in a totals assertion.
  d = await sheet();
  const mk = catOf(d, 'campaign', 'Marketing');
  ok('a category says whether it is still in the vocabulary', mk.in_catalog === true);
  ok('a section counts how many of its categories are budgeted',
    sectionOf(d, 'campaign').budgeted_count === 2, `got ${sectionOf(d, 'campaign').budgeted_count}`);
  ok('a section reports its legacy figure even when zero',
    sectionOf(d, 'campaign').legacy_budget === 0);
  ok('the sheet total carries a percent', d.totals.pct !== undefined);
  ok('every expense row names the category row it belongs under',
    d.rows.length > 0 && d.rows.every((r) => !!r.budget_category),
    `${d.rows.filter((r) => !r.budget_category).length} rows without one`);
  ok('and the section it belongs under', d.rows.every((r) => !!r.section));
  ok('an open row is flagged as open', d.open_rows.every((r) => r.is_open === true));
  ok('a row carries its USD value', d.rows.every((r) => typeof r.amount_usd_calc === 'number'));
  // Every category the PICKER offers is a row, so a budget can be typed for
  // something nothing has been spent on yet. Compared against the live
  // vocabulary rather than a number written here — the dev database carries 28
  // categories and production 32, so a hardcoded count tests the seed, not the
  // sheet.
  const catCount = d.sections.reduce((t, s) => t + s.categories.length, 0);
  const vocab = (await GET('/categories')).data;
  const offered = vocab.expense_groups.reduce((t, g) => t + g.items.length, 0);
  ok('every category the picker offers has a row on the sheet',
    catCount === offered, `sheet ${catCount}, picker ${offered}`);
  ok('and they land in the same sections the picker groups them into',
    vocab.expense_groups.every((g) => {
      const mine = sectionOf(d, g.key);
      return mine && g.items.every((n) => mine.categories.some((c) => c.category === n));
    }));

  console.log('\n9. THE OTHER PARTITION: BY RELEASE');
  // The original spreadsheet plans per RELEASE — its Expenses tab is one block
  // per release, its hidden Accounting tab is Artist | Project | Planned
  // Marketing | Amount Spent | Amount remaining. Measured on 3,582 live ledger
  // rows: only 695 name a release, so 56% of an artist's spend has none. That
  // residual is the assertion that matters here.
  const { rows: [art] } = await pool.query(
    `INSERT INTO artists (name) VALUES ($1) RETURNING id`, [TAG]);
  const { rows: [rel] } = await pool.query(
    `INSERT INTO releases (project_name, artist_id) VALUES ($1, $2) RETURNING id`,
    [`${TAG} Single`, art.id]);
  madeArtist = art.id; madeRelease = rel.id;
  // One expense ON the release, leaving the rest of this artist's spend with none.
  await pool.query(
    `INSERT INTO expenses (payee, artist, song, amount, currency, category,
                           payment_status, payment_date, invoice_date, notes, release_id)
     VALUES ('Fixture Vendor', $1, 'song', 700, 'USD', 'Marketing', 'Paid',
             CURRENT_DATE, CURRENT_DATE, $2, $3)`, [TAG, TAG, rel.id]);

  d = await sheet();
  const relRow = d.releases.find((r) => r.release_id === rel.id);
  ok('the release is a row', !!relRow);
  eq('carrying its own spend', relRow?.spent, 700);
  ok('and reads unplanned until it is budgeted', relRow?.unplanned === true);
  const resid = d.unassigned_release;
  ok('there is a residual row for spend that names no release', !!resid);
  ok('and it is READ-ONLY — a residual is not somewhere to plan', resid.read_only === true);
  ok(`which is carrying the rest of this artist's spend (${resid.spent})`, resid.spent > 0);
  // The partition has to hold: every release plus the residual IS the artist.
  eq('release rows + residual = the artist\'s spent',
    Math.round((d.releases.reduce((t, r) => t + r.spent, 0) + resid.spent) * 100) / 100,
    d.totals.spent);
  eq('and the same for open',
    Math.round((d.releases.reduce((t, r) => t + r.open, 0) + resid.open) * 100) / 100,
    d.totals.open);

  const relPut = await PUT(`/artist-budgets/${KEY}/release`, { release_id: rel.id, amount: 1000 });
  ok(`a release budget saves (${relPut.status}) ${relPut.status !== 200 ? JSON.stringify(relPut.body.error) : ''}`, relPut.status === 200);
  d = await sheet();
  const relRow2 = d.releases.find((r) => r.release_id === rel.id);
  eq('the cell holds it', relRow2?.budget, 1000);
  eq('variance measures against spent', relRow2?.variance, 300);
  eq('percent too', relRow2?.pct, 70);
  eq('and the release total is the sum of the release rows', d.release_totals.budget, 1000);
  // THE TWO GRAINS DO NOT MERGE. This is the whole design decision: a release
  // budget is the same money sliced the other way, so adding it to the category
  // total would report this artist as having planned it twice.
  ok('the category total is NOT the release total — two partitions, not two halves',
    d.totals.budget !== d.release_totals.budget);
  const beforeCat = d.totals.budget;
  ok(`and the category grain is untouched by a release write (${beforeCat})`,
    beforeCat === 111 + 400 + 600 + 777);

  const idx2 = (await GET('/artist-budgets')).data.artists.find((a) => a.artist_key === KEY);
  eq('the index carries the release budget separately', idx2?.release_budget, 1000);
  ok('and does not fold it into the category budget',
    idx2.budget !== idx2.budget + idx2.release_budget);

  const zero = await PUT(`/artist-budgets/${KEY}/release`, { release_id: rel.id, amount: 0 });
  ok('zero clears it', zero.status === 200);
  const { rows: gone } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM artist_budget_releases WHERE artist_key = $1', [KEY]);
  ok('by DELETING the row, as the other grains do', gone[0].n === 0);
  const bad2 = await PUT(`/artist-budgets/${KEY}/release`, { release_id: 999999999, amount: 5 });
  ok(`an unknown release is refused with a sentence (${bad2.body.error})`,
    bad2.status === 400 && /does not exist/i.test(bad2.body.error || ''));

  console.log('\n10. THE EXPORT IS THE SAME BUILDER');
  const xl = await fetch(
    `${BASE}/api/artist-budgets/${encodeURIComponent(KEY)}/export?token=${token}`,
    { headers: H() });
  ok('the workbook downloads', xl.status === 200);
  ok('it is an xlsx',
    /spreadsheetml/.test(xl.headers.get('content-type') || ''));
  const buf = Buffer.from(await xl.arrayBuffer());
  ok('it is not empty', buf.length > 4000);

  console.log(`\n${pass} passed, ${fail} failed`);
}

main()
  .catch((e) => { console.error('THREW:', e); fail++; })
  .finally(async () => {
    await pool.query(`DELETE FROM expenses WHERE notes = $1`, [TAG]);
    await pool.query(`DELETE FROM artist_budget_categories WHERE artist_key = $1`, [KEY]);
    await pool.query(`DELETE FROM artist_budget_sections WHERE artist_key = $1`, [KEY]);
    await pool.query(`DELETE FROM artist_budget_releases WHERE artist_key = $1`, [KEY]).catch(() => {});
    if (madeRelease) await pool.query(`DELETE FROM releases WHERE id = $1`, [madeRelease]).catch(() => {});
    if (madeArtist) await pool.query(`DELETE FROM artists WHERE id = $1`, [madeArtist]).catch(() => {});
    await pool.end();
    process.exit(fail ? 1 : 0);
  });
