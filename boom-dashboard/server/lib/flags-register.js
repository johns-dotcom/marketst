// The flag REGISTER — Flags as the label's exception list, with memory.
//
// Before this, /flags recomputed 23 data-quality checks on every open and
// remembered nothing: no "new since you last looked", no age, no owner, and
// nothing pushed a flag anywhere. Detection was also scattered — the bell ran
// 13 checks of its own, Home and the emails a few more, Contracts three,
// Approvals the AI scans — and failed emails, failed QuickBooks pushes and a
// blank Label record were computed and shown nowhere.
//
// The register is one table, `flag_register`, keyed (kind, key), written by a
// SWEEP that runs every detector below plus the data-quality detectors in
// routes/flags.js. A row is upserted while its condition holds (first_seen
// kept, last_seen bumped) and marked resolved when a sweep no longer sees it.
// From that one table come: NEW (first_seen after the viewer's last visit),
// AGE, RESOLVED history, assignment (a task in My Work), dismiss/snooze bound
// to a FINGERPRINT of the flagged value so a changed row resurfaces, and the
// Home tile + My Work row (summaryFor).
//
// Freshness is HOURLY (John, 2026-09-19): integrations-worker claims
// `flags_sweep` once per hour; the page's ⟳ runs one now for an admin.
//
// A detector that THROWS does not clear its rows — a skip is invisible and
// "no flag" must never mean "proved" (the statements lesson). Its error lands
// in flag_sweeps.errors and GET /flags renders "this check could not run".
//
// Gating follows the Home loop: every kind carries the PAGE that resolves it
// and is shown only to somebody who could open that page (pagesReachable);
// bank and setup kinds additionally carry roles.
const crypto = require('crypto');
const pool = require('../db');
const { pagesReachable } = require('../middleware/pagePermission');
const { usdOf } = require('./usd');

// ── Thresholds ──────────────────────────────────────────────────────────────
// Days. One place, so a stall is defined once.
const DAYS = {
  approval_stale: 3,        // pending this long is a stall (high after approval_high)
  approval_high: 7,
  payment_unscheduled: 7,   // approved this long with no payable date
  hold_aging: 14,
  rush_unpaid: 2,
  envelope_stuck: 14,
  onboarding_stalled: 14,
  invite_pending: 3,
  never_signed_in: 14,
  stats_stale: 3,
  mail_failed_window: 7,
  deal_stale: 21,           // a live deal with no stage move this long
};

const ADMIN = new Set(['Admin', 'Superadmin']);
const BK = new Set(['Admin', 'Superadmin', 'Approver']);

const fp = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const daysSince = (d) => (d ? Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000)) : null);
const money = (rows) => round2(rows.reduce((t, r) => t + (usdOf(r.amount, r.currency, r.fx_rate_to_usd) || 0), 0));

// Alive ledger rows — the predicate every bookkeeping query uses.
const ALIVE = `(e.deleted = false OR e.deleted IS NULL) AND (e.voided = false OR e.voided IS NULL)`;
const UNPAID = `e.payment_status IS DISTINCT FROM 'Paid'`;
const ROOT = `e.parent_id IS NULL`;
const ISO_DAY = `e.scheduled_payment_date ~ '^\\d{4}-\\d{2}-\\d{2}'`;

// ── Schema ──────────────────────────────────────────────────────────────────
async function ensureSchema() {
  const run = (sql) => pool.query(sql).catch((e) => console.warn('[flags-register] migration:', e.message));
  await run(`CREATE TABLE IF NOT EXISTS flag_register (
    kind TEXT NOT NULL, key TEXT NOT NULL,
    fingerprint TEXT, severity TEXT NOT NULL DEFAULT 'medium',
    title TEXT NOT NULL, detail TEXT, to_path TEXT, usd NUMERIC(14,2), payload JSONB,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    dismissed_at TIMESTAMPTZ, dismissed_by INTEGER, dismissed_fingerprint TEXT, snooze_until TIMESTAMPTZ,
    task_id INTEGER,
    PRIMARY KEY (kind, key)
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_flag_register_open ON flag_register (kind) WHERE resolved_at IS NULL`);
  await run(`CREATE TABLE IF NOT EXISTS flag_sweeps (
    id SERIAL PRIMARY KEY, ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), duration_ms INTEGER,
    trigger TEXT, counts JSONB, errors JSONB
  )`);
  // Who owns a category or a flag: one task per assignment. key '*' = the whole category.
  await run(`CREATE TABLE IF NOT EXISTS flag_assignments (
    kind TEXT NOT NULL, key TEXT NOT NULL,
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    assigned_to INTEGER REFERENCES users(id) ON DELETE CASCADE,
    assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (kind, key)
  )`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS flags_seen_at TIMESTAMPTZ`);
  await run(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS flag_kind TEXT`);
  await run(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS flag_key TEXT`);
  // Row-level dismissals (routes/flags.js) now remember the VALUE they waved
  // off, so a row whose artist changes to a different wrong name resurfaces.
  await run(`ALTER TABLE flag_dismissals ADD COLUMN IF NOT EXISTS value_fingerprint TEXT`);
  // Which expense categories must name an artist and a song. Was a hard-coded
  // list of ten Boom category names in routes/flags.js — on a label whose
  // categories are named differently the check fired on zero rows.
  await run(`ALTER TABLE bk_categories ADD COLUMN IF NOT EXISTS artist_required BOOLEAN`);
  await run(`UPDATE bk_categories SET artist_required = TRUE
    WHERE kind = 'expense' AND artist_required IS NULL AND name IN
      ('Marketing', 'PR', 'Radio', 'Recording', 'Music Video', 'Production', 'Sync/Licensing',
       'Mixing & Mastering', 'Distribution', 'Design', 'Advertisements', 'Advance')`);
  await run(`UPDATE bk_categories SET artist_required = FALSE WHERE kind = 'expense' AND artist_required IS NULL`);
}

// ── Detectors ───────────────────────────────────────────────────────────────
// Each: { kind, group, label, description, page, roles?, run: async () => item[] }
// item: { key, title, detail?, usd?, severity?, to?, fingerprint?, payload? }
// `to` defaults to the kind's page. Keep each detector to ONE question.

const SETUP = 'Setup', WORKFLOW = 'Workflow', COMPLIANCE = 'Compliance', MONEY = 'Money';

const LABEL_REQUIRED = [
  ['legal_name', 'Legal name'], ['display_name', 'Display name'], ['address_line1', 'Address line 1'],
  ['address_line2', 'City, state, ZIP'], ['contact_name', 'Contact name'], ['contact_email', 'Contact email'],
  ['contact_phone', 'Contact phone'], ['signatory_name', 'Signatory name'], ['signatory_title', 'Signatory title'],
  ['signatory_email', 'Signatory email'], ['default_payment_terms', 'Default payment terms'],
  ['bank_name', 'Bank name'], ['bank_account_name', 'Name on the account'], ['bank_routing_ach', 'Routing (ACH)'],
];
// Blank here and an invoice or a DocuSign envelope goes out wrong.
const LABEL_CRITICAL = new Set(['legal_name', 'address_line1', 'contact_email', 'signatory_name', 'signatory_email', 'bank_name', 'bank_account_name', 'bank_routing_ach']);

const DETECTORS = [
  // ── Setup & ops (Admin/Superadmin, resolved under Settings) ──────────────
  {
    kind: 'label_incomplete', group: SETUP, label: 'Label record incomplete', page: '/settings', roles: ADMIN,
    description: 'Settings › Label prints on every invoice, NDA and waiver and names the DocuSign countersigner. A blank field prints blank.',
    async run() {
      const { rows: [l] } = await pool.query(`SELECT * FROM label_settings LIMIT 1`).catch(() => ({ rows: [] }));
      const blanks = LABEL_REQUIRED.filter(([k]) => !String((l || {})[k] || '').trim());
      // EIN and the account number are encrypted; the column is *_enc.
      if (l && !l.ein_enc) blanks.push(['ein', 'EIN']);
      if (l && !l.bank_account_enc) blanks.push(['bank_account', 'Bank account number']);
      if (!blanks.length) return [];
      const critical = blanks.filter(([k]) => LABEL_CRITICAL.has(k) || k === 'ein' || k === 'bank_account');
      return [{
        key: 'label', severity: critical.length ? 'high' : 'medium', to: '/settings?tab=label',
        title: `${plural(blanks.length, 'label field')} blank`,
        detail: blanks.map(([, n]) => n).join(', '),
        fingerprint: fp(blanks.map(([k]) => k)),
      }];
    },
  },
  {
    kind: 'encryption_key', group: SETUP, label: 'Encryption key', page: '/settings', roles: ADMIN,
    description: 'PAYMENT_DETAILS_KEY encrypts vendor bank details, the label EIN, and the QuickBooks, DocuSign and mailbox tokens. Without it none of those can be stored.',
    async run() {
      const ok = require('./payment-crypto').isConfigured();
      return ok ? [] : [{ key: 'env', severity: 'high', to: '/settings?tab=integrations', title: 'Encryption key not set',
        detail: process.env.PAYMENT_DETAILS_KEY ? 'PAYMENT_DETAILS_KEY is set but is not 32 bytes (64 hex chars)' : 'Set PAYMENT_DETAILS_KEY on Railway' }];
    },
  },
  {
    kind: 'mail_setup', group: SETUP, label: 'Mail not connected', page: '/settings', roles: ADMIN,
    description: 'Invites, approval summaries, payment confirmations and task emails go through a connected mailbox. Each purpose needs one.',
    async run() {
      const { rows: boxes } = await pool.query(`SELECT id, address, kind, status, last_error FROM mailboxes ORDER BY id`).catch(() => ({ rows: [] }));
      const out = [];
      const active = boxes.filter((b) => b.status === 'active');
      if (!active.length) {
        out.push({ key: 'none', severity: 'medium', to: '/settings?tab=integrations', title: 'No mailbox connected', detail: 'Nothing the app sends can leave until a shared mailbox is connected under Settings › Integrations.' });
      }
      for (const b of boxes.filter((x) => x.status === 'needs_reconnect')) {
        out.push({ key: `reconnect:${b.id}`, severity: 'high', to: '/settings?tab=integrations', title: `${b.address} needs reconnecting`, detail: b.last_error || 'Google revoked the token; mail from this box is not being sent.', fingerprint: fp([b.status, b.last_error]) });
      }
      if (active.length) {
        const { PURPOSES } = require('./mail');
        const { rows: assigned } = await pool.query(`SELECT purpose FROM mail_purposes WHERE mailbox_id IS NOT NULL`).catch(() => ({ rows: [] }));
        const have = new Set(assigned.map((r) => r.purpose));
        const missing = (PURPOSES || []).filter((p) => !have.has(p.key));
        if (missing.length) out.push({ key: 'purposes', severity: 'medium', to: '/settings?tab=integrations', title: `${plural(missing.length, 'mail purpose')} with no mailbox`, detail: missing.map((p) => `${p.label}: ${p.what}`).join(' · '), fingerprint: fp(missing.map((p) => p.key)) });
      }
      return out;
    },
  },
  {
    kind: 'mail_failed', group: SETUP, label: 'Emails that failed to send', page: '/settings', roles: ADMIN,
    description: `Sends the mail log recorded as failed in the last ${DAYS.mail_failed_window} days, by kind. The recipient never got it.`,
    async run() {
      const { rows } = await pool.query(
        `SELECT COALESCE(kind, purpose, 'unknown') AS kind, COUNT(*)::int AS n, MAX(created_at) AS last_at,
                (ARRAY_AGG(error ORDER BY created_at DESC))[1] AS last_error
           FROM mail_log WHERE status <> 'sent' AND status <> 'dry_run' AND created_at > NOW() - ($1 || ' days')::interval
          GROUP BY 1 ORDER BY n DESC`, [String(DAYS.mail_failed_window)]).catch(() => ({ rows: [] }));
      return rows.map((r) => ({ key: r.kind, severity: 'medium', to: '/settings?tab=integrations', title: `${plural(r.n, `${r.kind} email`)} failed`, detail: r.last_error || 'see the mail log', fingerprint: fp([r.n, r.last_error]) }));
    },
  },
  {
    kind: 'integration_reconnect', group: SETUP, label: 'Integration needs reconnecting', page: '/settings', roles: ADMIN,
    description: 'QuickBooks or DocuSign rejected the stored token. Pushes and signature polls stop until somebody reconnects under Settings › Integrations.',
    async run() {
      const out = [];
      const { rows: [q] } = await pool.query(`SELECT status, last_error, company_name FROM qbo_connection WHERE id = 1`).catch(() => ({ rows: [] }));
      if (q && q.status === 'needs_reconnect') out.push({ key: 'quickbooks', severity: 'high', to: '/settings?tab=integrations', title: `QuickBooks${q.company_name ? ` (${q.company_name})` : ''} needs reconnecting`, detail: q.last_error || 'Approved invoices and payments are queuing, not posting.', fingerprint: fp(q.last_error) });
      const { rows: [d] } = await pool.query(`SELECT status, last_error, account_name FROM docusign_account WHERE id = 1`).catch(() => ({ rows: [] }));
      if (d && d.status === 'needs_reconnect') out.push({ key: 'docusign', severity: 'high', to: '/settings?tab=integrations', title: `DocuSign${d.account_name ? ` (${d.account_name})` : ''} needs reconnecting`, detail: d.last_error || 'Envelopes cannot be sent or polled.', fingerprint: fp(d.last_error) });
      return out;
    },
  },
  {
    kind: 'qbo_failed', group: SETUP, label: 'QuickBooks pushes that failed', page: '/settings', roles: ADMIN,
    description: 'A bill or payment Intuit refused, with its sentence. Retry from the QuickBooks card once the cause is fixed.',
    async run() {
      const { rows } = await pool.query(
        `SELECT q.id, q.kind, q.last_error, q.attempts, e.payee, e.amount, e.currency, e.fx_rate_to_usd, e.invoice_number
           FROM qbo_queue q JOIN expenses e ON e.id = q.expense_id WHERE q.status = 'error' ORDER BY q.id`).catch(() => ({ rows: [] }));
      return rows.map((r) => ({ key: String(r.id), severity: 'medium', to: '/settings?tab=integrations', usd: money([r]),
        title: `${r.kind === 'payment' ? 'Payment' : 'Bill'} for ${r.payee}${r.invoice_number ? ` #${r.invoice_number}` : ''} not in QuickBooks`,
        detail: r.last_error || `${r.attempts} attempts`, fingerprint: fp([r.last_error, r.attempts]) }));
    },
  },
  {
    kind: 'qbo_unmapped', group: SETUP, label: 'Categories not mapped to QuickBooks accounts', page: '/settings', roles: ADMIN,
    description: 'A push fails naming the category when it has no account and there is no default. Map them on the QuickBooks card.',
    async run() {
      const { rows: [q] } = await pool.query(`SELECT status, settings FROM qbo_connection WHERE id = 1`).catch(() => ({ rows: [] }));
      if (!q) return [];
      const s = q.settings || {};
      if (s.default_expense_account) return [];
      const map = s.category_map || {};
      const { rows } = await pool.query(`SELECT name FROM bk_categories WHERE kind = 'expense' AND COALESCE(active, true) ORDER BY sort_order NULLS LAST, name`).catch(() => ({ rows: [] }));
      const missing = rows.map((r) => r.name).filter((n) => !map[n]);
      return missing.length ? [{ key: 'map', severity: 'medium', to: '/settings?tab=integrations', title: `${plural(missing.length, 'category', 'categories')} with no QuickBooks account`, detail: missing.join(', '), fingerprint: fp(missing) }] : [];
    },
  },
  {
    kind: 'env_missing', group: SETUP, label: 'Service not configured', page: '/settings', roles: ADMIN,
    description: 'Keys the server reads from the environment. Each names what stops working without it.',
    async run() {
      const out = [];
      if (!process.env.ANTHROPIC_API_KEY) out.push({ key: 'ai', severity: 'medium', to: '/settings?tab=integrations', title: 'AI key not set', detail: 'Invoice reading, W-9 checks and the statement-parser fallback are off; the invoice-number gate falls open.' });
      const r2 = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'].every((k) => !!process.env[k]);
      if (!r2 && process.env.NODE_ENV === 'production') out.push({ key: 'storage', severity: 'low', to: '/settings?tab=integrations', title: 'File storage (R2) not configured', detail: 'Invoices, W-9s and documents are being stored in the database column instead.' });
      return out;
    },
  },
  {
    kind: 'artist_stats_stale', group: SETUP, label: 'Artist stats not refreshing', page: '/settings', roles: ADMIN,
    description: `Spotify is configured and artists are tracked, but no row has been written for ${DAYS.stats_stale} days. The daily job may not be running.`,
    async run() {
      if (!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET)) return [];
      const { rows: [r] } = await pool.query(`SELECT MAX(fetched_at) AS t, COUNT(DISTINCT artist_id)::int AS n FROM artist_stats WHERE source = 'spotify'`).catch(() => ({ rows: [{}] }));
      if (!r?.n || !r.t) return [];
      const d = daysSince(r.t);
      return d >= DAYS.stats_stale ? [{ key: 'spotify', severity: 'low', to: '/settings?tab=integrations', title: `Artist stats last written ${plural(d, 'day')} ago`, detail: `${r.n} artists tracked`, fingerprint: fp(d) }] : [];
    },
  },
  {
    kind: 'statement_overdue', group: MONEY, label: 'Bank statement never came', page: '/bk/statements', roles: ADMIN,
    description: 'An account whose next statement is late by its own cadence (median gap between period ends, plus five days). The gap flag cannot see the newest month; this can.',
    async run() {
      const { expectedNext } = require('./statement-integrity');
      const { rows } = await pool.query(`SELECT account, period_end FROM bank_statements WHERE period_end IS NOT NULL AND COALESCE(status, 'ready') <> 'error' ORDER BY period_end`);
      const by = {};
      for (const r of rows) (by[r.account] = by[r.account] || []).push(r);
      return Object.entries(by).map(([account, stmts]) => ({ account, ...expectedNext(stmts, new Date()) }))
        .filter((a) => a.overdue)
        .map((a) => ({ key: a.account, severity: 'high', title: `${a.account} statement overdue`, detail: `${plural(a.days_since, 'day')} since the last one${a.expected_by ? ` · expected by ${String(a.expected_by).slice(0, 10)}` : ''}`, fingerprint: fp(a.days_since) }));
    },
  },
  {
    kind: 'invite_pending', group: SETUP, label: 'Invites not used', page: '/team', roles: ADMIN,
    description: `Somebody was invited and has not set a password. Expired links need a new one from People; pending ones older than ${DAYS.invite_pending} days may need a nudge.`,
    async run() {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (u.id) u.id, u.name, u.email, i.expires_at, i.created_at
           FROM user_invites i JOIN users u ON u.id = i.user_id
          WHERE i.used_at IS NULL AND u.password_hash IS NULL
          ORDER BY u.id, i.created_at DESC`).catch(() => ({ rows: [] }));
      return rows.flatMap((r) => {
        const expired = new Date(r.expires_at) < new Date();
        const age = daysSince(r.created_at);
        if (!expired && age < DAYS.invite_pending) return [];
        return [{ key: String(r.id), severity: expired ? 'medium' : 'low', to: '/team', title: `${r.name || r.email}: invite ${expired ? 'expired' : 'not used'}`, detail: expired ? 'Send a new link from People.' : `sent ${plural(age, 'day')} ago`, fingerprint: fp([expired]) }];
      });
    },
  },
  {
    kind: 'never_signed_in', group: SETUP, label: 'Accounts never used', page: '/team', roles: ADMIN,
    description: `Somebody with a password who has never signed in, ${DAYS.never_signed_in} days after the account was made.`,
    async run() {
      const { rows } = await pool.query(
        `SELECT u.id, u.name, u.email, u.created_at FROM users u
          WHERE u.password_hash IS NOT NULL AND u.created_at < NOW() - ($1 || ' days')::interval
            AND NOT EXISTS (SELECT 1 FROM user_login_logs l WHERE l.user_id = u.id)
          ORDER BY u.created_at`, [String(DAYS.never_signed_in)]).catch(() => ({ rows: [] }));
      return rows.map((r) => ({ key: String(r.id), severity: 'low', to: `/team/${r.id}`, title: `${r.name || r.email} has never signed in`, detail: `account made ${plural(daysSince(r.created_at), 'day')} ago` }));
    },
  },

  // ── Workflow stalls ──────────────────────────────────────────────────────
  {
    kind: 'approval_stale', group: WORKFLOW, label: 'Approvals waiting too long', page: '/bk/approvals', roles: BK,
    description: `Invoices pending for more than ${DAYS.approval_stale} days. The vendor is waiting on a decision; after ${DAYS.approval_high} days it is high.`,
    async run() {
      const { rows } = await pool.query(
        `SELECT e.id, e.payee, e.amount, e.currency, e.fx_rate_to_usd, e.invoice_number, e.created_at FROM expenses e
          WHERE e.status = 'pending' AND ${ALIVE} AND ${ROOT} AND e.created_at < NOW() - ($1 || ' days')::interval ORDER BY e.created_at`, [String(DAYS.approval_stale)]);
      return rows.map((r) => { const d = daysSince(r.created_at); return { key: String(r.id), severity: d >= DAYS.approval_high ? 'high' : 'medium', usd: money([r]), to: '/bk/approvals', title: `${r.payee}${r.invoice_number ? ` #${r.invoice_number}` : ''} waiting ${plural(d, 'day')}`, detail: 'pending approval', fingerprint: fp([r.amount, d >= DAYS.approval_high]) }; });
    },
  },
  {
    kind: 'payment_overdue', group: WORKFLOW, label: 'Payments past due', page: '/bk/payments', roles: BK,
    description: 'Approved, unpaid, not on hold, and the scheduled payment date has passed.',
    async run() {
      const { rows } = await pool.query(
        `SELECT e.id, e.payee, e.amount, e.currency, e.fx_rate_to_usd, e.invoice_number, e.scheduled_payment_date FROM expenses e
          WHERE e.status = 'approved' AND ${UNPAID} AND ${ALIVE} AND ${ROOT} AND (e.on_hold = false OR e.on_hold IS NULL)
            AND ${ISO_DAY} AND e.scheduled_payment_date::date < CURRENT_DATE ORDER BY e.scheduled_payment_date`);
      return rows.map((r) => { const d = daysSince(r.scheduled_payment_date); return { key: String(r.id), severity: 'high', usd: money([r]), to: '/bk/payments', title: `${r.payee}${r.invoice_number ? ` #${r.invoice_number}` : ''} ${plural(d, 'day')} past due`, detail: `due ${String(r.scheduled_payment_date).slice(0, 10)}`, fingerprint: fp([r.amount, r.scheduled_payment_date]) }; });
    },
  },
  {
    kind: 'payment_unscheduled', group: WORKFLOW, label: 'Approved with no payable date', page: '/bk/payments', roles: BK,
    description: `Approved ${DAYS.payment_unscheduled}+ days ago, unpaid, and the scheduled date is empty or not a real date — so no due-date check can see it.`,
    async run() {
      const { rows } = await pool.query(
        `SELECT e.id, e.payee, e.amount, e.currency, e.fx_rate_to_usd, e.invoice_number, e.scheduled_payment_date, COALESCE(e.approved_at, e.created_at) AS since FROM expenses e
          WHERE e.status = 'approved' AND ${UNPAID} AND ${ALIVE} AND ${ROOT} AND (e.on_hold = false OR e.on_hold IS NULL)
            AND NOT (${ISO_DAY}) AND COALESCE(e.approved_at, e.created_at) < NOW() - ($1 || ' days')::interval ORDER BY 8`, [String(DAYS.payment_unscheduled)]);
      return rows.map((r) => ({ key: String(r.id), severity: 'medium', usd: money([r]), to: '/bk/payments', title: `${r.payee}${r.invoice_number ? ` #${r.invoice_number}` : ''}: no payment date`, detail: r.scheduled_payment_date ? `"${r.scheduled_payment_date}" is not a date` : `approved ${plural(daysSince(r.since), 'day')} ago`, fingerprint: fp([r.amount, r.scheduled_payment_date]) }));
    },
  },
  {
    kind: 'hold_aging', group: WORKFLOW, label: 'On hold too long', page: '/bk/payments', roles: BK,
    description: `Unpaid and on hold for more than ${DAYS.hold_aging} days, with the reason given. A hold is a pause, not a decision.`,
    async run() {
      const { rows } = await pool.query(
        `SELECT e.id, e.payee, e.amount, e.currency, e.fx_rate_to_usd, e.invoice_number, e.hold_at, e.hold_reason FROM expenses e
          WHERE e.on_hold = true AND ${UNPAID} AND ${ALIVE} AND ${ROOT} AND COALESCE(e.hold_at, e.created_at) < NOW() - ($1 || ' days')::interval ORDER BY e.hold_at`, [String(DAYS.hold_aging)]);
      return rows.map((r) => ({ key: String(r.id), severity: 'medium', usd: money([r]), to: '/bk/payments', title: `${r.payee}${r.invoice_number ? ` #${r.invoice_number}` : ''} on hold ${plural(daysSince(r.hold_at) ?? DAYS.hold_aging, 'day')}`, detail: r.hold_reason || 'no reason recorded', fingerprint: fp([r.amount, r.hold_reason]) }));
    },
  },
  {
    kind: 'rush_unpaid', group: WORKFLOW, label: 'Rush requests still unpaid', page: '/bk/payments', roles: BK,
    description: `Somebody asked for a rush and it is still unpaid ${DAYS.rush_unpaid} days later.`,
    async run() {
      const { rows } = await pool.query(
        `SELECT e.id, e.payee, e.amount, e.currency, e.fx_rate_to_usd, e.invoice_number, e.rush_requested_at, e.rush_requested_by FROM expenses e
          WHERE e.rush_requested = true AND ${UNPAID} AND ${ALIVE} AND ${ROOT} AND COALESCE(e.rush_requested_at, e.created_at) < NOW() - ($1 || ' days')::interval ORDER BY e.rush_requested_at`, [String(DAYS.rush_unpaid)]);
      return rows.map((r) => ({ key: String(r.id), severity: 'high', usd: money([r]), to: '/bk/payments', title: `Rush: ${r.payee}${r.invoice_number ? ` #${r.invoice_number}` : ''} unpaid ${plural(daysSince(r.rush_requested_at) ?? DAYS.rush_unpaid, 'day')} after the request`, detail: r.rush_requested_by ? `asked by ${r.rush_requested_by}` : null, fingerprint: fp([r.amount]) }));
    },
  },
  {
    kind: 'envelope_stuck', group: WORKFLOW, label: 'Signatures out too long', page: '/contracts', roles: BK,
    description: `A DocuSign envelope sent ${DAYS.envelope_stuck}+ days ago and not completed, or one DocuSign reported an error on.`,
    async run() {
      const { rows } = await pool.query(
        `SELECT id, doc_type, title, signer_name, signer_email, status, sent_at, last_error FROM signature_envelopes
          WHERE status NOT IN ('completed', 'declined', 'voided') AND (sent_at < NOW() - ($1 || ' days')::interval OR last_error IS NOT NULL) ORDER BY sent_at`, [String(DAYS.envelope_stuck)]).catch(() => ({ rows: [] }));
      const to = { contract: '/contracts', nda: '/create-nda', waiver: '/create-label-waiver' };
      return rows.map((r) => ({ key: String(r.id), severity: r.last_error ? 'high' : 'medium', to: to[r.doc_type] || '/contracts', title: `${r.title} — ${r.signer_name} has not signed (${plural(daysSince(r.sent_at), 'day')})`, detail: r.last_error || `status ${r.status}`, fingerprint: fp([r.status, r.last_error]) }));
    },
  },
  {
    kind: 'deal_signed_no_contract', group: WORKFLOW, label: 'Signed deals with no contract', page: '/contracts', roles: BK,
    description: 'A deal moved to Signed and the artist joined the roster, but no contract row exists for them yet.',
    async run() {
      const { rows } = await pool.query(
        `SELECT d.id, d.artist_name, d.signed_at, a.id AS artist_id, a.name FROM deals d JOIN artists a ON a.id = d.signed_artist_id
          WHERE d.stage = 'Signed' AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.artist_id = a.id) ORDER BY d.signed_at`).catch(() => ({ rows: [] }));
      return rows.map((r) => ({ key: String(r.id), severity: 'high', to: `/contracts?new=1&artist=${encodeURIComponent(r.name)}&deal=${r.id}`, title: `${r.name}: signed, no contract on file`, detail: r.signed_at ? `signed ${plural(daysSince(r.signed_at), 'day')} ago` : null }));
    },
  },
  {
    kind: 'deal_stale', group: WORKFLOW, label: 'Deals stuck in a stage', page: '/deals',
    description: `A live deal that has not moved stage in ${DAYS.deal_stale}+ days. Move it, pass on it, or set a follow-up.`,
    async run() {
      const { rows } = await pool.query(
        `SELECT d.id, d.artist_name, d.stage, u.name AS owner_name, COALESCE(d.stage_changed_at, d.updated_at, d.created_at) AS since
           FROM deals d LEFT JOIN users u ON u.id = d.owner_id
          WHERE d.stage NOT IN ('Signed','Passed') AND COALESCE(d.stage_changed_at, d.updated_at, d.created_at) < NOW() - ($1 || ' days')::interval
          ORDER BY since`, [DAYS.deal_stale]).catch(() => ({ rows: [] }));
      return rows.map((r) => ({ key: String(r.id), severity: daysSince(r.since) > DAYS.deal_stale * 2 ? 'high' : 'medium', to: `/deals?deal=${r.id}`, title: `${r.artist_name}: ${plural(daysSince(r.since), 'day')} in ${r.stage}`, detail: r.owner_name ? `owner ${r.owner_name}` : 'no owner', fingerprint: fp([r.stage]) }));
    },
  },
  {
    kind: 'deal_followup_overdue', group: WORKFLOW, label: 'Deal follow-ups overdue', page: '/deals',
    description: 'The follow-up date on a live deal has passed. Log the touch and set the next one.',
    async run() {
      const { rows } = await pool.query(
        `SELECT d.id, d.artist_name, d.stage, d.next_followup_date, u.name AS owner_name FROM deals d LEFT JOIN users u ON u.id = d.owner_id
          WHERE d.stage NOT IN ('Signed','Passed') AND d.next_followup_date < CURRENT_DATE ORDER BY d.next_followup_date`).catch(() => ({ rows: [] }));
      return rows.map((r) => ({ key: String(r.id), severity: daysSince(r.next_followup_date) > 7 ? 'high' : 'medium', to: `/deals?deal=${r.id}`, title: `${r.artist_name}: follow-up ${plural(daysSince(r.next_followup_date), 'day')} overdue`, detail: [r.stage, r.owner_name && `owner ${r.owner_name}`].filter(Boolean).join(' · '), fingerprint: fp([String(r.next_followup_date).slice(0, 10)]) }));
    },
  },
  {
    kind: 'deal_revisit_due', group: WORKFLOW, label: 'Passed deals to revisit', page: '/deals',
    description: 'A deal we passed on with a date to look again — that date has arrived.',
    async run() {
      const { rows } = await pool.query(
        `SELECT d.id, d.artist_name, d.passed_reason, d.revisit_date FROM deals d WHERE d.stage = 'Passed' AND d.revisit_date <= CURRENT_DATE ORDER BY d.revisit_date`).catch(() => ({ rows: [] }));
      return rows.map((r) => ({ key: String(r.id), severity: 'low', to: `/deals?deal=${r.id}`, title: `${r.artist_name}: revisit (passed — ${r.passed_reason || 'no reason recorded'})`, detail: `revisit date ${String(r.revisit_date).slice(0, 10)}`, fingerprint: fp([String(r.revisit_date).slice(0, 10)]) }));
    },
  },
  {
    kind: 'onboarding_stalled', group: WORKFLOW, label: 'Onboarding stalled', page: '/artists',
    description: `Signed ${DAYS.onboarding_stalled}+ days ago and the checklist is still open — contract, payment details, advance, budget, first release.`,
    async run() {
      const { openOnboardings } = require('./onboarding');
      const open = await openOnboardings();
      if (!open.length) return [];
      const { rows } = await pool.query(`SELECT id, signed_at FROM artists WHERE id = ANY($1)`, [open.map((o) => o.artist_id)]);
      const signed = new Map(rows.map((r) => [r.id, r.signed_at]));
      return open.filter((o) => daysSince(signed.get(o.artist_id)) >= DAYS.onboarding_stalled)
        .map((o) => ({ key: String(o.artist_id), severity: 'medium', to: `/artists/${o.artist_id}`, title: `${o.name}: ${plural(o.open, 'onboarding step')} open`, detail: `signed ${plural(daysSince(signed.get(o.artist_id)), 'day')} ago · ${(o.steps || []).filter((s) => !s.done).map((s) => s.label || s.key).join(', ')}`, fingerprint: fp(o.open) }));
    },
  },
  {
    kind: 'contract_expired_no_replacement', group: WORKFLOW, label: 'Expired contracts with no replacement', page: '/renewals', roles: BK,
    description: 'A contract marked Expired with no Active contract of the same type for that artist.',
    async run() {
      const { rows } = await pool.query(
        `SELECT c.id, a.id AS artist_id, a.name, c.type, c.expiration_date FROM contracts c JOIN artists a ON a.id = c.artist_id
          WHERE c.status = 'Expired' AND NOT EXISTS (SELECT 1 FROM contracts c2 WHERE c2.artist_id = c.artist_id AND c2.type = c.type AND c2.status = 'Active') ORDER BY c.expiration_date DESC`);
      return rows.map((r) => ({ key: String(r.id), severity: 'high', to: '/renewals', title: `${r.name}: ${r.type} expired${r.expiration_date ? ` ${String(r.expiration_date).slice(0, 10)}` : ''}`, detail: 'no active replacement' }));
    },
  },
  {
    kind: 'contract_no_file', group: WORKFLOW, label: 'Active contracts with no document', page: '/contracts', roles: BK,
    description: 'The contract row exists but nothing is attached. The signed PDF belongs on the record.',
    async run() {
      const { rows } = await pool.query(
        `SELECT c.id, a.name, c.type, c.date_signed FROM contracts c JOIN artists a ON a.id = c.artist_id
          WHERE c.status = 'Active' AND NOT EXISTS (SELECT 1 FROM entity_files ef WHERE ef.entity_type = 'contract' AND ef.entity_id = c.id)
            AND NOT EXISTS (SELECT 1 FROM signature_envelopes s WHERE s.doc_type = 'contract' AND s.doc_id = c.id AND s.status NOT IN ('completed','declined','voided')) ORDER BY a.name`).catch(() => ({ rows: [] }));
      return rows.map((r) => ({ key: String(r.id), severity: 'medium', to: '/contracts', title: `${r.name}: ${r.type} has no file`, detail: r.date_signed ? `signed ${String(r.date_signed).slice(0, 10)}` : 'no signing date either' }));
    },
  },
  {
    kind: 'artist_no_contract', group: WORKFLOW, label: 'Artists releasing with no contract', page: '/artists',
    description: 'On the roster with releases in the pipeline or catalog, and no contract row at all.',
    async run() {
      const { rows } = await pool.query(
        `SELECT a.id, a.name, COUNT(r.id)::int AS n FROM artists a JOIN releases r ON r.artist_id = a.id AND (r.archived = false OR r.archived IS NULL)
          WHERE (a.archived = false OR a.archived IS NULL) AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.artist_id = a.id) GROUP BY a.id, a.name ORDER BY n DESC`);
      return rows.map((r) => ({ key: String(r.id), severity: 'medium', to: `/artists/${r.id}`, title: `${r.name}: ${plural(r.n, 'release')}, no contract`, fingerprint: fp(r.n) }));
    },
  },
  {
    kind: 'release_unassigned', group: WORKFLOW, label: 'Releases with nobody on them', page: '/releases',
    description: 'Releasing within 30 days and assigned to no one.',
    async run() {
      const { rows } = await pool.query(
        `SELECT r.id, r.project_name, r.release_date::text AS day, a.name FROM releases r LEFT JOIN artists a ON a.id = r.artist_id
          WHERE r.assigned_to IS NULL AND (r.archived = false OR r.archived IS NULL) AND r.release_date >= CURRENT_DATE AND r.release_date <= CURRENT_DATE + INTERVAL '30 days' ORDER BY r.release_date`);
      return rows.map((r) => ({ key: String(r.id), severity: 'medium', to: '/releases', title: `${r.name ? `${r.name} — ` : ''}${r.project_name} releases ${r.day} with no owner` }));
    },
  },
  {
    kind: 'release_behind', group: WORKFLOW, label: 'Releases behind on the checklist', page: '/releases',
    description: 'Releasing within 14 days and under half the fourteen checklist items done.',
    async run() {
      const { rows } = await pool.query(
        `SELECT r.id, r.project_name, r.release_date::text AS day, a.name,
                (COALESCE(r.yt_video,false)::int + COALESCE(r.recoup_added,false)::int + COALESCE(r.uploaded,false)::int
               + COALESCE(r.stem_pitch,false)::int + COALESCE(r.s4a_pitch,false)::int + COALESCE(r.amazon_pitch,false)::int
               + COALESCE(r.pandora,false)::int + COALESCE(r.budget,false)::int + COALESCE(r.marketing_plan,false)::int
               + COALESCE(r.official_thread,false)::int + COALESCE(r.marquee,false)::int + COALESCE(r.content,false)::int
               + COALESCE(r.dsp_email,false)::int + COALESCE(r.musixmatch,false)::int) AS done
           FROM releases r LEFT JOIN artists a ON a.id = r.artist_id
          WHERE (r.archived = false OR r.archived IS NULL) AND r.release_date >= CURRENT_DATE AND r.release_date <= CURRENT_DATE + INTERVAL '14 days' ORDER BY r.release_date`);
      return rows.filter((r) => Number(r.done) / 14 < 0.5).map((r) => ({ key: String(r.id), severity: 'medium', to: '/releases', title: `${r.name ? `${r.name} — ` : ''}${r.project_name}: ${r.done} of 14 done, releases ${r.day}`, fingerprint: fp(r.done) }));
    },
  },
  {
    kind: 'task_overdue', group: WORKFLOW, label: 'Overdue tasks', page: '/team',
    description: 'Tasks past their due date and not Done, across the team.',
    async run() {
      const { rows } = await pool.query(
        `SELECT t.id, t.description, t.due_date::text AS due, u.id AS user_id, u.name FROM tasks t JOIN users u ON u.id = t.user_id
          WHERE t.due_date < CURRENT_DATE AND t.status <> 'Done' ORDER BY t.due_date`);
      return rows.map((r) => ({ key: String(r.id), severity: 'medium', to: `/team/${r.user_id}`, title: `${r.name}: ${String(r.description).slice(0, 80)}`, detail: `due ${r.due} · ${plural(daysSince(r.due), 'day')} late`, fingerprint: fp(r.due) }));
    },
  },

  // ── Compliance & money hygiene (bookkeeping roles) ───────────────────────
  {
    kind: 'invoice_discrepancy', group: COMPLIANCE, label: 'Invoice scan disagrees with the form', page: '/bk/approvals', roles: BK,
    description: 'The AI read of the uploaded document disagrees with what was typed — amount, vendor name, invoice number or currency. Dismiss on the Approvals card once explained.',
    async run() {
      const { rows } = await pool.query(
        `SELECT e.id, e.payee, e.amount, e.currency, e.fx_rate_to_usd, e.invoice_number, e.status, e.ai_scan->'discrepancies' AS d,
                EXISTS (SELECT 1 FROM vendor_aliases v WHERE LOWER(TRIM(v.primary_name)) = LOWER(TRIM(e.payee)) OR LOWER(TRIM(v.alias)) = LOWER(TRIM(e.payee))) AS aliased
           FROM expenses e WHERE ${ALIVE} AND e.status IN ('pending', 'approved') AND jsonb_typeof(e.ai_scan->'discrepancies') = 'array' AND jsonb_array_length(e.ai_scan->'discrepancies') > 0 ORDER BY e.id DESC`).catch(() => ({ rows: [] }));
      return rows.flatMap((r) => {
        // A vendor-name disagreement explained by an alias row is what Approvals silences at read time; do the same.
        const d = (r.d || []).filter((x) => !(r.aliased && /vendor/i.test(x.field || '')));
        if (!d.length) return [];
        const high = d.some((x) => /amount|currency/i.test(x.field || '') || x.severity === 'high');
        return [{ key: String(r.id), severity: high ? 'high' : 'medium', usd: money([r]), to: r.status === 'pending' ? '/bk/approvals' : `/bk/ledger?entry=${r.id}`, title: `${r.payee}${r.invoice_number ? ` #${r.invoice_number}` : ''}: ${d.map((x) => x.field).filter(Boolean).join(', ') || 'discrepancy'}`, detail: d.map((x) => `${x.field}: form "${x.form_value}" vs document "${x.document_value}"`).join(' · ').slice(0, 300), fingerprint: fp(d) }];
      });
    },
  },
  {
    kind: 'w9_missing', group: COMPLIANCE, label: 'Vendors with no W-9', page: '/bk/vendors', roles: BK,
    description: 'Payees with a pending or unpaid approved invoice and no W-9 on any of their rows. Needed before the 1099 run.',
    async run() {
      const { HAS_W9_SQL } = require('./w9-owner');
      const { rows } = await pool.query(
        `SELECT e.payee, COUNT(*)::int AS n, SUM(COALESCE(e.amount,0)) AS total FROM expenses e
          WHERE ${ALIVE} AND ${ROOT} AND e.payee IS NOT NULL AND TRIM(e.payee) <> ''
            AND COALESCE(e.entry_source, '') <> 'bank_statement' AND COALESCE(e.category, '') <> 'Reimbursements'
            AND (e.status = 'pending' OR (e.status = 'approved' AND ${UNPAID}))
            AND NOT EXISTS (SELECT 1 FROM expenses x WHERE LOWER(TRIM(x.payee)) = LOWER(TRIM(e.payee)) AND ${HAS_W9_SQL('x')} AND (x.deleted = false OR x.deleted IS NULL))
          GROUP BY e.payee ORDER BY n DESC`);
      return rows.map((r) => ({ key: r.payee.toLowerCase().trim(), severity: 'medium', to: `/bk/vendors?q=${encodeURIComponent(r.payee)}`, title: `${r.payee}: no W-9 on file`, detail: `${plural(r.n, 'open invoice')}`, fingerprint: fp(r.n) }));
    },
  },
  {
    kind: 'payment_details_missing', group: COMPLIANCE, label: 'Approved, no way to pay', page: '/bk/payments', roles: BK,
    description: 'Approved and unpaid, and the payee has no payment details on file (no email on the invoice, or no vendor form for that email). It cannot be paid until they do.',
    async run() {
      const { rows } = await pool.query(
        `SELECT e.payee, e.vendor_email, COUNT(*)::int AS n, ARRAY_AGG(e.id) AS ids,
                json_agg(json_build_object('amount', e.amount, 'currency', e.currency, 'fx_rate_to_usd', e.fx_rate_to_usd)) AS rows
           FROM expenses e
          WHERE e.status = 'approved' AND ${UNPAID} AND ${ALIVE} AND ${ROOT}
            AND COALESCE(e.entry_source, '') <> 'bank_statement' AND COALESCE(e.category, '') <> 'Reimbursements'
            AND (e.vendor_email IS NULL OR TRIM(e.vendor_email) = '' OR NOT EXISTS (SELECT 1 FROM vendor_payment_details v WHERE LOWER(TRIM(v.vendor_email)) = LOWER(TRIM(e.vendor_email))))
          GROUP BY e.payee, e.vendor_email ORDER BY n DESC`).catch(() => ({ rows: [] }));
      return rows.map((r) => ({ key: `${String(r.payee || '').toLowerCase().trim()}|${String(r.vendor_email || '').toLowerCase().trim()}`, severity: 'high', usd: money(r.rows || []), to: '/bk/payments', title: `${r.payee || 'Unnamed payee'}: ${plural(r.n, 'approved invoice')}, no payment details`, detail: r.vendor_email ? `${r.vendor_email} has not filled the vendor form` : 'no vendor email on the invoice', fingerprint: fp([r.n, r.vendor_email]) }));
    },
  },
  {
    kind: 'amount_nonpositive', group: COMPLIANCE, label: 'Zero or negative amounts', page: '/bk/ledger', roles: BK,
    description: 'Entry refuses these; these got in anyway (imports, edits). A negative expense is a credit that belongs elsewhere.',
    async run() {
      const { rows } = await pool.query(`SELECT e.id, e.payee, e.amount, e.currency, e.invoice_number FROM expenses e WHERE ${ALIVE} AND e.amount <= 0 AND e.status <> 'rejected' ORDER BY e.id DESC`);
      return rows.map((r) => ({ key: String(r.id), severity: 'high', to: `/bk/ledger?entry=${r.id}`, title: `${r.payee}${r.invoice_number ? ` #${r.invoice_number}` : ''}: ${r.amount} ${r.currency || 'USD'}`, fingerprint: fp(r.amount) }));
    },
  },
  {
    kind: 'category_missing', group: COMPLIANCE, label: 'Approved with no category', page: '/bk/ledger', roles: BK,
    description: 'Approved rows with a blank category. They land in no P&L line and cannot map to a QuickBooks account.',
    async run() {
      const { rows } = await pool.query(`SELECT e.id, e.payee, e.amount, e.currency, e.fx_rate_to_usd, e.invoice_number FROM expenses e WHERE ${ALIVE} AND ${ROOT} AND e.status = 'approved' AND (e.category IS NULL OR TRIM(e.category) = '') ORDER BY e.id DESC`);
      return rows.map((r) => ({ key: String(r.id), severity: 'medium', usd: money([r]), to: `/bk/ledger?entry=${r.id}`, title: `${r.payee}${r.invoice_number ? ` #${r.invoice_number}` : ''}: no category` }));
    },
  },
  {
    kind: 'attachment_missing', group: COMPLIANCE, label: 'Approved with no document', page: '/bk/ledger', roles: BK,
    description: 'Approved or paid, not from a bank statement, and no invoice, receipt or proof attached anywhere in the family.',
    async run() {
      const { rows } = await pool.query(
        `SELECT e.id, e.payee, e.amount, e.currency, e.fx_rate_to_usd, e.invoice_number, e.payment_status FROM expenses e
          WHERE ${ALIVE} AND ${ROOT} AND e.status = 'approved' AND COALESCE(e.entry_source, '') NOT IN ('bank_statement', 'signing')
            AND NOT ((e.invoice_data IS NOT NULL AND e.invoice_data != '') OR e.invoice_r2_key IS NOT NULL
                  OR (e.receipt_data IS NOT NULL AND e.receipt_data != '')
                  OR (e.proof_data IS NOT NULL AND e.proof_data != '') OR e.proof_r2_key IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM entity_files f WHERE f.entity_type = 'expense' AND f.entity_id = e.id)
          ORDER BY e.id DESC`);
      return rows.map((r) => ({ key: String(r.id), severity: 'medium', usd: money([r]), to: `/bk/ledger?entry=${r.id}`, title: `${r.payee}${r.invoice_number ? ` #${r.invoice_number}` : ''}: nothing attached`, detail: r.payment_status === 'Paid' ? 'already paid' : 'approved, unpaid' }));
    },
  },
  {
    kind: 'fx_missing', group: COMPLIANCE, label: 'Paid in a foreign currency, no rate locked', page: '/bk/ledger', roles: BK,
    description: 'Paid, not USD, and no fx_rate_to_usd stamped. Every USD figure for the row is a cached daily rate that can drift.',
    async run() {
      const { rows } = await pool.query(`SELECT e.id, e.payee, e.amount, e.currency, e.invoice_number FROM expenses e WHERE ${ALIVE} AND e.payment_status = 'Paid' AND COALESCE(e.currency, 'USD') <> 'USD' AND e.fx_rate_to_usd IS NULL ORDER BY e.id DESC`);
      return rows.map((r) => ({ key: String(r.id), severity: 'medium', to: `/bk/ledger?entry=${r.id}`, title: `${r.payee}${r.invoice_number ? ` #${r.invoice_number}` : ''}: ${r.amount} ${r.currency}, no USD rate` }));
    },
  },
  {
    kind: 'advance_no_artist', group: COMPLIANCE, label: 'Advances with no artist', page: '/recoupments', roles: ADMIN,
    description: 'An advance is an artist\'s own money by definition. One with no artist is recoupable cost nobody can be billed for.',
    async run() {
      const { ADVANCE_CATEGORIES } = require('../routes/reports');
      const cats = [...(ADVANCE_CATEGORIES || new Set(['Advance']))];
      const { rows } = await pool.query(
        `SELECT e.id, e.payee, e.amount, e.currency, e.fx_rate_to_usd, e.invoice_number FROM expenses e
          WHERE ${ALIVE} AND COALESCE(e.status, 'approved') = 'approved' AND e.category = ANY($1) AND (e.artist IS NULL OR TRIM(e.artist) = '') ORDER BY e.id DESC`, [cats]);
      return rows.map((r) => ({ key: String(r.id), severity: 'high', usd: money([r]), to: '/recoupments/audit', title: `Advance to ${r.payee}${r.invoice_number ? ` #${r.invoice_number}` : ''} names no artist` }));
    },
  },
];

const BY_KIND = new Map(DETECTORS.map((d) => [d.kind, d]));

// ── The data-quality detectors in routes/flags.js join the register too ──
// So "new", age and ownership exist for duplicates and blanks as well. Items
// are keyed the way the page already keys them (row id, or group_key).
function dqDetectors() {
  const f = require('../routes/flags').detectors;
  if (!f) return [];
  const wrap = (kind, get, toItem) => ({ kind, dq: true, async run() { return (await get()).map(toItem).filter(Boolean); } });
  const ledgerItem = (r) => ({ key: String(r.id), title: `${r.payee || ''}${r.artist ? ` · ${r.artist}` : ''}`.trim() || `Entry ${r.id}`, fingerprint: fp([r.artist, r.song]) });
  const relItem = (r) => ({ key: String(r.id), title: r.project_name || `Release ${r.id}` });
  const artItem = (r) => ({ key: String(r.id), title: r.name || `Artist ${r.id}` });
  return [
    wrap('duplicate_releases', f.getDuplicateReleases, (g) => ({ key: g.group_key, title: (g.releases || []).map((r) => r.project_name).join(' / ') })),
    wrap('duplicate_artists', f.getDuplicateArtists, (g) => ({ key: f.groupKeyForArtists(g), title: g.map((a) => a.name).join(' / ') })),
    wrap('duplicate_vendors', f.getDuplicateVendors, (g) => ({ key: f.groupKeyForVendors(g), title: g.map((v) => v.payee).join(' / ') })),
    wrap('duplicate_invoices', f.getDuplicateInvoices, (g) => ({ key: g.group_key, title: `${(g.entries || [])[0]?.payee || 'Invoice'} × ${(g.entries || []).length}`, fingerprint: fp((g.entries || []).map((e) => e.amount)) })),
    wrap('releases_missing_genre', f.getReleasesMissingGenre, relItem),
    wrap('releases_missing_upc', () => f.getReleasesMissingIdentifier('upc', 'UPC'), relItem),
    wrap('releases_missing_isrc', () => f.getReleasesMissingIdentifier('isrc', 'ISRC'), relItem),
    wrap('releases_missing_spotify', f.getReleasesMissingSpotify, relItem),
    wrap('artists_missing_genre', f.getArtistsMissingGenre, artItem),
    wrap('artists_missing_spotify', f.getArtistsMissingSpotify, artItem),
    wrap('artist_multi_normalize', f.getMultiArtistGroups, (g) => ({ key: g.group_key || g.source_key, title: g.source_display || g.source_key })),
    wrap('ledger_missing_song', f.getMissingSongFlags, ledgerItem),
    wrap('ledger_missing_socials', f.getMissingSocialsFlags, ledgerItem),
    // getArtistFlags returns { kind: rows[] } — one register kind per key.
    // getArtistFlags buckets by SHORT name ({ unknown, likely_typo, … }); the page's kinds are prefixed.
    ...Object.entries({ artist_placeholder: 'placeholder', artist_missing: 'missing', artist_multi_name: 'multi_name', artist_song_mismatch: 'song_mismatch', artist_likely_typo: 'likely_typo', artist_unknown: 'unknown', artist_variants: 'variants' })
      .map(([kind, bucket]) => ({ kind, bucket, dq: true, artistFlags: true })),
    wrap('flagged_expenses', f.getFlaggedExpenses, (r) => ({ key: String(r.id), title: `${r.payee}${r.flag_reason ? ` — ${r.flag_reason}` : ''}`, fingerprint: fp(r.flag_reason) })),
    wrap('flagged_transactions', f.getFlaggedTransactions, (r) => ({ key: String(r.id), title: `${r.payee_guess || r.description || 'Transaction'} ${r.amount}` })),
  ];
}

// ── The sweep ───────────────────────────────────────────────────────────────
let sweeping = null;
async function sweep({ trigger = 'timer' } = {}) {
  if (sweeping) return sweeping; // two callers share one run
  sweeping = (async () => {
    const t0 = Date.now();
    const counts = {}, errors = {};
    const seen = new Map();
    const run = async (d, fn) => {
      try { const items = await fn(); seen.set(d.kind, items); counts[d.kind] = items.length; }
      catch (e) { errors[d.kind] = e.message; console.warn(`[flags] ${d.kind}:`, e.message); }
    };
    for (const d of DETECTORS) await run(d, () => d.run());
    const dq = dqDetectors();
    for (const d of dq.filter((x) => !x.artistFlags)) await run(d, () => d.run());
    const af = dq.filter((x) => x.artistFlags);
    if (af.length) {
      try {
        const byKind = await require('../routes/flags').detectors.getArtistFlags();
        for (const d of af) {
          const rows = byKind[d.bucket] || [];
          seen.set(d.kind, rows.map((r) => ({ key: String(r.id), title: `${r.payee || ''}${r.artist ? ` · ${r.artist}` : ''}`.trim() || `Entry ${r.id}`, fingerprint: fp([r.artist, r.song, r.suggestion]) })));
          counts[d.kind] = rows.length;
        }
      } catch (e) { for (const d of af) errors[d.kind] = e.message; }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [kind, items] of seen) {
        const def = BY_KIND.get(kind);
        for (const it of items) {
          const fingerprint = it.fingerprint || fp([it.title, it.detail, it.usd, it.severity]);
          await client.query(
            `INSERT INTO flag_register (kind, key, fingerprint, severity, title, detail, to_path, usd, payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (kind, key) DO UPDATE SET
               fingerprint = EXCLUDED.fingerprint, severity = EXCLUDED.severity, title = EXCLUDED.title,
               detail = EXCLUDED.detail, to_path = EXCLUDED.to_path, usd = EXCLUDED.usd, payload = EXCLUDED.payload,
               last_seen = NOW(),
               -- a flag that resolved and came back is new again
               first_seen = CASE WHEN flag_register.resolved_at IS NOT NULL THEN NOW() ELSE flag_register.first_seen END,
               -- a dismissal or snooze binds to the VALUE; a changed value, or a return from resolved, resurfaces
               dismissed_at = CASE WHEN flag_register.resolved_at IS NOT NULL OR flag_register.dismissed_fingerprint IS DISTINCT FROM EXCLUDED.fingerprint THEN NULL ELSE flag_register.dismissed_at END,
               dismissed_by = CASE WHEN flag_register.resolved_at IS NOT NULL OR flag_register.dismissed_fingerprint IS DISTINCT FROM EXCLUDED.fingerprint THEN NULL ELSE flag_register.dismissed_by END,
               snooze_until = CASE WHEN flag_register.resolved_at IS NOT NULL OR flag_register.dismissed_fingerprint IS DISTINCT FROM EXCLUDED.fingerprint THEN NULL ELSE flag_register.snooze_until END,
               resolved_at = NULL`,
            [kind, String(it.key), fingerprint, it.severity || def?.severity || 'medium', String(it.title).slice(0, 300), it.detail ? String(it.detail).slice(0, 1000) : null, it.to || def?.page || null, it.usd != null ? round2(it.usd) : null, it.payload ? JSON.stringify(it.payload) : null]);
        }
        await client.query(`UPDATE flag_register SET resolved_at = NOW() WHERE kind = $1 AND resolved_at IS NULL AND NOT (key = ANY($2::text[]))`, [kind, items.map((i) => String(i.key))]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      errors.__write = e.message;
      console.error('[flags] register write failed:', e.message);
    } finally { client.release(); }

    // A task made from a flag closes when the flag does — a stale row in
    // somebody's My Work is noise. The note says why.
    await pool.query(
      `UPDATE tasks t SET status = 'Done', updated_at = NOW(),
              notes = COALESCE(t.notes, '') || CASE WHEN COALESCE(t.notes, '') = '' THEN '' ELSE E'\n' END || 'Closed automatically: the flag cleared on ' || to_char(NOW(), 'YYYY-MM-DD')
         FROM flag_register f WHERE t.id = f.task_id AND f.resolved_at IS NOT NULL AND t.status <> 'Done'`).catch(() => {});

    const duration_ms = Date.now() - t0;
    await pool.query(`INSERT INTO flag_sweeps (duration_ms, trigger, counts, errors) VALUES ($1, $2, $3, $4)`, [duration_ms, trigger, JSON.stringify(counts), JSON.stringify(errors)]).catch(() => {});
    await pool.query(`DELETE FROM flag_sweeps WHERE id < (SELECT MAX(id) FROM flag_sweeps) - 500`).catch(() => {});
    return { counts, errors, duration_ms };
  })();
  try { return await sweeping; } finally { sweeping = null; }
}

async function lastSweep() {
  const { rows: [r] } = await pool.query(`SELECT ran_at, duration_ms, trigger, counts, errors FROM flag_sweeps ORDER BY id DESC LIMIT 1`).catch(() => ({ rows: [] }));
  return r || null;
}

// ── Reading, gated ──────────────────────────────────────────────────────────
// Which register kinds this viewer may see: page reachable, role allowed.
async function visibleKinds(user) {
  const pages = [...new Set(DETECTORS.map((d) => d.page))];
  const reach = await pagesReachable(user, pages);
  return new Set(DETECTORS.filter((d) => reach.has(d.page) && (!d.roles || d.roles.has(user?.role))).map((d) => d.kind));
}

const OPEN = `resolved_at IS NULL`;
const SHOWN = `${OPEN} AND dismissed_at IS NULL AND (snooze_until IS NULL OR snooze_until <= NOW())`;

// Register-only categories, shaped like the page's categories: { kind, label,
// description, severity, group, count, items, register: true }.
async function categoriesFor(user, { includeDismissed = false } = {}) {
  const kinds = await visibleKinds(user);
  if (!kinds.size) return [];
  const { rows } = await pool.query(
    `SELECT r.*, t.status AS task_status, t.user_id AS task_user_id, tu.name AS task_user_name, du.name AS dismissed_by_name
       FROM flag_register r
       LEFT JOIN tasks t ON t.id = r.task_id LEFT JOIN users tu ON tu.id = t.user_id
       LEFT JOIN users du ON du.id = r.dismissed_by
      WHERE r.kind = ANY($1) AND r.${includeDismissed ? OPEN : SHOWN}
      ORDER BY CASE r.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, r.usd DESC NULLS LAST, r.first_seen`, [[...kinds]]);
  const seenAt = user?.flags_seen_at ? new Date(user.flags_seen_at) : null;
  const byKind = new Map();
  for (const r of rows) (byKind.get(r.kind) || byKind.set(r.kind, []).get(r.kind)).push(r);
  const out = [];
  for (const d of DETECTORS) {
    if (!kinds.has(d.kind)) continue;
    const items = (byKind.get(d.kind) || []).map((r) => shape(r, seenAt));
    const live = items.filter((i) => !i.dismissed && !i.snoozed);
    const sev = live.some((i) => i.severity === 'high') ? 'high' : live.some((i) => i.severity === 'medium') ? 'medium' : 'low';
    const firsts = live.map((i) => i.first_seen);
    out.push({ kind: d.kind, label: d.label, description: d.description, group: d.group, page: d.page, severity: live.length ? sev : 'medium', count: live.length, items, register: true,
      tracking: { new: live.filter((i) => i.is_new).length, oldest_days: firsts.length ? Math.max(...firsts.map(daysSince)) : null, owner: null } });
  }
  return out;
}

function shape(r, seenAt) {
  return {
    key: r.key, title: r.title, detail: r.detail, to: r.to_path, usd: r.usd != null ? Number(r.usd) : null, severity: r.severity,
    first_seen: r.first_seen, age_days: daysSince(r.first_seen), is_new: !!(seenAt ? new Date(r.first_seen) > seenAt : true),
    dismissed: !!r.dismissed_at, dismissed_at: r.dismissed_at, dismissed_by_name: r.dismissed_by_name || null,
    snoozed: !!(r.snooze_until && new Date(r.snooze_until) > new Date()), snooze_until: r.snooze_until,
    task: r.task_id ? { id: r.task_id, status: r.task_status, user_id: r.task_user_id, user_name: r.task_user_name } : null,
  };
}

// Annotate the page's data-quality categories with register facts (`tracking`):
// how many are new to this viewer, the oldest open, and who owns the category.
async function annotate(categories, user) {
  const kinds = categories.map((c) => c.kind);
  if (!kinds.length) return;
  const seenAt = user?.flags_seen_at ? new Date(user.flags_seen_at) : null;
  const [{ rows }, { rows: owners }] = await Promise.all([
    pool.query(`SELECT kind, key, first_seen FROM flag_register WHERE kind = ANY($1) AND ${OPEN}`, [kinds]).catch(() => ({ rows: [] })),
    pool.query(`SELECT a.kind, a.key, a.task_id, a.assigned_to, u.name AS user_name, t.status FROM flag_assignments a JOIN users u ON u.id = a.assigned_to LEFT JOIN tasks t ON t.id = a.task_id WHERE a.kind = ANY($1)`, [kinds]).catch(() => ({ rows: [] })),
  ]);
  const by = new Map();
  for (const r of rows) (by.get(r.kind) || by.set(r.kind, new Map()).get(r.kind)).set(r.key, r.first_seen);
  const ownerOf = new Map(owners.map((o) => [`${o.kind}|${o.key}`, { task_id: o.task_id, user_id: o.assigned_to, user_name: o.user_name, status: o.status }]));
  for (const c of categories) {
    const m = by.get(c.kind) || new Map();
    const stamp = (row, key) => { const fs = m.get(String(key)); if (fs) { row.first_seen = fs; row.age_days = daysSince(fs); row.is_new = seenAt ? new Date(fs) > seenAt : true; } };
    for (const it of c.items || []) stamp(it, it.id ?? it.key);
    for (const g of c.groups || []) stamp(g, g.group_key ?? g.source_key);
    const firsts = [...m.values()];
    // `tracking`, not `register`: the page reads `register: true` as "this is a
    // register-only category with the generic renderer".
    c.tracking = {
      new: firsts.filter((f) => (seenAt ? new Date(f) > seenAt : true)).length,
      oldest_days: firsts.length ? Math.max(...firsts.map(daysSince)) : null,
      owner: ownerOf.get(`${c.kind}|*`) || null,
    };
    for (const it of c.items || []) { const o = ownerOf.get(`${c.kind}|${it.id ?? it.key}`); if (o) it.task = o; }
  }
}

// The Home tile and My Work row. Only kinds this viewer could act on.
async function summaryFor(user) {
  const kinds = await visibleKinds(user);
  const seenAt = user?.flags_seen_at || null;
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS open,
            COUNT(*) FILTER (WHERE severity = 'high')::int AS high,
            COUNT(*) FILTER (WHERE $2::timestamptz IS NULL OR first_seen > $2::timestamptz)::int AS new,
            COALESCE(SUM(usd), 0) AS usd,
            MIN(first_seen) AS oldest,
            COUNT(*) FILTER (WHERE kind = ANY($3))::int AS setup
       FROM flag_register WHERE kind = ANY($1) AND ${SHOWN}`,
    [[...kinds], seenAt, DETECTORS.filter((d) => d.group === SETUP).map((d) => d.kind)]).catch(() => ({ rows: [{ open: 0, high: 0, new: 0, usd: 0, oldest: null, setup: 0 }] }));
  const last = await lastSweep();
  return { count: r.open, high: r.high, new: r.new, usd: round2(r.usd), oldest_days: r.oldest ? daysSince(r.oldest) : null, setup: r.setup, swept_at: last?.ran_at || null, to: '/flags' };
}

// ── Writes ──────────────────────────────────────────────────────────────────
async function markSeen(userId) {
  await pool.query(`UPDATE users SET flags_seen_at = NOW() WHERE id = $1`, [userId]);
}

async function dismiss({ kind, key, userId, until = null, undo = false }) {
  if (undo) {
    const { rowCount } = await pool.query(`UPDATE flag_register SET dismissed_at = NULL, dismissed_by = NULL, dismissed_fingerprint = NULL, snooze_until = NULL WHERE kind = $1 AND key = $2`, [kind, key]);
    return rowCount === 1;
  }
  const { rowCount } = await pool.query(
    `UPDATE flag_register SET dismissed_at = CASE WHEN $4::timestamptz IS NULL THEN NOW() ELSE dismissed_at END, dismissed_by = $3,
            dismissed_fingerprint = fingerprint, snooze_until = $4 WHERE kind = $1 AND key = $2`, [kind, key, userId, until]);
  return rowCount === 1;
}

// Assign: one task in My Work, linked both ways. key '*' owns the category.
async function assign({ kind, key = '*', assignee, actor, due_date = null, title, to, severity }) {
  const def = BY_KIND.get(kind);
  const desc = key === '*' ? `Work through the ${title || def?.label || kind} flags` : `Flag: ${title}`;
  const link = key === '*' ? `/flags?tab=${kind}` : `/flags?tab=${kind}&focus=${encodeURIComponent(key)}`;
  const priority = severity === 'high' ? 'High' : severity === 'low' ? 'Low' : 'Medium';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [prev] } = await client.query(`SELECT task_id FROM flag_assignments WHERE kind = $1 AND key = $2`, [kind, key]);
    if (prev?.task_id) await client.query(`UPDATE tasks SET status = 'Done', notes = COALESCE(notes,'') || E'\nReassigned', updated_at = NOW() WHERE id = $1 AND status <> 'Done'`, [prev.task_id]);
    const task_type = assignee.hierarchy_level < actor.hierarchy_level ? 'request' : 'assignment';
    const { rows: [task] } = await client.query(
      `INSERT INTO tasks (user_id, assigned_by, task_type, description, category, priority, status, due_date, notes, flag_kind, flag_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Flag', $5, 'To Do', $6, $7, $8, $9, NOW(), NOW()) RETURNING *`,
      [assignee.id, actor.id, task_type, desc, priority, due_date, `Open in Flags: ${link}${to ? `\nResolve at: ${to}` : ''}`, kind, key]);
    await client.query(
      `INSERT INTO flag_assignments (kind, key, task_id, assigned_to, assigned_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (kind, key) DO UPDATE SET task_id = EXCLUDED.task_id, assigned_to = EXCLUDED.assigned_to, assigned_by = EXCLUDED.assigned_by, assigned_at = NOW()`,
      [kind, key, task.id, assignee.id, actor.id]);
    if (key !== '*') await client.query(`UPDATE flag_register SET task_id = $3 WHERE kind = $1 AND key = $2`, [kind, key, task.id]);
    await client.query('COMMIT');
    return { ...task, assignee_name: assignee.name };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

async function unassign({ kind, key = '*' }) {
  const { rows: [a] } = await pool.query(`DELETE FROM flag_assignments WHERE kind = $1 AND key = $2 RETURNING task_id`, [kind, key]);
  if (a?.task_id) {
    await pool.query(`UPDATE tasks SET status = 'Done', notes = COALESCE(notes,'') || E'\nUnassigned from the flag', updated_at = NOW() WHERE id = $1 AND status <> 'Done'`, [a.task_id]).catch(() => {});
    await pool.query(`UPDATE flag_register SET task_id = NULL WHERE task_id = $1`, [a.task_id]).catch(() => {});
  }
  return !!a;
}

// Which expense categories must carry an artist and a song — a per-label
// setting on bk_categories, not a list in code.
async function artistRequiredCategories() {
  const { rows } = await pool.query(`SELECT name FROM bk_categories WHERE kind = 'expense' AND artist_required = TRUE`).catch(() => ({ rows: [] }));
  return new Set(rows.map((r) => r.name));
}

module.exports = { ensureSchema, sweep, lastSweep, DETECTORS, DAYS, visibleKinds, categoriesFor, annotate, summaryFor, markSeen, dismiss, assign, unassign, artistRequiredCategories, fp };
