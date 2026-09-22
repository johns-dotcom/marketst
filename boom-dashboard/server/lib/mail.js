// Connected mailboxes: which address a message goes from, and the one place
// it goes from (2026-09-19 plan, "Connected mailboxes").
//
//   mailboxes          a connected Google address (refresh token encrypted, or
//                      the env sender imported on boot as source 'env')
//   mailbox_purposes   purpose → mailbox; every kind of mail has a purpose
//   mail_log           one row per attempt, whatever happened
//
// sendMail({ purpose, to, cc, subject, html, attachments, from, replyTo, entity })
// resolves the mailbox — `from` (a mailbox id, a personal one) wins, else the
// purpose's owner — exchanges its refresh token, sends, logs. A purpose with no
// mailbox throws MailNotConnected, whose message is the sentence screens show.
// A revoked token (invalid_grant) marks the mailbox 'needs_reconnect' and is
// never retried silently.
//
// runWithMailContext({ actor, fromMailboxId }, fn): the route that knows WHO
// is sending wraps the dispatch so the senders in services/email.js need no
// new parameters. A human sending from a shared box gets Reply-To = their own
// address; automated mail sets none.
const { AsyncLocalStorage } = require('async_hooks');
const pool = require('../db');
const paymentCrypto = require('./payment-crypto');
const { getAccessTokenFor, credentialsPresent } = require('./google-oauth');
const { sendViaGmailAPI } = require('./gmail-transport');

const PURPOSES = [
  { key: 'payments', label: 'Payments', what: 'payment confirmations, bulk confirmations, the approval summary' },
  { key: 'vendors',  label: 'Vendors and creators', what: 'vendor approved and rejected, W-9 chases' },
  { key: 'team',     label: 'Team', what: 'invites, welcome, task assigned, mentions, requests, notifications' },
  { key: 'artists',  label: 'Artists', what: 'statements and onboarding mail (when built)' },
  { key: 'clients',  label: 'Clients', what: 'outgoing invoices (when sending is added)' },
];
const PURPOSE_KEYS = new Set(PURPOSES.map((p) => p.key));
const PURPOSE_OF_KIND = {
  welcome: 'team', test_invitation: 'team', task_assigned: 'team', internal_request: 'team', chat_mention: 'team', invite: 'team', notification: 'team',
  payment_confirmation: 'payments', bulk_payment_confirmation: 'payments', approval_summary: 'payments',
  vendor_approved: 'vendors', vendor_rejected: 'vendors',
};

class MailNotConnected extends Error {
  constructor(purpose) {
    const p = PURPOSES.find((x) => x.key === purpose);
    super(`${p ? p.label : purpose} mail is not connected — connect a mailbox under Settings › Integrations › Mail.`);
    this.code = 'MAIL_NOT_CONNECTED'; this.purpose = purpose;
  }
}

const als = new AsyncLocalStorage();
const runWithMailContext = (ctx, fn) => als.run(ctx || {}, fn);
const mailContext = () => als.getStore() || {};

// Dev and fixtures: MAIL_DRY_RUN=1 records the send without calling Gmail.
const DRY_RUN = process.env.MAIL_DRY_RUN === '1';

const tokenCache = new Map(); // mailbox id → { token, exp }
async function accessTokenFor(mb) {
  const hit = tokenCache.get(mb.id);
  if (hit && hit.exp > Date.now() + 60000) return hit.token;
  let refresh;
  if (mb.source === 'env') refresh = process.env.GMAIL_REFRESH_TOKEN;
  else refresh = paymentCrypto.decrypt(mb.refresh_token_enc);
  if (!refresh) throw Object.assign(new Error('Mailbox has no refresh token'), { code: 'invalid_grant' });
  const token = await getAccessTokenFor(refresh);
  tokenCache.set(mb.id, { token, exp: Date.now() + 50 * 60000 });
  return token;
}

async function mailboxById(id, q = pool) {
  const { rows: [mb] } = await q.query('SELECT * FROM mailboxes WHERE id = $1', [id]);
  return mb || null;
}
async function mailboxForPurpose(purpose, q = pool) {
  const { rows: [mb] } = await q.query(
    `SELECT m.* FROM mailbox_purposes mp JOIN mailboxes m ON m.id = mp.mailbox_id WHERE mp.purpose = $1`, [purpose]);
  return mb || null;
}
async function purposesStatus(q = pool) {
  const { rows } = await q.query(`SELECT mp.purpose, m.id, m.address, m.display_name, m.status FROM mailbox_purposes mp JOIN mailboxes m ON m.id = mp.mailbox_id`);
  const by = Object.fromEntries(rows.map((r) => [r.purpose, r]));
  return PURPOSES.map((p) => ({ ...p, mailbox: by[p.key] ? { id: by[p.key].id, address: by[p.key].address, display_name: by[p.key].display_name, status: by[p.key].status } : null, connected: !!by[p.key] && by[p.key].status === 'active' }));
}
async function isConnected(purpose, q = pool) {
  const mb = await mailboxForPurpose(purpose, q);
  return !!mb && mb.status === 'active';
}

const fromHeaderFor = (mb) => `${(mb.display_name || 'market.st').replace(/["<>]/g, '')} <${mb.address}>`;

async function sendMail({ purpose, kind, to, cc, subject, html, attachments, from, replyTo, entity }) {
  const ctx = mailContext();
  const resolvedPurpose = purpose || PURPOSE_OF_KIND[kind] || 'team';
  const fromId = from || ctx.fromMailboxId || null;
  let mb = fromId ? await mailboxById(fromId) : await mailboxForPurpose(resolvedPurpose);
  if (!mb) throw new MailNotConnected(resolvedPurpose);
  if (mb.status !== 'active') throw Object.assign(new Error(`${mb.address} needs reconnecting — Settings › Integrations › Mail.`), { code: 'MAIL_NEEDS_RECONNECT' });
  // A person sending from a SHARED box: replies should reach them.
  const reply = replyTo || (mb.kind === 'shared' && ctx.actor?.email ? ctx.actor.email : undefined);
  const log = async (status, error, gmailId) => pool.query(
    `INSERT INTO mail_log (mailbox_id, purpose, kind, to_addr, cc_addr, subject, status, error, entity_type, entity_id, sent_by, gmail_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [mb.id, resolvedPurpose, kind || null, String(to), cc || null, String(subject || '').slice(0, 300), status, error ? String(error).slice(0, 500) : null,
     entity?.type || null, entity?.id != null ? String(entity.id) : null, ctx.actor?.id || null, gmailId || null]).catch((e) => console.warn('[mail] log failed:', e.message));
  if (DRY_RUN) { await log('dry_run', null, null); await pool.query('UPDATE mailboxes SET last_used_at = NOW() WHERE id = $1', [mb.id]).catch(() => {}); return { dry_run: true, mailbox: mb.address }; }
  try {
    const token = await accessTokenFor(mb);
    const res = await sendViaGmailAPI(token, { from: fromHeaderFor(mb), replyTo: reply, to, cc: cc || undefined, subject, html, attachments: attachments || [] });
    await log('sent', null, res?.id || null);
    await pool.query('UPDATE mailboxes SET last_used_at = NOW(), last_error = NULL WHERE id = $1', [mb.id]).catch(() => {});
    return { sent: true, mailbox: mb.address, id: res?.id || null };
  } catch (err) {
    const revoked = err.code === 'invalid_grant' || /invalid_grant/.test(err.message || '');
    await log('failed', err.message, null);
    await pool.query('UPDATE mailboxes SET last_error = $2, status = CASE WHEN $3 THEN \'needs_reconnect\' ELSE status END WHERE id = $1', [mb.id, String(err.message).slice(0, 500), revoked]).catch(() => {});
    if (revoked) tokenCache.delete(mb.id);
    throw err;
  }
}

// The env sender becomes the first shared mailbox, owning every purpose, so
// mail keeps working through the change. Nothing is written if a mailbox
// already exists.
async function importEnvMailbox() {
  try {
    if (!credentialsPresent() || !process.env.GMAIL_USER) return false;
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM mailboxes');
    if (rows[0].n > 0) return false;
    const { rows: [mb] } = await pool.query(
      `INSERT INTO mailboxes (address, display_name, kind, source, status, connected_at)
       VALUES ($1, 'market.st', 'shared', 'env', 'active', NOW()) RETURNING id`, [String(process.env.GMAIL_USER).toLowerCase()]);
    for (const p of PURPOSES) await pool.query('INSERT INTO mailbox_purposes (purpose, mailbox_id) VALUES ($1, $2) ON CONFLICT (purpose) DO NOTHING', [p.key, mb.id]);
    console.log(`[mail] imported the environment sender ${process.env.GMAIL_USER} as the first shared mailbox`);
    return true;
  } catch (err) { console.warn('[mail] env import skipped:', err.message); return false; }
}

// Assign every unowned purpose to a (shared) mailbox — the first connection
// is enough to make all mail work.
async function claimUnassignedPurposes(mailboxId, q = pool) {
  for (const p of PURPOSES) await q.query('INSERT INTO mailbox_purposes (purpose, mailbox_id) VALUES ($1, $2) ON CONFLICT (purpose) DO NOTHING', [p.key, mailboxId]);
}

module.exports = { PURPOSES, PURPOSE_KEYS, PURPOSE_OF_KIND, MailNotConnected, sendMail, runWithMailContext, mailContext, mailboxById, mailboxForPurpose, purposesStatus, isConnected, importEnvMailbox, claimUnassignedPurposes, tokenCache };
