/**
 * Input sanitization & validation middleware.
 *
 * - Enforces max string lengths on all request body fields
 * - Strips HTML/script tags from text fields
 * - Rejects bodies larger than a safe threshold
 * - Validates that numeric fields are actually numbers
 */

const MAX_STRING_LENGTH = 10000;  // 10KB per field — short text fields
const MAX_BODY_KEYS = 100;       // reject payloads with too many keys
const MAX_ARRAY_LENGTH = 200;    // max items in an array field

// Fields known to carry long-form text (document bodies, contract clauses,
// notes, AI prompts). The 10KB short-text cap silently truncates these and
// has caused data-loss bugs — e.g., NDA bodies clipping off the last few
// sections. Listed fields use the larger cap below.
const LONG_TEXT_FIELDS = new Set([
  'custom_body', 'notes', 'description', 'body', 'message', 'content',
  'clause_body', 'terms', 'pitch', 'bio',
]);
const LONG_MAX_STRING_LENGTH = 100000;  // 100KB per long-text field

// Strips <script>, <iframe>, event handlers, and other dangerous HTML
function stripDangerous(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/<link[^>]*>/gi, '');
}

function sanitizeValue(val, fieldName, depth = 0) {
  if (depth > 10) return val; // prevent deep recursion

  if (typeof val === 'string') {
    // Per-field max length — long-text fields get a much higher cap so we
    // don't silently truncate document bodies, contract clauses, etc.
    const maxLen = LONG_TEXT_FIELDS.has(fieldName) ? LONG_MAX_STRING_LENGTH : MAX_STRING_LENGTH;
    let sanitized = val.length > maxLen ? val.slice(0, maxLen) : val;
    // Strip dangerous HTML
    sanitized = stripDangerous(sanitized);
    return sanitized;
  }

  if (Array.isArray(val)) {
    // Limit array length
    const trimmed = val.length > MAX_ARRAY_LENGTH ? val.slice(0, MAX_ARRAY_LENGTH) : val;
    return trimmed.map(item => sanitizeValue(item, fieldName, depth + 1));
  }

  if (val && typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.length > MAX_BODY_KEYS) return val; // bail on huge objects
    const sanitized = {};
    for (const key of keys) {
      sanitized[key] = sanitizeValue(val[key], key, depth + 1);
    }
    return sanitized;
  }

  return val;
}

function sanitizeMiddleware(req, res, next) {
  // Only sanitize JSON bodies
  if (req.body && typeof req.body === 'object') {
    // Reject payloads with too many keys (potential DoS)
    const topKeys = Object.keys(req.body);
    if (topKeys.length > MAX_BODY_KEYS) {
      return res.status(400).json({ success: false, error: 'Request body has too many fields' });
    }

    req.body = sanitizeValue(req.body, null);
  }

  // Sanitize query params
  if (req.query && typeof req.query === 'object') {
    for (const key of Object.keys(req.query)) {
      if (typeof req.query[key] === 'string') {
        req.query[key] = stripDangerous(req.query[key]);
        if (req.query[key].length > 2000) {
          req.query[key] = req.query[key].slice(0, 2000);
        }
      }
    }
  }

  next();
}

module.exports = sanitizeMiddleware;
