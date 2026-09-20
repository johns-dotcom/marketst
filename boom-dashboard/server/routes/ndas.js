const express = require('express');
const router = express.Router();
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// GET all NDAs — most recent first.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM boom_ndas ORDER BY created_at DESC, id DESC'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST create NDA
router.post('/', async (req, res) => {
  try {
    const {
      effective_date, owner_name, owner_address,
      recipient_name, recipient_address, disclosed_to, recipient_email,
      signatory_name, signatory_title, custom_body,
      include_non_circumvention, include_non_solicitation,
      template_id, template_data,
    } = req.body;

    if (!effective_date || !owner_name || !recipient_name) {
      return res.status(400).json({ success: false, error: 'effective_date, owner_name, and recipient_name are required' });
    }

    // Whitelist template_id shape so callers can't stash arbitrary
    // strings; the client picks from a fixed registry. Default to
    // 'standard' when omitted — the historical single-template flow.
    const safeTemplateId = (typeof template_id === 'string' && /^[a-z0-9_-]{1,64}$/.test(template_id))
      ? template_id : 'standard';
    // template_data is opaque JSONB the client uses to persist per-
    // template extra form fields (project title, track name, etc.).
    // Only accept plain objects; anything else lands as null.
    const safeTemplateData = (template_data && typeof template_data === 'object' && !Array.isArray(template_data))
      ? template_data : null;

    const { rows } = await pool.query(
      `INSERT INTO boom_ndas
         (effective_date, owner_name, owner_address, recipient_name, recipient_address,
          disclosed_to, signatory_name, signatory_title, custom_body,
          include_non_circumvention, include_non_solicitation, created_by,
          template_id, template_data, recipient_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15) RETURNING *`,
      [
        effective_date, owner_name, owner_address || null, recipient_name, recipient_address || null,
        disclosed_to || null, signatory_name || null, signatory_title || null, custom_body || null,
        include_non_circumvention !== false,
        include_non_solicitation !== false,
        req.user?.name || 'Unknown',
        safeTemplateId,
        safeTemplateData ? JSON.stringify(safeTemplateData) : null,
        recipient_email ? String(recipient_email).trim().toLowerCase().slice(0, 200) : null,
      ]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT update NDA — same allow-list pattern as invoices.
router.put('/:id', async (req, res) => {
  try {
    const allowed = ['effective_date', 'owner_name', 'owner_address', 'recipient_name',
      'recipient_address', 'disclosed_to', 'signatory_name', 'signatory_title', 'custom_body',
      'include_non_circumvention', 'include_non_solicitation',
      'template_id', 'template_data', 'recipient_email'];
    const fields = Object.keys(req.body).filter(k => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ success: false, error: 'No valid fields' });
    // template_data is JSONB — cast the placeholder so pg stringifies
    // the JS object correctly. Other columns pass through as text/bool.
    const setClauses = fields.map((f, i) => `${f} = $${i + 2}${f === 'template_data' ? '::jsonb' : ''}`);
    const values = fields.map(f => {
      const v = req.body[f];
      if (f === 'template_data') {
        return (v && typeof v === 'object' && !Array.isArray(v)) ? JSON.stringify(v) : null;
      }
      if (f === 'template_id') {
        return (typeof v === 'string' && /^[a-z0-9_-]{1,64}$/.test(v)) ? v : 'standard';
      }
      return v;
    });
    const { rows } = await pool.query(
      `UPDATE boom_ndas SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      [req.params.id, ...values]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'NDA not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE NDA
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM boom_ndas WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
