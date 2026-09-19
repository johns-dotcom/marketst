const express = require('express');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const TYPE_LABELS = {
  workflow:       'Workflow Request',
  formatting:     'Formatting Feedback',
  recommendation: 'Feature Recommendation',
  issue:          'Bug / Issue Report',
};

// This file used to carry its own copy of the Gmail token exchange. It had no
// callers — requests send through services/emailDispatch — so it was removed
// rather than repointed at lib/google-oauth.js. sendViaGmailAPI below is dead
// for the same reason; left in place because deleting it is a separate change.


// POST /api/requests
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { type, title, details, page } = req.body;
    const user = req.user;

    if (!type || !title || !details) {
      return res.status(400).json({ success: false, error: 'Type, title, and details are required' });
    }

    const typeLabel = TYPE_LABELS[type] || type;
    const timestamp = new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });

    // Build preview payload — the client opens EmailPreviewModal so the
    // submitter can review the email going to johns@ before it's sent.
    const ctx = {
      typeLabel,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role || '',
      page: page || '',
      title,
      details,
      timestamp,
    };
    let pending_email = null;
    try {
      const { prepareEmail } = require('../services/emailDispatch');
      const preview = await prepareEmail('internal_request', ctx);
      pending_email = { kind: 'internal_request', context: ctx, ...preview };
    } catch (err) {
      console.warn('internal_request preview failed:', err.message);
    }

    res.json({ success: true, pending_email });
  } catch (error) {
    console.error('Request submit error:', error);
    res.status(500).json({ success: false, error: 'Failed to send request' });
  }
});

module.exports = router;
