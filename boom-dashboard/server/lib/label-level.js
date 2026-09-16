/**
 * Spend that bills the LABEL, not a release — so "which artist was this for" has
 * no answer, and a report should say so rather than counting it as unattributed.
 *
 * ── Why this exists ──
 * Campaign coverage sat at 68.7% with $289,499 of the gap in ad-platform charges:
 * 168 `SPOTIFY USA INC` debits, 262 `FACEBOOK`, 48 `APPLE.COM/BILL`. Measured
 * against every field on those rows, there is NOTHING that names an artist:
 *
 *   489 of 490 are `invented` — booked from a bank line, no invoice behind them
 *   0 carry a song, an artist, or a campaign
 *   the raw descriptors are merchant ids, identical on every charge:
 *     PURCHASE 0731 SPOTIFY USA INC 180-09525210 NY
 *     PURCHASE 0724 FACEBK *F4EE6X5GP2 650-5434800 CA
 *
 * A Spotify ad account bills the label; the charge is not per-release. So the
 * honest fix is not to guess which artist it was for — inferring it from dates
 * against the release calendar would be a guess dressed as a rule, and one shared
 * `PAYPAL` descriptor once filed 154 pulls under the wrong vendor — but to record
 * that this class of spend is label-level, and take it out of a coverage figure
 * it can only ever drag down. Same argument as `statement_no_invoice_rules`: a
 * number that can never improve is one people stop reading.
 *
 * ── What it does NOT do ──
 * It moves no money. The P&L total is unchanged and `by_artist.total` still ties
 * to it; label-level spend becomes a THIRD bucket beside the artists and the
 * unattributed, disclosed on its own.
 *
 * It also never overrides a real attribution. If somebody has named an artist on
 * a Facebook charge, that stands — the rule only speaks for rows where the
 * question is otherwise unanswered.
 *
 * ── EQUALITY, never substring ──
 * The trap `statement_no_invoice_rules` documents: "TONE" ($615k) is a substring
 * of "Tone Pay, Inc" and "Dean St" of "Dean Street Media". A vendor rule matches
 * the whole normalized name or nothing.
 *
 * Deleting a rule returns those rows to the unattributed bucket on the next
 * request — nothing was written to the ledger.
 */

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Load the rules once per request that needs them.
 *
 * Degrades to "no rules" on any error, including the table not existing yet:
 * runMigrations() runs in the BACKGROUND after app.listen, and a report that
 * 500s during a deploy window is worse than one that reports the old coverage.
 *
 * @returns {{ vendors: Set<string>, categories: Set<string>, has: Function, size: number }}
 */
async function loadLabelLevelRules(pool) {
  const empty = {
    vendors: new Set(), categories: new Set(), size: 0,
    has: () => false,
  };
  try {
    const { rows } = await pool.query(
      `SELECT scope, rule_key FROM label_level_spend_rules`);
    const vendors = new Set();
    const categories = new Set();
    for (const r of rows) {
      if (r.scope === 'vendor') vendors.add(norm(r.rule_key));
      else if (r.scope === 'category') categories.add(norm(r.rule_key));
    }
    return {
      vendors, categories, size: rows.length,
      /**
       * Is this spend label-level? A CATEGORY rule answers for everything in it;
       * a VENDOR rule answers for that payee whatever the category.
       */
      has: (payee, category) =>
        categories.has(norm(category)) || vendors.has(norm(payee)),
    };
  } catch (err) {
    console.error('label-level rules unavailable — reporting without them:', err.message);
    return empty;
  }
}

/**
 * Per-artist amounts drawn out of the pool, for the months a report covers.
 *
 * @param {string[]} months  'YYYY-MM' keys the report is reporting on
 */
async function loadAllocations(pool, months) {
  if (!months?.length) return [];
  try {
    const { rows } = await pool.query(
      `SELECT id, artist, category, period_month, amount::float8 AS amount, note, created_at
         FROM ad_pool_allocations
        WHERE period_month = ANY($1::text[])
        ORDER BY created_at ASC, id ASC`, [months]);
    return rows;
  } catch (err) {
    console.error('ad pool allocations unavailable — reporting the pool unallocated:', err.message);
    return [];
  }
}

/**
 * Apply allocations: move money from the pool to the artists.
 *
 * The pool can only give what it has. Allocations are applied in creation order
 * and TRIMMED at the point the pool runs out — deterministic, explainable, and it
 * can never drive the pool negative or hand an artist money the report does not
 * have. What was trimmed is returned, never swallowed: a pool that shrank after an
 * allocation was written (a charge recategorized, a statement re-uploaded) is a
 * real thing that needs saying.
 *
 * Mutates `labelLevel` and calls `credit(artist, category, amount)` for each
 * applied share, so the caller decides where an artist's money lands.
 *
 * @returns {{ applied, trimmed, byArtist, unallocated }}
 */
function applyAllocations(allocations, labelLevel, credit) {
  const out = { applied: 0, trimmed: [], byArtist: {}, unallocated: {} };
  // Per CATEGORY, because a pool of Advertisements cannot fund a Marketing
  // allocation — that would move money between P&L lines.
  const remaining = { ...labelLevel.cats };
  for (const a of allocations) {
    const cat = a.category || 'Advertisements';
    const want = Math.abs(Number(a.amount) || 0);
    if (!want) continue;
    const have = Math.max(0, Number(remaining[cat]) || 0);
    const give = Math.min(want, have);
    if (give < want) out.trimmed.push({ id: a.id, artist: a.artist, month: a.period_month,
      category: cat, requested: want, applied: give });
    if (!give) continue;
    remaining[cat] = have - give;
    labelLevel.cats[cat] = remaining[cat];
    labelLevel.total -= give;
    out.applied += give;
    out.byArtist[a.artist] = (out.byArtist[a.artist] || 0) + give;
    credit(a.artist, cat, give);
  }
  out.unallocated = { ...remaining };
  return out;
}

module.exports = { loadLabelLevelRules, loadAllocations, applyAllocations, norm };
