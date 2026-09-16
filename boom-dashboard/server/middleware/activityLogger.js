const pool = require('../db');

// Map method + normalized path to a human-readable action label
function getActionLabel(method, rawPath) {
  // Normalize: strip query string, collapse numeric/uuid segments to :id
  const path = rawPath.split('?')[0].replace(/\/\d+/g, '/:id');
  const key = `${method} ${path}`;

  const MAP = {
    // Auth
    'POST /api/auth/login':    'Signed In',
    'POST /api/auth/register': 'Registered User',

    // Releases
    'GET /api/releases':             'Viewed Releases',
    'GET /api/releases/:id':         'Viewed Release',
    'POST /api/releases':            'Created Release',
    'PUT /api/releases/:id':         'Updated Release',
    'DELETE /api/releases/:id':      'Deleted Release',
    'GET /api/releases/:id/comments':'Viewed Release Comments',
    'POST /api/releases/:id/comments':'Added Release Comment',

    // Artists
    'GET /api/artists':              'Viewed Artists',
    'GET /api/artists/:id':          'Viewed Artist',
    'POST /api/artists':             'Created Artist',
    'PUT /api/artists/:id':          'Updated Artist',
    'DELETE /api/artists/:id':       'Deleted Artist',

    // Contracts
    'GET /api/contracts':            'Viewed Contracts',
    'GET /api/contracts/:id':        'Viewed Contract',
    'POST /api/contracts':           'Created Contract',
    'PUT /api/contracts/:id':        'Updated Contract',
    'DELETE /api/contracts/:id':     'Deleted Contract',

    // Deals
    'GET /api/deals':                'Viewed Deals',
    'POST /api/deals':               'Created Deal',
    'PUT /api/deals/:id':            'Updated Deal',
    'DELETE /api/deals/:id':         'Deleted Deal',

    // Team
    'GET /api/team':                 'Viewed Team',
    'GET /api/team/:id':             'Viewed Team Member',
    'POST /api/team':                'Added Team Member',
    'PUT /api/team/:id':             'Updated Team Member',
    'DELETE /api/team/:id':          'Removed Team Member',

    // Tasks (my-work)
    'GET /api/team/:id/tasks':       'Viewed Tasks',
    'POST /api/team/:id/tasks':      'Created Task',
    'PUT /api/team/:id/tasks/:id':   'Updated Task',
    'DELETE /api/team/:id/tasks/:id':'Deleted Task',

    // Financials
    'GET /api/financials':                   'Viewed Financials',
    'POST /api/financials/expenses':          'Added Expense',
    'PUT /api/financials/expenses/:id':       'Updated Expense',
    'DELETE /api/financials/expenses/:id':    'Deleted Expense',
    'POST /api/financials/income':            'Added Income',
    'PUT /api/financials/income/:id':         'Updated Income',
    'DELETE /api/financials/income/:id':      'Deleted Income',
    'PUT /api/financials/budgets/artist/:id': 'Updated Artist Budget',
    'PUT /api/financials/budgets/release/:id':'Updated Release Budget',

    // Pending contracts
    'GET /api/pending-contracts':            'Viewed Pending Contracts',
    'POST /api/pending-contracts':           'Created Pending Contract',
    'PUT /api/pending-contracts/:id':        'Updated Pending Contract',
    'DELETE /api/pending-contracts/:id':     'Deleted Pending Contract',

    // Requests
    'POST /api/requests':                    'Submitted Request',
    'PUT /api/requests/:id':                 'Updated Request',

    // Dashboard
    'GET /api/dashboard':                    'Viewed Dashboard',

    // Bookkeeping
    'POST /api/bk/entries':                  'Added invoice to ledger',
    'POST /api/bk/entries/batch':            'Bulk uploaded invoices',
    'PUT /api/bk/entries/:id':               'Updated ledger entry',
    'DELETE /api/bk/entries/:id':            'Deleted ledger entry',
    'POST /api/bk/entries/:id/restore':      'Restored deleted entry',
    'POST /api/bk/entries/:id/approve':      'Approved invoice',
    'POST /api/bk/entries/:id/reject':       'Rejected invoice',
    'POST /api/bk/entries/:id/split':        'Split invoice between artists',
    'POST /api/bk/entries/:id/split-fee-reimb': 'Carved reimbursement off invoice',
    'DELETE /api/bk/entries/:id/splits':      'Removed invoice split',
    'POST /api/bk/entries/:id/file/invoice':  'Uploaded invoice document',
    'POST /api/bk/entries/:id/file/w9':       'Uploaded W9',
    'POST /api/bk/entries/:id/file/proof':    'Uploaded proof of payment',
    'POST /api/bk/entries/:id/file/receipt':  'Uploaded receipt',
    'DELETE /api/bk/entries/:id/file/invoice': 'Removed invoice document',
    'DELETE /api/bk/entries/:id/file/w9':      'Removed W9',
    'DELETE /api/bk/entries/:id/file/proof':   'Removed proof of payment',
    'DELETE /api/bk/entries/:id/file/receipt':  'Removed receipt',
    'POST /api/bk/bulk-approve':              'Bulk approved invoices',
    'PUT /api/bk/payments/:id':               'Updated payment status',
    'POST /api/bk/payments/:id/installments':  'Recorded payment installment',
    'DELETE /api/bk/installments/:id':        'Removed payment installment',
    'PUT /api/bk/recoupments/notes':          'Updated recoupment note',
    'POST /api/bk/payments/:id/send-confirmation': 'Sent payment confirmation',
    'POST /api/bk/parse':                     'AI-scanned invoice',
    'POST /api/bk/parse-proof':               'AI-scanned proof of payment',
    'PUT /api/bk/vendors/rename':             'Renamed vendor',
    'POST /api/bk/vendors/merge':             'Merged vendors',
    'POST /api/bk/vendors/aliases':           'Added vendor alias',
    'DELETE /api/bk/vendors/aliases/:id':     'Removed vendor alias',
    'POST /api/bk/vendors/scan-w9s':          'Ran W9 name scan',
    'GET /api/bk/export':                     'Exported ledger (Excel)',
    'GET /api/bk/export-csv':                 'Exported ledger (CSV)',
    'GET /api/bk/export-lookup':              'Exported expense lookup',
    'GET /api/bk/download-files':             'Downloaded expense files',
    // Reports — every one of these MOVES A REPORTED NUMBER, so they must not
    // land in the feed as a raw path. Six category merges did exactly that
    // (2026-08-19), reading as "POST /api/reports/rename-category" beside
    // "Signed In".
    'POST /api/reports/rename-category':      'Renamed or merged a report category',
    'POST /api/reports/recategorize':         'Recategorized from Reports',
    'POST /api/reports/set-artist':           'Attributed spend to an artist',
    'POST /api/reports/reassign-month':       'Moved a row to another report month',
    'POST /api/reports/classify':             'Changed a report section',
    'POST /api/reports/dismiss':              'Excluded an item from the report',
    'POST /api/reports/dismiss/restore':      'Restored an excluded item',
    'PUT /api/salary/employees/:id':          'Updated salary info',
    'PUT /api/salary/payments/:id':           'Updated salary payment',

    // DSP
    'PUT /api/dsp/:id':                      'Updated DSP Submission',
    'POST /api/dsp':                         'Created DSP Submission',

    // Search
    'GET /api/search':                       'Performed Search',
  };

  return MAP[key] || null; // null = don't log
}

// Which paths to always skip (too noisy)
const SKIP_PREFIXES = [
  '/api/auth/me',
  '/api/notifications',
  '/health',
  '/uploads',
  '/api/activity',
  '/api/auth/login-logs',
  // Bookkeeping writes log themselves via logBkAction (bookkeeping.js),
  // which writes to activity_log with richer context (entry id + payee +
  // field diff). Skipping /api/bk here prevents double-logging. Trade-off:
  // exports and AI scans (/bk/parse, /bk/export*) stop being logged too —
  // add explicit logBkAction calls there if that becomes important.
  '/api/bk',
];

// Skip GET requests to endpoints we don't have mapped (too noisy),
// but always log mutations
function shouldLog(method, path, label) {
  if (SKIP_PREFIXES.some(p => path.startsWith(p))) return false;
  // For GETs: only log if we have an explicit label for them
  if (method === 'GET' && !label) return false;
  // Always log mutations even if unmapped
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !label) return true;
  return !!label;
}

function activityLogger(req, res, next) {
  // req.user is populated by authMiddleware — skip if not authenticated
  res.on('finish', () => {
    try {
      if (!req.user) return;
      // Only log successful responses (2xx)
      if (res.statusCode < 200 || res.statusCode >= 300) return;

      const method = req.method;
      const rawPath = req.originalUrl || req.url;
      const label = getActionLabel(method, rawPath);

      if (!shouldLog(method, rawPath, label)) return;

      const action = label || `${method} ${rawPath.split('?')[0]}`;
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.socket?.remoteAddress
        || null;

      const endpoint = rawPath.split('?')[0];
      // Use pre-built diff from route handler if available, otherwise fall back to req.body
      let detail = req._activityDetail || null;

      pool.query(
        `INSERT INTO activity_log (user_id, action, detail, ip_address, method, endpoint, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          req.user.id,
          action,
          detail,
          ip,
          method,
          endpoint,
        ]
      ).catch(err => console.error('activityLogger insert failed:', err.message));
    } catch (e) {
      // Never let logging crash a request
      console.error('activityLogger error:', e.message);
    }
  });

  next();
}

module.exports = activityLogger;
