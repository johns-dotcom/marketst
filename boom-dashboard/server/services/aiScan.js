/**
 * AI discrepancy rescans for existing ledger entries.
 *
 * rescanInvoice(entryId) — re-runs invoice discrepancy scan, writes ai_scan.
 * rescanW9(entryId)      — re-runs W9/W8 discrepancy scan, writes w9_scan.
 *
 * Both look up the entry + file blobs from the DB so callers only pass an ID.
 * Safe to call concurrently. Returns the new scan object, or null on error.
 */
const pool = require('../db');
const { loadFileBase64 } = require('../lib/r2');
const { storeW9Tax, W9_TAX_PROMPT_FIELDS } = require('./w9Tax');
const { callClaude } = require('./claude');

async function rescanInvoice(entryId) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, reason: 'AI is not configured (no API key on server).' };
  }
  // Family total: parent's amount + every child's amount. This is what the
  // document SHOULD show for a multi-artist split — the bare parent.amount
  // alone is just the first artist's share post-split, which would (wrongly)
  // generate an "amount mismatch" discrepancy for every split family.
  const { rows } = await pool.query(
    `SELECT e.payee, e.artist, e.song, e.invoice_number, e.amount, e.currency,
            e.category, e.description, e.parent_id, e.artist_breakdown,
            e.invoice_data, e.invoice_r2_key, e.invoice_filename,
            (e.amount + COALESCE(
              (SELECT SUM(c.amount) FROM expenses c
               WHERE c.parent_id = COALESCE(e.parent_id, e.id)
                 AND (c.deleted = false OR c.deleted IS NULL)), 0)
            ) AS family_amount
     FROM expenses e
     WHERE e.id = $1`,
    [entryId]
  );
  const entry = rows[0];
  if (!entry) return { ok: false, reason: 'Entry not found.' };
  if (!entry.invoice_filename) return { ok: false, reason: 'No invoice file is attached to this entry.' };
  const invoiceB64 = await loadFileBase64(entry.invoice_r2_key, entry.invoice_data);
  if (!invoiceB64) return { ok: false, reason: 'Invoice file could not be loaded — the stored object is missing or empty in R2.' };
  console.log(`[rescan] entry ${entryId} invoice file ${entry.invoice_filename} loaded (${Math.round(invoiceB64.length / 1024)}KB base64)`);

  // Use the family total when this entry is part of a split (has a parent or
  // children). Fall back to the breakdown JSON sum if it's larger than the
  // parent's amount (covers pre-split entries that still carry a breakdown).
  let formAmount = Number(entry.family_amount) || Number(entry.amount) || 0;
  if (Array.isArray(entry.artist_breakdown) && entry.artist_breakdown.length > 1) {
    const breakdownSum = entry.artist_breakdown.reduce((s, b) => {
      const n = parseFloat(String(b?.amount ?? '').replace(/[^0-9.\-]/g, ''));
      return s + (Number.isFinite(n) ? n : 0);
    }, 0);
    if (breakdownSum > formAmount) formAmount = breakdownSum;
  }

  const prompt = `You are an invoice auditor for a record label called Market Street. A vendor submitted an invoice along with a form. Compare the submitted document against the form data and identify any discrepancies.

FORM DATA SUBMITTED BY VENDOR:
- Vendor Name: ${entry.payee}
- Artist: ${entry.artist || '(not provided)'}
- Song: ${entry.song || '(not provided)'}
- Invoice Number: ${entry.invoice_number || '(not provided)'}
- Amount: ${formAmount} ${entry.currency || 'USD'}
- Category: ${entry.category || '(not provided)'}
- Notes: ${entry.description || '(none)'}

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
    filename: entry.invoice_filename,
    parseJson: true,
  });
  if (!result.ok) {
    console.error(`Invoice rescan failed for entry ${entryId}:`, result.error);
    return { ok: false, reason: `AI call failed: ${result.error || 'unknown'}` };
  }
  const parsed = { ...(result.data || {}), scanned_at: new Date().toISOString() };
  console.log(`[rescan] entry ${entryId} invoice scan complete at ${parsed.scanned_at}: ${parsed?.discrepancies?.length || 0} discrepancies, summary="${(parsed?.summary || '').slice(0, 120)}"`);
  await pool.query('UPDATE expenses SET ai_scan = $1 WHERE id = $2', [JSON.stringify(parsed), entryId]);
  return { ok: true, scan: parsed };
}

async function rescanW9(entryId) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, reason: 'AI is not configured (no API key on server).' };
  }
  const { rows } = await pool.query(
    `SELECT e.payee, e.vendor_email, e.vendor_address,
            w9.w9_data, w9.w9_r2_key, w9.w9_filename
     FROM expenses e
     LEFT JOIN LATERAL (
       SELECT w9_data, w9_r2_key, w9_filename FROM expenses x
       WHERE LOWER(TRIM(x.payee)) = LOWER(TRIM(e.payee))
         AND ((x.w9_data IS NOT NULL AND x.w9_data != '') OR x.w9_r2_key IS NOT NULL)
       ORDER BY x.id DESC LIMIT 1
     ) w9 ON true
     WHERE e.id = $1`,
    [entryId]
  );
  const entry = rows[0];
  if (!entry) return { ok: false, reason: 'Entry not found.' };
  if (!entry.w9_filename) return { ok: false, reason: 'No W9/W8 file is attached or on file for this vendor.' };
  const w9B64 = await loadFileBase64(entry.w9_r2_key, entry.w9_data);
  if (!w9B64) return { ok: false, reason: 'W9/W8 file could not be loaded — the stored object is missing or empty in R2.' };
  console.log(`[rescan] entry ${entryId} W9 file ${entry.w9_filename} loaded (${Math.round(w9B64.length / 1024)}KB base64)`);

  const prompt = `You are auditing a W-9 or W-8 tax form submitted by a vendor to Market Street. Compare the form against the vendor's submitted information and identify any discrepancies.

VENDOR SUBMITTED INFO:
- Legal Name: ${entry.payee}
- Email: ${entry.vendor_email || '(not provided)'}
- Mailing Address: ${entry.vendor_address || '(not provided)'}

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
    filename: entry.w9_filename,
    parseJson: true,
  });
  if (!result.ok) {
    console.error(`W9 rescan failed for entry ${entryId}:`, result.error);
    return { ok: false, reason: `AI call failed: ${result.error || 'unknown'}` };
  }
  const parsed = { ...(result.data || {}), scanned_at: new Date().toISOString() };
  console.log(`[rescan] entry ${entryId} W9 scan complete at ${parsed.scanned_at}: ${parsed?.discrepancies?.length || 0} discrepancies, summary="${(parsed?.summary || '').slice(0, 120)}"`);
  await pool.query('UPDATE expenses SET w9_scan = $1 WHERE id = $2', [JSON.stringify(parsed), entryId]);
  // Same read, also filed as tax identity — see services/w9Tax.js. Pressing
  // rescan on a form is exactly when a TIN that failed to read the first time
  // gets a second chance, so this path has to write it too.
  await storeW9Tax({ payee: entry.payee, parsed, entryId, userName: 'rescan' })
    .catch((err) => console.error(`[w9-tax] rescan of entry ${entryId}:`, err.message));
  return { ok: true, scan: parsed };
}

const INVOICE_SCAN_FIELDS = ['payee', 'artist', 'song', 'invoice_number', 'amount', 'currency', 'category', 'description'];
const W9_SCAN_FIELDS = ['payee', 'vendor_email', 'vendor_address'];

module.exports = { rescanInvoice, rescanW9, INVOICE_SCAN_FIELDS, W9_SCAN_FIELDS };
