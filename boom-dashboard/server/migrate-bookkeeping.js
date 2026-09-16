/**
 * migrate-bookkeeping.js
 *
 * One-time script to copy expenses + audit log from the Flask bookkeeping
 * app's PostgreSQL database into boom-combined's main PostgreSQL database.
 *
 * Usage (run from the server/ directory):
 *   BOOKKEEPING_DB_URL="postgres://..." node migrate-bookkeeping.js
 *
 * Or set BOOKKEEPING_DB_URL in .env and run:
 *   node migrate-bookkeeping.js
 *
 * The script is safe to run multiple times — it uses ON CONFLICT DO NOTHING
 * so existing rows are never overwritten.
 *
 * Prerequisites:
 *   - The main DATABASE_URL database must already have the expenses and
 *     bk_audit_log tables (deploy boom-combined once first so runMigrations
 *     creates them, OR run: node -e "require('./index')" and ctrl-c after
 *     "Schema migrations applied" appears in the logs).
 *   - BOOKKEEPING_DB_URL must point to the Flask app's live Railway Postgres.
 *     Find it in the Flask app's Railway service → Variables → DATABASE_URL.
 */

require('dotenv').config();
const { Pool } = require('pg');

const SRC_URL  = process.env.BOOKKEEPING_DB_URL;
const DEST_URL = process.env.DATABASE_URL;

if (!SRC_URL)  { console.error('ERROR: BOOKKEEPING_DB_URL not set'); process.exit(1); }
if (!DEST_URL) { console.error('ERROR: DATABASE_URL not set');        process.exit(1); }

const src  = new Pool({ connectionString: SRC_URL,  ssl: { rejectUnauthorized: false } });
const dest = new Pool({ connectionString: DEST_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  console.log('\n── Market Street bookkeeping migration ─────────────────────────\n');

  // ── Step 1: verify source tables exist ───────────────────────────────────
  const { rows: srcTables } = await src.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('expenses','audit_log')
  `);
  const srcTableNames = srcTables.map(r => r.table_name);
  console.log('Source tables found:', srcTableNames);

  // ── Step 2: migrate expenses ──────────────────────────────────────────────
  console.log('\nReading expenses from source...');
  const { rows: expenses } = await src.query(`
    SELECT
      id, invoice_date, payee, description, category, artist, song,
      invoice_number, amount, currency, payment_method,
      payment_date, in_quickbooks, qb_entry_date,
      uploaded_to_stem, stem_upload_date,
      invoice_filename, invoice_data,
      w9_filename, w9_data,
      proof_filename, proof_data,
      vendor_submitted, vendor_name, vendor_email, vendor_address,
      status, approved_by, approved_at,
      payment_status, payment_terms, scheduled_payment_date, paid_by,
      artist_breakdown, cobrand, is_reimbursement,
      notes, boom_rep, deleted, parent_id,
      created_at, created_by
    FROM expenses
    ORDER BY id ASC
  `);
  console.log(`  Found ${expenses.length} expense rows`);

  let expensesInserted = 0;
  let expensesSkipped  = 0;

  // Two-pass: insert non-children first so parent_id FKs resolve
  const parents  = expenses.filter(e => e.parent_id === null || e.parent_id === undefined);
  const children = expenses.filter(e => e.parent_id !== null && e.parent_id !== undefined);

  for (const batch of [parents, children]) {
    for (const e of batch) {
      try {
        // Parse artist_breakdown if it came back as a string
        let artistBreakdown = e.artist_breakdown;
        if (typeof artistBreakdown === 'string') {
          try { artistBreakdown = JSON.parse(artistBreakdown); } catch (_) { artistBreakdown = null; }
        }

        const { rowCount } = await dest.query(`
          INSERT INTO expenses (
            id, invoice_date, payee, description, category, artist, song,
            invoice_number, amount, currency, payment_method,
            payment_date, in_quickbooks, qb_entry_date,
            uploaded_to_stem, stem_upload_date,
            invoice_filename, invoice_data,
            w9_filename, w9_data,
            proof_filename, proof_data,
            vendor_submitted, vendor_name, vendor_email, vendor_address,
            status, approved_by, approved_at,
            payment_status, payment_terms, scheduled_payment_date, paid_by,
            artist_breakdown, cobrand, is_reimbursement,
            notes, boom_rep, deleted, parent_id,
            created_at, created_by
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
            $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
            $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42
          )
          ON CONFLICT (id) DO NOTHING
        `, [
          e.id, e.invoice_date, e.payee, e.description, e.category,
          e.artist, e.song, e.invoice_number, e.amount, e.currency || 'USD',
          e.payment_method, e.payment_date, e.in_quickbooks || 'No', e.qb_entry_date,
          e.uploaded_to_stem || 'No', e.stem_upload_date,
          e.invoice_filename, e.invoice_data,
          e.w9_filename, e.w9_data,
          e.proof_filename, e.proof_data,
          e.vendor_submitted || false, e.vendor_name, e.vendor_email, e.vendor_address,
          e.status || 'approved', e.approved_by, e.approved_at,
          e.payment_status || 'Unpaid', e.payment_terms, e.scheduled_payment_date, e.paid_by,
          artistBreakdown ? JSON.stringify(artistBreakdown) : null,
          e.cobrand || false, e.is_reimbursement || false,
          e.notes, e.boom_rep,
          e.deleted || false, e.parent_id || null,
          e.created_at || new Date(), e.created_by,
        ]);

        if (rowCount > 0) expensesInserted++;
        else              expensesSkipped++;
      } catch (err) {
        console.warn(`  ⚠ Skipping expense id=${e.id} (${e.payee}): ${err.message}`);
        expensesSkipped++;
      }
    }
  }

  // Advance the ID sequence so new inserts don't collide with migrated IDs
  await dest.query(`SELECT setval('expenses_id_seq', (SELECT MAX(id) FROM expenses))`);

  console.log(`  ✓ Inserted: ${expensesInserted} | Skipped (already exist): ${expensesSkipped}`);

  // ── Step 3: migrate audit_log → bk_audit_log ─────────────────────────────
  if (srcTableNames.includes('audit_log')) {
    console.log('\nReading audit_log from source...');

    // Source audit_log may have different column names — handle both schemas
    const { rows: srcCols } = await src.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'audit_log' AND table_schema = 'public'
    `);
    const colNames = srcCols.map(r => r.column_name);
    const hasTimestamp = colNames.includes('timestamp');
    const tsCol = hasTimestamp ? 'timestamp' : 'created_at';

    const { rows: auditRows } = await src.query(`
      SELECT id, ${tsCol} AS ts, user_name,
             action,
             ${colNames.includes('entry_id')   ? 'entry_id'   : 'NULL::int'} AS entry_id,
             ${colNames.includes('entry_payee') ? 'entry_payee': 'NULL::text'} AS entry_payee,
             ${colNames.includes('field')       ? 'field'      : 'NULL::text'} AS field,
             ${colNames.includes('old_value')   ? 'old_value'  : 'NULL::text'} AS old_value,
             ${colNames.includes('new_value')   ? 'new_value'  : 'NULL::text'} AS new_value,
             ${colNames.includes('details')     ? 'details'    : 'NULL::text'} AS details
      FROM audit_log
      ORDER BY id ASC
    `);
    console.log(`  Found ${auditRows.length} audit rows`);

    let auditInserted = 0;
    let auditSkipped  = 0;

    for (const r of auditRows) {
      try {
        const { rowCount } = await dest.query(`
          INSERT INTO bk_audit_log (id, ts, user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (id) DO NOTHING
        `, [r.id, r.ts, r.user_name, r.action, r.entry_id || null, r.entry_payee || null,
            r.field || null, r.old_value || null, r.new_value || null, r.details || null]);

        if (rowCount > 0) auditInserted++;
        else              auditSkipped++;
      } catch (err) {
        console.warn(`  ⚠ Skipping audit id=${r.id}: ${err.message}`);
        auditSkipped++;
      }
    }

    await dest.query(`SELECT setval('bk_audit_log_id_seq', (SELECT MAX(id) FROM bk_audit_log))`);
    console.log(`  ✓ Inserted: ${auditInserted} | Skipped: ${auditSkipped}`);
  } else {
    console.log('\nNo audit_log table in source — skipping audit migration.');
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log('\n── Migration complete ──────────────────────────────────────────');
  console.log('Next steps:');
  console.log('  1. Verify data in Railway: psql $DATABASE_URL -c "SELECT COUNT(*) FROM expenses"');
  console.log('  2. Remove BOOKKEEPING_DB_URL from Railway env vars (no longer needed)');
  console.log('  3. The Flask bookkeeping app can be decommissioned\n');

  await src.end();
  await dest.end();
}

run().catch(err => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});
