// DocuSign — Settings › Integrations › DocuSign, and "Send for signature" on
// Contracts, NDAs and Label waivers. The work is in lib/docusign.js.
//
//   GET  /docusign/status                 signed in: connected?, label signer (for the Send dialog)
//   GET  /docusign/connect                admin: consent URL (state = signed JWT)
//   GET  /docusign/oauth/callback         PUBLIC: DocuSign returns here; redirects to Settings
//   DELETE /docusign/account              admin: forget the account
//   POST /docusign/send                   signed in: multipart { doc_type, doc_id, signer_name, signer_email, message, file? }
//   GET  /docusign/envelopes              ?doc_type=&doc_id= · ?artist_id= · (admin) all, last 50
//   POST /docusign/envelopes/:id/refresh  pull the status now
//   POST /docusign/envelopes/:id/void     { reason }
//   POST /docusign/webhook                PUBLIC: Connect nudges a refresh of one envelope (status is re-read from DocuSign, never trusted from the body)
const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const ds = require('../lib/docusign');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const APP_URL = process.env.FRONTEND_URL || 'https://marketst-production.up.railway.app';
const redirectUri = () => `${APP_URL}/api/docusign/oauth/callback`;
const isAdmin = (role) => role === 'Admin' || role === 'Superadmin';
const adminOnly = [authMiddleware, (req, res, next) => (isAdmin(req.user.role) ? next() : res.status(403).json({ success: false, error: 'Admin only' }))];
const fail = (res, e, where) => {
  if (e instanceof ds.DocuSignError) return res.status(e.status || 500).json({ success: false, error: e.message, code: e.code });
  console.error(`docusign ${where} error:`, e); return res.status(500).json({ success: false, error: 'Internal server error' });
};

router.get('/status', authMiddleware, async (req, res) => {
  try {
    const st = await ds.status(); const signer = await ds.labelSigner();
    const pub = { configured: st.configured, connected: st.connected, env: st.env, status: st.status, label_signer: { name: signer.name, email: signer.email }, open: st.open, completed: st.completed };
    res.json({ success: true, data: isAdmin(req.user.role) ? { ...st, ...pub, redirect_uri: redirectUri() } : pub });
  } catch (e) { fail(res, e, 'status'); }
});

router.get('/connect', adminOnly, async (req, res) => {
  try {
    if (!ds.isConfigured()) return res.status(503).json({ success: false, error: 'The DocuSign app is not configured (DOCUSIGN_INTEGRATION_KEY / DOCUSIGN_SECRET).' });
    const state = jwt.sign({ uid: req.user.id, t: 'docusign_connect' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    res.json({ success: true, data: { url: ds.authorizeUrl({ redirectUri: redirectUri(), state }) } });
  } catch (e) { fail(res, e, 'connect'); }
});

router.get('/oauth/callback', async (req, res) => {
  const back = (q) => res.redirect(`/settings?${new URLSearchParams({ tab: 'integrations', ...q })}`);
  try {
    const { code, state, error } = req.query;
    let st; try { st = jwt.verify(String(state || ''), process.env.JWT_SECRET); } catch { return back({ ds: 'badstate' }); }
    if (st.t !== 'docusign_connect') return back({ ds: 'badstate' });
    if (error || !code) return back({ ds: 'denied' });
    const out = await ds.connect({ code: String(code), redirectUri: redirectUri(), userId: st.uid });
    return back({ ds: 'connected', ...(out.account_name ? { account: out.account_name } : {}) });
  } catch (e) { console.error('docusign callback error:', e.message); return back({ ds: 'error' }); }
});

router.delete('/account', adminOnly, async (req, res) => { try { res.json({ success: true, data: { removed: await ds.disconnect() } }); } catch (e) { fail(res, e, 'disconnect'); } });

router.post('/send', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const b = req.body || {};
    const uploaded = req.file ? { buffer: req.file.buffer, name: req.file.originalname || 'document.pdf' } : null;
    if (uploaded && !(req.file.mimetype === 'application/pdf' || /\.pdf$/i.test(uploaded.name))) return res.status(400).json({ success: false, error: 'Only a PDF can be sent for signature.' });
    const row = await ds.send({ docType: String(b.doc_type || ''), docId: Number(b.doc_id), signerName: b.signer_name, signerEmail: b.signer_email, message: b.message ? String(b.message).slice(0, 2000) : null, uploaded, userId: req.user.id });
    req._activityDetail = `${row.title} → ${row.signer_email}`;
    res.status(201).json({ success: true, data: row });
  } catch (e) { fail(res, e, 'send'); }
});

router.get('/envelopes', authMiddleware, async (req, res) => {
  try {
    const { doc_type, doc_id, artist_id } = req.query;
    let rows;
    if (doc_type && doc_id) ({ rows } = await pool.query('SELECT * FROM signature_envelopes WHERE doc_type = $1 AND doc_id = $2 ORDER BY sent_at DESC', [String(doc_type), Number(doc_id)]));
    else if (artist_id) ({ rows } = await pool.query('SELECT * FROM signature_envelopes WHERE artist_id = $1 ORDER BY sent_at DESC', [Number(artist_id)]));
    else if (doc_type) ({ rows } = await pool.query('SELECT * FROM signature_envelopes WHERE doc_type = $1 ORDER BY sent_at DESC LIMIT 200', [String(doc_type)]));
    else if (isAdmin(req.user.role)) ({ rows } = await pool.query('SELECT * FROM signature_envelopes ORDER BY sent_at DESC LIMIT 50'));
    else return res.status(400).json({ success: false, error: 'Name a document or an artist' });
    res.json({ success: true, data: rows });
  } catch (e) { fail(res, e, 'envelopes'); }
});

const load = async (id) => (await pool.query('SELECT * FROM signature_envelopes WHERE id = $1', [id])).rows[0] || null;
router.post('/envelopes/:id/refresh', authMiddleware, async (req, res) => {
  try { const row = await load(Number(req.params.id)); if (!row) return res.status(404).json({ success: false, error: 'Not found' }); res.json({ success: true, data: await ds.refreshEnvelope(row) }); } catch (e) { fail(res, e, 'refresh'); }
});
router.post('/envelopes/:id/void', authMiddleware, async (req, res) => {
  try {
    const row = await load(Number(req.params.id)); if (!row) return res.status(404).json({ success: false, error: 'Not found' });
    if (!isAdmin(req.user.role) && row.sent_by !== req.user.id) return res.status(403).json({ success: false, error: 'Only the sender or an admin can void it' });
    res.json({ success: true, data: await ds.voidEnvelope(row, req.body?.reason) });
  } catch (e) { fail(res, e, 'void'); }
});

// Connect webhook: we only take the envelope id and re-read the truth from DocuSign.
router.post('/webhook', async (req, res) => {
  try {
    const id = req.body?.data?.envelopeId || req.body?.envelopeId || req.body?.envelopeStatus?.envelopeID;
    if (id) { const { rows: [row] } = await pool.query('SELECT * FROM signature_envelopes WHERE envelope_id = $1', [String(id)]); if (row) ds.refreshEnvelope(row).catch(() => {}); }
    res.status(200).end();
  } catch { res.status(200).end(); }
});

module.exports = router;
