const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { uploadFile, deleteFile } = require('../lib/r2');
const { postEvent } = require('../lib/activityBot');

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const { secureFileFilter } = require('../middleware/secureUpload');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: secureFileFilter,
});

// GET /api/deals
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { stage } = req.query;
    let query = 'SELECT * FROM deals WHERE 1=1';
    const params = [];

    if (stage) {
      query += ` AND stage = $${params.length + 1}`;
      params.push(stage);
    }

    query += ' ORDER BY added_date DESC';

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error('Get deals error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

const PRIORITIES = ['High', 'Medium', 'Low'];
const DEAL_TYPES = ['360 Deal', 'Master License', 'Single License', 'Distribution', 'Publishing', 'Other'];

// POST /api/deals
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { artist_name, genre, stage, ar_rep, source, notes, priority, deal_type } = req.body;

    if (!artist_name || !stage) {
      return res.status(400).json({ success: false, error: 'Artist name and stage required' });
    }
    if (priority && !PRIORITIES.includes(priority)) {
      return res.status(400).json({ success: false, error: 'Invalid priority' });
    }
    if (deal_type && !DEAL_TYPES.includes(deal_type)) {
      return res.status(400).json({ success: false, error: 'Invalid deal_type' });
    }

    const result = await pool.query(
      `
      INSERT INTO deals (artist_name, genre, stage, ar_rep, source, notes, priority, deal_type, added_date, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'Medium'), $8, CURRENT_DATE, NOW(), NOW())
      RETURNING *
      `,
      [artist_name, genre || null, stage, ar_rep || null, source || null, notes || null, priority || null, deal_type || null]
    );

    res.status(201).json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Create deal error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/deals/:id
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      artist_name, genre, stage, ar_rep, source, notes,
      last_contact_date, next_followup_date, priority,
      spotify_monthly_listeners, deal_type, offer_amount,
    } = req.body;

    if (priority !== undefined && priority !== null && !PRIORITIES.includes(priority)) {
      return res.status(400).json({ success: false, error: 'Invalid priority' });
    }
    if (deal_type !== undefined && deal_type !== null && deal_type !== '' && !DEAL_TYPES.includes(deal_type)) {
      return res.status(400).json({ success: false, error: 'Invalid deal_type' });
    }

    // The stage BEFORE the write, so the activity feed can report a
    // transition rather than a value. The UPDATE below is all COALESCE, so the
    // returned row cannot tell us whether `stage` actually moved — without this
    // read, saving a deal's notes would announce a stage change every time.
    let previousStage = null;
    if (stage !== undefined && stage !== null && stage !== '') {
      const prior = await pool.query('SELECT stage FROM deals WHERE id = $1', [id]);
      previousStage = prior.rows[0]?.stage ?? null;
    }

    // Use a NULL sentinel so callers can intentionally clear a field by
    // passing null; COALESCE on the right side preserves untouched columns
    // (the field key being absent on req.body comes through as undefined,
    // which we normalize to undefined → the column keeps its current value).
    const norm = v => (v === undefined ? undefined : v === '' ? null : v);

    const result = await pool.query(
      `
      UPDATE deals
      SET artist_name               = COALESCE($1, artist_name),
          genre                     = COALESCE($2, genre),
          stage                     = COALESCE($3, stage),
          ar_rep                    = COALESCE($4, ar_rep),
          source                    = COALESCE($5, source),
          notes                     = COALESCE($6, notes),
          last_contact_date         = COALESCE($7::date, last_contact_date),
          next_followup_date        = COALESCE($8::date, next_followup_date),
          priority                  = COALESCE($9, priority),
          spotify_monthly_listeners = COALESCE($10::integer, spotify_monthly_listeners),
          deal_type                 = COALESCE($11, deal_type),
          offer_amount              = COALESCE($12::numeric, offer_amount),
          updated_at                = NOW()
      WHERE id = $13
      RETURNING *
      `,
      [
        norm(artist_name), norm(genre), norm(stage), norm(ar_rep), norm(source), norm(notes),
        norm(last_contact_date), norm(next_followup_date), norm(priority),
        norm(spotify_monthly_listeners), norm(deal_type), norm(offer_amount),
        id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Deal not found' });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });

    const newStage = result.rows[0].stage;
    if (previousStage !== null && newStage && newStage !== previousStage) {
      const signed = String(newStage).toLowerCase() === 'signed';
      postEvent({
        text: signed
          ? `🎉 *${result.rows[0].artist_name}* is *Signed*`
          : `*${result.rows[0].artist_name}* moved to *${newStage}*`,
        icon: signed ? 'party' : 'trending-up',
        link: '/deals',
      }).catch(e => console.error('[activityBot] event dropped:', e.message));
    }
  } catch (error) {
    console.error('Update deal error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/deals/:id
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM deals WHERE id = $1 RETURNING id', [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Deal not found' });
    }

    res.json({
      success: true,
      data: { id: result.rows[0].id },
    });
  } catch (error) {
    console.error('Delete deal error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/deals/:id/files
router.post('/:id/files', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    // Verify deal exists
    const dealCheck = await pool.query('SELECT id FROM deals WHERE id = $1', [req.params.id]);
    if (!dealCheck.rows.length) {
      return res.status(404).json({ success: false, error: 'Deal not found' });
    }
    const sanitized = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storedFilename = `${Date.now()}-${sanitized}`;
    const r2Key = `entity_files/deal/${req.params.id}/${storedFilename}`;
    await uploadFile(r2Key, req.file.buffer, req.file.mimetype);
    const result = await pool.query(
      `INSERT INTO entity_files (entity_type, entity_id, filename, original_name, file_size, uploaded_by, r2_key, mime_type)
       VALUES ('deal', $1, $2, $3, $4, $5, $6, $7)
       RETURNING id, entity_type, entity_id, filename, original_name, file_size, uploaded_by, uploaded_at, label`,
      [req.params.id, storedFilename, req.file.originalname, req.file.size, req.user?.id || null, r2Key, req.file.mimetype]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Upload deal file error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/deals/:id/files
router.get('/:id/files', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      // Metadata only — ef.file_data (base64 blob) served via download route.
      `SELECT ef.id, ef.entity_type, ef.entity_id, ef.filename, ef.original_name,
              ef.file_size, ef.uploaded_by, ef.uploaded_at, ef.label, ef.mime_type,
              u.name as uploaded_by_name
       FROM entity_files ef
       LEFT JOIN users u ON ef.uploaded_by = u.id
       WHERE ef.entity_type = 'deal' AND ef.entity_id = $1
       ORDER BY ef.uploaded_at DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get deal files error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/deals/:id/files/:fileId
router.delete('/:id/files/:fileId', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM entity_files WHERE id = $1 AND entity_type = 'deal' AND entity_id = $2 RETURNING *`,
      [req.params.fileId, req.params.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }
    if (result.rows[0].r2_key) {
      deleteFile(result.rows[0].r2_key).catch(err => console.warn('R2 delete failed:', err.message));
    }
    fs.unlink(path.join(UPLOADS_DIR, result.rows[0].filename), (err) => {
      if (err) console.warn('Could not delete file from disk:', result.rows[0].filename);
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete deal file error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
