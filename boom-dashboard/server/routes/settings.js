const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { sendWelcomeEmail, sendTestUserInvitationEmail } = require('../services/email');
const { prepareEmail: prepareEmailPayload } = require('../services/emailDispatch');
const { clearForeignKeyRefs } = require('../lib/fkSweep');
const { postEvent } = require('../lib/activityBot');

const router = express.Router();

// Role helpers
const isAdminOrSuperadmin = (role) => role === 'Admin' || role === 'Superadmin';
const isSuperadmin = (role) => role === 'Superadmin';

// All settings routes require Admin or Superadmin
const adminOnly = [authMiddleware, (req, res, next) => {
  if (!isAdminOrSuperadmin(req.user.role)) {
    return res.status(403).json({ success: false, error: 'Admin only' });
  }
  next();
}];

// ─── Users ───────────────────────────────────────────────────────────────────

// GET /api/settings/users — list real users (test users live under /test-users)
// Ordered by role tier (Superadmin → Admin → Approver → User → anything else),
// then by hierarchy_level, then by name. Makes the Settings and Permissions
// lists easier to scan when you're looking for a specific tier.
router.get('/users', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, department, hierarchy_level, boom_rep, created_at
       FROM users
       WHERE is_test IS NOT TRUE
       ORDER BY
         CASE role
           WHEN 'Superadmin' THEN 1
           WHEN 'Admin'      THEN 2
           WHEN 'Approver'   THEN 3
           WHEN 'User'       THEN 4
           ELSE 5
         END,
         hierarchy_level,
         name`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Settings list users error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/settings/users — create a new user
router.post('/users', adminOnly, async (req, res) => {
  try {
    const { name, email, role, department, hierarchy_level, boom_rep } = req.body;
    if (!name || !email) {
      return res.status(400).json({ success: false, error: 'Name and email are required' });
    }

    // Only Superadmin can create Admin or Superadmin accounts
    if (!isSuperadmin(req.user.role) && isAdminOrSuperadmin(role)) {
      return res.status(403).json({ success: false, error: 'Only Superadmin can create Admin accounts' });
    }

    // boom_rep is optional. Empty string → NULL so the DB doesn't carry
    // a meaningless '' that would never match any expense's rep field.
    const repValue = boom_rep && String(boom_rep).trim() ? String(boom_rep).trim() : null;

    // Users authenticate via Google SSO — generate a random unusable password hash
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, department, hierarchy_level, boom_rep, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING id, name, email, role, department, hierarchy_level, boom_rep, created_at`,
      [name, email, passwordHash, role || 'User', department || 'Operations', hierarchy_level || 99, repValue]
    );

    const newUser = result.rows[0];

    // "New teammate joined". BUILD_MESSAGE_BOARD.md §6 points this event at
    // routes/team.js — but that file is tasks, and users are created here and
    // in routes/auth.js's register. This is the admin path that actually adds
    // somebody to the company.
    postEvent({
      text: `*${newUser.name}* joined the team as *${newUser.role}*`
        + (newUser.department ? ` in ${newUser.department}` : ''),
      icon: 'user-plus',
      link: `/team/${newUser.id}`,
    }).catch(e => console.error('[activityBot] event dropped:', e.message));

    // Seed the starting page set, if the caller sent one.
    //
    // The model is default-CLOSED, so a new User with no rows sees exactly the
    // Dashboard and Settings — two links, an app that looks broken. Two live
    // accounts are in that state right now because nobody ran the permissions
    // matrix after creating them.
    //
    // The page list comes FROM THE CLIENT deliberately. The presets live in
    // Settings.jsx next to the checkboxes they mirror, and the nav vocabulary
    // lives in navConfig.jsx; a server-side copy of either would be a second
    // definition that drifts the first time a page is added. The client is the
    // one that knows, so it says.
    //
    // Best-effort: a failure here must not lose the account that was just
    // created — the admin can still open the matrix and set them by hand.
    if (Array.isArray(req.body?.pages) && req.body.pages.length) {
      try {
        const clean = [...new Set(req.body.pages
          .map((p) => String(p || '').trim())
          .filter((p) => p.startsWith('/') && p.length <= 120))];
        for (const page of clean) {
          await pool.query(
            'INSERT INTO user_page_permissions (user_id, page) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [newUser.id, page]
          );
        }
        newUser.pages_granted = clean.length;
      } catch (err) {
        console.error('preset page grant failed for new user', newUser.id, err.message);
        newUser.pages_granted = 0;
      }
    }

    // Welcome email is now opt-in via preview modal. Build the preview
    // payload; the client opens EmailPreviewModal and triggers the send.
    let pending_email = null;
    try {
      const preview = await prepareEmailPayload('welcome', {
        name, email, role: newUser.role, department: newUser.department,
      });
      pending_email = {
        kind: 'welcome',
        context: { name, email, role: newUser.role, department: newUser.department },
        ...preview,
      };
    } catch (err) {
      console.warn('welcome preview prepare failed:', err.message);
    }

    res.status(201).json({ success: true, data: newUser, pending_email });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ success: false, error: 'Email already exists' });
    }
    console.error('Settings create user error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/settings/users/:id — update a user
router.put('/users/:id', adminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { name, email, role, department, hierarchy_level, password, boom_rep } = req.body;
    // boom_rep semantics on PUT:
    //   undefined  → don't touch the column (caller didn't send the field).
    //   '' or null → clear the assignment.
    //   'John' etc → set it.
    const repProvided = Object.prototype.hasOwnProperty.call(req.body, 'boom_rep');
    const repValue = repProvided && boom_rep && String(boom_rep).trim()
      ? String(boom_rep).trim()
      : null;

    // Read the target's current role once for cross-role checks below.
    const targetRow = await pool.query('SELECT role FROM users WHERE id=$1', [userId]);
    const targetRole = targetRow.rows[0]?.role;

    // Only Superadmin can edit Admin or Superadmin accounts
    if (!isSuperadmin(req.user.role)) {
      if (isAdminOrSuperadmin(targetRole)) {
        return res.status(403).json({ success: false, error: 'Only Superadmin can edit Admin accounts' });
      }
      // Also prevent an Admin from assigning Admin or Superadmin role
      if (isAdminOrSuperadmin(role)) {
        return res.status(403).json({ success: false, error: 'Only Superadmin can assign Admin or Superadmin roles' });
      }
    }

    // Last-Superadmin guard: block demoting the only remaining Superadmin so
    // the system can never end up with zero Superadmins.
    if (targetRole === 'Superadmin' && role && role !== 'Superadmin') {
      const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role='Superadmin'");
      if ((rows[0]?.n || 0) <= 1) {
        return res.status(400).json({ success: false, error: 'Cannot demote the last Superadmin. Promote another user first.' });
      }
    }

    if (!name || !email) {
      return res.status(400).json({ success: false, error: 'Name and email are required' });
    }

    // boom_rep SET clause is appended only when the caller sent the
    // field. Otherwise legacy callers omitting it would wipe the
    // existing rep on every edit. The repClause/idIdx inside each
    // branch handle the parameter-index bookkeeping.
    if (password) {
      const passwordHash = await bcrypt.hash(password, 10);
      const params = repProvided
        ? [name, email, role || 'User', department || 'Operations', hierarchy_level || 99, passwordHash, repValue, userId]
        : [name, email, role || 'User', department || 'Operations', hierarchy_level || 99, passwordHash, userId];
      const repClause = repProvided ? ', boom_rep=$7' : '';
      const idIdx = repProvided ? 8 : 7;
      await pool.query(
        `UPDATE users SET name=$1, email=$2, role=$3, department=$4, hierarchy_level=$5, password_hash=$6${repClause} WHERE id=$${idIdx}`,
        params
      );
    } else {
      const params = repProvided
        ? [name, email, role || 'User', department || 'Operations', hierarchy_level || 99, repValue, userId]
        : [name, email, role || 'User', department || 'Operations', hierarchy_level || 99, userId];
      const repClause = repProvided ? ', boom_rep=$6' : '';
      const idIdx = repProvided ? 7 : 6;
      await pool.query(
        `UPDATE users SET name=$1, email=$2, role=$3, department=$4, hierarchy_level=$5${repClause} WHERE id=$${idIdx}`,
        params
      );
    }

    const result = await pool.query(
      'SELECT id, name, email, role, department, hierarchy_level, boom_rep, created_at FROM users WHERE id=$1',
      [userId]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ success: false, error: 'Email already exists' });
    }
    console.error('Settings update user error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/settings/users/:id — delete a user (cannot delete self)
router.delete('/users/:id', adminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (userId === req.user.id) {
      return res.status(400).json({ success: false, error: 'Cannot delete your own account' });
    }

    // Pull the target's role once so we can apply both the cross-role gate
    // and the last-Superadmin guard without two round-trips.
    const target = await pool.query('SELECT role FROM users WHERE id=$1', [userId]);
    const targetRole = target.rows[0]?.role;

    // Only Superadmin can delete Admin or Superadmin accounts
    if (!isSuperadmin(req.user.role) && isAdminOrSuperadmin(targetRole)) {
      return res.status(403).json({ success: false, error: 'Only Superadmin can delete Admin accounts' });
    }

    // Last-Superadmin guard: never let the count drop to zero — even another
    // Superadmin can't take out the final one without first creating another.
    if (targetRole === 'Superadmin') {
      const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role='Superadmin'");
      if ((rows[0]?.n || 0) <= 1) {
        return res.status(400).json({ success: false, error: 'Cannot remove the last Superadmin. Promote another user first.' });
      }
    }

    // Clear foreign key references before deleting. Intentional-semantics
    // cleanups first (a departed user's tasks/notifications go away rather
    // than lingering owner-less), then a dynamic sweep of every remaining
    // non-cascading FK to users (lib/fkSweep) — new tables with user_id
    // columns can't re-break this delete. Atomic: any failure rolls back.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // (No `notifications` table exists — the bell is computed; mention
      // rows in user_mentions cascade via their own FK.)
      await client.query('DELETE FROM tasks WHERE user_id=$1', [userId]);
      await client.query('UPDATE activity_log SET user_id=NULL WHERE user_id=$1', [userId]);
      await clearForeignKeyRefs('users', userId, { db: client });
      await client.query('DELETE FROM users WHERE id=$1', [userId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Settings delete user error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Permission Templates ─────────────────────────────────────────────────────
// Admin-built named page-sets, applied from the Permissions editor the same
// way as the hardcoded starter presets. Upsert by case-insensitive name so
// re-saving a template under the same name updates it.

// GET /api/settings/permission-templates
router.get('/permission-templates', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, pages, created_by, updated_at FROM permission_templates ORDER BY LOWER(name)'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Settings get permission-templates error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/settings/permission-templates — { name, pages }
router.post('/permission-templates', adminOnly, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const pages = req.body?.pages;
    if (!name || name.length > 60) {
      return res.status(400).json({ success: false, error: 'Template name required (max 60 chars)' });
    }
    if (!Array.isArray(pages) || pages.length === 0 || !pages.every(p => typeof p === 'string' && p.startsWith('/') && p.length <= 100)) {
      return res.status(400).json({ success: false, error: 'pages must be a non-empty array of page paths' });
    }
    const { rows: existing } = await pool.query(
      'SELECT id FROM permission_templates WHERE LOWER(name) = LOWER($1)', [name]
    );
    let row;
    if (existing.length) {
      const r = await pool.query(
        `UPDATE permission_templates SET pages = $1, name = $2, created_by = $3, updated_at = NOW()
          WHERE id = $4 RETURNING id, name, pages, created_by, updated_at`,
        [JSON.stringify(pages), name, req.user.name, existing[0].id]
      );
      row = r.rows[0];
    } else {
      const r = await pool.query(
        `INSERT INTO permission_templates (name, pages, created_by)
         VALUES ($1, $2, $3) RETURNING id, name, pages, created_by, updated_at`,
        [name, JSON.stringify(pages), req.user.name]
      );
      row = r.rows[0];
    }
    res.json({ success: true, data: row, updated: existing.length > 0 });
  } catch (err) {
    console.error('Settings save permission-template error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/settings/permission-templates/:id
router.delete('/permission-templates/:id', adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM permission_templates WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Settings delete permission-template error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── Page Permissions ─────────────────────────────────────────────────────────

// GET /api/settings/permissions/:userId — get allowed pages for a user
// Returns array of page paths, or null if unrestricted (no rows)
router.get('/permissions/:userId', adminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const result = await pool.query(
      'SELECT page FROM user_page_permissions WHERE user_id=$1 ORDER BY page',
      [userId]
    );
    // null = no restrictions configured, array = explicit whitelist
    const pages = result.rows.length > 0 ? result.rows.map(r => r.page) : null;
    res.json({ success: true, data: pages });
  } catch (err) {
    console.error('Settings get permissions error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/settings/permissions/:userId — set allowed pages for a user
// pages: string[] — the pages to allow. Empty array = delete all rows (unrestricted).
router.put('/permissions/:userId', adminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const { pages } = req.body; // array of page paths

    // Only Superadmin can set permissions for Admin or Superadmin accounts
    if (!isSuperadmin(req.user.role)) {
      const target = await pool.query('SELECT role FROM users WHERE id=$1', [userId]);
      if (target.rows.length > 0 && isAdminOrSuperadmin(target.rows[0].role)) {
        return res.status(403).json({ success: false, error: 'Only Superadmin can set permissions for Admin accounts' });
      }
    }

    await pool.query('DELETE FROM user_page_permissions WHERE user_id=$1', [userId]);

    if (pages && pages.length > 0) {
      for (const page of pages) {
        await pool.query(
          'INSERT INTO user_page_permissions (user_id, page) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [userId, page]
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Settings set permissions error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── User rep visibility (allow-list) ──────────────────────────────────────
// Admins use this to scope which boom_rep submissions a non-admin user can
// see on the Approvals + Payments pages. Allow-list model:
//   • Admin / Superadmin → ignores this table entirely; sees every rep.
//   • Approver           → sees only reps in their list. Empty = nothing.
//   • User               → defaults to seeing only their own rep
//                          (user.name = boom_rep, case-insensitive);
//                          this list grants visibility to additional reps.

// GET /api/settings/visible-reps
// Returns { [user_id]: [reps] } — the whole map. Admin/Superadmin only.
router.get('/visible-reps', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT user_id, visible_rep FROM user_visible_reps ORDER BY user_id, visible_rep`
    );
    const map = {};
    for (const r of rows) {
      if (!map[r.user_id]) map[r.user_id] = [];
      map[r.user_id].push(r.visible_rep);
    }
    res.json({ success: true, data: map });
  } catch (err) {
    console.error('GET /api/settings/visible-reps:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/settings/visible-reps  body: { user_id, visible_rep }
// Adds one allow. Idempotent — ON CONFLICT DO NOTHING. Admin/Superadmin only.
router.post('/visible-reps', adminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.body?.user_id, 10);
    const rep = String(req.body?.visible_rep || '').trim();
    if (!userId || !rep) {
      return res.status(400).json({ success: false, error: 'user_id and visible_rep are required' });
    }
    await pool.query(
      `INSERT INTO user_visible_reps (user_id, visible_rep, created_by)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [userId, rep, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/settings/visible-reps:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/settings/visible-reps  body: { user_id, visible_rep }
// Removes one allow. Admin/Superadmin only.
router.delete('/visible-reps', adminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.body?.user_id, 10);
    const rep = String(req.body?.visible_rep || '').trim();
    if (!userId || !rep) {
      return res.status(400).json({ success: false, error: 'user_id and visible_rep are required' });
    }
    await pool.query(
      `DELETE FROM user_visible_reps WHERE user_id = $1 AND visible_rep = $2`,
      [userId, rep]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/settings/visible-reps:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── Market Street Reps CRUD ─────────────────────────────────────────────────────────
// Admin/Superadmin manage the canonical Market Street Reps list. The public
// /api/reps endpoint reads from the same table (active rows only) and
// is what every "Market Street Rep" dropdown across the app consumes.
//
// Soft deactivate, no hard delete: existing expenses + user assignments
// still reference the rep by name string, so removing the row would
// orphan historical data. Toggling active = false hides the rep from
// new dropdowns while keeping the audit trail intact.

// GET /api/settings/reps — full list with active flag + audit
router.get('/reps', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.name, r.active, r.created_at,
             (SELECT u.name FROM users u WHERE u.id = r.created_by) AS created_by_name
        FROM boom_reps r
       ORDER BY r.active DESC, r.name ASC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /api/settings/reps:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/settings/reps — body: { name }. Idempotent: re-adding a
// previously-deactivated rep flips active back to TRUE instead of erroring.
router.post('/reps', adminOnly, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    if (name.length > 64) return res.status(400).json({ success: false, error: 'name too long (max 64)' });
    await pool.query(`
      INSERT INTO boom_reps (name, active, created_by)
      VALUES ($1, TRUE, $2)
      ON CONFLICT (name) DO UPDATE SET active = TRUE
    `, [name, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/settings/reps:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PATCH /api/settings/reps/:name — body: { active }. Toggle visibility.
router.patch('/reps/:name', adminOnly, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    if (typeof req.body?.active !== 'boolean') {
      return res.status(400).json({ success: false, error: 'active (boolean) required' });
    }
    const { rowCount } = await pool.query(
      `UPDATE boom_reps SET active = $1 WHERE name = $2`,
      [req.body.active, name]
    );
    if (rowCount === 0) return res.status(404).json({ success: false, error: 'rep not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/settings/reps/:name:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── Test Users (Superadmin only) ────────────────────────────────────────────
// Test users are demo accounts that see mocked data only — they never read or
// write real company data. The testUserGuard middleware blocks all /api/*
// routes for them except a tiny allowlist; the frontend renders mocked data
// for every screen.

const superadminOnly = [authMiddleware, (req, res, next) => {
  if (!isSuperadmin(req.user.role)) {
    return res.status(403).json({ success: false, error: 'Superadmin only' });
  }
  next();
}];

// GET /api/settings/test-users
router.get('/test-users', superadminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, department, created_at
       FROM users
       WHERE is_test = true
       ORDER BY created_at DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Settings list test users error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/settings/test-users — create a test user with email + password
router.post('/test-users', superadminOnly, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, error: 'Name, email, and password are required' });
    }
    // Test users can be "Admin" or "User" — that's the experience they simulate
    const simulatedRole = (role === 'Admin' || role === 'Superadmin') ? 'Admin' : 'User';

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, department, hierarchy_level, is_test, created_at)
       VALUES ($1, $2, $3, $4, 'Demo', 999, true, NOW())
       RETURNING id, name, email, role, department, created_at`,
      [name, email, passwordHash, simulatedRole]
    );

    // Build preview payload. Client opens EmailPreviewModal so the
    // superadmin can review the plaintext password being sent.
    let pending_email = null;
    try {
      const preview = await prepareEmailPayload('test_invitation', {
        name, email, password, role: simulatedRole,
      });
      pending_email = {
        kind: 'test_invitation',
        context: { name, email, password, role: simulatedRole },
        ...preview,
      };
    } catch (err) {
      console.warn('test_invitation preview prepare failed:', err.message);
    }

    res.status(201).json({ success: true, data: result.rows[0], pending_email });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ success: false, error: 'A user with that email already exists' });
    }
    console.error('Settings create test user error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/settings/test-users/:id — update name, role, or reset password
router.put('/test-users/:id', superadminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, role, password } = req.body;

    // Guardrails: refuse to touch non-test rows from this endpoint
    const { rows: existing } = await pool.query('SELECT is_test FROM users WHERE id=$1', [id]);
    if (!existing.length) return res.status(404).json({ success: false, error: 'Not found' });
    if (!existing[0].is_test) return res.status(400).json({ success: false, error: 'Not a test user' });

    const updates = [];
    const params = [];
    if (name)  { params.push(name);  updates.push(`name = $${params.length}`); }
    if (role)  {
      const simulatedRole = (role === 'Admin' || role === 'Superadmin') ? 'Admin' : 'User';
      params.push(simulatedRole); updates.push(`role = $${params.length}`);
    }
    if (password) {
      const passwordHash = await bcrypt.hash(password, 10);
      params.push(passwordHash); updates.push(`password_hash = $${params.length}`);
      // Bump token_version to invalidate any existing sessions
      updates.push('token_version = COALESCE(token_version, 0) + 1');
    }
    if (!updates.length) return res.json({ success: true });

    params.push(id);
    await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length} AND is_test = true`,
      params
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Settings update test user error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/settings/test-users/:id
router.delete('/test-users/:id', superadminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query('SELECT is_test FROM users WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    if (!rows[0].is_test) return res.status(400).json({ success: false, error: 'Not a test user' });

    // Login is allowlisted by the test-user guard, so activity_log can still
    // accumulate rows. Clear FK references before deleting the user.
    await pool.query('DELETE FROM user_page_permissions WHERE user_id = $1', [id]);
    await pool.query('UPDATE activity_log SET user_id = NULL WHERE user_id = $1', [id]);
    await pool.query('DELETE FROM users WHERE id = $1 AND is_test = true', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Settings delete test user error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
