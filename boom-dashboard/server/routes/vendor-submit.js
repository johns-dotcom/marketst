/**
 * Public vendor submission route — no auth required.
 * POST /api/vendor/submit  (multipart/form-data)
 */

const express = require('express');
const multer  = require('multer');
const pool    = require('../db');
const rateLimit = require('express-rate-limit');
const { uploadFile } = require('../lib/r2');
const { callClaude } = require('../services/claude');
const { CATEGORIES } = require('../lib/constants');
const { categoryVocabulary } = require('../lib/category-vocab');
const { applyArtistNormalization } = require('../lib/artist-normalization');

const router = express.Router();

// Rate limit AI validation endpoints — 5 per minute per IP
const aiValidationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { valid: true, issues: [], rate_limited: true },
});

const { secureFileFilter } = require('../middleware/secureUpload');
const { postEvent } = require('../lib/activityBot');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: secureFileFilter,
});

// Auth for the sandbox only.
//
// /api/vendor/submit is PUBLIC — that is the whole point of it, and a vendor
// reaching it from an invoice email has no account. But `?sandbox=1` spends real
// Anthropic calls on the way to writing nothing, so it needs a signed-in admin, or
// it is a bill a stranger can run up.
//
// Reuses the ONE auth middleware rather than verifying a token here: that is where
// the token_version session check and the live role lookup live, and a second
// implementation of "is this caller real" is how the two drift apart. Placed BEFORE
// multer so an unauthenticated sandbox request is refused without buffering 10MB
// of upload first.
const auth = require('../middleware/auth');
const sandboxAuth = (req, res, next) => (
  String(req.query.sandbox || '') === '1' ? auth(req, res, next) : next()
);

// `file` stays maxCount 1 and stays the PRIMARY invoice, deliberately. It is the
// document the AI parse reads, the one `extractInvoiceNumberFromDocument` checks
// the typed invoice number against, and the one `invoice_r2_key` points at — so
// every has-invoice check and the whole anti-spoofing gate keep meaning exactly
// what they meant. Turning that single key into a list would have quietly
// changed which document the gate judges.
//
// `file_extra` is everything else the vendor wants to attach: extra pages, a
// timesheet, a screenshot of the brief. Up to 9, which with the primary makes 10
// files at 10MB each — the per-file cap is multer's `fileSize` above.
// Must match EXTRA_FILE_MAX in client/src/pages/VendorSubmit.jsx.
const EXTRA_FILE_MAX = 9;

// ── One submission, up to ten invoices ───────────────────────────────────────
//
// John, 2026-09-15: "allow users to upload multiple invoices in one submission."
// A vendor with five invoices to bill filled this form five times — and
// `vendorLimiter` is 10/hour, so the sixth was refused outright.
//
// EACH INVOICE KEEPS ITS OWN PRIMARY DOCUMENT, under its own field name. The
// note above `file` still holds, one level down: the primary is what the AI
// parse reads, what `extractInvoiceNumberFromDocument` judges that invoice's
// typed number against, and what its `invoice_r2_key` points at. Making a single
// field carry N documents would have made "which document is the gate judging"
// depend on upload order, which is exactly the property `file_extra` exists to
// protect.
//
// `file` / `file_extra` / `receipt_file` stay, and mean INVOICE 1. A tab that
// was open before this deployed, a script posting the old shape, and both
// fixtures all send exactly those, and they must keep working unchanged — the
// single-invoice path is 418 live submissions from 190 vendors.
const INVOICE_MAX = 10;

// ONE SLOT PAST THE CAP, on purpose. Multer refuses the whole request when it
// meets a field it was not told about, so with exactly ten slots an eleventh
// invoice died as `LIMIT_UNEXPECTED_FILE` — "too many files" — which is the
// wrong sentence for the wrong problem: the vendor sent one invoice too many,
// not too many attachments. With the extra slot the request parses and
// `collectInvoices` refuses it by NAME, saying the limit and how many arrived.
const perInvoiceFields = [];
for (let i = 0; i <= INVOICE_MAX; i++) {
  perInvoiceFields.push({ name: `invoice_file_${i}`,   maxCount: 1 });
  perInvoiceFields.push({ name: `invoice_extra_${i}`,  maxCount: EXTRA_FILE_MAX });
  perInvoiceFields.push({ name: `invoice_receipt_${i}`, maxCount: 1 });
}

const fileFields = upload.fields([
  { name: 'file',         maxCount: 1 },
  { name: 'file_extra',   maxCount: EXTRA_FILE_MAX },
  { name: 'w9_file',      maxCount: 1 },
  { name: 'receipt_file', maxCount: 1 },
  ...perInvoiceFields,
]);

/**
 * Run an async mapper over items, at most `limit` in flight.
 *
 * Ten invoices means ten invoice-number reads and ten payment-detail reads
 * before anything is written. Sequentially that is twenty Anthropic round trips
 * in one HTTP request — minutes, and Cloudflare replaces a slow origin with its
 * own error page. All twenty at once is a rate-limit refusal that the vendor
 * reads as "the form is broken". Neither is a cap on how many invoices you may
 * send; it is a cap on how many are in the air at once.
 */
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Turn multer's upload failures into sentences a vendor can act on.
 *
 * Without this they reach the global error handler as a 500. The fixture caught
 * it: posting 12 supporting files returned `500` with nothing saying which limit
 * was hit or what to do. The browser caps the count at EXTRA_FILE_MAX so this is
 * not the normal path — but a stale tab, or the 10MB per-file limit, reaches it,
 * and "500" is the one answer that tells a vendor nothing.
 *
 * 400, not 502/504, deliberately: Cloudflare replaces 5xx from the origin with
 * its own HTML page and the JSON message is lost before anyone reads it.
 */
const fileFieldsSafe = (req, res, next) => fileFields(req, res, (err) => {
  if (!err) return next();
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      error: `Too many files. Each invoice takes one document plus up to ${EXTRA_FILE_MAX} `
        + `additional files, and a submission takes up to ${INVOICE_MAX} invoices.`,
    });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'That file is too large — each file must be under 10 MB.' });
  }
  console.error('[vendor-submit] upload rejected:', err.code || '', err.message);
  return res.status(400).json({ error: 'We could not read that upload. Please check the files and try again.' });
});

const singleUpload = upload.single('file');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (s) => EMAIL_RE.test(String(s || '').trim());

const { normalizeInvoiceNum } = require('../lib/normalize-invoice-num');
// One writer for a W-9's tax identity, shared with the three other paths a form
// can arrive by — see services/w9Tax.js.
const { storeW9Tax, W9_TAX_PROMPT_FIELDS } = require('../services/w9Tax');
const { normalizeSocialRows } = require('../lib/socials');
// "Does this row carry a W9 file?" — imported rather than retyped so this
// route's answer cannot drift from the `has_w9` the Approvals page shows.
const { HAS_W9_SQL } = require('../lib/w9-owner');
const { validatePaymentFields, comparePaymentDetails, buildPaymentSnapshot,
        last4: payLast4 } = require('../lib/payment-fields');
const paymentCrypto = require('../lib/payment-crypto');

// Focused AI extraction of the payment instructions printed on the invoice.
// We need *direct* payment info on the document (ACH, wire, PayPal address,
// Venmo/Zelle, CashApp, or check). A bare "click here to pay" link to an
// external portal (Stripe Checkout, QBO invoice link, generic "Pay Now"
// button) does NOT count — Market Street's AP team needs to push funds, not log in
// to a third-party portal.
//
// Returns { ok, ...fields }:
//   ok=false → AI unavailable / errored. Caller should fail open.
//   ok=true  → fields populated with whatever was readable on the document.
async function extractPaymentMethodFromInvoice(buffer, filename) {
  const prompt = `Examine this invoice for the payment instructions printed on the document. We need to identify how the vendor wants to be paid. Return ONLY valid JSON:
{
  "ach_routing_number": "the 9-digit US bank routing number printed, or null",
  "ach_account_number": "the bank account number printed, or null",
  "wire_swift_or_iban": "the SWIFT/BIC code or IBAN printed (for international wires), or null",
  "paypal_identifier": "the PayPal email address, paypal.me handle, or PayPal username printed (something the recipient can send money to directly), or null",
  "venmo_or_zelle": "the Venmo @username or Zelle email/phone printed, or null",
  "cashapp": "the $cashtag printed, or null",
  "check_payable_to": "name printed for check payment (e.g. 'Make checks payable to ___'), or null",
  "external_pay_link": "any URL or 'click to pay' / 'pay now' / 'view & pay invoice' button that opens an external payment portal where the recipient must log in or be redirected to pay (Stripe Checkout, Square, QuickBooks Online 'Pay Invoice' link, FreshBooks, Wave, Bill.com, generic Pay buttons, etc.), or null",
  "summary": "one short sentence describing the payment instructions shown"
}

DEFINITIONS:
- ACH: BOTH a 9-digit routing number AND an account number must be printed for ACH to count. Routing alone or account alone is not enough.
- PayPal: an actual PayPal email/handle the recipient can push money to (e.g. "PayPal: vendor@example.com" or "paypal.me/vendorname"). This is NOT the same as a paypal.com checkout link generated for this invoice — a checkout link is an external_pay_link.
- External pay link: any clickable URL or button that takes the recipient to a payment portal instead of giving them direct payment info. Phrases like "Pay Online", "Pay Invoice", "View and Pay", "Click here to pay", and links to invoice.stripe.com / quickbooks.intuit.com / squareup.com / bill.com / etc. all count as external_pay_link.

Banking instructions are usually printed in the footer, in a "Payment Details" / "Remit To" / "Wire Instructions" block, or as a sidebar. Read carefully — only return values you can actually see printed on the document. Return only JSON.`;

  const result = await callClaude({
    prompt,
    buffer,
    filename,
    maxTokens: 384,
    parseJson: true,
    cacheDocument: true,
  });
  if (!result.ok) {
    if (!result.disabled) console.warn('Payment-method extraction failed:', result.error);
    return { ok: false };
  }
  const d = result.data || {};
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    ok: true,
    ach_routing_number: str(d.ach_routing_number),
    ach_account_number: str(d.ach_account_number),
    wire_swift_or_iban: str(d.wire_swift_or_iban),
    paypal_identifier:  str(d.paypal_identifier),
    venmo_or_zelle:     str(d.venmo_or_zelle),
    cashapp:            str(d.cashapp),
    check_payable_to:   str(d.check_payable_to),
    external_pay_link:  str(d.external_pay_link),
    summary:            str(d.summary),
  };
}

// Verdict on whether the extracted info contains an acceptable direct-payment
// method. Bare external pay links (Stripe, QBO, "Pay Now" buttons) do NOT
// count — we explicitly want vendors to put their bank/PayPal on the document.
function evaluatePaymentMethod(info) {
  if (!info || !info.ok) return { ok: false };
  const hasAch          = !!(info.ach_routing_number && info.ach_account_number);
  const hasWire         = !!info.wire_swift_or_iban;
  const hasPaypal       = !!info.paypal_identifier;
  const hasVenmoOrZelle = !!info.venmo_or_zelle;
  const hasCashapp      = !!info.cashapp;
  const hasCheck        = !!info.check_payable_to;
  const acceptable = hasAch || hasWire || hasPaypal || hasVenmoOrZelle || hasCashapp || hasCheck;
  return {
    ok: true,
    acceptable,
    onlyExternalLink: !acceptable && !!info.external_pay_link,
    hasAch, hasWire, hasPaypal, hasVenmoOrZelle, hasCashapp, hasCheck,
  };
}

// Vendor-facing message when no acceptable payment method is on the invoice.
function paymentMethodErrorMessage(verdict) {
  if (verdict.onlyExternalLink) {
    return 'Your invoice only includes a "pay" link, which we cannot accept. Please add your bank account + routing number, or your PayPal email / handle, directly on the invoice and re-upload.';
  }
  return 'Your invoice is missing payment instructions. Please add your bank account + routing number, or your PayPal email / handle, directly on the invoice and re-upload.';
}

// Focused AI extraction of the invoice number printed on the document.
// Returns { ok, invoice_number }:
//   ok=false → AI unavailable / errored. Caller should fail open.
//   ok=true, invoice_number=null → confident: no invoice number on the document.
//   ok=true, invoice_number='X' → confident: this is the printed number.
async function extractInvoiceNumberFromDocument(buffer, filename) {
  const prompt = `Extract ONLY the invoice number printed on this invoice/receipt document. Return ONLY valid JSON:
{"invoice_number": "the exact invoice number string as printed, or null if no invoice number / receipt reference is shown"}

Rules:
- Only return a number that is clearly labelled as an invoice number, receipt number, or reference number on the document.
- Do NOT infer a number from dates, totals, account numbers, routing numbers, phone numbers, or order line counts.
- If no invoice/receipt number is shown, return null.
Return only JSON.`;

  const result = await callClaude({
    prompt,
    buffer,
    filename,
    maxTokens: 128,
    parseJson: true,
    cacheDocument: true,
  });
  if (!result.ok) {
    if (!result.disabled) console.warn('Invoice-number extraction failed:', result.error);
    return { ok: false, invoice_number: null };
  }

  const raw = result.data?.invoice_number;
  const num = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  return { ok: true, invoice_number: num };
}

// ── AI Document Validation ───────────────────────────────────────────────────

async function validateWithAI(fileBuffer, filename, prompt) {
  const result = await callClaude({
    prompt,
    buffer: fileBuffer,
    filename,
    maxTokens: 512,
    parseJson: true,
    // Same buffer is re-sent within the wizard (validate → parse → submit-time
    // scans), so the 5-min cache TTL pays for itself.
    cacheDocument: true,
  });
  if (!result.ok) return { valid: true, issues: [] };
  const parsed = result.data;

  // Normalize — Claude sometimes returns issues as a string or array of objects
  // instead of an array of strings. The frontend renders issues directly, so
  // non-string entries crash React ("Objects are not valid as a React child").
  const toStringIssue = (v) => {
    if (v == null) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
      // Pick a sensible field for objects like { problem, description, message, field }
      return v.issue || v.problem || v.description || v.message || v.field || JSON.stringify(v);
    }
    return String(v);
  };
  let issues = parsed.issues;
  if (typeof issues === 'string') issues = [issues];
  else if (!Array.isArray(issues)) issues = [];
  issues = issues.map(toStringIssue).filter(Boolean);

  return { ...parsed, issues, valid: parsed.valid !== false };
}

// POST /api/vendor/validate-invoice
router.post('/validate-invoice', aiValidationLimiter, singleUpload, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ valid: false, issues: ['No file uploaded'] });

    // Run the general validation and the focused payment-method extraction
    // in parallel. Two focused prompts produce more reliable JSON than one
    // mega-prompt, and the cached document means /submit's later focused
    // call is essentially free.
    const [result, payInfo] = await Promise.all([
      validateWithAI(req.file.buffer, req.file.originalname, `You are validating an invoice submitted to Market Street (a record label). Check this document and return ONLY valid JSON:
{
  "valid": true or false,
  "issues": ["list of problems found"],
  "is_invoice": true or false,
  "billed_to": "who it's billed to or null",
  "has_invoice_number": true or false,
  "has_date": true or false,
  "has_amount": true or false,
  "has_description": true or false
}

REQUIREMENTS — the document MUST:
1. Be an actual invoice or receipt (not bank instructions, a screenshot of a conversation, a random document, etc.)
2. Be billed/addressed to "Market Street", "Market Street", "Market Street", or similar
3. Include an invoice number or receipt reference
4. Include a date
5. Include a total amount
6. Include a description of services or items

If ANY requirement fails, set valid=false and list the specific issues. Be strict — reject anything that is not a proper invoice. Return only JSON.`),
      extractPaymentMethodFromInvoice(req.file.buffer, req.file.originalname),
    ]);

    // Fold payment-method verdict into the response. When AI confidently
    // returned no acceptable method, add a blocking issue and flip valid=false
    // so the existing UI surfaces it. When AI failed, payment_methods is null
    // and the server's /submit gate becomes the only check (fail-open here).
    const verdict = evaluatePaymentMethod(payInfo);
    if (verdict.ok && !verdict.acceptable) {
      result.issues = [paymentMethodErrorMessage(verdict), ...(Array.isArray(result.issues) ? result.issues : [])];
      result.valid = false;
    }
    result.payment_methods = verdict.ok
      ? {
          acceptable: verdict.acceptable,
          only_external_link: verdict.onlyExternalLink,
          message: verdict.acceptable ? null : paymentMethodErrorMessage(verdict),
          has_ach: verdict.hasAch,
          has_wire: verdict.hasWire,
          has_paypal: verdict.hasPaypal,
          has_venmo_or_zelle: verdict.hasVenmoOrZelle,
          has_cashapp: verdict.hasCashapp,
          has_check: verdict.hasCheck,
        }
      : null;

    res.json(result);
  } catch (err) {
    console.error('Invoice validation error:', err.message);
    res.json({ valid: true, issues: [] }); // fail open
  }
});

// POST /api/vendor/validate-w9
router.post('/validate-w9', aiValidationLimiter, singleUpload, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ valid: false, issues: ['No file uploaded'] });

    // Anchor "today" for the AI. Without this, the model uses its training
    // cutoff as "now" and flags real-past dates (e.g. 5/15/2026 when today
    // is 6/16/2026) as future. Pass both ISO and human formats so the
    // model can compare against whatever date format is on the W9.
    const nowDate = new Date();
    const todayISO = nowDate.toISOString().slice(0, 10);
    const todayHuman = nowDate.toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    });

    const result = await validateWithAI(req.file.buffer, req.file.originalname, `You are validating a W-9 or W-8 tax form submitted to Market Street.

TODAY'S DATE IS ${todayHuman} (ISO: ${todayISO}). Treat this as authoritative — do NOT use your own internal notion of "today." A signing date is only in the future if it is strictly AFTER ${todayISO}. Any date on or before ${todayISO} is in the past or present and is VALID.

Check this document and return ONLY valid JSON:
{
  "valid": true or false,
  "issues": ["list of actual problems found — only real problems, not nitpicks"],
  "form_type": "W-9" or "W-8BEN" or "W-8BEN-E" or "unknown",
  "has_name": true or false,
  "has_address": true or false,
  "has_tin": true or false,
  "is_signed": true or false,
  "is_dated": true or false,
  "form_date": "YYYY-MM-DD or null — the signing date written on the form, normalized to ISO"
}

REQUIREMENTS — the document MUST:
1. Be an actual W-9 or W-8 form (IRS tax form). W-8BEN, W-8BEN-E, and W-9 are all acceptable.
2. Have the name filled in (line 1)
3. Have an address filled in
4. Have a tax identification number:
   - For W-9: TIN/SSN/EIN on line 1 or 2 (at least partially visible or redacted is OK)
   - For W-8BEN/W-8BEN-E: EITHER a U.S. TIN (line 5) OR a foreign TIN (line 6a) is sufficient. A foreign TIN alone is perfectly valid.
5. Be SIGNED (there must be a signature in the certification section)
6. Be DATED (there must be a date near the signature). Any date on or before ${todayISO} is valid. Only flag the date as a "future date" if it is strictly AFTER ${todayISO}.

IMPORTANT — do NOT flag these as issues:
- Part II (Tax Treaty Benefits) being blank — this section is OPTIONAL
- Missing U.S. TIN when a foreign TIN is provided on a W-8 form
- Any signing date on or before ${todayISO} — these are in the past or present and are valid
- Optional fields being left blank
- Age of the beneficial owner or date of birth — do NOT check age or flag minors

Only flag genuine problems that would make the form legally invalid. Return only JSON.`);

    // Belt-and-suspenders: even with today's date in the prompt, the model
    // can mis-classify. If it extracted a form_date that is actually on or
    // before today, strip any "future date" issues it added in spite of the
    // instructions, and flip valid back to true if that was the only issue.
    const formDateRaw = typeof result.form_date === 'string' ? result.form_date.trim() : '';
    const formDateIsIso = /^\d{4}-\d{2}-\d{2}$/.test(formDateRaw);
    const formDateNotFuture = formDateIsIso && formDateRaw <= todayISO;
    if (formDateNotFuture && Array.isArray(result.issues) && result.issues.length) {
      const filtered = result.issues.filter(i => !/future/i.test(String(i)));
      if (filtered.length !== result.issues.length) {
        result.issues = filtered;
        if (filtered.length === 0) result.valid = true;
      }
    }

    res.json(result);
  } catch (err) {
    console.error('W9 validation error:', err.message);
    res.json({ valid: true, issues: [] }); // fail open
  }
});

// POST /api/vendor/parse-invoice — public AI parse for the vendor-submit form
// Mirrors /api/bk/parse but with no auth (the dashboard route is admin-only).
router.post('/parse-invoice', aiValidationLimiter, singleUpload, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, data: {} });

    // Load the signed-artist roster for both prompt-time context AND
    // post-parse validation. Vendor-side has no auth so keep the query
    // cheap and cap at 250 names. Ordered longest-first so the roster
    // pre-context shows the label's biggest / most-recognized names.
    const rosterRows = await pool.query(
      `SELECT name FROM artists WHERE archived IS NOT TRUE ORDER BY LENGTH(name) DESC LIMIT 250`
    ).catch(() => ({ rows: [] }));
    const roster = rosterRows.rows.map(r => r.name).filter(Boolean);
    const rosterLower = new Set(roster.map(n => n.toLowerCase().trim()));

    // The LIVE category list, most-used first. Loaded here beside the roster so
    // there is no extra round trip, and degrading to the seed constant on failure
    // rather than letting a ranking refinement break invoice parsing.
    const vocab = await categoryVocabulary(pool, 'expense');

    const prompt = `You are extracting invoice/receipt data. Analyze this document and return ONLY valid JSON with these fields:
{
  "invoice_date": "YYYY-MM-DD or null",
  "payee": "vendor/company name or null",
  "amount": number (no currency symbols, 2 decimal places) or null,
  "invoice_number": "string or null",
  "category": one of the categories listed under CATEGORY below, or null,
  "artist": "the LABEL'S artist the invoice is FOR — must be a proper name from the roster below when possible, NEVER a social-media handle. null if absent.",
  "song": "specific song/track being promoted, NOT the artist name. null if absent.",
  "description": "brief description of what was purchased or null",
  "currency": "3-letter ISO code, default USD"
}

CATEGORY — the label's own vocabulary, most-used first:
${vocab.prompt}

Choose from that list ONLY. Prefer a category the label uses often over a rarely
used one when both could fit — the usage counts above are real, and a category
with 1,200 rows behind it is far more likely to be right than one with 1.

The "Artist Expense - …" categories are for work done FOR A NAMED ARTIST and take
precedence over their plain equivalents whenever the invoice names one:
  · recording, mixing, mastering, studio time, engineering, a beat or production
    work for an artist  →  "Artist Expense - Recording"
    NOT "Mixing & Mastering", NOT "Production", NOT "Recording"
  · legal work about an artist   →  "Artist Expense - Legal"
  · PR or press for an artist    →  "Artist Expense - PR"
The plain categories ("Mixing & Mastering", "Production", "Legal", "PR") are for
LABEL-level spend with no artist attached.

CRITICAL RULES — this is a music-label bookkeeping system, and the single most common mistake is confusing the vendor's SOCIAL HANDLE with the ARTIST field. Follow these rules exactly:

1. Social media handles (with or without @, e.g. "@crazyauntieann", "crazy_annie", "kennyslowbird") are NEVER the artist. They identify the VENDOR (creator/influencer). They belong in the description or an unused field — NEVER the artist field.

2. On an influencer / marketing invoice with phrasing like "services for @handle — Artist Name — Song Title" or "promo by @handle for Artist / Song", the mapping is:
   - artist = the proper artist name (e.g. "Nobody Serious"), NOT the @handle
   - song = the track (e.g. "No Sir")
   - description mentions the handle
   Example — invoice text: "Social media services for @crazyauntieann - EDM Only // Nobody Serious - No Sir"
     WRONG:   { "artist": "crazyauntieann", "song": "Nobody Serious - No Sir" }
     CORRECT: { "artist": "Nobody Serious", "song": "No Sir", "description": "Social media/influencer promotion via @crazyauntieann" }

3. If a name in the document matches the label's signed-artists roster (below), STRONGLY prefer it for the artist field over anything that looks handle-shaped.

4. Song titles do not contain artist names. If your candidate song field starts with a proper name that matches the roster, that name is the artist — extract the actual track title separately (often after a dash or slash), and if there's no separate track title leave song null.

Signed artists on this label (partial roster; case-insensitive matching):
${roster.length ? roster.slice(0, 60).map(a => `- ${a}`).join('\n') : '(no roster available)'}

IMPORTANT: A document IS attached and you CAN read it. Read every visible field carefully and extract what you can — even if the scan is imperfect, low resolution, or photographed at an angle, do your best to OCR. Most invoices have at least a payee name, an amount, and a date — find them. Only leave a field null if that specific field is genuinely absent or unreadable, NOT because the whole document seems hard. Return only the JSON object, no explanation.`;

    const result = await callClaude({
      prompt,
      buffer: req.file.buffer,
      filename: req.file.originalname,
      maxTokens: 512,
      parseJson: true,
      cacheDocument: true,
    });

    // Post-parse fixup — catches the classic influencer-invoice swap
    // even when the prompt fails to prevent it (handle in artist,
    // artist in song). Also extracts any @handles from the description
    // so the client's socials step can prefill them.
    const ai_warnings = [];
    let suggest_socials = [];
    if (result.ok && result.data) {
      const d = result.data;
      const looksLikeHandle = (s) => {
        const t = String(s || '').trim();
        if (!t) return false;
        if (t.startsWith('@')) return true;
        return /^[a-z0-9._]{3,30}$/.test(t) && /[._]/.test(t);
      };
      const norm = (s) => String(s || '').toLowerCase().trim();

      const artistLooksHandle = looksLikeHandle(d.artist);
      const rawSong = String(d.song || '').trim();
      const splitMatch = rawSong.match(/^\s*([^-–—/]+?)\s*[-–—/]\s*(.+)\s*$/);
      const songLeftIsRoster = splitMatch && rosterLower.has(norm(splitMatch[1]));
      const songWholeIsRoster = rosterLower.has(norm(rawSong));

      if (artistLooksHandle && (songLeftIsRoster || songWholeIsRoster)) {
        const stashedHandle = String(d.artist || '').replace(/^@/, '');
        if (songLeftIsRoster) {
          d.artist = splitMatch[1].trim();
          d.song   = splitMatch[2].trim();
        } else {
          d.artist = rawSong;
          d.song   = null;
        }
        if (stashedHandle) {
          suggest_socials.push({ platform: 'Instagram', handle: stashedHandle });
        }
        ai_warnings.push(
          `The scan initially misread a social-media handle as the artist. ` +
          `Fixed automatically — please verify the Artist / Song fields.`
        );
      } else if (artistLooksHandle) {
        ai_warnings.push(
          `Artist field looks like a social-media handle. Double-check that ` +
          `it's the artist being promoted, not the vendor's own handle.`
        );
      }

      // Pull any @handles out of the description for the socials step.
      const descHandles = String(d.description || '').match(/@[A-Za-z0-9._]{3,30}/g) || [];
      for (const raw of descHandles) {
        const h = raw.replace(/^@/, '');
        if (!suggest_socials.some(s => s.handle === h)) {
          suggest_socials.push({ platform: 'Instagram', handle: h });
        }
      }
    }

    res.json({
      success: true,
      data: result.ok ? result.data : {},
      ai_warnings,
      suggest_socials,
    });
  } catch (err) {
    console.error('POST /api/vendor/parse-invoice:', err.message);
    res.json({ success: true, data: {} }); // fail open
  }
});

// GET /api/vendor/roster
// Returns the full Market Street roster (artist names only) so the vendor submit
// form can render a type-to-filter picker. Public — no auth, no ids or
// contract data exposed. Ordered case-insensitively so "aXbY" sorts next
// to "AXBY". 5-minute browser cache: roster changes rarely and every
// submission form load would otherwise hit this.
router.get('/roster', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT name FROM artists WHERE name IS NOT NULL AND TRIM(name) <> '' ORDER BY LOWER(name)`
    );
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ artists: rows.map(r => r.name) });
  } catch (err) {
    console.error('GET /api/vendor/roster:', err.message);
    res.json({ artists: [] });
  }
});

// ── "Do we already hold this vendor's W9?" — ONE definition ─────────────────
//
// Three places ask this and they must give the same answer: the form's green
// "W9 on file — no need to resubmit" badge (/lookup), the legacy /check-w9, and
// the gate inside POST /submit that refuses a submission without one.
//
// They used to disagree, and the disagreement was a dead end rather than an
// inconvenience. The badge resolved aliases in BOTH directions; the submit gate
// resolved them one way only:
//
//     SELECT va.primary_name FROM vendor_aliases
//      WHERE LOWER(va.alias) = LOWER($1) OR LOWER(va.primary_name) = LOWER($1)
//
// Given a PRIMARY name that query matches on its own primary_name side and hands
// back the name it was passed, so the follow-up lookup was a verbatim repeat of
// the direct check that had already failed — a primary name's aliases were never
// searched. A vendor whose W9 is filed under "Foreign Exchange Records" and who
// submits as "Chase Mann" was shown the badge, advanced past the W9 step (which
// is what the badge unlocks), and then refused with "Please upload your W9 or W8
// form" — on a page that renders no W9 upload field at all while the badge is
// showing. The submission could not be completed by any route, and the 400 is
// not recorded anywhere, so nobody at Market Street learned it had been attempted.
//
// Two smaller divergences rode along: the gate matched LOWER(payee) where the
// badge matched LOWER(TRIM(payee)), and the gate required w9_filename to be
// non-null where the badge (and Approvals) only require the file itself.
//
// DELIBERATELY not filtered on status. A W9 sitting on a rejected invoice is
// still a W9 we hold, and adding the filter here would refuse submissions the
// badge had already promised — the same failure in a new place.

// The vendor's name plus every alias of it, both directions, lower-cased and
// trimmed. Returned rather than inlined so /lookup can reuse it for the contact
// prefill instead of resolving aliases twice.
async function vendorNameGroup(name) {
  const base = String(name || '').trim().toLowerCase();
  if (!base) return [];
  const { rows } = await pool.query(
    `SELECT LOWER(TRIM(va.primary_name)) AS n FROM vendor_aliases va
      WHERE LOWER(TRIM(va.alias)) = LOWER(TRIM($1))
     UNION
     SELECT LOWER(TRIM(va.alias)) AS n FROM vendor_aliases va
      WHERE LOWER(TRIM(va.primary_name)) = LOWER(TRIM($1))`,
    [base]
  );
  return [...new Set([base, ...rows.map((r) => r.n)])];
}

// Matches on payee OR vendor_name. Vendor submissions write the same string to
// both, but invoices added internally often fill only one, and a W9 attached to
// one of those still covers this vendor.
async function vendorHasW9OnFile(name, group = null) {
  const names = group || await vendorNameGroup(name);
  if (!names.length) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM expenses e
      WHERE (LOWER(TRIM(e.payee)) = ANY($1::text[])
             OR LOWER(TRIM(e.vendor_name)) = ANY($1::text[]))
        AND ${HAS_W9_SQL('e')}
        AND (e.deleted = false OR e.deleted IS NULL)
      LIMIT 1`,
    [names]
  );
  return rows.length > 0;
}

// GET /api/vendor/lookup?name=...&email=...
// W9 status for the given vendor name, plus contact prefill (address /
// bank / payment preference) — but the prefill is ONLY returned when the
// caller also supplies the email already on file for that vendor. This is
// an unauthenticated endpoint; without the email-as-shared-secret gate,
// anyone could harvest vendors' mailing addresses and bank names just by
// guessing names. The email itself is never echoed back.
// Walks vendor_aliases in both directions and falls back to vendor_name matches.
router.get('/lookup', async (req, res) => {
  const name = (req.query.name || '').trim();
  const callerEmail = (req.query.email || '').trim().toLowerCase();
  if (!name) return res.json({ on_file: false });
  try {
    // Build the set of names to search — this name + any aliases (either direction)
    const names = await vendorNameGroup(name);

    // W9 status comes from the shared resolver, NOT from the 50-row window
    // below. Two reasons: the submit gate calls the same function, so the badge
    // and the gate cannot disagree; and the window is ordered by id DESC, so a
    // vendor with more than 50 invoices whose W9 sits on an early one was told
    // we did not have it.
    const hasW9 = await vendorHasW9OnFile(name, names);

    // Pull recent entries for any name in the group, most recent first.
    // Scan in order and keep the first non-null value for each contact field.
    const { rows } = await pool.query(
      `SELECT vendor_email, vendor_address, vendor_bank, payment_method
       FROM expenses
       WHERE (LOWER(TRIM(payee)) = ANY($1::text[])
              OR LOWER(TRIM(vendor_name)) = ANY($1::text[]))
         AND (deleted = false OR deleted IS NULL)
       ORDER BY id DESC
       LIMIT 50`,
      [names]
    );

    let address = null, bank = null, paymentMethod = null;
    let emailMatch = false;
    for (const r of rows) {
      if (!address && r.vendor_address) address = r.vendor_address;
      if (!bank && r.vendor_bank) bank = r.vendor_bank;
      if (!paymentMethod && r.payment_method) paymentMethod = r.payment_method;
      if (callerEmail && (r.vendor_email || '').trim().toLowerCase() === callerEmail) emailMatch = true;
    }

    // W9 status alone is fine to answer by name — the form needs it before
    // the vendor has typed anything else, and it gates a REQUIRED upload.
    if (!emailMatch) return res.json({ on_file: hasW9 });

    // Only return a payment preference the vendor-submit dropdown supports
    const allowedPrefs = new Set(['ACH', 'Wire', 'PayPal']);
    const payment_preference = allowedPrefs.has(paymentMethod) ? paymentMethod : null;

    res.json({ on_file: hasW9, address, bank, payment_preference });
  } catch {
    res.json({ on_file: false });
  }
});

// GET /api/vendor/check-w9?name=...  — legacy endpoint, kept for back-compat
router.get('/check-w9', async (req, res) => {
  const name = (req.query.name || '').trim();
  if (!name) return res.json({ on_file: false });
  try {
    res.json({ on_file: await vendorHasW9OnFile(name) });
  } catch {
    res.json({ on_file: false });
  }
});

// GET /api/vendor/check-dup?email=...&vendor_name=...&invoice_number=...
// Triggers the inline "you already submitted this" warning on the vendor
// submit form. Compares NORMALIZED invoice numbers so "#003" and "003" and
// "INV-3" all collide — otherwise the server-side POST gate fires later as
// a 409 and the vendor has no clue why their submission was rejected.
//
// Matches against EITHER vendor_email OR payee/vendor_name so an invoice
// already on file under the same vendor name (e.g. added internally via
// BkAddInvoice with no email captured) still blocks the vendor's later
// submission. Without the name-side check, a vendor could effectively
// double-submit an already-recorded invoice if its prior entry came in
// through a non-portal path.
// GET /api/vendor/payment-on-file?email=…
//
// Do we already hold this vendor's payment details? Public, like /check-w9 and
// /lookup beside it, and it CONFIRMS without DISCLOSING: method, last four,
// and the name on the account — never a decrypted value. An unauthenticated
// endpoint that returns an account number is an account number anyone can
// enumerate, so this one is written to be safe when it is guessed at.
//
// Matched on the EMAIL, exactly. The rest of the app resolves a vendor through
// names and aliases, which is right for grouping invoices and wrong here: a name
// collision would show one vendor a different vendor's bank details.
router.get('/payment-on-file', async (req, res) => {
  const email = String(req.query.email || '').trim();
  if (!email || !isValidEmail(email)) return res.json({ on_file: false });
  try {
    const { rows } = await pool.query(
      `SELECT method, account_last4, holder_name, updated_at
         FROM vendor_payment_details WHERE LOWER(vendor_email) = LOWER($1)`, [email]);
    const r = rows[0];
    if (!r) return res.json({ on_file: false });
    return res.json({
      on_file: true,
      method: r.method,
      last4: r.account_last4,
      holder_name: r.holder_name,
      updated_at: r.updated_at,
    });
  } catch (err) {
    // Degrade to "nothing on file" — the vendor is then asked to type their
    // details, which is the correct outcome when we cannot tell.
    console.error('GET /api/vendor/payment-on-file:', err.message);
    return res.json({ on_file: false });
  }
});

router.get('/check-dup', async (req, res) => {
  const email = (req.query.email || '').trim();
  const vendorName = (req.query.vendor_name || '').trim();
  const num   = (req.query.invoice_number || '').trim();
  if (!num || (!email && !vendorName)) return res.json({ duplicate: false });
  try {
    const normalizedInput = normalizeInvoiceNum(num);
    const params = [];
    const conds = [];
    if (email) {
      params.push(email);
      conds.push(`LOWER(vendor_email) = LOWER($${params.length})`);
    }
    if (vendorName) {
      params.push(vendorName);
      conds.push(`LOWER(TRIM(vendor_name)) = LOWER(TRIM($${params.length}))`);
      conds.push(`LOWER(TRIM(payee)) = LOWER(TRIM($${params.length}))`);
    }
    const { rows } = await pool.query(
      `SELECT id, invoice_number FROM expenses
        WHERE (${conds.join(' OR ')})
          AND invoice_number IS NOT NULL AND invoice_number != ''
          AND (deleted=false OR deleted IS NULL)
          AND status != 'rejected'`,
      params
    );
    const dup = rows.some(r => normalizeInvoiceNum(r.invoice_number) === normalizedInput);
    res.json({ duplicate: dup });
  } catch {
    res.json({ duplicate: false });
  }
});

// GET /api/vendor/check-similar — soft double-entry guard: same vendor
// (email or name — same shared-secret posture as /check-dup), same
// amount + currency, within the last 30 days, not rejected. The
// invoice-number check above catches exact resubmits; this catches the
// near-duplicates that carry a different (or no) invoice number.
// Returns at most one minimal match; the client shows a NON-blocking
// warning.
router.get('/check-similar', async (req, res) => {
  const email = (req.query.email || '').trim();
  const vendorName = (req.query.vendor_name || '').trim();
  const amount = parseFloat(req.query.amount);
  const currency = (req.query.currency || 'USD').trim().toUpperCase().slice(0, 6);
  if (!Number.isFinite(amount) || amount <= 0 || (!email && !vendorName)) return res.json({ similar: null });
  try {
    const params = [];
    const conds = [];
    if (email) {
      params.push(email);
      conds.push(`LOWER(vendor_email) = LOWER($${params.length})`);
    }
    if (vendorName) {
      params.push(vendorName);
      conds.push(`LOWER(TRIM(vendor_name)) = LOWER(TRIM($${params.length}))`);
      conds.push(`LOWER(TRIM(payee)) = LOWER(TRIM($${params.length}))`);
    }
    params.push(amount);
    const amtIdx = params.length;
    params.push(currency);
    const curIdx = params.length;
    const { rows } = await pool.query(
      `SELECT invoice_number, amount, currency,
              COALESCE(invoice_date, created_at::date) AS date
         FROM expenses
        WHERE (${conds.join(' OR ')})
          AND amount = $${amtIdx}
          AND UPPER(COALESCE(currency, 'USD')) = $${curIdx}
          AND (deleted = false OR deleted IS NULL)
          AND status != 'rejected'
          AND created_at >= NOW() - INTERVAL '30 days'
        ORDER BY id DESC
        LIMIT 1`,
      params
    );
    res.json({ similar: rows[0] || null });
  } catch {
    res.json({ similar: null });
  }
});

// POST /api/vendor/submit
/**
 * The `expenses` row one invoice becomes.
 *
 * ONE definition, read by two callers that must never disagree: the INSERT, and
 * the `?sandbox=1` dry run that exists to show what the INSERT would do. They
 * were two hand-written field lists, and that is exactly the arrangement where a
 * batch can report three correct invoices in the sandbox while writing the first
 * one three times — verified by breaking the INSERT's indexing and watching
 * every sandbox assertion stay green.
 *
 * Returns named fields rather than a positional array so the INSERT's parameter
 * list still reads against its own column list.
 */
function expenseRowFor(ctx, inv) {
  return {
    payee: ctx.vendorName,
    vendor_email: ctx.vendorEmail,
    vendor_address: ctx.vendorAddress,
    vendor_bank: ctx.vendorBank,
    artist: inv.artist,
    song: inv.song,
    category: inv.category,
    invoice_number: inv.invoice_number,
    amount: inv.amount,
    currency: inv.currency,
    payment_method: ctx.paymentPref,
    description: inv.description,
    notes: inv.notes,
    boom_rep: inv.boom_rep,
    is_reimbursement: ctx.isReimb,
    off_roster_artist: inv.off_roster,
    payment_last4: inv.payment_check.typed_last4,
  };
}

/** A breakdown arrives as JSON text on the legacy shape and as an array inside `invoices`. */
function parseBreakdown(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : null; } catch { return null; }
  }
  return null;
}

/**
 * The submission's invoices, normalized to a list of one or more.
 *
 * ── The legacy shape IS invoice 1 ──
 * With no `invoices` field this returns exactly one invoice built from the flat
 * top-level body, carrying `file`, `file_extra` and `receipt_file`. That path
 * has to stay byte-for-byte what it was: it is what every live vendor's open tab
 * posts, what `vendor-required-fixture.cjs` asserts 74 things about, and what
 * `/admin/vendor-lab` sent until today.
 *
 * Returns `{ invoices, error }`. `error` is set for a body that is malformed
 * rather than merely incomplete — too many invoices, or an `invoices` field that
 * is not a list — because those are not something a vendor can fix by filling a
 * field in, and reporting them as a missing-field error would send them looking
 * for one.
 */
async function collectInvoices(req) {
  const b = req.body;
  const files = req.files || {};

  let raw = null;
  if (b.invoices != null) {
    try { raw = JSON.parse(b.invoices); } catch { raw = null; }
    if (!Array.isArray(raw)) {
      return { invoices: [], error: 'We could not read the list of invoices. Please try again.' };
    }
    if (!raw.length) {
      return { invoices: [], error: 'Please add at least one invoice.' };
    }
    // Refused, never truncated. Silently dropping invoices 11 and 12 would show
    // the vendor a success page for a submission that lost two of their bills.
    if (raw.length > INVOICE_MAX) {
      return { invoices: [], error:
        `You can send up to ${INVOICE_MAX} invoices at a time — you attached ${raw.length}. `
        + 'Please split them across two submissions.' };
    }
  }

  const legacy = raw == null;
  if (legacy) {
    raw = [{
      invoice_number: b.invoice_number_hint, amount: b.amount, currency: b.currency,
      category: b.category, boom_rep: b.boom_rep, artist: b.artist, song: b.song,
      description: b.description, notes: b.notes,
      artist_breakdown: b.artist_breakdown, off_roster_artist: b.off_roster_artist,
    }];
  }

  const invoices = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] || {};
    const artistRaw = String(r.artist || '').trim();
    invoices.push({
      index: i,
      // What an error message calls this invoice. One invoice has no number to
      // refer to — it is "the invoice" — and prefixing its errors would change
      // the wording every existing vendor and both fixtures see.
      label: raw.length > 1 ? `Invoice ${i + 1}` : null,
      invoice_number: String(r.invoice_number ?? '').trim(),
      // Collapse multi-artist strings ("Ezra feat. Kendrick") to their registered
      // base artist when one exists, so approvals + downstream pages don't grow
      // spurious buckets. See lib/artist-normalization.
      artist_raw: artistRaw,
      artist: await applyArtistNormalization(artistRaw),
      song: String(r.song || '').trim(),
      category: String(r.category || '').trim(),
      boom_rep: String(r.boom_rep || '').trim() || null,
      currency: String(r.currency || 'USD').trim() || 'USD',
      amount: parseFloat(r.amount) || null,
      description: String(r.description || '').trim(),
      notes: String(r.notes || '').trim(),
      breakdown: parseBreakdown(r.artist_breakdown),
      client_off_roster: String(r.off_roster_artist || '').toLowerCase() === 'true',
      file: files[`invoice_file_${i}`]?.[0] || (legacy ? files.file?.[0] : null) || null,
      extras: files[`invoice_extra_${i}`] || (legacy ? (files.file_extra || []) : []),
      receipt: files[`invoice_receipt_${i}`]?.[0] || (legacy ? files.receipt_file?.[0] : null) || null,
    });
  }
  return { invoices, error: null };
}

router.post('/submit', sandboxAuth, fileFieldsSafe, async (req, res) => {
  const b = req.body;

  const vendorName     = (b.vendor_name || '').trim();
  const vendorEmail    = (b.vendor_email || '').trim();
  const vendorAddress  = (b.vendor_address || '').trim();
  // Bank name now arrives as part of the payment block (payment_bank_name). The
  // legacy top-level field is still accepted so an older client or a script that
  // posts the previous shape keeps populating the column it always populated.
  const vendorBank     = (b.payment_bank_name || b.vendor_bank || '').trim();
  const paymentPref    = (b.payment_preference || '').trim();
  const isReimb        = b.is_reimbursement === 'yes';

  // ── What is shared, and what repeats ──────────────────────────────────────
  // Everything above this line describes the VENDOR and is collected once: who
  // they are, how to reach them, how to pay them, their W9. Everything an
  // INVOICE is — its document, number, amount, currency, category, artist rows,
  // rep, description — repeats, and lives in `invoices` below.
  //
  // `is_reimbursement` is shared on purpose: it is the mode the form is in, not
  // a property of one document. Each invoice still carries its own receipt.
  const { invoices, error: invoicesError } = await collectInvoices(req);
  if (invoicesError) return res.status(400).json({ error: invoicesError });
  const multi = invoices.length > 1;
  // Optional: array of {platform, handle} pairs supplied on step 3 of the form
  let socialHandles = null;
  if (b.social_handles) {
    try {
      const parsed = JSON.parse(b.social_handles);
      socialHandles = normalizeSocialRows(parsed);
    } catch {}
  }
  // Optional: extra email addresses (step 1). Saved to vendor_emails so they
  // default into CC on payment confirmations. Strictly validated — this is a
  // public endpoint: strings only, valid format, deduped, main email
  // excluded, hard cap of 4.
  let additionalEmails = [];
  if (b.additional_emails) {
    try {
      const parsed = JSON.parse(b.additional_emails);
      if (Array.isArray(parsed)) {
        const seen = new Set([vendorEmail.toLowerCase()]);
        additionalEmails = parsed
          .filter(e => typeof e === 'string')
          .map(e => e.trim())
          .filter(e => e && e.length <= 254 && isValidEmail(e) && !seen.has(e.toLowerCase()) && seen.add(e.toLowerCase()))
          .slice(0, 4);
      }
    } catch {}
  }

  // Basic validation
  const errors = [];
  if (!vendorName)    errors.push('Please enter your legal / government name.');
  if (!vendorEmail)   errors.push('Please enter your email address.');
  else if (!isValidEmail(vendorEmail)) errors.push('Please enter a valid email address (e.g. you@example.com).');
  // ── No separate "mailing address" and no standalone "bank name" ───────────
  // Both used to be required top-level fields. They are not any more, and the
  // reasons differ:
  //
  //   bank name     MOVED into the payment block, where it is required for ACH
  //                 and Wire and absent for PayPal. As a top-level field it was
  //                 required of PayPal vendors too, who do not have one to give —
  //                 a required field with no correct answer teaches people to
  //                 type anything, which is how you get "n/a" in a bank column.
  //                 `vendor_bank` is still written, now from payment_bank_name.
  //
  //   mailing addr  OPTIONAL, not gone. It was dropped entirely earlier on
  //                 2026-08-31 to stop asking for two addresses, and was back as
  //                 an optional field the same day: a 1099-NEC needs the
  //                 RECIPIENT's address, and a bank address is the bank's. Still
  //                 not required, because it is not needed to PAY anyone — only
  //                 to file at year end, so it must never block a submission.
  //                 `vendor_address` is read by full-export.js, the vendors
  //                 roster's MAX(vendor_address) and the returning-vendor
  //                 pre-fill. Do NOT alias a bank address into it.
  if (!paymentPref)   errors.push('Please select your preferred payment method.');

  // ── Rules the BROWSER already enforced, now enforced here too ──────────────
  // VendorSubmit.jsx checks each of these before it will submit. None of them
  // were checked on the server, which makes them requests rather than rules:
  // anything not going through that exact client — a stale tab, /admin/vendor-lab,
  // a direct POST — wrote rows without them. Live evidence: 11 rows with no song
  // (3.1%) and 35 with no socials (9.9%). Same lesson the W9 gate already carries.
  //
  // Wording is copied from the client deliberately, so a vendor is never shown
  // two different sentences for one problem.
  // ── Per invoice ───────────────────────────────────────────────────────────
  // Collected against the invoice they belong to, so a batch of five reports
  // "Invoice 3 — please enter the invoice amount" rather than five identical
  // sentences with no way to tell which card is wrong.
  //
  // With ONE invoice the label is null and the message is the exact string this
  // endpoint has always returned. 190 vendors read these sentences and
  // `vendor-required-fixture.cjs` asserts their wording; a batch feature is not
  // a reason to reword the single-invoice path.
  const invoiceErrors = invoices.map(() => []);
  invoices.forEach((inv, i) => {
    const bad = (m) => invoiceErrors[i].push(m);
    if (!inv.file)          bad('Please upload your invoice file.');
    if (!inv.invoice_number) bad('Please enter your invoice number.');
    if (!inv.artist)        bad('Please enter the artist or project name.');
    if (!inv.category)      bad('Please select a category.');
    if (!inv.boom_rep)      bad('Please select your Market Street Rep.');
    if (!inv.amount || inv.amount <= 0) bad('Please enter the invoice amount.');
    if (!inv.song)          bad('Please enter a song / track for every artist row.');
    // Every row that names an artist must also name a song. The breakdown is the
    // multi-artist case; the primary pair above covers the single-row one.
    if (Array.isArray(inv.breakdown)) {
      const named = inv.breakdown.filter((r) => r && String(r.artist || '').trim());
      if (inv.breakdown.length && !named.length) bad('Please enter at least one artist or project.');
      if (named.some((r) => !String(r.song || '').trim())) {
        bad('Please enter a song / track for every artist row.');
      }
    }
    if (isReimb && !inv.receipt) bad('Please attach your supporting receipt.');
  });

  // Two invoices cannot carry the same number — that is one bill sent twice, and
  // it is the one duplicate test that can be made INSIDE a submission without
  // the false positives that got the cross-submission check removed. There is no
  // history involved and no normalizing away of leading zeros: it compares what
  // the vendor typed on two cards in front of them.
  {
    const seen = new Map();
    invoices.forEach((inv, i) => {
      const k = inv.invoice_number.toLowerCase();
      if (!k) return;
      if (seen.has(k)) {
        invoiceErrors[i].push(
          `Invoice number "${inv.invoice_number}" is already on invoice ${seen.get(k) + 1} `
          + 'of this submission. Please give each invoice its own number.');
      } else seen.set(k, i);
    });
  }
  // A social handle, or the literal "N/A" from a vendor who has none. An explicit
  // answer either way beats a blank field somebody has to chase.
  if (!Array.isArray(socialHandles) || !socialHandles.some((r) => String(r?.handle || '').trim())) {
    errors.push('Please add at least one social media handle, or type "N/A" if you don\'t use social media.');
  }

  // ── Payment coordinates ────────────────────────────────────────────────────
  // How we actually pay them. Until now the form collected a preference and a
  // bank NAME, and the real details lived only inside the PDF — which is why an
  // invoice that did not print them was refused outright. Now they are fields,
  // and the document is corroboration rather than the only copy.
  //
  // A returning vendor who confirmed the details we already hold sends nothing
  // here — the stored record IS the answer, and re-typing an account number to
  // prove you still bank where you banked is friction with no payoff. Anything
  // typed always wins over the stored copy, so this is a fallback, never an
  // override.
  let payFields = validatePaymentFields(paymentPref, b);
  let reusedOnFile = false;
  if (!payFields.ok && String(b.payment_reuse_on_file || '') === 'true') {
    try {
      const { rows } = await pool.query(
        `SELECT method, account_enc, routing_enc, iban_enc, paypal_handle, holder_name,
                bank_address, account_type, bank_name, beneficiary_address, intermediary_bank,
                wire_scope
           FROM vendor_payment_details WHERE LOWER(vendor_email) = LOWER($1)`, [vendorEmail]);
      const r = rows[0];
      if (r && r.method === paymentPref) {
        payFields = {
          ok: true, errors: [],
          normalized: {
            account_number: paymentCrypto.decrypt(r.account_enc) || '',
            routing_number: paymentCrypto.decrypt(r.routing_enc) || '',
            iban_swift: paymentCrypto.decrypt(r.iban_enc) || '',
            paypal: r.paypal_handle || '',
            holder_name: r.holder_name || '',
            bank_address: r.bank_address || '',
            account_type: r.account_type || '',
            bank_name: r.bank_name || '',
            beneficiary_address: r.beneficiary_address || '',
            intermediary_bank: r.intermediary_bank || '',
            wire_scope: r.wire_scope || '',
          },
        };
        reusedOnFile = true;
      }
    } catch (err) {
      console.error('[vendor-submit] could not reuse stored payment details:', err.message);
    }
  }
  errors.push(...payFields.errors);

  // No key, no storage — and therefore no submission. The alternatives are worse
  // than an outage: write the number into a column named `_enc` in plain text, or
  // show the vendor a success page having silently dropped the details they just
  // typed. Checked BEFORE the sandbox branch so /admin/vendor-lab reports the same
  // refusal the live form would give, rather than a green result that is a lie.
  if (!paymentCrypto.isConfigured()) {
    console.error('[vendor-submit] PAYMENT_DETAILS_KEY is not configured — refusing submissions. '
      + 'Set it in the environment; see lib/payment-crypto.js.');
    return res.status(503).json({
      error: 'We cannot accept payment details right now. Please try again shortly, '
        + 'or email john@deanst.co and we will take them another way.',
    });
  }

  // ── One 400, listing everything that is wrong ─────────────────────────────
  // A batch that reports its problems one at a time is the vendor fixing a
  // field, pressing Submit, and being told about the next one — five times.
  //
  // `error` and `errors` keep exactly the shape and the wording they had, so
  // every existing caller is unaffected; `invoice_errors` is additive and is
  // what lets the form put a message on the card it belongs to.
  {
    const flat = [...errors];
    const per = [];
    invoices.forEach((inv, i) => {
      if (!invoiceErrors[i].length) return;
      per.push({ index: i, label: inv.label, errors: invoiceErrors[i] });
      for (const m of invoiceErrors[i]) flat.push(inv.label ? `${inv.label} — ${m}` : m);
    });
    if (flat.length) {
      return res.status(400).json({ error: flat[0], errors: flat, invoice_errors: per });
    }
  }

  // Supporting files are OPTIONAL and are never gated on — see the multer config.

  // W9 check (not required for reimbursements). A W9 belongs to the VENDOR, so
  // one covers every invoice in the submission — the same reason it is shared
  // across separate submissions through `w9_entry_id`.
  const w9File = req.files?.w9_file?.[0];

  if (!isReimb) {
    // Do we already hold a W9 for this vendor? The SAME function the form's
    // badge asked — see vendorHasW9OnFile. This gate previously rolled its own
    // alias resolution, which searched a primary name's aliases never, so a
    // vendor could be shown "W9 on file" and then refused for not attaching one.
    //
    // Failing CLOSED on a DB error (the catch below leaves w9OnFile false) is
    // deliberate: a missing W9 is a 1099 we cannot file, so an unreadable
    // database should ask for the form again rather than wave it through. The
    // vendor can still complete the submission by attaching it.
    let w9OnFile = false;
    try {
      w9OnFile = await vendorHasW9OnFile(vendorName);
    } catch (err) {
      console.error('[vendor-submit] W9-on-file check failed:', err.message);
    }

    if (!w9OnFile && !w9File) {
      return res.status(400).json({ error: 'Please upload your W9 or W8 form.' });
    }
  }
  // The reimbursement receipt is checked per invoice, above — each claim has its
  // own receipt, so it is a property of the invoice and not of the submission.

  // The duplicate check that used to live here has been REMOVED, not moved.
  //
  // It compared normalized invoice numbers for the same vendor and returned a
  // 409 telling the vendor to "reach out to us directly" — so a false positive
  // meant the invoice never reached us at all. And false positives were the
  // common case: normalizeInvoiceNum strips leading zeros, so 001 / 01 / 0001
  // / 1 are one number (88 live entries share "1", 40 share "2"), and
  // prefix-only numbers — #, INV-, -, ., inv, No. — ALL collapse to "0".
  // Identity matched on email OR name OR payee with no amount check and no
  // time bound, so a vendor who restarts numbering each year was blocked
  // permanently. 393 pairs already sitting in the ledger would have been
  // refused by this rule; they got in through paths that have no such gate,
  // which is the tell that it was not protecting the books, only obstructing
  // the form.
  //
  // Duplicates are now surfaced on the APPROVALS page as a flag, where a
  // person can compare both entries and decide. Approvals is already the
  // human review step. /check-dup still exists and still warns the vendor
  // before they submit — it just no longer refuses on their behalf, matching
  // the posture /check-similar below has always had.

  // Block submission when the entered invoice number doesn't match the one
  // printed on the uploaded document — or when the document has no invoice
  // number at all. Enforced server-side because the client could otherwise
  // tamper with the form. AI failure falls open: the background scan still
  // flags the discrepancy for admins.
  //
  // EVERY invoice is judged before ANY is written. John, 2026-09-15, on a batch
  // where one fails: "nothing is written until all pass." Checking as we insert
  // would leave three rows on Approvals and two invoices the vendor still has to
  // send, with no way to tell from the form which is which.
  {
    const gate = await mapWithConcurrency(invoices, 4, (inv) =>
      extractInvoiceNumberFromDocument(inv.file.buffer, inv.file.originalname));
    const failures = [];
    gate.forEach((docCheck, i) => {
      if (!docCheck.ok) return;                       // AI failure falls open
      const inv = invoices[i];
      const say = (m) => failures.push({ index: i, label: inv.label, errors: [m] });
      if (docCheck.invoice_number == null) {
        say('The uploaded invoice does not contain an invoice number. Please add one to the document and re-upload.');
      } else if (normalizeInvoiceNum(docCheck.invoice_number) !== normalizeInvoiceNum(inv.invoice_number)) {
        say(`The invoice number on your document ("${docCheck.invoice_number}") doesn't match the number you entered ("${inv.invoice_number}"). Please correct one of them.`);
      }
    });
    if (failures.length) {
      const flat = failures.map((f) => (f.label ? `${f.label} — ${f.errors[0]}` : f.errors[0]));
      return res.status(400).json({ error: flat[0], errors: flat, invoice_errors: failures });
    }
  }

  // Block submission when the invoice does not carry a direct payment method
  // (ACH account+routing, wire info, PayPal address, Venmo/Zelle, CashApp, or
  // check). External "pay" links to portals like Stripe / QuickBooks Online /
  // "Pay Now" buttons are explicitly rejected — AP needs to push funds, not
  // log in to a third-party portal. Reimbursements are exempt: a coffee-shop
  // receipt doesn't (and shouldn't) carry the vendor's bank info.
  // AI failure falls open; background discrepancy scan is the backstop.
  //
  // ── CHANGED 2026-08-26: this no longer refuses ─────────────────────────────
  // It used to 400 with "add your bank details to the invoice and re-upload".
  // That is exactly the case John asked about — a vendor who forgot to put
  // something on their invoice — and bouncing them was the wrong answer when we
  // can simply ask. The details are now collected as FIELDS above, and this scan
  // becomes corroboration: agreement is recorded, disagreement is flagged for a
  // human on Approvals, and silence is fine because the form already has them.
  //
  // The anti-fraud property the old rule was protecting is kept where it counts:
  // when the document DOES carry details and they differ from what was typed,
  // that is now visible, which it never was before.
  //
  // PER INVOICE, because the evidence is per document: one of five invoices may
  // print the vendor's account details and the other four may not, and a single
  // verdict over the batch would report the whole submission as corroborated on
  // the strength of one page.
  const checkedAt = new Date().toISOString();
  const payInfos = await mapWithConcurrency(invoices, 4, (inv) => (
    isReimb ? null : extractPaymentMethodFromInvoice(inv.file.buffer, inv.file.originalname)));
  invoices.forEach((inv, i) => {
    let check = { method: paymentPref, typed_last4: payLast4(paymentPref, payFields.normalized),
      doc_last4: null, verdict: 'unscanned' };
    if (!isReimb) {
      check = comparePaymentDetails(paymentPref, payFields.normalized, payInfos[i]);
    } else {
      // A coffee-shop receipt does not carry the claimant's bank details and
      // never should, so there is nothing to compare against.
      check.verdict = 'absent';
    }
    check.checked_at = checkedAt;
    if (reusedOnFile) check.reused_on_file = true;
    inv.payment_check = check;
  });
  // The shipping label. Built here, before the sandbox branch, so
  // /admin/vendor-lab reports exactly what would be stored — and copied onto
  // EVERY invoice, because it records how this submission was to be paid and
  // each row keeps its own copy of that (see `payment_snapshot`).
  const paymentSnapshot = buildPaymentSnapshot(paymentPref, payFields.normalized,
    { reused_on_file: reusedOnFile });
  paymentSnapshot.captured_at = checkedAt;
  // The first invoice's check is what the vendor-level lookups below read from
  // and write back — `typed_last4` is a property of the payment details, which
  // are shared, so every invoice's copy carries the same value.
  const paymentCheck = invoices[0].payment_check;

  // Are these the details we already held for this vendor?
  //
  // A vendor whose bank details change between invoices is the classic
  // invoice-fraud shape, so it is recorded on the entry for the approver rather
  // than overwritten quietly. Computed HERE, before the sandbox branch, for two
  // reasons: it is a read, so it is safe to run in a dry run; and /admin/vendor-lab
  // exists to show what a submission would do, which has to include this.
  try {
    const { rows: prevRows } = await pool.query(
      `SELECT account_last4, method, holder_name, bank_name, bank_address, account_type,
              beneficiary_address, intermediary_bank, wire_scope, updated_at
         FROM vendor_payment_details WHERE LOWER(vendor_email) = LOWER($1)`,
      [vendorEmail]);
    const prev = prevRows[0];
    if (prev && (prev.account_last4 !== paymentCheck.typed_last4 || prev.method !== paymentPref)) {
      // The FULL previous coordinates, not just method + last4.
      //
      // "Something changed" is a weaker claim than "it used to be Chase checking
      // in Jane's name and now it is Wells Fargo savings", and the second is the
      // one an approver can act on — redirected-payment fraud is exactly a
      // change of these fields. Built through buildPaymentSnapshot so the before
      // and the after are the same shape and can be diffed field by field.
      paymentCheck.changed_from = buildPaymentSnapshot(prev.method, {
        holder_name: prev.holder_name,
        bank_name: prev.bank_name,
        bank_address: prev.bank_address,
        account_type: prev.account_type,
        beneficiary_address: prev.beneficiary_address,
        intermediary_bank: prev.intermediary_bank,
        wire_scope: prev.wire_scope,
        // primaryValue() reads these, and we deliberately do NOT decrypt the
        // stored account number to build a history record. last4 is set below
        // from the column, which is what was displayed before and is enough to
        // say which account it used to be.
      });
      paymentCheck.changed_from.last4 = prev.account_last4 || null;
      paymentCheck.changed_from.held_since = prev.updated_at || null;
    }
  } catch (err) {
    console.error('[vendor-submit] could not read previous payment details:', err.message);
  }

  // A CHANGED account is a fact about the vendor, not about one document, so it
  // rides on every invoice in the submission. Approvals renders the was/now diff
  // per row, and an approver looking at invoice 4 must see it as readily as one
  // looking at invoice 1.
  if (paymentCheck.changed_from) {
    for (const inv of invoices) inv.payment_check.changed_from = paymentCheck.changed_from;
  }

  const w9Fname = w9File ? w9File.originalname : null;

  // Compute the authoritative off-roster flag, PER INVOICE. Union of:
  //   • the client's claim for that invoice's primary artist, and
  //   • any off_roster=true entry on its artist_breakdown.
  // Then intersect with the current roster: an artist that matches an
  // artists.name row (case-insensitive) is *not* off-roster, regardless
  // of what the client sent. This defends against a stale client cache
  // and against a malicious sender flipping the flag manually.
  //
  // The roster is read ONCE for the whole submission rather than per invoice —
  // ten invoices should not be ten scans of the artists table.
  try {
    let rosterSet = null;
    const wanted = invoices.some((inv) => (
      (inv.client_off_roster && inv.artist)
      || (Array.isArray(inv.breakdown) && inv.breakdown.some((r) => r && r.off_roster && r.artist))
    ));
    if (wanted) {
      const { rows: rosterRows } = await pool.query(
        `SELECT LOWER(name) AS name FROM artists WHERE name IS NOT NULL`
      );
      rosterSet = new Set(rosterRows.map(r => r.name));
    }
    for (const inv of invoices) {
      inv.off_roster = false;
      if (!rosterSet) continue;
      const candidates = new Set();
      if (inv.client_off_roster && inv.artist) candidates.add(inv.artist.toLowerCase());
      if (Array.isArray(inv.breakdown)) {
        for (const r of inv.breakdown) {
          if (r && r.off_roster && r.artist) candidates.add(String(r.artist).toLowerCase());
        }
      }
      for (const c of candidates) {
        if (!rosterSet.has(c)) { inv.off_roster = true; break; }
      }
    }
  } catch {
    for (const inv of invoices) inv.off_roster = inv.client_off_roster;
  }

  // Everything the row builder needs that is not the invoice itself.
  const ctx = { vendorName, vendorEmail, vendorAddress, vendorBank, paymentPref, isReimb };

  // ── SANDBOX: everything above, nothing below ────────────────────────────────
  //
  // `?sandbox=1` stops here, having run every check the real submission runs —
  // the required fields, the email format, `normalizeInvoiceNum`, the duplicate
  // lookup, the off-roster artist test, and the invoice-number gate that compares
  // what the vendor typed against what the document says. What it does NOT do is
  // the four lines below: no row in `expenses`, so nothing appears on Approvals;
  // no `uploadFile`, so no R2 objects to sweep up afterwards; no email to a vendor
  // or a rep.
  //
  // It exists so /admin/vendor-lab can be experimented on. The gate above is the
  // reason the branch sits HERE and not at the top of the handler: a sandbox that
  // skips the anti-spoofing check would teach the wrong thing about the form, and
  // the whole point of the lab is to try changes against the real rules.
  //
  // What it therefore cannot tell you: whether the INSERT's column list is right,
  // whether R2 accepts the file, or what the emails look like — see
  // `not_exercised` below, which says so in the response rather than leaving a
  // green result to imply otherwise. /admin/vendor-preview used to exercise all
  // three because its submissions were real; it was deleted on 2026-08-27, since
  // an admin opening the form to look at it should not create an approval by
  // pressing the obvious button. The live /submit is the only thing that writes.
  //
  // TOKEN REQUIRED, unlike the rest of /api/vendor/*. This writes nothing, but it
  // spends real Anthropic calls on the way here, and a public endpoint that burns
  // AI on request is a bill a stranger can run up.
  if (String(req.query.sandbox || '') === '1') {
    // Second lock. `sandboxAuth` above already refused an anonymous caller, but
    // that middleware is conditional on a query param — and a refactor of that
    // condition would silently open an AI-spending endpoint to the internet.
    if (!req.user) {
      return res.status(401).json({ success: false,
        error: 'The sandbox needs a signed-in admin — the live form is /submit' });
    }
    // The SAME builder the INSERT uses. Two literal field lists — one for the
    // row and one for the dry run — is the shape that lets a sandbox report
    // three correct invoices while the INSERT writes the first one three times.
    // Proven: breaking the INSERT's indexing left every sandbox assertion green.
    const rowFor = (inv) => ({
      ...expenseRowFor(ctx, inv),
      artist_before_normalization: inv.artist_raw,
      status: 'pending',
      // Masked, even here. The sandbox is admin-only, but there is no reason
      // for a full account number to travel in a response that exists to show
      // shape rather than secrets.
      payment_check: inv.payment_check,
      payment_snapshot: paymentSnapshot,
      social_handles: socialHandles,
    });
    const filesFor = (inv) => ({
      invoice: inv.file ? { name: inv.file.originalname, bytes: inv.file.size } : null,
      receipt: inv.receipt ? { name: inv.receipt.originalname, bytes: inv.receipt.size } : null,
      // Listed so the lab shows that multiple attachments arrived and were
      // parsed. Where they would GO is not rehearsed — see not_exercised.
      supporting: inv.extras.map((f) => ({ name: f.originalname, bytes: f.size })),
    });
    return res.json({ success: true, data: {
      sandbox: true,
      // `would_create` stays the FIRST invoice's row and keeps its exact shape,
      // and `files` stays that invoice's files, because that is what a
      // single-invoice submission has always reported and what the fixture reads.
      // The batch is additive, beside them.
      would_create: rowFor(invoices[0]),
      would_create_rows: invoices.map(rowFor),
      invoice_count: invoices.length,
      batch_total: invoices.reduce((t, inv) => t + (inv.amount || 0), 0),
      files: {
        ...filesFor(invoices[0]),
        w9: w9File ? { name: w9File.originalname, bytes: w9File.size } : null,
      },
      invoice_files: invoices.map(filesFor),
      // Said explicitly rather than implied by silence, so nobody reads a green
      // sandbox result as "this submission would have worked".
      not_exercised: ['INSERT INTO expenses', 'R2 upload', 'vendor + rep emails',
        'AI discrepancy scan', 'W9 cross-check', 'vendor_payment_details upsert',
        'entity_files rows for supporting invoice files'],
    } });
  }

  let entryId = null;
  // Every row this request has created. The rollback at the bottom deletes all
  // of them, not just the one that was in flight: a batch that half-wrote would
  // put three invoices on Approvals and tell the vendor the submission failed,
  // and they would send all five again.
  const createdIds = [];
  let stage = 'insert';
  try {
    for (const inv of invoices) {
    // INSERT first (with NULL r2 keys) to get the expense id for the R2 key
    // path. Full cutover: no *_data blobs go into Postgres anymore.
    const insertResult = await pool.query(
      `INSERT INTO expenses (
        invoice_date, payee, description, category,
        artist, song, invoice_number, amount, currency,
        payment_method, in_quickbooks, uploaded_to_stem, notes,
        vendor_submitted, vendor_name, vendor_email, vendor_address, vendor_bank,
        w9_filename, invoice_filename, proof_filename,
        status, cobrand, is_reimbursement, artist_breakdown,
        boom_rep, payment_terms, scheduled_payment_date, social_handles,
        off_roster_artist, payment_check, payment_last4, payment_snapshot, created_at
      ) VALUES (
        NOW(), $1, $2, $3,
        $4, $5, $6, $7, $8,
        $9, 'No', 'No', $10,
        true, $11, $12, $13, $14,
        $15, $16, $17,
        'pending', false, $18, $19,
        $20, 'Net 30', (NOW() + INTERVAL '30 days')::date, $21,
        $22, $23, $24, $25, NOW()
      ) RETURNING id`,
      (() => { const row = expenseRowFor(ctx, inv); return [
        row.payee, row.description, row.category,
        row.artist, row.song, row.invoice_number, row.amount, row.currency,
        row.payment_method, row.notes,
        row.payee, row.vendor_email, row.vendor_address, row.vendor_bank || null,
        // The W9 lands on the FIRST row only, and that is not a shortcut — W9s
        // are shared per VENDOR through `w9_entry_id`, which finds the most
        // recent form for a payee across all their entries. Copying the filename
        // onto five rows would claim five documents where one was uploaded, and
        // `HAS_W9_SQL` already covers the other four.
        inv.index === 0 ? w9Fname : null,
        inv.file.originalname,
        inv.receipt ? inv.receipt.originalname : null,
        row.is_reimbursement, inv.breakdown ? JSON.stringify(inv.breakdown) : null,
        row.boom_rep,
        socialHandles ? JSON.stringify(socialHandles) : null,
        row.off_roster_artist,
        JSON.stringify(inv.payment_check),
        row.payment_last4,
        JSON.stringify(paymentSnapshot),
      ]; })()
    );
    entryId = insertResult.rows[0].id;
    inv.entry_id = entryId;
    createdIds.push(entryId);
    }
    // ── End of the INSERT pass ───────────────────────────────────────────────
    // Every row exists before any file is uploaded. That ordering is not
    // cosmetic: it means a database failure on invoice 4 rolls back a batch that
    // has touched no object storage at all, and it puts the vendor-level write
    // below back where it has always been — BEFORE R2, so the details a vendor
    // typed survive an upload failure. Folding it into one pass moved it after
    // R2, and in dev (where R2 is unconfigured and every upload throws) the
    // profile stopped being stored at all: 10 fixture assertions, one cause.

    // ── Remember, so the next invoice does not ask again ─────────────────────
    // Keyed on the EMAIL, lower-cased. Vendor identity elsewhere resolves through
    // names and aliases; that is right for grouping invoices and wrong here,
    // because a name collision would pre-fill one vendor's bank details into
    // another vendor's form.
    //
    // A CHANGE is worth seeing: a vendor whose bank details differ from what we
    // held is the classic invoice-fraud shape, so the previous last4 is carried
    // onto this entry's payment_check for the approver rather than being
    // overwritten quietly.
    try {
      const n = payFields.normalized;
      await pool.query(`
        INSERT INTO vendor_payment_details
          (vendor_email, vendor_name, method, account_enc, routing_enc, iban_enc,
           paypal_handle, account_last4, holder_name, bank_address, account_type,
           bank_name, beneficiary_address, intermediary_bank, wire_scope,
           updated_from_entry_id, updated_at)
        VALUES (LOWER($1),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
        ON CONFLICT (vendor_email) DO UPDATE SET
          vendor_name = EXCLUDED.vendor_name, method = EXCLUDED.method,
          account_enc = EXCLUDED.account_enc, routing_enc = EXCLUDED.routing_enc,
          iban_enc = EXCLUDED.iban_enc, paypal_handle = EXCLUDED.paypal_handle,
          account_last4 = EXCLUDED.account_last4, holder_name = EXCLUDED.holder_name,
          bank_address = EXCLUDED.bank_address, account_type = EXCLUDED.account_type,
          bank_name = EXCLUDED.bank_name,
          beneficiary_address = EXCLUDED.beneficiary_address,
          intermediary_bank = EXCLUDED.intermediary_bank,
          wire_scope = EXCLUDED.wire_scope,
          updated_from_entry_id = EXCLUDED.updated_from_entry_id, updated_at = NOW()`,
        [vendorEmail, vendorName, paymentPref,
          n.account_number ? paymentCrypto.encrypt(n.account_number) : null,
          n.routing_number ? paymentCrypto.encrypt(n.routing_number) : null,
          n.iban_swift ? paymentCrypto.encrypt(n.iban_swift) : null,
          n.paypal || null, paymentCheck.typed_last4, n.holder_name || null,
          n.bank_address || null, n.account_type || null, n.bank_name || null,
          n.beneficiary_address || null, n.intermediary_bank || null,
          // The FIRST row of the batch, not the last one the loop happened to
          // leave in `entryId`. `updated_from_entry_id` answers "which
          // submission did these details arrive on", and the first row is the
          // one that also holds the W9 — so the two point at the same invoice.
          n.wire_scope || null, createdIds[0]]);
    } catch (err) {
      // The invoice is already in the ledger and the vendor has been told it
      // arrived; failing the whole submission here would be worse than losing the
      // convenience of a remembered profile. Loud, and the details are still on
      // the invoice we hold.
      console.error('[vendor-submit] could not store vendor payment details:', err.message);
    }

    // ── The files, one invoice at a time ─────────────────────────────────────
    // A second pass, deliberately. Object storage is the slow, failure-prone
    // half of this handler, so it runs after every row exists AND after the
    // vendor-level write above — which is where that write has always sat,
    // relative to R2. Folding both into one pass moved it after the upload,
    // and in dev (R2 unconfigured, every upload throws) the vendor profile
    // stopped being stored at all: ten fixture assertions, one cause.
    for (const inv of invoices) {
      const entryId = inv.entry_id;
    // Upload to R2 using the new id. Buffers stay alive on req.files so the
    // background AI scans below can still call .toString('base64') on them.
    const ts = Date.now();
    const safe = (n) => n.replace(/[^a-zA-Z0-9.-]/g, '_');

    stage = 'r2_upload_invoice';
    const invoiceR2Key = `vendors/${entryId}/invoice/${ts}_${safe(inv.file.originalname)}`;
    await uploadFile(invoiceR2Key, inv.file.buffer, inv.file.mimetype);

    // The W9 is ONE document for the whole submission and goes up once, on the
    // first row. See the INSERT above for why the other rows carry none.
    let w9R2Key = null;
    if (w9File && inv.index === 0) {
      stage = 'r2_upload_w9';
      w9R2Key = `vendors/${entryId}/w9/${ts}_${safe(w9Fname)}`;
      await uploadFile(w9R2Key, w9File.buffer, w9File.mimetype);
    }

    let proofR2Key = null;
    if (inv.receipt) {
      stage = 'r2_upload_proof';
      proofR2Key = `vendors/${entryId}/proof/${ts}_${safe(inv.receipt.originalname)}`;
      await uploadFile(proofR2Key, inv.receipt.buffer, inv.receipt.mimetype);
    }

    // Persist the R2 keys back to the row
    stage = 'update_r2_keys';
    await pool.query(
      `UPDATE expenses SET invoice_r2_key = $1, w9_r2_key = $2, proof_r2_key = $3 WHERE id = $4`,
      [invoiceR2Key, w9R2Key, proofR2Key, entryId]
    );

    // ── Supporting files for THIS invoice ────────────────────────────────────
    // Written as `expense_receipt` rows in `entity_files`, which is the SAME type
    // the per-entry attachments list already uses. That is the point: those rows
    // already have a serve route, a delete route and a place they render
    // (POST/GET/DELETE /api/bk/entries/:id/receipts). A new `expense_invoice`
    // type would have been tidier to name and invisible to every existing reader
    // until three more surfaces were taught about it.
    //
    // `label` is what tells them apart, so an approver can see which files a
    // vendor sent versus which ones we attached afterwards.
    //
    // Best-effort: the invoice is already in the ledger and the vendor is about
    // to be told it arrived. Losing an attachment is worth a loud log, not a
    // failed submission — the primary invoice, the one everything is gated on,
    // is already safely in R2.
    if (inv.extras.length) {
      stage = 'r2_upload_extras';
      for (const f of inv.extras) {
        try {
          const stored = `${Date.now()}-${safe(f.originalname || 'attachment')}`;
          const key = `entity_files/expense_receipt/${entryId}/${stored}`;
          await uploadFile(key, f.buffer, f.mimetype);
          await pool.query(
            `INSERT INTO entity_files
               (entity_type, entity_id, filename, original_name, file_size, uploaded_by, r2_key, mime_type, label)
             VALUES ('expense_receipt', $1, $2, $3, $4, NULL, $5, $6, $7)`,
            [entryId, stored, f.originalname, f.size, key, f.mimetype, 'Vendor invoice attachment']
          );
        } catch (err) {
          console.error(`[vendor-submit] entry ${entryId}: supporting file "${f.originalname}" was not saved:`, err.message);
        }
      }
    }
    }

    // Save any extra emails to the vendor's record (best-effort — never fail
    // the submission over this). Stored under the canonical primary name
    // when the submitted name is a known alias; duplicates are skipped by
    // the case-insensitive unique index.
    if (additionalEmails.length) {
      try {
        const { rows: asAlias } = await pool.query(
          'SELECT primary_name FROM vendor_aliases WHERE LOWER(alias) = LOWER($1)', [vendorName]
        );
        const canonical = asAlias.length ? asAlias[0].primary_name : vendorName;
        for (const email of additionalEmails) {
          await pool.query(
            `INSERT INTO vendor_emails (vendor_name, email, created_by) VALUES ($1, $2, $3)`,
            [canonical, email, 'Vendor (submit form)']
          ).catch(err => { if (err.code !== '23505') throw err; });
        }
      } catch (err) {
        console.warn('vendor-submit: saving additional emails failed:', err.message);
      }
    }

    // `success: true` and nothing else is what every existing caller reads. The
    // counts are additive, for a form that has to say "5 invoices received".
    res.json({
      success: true,
      invoice_count: invoices.length,
      entry_ids: createdIds,
    });

    // Activity feed — a submission is now waiting on somebody. Fired after the
    // response and never awaited; postEvent swallows and logs its own failures,
    // so a vendor's submission can never fail because chat is unhappy.
    //
    // ONE event for the batch, not five. Five near-identical lines in the feed
    // reads as five separate submissions, which is the thing this feature makes
    // no longer true.
    {
      const total = invoices.reduce((t, inv) => t + (inv.amount || 0), 0);
      const cur = invoices[0].currency || 'USD';
      const oneCurrency = invoices.every((inv) => (inv.currency || 'USD') === cur);
      const artists = [...new Set(invoices.map((i) => i.artist).filter(Boolean))];
      postEvent({
        text: `*${vendorName}* submitted `
          + (multi ? `${invoices.length} invoices` : 'an invoice')
          + ' for approval'
          // Withheld rather than converted when the batch mixes currencies —
          // this app has one place that converts money and it is not the chat
          // feed. The count and the artists still say what arrived.
          + (total && oneCurrency ? ` — ${cur} ${Number(total).toLocaleString()}` : '')
          + (artists.length === 1 ? ` (${artists[0]})`
            : artists.length > 1 ? ` (${artists.slice(0, 3).join(', ')}${artists.length > 3 ? '…' : ''})`
              : ''),
        icon: 'inbox',
        link: '/bk/approvals',
      }).catch(e => console.error('[activityBot] event dropped:', e.message));
    }

    // Run AI scans in the background (don't block the response). Re-encode
    // from the live multer buffers — cheaper than fetching back from R2.
    //
    // Per invoice: the scan compares ONE document against the row that document
    // created, so a batch needs one scan each or four of five rows carry an
    // `ai_scan` describing somebody else's invoice.
    if (process.env.ANTHROPIC_API_KEY) {
      for (const inv of invoices) {
        scanInvoiceForDiscrepancies(inv.entry_id, {
          vendorName, artist: inv.artist, song: inv.song, invoiceNum: inv.invoice_number,
          amount: inv.amount, currency: inv.currency, category: inv.category, notes: inv.notes,
        }, inv.file.buffer.toString('base64'), inv.file.originalname).catch(err => {
          console.error('AI invoice scan failed for entry', inv.entry_id, err.message);
        });
      }

      // Also cross-check W9/W8 against submitted data. ONE form, one scan, on
      // the row that holds it — the same row `w9_entry_id` resolves to.
      if (w9File) {
        scanW9ForDiscrepancies(createdIds[0], {
          vendorName, vendorEmail, vendorAddress,
        }, w9File.buffer.toString('base64'), w9File.originalname).catch(err => {
          console.error('AI W9 scan failed for entry', createdIds[0], err.message);
        });
      }
    }
  } catch (err) {
    // If INSERT succeeded but R2 upload / UPDATE failed, roll back the row so
    // we don't leave an expense with missing files.
    // Roll back ONLY if the vendor has not already been told it worked.
    //
    // res.json({ success: true }) is sent above, before the background AI
    // scans. Nothing there can throw synchronously today (the scans are async
    // functions and their arguments are safe), but if anything ever does, the
    // unguarded version deleted a row the vendor had just been told was
    // accepted — the submission would vanish with nobody aware. By that point
    // the row is complete: files uploaded, R2 keys written. Keep it.
    //
    // EVERY row this request made, not just the one that was in flight. A batch
    // that failed on invoice 4 would otherwise leave 1, 2 and 3 on Approvals
    // under a response that said the submission failed — so the vendor sends all
    // five again and three of them are now duplicates nobody asked for.
    if (createdIds.length && !res.headersSent) {
      try {
        await pool.query('DELETE FROM expenses WHERE id = ANY($1::int[])', [createdIds]);
      } catch {}
    }
    console.error(`Vendor submit failed at stage=${stage}:`, err.code || err.name || '', err.message);
    if (err.stack) console.error(err.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Submission failed. Please try again.', stage, detail: err.message });
    }
  }
});

// ── AI Invoice Scan ──────────────────────────────────────────────────────────
// Scans the uploaded invoice/receipt with Claude and compares to the form data.
// Stores discrepancies in the ai_scan JSONB column on the expense row.
async function scanInvoiceForDiscrepancies(entryId, formData, invoiceB64, filename) {
  if (!invoiceB64) return; // No file to scan; nothing to write.
  const prompt = `You are an invoice auditor for a record label called Market Street. A vendor submitted an invoice along with a form. Compare the submitted document against the form data and identify any discrepancies.

FORM DATA SUBMITTED BY VENDOR:
- Vendor Name: ${formData.vendorName}
- Artist: ${formData.artist}
- Song: ${formData.song || '(not provided)'}
- Invoice Number: ${formData.invoiceNum}
- Amount: ${formData.amount} ${formData.currency}
- Category: ${formData.category}
- Notes: ${formData.notes || '(none)'}

Analyze the attached invoice/receipt document and return ONLY valid JSON:
{
  "document_payee": "name on the invoice/receipt or null",
  "document_amount": number or null,
  "document_currency": "3-letter code or null",
  "document_invoice_number": "string or null",
  "document_date": "YYYY-MM-DD or null",
  "document_description": "brief description of services/items or null",
  "discrepancies": [
    {
      "field": "name of the field with a mismatch",
      "form_value": "what the vendor entered",
      "document_value": "what the document shows",
      "severity": "high" or "medium" or "low"
    }
  ],
  "summary": "one-sentence summary of the findings"
}

Flag discrepancies for: amount mismatch (high severity), vendor name mismatch (medium), invoice number mismatch (medium), currency mismatch (high).

IMPORTANT: A document IS attached and you CAN read it. Read every visible field carefully and extract the data — even if the scan is imperfect, low resolution, or photographed at an angle, do your best to OCR what you can see. Most invoices have at least a payee name, an amount, and a date — find them. Only conclude the document is "unreadable" if it is genuinely blank or completely garbled, which is rare. NEVER claim "no document was attached" — one is. The summary should describe what you read, not excuses for not reading. Return only JSON.`;

  const result = await callClaude({
    prompt,
    base64: invoiceB64,
    filename,
    maxTokens: 1024,
    parseJson: true,
    cacheDocument: true,
  });
  const parsed = result.ok
    ? result.data
    : { summary: 'AI could not parse the invoice document.', discrepancies: [] };

  await pool.query(
    'UPDATE expenses SET ai_scan = $1 WHERE id = $2',
    [JSON.stringify(parsed), entryId]
  );
  console.log(`AI scan complete for entry ${entryId}: ${parsed.discrepancies?.length || 0} discrepancies`);
}

// ── AI W9/W8 Cross-Check ────────────────────────────────────────────────────
// Compares the W9/W8 form against the vendor's submitted info.
// Stores results in the w9_scan JSONB column.
async function scanW9ForDiscrepancies(entryId, formData, w9B64, filename) {
  if (!w9B64) return; // No file to scan; nothing to write.
  const prompt = `You are auditing a W-9 or W-8 tax form submitted by a vendor to Market Street. Compare the form against the vendor's submitted information and identify any discrepancies.

VENDOR SUBMITTED INFO:
- Legal Name: ${formData.vendorName}
- Email: ${formData.vendorEmail || '(not provided)'}
- Mailing Address: ${formData.vendorAddress || '(not provided)'}

Analyze the attached W-9 or W-8 form and return ONLY valid JSON:
{
  "form_type": "W-9" or "W-8BEN" or "W-8BEN-E" or "unknown",
  "w9_name": "name on the form (line 1) or null",
  "w9_business_name": "business name (line 2) if different from line 1, or null",
  "w9_address": "address on the form or null",
  "w9_tin_present": true or false,
  "w9_signed": true or false,
  "w9_dated": true or false,
  "discrepancies": [
    {
      "field": "name of the field with a mismatch",
      "form_value": "what the vendor submitted in the web form",
      "w9_value": "what the W9/W8 document shows",
      "severity": "high" or "medium" or "low"
    }
  ],
  "summary": "one-sentence summary"
}
${W9_TAX_PROMPT_FIELDS}

Check for:
- Name mismatch between submitted legal name and W9 line 1 or line 2 (high severity if completely different, medium if minor spelling/formatting difference)
- Address mismatch between submitted address and W9 address (low severity — addresses often differ slightly)
- Missing TIN/SSN/EIN (high severity)
- Missing signature (high severity)
- Missing date (medium severity)

Be reasonable about name matching — "John Smith" vs "John A. Smith" or "Smith LLC" vs "Smith, LLC" are NOT discrepancies. Only flag genuine mismatches.

IMPORTANT: A document IS attached and you CAN read it. Read every visible field carefully — even if the scan is imperfect, low resolution, or photographed at an angle, do your best to OCR what you can see. If the attached document is clearly a W-9 or W-8, set form_type accordingly and extract the fields. If it is clearly a different kind of document (bank statement, receipt, ID, etc.), still describe what it actually is in the summary AND add a discrepancy with field "form_type", form_value: "W-9 or W-8 expected", w9_value: "<what it actually is>", severity: "high" — that is a real finding the admin needs to see. Only conclude the document is "unreadable" if it is genuinely blank or completely garbled, which is rare. NEVER claim "no document was attached" — one is. Return only JSON.`;

  const result = await callClaude({
    prompt,
    base64: w9B64,
    filename,
    maxTokens: 1024,
    parseJson: true,
    cacheDocument: true,
  });
  const parsed = result.ok
    ? result.data
    : { summary: 'AI could not parse the W9/W8 document.', discrepancies: [] };

  await pool.query(
    'UPDATE expenses SET w9_scan = $1 WHERE id = $2',
    [JSON.stringify(parsed), entryId]
  );
  console.log(`W9 scan complete for entry ${entryId}: ${parsed.discrepancies?.length || 0} discrepancies`);

  // The same read, filed as tax identity. This scan was already looking at the
  // form; asking it for the TIN and line 3 in the same call is why a vendor who
  // submits today is filable in January without anybody re-running a backfill.
  //
  // Best-effort on purpose: the vendor has already been told their submission
  // arrived (res.json fires before these background scans), so nothing here may
  // throw its way back to them.
  try {
    const stored = await storeW9Tax({
      payee: formData.vendorName, parsed, entryId, userName: 'vendor-submit',
    });
    console.log(`[w9-tax] entry ${entryId}: ${stored.stored ? 'stored' : 'not stored'}`
      + ` — ${stored.tax_classification || 'no line 3'}, ${stored.tin_last4 ? `TIN ••${stored.tin_last4}` : 'no TIN'}`
      + (stored.reason ? ` (${stored.reason})` : ''));
  } catch (err) {
    console.error(`[w9-tax] entry ${entryId}: tax fields not stored —`, err.message);
  }
}

module.exports = router;
