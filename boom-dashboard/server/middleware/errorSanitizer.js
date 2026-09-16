/**
 * Error sanitization — prevents secrets from leaking in API responses.
 *
 * In production, replaces raw error messages with generic ones.
 * In development, passes through for easier debugging.
 */

// Patterns that indicate a secret might be in the error
const SENSITIVE_PATTERNS = [
  /password/i,
  /secret/i,
  /api_key/i,
  /apikey/i,
  /token/i,
  /DATABASE_URL/i,
  /connectionString/i,
  /postgresql:\/\//i,
  /postgres:\/\//i,
  /ANTHROPIC/i,
  /SPOTIFY/i,
  /GMAIL/i,
  /GOOGLE/i,
  /Bearer\s+[a-zA-Z0-9._-]+/i,
  /sk-[a-zA-Z0-9]+/,      // Anthropic API key format
  /Basic\s+[a-zA-Z0-9+/=]+/i,
];

function sanitizeErrorMessage(message) {
  if (!message || typeof message !== 'string') return 'An error occurred';

  if (process.env.NODE_ENV !== 'production') return message;

  // Check if the error message contains anything sensitive
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(message)) {
      return 'An internal error occurred. Please try again.';
    }
  }

  // Truncate very long messages (could contain data dumps)
  if (message.length > 200) {
    return message.slice(0, 200);
  }

  return message;
}

// Global error handler middleware — catches unhandled errors
function errorSanitizerMiddleware(err, req, res, next) {
  // Log the full error server-side
  console.error(`[${req.method} ${req.originalUrl}] Error:`, err.message);

  // Never send stack traces in production
  const response = {
    success: false,
    error: sanitizeErrorMessage(err.message),
  };

  // In dev, include the stack for debugging
  if (process.env.NODE_ENV !== 'production') {
    response.stack = err.stack;
  }

  res.status(err.status || 500).json(response);
}

module.exports = { sanitizeErrorMessage, errorSanitizerMiddleware };
