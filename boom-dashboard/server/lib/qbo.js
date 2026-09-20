// QuickBooks Online — a PUSH sync from the bookkeeping ledger.
//
//   approve an expense  → qbo_queue 'bill'     → Vendor (find or create) + Bill (one line per split)
//   mark it Paid        → qbo_queue 'payment'  → BillPayment (Check from the chosen bank account)
//
// The queue is processed every ten minutes (lib/integrations-worker.js) and on
// demand (POST /quickbooks/sync). A failed push backs off (1h, 2h, 4h … 24h)
// and gives up after MAX_ATTEMPTS, showing on the Integrations card with the
// message QuickBooks returned. Everything QuickBooks knows about a row is in
// qbo_links, so a second push UPDATES instead of duplicating.
//
// OAuth 2 authorization-code grant (Intuit). Refresh tokens ROTATE on every
// refresh and expire after 100 days idle — always store the one that comes
// back. Tokens live encrypted under PAYMENT_DETAILS_KEY.
//
// Env: QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_ENV=sandbox|production,
//      QBO_DRY_RUN=1 (fixtures: no Intuit call; deterministic fake ids).
const pool = require('../db');
const crypto = require('./payment-crypto');
const { request, basic } = require('./http-json');

const DRY = () => process.env.QBO_DRY_RUN === '1';
const ENV = () => (process.env.QBO_ENV === 'production' ? 'production' : 'sandbox');
const API_HOST = () => (ENV() === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com');
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const SCOPE = 'com.intuit.quickbooks.accounting';
const MINOR = 73;
const MAX_ATTEMPTS = 10;

const isConfigured = () => !!(process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET);

class QboError extends Error {
  constructor(message, { code = 'QBO_ERROR', status = 500, retryable = true } = {}) { super(message); this.code = code; this.status = status; this.retryable = retryable; }
}

// ─── connection ───────────────────────────────────────────────────────────
async function getConnection() {
  const { rows: [c] } = await pool.query('SELECT * FROM qbo_connection WHERE id = 1');
  return c || null;
}

// Public view: never the tokens.
async function status() {
  const c = await getConnection();
  const { rows: q } = await pool.query(`SELECT status, COUNT(*)::int AS n FROM qbo_queue GROUP BY status`).catch(() => ({ rows: [] }));
  const counts = Object.fromEntries(q.map((r) => [r.status, r.n]));
  const { rows: [last] } = await pool.query(`SELECT MAX(done_at) AS t FROM qbo_queue WHERE status = 'done'`).catch(() => ({ rows: [{}] }));
  return {
    configured: isConfigured(), env: ENV(), dry_run: DRY(),
    connected: !!c, company_name: c?.company_name || null, realm_id: c?.realm_id || null, status: c?.status || null,
    last_error: c?.last_error || null, connected_at: c?.connected_at || null, refresh_expires_at: c?.refresh_expires_at || null,
    settings: c?.settings || {}, queue: { pending: counts.pending || 0, error: counts.error || 0, done: counts.done || 0 },
    last_synced_at: last?.t || null,
  };
}

function authorizeUrl({ redirectUri, state }) {
  const p = new URLSearchParams({ client_id: process.env.QBO_CLIENT_ID, response_type: 'code', scope: SCOPE, redirect_uri: redirectUri, state });
  return `${AUTH_URL}?${p}`;
}

async function tokenRequest(form) {
  if (DRY()) return { access_token: `dry-access-${Date.now()}`, refresh_token: `dry-refresh-${Date.now()}`, expires_in: 3600, x_refresh_token_expires_in: 8726400 };
  const r = await request(TOKEN_URL, { method: 'POST', headers: { Authorization: basic(process.env.QBO_CLIENT_ID, process.env.QBO_CLIENT_SECRET) }, form });
  if (r.status >= 400 || !r.json?.access_token) {
    const msg = r.json?.error_description || r.json?.error || `HTTP ${r.status}`;
    throw new QboError(`QuickBooks token request failed: ${msg}`, { code: r.json?.error === 'invalid_grant' ? 'INVALID_GRANT' : 'TOKEN', status: 502, retryable: r.json?.error !== 'invalid_grant' });
  }
  return r.json;
}

function storeTokens(tok) {
  const now = Date.now();
  return {
    access_token_enc: crypto.encrypt(tok.access_token), refresh_token_enc: tok.refresh_token ? crypto.encrypt(tok.refresh_token) : undefined,
    access_expires_at: new Date(now + (Number(tok.expires_in || 3600) - 120) * 1000),
    refresh_expires_at: tok.x_refresh_token_expires_in ? new Date(now + Number(tok.x_refresh_token_expires_in) * 1000) : undefined,
  };
}

// The callback: exchange the code, read the company name, upsert the one row.
async function connect({ code, realmId, redirectUri, userId }) {
  if (!crypto.isConfigured()) throw new QboError('Encryption key not configured; QuickBooks tokens cannot be stored.', { code: 'NO_CRYPTO', status: 503, retryable: false });
  const tok = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  const t = storeTokens(tok);
  await pool.query(`INSERT INTO qbo_connection (id, realm_id, env, refresh_token_enc, access_token_enc, access_expires_at, refresh_expires_at, status, last_error, connected_by, connected_at, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, 'active', NULL, $7, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET realm_id = EXCLUDED.realm_id, env = EXCLUDED.env, refresh_token_enc = EXCLUDED.refresh_token_enc, access_token_enc = EXCLUDED.access_token_enc,
       access_expires_at = EXCLUDED.access_expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at, status = 'active', last_error = NULL, connected_by = EXCLUDED.connected_by, connected_at = NOW(), updated_at = NOW()`,
    [String(realmId), ENV(), t.refresh_token_enc, t.access_token_enc, t.access_expires_at, t.refresh_expires_at || null, userId || null]);
  try {
    const info = await api('GET', `/companyinfo/${encodeURIComponent(String(realmId))}`);
    const name = info?.CompanyInfo?.CompanyName || null;
    if (name) await pool.query('UPDATE qbo_connection SET company_name = $1 WHERE id = 1', [name]);
    return { realm_id: String(realmId), company_name: name };
  } catch (e) { console.warn('[qbo] company info failed:', e.message); return { realm_id: String(realmId), company_name: null }; }
}

async function disconnect() {
  const c = await getConnection(); if (!c) return false;
  if (!DRY() && c.refresh_token_enc && isConfigured()) {
    const rt = crypto.decrypt(c.refresh_token_enc);
    if (rt) await request(REVOKE_URL, { method: 'POST', headers: { Authorization: basic(process.env.QBO_CLIENT_ID, process.env.QBO_CLIENT_SECRET) }, body: { token: rt } }).catch(() => null);
  }
  await pool.query('DELETE FROM qbo_connection WHERE id = 1');
  return true;
}

async function accessToken() {
  const c = await getConnection();
  if (!c) throw new QboError('QuickBooks is not connected. Connect it under Settings › Integrations.', { code: 'NOT_CONNECTED', status: 409, retryable: false });
  if (c.status === 'needs_reconnect') throw new QboError('QuickBooks needs to be reconnected (its refresh token was rejected).', { code: 'NEEDS_RECONNECT', status: 409, retryable: false });
  if (c.access_token_enc && c.access_expires_at && new Date(c.access_expires_at) > new Date()) {
    const at = crypto.decrypt(c.access_token_enc); if (at) return { token: at, c };
  }
  const rt = crypto.decrypt(c.refresh_token_enc || '');
  if (!rt) throw new QboError('QuickBooks refresh token is missing; reconnect.', { code: 'NEEDS_RECONNECT', status: 409, retryable: false });
  try {
    const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: rt });
    const t = storeTokens(tok);
    await pool.query(`UPDATE qbo_connection SET access_token_enc = $1, access_expires_at = $2, refresh_token_enc = COALESCE($3, refresh_token_enc), refresh_expires_at = COALESCE($4, refresh_expires_at), status = 'active', last_error = NULL, updated_at = NOW() WHERE id = 1`,
      [t.access_token_enc, t.access_expires_at, t.refresh_token_enc || null, t.refresh_expires_at || null]);
    return { token: tok.access_token, c };
  } catch (e) {
    if (e.code === 'INVALID_GRANT') await pool.query(`UPDATE qbo_connection SET status = 'needs_reconnect', last_error = $1, updated_at = NOW() WHERE id = 1`, [e.message]);
    throw e;
  }
}

// ─── the API ──────────────────────────────────────────────────────────────
// Dry run: a tiny in-memory QuickBooks so fixtures see real shapes.
const dry = { seq: 1000, vendors: new Map(), bills: new Map(), payments: new Map() };
function dryApi(method, path, body) {
  const q = /\/query\?query=(.*)$/.exec(path);
  if (q) {
    const sql = decodeURIComponent(q[1].split('&')[0]);
    if (/from Vendor/i.test(sql)) { const m = /DisplayName = '([^']*)'/i.exec(sql); const v = m ? dry.vendors.get(m[1].replace(/\\'/g, "'")) : null; return { QueryResponse: v ? { Vendor: [v] } : {} }; }
    if (/from Account/i.test(sql)) return { QueryResponse: { Account: [
      { Id: '7', Name: 'Marketing', AccountType: 'Expense', AccountSubType: 'AdvertisingPromotional' }, { Id: '8', Name: 'Recording', AccountType: 'Expense', AccountSubType: 'OtherMiscellaneousServiceCost' },
      { Id: '35', Name: 'Checking', AccountType: 'Bank', AccountSubType: 'Checking' }, { Id: '33', Name: 'Accounts Payable (A/P)', AccountType: 'Accounts Payable', AccountSubType: 'AccountsPayable' },
    ] } };
    return { QueryResponse: {} };
  }
  if (/\/companyinfo\//.test(path)) return { CompanyInfo: { CompanyName: 'Dry Run Records' } };
  if (/\/vendor$/.test(path)) { const id = String(++dry.seq); const v = { ...body, Id: id, SyncToken: '0' }; dry.vendors.set(body.DisplayName, v); return { Vendor: v }; }
  if (/\/bill$/.test(path)) { const id = body.Id || String(++dry.seq); const b = { ...body, Id: id, SyncToken: String(Number(body.SyncToken || -1) + 1) }; dry.bills.set(id, b); return { Bill: b }; }
  if (/\/billpayment$/.test(path)) { const id = body.Id || String(++dry.seq); const p = { ...body, Id: id, SyncToken: '0' }; dry.payments.set(id, p); return { BillPayment: p }; }
  return {};
}

async function api(method, path, body) {
  if (DRY()) return dryApi(method, path, body);
  const { token, c } = await accessToken();
  const sep = path.includes('?') ? '&' : '?';
  const url = `${API_HOST()}/v3/company/${encodeURIComponent(c.realm_id)}${path}${sep}minorversion=${MINOR}`;
  let r = await request(url, { method, headers: { Authorization: `Bearer ${token}` }, body });
  if (r.status === 401) {
    // Access token rejected before its clock said so: refresh once and retry.
    await pool.query('UPDATE qbo_connection SET access_expires_at = NULL WHERE id = 1');
    const again = await accessToken();
    r = await request(url, { method, headers: { Authorization: `Bearer ${again.token}` }, body });
  }
  if (r.status >= 400) {
    const err = r.json?.Fault?.Error?.[0];
    const msg = err ? `${err.Message}${err.Detail ? ` — ${err.Detail}` : ''}` : (r.text || `HTTP ${r.status}`).slice(0, 300);
    // 4xx is our payload's fault: no point retrying until something changes.
    throw new QboError(`QuickBooks: ${msg}`, { code: err?.code ? `QBO_${err.code}` : 'QBO_HTTP', status: 502, retryable: r.status >= 500 || r.status === 429 });
  }
  return r.json;
}

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const query = async (sql) => (await api('GET', `/query?query=${encodeURIComponent(sql)}`))?.QueryResponse || {};

async function listAccounts() {
  const q = await query(`select Id, Name, AccountType, AccountSubType, Active from Account where Active = true maxresults 1000`);
  const list = (q.Account || []).map((a) => ({ id: String(a.Id), name: a.Name, type: a.AccountType, subtype: a.AccountSubType }));
  return {
    expense: list.filter((a) => ['Expense', 'Other Expense', 'Cost of Goods Sold'].includes(a.type)),
    bank: list.filter((a) => a.type === 'Bank' || a.type === 'Credit Card'),
    ap: list.filter((a) => a.type === 'Accounts Payable'),
  };
}

// settings: { default_expense_account: {id,name}, bank_account: {id,name}, category_map: { [bk category]: {id,name} } }
async function saveSettings(patch) {
  const c = await getConnection(); if (!c) throw new QboError('QuickBooks is not connected.', { code: 'NOT_CONNECTED', status: 409, retryable: false });
  const clean = {};
  const ref = (v) => (v && v.id ? { id: String(v.id), name: String(v.name || '').slice(0, 120) } : null);
  if ('default_expense_account' in patch) clean.default_expense_account = ref(patch.default_expense_account);
  if ('bank_account' in patch) clean.bank_account = ref(patch.bank_account);
  if ('category_map' in patch && patch.category_map && typeof patch.category_map === 'object') {
    clean.category_map = {}; for (const [k, v] of Object.entries(patch.category_map)) { const r = ref(v); if (r) clean.category_map[String(k).slice(0, 120)] = r; }
  }
  const next = { ...(c.settings || {}), ...clean };
  await pool.query('UPDATE qbo_connection SET settings = $1::jsonb, updated_at = NOW() WHERE id = 1', [JSON.stringify(next)]);
  return next;
}

// ─── links ────────────────────────────────────────────────────────────────
async function getLink(type, key) { const { rows: [l] } = await pool.query('SELECT * FROM qbo_links WHERE entity_type = $1 AND entity_key = $2', [type, String(key)]); return l || null; }
async function setLink(type, key, qboType, qboId, syncToken) {
  await pool.query(`INSERT INTO qbo_links (entity_type, entity_key, qbo_type, qbo_id, sync_token, synced_at) VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (entity_type, entity_key) DO UPDATE SET qbo_id = EXCLUDED.qbo_id, sync_token = EXCLUDED.sync_token, synced_at = NOW()`, [type, String(key), qboType, String(qboId), syncToken == null ? null : String(syncToken)]);
}

// ─── pushes ───────────────────────────────────────────────────────────────
async function ensureVendor(name, email) {
  const display = String(name || '').trim().slice(0, 100);
  if (!display) throw new QboError('The expense has no payee; QuickBooks needs a vendor name.', { code: 'NO_PAYEE', retryable: false });
  const key = display.toLowerCase();
  const link = await getLink('vendor', key); if (link) return link.qbo_id;
  const found = (await query(`select Id, DisplayName, SyncToken from Vendor where DisplayName = '${esc(display)}'`)).Vendor?.[0];
  let id = found?.Id;
  if (!id) {
    const body = { DisplayName: display, ...(email ? { PrimaryEmailAddr: { Address: String(email).slice(0, 100) } } : {}) };
    id = (await api('POST', '/vendor', body))?.Vendor?.Id;
  }
  if (!id) throw new QboError('QuickBooks did not return a vendor id.');
  await setLink('vendor', key, 'Vendor', id, found?.SyncToken);
  return id;
}

// The family: the root plus its split children, each with its own category and amount.
async function loadFamily(expenseId) {
  const { rows: [root] } = await pool.query('SELECT * FROM expenses WHERE id = $1', [expenseId]);
  if (!root) throw new QboError(`Expense #${expenseId} no longer exists.`, { code: 'GONE', retryable: false });
  const rootRow = root.parent_id ? (await pool.query('SELECT * FROM expenses WHERE id = $1', [root.parent_id])).rows[0] || root : root;
  const { rows: children } = await pool.query(`SELECT * FROM expenses WHERE parent_id = $1 AND (deleted = false OR deleted IS NULL) AND (voided = false OR voided IS NULL) ORDER BY id`, [rootRow.id]);
  return { root: rootRow, children };
}

const accountFor = (settings, category) => (settings.category_map && settings.category_map[category]) || settings.default_expense_account || null;
const dateOnly = (d) => { if (!d) return null; const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };

async function pushBill(expenseId) {
  const c = await getConnection(); if (!c) throw new QboError('QuickBooks is not connected.', { code: 'NOT_CONNECTED', status: 409, retryable: false });
  const settings = c.settings || {};
  const { root, children } = await loadFamily(expenseId);
  if (root.deleted || root.voided) throw new QboError('The expense was deleted or voided; nothing to push.', { code: 'GONE', retryable: false });
  if (root.status !== 'approved') throw new QboError('Only an approved expense becomes a Bill.', { code: 'NOT_APPROVED', retryable: false });
  const lines = (children.length ? children : [root]).map((row) => {
    const acct = accountFor(settings, row.category);
    if (!acct) throw new QboError(`No QuickBooks account for the category "${row.category || 'blank'}". Map it (or set a default expense account) under Settings › Integrations › QuickBooks.`, { code: 'UNMAPPED_CATEGORY', retryable: false });
    return {
      DetailType: 'AccountBasedExpenseLineDetail', Amount: Number(row.amount || 0),
      Description: [row.description, row.artist, row.song].filter(Boolean).join(' · ').slice(0, 4000) || null,
      AccountBasedExpenseLineDetail: { AccountRef: { value: acct.id, name: acct.name } },
    };
  });
  if (!lines.some((l) => l.Amount > 0)) throw new QboError('The expense has no amount.', { code: 'NO_AMOUNT', retryable: false });
  const vendorId = await ensureVendor(root.payee || root.vendor_name, root.vendor_email);
  const existing = await getLink('bill', root.id);
  const body = {
    VendorRef: { value: vendorId }, TxnDate: dateOnly(root.invoice_date) || dateOnly(root.approved_at) || undefined,
    DueDate: dateOnly(root.scheduled_payment_date) || undefined, DocNumber: root.invoice_number ? String(root.invoice_number).slice(0, 21) : undefined,
    PrivateNote: `Market Street dashboard expense #${root.id}`.slice(0, 4000), Line: lines,
    ...(settings.ap_account ? { APAccountRef: { value: settings.ap_account.id } } : {}),
  };
  if (existing) { body.Id = existing.qbo_id; body.SyncToken = existing.sync_token || '0'; body.sparse = true; }
  const bill = (await api('POST', '/bill', body))?.Bill;
  if (!bill?.Id) throw new QboError('QuickBooks did not return a Bill.');
  await setLink('bill', root.id, 'Bill', bill.Id, bill.SyncToken);
  await pool.query(`UPDATE expenses SET in_quickbooks = 'Yes', qb_entry_date = COALESCE(qb_entry_date, CURRENT_DATE) WHERE id = $1 OR parent_id = $1`, [root.id]).catch(() => {});
  return { bill_id: bill.Id, vendor_id: vendorId, lines: lines.length, updated: !!existing };
}

async function pushPayment(expenseId) {
  const c = await getConnection(); if (!c) throw new QboError('QuickBooks is not connected.', { code: 'NOT_CONNECTED', status: 409, retryable: false });
  const settings = c.settings || {};
  const { root, children } = await loadFamily(expenseId);
  if (root.payment_status !== 'Paid') throw new QboError('The expense is not marked Paid.', { code: 'NOT_PAID', retryable: false });
  if (!settings.bank_account) throw new QboError('Choose the bank account payments come from under Settings › Integrations › QuickBooks.', { code: 'NO_BANK_ACCOUNT', retryable: false });
  let bill = await getLink('bill', root.id);
  if (!bill) { await pushBill(root.id); bill = await getLink('bill', root.id); }
  const vendorId = await ensureVendor(root.payee || root.vendor_name, root.vendor_email);
  const total = (children.length ? children : [root]).reduce((s, r) => s + Number(r.amount || 0), 0);
  const existing = await getLink('payment', root.id);
  if (existing) return { payment_id: existing.qbo_id, bill_id: bill.qbo_id, already: true };
  const body = {
    VendorRef: { value: vendorId }, PayType: 'Check', TotalAmt: Number(total.toFixed(2)),
    CheckPayment: { BankAccountRef: { value: settings.bank_account.id, name: settings.bank_account.name } },
    TxnDate: dateOnly(root.payment_date) || undefined, DocNumber: root.payment_ref ? String(root.payment_ref).slice(0, 21) : undefined,
    PrivateNote: `Market Street dashboard payment for expense #${root.id}${root.payment_method ? ` (${root.payment_method})` : ''}`.slice(0, 4000),
    Line: [{ Amount: Number(total.toFixed(2)), LinkedTxn: [{ TxnId: bill.qbo_id, TxnType: 'Bill' }] }],
  };
  const p = (await api('POST', '/billpayment', body))?.BillPayment;
  if (!p?.Id) throw new QboError('QuickBooks did not return a BillPayment.');
  await setLink('payment', root.id, 'BillPayment', p.Id, p.SyncToken);
  return { payment_id: p.Id, bill_id: bill.qbo_id, total };
}

// ─── the queue ────────────────────────────────────────────────────────────
// Enqueue is a no-op when QuickBooks is not connected, so the ledger never
// waits on it. Safe to call from inside route handlers after their COMMIT.
async function enqueue(kind, expenseId, userId) {
  try {
    if (!(await getConnection())) return false;
    const { rows: [root] } = await pool.query('SELECT COALESCE(parent_id, id) AS root FROM expenses WHERE id = $1', [expenseId]);
    if (!root) return false;
    await pool.query(`INSERT INTO qbo_queue (kind, expense_id, status, attempts, next_attempt_at, last_error, requested_by, created_at)
      VALUES ($1, $2, 'pending', 0, NOW(), NULL, $3, NOW())
      ON CONFLICT (kind, expense_id) DO UPDATE SET status = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = NULL, done_at = NULL, requested_by = EXCLUDED.requested_by`,
      [kind, root.root, userId || null]);
    return true;
  } catch (e) { console.warn('[qbo] enqueue failed:', e.message); return false; }
}

// Claim one due row at a time (SKIP LOCKED: two workers never take the same row).
async function claimNext() {
  const { rows: [job] } = await pool.query(`UPDATE qbo_queue SET claimed_at = NOW(), attempts = attempts + 1
     WHERE id = (SELECT id FROM qbo_queue WHERE status = 'pending' AND next_attempt_at <= NOW() ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`);
  return job || null;
}

async function processQueue({ limit = 50 } = {}) {
  const out = { done: 0, failed: 0, skipped: 0 };
  if (!(await getConnection())) return out;
  for (let i = 0; i < limit; i += 1) {
    const job = await claimNext(); if (!job) break;
    try {
      const result = job.kind === 'payment' ? await pushPayment(job.expense_id) : await pushBill(job.expense_id);
      await pool.query(`UPDATE qbo_queue SET status = 'done', done_at = NOW(), last_error = NULL WHERE id = $1`, [job.id]);
      out.done += 1;
      await pool.query(`INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, new_value, details) VALUES ('QuickBooks sync', $1, $2, NULL, 'quickbooks', $3, $4)`,
        [job.kind === 'payment' ? 'qbo_payment_pushed' : 'qbo_bill_pushed', job.expense_id, String(result.payment_id || result.bill_id), JSON.stringify(result)]).catch(() => {});
    } catch (e) {
      const giveUp = e.retryable === false || job.attempts >= MAX_ATTEMPTS;
      const hours = Math.min(24, 2 ** Math.max(0, job.attempts - 1));
      await pool.query(`UPDATE qbo_queue SET status = $2, last_error = $3, next_attempt_at = NOW() + ($4 || ' hours')::interval WHERE id = $1`,
        [job.id, giveUp ? 'error' : 'pending', String(e.message).slice(0, 500), String(hours)]);
      out.failed += 1;
      if (e.code === 'NEEDS_RECONNECT' || e.code === 'NOT_CONNECTED') break;
    }
  }
  return out;
}

async function listQueue(limit = 50) {
  const { rows } = await pool.query(`SELECT q.*, e.payee, e.amount, e.invoice_number, l.qbo_id
    FROM qbo_queue q LEFT JOIN expenses e ON e.id = q.expense_id
    LEFT JOIN qbo_links l ON l.entity_type = CASE q.kind WHEN 'payment' THEN 'payment' ELSE 'bill' END AND l.entity_key = q.expense_id::text
    ORDER BY (q.status = 'error') DESC, (q.status = 'pending') DESC, q.id DESC LIMIT $1`, [limit]);
  return rows;
}

async function retry(queueId) {
  const { rowCount } = await pool.query(`UPDATE qbo_queue SET status = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = NULL WHERE id = $1`, [queueId]);
  return rowCount === 1;
}

module.exports = { isConfigured, status, authorizeUrl, connect, disconnect, listAccounts, saveSettings, enqueue, processQueue, listQueue, retry, pushBill, pushPayment, getConnection, QboError, ENV, DRY, _dry: dry };
