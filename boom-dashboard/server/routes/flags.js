/**
 * Aggregated "flags" / data-quality endpoint.
 *
 * Surfaces potential errors across the catalog that admins should clean up:
 *   - Potential duplicate releases   (same artist+name / UPC / ISRC / Spotify URI)
 *   - Potential duplicate artists    (fuzzy name match)
 *   - Releases missing genre
 *   - Released-date-passed releases missing UPC or ISRC
 *   - Artists missing genre (active artists only — i.e. with releases)
 *
 * Returns a flat array of category objects with their items / groups so the
 * Flags page can render each as its own collapsible section.
 */

const express = require('express');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// ── Duplicate detection helpers (mirrored from existing endpoints) ───────────
const SENTINEL_VALUES = "('n/a', 'na', 'none', 'tbd', '-', '—', 'unknown', 'missing', 'pending', '?', '0', '00')";
const sentinelGuard = (col) => `LOWER(TRIM(${col})) NOT IN ${SENTINEL_VALUES}`;

function normalizeArtistName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

// Canonical normalizer lives in server/lib/normalize-invoice-num.js.
// Pulled in here instead of hand-copied so the rules can't drift out
// of sync with the vendor-submit + duplicate-invoice gates.
const { normalizeInvoiceNum } = require('../lib/normalize-invoice-num');
// ONE definition of what counts as an artist name, shared with the P&L, Spend
// by Artist and the needs-artist queue. This file used to have no opinion:
// "n/a" was just an unrostered name, so the artist detectors treated it as a
// misspelling of a real artist and offered to correct it.
const { namesAnArtist } = require('../lib/artist-key');
function levDist(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length, n = b.length;
  const v = new Array(n + 1);
  for (let j = 0; j <= n; j++) v[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = v[0]; v[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = v[j];
      v[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, v[j], v[j - 1]);
      prev = tmp;
    }
  }
  return v[n];
}

async function getDuplicateReleases() {
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
      groups.push({ reason, releases: row.releases });
    }
  }

  // Merge groups that share exactly the same release-id set (so a UPC dup
  // and a name+artist dup of the same pair render as one group with both
  // reasons listed).
  const merged = new Map();
  for (const g of groups) {
    const sig = g.releases.map(r => r.id).sort((a, b) => a - b).join(',');
    if (merged.has(sig)) {
      const ex = merged.get(sig);
      if (!ex.reasons.includes(g.reason)) ex.reasons.push(g.reason);
    } else {
      merged.set(sig, { reasons: [g.reason], releases: g.releases });
    }
  }
  return Array.from(merged.values())
    // Stable group_key = sorted release-id signature; same set always hashes
    // to the same key across rescans so dismissals stick.
    .map(g => ({
      ...g,
      group_key: g.releases.map(r => r.id).sort((a, b) => a - b).join(','),
    }))
    .sort((a, b) => b.releases.length - a.releases.length);
}

async function getDuplicateArtists() {
  const { rows } = await pool.query(`
    SELECT a.id, a.name, a.total_releases,
           (SELECT COUNT(*) FROM contracts c WHERE c.artist_id = a.id)::int AS contract_count
    FROM artists a ORDER BY a.name ASC`);
  if (rows.length < 2) return [];

  const normed = rows.map(r => ({ ...r, _n: normalizeArtistName(r.name) })).filter(r => r._n.length >= 3);
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
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
  return [...groups.values()]
    .filter(g => g.length >= 2)
    .map(g => g.sort((a, b) => (b.total_releases + b.contract_count) - (a.total_releases + a.contract_count)));
}

// Stable group-key generators per duplicate-flag category. The same group
// (same IDs / payees) must always produce the same key across rescans so
// dismissals stick. Mirrors the sort + signature pattern getDuplicateReleases
// uses internally to dedupe overlapping reason-buckets.
const groupKeyForArtists = (group) =>
  group.map(a => a.id).sort((a, b) => a - b).join(',');
const groupKeyForVendors = (group) =>
  group.map(v => (v.payee || '').toLowerCase().trim()).sort().join('|');

// Distinct vendor payees from the ledger that look like they might be the
// same vendor under two names — same normalized key, or Levenshtein ≤
// threshold on the normalized form. Skips pairs that have already been
// linked via vendor_aliases (admins explicitly resolved those). Each
// group surfaces enough metadata for an admin to pick the canonical
// spelling and merge — invoice count, latest invoice date, W9 status.
async function getDuplicateVendors() {
  // Aggregate per payee. Mirrors the Vendors directory query so the
  // information shown here matches what the Vendors page would show.
  const { rows } = await pool.query(`
    SELECT TRIM(payee) AS payee,
           COUNT(*)::int                 AS invoice_count,
           MAX(invoice_date)             AS last_invoice,
           MIN(invoice_date)             AS first_invoice,
           BOOL_OR(((w9_data IS NOT NULL AND w9_data != '') OR w9_r2_key IS NOT NULL)) AS has_w9
      FROM expenses
     WHERE (deleted = false OR deleted IS NULL)
       AND payee IS NOT NULL AND TRIM(payee) != ''
     GROUP BY TRIM(payee)
  `);
  if (rows.length < 2) return [];

  // Aliases that already link two payees should be excluded — admins
  // intentionally established those, they're not duplicates.
  const { rows: aliasRows } = await pool.query(
    `SELECT LOWER(TRIM(primary_name)) AS p, LOWER(TRIM(alias)) AS a FROM vendor_aliases`
  ).catch(() => ({ rows: [] }));
  const aliasedPairs = new Set();
  for (const r of aliasRows) {
    // Use lexicographic key so (A,B) and (B,A) collide.
    const k = [r.p, r.a].sort().join('||');
    aliasedPairs.add(k);
  }

  const normed = rows
    .map(r => ({ ...r, _n: normalizeArtistName(r.payee) }))
    .filter(r => r._n.length >= 3);
  if (normed.length < 2) return [];

  // Union-find via exact normalized match or Levenshtein ≤ length-scaled
  // threshold — same pattern as getDuplicateArtists. Vendor names have
  // higher noise (LLC suffixes, commas, "DBA" tags) so the normalization
  // strip is doing most of the work; Levenshtein catches typos.
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  normed.forEach(r => parent.set(r.payee, r.payee));

  for (let i = 0; i < normed.length; i++) {
    for (let j = i + 1; j < normed.length; j++) {
      const a = normed[i], b = normed[j];
      if (Math.abs(a._n.length - b._n.length) > 3) continue;
      // Skip pairs already linked via vendor_aliases.
      const pairKey = [a.payee.toLowerCase(), b.payee.toLowerCase()].sort().join('||');
      if (aliasedPairs.has(pairKey)) continue;
      if (a._n === b._n) { union(a.payee, b.payee); continue; }
      const d = levDist(a._n, b._n);
      const longer = Math.max(a._n.length, b._n.length);
      const threshold = longer <= 6 ? 1 : longer <= 12 ? 2 : 3;
      if (d <= threshold) union(a.payee, b.payee);
    }
  }

  const groups = new Map();
  for (const r of normed) {
    const root = find(r.payee);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push({
      payee: r.payee,
      invoice_count: r.invoice_count || 0,
      last_invoice: r.last_invoice,
      first_invoice: r.first_invoice,
      has_w9: !!r.has_w9,
    });
  }
  return [...groups.values()]
    .filter(g => g.length >= 2)
    // Sort each group so the canonical-looking entry is first: most
    // invoices wins, then has-w9, then earliest first invoice (longest
    // history). Admin can override via the radio button.
    .map(g => g.sort((a, b) => {
      if (b.invoice_count !== a.invoice_count) return b.invoice_count - a.invoice_count;
      if (a.has_w9 !== b.has_w9) return a.has_w9 ? -1 : 1;
      const af = a.first_invoice ? new Date(a.first_invoice).getTime() : Infinity;
      const bf = b.first_invoice ? new Date(b.first_invoice).getTime() : Infinity;
      return af - bf;
    }))
    .sort((a, b) => {
      const aN = a.reduce((s, x) => s + (x.invoice_count || 0), 0);
      const bN = b.reduce((s, x) => s + (x.invoice_count || 0), 0);
      return bN - aN;
    });
}

// Duplicate ledger entries that look like the same invoice was booked twice.
// Three detection tiers, each producing a group; identical entry-id sets are
// merged so a group can carry multiple reasons.
//
//   Tier 1 (high)   — same vendor (or aliased vendor) + normalized invoice #
//                     + same amount + same currency. Almost certainly a dupe.
//   Tier 2a (high)  — same vendor + normalized invoice # but the amounts /
//                     currencies disagree. Probably one is wrong; needs eyes.
//   Tier 2b (med)   — same vendor + same amount + same currency + invoice
//                     dates within ±7 days when BOTH sides have no invoice #.
//                     Catches recurring uncategorized expenses booked twice.
//   Tier 3 (low)    — same normalized invoice # (length ≥ 4) under different
//                     vendors with the same amount. Catches mis-routed entries
//                     where the wrong vendor was selected on import.
//
// Group_key is the sorted entry-id signature (same pattern as duplicate
// releases) so dismissals stick across rescans.
async function getDuplicateInvoices() {
  // Parents-only: children inherit the parent's invoice number after a
  // split, so flagging both would double-count the same logical invoice.
  const { rows: entries } = await pool.query(`
    SELECT e.id, e.invoice_date, e.payee, e.vendor_name, e.invoice_number,
           e.amount, e.currency, e.payment_status, e.status,
           e.artist, e.song, e.category, e.artist_breakdown, e.entry_source,
           e.id AS file_entry_id,
           e.proof_filename, e.receipt_filename,
           ((e.proof_data IS NOT NULL AND e.proof_data != '')
             OR e.proof_r2_key IS NOT NULL) AS has_proof,
           (e.receipt_data IS NOT NULL AND e.receipt_data != '') AS has_receipt,
           e.invoice_filename,
           ((e.invoice_data IS NOT NULL AND e.invoice_data != '')
             OR e.invoice_r2_key IS NOT NULL) AS has_invoice
      FROM expenses e
     WHERE (e.deleted = false OR e.deleted IS NULL)
       AND (e.voided  = false OR e.voided  IS NULL)
       AND e.status != 'rejected'
       AND e.parent_id IS NULL
       AND e.payee IS NOT NULL AND TRIM(e.payee) != ''
       -- Rows booked FROM a bank debit are not invoices. All 1,824 of them
       -- carry no invoice number and no invoice file, because there was never a
       -- vendor invoice — a statement line was turned into a ledger row. They
       -- therefore fall into the "no invoice #" tier automatically and get
       -- reported as duplicate invoices, which is a category error: a bank
       -- charging five identical $5 transfer fees on one day is normal, and
       -- 129 such rows were being flagged.
       --
       -- Genuine double-counting on this side is already covered elsewhere:
       -- the booked-duplicate flag catches a debit booked twice, and the
       -- ledger-extras audit compares against what the statement proves.
       AND (e.entry_source IS DISTINCT FROM 'bank_statement')
  `);
  if (entries.length < 2) return [];

  // Build a vendor-alias resolver: payees linked via vendor_aliases collapse
  // to the same canonical key. Without this, "Eddie Marange" and "Edward
  // Marange" never group even though they're explicitly linked. Mirrors the
  // same lookup pattern check-dup / W9-on-file use, but in-memory union-find
  // because we're already doing a single-pass scan over every entry.
  const { rows: aliasRows } = await pool.query(
    `SELECT LOWER(TRIM(primary_name)) AS p, LOWER(TRIM(alias)) AS a FROM vendor_aliases`
  ).catch(() => ({ rows: [] }));
  const aparent = new Map();
  const afind = (x) => { while (aparent.get(x) !== x) { aparent.set(x, aparent.get(aparent.get(x))); x = aparent.get(x); } return x; };
  const aunion = (a, b) => { const ra = afind(a), rb = afind(b); if (ra !== rb) aparent.set(ra, rb); };
  const aensure = (k) => { if (k && !aparent.has(k)) aparent.set(k, k); };
  for (const r of aliasRows) {
    aensure(r.p); aensure(r.a);
    if (r.p && r.a) aunion(r.p, r.a);
  }
  const vendorKey = (name) => {
    const k = String(name || '').toLowerCase().trim();
    if (!k) return '';
    aensure(k);
    return afind(k);
  };

  // Precompute the bucketable form once. Amount is stored as integer cents
  // so floating-point comparisons don't bite (a stored 100.10 wouldn't
  // group with a stored 100.099999 otherwise).
  const enriched = entries.map(e => {
    const vk = vendorKey(e.payee || e.vendor_name);
    const inv = normalizeInvoiceNum(e.invoice_number);
    const amtNum = Number(e.amount);
    const amtCents = Number.isFinite(amtNum) ? Math.round(amtNum * 100) : null;
    const cur = String(e.currency || 'USD').toUpperCase();
    const d = e.invoice_date ? new Date(e.invoice_date) : null;
    // A row carrying a multi-slice artist_breakdown is one SLICE of a split
    // invoice, not a whole invoice. Splitting is the documented way to spread
    // one invoice across songs/artists, and every slice keeps the invoice
    // number by design — so slices sharing a vendor + invoice # is expected,
    // and when the split is even they share an amount too.
    let bd = e.artist_breakdown;
    if (typeof bd === 'string') { try { bd = JSON.parse(bd); } catch { bd = null; } }
    const isSplitSlice = Array.isArray(bd) && bd.length > 1;
    return { ...e, _split: isSplitSlice, _vk: vk, _inv: inv, _amtCents: amtCents, _cur: cur,
             _date: d && !isNaN(d.getTime()) ? d : null };
  });

  const rawGroups = []; // { reason, severity, entries }

  // ── Tier 1 + 2a: same (vendor, invoice #). Sub-group by amount/currency
  // to decide whether the amounts agree (Tier 1) or differ (Tier 2a).
  const byVendorInv = new Map();
  for (const e of enriched) {
    if (!e._vk || !e._inv) continue;
    const k = `${e._vk}|${e._inv}`;
    if (!byVendorInv.has(k)) byVendorInv.set(k, []);
    byVendorInv.get(k).push(e);
  }
  for (const bucket of byVendorInv.values()) {
    if (bucket.length < 2) continue;
    // Every row here is a slice of a split invoice, so sharing the vendor and
    // invoice number is the design, not a duplicate — and an evenly split
    // invoice makes the slices share an amount as well, which is what this
    // check used to read as "the same invoice booked twice".
    //
    // The parents-only filter above was meant to cover this, but it only helps
    // when a split is parent + children. These slices are all parent_id IS NULL,
    // so it never applied to them.
    //
    // The trade is deliberate: a split invoice genuinely entered twice will no
    // longer be caught by THIS rule. Same vendor + amount + date still catches
    // the blank-invoice case, and the booked-duplicate check on Statements
    // catches the bank-side version.
    if (bucket.every(e => e._split)) continue;
    const subKeys = new Set(bucket.map(e => `${e._amtCents}|${e._cur}`));
    if (subKeys.size === 1) {
      rawGroups.push({
        reason: 'Same vendor + invoice # + amount',
        severity: 'high',
        entries: bucket,
      });
    } else {
      // Mix of agreeing + disagreeing amounts under one invoice #; surface
      // the entire bucket so the admin sees the inconsistency in context.
      rawGroups.push({
        reason: 'Same vendor + invoice # (amount mismatch)',
        severity: 'high',
        entries: bucket,
      });
    }
  }

  // ── Tier 2b: blank invoice # on BOTH sides — same vendor + amount +
  // currency, invoice dates within ±7 days. Group via union-find on a
  // sorted-by-date sliding window inside each (vendor|amount|currency)
  // partition so a chain of 3 entries each 6 days apart all collapse to
  // one group instead of two overlapping pairs.
  const blankParent = new Map();
  const bfind = (x) => { while (blankParent.get(x) !== x) { blankParent.set(x, blankParent.get(blankParent.get(x))); x = blankParent.get(x); } return x; };
  const bunion = (a, b) => { const ra = bfind(a), rb = bfind(b); if (ra !== rb) blankParent.set(ra, rb); };
  const byBlankCore = new Map();
  for (const e of enriched) {
    if (e._inv) continue;                  // skip entries that have an invoice #
    if (!e._vk || !e._amtCents || !e._date) continue;
    blankParent.set(e.id, e.id);
    const k = `${e._vk}|${e._amtCents}|${e._cur}`;
    if (!byBlankCore.has(k)) byBlankCore.set(k, []);
    byBlankCore.get(k).push(e);
  }
  for (const list of byBlankCore.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a._date.getTime() - b._date.getTime());
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const diffDays = (list[j]._date - list[i]._date) / 86400000;
        if (diffDays > 7) break;           // sorted — anything further is also > 7
        bunion(list[i].id, list[j].id);
      }
    }
  }
  const blankGroups = new Map();
  for (const e of enriched) {
    if (!blankParent.has(e.id)) continue;
    const root = bfind(e.id);
    if (!blankGroups.has(root)) blankGroups.set(root, []);
    blankGroups.get(root).push(e);
  }
  for (const grp of blankGroups.values()) {
    if (grp.length < 2) continue;
    rawGroups.push({
      reason: 'Same vendor + amount + date (no invoice #)',
      severity: 'medium',
      entries: grp,
    });
  }

  // ── Tier 3: same normalized invoice # under DIFFERENT vendors, with the
  // same amount and currency. Requires inv length ≥ 4 — tiny numbers like
  // "1" / "2" / "3" collide across every vendor on the platform and would
  // flood the tab.
  const byInv = new Map();
  for (const e of enriched) {
    if (!e._inv || e._inv.length < 4 || !e._amtCents || !e._vk) continue;
    const k = `${e._inv}|${e._amtCents}|${e._cur}`;
    if (!byInv.has(k)) byInv.set(k, []);
    byInv.get(k).push(e);
  }
  for (const list of byInv.values()) {
    if (list.length < 2) continue;
    const distinctVendors = new Set(list.map(e => e._vk));
    if (distinctVendors.size < 2) continue; // already caught by Tier 1/2a
    rawGroups.push({
      reason: 'Same invoice # under different vendors',
      severity: 'low',
      entries: list,
    });
  }

  // Merge groups that share an identical entry-id set so one card can list
  // multiple reasons (mirrors the merge step in getDuplicateReleases).
  const order = { low: 1, medium: 2, high: 3 };
  const merged = new Map();
  for (const g of rawGroups) {
    const sig = g.entries.map(e => e.id).sort((a, b) => a - b).join(',');
    if (merged.has(sig)) {
      const ex = merged.get(sig);
      if (!ex.reasons.includes(g.reason)) ex.reasons.push(g.reason);
      if ((order[g.severity] || 0) > (order[ex.severity] || 0)) ex.severity = g.severity;
    } else {
      merged.set(sig, { reasons: [g.reason], severity: g.severity, entries: g.entries });
    }
  }

  const toUi = (e) => ({
    id: e.id,
    invoice_date: e.invoice_date,
    payee: e.payee,
    vendor_name: e.vendor_name,
    invoice_number: e.invoice_number,
    amount: e.amount,
    currency: e.currency,
    payment_status: e.payment_status,
    entry_source: e.entry_source,
    status: e.status,
    artist: e.artist,
    song: e.song,
    category: e.category,
    file_entry_id: e.file_entry_id,
    invoice_filename: e.invoice_filename,
    has_invoice: !!e.has_invoice,
    proof_filename: e.proof_filename,
    has_proof: !!e.has_proof,
    receipt_filename: e.receipt_filename,
    has_receipt: !!e.has_receipt,
  });

  return [...merged.values()]
    .map(g => ({
      reasons: g.reasons,
      severity: g.severity,
      // Sort entries earliest-first so the original (the one most likely to
      // be correct) sits at the top of the group.
      entries: g.entries
        .slice()
        .sort((a, b) => {
          const da = a.invoice_date ? new Date(a.invoice_date).getTime() : 0;
          const db = b.invoice_date ? new Date(b.invoice_date).getTime() : 0;
          return da - db;
        })
        .map(toUi),
      group_key: g.entries.map(e => e.id).sort((a, b) => a - b).join(','),
    }))
    .sort((a, b) => {
      const sa = order[a.severity] || 0;
      const sb = order[b.severity] || 0;
      if (sa !== sb) return sb - sa;
      return b.entries.length - a.entries.length;
    });
}

// Denominators (and true counts) for the completeness checks.
//
// The Flags overview draws a progress bar for each "missing X" check, and a bar
// needs a total. It also needs a count the LIMIT 500 on the item queries hasn't
// truncated — a capped count would quietly overstate how complete the catalogue
// is, which is the opposite of the point.
//
// One round trip, scalar subqueries, all indexed columns.
async function getCompletenessTotals() {
  const { rows: [t] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM releases r JOIN artists a ON a.id = r.artist_id
         WHERE (r.archived = false OR r.archived IS NULL))                              AS releases_active,
      (SELECT COUNT(*) FROM releases r JOIN artists a ON a.id = r.artist_id
         WHERE (r.archived = false OR r.archived IS NULL)
           AND r.release_date IS NOT NULL AND r.release_date <= CURRENT_DATE)           AS releases_out,
      (SELECT COUNT(*) FROM artists a WHERE a.total_releases > 0)                       AS artists_with_releases,

      (SELECT COUNT(*) FROM releases r JOIN artists a ON a.id = r.artist_id
         WHERE (r.archived = false OR r.archived IS NULL)
           AND (r.genre IS NULL OR TRIM(r.genre) = '' OR LOWER(TRIM(r.genre)) IN ${SENTINEL_VALUES}))  AS miss_rel_genre,
      (SELECT COUNT(*) FROM releases r JOIN artists a ON a.id = r.artist_id
         WHERE (r.archived = false OR r.archived IS NULL)
           AND r.release_date IS NOT NULL AND r.release_date <= CURRENT_DATE
           AND (r.upc IS NULL OR TRIM(r.upc) = '' OR LOWER(TRIM(r.upc)) IN ${SENTINEL_VALUES}))        AS miss_rel_upc,
      (SELECT COUNT(*) FROM releases r JOIN artists a ON a.id = r.artist_id
         WHERE (r.archived = false OR r.archived IS NULL)
           AND r.release_date IS NOT NULL AND r.release_date <= CURRENT_DATE
           AND (r.isrc IS NULL OR TRIM(r.isrc) = '' OR LOWER(TRIM(r.isrc)) IN ${SENTINEL_VALUES}))     AS miss_rel_isrc,
      (SELECT COUNT(*) FROM releases r JOIN artists a ON a.id = r.artist_id
         WHERE (r.archived = false OR r.archived IS NULL)
           AND r.release_date IS NOT NULL AND r.release_date <= CURRENT_DATE
           AND (r.spotify_uri IS NULL OR TRIM(r.spotify_uri) = '' OR LOWER(TRIM(r.spotify_uri)) IN ${SENTINEL_VALUES})) AS miss_rel_spotify,
      (SELECT COUNT(*) FROM artists a WHERE a.total_releases > 0
           AND (a.genre IS NULL OR TRIM(a.genre) = '' OR LOWER(TRIM(a.genre)) IN ${SENTINEL_VALUES}))  AS miss_art_genre,
      (SELECT COUNT(*) FROM artists a WHERE a.total_releases > 0
           AND NOT EXISTS (SELECT 1 FROM artist_links al WHERE al.artist_id = a.id
             AND LOWER(TRIM(al.platform)) = 'spotify' AND al.url IS NOT NULL AND TRIM(al.url) != '')) AS miss_art_spotify
  `).catch(() => ({ rows: [{}] }));
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    releases_missing_genre:   { of_total: n(t.releases_active),       missing_total: n(t.miss_rel_genre) },
    releases_missing_upc:     { of_total: n(t.releases_out),          missing_total: n(t.miss_rel_upc) },
    releases_missing_isrc:    { of_total: n(t.releases_out),          missing_total: n(t.miss_rel_isrc) },
    releases_missing_spotify: { of_total: n(t.releases_out),          missing_total: n(t.miss_rel_spotify) },
    artists_missing_genre:    { of_total: n(t.artists_with_releases), missing_total: n(t.miss_art_genre) },
    artists_missing_spotify:  { of_total: n(t.artists_with_releases), missing_total: n(t.miss_art_spotify) },
  };
}

async function getReleasesMissingGenre() {
  const { rows } = await pool.query(`
    SELECT r.id, r.project_name, r.release_date, r.release_type, a.name AS artist_name, a.id AS artist_id
    FROM releases r
    JOIN artists a ON a.id = r.artist_id
    WHERE (r.archived = false OR r.archived IS NULL)
      AND (r.genre IS NULL OR TRIM(r.genre) = '' OR LOWER(TRIM(r.genre)) IN ${SENTINEL_VALUES})
    ORDER BY r.release_date DESC NULLS LAST, r.id DESC
    LIMIT 500`);
  return rows;
}

async function getReleasesMissingIdentifier(col, label) {
  const { rows } = await pool.query(`
    SELECT r.id, r.project_name, r.release_date, a.name AS artist_name, a.id AS artist_id
    FROM releases r
    JOIN artists a ON a.id = r.artist_id
    WHERE (r.archived = false OR r.archived IS NULL)
      AND r.release_date IS NOT NULL AND r.release_date <= CURRENT_DATE
      AND (r.${col} IS NULL OR TRIM(r.${col}) = '' OR LOWER(TRIM(r.${col})) IN ${SENTINEL_VALUES})
    ORDER BY r.release_date DESC, r.id DESC
    LIMIT 500`);
  return rows.map(r => ({ ...r, missing: label }));
}

async function getReleasesMissingSpotify() {
  // Released titles past their release date with no Spotify URI on file —
  // either never went up, or the link was never recorded. Skips the in-flow
  // pipeline so the only-recently-added rows aren't flagged.
  const { rows } = await pool.query(`
    SELECT r.id, r.project_name, r.release_date, r.release_type,
           a.name AS artist_name, a.id AS artist_id
    FROM releases r
    JOIN artists a ON a.id = r.artist_id
    WHERE (r.archived = false OR r.archived IS NULL)
      AND r.release_date IS NOT NULL AND r.release_date <= CURRENT_DATE
      AND (r.spotify_uri IS NULL OR TRIM(r.spotify_uri) = '' OR LOWER(TRIM(r.spotify_uri)) IN ${SENTINEL_VALUES})
    ORDER BY r.release_date DESC, r.id DESC
    LIMIT 500`);
  return rows.map(r => ({ ...r, missing: 'Spotify link' }));
}

async function getArtistsMissingSpotify() {
  // Artists with at least one release on file but no 'spotify' artist_link.
  // Links to a Spotify artist page (not an individual release) — that's the
  // canonical "is this artist live on Spotify" check.
  const { rows } = await pool.query(`
    SELECT a.id, a.name, a.total_releases
    FROM artists a
    WHERE a.total_releases > 0
      AND NOT EXISTS (
        SELECT 1 FROM artist_links al
        WHERE al.artist_id = a.id
          AND LOWER(TRIM(al.platform)) = 'spotify'
          AND al.url IS NOT NULL AND TRIM(al.url) != ''
      )
    ORDER BY a.total_releases DESC, a.name ASC
    LIMIT 500`);
  return rows;
}

async function getArtistsMissingGenre() {
  const { rows } = await pool.query(`
    SELECT a.id, a.name, a.total_releases
    FROM artists a
    WHERE (a.genre IS NULL OR TRIM(a.genre) = '' OR LOWER(TRIM(a.genre)) IN ${SENTINEL_VALUES})
      AND a.total_releases > 0
    ORDER BY a.total_releases DESC, a.name ASC
    LIMIT 500`);
  return rows;
}

// ── Artist-column issue detectors ────────────────────────────────────────────
// These all share a single in-memory pass over the ledger. We pull a single
// flat list of entry rows + the roster + release-by-id index, then derive each
// category client-side (where "client-side" = inside this Node process).

const ARTIST_FLAG_KINDS = [
  'unknown',        // typed artist not in roster
  'likely_typo',    // typed artist is Levenshtein 1-2 from a roster name
  'variants',       // ledger uses multiple casings/spellings of same artist
  'multi_name',     // single field contains multiple artists (no split set up)
  'missing',        // artist-required category but empty artist
  'placeholder',    // artist field holds "n/a" / "N/A" / "unknown" — not a name
  'song_mismatch',  // expense linked to a release whose artist differs
  'missing_song',   // project-bound category but song field is blank
  'missing_socials',// promo-category row with no social_handles on file
];
// Categories where an empty artist is reasonable (overhead, salary, etc.) and
// not worth flagging. THE LIST IS DATA: `bk_categories.artist_required`,
// seeded once from these Boom names by lib/flags-register.ensureSchema and
// editable per label. Hard-coded here, a label whose categories are named
// differently had "missing artist" and "missing song" firing on ZERO rows.
// The literal survives only as the fallback for a database with no rows.
const DEFAULT_ARTIST_REQUIRED = new Set([
  'Marketing', 'PR', 'Radio', 'Recording', 'Music Video',
  'Production', 'Sync/Licensing', 'Mixing & Mastering',
  'Distribution', 'Design',
]);
async function artistRequiredSet() {
  try {
    const s = await require('../lib/flags-register').artistRequiredCategories();
    if (s && s.size) return s;
  } catch { /* fall through */ }
  return DEFAULT_ARTIST_REQUIRED;
}
// Where creator / influencer payments live and social handles are expected:
// the Campaigns page's own scope (one definition) plus PR.
function socialsCategories() {
  try { return [...new Set([...(require('./artist-campaigns').CAMPAIGN_CATEGORIES || []), 'PR'])]; }
  catch { return ['Marketing', 'Advertisements', 'PR']; }
}
// What a row-level dismissal is bound to. A dismissal made when the artist
// read "Unkown" must not survive the artist being changed to a different
// wrong name — so the dismissal remembers the value and the detectors compare.
const valueFp = (row) => require('../lib/flags-register').fp([String(row?.artist ?? ''), String(row?.song ?? '')]);
// Multi-name separator pattern. We treat ',' or '&' or '/' or ' and ' as
// indicators of multiple artists in one field. We DON'T treat ' x ' or ' feat '
// — those are common in song titles but shouldn't appear in the artist column.
const MULTI_NAME_SPLIT = /,|&|\/| and /i;

// Broader multi-artist pattern for the "Multi-Artist Ledger Rows" flag —
// includes features / collabs (feat, ft, with, x, ×) alongside the
// commas / ampersands that MULTI_NAME_SPLIT catches. The narrower
// MULTI_NAME_SPLIT stays as-is for the per-row split flow because
// splitting on "feat." would create bogus child rows for featured
// artists we don't want in the ledger. Requiring whitespace around
// 'x', 'and', 'with', etc. avoids false positives inside single names
// like "Alexander", "Foxes", "6ix9ine".
const MULTI_ARTIST_PATTERN = /,|\s+&\s+|\s+\/\s+|\s+and\s+|\s+with\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+x\s+|×/i;
const MULTI_ARTIST_SPLIT   = /,|\s+&\s+|\s+\/\s+|\s+and\s+|\s+with\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+x\s+|\s+×\s+/i;

// Aggregate expenses whose artist field looks multi-artist. One group
// per distinct lowercased-trimmed string. Parses out candidate sub-
// artists for the flag UI's radio picker; the typeahead falls back to
// the artists table when the operator wants a name that isn't in the
// parse. Split children are excluded so a $500 fee split 3 ways
// doesn't triple-count.
async function getMultiArtistGroups() {
  const { rows } = await pool.query(`
    SELECT
      LOWER(TRIM(e.artist)) AS source_key,
      MAX(e.artist)          AS source_display,
      COUNT(*)::int          AS row_count,
      SUM(COALESCE(e.amount, 0))::numeric AS total_amount
    FROM expenses e
    WHERE (e.deleted IS NULL OR e.deleted = FALSE)
      AND (e.voided  IS NULL OR e.voided  = FALSE)
      AND COALESCE(e.status, 'approved') = 'approved'
      AND e.parent_id IS NULL
      AND e.artist IS NOT NULL
      AND TRIM(e.artist) <> ''
      AND e.artist ~* '(,|\\s+&\\s+|\\s+/\\s+|\\s+and\\s+|\\s+with\\s+|\\s+feat\\.?\\s+|\\s+ft\\.?\\s+|\\s+x\\s+|×)'
    GROUP BY LOWER(TRIM(e.artist))
    ORDER BY COUNT(*) DESC, SUM(COALESCE(e.amount, 0)) DESC
  `).catch(err => { console.error('getMultiArtistGroups query:', err); return { rows: [] }; });

  return rows.map(r => {
    const display = r.source_display || '';
    const candidates = display
      .split(MULTI_ARTIST_SPLIT)
      .map(s => s.trim())
      .filter(Boolean);
    return {
      group_key: r.source_key,
      source_key: r.source_key,
      source_display: display,
      row_count: r.row_count,
      total_amount: Number(r.total_amount) || 0,
      candidates,
    };
  });
}

// Use the SAME normalization the rest of this file uses for duplicate-artist
// detection (NFKD + diacritic strip + non-alphanumeric strip). A simple
// lower+trim missed real matches because roster names sometimes carry hidden
// non-breaking spaces, trailing periods, or spacing variants ("DeLuca" vs
// "Deluca" vs "De Luca") that all read the same to a human.
const normArtistKey = (s) => normalizeArtistName(s);

async function getArtistFlags() {
  const ARTIST_REQUIRED_CATEGORIES = await artistRequiredSet();
  // 1. Pull every approved, undeleted expense. We deliberately exclude
  // status='pending' (vendor-submitted but not yet reviewed) and 'rejected'
  // — vendors routinely type junk into the artist field on submission and
  // admins fix it during approval. Surfacing those in Flags would double
  // up with the Approvals page and look like noise from the ledger view.
  const { rows: entries } = await pool.query(`
    SELECT e.id, e.invoice_date, e.payee, e.artist, e.song, e.category,
           e.amount, e.currency,
           e.release_id, e.parent_id, e.artist_breakdown,
           -- File-existence flags so each row on /flags can offer an
           -- invoice preview button without a second round-trip. Split
           -- children inherit their parent's file (file_entry_id =
           -- parent_id || id), mirroring the Lookup / Export pattern.
           COALESCE(e.parent_id, e.id) AS file_entry_id,
           e.entry_source,
           e.proof_filename, e.receipt_filename,
           ((e.proof_data IS NOT NULL AND e.proof_data != '')
             OR e.proof_r2_key IS NOT NULL) AS has_proof,
           (e.receipt_data IS NOT NULL AND e.receipt_data != '') AS has_receipt,
           e.invoice_filename,
           ((e.invoice_data IS NOT NULL AND e.invoice_data != '')
             OR e.invoice_r2_key IS NOT NULL
             OR EXISTS (
               SELECT 1 FROM expenses p
                WHERE p.id = e.parent_id
                  AND ((p.invoice_data IS NOT NULL AND p.invoice_data != '')
                       OR p.invoice_r2_key IS NOT NULL)
             )) AS has_invoice
      FROM expenses e
     WHERE e.status = 'approved'
       AND (e.deleted = false OR e.deleted IS NULL)
       AND (e.voided  = false OR e.voided  IS NULL)
  `);

  // 2. Roster snapshot, keyed by the robust normalized form so hidden
  // whitespace / punctuation / case variations all hash to the same bucket.
  const { rows: artists } = await pool.query(`SELECT id, name FROM artists`);
  const rosterByNorm = new Map();
  for (const a of artists) {
    const k = normArtistKey(a.name);
    if (k && !rosterByNorm.has(k)) rosterByNorm.set(k, a);
  }

  // 3. Release-artist index for song_mismatch.
  const { rows: releaseRows } = await pool.query(`
    SELECT r.id AS release_id, r.project_name, a.id AS artist_id, a.name AS artist_name
      FROM releases r
      LEFT JOIN artists a ON a.id = r.artist_id
  `);
  const releaseById = new Map(releaseRows.map(r => [r.release_id, r]));

  // 4. Dismissals so we don't surface what's already been waved off.
  // A dismissal made before value_fingerprint existed (NULL) still holds; one
  // made since holds only while the row's artist/song read what they read then.
  const { rows: dismissals } = await pool.query(`SELECT entry_id, flag_kind, value_fingerprint FROM flag_dismissals`);
  const dismissedMap = new Map(dismissals.map(d => [`${d.entry_id}|${d.flag_kind}`, d.value_fingerprint]));
  const entryById = new Map(entries.map(e => [e.id, e]));
  const isDismissed = (id, kind) => {
    const k = `${id}|${kind}`;
    if (!dismissedMap.has(k)) return false;
    const vf = dismissedMap.get(k);
    return !vf || vf === valueFp(entryById.get(id));
  };

  // ── Detectors ──────────────────────────────────────────────────────────────
  const unknown      = [];
  const likely_typo  = [];
  const multi_name   = [];
  const missing      = [];
  const placeholder  = [];
  const song_mismatch = [];

  for (const e of entries) {
    const raw   = String(e.artist || '');
    const trimmed = raw.trim();
    const normKey = normArtistKey(trimmed);
    const inRoster = !!(normKey && rosterByNorm.has(normKey));
    const hasBreakdown = Array.isArray(e.artist_breakdown) && e.artist_breakdown.length > 1;

    // 0. A PLACEHOLDER IS NOT A NAME, and this has to be decided before any
    // other detector sees the row — every one of them assumes the text in the
    // artist field is somebody's name, and acts on that assumption:
    //
    //   likely_typo  offered "n/a" as a 2-edit typo of the artist K3, and its
    //                one-click fix would have attributed a salary payment to K3
    //   multi_name   read "N/A" as two artists and offered to SPLIT the row
    //                into children named "N" and "A"
    //   variants     proposed "n/a" as the canonical spelling to normalise
    //                "NA" and "N/A" onto
    //   unknown      listed "unknown" as an artist missing from the roster
    //
    // 16 live rows were in those four buckets. The remedy each offered was
    // worse than the flag.
    //
    // Kept as its own kind rather than folded into 'missing': that one only
    // fires on ARTIST_REQUIRED_CATEGORIES, and 22 of these 24 are Salary, Rent,
    // Studio House and Legal — categories where having no artist is the RIGHT
    // answer. Folding them in would hide 22 rows while leaving the junk text in
    // the field, still printed as an artist on the ledger and the vendor pages.
    // So the answer here is two-sided: name the artist, or clear the field.
    if (trimmed && !namesAnArtist(trimmed) && !e.parent_id) {
      if (!isDismissed(e.id, 'placeholder')) placeholder.push({ ...e, suggestion: null });
      continue;
    }

    // 5. Missing artist on artist-required category.
    if (!trimmed && ARTIST_REQUIRED_CATEGORIES.has(e.category) && !e.parent_id) {
      if (!isDismissed(e.id, 'missing')) {
        missing.push({ ...e, suggestion: null });
      }
      continue; // can't run other artist-text detectors on an empty field
    }
    if (!trimmed) continue;

    // 4. Multi-name in one field.
    if (!hasBreakdown && MULTI_NAME_SPLIT.test(trimmed)) {
      if (!isDismissed(e.id, 'multi_name')) {
        const parts = trimmed.split(MULTI_NAME_SPLIT).map(p => p.trim()).filter(Boolean);
        multi_name.push({ ...e, suggestion: parts });
      }
      // Don't also flag as unknown/typo — multi-name supersedes.
      continue;
    }

    // 6. Song ↔ release artist mismatch (only when row points at a real release).
    if (e.release_id) {
      const rel = releaseById.get(e.release_id);
      if (rel?.artist_name && normArtistKey(rel.artist_name) !== normKey) {
        if (!isDismissed(e.id, 'song_mismatch')) {
          song_mismatch.push({ ...e, suggestion: { artist_id: rel.artist_id, artist_name: rel.artist_name, project_name: rel.project_name } });
        }
        continue;
      }
    }

    if (!inRoster) {
      // 2. Likely typo — Levenshtein 1-2 against a roster name. Comparison
      // runs on the normalized form so spacing/punctuation noise doesn't
      // bump the edit distance.
      let best = null;
      for (const [rosterKey, a] of rosterByNorm) {
        if (Math.abs(rosterKey.length - normKey.length) > 2) continue;
        const d = levDist(normKey, rosterKey);
        if (d > 0 && d <= 2 && (!best || d < best.dist)) {
          best = { dist: d, artist: a };
          if (d === 1) break;
        }
      }
      if (best) {
        if (!isDismissed(e.id, 'likely_typo')) {
          likely_typo.push({ ...e, suggestion: { artist_id: best.artist.id, artist_name: best.artist.name } });
        }
      } else {
        // 1. Unknown artist — any ledger row whose artist string doesn't
        // match a roster name (and isn't close enough to be a typo) gets
        // flagged. Was previously gated to artist-required categories to
        // reduce noise; broadened per user request — every off-roster
        // artist should surface here regardless of category so the user
        // catches typos in 'Legal' / 'Services' / etc. expenses too.
        if (!isDismissed(e.id, 'unknown')) {
          unknown.push({ ...e, suggestion: null });
        }
      }
    }
  }

  // 3. Casing/spelling variants — group entries by their robust-normalized
  // artist string. A "variant" issue requires 2+ distinct raw spellings that
  // normalize identically. Keying by normArtistKey catches DeLuca vs Deluca
  // vs De Luca vs Deluca  as the same group.
  const variantsByNorm = new Map();
  for (const e of entries) {
    const raw = String(e.artist || '').trim();
    if (!raw) continue;
    // Separate pass, so it needs the placeholder guard of its own. Without it
    // "n/a", "N/A" and "NA" normalise to one key and become a 3-spelling
    // "artist" whose canonical form is proposed as a real name.
    if (!namesAnArtist(raw)) continue;
    const nk = normArtistKey(raw);
    if (!nk) continue;
    if (!variantsByNorm.has(nk)) variantsByNorm.set(nk, new Set());
    variantsByNorm.get(nk).add(raw);
  }
  const variants = [];
  for (const [nk, set] of variantsByNorm) {
    if (set.size < 2) continue;
    const spellings = Array.from(set);
    // Canonical = roster-matching spelling > most-frequent > first alpha.
    let canonical = spellings.find(s => rosterByNorm.has(normArtistKey(s)));
    if (!canonical) {
      const counts = new Map();
      for (const e of entries) {
        const r = String(e.artist || '').trim();
        if (!r) continue;
        if (normArtistKey(r) !== nk) continue;
        counts.set(r, (counts.get(r) || 0) + 1);
      }
      canonical = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || spellings[0];
    }
    for (const s of spellings) {
      if (s === canonical) continue;
      const rep = entries.find(e => String(e.artist || '').trim() === s);
      if (!rep) continue;
      if (isDismissed(rep.id, 'variants')) continue;
      const occurrenceCount = entries.filter(e => String(e.artist || '').trim() === s).length;
      variants.push({
        ...rep,
        suggestion: { artist_name: canonical },
        occurrence_count: occurrenceCount,
      });
    }
  }

  return { unknown, likely_typo, variants, multi_name, missing, placeholder, song_mismatch };
}

// Ledger rows in project-bound categories with no song attached. Splits are
// handled deliberately: a parent row with empty song is OK if its children
// carry a song, because the parent is just the split container.
async function getMissingSongFlags() {
  const cats = Array.from(await artistRequiredSet());
  const placeholders = cats.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(`
    SELECT e.id, e.invoice_date, e.payee, e.artist, e.song, e.category,
           e.release_id, e.parent_id, e.artist_breakdown, e.entry_source,
           e.entry_source,
           e.proof_filename, e.receipt_filename,
           ((e.proof_data IS NOT NULL AND e.proof_data != '')
             OR e.proof_r2_key IS NOT NULL) AS has_proof,
           (e.receipt_data IS NOT NULL AND e.receipt_data != '') AS has_receipt,
           e.invoice_filename,
           ((e.invoice_data IS NOT NULL AND e.invoice_data != '')
             OR e.invoice_r2_key IS NOT NULL
             OR EXISTS (
               SELECT 1 FROM expenses p
                WHERE p.id = e.parent_id
                  AND ((p.invoice_data IS NOT NULL AND p.invoice_data != '')
                       OR p.invoice_r2_key IS NOT NULL)
             )) AS has_invoice,
           e.invoice_number
      FROM expenses e
     WHERE e.status = 'approved'
       AND (e.deleted = false OR e.deleted IS NULL)
       AND (e.voided  = false OR e.voided  IS NULL)
       AND (e.song IS NULL OR TRIM(e.song) = '')
       AND e.category IN (${placeholders})
       AND (e.is_reimbursement = false OR e.is_reimbursement IS NULL)
       AND NOT EXISTS (
         SELECT 1 FROM expenses c
          WHERE c.parent_id = e.id
            AND (c.deleted = false OR c.deleted IS NULL)
            AND c.song IS NOT NULL AND TRIM(c.song) != ''
       )
     ORDER BY e.invoice_date DESC
  `, cats);
  const { rows: dismissals } = await pool.query(
    `SELECT entry_id, value_fingerprint FROM flag_dismissals WHERE flag_kind = 'missing_song'`
  );
  const dismissed = new Map(dismissals.map(d => [d.entry_id, d.value_fingerprint]));
  return rows.filter(r => !dismissed.has(r.id) || (dismissed.get(r.id) && dismissed.get(r.id) !== valueFp(r)));
}

// Ledger rows that should plausibly carry social handles but don't. Scoped to
// the categories where creator / influencer payments live (Marketing, PR) or
// any cobrand row, since those are the places the vendor-submit form is set
// up to collect IG / TikTok / X handles. Other categories (Recording,
// Distribution, Legal, …) genuinely don't need socials, so we exclude them up
// front instead of dumping the entire ledger and asking the user to dismiss
// each row individually. The dismiss feature still handles in-scope false
// positives (e.g. a PR firm with no social presence).
async function getMissingSocialsFlags() {
  // jsonb_array_length only works on arrays; a row whose social_handles got
  // stored as a JSON null or {} would throw. Guard with jsonb_typeof first.
  const { rows } = await pool.query(`
    SELECT e.id, e.invoice_date, e.payee, e.artist, e.song, e.category,
           e.amount, e.currency, e.cobrand,
           COALESCE(e.parent_id, e.id) AS file_entry_id,
           e.entry_source,
           e.proof_filename, e.receipt_filename,
           ((e.proof_data IS NOT NULL AND e.proof_data != '')
             OR e.proof_r2_key IS NOT NULL) AS has_proof,
           (e.receipt_data IS NOT NULL AND e.receipt_data != '') AS has_receipt,
           e.invoice_filename,
           ((e.invoice_data IS NOT NULL AND e.invoice_data != '')
             OR e.invoice_r2_key IS NOT NULL
             OR EXISTS (
               SELECT 1 FROM expenses p
                WHERE p.id = e.parent_id
                  AND ((p.invoice_data IS NOT NULL AND p.invoice_data != '')
                       OR p.invoice_r2_key IS NOT NULL)
             )) AS has_invoice
      FROM expenses e
     WHERE e.status = 'approved'
       AND (e.deleted = false OR e.deleted IS NULL)
       AND (e.voided  = false OR e.voided  IS NULL)
       AND (e.is_reimbursement = false OR e.is_reimbursement IS NULL)
       AND e.parent_id IS NULL
       AND (
         e.social_handles IS NULL
         OR jsonb_typeof(e.social_handles) <> 'array'
         OR jsonb_array_length(e.social_handles) = 0
       )
       AND (e.category = ANY($1) OR e.cobrand = TRUE)
     ORDER BY e.invoice_date DESC NULLS LAST, e.id DESC
  `, [socialsCategories()]);
  const { rows: dismissals } = await pool.query(
    `SELECT entry_id, value_fingerprint FROM flag_dismissals WHERE flag_kind = 'missing_socials'`
  );
  const dismissed = new Map(dismissals.map(d => [d.entry_id, d.value_fingerprint]));
  return rows.filter(r => !dismissed.has(r.id) || (dismissed.get(r.id) && dismissed.get(r.id) !== valueFp(r)));
}

// Human-raised review flags — the flag button on a ledger row, and the F key
// in a bank review deck. Functions rather than inline queries so the register
// sweep can run them too. LIMIT 300 attached; `total` is the uncapped count.
async function getFlaggedExpenses() {
  const [{ rows }, { rows: [{ n }] }] = await Promise.all([
    pool.query(`
      SELECT e.id, e.payee, e.amount, COALESCE(e.currency, 'USD') AS currency,
             e.invoice_date, e.invoice_number, e.artist, e.category,
             e.payment_status, e.flag_reason, e.flagged_at, e.entry_source,
             COALESCE(e.parent_id, e.id) AS file_entry_id,
             e.proof_filename, e.receipt_filename,
             ((e.proof_data IS NOT NULL AND e.proof_data != '')
               OR e.proof_r2_key IS NOT NULL) AS has_proof,
             (e.receipt_data IS NOT NULL AND e.receipt_data != '') AS has_receipt,
             u.name AS flagged_by_name,
             e.invoice_filename,
             ((e.invoice_data IS NOT NULL AND e.invoice_data != '')
               OR e.invoice_r2_key IS NOT NULL
               OR EXISTS (
                 SELECT 1 FROM expenses p
                  WHERE p.id = e.parent_id
                    AND ((p.invoice_data IS NOT NULL AND p.invoice_data != '')
                         OR p.invoice_r2_key IS NOT NULL)
               )) AS has_invoice
        FROM expenses e
        LEFT JOIN users u ON u.id = e.flagged_by
       WHERE e.flagged = true
         AND (e.deleted = false OR e.deleted IS NULL)
         AND (e.voided = false OR e.voided IS NULL)
       ORDER BY e.flagged_at DESC NULLS LAST, e.id DESC
       LIMIT 300`),
    pool.query(`SELECT COUNT(*)::int AS n FROM expenses e WHERE e.flagged = true AND (e.deleted = false OR e.deleted IS NULL) AND (e.voided = false OR e.voided IS NULL)`),
  ]);
  rows.total = n;
  return rows;
}
async function getFlaggedTransactions() {
  // Deck markers live on bank_transactions.flagged — a different column from
  // expenses.flagged, set by the review deck's F key. Dismissed rows are
  // excluded: a dismissed transaction is a closed decision.
  const [{ rows }, { rows: [{ n }] }] = await Promise.all([
    pool.query(`
      SELECT t.id, t.txn_date, t.amount, COALESCE(t.currency, 'USD') AS currency,
             t.description, t.payee_guess, t.direction, t.flagged_by,
             t.statement_id, s.account, s.filename,
             (t.matched_expense_id IS NOT NULL OR t.matched_income_id IS NOT NULL) AS is_booked
        FROM bank_transactions t
        JOIN bank_statements s ON s.id = t.statement_id AND s.status = 'ready'
       WHERE t.flagged = true AND t.dismissed = false
       ORDER BY t.txn_date DESC NULLS LAST, t.id DESC
       LIMIT 300`),
    pool.query(`SELECT COUNT(*)::int AS n FROM bank_transactions t JOIN bank_statements s ON s.id = t.statement_id AND s.status = 'ready' WHERE t.flagged = true AND t.dismissed = false`),
  ]);
  rows.total = n;
  return rows;
}

// GET /api/flags/artist-issues — returns counted buckets per kind, optionally
// including dismissed entries when ?include_dismissed=1 is passed (used by the
// "Show dismissed" view).
router.get('/artist-issues', authMiddleware, async (req, res) => {
  try {
    const buckets = await getArtistFlags();
    // If client asked for dismissed too, fetch and append a separate list.
    let dismissed = [];
    if (req.query.include_dismissed === '1') {
      const { rows } = await pool.query(`
        SELECT fd.entry_id, fd.flag_kind, fd.dismissed_at, u.name AS dismissed_by_name,
               e.id, e.invoice_date, e.payee, e.artist, e.song, e.category
          FROM flag_dismissals fd
          LEFT JOIN users u ON u.id = fd.dismissed_by
          JOIN expenses e ON e.id = fd.entry_id
         WHERE e.deleted = false OR e.deleted IS NULL
         ORDER BY fd.dismissed_at DESC
      `);
      dismissed = rows;
    }
    res.json({ success: true, data: { buckets, dismissed } });
  } catch (err) {
    console.error('GET /api/flags/artist-issues:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/flags/artist-issues/dismiss — { entry_id, flag_kind }
router.post('/artist-issues/dismiss', authMiddleware, async (req, res) => {
  try {
    const { entry_id, flag_kind } = req.body || {};
    if (!entry_id || !ARTIST_FLAG_KINDS.includes(flag_kind)) {
      return res.status(400).json({ success: false, error: 'entry_id and a valid flag_kind required' });
    }
    // Remember WHAT was waved off: the row's artist and song as they read now.
    // The detectors ignore this dismissal once either changes.
    const { rows: [row] } = await pool.query(`SELECT artist, song FROM expenses WHERE id = $1`, [entry_id]);
    await pool.query(
      `INSERT INTO flag_dismissals (entry_id, flag_kind, dismissed_by, value_fingerprint)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (entry_id, flag_kind) DO UPDATE SET dismissed_at = NOW(), dismissed_by = EXCLUDED.dismissed_by, value_fingerprint = EXCLUDED.value_fingerprint`,
      [entry_id, flag_kind, req.user?.id || null, row ? valueFp(row) : null]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/flags/artist-issues/dismiss:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/flags/group/dismiss — { kind, group_key } | { kind, group_key, value: false }
// Toggle a group-level dismissal for the three duplicate-flag categories
// (duplicate_releases / duplicate_artists / duplicate_vendors). Value
// defaults to true (dismiss); pass value:false to restore — saves having
// to expose a separate /restore endpoint.
const GROUP_DISMISS_KINDS = new Set(['duplicate_releases', 'duplicate_artists', 'duplicate_vendors', 'duplicate_invoices']);
router.post('/group/dismiss', authMiddleware, async (req, res) => {
  try {
    const { kind, group_key, value } = req.body || {};
    if (!GROUP_DISMISS_KINDS.has(kind)) {
      return res.status(400).json({ success: false, error: 'unknown group kind' });
    }
    if (typeof group_key !== 'string' || !group_key.length) {
      return res.status(400).json({ success: false, error: 'group_key required' });
    }
    if (value === false) {
      await pool.query(
        `DELETE FROM flag_group_dismissals WHERE flag_kind = $1 AND group_key = $2`,
        [kind, group_key]
      );
    } else {
      await pool.query(
        `INSERT INTO flag_group_dismissals (flag_kind, group_key, dismissed_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (flag_kind, group_key)
         DO UPDATE SET dismissed_at = NOW(), dismissed_by = EXCLUDED.dismissed_by`,
        [kind, group_key, req.user?.id || null]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/flags/group/dismiss:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/flags/artist-issues/restore — { entry_id, flag_kind }
router.post('/artist-issues/restore', authMiddleware, async (req, res) => {
  try {
    const { entry_id, flag_kind } = req.body || {};
    if (!entry_id || !flag_kind) {
      return res.status(400).json({ success: false, error: 'entry_id and flag_kind required' });
    }
    await pool.query(
      `DELETE FROM flag_dismissals WHERE entry_id = $1 AND flag_kind = $2`,
      [entry_id, flag_kind]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/flags/artist-issues/restore:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/flags — aggregated data-quality flags
router.get('/', authMiddleware, async (req, res) => {
  try {
    const [
      duplicateReleases, duplicateArtists,
      releasesMissingGenre, artistsMissingGenre,
      releasesMissingUpc, releasesMissingIsrc,
      releasesMissingSpotify, artistsMissingSpotify,
      artistFlags, missingSong, missingSocials, duplicateVendors,
      duplicateInvoices,
    ] = await Promise.all([
      getDuplicateReleases(),
      getDuplicateArtists(),
      getReleasesMissingGenre(),
      getArtistsMissingGenre(),
      getReleasesMissingIdentifier('upc', 'UPC'),
      getReleasesMissingIdentifier('isrc', 'ISRC'),
      getReleasesMissingSpotify(),
      getArtistsMissingSpotify(),
      getArtistFlags(),
      getMissingSongFlags(),
      getMissingSocialsFlags(),
      getDuplicateVendors(),
      getDuplicateInvoices(),
    ]);

    // Multi-artist normalization groups. Broader pattern than
    // MULTI_NAME_SPLIT — includes 'feat.', 'ft.', 'with', ' x ', '×'
    // etc. so features + collabs on the artist string get surfaced.
    // Grouped by the exact lowercased-trimmed string so operators
    // pick one base per distinct spelling.
    const multiArtistGroups = await getMultiArtistGroups();

    // Pull every group-level dismissal up-front so we can both filter
    // groups out by default AND annotate them on the include-dismissed
    // path. Keyed by flag_kind|group_key for O(1) lookup.
    const { rows: groupDismissals } = await pool.query(
      `SELECT flag_kind, group_key, dismissed_at,
              (SELECT name FROM users WHERE id = dismissed_by) AS dismissed_by_name
         FROM flag_group_dismissals`
    );
    const groupDismissedByKey = new Map(
      groupDismissals.map(d => [`${d.flag_kind}|${d.group_key}`, d])
    );
    const includeDismissed = req.query.include_dismissed === '1';
    const partitionGroups = (kind, groups, keyOf) => {
      const tagged = groups.map(g => {
        const gk = keyOf(g);
        const hit = groupDismissedByKey.get(`${kind}|${gk}`);
        return {
          ...g,
          group_key: gk,
          dismissed: !!hit,
          ...(hit ? {
            dismissed_at: hit.dismissed_at,
            dismissed_by_name: hit.dismissed_by_name,
          } : {}),
        };
      });
      return includeDismissed ? tagged : tagged.filter(g => !g.dismissed);
    };

    // Annotated, optionally-filtered groups. Releases already arrive as
    // objects with a group_key; artists and vendors are wrapped here so
    // the per-group dismiss tagging can hang off a stable property name
    // ({ group_key, artists } and { group_key, vendors }) instead of a
    // bare array that can't carry siblings.
    const taggedReleases = partitionGroups('duplicate_releases', duplicateReleases, g => g.group_key);
    const taggedArtists = partitionGroups(
      'duplicate_artists',
      duplicateArtists.map(g => ({ artists: g })),
      g => groupKeyForArtists(g.artists)
    );
    const taggedVendors = partitionGroups(
      'duplicate_vendors',
      duplicateVendors.map(g => ({ vendors: g })),
      g => groupKeyForVendors(g.vendors)
    );
    // Invoice groups already arrive with a stable group_key (sorted entry-id
    // signature), so partitionGroups can use it directly.
    const taggedInvoices = partitionGroups(
      'duplicate_invoices',
      duplicateInvoices,
      g => g.group_key
    );

    const categories = [
      {
        kind: 'duplicate_releases',
        label: 'Potential Duplicate Releases',
        description: 'Releases that share an artist+name, UPC, ISRC, or Spotify URI.',
        severity: 'high',
        groups: taggedReleases,
        count: taggedReleases.length,
      },
      {
        kind: 'duplicate_artists',
        label: 'Potential Duplicate Artists',
        description: 'Artist records whose names are identical or near-identical after normalization.',
        severity: 'high',
        groups: taggedArtists,
        count: taggedArtists.length,
      },
      {
        kind: 'artist_multi_normalize',
        label: 'Multi-Artist Ledger Rows',
        description: 'Ledger rows whose artist field lists multiple artists (features / collabs). Pick one signed base artist per group — we\'ll rename existing rows to that base and remember the mapping so future entries auto-collapse.',
        severity: 'medium',
        groups: multiArtistGroups,
        count: multiArtistGroups.length,
      },
      {
        kind: 'duplicate_vendors',
        label: 'Potential Duplicate Vendors',
        description: 'Vendor / payee names that look like the same vendor under two spellings — identical after normalization, or a Levenshtein edit away. Pairs already linked via vendor aliases are excluded.',
        severity: 'high',
        groups: taggedVendors,
        count: taggedVendors.length,
      },
      {
        kind: 'duplicate_invoices',
        label: 'Potential Duplicate Invoices',
        description: 'Ledger rows that look like the same invoice was booked twice. Compares vendor (including aliased vendors), normalized invoice number, amount, currency, and date. Children of split invoices are excluded — they share the parent\'s invoice number by design.',
        severity: 'high',
        groups: taggedInvoices,
        count: taggedInvoices.length,
      },
      {
        kind: 'releases_missing_genre',
        label: 'Releases Missing Genre',
        description: 'Active releases with no genre on file.',
        severity: 'medium',
        items: releasesMissingGenre,
        count: releasesMissingGenre.length,
      },
      {
        kind: 'artists_missing_genre',
        label: 'Artists Missing Genre',
        description: 'Artists who have releases on file but no genre.',
        severity: 'medium',
        items: artistsMissingGenre,
        count: artistsMissingGenre.length,
      },
      {
        kind: 'releases_missing_upc',
        label: 'Released — Missing UPC',
        description: 'Releases past their release date without a UPC.',
        severity: 'medium',
        items: releasesMissingUpc,
        count: releasesMissingUpc.length,
      },
      {
        kind: 'releases_missing_isrc',
        label: 'Released — Missing ISRC',
        description: 'Releases past their release date without an ISRC.',
        severity: 'low',
        items: releasesMissingIsrc,
        count: releasesMissingIsrc.length,
      },
      {
        kind: 'releases_missing_spotify',
        label: 'Released — Missing Spotify Link',
        description: 'Releases past their release date with no Spotify URI on file — likely never went live or the link was never recorded.',
        severity: 'medium',
        items: releasesMissingSpotify,
        count: releasesMissingSpotify.length,
      },
      {
        kind: 'artists_missing_spotify',
        label: 'Artists Missing Spotify Link',
        description: 'Artists who have releases on file but no Spotify artist link recorded.',
        severity: 'medium',
        items: artistsMissingSpotify,
        count: artistsMissingSpotify.length,
      },
      // ── Ledger artist-column issues — surfaced as discrete categories per
      // kind so the existing tab/severity UX works without changes.
      {
        kind: 'artist_likely_typo',
        label: 'Ledger — Likely Artist Typo',
        description: 'Ledger rows whose artist is a 1–2 character edit away from a roster name. One-click fix swaps to the suggested artist.',
        severity: 'high',
        items: artistFlags.likely_typo,
        count: artistFlags.likely_typo.length,
      },
      {
        kind: 'artist_song_mismatch',
        label: 'Ledger — Artist ↔ Song Mismatch',
        description: 'Ledger rows linked to a release whose artist does not match the row\'s artist.',
        severity: 'high',
        items: artistFlags.song_mismatch,
        count: artistFlags.song_mismatch.length,
      },
      {
        kind: 'artist_unknown',
        label: 'Ledger — Unknown Artist',
        description: 'Ledger rows whose artist does not match any name in the roster (filtered to artist-relevant categories).',
        severity: 'medium',
        items: artistFlags.unknown,
        count: artistFlags.unknown.length,
      },
      {
        kind: 'artist_multi_name',
        label: 'Ledger — Multiple Artists in One Field',
        description: 'Single-field artist values containing commas, slashes, or "&" — likely should be a split.',
        severity: 'medium',
        items: artistFlags.multi_name,
        count: artistFlags.multi_name.length,
      },
      {
        kind: 'artist_missing',
        label: 'Ledger — Missing Artist',
        description: 'Artist-required category (Marketing, PR, Recording, etc.) with an empty artist field.',
        severity: 'medium',
        items: artistFlags.missing,
        count: artistFlags.missing.length,
      },
      {
        kind: 'artist_placeholder',
        label: 'Ledger — Placeholder Artist',
        description: 'The artist field holds a placeholder ("n/a", "N/A", "unknown") rather than a name. Reports count these as unattributed while the ledger prints them as though they were an artist. Name the artist, or clear the field.',
        severity: 'medium',
        items: artistFlags.placeholder,
        count: artistFlags.placeholder.length,
      },
      {
        kind: 'artist_variants',
        label: 'Ledger — Spelling / Casing Variants',
        description: 'The ledger uses multiple spellings of the same artist (e.g. "zeke bleu" and "Zeke Bleu"). Canonicalize so reports group correctly.',
        severity: 'low',
        items: artistFlags.variants,
        count: artistFlags.variants.length,
      },
      {
        kind: 'ledger_missing_song',
        label: 'Ledger — Missing Song',
        description: 'Project-bound ledger rows (Marketing, PR, Recording, etc.) with no song attached. Split parents are skipped when any child carries a song.',
        severity: 'medium',
        items: missingSong,
        count: missingSong.length,
      },
      {
        kind: 'ledger_missing_socials',
        label: 'Ledger — Missing Socials',
        description: 'Marketing / PR / cobrand rows with no social handles on file. Not every invoice in these categories needs socials — use the × dismiss button on rows that aren\'t creator-related.',
        severity: 'low',
        items: missingSocials,
        count: missingSocials.length,
      },
    ];

    // ── Bookkeeping-side flags ────────────────────────────────────────────
    // Human-raised review flags had no aggregate view anywhere: someone hits
    // the flag button on a ledger row or a review-deck card, and the only way
    // to find it again was to scroll back to the row. These two categories
    // are that missing inbox.
    //
    // Role-gated per section, not per page: the hub itself is
    // permission-gated (so a User who has the Flags page keeps the catalog
    // categories they always had), but money-shaped flags are limited to the
    // bookkeeping roles. Mirrors isBkAdmin in routes/bookkeeping.js.
    // Two tiers, because bank rows are not ledger rows. Approvers do full
    // bookkeeping review but deliberately don't see bank data (same split as
    // BkStatements, which gates on Admin/Superadmin) — so they get the ledger
    // flag inbox and not the transaction one.
    const role = req.user?.role;
    const isBkRole = role === 'Admin' || role === 'Superadmin' || role === 'Approver';
    const isBankRole = role === 'Admin' || role === 'Superadmin';
    if (isBkRole) {
      const [flaggedExpenses, flaggedTxns] = await Promise.all([
        getFlaggedExpenses(),
        isBankRole ? getFlaggedTransactions() : Promise.resolve(Object.assign([], { total: 0 })),
      ]);

      categories.push({
        kind: 'flagged_expenses',
        label: 'Ledger — Flagged for Review',
        description: 'Ledger rows someone flagged with the flag button, with whatever reason they left. Clearing a flag is the same toggle on the row itself.',
        severity: 'medium',
        items: flaggedExpenses,
        count: flaggedExpenses.total ?? flaggedExpenses.length,
      });
      if (isBankRole) {
        categories.push({
          kind: 'flagged_transactions',
          label: 'Statements — Flagged in Review',
          description: 'Bank transactions marked with F during a review deck run. Flagging is a marker, not a decision — these are still open and will come back around in the next deck run.',
          severity: 'medium',
          items: flaggedTxns,
          count: flaggedTxns.total ?? flaggedTxns.length,
        });
      }
    }

    // Attach denominators to the completeness checks so the overview can draw
    // an honest progress bar, and use the UNCAPPED count for them — the item
    // queries LIMIT 500, so a large gap would otherwise report as exactly 500
    // and read as more complete than it is.
    const totals = await getCompletenessTotals().catch(() => ({}));
    for (const cat of categories) {
      const t = totals[cat.kind];
      if (!t) continue;
      if (t.of_total != null) cat.of_total = t.of_total;
      if (t.missing_total != null) cat.count = t.missing_total;
    }
    // A capped list must SAY it is capped. The header used to read "1,240"
    // over a body of 500 rows with nothing in between admitting the gap.
    for (const cat of categories) {
      const shown = (cat.items || cat.groups || []).length;
      if (cat.count > shown) { cat.truncated = true; cat.shown = shown; }
    }

    // ── The register: new / age / owner on these categories, plus the
    // workflow, compliance and setup categories that live only there. ──
    const register = require('../lib/flags-register');
    const { rows: [seenRow] } = await pool.query(`SELECT flags_seen_at FROM users WHERE id = $1`, [req.user.id]).catch(() => ({ rows: [{}] }));
    const viewer = { ...req.user, flags_seen_at: seenRow?.flags_seen_at || null };
    let meta = { seen_at: viewer.flags_seen_at, swept_at: null, sweep_errors: {}, sweep_counts: {} };
    try {
      await register.annotate(categories, viewer);
      const regCats = await register.categoriesFor(viewer, { includeDismissed });
      categories.push(...regCats);
      const last = await register.lastSweep();
      if (last) meta = { ...meta, swept_at: last.ran_at, sweep_errors: last.errors || {}, sweep_counts: last.counts || {}, sweep_trigger: last.trigger };
      meta.new_total = categories.reduce((n, c) => n + (c.tracking?.new || 0), 0);
      meta.detectors = register.DETECTORS.map((d) => ({ kind: d.kind, label: d.label, group: d.group, page: d.page }));
    } catch (e) {
      // The register failing must not take the data-quality hub down.
      console.error('GET /api/flags register:', e.message);
      meta.register_error = e.message;
    }

    res.json({ success: true, data: categories, meta });
  } catch (err) {
    console.error('GET /api/flags:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── The register's own endpoints (lib/flags-register) ────────────────────────

// GET /api/flags/summary — the Home tile / My Work row figures for this viewer.
router.get('/summary', authMiddleware, async (req, res) => {
  try {
    const register = require('../lib/flags-register');
    const { rows: [u] } = await pool.query(`SELECT flags_seen_at FROM users WHERE id = $1`, [req.user.id]).catch(() => ({ rows: [{}] }));
    res.json({ success: true, data: await register.summaryFor({ ...req.user, flags_seen_at: u?.flags_seen_at || null }) });
  } catch (err) { console.error('GET /api/flags/summary:', err); res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/flags/seen — "I have looked": what is new resets from now.
router.post('/seen', authMiddleware, async (req, res) => {
  try { await require('../lib/flags-register').markSeen(req.user.id); res.json({ success: true, seen_at: new Date().toISOString() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/flags/sweep — run the sweep now (Admin/Superadmin; the page's ⟳).
router.post('/sweep', authMiddleware, async (req, res) => {
  try {
    if (!['Admin', 'Superadmin'].includes(req.user?.role)) return res.status(403).json({ success: false, error: 'Admin required' });
    const out = await require('../lib/flags-register').sweep({ trigger: `manual:${req.user.id}` });
    res.json({ success: true, data: out });
  } catch (err) { console.error('POST /api/flags/sweep:', err); res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/flags/register/dismiss — { kind, key, until?: 'YYYY-MM-DD', undo?: bool }
// `until` snoozes; without it the flag is dismissed. Either binds to the
// flagged VALUE: a changed row comes back on the next sweep.
router.post('/register/dismiss', authMiddleware, async (req, res) => {
  try {
    const { kind, key, until, undo } = req.body || {};
    if (!kind || key == null) return res.status(400).json({ success: false, error: 'kind and key required' });
    const register = require('../lib/flags-register');
    if (!(await register.visibleKinds(req.user)).has(kind)) return res.status(403).json({ success: false, error: 'Not a flag you can act on' });
    let untilTs = null;
    if (until) { const d = new Date(until); if (Number.isNaN(d.getTime())) return res.status(400).json({ success: false, error: 'until must be a date' }); untilTs = d.toISOString(); }
    const ok = await register.dismiss({ kind, key: String(key), userId: req.user.id, until: untilTs, undo: !!undo });
    if (!ok) return res.status(404).json({ success: false, error: 'No such flag' });
    res.json({ success: true });
  } catch (err) { console.error('POST /api/flags/register/dismiss:', err); res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/flags/assign — { kind, key?: '*', user_id, due_date?, title?, to?, severity? }
// Makes ONE task in the assignee's My Work, linked back to the flag. key '*'
// (or omitted) owns the whole category — the shape for the data-quality
// categories, whose rows are worked through in bulk.
router.post('/assign', authMiddleware, async (req, res) => {
  try {
    const { kind, key = '*', user_id, due_date, title, to, severity } = req.body || {};
    if (!kind || !user_id) return res.status(400).json({ success: false, error: 'kind and user_id required' });
    const [{ rows: [assignee] }, { rows: [actor] }] = await Promise.all([
      pool.query(`SELECT id, name, email, hierarchy_level, notification_prefs FROM users WHERE id = $1`, [user_id]),
      pool.query(`SELECT id, name, hierarchy_level FROM users WHERE id = $1`, [req.user.id]),
    ]);
    if (!assignee) return res.status(404).json({ success: false, error: 'No such person' });
    const register = require('../lib/flags-register');
    const task = await register.assign({ kind, key: String(key), assignee, actor, due_date: due_date || null, title, to, severity });
    // Same email the task form sends, when the assignee wants it. Best effort.
    if (String(assignee.id) !== String(req.user.id)) {
      require('../lib/notifier').notifyAssigned({ assignee, assigner: actor.name, description: task.description, priority: task.priority, due_date: task.due_date }).catch(() => {});
    }
    res.json({ success: true, data: task });
  } catch (err) { console.error('POST /api/flags/assign:', err); res.status(500).json({ success: false, error: err.message }); }
});

// DELETE /api/flags/assign?kind=&key= — drop the owner; their task closes.
router.delete('/assign', authMiddleware, async (req, res) => {
  try {
    const { kind, key = '*' } = req.query || {};
    if (!kind) return res.status(400).json({ success: false, error: 'kind required' });
    const ok = await require('../lib/flags-register').unassign({ kind, key: String(key) });
    res.json({ success: true, removed: ok });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/flags/artist-multi/apply
// Body: { source: string, base: string, base_artist_id?: number }
// - Bulk UPDATE expenses.artist = <base> WHERE LOWER(TRIM(artist)) = LOWER(TRIM(<source>))
// - Cascade to deals.artist_name + artist_income.artist_name (same
//   tables the artist rename + merge cascades touch).
// - Upsert artist_normalization so future rows with the same source
//   string auto-collapse to the base at insert time.
// Admin/Superadmin only — this is a bulk rewrite.
router.post('/artist-multi/apply', authMiddleware, async (req, res) => {
  const role = (req.user?.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'superadmin') {
    return res.status(403).json({ success: false, error: 'Admin required' });
  }
  const source = String(req.body?.source || '').trim();
  const base = String(req.body?.base || '').trim();
  const baseArtistId = Number.isInteger(req.body?.base_artist_id) && req.body.base_artist_id > 0
    ? req.body.base_artist_id
    : null;
  if (!source) return res.status(400).json({ success: false, error: 'source required' });
  if (!base) return res.status(400).json({ success: false, error: 'base required' });
  if (base.toLowerCase() === source.toLowerCase()) {
    return res.status(400).json({ success: false, error: 'base must differ from source' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const key = source.toLowerCase();
    const exp = await client.query(
      `UPDATE expenses SET artist = $1
        WHERE LOWER(TRIM(artist)) = $2`,
      [base, key]
    );
    // No .catch() here: a swallowed failure aborts the transaction (every
    // later statement fails with 25P02) and the final COMMIT silently
    // no-ops — the endpoint reported success while nothing was written.
    // Let errors reach the outer catch's ROLLBACK instead.
    await client.query(
      `UPDATE deals SET artist_name = $1
        WHERE LOWER(TRIM(artist_name)) = $2`,
      [base, key]
    );
    await client.query(
      `UPDATE artist_income SET artist_name = $1
        WHERE LOWER(TRIM(artist_name)) = $2`,
      [base, key]
    );
    // Remember the mapping. On conflict, refresh the base + who/when
    // so operators can audit re-normalizations later.
    await client.query(
      `INSERT INTO artist_normalization
         (source_key, source_display, base_artist, base_artist_id, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_key) DO UPDATE SET
         source_display = EXCLUDED.source_display,
         base_artist    = EXCLUDED.base_artist,
         base_artist_id = EXCLUDED.base_artist_id,
         created_by     = EXCLUDED.created_by,
         created_at     = NOW()`,
      [key, source, base, baseArtistId, req.user?.id || null]
    );
    await client.query('COMMIT');
    res.json({ success: true, data: { renamed: exp.rowCount || 0, source, base } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/flags/artist-multi/apply:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// The data-quality detectors, for lib/flags-register's hourly sweep — so
// duplicates and blanks get first-seen / age / ownership like everything else.
router.detectors = {
  getDuplicateReleases, getDuplicateArtists, getDuplicateVendors, getDuplicateInvoices,
  getReleasesMissingGenre, getReleasesMissingIdentifier, getReleasesMissingSpotify,
  getArtistsMissingGenre, getArtistsMissingSpotify, getMultiArtistGroups,
  getArtistFlags, getMissingSongFlags, getMissingSocialsFlags,
  getFlaggedExpenses, getFlaggedTransactions,
  groupKeyForArtists, groupKeyForVendors,
};

module.exports = router;
