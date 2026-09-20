const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { onboardingFor, openOnboardings } = require('../lib/onboarding');
const { validatePaymentFields, last4: payLast4 } = require('../lib/payment-fields');
const paymentCrypto = require('../lib/payment-crypto');
const { uploadFile, deleteFile } = require('../lib/r2');
const { clearForeignKeyRefs } = require('../lib/fkSweep');

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const { secureFileFilter } = require('../middleware/secureUpload');

// Memory storage so we can stream the buffer straight to R2. The old disk
// storage broke across Railway restarts — the filesystem is ephemeral.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: secureFileFilter,
});

// GET /api/artists
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = ' WHERE 1=1';
    const params = [];

    if (search) {
      whereClause += ` AND LOWER(name) LIKE LOWER($${params.length + 1})`;
      params.push(`%${search}%`);
    }

    // Get total count
    const countResult = await pool.query('SELECT COUNT(*) as count FROM artists' + whereClause, params);
    const total = parseInt(countResult.rows[0].count);

    // Get paginated results. has_recent_release is a derived boolean
    // used by the Roster page's "Active only" filter — true when the
    // artist has at least one non-archived release dated within the
    // past 365 days OR scheduled for any future date (single comparison
    // `release_date >= CURRENT_DATE - INTERVAL '365 days'` covers both
    // — yesterday's release is in past 365 days, next month's release
    // is also >= a-year-ago).
    const query = `
      SELECT a.*, st.followers AS spotify_followers, st.popularity AS spotify_popularity, st.monthly_listeners, st.day AS stats_day,
             EXISTS(
               SELECT 1 FROM releases r
                WHERE r.artist_id = a.id
                  AND (r.archived = false OR r.archived IS NULL)
                  AND r.release_date IS NOT NULL
                  AND r.release_date >= CURRENT_DATE - INTERVAL '365 days'
             ) AS has_recent_release
        FROM artists a
        LEFT JOIN LATERAL (
          SELECT s.followers, s.popularity, s.day, (SELECT c.monthly_listeners FROM artist_stats c WHERE c.artist_id = a.id AND c.source = 'chartmetric' ORDER BY c.day DESC LIMIT 1) AS monthly_listeners
          FROM artist_stats s WHERE s.artist_id = a.id AND s.source = 'spotify' ORDER BY s.day DESC LIMIT 1
        ) st ON TRUE
        ${whereClause.replace(/LOWER\(name\)/g, 'LOWER(a.name)')}
       ORDER BY a.name ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    params.push(limit, offset);
    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows,
      total,
    });
  } catch (error) {
    console.error('Get artists error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/artists/export — Excel export of the roster.
// Query params:
//   genres     — comma-separated list (case-insensitive); omit to include all genres.
//   since_days — integer; narrow to artists with at least one non-archived
//                release whose release_date falls within the past N days
//                (strictly past — future-dated releases don't count here, the
//                "past N months" phrasing means past). Omit for all-time.
// Declared BEFORE /:id so Express doesn't treat "export" as an id.
router.get('/export', authMiddleware, async (req, res) => {
  try {
    const { genres } = req.query;
    const sinceDays = parseInt(req.query.since_days, 10);
    const params = [];
    let where = ' WHERE 1=1';

    if (genres) {
      const list = String(genres).split(',').map(g => g.trim()).filter(Boolean);
      if (list.length) {
        const placeholders = list.map((_, i) => `LOWER($${i + 1})`).join(', ');
        where += ` AND LOWER(COALESCE(genre, '')) IN (${placeholders})`;
        params.push(...list);
      }
    }

    if (Number.isFinite(sinceDays) && sinceDays > 0) {
      // Cast the integer literal — interpolated server-side so we don't
      // have to push a parameterised INTERVAL (Postgres doesn't accept
      // $N in INTERVAL strings). Sanitised to an int by parseInt above.
      where += ` AND EXISTS (
        SELECT 1 FROM releases r
         WHERE r.artist_id = a.id
           AND (r.archived = false OR r.archived IS NULL)
           AND r.release_date IS NOT NULL
           AND r.release_date BETWEEN (CURRENT_DATE - INTERVAL '${sinceDays} days') AND CURRENT_DATE
      )`;
    }

    // `last_release_date` is computed per row regardless of window so
    // the bookkeeper sees WHY each artist made the cut. Useful context
    // even for an all-time export. Genre filter built earlier referenced
    // the unaliased `genre` column; qualify it to a.genre now that the
    // table is aliased.
    const { rows } = await pool.query(
      `SELECT a.name, a.genre, a.total_releases, a.created_at,
              (SELECT MAX(r.release_date) FROM releases r
                WHERE r.artist_id = a.id
                  AND (r.archived = false OR r.archived IS NULL)) AS last_release_date
         FROM artists a
         ${where.replace(/LOWER\(COALESCE\(genre/g, 'LOWER(COALESCE(a.genre')}
        ORDER BY a.name ASC`,
      params
    );

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Market Street Dashboard';
    const ws = wb.addWorksheet('Roster');

    ws.columns = [
      { header: 'Artist',            key: 'name',              width: 32 },
      { header: 'Genre',             key: 'genre',             width: 22 },
      { header: 'Total Releases',    key: 'total_releases',    width: 14 },
      { header: 'Last Release Date', key: 'last_release_date', width: 18 },
      { header: 'Date Added',        key: 'created_at',        width: 14 },
    ];

    ws.getRow(1).font      = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
    ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    for (const r of rows) {
      ws.addRow({
        name: r.name,
        genre: r.genre || '',
        total_releases: r.total_releases || 0,
        last_release_date: r.last_release_date ? new Date(r.last_release_date).toLocaleDateString('en-US') : '',
        created_at: r.created_at ? new Date(r.created_at).toLocaleDateString('en-US') : '',
      });
    }
    ws.getColumn('total_releases').alignment = { horizontal: 'center' };
    ws.getColumn('last_release_date').alignment = { horizontal: 'center' };

    const genreLabel = genres
      ? String(genres).split(',').map(g => g.trim()).filter(Boolean).join('-').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
      : 'all';
    const windowLabel = (Number.isFinite(sinceDays) && sinceDays > 0) ? `-last${sinceDays}d` : '';
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Disposition', `attachment; filename="roster-${genreLabel}${windowLabel}-${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('GET /api/artists/export:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Duplicate detection + merge ─────────────────────────────────────────
// Catches "Oniimukuu" vs "oniimuku" / "Grey Mullet" vs "Grey  Mullet " type
// spelling collisions so admins can merge them into one canonical artist.

function normalizeArtistName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function levDist(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

// GET /api/artists/duplicates — groups of likely-duplicate artists
// Normalizes (lowercase, strip non-alphanumeric), then groups by exact
// normalized match OR Levenshtein distance within a length-scaled threshold
// (1 for short names, 2 for medium, 3 for long). Union-find collapses chains
// so "oniimuku / Oniimukuu / OniiMuku " all land in one group.
router.get('/duplicates', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.name, a.total_releases,
              (SELECT COUNT(*) FROM contracts c WHERE c.artist_id = a.id)::int AS contract_count
       FROM artists a
       ORDER BY a.name ASC`
    );
    if (rows.length < 2) return res.json({ success: true, data: [] });

    // Skip very short normalized names (≤2 chars) — too many false positives
    const normed = rows.map(r => ({ ...r, _n: normalizeArtistName(r.name) })).filter(r => r._n.length >= 3);

    // Union-find
    const parent = new Map();
    const find = (x) => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)));
        x = parent.get(x);
      }
      return x;
    };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    normed.forEach(r => parent.set(r.id, r.id));

    for (let i = 0; i < normed.length; i++) {
      for (let j = i + 1; j < normed.length; j++) {
        const a = normed[i], b = normed[j];
        if (Math.abs(a._n.length - b._n.length) > 3) continue;
        if (a._n === b._n) { union(a.id, b.id); continue; }
        const d = levDist(a._n, b._n);
        const longer = Math.max(a._n.length, b._n.length);
        const threshold = longer <= 6 ? 1 : longer <= 12 ? 2 : 3;
        if (d <= threshold) union(a.id, b.id);
      }
    }

    const groups = new Map();
    for (const r of normed) {
      const root = find(r.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push({ id: r.id, name: r.name, total_releases: r.total_releases || 0, contract_count: r.contract_count || 0 });
    }

    // Only surface groups with 2+ members. Sort each group so the one with
    // the most releases (likely canonical) appears first — UI uses that as
    // the default "keep" selection.
    const result = [...groups.values()]
      .filter(g => g.length >= 2)
      .map(g => g.sort((a, b) => (b.total_releases + b.contract_count) - (a.total_releases + a.contract_count)));

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('GET /api/artists/duplicates:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/artists/:id/name — rename an artist. Admin only.
// Cascades the new name to every string-keyed reference — same tables the
// merge endpoint touches — so the ledger, deals, and income rows keep
// pointing at the renamed artist. FK-keyed tables (releases, contracts,
// artist_links, etc.) reference artist_id and don't need touching.
router.patch('/:id/name', authMiddleware, async (req, res) => {
  const role = (req.user?.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'superadmin') {
    return res.status(403).json({ success: false, error: 'Admin required' });
  }
  const id = parseInt(req.params.id, 10);
  const newName = String(req.body?.name || '').trim();
  if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
  if (!newName) return res.status(400).json({ success: false, error: 'name required' });
  if (newName.length > 200) return res.status(400).json({ success: false, error: 'name too long (max 200)' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: pre } = await client.query('SELECT id, name FROM artists WHERE id = $1', [id]);
    if (!pre.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Artist not found' });
    }
    const oldName = pre[0].name;
    if (oldName === newName) {
      await client.query('ROLLBACK');
      return res.json({ success: true, data: { id, name: oldName }, changed: false });
    }
    // Guard: if the new name already belongs to a DIFFERENT artist row,
    // the rename would silently split identities. Force the caller to
    // reach for the merge flow instead.
    const { rows: collision } = await client.query(
      'SELECT id FROM artists WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) AND id <> $2',
      [newName, id]
    );
    if (collision.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        error: `Another artist already exists with the name "${newName}" (id ${collision[0].id}). Use the merge flow instead.`,
      });
    }

    await client.query('UPDATE artists SET name = $1 WHERE id = $2', [newName, id]);
    // Cascade string-keyed references — case-insensitive match on the old
    // name so a spelling drift like "Ezri  " with trailing space still
    // gets picked up. Mirrors the same cascade the merge endpoint runs.
    await client.query(
      'UPDATE expenses SET artist = $1 WHERE LOWER(TRIM(artist)) = LOWER(TRIM($2))',
      [newName, oldName]
    );
    await client.query(
      'UPDATE deals SET artist_name = $1 WHERE LOWER(TRIM(artist_name)) = LOWER(TRIM($2))',
      [newName, oldName]
    );
    await client.query(
      'UPDATE artist_income SET artist_name = $1 WHERE LOWER(TRIM(artist_name)) = LOWER(TRIM($2))',
      [newName, oldName]
    );

    await client.query('COMMIT');
    res.json({ success: true, data: { id, name: newName, previous_name: oldName }, changed: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PATCH /api/artists/:id/name:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/artists/merge — merge from_id into to_id
// Destructive: reassigns every FK + string reference to the target, then
// deletes the source row. Admin/Superadmin only. Wrapped in a transaction
// so either all of it happens or none of it does.
router.post('/merge', authMiddleware, async (req, res) => {
  const role = (req.user?.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'superadmin') {
    return res.status(403).json({ success: false, error: 'Admin required' });
  }
  const fromId = parseInt(req.body.from_id, 10);
  const toId = parseInt(req.body.to_id, 10);
  if (!fromId || !toId || fromId === toId) {
    return res.status(400).json({ success: false, error: 'from_id and to_id required and must differ' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, name FROM artists WHERE id IN ($1, $2)', [fromId, toId]);
    const fromArtist = rows.find(r => r.id === fromId);
    const toArtist = rows.find(r => r.id === toId);
    if (!fromArtist || !toArtist) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Artist not found' });
    }

    await client.query('UPDATE releases SET artist_id = $1 WHERE artist_id = $2', [toId, fromId]);
    await client.query('UPDATE contracts SET artist_id = $1 WHERE artist_id = $2', [toId, fromId]);
    await client.query('UPDATE artist_links SET artist_id = $1 WHERE artist_id = $2', [toId, fromId]);
    await client.query('UPDATE artist_budget_items SET artist_id = $1 WHERE artist_id = $2', [toId, fromId]);
    await client.query('UPDATE artist_income SET artist_id = $1 WHERE artist_id = $2', [toId, fromId]);
    // Legacy artist_budgets (deprecated — still exists as dormant
    // backup; drop coming in a follow-up). Keep in sync so merges
    // during the transition don't leave orphan rows.
    await client.query('DELETE FROM artist_budgets WHERE artist_id = $1', [fromId]).catch(() => {});
    // Consolidated recording_budgets — same idea: at most one
    // artist-scoped row per artist. Drop the source artist's rows;
    // the target's rows stay.
    await client.query(
      `DELETE FROM recording_budgets WHERE artist_id = $1 AND release_id IS NULL`,
      [fromId]
    );
    // For release-scoped budgets the artist_id is just a lookup key;
    // point remaining rows at the target artist.
    await client.query(
      `UPDATE recording_budgets SET artist_id = $1 WHERE artist_id = $2 AND release_id IS NOT NULL`,
      [toId, fromId]
    );
    await client.query('DELETE FROM entity_files WHERE entity_type = $1 AND entity_id = $2', ['artist', fromId]);

    // String-keyed references — case-insensitive match on the old name
    await client.query('UPDATE expenses SET artist = $1 WHERE LOWER(TRIM(artist)) = LOWER(TRIM($2))', [toArtist.name, fromArtist.name]);
    await client.query('UPDATE deals SET artist_name = $1 WHERE LOWER(TRIM(artist_name)) = LOWER(TRIM($2))', [toArtist.name, fromArtist.name]);
    await client.query('UPDATE artist_income SET artist_name = $1 WHERE LOWER(TRIM(artist_name)) = LOWER(TRIM($2))', [toArtist.name, fromArtist.name]);

    await client.query('DELETE FROM artists WHERE id = $1', [fromId]);
    await client.query(
      'UPDATE artists SET total_releases = (SELECT COUNT(*) FROM releases WHERE artist_id = $1) WHERE id = $1',
      [toId]
    );

    await client.query('COMMIT');
    res.json({ success: true, data: { from: fromArtist, to: toArtist } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/artists/merge:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// Ensure artist_links table exists
pool.query(`
  CREATE TABLE IF NOT EXISTS artist_links (
    id SERIAL PRIMARY KEY,
    artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    platform VARCHAR(64) NOT NULL,
    url TEXT NOT NULL,
    label VARCHAR(128),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.error('artist_links migration error:', e));

// Add image_url column if it doesn't exist
pool.query(`ALTER TABLE artists ADD COLUMN IF NOT EXISTS image_url TEXT`)
  .catch(e => console.error('image_url migration error:', e));

// GET /api/artists/:id
// GET /api/artists/resolve?name=Rosa%20Vale → { id, name } or 404.
//
// Pages keyed by artist NAME (the budget sheet, Recoupments, Campaigns) need
// the roster row to link back to the profile. Matched on artistBucketKey —
// the same folding every money surface uses — so "rosa vale " finds Rosa Vale.
// Registered before /:id, or "resolve" would be read as an id.
// GET /api/artists/onboarding — every artist signed and not yet onboarded,
// with their open steps. Roster chips and the Home tile read this.
router.get('/onboarding', authMiddleware, async (req, res) => {
  try {
    const rows = await openOnboardings();
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Onboarding list error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/resolve', authMiddleware, async (req, res) => {
  try {
    const { artistBucketKey } = require('../lib/artist-key');
    const key = artistBucketKey(req.query.name);
    if (!key) return res.status(400).json({ success: false, error: 'name required' });
    const { rows } = await pool.query(
      `SELECT id, name FROM artists WHERE (archived = false OR archived IS NULL)`);
    const hit = rows.find((r) => artistBucketKey(r.name) === key);
    if (!hit) return res.status(404).json({ success: false, error: 'not on the roster' });
    res.json({ success: true, data: { id: hit.id, name: hit.name, artist_key: key } });
  } catch (err) {
    console.error('GET /api/artists/resolve:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const artistResult = await pool.query('SELECT * FROM artists WHERE id = $1', [req.params.id]);

    if (artistResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Artist not found' });
    }

    const artistName = artistResult.rows[0].name;
    // Contracts only surface for admin/superadmin/approver. Regular users see
    // an empty contracts array on the artist detail payload — same as if the
    // artist had no contracts on file.
    const userRole = (req.user?.role || '').toLowerCase();
    const canSeeContracts = userRole === 'admin' || userRole === 'superadmin' || userRole === 'approver';

    const [releasesResult, contractsResult, dealsResult, linksResult, filesResult, budgetResult, incomeResult, expensesResult] = await Promise.all([
      pool.query(
        `SELECT r.*, u.name as assigned_to_name
         FROM releases r
         LEFT JOIN users u ON r.assigned_to = u.id
         WHERE r.artist_id = $1 ORDER BY r.release_date DESC`,
        [req.params.id]
      ),
      canSeeContracts
        ? pool.query(
            `SELECT * FROM contracts WHERE artist_id = $1 ORDER BY expiration_date ASC`,
            [req.params.id]
          )
        : Promise.resolve({ rows: [] }),
      pool.query(
        `SELECT * FROM deals WHERE LOWER(artist_name) = LOWER($1) ORDER BY created_at DESC`,
        [artistName]
      ),
      pool.query(
        `SELECT * FROM artist_links WHERE artist_id = $1 ORDER BY created_at ASC`,
        [req.params.id]
      ),
      pool.query(
        // Metadata only — ef.file_data (base64 blob) served via download route.
        `SELECT ef.id, ef.entity_type, ef.entity_id, ef.filename, ef.original_name,
                ef.file_size, ef.uploaded_by, ef.uploaded_at, ef.label, ef.mime_type,
                u.name as uploaded_by_name
         FROM entity_files ef
         LEFT JOIN users u ON ef.uploaded_by = u.id
         WHERE ef.entity_type = 'artist' AND ef.entity_id = $1
         ORDER BY ef.uploaded_at DESC`,
        [req.params.id]
      ),
      // Artist-scoped budget from the consolidated recording_budgets
      // table. Response mirrors the legacy artist_budgets row shape
      // (artist_id, amount, advance, notes, updated_at) so downstream
      // pages don't need to change. amount uses total_amount_override
      // if set, else computed from line items + contingency.
      pool.query(`
        SELECT
          artist_id,
          COALESCE(
            total_amount_override,
            (SELECT COALESCE(SUM(li.amount), 0) FROM recording_budget_line_items li WHERE li.budget_id = rb.id)
              * (1 + COALESCE(contingency_pct, 0) / 100)
          )::float AS amount,
          COALESCE(advance_amount, 0)::float AS advance,
          notes, updated_at
        FROM recording_budgets rb
        WHERE artist_id = $1 AND release_id IS NULL
        LIMIT 1
      `, [req.params.id]).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT * FROM artist_income WHERE artist_id = $1 ORDER BY income_date DESC`,
        [req.params.id]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT id, invoice_date, payee, description, category, song, amount, currency, payment_status,
                recoupable, cobrand, parent_id
         FROM expenses
         WHERE LOWER(TRIM(artist)) = LOWER(TRIM($1))
           AND status = 'approved' AND (deleted = false OR deleted IS NULL)
           AND (voided = false OR voided IS NULL)
         ORDER BY invoice_date DESC`,
        [artistName]
      ).catch(() => ({ rows: [] })),
    ]);

    const budget = budgetResult.rows[0] || null;
    const totalIncome = incomeResult.rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    const totalExpenses = expensesResult.rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);

    res.json({
      success: true,
      data: {
        ...artistResult.rows[0],
        releases: releasesResult.rows,
        contracts: contractsResult.rows,
        deals: dealsResult.rows,
        links: linksResult.rows,
        files: filesResult.rows,
        budget,
        income: incomeResult.rows,
        expenses: expensesResult.rows,
        totalIncome,
        totalExpenses,
      },
    });
  } catch (error) {
    console.error('Get artist error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/artists/:id/links
router.post('/:id/links', authMiddleware, async (req, res) => {
  try {
    const { platform, url, label } = req.body;
    if (!platform || !url) {
      return res.status(400).json({ success: false, error: 'Platform and URL required' });
    }
    const result = await pool.query(
      `INSERT INTO artist_links (artist_id, platform, url, label, created_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
      [req.params.id, platform, url, label || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Create link error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/artists/:id/links/:linkId
router.put('/:id/links/:linkId', authMiddleware, async (req, res) => {
  try {
    const { platform, url, label } = req.body;
    const result = await pool.query(
      `UPDATE artist_links SET platform = COALESCE($1, platform), url = COALESCE($2, url),
       label = $3 WHERE id = $4 AND artist_id = $5 RETURNING *`,
      [platform, url, label || null, req.params.linkId, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Link not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update link error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/artists/:id/links/:linkId
router.delete('/:id/links/:linkId', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM artist_links WHERE id = $1 AND artist_id = $2`,
      [req.params.linkId, req.params.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Delete link error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/artists/:id/files
router.post('/:id/files', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    const artistCheck = await pool.query('SELECT id FROM artists WHERE id = $1', [req.params.id]);
    if (!artistCheck.rows.length) {
      return res.status(404).json({ success: false, error: 'Artist not found' });
    }
    const sanitized = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storedFilename = `${Date.now()}-${sanitized}`;
    const r2Key = `entity_files/artist/${req.params.id}/${storedFilename}`;
    await uploadFile(r2Key, req.file.buffer, req.file.mimetype);
    const result = await pool.query(
      `INSERT INTO entity_files (entity_type, entity_id, filename, original_name, file_size, uploaded_by, r2_key, mime_type, label)
       VALUES ('artist', $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      // label: optional, what put the file here ("Generated NDA") — read by the Documents tab.
      [req.params.id, storedFilename, req.file.originalname, req.file.size, req.user?.id || null, r2Key, req.file.mimetype,
       typeof req.body?.label === 'string' && req.body.label.trim() ? req.body.label.trim().slice(0, 128) : null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Upload artist file error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/artists/:id/files
router.get('/:id/files', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      // Metadata only — ef.file_data (base64 blob) served via download route.
      `SELECT ef.id, ef.entity_type, ef.entity_id, ef.filename, ef.original_name,
              ef.file_size, ef.uploaded_by, ef.uploaded_at, ef.label, ef.mime_type,
              u.name as uploaded_by_name
       FROM entity_files ef
       LEFT JOIN users u ON ef.uploaded_by = u.id
       WHERE ef.entity_type = 'artist' AND ef.entity_id = $1
       ORDER BY ef.uploaded_at DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get artist files error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/artists/:id/files/:fileId
router.delete('/:id/files/:fileId', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM entity_files WHERE id = $1 AND entity_type = 'artist' AND entity_id = $2 RETURNING *`,
      [req.params.fileId, req.params.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }
    if (result.rows[0].r2_key) {
      deleteFile(result.rows[0].r2_key).catch(err => console.warn('R2 delete failed:', err.message));
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Delete artist file error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Artist Budget Page ───────────────────────────────────────────────────
// The Budget tab on an artist's profile renders three things together:
//   1. Deal summary — aggregated from contracts.financial_terms +
//      contracts.advance across every non-expired contract for this artist.
//      Already populated on contract upload via POST /api/contracts/scan.
//   2. User-editable budget items (artist_budget_items) — placeholders for
//      planned spend that hasn't hit the ledger yet.
//   3. Auto-surfaced ledger rows — expenses where artist matches (case-
//      insensitive). Show child rows from split invoices, not parents, so a
//      multi-artist invoice only contributes each artist's slice.
// Edit perms (mutating endpoints) require admin/superadmin; GET is any
// authenticated user via the router-level auth middleware.

const isAdminArtist = (user) => {
  const role = (user?.role || '').toLowerCase();
  return role === 'admin' || role === 'superadmin';
};

// GET /api/artists/:id/budget
router.get('/:id/budget', authMiddleware, async (req, res) => {
  try {
    const artistId = parseInt(req.params.id);
    if (!artistId) return res.status(400).json({ success: false, error: 'Invalid artist id' });

    const artistRes = await pool.query('SELECT id, name FROM artists WHERE id = $1', [artistId]);
    if (!artistRes.rows.length) return res.status(404).json({ success: false, error: 'Artist not found' });
    const artist = artistRes.rows[0];

    // Deal summary — every active contract's advance + financial_terms
    const contractsRes = await pool.query(
      `SELECT id, type, status, date_signed, advance, financial_terms
       FROM contracts
       WHERE artist_id = $1 AND status NOT IN ('Expired', 'Terminated')
       ORDER BY date_signed DESC NULLS LAST`,
      [artistId]
    );

    const parseMoney = (v) => {
      if (v == null) return null;
      if (typeof v === 'number') return v;
      const raw = String(v).replace(/[$,]/g, '').trim();
      if (raw.includes('%') || raw === '') return null;
      const n = parseFloat(raw);
      return isNaN(n) ? null : n;
    };

    const dealLines = [];
    let dealAdvanceTotal = 0;
    for (const c of contractsRes.rows) {
      const adv = parseMoney(c.advance);
      if (adv != null && adv > 0) {
        dealLines.push({ contract_id: c.id, contract_type: c.type, label: 'Advance', amount: adv, recoupable: true, note: null });
        dealAdvanceTotal += adv;
      }
      const terms = Array.isArray(c.financial_terms) ? c.financial_terms : [];
      for (const t of terms) {
        const amt = parseMoney(t.amount);
        dealLines.push({
          contract_id: c.id,
          contract_type: c.type,
          label: t.label || 'Unnamed',
          amount: amt,
          raw_amount: amt == null ? (t.amount || null) : null,
          recoupable: t.recoupable !== false,
          note: t.note || null,
        });
      }
    }
    const dealTotal = dealLines.reduce((s, l) => s + (l.amount || 0), 0);


    // ── budgetItems and ledgerRows USED TO BE BUILT HERE ─────────────────────
    //
    // Removed 2026-08-24. Nothing read them: this endpoint's only consumer is
    // Recoupments.jsx, which takes `dealSummary` for its deal panel. The artist
    // spend sheets at /artist-budgets replaced both.
    //
    // The ledger query is worth naming rather than just deleting, because it was
    // a SECOND definition of "spend" and it was the wrong one: it matched
    // `LOWER(TRIM(e.artist))` — so "Jerri" and "jerri " were different artists —
    // and had no bank-evidence join at all, which meant an unpaid invoice counted
    // as money spent. Measured across the eight biggest artists before it went:
    // 31.3% of what it called spend, $538,345, was invoices nobody had paid.
    // /artist-budgets carries bankEvidenceCols and reports the four states apart.
    //
    // `artist_budget_items` is left in the database, unread. It holds one real
    // row and dropping a table to tidy a feature is not reversible.

    res.json({
      success: true,
      data: {
        artist: { id: artist.id, name: artist.name },
        dealSummary: {
          totalAdvance: dealAdvanceTotal,
          total: dealTotal,
          lines: dealLines,
        },
      },
    });
  } catch (err) {
    console.error('GET /api/artists/:id/budget:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/artists/:id/budget/expenses
// Creates a real expense (in expenses table) attributed to this artist, with
// optional receipt upload to R2. The Budget page submits its add-expense form
// here so the entry shows up on Financials, Expense Lookup, Recoupments, and
// the Ledger — not just the artist's own budget table.
// Open to any authenticated user — the Recoupments page's 'Add Expense'
// modal needs this for non-admin users. Created rows are tagged with
// req.user.name as created_by so we keep accountability; soft-delete is
// available from the same page for anything that lands here in error.
router.post('/:id/budget/expenses', authMiddleware, upload.single('receipt'), async (req, res) => {
  try {
    const artistId = parseInt(req.params.id);
    if (!artistId) return res.status(400).json({ success: false, error: 'Invalid artist id' });

    const { rows: artistRows } = await pool.query('SELECT name FROM artists WHERE id = $1', [artistId]);
    if (!artistRows.length) return res.status(404).json({ success: false, error: 'Artist not found' });
    const artistName = artistRows[0].name;

    const {
      release_id, payee, description, category, amount, currency,
      date, notes, paid, ufr, song, social_handles,
    } = req.body;

    if (!payee)       return res.status(400).json({ success: false, error: 'payee required' });
    if (amount == null || amount === '') return res.status(400).json({ success: false, error: 'amount required' });

    // Optional socials — accepts either an array (JSON body) or a
    // JSON-stringified array (multipart body). Empty rows drop out.
    let socialHandlesJson = null;
    try {
      const raw = typeof social_handles === 'string'
        ? JSON.parse(social_handles || '[]')
        : (Array.isArray(social_handles) ? social_handles : []);
      const cleaned = (raw || [])
        .map(s => ({ platform: String(s?.platform || '').trim(), handle: String(s?.handle || '').trim() }))
        .filter(s => s.handle);
      if (cleaned.length) socialHandlesJson = JSON.stringify(cleaned);
    } catch (_) { socialHandlesJson = null; }

    const amt = parseFloat(amount);
    if (!Number.isFinite(amt)) return res.status(400).json({ success: false, error: 'amount must be a number' });

    // Paid unless explicitly told otherwise — this endpoint only serves the
    // Recoupments add-expense modal, where added expenses default to Paid.
    // An omitted `paid` (older client bundle) must not create Unpaid rows.
    const isPaid = paid === undefined || paid === null || paid === ''
      ? true
      : (paid === true || paid === 'true' || paid === 'on');
    // Budget-page expenses are always recoupable by policy — the toggle was
    // removed from the form. Any incoming `recoupable` field is ignored.
    const isRecoup = true;
    const isUfr = ufr === true || ufr === 'true' || ufr === 'on';

    const dueDate = (() => {
      if (!date) return null;
      const d = new Date(date);
      if (Number.isNaN(d.getTime())) return null;
      d.setDate(d.getDate() + 30);
      return d.toISOString().slice(0, 10);
    })();

    // Auto-fill song from the linked release's project name so the Expense
    // Lookup page (which filters on e.song ILIKE %Loop%) can find this entry
    // when the user picked the release from the dropdown without typing a
    // separate song value. Caller-supplied 'song' wins.
    let resolvedSong = song || null;
    if (!resolvedSong && release_id) {
      try {
        const r = await pool.query('SELECT project_name FROM releases WHERE id = $1', [release_id]);
        if (r.rows.length) resolvedSong = r.rows[0].project_name || null;
      } catch (_) { /* fall back to null */ }
    }

    // Create expense row. Budget page is admin-only, so status='approved'.
    // approved_at, created_at = NOW() inline; in_quickbooks/uploaded_to_stem
    // default to 'No'; vendor_* + cobrand are NULL/false on this path.
    const insert = await pool.query(`
      INSERT INTO expenses
        (invoice_date, payee, description, category, artist, song,
         amount, currency, notes, recoupable, ufr,
         payment_status, payment_date, paid_by,
         release_id, payment_terms, scheduled_payment_date,
         status, approved_by, approved_at,
         created_by, created_at,
         in_quickbooks, uploaded_to_stem,
         is_reimbursement, cobrand)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),$20,NOW(),'No','No',$21,FALSE)
      RETURNING id`,
      [
        date || null, payee, description, category || null, artistName, resolvedSong,
        amt, (currency || 'USD').toUpperCase(), notes || null, isRecoup, isUfr ? 'Yes' : 'No',
        isPaid ? 'Paid' : 'Unpaid',
        isPaid ? (date || new Date().toISOString().slice(0, 10)) : null,
        isPaid ? (req.user?.name || null) : null,
        release_id ? Number(release_id) : null,
        'Net 30', dueDate,
        'approved', req.user?.name || null,
        req.user?.name || null,
        !!req.file, // is_reimbursement when a receipt was attached
      ]
    );
    const entryId = insert.rows[0].id;

    // Tag as Recoupments-originated. This endpoint is only ever called
    // from the Recoupments "Add expense" modal in artist context, so the
    // origin is unambiguous — no need to read a body flag.
    try {
      await pool.query(`UPDATE expenses SET entry_source = 'recoupments' WHERE id = $1`, [entryId]);
    } catch (_) {}
    // Optional socials — stamped as a follow-up so we don't have to
    // thread another placeholder through the INSERT above.
    if (socialHandlesJson) {
      try {
        await pool.query(`UPDATE expenses SET social_handles = $1::jsonb WHERE id = $2`, [socialHandlesJson, entryId]);
      } catch (_) {}
    }

    // Upload receipt to R2 if present. We use the legacy single-receipt
    // column path (receipt_data + receipt_filename) — that's what the Ledger
    // and Lookup pages expect. R2 isn't wired for receipts yet (per CLAUDE.md
    // they're still on the legacy base64 path), but we keep the buffer small.
    if (req.file) {
      await pool.query(
        `UPDATE expenses SET receipt_data = $1, receipt_filename = $2 WHERE id = $3`,
        [req.file.buffer.toString('base64'), req.file.originalname, entryId]
      );
    }

    res.status(201).json({ success: true, data: { id: entryId } });
  } catch (err) {
    console.error('POST /api/artists/:id/budget/expenses:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// DELETE /api/artists/:id — superadmin only
// PATCH /api/artists/:id/archive — body { archived: bool }
// Soft-archive an artist when their deal is finished. Reversible; the
// row stays in place so historical references (releases, contracts,
// expenses) keep resolving. Auth-required but no admin gate — archive
// is reversible, unlike DELETE which is Superadmin-only.
router.patch('/:id/archive', authMiddleware, async (req, res) => {
  try {
    const artistId = parseInt(req.params.id, 10);
    if (!artistId) return res.status(400).json({ success: false, error: 'Invalid id' });
    if (typeof req.body?.archived !== 'boolean') {
      return res.status(400).json({ success: false, error: 'archived (boolean) required' });
    }
    const archived = req.body.archived;
    // archived_by is INT; both branches of the CASE need explicit casts
    // so PostgreSQL doesn't fall back to text type-inference when the
    // parameter sits inside a CASE expression with no other context.
    // Without the cast, node-pg-sent params get treated as text and the
    // assignment to the INT column fails with "expression is of type text".
    const userId = req.user?.id ? parseInt(req.user.id, 10) || null : null;
    const { rows } = await pool.query(
      `UPDATE artists
          SET archived = $1,
              archived_at = CASE WHEN $1 = TRUE THEN NOW() ELSE NULL END,
              archived_by = CASE WHEN $1 = TRUE THEN $2::int ELSE NULL::int END
        WHERE id = $3
        RETURNING id, name, archived`,
      [archived, userId, artistId]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Artist not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('PATCH /api/artists/:id/archive:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const role = (req.user?.role || '').toLowerCase();
    if (role !== 'superadmin') {
      return res.status(403).json({ success: false, error: 'Superadmin access required' });
    }
    const artistId = parseInt(req.params.id);

    // Releases are real catalog data — refuse the delete with a clear
    // message instead of orphaning them (or 500ing on the FK, which is
    // what the old swallowed-error path did).
    const { rows: relRows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM releases WHERE artist_id = $1', [artistId]
    );
    if ((relRows[0]?.n || 0) > 0) {
      return res.status(409).json({
        success: false,
        error: `This artist has ${relRows[0].n} release${relRows[0].n === 1 ? '' : 's'}. Delete or reassign them first.`,
      });
    }

    // Clean up everything else atomically: entity_files (composite key, no
    // FK), then a dynamic sweep of every non-cascading FK to artists
    // (lib/fkSweep) so new artist_id columns can't re-break this delete.
    const client = await pool.connect();
    let deletedName = null;
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM entity_files WHERE entity_type = 'artist' AND entity_id = $1`, [artistId]);
      await clearForeignKeyRefs('artists', artistId, { db: client, skipTables: ['releases'] });
      const { rows } = await client.query('DELETE FROM artists WHERE id = $1 RETURNING name', [artistId]);
      deletedName = rows.length ? rows[0].name : null;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (!deletedName) return res.status(404).json({ success: false, error: 'Artist not found' });

    res.json({ success: true, message: `Deleted ${deletedName}` });
  } catch (err) {
    console.error('Delete artist error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/artists/sync-images — fetch Spotify profile images for all artists
router.post('/sync-images', authMiddleware, async (req, res) => {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(400).json({
      success: false,
      error: 'Spotify credentials not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your Railway environment variables.',
    });
  }

  try {
    // Get Spotify access token via client credentials flow
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      },
      body: 'grant_type=client_credentials',
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('Spotify token error: status', tokenRes.status);
      return res.status(401).json({ success: false, error: 'Invalid Spotify credentials' });
    }

    const { access_token } = await tokenRes.json();

    // Get all artists
    const artistsResult = await pool.query('SELECT id, name FROM artists ORDER BY name');
    const artists = artistsResult.rows;

    // Get all Spotify links grouped by artist_id
    const linksResult = await pool.query(
      `SELECT artist_id, url FROM artist_links WHERE LOWER(platform) = 'spotify'`
    );
    const spotifyLinkMap = {};
    for (const link of linksResult.rows) {
      spotifyLinkMap[link.artist_id] = link.url;
    }

    let updated = 0;
    let notFound = 0;

    for (const artist of artists) {
      try {
        let imageUrl = null;

        // Try direct lookup via stored Spotify link
        const spotifyUrl = spotifyLinkMap[artist.id];
        if (spotifyUrl) {
          const match = spotifyUrl.match(/spotify\.com\/artist\/([a-zA-Z0-9]+)/);
          if (match) {
            const spotifyId = match[1];
            const artistRes = await fetch(`https://api.spotify.com/v1/artists/${spotifyId}`, {
              headers: { 'Authorization': `Bearer ${access_token}` },
            });
            if (artistRes.ok) {
              const data = await artistRes.json();
              if (data.images && data.images.length > 0) {
                imageUrl = data.images[0].url;
              }
            }
          }
        }

        // Fall back to search by name
        if (!imageUrl) {
          const searchRes = await fetch(
            `https://api.spotify.com/v1/search?q=${encodeURIComponent(artist.name)}&type=artist&limit=1`,
            { headers: { 'Authorization': `Bearer ${access_token}` } }
          );
          if (searchRes.ok) {
            const data = await searchRes.json();
            const items = data.artists?.items;
            if (items && items.length > 0 && items[0].images && items[0].images.length > 0) {
              imageUrl = items[0].images[0].url;
            }
          }
        }

        if (imageUrl) {
          await pool.query('UPDATE artists SET image_url = $1 WHERE id = $2', [imageUrl, artist.id]);
          updated++;
        } else {
          notFound++;
        }
      } catch (err) {
        console.error(`Image fetch failed for ${artist.name}:`, err.message);
        notFound++;
      }

      // Small delay to respect Spotify rate limits
      await new Promise(r => setTimeout(r, 100));
    }

    res.json({ success: true, data: { updated, notFound, total: artists.length } });
  } catch (error) {
    console.error('Sync images error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Spotify helpers ────────────────────────────────────────────────────────
async function getSpotifyToken() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  if (!tokenRes.ok) return null;
  const { access_token } = await tokenRes.json();
  return access_token;
}

async function resolveSpotifyArtistId(artistId, artistName, token) {
  // Try stored Spotify link first
  const { rows } = await pool.query(
    `SELECT url FROM artist_links WHERE artist_id = $1 AND LOWER(platform) = 'spotify' LIMIT 1`,
    [artistId]
  );
  if (rows.length) {
    const match = rows[0].url.match(/artist\/([a-zA-Z0-9]+)/);
    if (match) return match[1];
  }
  // Fall back to search
  const searchRes = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(artistName)}&type=artist&limit=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!searchRes.ok) return null;
  const data = await searchRes.json();
  return data.artists?.items?.[0]?.id || null;
}

// ─── Artist stats: the daily Spotify (+ Chartmetric) feed, lib/artist-stats.js ───
// GET  /api/artists/:id/stats            latest + last 90 days, both sources
// POST /api/artists/:id/stats/refresh    fetch today's numbers for this artist now
// POST /api/artists/stats/refresh        admin: the whole roster now
router.post('/stats/refresh', authMiddleware, async (req, res) => {
  try {
    if (!['Admin', 'Superadmin'].includes(req.user.role)) return res.status(403).json({ success: false, error: 'Admin only' });
    res.json({ success: true, data: await require('../lib/artist-stats').refreshAll() });
  } catch (err) { console.error('stats refresh error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});
router.get('/:id/stats', authMiddleware, async (req, res) => {
  try { res.json({ success: true, data: await require('../lib/artist-stats').history(Number(req.params.id)) }); }
  catch (err) { console.error('stats error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});
router.post('/:id/stats/refresh', authMiddleware, async (req, res) => {
  try {
    const { rows: [artist] } = await pool.query('SELECT id, name, spotify_id, spotify_url, chartmetric_id FROM artists WHERE id = $1', [Number(req.params.id)]);
    if (!artist) return res.status(404).json({ success: false, error: 'Artist not found' });
    const stats = require('../lib/artist-stats');
    const out = await stats.refreshArtist(artist);
    res.json({ success: true, data: { ...out, ...(await stats.history(artist.id)) } });
  } catch (err) { console.error('stats refresh error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

// GET /api/artists/:id/spotify — full Spotify profile for an artist
// Uses current (2026) Spotify Web API — many endpoints deprecated, so we use
// search + albums (limit 10 max) to build the profile.
router.get('/:id/spotify', authMiddleware, async (req, res) => {
  try {
    const token = await getSpotifyToken();
    if (!token) {
      return res.status(400).json({ success: false, error: 'Spotify credentials not configured.' });
    }

    const artistResult = await pool.query('SELECT id, name FROM artists WHERE id = $1', [req.params.id]);
    if (!artistResult.rows.length) return res.status(404).json({ success: false, error: 'Artist not found' });
    const artist = artistResult.rows[0];

    const spotifyId = await resolveSpotifyArtistId(artist.id, artist.name, token);
    if (!spotifyId) {
      return res.json({ success: true, data: null, message: 'Artist not found on Spotify' });
    }

    const headers = { Authorization: `Bearer ${token}` };

    // Fetch profile + albums (limit=10 is the API max) + search for tracks by this artist
    const [profileRes, albumsRes, tracksSearchRes] = await Promise.all([
      fetch(`https://api.spotify.com/v1/artists/${spotifyId}`, { headers }),
      fetch(`https://api.spotify.com/v1/artists/${spotifyId}/albums?include_groups=album,single&limit=10`, { headers }),
      fetch(`https://api.spotify.com/v1/search?q=artist:${encodeURIComponent(artist.name)}&type=track&limit=20`, { headers }),
    ]);

    console.log(`Spotify API statuses for "${artist.name}" (${spotifyId}): profile=${profileRes.status}, albums=${albumsRes.status}, trackSearch=${tracksSearchRes.status}`);

    const profile = profileRes.ok ? await profileRes.json() : null;
    const albums = albumsRes.ok ? await albumsRes.json() : null;
    const tracksSearch = tracksSearchRes.ok ? await tracksSearchRes.json() : null;

    // Filter search results to only tracks by this artist
    const artistTracks = (tracksSearch?.tracks?.items || []).filter(t =>
      t.artists?.some(a => a.id === spotifyId)
    );

    // Get more album pages if available
    let allAlbumItems = albums?.items || [];
    if (albums?.next) {
      try {
        const page2Res = await fetch(albums.next, { headers });
        if (page2Res.ok) {
          const page2 = await page2Res.json();
          allAlbumItems = [...allAlbumItems, ...(page2.items || [])];
          if (page2.next) {
            const page3Res = await fetch(page2.next, { headers });
            if (page3Res.ok) {
              const page3 = await page3Res.json();
              allAlbumItems = [...allAlbumItems, ...(page3.items || [])];
            }
          }
        }
      } catch (err) {
        console.warn('Album pagination failed:', err.message);
      }
    }

    console.log(`Spotify results for "${artist.name}": popularity=${profile?.popularity}, followers=${profile?.followers?.total}, tracks=${artistTracks.length}, albums=${allAlbumItems.length}`);

    res.json({
      success: true,
      data: {
        spotify_id: spotifyId,
        profile: profile ? {
          name: profile.name,
          popularity: profile.popularity || 0,
          followers: profile.followers?.total || 0,
          genres: profile.genres || [],
          images: profile.images || [],
          external_url: profile.external_urls?.spotify,
        } : null,
        top_tracks: artistTracks.map(t => ({
          id: t.id,
          name: t.name,
          popularity: t.popularity || 0,
          preview_url: t.preview_url,
          duration_ms: t.duration_ms,
          album: { name: t.album?.name, image: t.album?.images?.[t.album.images.length > 1 ? 1 : 0]?.url, release_date: t.album?.release_date },
          external_url: t.external_urls?.spotify,
        })),
        audio_features: [],
        related_artists: [],
        albums: allAlbumItems.map(a => ({
          id: a.id,
          name: a.name,
          release_date: a.release_date,
          total_tracks: a.total_tracks,
          album_type: a.album_type,
          image: a.images?.[a.images.length > 1 ? 1 : 0]?.url,
          external_url: a.external_urls?.spotify,
          markets_count: a.available_markets?.length || 0,
        })),
      },
    });
  } catch (error) {
    console.error('Spotify profile error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch Spotify data' });
  }
});

// POST /api/artists
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, genre } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, error: 'Artist name required' });
    }

    const result = await pool.query(
      'INSERT INTO artists (name, genre, created_at) VALUES ($1, $2, NOW()) RETURNING *',
      [name, genre || null]
    );

    res.status(201).json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ success: false, error: 'Artist name already exists' });
    }
    console.error('Create artist error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── Development Log ─────────────────────────────────────────────────────
// Timeline of A&R touchpoints (meetings, demos, follow-ups, etc.) per
// artist. Schema lives in server/migrations/add_artist_development_log.js.

const DEVLOG_ENTRY_TYPES = [
  'Meeting', 'Demo Received', 'Feedback Sent', 'Offer Made',
  'Follow-up', 'Call', 'Email', 'Note',
];
const DEVLOG_ADMIN_ROLES = new Set(['Superadmin', 'Admin', 'Approver']);

// GET /api/artists/:id/devlog
router.get('/:id/devlog', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.id, l.artist_id, l.entry_type, l.date, l.summary,
              l.created_by, l.created_at, u.name AS created_by_name
       FROM artist_development_log l
       LEFT JOIN users u ON u.id = l.created_by
       WHERE l.artist_id = $1
       ORDER BY l.date DESC, l.created_at DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get devlog error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/artists/:id/devlog
router.post('/:id/devlog', authMiddleware, async (req, res) => {
  try {
    const { entry_type, date, summary } = req.body;

    if (!summary || !String(summary).trim()) {
      return res.status(400).json({ success: false, error: 'Summary required' });
    }
    if (entry_type && !DEVLOG_ENTRY_TYPES.includes(entry_type)) {
      return res.status(400).json({ success: false, error: 'Invalid entry_type' });
    }

    // Verify the artist exists so we surface a 404 instead of an FK error.
    const artistCheck = await pool.query('SELECT id FROM artists WHERE id = $1', [req.params.id]);
    if (!artistCheck.rows.length) {
      return res.status(404).json({ success: false, error: 'Artist not found' });
    }

    const result = await pool.query(
      `INSERT INTO artist_development_log
         (artist_id, entry_type, date, summary, created_by)
       VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5)
       RETURNING id, artist_id, entry_type, date, summary, created_by, created_at`,
      [req.params.id, entry_type || null, date || null, String(summary).trim(), req.user?.id || null]
    );

    // Re-fetch with the joined created_by_name so the client gets the same
    // shape it would get back from the list endpoint — no special-case in
    // the timeline renderer.
    const enriched = await pool.query(
      `SELECT l.id, l.artist_id, l.entry_type, l.date, l.summary,
              l.created_by, l.created_at, u.name AS created_by_name
       FROM artist_development_log l
       LEFT JOIN users u ON u.id = l.created_by
       WHERE l.id = $1`,
      [result.rows[0].id]
    );

    res.status(201).json({ success: true, data: enriched.rows[0] });
  } catch (error) {
    console.error('Create devlog entry error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/artists/:id/devlog/:entryId
// Author can always delete their own; Admin / Superadmin / Approver can
// delete anyone's. Otherwise 403.
router.delete('/:id/devlog/:entryId', authMiddleware, async (req, res) => {
  try {
    const entry = await pool.query(
      'SELECT id, created_by FROM artist_development_log WHERE id = $1 AND artist_id = $2',
      [req.params.entryId, req.params.id]
    );
    if (!entry.rows.length) {
      return res.status(404).json({ success: false, error: 'Entry not found' });
    }

    const userId = req.user?.id;
    const role = req.user?.role;
    const isAdmin = DEVLOG_ADMIN_ROLES.has(role);
    if (entry.rows[0].created_by !== userId && !isAdmin) {
      return res.status(403).json({ success: false, error: 'Not authorized to delete this entry' });
    }

    await pool.query('DELETE FROM artist_development_log WHERE id = $1', [req.params.entryId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete devlog entry error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Onboarding (2026-09-18) ───────────────────────────────────────────────
// GET /api/artists/:id/onboarding — the five steps, computed (lib/onboarding)
router.get('/:id(\\d+)/onboarding', authMiddleware, async (req, res) => {
  try {
    const o = await onboardingFor(req.params.id);
    if (!o) return res.status(404).json({ success: false, error: 'Artist not found' });
    res.json({ success: true, data: o });
  } catch (error) {
    console.error('Onboarding error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/artists/:id/contact — email, phone, manager, socials, Spotify link
router.put('/:id(\\d+)/contact', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const str = (v) => (v === undefined ? undefined : (v === null ? null : (String(v).trim() || null)));
    const email = str(b.email), mgrEmail = str(b.manager_email);
    const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || ''));
    if (email && !isEmail(email)) return res.status(400).json({ success: false, error: 'Email is not an email address' });
    if (mgrEmail && !isEmail(mgrEmail)) return res.status(400).json({ success: false, error: 'Manager email is not an email address' });
    let socials;
    if (b.socials !== undefined) {
      socials = Array.isArray(b.socials)
        ? JSON.stringify(b.socials.map((x) => ({ platform: str(x?.platform), handle: str(x?.handle) })).filter((x) => x.platform && x.handle))
        : null;
    }
    const { rows: [a] } = await pool.query(
      `UPDATE artists SET
         email         = CASE WHEN $2::boolean THEN $3 ELSE email END,
         phone         = CASE WHEN $4::boolean THEN $5 ELSE phone END,
         manager_name  = CASE WHEN $6::boolean THEN $7 ELSE manager_name END,
         manager_email = CASE WHEN $8::boolean THEN $9 ELSE manager_email END,
         socials       = CASE WHEN $10::boolean THEN $11::jsonb ELSE socials END,
         spotify_url   = CASE WHEN $12::boolean THEN $13 ELSE spotify_url END
       WHERE id = $1 RETURNING id, name, email, phone, manager_name, manager_email, socials, spotify_url, signed_at, onboarded_at`,
      [req.params.id,
       b.email !== undefined, email ?? null,
       b.phone !== undefined, str(b.phone) ?? null,
       b.manager_name !== undefined, str(b.manager_name) ?? null,
       b.manager_email !== undefined, mgrEmail ?? null,
       socials !== undefined, socials ?? null,
       b.spotify_url !== undefined, str(b.spotify_url) ?? null]);
    if (!a) return res.status(404).json({ success: false, error: 'Artist not found' });
    res.json({ success: true, data: a });
  } catch (error) {
    console.error('Artist contact error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Payment details typed in by the team. Same validators and the same encrypted
// store the public vendor form writes (vendor_payment_details, keyed on the
// artist's email), so the checklist and the Payments queue read one record.
// Only the roles that may already decrypt vendor details may write here, and
// every write leaves a bk_audit_log row. The response never echoes a number.
const PAY_ROLES = new Set(['Admin', 'Superadmin', 'Approver']);
router.post('/:id(\\d+)/payment-details', authMiddleware, async (req, res) => {
  try {
    if (!PAY_ROLES.has(req.user?.role)) return res.status(403).json({ success: false, error: 'Only bookkeeping roles can enter payment details' });
    const { rows: [a] } = await pool.query('SELECT id, name, email FROM artists WHERE id = $1', [req.params.id]);
    if (!a) return res.status(404).json({ success: false, error: 'Artist not found' });
    if (!a.email) return res.status(400).json({ success: false, error: "Add the artist's email first — payment details are filed by email" });
    if (!paymentCrypto.isConfigured()) return res.status(503).json({ success: false, error: 'Payment details cannot be stored: encryption key not configured' });
    const b = req.body || {};
    const method = String(b.payment_method || b.method || '').trim();
    const check = validatePaymentFields(method, b);
    if (!check.ok) return res.status(400).json({ success: false, error: check.errors.join(' '), errors: check.errors });
    const n = check.normalized;
    // last4 is dropped for PayPal — the tail of an email identifies nothing (see the snapshot rule)
    const l4 = method === 'PayPal' ? null : payLast4(method, n);
    await pool.query(`
      INSERT INTO vendor_payment_details
        (vendor_email, vendor_name, method, account_enc, routing_enc, iban_enc,
         paypal_handle, account_last4, holder_name, bank_address, account_type,
         bank_name, beneficiary_address, intermediary_bank, wire_scope, updated_at)
      VALUES (LOWER($1),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
      ON CONFLICT (vendor_email) DO UPDATE SET
        vendor_name = EXCLUDED.vendor_name, method = EXCLUDED.method,
        account_enc = EXCLUDED.account_enc, routing_enc = EXCLUDED.routing_enc,
        iban_enc = EXCLUDED.iban_enc, paypal_handle = EXCLUDED.paypal_handle,
        account_last4 = EXCLUDED.account_last4, holder_name = EXCLUDED.holder_name,
        bank_address = EXCLUDED.bank_address, account_type = EXCLUDED.account_type,
        bank_name = EXCLUDED.bank_name, beneficiary_address = EXCLUDED.beneficiary_address,
        intermediary_bank = EXCLUDED.intermediary_bank, wire_scope = EXCLUDED.wire_scope, updated_at = NOW()`,
      [a.email, a.name, method,
       n.account_number ? paymentCrypto.encrypt(n.account_number) : null,
       n.routing_number ? paymentCrypto.encrypt(n.routing_number) : null,
       n.iban_swift ? paymentCrypto.encrypt(n.iban_swift) : null,
       n.paypal || null, l4, n.holder_name || null,
       n.bank_address || null, n.account_type || null, n.bank_name || null,
       n.beneficiary_address || null, n.intermediary_bank || null, n.wire_scope || null]);
    await pool.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1, 'artist_payment_details_typed', NULL, $2, 'payment_details', NULL, $3, $4)`,
      [req.user.name || req.user.email, a.name, method, `typed on the artist profile (artist #${a.id}); last4 ${l4 || '—'}`]
    ).catch(() => {});
    res.json({ success: true, data: { on_file: true, method, last4: l4, holder_name: n.holder_name || null } });
  } catch (error) {
    console.error('Artist payment details error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
