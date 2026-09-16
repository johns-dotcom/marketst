/**
 * testUserGuard
 *
 * Second layer of defense for the "test user" demo-account feature.
 * A test user (`users.is_test = true`) must never see or mutate real company
 * data. The frontend renders a mocked API response via an axios adapter, so
 * real requests don't normally leave the browser — but this middleware makes
 * sure that even if a direct URL or a bug slips through, the server rejects it.
 *
 * Policy: if the authenticated user has `is_test === true`, reject every
 * /api/* request that doesn't live in the allowlist below with 403.
 *
 * Allowlist: whatever is needed to stay logged in, manage the profile /
 * password, and read the small set of things the UI needs pre-mock (role,
 * name, theme). Everything else — ledger, approvals, payments, releases,
 * contracts, financials, salary, etc. — is blocked.
 *
 * Mount AFTER authMiddleware.
 */

const ALLOWLIST = [
  // Authentication
  /^\/api\/auth\/me$/,
  /^\/api\/auth\/login$/,       // login itself is already public — belt-and-braces
  /^\/api\/auth\/google$/,
  /^\/api\/auth\/logout$/,
  // Password self-service — lives under /api/auth, not /api/settings (the
  // old /api/settings/* entries pointed at endpoints that never existed;
  // theme + my-nav are localStorage-only client features with no API).
  /^\/api\/auth\/change-password$/,
  // Anything under /test-* namespaces a test user can touch — reserved for future
  /^\/api\/test\//,
];

function testUserGuard(req, res, next) {
  if (!req.user || req.user.is_test !== true) return next();
  const path = req.originalUrl.split('?')[0];
  if (ALLOWLIST.some(re => re.test(path))) return next();
  return res.status(403).json({
    success: false,
    error: 'Test-account — real data is not accessible. Demo mode renders mocked data in the UI.',
    test_mode: true,
  });
}

module.exports = testUserGuard;
