/**
 * /api/email — generic preview + send endpoints used by EmailPreviewModal.
 *
 * Every email-sending workflow in the app goes through here: the modal calls
 * POST /preview to render the HTML for review, the user edits inline, then
 * POST /send fires the underlying mail. Dispatch logic per kind lives in
 * services/emailDispatch.js so the templates and gmail integration stay in
 * one place.
 */
const express = require('express');
const auth = require('../middleware/auth');
const { prepareEmail, dispatchSend } = require('../services/emailDispatch');

const router = express.Router();
router.use(auth);

// Admins (+ Approvers, which already counts as bookkeeping admin elsewhere)
// can send emails. Welcome / test-invitation kinds additionally require
// Superadmin since they're tied to user-management features.
const isAdmin = (user) =>
  user && (user.role === 'Admin' || user.role === 'Superadmin' || user.role === 'Approver');

// POST /api/email/preview — { kind, context, [to, cc, subject, message] }
// Returns the rendered HTML + default field values. Idempotent — never sends.
router.post('/preview', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { kind, context = {} } = req.body || {};
    if (!kind) return res.status(400).json({ success: false, error: 'kind required' });
    const base = await prepareEmail(kind, context);
    // Caller-supplied overrides win on echo — used by the message-changes
    // debounce so the preview re-renders without losing form state.
    const data = {
      ...base,
      to: req.body?.to != null ? String(req.body.to) : base.to,
      cc: req.body?.cc != null ? String(req.body.cc) : base.cc,
      subject: req.body?.subject != null ? String(req.body.subject) : base.subject,
      message: req.body?.message != null ? String(req.body.message) : '',
    };
    res.json({ success: true, data });
  } catch (err) {
    console.error('POST /api/email/preview:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/email/send — { kind, context, to?, cc?, subject?, html_override?, message? }
// Fires the underlying sender. Returns { to, cc } so the client can echo them
// in a success toast.
router.post('/send', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { kind, context = {} } = req.body || {};
    if (!kind) return res.status(400).json({ success: false, error: 'kind required' });
    const override = {
      to: req.body?.to ? String(req.body.to).trim() : undefined,
      cc: req.body?.cc !== undefined ? String(req.body.cc) : undefined,
      subject: req.body?.subject ? String(req.body.subject) : undefined,
      html_override: req.body?.html_override || undefined,
      message: req.body?.message || undefined,
    };
    if (!override.to) {
      return res.status(400).json({ success: false, error: 'Recipient email required' });
    }
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(override.to)) {
      return res.status(400).json({ success: false, error: 'Invalid recipient email' });
    }
    if (override.cc) {
      const parts = override.cc.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (!emailRe.test(p)) return res.status(400).json({ success: false, error: `Invalid CC email: ${p}` });
      }
      override.cc = parts.join(', ');
    }
    // Who is sending (Reply-To for shared boxes) and, optionally, their own mailbox.
    const { runWithMailContext, mailboxById } = require('../lib/mail');
    let fromMailboxId = null;
    if (req.body?.from_mailbox_id) {
      const mb = await mailboxById(req.body.from_mailbox_id);
      if (!mb) return res.status(400).json({ success: false, error: 'That mailbox is not connected' });
      if (mb.kind === 'personal' && Number(mb.owner_user_id) !== Number(req.user.id) && req.user.role !== 'Superadmin') return res.status(403).json({ success: false, error: 'You can only send from your own mailbox' });
      fromMailboxId = mb.id;
    }
    const result = await runWithMailContext({ actor: { id: req.user.id, email: req.user.email, name: req.user.name }, fromMailboxId }, () => dispatchSend(kind, context, override));
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /api/email/send:', err);
    res.status(err.code === 'MAIL_NOT_CONNECTED' || err.code === 'MAIL_NEEDS_RECONNECT' ? 409 : 500).json({ success: false, error: err.message, code: err.code });
  }
});

module.exports = router;
