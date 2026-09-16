// Public list of active Market Street reps.
//
// This endpoint deliberately does NOT require auth so the unauthenticated
// vendor submit form (/submit, served at /api/vendor/*) can populate its
// "Which Market Street Rep are you working with?" dropdown without leaking auth
// tokens. The data is the same set of names already visible to vendors
// on the form anyway — not sensitive.
//
// Admin CRUD (create rep, toggle active) lives at /api/settings/reps and
// is auth-gated to Admin/Superadmin.

const express = require('express');
const pool = require('../db');
const router = express.Router();

// GET /api/reps — returns active rep names as a flat array
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT name FROM boom_reps WHERE active = TRUE ORDER BY name ASC`
    );
    res.json({ success: true, data: rows.map(r => r.name) });
  } catch (err) {
    console.error('GET /api/reps:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
