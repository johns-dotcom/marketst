const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { sendWelcomeEmail } = require('../services/email');
const { prepareEmail: prepareEmailPayload } = require('../services/emailDispatch');
const { clearForeignKeyRefs } = require('../lib/fkSweep');
const { postEvent } = require('../lib/activityBot');
const { createInvite } = require('../lib/invites');

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

// GET /api/settings/users — list users
// Ordered by role tier (Superadmin → Admin → Approver → User → anything else),
// then by hierarchy_level, then by name. Makes the Settings and Permissions
// lists easier to scan when you're looking for a specific tier.
router.get('/users', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, department, hierarchy_level, boom_rep, created_at
       FROM users
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

    // No password yet: the person sets it through a one-time invite link (or
    // signs in with Google, which needs no password). Login refuses a
    // password-less account with a sentence that says so.
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, department, hierarchy_level, boom_rep, created_at)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, NOW())
       RETURNING id, name, email, role, department, hierarchy_level, boom_rep, created_at`,
      [name, email, role || 'User', department || 'Operations', hierarchy_level || 99, repValue]
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

    let invite = null;
    try { invite = await createInvite(newUser.id, req.user.id); } catch (e) { console.error('invite create failed:', e.message); }
    res.status(201).json({ success: true, data: newUser, pending_email, invite });
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

// ── My settings (2026-09-19) ────────────────────────────────────────────────
// The signed-in person's own profile, sign-ins and notification preferences.
const NOTIFY_KEYS = ['approvals_waiting', 'payments_due', 'tasks_assigned', 'renewals_coming', 'weekly_digest'];

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { rows: [u] } = await pool.query(
      'SELECT id, name, email, role, department, title, phone, notification_prefs, tours_done, created_at FROM users WHERE id = $1', [req.user.id]);
    if (!u) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, data: u });
  } catch (err) { console.error('settings/me error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

router.put('/me', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const str = (v) => (v === undefined ? undefined : (v === null ? null : (String(v).trim() || null)));
    const name = str(b.name);
    if (name === null) return res.status(400).json({ success: false, error: 'Name cannot be empty' });
    const { rows: [u] } = await pool.query(
      `UPDATE users SET
         name  = COALESCE($2, name),
         title = CASE WHEN $3::boolean THEN $4 ELSE title END,
         phone = CASE WHEN $5::boolean THEN $6 ELSE phone END
       WHERE id = $1 RETURNING id, name, email, role, department, title, phone, notification_prefs`,
      [req.user.id, name ?? null, b.title !== undefined, str(b.title) ?? null, b.phone !== undefined, str(b.phone) ?? null]);
    res.json({ success: true, data: u });
  } catch (err) { console.error('settings/me update error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

// Recent sign-ins, from the log the login endpoints already write.
router.get('/me/sessions', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, logged_in_at, ip_address, user_agent FROM user_login_logs WHERE user_id = $1 ORDER BY logged_in_at DESC LIMIT 12`, [req.user.id]);
    res.json({ success: true, data: rows });
  } catch (err) { console.error('settings/me/sessions error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

// Notification preferences: stored now, SENT once Gmail is connected. The
// client says so on the tab; this route only keeps the answers.
router.get('/me/notifications', authMiddleware, async (req, res) => {
  try {
    const { rows: [u] } = await pool.query('SELECT notification_prefs FROM users WHERE id = $1', [req.user.id]);
    const prefs = u?.notification_prefs || {};
    const { isConnected } = require('../lib/mail');
    res.json({ success: true, data: Object.fromEntries(NOTIFY_KEYS.map((k) => [k, prefs[k] === true])), keys: NOTIFY_KEYS, delivery: { gmail: await isConnected('team') } });
  } catch (err) { console.error('settings/me/notifications error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});
router.put('/me/notifications', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const prefs = Object.fromEntries(NOTIFY_KEYS.map((k) => [k, b[k] === true]));
    await pool.query('UPDATE users SET notification_prefs = $2::jsonb WHERE id = $1', [req.user.id, JSON.stringify(prefs)]);
    res.json({ success: true, data: prefs });
  } catch (err) { console.error('settings/me/notifications update error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

// Tours: which click-through tours this person finished, and at which version.
router.put('/me/tours', authMiddleware, async (req, res) => {
  try {
    // One tour, or a batch (the welcome walk completes the page tours it ran).
    const list = Array.isArray(req.body?.tours) ? req.body.tours : [req.body || {}];
    const clean = list.map((t) => ({ id: String(t?.id || '').trim(), version: String(t?.version || '').trim(), skipped: t?.skipped === true }));
    if (!clean.length || clean.length > 50 || clean.some((t) => !/^[a-z0-9-]{2,40}$/.test(t.id) || !t.version)) return res.status(400).json({ success: false, error: 'id and version required' });
    const patch = Object.fromEntries(clean.map((t) => [t.id, { version: t.version, at: new Date().toISOString(), skipped: t.skipped }]));
    const { rows: [u] } = await pool.query(
      `UPDATE users SET tours_done = COALESCE(tours_done, '{}'::jsonb) || $2::jsonb WHERE id = $1 RETURNING tours_done`, [req.user.id, JSON.stringify(patch)]);
    res.json({ success: true, data: u?.tours_done || {} });
  } catch (err) { console.error('tours update error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});
router.delete('/me/tours', authMiddleware, async (req, res) => {
  try { const { rows: [u] } = await pool.query(`UPDATE users SET tours_done = '{}'::jsonb WHERE id = $1 RETURNING tours_done`, [req.user.id]); res.json({ success: true, data: u?.tours_done || {} }); }
  catch (err) { console.error('tours reset error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

// ── People (2026-09-19) ─────────────────────────────────────────────────────
// The one list behind /team for admins: every account with its page rows,
// last sign-in and open-task count. Presets are a CLIENT vocabulary
// (lib/navPresets.js), so the rows are returned raw and the client names
// which presets they add up to.
router.get('/people', adminOnly, async (req, res) => {
  try {
    const { rows: users } = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.department, u.hierarchy_level, u.boom_rep, u.title, u.phone, u.created_at,
              (u.password_hash IS NULL) AS invite_pending,
              (SELECT MAX(l.logged_in_at) FROM user_login_logs l WHERE l.user_id = u.id) AS last_sign_in,
              (SELECT COUNT(*)::int FROM tasks t WHERE t.user_id = u.id AND t.status <> 'Done') AS open_tasks
         FROM users u
        ORDER BY CASE u.role WHEN 'Superadmin' THEN 1 WHEN 'Admin' THEN 2 WHEN 'Approver' THEN 3 WHEN 'User' THEN 4 ELSE 5 END, u.hierarchy_level, u.name`);
    const { rows: perms } = await pool.query('SELECT user_id, page FROM user_page_permissions ORDER BY page');
    const byUser = {};
    for (const r of perms) (byUser[r.user_id] = byUser[r.user_id] || []).push(r.page);
    res.json({ success: true, data: users.map((u) => ({ ...u, pages: byUser[u.id] || null })) });
  } catch (err) { console.error('settings/people error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

// Sign a person out everywhere: bump token_version so every JWT they hold is stale.
router.post('/users/:id(\\d+)/logout-all', adminOnly, async (req, res) => {
  try {
    const { rows: [t] } = await pool.query('SELECT id, role FROM users WHERE id = $1', [req.params.id]);
    if (!t) return res.status(404).json({ success: false, error: 'User not found' });
    if (!isSuperadmin(req.user.role) && isAdminOrSuperadmin(t.role)) return res.status(403).json({ success: false, error: 'Only Superadmin can sign out an Admin' });
    await pool.query('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1', [t.id]);
    res.json({ success: true });
  } catch (err) { console.error('settings logout-all error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

// POST /api/settings/users/:id/invite — a fresh one-time link (voids the old one)
router.post('/users/:id(\\d+)/invite', adminOnly, async (req, res) => {
  try {
    const { rows: [t] } = await pool.query('SELECT id, role, email, name FROM users WHERE id = $1', [req.params.id]);
    if (!t) return res.status(404).json({ success: false, error: 'User not found' });
    if (!isSuperadmin(req.user.role) && isAdminOrSuperadmin(t.role)) return res.status(403).json({ success: false, error: 'Only Superadmin can invite an Admin' });
    const invite = await createInvite(t.id, req.user.id);
    let emailed = false;
    if (req.query.send === '1' || req.body?.send === true) {
      const { sendMail, runWithMailContext } = require('../lib/mail');
      const url = `${process.env.FRONTEND_URL || 'https://marketst-production.up.railway.app'}${invite.path}`;
      await runWithMailContext({ actor: { id: req.user.id, email: req.user.email, name: req.user.name } }, () => sendMail({
        kind: 'invite', purpose: 'team', to: t.email, subject: 'Your Market Street dashboard login',
        html: `<p>Hi ${t.name.split(' ')[0]},</p><p>${req.user.name || 'An admin'} added you to the Market Street dashboard. Set your password and sign in here:</p><p><a href="${url}">${url}</a></p><p style="color:#666;font-size:12px;">The link works once and expires in 7 days.</p>`,
        entity: { type: 'user', id: t.id } }));
      emailed = true;
    }
    res.json({ success: true, data: { ...invite, emailed } });
  } catch (err) { console.error('settings invite error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

// GET /api/settings/integrations — what is configured, read from the
// environment; status only, never a key. `powers` says what breaks without it.
router.get('/integrations', adminOnly, async (req, res) => {
  try {
    const has = (...keys) => keys.every((k) => !!process.env[k]);
    const lastAudit = async (like) => (await pool.query(`SELECT MAX(created_at) AS t FROM bk_audit_log WHERE action ILIKE $1`, [like]).catch(() => ({ rows: [{ t: null }] }))).rows[0]?.t || null;
    const rows = [
      await (async () => {
        // Mail is connected mailboxes now, not env vars. Configured = at least one active box.
        const { rows } = await pool.query(`SELECT address, last_used_at FROM mailboxes WHERE status = 'active' ORDER BY connected_at`).catch(() => ({ rows: [] }));
        return { key: 'gmail', label: 'Mail (Google)', configured: rows.length > 0, powers: 'payment confirmations, welcome and invite emails, notifications', detail: rows.length ? `${rows.length} mailbox${rows.length === 1 ? '' : 'es'}: ${rows.map((r) => r.address).join(', ')}` : (has('GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET') ? 'OAuth client ready — connect a mailbox in the Mail card above' : 'needs GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET on Railway'), last_used: rows.map((r) => r.last_used_at).filter(Boolean).sort().pop() || null };
      })(),
      { key: 'google_signin', label: 'Google sign-in', configured: has('GOOGLE_CLIENT_ID'), powers: 'one-click login for the team (the client also needs VITE_GOOGLE_CLIENT_ID at build time)', detail: null, last_used: null },
      { key: 'spotify', label: 'Spotify', configured: has('SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET'), powers: 'cover art and artist lookup on releases', detail: null, last_used: null },
      { key: 'storage', label: 'File storage (R2)', configured: has('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'), powers: 'invoices, W-9s, proofs, contracts and documents', detail: process.env.R2_BUCKET_NAME ? `bucket ${process.env.R2_BUCKET_NAME}` : null, last_used: null },
      { key: 'ai', label: 'AI (Anthropic)', configured: has('ANTHROPIC_API_KEY'), powers: 'invoice reading, W-9 checks, statement parsing fallback, contract scans', detail: null, last_used: await lastAudit('ai%') },
      { key: 'encryption', label: 'Encryption key', configured: has('PAYMENT_DETAILS_KEY'), powers: 'storing vendor and label bank details, EINs and TINs', detail: null, last_used: null },
    ];
    res.json({ success: true, data: rows });
  } catch (err) { console.error('settings integrations error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

module.exports = router;
