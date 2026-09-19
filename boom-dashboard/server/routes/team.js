const express = require('express');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// ── Gmail API helpers ───────────────────────────────────────────────────────
// The token exchange was copied byte-for-byte in four files (here, requests.js,
// services/email.js, and again for the Sheets export). One definition now.
const { sendMail } = require('../lib/mail');

async function notifyTaskAssignment({ assigneeName, assigneeEmail, assignerName, description, priority, due_date }) {
  try {
    const due = due_date ? new Date(due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#111;">
        <div style="background:#334155;padding:20px 28px;border-radius:12px 12px 0 0;">
          <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:2px;color:rgba(255,255,255,0.7);text-transform:uppercase;">Market Street</p>
          <h1 style="margin:6px 0 0;font-size:20px;font-weight:700;color:#fff;">New Task Assigned</h1>
        </div>
        <div style="background:#f9f9f9;padding:28px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;">
          <p style="margin:0 0 20px;font-size:14px;color:#444;">Hi ${assigneeName}, <strong>${assignerName}</strong> assigned you a task:</p>
          <div style="background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
            <p style="margin:0;font-size:16px;font-weight:600;color:#111;">${description}</p>
          </div>
          <table style="width:100%;border-collapse:collapse;">
            <tr>
              <td style="padding:6px 0;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;width:100px;">Priority</td>
              <td style="padding:6px 0;font-size:14px;color:#111;">${priority || 'Medium'}</td>
            </tr>
            ${due ? `<tr>
              <td style="padding:6px 0;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Due</td>
              <td style="padding:6px 0;font-size:14px;color:#111;">${due}</td>
            </tr>` : ''}
            <tr>
              <td style="padding:6px 0;font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Assigned by</td>
              <td style="padding:6px 0;font-size:14px;color:#111;">${assignerName}</td>
            </tr>
          </table>
          <p style="margin:20px 0 0;font-size:12px;color:#aaa;">Log in to the Market Street Dashboard to view and manage your tasks.</p>
        </div>
      </div>`;
    await sendMail({
      kind: 'task_assigned',
      to: assigneeEmail,
      subject: `[Market Street Dashboard] New task from ${assignerName}: ${description.slice(0, 60)}${description.length > 60 ? '…' : ''}`,
      html,
    });
  } catch (err) {
    console.error('Task assignment email error:', err.message);
    // Non-blocking — don't fail the request if email fails
  }
}

// GET /api/team
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, role, department, hierarchy_level, created_at FROM users ORDER BY hierarchy_level ASC, name ASC'
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get team error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

const CHECKLIST_KEYS = [
  'yt_video','content','marketing_plan','official_thread',
  'uploaded','recoup_added','budget',
  'stem_pitch','s4a_pitch','amazon_pitch','pandora','marquee','dsp_email',
  'musixmatch'
];
const CHECKLIST_TOTAL = CHECKLIST_KEYS.length;

// GET /api/team/velocity — release velocity per team member (admin only)
router.get('/velocity', authMiddleware, async (req, res) => {
  if (req.user.role !== 'Admin' && req.user.role !== 'Superadmin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }

  try {
    const membersResult = await pool.query(
      `SELECT id, name, department, hierarchy_level FROM users ORDER BY hierarchy_level ASC, name ASC`
    );

    // All releases with assigned_to, grouped by completion status and time periods
    const releasesResult = await pool.query(`
      SELECT r.id, r.project_name, r.release_date, r.release_type, r.assigned_to, r.created_at, r.updated_at,
             r.archived, a.name as artist_name,
             ${CHECKLIST_KEYS.map(k => `COALESCE(r.${k}, false) as ${k}`).join(', ')}
      FROM releases r
      JOIN artists a ON r.artist_id = a.id
      WHERE r.assigned_to IS NOT NULL
      ORDER BY r.release_date DESC
    `);

    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 86400000);
    const ninetyDaysAgo = new Date(now - 90 * 86400000);

    const velocity = membersResult.rows.map(member => {
      const memberReleases = releasesResult.rows.filter(r => r.assigned_to === member.id);

      const withCompletion = memberReleases.map(r => {
        const done = CHECKLIST_KEYS.filter(k => r[k]).length;
        const completion = Math.round((done / CHECKLIST_TOTAL) * 100);
        const releaseDate = r.release_date ? new Date(r.release_date) : null;
        const isPast = releaseDate && releaseDate < now;
        return { ...r, completion, isPast, releaseDate };
      });

      const total = withCompletion.length;
      const completed = withCompletion.filter(r => r.completion === 100).length;
      const released = withCompletion.filter(r => r.isPast).length;
      const upcoming = withCompletion.filter(r => !r.isPast).length;
      const avgCompletion = total > 0
        ? Math.round(withCompletion.reduce((s, r) => s + r.completion, 0) / total)
        : 0;

      // Releases completed in last 30 / 90 days
      const last30 = withCompletion.filter(r => r.isPast && r.releaseDate >= thirtyDaysAgo).length;
      const last90 = withCompletion.filter(r => r.isPast && r.releaseDate >= ninetyDaysAgo).length;

      // On-time rate: releases that hit 100% checklist before or on release date
      const releasedWithChecklist = withCompletion.filter(r => r.isPast);
      const fullyPrepped = releasedWithChecklist.filter(r => r.completion === 100).length;
      const onTimeRate = releasedWithChecklist.length > 0
        ? Math.round((fullyPrepped / releasedWithChecklist.length) * 100)
        : null;

      // Monthly breakdown (last 12 months)
      const monthly = [];
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
        const label = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        const count = withCompletion.filter(r =>
          r.releaseDate && r.releaseDate >= d && r.releaseDate <= monthEnd
        ).length;
        monthly.push({ label, count });
      }

      return {
        id: member.id,
        name: member.name,
        department: member.department,
        total,
        completed,
        released,
        upcoming,
        avgCompletion,
        last30,
        last90,
        onTimeRate,
        monthly,
        recentReleases: withCompletion
          .filter(r => r.isPast)
          .slice(0, 5)
          .map(r => ({ id: r.id, project_name: r.project_name, artist_name: r.artist_name, release_date: r.release_date, completion: r.completion, release_type: r.release_type })),
      };
    });

    // Sort by total releases desc
    velocity.sort((a, b) => b.total - a.total);

    // Team totals
    const teamTotals = {
      totalReleases: releasesResult.rows.length,
      last30: velocity.reduce((s, v) => s + v.last30, 0),
      last90: velocity.reduce((s, v) => s + v.last90, 0),
      avgCompletion: velocity.length > 0
        ? Math.round(velocity.reduce((s, v) => s + v.avgCompletion, 0) / velocity.filter(v => v.total > 0).length || 0)
        : 0,
    };

    res.json({ success: true, data: { velocity, totals: teamTotals } });
  } catch (error) {
    console.error('Velocity error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/team/workload
// All members with their assigned releases (for the workload board)
router.get('/workload', authMiddleware, async (req, res) => {
  try {
    const membersResult = await pool.query(
      `SELECT id, name, email, role, department, hierarchy_level
       FROM users ORDER BY hierarchy_level ASC, name ASC`
    );
    const members = membersResult.rows;

    const releasesResult = await pool.query(`
      SELECT r.id, r.project_name, r.release_date, r.release_type, r.priority,
             r.assigned_to,
             a.name as artist_name,
             ${CHECKLIST_KEYS.map(k => `COALESCE(r.${k}, false) as ${k}`).join(', ')}
      FROM releases r
      JOIN artists a ON r.artist_id = a.id
      WHERE (r.archived = false OR r.archived IS NULL)
        AND r.assigned_to IS NOT NULL
      ORDER BY r.release_date ASC
    `);

    const releasesByMember = {};
    releasesResult.rows.forEach(r => {
      const done = CHECKLIST_KEYS.filter(k => r[k]).length;
      const completion = Math.round((done / CHECKLIST_TOTAL) * 100);
      if (!releasesByMember[r.assigned_to]) releasesByMember[r.assigned_to] = [];
      releasesByMember[r.assigned_to].push({ ...r, completion });
    });

    const result = members.map(m => ({
      ...m,
      releases: releasesByMember[m.id] || [],
    }));

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Workload error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/team/my-work
// The logged-in user's assigned releases, tasks, and upcoming deadlines
router.get('/my-work', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const [releasesResult, tasksResult, activityResult] = await Promise.all([
      pool.query(`
        SELECT r.id, r.project_name, r.release_date, r.release_type, r.priority,
               a.name as artist_name,
               ${CHECKLIST_KEYS.map(k => `COALESCE(r.${k}, false) as ${k}`).join(', ')}
        FROM releases r
        JOIN artists a ON r.artist_id = a.id
        WHERE r.assigned_to = $1
          AND (r.archived = false OR r.archived IS NULL)
        ORDER BY r.release_date ASC
      `, [userId]),
      pool.query(`
        SELECT t.*, u.name as assigned_by_name
        FROM tasks t
        LEFT JOIN users u ON t.assigned_by = u.id
        WHERE t.user_id = $1
        ORDER BY
          CASE t.status WHEN 'Done' THEN 1 ELSE 0 END ASC,
          -- A task somebody DRAGGED leads; everything untouched keeps its
          -- due-date order. NULLS LAST is what makes those two coexist.
          t.sort_order ASC NULLS LAST,
          t.due_date ASC NULLS LAST,
          t.priority ASC
      `, [userId]),
      pool.query(`
        SELECT al.*, u.name as user_name
        FROM activity_log al
        LEFT JOIN users u ON al.user_id = u.id
        WHERE al.user_id = $1
        ORDER BY al.created_at DESC
        LIMIT 20
      `, [userId]),
    ]);

    const releases = releasesResult.rows.map(r => {
      const done = CHECKLIST_KEYS.filter(k => r[k]).length;
      return { ...r, completion: Math.round((done / CHECKLIST_TOTAL) * 100) };
    });

    const upcoming = releases.filter(r => {
      const d = Math.ceil((new Date(r.release_date) - new Date()) / 86400000);
      return d >= 0 && d <= 30;
    });

    // Enrich tasks with linked release info (safe — column may not exist yet)
    let tasks = tasksResult.rows;
    try {
      const taskIds = tasks.filter(t => t.release_id).map(t => t.release_id);
      if (taskIds.length > 0) {
        const { rows: rels } = await pool.query(
          `SELECT r.id, r.project_name, a.name as artist_name FROM releases r JOIN artists a ON r.artist_id = a.id WHERE r.id = ANY($1)`,
          [taskIds]
        );
        const relMap = {};
        rels.forEach(r => { relMap[r.id] = r });
        tasks = tasks.map(t => t.release_id && relMap[t.release_id]
          ? { ...t, release_name: relMap[t.release_id].project_name, release_artist_name: relMap[t.release_id].artist_name }
          : t
        );
      }
    } catch {}

    res.json({
      success: true,
      data: {
        releases,
        upcoming,
        tasks,
        activity: activityResult.rows,
      }
    });
  } catch (error) {
    console.error('My work error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/team/:id (member detail — must come AFTER named routes above)
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const memberResult = await pool.query(
      `SELECT id, name, email, role, department, hierarchy_level FROM users WHERE id = $1`,
      [id]
    );
    if (memberResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Member not found' });
    const member = memberResult.rows[0];

    // Task visibility: admins/superadmins see everything. The logged-in user
    // sees their own tasks in full (including self-added personal ones).
    // Everyone else only sees tasks a different user delegated to this
    // member — self-added or unknown-assigner rows stay private.
    const isPrivileged = req.user.role === 'Admin' || req.user.role === 'Superadmin';
    const isSelfView = String(req.user.id) === String(id);
    const taskVisibilityFilter = (isPrivileged || isSelfView)
      ? ''
      : ' AND t.assigned_by IS NOT NULL AND t.assigned_by != t.user_id';

    const [releasesResult, tasksResult, activityResult] = await Promise.all([
      pool.query(`
        SELECT r.id, r.project_name, r.release_date, r.release_type, r.priority,
               a.name as artist_name,
               ${CHECKLIST_KEYS.map(k => `COALESCE(r.${k}, false) as ${k}`).join(', ')}
        FROM releases r
        JOIN artists a ON r.artist_id = a.id
        WHERE r.assigned_to = $1
          AND (r.archived = false OR r.archived IS NULL)
        ORDER BY r.release_date ASC
      `, [id]),
      pool.query(`
        SELECT t.*, u.name as assigned_by_name
        FROM tasks t
        LEFT JOIN users u ON t.assigned_by = u.id
        WHERE t.user_id = $1${taskVisibilityFilter}
        ORDER BY t.due_date ASC NULLS LAST, t.priority ASC
      `, [id]),
      pool.query(`
        SELECT al.*, u.name as user_name
        FROM activity_log al
        LEFT JOIN users u ON al.user_id = u.id
        WHERE al.user_id = $1
        ORDER BY al.created_at DESC
        LIMIT 30
      `, [id]),
    ]);

    const releases = releasesResult.rows.map(r => {
      const done = CHECKLIST_KEYS.filter(k => r[k]).length;
      return { ...r, completion: Math.round((done / CHECKLIST_TOTAL) * 100) };
    });

    res.json({
      success: true,
      data: { ...member, releases, tasks: tasksResult.rows, activity: activityResult.rows }
    });
  } catch (error) {
    console.error('Member detail error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/team/:id/tasks
router.get('/:id/tasks', authMiddleware, async (req, res) => {
  try {
    // Same visibility rule as /team/:id — admins/superadmins or self-view
    // see every task; everyone else only sees tasks assigned by a different
    // user (delegated work), not the member's self-added personal notes.
    const isPrivileged = req.user.role === 'Admin' || req.user.role === 'Superadmin';
    const isSelfView = String(req.user.id) === String(req.params.id);
    const filter = (isPrivileged || isSelfView)
      ? ''
      : ' AND t.assigned_by IS NOT NULL AND t.assigned_by != t.user_id';

    const result = await pool.query(
      `SELECT t.*, u.name as assigned_by_name
       FROM tasks t
       LEFT JOIN users u ON t.assigned_by = u.id
       WHERE t.user_id = $1${filter}
       ORDER BY t.due_date ASC, t.priority ASC`,
      [req.params.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get user tasks error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/team/tasks
// Hierarchy rules:
//   - You can ASSIGN to anyone at the same level or below (higher level number)
//   - You can REQUEST from anyone above you (lower level number)
router.post('/tasks', authMiddleware, async (req, res) => {
  try {
    const { user_id, description, priority, status, due_date, category, release_id } = req.body;

    // Default to the logged-in user if no user_id provided
    const effectiveUserId = user_id || req.user.id;

    if (!effectiveUserId || !description) {
      return res.status(400).json({ success: false, error: 'Description required' });
    }

    // Get current user's hierarchy level + name/email
    const currentUserResult = await pool.query(
      'SELECT id, name, email, hierarchy_level FROM users WHERE id = $1',
      [req.user.id]
    );
    const currentUser = currentUserResult.rows[0];
    if (!currentUser) return res.status(403).json({ success: false, error: 'User not found' });

    // Get target user's hierarchy level + name/email
    const targetUserResult = await pool.query(
      'SELECT id, name, email, hierarchy_level FROM users WHERE id = $1',
      [effectiveUserId]
    );
    const targetUser = targetUserResult.rows[0];
    if (!targetUser) return res.status(404).json({ success: false, error: 'Target user not found' });

    // Determine task type: request if target is above (lower level number), else assignment
    const task_type = targetUser.hierarchy_level < currentUser.hierarchy_level ? 'request' : 'assignment';

    const result = await pool.query(
      `INSERT INTO tasks (user_id, assigned_by, task_type, description, category, priority, status, due_date, release_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       RETURNING *`,
      [effectiveUserId, req.user.id, task_type, description, category || null, priority || 'Medium', status || 'To Do', due_date || null, release_id || null]
    );

    const taskResult = await pool.query(
      `SELECT t.*, u.name as assigned_by_name
       FROM tasks t
       LEFT JOIN users u ON t.assigned_by = u.id
       WHERE t.id = $1`,
      [result.rows[0].id]
    );

    // Build preview payload for the task assignment notification — only when
    // assigning to someone else (self-assigns don't email yourself).
    let pending_email = null;
    if (String(effectiveUserId) !== String(req.user.id) && targetUser.email) {
      try {
        const { prepareEmail } = require('../services/emailDispatch');
        const ctx = {
          assigneeName: targetUser.name,
          assigneeEmail: targetUser.email,
          assignerName: currentUser.name,
          description,
          priority: priority || 'Medium',
          due_date: due_date || null,
        };
        // If the assignee asked to be emailed about tasks and the Team mailbox is
        // connected, it goes now — no preview to click through.
        const { rows: [prefRow] } = await pool.query('SELECT notification_prefs FROM users WHERE id = $1', [effectiveUserId]).catch(() => ({ rows: [{}] }));
        const sentNow = await require('../lib/notifier').notifyAssigned({ assignee: { email: targetUser.email, notification_prefs: prefRow?.notification_prefs }, assigner: currentUser.name, description, priority, due_date }).catch(() => false);
        if (sentNow) pending_email = null;
        else {
          const preview = await prepareEmail('task_assigned', ctx);
          pending_email = { kind: 'task_assigned', context: ctx, ...preview };
        }
      } catch (err) {
        console.warn('task_assigned preview failed:', err.message);
      }
    }

    res.status(201).json({ success: true, data: taskResult.rows[0], pending_email });
  } catch (error) {
    console.error('Create task error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/team/tasks/:id
// PUT /api/team/tasks/:id/assign  { user_id }
//
// Hand a task to someone else. `PUT /tasks/:id` cannot do it — it takes no
// user_id — and the hierarchy rule and the notification preview lived only in
// POST /tasks, which is why the @mention flow died with the add-task form: there
// was no way to assign a task that already existed.
//
// Same two rules as creation, deliberately, so a task assigned on the way in and
// one handed over afterwards behave identically:
//   • task_type is 'request' when the target sits ABOVE the caller in the
//     hierarchy, 'assignment' otherwise. You do not assign work to your boss.
//   • the email is PREPARED, never sent here — the client previews it and the
//     person decides. Self-assignment emails nobody.
//
// Declared before /tasks/:id for the same reason reorder is: Express matches in
// order, and "/tasks/12/assign" would otherwise be an update to task "12" with a
// trailing path Express ignores.
router.put('/tasks/:id(\\d+)/assign', authMiddleware, async (req, res) => {
  try {
    const taskId = Number(req.params.id);
    const targetId = Number(req.body?.user_id);
    if (!Number.isFinite(targetId)) {
      return res.status(400).json({ success: false, error: 'user_id required' });
    }

    const { rows: [task] } = await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
    if (!task) return res.status(404).json({ success: false, error: 'Task not found' });
    // Only the owner or the person who assigned it may hand it on. Without this
    // any signed-in user could move anyone's task to anyone.
    if (String(task.user_id) !== String(req.user.id) && String(task.assigned_by) !== String(req.user.id)) {
      return res.status(403).json({ success: false, error: 'That is not your task to reassign' });
    }

    const { rows: [me] } = await pool.query(
      'SELECT id, name, email, hierarchy_level FROM users WHERE id = $1', [req.user.id]);
    const { rows: [target] } = await pool.query(
      'SELECT id, name, email, hierarchy_level FROM users WHERE id = $1', [targetId]);
    if (!target) return res.status(404).json({ success: false, error: 'Target user not found' });

    const task_type = target.hierarchy_level < me.hierarchy_level ? 'request' : 'assignment';
    const { rows: [updated] } = await pool.query(
      `UPDATE tasks SET user_id = $1, assigned_by = $2, task_type = $3, updated_at = NOW()
        WHERE id = $4 RETURNING *`, [targetId, req.user.id, task_type, taskId]);

    let pending_email = null;
    if (String(targetId) !== String(req.user.id) && target.email) {
      try {
        const { prepareEmail } = require('../services/emailDispatch');
        const ctx = {
          assigneeName: target.name,
          assigneeEmail: target.email,
          assignerName: me.name,
          description: updated.description,
          priority: updated.priority || 'Medium',
          due_date: updated.due_date || null,
        };
        const preview = await prepareEmail('task_assigned', ctx);
        pending_email = { kind: 'task_assigned', context: ctx, ...preview };
      } catch (err) {
        // A failed preview must not fail the assignment — the task HAS moved.
        console.warn('task_assigned preview failed:', err.message);
      }
    }
    res.json({ success: true, data: updated, pending_email, task_type });
  } catch (err) {
    console.error('PUT /api/team/tasks/:id/assign:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/team/tasks/reorder  { ids: [taskId, …] }
//
// The order a person arranged, persisted. Was localStorage under `task_order`,
// which is to say it existed on one browser and nowhere else.
//
// MUST be declared BEFORE `/tasks/:id` — Express matches in order, so registered
// after it this would arrive as an update to a task whose id is the string
// "reorder".
//
// Scoped to the caller's OWN tasks: the id list comes from a client and is not
// evidence of ownership. Ids that are not theirs are ignored rather than refused,
// so a stale list (a task reassigned in another tab) still saves the rest.
router.put('/tasks/reorder', authMiddleware, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : null;
    if (!ids || !ids.length) {
      return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
    }
    if (ids.length > 500) {
      return res.status(400).json({ success: false, error: 'too many ids' });
    }
    // One statement: position comes from the array index, so the whole list is
    // written atomically and cannot end up half-ordered.
    const { rowCount } = await pool.query(
      `UPDATE tasks AS t
          SET sort_order = v.ord
         FROM (SELECT * FROM UNNEST($1::int[]) WITH ORDINALITY AS x(id, ord)) AS v
        WHERE t.id = v.id AND t.user_id = $2`,
      [ids, req.user.id]
    );
    res.json({ success: true, data: { reordered: rowCount, requested: ids.length } });
  } catch (err) {
    console.error('PUT /api/team/tasks/reorder:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/tasks/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { description, priority, status, due_date, category, notes, release_id, progress } = req.body;

    // release_id uses an explicit-presence check so partial updates (e.g. just
    // { progress }) don't silently unlink a task from its release. Pass
    // release_id: null in the body to actively clear it.
    const releaseIdProvided = Object.prototype.hasOwnProperty.call(req.body, 'release_id');
    const result = await pool.query(
      `UPDATE tasks
       SET description = COALESCE($1, description),
           priority = COALESCE($2, priority),
           status = COALESCE($3, status),
           due_date = COALESCE($4, due_date),
           category = COALESCE($5, category),
           notes = COALESCE($6, notes),
           release_id = CASE WHEN $7::boolean THEN $8 ELSE release_id END,
           progress = COALESCE($10, progress),
           updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [description, priority, status, due_date, category, notes, releaseIdProvided, release_id || null, id, progress !== undefined ? progress : null]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    const taskResult = await pool.query(
      `SELECT t.*, u.name as assigned_by_name
       FROM tasks t
       LEFT JOIN users u ON t.assigned_by = u.id
       WHERE t.id = $1`,
      [result.rows[0].id]
    );

    res.json({ success: true, data: taskResult.rows[0] });
  } catch (error) {
    console.error('Update task error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/team/tasks/:id
// You can delete a task if:
//   - You created it (assigned_by = you), OR
//   - The task belongs to someone at your level or below (hierarchy_level >= yours)
router.delete('/tasks/:id', authMiddleware, async (req, res) => {
  try {
    // Get the task + task owner's hierarchy level
    const taskResult = await pool.query(
      `SELECT t.*, u.hierarchy_level as owner_level
       FROM tasks t
       JOIN users u ON t.user_id = u.id
       WHERE t.id = $1`,
      [req.params.id]
    );

    if (taskResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    const task = taskResult.rows[0];

    // Get current user's hierarchy level
    const currentUserResult = await pool.query(
      'SELECT hierarchy_level FROM users WHERE id = $1',
      [req.user.id]
    );
    const currentUser = currentUserResult.rows[0];

    const isCreator = task.assigned_by === req.user.id;
    const canDeleteByHierarchy = task.owner_level >= currentUser.hierarchy_level;

    if (!isCreator && !canDeleteByHierarchy) {
      return res.status(403).json({ success: false, error: 'Not authorized to delete this task' });
    }

    await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    res.json({ success: true, data: { id: parseInt(req.params.id) } });
  } catch (error) {
    console.error('Delete task error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
