const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const releasesRoutes = require('./routes/releases');
const artistsRoutes = require('./routes/artists');
const teamRoutes = require('./routes/team');
const contractsRoutes = require('./routes/contracts');
const dealsRoutes = require('./routes/deals');
const labelRoutes = require('./routes/label');
const brandRoutes = require('./routes/brand');
const dashboardRoutes = require('./routes/dashboard');
const searchRoutes = require('./routes/search');
const dspRoutes = require('./routes/dsp');
const notificationsRoutes = require('./routes/notifications');
const financialsRoutes = require('./routes/financials');
const pendingContractsRoutes = require('./routes/pending-contracts');
const requestsRoutes = require('./routes/requests');
const activityRoutes = require('./routes/activity');
const settingsRoutes = require('./routes/settings');
const marketingRoutes = require('./routes/marketing');
const bookkeepingRoutes  = require('./routes/bookkeeping');
const vendorSubmitRoutes = require('./routes/vendor-submit');
const invoicesRoutes     = require('./routes/invoices');
const budgetsRoutes      = require('./routes/budgets');
const artistBudgetsRoutes = require('./routes/artist-budgets');
const spendPlansRoutes   = require('./routes/spend-plans');
const ndasRoutes         = require('./routes/ndas');
const clearancesRoutes   = require('./routes/clearances');
const labelWaiversRoutes = require('./routes/label-waivers');
const calendarRoutes     = require('./routes/calendar');
const salaryRoutes       = require('./routes/salary');
const adminDocsRoutes    = require('./routes/admin-docs');
const artistCampaignsRoutes = require('./routes/artist-campaigns');

const authMiddleware = require('./middleware/auth');
const activityLogger = require('./middleware/activityLogger');
const { securityAuditMiddleware } = require('./middleware/securityAudit');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();

// ── Security Headers ──────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: { policy: 'unsafe-none' }, // Required for Google SSO popup flow
}));

// ── Rate Limiting ─────────────────────────────────────────────────────────
// Trust Railway's proxy so req.ip reflects the real client IP
app.set('trust proxy', 1);

// Login: strict — 5 FAILED attempts per 15 minutes per IP. Successful
// logins don't count, so a legitimate user typing the wrong password
// once or twice and then succeeding won't burn through the quota.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { success: false, error: 'Too many login attempts. Please try again in 15 minutes.' },
});

// Vendor submit: public endpoint — 10 per hour per IP
const vendorLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  // 10 per hour per IP in production, and that is not configurable there — a
  // raised cap on a public endpoint that spends Anthropic calls is a bill a
  // stranger can run up.
  //
  // Outside production it can be raised, because the fixture for this route needs
  // more than ten submissions to cover its cases and a throttled run is WORSE than
  // no run: a 429 writes nothing, so every "nothing was written" assertion passes
  // vacuously against it. That has already happened here once — 13 passes against
  // four refusals — which is why the override exists rather than the fixture
  // quietly testing less.
  max: process.env.NODE_ENV === 'production'
    ? 10
    : Math.max(10, Number(process.env.VENDOR_SUBMIT_LIMIT) || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again later.' },
});

// AI endpoints: expensive calls — 20 per 15 minutes per IP
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'AI request limit reached. Please wait a few minutes.' },
});

// Batch-tolerant AI endpoints: parse-proof / validate-invoice /
// extract-invoice-number / scan-w9s also hit Claude but are driven by
// per-file loops (Bulk Upload fires one parse-proof per file). A separate,
// roomier bucket caps abuse without breaking a normal 20-file batch —
// they can't share aiLimiter's 20/15min pool for that reason.
const aiBatchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'AI request limit reached. Please wait a few minutes.' },
});

// File uploads: 30 per 15 minutes per IP
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Upload limit reached. Please wait a few minutes.' },
});

// General API: 200 requests per minute per IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please slow down.' },
});

// Apply general limiter to all /api routes
app.use('/api', generalLimiter);

// ── CORS ──────────────────────────────────────────────────────────────────
// In production, only allow the actual frontend domain.
// In development, allow localhost origins for Vite + Express dev servers.
const allowedOrigins = process.env.NODE_ENV === 'production'
  ? [process.env.FRONTEND_URL].filter(Boolean)
  : ['http://localhost:5173', 'http://localhost:3001', process.env.FRONTEND_URL].filter(Boolean);

// In production, API and frontend are same-origin (Express serves React build),
// so CORS is only needed for development (Vite on :5173 → Express on :3001).
if (process.env.NODE_ENV !== 'production') {
  app.use(cors({
    origin: ['http://localhost:5173', 'http://localhost:3001'],
    credentials: true,
  }));
} else {
  // Production: allow same-origin + Railway deploy previews
  app.use('/api', cors({
    origin: true, // Reflect request origin (safe since frontend is same-origin)
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
}

// JSON body limit — sized for the Bulk Upload page (`/bk/bulk-upload`),
// which packs N base64-encoded PDFs into a single JSON POST to
// `/api/bk/entries/batch`. Each ~1 MB PDF becomes ~1.4 MB encoded, so
// the 5 MB default caps the batch at ~3 invoices. 50 MB comfortably
// handles ~30 invoices per batch. Routes are auth-gated so the larger
// cap doesn't open a DoS vector beyond what authenticated users can do
// already.
app.use(express.json({ limit: '50mb' }));
const sanitize = require('./middleware/sanitize');
app.use(sanitize);

// Serve uploaded files — try disk first, fall back to DB (entity_files).
// JWT REQUIRED (Authorization header or ?token= — authMiddleware accepts
// both; the client's getFileUrl appends the token since these render as
// plain <a href> links). These are contract PDFs and admin-vault docs,
// some Superadmin-gated at the API layer — previously the raw bytes were
// world-readable by guessable timestamp-filename.
app.use('/uploads', authMiddleware, express.static(path.join(__dirname, 'uploads')));
app.get('/uploads/:filename', authMiddleware, async (req, res) => {
  try {
    const { loadFileBuffer } = require('./lib/r2');
    const { rows } = await pool.query(
      `SELECT ef.r2_key, ef.file_data, ef.mime_type, ef.original_name, ef.entity_type,
              ad.confidentiality
         FROM entity_files ef
         LEFT JOIN admin_documents ad
           ON ef.entity_type = 'admin_document' AND ad.id = ef.entity_id
        WHERE ef.filename = $1 LIMIT 1`,
      [req.params.filename]
    );
    if (!rows.length) return res.status(404).json({ error: 'File not found' });
    // Admin-vault files mirror the /api/admin-docs gates: admin-only, and
    // 'Restricted' rows Superadmin-only. Without this, any authenticated
    // user who knew a filename could pull the raw bytes of a vault doc.
    if (rows[0].entity_type === 'admin_document') {
      const role = (req.user?.role || '').toLowerCase();
      const superadmin = role === 'superadmin';
      const admin = superadmin || role === 'admin';
      if (!admin || (rows[0].confidentiality === 'Restricted' && !superadmin)) {
        return res.status(403).json({ error: 'Not authorized' });
      }
    }
    const buf = await loadFileBuffer(rows[0].r2_key, rows[0].file_data);
    if (!buf) return res.status(404).json({ error: 'File not found' });
    // Only render inline for types a browser can't execute script from.
    // Everything else (HTML, SVG, unknown) is forced to download as a
    // generic attachment so a malicious stored file can't run on our
    // origin — the stored mime_type is client-supplied at upload time.
    const mime = rows[0].mime_type || 'application/pdf';
    const inlineSafe = /^(application\/pdf|image\/(png|jpe?g|gif|webp|bmp))$/i.test(mime);
    const safeName = String(rows[0].original_name || req.params.filename)
      .replace(/[\r\n"\\]/g, '_');
    res.setHeader('Content-Type', inlineSafe ? mime : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${inlineSafe ? 'inline' : 'attachment'}; filename="${safeName}"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Activity logging — attaches to all routes, logs after response
app.use(activityLogger);
// Security audit logging — captures auth, permission, and security events
app.use(securityAuditMiddleware);

// Routes — with targeted rate limiters
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/register', loginLimiter);
app.use('/api/auth', authRoutes);
// Public — vendor submit reads from this. Auth-gated admin CRUD for
// reps lives at /api/settings/reps.
app.use('/api/reps', require('./routes/reps'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/flags', require('./routes/flags'));
app.use('/api/releases', releasesRoutes);
app.use('/api/artists', artistsRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/contracts/generate', aiLimiter);
app.use('/api/contracts/scan', aiLimiter, uploadLimiter);
app.use('/api/contracts', contractsRoutes);
app.use('/api/admin-docs', adminDocsRoutes);
app.use('/api/deals', dealsRoutes);
app.use('/api/label', labelRoutes);
app.use('/api/brand', brandRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/dsp', dspRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/financials', financialsRoutes);
app.use('/api/budgets', budgetsRoutes);
app.use('/api/artist-budgets', artistBudgetsRoutes);
app.use('/api/spend-plans', spendPlansRoutes);
app.use('/api/pending-contracts', pendingContractsRoutes);
app.use('/api/requests', requestsRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/marketing/parse', aiLimiter, uploadLimiter);
app.use('/api/marketing', marketingRoutes);
app.use('/api/statements/upload', uploadLimiter);
const statementsRoutes = require('./routes/statements');
app.use('/api/statements', statementsRoutes);
// Creator payments — ledger rows with entry_source='creator_payment'.
// Gated on its own page path so the marketing team can be granted this
// without the rest of the bookkeeping surface.
app.use('/api/creators', require('./routes/creators'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/bk/parse', aiLimiter, uploadLimiter);
// Remaining Claude-calling bookkeeping endpoints — previously unlimited.
app.use('/api/bk/parse-proof', aiBatchLimiter);
app.use('/api/bk/validate-invoice', aiBatchLimiter);
app.use('/api/bk/extract-invoice-number', aiBatchLimiter);
app.use('/api/bk/vendors/scan-w9s', aiBatchLimiter);
app.use('/api/bk', bookkeepingRoutes);
app.use('/api/vendor/submit', vendorLimiter);
// Vendor read helpers (lookup / check-dup / check-w9) are unauthenticated
// and fire debounced while the vendor types, so the 10/hr submit cap is
// too tight — but with no cap at all they're a bulk name-enumeration /
// invoice-number-probing vector. One shared bucket across all three
// endpoints; 240/15min leaves room for several vendors behind one office
// NAT filling the form simultaneously (the lookup re-fires per debounced
// keystroke pause) while still making bulk harvesting impractical.
const vendorReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});
app.use('/api/vendor/lookup', vendorReadLimiter);
app.use('/api/vendor/check-dup', vendorReadLimiter);
app.use('/api/vendor/check-similar', vendorReadLimiter);
app.use('/api/vendor/check-w9', vendorReadLimiter);
app.use('/api/vendor', vendorSubmitRoutes);
app.use('/api/invoices', invoicesRoutes);
app.use('/api/ndas', ndasRoutes);
app.use('/api/clearances', clearancesRoutes);
app.use('/api/label-waivers', labelWaiversRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/salary', salaryRoutes);
app.use('/api/artist-campaigns', artistCampaignsRoutes);
// Team message board. Membership-gated inside the router, not role-gated —
// /messages is on the BASE_WHITELIST so everyone can open the page, and which
// channels you belong to is what bounds you. See routes/chat.js.
//
// uploadLimiter applies to ATTACHMENT sends only, detected by content type.
// Mounting it on '/api/chat/channels' wholesale — the obvious reading — would
// put a 30-request/15-minute cap on reading messages and on typing them: that
// is thirty sentences in a quarter of an hour, which is one ordinary minute of
// conversation, and the eleventh message of a busy morning would fail. An
// app.post() middleware that falls through with next() keeps the cap on the
// thing that actually costs bandwidth.
app.post('/api/chat/channels/:id/messages', (req, res, next) => {
  const ct = String(req.headers['content-type'] || '');
  if (ct.startsWith('multipart/')) return uploadLimiter(req, res, next);
  return next();
});
app.use('/api/chat', require('./routes/chat'));
app.use('/api/email', require('./routes/email'));
app.use('/api/full-export', require('./routes/full-export'));

// Health check.
//
// Reports the DEPLOYED COMMIT, because "the site returns 200" does not mean a
// push went out: a failed Railway build leaves the previous version serving
// behind a perfectly green health check, and with no version in the response
// there is nothing to tell them apart. Every deploy is now verifiable in one
// unauthenticated request.
const BOOT_AT = new Date().toISOString();
const COMMIT = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.COMMIT_SHA || '').slice(0, 7) || null;

// Whether the deterministic statement parser can run on this host. pdfjs-dist
// needs the OPTIONAL @napi-rs/canvas native package even to read text; where a
// platform has no prebuild, statement parsing still works but silently falls
// back to the AI path — milliseconds becoming minutes, with nothing on the
// surface to show it. See "Statement PDF parsing" in CLAUDE.md.
let STATEMENT_FAST_PARSE;
try {
  require.resolve('@napi-rs/canvas');
  STATEMENT_FAST_PARSE = true;
} catch {
  STATEMENT_FAST_PARSE = false;
}

app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Server is running',
    commit: COMMIT,
    started_at: BOOT_AT,
    statement_fast_parse: STATEMENT_FAST_PARSE,
  });
});

// FX rates — daily ECB mid-market rates via frankfurter.app, cached
// in-memory for 12h. Public so any page that displays money can fetch
// once on mount and show USD equivalents next to foreign amounts.
const fxService = require('./services/fx');
app.get('/api/fx/rates', (req, res) => {
  res.json({ success: true, data: fxService.getCached() });
});

// Serve React frontend in production
if (process.env.NODE_ENV === 'production') {
  const clientBuildPath = path.join(__dirname, '../client/dist');
  app.use(express.static(clientBuildPath));

  // Link previews (iMessage / Slack / WhatsApp) fetch the URL without
  // running JS, so every route showed the generic "Admin Dashboard"
  // title. Serve /submit with its own title + OG tags so a shared
  // vendor-form link unfurls as the vendor form. Transformed HTML is
  // rebuilt lazily per deploy (index.html changes hash every build).
  let submitHtmlCache = null;
  app.get('/submit', (req, res, next) => {
    try {
      if (!submitHtmlCache) {
        const raw = require('fs').readFileSync(path.join(clientBuildPath, 'index.html'), 'utf8');
        submitHtmlCache = raw
          .replace(/<title>[^<]*<\/title>/, '<title>Market Street — Vendor Submit</title>')
          .replace('</head>', [
            '<meta property="og:title" content="Market Street — Vendor Submit" />',
            '<meta property="og:description" content="Submit your invoice to Market Street — takes about two minutes." />',
            '<meta property="og:url" content="https://marketst-production.up.railway.app/submit" />',
            '<meta name="description" content="Submit your invoice to Market Street — takes about two minutes." />',
            '</head>',
          ].join('\n    '));
      }
      res.type('html').send(submitHtmlCache);
    } catch {
      next(); // fall through to the generic index.html
    }
  });

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/health') return next();
    res.sendFile(path.join(clientBuildPath, 'index.html'));
  });
}

// Error handling middleware — sanitizes errors in production
const { errorSanitizerMiddleware } = require('./middleware/errorSanitizer');
app.use(errorSanitizerMiddleware);

// 404 handler for API routes
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

const pool = require('./db');
const bcrypt = require('bcryptjs');

// Runs on every deploy — upserts user accounts from env vars without touching release data.
// Change a password or add a user: update env vars, redeploy, done. No FORCE_RESEED needed.
const syncUsers = async () => {
  const allUsers = [
    { name: 'John', email: 'john@deanst.co', pwEnv: 'PW_JOHN', role: 'Superadmin', department: 'Operations', hierarchy_level: 1 },
  ];

  for (const u of allUsers) {
    const password = process.env[u.pwEnv];
    if (!password) {
      console.warn(`syncUsers: skipping ${u.name} — ${u.pwEnv} not set`);
      continue;
    }
    const hash = await bcrypt.hash(password, 10);
    // On conflict, only refresh password_hash — passwords are intentionally
    // env-var driven (rotate via Railway vars, redeploy). Role / name /
    // department / hierarchy_level used to be overwritten too, which meant
    // any role change made via the Settings UI or by a startup
    // migration got silently reverted on the next deploy. Those
    // fields are now UI-owned after the initial insert.
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role, department, hierarchy_level, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash`,
      [u.name, u.email, hash, u.role, u.department, u.hierarchy_level]
    );
  }
  console.log('User sync complete.');
};

// Deploy-time sanity check on the canonical invoice-number normalizer.
// Every duplicate-invoice gate in the app routes through this function —
// the vendor portal, internal Add Invoice, batch upload, the live
// check-dup endpoints, the Duplicates page detector, the Ledger flag
// banner. If anything in that function ever regresses (the regex breaks,
// someone removes the `#` from the alternation, etc.), the cases below
// catch it on every server start and log loud red errors to Railway. The
// process keeps running so we don't take the whole app down for a
// formatting regression, but the error is impossible to miss in logs.
(() => {
  const { normalizeInvoiceNum } = require('./lib/normalize-invoice-num');
  // Every common shape we've seen vendors / staff type, plus the exact
  // cases that motivated the gate (INV-11 ≡ 11, #123 ≡ 123, leading
  // zeros, mid-string whitespace, prefix combos).
  const cases = [
    ['11', '11'], ['INV-11', '11'], ['INV11', '11'], ['inv 11', '11'],
    ['#11', '11'], ['# 11', '11'], ['# 0011', '11'],
    ['#123457', '123457'], ['123457', '123457'],
    ['Invoice #123', '123'], ['Invoice 123', '123'], ['INV-#123', '123'],
    ['No. 123', '123'], ['no.123', '123'], ['No 123', '123'],
    ['  #123  ', '123'], ['00011', '11'], ['#00011', '11'],
    // Slash and underscore separators — real formats we've seen on
    // vendor invoices. Without these in the gate a vendor typing "01"
    // couldn't match a document printed "INV/01" or "INV_01".
    ['INV/01', '1'], ['INV_01', '1'], ['inv/01', '1'], ['inv_01', '1'],
    ['INV/#01', '1'], ['Invoice/123', '123'], ['no_123', '123'],
  ];
  const fails = [];
  for (const [input, expected] of cases) {
    const got = normalizeInvoiceNum(input);
    if (got !== expected) fails.push({ input, expected, got });
  }
  if (fails.length > 0) {
    console.error('[startup] normalizeInvoiceNum REGRESSION — dup gates will leak:');
    for (const f of fails) console.error('  ', JSON.stringify(f.input), '->', JSON.stringify(f.got), 'expected', JSON.stringify(f.expected));
  } else {
    console.log(`[startup] normalizeInvoiceNum verified across ${cases.length} cases (incl. #-prefix variants)`);
  }
})();

// Safe schema migrations — add new columns without wiping any data.
// Safe to run on every deploy.
const runMigrations = async () => {
  // Add assigned_to column
  await pool.query(`ALTER TABLE releases ADD COLUMN IF NOT EXISTS assigned_to INT REFERENCES users(id)`);
  await pool.query(`ALTER TABLE releases ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false`);

  // Artist archive — soft-archive an artist when their deal ends. Hides
  // them from the active roster grid; they reappear in the Archived
  // section at the bottom of the Roster page. Audit fields capture who
  // archived + when. Defaults match the releases pattern.
  //
  // Errors are LOGGED (not silently swallowed) — earlier the .catch(()=>{})
  // suppression hid an issue where the column didn't get added on Railway,
  // so the PATCH endpoint kept 500ing and the optimistic UI update kept
  // bouncing back. Logging surfaces those failures in the deploy logs.
  await pool.query(`ALTER TABLE artists ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false`)
    .catch(err => console.error('artists.archived migration failed:', err.message));
  await pool.query(`ALTER TABLE artists ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP`)
    .catch(err => console.error('artists.archived_at migration failed:', err.message));
  await pool.query(`ALTER TABLE artists ADD COLUMN IF NOT EXISTS archived_by INT REFERENCES users(id) ON DELETE SET NULL`)
    .catch(err => console.error('artists.archived_by migration failed:', err.message));

  // ── Signing an artist (2026-09-18) ──────────────────────────────────────
  // Terms and contact typed on the DEAL at Offer; signing copies them onto
  // the roster row and creates the advance as an approved invoice. The first
  // six deal columns already exist on every database that ran Boom's code
  // (they were added by hand there); listed here so a fresh database gets them.
  for (const col of [
    `priority VARCHAR(20) DEFAULT 'Medium'`, `deal_type VARCHAR(50)`, `last_contact_date DATE`,
    `next_followup_date DATE`, `spotify_monthly_listeners INTEGER`, `offer_amount NUMERIC(14,2)`,
    `advance NUMERIC(14,2)`, `royalty_split NUMERIC(6,2)`, `term_months INTEGER`, `territory TEXT`,
    `num_releases INTEGER`, `option_periods INTEGER`,
    `artist_email TEXT`, `artist_phone TEXT`, `manager_name TEXT`, `manager_email TEXT`,
    `socials JSONB`, `spotify_url TEXT`,
    `signed_artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL`, `signed_at TIMESTAMPTZ`,
    `advance_expense_id INTEGER`,
  ]) {
    await pool.query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS ${col}`)
      .catch(err => console.error(`deals.${col.split(' ')[0]} migration failed:`, err.message));
  }
  for (const col of [
    `email TEXT`, `phone TEXT`, `manager_name TEXT`, `manager_email TEXT`, `socials JSONB`, `spotify_url TEXT`,
    `signed_at TIMESTAMPTZ`, `onboarded_at TIMESTAMPTZ`, `signed_deal_id INTEGER`,
  ]) {
    await pool.query(`ALTER TABLE artists ADD COLUMN IF NOT EXISTS ${col}`)
      .catch(err => console.error(`artists.${col.split(' ')[0]} migration failed:`, err.message));
  }
  // A manual calendar event may point at a page (the "signed" marker → the profile).
  await pool.query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS link TEXT`)
    .catch(err => console.error('calendar_events.link migration failed:', err.message));
  // Sanity check — verify the column actually exists post-migration so a
  // future deploy log makes it obvious when something silently regressed.
  {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'artists' AND column_name = 'archived'`
    ).catch(() => ({ rows: [] }));
    if (rows.length === 0) {
      console.error('[migration] artists.archived COLUMN STILL MISSING after ALTER — archive feature will not work.');
    } else {
      console.log('[migration] artists.archived column present');
    }
  }

  // SQL helper used by every server-side query that groups / filters /
  // joins by artist name. Mirrors the client `normalizeArtistKey` in
  // utils.js — lowercase + strip non-alphanumerics so common spelling
  // variants ("LIFE/LINE", "LIFELINE", "Life Line") collapse to the same
  // bucket. IMMUTABLE so Postgres can use it in functional indexes if we
  // ever need to.
  await pool.query(`
    CREATE OR REPLACE FUNCTION normalize_artist_key(s TEXT) RETURNS TEXT AS $$
      SELECT LOWER(REGEXP_REPLACE(COALESCE(s, ''), '[^a-zA-Z0-9]', '', 'g'));
    $$ LANGUAGE SQL IMMUTABLE;
  `).catch(err => console.error('normalize_artist_key function failed:', err.message));

  // DB-level invariant: a Paid row CANNOT carry a RUSH badge.
  //
  // Earlier passes added rush-clearing to every paid-flip path I could
  // find (PUT /payments/:id + cascade, PUT /entries/:id, proof upload
  // sync + AI scan, installment aggregation), and that's still the
  // ideal place — clears it cleanly with explicit intent. But a path I
  // missed (or a future path someone adds) can silently violate the
  // invariant. This trigger is the belt-and-suspenders catch: every
  // INSERT or UPDATE on expenses, if the row would land as Paid + Rush,
  // the trigger strips the rush state before the write commits.
  //
  // Cheap (single conditional on every write), idempotent, and impossible
  // to bypass from app code. CREATE OR REPLACE means it self-heals if
  // someone drops it manually.
  //
  // Each statement runs in its OWN pool.query() so node-postgres'
  // simple-vs-extended protocol quirks can't silently drop the second
  // statement. Previous version concatenated DROP+CREATE in one query
  // string, which produced inconsistent behavior — splitting the calls
  // guarantees both ran.
  await pool.query(`
    CREATE OR REPLACE FUNCTION clear_rush_on_paid() RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.payment_status = 'Paid' THEN
        IF NEW.rush_requested IS TRUE THEN
          NEW.rush_requested := FALSE;
          NEW.rush_requested_at := NULL;
          NEW.rush_requested_by := NULL;
          NEW.rush_reason := NULL;
        END IF;
        IF NEW.on_hold IS TRUE THEN
          NEW.on_hold := FALSE;
          NEW.hold_at := NULL;
          NEW.hold_by := NULL;
          NEW.hold_reason := NULL;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `).catch(err => console.error('clear_rush_on_paid function failed:', err.message));
  await pool.query(`DROP TRIGGER IF EXISTS expenses_clear_rush_on_paid ON expenses`)
    .catch(err => console.error('drop expenses_clear_rush_on_paid trigger failed:', err.message));
  await pool.query(`
    CREATE TRIGGER expenses_clear_rush_on_paid
      BEFORE INSERT OR UPDATE ON expenses
      FOR EACH ROW
      EXECUTE FUNCTION clear_rush_on_paid()
  `).catch(err => console.error('create expenses_clear_rush_on_paid trigger failed:', err.message));
  // Verify the trigger actually got installed so a silent CREATE failure
  // is impossible to miss in deploy logs. Without this, a regression
  // (e.g., function signature change, name typo) would deploy clean but
  // leave the invariant unenforced.
  {
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_trigger WHERE tgname = 'expenses_clear_rush_on_paid' AND NOT tgisinternal`
    ).catch(() => ({ rows: [] }));
    if (rows.length === 0) {
      console.error('[migration] expenses_clear_rush_on_paid TRIGGER MISSING — Paid+Rush rows can still slip through.');
    } else {
      console.log('[migration] expenses_clear_rush_on_paid trigger present');
    }
  }

  // Backfill any historical rows still in the invalid state. Two pieces
  // of telemetry around it: (1) count remaining stale rows BEFORE the
  // sweep, (2) count again AFTER. If the second number is non-zero, the
  // trigger isn't working and the migration log makes that obvious.
  {
    const { rows: pre } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM expenses WHERE payment_status = 'Paid' AND rush_requested = TRUE`
    ).catch(() => ({ rows: [{ n: 0 }] }));
    const stalePre = pre[0]?.n || 0;
    if (stalePre > 0) console.log(`[migration] found ${stalePre} stale Paid+Rush row(s) — clearing…`);

    const upd = await pool.query(
      `UPDATE expenses
          SET rush_requested = FALSE,
              rush_requested_at = NULL,
              rush_requested_by = NULL,
              rush_reason = NULL
        WHERE payment_status = 'Paid'
          AND rush_requested = TRUE`
    ).catch(err => { console.error('rush-on-paid backfill failed:', err.message); return null; });
    if (upd && upd.rowCount > 0) console.log(`[migration] cleared rush state on ${upd.rowCount} paid row(s)`);

    // Re-check: if anything remains, either the UPDATE didn't apply or
    // some other process is racing to re-set the state. Either way the
    // operator should know.
    const { rows: post } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM expenses WHERE payment_status = 'Paid' AND rush_requested = TRUE`
    ).catch(() => ({ rows: [{ n: 0 }] }));
    const stalePost = post[0]?.n || 0;
    if (stalePost > 0) {
      console.error(`[migration] ${stalePost} Paid+Rush row(s) STILL PRESENT after backfill — trigger probably not enforcing.`);
    }
  }

  // Same backfill for Paid+Hold rows. Hold columns may not exist yet on
  // very old DBs — the ALTER TABLE ADD COLUMN IF NOT EXISTS statements
  // further below add them, but this migration block runs BEFORE those
  // ALTERs. Wrap in a to_regclass-guarded existence check so first-time
  // migrations don't error out.
  {
    const hasHold = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'expenses' AND column_name = 'on_hold'`
    ).catch(() => ({ rows: [] }));
    if (hasHold.rows.length > 0) {
      const { rows: pre } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM expenses WHERE payment_status = 'Paid' AND on_hold = TRUE`
      ).catch(() => ({ rows: [{ n: 0 }] }));
      const stalePre = pre[0]?.n || 0;
      if (stalePre > 0) console.log(`[migration] found ${stalePre} stale Paid+Hold row(s) — clearing…`);

      const upd = await pool.query(
        `UPDATE expenses
            SET on_hold    = FALSE,
                hold_at    = NULL,
                hold_by    = NULL,
                hold_reason = NULL
          WHERE payment_status = 'Paid'
            AND on_hold = TRUE`
      ).catch(err => { console.error('hold-on-paid backfill failed:', err.message); return null; });
      if (upd && upd.rowCount > 0) console.log(`[migration] cleared hold state on ${upd.rowCount} paid row(s)`);
    }
  }

  // Tasks: category, notes, release_id, progress columns
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS category VARCHAR(50)`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS notes TEXT`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS release_id INT REFERENCES releases(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress INT DEFAULT 0`);

  // Meta table for tracking one-time migrations
  await pool.query(`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)`);

  // One-time cleanup: the old searchArtworkUrl fell back to Spotify's first
  // search result when the artist+title didn't match, so any release without
  // a spotify_uri could have ended up with an unrelated cover. Clear those so
  // the next artwork sync re-evaluates them with the strict matcher.
  try {
    const flag = await pool.query("SELECT value FROM _meta WHERE key = 'artwork_search_cleanup_v1'");
    if (flag.rows.length === 0) {
      const { rowCount } = await pool.query(`
        UPDATE releases
        SET cover_art_url = NULL
        WHERE (spotify_uri IS NULL OR spotify_uri = '')
          AND cover_art_url IS NOT NULL
          AND cover_art_url != ''
          AND cover_art_url != 'not_found'
      `);
      await pool.query("INSERT INTO _meta (key, value) VALUES ('artwork_search_cleanup_v1', 'done')");
      if (rowCount > 0) console.log(`[migration] cleared ${rowCount} potentially-wrong cover_art_url values`);
    }
  } catch (err) {
    console.warn('artwork_search_cleanup_v1 migration:', err.message);
  }

  // Expenses: AI invoice scan results
  // These ALTERs run ~750 lines BEFORE the CREATE TABLE that defines
  // `expenses`. On an existing database that's harmless, but on a FRESH one
  // they threw, the single try/catch around runMigrations() swallowed it,
  // and EVERY table defined after this point was never created — the app
  // could not stand up a new environment at all (no expenses, no boom_reps,
  // no bk_categories...). Caught, migrations continue to the CREATE, and
  // these idempotent ALTERs apply on the next boot.
await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS ai_scan JSONB`).catch((e) => console.warn('[migration] deferred (expenses not created yet):', e.message));

  // Expenses: vendor-supplied social handles (array of {platform, handle})
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS social_handles JSONB`).catch((e) => console.warn('[migration] deferred (expenses not created yet):', e.message));

  // Expenses: recoupment grouping label — free-form user-provided string that
  // ties multiple expenses together as a single "batch" the user uploaded
  // for recoupment (e.g. "Digital Marketing — Song X"). Powers the Recoupments
  // page's bulk-label workflow + label filter. Nullable; no FK / no batches
  // table — labels are just strings shared by convention.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS recoupment_label TEXT`).catch((e) => console.warn('[migration] deferred (expenses not created yet):', e.message));

  // Flag dismissals — lets admins suppress a specific (entry_id, flag_kind)
  // tuple from the Artist Issues section so resolved / false-positive items
  // don't keep coming back on rescans.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flag_dismissals (
      entry_id      INT NOT NULL,
      flag_kind     VARCHAR(64) NOT NULL,
      dismissed_by  INT REFERENCES users(id),
      dismissed_at  TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (entry_id, flag_kind)
    )
  `);

  // Group-level flag dismissals — for flag categories that surface
  // groups (duplicate releases / artists / vendors) rather than per-row
  // entries. group_key is a stable string derived from the sorted
  // contents of the group (e.g. sorted release IDs joined with comma,
  // or sorted normalized vendor names joined with '|'); the same group
  // will hash to the same key across re-detections.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flag_group_dismissals (
      flag_kind     VARCHAR(64) NOT NULL,
      group_key     TEXT NOT NULL,
      dismissed_by  INT REFERENCES users(id),
      dismissed_at  TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (flag_kind, group_key)
    )
  `);

  // Admin docs vault — legal, NDAs, compliance, HR, IP, policies, templates
  // Files live in entity_files keyed on entity_type='admin_document'.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_documents (
      id              SERIAL PRIMARY KEY,
      title           VARCHAR(255) NOT NULL,
      category        VARCHAR(64),
      counterparty    VARCHAR(255),
      status          VARCHAR(32)  DEFAULT 'Active',
      confidentiality VARCHAR(32)  DEFAULT 'Internal',
      date_signed     DATE,
      expiration_date DATE,
      tags            JSONB DEFAULT '[]'::jsonb,
      notes           TEXT,
      is_template     BOOLEAN DEFAULT FALSE,
      created_by      INT REFERENCES users(id),
      created_at      TIMESTAMP DEFAULT NOW(),
      updated_at      TIMESTAMP DEFAULT NOW()
    )
  `);
  // Allow uncategorized admin docs (added later to support quick-upload flow).
  await pool.query(`ALTER TABLE admin_documents ALTER COLUMN category DROP NOT NULL`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_docs_category ON admin_documents(category)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_docs_expiration ON admin_documents(expiration_date)`);

  // Expenses: link to releases
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS release_id INT REFERENCES releases(id) ON DELETE SET NULL`).catch((e) => console.warn('[migration] deferred (expenses not created yet):', e.message));

  // Auto-match expenses to releases by artist name + song/project_name
  await pool.query(`
    UPDATE expenses e
    SET release_id = r.id
    FROM releases r
    JOIN artists a ON r.artist_id = a.id
    WHERE e.release_id IS NULL
      AND e.song IS NOT NULL AND e.song != ''
      AND LOWER(TRIM(a.name)) = LOWER(TRIM(e.artist))
      AND LOWER(TRIM(r.project_name)) = LOWER(TRIM(e.song))
      AND e.status = 'approved'
      AND (e.deleted = false OR e.deleted IS NULL)
  `).catch(err => console.warn('Auto-match expenses to releases:', err.message));

  // Auto-split entries with comma-separated songs (one-time migration)
  try {
    const { rows: multiSong } = await pool.query(`
      SELECT e.id, e.song, e.artist, e.amount, e.invoice_date, e.payee, e.description,
             e.category, e.currency, e.payment_method, e.status, e.approved_by, e.approved_at,
             e.cobrand, e.is_reimbursement, e.boom_rep, e.vendor_email, e.vendor_name,
             e.vendor_bank, e.payment_status, e.payment_date, e.paid_by, e.payment_terms,
             e.invoice_number, e.created_by
      FROM expenses e
      WHERE e.song LIKE '%,%'
        AND e.parent_id IS NULL
        AND e.status = 'approved'
        AND (e.deleted = false OR e.deleted IS NULL)
        AND NOT EXISTS (SELECT 1 FROM expenses c WHERE c.parent_id = e.id AND (c.deleted = false OR c.deleted IS NULL))
    `);
    for (const entry of multiSong) {
      const songs = entry.song.split(',').map(s => s.trim()).filter(Boolean);
      if (songs.length < 2) continue;
      const total = parseFloat(entry.amount);
      const perSong = Math.round((total / songs.length) * 100) / 100;
      const remainder = Math.round((total - perSong * songs.length) * 100) / 100;

      await pool.query('UPDATE expenses SET song = $1, amount = $2, artist_breakdown = $3 WHERE id = $4', [
        songs[0], perSong + remainder,
        JSON.stringify(songs.map((s, i) => ({ artist: entry.artist || '', song: s, amount: i === 0 ? perSong + remainder : perSong }))),
        entry.id
      ]);

      for (let i = 1; i < songs.length; i++) {
        await pool.query(`
          INSERT INTO expenses
            (invoice_date, payee, description, category, artist, song, amount,
             currency, payment_method, status, approved_by, approved_at,
             parent_id, cobrand, is_reimbursement, boom_rep, created_by,
             vendor_email, vendor_name, vendor_bank, payment_status, payment_date,
             paid_by, payment_terms, invoice_number)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
        `, [entry.invoice_date, entry.payee, entry.description, entry.category,
            entry.artist, songs[i], perSong,
            entry.currency, entry.payment_method, entry.status,
            entry.approved_by, entry.approved_at,
            entry.id, entry.cobrand, entry.is_reimbursement, entry.boom_rep,
            entry.created_by || 'system',
            entry.vendor_email, entry.vendor_name, entry.vendor_bank,
            entry.payment_status, entry.payment_date, entry.paid_by,
            entry.payment_terms, entry.invoice_number]);
      }
    }
    if (multiSong.length) console.log(`Auto-split ${multiSong.length} entries with multiple songs`);
  } catch (err) { console.warn('Auto-split multi-song entries:', err.message); }

  // ── Artist spend sheets: the budget half ────────────────────────────────────
  //
  // John, 2026-08-24: "artist spend / budget sheets — organized expense sheets per
  // artist matched against a created budget."
  //
  // SIX ROWS PER ARTIST, MAXIMUM. One per category section (the `ui_group` keys:
  // campaign / record / artist / people / label / other), and that is the entire
  // budget. Actuals land against them automatically by the expense's own category.
  //
  // The smallness is the design, not a shortcut. Budgets have been attempted three
  // times here and every attempt died at the same place: all 7 `recording_budgets`
  // are `draft` with ZERO line items — five created within 40 minutes of each
  // other — and `artist_budget_items` holds 1 row across the twelve
  // biggest-spending artists. Somebody entered an advance and stopped before
  // writing a single line. So there is no line-item step to abandon: six numbers,
  // edited in place on the sheet, is a budget.
  //
  // KEYED ON artistBucketKey(), never a raw name. Every earlier budget surface
  // matched `LOWER(TRIM(e.artist))`, which makes "Jerri" and "jerri " two artists
  // here while they are one everywhere else, and lets a placeholder like "N/A"
  // open its own sheet. See lib/artist-key.js — same key the P&L rollup uses.
  //
  // No period column, deliberately (John: "per artist, not per period"). An
  // advance invoiced in July sits on the same sheet as the tranche paid in
  // January, which is the point: the sheet is the artist's whole picture.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS artist_budget_sections (
      artist_key  TEXT NOT NULL,
      section     TEXT NOT NULL,
      amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
      currency    TEXT NOT NULL DEFAULT 'USD',
      note        TEXT,
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (artist_key, section)
    )
  `).catch(err => console.error('artist_budget_sections CREATE TABLE failed:', err.message));
  // The display name is NOT stored here. `artist_key` is the identity and the
  // label comes from the most-used spelling on the artist's own rows, the rule
  // shapeByArtist and Recoupments already follow — storing a name would freeze
  // whichever spelling happened to be current when the budget was typed.

  // The same budget, sliced the OTHER way: a number per RELEASE.
  //
  // John, 2026-09-15: "the budgets should be artist based but also release
  // based. take a look back at the original excel as reference." The original
  // is `Copy of Boom.Records.xlsx`, and both of its budget models are
  // release-shaped — the visible `Expenses` tab is one three-column block per
  // release (Artist - Song | Expense Notes | Who Paid, total at row 17), and the
  // hidden `Accounting` tab is literally
  //
  //     Artist | Project | Release Date | Planned Marketing | Amount Spent |
  //     Where allocated | Amount remaining | Amount Recouped
  //
  // which is this app's Budget / Spent / Variance columns with RELEASE as the
  // row. Artist-level category budgets are this app's invention; per-release
  // planning is what the label has always actually done.
  //
  // A SEPARATE TABLE, not a column on artist_budget_categories, because these
  // are two different PARTITIONS of one artist's money and neither is a
  // subdivision of the other. They can disagree about the artist's total, and
  // the sheet reports that difference rather than picking a winner quietly.
  //
  // Measured before building, on 3,582 live ledger rows: 1,595 name an artist
  // and only 695 name a release — so 56% of an artist's spend has no release to
  // sit under. The sheet carries an explicit "no release named" row for it,
  // which is read-only: it is a residual, not somewhere to plan.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS artist_budget_releases (
      artist_key  TEXT NOT NULL,
      release_id  INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
      amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
      currency    TEXT NOT NULL DEFAULT 'USD',
      note        TEXT,
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (artist_key, release_id)
    )
  `).catch(err => console.error('artist_budget_releases CREATE TABLE failed:', err.message));

  // The same budget, one level finer: a number per CATEGORY.
  //
  // John, 2026-09-15: the sheet should read like a spreadsheet, and the budget
  // should be typed on the category rows — "the section total is the sum of its
  // children and stops being typed directly".
  //
  // A new table rather than a `category` column on the one above, because the
  // two grains are not the same row: `artist_budget_sections` is keyed
  // (artist_key, section) and a nullable category would make its primary key a
  // lie. Measured before writing this: `artist_budget_sections` holds ZERO rows
  // across all 156 artists, so nothing has to be migrated into it — the section
  // figure is now derived, and any legacy section row that appears is added on
  // top and labelled rather than silently absorbed.
  //
  // Keyed on the category NAME, matching `expenses.category`, which is also
  // text. Writes validate against `bk_categories` and store that table's
  // spelling, so the key is the vocabulary's canonical name and never whatever
  // case the client sent.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS artist_budget_categories (
      artist_key  TEXT NOT NULL,
      category    TEXT NOT NULL,
      amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
      currency    TEXT NOT NULL DEFAULT 'USD',
      note        TEXT,
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (artist_key, category)
    )
  `).catch(err => console.error('artist_budget_categories CREATE TABLE failed:', err.message));

  // Financials: per-artist budgets
  await pool.query(`
    CREATE TABLE IF NOT EXISTS artist_budgets (
      id SERIAL PRIMARY KEY,
      artist_id INT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
      amount DECIMAL(12,2) DEFAULT 0,
      notes TEXT,
      updated_at TIMESTAMP DEFAULT NOW(),
      updated_by INT REFERENCES users(id),
      UNIQUE(artist_id)
    )
  `);

  // Artist budget page — user-editable budget line items. Renders alongside
  // ledger rows (from expenses) on the per-artist Budget tab. Optional
  // release_id ties a line to a specific project; section is a freeform label
  // that pre-fills from releases.project_name when release_id is set.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS artist_budget_items (
      id SERIAL PRIMARY KEY,
      artist_id INT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
      release_id INT REFERENCES releases(id) ON DELETE SET NULL,
      section TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL,
      amount NUMERIC(12,2),
      currency TEXT DEFAULT 'USD',
      date DATE,
      notes TEXT,
      paid BOOLEAN DEFAULT FALSE,
      recoupable BOOLEAN DEFAULT TRUE,
      ufr BOOLEAN DEFAULT FALSE,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_artist_budget_items_artist ON artist_budget_items(artist_id)`);

  // Financials: manual expenses added directly in the dashboard
  await pool.query(`
    CREATE TABLE IF NOT EXISTS manual_expenses (
      id SERIAL PRIMARY KEY,
      artist_id INT REFERENCES artists(id) ON DELETE SET NULL,
      artist_name VARCHAR(255),
      description TEXT NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      category VARCHAR(100),
      expense_date DATE DEFAULT CURRENT_DATE,
      created_by INT REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE manual_expenses ADD COLUMN IF NOT EXISTS song VARCHAR(255)`);
  await pool.query(`ALTER TABLE manual_expenses ADD COLUMN IF NOT EXISTS recoupable BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE manual_expenses ADD COLUMN IF NOT EXISTS release_id INT REFERENCES releases(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE artist_budgets ADD COLUMN IF NOT EXISTS advance DECIMAL(12,2) DEFAULT 0`);

  // Financials: per-release budgets
  await pool.query(`
    CREATE TABLE IF NOT EXISTS release_budgets (
      id SERIAL PRIMARY KEY,
      release_id INT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
      amount DECIMAL(12,2) DEFAULT 0,
      notes TEXT,
      updated_at TIMESTAMP DEFAULT NOW(),
      updated_by INT REFERENCES users(id),
      UNIQUE(release_id)
    )
  `);

  // Contracts: financial obligations (recording fund, marketing fund, etc.)
  await pool.query(`ALTER TABLE contracts ADD COLUMN IF NOT EXISTS financial_terms JSONB DEFAULT '[]'`);

  // Financials: income / revenue tracking per artist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS artist_income (
      id SERIAL PRIMARY KEY,
      artist_id INT REFERENCES artists(id) ON DELETE SET NULL,
      artist_name VARCHAR(255),
      description VARCHAR(500) NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      income_type VARCHAR(100),
      income_date DATE,
      release_id INT REFERENCES releases(id) ON DELETE SET NULL,
      notes TEXT,
      created_by INT REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Calendar: manual events
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      event_date DATE NOT NULL,
      event_type VARCHAR(50) DEFAULT 'manual',
      description TEXT,
      color VARCHAR(20),
      created_by INT REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // DSP submission tracker
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dsp_submissions (
      id SERIAL PRIMARY KEY,
      release_id INT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
      dsp_name VARCHAR(100) NOT NULL,
      status VARCHAR(50) DEFAULT 'Not Submitted',
      submitted_date DATE,
      live_date DATE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(release_id, dsp_name)
    )
  `);

  // Normalize release_type: collapse typos and casing variants to canonical values
  await pool.query(`
    UPDATE releases SET release_type = 'Single'
    WHERE LOWER(TRIM(release_type)) IN ('single', 'singles', 'singel', 'singke', 'singe', 'singl')
      AND release_type != 'Single'
  `);
  await pool.query(`
    UPDATE releases SET release_type = 'EP'
    WHERE LOWER(TRIM(release_type)) = 'ep' AND release_type != 'EP'
  `);
  await pool.query(`
    UPDATE releases SET release_type = 'Album'
    WHERE LOWER(TRIM(release_type)) IN ('album', 'lp') AND release_type != 'Album'
  `);
  await pool.query(`
    UPDATE releases SET release_type = 'Compilation'
    WHERE LOWER(TRIM(release_type)) IN ('compilation', 'comp') AND release_type != 'Compilation'
  `);

  // Normalize genre: apply consistent Title Case to collapse duplicates like
  // "hip-hop" / "Hip-Hop" / "HIP-HOP" and "r&b" / "R&B" etc.
  // Preserve known acronyms/special cases
  await pool.query(`
    UPDATE releases SET genre = CASE
      WHEN LOWER(TRIM(genre)) IN ('r&b', 'rnb', 'r and b', 'r & b') THEN 'R&B'
      WHEN LOWER(TRIM(genre)) IN ('edm', 'electronic dance music') THEN 'EDM'
      WHEN LOWER(TRIM(genre)) IN ('hip-hop', 'hip hop', 'hiphop', 'hip hop/rap') THEN 'Hip-Hop'
      WHEN LOWER(TRIM(genre)) IN ('hip-hop/rap') THEN 'Hip-Hop/Rap'
      WHEN LOWER(TRIM(genre)) IN ('alt', 'alternative') THEN 'Alt'
      ELSE INITCAP(LOWER(TRIM(genre)))
    END
    WHERE genre IS NOT NULL AND genre != ''
      AND genre != CASE
        WHEN LOWER(TRIM(genre)) IN ('r&b', 'rnb', 'r and b', 'r & b') THEN 'R&B'
        WHEN LOWER(TRIM(genre)) IN ('edm', 'electronic dance music') THEN 'EDM'
        WHEN LOWER(TRIM(genre)) IN ('hip-hop', 'hip hop', 'hiphop', 'hip hop/rap') THEN 'Hip-Hop'
        WHEN LOWER(TRIM(genre)) IN ('hip-hop/rap') THEN 'Hip-Hop/Rap'
        WHEN LOWER(TRIM(genre)) IN ('alt', 'alternative') THEN 'Alt'
        ELSE INITCAP(LOWER(TRIM(genre)))
      END
  `);

  // Release budget line items — categorized spend per release
  await pool.query(`
    CREATE TABLE IF NOT EXISTS release_budget_line_items (
      id SERIAL PRIMARY KEY,
      release_id INT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
      category VARCHAR(100) NOT NULL,
      description TEXT,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      notes TEXT,
      created_by INT REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Recording budgets — new feature modeled directly after the label's
  // "Recording Budget (Budget)" and "Recording Budget (Fund)" Excel
  // templates. `type='budget'` means Total Recording Budget + separate
  // advances. `type='fund'` means a Total Recording Fund pool that
  // advances are deducted from. Section-level line items live in
  // recording_budget_line_items below.
  //
  // artist_id and release_id are BOTH nullable so a budget can be
  // drafted before an artist is signed / a release is created; the
  // freeform artist_name + project_title fields cover that case.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recording_budgets (
      id SERIAL PRIMARY KEY,
      artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
      release_id INTEGER REFERENCES releases(id) ON DELETE SET NULL,
      artist_name TEXT,
      project_title TEXT,
      type TEXT NOT NULL DEFAULT 'budget' CHECK (type IN ('budget', 'fund')),
      currency TEXT NOT NULL DEFAULT 'USD',
      advance_amount NUMERIC(14, 2) DEFAULT 0,
      fund_amount NUMERIC(14, 2) DEFAULT 0,
      proposed_tracks INTEGER,
      contingency_pct NUMERIC(6, 3) DEFAULT 7.5,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'locked')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMP DEFAULT NOW(),
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_at TIMESTAMP,
      locked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      locked_at TIMESTAMP
    )
  `).catch(err => console.error('recording_budgets CREATE TABLE failed:', err.message));

  // Recording budget line items — grouped by section (producers /
  // studio / mixing_mastering / musicians / travel / other) so the
  // client can render each section as its own table exactly like the
  // Excel template. `amount = qty * unit_price` is stored (not
  // computed) so historical entries survive schema/precision drift.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recording_budget_line_items (
      id SERIAL PRIMARY KEY,
      budget_id INTEGER NOT NULL REFERENCES recording_budgets(id) ON DELETE CASCADE,
      section TEXT NOT NULL CHECK (section IN ('producers','studio','mixing_mastering','musicians','travel','other')),
      description TEXT NOT NULL DEFAULT '',
      qty NUMERIC(10, 2) DEFAULT 1,
      unit_price NUMERIC(14, 2) DEFAULT 0,
      amount NUMERIC(14, 2) DEFAULT 0,
      notes TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(err => console.error('recording_budget_line_items CREATE TABLE failed:', err.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rec_budget_line_items_budget ON recording_budget_line_items(budget_id)`).catch(() => {});

  // ── Release spend plans: the marketing sheet, transferred ───────────────────
  //
  // John, 2026-09-03: "the attached excel is how we currently track artist
  // budgets. I want to transfer this over to our app."
  //
  // The sheet is 1,373 releases side by side, 7,083 expense lines, $4,952,054.13.
  // See `lib/spendPlan.js` for its shape and for what it can and cannot tell us.
  //
  // A FOURTH budget model, deliberately, and John chose it knowing that — the
  // other three are `recording_budgets` (7 drafts, 0 line items),
  // `artist_budget_items` (1 row) and the live `artist_budget_sections`. The
  // reason this one is separate rather than folded into `recording_budgets`:
  // that table's line items carry `CHECK (section IN ('producers','studio',
  // 'mixing_mastering','musicians','travel','other'))`, a RECORDING vocabulary,
  // and this sheet is marketing — marquee, showcase, masked mortal, youtube ads,
  // fb ads, PR. All 4,435 lines in its top ten channels would have landed in
  // `other`, which is the one column worth importing flattened to nothing.
  //
  // ── This is a COMMITMENT record, not a second ledger ──
  // 111 (artist, song) pairs exist in both this sheet and `expenses`, and none
  // of the 111 agrees. Nothing here writes to `expenses`, and actuals are never
  // copied in — `release_id` is the join, and the ledger stays the only record
  // of money that actually moved.
  //
  // `source_column` is the block's identity because the sheet has no id of its
  // own and 1,347 of its headers are the only name a block has. That makes a
  // re-import idempotent for a sheet whose columns have not MOVED; if blocks are
  // ever re-arranged, clear the table and re-import rather than merging.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS release_spend_plans (
      id             SERIAL PRIMARY KEY,
      release_id     INTEGER REFERENCES releases(id) ON DELETE SET NULL,
      source_header  TEXT NOT NULL,
      source_column  TEXT NOT NULL,
      parsed_left    TEXT,
      parsed_right   TEXT,
      match_status   TEXT NOT NULL DEFAULT 'unmatched'
                     CHECK (match_status IN ('matched','ambiguous','duplicate_release','unmatched','skipped')),
      match_order    TEXT,
      matched_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      matched_at     TIMESTAMPTZ,
      suggestions    JSONB NOT NULL DEFAULT '[]'::jsonb,
      sheet_total    NUMERIC(14,2),
      total_source   TEXT,
      imported_at    TIMESTAMPTZ DEFAULT NOW(),
      imported_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE (source_column)
    )
  `).catch(err => console.error('release_spend_plans CREATE TABLE failed:', err.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_release_spend_plans_release ON release_spend_plans(release_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_release_spend_plans_status ON release_spend_plans(match_status)`).catch(() => {});

  // One row per line on the sheet. `amount` is NULL where the operator typed
  // prose into the money column ("625 advance", "FREE") — 49 such cells — and
  // `amount_raw` keeps what they wrote, because "625 advance" is PROBABLY $625
  // and probably is not good enough to feed a total.
  //
  // `status` is the mapped payment state and is NULLABLE on purpose: unknown is
  // a third state, not a missing value. `status_raw` keeps the original cell so
  // a mapping decision can be revisited without re-reading the workbook.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS release_spend_plan_lines (
      id          SERIAL PRIMARY KEY,
      plan_id     INTEGER NOT NULL REFERENCES release_spend_plans(id) ON DELETE CASCADE,
      source_row  INTEGER NOT NULL,
      amount      NUMERIC(14,2),
      amount_raw  TEXT,
      note        TEXT,
      status      TEXT CHECK (status IN ('paid','not_yet')),
      status_raw  TEXT,
      UNIQUE (plan_id, source_row)
    )
  `).catch(err => console.error('release_spend_plan_lines CREATE TABLE failed:', err.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_release_spend_plan_lines_plan ON release_spend_plan_lines(plan_id)`).catch(() => {});

  // Expense → budget-section override. When "Costs to Date" auto-
  // maps a ledger category to a budget section (Recording → studio,
  // Production → producers, etc.), the user can override that
  // mapping on a per-expense basis. NULL means "use the default
  // mapping". Only meaningful when the expense's artist matches an
  // active budget's artist; otherwise ignored.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS budget_section_override TEXT`).catch(() => {});

  // Per-expense "flag for review" — mirrors the artist_meta and
  // song_campaign_status flag columns so the label has a consistent
  // "needs a second look" surface at every layer (artist / song / row).
  // Nullable + defaults so existing rows are implicitly unflagged.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS flagged BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS flagged_by INTEGER REFERENCES users(id) ON DELETE SET NULL`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS flag_reason TEXT`).catch(() => {});

  // Off-roster marker: set true when a vendor submits an expense against
  // an artist that isn't in the artists table. Surfaces as an amber chip
  // on Approvals so an admin can either add the artist to the roster or
  // reject the submission — silent acceptance was the risk we wanted to
  // avoid when opening up the vendor-submit picker.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS off_roster_artist BOOLEAN DEFAULT FALSE`).catch(() => {});

  // Per-item "checked" marker for the Artist Campaigns page. Operators
  // work through a song's spend row-by-row (verify socials, confirm
  // amount, etc.) and want a way to tick each item as reviewed
  // independent of the song-level "finished" flag on
  // song_campaign_status.finished. Kept as a plain boolean + audit
  // fields; the group header rolls this up as "N of M done".
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS item_finished BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS item_finished_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS item_finished_by INTEGER REFERENCES users(id) ON DELETE SET NULL`).catch(() => {});

  // Origin tag: which page created this row. Kept nullable so existing
  // rows stay untagged (the ledger falls back to Admin/Vendor for those).
  // Set explicitly by clients that call POST /bk/entries from a non-
  // vanilla context — currently Recoupments and Artist Campaigns — so
  // the ledger can distinguish them visually without inferring intent
  // from side-effect flags like recoupable / artist_campaign.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS entry_source TEXT`).catch(() => {});
  // Creator payments (/bk/creators) are paid by PayPal to a handle, not by wire
  // to a bank account, so vendor_bank has nowhere to put this. The other fields
  // a creator needs — vendor_email, social_handles, artist, song — already exist.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS paypal_handle TEXT`).catch(() => {});

  // Consolidation additions (v2). Give the new recording_budgets
  // schema enough surface area to absorb rows from the older
  // artist_budgets / release_budgets / release_budget_line_items
  // tables without losing data:
  //   • notes            — freeform text, mirrors old `notes` col
  //   • total_amount_override — for legacy artist_budgets rows that
  //     stored a flat amount without line items. When set, /budgets
  //     rollups use this instead of the line-item sum.
  //   • line-item category — the old release_budget_line_items table
  //     had a freeform category column (Recording, Marketing, PR,
  //     etc.) that doesn't map to the 6-enum sections cleanly. We
  //     preserve it verbatim on migration; the client can display it
  //     alongside the section.
  await pool.query(`ALTER TABLE recording_budgets ADD COLUMN IF NOT EXISTS notes TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE recording_budgets ADD COLUMN IF NOT EXISTS total_amount_override NUMERIC(14, 2)`).catch(() => {});
  await pool.query(`ALTER TABLE recording_budget_line_items ADD COLUMN IF NOT EXISTS category TEXT`).catch(() => {});

  // NB: the one-shot consolidation of artist_budgets / release_
  // budgets / release_budget_line_items into these new tables lives
  // further down the boot sequence, near the other guarded migrations
  // (grep 'consolidate_budgets_v1') — it depends on the app_migrations
  // table which is created later in this file.

  // Pending contracts pipeline
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_contracts (
      id SERIAL PRIMARY KEY,
      artist_name VARCHAR(255) NOT NULL,
      legal_name TEXT,
      address TEXT,
      cash TEXT,
      split VARCHAR(150),
      years VARCHAR(150),
      options TEXT,
      back_signs TEXT,
      futures TEXT,
      status VARCHAR(50) DEFAULT 'Not Sent',
      email TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Seed pending contracts if table is empty
  const pcCheck = await pool.query('SELECT COUNT(*) FROM pending_contracts');
  if (parseInt(pcCheck.rows[0].count) === 0) {
    const pendingData = require('./data/pending-contracts');
    for (const row of pendingData) {
      const [artist_name, legal_name, address, cash, split, years, options, back_signs, futures, status, email] = row;
      await pool.query(
        `INSERT INTO pending_contracts (artist_name, legal_name, address, cash, split, years, options, back_signs, futures, status, email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [artist_name, legal_name, address, cash, split, years, options, back_signs, futures, status, email]
      );
    }
    console.log('Pending contracts seeded:', pendingData.length, 'records');
  }

  // User login tracking
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_login_logs (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      logged_in_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ip_address VARCHAR(100),
      user_agent TEXT
    )
  `);

  // Per-user page permissions — presence of a row means that page is allowed.
  // If a user has zero rows, they are unrestricted (see all pages).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_page_permissions (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      page VARCHAR(100) NOT NULL,
      UNIQUE(user_id, page)
    )
  `);

  // Release campaign tracker
  await pool.query(`
    CREATE TABLE IF NOT EXISTS release_campaigns (
      id SERIAL PRIMARY KEY,
      release_id INT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
      stage VARCHAR(100) DEFAULT 'Pre-Announce',
      target_announce_date DATE,
      target_presave_date DATE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(release_id)
    )
  `);

  // Release comments
  await pool.query(`
    CREATE TABLE IF NOT EXISTS release_comments (
      id SERIAL PRIMARY KEY,
      release_id INT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id),
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_release_comments_release ON release_comments(release_id)`);

  // Release audit log
  await pool.query(`
    CREATE TABLE IF NOT EXISTS release_audit_log (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP DEFAULT NOW(),
      user_name TEXT,
      release_id INT REFERENCES releases(id) ON DELETE CASCADE,
      action TEXT,
      field TEXT,
      old_value TEXT,
      new_value TEXT,
      details TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_release_audit_release ON release_audit_log(release_id)`);

  // Entity files — universal document vault for contracts, deals, and artists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entity_files (
      id SERIAL PRIMARY KEY,
      entity_type VARCHAR(50) NOT NULL,
      entity_id INT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_size INT,
      uploaded_by INT REFERENCES users(id),
      uploaded_at TIMESTAMP DEFAULT NOW(),
      label TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_entity_files_lookup ON entity_files (entity_type, entity_id)`);
  await pool.query(`ALTER TABLE entity_files ADD COLUMN IF NOT EXISTS file_data TEXT`);
  await pool.query(`ALTER TABLE entity_files ADD COLUMN IF NOT EXISTS mime_type TEXT`);
  // R2 migration — new uploads write the object key here instead of base64 to file_data
  await pool.query(`ALTER TABLE entity_files ADD COLUMN IF NOT EXISTS r2_key TEXT`);

  // Google SSO: password_hash is no longer required
  await pool.query(`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`);

  // The label's own details (2026-09-19) — one row, what prints on invoices,
  // NDAs and waivers. EIN and the bank account number are encrypted with the
  // same key as vendor payment details; only their last four are ever read
  // back except by the audited remittance read in routes/label.js.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS label_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      legal_name TEXT, display_name TEXT,
      address_line1 TEXT, address_line2 TEXT,
      contact_name TEXT, contact_email TEXT, contact_phone TEXT,
      ein_enc TEXT, ein_last4 TEXT,
      bank_name TEXT, bank_address TEXT, bank_account_name TEXT, bank_account_type TEXT,
      bank_routing_ach TEXT, bank_routing_wire TEXT, bank_swift TEXT,
      bank_account_enc TEXT, bank_account_last4 TEXT,
      signatory_name TEXT, signatory_title TEXT,
      default_payment_terms TEXT DEFAULT 'Net 30',
      updated_at TIMESTAMPTZ DEFAULT NOW(), updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    )`).catch(err => console.error('label_settings migration failed:', err.message));
  await pool.query(`INSERT INTO label_settings (id, display_name, legal_name) VALUES (1, 'Market Street', 'Market Street') ON CONFLICT (id) DO NOTHING`).catch(() => {});

  // Invites (2026-09-19): a person is created with no password and a one-time
  // link (token hashed here) that sets it. Seven days; resend voids the old one.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_invites (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    )`).catch(err => console.error('user_invites migration failed:', err.message));

  // My settings (2026-09-19): profile fields and notification preferences.
  for (const col of [`title TEXT`, `phone TEXT`, `notification_prefs JSONB`]) {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col}`)
      .catch(err => console.error(`users.${col.split(' ')[0]} migration failed:`, err.message));
  }


  // Market Street Reps registry — the canonical list of reps that appears in
  // every "Market Street Rep" dropdown (vendor submit, ledger filters, user
  // edit modal, payments + approvals filters, etc.). Admins manage
  // this list from the Settings page. Name is the PK because the rest
  // of the schema stores boom_rep as a plain TEXT label (e.g.
  // expenses.boom_rep) — using SERIAL ids would require renames to
  // cascade everywhere. `active = false` just hides a rep from new
  // dropdowns; historical references keep working.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS boom_reps (
      name        TEXT PRIMARY KEY,
      active      BOOLEAN DEFAULT TRUE,
      created_at  TIMESTAMP DEFAULT NOW(),
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
    )
  `).catch(() => {});
  // Idempotent seed — inserts the initial rep so the first deploy has a
  // populated dropdown without manual setup. Add the rest in Settings. ON CONFLICT DO NOTHING means an admin who
  // later deactivates one of these won't have it re-enabled on restart.
  for (const rep of ['John']) {
    await pool.query(
      `INSERT INTO boom_reps (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [rep]
    ).catch(() => {});
  }

  // Bookkeeping categories — the expense CATEGORIES and income
  // INCOME_CATEGORIES vocabularies, promoted from hardcoded constants to
  // data so they can be extended from Statements and Reports without a
  // deploy. Same shape and same seeding discipline as boom_reps above.
  //
  // `seeded` marks the rows the app shipped with. Custom categories can be
  // deactivated freely; deactivating a seeded one is allowed too, but the
  // flag lets the UI explain which is which, and lets a future cleanup tell
  // "we shipped this" from "someone typed this".
  //
  // Category values are stored on expenses.category / artist_income
  // .income_type as FREE TEXT, and historical rows may hold values that
  // aren't in this table at all. So this table is the source of the
  // dropdown OPTIONS, never a validity constraint on existing data —
  // nothing here should ever be used to reject or rewrite a stored row.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bk_categories (
      name        TEXT NOT NULL,
      kind        VARCHAR(8) NOT NULL,
      active      BOOLEAN DEFAULT TRUE,
      seeded      BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMP DEFAULT NOW(),
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      sort_order  INTEGER,
      PRIMARY KEY (kind, name),
      CONSTRAINT bk_categories_kind CHECK (kind IN ('expense', 'income'))
    )
  `).catch(() => {});
  await pool.query(`ALTER TABLE bk_categories ADD COLUMN IF NOT EXISTS sort_order INTEGER`).catch(() => {});

  // ── Where a category sits on the P&L ────────────────────────────────────────
  //
  // This used to be two hardcoded Sets in routes/reports.js, which is how
  // "Partner - Felipe" and "Partner - Tyler" ended up in operating expenses:
  // they weren't in the list, and nothing could put them there without a
  // deploy. $530,926 of owner distributions read as opex, inflating the
  // operating loss by ~20%.
  //
  // It belongs here for the same reason the categories themselves do — it is a
  // judgment about the business that changes, not a constant. A new
  // "Partner - Sam" is now one dropdown away from being classified correctly
  // instead of silently landing in opex.
  //
  //   operating      counts in Net Income. The default.
  //   below_line     advances, drawdowns, pass-through. Real cash, not trading.
  //   non_recurring  asset sales and one-offs. Kept out of Net Income so a
  //                  single catalog sale can't make a month look like a record
  //                  trading month — and so a reader doesn't have to strip it
  //                  out themselves to get a run-rate.
  await pool.query(`ALTER TABLE bk_categories ADD COLUMN IF NOT EXISTS report_section VARCHAR(16) NOT NULL DEFAULT 'operating'`).catch(() => {});
  // A recovery nets against the thing it recovers rather than being reported as
  // income. "Advance Refund" reverses an advance; "Marketing Reimbursement"
  // gives back marketing spend. Booking either as revenue overstates both sides
  // and leaves a reader unable to prove there's no double count.
  //
  // Holds the NAME of the expense category it offsets. The offset lands in
  // whichever section that expense lives in, so a refund of a below-line
  // advance stays below the line.
  await pool.query(`ALTER TABLE bk_categories ADD COLUMN IF NOT EXISTS contra_of TEXT`).catch(() => {});
  await pool.query(`
    ALTER TABLE bk_categories ADD CONSTRAINT bk_categories_section
      CHECK (report_section IN ('operating', 'below_line', 'non_recurring'))
  `).catch(() => {});

  // Seed the classification ONCE per category, then never again — `section_set`
  // records that the default has been applied, so a later reclassification from
  // the Reports page is not overwritten on the next boot. Same reason `seeded`
  // exists on the row itself.
  await pool.query(`ALTER TABLE bk_categories ADD COLUMN IF NOT EXISTS section_set BOOLEAN DEFAULT FALSE`).catch(() => {});
  const SECTION_SEED = [
    // kind, name, section, contra_of
    ['expense', 'Advance', 'below_line', null],
    ['expense', 'Reimbursements', 'below_line', null],
    ['income', 'Drawdown Fund', 'below_line', null],
    ['income', 'Reimbursements', 'below_line', null],
    ['income', 'Refund', 'below_line', null],
    // Recoveries, netted against what they recover.
    ['income', 'Advance Refund', 'operating', 'Advance'],
    ['income', 'Marketing Reimbursement', 'operating', 'Marketing'],
    // One-time asset disposition, not trading revenue.
    ['income', 'Catalog Sales', 'non_recurring', null],
  ];
  for (const [kind, name, section, contra] of SECTION_SEED) {
    await pool.query(
      `INSERT INTO bk_categories (name, kind, seeded, report_section, contra_of, section_set)
       VALUES ($1, $2, TRUE, $3, $4, TRUE)
       ON CONFLICT (kind, name) DO UPDATE
         SET report_section = EXCLUDED.report_section,
             contra_of      = EXCLUDED.contra_of,
             section_set    = TRUE
       WHERE bk_categories.section_set IS NOT TRUE`,
      [name, kind, section, contra]).catch(() => {});
  }
  // ── How the PICKERS group the vocabulary ────────────────────────────────────
  //
  // Orthogonal to report_section above, and both are needed. report_section says
  // where a category lands on the P&L (three values, and Marketing / Bank Fees /
  // Salary / Rent are all 'operating'). ui_group says what KIND of spend it is,
  // which is what a person scanning a 32-item dropdown needs.
  //
  // Seeded ONCE per category with the same `*_set` guard report_section uses, so
  // moving a category between groups later is not undone on the next boot.
  // Defaults to 'other': a category created from Statements or Reports next month
  // groups itself sensibly without a deploy, and lands somewhere visible rather
  // than disappearing from the picker.
  //
  // See CATEGORY_GROUP_SEED in lib/constants.js for the measurement behind it.
  await pool.query(`ALTER TABLE bk_categories ADD COLUMN IF NOT EXISTS ui_group TEXT NOT NULL DEFAULT 'other'`).catch(() => {});
  await pool.query(`ALTER TABLE bk_categories ADD COLUMN IF NOT EXISTS group_set BOOLEAN DEFAULT FALSE`).catch(() => {});
  // Required locally, the same way the vocabulary seed below does it.
  const { CATEGORY_GROUP_SEED } = require('./lib/constants');
  for (const [kind, groups] of Object.entries(CATEGORY_GROUP_SEED)) {
    for (const [group, names] of Object.entries(groups)) {
      for (const name of names) {
        // UPDATE-only, not an upsert: the vocabulary seed below owns which
        // categories EXIST. Inserting here would resurrect the six categories
        // that were deliberately merged away, which is a reported-number change
        // dressed as a UI tweak.
        await pool.query(
          `UPDATE bk_categories SET ui_group = $3, group_set = TRUE
            WHERE kind = $2 AND LOWER(TRIM(name)) = LOWER(TRIM($1))
              AND group_set IS NOT TRUE`,
          [name, kind, group]).catch(() => {});
      }
    }
  }

  // Case-insensitive uniqueness per kind, so "Podcast Ads" and "podcast ads"
  // can't both exist and split a report line in two.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS bk_categories_ci_idx
      ON bk_categories (kind, LOWER(TRIM(name)))
  `).catch(() => {});
  // The constants' ORDER is meaningful, not incidental — most-used first
  // (Recording, Mixing & Mastering, Music Video…) with 'Other' last, and
  // 'Streaming / Distribution' leading the income list. Alphabetizing the
  // dropdowns lost that, and also shifted the review deck's 1-9 hotkeys.
  // sort_order preserves the shipped sequence; custom categories have NULL
  // and sort after it, alphabetically among themselves.
  //
  // DO UPDATE (not DO NOTHING) on sort_order/seeded so already-deployed rows
  // get backfilled on the next boot. It deliberately leaves `active` alone —
  // re-seeding must never resurrect a category an admin retired.
  {
    const { CATEGORIES: SEED_EXPENSE, INCOME_CATEGORIES: SEED_INCOME } = require('./lib/constants');
    for (const [kind, list] of [['expense', SEED_EXPENSE], ['income', SEED_INCOME]]) {
      for (const [i, name] of list.entries()) {
        await pool.query(
          `INSERT INTO bk_categories (name, kind, seeded, sort_order) VALUES ($1, $2, TRUE, $3)
           ON CONFLICT (kind, name) DO UPDATE SET seeded = TRUE, sort_order = EXCLUDED.sort_order`,
          [name, kind, i]
        ).catch(() => {});
      }
    }
  }

  // Market Street-rep assignment — admins map a user to one of the BOOM_REPS
  // strings to declare "this user IS that rep". Drives implicit
  // visibility on Approvals + Payments (the user always sees rows
  // where boom_rep matches their assignment). NULL = no implicit
  // visibility; user only sees rows in their allow-list (or, for
  // Approvers, nothing until the allow-list is configured).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS boom_rep TEXT`).catch(() => {});

  // Activity log: extend with ip, method, endpoint columns
  await pool.query(`ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS ip_address VARCHAR(100)`);
  await pool.query(`ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS method VARCHAR(10)`);
  await pool.query(`ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS endpoint VARCHAR(255)`);
  // Rich-context columns so the unified Activity page can show bookkeeping
  // entry context (payee + field diff) that previously only lived in
  // bk_audit_log. bk_audit_id is the idempotency marker for the one-shot
  // backfill below.
  await pool.query(`ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS entry_id INT`);
  await pool.query(`ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS entry_payee TEXT`);
  await pool.query(`ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS bk_audit_id INT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activity_bk_audit ON activity_log(bk_audit_id)`);

  // One-shot backfill: copy every bk_audit_log row into activity_log so the
  // Activity page shows the full history. Idempotent via bk_audit_id — rows
  // already copied get skipped. Best-effort on user_id lookup; if the user
  // has been renamed we fall back to NULL and the UI shows '—'.
  await pool.query(`
    INSERT INTO activity_log (user_id, action, detail, entry_id, entry_payee, created_at, bk_audit_id)
    SELECT
      (SELECT id FROM users WHERE LOWER(TRIM(name)) = LOWER(TRIM(b.user_name)) LIMIT 1) AS user_id,
      CASE b.action
        WHEN 'expense_added'           THEN 'Added invoice'
        WHEN 'expense_updated'         THEN 'Updated invoice'
        WHEN 'expense_deleted'         THEN 'Deleted invoice'
        WHEN 'expense_restored'        THEN 'Restored invoice'
        WHEN 'expense_approved'        THEN 'Approved invoice'
        WHEN 'expense_approved_split'  THEN 'Approved & split invoice'
        WHEN 'expense_rejected'        THEN 'Rejected invoice'
        WHEN 'expense_unrejected'      THEN 'Restored rejected invoice'
        WHEN 'expense_split'           THEN 'Split invoice'
        WHEN 'expense_unsplit'         THEN 'Unsplit invoice'
        WHEN 'scan_dismissed'          THEN 'Dismissed AI scan'
        WHEN 'bulk_approve'            THEN 'Bulk approved invoices'
        WHEN 'vendor_renamed'          THEN 'Renamed vendor'
        WHEN 'vendor_alias_added'      THEN 'Added vendor alias'
        WHEN 'vendor_alias_reassigned' THEN 'Reassigned vendor alias'
        WHEN 'vendor_merged'           THEN 'Merged vendors'
        WHEN 'payment_updated'         THEN 'Updated payment'
        WHEN 'payment_confirmation_sent' THEN 'Sent payment confirmation'
        WHEN 'payment_approval_email_sent' THEN 'Sent approval email'
        WHEN 'payment_approval_email_test' THEN 'Sent test approval email'
        WHEN 'invoice_uploaded'        THEN 'Uploaded invoice'
        WHEN 'w9_uploaded'             THEN 'Uploaded W9'
        WHEN 'proof_uploaded'          THEN 'Uploaded proof of payment'
        WHEN 'receipt_uploaded'        THEN 'Uploaded receipt'
        ELSE b.action
      END,
      COALESCE(
        b.details,
        CASE WHEN b.field IS NOT NULL
          THEN b.field || ': ' || COALESCE(b.old_value, '—') || ' → ' || COALESCE(b.new_value, '—')
          ELSE NULL END
      ),
      b.entry_id, b.entry_payee, b.ts, b.id
    FROM bk_audit_log b
    WHERE NOT EXISTS (SELECT 1 FROM activity_log a WHERE a.bk_audit_id = b.id)
  `).catch(err => console.warn('bk_audit_log → activity_log backfill:', err.message));

  // Influencer / creator campaign imports
  await pool.query(`
    CREATE TABLE IF NOT EXISTS influencer_campaigns (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      platform VARCHAR(100) DEFAULT 'Cobrand',
      artist_id INT REFERENCES artists(id) ON DELETE SET NULL,
      release_id INT REFERENCES releases(id) ON DELETE SET NULL,
      total_budget DECIMAL(12,2),
      num_sounds INT,
      num_creators INT,
      campaign_date DATE,
      status VARCHAR(50) DEFAULT 'active',
      expense_id INT,
      created_by INT REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS influencer_campaign_creators (
      id SERIAL PRIMARY KEY,
      campaign_id INT NOT NULL REFERENCES influencer_campaigns(id) ON DELETE CASCADE,
      creator_name VARCHAR(255),
      handle VARCHAR(255),
      stage VARCHAR(100),
      price DECIMAL(10,2),
      contact_email VARCHAR(255),
      date_added DATE,
      tiktok_engagement_rate VARCHAR(20),
      tiktok_followers VARCHAR(50),
      instagram_engagement_rate VARCHAR(20),
      instagram_followers VARCHAR(50),
      tags TEXT[],
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ── Bookkeeping: expenses + audit log ────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id                    SERIAL PRIMARY KEY,
      invoice_date          DATE,
      payee                 TEXT,
      description           TEXT,
      category              TEXT,
      artist                TEXT,
      song                  TEXT,
      invoice_number        TEXT,
      amount                NUMERIC(12,2),
      currency              TEXT DEFAULT 'USD',
      payment_method        TEXT,
      payment_date          DATE,
      in_quickbooks         TEXT DEFAULT 'No',
      qb_entry_date         DATE,
      uploaded_to_stem      TEXT DEFAULT 'No',
      stem_upload_date      DATE,
      invoice_filename      TEXT,
      invoice_data          TEXT,
      w9_filename           TEXT,
      w9_data               TEXT,
      proof_filename        TEXT,
      proof_data            TEXT,
      vendor_submitted      BOOLEAN DEFAULT FALSE,
      vendor_name           TEXT,
      vendor_email          TEXT,
      vendor_address        TEXT,
      status                TEXT DEFAULT 'approved',
      approved_by           TEXT,
      approved_at           TIMESTAMP,
      payment_status        TEXT DEFAULT 'Unpaid',
      payment_terms         TEXT,
      scheduled_payment_date TEXT,
      paid_by               TEXT,
      artist_breakdown      JSONB,
      cobrand               BOOLEAN DEFAULT FALSE,
      is_reimbursement      BOOLEAN DEFAULT FALSE,
      notes                 TEXT,
      boom_rep              TEXT,
      deleted               BOOLEAN DEFAULT FALSE,
      parent_id             INTEGER REFERENCES expenses(id),
      recoupable            BOOLEAN DEFAULT TRUE,
      confirmation_sent     BOOLEAN DEFAULT FALSE,
      is_bulk_deal          BOOLEAN DEFAULT FALSE,
      -- What the approver confirmed when they accepted this invoice, and who.
      -- NULL means approved before the checklist existed (or not yet approved) —
      -- deliberately not backfilled, because inventing answers nobody gave is
      -- worse than an empty column. Also the ONLY place that distinguishes
      -- "someone decided this is not a cobrand / bulk deal" from "nobody ever
      -- looked": both of those columns are BOOLEAN DEFAULT FALSE, so on their
      -- own the 3,174 cobrand=false and 3,527 is_bulk_deal=false rows say
      -- nothing about whether the question was ever asked.
      approval_checklist    JSONB,
      bulk_deal_quantity    INTEGER,
      bulk_deal_unit        TEXT,
      created_at            TIMESTAMP DEFAULT NOW(),
      created_by            TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_expenses_status    ON expenses(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_expenses_payee     ON expenses(payee)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_expenses_date      ON expenses(invoice_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_expenses_deleted   ON expenses(deleted)`);
  // Backfill columns for existing databases
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS confirmation_sent BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS is_bulk_deal BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS approval_checklist JSONB`).catch(() => {});
  // The W9 attestation, written on the entry that HOLDS the W9 file — the
  // review belongs to the document, not to whichever invoice happened to be
  // on screen. A new upload creates a new entry, which is unreviewed again.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS w9_review JSONB`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS bulk_deal_quantity INTEGER`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS bulk_deal_unit TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS bulk_deal_completed BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS vendor_bank TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_ref TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS ufr TEXT DEFAULT 'No'`).catch(() => {});
  // Per-row "Artist Campaign?" tag. Curator's judgment about whether a
  // spend belongs to an artist marketing campaign — mirrors the UFR
  // Yes/No pattern so the ledger can host both toggles the same way.
  // Every row defaults to 'Yes': the assumption is that new ledger
  // entries ARE campaign work, and the Artist Campaigns page's
  // dismiss / not-campaign flows flip them to 'No' when reclassified.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS artist_campaign TEXT DEFAULT 'Yes'`).catch(() => {});
  // "2025 Expenses" bucket — prior-year spend tagged from the Recoupments
  // page; browsable on the dedicated /recoupments/2025 subpage.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS is_2025_expense BOOLEAN DEFAULT FALSE`).catch(() => {});
  // Deletion attribution for the Archive page's "Deletion" column — who
  // soft-deleted the row and when. Stamped by DELETE /bk/entries/:id,
  // cleared on restore.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS deleted_by TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`).catch(() => {});
  // One-time backfill for rows deleted before these columns existed —
  // pull the most recent expense_deleted audit entry. Idempotent: the
  // deleted_at IS NULL guard makes it a no-op after the first pass.
  await pool.query(`
    UPDATE expenses e SET deleted_by = a.user_name, deleted_at = a.ts
      FROM (SELECT DISTINCT ON (entry_id) entry_id, user_name, ts
              FROM bk_audit_log WHERE action = 'expense_deleted'
             ORDER BY entry_id, ts DESC) a
     WHERE e.id = a.entry_id AND e.deleted = true AND e.deleted_at IS NULL
  `).catch(() => {});
  // Two follow-up migrations for the transition: (1) the column may
  // already exist without the default from an earlier deploy — force
  // the default explicitly. (2) backfill legacy NULL rows to 'Yes' so
  // the ledger's Campaign? column doesn't show an unclassified state
  // for the historical rows. Both are idempotent and cheap.
  await pool.query(`ALTER TABLE expenses ALTER COLUMN artist_campaign SET DEFAULT 'Yes'`).catch(() => {});
  await pool.query(`
    UPDATE expenses SET artist_campaign = 'Yes'
     WHERE artist_campaign IS NULL
       AND (deleted IS NULL OR deleted = FALSE)
       AND (voided  IS NULL OR voided  = FALSE)
  `).catch(err => console.error('artist_campaign backfill failed:', err.message));
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS receipt_data TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS receipt_filename TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS w9_scan JSONB`).catch(() => {});

  // R2 migration — file blobs move from *_data (base64 TEXT) to Cloudflare R2.
  // These columns hold the R2 object key; the actual bytes live in the bucket.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS invoice_r2_key TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS w9_r2_key TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS proof_r2_key TEXT`).catch(() => {});

  // Set when an admin manually unsplits a song-split entry — keeps subsequent
  // song edits from re-triggering auto-split on a comma in the song name.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS no_auto_split BOOLEAN DEFAULT FALSE`).catch(() => {});

  // Voided invoices — kept on the ledger for record but excluded from the
  // Payment Dashboard. Different from soft-delete (which removes the entry
  // entirely); voiding is for "this is no longer payable but the audit trail
  // stays". voided_at / voided_by capture the audit metadata.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS voided BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS voided_by TEXT`).catch(() => {});

  // Tracks when a row was marked Paid in our system (vs. payment_date which
  // is the actual transaction date — often older if proof is uploaded late).
  // The Payment Dashboard's 14-day window is gated on this so a row stays
  // visible for 14 days after being marked paid, regardless of payment_date.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS paid_marked_at TIMESTAMP`).catch(() => {});

  // Per-user rep allow list — admins use this to scope which boom_rep
  // submissions a given non-admin user can see on the Approvals and
  // Payments pages. Allow-list model:
  //   • Admin / Superadmin → sees every rep (no rows needed).
  //   • Approver           → sees rows where boom_rep IN this user's
  //                          allow list. Empty list = sees nothing.
  //   • User               → sees rows where boom_rep matches their
  //                          own user.name (case-insensitive) OR is in
  //                          their allow list. Empty list = own rep only.
  //   • NULL boom_rep      → visible to admins only.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_visible_reps (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      visible_rep TEXT    NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW(),
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (user_id, visible_rep)
    )
  `).catch(() => {});

  // Unified per-artist meta — shared by the Recoupments page and the
  // Artist Campaigns page so an artist's priority is the same on both.
  // The `dismissed` columns are only used by the Recoupments page (Artist
  // Campaigns has no dismiss concept) but live here too to keep one row
  // per artist instead of fragmenting across tables.
  //
  // Global (not per-user) so a team working the same workflow stays in
  // sync. Keyed by artist_key (lowercase + trimmed of the canonical
  // artist name used by Recoupments' computeGrouped and Artist Campaigns'
  // index list).
  // Note: errors here are LOGGED (not silently swallowed). The
  // priority-saving feature on Recoupments + Artist Campaigns depends
  // entirely on this table — if CREATE fails for any reason (e.g. a
  // transient ordering issue with the users FK), every priority PUT
  // 500s and the client's optimistic update silently bounces back,
  // looking exactly like "the button doesn't work".
  await pool.query(`
    CREATE TABLE IF NOT EXISTS artist_meta (
      artist_key          TEXT PRIMARY KEY,
      dismissed           BOOLEAN DEFAULT FALSE,
      dismissed_at        TIMESTAMP,
      dismissed_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      priority            TEXT,
      priority_updated_at TIMESTAMP,
      priority_updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    )
  `).catch(err => console.error('artist_meta CREATE TABLE failed:', err.message));
  // Flag-for-review columns — added to both artist_meta and
  // song_campaign_status so both dimensions carry the same shape.
  // ADD COLUMN IF NOT EXISTS keeps older deployments happy without a
  // migration table entry.
  await pool.query(`ALTER TABLE artist_meta ADD COLUMN IF NOT EXISTS flagged BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE artist_meta ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE artist_meta ADD COLUMN IF NOT EXISTS flagged_by INTEGER REFERENCES users(id) ON DELETE SET NULL`).catch(() => {});
  await pool.query(`ALTER TABLE artist_meta ADD COLUMN IF NOT EXISTS flag_reason TEXT`).catch(() => {});
  // Artist-level "campaign complete" flag — the artist-page equivalent
  // of song_campaign_status.finished. Surfaces as a filled emerald
  // checkmark next to the artist name on the Artist Campaigns index,
  // mirroring the per-song completion pattern on the detail page.
  await pool.query(`ALTER TABLE artist_meta ADD COLUMN IF NOT EXISTS complete BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE artist_meta ADD COLUMN IF NOT EXISTS complete_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE artist_meta ADD COLUMN IF NOT EXISTS complete_by INTEGER REFERENCES users(id) ON DELETE SET NULL`).catch(() => {});
  // "Ready for planning" — Recoupments-page workflow marker: the artist's
  // pending items are reviewed and the batch can be staged on the
  // Planning page. Doubles as an index filter.
  await pool.query(`ALTER TABLE artist_meta ADD COLUMN IF NOT EXISTS ready_for_planning BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE artist_meta ADD COLUMN IF NOT EXISTS ready_for_planning_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE artist_meta ADD COLUMN IF NOT EXISTS ready_for_planning_by INTEGER REFERENCES users(id) ON DELETE SET NULL`).catch(() => {});
  // Sanity check — verify the table is actually there so a future
  // deploy log makes regressions obvious without DB shell access.
  {
    const { rows } = await pool.query(
      `SELECT to_regclass('public.artist_meta') AS exists`
    ).catch(() => ({ rows: [{ exists: null }] }));
    if (!rows[0]?.exists) {
      console.error('[migration] artist_meta TABLE MISSING after CREATE — priority/dismiss saves will fail.');
    } else {
      console.log('[migration] artist_meta table present');
    }
  }

  // Artist normalization — maps a multi-artist expenses.artist string
  // (e.g. "Ezra feat. Kendrick", "Chris Miles x Lil Xan") to a single
  // base artist so the ledger / recoupments / campaigns pages don't
  // grow separate buckets for every feature or collab spelling. Powered
  // by the Multi-Artist flag on /flags: when an operator picks a base
  // there, we (a) bulk-rename existing expenses.artist to the base and
  // (b) register the mapping here so future rows normalize on insert.
  // source_key is LOWER(TRIM()) of the multi-artist string; source_display
  // preserves the original casing for the flag UI.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS artist_normalization (
      source_key      TEXT PRIMARY KEY,
      source_display  TEXT NOT NULL,
      base_artist     TEXT NOT NULL,
      base_artist_id  INTEGER REFERENCES artists(id) ON DELETE SET NULL,
      created_at      TIMESTAMP DEFAULT NOW(),
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL
    )
  `).catch(err => console.error('artist_normalization CREATE TABLE failed:', err.message));

  // Song-campaign status. Marks a (artist, song) pairing as "finished
  // and matched up" — i.e. the campaign work is complete and all
  // expenses have been reconciled for recoupment. Surfaces as a badge
  // on both the Artist Campaigns song header and the Recoupments song
  // bucket header. Keyed identically to the artist_meta lookups:
  // artist_key uses normalize_artist_key (lowercase + strip non-
  // alphanumerics) and song_key is lowercase + trim.
  // Spend that bills the LABEL, not a release — so "which artist was this for"
  // has no answer. See lib/label-level.js for the measurement behind it: 490
  // ad-platform charges worth $289,499 with no song, no artist and no campaign on
  // any of them, holding campaign coverage at 68.7% with no way to improve it.
  //
  // Deliberately NOT a column on expenses. It is a rule about a CLASS of spend,
  // it must apply to rows that arrive next month, and deleting it must put those
  // rows straight back — the same shape and the same reasons as
  // statement_no_invoice_rules.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS label_level_spend_rules (
      id          SERIAL PRIMARY KEY,
      scope       TEXT NOT NULL CHECK (scope IN ('vendor', 'category')),
      rule_key    TEXT NOT NULL,
      reason      TEXT,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (scope, rule_key)
    )
  `).catch(err => console.error('label_level_spend_rules CREATE TABLE failed:', err.message));

  // Per-artist amounts drawn OUT of the label-level ad pool.
  //
  // John: "for advertisements, I will assign a set $$ amount for artists that can
  // be assigned/deducted from advertisements as a whole (facebook, spotify, etc.)"
  //
  // The charges themselves carry no artist evidence — that is why the pool exists
  // — but HE knows what the ads were for, and this is where that knowledge goes.
  // An allocation MOVES money from the pool to an artist: the artist's total goes
  // up, the pool's goes down, the P&L is untouched. Keyed by MONTH because that is
  // the grain the P&L buckets on and the grain ad spend arrives in.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ad_pool_allocations (
      id            SERIAL PRIMARY KEY,
      artist        TEXT NOT NULL,
      category      TEXT NOT NULL DEFAULT 'Advertisements',
      period_month  TEXT NOT NULL,
      amount        NUMERIC(14,2) NOT NULL,
      note          TEXT,
      created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(err => console.error('ad_pool_allocations CREATE TABLE failed:', err.message));
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ad_pool_allocations_month ON ad_pool_allocations (period_month)`
  ).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS song_campaign_status (
      artist_key  TEXT NOT NULL,
      song_key    TEXT NOT NULL,
      finished    BOOLEAN DEFAULT FALSE,
      finished_at TIMESTAMP,
      finished_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (artist_key, song_key)
    )
  `).catch(err => console.error('song_campaign_status CREATE TABLE failed:', err.message));
  // Freeform notes on the song campaign. Persisted independently of
  // `finished` so a user can jot context while the campaign is still
  // active. Nullable — empty state is either NULL or ''.
  await pool.query(`ALTER TABLE song_campaign_status ADD COLUMN IF NOT EXISTS notes TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE song_campaign_status ADD COLUMN IF NOT EXISTS notes_updated_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE song_campaign_status ADD COLUMN IF NOT EXISTS notes_updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL`).catch(() => {});
  // Song-level "ready for planning" — release-scoped counterpart of
  // artist_meta.ready_for_planning; toggled from the Campaigns song
  // subpage and the Recoupments song buckets.
  await pool.query(`ALTER TABLE song_campaign_status ADD COLUMN IF NOT EXISTS ready_for_planning BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE song_campaign_status ADD COLUMN IF NOT EXISTS ready_for_planning_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE song_campaign_status ADD COLUMN IF NOT EXISTS ready_for_planning_by INTEGER REFERENCES users(id) ON DELETE SET NULL`).catch(() => {});
  // Flag-for-review columns — mirror the artist_meta shape so both
  // layers can be flagged with an optional reason.
  await pool.query(`ALTER TABLE song_campaign_status ADD COLUMN IF NOT EXISTS flagged BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE song_campaign_status ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE song_campaign_status ADD COLUMN IF NOT EXISTS flagged_by INTEGER REFERENCES users(id) ON DELETE SET NULL`).catch(() => {});
  await pool.query(`ALTER TABLE song_campaign_status ADD COLUMN IF NOT EXISTS flag_reason TEXT`).catch(() => {});

  // Locked-in FX rate, snapshotted when payment_status flips to 'Paid'.
  // Stored as "value of `currency` per 1 USD" — matches /api/fx/rates shape
  // — so USD-equivalent = native_amount / fx_rate_to_usd. NULL means
  // "not yet locked" — live rates are used for display. Once stamped, the
  // displayed USD value for that row never changes again (user-stated
  // requirement: post-payment amounts must be immutable for audit). See
  // server/services/fx.js getHistorical().
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS fx_rate_to_usd NUMERIC`).catch(() => {});

  // Tracks when a row was marked "Uploaded for Recoupment" (ufr='Yes'). Set
  // by the PUT /entries/:id handler on transition into Yes; cleared on
  // transition out. Surfaced next to the UFR toggle on the Recoupments page
  // so the user can see how stale each upload is.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS ufr_marked_at TIMESTAMP`).catch(() => {});
  // Has somebody ANSWERED "is this bank-born cost recoupable?"
  //
  // `recoupable` is BOOLEAN DEFAULT TRUE and bookDebitAsEntry never sets it, so
  // all 1,972 statement-born rows arrive marked recoupable against nobody —
  // $3,101,837 of unvetted spend, of which 53 even name an artist. That default
  // is why lib/ledger-source.js keeps them off the recoupment surfaces.
  //
  // This is the gate that lets the good ones in: a DECISION, distinct from the
  // default. Recoupments admits a bank-born row only when this is true, whatever
  // `recoupable` happens to say.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS recoup_reviewed BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS recoup_reviewed_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS recoup_reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL`).catch(() => {});

  // Which campaign a ledger row's money belongs to.
  //
  // Ad-platform charges name nobody — 495 of the 499 `Advertisements` rows carry
  // no artist and their descriptors are merchant ids repeated on every charge
  // (`FACEBK *F4EE6X5GP2`). /bk/advertising splits such a charge across campaigns,
  // and each slice points here so a campaign's spend is a QUERY rather than a
  // number somebody remembered.
  //
  // NOT the same thing as `artist_campaign`, which is a free-text Yes/No answering
  // "is this campaign spend at all". This is an identity.
  //
  // ON DELETE SET NULL, deliberately: deleting a campaign must never delete or
  // orphan the ledger rows recording money that actually left the bank. The slice
  // survives with its artist and its amount intact, just unattached.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS campaign_id INTEGER REFERENCES influencer_campaigns(id) ON DELETE SET NULL`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS expenses_campaign_id ON expenses (campaign_id) WHERE campaign_id IS NOT NULL`).catch(() => {});

  // ── Vendor payment details ────────────────────────────────────────────────
  // How we actually pay a vendor. Until now the app stored a payment PREFERENCE
  // ('ACH') and a bank NAME ('Chase') and nothing else — the account number,
  // routing number, IBAN and PayPal handle existed only inside the uploaded PDF,
  // so paying somebody meant opening their invoice, and an invoice that did not
  // print them was refused outright.
  //
  // Keyed on the vendor's EMAIL, lower-cased, and nothing weaker. Vendor identity
  // everywhere else in this app resolves through names and vendor_aliases, which
  // is right for grouping invoices and exactly wrong here: a name collision that
  // pre-fills one vendor's bank details into another vendor's form is not a
  // mistake anyone gets to make twice.
  //
  // The account/routing/IBAN columns hold AES-256-GCM ciphertext from
  // lib/payment-crypto.js — never plaintext. `account_last4` is what screens show.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vendor_payment_details (
      id SERIAL PRIMARY KEY,
      vendor_email TEXT NOT NULL UNIQUE,
      vendor_name TEXT,
      method TEXT NOT NULL,
      account_enc TEXT,
      routing_enc TEXT,
      iban_enc TEXT,
      paypal_handle TEXT,
      account_last4 TEXT,
      holder_name TEXT,
      bank_address TEXT,
      updated_from_entry_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(err => console.error('vendor_payment_details CREATE TABLE failed:', err.message));
  await pool.query(
    `CREATE INDEX IF NOT EXISTS vendor_payment_details_email ON vendor_payment_details (LOWER(vendor_email))`
  ).catch(() => {});
  // ── The rest of what a payment run actually needs ─────────────────────────
  // The first cut of this table stored enough to IDENTIFY an account (number,
  // routing, IBAN, last4, holder) and `bank_address` for wires. It did not store
  // enough to FILE one: an ACH batch needs the checking/savings transaction code
  // and the receiving bank, and a wire needs the beneficiary's own address and
  // sometimes a correspondent bank. Those lived only in the PDF, which is the
  // same gap the payment block was created to close — just one layer further in.
  //
  // Not encrypted, deliberately, and the split is on sensitivity not on
  // convenience: `account_enc` / `routing_enc` / `iban_enc` are the values that
  // move money if they leak. A bank's street address is on its website.
  for (const col of [
    'account_type TEXT',            // 'Checking' | 'Savings' — canonical, see matchAccountType
    'bank_name TEXT',
    'beneficiary_address TEXT',
    'intermediary_bank TEXT',
    // 'Domestic' | 'International' — which KIND of wire. A domestic US wire is
    // an ABA plus an account number and has no IBAN at all, so without this the
    // stored row cannot say which set of coordinates it holds.
    'wire_scope TEXT',
  ]) {
    await pool.query(`ALTER TABLE vendor_payment_details ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
  }

  // The document cross-check for THIS submission:
  //   { method, typed_last4, doc_last4, verdict, checked_at }
  // verdict is match | mismatch | absent | unscanned. Mirrors `w9_review` — a
  // stored verdict rather than a recomputed one, because the document it judged
  // may be replaced later and the answer given at submission time is the one the
  // approver acted on.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_check JSONB`).catch(() => {});
  // Denormalized onto the entry so the ledger and the payments dashboard can show
  // which account a specific invoice was to be paid to, even if the vendor later
  // changes their details.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_last4 TEXT`).catch(() => {});
  // HOW this invoice was to be paid, frozen at submission — see
  // buildPaymentSnapshot in lib/payment-fields.js for the shape and for what is
  // deliberately excluded (account number, routing, IBAN).
  //
  // vendor_payment_details is a PROFILE and is overwritten on every submission,
  // so it answers "where does this vendor bank now" and cannot answer "where did
  // THIS invoice go". Address book versus shipping label: we kept the address
  // book. This is the label.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_snapshot JSONB`).catch(() => {});

  // ── The two fields on a W-9 that a 1099 needs, read off the form ──────────
  //
  // 299 vendors have a W-9 on file and the app never read either of these off
  // it: the scan took name, email and address only. Which meant GET /bk/1099
  // could get the money right and still not produce a filing — you cannot file
  // without a TIN, and without line 3 every reportable vendor needs a manual
  // entity check (222 of them for 2026, $6,121,632, measured 2026-09-01).
  //
  // They live on `expenses` alongside w9_scan rather than in a new table,
  // because a W-9 already lives on whichever row it was uploaded onto and every
  // other invoice from that vendor is covered by it (see lib/w9-owner.js). A
  // new per-vendor table would need a new identity key, and a name collision
  // putting one person's SSN under another's name is not a mistake worth
  // risking for tidiness.
  //
  // The TIN is ENCRYPTED (lib/payment-crypto, the same AES-256-GCM the bank
  // details use) and is the second thing in this schema that is. An SSN sitting
  // in plain text in a column is the one part of a W-9 that is directly
  // actionable by anyone who reads the table.
  //
  // `w9_tin_last4` is the part that gets displayed and compared, so it is plain
  // — exactly the split `payment_last4` / `payment_snapshot` already uses.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS w9_tin_enc TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS w9_tin_last4 TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS w9_tin_type TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS w9_tax_classification TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS w9_tax_scanned_at TIMESTAMPTZ`).catch(() => {});

  // Where a task sits in MY list. Personal by construction: `tasks` are scoped
  // `WHERE user_id = $1` everywhere they are read, so one column per task IS a
  // per-user order and no join table is needed.
  //
  // Replaces a `task_order` id-list in localStorage, which meant the order a
  // person arranged existed on one browser and nowhere else.
  //
  // NULL means "never dragged" and sorts LAST, so an untouched list keeps its
  // due-date order and only the rows somebody actually placed jump the queue.
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sort_order INTEGER`).catch(() => {});

  // ── Settlement groups: invoices paid TOGETHER ─────────────────────────────
  // Same value = one payment settles all of them.
  //
  // The matcher pairs on an amount equal to the cent, so two invoices paid in a
  // single transfer match NOTHING — each is smaller than the payment. Marking
  // them lets the matcher sum the group and settle the line in one go, through
  // the same path POST /statements/tx/:id/attach uses.
  //
  // NOT `payment_ref`. That column means "the bank's reference for this payment",
  // it is written by proof-of-payment scans, and refEvidence() reads it as
  // wire-text evidence — overloading it would corrupt that signal and be
  // overwritten by the next scan. (76 payment_refs are already shared by 2+
  // invoices, all of them from proofs, i.e. recorded after the money moved.)
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS settlement_group TEXT`).catch(() => {});
  await pool.query(
    `CREATE INDEX IF NOT EXISTS expenses_settlement_group ON expenses (settlement_group)
       WHERE settlement_group IS NOT NULL`).catch(() => {});

  // Classes of spend that are NEVER recoupable against an artist.
  //
  // The recoup_reviewed gate above lets a person answer one bank row at a time.
  // That is the wrong tool for most of the pile: 1,919 of the 1,972 unreviewed
  // statement rows carry no artist at all ($3,022,524), and 560 of those are Bank
  // Fees worth $3,251.43 in total. Answering them individually gives a $12 card
  // charge the same ceremony as a $200,000 advance, and a queue nobody can finish
  // is a queue nobody opens.
  //
  // Measured on the no-artist remainder (2026-08-20): Royalties $600,000,
  // Partner - Felipe $330,676, Salary $315,687, Royalty Service Expense $250,975,
  // Partner - Tyler $204,115, Salary (Felipe) $191,647, Credit Card $99,812,
  // Rent $82,005 — $2,074,917 across eight categories, none of it artist-
  // recoupable, and none of it duplicating an invoice row. Eight rules leave the
  // genuinely open questions behind: Advance $390,530 and Marketing $70,047.
  //
  // Third use of this shape, after statement_no_invoice_rules and
  // label_level_spend_rules, and the reasoning is the same each time:
  //
  //   - It is a rule about a CLASS, so it must apply to rows that arrive next
  //     month without anybody revisiting it.
  //   - It writes NOTHING to the ledger. `recoupable` is untouched, so deleting a
  //     rule puts those rows straight back in the queue. Compare recoup_reviewed,
  //     which is a per-row decision and is meant to persist.
  //   - It moves NO money. The rows it covers are already off the Recoupments
  //     page (client withoutUnreviewedBankRows); a rule only removes them from the
  //     queue of things still to answer.
  //
  // EQUALITY, never substring — the trap both precedents document ("TONE" is a
  // substring of "Tone Pay, Inc"). Here it cuts the other way too and is load-
  // bearing: `Salary` and `Salary (Felipe)` are two separate live categories, as
  // are `Partner - Felipe` and `Partner - Tyler`, so a `Salary` rule must leave
  // the `Salary (Felipe)` rows exactly where they are.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recoupment_class_rules (
      id          SERIAL PRIMARY KEY,
      scope       TEXT NOT NULL CHECK (scope IN ('vendor', 'category')),
      rule_key    TEXT NOT NULL,
      reason      TEXT,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (scope, rule_key)
    )
  `).catch(err => console.error('recoupment_class_rules CREATE TABLE failed:', err.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recoup_class_key
    ON recoupment_class_rules (scope, LOWER(TRIM(rule_key)))`).catch(() => {});
  // Best-effort backfill for existing Yes rows that pre-date this column —
  // anchor to created_at so the timeline doesn't all jump to "just now".
  // Idempotent: WHERE clause excludes rows already stamped.
  await pool.query(`
    UPDATE expenses
       SET ufr_marked_at = COALESCE(created_at, NOW())
     WHERE ufr = 'Yes' AND ufr_marked_at IS NULL
  `).catch(err => console.warn('ufr_marked_at backfill:', err.message));

  // Rush-payment request — surfaced as a yellow badge on the Payment Dashboard,
  // alerts the superadmin (John) via email + smart-alerts. Auto-cleared when
  // the row flips to payment_status='Paid'.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS rush_requested BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS rush_requested_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS rush_requested_by TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS rush_reason TEXT`).catch(() => {});
  // Hold: mirror of the rush columns for the opposite intent ("pause,
  // don't pay yet"). Mutually exclusive with rush server-side — setting
  // one clears the other. Trigger above also clears hold on Paid.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS on_hold BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS hold_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS hold_by TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS hold_reason TEXT`).catch(() => {});

  // Installments — one row per real payment transaction against an expense.
  // expense_id always references the family ROOT (the parent of a split, or the
  // entry itself if not split). payment_status on the expense is *derived* from
  // these rows: 0 → 'Unpaid', 0 < SUM < amount → 'Partial', SUM ≥ amount →
  // 'Paid'. Zero-installment rows keep the legacy single-payment behavior.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expense_payments (
      id              SERIAL PRIMARY KEY,
      expense_id      INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      amount          NUMERIC(12,2) NOT NULL,
      payment_date    DATE,
      payment_method  TEXT,
      payment_ref     TEXT,
      paid_by         TEXT,
      proof_filename  TEXT,
      proof_r2_key    TEXT,
      notes           TEXT,
      created_at      TIMESTAMP DEFAULT NOW(),
      created_by      TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_expense_payments_expense ON expense_payments(expense_id)`);

  // Recoupment notes — overarching context attached to an artist or to a
  // specific song under that artist. Used on the Recoupments page so the
  // team can leave standing reminders ("ad spend caps at $5K/mo", "wait
  // for Q3 mech royalties before final upload", etc.) without polluting
  // the per-expense notes field. Keyed on lowercased name strings since
  // songs aren't first-class entities in the schema (they're text on
  // expenses + releases). song_key NULL means it's the artist-level note.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recoupment_notes (
      id          SERIAL PRIMARY KEY,
      artist_key  TEXT NOT NULL,
      song_key    TEXT,
      note        TEXT NOT NULL DEFAULT '',
      updated_at  TIMESTAMP DEFAULT NOW(),
      updated_by  TEXT
    )
  `);
  // Two partial unique indexes (artist row vs song row) because PG can't
  // express the constraint as ONE composite that treats NULL as a real key.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_recoupment_notes_artist_only
                    ON recoupment_notes (artist_key) WHERE song_key IS NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_recoupment_notes_artist_song
                    ON recoupment_notes (artist_key, song_key) WHERE song_key IS NOT NULL`);

  // Recoupable defaults to TRUE going forward — the team's policy is that
  // every uploaded expense is recoupable unless explicitly marked otherwise.
  // The CREATE TABLE block above sets the default for new schemas; this
  // ALTER updates the default on existing databases.
  await pool.query(`ALTER TABLE expenses ALTER COLUMN recoupable SET DEFAULT TRUE`).catch(() => {});

  // app_migrations gates one-shot data migrations so a server restart doesn't
  // re-run them and clobber subsequent user edits. Each migration is keyed
  // by a stable identifier; INSERT ... ON CONFLICT DO NOTHING is the lock.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      key TEXT PRIMARY KEY,
      ran_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});

  // One-shot 'mark everything recoupable' backfill — runs ONLY the first
  // time this code deploys. After that, individual user toggles to
  // FALSE persist across restarts.
  const { rows: recoupMig } = await pool.query(
    `INSERT INTO app_migrations (key) VALUES ('recoupable_backfill_v1') ON CONFLICT DO NOTHING RETURNING key`
  ).catch(() => ({ rows: [] }));
  if (recoupMig.length) {
    await pool.query(`UPDATE expenses SET recoupable = TRUE WHERE recoupable IS DISTINCT FROM TRUE`)
      .catch(err => console.warn('recoupable=TRUE backfill:', err.message));
    console.log('[migration] recoupable_backfill_v1 applied');
  }

  // One-shot backfill: any row that has proof on file but is still Unpaid
  // got stuck before the upload handler started marking rows Paid
  // synchronously. Flip them now so the Payment Dashboard shows the
  // send-confirmation affordance.
  const { rows: paidFromProofMig } = await pool.query(
    `INSERT INTO app_migrations (key) VALUES ('paid_from_proof_v1') ON CONFLICT DO NOTHING RETURNING key`
  ).catch(() => ({ rows: [] }));
  if (paidFromProofMig.length) {
    await pool.query(`
      UPDATE expenses
         SET payment_status = 'Paid',
             paid_marked_at = COALESCE(paid_marked_at, NOW())
       WHERE payment_status IS DISTINCT FROM 'Paid'
         AND (deleted = false OR deleted IS NULL)
         AND ((proof_data IS NOT NULL AND proof_data != '') OR proof_r2_key IS NOT NULL)
    `).catch(err => console.warn('paid_from_proof backfill:', err.message));
    console.log('[migration] paid_from_proof_v1 applied');
  }

  // One-shot: drop the A&R-page tables. Both the Release Tracker and
  // Distro Requests pages have been removed from the app — the
  // distro_requests + content_transfers tables are no longer read or
  // written by anything. Guarded by app_migrations so this only runs
  // once; safe to leave in indefinitely.
  const { rows: dropAnrMig } = await pool.query(
    `INSERT INTO app_migrations (key) VALUES ('drop_anr_tables_v1') ON CONFLICT DO NOTHING RETURNING key`
  ).catch(() => ({ rows: [] }));
  if (dropAnrMig.length) {
    await pool.query(`DROP TABLE IF EXISTS distro_requests`)
      .catch(err => console.warn('drop distro_requests:', err.message));
    await pool.query(`DROP TABLE IF EXISTS content_transfers`)
      .catch(err => console.warn('drop content_transfers:', err.message));
    console.log('[migration] drop_anr_tables_v1 applied');
  }

  // One-shot: drop the prior block-list table (approver_rep_blocks).
  // Its semantics were inverted — block list. The replacement table
  // user_visible_reps uses allow-list semantics, so the old rows don't
  // translate cleanly. Best to discard and reconfigure.
  const { rows: dropBlockMig } = await pool.query(
    `INSERT INTO app_migrations (key) VALUES ('drop_approver_rep_blocks_v1') ON CONFLICT DO NOTHING RETURNING key`
  ).catch(() => ({ rows: [] }));
  if (dropBlockMig.length) {
    await pool.query(`DROP TABLE IF EXISTS approver_rep_blocks`)
      .catch(err => console.warn('drop approver_rep_blocks:', err.message));
    console.log('[migration] drop_approver_rep_blocks_v1 applied');
  }

  // One-shot: consolidate legacy budget tables (artist_budgets +
  // release_budgets + release_budget_line_items) into the unified
  // recording_budgets / recording_budget_line_items pair. Every
  // step is guarded by WHERE-NOT-EXISTS so re-runs are safe; the
  // app_migrations marker gates the whole block.
  //
  // Legacy tables intentionally NOT dropped here — kept as read-only
  // backup for one deploy so an issue mid-migration doesn't lose
  // data. The next release will drop them once we've verified the
  // consolidated data reads correctly.
  const { rows: consolidateBudgetsMig } = await pool.query(
    `INSERT INTO app_migrations (key) VALUES ('consolidate_budgets_v1') ON CONFLICT DO NOTHING RETURNING key`
  ).catch(() => ({ rows: [] }));
  if (consolidateBudgetsMig.length) {
    try {
      // A: artist_budgets → recording_budgets. Store the legacy flat
      //    amount in total_amount_override so the old total survives
      //    without needing a placeholder line item. Advance carries
      //    over verbatim.
      await pool.query(`
        INSERT INTO recording_budgets
          (artist_id, type, currency, advance_amount, total_amount_override,
           notes, contingency_pct, status, created_by, updated_by, created_at, updated_at)
        SELECT
          ab.artist_id, 'budget', 'USD',
          COALESCE(ab.advance, 0),
          COALESCE(ab.amount, 0),
          ab.notes,
          0,                       -- legacy budgets had no contingency
          'draft',
          ab.updated_by, ab.updated_by,
          COALESCE(ab.updated_at, NOW()), COALESCE(ab.updated_at, NOW())
        FROM artist_budgets ab
        WHERE NOT EXISTS (
          SELECT 1 FROM recording_budgets rb
           WHERE rb.artist_id = ab.artist_id AND rb.release_id IS NULL
        )
      `);
      // B: release_budgets → recording_budgets. Cap `amount` goes
      //    into total_amount_override; artist_id is looked up from
      //    the release so the row is queryable both ways.
      await pool.query(`
        INSERT INTO recording_budgets
          (release_id, artist_id, type, currency, advance_amount, total_amount_override,
           notes, contingency_pct, status, created_by, updated_by, created_at, updated_at)
        SELECT
          rb.release_id,
          (SELECT r.artist_id FROM releases r WHERE r.id = rb.release_id),
          'budget', 'USD',
          0,
          COALESCE(rb.amount, 0),
          rb.notes,
          0,
          'draft',
          rb.updated_by, rb.updated_by,
          COALESCE(rb.updated_at, NOW()), COALESCE(rb.updated_at, NOW())
        FROM release_budgets rb
        WHERE NOT EXISTS (
          SELECT 1 FROM recording_budgets rec
           WHERE rec.release_id = rb.release_id
        )
      `);
      // C: release_budget_line_items → recording_budget_line_items.
      //    Section forced to 'other' (release line-item categories
      //    don't map to the 6-section recording enum); the original
      //    category text is preserved in the new `category` column.
      await pool.query(`
        INSERT INTO recording_budget_line_items
          (budget_id, section, category, description, qty, unit_price, amount, notes, created_at)
        SELECT
          rb.id,
          'other',
          bli.category,
          COALESCE(bli.description, ''),
          1,
          COALESCE(bli.amount, 0),
          COALESCE(bli.amount, 0),
          bli.notes,
          COALESCE(bli.created_at, NOW())
        FROM release_budget_line_items bli
        JOIN recording_budgets rb ON rb.release_id = bli.release_id
        WHERE NOT EXISTS (
          SELECT 1 FROM recording_budget_line_items existing
           WHERE existing.budget_id = rb.id
             AND COALESCE(existing.description, '') = COALESCE(bli.description, '')
             AND ABS(existing.amount - COALESCE(bli.amount, 0)) < 0.005
        )
      `);
      console.log('[migration] consolidate_budgets_v1 applied');
    } catch (err) {
      console.error('[migration] consolidate_budgets_v1 failed:', err.message);
      await pool.query(`DELETE FROM app_migrations WHERE key = 'consolidate_budgets_v1'`).catch(() => {});
    }
  }

  // One-shot: backfill expenses.release_id for rows that missed the auto-link
  // window (expense created before the release existed) OR whose song text
  // differs from the release's project_name only by whitespace / curly-quote
  // / dash formatting. Two-pass:
  //   1. Fast SQL UPDATE using LOWER(TRIM(...)) equality — hits the vast
  //      majority of orphans (predated-release rows).
  //   2. JS-side normalized pass for anything still NULL — handles the
  //      formatting-only mismatches that Pass 1 couldn't reach. Capped at
  //      5k rows so a monster ledger doesn't turn startup into a scan.
  const { rows: relinkMig } = await pool.query(
    `INSERT INTO app_migrations (key) VALUES ('backfill_release_links_v1') ON CONFLICT DO NOTHING RETURNING key`
  ).catch(() => ({ rows: [] }));
  if (relinkMig.length) {
    try {
      const exact = await pool.query(`
        UPDATE expenses e
           SET release_id = r.id
          FROM releases r
          JOIN artists a ON r.artist_id = a.id
         WHERE e.release_id IS NULL
           AND (e.deleted = false OR e.deleted IS NULL)
           AND e.artist IS NOT NULL AND TRIM(e.artist) <> ''
           AND e.song   IS NOT NULL AND TRIM(e.song)   <> ''
           AND LOWER(TRIM(a.name))          = LOWER(TRIM(e.artist))
           AND LOWER(TRIM(r.project_name))  = LOWER(TRIM(e.song))
      `);
      const { normalizeSongMatch } = require('./lib/release-linking');
      const { rows: leftovers } = await pool.query(`
        SELECT id, artist, song FROM expenses
         WHERE release_id IS NULL
           AND (deleted = false OR deleted IS NULL)
           AND artist IS NOT NULL AND TRIM(artist) <> ''
           AND song   IS NOT NULL AND TRIM(song)   <> ''
         LIMIT 5000
      `);
      let fuzzyLinked = 0;
      if (leftovers.length) {
        const { rows: rel } = await pool.query(`
          SELECT r.id, a.name AS artist_name, r.project_name
            FROM releases r JOIN artists a ON r.artist_id = a.id
        `);
        const idx = new Map();
        for (const r of rel) {
          const key = String(r.artist_name || '').toLowerCase().trim();
          if (!idx.has(key)) idx.set(key, []);
          idx.get(key).push({ id: r.id, songNorm: normalizeSongMatch(r.project_name) });
        }
        for (const row of leftovers) {
          const bucket = idx.get(String(row.artist || '').toLowerCase().trim());
          if (!bucket) continue;
          const target = normalizeSongMatch(row.song);
          const hit = bucket.find(r => r.songNorm === target);
          if (hit) {
            await pool.query('UPDATE expenses SET release_id = $1 WHERE id = $2', [hit.id, row.id]);
            fuzzyLinked++;
          }
        }
      }
      console.log(`[migration] backfill_release_links_v1 applied: ${exact.rowCount || 0} exact + ${fuzzyLinked} normalized`);
    } catch (err) {
      console.error('[migration] backfill_release_links_v1 failed:', err.message);
      await pool.query(`DELETE FROM app_migrations WHERE key = 'backfill_release_links_v1'`).catch(() => {});
    }
  }

  // One-shot: backfill expenses.entry_source for rows created before the
  // origin-tag feature deployed. Two signals — each independently reliable
  // enough to run without a manual review — then a final propagation pass
  // for split children so the whole family agrees.
  //
  //   1. RECOUPMENTS artist-context path: correlate to activity_log rows
  //      whose endpoint matches /api/artists/*/budget/expenses. That URL
  //      is ONLY hit from the Recoupments "Add expense" modal in artist
  //      context, so hits are 100% precise. Joined by user_id + a small
  //      created_at window (< 15s) since activity_log doesn't persist
  //      the created entry_id back.
  //   2. ARTIST CAMPAIGNS: artist_campaign='Yes' AND vendor_submitted !=
  //      true. That flag is set explicitly by the Artist Campaigns add
  //      form on create; no other server-side write path sets it by
  //      default. False-positive risk: a ledger row that was later
  //      toggled artist_campaign='Yes' via the UI would get tagged too.
  //      That's a known, acceptable trade-off — the alternative is
  //      leaving hundreds of legitimate rows untagged.
  //   3. SPLIT CHILDREN: propagate the parent's entry_source down when
  //      the parent has one and children don't. Keeps a whole split
  //      family visually consistent.
  //
  // Only touches rows where entry_source IS NULL — never overwrites the
  // explicit tag set at create time.
  const { rows: srcMig } = await pool.query(
    `INSERT INTO app_migrations (key) VALUES ('entry_source_backfill_v1') ON CONFLICT DO NOTHING RETURNING key`
  ).catch(() => ({ rows: [] }));
  if (srcMig.length) {
    try {
      // Recoupments — via activity_log endpoint match. Correlate by user
      // + a 15-second window on either side of the expense's created_at.
      const recoupMatched = await pool.query(`
        UPDATE expenses e
           SET entry_source = 'recoupments'
         WHERE e.entry_source IS NULL
           AND e.created_at IS NOT NULL
           AND EXISTS (
             SELECT 1
               FROM activity_log al
               JOIN users u ON u.id = al.user_id
              WHERE al.method = 'POST'
                AND al.endpoint LIKE '/api/artists/%/budget/expenses%'
                AND LOWER(TRIM(u.name)) = LOWER(TRIM(COALESCE(e.created_by, '')))
                AND ABS(EXTRACT(EPOCH FROM (al.created_at - e.created_at))) < 15
           )
      `);

      // Artist Campaigns — heuristic on artist_campaign='Yes'
      const campaignsMatched = await pool.query(`
        UPDATE expenses
           SET entry_source = 'artist_campaigns'
         WHERE entry_source IS NULL
           AND artist_campaign = 'Yes'
           AND (vendor_submitted IS NOT TRUE)
      `);

      // Split-family propagation: if a parent has entry_source and its
      // children don't (e.g. the split ran after the origin UPDATE — the
      // bug we just fixed), propagate down.
      const propagated = await pool.query(`
        UPDATE expenses c
           SET entry_source = p.entry_source
          FROM expenses p
         WHERE c.parent_id = p.id
           AND p.entry_source IS NOT NULL
           AND c.entry_source IS NULL
      `);

      console.log(
        `[migration] entry_source_backfill_v1 applied: ` +
        `${recoupMatched.rowCount || 0} recoupments (audit-log), ` +
        `${campaignsMatched.rowCount || 0} artist_campaigns (heuristic), ` +
        `${propagated.rowCount || 0} split children propagated`
      );
    } catch (err) {
      console.error('[migration] entry_source_backfill_v1 failed:', err.message);
      await pool.query(`DELETE FROM app_migrations WHERE key = 'entry_source_backfill_v1'`).catch(() => {});
    }
  }

  // Corrective one-shot: the previous backfill's artist_campaign='Yes'
  // heuristic was too broad — that flag is ledger-editable, so it fired
  // on every row someone had ever toggled Campaign on (vendor invoices,
  // admin-entered rows, etc.), not just rows born via the Add Expense
  // modal on the Artist Campaigns page.
  //
  // Correct rule (per user constraint): Add Expense rows never have
  //   • invoice_number
  //   • vendor_name / vendor_email / vendor_bank / vendor_address
  //   • invoice / W9 / proof files (or their R2 keys)
  //   • receipt files (Recoupments allows a receipt, but Artist Campaigns
  //     Add Expense doesn't — so we still disqualify 'artist_campaigns'
  //     rows with any receipt)
  //
  // This clears entry_source on any row that shows any of those signs.
  // Rows correctly tagged at create-time (via POST /bk/entries with
  // entry_source in the body from the Add Expense modal) won't have
  // any of these fields, so they survive.
  const { rows: correctMig } = await pool.query(
    `INSERT INTO app_migrations (key) VALUES ('entry_source_untag_wrong_v1') ON CONFLICT DO NOTHING RETURNING key`
  ).catch(() => ({ rows: [] }));
  if (correctMig.length) {
    try {
      const untagged = await pool.query(`
        UPDATE expenses
           SET entry_source = NULL
         WHERE entry_source IS NOT NULL
           AND (
             (invoice_number IS NOT NULL AND TRIM(invoice_number) <> '')
             OR (vendor_name    IS NOT NULL AND TRIM(vendor_name)    <> '')
             OR (vendor_email   IS NOT NULL AND TRIM(vendor_email)   <> '')
             OR (vendor_bank    IS NOT NULL AND TRIM(vendor_bank)    <> '')
             OR (vendor_address IS NOT NULL AND TRIM(vendor_address) <> '')
             OR vendor_submitted = TRUE
             OR (invoice_data IS NOT NULL AND invoice_data <> '')
             OR invoice_r2_key IS NOT NULL
             OR (w9_data      IS NOT NULL AND w9_data      <> '')
             OR w9_r2_key      IS NOT NULL
             OR (proof_data   IS NOT NULL AND proof_data   <> '')
             OR proof_r2_key   IS NOT NULL
             OR (
               -- Receipts disqualify 'artist_campaigns' outright; the
               -- Recoupments artist-context path DOES allow attaching a
               -- receipt so we keep those tagged.
               entry_source = 'artist_campaigns'
               AND receipt_data IS NOT NULL AND receipt_data <> ''
             )
           )
      `);
      console.log(`[migration] entry_source_untag_wrong_v1 applied: cleared ${untagged.rowCount || 0} rows`);
    } catch (err) {
      console.error('[migration] entry_source_untag_wrong_v1 failed:', err.message);
      await pool.query(`DELETE FROM app_migrations WHERE key = 'entry_source_untag_wrong_v1'`).catch(() => {});
    }
  }

  // One-shot: copy existing recoupment_artist_meta + campaign_artist_meta
  // rows into the unified artist_meta table, then drop the old tables.
  // Recoupment meta wins on conflict (it has the dismissed columns the
  // campaign table doesn't); the campaign table's priority fills in any
  // rows that recoupment hadn't set. Gated by app_migrations so this
  // only runs once.
  const { rows: unifyMig } = await pool.query(
    `INSERT INTO app_migrations (key) VALUES ('unify_artist_meta_v1') ON CONFLICT DO NOTHING RETURNING key`
  ).catch(() => ({ rows: [] }));
  if (unifyMig.length) {
    await pool.query(`
      INSERT INTO artist_meta (artist_key, dismissed, dismissed_at, dismissed_by, priority, priority_updated_at, priority_updated_by)
      SELECT artist_key, dismissed, dismissed_at, dismissed_by, priority, priority_updated_at, priority_updated_by
        FROM recoupment_artist_meta
      ON CONFLICT (artist_key) DO NOTHING
    `).catch(err => console.warn('artist_meta recoupment copy:', err.message));
    await pool.query(`
      INSERT INTO artist_meta (artist_key, priority, priority_updated_at, priority_updated_by)
      SELECT artist_key, priority, priority_updated_at, priority_updated_by
        FROM campaign_artist_meta
      ON CONFLICT (artist_key) DO UPDATE SET
        priority = COALESCE(artist_meta.priority, EXCLUDED.priority),
        priority_updated_at = COALESCE(artist_meta.priority_updated_at, EXCLUDED.priority_updated_at),
        priority_updated_by = COALESCE(artist_meta.priority_updated_by, EXCLUDED.priority_updated_by)
    `).catch(err => console.warn('artist_meta campaign copy:', err.message));
    await pool.query(`DROP TABLE IF EXISTS recoupment_artist_meta`)
      .catch(err => console.warn('drop recoupment_artist_meta:', err.message));
    await pool.query(`DROP TABLE IF EXISTS campaign_artist_meta`)
      .catch(err => console.warn('drop campaign_artist_meta:', err.message));
    console.log('[migration] unify_artist_meta_v1 applied');
  }

  // One-shot: backfill users.boom_rep from name match. Bridges the
  // upgrade so existing users don't lose their implicit Payments-page
  // visibility when the helper switches from user.name match to
  // user.boom_rep direct match. Only writes rows where boom_rep is
  // still NULL — won't clobber admin-set values.
  const { rows: backfillRepMig } = await pool.query(
    `INSERT INTO app_migrations (key) VALUES ('users_boom_rep_backfill_v1') ON CONFLICT DO NOTHING RETURNING key`
  ).catch(() => ({ rows: [] }));
  if (backfillRepMig.length) {
    // BOOM_REPS canonical list (mirror of client/src/constants.js). Keep
    // in sync if the client list changes.
    const BOOM_REPS = ['John'];
    for (const rep of BOOM_REPS) {
      await pool.query(
        `UPDATE users SET boom_rep = $1
          WHERE boom_rep IS NULL
            AND LOWER(TRIM(name)) = LOWER(TRIM($1))`,
        [rep]
      ).catch(err => console.warn(`boom_rep backfill ${rep}:`, err.message));
    }
    console.log('[migration] users_boom_rep_backfill_v1 applied');
  }

  // One-shot backfill: existing Paid rows with no paid_marked_at use the
  // greater of payment_date / created_at so they don't all jump to 'just now'.
  await pool.query(`
    UPDATE expenses
       SET paid_marked_at = COALESCE(payment_date::timestamp, created_at, NOW())
     WHERE payment_status = 'Paid' AND paid_marked_at IS NULL
  `).catch(err => console.warn('paid_marked_at backfill:', err.message));

  // Net-30 default backfill — every expense without an explicit due date gets
  // one computed as invoice_date + 30 days, and missing payment_terms fills
  // to 'Net 30'. Idempotent — the WHERE clauses exclude rows already set, so
  // it's safe to run every startup.
  await pool.query(`
    UPDATE expenses
       SET scheduled_payment_date = invoice_date + INTERVAL '30 days'
     WHERE scheduled_payment_date IS NULL
       AND invoice_date IS NOT NULL
  `).catch(err => console.warn('Net-30 due-date backfill:', err.message));
  await pool.query(`
    UPDATE expenses
       SET payment_terms = 'Net 30'
     WHERE payment_terms IS NULL OR payment_terms = ''
  `).catch(err => console.warn('payment_terms backfill:', err.message));

  // Backfill song from the linked release's project_name where song is empty
  // but release_id is set. Past artist-budget expenses didn't auto-populate
  // the song field so the Expense Lookup couldn't find them by song. Idempotent
  // — only fills rows where song IS NULL/'' AND a release is linked.
  await pool.query(`
    UPDATE expenses e
       SET song = r.project_name
      FROM releases r
     WHERE e.release_id = r.id
       AND (e.song IS NULL OR e.song = '')
       AND r.project_name IS NOT NULL
  `).catch(err => console.warn('song-from-release backfill:', err.message));

  // Release-link backfill: case-insensitive (artist + song) match against
  // the releases table for any expense that has both fields but no
  // release_id. autoLinkRelease() already runs case-insensitive on every
  // create / update, but legacy rows that pre-date the auto-link feature
  // (or were edited via paths that bypass it) stay unlinked indefinitely
  // — that's why the ledger sometimes shows "Gimme Love" un-styled
  // alongside a styled "GIMME LOVE" sibling for the same release. The
  // WHERE clause skips any row already linked so this is idempotent
  // and safe to re-run on every startup.
  await pool.query(`
    UPDATE expenses e
       SET release_id = sub.release_id
      FROM (
        SELECT DISTINCT ON (e2.id) e2.id AS expense_id, r.id AS release_id
          FROM expenses e2
          JOIN artists a  ON LOWER(TRIM(a.name)) = LOWER(TRIM(e2.artist))
          JOIN releases r ON r.artist_id = a.id
                         AND LOWER(TRIM(r.project_name)) = LOWER(TRIM(e2.song))
         WHERE e2.release_id IS NULL
           AND e2.song   IS NOT NULL AND TRIM(e2.song)   <> ''
           AND e2.artist IS NOT NULL AND TRIM(e2.artist) <> ''
         ORDER BY e2.id, r.id ASC
      ) sub
     WHERE e.id = sub.expense_id
  `).catch(err => console.warn('release-link backfill:', err.message));

  // Payment-date backfill — every Paid row should carry the date the
  // row was flipped to Paid. New flips going forward stamp it
  // automatically (see todayLA() / inline (NOW() AT TIME ZONE
  // 'America/Los_Angeles')::DATE in routes/bookkeeping.js), but
  // historical rows that pre-date the rule have NULL payment_date.
  // Backfill from paid_marked_at when we have it (interpret the
  // server-stored timestamp as UTC, convert to LA local date), fall
  // back to today's LA date for any Paid row that doesn't even have a
  // paid_marked_at on file. WHERE clause skips already-set rows so this
  // is idempotent and safe to re-run on every boot.
  await pool.query(`
    UPDATE expenses
       SET payment_date = COALESCE(
         ((paid_marked_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::DATE,
         (NOW() AT TIME ZONE 'America/Los_Angeles')::DATE
       )
     WHERE payment_status = 'Paid'
       AND payment_date IS NULL
       AND (deleted = false OR deleted IS NULL)
  `).catch(err => console.warn('payment-date backfill:', err.message));

  // Split-family payment sync: a split parent that's Paid while its
  // children are still Unpaid is an inconsistent state — the children are
  // just accounting slices of the same underlying payment. Copy the
  // parent's payment fields down. Idempotent — the WHERE clause skips
  // already-synced rows. New writes (PUT /bk/payments/:id) cascade on
  // their own so this only fixes historical data.
  await pool.query(`
    UPDATE expenses c
       SET payment_status = p.payment_status,
           payment_date   = COALESCE(p.payment_date, c.payment_date),
           paid_by        = COALESCE(p.paid_by, c.paid_by),
           payment_method = COALESCE(p.payment_method, c.payment_method),
           payment_ref    = COALESCE(p.payment_ref, c.payment_ref)
      FROM expenses p
     WHERE c.parent_id = p.id
       AND p.payment_status = 'Paid'
       AND c.payment_status IS DISTINCT FROM 'Paid'
       AND (c.deleted = false OR c.deleted IS NULL)
  `).catch(err => console.warn('split-family payment backfill:', err.message));

  // FX rate backfill — every Paid row that doesn't have fx_rate_to_usd
  // locked yet (legacy rows, paid_from_proof_v1 migration rows, etc.)
  // gets stamped at the rate as-of its payment_date. Runs ONCE per
  // startup; failures are logged + skipped. Doesn't block server boot —
  // the FX API can be slow and we don't want a deploy held up by it.
  setImmediate(() => {
    require('./services/fxStamp').backfillPaidRows().catch(err => {
      console.warn('[fxStamp] backfill failed:', err.message);
    });
  });

  // Reminder emails — one per due cycle: fires when a reminder comes due
  // and stays quiet until it's marked Done and comes due again. Hourly
  // sweep + one pass on boot.
  const sweepReminderEmails = async () => {
    try {
      const { rows } = await pool.query(`
        SELECT r.id, r.title, r.link, r.next_due, u.email, u.name
          FROM reminders r JOIN users u ON u.id = r.user_id
         WHERE r.active = true AND r.notify_email = true AND r.next_due <= CURRENT_DATE
           AND (r.last_emailed IS NULL OR r.last_emailed < r.next_due)`);
      if (!rows.length) return;
      const { sendEmail } = require('./services/email');
      const base = process.env.FRONTEND_URL || 'https://marketst-production.up.railway.app';
      for (const r of rows) {
        if (!r.email) continue;
        await sendEmail({
          to: r.email,
          subject: `Reminder: ${r.title}`,
          html: `<p>Hi ${r.name || ''},</p>
                 <p>This is your reminder: <strong>${r.title}</strong></p>
                 ${r.link ? `<p><a href="${base}${r.link}">Open it in the dashboard</a></p>` : ''}
                 <p style="color:#888;font-size:12px">Mark it done from the notification bell to stop this cycle's nudges. Manage reminders on the Statements page.</p>`,
        }).catch((err) => console.warn(`[reminders] email for #${r.id} failed:`, err.message));
        await pool.query(`UPDATE reminders SET last_emailed = CURRENT_DATE WHERE id = $1`, [r.id]);
      }
      console.log(`[reminders] emailed ${rows.length} due reminder(s)`);
    } catch (err) {
      console.warn('[reminders] sweep failed:', err.message);
    }
  };
  setImmediate(sweepReminderEmails);
  setInterval(sweepReminderEmails, 60 * 60 * 1000);

  // Nightly matcher freshness: invoices approved/paid since upload get
  // matched without anyone pressing Re-run. First pass 5 minutes after
  // boot (post-deploy), then daily.
  const rematchSweep = () => {
    statementsRoutes.rematchAll?.('auto-rematch')
      .then((n) => { if (n > 0) console.log(`[rematch] freshness sweep matched ${n} debit(s)`); })
      .catch((err) => console.warn('[rematch] sweep failed:', err.message));
  };
  setTimeout(rematchSweep, 5 * 60 * 1000);
  setInterval(rematchSweep, 24 * 60 * 60 * 1000);

  // Salary employees — standalone payroll roster (not tied to users table)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS salary_employees (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      department TEXT,
      monthly_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Seed payroll roster — insert only if missing. Never re-activate or
  // overwrite existing rows: that would resurrect employees the user
  // soft-deleted via the UI and clobber any salary/department edits.
  // Market Street starts with an empty payroll roster — add employees from
  // the Financials page. (The fork removed the previous label's roster.)
  const payroll = [];
  for (const p of payroll) {
    const { rows: exists } = await pool.query('SELECT id FROM salary_employees WHERE LOWER(name) = LOWER($1)', [p.name]);
    if (exists.length === 0) {
      await pool.query('INSERT INTO salary_employees (name, department, monthly_amount) VALUES ($1, $2, $3)', [p.name, p.department, p.amount]);
    }
  }

  // Salary payments — tracks paid status per employee per month
  // Drop old table if it has the wrong schema (user_id instead of employee_id)
  const { rows: spCols } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'salary_payments' AND column_name = 'user_id'
  `).catch(() => ({ rows: [] }));
  if (spCols.length > 0) {
    await pool.query('DROP TABLE IF EXISTS salary_payments CASCADE');
    console.log('Dropped old salary_payments table (had user_id instead of employee_id)');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS salary_payments (
      id SERIAL PRIMARY KEY,
      employee_id INT NOT NULL REFERENCES salary_employees(id) ON DELETE CASCADE,
      month INT NOT NULL,
      year INT NOT NULL,
      amount NUMERIC(12,2),
      paid BOOLEAN DEFAULT FALSE,
      paid_at TIMESTAMP,
      paid_by TEXT,
      notes TEXT,
      UNIQUE(employee_id, month, year)
    )
  `);

  // Salary payment history (audit trail for toggles)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS salary_payment_history (
      id SERIAL PRIMARY KEY,
      employee_id INT NOT NULL REFERENCES salary_employees(id) ON DELETE CASCADE,
      month INT NOT NULL,
      year INT NOT NULL,
      action TEXT NOT NULL,
      performed_by TEXT,
      performed_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bulk_deal_items (
      id            SERIAL PRIMARY KEY,
      expense_id    INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      video_url     TEXT,
      platform      TEXT,
      completed     BOOLEAN DEFAULT FALSE,
      completed_at  TIMESTAMP,
      position      INTEGER DEFAULT 0,
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE bulk_deal_items ADD COLUMN IF NOT EXISTS platform TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bulk_deal_items_expense ON bulk_deal_items(expense_id)`);

  // Per-expense comment threads (Artist Campaigns row discussions).
  // user_id is SET NULL on user deletion so threads survive account
  // cleanup without joining the users FK-cleanup list in settings.js.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expense_comments (
      id          SERIAL PRIMARY KEY,
      expense_id  INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      comment     TEXT NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_expense_comments_expense ON expense_comments(expense_id)`);

  // Review assignments — the Artist Campaigns "Needs review" inbox lets
  // items be assigned to MULTIPLE users (one row per assignee). Both FKs
  // cascade/null so expense deletion and user cleanup stay simple.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS review_assignments (
      id           SERIAL PRIMARY KEY,
      expense_id   INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      assigned_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TIMESTAMP DEFAULT NOW(),
      UNIQUE(expense_id, user_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_review_assignments_expense ON review_assignments(expense_id)`);

  // Campaign chat — one room per Artist Campaigns page/subpage (room is a
  // stable string key: 'campaigns:index', 'campaigns:<artist>',
  // 'campaigns:<artist>::<song>'). Messages soft-delete (deleted=TRUE,
  // filtered from reads) so edits/deletions stay auditable in the DB.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_chat_messages (
      id          SERIAL PRIMARY KEY,
      room        TEXT NOT NULL,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body        TEXT NOT NULL,
      mentions    JSONB,
      edited_at   TIMESTAMP,
      deleted     BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_campaign_chat_room ON campaign_chat_messages(room, id)`);

  // Per-user last-read watermark per room — powers the unread badge on
  // the floating chat button.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_chat_reads (
      room          TEXT NOT NULL,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_id  INTEGER NOT NULL DEFAULT 0,
      updated_at    TIMESTAMP DEFAULT NOW(),
      UNIQUE(room, user_id)
    )
  `);

  // @mention notifications — persisted (unlike the computed bell alerts)
  // so a mention survives until the mentioned user sees it. Generic shape
  // (room/room_title/room_path) so future chat surfaces can reuse it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_mentions (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_name  TEXT,
      room        TEXT NOT NULL,
      room_title  TEXT,
      room_path   TEXT,
      message_id  INTEGER,
      snippet     TEXT,
      read        BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_mentions_user ON user_mentions(user_id, read)`);

  // ── Team message board (/messages) ────────────────────────────────────────
  // The workspace-wide chat store. Deliberately SEPARATE from
  // campaign_chat_messages above, which stays untouched: that one is keyed by a
  // free-form `room` string and mounted on three pages, and migrating it is a
  // later, reversible step (BUILD_MESSAGE_BOARD.md §7.2). The two coexist until
  // then. What does NOT get a second copy is the mention store — chat mentions
  // write to `user_mentions` above with room = 'chat:<channelId>', so the bell
  // and its "mark all read" see every mention in the app, not half of them.
  //
  // Every statement carries its own .catch: runMigrations() is ONE promise
  // chain, so an unguarded throw here would abort every migration defined below
  // it and the app would boot "successfully" with a half-built schema.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_channels (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(80),
      topic       TEXT,
      type        VARCHAR(16) NOT NULL DEFAULT 'channel',
      entity_type VARCHAR(40),
      entity_id   INTEGER,
      is_private  BOOLEAN DEFAULT FALSE,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `).catch(err => console.error('[migration] chat_channels failed:', err.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_channels_type ON chat_channels (type)`)
    .catch(err => console.error('[migration] idx_chat_channels_type failed:', err.message));
  // Partial unique index — one discussion thread per record, enforced by the
  // database rather than by a read-then-insert race in the route (phase 5).
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_object
      ON chat_channels (entity_type, entity_id) WHERE type = 'object'
  `).catch(err => console.error('[migration] uq_chat_object failed:', err.message));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_members (
      id           SERIAL PRIMARY KEY,
      channel_id   INTEGER NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_at TIMESTAMP,
      muted        BOOLEAN DEFAULT FALSE,
      joined_at    TIMESTAMP DEFAULT NOW(),
      UNIQUE (channel_id, user_id)
    )
  `).catch(err => console.error('[migration] chat_members failed:', err.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members (user_id)`)
    .catch(err => console.error('[migration] idx_chat_members_user failed:', err.message));

  // user_id is nullable ON PURPOSE — that is how the activity bot (phase 4)
  // posts without a fake user row. body is nullable so an attachment-only
  // message (phase 3) is expressible. Soft delete, matching the convention
  // campaign_chat_messages already set.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id             SERIAL PRIMARY KEY,
      channel_id     INTEGER NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
      user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body           TEXT,
      thread_root_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
      is_system      BOOLEAN DEFAULT FALSE,
      meta           JSONB,
      edited_at      TIMESTAMP,
      deleted        BOOLEAN DEFAULT FALSE,
      created_at     TIMESTAMP DEFAULT NOW()
    )
  `).catch(err => console.error('[migration] chat_messages failed:', err.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages (channel_id, id DESC)`)
    .catch(err => console.error('[migration] idx_chat_messages_channel failed:', err.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages (thread_root_id)`)
    .catch(err => console.error('[migration] idx_chat_messages_thread failed:', err.message));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_reactions (
      id         SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji      VARCHAR(16) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (message_id, user_id, emoji)
    )
  `).catch(err => console.error('[migration] chat_reactions failed:', err.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_reactions_msg ON chat_reactions (message_id)`)
    .catch(err => console.error('[migration] idx_chat_reactions_msg failed:', err.message));

  // Chat attachments — one row per uploaded file on a chat message.
  //
  // Storage is R2 when it is configured and base64 in `inline_data` when it is
  // not, which is the same two-source shape `entity_files` uses (r2_key +
  // file_data TEXT) and the same shape lib/r2.js's loadFileBuffer() already
  // knows how to resolve. TEXT/base64 rather than bytea for exactly that
  // reason: a third storage representation would need a third reader.
  //
  // A dev box with no R2_* credentials has to be able to send a file, or the
  // feature cannot be exercised before it deploys.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_attachments (
      id          SERIAL PRIMARY KEY,
      message_id  INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      filename    TEXT NOT NULL,
      mime        TEXT,
      size_bytes  INTEGER,
      r2_key      TEXT,
      inline_data TEXT,
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `).catch(err => console.error('[migration] chat_attachments failed:', err.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_attachments_msg ON chat_attachments (message_id)`)
    .catch(err => console.error('[migration] idx_chat_attachments_msg failed:', err.message));

  // Seed #general and #activity, and put every user in both.
  //
  // FIND-OR-CREATE on lower(name), not insert-when-the-table-is-empty: a
  // workspace that deletes #general has to get it back on the next boot, and an
  // emptiness test would only ever fire once in the life of the database.
  // The membership backfill is unconditional for the same reason — it is how a
  // teammate hired after the channel was created ends up in it.
  //
  // #activity is NOT seeded here. lib/activityBot.js owns it, because the bot
  // must be able to create it from a background write long after boot, and this
  // block, routes/chat.js and the bot would otherwise be three copies of one
  // `lower(name) = 'activity'` rule — three places to update to rename a channel,
  // and two of them will be missed.
  try {
    let { rows } = await pool.query(
      `SELECT id FROM chat_channels WHERE type = 'channel' AND lower(name) = 'general' LIMIT 1`
    );
    if (!rows.length) {
      ({ rows } = await pool.query(
        `INSERT INTO chat_channels (name, topic, type, is_private)
         VALUES ('general', 'Company-wide chatter', 'channel', FALSE) RETURNING id`
      ));
      console.log('[migration] created #general');
    }
    const { rowCount } = await pool.query(`
      INSERT INTO chat_members (channel_id, user_id, last_read_at)
      SELECT $1, u.id, NOW() FROM users u
      ON CONFLICT (channel_id, user_id) DO NOTHING
    `, [rows[0].id]);
    if (rowCount > 0) console.log(`[migration] added ${rowCount} member(s) to #general`);

    const activityId = await require('./lib/activityBot').ensureActivityChannel();
    console.log(`[migration] #activity ready (channel ${activityId})`);
  } catch (err) {
    console.error('[migration] chat channel seed failed:', err.message);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bk_audit_log (
      id           SERIAL PRIMARY KEY,
      ts           TIMESTAMP DEFAULT NOW(),
      user_name    TEXT,
      action       TEXT,
      entry_id     INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
      entry_payee  TEXT,
      field        TEXT,
      old_value    TEXT,
      new_value    TEXT,
      details      TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bk_audit_entry ON bk_audit_log(entry_id)`);

  // Market Street invoices — generated invoices from Market Street
  await pool.query(`
    CREATE TABLE IF NOT EXISTS boom_invoices (
      id              SERIAL PRIMARY KEY,
      invoice_number  INT NOT NULL UNIQUE,
      bill_to         TEXT NOT NULL,
      bill_to_address TEXT,
      description     TEXT NOT NULL,
      amount          NUMERIC(12,2) NOT NULL,
      purchase_order  TEXT DEFAULT 'N/A',
      due_by          TEXT DEFAULT 'UPON RECEIPT',
      payment_status  TEXT DEFAULT 'Unpaid',
      line_items      JSONB,
      created_by      TEXT,
      invoice_date    DATE,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // The date the invoice BEARS, as opposed to the instant the row was made.
  //
  // John, 2026-09-15: "I want to be able to edit the start date of an invoice."
  // Until now that date was DERIVED from `created_at` (businessDay), which is
  // right for a document raised today and impossible to correct afterwards — and
  // `created_at` must not become the editable one, because it is the audit
  // record of when the row was created and the whole reason that column was
  // migrated to TIMESTAMPTZ.
  //
  // NULLABLE, and null means "derive it from created_at" exactly as before. So
  // every invoice already in the table keeps printing the date it prints today,
  // with no backfill and nothing to get wrong.
  await pool.query(`ALTER TABLE boom_invoices ADD COLUMN IF NOT EXISTS invoice_date DATE`)
    .catch(err => console.error('[migration] boom_invoices.invoice_date failed:', err.message));

  // created_at carries the INSTANT, not a wall-clock reading.
  //
  // It was TIMESTAMP (no zone). NOW() writes the DB session's clock, which is UTC,
  // so the stored value meant "UTC, trust me" — and node-pg parses a zoneless
  // timestamp in the NODE PROCESS's timezone. Railway runs UTC so production read
  // the right instant by coincidence of configuration; the same row read from a
  // laptop in Los Angeles came back seven hours later. That matters now because
  // the invoice's printed date and its payment deadline are both derived from this
  // column (lib/payment-terms.js businessDay), so a misread instant moves a
  // client's due date.
  //
  // Guarded by the current type, not just IF EXISTS: re-running
  // `AT TIME ZONE 'UTC'` on a column that is ALREADY timestamptz would shift every
  // value by the session offset. Existing rows are UTC wall clocks, which is
  // exactly what the USING clause says.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'boom_invoices' AND column_name = 'created_at'
                    AND data_type = 'timestamp without time zone') THEN
        ALTER TABLE boom_invoices
          ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
        ALTER TABLE boom_invoices ALTER COLUMN created_at SET DEFAULT NOW();
      END IF;
    END $$;
  `).catch((e) => console.error('[migration] boom_invoices.created_at -> timestamptz deferred:', e.message));

  await pool.query(`ALTER TABLE boom_invoices ADD COLUMN IF NOT EXISTS bill_to_address TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE boom_invoices ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'Unpaid'`).catch(() => {});
  await pool.query(`ALTER TABLE boom_invoices ADD COLUMN IF NOT EXISTS line_items JSONB`).catch(() => {});
  // Invoice currency. Existing rows default to USD — the only thing
  // they ever were before this column existed. NULL is also treated
  // as USD client-side so any pre-migration row renders correctly.
  await pool.query(`ALTER TABLE boom_invoices ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD'`).catch(() => {});
  // Payment terms, and the date they imply.
  //
  // `due_by` already existed and is the printed STRING — every one of the 21 live
  // rows holds the literal 'UPON RECEIPT'. It stays, because it is what the PDF
  // renders, but a string cannot be reported on: A/R aging cannot bucket it and
  // nothing can tell "Net 30" from a date somebody typed.
  //
  // So the choice and the date are stored beside it. The column default is
  // 'Due on receipt' so a row created without the field keeps the old behaviour;
  // the create page preselects Net 30, which is what the terms were asked for.
  await pool.query(`ALTER TABLE boom_invoices ADD COLUMN IF NOT EXISTS payment_terms TEXT DEFAULT 'Due on receipt'`).catch(() => {});
  await pool.query(`ALTER TABLE boom_invoices ADD COLUMN IF NOT EXISTS due_date DATE`).catch(() => {});

  // Market Street NDAs — generated non-disclosure agreements from the Create NDA page.
  // Mirrors the boom_invoices pattern (raw form fields + audit columns).
  // PDF rendering happens client-side via jsPDF; only the form values are
  // persisted so a past NDA can be reopened and re-issued. `custom_body`
  // holds the full editable body text (template + user edits) — the client
  // renders this string into the PDF rather than reconstructing from a
  // template, so any tweaks the user made survive a save/reload cycle.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS boom_ndas (
      id                SERIAL PRIMARY KEY,
      effective_date    DATE NOT NULL,
      owner_name        TEXT NOT NULL,
      owner_address     TEXT,
      recipient_name    TEXT NOT NULL,
      recipient_address TEXT,
      disclosed_to      TEXT,
      signatory_name    TEXT,
      signatory_title   TEXT,
      custom_body       TEXT,
      include_non_circumvention BOOLEAN DEFAULT true,
      include_non_solicitation  BOOLEAN DEFAULT true,
      created_by        TEXT,
      created_at        TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE boom_ndas ADD COLUMN IF NOT EXISTS custom_body TEXT`).catch(() => {});
  // Optional clauses — historically every NDA had both, so existing rows
  // default to true. The client treats NULL the same as true for legacy rows.
  await pool.query(`ALTER TABLE boom_ndas ADD COLUMN IF NOT EXISTS include_non_circumvention BOOLEAN DEFAULT true`).catch(() => {});
  await pool.query(`ALTER TABLE boom_ndas ADD COLUMN IF NOT EXISTS include_non_solicitation BOOLEAN DEFAULT true`).catch(() => {});
  // Template registry — the /create-nda page now supports multiple
  // NDA templates as subpages. template_id remembers which template
  // an NDA was created against (so edit loads the right template);
  // template_data JSONB carries any template-specific extra fields
  // (project title, track name, arbitration venue, etc.) that live
  // outside the base recipient/owner/date/signatory columns.
  await pool.query(`ALTER TABLE boom_ndas ADD COLUMN IF NOT EXISTS template_id TEXT DEFAULT 'standard'`).catch(() => {});
  await pool.query(`ALTER TABLE boom_ndas ADD COLUMN IF NOT EXISTS template_data JSONB`).catch(() => {});
  await pool.query(`UPDATE boom_ndas SET template_id = 'standard' WHERE template_id IS NULL`).catch(() => {});

  // Artist Clearance Charts — structured per-album/per-EP per-track clearance
  // forms. Each row holds the structured form data; the generated XLSX (built
  // from server/templates/artist-clearance.xlsx populated with these fields)
  // lives in entity_files as entity_type='artist', so the artist's Documents
  // tab automatically surfaces it. file_id links back to that entity_files row.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS artist_clearances (
      id                          SERIAL PRIMARY KEY,
      artist_id                   INT REFERENCES artists(id) ON DELETE CASCADE,
      title                       TEXT,
      project_number              TEXT,
      product_commitment          TEXT,
      contractual_members         TEXT,
      effective_date              DATE,
      main_artist_royalty_account TEXT,
      artist_royalty_rate         TEXT,
      tracks                      JSONB DEFAULT '[]'::jsonb,
      file_id                     INT REFERENCES entity_files(id) ON DELETE SET NULL,
      created_by                  TEXT,
      created_at                  TIMESTAMP DEFAULT NOW(),
      updated_at                  TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_artist_clearances_artist ON artist_clearances (artist_id)`);

  // Market Street Label Waivers — short side-letter documents waiving Market Street's
  // exclusivity so a Market Street-signed artist can appear as co-primary artist
  // on another label's release. Same client-side jsPDF rendering pattern
  // as boom_ndas: we persist the structured form fields + the full
  // editable body string, the PDF is generated on-demand.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS boom_label_waivers (
      id                   SERIAL PRIMARY KEY,
      effective_date       DATE NOT NULL,
      boom_artist          TEXT NOT NULL,
      releasing_label      TEXT NOT NULL,
      other_label_artist   TEXT,
      song_title           TEXT NOT NULL,
      release_date         DATE,
      release_format       TEXT,
      royalty_percent      TEXT,
      contact_email        TEXT,
      signatory_name       TEXT,
      signatory_title      TEXT,
      custom_body          TEXT,
      created_by           TEXT,
      created_at           TIMESTAMP DEFAULT NOW()
    )
  `);
  // Tie each waiver to its artist + the generated PDF stored in entity_files
  // so the artist's Documents tab automatically surfaces the saved waiver.
  // Both columns are nullable for backwards-compat with rows that pre-date
  // the auto-attach feature.
  await pool.query(`ALTER TABLE boom_label_waivers ADD COLUMN IF NOT EXISTS artist_id INT REFERENCES artists(id) ON DELETE SET NULL`).catch(() => {});
  await pool.query(`ALTER TABLE boom_label_waivers ADD COLUMN IF NOT EXISTS file_id   INT REFERENCES entity_files(id) ON DELETE SET NULL`).catch(() => {});

  // Vendor aliases — allows vendors to have multiple names (DBA, business name, etc.)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vendor_aliases (
      id SERIAL PRIMARY KEY,
      primary_name TEXT NOT NULL,
      alias TEXT NOT NULL,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(alias)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vendor_aliases_alias ON vendor_aliases (LOWER(alias))`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vendor_aliases_primary ON vendor_aliases (LOWER(primary_name))`).catch(() => {});

  // What a vendor merge actually touched, so it can be UNDONE.
  //
  // A merge renames rows: `UPDATE expenses SET payee = target WHERE payee =
  // source`. Afterwards nothing records WHICH rows moved — bk_audit_log keeps the
  // two names and a sentence — so a name-based unmerge would rewrite every row
  // now called "Kate Stephenson" back to "Katherine Stephenson", including the
  // four that were always Kate. Storing the ids is what makes the reverse
  // row-precise instead of destructive.
  //
  // All four sides of a merge are addressable: expenses.payee,
  // expenses.vendor_name, the statement_payee_map rows it repointed (the step
  // that makes a merge stick), and the vendor_aliases row IF this merge inserted
  // it — a merge whose alias already existed must not delete it on undo.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vendor_merge_log (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      expense_ids INT[] NOT NULL DEFAULT '{}',
      vendor_name_ids INT[] NOT NULL DEFAULT '{}',
      payee_map_ids INT[] NOT NULL DEFAULT '{}',
      alias_inserted BOOLEAN DEFAULT FALSE,
      undone_at TIMESTAMP,
      undone_by VARCHAR(255),
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vendor_merge_log_created ON vendor_merge_log (created_at DESC)`).catch(() => {});

  // Additional saved email addresses per vendor (keyed by payee name, like
  // vendor_aliases). expenses.vendor_email stays the per-invoice contact;
  // these extras default into the CC line on payment-confirmation emails.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vendor_emails (
      id SERIAL PRIMARY KEY,
      vendor_name TEXT NOT NULL,
      email TEXT NOT NULL,
      label TEXT,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_emails_unique ON vendor_emails (LOWER(vendor_name), LOWER(email))`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vendor_emails_vendor ON vendor_emails (LOWER(vendor_name))`).catch(() => {});

  // In-app usage analytics — one row per client route change (see
  // routes/analytics.js + the ping in Layout.jsx). 180-day retention:
  // the Analytics page reads at most a year, and the table would grow
  // unbounded otherwise. Cleanup is idempotent and cheap on boot.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS page_views (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      ts TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_page_views_ts ON page_views (ts)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_page_views_path ON page_views (path)`).catch(() => {});
  await pool.query(`DELETE FROM page_views WHERE ts < NOW() - INTERVAL '180 days'`).catch(() => {});

  // Admin-built permission templates — named page-path sets applied from
  // the Settings → Permissions editor (alongside the hardcoded starter
  // presets). CRUD lives in routes/settings.js.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS permission_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      pages JSONB NOT NULL DEFAULT '[]',
      created_by TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_templates_name ON permission_templates (LOWER(name))`).catch(() => {});

  // Bank statements + parsed transactions (Statements page reconciliation).
  // matched_expense_id is always a family ROOT id; deleting a statement
  // removes its transactions (and their matches) but never touches expenses.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_statements (
      id SERIAL PRIMARY KEY,
      account VARCHAR(32) NOT NULL,
      filename TEXT,
      r2_key TEXT,
      period_start DATE,
      period_end DATE,
      txn_count INT DEFAULT 0,
      status VARCHAR(16) DEFAULT 'ready',
      error TEXT,
      uploaded_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE bank_statements ADD COLUMN IF NOT EXISTS status VARCHAR(16) DEFAULT 'ready'`).catch(() => {});
  await pool.query(`ALTER TABLE bank_statements ADD COLUMN IF NOT EXISTS error TEXT`).catch(() => {});
  // Upload receipt: what the automation did on ingest (dup_skipped,
  // auto_matched, rule_booked, rule_dismissed) — auditability for the robots.
  await pool.query(`ALTER TABLE bank_statements ADD COLUMN IF NOT EXISTS import_summary JSONB`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id SERIAL PRIMARY KEY,
      statement_id INT REFERENCES bank_statements(id) ON DELETE CASCADE,
      txn_date DATE,
      description TEXT,
      payee_guess TEXT,
      amount NUMERIC(14,2) NOT NULL,
      direction VARCHAR(8) DEFAULT 'debit',
      currency VARCHAR(8) DEFAULT 'USD',
      reference TEXT,
      fee NUMERIC(14,2),
      matched_expense_id INT,
      match_method VARCHAR(24),
      match_score REAL,
      matched_by VARCHAR(255),
      matched_at TIMESTAMP,
      dismissed BOOLEAN DEFAULT FALSE,
      dismissed_reason TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS payee_email TEXT`).catch(() => {});
  // Credits book as income (artist_income rows); debits book as expenses.
  await pool.query(`ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS matched_income_id INT`).catch(() => {});
  await pool.query(`ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS flagged BOOLEAN DEFAULT false`).catch(() => {});
  await pool.query(`ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS flagged_by VARCHAR(255)`).catch(() => {});
  // "This one never had an invoice." A meal, a payroll run, a rent payment: a
  // real cost with no document coming. NOT a dismissal — the money stays in the
  // P&L and in Coverage, it just stops counting as unfinished work.
  //
  // statement_no_invoice_rules already answers this for a whole CATEGORY or a
  // whole VENDOR. Neither scope fits one row, which is the scope people actually
  // reach for first: one Uber, not every Uber.
  await pool.query(`ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS no_invoice_expected BOOLEAN DEFAULT FALSE`).catch(() => {});
  // Which ledger vendor THIS ONE bank line belongs to, when a person overrules
  // what the descriptor says. Distinct from statement_payee_map, which maps a
  // whole bank descriptor and therefore moves every line carrying it — the two
  // answer different questions and both are needed. A person's decision here
  // outranks every inference.
  await pool.query(`ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS vendor_override TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS vendor_override_by TEXT`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS bank_txn_vendor_override_idx
                      ON bank_transactions (LOWER(vendor_override)) WHERE vendor_override IS NOT NULL`).catch(() => {});
  // Statement ending balance — the balance-sheet Cash line is bank-verified.
  await pool.query(`ALTER TABLE bank_statements ADD COLUMN IF NOT EXISTS ending_balance NUMERIC(14,2)`).catch(() => {});
  // When the CURRENT parse began. The stale-parse sweep used created_at, which
  // is the original upload date — fine for an upload (same moment) but wrong for
  // a re-parse of a months-old statement, where it is already far past the
  // timeout and the sweep would flip a healthy statement straight to 'error'.
  await pool.query(`ALTER TABLE bank_statements ADD COLUMN IF NOT EXISTS parse_started_at TIMESTAMP`).catch(() => {});
  // Opening balance, straight off the statement. With it, a statement proves
  // itself: opening + credits - debits must equal closing. Without it we could
  // only chain one statement to the previous one, which breaks on any gap and
  // can never validate the first statement of an account.
  await pool.query(`ALTER TABLE bank_statements ADD COLUMN IF NOT EXISTS beginning_balance NUMERIC(14,2)`).catch(() => {});
  // USD settlement of a foreign-currency transaction, as printed. Balance
  // reconciliation previously SKIPPED any statement containing a single
  // non-USD row — which meant PayPal, where foreign rows are routine, was
  // never arithmetically checked at all.
  await pool.query(`ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS amount_usd NUMERIC(14,2)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bank_txns_statement ON bank_transactions (statement_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bank_txns_matched ON bank_transactions (matched_expense_id)`).catch(() => {});
  // "Always dismiss" patterns for statement reconciliation — payroll, rent,
  // transfers recur monthly; a rule auto-dismisses matching debits on upload.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS statement_dismiss_rules (
      id SERIAL PRIMARY KEY,
      pattern TEXT NOT NULL,
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Match memory: every manual match / created entry teaches the matcher
  // which ledger vendor a bank descriptor belongs to. Future auto-match
  // runs treat the learned pairing as an exact name hit.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS statement_payee_map (
      id SERIAL PRIMARY KEY,
      bank_payee TEXT NOT NULL,
      ledger_payee TEXT NOT NULL,
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_stmt_payee_map_bank ON statement_payee_map (LOWER(bank_payee))`).catch(() => {});
  // Category rules: recurring non-invoiced overhead (Ubers, travel, software)
  // auto-books as approved+Paid ledger entries with the rule's category on
  // every statement upload.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS statement_category_rules (
      id SERIAL PRIMARY KEY,
      pattern TEXT NOT NULL,
      category VARCHAR(100) NOT NULL,
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Artist attribution rules: "spend with this vendor belongs to this artist",
  // or with a NULL artist, "this vendor is overhead and never gets one".
  //
  // Exists because 2,320 booked rows worth $3.26M carry a category but no
  // artist — the bank told us money left, a person typed what kind of spend it
  // was, and nobody could say who it was FOR. That is why Spend by Artist
  // covers a sixth of actual spend.
  //
  // Deliberately keyed on the vendor, not the row. The money is concentrated
  // (top 25 vendors are 79% of it), and the artist is a property of the
  // relationship, not of one charge — so answering once fixes the history AND
  // every future statement. Learning it automatically was measured and
  // rejected: only 95 of the 2,320 rows have a vendor that maps to exactly one
  // artist on invoiced rows, so this is a human answer with a memory, not an
  // inference.
  //
  // NULL artist is a real answer ("overhead"), not an absent one — hence the
  // separate is_overhead flag rather than reading NULL as "unanswered".
  await pool.query(`
    CREATE TABLE IF NOT EXISTS statement_artist_rules (
      id SERIAL PRIMARY KEY,
      pattern TEXT NOT NULL,
      artist VARCHAR(255),
      is_overhead BOOLEAN DEFAULT FALSE,
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_stmt_artist_rules_pattern
    ON statement_artist_rules (LOWER(pattern))`).catch(() => {});

  // "No invoice is ever coming for this" — the answer that lets the
  // booked-but-unmatched queue reach zero.
  //
  // A BOOKED row is an entry the app invented from a bank line: it has a
  // ledger id but no document behind it. Nobody billed us, we wrote down what
  // the bank did. So booked is not the same as complete, and the page that
  // exists to match bank lines to real invoices should say so.
  //
  // But 1,997 of the 2,321 booked rows ($1.95M) are payroll, partner draws,
  // rent, cards, royalties and meals — spend that will NEVER have an invoice.
  // Without a way to say that, the queue is permanently $3.26M and Coverage is
  // permanently 38%, and a number that can never improve is a number people
  // stop reading.
  //
  // scope 'category' answers ~10 rows of business truth at once (Salary, Rent,
  // Partner draws); scope 'vendor' handles the exceptions inside a category
  // that mostly does invoice.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS statement_no_invoice_rules (
      id SERIAL PRIMARY KEY,
      scope VARCHAR(16) NOT NULL,
      pattern TEXT NOT NULL,
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_stmt_no_invoice_rule
    ON statement_no_invoice_rules (scope, LOWER(TRIM(pattern)))`).catch(() => {});

  // Acknowledged statement flags — "I know, it's fine". Keyed by a stable
  // fingerprint (check type + the ids involved) so a re-check skips them.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS statement_flag_acks (
      id SERIAL PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ONE payment, SEVERAL invoices.
  //
  // `bank_transactions.matched_expense_id` has one slot, and the matcher requires
  // a single invoice to equal the payment to the cent — so a vendor paid for two
  // invoices in one transfer could never be reconciled at all. Measured on live
  // data: 8 such payments across 5 vendors, every part already marked Paid on the
  // day the money moved, permanently stuck in the "invoices to attach" pile.
  //
  // This table is the many side. `matched_expense_id` KEEPS holding the primary
  // invoice, and this table holds every attached invoice INCLUDING that primary,
  // so it is self-sufficient for new readers while the ~19 existing readers of
  // matched_expense_id keep working untouched.
  //
  // No per-link amount on purpose. A link says "this invoice is settled by this
  // bank line"; an amount column would be a second opinion about what an invoice
  // is worth, and the UI already shows the difference when the parts don't sum.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_txn_invoice_links (
      id SERIAL PRIMARY KEY,
      txn_id INT NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
      expense_id INT NOT NULL,
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (txn_id, expense_id)
    )
  `);
  // One invoice is settled by at most one bank line — the same invariant
  // /match and /rematch already enforce, stated in the schema so a second
  // claim cannot be written even by a path that forgets to check.
  // DROPPED (2026-08-18): one invoice may now be settled by SEVERAL bank rows —
  // a deposit and a balance, or a wire split across two days. The unique index
  // encoded "one invoice, one payment", which made the second instalment
  // impossible to record at all. Over-payment is still refused, by amount, in
  // /attach and /match; the composite unique below still stops the same row
  // being linked to the same invoice twice.
  await pool.query('DROP INDEX IF EXISTS bank_txn_invoice_links_expense_uq').catch(() => {});

  // Monthly close (soft): a month marked reconciled gets a badge; changes
  // after the close raise a flag rather than being blocked.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS statement_months (
      id SERIAL PRIMARY KEY,
      month_key VARCHAR(7) NOT NULL UNIQUE,
      reconciled_by VARCHAR(255),
      reconciled_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Negative match memory: pairings the operator explicitly rejected
  // (unmatched a pair, or dismissed a card that carried a suggestion).
  // Keyed by a txn FINGERPRINT (date|amount|normalized payee) so the "no"
  // survives statement re-uploads, where txn ids change.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS statement_match_rejections (
      id SERIAL PRIMARY KEY,
      txn_fingerprint TEXT NOT NULL,
      expense_root_id INTEGER NOT NULL,
      source VARCHAR(16),
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS statement_match_rejections_pair_idx
      ON statement_match_rejections (txn_fingerprint, expense_root_id)
  `).catch(() => {});

  // Report-level dismissals — items excluded from the P&L from the Reports
  // page, kept DELIBERATELY SEPARATE from bank_transactions.dismissed.
  //
  // The distinction is the point: a dismissed bank transaction means "the
  // statements pipeline decided this isn't spend" (internal transfers,
  // funding legs, always-dismiss rules — mostly machine decisions). A row
  // here means "a human looked at this in a report and said don't count it."
  // Mixing them would make it impossible to tell a sweep's judgment from a
  // person's, or to undo one without disturbing the other.
  //
  // Keyed by FINGERPRINT, not just txn id, for the same reason
  // statement_match_rejections is: statements get re-uploaded and txn ids
  // change, and a dismissal that resurrects itself on re-upload is worse
  // than no dismissal at all. txn_id is kept for joins and display, and is
  // allowed to go stale.
  //
  // These exclusions MOVE REPORTED TOTALS, so every row records who and
  // when, and the P&L discloses the excluded count and amount rather than
  // quietly reporting a smaller number.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_dismissals (
      id SERIAL PRIMARY KEY,
      txn_fingerprint TEXT,
      txn_id INTEGER,
      expense_id INTEGER,
      cell_kind VARCHAR(16),
      cell_key TEXT,
      reason TEXT,
      dismissed_by VARCHAR(255),
      dismissed_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT report_dismissals_one_ref
        CHECK ((txn_fingerprint IS NOT NULL) <> (expense_id IS NOT NULL))
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS report_dismissals_txn_idx
      ON report_dismissals (txn_fingerprint) WHERE txn_fingerprint IS NOT NULL
  `).catch(() => {});
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS report_dismissals_expense_idx
      ON report_dismissals (expense_id) WHERE expense_id IS NOT NULL
  `).catch(() => {});

  // Whole-P&L-LINE dismissals live in the same table as item dismissals, with
  // `scope` telling them apart. One table means one Dismissed tab, one restore
  // path, and one disclosure of what's been excluded.
  //
  // The semantics differ in one important way, though: an item dismissal is an
  // INSTANCE (this transaction), while a category dismissal is a standing
  // RULE — it excludes everything currently in that line AND anything that
  // lands there later. Dismissing "Bank Fees" that only hid the fees booked so
  // far would need re-doing every month, which defeats the point.
  await pool.query(`ALTER TABLE report_dismissals ADD COLUMN IF NOT EXISTS scope VARCHAR(12) NOT NULL DEFAULT 'item'`).catch(() => {});
  // The original CHECK required exactly one of txn_fingerprint / expense_id,
  // which a category row has neither of. Replace it with a scope-aware version.
  // DROP-then-ADD because ADD CONSTRAINT has no IF NOT EXISTS.
  await pool.query(`ALTER TABLE report_dismissals DROP CONSTRAINT IF EXISTS report_dismissals_one_ref`).catch(() => {});
  await pool.query(`ALTER TABLE report_dismissals DROP CONSTRAINT IF EXISTS report_dismissals_ref_shape`).catch(() => {});
  await pool.query(`
    ALTER TABLE report_dismissals ADD CONSTRAINT report_dismissals_ref_shape CHECK (
      (scope = 'item' AND ((txn_fingerprint IS NOT NULL) <> (expense_id IS NOT NULL)))
      OR
      (scope = 'category' AND txn_fingerprint IS NULL AND expense_id IS NULL
        AND cell_kind IS NOT NULL AND cell_key IS NOT NULL)
    )
  `).catch(() => {});
  // One rule per line. Case-insensitive so 'Bank Fees' and 'bank fees' can't
  // both be dismissed and then need restoring twice.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS report_dismissals_category_idx
      ON report_dismissals (cell_kind, LOWER(TRIM(cell_key))) WHERE scope = 'category'
  `).catch(() => {});

  // ── Balance-sheet exclusions ────────────────────────────────────────────────
  //
  // Two more scopes: 'bs_line' (a whole balance-sheet line — A/R, A/P, a cash
  // account, drawdowns) and 'bs_item' (one invoice / bill / drawdown inside a
  // line). Same table so there is still ONE Dismissed tab, one restore path and
  // one answer to "what has been excluded".
  //
  // They get their OWN scope values rather than reusing 'category' so that
  // dismissedCategoryKeys() — which selects `WHERE scope = 'category'` — can
  // never pick them up. A balance-sheet exclusion must not touch the P&L.
  //
  // bs_ref, not expense_id, and that is the load-bearing bit. A/P rows ARE
  // expenses, and report_dismissals_expense_idx is UNIQUE on expense_id — so
  // storing one here would mean a bill already hidden from the P&L worklist
  // could never also be excluded from the balance sheet, and vice versa. Those
  // are unrelated judgments about the same row. The ref is namespaced
  // ('ar:123' / 'ap:456' / 'adv:789') because the three lines draw from three
  // different tables whose ids collide freely.
  await pool.query(`ALTER TABLE report_dismissals ADD COLUMN IF NOT EXISTS bs_ref TEXT`).catch(() => {});
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS report_dismissals_bs_ref_idx
      ON report_dismissals (bs_ref) WHERE bs_ref IS NOT NULL
  `).catch(() => {});
  // One rule per balance-sheet line. Its OWN index rather than reusing the
  // category one: that index is partial on `scope = 'category'`, so a bs_line
  // row can never conflict with it and every re-exclusion would insert a
  // duplicate the restore path would then only half remove.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS report_dismissals_bs_line_idx
      ON report_dismissals (LOWER(TRIM(cell_key))) WHERE scope = 'bs_line'
  `).catch(() => {});
  // DROP-then-ADD: ADD CONSTRAINT has no IF NOT EXISTS. Same shape as the
  // category migration above, extended with the two balance-sheet branches.
  await pool.query(`ALTER TABLE report_dismissals DROP CONSTRAINT IF EXISTS report_dismissals_ref_shape`).catch(() => {});
  await pool.query(`
    ALTER TABLE report_dismissals ADD CONSTRAINT report_dismissals_ref_shape CHECK (
      (scope = 'item' AND ((txn_fingerprint IS NOT NULL) <> (expense_id IS NOT NULL)))
      OR
      (scope = 'category' AND txn_fingerprint IS NULL AND expense_id IS NULL
        AND cell_kind IS NOT NULL AND cell_key IS NOT NULL)
      OR
      (scope = 'bs_line' AND txn_fingerprint IS NULL AND expense_id IS NULL
        AND bs_ref IS NULL AND cell_key IS NOT NULL)
      OR
      (scope = 'bs_item' AND txn_fingerprint IS NULL AND expense_id IS NULL
        AND bs_ref IS NOT NULL)
    )
  `).catch(() => {});

  // Report-level MONTH reassignment — "this July payment is really June's".
  //
  // A salary paid on the 1st, an invoice settled a few days after period end: the
  // bank date and the period the money belongs to genuinely differ, and a P&L
  // bucketed strictly by statement date reads one month light and the next heavy
  // forever. This lets a person say otherwise, per transaction.
  //
  // REPORT-ONLY, and that is the whole design. The bank row keeps its real
  // txn_date, stays matched to its ledger entry, and the expense's payment_date
  // is untouched — so bank evidence, reconciliation flags and the Payments
  // dashboard scope all continue to agree with the statement that proves the
  // payment. Nothing here may ever be "improved" into rewriting a date.
  //
  // Keyed by FINGERPRINT for the same reason report_dismissals is: statements get
  // re-uploaded and txn ids change. txn_id is kept for joins and display and is
  // allowed to go stale. original_month is NOT redundant with the fingerprint's
  // date — bankRows uses it to widen its date window and find rows that were
  // moved INTO the range being reported, without scanning all of history.
  //
  // Like a dismissal, this MOVES A REPORTED TOTAL, so every row records who and
  // when, it is fully reversible, and the P&L discloses what was reassigned
  // rather than quietly showing different figures.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_month_overrides (
      id SERIAL PRIMARY KEY,
      txn_fingerprint TEXT NOT NULL,
      txn_id INTEGER,
      original_month CHAR(7) NOT NULL,
      target_month CHAR(7) NOT NULL,
      reason TEXT,
      moved_by VARCHAR(255),
      moved_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT report_month_overrides_shape CHECK (
        original_month ~ '^[0-9]{4}-[0-9]{2}$' AND target_month ~ '^[0-9]{4}-[0-9]{2}$'
      )
    )
  `);
  // One override per transaction. Re-assigning an already-moved row updates it
  // rather than stacking a second opinion on the same money.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS report_month_overrides_fp_idx
      ON report_month_overrides (txn_fingerprint)
  `).catch(() => {});
  // bankRows looks up "which overrides land in the range I'm reporting".
  await pool.query(`
    CREATE INDEX IF NOT EXISTS report_month_overrides_target_idx
      ON report_month_overrides (target_month)
  `).catch(() => {});

  // Learned payee→category lessons for statement suggestions: booking a
  // payee as a category twice makes it the auto-suggestion. bank_payee is
  // stored descriptor-normalized (codes/phone numbers stripped).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS statement_category_map (
      id SERIAL PRIMARY KEY,
      bank_payee TEXT NOT NULL,
      category VARCHAR(100) NOT NULL,
      times INT DEFAULT 1,
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS statement_category_map_payee_idx
      ON statement_category_map ((LOWER(bank_payee)))
  `).catch(() => {});

  // Personal recurring reminders (bell + one email per due cycle).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      link TEXT,
      cadence VARCHAR(20) DEFAULT 'monthly',
      day_of_month INT DEFAULT 1,
      next_due DATE NOT NULL,
      notify_email BOOLEAN DEFAULT true,
      active BOOLEAN DEFAULT true,
      last_emailed DATE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Clean up orphaned child expenses (parent was soft-deleted but children weren't)
  await pool.query(`
    UPDATE expenses SET deleted = true
    WHERE parent_id IS NOT NULL
      AND (deleted = false OR deleted IS NULL)
      AND parent_id IN (SELECT id FROM expenses WHERE deleted = true)
  `).catch(() => {});

  console.log('Schema migrations and data normalization applied.');
};

// One-time import of missing catalog releases from the checklist PDF.
// Runs once, tracked by _meta.checklist_imported flag.
// Market Street: data/missing_releases.json is an empty list — the Boom
// checklist was imported into this database on the first deploy by mistake
// and removed by hand on 2026-09-16. Keep the file empty.
const importChecklistReleases = async () => {
  try {
    // Check if already imported
    const metaCheck = await pool.query("SELECT value FROM _meta WHERE key = 'checklist_imported'").catch(() => ({ rows: [] }));
    if (metaCheck.rows.length > 0 && metaCheck.rows[0].value === 'true') return;

    const missing = require('./data/missing_releases.json');
    console.log(`Importing ${missing.length} missing catalog releases...`);

    // Load existing artists
    const { rows: artists } = await pool.query('SELECT id, name FROM artists');
    const artistMap = {};
    for (const a of artists) artistMap[a.name.toLowerCase()] = a.id;

    // Load existing releases
    const { rows: rels } = await pool.query(
      "SELECT LOWER(a.name) AS artist, LOWER(r.project_name) AS project FROM releases r JOIN artists a ON r.artist_id = a.id"
    );
    const existingSet = new Set(rels.map(r => `${r.artist}|||${r.project}`));

    let inserted = 0, artistsCreated = 0;
    for (const entry of missing) {
      const key = `${entry.artist.toLowerCase()}|||${entry.project.toLowerCase()}`;
      if (existingSet.has(key)) continue;

      // Find or create artist
      let artistId = artistMap[entry.artist.toLowerCase()];
      if (!artistId) {
        const res = await pool.query(
          'INSERT INTO artists (name, genre, total_releases, created_at) VALUES ($1, $2, 0, NOW()) RETURNING id',
          [entry.artist, '']
        );
        artistId = res.rows[0].id;
        artistMap[entry.artist.toLowerCase()] = artistId;
        artistsCreated++;
      }

      let releaseType = 'Single';
      const pL = entry.project.toLowerCase();
      if (pL.includes(' album') || pL.includes('deluxe')) releaseType = 'Album';
      else if (pL.includes(' ep') || pL.endsWith(' ep')) releaseType = 'EP';
      else if (pL.includes('remix')) releaseType = 'Remix';

      const isFuture = new Date(entry.date) > new Date();
      const priority = isFuture ? 'Medium' : 'Low';

      await pool.query(
        `INSERT INTO releases (artist_id, project_name, release_date, release_type, priority, in_catalog, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
        [artistId, entry.project, entry.date, releaseType, priority, !isFuture]
      );
      inserted++;
      existingSet.add(key);
    }

    // Update artist counts
    await pool.query('UPDATE artists SET total_releases = (SELECT COUNT(*) FROM releases WHERE releases.artist_id = artists.id)');

    // Mark as done
    await pool.query("INSERT INTO _meta (key, value) VALUES ('checklist_imported', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'");
    console.log(`Checklist import complete: ${inserted} releases added, ${artistsCreated} new artists.`);
  } catch (err) {
    console.error('Checklist import error:', err.message);
  }
};

// Auto-seed: only runs on first deploy (no tables) or when FORCE_RESEED=true.
// FORCE_RESEED wipes ALL data — only use when DB schema changes require a full reset.
const autoSeed = async () => {
  try {
    const forceReseed = process.env.FORCE_RESEED === 'true';
    const tableCheck = await pool.query("SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'users')");

    if (!tableCheck.rows[0].exists) {
      console.log('No tables found — running initial seed...');
      const seed = require('./seed');
      await seed();
      await runMigrations();
      return;
    }

    if (forceReseed) {
      console.log('FORCE_RESEED=true — dropping all tables and reseeding...');
      await pool.query('DROP TABLE IF EXISTS activity_log, tasks, releases, contracts, deals, requests, users, artists, _meta CASCADE');
      const seed = require('./seed');
      await seed();
      await runMigrations();
      console.log('Reseed complete. Remove FORCE_RESEED from Railway env vars.');
      return;
    }

    // Normal deploy: run migrations + sync users, leave everything else alone
    await runMigrations();
    await syncUsers();

    // One-time: import missing catalog releases from checklist PDF (non-blocking)
    importChecklistReleases().catch(err => console.error('Checklist import error:', err.message));
  } catch (err) {
    console.error('Auto-seed check failed:', err.message);
  } finally {
    // Now that migrations have had their run, tell the bank-evidence fragments
    // whether the link table exists. Until this flips, they emit the SQL they
    // emitted before one-payment-many-invoices existed — which is correct for
    // every row written before it, and keeps every list endpoint answering
    // instead of 500ing on a table that is still being created.
    //
    // In `finally` deliberately: a migration that throws must not leave the
    // probe unrun, or a single unrelated migration failure would silently
    // disable the feature for the whole process lifetime.
    const { markLinksReady } = require('./lib/bank-evidence');
    const ready = await markLinksReady(pool);
    console.log(`[bank-evidence] multi-invoice links ${ready ? 'ENABLED' : 'not yet — using single-link SQL'}`);
  }
};

const PORT = process.env.PORT || 3001;

// The message board needs websockets, and socket.io attaches to the underlying
// http.Server rather than to the Express app — so the boot goes through
// http.createServer() instead of app.listen(). Nothing else about the listen
// changes: autoSeed() still runs INSIDE the callback, in the background, after
// the port is open, exactly as before.
//
// realtime.init() must run BEFORE listen() so the upgrade handler is attached
// when the first connection arrives. Railway needs no config change for this.
const http = require('http');
const server = http.createServer(app);
require('./lib/realtime').init(server);

server.listen(PORT, () => {
  console.log(`Market Street Dashboard server running on port ${PORT}`);
  // Run migrations in background — don't block request handling
  autoSeed().catch(err => console.error('Auto-seed failed:', err.message));
});
