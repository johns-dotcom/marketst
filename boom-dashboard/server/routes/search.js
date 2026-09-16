const express = require('express');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { excludeCreatorRows } = require('../lib/ledger-source');

const router = express.Router();


// Does this user hold ANY bookkeeping page? Same answer requirePagePermission
// gives for the /api/bk/* router, derived from the same table and the same
// default-closed model, so the palette can never surface a vendor to somebody
// who would get a 403 clicking it.
//
// Admin/Superadmin pass on role. An Approver with NO rows falls back to the
// bookkeeping surface the role exists for; once rows are curated they are
// authoritative. A User with no rows gets nothing.
async function hasAnyBookkeepingPage(user) {
  if (!user) return false;
  if (user.role === 'Admin' || user.role === 'Superadmin') return true;
  try {
    const { rows } = await pool.query(
      'SELECT page FROM user_page_permissions WHERE user_id = $1', [user.id]
    );
    if (rows.length === 0) return user.role === 'Approver';
    return rows.some((r) => String(r.page || '').startsWith('/bk/'));
  } catch (err) {
    // Fail CLOSED. A database blip must not turn the vendor directory into a
    // public index.
    console.error('search: bookkeeping gate unavailable, denying:', err.message);
    return false;
  }
}

// GET /api/search?q=...
// Searches releases, artists, contracts, and deals in one shot
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.json({ success: true, data: { releases: [], artists: [], contracts: [], deals: [] } });
    }

    const term = `%${q.trim()}%`;
    // Contracts are admin-only across the app, so global search hides them
    // for regular users — they'd 403 anyway when clicking through.
    const userRole = (req.user?.role || '').toLowerCase();
    const canSeeContracts = userRole === 'admin' || userRole === 'superadmin' || userRole === 'approver';

    // Bookkeeping results are gated the same way /api/bk/* is. This ASKS the
    // same middleware rather than restating its rule: req.user carries no
    // `pages`, so the only honest way to know is the query requirePagePermission
    // itself runs. A second copy of an access rule is how one of them gets
    // fixed and the other doesn't — the reason the client's copy now lives in
    // one module too.
    const canSeeBookkeeping = await hasAnyBookkeepingPage(req.user);
    const none = { rows: [] };

    const [releases, artists, contracts, deals, vendors, entries] = await Promise.all([
      pool.query(
        `SELECT r.id, r.project_name, r.release_date, r.release_type, r.genre,
                r.upc, r.isrc, a.name as artist_name
         FROM releases r
         JOIN artists a ON r.artist_id = a.id
         WHERE (r.archived = false OR r.archived IS NULL)
           AND (
             LOWER(r.project_name) LIKE LOWER($1)
             OR LOWER(a.name)      LIKE LOWER($1)
             OR r.upc              LIKE $1
             OR r.isrc             LIKE $1
           )
         ORDER BY r.release_date DESC
         LIMIT 8`,
        [term]
      ),
      pool.query(
        `SELECT id, name, genre, total_releases
         FROM artists
         WHERE LOWER(name) LIKE LOWER($1)
         ORDER BY total_releases DESC
         LIMIT 6`,
        [term]
      ),
      canSeeContracts
        ? pool.query(
            `SELECT c.id, c.type, c.status, c.expiration_date, a.name as artist_name
             FROM contracts c
             JOIN artists a ON c.artist_id = a.id
             WHERE LOWER(a.name) LIKE LOWER($1) OR LOWER(c.type) LIKE LOWER($1)
             ORDER BY c.expiration_date ASC
             LIMIT 6`,
            [term]
          )
        : Promise.resolve({ rows: [] }),
      pool.query(
        `SELECT id, artist_name, genre, stage, ar_rep
         FROM deals
         WHERE LOWER(artist_name) LIKE LOWER($1)
         ORDER BY created_at DESC
         LIMIT 6`,
        [term]
      ),

      // ── Vendors ──
      // The vendor directory is DERIVED from expenses.payee, not a table (see
      // GET /bk/vendors), so this groups the same way and applies the same
      // deleted/voided/approved scoping. A vendor the directory won't show must
      // not be findable here either.
      //
      // Aliases are searched too: 'vendor_aliases' is how one payee's other
      // spellings are recorded, and someone typing the name on the invoice they
      // are holding is exactly the case the directory's alias table exists for.
      // The alias hit still resolves to the PRIMARY name — one vendor, one
      // result, never the alias masquerading as its own vendor.
      !canSeeBookkeeping ? none : pool.query(
        `SELECT e.payee,
                COUNT(*) FILTER (WHERE e.parent_id IS NULL)::int AS invoice_count,
                COALESCE(SUM(e.amount), 0) AS total_spent,
                MAX(e.invoice_date) AS last_invoice
           FROM expenses e
          WHERE (e.deleted = false OR e.deleted IS NULL)
            AND (e.voided = false OR e.voided IS NULL)
            AND e.payee IS NOT NULL AND e.payee <> ''
            AND e.status = 'approved'
            -- Creators are not vendors. ⌘K offering one under "Vendors" would
            -- send you to a vendor page built for W9s and payment terms, about
            -- somebody who has neither. They are findable on /bk/creators.
            AND ${excludeCreatorRows('e')}
            AND (LOWER(e.payee) LIKE LOWER($1)
                 OR EXISTS (SELECT 1 FROM vendor_aliases va
                             WHERE LOWER(va.primary_name) = LOWER(e.payee)
                               AND LOWER(va.alias) LIKE LOWER($1)))
          GROUP BY e.payee
          ORDER BY SUM(e.amount) DESC NULLS LAST
          LIMIT 6`,
        [term]
      ),

      // ── Ledger entries ──
      // Invoice number, payee and description, so a piece of paper on the desk
      // can be found by whatever is printed on it. LEAF ROWS ONLY — a split
      // parent's children carry the real attribution, and returning both would
      // offer the same money twice under two ids.
      !canSeeBookkeeping ? none : pool.query(
        `SELECT e.id, e.payee, e.invoice_number, e.amount, e.currency,
                e.invoice_date, e.payment_status, e.artist, e.category
           FROM expenses e
          WHERE (e.deleted = false OR e.deleted IS NULL)
            AND (e.voided = false OR e.voided IS NULL)
            AND NOT EXISTS (SELECT 1 FROM expenses c WHERE c.parent_id = e.id)
            AND (LOWER(e.invoice_number) LIKE LOWER($1)
                 OR LOWER(e.payee) LIKE LOWER($1)
                 OR LOWER(e.description) LIKE LOWER($1))
          ORDER BY e.invoice_date DESC NULLS LAST
          LIMIT 6`,
        [term]
      ),
    ]);

    res.json({
      success: true,
      data: {
        releases: releases.rows,
        artists: artists.rows,
        contracts: contracts.rows,
        deals: deals.rows,
        vendors: vendors.rows,
        entries: entries.rows,
      },
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
