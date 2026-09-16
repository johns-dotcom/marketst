/**
 * Adds six follow-up / commercial fields to the deals table:
 *   last_contact_date, next_followup_date, priority, spotify_monthly_listeners,
 *   deal_type, offer_amount
 *
 * Safe to re-run: every column uses ADD COLUMN IF NOT EXISTS.
 *
 * Usage:
 *   npm run migrate:deals   (from server/)
 */

require('dotenv').config();
const pool = require('../db');

const COLUMNS = [
  ['last_contact_date',          'DATE'],
  ['next_followup_date',         'DATE'],
  ['priority',                   `VARCHAR(10) DEFAULT 'Medium'`],
  ['spotify_monthly_listeners',  'INTEGER'],
  ['deal_type',                  'VARCHAR(50)'],
  ['offer_amount',               'NUMERIC(12,2)'],
];

(async function main() {
  console.log('Adding deal fields…\n');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const [name, type] of COLUMNS) {
      await client.query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS ${name} ${type}`);
      console.log(`  ✓ ${name} (${type})`);
    }

    // Constrain priority to the documented set. Done as a separate statement
    // so re-runs don't fail if the constraint already exists.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'deals_priority_check'
        ) THEN
          ALTER TABLE deals
            ADD CONSTRAINT deals_priority_check
            CHECK (priority IN ('High','Medium','Low'));
        END IF;
      END$$;
    `);
    console.log('  ✓ deals_priority_check constraint');

    await client.query('COMMIT');
    console.log('\nDone.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed, rolled back:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
