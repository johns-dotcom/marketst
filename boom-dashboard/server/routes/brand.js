// Brand assets — the label's logos and photos, one shared library.
//
//   GET    /brand            everyone signed in: the list, newest first
//   POST   /brand            everyone signed in: one file + a category (logo · photo · other)
//   DELETE /brand/:id        the person who uploaded it, or an Admin/Superadmin
//
// Stored as entity_files rows (entity_type 'brand', entity_id 1, label = the
// category) so they download through the same /uploads/:filename route every
// other attachment uses — which forces SVG and unknown types to download
// rather than render, so a logo file can never run script on our origin.
// Bytes go to R2 when it is configured, else to the legacy file_data column
// (dev has no bucket).
const express = require('express');
const multer = require('multer');
const path = require('path');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const r2 = require('../lib/r2');

const router = express.Router();
const CATEGORIES = new Set(['logo', 'photo', 'other']);
// Brand files are design assets: vector logos included. SVG/AI/EPS/ZIP are
// allowed here (not in secureFileFilter) because /uploads serves them as
// attachments only. HTML and scripts stay out.
const EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', '.ai', '.eps', '.zip', '.tif', '.tiff']);
const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.ai': 'application/postscript', '.eps': 'application/postscript', '.zip': 'application/zip', '.tif': 'image/tiff', '.tiff': 'image/tiff' };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!EXT.has(ext)) return cb(new Error(`${ext || 'that file type'} is not a brand asset type (png, jpg, gif, webp, svg, pdf, ai, eps, zip)`), false);
    cb(null, true);
  },
});
const isAdmin = (r) => r === 'Admin' || r === 'Superadmin';

router.get('/', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ef.id, ef.filename, ef.original_name, ef.file_size, ef.mime_type, ef.label AS category, ef.uploaded_at, ef.uploaded_by,
              u.name AS uploaded_by_name
         FROM entity_files ef LEFT JOIN users u ON u.id = ef.uploaded_by
        WHERE ef.entity_type = 'brand'
        ORDER BY ef.uploaded_at DESC, ef.id DESC`);
    res.json({ success: true, data: rows });
  } catch (err) { console.error('brand list error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

router.post('/', authMiddleware, (req, res, next) => upload.single('file')(req, res, (err) => (err ? res.status(400).json({ success: false, error: err.message }) : next())), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    const category = CATEGORIES.has(String(req.body?.category || '').toLowerCase()) ? String(req.body.category).toLowerCase() : 'other';
    const ext = path.extname(req.file.originalname).toLowerCase();
    const mime = MIME_BY_EXT[ext] || req.file.mimetype || 'application/octet-stream';
    const sanitized = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storedFilename = `brand-${Date.now()}-${sanitized}`;
    let r2Key = null, fileData = null;
    if (r2.isConfigured()) {
      r2Key = `entity_files/brand/${storedFilename}`;
      await r2.uploadFile(r2Key, req.file.buffer, mime);
    } else {
      fileData = req.file.buffer.toString('base64');
    }
    const { rows: [row] } = await pool.query(
      `INSERT INTO entity_files (entity_type, entity_id, filename, original_name, file_size, uploaded_by, r2_key, mime_type, label, file_data)
       VALUES ('brand', 1, $1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, filename, original_name, file_size, mime_type, label AS category, uploaded_at, uploaded_by`,
      [storedFilename, req.file.originalname, req.file.size, req.user?.id || null, r2Key, mime, category, fileData]);
    res.status(201).json({ success: true, data: { ...row, uploaded_by_name: req.user?.name || null } });
  } catch (err) { console.error('brand upload error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

router.delete('/:id(\\d+)', authMiddleware, async (req, res) => {
  try {
    const { rows: [f] } = await pool.query(`SELECT id, uploaded_by, r2_key FROM entity_files WHERE id = $1 AND entity_type = 'brand'`, [req.params.id]);
    if (!f) return res.status(404).json({ success: false, error: 'File not found' });
    if (!isAdmin(req.user?.role) && Number(f.uploaded_by) !== Number(req.user?.id)) return res.status(403).json({ success: false, error: 'Only the person who uploaded it, or an admin, can remove it' });
    await pool.query('DELETE FROM entity_files WHERE id = $1', [f.id]);
    if (f.r2_key) r2.deleteFile(f.r2_key).catch((e) => console.warn('brand r2 delete failed:', e.message));
    res.json({ success: true });
  } catch (err) { console.error('brand delete error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

module.exports = router;
