/**
 * One-off import of the market.st expense sheet into release spend plans.
 *
 * Behavior (agreed with John 2026-09-03):
 *   - The sheet holds COMMITMENTS. Nothing here writes to `expenses`, and no
 *     actual is copied in — `release_id` is the join and the ledger stays the
 *     only record of money that moved.
 *   - A block links to a release ONLY on an exact (artist, project) pair, tried
 *     in both header orders. Everything else goes to a queue with ranked
 *     suggestions; nothing is linked on a fuzzy score.
 *   - "Who Paid" maps to a payment status. Bare person names map to NULL
 *     (unknown), never to paid.
 *   - Re-running refreshes the money and LEAVES THE MATCHING ALONE, so a second
 *     run cannot undo the queue answers somebody has already given.
 *
 * Parse + diff + apply live in server/lib/spendPlan.js so the same code path
 * drives the in-app import page.
 *
 * Usage:
 *   node server/scripts/import-spend-plans.js [--apply] [path]
 *
 * Boot from `server/` so dotenv reads `./.env` and it runs against the dev
 * database. Dry run by default; nothing is written without --apply.
 */

require('dotenv').config();
const pool = require('../db');
const { parseSheet, diff, loadDbState, applyImport } = require('../lib/spendPlan');

const APPLY = process.argv.includes('--apply');
const SHEET_PATH = process.argv.find(a => a.endsWith('.xlsx'))
  || '/Users/johnskead/Downloads/Copy of Boom.Records.xlsx';

const money = n => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

(async function main() {
  console.log(`\nMode:  ${APPLY ? 'APPLY (writes will happen)' : 'DRY RUN (no writes)'}`);
  console.log(`Sheet: ${SHEET_PATH}\n`);

  const blocks = await parseSheet(SHEET_PATH);
  console.log(`Read ${blocks.length} release blocks from the Expenses tab.`);

  const { dbReleases } = await loadDbState(pool);
  console.log(`Existing releases in DB: ${dbReleases.length}\n`);

  const { results, stats } = diff(blocks, dbReleases);

  console.log('--- What the sheet says ---');
  console.log(`  Release blocks:            ${stats.blocks}`);
  console.log(`  Expense lines:             ${stats.lines}`);
  console.log(`  Sheet total:               ${money(stats.sheetTotal)}`);
  console.log(`    of which paid:           ${money(stats.paid)}`);
  console.log(`    of which not yet:        ${money(stats.committed)}`);
  console.log(`    status unknown:          ${money(stats.unknownStatus)}`);

  console.log('\n--- Matching ---');
  console.log(`  Linked to a release:       ${stats.matched}`);
  console.log(`  Duplicate release in DB:   ${stats.duplicateRelease}   (merge them, then re-run)`);
  console.log(`  Header ambiguous:          ${stats.ambiguous}`);
  console.log(`  No match:                  ${stats.unmatched}`);
  console.log(`    with a suggestion:       ${stats.withSuggestion}`);
  const queued = results.filter(r => r.status !== 'matched');
  console.log(`  Queued for review:         ${queued.length}  (${money(queued.reduce((s, r) => s + (r.sheetTotal || 0), 0))})`);

  console.log('\n--- Data quality, reported not corrected ---');
  console.log(`  Totals derived from a formula with no cached value: ${stats.derivedTotals}`);
  console.log(`  Printed totals disagreeing with their own lines:    ${stats.totalDisagreements}`);
  console.log(`  Amount cells holding prose instead of a number:     ${stats.nonNumericAmounts}`);

  const disagree = results.filter(
    r => r.totalSource === 'printed' && Math.abs(r.sheetTotal - r.linesTotal) > 0.005
  );
  if (disagree.length) {
    console.log('\n  Total vs lines:');
    for (const r of disagree) {
      console.log(`    ${r.sourceColumn.padEnd(5)} ${String(r.header).slice(0, 44).padEnd(45)} printed ${money(r.sheetTotal).padStart(13)}  lines ${money(r.linesTotal).padStart(13)}`);
    }
  }

  const prose = results.flatMap(r => r.lines.filter(l => l.amountRaw).map(l => ({ r, l })));
  if (prose.length) {
    console.log('\n  Prose in the amount column (imported with a NULL amount):');
    for (const { r, l } of prose.slice(0, 15)) {
      console.log(`    ${r.sourceColumn}${l.sourceRow} ${String(r.header).slice(0, 34).padEnd(35)} ${JSON.stringify(l.amountRaw)}`);
    }
    if (prose.length > 15) console.log(`    …and ${prose.length - 15} more`);
  }

  const sample = queued.filter(r => r.suggestions.length).slice(0, 12);
  if (sample.length) {
    console.log('\n--- Queue preview (top suggestion) ---');
    for (const r of sample) {
      console.log(`  ${String(r.header).slice(0, 40).padEnd(41)} -> ${r.suggestions[0].label}  (${r.suggestions[0].score})`);
    }
  }

  if (!APPLY) {
    console.log('\nDry run complete. Re-run with --apply to write these changes.\n');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const written = await applyImport(client, results, null);
    await client.query('COMMIT');
    console.log('\n--- Written ---');
    console.log(`  Plans inserted:  ${written.plansInserted}`);
    console.log(`  Plans updated:   ${written.plansUpdated}`);
    console.log(`  Lines written:   ${written.linesWritten}\n`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nImport FAILED, rolled back:', err.message, '\n');
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})().catch(err => {
  console.error('\nFAILED:', err.message, '\n');
  process.exit(1);
});
