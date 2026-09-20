// QuickBooks Online — Settings › Integrations › QuickBooks. Pushes live in lib/qbo.js.
//
//   GET  /quickbooks/status            admin: connection (no tokens), settings, queue counts
//   GET  /quickbooks/connect           admin: Intuit consent URL (state = signed JWT)
//   GET  /quickbooks/oauth/callback    PUBLIC: Intuit returns here with code + realmId; redirects to Settings
//   DELETE /quickbooks/connection      admin: revoke + forget
//   GET  /quickbooks/accounts          admin: expense / bank / A-P accounts from QuickBooks, for the mapping
//   GET  /quickbooks/categories        admin: the ledger's expense categories, for the mapping
//   PUT  /quickbooks/settings          admin: { default_expense_account, bank_account, category_map }
//   GET  /quickbooks/queue             admin: last 50 queue rows
//   POST /quickbooks/sync              admin: process the queue now
//   POST /quickbooks/queue/:id/retry   admin: reset a row to pending
//   POST /quickbooks/expenses/:id/push admin: enqueue a bill (and payment if Paid) for one expense
const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const qbo = require('../lib/qbo');

const router = express.Router();
const APP_URL = process.env.FRONTEND_URL || 'https://marketst-production.up.railway.app';
const redirectUri = () => `${APP_URL}/api/quickbooks/oauth/callback`;
const isAdmin = (role) => role === 'Admin' || role === 'Superadmin';
const adminOnly = [authMiddleware, (req, res, next) => (isAdmin(req.user.role) ? next() : res.status(403).json({ success: false, error: 'Admin only' }))];
const fail = (res, e, where) => {
  if (e instanceof qbo.QboError) return res.status(e.status || 500).json({ success: false, error: e.message, code: e.code });
  console.error(`quickbooks ${where} error:`, e); return res.status(500).json({ success: false, error: 'Internal server error' });
};

router.get('/status', adminOnly, async (req, res) => { try { res.json({ success: true, data: { ...(await qbo.status()), redirect_uri: redirectUri() } }); } catch (e) { fail(res, e, 'status'); } });

router.get('/connect', adminOnly, async (req, res) => {
  try {
    if (!qbo.isConfigured()) return res.status(503).json({ success: false, error: 'The QuickBooks app is not configured (QBO_CLIENT_ID / QBO_CLIENT_SECRET).' });
    const state = jwt.sign({ uid: req.user.id, t: 'qbo_connect' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    res.json({ success: true, data: { url: qbo.authorizeUrl({ redirectUri: redirectUri(), state }) } });
  } catch (e) { fail(res, e, 'connect'); }
});

// Public: Intuit lands here. Every failure redirects to Settings with a reason.
router.get('/oauth/callback', async (req, res) => {
  const back = (q) => res.redirect(`/settings?${new URLSearchParams({ tab: 'integrations', ...q })}`);
  try {
    const { code, state, realmId, error } = req.query;
    let st; try { st = jwt.verify(String(state || ''), process.env.JWT_SECRET); } catch { return back({ qb: 'badstate' }); }
    if (st.t !== 'qbo_connect') return back({ qb: 'badstate' });
    if (error || !code || !realmId) return back({ qb: 'denied' });
    const out = await qbo.connect({ code: String(code), realmId: String(realmId), redirectUri: redirectUri(), userId: st.uid });
    return back({ qb: 'connected', ...(out.company_name ? { company: out.company_name } : {}) });
  } catch (e) { console.error('quickbooks callback error:', e.message); return back({ qb: 'error' }); }
});

router.delete('/connection', adminOnly, async (req, res) => { try { res.json({ success: true, data: { removed: await qbo.disconnect() } }); } catch (e) { fail(res, e, 'disconnect'); } });
router.get('/accounts', adminOnly, async (req, res) => { try { res.json({ success: true, data: await qbo.listAccounts() }); } catch (e) { fail(res, e, 'accounts'); } });
router.get('/categories', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT name FROM bk_categories WHERE kind = 'expense' AND active = true ORDER BY sort_order NULLS LAST, name`).catch(() => ({ rows: [] }));
    const { rows: used } = await pool.query(`SELECT DISTINCT category AS name FROM expenses WHERE category IS NOT NULL AND category <> '' AND status = 'approved' ORDER BY 1 LIMIT 300`).catch(() => ({ rows: [] }));
    const names = [...new Set([...rows.map((r) => r.name), ...used.map((r) => r.name)])];
    res.json({ success: true, data: names });
  } catch (e) { fail(res, e, 'categories'); }
});
router.put('/settings', adminOnly, async (req, res) => { try { res.json({ success: true, data: await qbo.saveSettings(req.body || {}) }); } catch (e) { fail(res, e, 'settings'); } });
router.get('/queue', adminOnly, async (req, res) => { try { res.json({ success: true, data: await qbo.listQueue(Math.min(200, Number(req.query.limit) || 50)) }); } catch (e) { fail(res, e, 'queue'); } });
router.post('/sync', adminOnly, async (req, res) => { try { res.json({ success: true, data: await qbo.processQueue({ limit: 100 }) }); } catch (e) { fail(res, e, 'sync'); } });
router.post('/queue/:id/retry', adminOnly, async (req, res) => {
  try { const ok = await qbo.retry(Number(req.params.id)); if (!ok) return res.status(404).json({ success: false, error: 'Not found' }); res.json({ success: true }); } catch (e) { fail(res, e, 'retry'); }
});
router.post('/expenses/:id/push', adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows: [e] } = await pool.query('SELECT id, status, payment_status FROM expenses WHERE id = $1', [id]);
    if (!e) return res.status(404).json({ success: false, error: 'Expense not found' });
    if (!(await qbo.getConnection())) return res.status(409).json({ success: false, error: 'QuickBooks is not connected.', code: 'NOT_CONNECTED' });
    if (e.status !== 'approved') return res.status(400).json({ success: false, error: 'Only an approved expense is pushed as a Bill.' });
    await qbo.enqueue('bill', id, req.user.id);
    if (e.payment_status === 'Paid') await qbo.enqueue('payment', id, req.user.id);
    const result = req.query.now === '1' ? await qbo.processQueue({ limit: 5 }) : null;
    res.json({ success: true, data: { queued: true, result } });
  } catch (e) { fail(res, e, 'push'); }
});

module.exports = router;
