const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { uploadFile, deleteFile } = require('../lib/r2');

const router = express.Router();

const { BLOCKED_EXTENSIONS } = require('../middleware/secureUpload');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  // The vault legitimately stores more formats than secureFileFilter's
  // MIME allowlist covers (docx, txt, ...), so gate on the shared
  // dangerous-extension blocklist instead — rejects executables,
  // scripts, and HTML/SVG (stored-XSS vectors when served from our
  // origin). This route previously had NO filter at all.
  fileFilter: (req, file, cb) => {
    // Strip trailing dots/whitespace first — 'payload.html ' or
    // 'payload.html.' would otherwise slip past the extension check.
    const cleaned = String(file.originalname || '').replace(/[.\s]+$/, '');
    const ext = '.' + (cleaned.split('.').pop() || '').toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
      return cb(new Error(`File type ${ext} is not allowed`), false);
    }
    cb(null, true);
  },
});

// All admin-doc endpoints are admin-gated. Restricted-confidentiality rows
// further require Superadmin — enforced inline per-query.
const isAdmin = (user) => {
  const r = (user?.role || '').toLowerCase();
  return r === 'admin' || r === 'superadmin';
};
const isSuperadmin = (user) => (user?.role || '').toLowerCase() === 'superadmin';

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin access required' });
  next();
}
router.use(authMiddleware, requireAdmin);

// Filter clause: hide Restricted rows from non-superadmins.
const restrictedClause = (req) => isSuperadmin(req.user) ? '' : `AND confidentiality <> 'Restricted'`;

// ── List ─────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, u.name AS created_by_name,
              (SELECT COUNT(*) FROM entity_files ef
                WHERE ef.entity_type = 'admin_document' AND ef.entity_id = d.id) AS file_count
         FROM admin_documents d
         LEFT JOIN users u ON u.id = d.created_by
        WHERE 1=1 ${restrictedClause(req)}
        ORDER BY d.updated_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('admin-docs list error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Expiring (within 60d) — drives the banner + dashboard notifications ──────
router.get('/expiring', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, category, counterparty, expiration_date,
              (expiration_date - CURRENT_DATE) AS days_left
         FROM admin_documents
        WHERE expiration_date IS NOT NULL
          AND expiration_date > CURRENT_DATE
          AND expiration_date <= CURRENT_DATE + INTERVAL '60 days'
          AND (status IS NULL OR status NOT IN ('Archived', 'Expired'))
          ${restrictedClause(req)}
        ORDER BY expiration_date ASC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('admin-docs expiring error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Single doc ───────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, u.name AS created_by_name
         FROM admin_documents d
         LEFT JOIN users u ON u.id = d.created_by
        WHERE d.id = $1 ${restrictedClause(req)}`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('admin-docs get error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Create ───────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      title, category, counterparty, status, confidentiality,
      date_signed, expiration_date, tags, notes, is_template,
    } = req.body;
    if (!title) return res.status(400).json({ success: false, error: 'title required' });
    if (confidentiality === 'Restricted' && !isSuperadmin(req.user)) {
      return res.status(403).json({ success: false, error: 'Only Superadmin can create Restricted docs' });
    }
    const { rows } = await pool.query(
      `INSERT INTO admin_documents
         (title, category, counterparty, status, confidentiality,
          date_signed, expiration_date, tags, notes, is_template, created_by)
       VALUES ($1, $2, $3, COALESCE($4, 'Active'), COALESCE($5, 'Internal'),
               $6, $7, COALESCE($8, '[]'::jsonb), $9, COALESCE($10, false), $11)
       RETURNING *`,
      [
        title, category, counterparty || null,
        status || null, confidentiality || null,
        date_signed || null, expiration_date || null,
        tags ? JSON.stringify(tags) : null,
        notes || null,
        !!is_template,
        req.user?.id || null,
      ]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('admin-docs create error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Update ───────────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    // Block non-superadmins from touching a Restricted row at all.
    const existing = await pool.query(
      `SELECT confidentiality FROM admin_documents WHERE id = $1`,
      [req.params.id]
    );
    if (!existing.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    if (existing.rows[0].confidentiality === 'Restricted' && !isSuperadmin(req.user)) {
      return res.status(403).json({ success: false, error: 'Restricted — Superadmin required' });
    }
    if (req.body.confidentiality === 'Restricted' && !isSuperadmin(req.user)) {
      return res.status(403).json({ success: false, error: 'Only Superadmin can mark Restricted' });
    }

    const {
      title, category, counterparty, status, confidentiality,
      date_signed, expiration_date, tags, notes, is_template,
    } = req.body;
    const { rows } = await pool.query(
      `UPDATE admin_documents SET
         title           = COALESCE($1, title),
         category        = COALESCE($2, category),
         counterparty    = COALESCE($3, counterparty),
         status          = COALESCE($4, status),
         confidentiality = COALESCE($5, confidentiality),
         date_signed     = COALESCE($6, date_signed),
         expiration_date = COALESCE($7, expiration_date),
         tags            = COALESCE($8, tags),
         notes           = COALESCE($9, notes),
         is_template     = COALESCE($10, is_template),
         updated_at      = NOW()
       WHERE id = $11
       RETURNING *`,
      [
        title ?? null, category ?? null, counterparty ?? null,
        status ?? null, confidentiality ?? null,
        date_signed ?? null, expiration_date ?? null,
        tags ? JSON.stringify(tags) : null,
        notes ?? null,
        typeof is_template === 'boolean' ? is_template : null,
        req.params.id,
      ]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('admin-docs update error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Delete (hard delete — file rows cascade via entity_files cleanup below) ──
router.delete('/:id', async (req, res) => {
  try {
    const existing = await pool.query(
      `SELECT confidentiality FROM admin_documents WHERE id = $1`,
      [req.params.id]
    );
    if (!existing.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    if (existing.rows[0].confidentiality === 'Restricted' && !isSuperadmin(req.user)) {
      return res.status(403).json({ success: false, error: 'Restricted — Superadmin required' });
    }

    // Best-effort R2 cleanup before deleting metadata rows.
    const { rows: files } = await pool.query(
      `SELECT r2_key FROM entity_files WHERE entity_type = 'admin_document' AND entity_id = $1`,
      [req.params.id]
    );
    for (const f of files) {
      if (f.r2_key) deleteFile(f.r2_key).catch(e => console.warn('R2 delete failed:', e.message));
    }
    await pool.query(`DELETE FROM entity_files WHERE entity_type = 'admin_document' AND entity_id = $1`, [req.params.id]);
    await pool.query(`DELETE FROM admin_documents WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('admin-docs delete error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── File attachments (FilesPanel-compatible) ─────────────────────────────────
// FilesPanel speaks: GET /:id/files · POST /:id/files (multipart 'file') · DELETE /:id/files/:fileId

router.get('/:id/files', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ef.id, ef.entity_type, ef.entity_id, ef.filename, ef.original_name,
              ef.file_size, ef.uploaded_by, ef.uploaded_at, ef.label, ef.mime_type,
              u.name AS uploaded_by_name
         FROM entity_files ef
         LEFT JOIN users u ON ef.uploaded_by = u.id
        WHERE ef.entity_type = 'admin_document' AND ef.entity_id = $1
        ORDER BY ef.uploaded_at DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('admin-docs files list error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/:id/files', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    const timestamp = Date.now();
    const sanitized = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storedFilename = `${timestamp}-${sanitized}`;
    const r2Key = `entity_files/admin_document/${req.params.id}/${storedFilename}`;

    await uploadFile(r2Key, req.file.buffer, req.file.mimetype);

    const { rows } = await pool.query(
      `INSERT INTO entity_files (entity_type, entity_id, filename, original_name, file_size, uploaded_by, r2_key, mime_type)
       VALUES ('admin_document', $1, $2, $3, $4, $5, $6, $7)
       RETURNING id, entity_type, entity_id, filename, original_name, file_size, uploaded_by, uploaded_at, label, mime_type`,
      [req.params.id, storedFilename, req.file.originalname, req.file.size, req.user?.id || null, r2Key, req.file.mimetype]
    );

    // Bump updated_at so the parent doc sorts to the top.
    await pool.query(`UPDATE admin_documents SET updated_at = NOW() WHERE id = $1`, [req.params.id]);

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('admin-docs file upload error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.delete('/:id/files/:fileId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM entity_files
        WHERE id = $1 AND entity_type = 'admin_document' AND entity_id = $2
        RETURNING *`,
      [req.params.fileId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'File not found' });
    if (rows[0].r2_key) deleteFile(rows[0].r2_key).catch(e => console.warn('R2 delete failed:', e.message));
    res.json({ success: true });
  } catch (err) {
    console.error('admin-docs file delete error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
