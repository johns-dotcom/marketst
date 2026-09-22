// /api/campaigns — song campaigns (see lib/song-campaigns.js for the model).
//   GET    /                     ?status ?owner=me|id ?artist=<key>   every campaign with money + checklist
//   GET    /songs?artist=        the artist's releases and the songs already on their ledger rows
//   GET    /:id                  one campaign, with lines, ledger rows, channels, events
//   POST   /                     create (artist, song, budget, owner_id, dates, notes, lines[])
//   PUT    /:id                  edit those fields
//   POST   /:id/lines            add an expected line;  PUT /:id/lines/:lid (incl. expense_id link) ; DELETE
//   POST   /:id/status           { status, note } — live · finished · ready (confirm) · live from ready (reopen)
//   DELETE /:id                  owner, creator or admin
const express = require('express');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { artistBucketKey } = require('../lib/artist-key');
const sc = require('../lib/song-campaigns');

const router = express.Router();
router.use(authMiddleware);

const isAdmin = (u) => ['Admin', 'Superadmin', 'Approver'].includes(u?.role);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const numOrNull = (v) => (v === undefined || v === null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const str = (v) => (v === undefined ? undefined : (v === null ? null : (String(v).trim() || null)));
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const one = async (id) => (await sc.list({ id }))[0] || null;

router.get('/', async (req, res) => {
  try {
    const owner_id = req.query.owner === 'me' ? req.user.id : (req.query.owner ? Number(req.query.owner) : null);
    const data = await sc.list({ status: sc.STATUSES.includes(req.query.status) ? req.query.status : null, owner_id, artist_key: req.query.artist || null });
    // The list is light: no per-row ledger.
    res.json({ success: true, data: data.map(({ ledger, lines, ...c }) => ({ ...c, lines_open: lines.filter((l) => !l.expense_id).length })) });
  } catch (e) { console.error('campaigns list:', e); fail(res, 500, 'Internal server error'); }
});

// Songs to pick from for an artist: their releases first, then songs the ledger already names.
router.get('/songs', async (req, res) => {
  try {
    const key = artistBucketKey(req.query.artist || '');
    if (!key) return res.json({ success: true, data: { releases: [], ledger: [] } });
    const [{ rows: rel }, { rows: led }] = await Promise.all([
      pool.query(`SELECT r.id, r.project_name, r.release_date::text AS release_date FROM releases r JOIN artists a ON a.id = r.artist_id WHERE LOWER(TRIM(a.name)) = LOWER(TRIM($1)) OR $2 = ANY(ARRAY[LOWER(TRIM(a.name))]) ORDER BY r.release_date DESC NULLS LAST`, [req.query.artist || '', key]),
      pool.query(`SELECT DISTINCT TRIM(song) AS song FROM expenses WHERE song IS NOT NULL AND TRIM(song) <> '' AND (deleted = false OR deleted IS NULL) AND LOWER(TRIM(artist)) = LOWER(TRIM($1)) ORDER BY 1 LIMIT 200`, [req.query.artist || '']),
    ]);
    const { rows: existing } = await pool.query(`SELECT song, status FROM song_campaigns WHERE artist_key = $1`, [key]);
    res.json({ success: true, data: { releases: rel, ledger: led.map((r) => r.song), existing } });
  } catch (e) { console.error('campaign songs:', e); fail(res, 500, 'Internal server error'); }
});

router.get('/:id(\\d+)', async (req, res) => {
  try {
    const c = await one(Number(req.params.id));
    if (!c) return fail(res, 404, 'Campaign not found');
    const { rows: events } = await pool.query(`SELECT * FROM song_campaign_events WHERE campaign_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`, [c.id]);
    res.json({ success: true, data: { ...c, events } });
  } catch (e) { console.error('campaign read:', e); fail(res, 500, 'Internal server error'); }
});

router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const artist = str(b.artist); const song = str(b.song);
    if (!artist || !song) return fail(res, 400, 'Artist and song are required');
    const artist_key = artistBucketKey(artist);
    if (!artist_key) return fail(res, 400, 'That artist name is a placeholder');
    const song_key = sc.songKeyOf(song);
    if (b.end_date && !isDate(b.end_date)) return fail(res, 400, 'end_date must be YYYY-MM-DD');
    if (b.start_date && !isDate(b.start_date)) return fail(res, 400, 'start_date must be YYYY-MM-DD');
    const status = sc.STATUSES.includes(b.status) ? b.status : 'planning';
    const ownerId = b.owner_id === undefined || b.owner_id === null || b.owner_id === '' ? req.user.id : Number(b.owner_id);
    const { rows: [dup] } = await pool.query(`SELECT id FROM song_campaigns WHERE artist_key = $1 AND song_key = $2`, [artist_key, song_key]);
    if (dup) return res.status(409).json({ success: false, error: 'A campaign for this song already exists', id: dup.id });
    const { rows: [c] } = await pool.query(
      `INSERT INTO song_campaigns (artist_key, artist, song, song_key, release_id, owner_id, budget, currency, start_date, end_date, status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [artist_key, artist, song, song_key, numOrNull(b.release_id), ownerId, numOrNull(b.budget), str(b.currency) || 'USD', isDate(b.start_date) ? b.start_date : null, isDate(b.end_date) ? b.end_date : null, status, str(b.notes), req.user.id]);
    for (const [i, l] of (Array.isArray(b.lines) ? b.lines : []).entries()) {
      if (!str(l?.label)) continue;
      await pool.query(`INSERT INTO song_campaign_lines (campaign_id, label, category, vendor, expected_amount, currency, sort, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [c.id, str(l.label), str(l.category), str(l.vendor), numOrNull(l.expected_amount), str(l.currency) || 'USD', i, req.user.id]);
    }
    await sc.logEvent(c.id, { kind: 'created', body: `Created in ${status}`, to_status: status, user: req.user });
    if (str(b.notes)) await sc.logEvent(c.id, { kind: 'note', body: str(b.notes), user: req.user });
    res.status(201).json({ success: true, data: await one(c.id) });
  } catch (e) { console.error('campaign create:', e); fail(res, 500, 'Internal server error'); }
});

router.put('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id); const b = req.body || {};
    const { rows: [cur] } = await pool.query(`SELECT * FROM song_campaigns WHERE id = $1`, [id]);
    if (!cur) return fail(res, 404, 'Campaign not found');
    if (b.end_date && !isDate(b.end_date)) return fail(res, 400, 'end_date must be YYYY-MM-DD');
    if (b.start_date && !isDate(b.start_date)) return fail(res, 400, 'start_date must be YYYY-MM-DD');
    const sets = []; const vals = [];
    const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.budget !== undefined) set('budget', numOrNull(b.budget));
    if (b.currency !== undefined) set('currency', str(b.currency) || 'USD');
    if (b.owner_id !== undefined) set('owner_id', b.owner_id === null || b.owner_id === '' ? null : Number(b.owner_id));
    if (b.start_date !== undefined) set('start_date', isDate(b.start_date) ? b.start_date : null);
    if (b.end_date !== undefined) set('end_date', isDate(b.end_date) ? b.end_date : null);
    if (b.release_id !== undefined) set('release_id', numOrNull(b.release_id));
    if (b.notes !== undefined) set('notes', str(b.notes));
    if (b.song !== undefined && str(b.song)) { set('song', str(b.song)); set('song_key', sc.songKeyOf(b.song)); }
    if (!sets.length) return res.json({ success: true, data: await one(id) });
    vals.push(id);
    await pool.query(`UPDATE song_campaigns SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length}`, vals);
    if (b.note_event && str(b.note_event)) await sc.logEvent(id, { kind: 'note', body: str(b.note_event), user: req.user });
    res.json({ success: true, data: await one(id) });
  } catch (e) {
    if (e.code === '23505') return fail(res, 409, 'A campaign for this song already exists');
    console.error('campaign update:', e); fail(res, 500, 'Internal server error');
  }
});

// ── expected lines ──
router.post('/:id(\\d+)/lines', async (req, res) => {
  try {
    const id = Number(req.params.id); const b = req.body || {};
    if (!str(b.label)) return fail(res, 400, 'A line needs a label');
    const { rows: [n] } = await pool.query(`SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM song_campaign_lines WHERE campaign_id = $1`, [id]);
    await pool.query(`INSERT INTO song_campaign_lines (campaign_id, label, category, vendor, expected_amount, currency, sort, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, str(b.label), str(b.category), str(b.vendor), numOrNull(b.expected_amount), str(b.currency) || 'USD', n.s, req.user.id]);
    await pool.query(`UPDATE song_campaigns SET updated_at = NOW() WHERE id = $1`, [id]);
    res.status(201).json({ success: true, data: await one(id) });
  } catch (e) { console.error('campaign line add:', e); fail(res, 500, 'Internal server error'); }
});
router.put('/:id(\\d+)/lines/:lid(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id); const lid = Number(req.params.lid); const b = req.body || {};
    const sets = []; const vals = [];
    const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.label !== undefined) set('label', str(b.label));
    if (b.category !== undefined) set('category', str(b.category));
    if (b.vendor !== undefined) set('vendor', str(b.vendor));
    if (b.expected_amount !== undefined) set('expected_amount', numOrNull(b.expected_amount));
    if (b.currency !== undefined) set('currency', str(b.currency) || 'USD');
    if (b.expense_id !== undefined) {
      // Linking the invoice that fulfils the line — the row must belong to this song.
      const exp = numOrNull(b.expense_id);
      if (exp !== null) { const c = await one(id); if (!c || !c.expense_ids.includes(exp)) return fail(res, 400, 'That invoice is not attributed to this song'); }
      set('expense_id', exp); set('received_at', exp === null ? null : new Date());
    }
    if (!sets.length) return res.json({ success: true, data: await one(id) });
    vals.push(lid, id);
    const { rowCount } = await pool.query(`UPDATE song_campaign_lines SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND campaign_id = $${vals.length}`, vals);
    if (!rowCount) return fail(res, 404, 'Line not found');
    await pool.query(`UPDATE song_campaigns SET updated_at = NOW() WHERE id = $1`, [id]);
    res.json({ success: true, data: await one(id) });
  } catch (e) { console.error('campaign line update:', e); fail(res, 500, 'Internal server error'); }
});
router.delete('/:id(\\d+)/lines/:lid(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await pool.query(`DELETE FROM song_campaign_lines WHERE id = $1 AND campaign_id = $2`, [Number(req.params.lid), id]);
    res.json({ success: true, data: await one(id) });
  } catch (e) { console.error('campaign line delete:', e); fail(res, 500, 'Internal server error'); }
});

// ── the lifecycle ──
// planning → live → finished → ready → uploaded. `ready` is the confirmation:
// the checklist must be clear, or a note must say why it is fine anyway.
// Anything back to `live` is a reopen and clears the confirmation.
router.post('/:id(\\d+)/status', async (req, res) => {
  try {
    const id = Number(req.params.id); const { status, note } = req.body || {};
    if (!sc.STATUSES.includes(status)) return fail(res, 400, `status must be one of ${sc.STATUSES.join(', ')}`);
    if (status === 'uploaded') return fail(res, 400, 'Uploaded is reached by uploading the items for recoupment, not by hand');
    const c = await one(id);
    if (!c) return fail(res, 404, 'Campaign not found');
    if (status === c.status) return res.json({ success: true, data: c });
    const n = str(note);
    const sets = [`status = $2`, `updated_at = NOW()`]; const vals = [id, status];
    if (status === 'finished') { sets.push(`finished_at = NOW()`, `finished_by = $3`); vals.push(req.user.id); }
    if (status === 'ready') {
      if (!c.ready && !n) return res.status(400).json({ success: false, error: 'The checklist is not clear. Confirm anyway with a note saying why.', checklist: c.checklist, needs_note: true });
      sets.push(`confirmed_at = NOW()`, `confirmed_by = $3`, `confirm_note = $4`); vals.push(req.user.id, n);
      if (!c.finished_at) sets.push(`finished_at = NOW()`, `finished_by = $3`);
    }
    if (status === 'live' || status === 'planning') {
      const reopening = ['ready', 'uploaded', 'finished'].includes(c.status);
      sets.push(`finished_at = NULL`, `finished_by = NULL`, `confirmed_at = NULL`, `confirmed_by = NULL`, `confirm_note = NULL`, `uploaded_at = NULL`);
      if (reopening) { sets.push(`reopened_at = NOW()`, `reopen_reason = $3`); vals.push(n || 'Reopened by hand'); }
    }
    await pool.query(`UPDATE song_campaigns SET ${sets.join(', ')} WHERE id = $1`, vals);
    const kind = status === 'ready' ? 'confirmed' : status === 'finished' ? 'finished' : ['ready', 'uploaded', 'finished'].includes(c.status) ? 'reopened' : 'status';
    await sc.logEvent(id, { kind, body: n || (status === 'ready' && !c.ready ? null : null), from_status: c.status, to_status: status, user: req.user });
    res.json({ success: true, data: await one(id) });
  } catch (e) { console.error('campaign status:', e); fail(res, 500, 'Internal server error'); }
});

router.post('/:id(\\d+)/events', async (req, res) => {
  try {
    const body = str(req.body?.body); if (!body) return fail(res, 400, 'Write something first');
    const e = await sc.logEvent(Number(req.params.id), { kind: 'note', body, user: req.user });
    res.status(201).json({ success: true, data: e });
  } catch (e) { console.error('campaign note:', e); fail(res, 500, 'Internal server error'); }
});

router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const { rows: [c] } = await pool.query(`SELECT * FROM song_campaigns WHERE id = $1`, [Number(req.params.id)]);
    if (!c) return fail(res, 404, 'Campaign not found');
    if (!isAdmin(req.user) && Number(c.owner_id) !== Number(req.user.id) && Number(c.created_by) !== Number(req.user.id)) return fail(res, 403, 'Only the owner or an admin removes a campaign');
    await pool.query(`DELETE FROM song_campaigns WHERE id = $1`, [c.id]);
    res.json({ success: true });
  } catch (e) { console.error('campaign delete:', e); fail(res, 500, 'Internal server error'); }
});

module.exports = router;
