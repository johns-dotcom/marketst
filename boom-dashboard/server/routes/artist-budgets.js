/**
 * Artist spend sheets — a budget per artist, with the actuals matched to it.
 *
 * John, 2026-08-24: "artist spend / budget sheets. Organized expense sheets per
 * artist matched against a created budget."
 *
 * ── The shape ──
 * Rows are the six CATEGORY SECTIONS (`bk_categories.ui_group`) with their
 * categories underneath, and THE BUDGET IS TYPED ON THE CATEGORY ROWS:
 *
 *                             BUDGET      SPENT       OPEN  COMMITTED  VARIANCE
 *     THE ARTIST             400,000    400,992          —    400,992      −992
 *       Advance             [400,000]   400,000          —    400,000         —
 *       Tour/Live                  —        992          —        992 unplanned
 *     CAMPAIGN & PROMOTION   310,000    379,230     12,400    391,630   −69,230
 *       Marketing           [310,000]   353,855          —    353,855   −43,855
 *       Distribution               —     25,375     12,400     37,775 unplanned
 *
 * A SECTION'S BUDGET IS THE SUM OF ITS CATEGORIES — derived here, never stored,
 * so the two grains cannot disagree. John, 2026-09-15: "the section total is the
 * sum of its children and stops being typed directly."
 *
 * This replaced six section-level inputs, and the replacement was free: measured
 * first, `artist_budget_sections` held ZERO rows across all 156 artists, so there
 * was no budget anywhere to migrate. A section row that appears anyway is read as
 * `legacy_budget`, added to the section and labelled on screen and in the export.
 *
 * The line-item caution that produced the six-input design still stands — budgets
 * have been attempted three times in this app and every attempt died at
 * line-item entry (all 7 `recording_budgets` are drafts with ZERO line items;
 * `artist_budget_items` holds 1 row across the twelve biggest-spending artists).
 * What makes 32 cells different from those attempts is that there is still
 * nothing to create: every row is already on screen with its actuals beside it,
 * typing in one IS the budget, and a pasted column fills all of them at once.
 *
 * ── The four states, and why they are not invented here ──
 * John: "if an item is marked as paid but its statement hasn't been uploaded yet,
 * it should be noted that it's paid but not confirmed done."
 *
 * That is `recoupState()` in client/src/utils.js, which this endpoint feeds rather
 * than duplicates: every row carries `bank_evidence` and `bank_expected` from
 * bankEvidenceCols(), and the client derives
 *
 *     verified            the bank shows it
 *     awaiting_statement  paid, and no uploaded statement covers the date yet
 *                         — John's "paid but not confirmed done"
 *     unverified          paid, a statement DOES cover it, and no line matches.
 *                         A real discrepancy, not a waiting state.
 *     unpaid              an invoice nobody has paid
 *
 * Measured before this was built: 31.3% of what the older budget pages called
 * "spend" ($538,345 across the eight biggest artists) was unpaid invoices, because
 * those queries have no bank-evidence join at all.
 */

const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const auth = require('../middleware/auth');
const { bankEvidenceCols } = require('../lib/bank-evidence');
const { usdOf } = require('../lib/usd');
const { artistBucketKey, namesAnArtist } = require('../lib/artist-key');
const { CATEGORY_GROUPS } = require('../lib/constants');

const router = express.Router();
router.use(auth);

const isBkAdmin = (u) => u && ['Admin', 'Superadmin', 'Approver'].includes(u.role);
const SECTION_KEYS = CATEGORY_GROUPS.expense.map(([key]) => key);
const SECTION_LABEL = new Map(CATEGORY_GROUPS.expense);
const LAST_SECTION = SECTION_KEYS[SECTION_KEYS.length - 1];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * A row's USD value, rounded to cents AT THE ROW.
 *
 * This is the one place rounding happens, and it has to be here rather than at
 * the totals, because a sheet slices the same rows two ways at once — by state
 * (confirmed / not confirmed / no bank line / unpaid) and by category — and BOTH
 * have to add up to the section total on screen and in the exported workbook.
 *
 * Rounding each subtotal independently cannot give you that. Shipped that way
 * first and production proved it within a minute: Jerri's four states summed to
 * $781,522.61 against an actual of $781,522.62, because a foreign row converts to
 * a fraction of a cent and each subtotal absorbed a different part of it. The dev
 * fixture missed it because every amount it created was a clean number.
 *
 * Rounding at the row is also the honest place: an expense IS an amount of money,
 * and its USD value is a real cent figure. Every aggregate above this is then an
 * exact sum of exact cents.
 */
const rowUsd = (e) => r2(usdOf(e.amount, e.currency, e.fx_rate_to_usd));

/**
 * category name → section key, from the TABLE, not a hardcoded list.
 *
 * `bk_categories.ui_group` is the one place this lives. A seventh copy of the
 * category vocabulary in this file is exactly the mistake `budgets.js` made with
 * its stale `LEDGER_CATEGORIES`.
 *
 * Degrades to "everything in the last section" rather than throwing: the picker
 * rule applies here too — a category that cannot be placed must still be VISIBLE,
 * because a sheet that silently omits spend is worse than one that groups it
 * loosely.
 */
async function loadCategoryCatalog() {
  const norm = (s) => String(s || '').trim().toLowerCase();
  try {
    const { rows } = await pool.query(
      `SELECT name, ui_group, COALESCE(active, TRUE) AS active
         FROM bk_categories WHERE kind = 'expense'
        ORDER BY sort_order ASC NULLS LAST, name ASC`);
    const group = new Map(rows.map((r) => [norm(r.name), r.ui_group]));
    const canonical = new Map(rows.map((r) => [norm(r.name), String(r.name).trim()]));
    const sectionOf = (category) => {
      const g = group.get(norm(category));
      return SECTION_LABEL.has(g) ? g : LAST_SECTION;
    };
    return {
      sectionOf,
      // The rows the grid OFFERS to budget. Inactive categories are not offered
      // — but they are not dropped either: buildSheet appends anything that
      // carries spend or an existing budget, so retiring a category can never
      // make money disappear off a sheet.
      catalog: rows.filter((r) => r.active)
        .map((r) => ({ name: String(r.name).trim(), section: sectionOf(r.name) })),
      // A write is stored under the TABLE's spelling, never the client's. Two
      // budgets for "marketing" and "Marketing" would be two rows against one
      // column of spend.
      canonical: (name) => canonical.get(norm(name)) || null,
    };
  } catch (err) {
    console.error('category sections unavailable — one section:', err.message);
    return { sectionOf: () => LAST_SECTION, catalog: [], canonical: () => null };
  }
}

/** Percent of a budget that has been spent. Null without a budget to divide by. */
const pctOf = (spent, budget) => (budget > 0 ? Math.round((spent / budget) * 100) : null);

/**
 * Every expense that belongs on an artist's sheet.
 *
 * LEAF ROWS ONLY. A split family's children carry the real attribution and the
 * parent carries their sum, so counting both doubles every split invoice. The
 * `NOT EXISTS (children)` test is the same one the older budget endpoints use —
 * kept, because it is the thing that makes the sheet tie to the ledger.
 *
 * Scoped to `approved`: pending vendor submissions live on Approvals until
 * somebody reviews them, and a sheet that counted them would move when an
 * approver clicked.
 */
const SHEET_ROWS_SQL = `
  SELECT e.id, e.invoice_date, e.payment_date, e.payee, e.artist, e.song,
         e.category, e.description, e.amount, e.currency, e.fx_rate_to_usd,
         e.payment_status, e.recoupable, e.entry_source, e.parent_id, e.release_id,
         ${bankEvidenceCols('e')}
    FROM expenses e
   WHERE COALESCE(e.status, 'approved') = 'approved'
     AND (e.deleted IS NULL OR e.deleted = FALSE)
     AND (e.voided  IS NULL OR e.voided  = FALSE)
     AND COALESCE(TRIM(e.artist), '') <> ''
     AND NOT EXISTS (
       SELECT 1 FROM expenses c
        WHERE c.parent_id = e.id
          AND (c.deleted IS NULL OR c.deleted = FALSE)
          AND (c.voided  IS NULL OR c.voided  = FALSE))
`;

/** The spelling to PRINT: most-used wins, ties alphabetically. */
// The roster's spelling, by artist key. A sheet that exists only because
// somebody typed a budget has no ledger rows to take a spelling from, and
// without this the index card and the sheet header read the KEY ("rosavale")
// for an artist the roster calls "Rosa Vale". Read once per request, never per
// artist.
async function rosterNamesByKey() {
  const { rows } = await pool.query(
    `SELECT name FROM artists WHERE (archived = false OR archived IS NULL)`);
  const m = new Map();
  for (const r of rows) {
    const k = artistBucketKey(r.name);
    if (k && !m.has(k)) m.set(k, String(r.name).trim());
  }
  return m;
}

function bestSpelling(counts) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
}

// ── GET /api/artist-budgets ──────────────────────────────────────────────────
// The index: every artist that has a budget OR has spend. An artist with spend
// and no budget is the normal case at first — 91 artists carry ledger spend and
// none of them has a sheet — so they are listed, not hidden behind a "create".
router.get('/', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    // BOTH budget tables. The sheet's budget is the sum of its category rows,
    // so an index that read only the section table would report "no budget" for
    // every artist whose budget has actually been typed — the same surface
    // disagreeing with itself one click apart.
    const [{ rows: expenses }, { rows: budgets }, { rows: catBudgets },
      { rows: relBudgets }, roster] = await Promise.all([
      pool.query(SHEET_ROWS_SQL),
      pool.query(`SELECT artist_key, section, amount::float8 AS amount FROM artist_budget_sections`),
      pool.query(`SELECT artist_key, category, amount::float8 AS amount FROM artist_budget_categories`),
      pool.query(`SELECT artist_key, release_id, amount::float8 AS amount FROM artist_budget_releases`),
      rosterNamesByKey(),
    ]);

    const byKey = new Map();
    const spellings = new Map();
    const take = (key) => {
      if (!byKey.has(key)) {
        byKey.set(key, { artist_key: key, budget: 0, release_budget: 0, spent: 0, open: 0,
          count: 0, open_count: 0,
          verified: 0, awaiting: 0, unverified: 0, unpaid: 0 });
      }
      return byKey.get(key);
    };
    for (const b of budgets) take(b.artist_key).budget += Number(b.amount) || 0;
    for (const b of catBudgets) take(b.artist_key).budget += Number(b.amount) || 0;
    // NOT added into `budget`. A release budget is the same money sliced the
    // other way, so summing both would report an artist who planned $50k twice
    // as having planned $100k. Carried alongside instead, so an artist budgeted
    // ONLY by release does not read as having no budget at all — which is the
    // disagreement this index already had to be fixed for once.
    for (const b of relBudgets) take(b.artist_key).release_budget += Number(b.amount) || 0;
    for (const e of expenses) {
      const key = artistBucketKey(e.artist);
      if (!key) continue;               // placeholders are not artists
      if (!spellings.has(key)) spellings.set(key, new Map());
      const sp = spellings.get(key);
      const name = String(e.artist).trim();
      sp.set(name, (sp.get(name) || 0) + 1);

      const row = take(key);
      const usd = rowUsd(e);
      const paid = e.payment_status === 'Paid';
      if (paid) { row.spent += usd; row.count += 1; }
      else { row.open += usd; row.open_count += 1; }
      // Mirrors client recoupState — see the header note.
      if (e.bank_evidence) row.verified += usd;
      else if (!paid) row.unpaid += usd;
      else if (e.bank_expected) row.unverified += usd;
      else row.awaiting += usd;
    }

    const list = [...byKey.values()].map((r) => {
      const verified = r2(r.verified); const awaiting = r2(r.awaiting);
      const unverified = r2(r.unverified); const unpaid = r2(r.unpaid);
      const spent = r2(verified + awaiting + unverified);
      const open = unpaid;
      const budget = r2(r.budget);
      return {
        ...r,
        artist: bestSpelling(spellings.get(r.artist_key) || new Map()) || roster.get(r.artist_key) || r.artist_key,
        budget, release_budget: r2(r.release_budget), spent, open, committed: r2(spent + open),
        verified, awaiting, unverified, unpaid,
        variance: r2(budget - spent),
        has_budget: budget > 0 || r2(r.release_budget) > 0,
        over_committed: budget > 0 && r2(spent + open) > budget,
      };
    }).sort((a, b) => b.committed - a.committed);

    res.json({ success: true, data: {
      artists: list,
      totals: {
        artists: list.length,
        with_budget: list.filter((a) => a.has_budget).length,
        budget: r2(list.reduce((t, a) => t + a.budget, 0)),
        spent: r2(list.reduce((t, a) => t + a.spent, 0)),
        open: r2(list.reduce((t, a) => t + a.open, 0)),
        committed: r2(list.reduce((t, a) => t + a.committed, 0)),
        open_count: list.reduce((t, a) => t + a.open_count, 0),
      },
      sections: CATEGORY_GROUPS.expense.map(([key, label]) => ({ key, label })),
    } });
  } catch (err) {
    console.error('GET /api/artist-budgets:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── One sheet ────────────────────────────────────────────────────────────────
// Sections with their budget, their actual and the categories under them, plus
// every expense row so the totals can be opened up.
//
// A plain function, not a route handler, because BOTH the JSON endpoint and the
// Excel export build from it. Two code paths producing "the same" totals is how a
// spreadsheet somebody emailed out stops matching the screen it came from.
async function buildSheet(key) {
    const [{ rows: allRows }, { rows: budgets }, { rows: catBudgets }, catalog,
      { rows: relBudgets }, { rows: allReleases }] = await Promise.all([
      pool.query(SHEET_ROWS_SQL),
      pool.query(
        `SELECT section, amount::float8 AS amount, currency, note, updated_at,
                (SELECT name FROM users WHERE id = updated_by) AS updated_by_name
           FROM artist_budget_sections WHERE artist_key = $1`, [key]),
      pool.query(
        `SELECT category, amount::float8 AS amount, note, updated_at,
                (SELECT name FROM users WHERE id = updated_by) AS updated_by_name
           FROM artist_budget_categories WHERE artist_key = $1`, [key]),
      loadCategoryCatalog(),
      pool.query(
        `SELECT release_id, amount::float8 AS amount, note, updated_at,
                (SELECT name FROM users WHERE id = updated_by) AS updated_by_name
           FROM artist_budget_releases WHERE artist_key = $1`, [key]),
      // Every release this app knows about, with the artist it belongs to, so a
      // release with no spend YET is still a row to plan in — the same union
      // rule the category grain follows. `release_spend_plans` joins on so the
      // imported marketing sheet's own figure can sit beside what was typed.
      pool.query(
        `SELECT r.id, r.project_name, r.release_date, a.name AS artist_name,
                p.sheet_total::float8 AS sheet_total
           FROM releases r
           LEFT JOIN artists a ON a.id = r.artist_id
           LEFT JOIN release_spend_plans p
                  ON p.release_id = r.id AND p.match_status = 'matched'`),
    ]);
    const { sectionOf } = catalog;

    // Matched in JS on artistBucketKey, NOT in SQL on a name: the key folds
    // spelling and placeholders the same way the P&L rollup does, and a SQL
    // LOWER(TRIM()) match would split "Jerri" from "jerri ".
    const mine = allRows.filter((e) => artistBucketKey(e.artist) === key);
    const spellings = new Map();
    for (const e of mine) {
      const n = String(e.artist).trim();
      spellings.set(n, (spellings.get(n) || 0) + 1);
    }

    const budgetOf = new Map(budgets.map((b) => [b.section, b]));
    const sections = CATEGORY_GROUPS.expense.map(([sKey, label]) => ({
      key: sKey, label,
      // NOT the section's own stored amount. The budget is typed on the category
      // rows now and this figure is their sum, computed after the categories are
      // assembled below. `legacy_budget` is a stored section row from before
      // that change — zero rows exist in production, and it is added on top and
      // labelled rather than quietly dropped, because a budget that vanishes on
      // deploy is worse than one that needs explaining.
      budget: 0,
      legacy_budget: r2(budgetOf.get(sKey)?.amount || 0),
      note: budgetOf.get(sKey)?.note || null,
      updated_at: budgetOf.get(sKey)?.updated_at || null,
      updated_by_name: budgetOf.get(sKey)?.updated_by_name || null,
      spent: 0, open: 0, count: 0, open_count: 0,
      verified: 0, awaiting: 0, unverified: 0, unpaid: 0,
      categories: [],
    }));
    const sectionByKey = new Map(sections.map((s) => [s.key, s]));
    const catAcc = new Map();
    const relAcc = new Map();

    for (const e of mine) {
      const sKey = sectionOf(e.category);
      const s = sectionByKey.get(sKey);
      const usd = rowUsd(e);
      // SPENT is money that has left the bank. An unpaid invoice has not, so it
      // does not belong in a spend figure — it goes to OPEN and gets its own
      // section below. Jerri, before this split: $781,522 "spent", of which
      // $460,680 was invoices nobody had paid.
      const paid = e.payment_status === 'Paid';
      if (paid) { s.spent += usd; s.count += 1; }
      else { s.open += usd; s.open_count += 1; }

      if (e.bank_evidence) s.verified += usd;
      else if (!paid) s.unpaid += usd;
      else if (e.bank_expected) s.unverified += usd;
      else s.awaiting += usd;

      // A category row carries SPENT and OPEN in separate columns, exactly as
      // its section does, so each column still sums to the section figure above
      // it. The two are never added into one "actual" — the open-invoice
      // worklist below lists the same money BY PAYEE, and one amount looks like
      // two the moment a single column blends them.
      const cName = catalog.canonical(e.category) || String(e.category || '').trim() || '—';
      const cKey = `${sKey}||${cName}`;
      if (!catAcc.has(cKey)) {
        catAcc.set(cKey, { section: sKey, category: cName,
          spent: 0, open: 0, count: 0, open_count: 0 });
      }
      const c = catAcc.get(cKey);
      if (paid) { c.spent += usd; c.count += 1; }
      else { c.open += usd; c.open_count += 1; }

      // ── The OTHER partition: by release ──────────────────────────────────
      // Same rows, sliced the way the original spreadsheet slices them. `null`
      // is a real bucket, not a dropped row: 56% of an artist's spend names no
      // release, and a view that silently omitted it would report a third of
      // the money and look complete.
      const rKey = e.release_id == null ? 'none' : String(e.release_id);
      if (!relAcc.has(rKey)) {
        relAcc.set(rKey, { release_id: e.release_id ?? null,
          spent: 0, open: 0, count: 0, open_count: 0 });
      }
      const ra = relAcc.get(rKey);
      if (paid) { ra.spent += usd; ra.count += 1; }
      else { ra.open += usd; ra.open_count += 1; }

      e.amount_usd_calc = usd;
      e.section = sKey;
      e.budget_category = cName;
      e.is_open = !paid;
    }

    // ── The category rows ────────────────────────────────────────────────────
    // Three sources, unioned, because each one alone loses rows the sheet has to
    // show:
    //   the live vocabulary   a category with no spend YET is exactly what you
    //                         need a row for — it is the one you are planning
    //   anything with spend   including a category retired out of the vocabulary
    //   anything budgeted     so a typed number can never become invisible
    const catBudgetOf = new Map(
      catBudgets.map((b) => [String(b.category).trim().toLowerCase(), b]));
    const seen = new Set();
    const addCategory = (name, sKey, inCatalog = false) => {
      const dedupe = `${sKey}||${name}`;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      const acc = catAcc.get(dedupe) || { spent: 0, open: 0, count: 0, open_count: 0 };
      const b = catBudgetOf.get(name.toLowerCase());
      const budget = r2(b?.amount || 0);
      const spent = r2(acc.spent);
      const open = r2(acc.open);
      const committed = r2(spent + open);
      sectionByKey.get(sKey).categories.push({
        section: sKey, category: name,
        budget, spent, open, committed,
        variance: r2(budget - spent),
        pct: pctOf(spent, budget),
        count: acc.count, open_count: acc.open_count,
        note: b?.note || null,
        updated_at: b?.updated_at || null,
        updated_by_name: b?.updated_by_name || null,
        unplanned: budget === 0 && committed > 0,
        over_committed: budget > 0 && committed > budget,
        // False for a category that has spend or a budget but is no longer in
        // `bk_categories` — the grid marks it rather than offering it as a
        // normal place to plan new money.
        in_catalog: inCatalog,
      });
    };
    for (const c of catalog.catalog) addCategory(c.name, c.section, true);
    for (const c of catAcc.values()) addCategory(c.category, c.section);
    for (const b of catBudgets) {
      const name = String(b.category).trim();
      if (name) addCategory(name, sectionOf(name));
    }

    for (const s of sections) {
      // Catalog order first (the picker's own order, so the grid reads the way
      // the category menu does), then the off-catalog stragglers by size.
      const rank = (c) => (c.in_catalog ? 0 : 1);
      s.categories.sort((a, b) => rank(a) - rank(b) || (rank(a) ? b.committed - a.committed : 0));
      // THE SECTION IS THE SUM OF ITS CHILDREN. Typed at the category, derived
      // here — the one rule that makes this a budget sheet rather than two
      // numbers that disagree.
      s.budget = r2(s.categories.reduce((t, c) => t + c.budget, 0) + s.legacy_budget);
      s.verified = r2(s.verified); s.awaiting = r2(s.awaiting);
      s.unverified = r2(s.unverified); s.unpaid = r2(s.unpaid);
      // DERIVED from the states, so each partition holds by construction rather
      // than by luck — every row went in as an exact cent figure, so these are
      // exact sums of exact cents.
      //
      //   spent     = the three PAID states
      //   open      = the unpaid state, on its own
      //   committed = what the artist is on the hook for, in total
      s.spent = r2(s.verified + s.awaiting + s.unverified);
      s.open = r2(s.unpaid);
      s.committed = r2(s.spent + s.open);
      // Variance sits next to SPENT and therefore measures against it. Whether
      // the artist is over-committed is a different question and gets its own
      // flag, because a budget can be intact on spend and blown on commitments.
      s.variance = r2(s.budget - s.spent);
      s.pct = pctOf(s.spent, s.budget);
      s.over_committed = s.budget > 0 && s.committed > s.budget;
      s.unplanned = s.budget === 0 && s.committed > 0;
      s.budgeted_count = s.categories.filter((c) => c.budget > 0).length;
      s.active_count = s.categories.filter((c) => c.budget > 0 || c.committed > 0).length;
    }

    // ── The release rows ─────────────────────────────────────────────────────
    // Union of three sources, exactly as the category grain does: every release
    // this artist has (so one with no spend yet is still a row to plan in),
    // anything carrying spend, and anything carrying a budget.
    const relBudgetOf = new Map(relBudgets.map((b) => [Number(b.release_id), b]));
    const releaseInfo = new Map(allReleases.map((r) => [Number(r.id), r]));
    const mineReleaseIds = new Set();
    for (const r of allReleases) {
      if (artistBucketKey(r.artist_name) === key) mineReleaseIds.add(Number(r.id));
    }
    for (const k of relAcc.keys()) if (k !== 'none') mineReleaseIds.add(Number(k));
    for (const id of relBudgetOf.keys()) mineReleaseIds.add(Number(id));

    const releaseRow = (id) => {
      const info = releaseInfo.get(id) || {};
      const acc = relAcc.get(String(id)) || { spent: 0, open: 0, count: 0, open_count: 0 };
      const b = relBudgetOf.get(id);
      const budget = r2(b?.amount || 0);
      const spent = r2(acc.spent);
      const open = r2(acc.open);
      const committed = r2(spent + open);
      return {
        release_id: id,
        title: info.project_name || `Release #${id}`,
        release_date: info.release_date || null,
        // What the imported marketing sheet planned for this release, beside
        // what was typed here. Reported, never merged — the sheet is a record of
        // what was committed and this column is what somebody decided.
        sheet_total: info.sheet_total == null ? null : r2(info.sheet_total),
        budget, spent, open, committed,
        variance: r2(budget - spent),
        pct: pctOf(spent, budget),
        count: acc.count, open_count: acc.open_count,
        note: b?.note || null,
        updated_at: b?.updated_at || null,
        updated_by_name: b?.updated_by_name || null,
        unplanned: budget === 0 && committed > 0,
        over_committed: budget > 0 && committed > budget,
      };
    };
    const releases = [...mineReleaseIds].map(releaseRow)
      .sort((a, b) => b.committed - a.committed || b.budget - a.budget
        || String(a.title).localeCompare(String(b.title)));

    // The residual. READ-ONLY on purpose: it is what is left over, not a place
    // to plan, and offering a budget cell on it would invite somebody to plan
    // against "everything I have not attributed yet".
    const none = relAcc.get('none');
    const unassigned = {
      release_id: null,
      title: 'No release named',
      budget: 0,
      spent: r2(none?.spent || 0),
      open: r2(none?.open || 0),
      committed: r2((none?.spent || 0) + (none?.open || 0)),
      variance: 0, pct: null,
      count: none?.count || 0, open_count: none?.open_count || 0,
      unplanned: (none?.spent || 0) + (none?.open || 0) > 0,
      over_committed: false,
      read_only: true,
    };

    const sum = (f) => r2(sections.reduce((t, s) => t + s[f], 0));
    return {
      artist_key: key,
      artist: bestSpelling(spellings) || (await rosterNamesByKey()).get(key) || key,
      sections,
      releases,
      unassigned_release: unassigned,
      // The two partitions do not have to agree, and when they do not that is
      // information rather than a bug: it says the artist has been planned one
      // way and not the other. The sheet states both totals; it does not pick.
      release_totals: {
        budget: r2(releases.reduce((t, x) => t + x.budget, 0)),
        spent: r2(releases.reduce((t, x) => t + x.spent, 0) + unassigned.spent),
        open: r2(releases.reduce((t, x) => t + x.open, 0) + unassigned.open),
        committed: r2(releases.reduce((t, x) => t + x.committed, 0) + unassigned.committed),
        with_budget: releases.filter((x) => x.budget > 0).length,
        releases: releases.length,
        unassigned_spent: unassigned.spent,
      },
      rows: mine.sort((a, b) =>
        String(b.payment_date || b.invoice_date || '').localeCompare(
          String(a.payment_date || a.invoice_date || ''))),
      // Every open invoice, oldest first — the oldest is the one most likely to
      // be a surprise, and this section is a worklist as much as a total.
      open_rows: mine.filter((e) => e.is_open).sort((a, b) =>
        String(a.invoice_date || '').localeCompare(String(b.invoice_date || ''))),
      totals: {
        budget: sum('budget'),
        spent: sum('spent'), open: sum('open'), committed: sum('committed'),
        variance: sum('variance'),
        verified: sum('verified'), awaiting: sum('awaiting'),
        unverified: sum('unverified'), unpaid: sum('unpaid'),
        count: sections.reduce((t, s) => t + s.count, 0),
        open_count: sections.reduce((t, s) => t + s.open_count, 0),
        pct: pctOf(sum('spent'), sum('budget')),
        over_committed: sum('budget') > 0 && sum('committed') > sum('budget'),
        legacy_budget: sum('legacy_budget'),
      },
    };
}

router.get('/:artistKey', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const key = String(req.params.artistKey || '').trim();
    if (!key) return res.status(400).json({ success: false, error: 'artist key required' });
    res.json({ success: true, data: await buildSheet(key) });
  } catch (err) {
    console.error('GET /api/artist-budgets/:artistKey:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── The budget cells ─────────────────────────────────────────────────────────
//
// Registered BEFORE `/:artistKey/:section`, which would otherwise match
// `/Jerri/category` with section="category" and answer 400 for every write.
//
// The category travels in the BODY, not the path: five live category names
// contain a slash ("Software / Subscriptions", "Sync/Licensing"), and a path
// segment cannot carry one without every caller remembering to encode it.

/** Shared by the single write and the bulk paste. Throws a sentence. */
async function resolveCells(items, canonical) {
  const out = [];
  const seen = new Set();
  for (const raw of items) {
    const name = canonical(raw.category);
    if (!name) {
      const err = new Error(`"${String(raw.category || '').slice(0, 60)}" is not a category`);
      err.status = 400; throw err;
    }
    if (seen.has(name)) {
      const err = new Error(`${name} appears twice in one save`);
      err.status = 400; throw err;
    }
    seen.add(name);
    const amount = raw.amount === '' || raw.amount == null ? 0 : Number(raw.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      const err = new Error(`${name}: a budget is zero or more`);
      err.status = 400; throw err;
    }
    out.push({
      category: name,
      amount: r2(amount),
      note: raw.note == null ? null : String(raw.note).slice(0, 500) || null,
    });
  }
  return out;
}

// Zero DELETES the row rather than storing one, the same rule the section write
// has always followed: "no budget for this category" and "a budget of nothing"
// are one state, and a stored 0 would make an unplanned category read as a plan
// somebody made.
const writeCell = (q, key, c, userId) => (
  c.amount === 0 && !c.note
    ? q(`DELETE FROM artist_budget_categories WHERE artist_key = $1 AND category = $2`,
      [key, c.category])
    : q(`INSERT INTO artist_budget_categories
           (artist_key, category, amount, note, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (artist_key, category) DO UPDATE
           SET amount = EXCLUDED.amount, note = EXCLUDED.note,
               updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [key, c.category, c.amount, c.note, userId]));

// PUT /api/artist-budgets/:artistKey/category   { category, amount, note? }
router.put('/:artistKey/category', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const key = String(req.params.artistKey || '').trim();
    if (!key) return res.status(400).json({ success: false, error: 'artist key required' });
    const { canonical } = await loadCategoryCatalog();
    const [cell] = await resolveCells([req.body || {}], canonical);
    await writeCell((t, v) => pool.query(t, v), key, cell, req.user.id || null);
    res.json({ success: true, data: { artist_key: key, ...cell, cleared: cell.amount === 0 } });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ success: false, error: err.message });
    console.error('PUT /api/artist-budgets/:artistKey/category:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/artist-budgets/:artistKey/release  { release_id, amount, note? }
//
// The OTHER grain. Stored apart from the category budget because the two are
// different partitions of one artist's money, not a subdivision of each other —
// see the table's own note in index.js.
router.put('/:artistKey/release', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const key = String(req.params.artistKey || '').trim();
    if (!key) return res.status(400).json({ success: false, error: 'artist key required' });
    const releaseId = Number(req.body.release_id);
    if (!Number.isInteger(releaseId) || releaseId <= 0) {
      return res.status(400).json({ success: false, error: 'release_id required' });
    }
    // The release has to exist. The column is a foreign key, so an unknown id
    // would fail as a 500 with a constraint name in it — which tells a person
    // nothing.
    const { rows: rel } = await pool.query('SELECT id FROM releases WHERE id = $1', [releaseId]);
    if (!rel.length) return res.status(400).json({ success: false, error: 'that release does not exist' });

    const amount = req.body.amount === '' || req.body.amount == null ? 0 : Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ success: false, error: 'a budget is zero or more' });
    }
    const note = req.body.note == null ? null : String(req.body.note).slice(0, 500) || null;

    // Zero DELETES, the same rule both other grains follow: "no budget for this
    // release" and "a budget of nothing" stay one state, so `unplanned` keeps
    // meaning something.
    if (r2(amount) === 0 && !note) {
      await pool.query(
        'DELETE FROM artist_budget_releases WHERE artist_key = $1 AND release_id = $2',
        [key, releaseId]);
      return res.json({ success: true, data: { artist_key: key, release_id: releaseId, amount: 0, cleared: true } });
    }
    const { rows: [row] } = await pool.query(
      `INSERT INTO artist_budget_releases (artist_key, release_id, amount, note, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (artist_key, release_id) DO UPDATE
         SET amount = EXCLUDED.amount, note = EXCLUDED.note,
             updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING artist_key, release_id, amount::float8 AS amount, note`,
      [key, releaseId, r2(amount), note, req.user.id || null]);
    res.json({ success: true, data: row });
  } catch (err) {
    console.error('PUT /api/artist-budgets/:artistKey/release:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/artist-budgets/:artistKey/categories  { items: [{ category, amount }] }
//
// What a paste from Excel lands on. ONE TRANSACTION: a paste is a single edit in
// the user's head, and half of it applying would leave a sheet nobody typed —
// with no way to tell which half. Validation happens for every cell before any
// of them is written, so an unknown category in row 9 refuses the paste rather
// than committing rows 1-8 first.
router.put('/:artistKey/categories', async (req, res) => {
  let client;
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const key = String(req.params.artistKey || '').trim();
    if (!key) return res.status(400).json({ success: false, error: 'artist key required' });
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items || !items.length) {
      return res.status(400).json({ success: false, error: 'items required' });
    }
    // The grid has 32 rows. A request with hundreds is not a paste.
    if (items.length > 200) {
      return res.status(400).json({ success: false, error: 'too many cells in one save' });
    }
    const { canonical } = await loadCategoryCatalog();
    const cells = await resolveCells(items, canonical);

    client = await pool.connect();
    await client.query('BEGIN');
    for (const c of cells) await writeCell((t, v) => client.query(t, v), key, c, req.user.id || null);
    await client.query('COMMIT');
    res.json({ success: true, data: { artist_key: key, written: cells.length, cells } });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (err.status === 400) return res.status(400).json({ success: false, error: err.message });
    console.error('PUT /api/artist-budgets/:artistKey/categories:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (client) client.release();
  }
});

// ── PUT /api/artist-budgets/:artistKey/:section ──────────────────────────────
// One section's number, from before the budget moved to the category rows. The
// sheet no longer writes here and nothing in production ever did (zero rows),
// but the route stays and `buildSheet` still adds what it finds as
// `legacy_budget`, so a number typed through it is never invisible.
router.put('/:artistKey/:section', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const key = String(req.params.artistKey || '').trim();
    const section = String(req.params.section || '').trim();
    if (!key) return res.status(400).json({ success: false, error: 'artist key required' });
    if (!SECTION_LABEL.has(section)) {
      return res.status(400).json({ success: false,
        error: `section must be one of: ${SECTION_KEYS.join(', ')}` });
    }
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ success: false, error: 'amount must be zero or more' });
    }
    const note = req.body.note == null ? null : String(req.body.note).slice(0, 500) || null;

    // Zero DELETES the row rather than storing a zero, so "no budget for this
    // section" and "a budget of nothing" stay the same state — the sheet marks
    // spend in an unbudgeted section as unplanned, and a stored 0 would make that
    // read as a plan somebody made.
    if (amount === 0 && !note) {
      await pool.query(
        `DELETE FROM artist_budget_sections WHERE artist_key = $1 AND section = $2`, [key, section]);
      return res.json({ success: true, data: { artist_key: key, section, amount: 0, cleared: true } });
    }
    const { rows: [row] } = await pool.query(
      `INSERT INTO artist_budget_sections (artist_key, section, amount, note, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (artist_key, section) DO UPDATE
         SET amount = EXCLUDED.amount, note = EXCLUDED.note,
             updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING artist_key, section, amount::float8 AS amount, note`,
      [key, section, amount, note, req.user.id || null]);
    res.json({ success: true, data: row });
  } catch (err) {
    console.error('PUT /api/artist-budgets/:artistKey/:section:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/artist-budgets/:artistKey/export ────────────────────────────────
// The sheet as a workbook. John: internal, "but can be sent external" — so it has
// to stand on its own without the app around it.
//
// TWO sheets, because a summary alone is a number somebody has to trust: the
// second lists every expense behind it, with its state, so a recipient can see
// what the totals are made of.
router.get('/:artistKey/export', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const key = String(req.params.artistKey || '').trim();

    if (!key) return res.status(400).json({ success: false, error: 'artist key required' });
    // The SAME builder the page renders from. An export that re-derives its own
    // totals is an export that eventually disagrees with the screen, and this one
    // gets emailed outside the company.
    const d = await buildSheet(key);

    const money = '#,##0.00';
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Market Street';
    wb.created = new Date();

    const s1 = wb.addWorksheet('Budget vs spent');
    // The same columns the grid on screen has, in the same order. An export that
    // shows a subset invites the recipient to do the missing arithmetic
    // themselves, and this one gets emailed outside the company.
    s1.columns = [
      { header: '', key: 'label', width: 34 },
      { header: 'Budget', key: 'budget', width: 14, style: { numFmt: money } },
      { header: 'Spent', key: 'actual', width: 14, style: { numFmt: money } },
      { header: 'Open', key: 'open', width: 14, style: { numFmt: money } },
      { header: 'Committed', key: 'committed', width: 14, style: { numFmt: money } },
      { header: 'Variance', key: 'variance', width: 14, style: { numFmt: money } },
      { header: 'Note', key: 'note', width: 40 },
    ];
    s1.getRow(1).font = { bold: true };
    s1.addRow({ label: d.artist });
    s1.getRow(2).font = { bold: true, size: 14 };
    s1.addRow({});
    for (const sec of d.sections) {
      // A section with neither a budget nor spend is not part of this artist's
      // picture; printing six headers with zeros makes the sheet look unfinished.
      if (!sec.budget && !sec.committed) continue;
      const r = s1.addRow({
        label: sec.label.toUpperCase(),
        budget: sec.budget || null,
        actual: sec.spent || null,
        open: sec.open || null,
        committed: sec.committed || null,
        variance: sec.budget ? sec.variance : null,
        note: sec.over_committed ? 'over-committed once open invoices are paid'
          : sec.unplanned ? 'unplanned — no budget set' : (sec.note || ''),
      });
      r.font = { bold: true };
      // Same rule one level down: a category with nothing budgeted and nothing
      // spent is a row the grid offers you to TYPE in, which a printed workbook
      // has no use for.
      for (const c of sec.categories) {
        if (!c.budget && !c.committed) continue;
        s1.addRow({
          label: `    ${c.category}`,
          budget: c.budget || null,
          actual: c.spent || null,
          open: c.open || null,
          committed: c.committed || null,
          variance: c.budget ? c.variance : null,
          note: c.over_committed ? 'over-committed once open invoices are paid'
            : c.unplanned ? 'unplanned — no budget set' : (c.note || ''),
        });
      }
      if (sec.legacy_budget > 0) {
        s1.addRow({
          label: '    (section-level budget)', budget: sec.legacy_budget,
          note: 'typed before the budget moved to the category rows',
        });
      }
    }
    s1.addRow({});
    const tot = s1.addRow({
      label: 'SPENT', budget: d.totals.budget, actual: d.totals.spent,
      // Blank when there is no budget, exactly as the section rows above and
      // the COMMITTED row below already do.
      //
      // `d.totals.variance` is `budget - spent`, which is MINUS THE SPEND when
      // no budget exists — and none does yet for any of the 145 artists. This
      // row printed "-320,842.61" beside an empty budget column on Jerri's
      // sheet, which reads as overspending in a document that goes to the
      // accountant. Its two neighbours guarded; this one did not.
      variance: d.totals.budget ? d.totals.variance : null,
    });
    tot.font = { bold: true };
    tot.border = { top: { style: 'thin' } };
    s1.addRow({});

    // ── Open, unpaid invoices ────────────────────────────────────────────────
    // Money the label has agreed to pay and has not. It is NOT in Spent above —
    // an invoice sitting in a drawer is not an expenditure — so it gets its own
    // block, and the two are added into a committed total underneath.
    if (d.open_rows.length) {
      const oh = s1.addRow({ label: 'OPEN · UNPAID INVOICES' });
      oh.font = { bold: true };
      for (const o of d.open_rows) {
        s1.addRow({
          // The OPEN column, not Spent — these are the rows that are not spend,
          // which is the entire reason this block exists.
          label: `    ${o.payee || '—'}`,
          open: r2(o.amount_usd_calc),
          note: [String(o.invoice_date || '').slice(0, 10), o.category, o.song]
            .filter(Boolean).join(' · '),
        });
      }
      const ot = s1.addRow({ label: 'STILL TO PAY', open: d.totals.open });
      ot.font = { bold: true };
      ot.border = { top: { style: 'thin' } };
      s1.addRow({});
    }
    const ct = s1.addRow({
      label: 'COMMITTED (spent + open)', budget: d.totals.budget,
      committed: d.totals.committed,
      variance: d.totals.budget ? r2(d.totals.budget - d.totals.committed) : null,
      note: d.totals.over_committed ? 'over budget once the open invoices are paid' : '',
    });
    ct.font = { bold: true };
    ct.border = { top: { style: 'double' } };
    s1.addRow({});
    // The state split, spelled out in words rather than left to a colour.
    s1.addRow({ label: 'Of that spent — confirmed on a bank statement', actual: d.totals.verified });
    s1.addRow({ label: 'Of that spent — paid, statement not uploaded yet', actual: d.totals.awaiting });
    s1.addRow({ label: 'Of that spent — paid, but no matching bank line', actual: d.totals.unverified });
    s1.addRow({ label: 'Open — not paid yet', actual: d.totals.unpaid });

    // ── By release ───────────────────────────────────────────────────────────
    // The other partition, on its own sheet. The screen has both grains, so a
    // workbook with only one says less than the page it came from — and this is
    // the shape the label's own spreadsheet has always used (its hidden
    // Accounting tab is Artist | Project | Planned Marketing | Amount Spent |
    // Amount remaining).
    if (d.releases.length || d.unassigned_release.committed > 0) {
      const s3 = wb.addWorksheet('By release');
      s3.columns = [
        { header: 'Release', key: 'title', width: 38 },
        { header: 'Released', key: 'date', width: 12 },
        { header: 'Budget', key: 'budget', width: 14, style: { numFmt: money } },
        { header: 'Spent', key: 'spent', width: 14, style: { numFmt: money } },
        { header: 'Open', key: 'open', width: 14, style: { numFmt: money } },
        { header: 'Committed', key: 'committed', width: 14, style: { numFmt: money } },
        { header: 'Variance', key: 'variance', width: 14, style: { numFmt: money } },
        { header: 'Marketing sheet', key: 'sheet', width: 15, style: { numFmt: money } },
        { header: 'Note', key: 'note', width: 34 },
      ];
      s3.getRow(1).font = { bold: true };
      for (const r of d.releases) {
        if (!r.budget && !r.committed) continue;
        s3.addRow({
          title: r.title,
          date: r.release_date ? String(r.release_date).slice(0, 10) : '',
          budget: r.budget || null, spent: r.spent || null, open: r.open || null,
          committed: r.committed || null,
          variance: r.budget ? r.variance : null,
          sheet: r.sheet_total || null,
          note: r.over_committed ? 'over-committed once open invoices are paid'
            : r.unplanned ? 'unplanned — no budget set' : (r.note || ''),
        });
      }
      // The residual is a ROW, not a footnote. It is usually the biggest number
      // on this sheet — 56% of an artist's spend names no release — and a
      // workbook that omitted it would tie to nothing.
      const u = d.unassigned_release;
      if (u.committed > 0) {
        const ur = s3.addRow({
          title: 'No release named', spent: u.spent || null, open: u.open || null,
          committed: u.committed || null,
          note: 'spend on this artist that names no release — cannot be budgeted per release',
        });
        ur.font = { italic: true };
      }
      const rt = s3.addRow({
        title: 'TOTAL',
        budget: d.release_totals.budget || null,
        spent: d.release_totals.spent || null,
        open: d.release_totals.open || null,
        committed: d.release_totals.committed || null,
        variance: d.release_totals.budget ? r2(d.release_totals.budget - d.release_totals.spent) : null,
      });
      rt.font = { bold: true };
      rt.border = { top: { style: 'thin' } };
      // Said in the workbook too, for the same reason it is said on screen.
      if (d.release_totals.budget > 0 && d.totals.budget > 0
          && Math.abs(d.release_totals.budget - d.totals.budget) >= 0.005) {
        s3.addRow({});
        s3.addRow({ title: `Planned ${d.totals.budget.toFixed(2)} by category and `
          + `${d.release_totals.budget.toFixed(2)} by release — the same money split two ways.` });
      }
    }

    const s2 = wb.addWorksheet('Expenses');
    s2.columns = [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Payee', key: 'payee', width: 32 },
      { header: 'Category', key: 'category', width: 24 },
      { header: 'Section', key: 'section', width: 22 },
      { header: 'Song', key: 'song', width: 22 },
      { header: 'Amount', key: 'amount', width: 13, style: { numFmt: money } },
      { header: 'Cur', key: 'currency', width: 6 },
      { header: 'USD', key: 'usd', width: 13, style: { numFmt: money } },
      { header: 'Status', key: 'status', width: 30 },
      { header: 'Recoupable', key: 'recoupable', width: 11 },
    ];
    s2.getRow(1).font = { bold: true };
    const STATE_LABEL = {
      verified: 'Confirmed on a bank statement',
      awaiting_statement: 'Paid, statement not uploaded yet',
      unverified: 'Paid, but no matching bank line',
      unpaid: 'Not paid yet',
    };
    for (const e of d.rows) {
      const state = e.bank_evidence ? 'verified'
        : e.payment_status !== 'Paid' ? 'unpaid'
          : e.bank_expected ? 'unverified' : 'awaiting_statement';
      s2.addRow({
        date: String(e.payment_date || e.invoice_date || '').slice(0, 10),
        payee: e.payee || '', category: e.category || '',
        section: SECTION_LABEL.get(e.section) || '',
        song: e.song || '',
        amount: Number(e.amount) || 0, currency: e.currency || 'USD',
        usd: r2(e.amount_usd_calc), status: STATE_LABEL[state],
        recoupable: e.recoupable ? 'Yes' : 'No',
      });
    }

    const safe = String(d.artist).replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'artist';
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="${safe} - budget vs actual.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('GET /api/artist-budgets/:artistKey/export:', err);
    if (!res.headersSent) res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.SHEET_ROWS_SQL = SHEET_ROWS_SQL;
