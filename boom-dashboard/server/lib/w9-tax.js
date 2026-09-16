/**
 * The two fields on a W-9 that a 1099 cannot be filed without, and the rule
 * that decides whether a vendor gets one at all.
 *
 * ── Why this exists ──
 * The app already holds the documents: 299 vendors have a W-9 on file. What it
 * never read off them is the TIN and the tax classification — the W-9 scan
 * extracted name, email and address only. So `GET /bk/1099` could compute the
 * money correctly (payment basis, alias rollup, locked FX, reimbursements
 * excluded) and still not produce a filing, because:
 *
 *   · you cannot file a 1099 without a TIN, and
 *   · corporations are generally not 1099-reportable at all, so without
 *     line 3 every reportable vendor needs checking by hand. Measured
 *     2026-09-01: 222 reportable vendors for 2026, $6,121,632, and the endpoint
 *     honestly flagged all 222 as needing that check.
 *
 * ── What is deliberately NOT decided here ──
 * This module extracts, validates and CLASSIFIES. It never drops a vendor from
 * a filing. `exemptionFor()` returns a reason and a confidence, and the caller
 * reports it as an exclusion the human can see and override — because the
 * corporation rule has exceptions (below) that no field on the form can settle.
 */

// W-9 line 3, as printed on the form (Rev. March 2024). The strings are the
// vocabulary the extraction is held to; anything else becomes 'Other' with the
// raw text preserved, rather than being coerced into a box it might not be in.
const TAX_CLASSIFICATIONS = [
  'Individual/sole proprietor',
  'C corporation',
  'S corporation',
  'Partnership',
  'Trust/estate',
  'LLC',
  'Other',
];

// A W-8 is a foreign payee. They are not 1099 recipients (a 1042-S is the
// analogue), so the classification is recorded and the exemption reason says
// which form it came from rather than pretending it is a US entity.
const FOREIGN = 'Foreign (W-8)';

/**
 * The extraction contract. One prompt, superseding the old name-only one, so a
 * single pass over a document produces everything: re-scanning 299 W-9s twice
 * to collect fields that are two lines apart on the same page would be paying
 * the AI bill twice for one read.
 *
 * The TIN is asked for AS PRINTED. Normalising in the prompt would throw away
 * the punctuation, and the punctuation is what says whether nine digits are an
 * SSN (###-##-####) or an EIN (##-#######) — a distinction the filing needs and
 * the digits alone cannot carry.
 */
const W9_TAX_PROMPT = `You are reading a US tax form (W-9, or a W-8 series form) that a vendor submitted to a record label. Extract ONLY what is printed. Return ONLY valid JSON:
{
  "form_type": "W-9" | "W-8BEN" | "W-8BEN-E" | "unknown",
  "w9_name": "the name on line 1, exactly as printed",
  "w9_business_name": "line 2 business/DBA name, or null if blank",
  "tin_printed": "the taxpayer identification number EXACTLY as printed, including any dashes, or null if blank",
  "tin_kind": "SSN" | "EIN" | null,
  "tax_classification": "the checked box on line 3, one of: Individual/sole proprietor, C corporation, S corporation, Partnership, Trust/estate, LLC, Other. null if none is checked",
  "llc_tax_class": "if LLC is checked, the single letter written in its box (C, S or P), else null",
  "address": "the address on lines 5-6, or null",
  "signed": true | false
}
Rules: report a field as null when it is blank or you cannot read it — never guess. "tin_kind" is which box the number was written in, not an inference from its format. If both an SSN and an EIN appear, report the one that is filled in on the TIN line.`;

/** Digits only. "12-3456789" → "123456789". */
const digitsOf = (s) => String(s || '').replace(/\D/g, '');

/**
 * Is this a plausible TIN, and which kind?
 *
 * Nine digits is the only structural check the IRS format gives us, and it is
 * worth making: a mis-read that drops or adds a digit is the difference between
 * a filing and a rejection notice. The KIND comes from what the vendor was
 * asked (`tin_kind`) and falls back to the printed punctuation — `##-#######`
 * is an EIN, `###-##-####` an SSN — because the two are filed differently and
 * "nine digits" does not say which.
 *
 * @returns {{ digits: string|null, type: 'SSN'|'EIN'|null, last4: string|null, issue: string|null }}
 */
function normalizeTin(printed, kindHint) {
  const raw = String(printed || '').trim();
  if (!raw) return { digits: null, type: null, last4: null, issue: 'no TIN printed on the form' };
  const digits = digitsOf(raw);
  if (digits.length !== 9) {
    return { digits: null, type: null, last4: null,
      issue: `TIN read as ${digits.length} digit${digits.length === 1 ? '' : 's'}, not 9 — check the form by hand` };
  }
  // All-same-digit and the placeholder the form itself prints are reads of
  // something that is not a number.
  if (/^(\d)\1{8}$/.test(digits)) {
    return { digits: null, type: null, last4: null, issue: 'TIN read as nine identical digits — not a real number' };
  }
  const hinted = String(kindHint || '').toUpperCase();
  let type = hinted === 'SSN' || hinted === 'EIN' ? hinted : null;
  if (!type) {
    if (/^\d{2}-\d{7}$/.test(raw)) type = 'EIN';
    else if (/^\d{3}-\d{2}-\d{4}$/.test(raw)) type = 'SSN';
  }
  return { digits, type, last4: digits.slice(-4), issue: null };
}

/** Fold a free-text line-3 answer onto the printed vocabulary. */
function normalizeClassification(raw, llcLetter, formType) {
  const ft = String(formType || '').toUpperCase();
  if (ft.startsWith('W-8')) return FOREIGN;
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (/(^|\b)(c[\s-]?corp|c corporation)/.test(s)) return 'C corporation';
  if (/(^|\b)(s[\s-]?corp|s corporation)/.test(s)) return 'S corporation';
  if (/partnership/.test(s)) return 'Partnership';
  if (/trust|estate/.test(s)) return 'Trust/estate';
  if (/individual|sole/.test(s)) return 'Individual/sole proprietor';
  if (/llc|limited liability/.test(s)) {
    // An LLC is a pass-through UNLESS it elected corporate treatment, and the
    // form asks for that letter precisely because the answer changes whether a
    // 1099 is due. Carried in the label so nothing downstream has to guess.
    const l = String(llcLetter || '').trim().toUpperCase();
    if (l === 'C') return 'LLC (C corporation)';
    if (l === 'S') return 'LLC (S corporation)';
    if (l === 'P') return 'LLC (Partnership)';
    return 'LLC';
  }
  return 'Other';
}

/**
 * Categories where a corporation IS still 1099-reportable.
 *
 * The exceptions that make a blanket "skip corporations" wrong: gross proceeds
 * paid to an ATTORNEY are reportable whatever the firm's entity type (1099-NEC
 * box 1 for fees, 1099-MISC box 10 for gross proceeds), and so are medical and
 * health-care payments. A label pays lawyers. Matched against the live category
 * vocabulary by substring on purpose — 'Legal', 'Legal Fees' and
 * 'Artist Expense - Legal' all mean the same thing here.
 */
const CORP_STILL_REPORTABLE = [/legal/i, /attorney/i, /lawyer/i, /medical/i, /health/i];

const CORPORATE = new Set(['C corporation', 'S corporation', 'LLC (C corporation)', 'LLC (S corporation)']);

/**
 * Should this vendor be left off the 1099 run, and how sure can we be?
 *
 * Returns null when there is no reason to exclude them. Otherwise a reason the
 * UI shows and a person can override — never a silent drop. `confidence` is
 * 'certain' only where the form answers it outright and no exception category
 * is in play.
 *
 * @param {string|null} classification  normalized line 3
 * @param {string[]} categories         the spend categories that make up their total
 */
function exemptionFor(classification, categories = []) {
  if (!classification) return null;
  if (classification === FOREIGN) {
    return { exempt: true, confidence: 'certain', code: 'foreign',
      reason: 'Foreign payee (W-8 on file) — not a 1099 recipient; a 1042-S may apply instead. Ask your accountant.' };
  }
  if (!CORPORATE.has(classification)) return null;
  const exception = (categories || []).find((c) => CORP_STILL_REPORTABLE.some((re) => re.test(String(c || ''))));
  if (exception) {
    return { exempt: false, confidence: 'exception',
      code: 'corp_but_reportable',
      reason: `${classification}, but "${exception}" spend is reportable to a corporation anyway `
        + '(attorney fees and medical payments are the standard exceptions). Left IN the run.' };
  }
  return { exempt: true, confidence: 'certain', code: 'corporation',
    reason: `${classification} — corporations are generally not 1099-reportable. Confirm with your accountant.` };
}

/**
 * Turn one AI read into the fields that get stored, plus everything wrong with
 * it. `issues` is the chase list: a vendor with a W-9 we could not read is not
 * the same as a vendor with no W-9, and the difference decides who gets emailed.
 */
function parseW9Tax(ai) {
  const d = ai && typeof ai === 'object' ? ai : {};
  const tin = normalizeTin(d.tin_printed, d.tin_kind);
  const classification = normalizeClassification(d.tax_classification, d.llc_tax_class, d.form_type);
  const issues = [];
  if (tin.issue) issues.push(tin.issue);
  if (!classification) issues.push('no tax classification box checked on line 3');
  if (d.signed === false) issues.push('the form is not signed');
  return {
    form_type: d.form_type || 'unknown',
    w9_name: d.w9_name || null,
    w9_business_name: d.w9_business_name || null,
    address: d.address || null,
    tin_digits: tin.digits,
    tin_type: tin.type,
    tin_last4: tin.last4,
    tax_classification: classification,
    signed: d.signed === true,
    issues,
  };
}

module.exports = {
  W9_TAX_PROMPT, TAX_CLASSIFICATIONS, FOREIGN, CORPORATE, CORP_STILL_REPORTABLE,
  normalizeTin, normalizeClassification, exemptionFor, parseW9Tax, digitsOf,
};
