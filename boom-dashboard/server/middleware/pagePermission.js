// Page-permission-aware authorization middleware.
//
// Replaces the hardcoded role-only gates on /api/contracts, /api/salary, etc.
// so that an admin who grants a non-admin User explicit page_permissions
// access to one of those routes is actually honored end-to-end (the prior
// gates always returned 403 for non-admins regardless of permissions).
//
// Allows the request if:
//   • The user has role Admin / Superadmin / Approver, OR
//   • The user has explicit page_permissions rows AND at least one row
//     matches one of the supplied page paths, OR
//   • The user has NO page_permissions rows configured AND one of the
//     supplied pages is on the BASE_WHITELIST (Dashboard).
//
// Default-CLOSED model (2026-07): a User with no page_permissions rows
// sees ONLY the base-whitelist paths. Everything else is a 403 until
// an admin grants access via the permissions matrix in Settings.
// Mirrors the client-side canView so a User can't work around the
// sidebar by hitting the API directly.
//
// Use:
//   router.use(authMiddleware, requirePagePermission('/contracts', '/renewals'))

const pool = require('../db');

// Superadmin bypasses unconditionally. Admin is handled below: unrestricted
// while it has NO permission rows, bound by them once it has some — mirroring
// canViewPath in client/src/lib/pageAccess.js. If the client restricts a page
// and this file does not, the page is merely hidden and the API behind it stays
// open, which is not a permission system.
const ADMIN_ROLES = new Set(['Superadmin']);

// Mirror of the client's BASE_WHITELIST. Everything else defaults to
// closed for a User with no configured permissions.
//
// '/messages' is here for the same reason '/' is: a message board an admin has
// to grant per-person is not a message board. What bounds a user inside it is
// channel MEMBERSHIP, enforced in routes/chat.js — not a page grant. It still
// appears in navConfig.jsx, so a user may HIDE it from their own nav; they may
// not be denied it.
//
// NOTE: the client copy (client/src/lib/pageAccess.js) also carries '/settings'
// and this one does not. That predates this change and is left alone here, but
// it is exactly the drift both files warn about — worth reconciling separately.
const BASE_WHITELIST = new Set(['/', '/messages']);

// Approver fallback — mirrors the client's approverFallback in
// AuthContext. Applies ONLY when the Approver has no permission rows
// configured; curated rows are authoritative. Approver used to sit in
// ADMIN_ROLES and bypass every gate, which ignored those rows entirely.
const approverFallback = (p) =>
  p === '/' || p.startsWith('/bk/') || p.startsWith('/recoupments') || p === '/artist-campaigns';

function requirePagePermission(...pages) {
  const targetPages = pages.filter(Boolean);
  return async (req, res, next) => {
    const user = req.user;
    if (!user) return res.status(401).json({ success: false, error: 'Auth required' });
    if (ADMIN_ROLES.has(user.role)) return next();
    // Base whitelist paths pass regardless of DB state — every user
    // needs somewhere to land.
    if (targetPages.some(p => BASE_WHITELIST.has(p))) return next();
    try {
      const { rows } = await pool.query(
        'SELECT page FROM user_page_permissions WHERE user_id = $1',
        [user.id]
      );
      // No rows = default CLOSED for Users; an unconfigured Approver
      // still gets the bookkeeping surface their role exists for; an
      // unconfigured Admin is grandfathered, since no rows means nobody has
      // made a decision about them yet.
      if (rows.length === 0) {
        if (user.role === 'Admin') return next();
        if (user.role === 'Approver' && targetPages.some(approverFallback)) return next();
        return res.status(403).json({ success: false, error: 'Access required' });
      }
      // Explicit permissions: allow when any target page is granted.
      const granted = new Set(rows.map(r => r.page));
      if (targetPages.some(p => granted.has(p))) return next();
      return res.status(403).json({ success: false, error: 'Access required' });
    } catch (err) {
      console.error('requirePagePermission:', err);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

/**
 * Which of `pages` this user can reach — the middleware's rules, as a set,
 * for a handler that assembles several sections and must show each one only
 * to somebody who could open the page behind it (GET /dashboard/loop).
 *
 * One permission read for the whole list, never one per page. Same rules as
 * requirePagePermission above — Superadmin everything, base whitelist,
 * unconfigured Admin everything, unconfigured Approver the bookkeeping set,
 * otherwise the rows — so the two cannot disagree about a page.
 */
async function pagesReachable(user, pages) {
  const out = new Set();
  if (!user) return out;
  if (ADMIN_ROLES.has(user.role)) return new Set(pages);
  const { rows } = await pool.query(
    'SELECT page FROM user_page_permissions WHERE user_id = $1',
    [user.id]
  );
  const granted = new Set(rows.map(r => r.page));
  for (const p of pages) {
    if (BASE_WHITELIST.has(p)) { out.add(p); continue; }
    if (rows.length === 0) {
      if (user.role === 'Admin') { out.add(p); continue; }
      if (user.role === 'Approver' && approverFallback(p)) { out.add(p); continue; }
      continue;
    }
    if (granted.has(p)) out.add(p);
  }
  return out;
}

module.exports = { requirePagePermission, pagesReachable };
