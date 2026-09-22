const express = require('express');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { relinkExpensesForRelease } = require('../lib/release-linking');
const { postEvent, fmtDate } = require('../lib/activityBot');

const router = express.Router();

// Migration: ensure in_catalog column exists (safe to run on every startup)
pool.query(`ALTER TABLE releases ADD COLUMN IF NOT EXISTS in_catalog BOOLEAN DEFAULT false`)
  .then(() => {
    // Backfill: move past releases into catalog, move future releases out of catalog
    return pool.query(`
      UPDATE releases
      SET in_catalog = true
      WHERE release_date < CURRENT_DATE
        AND (archived = false OR archived IS NULL)
        AND (in_catalog = false OR in_catalog IS NULL)
    `).then(() => pool.query(`
      UPDATE releases
      SET in_catalog = false
      WHERE release_date >= CURRENT_DATE
        AND in_catalog = true
    `)).then(() => pool.query(`
      UPDATE releases
      SET priority = 'standard'
      WHERE release_date < CURRENT_DATE
        AND priority IS NOT NULL AND priority != 'standard'
    `));
  })
  .catch(() => {});

// Migration: ensure cover_art_url column exists
pool.query(`ALTER TABLE releases ADD COLUMN IF NOT EXISTS cover_art_url VARCHAR(500)`)
  .catch(() => {});

// Helper: write to activity_log (fire-and-forget, never throws)
const logActivity = async (userId, action, detail) => {
  try {
    await pool.query(
      `INSERT INTO activity_log (user_id, action, detail, created_at) VALUES ($1, $2, $3, NOW())`,
      [userId, action, detail]
    );
  } catch (_) {}
};

// POST /api/releases/sync-artwork
// Fetches Spotify cover art for up to 200 releases that are missing it.
// Call repeatedly until all releases are covered. Requires SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET.
router.post('/sync-artwork', authMiddleware, async (req, res) => {
  const { getArtworkUrl, searchArtworkUrl } = require('../services/spotify');
  try {
    const includeNotFound = req.body.retry === true;
    // Optional: scope to releases in the last N days (used by Dashboard's
    // "Latest Releases" row so it doesn't sweep the entire back catalog).
    const days = Math.max(0, parseInt(req.body.days ?? req.query.days, 10) || 0);
    const recentClause = days > 0 ? ` AND release_date >= CURRENT_DATE - INTERVAL '${days} days'` : '';
    const recentClauseR = days > 0 ? ` AND r.release_date >= CURRENT_DATE - INTERVAL '${days} days'` : '';

    // force=true resets cover_art_url in scope so the sync re-evaluates every
    // release from scratch. Safe because Phase 1 will re-populate URI'd rows
    // with the canonical Spotify image, and Phase 2 uses the strict matcher.
    if (req.body.force === true) {
      await pool.query(`UPDATE releases SET cover_art_url = NULL WHERE 1=1${recentClause}`);
    }

    // Phase 1: Releases with a Spotify URI but no artwork
    const { rows } = await pool.query(
      `SELECT id, spotify_uri FROM releases
       WHERE spotify_uri IS NOT NULL
         AND spotify_uri != ''
         AND (cover_art_url IS NULL OR cover_art_url = '' ${includeNotFound ? "OR cover_art_url = 'not_found'" : ''})${recentClause}
       LIMIT 500`
    );

    let updated = 0;
    for (const r of rows) {
      try {
        const url = await getArtworkUrl(r.spotify_uri);
        if (url) {
          await pool.query(
            `UPDATE releases SET cover_art_url = $1 WHERE id = $2`,
            [url, r.id]
          );
          updated++;
        } else {
          // Permanent: bad URI format, Spotify 404, or no images — mark so
          // we don't re-process every sync.
          await pool.query(
            `UPDATE releases SET cover_art_url = 'not_found' WHERE id = $1`,
            [r.id]
          ).catch(() => {});
        }
      } catch (err) {
        // Transient (rate limit, 5xx, network). Leave cover_art_url as NULL
        // so the next sync picks it back up.
        console.warn(`[sync-artwork] phase1 transient error on #${r.id}:`, err.message);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Phase 2: Releases still without artwork (URI-less, or URI rows that
    // Phase 1 couldn't resolve). Search Spotify by artist + title with the
    // strict matcher. `retry=true` lets us reprocess prior 'not_found' rows.
    const { rows: noUri } = await pool.query(
      `SELECT r.id, r.project_name, a.name AS artist_name FROM releases r
       LEFT JOIN artists a ON a.id = r.artist_id
       WHERE (r.cover_art_url IS NULL OR r.cover_art_url = '' ${includeNotFound ? "OR r.cover_art_url = 'not_found'" : ''})${recentClauseR}
       LIMIT 200`
    );

    let searchUpdated = 0;
    for (const r of noUri) {
      try {
        const url = await searchArtworkUrl(r.artist_name, r.project_name);
        if (url) {
          await pool.query(
            `UPDATE releases SET cover_art_url = $1 WHERE id = $2`,
            [url, r.id]
          );
          searchUpdated++;
        } else {
          // Strict matcher couldn't confidently identify the release on
          // Spotify — genuinely "no match". Mark so the batch loop can
          // terminate. User can paste a spotify_uri manually to override.
          await pool.query(
            `UPDATE releases SET cover_art_url = 'not_found' WHERE id = $1`,
            [r.id]
          ).catch(() => {});
        }
      } catch (err) {
        // Transient — leave NULL so the next sync retries this release.
        console.warn(`[sync-artwork] phase2 transient error on #${r.id}:`, err.message);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    updated += searchUpdated;

    // Remaining count excludes 'not_found' — those are "tried, couldn't
    // match, user would have to set spotify_uri manually". Otherwise the
    // client's batching loop would never terminate on untracked releases.
    const remaining = await pool.query(
      `SELECT COUNT(*) FROM releases
       WHERE (cover_art_url IS NULL OR cover_art_url = '')${recentClause}`
    );

    res.json({
      success: true,
      data: {
        updated,
        total: rows.length + noUri.length,
        remaining: parseInt(remaining.rows[0].count),
        searched: noUri.length,
        search_found: searchUpdated,
      },
    });
  } catch (err) {
    console.error('sync-artwork error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/releases/duplicates
// Returns groups of releases that look like potential duplicates, based on
// matching artist+name, UPC, ISRC, or Spotify URI. Archived releases are
// excluded (a dup that's already archived is considered resolved).
router.get('/duplicates', authMiddleware, async (req, res) => {
  try {
    // Build an idempotent group list. `key` is the dedup signal, `reason` is
    // the human-readable label. The FE joins groups that share ids.
    // Placeholder values people type when a real identifier isn't known yet.
    // Grouping on these would falsely flag every placeholder row as a duplicate
    // of every other (e.g. 40 unrelated releases all with ISRC "n/a").
    const SENTINEL_VALUES = "('n/a', 'na', 'none', 'tbd', '-', '—', 'unknown', 'missing', 'pending', '?', '0', '00')";
    const sentinelGuard = (col) => `LOWER(TRIM(${col})) NOT IN ${SENTINEL_VALUES}`;

    const groupQueries = [
      {
        reason: 'Same artist & project name',
        key: "a.id || '|' || LOWER(TRIM(r.project_name))",
        where: "r.project_name IS NOT NULL AND TRIM(r.project_name) != ''",
      },
      {
        reason: 'Same UPC',
        key: 'LOWER(TRIM(r.upc))',
        where: `r.upc IS NOT NULL AND TRIM(r.upc) != '' AND ${sentinelGuard('r.upc')}`,
      },
      {
        reason: 'Same ISRC',
        key: 'LOWER(TRIM(r.isrc))',
        where: `r.isrc IS NOT NULL AND TRIM(r.isrc) != '' AND ${sentinelGuard('r.isrc')}`,
      },
      {
        reason: 'Same Spotify URI',
        key: 'LOWER(TRIM(r.spotify_uri))',
        where: `r.spotify_uri IS NOT NULL AND TRIM(r.spotify_uri) != '' AND ${sentinelGuard('r.spotify_uri')}`,
      },
    ];

    const groups = [];
    for (const { reason, key, where } of groupQueries) {
      const { rows } = await pool.query(`
        SELECT ${key} AS group_key,
               ARRAY_AGG(
                 json_build_object(
                   'id', r.id,
                   'project_name', r.project_name,
                   'artist_id', r.artist_id,
                   'artist_name', a.name,
                   'release_date', r.release_date,
                   'upc', r.upc,
                   'isrc', r.isrc,
                   'spotify_uri', r.spotify_uri,
                   'cover_art_url', r.cover_art_url
                 ) ORDER BY r.id
               ) AS releases
        FROM releases r
        JOIN artists a ON a.id = r.artist_id
        WHERE (r.archived = false OR r.archived IS NULL)
          AND ${where}
        GROUP BY ${key}
        HAVING COUNT(*) > 1
      `);
      for (const row of rows) {
        groups.push({ reason, key: row.group_key, releases: row.releases });
      }
    }

    // Deduplicate: if two groups share the same exact release-id set, merge
    // their reasons into one group so we don't show the same pair twice.
    const merged = new Map();
    for (const g of groups) {
      const sig = g.releases.map(r => r.id).sort((a, b) => a - b).join(',');
      if (merged.has(sig)) {
        const existing = merged.get(sig);
        if (!existing.reasons.includes(g.reason)) existing.reasons.push(g.reason);
      } else {
        merged.set(sig, { reasons: [g.reason], releases: g.releases });
      }
    }

    const out = Array.from(merged.values()).sort(
      (a, b) => b.releases.length - a.releases.length
    );

    res.json({ success: true, data: out });
  } catch (err) {
    console.error('GET /releases/duplicates:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Columns we COALESCE into the target from sources when merging.
// Listed here so it's obvious what gets preserved vs. dropped.
const MERGE_COALESCE_COLUMNS = [
  'release_date', 'release_type', 'genre', 'subgenre', 'priority',
  'upc', 'isrc', 'apple_id', 'spotify_uri', 'presave_link',
  'presave_analytics', 'ugc_link', 'apple_music_link',
  'producer', 'featured_artists', 'distributor_notes', 'notes',
  'cover_art_status', 'cover_art_url', 'assigned_to',
];

// One status per release (the CEO: "each release should have a clear status"):
// Archived · Draft (no date) · Scheduled (dated, not ingested) · Ingested (dated,
// ingested, not out yet) · Released (the date has passed).
const releaseStatus = (r) => {
  if (r.archived) return 'Archived';
  if (!r.release_date) return 'Draft';
  const d = r.release_date instanceof Date ? r.release_date.toISOString().slice(0, 10) : String(r.release_date).slice(0, 10);
  if (d <= new Date().toISOString().slice(0, 10)) return 'Released';
  return r.ingested ? 'Ingested' : 'Scheduled';
};
const withStatus = (rows) => rows.map((r) => ({ ...r, status: releaseStatus(r) }));

const MERGE_CHECKLIST_COLUMNS = [
  'yt_video', 'recoup_added', 'uploaded', 'stem_pitch', 's4a_pitch',
  'amazon_pitch', 'pandora', 'budget', 'marketing_plan',
  'official_thread', 'marquee', 'content', 'dsp_email', 'musixmatch',
];

// POST /api/releases/merge
// Body: { target_id: number, source_ids: number[] }
// Merges sources into target, reassigning child rows, then deletes the
// source releases. Admin-only because this is destructive.
router.post('/merge', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    // Admin gate (same bar as permanent delete)
    const userResult = await pool.query('SELECT hierarchy_level FROM users WHERE id = $1', [req.user.id]);
    const userLevel = userResult.rows[0]?.hierarchy_level ?? 99;
    if (userLevel > 2) {
      return res.status(403).json({ success: false, error: 'Only admins can merge releases' });
    }

    const targetId = parseInt(req.body.target_id, 10);
    const sourceIds = (req.body.source_ids || []).map(n => parseInt(n, 10)).filter(n => Number.isFinite(n));
    if (!Number.isFinite(targetId) || sourceIds.length === 0) {
      return res.status(400).json({ success: false, error: 'target_id and non-empty source_ids[] required' });
    }
    if (sourceIds.includes(targetId)) {
      return res.status(400).json({ success: false, error: 'target_id cannot also appear in source_ids' });
    }

    const allIds = [targetId, ...sourceIds];

    await client.query('BEGIN');

    const { rows: releases } = await client.query(
      'SELECT * FROM releases WHERE id = ANY($1)',
      [allIds]
    );
    if (releases.length !== allIds.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'One or more releases not found' });
    }

    const target  = releases.find(r => r.id === targetId);
    const sources = releases.filter(r => sourceIds.includes(r.id));
    // Preserve every affected artist so we can recount at the end, even if
    // someone merged across artists (unusual but possible).
    const affectedArtistIds = Array.from(new Set(releases.map(r => r.artist_id).filter(Boolean)));

    // 1. Fill target's NULL/empty columns from sources (in caller-specified order).
    const updates = {};
    for (const col of MERGE_COALESCE_COLUMNS) {
      const currentIsEmpty = target[col] === null || target[col] === undefined || target[col] === '';
      if (!currentIsEmpty) continue;
      for (const s of sources) {
        const v = s[col];
        if (v !== null && v !== undefined && v !== '') { updates[col] = v; break; }
      }
    }
    // 2. Checklist: OR across target + every source (true wins).
    for (const col of MERGE_CHECKLIST_COLUMNS) {
      if (target[col] === true) continue;
      if (sources.some(s => s[col] === true)) updates[col] = true;
    }

    if (Object.keys(updates).length > 0) {
      const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`);
      await client.query(
        `UPDATE releases SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${Object.keys(updates).length + 1}`,
        [...Object.values(updates), targetId]
      );
    }

    // 3. Reassign child rows.
    //   a) Tables with no uniqueness on release_id — plain UPDATE.
    //      release_budget_line_items is legacy (deprecated, dormant);
    //      the live table is recording_budget_line_items, handled via
    //      its parent recording_budgets row.
    const plainChildTables = [
      'tasks', 'expenses', 'manual_expenses',
      'release_comments', 'release_audit_log', 'release_campaigns',
      'release_budget_line_items', 'artist_income', 'influencer_campaigns',
    ];
    for (const t of plainChildTables) {
      await client.query(
        `UPDATE ${t} SET release_id = $1 WHERE release_id = ANY($2)`,
        [targetId, sourceIds]
      ).catch(err => console.warn(`merge: reassigning ${t} failed`, err.message));
    }

    //   b) Legacy release_budgets — UNIQUE(release_id). Drop source
    //      rows if target already has one; otherwise promote one.
    //      Table is deprecated but still exists until the next
    //      release's cleanup drops it.
    await client.query(
      `DELETE FROM release_budgets WHERE release_id = ANY($1)
         AND EXISTS (SELECT 1 FROM release_budgets WHERE release_id = $2)`,
      [sourceIds, targetId]
    ).catch(() => {});
    await client.query(
      `UPDATE release_budgets SET release_id = $1
        WHERE id = (SELECT id FROM release_budgets WHERE release_id = ANY($2) ORDER BY updated_at DESC NULLS LAST LIMIT 1)`,
      [targetId, sourceIds]
    ).catch(() => {});
    await client.query(`DELETE FROM release_budgets WHERE release_id = ANY($1)`, [sourceIds]).catch(() => {});

    //   b'. Consolidated recording_budgets — same idea, applied to
    //       release-scoped budget rows. Keep the target's row if it
    //       has one; otherwise promote one source row onto the target.
    //       Line items follow via ON UPDATE (they FK to budget_id).
    await client.query(
      `DELETE FROM recording_budgets
         WHERE release_id = ANY($1)
           AND EXISTS (SELECT 1 FROM recording_budgets WHERE release_id = $2)`,
      [sourceIds, targetId]
    );
    await client.query(
      `UPDATE recording_budgets SET release_id = $1, updated_at = NOW()
        WHERE id = (
          SELECT id FROM recording_budgets
           WHERE release_id = ANY($2)
           ORDER BY updated_at DESC NULLS LAST LIMIT 1
        )`,
      [targetId, sourceIds]
    );
    await client.query(`DELETE FROM recording_budgets WHERE release_id = ANY($1)`, [sourceIds]);

    //   c) dsp_submissions — UNIQUE(release_id, dsp_name). Drop source rows
    //      whose dsp_name already exists on target, then reassign the rest.
    await client.query(
      `DELETE FROM dsp_submissions ds
        WHERE ds.release_id = ANY($1)
          AND EXISTS (SELECT 1 FROM dsp_submissions dt
                       WHERE dt.release_id = $2 AND dt.dsp_name = ds.dsp_name)`,
      [sourceIds, targetId]
    );
    await client.query(
      `UPDATE dsp_submissions SET release_id = $1 WHERE release_id = ANY($2)`,
      [targetId, sourceIds]
    );

    // 4. Delete the source releases. CASCADE mops up any stragglers we missed.
    await client.query('DELETE FROM releases WHERE id = ANY($1)', [sourceIds]);

    // 5. Recount total_releases for every affected artist so Roster stays accurate.
    await client.query(
      `UPDATE artists SET total_releases = (SELECT COUNT(*) FROM releases WHERE artist_id = artists.id)
        WHERE id = ANY($1)`,
      [affectedArtistIds]
    );

    await client.query('COMMIT');

    await logActivity(
      req.user.id,
      'merge',
      `Merged ${sourceIds.length} release(s) into #${targetId} "${target.project_name}"`
    ).catch(() => {});

    const { rows: updated } = await pool.query(
      `SELECT r.*, a.name as artist_name
       FROM releases r JOIN artists a ON r.artist_id = a.id
       WHERE r.id = $1`,
      [targetId]
    );

    res.json({ success: true, data: updated[0], merged_count: sourceIds.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /releases/merge:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/releases
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { month, date_from, date_to, artist, search, genre, priority, release_type, upcoming, archived, in_catalog } = req.query;
    let query = `
      SELECT r.*, a.name as artist_name,
             u.id as assigned_to_id, u.name as assigned_to_name
      FROM releases r
      JOIN artists a ON r.artist_id = a.id
      LEFT JOIN users u ON r.assigned_to = u.id
      WHERE 1=1
    `;
    // Catalog filter: default excludes cataloged. `true` = catalog only.
    // `any` = skip the filter entirely (used by Dashboard's Latest Releases).
    if (in_catalog === 'true') {
      query += ` AND r.in_catalog = true`;
    } else if (in_catalog !== 'any') {
      query += ` AND (r.in_catalog = false OR r.in_catalog IS NULL)`;
    }
    // Hide archived releases by default; pass archived=true to see them
    if (archived === 'true') {
      query += ` AND r.archived = true`;
    } else {
      query += ` AND (r.archived = false OR r.archived IS NULL)`;
    }
    const params = [];

    if (month) {
      if (month.length === 4) {
        query += ` AND TO_CHAR(r.release_date, 'YYYY') = $${params.length + 1}`;
      } else {
        query += ` AND TO_CHAR(r.release_date, 'YYYY-MM') = $${params.length + 1}`;
      }
      params.push(month);
    }

    if (date_from) {
      query += ` AND r.release_date >= $${params.length + 1}`;
      params.push(date_from);
    }

    if (date_to) {
      query += ` AND r.release_date <= $${params.length + 1}`;
      params.push(date_to);
    }

    if (artist) {
      query += ` AND LOWER(a.name) LIKE LOWER($${params.length + 1})`;
      params.push(`%${artist}%`);
    }

    if (search) {
      query += ` AND (LOWER(r.project_name) LIKE LOWER($${params.length + 1}) OR LOWER(a.name) LIKE LOWER($${params.length + 1}) OR r.isrc LIKE $${params.length + 1} OR r.upc LIKE $${params.length + 1})`;
      params.push(`%${search}%`);
    }

    if (genre) {
      query += ` AND LOWER(r.genre) = LOWER($${params.length + 1})`;
      params.push(genre);
    }

    if (priority) {
      query += ` AND LOWER(r.priority) = LOWER($${params.length + 1})`;
      params.push(priority);
    }

    if (release_type) {
      query += ` AND LOWER(r.release_type) = LOWER($${params.length + 1})`;
      params.push(release_type);
    }

    if (upcoming === 'true') {
      query += ` AND r.release_date >= CURRENT_DATE`;
    } else if (upcoming === 'false') {
      query += ` AND r.release_date < CURRENT_DATE`;
    }

    // Upcoming: nearest first (ASC); Past/All: newest first (DESC)
    query += upcoming === 'true' ? ' ORDER BY r.release_date ASC NULLS LAST' : ' ORDER BY r.release_date DESC';

    // Optional limit for mobile/pagination
    const limit = parseInt(req.query.limit) || 0;
    if (limit > 0) {
      query += ` LIMIT ${limit}`;
    }

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: withStatus(result.rows),
    });
  } catch (error) {
    console.error('Get releases error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/releases/:id
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, a.name as artist_name,
              u.id as assigned_to_id, u.name as assigned_to_name
       FROM releases r
       JOIN artists a ON r.artist_id = a.id
       LEFT JOIN users u ON r.assigned_to = u.id
       WHERE r.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Release not found' });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Get release error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/releases/:id — update core release fields
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      artist_name, project_name, release_date, release_type,
      genre, subgenre, priority
    } = req.body;

    // If artist_name changed, find or create the artist
    let artistUpdate = '';
    const params = [];
    let paramIdx = 1;

    if (artist_name !== undefined) {
      // Find or create artist
      let artistId;
      const existing = await pool.query('SELECT id FROM artists WHERE LOWER(name) = LOWER($1)', [artist_name.trim()]);
      if (existing.rows.length > 0) {
        artistId = existing.rows[0].id;
      } else {
        const newArtist = await pool.query(
          'INSERT INTO artists (name, genre, created_at) VALUES ($1, $2, NOW()) RETURNING id',
          [artist_name.trim(), genre || null]
        );
        artistId = newArtist.rows[0].id;
      }
      artistUpdate = `artist_id = $${paramIdx},`;
      params.push(artistId);
      paramIdx++;
    }

    const { assigned_to } = req.body;

    const result = await pool.query(
      `UPDATE releases SET
        ${artistUpdate}
        project_name = COALESCE($${paramIdx}, project_name),
        release_date = COALESCE($${paramIdx + 1}, release_date),
        release_type = COALESCE($${paramIdx + 2}, release_type),
        genre = COALESCE($${paramIdx + 3}, genre),
        subgenre = COALESCE($${paramIdx + 4}, subgenre),
        priority = COALESCE($${paramIdx + 5}, priority),
        assigned_to = COALESCE($${paramIdx + 6}, assigned_to),
        -- the CEO's list (2026-09-22): counts toward the artist's deal · ingested for distribution
        counts_toward_deal = CASE WHEN $${paramIdx + 8}::boolean THEN $${paramIdx + 9}::boolean ELSE counts_toward_deal END,
        ingested = CASE WHEN $${paramIdx + 10}::boolean THEN $${paramIdx + 11}::boolean ELSE ingested END,
        updated_at = NOW()
      WHERE id = $${paramIdx + 7}
      RETURNING *`,
      [...params, project_name || null, release_date || null, release_type || null, genre || null, subgenre || null, priority || null, assigned_to || null, id,
       req.body.counts_toward_deal !== undefined, req.body.counts_toward_deal === null ? null : !!req.body.counts_toward_deal, req.body.ingested !== undefined, req.body.ingested === null ? null : !!req.body.ingested]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Release not found' });
    }

    const updated = result.rows[0];

    // Re-fetch with artist name and assignee
    const full = await pool.query(
      `SELECT r.*, a.name as artist_name, u.id as assigned_to_id, u.name as assigned_to_name
       FROM releases r JOIN artists a ON r.artist_id = a.id LEFT JOIN users u ON r.assigned_to = u.id WHERE r.id = $1`,
      [id]
    );

    // Audit log — record field changes
    const logChange = (field, oldVal, newVal) => {
      if (oldVal !== newVal && newVal != null) {
        pool.query(
          `INSERT INTO release_audit_log (user_name, release_id, action, field, old_value, new_value)
           VALUES ($1, $2, 'updated', $3, $4, $5)`,
          [req.user.name, id, field, oldVal != null ? String(oldVal) : null, String(newVal)]
        ).catch(() => {});
      }
    };
    if (project_name) logChange('project_name', null, project_name);
    if (release_date) logChange('release_date', null, release_date);
    if (release_type) logChange('release_type', null, release_type);
    if (genre) logChange('genre', null, genre);
    if (priority) logChange('priority', null, priority);

    // Update artist total_releases counts
    await pool.query(`
      UPDATE artists SET total_releases = (SELECT COUNT(*) FROM releases WHERE artist_id = artists.id)
    `);

    // If project_name or artist changed, orphan expenses may now match this
    // release. Fire-and-forget so slow scans don't block the response.
    if (project_name || artist_name !== undefined) {
      relinkExpensesForRelease(id)
        .then(r => { if (r.linked) console.log(`[release ${id}] relinked ${r.linked} expense(s) after rename`); })
        .catch(err => console.warn('relinkExpensesForRelease:', err.message));
    }

    res.json({
      success: true,
      data: withStatus(full.rows)[0],
    });
  } catch (error) {
    console.error('Update release error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/releases/:id/checklist
// PARTIAL update — only keys present in the body are written. The old
// full-replace defaulted every missing key to false, so a caller sending a
// single toggle (or an empty body from a client race) silently wiped the
// other 13 checklist flags.
router.put('/:id/checklist', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const checklist = req.body || {};

    const KEYS = [
      'yt_video', 'recoup_added', 'uploaded', 'stem_pitch', 's4a_pitch',
      'amazon_pitch', 'pandora', 'budget', 'marketing_plan',
      'official_thread', 'marquee', 'content', 'dsp_email', 'musixmatch',
    ];
    const provided = KEYS.filter(k => k in checklist);
    if (provided.length === 0) {
      return res.status(400).json({ success: false, error: 'No checklist fields provided' });
    }
    const sets = provided.map((k, i) => `${k} = $${i + 1}`);
    const params = provided.map(k => !!checklist[k]);
    params.push(id);

    const result = await pool.query(`
      UPDATE releases SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length}
      RETURNING *
    `, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Release not found' });
    }

    // Log each toggled item
    const changedKeys = Object.keys(checklist);
    for (const key of changedKeys) {
      const label = key.replace(/_/g, ' ');
      const val = checklist[key];
      if (typeof val === 'boolean') {
        await logActivity(req.user.id, 'checklist_update',
          `${val ? 'Checked' : 'Unchecked'} "${label}" on release #${id}`);
        pool.query(
          `INSERT INTO release_audit_log (user_name, release_id, action, field, old_value, new_value)
           VALUES ($1, $2, 'checklist', $3, $4, $5)`,
          [req.user.name, id, label, val ? 'unchecked' : 'checked', val ? 'checked' : 'unchecked']
        ).catch(() => {});
      }
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update checklist error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/releases/:id/metadata — update metadata fields (allows clearing via explicit empty string)
router.put('/:id/metadata', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body;

    // Build dynamic SET clause — only update fields that were sent
    const fields = [
      'ugc_link', 'isrc', 'upc', 'genre', 'subgenre', 'release_type',
      'producer', 'featured_artists', 'distributor_notes', 'spotify_uri',
      'apple_music_link', 'cover_art_status', 'apple_id', 'presave_link',
      'presave_analytics', 'priority', 'notes'
    ];

    const setClauses = [];
    const params = [];
    let idx = 1;

    for (const field of fields) {
      if (field in body) {
        // Allow setting to empty string / null
        const val = body[field] === '' ? null : body[field];
        setClauses.push(`${field} = $${idx}`);
        params.push(val);
        idx++;
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    setClauses.push('updated_at = NOW()');
    params.push(id);

    const result = await pool.query(
      `UPDATE releases SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Release not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update metadata error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/releases
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { artist_id, artist_name, project_name, release_date, release_type, genre, subgenre, producer, featured_artists, upc, isrc, distributor_notes, notes, cover_art_status, spotify_uri, apple_music_link, presave_link, assigned_to } = req.body;

    if (!project_name || !release_date) {
      return res.status(400).json({ success: false, error: 'Project name and release date required' });
    }

    let finalArtistId = artist_id;

    if (!finalArtistId && artist_name) {
      const existing = await pool.query('SELECT id FROM artists WHERE LOWER(name) = LOWER($1)', [artist_name.trim()]);
      if (existing.rows.length > 0) {
        finalArtistId = existing.rows[0].id;
      } else {
        const newArtist = await pool.query(
          'INSERT INTO artists (name, genre, created_at) VALUES ($1, $2, NOW()) RETURNING id',
          [artist_name.trim(), genre || null]
        );
        finalArtistId = newArtist.rows[0].id;
      }
    }

    if (!finalArtistId) {
      return res.status(400).json({ success: false, error: 'Artist ID or artist name required' });
    }

    const result = await pool.query(
      `INSERT INTO releases (artist_id, project_name, release_date, release_type, genre, subgenre, producer, featured_artists, upc, isrc, distributor_notes, notes, cover_art_status, spotify_uri, apple_music_link, presave_link, assigned_to, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), NOW())
       RETURNING *`,
      [finalArtistId, project_name, release_date, release_type || null, genre || null, subgenre || null, producer || null, featured_artists || null, upc || null, isrc || null, distributor_notes || null, notes || null, cover_art_status || 'Pending', spotify_uri || null, apple_music_link || null, presave_link || null, assigned_to || null]
    );

    await pool.query('UPDATE artists SET total_releases = (SELECT COUNT(*) FROM releases WHERE artist_id = $1) WHERE id = $1', [finalArtistId]);

    // Retroactively link any expenses that were entered before this release
    // existed. Fire-and-forget so a slow scan doesn't stall the creation
    // response — errors are logged but the release itself is committed.
    relinkExpensesForRelease(result.rows[0].id)
      .then(r => { if (r.linked) console.log(`[release ${result.rows[0].id}] relinked ${r.linked} expense(s)`); })
      .catch(err => console.warn('relinkExpensesForRelease:', err.message));

    // Re-fetch with artist name and assignee
    const full = await pool.query(
      `SELECT r.*, a.name as artist_name, u.id as assigned_to_id, u.name as assigned_to_name
       FROM releases r JOIN artists a ON r.artist_id = a.id LEFT JOIN users u ON r.assigned_to = u.id WHERE r.id = $1`,
      [result.rows[0].id]
    );

    res.status(201).json({ success: true, data: full.rows[0] });

    const rel = full.rows[0];
    postEvent({
      text: `*${rel.artist_name}* — *${rel.project_name}* added to the release schedule`
        + (rel.release_date ? ` for ${fmtDate(rel.release_date)}` : ''),
      icon: 'disc',
      link: `/releases/${rel.id}`,
    }).catch(e => console.error('[activityBot] event dropped:', e.message));
  } catch (error) {
    console.error('Create release error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/releases/:id/assign — assign or unassign a team member
router.put('/:id/assign', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { assigned_to } = req.body; // null to unassign

    await pool.query(
      `UPDATE releases SET assigned_to = $1, updated_at = NOW() WHERE id = $2`,
      [assigned_to || null, id]
    );

    const full = await pool.query(
      `SELECT r.*, a.name as artist_name, u.id as assigned_to_id, u.name as assigned_to_name
       FROM releases r JOIN artists a ON r.artist_id = a.id LEFT JOIN users u ON r.assigned_to = u.id WHERE r.id = $1`,
      [id]
    );

    if (full.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Release not found' });
    }

    const assigneeName = full.rows[0]?.assigned_to_name || 'nobody';
    await logActivity(req.user.id, 'assignment', `Release #${id} assigned to ${assigneeName}`);

    res.json({ success: true, data: full.rows[0] });
  } catch (error) {
    console.error('Assign release error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/releases/:id/activity — activity log for one release
router.get('/:id/activity', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT al.*, u.name as user_name
       FROM activity_log al
       LEFT JOIN users u ON al.user_id = u.id
       WHERE al.detail LIKE $1
       ORDER BY al.created_at DESC
       LIMIT 50`,
      [`%release #${req.params.id}%`]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get release activity error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/releases/:id/catalog — move to / remove from catalog
router.put('/:id/catalog', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE releases SET in_catalog = NOT COALESCE(in_catalog, false), updated_at = NOW()
       WHERE id = $1 RETURNING id, in_catalog`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Release not found' });
    }
    const { in_catalog } = result.rows[0];
    await logActivity(req.user.id, 'catalog', `Release #${id} ${in_catalog ? 'moved to catalog' : 'moved back to pipeline'}`);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Catalog release error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/releases/:id/archive — toggle archived flag
router.put('/:id/archive', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE releases SET archived = NOT COALESCE(archived, false), updated_at = NOW()
       WHERE id = $1 RETURNING id, archived`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Release not found' });
    }
    const { archived } = result.rows[0];
    await logActivity(req.user.id, 'archive', `Release #${id} ${archived ? 'archived' : 'unarchived'}`);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Archive release error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/releases/:id
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    // Only admin (hierarchy_level <= 2) can permanently delete
    const userResult = await pool.query('SELECT hierarchy_level FROM users WHERE id = $1', [req.user.id]);
    const userLevel = userResult.rows[0]?.hierarchy_level ?? 99;
    if (userLevel > 2) {
      return res.status(403).json({ success: false, error: 'Only admins can permanently delete releases' });
    }
    const result = await pool.query('DELETE FROM releases WHERE id = $1 RETURNING id, project_name, artist_id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Release not found' });
    }
    // Keep artists.total_releases in sync so the Roster counters don't drift.
    const deletedArtistId = result.rows[0].artist_id;
    if (deletedArtistId) {
      await pool.query(
        'UPDATE artists SET total_releases = (SELECT COUNT(*) FROM releases WHERE artist_id = $1) WHERE id = $1',
        [deletedArtistId]
      );
    }
    await logActivity(req.user.id, 'delete', `Deleted release "${result.rows[0].project_name}" (#${id})`);
    res.json({ success: true, data: { id: parseInt(id) } });
  } catch (error) {
    console.error('Delete release error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Comment routes (GET / POST / DELETE) live further down in this file —
// see the block starting `router.get('/:id/comments', ...)` around line
// ~1086. There used to be a duplicate set of handlers here that targeted
// a non-existent `body` column (the schema column is `text`), which
// silently broke every comment write because Express matched these
// handlers first. They have been removed.

// ── Budget Line Items ─────────────────────────────────────────────────────────

// Helper — resolve (or lazily create) the recording_budgets row that
// backs a release. This endpoint used to write to the standalone
// release_budgets + release_budget_line_items tables; both are now
// consolidated into recording_budgets + recording_budget_line_items,
// but the wire shape returned here still matches the legacy
// { items: [], budget_cap } contract so the Release Tracker's
// Budget tab keeps working without a client change.
async function ensureReleaseBudget(releaseId, userId) {
  const existing = await pool.query(
    `SELECT id FROM recording_budgets WHERE release_id = $1 LIMIT 1`,
    [releaseId]
  );
  if (existing.rows.length) return existing.rows[0].id;
  const created = await pool.query(`
    INSERT INTO recording_budgets
      (release_id, artist_id, type, currency, advance_amount, total_amount_override,
       contingency_pct, status,
       created_by, updated_by, created_at, updated_at)
    VALUES
      ($1,
       (SELECT r.artist_id FROM releases r WHERE r.id = $1),
       'budget', 'USD', 0, NULL, 0, 'draft',
       $2, $2, NOW(), NOW())
    RETURNING id
  `, [releaseId, userId]);
  return created.rows[0].id;
}

// GET /api/releases/:id/budget-items
router.get('/:id/budget-items', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const budgetRow = await pool.query(
      `SELECT id, total_amount_override FROM recording_budgets WHERE release_id = $1 LIMIT 1`,
      [id]
    );
    const items = budgetRow.rows.length
      ? await pool.query(`
          SELECT
            li.id, li.category, li.description, li.amount, li.notes, li.created_at,
            NULL AS created_by_name
          FROM recording_budget_line_items li
          WHERE li.budget_id = $1
          ORDER BY li.created_at ASC
        `, [budgetRow.rows[0].id])
      : { rows: [] };
    res.json({
      success: true,
      data: {
        items: items.rows,
        budget_cap: budgetRow.rows[0]?.total_amount_override ?? null,
      },
    });
  } catch (error) {
    console.error('Get budget items error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/releases/:id/budget-items
router.post('/:id/budget-items', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { category, description, amount, notes } = req.body;
    if (!category) return res.status(400).json({ success: false, error: 'Category is required' });
    if (amount === undefined || amount === null || amount === '')
      return res.status(400).json({ success: false, error: 'Amount is required' });
    const budgetId = await ensureReleaseBudget(id, req.user.id);
    const amt = parseFloat(amount);
    // Section forced to 'other' because release line-item categories
    // (Recording, Marketing, PR, Distribution, Legal, …) don't map
    // cleanly to the 6-section recording-budget enum. The freeform
    // category text is preserved verbatim in `category`, which the
    // client already renders.
    const result = await pool.query(`
      INSERT INTO recording_budget_line_items
        (budget_id, section, category, description, qty, unit_price, amount, notes, created_at)
      VALUES ($1, 'other', $2, $3, 1, $4, $4, $5, NOW())
      RETURNING id, category, description, amount, notes, created_at
    `, [budgetId, category, description || null, amt, notes || null]);
    // Bump parent updated_at so the budget list resorts.
    await pool.query(
      `UPDATE recording_budgets SET updated_at = NOW(), updated_by = $1 WHERE id = $2`,
      [req.user.id, budgetId]
    );
    const row = result.rows[0];
    const user = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
    row.created_by_name = user.rows[0]?.name;
    await logActivity(req.user.id, 'budget', `Added budget line item "${category}" ($${amt.toFixed(2)}) to release #${id}`);
    res.json({ success: true, data: row });
  } catch (error) {
    console.error('Add budget item error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/releases/:id/budget-items/:itemId
router.put('/:id/budget-items/:itemId', authMiddleware, async (req, res) => {
  try {
    const { itemId } = req.params;
    const { category, description, amount, notes } = req.body;
    const amt = amount != null ? parseFloat(amount) : null;
    // For release line items amount == unit_price × 1, so we update
    // both together when the caller sends amount. Description /
    // category / notes are partial-update via COALESCE.
    const result = await pool.query(`
      UPDATE recording_budget_line_items li
         SET category    = COALESCE($1, li.category),
             description = COALESCE($2, li.description),
             amount      = COALESCE($3, li.amount),
             unit_price  = COALESCE($3, li.unit_price),
             notes       = COALESCE($4, li.notes)
       FROM recording_budgets rb
       WHERE li.id = $5 AND li.budget_id = rb.id AND rb.release_id = $6
       RETURNING li.id, li.category, li.description, li.amount, li.notes, li.created_at
    `, [category || null, description ?? null, amt, notes ?? null, itemId, req.params.id]);
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, error: 'Line item not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update budget item error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/releases/:id/budget-items/:itemId
router.delete('/:id/budget-items/:itemId', authMiddleware, async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const result = await pool.query(`
      DELETE FROM recording_budget_line_items li
       USING recording_budgets rb
       WHERE li.id = $1 AND li.budget_id = rb.id AND rb.release_id = $2
       RETURNING li.id
    `, [itemId, id]);
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, error: 'Line item not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete budget item error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Audit Trail ──────────────────────────────────────────────────────────────

// GET /api/releases/:id/audit
router.get('/:id/audit', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM release_audit_log WHERE release_id = $1 ORDER BY ts DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Comments ─────────────────────────────────────────────────────────────────

// GET /api/releases/:id/comments
router.get('/:id/comments', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, u.name as user_name, u.role as user_role, u.department as user_department
       FROM release_comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.release_id = $1
       ORDER BY c.created_at ASC`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/releases/:id/comments
router.post('/:id/comments', authMiddleware, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ success: false, error: 'Comment text required' });

    const { rows } = await pool.query(
      `INSERT INTO release_comments (release_id, user_id, text)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, req.user.id, text.trim()]
    );

    // Fetch with user info
    const result = await pool.query(
      `SELECT c.*, u.name as user_name, u.role as user_role, u.department as user_department
       FROM release_comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.id = $1`,
      [rows[0].id]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/releases/:id/comments/:commentId
router.delete('/:id/comments/:commentId', authMiddleware, async (req, res) => {
  try {
    // Only the author or admin can delete
    const { rows } = await pool.query('SELECT user_id FROM release_comments WHERE id = $1', [req.params.commentId]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Comment not found' });
    if (rows[0].user_id !== req.user.id && req.user.role !== 'Admin' && req.user.role !== 'Superadmin') {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    await pool.query('DELETE FROM release_comments WHERE id = $1', [req.params.commentId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
