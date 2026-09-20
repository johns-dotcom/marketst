const jwt = require('jsonwebtoken');
const pool = require('../db');

// Ensure token_version column exists
pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT DEFAULT 0')
  .catch(e => console.warn('token_version migration:', e.message));

// A token in the QUERY STRING is accepted only for GET requests to the routes
// that serve or export a file — the browser has to open those as plain URLs.
// It was accepted everywhere, so a session JWT that reached an access log or a
// Referer header replayed against the whole API (security pass 2026-09-20).
const QUERY_TOKEN_PATHS = /(\/file(\/|$)|\/files\/|\/receipts\/\d+|\/proof$|\/export|\/download|\/uploads\/|\/statements\/\d+\/file|\.(xlsx|csv|zip)$)/;
const authMiddleware = async (req, res, next) => {
  const headerToken = req.headers.authorization?.split(' ')[1];
  const queryToken = req.method === 'GET' && QUERY_TOKEN_PATHS.test(req.path) ? req.query.token : undefined;
  const token = headerToken || queryToken;

  if (!token) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Only a SESSION token authenticates: it names a user and carries the
    // token_version it was minted at. The OAuth `state` JWTs are signed with the
    // same secret and used to pass here (no id → no version check); a token
    // without `tv` could never be revoked by logout-all.
    if (!decoded || typeof decoded !== 'object' || !decoded.id || decoded.tv === undefined) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
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

    return next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
};

module.exports = authMiddleware;
