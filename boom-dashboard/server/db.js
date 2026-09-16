const { Pool } = require('pg');
require('dotenv').config();

// SSL is decided by the CONNECTION STRING first, then by NODE_ENV.
//
// It used to be NODE_ENV alone, which meant local development could only ever
// talk to a plaintext Postgres on localhost. There isn't one on this machine
// (no Docker, no Homebrew), so `npm run dev:server` couldn't start at all — and
// with no way to run the app, nothing could be exercised in a browser before it
// deployed. Several production regressions came straight out of that gap.
//
// Any hosted Postgres (Neon, Supabase, RDS) requires SSL regardless of
// NODE_ENV, and every one of them says so in the URL. Honouring sslmode makes a
// hosted dev database work without pretending to be production, which would
// also make Express serve the React build and change half a dozen other
// behaviours.
//
// Production is unchanged: the NODE_ENV clause still stands on its own, so
// Railway behaves exactly as before whether or not its URL carries sslmode.
const CONN = process.env.DATABASE_URL || '';
const urlWantsSsl = /[?&]sslmode=(require|verify-ca|verify-full)/.test(CONN);
const pool = new Pool({
  connectionString: CONN,
  ssl: (process.env.NODE_ENV === 'production' || urlWantsSsl)
    ? { rejectUnauthorized: false }
    : false,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

module.exports = pool;
