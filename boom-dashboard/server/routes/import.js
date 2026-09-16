const express = require('express');
const multer = require('multer');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { secureFileFilter } = require('../middleware/secureUpload');
const { parseSheet, diff, loadDbState, applyImport } = require('../lib/masterSheet');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB — master sheet is ~400 KB
  fileFilter: secureFileFilter,
});

// Admin gating on the master-sheet route moved to a page-permission
// middleware (see the requirePagePermission usage below). The /bulk
// endpoint above stays open to any authed user — it just inserts rows
// that landed there via the QB CSV wizard.

// POST /api/import/bulk
// Accepts an array of pre-validated rows from the QB CSV import wizard.
// Each row is either an expense or income entry.
// Inserts in a single transaction; returns counts of each type.
router.post('/bulk', authMiddleware, async (req, res) => {
  const { rows } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ success: false, error: 'No rows provided' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let expenseCount = 0;
    let incomeCount = 0;

    for (const row of rows) {
      const {
        record_type,          // 'expense' | 'income'
        artist_id,
        artist_name,
        description,
        amount,
        date,
        // expense-specific
        category,
        song,
        recoupable,
        release_id,
        // income-specific
        income_type,
        notes,
      } = row;

      if (!description || !amount || !record_type) continue;

      const absAmount = Math.abs(parseFloat(amount));
      if (isNaN(absAmount) || absAmount === 0) continue;

      if (record_type === 'expense') {
        await client.query(`
          INSERT INTO manual_expenses
            (artist_id, artist_name, description, amount, category, song,
             expense_date, recoupable, release_id, created_by, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        `, [
          artist_id   || null,
          artist_name || null,
          description,
          absAmount,
          category    || 'Other',
          song        || null,
          date        || new Date().toISOString().split('T')[0],
          recoupable  ?? false,
          release_id  || null,
          req.user.id,
        ]);
        expenseCount++;
      } else if (record_type === 'income') {
        await client.query(`
          INSERT INTO artist_income
            (artist_id, artist_name, description, amount, income_type,
             income_date, release_id, notes, created_by, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        `, [
          artist_id   || null,
          artist_name || null,
          description,
          absAmount,
          income_type || 'Other',
          date        || new Date().toISOString().split('T')[0],
          release_id  || null,
          notes       || null,
          req.user.id,
        ]);
        incomeCount++;
      }
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      data: {
        imported: expenseCount + incomeCount,
        expenses: expenseCount,
        income: incomeCount,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Bulk import error:', err);
    res.status(500).json({ success: false, error: 'Import failed — changes rolled back' });
  } finally {
    client.release();
  }
});

// POST /api/import/master-sheet
// Accepts the Market Street master sheet .xlsx as multipart 'file'.
// `apply=1` (form field or query) applies the import; otherwise dry run.
// Returns the same stats the CLI script prints, plus previews of new artists
// + DB orphans the spreadsheet doesn't mention.
//
// Page-permission gate via requirePagePermission so a User explicitly
// granted /import/master-sheet by an admin can hit this endpoint. The
// prior hardcoded isAdmin check ignored those grants.
const { requirePagePermission: requireImportAccess } = require('./../middleware/pagePermission');
router.post('/master-sheet', authMiddleware, requireImportAccess('/import/master-sheet'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  const apply = req.query.apply === '1'
    || req.query.apply === 'true'
    || req.body?.apply === '1'
    || req.body?.apply === 'true';

  let rows;
  try {
    rows = await parseSheet(req.file.buffer);
  } catch (err) {
    console.error('Master sheet parse failed:', err);
    return res.status(400).json({
      success: false,
      error: 'Could not parse spreadsheet. Make sure it is a Market Street master sheet .xlsx with "Upcoming Releases" and/or "Past Releases" tabs.',
    });
  }

  const client = await pool.connect();
  try {
    const { dbArtists, dbReleases } = await loadDbState(client);
    const { stats, artistsToCreate, toInsert, dbOrphans } = diff(rows, dbReleases, dbArtists);

    const summary = {
      totalRows: stats.totalRows,
      skippedNoArtistName: stats.skippedNoArtistName,
      skippedNoTitle: stats.skippedNoTitle,
      skippedDuplicate: stats.skippedDuplicate,
      willInsert: toInsert.length,
      newArtists: artistsToCreate.length,
      existingArtists: dbArtists.length,
      existingReleases: dbReleases.length,
      orphanCount: dbOrphans.length,
    };

    const preview = {
      newArtists: artistsToCreate.slice(0, 50).map(a => a.name),
      newArtistsTruncated: Math.max(0, artistsToCreate.length - 50),
      orphans: dbOrphans.slice(0, 50),
      orphansTruncated: Math.max(0, dbOrphans.length - 50),
      sampleInserts: toInsert.slice(0, 25).map(r => ({
        artist: r.artist,
        title: r.title,
        sheet: r.sheet,
        release_date: r.release_date,
        upc: r.upc,
      })),
      sampleInsertsTruncated: Math.max(0, toInsert.length - 25),
    };

    if (!apply) {
      return res.json({ success: true, applied: false, summary, preview });
    }

    await client.query('BEGIN');
    const { artistsCreated, releasesInserted } = await applyImport(client, {
      artistsToCreate, toInsert, dbArtists,
    });
    await client.query('COMMIT');

    return res.json({
      success: true,
      applied: true,
      summary: { ...summary, artistsCreated, releasesInserted },
      preview,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Master sheet import failed:', err);
    return res.status(500).json({
      success: false,
      error: 'Import failed — changes rolled back. ' + (err.message || ''),
    });
  } finally {
    client.release();
  }
});

module.exports = router;
