/**
 * Reading a W-9's tax identity, and the ONE place it gets written.
 *
 * ── Why this is a service and not four copies ──
 * A W-9 arrives by four routes, and until now only one of them read the two
 * fields a 1099 needs:
 *
 *   1. a vendor submits one              routes/vendor-submit.js
 *   2. an admin uploads one to an entry  POST /bk/entries/:id/file/w9
 *   3. somebody presses rescan           services/aiScan.js rescanW9
 *   4. the backfill over old forms       POST /bk/vendors/scan-w9-tax
 *
 * Only (4) existed, which meant every W-9 arriving from today onward had to
 * wait for somebody to re-run a backfill — a feature that needs a chore to stay
 * true is a feature that quietly stops being true. All four now write through
 * `storeW9Tax`, so a TIN read by one path is stored exactly as another would
 * store it.
 *
 * ── One read, two answers ──
 * (1) and (3) were ALREADY reading the form, to compare it against what the
 * vendor typed. They now ask for the tax fields in the same call and hand the
 * result here. Adding a second Claude call per submission to fetch two more
 * fields off a page already being read would pay the bill twice for one read,
 * which is the same argument that kept the backfill separate from the
 * name-only scan it sits next to.
 *
 * ── Storing it ──
 * The TIN is encrypted, and if there is no key it is NOT STORED — not stored in
 * plain text, not dropped silently. `lib/payment-crypto` makes the same refusal
 * for bank details, and here the caller is always a background task, so the
 * refusal is a loud log rather than a thrown 503: a vendor's submission must not
 * fail because an env var is missing on the day they filled the form in.
 */
const pool = require('../db');
const paymentCrypto = require('../lib/payment-crypto');
const { parseW9Tax } = require('../lib/w9-tax');
const { callClaude } = require('./claude');
const { W9_TAX_PROMPT } = require('../lib/w9-tax');
const { loadFileBase64 } = require('../lib/r2');

/**
 * The tax fields any W-9 read should return, as prompt text.
 *
 * Appended to the two prompts that were already comparing a form against the
 * submitted data, so their JSON gains these keys without their own instructions
 * being rewritten around them. Kept here rather than inline in each prompt so
 * the four paths cannot drift on what they ask for — the field NAMES are the
 * contract `parseW9Tax` reads.
 */
const W9_TAX_PROMPT_FIELDS = `
Also extract these tax-identity fields, which are needed to file a 1099. Add them to the same JSON object:
  "tin_printed": the taxpayer identification number EXACTLY as printed including any dashes, or null if blank
  "tin_kind": "SSN" or "EIN" — which box the number was written in, not a guess from its format — or null
  "tax_classification": the checked box on line 3, one of: Individual/sole proprietor, C corporation, S corporation, Partnership, Trust/estate, LLC, Other. null if none is checked
  "llc_tax_class": if LLC is checked, the single letter in its box (C, S or P), else null
Report any of these as null when blank or unreadable. Never guess a TIN.`;

/**
 * Write a read onto the vendor, and say what happened.
 *
 * Scoped to the PAYEE's W-9-bearing rows, the same population the backfill
 * writes and the same one `w9_by_payee` and lib/w9-owner resolve a W-9 through:
 * a TIN is a fact about the vendor, so storing it on whichever invoice happened
 * to carry the upload would make it a fact about that row.
 *
 * ALWAYS stamps `w9_tax_scanned_at`, even when the form yielded nothing. That
 * stamp is what stops the backfill offering the same unreadable form forever,
 * and "we looked and it does not say" is a different state from "nobody has
 * looked" — the 1099 page shows them differently.
 *
 * @returns {Promise<{ stored: boolean, reason?: string, tin_last4?: string|null,
 *                     tax_classification?: string|null, issues?: string[] }>}
 */
async function storeW9Tax({ payee, parsed, entryId = null, userName = 'system', audit = null }) {
  const name = String(payee || '').trim();
  if (!name) return { stored: false, reason: 'no payee to store it against' };
  const tax = parsed && parsed.issues ? parsed : parseW9Tax(parsed);

  // No key, no ciphertext — and no plaintext either. The classification and the
  // last four are not secrets and are still worth having, so they are stored
  // regardless; only the number itself is withheld.
  let enc = null;
  if (tax.tin_digits) {
    if (paymentCrypto.isConfigured()) {
      enc = paymentCrypto.encrypt(tax.tin_digits);
    } else {
      console.error('[w9-tax] PAYMENT_DETAILS_KEY is not set — a TIN was read for '
        + `${name} and deliberately NOT stored. Set the key and re-run the scan.`);
      tax.issues = [...tax.issues, 'a TIN was on the form but could not be stored (no encryption key configured)'];
    }
  }

  const { rowCount } = await pool.query(
    `UPDATE expenses
        SET w9_tin_enc = COALESCE($1, w9_tin_enc),
            w9_tin_last4 = COALESCE($2, w9_tin_last4),
            w9_tin_type = COALESCE($3, w9_tin_type),
            w9_tax_classification = COALESCE($4, w9_tax_classification),
            w9_tax_scanned_at = NOW()
      WHERE LOWER(TRIM(payee)) = LOWER(TRIM($5))
        AND ((w9_data IS NOT NULL AND w9_data != '') OR w9_r2_key IS NOT NULL)`,
    [enc, tax.tin_last4, tax.tin_type, tax.tax_classification, name]);

  // COALESCE, not overwrite. A re-read that could not make out the TIN must not
  // erase one an earlier read got — the second read is not evidence the first
  // was wrong, and a blanked TIN silently moves a vendor back onto the "cannot
  // file" list. A correction goes through the vendor page, deliberately.

  if (audit) {
    await audit({ name: userName }, 'w9_tax_scanned', entryId, name, 'w9_tax_classification',
      null, tax.tax_classification,
      `Read from the ${tax.form_type}: ${tax.tin_last4 ? `TIN ••${tax.tin_last4} (${tax.tin_type || 'kind not stated'})` : 'no TIN on the form'}`
      + `, line 3 ${tax.tax_classification || 'not checked'}`
      + (tax.issues.length ? ` — ${tax.issues.join('; ')}` : '')).catch(() => {});
  }

  return {
    stored: rowCount > 0,
    rows: rowCount,
    tin_last4: tax.tin_last4,
    tin_type: tax.tin_type,
    tax_classification: tax.tax_classification,
    form_type: tax.form_type,
    issues: tax.issues,
    ...(rowCount === 0
      // The one case worth naming: the file is on an entry whose payee has no
      // W-9-bearing row yet (the upload and this read raced). The caller retries
      // by re-running the scan; it is not a failure of the read.
      ? { reason: 'no W-9-bearing row for that payee — nothing written' }
      : {}),
  };
}

/**
 * Read a form nobody else is reading, then store it.
 *
 * For the two paths where no comparison scan is already in flight: the backfill
 * and an admin uploading a W-9 onto an entry. Loads the file from R2 (or the
 * legacy column) when the caller has not got it in hand.
 */
async function readAndStoreW9Tax({ entryId, payee, base64, filename, userName = 'system', audit = null }) {
  if (!process.env.ANTHROPIC_API_KEY) return { stored: false, reason: 'AI is not configured (no API key)' };
  let b64 = base64;
  let fname = filename;
  let name = payee;
  if (!b64 || !name) {
    const { rows } = await pool.query(
      `SELECT payee, w9_data, w9_r2_key, w9_filename FROM expenses WHERE id = $1`, [entryId]);
    if (!rows.length) return { stored: false, reason: 'entry not found' };
    name = name || rows[0].payee;
    fname = fname || rows[0].w9_filename;
    b64 = b64 || await loadFileBase64(rows[0].w9_r2_key, rows[0].w9_data);
  }
  if (!b64) return { stored: false, reason: 'the W-9 file could not be loaded' };

  const ai = await callClaude({
    prompt: W9_TAX_PROMPT, base64: b64, filename: fname || '', maxTokens: 512, parseJson: true,
  });
  if (!ai.ok) return { stored: false, reason: ai.reason || 'the form could not be read' };
  return storeW9Tax({ payee: name, parsed: parseW9Tax(ai.data), entryId, userName, audit });
}

module.exports = { storeW9Tax, readAndStoreW9Tax, W9_TAX_PROMPT_FIELDS };
