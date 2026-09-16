/**
 * Bookkeeping category vocabularies — expense categories and income types.
 *
 * These used to be hardcoded constants mirrored in client/src/constants.js
 * and server/lib/constants.js. They're now rows in bk_categories, seeded from
 * those same constants on startup, so a category can be added from Statements
 * or Reports at the moment someone discovers they need it.
 *
 * The constants stay in place as the seed AND as the client's offline
 * fallback — same arrangement as boom_reps / BOOM_REPS.
 *
 * IMPORTANT: this table lists the dropdown OPTIONS. It is not a constraint on
 * stored data. expenses.category and artist_income.income_type are free text
 * and historical rows can hold values no longer offered (or never offered).
 * Never use this list to reject a write or rewrite a stored row — that would
 * silently recategorize history.
 */

const express = require('express');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { CATEGORIES, INCOME_CATEGORIES, CATEGORY_GROUPS } = require('../lib/constants');

const router = express.Router();

const KINDS = new Set(['expense', 'income']);
const isBkAdmin = (u) => u && ['Admin', 'Superadmin', 'Approver'].includes(u.role);

// Deliberately PUBLIC, exactly like GET /api/reps.
//
// The public vendor-submit form (/submit) renders a category dropdown and has
// no session, so an authed endpoint would leave it stuck on the build-time
// constant while everyone else saw the live list. Category names are already
// public via that form, so serving them adds no disclosure.
//
// Writes below are admin-gated.
router.get('/', async (req, res) => {
  try {
    // sort_order carries the shipped sequence (most-used first, 'Other' last);
    // it is NOT alphabetical, and shouldn't be. Custom categories have a NULL
    // sort_order and land after the seeded ones, alphabetically among
    // themselves. The deck's 1-9 hotkeys index this order, so changing it
    // changes what a number key picks.
    // ORDERED BY WHAT THE LABEL ACTUALLY USES, most first.
    //
    // John: "recommend the most used over other categories." The shipped
    // sort_order is a curated guess made once; the ledger knows the answer —
    // Marketing carries 1,256 rows and Design carries 1, and a picker that lists
    // them in the same relative position as on day one is ignoring that.
    //
    // sort_order remains the TIEBREAK, so categories with no usage keep their
    // curated sequence among themselves rather than falling into alphabetical
    // order.
    //
    // Safe for the review decks' 1-9 hotkeys, and that pairing has broken once
    // before: CategorySelect REQUIRES an explicit `options` list whenever
    // `numbered` is set, and both decks pass their own already-ranked list
    // (BkBankMatching.jsx:3742/3810, Reports.jsx:2701). Checked before changing
    // this, not after.
    //
    // The count is ordered BY but never returned. This route is deliberately
    // unauthenticated for the public vendor-submit form; the names are already
    // public there, per-category row counts are not.
    const { rows } = await pool.query(
      `SELECT c.name, c.kind, c.seeded, c.ui_group
         FROM bk_categories c
         LEFT JOIN (
           SELECT LOWER(TRIM(category)) AS k, COUNT(*)::int AS n
             FROM expenses
            WHERE (deleted = false OR deleted IS NULL)
              AND (voided = false OR voided IS NULL)
            GROUP BY 1
         ) eu ON eu.k = LOWER(TRIM(c.name)) AND c.kind = 'expense'
         LEFT JOIN (
           SELECT LOWER(TRIM(income_type)) AS k, COUNT(*)::int AS n
             FROM artist_income
            GROUP BY 1
         ) iu ON iu.k = LOWER(TRIM(c.name)) AND c.kind = 'income'
        WHERE c.active = TRUE
        ORDER BY c.kind ASC,
                 COALESCE(eu.n, iu.n, 0) DESC,
                 c.sort_order ASC NULLS LAST,
                 c.name ASC`)
      // Usage ranking is a nicety; the vocabulary is not. If the join fails for
      // any reason, serve the curated order rather than an empty dropdown.
      .catch(async (err) => {
        console.error('category usage ranking unavailable — using sort_order:', err.message);
        return pool.query(
          `SELECT name, kind, seeded FROM bk_categories
            WHERE active = TRUE
            ORDER BY kind ASC, sort_order ASC NULLS LAST, name ASC`);
      });
    const expense = rows.filter((r) => r.kind === 'expense').map((r) => r.name);
    const income = rows.filter((r) => r.kind === 'income').map((r) => r.name);

    // ── The sections, and the flat order derived FROM them ────────────────────
    //
    // A 32-item flat list is what prompted this: ranked by real usage, but the
    // ranking is global while a picker is contextual, so the approvals screen led
    // with five categories that have never once been used on a vendor invoice.
    //
    // `groups` renders; `order` is `groups.flatMap(items)` and nothing else. It
    // exists because CategorySelect numbers its options BY INDEX for the review
    // decks' 1-9 hotkeys, and the decks resolve a keypress by the same index — so
    // a rendered order and a numbering order that are computed separately WILL
    // drift, and did once already ("1 · Recording" in the menu while pressing 1
    // picked something else). Deriving one from the other makes that impossible.
    //
    // Rows arrive already sorted by usage, so pushing them into buckets in arrival
    // order preserves the ranking INSIDE each group for free.
    const shape = (kind, names) => {
      const defs = CATEGORY_GROUPS[kind] || [];
      const bucket = new Map(defs.map(([key]) => [key, []]));
      const byName = new Map(rows.filter((r) => r.kind === kind).map((r) => [r.name, r]));
      for (const name of names) {
        // An unknown or NULL ui_group lands in the LAST group rather than being
        // dropped: a picker that silently omits a value invites a wrong pick.
        const key = byName.get(name)?.ui_group;
        const target = bucket.has(key) ? key : defs[defs.length - 1]?.[0];
        if (target != null) bucket.get(target).push(name);
      }
      const groups = defs
        .map(([key, label]) => ({ key, label, items: bucket.get(key) || [] }))
        .filter((g) => g.items.length > 0);
      return { groups, order: groups.flatMap((g) => g.items) };
    };

    // Fall back to the constants if the table is somehow empty (fresh DB
    // where the seed hasn't run yet) so dropdowns are never blank.
    const expenseNames = expense.length ? expense : CATEGORIES;
    const incomeNames = income.length ? income : INCOME_CATEGORIES;
    const expenseShape = shape('expense', expenseNames);
    const incomeShape = shape('income', incomeNames);
    res.json({
      success: true,
      data: {
        // `expense` / `income` keep meaning exactly what they meant: the flat,
        // usage-ranked vocabulary. A dozen callers read them and none has to
        // change. `*_groups` is additive, and `*_order` is the flat list in
        // RENDERED order for anything that numbers its options.
        expense: expenseNames,
        income: incomeNames,
        expense_groups: expenseShape.groups,
        income_groups: incomeShape.groups,
        expense_order: expenseShape.order,
        income_order: incomeShape.order,
        custom: rows.filter((r) => !r.seeded).map((r) => ({ name: r.name, kind: r.kind })),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/categories  { name, kind }
router.post('/', authMiddleware, async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const kind = String(req.body.kind || '').trim().toLowerCase();
    if (!KINDS.has(kind)) {
      return res.status(400).json({ success: false, error: "kind must be 'expense' or 'income'" });
    }
    // Collapse internal whitespace so " Podcast   Ads " and "Podcast Ads"
    // can't become two categories that read identically in a report.
    const name = String(req.body.name || '').replace(/\s+/g, ' ').trim();
    if (name.length < 2) return res.status(400).json({ success: false, error: 'Name is too short' });
    if (name.length > 64) return res.status(400).json({ success: false, error: 'Name is too long (64 max)' });

    // Reject a case-insensitive near-duplicate with a message that names the
    // existing one, rather than silently doing nothing — the caller asked for
    // a new category and deserves to know why they didn't get one.
    const { rows: [dupe] } = await pool.query(
      `SELECT name, active FROM bk_categories
        WHERE kind = $1 AND LOWER(TRIM(name)) = LOWER($2)`, [kind, name]);
    if (dupe) {
      if (!dupe.active) {
        // Reactivate rather than error — an admin re-adding a name they
        // previously retired clearly wants it back.
        await pool.query(
          `UPDATE bk_categories SET active = TRUE WHERE kind = $1 AND name = $2`,
          [kind, dupe.name]);
        return res.json({ success: true, data: { name: dupe.name, kind, reactivated: true } });
      }
      return res.status(409).json({ success: false, error: `“${dupe.name}” already exists` });
    }

    await pool.query(
      `INSERT INTO bk_categories (name, kind, seeded, created_by) VALUES ($1, $2, FALSE, $3)`,
      [name, kind, req.user.id || null]);
    await pool.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1,'category_created',NULL,NULL,$2,NULL,$3,'Created from the bookkeeping UI')`,
      [req.user.name, kind === 'income' ? 'income_type' : 'category', name]).catch(() => {});

    res.json({ success: true, data: { name, kind } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/categories  { name, kind, active }
// Deactivating only removes a category from future dropdowns. Rows already
// carrying it keep it, and it still renders wherever it's stored — see the
// off-list handling in the client's useCategories consumers.
router.patch('/', authMiddleware, async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const kind = String(req.body.kind || '').trim().toLowerCase();
    if (!KINDS.has(kind)) {
      return res.status(400).json({ success: false, error: "kind must be 'expense' or 'income'" });
    }
    const name = String(req.body.name || '').trim();
    const active = req.body.active !== false;

    // COUNTED FIRST, and it decides whether the write happens.
    //
    // This used to deactivate and then report the usage, which is the wrong
    // order for a number that should stop you: "Marketing" was hidden while
    // 1,349 live rows carried it, so it vanished from every dropdown in the app
    // while remaining the largest category in the ledger. Recategorizing was
    // then impossible — the picker offered to CREATE the category you were
    // looking at.
    //
    // Deactivating an UNUSED category is still one call. Deactivating one with
    // live rows needs confirm_in_use, because the consequence is not "tidier
    // dropdowns", it is "this label can no longer be applied to anything".
    const { rows: [usage] } = kind === 'income'
      ? await pool.query(
        `SELECT COUNT(*)::int AS n FROM artist_income WHERE LOWER(TRIM(income_type)) = LOWER($1)`, [name])
      : await pool.query(
        `SELECT COUNT(*)::int AS n FROM expenses
          WHERE LOWER(TRIM(category)) = LOWER($1)
            AND (deleted = false OR deleted IS NULL)`, [name]);
    if (!active && usage.n > 0 && req.body.confirm_in_use !== true) {
      return res.status(400).json({
        success: false,
        in_use: usage.n,
        error: `"${name}" is still on ${usage.n} live ${kind === 'income' ? 'income row' : 'expense'}${usage.n === 1 ? '' : 's'}. `
          + 'Hiding it removes it from every dropdown, so those rows keep the label and nothing can be given it again — '
          + 'including when you try to recategorize one of them. Rename or merge it instead, '
          + 'or pass confirm_in_use to hide it anyway.',
      });
    }

    const { rowCount } = await pool.query(
      `UPDATE bk_categories SET active = $1 WHERE kind = $2 AND LOWER(TRIM(name)) = LOWER($3)`,
      [active, kind, name]);
    if (!rowCount) return res.status(404).json({ success: false, error: 'Category not found' });
    await pool.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1,$2,NULL,NULL,$3,NULL,$4,$5)`,
      [req.user.name, active ? 'category_reactivated' : 'category_deactivated',
        kind === 'income' ? 'income_type' : 'category', name,
        `${usage.n} row${usage.n === 1 ? '' : 's'} still use this category`]).catch(() => {});

    res.json({ success: true, data: { name, kind, active, in_use: usage.n } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
