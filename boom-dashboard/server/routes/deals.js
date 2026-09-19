const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { uploadFile, deleteFile } = require('../lib/r2');
const { postEvent } = require('../lib/activityBot');
const { artistBucketKey } = require('../lib/artist-key');

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
// ── Terms and contact, typed on the deal at Offer (2026-09-18) ────────────
// Signing reads these: the contract form is prefilled from them, the roster
// row takes the contact block, the advance becomes an invoice. Typed once.
const TERM_FIELDS = ['advance', 'royalty_split', 'term_months', 'territory', 'num_releases', 'option_periods'];
const CONTACT_FIELDS = ['artist_email', 'artist_phone', 'manager_name', 'manager_email', 'spotify_url'];
const numOrNull = (v) => (v === undefined || v === null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const intOrNull = (v) => { const n = numOrNull(v); return n === null ? null : Math.round(n); };
const strOrNull = (v) => (v === undefined || v === null ? null : (String(v).trim() || null));
// socials: [{platform, handle}] or an object {platform: handle}; stored as JSONB
const socialsOrNull = (v) => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (Array.isArray(v)) {
    const rows = v.map((x) => ({ platform: strOrNull(x?.platform), handle: strOrNull(x?.handle) })).filter((x) => x.platform && x.handle);
    return rows.length ? JSON.stringify(rows) : null;
  }
  if (typeof v === 'object') {
    const rows = Object.entries(v).map(([platform, handle]) => ({ platform: strOrNull(platform), handle: strOrNull(handle) })).filter((x) => x.platform && x.handle);
    return rows.length ? JSON.stringify(rows) : null;
  }
  return null;
};
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || ''));

// ── Signing ───────────────────────────────────────────────────────────────
// What "the deal moved to Signed" DOES, in one transaction and idempotently:
//   1. the roster row — created, or matched by folded name (artistBucketKey,
//      the key every money surface uses); contact fields filled only where
//      empty, never overwriting what somebody typed on the profile
//   2. the advance as an approved invoice: payee and artist both the artist,
//      category Advance, Net 30 from today, Unpaid, recoupable AND reviewed
//      (an advance is the artist's own money by definition — the one creation
//      path where that answer is known), vendor_email = the artist's email so
//      the payment link resolves to the same payee
//   3. a "signed" marker on the calendar, linking to the profile
//   4. the deal remembers all three (signed_artist_id, signed_at,
//      advance_expense_id) — which is what makes a second call a no-op
// Called from PUT (stage transition), POST (created already Signed) and the
// explicit POST /:id/sign, so nothing depends on a prompt being clicked.
async function signDeal(dealId, user) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [deal] } = await client.query('SELECT * FROM deals WHERE id = $1 FOR UPDATE', [dealId]);
    if (!deal) { await client.query('ROLLBACK'); return null; }
    const created = { artist: false, advance: false, marker: false };
    const name = String(deal.artist_name || '').trim();
    const key = artistBucketKey(name);
    if (!key) { await client.query('ROLLBACK'); return { error: 'The deal names no artist' }; }

    // 1. roster row
    let artist = null;
    if (deal.signed_artist_id) {
      artist = (await client.query('SELECT * FROM artists WHERE id = $1', [deal.signed_artist_id])).rows[0] || null;
    }
    if (!artist) {
      const { rows } = await client.query('SELECT * FROM artists WHERE (archived = false OR archived IS NULL)');
      artist = rows.find((a) => artistBucketKey(a.name) === key) || null;
    }
    if (!artist) {
      const { rows: [a] } = await client.query(
        `INSERT INTO artists (name, genre, email, phone, manager_name, manager_email, socials, spotify_url, signed_at, signed_deal_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, NOW()) RETURNING *`,
        [name, deal.genre || null, strOrNull(deal.artist_email), strOrNull(deal.artist_phone), strOrNull(deal.manager_name),
         strOrNull(deal.manager_email), deal.socials ? JSON.stringify(deal.socials) : null, strOrNull(deal.spotify_url), deal.id]);
      artist = a; created.artist = true;
    } else {
      // fill only what is empty; stamp signed_at once
      const { rows: [a] } = await client.query(
        `UPDATE artists SET
           genre         = COALESCE(genre, $2),
           email         = COALESCE(email, $3),
           phone         = COALESCE(phone, $4),
           manager_name  = COALESCE(manager_name, $5),
           manager_email = COALESCE(manager_email, $6),
           socials       = COALESCE(socials, $7::jsonb),
           spotify_url   = COALESCE(spotify_url, $8),
           signed_at     = COALESCE(signed_at, NOW()),
           signed_deal_id = COALESCE(signed_deal_id, $9)
         WHERE id = $1 RETURNING *`,
        [artist.id, deal.genre || null, strOrNull(deal.artist_email), strOrNull(deal.artist_phone), strOrNull(deal.manager_name),
         strOrNull(deal.manager_email), deal.socials ? JSON.stringify(deal.socials) : null, strOrNull(deal.spotify_url), deal.id]);
      artist = a;
    }

    // 2. the advance, once
    let advanceExpenseId = deal.advance_expense_id || null;
    const advance = Number(deal.advance) || 0;
    if (!advanceExpenseId && advance > 0) {
      const today = new Date();
      const invoiceDate = today.toISOString().slice(0, 10);
      const due = new Date(today.getTime() + 30 * 86400000).toISOString().slice(0, 10);
      const { rows: [e] } = await client.query(
        `INSERT INTO expenses
           (invoice_date, payee, description, category, artist, amount, currency,
            vendor_email, payment_status, payment_terms, scheduled_payment_date,
            recoupable, recoup_reviewed, recoup_reviewed_at, recoup_reviewed_by,
            entry_source, status, approved_by, approved_at, created_by, created_at, notes)
         VALUES ($1, $2, $3, 'Advance', $2, $4, 'USD',
                 $5, 'Unpaid', 'Net 30', $6,
                 TRUE, TRUE, NOW(), $7::integer,
                 'signing', 'approved', $9, NOW(), $9, NOW(), $8)
         RETURNING id`,
        // recoup_reviewed_by is an INTEGER user id; approved_by / created_by are TEXT names
        [invoiceDate, artist.name, `Advance — ${deal.deal_type || 'deal'} signed ${invoiceDate}`, advance,
         strOrNull(deal.artist_email), due, user?.id || null, `Created by signing deal #${deal.id}`, user?.name || user?.email || 'signing']);
      advanceExpenseId = e.id; created.advance = true;
    }

    // 3. the calendar marker, once
    const markerTag = `deal:${deal.id}`;
    const { rows: existing } = await client.query(`SELECT id FROM calendar_events WHERE event_type = 'signed' AND description = $1`, [markerTag]);
    if (!existing.length) {
      await client.query(
        `INSERT INTO calendar_events (title, event_date, event_type, description, color, link, created_by)
         VALUES ($1, CURRENT_DATE, 'signed', $2, NULL, $3, $4)`,
        [`${artist.name} signed`, markerTag, `/artists/${artist.id}`, user?.id || null]);
      created.marker = true;
    }

    // 4. the deal remembers
    const { rows: [updated] } = await client.query(
      `UPDATE deals SET stage = 'Signed', signed_artist_id = $2, signed_at = COALESCE(signed_at, NOW()),
                        advance_expense_id = COALESCE(advance_expense_id, $3), updated_at = NOW()
        WHERE id = $1 RETURNING *`, [deal.id, artist.id, advanceExpenseId]);
    await client.query('COMMIT');
    return { deal: updated, artist: { id: artist.id, name: artist.name }, advance_expense_id: advanceExpenseId, created };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// GET /api/deals/:id — one deal (the contract form reads its terms)
router.get('/:id(\\d+)', authMiddleware, async (req, res) => {
  try {
    const { rows: [deal] } = await pool.query('SELECT * FROM deals WHERE id = $1', [req.params.id]);
    if (!deal) return res.status(404).json({ success: false, error: 'Deal not found' });
    res.json({ success: true, data: deal });
  } catch (error) {
    console.error('Get deal error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/deals/:id/sign — run the signing for a deal (idempotent)
router.post('/:id(\\d+)/sign', authMiddleware, async (req, res) => {
  try {
    const out = await signDeal(req.params.id, req.user);
    if (!out) return res.status(404).json({ success: false, error: 'Deal not found' });
    if (out.error) return res.status(400).json({ success: false, error: out.error });
    res.json({ success: true, data: out.deal, signing: { artist: out.artist, advance_expense_id: out.advance_expense_id, created: out.created } });
  } catch (error) {
    console.error('Sign deal error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

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

    const b = req.body;
    if (b.artist_email && !isEmail(b.artist_email)) return res.status(400).json({ success: false, error: 'Artist email is not an email address' });
    if (b.manager_email && !isEmail(b.manager_email)) return res.status(400).json({ success: false, error: 'Manager email is not an email address' });
    const result = await pool.query(
      `
      INSERT INTO deals (artist_name, genre, stage, ar_rep, source, notes, priority, deal_type, added_date, created_at, updated_at,
                         advance, royalty_split, term_months, territory, num_releases, option_periods,
                         artist_email, artist_phone, manager_name, manager_email, socials, spotify_url)
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'Medium'), $8, CURRENT_DATE, NOW(), NOW(),
              $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20)
      RETURNING *
      `,
      [artist_name, genre || null, stage, ar_rep || null, source || null, notes || null, priority || null, deal_type || null,
       numOrNull(b.advance), numOrNull(b.royalty_split), intOrNull(b.term_months), strOrNull(b.territory), intOrNull(b.num_releases), intOrNull(b.option_periods),
       strOrNull(b.artist_email), strOrNull(b.artist_phone), strOrNull(b.manager_name), strOrNull(b.manager_email), socialsOrNull(b.socials) ?? null, strOrNull(b.spotify_url)]
    );

    let signing = null;
    if (String(stage).toLowerCase() === 'signed') {
      const out = await signDeal(result.rows[0].id, req.user);
      if (out && !out.error) { result.rows[0] = out.deal; signing = { artist: out.artist, advance_expense_id: out.advance_expense_id, created: out.created }; }
    }
    res.status(201).json({
      success: true,
      data: result.rows[0],
      ...(signing ? { signing } : {}),
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
    const b = req.body;
    if (b.artist_email && !isEmail(b.artist_email)) return res.status(400).json({ success: false, error: 'Artist email is not an email address' });
    if (b.manager_email && !isEmail(b.manager_email)) return res.status(400).json({ success: false, error: 'Manager email is not an email address' });

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
          advance                   = CASE WHEN $14::boolean THEN $15::numeric ELSE advance END,
          royalty_split             = CASE WHEN $16::boolean THEN $17::numeric ELSE royalty_split END,
          term_months               = CASE WHEN $18::boolean THEN $19::integer ELSE term_months END,
          territory                 = CASE WHEN $20::boolean THEN $21 ELSE territory END,
          num_releases              = CASE WHEN $22::boolean THEN $23::integer ELSE num_releases END,
          option_periods            = CASE WHEN $24::boolean THEN $25::integer ELSE option_periods END,
          artist_email              = CASE WHEN $26::boolean THEN $27 ELSE artist_email END,
          artist_phone              = CASE WHEN $28::boolean THEN $29 ELSE artist_phone END,
          manager_name              = CASE WHEN $30::boolean THEN $31 ELSE manager_name END,
          manager_email             = CASE WHEN $32::boolean THEN $33 ELSE manager_email END,
          socials                   = CASE WHEN $34::boolean THEN $35::jsonb ELSE socials END,
          spotify_url               = CASE WHEN $36::boolean THEN $37 ELSE spotify_url END,
          updated_at                = NOW()
      WHERE id = $13
      RETURNING *
      `,
      [
        norm(artist_name), norm(genre), norm(stage), norm(ar_rep), norm(source), norm(notes),
        norm(last_contact_date), norm(next_followup_date), norm(priority),
        norm(spotify_monthly_listeners), norm(deal_type), norm(offer_amount),
        id,
        // Terms and contact: "present on the body" means "write it", so a
        // field can be CLEARED by sending '' (unlike the COALESCE columns above).
        b.advance !== undefined, numOrNull(b.advance),
        b.royalty_split !== undefined, numOrNull(b.royalty_split),
        b.term_months !== undefined, intOrNull(b.term_months),
        b.territory !== undefined, strOrNull(b.territory),
        b.num_releases !== undefined, intOrNull(b.num_releases),
        b.option_periods !== undefined, intOrNull(b.option_periods),
        b.artist_email !== undefined, strOrNull(b.artist_email),
        b.artist_phone !== undefined, strOrNull(b.artist_phone),
        b.manager_name !== undefined, strOrNull(b.manager_name),
        b.manager_email !== undefined, strOrNull(b.manager_email),
        b.socials !== undefined, socialsOrNull(b.socials) ?? null,
        b.spotify_url !== undefined, strOrNull(b.spotify_url),
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Deal not found' });
    }

    // The transition INTO Signed runs the signing before the response, so the
    // client learns what was created (and nothing depends on a prompt click).
    let signing = null;
    // previousStage is read only when `stage` was in the body, so an edit that
    // does not touch the stage (notes, terms) can never re-run the signing.
    const movedToSigned = previousStage !== null
      && String(result.rows[0].stage).toLowerCase() === 'signed'
      && String(previousStage || '').toLowerCase() !== 'signed';
    if (movedToSigned) {
      try {
        const out = await signDeal(id, req.user);
        if (out && !out.error) { result.rows[0] = out.deal; signing = { artist: out.artist, advance_expense_id: out.advance_expense_id, created: out.created }; }
        else if (out?.error) signing = { error: out.error };
      } catch (e) {
        console.error('signing after stage change failed:', e);
        signing = { error: 'Signing could not complete; use Sign again on the deal.' };
      }
    }

    res.json({
      success: true,
      data: result.rows[0],
      ...(signing ? { signing } : {}),
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
