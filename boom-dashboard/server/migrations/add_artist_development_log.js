/**
 * Creates the artist_development_log table — a timeline of A&R touchpoints
 * (meetings, demos, follow-ups, etc.) per artist. Safe to re-run.
 *
 * Usage:
 *   npm run migrate:devlog   (from server/)
 */

require('dotenv').config();
const pool = require('../db');

const ENTRY_TYPES = [
  'Meeting', 'Demo Received', 'Feedback Sent', 'Offer Made',
  'Follow-up', 'Call', 'Email', 'Note',
];

(async function main() {
  console.log('Creating artist_development_log…\n');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS artist_development_log (
        id          SERIAL PRIMARY KEY,
        artist_id   INTEGER REFERENCES artists(id) ON DELETE CASCADE,
        entry_type  VARCHAR(50),
        date        DATE NOT NULL DEFAULT CURRENT_DATE,
        summary     TEXT NOT NULL,
        created_by  INTEGER REFERENCES users(id),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('  ✓ table');

    // Constrain entry_type to the documented set. Separate DO block so a
    // re-run doesn't trip if the constraint already exists.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'artist_dev_log_entry_type_check'
        ) THEN
          ALTER TABLE artist_development_log
            ADD CONSTRAINT artist_dev_log_entry_type_check
            CHECK (entry_type IN (${ENTRY_TYPES.map(t => `'${t}'`).join(', ')}));
        END IF;
      END$$;
    `);
    console.log('  ✓ entry_type CHECK constraint');

    // Index on (artist_id, date DESC, created_at DESC) — every list query
    // is per-artist + ordered by these two fields, so this is the right
    // shape for the lookup we'll do every time the Development tab opens.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_artist_dev_log_artist_date
      ON artist_development_log (artist_id, date DESC, created_at DESC)
    `);
    console.log('  ✓ idx_artist_dev_log_artist_date');

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
