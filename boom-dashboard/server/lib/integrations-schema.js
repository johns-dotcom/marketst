// Tables for the third-party integrations added 2026-09-19: QuickBooks Online
// (push sync with a retry queue), DocuSign (envelopes for signature) and the
// artist stats feed (Spotify Web API + Chartmetric). Called from runMigrations
// after the mail tables; every statement carries its own .catch so one failure
// cannot stop the rest of the migration promise.
const pool = require('../db');

const run = (label, sql) => pool.query(sql).catch((err) => console.error(`${label} migration failed:`, err.message));

async function ensure() {
  // ─── QuickBooks Online ──────────────────────────────────────────────────
  await run('qbo_connection', `CREATE TABLE IF NOT EXISTS qbo_connection (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    realm_id TEXT NOT NULL, company_name TEXT, env TEXT NOT NULL DEFAULT 'sandbox',
    refresh_token_enc TEXT, access_token_enc TEXT, access_expires_at TIMESTAMPTZ, refresh_expires_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'active', last_error TEXT,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    connected_by INTEGER REFERENCES users(id) ON DELETE SET NULL, connected_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  // What each dashboard row became in QuickBooks. entity_key is the expense id
  // for bills/payments and the lower-cased payee for vendors.
  await run('qbo_links', `CREATE TABLE IF NOT EXISTS qbo_links (
    id SERIAL PRIMARY KEY, entity_type TEXT NOT NULL, entity_key TEXT NOT NULL,
    qbo_type TEXT NOT NULL, qbo_id TEXT NOT NULL, sync_token TEXT, synced_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (entity_type, entity_key)
  )`);
  // The retry queue: one row per (kind, expense). Re-enqueueing resets a done
  // or errored row to pending so an edit after approval is pushed again.
  await run('qbo_queue', `CREATE TABLE IF NOT EXISTS qbo_queue (
    id SERIAL PRIMARY KEY, kind TEXT NOT NULL, expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), claimed_at TIMESTAMPTZ, last_error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(), done_at TIMESTAMPTZ, requested_by INTEGER,
    UNIQUE (kind, expense_id)
  )`);
  await run('qbo_queue idx', `CREATE INDEX IF NOT EXISTS idx_qbo_queue_due ON qbo_queue (status, next_attempt_at)`);

  // ─── DocuSign ───────────────────────────────────────────────────────────
  await run('docusign_account', `CREATE TABLE IF NOT EXISTS docusign_account (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    account_id TEXT NOT NULL, account_name TEXT, base_uri TEXT NOT NULL, env TEXT NOT NULL DEFAULT 'demo',
    user_email TEXT, refresh_token_enc TEXT, access_token_enc TEXT, access_expires_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'active', last_error TEXT,
    connected_by INTEGER REFERENCES users(id) ON DELETE SET NULL, connected_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await run('signature_envelopes', `CREATE TABLE IF NOT EXISTS signature_envelopes (
    id SERIAL PRIMARY KEY, envelope_id TEXT UNIQUE,
    doc_type TEXT NOT NULL, doc_id INTEGER NOT NULL, artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    source_file_id INTEGER REFERENCES entity_files(id) ON DELETE SET NULL, title TEXT NOT NULL,
    signer_name TEXT NOT NULL, signer_email TEXT NOT NULL, countersigner_name TEXT, countersigner_email TEXT,
    status TEXT NOT NULL DEFAULT 'sent', signer_status TEXT, countersigner_status TEXT,
    sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL, sent_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ, signed_file_id INTEGER REFERENCES entity_files(id) ON DELETE SET NULL,
    last_checked_at TIMESTAMPTZ, last_error TEXT, message TEXT
  )`);
  await run('signature_envelopes idx', `CREATE INDEX IF NOT EXISTS idx_sig_env_doc ON signature_envelopes (doc_type, doc_id)`);
  await run('boom_ndas.recipient_email', `ALTER TABLE boom_ndas ADD COLUMN IF NOT EXISTS recipient_email TEXT`);
  await run('label_settings.signatory_email', `ALTER TABLE label_settings ADD COLUMN IF NOT EXISTS signatory_email TEXT`);

  // ─── Artist stats (Spotify Web API + Chartmetric) ───────────────────────
  await run('artist_stats', `CREATE TABLE IF NOT EXISTS artist_stats (
    id SERIAL PRIMARY KEY, artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    source TEXT NOT NULL, day DATE NOT NULL,
    followers INTEGER, popularity INTEGER, monthly_listeners INTEGER, top_tracks JSONB, raw JSONB,
    fetched_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (artist_id, source, day)
  )`);
  await run('artists.spotify_id', `ALTER TABLE artists ADD COLUMN IF NOT EXISTS spotify_id TEXT`);
  await run('artists.chartmetric_id', `ALTER TABLE artists ADD COLUMN IF NOT EXISTS chartmetric_id TEXT`);
  await run('integration_jobs', `CREATE TABLE IF NOT EXISTS integration_jobs (job TEXT NOT NULL, period TEXT NOT NULL, ran_at TIMESTAMPTZ DEFAULT NOW(), result JSONB, PRIMARY KEY (job, period))`);
}

module.exports = { ensure };
