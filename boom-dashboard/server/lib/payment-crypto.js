/**
 * Encryption for stored vendor payment details.
 *
 * ── Why this is separate from every other field in the app ──
 * The database already holds sensitive vendor data — names, addresses, emails,
 * W9s. A bank account number together with its routing number is a different
 * class: it is directly actionable by anyone who reads it. So it is the one
 * thing here that does not go in as plain text.
 *
 * AES-256-GCM, which authenticates as well as encrypts: a stored value that has
 * been tampered with fails to decrypt rather than returning something plausible.
 * Each value gets its own random IV, so two vendors sharing a routing number do
 * not produce identical ciphertext.
 *
 * ── No key, no storage ──
 * `encrypt` THROWS when `PAYMENT_DETAILS_KEY` is missing. That is deliberate and
 * the caller must not swallow it: the alternatives are writing plaintext into a
 * column named `_enc` (silently defeating the whole point) or dropping the
 * details on the floor (a vendor who typed their bank details and got a success
 * page, with nothing stored). Refusing loudly is the only honest option.
 *
 * Which means THE ENV VAR MUST EXIST BEFORE THIS DEPLOYS. Without it the public
 * submit form starts refusing every submission. That ordering is part of the
 * rollout.
 *
 * Key: 32 bytes, hex or base64. Generate with
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;          // 96 bits, the size GCM is specified for
const VERSION = 'v1';         // so a future key rotation can be told apart

let cachedKey = null;
let cachedRaw = null;

/**
 * The key as 32 raw bytes, or null when unset/malformed.
 * Cached against the env value so a changed key in a long-running process is
 * picked up rather than being masked by the cache.
 */
function loadKey() {
  const raw = process.env.PAYMENT_DETAILS_KEY || '';
  if (!raw) { cachedKey = null; cachedRaw = null; return null; }
  if (raw === cachedRaw) return cachedKey;
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, 'hex');
  else {
    try {
      const b = Buffer.from(raw, 'base64');
      if (b.length === 32) buf = b;
    } catch { /* not base64 either */ }
  }
  if (!buf || buf.length !== 32) {
    console.error('[payment-crypto] PAYMENT_DETAILS_KEY is set but is not 32 bytes '
      + '(expected 64 hex chars or base64 of 32 bytes) — treating it as ABSENT');
    cachedKey = null; cachedRaw = raw;
    return null;
  }
  cachedKey = buf; cachedRaw = raw;
  return buf;
}

/** Is storing payment details possible right now? Callers check this to refuse early. */
const isConfigured = () => loadKey() !== null;

/**
 * @param {string} plain
 * @returns {string} `v1:<iv b64>:<tag b64>:<ciphertext b64>`
 * @throws when no usable key is configured — never returns plaintext.
 */
function encrypt(plain) {
  const key = loadKey();
  if (!key) throw new Error('PAYMENT_DETAILS_KEY is not configured — refusing to store payment details');
  const s = String(plain ?? '');
  if (!s) return null;
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return [VERSION, iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

/**
 * @returns {string|null} the plaintext, or null when the value is absent, the
 *   key is missing, or the ciphertext fails authentication. Never throws — a
 *   payments screen should render with the field unavailable rather than 500.
 */
function decrypt(stored) {
  if (!stored) return null;
  const key = loadKey();
  if (!key) return null;
  try {
    const [v, ivB64, tagB64, ctB64] = String(stored).split(':');
    if (v !== VERSION) return null;
    const d = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
    d.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8');
  } catch (err) {
    console.error('[payment-crypto] could not decrypt a stored value:', err.message);
    return null;
  }
}

/** Last four characters, for display. Never derive this FROM the ciphertext. */
const last4 = (plain) => (plain ? String(plain).slice(-4) : null);

/** `••••4821` — the form every screen except the explicit reveal shows. */
const mask = (l4) => (l4 ? `••••${l4}` : null);

module.exports = { encrypt, decrypt, isConfigured, last4, mask, VERSION };
