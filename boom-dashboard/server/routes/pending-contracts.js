const express = require('express');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// Pending contracts gate matches /api/contracts: admin/Approver pass
// freely; other Users must have explicit page_permissions for a
// contract page. Sensitive-path default-block applies for Users with
// no permission rows.
const { requirePagePermission } = require('../middleware/pagePermission');
router.use(authMiddleware, requirePagePermission(
  '/contracts', '/pending-contracts', '/renewals', '/contracts/create'
));

// (The one-time /seed endpoint and its hardcoded launch data were removed —
// it was unauthenticated behind a guessable key and wiped the live table.
// See git history if the original seed rows are ever needed.)
// GET /api/pending-contracts
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { status, search } = req.query;
    let query = 'SELECT * FROM pending_contracts WHERE 1=1';
    const params = [];

    if (status) {
      query += ` AND status = $${params.length + 1}`;
      params.push(status);
    }

    if (search) {
      query += ` AND (LOWER(artist_name) LIKE LOWER($${params.length + 1}) OR LOWER(legal_name) LIKE LOWER($${params.length + 1}))`;
      params.push(`%${search}%`);
    }

    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get pending contracts error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/pending-contracts/:id
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM pending_contracts WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Get pending contract error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/pending-contracts
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { artist_name, legal_name, address, cash, split, years, options, back_signs, futures, status, email, notes } = req.body;
    if (!artist_name) return res.status(400).json({ success: false, error: 'Artist name required' });

    const result = await pool.query(
      `INSERT INTO pending_contracts
         (artist_name, legal_name, address, cash, split, years, options, back_signs, futures, status, email, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [artist_name, legal_name || null, address || null, cash || null, split || null, years || null, options || null, back_signs || null, futures || null, status || 'Not Sent', email || null, notes || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Create pending contract error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/pending-contracts/:id
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { artist_name, legal_name, address, cash, split, years, options, back_signs, futures, status, email, notes } = req.body;
    const result = await pool.query(
      `UPDATE pending_contracts SET
         artist_name = COALESCE($1, artist_name),
         legal_name  = $2,
         address     = $3,
         cash        = $4,
         split       = $5,
         years       = $6,
         options     = $7,
         back_signs  = $8,
         futures     = $9,
         status      = COALESCE($10, status),
         email       = $11,
         notes       = $12,
         updated_at  = NOW()
       WHERE id = $13
       RETURNING *`,
      [artist_name, legal_name, address, cash, split, years, options, back_signs, futures, status, email, notes, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update pending contract error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/pending-contracts/:id
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM pending_contracts WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete pending contract error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
