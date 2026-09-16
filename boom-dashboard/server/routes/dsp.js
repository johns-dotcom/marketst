const express = require('express');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const DSP_LIST = [
  'Spotify', 'Apple Music', 'Amazon Music', 'YouTube Music',
  'TIDAL', 'Pandora', 'Deezer', 'iHeart Radio', 'Audiomack'
];

// GET /api/dsp/:releaseId — get all DSP statuses for a release
router.get('/:releaseId', authMiddleware, async (req, res) => {
  try {
    const { releaseId } = req.params;

    // Get existing rows
    const result = await pool.query(
      `SELECT * FROM dsp_submissions WHERE release_id = $1 ORDER BY dsp_name`,
      [releaseId]
    );

    // Fill in missing DSPs with default "Not Submitted"
    const existing = {};
    result.rows.forEach(r => { existing[r.dsp_name] = r; });

    const all = DSP_LIST.map(dsp => existing[dsp] || {
      release_id: parseInt(releaseId),
      dsp_name: dsp,
      status: 'Not Submitted',
      submitted_date: null,
      live_date: null,
      notes: null,
    });

    res.json({ success: true, data: all });
  } catch (error) {
    console.error('Get DSP submissions error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/dsp/:releaseId — upsert one DSP entry
router.put('/:releaseId', authMiddleware, async (req, res) => {
  try {
    const { releaseId } = req.params;
    const { dsp_name, status, submitted_date, live_date, notes } = req.body;

    if (!dsp_name) {
      return res.status(400).json({ success: false, error: 'dsp_name required' });
    }

    const result = await pool.query(
      `INSERT INTO dsp_submissions (release_id, dsp_name, status, submitted_date, live_date, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (release_id, dsp_name) DO UPDATE SET
         status         = EXCLUDED.status,
         submitted_date = EXCLUDED.submitted_date,
         live_date      = EXCLUDED.live_date,
         notes          = EXCLUDED.notes,
         updated_at     = NOW()
       RETURNING *`,
      [releaseId, dsp_name, status || 'Not Submitted', submitted_date || null, live_date || null, notes || null]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update DSP submission error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
