// One-time invite links. The token travels in the URL and only its SHA-256
// is stored, so a database read cannot mint a login. Seven days; creating a
// new one deletes any unused ones for the same person.
const crypto = require('crypto');
const pool = require('../db');

const INVITE_DAYS = 7;
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

async function createInvite(userId, createdBy, q = pool) {
  const token = crypto.randomBytes(24).toString('base64url');
  await q.query('DELETE FROM user_invites WHERE user_id = $1 AND used_at IS NULL', [userId]);
  const { rows: [row] } = await q.query(
    `INSERT INTO user_invites (user_id, token_hash, created_by, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' days')::interval) RETURNING id, expires_at`,
    [userId, hash(token), createdBy || null, String(INVITE_DAYS)]);
  return { token, path: `/invite/${token}`, expires_at: row.expires_at };
}

// The invite behind a token, with its person, or a reason it cannot be used.
async function lookupInvite(token, q = pool) {
  if (!token || String(token).length < 16) return { error: 'invalid' };
  const { rows: [r] } = await q.query(
    `SELECT i.id, i.user_id, i.expires_at, i.used_at, u.name, u.email, u.password_hash IS NOT NULL AS has_password
       FROM user_invites i JOIN users u ON u.id = i.user_id WHERE i.token_hash = $1`, [hash(token)]);
  if (!r) return { error: 'invalid' };
  if (r.used_at) return { error: 'used', invite: r };
  if (new Date(r.expires_at) < new Date()) return { error: 'expired', invite: r };
  return { invite: r };
}

module.exports = { createInvite, lookupInvite, hashToken: hash, INVITE_DAYS };
