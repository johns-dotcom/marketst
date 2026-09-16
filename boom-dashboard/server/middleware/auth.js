const jwt = require('jsonwebtoken');
const pool = require('../db');
const testUserGuard = require('./testUserGuard');

// Ensure token_version column exists
pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT DEFAULT 0')
  .catch(e => console.warn('token_version migration:', e.message));

const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;

  if (!token) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    // Verify token_version hasn't been bumped (session invalidation), and
    // at the same time pull the live role + boom_rep from the DB. JWTs
    // are stateless, so a role change made via Settings or a startup
    // migration wouldn't otherwise take effect until the user logged
    // out and back in. Same applies to boom_rep — the rep-visibility
    // helpers in bookkeeping.js read it off req.user; staleness would
    // hide work from a freshly-assigned rep until they logged back in.
    if (decoded.id) {
      const { rows } = await pool.query(
        'SELECT token_version, role, boom_rep FROM users WHERE id = $1',
        [decoded.id]
      );
      if (rows.length) {
        if (decoded.tv !== undefined && rows[0].token_version !== decoded.tv) {
          return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
        }
        // Overlay the fresh role + boom_rep onto req.user so the
        // permission gates see the current values, not the stale ones
        // baked into the token at login.
        if (rows[0].role) req.user.role = rows[0].role;
        req.user.boom_rep = rows[0].boom_rep || null;
      }
    }

    // Test-user guard runs on every authenticated request — blocks test
    // accounts from touching any real-data endpoint outside the allowlist.
    return testUserGuard(req, res, next);
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
};

module.exports = authMiddleware;
