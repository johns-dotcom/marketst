// Who can see which page. ONE definition, and a pure one.
//
// Extracted from AuthContext for the same reason statementLens.js was extracted
// from BkLedger: these are rules with real consequences that were only testable
// by logging in as somebody and clicking. App.jsx REDIRECTS on a false answer
// from canViewPath, so a mistake here doesn't degrade a page — it removes it.
//
// Everything below is a plain function of (path, role, pagePermissions). No
// React, no network, no module state, so a fixture can run every real account's
// permission rows against every real route in node.

// Paths every authenticated non-admin can reach regardless of their grants.
// Kept intentionally minimal: only the Dashboard is unconditional so a freshly
// created User with no permissions still lands on a real page instead of an
// empty sidebar. Everything else must be explicitly granted in Settings.
//
// '/settings' is self-service for everyone: the page renders role-aware tabs
// (non-admins only get My Nav + Theme) and every admin API behind it is
// independently adminOnly-gated server-side. Requiring an admin grant just to
// change your own theme was the old behaviour — a trap.
//
// '/messages' is unconditional for the same reason: a message board that has to
// be granted per-person is not a message board. Membership in a channel is what
// bounds you there, enforced server-side in routes/chat.js. Mirrored in
// server/middleware/pagePermission.js — adding it to one file only is how a
// page renders in the nav and then 403s on every request.
export const BASE_WHITELIST = new Set(['/', '/settings', '/messages'])

// The bookkeeping surface the Approver role exists for. Applies ONLY when no
// permission rows are configured; once an admin has curated rows for an
// Approver, the rows are authoritative.
export const approverFallback = (path) =>
  path === '/' || path.startsWith('/bk/') || path.startsWith('/recoupments') || path === '/artist-campaigns'

/**
 * The ancestor paths of a location, longest first, never including the root.
 *
 *   '/bk/vendors/ACME'        → ['/bk/vendors', '/bk']
 *   '/financials/month/26-01' → ['/financials/month', '/financials']
 *   '/artists'                → []
 *
 * Splitting on SEGMENTS is the whole point. The obvious implementation —
 * `granted.some(g => path.startsWith(g))` — is wrong at a path boundary: a
 * grant on '/bk/rules' would admit '/bk/rules-admin', and '/artists' would
 * admit '/artist-budgets'. Building the ancestor list makes a partial segment
 * impossible to express rather than merely unlikely.
 *
 * The root is deliberately excluded. '/' is in BASE_WHITELIST, so returning it
 * would make every path in the app an allowed descendant of the Dashboard and
 * switch the permission system off entirely.
 */
export function ancestorsOf(path) {
  const parts = String(path || '').split('/').filter(Boolean)
  const out = []
  for (let n = parts.length - 1; n >= 1; n--) out.push('/' + parts.slice(0, n).join('/'))
  return out
}

/**
 * Does this EXACT path resolve for these grants?
 *
 * Separate from canViewPath so the ancestor walk reuses every carve-out below
 * instead of re-listing them. A second copy of these rules is how one of them
 * gets fixed and the other doesn't.
 *
 * @param {string} path
 * @param {{role: string, pagePermissions: string[]|null}} ctx
 *        pagePermissions === null means NO rows are configured, which is not
 *        the same as an empty array.
 */
export function allowsExactly(path, { role, pagePermissions }) {
  if (BASE_WHITELIST.has(path)) return true
  if (pagePermissions === null) {
    return role === 'Approver' ? approverFallback(path) : false
  }
  if (pagePermissions.includes(path)) return true

  // ── Carve-outs: pages that were SPLIT or RENAMED after grants were stored ──
  // Permissions live in the database as whole path strings, so moving a page
  // silently revokes it for everyone holding the old path. Each of these exists
  // because that happened or was about to.

  // Recoupment Planning was carved out of the Recoupments page — an existing
  // /recoupments grant keeps covering it so nobody loses access; admins can
  // also grant Planning on its own.
  if (path === '/recoupments/planning' && pagePermissions.includes('/recoupments')) return true

  // The Flags page moved from /duplicates to /flags when it became the global
  // hub. Without this, every non-admin who had the Flags page silently lost it
  // on deploy.
  if (path === '/flags' && pagePermissions.includes('/duplicates')) return true

  // Bank Matching was carved out of Statements — the review deck, the
  // transaction table and batch review moved to their own page. Without this
  // every non-admin who could review statements would silently lose the ability
  // to match anything, while still seeing the (now review-less) Statements page.
  if (path === '/bk/bank-matching' && pagePermissions.includes('/bk/statements')) return true

  // The Bank Ledger is the other HALF of the ledger, not a new capability:
  // 2,326 of its 3,692 rows were created by booking a bank debit and moved
  // there so the invoice controls stop being inert on 62% of the page. Anyone
  // who could read those rows yesterday must still read them today. Without
  // this the split would quietly take $3,640,421 of spend away from every
  // non-admin who has the ledger.
  if (path === '/bk/bank-ledger' && pagePermissions.includes('/bk/ledger')) return true

  return false
}

/**
 * Can this user see this page?
 *
 * Superadmin is always unrestricted — the one role that can never be locked out
 * of the app that administers it.
 *
 * Approver used to bypass too, which silently ignored the curated rows admins
 * set for them and gave every Approver the full nav (found 2026-07 while
 * view-as'ing an Approver). Approvers now follow their rows like Users do,
 * falling back to the bookkeeping set when no rows exist so a rowless Approver
 * can still do their core job. For every other role the model is DEFAULT-CLOSED.
 *
 * ── A grant on a page covers that page's DETAIL routes ──
 * This used to be an exact string match, which made all 11 parameterized routes
 * unreachable for everyone who doesn't bypass: /artists/:id,
 * /bk/vendors/:vendorName, /releases/:id, /recoupments/:artistName,
 * /artist-campaigns/:artistName, /artist-budgets/:artistKey, /budget/:id,
 * /financials/month/:month, /team/:id, /create-nda/:template. Measured
 * 2026-08-24: Nick and Kareem each held 18 granted pages and could not open a
 * single artist, vendor, release or team member — every click bounced them to
 * the Dashboard, which is why '/' had more distinct users than any other page.
 *
 * A detail page is not a separate capability from its index. Nobody grants "the
 * vendor directory" meaning "but not any vendor in it".
 *
 * @param {string} path
 * @param {{role: string, pagePermissions: string[]|null}} ctx
 */
export function canViewPath(path, ctx) {
  if (!ctx?.role) return false

  // Superadmin is unconditional. One role must always be able to reach the page
  // that administers the roles, or a mistake in Settings is unrecoverable from
  // inside the app.
  if (ctx.role === 'Superadmin') return true

  // ── Admin: grandfathered while unconfigured, bound once configured ──
  // Admin used to bypass outright, which meant the curated rows an admin had
  // been given were decorative: Felipe held 41 and Dylan 13, and both saw all
  // 50 regardless. Settings offered a choice it then ignored — the same bug
  // Approver had in 2026-07.
  //
  // Rather than seed every admin with all fifty paths (a second copy of the nav
  // living server-side, drifting the first time a page is added), the rule reads
  // the absence of rows as the absence of a decision. No rows: unrestricted,
  // exactly as before, so nothing changes for an admin nobody has configured.
  // Rows present: somebody chose, and the choice is honoured.
  if (ctx.role === 'Admin' && ctx.pagePermissions === null) return true

  if (allowsExactly(path, ctx)) return true

  // ── A REGISTERED page never inherits from its ancestor ──
  // Only unregistered descendants — the detail routes — do.
  //
  // '/import/master-sheet' (Master Sheet Import, adminOnly) lives under
  // '/import' (QB Import). They are different features that happen to share a
  // prefix, so without this test a QB Import grant would silently confer an
  // admin-only importer. Nobody's current rows hit that combination, which is
  // exactly why it would have shipped.
  //
  // `knownPages` is the set of paths the nav registers — the same list Settings
  // offers as checkboxes. If a path is on it, somebody chose whether to grant
  // it, and that choice is the answer. An empty/absent set degrades to plain
  // ancestor inheritance, which is the old behaviour rather than a new hole.
  if (ctx.knownPages?.has?.(path)) return false

  for (const parent of ancestorsOf(path)) {
    if (allowsExactly(parent, ctx)) return true
  }
  return false
}
