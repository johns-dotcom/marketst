require('dotenv').config();
const pool = require('../db');
const { uploadFile } = require('../lib/r2');
const { sniffMime } = require('../lib/sniffMime');

async function migrate() {
  const { rows } = await pool.query(`
    SELECT id, invoice_filename, invoice_data, w9_filename, w9_data, proof_filename, proof_data
    FROM expenses
    WHERE (invoice_data IS NOT NULL OR w9_data IS NOT NULL OR proof_data IS NOT NULL)
      AND (invoice_r2_key IS NULL AND w9_r2_key IS NULL AND proof_r2_key IS NULL)
      AND (deleted = false OR deleted IS NULL)
  `);

  console.log(`Migrating ${rows.length} expenses...`);

  for (const row of rows) {
    const updates = {};

    if (row.invoice_data && !row.invoice_r2_key) {
      const buffer = Buffer.from(row.invoice_data, 'base64');
      const mime = sniffMime(buffer) || 'application/octet-stream';
      const key = `vendors/${row.id}/invoice/${row.invoice_filename || 'invoice.pdf'}`;
      await uploadFile(key, buffer, mime);
      updates.invoice_r2_key = key;
    }

    if (row.w9_data && !row.w9_r2_key) {
      const buffer = Buffer.from(row.w9_data, 'base64');
      const mime = sniffMime(buffer) || 'application/octet-stream';
      const key = `vendors/${row.id}/w9/${row.w9_filename || 'w9.pdf'}`;
      await uploadFile(key, buffer, mime);
      updates.w9_r2_key = key;
    }

    if (row.proof_data && !row.proof_r2_key) {
      const buffer = Buffer.from(row.proof_data, 'base64');
      const mime = sniffMime(buffer) || 'application/octet-stream';
      const key = `vendors/${row.id}/proof/${row.proof_filename || 'proof.pdf'}`;
      await uploadFile(key, buffer, mime);
      updates.proof_r2_key = key;
    }

    if (Object.keys(updates).length) {
      const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`).join(', ');
      const values = [...Object.values(updates), row.id];
      await pool.query(`UPDATE expenses SET ${setClauses} WHERE id = $${values.length}`, values);
      console.log(`Migrated expense ${row.id}`);
    }
  }

  console.log('Migration complete.');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
