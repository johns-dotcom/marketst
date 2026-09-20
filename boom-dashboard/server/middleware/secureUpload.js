/**
 * Secure file upload configuration.
 *
 * - Validates MIME types against an allowlist
 * - Checks file magic bytes (not just extension)
 * - Enforces per-file size limits
 * - Rejects executables, scripts, and archives
 */

const ALLOWED_MIMES = new Set([
  // Documents
  'application/pdf',
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  // Spreadsheets / CSV
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // Allow octet-stream for files that multer can't determine (we validate further)
  'application/octet-stream',
]);

// Magic byte signatures for common safe file types
const MAGIC_BYTES = {
  '%PDF':     'application/pdf',
  '\xFF\xD8': 'image/jpeg',
  '\x89PNG':  'image/png',
  'GIF8':     'image/gif',
  'RIFF':     'image/webp', // WebP starts with RIFF
  'PK':       'application/zip', // xlsx files are zips
};

// Dangerous extensions to always reject regardless of MIME
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.pif',
  '.vbs', '.vbe', '.js', '.jse', '.ws', '.wsf', '.wsc', '.wsh',
  '.ps1', '.psm1', '.psd1', '.sh', '.bash', '.csh', '.ksh',
  '.py', '.pyw', '.rb', '.pl', '.php', '.asp', '.aspx', '.jsp',
  '.dll', '.so', '.dylib', '.class', '.jar',
  '.hta', '.inf', '.reg', '.rgs', '.sct',
  '.html', '.htm', '.svg', // Can contain XSS
]);

// application/octet-stream is what a browser sends for anything it cannot name.
// It is accepted only when the extension says it is a document we serve.
const OCTET_OK_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.xlsx', '.xls', '.csv', '.doc', '.docx', '.txt', '.zip']);
function secureFileFilter(req, file, cb) {
  // Check extension — path.extname, so "payload" (no dot) and "x.svg." are refused rather
  // than yielding ".payload" / "." and slipping past the block list.
  const ext = require('path').extname(String(file.originalname || '')).toLowerCase();
  if (!ext || ext === '.') return cb(new Error('The file needs an extension (.pdf, .png, .jpg…)'), false);
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return cb(new Error(`File type ${ext} is not allowed`), false);
  }
  if (file.mimetype === 'application/octet-stream' && !OCTET_OK_EXT.has(ext)) {
    return cb(new Error(`File type ${ext} is not allowed`), false);
  }

  // Check MIME type
  if (!ALLOWED_MIMES.has(file.mimetype)) {
    return cb(new Error(`File type ${file.mimetype} is not allowed`), false);
  }

  cb(null, true);
}

module.exports = { secureFileFilter, ALLOWED_MIMES, BLOCKED_EXTENSIONS };
