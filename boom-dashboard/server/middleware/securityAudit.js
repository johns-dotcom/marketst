/**
 * Security audit logger.
 *
 * Logs security-sensitive events to a dedicated security_audit_log table.
 * Unlike the general activity logger, this captures:
 * - Failed login attempts (with IP)
 * - Permission changes
 * - Password changes / session invalidations
 * - Role changes
 * - Admin actions (user creation, deletion)
 * - File uploads
 */

const pool = require('../db');

// Auto-create security audit table
pool.query(`
  CREATE TABLE IF NOT EXISTS security_audit_log (
    id SERIAL PRIMARY KEY,
    ts TIMESTAMP DEFAULT NOW(),
    event_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) DEFAULT 'info',
    user_id INT,
    user_name TEXT,
    ip_address VARCHAR(100),
    user_agent TEXT,
    details JSONB,
    endpoint VARCHAR(255),
    success BOOLEAN DEFAULT TRUE
  )
`).catch(e => console.warn('security_audit_log migration:', e.message));

pool.query(`CREATE INDEX IF NOT EXISTS idx_security_audit_ts ON security_audit_log(ts DESC)`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_security_audit_type ON security_audit_log(event_type)`).catch(() => {});

async function logSecurityEvent({ event_type, severity = 'info', user_id, user_name, ip, user_agent, details, endpoint, success = true }) {
  try {
    await pool.query(
      `INSERT INTO security_audit_log (event_type, severity, user_id, user_name, ip_address, user_agent, details, endpoint, success)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [event_type, severity, user_id || null, user_name || null, ip || null, user_agent || null, details ? JSON.stringify(details) : null, endpoint || null, success]
    );
  } catch (err) {
    console.error('Security audit log failed:', err.message);
  }
}

// Middleware that auto-logs security events based on request patterns
function securityAuditMiddleware(req, res, next) {
  const startTime = Date.now();

  res.on('finish', () => {
    try {
      const method = req.method;
      const path = (req.originalUrl || req.url).split('?')[0];
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
      const ua = req.headers['user-agent'] || null;
      const userId = req.user?.id || null;
      const userName = req.user?.name || null;
      const statusCode = res.statusCode;
      const ok = statusCode >= 200 && statusCode < 300;

      // Failed login attempts
      if (path === '/api/auth/login' && method === 'POST' && !ok) {
        logSecurityEvent({
          event_type: 'login_failed',
          severity: 'warning',
          ip, user_agent: ua,
          details: { email: req.body?.email, status: statusCode },
          endpoint: path,
          success: false,
        });
        return;
      }

      // Successful login
      if (path === '/api/auth/login' && method === 'POST' && ok) {
        logSecurityEvent({
          event_type: 'login_success',
          severity: 'info',
          user_id: userId, user_name: userName, ip, user_agent: ua,
          details: { email: req.body?.email },
          endpoint: path,
        });
        return;
      }

      // Password changes
      if (path === '/api/auth/change-password' && method === 'POST') {
        logSecurityEvent({
          event_type: ok ? 'password_changed' : 'password_change_failed',
          severity: ok ? 'warning' : 'info',
          user_id: userId, user_name: userName, ip, user_agent: ua,
          endpoint: path,
          success: ok,
        });
        return;
      }

      // Logout all sessions
      if (path === '/api/auth/logout-all' && method === 'POST' && ok) {
        logSecurityEvent({
          event_type: 'sessions_invalidated',
          severity: 'warning',
          user_id: userId, user_name: userName, ip,
          endpoint: path,
        });
        return;
      }

      // User registration
      if (path === '/api/auth/register' && method === 'POST' && ok) {
        logSecurityEvent({
          event_type: 'user_created',
          severity: 'warning',
          user_id: userId, user_name: userName, ip,
          details: { new_user_email: req.body?.email, role: req.body?.role },
          endpoint: path,
        });
        return;
      }

      // Permission changes
      if (path.match(/^\/api\/settings\/permissions\/\d+$/) && method === 'PUT') {
        logSecurityEvent({
          event_type: ok ? 'permissions_changed' : 'permissions_change_failed',
          severity: 'warning',
          user_id: userId, user_name: userName, ip,
          details: { target_user_id: path.split('/').pop(), pages_count: req.body?.pages?.length },
          endpoint: path,
          success: ok,
        });
        return;
      }

      // Role changes (user updates in settings)
      if (path.match(/^\/api\/settings\/users\/\d+$/) && method === 'PUT' && req.body?.role) {
        logSecurityEvent({
          event_type: 'role_changed',
          severity: 'critical',
          user_id: userId, user_name: userName, ip,
          details: { target_user_id: path.split('/').pop(), new_role: req.body.role },
          endpoint: path,
          success: ok,
        });
        return;
      }

      // File uploads (any multipart request that succeeded)
      if (method === 'POST' && ok && req.file) {
        logSecurityEvent({
          event_type: 'file_uploaded',
          severity: 'info',
          user_id: userId, user_name: userName, ip,
          details: { filename: req.file.originalname, size: req.file.size, mimetype: req.file.mimetype },
          endpoint: path,
        });
        return;
      }

      // Vendor submissions (public endpoint)
      if (path === '/api/vendor/submit' && method === 'POST') {
        logSecurityEvent({
          event_type: ok ? 'vendor_submission' : 'vendor_submission_failed',
          severity: 'info',
          ip, user_agent: ua,
          details: { vendor_name: req.body?.vendor_name, vendor_email: req.body?.vendor_email },
          endpoint: path,
          success: ok,
        });
        return;
      }

      // Rate limit hits (429 status)
      if (statusCode === 429) {
        logSecurityEvent({
          event_type: 'rate_limit_hit',
          severity: 'warning',
          user_id: userId, user_name: userName, ip, user_agent: ua,
          details: { endpoint: path, method },
          endpoint: path,
          success: false,
        });
      }
    } catch (e) {
      // Never let audit logging crash a request
    }
  });

  next();
}

module.exports = { securityAuditMiddleware, logSecurityEvent };
