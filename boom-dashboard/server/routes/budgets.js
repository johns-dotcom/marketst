/**
 * Recording budgets — a first-class budget feature modeled on the
 * label's Recording Budget (Budget/Fund) and Costs-to-Date Excel
 * templates. Two data tables:
 *   recording_budgets           — one row per budget (header + status)
 *   recording_budget_line_items — grouped by section under a budget
 *
 * Sections are hard-coded to match the templates exactly:
 *   producers · studio · mixing_mastering · musicians · travel · other
 *
 * Statuses: draft → approved → locked. Draft = fully editable.
 * Approved = amounts locked, line items still addable with a note.
 * Locked = frozen.
 */

const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const { CATEGORIES } = require('../lib/constants');
// Audit trail for budget mutations is handled by the app-wide
// activityLogger middleware (mounted globally in server/index.js);
// this router doesn't need to emit its own log lines.
const logActivity = async () => {};

const router = express.Router();
router.use(auth);

// Section catalog — kept as a Set for validation. The client renders
// them in this same order. Keep in sync with the CHECK constraint on
// recording_budget_line_items.section.
const SECTIONS = ['producers', 'studio', 'mixing_mastering', 'musicians', 'travel', 'other'];
const SECTION_SET = new Set(SECTIONS);

// Section → default ledger category mapping. Used to give budget
// line items a sensible starting category for the Costs-to-Date
// rollup (which groups by ledger category, not by section). Users
// can override on any line item via the `category` field.
const SECTION_TO_DEFAULT_CATEGORY = {
  producers:        'Production',
  studio:           'Recording',
  mixing_mastering: 'Mixing & Mastering',
  musicians:        'Services',
  travel:           'Tour/Live',
  other:            'Other',
};

// Ledger categories, READ FROM THE TABLE.
//
// This used to be a hardcoded Set "kept in sync with the CATEGORIES constant on
// the client" — a seventh copy of the vocabulary, and it had drifted: it still
// listed PR, Design, Music Video and Merch (deactivated when the six redundant
// categories were merged) and knew about none of the four `Artist Expense - *`
// categories, True Legal, Partner - *, Studio House, Bookkeeper or Credit Card.
//
// Worse than stale, it was used to REJECT a write (`PUT /expense/:id/section`
// returned "invalid category"), which is the one thing the categories rule
// forbids outright: the table lists dropdown OPTIONS and is never a constraint on
// stored data. An operator categorizing a budget row as `Artist Expense -
// Recording` — a live category with 63 ledger rows behind it — got a 400.
//
// Falls open on a read failure rather than rejecting everything: refusing every
// override because a SELECT failed is worse than accepting one that is unusual.
async function isKnownLedgerCategory(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM bk_categories
        WHERE kind = 'expense' AND LOWER(TRIM(name)) = LOWER($1) LIMIT 1`, [v]);
    return rows.length > 0;
  } catch (err) {
    console.error('category validation unavailable — accepting the override:', err.message);
    return true;
  }
}

// The label list the costs-to-date rollup offers. Same source, ordered the way
// /api/categories orders it, with a constant fallback so a failed read never
// empties a dropdown.
async function ledgerCategoryLabels() {
  try {
    const { rows } = await pool.query(
      `SELECT name FROM bk_categories
        WHERE kind = 'expense' AND active = TRUE
        ORDER BY sort_order ASC NULLS LAST, name ASC`);
    if (rows.length) return rows.map((r) => r.name);
  } catch (err) {
    console.error('category labels unavailable — using the constant:', err.message);
  }
  return [...CATEGORIES];
}

// Small helpers for consistent status transitions + audit fields.
function isValidStatus(s) { return s === 'draft' || s === 'approved' || s === 'locked'; }
function nowIso() { return new Date().toISOString(); }

// ── GET /api/budgets ────────────────────────────────────────────────
// List all recording budgets with rolled-up header stats. Small
// enough to return uncapped for now (a label typically has <200
// active budgets at any time). If this grows we'll paginate.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        b.id, b.artist_id, b.release_id,
        COALESCE(a.name, b.artist_name) AS artist_display,
        b.artist_name, b.project_title,
        b.type, b.currency, b.advance_amount, b.fund_amount,
        b.proposed_tracks, b.contingency_pct, b.status,
        b.created_at, b.updated_at, b.approved_at, b.locked_at,
        (SELECT name FROM users WHERE id = b.created_by)  AS created_by_name,
        (SELECT name FROM users WHERE id = b.approved_by) AS approved_by_name,
        (SELECT name FROM users WHERE id = b.locked_by)   AS locked_by_name,
        -- Rolled-up sum of line items × (1 + contingency%). Excludes
        -- contingency when contingency_pct is NULL so a legacy 0/blank
        -- budget doesn't inflate.
        COALESCE(
          (SELECT SUM(li.amount) FROM recording_budget_line_items li WHERE li.budget_id = b.id),
          0
        )::float AS sections_subtotal,
        (SELECT COUNT(*) FROM recording_budget_line_items li WHERE li.budget_id = b.id)::int AS line_item_count
      FROM recording_budgets b
      LEFT JOIN artists a ON a.id = b.artist_id
      ORDER BY b.updated_at DESC, b.id DESC
    `);
    // Compute total_budget = sections_subtotal * (1 + contingency%/100).
    // Store both for the client so it doesn't have to redo the math.
    const enriched = rows.map(r => {
      const subtotal = Number(r.sections_subtotal) || 0;
      const pct = Number(r.contingency_pct) || 0;
      const contingency = subtotal * (pct / 100);
      const total = subtotal + contingency;
      return {
        ...r,
        sections_subtotal: subtotal,
        contingency_amount: contingency,
        total_budget: total,
      };
    });
    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('GET /api/budgets:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/budgets/:id ────────────────────────────────────────────
// Full budget with line items grouped by section. Sections are always
// present in the response even when empty, so the client can render
// all six section tables consistently.
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'invalid id' });
  try {
    const [budgetRes, itemsRes] = await Promise.all([
      pool.query(`
        SELECT
          b.*,
          COALESCE(a.name, b.artist_name) AS artist_display,
          r.project_name AS release_display,
          (SELECT name FROM users WHERE id = b.created_by)  AS created_by_name,
          (SELECT name FROM users WHERE id = b.updated_by)  AS updated_by_name,
          (SELECT name FROM users WHERE id = b.approved_by) AS approved_by_name,
          (SELECT name FROM users WHERE id = b.locked_by)   AS locked_by_name
        FROM recording_budgets b
        LEFT JOIN artists a  ON a.id = b.artist_id
        LEFT JOIN releases r ON r.id = b.release_id
        WHERE b.id = $1
      `, [id]),
      pool.query(`
        SELECT id, section, description, qty, unit_price, amount, notes, sort_order
          FROM recording_budget_line_items
         WHERE budget_id = $1
         ORDER BY section, sort_order, id
      `, [id]),
    ]);
    if (!budgetRes.rows.length) return res.status(404).json({ success: false, error: 'not found' });
    const budget = budgetRes.rows[0];
    // Section groups — always emit all six, even when empty, so the
    // client's grid layout doesn't have to defensively fallback.
    const bySection = Object.fromEntries(SECTIONS.map(s => [s, []]));
    for (const item of itemsRes.rows) {
      if (bySection[item.section]) bySection[item.section].push(item);
    }
    const subtotal = itemsRes.rows.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    const pct = Number(budget.contingency_pct) || 0;
    const contingency = subtotal * (pct / 100);
    res.json({ success: true, data: {
      ...budget,
      sections: bySection,
      section_totals: Object.fromEntries(
        SECTIONS.map(s => [s, bySection[s].reduce((sum, i) => sum + (Number(i.amount) || 0), 0)])
      ),
      sections_subtotal: subtotal,
      contingency_amount: contingency,
      total_budget: subtotal + contingency,
    }});
  } catch (err) {
    console.error('GET /api/budgets/:id:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/budgets ───────────────────────────────────────────────
// Create a new draft budget. All meaningful fields are optional at
// create time so users can start with just an artist name and fill
// in the rest later.
router.post('/', async (req, res) => {
  try {
    const {
      artist_id, release_id, artist_name, project_title,
      type = 'budget', currency = 'USD',
      advance_amount = 0, fund_amount = 0,
      proposed_tracks = null, contingency_pct = 7.5,
    } = req.body || {};
    if (type !== 'budget' && type !== 'fund') {
      return res.status(400).json({ success: false, error: 'type must be budget or fund' });
    }
    const { rows } = await pool.query(`
      INSERT INTO recording_budgets
        (artist_id, release_id, artist_name, project_title, type, currency,
         advance_amount, fund_amount, proposed_tracks, contingency_pct,
         created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
      RETURNING *
    `, [
      artist_id || null, release_id || null,
      artist_name || null, project_title || null,
      type, currency,
      Number(advance_amount) || 0, Number(fund_amount) || 0,
      proposed_tracks ? Number(proposed_tracks) : null,
      Number(contingency_pct) || 7.5,
      req.user?.id || null,
    ]);
    await logActivity(req, 'budget_created', { budget_id: rows[0].id, artist_name, project_title, type });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /api/budgets:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PUT /api/budgets/:id ────────────────────────────────────────────
// Partial-update the header. Rejects amount changes on locked
// budgets; allows notes / metadata updates always. On approved
// budgets, amount changes are allowed (approval doesn't freeze
// them — see design doc) but flagged in the audit log.
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'invalid id' });
  try {
    const cur = await pool.query('SELECT * FROM recording_budgets WHERE id = $1', [id]);
    if (!cur.rows.length) return res.status(404).json({ success: false, error: 'not found' });
    if (cur.rows[0].status === 'locked') {
      return res.status(403).json({ success: false, error: 'budget is locked — unlock to edit' });
    }
    const fields = [
      'artist_id', 'release_id', 'artist_name', 'project_title',
      'type', 'currency', 'advance_amount', 'fund_amount',
      'proposed_tracks', 'contingency_pct',
    ];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, f)) {
        params.push(req.body[f] === '' ? null : req.body[f]);
        sets.push(`${f} = $${params.length}`);
      }
    }
    if (!sets.length) return res.json({ success: true, data: cur.rows[0] });
    params.push(req.user?.id || null);
    sets.push(`updated_by = $${params.length}`);
    sets.push(`updated_at = NOW()`);
    params.push(id);
    const { rows } = await pool.query(
      `UPDATE recording_budgets SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    await logActivity(req, 'budget_updated', { budget_id: id });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('PUT /api/budgets/:id:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /api/budgets/:id ─────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'invalid id' });
  try {
    const cur = await pool.query('SELECT * FROM recording_budgets WHERE id = $1', [id]);
    if (!cur.rows.length) return res.status(404).json({ success: false, error: 'not found' });
    if (cur.rows[0].status === 'locked') {
      return res.status(403).json({ success: false, error: 'budget is locked — unlock to delete' });
    }
    await pool.query('DELETE FROM recording_budgets WHERE id = $1', [id]);
    await logActivity(req, 'budget_deleted', { budget_id: id, artist_name: cur.rows[0].artist_name });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/budgets/:id:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Status transitions ─────────────────────────────────────────────
// draft → approved  (POST /:id/approve)
// approved → locked (POST /:id/lock)
// any → draft       (POST /:id/reopen)
router.post('/:id/approve', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'invalid id' });
  try {
    const { rows } = await pool.query(`
      UPDATE recording_budgets
         SET status = 'approved',
             approved_by = $1, approved_at = NOW(),
             updated_by = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *
    `, [req.user?.id || null, id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'not found' });
    await logActivity(req, 'budget_approved', { budget_id: id });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /api/budgets/:id/approve:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});
router.post('/:id/lock', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'invalid id' });
  try {
    const { rows } = await pool.query(`
      UPDATE recording_budgets
         SET status = 'locked',
             locked_by = $1, locked_at = NOW(),
             updated_by = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *
    `, [req.user?.id || null, id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'not found' });
    await logActivity(req, 'budget_locked', { budget_id: id });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /api/budgets/:id/lock:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});
router.post('/:id/reopen', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'invalid id' });
  try {
    const { rows } = await pool.query(`
      UPDATE recording_budgets
         SET status = 'draft',
             approved_by = NULL, approved_at = NULL,
             locked_by   = NULL, locked_at   = NULL,
             updated_by = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *
    `, [req.user?.id || null, id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'not found' });
    await logActivity(req, 'budget_reopened', { budget_id: id });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /api/budgets/:id/reopen:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Line items ─────────────────────────────────────────────────────
router.post('/:id/line-items', async (req, res) => {
  const budgetId = parseInt(req.params.id, 10);
  if (!Number.isFinite(budgetId)) return res.status(400).json({ success: false, error: 'invalid id' });
  try {
    const cur = await pool.query('SELECT status FROM recording_budgets WHERE id = $1', [budgetId]);
    if (!cur.rows.length) return res.status(404).json({ success: false, error: 'not found' });
    if (cur.rows[0].status === 'locked') {
      return res.status(403).json({ success: false, error: 'budget is locked' });
    }
    const { section, description = '', qty = 1, unit_price = 0, notes = null, sort_order = 0 } = req.body || {};
    if (!SECTION_SET.has(section)) {
      return res.status(400).json({ success: false, error: 'invalid section' });
    }
    const qtyN = Number(qty) || 0;
    const priceN = Number(unit_price) || 0;
    const amount = qtyN * priceN;
    const { rows } = await pool.query(`
      INSERT INTO recording_budget_line_items
        (budget_id, section, description, qty, unit_price, amount, notes, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [budgetId, section, description, qtyN, priceN, amount, notes, Number(sort_order) || 0]);
    // Touch parent updated_at so the list view resorts freshly-touched
    // budgets to the top.
    await pool.query(`UPDATE recording_budgets SET updated_at = NOW(), updated_by = $1 WHERE id = $2`,
      [req.user?.id || null, budgetId]);
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /api/budgets/:id/line-items:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/:id/line-items/:itemId', async (req, res) => {
  const budgetId = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);
  if (!Number.isFinite(budgetId) || !Number.isFinite(itemId)) {
    return res.status(400).json({ success: false, error: 'invalid id' });
  }
  try {
    const cur = await pool.query('SELECT status FROM recording_budgets WHERE id = $1', [budgetId]);
    if (!cur.rows.length) return res.status(404).json({ success: false, error: 'not found' });
    if (cur.rows[0].status === 'locked') {
      return res.status(403).json({ success: false, error: 'budget is locked' });
    }
    // Only fields the caller passed get updated; amount is recomputed
    // from qty × unit_price whenever either changes.
    const cur2 = await pool.query('SELECT * FROM recording_budget_line_items WHERE id = $1 AND budget_id = $2', [itemId, budgetId]);
    if (!cur2.rows.length) return res.status(404).json({ success: false, error: 'line item not found' });
    const existing = cur2.rows[0];
    const next = {
      section:     Object.prototype.hasOwnProperty.call(req.body || {}, 'section')     ? req.body.section     : existing.section,
      description: Object.prototype.hasOwnProperty.call(req.body || {}, 'description') ? req.body.description : existing.description,
      qty:         Object.prototype.hasOwnProperty.call(req.body || {}, 'qty')         ? Number(req.body.qty) || 0 : Number(existing.qty),
      unit_price:  Object.prototype.hasOwnProperty.call(req.body || {}, 'unit_price')  ? Number(req.body.unit_price) || 0 : Number(existing.unit_price),
      notes:       Object.prototype.hasOwnProperty.call(req.body || {}, 'notes')       ? req.body.notes       : existing.notes,
      sort_order:  Object.prototype.hasOwnProperty.call(req.body || {}, 'sort_order')  ? Number(req.body.sort_order) || 0 : Number(existing.sort_order),
    };
    if (!SECTION_SET.has(next.section)) {
      return res.status(400).json({ success: false, error: 'invalid section' });
    }
    next.amount = next.qty * next.unit_price;
    const { rows } = await pool.query(`
      UPDATE recording_budget_line_items
         SET section = $1, description = $2, qty = $3, unit_price = $4,
             amount = $5, notes = $6, sort_order = $7
       WHERE id = $8 AND budget_id = $9
       RETURNING *
    `, [next.section, next.description, next.qty, next.unit_price, next.amount, next.notes, next.sort_order, itemId, budgetId]);
    await pool.query(`UPDATE recording_budgets SET updated_at = NOW(), updated_by = $1 WHERE id = $2`,
      [req.user?.id || null, budgetId]);
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('PUT /api/budgets/:id/line-items/:itemId:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/:id/line-items/:itemId', async (req, res) => {
  const budgetId = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);
  if (!Number.isFinite(budgetId) || !Number.isFinite(itemId)) {
    return res.status(400).json({ success: false, error: 'invalid id' });
  }
  try {
    const cur = await pool.query('SELECT status FROM recording_budgets WHERE id = $1', [budgetId]);
    if (!cur.rows.length) return res.status(404).json({ success: false, error: 'not found' });
    if (cur.rows[0].status === 'locked') {
      return res.status(403).json({ success: false, error: 'budget is locked' });
    }
    await pool.query('DELETE FROM recording_budget_line_items WHERE id = $1 AND budget_id = $2', [itemId, budgetId]);
    await pool.query(`UPDATE recording_budgets SET updated_at = NOW(), updated_by = $1 WHERE id = $2`,
      [req.user?.id || null, budgetId]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/budgets/:id/line-items/:itemId:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Costs to Date ──────────────────────────────────────────────────
// GET /api/budgets/:id/actuals
//
// Groups planned + spent by LEDGER CATEGORY (Advance, Marketing,
// Legal, Recording, etc.) rather than by the 6-section recording-
// template enum. Budget line items map to a category via the
// line_item's own `category` field, falling back to the default
// derived from its section. Expenses use their own `category`,
// overridable per-row via expenses.budget_section_override
// (repurposed to store a category name).
//
// Returns:
//   - by_category: { [category]: { planned, spent, remaining, count } }
//   - all:         full ledger row list with default_category + override
//   - summary:     top-of-page fund/budget math
router.get('/:id/actuals', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'invalid id' });
  try {
    const budgetRes = await pool.query('SELECT * FROM recording_budgets WHERE id = $1', [id]);
    if (!budgetRes.rows.length) return res.status(404).json({ success: false, error: 'not found' });
    const budget = budgetRes.rows[0];

    // Resolve the artist name to match on.
    const matchName = budget.artist_id
      ? (await pool.query('SELECT name FROM artists WHERE id = $1', [budget.artist_id])).rows[0]?.name
      : budget.artist_name;
    if (!matchName) {
      return res.json({ success: true, data: {
        by_category: {}, all: [], match_name: null,
        summary: budget.type === 'fund'
          ? { fund: 0, advance: 0, remainder_after_advance: 0, spent: 0, balance_of_fund: 0 }
          : { budget_planned: 0, spent: 0, remaining: 0 },
        category_labels: await ledgerCategoryLabels(),
      }});
    }
    // Ledger expense scope — approved, non-deleted, non-voided,
    // parent-only. Optionally scoped to the release for release-linked
    // budgets.
    const params = [matchName];
    let releaseClause = '';
    if (budget.release_id) {
      params.push(budget.release_id);
      releaseClause = `AND (e.release_id = $${params.length} OR e.release_id IS NULL)`;
    }
    const { rows: expenses } = await pool.query(`
      SELECT
        e.id, e.invoice_date, e.payee, e.artist, e.song, e.category,
        e.amount, e.currency, e.payment_status, e.payment_date,
        (e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1))::float AS amount_usd,
        e.budget_section_override AS budget_category_override
      FROM expenses e
      WHERE e.status = 'approved'
        AND (e.deleted IS NULL OR e.deleted = FALSE)
        AND (e.voided  IS NULL OR e.voided  = FALSE)
        AND e.parent_id IS NULL
        AND LOWER(TRIM(e.artist)) = LOWER(TRIM($1))
        ${releaseClause}
      ORDER BY COALESCE(e.payment_date, e.invoice_date, e.created_at::date) DESC
    `, params);

    // Per-category planned. Line items with an explicit `category`
    // use that; otherwise we default the category from the item's
    // section via SECTION_TO_DEFAULT_CATEGORY.
    const itemsRes = await pool.query(
      `SELECT section, category, amount FROM recording_budget_line_items WHERE budget_id = $1`,
      [id]
    );
    // Category rollup. Starts empty and grows to include every
    // category that shows up in either planned line items or actual
    // expenses, so the "By category" table renders exactly the
    // categories in play for this budget (no empty 6-section list).
    const byCategory = {};
    const ensure = (cat) => {
      if (!byCategory[cat]) byCategory[cat] = { planned: 0, spent: 0, remaining: 0, count: 0 };
      return byCategory[cat];
    };
    for (const li of itemsRes.rows) {
      const cat = (li.category && li.category.trim()) || SECTION_TO_DEFAULT_CATEGORY[li.section] || 'Other';
      ensure(cat).planned += Number(li.amount) || 0;
    }
    for (const e of expenses) {
      const override = e.budget_category_override;
      // The override is trusted as stored. Re-validating a value already written
      // would silently reclassify a row whose category has since been renamed or
      // deactivated — reading is never the place to enforce a vocabulary.
      const resolved = override || e.category || 'Other';
      const bucket = ensure(resolved);
      bucket.spent += Number(e.amount_usd) || 0;
      bucket.count += 1;
    }
    for (const cat of Object.keys(byCategory)) {
      byCategory[cat].remaining = byCategory[cat].planned - byCategory[cat].spent;
    }
    const totalPlanned = Object.values(byCategory).reduce((s, v) => s + v.planned, 0);
    const totalSpent   = Object.values(byCategory).reduce((s, v) => s + v.spent, 0);
    const advance = Number(budget.advance_amount) || 0;
    const fund    = Number(budget.fund_amount)    || 0;
    const summary = budget.type === 'fund'
      ? {
          fund, advance,
          remainder_after_advance: fund - advance,
          spent: totalSpent,
          balance_of_fund: fund - advance - totalSpent,
        }
      : {
          budget_planned: totalPlanned,
          spent: totalSpent,
          remaining: totalPlanned - totalSpent,
        };
    res.json({ success: true, data: {
      match_name: matchName,
      by_category: byCategory,
      all: expenses.map(e => ({
        ...e,
        default_category: e.category || 'Other',
      })),
      summary,
      category_labels: await ledgerCategoryLabels(),
    }});
  } catch (err) {
    console.error('GET /api/budgets/:id/actuals:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PUT /api/budgets/expense/:expenseId/section ────────────────────
// Per-expense category override. Route name kept for backward-
// compat with the initial section-based design; the body now
// accepts either `section` (legacy) or `category` — both map to
// the same expenses.budget_section_override column. Value must be
// a valid ledger category. Pass empty/null to clear the override
// and revert to the expense's own category.
router.put('/expense/:expenseId/section', async (req, res) => {
  const expenseId = parseInt(req.params.expenseId, 10);
  if (!Number.isFinite(expenseId)) return res.status(400).json({ success: false, error: 'invalid id' });
  try {
    const raw = String(req.body?.category ?? req.body?.section ?? '').trim();
    const value = raw === '' ? null : raw;
    if (value && !(await isKnownLedgerCategory(value))) {
      return res.status(400).json({ success: false,
        error: `“${value}” is not a category. Create it first, then set it here.` });
    }
    const { rows } = await pool.query(
      `UPDATE expenses SET budget_section_override = $1 WHERE id = $2 RETURNING id, budget_section_override AS budget_category_override`,
      [value, expenseId]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'expense not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('PUT /api/budgets/expense/:expenseId/section:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
