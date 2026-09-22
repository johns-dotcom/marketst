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
const TERM_FIELDS = ['advance', 'royalty_split', 'term_months', 'territory', 'num_releases', 'option_periods', 'marketing_budget'];
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
    const deal = await readDeal(req.params.id);
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
    const { stage, owner } = req.query;
    let query = `${LIST_SQL} WHERE 1=1`;
    const params = [];

    if (stage) {
      query += ` AND d.stage = $${params.length + 1}`;
      params.push(stage);
    }
    if (owner) {
      params.push(owner === 'me' ? req.user.id : Number(owner));
      query += ` AND d.owner_id = $${params.length}`;
    }

    query += ' ORDER BY d.added_date DESC, d.id DESC';

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
const STAGES = ['Scouting', 'Meeting', 'Offer', 'Negotiation', 'Signed', 'Passed'];
const LIVE_STAGES = ['Scouting', 'Meeting', 'Offer', 'Negotiation'];
// Why a deal was passed — a fixed list so the report can count them; "Other" carries the note.
const PASSED_REASONS = ['Budget', 'Went elsewhere', 'Not ready', 'No fit', 'Unresponsive', 'Other'];
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// One row on the timeline. Never throws: a lost log line is a log line, not a failed write.
async function logEvent(dealId, { kind, body = null, from_stage = null, to_stage = null, user }) {
  try {
    const { rows: [e] } = await pool.query(
      `INSERT INTO deal_events (deal_id, kind, body, from_stage, to_stage, user_id, user_name) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [dealId, kind, body, from_stage, to_stage, user?.id || null, user?.name || user?.email || null]);
    return e;
  } catch (e) { console.error('deal_events insert failed:', e.message); return null; }
}

// The list shape: the deal, its owner's name, days in the current stage, the
// last thing that happened on it, and how many documents it carries.
const LIST_SQL = `
  SELECT d.*, u.name AS owner_name,
         FLOOR(EXTRACT(EPOCH FROM (NOW() - COALESCE(d.stage_changed_at, d.updated_at, d.created_at))) / 86400)::int AS days_in_stage,
         le.kind AS last_event_kind, le.body AS last_event_body, le.created_at AS last_event_at, le.user_name AS last_event_user,
         (SELECT COUNT(*)::int FROM entity_files ef WHERE ef.entity_type = 'deal' AND ef.entity_id = d.id) AS file_count
    FROM deals d
    LEFT JOIN users u ON u.id = d.owner_id
    LEFT JOIN LATERAL (SELECT kind, body, created_at, user_name FROM deal_events e WHERE e.deal_id = d.id ORDER BY created_at DESC, id DESC LIMIT 1) le ON TRUE`;
const readDeal = async (id) => (await pool.query(`${LIST_SQL} WHERE d.id = $1`, [id])).rows[0] || null;

// POST /api/deals
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { artist_name, genre, stage, ar_rep, source, notes, priority, deal_type } = req.body;

    if (!artist_name || !stage) {
      return res.status(400).json({ success: false, error: 'Artist name and stage required' });
    }
    if (!STAGES.includes(stage)) return res.status(400).json({ success: false, error: 'Unknown stage' });
    // The owner is a PERSON — the one whose My Work and calendar carry the follow-ups.
    // Defaults to whoever adds the deal.
    const ownerId = req.body.owner_id === undefined || req.body.owner_id === null || req.body.owner_id === '' ? req.user.id : Number(req.body.owner_id);
    if (!Number.isInteger(ownerId)) return res.status(400).json({ success: false, error: 'owner_id must be a user id' });
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
                         artist_email, artist_phone, manager_name, manager_email, socials, spotify_url,
                         owner_id, stage_changed_at, next_followup_date, marketing_budget)
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'Medium'), $8, CURRENT_DATE, NOW(), NOW(),
              $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20,
              $21, NOW(), $22::date, $23)
      RETURNING *
      `,
      [artist_name, genre || null, stage, ar_rep || null, source || null, notes || null, priority || null, deal_type || null,
       numOrNull(b.advance), numOrNull(b.royalty_split), intOrNull(b.term_months), strOrNull(b.territory), intOrNull(b.num_releases), intOrNull(b.option_periods),
       strOrNull(b.artist_email), strOrNull(b.artist_phone), strOrNull(b.manager_name), strOrNull(b.manager_email), socialsOrNull(b.socials) ?? null, strOrNull(b.spotify_url),
       ownerId, isDate(b.next_followup_date) ? b.next_followup_date : null, numOrNull(b.marketing_budget)]
    );
    await logEvent(result.rows[0].id, { kind: 'created', to_stage: stage, body: source ? `Added from ${source}` : 'Added', user: req.user });
    if (notes && String(notes).trim()) await logEvent(result.rows[0].id, { kind: 'note', body: String(notes).trim(), user: req.user });

    let signing = null;
    if (String(stage).toLowerCase() === 'signed') {
      const out = await signDeal(result.rows[0].id, req.user);
      if (out && !out.error) { result.rows[0] = out.deal; signing = { artist: out.artist, advance_expense_id: out.advance_expense_id, created: out.created }; }
    }
    result.rows[0] = (await readDeal(result.rows[0].id)) || result.rows[0];
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
    if (stage !== undefined && stage !== null && stage !== '' && !STAGES.includes(stage)) return res.status(400).json({ success: false, error: 'Unknown stage' });
    if (b.passed_reason !== undefined && b.passed_reason !== null && b.passed_reason !== '' && !PASSED_REASONS.includes(b.passed_reason)) return res.status(400).json({ success: false, error: `passed_reason must be one of ${PASSED_REASONS.join(', ')}` });
    if (b.revisit_date !== undefined && b.revisit_date !== null && b.revisit_date !== '' && !isDate(b.revisit_date)) return res.status(400).json({ success: false, error: 'revisit_date must be YYYY-MM-DD' });
    if (b.owner_id !== undefined && b.owner_id !== null && b.owner_id !== '' && !Number.isInteger(Number(b.owner_id))) return res.status(400).json({ success: false, error: 'owner_id must be a user id' });

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
          owner_id                  = CASE WHEN $38::boolean THEN $39::integer ELSE owner_id END,
          passed_reason             = CASE WHEN $40::boolean THEN $41 ELSE passed_reason END,
          passed_note               = CASE WHEN $42::boolean THEN $43 ELSE passed_note END,
          revisit_date              = CASE WHEN $44::boolean THEN $45::date ELSE revisit_date END,
          -- the clock restarts only when the stage actually moves
          stage_changed_at          = CASE WHEN $46::boolean THEN NOW() ELSE stage_changed_at END,
          marketing_budget          = CASE WHEN $47::boolean THEN $48::numeric ELSE marketing_budget END,
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
        b.owner_id !== undefined, b.owner_id == null || b.owner_id === '' ? null : Number(b.owner_id),
        b.passed_reason !== undefined, strOrNull(b.passed_reason),
        b.passed_note !== undefined, strOrNull(b.passed_note),
        b.revisit_date !== undefined, isDate(b.revisit_date) ? b.revisit_date : null,
        previousStage !== null && norm(stage) && norm(stage) !== previousStage,
        b.marketing_budget !== undefined, numOrNull(b.marketing_budget),
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Deal not found' });
    }
    // The timeline records the move (and, for Passed, the reason beside it).
    if (previousStage !== null && result.rows[0].stage !== previousStage) {
      const toPassed = result.rows[0].stage === 'Passed';
      await logEvent(id, {
        kind: toPassed ? 'passed' : 'stage', from_stage: previousStage, to_stage: result.rows[0].stage,
        body: toPassed ? [result.rows[0].passed_reason, result.rows[0].passed_note].filter(Boolean).join(' — ') || null : null, user: req.user,
      });
      // Leaving Passed: the revisit reminder no longer applies.
      if (previousStage === 'Passed' && !toPassed) await pool.query('UPDATE deals SET revisit_date = NULL WHERE id = $1', [id]).catch(() => {});
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

    result.rows[0] = (await readDeal(id)) || result.rows[0];
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

// ── The timeline ───────────────────────────────────────────────────────────
// GET  /deals/:id/events            newest first
// POST /deals/:id/events {body}     a dated note by the caller; also stamps last_contact_date
// DELETE /deals/:id/events/:eid     your own note, or any note for Admin/Superadmin
router.get('/:id(\\d+)/events', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM deal_events WHERE deal_id = $1 ORDER BY created_at DESC, id DESC LIMIT 500', [req.params.id]);
    res.json({ success: true, data: rows });
  } catch (error) { console.error('deal events error:', error); res.status(500).json({ success: false, error: 'Internal server error' }); }
});
router.post('/:id(\\d+)/events', authMiddleware, async (req, res) => {
  try {
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ success: false, error: 'Write something first' });
    if (body.length > 5000) return res.status(400).json({ success: false, error: 'A note is at most 5,000 characters' });
    const { rows: [d] } = await pool.query('SELECT id FROM deals WHERE id = $1', [req.params.id]);
    if (!d) return res.status(404).json({ success: false, error: 'Deal not found' });
    const e = await logEvent(d.id, { kind: 'note', body, user: req.user });
    if (!e) return res.status(500).json({ success: false, error: 'Could not save the note' });
    // A note is a touch: the card's "last contact" follows it unless somebody typed a later date.
    await pool.query('UPDATE deals SET last_contact_date = GREATEST(COALESCE(last_contact_date, CURRENT_DATE), CURRENT_DATE), updated_at = NOW() WHERE id = $1', [d.id]).catch(() => {});
    res.status(201).json({ success: true, data: e, deal: await readDeal(d.id) });
  } catch (error) { console.error('deal note error:', error); res.status(500).json({ success: false, error: 'Internal server error' }); }
});
router.delete('/:id(\\d+)/events/:eid(\\d+)', authMiddleware, async (req, res) => {
  try {
    const { rows: [e] } = await pool.query('SELECT * FROM deal_events WHERE id = $1 AND deal_id = $2', [req.params.eid, req.params.id]);
    if (!e) return res.status(404).json({ success: false, error: 'Not found' });
    if (e.kind !== 'note') return res.status(400).json({ success: false, error: 'Stage history cannot be deleted' });
    const admin = ['Admin', 'Superadmin'].includes(req.user?.role);
    if (!admin && Number(e.user_id) !== Number(req.user.id)) return res.status(403).json({ success: false, error: 'Not your note' });
    await pool.query('DELETE FROM deal_events WHERE id = $1', [e.id]);
    res.json({ success: true });
  } catch (error) { console.error('deal note delete error:', error); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

// ── The funnel report ──────────────────────────────────────────────────────
// GET /deals/report/funnel?from=&to=   (added_date window; default all time)
//   funnel[]        per live stage: deals that REACHED it (or further) and the conversion from the stage before
//   stage_days[]    per stage: average days of every COMPLETED stint, and how many deals sit there now
//   by_source[] / by_owner[]   signed · passed · open · win_rate (signed / (signed + passed))
//   passed_reasons[]           counts
//   totals          live count and advance sum, signed count and advance sum, passed count, win_rate
// Built from deal_events (created + stage moves) — the history, not the current column — so a deal
// that went Scouting → Offer → Passed still counts as having reached Offer.
router.get('/report/funnel', authMiddleware, async (req, res) => {
  try {
    const from = isDate(req.query.from) ? req.query.from : null;
    const to = isDate(req.query.to) ? req.query.to : null;
    const where = ['1=1']; const params = [];
    if (from) { params.push(from); where.push(`d.added_date >= $${params.length}::date`); }
    if (to) { params.push(to); where.push(`d.added_date <= $${params.length}::date`); }
    const { rows: deals } = await pool.query(`SELECT d.*, u.name AS owner_name FROM deals d LEFT JOIN users u ON u.id = d.owner_id WHERE ${where.join(' AND ')}`, params);
    const ids = deals.map((d) => d.id);
    const { rows: events } = ids.length
      ? await pool.query(`SELECT deal_id, kind, from_stage, to_stage, created_at FROM deal_events WHERE deal_id = ANY($1) AND kind IN ('created','stage','passed','signed') ORDER BY deal_id, created_at, id`, [ids])
      : { rows: [] };
    const byDeal = new Map(); for (const e of events) { if (!byDeal.has(e.deal_id)) byDeal.set(e.deal_id, []); byDeal.get(e.deal_id).push(e); }
    const idx = (st) => LIVE_STAGES.indexOf(st);
    const reached = LIVE_STAGES.map(() => 0);
    const stints = {}; for (const st of STAGES) stints[st] = { total_days: 0, n: 0, open: 0 };
    const now = Date.now();
    for (const d of deals) {
      const evs = byDeal.get(d.id) || [];
      // furthest live stage: every stage entered plus the current one
      let far = idx(d.stage);
      for (const e of evs) far = Math.max(far, idx(e.to_stage));
      if (d.stage === 'Signed' || evs.some((e) => e.to_stage === 'Signed')) far = LIVE_STAGES.length - 1;
      if (d.stage === 'Passed' && far < 0) far = 0;
      for (let i = 0; i <= far; i += 1) reached[i] += 1;
      // stints: from each entry to the next move
      const entries = evs.filter((e) => e.to_stage);
      if (!entries.length) entries.push({ to_stage: d.stage, created_at: d.stage_changed_at || d.created_at });
      for (let i = 0; i < entries.length; i += 1) {
        const st = entries[i].to_stage; const start = new Date(entries[i].created_at).getTime();
        const next = entries[i + 1];
        if (!stints[st]) continue;
        if (next) { stints[st].total_days += (new Date(next.created_at).getTime() - start) / 86400000; stints[st].n += 1; }
        else if (LIVE_STAGES.includes(st)) stints[st].open += 1;
      }
    }
    const funnel = LIVE_STAGES.map((st, i) => ({ stage: st, reached: reached[i], conversion: i === 0 ? null : (reached[i - 1] ? Math.round((reached[i] / reached[i - 1]) * 1000) / 10 : null) }));
    const signedN = deals.filter((d) => d.stage === 'Signed').length;
    funnel.push({ stage: 'Signed', reached: signedN, conversion: reached[LIVE_STAGES.length - 1] ? Math.round((signedN / reached[LIVE_STAGES.length - 1]) * 1000) / 10 : null });
    const stage_days = STAGES.filter((s) => s !== 'Passed').map((st) => ({ stage: st, avg_days: stints[st].n ? Math.round((stints[st].total_days / stints[st].n) * 10) / 10 : null, completed: stints[st].n, sitting: stints[st].open }));
    const group = (keyOf) => {
      const m = new Map();
      for (const d of deals) {
        const k = keyOf(d) || '—'; if (!m.has(k)) m.set(k, { key: k, signed: 0, passed: 0, open: 0, advance_signed: 0 });
        const g = m.get(k);
        if (d.stage === 'Signed') { g.signed += 1; g.advance_signed += Number(d.advance) || 0; } else if (d.stage === 'Passed') g.passed += 1; else g.open += 1;
      }
      return [...m.values()].map((g) => ({ ...g, win_rate: g.signed + g.passed ? Math.round((g.signed / (g.signed + g.passed)) * 1000) / 10 : null })).sort((a, b) => (b.signed + b.passed + b.open) - (a.signed + a.passed + a.open));
    };
    const reasons = new Map(); for (const d of deals) if (d.stage === 'Passed') reasons.set(d.passed_reason || 'Not recorded', (reasons.get(d.passed_reason || 'Not recorded') || 0) + 1);
    const live = deals.filter((d) => LIVE_STAGES.includes(d.stage));
    const signed = deals.filter((d) => d.stage === 'Signed'); const passed = deals.filter((d) => d.stage === 'Passed');
    res.json({ success: true, data: {
      range: { from, to }, deals: deals.length,
      totals: { live: live.length, live_advance: live.reduce((a, d) => a + (Number(d.advance) || 0), 0), signed: signed.length, signed_advance: signed.reduce((a, d) => a + (Number(d.advance) || 0), 0), passed: passed.length, win_rate: signed.length + passed.length ? Math.round((signed.length / (signed.length + passed.length)) * 1000) / 10 : null },
      funnel, stage_days, by_source: group((d) => d.source), by_owner: group((d) => d.owner_name),
      passed_reasons: [...reasons.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
    } });
  } catch (error) { console.error('deal funnel error:', error); res.status(500).json({ success: false, error: 'Internal server error' }); }
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
    if (!['Admin', 'Superadmin', 'Approver'].includes(req.user?.role)) return res.status(403).json({ success: false, error: 'Admin or Approver required' });
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
