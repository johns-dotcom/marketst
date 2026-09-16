const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { uploadFile, deleteFile } = require('../lib/r2');
const { callClaude } = require('../services/claude');

const router = express.Router();

// All contract endpoints (read + write) are admin-only. Contract content is
// sensitive — financial terms, advances, recoupment language — and should not
// be visible to regular users. Approver / Admin / Superadmin all pass.
// Page-permission gate: admin/Superadmin/Approver always pass; other roles
// must have explicit page_permissions for at least one contract page.
// This replaces the prior hard role-only gate so admins can selectively
// grant contract access to specific Users via Settings → Permissions.
const { requirePagePermission } = require('../middleware/pagePermission');
router.use(authMiddleware, requirePagePermission(
  '/contracts', '/pending-contracts', '/renewals', '/contracts/create'
));

// ── Budget sync ───────────────────────────────────────────────────────────────
// After any contract save/update, recalculate the artist's budget from
// all their active contract obligations and upsert into artist_budgets.

async function syncArtistBudget(artistId) {
  try {
    const { rows } = await pool.query(
      `SELECT advance, financial_terms FROM contracts
       WHERE artist_id = $1 AND status NOT IN ('Expired', 'Terminated')`,
      [artistId]
    );

    let totalBudget = 0;
    let totalAdvance = 0;

    for (const c of rows) {
      // Advance tracked separately for recoupment
      const adv = parseFloat(c.advance || 0);
      if (!isNaN(adv) && adv > 0) totalAdvance += adv;

      // Sum all dollar-amount financial obligations
      const terms = Array.isArray(c.financial_terms) ? c.financial_terms : [];
      for (const term of terms) {
        if (term.amount == null) continue;
        const raw = String(term.amount).replace(/[$,]/g, '').trim();
        if (raw.includes('%')) continue;           // skip percentages
        const val = parseFloat(raw);
        if (!isNaN(val) && val > 0) totalBudget += val;
      }
    }

    // If no dollar obligations, fall back to advance as budget
    if (totalBudget === 0 && totalAdvance > 0) totalBudget = totalAdvance;

    if (totalBudget > 0 || totalAdvance > 0) {
      await pool.query(
        `INSERT INTO artist_budgets (artist_id, amount, advance)
         VALUES ($1, $2, $3)
         ON CONFLICT (artist_id) DO UPDATE SET
           amount  = EXCLUDED.amount,
           advance = EXCLUDED.advance,
           updated_at = NOW()`,
        [artistId, totalBudget, totalAdvance]
      );
    }
  } catch (err) {
    // Non-fatal — log but don't break the contract save
    console.error('syncArtistBudget error:', err.message);
  }
}

// Ensure uploads directory exists (Railway filesystem may not have it)
const UPLOADS_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer — memory storage for scanning (no file saved to disk)
const scanUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'), false);
  },
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
});

// Configure multer for file uploads — memory storage so we can save to DB
const upload = multer({ storage: multer.memoryStorage(), fileFilter: (req, file, cb) => {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Only PDF files are allowed'), false);
  }
}});

// GET /api/contracts
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { artist, type, status } = req.query;
    // Surface every uploaded PDF on the list, not just the legacy file_path
    // column. Three independent scalar subqueries keep the SQL trivially
    // correct (LATERAL with mixed aggregate + scalar subqueries had a
    // quirky shape that wasn't returning data reliably). The latest_file_id
    // also lets the frontend hit the per-file download endpoint directly
    // so contracts whose legacy file_path was never set still preview.
    let query = `
      SELECT c.*, a.name as artist_name,
             (SELECT COUNT(*)::int FROM entity_files ef
               WHERE ef.entity_type = 'contract' AND ef.entity_id = c.id) AS file_count,
             (SELECT ef.id FROM entity_files ef
               WHERE ef.entity_type = 'contract' AND ef.entity_id = c.id
               ORDER BY ef.uploaded_at DESC LIMIT 1) AS latest_file_id,
             (SELECT ef.filename FROM entity_files ef
               WHERE ef.entity_type = 'contract' AND ef.entity_id = c.id
               ORDER BY ef.uploaded_at DESC LIMIT 1) AS latest_file_filename,
             (SELECT ef.original_name FROM entity_files ef
               WHERE ef.entity_type = 'contract' AND ef.entity_id = c.id
               ORDER BY ef.uploaded_at DESC LIMIT 1) AS latest_file_original_name
      FROM contracts c
      JOIN artists a ON c.artist_id = a.id
      WHERE 1=1
    `;
    const params = [];

    if (artist) {
      query += ` AND LOWER(a.name) LIKE LOWER($${params.length + 1})`;
      params.push(`%${artist}%`);
    }

    if (type) {
      query += ` AND c.type = $${params.length + 1}`;
      params.push(type);
    }

    if (status) {
      query += ` AND c.status = $${params.length + 1}`;
      params.push(status);
    }

    query += ' ORDER BY c.expiration_date ASC';

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error('Get contracts error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/contracts
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { artist_id, type, date_signed, expiration_date, status, royalty_split, advance, territory, num_releases, notes, financial_terms } =
      req.body;

    if (!artist_id || !type) {
      return res.status(400).json({ success: false, error: 'Artist ID and type required' });
    }

    const result = await pool.query(
      `
      INSERT INTO contracts (artist_id, type, date_signed, expiration_date, status, royalty_split, advance, territory, num_releases, notes, financial_terms, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      RETURNING *
      `,
      [artist_id, type, date_signed || null, expiration_date || null, status || 'Active', royalty_split, advance, territory, num_releases, notes || null, JSON.stringify(financial_terms || [])]
    );

    // Auto-sync artist budget from contract obligations (fire-and-forget)
    syncArtistBudget(artist_id);

    res.status(201).json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Create contract error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// IMPORTANT: Special routes MUST be defined before /:id to avoid being swallowed by the param handler

// GET /api/contracts/missing
router.get('/missing', authMiddleware, async (req, res) => {
  try {
    // Artists with releases but no contract at all
    const noContractResult = await pool.query(
      `SELECT a.id, a.name, a.genre, a.total_releases,
              COUNT(r.id) as release_count,
              MIN(r.release_date) as first_release,
              MAX(r.release_date) as latest_release
       FROM artists a
       JOIN releases r ON r.artist_id = a.id
       LEFT JOIN contracts c ON c.artist_id = a.id
       WHERE c.id IS NULL
       GROUP BY a.id, a.name, a.genre, a.total_releases
       ORDER BY release_count DESC`
    );

    // Artists with contracts but missing file uploads (check entity_files)
    const noFileResult = await pool.query(
      `SELECT c.id as contract_id, a.name as artist_name, c.type, c.status,
              c.date_signed, c.expiration_date
       FROM contracts c
       JOIN artists a ON c.artist_id = a.id
       WHERE NOT EXISTS (
         SELECT 1 FROM entity_files ef
         WHERE ef.entity_type = 'contract' AND ef.entity_id = c.id
       )
       ORDER BY a.name, c.type`
    );

    // Artists with expired contracts and no active replacement
    const expiredResult = await pool.query(
      `SELECT a.id, a.name, c.type, c.expiration_date
       FROM contracts c
       JOIN artists a ON c.artist_id = a.id
       WHERE c.status = 'Expired'
         AND NOT EXISTS (
           SELECT 1 FROM contracts c2
           WHERE c2.artist_id = c.artist_id
             AND c2.type = c.type
             AND c2.status = 'Active'
         )
       ORDER BY c.expiration_date DESC`
    );

    res.json({
      success: true,
      data: {
        noContract: noContractResult.rows,
        noFile: noFileResult.rows,
        expiredUnreplaced: expiredResult.rows,
      },
    });
  } catch (error) {
    console.error('Get missing contracts error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/contracts/renewals
router.get('/renewals', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT c.*, a.name as artist_name
      FROM contracts c
      JOIN artists a ON c.artist_id = a.id
      WHERE c.expiration_date IS NOT NULL
      ORDER BY c.expiration_date ASC
      `
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error('Get renewals error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/contracts/expiring — contracts expiring within 90 days
router.get('/expiring', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, a.name as artist_name,
              (c.expiration_date - CURRENT_DATE) AS days_until_expiry
       FROM contracts c
       JOIN artists a ON c.artist_id = a.id
       WHERE c.expiration_date IS NOT NULL
         AND c.expiration_date >= CURRENT_DATE
         AND c.expiration_date <= CURRENT_DATE + INTERVAL '90 days'
         AND c.status = 'Active'
       ORDER BY c.expiration_date ASC`
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get expiring contracts error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/contracts/scan — extract fields from a PDF using Claude AI
router.post('/scan', authMiddleware, scanUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file provided' });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({
        success: false,
        error: 'Contract scanning requires ANTHROPIC_API_KEY to be set in your Railway environment variables.',
        setup_required: true,
      });
    }

    const prompt = `You are extracting structured data from a music industry contract. Return ONLY a valid JSON object — no explanation, no markdown, just the JSON.

{
  "artist_name": "the recording artist or band name (string or null)",
  "contract_type": "exactly one of: Recording, Publishing, Distribution, Management, Licensing (or null)",
  "royalty_split": <artist royalty percentage as a plain number e.g. 80, or null>,
  "advance": <advance payment in dollars as a plain number e.g. 25000, or null>,
  "date_signed": "YYYY-MM-DD or null",
  "expiration_date": "YYYY-MM-DD or null",
  "territory": "e.g. Worldwide or null",
  "notes": "1-2 key deal terms worth noting (string or null)",
  "financial_obligations": [
    {
      "label": "human-readable name e.g. Recording Fund, Marketing Fund, Distribution Fee, Video Budget, Tour Support, Sync Fee, Mechanical Rate, etc.",
      "amount": "dollar amount as number, or percentage as string like '15%', or description like 'statutory rate'",
      "recoupable": true or false,
      "note": "brief clarifying note or null",
      "_confidence": "high | medium | low"
    }
  ],
  "_confidence": {
    "artist_name": "high | medium | low",
    "contract_type": "high | medium | low",
    "royalty_split": "high | medium | low",
    "advance": "high | medium | low",
    "date_signed": "high | medium | low",
    "expiration_date": "high | medium | low",
    "territory": "high | medium | low"
  }
}

For financial_obligations: extract EVERY financial commitment in the contract — funds, budgets, fees, rates, bonuses. Do NOT include the advance here (that's the separate advance field). If none found, return an empty array [].

For _confidence: rate every field you extracted using this scale:
  - "high"   = the value is explicitly stated in the contract (you copied it from the page)
  - "medium" = the value is implied / inferred from context (e.g. type inferred from agreement title, or a date computed from "5 years from signing")
  - "low"    = you guessed / defaulted because the contract didn't really say (or it was ambiguous)
Be honest. A user-facing UI warns when confidence is medium or low so they can double-check. Over-claiming "high" costs trust more than admitting "low".
For any field whose extracted value is null, omit it from _confidence (it doesn't need a rating).`;

    const result = await callClaude({
      prompt,
      buffer: req.file.buffer,
      mimeType: 'application/pdf',
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 1024,
      // parseJson: false — the response sometimes wraps JSON in prose, so we extract via regex below.
    });
    if (!result.ok) {
      return res.status(500).json({ success: false, error: result.error || 'Contract scan failed' });
    }

    // Extract JSON even if wrapped in ```json blocks or prose
    const jsonMatch = result.raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(422).json({ success: false, error: 'Could not parse contract data from PDF' });
    }

    const extracted = JSON.parse(jsonMatch[0]);
    // Normalise financial_obligations to always be an array
    if (!Array.isArray(extracted.financial_obligations)) {
      extracted.financial_obligations = [];
    }
    // Normalise _confidence to always be an object, and clamp values to
    // the documented enum so a hallucinated "very-high" doesn't trip the
    // frontend chip-rendering logic.
    if (!extracted._confidence || typeof extracted._confidence !== 'object') {
      extracted._confidence = {};
    }
    const VALID_CONF = new Set(['high', 'medium', 'low']);
    for (const k of Object.keys(extracted._confidence)) {
      if (!VALID_CONF.has(extracted._confidence[k])) delete extracted._confidence[k];
    }
    extracted.financial_obligations = extracted.financial_obligations.map(o => ({
      ...o,
      _confidence: VALID_CONF.has(o?._confidence) ? o._confidence : undefined,
    }));
    res.json({ success: true, data: extracted });
  } catch (err) {
    console.error('Contract scan error:', err);
    if (err.status === 401) {
      return res.status(401).json({ success: false, error: 'Invalid Anthropic API key' });
    }
    res.status(500).json({ success: false, error: 'Scan failed: ' + err.message });
  }
});

// GET /api/contracts/:id/linked — every dashboard-side number we can pin to
// this contract: releases, expenses (with recoupment breakdown), and income.
// Joins on artist_id (releases / income / artist_budgets — clean FK) and on
// the artist *name* for the ledger expenses table (it has no artist_id FK,
// only a free-text artist column — case-insensitive trim match keeps
// "Logic" / "logic" / " Logic " grouped together).
//
// The contract's date_signed → expiration_date defines the "during term"
// window so the panel can show "8 releases (5 during this term)" without
// implying the lifetime stats belong to this specific contract.
router.get('/:id/linked', authMiddleware, async (req, res) => {
  try {
    const { rows: contractRows } = await pool.query(
      `SELECT c.id, c.artist_id, c.date_signed, c.expiration_date, a.name AS artist_name
       FROM contracts c JOIN artists a ON c.artist_id = a.id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!contractRows.length) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }
    const { artist_id, artist_name, date_signed, expiration_date } = contractRows[0];

    // Releases — counted lifetime + during contract term. Recent list is
    // top-5 by release_date for a sparkline-ish "what's been shipping"
    // glance. Releases don't currently carry a contract_id, so this is
    // artist-scoped, not contract-scoped — caveat'd in the UI.
    const [releaseTotals, recentReleases] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int AS total,
           SUM(CASE WHEN release_date BETWEEN $2 AND $3 THEN 1 ELSE 0 END)::int AS during_term
         FROM releases
         WHERE artist_id = $1
           AND (archived IS NULL OR archived = FALSE)`,
        [artist_id, date_signed || '1900-01-01', expiration_date || '2999-12-31']
      ),
      pool.query(
        `SELECT id, project_name, release_date, status
         FROM releases
         WHERE artist_id = $1 AND (archived IS NULL OR archived = FALSE)
         ORDER BY release_date DESC NULLS LAST LIMIT 5`,
        [artist_id]
      ),
    ]);

    // Ledger expenses for this artist. Recoupment columns drive the
    // advance-progress card; unpaid totals warn about outstanding spend.
    // Excludes split children so a $1,200 invoice split 3 ways doesn't
    // count as $4,800.
    const expenseTotals = await pool.query(
      `SELECT
         COUNT(*)::int AS count,
         COALESCE(SUM(amount), 0)::numeric AS total,
         COALESCE(SUM(CASE WHEN recoupable = TRUE THEN amount ELSE 0 END), 0)::numeric AS recoupable_total,
         SUM(CASE WHEN recoupable = TRUE THEN 1 ELSE 0 END)::int AS recoupable_count,
         COALESCE(SUM(CASE WHEN ufr = 'Yes' THEN amount ELSE 0 END), 0)::numeric AS ufr_total,
         SUM(CASE WHEN ufr = 'Yes' THEN 1 ELSE 0 END)::int AS ufr_count,
         COALESCE(SUM(CASE WHEN payment_status IS DISTINCT FROM 'Paid' THEN amount ELSE 0 END), 0)::numeric AS unpaid_total,
         SUM(CASE WHEN payment_status IS DISTINCT FROM 'Paid' THEN 1 ELSE 0 END)::int AS unpaid_count
       FROM expenses
       WHERE LOWER(TRIM(artist)) = LOWER(TRIM($1))
         AND (deleted IS NULL OR deleted = FALSE)
         AND COALESCE(status, 'approved') = 'approved'
         AND parent_id IS NULL`,
      [artist_name]
    );

    // Spend by category, capped to top 6 so a sprawling history doesn't
    // dominate the card. Drives the "marketing-fund overrun" instinct.
    const byCategory = await pool.query(
      `SELECT category, COALESCE(SUM(amount), 0)::numeric AS total, COUNT(*)::int AS count
       FROM expenses
       WHERE LOWER(TRIM(artist)) = LOWER(TRIM($1))
         AND (deleted IS NULL OR deleted = FALSE)
         AND COALESCE(status, 'approved') = 'approved'
         AND parent_id IS NULL
         AND category IS NOT NULL
       GROUP BY category
       ORDER BY total DESC LIMIT 6`,
      [artist_name]
    );

    // Income on artist_income (royalties / sync / etc.), totaled lifetime
    // and within the contract term. by_type funds the "where does revenue
    // come from" breakdown.
    const [incomeTotals, incomeByType] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(amount), 0)::numeric AS total,
           COALESCE(SUM(CASE WHEN income_date BETWEEN $2 AND $3 THEN amount ELSE 0 END), 0)::numeric AS during_term
         FROM artist_income
         WHERE artist_id = $1`,
        [artist_id, date_signed || '1900-01-01', expiration_date || '2999-12-31']
      ),
      pool.query(
        `SELECT COALESCE(income_type, 'Other') AS income_type,
                COALESCE(SUM(amount), 0)::numeric AS total
         FROM artist_income
         WHERE artist_id = $1
         GROUP BY income_type
         ORDER BY total DESC LIMIT 6`,
        [artist_id]
      ),
    ]);

    res.json({
      success: true,
      data: {
        releases: {
          total: releaseTotals.rows[0].total || 0,
          during_term: releaseTotals.rows[0].during_term || 0,
          recent: recentReleases.rows,
        },
        expenses: {
          ...expenseTotals.rows[0],
          // Convert numeric→number on the way out — pg returns these as
          // strings by default, which trips up clientside math.
          total: Number(expenseTotals.rows[0].total) || 0,
          recoupable_total: Number(expenseTotals.rows[0].recoupable_total) || 0,
          ufr_total: Number(expenseTotals.rows[0].ufr_total) || 0,
          unpaid_total: Number(expenseTotals.rows[0].unpaid_total) || 0,
          by_category: byCategory.rows.map(r => ({
            ...r, total: Number(r.total) || 0,
          })),
        },
        income: {
          total: Number(incomeTotals.rows[0].total) || 0,
          during_term: Number(incomeTotals.rows[0].during_term) || 0,
          by_type: incomeByType.rows.map(r => ({
            ...r, total: Number(r.total) || 0,
          })),
        },
      },
    });
  } catch (error) {
    console.error('Get contract linked-data error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/contracts/:id
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT c.*, a.name as artist_name
      FROM contracts c
      JOIN artists a ON c.artist_id = a.id
      WHERE c.id = $1
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Get contract error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/contracts/:id
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { type, date_signed, expiration_date, status, royalty_split, advance, territory, num_releases, notes, financial_terms } = req.body;

    const result = await pool.query(
      `
      UPDATE contracts
      SET type = COALESCE($1, type),
          date_signed = COALESCE($2, date_signed),
          expiration_date = COALESCE($3, expiration_date),
          status = COALESCE($4, status),
          royalty_split = COALESCE($5, royalty_split),
          advance = COALESCE($6, advance),
          territory = COALESCE($7, territory),
          num_releases = COALESCE($8, num_releases),
          notes = COALESCE($9, notes),
          financial_terms = COALESCE($10, financial_terms)
      WHERE id = $11
      RETURNING *
      `,
      [type, date_signed, expiration_date, status, royalty_split, advance, territory, num_releases, notes, financial_terms ? JSON.stringify(financial_terms) : null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    // Auto-sync artist budget from updated contract obligations
    syncArtistBudget(result.rows[0].artist_id);

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Update contract error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/contracts/:id — remove a contract row and all attached files.
// Pulls the entity_files rows first so R2 keys can be cleaned up after the
// DB delete commits. Re-syncs the artist's budget since this contract's
// financial obligations no longer apply. The Contracts page itself is
// admin-gated client-side (App.jsx wraps it in <AdminRoute>), so we don't
// re-gate here — consistent with the surrounding PUT / POST /:id/upload.
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // Snapshot the contract (we need artist_id for the post-delete budget
    // sync, and the legacy file_path for the disk-fallback cleanup) plus
    // every entity_files row attached to it so R2 keys aren't orphaned.
    const contractRow = await pool.query('SELECT id, artist_id, file_path FROM contracts WHERE id = $1', [id]);
    if (!contractRow.rows.length) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }
    const { artist_id: artistId, file_path: legacyFilePath } = contractRow.rows[0];

    const fileRows = await pool.query(
      `SELECT id, filename, r2_key FROM entity_files WHERE entity_type = 'contract' AND entity_id = $1`,
      [id]
    );

    // DELETE the contract row first — the DB constraint surface is the
    // safest place to fail. R2 + disk cleanup is best-effort after that.
    await pool.query(`DELETE FROM entity_files WHERE entity_type = 'contract' AND entity_id = $1`, [id]);
    await pool.query('DELETE FROM contracts WHERE id = $1', [id]);

    // Best-effort R2 + disk cleanup. R2 failures are swallowed because the
    // DB row is already gone — leaving an orphan key in R2 is cheaper than
    // failing a delete the user has already confirmed.
    for (const f of fileRows.rows) {
      if (f.r2_key) {
        deleteFile(f.r2_key).catch(err => console.warn('R2 delete failed:', err.message));
      }
      if (f.filename) {
        const diskPath = path.join(UPLOADS_DIR, f.filename);
        fs.unlink(diskPath, () => {});
      }
    }
    if (legacyFilePath) {
      const diskPath = path.join(UPLOADS_DIR, path.basename(legacyFilePath));
      fs.unlink(diskPath, () => {});
    }

    // Recompute the artist's budget so the removed contract's financial
    // obligations stop showing up. Fire-and-forget — same pattern as PUT.
    if (artistId) syncArtistBudget(artistId);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete contract error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/contracts/:id/upload (kept for backward compat — now also writes to entity_files)
router.post('/:id/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const timestamp = Date.now();
    const sanitized = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storedFilename = `${timestamp}-${sanitized}`;
    const filePath = `/uploads/${storedFilename}`;
    const r2Key = `entity_files/contract/${req.params.id}/${storedFilename}`;

    // Update contract's legacy file_path column
    const result = await pool.query('UPDATE contracts SET file_path = $1 WHERE id = $2 RETURNING *', [filePath, req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    // Upload the bytes to R2, then record only the key in entity_files.
    await uploadFile(r2Key, req.file.buffer, req.file.mimetype);

    const fileRow = await pool.query(
      `INSERT INTO entity_files (entity_type, entity_id, filename, original_name, file_size, uploaded_by, r2_key, mime_type)
       VALUES ('contract', $1, $2, $3, $4, $5, $6, $7) RETURNING id, entity_type, entity_id, filename, original_name, file_size, uploaded_by, uploaded_at, label`,
      [req.params.id, storedFilename, req.file.originalname, req.file.size, req.user?.id || null, r2Key, req.file.mimetype]
    );

    res.json({ success: true, data: { ...result.rows[0], uploaded_file: fileRow.rows[0] } });
  } catch (error) {
    console.error('Upload contract error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/contracts/:id/files — the unified entity-files upload endpoint
// (mirrors POST /api/deals/:id/files and /api/artists/:id/files). The
// FilesPanel component hits this path; the older POST /:id/upload above is
// kept for legacy callers (drag-drop on the contracts list page) and also
// writes the legacy file_path column.
router.post('/:id/files', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    // Verify the contract exists so a stale modal can't silently orphan
    // an entity_files row.
    const contractCheck = await pool.query('SELECT id FROM contracts WHERE id = $1', [req.params.id]);
    if (!contractCheck.rows.length) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }
    const sanitized = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storedFilename = `${Date.now()}-${sanitized}`;
    const r2Key = `entity_files/contract/${req.params.id}/${storedFilename}`;
    await uploadFile(r2Key, req.file.buffer, req.file.mimetype);
    const result = await pool.query(
      `INSERT INTO entity_files (entity_type, entity_id, filename, original_name, file_size, uploaded_by, r2_key, mime_type)
       VALUES ('contract', $1, $2, $3, $4, $5, $6, $7)
       RETURNING id, entity_type, entity_id, filename, original_name, file_size, uploaded_by, uploaded_at, label`,
      [req.params.id, storedFilename, req.file.originalname, req.file.size, req.user?.id || null, r2Key, req.file.mimetype]
    );
    // Keep the legacy file_path column in sync so older list-view callers
    // (and the GET /api/contracts roll-up's file_path fallback) still see
    // a value pointing at the most recent upload.
    await pool.query(
      'UPDATE contracts SET file_path = $1 WHERE id = $2',
      [`/uploads/${storedFilename}`, req.params.id]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Upload contract file error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/contracts/:id/files
router.get('/:id/files', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      // Metadata only — ef.file_data (base64 blob) served via download route.
      `SELECT ef.id, ef.entity_type, ef.entity_id, ef.filename, ef.original_name,
              ef.file_size, ef.uploaded_by, ef.uploaded_at, ef.label, ef.mime_type,
              u.name as uploaded_by_name
       FROM entity_files ef
       LEFT JOIN users u ON ef.uploaded_by = u.id
       WHERE ef.entity_type = 'contract' AND ef.entity_id = $1
       ORDER BY ef.uploaded_at DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get contract files error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/contracts/:id/files/:fileId
router.delete('/:id/files/:fileId', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM entity_files WHERE id = $1 AND entity_type = 'contract' AND entity_id = $2 RETURNING *`,
      [req.params.fileId, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }
    // Best-effort cleanup — R2 first (new files), disk second (legacy).
    if (result.rows[0].r2_key) {
      deleteFile(result.rows[0].r2_key).catch(err => console.warn('R2 delete failed:', err.message));
    }
    const diskPath = path.join(UPLOADS_DIR, result.rows[0].filename);
    fs.unlink(diskPath, (err) => {
      if (err) console.warn('Could not delete file from disk:', diskPath);
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete contract file error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/contracts/generate — AI generates contract text based on existing contracts and user input
router.post('/generate', authMiddleware, async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ success: false, error: 'ANTHROPIC_API_KEY required' });
    }

    const { artist_name, type, royalty_split, advance, territory, num_releases, duration_years, notes, financial_terms } = req.body;

    if (!artist_name || !type) {
      return res.status(400).json({ success: false, error: 'Artist name and contract type are required' });
    }

    // Fetch existing contracts of the same type as reference
    const { rows: refs } = await pool.query(
      `SELECT c.type, c.royalty_split, c.advance, c.territory, c.num_releases, c.notes,
              c.financial_terms, a.name as artist_name
       FROM contracts c
       JOIN artists a ON c.artist_id = a.id
       WHERE LOWER(c.type) = LOWER($1) AND c.status = 'Active'
       ORDER BY c.created_at DESC LIMIT 5`,
      [type]
    );

    // If no same-type refs, fetch any recent contracts
    let referenceContracts = refs;
    if (refs.length === 0) {
      const { rows: anyRefs } = await pool.query(
        `SELECT c.type, c.royalty_split, c.advance, c.territory, c.num_releases, c.notes,
                c.financial_terms, a.name as artist_name
         FROM contracts c
         JOIN artists a ON c.artist_id = a.id
         WHERE c.status = 'Active'
         ORDER BY c.created_at DESC LIMIT 5`
      );
      referenceContracts = anyRefs;
    }

    const refText = referenceContracts.length > 0
      ? referenceContracts.map((r, i) => `Reference ${i + 1} (${r.type} with ${r.artist_name}): Royalty ${r.royalty_split || 'N/A'}%, Advance ${r.advance || 'N/A'}, Territory ${r.territory || 'N/A'}, Releases ${r.num_releases || 'N/A'}, Terms: ${JSON.stringify(r.financial_terms || [])}`).join('\n')
      : 'No existing contracts on file for reference.';

    const prompt = `You are a music industry contract attorney drafting a contract for Market Street, a record label.

EXISTING CONTRACTS ON FILE (use these as reference for style, terms, and structure):
${refText}

GENERATE A NEW CONTRACT with these specifications:
- Type: ${type} Agreement
- Artist: ${artist_name}
- Label: Market Street
- Royalty Split: ${royalty_split || 'To be determined'}%
- Advance: $${advance || '0'}
- Territory: ${territory || 'Worldwide'}
- Number of Releases: ${num_releases || 'To be determined'}
- Duration: ${duration_years || '1'} year(s)
${notes ? `- Additional Notes/Requirements: ${notes}` : ''}
${financial_terms && financial_terms.length > 0 ? `- Financial Obligations: ${JSON.stringify(financial_terms)}` : ''}

Generate a professional, complete contract document. Include:
1. Parties (Market Street and the artist)
2. Term and territory
3. Recording/publishing/distribution obligations (based on contract type)
4. Financial terms (royalty split, advance, recoupment)
5. Rights and ownership
6. Termination clauses
7. General provisions
8. Signature blocks

Use professional legal language but keep it readable. Format with clear section headers and numbered paragraphs. This should be a complete, ready-to-review contract draft.`;

    const result = await callClaude({ prompt, maxTokens: 4096 });
    if (!result.ok) {
      return res.status(500).json({ success: false, error: result.error || 'Contract generation failed' });
    }

    res.json({ success: true, data: { text: result.raw } });
  } catch (err) {
    console.error('POST /api/contracts/generate:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
