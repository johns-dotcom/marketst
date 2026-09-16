// Artist Clearance Chart routes.
//
// Each clearance ties to a specific artist + holds the structured form
// values (project metadata + a JSONB array of tracks, each with the 17
// per-track sub-fields the template requires). On every save we:
//   1) generate an XLSX from server/templates/artist-clearance.xlsx
//      (template approach — the user's source file is the styling source
//      of truth, identical strategy to the BK Excel export)
//   2) upload the XLSX to R2 via entity_files (entity_type='artist'),
//      so the artist's Documents tab surfaces the file automatically
//   3) save the artist_clearances row with file_id pointing at that
//      entity_files row so subsequent updates can replace it cleanly.

const express = require('express');
const router = express.Router();
const path = require('path');
const ExcelJS = require('exceljs');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { uploadFile, deleteFile } = require('../lib/r2');

router.use(authMiddleware);

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'artist-clearance.xlsx');

// ── Template layout constants ──────────────────────────────────────────
// Row numbers + column numbers of every cell the generator writes. Pulled
// straight from the user's source workbook (inspected once); keeping them
// here as named constants beats magic numbers scattered through the file.
const TRACK_BLOCK_ROWS = 17;        // primary row + 16 sub-rows
const FIRST_TRACK_ROW = 15;
const SUB_LABEL_COL = 3;            // "ISRC:", "Timing:", ... live in col C
const SUB_VALUE_COL = 4;            // values in col D

// Order of the 16 sub-fields on each track block (rows 16-31 in the template).
const SUB_FIELDS = [
  { key: 'isrc',                 label: 'ISRC:' },
  { key: 'timing',               label: 'Timing:' },
  { key: 'explicit',             label: 'Clean or Explicit:' },
  { key: 'samples_ai',           label: 'Samples/AI [yes/no]:' },
  { key: 'produced_by',          label: 'Produced by:' },
  { key: 'musician_credits',     label: 'Musician Credits:' },
  { key: 'recorded_by',          label: 'Recorded by:' },
  { key: 'mixed_by',             label: 'Mixed by:' },
  { key: 'mastered_by',          label: 'Mastered by:' },
  { key: 'writers',              label: 'Writers (full names):' },
  { key: 'publishing_splits',    label: 'Publishing splits:' },
  { key: 'publishers',           label: 'Publishers:' },
  { key: 'lyrics',               label: 'Lyrics' },
  { key: 'stems_masters',        label: 'Stems/Masters?' },
  { key: 'artwork',              label: 'Artwork?' },
  { key: 'credits_approved',     label: 'Credits Approved?' },
];

// Primary-row columns (row 15 in the template, then offset for additional
// tracks). The "label" form key drives the value written into each column.
const PRIMARY_COLS = [
  { col: 1,  key: 'track_number' },
  { col: 2,  key: 'title' },
  { col: 3,  key: 'role' },
  { col: 4,  key: 'credit' },
  { col: 5,  key: 'docs_needed' },
  { col: 6,  key: 'sample_review' },
  { col: 7,  key: 'release_date' },
  { col: 9,  key: 'royalty_comments' },
  { col: 11, key: 'royalty_rate' },
  { col: 13, key: 'royalty_account' },
  { col: 15, key: 'advance' },
  { col: 17, key: 'recoupable_portion' },
  { col: 19, key: 'agreement_on_file' },
];

// Build the populated workbook buffer. Loads the bundled template as a
// styling source so the user's exact column widths, fonts, fills, and
// merges carry through — no need to recreate any of that in code.
async function buildClearanceWorkbook({ form, artistName }) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE_PATH);
  const ws = wb.getWorksheet('Sheet1') || wb.worksheets[0];

  // ── Header metadata (rows 1-12) ──────────────────────────────────────
  // Replace the placeholder text with form values. The template ships these
  // cells with prefix labels ("Title: ", "Project #", etc.) baked into the
  // string; we mirror that so the rendered look is identical.
  ws.getCell(1, 1).value  = `Artist Name: ${artistName || ''}`;
  ws.getCell(2, 1).value  = 'Document List';
  ws.getCell(3, 1).value  = form.effective_date ? new Date(form.effective_date) : null;
  ws.getCell(5, 1).value  = `Contractual Members: ${form.contractual_members || ''}`;
  ws.getCell(7, 1).value  = `Project #: ${form.project_number || ''}`;
  ws.getCell(8, 1).value  = `Title: ${form.title || ''}`;
  ws.getCell(9, 1).value  = `Product Committment: ${form.product_commitment || ''}`;
  ws.getCell(11, 1).value = `Main Artist Royalty Account: ${form.main_artist_royalty_account || ''}`;
  ws.getCell(12, 1).value = `Artist Royalty Rate: ${form.artist_royalty_rate || ''}`;

  // ── Capture the track-block template (rows 15-31) BEFORE we modify it,
  // so additional tracks can reuse the styling + sub-row labels. The first
  // track overwrites the existing block; subsequent tracks get new rows
  // appended with this captured style applied per cell.
  const trackTemplate = [];
  for (let dr = 0; dr < TRACK_BLOCK_ROWS; dr++) {
    const rowTpl = [];
    const row = ws.getRow(FIRST_TRACK_ROW + dr);
    for (let c = 1; c <= 24; c++) {
      const cell = row.getCell(c);
      rowTpl.push({
        value:     cell.value,
        font:      cell.font      ? JSON.parse(JSON.stringify(cell.font))      : null,
        fill:      cell.fill      ? JSON.parse(JSON.stringify(cell.fill))      : null,
        border:    cell.border    ? JSON.parse(JSON.stringify(cell.border))    : null,
        alignment: cell.alignment ? JSON.parse(JSON.stringify(cell.alignment)) : null,
        numFmt:    cell.numFmt,
      });
    }
    trackTemplate.push(rowTpl);
  }

  // ── Write each track block ──────────────────────────────────────────
  const tracks = Array.isArray(form.tracks) ? form.tracks : [];
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i] || {};
    const startRow = FIRST_TRACK_ROW + i * TRACK_BLOCK_ROWS;

    for (let dr = 0; dr < TRACK_BLOCK_ROWS; dr++) {
      const targetRow = startRow + dr;
      const tplRow = trackTemplate[dr];

      for (let c = 1; c <= 24; c++) {
        const tpl = tplRow[c - 1];
        const cell = ws.getCell(targetRow, c);
        if (tpl.font)      cell.font = tpl.font;
        if (tpl.fill)      cell.fill = tpl.fill;
        if (tpl.border)    cell.border = tpl.border;
        if (tpl.alignment) cell.alignment = tpl.alignment;
        if (tpl.numFmt)    cell.numFmt = tpl.numFmt;
      }

      if (dr === 0) {
        // Primary row — clear any leftover template values then write form data.
        ws.getRow(targetRow).eachCell({ includeEmpty: true }, (cell) => { cell.value = null; });
        // Re-apply styling (clearing values wiped some cells on the row).
        for (let c = 1; c <= 24; c++) {
          const tpl = tplRow[c - 1];
          const cell = ws.getCell(targetRow, c);
          if (tpl.font)      cell.font = tpl.font;
          if (tpl.fill)      cell.fill = tpl.fill;
          if (tpl.border)    cell.border = tpl.border;
          if (tpl.alignment) cell.alignment = tpl.alignment;
          if (tpl.numFmt)    cell.numFmt = tpl.numFmt;
        }
        for (const col of PRIMARY_COLS) {
          const raw = col.key === 'track_number' ? (i + 1) : (track[col.key] || '');
          ws.getCell(targetRow, col.col).value = raw === '' ? null : raw;
        }
      } else {
        // Sub-row — label in col 3 from the template, value from form.
        const sub = SUB_FIELDS[dr - 1];
        if (sub) {
          ws.getCell(targetRow, SUB_LABEL_COL).value = sub.label;
          ws.getCell(targetRow, SUB_VALUE_COL).value = (track[sub.key] || 'TBD');
        }
      }
    }
  }

  // If no tracks at all (legal edge case — a freshly-created clearance
  // saved before any track was added), clear the first track block so
  // we don't ship the template's placeholder TBD song.
  if (tracks.length === 0) {
    for (let dr = 0; dr < TRACK_BLOCK_ROWS; dr++) {
      const r = ws.getRow(FIRST_TRACK_ROW + dr);
      r.eachCell({ includeEmpty: true }, (cell, col) => {
        // Keep the sub-row labels in col 3 so the form scaffold reads
        // intact when the bookkeeper opens an empty clearance.
        if (col !== SUB_LABEL_COL || dr === 0) cell.value = null;
      });
    }
  }

  return await wb.xlsx.writeBuffer();
}

// Build a safe, recognisable filename for the generated XLSX.
function buildClearanceFilename(artistName, title) {
  const slug = (s) => String(s || '').replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_').slice(0, 60) || 'untitled';
  const datePart = new Date().toISOString().slice(0, 10);
  return `Clearance-${slug(artistName)}${title ? '-' + slug(title) : ''}-${datePart}.xlsx`;
}

// Generate + upload the XLSX, replacing the previous file_id row in
// entity_files when this is an update. Returns the entity_files row id
// for storage on artist_clearances.file_id.
async function generateAndAttach({ artistId, artistName, form, existingFileId, userId }) {
  if (!artistId) return null;
  const buf = await buildClearanceWorkbook({ form, artistName });
  const original = buildClearanceFilename(artistName, form.title);
  const sanitized = original.replace(/[^a-zA-Z0-9.-]/g, '_');
  const stored = `${Date.now()}-${sanitized}`;
  const r2Key = `entity_files/artist/${artistId}/${stored}`;
  const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  await uploadFile(r2Key, Buffer.from(buf), mime);

  if (existingFileId) {
    // Update the existing entity_files row in place so the Documents tab
    // keeps a single clearance file per chart (instead of accumulating
    // a new one each save). Drop the prior R2 object so storage doesn't
    // bloat over time — failures here are non-fatal.
    const { rows: priorRows } = await pool.query(
      'SELECT r2_key FROM entity_files WHERE id = $1', [existingFileId]
    );
    if (priorRows.length && priorRows[0].r2_key) {
      try { await deleteFile(priorRows[0].r2_key); } catch (e) {
        console.warn('clearance: prior R2 delete failed:', e.message);
      }
    }
    await pool.query(
      `UPDATE entity_files
          SET filename = $1, original_name = $2, file_size = $3,
              r2_key = $4, mime_type = $5, uploaded_at = NOW()
        WHERE id = $6`,
      [stored, original, buf.byteLength, r2Key, mime, existingFileId]
    );
    return existingFileId;
  }

  const ins = await pool.query(
    `INSERT INTO entity_files
       (entity_type, entity_id, filename, original_name, file_size,
        uploaded_by, r2_key, mime_type, label)
     VALUES ('artist', $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [artistId, stored, original, buf.byteLength, userId || null, r2Key, mime, 'Artist Clearance Chart']
  );
  return ins.rows[0].id;
}

// ── Routes ──────────────────────────────────────────────────────────────

// GET /api/clearances/catalog?artist_id=X — lightweight list of an
// artist's releases for the clearance form's autocomplete + bulk-add.
// Pulls only the columns the form can auto-fill onto a track so the
// payload stays small even for artists with hundreds of releases.
// Declared BEFORE /:id so Express doesn't try to treat "catalog" as an id.
router.get('/catalog', async (req, res) => {
  try {
    const artistId = parseInt(req.query.artist_id, 10);
    if (!artistId) return res.status(400).json({ success: false, error: 'artist_id required' });
    const { rows } = await pool.query(`
      SELECT id, project_name, release_date, isrc, producer, featured_artists,
             release_type, genre
        FROM releases
       WHERE artist_id = $1
         AND (archived = false OR archived IS NULL)
       ORDER BY release_date DESC NULLS LAST, project_name ASC
    `, [artistId]);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /api/clearances/catalog:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/clearances — list, most recent first, with the artist name
// joined in so the page table can show it without an extra fetch.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, a.name AS artist_name,
             ef.id AS file_entity_id, ef.original_name AS file_filename
        FROM artist_clearances c
        LEFT JOIN artists a       ON a.id  = c.artist_id
        LEFT JOIN entity_files ef ON ef.id = c.file_id
       ORDER BY c.created_at DESC, c.id DESC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /api/clearances:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/clearances/:id — single clearance, full form data + tracks.
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, a.name AS artist_name
        FROM artist_clearances c
        LEFT JOIN artists a ON a.id = c.artist_id
       WHERE c.id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Clearance not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('GET /api/clearances/:id:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/clearances — create. Generates the XLSX, attaches it to the
// artist's Documents tab via entity_files, saves the structured row.
router.post('/', async (req, res) => {
  try {
    const f = req.body || {};
    if (!f.artist_id) return res.status(400).json({ success: false, error: 'artist_id required' });
    const { rows: artistRows } = await pool.query('SELECT id, name FROM artists WHERE id = $1', [f.artist_id]);
    if (!artistRows.length) return res.status(404).json({ success: false, error: 'Artist not found' });
    const artistName = artistRows[0].name;

    const fileId = await generateAndAttach({
      artistId: f.artist_id,
      artistName,
      form: f,
      existingFileId: null,
      userId: req.user?.id,
    });

    const { rows } = await pool.query(`
      INSERT INTO artist_clearances
        (artist_id, title, project_number, product_commitment, contractual_members,
         effective_date, main_artist_royalty_account, artist_royalty_rate,
         tracks, file_id, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11) RETURNING *`,
      [
        f.artist_id, f.title || null, f.project_number || null,
        f.product_commitment || null, f.contractual_members || null,
        f.effective_date || null,
        f.main_artist_royalty_account || null, f.artist_royalty_rate || null,
        JSON.stringify(f.tracks || []),
        fileId,
        req.user?.name || 'Unknown',
      ]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /api/clearances:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/clearances/:id — update + regenerate XLSX. Updates the same
// entity_files row in place when one exists so the Documents tab doesn't
// accumulate stale copies.
router.put('/:id', async (req, res) => {
  try {
    const f = req.body || {};
    const { rows: existRows } = await pool.query(
      'SELECT artist_id, file_id FROM artist_clearances WHERE id = $1', [req.params.id]
    );
    if (!existRows.length) return res.status(404).json({ success: false, error: 'Clearance not found' });

    const artistId = f.artist_id || existRows[0].artist_id;
    const { rows: artistRows } = await pool.query('SELECT name FROM artists WHERE id = $1', [artistId]);
    if (!artistRows.length) return res.status(404).json({ success: false, error: 'Artist not found' });
    const artistName = artistRows[0].name;

    // If the artist changed, the prior file lives on the old artist's
    // entity_files row — drop it and start a new one on the new artist.
    let existingFileId = existRows[0].file_id;
    if (artistId !== existRows[0].artist_id && existingFileId) {
      try { await pool.query('DELETE FROM entity_files WHERE id = $1', [existingFileId]); }
      catch (e) { console.warn('clearance: drop prior entity_file failed:', e.message); }
      existingFileId = null;
    }
    const fileId = await generateAndAttach({
      artistId, artistName, form: f, existingFileId, userId: req.user?.id,
    });

    const { rows } = await pool.query(`
      UPDATE artist_clearances
         SET artist_id = $1, title = $2, project_number = $3,
             product_commitment = $4, contractual_members = $5,
             effective_date = $6,
             main_artist_royalty_account = $7, artist_royalty_rate = $8,
             tracks = $9::jsonb, file_id = $10, updated_at = NOW()
       WHERE id = $11 RETURNING *`,
      [
        artistId, f.title || null, f.project_number || null,
        f.product_commitment || null, f.contractual_members || null,
        f.effective_date || null,
        f.main_artist_royalty_account || null, f.artist_royalty_rate || null,
        JSON.stringify(f.tracks || []),
        fileId,
        req.params.id,
      ]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('PUT /api/clearances/:id:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/clearances/:id — drop the record + its attached entity_file
// so the Documents tab is also cleaned up.
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT file_id FROM artist_clearances WHERE id = $1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Clearance not found' });
    if (rows[0].file_id) {
      // entity_files ON DELETE SET NULL on file_id keeps the artist_clearances
      // FK intact even though we cascade through entity_files; deleting the
      // entity_file row removes it from the Documents tab.
      const { rows: efRows } = await pool.query(
        'SELECT r2_key FROM entity_files WHERE id = $1', [rows[0].file_id]
      );
      if (efRows.length && efRows[0].r2_key) {
        try { await deleteFile(efRows[0].r2_key); } catch (e) {
          console.warn('clearance: R2 delete on clearance-delete failed:', e.message);
        }
      }
      await pool.query('DELETE FROM entity_files WHERE id = $1', [rows[0].file_id]);
    }
    await pool.query('DELETE FROM artist_clearances WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/clearances/:id:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/clearances/:id/download — regenerate + stream the XLSX. We
// rebuild from the saved form data on every download so a stale R2 object
// (rare) can't cause a divergence between the dashboard data and the file.
router.get('/:id/download', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, a.name AS artist_name
        FROM artist_clearances c
        LEFT JOIN artists a ON a.id = c.artist_id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Clearance not found' });
    const r = rows[0];
    const form = {
      title: r.title, project_number: r.project_number,
      product_commitment: r.product_commitment, contractual_members: r.contractual_members,
      effective_date: r.effective_date,
      main_artist_royalty_account: r.main_artist_royalty_account,
      artist_royalty_rate: r.artist_royalty_rate,
      tracks: r.tracks || [],
    };
    const buf = await buildClearanceWorkbook({ form, artistName: r.artist_name });
    const filename = buildClearanceFilename(r.artist_name, r.title);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('GET /api/clearances/:id/download:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
