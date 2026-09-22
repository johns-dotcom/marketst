const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { requirePagePermission } = require('../middleware/pagePermission');

const router = express.Router();

// Every /api/financials endpoint requires an explicit /financials
// grant (or an admin-tier role). Mirrors the client-side canView so
// a User without permission can't extract financial data via curl or
// DevTools even after the sidebar hides the link.
router.use(authMiddleware, requirePagePermission('/financials'));

// Fetch approved expenses from the main DB, grouped by artist.
// The expenses table now lives in the same DB after bookkeeping migration.
const fetchBookkeepingExpenses = async (dateFrom, dateTo) => {
  try {
    const params = [];
    const dateFilters = [];
    if (dateFrom) { params.push(dateFrom); dateFilters.push(`COALESCE(payment_date, invoice_date) >= $${params.length}`); }
    if (dateTo)   { params.push(dateTo);   dateFilters.push(`COALESCE(payment_date, invoice_date) <= $${params.length}`); }
    const dateClause = dateFilters.length ? 'AND ' + dateFilters.join(' AND ') : '';

    const result = await pool.query(`
      SELECT
        TRIM(artist) AS artist,
        payee, description, category, song, amount,
        invoice_date, payment_date,
        COALESCE(payment_date, invoice_date) AS effective_date,
        payment_status, invoice_number, payment_method,
        COALESCE(recoupable, false) AS recoupable,
        id
      FROM expenses
      WHERE (deleted = false OR deleted IS NULL)
        AND status = 'approved'
        AND id NOT IN (SELECT DISTINCT parent_id FROM expenses WHERE parent_id IS NOT NULL)
        AND artist IS NOT NULL
        AND TRIM(artist) != ''
        AND TRIM(artist) != 'Multi'
        ${dateClause}
      ORDER BY COALESCE(payment_date, invoice_date) DESC
    `, params);

    const grouped = {};
    for (const row of result.rows) {
      const key = row.artist.toLowerCase();
      if (!grouped[key]) grouped[key] = { name: row.artist, expenses: [] };
      grouped[key].expenses.push(row);
    }
    return grouped;
  } catch (err) {
    console.error('Bookkeeping DB query failed:', err.message);
    return {};
  }
};

// GET /api/financials
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { from: dateFrom, to: dateTo } = req.query;

    const [
      artistsResult, budgetsResult, manualResult,
      releasesResult, releaseBudgetsResult,
      incomeResult, contractsResult,
    ] = await Promise.all([
      pool.query(`SELECT id, name FROM artists ORDER BY name ASC`),
      // Artist-scoped budgets — reads from the consolidated
      // recording_budgets table. Shape matches the old artist_budgets
      // row (artist_id, amount, advance, notes, updated_at) so
      // downstream aggregation doesn't need to change. amount comes
      // from total_amount_override when set (legacy flat total),
      // else from summed line items + contingency.
      pool.query(`
        SELECT
          rb.artist_id,
          COALESCE(
            rb.total_amount_override,
            (SELECT COALESCE(SUM(li.amount), 0) FROM recording_budget_line_items li WHERE li.budget_id = rb.id)
              * (1 + COALESCE(rb.contingency_pct, 0) / 100)
          )::float AS amount,
          COALESCE(rb.advance_amount, 0)::float AS advance,
          rb.notes,
          rb.updated_at
        FROM recording_budgets rb
        WHERE rb.artist_id IS NOT NULL AND rb.release_id IS NULL
      `),
      pool.query(`
        SELECT me.*, u.name as created_by_name
        FROM manual_expenses me
        LEFT JOIN users u ON me.created_by = u.id
        WHERE ($1::date IS NULL OR me.expense_date >= $1)
          AND ($2::date IS NULL OR me.expense_date <= $2)
        ORDER BY me.expense_date DESC
      `, [dateFrom || null, dateTo || null]),
      pool.query(`
        SELECT r.id, r.project_name, r.artist_id, r.release_date, r.release_type
        FROM releases r
        WHERE (r.archived = false OR r.archived IS NULL)
        ORDER BY r.release_date DESC
      `),
      // Release-scoped budgets from the consolidated table. Same
      // shape the old release_budgets rows had (release_id, amount,
      // notes, updated_at). amount uses total_amount_override when
      // present (legacy cap) else computed subtotal + contingency.
      pool.query(`
        SELECT
          rb.release_id,
          COALESCE(
            rb.total_amount_override,
            (SELECT COALESCE(SUM(li.amount), 0) FROM recording_budget_line_items li WHERE li.budget_id = rb.id)
              * (1 + COALESCE(rb.contingency_pct, 0) / 100)
          )::float AS amount,
          rb.notes,
          rb.updated_at
        FROM recording_budgets rb
        WHERE rb.release_id IS NOT NULL
      `),
      pool.query(`
        SELECT ai.*, u.name as created_by_name
        FROM artist_income ai
        LEFT JOIN users u ON ai.created_by = u.id
        WHERE ($1::date IS NULL OR ai.income_date >= $1)
          AND ($2::date IS NULL OR ai.income_date <= $2)
        ORDER BY ai.income_date DESC
      `, [dateFrom || null, dateTo || null]),
      pool.query(`
        SELECT artist_id, type, status, royalty_split, advance,
               COALESCE(financial_terms, '[]'::jsonb) AS financial_terms
        FROM contracts
        WHERE status = 'Active'
      `),
    ]);

    const bookkeepingByArtist = await fetchBookkeepingExpenses(dateFrom, dateTo);

    const budgetMap = {};
    budgetsResult.rows.forEach(b => { budgetMap[b.artist_id] = b; });

    const manualByArtist = {};
    manualResult.rows.forEach(e => {
      const id = e.artist_id;
      if (!manualByArtist[id]) manualByArtist[id] = [];
      manualByArtist[id].push(e);
    });

    const releasesByArtist = {};
    releasesResult.rows.forEach(r => {
      if (!releasesByArtist[r.artist_id]) releasesByArtist[r.artist_id] = [];
      releasesByArtist[r.artist_id].push(r);
    });

    const releaseBudgetMap = {};
    releaseBudgetsResult.rows.forEach(rb => { releaseBudgetMap[rb.release_id] = rb; });

    // Income is bucketed by artist_id. Most rows don't carry one, so most income
    // attaches to no artist — accepted by design (2026-08-06, John's call):
    // income here is not attributed per artist, so the per-artist income figures
    // and the recoupment scoreboard's income column stay at zero deliberately.
    const incomeByArtist = {};
    incomeResult.rows.forEach(item => {
      const id = item.artist_id;
      if (!incomeByArtist[id]) incomeByArtist[id] = [];
      incomeByArtist[id].push(item);
    });

    const contractsByArtist = {};
    contractsResult.rows.forEach(c => {
      const id = c.artist_id;
      if (!contractsByArtist[id]) contractsByArtist[id] = [];
      contractsByArtist[id].push(c);
    });

    const artists = artistsResult.rows.map(artist => {
      const budget = budgetMap[artist.id] || { amount: 0, advance: 0, notes: null };
      const bkKey = artist.name.toLowerCase();
      const bkData = bookkeepingByArtist[bkKey] || { expenses: [] };
      const manual = manualByArtist[artist.id] || [];
      const income = incomeByArtist[artist.id] || [];

      const bookkeeping_total = bkData.expenses.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
      const manual_total      = manual.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
      const total_spent       = bookkeeping_total + manual_total;
      const budget_amount     = parseFloat(budget.amount || 0);
      const advance           = parseFloat(budget.advance || 0);
      const variance          = budget_amount - total_spent;

      const paid_total = bkData.expenses
        .filter(e => e.payment_status === 'Paid')
        .reduce((s, e) => s + parseFloat(e.amount || 0), 0);
      const unpaid_total = bkData.expenses
        .filter(e => e.payment_status && e.payment_status !== 'Paid')
        .reduce((s, e) => s + parseFloat(e.amount || 0), 0);

      const recoupable_bk     = bkData.expenses.filter(e => e.recoupable).reduce((s, e) => s + parseFloat(e.amount || 0), 0);
      const recoupable_manual = manual.filter(e => e.recoupable).reduce((s, e) => s + parseFloat(e.amount || 0), 0);
      const recoupable_total  = recoupable_bk + recoupable_manual;
      const recoupment_balance = advance - recoupable_total;
      const recouped = advance > 0 && recoupment_balance <= 0;

      const income_total = income.reduce((s, i) => s + parseFloat(i.amount || 0), 0);
      const net_pl       = income_total - total_spent;

      const artistReleases = (releasesByArtist[artist.id] || []).map(r => {
        const rb = releaseBudgetMap[r.id] || { amount: 0 };
        return {
          id: r.id,
          name: r.project_name,
          release_date: r.release_date,
          release_type: r.release_type,
          budget: parseFloat(rb.amount || 0),
          release_budget_id: rb.id || null,
        };
      });

      return {
        id: artist.id,
        name: artist.name,
        budget: budget_amount,
        advance,
        budget_notes: budget.notes,
        bookkeeping_total,
        manual_total,
        total_spent,
        variance,
        paid_total,
        unpaid_total,
        recoupable_total,
        recoupment_balance,
        recouped,
        income_total,
        net_pl,
        releases: artistReleases,
        bookkeeping_expenses: bkData.expenses,
        manual_expenses: manual,
        income,
        active_contracts: contractsByArtist[artist.id] || [],
      };
    });

    const totals = artists.reduce((acc, a) => ({
      budget:   acc.budget   + a.budget,
      spent:    acc.spent    + a.total_spent,
      variance: acc.variance + a.variance,
      unpaid:   acc.unpaid   + a.unpaid_total,
      income:   acc.income   + a.income_total,
      net_pl:   acc.net_pl   + a.net_pl,
    }), { budget: 0, spent: 0, variance: 0, unpaid: 0, income: 0, net_pl: 0 });

    res.json({ success: true, data: { artists, totals, bookkeeping_connected: true } });
  } catch (err) {
    console.error('Financials error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/financials/budgets/:artistId
//
// Rewritten to write into the consolidated recording_budgets table.
// Shape returned to the caller matches the legacy artist_budgets row
// (artist_id, amount, advance, notes, updated_at) so the Recoupments
// page + Financials KPI card don't need to change.
//
// Strategy: find the artist-scoped (release_id IS NULL) recording
// budget for this artist; create it as 'draft' if none. Amount is
// stored in total_amount_override — this endpoint's callers set a
// flat total, not line items.
router.put('/budgets/:artistId', authMiddleware, async (req, res) => {
  try {
    const { artistId } = req.params;
    const { amount, advance, notes } = req.body;
    const amt = Number(amount) || 0;
    const adv = Number(advance) || 0;
    // Upsert against the (artist_id, release_id IS NULL) unique row.
    // Not a table-level unique constraint, so we handle the "does one
    // already exist" check ourselves.
    const existing = await pool.query(
      `SELECT id FROM recording_budgets WHERE artist_id = $1 AND release_id IS NULL LIMIT 1`,
      [artistId]
    );
    let row;
    if (existing.rows.length) {
      row = (await pool.query(`
        UPDATE recording_budgets
           SET total_amount_override = $1,
               advance_amount = $2,
               notes = $3,
               updated_at = NOW(), updated_by = $4
         WHERE id = $5
        RETURNING artist_id, $1::numeric AS amount, advance_amount AS advance, notes, updated_at
      `, [amt, adv, notes ?? null, req.user.id, existing.rows[0].id])).rows[0];
    } else {
      row = (await pool.query(`
        INSERT INTO recording_budgets
          (artist_id, type, currency, advance_amount, total_amount_override,
           notes, contingency_pct, status,
           created_by, updated_by, created_at, updated_at)
        VALUES ($1, 'budget', 'USD', $2, $3, $4, 0, 'draft', $5, $5, NOW(), NOW())
        RETURNING artist_id, $3::numeric AS amount, advance_amount AS advance, notes, updated_at
      `, [artistId, adv, amt, notes ?? null, req.user.id])).rows[0];
    }
    res.json({ success: true, data: row });
  } catch (err) {
    console.error('Update budget error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/financials/release-budgets/:releaseId
// Same treatment as above but scoped to release_id. artist_id is
// derived from the release so both indices stay usable.
router.put('/release-budgets/:releaseId', authMiddleware, async (req, res) => {
  try {
    const { releaseId } = req.params;
    const { amount, notes } = req.body;
    const amt = Number(amount) || 0;
    const existing = await pool.query(
      `SELECT id FROM recording_budgets WHERE release_id = $1 LIMIT 1`,
      [releaseId]
    );
    let row;
    if (existing.rows.length) {
      row = (await pool.query(`
        UPDATE recording_budgets
           SET total_amount_override = $1,
               notes = $2,
               updated_at = NOW(), updated_by = $3
         WHERE id = $4
        RETURNING release_id, $1::numeric AS amount, notes, updated_at
      `, [amt, notes ?? null, req.user.id, existing.rows[0].id])).rows[0];
    } else {
      row = (await pool.query(`
        INSERT INTO recording_budgets
          (release_id, artist_id, type, currency, advance_amount, total_amount_override,
           notes, contingency_pct, status,
           created_by, updated_by, created_at, updated_at)
        VALUES
          ($1,
           (SELECT r.artist_id FROM releases r WHERE r.id = $1),
           'budget', 'USD', 0, $2, $3, 0, 'draft', $4, $4, NOW(), NOW())
        RETURNING release_id, $2::numeric AS amount, notes, updated_at
      `, [releaseId, amt, notes ?? null, req.user.id])).rows[0];
    }
    res.json({ success: true, data: row });
  } catch (err) {
    console.error('Update release budget error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/financials/summary — spending trends, top vendors, category breakdown
router.get('/summary', authMiddleware, async (req, res) => {
  try {
    // Monthly spending trend (last 12 months)
    const trendsResult = await pool.query(`
      SELECT
        TO_CHAR(COALESCE(payment_date, invoice_date), 'YYYY-MM') AS month,
        SUM(amount) AS total
      FROM expenses
      WHERE status = 'approved' AND (deleted = false OR deleted IS NULL)
        AND COALESCE(payment_date, invoice_date) >= NOW() - INTERVAL '12 months'
      GROUP BY TO_CHAR(COALESCE(payment_date, invoice_date), 'YYYY-MM')
      ORDER BY month ASC
    `);

    // Top vendors by spend
    const vendorsResult = await pool.query(`
      SELECT payee, SUM(amount) AS total, COUNT(*) AS count
      FROM expenses
      WHERE status = 'approved' AND (deleted = false OR deleted IS NULL)
        AND payee IS NOT NULL AND payee != ''
      GROUP BY payee
      ORDER BY total DESC
      LIMIT 10
    `);

    // Category breakdown
    const categoriesResult = await pool.query(`
      SELECT category, SUM(amount) AS total, COUNT(*) AS count
      FROM expenses
      WHERE status = 'approved' AND (deleted = false OR deleted IS NULL)
        AND category IS NOT NULL AND category != ''
      GROUP BY category
      ORDER BY total DESC
    `);

    // Budget alerts — artists over 80% of budget. Reads from the
    // consolidated recording_budgets table (artist-scoped rows).
    // Budget amount is total_amount_override when set (legacy flat
    // total) else computed from line items + contingency.
    const alertsResult = await pool.query(`
      SELECT a.name AS artist_name,
        COALESCE(
          rb.total_amount_override,
          (SELECT COALESCE(SUM(li.amount), 0) FROM recording_budget_line_items li WHERE li.budget_id = rb.id)
            * (1 + COALESCE(rb.contingency_pct, 0) / 100)
        )::float AS budget_amount,
        COALESCE((
          SELECT SUM(e.amount) FROM expenses e
          WHERE normalize_artist_key(e.artist) = normalize_artist_key(a.name)
            AND e.status = 'approved' AND (e.deleted = false OR e.deleted IS NULL)
        ), 0) AS spent
      FROM recording_budgets rb
      JOIN artists a ON rb.artist_id = a.id
      WHERE rb.release_id IS NULL
    `);

    const budgetAlerts = alertsResult.rows
      .map(r => ({
        artist_name: r.artist_name,
        budget: Number(r.budget_amount) || 0,
        spent: Number(r.spent) || 0,
        // Guard against divide-by-zero when the budget hasn't been
        // filled in yet (a common state on newly-migrated rows).
        pct: (Number(r.budget_amount) > 0)
          ? Math.round((Number(r.spent) / Number(r.budget_amount)) * 100)
          : 0,
      }))
      .filter(r => r.budget > 0 && r.pct >= 80)
      .sort((a, b) => b.pct - a.pct);

    // This month vs last month comparison
    const thisMonth = await pool.query(`
      SELECT SUM(amount) AS total, COUNT(*) AS count
      FROM expenses
      WHERE status = 'approved' AND (deleted = false OR deleted IS NULL)
        AND COALESCE(payment_date, invoice_date) >= DATE_TRUNC('month', NOW())
    `);
    const lastMonth = await pool.query(`
      SELECT SUM(amount) AS total, COUNT(*) AS count
      FROM expenses
      WHERE status = 'approved' AND (deleted = false OR deleted IS NULL)
        AND COALESCE(payment_date, invoice_date) >= DATE_TRUNC('month', NOW() - INTERVAL '1 month')
        AND COALESCE(payment_date, invoice_date) < DATE_TRUNC('month', NOW())
    `);

    res.json({
      success: true,
      data: {
        trends: trendsResult.rows,
        topVendors: vendorsResult.rows,
        categories: categoriesResult.rows,
        budgetAlerts,
        thisMonth: { total: parseFloat(thisMonth.rows[0]?.total || 0), count: parseInt(thisMonth.rows[0]?.count || 0) },
        lastMonth: { total: parseFloat(lastMonth.rows[0]?.total || 0), count: parseInt(lastMonth.rows[0]?.count || 0) },
      }
    });
  } catch (err) {
    console.error('GET /api/financials/summary:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/financials/monthly-by-artist?months=12
// One row per (month, artist) pair, split into PAID vs UNPAID totals
// so the Financials section can show both sides without a second
// round-trip. Range capped to 36 months to keep the payload bounded.
//
// Cohort by created_at (invoice-received month, LA time). All sums are
// USD-normalized and use the same filters as the sibling Received
// query, so Paid + Unpaid = Received on every row by construction.
//
// Caveat: SUM(amount) is currency-blind here (mirrors how the rest of
// /summary aggregates). Mixed-currency totals are slightly off until
// the wider FX-conversion pass on the financials backend lands —
// flagged in TODO.md item #7.
router.get('/monthly-by-artist', authMiddleware, async (req, res) => {
  try {
    const requested = parseInt(req.query.months, 10);
    const months = Math.max(1, Math.min(36, Number.isFinite(requested) ? requested : 12));
    // Run the per-(month, artist) query AND a per-month received
    // (intake) query in parallel. Received uses created_at (submission
    // date), which is a different date basis than the artist-scoped
    // paid/unpaid data — hence a separate query keyed by month. The
    // client merges them client-side.
    // Both queries now share the same recipe so Paid + Unpaid = Received
    // by construction. Prior version had four sources of drift:
    //   1. Different date basis (COALESCE(payment_date, invoice_date) for
    //      spend vs. created_at for received). Rows straddling months
    //      landed in different buckets on each side.
    //   2. Currency (spend was native, received was USD-normalized).
    //   3. Voided filter only on received.
    //   4. Received filtered parent_id IS NULL — that DROPS split children
    //      whose amounts still belong to the family, so a $1000 invoice
    //      split 3 ways counted as ~$500 instead of $1000.
    //
    // Aligned recipe:
    //   • Cohort by created_at (LA month) — this is what "Received in
    //     month X" naturally means; the paid/unpaid buckets become
    //     "of invoices received in month X, how much has been paid".
    //   • USD via fx_rate_to_usd on all three sums.
    //   • Voided excluded across the board.
    //   • All rows (parent + children) counted for sums so split
    //     families total correctly; received_count still filters to
    //     parents so "N invoices submitted" reads as families.
    const [artistsRes, receivedRes] = await Promise.all([
      pool.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', (e.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles'), 'YYYY-MM') AS month,
          COALESCE(NULLIF(TRIM(e.artist), ''), 'Unassigned') AS artist,
          SUM(CASE WHEN e.payment_status = 'Paid' THEN COALESCE(e.amount, 0) / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1) ELSE 0 END)::numeric AS paid,
          SUM(CASE WHEN e.payment_status IS DISTINCT FROM 'Paid' THEN COALESCE(e.amount, 0) / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1) ELSE 0 END)::numeric AS unpaid,
          SUM(CASE WHEN e.payment_status = 'Paid' THEN 1 ELSE 0 END)::int AS paid_count,
          SUM(CASE WHEN e.payment_status IS DISTINCT FROM 'Paid' THEN 1 ELSE 0 END)::int AS unpaid_count,
          SUM(COALESCE(e.amount, 0) / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1))::numeric AS total,
          COUNT(*)::int AS count
        FROM expenses e
        WHERE e.status = 'approved'
          AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided  IS NULL OR e.voided  = FALSE)
          AND e.created_at IS NOT NULL
          AND (e.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles'
                >= (DATE_TRUNC('month', NOW() AT TIME ZONE 'America/Los_Angeles')
                     - ($1::int - 1) * INTERVAL '1 month')
        GROUP BY month, COALESCE(NULLIF(TRIM(e.artist), ''), 'Unassigned')
        ORDER BY month DESC, total DESC
      `, [months]),
      pool.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', (e.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles'), 'YYYY-MM') AS month,
          COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1)), 0)::float AS received_usd,
          COUNT(*) FILTER (WHERE e.parent_id IS NULL)::int AS received_count
        FROM expenses e
        WHERE e.status = 'approved'
          AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided  IS NULL OR e.voided  = FALSE)
          AND (e.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles'
                >= (DATE_TRUNC('month', NOW() AT TIME ZONE 'America/Los_Angeles')
                     - ($1::int - 1) * INTERVAL '1 month')
        GROUP BY 1
      `, [months]),
    ]);

    // Received map keyed by 'YYYY-MM' so the client can merge in O(1).
    const receivedByMonth = {};
    for (const r of receivedRes.rows) {
      receivedByMonth[r.month] = {
        usd: Number(r.received_usd) || 0,
        count: Number(r.received_count) || 0,
      };
    }

    res.json({
      success: true,
      data: artistsRes.rows.map(r => ({
        month: r.month,
        artist: r.artist,
        paid: parseFloat(r.paid) || 0,
        unpaid: parseFloat(r.unpaid) || 0,
        paidCount: r.paid_count || 0,
        unpaidCount: r.unpaid_count || 0,
        total: parseFloat(r.total) || 0,
        count: r.count || 0,
      })),
      received: receivedByMonth,
    });
  } catch (err) {
    console.error('GET /api/financials/monthly-by-artist:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/financials/expenses
router.post('/expenses', authMiddleware, async (req, res) => {
  try {
    const { artist_id, artist_name, description, amount, category, song, expense_date, recoupable, release_id } = req.body;
    if (!description || !amount) {
      return res.status(400).json({ success: false, error: 'Description and amount are required' });
    }
    const result = await pool.query(`
      INSERT INTO manual_expenses
        (artist_id, artist_name, description, amount, category, song, expense_date, recoupable, release_id, created_by, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING *
    `, [
      artist_id ?? null, artist_name ?? null, description, amount,
      category ?? null, song ?? null,
      expense_date || new Date().toISOString().split('T')[0],
      recoupable ?? false,
      release_id ?? null,
      req.user.id,
    ]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Add manual expense error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/financials/expenses/:id
router.delete('/expenses/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM manual_expenses WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete expense error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/financials/income
router.post('/income', authMiddleware, async (req, res) => {
  try {
    const { artist_id, artist_name, description, amount, income_type, income_date, release_id, notes } = req.body;
    if (!description || !amount) {
      return res.status(400).json({ success: false, error: 'Description and amount are required' });
    }
    const result = await pool.query(`
      INSERT INTO artist_income
        (artist_id, artist_name, description, amount, income_type, income_date, release_id, notes, created_by, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING *
    `, [
      artist_id ?? null, artist_name ?? null, description, amount,
      income_type ?? null,
      income_date || new Date().toISOString().split('T')[0],
      release_id ?? null, notes ?? null,
      req.user.id,
    ]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Add income error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/financials/income/:id
router.delete('/income/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM artist_income WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete income error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── Executive dashboard ────────────────────────────────────────────────────
// GET /api/financials/exec?weeks=<N>&from=<YYYY-MM-DD>&to=<YYYY-MM-DD>
// Backing data for the CEO/board landing view on /financials. Returns:
//   - kpi: this_week / last_week / mtd / last_mtd / ytd / last_ytd
//          + unpaid_total (running open balance) + unpaid_count
//   - weeks: trailing-N-weeks buckets (default 12) with paid_usd,
//            unpaid_usd (invoices dated in that week that are still
//            open), received_usd + received_count (created_at in week).
//   - breakdowns: top-10 by artist, song, and category — paid + unpaid
//     USD and row_count for each. Client toggles between the three
//     via a segmented switcher; server returns all three in one round-
//     trip since the data is small.
// USD-equivalent via fx_rate_to_usd when locked; falls back to native
// amount (accepted approximation — the exec view rolls up big numbers
// where a 5% FX drift is invisible).
router.get('/exec', authMiddleware, async (req, res) => {
  try {
    const weeksN = Math.max(1, Math.min(52, parseInt(req.query.weeks, 10) || 12));

    // ── Cross-page filters ───────────────────────────────────────────
    // The exec dashboard supports three optional scope filters: artist,
    // category, boom_rep. Every SQL query in this endpoint threads
    // them through via applyFilters(params, alias) — that helper pushes
    // filter values into the query's params array and returns the SQL
    // clause fragment (with correctly-numbered $N placeholders based
    // on the pushed positions), so the caller only needs to inject
    // ${filterClause} at the right spot in its WHERE.
    //
    // Length cap = 120 chars — payee/artist columns are ~200 in the
    // schema, but filters come from a dropdown of the vendor's own
    // rows so any legit value fits. Anything longer is either garbage
    // or an attempt to blow up query planner memory; truncate quietly.
    const filterArtist   = String(req.query.artist   || '').trim().slice(0, 120);
    const filterCategory = String(req.query.category || '').trim().slice(0, 120);
    const filterRep      = String(req.query.rep      || '').trim().slice(0, 120);
    const hasAnyFilter = !!(filterArtist || filterCategory || filterRep);
    const applyFilters = (params, alias = 'e') => {
      const p = alias ? `${alias}.` : '';
      const parts = [];
      if (filterArtist) {
        params.push(filterArtist);
        parts.push(`LOWER(TRIM(${p}artist)) = LOWER(TRIM($${params.length}))`);
      }
      if (filterCategory) {
        params.push(filterCategory);
        parts.push(`${p}category = $${params.length}`);
      }
      if (filterRep) {
        params.push(filterRep);
        parts.push(`${p}boom_rep = $${params.length}`);
      }
      return parts.length ? ' AND ' + parts.join(' AND ') : '';
    };

    // 1. Compute the KPI window bounds in JS. Doing this in SQL kept
    //    running into date-math edge cases (LEAST + day-matched last-
    //    month arithmetic across leap years / short months). JS
    //    Date is boring but predictable, and the query flattens down
    //    to a single scan of `expenses` with parameterized ranges.
    //
    //    All bounds are anchored to the LA "today" so a request from
    //    a browser in a different tz doesn't skew the numbers.
    const now = new Date();
    const laToday = new Date(now.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }));
    const iso = (d) => d.toISOString().slice(0, 10);
    const addDays = (d, n) => { const c = new Date(d); c.setDate(c.getDate() + n); return c; };
    // Monday of the LA-week that contains `d`.
    const startOfWeekMon = (d) => {
      const c = new Date(d);
      const day = c.getDay(); // 0=Sun ... 6=Sat
      const diff = day === 0 ? -6 : 1 - day; // shift to Monday
      c.setDate(c.getDate() + diff);
      return c;
    };
    // Day-matched previous month/year. Falls back to the last valid
    // day if the target month is shorter (Mar 31 → Feb 28/29).
    const dayMatchedBack = (d, monthsBack) => {
      const dayOfMonth = d.getDate();
      const c = new Date(d.getFullYear(), d.getMonth() - monthsBack + 1, 0); // last day of target month
      const lastValidDay = Math.min(dayOfMonth, c.getDate());
      return new Date(d.getFullYear(), d.getMonth() - monthsBack, lastValidDay);
    };

    const wkStart  = startOfWeekMon(laToday);
    const wkEnd    = laToday;
    const lastWkStart = addDays(wkStart, -7);
    // Day-match the previous-week endpoint so we compare
    // Monday→today against Monday→(today−7 days). Without this the
    // current week was a partial 1–7 day slice while "last week" was a
    // full 7-day window — 2 vs 7 days meant the delta chip lied.
    // Matches the dayMatchedBack pattern used by MTD / YTD.
    const lastWkEnd   = addDays(laToday, -7);
    const mtdStart = new Date(laToday.getFullYear(), laToday.getMonth(), 1);
    const mtdEnd   = laToday;
    const lastMtdStart = new Date(laToday.getFullYear(), laToday.getMonth() - 1, 1);
    const lastMtdEnd   = dayMatchedBack(laToday, 1);
    const ytdStart = new Date(laToday.getFullYear(), 0, 1);
    const ytdEnd   = laToday;
    const lastYtdStart = new Date(laToday.getFullYear() - 1, 0, 1);
    const lastYtdEnd   = dayMatchedBack(laToday, 12);

    // 2. Single-scan KPI query — six CASE-summed ranges over the same
    //    paid dataset, plus a running unpaid balance in one shot.
    //    Filter clauses share the same params array so their $N
    //    indices come after the 12 date params.
    const kpiParams = [
      iso(wkStart),      iso(wkEnd),
      iso(lastWkStart),  iso(lastWkEnd),
      iso(mtdStart),     iso(mtdEnd),
      iso(lastMtdStart), iso(lastMtdEnd),
      iso(ytdStart),     iso(ytdEnd),
      iso(lastYtdStart), iso(lastYtdEnd),
    ];
    const kpiFilterClause = applyFilters(kpiParams, '');
    const kpiRes = await pool.query(`
      WITH paid_sums AS (
        SELECT
          COALESCE(SUM(CASE WHEN payment_date BETWEEN $1 AND $2  THEN amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float  AS this_week,
          COALESCE(SUM(CASE WHEN payment_date BETWEEN $3 AND $4  THEN amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float  AS last_week,
          COALESCE(SUM(CASE WHEN payment_date BETWEEN $5 AND $6  THEN amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float  AS mtd,
          COALESCE(SUM(CASE WHEN payment_date BETWEEN $7 AND $8  THEN amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float  AS last_mtd,
          COALESCE(SUM(CASE WHEN payment_date BETWEEN $9 AND $10 THEN amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float  AS ytd,
          COALESCE(SUM(CASE WHEN payment_date BETWEEN $11 AND $12 THEN amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS last_ytd
        FROM expenses
        WHERE status = 'approved'
          AND (deleted IS NULL OR deleted = FALSE)
          AND (voided  IS NULL OR voided  = FALSE)
          AND parent_id IS NULL
          AND payment_status = 'Paid'
          AND payment_date IS NOT NULL
          ${kpiFilterClause}
      ),
      unpaid_sum AS (
        SELECT
          COALESCE(SUM(amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1)), 0)::float AS unpaid_total,
          COUNT(*)::int AS unpaid_count
        FROM expenses
        WHERE status = 'approved'
          AND (deleted IS NULL OR deleted = FALSE)
          AND (voided  IS NULL OR voided  = FALSE)
          AND parent_id IS NULL
          AND payment_status IS DISTINCT FROM 'Paid'
          ${kpiFilterClause}
      )
      SELECT * FROM paid_sums, unpaid_sum
    `, kpiParams);
    const kpi = kpiRes.rows[0] || {};

    // Range picker → weekly chart + breakdown scoping. When from/to
    // are supplied, both respect that window. Otherwise fall back to
    // trailing-N-weeks for the chart and all-time for the breakdowns.
    const rangeFrom = (req.query.from && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)) ? req.query.from : null;
    const rangeTo   = (req.query.to   && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to))   ? req.query.to   : null;

    // 3. Weekly buckets. Compute the anchor Monday in JS and pass it as
    //    a parameter — cleaner than interpolating into an INTERVAL
    //    string. When from/to are supplied, snap to whole weeks so the
    //    chart starts on a Monday and ends on the enclosing week.
    let chartAnchorStart;
    let chartAnchorEnd;
    if (rangeFrom) {
      const [fy, fm, fd] = rangeFrom.split('-').map(n => parseInt(n, 10));
      chartAnchorStart = startOfWeekMon(new Date(fy, fm - 1, fd));
    } else {
      chartAnchorStart = addDays(wkStart, -(weeksN - 1) * 7);
    }
    if (rangeTo) {
      const [ty, tm, td] = rangeTo.split('-').map(n => parseInt(n, 10));
      chartAnchorEnd = startOfWeekMon(new Date(ty, tm - 1, td));
    } else {
      chartAnchorEnd = wkStart;
    }
    const weeksParams = [iso(chartAnchorStart), iso(chartAnchorEnd)];
    const weeksFilterClause = applyFilters(weeksParams, 'e');
    const weeksRes = await pool.query(`
      WITH weeks AS (
        SELECT gs::DATE AS week_start
          FROM generate_series(
                 $1::DATE,
                 $2::DATE,
                 INTERVAL '7 days'
               ) gs
      ),
      buckets AS (
        SELECT
          DATE_TRUNC('week', e.payment_date)::DATE AS week_start,
          SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1)) AS paid_usd
        FROM expenses e
        WHERE e.status = 'approved'
          AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided  IS NULL OR e.voided  = FALSE)
          AND e.parent_id IS NULL
          AND e.payment_status = 'Paid'
          AND e.payment_date IS NOT NULL
          ${weeksFilterClause}
        GROUP BY 1
      ),
      unpaid_buckets AS (
        SELECT
          DATE_TRUNC('week', COALESCE(e.invoice_date, e.created_at))::DATE AS week_start,
          SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1)) AS unpaid_usd
        FROM expenses e
        WHERE e.status = 'approved'
          AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided  IS NULL OR e.voided  = FALSE)
          AND e.parent_id IS NULL
          AND e.payment_status IS DISTINCT FROM 'Paid'
          ${weeksFilterClause}
        GROUP BY 1
      ),
      received_buckets AS (
        SELECT
          DATE_TRUNC('week', (e.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::DATE AS week_start,
          SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1)) AS received_usd,
          COUNT(*)::int AS received_count
        FROM expenses e
        WHERE e.status = 'approved'
          AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided  IS NULL OR e.voided  = FALSE)
          AND e.parent_id IS NULL
          ${weeksFilterClause}
        GROUP BY 1
      )
      SELECT
        TO_CHAR(w.week_start, 'YYYY-MM-DD') AS week_start,
        TO_CHAR((w.week_start + INTERVAL '6 days')::DATE, 'YYYY-MM-DD') AS week_end,
        COALESCE(b.paid_usd, 0)::float      AS paid_usd,
        COALESCE(u.unpaid_usd, 0)::float    AS unpaid_usd,
        COALESCE(r.received_usd, 0)::float  AS received_usd,
        COALESCE(r.received_count, 0)::int  AS received_count
      FROM weeks w
      LEFT JOIN buckets b          USING (week_start)
      LEFT JOIN unpaid_buckets u   USING (week_start)
      LEFT JOIN received_buckets r USING (week_start)
      ORDER BY w.week_start ASC
    `, weeksParams);

    // 3. Breakdowns — top 10 by paid_usd for each of the three dimensions.
    //    Same USD conversion + parent-only + not-dismissed filters as
    //    the KPI query. Case-insensitive artist grouping (best-spelling
    //    wins) matches the rest of the app.
    const breakdownQuery = async (groupBy) => {
      const groupExpr =
        groupBy === 'artist'   ? "COALESCE(NULLIF(TRIM(LOWER(e.artist)), ''), 'unassigned')" :
        groupBy === 'song'     ? "COALESCE(NULLIF(TRIM(LOWER(e.song)),   ''), 'unassigned')" :
                                 "COALESCE(NULLIF(TRIM(e.category), ''), 'Uncategorized')";
      const labelExpr =
        groupBy === 'category'
          ? groupExpr
          : `MAX(${groupBy === 'artist' ? 'e.artist' : 'e.song'})`;
      // Range scope — same rangeFrom / rangeTo the chart uses. Filter
      // on COALESCE(payment_date, invoice_date, created_at) so a row
      // still counts even when it hasn't been paid yet.
      const params = [];
      const rangeClauses = [];
      if (rangeFrom) {
        params.push(rangeFrom);
        rangeClauses.push(`COALESCE(e.payment_date, e.invoice_date, e.created_at::date) >= $${params.length}`);
      }
      if (rangeTo) {
        params.push(rangeTo);
        rangeClauses.push(`COALESCE(e.payment_date, e.invoice_date, e.created_at::date) <= $${params.length}`);
      }
      const breakdownFilterClause = applyFilters(params, 'e');
      const { rows } = await pool.query(`
        SELECT
          ${labelExpr} AS label,
          COALESCE(SUM(CASE WHEN e.payment_status = 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS paid_usd,
          COALESCE(SUM(CASE WHEN e.payment_status IS DISTINCT FROM 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS unpaid_usd,
          COUNT(*)::int AS row_count
        FROM expenses e
        WHERE e.status = 'approved'
          AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided  IS NULL OR e.voided  = FALSE)
          AND e.parent_id IS NULL
          ${rangeClauses.length ? 'AND ' + rangeClauses.join(' AND ') : ''}
          ${breakdownFilterClause}
        GROUP BY ${groupExpr}
        ORDER BY paid_usd DESC
        LIMIT 10
      `, params);
      return rows;
    };

    const [byArtist, bySong, byCategory] = await Promise.all([
      breakdownQuery('artist'),
      breakdownQuery('song'),
      breakdownQuery('category'),
    ]);

    // 4-7. New sections — aging, upcoming, category trend, recoupment.
    //      Each wrapped in try/catch so a single query bug can't 500
    //      the whole exec response. A broken section renders as an
    //      empty/skipped card on the client, not a total load failure.
    const safeQuery = async (label, fn, fallback) => {
      try { return await fn(); }
      catch (err) {
        console.error(`GET /api/financials/exec[${label}]:`, err.message);
        return fallback;
      }
    };

    // 4. Aging buckets — unpaid invoices grouped by days past their
    //    *invoice-anchored* due date. Uses invoice_date + payment_terms
    //    (parsed for Net N / Due on receipt) instead of the
    //    submission-anchored `scheduled_payment_date` — which is
    //    auto-computed as `created_at + Net 30` and hides real overdue
    //    invoices when a vendor submits stale invoices.
    //
    //    Positive days_overdue = past due; 0 or negative = not-yet-due.
    //    Breaks at 30 / 60 / 90 for the aging pill row.
    const agingParams = [iso(laToday)];
    const agingFilterClause = applyFilters(agingParams, 'e');
    const agingRes = await safeQuery('aging', () => pool.query(`
      WITH unpaid AS (
        SELECT
          -- Effective due date, invoice-anchored. Parse "Net 30" /
          -- "Net 60" etc. from payment_terms; "Due on receipt" → 0
          -- days; default 30 days for missing / unrecognized terms.
          -- Falls back to created_at when invoice_date is missing so
          -- the row still gets a due date.
          (COALESCE(e.invoice_date, e.created_at::date) +
            (CASE
              WHEN e.payment_terms ~* '^due\\s*on\\s*receipt' THEN 0
              WHEN e.payment_terms ~* '^net\\s*\\d+'
                THEN (substring(e.payment_terms from '\\d+'))::int
              ELSE 30
            END) * INTERVAL '1 day')::date AS due_date,
          e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1) AS usd,
          e.id
        FROM expenses e
        WHERE e.status = 'approved'
          AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided  IS NULL OR e.voided  = FALSE)
          AND e.parent_id IS NULL
          AND e.payment_status IS DISTINCT FROM 'Paid'
          ${agingFilterClause}
      )
      SELECT
        CASE
          WHEN due_date IS NULL OR due_date >= $1::date THEN 'not_yet_due'
          WHEN ($1::date - due_date) <= 30 THEN '0-30'
          WHEN ($1::date - due_date) <= 60 THEN '30-60'
          WHEN ($1::date - due_date) <= 90 THEN '60-90'
          ELSE '90+'
        END AS bucket,
        COUNT(*)::int AS count,
        COALESCE(SUM(usd), 0)::float AS usd
      FROM unpaid
      GROUP BY bucket
    `, agingParams), { rows: [] });
    const agingBuckets = { '0-30': { count: 0, usd: 0 }, '30-60': { count: 0, usd: 0 }, '60-90': { count: 0, usd: 0 }, '90+': { count: 0, usd: 0 }, not_yet_due: { count: 0, usd: 0 } };
    for (const r of (agingRes?.rows || [])) {
      agingBuckets[r.bucket] = { count: r.count, usd: Number(r.usd) };
    }

    // 5. Upcoming due — invoices with a future due_date. Three windows
    //    (7, 30, 60 days) so the exec can eyeball the near-term cash
    //    call. Same invoice-anchored due-date as aging so the two
    //    cards agree; same unpaid filter. DATE + INTEGER math (not
    //    DATE + INTERVAL) so both sides of the BETWEEN stay DATE.
    const upcomingParams = [iso(laToday)];
    const upcomingFilterClause = applyFilters(upcomingParams, 'e');
    const upcomingRes = await safeQuery('upcoming', () => pool.query(`
      WITH unpaid AS (
        SELECT
          (COALESCE(e.invoice_date, e.created_at::date) +
            (CASE
              WHEN e.payment_terms ~* '^due\\s*on\\s*receipt' THEN 0
              WHEN e.payment_terms ~* '^net\\s*\\d+'
                THEN (substring(e.payment_terms from '\\d+'))::int
              ELSE 30
            END) * INTERVAL '1 day')::date AS due_date,
          e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1) AS usd,
          e.id
        FROM expenses e
        WHERE e.status = 'approved'
          AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided  IS NULL OR e.voided  = FALSE)
          AND e.parent_id IS NULL
          AND e.payment_status IS DISTINCT FROM 'Paid'
          ${upcomingFilterClause}
      )
      SELECT
        SUM(CASE WHEN due_date BETWEEN $1::date AND ($1::date + 7)  THEN 1 ELSE 0 END)::int AS in_7_count,
        COALESCE(SUM(CASE WHEN due_date BETWEEN $1::date AND ($1::date + 7)  THEN usd ELSE 0 END), 0)::float AS in_7_usd,
        SUM(CASE WHEN due_date BETWEEN $1::date AND ($1::date + 30) THEN 1 ELSE 0 END)::int AS in_30_count,
        COALESCE(SUM(CASE WHEN due_date BETWEEN $1::date AND ($1::date + 30) THEN usd ELSE 0 END), 0)::float AS in_30_usd,
        SUM(CASE WHEN due_date BETWEEN $1::date AND ($1::date + 60) THEN 1 ELSE 0 END)::int AS in_60_count,
        COALESCE(SUM(CASE WHEN due_date BETWEEN $1::date AND ($1::date + 60) THEN usd ELSE 0 END), 0)::float AS in_60_usd
      FROM unpaid
    `, upcomingParams), { rows: [] });
    const upcoming = (upcomingRes?.rows?.[0]) || {};

    // 6. Category composition trend — monthly spend per category over
    //    the range. Client renders as a stacked area chart. Only
    //    top-8 categories by USD across the window get their own band;
    //    everything else rolls into "Other" so the chart doesn't drown
    //    in tiny bands.
    const catTrendFrom = rangeFrom || iso(new Date(laToday.getFullYear(), laToday.getMonth() - 11, 1));
    const catTrendTo   = rangeTo   || iso(laToday);
    const catTrendParams = [catTrendFrom, catTrendTo];
    const catTrendFilterClause = applyFilters(catTrendParams, 'e');
    const catTrendRes = await safeQuery('category_trend', () => pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', COALESCE(e.payment_date, e.invoice_date, e.created_at::date)), 'YYYY-MM') AS month,
        COALESCE(NULLIF(TRIM(e.category), ''), 'Uncategorized') AS category,
        COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1)), 0)::float AS usd
      FROM expenses e
      WHERE e.status = 'approved'
        AND (e.deleted IS NULL OR e.deleted = FALSE)
        AND (e.voided  IS NULL OR e.voided  = FALSE)
        AND e.parent_id IS NULL
        AND COALESCE(e.payment_date, e.invoice_date, e.created_at::date) BETWEEN $1::date AND $2::date
        ${catTrendFilterClause}
      GROUP BY month, category
      ORDER BY month ASC
    `, catTrendParams), { rows: [] });
    // Roll into { month → { category → usd } }, then pick top-8 categories
    // by grand total, collapse the rest into "Other".
    const catByMonth = new Map();
    const catTotals = new Map();
    for (const r of (catTrendRes?.rows || [])) {
      if (!catByMonth.has(r.month)) catByMonth.set(r.month, {});
      catByMonth.get(r.month)[r.category] = Number(r.usd);
      catTotals.set(r.category, (catTotals.get(r.category) || 0) + Number(r.usd));
    }
    const topCats = Array.from(catTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([c]) => c);
    const topCatsSet = new Set(topCats);
    const catTrend = Array.from(catByMonth.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, cats]) => {
        const row = { month };
        for (const c of topCats) row[c] = cats[c] || 0;
        let other = 0;
        for (const [c, v] of Object.entries(cats)) if (!topCatsSet.has(c)) other += v;
        if (other > 0) row.Other = other;
        return row;
      });

    // 7. Recoupment scoreboard — per-artist. Sum of recoupable spend
    //    (paid + unpaid together — both count toward the artist's
    //    balance) minus recouped income from artist_income. Positive
    //    net = artist still in debt. Case-insensitive artist grouping.
    // Recoupment: filter clause uses no alias (bare column names in
    // the CTE). Reps / categories carry across too — an exec looking
    // at "Marketing" spend only cares about how Marketing recouped.
    const recoupParams = [];
    const recoupFilterClause = applyFilters(recoupParams, '');
    const recoupRes = await safeQuery('recoupment', () => pool.query(`
      WITH spend AS (
        SELECT
          COALESCE(NULLIF(TRIM(LOWER(artist)), ''), 'unassigned') AS artist_key,
          MAX(artist) AS artist,
          COALESCE(SUM(amount / COALESCE(NULLIF(fx_rate_to_usd, 0), 1)), 0)::float AS spend_usd
        FROM expenses
        WHERE status = 'approved'
          AND (deleted IS NULL OR deleted = FALSE)
          AND (voided  IS NULL OR voided  = FALSE)
          AND parent_id IS NULL
          AND recoupable = TRUE
          ${recoupFilterClause}
        GROUP BY artist_key
      ),
      -- Income joins on ai.artist_id, which nothing currently populates, so this
      -- credits nothing and every artist reads 0% recouped. Left as-is
      -- deliberately (2026-08-06, John's call): income is not attributed per
      -- artist, so the income column here is not a number anyone relies on.
      -- Don't "fix" it without deciding whether per-artist recoupment is wanted.
      income AS (
        SELECT
          COALESCE(NULLIF(TRIM(LOWER(a.name)), ''), 'unassigned') AS artist_key,
          COALESCE(SUM(ai.amount), 0)::float AS income_usd
        FROM artist_income ai
        LEFT JOIN artists a ON a.id = ai.artist_id
        GROUP BY artist_key
      )
      SELECT
        COALESCE(s.artist, INITCAP(s.artist_key)) AS artist,
        s.artist_key,
        s.spend_usd,
        COALESCE(i.income_usd, 0)::float AS income_usd,
        (s.spend_usd - COALESCE(i.income_usd, 0))::float AS unrecouped_usd,
        CASE WHEN s.spend_usd > 0
             THEN LEAST(100, (COALESCE(i.income_usd, 0) / s.spend_usd) * 100)
             ELSE 0 END::float AS pct_recouped
      FROM spend s
      LEFT JOIN income i USING (artist_key)
      WHERE s.spend_usd > 0
      ORDER BY unrecouped_usd DESC
      LIMIT 50
    `, recoupParams), { rows: [] });

    // 8. Vendor concentration — top 12 payees by total (paid+unpaid) so
    //    the exec can spot the 80/20 concentration. Also returns count
    //    per vendor for the compact bar row.
    const vendorScopeParams = [];
    const vendorScopeClauses = [];
    if (rangeFrom) {
      vendorScopeParams.push(rangeFrom);
      vendorScopeClauses.push(`COALESCE(e.payment_date, e.invoice_date, e.created_at::date) >= $${vendorScopeParams.length}`);
    }
    if (rangeTo) {
      vendorScopeParams.push(rangeTo);
      vendorScopeClauses.push(`COALESCE(e.payment_date, e.invoice_date, e.created_at::date) <= $${vendorScopeParams.length}`);
    }
    // Cross-page filter — appended after range scope so $N indices
    // stay consistent across the four vendor / velocity / method /
    // rep queries that share this params array.
    const vendorFilterFragment = applyFilters(vendorScopeParams, 'e');
    if (vendorFilterFragment) vendorScopeClauses.push(vendorFilterFragment.replace(/^ AND /, ''));
    const vendorRes = await safeQuery('vendors', () => pool.query(`
      SELECT
        COALESCE(NULLIF(TRIM(e.payee), ''), 'Unknown') AS payee,
        COALESCE(SUM(CASE WHEN e.payment_status = 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS paid_usd,
        COALESCE(SUM(CASE WHEN e.payment_status IS DISTINCT FROM 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS unpaid_usd,
        COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1)), 0)::float AS total_usd,
        COUNT(*)::int AS invoice_count
      FROM expenses e
      WHERE e.status = 'approved'
        AND (e.deleted IS NULL OR e.deleted = FALSE)
        AND (e.voided  IS NULL OR e.voided  = FALSE)
        AND e.parent_id IS NULL
        ${vendorScopeClauses.length ? 'AND ' + vendorScopeClauses.join(' AND ') : ''}
      GROUP BY COALESCE(NULLIF(TRIM(e.payee), ''), 'Unknown')
      HAVING COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1)), 0) > 0
      ORDER BY total_usd DESC
      LIMIT 12
    `, vendorScopeParams), { rows: [] });
    // Grand total (across ALL vendors, not just top 12) so the Pareto
    // % is calibrated against the real universe — otherwise "top 12
    // is 100%" would be trivially true.
    const vendorTotalRes = await safeQuery('vendors_total', () => pool.query(`
      SELECT COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1)), 0)::float AS grand_total
      FROM expenses e
      WHERE e.status = 'approved'
        AND (e.deleted IS NULL OR e.deleted = FALSE)
        AND (e.voided  IS NULL OR e.voided  = FALSE)
        AND e.parent_id IS NULL
        ${vendorScopeClauses.length ? 'AND ' + vendorScopeClauses.join(' AND ') : ''}
    `, vendorScopeParams), { rows: [{ grand_total: 0 }] });
    const vendorGrandTotal = Number(vendorTotalRes?.rows?.[0]?.grand_total) || 0;

    // 9. Payment velocity — histogram of days-to-pay across paid rows
    //    in the range. Buckets tuned around Net-30 as the norm.
    const velocityRes = await safeQuery('velocity', () => pool.query(`
      WITH paid AS (
        SELECT
          (e.payment_date - COALESCE(e.invoice_date, e.created_at::date))::int AS days_to_pay,
          e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1) AS usd
        FROM expenses e
        WHERE e.status = 'approved'
          AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided  IS NULL OR e.voided  = FALSE)
          AND e.parent_id IS NULL
          AND e.payment_status = 'Paid'
          AND e.payment_date IS NOT NULL
          ${vendorScopeClauses.length ? 'AND ' + vendorScopeClauses.join(' AND ') : ''}
      )
      SELECT
        CASE
          WHEN days_to_pay <= 0  THEN '0'
          WHEN days_to_pay <= 7  THEN '1-7'
          WHEN days_to_pay <= 14 THEN '8-14'
          WHEN days_to_pay <= 30 THEN '15-30'
          WHEN days_to_pay <= 60 THEN '31-60'
          ELSE '60+'
        END AS bucket,
        COUNT(*)::int AS count,
        COALESCE(SUM(usd), 0)::float AS usd,
        ROUND(AVG(days_to_pay))::int AS avg_days
      FROM paid
      GROUP BY bucket
    `, vendorScopeParams), { rows: [] });
    // Emit in fixed order so the client doesn't have to sort.
    const VELOCITY_ORDER = ['0', '1-7', '8-14', '15-30', '31-60', '60+'];
    const velocityMap = new Map((velocityRes?.rows || []).map(r => [r.bucket, r]));
    const velocity = VELOCITY_ORDER.map(b => ({
      bucket: b,
      count: Number(velocityMap.get(b)?.count) || 0,
      usd: Number(velocityMap.get(b)?.usd) || 0,
    }));
    // Also compute a single median-days figure across the whole range
    // for the section subtitle. Postgres's percentile_cont is exact.
    const medianRes = await safeQuery('velocity_median', () => pool.query(`
      SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY (e.payment_date - COALESCE(e.invoice_date, e.created_at::date))::int)::float AS median_days,
        AVG((e.payment_date - COALESCE(e.invoice_date, e.created_at::date))::int)::float AS mean_days,
        COUNT(*)::int AS paid_count
      FROM expenses e
      WHERE e.status = 'approved'
        AND (e.deleted IS NULL OR e.deleted = FALSE)
        AND (e.voided  IS NULL OR e.voided  = FALSE)
        AND e.parent_id IS NULL
        AND e.payment_status = 'Paid'
        AND e.payment_date IS NOT NULL
        ${vendorScopeClauses.length ? 'AND ' + vendorScopeClauses.join(' AND ') : ''}
    `, vendorScopeParams), { rows: [{}] });
    const velocityStats = medianRes?.rows?.[0] || {};

    // 10. Payment method mix — USD paid by method over the range. Null
    //     methods bucket into "Not set" so it stays visible as a
    //     hygiene metric (any real % of "Not set" = missing data).
    const methodRes = await safeQuery('methods', () => pool.query(`
      SELECT
        COALESCE(NULLIF(TRIM(e.payment_method), ''), 'Not set') AS method,
        COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1)), 0)::float AS usd,
        COUNT(*)::int AS count
      FROM expenses e
      WHERE e.status = 'approved'
        AND (e.deleted IS NULL OR e.deleted = FALSE)
        AND (e.voided  IS NULL OR e.voided  = FALSE)
        AND e.parent_id IS NULL
        AND e.payment_status = 'Paid'
        ${vendorScopeClauses.length ? 'AND ' + vendorScopeClauses.join(' AND ') : ''}
      GROUP BY COALESCE(NULLIF(TRIM(e.payment_method), ''), 'Not set')
      HAVING COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1)), 0) > 0
      ORDER BY usd DESC
    `, vendorScopeParams), { rows: [] });

    // 11. Rep leaderboard — total USD by boom_rep. Empty reps ("Not
    //     assigned") get their own bar so the accountability gap is
    //     visible.
    const repRes = await safeQuery('reps', () => pool.query(`
      SELECT
        COALESCE(NULLIF(TRIM(e.boom_rep), ''), 'Not assigned') AS rep,
        COALESCE(SUM(CASE WHEN e.payment_status = 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS paid_usd,
        COALESCE(SUM(CASE WHEN e.payment_status IS DISTINCT FROM 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS unpaid_usd,
        COUNT(*)::int AS invoice_count
      FROM expenses e
      WHERE e.status = 'approved'
        AND (e.deleted IS NULL OR e.deleted = FALSE)
        AND (e.voided  IS NULL OR e.voided  = FALSE)
        AND e.parent_id IS NULL
        ${vendorScopeClauses.length ? 'AND ' + vendorScopeClauses.join(' AND ') : ''}
      GROUP BY COALESCE(NULLIF(TRIM(e.boom_rep), ''), 'Not assigned')
      HAVING COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1)), 0) > 0
      ORDER BY (paid_usd + unpaid_usd) DESC
      LIMIT 15
    `, vendorScopeParams), { rows: [] });

    // 12. Cash forecast — 30 / 60 / 90 day windows.
    //     committed_usd = unpaid invoices currently on the books whose
    //                     invoice-anchored due date falls inside the window
    //     projected_usd = trailing-4-week avg of NEW invoicing extrapolated
    //                     forward across the window
    //     total_usd     = committed + projected — the "plan for X" number
    //
    //     Projected is inherently a rough estimate; the exec should treat
    //     it as a directional planning aid, not a promise. If receipt
    //     activity is flat, projected is small; if the label is scaling
    //     up, projected grows with the recent rate.
    const forecastParams = [iso(laToday)];
    const forecastFilterClause = applyFilters(forecastParams, 'e');
    const forecastRes = await safeQuery('cash_forecast', () => pool.query(`
      WITH unpaid_due AS (
        SELECT
          (COALESCE(e.invoice_date, e.created_at::date) +
            (CASE
              WHEN e.payment_terms ~* '^due\\s*on\\s*receipt' THEN 0
              WHEN e.payment_terms ~* '^net\\s*\\d+'
                THEN (substring(e.payment_terms from '\\d+'))::int
              ELSE 30
            END) * INTERVAL '1 day')::date AS due_date,
          e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1) AS usd
        FROM expenses e
        WHERE e.status = 'approved'
          AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided  IS NULL OR e.voided  = FALSE)
          AND e.parent_id IS NULL
          AND e.payment_status IS DISTINCT FROM 'Paid'
          ${forecastFilterClause}
      ),
      -- Trailing 4 weeks of new-invoicing $ per week. Uses created_at
      -- (submission date) since that's when a bill lands in market.st's
      -- inbox regardless of invoice_date. Avg → weekly rate.
      recent_intake AS (
        SELECT COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1)), 0)::float / 4.0 AS weekly_avg_usd
        FROM expenses e
        WHERE e.status = 'approved'
          AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided  IS NULL OR e.voided  = FALSE)
          AND e.parent_id IS NULL
          AND e.created_at >= (NOW() - INTERVAL '28 days')
          ${forecastFilterClause}
      )
      SELECT
        (SELECT COALESCE(SUM(usd), 0)::float FROM unpaid_due WHERE due_date <= $1::date + 30) AS committed_30,
        (SELECT COALESCE(SUM(usd), 0)::float FROM unpaid_due WHERE due_date <= $1::date + 60) AS committed_60,
        (SELECT COALESCE(SUM(usd), 0)::float FROM unpaid_due WHERE due_date <= $1::date + 90) AS committed_90,
        ((SELECT weekly_avg_usd FROM recent_intake) * (30.0 / 7.0))::float AS projected_30,
        ((SELECT weekly_avg_usd FROM recent_intake) * (60.0 / 7.0))::float AS projected_60,
        ((SELECT weekly_avg_usd FROM recent_intake) * (90.0 / 7.0))::float AS projected_90,
        (SELECT weekly_avg_usd FROM recent_intake)::float AS weekly_avg_usd
    `, forecastParams), { rows: [{}] });
    const fc = forecastRes?.rows?.[0] || {};

    res.json({
      success: true,
      data: {
        kpi: {
          this_week: Number(kpi.this_week) || 0,
          last_week: Number(kpi.last_week) || 0,
          mtd:       Number(kpi.mtd)       || 0,
          last_mtd:  Number(kpi.last_mtd)  || 0,
          ytd:       Number(kpi.ytd)       || 0,
          last_ytd:  Number(kpi.last_ytd)  || 0,
          unpaid_total: Number(kpi.unpaid_total) || 0,
          unpaid_count: Number(kpi.unpaid_count) || 0,
        },
        weeks: weeksRes.rows,
        breakdowns: {
          artist:   byArtist,
          song:     bySong,
          category: byCategory,
        },
        aging: agingBuckets,
        upcoming: {
          in_7:  { count: upcoming.in_7_count  || 0, usd: Number(upcoming.in_7_usd)  || 0 },
          in_30: { count: upcoming.in_30_count || 0, usd: Number(upcoming.in_30_usd) || 0 },
          in_60: { count: upcoming.in_60_count || 0, usd: Number(upcoming.in_60_usd) || 0 },
        },
        category_trend: {
          months: catTrend,
          categories: topCats.concat(catTrend.some(r => r.Other) ? ['Other'] : []),
        },
        recoupment: recoupRes?.rows || [],
        vendors: {
          rows: vendorRes?.rows || [],
          grand_total: vendorGrandTotal,
        },
        velocity: {
          buckets: velocity,
          median_days: Number(velocityStats.median_days) || 0,
          mean_days: Number(velocityStats.mean_days) || 0,
          paid_count: Number(velocityStats.paid_count) || 0,
        },
        methods: methodRes?.rows || [],
        reps: repRes?.rows || [],
        forecast: {
          weekly_avg_usd: Number(fc.weekly_avg_usd) || 0,
          in_30: { committed: Number(fc.committed_30) || 0, projected: Number(fc.projected_30) || 0 },
          in_60: { committed: Number(fc.committed_60) || 0, projected: Number(fc.projected_60) || 0 },
          in_90: { committed: Number(fc.committed_90) || 0, projected: Number(fc.projected_90) || 0 },
        },
        filters: {
          applied: hasAnyFilter,
          artist: filterArtist || null,
          category: filterCategory || null,
          rep: filterRep || null,
        },
      },
    });
  } catch (err) {
    console.error('GET /api/financials/exec:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/financials/filter-options
// Distinct non-null values for the Financials page's cross-scope
// filter dropdowns — artists, categories, reps — derived from
// approved-and-live expenses so the dropdowns show only options
// that actually have data. Cheap enough to hit on every page load.
router.get('/filter-options', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH base AS (
        SELECT artist, category, boom_rep FROM expenses
        WHERE status = 'approved'
          AND (deleted IS NULL OR deleted = FALSE)
          AND (voided  IS NULL OR voided  = FALSE)
          AND parent_id IS NULL
      )
      SELECT
        (SELECT COALESCE(json_agg(a ORDER BY a), '[]')
           FROM (SELECT DISTINCT TRIM(artist) AS a FROM base
                 WHERE artist IS NOT NULL AND TRIM(artist) != '') s) AS artists,
        (SELECT COALESCE(json_agg(c ORDER BY c), '[]')
           FROM (SELECT DISTINCT TRIM(category) AS c FROM base
                 WHERE category IS NOT NULL AND TRIM(category) != '') s) AS categories,
        (SELECT COALESCE(json_agg(r ORDER BY r), '[]')
           FROM (SELECT DISTINCT TRIM(boom_rep) AS r FROM base
                 WHERE boom_rep IS NOT NULL AND TRIM(boom_rep) != '') s) AS reps
    `);
    const r = rows[0] || {};
    res.json({
      success: true,
      data: {
        artists:    r.artists    || [],
        categories: r.categories || [],
        reps:       r.reps       || [],
      },
    });
  } catch (err) {
    console.error('GET /api/financials/filter-options:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Top-spend sub-breakdown ───────────────────────────────────────────────
// GET /api/financials/exec/subbreakdown?dimension=artist|song&value=<name>
//   &from=YYYY-MM-DD&to=YYYY-MM-DD&artist=&category=&rep=
//
// Returns the categories that make up spend for a single artist or
// song. Powers the expandable rows on the Top Spend section: click
// "Jerri" → this endpoint returns the categories inside Jerri's spend.
// Case-insensitive artist matching (LOWER(TRIM(...))) mirrors the rest
// of the app; song matching is case-insensitive but trim-normalized
// only (song names vary in casing / punctuation but not enough to
// warrant deeper normalization).
router.get('/exec/subbreakdown', authMiddleware, async (req, res) => {
  const dimension = String(req.query.dimension || '').toLowerCase();
  const value     = String(req.query.value || '').trim();
  if (dimension !== 'artist' && dimension !== 'song') {
    return res.status(400).json({ success: false, error: 'dimension must be artist or song' });
  }
  if (!value) return res.status(400).json({ success: false, error: 'value required' });
  if (value.length > 200) return res.status(400).json({ success: false, error: 'value too long' });

  const rangeFrom = (req.query.from && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)) ? req.query.from : null;
  const rangeTo   = (req.query.to   && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to))   ? req.query.to   : null;
  const filterArtist   = String(req.query.artist   || '').trim().slice(0, 120);
  const filterCategory = String(req.query.category || '').trim().slice(0, 120);
  const filterRep      = String(req.query.rep      || '').trim().slice(0, 120);

  try {
    const params = [];
    // Dimension selector — case-insensitive equality against
    // artist/song, matching the /exec breakdown's grouping.
    params.push(value);
    const dimClause = dimension === 'artist'
      ? `LOWER(TRIM(e.artist)) = LOWER(TRIM($${params.length}))`
      : `LOWER(TRIM(e.song))   = LOWER(TRIM($${params.length}))`;

    // Range scope — anchored on COALESCE(payment_date, invoice_date,
    // created_at), same as the /exec breakdown.
    const rangeClauses = [];
    if (rangeFrom) {
      params.push(rangeFrom);
      rangeClauses.push(`COALESCE(e.payment_date, e.invoice_date, e.created_at::date) >= $${params.length}`);
    }
    if (rangeTo) {
      params.push(rangeTo);
      rangeClauses.push(`COALESCE(e.payment_date, e.invoice_date, e.created_at::date) <= $${params.length}`);
    }
    // Cross-page filter clauses (artist / category / rep). Threaded
    // via applyFilters-style helper so a filter selected on the main
    // dashboard scopes the sub-breakdown too. If the user already
    // filtered by artist=X on the page, this endpoint respects it
    // even when clicking a different artist (unusual but honest).
    const filterClauses = [];
    if (filterArtist)   { params.push(filterArtist);   filterClauses.push(`LOWER(TRIM(e.artist)) = LOWER(TRIM($${params.length}))`); }
    if (filterCategory) { params.push(filterCategory); filterClauses.push(`e.category = $${params.length}`); }
    if (filterRep)      { params.push(filterRep);      filterClauses.push(`e.boom_rep = $${params.length}`); }

    const extraWhere = [...rangeClauses, ...filterClauses];

    const { rows } = await pool.query(`
      SELECT
        COALESCE(NULLIF(TRIM(e.category), ''), 'Uncategorized') AS category,
        COALESCE(SUM(CASE WHEN e.payment_status = 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS paid_usd,
        COALESCE(SUM(CASE WHEN e.payment_status IS DISTINCT FROM 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS unpaid_usd,
        COUNT(*)::int AS row_count
      FROM expenses e
      WHERE e.status = 'approved'
        AND (e.deleted IS NULL OR e.deleted = FALSE)
        AND (e.voided  IS NULL OR e.voided  = FALSE)
        AND e.parent_id IS NULL
        AND ${dimClause}
        ${extraWhere.length ? 'AND ' + extraWhere.join(' AND ') : ''}
      GROUP BY COALESCE(NULLIF(TRIM(e.category), ''), 'Uncategorized')
      HAVING COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1)), 0) > 0
      ORDER BY (COALESCE(SUM(CASE WHEN e.payment_status = 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1) ELSE 0 END), 0)
              + COALESCE(SUM(CASE WHEN e.payment_status IS DISTINCT FROM 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1) ELSE 0 END), 0)) DESC
    `, params);

    res.json({
      success: true,
      data: { dimension, value, categories: rows },
    });
  } catch (err) {
    console.error('GET /api/financials/exec/subbreakdown:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── KPI drill-down rows ────────────────────────────────────────────────────
// GET /api/financials/exec/rows?bucket=<this_week|last_week|mtd|ytd|unpaid>
// Returns the invoice rows behind one of the four exec-dashboard KPI
// cards. Client opens a modal with this list. Same window semantics as
// the KPI computation in /exec (day-matched last_mtd / last_ytd), so
// the modal's total footer matches the card's number to the dollar.
router.get('/exec/rows', authMiddleware, async (req, res) => {
  const bucket = String(req.query.bucket || '').toLowerCase();
  const allowed = new Set([
    // KPI card drill-downs
    'this_week', 'last_week', 'mtd', 'last_mtd', 'ytd', 'last_ytd', 'unpaid',
    // Payment aging bucket drill-downs (invoice-anchored due date)
    'aging_0_30', 'aging_30_60', 'aging_60_90', 'aging_90_plus',
    // Upcoming-due window drill-downs
    'upcoming_7', 'upcoming_30', 'upcoming_60',
  ]);
  if (!allowed.has(bucket)) {
    return res.status(400).json({ success: false, error: 'unknown bucket' });
  }

  // Mirror the /exec cross-page filters so the modal totals stay in
  // agreement with the card the user just clicked.
  const filterArtist   = String(req.query.artist   || '').trim().slice(0, 120);
  const filterCategory = String(req.query.category || '').trim().slice(0, 120);
  const filterRep      = String(req.query.rep      || '').trim().slice(0, 120);
  const applyFilters = (params, alias = 'e') => {
    const p = alias ? `${alias}.` : '';
    const parts = [];
    if (filterArtist)   { params.push(filterArtist);   parts.push(`LOWER(TRIM(${p}artist)) = LOWER(TRIM($${params.length}))`); }
    if (filterCategory) { params.push(filterCategory); parts.push(`${p}category = $${params.length}`); }
    if (filterRep)      { params.push(filterRep);      parts.push(`${p}boom_rep = $${params.length}`); }
    return parts.length ? ' AND ' + parts.join(' AND ') : '';
  };

  const now = new Date();
  const laToday = new Date(now.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }));
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (d, n) => { const c = new Date(d); c.setDate(c.getDate() + n); return c; };
  const startOfWeekMon = (d) => {
    const c = new Date(d);
    const day = c.getDay();
    c.setDate(c.getDate() + (day === 0 ? -6 : 1 - day));
    return c;
  };
  const dayMatchedBack = (d, monthsBack) => {
    const dayOfMonth = d.getDate();
    const lastDayOfTarget = new Date(d.getFullYear(), d.getMonth() - monthsBack + 1, 0);
    const lastValidDay = Math.min(dayOfMonth, lastDayOfTarget.getDate());
    return new Date(d.getFullYear(), d.getMonth() - monthsBack, lastValidDay);
  };

  let fromDate, toDate, paidOnly = true;
  if (bucket === 'this_week') {
    fromDate = startOfWeekMon(laToday); toDate = laToday;
  } else if (bucket === 'last_week') {
    // Day-matched: Mon→(today−7) to mirror the current Mon→today window.
    const wkStart = startOfWeekMon(laToday);
    fromDate = addDays(wkStart, -7); toDate = addDays(laToday, -7);
  } else if (bucket === 'mtd') {
    fromDate = new Date(laToday.getFullYear(), laToday.getMonth(), 1); toDate = laToday;
  } else if (bucket === 'last_mtd') {
    fromDate = new Date(laToday.getFullYear(), laToday.getMonth() - 1, 1);
    toDate = dayMatchedBack(laToday, 1);
  } else if (bucket === 'ytd') {
    fromDate = new Date(laToday.getFullYear(), 0, 1); toDate = laToday;
  } else if (bucket === 'last_ytd') {
    fromDate = new Date(laToday.getFullYear() - 1, 0, 1);
    toDate = dayMatchedBack(laToday, 12);
  } else if (bucket === 'unpaid') {
    paidOnly = false; // no date window — all outstanding
  }

  // Invoice-anchored due date expression — used by aging_* and
  // upcoming_* branches so the drill-through matches the summary
  // cards exactly. Kept as a string constant so a schema tweak lives
  // in one place.
  const DUE_DATE_EXPR = `
    (COALESCE(e.invoice_date, e.created_at::date) +
      (CASE
        WHEN e.payment_terms ~* '^due\\s*on\\s*receipt' THEN 0
        WHEN e.payment_terms ~* '^net\\s*\\d+'
          THEN (substring(e.payment_terms from '\\d+'))::int
        ELSE 30
      END) * INTERVAL '1 day')::date
  `;
  const UNPAID_FILTERS = `
    e.status = 'approved'
    AND (e.deleted IS NULL OR e.deleted = FALSE)
    AND (e.voided  IS NULL OR e.voided  = FALSE)
    AND e.parent_id IS NULL
    AND e.payment_status IS DISTINCT FROM 'Paid'
  `;

  try {
    let sql, params;
    if (bucket === 'unpaid') {
      // days_overdue uses the same invoice_date + payment_terms anchor
      // as the aging card, so the drill-through matches the summary.
      params = [];
      const filterClause = applyFilters(params, 'e');
      sql = `
        SELECT e.id, e.invoice_date, e.invoice_number, e.payee, e.artist, e.song,
               e.category, e.currency, e.amount, e.boom_rep,
               (e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1))::float AS amount_usd,
               e.payment_status, e.payment_date, e.scheduled_payment_date,
               ((NOW() AT TIME ZONE 'America/Los_Angeles')::date - ${DUE_DATE_EXPR})::int AS days_overdue
        FROM expenses e
        WHERE ${UNPAID_FILTERS}
          ${filterClause}
        ORDER BY (e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1)) DESC
        LIMIT 200
      `;
    } else if (bucket.startsWith('aging_')) {
      // Aging bucket drill-downs. Filter by days_overdue window against
      // the invoice-anchored due date. 90+ is any overdue >= 91.
      const [minDays, maxDays] = ({
        aging_0_30:    [1,   30],
        aging_30_60:   [31,  60],
        aging_60_90:   [61,  90],
        aging_90_plus: [91,  null],
      })[bucket] || [1, 30];
      params = maxDays == null ? [minDays] : [minDays, maxDays];
      const filterClause = applyFilters(params, 'e');
      const upper = maxDays == null
        ? ''
        : `AND ((NOW() AT TIME ZONE 'America/Los_Angeles')::date - ${DUE_DATE_EXPR}) <= $2::int`;
      sql = `
        SELECT e.id, e.invoice_date, e.invoice_number, e.payee, e.artist, e.song,
               e.category, e.currency, e.amount, e.boom_rep,
               (e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1))::float AS amount_usd,
               e.payment_status, e.payment_date, e.scheduled_payment_date,
               ${DUE_DATE_EXPR} AS due_date,
               ((NOW() AT TIME ZONE 'America/Los_Angeles')::date - ${DUE_DATE_EXPR})::int AS days_overdue
        FROM expenses e
        WHERE ${UNPAID_FILTERS}
          AND ((NOW() AT TIME ZONE 'America/Los_Angeles')::date - ${DUE_DATE_EXPR}) >= $1::int
          ${upper}
          ${filterClause}
        ORDER BY ((NOW() AT TIME ZONE 'America/Los_Angeles')::date - ${DUE_DATE_EXPR}) DESC,
                 (e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1)) DESC
        LIMIT 200
      `;
      paidOnly = false; // aging rows are all unpaid
    } else if (bucket.startsWith('upcoming_')) {
      // Upcoming-due drill-downs: due_date within N days from today.
      const days = ({ upcoming_7: 7, upcoming_30: 30, upcoming_60: 60 })[bucket] || 7;
      params = [days];
      const filterClause = applyFilters(params, 'e');
      sql = `
        SELECT e.id, e.invoice_date, e.invoice_number, e.payee, e.artist, e.song,
               e.category, e.currency, e.amount, e.boom_rep,
               (e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1))::float AS amount_usd,
               e.payment_status, e.payment_date, e.scheduled_payment_date,
               ${DUE_DATE_EXPR} AS due_date,
               (${DUE_DATE_EXPR} - (NOW() AT TIME ZONE 'America/Los_Angeles')::date)::int AS days_until_due
        FROM expenses e
        WHERE ${UNPAID_FILTERS}
          AND ${DUE_DATE_EXPR} BETWEEN (NOW() AT TIME ZONE 'America/Los_Angeles')::date
                                    AND ((NOW() AT TIME ZONE 'America/Los_Angeles')::date + $1::int)
          ${filterClause}
        ORDER BY ${DUE_DATE_EXPR} ASC,
                 (e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1)) DESC
        LIMIT 200
      `;
      paidOnly = false; // unpaid rows
    } else {
      params = [iso(fromDate), iso(toDate)];
      const filterClause = applyFilters(params, 'e');
      sql = `
        SELECT e.id, e.invoice_date, e.invoice_number, e.payee, e.artist, e.song,
               e.category, e.currency, e.amount, e.boom_rep,
               (e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1))::float AS amount_usd,
               e.payment_status, e.payment_date
        FROM expenses e
        WHERE e.status = 'approved'
          AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided  IS NULL OR e.voided  = FALSE)
          AND e.parent_id IS NULL
          AND e.payment_status = 'Paid'
          AND e.payment_date BETWEEN $1::date AND $2::date
          ${filterClause}
        ORDER BY (e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1)) DESC
        LIMIT 200
      `;
    }
    const { rows } = await pool.query(sql, params);
    const total_usd = rows.reduce((s, r) => s + (Number(r.amount_usd) || 0), 0);
    res.json({
      success: true,
      data: {
        bucket,
        from: fromDate ? iso(fromDate) : null,
        to:   toDate   ? iso(toDate)   : null,
        paid_only: paidOnly,
        rows,
        total_usd,
        row_count: rows.length,
      },
    });
  } catch (err) {
    console.error(`GET /api/financials/exec/rows?bucket=${bucket}:`, err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Excel export ───────────────────────────────────────────────────────────
// GET /api/financials/export?from=&to=
// Multi-sheet .xlsx of the whole exec dashboard for the board packet.
// Reuses the ExcelJS palette pattern from routes/artist-campaigns.js
// (brand-red header, banded rows, freeze pane, autofilter).
// One sheet each: Overview (KPI + aging), Weekly, Top artists / songs /
// categories, Recoupment, Monthly, Category trend cross-tab.
const XLSX_HEADER_BG     = 'FFDC2626';
const XLSX_HEADER_BORDER = 'FF991B1B';
const XLSX_TITLE_FG      = 'FF991B1B';
const XLSX_ROW_BAND      = 'FFFAFAFA';
const XLSX_SUBTLE        = 'FF6B7280';
const XLSX_THIN_BORDER   = { style: 'thin', color: { argb: 'FFE5E7EB' } };
const XLSX_ACCENT_LINE   = { style: 'medium', color: { argb: XLSX_HEADER_BORDER } };
const USD_NUM_FMT = '"$"#,##0.00';

function xlsxHeader(ws, columns, headerRowIdx = 4) {
  const header = ws.getRow(headerRowIdx);
  header.values = columns.map(c => c.header);
  header.height = 22;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_HEADER_BG } };
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  header.eachCell(cell => {
    cell.border = {
      top:    { style: 'thin', color: { argb: XLSX_HEADER_BORDER } },
      bottom: { style: 'medium', color: { argb: XLSX_HEADER_BORDER } },
      left:   { style: 'thin', color: { argb: XLSX_HEADER_BORDER } },
      right:  { style: 'thin', color: { argb: XLSX_HEADER_BORDER } },
    };
  });
}

function xlsxTitle(ws, title, subtitle, lastCol) {
  const t = ws.addRow([title]);
  t.height = 26;
  t.font = { bold: true, size: 16, color: { argb: XLSX_TITLE_FG } };
  ws.mergeCells(`A1:${lastCol}1`);
  t.alignment = { vertical: 'middle', horizontal: 'left' };

  const sub = ws.addRow([subtitle]);
  sub.font = { size: 10, color: { argb: XLSX_SUBTLE } };
  ws.mergeCells(`A2:${lastCol}2`);

  ws.addRow([]);
}

function xlsxDataRow(ws, columns, values, bandIdx) {
  const row = ws.addRow(values);
  const banded = bandIdx % 2 === 1;
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    const col = columns[colNumber - 1];
    if (banded) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_ROW_BAND } };
    cell.border = { top: XLSX_THIN_BORDER, bottom: XLSX_THIN_BORDER, left: XLSX_THIN_BORDER, right: XLSX_THIN_BORDER };
    if (col?.type === 'currency') cell.alignment = { horizontal: 'right', vertical: 'middle' };
    else if (col?.type === 'number') cell.alignment = { horizontal: 'right', vertical: 'middle' };
    else if (col?.type === 'percent') cell.alignment = { horizontal: 'right', vertical: 'middle' };
    else if (col?.type === 'date')  cell.alignment = { horizontal: 'center', vertical: 'middle' };
    else cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: !!col?.wrap };
  });
  for (const c of columns) {
    if (c.type === 'currency') row.getCell(c.key).numFmt = USD_NUM_FMT;
    if (c.type === 'date')     row.getCell(c.key).numFmt = 'mm/dd/yyyy';
    if (c.type === 'percent')  row.getCell(c.key).numFmt = '0.0"%"';
  }
  return row;
}

// Bold "Total" row at the bottom of a data block. Amber wash + thick
// top border so it reads as a summary line in board packets.
function xlsxTotalRow(ws, columns, values) {
  const row = ws.addRow(values);
  row.font = { bold: true, size: 10 };
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    const col = columns[colNumber - 1];
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7ED' } };
    cell.border = {
      top:    XLSX_ACCENT_LINE,
      bottom: XLSX_ACCENT_LINE,
      left:   XLSX_THIN_BORDER,
      right:  XLSX_THIN_BORDER,
    };
    if (col?.type === 'currency') cell.alignment = { horizontal: 'right', vertical: 'middle' };
    else if (col?.type === 'number') cell.alignment = { horizontal: 'right', vertical: 'middle' };
    else if (col?.type === 'percent') cell.alignment = { horizontal: 'right', vertical: 'middle' };
    else cell.alignment = { horizontal: 'left', vertical: 'middle' };
  });
  for (const c of columns) {
    if (c.type === 'currency') row.getCell(c.key).numFmt = USD_NUM_FMT;
    if (c.type === 'percent')  row.getCell(c.key).numFmt = '0.0"%"';
  }
  return row;
}

// Section subheader inside a sheet (below the title, above a data
// block). Bigger + brand-tinted so it separates two tables on the
// same sheet without needing a second worksheet.
function xlsxSubsection(ws, text) {
  ws.addRow([]);
  const r = ws.addRow([text]);
  r.font = { bold: true, size: 12, color: { argb: XLSX_TITLE_FG } };
  r.height = 20;
  return r;
}

router.get('/export', authMiddleware, async (req, res) => {
  try {
    const rangeFrom = (req.query.from && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)) ? req.query.from : null;
    const rangeTo   = (req.query.to   && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to))   ? req.query.to   : null;
    // Cross-page scope filters — mirror the /exec API so the workbook
    // matches exactly what the exec was looking at on screen.
    const filterArtist   = String(req.query.artist   || '').trim().slice(0, 120);
    const filterCategory = String(req.query.category || '').trim().slice(0, 120);
    const filterRep      = String(req.query.rep      || '').trim().slice(0, 120);
    const applyFilters = (params, alias = 'e') => {
      const p = alias ? `${alias}.` : '';
      const parts = [];
      if (filterArtist)   { params.push(filterArtist);   parts.push(`LOWER(TRIM(${p}artist)) = LOWER(TRIM($${params.length}))`); }
      if (filterCategory) { params.push(filterCategory); parts.push(`${p}category = $${params.length}`); }
      if (filterRep)      { params.push(filterRep);      parts.push(`${p}boom_rep = $${params.length}`); }
      return parts.length ? ' AND ' + parts.join(' AND ') : '';
    };
    const filterSummary = [];
    if (filterArtist)   filterSummary.push(`Artist = ${filterArtist}`);
    if (filterCategory) filterSummary.push(`Category = ${filterCategory}`);
    if (filterRep)      filterSummary.push(`Rep = ${filterRep}`);
    const filterLine = filterSummary.length ? filterSummary.join('  ·  ') : 'All artists · All categories · All reps';

    // Simple all-time KPIs (this-week / MTD / YTD / unpaid). Not
    // day-matched — the workbook is a snapshot artifact where the
    // subtlety of "same-day last month" is more confusing than useful.
    const now = new Date();
    const laToday = new Date(now.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }));
    const iso = (d) => d.toISOString().slice(0, 10);
    const startOfWeekMon = (d) => {
      const c = new Date(d);
      const day = c.getDay();
      c.setDate(c.getDate() + (day === 0 ? -6 : 1 - day));
      return c;
    };
    const wkStart = startOfWeekMon(laToday);
    const mtdStart = new Date(laToday.getFullYear(), laToday.getMonth(), 1);
    const ytdStart = new Date(laToday.getFullYear(), 0, 1);

    const params = [];
    const pushParam = (v) => { params.push(v); return `$${params.length}`; };

    // KPI + unpaid pipeline in one shot.
    const kpiFilterClause = applyFilters(params, '');
    const kpiRes = await pool.query(`
      WITH paid AS (
        SELECT
          COALESCE(SUM(CASE WHEN payment_date BETWEEN ${pushParam(iso(wkStart))} AND ${pushParam(iso(laToday))} THEN amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS this_week,
          COALESCE(SUM(CASE WHEN payment_date BETWEEN ${pushParam(iso(mtdStart))} AND ${pushParam(iso(laToday))} THEN amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS mtd,
          COALESCE(SUM(CASE WHEN payment_date BETWEEN ${pushParam(iso(ytdStart))} AND ${pushParam(iso(laToday))} THEN amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS ytd
        FROM expenses
        WHERE status = 'approved'
          AND (deleted IS NULL OR deleted = FALSE)
          AND (voided  IS NULL OR voided  = FALSE)
          AND parent_id IS NULL
          AND payment_status = 'Paid'
          AND payment_date IS NOT NULL
          ${kpiFilterClause}
      ),
      unpaid AS (
        SELECT
          COALESCE(SUM(amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1)), 0)::float AS unpaid_total,
          COUNT(*)::int AS unpaid_count
        FROM expenses
        WHERE status = 'approved'
          AND (deleted IS NULL OR deleted = FALSE)
          AND (voided  IS NULL OR voided  = FALSE)
          AND parent_id IS NULL
          AND payment_status IS DISTINCT FROM 'Paid'
          ${kpiFilterClause}
      )
      SELECT * FROM paid, unpaid
    `, params);
    const kpi = kpiRes.rows[0] || {};

    // Weekly buckets — trailing 12 or range.
    const chartFrom = rangeFrom
      ? startOfWeekMon(new Date(rangeFrom + 'T00:00:00'))
      : (() => { const d = new Date(wkStart); d.setDate(d.getDate() - 77); return d; })();
    const chartTo = rangeTo ? startOfWeekMon(new Date(rangeTo + 'T00:00:00')) : wkStart;
    const weeksParams = [iso(chartFrom), iso(chartTo)];
    const weeksFilterClause = applyFilters(weeksParams, '');
    const weeksRes = await pool.query(`
      WITH weeks AS (
        SELECT gs::DATE AS week_start
          FROM generate_series($1::DATE, $2::DATE, INTERVAL '7 days') gs
      ),
      paid AS (
        SELECT DATE_TRUNC('week', payment_date)::DATE AS week_start,
               SUM(amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1)) AS paid_usd
        FROM expenses
        WHERE status = 'approved' AND (deleted IS NULL OR deleted = FALSE)
          AND (voided IS NULL OR voided = FALSE) AND parent_id IS NULL
          AND payment_status = 'Paid' AND payment_date IS NOT NULL
          ${weeksFilterClause}
        GROUP BY 1
      ),
      unpaid AS (
        SELECT DATE_TRUNC('week', COALESCE(invoice_date, created_at::date))::DATE AS week_start,
               SUM(amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1)) AS unpaid_usd
        FROM expenses
        WHERE status = 'approved' AND (deleted IS NULL OR deleted = FALSE)
          AND (voided IS NULL OR voided = FALSE) AND parent_id IS NULL
          AND payment_status IS DISTINCT FROM 'Paid'
          ${weeksFilterClause}
        GROUP BY 1
      ),
      received AS (
        SELECT DATE_TRUNC('week', (created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::DATE AS week_start,
               SUM(amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1)) AS received_usd,
               COUNT(*)::int AS received_count
        FROM expenses
        WHERE status = 'approved' AND (deleted IS NULL OR deleted = FALSE)
          AND (voided IS NULL OR voided = FALSE) AND parent_id IS NULL
          ${weeksFilterClause}
        GROUP BY 1
      )
      SELECT TO_CHAR(w.week_start, 'YYYY-MM-DD') AS week_start,
             COALESCE(p.paid_usd, 0)::float AS paid_usd,
             COALESCE(u.unpaid_usd, 0)::float AS unpaid_usd,
             COALESCE(r.received_usd, 0)::float AS received_usd,
             COALESCE(r.received_count, 0)::int AS received_count
      FROM weeks w
      LEFT JOIN paid p USING (week_start)
      LEFT JOIN unpaid u USING (week_start)
      LEFT JOIN received r USING (week_start)
      ORDER BY w.week_start ASC
    `, weeksParams);

    // Range filter shared by breakdowns + monthly + category trend.
    // Scope filters piggyback on the same params array so both share
    // one set of $N placeholders.
    const rangeParams = [];
    const rangeWhere = [];
    if (rangeFrom) { rangeParams.push(rangeFrom); rangeWhere.push(`COALESCE(payment_date, invoice_date, created_at::date) >= $${rangeParams.length}::date`); }
    if (rangeTo)   { rangeParams.push(rangeTo);   rangeWhere.push(`COALESCE(payment_date, invoice_date, created_at::date) <= $${rangeParams.length}::date`); }
    const rangeScopeClause = applyFilters(rangeParams, '');
    const rangeClause = (rangeWhere.length ? 'AND ' + rangeWhere.join(' AND ') : '') + rangeScopeClause;

    const breakdownRes = async (col) => {
      const groupExpr = col === 'category'
        ? "COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized')"
        : `COALESCE(NULLIF(TRIM(LOWER(${col})), ''), 'unassigned')`;
      const labelExpr = col === 'category' ? groupExpr : `MAX(${col})`;
      return pool.query(`
        SELECT ${labelExpr} AS label,
               COALESCE(SUM(CASE WHEN payment_status = 'Paid' THEN amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS paid_usd,
               COALESCE(SUM(CASE WHEN payment_status IS DISTINCT FROM 'Paid' THEN amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS unpaid_usd,
               COUNT(*)::int AS row_count
        FROM expenses
        WHERE status = 'approved' AND (deleted IS NULL OR deleted = FALSE)
          AND (voided IS NULL OR voided = FALSE) AND parent_id IS NULL
          ${rangeClause}
        GROUP BY ${groupExpr}
        ORDER BY paid_usd DESC
        LIMIT 100
      `, rangeParams);
    };
    const [artistsRes, songsRes, categoriesRes] = await Promise.all([
      breakdownRes('artist'), breakdownRes('song'), breakdownRes('category'),
    ]);

    // Recoupment: same query as /exec but no LIMIT. Filter clause
    // uses its own params array — no other query in this endpoint
    // uses it.
    const recoupParams = [];
    const recoupFilterClause = applyFilters(recoupParams, '');
    const recoupRes = await pool.query(`
      WITH spend AS (
        SELECT COALESCE(NULLIF(TRIM(LOWER(artist)), ''), 'unassigned') AS artist_key,
               MAX(artist) AS artist,
               COALESCE(SUM(amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1)), 0)::float AS spend_usd
        FROM expenses
        WHERE status = 'approved' AND (deleted IS NULL OR deleted = FALSE)
          AND (voided IS NULL OR voided = FALSE) AND parent_id IS NULL AND recoupable = TRUE
          ${recoupFilterClause}
        GROUP BY artist_key
      ),
      income AS (
        SELECT COALESCE(NULLIF(TRIM(LOWER(a.name)), ''), 'unassigned') AS artist_key,
               COALESCE(SUM(ai.amount), 0)::float AS income_usd
        FROM artist_income ai LEFT JOIN artists a ON a.id = ai.artist_id
        GROUP BY artist_key
      )
      SELECT COALESCE(s.artist, INITCAP(s.artist_key)) AS artist,
             s.spend_usd, COALESCE(i.income_usd, 0)::float AS income_usd,
             (s.spend_usd - COALESCE(i.income_usd, 0))::float AS unrecouped_usd,
             CASE WHEN s.spend_usd > 0
                  THEN LEAST(100::float, (COALESCE(i.income_usd, 0) / s.spend_usd) * 100)
                  ELSE 0::float END AS pct_recouped
      FROM spend s LEFT JOIN income i USING (artist_key)
      WHERE s.spend_usd > 0
      ORDER BY unrecouped_usd DESC
    `, recoupParams);

    // Monthly rollup — one row per month, all totals paid + unpaid + total.
    const monthlyRes = await pool.query(`
      SELECT TO_CHAR(DATE_TRUNC('month', COALESCE(payment_date, invoice_date, created_at::date)), 'YYYY-MM') AS month,
             COALESCE(SUM(CASE WHEN payment_status = 'Paid' THEN amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS paid_usd,
             COALESCE(SUM(CASE WHEN payment_status IS DISTINCT FROM 'Paid' THEN amount / COALESCE(NULLIF(fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS unpaid_usd,
             COUNT(*)::int AS count
      FROM expenses
      WHERE status = 'approved' AND (deleted IS NULL OR deleted = FALSE)
        AND (voided IS NULL OR voided = FALSE) AND parent_id IS NULL
        ${rangeClause}
      GROUP BY month
      ORDER BY month DESC
    `, rangeParams);

    // Aging + upcoming + forecast + vendors + velocity + methods + reps
    // + category trend cross-tab + ledger detail — the additional data
    // the exec dashboard shows that the old export omitted. Each block
    // uses its own params array so numbering stays local to the query.
    const DUE_DATE_EXPR = `
      (COALESCE(e.invoice_date, e.created_at::date) +
        (CASE
          WHEN e.payment_terms ~* '^due\\s*on\\s*receipt' THEN 0
          WHEN e.payment_terms ~* '^net\\s*\\d+'
            THEN (substring(e.payment_terms from '\\d+'))::int
          ELSE 30
        END) * INTERVAL '1 day')::date
    `;

    const agingParams = [iso(laToday)];
    const agingFilterClause = applyFilters(agingParams, 'e');
    const agingRes = await pool.query(`
      WITH unpaid AS (
        SELECT ${DUE_DATE_EXPR} AS due_date,
               e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1) AS usd
        FROM expenses e
        WHERE e.status = 'approved' AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided IS NULL OR e.voided = FALSE) AND e.parent_id IS NULL
          AND e.payment_status IS DISTINCT FROM 'Paid'
          ${agingFilterClause}
      )
      SELECT
        CASE
          WHEN due_date IS NULL OR due_date >= $1::date THEN 'not_yet_due'
          WHEN ($1::date - due_date) <= 30 THEN '0-30'
          WHEN ($1::date - due_date) <= 60 THEN '30-60'
          WHEN ($1::date - due_date) <= 90 THEN '60-90'
          ELSE '90+'
        END AS bucket,
        COUNT(*)::int AS count,
        COALESCE(SUM(usd), 0)::float AS usd
      FROM unpaid
      GROUP BY bucket
    `, agingParams);
    const agingBuckets = { '0-30': { count: 0, usd: 0 }, '30-60': { count: 0, usd: 0 }, '60-90': { count: 0, usd: 0 }, '90+': { count: 0, usd: 0 }, not_yet_due: { count: 0, usd: 0 } };
    for (const r of agingRes.rows) agingBuckets[r.bucket] = { count: r.count, usd: Number(r.usd) };

    const upcomingParams = [iso(laToday)];
    const upcomingFilterClause = applyFilters(upcomingParams, 'e');
    const upcomingRes = await pool.query(`
      WITH unpaid AS (
        SELECT ${DUE_DATE_EXPR} AS due_date,
               e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1) AS usd
        FROM expenses e
        WHERE e.status = 'approved' AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided IS NULL OR e.voided = FALSE) AND e.parent_id IS NULL
          AND e.payment_status IS DISTINCT FROM 'Paid'
          ${upcomingFilterClause}
      )
      SELECT
        SUM(CASE WHEN due_date BETWEEN $1::date AND ($1::date + 7)  THEN 1 ELSE 0 END)::int AS in_7_count,
        COALESCE(SUM(CASE WHEN due_date BETWEEN $1::date AND ($1::date + 7)  THEN usd ELSE 0 END), 0)::float AS in_7_usd,
        SUM(CASE WHEN due_date BETWEEN $1::date AND ($1::date + 30) THEN 1 ELSE 0 END)::int AS in_30_count,
        COALESCE(SUM(CASE WHEN due_date BETWEEN $1::date AND ($1::date + 30) THEN usd ELSE 0 END), 0)::float AS in_30_usd,
        SUM(CASE WHEN due_date BETWEEN $1::date AND ($1::date + 60) THEN 1 ELSE 0 END)::int AS in_60_count,
        COALESCE(SUM(CASE WHEN due_date BETWEEN $1::date AND ($1::date + 60) THEN usd ELSE 0 END), 0)::float AS in_60_usd
      FROM unpaid
    `, upcomingParams);
    const upcoming = upcomingRes.rows[0] || {};

    const forecastParams = [iso(laToday)];
    const forecastFilterClause = applyFilters(forecastParams, 'e');
    const forecastRes = await pool.query(`
      WITH unpaid_due AS (
        SELECT ${DUE_DATE_EXPR} AS due_date,
               e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1) AS usd
        FROM expenses e
        WHERE e.status = 'approved' AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided IS NULL OR e.voided = FALSE) AND e.parent_id IS NULL
          AND e.payment_status IS DISTINCT FROM 'Paid'
          ${forecastFilterClause}
      ),
      recent_intake AS (
        SELECT COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1)), 0)::float / 4.0 AS weekly_avg_usd
        FROM expenses e
        WHERE e.status = 'approved' AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided IS NULL OR e.voided = FALSE) AND e.parent_id IS NULL
          AND e.created_at >= (NOW() - INTERVAL '28 days')
          ${forecastFilterClause}
      )
      SELECT
        (SELECT COALESCE(SUM(usd), 0)::float FROM unpaid_due WHERE due_date <= $1::date + 30) AS committed_30,
        (SELECT COALESCE(SUM(usd), 0)::float FROM unpaid_due WHERE due_date <= $1::date + 60) AS committed_60,
        (SELECT COALESCE(SUM(usd), 0)::float FROM unpaid_due WHERE due_date <= $1::date + 90) AS committed_90,
        ((SELECT weekly_avg_usd FROM recent_intake) * (30.0 / 7.0))::float AS projected_30,
        ((SELECT weekly_avg_usd FROM recent_intake) * (60.0 / 7.0))::float AS projected_60,
        ((SELECT weekly_avg_usd FROM recent_intake) * (90.0 / 7.0))::float AS projected_90,
        (SELECT weekly_avg_usd FROM recent_intake)::float AS weekly_avg_usd
    `, forecastParams);
    const fc = forecastRes.rows[0] || {};

    // Vendor concentration — full ranking so the Excel export lists
    // top 30 (dashboard is capped at 12). Include payee + all key
    // slices so the sheet stands alone without cross-referencing.
    const vendorParams = [];
    const vendorRangeClauses = [];
    if (rangeFrom) { vendorParams.push(rangeFrom); vendorRangeClauses.push(`COALESCE(e.payment_date, e.invoice_date, e.created_at::date) >= $${vendorParams.length}`); }
    if (rangeTo)   { vendorParams.push(rangeTo);   vendorRangeClauses.push(`COALESCE(e.payment_date, e.invoice_date, e.created_at::date) <= $${vendorParams.length}`); }
    const vendorFilterClause = applyFilters(vendorParams, 'e');
    const vendorScopeSql = (vendorRangeClauses.length ? 'AND ' + vendorRangeClauses.join(' AND ') : '') + vendorFilterClause;
    const vendorsRes = await pool.query(`
      SELECT
        COALESCE(NULLIF(TRIM(e.payee), ''), 'Unknown') AS payee,
        COALESCE(SUM(CASE WHEN e.payment_status = 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS paid_usd,
        COALESCE(SUM(CASE WHEN e.payment_status IS DISTINCT FROM 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS unpaid_usd,
        COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1)), 0)::float AS total_usd,
        COUNT(*)::int AS invoice_count
      FROM expenses e
      WHERE e.status = 'approved' AND (e.deleted IS NULL OR e.deleted = FALSE)
        AND (e.voided IS NULL OR e.voided = FALSE) AND e.parent_id IS NULL
        ${vendorScopeSql}
      GROUP BY COALESCE(NULLIF(TRIM(e.payee), ''), 'Unknown')
      HAVING COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1)), 0) > 0
      ORDER BY total_usd DESC
      LIMIT 30
    `, vendorParams);
    const vendorTotalRes = await pool.query(`
      SELECT COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1)), 0)::float AS grand_total
      FROM expenses e
      WHERE e.status = 'approved' AND (e.deleted IS NULL OR e.deleted = FALSE)
        AND (e.voided IS NULL OR e.voided = FALSE) AND e.parent_id IS NULL
        ${vendorScopeSql}
    `, vendorParams);
    const vendorGrandTotal = Number(vendorTotalRes.rows[0]?.grand_total) || 0;

    // Payment velocity histogram + stats.
    const velocityRes = await pool.query(`
      WITH paid AS (
        SELECT (e.payment_date - COALESCE(e.invoice_date, e.created_at::date))::int AS days_to_pay,
               e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1) AS usd
        FROM expenses e
        WHERE e.status = 'approved' AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided IS NULL OR e.voided = FALSE) AND e.parent_id IS NULL
          AND e.payment_status = 'Paid' AND e.payment_date IS NOT NULL
          ${vendorScopeSql}
      )
      SELECT
        CASE
          WHEN days_to_pay <= 0  THEN '0'
          WHEN days_to_pay <= 7  THEN '1-7'
          WHEN days_to_pay <= 14 THEN '8-14'
          WHEN days_to_pay <= 30 THEN '15-30'
          WHEN days_to_pay <= 60 THEN '31-60'
          ELSE '60+'
        END AS bucket,
        COUNT(*)::int AS count,
        COALESCE(SUM(usd), 0)::float AS usd
      FROM paid
      GROUP BY bucket
    `, vendorParams);
    const VEL_ORDER = ['0', '1-7', '8-14', '15-30', '31-60', '60+'];
    const velocityMap = new Map(velocityRes.rows.map(r => [r.bucket, r]));
    const velocityRows = VEL_ORDER.map(b => ({
      bucket: b,
      count: Number(velocityMap.get(b)?.count) || 0,
      usd: Number(velocityMap.get(b)?.usd) || 0,
    }));
    const velocityStatsRes = await pool.query(`
      SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY (e.payment_date - COALESCE(e.invoice_date, e.created_at::date))::int)::float AS median_days,
        AVG((e.payment_date - COALESCE(e.invoice_date, e.created_at::date))::int)::float AS mean_days,
        COUNT(*)::int AS paid_count
      FROM expenses e
      WHERE e.status = 'approved' AND (e.deleted IS NULL OR e.deleted = FALSE)
        AND (e.voided IS NULL OR e.voided = FALSE) AND e.parent_id IS NULL
        AND e.payment_status = 'Paid' AND e.payment_date IS NOT NULL
        ${vendorScopeSql}
    `, vendorParams);
    const velocityStats = velocityStatsRes.rows[0] || {};

    // Payment method mix.
    const methodsRes = await pool.query(`
      SELECT
        COALESCE(NULLIF(TRIM(e.payment_method), ''), 'Not set') AS method,
        COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1)), 0)::float AS usd,
        COUNT(*)::int AS count
      FROM expenses e
      WHERE e.status = 'approved' AND (e.deleted IS NULL OR e.deleted = FALSE)
        AND (e.voided IS NULL OR e.voided = FALSE) AND e.parent_id IS NULL
        AND e.payment_status = 'Paid'
        ${vendorScopeSql}
      GROUP BY COALESCE(NULLIF(TRIM(e.payment_method), ''), 'Not set')
      HAVING COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1)), 0) > 0
      ORDER BY usd DESC
    `, vendorParams);
    const methodsTotal = methodsRes.rows.reduce((s, m) => s + Number(m.usd), 0) || 0;

    // Rep leaderboard.
    const repsRes = await pool.query(`
      SELECT
        COALESCE(NULLIF(TRIM(e.boom_rep), ''), 'Not assigned') AS rep,
        COALESCE(SUM(CASE WHEN e.payment_status = 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS paid_usd,
        COALESCE(SUM(CASE WHEN e.payment_status IS DISTINCT FROM 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1) ELSE 0 END), 0)::float AS unpaid_usd,
        COUNT(*)::int AS invoice_count
      FROM expenses e
      WHERE e.status = 'approved' AND (e.deleted IS NULL OR e.deleted = FALSE)
        AND (e.voided IS NULL OR e.voided = FALSE) AND e.parent_id IS NULL
        ${vendorScopeSql}
      GROUP BY COALESCE(NULLIF(TRIM(e.boom_rep), ''), 'Not assigned')
      HAVING COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd,0), 1)), 0) > 0
      ORDER BY (paid_usd + unpaid_usd) DESC
    `, vendorParams);

    // Category trend cross-tab — month × category matrix.
    const catTrendRes = await pool.query(`
      SELECT TO_CHAR(DATE_TRUNC('month', COALESCE(payment_date, invoice_date, created_at::date)), 'YYYY-MM') AS month,
             COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized') AS category,
             COALESCE(SUM(amount / COALESCE(NULLIF(fx_rate_to_usd, 0), 1)), 0)::float AS usd
      FROM expenses
      WHERE status = 'approved' AND (deleted IS NULL OR deleted = FALSE)
        AND (voided IS NULL OR voided = FALSE) AND parent_id IS NULL
        ${rangeClause}
      GROUP BY month, category
      ORDER BY month ASC
    `, rangeParams);
    // Roll into { month → { category → usd } }
    const catByMonth = new Map();
    const catTotals = new Map();
    for (const r of catTrendRes.rows) {
      if (!catByMonth.has(r.month)) catByMonth.set(r.month, {});
      catByMonth.get(r.month)[r.category] = Number(r.usd);
      catTotals.set(r.category, (catTotals.get(r.category) || 0) + Number(r.usd));
    }
    const sortedCats = Array.from(catTotals.entries()).sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const sortedMonths = Array.from(catByMonth.keys()).sort();

    // Full ledger detail — every approved, non-child expense in the
    // range. Cap at 5,000 rows so a runaway all-time export doesn't
    // build a 50MB workbook; log a warning row when we hit the cap
    // so the reader knows to narrow the range.
    const ledgerParams = [];
    const ledgerWhere = [];
    if (rangeFrom) { ledgerParams.push(rangeFrom); ledgerWhere.push(`COALESCE(e.payment_date, e.invoice_date, e.created_at::date) >= $${ledgerParams.length}::date`); }
    if (rangeTo)   { ledgerParams.push(rangeTo);   ledgerWhere.push(`COALESCE(e.payment_date, e.invoice_date, e.created_at::date) <= $${ledgerParams.length}::date`); }
    const ledgerFilterClause = applyFilters(ledgerParams, 'e');
    const ledgerRes = await pool.query(`
      SELECT
        e.id,
        TO_CHAR(e.invoice_date, 'YYYY-MM-DD') AS invoice_date,
        e.invoice_number, e.payee, e.artist, e.song, e.category, e.boom_rep,
        e.currency, e.amount,
        (e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1))::float AS amount_usd,
        e.payment_status,
        TO_CHAR(e.payment_date, 'YYYY-MM-DD') AS payment_date,
        e.payment_method, e.payment_terms, e.description
      FROM expenses e
      WHERE e.status = 'approved' AND (e.deleted IS NULL OR e.deleted = FALSE)
        AND (e.voided IS NULL OR e.voided = FALSE) AND e.parent_id IS NULL
        ${ledgerWhere.length ? 'AND ' + ledgerWhere.join(' AND ') : ''}
        ${ledgerFilterClause}
      ORDER BY COALESCE(e.payment_date, e.invoice_date, e.created_at::date) DESC, e.id DESC
      LIMIT 5000
    `, ledgerParams);
    const ledgerCapped = ledgerRes.rows.length === 5000;

    // Build the workbook.
    const wb = new ExcelJS.Workbook();
    wb.creator = 'market.st Dashboard';
    wb.created = new Date();
    const rangeLabel = rangeFrom && rangeTo ? `${rangeFrom} → ${rangeTo}` : 'All time';
    const subtitle = `Generated ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}  ·  Range: ${rangeLabel}  ·  Scope: ${filterLine}`;

    // Sheet 1: Cover — headline numbers + TOC. First thing a board
    // member sees when they open the file.
    {
      const ws = wb.addWorksheet('Cover', { views: [{ showGridLines: false }] });
      ws.columns = [
        { key: 'a', width: 4 }, { key: 'b', width: 30 }, { key: 'c', width: 22 }, { key: 'd', width: 42 },
      ];
      // Title
      const t = ws.addRow(['', 'market.st — Financials']);
      t.height = 36; t.font = { bold: true, size: 22, color: { argb: XLSX_TITLE_FG } };
      ws.mergeCells('B1:D1');
      const s = ws.addRow(['', subtitle]);
      s.font = { size: 10, color: { argb: XLSX_SUBTLE } };
      ws.mergeCells('B2:D2');
      ws.addRow([]);

      // Headline snapshot — six big metrics in a 2×3 grid. Format each
      // as [label] + [value] so an exec skimming the file has the
      // whole story on page 1.
      const overdueCount = (agingBuckets['0-30'].count) + (agingBuckets['30-60'].count) + (agingBuckets['60-90'].count) + (agingBuckets['90+'].count);
      const overdueUsd   = (agingBuckets['0-30'].usd)   + (agingBuckets['30-60'].usd)   + (agingBuckets['60-90'].usd)   + (agingBuckets['90+'].usd);
      const forecast30   = (Number(fc.committed_30) || 0) + (Number(fc.projected_30) || 0);
      const headline = [
        ['This Week (paid)',   Number(kpi.this_week)   || 0, 'Paid Mon → today, LA week'],
        ['Month-to-Date',      Number(kpi.mtd)         || 0, 'Paid in the current month'],
        ['Year-to-Date',       Number(kpi.ytd)         || 0, 'Paid in the current year'],
        ['Unpaid Pipeline',    Number(kpi.unpaid_total)|| 0, `${kpi.unpaid_count || 0} invoice(s) outstanding`],
        ['Past due',           overdueUsd,                    `${overdueCount} overdue invoice(s)`],
        ['30-day cash forecast', forecast30,                  'Committed + projected new invoicing'],
      ];
      const hdrRow = ws.addRow(['', 'Headline', 'USD', 'Context']);
      hdrRow.height = 22;
      hdrRow.eachCell((cell, colNumber) => {
        if (colNumber >= 2) {
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_HEADER_BG } };
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          cell.border = { top: XLSX_ACCENT_LINE, bottom: XLSX_ACCENT_LINE, left: XLSX_THIN_BORDER, right: XLSX_THIN_BORDER };
        }
      });
      headline.forEach(([label, value, note], i) => {
        const banded = i % 2 === 1;
        const r = ws.addRow(['', label, value, note]);
        r.height = 22;
        r.eachCell((cell, colNumber) => {
          if (colNumber < 2) return;
          if (banded) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_ROW_BAND } };
          cell.border = { top: XLSX_THIN_BORDER, bottom: XLSX_THIN_BORDER, left: XLSX_THIN_BORDER, right: XLSX_THIN_BORDER };
          if (colNumber === 3) {
            cell.numFmt = USD_NUM_FMT;
            cell.font = { bold: true, size: 12 };
            cell.alignment = { horizontal: 'right', vertical: 'middle' };
          } else if (colNumber === 2) {
            cell.font = { bold: true, size: 11 };
            cell.alignment = { horizontal: 'left', vertical: 'middle' };
          } else {
            cell.font = { size: 10, color: { argb: XLSX_SUBTLE } };
            cell.alignment = { horizontal: 'left', vertical: 'middle' };
          }
        });
      });

      ws.addRow([]);
      const tocTitle = ws.addRow(['', 'Contents']);
      tocTitle.font = { bold: true, size: 13, color: { argb: XLSX_TITLE_FG } };
      tocTitle.height = 22;
      const tocEntries = [
        ['Overview',            'This-week / MTD / YTD / Unpaid, in one table'],
        ['Cash Forecast',       '30 / 60 / 90-day committed + projected'],
        ['Aging & Upcoming',    'Past-due buckets + near-term cash call'],
        ['Weekly',              'Trailing weekly paid / unpaid / received'],
        ['By Vendor',           'Top 30 payees + cumulative % of spend'],
        ['By Artist',           'Top artists by paid + unpaid'],
        ['By Song',             'Top songs'],
        ['By Category',         'Top categories'],
        ['By Rep',              'Which market.st rep authorized the spend'],
        ['Payment Velocity',    'Days-to-pay histogram + median / mean'],
        ['Payment Methods',     'USD by method + % of paid'],
        ['Recoupment',          'Per-artist spend vs income'],
        ['Monthly',             'One row per month, paid / unpaid'],
        ['Category Trend',      'Month × category cross-tab'],
        ['Full Ledger',         'Every approved invoice in the range'],
      ];
      tocEntries.forEach(([sheet, desc], i) => {
        const banded = i % 2 === 1;
        const r = ws.addRow(['', sheet, '', desc]);
        r.eachCell((cell, colNumber) => {
          if (colNumber < 2) return;
          if (banded) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_ROW_BAND } };
          cell.border = { top: XLSX_THIN_BORDER, bottom: XLSX_THIN_BORDER, left: XLSX_THIN_BORDER, right: XLSX_THIN_BORDER };
        });
        const nameCell = r.getCell(2);
        // Hyperlink into the sheet. ExcelJS syntax uses the "workbook"
        // hyperlink form so it stays valid regardless of sheet order.
        nameCell.value = { text: sheet, hyperlink: `#'${sheet}'!A1` };
        nameCell.font = { color: { argb: 'FF1D4ED8' }, underline: true, bold: true, size: 11 };
        nameCell.alignment = { horizontal: 'left', vertical: 'middle' };
        const descCell = r.getCell(4);
        descCell.font = { size: 10, color: { argb: XLSX_SUBTLE } };
        descCell.alignment = { horizontal: 'left', vertical: 'middle' };
      });
      ws.views = [{ showGridLines: false }];
    }

    // Sheet 2: Overview (KPI table with more depth than the Cover)
    {
      const ws = wb.addWorksheet('Overview', { views: [{ showGridLines: false }] });
      const columns = [
        { key: 'metric', header: 'Metric',   width: 32 },
        { key: 'value',  header: 'USD',      width: 20, type: 'currency' },
        { key: 'note',   header: 'Note',     width: 48 },
      ];
      ws.columns = columns.map(c => ({ key: c.key, width: c.width }));
      const lastCol = ws.getColumn(columns.length).letter;
      xlsxTitle(ws, 'Overview', subtitle, lastCol);
      xlsxHeader(ws, columns);
      ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];
      const overdueCount = (agingBuckets['0-30'].count) + (agingBuckets['30-60'].count) + (agingBuckets['60-90'].count) + (agingBuckets['90+'].count);
      const overdueUsd   = (agingBuckets['0-30'].usd)   + (agingBuckets['30-60'].usd)   + (agingBuckets['60-90'].usd)   + (agingBuckets['90+'].usd);
      const rows = [
        { metric: 'This Week (paid)',      value: Number(kpi.this_week)    || 0, note: 'Paid Mon-today, LA week' },
        { metric: 'Month-to-Date (paid)',  value: Number(kpi.mtd)          || 0, note: 'Paid so far this month' },
        { metric: 'Year-to-Date (paid)',   value: Number(kpi.ytd)          || 0, note: 'Paid so far this year' },
        { metric: 'Unpaid Pipeline',       value: Number(kpi.unpaid_total) || 0, note: `${kpi.unpaid_count || 0} invoice(s) outstanding` },
        { metric: 'Past due (all buckets)', value: overdueUsd,                   note: `${overdueCount} invoice(s) past invoice-anchored due date` },
        { metric: 'Weekly avg intake (last 4 weeks)', value: Number(fc.weekly_avg_usd) || 0, note: 'Trailing 4-week new-invoicing rate' },
      ];
      rows.forEach((r, i) => xlsxDataRow(ws, columns, r, i));
    }

    // Sheet 3: Cash Forecast — 30 / 60 / 90 committed + projected + total
    {
      const ws = wb.addWorksheet('Cash Forecast', { views: [{ showGridLines: false }] });
      const columns = [
        { key: 'window',    header: 'Window',    width: 18 },
        { key: 'committed', header: 'Committed', width: 18, type: 'currency' },
        { key: 'projected', header: 'Projected', width: 18, type: 'currency' },
        { key: 'total',     header: 'Plan for',  width: 18, type: 'currency' },
        { key: 'note',      header: 'Note',      width: 40 },
      ];
      ws.columns = columns.map(c => ({ key: c.key, width: c.width }));
      const lastCol = ws.getColumn(columns.length).letter;
      xlsxTitle(ws, 'Cash forecast — committed + projected', subtitle, lastCol);
      xlsxHeader(ws, columns);
      ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];
      const rows = [
        { window: 'Next 30 days', committed: Number(fc.committed_30) || 0, projected: Number(fc.projected_30) || 0, total: (Number(fc.committed_30) || 0) + (Number(fc.projected_30) || 0), note: 'Near-term cash call' },
        { window: 'Next 60 days', committed: Number(fc.committed_60) || 0, projected: Number(fc.projected_60) || 0, total: (Number(fc.committed_60) || 0) + (Number(fc.projected_60) || 0), note: 'Mid-term outlook' },
        { window: 'Next 90 days', committed: Number(fc.committed_90) || 0, projected: Number(fc.projected_90) || 0, total: (Number(fc.committed_90) || 0) + (Number(fc.projected_90) || 0), note: 'Quarter-ahead planning' },
      ];
      rows.forEach((r, i) => xlsxDataRow(ws, columns, r, i));
      ws.addRow([]);
      const note = ws.addRow([`Committed = unpaid invoices already on the books whose invoice-anchored due date falls in the window. Projected = trailing 4-week new-invoicing rate (${(Number(fc.weekly_avg_usd) || 0).toFixed(0)} USD/week) extrapolated forward. Treat "Plan for" as a directional planning figure, not a promise.`]);
      note.font = { italic: true, size: 10, color: { argb: XLSX_SUBTLE } };
      note.alignment = { wrapText: true };
      ws.mergeCells(note.number, 1, note.number, columns.length);
    }

    // Sheet 4: Aging & Upcoming — two tables on one sheet
    {
      const ws = wb.addWorksheet('Aging & Upcoming', { views: [{ showGridLines: false }] });
      const columns = [
        { key: 'bucket', header: 'Bucket',    width: 22 },
        { key: 'count',  header: 'Invoices',  width: 12, type: 'number' },
        { key: 'usd',    header: 'USD',       width: 18, type: 'currency' },
        { key: 'share',  header: 'Share',     width: 12, type: 'percent' },
      ];
      ws.columns = columns.map(c => ({ key: c.key, width: c.width }));
      const lastCol = ws.getColumn(columns.length).letter;
      xlsxTitle(ws, 'Aging & upcoming due', subtitle, lastCol);
      xlsxHeader(ws, columns);
      ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];
      const agingRows = [
        { key: '0-30',  label: '0-30 days past due' },
        { key: '30-60', label: '30-60 days past due' },
        { key: '60-90', label: '60-90 days past due' },
        { key: '90+',   label: '90+ days past due (escalate)' },
      ];
      const overdueUsd = agingRows.reduce((s, r) => s + agingBuckets[r.key].usd, 0);
      const overdueCount = agingRows.reduce((s, r) => s + agingBuckets[r.key].count, 0);
      agingRows.forEach((b, i) => xlsxDataRow(ws, columns, {
        bucket: b.label,
        count: agingBuckets[b.key].count,
        usd: agingBuckets[b.key].usd,
        share: overdueUsd > 0 ? (agingBuckets[b.key].usd / overdueUsd) * 100 : 0,
      }, i));
      xlsxTotalRow(ws, columns, { bucket: 'Total past due', count: overdueCount, usd: overdueUsd, share: 100 });

      xlsxSubsection(ws, 'Upcoming due — near-term cash call');
      const upHdr = ws.addRow(columns.map(c => c.header));
      upHdr.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      upHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_HEADER_BG } };
      upHdr.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      upHdr.eachCell(cell => {
        cell.border = { top: XLSX_THIN_BORDER, bottom: XLSX_ACCENT_LINE, left: XLSX_THIN_BORDER, right: XLSX_THIN_BORDER };
      });
      const upcomingRows = [
        { bucket: 'Next 7 days',  count: upcoming.in_7_count  || 0, usd: Number(upcoming.in_7_usd)  || 0 },
        { bucket: 'Next 30 days', count: upcoming.in_30_count || 0, usd: Number(upcoming.in_30_usd) || 0 },
        { bucket: 'Next 60 days', count: upcoming.in_60_count || 0, usd: Number(upcoming.in_60_usd) || 0 },
      ];
      const upcomingUsd = upcomingRows.reduce((s, r) => s + r.usd, 0);
      upcomingRows.forEach((r, i) => xlsxDataRow(ws, columns, {
        ...r, share: upcomingUsd > 0 ? (r.usd / upcomingUsd) * 100 : 0,
      }, i));
    }

    // Sheet 5: Weekly (with total row)
    {
      const ws = wb.addWorksheet('Weekly', { views: [{ showGridLines: false }] });
      const columns = [
        { key: 'week',           header: 'Week starting', width: 16 },
        { key: 'paid_usd',       header: 'Paid (USD)',    width: 16, type: 'currency' },
        { key: 'unpaid_usd',     header: 'Unpaid (USD)',  width: 16, type: 'currency' },
        { key: 'received_usd',   header: 'Received (USD)',width: 16, type: 'currency' },
        { key: 'received_count', header: 'Received (#)',  width: 14, type: 'number' },
      ];
      ws.columns = columns.map(c => ({ key: c.key, width: c.width }));
      const lastCol = ws.getColumn(columns.length).letter;
      xlsxTitle(ws, 'Weekly spend & intake', subtitle, lastCol);
      xlsxHeader(ws, columns);
      ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];
      ws.autoFilter = `A4:${lastCol}4`;
      const tot = { paid: 0, unpaid: 0, received: 0, count: 0 };
      weeksRes.rows.forEach((w, i) => {
        tot.paid += Number(w.paid_usd) || 0;
        tot.unpaid += Number(w.unpaid_usd) || 0;
        tot.received += Number(w.received_usd) || 0;
        tot.count += Number(w.received_count) || 0;
        xlsxDataRow(ws, columns, {
          week: w.week_start, paid_usd: w.paid_usd, unpaid_usd: w.unpaid_usd,
          received_usd: w.received_usd, received_count: w.received_count,
        }, i);
      });
      xlsxTotalRow(ws, columns, { week: 'Total', paid_usd: tot.paid, unpaid_usd: tot.unpaid, received_usd: tot.received, received_count: tot.count });
    }

    // Sheet 6: By Vendor — Pareto (top 30 + cumulative %)
    {
      const ws = wb.addWorksheet('By Vendor', { views: [{ showGridLines: false }] });
      const columns = [
        { key: 'rank',       header: '#',            width: 6,  type: 'number' },
        { key: 'payee',      header: 'Vendor',       width: 34 },
        { key: 'paid_usd',   header: 'Paid (USD)',   width: 16, type: 'currency' },
        { key: 'unpaid_usd', header: 'Unpaid (USD)', width: 16, type: 'currency' },
        { key: 'total_usd',  header: 'Total (USD)',  width: 16, type: 'currency' },
        { key: 'cum_pct',    header: 'Cumulative %', width: 14, type: 'percent' },
        { key: 'count',      header: 'Invoices',     width: 10, type: 'number' },
      ];
      ws.columns = columns.map(c => ({ key: c.key, width: c.width }));
      const lastCol = ws.getColumn(columns.length).letter;
      xlsxTitle(ws, `Top vendors — ${vendorsRes.rows.length} of ${vendorGrandTotal > 0 ? 'many' : '0'} · cumulative % against range grand total`, subtitle, lastCol);
      xlsxHeader(ws, columns);
      ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];
      ws.autoFilter = `A4:${lastCol}4`;
      let running = 0;
      let paidTot = 0, unpaidTot = 0;
      vendorsRes.rows.forEach((v, i) => {
        running += Number(v.total_usd) || 0;
        paidTot += Number(v.paid_usd) || 0;
        unpaidTot += Number(v.unpaid_usd) || 0;
        xlsxDataRow(ws, columns, {
          rank: i + 1,
          payee: v.payee,
          paid_usd: Number(v.paid_usd) || 0,
          unpaid_usd: Number(v.unpaid_usd) || 0,
          total_usd: Number(v.total_usd) || 0,
          cum_pct: vendorGrandTotal > 0 ? (running / vendorGrandTotal) * 100 : 0,
          count: Number(v.invoice_count) || 0,
        }, i);
      });
      xlsxTotalRow(ws, columns, {
        rank: '', payee: `Top ${vendorsRes.rows.length} shown`,
        paid_usd: paidTot, unpaid_usd: unpaidTot, total_usd: paidTot + unpaidTot,
        cum_pct: vendorGrandTotal > 0 ? ((paidTot + unpaidTot) / vendorGrandTotal) * 100 : 0,
        count: vendorsRes.rows.reduce((s, v) => s + (Number(v.invoice_count) || 0), 0),
      });
    }

    // Sheet 2: Weekly
    {
      const ws = wb.addWorksheet('Weekly', { views: [{ showGridLines: false }] });
      const columns = [
        { key: 'week',           header: 'Week starting', width: 16 },
        { key: 'paid_usd',       header: 'Paid (USD)',    width: 16, type: 'currency' },
        { key: 'unpaid_usd',     header: 'Unpaid (USD)',  width: 16, type: 'currency' },
        { key: 'received_usd',   header: 'Received (USD)',width: 16, type: 'currency' },
        { key: 'received_count', header: 'Received (#)',  width: 14, type: 'number' },
      ];
      ws.columns = columns.map(c => ({ key: c.key, width: c.width }));
      const lastCol = ws.getColumn(columns.length).letter;
      xlsxTitle(ws, 'Weekly spend & intake', subtitle, lastCol);
      xlsxHeader(ws, columns);
      ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];
      ws.autoFilter = `A4:${lastCol}4`;
      weeksRes.rows.forEach((w, i) => xlsxDataRow(ws, columns, {
        week: w.week_start, paid_usd: w.paid_usd, unpaid_usd: w.unpaid_usd,
        received_usd: w.received_usd, received_count: w.received_count,
      }, i));
    }

    // Sheets 7-9: Breakdowns with totals row
    const buildBreakdownSheet = (name, dataset, labelHeader) => {
      const ws = wb.addWorksheet(name, { views: [{ showGridLines: false }] });
      const columns = [
        { key: 'label',      header: labelHeader,   width: 34 },
        { key: 'paid_usd',   header: 'Paid (USD)',  width: 16, type: 'currency' },
        { key: 'unpaid_usd', header: 'Unpaid (USD)',width: 16, type: 'currency' },
        { key: 'total_usd',  header: 'Total (USD)', width: 16, type: 'currency' },
        { key: 'row_count',  header: 'Invoices',    width: 12, type: 'number' },
      ];
      ws.columns = columns.map(c => ({ key: c.key, width: c.width }));
      const lastCol = ws.getColumn(columns.length).letter;
      xlsxTitle(ws, name, subtitle, lastCol);
      xlsxHeader(ws, columns);
      ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];
      ws.autoFilter = `A4:${lastCol}4`;
      let paidTot = 0, unpaidTot = 0, countTot = 0;
      dataset.rows.forEach((r, i) => {
        const paid = Number(r.paid_usd) || 0;
        const unpaid = Number(r.unpaid_usd) || 0;
        paidTot += paid; unpaidTot += unpaid; countTot += Number(r.row_count) || 0;
        xlsxDataRow(ws, columns, {
          label: r.label, paid_usd: paid, unpaid_usd: unpaid,
          total_usd: paid + unpaid, row_count: r.row_count,
        }, i);
      });
      xlsxTotalRow(ws, columns, {
        label: 'Total', paid_usd: paidTot, unpaid_usd: unpaidTot,
        total_usd: paidTot + unpaidTot, row_count: countTot,
      });
    };
    buildBreakdownSheet('By Artist',   artistsRes,    'Artist');
    buildBreakdownSheet('By Song',     songsRes,      'Song');
    buildBreakdownSheet('By Category', categoriesRes, 'Category');

    // Sheet 10: By Rep — accountability leaderboard
    {
      const ws = wb.addWorksheet('By Rep', { views: [{ showGridLines: false }] });
      const columns = [
        { key: 'rep',        header: 'market.st rep',     width: 26 },
        { key: 'paid_usd',   header: 'Paid (USD)',   width: 16, type: 'currency' },
        { key: 'unpaid_usd', header: 'Unpaid (USD)', width: 16, type: 'currency' },
        { key: 'total_usd',  header: 'Total (USD)',  width: 16, type: 'currency' },
        { key: 'count',      header: 'Invoices',     width: 12, type: 'number' },
      ];
      ws.columns = columns.map(c => ({ key: c.key, width: c.width }));
      const lastCol = ws.getColumn(columns.length).letter;
      xlsxTitle(ws, 'Spend by rep — who authorized the money', subtitle, lastCol);
      xlsxHeader(ws, columns);
      ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];
      ws.autoFilter = `A4:${lastCol}4`;
      let paidTot = 0, unpaidTot = 0, countTot = 0;
      repsRes.rows.forEach((r, i) => {
        const paid = Number(r.paid_usd) || 0;
        const unpaid = Number(r.unpaid_usd) || 0;
        paidTot += paid; unpaidTot += unpaid; countTot += Number(r.invoice_count) || 0;
        xlsxDataRow(ws, columns, {
          rep: r.rep, paid_usd: paid, unpaid_usd: unpaid,
          total_usd: paid + unpaid, count: r.invoice_count,
        }, i);
      });
      xlsxTotalRow(ws, columns, {
        rep: 'Total', paid_usd: paidTot, unpaid_usd: unpaidTot,
        total_usd: paidTot + unpaidTot, count: countTot,
      });
    }

    // Sheet 11: Payment Velocity — histogram + stats
    {
      const ws = wb.addWorksheet('Payment Velocity', { views: [{ showGridLines: false }] });
      const columns = [
        { key: 'bucket', header: 'Bucket',   width: 20 },
        { key: 'count',  header: 'Invoices', width: 12, type: 'number' },
        { key: 'usd',    header: 'USD',      width: 18, type: 'currency' },
        { key: 'share',  header: 'Share',    width: 12, type: 'percent' },
      ];
      ws.columns = columns.map(c => ({ key: c.key, width: c.width }));
      const lastCol = ws.getColumn(columns.length).letter;
      xlsxTitle(ws, `Payment velocity — median ${Number(velocityStats.median_days || 0).toFixed(0)}d · mean ${Number(velocityStats.mean_days || 0).toFixed(0)}d · ${velocityStats.paid_count || 0} paid invoices`, subtitle, lastCol);
      xlsxHeader(ws, columns);
      ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];
      const totalCount = velocityRows.reduce((s, r) => s + r.count, 0);
      const totalUsd   = velocityRows.reduce((s, r) => s + r.usd, 0);
      velocityRows.forEach((r, i) => xlsxDataRow(ws, columns, {
        bucket: r.bucket === '0' ? 'Same day' : (r.bucket === '60+' ? '60+ days' : `${r.bucket} days`),
        count: r.count,
        usd: r.usd,
        share: totalCount > 0 ? (r.count / totalCount) * 100 : 0,
      }, i));
      xlsxTotalRow(ws, columns, { bucket: 'Total', count: totalCount, usd: totalUsd, share: 100 });
    }

    // Sheet 12: Payment Methods — mix + %
    {
      const ws = wb.addWorksheet('Payment Methods', { views: [{ showGridLines: false }] });
      const columns = [
        { key: 'method', header: 'Method',   width: 22 },
        { key: 'usd',    header: 'USD',      width: 18, type: 'currency' },
        { key: 'share',  header: 'Share',    width: 12, type: 'percent' },
        { key: 'count',  header: 'Invoices', width: 12, type: 'number' },
      ];
      ws.columns = columns.map(c => ({ key: c.key, width: c.width }));
      const lastCol = ws.getColumn(columns.length).letter;
      xlsxTitle(ws, 'Payment method mix — where the paid dollars flow', subtitle, lastCol);
      xlsxHeader(ws, columns);
      ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];
      let totalUsd = 0, totalCount = 0;
      methodsRes.rows.forEach((m, i) => {
        totalUsd += Number(m.usd) || 0;
        totalCount += Number(m.count) || 0;
        xlsxDataRow(ws, columns, {
          method: m.method,
          usd: Number(m.usd) || 0,
          share: methodsTotal > 0 ? (Number(m.usd) / methodsTotal) * 100 : 0,
          count: m.count,
        }, i);
      });
      xlsxTotalRow(ws, columns, { method: 'Total', usd: totalUsd, share: 100, count: totalCount });
    }

    // Sheet 13: Recoupment
    {
      const ws = wb.addWorksheet('Recoupment', { views: [{ showGridLines: false }] });
      const columns = [
        { key: 'artist',        header: 'Artist',           width: 30 },
        { key: 'spend_usd',     header: 'Recoupable spend', width: 20, type: 'currency' },
        { key: 'income_usd',    header: 'Income',           width: 16, type: 'currency' },
        { key: 'unrecouped_usd',header: 'Unrecouped',       width: 16, type: 'currency' },
        { key: 'pct_recouped',  header: '% Recouped',       width: 14, type: 'percent' },
      ];
      ws.columns = columns.map(c => ({ key: c.key, width: c.width }));
      const lastCol = ws.getColumn(columns.length).letter;
      xlsxTitle(ws, 'Recoupment scoreboard', subtitle, lastCol);
      xlsxHeader(ws, columns);
      ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];
      ws.autoFilter = `A4:${lastCol}4`;
      let spendTot = 0, incomeTot = 0;
      recoupRes.rows.forEach((r, i) => {
        spendTot += Number(r.spend_usd) || 0;
        incomeTot += Number(r.income_usd) || 0;
        xlsxDataRow(ws, columns, {
          artist: r.artist,
          spend_usd: Number(r.spend_usd) || 0,
          income_usd: Number(r.income_usd) || 0,
          unrecouped_usd: Number(r.unrecouped_usd) || 0,
          pct_recouped: Number(r.pct_recouped) || 0,
        }, i);
      });
      xlsxTotalRow(ws, columns, {
        artist: 'Total', spend_usd: spendTot, income_usd: incomeTot,
        unrecouped_usd: spendTot - incomeTot,
        pct_recouped: spendTot > 0 ? Math.min(100, (incomeTot / spendTot) * 100) : 0,
      });
    }

    // Sheet 14: Monthly
    {
      const ws = wb.addWorksheet('Monthly', { views: [{ showGridLines: false }] });
      const columns = [
        { key: 'month',      header: 'Month',        width: 12 },
        { key: 'paid_usd',   header: 'Paid (USD)',   width: 16, type: 'currency' },
        { key: 'unpaid_usd', header: 'Unpaid (USD)', width: 16, type: 'currency' },
        { key: 'total_usd',  header: 'Total (USD)',  width: 16, type: 'currency' },
        { key: 'count',      header: 'Invoices',     width: 12, type: 'number' },
      ];
      ws.columns = columns.map(c => ({ key: c.key, width: c.width }));
      const lastCol = ws.getColumn(columns.length).letter;
      xlsxTitle(ws, 'Monthly rollup', subtitle, lastCol);
      xlsxHeader(ws, columns);
      ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];
      ws.autoFilter = `A4:${lastCol}4`;
      let paidTot = 0, unpaidTot = 0, countTot = 0;
      monthlyRes.rows.forEach((m, i) => {
        const paid = Number(m.paid_usd) || 0;
        const unpaid = Number(m.unpaid_usd) || 0;
        paidTot += paid; unpaidTot += unpaid; countTot += Number(m.count) || 0;
        xlsxDataRow(ws, columns, {
          month: m.month, paid_usd: paid, unpaid_usd: unpaid,
          total_usd: paid + unpaid, count: m.count,
        }, i);
      });
      xlsxTotalRow(ws, columns, {
        month: 'Total', paid_usd: paidTot, unpaid_usd: unpaidTot,
        total_usd: paidTot + unpaidTot, count: countTot,
      });
    }

    // Sheet 15: Category Trend — cross-tab of months × categories
    {
      const ws = wb.addWorksheet('Category Trend', { views: [{ showGridLines: false }] });
      const columns = [
        { key: 'month', header: 'Month', width: 12 },
        ...sortedCats.map((c) => ({ key: `cat_${c}`, header: c, width: Math.max(14, Math.min(24, c.length + 4)), type: 'currency' })),
        { key: 'total', header: 'Row total', width: 16, type: 'currency' },
      ];
      ws.columns = columns.map(c => ({ key: c.key, width: c.width }));
      const lastCol = ws.getColumn(columns.length).letter;
      xlsxTitle(ws, 'Category trend — monthly cross-tab', subtitle, lastCol);
      xlsxHeader(ws, columns);
      ws.views = [{ state: 'frozen', ySplit: 4, xSplit: 1, showGridLines: false }];
      ws.autoFilter = `A4:${lastCol}4`;
      const colTotals = new Array(sortedCats.length).fill(0);
      let grandTotal = 0;
      sortedMonths.forEach((month, i) => {
        const row = { month };
        let rowSum = 0;
        sortedCats.forEach((c, j) => {
          const v = catByMonth.get(month)[c] || 0;
          row[`cat_${c}`] = v;
          colTotals[j] += v;
          rowSum += v;
        });
        row.total = rowSum;
        grandTotal += rowSum;
        xlsxDataRow(ws, columns, row, i);
      });
      const totalRow = { month: 'Total' };
      sortedCats.forEach((c, j) => { totalRow[`cat_${c}`] = colTotals[j]; });
      totalRow.total = grandTotal;
      xlsxTotalRow(ws, columns, totalRow);
    }

    // Sheet 16: Full Ledger — raw invoice detail
    {
      const ws = wb.addWorksheet('Full Ledger', { views: [{ showGridLines: false }] });
      const columns = [
        { key: 'invoice_date',   header: 'Invoice date', width: 12,             type: 'date' },
        { key: 'invoice_number', header: 'Invoice #',    width: 14 },
        { key: 'payee',          header: 'Vendor',       width: 26 },
        { key: 'artist',         header: 'Artist',       width: 22 },
        { key: 'song',           header: 'Song',         width: 22 },
        { key: 'category',       header: 'Category',     width: 18 },
        { key: 'boom_rep',       header: 'Rep',          width: 14 },
        { key: 'currency',       header: 'Cur',          width: 6 },
        { key: 'amount',         header: 'Amount',       width: 14, type: 'currency' },
        { key: 'amount_usd',     header: 'USD',          width: 14, type: 'currency' },
        { key: 'payment_status', header: 'Status',       width: 10 },
        { key: 'payment_date',   header: 'Paid on',      width: 12,             type: 'date' },
        { key: 'payment_method', header: 'Method',       width: 12 },
        { key: 'payment_terms',  header: 'Terms',        width: 12 },
        { key: 'description',    header: 'Description',  width: 40, wrap: true },
      ];
      ws.columns = columns.map(c => ({ key: c.key, width: c.width }));
      const lastCol = ws.getColumn(columns.length).letter;
      const capNote = ledgerCapped ? ` · CAPPED AT 5,000 rows — narrow the date range to see the full list` : '';
      xlsxTitle(ws, `Full ledger — ${ledgerRes.rows.length} invoice(s)${capNote}`, subtitle, lastCol);
      xlsxHeader(ws, columns);
      ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];
      ws.autoFilter = `A4:${lastCol}4`;
      let usdTot = 0;
      ledgerRes.rows.forEach((r, i) => {
        usdTot += Number(r.amount_usd) || 0;
        xlsxDataRow(ws, columns, {
          invoice_date:   r.invoice_date   ? new Date(r.invoice_date + 'T00:00:00') : null,
          invoice_number: r.invoice_number || '',
          payee:          r.payee || '',
          artist:         r.artist || '',
          song:           r.song || '',
          category:       r.category || '',
          boom_rep:       r.boom_rep || '',
          currency:       r.currency || 'USD',
          amount:         Number(r.amount) || 0,
          amount_usd:     Number(r.amount_usd) || 0,
          payment_status: r.payment_status || 'Unpaid',
          payment_date:   r.payment_date   ? new Date(r.payment_date + 'T00:00:00') : null,
          payment_method: r.payment_method || '',
          payment_terms:  r.payment_terms  || '',
          description:    r.description    || '',
        }, i);
      });
      xlsxTotalRow(ws, columns, {
        invoice_date: '', invoice_number: '', payee: `Total (${ledgerRes.rows.length})`,
        artist: '', song: '', category: '', boom_rep: '', currency: '',
        amount: '', amount_usd: usdTot, payment_status: '', payment_date: '',
        payment_method: '', payment_terms: '', description: '',
      });
    }

    const buf = await wb.xlsx.writeBuffer();
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `marketst-financials-${stamp}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('GET /api/financials/export:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Month subpage ──────────────────────────────────────────────────────────
// GET /api/financials/month/:month   month = YYYY-MM
// Backs the /financials/month/:month drill-down. Returns everything an
// exec would want to know about one month at a glance: totals, per-
// artist + per-category breakdowns, top vendors, and the top invoices.
// Every dollar amount is USD-equivalent (fx_rate_to_usd when locked,
// native amount otherwise — same rule the /exec endpoint uses).
router.get('/month/:month', authMiddleware, async (req, res) => {
  const monthParam = String(req.params.month || '');
  if (!/^\d{4}-\d{2}$/.test(monthParam)) {
    return res.status(400).json({ success: false, error: 'month must be YYYY-MM' });
  }
  const [yStr, mStr] = monthParam.split('-');
  const year = parseInt(yStr, 10);
  const month = parseInt(mStr, 10);
  if (year < 1900 || year > 2999 || month < 1 || month > 12) {
    return res.status(400).json({ success: false, error: 'invalid year or month' });
  }
  // Start of month + start of next month for range filtering. Match on
  // COALESCE(payment_date, invoice_date, created_at::date) — the same
  // "when did this land" heuristic used elsewhere in the exec view.
  const start = new Date(year, month - 1, 1);
  const end   = new Date(year, month,     1);
  const iso = (d) => d.toISOString().slice(0, 10);
  // Prior-month window for delta chips on the stat cards. Uses
  // JS Date so the year rollover (Jan → Dec previous year) is
  // handled without special-casing.
  const prevStart = new Date(year, month - 2, 1);
  const prevEnd   = new Date(year, month - 1, 1);

  try {
    // Common WHERE fragment — parent-only, approved, not deleted /
    // voided, within the month bounds via the coalesced anchor date.
    const baseWhere = `
      e.status = 'approved'
        AND (e.deleted IS NULL OR e.deleted = FALSE)
        AND (e.voided  IS NULL OR e.voided  = FALSE)
        AND e.parent_id IS NULL
        AND COALESCE(e.payment_date, e.invoice_date, e.created_at::date) >= $1::date
        AND COALESCE(e.payment_date, e.invoice_date, e.created_at::date) <  $2::date
    `;
    const params = [iso(start), iso(end)];
    const prevParams = [iso(prevStart), iso(prevEnd)];

    const [summaryRes, artistsRes, categoriesRes, vendorsRes, invoicesRes, receivedRes, prevSummaryRes, prevReceivedRes, dailyRes] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1)), 0)::float AS total_usd,
          COALESCE(SUM(CASE WHEN e.payment_status = 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1) ELSE 0 END), 0)::float AS paid_usd,
          COALESCE(SUM(CASE WHEN e.payment_status IS DISTINCT FROM 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1) ELSE 0 END), 0)::float AS unpaid_usd,
          COUNT(*)::int AS total_count,
          SUM(CASE WHEN e.payment_status = 'Paid' THEN 1 ELSE 0 END)::int AS paid_count,
          SUM(CASE WHEN e.payment_status IS DISTINCT FROM 'Paid' THEN 1 ELSE 0 END)::int AS unpaid_count,
          COUNT(DISTINCT NULLIF(TRIM(LOWER(e.artist)), ''))::int AS artist_count,
          COUNT(DISTINCT NULLIF(TRIM(LOWER(e.payee)),  ''))::int AS vendor_count
        FROM expenses e
        WHERE ${baseWhere}
      `, params),
      pool.query(`
        SELECT
          MAX(e.artist) AS artist,
          COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1)), 0)::float AS total_usd,
          COALESCE(SUM(CASE WHEN e.payment_status = 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1) ELSE 0 END), 0)::float AS paid_usd,
          COALESCE(SUM(CASE WHEN e.payment_status IS DISTINCT FROM 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1) ELSE 0 END), 0)::float AS unpaid_usd,
          COUNT(*)::int AS count
        FROM expenses e
        WHERE ${baseWhere}
        GROUP BY COALESCE(NULLIF(TRIM(LOWER(e.artist)), ''), 'unassigned')
        ORDER BY total_usd DESC
      `, params),
      pool.query(`
        SELECT
          COALESCE(NULLIF(TRIM(e.category), ''), 'Uncategorized') AS category,
          COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1)), 0)::float AS total_usd,
          COALESCE(SUM(CASE WHEN e.payment_status = 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1) ELSE 0 END), 0)::float AS paid_usd,
          COALESCE(SUM(CASE WHEN e.payment_status IS DISTINCT FROM 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1) ELSE 0 END), 0)::float AS unpaid_usd,
          COUNT(*)::int AS count
        FROM expenses e
        WHERE ${baseWhere}
        GROUP BY COALESCE(NULLIF(TRIM(e.category), ''), 'Uncategorized')
        ORDER BY total_usd DESC
      `, params),
      pool.query(`
        SELECT
          MAX(e.payee) AS payee,
          COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1)), 0)::float AS total_usd,
          COUNT(*)::int AS count
        FROM expenses e
        WHERE ${baseWhere}
        GROUP BY COALESCE(NULLIF(TRIM(LOWER(e.payee)), ''), 'unknown')
        ORDER BY total_usd DESC
        LIMIT 15
      `, params),
      pool.query(`
        SELECT
          e.id,
          e.invoice_date, e.invoice_number, e.payee, e.artist, e.song,
          e.category, e.currency, e.amount,
          (e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1))::float AS amount_usd,
          e.payment_status, e.payment_date, e.boom_rep
        FROM expenses e
        WHERE ${baseWhere}
        ORDER BY (e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1)) DESC
        LIMIT 25
      `, params),
      pool.query(`
        SELECT
          COUNT(*)::int AS received_count,
          COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1)), 0)::float AS received_usd
        FROM expenses e
        WHERE e.status = 'approved'
          AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided  IS NULL OR e.voided  = FALSE)
          AND e.parent_id IS NULL
          AND (e.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles' >= $1::date
          AND (e.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles' <  $2::date
      `, params),
      // Prior-month summary — used for delta chips on the stat cards.
      // Same shape as the primary summary query, just against prev bounds.
      pool.query(`
        SELECT
          COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1)), 0)::float AS total_usd,
          COALESCE(SUM(CASE WHEN e.payment_status = 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1) ELSE 0 END), 0)::float AS paid_usd,
          COALESCE(SUM(CASE WHEN e.payment_status IS DISTINCT FROM 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1) ELSE 0 END), 0)::float AS unpaid_usd,
          COUNT(*)::int AS total_count
        FROM expenses e
        WHERE ${baseWhere}
      `, prevParams),
      pool.query(`
        SELECT
          COUNT(*)::int AS received_count,
          COALESCE(SUM(e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1)), 0)::float AS received_usd
        FROM expenses e
        WHERE e.status = 'approved'
          AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND (e.voided  IS NULL OR e.voided  = FALSE)
          AND e.parent_id IS NULL
          AND (e.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles' >= $1::date
          AND (e.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles' <  $2::date
      `, prevParams),
      // Daily rollup — one row per day of the month. Uses
      // generate_series so days with zero activity still emit a row,
      // giving the client chart a full month timeline instead of
      // a jagged x-axis.
      pool.query(`
        WITH days AS (
          SELECT gs::date AS day FROM generate_series($1::date, ($2::date - INTERVAL '1 day')::date, INTERVAL '1 day') gs
        ),
        activity AS (
          SELECT
            COALESCE(e.payment_date, e.invoice_date, e.created_at::date) AS day,
            COALESCE(SUM(CASE WHEN e.payment_status = 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1) ELSE 0 END), 0)::float AS paid_usd,
            COALESCE(SUM(CASE WHEN e.payment_status IS DISTINCT FROM 'Paid' THEN e.amount / COALESCE(NULLIF(e.fx_rate_to_usd, 0), 1) ELSE 0 END), 0)::float AS unpaid_usd,
            COUNT(*)::int AS count
          FROM expenses e
          WHERE ${baseWhere}
          GROUP BY 1
        )
        SELECT
          TO_CHAR(d.day, 'YYYY-MM-DD') AS day,
          EXTRACT(DAY FROM d.day)::int AS day_of_month,
          COALESCE(a.paid_usd, 0)::float   AS paid_usd,
          COALESCE(a.unpaid_usd, 0)::float AS unpaid_usd,
          COALESCE(a.count, 0)::int        AS count
        FROM days d LEFT JOIN activity a USING (day)
        ORDER BY d.day
      `, params),
    ]);

    const summary = summaryRes.rows[0] || {};
    const received = receivedRes.rows[0] || {};
    const prevSummary = prevSummaryRes.rows[0] || {};
    const prevReceived = prevReceivedRes.rows[0] || {};

    // Prev / next month strings for the client's month-hop arrows.
    // Handle year boundaries by delegating to JS Date.
    const prevD = new Date(year, month - 2, 1);
    const nextD = new Date(year, month,     1);
    const monthStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

    res.json({
      success: true,
      data: {
        month: monthParam,
        month_label: new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
        prev_month: monthStr(prevD),
        next_month: monthStr(nextD),
        prev_month_label: prevD.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
        next_month_label: nextD.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
        summary: {
          total_usd:    Number(summary.total_usd)    || 0,
          paid_usd:     Number(summary.paid_usd)     || 0,
          unpaid_usd:   Number(summary.unpaid_usd)   || 0,
          total_count:  Number(summary.total_count)  || 0,
          paid_count:   Number(summary.paid_count)   || 0,
          unpaid_count: Number(summary.unpaid_count) || 0,
          artist_count: Number(summary.artist_count) || 0,
          vendor_count: Number(summary.vendor_count) || 0,
          received_count: Number(received.received_count) || 0,
          received_usd:   Number(received.received_usd)   || 0,
          avg_invoice_usd: summary.total_count > 0
            ? (Number(summary.total_usd) || 0) / Number(summary.total_count)
            : 0,
        },
        prev_summary: {
          total_usd:    Number(prevSummary.total_usd)    || 0,
          paid_usd:     Number(prevSummary.paid_usd)     || 0,
          unpaid_usd:   Number(prevSummary.unpaid_usd)   || 0,
          total_count:  Number(prevSummary.total_count)  || 0,
          received_usd: Number(prevReceived.received_usd) || 0,
        },
        daily:      dailyRes.rows,
        artists:    artistsRes.rows,
        categories: categoriesRes.rows,
        vendors:    vendorsRes.rows,
        invoices:   invoicesRes.rows,
      },
    });
  } catch (err) {
    console.error(`GET /api/financials/month/${monthParam}:`, err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
