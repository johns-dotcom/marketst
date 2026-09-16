/**
 * /api/analytics — in-app usage analytics.
 *
 * Data sources:
 *   page_views       — one row per client route change (POST /pageview below)
 *   user_login_logs  — written by the login endpoints
 *   activity_log     — mutations, written by activityLogger
 *
 * The pageview ping is fire-and-forget from Layout.jsx: it must never
 * break normal navigation, so it always answers success. Summary reads
 * are Admin/Superadmin only.
 */
const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

const isAdmin = (u) => ['Admin', 'Superadmin'].includes(u?.role);

// POST /api/analytics/pageview — { path }
router.post('/pageview', async (req, res) => {
  try {
    let path = String(req.body?.path || '').trim();
    if (!path.startsWith('/') || path.length > 200) return res.json({ success: true });
    // Group dynamic segments so /releases/123 and /artists/9 roll up.
    path = path.replace(/\/\d+(?=\/|$)/g, '/:id');
    await pool.query('INSERT INTO page_views (user_id, path) VALUES ($1, $2)', [req.user.id, path]);
    res.json({ success: true });
  } catch {
    // Analytics must never fail the client.
    res.json({ success: true });
  }
});

// GET /api/analytics/summary?days=30 — Admin/Superadmin
router.get('/summary', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));

    const [topPages, topUsers, logins, daily, actions, totals] = await Promise.all([
      pool.query(
        `SELECT path, COUNT(*)::int AS views, COUNT(DISTINCT user_id)::int AS users
           FROM page_views
          WHERE ts > NOW() - make_interval(days => $1)
          GROUP BY path
          ORDER BY views DESC
          LIMIT 15`,
        [days]
      ),
      pool.query(
        `SELECT COALESCE(u.name, 'Deleted user') AS name,
                COUNT(*)::int AS views,
                COUNT(DISTINCT date_trunc('day', pv.ts))::int AS active_days,
                MAX(pv.ts) AS last_seen
           FROM page_views pv
           LEFT JOIN users u ON u.id = pv.user_id
          WHERE pv.ts > NOW() - make_interval(days => $1)
          GROUP BY u.name
          ORDER BY views DESC
          LIMIT 20`,
        [days]
      ),
      pool.query(
        `SELECT COALESCE(u.name, 'Deleted user') AS name,
                COUNT(*)::int AS logins,
                MAX(l.logged_in_at) AS last_login
           FROM user_login_logs l
           LEFT JOIN users u ON u.id = l.user_id
          WHERE l.logged_in_at > NOW() - make_interval(days => $1)
          GROUP BY u.name
          ORDER BY logins DESC
          LIMIT 20`,
        [days]
      ),
      pool.query(
        `SELECT to_char(date_trunc('day', ts), 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS views,
                COUNT(DISTINCT user_id)::int AS users
           FROM page_views
          WHERE ts > NOW() - make_interval(days => $1)
          GROUP BY 1
          ORDER BY 1`,
        [days]
      ),
      pool.query(
        `SELECT COALESCE(u.name, 'Deleted user') AS name, COUNT(*)::int AS actions
           FROM activity_log a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE a.created_at > NOW() - make_interval(days => $1)
          GROUP BY u.name
          ORDER BY actions DESC
          LIMIT 20`,
        [days]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS views, COUNT(DISTINCT user_id)::int AS users
           FROM page_views
          WHERE ts > NOW() - make_interval(days => $1)`,
        [days]
      ),
    ]);

    res.json({
      success: true,
      data: {
        days,
        totals: totals.rows[0] || { views: 0, users: 0 },
        topPages: topPages.rows,
        topUsers: topUsers.rows,
        logins: logins.rows,
        daily: daily.rows,
        actions: actions.rows,
      },
    });
  } catch (err) {
    console.error('GET /api/analytics/summary:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
