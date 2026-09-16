/**
 * One-off import of the Market Street master sheet into the releases table.
 *
 * Behavior (agreed with John 2026-04-28):
 *   - Insert-only. Never updates an existing release row.
 *   - Match key: UPC if present on the spreadsheet row, else
 *     (artist_name + project_name) compared case-insensitively.
 *   - Auto-create any artist that does not already exist (case-insensitive
 *     match on artists.name).
 *   - Past Releases sheet → in_catalog = true. Upcoming → false.
 *   - Pitch flag columns ("yes" or blank) → true on insert if any non-empty
 *     value is present, else false.
 *   - Reports any DB releases (UPC or artist+title) that the spreadsheet
 *     does not mention. Reports orphan stats only — does not modify them.
 *
 * Parse + diff + apply logic lives in server/lib/masterSheet.js so the same
 * code path drives the in-app Master Sheet Import page.
 *
 * Usage:
 *   DATABASE_URL=... node server/scripts/import-master-sheet.js [--apply] [path]
 */

require('dotenv').config();
const pool = require('../db');
const { parseSheet, diff, loadDbState, applyImport } = require('../lib/masterSheet');

const APPLY = process.argv.includes('--apply');
const SHEET_PATH = process.argv.find(a => a.endsWith('.xlsx'))
  || '/Users/johnskead/Downloads/Copy of Boom.Records __ Master Sheet (3).xlsx';

(async function main() {
  console.log(`\nMode: ${APPLY ? 'APPLY (writes will happen)' : 'DRY RUN (no writes)'}`);
  console.log(`Sheet: ${SHEET_PATH}\n`);

  const rows = await parseSheet(SHEET_PATH);
  console.log(`Read ${rows.length} non-empty rows from spreadsheet.`);

  const { dbArtists, dbReleases } = await loadDbState(pool);
  console.log(`Existing artists in DB: ${dbArtists.length}`);
  console.log(`Existing non-archived releases in DB: ${dbReleases.length}\n`);

  const { stats, artistsToCreate, toInsert, dbOrphans } = diff(rows, dbReleases, dbArtists);

  console.log('--- Spreadsheet rows ---');
  console.log(`  Total non-empty:           ${stats.totalRows}`);
  console.log(`  Skipped (no artist name):  ${stats.skippedNoArtistName}`);
  console.log(`  Skipped (no title):        ${stats.skippedNoTitle}`);
  console.log(`  Skipped (already in DB):   ${stats.skippedDuplicate}`);
  console.log(`  Will insert:               ${toInsert.length}`);
  console.log(`  New artists to create:     ${artistsToCreate.length}`);
  console.log(`\n--- DB releases NOT in spreadsheet (${dbOrphans.length}) ---`);
  const orphanPreview = dbOrphans.slice(0, 25);
  for (const o of orphanPreview) {
    console.log(`  [${o.id}] ${o.artist_name || '?'} — ${o.project_name}${o.upc ? ' (upc:' + o.upc + ')' : ''}`);
  }
  if (dbOrphans.length > orphanPreview.length) {
    console.log(`  …and ${dbOrphans.length - orphanPreview.length} more`);
  }

  if (artistsToCreate.length) {
    console.log(`\n--- New artists (preview, up to 25) ---`);
    for (const a of artistsToCreate.slice(0, 25)) console.log(`  ${a.name}`);
    if (artistsToCreate.length > 25) {
      console.log(`  …and ${artistsToCreate.length - 25} more`);
    }
  }

  if (!APPLY) {
    console.log(`\nDry run complete. Re-run with --apply to write these changes.`);
    await pool.end();
    return;
  }

  console.log('\nApplying…');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { artistsCreated, releasesInserted } = await applyImport(client, {
      artistsToCreate, toInsert, dbArtists,
    });
    await client.query('COMMIT');
    console.log(`\nDone. Inserted ${releasesInserted} releases, created ${artistsCreated} artists.`);
    console.log(`(${dbOrphans.length} DB releases were NOT in the spreadsheet — left untouched.)`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed, rolled back:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
