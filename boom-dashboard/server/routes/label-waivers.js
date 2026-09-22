// market.st Label Waivers — short side-letter documents waiving market.st's
// exclusivity so a market.st-signed artist can appear as co-primary on
// another label's release. CRUD mirror of routes/ndas.js — PDF
// rendering still lives client-side via jsPDF, but the client now
// posts the generated PDF alongside the form values on save. The
// server attaches the PDF to entity_files (entity_type='artist')
// so the waiver shows up on the artist's Documents tab without any
// extra step. Mirrors the artist_clearances integration pattern.

const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const secureFileFilter = require('../middleware/secureUpload').secureFileFilter;
const { uploadFile, deleteFile } = require('../lib/r2');

router.use(authMiddleware);

// 10 MB cap matches the secureUpload defaults elsewhere; a one-page
// label-waiver PDF is well under 1 MB so this is plenty of headroom.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: secureFileFilter,
});

// Parse the multipart `payload` JSON field into a regular object. Falls
// back to req.body when there's no multipart wrapper (json-only POST,
// kept for backwards compat with any older client / mocks).
function parsePayload(req) {
  if (req.body && typeof req.body.payload === 'string') {
    try { return JSON.parse(req.body.payload); } catch { return {}; }
  }
  return req.body || {};
}

// Best-match artist lookup by name. Case-insensitive, exact-only —
// fuzzier matching here would risk attaching a waiver to the wrong
// artist's Documents tab, which is worse than failing silently to
// attach. Returns null when no exact match (we still save the waiver,
// just without the Documents-tab link).
async function lookupArtistId(boomArtist) {
  if (!boomArtist) return null;
  const { rows } = await pool.query(
    'SELECT id FROM artists WHERE LOWER(name) = LOWER($1) LIMIT 1',
    [String(boomArtist).trim()]
  );
  return rows.length ? rows[0].id : null;
}

// Attach the PDF buffer to entity_files for the given artist. If a
// prior file_id exists, replace it in place (delete the old R2 object
// + update the row) so the Documents tab doesn't accumulate stale
// copies. Returns the entity_files row id.
async function attachPdfToArtist({ artistId, fileBuffer, filename, existingFileId, userId }) {
  if (!artistId || !fileBuffer) return null;
  const sanitized = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
  const stored = `${Date.now()}-${sanitized}`;
  const r2Key = `entity_files/artist/${artistId}/${stored}`;
  const mime = 'application/pdf';
  await uploadFile(r2Key, fileBuffer, mime);

  if (existingFileId) {
    const { rows: priorRows } = await pool.query(
      'SELECT r2_key FROM entity_files WHERE id = $1', [existingFileId]
    );
    if (priorRows.length && priorRows[0].r2_key) {
      try { await deleteFile(priorRows[0].r2_key); } catch (e) {
        console.warn('label-waiver: prior R2 delete failed:', e.message);
      }
    }
    await pool.query(
      `UPDATE entity_files
          SET filename = $1, original_name = $2, file_size = $3,
              r2_key = $4, mime_type = $5, uploaded_at = NOW()
        WHERE id = $6`,
      [stored, filename, fileBuffer.length, r2Key, mime, existingFileId]
    );
    return existingFileId;
  }

  const ins = await pool.query(
    `INSERT INTO entity_files
       (entity_type, entity_id, filename, original_name, file_size,
        uploaded_by, r2_key, mime_type, label)
     VALUES ('artist', $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [artistId, stored, filename, fileBuffer.length, userId || null, r2Key, mime, 'Label Waiver']
  );
  return ins.rows[0].id;
}

// GET all label waivers — most recent first.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM boom_label_waivers ORDER BY created_at DESC, id DESC'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST create label waiver. Multipart: `file` is the generated PDF,
// `payload` is the JSON form data string. The PDF gets attached to
// the artist's Documents tab via entity_files when the boom_artist
// name resolves to a known artist.
router.post('/', upload.single('file'), async (req, res) => {
  try {
    const body = parsePayload(req);
    const {
      effective_date, boom_artist, releasing_label, other_label_artist,
      song_title, release_date, release_format, royalty_percent,
      contact_email, signatory_name, signatory_title, custom_body,
    } = body;

    if (!effective_date || !boom_artist || !releasing_label || !song_title) {
      return res.status(400).json({
        success: false,
        error: 'effective_date, boom_artist, releasing_label, and song_title are required',
      });
    }

    const artistId = await lookupArtistId(boom_artist);
    let fileId = null;
    if (artistId && req.file) {
      fileId = await attachPdfToArtist({
        artistId,
        fileBuffer: req.file.buffer,
        filename: req.file.originalname || 'label-waiver.pdf',
        existingFileId: null,
        userId: req.user?.id,
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO boom_label_waivers
         (effective_date, boom_artist, releasing_label, other_label_artist,
          song_title, release_date, release_format, royalty_percent,
          contact_email, signatory_name, signatory_title, custom_body,
          artist_id, file_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [
        effective_date, boom_artist, releasing_label, other_label_artist || null,
        song_title, release_date || null, release_format || null, royalty_percent || null,
        contact_email || null, signatory_name || null, signatory_title || null, custom_body || null,
        artistId, fileId,
        req.user?.name || 'Unknown',
      ]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /api/label-waivers:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT update — multipart same as POST. Re-resolves artist_id from the
// (possibly updated) boom_artist name; if it points at a different
// artist than the saved file_id sits on, the old entity_files row is
// dropped + a new one created on the new artist. Otherwise the existing
// row is updated in place.
router.put('/:id', upload.single('file'), async (req, res) => {
  try {
    const allowed = [
      'effective_date', 'boom_artist', 'releasing_label', 'other_label_artist',
      'song_title', 'release_date', 'release_format', 'royalty_percent',
      'contact_email', 'signatory_name', 'signatory_title', 'custom_body',
    ];
    const body = parsePayload(req);
    const fields = Object.keys(body).filter(k => allowed.includes(k));
    if (!fields.length && !req.file) return res.status(400).json({ success: false, error: 'No valid fields' });

    const { rows: prior } = await pool.query(
      'SELECT artist_id, file_id, boom_artist FROM boom_label_waivers WHERE id = $1',
      [req.params.id]
    );
    if (!prior.length) return res.status(404).json({ success: false, error: 'Label waiver not found' });

    // Recompute artist_id whenever boom_artist appears in the patch.
    let newArtistId = prior[0].artist_id;
    if (Object.prototype.hasOwnProperty.call(body, 'boom_artist')) {
      newArtistId = await lookupArtistId(body.boom_artist);
    }

    // Handle the attached PDF — drop old if artist changed, otherwise
    // update in place.
    let newFileId = prior[0].file_id;
    if (req.file) {
      let existingFileId = prior[0].file_id;
      if (newArtistId !== prior[0].artist_id && existingFileId) {
        try {
          const { rows: efRows } = await pool.query('SELECT r2_key FROM entity_files WHERE id = $1', [existingFileId]);
          if (efRows.length && efRows[0].r2_key) await deleteFile(efRows[0].r2_key);
          await pool.query('DELETE FROM entity_files WHERE id = $1', [existingFileId]);
        } catch (e) { console.warn('label-waiver: drop prior file failed:', e.message); }
        existingFileId = null;
      }
      if (newArtistId) {
        newFileId = await attachPdfToArtist({
          artistId: newArtistId,
          fileBuffer: req.file.buffer,
          filename: req.file.originalname || 'label-waiver.pdf',
          existingFileId,
          userId: req.user?.id,
        });
      } else {
        // No artist to attach to — drop any prior file from the
        // previous artist so it doesn't linger.
        if (existingFileId) {
          try {
            const { rows: efRows } = await pool.query('SELECT r2_key FROM entity_files WHERE id = $1', [existingFileId]);
            if (efRows.length && efRows[0].r2_key) await deleteFile(efRows[0].r2_key);
            await pool.query('DELETE FROM entity_files WHERE id = $1', [existingFileId]);
          } catch (e) { console.warn('label-waiver: orphan-file cleanup failed:', e.message); }
        }
        newFileId = null;
      }
    } else if (newArtistId !== prior[0].artist_id && prior[0].file_id) {
      // Artist changed but no new PDF supplied — drop the prior file
      // so the old artist's Documents tab isn't lying.
      try {
        const { rows: efRows } = await pool.query('SELECT r2_key FROM entity_files WHERE id = $1', [prior[0].file_id]);
        if (efRows.length && efRows[0].r2_key) await deleteFile(efRows[0].r2_key);
        await pool.query('DELETE FROM entity_files WHERE id = $1', [prior[0].file_id]);
      } catch (e) { console.warn('label-waiver: artist-change cleanup failed:', e.message); }
      newFileId = null;
    }

    // Build the UPDATE setting only the allow-listed columns the
    // payload included, plus the recomputed artist_id / file_id.
    const setClauses = fields.map((f, i) => `${f} = $${i + 2}`);
    const values = fields.map(f => body[f]);
    setClauses.push(`artist_id = $${values.length + 2}`); values.push(newArtistId);
    setClauses.push(`file_id = $${values.length + 2}`);   values.push(newFileId);

    const { rows } = await pool.query(
      `UPDATE boom_label_waivers SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      [req.params.id, ...values]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('PUT /api/label-waivers/:id:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE label waiver + its attached entity_file (so the Documents
// tab gets cleaned up too).
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT file_id FROM boom_label_waivers WHERE id = $1',
      [req.params.id]
    );
    if (rows.length && rows[0].file_id) {
      try {
        const { rows: efRows } = await pool.query('SELECT r2_key FROM entity_files WHERE id = $1', [rows[0].file_id]);
        if (efRows.length && efRows[0].r2_key) await deleteFile(efRows[0].r2_key);
        await pool.query('DELETE FROM entity_files WHERE id = $1', [rows[0].file_id]);
      } catch (e) { console.warn('label-waiver: delete cleanup failed:', e.message); }
    }
    await pool.query('DELETE FROM boom_label_waivers WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
