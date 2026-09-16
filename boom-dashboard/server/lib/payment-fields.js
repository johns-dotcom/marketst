/**
 * What we need in order to actually pay a vendor, per payment method — and
 * whether what they typed agrees with what their invoice says.
 *
 * ── Why this exists as its own module ──
 * Before this, the app collected a payment PREFERENCE ("ACH") and a bank NAME
 * ("Chase") and nothing else. The account number, routing number, IBAN and
 * PayPal handle lived only inside the uploaded PDF, so paying somebody meant
 * opening their invoice and reading it off — and an invoice that did not print
 * them was REFUSED, with the vendor told to edit their document and re-upload.
 * That refusal is the case this whole change is about: the form should ask for
 * what the invoice forgot, not bounce the vendor.
 *
 * Everything here is PURE. That is deliberate and not merely tidy: the document
 * side of the comparison comes from an AI extraction, dev has no
 * ANTHROPIC_API_KEY, and a verdict that can only be exercised against a live
 * model is a verdict nobody tests. The route wires this up; the fixture tests it
 * exhaustively.
 *
 * ── One definition, two callers ──
 * The submit route and the fixture both import from here, so the rule a vendor
 * is held to and the rule that is tested cannot drift. (The browser has its own
 * copy of the field LIST for rendering, but the server is the authority — a
 * check only the browser performs is a request, not a requirement, which is
 * exactly how 11 songless and 35 social-less rows got in.)
 */

/** The three methods the form offers. Anything else is refused outright. */
const PAYMENT_METHODS = ['ACH', 'Wire', 'PayPal'];

/**
 * Field spec per method. `key` is the form field name; `label` is what the
 * vendor is told when it is missing, in the same words the browser uses.
 */
const FIELDS_BY_METHOD = {
  ACH: [
    { key: 'payment_account_number', label: 'account number' },
    { key: 'payment_routing_number', label: 'routing number' },
    { key: 'payment_account_type',   label: 'account type (checking or savings)' },
    { key: 'payment_holder_name',    label: 'name on the account' },
    { key: 'payment_bank_name',      label: 'bank name' },
    { key: 'payment_bank_address',   label: 'bank address' },
  ],
  // Wire is NOT a flat list — see FIELDS_BY_WIRE_SCOPE. `fieldsFor()` is the
  // accessor; reading FIELDS_BY_METHOD.Wire directly gets you undefined, on
  // purpose, so a caller that has not been taught about the scope fails loudly
  // instead of silently requiring nothing.
  PayPal: [
    { key: 'payment_paypal', label: 'PayPal email or handle' },
  ],
};

/**
 * A wire is two different instruments wearing one name.
 *
 * A DOMESTIC US wire needs the receiving bank's ABA routing number and the
 * account number, and that is genuinely most of it — Fedwire identifies the bank
 * from the ABA, so there is no IBAN and no SWIFT to give. Requiring them was the
 * "required field with no correct answer" problem all over again, one field
 * along: a US vendor either invents something or gives up.
 *
 * An INTERNATIONAL wire needs an IBAN or a SWIFT/BIC, and the addresses actually
 * matter — correspondent banks reject on a missing beneficiary address.
 *
 * So the vendor is asked WHERE THEIR BANK IS first, and the rest follows from
 * that answer rather than from a single worst-case list.
 */
const WIRE_SCOPES = ['Domestic', 'International'];

const FIELDS_BY_WIRE_SCOPE = {
  Domestic: [
    { key: 'payment_routing_number', label: 'routing number (ABA)' },
    { key: 'payment_account_number', label: 'account number' },
    { key: 'payment_holder_name',    label: 'name on the account' },
    { key: 'payment_bank_name',      label: 'bank name' },
    // Bank address and beneficiary address are OPTIONAL here. The ABA already
    // identifies the bank, and "sometimes wires just need routing and account"
    // is the case this scope exists to serve.
  ],
  International: [
    { key: 'payment_iban_swift',          label: 'IBAN or SWIFT/BIC code' },
    { key: 'payment_holder_name',         label: 'name on the account' },
    { key: 'payment_bank_name',           label: 'bank name' },
    { key: 'payment_bank_address',        label: 'bank address' },
    { key: 'payment_beneficiary_address', label: 'beneficiary address' },
    // The account number is conditionally required — see validatePaymentFields.
    // An IBAN CONTAINS the account number, so demanding it twice is redundant;
    // a SWIFT/BIC identifies only the bank, so then it is essential.
  ],
};

/**
 * The required field list for a submission. Wire depends on its scope, so this
 * needs the values, not just the method.
 */
function fieldsFor(method, values = {}) {
  if (method !== 'Wire') return FIELDS_BY_METHOD[method] || [];
  const scope = matchWireScope(values.payment_wire_scope);
  return scope ? FIELDS_BY_WIRE_SCOPE[scope] : [];
}

/** Optional fields — rendered and stored, never required. */
const OPTIONAL_FIELDS_BY_METHOD = {
  ACH: [],
  Wire: [{ key: 'payment_intermediary_bank', label: 'intermediary / correspondent bank' }],
  PayPal: [],
};

/**
 * ACH files carry a transaction code that differs for checking vs savings, so
 * this is not decoration — the wrong one is a returned payment.
 */
const ACCOUNT_TYPES = ['Checking', 'Savings'];

/**
 * Accept how people actually describe it — "domestic", "US", "usa", "intl" —
 * and return the canonical value, or '' if it is neither.
 */
function matchWireScope(v) {
  const t = String(v ?? '').trim().toLowerCase();
  if (!t) return '';
  if (t.startsWith('dom') || t === 'us' || t === 'usa' || t === 'united states') return 'Domestic';
  if (t.startsWith('int') || t.startsWith('for') || t.startsWith('abroad')) return 'International';
  return '';
}

const clean = (s) => String(s ?? '').trim();
/** Digits only — account and routing numbers are written with spaces and dashes. */
const digits = (s) => clean(s).replace(/[^0-9]/g, '');
/** Letters and digits, upper-cased — how IBAN and SWIFT are compared. */
const alnum = (s) => clean(s).replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/**
 * ABA checksum. A routing number is nine digits with a weighted mod-10 check, so
 * a single mistyped digit is CATCHABLE — and worth catching, because the failure
 * mode otherwise is a payment that bounces days later, or worse, one that lands
 * somewhere else.
 */
function validAba(routing) {
  const d = digits(routing);
  if (d.length !== 9) return false;
  const n = d.split('').map(Number);
  const sum = 3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8]);
  return sum % 10 === 0;
}

/** IBAN: 2 country letters, 2 check digits, then up to 30 alphanumerics. */
const looksLikeIban = (v) => /^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(alnum(v));
/** SWIFT/BIC: 8 or 11 characters, bank(4) country(2) location(2) [branch(3)]. */
const looksLikeSwift = (v) => /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(alnum(v));

/**
 * Accept what a vendor actually types — "checking", "Checking Account", "CHK" —
 * and return the canonical value, or '' if it is neither. Returning a canonical
 * string rather than a boolean means the column only ever holds one of two
 * values, so a downstream ACH file never has to re-interpret free text.
 */
function matchAccountType(v) {
  const s = clean(v).toLowerCase();
  if (!s) return '';
  if (s.startsWith('check') || s === 'chk') return 'Checking';
  if (s.startsWith('sav') || s === 'svg') return 'Savings';
  return '';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** PayPal is reached by an email address or an @handle — accept either. */
const looksLikePaypal = (v) => {
  const s = clean(v);
  if (EMAIL_RE.test(s)) return true;
  return /^@?[A-Za-z0-9._-]{3,}$/.test(s);
};

/**
 * Validate the payment block for a method.
 *
 * @param {string} method  one of PAYMENT_METHODS
 * @param {object} values  raw form values, keyed as in FIELDS_BY_METHOD
 * @returns {{ ok: boolean, errors: string[], normalized: object }}
 *   `errors` are vendor-facing sentences, in field order, so the first one is
 *   also the sensible single message for a 400.
 */
function validatePaymentFields(method, values = {}) {
  const errors = [];
  if (!PAYMENT_METHODS.includes(method)) {
    return { ok: false, errors: ['Please select your preferred payment method.'], normalized: {} };
  }
  // Wire needs its scope before anything else can be asked for: the required
  // list IS the answer to that question. Refused first and alone, so a domestic
  // vendor is never shown a demand for an IBAN.
  if (method === 'Wire') {
    const scope = matchWireScope(values.payment_wire_scope);
    if (!scope) {
      return {
        ok: false,
        errors: ['Please tell us whether your bank is in the US (domestic wire) or outside the US (international wire).'],
        normalized: {},
      };
    }
  }

  const spec = fieldsFor(method, values);
  const normalized = {};

  for (const f of spec) {
    if (!clean(values[f.key])) {
      errors.push(`Please enter your ${f.label} — we cannot pay you without it.`);
    }
  }
  // Shape checks run only on fields that were actually provided, so a vendor
  // never sees "that isn't a valid routing number" about a box they left empty.
  if (method === 'ACH') {
    const acct = digits(values.payment_account_number);
    const rout = digits(values.payment_routing_number);
    if (clean(values.payment_account_number) && (acct.length < 4 || acct.length > 17)) {
      errors.push('That account number does not look right — US account numbers are 4 to 17 digits.');
    }
    if (clean(values.payment_routing_number) && !validAba(rout)) {
      errors.push('That routing number does not look right — it should be the 9-digit ABA number on the bottom of a check.');
    }
    const type = matchAccountType(values.payment_account_type);
    if (clean(values.payment_account_type) && !type) {
      errors.push('Please choose whether that is a checking or a savings account.');
    }
    normalized.account_number = acct;
    normalized.routing_number = rout;
    normalized.account_type = type;
    normalized.holder_name = clean(values.payment_holder_name);
    normalized.bank_name = clean(values.payment_bank_name);
    normalized.bank_address = clean(values.payment_bank_address);
  } else if (method === 'Wire') {
    const scope = matchWireScope(values.payment_wire_scope);
    normalized.wire_scope = scope;
    normalized.holder_name = clean(values.payment_holder_name);
    normalized.bank_name = clean(values.payment_bank_name);
    normalized.bank_address = clean(values.payment_bank_address);
    normalized.beneficiary_address = clean(values.payment_beneficiary_address);
    normalized.intermediary_bank = clean(values.payment_intermediary_bank);

    if (scope === 'Domestic') {
      // A US wire is an ABA and an account number. Same checksum as ACH — the
      // wire routing number and the ACH one are usually the same nine digits,
      // and a mistyped one fails the same way.
      const acct = digits(values.payment_account_number);
      const rout = digits(values.payment_routing_number);
      if (clean(values.payment_account_number) && (acct.length < 4 || acct.length > 17)) {
        errors.push('That account number does not look right — US account numbers are 4 to 17 digits.');
      }
      if (clean(values.payment_routing_number) && !validAba(rout)) {
        errors.push('That routing number does not look right — it should be the 9-digit ABA number on the bottom of a check.');
      }
      normalized.account_number = acct;
      normalized.routing_number = rout;
      normalized.iban_swift = '';
    } else {
      const v = values.payment_iban_swift;
      const isIban = looksLikeIban(v);
      const isSwift = looksLikeSwift(v);
      if (clean(v) && !isIban && !isSwift) {
        errors.push('That does not look like an IBAN or a SWIFT/BIC code. IBANs start with two letters and two digits; SWIFT codes are 8 or 11 characters.');
      }
      // Conditionally required, and this is the point of the branch: an IBAN
      // already CONTAINS the account number, so asking again is a box with no
      // new answer. A SWIFT/BIC names only the bank, so without an account
      // number the payment has no destination.
      const wireAcct = clean(values.payment_account_number);
      if (isSwift && !isIban && !wireAcct) {
        errors.push('Please enter your account number — a SWIFT/BIC code identifies your bank but not your account.');
      }
      // The US 4-to-17-DIGIT rule is deliberately NOT applied here. Foreign
      // account numbers carry letters and run longer, so borrowing the ACH check
      // would reject correct details — the exact failure this module exists to stop.
      if (wireAcct && alnum(wireAcct).length < 4) {
        errors.push('That account number does not look right — it is too short.');
      }
      normalized.iban_swift = alnum(v);
      normalized.account_number = alnum(wireAcct);
      normalized.routing_number = '';
    }
  } else {
    const v = values.payment_paypal;
    if (clean(v) && !looksLikePaypal(v)) {
      errors.push('That does not look like a PayPal email address or handle.');
    }
    normalized.paypal = clean(v).replace(/^@/, '');
  }
  return { ok: errors.length === 0, errors, normalized };
}

/**
 * A frozen copy of HOW this invoice was to be paid, for storing on the entry.
 *
 * ── Why the entry needs its own copy ──
 * `vendor_payment_details` is a PROFILE: one row per vendor, overwritten on every
 * submission (ON CONFLICT DO UPDATE, no history). That is right for paying
 * somebody today and wrong for reading an invoice from six months ago — by then
 * the card has been rewritten and the question "which account did THIS actually
 * go to?" can only be answered with "wherever they bank now". Address book
 * versus shipping label: we kept the address book and threw the label away.
 *
 * The entry already carried `payment_method`, `vendor_bank` and `payment_last4`,
 * so the loss was partial rather than total — but account type, wire scope,
 * holder name and the addresses were gone.
 *
 * ── What is deliberately NOT in here ──
 * The account number, the routing number and the IBAN. Those stay single-copy
 * and encrypted in the profile. Copying a secret onto every invoice row
 * multiplies the blast radius of a key compromise by the number of invoices and
 * buys nothing: `last4` already identifies WHICH account this row pointed at,
 * and the full value is one lookup away for the one caller allowed to decrypt.
 *
 * Keep this function pure and keep it the only place the shape is built — the
 * route stores it, `changed_from` embeds the previous one, and the fixture
 * asserts against it.
 */
function buildPaymentSnapshot(method, normalized = {}, extra = {}) {
  const snap = {
    method,
    holder_name: normalized.holder_name || null,
    bank_name: normalized.bank_name || null,
    last4: last4(method, normalized),
  };
  if (method === 'ACH') {
    snap.account_type = normalized.account_type || null;
    snap.bank_address = normalized.bank_address || null;
  } else if (method === 'Wire') {
    // The scope is the single most useful field here and the one with no other
    // home: it lives only on the profile, so without this a paid wire could not
    // say whether it went out as a domestic ABA transfer or an international one.
    snap.wire_scope = normalized.wire_scope || null;
    snap.bank_address = normalized.bank_address || null;
    snap.beneficiary_address = normalized.beneficiary_address || null;
    snap.intermediary_bank = normalized.intermediary_bank || null;
  } else if (method === 'PayPal') {
    // The handle IS the destination and is not a secret — it is what you type
    // into PayPal to pay somebody, and it is already stored in plain text on the
    // profile for exactly that reason.
    snap.paypal = normalized.paypal || null;
    // And `last4` is dropped here rather than shown. For an email handle it is
    // the last four CHARACTERS — "a@b.com" masks to ".com", which identifies
    // nothing and reads like a real masked value. The handle above is the
    // identity. (`payment_last4` on the entry has the same quirk; that column is
    // long-standing and compared against elsewhere, so it is left alone.)
    delete snap.last4;
  }
  if (extra.reused_on_file) snap.reused_on_file = true;
  return snap;
}

/** The value a method is identified by — what gets masked, compared and shown. */
function primaryValue(method, normalized = {}) {
  if (method === 'ACH') return normalized.account_number || '';
  // A DOMESTIC wire has no IBAN, so identity falls back to the account number.
  // Without this fallback `payment_last4` was null for every domestic wire and
  // the changed_from flag could never fire — the two things that make a swapped
  // account visible.
  if (method === 'Wire') return normalized.iban_swift || normalized.account_number || '';
  return normalized.paypal || '';
}

/** Last four characters of the identifying value — the only part ever displayed. */
function last4(method, normalized = {}) {
  const v = primaryValue(method, normalized);
  return v ? String(v).slice(-4) : null;
}

/**
 * Does what the vendor typed agree with what their invoice shows?
 *
 * The AI extraction (`parsePaymentInfo` in routes/vendor-submit.js) already
 * pulls `ach_account_number`, `ach_routing_number`, `wire_swift_or_iban` and
 * `paypal_identifier` off the document. Until now that result was used only to
 * REFUSE a submission. Here it becomes evidence instead.
 *
 * Four verdicts, and the distinction between the last two is the point:
 *   match      the document and the form agree — the strongest state, and the
 *              one that preserves what the old blocking rule was protecting.
 *   mismatch   the document says one account and the form says another. This is
 *              the case worth a human's attention, so it is flagged, not blocked.
 *   absent     the document shows nothing for this method. NO LONGER A REFUSAL —
 *              it is the whole reason the form now asks.
 *   unscanned  the AI was unavailable. Falls open, exactly as the invoice-number
 *              gate already does.
 *
 * @param {string} method
 * @param {object} normalized  from validatePaymentFields
 * @param {object|null} docInfo  the AI extraction, or null/{ok:false}
 */
function comparePaymentDetails(method, normalized, docInfo) {
  const typed = primaryValue(method, normalized);
  const base = { method, typed_last4: typed ? String(typed).slice(-4) : null, doc_last4: null };
  if (!docInfo || docInfo.ok !== true) return { ...base, verdict: 'unscanned' };

  // A DOMESTIC wire prints a routing number and an account number, which the
  // extraction reports as `ach_account_number` — there is no IBAN on the page to
  // find. Comparing it against `wire_swift_or_iban` therefore found nothing and
  // returned 'absent' for every domestic wire, which reads as "the invoice was
  // silent" when the invoice said exactly what it should.
  const isDomesticWire = method === 'Wire' && normalized.wire_scope === 'Domestic';
  const docRaw = method === 'ACH' || isDomesticWire ? docInfo.ach_account_number
    : method === 'Wire' ? docInfo.wire_swift_or_iban
      : docInfo.paypal_identifier;
  const docVal = method === 'PayPal'
    ? clean(docRaw).replace(/^@/, '').toLowerCase()
    : (method === 'ACH' || isDomesticWire ? digits(docRaw) : alnum(docRaw));
  if (!docVal) {
    // The document may still carry a DIFFERENT method's details — say so, so an
    // approver reading "absent" knows whether the invoice was silent or simply
    // paid a different way.
    const others = [
      docInfo.ach_account_number && !isDomesticWire ? 'ACH' : null,
      docInfo.wire_swift_or_iban ? 'Wire' : null,
      docInfo.paypal_identifier ? 'PayPal' : null,
      docInfo.venmo_or_zelle ? 'Venmo/Zelle' : null,
      docInfo.cashapp ? 'CashApp' : null,
      docInfo.check_payable_to ? 'Check' : null,
    ].filter(Boolean).filter((m) => m !== method);
    return { ...base, verdict: 'absent', doc_other_methods: others.length ? others : null };
  }
  const typedCmp = method === 'PayPal' ? String(typed).toLowerCase() : String(typed);
  return {
    ...base,
    doc_last4: docVal.slice(-4),
    verdict: typedCmp === docVal ? 'match' : 'mismatch',
  };
}

module.exports = {
  PAYMENT_METHODS, FIELDS_BY_METHOD, OPTIONAL_FIELDS_BY_METHOD, ACCOUNT_TYPES,
  WIRE_SCOPES, FIELDS_BY_WIRE_SCOPE, fieldsFor,
  validatePaymentFields, comparePaymentDetails, buildPaymentSnapshot, primaryValue, last4,
  validAba, looksLikeIban, looksLikeSwift, looksLikePaypal,
  matchAccountType, matchWireScope,
};
