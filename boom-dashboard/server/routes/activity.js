const express = require('express');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// GET /api/activity — admin only, returns paginated activity log
router.get('/', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'Admin' && req.user.role !== 'Superadmin') {
      return res.status(403).json({ success: false, error: 'Admin only' });
    }

    const {
      user_id,
      category,
      from,
      to,
      search,
      methods,    // comma-separated: "GET,POST,DELETE"
      department, // single department name
      sort = 'desc', // 'asc' | 'desc'
      page = 1,
      limit = 100,
    } = req.query;

    const conditions = [];
    const params = [];

    if (user_id && user_id !== 'all') {
      params.push(parseInt(user_id, 10));
      conditions.push(`a.user_id = $${params.length}`);
    }

    if (from) {
      params.push(from);
      conditions.push(`a.created_at >= $${params.length}::timestamptz`);
    }

    if (to) {
      // Include the full "to" day
      params.push(to);
      conditions.push(`a.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }

    // Category map: group actions under broad buckets
    const CATEGORY_ACTIONS = {
      auth:       ['Signed In', 'Registered User'],
      releases:   ['Viewed Releases', 'Viewed Release', 'Created Release', 'Updated Release', 'Deleted Release', 'Viewed Release Comments', 'Added Release Comment'],
      artists:    ['Viewed Artists', 'Viewed Artist', 'Created Artist', 'Updated Artist', 'Deleted Artist'],
      contracts:  ['Viewed Contracts', 'Viewed Contract', 'Created Contract', 'Updated Contract', 'Deleted Contract', 'Viewed Pending Contracts', 'Created Pending Contract', 'Updated Pending Contract', 'Deleted Pending Contract'],
      deals:      ['Viewed Deals', 'Created Deal', 'Updated Deal', 'Deleted Deal'],
      team:       ['Viewed Team', 'Viewed Team Member', 'Added Team Member', 'Updated Team Member', 'Removed Team Member', 'Viewed Tasks', 'Created Task', 'Updated Task', 'Deleted Task'],
      financials: ['Viewed Financials', 'Added Expense', 'Updated Expense', 'Deleted Expense', 'Added Income', 'Updated Income', 'Deleted Income', 'Updated Artist Budget', 'Updated Release Budget'],
      other:      ['Submitted Request', 'Updated Request', 'Viewed Dashboard', 'Updated DSP Submission', 'Created DSP Submission', 'Performed Search'],
    };

    if (category && category !== 'all' && CATEGORY_ACTIONS[category]) {
      const actions = CATEGORY_ACTIONS[category];
      const placeholders = actions.map((_, i) => `$${params.length + i + 1}`).join(', ');
      params.push(...actions);
      conditions.push(`a.action IN (${placeholders})`);
    }

    // HTTP method filter (comma-separated list e.g. "POST,PUT,DELETE")
    if (methods && methods.trim()) {
      const methodList = methods.split(',').map(m => m.trim().toUpperCase()).filter(Boolean);
      if (methodList.length > 0) {
        const placeholders = methodList.map((_, i) => `$${params.length + i + 1}`).join(', ');
        params.push(...methodList);
        conditions.push(`a.method IN (${placeholders})`);
      }
    }

    // Department filter (joins through users table)
    if (department && department !== 'all') {
      params.push(department);
      conditions.push(`u.department = $${params.length}`);
    }

    if (search && search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      conditions.push(`(LOWER(a.action) LIKE $${params.length} OR LOWER(u.name) LIKE $${params.length} OR LOWER(u.email) LIKE $${params.length})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderDir = sort === 'asc' ? 'ASC' : 'DESC';

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    params.push(parseInt(limit, 10));
    params.push(offset);

    const dataQuery = `
      SELECT
        a.id,
        a.action,
        a.detail,
        a.ip_address,
        a.method,
        a.endpoint,
        a.entry_id,
        a.entry_payee,
        a.created_at,
        u.id         AS user_id,
        u.name       AS user_name,
        u.email,
        u.role,
        u.department
      FROM activity_log a
      LEFT JOIN users u ON u.id = a.user_id
      ${where}
      ORDER BY a.created_at ${orderDir}
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    // Count query (same conditions, no limit/offset)
    const countParams = params.slice(0, params.length - 2);
    const countQuery = `
      SELECT COUNT(*) FROM activity_log a
      LEFT JOIN users u ON u.id = a.user_id
      ${where}
    `;

    const [dataRes, countRes] = await Promise.all([
      pool.query(dataQuery, params),
      pool.query(countQuery, countParams),
    ]);

    res.json({
      success: true,
      data: dataRes.rows,
      total: parseInt(countRes.rows[0].count, 10),
    });
  } catch (error) {
    console.error('Activity log error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/activity/users — distinct users who have activity (for filter dropdown)
router.get('/users', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'Admin' && req.user.role !== 'Superadmin') {
      return res.status(403).json({ success: false, error: 'Admin only' });
    }

    const result = await pool.query(`
      SELECT DISTINCT u.id, u.name, u.department
      FROM activity_log a
      JOIN users u ON u.id = a.user_id
      ORDER BY u.name ASC
    `);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Activity users error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
