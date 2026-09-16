// FX rate stamper.
//
// When an expense row's payment_status flips to 'Paid', we snapshot the
// exchange rate as-of payment_date onto expenses.fx_rate_to_usd. Once
// stamped, the row's USD-equivalent never changes again — that's the
// audit guarantee for paid invoices.
//
// The column convention matches /api/fx/rates: it stores "value of
// `currency` per 1 USD on payment_date", so USD = native / fx_rate_to_usd.
// USD rows get a literal 1 to make the "is stamped?" check consistent
// (NULL = needs stamping, non-NULL = locked).
//
// Designed to be safe to call repeatedly: idempotent on its CTE check,
// no-ops if already stamped, no-ops if not yet paid, no-ops if the
// historical fetch fails (the row stays NULL and live rates are used
// for display until something retries).

const pool = require('../db');
const fxService = require('./fx');

function dateToYmd(d) {
  if (!d) return null;
  if (d instanceof Date) {
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  const s = String(d);
  // Already a YYYY-MM-DD or 'YYYY-MM-DDTHH:MM:SS...' — slice off any time.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Last resort: let JS parse it.
  const j = new Date(s);
  return isNaN(j.getTime()) ? null : j.toISOString().slice(0, 10);
}

// Stamp one entry. `client` is optional — pass a pg client to participate
// in an open transaction; otherwise the helper grabs its own connection
// from the pool.
async function stampFxRateIfPaid(client, entryId) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT id, currency, payment_status, payment_date, fx_rate_to_usd
       FROM expenses WHERE id = $1`,
    [entryId]
  );
  if (!rows.length) return;
  const e = rows[0];
  if (e.fx_rate_to_usd != null) return;        // already locked
  if (e.payment_status !== 'Paid') return;     // not yet paid

  const cur = (e.currency || 'USD').toUpperCase();
  if (cur === 'USD') {
    await db.query(
      `UPDATE expenses SET fx_rate_to_usd = 1 WHERE id = $1 AND fx_rate_to_usd IS NULL`,
      [entryId]
    );
    return;
  }

  // Lock at payment_date when set; else today's date (only matters for
  // legacy rows that somehow have payment_status=Paid with no date).
  const asOf = dateToYmd(e.payment_date) || new Date().toISOString().slice(0, 10);
  const hist = await fxService.getHistorical(asOf);
  const rate = hist?.rates?.[cur];
  if (rate == null || !Number.isFinite(Number(rate)) || Number(rate) <= 0) {
    console.warn(`[fxStamp] No rate for ${cur} on ${asOf}; entry ${entryId} stays unlocked`);
    return;
  }
  await db.query(
    `UPDATE expenses SET fx_rate_to_usd = $1 WHERE id = $2 AND fx_rate_to_usd IS NULL`,
    [rate, entryId]
  );
}

// Fire-and-forget convenience for PATCH/PUT handlers — never blocks the
// response, logs failures so they don't disappear silently.
function stampFxRateAsync(entryId) {
  stampFxRateIfPaid(null, entryId).catch(err => {
    console.warn(`[fxStamp] async stamp failed for entry ${entryId}: ${err.message}`);
  });
}

// One-shot scan for un-stamped paid rows. Called from server/index.js at
// startup so existing data picks up locked rates without anyone touching
// each row. Batches by distinct payment_date to keep the FX hit-count
// proportional to dates, not rows.
async function backfillPaidRows() {
  // Fetch every paid non-USD row with no lock yet, grouped by date.
  const { rows } = await pool.query(`
    SELECT id, currency, payment_date
      FROM expenses
     WHERE payment_status = 'Paid'
       AND fx_rate_to_usd IS NULL
       AND (deleted = false OR deleted IS NULL)
       AND currency IS NOT NULL
       AND UPPER(currency) != 'USD'
  `);
  if (!rows.length) {
    // Also stamp USD rows so the "is stamped?" check stays consistent.
    await pool.query(`
      UPDATE expenses SET fx_rate_to_usd = 1
       WHERE payment_status = 'Paid'
         AND fx_rate_to_usd IS NULL
         AND (deleted = false OR deleted IS NULL)
         AND (currency IS NULL OR UPPER(currency) = 'USD')
    `);
    console.log('[fxStamp] backfill: no non-USD paid rows pending');
    return;
  }

  // Group by date so we hit the FX API once per unique date.
  const byDate = new Map(); // ymd -> { ids: Set, rows: [] }
  for (const r of rows) {
    const ymd = dateToYmd(r.payment_date) || new Date().toISOString().slice(0, 10);
    if (!byDate.has(ymd)) byDate.set(ymd, []);
    byDate.get(ymd).push(r);
  }

  let stamped = 0, skipped = 0;
  for (const [ymd, group] of byDate) {
    const hist = await fxService.getHistorical(ymd);
    if (!hist?.rates) {
      console.warn(`[fxStamp] backfill: skipping ${group.length} rows on ${ymd} — historical fetch failed`);
      skipped += group.length;
      continue;
    }
    for (const r of group) {
      const cur = (r.currency || 'USD').toUpperCase();
      const rate = hist.rates[cur];
      if (rate == null || !Number.isFinite(Number(rate)) || Number(rate) <= 0) {
        skipped++;
        continue;
      }
      try {
        await pool.query(
          `UPDATE expenses SET fx_rate_to_usd = $1
            WHERE id = $2 AND fx_rate_to_usd IS NULL`,
          [rate, r.id]
        );
        stamped++;
      } catch (err) {
        console.warn(`[fxStamp] backfill: UPDATE failed for entry ${r.id}: ${err.message}`);
        skipped++;
      }
    }
  }

  // Backfill USD rows in a single UPDATE — no rate fetch needed.
  await pool.query(`
    UPDATE expenses SET fx_rate_to_usd = 1
     WHERE payment_status = 'Paid'
       AND fx_rate_to_usd IS NULL
       AND (deleted = false OR deleted IS NULL)
       AND (currency IS NULL OR UPPER(currency) = 'USD')
  `).catch(() => {});

  console.log(`[fxStamp] backfill done: ${stamped} stamped, ${skipped} skipped, across ${byDate.size} dates`);
}

module.exports = { stampFxRateIfPaid, stampFxRateAsync, backfillPaidRows };
