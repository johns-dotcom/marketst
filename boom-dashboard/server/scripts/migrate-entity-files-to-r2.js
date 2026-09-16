/**
 * One-shot backfill: upload every legacy entity_files.file_data blob to R2
 * and record the new object key. Skips rows that already have r2_key set.
 *
 * Usage:
 *   cd server && node scripts/migrate-entity-files-to-r2.js
 *   (or `railway run node scripts/migrate-entity-files-to-r2.js`)
 *
 * Safe to re-run — its WHERE clause excludes rows already migrated.
 */
require('dotenv').config();
const pool = require('../db');
const { uploadFile } = require('../lib/r2');
const { sniffMime } = require('../lib/sniffMime');

async function migrate() {
  const { rows } = await pool.query(`
    SELECT id, entity_type, entity_id, filename, original_name, mime_type, file_data
    FROM entity_files
    WHERE file_data IS NOT NULL AND file_data != ''
      AND r2_key IS NULL
    ORDER BY id ASC
  `);

  console.log(`Migrating ${rows.length} entity_files rows...`);

  let migrated = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const buffer = Buffer.from(row.file_data, 'base64');
      const mime = row.mime_type || sniffMime(buffer) || 'application/octet-stream';
      const key = `entity_files/${row.entity_type}/${row.entity_id}/${row.filename}`;
      await uploadFile(key, buffer, mime);
      await pool.query('UPDATE entity_files SET r2_key = $1 WHERE id = $2', [key, row.id]);
      migrated++;
      console.log(`Migrated entity_files #${row.id} (${row.entity_type}/${row.entity_id}) → ${key}`);
    } catch (err) {
      errors++;
      console.error(`Failed #${row.id} (${row.entity_type}/${row.entity_id}):`, err.message);
    }
  }

  console.log(`\nMigration complete. migrated=${migrated} errors=${errors}`);
  process.exit(errors > 0 ? 1 : 0);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
