const express = require('express');
const ExcelJS = require('exceljs');
const router = express.Router();
const pool = require('../db');
const { getCached } = require('../services/fx');
const auth = require('../middleware/auth');
const { requirePagePermission } = require('../middleware/pagePermission');
// Statement-born rows are excluded from every expense query in this file —
// see lib/ledger-source.js for why, and for the IS-DISTINCT-FROM trap. This
// page's queries had NO source filter at all, so they took the entire ledger.
const { excludeBankRows } = require('../lib/ledger-source');
const { bankEvidenceCols } = require('../lib/bank-evidence');
const { artistBucketKey } = require('../lib/artist-key');
const { usdOf } = require('../lib/usd');

router.use(auth);
// Same gate the client applies to /artist-campaigns. Mirrors the
// bookkeeping router — admins pass, everyone else needs the page grant.
router.use(requirePagePermission('/artist-campaigns'));

// ─── Excel export styling ────────────────────────────────────────────────────
// Market Street brand-red palette. Column headers are red-on-white with a dark-red
// accent, section bands are a soft red tint, and the finished/in-progress
// left rail on section rows uses emerald / red respectively. The rest of
// the workbook stays cream + slate for legibility since a full red sheet
// would tire the reader.
const XLSX_HEADER_BG      = 'FFDC2626'; // red-600 — column headers
const XLSX_HEADER_BORDER  = 'FF991B1B'; // red-800
const XLSX_TITLE_FG       = 'FF991B1B'; // red-800 — title text
const XLSX_ROW_BAND       = 'FFFAFAFA'; // near-white — alternating row band
const XLSX_SECTION_BG     = 'FFFEF2F2'; // red-50 — song section header band
const XLSX_SECTION_FG     = 'FF7F1D1D'; // red-900 — text on section rows
const XLSX_SECTION_BORDER = 'FFFECACA'; // red-200 — bottom rule under section rows
const XLSX_SUBTLE         = 'FF6B7280'; // gray-500 — subtitle / footer text
const XLSX_THIN_BORDER    = { style: 'thin', color: { argb: 'FFE5E7EB' } }; // gray-200
const XLSX_ACCENT_LINE    = { style: 'medium', color: { argb: XLSX_HEADER_BORDER } };
const XLSX_RAIL_FINISHED   = 'FF10B981'; // emerald-500 — finished song rail
const XLSX_RAIL_INPROGRESS = 'FFDC2626'; // red-600 — in-progress song rail
const XLSX_STATUS_PAID_BG   = 'FFECFDF5'; // emerald-50
const XLSX_STATUS_PAID_FG   = 'FF065F46'; // emerald-800
const XLSX_STATUS_UNPAID_BG = 'FFFEE2E2'; // red-100
const XLSX_STATUS_UNPAID_FG = 'FF991B1B'; // red-800
const XLSX_CURRENCY_FMT = {
  USD: '"$"#,##0.00',
  EUR: '"€"#,##0.00',
  GBP: '"£"#,##0.00',
  JPY: '"¥"#,##0',
  CAD: '"CA$"#,##0.00',
  AUD: '"AU$"#,##0.00',
};
const xlsxCurrencyFmt = (cur) => XLSX_CURRENCY_FMT[cur] || `"${cur || 'USD'} "#,##0.00`;

// Shared SQL fragment: a ledger row counts as "missing socials" when its own
// social_handles JSONB is empty AND it's not a split child (children inherit
// from the parent — flagging them would double-count). Mirrors the rule in
// routes/flags.js getMissingSocialsFlags().
const MISSING_SOCIALS_PREDICATE = `
  e.parent_id IS NULL
  AND (
    e.social_handles IS NULL
    OR jsonb_typeof(e.social_handles) <> 'array'
    OR jsonb_array_length(e.social_handles) = 0
  )
`;

// Dismissals are stored in the existing flag_dismissals table — same table
// the Flags page uses, scoped by flag_kind. Reusing it keeps a single audit
// trail of "this entry was hidden from a reconciliation view" rather than
// scattering a one-off boolean column across expenses.
//
// Two distinct flag kinds on this page:
//   - 'artist_campaign'              → row is fully dismissed (hidden from
//                                       the page until the user toggles
//                                       "Show dismissed").
//   - 'artist_campaign_not_campaign' → row is on the page but segregated
//                                       to the bottom "Not a campaign
//                                       expense" section. Still visible,
//                                       not counted in campaign stats.
const DISMISS_KIND = 'artist_campaign';
const NOT_CAMPAIGN_KIND = 'artist_campaign_not_campaign';
const DISMISSED_IDS_SUBQUERY = `
  SELECT entry_id FROM flag_dismissals WHERE flag_kind = '${DISMISS_KIND}'
`;

// Bound once so all six expense queries below read identically. Every one of
// them needs it: the index rollup and its fxPending companion must agree or a
// foreign-currency artist's card total contradicts the detail page, and the
// export must agree with the page it exports.
const NOT_BANK = excludeBankRows('e');

// ─── Two layers: what the bank paid, and what is still coming ────────────────
//
// This page used to read INVOICES and call the total "actual": $1,827,706 across
// 142 cards, the whole ledger with no category scope at all, while its own
// comment claimed "marketing-category ledger spend". Jerri read $274,289 here and
// $157,831 on Spend by Artist, because one page counted invoices and the other
// counted what left the bank.
//
//   SETTLED    what the STATEMENTS show, per artist. Not derived here — it comes
//              from buildPnl's by-artist rollup (see the export note at the
//              bottom of routes/reports.js), which is bank-basis, funding-pair
//              aware and part-aware, and ties to the P&L by construction.
//
//   COMMITTED  invoices with NO bank line yet — the forward view. Unpaid, plus
//              paid where no statement covers the date yet ("not in yet"), plus
//              paid where a statement SHOULD show it and doesn't, which stays in
//              Committed but is FLAGGED because it is a reconciliation problem
//              rather than a plan.
//
// The double-count guard is `bank_evidence IS NOT NULL`: an invoice the bank has
// already paid is counted on the settled side, so it must not also be counted
// here. That one predicate is why the two layers can be added together.
const CAMPAIGN_CATEGORIES = ['Marketing', 'Advertisements'];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Artist identity comes from lib/artist-key.js in JS, NOT from the SQL
// normalize_artist_key() this file used to group by. They are not the same rule:
// the SQL one is lowercase-and-strip, while artistBucketKey ALSO maps
// placeholders ("N/A", "TBD", "various") to unattributed. Keying one layer each
// way would give an artist two cards, and would count placeholder spend as an
// artist here while the report counted it as nobody's.
const keyOf = (raw) => artistBucketKey(raw) || '';

/**
 * Per-artist campaign money, both layers, keyed identically.
 *
 * @param {string} from,to  the range for SETTLED. Committed is deliberately
 *   UNBOUNDED — it is a forward view, and an invoice dated last November that is
 *   still unpaid belongs in it. Two numbers under one date range would otherwise
 *   quietly mean different things; the page says which is which.
 */
async function campaignLayers({ from, to }) {
  const { buildPnl } = require('./reports');
  const pnl = await buildPnl(from, to, null);
  const inScope = (byCat) => CAMPAIGN_CATEGORIES
    .reduce((t, c) => t + (Number(byCat?.[c]) || 0), 0);

  const settled = new Map();   // key -> { total, name }
  for (const a of pnl.by_artist?.artists || []) {
    const v = inScope(a.by_category);
    if (v) settled.set(a.key, { total: v, name: a.name });
  }
  const unattributedSettled = inScope(pnl.by_artist?.unattributed?.by_category);

  // ── Committed ──
  // EVERY family member, not just roots: a split payment's slices carry their own
  // artist, and crediting the root's artist with the whole thing is the bug that
  // was fixed on the P&L side. Each member contributes its OWN amount, so the
  // slices re-add to the family total.
  //
  // `excludeBankRows` is applied to the family ROOT, not the member. Split
  // children are inserted without `entry_source` (see the child INSERT in
  // routes/bookkeeping.js), so a member-level test lets a slice of a bank-born
  // payment through — 88 rows, $55,470.89 measured on the live ledger. The
  // bank-evidence guard below catches them anyway; this makes it explicit rather
  // than incidental.
  const { rows: members } = await pool.query(`
    SELECT e.id, e.parent_id, e.artist, e.amount, e.currency, e.fx_rate_to_usd,
           e.payment_status, e.payment_date, e.invoice_date, e.payee, e.category,
           -- Counted over EVERY member, settled or not: a payment the bank has
           -- already made still needs its influencer handles.
           (${MISSING_SOCIALS_PREDICATE}) AS missing_socials,
           ${bankEvidenceCols('e')}
      FROM expenses e
      JOIN expenses root ON root.id = COALESCE(e.parent_id, e.id)
     WHERE (e.deleted IS NULL OR e.deleted = FALSE)
       AND (e.voided IS NULL OR e.voided = FALSE)
       AND COALESCE(e.status, 'approved') IN ('approved', 'pending')
       AND e.category = ANY($1::text[])
       AND ${excludeBankRows('root')}
       AND e.id NOT IN (${DISMISSED_IDS_SUBQUERY})
       AND e.id NOT IN (SELECT entry_id FROM flag_dismissals WHERE flag_kind = '${NOT_CAMPAIGN_KIND}')
  `, [CAMPAIGN_CATEGORIES]);

  const committed = new Map();
  const socials = new Map();
  // The spelling to PRINT for an artist the settled layer has never heard of —
  // one whose campaign spend is all still committed. Without this a
  // committed-only card is titled with its bucket key: "Nobody Serious" renders
  // as "nobodyserious". Most-used spelling wins, ties alphabetically, which is
  // the rule shapeByArtist's bestName and Recoupments' bestSpelling already use.
  const spellings = new Map();
  const blank = () => ({
    total: 0, count: 0,
    unpaid: 0, unpaid_count: 0,
    awaiting_statement: 0, awaiting_count: 0,
    flagged: 0, flagged_count: 0,
  });
  let committedUnattributed = 0;
  for (const m of members) {
    if (m.missing_socials) socials.set(keyOf(m.artist), (socials.get(keyOf(m.artist)) || 0) + 1);
    // Already on a statement — the settled layer counts this money.
    if (m.bank_evidence) continue;
    const usd = usdOf(m.amount, m.currency, m.fx_rate_to_usd);
    if (!usd) continue;
    const key = keyOf(m.artist);
    if (key) {
      if (!spellings.has(key)) spellings.set(key, new Map());
      const tally = spellings.get(key);
      const raw = String(m.artist || '').trim();
      if (raw) tally.set(raw, (tally.get(raw) || 0) + 1);
    }
    if (!committed.has(key)) committed.set(key, blank());
    const c = committed.get(key);
    c.total += usd; c.count += 1;
    const paid = String(m.payment_status || '') === 'Paid';
    if (!paid) { c.unpaid += usd; c.unpaid_count += 1; }
    else if (m.bank_expected) { c.flagged += usd; c.flagged_count += 1; }
    else { c.awaiting_statement += usd; c.awaiting_count += 1; }
    if (!key) committedUnattributed += usd;
  }

  // What this page EXCLUDES, disclosed rather than left as an unexplained gap.
  //
  // In-scope open invoices are dropped for two reasons a person chose: dismissed
  // from the page entirely, or reclassified "not a campaign expense". Both are
  // correct and both move the Committed figure, so the total says so — the same
  // rule the P&L follows for its own dismissals. Measured while building this:
  // raw ledger open items came to ~$460k against a Committed of ~$380k, and the
  // difference was invisible.
  const { rows: [excl] } = await pool.query(`
    SELECT COUNT(*)::int AS count,
           COALESCE(SUM(CASE WHEN e.fx_rate_to_usd > 0 THEN e.amount / e.fx_rate_to_usd
                             WHEN UPPER(COALESCE(e.currency,'USD')) = 'USD' THEN e.amount
                             ELSE 0 END), 0)::numeric AS total
      FROM expenses e
      JOIN expenses root ON root.id = COALESCE(e.parent_id, e.id)
     WHERE (e.deleted IS NULL OR e.deleted = FALSE)
       AND (e.voided IS NULL OR e.voided = FALSE)
       AND COALESCE(e.status, 'approved') IN ('approved', 'pending')
       AND e.category = ANY($1::text[])
       AND ${excludeBankRows('root')}
       AND (e.id IN (${DISMISSED_IDS_SUBQUERY})
            OR e.id IN (SELECT entry_id FROM flag_dismissals WHERE flag_kind = '${NOT_CAMPAIGN_KIND}'))
  `, [CAMPAIGN_CATEGORIES]).catch((err) => {
    console.error('[artist-campaigns] exclusion disclosure unavailable:', err.message);
    return { rows: [{ count: null, total: null }] };
  });

  const bestSpelling = new Map();
  for (const [key, tally] of spellings) {
    bestSpelling.set(key, [...tally.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] || key);
  }

  // Per category, because Marketing and Advertisements are different problems:
  // ad-platform charges arrive per transaction and rarely name an artist, while
  // Marketing spend usually can be attributed by a person. One combined figure
  // hid which of the two the money was in.
  const unattributedByCategory = {};
  for (const c of CAMPAIGN_CATEGORIES) {
    unattributedByCategory[c] = round2(Number(pnl.by_artist?.unattributed?.by_category?.[c]) || 0);
  }

  // The ad POOL: spend a rule says bills the label, not a release. Disclosed on
  // its own, and it is what John's per-artist allocations will draw from.
  const labelLevel = {
    total: round2(inScope(pnl.by_artist?.label_level?.by_category)),
    count: pnl.by_artist?.label_level?.count || 0,
    by_category: Object.fromEntries(CAMPAIGN_CATEGORIES.map((c) =>
      [c, round2(Number(pnl.by_artist?.label_level?.by_category?.[c]) || 0)])),
  };

  return {
    settled, committed, socials, bestSpelling, unattributedSettled,
    unattributedByCategory, labelLevel,
    excluded: { count: excl.count, total: round2(excl.total) },
    committedUnattributed,
    unattributedCount: (pnl.by_artist?.unattributed?.count ?? null),
    scope: { categories: CAMPAIGN_CATEGORIES, from, to, basis: pnl.basis },
    // The whole-report figure, so the page can say what share of campaign spend
    // it is showing without asking a second endpoint.
    // ATTRIBUTABLE campaign spend: what names an artist plus what still could.
    // The label-level pool is deliberately outside it — including money nobody
    // can ever attribute would cap coverage below 100 forever.
    campaign_total: round2(inScope(pnl.by_artist?.unattributed?.by_category)
      + [...settled.values()].reduce((t, v) => t + v.total, 0)),
  };
}

// GET /api/artist-campaigns?from&to
//
// One card per artist, with the two layers campaignLayers() defines: SETTLED
// (what the statements show, in the range) and COMMITTED (invoices with no bank
// line yet, any date — a forward view is not a dated one).
//
// `actual_total` and `planned_total` are kept as ALIASES of settled and
// committed. The old `planned_total` came from influencer_campaigns.total_budget
// and was $0.00 on every card — there are zero campaigns — so its variance was
// just the actual restated. The campaign counts still come from that table,
// which is unused rather than wrong.
router.get('/', async (req, res) => {
  try {
    const to = String(req.query.to || new Date().toISOString().slice(0, 10));
    const from = String(req.query.from || `${to.slice(0, 4)}-01-01`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      return res.status(400).json({ success: false, error: 'from and to must be YYYY-MM-DD, from before to' });
    }
    const L = await campaignLayers({ from, to });

    const camps = await pool.query(`
      SELECT
        COALESCE(NULLIF(normalize_artist_key(a.name), ''), '') AS artist_key,
        MAX(a.name) AS artist_display,
        COUNT(*)::int AS campaign_count,
        SUM(COALESCE(ic.total_budget, 0))::numeric AS planned_budget,
        SUM(CASE WHEN ic.expense_id IS NULL THEN 1 ELSE 0 END)::int AS unlinked_campaign_count
      FROM influencer_campaigns ic
      LEFT JOIN artists a ON a.id = ic.artist_id
      GROUP BY artist_key
    `);

    const byKey = new Map();
    const card = (key) => {
      if (!byKey.has(key)) byKey.set(key, {
        artist_key: key, artist: key ? key : 'Not attributed to an artist',
        settled: 0, committed: 0, committed_unpaid: 0, committed_awaiting_statement: 0,
        committed_count: 0, unpaid_count: 0,
        flagged_no_bank_line: { count: 0, total: 0 },
        missing_socials_count: 0,
        planned_budget: 0, campaign_count: 0, unlinked_campaign_count: 0,
      });
      return byKey.get(key);
    };
    for (const [key, v] of L.settled) {
      if (!key) continue;                      // unattributed is its own block
      const c = card(key); c.artist = v.name || c.artist; c.settled = round2(v.total);
    }
    for (const [key, v] of L.committed) {
      if (!key) continue;
      const c = card(key);
      // Only when the settled layer did not already supply a real name.
      if (c.artist === key) c.artist = L.bestSpelling.get(key) || key;
      c.committed = round2(v.total);
      c.committed_count = v.count;
      c.committed_unpaid = round2(v.unpaid);
      c.unpaid_count = v.unpaid_count;
      c.committed_awaiting_statement = round2(v.awaiting_statement);
      c.flagged_no_bank_line = { count: v.flagged_count, total: round2(v.flagged) };
    }
    for (const [key, n] of L.socials) { if (key) card(key).missing_socials_count = n; }
    camps.rows.forEach((r) => {
      if (!r.artist_key) return;
      const c = card(r.artist_key);
      if (!c.artist || c.artist === r.artist_key) c.artist = r.artist_display || c.artist;
      c.planned_budget = round2(r.planned_budget);
      c.campaign_count = r.campaign_count || 0;
      c.unlinked_campaign_count = r.unlinked_campaign_count || 0;
    });

    const data = [...byKey.values()]
      .map((c) => ({
        ...c,
        // Compatibility aliases. The client reads the explicit names; these keep
        // any reader I have not re-pointed showing a real number instead of a
        // blank. Remove once the page is fully converted.
        actual_total: c.settled,
        planned_total: c.committed,
        unpaid_total: c.committed_unpaid,
        spend_count: c.committed_count,
      }))
      .sort((a, b) => (b.settled + b.committed) - (a.settled + a.committed)
        || (a.artist < b.artist ? -1 : 1));

    res.json({
      success: true,
      data,
      meta: {
        scope: L.scope,
        // The gap this page exists to close: campaign spend the statements show
        // that names no artist. Counted on the BANK basis, because that is what
        // the queue lists.
        unattributed: {
          settled: round2(L.unattributedSettled),
          committed: round2(L.committedUnattributed),
          by_category: L.unattributedByCategory,
        },
        campaign_total: L.campaign_total,
        // Not artist-attributable by rule — the pool. Kept out of the coverage
        // denominator and stated, never hidden.
        label_level: L.labelLevel,
        // Rows a person removed from this page. Stated because they change
        // Committed, and a figure that quietly omits $80k reads as complete.
        excluded: L.excluded,
        coverage_pct: L.campaign_total > 0
          ? round2(((L.campaign_total - L.unattributedSettled) / L.campaign_total) * 100)
          : null,
      },
    });
  } catch (err) {
    console.error('GET /api/artist-campaigns:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── The catch-up queue ──────────────────────────────────────────────────────
// GET /api/artist-campaigns/queue
//
// Every CAMPAIGN — an artist+song pair with invoices in scope — that nobody has
// marked complete. "Complete" is `song_campaign_status.finished`, which the song
// subpage has owned since it shipped; the flag was only ever visible one artist at
// a time, so the backlog it implies was invisible. Measured when this was written:
// 284 campaigns exist, 23 finished, 261 outstanding — $754,475 over 860 invoice
// rows and 116 artists.
//
// Route order: MUST sit above `/:artist` or the param route swallows it, exactly
// as /review-feed does.
//
// ── Two things that decide whether this is correct ──
//
// KEYS. `song_campaign_status` is written by PUT /bk/song-status as
// `normalize_artist_key($1)` + `LOWER(TRIM($2))`, so the finished join uses those
// and NOT artistBucketKey. The two disagree on placeholders ("N/A" is `na` in SQL
// and `''` in JS), and keying this the other way would list finished campaigns as
// outstanding.
//
// MONEY. `invoiced` and `unsettled` are INVOICE-side figures. The cards' Settled
// comes from buildPnl's bank-basis rollup, which has no song dimension at all — a
// per-song number can only be built from the ledger. Different question, so
// different names; calling this "settled" would invite a comparison that cannot
// hold.
router.get('/queue', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.id, e.artist, e.song, e.amount, e.currency, e.fx_rate_to_usd,
             e.payment_status, e.invoice_date, e.payee, e.category,
             normalize_artist_key(e.artist) AS akey,
             LOWER(TRIM(e.song)) AS skey,
             -- The song page's own has-a-document rule: a split child inherits
             -- its parent's file, or every slice of one invoice reads as missing.
             (((e.invoice_data IS NOT NULL AND e.invoice_data <> '') OR e.invoice_r2_key IS NOT NULL)
              OR ((p.invoice_data IS NOT NULL AND p.invoice_data <> '') OR p.invoice_r2_key IS NOT NULL)) AS has_invoice,
             ${bankEvidenceCols('e')}
        FROM expenses e
        JOIN expenses root ON root.id = COALESCE(e.parent_id, e.id)
        LEFT JOIN expenses p ON p.id = e.parent_id
        LEFT JOIN song_campaign_status scs
               ON scs.artist_key = normalize_artist_key(e.artist)
              AND scs.song_key   = LOWER(TRIM(e.song))
       WHERE (e.deleted IS NULL OR e.deleted = FALSE)
         AND (e.voided IS NULL OR e.voided = FALSE)
         AND COALESCE(e.status, 'approved') IN ('approved', 'pending')
         AND e.category = ANY($1::text[])
         -- A campaign needs both halves: no song is not a campaign, and no artist
         -- cannot be linked to a song subpage.
         AND COALESCE(TRIM(e.artist), '') <> ''
         AND COALESCE(TRIM(e.song), '') <> ''
         -- The family ROOT, never the member: split children are inserted without
         -- entry_source, so a member-level test lets a slice of a bank-born
         -- payment through.
         AND ${excludeBankRows('root')}
         AND e.id NOT IN (${DISMISSED_IDS_SUBQUERY})
         AND e.id NOT IN (SELECT entry_id FROM flag_dismissals WHERE flag_kind = '${NOT_CAMPAIGN_KIND}')
         AND COALESCE(scs.finished, FALSE) = FALSE
    `, [CAMPAIGN_CATEGORIES]);

    const byCampaign = new Map();
    // Most-used spelling wins for both halves, ties alphabetically — the rule
    // shapeByArtist and the page's own songGroups builder already use. The LINK
    // is built from these, so a wrong pick sends you to an empty song page.
    const bump = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
    for (const r of rows) {
      const key = `${r.akey}|${r.skey}`;
      if (!byCampaign.has(key)) {
        byCampaign.set(key, {
          key, artist_key: r.akey, song_key: r.skey,
          artist: '', song: '',
          invoiced: 0, unsettled: 0, unpaid_total: 0,
          rows: 0, unpaid_count: 0, no_invoice_file_count: 0, unsettled_count: 0,
          flagged_no_bank_line: 0,
          oldest: null, newest: null,
          __artistNames: new Map(), __songNames: new Map(),
        });
      }
      const c = byCampaign.get(key);
      const usd = usdOf(r.amount, r.currency, r.fx_rate_to_usd);
      c.rows += 1;
      c.invoiced += usd;
      bump(c.__artistNames, String(r.artist).trim(), 1);
      bump(c.__songNames, String(r.song).trim(), 1);
      const paid = String(r.payment_status || '') === 'Paid';
      if (!paid) { c.unpaid_count += 1; c.unpaid_total += usd; }
      if (!r.has_invoice) c.no_invoice_file_count += 1;
      if (!r.bank_evidence) {
        c.unsettled_count += 1;
        c.unsettled += usd;
        // Paid, no line, and a statement covering the date SHOULD have shown it.
        if (paid && r.bank_expected) c.flagged_no_bank_line += 1;
      }
      const day = r.invoice_date ? new Date(r.invoice_date).toISOString().slice(0, 10) : null;
      if (day) {
        if (!c.oldest || day < c.oldest) c.oldest = day;
        if (!c.newest || day > c.newest) c.newest = day;
      }
    }

    const best = (m) => [...m.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] || '';
    const data = [...byCampaign.values()].map((c) => {
      const { __artistNames, __songNames, ...rest } = c;
      return {
        ...rest,
        artist: best(__artistNames),
        song: best(__songNames),
        invoiced: round2(rest.invoiced),
        unsettled: round2(rest.unsettled),
        unpaid_total: round2(rest.unpaid_total),
      };
    }).sort((a, b) => b.invoiced - a.invoiced || (a.artist < b.artist ? -1 : 1));

    // Campaigns with a song but no artist cannot be linked to a subpage, so they
    // are absent from `data` — disclosed rather than silently dropped.
    const { rows: [orphan] } = await pool.query(`
      SELECT COUNT(DISTINCT LOWER(TRIM(e.song)))::int AS songs, COUNT(*)::int AS rows
        FROM expenses e
        JOIN expenses root ON root.id = COALESCE(e.parent_id, e.id)
       WHERE (e.deleted IS NULL OR e.deleted = FALSE)
         AND (e.voided IS NULL OR e.voided = FALSE)
         AND COALESCE(e.status, 'approved') IN ('approved', 'pending')
         AND e.category = ANY($1::text[])
         AND COALESCE(TRIM(e.song), '') <> ''
         AND COALESCE(TRIM(e.artist), '') = ''
         AND ${excludeBankRows('root')}
    `, [CAMPAIGN_CATEGORIES]).catch(() => ({ rows: [{ songs: null, rows: null }] }));

    res.json({
      success: true,
      data,
      meta: {
        scope: { categories: CAMPAIGN_CATEGORIES },
        // Reduced over the SAME list that is returned.
        count: data.length,
        invoiced: round2(data.reduce((t, c) => t + c.invoiced, 0)),
        unsettled: round2(data.reduce((t, c) => t + c.unsettled, 0)),
        with_unpaid: data.filter((c) => c.unpaid_count > 0).length,
        with_missing_invoice: data.filter((c) => c.no_invoice_file_count > 0).length,
        with_unsettled: data.filter((c) => c.unsettled_count > 0).length,
        clean: data.filter((c) => !c.unpaid_count && !c.no_invoice_file_count && !c.unsettled_count).length,
        unlinkable: { songs: orphan?.songs ?? null, rows: orphan?.rows ?? null },
        basis: 'invoice totals — the cards\' Settled figure is bank-basis and has no song dimension',
      },
    });
  } catch (err) {
    console.error('GET /api/artist-campaigns/queue:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Needs-review inbox ──────────────────────────────────────────────────────
// GET /api/artist-campaigns/review-feed
// Aggregates everything on the campaigns home page that needs human eyes:
//   - flagged expenses (flag reason, who, when)
//   - expenses with open comment threads (count + latest comment)
//   - review assignments per expense (multiple users per item)
// Route order: MUST sit above `/:artist` or the param route swallows it.
router.get('/review-feed', async (req, res) => {
  try {
    // Shared by the flagged-rows and commented-rows panels below. Carries the
    // bank exclusion so those two panels can't surface a statement row the
    // rest of the page has filtered out.
    const vis = `(e.deleted IS NULL OR e.deleted = FALSE)
      AND (e.voided IS NULL OR e.voided = FALSE)
      AND COALESCE(e.status, 'approved') IN ('approved', 'pending')
      AND ${NOT_BANK}`;

    const flags = await pool.query(`
      SELECT e.id, e.artist, e.payee, e.amount, e.currency, e.song,
             e.flag_reason, e.flagged_at,
             (SELECT u.name FROM users u WHERE u.id = e.flagged_by) AS flagged_by_name
      FROM expenses e
      WHERE e.flagged = TRUE AND ${vis}
      ORDER BY e.flagged_at DESC NULLS LAST
      LIMIT 100
    `);

    const comments = await pool.query(`
      SELECT e.id, e.artist, e.payee, e.amount, e.currency, e.song,
             c.cnt::int AS comment_count, c.last_comment, c.last_comment_by, c.last_comment_at
      FROM expenses e
      JOIN (
        SELECT ec.expense_id, COUNT(*) AS cnt,
               (ARRAY_AGG(ec.comment ORDER BY ec.created_at DESC))[1] AS last_comment,
               (ARRAY_AGG(u.name    ORDER BY ec.created_at DESC))[1] AS last_comment_by,
               MAX(ec.created_at) AS last_comment_at
        FROM expense_comments ec
        LEFT JOIN users u ON u.id = ec.user_id
        GROUP BY ec.expense_id
      ) c ON c.expense_id = e.id
      WHERE ${vis}
      ORDER BY c.last_comment_at DESC
      LIMIT 100
    `);

    const ids = [...new Set([...flags.rows.map(r => r.id), ...comments.rows.map(r => r.id)])];
    const assignments = {};
    if (ids.length) {
      const { rows } = await pool.query(`
        SELECT ra.expense_id, ra.user_id, u.name
        FROM review_assignments ra
        LEFT JOIN users u ON u.id = ra.user_id
        WHERE ra.expense_id = ANY($1::int[])
        ORDER BY u.name
      `, [ids]);
      for (const r of rows) {
        (assignments[r.expense_id] = assignments[r.expense_id] || []).push({ user_id: r.user_id, name: r.name });
      }
    }

    res.json({ success: true, data: { flags: flags.rows, comments: comments.rows, assignments } });
  } catch (err) {
    console.error('GET /api/artist-campaigns/review-feed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/artist-campaigns/review-assign — { entry_id, user_ids: [] }
// Replaces the full assignee set for an expense (multi-select UI sends
// the complete list each save; empty array clears all assignments).
router.post('/review-assign', async (req, res) => {
  try {
    const { entry_id, user_ids } = req.body || {};
    if (!entry_id) return res.status(400).json({ success: false, error: 'entry_id required' });
    if (!Array.isArray(user_ids)) return res.status(400).json({ success: false, error: 'user_ids array required' });
    const ids = [...new Set(user_ids.map(Number).filter(Number.isInteger))];

    await pool.query(`DELETE FROM review_assignments WHERE expense_id = $1`, [entry_id]);
    for (const uid of ids) {
      await pool.query(
        `INSERT INTO review_assignments (expense_id, user_id, assigned_by)
         VALUES ($1, $2, $3) ON CONFLICT (expense_id, user_id) DO NOTHING`,
        [entry_id, uid, req.user?.id || null]
      );
    }
    const { rows } = await pool.query(`
      SELECT ra.user_id, u.name FROM review_assignments ra
      LEFT JOIN users u ON u.id = ra.user_id
      WHERE ra.expense_id = $1 ORDER BY u.name
    `, [entry_id]);
    res.json({ success: true, data: { entry_id: Number(entry_id), assignees: rows } });
  } catch (err) {
    console.error('POST /api/artist-campaigns/review-assign:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Campaign chat ───────────────────────────────────────────────────────────
// One room per campaigns page/subpage. Route order: everything under
// /chat MUST sit above `/:artist` or the param route swallows it.

// GET /api/artist-campaigns/chat/:room?after=<id>
// Full history (last 300) when `after` is absent; only newer messages
// when polling with `after`. Includes the caller's read watermark so
// the client can compute its unread badge without a second request.
router.get('/chat/:room', async (req, res) => {
  try {
    const room = String(req.params.room || '').slice(0, 300);
    const after = Number(req.query.after) || 0;
    const { rows: messages } = await pool.query(`
      SELECT m.id, m.user_id, u.name AS user_name, m.body, m.mentions,
             m.edited_at, m.created_at
      FROM campaign_chat_messages m
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.room = $1 AND (m.deleted = FALSE OR m.deleted IS NULL)
        ${after ? 'AND m.id > $2' : ''}
      ORDER BY m.id ${after ? 'ASC' : 'DESC'}
      LIMIT 300
    `, after ? [room, after] : [room]);
    if (!after) messages.reverse();

    const { rows: readRows } = await pool.query(
      `SELECT last_read_id FROM campaign_chat_reads WHERE room = $1 AND user_id = $2`,
      [room, req.user.id]
    );
    res.json({ success: true, data: { messages, last_read_id: readRows[0]?.last_read_id || 0 } });
  } catch (err) {
    console.error('GET /api/artist-campaigns/chat/:room:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/artist-campaigns/chat/:room
// Body: { body, mentions: [userId], room_title, room_path }
// room_title/room_path ride along so mention notifications can say WHERE
// the mention happened and deep-link back without a room-key parser.
router.post('/chat/:room', async (req, res) => {
  try {
    const room = String(req.params.room || '').slice(0, 300);
    const body = String(req.body?.body || '').trim().slice(0, 4000);
    if (!body) return res.status(400).json({ success: false, error: 'Message body required' });
    const mentions = [...new Set((Array.isArray(req.body?.mentions) ? req.body.mentions : [])
      .map(Number).filter(Number.isInteger))];

    const { rows } = await pool.query(`
      INSERT INTO campaign_chat_messages (room, user_id, body, mentions)
      VALUES ($1, $2, $3, $4::jsonb)
      RETURNING id, user_id, body, mentions, edited_at, created_at
    `, [room, req.user.id, body, JSON.stringify(mentions)]);
    const msg = { ...rows[0], user_name: req.user.name };

    // Persist a bell notification per mentioned user (never self).
    const roomTitle = String(req.body?.room_title || '').slice(0, 200) || null;
    const roomPath = String(req.body?.room_path || '').slice(0, 300) || null;
    for (const uid of mentions) {
      if (uid === req.user.id) continue;
      await pool.query(`
        INSERT INTO user_mentions (user_id, actor_name, room, room_title, room_path, message_id, snippet)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [uid, req.user.name, room, roomTitle, roomPath, msg.id, body.slice(0, 140)]).catch(() => {});
    }

    res.json({ success: true, data: msg });
  } catch (err) {
    console.error('POST /api/artist-campaigns/chat/:room:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/artist-campaigns/chat/:room/read — { last_id }
router.post('/chat/:room/read', async (req, res) => {
  try {
    const room = String(req.params.room || '').slice(0, 300);
    const lastId = Number(req.body?.last_id) || 0;
    await pool.query(`
      INSERT INTO campaign_chat_reads (room, user_id, last_read_id, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (room, user_id)
      DO UPDATE SET last_read_id = GREATEST(campaign_chat_reads.last_read_id, EXCLUDED.last_read_id), updated_at = NOW()
    `, [room, req.user.id, lastId]);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/artist-campaigns/chat/:room/read:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/artist-campaigns/chat/messages/:id — edit OWN message.
router.put('/chat/messages/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = String(req.body?.body || '').trim().slice(0, 4000);
    if (!body) return res.status(400).json({ success: false, error: 'Message body required' });
    const mentions = [...new Set((Array.isArray(req.body?.mentions) ? req.body.mentions : [])
      .map(Number).filter(Number.isInteger))];
    const { rows } = await pool.query(`
      UPDATE campaign_chat_messages
      SET body = $1, mentions = $2::jsonb, edited_at = NOW()
      WHERE id = $3 AND user_id = $4 AND (deleted = FALSE OR deleted IS NULL)
      RETURNING id, user_id, body, mentions, edited_at, created_at
    `, [body, JSON.stringify(mentions), id, req.user.id]);
    if (!rows.length) return res.status(403).json({ success: false, error: 'You can only edit your own messages' });
    res.json({ success: true, data: { ...rows[0], user_name: req.user.name } });
  } catch (err) {
    console.error('PUT /api/artist-campaigns/chat/messages/:id:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/artist-campaigns/chat/messages/:id — own message, or any
// message for Admin / Superadmin (moderation). Soft delete.
router.delete('/chat/messages/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const isModerator = ['Admin', 'Superadmin'].includes(req.user?.role);
    const { rowCount } = await pool.query(
      isModerator
        ? `UPDATE campaign_chat_messages SET deleted = TRUE WHERE id = $1`
        : `UPDATE campaign_chat_messages SET deleted = TRUE WHERE id = $1 AND user_id = $2`,
      isModerator ? [id] : [id, req.user.id]
    );
    if (!rowCount) return res.status(403).json({ success: false, error: 'You can only delete your own messages' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/artist-campaigns/chat/messages/:id:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Excel export ────────────────────────────────────────────────────────────
// GET /api/artist-campaigns/export?artist=<name>
// Streams a styled .xlsx. When ?artist is omitted, includes every artist
// with campaign spend / releases / planned campaigns; when provided,
// scopes to that single artist. Layout:
//   - One sheet per artist — sectioned by song. Each section header row
//     shows the song title, release type/date, section total, and
//     Finished/In-progress status. Column headers render once at the
//     top; sections are colored merged rows between song groups.
//   Row filter: active only — excludes dismissed rows + rows marked
//   "not a campaign expense". Split children roll into their parent
//   via the song-key grouping so the workbook shape matches the page.
//
// Route order: this handler MUST sit above `/:artist` — Express matches
// registration order and `/export` would otherwise be swallowed by the
// param-style route.
router.get('/export', async (req, res) => {
  try {
    const scopedArtist = String(req.query?.artist || '').trim();
    const scopedSong = String(req.query?.song || '').trim();
    const scopeAll = !scopedArtist;

    // Pull the full active-campaign ledger in one query. Applying the
    // same filters the page uses:
    //   - not deleted, not rejected
    //   - not in flag_dismissals with kind = 'artist_campaign' (fully hidden)
    //   - NOT excluded when kind = 'artist_campaign_not_campaign' — those
    //     rows are visible on the page but segregated out of stats. Per
    //     the export scope decision, we exclude them from the workbook so
    //     totals match what an operator sees on-screen.
    const ledgerRes = await pool.query(`
      SELECT e.id, e.invoice_date, e.payee, e.description, e.category,
             e.artist, e.song, e.invoice_number, e.amount, e.currency,
             e.fx_rate_to_usd,
             e.payment_status, e.payment_date, e.boom_rep, e.notes,
             e.social_handles, e.parent_id, e.vendor_name,
             -- So the workbook can say what the BANK shows, not just what was
             -- invoiced. This is the whole point of exporting it while catching
             -- up on accounting: a row nobody can find on a statement is the work.
             ${bankEvidenceCols('e')},
             COALESCE(NULLIF(normalize_artist_key(e.artist), ''), 'unassigned') AS artist_key,
             -- TWO link directions, and both are real. A creator/cobrand campaign
             -- points AT its invoice (ic.expense_id); an ad campaign is funded by
             -- many charge slices, each of which points BACK (e.campaign_id,
             -- written by /bk/advertising). Reading only the first left every
             -- allocated ad slice showing no campaign at all.
             -- NB: no backticks in here — this is inside a JS template literal.
             COALESCE(
               (SELECT icb.name FROM influencer_campaigns icb WHERE icb.id = e.campaign_id),
               (SELECT ic.name  FROM influencer_campaigns ic  WHERE ic.expense_id = e.id LIMIT 1)
             ) AS campaign_name
      FROM expenses e
      WHERE (e.deleted IS NULL OR e.deleted = FALSE)
        AND (e.voided IS NULL OR e.voided = FALSE)
        AND COALESCE(e.status, 'approved') = 'approved'
        AND e.id NOT IN (${DISMISSED_IDS_SUBQUERY})
        AND e.id NOT IN (SELECT entry_id FROM flag_dismissals WHERE flag_kind = '${NOT_CAMPAIGN_KIND}')
        AND ${NOT_BANK}
        -- Same scope as the cards. Without it the workbook listed the whole
        -- ledger — rent, payroll, cards — under a heading about campaigns.
        AND e.category = ANY(${scopedArtist ? '$2' : '$1'}::text[])
        ${scopedArtist ? `AND normalize_artist_key(e.artist) = normalize_artist_key($1)` : ''}
      ORDER BY e.invoice_date DESC NULLS LAST, e.id DESC
    `, scopedArtist ? [scopedArtist, CAMPAIGN_CATEGORIES] : [CAMPAIGN_CATEGORIES]);

    // Planned campaigns for the rollup — grouped by artist_key so the
    // Summary sheet's Planned column can pair with each ledger bucket.
    const campsRes = await pool.query(`
      SELECT
        COALESCE(NULLIF(normalize_artist_key(a.name), ''), 'unassigned') AS artist_key,
        MAX(a.name) AS artist_display,
        COUNT(*)::int AS campaign_count,
        SUM(COALESCE(ic.total_budget, 0))::numeric AS planned_total
      FROM influencer_campaigns ic
      LEFT JOIN artists a ON a.id = ic.artist_id
      ${scopedArtist ? `WHERE normalize_artist_key(a.name) = normalize_artist_key($1)` : ''}
      GROUP BY artist_key
    `, scopedArtist ? [scopedArtist] : []);

    // Releases — matched to artists by artist_id so per-song sections
    // can label planned/released songs even when no expenses exist yet.
    const relsRes = await pool.query(`
      SELECT r.id, r.project_name, r.release_date, r.release_type,
             COALESCE(NULLIF(normalize_artist_key(a.name), ''), 'unassigned') AS artist_key
      FROM releases r
      LEFT JOIN artists a ON a.id = r.artist_id
      ${scopedArtist ? `WHERE normalize_artist_key(a.name) = normalize_artist_key($1)` : ''}
    `, scopedArtist ? [scopedArtist] : []);

    // Song-campaign status (finished flags) — used for the "Finished
    // X / Y" column on the Summary and the section-header status label.
    const statusRes = await pool.query(`
      SELECT artist_key, song_key, finished
        FROM song_campaign_status
       WHERE finished = TRUE
    `);

    // Group everything by artist_key.
    const finishedSet = new Set(statusRes.rows.map(r => `${r.artist_key}|${r.song_key}`));
    const byArtist = new Map(); // artist_key → { artist, songs: Map<songKey, { song, entries, release }> }

    const upsertArtist = (key, artistDisplay) => {
      if (!byArtist.has(key)) {
        byArtist.set(key, {
          artist_key: key,
          artist: artistDisplay || 'Unassigned',
          songs: new Map(),
          planned_total: 0,
          campaign_count: 0,
        });
      } else if (artistDisplay && byArtist.get(key).artist === 'Unassigned') {
        byArtist.get(key).artist = artistDisplay;
      }
      return byArtist.get(key);
    };

    const songKeyOf = (s) => {
      const t = String(s || '').toLowerCase().trim();
      return t || '__no_song__';
    };

    for (const row of ledgerRes.rows) {
      const a = upsertArtist(row.artist_key, row.artist);
      const sk = songKeyOf(row.song);
      if (!a.songs.has(sk)) {
        a.songs.set(sk, { song: row.song || '(no song)', entries: [], release: null, key: sk });
      }
      a.songs.get(sk).entries.push(row);
    }
    for (const r of relsRes.rows) {
      const a = upsertArtist(r.artist_key, null);
      const sk = songKeyOf(r.project_name);
      if (!a.songs.has(sk)) {
        a.songs.set(sk, { song: r.project_name, entries: [], release: r, key: sk });
      } else if (!a.songs.get(sk).release) {
        a.songs.get(sk).release = r;
      }
    }
    for (const c of campsRes.rows) {
      const a = upsertArtist(c.artist_key, c.artist_display);
      a.planned_total = Number(c.planned_total) || 0;
      a.campaign_count = c.campaign_count || 0;
    }

    // Song scope (release subpage export): keep only the matching song
    // section in every artist bucket. Uses the same songKeyOf normalizer
    // as the grouping above so "Song A" ≡ "song a".
    if (scopedSong) {
      const wantedKey = songKeyOf(scopedSong);
      for (const a of byArtist.values()) {
        for (const key of [...a.songs.keys()]) {
          if (key !== wantedKey) a.songs.delete(key);
        }
      }
    }

    // Skip artists with truly nothing (no ledger, no releases, no
    // campaigns) — they'd render as empty tabs otherwise.
    // Include an artist when they have at least one ledger row on
    // record OR a planned campaign. Stub-only artists (Release Tracker
    // entries with no expenses on file) are skipped — the workbook
    // reports on spend, so they'd be empty tabs.
    const artistHasSpend = (a) => Array.from(a.songs.values()).some(s => s.entries.length > 0);
    const artists = Array.from(byArtist.values())
      .filter(a => artistHasSpend(a) || a.planned_total > 0)
      .sort((a, b) => (a.artist || '').localeCompare(b.artist || ''));

    // Build the workbook.
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Market Street Dashboard';
    wb.created = new Date();

    for (const a of artists) {
      buildArtistSheet(wb, a, finishedSet);
    }

    const buf = await wb.xlsx.writeBuffer();
    const filenameArtist = scopedArtist ? scopedArtist.replace(/[^A-Za-z0-9._-]+/g, '_') : 'all';
    const dateStamp = new Date().toISOString().slice(0, 10);
    const filename = `marketst-artist-campaigns-${filenameArtist}-${dateStamp}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('GET /api/artist-campaigns/export:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sum helpers used by both sheets. USD-equivalent uses fx_rate_to_usd
// when locked (paid rows); rows without a locked rate convert at the
// cached daily ECB rate instead of silently pretending 1:1 (a €1,000
// row used to export as $1,000). USD rows pass through untouched.
function usdEquivalent(row) {
  const native = parseFloat(row.amount || 0);
  const locked = parseFloat(row.fx_rate_to_usd || 0);
  if (locked > 0) return native / locked;
  const cur = String(row.currency || 'USD').toUpperCase();
  if (cur === 'USD') return native;
  const live = getCached().rates?.[cur];
  return live > 0 ? native / live : native;
}
// What the bank says about one invoice row, in the workbook's words. The same
// three states lib/bank-evidence.js defines and the cards count:
//   settled            — a statement shows it
//   no line yet        — paid, but no statement covering the date exists yet
//   PAID, NO LINE      — paid, a statement DOES cover it, and it is not there
//   unpaid             — not paid, so nothing is expected
// Shouted only for the third, because that one is a discrepancy rather than a
// waiting game.
function bankState(r) {
  if (r.bank_evidence) return 'settled';
  if (String(r.payment_status || '') !== 'Paid') return 'unpaid';
  return r.bank_expected ? 'PAID, NO LINE' : 'no line yet';
}

// USD of the rows the BANK has not settled — the catch-up figure.
function unsettledUsd(rows) {
  return sumUsd(rows, (r) => !r.bank_evidence);
}

function sumUsd(rows, predicate) {
  let s = 0;
  for (const r of rows) {
    // Count EVERY row — parents and split children alike. A split parent
    // keeps only its own slice (its amount is reduced when children are
    // carved off), so summing all rows never double-counts. The old
    // parent_id skip silently dropped every child slice and made the
    // workbook totals disagree with the page (John's $1,250 gap).
    if (predicate && !predicate(r)) continue;
    s += usdEquivalent(r);
  }
  return s;
}
// Excel-safe sheet name: 31 chars max, must not contain \/*?[]:
const safeSheetName = (name) => {
  const cleaned = String(name || 'Artist').replace(/[\\\/*?[\]:]/g, '_').trim();
  return (cleaned || 'Artist').slice(0, 31);
};
// Deduplicate sheet names — two artists whose names collide after
// truncation would otherwise error out ExcelJS on write.
const uniqueSheetName = (wb, base) => {
  let name = safeSheetName(base);
  if (!wb.getWorksheet(name)) return name;
  let i = 2;
  while (wb.getWorksheet(name)) {
    const suffix = ` (${i})`;
    name = safeSheetName(base).slice(0, 31 - suffix.length) + suffix;
    i++;
  }
  return name;
};

function buildArtistSheet(wb, a, finishedSet) {
  const ws = wb.addWorksheet(uniqueSheetName(wb, a.artist), {
    views: [{ showGridLines: false }],
    pageSetup: {
      orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
    },
  });
  // Column set — dropped the CUR column (currency now shown as prefix in
  // the Amount cell via numFmt, saving 6 cols of horizontal chrome), and
  // dropped the Song column (redundant with the section headers). Wider
  // Vendor + Notes columns since operators actually read those.
  const columns = [
    { key: 'date',        header: 'Date',        width: 12, type: 'date' },
    { key: 'vendor',      header: 'Vendor',      width: 28 },
    { key: 'category',    header: 'Category',    width: 18 },
    { key: 'amount',      header: 'Amount',      width: 15, type: 'currency' },
    { key: 'usd',         header: 'USD',         width: 14, type: 'currency' },
    { key: 'status',      header: 'Status',      width: 10, align: { horizontal: 'center', vertical: 'middle' } },
    { key: 'paid_date',   header: 'Paid',        width: 12, type: 'date' },
    // Settled / no line / unpaid — the three states lib/bank-evidence.js draws.
    { key: 'bank',        header: 'Bank',        width: 16 },
    { key: 'rep',         header: 'Rep',         width: 12 },
    { key: 'socials',     header: 'Socials',     width: 26, wrap: true },
    { key: 'invoice_no',  header: 'Invoice #',   width: 14 },
    { key: 'campaign',    header: 'Campaign',    width: 22 },
    { key: 'notes',       header: 'Notes',       width: 36, wrap: true },
  ];
  ws.columns = columns.map(c => ({ key: c.key, width: c.width }));
  const lastCol = ws.getColumn(columns.length).letter;

  // Filter down to songs with actual spend. Release-tracker stubs that
  // never got a ledger row are irrelevant to a spending report — they
  // padded the workbook with "No spend yet" placeholder sections.
  const NO_SONG = '__no_song__';
  const songList = Array.from(a.songs.values())
    .filter(s => s.entries.length > 0)
    .sort((x, y) => {
      if (x.key === NO_SONG) return 1;
      if (y.key === NO_SONG) return -1;
      const xu = sumUsd(x.entries);
      const yu = sumUsd(y.entries);
      if (xu !== yu) return yu - xu;
      const xd = x.release?.release_date || '';
      const yd = y.release?.release_date || '';
      return String(yd).localeCompare(String(xd));
    });

  // Title + subtitle
  const t = ws.addRow([a.artist]);
  t.height = 28;
  t.font = { bold: true, size: 18, color: { argb: XLSX_TITLE_FG } };
  ws.mergeCells(`A1:${lastCol}1`);
  t.alignment = { vertical: 'middle', horizontal: 'left' };

  // Recompute totals against the filtered set so stubs don't inflate
  // finished ratios or song counts.
  const allEntries = [];
  for (const s of songList) allEntries.push(...s.entries);
  const actualUsd = sumUsd(allEntries);
  const unpaidUsd = sumUsd(allEntries, r => r.payment_status !== 'Paid');
  const totalSongs = songList.length;
  const finishedSongs = songList.filter(s => finishedSet.has(`${a.artist_key}|${s.key}`)).length;
  const fmtUsd = (n) => `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const subText =
    `${totalSongs} song${totalSongs === 1 ? '' : 's'} with spend  ·  ${finishedSongs} finished  ·  ` +
    // "Invoiced", not "Actual": this sheet sums the INVOICES, while the page's
    // Settled figure is what the statements show. They are different questions
    // and calling both "actual" is how two surfaces come to disagree in silence.
    `Invoiced ${fmtUsd(actualUsd)}  ·  Unsettled ${fmtUsd(unsettledUsd(allEntries))}`
    + `  ·  Unpaid ${fmtUsd(unpaidUsd)}`;
  const sub = ws.addRow([subText]);
  sub.font = { size: 10, color: { argb: XLSX_SUBTLE } };
  ws.mergeCells(`A2:${lastCol}2`);

  ws.addRow([]);
  const HEADER_ROW = 4;
  const header = ws.getRow(HEADER_ROW);
  header.values = columns.map(c => c.header);
  header.height = 24;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_HEADER_BG } };
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  header.eachCell(cell => {
    cell.border = {
      top: { style: 'thin', color: { argb: XLSX_HEADER_BORDER } },
      bottom: { style: 'medium', color: { argb: XLSX_HEADER_BORDER } },
      left: { style: 'thin', color: { argb: XLSX_HEADER_BORDER } },
      right: { style: 'thin', color: { argb: XLSX_HEADER_BORDER } },
    };
  });
  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: HEADER_ROW, showGridLines: false }];
  ws.autoFilter = `A${HEADER_ROW}:${lastCol}${HEADER_ROW}`;

  let bandCounter = 0;
  let sectionIndex = 0;
  for (const s of songList) {
    // Blank spacer between sections. Skipped before the first section
    // so the header row butts directly against its first section band.
    if (sectionIndex > 0) {
      const spacer = ws.addRow([]);
      spacer.height = 6;
    }
    sectionIndex++;

    const sectionSum = sumUsd(s.entries);
    const isFinished = finishedSet.has(`${a.artist_key}|${s.key}`);
    const releaseMeta = s.release
      ? `${s.release.release_type || 'Release'}${s.release.release_date ? ' · ' + String(s.release.release_date).slice(0, 10) : ''}`
      : null;
    const statusLabel = isFinished ? 'Finished' : 'In progress';
    // Section title row — song title bold on the left, "Total  $X" on
    // the right, release chip + status chip in the middle-right area.
    // Rendered as a single merged row so the whole band reads like a
    // section divider rather than another data row.
    const bits = [s.song || '(no song)'];
    if (releaseMeta) bits.push(releaseMeta);
    bits.push(`${statusLabel}`);
    bits.push(`Total ${fmtUsd(sectionSum)}`);
    // Song level, so INVOICE-side: the cards' Settled figure is bank-basis and
    // has no song dimension. Same reason the catch-up queue says "unsettled".
    const sectionUnsettled = unsettledUsd(s.entries);
    if (sectionUnsettled > 0) bits.push(`Unsettled ${fmtUsd(sectionUnsettled)}`);
    const secRow = ws.addRow([bits.join('   ·   ')]);
    secRow.height = 22;
    secRow.font = { bold: true, size: 11, color: { argb: XLSX_SECTION_FG } };
    secRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_SECTION_BG } };
    secRow.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    // Emerald left-rail on finished sections; brand-red on in-progress.
    // Gives a scannable visual cue as you flip through a long sheet.
    const railColor = isFinished ? XLSX_RAIL_FINISHED : XLSX_RAIL_INPROGRESS;
    secRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.border = {
        top: XLSX_ACCENT_LINE,
        bottom: { style: 'thin', color: { argb: XLSX_SECTION_BORDER } },
        left: colNumber === 1 ? { style: 'medium', color: { argb: railColor } } : undefined,
        right: undefined,
      };
    });
    ws.mergeCells(`A${secRow.number}:${lastCol}${secRow.number}`);

    // Sort within a section by category then invoice_date DESC. Same
    // ordering the on-page view uses so the workbook feels familiar.
    const sortedEntries = s.entries.slice().sort((x, y) => {
      const xc = (x.category || 'zzz').toLowerCase();
      const yc = (y.category || 'zzz').toLowerCase();
      if (xc !== yc) return xc.localeCompare(yc);
      const xd = x.invoice_date ? new Date(x.invoice_date).getTime() : 0;
      const yd = y.invoice_date ? new Date(y.invoice_date).getTime() : 0;
      return yd - xd;
    });

    for (const r of sortedEntries) {
      const socials = Array.isArray(r.social_handles)
        ? r.social_handles.map(h => `${h.platform || ''}: ${h.handle || ''}`.trim()).filter(Boolean).join(', ')
        : '';
      const cur = (r.currency || 'USD').toUpperCase();
      const row = ws.addRow({
        date: r.invoice_date ? new Date(r.invoice_date) : null,
        vendor: r.payee || r.vendor_name || '',
        category: r.category || '',
        bank: bankState(r),
        amount: r.amount != null ? parseFloat(r.amount) : null,
        usd: usdEquivalent(r),
        status: r.payment_status || 'Unpaid',
        paid_date: r.payment_date ? new Date(r.payment_date) : null,
        rep: r.boom_rep || '',
        socials,
        invoice_no: r.invoice_number || '',
        campaign: r.campaign_name || '',
        notes: r.notes || '',
      });
      row.height = 18;
      const banded = bandCounter % 2 === 1;
      bandCounter++;
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const col = columns[colNumber - 1];
        if (banded) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_ROW_BAND } };
        cell.border = { top: XLSX_THIN_BORDER, bottom: XLSX_THIN_BORDER, left: XLSX_THIN_BORDER, right: XLSX_THIN_BORDER };
        if (col?.align) cell.alignment = col.align;
        else if (col?.type === 'currency') cell.alignment = { horizontal: 'right', vertical: 'middle' };
        else if (col?.type === 'date') cell.alignment = { horizontal: 'center', vertical: 'middle' };
        else cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: !!col?.wrap };
      });
      // Column-specific formats
      row.getCell('amount').numFmt = xlsxCurrencyFmt(cur);
      row.getCell('usd').numFmt = xlsxCurrencyFmt('USD');
      row.getCell('date').numFmt = 'mm/dd/yyyy';
      row.getCell('paid_date').numFmt = 'mm/dd/yyyy';
      // Status pill — subtle emerald/rose tint so a scan reveals unpaid
      // rows without reading the column value.
      if ((r.payment_status || 'Unpaid') !== 'Paid') {
        row.getCell('status').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_STATUS_UNPAID_BG } };
        row.getCell('status').font = { color: { argb: XLSX_STATUS_UNPAID_FG }, bold: true, size: 10 };
      } else {
        row.getCell('status').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_STATUS_PAID_BG } };
        row.getCell('status').font = { color: { argb: XLSX_STATUS_PAID_FG }, bold: true, size: 10 };
      }
    }
  }
}

// GET /api/artist-campaigns/:artist
// All marketing-category ledger entries for this artist, plus all
// influencer_campaigns booked against them. The frontend groups by song
// itself — server returns the flat list so the same payload can drive
// the artist detail view AND the song subpage's filtering.
router.get('/:artist', async (req, res) => {
  try {
    const artistRaw = decodeURIComponent(req.params.artist);
    const isUnassigned = artistRaw.toLowerCase() === 'unassigned';
    // Dismissed rows are hidden by default; the page asks for them via
    // ?include_dismissed=true when the user opens the "Show dismissed" tray
    // so they can be restored.
    const includeDismissed = req.query.include_dismissed === 'true';

    // Parameter index for the campaign-category list: this query already uses $1
    // for the artist name, and only when the artist is named.
    const catIdx = isUnassigned ? 1 : 2;
    const ledgerSql = `
      SELECT e.id, e.invoice_date, e.payee, e.description, e.category, e.artist, e.song,
             e.invoice_number, e.amount, e.currency, e.payment_status, e.payment_date,
             e.social_handles, e.parent_id, e.notes, e.boom_rep,
             e.ufr, e.ufr_marked_at, e.recoupable, e.entry_source,
             e.status, e.cobrand, e.fx_rate_to_usd,
             e.flagged, e.flagged_at, e.flagged_by, e.flag_reason,
             (SELECT u.name FROM users u WHERE u.id = e.flagged_by) AS flagged_by_name,
             e.item_finished, e.item_finished_at, e.item_finished_by,
             (SELECT u.name FROM users u WHERE u.id = e.item_finished_by) AS item_finished_by_name,
             COALESCE(ec.comment_count, 0)::int AS comment_count,
             (SELECT jsonb_agg(jsonb_build_object('user_id', ra.user_id, 'name', ru.name) ORDER BY ru.name)
                FROM review_assignments ra
                LEFT JOIN users ru ON ru.id = ra.user_id
               WHERE ra.expense_id = e.id) AS review_assignees,
             e.is_bulk_deal, e.bulk_deal_quantity, e.bulk_deal_unit,
             COALESCE(bdi.delivered, 0)::int AS bulk_delivered,
             COALESCE(bdi.total, 0)::int     AS bulk_items_total,
             bdi.evidence AS bulk_evidence,
             p.social_handles AS parent_social_handles,
             ((e.invoice_data IS NOT NULL AND e.invoice_data != '') OR e.invoice_r2_key IS NOT NULL) AS has_invoice,
             ((p.invoice_data IS NOT NULL AND p.invoice_data != '') OR p.invoice_r2_key IS NOT NULL) AS parent_has_invoice,
             -- Is this row inside the campaign scope the CARDS count? The list
             -- below is deliberately NOT scoped — this page is where you look at
             -- everything for an artist, and hiding their Legal or Recording rows
             -- would lose context people rely on. So every row still arrives and
             -- the flag decides which ones the TOTALS may include, which is what
             -- lets those totals agree with the artist's card.
             (e.category = ANY($${catIdx}::text[])) AS in_scope,
             -- The FAMILY's source, not the row's. A split child is inserted
             -- without entry_source (see the child INSERT in
             -- routes/bookkeeping.js), so a slice of a bank-born payment reads as
             -- an invoice here — 88 rows / $55,470.89 on the live ledger. The row
             -- stays LISTED, because this page is where you look at everything,
             -- but the totals must exclude it or they cannot agree with the
             -- artist's card, which filters on the root.
             root.entry_source AS family_source,
             ${bankEvidenceCols('e')},
             -- TWO link directions, and both are real. A creator/cobrand campaign
             -- points AT its invoice (ic.expense_id); an ad campaign is funded by
             -- many charge slices, each of which points BACK (e.campaign_id,
             -- written by /bk/advertising). Reading only the first left every
             -- allocated ad slice showing no campaign at all.
             -- NB: no backticks in here — this is inside a JS template literal.
             COALESCE(e.campaign_id,
               (SELECT ic.id FROM influencer_campaigns ic WHERE ic.expense_id = e.id LIMIT 1)) AS campaign_id,
             COALESCE(
               (SELECT icb.name FROM influencer_campaigns icb WHERE icb.id = e.campaign_id),
               (SELECT ic.name  FROM influencer_campaigns ic  WHERE ic.expense_id = e.id LIMIT 1)
             ) AS campaign_name,
             EXISTS (
               SELECT 1 FROM flag_dismissals fd
               WHERE fd.entry_id = e.id AND fd.flag_kind = '${DISMISS_KIND}'
             ) AS dismissed,
             EXISTS (
               SELECT 1 FROM flag_dismissals fd
               WHERE fd.entry_id = e.id AND fd.flag_kind = '${NOT_CAMPAIGN_KIND}'
             ) AS not_campaign
      FROM expenses e
      LEFT JOIN expenses p ON p.id = e.parent_id
      JOIN expenses root ON root.id = COALESCE(e.parent_id, e.id)
      -- Bulk-deal deliverable rollup + evidence links, so campaign rows
      -- backed by a bulk deal show delivery progress and the posts that
      -- prove it. Only rows with a URL land in the evidence array.
      LEFT JOIN (
        SELECT expense_id,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE completed) AS delivered,
               jsonb_agg(jsonb_build_object(
                 'title', title, 'url', video_url, 'platform', platform,
                 'completed', completed) ORDER BY position, id)
                 FILTER (WHERE video_url IS NOT NULL AND video_url <> '') AS evidence
        FROM bulk_deal_items GROUP BY expense_id
      ) bdi ON bdi.expense_id = e.id
      LEFT JOIN (
        SELECT expense_id, COUNT(*) AS comment_count
        FROM expense_comments GROUP BY expense_id
      ) ec ON ec.expense_id = e.id
      WHERE (e.deleted IS NULL OR e.deleted = FALSE)
        AND (e.voided IS NULL OR e.voided = FALSE)
        AND COALESCE(e.status, 'approved') IN ('approved', 'pending')
        AND ${NOT_BANK}
        AND ${isUnassigned ? `(e.artist IS NULL OR TRIM(e.artist) = '')` : `normalize_artist_key(e.artist) = normalize_artist_key($1)`}
        ${includeDismissed ? '' : `AND e.id NOT IN (${DISMISSED_IDS_SUBQUERY})`}
        ${['Admin', 'Superadmin', 'Approver'].includes(req.user?.role)
          ? ''
          // Rows reclassified as "not a campaign expense" (advances, legal,
          // services) are bookkeeping-admin material — regular users don't
          // receive them at all, matching the hidden section client-side.
          : `AND e.id NOT IN (SELECT entry_id FROM flag_dismissals WHERE flag_kind = '${NOT_CAMPAIGN_KIND}')`}
      ORDER BY e.invoice_date DESC NULLS LAST, e.id DESC
    `;
    const ledger = await pool.query(
      ledgerSql,
      isUnassigned ? [CAMPAIGN_CATEGORIES] : [artistRaw, CAMPAIGN_CATEGORIES]
    );

    // Side query: dismissed count for the artist, so the page can show the
    // "Show dismissed (N)" toggle without re-fetching with include_dismissed.
    const dismissedCountSql = `
      SELECT COUNT(*)::int AS count
      FROM expenses e
      INNER JOIN flag_dismissals fd ON fd.entry_id = e.id AND fd.flag_kind = '${DISMISS_KIND}'
      WHERE (e.deleted IS NULL OR e.deleted = FALSE)
        AND (e.voided IS NULL OR e.voided = FALSE)
        -- Same exclusion as ledgerSql above, or the toggle offers to reveal N
        -- dismissed rows and then shows fewer than N.
        AND ${NOT_BANK}
        AND ${isUnassigned ? `(e.artist IS NULL OR TRIM(e.artist) = '')` : `normalize_artist_key(e.artist) = normalize_artist_key($1)`}
    `;
    const dismissedCount = await pool.query(
      dismissedCountSql,
      isUnassigned ? [] : [artistRaw]
    );

    const campSql = isUnassigned ? `
      SELECT ic.*, NULL::text AS artist_name,
             (SELECT COUNT(*)::int FROM influencer_campaign_creators icc WHERE icc.campaign_id = ic.id) AS creator_count
      FROM influencer_campaigns ic
      WHERE ic.artist_id IS NULL
      ORDER BY ic.campaign_date DESC NULLS LAST, ic.id DESC
    ` : `
      SELECT ic.*, a.name AS artist_name,
             (SELECT COUNT(*)::int FROM influencer_campaign_creators icc WHERE icc.campaign_id = ic.id) AS creator_count
      FROM influencer_campaigns ic
      LEFT JOIN artists a ON a.id = ic.artist_id
      WHERE normalize_artist_key(a.name) = normalize_artist_key($1)
      ORDER BY ic.campaign_date DESC NULLS LAST, ic.id DESC
    `;
    const campaigns = await pool.query(campSql, isUnassigned ? [] : [artistRaw]);

    // Resolve artist_id once so the frontend can wire the "create campaign"
    // affordance without a second round-trip.
    let artist_id = null;
    if (!isUnassigned) {
      const a = await pool.query(
        `SELECT id FROM artists WHERE normalize_artist_key(name) = normalize_artist_key($1) LIMIT 1`,
        [artistRaw]
      );
      artist_id = a.rows[0]?.id || null;
    }

    // Pull every release for this artist so the frontend can surface
    // song subpages even for songs that don't have any ledger rows yet
    // (i.e. a planned release whose spend hasn't landed on invoices).
    // Unassigned artist has no artist_id → skip the query entirely.
    let releases = [];
    if (artist_id) {
      const r = await pool.query(
        `SELECT id, project_name, release_date, release_type
           FROM releases
          WHERE artist_id = $1
          ORDER BY release_date DESC NULLS LAST, id DESC`,
        [artist_id]
      );
      releases = r.rows;
    }

    res.json({
      success: true,
      data: {
        artist: artistRaw,
        artist_id,
        ledger: ledger.rows,
        campaigns: campaigns.rows,
        releases,
        dismissed_count: dismissedCount.rows[0]?.count || 0,
        // The scope the TOTALS use. The row list is unscoped on purpose; each row
        // carries `in_scope` so the page can total the campaign spend (agreeing
        // with the artist's card) while still showing everything.
        scope: { categories: CAMPAIGN_CATEGORIES },
      },
    });
  } catch (err) {
    console.error('GET /api/artist-campaigns/:artist:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/artist-campaigns/link
// Attach an influencer_campaign to a ledger expense (manual reconciliation).
// Passing expense_id = null unlinks. Mirrors how the marketing.js POST sets
// expense_id when it auto-creates a manual_expense.
router.post('/link', async (req, res) => {
  try {
    const { campaign_id, expense_id } = req.body || {};
    if (!campaign_id) {
      return res.status(400).json({ success: false, error: 'campaign_id required' });
    }
    const { rows } = await pool.query(
      `UPDATE influencer_campaigns SET expense_id = $1 WHERE id = $2 RETURNING id, expense_id`,
      [expense_id || null, campaign_id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Campaign not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /api/artist-campaigns/link:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/artist-campaigns/dismiss — { entry_id }
// Hide a ledger row from this reconciliation view. Used for spends that
// don't actually need to be matched against a marketing campaign (e.g.
// catch-all "Services" rows that aren't creator-related). Reuses the same
// flag_dismissals table the Flags page uses so the audit trail is unified.
// Also flips expenses.artist_campaign to 'No' — dismissing = "this
// isn't a campaign expense," which is exactly what that column tracks.
router.post('/dismiss', async (req, res) => {
  try {
    const { entry_id } = req.body || {};
    if (!entry_id) return res.status(400).json({ success: false, error: 'entry_id required' });
    await pool.query(
      `INSERT INTO flag_dismissals (entry_id, flag_kind, dismissed_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (entry_id, flag_kind)
       DO UPDATE SET dismissed_at = NOW(), dismissed_by = EXCLUDED.dismissed_by`,
      [entry_id, DISMISS_KIND, req.user?.id || null]
    );
    await pool.query(
      `UPDATE expenses SET artist_campaign = 'No' WHERE id = $1`,
      [entry_id]
    ).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/artist-campaigns/dismiss:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/artist-campaigns/restore — { entry_id }
// Inverse of dismiss. Drops the flag_dismissals row so this entry shows
// back up on the page. Used by the undo toast + the dismissed tray's
// per-row Restore button. Also flips expenses.artist_campaign back
// to 'Yes' — restoring means the row IS campaign work again.
router.post('/restore', async (req, res) => {
  try {
    const { entry_id } = req.body || {};
    if (!entry_id) return res.status(400).json({ success: false, error: 'entry_id required' });
    await pool.query(
      `DELETE FROM flag_dismissals WHERE entry_id = $1 AND flag_kind = $2`,
      [entry_id, DISMISS_KIND]
    );
    await pool.query(
      `UPDATE expenses SET artist_campaign = 'Yes' WHERE id = $1`,
      [entry_id]
    ).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/artist-campaigns/restore:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/artist-campaigns/not-campaign — { entry_id, value: boolean }
// Mark/unmark a row as "not a campaign expense." Distinct from dismiss:
// these rows stay visible on the page (in the bottom section) so the
// reclassification stays auditable, rather than vanishing the way a
// dismiss does.
router.post('/not-campaign', async (req, res) => {
  try {
    const { entry_id, value } = req.body || {};
    if (!entry_id) return res.status(400).json({ success: false, error: 'entry_id required' });
    // Classification is family-wide: split children follow the parent.
    // Without this, auto-split fragments of a reclassified invoice kept
    // the schema-default artist_campaign='Yes' and resurrected the
    // artist's card on the index.
    const { rows: kids } = await pool.query(
      `SELECT id FROM expenses WHERE parent_id = $1`, [entry_id]
    );
    const familyIds = [Number(entry_id), ...kids.map(k => k.id)];
    if (value) {
      for (const id of familyIds) {
        await pool.query(
          `INSERT INTO flag_dismissals (entry_id, flag_kind, dismissed_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (entry_id, flag_kind)
           DO UPDATE SET dismissed_at = NOW(), dismissed_by = EXCLUDED.dismissed_by`,
          [id, NOT_CAMPAIGN_KIND, req.user?.id || null]
        );
      }
    } else {
      await pool.query(
        `DELETE FROM flag_dismissals WHERE entry_id = ANY($1::int[]) AND flag_kind = $2`,
        [familyIds, NOT_CAMPAIGN_KIND]
      );
    }
    // Keep expenses.artist_campaign in sync with the flag: value=true
    // (marking as not-campaign) → 'No', value=false (restoring) →
    // 'Yes'. Same rule the /dismiss + /restore endpoints use.
    await pool.query(
      `UPDATE expenses SET artist_campaign = $1 WHERE id = ANY($2::int[])`,
      [value ? 'No' : 'Yes', familyIds]
    ).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/artist-campaigns/not-campaign:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Artist-priority meta moved to the unified /api/bk/artist-meta endpoint
// (see routes/bookkeeping.js) so Recoupments and Artist Campaigns share
// the same priority value per artist. The old /api/artist-campaigns/
// artist-meta endpoint was removed when the schemas were unified.

// POST /api/artist-campaigns/:artist/rename-song
// Body: { old: string, new: string }
// Rename every mention of a song within this artist's scope. Three
// cascades run in one transaction so the ledger, release tracker, and
// song-campaign status all move together:
//   1. UPDATE expenses.song       — for approved rows matching the
//      old song (case-insensitive) belonging to this artist.
//   2. UPDATE releases.project_name — for releases under this artist_id
//      matching the old title (case-insensitive).
//   3. UPDATE song_campaign_status.song_key — moves the finished flag
//      + notes to the new key. On collision (target already has a row)
//      the old row is dropped and the target's status wins; that's the
//      simpler merge story and avoids overwriting notes silently.
router.post('/:artist/rename-song', async (req, res) => {
  const artistRaw = decodeURIComponent(req.params.artist);
  const oldName = String(req.body?.old || '').trim();
  const newName = String(req.body?.new || '').trim();
  if (!oldName) return res.status(400).json({ success: false, error: 'old song name required' });
  if (!newName) return res.status(400).json({ success: false, error: 'new song name required' });
  if (oldName === newName) return res.json({ success: true, changed: false });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const oldKey = oldName.toLowerCase().trim();
    const newKey = newName.toLowerCase().trim();

    // 1. Ledger rows.
    const exp = await client.query(
      `UPDATE expenses SET song = $1
        WHERE normalize_artist_key(artist) = normalize_artist_key($2)
          AND LOWER(TRIM(song)) = $3
          AND (deleted = false OR deleted IS NULL)`,
      [newName, artistRaw, oldKey]
    );

    // 2. Release tracker. Match by artist_id → normalized name so the
    // rename catches releases even when the tracker uses a different
    // spelling of the artist.
    const artistRow = await client.query(
      `SELECT id FROM artists WHERE normalize_artist_key(name) = normalize_artist_key($1) LIMIT 1`,
      [artistRaw]
    );
    const artistId = artistRow.rows[0]?.id || null;
    let rel = { rowCount: 0 };
    if (artistId) {
      rel = await client.query(
        `UPDATE releases SET project_name = $1
          WHERE artist_id = $2
            AND LOWER(TRIM(project_name)) = $3`,
        [newName, artistId, oldKey]
      );
    }

    // 3. song_campaign_status. Move the finished flag + notes to the
    // new key. If the target already has a row, drop the source
    // (target wins) so the merge doesn't need conflict UI.
    const aKey = (await client.query(`SELECT normalize_artist_key($1) AS k`, [artistRaw])).rows[0]?.k;
    if (aKey && oldKey !== newKey) {
      const targetExists = await client.query(
        `SELECT 1 FROM song_campaign_status WHERE artist_key = $1 AND song_key = $2 LIMIT 1`,
        [aKey, newKey]
      );
      if (targetExists.rowCount) {
        await client.query(
          `DELETE FROM song_campaign_status WHERE artist_key = $1 AND song_key = $2`,
          [aKey, oldKey]
        );
      } else {
        await client.query(
          `UPDATE song_campaign_status SET song_key = $1 WHERE artist_key = $2 AND song_key = $3`,
          [newKey, aKey, oldKey]
        );
      }
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      data: {
        ledger_rows: exp.rowCount || 0,
        release_rows: rel.rowCount || 0,
        old: oldName,
        new: newName,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/artist-campaigns/:artist/rename-song:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
