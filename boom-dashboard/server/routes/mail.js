// Connected mailboxes — Settings › Integrations › Mail and My settings › My mailbox.
//
//   GET  /mail/status                    anyone: purposes → connected, for the sentences screens show
//   GET  /mail/mailboxes                 shared boxes (admins see all fields), plus the caller's own
//   GET  /mail/connect?kind=shared|personal   returns the Google consent URL (state = signed JWT)
//   GET  /mail/oauth/callback            PUBLIC: Google returns here; stores the mailbox; redirects
//   PUT  /mail/purposes                  admin: { purpose: mailboxId|null, ... }
//   POST /mail/mailboxes/:id/test        owner/admin: sends a test to the caller
//   DELETE /mail/mailboxes/:id           owner/admin: disconnect (purposes go unassigned)
//   GET  /mail/log                       admin: last 50 sends
const express = require('express');
const https = require('https');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const paymentCrypto = require('../lib/payment-crypto');
const mail = require('../lib/mail');

const router = express.Router();
const APP_URL = process.env.FRONTEND_URL || 'https://marketst-production.up.railway.app';
const isAdmin = (r) => r === 'Admin' || r === 'Superadmin';
const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/userinfo.email'];
const redirectUri = () => `${APP_URL}/api/mail/oauth/callback`;
const publicBox = (m, full) => ({ id: m.id, address: m.address, display_name: m.display_name, kind: m.kind, owner_user_id: m.owner_user_id, source: m.source, status: m.status, connected_at: m.connected_at, last_used_at: m.last_used_at, ...(full ? { last_error: m.last_error, connected_by: m.connected_by } : {}) });

router.get('/status', authMiddleware, async (req, res) => {
  try { res.json({ success: true, data: await mail.purposesStatus(), configured: !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET) }); }
  catch (err) { console.error('mail status error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

router.get('/mailboxes', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT m.*, u.name AS connected_by_name FROM mailboxes m LEFT JOIN users u ON u.id = m.connected_by ORDER BY m.kind, m.connected_at`);
    const admin = isAdmin(req.user.role);
    const visible = rows.filter((m) => m.kind === 'shared' || Number(m.owner_user_id) === Number(req.user.id) || admin);
    res.json({ success: true, data: visible.map((m) => ({ ...publicBox(m, admin || Number(m.owner_user_id) === Number(req.user.id)), connected_by_name: m.connected_by_name })), purposes: await mail.purposesStatus(),
      configured: !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET), redirect_uri: redirectUri() });
  } catch (err) { console.error('mailboxes error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

// The consent URL. `state` binds the callback to this person and this kind;
// a stray or replayed callback cannot attach a mailbox to someone else.
router.get('/connect', authMiddleware, async (req, res) => {
  try {
    const kind = req.query.kind === 'personal' ? 'personal' : 'shared';
    if (kind === 'shared' && !isAdmin(req.user.role)) return res.status(403).json({ success: false, error: 'Only an admin can connect a shared mailbox' });
    if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) return res.status(503).json({ success: false, error: 'The Google OAuth client is not configured (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET).' });
    if (!paymentCrypto.isConfigured()) return res.status(503).json({ success: false, error: 'Encryption key not configured; a mailbox token cannot be stored.' });
    const state = jwt.sign({ uid: req.user.id, kind, t: 'mail_connect' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const params = new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code',
      scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
    });
    res.json({ success: true, data: { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` } });
  } catch (err) { console.error('mail connect error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

const postForm = (hostname, path, form) => new Promise((resolve, reject) => {
  const body = new URLSearchParams(form).toString();
  const req = https.request({ hostname, path, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (r) => {
    let data = ''; r.on('data', (c) => { data += c; }); r.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(`Non-JSON from ${hostname}: ${data.slice(0, 200)}`)); } });
  });
  req.on('error', reject); req.write(body); req.end();
});
const getJson = (url, token) => new Promise((resolve, reject) => {
  https.get(url, { headers: { Authorization: `Bearer ${token}` } }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Non-JSON userinfo')); } }); }).on('error', reject);
});

// Public: Google lands here. Every failure redirects to Settings with a reason.
router.get('/oauth/callback', async (req, res) => {
  const back = (q) => res.redirect(`/settings?${new URLSearchParams(q)}`);
  try {
    const { code, state, error } = req.query;
    if (error) return back({ tab: 'integrations', mail: 'denied' });
    let st; try { st = jwt.verify(String(state || ''), process.env.JWT_SECRET); } catch { return back({ tab: 'integrations', mail: 'badstate' }); }
    if (st.t !== 'mail_connect') return back({ tab: 'integrations', mail: 'badstate' });
    const tok = await postForm('oauth2.googleapis.com', '/token', { code: String(code), client_id: process.env.GMAIL_CLIENT_ID, client_secret: process.env.GMAIL_CLIENT_SECRET, redirect_uri: redirectUri(), grant_type: 'authorization_code' });
    if (!tok.refresh_token) { console.error('[mail] no refresh token in exchange:', tok.error || tok); return back({ tab: st.kind === 'personal' ? 'notifications' : 'integrations', mail: 'norefresh' }); }
    const info = await getJson('https://www.googleapis.com/oauth2/v3/userinfo', tok.access_token);
    const address = String(info.email || '').toLowerCase();
    if (!address) return back({ tab: 'integrations', mail: 'noemail' });
    const { rows: [existing] } = await pool.query('SELECT id, kind, owner_user_id FROM mailboxes WHERE address = $1', [address]);
    let id;
    if (existing) {
      // Reconnecting: refresh the token, keep the kind and purposes.
      await pool.query(`UPDATE mailboxes SET refresh_token_enc = $2, source = 'oauth', status = 'active', last_error = NULL, connected_by = $3, connected_at = NOW(), updated_at = NOW() WHERE id = $1`, [existing.id, paymentCrypto.encrypt(tok.refresh_token), st.uid]);
      id = existing.id;
    } else {
      const { rows: [mb] } = await pool.query(
        `INSERT INTO mailboxes (address, display_name, kind, owner_user_id, refresh_token_enc, source, status, connected_by, connected_at)
         VALUES ($1, 'market.st', $2, $3, $4, 'oauth', 'active', $5, NOW()) RETURNING id`,
        [address, st.kind, st.kind === 'personal' ? st.uid : null, paymentCrypto.encrypt(tok.refresh_token), st.uid]);
      id = mb.id;
      if (st.kind === 'shared') await mail.claimUnassignedPurposes(id);
    }
    mail.tokenCache.delete(id);
    return back({ tab: st.kind === 'personal' ? 'notifications' : 'integrations', mail: 'connected', address });
  } catch (err) { console.error('mail callback error:', err); return back({ tab: 'integrations', mail: 'error' }); }
});

router.put('/purposes', authMiddleware, async (req, res) => {
  try {
    if (!isAdmin(req.user.role)) return res.status(403).json({ success: false, error: 'Admins only' });
    const body = req.body || {};
    for (const [purpose, mailboxId] of Object.entries(body)) {
      if (!mail.PURPOSE_KEYS.has(purpose)) return res.status(400).json({ success: false, error: `Unknown purpose ${purpose}` });
      if (mailboxId === null || mailboxId === '') { await pool.query('DELETE FROM mailbox_purposes WHERE purpose = $1', [purpose]); continue; }
      const mb = await mail.mailboxById(mailboxId);
      if (!mb || mb.kind !== 'shared') return res.status(400).json({ success: false, error: 'Purposes can only be owned by a shared mailbox' });
      await pool.query('INSERT INTO mailbox_purposes (purpose, mailbox_id) VALUES ($1, $2) ON CONFLICT (purpose) DO UPDATE SET mailbox_id = EXCLUDED.mailbox_id', [purpose, mb.id]);
    }
    res.json({ success: true, data: await mail.purposesStatus() });
  } catch (err) { console.error('mail purposes error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

router.put('/mailboxes/:id(\\d+)', authMiddleware, async (req, res) => {
  try {
    const mb = await mail.mailboxById(req.params.id);
    if (!mb) return res.status(404).json({ success: false, error: 'Mailbox not found' });
    if (!(isAdmin(req.user.role) || Number(mb.owner_user_id) === Number(req.user.id))) return res.status(403).json({ success: false, error: 'Not yours' });
    const name = String(req.body?.display_name || '').trim().slice(0, 80) || 'market.st';
    await pool.query('UPDATE mailboxes SET display_name = $2, updated_at = NOW() WHERE id = $1', [mb.id, name]);
    res.json({ success: true, data: { ...publicBox(mb, true), display_name: name } });
  } catch (err) { console.error('mailbox rename error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

router.post('/mailboxes/:id(\\d+)/test', authMiddleware, async (req, res) => {
  try {
    const mb = await mail.mailboxById(req.params.id);
    if (!mb) return res.status(404).json({ success: false, error: 'Mailbox not found' });
    if (!(isAdmin(req.user.role) || Number(mb.owner_user_id) === Number(req.user.id))) return res.status(403).json({ success: false, error: 'Not yours' });
    const r = await mail.runWithMailContext({ actor: { id: req.user.id, email: req.user.email, name: req.user.name } }, () => mail.sendMail({
      from: mb.id, kind: 'test', purpose: 'team', to: req.user.email, subject: `Test from ${mb.address}`,
      html: require('../lib/email-layout').layout({ title: 'Test message', eyebrow: 'Mail check', accent: 'royal', body: require('../lib/email-layout').p(`This is a test from the dashboard, sent from ${mb.address} by ${req.user.name || req.user.email}. If you can read this, the mailbox is connected and sending.`) }),
    }));
    res.json({ success: true, data: r });
  } catch (err) { console.error('mail test error:', err); res.status(err.code === 'MAIL_NEEDS_RECONNECT' ? 409 : 500).json({ success: false, error: err.message }); }
});

router.delete('/mailboxes/:id(\\d+)', authMiddleware, async (req, res) => {
  try {
    const mb = await mail.mailboxById(req.params.id);
    if (!mb) return res.status(404).json({ success: false, error: 'Mailbox not found' });
    if (mb.kind === 'shared' && !isAdmin(req.user.role)) return res.status(403).json({ success: false, error: 'Only an admin can disconnect a shared mailbox' });
    if (mb.kind === 'personal' && !(isAdmin(req.user.role) || Number(mb.owner_user_id) === Number(req.user.id))) return res.status(403).json({ success: false, error: 'Not yours' });
    const { rows: freed } = await pool.query('DELETE FROM mailbox_purposes WHERE mailbox_id = $1 RETURNING purpose', [mb.id]);
    await pool.query('DELETE FROM mailboxes WHERE id = $1', [mb.id]);
    mail.tokenCache.delete(mb.id);
    res.json({ success: true, data: { unassigned: freed.map((f) => f.purpose) } });
  } catch (err) { console.error('mailbox delete error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

router.get('/log', authMiddleware, async (req, res) => {
  try {
    if (!isAdmin(req.user.role)) return res.status(403).json({ success: false, error: 'Admins only' });
    const { rows } = await pool.query(
      `SELECT l.*, m.address, u.name AS sent_by_name FROM mail_log l LEFT JOIN mailboxes m ON m.id = l.mailbox_id LEFT JOIN users u ON u.id = l.sent_by ORDER BY l.created_at DESC LIMIT 50`);
    const { rows: [today] } = await pool.query(`SELECT COUNT(*)::int AS n FROM mail_log WHERE status = 'sent' AND created_at > NOW() - INTERVAL '24 hours'`);
    res.json({ success: true, data: rows, sent_24h: today.n });
  } catch (err) { console.error('mail log error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

module.exports = router;
