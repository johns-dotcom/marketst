const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// POST /api/auth/login
// ── Invites (public) ────────────────────────────────────────────────────────
// GET  /auth/invite/:token   who this link is for, or why it cannot be used
// POST /auth/invite/:token   { password } → sets it, marks the invite used, signs in
const { lookupInvite } = require('../lib/invites');
const INVITE_MESSAGES = {
  invalid: 'This invite link is not valid.',
  used: 'This invite link has already been used. Sign in instead, or ask an admin to resend.',
  expired: 'This invite link has expired. Ask an admin to resend it.',
};
router.get('/invite/:token', async (req, res) => {
  try {
    const r = await lookupInvite(req.params.token);
    if (r.error) return res.status(r.error === 'invalid' ? 404 : 410).json({ success: false, error: INVITE_MESSAGES[r.error], reason: r.error });
    res.json({ success: true, data: { name: r.invite.name, email: r.invite.email, expires_at: r.invite.expires_at } });
  } catch (err) { console.error('invite lookup error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});
router.post('/invite/:token', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 8) return res.status(400).json({ success: false, error: 'Choose a password of at least 8 characters.' });
    const r = await lookupInvite(req.params.token);
    if (r.error) return res.status(r.error === 'invalid' ? 404 : 410).json({ success: false, error: INVITE_MESSAGES[r.error], reason: r.error });
    const hashPw = await bcrypt.hash(String(password), 10);
    const client = await pool.connect();
    let user;
    try {
      await client.query('BEGIN');
      const { rows: [u] } = await client.query(
        `UPDATE users SET password_hash = $2, token_version = COALESCE(token_version, 0) + 1 WHERE id = $1
         RETURNING id, email, name, role, department, hierarchy_level, token_version`, [r.invite.user_id, hashPw]);
      await client.query('UPDATE user_invites SET used_at = NOW() WHERE id = $1', [r.invite.id]);
      await client.query('COMMIT'); user = u;
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role, department: user.department, hierarchy_level: user.hierarchy_level, tv: user.token_version || 0 },
      process.env.JWT_SECRET, { expiresIn: '8h' });
    await pool.query('INSERT INTO user_login_logs (user_id, ip_address, user_agent) VALUES ($1, $2, $3)', [user.id, req.ip || null, req.headers['user-agent'] || null]).catch(() => {});
    res.json({ success: true, data: { token, user: { id: user.id, name: user.name, email: user.email, role: user.role, department: user.department, hierarchy_level: user.hierarchy_level } } });
  } catch (err) { console.error('invite accept error:', err); res.status(500).json({ success: false, error: 'Internal server error' }); }
});

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

    // No password yet: the account is waiting on its invite link (or is
    // Google-only). Say so — a generic "invalid credentials" sends a new
    // teammate off to reset a password they never had.
    if (!user.password_hash) {
      return res.status(401).json({ success: false, error: 'This account has no password yet. Use the invite link you were sent, sign in with Google, or ask an admin to resend the invite.' });
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
    // Google says whether it verified the address; an unverified claim must not log anyone in.
    if (payload.email_verified === false) return res.status(403).json({ success: false, error: 'This Google account\'s email is not verified.' });

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
    // Signing in with Google ACCEPTS a pending invite: the link is spent, and the
    // person can set a password of their own under Settings › Sign-in.
    if (!user.password_hash) pool.query('UPDATE user_invites SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [user.id]).catch(() => {});

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
          has_password: !!user.password_hash,
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
    // The same tiering Settings enforces: an Admin creates Users and Approvers;
    // only a Superadmin creates Admins or Superadmins. This route took `role`
    // straight from the body, a second door onto the same table.
    const wantedRole = role || 'User';
    if (!['User', 'Approver', 'Admin', 'Superadmin'].includes(wantedRole)) return res.status(400).json({ success: false, error: 'Unknown role' });
    if (['Admin', 'Superadmin'].includes(wantedRole) && req.user.role !== 'Superadmin') return res.status(403).json({ success: false, error: 'Only a Superadmin can create Admin or Superadmin accounts' });

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
      'SELECT id, name, email, role, role_key, department, hierarchy_level, boom_rep, title, phone, nav_hidden, created_at, (password_hash IS NOT NULL) AS has_password FROM users WHERE id = $1',
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

    // The token remembers WHO is impersonating (`imp`), and the act is written to
    // the security audit — before this an impersonated session was byte-identical
    // to the person's own and left no trail naming the Superadmin.
    const token = jwt.sign(
      { id: target.id, email: target.email, name: target.name, role: target.role, department: target.department, hierarchy_level: target.hierarchy_level, tv: target.token_version || 0, imp: req.user.id },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );
    try {
      const { logSecurityEvent } = require('../middleware/securityAudit');
      await logSecurityEvent({ event_type: 'impersonate', severity: 'critical', user_id: req.user.id, user_name: req.user.name || req.user.email, ip: req.ip, user_agent: req.get('user-agent'), endpoint: req.originalUrl, details: `Viewing as ${target.name || target.email} (#${target.id}, ${target.role}) for up to 2h` });
    } catch (e) { console.warn('impersonate audit failed:', e.message); }

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
    if (!new_password) return res.status(400).json({ success: false, error: 'New password required' });
    if (new_password.length < 8) {
      return res.status(400).json({ success: false, error: 'New password must be at least 8 characters' });
    }

    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'User not found' });

    // An account that signed in with Google off an invite has NO password yet
    // (2026-09-22, John: "users should be allowed to set their own password after
    // accepting the google invite"). Setting the first one needs no current
    // password — there is none to check; bcrypt.compare against null threw a 500
    // here before. Changing an existing one still does.
    const firstPassword = !rows[0].password_hash;
    if (!firstPassword) {
      if (!current_password) return res.status(400).json({ success: false, error: 'Current password required' });
      const match = await bcrypt.compare(current_password, rows[0].password_hash);
      if (!match) return res.status(401).json({ success: false, error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    // Setting the first password ends the invite (the link would otherwise still
    // work) and does NOT bump token_version — this session is the only one.
    await pool.query(
      firstPassword
        ? 'UPDATE users SET password_hash = $1 WHERE id = $2'
        : 'UPDATE users SET password_hash = $1, token_version = COALESCE(token_version, 0) + 1 WHERE id = $2',
      [hash, req.user.id]
    );
    if (firstPassword) await pool.query('UPDATE user_invites SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [req.user.id]).catch(() => {});

    res.json({ success: true, first_password: firstPassword, message: firstPassword ? 'Password set. You can sign in with it or with Google.' : 'Password changed. All sessions invalidated.' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
