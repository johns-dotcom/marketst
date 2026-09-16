/**
 * Release spend plans — the marketing sheet as a commitment record.
 *
 * See `lib/spendPlan.js` for what the sheet is and `server/index.js` for the two
 * tables. The rule this whole router is built around:
 *
 *   THE PLAN IS THE COMMITMENT. THE LEDGER IS THE ACTUAL. NEITHER OVERWRITES
 *   THE OTHER.
 *
 * 111 (artist, song) pairs exist in both the sheet and `expenses` and not one of
 * them agrees, so there is no version of "reconcile them" that is not somebody
 * choosing which record to believe. Nothing here writes to `expenses`, and no
 * ledger figure is ever copied into a plan. `release_id` is the only join, and
 * the variance between the two is reported rather than resolved.
 *
 * ── Actuals: every row in the family, at the row, in USD ──
 * Three rules borrowed rather than re-derived, each of which has already been
 * got wrong somewhere in this codebase:
 *   - SUM EVERY ROW IN A SPLIT FAMILY, parent included. All three split writers
 *     SHRINK the parent to its own slice (`SET amount = first.amount` in
 *     `POST /bk/entries/:id/split`) and put the rest on children, so
 *     `parent.amount + SUM(children.amount)` IS the invoice. This was written
 *     leaf-only first — `NOT EXISTS (children)`, the intuitive reading — and
 *     `scripts/spend-plan-fixture.cjs` caught it: a $900 family booked as
 *     300 + 300 + 300 reported $600. That is the same mistake
 *     `split-family-total-fixture.cjs` exists to stop, where the leaf-only
 *     remedy would have removed $47,226.01 from a $3,126,376.38 page.
 *     (`artist-budgets.js` filters leaf-only and disagrees with this; that is a
 *     pre-existing surface and moving its numbers needs its own decision.)
 *   - `usdOf` per row, never `amount_usd`. Summing the stored column reported
 *     $6,159,482 against $5,772,443 on the statements page, because a foreign
 *     row with a null `amount_usd` falls back to its face value.
 *   - ROUND AT THE ROW. A release's actual is sliced two ways at once (paid vs
 *     open, and by category) and both have to add to the same total; rounding
 *     each subtotal independently cannot give you that, and produced a $0.01
 *     break on the artist spend sheets in production within a minute.
 *
 * ── SPENT and OPEN are separate ──
 * An unpaid invoice is not an expenditure. `spent` is what the ledger says
 * moved; `open` is invoices nobody has paid. They are reported apart and the
 * variance measures against `spent`, exactly as the artist spend sheets do —
 * 31.3% of what the older budget pages called "spend" was unpaid invoices.
 */

const express = require('express');
const multer = require('multer');
const pool = require('../db');
const auth = require('../middleware/auth');
const { requirePagePermission } = require('../middleware/pagePermission');
const { secureFileFilter } = require('../middleware/secureUpload');
const { usdOf } = require('../lib/usd');
const { artistBucketKey } = require('../lib/artist-key');
const { parseSheet, diff, loadDbState, applyImport } = require('../lib/spendPlan');

const router = express.Router();
router.use(auth);

// Page permissions are stored BY PATH, so the gate moved with the surface: the
// upload and the queue now live on /artist-budgets, not under Import. The old
// path is kept as a second accepted page rather than replaced — it shipped
// earlier today and `requirePagePermission` takes several, so an existing grant
// keeps working exactly as the /duplicates -> /flags carve-out does.
const PAGE = '/artist-budgets';
const LEGACY_PAGE = '/import/spend-plans';

// The workbook is ~11.8 MB — 4.1 million cell tags across 4,129 columns — so the
// master sheet's 10 MB ceiling would refuse the only file this page exists to
// read. Checked against the real file rather than guessed.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: secureFileFilter,
});

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Multer refuses the whole request rather than dropping the overflow, and a bare
// throw reaches the global handler as a 500 — which Cloudflare replaces with its
// own HTML error page, so the message never arrives. Same reason every API error
// below is a 400 or 500 with a sentence rather than a 502/504.
function uploadSafe(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(400).json({
      success: false,
      error: tooBig
        ? 'That file is larger than 30 MB.'
        : `Upload failed: ${err.message}`,
    });
  });
}

// ── Actuals from the ledger ──────────────────────────────────────────────────
//
// Deliberately NOT filtered by `excludeBankRows`. That rule exists to keep
// never-reviewed statement rows off the recoupment surfaces, and it is right
// there — but this question is "what has the ledger recorded against this
// release", and a bank row that has been matched to one is a real answer to it.
// In practice statement rows carry no release_id at all (they name no artist or
// song, so `autoLinkRelease` never fires), so the filter would change nothing
// today while quietly discarding exactly the rows that matching is meant to
// produce.
const ACTUALS_SQL = `
  SELECT e.id, e.release_id, e.amount, e.currency, e.fx_rate_to_usd,
         e.payment_status, e.payment_date, e.category, e.payee, e.song, e.artist
    FROM expenses e
   WHERE e.release_id = ANY($1::int[])
     AND COALESCE(e.deleted, false) = false
     AND COALESCE(e.voided, false) = false
`;

async function actualsFor(releaseIds) {
  const byRelease = new Map();
  if (!releaseIds.length) return byRelease;
  const { rows } = await pool.query(ACTUALS_SQL, [releaseIds]);
  for (const row of rows) {
    const usd = r2(usdOf(row.amount, row.currency, row.fx_rate_to_usd));
    if (!byRelease.has(row.release_id)) {
      byRelease.set(row.release_id, { spent: 0, open: 0, rows: [] });
    }
    const bucket = byRelease.get(row.release_id);
    if (row.payment_status === 'Paid') bucket.spent = r2(bucket.spent + usd);
    else bucket.open = r2(bucket.open + usd);
    bucket.rows.push({
      id: row.id,
      amount_usd: usd,
      currency: row.currency,
      payment_status: row.payment_status,
      payment_date: row.payment_date,
      category: row.category,
      payee: row.payee,
      song: row.song,
      artist: row.artist,
    });
  }
  return byRelease;
}

// The commitment side of a plan, from its own lines. `not_yet` is what is still
// owed; `paid` is what the SHEET believes was paid, which is not evidence and is
// never mixed with the ledger's answer.
function planMoney(lines) {
  const sum = (pred) => r2(lines.filter(pred).reduce((s, l) => s + (Number(l.amount) || 0), 0));
  return {
    lines_total: sum(() => true),
    committed: sum(l => l.status === 'not_yet'),
    sheet_paid: sum(l => l.status === 'paid'),
    sheet_unknown: sum(l => l.status === null),
    prose_lines: lines.filter(l => l.amount === null && l.amount_raw).length,
  };
}

// ── GET /api/spend-plans/summary ─────────────────────────────────────────────
router.get('/summary', requirePagePermission(PAGE, LEGACY_PAGE), async (req, res) => {
  try {
    const [{ rows: byStatus }, { rows: [totals] }, { rows: [lineAgg] }] = await Promise.all([
      pool.query(`
        SELECT match_status, COUNT(*)::int AS plans, COALESCE(SUM(sheet_total), 0)::float AS total
          FROM release_spend_plans GROUP BY match_status ORDER BY plans DESC
      `),
      pool.query(`
        SELECT COUNT(*)::int AS plans,
               COUNT(release_id)::int AS linked,
               COALESCE(SUM(sheet_total), 0)::float AS sheet_total,
               MAX(imported_at) AS last_import
          FROM release_spend_plans
      `),
      pool.query(`
        SELECT COUNT(*)::int AS lines,
               COALESCE(SUM(amount) FILTER (WHERE status = 'not_yet'), 0)::float AS committed,
               COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)::float AS sheet_paid,
               COALESCE(SUM(amount) FILTER (WHERE status IS NULL), 0)::float AS sheet_unknown,
               COUNT(*) FILTER (WHERE amount IS NULL AND amount_raw IS NOT NULL)::int AS prose_lines
          FROM release_spend_plan_lines
      `),
    ]);
    res.json({
      success: true,
      data: { by_status: byStatus, totals, lines: lineAgg },
    });
  } catch (err) {
    console.error('GET /api/spend-plans/summary:', err);
    res.status(500).json({ success: false, error: 'Could not load the spend plan summary.' });
  }
});

// ── GET /api/spend-plans/by-artist ───────────────────────────────────────────
//
// The budget sheet: one card per artist, that artist's campaigns inside it.
//
// KEYED ON `artistBucketKey`, never a raw name, and specifically on the name of
// the release's ARTIST RECORD rather than the free text on an expense. That is
// the same key `/artist-budgets` uses, which is what lets a card link straight
// to that artist's sheet — a second keying rule here would give an artist a card
// that opens somebody else's page, or nobody's. The key also folds "Jerri" and
// "jerri " together and drops placeholders ("N/A", "TBD"), so a card can never
// be opened for a non-artist.
//
// PLANNED, OWED and LEDGER-PAID are three different measurements and are
// returned apart. Planned is the sheet's printed total; owed is its "not yet"
// lines; paid is what `expenses` actually recorded. They do not reconcile — see
// the header — so the card shows all three and computes no blended figure.
//
// `?artist_key=` narrows to one artist for the detail sheet's campaigns block,
// so both surfaces are built by the same code rather than two rollups that can
// drift.
router.get('/by-artist', requirePagePermission(PAGE, LEGACY_PAGE), async (req, res) => {
  try {
    const only = (req.query.artist_key || '').trim() || null;

    const [{ rows: plans }, { rows: unlinked }] = await Promise.all([
      pool.query(`
        SELECT p.id, p.release_id, p.source_header, p.sheet_total::float AS sheet_total,
               p.total_source,
               r.project_name, r.release_date, a.name AS artist_name
          FROM release_spend_plans p
          JOIN releases r ON r.id = p.release_id
          LEFT JOIN artists a ON a.id = r.artist_id
         WHERE p.match_status = 'matched' AND p.release_id IS NOT NULL
      `),
      pool.query(`
        SELECT COUNT(*)::int AS count, COALESCE(SUM(sheet_total), 0)::float AS total
          FROM release_spend_plans
         WHERE match_status <> 'matched' AND match_status <> 'skipped'
      `),
    ]);

    // Drop plans whose artist is a placeholder or missing before anything else
    // is computed, so no total below includes money the cards cannot show.
    const kept = [];
    for (const p of plans) {
      const key = artistBucketKey(p.artist_name);
      if (!key) continue;
      if (only && key !== only) continue;
      kept.push({ ...p, artist_key: key });
    }

    const planIds = kept.map(p => p.id);
    const lineAgg = new Map();
    if (planIds.length) {
      const { rows } = await pool.query(`
        SELECT plan_id,
               COALESCE(SUM(amount) FILTER (WHERE status = 'not_yet'), 0)::float AS owed,
               COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)::float AS sheet_paid,
               COUNT(*)::int AS lines
          FROM release_spend_plan_lines
         WHERE plan_id = ANY($1::int[])
         GROUP BY plan_id
      `, [planIds]);
      for (const r of rows) lineAgg.set(r.plan_id, r);
    }

    const actuals = await actualsFor([...new Set(kept.map(p => p.release_id))]);

    const byArtist = new Map();
    const spellings = new Map();
    for (const p of kept) {
      if (!byArtist.has(p.artist_key)) {
        byArtist.set(p.artist_key, {
          artist_key: p.artist_key, campaigns: [],
          planned: 0, owed: 0, sheet_paid: 0, ledger_paid: 0, ledger_open: 0,
          seenReleases: new Set(),
        });
      }
      // Display name is the most-used spelling on the artist's own releases —
      // the rule shapeByArtist and Recoupments follow. Storing one would freeze
      // whichever spelling happened to be current.
      if (!spellings.has(p.artist_key)) spellings.set(p.artist_key, new Map());
      const sp = spellings.get(p.artist_key);
      const name = String(p.artist_name || '').trim();
      if (name) sp.set(name, (sp.get(name) || 0) + 1);

      const agg = lineAgg.get(p.id) || { owed: 0, sheet_paid: 0, lines: 0 };
      const act = actuals.get(p.release_id) || { spent: 0, open: 0 };
      const bucket = byArtist.get(p.artist_key);
      // A RELEASE's actual is counted once per release, not once per plan. Nine
      // releases carry two blocks each on the live sheet — the operator made a
      // second column for the same project — and adding `act` inside this loop
      // counted their ledger spend twice on the artist's card. The campaign rows
      // below still each show the release's figure, which is right: they are two
      // views of one release, not two payments.
      const firstForRelease = !bucket.seenReleases.has(p.release_id);
      bucket.seenReleases.add(p.release_id);
      bucket.campaigns.push({
        plan_id: p.id,
        release_id: p.release_id,
        title: p.project_name,
        release_date: p.release_date,
        source_header: p.source_header,
        planned: r2(p.sheet_total),
        total_source: p.total_source,
        owed: r2(agg.owed),
        sheet_paid: r2(agg.sheet_paid),
        ledger_paid: act.spent,
        ledger_open: act.open,
        lines: agg.lines,
      });
      bucket.planned = r2(bucket.planned + (p.sheet_total || 0));
      bucket.owed = r2(bucket.owed + agg.owed);
      bucket.sheet_paid = r2(bucket.sheet_paid + agg.sheet_paid);
      if (firstForRelease) {
        bucket.ledger_paid = r2(bucket.ledger_paid + act.spent);
        bucket.ledger_open = r2(bucket.ledger_open + act.open);
      }
    }

    const bestSpelling = (m) => {
      let best = null, n = -1;
      for (const [name, c] of m) if (c > n) { best = name; n = c; }
      return best;
    };

    const artists = [...byArtist.values()].map(({ seenReleases, ...a }) => ({
      ...a,
      artist: bestSpelling(spellings.get(a.artist_key) || new Map()) || a.artist_key,
      campaign_count: a.campaigns.length,
      // What share of the plan the ledger has actually paid. Capped for display
      // only — a release can be paid past its plan, and the raw figures above
      // still say so.
      paid_pct: a.planned > 0 ? Math.min(100, Math.round((a.ledger_paid / a.planned) * 100)) : null,
      campaigns: a.campaigns.sort((x, y) => y.planned - x.planned),
    })).sort((x, y) => y.planned - x.planned);

    res.json({
      success: true,
      data: {
        artists,
        totals: {
          artists: artists.length,
          campaigns: artists.reduce((s, a) => s + a.campaign_count, 0),
          planned: r2(artists.reduce((s, a) => s + a.planned, 0)),
          owed: r2(artists.reduce((s, a) => s + a.owed, 0)),
          ledger_paid: r2(artists.reduce((s, a) => s + a.ledger_paid, 0)),
          ledger_open: r2(artists.reduce((s, a) => s + a.ledger_open, 0)),
        },
        unlinked: unlinked[0],
      },
    });
  } catch (err) {
    console.error('GET /api/spend-plans/by-artist:', err);
    res.status(500).json({ success: false, error: 'Could not load the artist budgets.' });
  }
});

// ── GET /api/spend-plans/queue ───────────────────────────────────────────────
// Everything that is not cleanly linked, with its lines and its suggestions.
router.get('/queue', requirePagePermission(PAGE, LEGACY_PAGE), async (req, res) => {
  try {
    const { status, q } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const where = [];
    const params = [];
    if (status && status !== 'all') {
      params.push(status);
      where.push(`p.match_status = $${params.length}`);
    } else {
      // Matches the unlinked count on /by-artist exactly. It used to be just
      // `<> 'matched'`, which INCLUDED skipped blocks — so the banner said 359,
      // the list it opened showed more than that, and skipping one decremented
      // the banner while the row stayed on screen. Ask for them with
      // ?status=skipped.
      where.push(`p.match_status <> 'matched' AND p.match_status <> 'skipped'`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`p.source_header ILIKE $${params.length}`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM release_spend_plans p ${whereSql}`, params
    );
    params.push(limit, offset);
    const { rows: plans } = await pool.query(`
      SELECT p.id, p.release_id, p.source_header, p.source_column,
             p.parsed_left, p.parsed_right, p.match_status, p.match_order,
             p.suggestions, p.sheet_total::float AS sheet_total, p.total_source,
             p.matched_at,
             a.name AS release_artist, r.project_name AS release_title
        FROM release_spend_plans p
        LEFT JOIN releases r ON r.id = p.release_id
        LEFT JOIN artists  a ON a.id = r.artist_id
        ${whereSql}
       ORDER BY p.sheet_total DESC NULLS LAST, p.id
       LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    const ids = plans.map(p => p.id);
    const linesByPlan = new Map();
    if (ids.length) {
      const { rows: lines } = await pool.query(`
        SELECT plan_id, source_row, amount::float AS amount, amount_raw, note, status, status_raw
          FROM release_spend_plan_lines
         WHERE plan_id = ANY($1::int[])
         ORDER BY plan_id, source_row
      `, [ids]);
      for (const l of lines) {
        if (!linesByPlan.has(l.plan_id)) linesByPlan.set(l.plan_id, []);
        linesByPlan.get(l.plan_id).push(l);
      }
    }

    res.json({
      success: true,
      data: plans.map(p => {
        const lines = linesByPlan.get(p.id) || [];
        return { ...p, lines, money: planMoney(lines) };
      }),
      total: count,
    });
  } catch (err) {
    console.error('GET /api/spend-plans/queue:', err);
    res.status(500).json({ success: false, error: 'Could not load the match queue.' });
  }
});

// ── POST /api/spend-plans/:id/link ───────────────────────────────────────────
// Link a queued block to a release. `match_order = 'manual'` marks it as a
// person's answer, which is what `applyImport` refuses to overwrite on a
// re-import.
router.post('/:id/link', requirePagePermission(PAGE, LEGACY_PAGE), async (req, res) => {
  try {
    const releaseId = parseInt(req.body?.release_id, 10);
    if (!Number.isInteger(releaseId)) {
      return res.status(400).json({ success: false, error: 'A release_id is required.' });
    }
    const { rows: [rel] } = await pool.query('SELECT id FROM releases WHERE id = $1', [releaseId]);
    if (!rel) return res.status(400).json({ success: false, error: 'That release does not exist.' });

    const { rows } = await pool.query(`
      UPDATE release_spend_plans
         SET release_id = $1, match_status = 'matched', match_order = 'manual',
             matched_by = $2, matched_at = NOW()
       WHERE id = $3
       RETURNING id, release_id, match_status, match_order, matched_at
    `, [releaseId, req.user?.id || null, req.params.id]);
    if (!rows.length) return res.status(400).json({ success: false, error: 'No such spend plan.' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /api/spend-plans/:id/link:', err);
    res.status(500).json({ success: false, error: 'Could not link that block.' });
  }
});

// ── POST /api/spend-plans/:id/unlink ─────────────────────────────────────────
// Returns the block to the queue. `unmatched` rather than its original status —
// the original may have been `duplicate_release`, and a person having looked at
// it is new information even when they undid their own answer.
router.post('/:id/unlink', requirePagePermission(PAGE, LEGACY_PAGE), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      UPDATE release_spend_plans
         SET release_id = NULL, match_status = 'unmatched', match_order = NULL,
             matched_by = $1, matched_at = NOW()
       WHERE id = $2
       RETURNING id, match_status
    `, [req.user?.id || null, req.params.id]);
    if (!rows.length) return res.status(400).json({ success: false, error: 'No such spend plan.' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /api/spend-plans/:id/unlink:', err);
    res.status(500).json({ success: false, error: 'Could not unlink that block.' });
  }
});

// ── POST /api/spend-plans/:id/skip ───────────────────────────────────────────
// "This block does not correspond to a release we track." Keeps the money
// visible and out of the queue, rather than deleting it — the sheet is the only
// record these 2021 projects have.
router.post('/:id/skip', requirePagePermission(PAGE, LEGACY_PAGE), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      UPDATE release_spend_plans
         SET match_status = 'skipped', matched_by = $1, matched_at = NOW()
       WHERE id = $2
       RETURNING id, match_status
    `, [req.user?.id || null, req.params.id]);
    if (!rows.length) return res.status(400).json({ success: false, error: 'No such spend plan.' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /api/spend-plans/:id/skip:', err);
    res.status(500).json({ success: false, error: 'Could not skip that block.' });
  }
});

// ── GET /api/spend-plans/release/:releaseId ──────────────────────────────────
// Budget vs actual for one release: the plan's lines on one side, the ledger's
// leaf rows on the other, and the variance stated rather than reconciled.
router.get('/release/:releaseId', async (req, res) => {
  try {
    const releaseId = parseInt(req.params.releaseId, 10);
    if (!Number.isInteger(releaseId)) {
      return res.status(400).json({ success: false, error: 'Bad release id.' });
    }
    const { rows: plans } = await pool.query(`
      SELECT id, source_header, source_column, sheet_total::float AS sheet_total,
             total_source, match_status, match_order, matched_at
        FROM release_spend_plans
       WHERE release_id = $1
       ORDER BY id
    `, [releaseId]);

    let lines = [];
    if (plans.length) {
      const { rows } = await pool.query(`
        SELECT plan_id, source_row, amount::float AS amount, amount_raw, note, status, status_raw
          FROM release_spend_plan_lines
         WHERE plan_id = ANY($1::int[])
         ORDER BY plan_id, source_row
      `, [plans.map(p => p.id)]);
      lines = rows;
    }

    const actualMap = await actualsFor([releaseId]);
    const actual = actualMap.get(releaseId) || { spent: 0, open: 0, rows: [] };
    const money = planMoney(lines);

    // The plan's own total is the PRINTED one where the sheet printed one — the
    // committed figure is what is still owed on it, which is a different
    // question and is reported beside it rather than instead of it.
    const sheetTotal = r2(plans.reduce((s, p) => s + (p.sheet_total || 0), 0));

    res.json({
      success: true,
      data: {
        release_id: releaseId,
        plans,
        lines,
        plan: { ...money, sheet_total: sheetTotal },
        actual: { spent: actual.spent, open: actual.open, rows: actual.rows },
        variance: r2(sheetTotal - actual.spent),
      },
    });
  } catch (err) {
    console.error('GET /api/spend-plans/release/:releaseId:', err);
    res.status(500).json({ success: false, error: 'Could not load the spend plan for that release.' });
  }
});

// ── POST /api/spend-plans/import ─────────────────────────────────────────────
// Dry run unless `apply=1`. Same parse/diff/apply path as the CLI script.
router.post('/import', requirePagePermission(PAGE, LEGACY_PAGE), uploadSafe, async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded.' });

  const apply = req.query.apply === '1' || req.query.apply === 'true'
    || req.body?.apply === '1' || req.body?.apply === 'true';

  let blocks;
  try {
    blocks = await parseSheet(req.file.buffer);
  } catch (err) {
    console.error('Spend sheet parse failed:', err);
    return res.status(400).json({
      success: false,
      error: 'Could not read that spreadsheet. It needs an "Expenses" tab laid out as repeating Amount / Expense Notes / Who Paid columns.',
    });
  }

  const client = await pool.connect();
  try {
    const { dbReleases } = await loadDbState(client);
    const { results, stats } = diff(blocks, dbReleases);

    const preview = {
      queue: results.filter(r => r.status !== 'matched').slice(0, 25).map(r => ({
        header: r.header,
        source_column: r.sourceColumn,
        status: r.status,
        sheet_total: r.sheetTotal,
        suggestions: r.suggestions.slice(0, 3),
      })),
      totalDisagreements: results
        .filter(r => r.totalSource === 'printed' && Math.abs(r.sheetTotal - r.linesTotal) > 0.005)
        .map(r => ({
          header: r.header, source_column: r.sourceColumn,
          printed: r.sheetTotal, lines: r.linesTotal,
        })),
      proseAmounts: results.flatMap(r =>
        r.lines.filter(l => l.amountRaw).map(l => ({
          header: r.header, cell: `${r.sourceColumn}${l.sourceRow}`, raw: l.amountRaw,
        }))
      ).slice(0, 25),
    };

    if (!apply) {
      return res.json({ success: true, data: { applied: false, stats, preview } });
    }

    await client.query('BEGIN');
    const written = await applyImport(client, results, req.user?.id || null);
    await client.query('COMMIT');
    res.json({ success: true, data: { applied: true, stats, preview, written } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/spend-plans/import:', err);
    res.status(500).json({ success: false, error: `Import failed and nothing was written: ${err.message}` });
  } finally {
    client.release();
  }
});

module.exports = router;
