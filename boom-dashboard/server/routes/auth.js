const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    // Google-SSO-only accounts have no password_hash — bcrypt.compare(pw, null)
    // throws, which surfaced as a 500 instead of a clean 401.
    if (!user.password_hash) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role, department: user.department, hierarchy_level: user.hierarchy_level, tv: user.token_version || 0 },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    // Record login event (fire-and-forget, non-blocking)
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
    const ua = req.headers['user-agent'] || null;
    pool.query(
      'INSERT INTO user_login_logs (user_id, ip_address, user_agent) VALUES ($1, $2, $3)',
      [user.id, ip, ua]
    ).catch(() => {});
    pool.query(
      'INSERT INTO activity_log (user_id, action, detail, ip_address, method, endpoint, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
      [user.id, 'Signed In', 'Email/password login', ip, 'POST', '/api/auth/login']
    ).catch(() => {});

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          department: user.department,
          hierarchy_level: user.hierarchy_level,
        },
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/auth/google — verify Google ID token, return our JWT
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ success: false, error: 'Google credential required' });
    }

    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(500).json({ success: false, error: 'Google OAuth not configured on server' });
    }

    // Verify the ID token with Google
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { email, name } = payload;

    // Look up the user by email — must already exist in the system
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(403).json({
        success: false,
        error: 'No account found for this Google account. Contact your admin.',
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role, department: user.department, hierarchy_level: user.hierarchy_level, tv: user.token_version || 0 },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    // Record login event
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
    const ua = req.headers['user-agent'] || null;
    pool.query(
      'INSERT INTO user_login_logs (user_id, ip_address, user_agent) VALUES ($1, $2, $3)',
      [user.id, ip, ua]
    ).catch(() => {});
    pool.query(
      'INSERT INTO activity_log (user_id, action, detail, ip_address, method, endpoint, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
      [user.id, 'Signed In', 'Google SSO', ip, 'POST', '/api/auth/google']
    ).catch(() => {});

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          department: user.department,
          hierarchy_level: user.hierarchy_level,
        },
      },
    });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(401).json({ success: false, error: 'Google authentication failed' });
  }
});

// POST /api/auth/register (admin only)
router.post('/register', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'Admin' && req.user.role !== 'Superadmin') {
      return res.status(403).json({ success: false, error: 'Only admins can register users' });
    }

    const { name, email, password, role, department } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, error: 'Name, email, and password required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash, role, department, created_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id, name, email, role, department',
      [name, email, passwordHash, role || 'User', department || 'Operations']
    );

    res.status(201).json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ success: false, error: 'Email already exists' });
    }
    console.error('Register error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, role, department, hierarchy_level, boom_rep, created_at FROM users WHERE id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Fetch page permissions — null means unrestricted (no rows configured)
    const permsResult = await pool.query(
      'SELECT page FROM user_page_permissions WHERE user_id = $1 ORDER BY page',
      [req.user.id]
    );
    const pagePermissions = permsResult.rows.length > 0
      ? permsResult.rows.map(r => r.page)
      : null;

    res.json({
      success: true,
      data: { ...result.rows[0], pagePermissions },
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/auth/impersonate/:userId (admin only)
// Returns a short-lived JWT for the target user so the frontend can view as them
router.post('/impersonate/:userId', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'Superadmin') {
      return res.status(403).json({ success: false, error: 'Superadmin only' });
    }

    const targetId = parseInt(req.params.userId, 10);
    if (isNaN(targetId) || targetId === req.user.id) {
      return res.status(400).json({ success: false, error: 'Invalid target user' });
    }

    const result = await pool.query(
      'SELECT id, name, email, role, department, hierarchy_level, boom_rep, token_version FROM users WHERE id = $1',
      [targetId]
    );
    const target = result.rows[0];
    if (!target) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const token = jwt.sign(
      { id: target.id, email: target.email, name: target.name, role: target.role, department: target.department, hierarchy_level: target.hierarchy_level, tv: target.token_version || 0 },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    res.json({ success: true, data: { token, user: target } });
  } catch (error) {
    console.error('Impersonate error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/auth/users (superadmin only) — list all users for the impersonation picker
router.get('/users', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'Superadmin') {
      return res.status(403).json({ success: false, error: 'Superadmin only' });
    }
    const result = await pool.query(
      'SELECT id, name, email, role, department, hierarchy_level FROM users ORDER BY hierarchy_level, name'
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('List users error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/auth/logout-all — invalidate all sessions for the current user
router.post('/logout-all', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1',
      [req.user.id]
    );
    res.json({ success: true, message: 'All sessions invalidated. Please log in again.' });
  } catch (error) {
    console.error('Logout all error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/auth/change-password — change password and invalidate all tokens
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, error: 'Current and new password required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ success: false, error: 'New password must be at least 8 characters' });
    }

    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'User not found' });

    const match = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!match) return res.status(401).json({ success: false, error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, token_version = COALESCE(token_version, 0) + 1 WHERE id = $2',
      [hash, req.user.id]
    );

    res.json({ success: true, message: 'Password changed. All sessions invalidated.' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
