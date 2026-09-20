// Bank Statements — upload BofA / PayPal statements, parse transactions, and
// reconcile them against the ledger. Read access and every action here is
// Admin/Superadmin only (NOT Approver): statements carry account balances.
//
// Matching model: bank DEBITS match ledger *families* (parent + split
// children). A family accepts multiple debits up to its combined total —
// installments pay one slice per wire — but never beyond capacity.
// Matches persist on bank_transactions.matched_expense_id (always the family
// root id), so re-running the matcher or uploading next month's statement
// never re-litigates confirmed history.
const express = require('express');
const multer = require('multer');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { uploadFile, downloadFile } = require('../lib/r2');
const { vendorsMatch, sameSquashedName } = require('../lib/vendorMatch');
const { normalizeInvoiceNum } = require('../lib/normalize-invoice-num');
const { excludeCreatorRows, movedMatchMethodSql, CREATOR_SOURCE } = require('../lib/ledger-source');
const { noBankEvidenceSql, paidUnmatchedSql, awaitingStatementSql } = require('../lib/bank-evidence');
const { callClaude } = require('../services/claude');
const { parseStatementPdfText } = require('../lib/statement-pdf');
const { diffReparseRows, refFromDescription, findMisfiled } = require('../lib/reparse-diff');
const { findExtras } = require('../lib/statement-extras');
const { getHistorical, getCached } = require('../services/fx');
// Is each statement proved, and is one missing? Pure — see lib/statement-integrity.
const { verdictFor, expectedNext, businessGapBetween, pairingFromCounts, day: sDay } = require('../lib/statement-integrity');
const { usdOf } = require('../lib/usd');
// Six buckets that partition a statement's debits, three its credits — one
// definition, so the library's coverage and the matching queue cannot disagree.
const { bucketKey, DEBIT_BUCKETS, CREDIT_BUCKETS } = require('../lib/statement-buckets');
const { groupsByKeys } = require('../lib/settlement-groups');
const { autoLinkRelease } = require('../lib/release-linking');
// Whether the one-payment-many-invoices link table exists yet. Migrations run in
// the background after app.listen, so writes have to check rather than assume.
const { linksAreReady, markLinksReady } = require('../lib/bank-evidence');
const { WINDOW_DAYS, PULL_SQL, namesRecipient: descriptorNames, descriptorMentions, dayGap, looksLikePull, pairTier,
  allocateFundingPairs, scoreFundingLegs } = require('../lib/funding-pairs');
const { spellingsOf, buildEmailIndex } = require('../lib/payee-spellings');
const { carryEntryState } = require('../lib/carry-entry-state');
const { namesAnArtist, artistLabel } = require('../lib/artist-key');

const router = express.Router();
router.use(authMiddleware);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
});

// Stricter than the bookkeeping isAdmin — Approvers do NOT get statements.
const isStrictAdmin = (u) => u && (u.role === 'Admin' || u.role === 'Superadmin');

const ACCOUNTS = new Set(['bofa', 'paypal']);

async function audit(user, action, entryId, payee, details) {
  await pool.query(
    `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
     VALUES ($1,$2,$3,$4,NULL,NULL,NULL,$5)`,
    [user?.name || user?.email || 'unknown', action, entryId || null, payee || null, details || null]
  ).catch(() => {});
}

// ── CSV parsing ──────────────────────────────────────────────────────────────

function parseCSVRow(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  result.push(current.trim());
  return result;
}

const num = (s) => {
  const n = parseFloat(String(s ?? '').replace(/[$,\s"]/g, '').replace(/^\((.*)\)$/, '-$1'));
  return Number.isFinite(n) ? n : null;
};

const toISO = (s) => {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);           // MM/DD/YYYY
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);                       // already ISO
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
};

// Pull a human payee out of a BofA description line. These are noisy:
//   "WIRE TYPE:WIRE OUT DATE:240705 TIME:0932 ET TRN:X BNF:EDUARDO ROHSLER..."
//   "ACME CO     DES:PAYMENTS   ID:12345 INDN:MARKET STREET  CO ID:..."
//   "CHECKCARD 0712 SWEETWATER SOUND 800-2224700 IN 2449..."
//   "Zelle payment to Jane Doe Conf# abc123"
function bofaPayee(desc) {
  const d = String(desc || '');
  let m = d.match(/BNF:([^;]+?)(?:\s{2,}|BNF BK|ACCT:|OBI:|$)/i);
  if (m) return m[1].trim();
  // Incoming wires name the counterparty as the ORIGinator, not a beneficiary.
  // Without this, every "WIRE TYPE:WIRE IN ..." descriptor falls through to the
  // generic tail split and yields "WIRE TYPE:WIRE IN DATE: ..." as the payee —
  // useless for matching, and these are the advances and distributions.
  m = d.match(/ORIG:\/?([^;]+?)(?:\s+ID:|\s+SND BK:|\s+ORIG BK:|\s{2,}|$)/i);
  if (m && m[1].trim()) return m[1].trim();
  // "TRANSFER MARKET STREET:LASZEWO LLC Confirmation# 1336263610" — the name
  // before the colon is OUR account, the counterparty comes after it. Without
  // this the generic tail-split returns the whole descriptor as the payee (there
  // is no double-space, ID: or TRN: to split on), which is worse than what the
  // AI path produced and breaks anything keyed on payee: reversal pairing, name
  // evidence in the matcher, vendor grouping.
  m = d.match(/^(?:TRANSFER|REVERSAL)\s+[^:]*:\s*(.+?)(?:\s+Confirmation#|\s{2,}|$)/i);
  if (m && m[1].trim()) return m[1].trim();
  m = d.match(/Zelle payment to ([^;]+?)(?:\s+Conf#|$)/i);
  if (m) return m[1].trim();
  m = d.match(/^CHECKCARD\s+\d{4}\s+(.+?)(?:\s+\d{3}-|\s{2,}|$)/i);
  if (m) return m[1].trim();
  m = d.match(/^(.*?)\s+DES:/i);
  if (m && m[1].trim()) return m[1].trim();
  // Fall back to the first chunk before a run of digits/codes
  return d.split(/\s{2,}|\sID:|\sTRN:/)[0].slice(0, 80).trim();
}

// account: 'bofa' | 'paypal' → rows of
// { txn_date, description, payee_guess, amount, direction, currency, reference, fee }
function parseStatementCSV(rawText, account) {
  const lines = rawText.split('\n').map((l) => l.replace(/\r$/, ''));

  // Both banks put summary/preamble rows above the real header.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(30, lines.length); i++) {
    const lower = lines[i].toLowerCase();
    if (lower.includes('date') &&
        (lower.includes('amount') || lower.includes('gross') || lower.includes('description') || lower.includes('name'))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return { error: 'Could not find a header row with Date + Amount columns.', rows: [] };

  const headers = parseCSVRow(lines[headerIdx]).map((h) => h.toLowerCase().replace(/[^a-z0-9 /#]/g, '').trim());
  const find = (...cands) => headers.findIndex((h) => cands.some((c) => h === c || h.includes(c)));

  const col = {
    date: find('date'),
    description: find('description', 'memo', 'narration'),
    name: find('name', 'payee', 'counterparty'),
    type: find('type'),
    status: find('status'),
    amount: find('amount'),
    gross: find('gross'),
    fee: find('fee'),
    net: find('net'),
    currency: find('currency'),
    reference: find('transaction id', 'reference', 'ref', 'confirmation'),
    email: find('to email address', 'email'),
    balance: find('running bal', 'balance'),
  };
  if (col.date === -1) return { error: 'No Date column found.', rows: [] };
  if (col.amount === -1 && col.gross === -1) return { error: 'No Amount (or Gross) column found.', rows: [] };

  const rows = [];
  let endingBalance = null; // last balance value seen = the statement's close
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = parseCSVRow(lines[i]);
    if (cells.length < 2 || cells.every((c) => !c)) continue;
    const get = (idx) => (idx >= 0 && idx < cells.length ? cells[idx] : '');
    const bal = num(get(col.balance));
    if (bal !== null) endingBalance = bal;

    const txn_date = toISO(get(col.date));
    if (!txn_date) continue; // summary/balance rows

    if (account === 'paypal') {
      const status = get(col.status);
      if (status && !/^completed$/i.test(status)) continue;
      const gross = num(get(col.gross) || get(col.amount));
      if (gross === null || gross === 0) continue;
      const type = get(col.type);
      // Internal ledger noise, not real money movement against a vendor
      if (/currency conversion|bank deposit to pp|general withdrawal|account hold|reversal of general account hold/i.test(type)) continue;
      const pp = splitPayeeEmail(get(col.name), get(col.email));
      rows.push({
        txn_date,
        description: [type, pp.name].filter(Boolean).join(' — '),
        payee_guess: pp.name || type || '',
        payee_email: pp.email,
        amount: Math.abs(gross),
        direction: gross < 0 ? 'debit' : 'credit',
        currency: (get(col.currency) || 'USD').toUpperCase(),
        reference: get(col.reference) || null,
        fee: Math.abs(num(get(col.fee)) || 0) || null,
      });
    } else {
      const amount = num(get(col.amount));
      if (amount === null || amount === 0) continue;
      const description = get(col.description);
      const pp = splitPayeeEmail(bofaPayee(description), '');
      rows.push({
        txn_date,
        description,
        payee_guess: pp.name,
        payee_email: pp.email,
        amount: Math.abs(amount),
        direction: amount < 0 ? 'debit' : 'credit',
        currency: 'USD',
        reference: get(col.reference) || null,
        fee: null,
      });
    }
  }
  if (!rows.length) return { error: 'Found the header but no transaction rows parsed.', rows: [] };
  return { error: null, rows, endingBalance };
}

// ── Upload ───────────────────────────────────────────────────────────────────

// Insert parsed rows, skipping transactions that already exist in ANOTHER
// statement of the same account (same date + amount + direction, and same
// reference when both sides have one, else identical description). A
// re-uploaded or overlapping statement can't double-book the month —
// critical now that category rules write ledger entries unattended.
async function insertRows(st, rows) {
  let inserted = 0;
  let dupSkipped = 0;
  for (const r of rows) {
    // Fill the reference from the descriptor when the parse left it empty, so
    // the check below has the one field that identifies a payment.
    const ref = String(r.reference || '').trim() || refFromDescription(r.description);
    const { rows: [dup] } = await pool.query(
      `SELECT 1 FROM bank_transactions bt
         JOIN bank_statements s ON s.id = bt.statement_id
        WHERE s.account = $1
          AND bt.txn_date = $3 AND bt.amount = $4 AND bt.direction = $5
          AND (
            -- Another statement of the same account: an overlapping or
            -- re-uploaded month must not double-book the period.
            (bt.statement_id != $2 AND (
              (COALESCE($6::text, '') != '' AND bt.reference = $6)
              OR (COALESCE($6::text, '') = '' AND bt.description = $7)))
            -- THIS statement, but only on a real reference. Two identical
            -- charges on one day are ordinary — several statements that
            -- reconcile to the cent contain them — so within a statement only
            -- the payment's own identifier may collapse two rows into one.
            OR (bt.statement_id = $2 AND COALESCE($6::text, '') != ''
                AND (bt.reference = $6 OR bt.description LIKE '%' || $6 || '%'))
          )
        LIMIT 1`,
      [st.account, st.id, r.txn_date, r.amount, r.direction, ref || null, r.description]);
    if (dup) { dupSkipped++; continue; }
    await pool.query(
      `INSERT INTO bank_transactions (statement_id, txn_date, description, payee_guess, payee_email, amount, direction, currency, reference, fee, amount_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [st.id, r.txn_date, r.description, r.payee_guess, r.payee_email || null, r.amount, r.direction, r.currency, ref || null, r.fee, r.amount_usd ?? null]
    );
    inserted++;
  }
  const internalDismissed = await dismissInternal(st.id);
  const ruleDismissed = await applyDismissRules(st.id);
  return { inserted, dupSkipped, ruleDismissed: ruleDismissed + internalDismissed };
}

// Escape ILIKE metacharacters — a payee containing % or _ must match
// literally, not as a wildcard.
const likeEscape = (s) => String(s).replace(/[\\%_]/g, (m) => '\\' + m);

// Statements show name and email as separate facts — keep them separate.
// Also rescues older rows / model output where they arrived mashed together
// ("quick motor / nathanthompson59@msn.com").
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
function splitPayeeEmail(rawName, rawEmail) {
  let name = String(rawName || '').trim();
  let email = String(rawEmail || '').trim().toLowerCase();
  const embedded = name.match(EMAIL_RE);
  if (embedded) {
    if (!email) email = embedded[0].toLowerCase();
    name = name.replace(EMAIL_RE, '').replace(/\s*[/·|,-]\s*$/, '').replace(/^\s*[/·|,-]\s*/, '').trim();
  }
  if (!EMAIL_RE.test(email)) email = '';
  return { name, email: email ? email.slice(0, 200) : null };
}

// Internal money movement — conversions, withdrawals to bank, holds,
// reversals, cross-account transfers. Not vendor spend: these must never
// match, never suggest, and never sit in Open. Auto-dismissed on every
// parse path (the CSV parser filtered some of these; the PDF path did not,
// and one currency conversion false-matched an invoice by bare amount).
const INTERNAL_NOISE = [
  'currency conversion', 'reversal of ach', 'bank deposit to pp',
  'user initiated withdrawal', 'general withdrawal', 'account hold',
  'paypal transfer', 'transfer to bank', 'withdrawal to bank',
  'general card deposit', 'money transfer',
];
const isInternal = (desc) => {
  const d = String(desc || '').toLowerCase();
  return INTERNAL_NOISE.some((p) => d.includes(p));
};
const INTERNAL_ILIKE = INTERNAL_NOISE.map((p) => `%${p}%`);

async function dismissInternal(statementId) {
  // Both directions — internal movement is noise whether money left or
  // arrived (a transfer-in isn't revenue any more than a transfer-out is spend).
  const { rowCount } = await pool.query(
    `UPDATE bank_transactions SET dismissed = true, dismissed_reason = 'internal transfer / conversion'
      WHERE statement_id = $1 AND dismissed = false
        AND matched_expense_id IS NULL AND matched_income_id IS NULL
        AND description ILIKE ANY($2)`,
    [statementId, INTERNAL_ILIKE]).catch(() => ({ rowCount: 0 }));
  return rowCount || 0;
}

// Income categories for booking statement credits — kept separate from the
// expense CATEGORIES; these become artist_income.income_type values.
//
// This was a third hardcoded copy (alongside client/src/constants.js and
// server/lib/constants.js). Now it's the seed list only — the live vocabulary
// lives in bk_categories, because income types are user-extendable. Use
// isKnownIncomeType() to check a submitted value, never this array.
const { INCOME_CATEGORIES } = require('../lib/constants');

// Is this a bookable income type? Checks the live table, falling back to the
// seed constants if the query fails.
//
// The previous code tested `INCOME_CATEGORIES.includes(x) ? x : 'Other Income'`
// against the hardcoded array, which meant any income type an admin added was
// SILENTLY rewritten to 'Other Income' — the booking appeared to succeed while
// landing in the wrong report line. Custom types have to pass this gate.
async function isKnownIncomeType(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM bk_categories
        WHERE kind = 'income' AND active = TRUE AND LOWER(TRIM(name)) = LOWER($1)`, [v]);
    if (rows.length) return true;
    // An inactive-but-known type is still a legitimate value to write — it
    // just isn't offered in new dropdowns.
    const { rows: inactive } = await pool.query(
      `SELECT 1 FROM bk_categories
        WHERE kind = 'income' AND LOWER(TRIM(name)) = LOWER($1)`, [v]);
    return inactive.length > 0;
  } catch {
    return INCOME_CATEGORIES.includes(v);
  }
}

// Obvious-overhead pre-tagging: rideshares and bank/processing fees get a
// suggested category so the swipe review books them in one gesture. These
// SUGGEST — nothing books without a confirm (per John's call).
const CATEGORY_SUGGESTIONS = [
  // Meals FIRST so any Uber Eats descriptor variant ("UBER EATS",
  // "UBER *EATS", "UBEREATS 800...") wins before the Uber→Travel rule.
  { re: /uber\s*\*?\s*eats|ubereats/i, category: 'Meals & Entertainment' },
  { re: /\buber\b(?!\s*\*?\s*eats)|\blyft\b|\btaxi\b|rideshare|\bparking\b|\bshell oil|\bchevron\b|\bexxon\b|\barco\b|gas station/i, category: 'Travel' },
  { re: /\bairlines?\b|\bdelta air\b|\bunited air|american air|jetblue|southwest air|\bhotel\b|marriott|hilton|airbnb|\bamtrak\b|hertz|enterprise rent/i, category: 'Travel' },
  // Generic "<bank word> fee" — covers wire/transfer/ATM/account/etc. variants
  // like "External transfer fee - Next Day" without matching vendor fees
  // ("producer fee" stays uncategorized).
  { re: /\b(wire|transfer|ach|atm|withdrawal|deposit|account|card|check|statement|analysis|annual|monthly|maintenance|service|servicing|processing|transaction|conversion|currency|bank|paypal|overdraft|late payment|stop payment|returned? item|nsf) fees?\b|service charge|overdraft|nsf\b|insufficient funds|foreign transaction|intl? transaction/i, category: 'Bank Fees' },
  // Two-signal fallback: any "fee" wording on a debit whose payee/description
  // names a bank or processor.
  { test: (hay) => /\bfees?\b|\bcharge\b/i.test(hay) && /bank of america|wells fargo|\bchase\b|jpmorgan|citibank|\bciti\b|capital one|\bpnc\b|td bank|us bank|\bhsbc\b|paypal|\bvenmo\b|\bstripe\b|\bsquare\b|\bwise\b|mercury/i.test(hay), category: 'Bank Fees' },
  { re: /uber ?eats|doordash|grubhub|postmates|seamless|caviar\b|restaurant|\bcafe\b|\bcafé\b|catering|\bdiner\b|pizzeria|\bsushi\b|starbucks|chipotle|mcdonald|dunkin|sweetgreen|shake shack|\bgrill\b|\bbistro\b|steakhouse|taqueria|\bbbq\b|\bdeli\b/i, category: 'Meals & Entertainment' },
  { re: /\badobe\b|dropbox|\bslack\b|zoom\.us|\bzoom\b video|notion\.so|\bnotion\b labs|figma|canva|apple\.com\/bill|openai|anthropic|github|godaddy|squarespace|wix\.com|mailchimp|\baws\b|amazon web services|railway\.app|vercel|google ?(workspace|one|storage)|gsuite|icloud|microsoft 365|splice\b|izotope|waves audio|native instruments/i, category: 'Software / Subscriptions' },
  { re: /fedex|\bups\b store|\busps\b|\bdhl\b/i, category: 'Services' },
  { re: /\bgusto\b|\badp\b|paychex|justworks|rippling|\bdeel\b|trinet|payroll|\bsalary\b|direct dep(osit)? .*payroll/i, category: 'Salary' },
  // Ad platforms — FACEBK card descriptors, Meta invoices, and the other
  // self-serve ad networks.
  { re: /facebk|facebook|\bmeta ?platforms\b|\bfb\.me\b|google ?ads|googleads|adwords|tiktok ?ads?\b|snapchat ?ads|spotify|\badvertis/i, category: 'Advertisements' },
  { re: /\bpg&e\b|pacific gas|con ?edison|\bladwp\b|dept of water|water dept|socalgas|so ?cal edison|\bcomcast\b|xfinity|\bspectrum\b|verizon|\bat&t\b|t-mobile\b|tmobile\b|\butilit(y|ies)\b|electric (bill|co)/i, category: 'Utilities' },
  // Word-bounded so "rental car" never hits, and "enterprise rent" stays
  // Travel (its pattern runs earlier in this list).
  { re: /\brent\b|\blease payment\b|landlord|property (mgmt|management)|realty/i, category: 'Rent' },
];
// Learned payee→category lessons: every booking teaches; after the SAME
// pairing lands twice it outranks the built-in regex rules. Switching a
// payee to a different category resets the count (latest intent wins).
async function learnCategoryMap(user, payeeGuess, category) {
  const norm = normalizeBankPayee(payeeGuess);
  if (norm.length < 3 || !category) return;
  await pool.query(
    `INSERT INTO statement_category_map (bank_payee, category, times, created_by)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT ((LOWER(bank_payee))) DO UPDATE SET
       times = CASE WHEN statement_category_map.category = EXCLUDED.category
                    THEN statement_category_map.times + 1 ELSE 1 END,
       category = EXCLUDED.category,
       created_by = EXCLUDED.created_by`,
    [norm, category, user?.name || null]).catch(() => {});
}
async function loadCategoryMap() {
  const { rows } = await pool.query(
    `SELECT bank_payee, category FROM statement_category_map WHERE times >= 2`).catch(() => ({ rows: [] }));
  return new Map(rows.map((r) => [r.bank_payee.toLowerCase(), r.category]));
}

const suggestCategory = (t, learned) => {
  const learnedHit = learned?.get(normalizeBankPayee(t.payee_guess));
  if (learnedHit) return learnedHit;
  const hay = `${t.payee_guess || ''} ${t.description || ''}`;
  const hit = CATEGORY_SUGGESTIONS.find((s) => (s.re ? s.re.test(hay) : s.test(hay)));
  return hit ? hit.category : null;
};
// Does this credit look like money coming BACK on a previous payment, rather
// than income? Reversals, refunds, chargebacks, returned payments.
const looksLikeReversal = (t) => /\brefund(ed|s)?\b|\brevers(al|ed)\b|\bchargeback\b|\breturned\b/i
  .test(`${t.payee_guess || ''} ${t.description || ''}`);

const suggestIncomeType = (t) => {
  // A reversal is NOT income. It's money back on an expense you already
  // recorded, so the right treatment is to pair it with the original debit and
  // let the two net to zero — which is what the reversal pairing and the
  // dismiss-pair action do.
  //
  // This used to `return 'Refund'` here, which pre-filled the review deck and
  // let one swipe book the credit as revenue — the exact condition the
  // 'reversal-booked-income' flag then reported as an error. The suggester was
  // steering operators into a mistake the same file complains about.
  //
  // Returning null is not enough on its own: the client's deckDefaultFor falls
  // back to 'Streaming / Distribution' when nothing is suggested, which would
  // book a refund as streaming revenue — worse. The deck therefore treats a
  // reversal as its own primary action; see deckPrimary in BkStatements.jsx.
  if (looksLikeReversal(t)) return null;
  const hay = `${t.payee_guess || ''} ${t.description || ''}`;
  // Advance/drawdown wires outrank the distributor rule — a "STEM ADVANCE"
  // wire is a drawdown, not royalty income.
  if (/drawdown|\badvance\b/i.test(hay)) return 'Drawdown Fund';
  if (/\brent\b|sublease|sublet/i.test(hay)) return 'Rent';
  if (/distrokid|tunecore|cd ?baby|believe|stem\b|too ?lost|symphonic|vydia|united masters|distribution/i.test(hay)) return 'Streaming / Distribution';
  return null;
};

// ── Match memory ─────────────────────────────────────────────────────────────
// A manual match (or a created entry) teaches the matcher which ledger
// vendor a bank descriptor belongs to. Stored once per bank payee; the
// latest lesson wins if the operator re-teaches it.
// Descriptors that name a payment CHANNEL, not a payee. A lesson keyed on one of
// these is guaranteed wrong for almost every row it covers, because the whole
// point of the channel is that many different people are paid through it.
//
// Found 2026-08-18 from John's report that "some payments are appearing in the
// wrong vendor": a single lesson on "PAYPAL" had claimed all 154 PayPal pulls,
// $94,660.97 of other people's payments, for Dean Street Media — whose own rows
// are $13,750 monthly salary transfers. CLAUDE.md already states that a
// PAYPAL-labelled bank row carries no recipient name; nothing enforced it.
//
// FACEBK is deliberately NOT here: Facebook IS the vendor being paid.
const CHANNEL_ONLY_PAYEES = new Set([
  'paypal', 'venmo', 'zelle', 'cash app', 'cashapp', 'square', 'stripe',
  'wire', 'transfer', 'ach', 'bill pay', 'online transfer', 'external transfer',
]);
async function learnPayeeMap(user, bankPayee, ledgerPayee) {
  // NORMALIZE BEFORE STORING, because that is how it is read back.
  //
  // It used to store the RAW descriptor while every lookup normalized, so a
  // lesson taught from one card variant silently applied to the whole family —
  // "ME 4829" became a lesson on "me", which then claimed every row whose payee
  // normalized to "me". learnCategoryMap two functions down already stored the
  // normalized form; only this one didn't, and unlearnPayeeMap carried a comment
  // working around the asymmetry instead of anyone fixing it.
  const bank = normalizeBankPayee(bankPayee);
  const ledger = String(ledgerPayee || '').trim();
  // Length is checked on the NORMALIZED value now. That alone kills "ME": the raw
  // descriptor was long enough to pass, the meaningful part never was.
  if (bank.length < 3 || !ledger) return;
  if (CHANNEL_ONLY_PAYEES.has(bank)) return;
  await pool.query(
    `INSERT INTO statement_payee_map (bank_payee, ledger_payee, created_by)
     VALUES ($1, $2, $3)
     ON CONFLICT ((LOWER(bank_payee))) DO UPDATE
       SET ledger_payee = EXCLUDED.ledger_payee, created_by = EXCLUDED.created_by`,
    [bank, ledger, user?.name || null]
  ).catch(() => {});
}
// Exported for the link route, which must refuse by hand what the sweep refuses
// automatically — and say why, rather than accepting and silently doing nothing.
const isChannelOnlyPayee = (bankPayee) => CHANNEL_ONLY_PAYEES.has(normalizeBankPayee(bankPayee));

// Card descriptors vary per charge ("FACEBK *7LJZ4FDFP2 650-543...",
// "FACEBK *R3FA8FDGP2 650-543..."). Normalize before learned-map lookup so
// one lesson covers the whole family: drop tokens that look like codes
// (4+ chars containing digits) or long digit runs (phones, store numbers).
// Moved to lib/normalize-bank-payee.js so routes/reports.js can key report
// dismissals on the same normalization. Re-exported here as a local name so
// the ~dozen call sites below read unchanged.
const { normalizeBankPayee } = require('../lib/normalize-bank-payee');
const { pairReversals } = require('../lib/reversal-pairs');
const { buildAliasIndex, isNoiseAlias, loadAliasIndex } = require('../lib/vendor-aliases');

// Case-preserving cousin of normalizeBankPayee — the payee a booked entry
// should carry. "FACEBK *BXJJYTMFP2 650-543..." books as vendor "FACEBK",
// not a new vendor per card code.
const displayBankPayee = (s) => String(s || '')
  .replace(/[*#]/g, ' ')
  .split(/\s+/)
  .filter((w) => w && !(w.length >= 4 && (w.match(/\d/g) || []).length >= 2)
    && !(w.length >= 5 && /\d/.test(w) && /[a-z]/i.test(w)) // mixed alnum ≥5 = card code ("2THTXF")
    && !/^\d{4,}$/.test(w))
  .join(' ')
  .trim() || String(s || '').trim();

// Everything the matcher consults besides the candidate families: the
// learned payee map (raw + descriptor-normalized keys) and the vendor alias
// groups (alias ↔ primary are the same vendor, symmetric).
async function loadMatchContext() {
  const [payeeRes, aliasRes] = await Promise.all([
    pool.query(`SELECT bank_payee, ledger_payee FROM statement_payee_map`),
    pool.query(`SELECT primary_name, alias FROM vendor_aliases`).catch(() => ({ rows: [] })),
  ]);
  const exact = new Map();
  const norm = new Map();
  for (const r of payeeRes.rows) {
    const ledger = r.ledger_payee.toLowerCase().trim();
    exact.set(r.bank_payee.toLowerCase().trim(), ledger);
    const n = normalizeBankPayee(r.bank_payee);
    if (n.length >= 3) norm.set(n, ledger);
  }
  // lower name -> Set of equivalent lower names, via the shared resolver.
  //
  // The loop this replaces took `aliases.get(p) || aliases.get(a) || new Set()`,
  // which adopts whichever group already exists but never UNIONS two — so a row
  // linking two already-formed groups left their members pointing at different
  // sets (6 names were in that state). buildAliasIndex is union-find, so a group
  // is a true equivalence class regardless of row order, chain length or cycles.
  //
  // It also drops alias rows too weak to identify a vendor. That matters far more
  // now than before: production holds rows whose alias is literally "Inc", "LLC"
  // and "I", and because UNIQUE(alias) is case-sensitive while every reader
  // lower-cases, "Inc"/"INC"/"inc" point at three DIFFERENT vendors. Transitively
  // those are bridges — they would have welded a $680k vendor to an unrelated
  // $1.5k one. See lib/vendor-aliases.js.
  const { groups: aliases } = buildAliasIndex(aliasRes.rows);
  return { exact, norm, aliases };
}

// Match methods that ARE their own evidence of who the counterparty is.
//
// Read against runAutoMatch's methodOf(): a learned link, an alias, an email
// address, or an invoice reference found in the descriptor each identify the
// vendor by something other than the payee column, and 'manual' / 'rematch'
// mean a person chose the invoice with both sides in front of them. A name
// disagreement on any of these is expected, not suspicious — 177 of the 237
// live disagreements are here, and flagging them would bury the 32 that matter.
//
// Everything NOT listed matched on amount, date or a fuzzy name — evidence that
// says nothing about identity. 'auto-sameday' is the sharpest case: it exists
// precisely to override the name veto, so every row it produces disagrees by
// construction.
const SELF_EVIDENCING_METHODS = new Set([
  'created',       // not a match at all — an entry invented from the bank line
  'auto-learned', 'auto-alias', 'auto-email', 'auto-ref',
  'manual', 'rematch',
]);

/**
 * Have we already been TOLD these two names are one vendor?
 *
 * Read live from the alias groups and the learned payee map rather than
 * inferred from match_method, and that difference is the whole point: a match
 * made months ago on amount alone may since have had its vendor aliased or
 * linked. Checking the live answer is what lets a person RETIRE a card — add
 * the alias, and the pair stops being flagged — instead of watching it come
 * back on every pass.
 */
function identityAlreadyLinked(ctx, bankName, ledgerName) {
  const b = String(bankName || '').toLowerCase().trim();
  const l = String(ledgerName || '').toLowerCase().trim();
  if (!b || !l) return false;
  // Alias groups are true equivalence classes (buildAliasIndex is union-find),
  // so this covers A→B→C chains, not just a direct row.
  if (ctx.aliases?.get(b)?.has(l) || ctx.aliases?.get(l)?.has(b)) return true;
  // A learned link, by the exact bank string and by its normalized form —
  // both are how loadMatchContext stores them, and the bank spells a
  // recurring payee differently every month.
  if (ctx.exact?.get(b) === l) return true;
  const n = normalizeBankPayee(bankName);
  if (n.length >= 3 && ctx.norm?.get(n) === l) return true;
  return false;
}

/**
 * Does this bank pull name the PayPal recipient — or have we been TOLD they are
 * the same vendor?
 *
 * descriptorNames is the evidence rule and it stays exactly as it was: it is
 * what stopped a $200 payment pairing with the wrong person. This adds one
 * thing it cannot see — an alias or a learned payee link, which is a PERSON
 * stating the identity outright, and strictly stronger evidence than a prefix
 * found in a descriptor.
 *
 * John hit this on 2026-08-19: he aliased "LIZDEKMUSIC" to "Nikola Lizdek", and
 * the CAD 681.03 PayPal payment still would not pair with the $500 pull one day
 * later, because the guard only ever read the two strings.
 *
 * Deliberately NOT wired into pairTier, which the unattended sweep uses to
 * AUTO-CLOSE. An alias plus an amount is enough to propose to a person; it is
 * not enough to write unread.
 */
function namesOrLinked(ctx, bankDescription, ppPayee, bankPayee) {
  if (descriptorNames(bankDescription, ppPayee, bankPayee)) return true;
  return identityAlreadyLinked(ctx, bankPayee, ppPayee);
}

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Negative match memory ────────────────────────────────────────────────────
// An explicit "no" (unmatching a pair, dismissing a card that carried a
// suggestion) permanently suppresses that txn↔family pairing from
// auto-match and demotes it in suggestions. Keyed by fingerprint, not txn
// id — re-uploading a statement must not resurrect a rejected pairing.
// pg returns DATE columns as local-midnight Date objects — String() gives
// "Mon Jul 06" (no year) and toISOString() can shift a day across TZs.
const isoDay = (d) => {
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x)) return String(d).slice(0, 10);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const txnFingerprint = (t) => [
  isoDay(t.txn_date),
  Number(t.amount).toFixed(2),
  normalizeBankPayee(t.payee_guess) || (t.payee_email || '').toLowerCase().trim(),
].join('|');

async function recordRejection(user, txn, rootId, source) {
  if (!txn || !rootId) return;
  await pool.query(
    `INSERT INTO statement_match_rejections (txn_fingerprint, expense_root_id, source, created_by)
     VALUES ($1, $2, $3, $4) ON CONFLICT (txn_fingerprint, expense_root_id) DO NOTHING`,
    [txnFingerprint(txn), rootId, source, user?.name || null]
  ).catch(() => {});
}

// fingerprint -> Set of rejected family root ids
async function loadRejections() {
  const { rows } = await pool.query(
    `SELECT txn_fingerprint, expense_root_id FROM statement_match_rejections`
  ).catch(() => ({ rows: [] }));
  const map = new Map();
  for (const r of rows) {
    const set = map.get(r.txn_fingerprint) || new Set();
    set.add(r.expense_root_id);
    map.set(r.txn_fingerprint, set);
  }
  return map;
}
const isRejected = (rejections, txn, rootId) =>
  rejections.get(txnFingerprint(txn))?.has(rootId) || false;

// Vendor merges record the losing name as an alias — bookings must respect
// that, or the next FACEBK charge re-creates the vendor that was just
// merged away. Resolves a payee to its alias primary (or itself).
// Walks to the TERMINAL primary, not one hop. Merging an already-aliased vendor
// creates a chain by construction (merge re-points the loser but leaves the
// loser's own aliases pointing at it), and 48 of 193 alias rows in production
// have an alias that is itself a primary_name. A single-hop lookup stopped at the
// middle of the chain and booked spend under a name that had itself been merged
// away — which is how 7 merged-away names still carry their own invoices.
async function resolveVendorAlias(name) {
  const n = String(name || '').trim();
  if (!n) return n;
  const { rows } = await pool.query('SELECT primary_name, alias FROM vendor_aliases')
    .catch(() => ({ rows: [] }));
  if (!rows.length) return n;
  const idx = buildAliasIndex(rows);
  const canon = idx.canonical(n);
  if (canon === n.toLowerCase()) return n;
  // canonical() works in lower case; return the real spelling from the table.
  const match = rows.find((r) => String(r.primary_name || '').trim().toLowerCase() === canon)
    || rows.find((r) => String(r.alias || '').trim().toLowerCase() === canon);
  return (match?.primary_name || '').trim().toLowerCase() === canon
    ? match.primary_name.trim()
    : (match?.alias || '').trim() || n;
}

// Reference evidence: an invoice number or payment reference printed in the
// wire text is the strongest signal a bank row carries — stronger than any
// name. Compares the ledger's payment_ref and normalized invoice_number
// against the txn's reference + description.
function refEvidence(txn, family) {
  const hay = `${txn.reference || ''} ${txn.description || ''}`;
  const ref = String(family.payment_ref || '').trim();
  if (ref.length >= 4 && hay.toLowerCase().includes(ref.toLowerCase())) {
    return { match: true, reason: 'reference' };
  }
  const inv = normalizeInvoiceNum(family.invoice_number);
  if (family.invoice_number && inv && inv !== '0') {
    // Bare-token match needs 2+ significant digits; short invoice numbers
    // ("003" → "3") only count via the prefixed form below.
    if (inv.length >= 2) {
      for (const w of hay.toLowerCase().split(/[\s,;:|]+/)) {
        // Skip 4-digit tokens that read as MMDD — card descriptors embed the
        // charge date ("PURCHASE 0227 FACEBK") and it isn't an invoice number.
        if (/^\d{4}$/.test(w)) {
          const mm = Number(w.slice(0, 2)), dd = Number(w.slice(2));
          if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) continue;
        }
        if (normalizeInvoiceNum(w) === inv) return { match: true, reason: 'invoice#' };
      }
    }
    // "INV 003" / "Invoice #123" — explicit prefix carries the meaning, so
    // any-length numbers qualify here.
    if (new RegExp(`(?:invoice|inv|no\\.?|#)[\\s\\-.:_/]*0*${escRe(inv)}\\b`, 'i').test(hay)) {
      return { match: true, reason: 'invoice#' };
    }
  }
  return { match: false };
}

// Name evidence for a txn↔family pair. Strongest first: a reference /
// invoice number printed in the wire text, then matching email (the bank's
// counterparty email vs the ledger's vendor_email), then a learned payee
// mapping (raw or descriptor-normalized), then the alias table, then fuzzy
// name against the ledger payee AND each of its aliases.
function nameEvidence(ctx, txn, family) {
  const ref = refEvidence(txn, family);
  if (ref.match) return { match: true, score: 1.0, reason: ref.reason };
  const tEmail = (txn.payee_email || '').toLowerCase().trim();
  if (tEmail && tEmail === (family.vendor_email || '').toLowerCase().trim()) {
    return { match: true, score: 1.0, reason: 'email' };
  }
  const tName = (txn.payee_guess || '').toLowerCase().trim();
  const fName = (family.payee || '').toLowerCase().trim();
  const grp = ctx.aliases.get(fName);
  const mapped = ctx.exact.get(tName)
    || (tName ? ctx.norm.get(normalizeBankPayee(txn.payee_guess)) : null);
  if (mapped && (mapped === fName || (grp && grp.has(mapped)))) {
    return { match: true, score: 1.0, reason: 'learned' };
  }
  if (tName && grp && grp.has(tName)) {
    return { match: true, score: 0.95, reason: 'alias' };
  }
  let best = vendorsMatch(txn.payee_guess, family.payee);
  if (grp) {
    for (const a of grp) {
      if (a === fName) continue;
      const vm = vendorsMatch(txn.payee_guess, a);
      if (vm.score > best.score) best = { match: vm.match, score: vm.score, reason: 'alias-fuzzy' };
    }
  }
  return best;
}

// Name-disagreement VETO for the weak (amount/date) tiers: when both sides have
// a payee and they share essentially NOTHING, an amount coincidence is not a
// match — "MAZEN ELAHWAL" must never claim "Exclap Entertainment"'s invoice.
// Name-evidence tiers are unaffected.
//
// MODULE-LEVEL because it has three readers now: the matcher's weak tiers, the
// marked-group tier, and the unmarked-group PROPOSAL in enrichDetail. This repo
// has shipped a money predicate living in three places and fixed in one more
// than once — the veto is the last thing that should be one of them.
const namesDisagreeFor = (txn, f, vm) => {
  const tn = (txn.payee_guess || '').trim();
  const fn = (f.payee || '').trim();
  return !!tn && !!fn && !vm.match && vm.score < 0.25;
};

// Wire/processing fees put the bank debit a hair above the invoice —
// tolerate a small delta, but only when the NAME also supports the match.
const feeTolerance = (amt) => Math.max(35, amt * 0.01);

// The same payment in two currencies. Exact cents is the wrong test after a
// conversion: the rate moves between invoicing and payment and the bank takes a
// spread, so agreement is a BAND, not a point.
//
// 5% of the larger side, from John's own confirmed pairs — PINK PANTHERS B.V.
// bills in EUR and pays in USD, and its hand-made matches sit 1.0%, 2.0%, 3.5%
// and 4.6% apart. A tighter window would refuse two of the four; a wider one
// stops meaning anything on a $1,000 payment.
//
// Both sides must already be in USD, via usdOf — never amount_usd, which is a
// stored column that is NULL on 97 rows and reads a JPY face value as dollars.
// How far an invoice may sit from a bank line and still be OFFERED — never
// auto-matched. Declared up here rather than beside /rematch-candidates because
// enrichDetail's group proposal reads it too, and a `const` used by a function
// defined 3,000 lines above it is a temporal-dead-zone bug that `node --check`
// does not catch.
const REMATCH_WINDOW_DAYS = 45;

const FX_BAND = 0.05;
const fxAgrees = (aUsd, bUsd) => {
  const a = Math.abs(Number(aUsd) || 0);
  const b = Math.abs(Number(bUsd) || 0);
  if (!(a > 0) || !(b > 0)) return false;
  return Math.abs(a - b) <= Math.max(a, b) * FX_BAND;
};

// Auto-dismiss debits matching saved "always dismiss" patterns — payroll,
// rent, transfers recur every month; rules make dismissal a one-time act.
async function applyDismissRules(statementId) {
  const { rows: rules } = await pool.query(`SELECT id, pattern FROM statement_dismiss_rules`);
  let dismissed = 0;
  for (const rule of rules) {
    const { rowCount } = await pool.query(
      `UPDATE bank_transactions SET dismissed = true, dismissed_reason = $1
        WHERE statement_id = $2 AND direction = 'debit'
          AND dismissed = false AND matched_expense_id IS NULL
          AND (payee_guess ILIKE $3 OR description ILIKE $3)`,
      [`rule: ${rule.pattern}`, statementId, `%${likeEscape(rule.pattern)}%`]
    ).catch(() => ({ rowCount: 0 }));
    dismissed += rowCount || 0;
  }
  return dismissed;
}

async function storeToR2(st, buffer, name, mime) {
  try {
    const key = `statements/${st.id}/${Date.now()}_${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    await uploadFile(key, buffer, mime);
    await pool.query(`UPDATE bank_statements SET r2_key = $1 WHERE id = $2`, [key, st.id]);
  } catch (e) { /* best effort — the parsed rows are the working data */ }
}

// Pipe-delimited lines, not JSON: the parse is output-bound (the model must
// literally write every transaction), and the line format is ~half the
// tokens of JSON — which halves the wall-clock per statement.
const pdfPrompt = (account) => `This is a ${account === 'paypal' ? 'PayPal' : 'Bank of America'} bank statement. First output TWO lines with the statement's balances:
BEGINNING_BALANCE|<number, no $ or commas — the opening/beginning/starting balance printed on the statement; blank if not shown>
ENDING_BALANCE|<number, no $ or commas — the closing/ending balance printed on the statement; blank if not shown>

Both balances matter: they let us prove arithmetically that no transaction was missed. Take them from the statement's own summary — never compute them.

Then extract EVERY transaction. Output ONE LINE per transaction, pipe-separated, exactly this field order:
DATE|DIRECTION|AMOUNT|CURRENCY|AMOUNT_USD|PAYEE|EMAIL|REFERENCE|DESCRIPTION

- DATE: YYYY-MM-DD
- DIRECTION: debit (money out) or credit (money in)
- AMOUNT: positive number, no $ or commas — in the transaction's OWN currency
- CURRENCY: 3-letter ISO code of the amount (USD, EUR, JPY, GBP…). PayPal statements list foreign-currency transactions — never write USD for a JPY amount.
- AMOUNT_USD: ONLY when CURRENCY is not USD — the US-dollar amount the account was actually debited/credited for that transaction, as printed on the statement (PayPal shows the converted settlement amount). Leave this field EMPTY when CURRENCY is USD. Never estimate it; leave it blank if the statement doesn't print one.
- PAYEE: the counterparty NAME ONLY (for wires the BNF/beneficiary; for card charges the merchant; for PayPal the recipient's name). Never put an email address here. Leave blank if unknown.
  ACH lines look like "MERCHANT NAME DES:<descriptor> ID:<id> INDN:<person> CO ID:<id> WEB". The PAYEE is the MERCHANT NAME at the START of the line, before "DES:". The INDN field is the individual name on OUR account, not the counterparty — never use it. "ADVICEPAY.COM DES:ADVICEPAY. ID:ST-X INDN:JANE DOE CO ID:123 WEB" is a payment to ADVICEPAY.COM, not to Jane Doe. Taking INDN put real people's names into the vendor ledger, where they read as vendors on a 1099.
  Internal-transfer lines look like "TRANSFER <our account name>:<counterparty> Confirmation# <digits>", and reversals the same with REVERSAL. The PAYEE is the counterparty AFTER the colon. The name before the colon is OUR OWN account and the confirmation number is not part of anyone's name. "TRANSFER MARKET STREET:Venable LLP Confirmation# 0650505782" is a payment to "Venable LLP" — not to Market Street, and not the whole line. Never return the raw statement line as the payee; if you cannot isolate a name, leave PAYEE blank.
- EMAIL: the counterparty's email address when the statement shows one (PayPal usually does). Leave blank if none.
- REFERENCE: transaction/confirmation id. Leave blank if none.
- DESCRIPTION: the statement line text (replace any | characters in it with /)

Do NOT include running balances, daily balance rows, subtotals, summary sections, interest or fee summaries — only actual transactions. Do not skip any transaction. Output ONLY the lines — no header row, no JSON, no markdown, no commentary.`;

// Six concurrent 30k-token streams starve each other on the org's output
// rate limit — everything crawls and nothing finishes. Two at a time keeps
// throughput while files complete visibly one after another.
const MAX_PARALLEL_PARSES = 2;
const parseQueue = [];
let parsesRunning = 0;
function enqueuePdfParse(job) {
  parseQueue.push(job);
  pumpParseQueue();
}
function pumpParseQueue() {
  while (parsesRunning < MAX_PARALLEL_PARSES && parseQueue.length) {
    const job = parseQueue.shift();
    parsesRunning++;
    job().catch(() => {}).finally(() => { parsesRunning--; pumpParseQueue(); });
  }
}

// PDF parses run AFTER the upload response — a big statement can take Claude
// a couple of minutes, which blows past the proxy timeout as a single request
// (the 502 John hit). The statement row carries status parsing → ready|error
// and the client polls. A deploy restart mid-parse leaves 'parsing' stuck;
// the list endpoint flips anything parsing >10min to error.
// Pure parse: PDF buffer -> transaction rows. No database writes, no status
// changes. Split out of parsePdfInBackground so /reparse can run exactly the
// same extraction without touching the statement's state — a re-parse that
// flipped status to 'parsing' or rewrote period bounds could take a reconciled
// month offline on a transient AI error.
//
// Two implementations sit behind this. The deterministic one (rules over
// extracted text) runs first and finishes in tens of milliseconds, but it is
// only allowed to win when the parse reconciles against the statement's own
// printed balances and section totals. Anything else — an unsupported account,
// a layout it doesn't recognise, arithmetic that doesn't tie out — falls
// through to the AI, which is minutes slower but layout-agnostic.
//
// The reconciliation gate is the whole safety argument: a BofA layout change
// can cost us the fast path, never correctness.
async function parsePdfRows(st, buffer, name) {
  const fast = await parsePdfRowsDeterministic(st, buffer);
  if (fast) return fast;
  return parsePdfRowsWithAI(st, buffer, name);
}

// Returns null to mean "not usable, use the AI" — never a partial result.
async function parsePdfRowsDeterministic(st, buffer) {
  let out;
  try {
    out = await parseStatementPdfText(buffer, st.account);
  } catch (err) {
    console.error(`[parse] deterministic parse threw for statement ${st.id}:`, err.message);
    return null;
  }
  if (!out) return null; // no rules for this account, or not a recognised layout
  if (!out.ok) {
    console.warn(`[parse] statement ${st.id}: deterministic parse did not reconcile (${out.verdict.reason}) — using AI`);
    return null;
  }
  console.log(`[parse] statement ${st.id}: deterministic parse reconciled, ${out.rows.length} rows`);
  return {
    error: null,
    // Same payee normalisation the AI path applies to BofA descriptors, so
    // matching and vendor grouping behave identically whichever path ran.
    rows: out.rows.map((r) => ({ ...r, payee_guess: bofaPayee(r.description) })),
    endingBalance: out.endingBalance,
    beginningBalance: out.beginningBalance,
    method: 'rules',
  };
}

async function parsePdfRowsWithAI(st, buffer, name) {
  try {
    // 32k output tokens of headroom; the line format needs roughly half of
    // what the old JSON did for the same statement.
    const MAX_OUT = 32000;
    const result = await callClaude({
      buffer,
      filename: name,
      maxTokens: MAX_OUT,
      prompt: pdfPrompt(st.account),
    });
    if (!result.ok) {
      throw new Error(result.disabled
        ? 'AI parsing is not configured on the server — upload the CSV export instead.'
        : `Could not parse the PDF: ${result.error}`);
    }
    // Token ceiling = the tail is MISSING. Never silently reconcile a
    // partial statement.
    if ((result.usage?.output_tokens || 0) >= MAX_OUT - 200) {
      throw new Error('This statement is too long to parse in one pass — upload the CSV export instead.');
    }
    let pdfEndingBalance = null;
    let pdfBeginningBalance = null;
    const rows = String(result.data || '')
      .split('\n')
      .map((line) => {
        if (/^ENDING_BALANCE\|/i.test(line.trim())) {
          pdfEndingBalance = num(line.split('|')[1]);
          return null;
        }
        if (/^BEGINNING_BALANCE\|/i.test(line.trim())) {
          pdfBeginningBalance = num(line.split('|')[1]);
          return null;
        }
        const parts = line.split('|');
        if (parts.length < 3) return null; // headers, fences, blank lines
        // 8-field format (with CURRENCY); tolerate older 7/6-field shapes.
        // A known ISO code in field 4 is the currency; anything else (a
        // 3-letter payee like "UPS") is not consumed.
        let rest = parts.slice(3);
        let currency = 'USD';
        const ISO = /^(USD|EUR|GBP|JPY|CAD|AUD|CHF|MXN|BRL|SEK|NOK|DKK|NZD|HKD|SGD|CNY|PLN|CZK|HUF|ILS|THB|PHP|TWD)$/i;
        let amountUsd = null;
        if (rest[0] && ISO.test(rest[0].trim())) {
          currency = rest[0].trim().toUpperCase();
          rest = rest.slice(1);
          // AMOUNT_USD follows CURRENCY, and only on foreign rows. Consumed
          // only when it is genuinely numeric, so older 8-field output (where
          // PAYEE sits here) still parses — a payee is not a bare number.
          if (currency !== 'USD' && rest[0] != null && /^-?[\d,]+(\.\d+)?$/.test(String(rest[0]).trim())) {
            amountUsd = Math.abs(num(rest[0]));
            rest = rest.slice(1);
          } else if (currency !== 'USD' && String(rest[0] ?? '').trim() === '') {
            // Model emitted the field but left it blank (no printed USD amount).
            rest = rest.slice(1);
          }
        }
        const [d, dir, amt] = parts;
        let [payee = '', email = '', ref = '', ...descParts] = rest;
        if (email && !/@/.test(email) && (ref === '' || descParts.length === 0)) {
          descParts = [ref, ...descParts].filter((x) => x !== '');
          ref = email;
          email = '';
        }
        const txn_date = toISO(d.trim());
        const amount = Math.abs(num(amt));
        if (!txn_date || !amount) return null;
        const description = descParts.join('|').trim().slice(0, 500);
        const norm = splitPayeeEmail(payee, email);
        return {
          txn_date,
          description: description || norm.name,
          payee_guess: norm.name.slice(0, 200) || (st.account === 'bofa' ? bofaPayee(description) : ''),
          payee_email: norm.email,
          amount,
          direction: dir.trim().toLowerCase() === 'credit' ? 'credit' : 'debit',
          currency,
          // USD settlement for a foreign row, straight off the statement. This
          // is what makes an FX statement reconcilable — see reconcileStatement.
          amount_usd: amountUsd,
          reference: ref.trim() ? ref.trim().slice(0, 120) : null,
          fee: null,
        };
      })
      .filter(Boolean);
    if (!rows.length) throw new Error('The AI found no transactions in this PDF — try the CSV export.');
    return { error: null, rows, endingBalance: pdfEndingBalance, beginningBalance: pdfBeginningBalance, method: 'ai' };
  } catch (err) {
    return { error: err.message, rows: [] };
  }
}

// Upload path: parse, then persist and flip the statement out of 'parsing'.
async function parsePdfInBackground(st, buffer, name, userName) {
  try {
    const parsed = await parsePdfRows(st, buffer, name);
    if (parsed.error) throw new Error(parsed.error);
    const rows = parsed.rows;
    const pdfEndingBalance = parsed.endingBalance;
    const pdfBeginningBalance = parsed.beginningBalance;

    const ins = await insertRows(st, rows);
    const dates = rows.map((r) => r.txn_date).sort();
    const fresh = { ...st, period_start: dates[0], period_end: dates[dates.length - 1] };
    const match = await runAutoMatch(fresh, userName);
    const ruleBooked = await applyCategoryRules(st.id);
    // WHY the rest didn't match, stored with the counts. The first thing anyone
    // wants after an upload is not "40 matched" but "and what about the other
    // 396" — and the answer was previously unrecoverable after the pass ended.
    const summary = { dup_skipped: ins.dupSkipped, auto_matched: match.matched, rule_booked: ruleBooked, rule_dismissed: ins.ruleDismissed, reasons: match.reasons || {} };
    await pool.query(
      `UPDATE bank_statements SET status = 'ready', error = NULL, txn_count = $1, period_start = $2, period_end = $3, import_summary = $4, ending_balance = $5, beginning_balance = COALESCE($7, beginning_balance) WHERE id = $6`,
      [ins.inserted, dates[0], dates[dates.length - 1], JSON.stringify(summary), pdfEndingBalance, st.id, pdfBeginningBalance]);
    await audit({ name: userName }, 'statement_uploaded', null, null,
      `${st.account.toUpperCase()} statement "${name}" (PDF, ${parsed.method === 'rules' ? 'rule-parsed, balance-verified' : 'AI-parsed'}): ${ins.inserted} transactions (${dates[0]} → ${dates[dates.length - 1]}); ${ins.dupSkipped} duplicates skipped, ${match.matched} auto-matched, ${ruleBooked} rule-booked, ${ins.ruleDismissed} rule-dismissed`);
  } catch (err) {
    console.warn(`Statement ${st.id} PDF parse failed:`, err.message);
    await pool.query(`UPDATE bank_statements SET status = 'error', error = $1 WHERE id = $2`,
      [err.message, st.id]).catch(() => {});
  }
}

// POST /api/statements/upload  (multipart: file, account)
// CSV → parsed + matched synchronously (fast, deterministic).
// PDF → returns immediately with status 'parsing'; Claude runs in background.
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    const account = String(req.body.account || '').toLowerCase();
    if (!ACCOUNTS.has(account)) return res.status(400).json({ success: false, error: 'account must be bofa or paypal' });

    const name = req.file.originalname || 'statement';
    const isCsv = /\.csv$/i.test(name) || /csv|text\/plain/.test(req.file.mimetype || '');
    const isPdf = /\.pdf$/i.test(name) || /pdf/.test(req.file.mimetype || '');
    if (!isCsv && !isPdf) {
      return res.status(400).json({ success: false, error: 'Upload the transaction CSV or the monthly PDF statement.' });
    }

    if (isCsv) {
      const parsed = parseStatementCSV(req.file.buffer.toString('utf8'), account);
      if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });
      const rows = parsed.rows;
      const dates = rows.map((r) => r.txn_date).sort();
      const { rows: [st] } = await pool.query(
        `INSERT INTO bank_statements (account, filename, period_start, period_end, txn_count, status, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,'ready',$6) RETURNING *`,
        [account, name, dates[0], dates[dates.length - 1], rows.length, req.user.name]);
      await storeToR2(st, req.file.buffer, name, 'text/csv');
      const ins = await insertRows(st, rows);
      const match = await runAutoMatch(st, req.user.name);
      const ruleBooked = await applyCategoryRules(st.id);
      const summary = { dup_skipped: ins.dupSkipped, auto_matched: match.matched, rule_booked: ruleBooked, rule_dismissed: ins.ruleDismissed, reasons: match.reasons || {} };
      await pool.query(`UPDATE bank_statements SET txn_count = $1, import_summary = $2, ending_balance = $3 WHERE id = $4`,
        [ins.inserted, JSON.stringify(summary), parsed.endingBalance ?? null, st.id]);
      await audit(req.user, 'statement_uploaded', null, null,
        `${account.toUpperCase()} statement "${name}": ${ins.inserted} transactions (${dates[0]} → ${dates[dates.length - 1]}); ${ins.dupSkipped} duplicates skipped, ${match.matched} auto-matched, ${ruleBooked} rule-booked, ${ins.ruleDismissed} rule-dismissed`);
      return res.json({ success: true, data: { id: st.id, status: 'ready', txn_count: ins.inserted } });
    }

    // PDF path
    const { rows: [st] } = await pool.query(
      `INSERT INTO bank_statements (account, filename, txn_count, status, uploaded_by)
       VALUES ($1,$2,0,'parsing',$3) RETURNING *`,
      [account, name, req.user.name]);
    await storeToR2(st, req.file.buffer, name, 'application/pdf');
    res.json({ success: true, data: { id: st.id, status: 'parsing' } });
    enqueuePdfParse(() => parsePdfInBackground(st, req.file.buffer, name, req.user.name));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── List / detail / delete ───────────────────────────────────────────────────

// Housekeeping throttle: the retro sweeps are idempotent maintenance, not
// request logic. Running them on EVERY list load stacked full-table
// UPDATE scans under load until the pool starved (2026-08-04 outage).
// At most once per 10 minutes per process, never concurrently.
let sweepsLastRun = 0;
let sweepsInFlight = false;
const rematchLast = new Map(); // statement id -> last freshness re-match ts
let rematchInFlight = false;
// Ending-balance backfill: statements parsed before balance capture have
// NULL ending_balance but their PDFs are stored — re-read them with a
// focused single-field extraction, 2 per cycle, FIRE-AND-FORGET (a PDF
// ingest takes tens of seconds; it must never block the list request).
let balBackfillInFlight = false;
const balBackfillSkip = new Set(); // statement ids whose PDF shows no balance

function runBalanceBackfill() {
  if (balBackfillInFlight) return;
  balBackfillInFlight = true;
  (async () => {
    const { rows: needBal } = await pool.query(`
      SELECT id, filename, r2_key FROM bank_statements
       WHERE status = 'ready' AND ending_balance IS NULL AND r2_key IS NOT NULL
         AND r2_key ILIKE '%.pdf'
       ORDER BY period_end DESC NULLS LAST`);
    const todo = needBal.filter((s) => !balBackfillSkip.has(s.id)).slice(0, 2);
    for (const st of todo) {
      const { buffer } = await downloadFile(st.r2_key);
      const result = await callClaude({
        buffer, filename: st.filename || 'statement.pdf', maxTokens: 100,
        prompt: 'This is a bank statement. Output ONLY the ending/closing balance printed on it, as a plain number with no $ or commas (e.g. 12345.67). If the statement genuinely shows no ending balance, output NONE.',
      });
      const txt = String(result.ok ? result.data : '').trim();
      const num = parseFloat(txt.replace(/[$,\s]/g, ''));
      if (result.ok && Number.isFinite(num)) {
        await pool.query(
          `UPDATE bank_statements SET ending_balance = $1 WHERE id = $2 AND ending_balance IS NULL`,
          [num, st.id]);
        await audit({ name: 'balance-backfill' }, 'statement_balance_backfilled', null, null,
          `Ending balance $${num.toLocaleString()} extracted from stored "${st.filename}"`);
      } else {
        balBackfillSkip.add(st.id); // no balance found / AI off — don't retry this process
      }
    }
  })().catch((e) => console.warn('[balance-backfill]', e.message))
    .finally(() => { balBackfillInFlight = false; });
}

// ── The PayPal funding-pair sweep ────────────────────────────────────────────
//
// Extracted from the statements-list handler (2026-08-18) so it can be asked
// what it WOULD do before it does it. Widening the pairing window makes this
// close pairs it never could before, and "run it and see" is not an acceptable
// way to move reported spend — GET /funding-pairs/preview runs this with dryRun
// and reaches the same classification the live run will.
//
// The pairing test itself now lives in lib/funding-pairs.js, shared with the
// vendor page and the cross-currency audit, because three copies of it had
// already drifted apart on both the window and the naming guard — which is how
// two vendors came to show "no bank pull found within 3 days" next to a pull
// that was plainly theirs.
//
// @param {boolean} dryRun  classify identically, write nothing
// @returns a summary; null when a LIVE run failed (advisory — it must never take
//          the statements list down). A dry run rethrows, because a caller asking
//          a question deserves the error rather than a silent empty answer.
async function runFundingPairSweep({ dryRun = false } = {}) {
  const brief = (l) => ({
    paypal_txn: l.pp_id, bank_txn: l.bank_id, payee: l.pp_payee,
    bank_desc: String(l.bank_desc || '').slice(0, 60),
    paypal_entry: l.pp_match || null, bank_entry: l.b_match || null,
    paypal_entry_source: l.pp_source || null, bank_entry_source: l.b_source || null,
  });
  const leftForFlag = [];
    try {
      const { rows: legs } = await pool.query(`
        SELECT b.id AS bank_id, b.payee_guess AS bank_payee, b.description AS bank_desc,
               b.txn_date AS bdate, p.txn_date AS pdate,
               b.matched_expense_id AS b_match, b.match_method AS b_method,
               be.entry_source AS b_source, be.category AS b_category,
               be.artist AS b_artist, be.song AS b_song, b.match_method AS b_method_raw,
               pe.entry_source AS pp_source, pe.payee AS pp_ledger,
               p.id AS pp_id, p.payee_guess AS pp_payee, p.matched_expense_id AS pp_match,
               p.match_method AS pp_method,
               pe.category AS pp_category, pe.artist AS pp_artist, pe.song AS pp_song,
               (p.matched_expense_id IS NOT NULL OR p.matched_income_id IS NOT NULL) AS pp_counted
          FROM bank_transactions b
          JOIN bank_statements sb ON sb.id = b.statement_id AND sb.account <> 'paypal'
          JOIN bank_transactions p ON p.direction = 'debit' AND p.amount = b.amount
           AND ABS(p.txn_date - b.txn_date) <= ${WINDOW_DAYS}
          JOIN bank_statements sp ON sp.id = p.statement_id AND sp.account = 'paypal' AND sp.status = 'ready'
          LEFT JOIN expenses be ON be.id = b.matched_expense_id
          LEFT JOIN expenses pe ON pe.id = p.matched_expense_id
         WHERE b.direction = 'debit' AND b.dismissed = false
           AND b.matched_income_id IS NULL
           AND ${PULL_SQL}
           AND p.dismissed = false
         ORDER BY b.id, ABS(p.txn_date - b.txn_date)`).catch(() => ({ rows: [] }));
      const usedPp = new Set();
      const seenBank = new Set();
      const dismissPpIds = [];   // PayPal twins the bank row already covers
      const moveToBank = [];     // record sits on PayPal, bank row is empty
      const mergeBoth = [];      // both counted, PayPal side invented
      const moveInvoice = [];    // PayPal holds a real invoice, bank holds a booking
      // ── Which candidate wins a contested pull ────────────────────────────
      //
      // Through the SHARED order, so this and the vendor page cannot name
      // different owners for one pull. `ORDER BY b.id, |gap|` decided by row id
      // whenever two payments were equally close, which is a coin toss: bank
      // #5424 reads "ID:ANGEL" and was as near to Blake Hall's identical $1,000
      // as to Angel Melendez's. The descriptor now breaks that tie.
      //
      // Only the ORDER moves. Every guard below is unchanged, so this cannot make
      // a pair eligible that was not — and the consumption rules stay here on
      // purpose, because branch 5 deliberately consumes nothing.
      //
      // A person's move on the bank row also drops the pairs that contradict it:
      // dismissing vendor Y's PayPal copy against a pull somebody filed under
      // vendor X would overrule a decision with an inference.
      const fpOverrides = await loadVendorOverrides().catch(() => new Map());
      const ordered = scoreFundingLegs(
        legs.map((l) => ({ ...l, names: [l.pp_payee, l.pp_ledger].filter(Boolean) })),
        { overrides: fpOverrides, vendorOf: (l) => l.pp_ledger || l.pp_payee });
      for (const { leg: l } of ordered) {
        if (seenBank.has(l.bank_id) || usedPp.has(l.pp_id)) continue;
        const paypalLabeled = /paypal/i.test(l.bank_desc || '');
        const bn = normalizeBankPayee(l.bank_payee);
        const pn = normalizeBankPayee(l.pp_payee);
        const similar = paypalLabeled
          ? true
          : bn && pn && (pn.startsWith(bn) || bn.startsWith(pn) || vendorsMatch(l.bank_payee, l.pp_payee).match);
        if (!similar) continue;
        // BEYOND THE ORIGINAL 3 DAYS, every branch must see the name.
        //
        // The window went 3 → 7 to catch eCheck settlement lag, and the
        // dismiss-only branch below deliberately runs on amount + date + a
        // "PAYPAL" label with no naming test at all — recoverable, so the bar was
        // lower. At 7 days that leniency stops being safe: a nameless pull and an
        // uncounted PayPal row of the same amount a week apart is exactly the
        // coincidence that mispaired a $200 payment. Inside 3 days behaviour is
        // unchanged; the days this change ADDED are the ones that need evidence.
        const wide = !(dayGap(l.pdate, l.bdate) <= 3);
        if (wide && !descriptorNames(l.bank_desc, l.pp_payee, l.bank_payee)) continue;
        // 1. The PayPal twin carries nothing → close it. The bank row keeps
        //    (or gets) the record, which is where the report reads.
        if (!l.pp_counted) {
          usedPp.add(l.pp_id); seenBank.add(l.bank_id);
          dismissPpIds.push(l.pp_id);
        } else if (!l.b_match && descriptorNames(l.bank_desc, l.pp_payee, l.bank_payee)) {
          // 2. The record is on the PayPal side and the bank row is empty. MOVE
          //    it across — dismissing the twin first would leave the payment on
          //    nobody's books, which is how a reconciliation loses money.
          //
          //    Held to the same naming test as the delete path. A move is not
          //    destructive, but landing a payment's record on the wrong bank row
          //    of the same amount mislabels BOTH payments, and the amount-plus-
          //    three-days coincidence is exactly what cost $200 today.
          usedPp.add(l.pp_id); seenBank.add(l.bank_id);
          moveToBank.push(l);
        } else if (l.pp_source === 'bank_statement' && descriptorNames(l.bank_desc, l.pp_payee, l.bank_payee)) {
          // 3. BOTH carry a record and the PayPal one is invented. Dissolve it
          //    into the bank record, keeping any field only it filled. Guarded
          //    by the descriptor naming the recipient, because this deletes.
          usedPp.add(l.pp_id); seenBank.add(l.bank_id);
          mergeBoth.push(l);
        } else if (l.b_source === 'bank_statement' && descriptorNames(l.bank_desc, l.pp_payee, l.bank_payee)) {
          // 4. The PayPal copy holds a REAL INVOICE and the bank row holds a
          //    booking the app invented. The invoice is the better record and
          //    the bank row is the counted one, so the invoice moves ACROSS:
          //    the invented booking is displaced exactly as /attach does it, and
          //    the row is linked with match_method 'rematch' so /unattach can
          //    put that booking back.
          //
          //    This is the case John's screenshot showed — a PayPal row reading
          //    "✓ invoice" beside "both still counting", with a button that
          //    refused to fire. 14 rows, of which 4 are this shape.
          usedPp.add(l.pp_id); seenBank.add(l.bank_id);
          moveInvoice.push(l);
        }
        // 5. Both hold a REAL invoice: left alone for the double-funding flag.
        //    Two documents disagreeing is a person's decision, not a sweep's.
        else leftForFlag.push(l);
      }
      // Close the PayPal twins the bank row already covers.
      if (dismissPpIds.length && !dryRun) {
        await pool.query(`
          UPDATE bank_transactions SET dismissed = true,
            dismissed_reason = 'paypal copy — this payment is counted from its bank statement row'
          WHERE id = ANY($1) AND dismissed = false
            AND matched_expense_id IS NULL AND matched_income_id IS NULL`, [dismissPpIds]);
        await audit({ name: 'funding-leg-sweep' }, 'statement_funding_pairs_closed', null, null,
          `${dismissPpIds.length} PayPal twin(s) closed — those payments are counted from the bank statement, which is what the P&L and Financials read`);
      }
      // Move the record onto the bank row, THEN close the twin. The other order
      // leaves the payment on nobody's books.
      let movedN = 0;
      for (const l of moveToBank) {
        if (dryRun) { movedN += 1; continue; }
        const { rowCount } = await pool.query(
          `UPDATE bank_transactions SET matched_expense_id = $1, match_method = $2,
             matched_by = 'funding-leg-sweep', matched_at = NOW()
           WHERE id = $3 AND matched_expense_id IS NULL AND matched_income_id IS NULL
             AND dismissed = false`,
          [l.pp_match, l.pp_method || 'created', l.bank_id]).catch(() => ({ rowCount: 0 }));
        if (!rowCount) continue;
        await pool.query(
          `UPDATE bank_transactions SET matched_expense_id = NULL, match_method = NULL,
             match_score = NULL, matched_by = NULL, matched_at = NULL,
             dismissed = true,
             dismissed_reason = 'paypal copy — this payment is counted from its bank statement row'
           WHERE id = $1`, [l.pp_id]).catch(() => {});
        movedN += 1;
      }
      if (movedN && !dryRun) {
        await audit({ name: 'funding-leg-sweep' }, 'statement_funding_records_moved', null, null,
          `${movedN} payment(s) moved their ledger record from the PayPal copy onto the bank statement row, `
          + 'so the counted row is the one that reconciles to the statement balance');
      }
      // An INVOICE on the PayPal copy moves to the bank row, displacing the
      // booking that row invented. Same three steps /attach performs, so
      // /unattach is its exact inverse.
      let movedInv = 0;
      for (const l of moveInvoice) {
        if (dryRun) { movedInv += 1; continue; }
        const { rows: [gone] } = await pool.query(
          `UPDATE expenses SET deleted = true, deleted_by = 'funding-leg-sweep', deleted_at = NOW()
            WHERE id = $1 AND entry_source = 'bank_statement'
              AND (deleted = false OR deleted IS NULL) RETURNING id`,
          [l.b_match]).catch(() => ({ rows: [] }));
        if (!gone) continue;
        await pool.query(`UPDATE expenses SET deleted = true, deleted_by = 'funding-leg-sweep', deleted_at = NOW()
           WHERE parent_id = $1 AND entry_source = 'bank_statement'`, [gone.id]).catch(() => {});
        const { rowCount } = await pool.query(
          // A creator payment keeps its own disposition when it moves. 'rematch'
          // feeds bucket.matched, which invoice_backed_pct reduces over, so
          // hard-coding it here would have had this sweep quietly report
          // creator payments as invoice-backed on every statement upload.
          `UPDATE bank_transactions SET matched_expense_id = $1,
             match_method = ${movedMatchMethodSql('$1', 'rematch')},
             matched_by = 'funding-leg-sweep', matched_at = NOW()
           WHERE id = $2 AND dismissed = false`, [l.pp_match, l.bank_id]).catch(() => ({ rowCount: 0 }));
        if (!rowCount) {
          // Put the booking back rather than leave the row holding nothing.
          await pool.query(`UPDATE expenses SET deleted = false, deleted_by = NULL, deleted_at = NULL
             WHERE id = $1 OR parent_id = $1`, [gone.id]).catch(() => {});
          continue;
        }
        // The displaced booking's recoupment state follows the invoice that
        // replaced it. Runs only after the rematch succeeded — the restore
        // branch above returns before here.
        await carryEntryState(pool, gone.id, l.pp_match).catch(() => {});
        // Links follow the match — a consolidated payment carries several.
        await pool.query(`UPDATE bank_txn_invoice_links SET txn_id = $1 WHERE txn_id = $2`,
          [l.bank_id, l.pp_id]).catch(() => {});
        await pool.query(
          `UPDATE bank_transactions SET matched_expense_id = NULL, match_method = NULL, match_score = NULL,
             matched_by = NULL, matched_at = NULL, dismissed = true,
             dismissed_reason = 'paypal copy — this payment is counted from its bank statement row'
           WHERE id = $1`, [l.pp_id]).catch(() => {});
        movedInv += 1;
      }
      if (movedInv && !dryRun) {
        await audit({ name: 'funding-leg-sweep' }, 'statement_funding_invoice_moved', null, null,
          `${movedInv} invoice match(es) moved from a PayPal copy onto the bank statement row that funded them; `
          + 'the booking each of those rows had invented was displaced, and /unattach restores it');
      }
      // Two records, one payment: dissolve the invented PayPal-side one into the
      // bank record, keeping any attribution only IT had, then close the copy.
      let merged = 0;
      for (const l of mergeBoth) {
        if (dryRun) { merged += 1; continue; }
        const { rows: [gone] } = await pool.query(
          `UPDATE expenses SET deleted = true, deleted_by = 'funding-leg-sweep', deleted_at = NOW()
            WHERE id = $1 AND entry_source = 'bank_statement'
              AND (deleted = false OR deleted IS NULL) RETURNING id`,
          [l.pp_match]).catch(() => ({ rows: [] }));
        if (!gone) continue;
        // Same carry the manual close performs — this sweep runs unattended on a
        // throttle, so it is the path most able to lose a mark without anyone
        // watching it happen.
        if (l.b_match) await carryEntryState(pool, gone.id, l.b_match).catch(() => {});
        const fill = [];
        const vals = [];
        if (!String(l.b_artist || '').trim() && String(l.pp_artist || '').trim()) { vals.push(l.pp_artist); fill.push(`artist = $${vals.length}`); }
        if (!String(l.b_song || '').trim() && String(l.pp_song || '').trim()) { vals.push(l.pp_song); fill.push(`song = $${vals.length}`); }
        if (!String(l.b_category || '').trim() && String(l.pp_category || '').trim()) { vals.push(l.pp_category); fill.push(`category = $${vals.length}`); }
        if (fill.length && l.b_match) {
          vals.push(l.b_match);
          await pool.query(`UPDATE expenses SET ${fill.join(', ')} WHERE id = $${vals.length}`, vals).catch(() => {});
        }
        await pool.query(
          `UPDATE bank_transactions SET matched_expense_id = NULL, match_method = NULL, match_score = NULL,
             matched_by = NULL, matched_at = NOW(), dismissed = true,
             dismissed_reason = 'paypal copy — this payment is counted from its bank statement row'
           WHERE id = $1`, [l.pp_id]).catch(() => {});
        merged += 1;
      }
      if (merged && !dryRun) {
        await audit({ name: 'funding-leg-sweep' }, 'statement_funding_pairs_merged', null, null,
          `${merged} payment(s) were carrying TWO ledger records — the invented PayPal-side entry was removed and its `
          + 'attribution folded into the bank statement record, which is the row the report counts');
      }
      return { dry_run: dryRun, window_days: WINDOW_DAYS, scanned: legs.length,
        closed_paypal_twin: dismissPpIds.length,
        moved_record_to_bank: movedN,
        moved_invoice_to_bank: movedInv,
        merged_double_record: merged,
        left_for_double_funding_flag: leftForFlag.length,
        detail: dryRun ? {
          close_paypal_twin: legs.filter((l) => dismissPpIds.includes(l.pp_id)).map(brief),
          move_record_to_bank: moveToBank.map(brief),
          move_invoice_to_bank: moveInvoice.map(brief),
          merge_double_record: mergeBoth.map(brief),
          left_for_double_funding_flag: leftForFlag.map(brief),
        } : undefined };
    } catch (err) {
      if (dryRun) throw err;
      console.error('funding-pair sweep skipped:', err.message);
      return null;
    }
}

router.get('/', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const sweepNow = Date.now();
    if (!sweepsInFlight && sweepNow - sweepsLastRun > 10 * 60 * 1000) {
      sweepsInFlight = true;
      sweepsLastRun = sweepNow;
      runBalanceBackfill(); // fire-and-forget — never blocks this request
      try {
    // A deploy restart mid-parse strands 'parsing' forever — flip stale ones.
    // 25min: a real parse of a dense statement takes 6-8min (316 txns = 6.4min
    // observed); the window must comfortably exceed the slowest legit parse.
    await pool.query(`UPDATE bank_statements SET status = 'error',
        error = 'Parsing was interrupted (server restarted) — delete this and re-upload.'
      WHERE status = 'parsing'
        AND COALESCE(parse_started_at, created_at) < NOW() - INTERVAL '25 minutes'`).catch(() => {});
    // Retroactive payee/email split (idempotent): older rows arrived with
    // "name / email" mashed into payee_guess — pull the email out into its
    // own column and strip it from the name, like the statement shows them.
    await pool.query(String.raw`
      UPDATE bank_transactions SET
        payee_email = LOWER(substring(payee_guess from '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')),
        payee_guess = btrim(regexp_replace(payee_guess, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '', 'g'), ' /|,-')
      WHERE payee_email IS NULL
        AND payee_guess ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'`).catch(() => {});
    // Retroactive internal-noise cleanup (idempotent): first UNLINK any
    // AUTO-matched internal row — a currency conversion that amount-matched
    // an invoice is a false positive (manual matches are left alone) — then
    // dismiss all unmatched internal rows.
    await pool.query(
      `UPDATE bank_transactions SET matched_expense_id = NULL, match_method = NULL,
         match_score = NULL, matched_by = NULL, matched_at = NULL
        WHERE match_method LIKE 'auto%' AND description ILIKE ANY($1)`,
      [INTERNAL_ILIKE]).catch(() => {});
    await pool.query(
      `UPDATE bank_transactions SET dismissed = true, dismissed_reason = 'internal transfer / conversion'
        WHERE dismissed = false AND matched_expense_id IS NULL AND description ILIKE ANY($1)`,
      [INTERNAL_ILIKE]).catch(() => {});
    // REMOVED (2026-08-18): a blanket "dismiss every unmatched PAYPAL DES: row
    // whose date a PayPal statement covers". It was the old model — PayPal
    // canonical, bank leg discarded — and it fought the pairwise sweep below,
    // re-dismissing 130 bank rows minutes after they were deliberately restored.
    //
    // It also could not tell WHICH PayPal row a pull belonged to, so it dismissed
    // on nothing more than "a PayPal statement covers this month". The pair sweep
    // does the same job per payment, with the recipient's name as evidence, and
    // an unpaired pull now stays live — it is the statement of record, and the
    // flags page names the ones with no PayPal statement behind them.
    // PayPal funding pairs (idempotent). John's funding model: PayPal never
    // spends a held balance — every PayPal payment is funded by the bank
    // account/debit card, so it appears TWICE: the per-payment record on
    // the PayPal statement (canonical: full name, email, FX) and a funding
    // row on the bank statement ("PAYPAL DES:PURCHASE ID:CHASEMANN8",
    // recipient-named IAT/WEB pulls, "PAYPAL *MERCHANT" card charges).
    // Exactly-once policy per live twin pair (same amount, ±3 days):
    //   · bank open                → dismiss the bank leg
    //   · bank AUTO-matched        → unlink + dismiss the bank leg
    //   · bank manual/created,
    //     PayPal twin still open   → dismiss the PayPal twin (the human
    //                                already recorded it from the bank side)
    //   · bank manual/created,
    //     PayPal twin also counted → left for the double-funding flag
    //
    // WHICH SIDE SURVIVES, and why it changed (2026-08-18, John): the BANK row.
    // The P&L and Financials are built on statement rows, and the BofA statement
    // is the one that reconciles to a printed balance — so the money has to stay
    // on that side and the PayPal twin is the copy that closes. Previously this
    // kept PayPal (it names the recipient) and dismissed the pull, which put the
    // counted row on the statement that does NOT tie out.
    //
    // The recipient's name is not lost: the ledger ENTRY moves to the bank row
    // and keeps its payee, and the vendor page now matches rows by their entry's
    // payee as well as by the descriptor.
    // PAYPAL-labeled bank rows carry no recipient name (payee is "PAYPAL")
    // — pairing is amount+date; recipient-named pulls also require a
    // similar payee. Greedy 1:1 so two $25 pulls need two twins.
    // Runs here, on the same 10-minute throttle as the rest of this
    // housekeeping. The classification lives in runFundingPairSweep so a preview
    // can reach it without writing.
    await runFundingPairSweep();
    // Currency repair (idempotent): the PDF parser stored every amount as
    // USD; PayPal's foreign rows carry the real currency at the end of the
    // description ("General Payment - JPY"). ¥237,858 read as $237,858.
    await pool.query(String.raw`
      UPDATE bank_transactions
         SET currency = UPPER(substring(description from '[-–] ?(JPY|EUR|GBP|CAD|AUD|CHF|MXN|BRL|SEK|NOK|DKK|NZD|HKD|SGD|PLN|CZK|HUF|ILS|THB|PHP|TWD) *$'))
       WHERE (currency IS NULL OR currency = 'USD')
         AND description ~ '[-–] ?(JPY|EUR|GBP|CAD|AUD|CHF|MXN|BRL|SEK|NOK|DKK|NZD|HKD|SGD|PLN|CZK|HUF|ILS|THB|PHP|TWD) *$'`).catch(() => {});
    // Orphaned statement bookings (idempotent): an entry CREATED from a
    // bank debit whose link is gone (deleted statement, historical race)
    // keeps counting in the ledger with no bank evidence — the exact
    // "recorded twice" failure once the debit is re-booked. Soft-delete;
    // restorable from the archive.
    try {
      const { rows: orphans } = await pool.query(`
        SELECT id FROM expenses r
         WHERE r.entry_source = 'bank_statement' AND r.parent_id IS NULL
           AND (r.deleted = false OR r.deleted IS NULL)
           AND NOT EXISTS (SELECT 1 FROM bank_transactions bt WHERE bt.matched_expense_id = r.id)`);
      if (orphans.length) {
        const ids = orphans.map((r) => r.id);
        await pool.query(
          // entry_source on BOTH halves. The SELECT above is guarded, but the
          // parent_id clause was not — so an automatic sweep could delete a
          // non-bank-born child of a bank-born parent, and a hand-entered child
          // is exactly the kind of row that can carry a recoupment claim.
          // 19 of the 22 delete sites in this file already carry this guard.
          `UPDATE expenses SET deleted = true, deleted_by = 'orphan-sweep', deleted_at = NOW()
            WHERE (id = ANY($1) OR parent_id = ANY($1)) AND entry_source = 'bank_statement'
              AND (deleted = false OR deleted IS NULL)`, [ids]);
        await audit({ name: 'orphan-sweep' }, 'statement_orphans_removed', null, null,
          `${ids.length} statement-created ledger entr${ids.length === 1 ? 'y' : 'ies'} had no bank link — soft-deleted to prevent double counting`);
      }
    } catch { /* sweep is advisory */ }
    // Income booked at foreign face value (idempotent): before book-income
    // converted currencies, a ¥237,858 credit booked ¥ as $. Repair any
    // income row still equal to its bank credit's foreign face amount.
    try {
      const { rows: faceInc } = await pool.query(`
        SELECT t.id, t.amount, t.currency, t.txn_date, t.matched_income_id
          FROM bank_transactions t
          JOIN artist_income ai ON ai.id = t.matched_income_id
         WHERE COALESCE(t.currency, 'USD') <> 'USD' AND ai.amount = t.amount`);
      for (const r of faceInc) {
        const cur = r.currency.toUpperCase();
        const hist = await getHistorical(String(r.txn_date).slice(0, 10)).catch(() => null);
        const rate = hist?.rates?.[cur] > 0 ? hist.rates[cur] : (getCached()?.rates?.[cur] || 0);
        if (!(rate > 0)) continue;
        const usd = Math.round((Number(r.amount) / rate) * 100) / 100;
        await pool.query(
          `UPDATE artist_income SET amount = $1,
             notes = COALESCE(notes, '') || ' — repaired: ' || $2 || ' ' || $3 || ' @ ' || $4
           WHERE id = $5 AND amount = $6`,
          [usd, Number(r.amount).toLocaleString(), cur, rate.toFixed(4), r.matched_income_id, r.amount]);
      }
    } catch { /* sweep is advisory */ }
    // Expenses booked at foreign face value (idempotent) — the twin of the
    // income repair above, which existed while this side did not.
    //
    // bookDebitAsEntry copies the bank row's amount AND currency, and locks an
    // fx rate for anything non-USD. But the PayPal parser stores every amount as
    // USD and the currency-repair sweep further up fixes the TRANSACTION from
    // the description suffix ("General Payment - MXN"). A row booked in the
    // window between those two reads USD, so the entry keeps the foreign face
    // value labelled as dollars — and the sweep that later fixes the bank row
    // never goes back for the entry it already created.
    //
    // Found 2026-08-19 from John's report that two PayPal rows would not match:
    // MANUEL BENJAMIN GARCIA PELAYO's ledger entry read $25,056.01 when the
    // payment was 25,056.01 MXN ≈ $1,469.26. Six entries were in that state,
    // overstating the ledger by $32,783 — and it is also why the matcher could
    // not see that his real $1,500 invoice fits: it was comparing against a
    // number 17× too big.
    //
    // Restores the ledger's own convention for a foreign row — native amount +
    // currency + locked rate — rather than converting the amount, so no
    // information is lost and usdOf/entryToUsd produce the right dollars
    // everywhere. Idempotent: once currency is no longer USD the row stops
    // matching this query.
    try {
      const { rows: faceExp } = await pool.query(`
        SELECT t.id AS txn_id, t.amount, t.currency, t.txn_date, e.id AS entry_id
          FROM bank_transactions t
          JOIN expenses e ON e.id = t.matched_expense_id
         WHERE COALESCE(t.currency, 'USD') <> 'USD'
           AND t.dismissed = false
           AND e.entry_source = 'bank_statement'
           AND (e.deleted = false OR e.deleted IS NULL)
           AND COALESCE(e.currency, 'USD') = 'USD'
           AND e.amount = t.amount`);
      for (const r of faceExp) {
        const cur = String(r.currency).toUpperCase();
        const hist = await getHistorical(String(r.txn_date).slice(0, 10)).catch(() => null);
        const rate = hist?.rates?.[cur] > 0 ? hist.rates[cur] : (getCached()?.rates?.[cur] || 0);
        if (!(rate > 0)) continue;
        // amount is left alone — it was always the native figure. Only the
        // label and the rate were wrong.
        await pool.query(
          `UPDATE expenses SET currency = $1, fx_rate_to_usd = $2
            WHERE id = $3 AND COALESCE(currency, 'USD') = 'USD' AND amount = $4`,
          [cur, rate, r.entry_id, r.amount]);
      }
      if (faceExp.length) {
        await audit({ name: 'currency-repair' }, 'statement_expense_currency_repaired', null, null,
          `${faceExp.length} booked ledger entr${faceExp.length === 1 ? 'y' : 'ies'} held a foreign face value labelled USD — relabelled with the real currency and the rate on the payment date`);
      }
    } catch { /* sweep is advisory */ }
    // Vendor consolidation (idempotent): booked entries used to carry the
    // RAW card descriptor as payee, fragmenting FACEBK into a vendor per
    // card code. Rename bank-booked entries (and the payee-map lessons
    // pointing at them) to the descriptor-cleaned name; after the first
    // pass this is a no-op.
    try {
      const { rows: bp } = await pool.query(
        `SELECT DISTINCT payee FROM expenses
          WHERE entry_source = 'bank_statement' AND payee IS NOT NULL AND TRIM(payee) <> ''`);
      // Only rename payees that literally exist as raw bank descriptors —
      // merged/edited names (which can legitimately contain digit-bearing
      // tokens, e.g. artist names) must never be re-cleaned.
      const { rows: rawRows } = await pool.query(
        `SELECT DISTINCT payee_guess FROM bank_transactions WHERE payee_guess IS NOT NULL`);
      const rawDescriptors = new Set(rawRows.map((r) => r.payee_guess.trim()));
      for (const r of bp) {
        if (!rawDescriptors.has(r.payee)) continue;
        const clean = displayBankPayee(r.payee);
        if (clean && clean !== r.payee) {
          await pool.query(
            `UPDATE expenses SET payee = $1 WHERE entry_source = 'bank_statement' AND payee = $2`,
            [clean, r.payee]);
          await pool.query(
            `UPDATE statement_payee_map SET ledger_payee = $1 WHERE ledger_payee = $2`,
            [clean, r.payee]).catch(() => {});
        }
      }
    } catch { /* consolidation is advisory */ }
    // Retroactive over-capacity sweep (idempotent): a family may hold
    // several matched debits (installments) but only up to its total.
    // When claims exceed capacity, keep the strongest (created > manual >
    // highest score > earliest) while they fit, reopen the rest. 'created'
    // rows are never unlinked — their expense was created FROM the txn.
    try {
      const { rows: multi } = await pool.query(`
        SELECT t.id, t.amount, t.currency, t.description, t.match_method, t.match_score, t.matched_at,
               t.matched_expense_id AS root
          FROM bank_transactions t
         WHERE t.dismissed = false AND t.matched_expense_id IN (
           SELECT matched_expense_id FROM bank_transactions
            WHERE matched_expense_id IS NOT NULL AND dismissed = false
            GROUP BY matched_expense_id HAVING COUNT(*) > 1)`);
      if (multi.length) {
        const rootIds = [...new Set(multi.map((r) => r.root))];
        const { rows: fams } = await pool.query(`${FAMILY_SQL} AND r.id = ANY($1)`, [rootIds]);
        const totalOf = new Map(fams.map((f) => [f.id, Number(f.family_total)]));
        const curOf = new Map(fams.map((f) => [f.id, (f.currency || 'USD').toUpperCase()]));
        const strength = (r) =>
          (r.match_method === 'created' ? 3e12 : r.match_method === 'manual' ? 2e12 : 0)
          + (Number(r.match_score) || 0) * 1e9
          - (r.matched_at ? new Date(r.matched_at).getTime() / 1e6 : 0);
        const unlink = [];
        for (const rootId of rootIds) {
          const total = totalOf.get(rootId);
          if (total === undefined) continue; // broken-link flag handles missing families
          const group = multi.filter((r) => r.root === rootId)
            .sort((a, b) => strength(b) - strength(a));
          // Cross-currency groups: raw amount sums are meaningless (a USD
          // settle of a GBP invoice, a JPY face value against a USD total).
          // Skip — the currency-mismatch / amount-drift flags cover these.
          const fCur = curOf.get(rootId) || 'USD';
          if (group.some((r) => (r.currency || 'USD').toUpperCase() !== fCur || fxFaceOf(r))) continue;
          let sum = 0;
          for (const r of group) {
            if (r.match_method === 'created') { sum += Number(r.amount); continue; }
            // First-claim-only overshoot, same as capacityOk — otherwise a
            // second $30 fee squats on a paid $30 entry via the $35 floor.
            if (sum + Number(r.amount) <= total + (sum > 0 ? 0.01 : feeTolerance(total))) sum += Number(r.amount);
            else unlink.push(r.id);
          }
        }
        if (unlink.length) {
          await pool.query(`
            UPDATE bank_transactions SET matched_expense_id = NULL, match_method = NULL,
              match_score = NULL, matched_by = NULL, matched_at = NULL
            WHERE id = ANY($1)`, [unlink]);
        }
      }
    } catch { /* sweep is advisory — never block the list */ }
      } finally { sweepsInFlight = false; }
    }
    const { rows } = await pool.query(`
      SELECT s.*,
        COUNT(t.id) FILTER (WHERE t.direction = 'debit')::int AS debits,
        COUNT(t.id) FILTER (WHERE t.direction = 'debit' AND t.matched_expense_id IS NOT NULL)::int AS matched,
        COUNT(t.id) FILTER (WHERE t.direction = 'debit' AND t.dismissed)::int AS dismissed,
        -- What is STILL UNANSWERED per statement, so the page can say where
        -- the remaining work lives. Counted here rather than on the client
        -- because /statements/:id returns one statement's rows, so a
        -- cross-statement breakdown is impossible client-side exactly when it
        -- is most useful — while you are narrowed to a single month.
        --
        -- Explicit FILTERs, never "debits - matched - dismissed": those three
        -- overlap (a row can be dismissed after being matched), and the
        -- subtraction would quietly report a remainder that doesn't exist.
        COUNT(t.id) FILTER (
          WHERE t.direction = 'debit' AND t.matched_expense_id IS NULL AND t.dismissed = false
        )::int AS open_debits,
        COUNT(t.id) FILTER (
          WHERE t.direction = 'credit' AND t.matched_income_id IS NULL AND t.dismissed = false
        )::int AS open_credits,
        COALESCE(SUM(ABS(COALESCE(t.amount_usd, t.amount))) FILTER (
          WHERE t.direction = 'debit' AND t.matched_expense_id IS NULL AND t.dismissed = false
        ), 0)::float AS open_value
      FROM bank_statements s
      LEFT JOIN bank_transactions t ON t.statement_id = s.id
      GROUP BY s.id ORDER BY s.created_at DESC`);
    // Flag period overlaps within the same account — an overlapping upload
    // is the main way a month gets double-counted.
    for (const s of rows) {
      if (!s.period_start || !s.period_end) continue;
      const other = rows.find((o) => o.id !== s.id && o.account === s.account
        && o.period_start && o.period_end
        && !(new Date(o.period_end) < new Date(s.period_start) || new Date(o.period_start) > new Date(s.period_end)));
      if (other) s.overlaps_with = other.filename;
    }
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Family totals for every approved, live expense — the unit the bank sees.
// Root = the parent (or a standalone row); total = parent slice + children.
// ── No document, no match ───────────────────────────────────────────────────
//
// John, 2026-08-19: "statement items shouldn't be able to match to added
// expenses." Measured before implementing, because taken literally it would
// have done real damage: 564 live matches worth $2,166,979 point at hand-added
// expenses, and 555 of them have the invoice PDF on file — Venable LLP $70,930,
// Feel Trip Musica $200,000. Those are real invoices somebody typed in instead
// of the vendor submitting them, and refusing them would collapse the
// invoice-backed figure the whole page is built to raise.
//
// The 9 that matter are hand-added AND carry no document at all ($43,960).
// Matching a bank line to one of those reports the payment as invoice-backed
// with nothing behind it — the exact claim "booked is not matched" exists to
// stop being made loosely.
//
// A separate, related guard already exists: runAutoMatch has always excluded
// statement-born entries from its pool, which is why only 2 circular matches
// exist in the whole ledger.
//
// IS DISTINCT FROM, never <>. 1,201 live rows carry a NULL entry_source
// (everything predating the column), and `entry_source <> 'bank_statement'` is
// NULL for every one of them — a plain inequality would exempt most of the
// ledger from this rule rather than apply it. Same trap as excludeBankRows.
//
// Document presence tests the R2 key AND the filename, the same OR the rest of
// the codebase uses: files live in R2 now, but a filename can outlive a blob.
//
// ── The one exemption: creator payments ─────────────────────────────────────
// A row entered on /bk/creators is undocumented BY DESIGN — the marketing team
// pays a creator directly and no invoice exists to attach. Refusing to
// reconcile it would leave real money permanently unexplainable on a statement
// that plainly shows it left.
//
// It is exempted from the REFUSAL and, separately, kept out of
// `invoice_backed_pct` (see the bucketing near the bottom of this file). Those
// are two different acts, and doing only the first is exactly the false claim
// this rule exists to prevent. The exemption keys on entry_source and nothing
// else, so it cannot widen into "any row somebody forgot to attach a file to".
//
// excludeCreatorRows, NOT `NOT (entry_source = '...')`. The first version of
// this line used the negated equality and the fixture caught it immediately:
// `NULL = 'creator_payment'` is NULL, `NOT NULL` is NULL, so the whole AND
// chain went NULL for every row with a NULL entry_source — 1,201 of them — and
// the no-document rule silently stopped applying to most of the ledger. The
// note twenty lines above warns about precisely this and I walked into it
// anyway; IS DISTINCT FROM is the only null-safe form here.
const UNDOCUMENTED_ADDED_SQL = (e = 'e') => `(
  ${e}.entry_source IS DISTINCT FROM 'bank_statement'
  AND ${excludeCreatorRows(e)}
  AND ${e}.vendor_submitted IS NOT TRUE
  AND ${e}.invoice_r2_key IS NULL
  AND ${e}.invoice_filename IS NULL
)`;

/**
 * Refuse a match whose target is a hand-added expense with no document.
 * @returns {Promise<string|null>} the reason to refuse with, or null to allow.
 */
async function undocumentedAddedReason(expenseId) {
  if (!expenseId) return null;
  const { rows: [e] } = await pool.query(
    `SELECT payee, ${UNDOCUMENTED_ADDED_SQL('e')} AS blocked FROM expenses e WHERE e.id = $1`,
    [expenseId]).catch(() => ({ rows: [] }));
  if (!e || !e.blocked) return null;
  return `${e.payee || 'That entry'} was added by hand and has no invoice on file, so matching this payment to it `
    + 'would report the bank line as invoice-backed with no document behind it. '
    + 'Upload the invoice onto that entry first, or book this line instead.';
}

const FAMILY_SQL = `
  SELECT r.id, r.payee, r.payment_status, r.payment_date, r.invoice_date, r.entry_source,
         r.vendor_submitted,
         -- Has anybody answered "is this recoupable?" for this entry, and what
         -- did they say. Two booleans and not one, because recoupable on its own
         -- is BOOLEAN DEFAULT TRUE: a row nobody has looked at is
         -- indistinguishable from one somebody answered yes to, which is the
         -- whole reason the review queue holds 1,919 rows. Only the PAIR can
         -- tell the card whether to show an answer or ask for one.
         -- (No backticks in here: this is inside a JS template literal.)
         r.recoupable, r.recoup_reviewed,
         r.scheduled_payment_date, r.payment_method, COALESCE(r.currency,'USD') AS currency,
         r.fx_rate_to_usd, r.invoice_number, r.payment_ref, r.artist, r.category, r.vendor_email,
         -- Declared "these invoices arrive as ONE payment" (see the marked-group
         -- tier in runAutoMatch). Selected here so the matcher can group its own
         -- candidate pool without a second pass over expenses.
         r.settlement_group,
         r.amount AS own_amount,
         -- Identity fields for the candidate cards. When a bank line offers
         -- several candidates the UI highlights only what SEPARATES them, so
         -- these are what makes two same-vendor same-amount invoices tellable
         -- apart. description is capped because the widest consumer of this
         -- query (line ~2358) pulls every approved family with no filter.
         r.song, r.boom_rep, r.created_at, LEFT(r.description, 200) AS description,
         -- Does a document exist, and what is it called?
         --
         -- Detected from the R2 key or the filename, NEVER from *_data. Those
         -- are the multi-MB base64 columns EXPENSE_LIGHT_COLS deliberately
         -- omits, and this query is the prime suspect in a 17-second page load
         -- — reading a blob to answer "is there a file" is the wrong trade.
         -- Files are migrated to R2, so this is accurate for essentially
         -- everything. Caveat: a filename can outlive a blob truncated before
         -- the R2 cutover, which is what /bk/bulk-reupload exists to repair, so
         -- the button can occasionally open a broken file. Visibly broken beats
         -- unreachable.
         (r.invoice_r2_key IS NOT NULL OR r.invoice_filename IS NOT NULL) AS has_invoice,
         (r.proof_r2_key IS NOT NULL OR r.proof_filename IS NOT NULL) AS has_proof,
         (r.receipt_filename IS NOT NULL) AS has_receipt,
         r.invoice_filename, r.proof_filename, r.receipt_filename,
         -- Children aggregated ONCE, not twice per row.
         --
         -- These were two correlated subqueries — one for the array, one for
         -- the sum — each a dependent scan of the expenses table per parent.
         -- On the widest consumer (/statements/all resolves 2,813 matched families
         -- in one call) that is ~5,600 dependent scans for one request, and
         -- that request had a 16.9-second time-to-first-byte against 0.1s of
         -- transfer.
         --
         -- One grouped scan joined once instead. The deleted/voided filters
         -- live inside the aggregate so the semantics are unchanged: a deleted
         -- or voided child must not appear in child_amounts and must not count
         -- toward family_total, which feeds matching capacity, the reversal
         -- pairing and the P&L. COALESCE keeps a childless parent at '{}' and
         -- its own amount, exactly as the subqueries did.
         COALESCE(k.child_amounts, '{}') AS child_amounts,
         r.amount + COALESCE(k.child_total, 0) AS family_total
  FROM expenses r
  LEFT JOIN (
    SELECT c.parent_id,
           ARRAY_AGG(c.amount) AS child_amounts,
           SUM(c.amount) AS child_total
      FROM expenses c
     WHERE c.parent_id IS NOT NULL
       AND (c.deleted = false OR c.deleted IS NULL)
       AND (c.voided = false OR c.voided IS NULL)
     GROUP BY c.parent_id
  ) k ON k.parent_id = r.id
  WHERE r.parent_id IS NULL
    AND (r.deleted = false OR r.deleted IS NULL)
    AND (r.voided = false OR r.voided IS NULL)
    AND r.status = 'approved'`;

// Ledger-side date evidence: the paid date when Paid, else the scheduled
// payment date — both sit 1-3 business days before the bank settle.
const evidenceDate = (f) => (f.payment_status === 'Paid' ? f.payment_date : f.scheduled_payment_date);

// Exact FX face value from a wire descriptor: "FX:GBP 100.00 1.3745" means
// the debit settled a GBP 100.00 payment — the most precise cross-currency
// evidence a bank row carries.
const fxFaceOf = (txn) => {
  const m = String(txn.description || '').match(/FX:([A-Z]{3}) ?([\d,]+(?:\.\d+)?)/i);
  return m ? { currency: m[1].toUpperCase(), amount: Number(m[2].replace(/,/g, '')) } : null;
};

// A bank txn's amount expressed in a ledger family's own currency, for
// capacity math. A GBP 100 invoice settles as a $137.45 USD debit —
// comparing raw USD against the GBP total wrongly refuses the match.
// Prefer the descriptor's exact FX face value; else convert through USD
// with the locked ledger rate / historical rate at the settle date.
async function amountInFamilyCurrency(txn, fam) {
  const tCur = (txn.currency || 'USD').toUpperCase();
  const fCur = (fam.currency || 'USD').toUpperCase();
  if (tCur === fCur) return Number(txn.amount);
  const face = fxFaceOf(txn);
  if (face && face.currency === fCur) return face.amount;
  const hist = await getHistorical(String(txn.txn_date).slice(0, 10)).catch(() => null);
  const rateOf = (cur) => (cur === 'USD' ? 1
    : hist?.rates?.[cur] > 0 ? hist.rates[cur]
    : getCached()?.rates?.[cur] > 0 ? getCached().rates[cur] : 0);
  const tr = rateOf(tCur);
  if (!(tr > 0)) return Number(txn.amount); // no rate — fall back to raw
  const usd = Number(txn.amount) / tr;
  const locked = parseFloat(fam.fx_rate_to_usd || 0);
  const fr = locked > 0 ? locked : rateOf(fCur);
  return fr > 0 ? usd * fr : Number(txn.amount);
}

// Installments: a split family can be paid in several wires — one per
// slice. A family's remaining CAPACITY (total − already-matched debits)
// decides whether another debit may claim it; slice amounts (parent's own
// + each child's) count as amount evidence alongside the family total.
async function loadClaimedSums() {
  const { rows } = await pool.query(`
    SELECT matched_expense_id AS id, COALESCE(SUM(amount), 0) AS total, COUNT(*)::int AS n
      FROM bank_transactions
     WHERE matched_expense_id IS NOT NULL AND dismissed = false
     GROUP BY matched_expense_id`);
  return new Map(rows.map((r) => [r.id, { total: Number(r.total), n: r.n }]));
}
const claimedOf = (claims, id) => claims.get(id)?.total || 0;
// Overshoot (the fee riding on a wire) is only allowed on a family's FIRST
// claim. Once anything is claimed, capacity is strict — otherwise the $35
// tolerance floor lets every small recurring charge (a $30 fee, a $12.99
// subscription) claim an already-fully-paid twin from another row or month.
const capacityOk = (f, amt, claims) => {
  const total = Number(f.family_total);
  const claimed = claimedOf(claims, f.id);
  return claimed + Number(amt) <= total + (claimed > 0 ? 0.01 : feeTolerance(total));
};
const sliceAmounts = (f) => [Number(f.family_total), Number(f.own_amount || f.family_total),
  ...((f.child_amounts || []).map(Number))].filter((n) => n > 0);
// Closest distance between the txn amount and any payable unit of the
// family: the whole total, the remaining capacity, or an individual slice.
const bestAmountDiff = (f, amt, claims) => {
  const remaining = Number(f.family_total) - claimedOf(claims, f.id);
  const targets = [...sliceAmounts(f), remaining].filter((n) => n > 0.009);
  return Math.min(...targets.map((x) => Math.abs(Number(amt) - x)));
};

const methodOf = (vm) =>
  vm.reason === 'reference' || vm.reason === 'invoice#' ? 'auto-ref'
  : vm.reason === 'email' ? 'auto-email'
  : vm.reason === 'learned' ? 'auto-learned'
  : vm.reason === 'alias' || vm.reason === 'alias-fuzzy' ? 'auto-alias'
  : 'auto-fuzzy';

const methodCompatible = (account, method) => {
  const m = (method || '').toLowerCase();
  return account === 'paypal' ? (m === 'paypal' || m === '') : m !== 'paypal';
};

// GET /api/statements/search?q= — global search across every transaction in
// every statement: payee, email, description, reference, matched ledger
// payee, or an exact amount. Powers the page-top search bar.
router.get('/search', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, data: [] });
    const like = `%${likeEscape(q)}%`;
    const amt = q.replace(/[$,]/g, '');
    const amtNum = /^\d+(\.\d{1,2})?$/.test(amt) ? Number(amt) : null;
    const { rows } = await pool.query(`
      SELECT t.id, t.statement_id, t.txn_date, t.amount, t.direction,
             COALESCE(t.currency, 'USD') AS currency, t.payee_guess, t.payee_email,
             t.description, t.reference, t.dismissed, t.matched_expense_id,
             t.matched_income_id, t.match_method, s.filename, s.account,
             e.payee AS matched_payee
      FROM bank_transactions t
      JOIN bank_statements s ON s.id = t.statement_id
      LEFT JOIN expenses e ON e.id = t.matched_expense_id
      WHERE t.payee_guess ILIKE $1 OR t.description ILIKE $1 OR t.payee_email ILIKE $1
         OR t.reference ILIKE $1 OR e.payee ILIKE $1${amtNum != null ? ' OR t.amount = $2' : ''}
      ORDER BY t.txn_date DESC, t.id DESC
      LIMIT 50`, amtNum != null ? [like, amtNum] : [like]);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Bank lines a PERSON has assigned to a vendor, overruling the descriptor.
//
// Degrades to "nobody has overridden anything" the way loadNoInvoiceRowIds
// does, and for the same reason: runMigrations() runs in the BACKGROUND after
// app.listen, so a SELECT naming a young column 500s every consumer for the
// first seconds of a deploy — and permanently if an earlier migration throws.
// The directory and the vendor pages are exactly the endpoints that must not go
// down for a feature nobody has used yet.
async function loadVendorOverrides() {
  const { rows } = await pool.query(
    `SELECT id, vendor_override FROM bank_transactions
      WHERE COALESCE(TRIM(vendor_override), '') <> ''`)
    .catch(() => ({ rows: [] }));
  return new Map(rows.map((r) => [r.id, String(r.vendor_override).trim()]));
}

// The group key a row belongs to. An override takes the row OUT of its
// descriptor's group entirely — that is what "move this one line" means, and a
// row that stayed in its old group while also appearing on the new vendor would
// be counted twice.
const OVERRIDE_KEY = (name) => `ledger:${String(name).toLowerCase().trim()}`;

// Bank-vendor aggregation — every debit payee across all ready statements
// (descriptor-normalized so card code variants collapse), with spend,
// triage state, learned mappings, and the linked ledger vendor. Shared by
// GET /statements/vendors and the unified vendors directory in
// routes/bookkeeping.js (exported as router.aggregateBankVendors).
async function aggregateBankVendors() {
    const { rows: txns } = await pool.query(`
      SELECT t.id, t.payee_guess, t.amount, COALESCE(t.currency, 'USD') AS currency,
             t.txn_date, t.dismissed,
             t.matched_expense_id, t.match_method, e.category, e.payee AS ledger_payee,
             e.artist
        FROM bank_transactions t
        JOIN bank_statements s ON s.id = t.statement_id AND s.status = 'ready'
        LEFT JOIN expenses e ON e.id = t.matched_expense_id
          AND (e.deleted = false OR e.deleted IS NULL)
       WHERE t.direction = 'debit' AND COALESCE(TRIM(t.payee_guess), '') <> ''`);
    // "Still needs a decision" — /completion's own predicate, not a second one.
    // The directory's OPEN column counts only rows with NO ledger entry at all
    // (12 in the whole system), which is why every vendor with a real pile reads
    // "open 0": FACEBOOK 195 lines, SPOTIFY 151, UBER 133, all invisible.
    const noInvoiceExpected = await makeNoInvoiceExpected();
    const overheadAnswered = await makeOverheadAnswered();
    const { rows: catMapRows } = await pool.query(
      `SELECT bank_payee, category, times FROM statement_category_map`).catch(() => ({ rows: [] }));
    const { rows: payeeMapRows } = await pool.query(
      `SELECT bank_payee, ledger_payee FROM statement_payee_map`).catch(() => ({ rows: [] }));
    const learnedCat = new Map(catMapRows.map((r) => [r.bank_payee.toLowerCase(), { category: r.category, times: r.times }]));
    const learnedPayee = new Map(payeeMapRows.map((r) => [normalizeBankPayee(r.bank_payee), r.ledger_payee]));

    const overrides = await loadVendorOverrides();

    const groups = new Map();
    for (const t of txns) {
      const ovr = overrides.get(t.id);
      const key = ovr
        ? OVERRIDE_KEY(ovr)
        : (normalizeBankPayee(t.payee_guess) || t.payee_guess.toLowerCase().trim());
      if (!groups.has(key)) {
        groups.set(key, { key, names: new Map(), txns: 0, total: 0, open_n: 0, open_total: 0,
          booked_n: 0, matched_n: 0, dismissed_n: 0, needs_n: 0, needs_total: 0,
          needs_artist_n: 0, needs_artist_total: 0,
          cats: new Map(), ledger: new Map(), last_seen: null });
      }
      const g = groups.get(key);
      if (ovr) g.override = ovr;
      // The group's display name still comes from the descriptors it holds —
      // an overridden group says WHERE the money went, not what the bank
      // called it — except when the override is the only thing defining the
      // group, where the descriptor would name the wrong company.
      const raw = ovr || t.payee_guess.trim();
      g.names.set(raw, (g.names.get(raw) || 0) + 1);
      g.txns++;
      // USD-converted — a ¥237,858 row is ~$1,500 of vendor spend, not $237k
      const fxr = t.currency === 'USD' ? 1 : (getCached()?.rates?.[t.currency] || 0);
      const usd = fxr > 0 ? Number(t.amount) / fxr : Number(t.amount);
      g.total += usd;
      // pg returns DATE as a JS Date — String() gives "Wed Mar 11 …" which
      // downstream parsing renders as "undefined/undefined".
      const d = t.txn_date instanceof Date ? t.txn_date.toISOString().slice(0, 10) : String(t.txn_date).slice(0, 10);
      if (!g.last_seen || d > g.last_seen) g.last_seen = d;
      if (t.dismissed) g.dismissed_n++;
      else if (!t.matched_expense_id) { g.open_n++; g.open_total += usd; }
      else if (t.match_method === 'created') g.booked_n++;
      else g.matched_n++;
      // The number the directory was missing: a line with no invoice behind it
      // that nobody has said will never have one. Same test the Bank Matching
      // queue counts, applied per vendor.
      if (!t.dismissed
        && (!t.matched_expense_id || t.match_method === 'created')
        && !noInvoiceExpected({ id: t.id, category: t.category, payee: t.ledger_payee, payee_guess: t.payee_guess })) {
        g.needs_n++; g.needs_total += usd;
      }
      // The OTHER half of a booked row's debt: it has a category we guessed and
      // no artist at all, which is why Spend by Artist covers ~27% of spend —
      // 2,165 rows worth $3.7M name nobody. Same predicate as /unattributed.
      if (needsArtist(t, overheadAnswered)) {
        g.needs_artist_n++; g.needs_artist_total += usd;
      }
      if (t.category) g.cats.set(t.category, (g.cats.get(t.category) || 0) + 1);
      if (t.ledger_payee) g.ledger.set(t.ledger_payee, (g.ledger.get(t.ledger_payee) || 0) + 1);
    }
    const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const data = [...groups.values()].map((g) => ({
      key: g.key,
      name: top(g.names),
      txns: g.txns,
      total: Math.round(g.total * 100) / 100,
      open_n: g.open_n,
      open_total: Math.round(g.open_total * 100) / 100,
      booked_n: g.booked_n,
      matched_n: g.matched_n,
      dismissed_n: g.dismissed_n,
      // Lines still needing a decision — not matched to an invoice, and nobody
      // has said this vendor never sends one.
      needs_n: g.needs_n,
      needs_total: Math.round(g.needs_total * 100) / 100,
      // Booked lines with no artist and no overhead answer.
      needs_artist_n: g.needs_artist_n,
      needs_artist_total: Math.round(g.needs_artist_total * 100) / 100,
      top_category: top(g.cats),
      // EVERY ledger vendor this group's rows are matched to, not just the most
      // common one. On a shared descriptor the top payee is a popularity contest:
      // two PayPal pulls to two different people gave the group ONE ledger_vendor,
      // so the second person's own payment was invisible on their page while the
      // first person's was fine. The vendor page tests membership of this list.
      ledger_vendors: [...g.ledger.keys()].filter(Boolean),
      learned_category: learnedCat.get(g.key)?.category || null,
      learned_times: learnedCat.get(g.key)?.times || 0,
      // Explicit link (payee map — drives 1.0 match evidence) vs what the
      // existing matches merely infer.
      // A person's assignment IS an explicit link — stronger than the learned
      // payee map, which is a lesson inferred from past matches.
      linked_vendor: g.override || learnedPayee.get(g.key) || null,
      ledger_vendor: g.override || top(g.ledger) || null,
      overridden: Boolean(g.override),
      last_seen: g.last_seen,
    })).sort((a, b) => b.total - a.total);
    return data;
}
router.aggregateBankVendors = aggregateBankVendors;

router.get('/vendors', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    res.json({ success: true, data: await aggregateBankVendors() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/statements/vendors/activity?ledger=NAME — the bank side of one
// ledger vendor for the detail page: its linked/inferred payee groups, a
// summary, and recent transactions with match status.
router.get('/vendors/activity', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const ledger = String(req.query.ledger || '').trim();
    if (!ledger) return res.status(400).json({ success: false, error: 'ledger required' });
    const lower = ledger.toLowerCase();
    const groups = await aggregateBankVendors();
    const { rows: aliasRows } = await pool.query(`SELECT primary_name, alias FROM vendor_aliases`).catch(() => ({ rows: [] }));
    const aliasSet = new Set(aliasRows
      .filter((a) => a.primary_name && a.alias && a.primary_name.toLowerCase().trim() === lower)
      .map((a) => a.alias.toLowerCase().trim())
      // A PAYMENT CHANNEL IS NOT AN ALIAS, however it got into the table.
      //
      // "PAYPAL NETFLIX.COM" carries the alias "PAYPAL", and an alias makes a bank
      // group EXPLICIT — so the PAYPAL group, 154 pulls to dozens of different
      // people, became wholly that vendor's. 71 rows worth $46,348 on the Netflix
      // subscription's page: Samel Berry-foster, chase mann, Kathryn Turner.
      //
      // The same guard learnPayeeMap and /vendors/link already apply on the write
      // side. This is the read side, for the rows already there.
      .filter((a) => !isChannelOnlyPayee(a)));
    // EXPLICIT vs INFERRED inclusion, and they must not bring the same rows.
    //
    // An explicit link (or the group's own name) says "this bank descriptor IS
    // this vendor" — the whole group belongs here, unanswered rows included,
    // because those are the ones needing a decision.
    //
    // `ledger_vendor` is different: it is merely the MOST COMMON payee among the
    // entries the group's rows happen to be matched to. On a shared descriptor
    // that is a popularity contest, not an identity — the "PAYPAL" group is 154
    // pulls to dozens of different people, and including it whole put all of them
    // on one vendor's page. So an inferred group contributes ONLY the rows whose
    // own matched entry names this vendor.
    const explicitOf = (g) => (g.linked_vendor || '').toLowerCase().trim() === lower
      || (g.name || '').toLowerCase().trim() === lower
      || aliasSet.has((g.name || '').toLowerCase().trim());
    const namesMe = (g) => (g.ledger_vendors || [g.ledger_vendor])
      .some((n) => String(n || '').trim().toLowerCase() === lower);
    const mine = groups.filter((g) => explicitOf(g) || namesMe(g));
    // NOT an early return any more. A vendor can have NO matching bank payee
    // group and still own statement rows: after its invoice is deleted, a
    // nameless "PAYPAL" pull belongs to no group at all, and bailing here meant
    // the descriptor test below never got to speak. That is how a real $800
    // payment left Strega's page. Decided after the rows are known instead.

    // Keys whose rows must each name this vendor to be shown.
    const inferredKeys = new Set(mine.filter((g) => !explicitOf(g)).map((g) => g.key));
    const explicitKeys = new Set(mine.filter(explicitOf).map((g) => g.key));
    const keys = new Set(mine.map((g) => g.key));
    const { rows: txns } = await pool.query(`
      SELECT t.id, t.payee_guess, t.description, t.amount, COALESCE(t.currency, 'USD') AS currency,
             t.txn_date, t.dismissed, t.dismissed_reason, t.no_invoice_expected,
             t.flagged, t.flagged_by,
             t.matched_expense_id, t.match_method, t.statement_id, t.direction,
             e.invoice_number, e.category AS matched_category, e.artist AS matched_artist,
             e.payee AS ledger_payee, e.amount AS matched_amount,
             COALESCE(e.currency, 'USD') AS matched_currency, e.song AS matched_song,
             ((e.invoice_data IS NOT NULL AND e.invoice_data != '') OR e.invoice_r2_key IS NOT NULL) AS has_invoice,
             ((e.proof_data IS NOT NULL AND e.proof_data != '') OR e.proof_r2_key IS NOT NULL) AS has_proof,
             e.invoice_filename, e.proof_filename,
             s.filename, s.account
        FROM bank_transactions t
        JOIN bank_statements s ON s.id = t.statement_id AND s.status = 'ready'
        LEFT JOIN expenses e ON e.id = t.matched_expense_id
       WHERE t.direction = 'debit' AND COALESCE(TRIM(t.payee_guess), '') <> ''`)
      // `no_invoice_expected` is a young column and runMigrations() runs in the
      // BACKGROUND after app.listen — naming it in a SELECT 500s this endpoint
      // for the first seconds of every deploy, and permanently if an earlier
      // migration throws. Retry once without it rather than take the panel down.
      .catch(async (err) => {
        if (!/no_invoice_expected/.test(err.message || '')) throw err;
        return pool.query(`
          SELECT t.id, t.payee_guess, t.description, t.amount, COALESCE(t.currency, 'USD') AS currency,
                 t.txn_date, t.dismissed, t.dismissed_reason, false AS no_invoice_expected,
                 t.flagged, t.flagged_by,
                 t.matched_expense_id, t.match_method, t.statement_id, t.direction,
                 e.invoice_number, e.category AS matched_category, e.artist AS matched_artist,
                 e.payee AS ledger_payee, e.amount AS matched_amount,
                 COALESCE(e.currency, 'USD') AS matched_currency, e.song AS matched_song,
                 ((e.invoice_data IS NOT NULL AND e.invoice_data != '') OR e.invoice_r2_key IS NOT NULL) AS has_invoice,
                 ((e.proof_data IS NOT NULL AND e.proof_data != '') OR e.proof_r2_key IS NOT NULL) AS has_proof,
                 e.invoice_filename, e.proof_filename,
                 s.filename, s.account
            FROM bank_transactions t
            JOIN bank_statements s ON s.id = t.statement_id AND s.status = 'ready'
            LEFT JOIN expenses e ON e.id = t.matched_expense_id
           WHERE t.direction = 'debit' AND COALESCE(TRIM(t.payee_guess), '') <> ''`);
      });
    const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
    // Cents, for the spread the FX proposals report. Local to this handler for
    // the same reason `iso` is; reports.js has its own and they must not drift
    // into a shared helper that rounds differently.
    const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
    // Same predicate as the directory's count and the /unattributed queue, so
    // this band lists exactly what the chip that sent you here counted.
    const overheadAnswered = await makeOverheadAnswered();
    // The LEDGER payee matters here: an overhead rule is written on the vendor's
    // ledger name, so testing the bank descriptor alone would keep showing rows
    // somebody has already answered.
    const needsArtistRow = (t) => needsArtist({ ...t, artist: t.matched_artist }, overheadAnswered);
    // A bank row belongs to this vendor if its DESCRIPTOR resolves here, or if
    // the ledger entry it holds does. The second half matters because a PayPal
    // funding pull is often just "PAYPAL" — 30 of 42 measured — so once the
    // record lives on the bank row, keying only on the descriptor would drop
    // that payment off the page of the vendor who was actually paid.
    // The rule set behind "no invoice expected" — the row flag, the category
    // rules and the vendor rules together. Loaded here rather than testing
    // t.no_invoice_expected alone, because a vendor-scope rule answers rows that
    // carry no flag of their own and the two must agree.
    const noInvoiceExpected = await makeNoInvoiceExpected();

    // "Still needs a decision" — matched to nothing real, and nobody has said
    // this line never gets an invoice. The same test the footer's count and the
    // directory's Needs-matching column use, so the page cannot order itself by
    // one rule and count by another.
    const needsAnswer = (t) => !t.dismissed
      && !noInvoiceExpected({ id: t.id, category: t.matched_category, payee: t.ledger_payee, payee_guess: t.payee_guess })
      && (!t.matched_expense_id || t.match_method === 'created');

    const ledgerNamesLower = new Set([String(req.query.ledger || '').trim().toLowerCase()]);
    for (const g of mine) if (g.name) ledgerNamesLower.add(String(g.name).toLowerCase());
    // A person's assignment decides both directions, and BOTH halves matter. A
    // moved row has to appear on its new vendor (or the move did nothing) and
    // has to stop appearing on the old one (or the payment shows up twice, on
    // two companies, and every per-vendor total is wrong). It overrides the
    // ledger-payee half too: a PayPal pull whose matched entry names one company
    // still goes where the person put it.
    const overrides = await loadVendorOverrides();
    const mine_txns = txns
      .filter((t) => {
        const ovr = overrides.get(t.id);
        if (ovr) return ovr.toLowerCase() === lower || aliasSet.has(ovr.toLowerCase());
        const bankKey = normalizeBankPayee(t.payee_guess) || t.payee_guess.toLowerCase().trim();
        const ownLedger = String(t.ledger_payee || '').trim().toLowerCase();
        // THE STATEMENT IS THE MASTER, so its own words outrank every ledger fact
        // here. A bank line whose DESCRIPTOR names this vendor belongs on this
        // page whether or not it is matched, whether or not its invoice was
        // deleted, and whether or not any lesson points here.
        //
        // John, 2026-08-18: "if a matched invoice is deleted, the bank statement
        // activity should still stay. always." Deleting an invoice correctly
        // released its bank row — but that row's only tie to Strega WAS the
        // invoice, so a real $800 payment silently left the vendor's page. The
        // payment happened; the document going away cannot unhappen it.
        //
        // descriptorMentions, not namesRecipient: the stricter of the two. It
        // needs a contiguous run of the vendor's name as PRINTED on the
        // statement, so "Dean St" cannot reach into "Dean Street Media In" — the
        // substring trap that put other people's payments on the wrong vendor
        // earlier today.
        if (descriptorMentions(t.description, ledger)) return true;
        for (const alias of aliasSet) if (descriptorMentions(t.description, alias)) return true;
        // A row arriving through an INFERRED group must name this vendor ITSELF.
        // Tested against the vendor, not against `ledgerNamesLower` — that set
        // also holds every included group's descriptor, which on a shared one
        // ("PAYPAL") would wave through all 154 rows again by the back door.
        if (inferredKeys.has(bankKey) && !explicitKeys.has(bankKey)) {
          return ownLedger === lower || aliasSet.has(ownLedger);
        }
        return keys.has(bankKey)
          || (t.ledger_payee && ledgerNamesLower.has(ownLedger));
      })
      // WORK FIRST, then newest. Sorting by date alone made the cap hide the
      // whole point of the page: FACEBOOK's newest 100 lines are all answered
      // already, so its 118 unanswered ones — every one dated before the oldest
      // row the page could show — were structurally unreachable. The footer's
      // "mark all N" counted the loaded rows, read 0, and hid itself. John could
      // see 224 transactions and act on none of the ones that needed him.
      //
      // A cap that drops the rows a page exists to work is worse than a slower
      // page, so what needs an answer is listed first and the date order is kept
      // within each group.
      .sort((a, b) => {
        const aw = needsAnswer(a) ? 0 : 1;
        const bw = needsAnswer(b) ? 0 : 1;
        if (aw !== bw) return aw - bw;
        return new Date(b.txn_date) - new Date(a.txn_date);
      });
    // Nothing here at all — no group, and no row the statement ties to this
    // vendor. Same empty answer as before, reached after asking both questions.
    if (!mine.length && !mine_txns.length) return res.json({ success: true, data: null });
    // ── The funding leg belongs on this page, and to ONE payment ────────────
    //
    // John, 2026-08-19, on two vendors: "the bank activity and paypal activity
    // doesn't match". It didn't. A PayPal payment's bank pull is filed under the
    // PAYPAL payee, so it reached no vendor page — the panel NAMED it ("bank
    // #5536 · both still counting") and could not list it. 31 vendors were
    // missing 34 pulls worth $18,470, and 13 of those were OPEN: real work no
    // page could show.
    //
    // Listing them needed the allocation fixed FIRST. The pairing ran per vendor,
    // greedily, with no naming test on a PAYPAL-labelled pull — so 20 pulls were
    // claimed by more than one vendor. #5536 ($200) was claimed by three people,
    // and its descriptor names exactly one of them. Pulling legs in on that basis
    // would have put one payment on three pages as three bank lines.
    //
    // So: gather the COMPETITION for every pull this vendor's payments want, and
    // let the shared allocator decide. One pull, one payment, everywhere.
    const legCols = `
        SELECT p.id AS pp_id, p.payee_guess AS pp_payee, p.payee_email AS pp_email,
               p.txn_date AS pdate, pe.payee AS pp_ledger,
               b.id AS bank_id, b.payee_guess AS bank_payee, b.description AS bank_desc,
               b.txn_date AS bdate
          FROM bank_transactions p
          JOIN bank_statements sp ON sp.id = p.statement_id AND sp.account = 'paypal'
           AND sp.status = 'ready'
          JOIN bank_transactions b ON b.direction = 'debit' AND b.amount = p.amount
           AND ABS(b.txn_date - p.txn_date) <= ${WINDOW_DAYS}
          JOIN bank_statements sb ON sb.id = b.statement_id AND sb.account <> 'paypal'
           AND sb.status = 'ready'
          LEFT JOIN expenses pe ON pe.id = p.matched_expense_id
         WHERE p.direction = 'debit' AND b.matched_income_id IS NULL
           -- The sweep's OWN descriptor test, unchanged: without it this pairs a
           -- PayPal payment with any bank debit of the same amount inside the
           -- window, and the page offers to close a line that funded nothing.
           AND ${PULL_SQL}`;
    const fundingLeg = new Map();       // pp id -> the bank row that funded it
    const fundingContest = new Map();   // pp id -> the pull two payments want
    {
      const myPp = mine_txns.filter((t) => t.account === 'paypal').map((t) => t.id);
      // THE COMPETITION, EXPANDED TO CLOSURE — every payment that could take
      // these pulls, and every pull those payments could take, until nothing new
      // arrives.
      //
      // One hop is not enough, and shipping it proved so: pull #4652 was still
      // claimed by two payments, because two vendor pages saw DIFFERENT candidate
      // sets. A rival pull present on one page consumed a payment there, freeing
      // #4652 for the other — so each page allocated correctly over what it could
      // see and the two disagreed anyway. An allocation is only stable if its
      // input is closed under "competes with".
      //
      // Components are tiny (a handful of same-amount payments in a week), so this
      // settles in two or three rounds. The cap is a backstop, not a budget: if a
      // component were ever big enough to hit it, the pulls at the frontier are
      // left UNALLOCATED — reported as contested — because a half-explored
      // component is exactly what produces the disagreement above.
      let knownPp = new Set(myPp);
      let knownBank = new Set();
      let allLegs = [];
      for (let round = 0; round < 5 && (knownPp.size || knownBank.size); round += 1) {
        const legs = await pool.query(
          `${legCols} AND (p.id = ANY($1::int[]) OR b.id = ANY($2::int[]))`,
          [[...knownPp], [...knownBank]]).then((r) => r.rows).catch(() => []);
        const grew = legs.length !== allLegs.length;
        allLegs = legs;
        const pp = new Set(legs.map((l) => l.pp_id));
        const bank = new Set(legs.map((l) => l.bank_id));
        for (const id of knownPp) pp.add(id);
        const closed = pp.size === knownPp.size && bank.size === knownBank.size;
        knownPp = pp; knownBank = bank;
        if (closed && !grew) break;
      }
      // Emails, through the guarded index: our own addresses and any address
      // shared by several vendors identify nobody. Loaded whole because sharing
      // is only visible across the corpus.
      const { rows: emailRows } = await pool.query(
        `SELECT DISTINCT payee AS vendor, vendor_email AS email FROM expenses
          WHERE vendor_email IS NOT NULL AND TRIM(vendor_email) <> ''
            AND payee IS NOT NULL AND TRIM(payee) <> ''
            AND (deleted = false OR deleted IS NULL)`).catch(() => ({ rows: [] }));
      const emailIx = buildEmailIndex(emailRows);
      const lcv = (v) => String(v || '').trim().toLowerCase();
      const legVendor = (l) => l.pp_ledger || l.pp_payee || '';
      // Every spelling the bank might have printed for this payment's recipient:
      // the PayPal payee, the ledger vendor its entry names, their email handles,
      // and pinyin for a Han name. The MATCHER is untouched — it is only being
      // handed strings it could not previously see.
      const withNames = allLegs.map((l) => ({
        ...l,
        names: [...new Set([
          ...spellingsOf(l.pp_payee, { emails: [l.pp_email] }),
          ...spellingsOf(l.pp_ledger, { emails: emailIx.get(lcv(l.pp_ledger)) || [] }),
        ].filter(Boolean))],
      }));
      const { byPp, contested } = allocateFundingPairs(withNames, {
        overrides, vendorOf: (l) => legVendor(l),
      });
      const mineIds = new Set(myPp);
      for (const [ppId, leg] of byPp) if (mineIds.has(ppId)) fundingLeg.set(ppId, leg);
      for (const [, legs] of contested) {
        for (const l of legs) if (mineIds.has(l.pp_id)) fundingContest.set(l.pp_id, legs);
      }
      // The pull now joins this vendor's rows. Already loaded — the query above
      // selects every debit carrying a payee_guess, and a pull's is "PAYPAL" — so
      // this is a set operation, not another round trip.
      const have = new Set(mine_txns.map((t) => t.id));
      for (const leg of fundingLeg.values()) {
        if (have.has(leg.bank_id)) continue;
        const row = txns.find((t) => t.id === leg.bank_id);
        if (!row) continue;
        have.add(row.id);
        // Marked, because a bank line whose descriptor names a payment channel
        // looks like somebody else's row unless the page says why it is here.
        mine_txns.push({ ...row, via_funding_pair: leg.pp_id });
      }
      // WORK FIRST, then newest — the order the filter above established, which
      // the pushes just broke.
      mine_txns.sort((a, b) => {
        const aw = needsAnswer(a) ? 0 : 1;
        const bw = needsAnswer(b) ? 0 : 1;
        if (aw !== bw) return aw - bw;
        return new Date(b.txn_date) - new Date(a.txn_date);
      });
    }

    // The 100 cap is a payload bound, and the page must be able to SAY so. SPOTIFY
    // has 151 lines: showing 100 of them silently, under a summary that reads 151,
    // presents a truncated list as the whole story — and now that these rows carry
    // actions, "I worked all of them" would be wrong.
    const CAP = 100;
    const transactions = mine_txns
      .slice(0, CAP)
      .map((t) => ({
        id: t.id, txn_date: iso(t.txn_date), amount: t.amount, payee_guess: t.payee_guess,
        // Where this line sits because a PERSON put it there, not because the
        // descriptor said so. The row has to say this: a payment whose bank text
        // names a different company looks like a bug unless the page admits it
        // was moved, and there is no way to undo a move you cannot see.
        vendor_override: overrides.get(t.id) || null,
        // This query is debits-only today, but the panel's controls decide what
        // they offer from the ROW — a control that reads a field the payload
        // doesn't carry renders never, or worse, always.
        direction: t.direction,
        status: t.dismissed ? 'dismissed'
          : !t.matched_expense_id ? 'open'
          : t.match_method === 'created' ? 'booked' : 'matched',
        invoice_number: t.invoice_number, filename: t.filename,
        // Everything below exists so the vendor page can ACT on the row rather
        // than only read it.
        //
        // `match_method` decides which undo is offered, and that is not cosmetic:
        // a rematch soft-deleted the entry the app invented for this line, so its
        // inverse is /unrematch (restores the booking). Plain unmatching a
        // rematched row leaves it OPEN — a state it was never in — which is the
        // dead end fixed in 6ef64a5.
        match_method: t.match_method || null,
        matched_expense_id: t.matched_expense_id || null,
        matched_category: t.matched_category || null,
        // What the invoice behind this line actually SAYS. The row named an
        // invoice number and nothing else, so "is this the right invoice" —
        // the question this page exists to answer — could only be checked by
        // leaving the page. Amount first, then the document itself.
        matched_amount: t.matched_amount ?? null,
        matched_currency: t.matched_currency || null,
        // `artist` and `song`, matching the field the band above already reads —
        // one row should not name the same entry's columns two different ways.
        song: t.matched_song || null,
        has_invoice: !!t.has_invoice,
        has_proof: !!t.has_proof,
        invoice_filename: t.invoice_filename || null,
        proof_filename: t.proof_filename || null,
        // WHO the spend was for, and whether anyone has said this vendor's
        // spend is overhead. A booked line with neither is the other half of
        // this page's debt: it looks finished and names nobody, so it lands in
        // Spend by Artist's 73% unattributed remainder.
        // artistLabel, not the raw value: a stored "unknown" is not an
        // attribution, and printing it in the artist column claimed one that no
        // report agreed with. Null here makes the row read "no artist", which is
        // both true and clickable.
        artist: artistLabel(t.matched_artist),
        flagged: !!t.flagged,
        flagged_by: t.flagged_by || null,
        needs_artist: needsArtistRow(t),
        // The name an artist/overhead rule has to be written on: rules match the
        // LEDGER payee by equality, and a vendor's rows are not always booked
        // under the spelling this page is titled with.
        ledger_payee: t.ledger_payee || null,
        no_invoice_expected: !!t.no_invoice_expected,
        // USD, from the live rate cache via the shared usdOf — never amount_usd.
        // A foreign line compared against an invoice at face value reports a
        // delta in the wrong unit, and summing the stored column is what once
        // reported $6.16M against the page's $5.77M.
        currency: t.currency,
        usd: usdOf(t.amount, t.currency),
        statement_id: t.statement_id, account: t.account,
        // This row is here because it FUNDED a payment on this page, not because
        // its own descriptor names the vendor — a "PAYPAL" pull names nobody. The
        // page has to say so, or it reads as somebody else's line.
        via_funding_pair: t.via_funding_pair || null,
      }));
    // ── The PayPal side ─────────────────────────────────────────────────────
    //
    // Every PayPal payment is bank-funded (John's model: PayPal never spends a
    // held balance), so the same money appears TWICE — the per-payment record on
    // the PayPal statement, which is canonical because it carries the recipient,
    // and a "PAYPAL DES:…" pull on the bank statement, which carries no name.
    //
    // That pull is filed under the PAYPAL payee, NOT under this vendor, so the
    // vendor page could never show the two halves together: it listed a PayPal
    // payment with no way to see the bank line that funded it, or whether that
    // line had been closed. Paired here on the sweep's own test — same amount,
    // within 3 days, on a non-PayPal statement — so the page cannot invent a
    // second definition of a funding pair.
    const ppIds = transactions.filter((t) => t.account === 'paypal').map((t) => t.id);
    // The allocation is already done, above the cap, against the competition —
    // this block used to run its OWN pairing query here, scoped to one vendor,
    // which is what let three people each own the same $200 pull. Reading the
    // shared result instead means the page and every other surface name the same
    // owner for a pull.
    const fundingBy = new Map();
    for (const [ppId, leg] of fundingLeg) {
      const row = txns.find((t) => t.id === leg.bank_id);
      if (!row) continue;
      fundingBy.set(ppId, {
        id: row.id, txn_date: iso(row.txn_date), amount: row.amount,
        description: row.description, account: row.account, filename: row.filename,
        dismissed: !!row.dismissed, dismissed_reason: row.dismissed_reason || null,
        matched_expense_id: row.matched_expense_id || null,
        counted: !row.dismissed && !!row.matched_expense_id,
      });
    }
    if (ppIds.length) {
      // ── The cross-currency half, which no equality can find ───────────────
      //
      // A GBP PayPal payment is funded by a USD pull, so `b.amount = p.amount`
      // never fires and the page said "no bank pull found within 3 days" while
      // the pull sat one row away. Harry Seddon, 2026-08-18: GBP 70.05 on the
      // 10th funded by $104.99 on the 11th — a 10.8% PayPal spread.
      //
      // Offered as a PROPOSAL, never folded into `funding`: the evidence is a
      // name, a date and a band, not an equality, so a person confirms it. The
      // close button posts to the same /funding-pair endpoint either way.
      const unpaired = transactions.filter((t) => t.account === 'paypal' && !fundingBy.has(t.id));
      const fxProposal = new Map();
      if (unpaired.length) {
        const { rows: cands } = await pool.query(`
          SELECT b.id, b.txn_date, b.amount, COALESCE(b.currency, 'USD') AS currency,
                 b.description, b.payee_guess, b.dismissed, b.matched_expense_id,
                 sb.account, sb.filename
            FROM bank_transactions b
            JOIN bank_statements sb ON sb.id = b.statement_id AND sb.account <> 'paypal'
             AND sb.status = 'ready'
           WHERE b.direction = 'debit' AND b.matched_income_id IS NULL
             AND b.dismissed = false
             AND ${PULL_SQL}
             AND b.txn_date BETWEEN $1::date - ${WINDOW_DAYS} AND $2::date + ${WINDOW_DAYS}`,
          [unpaired.reduce((m, t) => (m && m <= t.txn_date ? m : t.txn_date), null),
           unpaired.reduce((m, t) => (m && m >= t.txn_date ? m : t.txn_date), null)])
          .catch(() => ({ rows: [] }));
        // Same greedy 1:1 as above, and a claimed pull is off the table — a
        // proposal that reuses a bank row the exact pass already took would
        // invite closing one payment against another's funding.
        const claimed = new Set([...fundingBy.values()].map((f) => f.id));
        // The SAME identity test the cross-currency deck and every close gate
        // use. This page used the descriptor alone, so it reported "no bank pull
        // found within a week" for two of A Trần's payments while the deck
        // proposed both — and their bank twins were already attributed to Arlo
        // and Surf Mesa, which is why $350 sat in "Not attributed to an artist"
        // as a duplicate nobody could find from the vendor page.
        const fxNameCtx = await loadMatchContext().catch(() => ({ exact: new Map(), norm: new Map(), aliases: new Map() }));
        const fxNamesOk = (pp, bank) => namesOrLinked(fxNameCtx, bank.description, pp.payee_guess, bank.payee_guess);
        for (const t of unpaired) {
          const ppUsd = usdOf(t.amount, t.currency || 'USD', null);
          const fits = cands.filter((b) => !claimed.has(b.id)
            && pairTier(t, b, { ppUsd, bankUsd: usdOf(b.amount, b.currency || 'USD', null), namesOk: fxNamesOk }) === 'fx');
          // ONE candidate only. Two pulls of similar size in the same week are
          // exactly the coincidence that cost $200, and a page is the wrong
          // place to guess between them — the audit lists those as unresolved.
          if (process.env.FP_DEBUG) console.error('[fp]', t.id, t.currency, t.amount, 'cands', cands.length, 'fits', fits.length, JSON.stringify(cands.map((b)=>({id:b.id,amt:b.amount,cur:b.currency,tier:pairTier(t,b,{ppUsd,bankUsd:usdOf(b.amount,b.currency||'USD',null),namesOk:fxNamesOk})}))));
          if (fits.length !== 1) continue;
          const b = fits[0];
          claimed.add(b.id);
          const bankUsd = usdOf(b.amount, b.currency || 'USD', null);
          fxProposal.set(t.id, {
            id: b.id, txn_date: iso(b.txn_date), amount: b.amount, currency: b.currency,
            description: b.description, account: b.account, filename: b.filename,
            dismissed: !!b.dismissed, matched_expense_id: b.matched_expense_id || null,
            counted: !b.dismissed && !!b.matched_expense_id,
            tier: 'fx', days: dayGap(t.txn_date, b.txn_date),
            paypal_usd: round2(ppUsd), bank_usd: round2(bankUsd),
            spread_pct: ppUsd > 0 ? round2(((bankUsd - ppUsd) / ppUsd) * 100) : null,
          });
        }
      }
      for (const t of transactions) {
        if (t.account !== 'paypal') continue;
        t.funding = fundingBy.get(t.id) || null;
        // Cross-currency: a pull we believe funded this, awaiting confirmation.
        t.funding_proposal = t.funding ? null : (fxProposal.get(t.id) || null);
        // The state worth acting on: BOTH halves alive and both explained by a
        // ledger entry, which is one payment claiming two records. The global
        // flags page calls this double-funding; this is the same fact, on the
        // page where the vendor's other work already is.
        t.double_funded = !!(t.funding && t.funding.counted
          && t.status !== 'dismissed' && !!t.matched_expense_id);
        // A proposal that would ALSO be double-counted if confirmed — the one
        // John was looking at, where the pull already carries the invoice.
        t.funding_proposal_double = !!(t.funding_proposal && t.funding_proposal.counted
          && t.status !== 'dismissed' && !!t.matched_expense_id);
        // A pull TWO payments want equally, which nobody gets automatically.
        // Handing it to whichever page asked first is what this whole allocation
        // exists to stop; saying so lets a person settle it in one click, and the
        // descriptor usually makes it obvious to a human even when no rule can
        // read it ("ID:DIEGOADRIANPERE").
        const contest = fundingContest.get(t.id);
        if (contest && !t.funding) {
          const bank = txns.find((b) => b.id === contest[0].bank_id);
          t.funding_contested = {
            bank_id: contest[0].bank_id,
            txn_date: bank ? iso(bank.txn_date) : null,
            amount: bank ? bank.amount : null,
            description: bank ? bank.description : null,
            claimants: contest.map((l) => ({
              txn_id: l.pp_id, payee: l.pp_payee, ledger_payee: l.pp_ledger || null,
              txn_date: iso(l.pdate), mine: l.pp_id === t.id,
            })),
          };
        } else t.funding_contested = null;
      }
    }

    // ── The summary counts the ROWS THIS PAGE SHOWS, never the groups ───────
    //
    // `mine` holds each included group WHOLE, and the filter above admits only
    // the rows an inferred group contributes — the distinction the comment 350
    // lines up exists to make. Reducing over the groups therefore put all 154
    // "PAYPAL" pulls on one person's total: Nini Ajayi read "$86,505.97 · 24
    // open" above a list of three rows worth $360.00, and was offered 24 items
    // to work that were not hers. 104 vendors were overstated this way.
    //
    // Over `mine_txns`, not `transactions`: the latter is the CAP-100 display
    // slice, so a vendor with more lines (SPOTIFY has 151) would report LESS
    // than it holds — the opposite error, equally silent. `shown` / `truncated`
    // below are what disclose the cap.
    //
    // The per-row arithmetic mirrors aggregateBankVendors exactly — USD through
    // the shared usdOf, dismissed rows excluded from open — so the vendor page
    // and the directory still describe the same row the same way.
    const summary = mine_txns.reduce((s, t) => {
      const usd = usdOf(t.amount, t.currency);
      const open = !t.dismissed && !t.matched_expense_id;
      return {
        txns: s.txns + 1,
        total: s.total + usd,
        open_n: s.open_n + (open ? 1 : 0),
        open_total: s.open_total + (open ? usd : 0),
      };
    }, { txns: 0, total: 0, open_n: 0, open_total: 0 });
    // Rounded ONCE, at the end. Summing rounded parts is how a tie-out breaks by
    // a cent that nobody can find.
    summary.total = Math.round(summary.total * 100) / 100;
    summary.open_total = Math.round(summary.open_total * 100) / 100;
    // The learned category is a lesson about a bank DESCRIPTOR, not a sum of
    // rows, so it keeps coming from the groups.
    summary.learned_category = mine.reduce((c, g) => c || g.learned_category || g.top_category, null);
    // ── Money that came back ────────────────────────────────────────────────
    //
    // A vendor page that shows the payment but not the refund overstates what
    // was spent with that vendor, and the person reading it has no way to know.
    // Reversals are excluded from the review deck (they are neither an expense
    // to invoice nor income), so without a section here they are invisible on the
    // one page devoted to this vendor.
    //
    // Paired by the SHARED pairReversals — the same function the Flags page uses
    // for `reversal-still-matched`, so the two surfaces name the same pairs
    // rather than each deciding what a refund is.
    // The vendor's own artist answer, so "marked as overhead" is visible and
    // reversible HERE. Without it the band simply disappeared when answered:
    // the page gave no sign the answer existed and no way back, and the only
    // undo was finding the rule on another page.
    const ledgerNames = [...new Set(transactions.map((t) => (t.ledger_payee || '').trim())
      .concat(mine.map((g) => g.name), [String(req.query.ledger || '').trim()])
      .filter((n) => n))];
    let artistRule = null;
    if (ledgerNames.length) {
      const { rows: [rule] } = await pool.query(
        `SELECT id, pattern, artist, is_overhead FROM statement_artist_rules
          WHERE LOWER(pattern) = ANY($1::text[]) ORDER BY is_overhead DESC, id DESC LIMIT 1`,
        [ledgerNames.map((n) => n.toLowerCase())]).catch(() => ({ rows: [] }));
      artistRule = rule || null;
    }

    let reversals = [];
    try {
      const { rows: credits } = await pool.query(`
        SELECT t.id, t.txn_date, t.amount, t.direction, t.payee_guess, t.description,
               t.statement_id, t.dismissed, t.dismissed_reason, t.matched_income_id, s.account
          FROM bank_transactions t
          JOIN bank_statements s ON s.id = t.statement_id AND s.status = 'ready'
         WHERE t.direction = 'credit' AND COALESCE(TRIM(t.payee_guess), '') <> ''`);
      const mineCredits = credits.filter((c) =>
        keys.has(normalizeBankPayee(c.payee_guess) || c.payee_guess.toLowerCase().trim()));
      // Live debits pair FIRST, so a dismissed row can never take the credit
      // that explains a debit still counting. Then a second pass over what is
      // left brings back the pairs THIS PAGE resolved — matched on the reason it
      // writes, so nothing else can drift in.
      //
      // Without that second pass, resolving made the whole section disappear:
      // the debit is dismissed, so it stopped being paired at all, and the page
      // gave no sign the $250,000 had been dealt with rather than lost.
      const mineDebits = mine_txns.filter((d) => !d.dismissed);
      const livePairs = pairReversals(mineDebits, mineCredits);
      const usedCredit = new Set(livePairs.map((p) => p.credit.id));
      const resolvedDebits = mine_txns.filter((d) => d.dismissed
        && /^reversal pair/.test(String(d.dismissed_reason || '')));
      const resolvedPairs = resolvedDebits.length
        ? pairReversals(resolvedDebits, mineCredits.filter((c) => !usedCredit.has(c.id)
            && /^reversal pair/.test(String(c.dismissed_reason || ''))))
        : [];
      reversals = [...livePairs, ...resolvedPairs].map(({ debit, credit }) => ({
        amount: credit.amount,
        credit: { id: credit.id, txn_date: iso(credit.txn_date), description: credit.description,
          dismissed: !!credit.dismissed, booked_income: !!credit.matched_income_id },
        debit: { id: debit.id, txn_date: iso(debit.txn_date), description: debit.description,
          dismissed: !!debit.dismissed, matched_expense_id: debit.matched_expense_id || null,
          match_method: debit.match_method || null },
        // Both legs dismissed = the pair has been dealt with and nets to zero.
        // Anything else still counts somewhere, which is the point of showing it.
        resolved: !!(debit.dismissed && credit.dismissed),
      }));
    } catch { reversals = []; }

    res.json({ success: true, data: {
      payees: mine.map((g) => ({ key: g.key, name: g.name,
        explicit: (g.linked_vendor || '').toLowerCase().trim() === lower })),
      summary, transactions, reversals, artist_rule: artistRule,
      // What the list is a subset OF, so the page can disclose the cap instead of
      // implying these are all of them.
      shown: transactions.length, matched_txns: mine_txns.length,
      truncated: mine_txns.length > transactions.length,
      // Computed over EVERY line of this vendor, not the page. The client used
      // to derive this from the loaded rows, which is exactly how a vendor whose
      // unanswered lines sit past the cap reported none.
      waiting_n: mine_txns.filter(needsAnswer).length,
      // usdOf, not `t.usd` — that field is added by the CAP-100 .map below, so
      // these raw rows never carry it and every foreign line was being counted
      // at its face value as if it were dollars.
      waiting_total: Math.round(mine_txns.filter(needsAnswer)
        .reduce((sum, t) => sum + Math.abs(usdOf(t.amount, t.currency)), 0) * 100) / 100,
    } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Link / unlink a bank vendor to a ledger vendor. A link IS a payee-map
// lesson — the matcher treats it as 1.0 name evidence for every future
// transaction from that bank payee.
router.post('/vendors/link', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const bank = String(req.body.bank_payee || '').trim();
    const ledger = String(req.body.ledger_payee || '').trim();
    if (bank.length < 3 || !ledger) return res.status(400).json({ success: false, error: 'bank_payee and ledger_payee required' });
    // Say no out loud. learnPayeeMap would refuse this silently, and a link that
    // reports success while writing nothing is worse than an error.
    if (isChannelOnlyPayee(bank)) {
      return res.status(400).json({ success: false,
        error: `"${bank}" is a payment channel, not a payee — every vendor paid through it shares that descriptor, `
          + 'so linking it would file all of their payments under one vendor. Link the individual recipient instead, '
          + 'or match the row to its invoice and the recipient will follow.' });
    }
    await learnPayeeMap(req.user, bank, ledger);
    await audit(req.user, 'bank_vendor_linked', null, ledger, `Bank vendor "${bank}" linked to ledger vendor "${ledger}"`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// Clear a WRONG inference: unmatch every auto/manual match tying this bank
// payee to that ledger vendor (booked 'created' entries are left alone —
// unbook those individually) and delete the lesson so it doesn't re-learn.
router.post('/vendors/unmatch', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const bank = String(req.body.bank_payee || '').trim();
    const ledger = String(req.body.ledger_payee || '').trim();
    const norm = normalizeBankPayee(bank);
    if (!norm || !ledger) return res.status(400).json({ success: false, error: 'bank_payee and ledger_payee required' });
    const { rows } = await pool.query(`
      SELECT t.id, t.payee_guess, t.match_method
        FROM bank_transactions t JOIN expenses e ON e.id = t.matched_expense_id
       WHERE t.matched_expense_id IS NOT NULL AND t.dismissed = false
         AND LOWER(TRIM(e.payee)) = LOWER(TRIM($1))`, [ledger]);
    const mine = rows.filter((r) => normalizeBankPayee(r.payee_guess) === norm);
    const ids = mine.filter((r) => r.match_method !== 'created').map((r) => r.id);
    const bookedLeft = mine.length - ids.length;
    if (ids.length) {
      await pool.query(`
        UPDATE bank_transactions SET matched_expense_id = NULL, match_method = NULL,
          match_score = NULL, matched_by = NULL, matched_at = NULL
        WHERE id = ANY($1)`, [ids]);
    }
    await unlearnPayeeMap(bank, ledger);
    await audit(req.user, 'bank_vendor_unmatched', null, ledger,
      `Cleared wrong vendor inference: ${ids.length} txn(s) of "${bank}" unmatched from "${ledger}"`);
    res.json({ success: true, data: { unmatched: ids.length, booked_left: bookedLeft } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/vendors/link', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const bank = String(req.body?.bank_payee || req.query.bank_payee || '').trim();
    const norm = normalizeBankPayee(bank);
    if (!norm) return res.status(400).json({ success: false, error: 'bank_payee required' });
    const { rows } = await pool.query(`SELECT id, bank_payee FROM statement_payee_map`);
    const ids = rows.filter((r) => normalizeBankPayee(r.bank_payee) === norm).map((r) => r.id);
    if (ids.length) await pool.query(`DELETE FROM statement_payee_map WHERE id = ANY($1)`, [ids]);
    await audit(req.user, 'bank_vendor_unlinked', null, bank, `Bank vendor "${bank}" unlinked (${ids.length} lesson${ids.length === 1 ? '' : 's'} removed)`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Move a bank line to a vendor, and take its BOOKING with it.
//
// A booked row has a ledger entry the app invented to represent it. That entry
// carries the vendor name too, so filing the row somewhere else while leaving
// the entry behind splits one payment across two companies: the vendor page's
// Bank Activity shows the line and its invoice table does not, the header's
// TOTAL SPENT is short by the amount, and the ledger still credits the old name.
// John saw exactly that — two lines moved onto a vendor reading $2,900 of bank
// activity against $900 of ledger.
//
// ONLY an entry the app invented (`entry_source = 'bank_statement'`) is moved.
// A real invoice is another company's document and repointing it would rewrite
// the ledger on the strength of a filing decision — the same guard /rematch and
// /unbook use, and the one that saved entry #22.
//
// Restoring is derivable, so no extra state is stored: an invented entry's payee
// is resolveBookingPayee(row) by construction, which is what clearing puts back.
async function applyVendorOverride(txn, target, user) {
  const clearing = target == null;
  await pool.query(
    `UPDATE bank_transactions SET vendor_override = $1, vendor_override_by = $2 WHERE id = $3`,
    [clearing ? null : target, clearing ? null : (user?.name || null), txn.id]);

  if (!txn.matched_expense_id) return { entry_moved: false };
  const payee = clearing ? await resolveBookingPayee(txn, null) : target;
  if (!payee) return { entry_moved: false };
  const { rowCount } = await pool.query(
    `UPDATE expenses SET payee = $1
      WHERE id = $2 AND COALESCE(entry_source, '') = 'bank_statement'`,
    [payee, txn.matched_expense_id]);
  return { entry_moved: rowCount > 0 };
}

// POST /api/statements/tx/:txId/vendor { ledger_payee }  ·  { clear: true }
//
// Move ONE bank line to a vendor, overruling its descriptor.
//
// Not the same operation as /vendors/link, which repoints statement_payee_map
// and therefore moves EVERY line carrying that descriptor — the right tool for
// "all 195 FACEBK charges are Facebook", and the wrong one for "this single
// PayPal pull was actually the Gersh Agency". Both exist because both questions
// are asked; this one is per-row and teaches the matcher nothing, precisely so
// that one odd payment cannot rewrite where a whole descriptor family lands.
//
// It beats every inference — descriptor, learned map, alias resolution, and the
// vendor named by whatever invoice the row holds. A person looking at the
// statement is the best evidence available.
router.post('/tx/:txId(\\d+)/vendor', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    // vendor_override is selected through a fallback because the column is
    // young and runMigrations() runs in the background: on the first seconds of
    // the deploy that adds it, naming it here would 500 the endpoint.
    const { rows: [txn] } = await pool.query(
      `SELECT id, payee_guess, amount, txn_date, matched_expense_id, vendor_override
         FROM bank_transactions WHERE id = $1`, [req.params.txId])
      .catch(async (err) => {
        if (!/vendor_override/.test(err.message || '')) throw err;
        return { rows: [] };
      });
    if (!txn) {
      const { rows: [exists] } = await pool.query(
        `SELECT 1 AS ok FROM bank_transactions WHERE id = $1`, [req.params.txId]);
      if (exists) {
        return res.status(503).json({ success: false,
          error: 'Moving a line to another vendor is still starting up — try again in a few seconds.' });
      }
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }

    if (req.body?.clear === true) {
      const { entry_moved } = await applyVendorOverride(txn, null, req.user);
      await audit(req.user, 'bank_txn_vendor_cleared', null, txn.payee_guess,
        `Bank line #${txn.id} (${txn.payee_guess}) returned to its descriptor's vendor`
        + `${txn.vendor_override ? ` from "${txn.vendor_override}"` : ''}`
        + `${entry_moved ? '; its booked entry went back with it' : ''}`);
      return res.json({ success: true, data: { txn_id: txn.id, vendor_override: null, entry_moved } });
    }

    const target = String(req.body?.ledger_payee || '').trim();
    if (!target) return res.status(400).json({ success: false, error: 'ledger_payee required' });
    if (target.length > 200) return res.status(400).json({ success: false, error: 'ledger_payee is too long' });

    // Refuse a vendor nobody has heard of. A free-text name creates a company
    // row that exists only because of one bank line, which is how the directory
    // grew ghost vendors before — and a typo would silently move money to a
    // vendor that will never be looked at again. An unknown name has to be
    // created deliberately elsewhere first.
    //
    // Written as ONE query rather than a conditional second one. The first
    // version short-circuited with `known ? [{}] : await pool.query(...)` and
    // destructured `{ rows: [...] }` off it — so on the path where the vendor IS
    // known it destructured an array with no `rows`, and every successful move
    // threw "Cannot destructure property 'Symbol(Symbol.iterator)'". The
    // refusals all worked, which is why probing only the refusals passed it.
    const { rows: [known] } = await pool.query(
      `SELECT 1 AS ok
         WHERE EXISTS (SELECT 1 FROM expenses WHERE LOWER(TRIM(payee)) = LOWER($1))
            OR EXISTS (SELECT 1 FROM vendor_aliases
                        WHERE LOWER(TRIM(primary_name)) = LOWER($1)
                           OR LOWER(TRIM(alias)) = LOWER($1))`,
      [target]);
    if (!known && req.body?.confirm_new !== true) {
      return res.status(400).json({ success: false,
        error: `No ledger vendor is named "${target}". Check the spelling, or pass confirm_new to create the association anyway.` });
    }

    const { entry_moved } = await applyVendorOverride(txn, target, req.user);
    await audit(req.user, 'bank_txn_vendor_moved', null, txn.payee_guess,
      `Bank line #${txn.id} — ${txn.payee_guess}, ${txn.amount} on ${String(txn.txn_date).slice(0, 10)} — `
      + `moved to vendor "${target}". This line only; the descriptor's other lines are unaffected.`
      + `${entry_moved ? ' The entry booked from it moved too, so the ledger and the bank side agree.' : ''}`);
    res.json({ success: true, data: { txn_id: txn.id, vendor_override: target, entry_moved } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/statements/unmatched-ledger ────────────────────────────────────
//
// Direction ONE of Bank Matching: paid ledger rows with no statement line.
// (Direction two — statement lines with no ledger row — is the page's existing
// bands, served by /completion and the transactions list.)
//
// Three sections, and they are three different jobs:
//
//   needs_match        a ready statement covers the payment date and the money
//                      is not on it. A real discrepancy. 257 rows / $266,008
//                      measured 2026-08-24.
//   awaiting_statement dated past the newest statement we hold for a compatible
//                      account. Nothing is wrong; it has not been issued yet.
//                      135 rows / $206,735 — every one of them August, against
//                      a BofA latest of 31 Jul.
//   missing_statement  inside the covered span and still uncovered — a month
//                      nobody uploaded. 2 rows today, and the reason the split
//                      exists: without it those hide in "not in yet" forever.
//
// The three PARTITION the paid-and-unmatched set, asserted in
// scripts/unmatched-partition-fixture.cjs. `needs_match` is noBankEvidenceSql
// itself — the same predicate the Ledger's bank=unverified filter and the
// vendors to-attach count already use, not a fourth copy.
//
// NO DISMISS. John's rule: a statement line can be passed as needing no match,
// a paid ledger row cannot. The exits are matching it, or correcting what is
// wrong with it — both of which happen elsewhere and are linked to from here.
router.get('/unmatched-ledger', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    const { rows } = await pool.query(`
      SELECT e.id, e.payee, e.amount, e.currency, e.fx_rate_to_usd, e.category,
             e.artist, e.song, e.invoice_number, e.invoice_date, e.payment_date,
             e.payment_method, e.entry_source, e.boom_rep, e.vendor_submitted,
             (e.invoice_r2_key IS NOT NULL OR e.invoice_filename IS NOT NULL) AS has_invoice,
             CASE WHEN ${noBankEvidenceSql('e')}   THEN 'needs_match'
                  WHEN ${awaitingStatementSql('e')} THEN 'awaiting_statement'
                  ELSE 'missing_statement' END AS section
        FROM expenses e
       WHERE (e.deleted IS NULL OR e.deleted = FALSE)
         AND (e.voided IS NULL OR e.voided = FALSE)
         AND COALESCE(e.status, 'approved') = 'approved'
         -- LEAF ROWS ONLY. A split parent's children carry the real
         -- attribution; listing both would show the same money twice.
         AND NOT EXISTS (SELECT 1 FROM expenses c WHERE c.parent_id = e.id
                           AND (c.deleted IS NULL OR c.deleted = FALSE))
         AND ${paidUnmatchedSql('e')}
       ORDER BY e.payment_date DESC, e.id DESC`);

    // usdOf, never amount_usd — the stored column falls back to face value on a
    // foreign row and once reported $6,159,482 against a page showing $5,772,443.
    const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    for (const r of rows) r.amount_usd_calc = r2(usdOf(r.amount, r.currency, r.fx_rate_to_usd));

    const pick = (k) => rows.filter((r) => r.section === k);
    // Round ONCE, at the row, then sum — summing rounded parts has broken a
    // tie-out here by exactly a cent.
    const band = (k) => {
      const list = pick(k);
      return { n: list.length, value: r2(list.reduce((t, r) => t + usdOf(r.amount, r.currency, r.fx_rate_to_usd), 0)), rows: list };
    };

    // What we actually hold, so the page can SAY why something is awaiting
    // rather than leaving the reader to infer it.
    const { rows: cover } = await pool.query(`
      SELECT CASE WHEN account = 'paypal' THEN 'paypal' ELSE 'bank' END AS side,
             MAX(period_end) AS latest, COUNT(*)::int AS statements
        FROM bank_statements WHERE status = 'ready' AND period_end IS NOT NULL
       GROUP BY 1`);

    res.json({ success: true, data: {
      needs_match: band('needs_match'),
      awaiting_statement: band('awaiting_statement'),
      missing_statement: band('missing_statement'),
      coverage: cover,
      total: rows.length,
    } });
  } catch (err) {
    console.error('GET /api/statements/unmatched-ledger:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/statements/funding-pairs/cross-currency
//
// The funding pairs the existing sweep CANNOT see, because it pairs on amount.
//
// Every PayPal payment is funded by a pull from the bank, so it appears on both
// statements and one of the two copies has to be closed or the money is counted
// twice. That works while both legs are USD. It cannot work when the PayPal leg
// is not: PayPal converts at its own spread, so AUD 1,225.19 on the 4th is funded
// by $904.99 on the 5th — never equal, never within a cents tolerance, and the
// pair is simply never found.
//
// 101 of the 125 live PayPal debits are in one of thirteen non-USD currencies,
// which is why this is not an edge case.
//
// READ-ONLY, deliberately. Closing a leg moves reported totals, and the evidence
// here is a NAME plus a date plus a band — strong enough to propose, not strong
// enough to write without someone reading the list. The pairs it cannot resolve
// are returned too, labelled, rather than dropped.
// GET /api/statements/funding-pairs/preview
//
// What the sweep WOULD do, without doing it. Same classification, same order,
// every write skipped.
//
// This exists because the pairing window was widened from 3 to 7 days, which
// hands the sweep pairs it has never seen — and the sweep dismisses rows and
// deletes invented bookings. Reported spend moves when it runs. Nobody should
// have to load the statements page to find out how much.
router.get('/funding-pairs/preview', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    // Errors surface as 400 rather than 500: Cloudflare replaces an origin 5xx
    // with its own HTML page and the JSON message is lost.
    const summary = await runFundingPairSweep({ dryRun: true })
      .catch((err) => { throw new Error(`preview failed: ${err.message}`); });
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/funding-pairs/cross-currency', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const days = Math.max(1, Math.min(10, parseInt(req.query.days, 10) || 4));
    // The bank pays MORE than the PayPal leg's mid-market value, because the
    // spread is PayPal's margin — so the band is asymmetric on purpose. A little
    // slack below covers our own rate cache being a day stale.
    const lo = 1 - (Math.max(0, Math.min(20, parseInt(req.query.under, 10) || 5)) / 100);
    const hi = 1 + (Math.max(0, Math.min(40, parseInt(req.query.over, 10) || 20)) / 100);

    const { rows: txns } = await pool.query(`
      SELECT t.id, t.txn_date, t.amount, COALESCE(t.currency, 'USD') AS currency, t.amount_usd,
             t.description, t.payee_guess, t.dismissed, t.matched_expense_id, t.match_method,
             t.fee, s.account, e.payee AS ledger_payee
        FROM bank_transactions t
        JOIN bank_statements s ON s.id = t.statement_id AND s.status = 'ready'
        LEFT JOIN expenses e ON e.id = t.matched_expense_id
       WHERE t.direction = 'debit' AND t.dismissed = false`);

    // usdOf reads the live rate cache itself and DIVIDES (rates are quoted per
    // USD). Never amount_usd — it is NULL on every non-USD row here.
    const toUsd = (r) => {
      const v = usdOf(r.amount, r.currency, null);
      return Number.isFinite(v) ? v : (Number(r.amount) || 0);
    };
    const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
    // Local: the round2 at line ~1942 belongs to the vendor-activity handler and
    // is not in scope here. Caught by reading, not by node --check — an
    // out-of-scope identifier is a runtime error, and this route only runs when
    // somebody opens the deck.
    const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

    // Aliases + learned links, so a vendor a person has already identified is
    // not reported as unpairable.
    const nameCtx = await loadMatchContext().catch(() => ({ exact: new Map(), norm: new Map(), aliases: new Map() }));

    const pp = txns.filter((t) => t.account === 'paypal');
    const bank = txns.filter((t) => t.account !== 'paypal');
    // A pull a person has FILED under a vendor belongs to that vendor. Offering it
    // to somebody else's payment overrules a decision with a proposal, and the
    // deck's button WRITES — it dismisses a row. The exact pass and the vendor
    // page both defer to an override; this audit was the last surface that did
    // not. Measured 2026-08-19: zero live cases, so this is a guard against the
    // shape rather than a repair.
    const fxOverrides = await loadVendorOverrides().catch(() => new Map());
    const lcName = (v) => String(v || '').trim().toLowerCase();
    const overrideBlocks = (b, p) => {
      const ovr = fxOverrides.get(b.id);
      if (!ovr) return false;
      const mine = lcName(p.ledger_payee) === lcName(ovr) || lcName(p.payee_guess) === lcName(ovr);
      return !mine;
    };

    const proposals = [];
    // Candidate sets first, assignment after — a row cannot be judged
    // unresolvable until every other row has had its turn.
    const shapes = [];
    const unclear = [];
    // Which bank rows each PayPal row could be funded by.
    for (const p of pp) {
      const pUsd = toUsd(p);
      if (!(pUsd > 0)) continue;
      const cands = bank.filter((b) => {
        if (Math.abs((new Date(b.txn_date) - new Date(p.txn_date)) / 86400000) > days) return false;
        const bUsd = toUsd(b);
        if (!(bUsd >= pUsd * lo && bUsd <= pUsd * hi)) return false;
        if (overrideBlocks(b, p)) return false;
        // THE guard. Amount and date alone paired a $200 payment with the wrong
        // person once already and cost real money; the descriptor has to name the
        // same recipient on both sides.
        return namesOrLinked(nameCtx, b.description, p.payee_guess, b.payee_guess);
      });
      if (!cands.length) {
        // NOTHING PROVES IT — but a person may still recognise it.
        //
        // Michael Scott's AUD 202.25 is funded by "MJSCOTT117 DES:IAT PAYPAL",
        // one day later, $150.00, a 4.3% spread. Obvious to a human; unprovable
        // by any name rule, because PayPal prints a HANDLE that abbreviates the
        // name rather than containing it. 12 of the 39 unresolved rows are this
        // shape, and returning `{paypal_id, reason}` for them — which is all this
        // used to return — gave nobody anything to act on.
        //
        // So the same amount-and-date candidates are returned WITHOUT the naming
        // test, labelled as unproven. They are never auto-closed and never
        // included in a bulk action; they exist so a person can look at both rows
        // and say yes. Only a SINGLE candidate is offered — where several fit,
        // there is nothing for a person to recognise either.
        const loose = bank.filter((b) => {
          // STILL has to look like a funding pull. Dropping the NAME test here was
          // the point; dropping the structural one was an accident, and it cost
          // the very case this branch was written for — Michael Scott's $150 pull
          // was crowded out by an "EASYSONG.COM CHECKCARD" charge at $150.99, so
          // the count read 2 and no candidate was offered. A card charge at a
          // coincidental amount is not a candidate for anything.
          if (!looksLikePull(b.description)) return false;
          if (overrideBlocks(b, p)) return false;
          if (Math.abs((new Date(b.txn_date) - new Date(p.txn_date)) / 86400000) > days) return false;
          const bUsd = toUsd(b);
          return bUsd >= pUsd * lo && bUsd <= pUsd * hi;
        });
        unclear.push({
          paypal_id: p.id,
          reason: 'no bank debit within the window names this recipient at a plausible amount',
          paypal: { id: p.id, date: day(p.txn_date), amount: Number(p.amount), currency: p.currency,
            usd: round2(pUsd), payee: p.payee_guess || null,
            state: p.matched_expense_id ? (p.match_method === 'created' ? 'booked' : 'matched') : 'open' },
          // Present ONLY when exactly one debit fits on size and date. `unproven`
          // is the whole point of the field name: the UI must not present this
          // with the same confidence as a proposal.
          unproven_candidate: loose.length === 1 ? {
            id: loose[0].id, date: day(loose[0].txn_date), amount: Number(loose[0].amount),
            currency: loose[0].currency, usd: round2(toUsd(loose[0])),
            payee: loose[0].payee_guess || null,
            description: String(loose[0].description || '').slice(0, 80),
            spread_pct: pUsd > 0 ? round2(((toUsd(loose[0]) - pUsd) / pUsd) * 100) : null,
          } : null,
          other_candidates: loose.length > 1 ? loose.length : 0,
        });
        continue;
      }
      const shape = {
        paypal: { id: p.id, date: day(p.txn_date), amount: Number(p.amount), currency: p.currency, usd: Math.round(pUsd * 100) / 100,
          payee: p.payee_guess, state: p.matched_expense_id ? (p.match_method === 'created' ? 'booked' : 'matched') : 'open' },
        candidates: cands.map((b) => ({
          id: b.id, date: day(b.txn_date), amount: Number(b.amount), currency: b.currency,
          usd: Math.round(toUsd(b) * 100) / 100, payee: b.payee_guess,
          state: b.matched_expense_id ? (b.match_method === 'created' ? 'booked' : 'matched') : 'open',
          spread_pct: Math.round(((toUsd(b) / pUsd) - 1) * 1000) / 10,
        })),
      };
      shapes.push(shape);
    }

    // ── ASSIGNMENT IS GREEDY, NEAREST DATE FIRST ─────────────────────────────
    //
    // "Several candidates" was treated as unresolvable, and for 39 rows it was
    // the whole answer. But every candidate has already passed the naming test
    // AGAINST THIS RECIPIENT — that is what put it in the list — so more than one
    // candidate never means "which person is this?", only "which of this person's
    // pulls funded which of this person's payments?".
    //
    // That question does not change what gets counted. Alibaba Ali Elmouna is
    // paid about $1,000 a week: ten PayPal payments in CAD, ten near-identical
    // USD pulls. Any 1:1 assignment closes exactly one copy of each payment, and
    // the totals are identical whichever way round it goes. John found those ten
    // sitting in "Not attributed to an artist" — he had matched and attributed the
    // BANK legs, and the PayPal twins were the ones nothing could resolve.
    //
    // Same allocation the sweep uses, so the two cannot disagree: sort every
    // (payment, pull) candidate by how far apart they are, take them in order,
    // skip anything already spoken for.
    const triples = [];
    for (const sh of shapes) {
      for (const c of sh.candidates) {
        triples.push({ sh, c, gap: Math.abs((new Date(c.date) - new Date(sh.paypal.date)) / 86400000) });
      }
    }
    triples.sort((a, b) => a.gap - b.gap || a.sh.paypal.id - b.sh.paypal.id);
    const takenPp = new Set();
    const takenBank = new Set();
    for (const t of triples) {
      if (takenPp.has(t.sh.paypal.id) || takenBank.has(t.c.id)) continue;
      takenPp.add(t.sh.paypal.id);
      takenBank.add(t.c.id);
      // The chosen pull leads, and the alternatives ride along so the card can
      // say the choice existed rather than presenting it as the only reading.
      proposals.push({ ...t.sh, candidates: [t.c, ...t.sh.candidates.filter((x) => x.id !== t.c.id)] });
    }
    // Whatever is left had candidates, but every one of them was claimed by a
    // nearer payment. Reported with the SAME shape as every other unresolved row.
    for (const sh of shapes) {
      if (takenPp.has(sh.paypal.id)) continue;
      unclear.push({ paypal_id: sh.paypal.id, paypal: sh.paypal, candidates: sh.candidates,
        reason: 'every pull that could be this one is a closer match for another payment' });
    }
    // ── ONE PULL, ONE PAYMENT — in the unproven tier too ────────────────────
    //
    // `unproven_candidate` was offered whenever exactly one loose pull fitted THIS
    // payment, and never asked whether the same pull fitted another. The tier's
    // own rule is that where several candidates fit there is nothing for a person
    // to recognise; that has to hold in both directions, or two cards offer the
    // same pull, a person accepts both, and the server refuses the second — after
    // the first has already dismissed a row.
    //
    // The proven tier is 1:1 by construction (takenPp/takenBank above). This is
    // the half that was not. Zero live cases measured, so it guards the shape.
    const unprovenClaims = new Map();
    for (const u of unclear) {
      if (!u.unproven_candidate) continue;
      unprovenClaims.set(u.unproven_candidate.id, (unprovenClaims.get(u.unproven_candidate.id) || 0) + 1);
    }
    for (const u of unclear) {
      if (!u.unproven_candidate) continue;
      const n = unprovenClaims.get(u.unproven_candidate.id);
      if (n <= 1) continue;
      u.other_candidates = Math.max(u.other_candidates || 0, n);
      u.reason = 'the only pull that fits this payment fits another one too — nothing here says which';
      u.unproven_candidate = null;
    }
    const unique = proposals;

    const sum = (arr) => Math.round(arr.reduce((n, x) => n + x.paypal.usd, 0) * 100) / 100;
    res.json({ success: true, data: {
      window_days: days, band: { under_pct: Math.round((1 - lo) * 100), over_pct: Math.round((hi - 1) * 100) },
      live_paypal_debits: pp.length,
      // What closing the unique proposals would stop counting twice.
      would_close: unique.length,
      would_close_usd: sum(unique),
      unresolved: unclear.length,
      unresolved_usd: Math.round(unclear.reduce((n, x) => n + (x.paypal?.usd || 0), 0) * 100) / 100,
      proposals: unique,
      unclear,
    } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/statements/flags — cross-statement integrity checks. Read-only:
// every check emits { severity, type, title, detail, fingerprint,
// statement_id?, q?, action? } for the Flags card. `fingerprint` is stable
// across re-checks so acknowledgements stick; `statement_id` + `q` power
// jump-to-statement; `action` describes a one-click fix.
router.get('/flags', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const flags = [];
    const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '?');

    const { rows: stmts } = await pool.query(`
      SELECT s.id, s.account, s.filename, s.period_start, s.period_end,
        s.ending_balance, s.beginning_balance,
        COALESCE(SUM(t.amount) FILTER (WHERE t.direction = 'credit'), 0) AS credits,
        COALESCE(SUM(t.amount) FILTER (WHERE t.direction = 'debit'), 0) AS debits,
        COUNT(*) FILTER (WHERE COALESCE(t.currency, 'USD') <> 'USD')::int AS foreign_rows,
        -- USD-settled totals: a foreign row contributes its printed USD amount.
        -- These are what make an FX statement reconcilable at all.
        COALESCE(SUM(COALESCE(t.amount_usd, t.amount)) FILTER (WHERE t.direction = 'credit'), 0) AS credits_usd,
        COALESCE(SUM(COALESCE(t.amount_usd, t.amount)) FILTER (WHERE t.direction = 'debit'), 0) AS debits_usd,
        -- Foreign rows with no printed USD settlement: the statement cannot be
        -- reconciled in USD while any of these exist, and saying so beats
        -- silently skipping the check.
        COUNT(*) FILTER (WHERE COALESCE(t.currency, 'USD') <> 'USD' AND t.amount_usd IS NULL)::int AS foreign_unconverted
      FROM bank_statements s
      LEFT JOIN bank_transactions t ON t.statement_id = s.id
      WHERE s.status = 'ready'
      GROUP BY s.id
      ORDER BY s.account, s.period_start NULLS LAST`);

    // Balance continuity + coverage gaps between consecutive statements of
    // the same account. prior ending + money in − money out should equal
    // this statement's ending balance; a mismatch means the parse missed
    // rows or misread a balance. Skipped when foreign-currency rows make
    // the arithmetic meaningless.
    for (let i = 1; i < stmts.length; i++) {
      const prev = stmts[i - 1], cur = stmts[i];
      if (prev.account !== cur.account || !prev.period_end || !cur.period_start) continue;
      const gapDays = (new Date(cur.period_start) - new Date(prev.period_end)) / 86400000;
      if (gapDays > 5) {
        flags.push({ severity: 'warn', type: 'gap', fingerprint: `gap:${prev.id}:${cur.id}`,
          title: `Missing ${String(cur.account).toUpperCase()} statement?`,
          detail: `${Math.round(gapDays)}-day gap between "${prev.filename}" (ends ${day(prev.period_end)}) and "${cur.filename}" (starts ${day(cur.period_start)}).` });
      }
      // Chained check — only a FALLBACK now, for statements with no opening
      // balance of their own. Standalone reconciliation below is strictly
      // better: it needs no neighbour, so it survives gaps and covers the first
      // statement of an account.
      if (cur.beginning_balance == null
          && gapDays >= 0 && gapDays <= 5 && prev.ending_balance != null && cur.ending_balance != null
          && !cur.foreign_unconverted && !prev.foreign_unconverted) {
        const expected = Number(prev.ending_balance) + Number(cur.credits_usd) - Number(cur.debits_usd);
        const delta = Number(cur.ending_balance) - expected;
        if (Math.abs(delta) > 0.05) {
          flags.push({ severity: 'error', type: 'balance', fingerprint: `balance:${cur.id}`,
            statement_id: cur.id,
            title: `Balance doesn't reconcile on "${cur.filename}"`,
            detail: `Prior ending ${money(prev.ending_balance)} + in ${money(cur.credits_usd)} − out ${money(cur.debits_usd)} = ${money(expected)}, but the statement says ${money(cur.ending_balance)} (off by ${money(Math.abs(delta))}). The parse may have missed or misread transactions.` });
        }
      }
    }

    // ── Standalone reconciliation: each statement proves itself ──────────
    //   opening + credits − debits = closing
    // No neighbour needed, so it survives gaps and covers the first statement
    // of an account. Totals are USD-settled, so a PayPal statement full of
    // foreign rows reconciles like any other — previously ANY non-USD row
    // disqualified the whole statement and PayPal was never checked at all.
    //
    // A mismatch is arithmetic proof the parse is wrong, and the delta is
    // exactly how much money is unaccounted for.
    for (const st of stmts) {
      // Foreign rows FIRST. This test used to sit below the `continue` on a null
      // opening balance, which made it unreachable for every statement that had
      // one — all six PayPal statements, the only ones with unconverted rows. So
      // the warning written for this exact case never fired, and PayPal was
      // silently unchecked rather than visibly unverifiable.
      if (st.foreign_unconverted) {
        // Can't add the currencies up. Say so — a check that silently skips is
        // indistinguishable from a check that passed.
        flags.push({ severity: 'warn', type: 'balance-unverifiable', fingerprint: `balunver:${st.id}`,
          statement_id: st.id,
          title: `Can't verify "${st.filename}" — ${st.foreign_unconverted} foreign row${st.foreign_unconverted === 1 ? '' : 's'} with no USD amount`,
          detail: `${st.foreign_unconverted} transaction${st.foreign_unconverted === 1 ? ' is' : 's are'} in a non-USD currency with no printed USD settlement, so the statement can't be added up in dollars. Re-parse it, or upload the CSV export, to capture the converted amounts.` });
        continue;
      }
      if (st.beginning_balance == null || st.ending_balance == null) continue;
      const expected = Number(st.beginning_balance) + Number(st.credits_usd) - Number(st.debits_usd);
      const delta = Number(st.ending_balance) - expected;
      if (Math.abs(delta) > 0.05) {
        flags.push({ severity: 'error', type: 'balance-standalone', fingerprint: `balstd:${st.id}`,
          statement_id: st.id,
          title: `"${st.filename}" is off by ${money(Math.abs(delta))} — transactions are missing`,
          detail: `Opening ${money(st.beginning_balance)} + in ${money(st.credits_usd)} − out ${money(st.debits_usd)} = ${money(expected)}, but the statement's own closing balance is ${money(st.ending_balance)}. That ${money(Math.abs(delta))} gap is arithmetic: ${delta > 0 ? 'credits are missing from' : 'debits are missing from'} the parse, or an amount was misread. Re-parse the statement, or upload the CSV export.` });
      }
    }

    // Statements that opted out of the continuity check: an account where
    // some statements carry an ending balance but this one doesn't.
    const balAccounts = new Set(stmts.filter((s) => s.ending_balance != null).map((s) => s.account));
    for (const s of stmts) {
      if (s.ending_balance == null && balAccounts.has(s.account)) {
        flags.push({ severity: 'warn', type: 'no-balance', fingerprint: `nobal:${s.id}`,
          statement_id: s.id,
          title: `No ending balance on "${s.filename}"`,
          detail: `Other ${String(s.account).toUpperCase()} statements have one, so the balance-continuity check silently skips this month. Re-upload as PDF or a CSV with a balance column to close the gap.` });
      }
    }

    // Transactions dated outside their statement's covered period — a
    // misparsed date (3-day slack for settle-over-boundary rows).
    const { rows: outside } = await pool.query(`
      SELECT s.id, s.filename, COUNT(*)::int AS n, MIN(t.txn_date) AS lo, MAX(t.txn_date) AS hi
      FROM bank_transactions t
      JOIN bank_statements s ON s.id = t.statement_id
      WHERE s.period_start IS NOT NULL AND s.period_end IS NOT NULL
        AND (t.txn_date < s.period_start - 3 OR t.txn_date > s.period_end + 3)
      GROUP BY s.id, s.filename`);
    for (const r of outside) {
      flags.push({ severity: 'warn', type: 'out-of-period', fingerprint: `oop:${r.id}:${r.n}`,
        statement_id: r.id,
        title: `${r.n} transaction${r.n === 1 ? '' : 's'} dated outside the statement period`,
        detail: `"${r.filename}" has dates as far as ${day(r.lo)}–${day(r.hi)} beyond its covered period — a date may have been misread during parsing.` });
    }

    // Cross-statement duplicates: same account, date, amount, direction and
    // payee living in two different statements (overlapping uploads).
    const { rows: dupes } = await pool.query(`
      SELECT a.id AS a_id, b.id AS b_id, a.statement_id, a.txn_date, a.amount, a.payee_guess,
             sa.filename AS file_a, sb.filename AS file_b
      FROM bank_transactions a
      JOIN bank_transactions b ON b.id > a.id AND b.statement_id <> a.statement_id
        AND b.txn_date = a.txn_date AND b.amount = a.amount AND b.direction = a.direction
        AND COALESCE(b.payee_guess, '') = COALESCE(a.payee_guess, '')
        AND b.dismissed = false
      JOIN bank_statements sa ON sa.id = a.statement_id
      JOIN bank_statements sb ON sb.id = b.statement_id AND sb.account = sa.account
      WHERE a.dismissed = false
      LIMIT 20`);
    if (dupes.length) {
      flags.push({ severity: 'error', type: 'duplicates',
        fingerprint: `dupes:${dupes.slice(0, 10).map((d) => `${d.a_id}-${d.b_id}`).join(',')}`,
        statement_id: dupes[0].statement_id, q: dupes[0].payee_guess || '',
        title: `${dupes.length}${dupes.length === 20 ? '+' : ''} possible duplicate transaction${dupes.length === 1 ? '' : 's'} across statements`,
        detail: dupes.slice(0, 5).map((d) =>
          `${day(d.txn_date)} ${money(d.amount)} ${d.payee_guess || '(no payee)'} in "${d.file_a}" and "${d.file_b}"`).join(' · ')
          + (dupes.length > 5 ? ` · …and ${dupes.length - 5} more` : '') });
    }

    // Matched-pair sanity: every live match is re-checked against its ledger
    // family for broken links, amount drift, currency mismatch, and a paid
    // date far from the bank date.
    const { rows: matchedTx } = await pool.query(`
      SELECT t.id, t.statement_id, t.txn_date, t.amount, COALESCE(t.currency, 'USD') AS currency,
             t.payee_guess, t.description, t.matched_expense_id, t.match_method, s.filename
      FROM bank_transactions t JOIN bank_statements s ON s.id = t.statement_id
      WHERE t.matched_expense_id IS NOT NULL AND t.dismissed = false`);
    const famIds = [...new Set(matchedTx.map((t) => t.matched_expense_id))];
    const famById = new Map();
    if (famIds.length) {
      const { rows: fams } = await pool.query(`${FAMILY_SQL} AND r.id = ANY($1)`, [famIds]);
      for (const f of fams) famById.set(f.id, f);
    }
    const flagClaims = await loadClaimedSums();
    // Aliases and learned payee links, so the name check below can tell a wrong
    // match from a vendor we have already been TOLD is the same one. Without
    // this, "add an alias" would resolve nothing — the pair would re-flag on the
    // next pass and the queue could never be finished.
    const nameCtx = await loadMatchContext().catch(() => ({ exact: new Map(), norm: new Map(), aliases: new Map() }));
    for (const t of matchedTx) {
      const f = famById.get(t.matched_expense_id);
      const jump = { statement_id: t.statement_id, q: t.payee_guess || '' };
      if (!f) {
        flags.push({ severity: 'error', type: 'broken-link', fingerprint: `broken:${t.id}`, ...jump,
          action: { kind: 'unmatch', txn_id: t.id },
          title: `Bank match points at a missing ledger entry`,
          detail: `${day(t.txn_date)} ${money(t.amount)} ${t.payee_guess || ''} in "${t.filename}" is matched to ledger entry #${t.matched_expense_id}, which is deleted, voided, or no longer approved. Unmatch it or restore the entry.` });
        continue;
      }
      // ── Does anything at all tie this bank line to this invoice? ──────────
      //
      // Every other check in this loop asks whether a match is CONSISTENT —
      // right amounts, right dates, right currency. None of them asks the first
      // question: is this even the same counterparty. A $30,000 debit from
      // "GATE 3 ENTERTAINMENT" matched to Kyle Shirk's invoice passes every one
      // of them, because the amount and the date are exactly right. It is the
      // name that is wrong, and nothing was looking at the name.
      //
      // 2,809 live matches, 237 with names sharing essentially nothing, 32 with
      // no evidence of any kind — \$69,806. 30 of those 32 are 'auto-sameday',
      // the deliberate carve-out in runAutoMatch that overrides the name veto
      // when a single invoice matches to the cent on the same day. Its comment
      // promised these would be "auditable and reviewed as a group". This is
      // the surface that keeps that promise.
      //
      // Five ways a disagreeing pair can still be fine, and all five are
      // checked, because a queue that cries wolf gets cleared without reading:
      //
      //   1. the match method IS the evidence — a learned link, an alias, an
      //      email, an invoice reference in the descriptor, or a person's own
      //      hand. 177 of the 237.
      //   2. the DESCRIPTOR names the vendor even though the payee column does
      //      not. "PAYPAL DES:PURCHASE ID:CHASEMANN8" has a payee_guess of just
      //      "PAYPAL" and names Chase Mann perfectly well. 25 of the 237.
      //   3. same name, written differently — KYRAJOHNSON / Kyra Johnson.
      //   4. an alias already links them.
      //   5. a learned payee link already links them. This is what makes
      //      "Katherine Stephenson → Kate Stephenson" resolve without needing a
      //      nickname rule that would also merge Chris into Christina.
      //
      // 4 and 5 read LIVE, not from the match method, so answering a card
      // actually retires it.
      if (!SELF_EVIDENCING_METHODS.has(t.match_method || '')) {
        const bankName = (t.payee_guess || '').trim();
        const ledgerName = (f.payee || '').trim();
        // A nameless side is a different problem (and its own flag) — there is
        // no disagreement between a name and nothing.
        if (bankName && ledgerName) {
          const vm = vendorsMatch(bankName, ledgerName);
          if (!vm.match && vm.score < 0.25
              && !sameSquashedName(bankName, ledgerName)
              && !descriptorNames(t.description, ledgerName, bankName)
              && !descriptorMentions(t.description, ledgerName)
              && !identityAlreadyLinked(nameCtx, bankName, ledgerName)) {
            flags.push({ severity: 'error', type: 'name-disagreement', fingerprint: `namedis:${t.id}`, ...jump,
              ledger_id: f.id,
              action: { kind: 'unmatch', txn_id: t.id },
              // The second real answer. Without it the only button says
              // "unmatch", and people press the only button.
              alt_action: { kind: 'alias', bank_payee: bankName, ledger_payee: ledgerName },
              // The descriptor is the evidence, so the card has to show it —
              // payee_guess is a truncated guess AT the descriptor, and judging
              // the guess instead of the source is how these got made.
              descriptor: t.description || null,
              title: `Nothing links this payment to ${f.payee}`,
              detail: `The bank shows ${money(t.amount)} leaving on ${day(t.txn_date)} to "${bankName}", matched to ${f.payee}'s ${money(f.family_total)} invoice${f.invoice_number ? ` (inv ${f.invoice_number})` : ''} — the names share nothing, and neither the descriptor nor an alias nor a learned link connects them${t.match_method === 'auto-sameday' ? '. Matched on amount and date alone' : ` (${t.match_method})`}. If it is the same vendor under another name, add the alias; if not, unmatch it — ${f.payment_status === 'Paid' ? 'the ledger currently records this as paid' : 'confirming it would write a false payment record'}.` });
          }
        }
      }

      // ── Matched to an expense with no document ────────────────────────────
      //
      // The write paths now refuse this, but 9 matches ($43,960) predate the
      // rule and each one is a live claim that a bank line is invoice-backed
      // when nothing is behind it. Blocking new ones does not address them, and
      // unmatching them automatically would move reported spend at a moment
      // nobody chose — so they go in front of a person with the same one-click
      // Unmatch every other flag here offers.
      //
      // vendor-submitted rows are excluded on purpose: those went through the
      // submit form, which enforces its own invoice-number gate against the
      // uploaded document. A hand-added row had no such gate.
      if (f.entry_source !== 'bank_statement' && !f.vendor_submitted && !f.has_invoice) {
        flags.push({ severity: 'warn', type: 'no-document-match', fingerprint: `nodoc:${t.id}`, ...jump,
          ledger_id: f.id,
          action: { kind: 'unmatch', txn_id: t.id },
          title: `No document behind this match: ${f.payee}`,
          detail: `${money(t.amount)} on ${day(t.txn_date)} is matched to an entry added by hand with no invoice on file, `
            + `so this payment counts as invoice-backed with nothing behind it. Upload the invoice onto that entry, `
            + `or unmatch and book the line instead.` });
      }

      // Currency-aware amount check: a £315 invoice settled as a $359.97
      // debit is CONSISTENT, not drift. Convert both sides to USD before
      // comparing — locked fx first, then the HISTORICAL rate at the settle
      // date (today's rate on a March transaction produced false drift),
      // cached-today as the last resort. 3% band for bank FX spread.
      const tCur = t.currency.toUpperCase();
      const fCur = (f.currency || 'USD').toUpperCase();
      const hist = (fCur !== tCur)
        ? await getHistorical(String(t.txn_date).slice(0, 10)).catch(() => null)
        : null;
      const toUsd = (amt, cur, locked) => {
        if (cur === 'USD') return Number(amt);
        const lk = parseFloat(locked || 0);
        if (lk > 0) return Number(amt) / lk;
        const r = (hist?.rates?.[cur] > 0 ? hist.rates[cur] : getCached().rates?.[cur]);
        return r > 0 ? Number(amt) / r : null;
      };
      if (fCur === tCur) {
        // Slice-aware: an installment paying one slice of a split family
        // (or the remaining balance) is consistent, not drift.
        const diff = bestAmountDiff(f, t.amount, flagClaims);
        if (diff > feeTolerance(Number(t.amount))) {
          flags.push({ severity: 'warn', type: 'amount-drift', fingerprint: `amtdrift:${t.id}`, ...jump,
            action: { kind: 'unmatch', txn_id: t.id },
            title: `Amounts disagree: ${f.payee}`,
            detail: `Bank shows ${money(t.amount)} on ${day(t.txn_date)} but the ledger invoice totals ${money(f.family_total)} — no slice or remaining balance matches. Was this the right match?` });
        }
      } else {
        const famUsd = toUsd(f.family_total, fCur, f.fx_rate_to_usd);
        const txnUsd = toUsd(t.amount, tCur, null);
        if (famUsd == null || txnUsd == null) {
          flags.push({ severity: 'warn', type: 'currency-mismatch', fingerprint: `cur:${t.id}`, ...jump,
            action: { kind: 'unmatch', txn_id: t.id },
            title: `Currency mismatch: ${f.payee}`,
            detail: `Bank ${t.direction} is ${tCur} but the ledger invoice is ${fCur}, and no exchange rate is available to verify the amounts agree.` });
        } else {
          const diff = Math.abs(famUsd - txnUsd);
          if (diff > Math.max(35, txnUsd * 0.03)) {
            flags.push({ severity: 'warn', type: 'amount-drift', fingerprint: `amtdrift:${t.id}`, ...jump,
              action: { kind: 'unmatch', txn_id: t.id },
              title: `Amounts disagree: ${f.payee}`,
              detail: `Bank shows ${money(t.amount)} ${tCur} on ${day(t.txn_date)} but the ledger invoice totals ${Number(f.family_total).toFixed(2)} ${fCur} (≈${money(famUsd)}) — ${money(diff)} apart even after conversion. Was this the right match?` });
          }
          // Consistent cross-currency match — no flag at all.
        }
      }
      // Impossible, not merely odd: the money left before the invoice existed.
      // Checked for EVERY match regardless of payment status — the previous
      // date sanity check below only looked at rows already marked Paid, which
      // is why 8 inverted matches on UNPAID invoices never surfaced.
      if (f.invoice_date && t.txn_date) {
        const daysEarly = (new Date(f.invoice_date) - new Date(t.txn_date)) / 86400000;
        if (daysEarly > 5) {
          flags.push({ severity: 'error', type: 'bank-before-invoice', fingerprint: `beforeinv:${t.id}`, ...jump,
            action: { kind: 'unmatch', txn_id: t.id },
            title: `Bank debit predates the invoice: ${f.payee}`,
            detail: `The bank shows ${money(t.amount)} leaving on ${day(t.txn_date)}, but this invoice is dated ${day(f.invoice_date)} — ${Math.round(daysEarly)} days later. Money cannot pay an invoice that didn't exist yet, so this match is wrong`
              + `${f.payment_status === 'Paid' ? '' : ', and confirming it would write a false payment record'}. Unmatch it and pick the debit that actually settled this invoice.` });
        }
      }
      if (f.payment_status === 'Paid' && f.payment_date) {
        const dd = Math.abs((new Date(f.payment_date) - new Date(t.txn_date)) / 86400000);
        if (dd > 14) {
          flags.push({ severity: 'warn', type: 'date-drift', fingerprint: `datedrift:${t.id}`, ...jump,
            action: { kind: 'unmatch', txn_id: t.id },
            title: `Payment date far from bank date: ${f.payee}`,
            detail: `Ledger says paid ${day(f.payment_date)}, the bank shows the money left ${day(t.txn_date)} — ${Math.round(dd)} days apart. One of the two dates is probably wrong.` });
        }
      }
    }

    // ── Lessons that name somebody else ──────────────────────────────────
    //
    // A bank vendor group carries a LESSON — the statement_payee_map row saying
    // "descriptors like this mean this ledger vendor". It is the strongest
    // evidence the matcher has, and nothing ever checked it against the
    // invoices the group's own transactions are actually matched to.
    //
    // 32 live groups disagree with themselves, and they are three problems:
    //
    //   Noah Schipper       taught as "Computer Kill"        $28,000
    //   BRET MAZUR          matched to Cristofer Castillo-Chinchilla
    //   STREET AVENUE PROD  matched to Jen Blake
    //   FACEBK *GMWLGK …    18 groups, each taught its own card code
    //
    // The first three are wrong data a person has to settle. The 18 are one
    // vendor: normalizeBankPayee only drops a card code when it contains a
    // DIGIT ("2THTXF" goes, "GMWLGK" stays), so every Facebook ad charge minted
    // its own vendor group AND its own single-use lesson. Fixing the normalizer
    // is the real answer and is deliberately NOT done here — 28 call sites read
    // it, including the report-dismissal fingerprint in routes/reports.js, so
    // changing it re-keys existing dismissals and moves the P&L. A cleanup must
    // not quietly change what a report says.
    //
    // So they are COLLAPSED instead: three or more groups whose lessons all
    // disagree while pointing at the same ledger vendor are one card with one
    // bulk repoint. Generic on purpose — no "FACEBK" anywhere — because the
    // next card processor will do exactly the same thing.
    try {
      // aggregateBankVendors() is the ONE definition of a bank vendor group,
      // shared with /statements/vendors. Rebuilding the grouping here is how
      // the flag and the page it links to would come to disagree.
      const bankGroups = await aggregateBankVendors();
      const disagreeing = bankGroups.filter((g) => {
        // An OVERRIDE is a person's explicit assignment, not an inferred
        // lesson. Disagreeing with the matches is that person's decision.
        if (!g.linked_vendor || g.overridden) return false;
        const matched = (g.ledger_vendors || []).filter(Boolean);
        // Nothing matched yet = nothing to contradict the lesson.
        if (!matched.length) return false;
        return !matched.some((v) =>
          v.toLowerCase().trim() === String(g.linked_vendor).toLowerCase().trim()
          || vendorsMatch(v, g.linked_vendor).match
          || sameSquashedName(v, g.linked_vendor));
      });

      const byLedger = new Map();
      for (const g of disagreeing) {
        const k = (g.ledger_vendors || []).filter(Boolean).slice().sort().join(' + ');
        if (!byLedger.has(k)) byLedger.set(k, []);
        byLedger.get(k).push(g);
      }
      for (const [ledgerNames, gs] of byLedger) {
        const target = (gs[0].ledger_vendors || []).filter(Boolean)[0];
        const total = gs.reduce((n, g) => n + Number(g.total || 0), 0);
        const bankNames = gs.map((g) => g.name);
        if (gs.length >= 3) {
          flags.push({ severity: 'warn', type: 'lesson-disagreement',
            fingerprint: `lessongrp:${target}:${gs.length}`,
            q: bankNames[0] || '',
            action: { kind: 'relink', bank_payees: bankNames, ledger_payee: target },
            title: `${gs.length} bank vendors are all ${target}`,
            detail: `${gs.length} separate bank vendor groups (${bankNames.slice(0, 3).join(', ')}…) each carry their own learned link, but every one of their matches points at ${target} — ${money(total)} in total. The descriptor carries a per-charge code the grouping doesn't strip, so each charge became its own vendor. Repointing all ${gs.length} at ${target} files them together.` });
          continue;
        }
        for (const g of gs) {
          flags.push({ severity: 'warn', type: 'lesson-disagreement',
            fingerprint: `lesson:${g.key}`,
            q: g.name || '',
            action: { kind: 'relink', bank_payees: [g.name], ledger_payee: target },
            title: `"${g.name}" is taught as ${g.linked_vendor}, but pays ${ledgerNames}`,
            detail: `Payments under "${g.name}" (${money(g.total)}, last seen ${g.last_seen || '?'}) are matched to ${ledgerNames}, while the learned link sends future ones to ${g.linked_vendor}. Either the link is wrong — repoint it — or the matches are, in which case fix those first: the next statement will follow the link.` });
        }
      }
      // ── The complement: a bank payee the app can already prove is a vendor ──
      //
      // The check above finds a lesson that names the WRONG party. This finds a
      // group with NO lesson at all whose own matches name exactly one ledger
      // vendor — the app has the answer and never offered it, so the directory
      // shows one company as two rows until somebody notices.
      //
      // John hit it on "LIZDEKMUSIC" vs "Nikola Lizdek" (2026-08-19) and linked
      // it by hand before this shipped.
      //
      // The names must carry EVIDENCE. 26 groups are in this shape and only 6 are
      // links: the other 20 are "GATE 3 ENTERTAINMENT" matched to Kyle Shirk's
      // invoice — the wrong-match queue seen from the vendor side. Offering
      // those as links would cement the error into a rule that misdirects every
      // future statement, which is precisely the damage the lesson-disagreement
      // check exists to undo.
      for (const g of bankGroups) {
        if (g.linked_vendor || g.overridden) continue;
        const matched = (g.ledger_vendors || []).filter(Boolean);
        if (matched.length !== 1) continue;
        const target = matched[0];
        const already = target.toLowerCase().trim() === String(g.name).toLowerCase().trim()
          || vendorsMatch(target, g.name).match || !!sameSquashedName(target, g.name);
        if (already) continue;   // the directory folds these on the name alone
        const vm = vendorsMatch(g.name, target);
        const evidence = vm.match || vm.score >= 0.25
          || !!sameSquashedName(g.name, target) || descriptorMentions(g.name, target);
        if (!evidence) continue; // no evidence => this is a wrong match, not a link
        flags.push({ severity: 'warn', type: 'vendor-link',
          fingerprint: `vlink:${g.key}`,
          q: g.name || '',
          action: { kind: 'relink', bank_payees: [g.name], ledger_payee: target },
          title: `"${g.name}" is ${target}`,
          detail: `Every payment under "${g.name}" (${money(g.total)}, last seen ${g.last_seen || '?'}) is matched to ${target}'s invoices, but nothing links the two names — so the directory lists them as separate vendors and the next statement will not know either. Linking files them together.` });
      }

    } catch (e) { console.warn('lesson-disagreement flag check failed:', e.message); }

    // PayPal funding legs with NO PayPal statement covering the period —
    // they can't be auto-dismissed (the bank row is the only record), but
    // once the PayPal statement is uploaded the same money will appear
    // twice. Nudge per statement.
    const { rows: ppUncovered } = await pool.query(`
      SELECT s.id, s.filename, COUNT(*)::int AS n, COALESCE(SUM(t.amount), 0) AS total
        FROM bank_transactions t
        JOIN bank_statements s ON s.id = t.statement_id AND s.account <> 'paypal'
       WHERE t.dismissed = false AND t.description ILIKE '%paypal des:%'
         AND NOT EXISTS (SELECT 1 FROM bank_statements p
                          WHERE p.account = 'paypal' AND p.status = 'ready'
                            AND p.period_start IS NOT NULL AND p.period_end IS NOT NULL
                            AND t.txn_date BETWEEN p.period_start - 3 AND p.period_end + 3)
       GROUP BY s.id, s.filename`);
    for (const r of ppUncovered) {
      flags.push({ severity: 'warn', type: 'paypal-uncovered',
        fingerprint: `ppunc:${r.id}:${r.n}`,
        statement_id: r.id, q: 'paypal des',
        title: `${r.n} PayPal-funded transaction${r.n === 1 ? '' : 's'} with no PayPal statement covering the period`,
        detail: `${money(r.total)} of "PAYPAL DES:" activity in "${r.filename}" has no PayPal statement to reconcile against. Upload the PayPal statement for that period — the bank-side legs then auto-dismiss so the money can't count twice.` });
    }

    // Reversal/refund credits BOOKED AS INCOME — money coming back is not
    // revenue; the income entry must be unbooked, then both sides handled.
    // Only flagged when a matching outgoing debit exists (same amount,
    // payee equal or printed in the credit's description) — a bare
    // "refund" credit with no twin may be a legitimate rebate.
    const { rows: revBooked } = await pool.query(`
      SELECT DISTINCT ON (c.id) c.id, c.amount, c.payee_guess, c.txn_date, c.statement_id
        FROM bank_transactions c
        JOIN bank_transactions d ON d.direction = 'debit' AND d.amount = c.amount
          AND (LOWER(COALESCE(d.payee_guess, '')) = LOWER(COALESCE(c.payee_guess, ''))
            OR (LENGTH(COALESCE(d.payee_guess, '')) >= 3
              AND POSITION(LOWER(d.payee_guess) IN LOWER(COALESCE(c.description, ''))) > 0))
          AND d.txn_date <= c.txn_date AND c.txn_date - d.txn_date <= 21
          AND d.dismissed = false
       WHERE c.direction = 'credit' AND c.dismissed = false
         AND c.matched_income_id IS NOT NULL
         AND c.description ~* '\\mrevers|\\mrefund'
       ORDER BY c.id
       LIMIT 20`);
    for (const r of revBooked) {
      flags.push({ severity: 'error', type: 'reversal-booked-income',
        fingerprint: `revinc:${r.id}`,
        statement_id: r.statement_id, q: r.payee_guess || '',
        action: { kind: 'unbook-income', txn_id: r.id },
        title: `Reversal/refund booked as income: ${r.payee_guess || ''} ${money(r.amount)}`,
        detail: `The ${day(r.txn_date)} credit is money COMING BACK (a reversal or refund of an earlier debit), not revenue — but it's booked as income. Unbook it, then handle both sides from the review deck.` });
    }

    // Reversals: a credit whose description says REVERSAL, paired with the
    // earlier same-amount/same-payee debit it undoes. If that debit is
    // still matched or booked, the ledger thinks an invoice is paid while
    // the money actually came back — that's an error, not a warning.
    // Pairing moved to lib/reversal-pairs.js so the P&L and this flag can never
    // disagree about what a reversal is — routes/reports.js now excludes both
    // legs from reported totals, and a rule that decides money must have exactly
    // one definition. SQL fetches candidates; the lib decides.
    //
    // The credit's OWN dismissal is deliberately not a filter. Dismissing a
    // reversal credit is reasonable housekeeping (it isn't income), but it does
    // nothing about the debit it undoes — and hiding the pair meant the ledger
    // kept reporting an invoice as Paid after the money came back. The flag
    // below only fires when that debit is still matched or booked, so an
    // already-resolved reversal stays silent either way.
    //
    // NOTE: this drops four long-standing false "Reversed/refunded:  $100.00"
    // flags. The old SQL compared counterparties with
    // LOWER(COALESCE(d.payee_guess,'')) = LOWER(COALESCE(c.payee_guess,'')),
    // which is TRUE when BOTH are empty, so any payee-less debit paired with any
    // payee-less reversal credit of the same amount. The lib requires positive
    // evidence on both sides.
    const { rows: revCandidateCredits } = await pool.query(`
      SELECT c.id, c.txn_date, c.amount, c.direction, c.payee_guess, c.description,
             c.statement_id, s.account
        FROM bank_transactions c
        JOIN bank_statements s ON s.id = c.statement_id
       WHERE c.direction = 'credit' AND c.matched_income_id IS NULL
         AND c.description ~* '\\mrevers|\\mrefund'`);
    const { rows: revCandidateDebits } = revCandidateCredits.length ? await pool.query(`
      SELECT d.id, d.txn_date, d.amount, d.direction, d.payee_guess, d.description,
             d.matched_expense_id, d.match_method, s.account
        FROM bank_transactions d
        JOIN bank_statements s ON s.id = d.statement_id
       WHERE d.direction = 'debit' AND d.dismissed = false
         AND d.amount = ANY($1::numeric[])`,
    [revCandidateCredits.map((c) => c.amount)]) : { rows: [] };
    const reversals = pairReversals(revCandidateDebits, revCandidateCredits)
      .map(({ debit, credit }) => ({
        credit_id: credit.id, debit_id: debit.id, amount: credit.amount,
        payee_guess: credit.payee_guess || debit.payee_guess,
        cdate: credit.txn_date, ddate: debit.txn_date, statement_id: credit.statement_id,
        d_match: debit.matched_expense_id, d_method: debit.match_method,
      }));
    for (const r of reversals) {
      if (r.d_match) {
        flags.push({ severity: 'error', type: 'reversal-still-matched',
          fingerprint: `revm:${r.credit_id}:${r.debit_id}`,
          statement_id: r.statement_id, q: r.payee_guess || '',
          ...(r.d_method !== 'created' ? { action: { kind: 'unmatch', txn_id: r.debit_id } } : {}),
          title: `Payment reversed but still ${r.d_method === 'created' ? 'booked' : 'matched'}: ${r.payee_guess || ''} ${money(r.amount)}`,
          detail: `The ${day(r.ddate)} debit was reversed on ${day(r.cdate)} — the money came back, but the ledger still counts it as paid. ${r.d_method === 'created' ? 'Unbook the debit' : 'Unmatch it (the invoice is NOT paid by this transfer)'}, then dismiss both sides of the reversal.` });
      } else {
        flags.push({ severity: 'warn', type: 'reversal-pair',
          fingerprint: `rev:${r.credit_id}:${r.debit_id}`,
          statement_id: r.statement_id, q: r.payee_guess || '',
          action: { kind: 'dismiss-pair', txn_ids: [r.credit_id, r.debit_id] },
          title: `Reversed/refunded: ${r.payee_guess || ''} ${money(r.amount)}`,
          detail: `Went out ${day(r.ddate)}, came back ${day(r.cdate)} — a failed or refunded payment, not income and not an expense. Dismiss both sides so neither books.` });
      }
    }

    // Same-amount in/out pairs within 3 days on the same account — internal
    // movement the noise list didn't recognize (both sides still open).
    const { rows: roundtrips } = await pool.query(`
      SELECT c.id AS credit_id, d.id AS debit_id, c.statement_id, c.payee_guess,
             c.amount, c.txn_date AS credit_date, d.txn_date AS debit_date, s.account
      FROM bank_transactions c
      JOIN bank_statements s ON s.id = c.statement_id
      JOIN bank_transactions d ON d.direction = 'debit' AND d.amount = c.amount
        AND ABS(d.txn_date - c.txn_date) <= 3
        AND d.dismissed = false AND d.matched_expense_id IS NULL
      JOIN bank_statements sd ON sd.id = d.statement_id AND sd.account = s.account
      WHERE c.direction = 'credit' AND c.dismissed = false AND c.matched_income_id IS NULL
        AND c.amount >= 100
      LIMIT 10`);
    for (const r of roundtrips) {
      flags.push({ severity: 'warn', type: 'round-trip', fingerprint: `rt:${r.credit_id}:${r.debit_id}`,
        statement_id: r.statement_id, q: r.payee_guess || '',
        action: { kind: 'dismiss-pair', txn_ids: [r.credit_id, r.debit_id] },
        title: `Same-amount in/out pair — internal transfer?`,
        detail: `${money(r.amount)} came in ${day(r.credit_date)} and left ${day(r.debit_date)} on ${String(r.account).toUpperCase()}. If this is a transfer between your own accounts, dismiss both sides so it doesn't book as income and expense.` });
    }

    // Double-booked spend: two 'created' ledger entries born from different
    // statements with the same payee + amount within 3 days — the duplicate
    // that row-dedupe can't catch once both sides became real entries.
    const { rows: dblBook } = await pool.query(`
      SELECT a.id AS a_id, b.id AS b_id, a.statement_id, a.payee_guess, a.amount,
             a.txn_date, b.txn_date AS b_date
      FROM bank_transactions a
      JOIN bank_transactions b ON b.id > a.id AND b.statement_id <> a.statement_id
        AND b.match_method = 'created' AND b.dismissed = false
        AND b.amount = a.amount AND ABS(b.txn_date - a.txn_date) <= 3
        AND LOWER(COALESCE(b.payee_guess, '')) = LOWER(COALESCE(a.payee_guess, ''))
      WHERE a.match_method = 'created' AND a.dismissed = false
      LIMIT 10`);
    for (const r of dblBook) {
      flags.push({ severity: 'error', type: 'double-booked', fingerprint: `dbl:${r.a_id}:${r.b_id}`,
        statement_id: r.statement_id, q: r.payee_guess || '',
        title: `Booked twice: ${r.payee_guess || '(no payee)'} ${money(r.amount)}`,
        detail: `The same charge (${day(r.txn_date)} / ${day(r.b_date)}) was booked into the ledger from two different statements — the ledger now carries it twice. Unbook one of them.` });
    }

    // Stale coverage: a finished month still mostly unreconciled.
    const { rows: stale } = await pool.query(`
      SELECT s.id, s.filename,
        COUNT(*) FILTER (WHERE t.direction = 'debit' AND t.dismissed = false AND t.matched_expense_id IS NULL)::int AS open_n,
        COALESCE(SUM(t.amount) FILTER (WHERE t.direction = 'debit' AND t.dismissed = false), 0) AS live_amt,
        COALESCE(SUM(t.amount) FILTER (WHERE t.direction = 'debit' AND t.dismissed = false AND t.matched_expense_id IS NOT NULL), 0) AS cov_amt
      FROM bank_statements s
      JOIN bank_transactions t ON t.statement_id = s.id
      WHERE s.status = 'ready' AND s.period_end < CURRENT_DATE - 7
      GROUP BY s.id, s.filename`);
    for (const r of stale) {
      const pct = Number(r.live_amt) > 0 ? Math.round((Number(r.cov_amt) / Number(r.live_amt)) * 100) : 100;
      if (r.open_n >= 20 && pct < 60) {
        flags.push({ severity: 'warn', type: 'stale-coverage', fingerprint: `stale:${r.id}`,
          statement_id: r.id,
          title: `"${r.filename}" is only ${pct}% reconciled`,
          detail: `The period ended over a week ago and ${r.open_n} debits are still open. Run the swipe review to finish the month.` });
      }
    }

    // Paid on the ledger, never seen leaving the bank: Paid families whose
    // payment date falls inside a covered statement period (account
    // method-compatible) but that no bank transaction anywhere matches.
    // PER-ITEM (John's ask): every Paid ledger family with no bank match
    // is its own worklist flag — jump to the ledger row, jump to the
    // statement that should have shown it, or mark it Unpaid in one
    // click. Only families a ready statement SHOULD have shown (window
    // covers the paid date, method compatible) are flagged; biggest
    // amounts first, capped at 150 per pass.
    const { rows: paidUnmatched } = await pool.query(
      `${FAMILY_SQL} AND r.payment_status = 'Paid' AND r.payment_date IS NOT NULL
        AND r.id NOT IN (SELECT matched_expense_id FROM bank_transactions
                          WHERE matched_expense_id IS NOT NULL)
       ORDER BY r.amount DESC`);
    // Two counters on purpose. `pnmTotal` is every paid entry with no bank
    // match inside a covering period; `pnmCount` is how many we actually attach.
    // The 150 cap keeps the payload bounded, but reporting 150 as if it were the
    // answer would understate the problem on its own Flags subpage — so the true
    // figure is returned separately and the page says when the list is trimmed.
    let pnmCount = 0;
    let pnmTotal = 0;
    for (const f of paidUnmatched) {
      const pd = new Date(f.payment_date).getTime();
      const st = stmts.find((s) => s.period_start && s.period_end
        && pd >= new Date(s.period_start).getTime() - 3 * 86400000
        && pd <= new Date(s.period_end).getTime() + 3 * 86400000
        && methodCompatible(s.account, f.payment_method));
      if (!st) continue;
      pnmTotal++;
      if (++pnmCount > 150) continue;
      flags.push({ severity: 'warn', type: 'paid-no-match',
        fingerprint: `pnm:${f.id}`,
        statement_id: st.id, q: f.payee || '', ledger_id: f.id,
        action: { kind: 'mark-unpaid', entry_id: f.id, payee: f.payee },
        // Structured copy of what the detail sentence says, so the Flags page
        // can offer the three remedies in place instead of sending people to
        // another page to retype what we already know. `account` is the
        // statement that SHOULD have shown this payment — the reason the flag
        // fired — which is what makes "wrong method" diagnosable.
        entry: {
          id: f.id,
          payee: f.payee || '',
          amount: f.family_total,
          payment_date: f.payment_date,
          payment_method: f.payment_method || '',
          invoice_number: f.invoice_number || '',
          artist: f.artist || '',
          account: st.account,
        },
        title: `${f.payee} ${money(f.family_total)} — paid, no bank match`,
        detail: `Marked Paid ${day(f.payment_date)}${f.payment_method ? ` by ${f.payment_method}` : ''}${f.invoice_number ? ` · inv ${f.invoice_number}` : ''}${f.artist ? ` · ${f.artist}` : ''} — but it never appears leaving the ${String(st.account).toUpperCase()} account. Either the payment date/method is wrong, it was paid from an account with no statement uploaded, or it isn't actually paid.` });
    }

    // Double-counted funding legs the sweep can't auto-fix: the bank pull
    // AND its PayPal twin are both matched/booked (bank side by a human
    // decision). One real payment, two ledger records.
    const { rows: dblLegs } = await pool.query(`
      SELECT b.id AS bank_id, b.txn_date AS bdate, b.amount, b.payee_guess AS bank_payee,
             b.match_method AS b_method, b.statement_id,
             (SELECT p.id FROM bank_transactions p
               JOIN bank_statements sp ON sp.id = p.statement_id AND sp.account = 'paypal' AND sp.status = 'ready'
              WHERE p.direction = 'debit' AND p.dismissed = false AND p.amount = b.amount
                AND ABS(p.txn_date - b.txn_date) <= 3
                AND (p.matched_expense_id IS NOT NULL OR p.matched_income_id IS NOT NULL)
                AND (b.description ~* 'PAYPAL'
                  OR LOWER(COALESCE(p.payee_guess, '')) LIKE LOWER(b.payee_guess) || '%'
                  OR LOWER(b.payee_guess) LIKE LOWER(COALESCE(p.payee_guess, '')) || '%')
              ORDER BY ABS(p.txn_date - b.txn_date) LIMIT 1) AS pp_id
        FROM bank_transactions b
        JOIN bank_statements sb ON sb.id = b.statement_id AND sb.account <> 'paypal' AND sb.status = 'ready'
       WHERE b.direction = 'debit' AND b.dismissed = false
         AND COALESCE(b.payee_guess, '') <> ''
         AND (b.matched_expense_id IS NOT NULL OR b.matched_income_id IS NOT NULL)
         AND (b.description ~* 'PAYPAL'
           OR (b.description ~* 'DES:' AND b.description ~* '(PMT INFO: ?WEB|IAT)'))
       LIMIT 200`).catch((e) => { console.warn('double-funding flag check failed:', e.message); return { rows: [] }; });
    for (const l of dblLegs) {
      if (!l.pp_id) continue;
      flags.push({ severity: 'error', type: 'double-funding',
        fingerprint: `dblleg:${l.bank_id}:${l.pp_id}`,
        statement_id: l.statement_id, q: l.bank_payee || '',
        ...(l.b_method !== 'created' ? { action: { kind: 'unmatch', txn_id: l.bank_id } } : {}),
        title: `Payment counted twice: ${l.bank_payee || ''} ${money(l.amount)}`,
        detail: `The ${day(l.bdate)} bank debit is the funding pull of a PayPal payment that is ALSO matched. One real payment is claiming two ledger records — ${l.b_method === 'created' ? 'unbook the bank side' : 'unmatch the bank side'}, then dismiss it as a funding leg.` });
    }

    // Mislabeled currency suspects: a PayPal payment whose exact amount
    // also appears as a same-day "Currency Conversion" row is almost
    // certainly a FOREIGN face amount (the conversion moves the face
    // value) — parsed as USD before currency capture existed.
    const { rows: curSuspects } = await pool.query(`
      SELECT t.id, t.txn_date, t.amount, t.payee_guess, t.statement_id,
             t.matched_expense_id, t.match_method
        FROM bank_transactions t
        JOIN bank_statements s ON s.id = t.statement_id AND s.account = 'paypal' AND s.status = 'ready'
       WHERE COALESCE(t.currency, 'USD') = 'USD' AND t.dismissed = false
         AND t.description !~* 'conversion'
         AND t.amount >= 500
         AND EXISTS (SELECT 1 FROM bank_transactions c
                      WHERE c.statement_id = t.statement_id
                        AND c.id <> t.id AND c.amount = t.amount
                        AND ABS(c.txn_date - t.txn_date) <= 1
                        AND c.description ~* 'conversion')
       LIMIT 25`).catch(() => ({ rows: [] }));
    for (const r of curSuspects) {
      flags.push({ severity: 'error', type: 'suspect-currency',
        fingerprint: `suscur:${r.id}`,
        statement_id: r.statement_id, q: r.payee_guess || '',
        title: `Probably not USD: ${r.payee_guess || ''} ${money(r.amount)}`,
        detail: `This PayPal payment's exact amount also appears as a same-day currency-conversion row — the pattern of a FOREIGN-currency payment parsed as USD. Open the statement file to check the real currency${r.matched_expense_id ? `, ${r.match_method === 'created' ? 'unbook it' : 'unmatch it'},` : ''} then set the currency on its review card.` });
    }

    // Booked duplicates: a bank debit was BOOKED as a new ledger entry when
    // a matching invoice already existed — the money now lives twice in the
    // ledger (the untouched original reads "paid, no bank match" while the
    // copy holds the bank proof). One-click fix: unbook the copy, match the
    // debit to the original.
    try {
      const { rows: createdRows } = await pool.query(`
        SELECT t.id AS txn_id, t.amount, t.txn_date, t.statement_id,
               ce.id AS created_id, ce.payee AS created_payee
          FROM bank_transactions t
          JOIN expenses ce ON ce.id = t.matched_expense_id
          JOIN bank_statements s ON s.id = t.statement_id AND s.status = 'ready'
         WHERE t.match_method = 'created' AND t.dismissed = false
           AND ce.entry_source = 'bank_statement'
           AND (ce.deleted = false OR ce.deleted IS NULL)`);
      if (createdRows.length) {
        const { rows: fams } = await pool.query(
          `${FAMILY_SQL} AND COALESCE(r.entry_source, '') <> 'bank_statement'
       AND NOT ${UNDOCUMENTED_ADDED_SQL('r')}`);
        const claims = await loadClaimedSums();
        const ctx = await loadMatchContext();
        const byName = new Map();
        for (const f of fams) {
          const k = (f.payee || '').toLowerCase().trim();
          if (!byName.has(k)) byName.set(k, []);
          byName.get(k).push(f);
        }
        let emitted = 0;
        for (const c of createdRows) {
          if (emitted >= 80) break;
          const ck = (c.created_payee || '').toLowerCase().trim();
          // Same name, its alias group, or a strong fuzzy match.
          const names = new Set([ck, ...(ctx.aliases.get(ck) || [])]);
          let cands = [];
          for (const n of names) cands.push(...(byName.get(n) || []));
          if (!cands.length) {
            for (const [k, list] of byName) {
              const vm = vendorsMatch(c.created_payee, list[0]?.payee);
              if (vm.match && vm.score >= 0.8) cands.push(...list);
            }
          }
          const amt = Number(c.amount);
          const fits = cands.filter((f) =>
            claimedOf(claims, f.id) === 0
            && Math.abs(Number(f.family_total) - amt) <= feeTolerance(amt));
          if (!fits.length) {
            // The original may be CLAIMED — by the wrong payment (an
            // amount-coincidence auto match whose bank payee flatly
            // disagrees with the vendor). Flag the thief: unmatching it
            // frees the invoice, and the next pass offers the duplicate fix.
            const held = cands.find((f) =>
              Math.abs(Number(f.family_total) - amt) <= feeTolerance(amt)
              && claimedOf(claims, f.id) > 0);
            if (held) {
              const { rows: holders } = await pool.query(`
                SELECT id, payee_guess, match_method, txn_date FROM bank_transactions
                 WHERE matched_expense_id = $1 AND dismissed = false`, [held.id]);
              const thief = holders.find((h) => {
                if (!/^auto/.test(h.match_method || '')) return false;
                if (!(h.payee_guess || '').trim() || !(held.payee || '').trim()) return false;
                const vm = vendorsMatch(h.payee_guess, held.payee);
                return !vm.match && vm.score < 0.25;
              });
              if (thief && emitted < 80) {
                emitted++;
                flags.push({ severity: 'error', type: 'stolen-match',
                  fingerprint: `steal:${thief.id}:${held.id}`,
                  statement_id: c.statement_id, q: held.payee || '', ledger_id: held.id,
                  action: { kind: 'unmatch', txn_id: thief.id },
                  title: `Wrong payment holds this invoice: ${held.payee} ${money(held.family_total)}`,
                  detail: `${held.payee}'s invoice is matched to a ${day(thief.txn_date)} bank payment from "${thief.payee_guess}" (${thief.match_method} — the names don't agree), while the real ${c.created_payee} payment sits booked as a duplicate copy. Unmatch the wrong payment — the next flags pass then offers the one-click duplicate fix.` });
              }
            }
            continue;
          }
          fits.sort((a, b) => Math.abs(Number(a.family_total) - amt) - Math.abs(Number(b.family_total) - amt));
          const orig = fits[0];
          emitted++;
          flags.push({ severity: 'error', type: 'booked-duplicate',
            fingerprint: `bdup:${c.created_id}:${orig.id}`,
            statement_id: c.statement_id, q: c.created_payee || '', ledger_id: orig.id,
            action: { kind: 'unbook-rematch', txn_id: c.txn_id, expense_id: orig.id, payee: orig.payee },
            title: `Booked a duplicate: ${c.created_payee} ${money(amt)}`,
            detail: `The ${day(c.txn_date)} bank debit was booked as a NEW ledger entry, but ${orig.payee}'s ${money(orig.family_total)} invoice${orig.invoice_number ? ` (inv ${orig.invoice_number})` : ''} already exists${orig.payment_status === 'Paid' ? ' (marked Paid, no bank match)' : ''} — the expense counts twice. Fix removes the copy and matches the debit to the original invoice.` });
        }
      }
    } catch (e) { console.warn('booked-duplicate flag check failed:', e.message); }

    // Soft-close integrity: a reconciled month that has open items again
    // was changed after the close — say so instead of silently un-closing.
    const { rows: recMonths } = await pool.query(`SELECT * FROM statement_months`).catch(() => ({ rows: [] }));
    if (recMonths.length) {
      const { rows: openByMonth } = await pool.query(`
        SELECT to_char(t.txn_date, 'YYYY-MM') AS mk,
               COUNT(*) FILTER (WHERE t.direction = 'debit' AND t.matched_expense_id IS NULL AND t.dismissed = false)::int AS open_debits
          FROM bank_transactions t
          JOIN bank_statements s ON s.id = t.statement_id AND s.status = 'ready'
         GROUP BY 1`);
      const openOf = Object.fromEntries(openByMonth.map((r) => [r.mk, r.open_debits]));
      for (const r of recMonths) {
        const open = openOf[r.month_key] || 0;
        if (open > 0) {
          flags.push({ severity: 'warn', type: 'reopened-month',
            fingerprint: `reopen:${r.month_key}:${open}`,
            title: `${r.month_key} was reconciled but has ${open} open debit${open === 1 ? '' : 's'} again`,
            detail: `The month was marked reconciled by ${r.reconciled_by || '?'} on ${day(r.reconciled_at)}. New uploads or unmatches since then left ${open} debit${open === 1 ? '' : 's'} unresolved — re-review and reconcile it again.` });
        }
      }
    }

    // Split acknowledged flags out — "I know, it's fine" persists by
    // fingerprint; a changed fingerprint (new dupes, different count)
    // resurfaces automatically.
    const { rows: ackRows } = await pool.query(`SELECT fingerprint FROM statement_flag_acks`);
    const acks = new Set(ackRows.map((r) => r.fingerprint));
    const active = flags.filter((f) => !acks.has(f.fingerprint));
    const acked = flags.filter((f) => acks.has(f.fingerprint));
    const bySev = (a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1);
    active.sort(bySev); acked.sort(bySev);
    res.json({ success: true, data: { flags: active, acked, counts: { paid_no_match: pnmTotal } } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Acknowledge / un-acknowledge a flag by fingerprint.
router.post('/flags/ack', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const fp = String(req.body.fingerprint || '').slice(0, 500);
    if (!fp) return res.status(400).json({ success: false, error: 'fingerprint required' });
    await pool.query(
      `INSERT INTO statement_flag_acks (fingerprint, created_by) VALUES ($1, $2)
       ON CONFLICT (fingerprint) DO NOTHING`, [fp, req.user.name]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.delete('/flags/ack', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const fp = String(req.body.fingerprint || req.query.fingerprint || '');
    if (!fp) return res.status(400).json({ success: false, error: 'fingerprint required' });
    await pool.query(`DELETE FROM statement_flag_acks WHERE fingerprint = $1`, [fp]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Detail enrichment shared by the single-statement view and the
// all-statements review view: matched families, booked income, category /
// income-type suggestions, top-3 match suggestions, paid-no-match, and
// the hotkey usage map.
async function enrichDetail(st, txns) {
    // Attach the matched family (payee/status/total) to each matched txn
    const matchedIds = [...new Set(txns.filter((t) => t.matched_expense_id).map((t) => t.matched_expense_id))];
    let families = {};
    if (matchedIds.length) {
      const { rows } = await pool.query(`${FAMILY_SQL} AND r.id = ANY($1)`, [matchedIds]);
      families = Object.fromEntries(rows.map((f) => [f.id, f]));
    }
    // Booked-income info for credit rows
    const incomeIds = [...new Set(txns.filter((t) => t.matched_income_id).map((t) => t.matched_income_id))];
    let incomes = {};
    if (incomeIds.length) {
      const { rows } = await pool.query(
        `SELECT id, income_type, artist_name, description FROM artist_income WHERE id = ANY($1)`, [incomeIds]);
      incomes = Object.fromEntries(rows.map((i) => [i.id, i]));
    }
    const learnedCats = await loadCategoryMap();
    // USD estimate per row so client totals never sum yen as dollars
    const fxRates = getCached()?.rates || {};
    const usdEst = (amount, cur) => {
      const c = (cur || 'USD').toUpperCase();
      if (c === 'USD') return Number(amount);
      const r = fxRates[c];
      return r > 0 ? Math.round((Number(amount) / r) * 100) / 100 : Number(amount);
    };
    const data = txns.map((t) => ({
      ...t,
      usd: usdEst(t.amount, t.currency),
      matched: t.matched_expense_id ? families[t.matched_expense_id] || null : null,
      income: t.matched_income_id ? incomes[t.matched_income_id] || null : null,
      suggested_category: (!t.matched_expense_id && !t.dismissed && t.direction === 'debit') ? suggestCategory(t, learnedCats) : null,
      suggested_income_type: (!t.matched_income_id && !t.dismissed && t.direction === 'credit') ? suggestIncomeType(t) : null,
      // Flag the row so the deck can offer "pair and dismiss" instead of an
      // income booking, even when no twin debit was found in an uploaded
      // statement (the original may predate the statements you hold).
      looks_like_reversal: t.direction === 'credit' && looksLikeReversal(t),
    }));

    // Reversal pairing: attach each debit's reversal credit (and vice
    // versa) so the deck can offer "dismiss both sides" instead of tempting
    // a match between a FAILED payment and an invoice. Queried globally —
    // the reversal often lands on the next month's statement.
    // REVERSAL and REFUND credits both undo an earlier debit. Payee match:
    // equal names, OR the debit's payee printed inside the credit's
    // description ("REVERSAL MARKET STREET:Tone Confirmation…" — the
    // credit's own payee field says MARKET STREET while the twin is Tone).
    const { rows: revPairs } = await pool.query(`
      SELECT DISTINCT ON (c.id) c.id AS credit_id, d.id AS debit_id,
             c.txn_date AS cdate, d.txn_date AS ddate,
             (c.matched_income_id IS NOT NULL) AS credit_booked,
             (d.matched_expense_id IS NOT NULL) AS debit_matched,
             d.match_method AS debit_method
        FROM bank_transactions c
        JOIN bank_transactions d ON d.direction = 'debit' AND d.amount = c.amount
          AND (LOWER(COALESCE(d.payee_guess, '')) = LOWER(COALESCE(c.payee_guess, ''))
            OR (LENGTH(COALESCE(d.payee_guess, '')) >= 3
              AND POSITION(LOWER(d.payee_guess) IN LOWER(COALESCE(c.description, ''))) > 0))
          AND d.txn_date <= c.txn_date AND c.txn_date - d.txn_date <= 21
          AND d.dismissed = false
       WHERE c.direction = 'credit' AND c.dismissed = false
         AND c.description ~* '\\mrevers|\\mrefund'
       ORDER BY c.id, d.txn_date DESC`).catch(() => ({ rows: [] }));
    const revByDebit = new Map(revPairs.map((r) => [r.debit_id, r]));
    const revByCredit = new Map(revPairs.map((r) => [r.credit_id, r]));
    for (const t of data) {
      const asDebit = revByDebit.get(t.id);
      const asCredit = revByCredit.get(t.id);
      if (asDebit) t.reversed_by = { id: asDebit.credit_id, txn_date: asDebit.cdate, booked: asDebit.credit_booked };
      if (asCredit) t.reversal_of = { id: asCredit.debit_id, txn_date: asCredit.ddate, matched: asCredit.debit_matched, method: asCredit.debit_method };
    }

    // Top-3 match suggestions for every unmatched debit — the near-misses
    // that failed one of auto-match's strict gates (amount off by a fee,
    // date outside the window, method mismatch). Amount prefilter keeps the
    // fuzzy-name scoring cheap even on a 300-debit statement.
    const needSuggestions = data.filter((t) => t.direction === 'debit' && !t.matched_expense_id && !t.dismissed && !isInternal(t.description));
    if (needSuggestions.length) {
      // Candidates exclude entries that were themselves created from a bank
      // line. Matching one debit to another debit's invented entry records a
      // document-backed payment where no document exists, and it is not
      // hypothetical: two live matches were made that way, both by the auto
      // matcher (#5758 $1.00 auto-learned, #4249 $0.01 auto-ref).
      //
      // Added HERE and not inside FAMILY_SQL. That constant has ~12 call sites,
      // and several resolve ALREADY-MATCHED families — including the booked rows
      // whose whole payload is a bank-created entry. Filtering it centrally
      // would blank the `matched` object on every booked row in the table.
      // Same shape as the rematch pool at line ~2206, which already does this.
      const { rows: allFams } = await pool.query(
        `${FAMILY_SQL} AND COALESCE(r.entry_source, '') <> 'bank_statement'
       AND NOT ${UNDOCUMENTED_ADDED_SQL('r')}`);
      const claims = await loadClaimedSums();
      const matchCtx = await loadMatchContext();
      const rejections = await loadRejections();
      // Ledger-majority category per vendor — for identity-backed cards
      // with no open invoice ("linked vendor, likely an unbilled recurring
      // charge — book as their usual category").
      const usualCat = new Map();
      const displayOf = new Map();
      {
        const { rows: catRows } = await pool.query(`
          SELECT LOWER(TRIM(payee)) AS p, MIN(payee) AS display, category, COUNT(*)::int AS n
            FROM expenses
           WHERE category IS NOT NULL AND payee IS NOT NULL
             AND (deleted = false OR deleted IS NULL)
           GROUP BY 1, 3`).catch(() => ({ rows: [] }));
        const bestN = new Map();
        for (const r of catRows) {
          displayOf.set(r.p, r.display);
          if ((bestN.get(r.p) || 0) < r.n) { bestN.set(r.p, r.n); usualCat.set(r.p, r.category); }
        }
      }
      // Families bucketed by squashed payee, built ONCE. Read by the
      // several-invoices-one-payment proposal below to reach a vendor's invoices
      // without scoring the whole ledger per row.
      const payeeKeyOf = (n) => String(n || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      const famsByPayee = new Map();
      for (const f of allFams) {
        const k = payeeKeyOf(f.payee);
        if (!k) continue;
        if (!famsByPayee.has(k)) famsByPayee.set(k, []);
        famsByPayee.get(k).push(f);
      }

      // Txn amount in the family's OWN currency (cached rates — the precise
      // historical path lives in the match guard). A GBP 100 invoice paid
      // by a $137.45 wire is an exact fit, not a $37 miss.
      const famAmtOf = (t, f, face) => {
        const tCur = (t.currency || 'USD').toUpperCase();
        const fCur = (f.currency || 'USD').toUpperCase();
        if (tCur === fCur) return Number(t.amount);
        if (face && face.currency === fCur) return face.amount;
        const rate = (c) => (c === 'USD' ? 1 : fxRates[c] || 0);
        const tr = rate(tCur);
        if (!(tr > 0)) return Number(t.amount);
        const usd = Number(t.amount) / tr;
        const locked = parseFloat(f.fx_rate_to_usd || 0);
        const fr = locked > 0 ? locked : rate(fCur);
        return fr > 0 ? usd * fr : Number(t.amount);
      };
      // Capacity, not claimed/unclaimed: a $4,500 split family with one
      // $1,500 wire matched still has $3,000 of room for the next wires.
      for (const t of needSuggestions) {
        const face = fxFaceOf(t);
        // Identity: the payee resolves through an explicit link / learned
        // lesson / alias group to a ledger vendor. That vendor's open
        // invoices rank above any cross-vendor amount coincidence.
        const tName = (t.payee_guess || '').toLowerCase().trim();
        const mapped = matchCtx.exact.get(tName)
          || (tName ? matchCtx.norm.get(normalizeBankPayee(t.payee_guess)) : null);
        // The alias group counts as identity in its own right, not only when a
        // learned lesson already exists.
        //
        // This used to be `mapped ? aliases.get(mapped) : null` — learned-map
        // only. So a bank payee that IS a known alias but had never been matched
        // by hand produced no identity, and identity is what lets a candidate
        // skip the amount prefilter below (`diff <= max(5, amt*0.25)`). The
        // correct invoice for an alias-only vendor was therefore dropped before
        // scoring whenever the amount differed by more than 25% — it could never
        // reach the top 3, no matter how certain the name was. 62 unmatched
        // debits currently carry a payee that is a known alias.
        const idGroup = matchCtx.aliases.get(tName)
          || (mapped ? (matchCtx.aliases.get(mapped) || new Set([mapped])) : null);
        const tEmail = (t.payee_email || '').toLowerCase().trim();
        const isIdentity = (f) => {
          const fName = (f.payee || '').toLowerCase().trim();
          if (idGroup && idGroup.has(fName)) return true;
          return !!(tEmail && tEmail === (f.vendor_email || '').toLowerCase().trim());
        };
        const near = allFams
          .map((f) => {
            const amtF = famAmtOf(t, f, face);
            return { f, amtF, identity: isIdentity(f), diff: bestAmountDiff(f, amtF, claims) };
          })
          .filter((x) => capacityOk(x.f, x.amtF, claims))
          .filter((x) => x.diff <= Math.max(5, x.amtF * 0.25) || x.identity)
          .sort((a, b) => (b.identity - a.identity) || (a.diff - b.diff))
          .slice(0, 40);
        const scored = near.map(({ f, amtF, identity, diff }) => {
          const amountScore = 1 - Math.min(1, diff / Math.max(amtF, 1));
          const vm = nameEvidence(matchCtx, t, f);
          // Date = soft evidence: paid date when Paid, scheduled date when
          // not. Full credit same-day, fading to zero at a week (banks
          // settle 1-3 business days late); undated candidates sit neutral
          // rather than penalized.
          const ev = evidenceDate(f);
          const dd = ev ? Math.abs((new Date(ev) - new Date(t.txn_date)) / 86400000) : null;
          const dateScore = dd === null ? 0.5 : Math.max(0, 1 - dd / 7);
          const exactAmount = diff < 0.01;
          const fxExact = !!(face && (f.currency || 'USD').toUpperCase() === face.currency
            && Math.abs(face.amount - Number(f.family_total)) < 0.01);
          // Explainability — which KIND of confidence this is.
          const why = [];
          if (vm.reason === 'reference' || vm.reason === 'invoice#') why.push('ref');
          else if (vm.reason === 'email') why.push('email');
          else if (vm.reason === 'learned' || identity) why.push('linked vendor');
          else if (vm.reason === 'alias' || vm.reason === 'alias-fuzzy') why.push('alias');
          else if (vm.score >= 0.75) why.push('name');
          if (fxExact) why.push('FX exact');
          else if (exactAmount) why.push('exact amount');
          else if (diff <= feeTolerance(amtF)) why.push('amount+fee');
          if (dd !== null && dd <= 7) why.push(`±${Math.round(dd)}d`);
          return { f, identity, why, rejected: isRejected(rejections, t, f.id),
            score: amountScore * 0.55 + vm.score * 0.3 + dateScore * 0.15, exactAmount };
        })
          .filter((x) => x.exactAmount || x.identity || x.score >= 0.55)
          // Rejected pairings sink to the bottom (shown only when fewer
          // than 3 live candidates exist); identity outranks raw score.
          .sort((a, b) => (a.rejected - b.rejected) || (b.identity - a.identity) || (b.score - a.score))
          .slice(0, 3);
        t.suggestions = scored.map((x) => ({
          id: x.f.id, payee: x.f.payee, family_total: x.f.family_total,
          invoice_number: x.f.invoice_number, payment_status: x.f.payment_status,
          invoice_date: x.f.invoice_date, score: Math.round(x.score * 100),
          // What tells two candidates apart. The card renders every field but
          // highlights only the ones that DIFFER across this row's candidates,
          // so a field that is identical everywhere costs nothing and a field
          // that separates them is what the eye lands on.
          //
          // These matter most on exactly the rows where the old card was
          // useless: a live PayPal line offers three invoices identical on
          // payee, amount, score, status AND date — separable today only by
          // invoice number. Without these fields there is nothing to highlight
          // and picking wrong marks the wrong invoice paid, silently.
          // The document is what settles a choice between two invoices that
          // agree on vendor, amount and confidence — the exact case these
          // cards exist for.
          has_invoice: !!x.f.has_invoice, has_proof: !!x.f.has_proof, has_receipt: !!x.f.has_receipt,
          invoice_filename: x.f.invoice_filename || null,
          proof_filename: x.f.proof_filename || null,
          receipt_filename: x.f.receipt_filename || null,
          artist: x.f.artist || null,
          song: x.f.song || null,
          description: x.f.description || null,
          boom_rep: x.f.boom_rep || null,
          entered_at: x.f.created_at || null,
          // THE date this suggestion was scored against — the one that produced
          // its ±Nd chip. The card showed "Paid" and a day-delta but never which
          // dates, so judging a match meant leaving the deck to look the entry
          // up. Sent from evidenceDate() rather than re-derived on the client,
          // so the number shown can't disagree with the number scored.
          //
          // Falls back to invoice_date for an unpaid entry with no scheduled
          // date: evidenceDate() is null there (those score neutral, no chip),
          // and the invoice date is still the most useful thing the card can
          // say. The distinct label keeps it from reading as a payment date.
          evidence_date: evidenceDate(x.f) || x.f.invoice_date || null,
          evidence_kind: (x.f.payment_status === 'Paid' && x.f.payment_date) ? 'paid'
            : x.f.scheduled_payment_date ? 'scheduled'
              : x.f.invoice_date ? 'invoiced' : null,
          why: x.why, rejected: x.rejected || undefined,
          // Installment context for the UI: how much of the family is
          // still unpaid by bank debits.
          remaining: Math.round((Number(x.f.family_total) - claimedOf(claims, x.f.id)) * 100) / 100,
        }));

        // ── SEVERAL INVOICES, ONE PAYMENT — nobody marked it ─────────────────
        //
        // The tier in runAutoMatch only ever settles a group a PERSON declared.
        // This is the other half: 465 same-payee-same-date groups of 2+ invoices
        // are already in the ledger with nothing connecting them, and none of
        // them will ever be marked retroactively unless something points them
        // out. So the row carries an OFFER — the invoices whose totals add up to
        // this payment exactly — accepted through the same /attach a person uses
        // for the ones they spot themselves.
        //
        // Proposes only, never applies. Guessing which invoices add up to a
        // payment marks the wrong invoice NUMBERS settled, and nothing
        // downstream contradicts that.
        //
        // Skipped when one invoice already fits exactly: a single clean answer
        // must not compete with a combination.
        if (!scored.some((x) => x.exactAmount && !x.rejected)) {
          const txnUsd = Math.abs(usdOf(t.amount, t.currency));
          // ONE VENDOR'S invoices, reached through the payee index rather than by
          // scoring every family. nameEvidence is real string work, and running
          // it over ~1,500 families for each of ~700 unmatched debits is a
          // million comparisons inside a request handler.
          //
          // The bucket is the vendor's own name plus every name in its identity
          // group (learned lesson / alias class / email), which is the same
          // identity the deck's cards use. A fuzzy-only name is deliberately NOT
          // reached here: a combination of invoices is weaker evidence than a
          // single exact amount, so the vendor has to be identified rather than
          // guessed at. Link the payee once and the offer appears.
          const vendorFamPool = [];
          for (const nm of (idGroup ? [...idGroup] : []).concat(tName ? [tName] : [])) {
            for (const f of (famsByPayee.get(payeeKeyOf(nm)) || [])) {
              if (!vendorFamPool.includes(f)) vendorFamPool.push(f);
            }
          }
          const pool6 = vendorFamPool
            .filter((f) => {
              if (!methodCompatible(st.account, f.payment_method)) return false;
              if (claimedOf(claims, f.id) !== 0) return false;   // already carrying money
              if (isRejected(rejections, t, f.id)) return false;
              const vm = nameEvidence(matchCtx, t, f);
              if (!vm.match) return false;
              if (namesDisagreeFor(t, f, vm)) return false;      // the veto applies here too
              const ev = evidenceDate(f) || f.invoice_date;
              if (ev && Math.abs((new Date(ev) - new Date(t.txn_date)) / 86400000) > REMATCH_WINDOW_DAYS) return false;
              const u = usdOf(f.family_total, f.currency, f.fx_rate_to_usd);
              return u > 0 && u < txnUsd;      // a whole invoice is the 1:1 tiers' job
            })
            .sort((a, b) => usdOf(b.family_total, b.currency, b.fx_rate_to_usd)
              - usdOf(a.family_total, a.currency, a.fx_rate_to_usd));
          // BOUNDED, and the bound is DISCLOSED. Subset-sum is exponential: six
          // invoices is 63 subsets, seven is 127, and a vendor with 23 open
          // invoices would be 8.4M. A truncated search that says nothing reads
          // as "there was nothing to find".
          const CAP = 6;
          const cand = pool6.slice(0, CAP);
          if (cand.length >= 2) {
            const cents = (f) => Math.round(usdOf(f.family_total, f.currency, f.fx_rate_to_usd) * 100);
            const want = Math.round(txnUsd * 100);
            const hits = [];
            for (let mask = 1; mask < (1 << cand.length); mask++) {
              let n = 0, sum = 0;
              for (let i = 0; i < cand.length; i++) if (mask & (1 << i)) { n++; sum += cents(cand[i]); }
              if (n < 2) continue;
              if (Math.abs(sum - want) <= 1) hits.push({ mask, n });
            }
            if (hits.length) {
              hits.sort((a, b) => a.n - b.n);
              const members = (mask) => cand.filter((_, i) => mask & (1 << i));
              // Two different combinations hitting the same total is the same
              // "refuse to guess which one" rule lib/split-breakdown.js applies.
              // Reported rather than dropped, so the row says what it saw.
              const ambiguous = hits.length > 1;
              const chosen = members(hits[0].mask);
              t.group_proposal = {
                ambiguous,
                total: Math.round(txnUsd * 100) / 100,
                combinations: hits.length,
                // The bound, always stated — not only when it bit.
                considered: cand.length,
                available: pool6.length,
                capped: pool6.length > CAP,
                invoices: (ambiguous ? hits.map((h) => members(h.mask)) : [chosen]).map((set) => set.map((f) => ({
                  id: f.id,
                  invoice_number: f.invoice_number || null,
                  payee: f.payee,
                  amount: Number(f.family_total),
                  currency: f.currency,
                  usd: Math.round(usdOf(f.family_total, f.currency, f.fx_rate_to_usd) * 100) / 100,
                  invoice_date: f.invoice_date || null,
                  settlement_group: f.settlement_group || null,
                }))),
                expense_ids: ambiguous ? null : chosen.map((f) => f.id),
              };
              if (pool6.length > CAP) {
                console.log(`[group-proposal] txn #${t.id}: ${pool6.length} unsettled invoices for `
                  + `"${t.payee_guess || 'this vendor'}", searched the ${CAP} largest`);
              }
            }
          }
        }

        // Linked vendor with NO live invoice candidate: tell the deck who
        // this is and their usual category — the card leads with a booking
        // (which creates the ledger entry under the vendor's real name).
        if (idGroup && !scored.some((x) => x.identity && !x.rejected)) {
          const names = [...idGroup];
          const display = names.map((n) => displayOf.get(n)).find(Boolean) || mapped;
          const cat = names.map((n) => usualCat.get(n)).find(Boolean) || null;
          t.vendor_hint = { vendor: display, usual_category: cat };
        }
      }
    }

    // Paid rows in this window+account with NO bank evidence anywhere
    let unverified = [];
    if (st.period_start && st.period_end) {
      const { rows: paidNoMatch } = await pool.query(
        `${FAMILY_SQL} AND r.payment_status = 'Paid'
          AND r.payment_date BETWEEN $1::date - 3 AND $2::date + 3
          AND r.id NOT IN (SELECT matched_expense_id FROM bank_transactions
                            WHERE matched_expense_id IS NOT NULL)
         ORDER BY r.payment_date`, [st.period_start, st.period_end]);
      unverified = st.account === 'all'
        ? paidNoMatch
        : paidNoMatch.filter((f) => methodCompatible(st.account, f.payment_method));

      // Find-in-bank: the reverse direction. For each unproven Paid entry,
      // score the OPEN bank debits in this view with the same evidence
      // stack — a one-click path from "no bank proof" to matched. The date
      // gate that blocked auto-match (ledger paid date weeks off) is soft
      // evidence here, not a filter.
      if (unverified.length) {
        const openDebits = data.filter((t) => t.direction === 'debit'
          && !t.matched_expense_id && !t.dismissed && !isInternal(t.description));
        if (openDebits.length) {
          const ctx = await loadMatchContext();
          const claims = await loadClaimedSums();
          for (const f of unverified) {
            f.bank_candidates = openDebits
              .map((t) => ({ t, diff: bestAmountDiff(f, Number(t.amount), claims) }))
              .filter((x) => x.diff <= Math.max(5, Number(f.family_total) * 0.25))
              .map(({ t, diff }) => {
                const amountScore = 1 - Math.min(1, diff / Math.max(Number(t.amount), 1));
                const nameScore = nameEvidence(ctx, t, f).score;
                const ev = evidenceDate(f);
                const dd = ev ? Math.abs((new Date(ev) - new Date(t.txn_date)) / 86400000) : null;
                const dateScore = dd === null ? 0.5 : Math.max(0, 1 - dd / 7);
                return { id: t.id, txn_date: t.txn_date, amount: t.amount, payee_guess: t.payee_guess,
                  score: Math.round((amountScore * 0.55 + nameScore * 0.3 + dateScore * 0.15) * 100) };
              })
              .filter((c) => c.score >= 55)
              .sort((a, b) => b.score - a.score)
              .slice(0, 3);
          }
        }
      }
    }

    // How often each category has been booked from statements — the deck maps
    // its 1-9 hotkeys AND its dropdown numbering to the most-used ones.
    //
    // Scoped to entry_source = 'bank_statement' on purpose: this is the prior
    // for "what will I pick when booking a bank row", so categories that only
    // ever arrive on vendor invoices should not outrank the ones actually
    // chosen here.
    //
    // Voided bookings don't vote — a reversed booking is a decision that was
    // undone, and counting it keeps a category numbered on the strength of work
    // that no longer stands. Weighted to the last 12 months so the numbering
    // follows how the label spends now rather than being anchored by history;
    // rows with no payment_date fall back to when they were created so a
    // booking never silently drops out of its own count.
    const { rows: usageRows } = await pool.query(`
      SELECT TRIM(category) AS category, COUNT(*)::int AS n FROM expenses
       WHERE entry_source = 'bank_statement' AND category IS NOT NULL
         AND (deleted = false OR deleted IS NULL)
         AND (voided = false OR voided IS NULL)
         AND COALESCE(payment_date, created_at::date) > (CURRENT_DATE - INTERVAL '12 months')
       GROUP BY TRIM(category)`).catch(() => ({ rows: [] }));
    const category_usage = Object.fromEntries(usageRows.map((r) => [r.category, r.n]));

    return { statement: st, transactions: data, paid_no_match: unverified, category_usage };
}

// GET /api/statements/all — every transaction across every ready statement,
// same shape as the single-statement detail so the whole review surface
// (mini-ledger, chips, deck, bulk) works globally.
router.get('/all', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: txns } = await pool.query(`
      SELECT t.*, s.account, s.filename AS statement_filename
        FROM bank_transactions t
        JOIN bank_statements s ON s.id = t.statement_id AND s.status = 'ready'
       ORDER BY t.txn_date DESC, t.id DESC`);
    const { rows: [bounds] } = await pool.query(`
      SELECT MIN(period_start) AS lo, MAX(period_end) AS hi
        FROM bank_statements WHERE status = 'ready'`);
    const st = {
      id: 'all', account: 'all', filename: 'All statements',
      period_start: bounds?.lo || null, period_end: bounds?.hi || null,
      status: 'ready',
    };
    res.json({ success: true, data: await enrichDetail(st, txns) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/statements/unmatched?limit=&include_dismissed=1
//
// Bank rows nothing in the ledger accounts for. Deliberately NOT part of
// /statements/flags: this is not an anomaly, it is a worklist — 481 rows, where
// the flags payload caps a genuine anomaly at 150. It is also deliberately NOT
// /statements/all, which runs enrichDetail (top-3 suggestions, per-row scoring)
// over every transaction in every statement; that work belongs to the review
// deck, not to a list whose job is "show me what is unaccounted for".
//
// Internal movement is already dismissed at upload (dismissInternal), so the
// live set is free of transfers and currency conversions without filtering here
// — and anything the sweeps dismissed is restorable through the same endpoint
// that dismisses, which is why include_dismissed exists.
router.get('/unmatched', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
    const includeDismissed = req.query.include_dismissed === '1';

    // Uncapped truth. Reporting the attached count as the total would understate
    // the backlog on the page built to surface it — the same mistake
    // paid_no_match's `counts` field exists to avoid.
    const { rows: [tot] } = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE t.direction = 'debit')::int AS debits,
             COUNT(*) FILTER (WHERE t.direction = 'credit')::int AS credits,
             COALESCE(SUM(COALESCE(t.amount_usd, t.amount)) FILTER (WHERE t.direction = 'debit'), 0)::float AS debit_usd,
             COALESCE(SUM(COALESCE(t.amount_usd, t.amount)) FILTER (WHERE t.direction = 'credit'), 0)::float AS credit_usd
        FROM bank_transactions t
        JOIN bank_statements s ON s.id = t.statement_id AND s.status = 'ready'
       WHERE t.matched_expense_id IS NULL AND t.matched_income_id IS NULL AND t.dismissed = false`);

    const { rows: [dis] } = await pool.query(`
      SELECT COUNT(*)::int AS n FROM bank_transactions t
        JOIN bank_statements s ON s.id = t.statement_id AND s.status = 'ready'
       WHERE t.matched_expense_id IS NULL AND t.matched_income_id IS NULL AND t.dismissed = true`);

    // Largest first: the backlog is worked by value, and a 500-row list read
    // chronologically buries the rows that move the numbers.
    //
    // The two sets are fetched SEPARATELY and each gets its own budget. A single
    // query ordered `dismissed ASC` with one LIMIT can never return a dismissed
    // row while more live rows exist than the limit — 481 live against a limit of
    // 250 meant the Restore list was structurally always empty.
    const COLS = `t.id, t.txn_date, t.amount, COALESCE(t.currency, 'USD') AS currency, t.amount_usd,
             t.direction, t.payee_guess, t.description, t.dismissed, t.dismissed_reason,
             t.statement_id, s.account, s.filename AS statement_filename`;
    const BASE = `FROM bank_transactions t
        JOIN bank_statements s ON s.id = t.statement_id AND s.status = 'ready'
       WHERE t.matched_expense_id IS NULL AND t.matched_income_id IS NULL`;

    const { rows: liveRows } = await pool.query(
      `SELECT ${COLS} ${BASE} AND t.dismissed = false
        ORDER BY COALESCE(t.amount_usd, t.amount) DESC, t.txn_date DESC
        LIMIT $1`, [limit]);

    // Dismissed rows are a review surface, not a worklist — a smaller window is
    // enough, and most-recent-first is what you want when undoing a mistake.
    const dismissedRows = includeDismissed ? (await pool.query(
      `SELECT ${COLS} ${BASE} AND t.dismissed = true
        ORDER BY t.txn_date DESC, t.id DESC
        LIMIT 100`)).rows : [];
    const rows = [...liveRows, ...dismissedRows];

    res.json({
      success: true,
      data: {
        rows,
        counts: {
          debits: tot.debits, credits: tot.credits,
          debit_usd: tot.debit_usd, credit_usd: tot.credit_usd,
          total: tot.debits + tot.credits,
          dismissed: dis.n,
        },
        limit,
        truncated: (tot.debits + tot.credits) > liveRows.length,
        dismissed_truncated: dis.n > dismissedRows.length,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Monthly close (soft) ─────────────────────────────────────────────────────
// GET /api/statements/months — per calendar month: which accounts have a
// ready statement, coverage, open counts, and the reconciled state. The
// close is SOFT: reconciling stamps the month; later changes surface as a
// flag ("June was reconciled but has open items again"), never a lock.
// The statement totals every integrity check needs, in one query.
//
// Lifted out of GET /flags so the flag surface and the integrity surface cannot
// disagree about what a statement adds up to — two places deriving the same
// money is the shape that once had the P&L drill at $3.73M against a report
// saying otherwise.
const STATEMENT_TOTALS_SQL = `
  SELECT s.id, s.account, s.filename, s.period_start, s.period_end, s.txn_count,
    s.ending_balance, s.beginning_balance, s.created_at,
    COALESCE(SUM(COALESCE(t.amount_usd, t.amount)) FILTER (WHERE t.direction = 'credit'), 0) AS credits_usd,
    COALESCE(SUM(COALESCE(t.amount_usd, t.amount)) FILTER (WHERE t.direction = 'debit'), 0) AS debits_usd,
    COUNT(*) FILTER (WHERE COALESCE(t.currency, 'USD') <> 'USD' AND t.amount_usd IS NULL)::int AS foreign_unconverted,
    COUNT(t.id)::int AS rows_stored
  FROM bank_statements s
  LEFT JOIN bank_transactions t ON t.statement_id = s.id
  WHERE s.status = 'ready'
  GROUP BY s.id
  ORDER BY s.account, s.period_start NULLS LAST`;

// GET /api/statements/integrity — is every statement proved, and is one missing?
//
// READ-ONLY, and deliberately its own surface rather than fourteen more entries
// in /flags: that list is 366 active and 0 acknowledged, which is past the point
// where anyone reads it. This answers one question per statement and one per
// account, so it can be a band rather than a queue.
//
// Why it exists: both balance checks in /flags SKIP when they cannot run, and a
// skip is silent. On production that meant six PayPal statements — 890
// transactions, $596,616 of debits — were subject to no balance check whatsoever
// and nothing said so. Here "we could not check this" is a value with a reason,
// not an absence.
router.get('/integrity', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: stmts } = await pool.query(STATEMENT_TOTALS_SQL);

    // Pairing input, aggregated in SQL. A PayPal statement proves itself by
    // every payment having a funding leg of the same amount and currency (see
    // lib/statement-integrity), and that is a multiset match — so what the
    // check needs is counts per (currency, direction, amount), not 226 rows.
    // Integer cents, because a multiset keyed on a float is a multiset keyed on
    // rounding.
    const { rows: pairRows } = await pool.query(`
      SELECT t.statement_id, COALESCE(t.currency, 'USD') AS currency, t.direction,
             ROUND(t.amount * 100)::bigint AS cents, COUNT(*)::int AS n
        FROM bank_transactions t
        JOIN bank_statements s ON s.id = t.statement_id AND s.status = 'ready'
       WHERE t.amount IS NOT NULL
       GROUP BY 1, 2, 3, 4`);
    const pairsByStatement = new Map();
    for (const r of pairRows) {
      if (!pairsByStatement.has(r.statement_id)) pairsByStatement.set(r.statement_id, []);
      pairsByStatement.get(r.statement_id).push({ currency: r.currency, direction: r.direction, cents: Number(r.cents), n: r.n });
    }

    const byAccount = new Map();
    for (const s of stmts) {
      if (!byAccount.has(s.account)) byAccount.set(s.account, []);
      byAccount.get(s.account).push(s);
    }

    const statements = [];
    const accounts = [];
    for (const [account, list] of byAccount) {
      // ISO day, never String(pgDate). node-pg hands back a Date, and
      // `String(new Date('2026-01-05'))` is "Mon Jan 05 2026 …" — so a
      // localeCompare sorts by WEEKDAY NAME and then by MONTH NAME, putting
      // February before January. That is not hypothetical: the first run of the
      // fixture had the chain reversed and filled nothing, which is the same
      // trap the ad-allocation ordering hit ("Tue May 04 2032").
      const ordered = list.slice().sort((a, b) => String(sDay(a.period_start)).localeCompare(String(sDay(b.period_start))));
      for (let i = 0; i < ordered.length; i += 1) {
        const st = ordered[i];
        const prev = i > 0 ? ordered[i - 1] : null;
        const pairing = pairingFromCounts(pairsByStatement.get(st.id) || []);
        const v = verdictFor(st, prev, pairing);
        // A hole in coverage, weekends discounted — four of the five raw gaps on
        // production are a Friday and the Monday after it.
        const gap = prev ? businessGapBetween(prev.period_end, st.period_start) : 0;
        statements.push({
          id: st.id, account, filename: st.filename,
          period_start: sDay(st.period_start), period_end: sDay(st.period_end),
          rows: st.rows_stored, txn_count: st.txn_count,
          // The parser's count against what is actually stored. Equal on every
          // live statement today; a divergence would be rows lost on insert.
          rows_match_parser: st.txn_count == null || Number(st.txn_count) === Number(st.rows_stored),
          credits: Number(st.credits_usd), debits: Number(st.debits_usd),
          beginning_balance: st.beginning_balance == null ? null : Number(st.beginning_balance),
          ending_balance: st.ending_balance == null ? null : Number(st.ending_balance),
          foreign_unconverted: st.foreign_unconverted,
          ...v,
          // Can a missing opening balance be filled from the chain? Reported so
          // the button can say how many it would touch.
          // Matches the backfill's own rule exactly, or the button offers a
          // count it will not deliver: a 0.00 close on an account that never
          // shows a real balance is an absent balance, not a zero one.
          backfillable: st.beginning_balance == null && !!prev && prev.ending_balance != null
            && (Math.abs(Number(prev.ending_balance)) > 0.05
              || ordered.some((x) => x.ending_balance != null && Math.abs(Number(x.ending_balance)) > 0.05)),
          business_gap_before: gap > 0 ? gap : 0,
          overlaps_previous: gap < 0 ? -gap : 0,
        });
      }
      accounts.push({ account, statements: ordered.length, ...expectedNext(ordered, new Date()) });
    }

    const unprovable = statements.filter((x) => x.status === 'unprovable');
    res.json({ success: true, data: {
      statements, accounts,
      summary: {
        total: statements.length,
        proved: statements.filter((x) => x.status === 'proved').length,
        proved_by_chain: statements.filter((x) => x.status === 'proved_by_chain').length,
        proved_by_pairing: statements.filter((x) => x.status === 'proved_by_pairing').length,
        unprovable: unprovable.length,
        // The money behind statements nothing can vouch for. The point of the
        // surface: an unchecked statement is not a small problem in proportion
        // to its row count.
        unprovable_debits: Math.round(unprovable.reduce((t, x) => t + x.debits, 0) * 100) / 100,
        unprovable_rows: unprovable.reduce((t, x) => t + x.rows, 0),
        backfillable: statements.filter((x) => x.backfillable).length,
        overdue_accounts: accounts.filter((a) => a.overdue).map((a) => a.account),
        row_count_mismatches: statements.filter((x) => !x.rows_match_parser).length,
      },
    } });
  } catch (err) {
    console.error('GET /api/statements/integrity:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/statements/backfill-beginning-balance
//
// Fills a missing opening balance from the previous statement's closing one, so
// the STANDALONE check applies where only the chained one did. The chained check
// is disabled by a coverage gap and cannot cover the first statement of an
// account: same arithmetic, weaker footing.
//
// ── What this must not do, and how that is guaranteed ──────────────────────
// John, 2026-09-02: "make sure it doesnt reopen old items or duplicate ones."
//
// It writes ONE COLUMN on bank_statements and re-parses nothing. It does not
// touch bank_transactions at all — not a row, not a match, not a dismissal —
// which is the only reliable way to promise that: a re-parse is what once
// doubled a live statement from 465 rows to 963, and re-deriving match state is
// what would reopen work somebody had already finished.
//
// So the guarantee is structural, not careful. The UPDATE names bank_statements,
// filters `beginning_balance IS NULL`, and takes its value from a sibling row's
// `ending_balance`. Idempotent: a second run finds nothing null and writes
// nothing. And it REFUSES a statement whose own opening balance disagrees with
// the previous closing one — there is nothing to fill there, and a disagreement
// is a finding rather than a gap.
//
// The fixture proves the promise by snapshotting every transaction's id, match,
// dismissal and no-invoice flag before and after, and asserting they are
// identical.
router.post('/backfill-beginning-balance', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: stmts } = await pool.query(STATEMENT_TOTALS_SQL);
    const byAccount = new Map();
    for (const s of stmts) {
      if (!byAccount.has(s.account)) byAccount.set(s.account, []);
      byAccount.get(s.account).push(s);
    }

    const filled = [];
    const skipped = [];
    for (const [account, list] of byAccount) {
      // ISO day, never String(pgDate). node-pg hands back a Date, and
      // `String(new Date('2026-01-05'))` is "Mon Jan 05 2026 …" — so a
      // localeCompare sorts by WEEKDAY NAME and then by MONTH NAME, putting
      // February before January. That is not hypothetical: the first run of the
      // fixture had the chain reversed and filled nothing, which is the same
      // trap the ad-allocation ordering hit ("Tue May 04 2032").
      const ordered = list.slice().sort((a, b) => String(sDay(a.period_start)).localeCompare(String(sDay(b.period_start))));
      for (let i = 1; i < ordered.length; i += 1) {
        const cur = ordered[i];
        const prev = ordered[i - 1];
        if (cur.beginning_balance != null) {
          if (prev.ending_balance != null
              && Math.abs(Number(cur.beginning_balance) - Number(prev.ending_balance)) > 0.05) {
            skipped.push({ id: cur.id, account, filename: cur.filename,
              reason: `its own opening balance ($${Number(cur.beginning_balance).toFixed(2)}) disagrees with `
                + `the previous statement's closing one ($${Number(prev.ending_balance).toFixed(2)}) — `
                + 'a statement may be missing between them' });
          }
          continue;
        }
        if (prev.ending_balance == null) {
          skipped.push({ id: cur.id, account, filename: cur.filename,
            reason: 'the previous statement has no closing balance to carry forward' });
          continue;
        }
        // A 0.00 closing balance on an account that never shows a non-zero one
        // means "this statement prints no balance", not "the account held
        // nothing". Every live PayPal statement is exactly that. Carrying it
        // forward would turn a null — which honestly reads as unprovable — into
        // a number, and the arithmetic would then "tie" at 0 + X − X = 0 for
        // any X. Refuse, and say why.
        const accountHasRealBalance = ordered.some((x) => x.ending_balance != null
          && Math.abs(Number(x.ending_balance)) > 0.05);
        if (Math.abs(Number(prev.ending_balance)) < 0.05 && !accountHasRealBalance) {
          skipped.push({ id: cur.id, account, filename: cur.filename,
            reason: 'every statement on this account closes at 0.00, which means the statement prints no '
              + 'balance rather than that the account was empty — carrying that forward would manufacture '
              + 'a tie that cannot fail' });
          continue;
        }
        // The one write. `IS NULL` in the WHERE makes it idempotent, and makes a
        // concurrent second run a no-op rather than a double-apply.
        const { rowCount } = await pool.query(
          `UPDATE bank_statements SET beginning_balance = $1
            WHERE id = $2 AND beginning_balance IS NULL`,
          [prev.ending_balance, cur.id]);
        if (rowCount) {
          filled.push({ id: cur.id, account, filename: cur.filename,
            beginning_balance: Number(prev.ending_balance),
            from_statement: prev.id, from_filename: prev.filename });
        }
      }
    }

    if (filled.length) {
      await audit(req.user, 'statement_beginning_backfilled', null, null,
        `Opening balance carried forward onto ${filled.length} statement(s) from the preceding one: `
        + filled.map((f) => `${f.filename} = ${f.beginning_balance}`).join('; ')
        + ' — no transaction was touched').catch(() => {});
    }
    res.json({ success: true, data: { filled, skipped, filled_count: filled.length } });
  } catch (err) {
    console.error('POST /api/statements/backfill-beginning-balance:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/months', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows } = await pool.query(`
      SELECT to_char(t.txn_date, 'YYYY-MM') AS month_key, s.account,
        COUNT(*) FILTER (WHERE t.direction = 'debit')::int AS debits,
        COUNT(*) FILTER (WHERE t.direction = 'debit' AND t.matched_expense_id IS NOT NULL)::int AS matched,
        COUNT(*) FILTER (WHERE t.direction = 'debit' AND t.dismissed)::int AS dismissed,
        COUNT(*) FILTER (WHERE t.direction = 'debit' AND t.matched_expense_id IS NULL AND t.dismissed = false)::int AS open_debits,
        COUNT(*) FILTER (WHERE t.direction = 'credit' AND t.matched_income_id IS NULL AND t.dismissed = false)::int AS open_credits
      FROM bank_transactions t
      JOIN bank_statements s ON s.id = t.statement_id AND s.status = 'ready'
      GROUP BY 1, 2 ORDER BY 1 DESC`);
    const { rows: recs } = await pool.query(`SELECT * FROM statement_months`).catch(() => ({ rows: [] }));
    const recOf = Object.fromEntries(recs.map((r) => [r.month_key, r]));
    const months = new Map();
    for (const r of rows) {
      const m = months.get(r.month_key) || {
        month_key: r.month_key, accounts: [], debits: 0, matched: 0,
        dismissed: 0, open_debits: 0, open_credits: 0,
      };
      m.accounts.push(r.account);
      for (const k of ['debits', 'matched', 'dismissed', 'open_debits', 'open_credits']) m[k] += r[k];
      months.set(r.month_key, m);
    }
    const data = [...months.values()].map((m) => ({
      ...m,
      coverage: m.debits > 0 ? Math.round(((m.matched + m.dismissed) / m.debits) * 100) : 100,
      reconciled_by: recOf[m.month_key]?.reconciled_by || null,
      reconciled_at: recOf[m.month_key]?.reconciled_at || null,
    })).sort((a, b) => b.month_key.localeCompare(a.month_key));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/months/:key([0-9]{4}-[0-9]{2})/reconcile', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const key = req.params.key;
    if (req.body.undo === true) {
      await pool.query(`DELETE FROM statement_months WHERE month_key = $1`, [key]);
      await audit(req.user, 'statement_month_reopened', null, null, `Month ${key} un-reconciled`);
      return res.json({ success: true });
    }
    await pool.query(`
      INSERT INTO statement_months (month_key, reconciled_by, reconciled_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (month_key) DO UPDATE SET reconciled_by = EXCLUDED.reconciled_by, reconciled_at = NOW()`,
      [key, req.user.name]);
    await audit(req.user, 'statement_month_reconciled', null, null, `Month ${key} marked reconciled`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:id(\\d+)', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: [st] } = await pool.query(`SELECT * FROM bank_statements WHERE id = $1`, [req.params.id]);
    if (!st) return res.status(404).json({ success: false, error: 'Statement not found' });
    // Freshness: invoices approved/paid AFTER upload (and every matcher
    // upgrade since) never touched this statement's open debits. Re-run
    // quietly on open — idempotent, only unmatched rows are considered.
    // Throttled per statement (10 min) and never concurrent, so repeated
    // opens can't stack matcher passes on the pool.
    if (st.status === 'ready' && !rematchInFlight
        && Date.now() - (rematchLast.get(st.id) || 0) > 10 * 60 * 1000) {
      rematchLast.set(st.id, Date.now());
      rematchInFlight = true;
      try { await runAutoMatch(st, req.user.name).catch(() => {}); }
      finally { rematchInFlight = false; }
    }
    const { rows: txns } = await pool.query(
      `SELECT * FROM bank_transactions WHERE statement_id = $1 ORDER BY txn_date, id`, [req.params.id]);
    res.json({ success: true, data: await enrichDetail(st, txns) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/statements/:id/file — the original uploaded statement (PDF/CSV),
// streamed inline from R2. Accepts ?token= (auth middleware reads it) so it
// works as a plain browser link / new tab.
// Add only the transactions a re-parse found that the statement doesn't already
// hold. Shared by both re-parse paths so CSV and PDF can never disagree about
// what "already present" means.
//
// Identity within a statement: date + amount + direction, then reference when
// both sides carry one, else description — the same shape insertRows uses
// across statements.
async function applyReparse(st, parsedRows) {
  const { rows: existing } = await pool.query(
    // `currency` is part of row identity (lib/reparse-diff.js). Omitting it here
    // makes every non-USD row read as USD, so a PayPal re-parse would insert a
    // duplicate for each one — the same doubling bug this comparison exists to
    // prevent. Any column in keyOf MUST be selected here.
    'SELECT txn_date, amount, direction, currency, reference, description FROM bank_transactions WHERE statement_id = $1',
    [st.id]);

  // Identity is date + amount + direction, compared by COUNT — see
  // lib/reparse-diff.js for why description must never be part of it.
  const { missing, onlyInDb } = diffReparseRows(existing, parsedRows);

  const result = missing.length
    ? await insertRows(st, missing)
    : { inserted: 0, dupSkipped: 0, ruleDismissed: 0 };

  // MATCH the rows we just created. Upload does this (runAutoMatch then
  // applyCategoryRules); re-parse did not, and that is why a backlog of
  // matchable rows existed at all.
  //
  // Measured: 114 of the 138 booked rows that have an unclaimed invoice
  // waiting sit on a re-parsed statement, and 137 of 138 had their invoice
  // approved and visible at upload time. The matcher never rejected them on
  // the evidence — it was never asked. Rows appeared from a re-parse, nothing
  // tried to match them, and they were booked instead.
  //
  // Only worth running when the re-parse actually added rows; a re-parse that
  // finds everything already present has nothing new to match.
  let matched = 0;
  let ruleBooked = 0;
  if (result.inserted > 0) {
    matched = (await runAutoMatch(st, 'reparse').catch(() => ({ matched: 0 }))).matched || 0;
    ruleBooked = await applyCategoryRules(st.id).catch(() => 0);
  }

  const { rows: [{ n }] } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM bank_transactions WHERE statement_id = $1', [st.id]);
  await pool.query('UPDATE bank_statements SET txn_count = $1 WHERE id = $2', [n, st.id]);

  return {
    parsed: parsedRows.length,
    added: result.inserted,
    already_present: parsedRows.length - missing.length,
    duplicate_of_other_statement: result.dupSkipped,
    only_in_database: onlyInDb.length,
    txn_count: n,
    auto_matched: matched,
    rule_booked: ruleBooked,
  };
}

// Background PDF re-parse. Writes its outcome into import_summary.reparse so the
// UI can report it after polling, and ALWAYS returns the statement to 'ready' —
// a failed re-parse must not leave a reconciled month stuck in 'parsing' or
// flipped to 'error', because the statement it already holds is still valid.
async function reparseInBackground(st, buffer, name) {
  let summary;
  try {
    const parsed = await parsePdfRows(st, buffer, name);
    if (parsed.error) throw new Error(parsed.error);
    if (!parsed.rows.length) throw new Error('The re-parse produced no transactions.');
    summary = { ...(await applyReparse(st, parsed.rows)), method: parsed.method, at: new Date().toISOString() };

    // Persist the balances a RECONCILING rules parse read off the statement.
    //
    // applyReparse is strictly additive and never touched these, so
    // beginning_balance stayed null on 5 of 6 BofA statements — the AI path
    // frequently missed the line, and no amount of re-parsing could repair it.
    // The consequence was quiet: the standalone balance proof and the
    // balance-standalone / no-balance flags simply could not run on those months,
    // so the strongest check we have was inert exactly where it was needed.
    //
    // Guarded on method === 'rules' because that result has already been verified
    // against the statement's own printed figures. An AI-path re-parse must never
    // overwrite a known-good balance with a guess.
    if (parsed.method === 'rules'
        && Number.isFinite(Number(parsed.beginningBalance))
        && Number.isFinite(Number(parsed.endingBalance))) {
      await pool.query(
        `UPDATE bank_statements SET beginning_balance = $1, ending_balance = $2 WHERE id = $3`,
        [parsed.beginningBalance, parsed.endingBalance, st.id]);
      summary.balances_written = true;
    }
  } catch (err) {
    summary = { error: err.message, at: new Date().toISOString() };
  }
  await pool.query(
    `UPDATE bank_statements
        SET status = 'ready',
            parse_started_at = NULL,
            import_summary = COALESCE(import_summary, '{}'::jsonb) || jsonb_build_object('reparse', $1::jsonb)
      WHERE id = $2`,
    [JSON.stringify(summary), st.id]).catch(() => {});
}

// POST /api/statements/:id/reparse
//
// Re-run the parser over the ORIGINAL uploaded file and add any transaction the
// first pass missed. For PDFs that's a real risk: parsing is an AI call, and a
// long statement can come back short — which is how a month reads 27/35 with a
// partly-filled coverage bar.
//
// STRICTLY ADDITIVE. It never deletes, never updates, and never re-inserts a row
// it already has:
//
//   • insertRows() dedupes across OTHER statements but deliberately not against
//     the statement being written (`bt.statement_id != $2`), because a normal
//     upload writes into a fresh row set. Calling it again for an existing
//     statement would therefore duplicate EVERY transaction. This pre-filters
//     against the statement's own rows first.
//   • Existing rows are left completely alone. They carry matched_expense_id,
//     bookings, dismissals and flags; re-creating them would strand ledger
//     entries and silently double-count the month.
//
// Rows present in the database but absent from the re-parse are reported, never
// removed — that's a parser disagreement for a human to look at, not a mandate
// to delete reconciled history.
router.post('/:id(\\d+)/reparse', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: [st] } = await pool.query('SELECT * FROM bank_statements WHERE id = $1', [req.params.id]);
    if (!st) return res.status(404).json({ success: false, error: 'Statement not found' });
    if (!st.r2_key) {
      return res.status(400).json({ success: false, error: 'The original file was never stored for this statement — re-upload it instead.' });
    }

    const { buffer } = await downloadFile(st.r2_key);
    if (!buffer || !buffer.length) {
      return res.status(400).json({ success: false, error: 'The stored file could not be read — re-upload it instead.' });
    }

    const name = st.filename || '';
    const isCsv = /\.csv$/i.test(name) || /\.csv$/i.test(st.r2_key || '');

    // A PDF re-parse is a Claude call over a whole statement — minutes, not
    // seconds. Doing it inside the request returned HTTP 524 (Cloudflare gives
    // up around 100s) even while the parse ran on happily behind it.
    //
    // Upload solves this by returning immediately and finishing in the
    // background; re-parse now does the same. CSV stays synchronous — it's a
    // deterministic local parse measured in milliseconds, and instant feedback
    // is better when it's free.
    if (!isCsv) {
      await pool.query(`UPDATE bank_statements SET status = 'parsing', parse_started_at = NOW() WHERE id = $1`, [st.id]);
      reparseInBackground(st, buffer, name).catch(() => {});
      return res.json({ success: true, data: { started: true, mode: 'background' } });
    }

    const parsed = parseStatementCSV(buffer.toString('utf8'), st.account);
    if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });
    const parsedRows = parsed.rows;
    if (!parsedRows.length) {
      return res.status(400).json({ success: false, error: 'The re-parse produced no transactions.' });
    }

    res.json({ success: true, data: { ...(await applyReparse(st, parsedRows)), mode: 'sync' } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Extra items ──────────────────────────────────────────────────────────────
//
// Rows the app holds that the statement itself does not support.
//
// Only possible because a deterministic parse can PROVE a statement's contents.
// Where a parse reconciles (opening + net = closing, and every section total
// matching its printed figure), it is ground truth and any surplus the app holds
// is wrong. Where it does NOT reconcile, this reports no opinion at all —
// deleting real transactions because a parser had a bad day is far worse than
// leaving duplicates.
//
// Motivating case: the July 2026 BofA statement charges 84 "External transfer fee
// - 3 Day" $1.00 debits and the app held 113 — 29 duplicates from the original AI
// import, each matched to its own ledger expense, overstating fees by $29 and
// undetected for months because nothing ever checked a statement against its own
// arithmetic.
// Raw audit: groups carry the actual bank_transaction rows (remove + keep), which
// the ledger view needs. auditStatementExtras() wraps this for the API, where only
// ids are useful.
async function auditStatementExtrasRaw(st) {
  const base = {
    id: st.id, account: st.account, filename: st.filename,
    period_start: st.period_start, period_end: st.period_end,
    held: null, expected: null, extraCount: 0, extraValue: 0, missingCount: 0,
    reconciles: false, reason: null, groups: [],
  };
  const { rows: dbRows } = await pool.query(
    // currency included for the same reason as in applyReparse: it is part of
    // keyOf, and leaving it out made all six PayPal statements report a permanent
    // 206-row "mismatch" that was purely this missing column.
    // match_method is load-bearing for the misfiled repair, not decoration: it
    // is how that path knows a booking was INVENTED from the descriptor rather
    // than being a real invoice, and therefore whether removing it is safe.
    // Omitting it left the column undefined, the unbook branch silently never
    // ran, and two entries survived their own bank rows.
    `SELECT id, txn_date, amount, direction, currency, description, payee_guess, created_at,
            matched_expense_id, matched_income_id, match_method, dismissed, flagged
       FROM bank_transactions WHERE statement_id = $1`, [st.id]);
  base.held = dbRows.length;

  if (st.account !== 'bofa' && st.account !== 'paypal') { base.reason = 'No layout rules for this account, so the statement cannot prove its own contents.'; return base; }
  if (!st.r2_key) { base.reason = 'The original file was never stored, so there is nothing to check against.'; return base; }
  if (/\.csv$/i.test(st.filename || '') || /\.csv$/i.test(st.r2_key)) {
    base.reason = 'CSV statement — the balance proof only applies to the PDF layout.'; return base;
  }

  let out;
  try {
    const { buffer } = await downloadFile(st.r2_key);
    out = await parseStatementPdfText(buffer, st.account);
  } catch (err) {
    base.reason = `Could not read the stored file: ${err.message}`;
    return base;
  }
  if (!out) { base.reason = 'The stored PDF did not parse as a recognised statement layout.'; return base; }
  if (!out.ok) { base.reason = `The parse did not reconcile (${out.verdict.reason}), so it cannot be used as ground truth.`; return base; }

  // parseStatementPdfText leaves payee_guess empty — the ingest fills it, and
  // this reads the parser directly. Filling it the SAME way here is not
  // cosmetic: the misfiled repair decides whether a row changed hands by
  // comparing payees, and against a blank every repair looked like a change of
  // vendor. The production probe caught it holding six rows, two of which would
  // have had a correct invoice released for no reason.
  out.rows = out.rows.map((r) => ({ ...r, payee_guess: r.payee_guess || bofaPayee(r.description) }));

  const found = findExtras(out.rows, dbRows);

  // Same parse, second question. findExtras compares COUNTS per
  // date+amount+direction+currency, so a row holding another payment's details
  // is invisible to it — the surplus and the shortfall cancel. Asking here costs
  // nothing: the PDF is already parsed and the rows are already loaded.
  const misfiled = findMisfiled(dbRows, out.rows);

  // Surplus and shortfall appearing TOGETHER means the rows were relabelled, not
  // duplicated — the same transaction filed under a different key on each side.
  // PayPal made this obvious: the app holds all 70 July rows as USD while the
  // statement says USD 54, AUD 4, CAD 4, EUR 2, GBP 4, MXN 2, because the AI
  // parse flattened every currency to USD. That produced 16 "extras" and 16
  // "missing" against a statement holding exactly as many rows as the app.
  //
  // Reporting that as surplus would be badly wrong, and acting on it would delete
  // 206 real transactions across the six PayPal statements. So the overlap is
  // named for what it is, and only the excess beyond it is called surplus.
  const mismatched = Math.min(found.extraCount, found.missingCount);
  return {
    ...base,
    expected: out.rows.length,
    reconciles: true,
    extraCount: found.extraCount,
    extraValue: found.extraValue,
    missingCount: found.missingCount,
    mismatched,
    surplus: found.extraCount - mismatched,
    groups: found.groups,
    misfiled,
  };
}

// API shape: ids and labels only.
async function auditStatementExtras(st) {
  const raw = await auditStatementExtrasRaw(st);
  return {
    ...raw,
    groups: (raw.groups || []).map((g) => ({
      txn_date: g.txn_date, amount: g.amount, direction: g.direction,
      expected: g.expected, held: g.held, extra: g.extra,
      description: (g.remove[0]?.description || '').slice(0, 120),
      payee_guess: g.remove[0]?.payee_guess || '',
      remove_ids: g.remove.map((r) => r.id),
      matched_expense_ids: g.remove.map((r) => r.matched_expense_id).filter(Boolean),
      booked_income_ids: g.remove.map((r) => r.matched_income_id).filter(Boolean),
    })),
    misfiled_count: (raw.misfiled?.repairs || []).length,
    misfiled_value: Math.round((raw.misfiled?.repairs || []).reduce((t, r) => t + Number(r.row.amount || 0), 0) * 100) / 100,
    misfiled_unclear: (raw.misfiled?.unclear || []).length,
  };
}

// Only ONE whole-portfolio audit may run at a time, process-wide.
//
// Each one downloads and re-parses every stored statement — 13 PDFs, thousands of
// pages of text extraction — inside a request handler. That is CPU-bound work
// that blocks the event loop, so concurrent audits starve everything else: on
// 2026-08-06 repeated calls wedged production with /health still answering (no DB)
// while every database-backed endpoint hung indefinitely. Same shape as the
// 2026-08-04 sweeps outage: expensive housekeeping must never run unbounded per
// request.
//
// Rejected rather than queued, because a queued audit just moves the pile-up.
let portfolioAuditInFlight = false;
const withPortfolioAudit = async (res, run) => {
  if (portfolioAuditInFlight) {
    return res.status(429).json({ success: false,
      error: 'An audit of every statement is already running. It re-parses all stored PDFs, so only one runs at a time — try again when it finishes.' });
  }
  portfolioAuditInFlight = true;
  try { return await run(); } finally { portfolioAuditInFlight = false; }
};

// GET /api/statements/extras — audit every statement. Read-only.
router.get('/extras', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    return await withPortfolioAudit(res, async () => {
    const { rows: stmts } = await pool.query(
      `SELECT * FROM bank_statements WHERE status = 'ready' ORDER BY period_start DESC NULLS LAST, id DESC`);
    const results = [];
    for (const st of stmts) results.push(await auditStatementExtras(st)); // sequential: keeps the pool free
    res.json({ success: true, data: {
      statements: results,
      total_extra: results.reduce((s, r) => s + r.extraCount, 0),
      total_value: Math.round(results.reduce((s, r) => s + r.extraValue, 0) * 100) / 100,
      checked: results.filter((r) => r.reconciles).length,
      unverifiable: results.filter((r) => !r.reconciles).length,
      // Rows holding another payment's details. Reported alongside the extras
      // rather than behind their own button: it is the same parse answering a
      // question the extras count structurally cannot, and a finding that only
      // appears when someone knows to look for it is one nobody looks for.
      total_misfiled: results.reduce((s, r) => s + (r.misfiled_count || 0), 0),
      misfiled_value: Math.round(results.reduce((s, r) => s + (r.misfiled_value || 0), 0) * 100) / 100,
    } });
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/statements/:id/extras — one statement, with group detail. Read-only.
router.get('/:id(\\d+)/extras', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: [st] } = await pool.query('SELECT * FROM bank_statements WHERE id = $1', [req.params.id]);
    if (!st) return res.status(404).json({ success: false, error: 'Statement not found' });
    res.json({ success: true, data: await auditStatementExtras(st) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Misfiled rows ────────────────────────────────────────────────────────────
//
// A row holding the WRONG PAYMENT'S details.
//
// The extras audit above cannot see these and never will: it compares COUNTS per
// date+amount+direction+currency, so one payment stored twice alongside a
// different payment of the same day and amount stored not at all is a surplus
// and a shortfall that cancel exactly. The month reconciles to the cent while
// the money is filed against a company that was never paid it.
//
// Same server-authoritative posture as /extras/remove: the stored PDF is
// re-parsed at the moment of the call and the client's opinion is not consulted.
async function auditMisfiled(st) {
  // Deliberately the SAME function the extras audit runs. Parsing the stored PDF
  // twice would be both slower and a second opinion about what the statement
  // says, and this repair rewrites live rows on the strength of that opinion.
  const raw = await auditStatementExtrasRaw(st);
  return {
    id: st.id, account: st.account, filename: st.filename,
    reconciles: raw.reconciles, reason: raw.reason,
    repairs: raw.misfiled?.repairs || [],
    unclear: raw.misfiled?.unclear || [],
  };
}

// The vendor a row names, for deciding whether a repair invalidates its match.
const misfiledPayee = (r) => displayBankPayee(r.payee_guess || '') || String(r.description || '').slice(0, 40);

// GET /api/statements/:id/misfiled — read-only.
router.get('/:id(\\d+)/misfiled', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: [st] } = await pool.query('SELECT * FROM bank_statements WHERE id = $1', [req.params.id]);
    if (!st) return res.status(404).json({ success: false, error: 'Statement not found' });
    const a = await auditMisfiled(st);
    res.json({ success: true, data: {
      ...a,
      repairs: a.repairs.map((r) => ({
        txn_id: r.row.id,
        txn_date: r.row.txn_date,
        amount: r.row.amount,
        direction: r.row.direction,
        duplicate_of_reference: r.duplicate_of_reference,
        currently_reads: String(r.row.description || '').slice(0, 140),
        currently_payee: misfiledPayee(r.row),
        should_read: String(r.should_be.description || '').slice(0, 140),
        should_payee: r.should_be.payee_guess || '',
        matched_expense_id: r.row.matched_expense_id,
        matched_income_id: r.row.matched_income_id,
        match_method: r.row.match_method,
        // A repair that changes WHO was paid invalidates whatever was matched or
        // booked against the old name; one that only corrects a confirmation
        // number does not.
        payee_changes: misfiledPayee(r.row).toLowerCase()
          !== (displayBankPayee(r.should_be.payee_guess || '') || '').toLowerCase(),
      })),
      unclear: a.unclear.map((u) => ({
        txn_id: u.row.id, txn_date: u.row.txn_date, amount: u.row.amount,
        reference: u.reference, reason: u.reason,
        reads: String(u.row.description || '').slice(0, 140),
      })),
    } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/statements/:id/misfiled/repair
//
// Rewrite each provably-misfiled row to the payment the statement actually
// charges. The row itself is correct in date, amount and direction — only its
// identity is wrong — so this is an UPDATE, never a delete-and-insert: the row
// keeps its id, and anything pointing at it stays pointing at it.
//
// Where the payee changes, the match is DROPPED rather than carried over. An
// invoice matched to this row was matched to the old name, and silently
// re-pointing a real invoice at a different company's payment is the exact
// false-record shape the whole matching surface exists to prevent. The invoice
// returns to the attach pool for a person to place.
//
// A row that was BOOKED (an entry we invented from the old descriptor) has that
// entry soft-deleted, guarded on entry_source so a real invoice can never be
// removed — the same guard /rematch and /unbook use.
router.post('/:id(\\d+)/misfiled/repair', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: [st] } = await pool.query('SELECT * FROM bank_statements WHERE id = $1', [req.params.id]);
    if (!st) return res.status(404).json({ success: false, error: 'Statement not found' });

    const a = await auditMisfiled(st);
    if (!a.reconciles) return res.status(400).json({ success: false, error: `Refusing to change anything: ${a.reason}` });
    if (!a.repairs.length) return res.json({ success: true, data: { repaired: 0, unmatched: 0, unbooked: 0, rows: [], unclear: a.unclear.length } });

    // Honour a caller's narrowing, never a caller's list: ids are used to SELECT
    // FROM what the statement already proved, so a client can repair one row
    // without being able to nominate a row the statement does not support.
    const only = Array.isArray(req.body?.txn_ids) ? req.body.txn_ids.map(Number).filter(Boolean) : null;
    const todo = only ? a.repairs.filter((r) => only.includes(r.row.id)) : a.repairs;

    // Refuse rather than skip. The unbook below is chosen by match_method, and
    // when that column was missing from the audit's SELECT the branch simply did
    // not fire: the repair reported success while two invented entries outlived
    // the bank rows that created them. A missing field must stop the write, not
    // quietly narrow it.
    const blind = todo.filter((r) => r.row.matched_expense_id && r.row.match_method === undefined);
    if (blind.length) {
      return res.status(500).json({ success: false,
        error: `Refusing to repair: ${blind.length} row(s) came back without match_method, so whether their booking is safe to remove cannot be determined.` });
    }

    const done = [];
    let unmatched = 0;
    let unbooked = 0;
    await client.query('BEGIN');
    for (const r of todo) {
      const oldPayee = misfiledPayee(r.row);
      const newPayee = displayBankPayee(r.should_be.payee_guess || '') || '';
      const payeeChanges = oldPayee.toLowerCase() !== newPayee.toLowerCase();

      if (payeeChanges && (r.row.matched_expense_id || r.row.matched_income_id)) {
        if (r.row.match_method === 'created' && r.row.matched_expense_id) {
          const del = await client.query(
            `UPDATE expenses SET is_deleted = true
              WHERE id = $1 AND COALESCE(entry_source, '') = 'bank_statement'`, [r.row.matched_expense_id]);
          unbooked += del.rowCount;
        }
        await client.query(
          `DELETE FROM bank_txn_invoice_links WHERE txn_id = $1`, [r.row.id]).catch(() => {});
        await client.query(
          `UPDATE bank_transactions
              SET matched_expense_id = NULL, matched_income_id = NULL, match_method = NULL
            WHERE id = $1`, [r.row.id]);
        unmatched++;
      }

      await client.query(
        `UPDATE bank_transactions
            SET description = $1, payee_guess = $2, reference = $3
          WHERE id = $4`,
        [r.should_be.description,
          String(r.should_be.payee_guess || '').slice(0, 200),
          refFromDescription(r.should_be.description),
          r.row.id]);

      done.push({ txn_id: r.row.id, from: oldPayee, to: newPayee, payee_changed: payeeChanges,
        amount: r.row.amount, txn_date: r.row.txn_date });
    }
    await client.query('COMMIT');

    await audit(req.user, 'statement_misfiled_repaired', null, null,
      `${String(st.account || '').toUpperCase()} statement "${st.filename}" (id ${st.id}): repaired ${done.length} row`
      + `${done.length === 1 ? '' : 's'} that held another payment's details — `
      + done.map((d) => `#${d.txn_id} ${d.from} → ${d.to}`).join('; ')
      + `. ${unmatched} lost a match because the payee changed; ${unbooked} invented booking${unbooked === 1 ? '' : 's'} removed.`);

    res.json({ success: true, data: { repaired: done.length, unmatched, unbooked, rows: done, unclear: a.unclear.length } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ── Ledger extras ────────────────────────────────────────────────────────────
//
// Does the LEDGER hold more entries than the statement supports?
//
// The bank side is now provably correct, which makes this answerable for the
// first time. A reconciling statement proves exactly how many debits of a given
// amount cleared on a given day — so if the ledger holds more entries matching
// that day and amount, the surplus are duplicate records, and no
// vendor-similarity heuristic is needed to say so.
//
// This is the test that worked on July by hand: the statement charges 84 `$1.00`
// "External transfer fee" debits (2 on 07/01, 4 on 07/02, 30 on 07/07 …) and the
// ledger held 113 — 29 duplicates on exactly three dates. `/api/flags`
// duplicate_invoices could not settle it: its "same vendor + amount + date" rule
// collapsed 256 legitimately-repeated fees into one group and claimed 615 surplus
// copies worth $90,306, because it has no way to know the bank really does charge
// 30 identical $1 fees in a day. The statement does know.
//
// Deliberately conservative, because the output accuses accounting records:
//   • Only statements whose parse RECONCILES are used. No ground truth, no opinion.
//   • Only (date, amount) pairs the statement actually charges are compared. An
//     unpaid invoice with no matching debit is not a duplicate, it's unpaid.
//   • Parents only — split children inherit the parent's amount and would
//     double-count the same logical spend.
//   • USD only — a foreign-currency entry doesn't compare to a USD debit without
//     conversion, and a false accusation is worse than a missed one.
//   • READ-ONLY. Nothing here deletes a ledger entry; that is a separate
//     decision, and deleting an expense changes the P&L.
// Proven debits across EVERY statement that can prove itself, unioned.
//
// The first version of this compared the ledger against ONE statement, which made
// any invoice paid by another route look like a duplicate: its top finding was a
// PayPal-paid invoice counted as surplus against a BofA statement. Only a union of
// all provable accounts can say "the banks charged this N times".
async function provenDebits() {
  const { rows: stmts } = await pool.query(
    "SELECT * FROM bank_statements WHERE status = 'ready' ORDER BY period_start");
  const charged = new Map();          // 'YYYY-MM-DD|amount|CUR' -> count
  const covered = [];                 // periods we can speak for
  const unprovable = [];
  for (const st of stmts) {
    if (!st.r2_key) { unprovable.push({ id: st.id, reason: 'no stored file' }); continue; }
    let out = null;
    try {
      const { buffer } = await downloadFile(st.r2_key);
      out = await parseStatementPdfText(buffer, st.account);
    } catch (err) { unprovable.push({ id: st.id, reason: err.message }); continue; }
    if (!out) { unprovable.push({ id: st.id, reason: 'no layout rules' }); continue; }
    if (!out.ok) { unprovable.push({ id: st.id, reason: out.verdict.reason }); continue; }
    covered.push({ id: st.id, account: st.account, from: isoDay(st.period_start), to: isoDay(st.period_end) });
    for (const r of out.rows) {
      if (r.direction !== 'debit') continue;
      const k = `${r.txn_date}|${Number(r.amount).toFixed(2)}|${String(r.currency || 'USD').toUpperCase()}`;
      charged.set(k, (charged.get(k) || 0) + 1);
    }
  }
  return { charged, covered, unprovable };
}

// Ledger entries the banks don't support — SAME-DAY duplicates only.
//
// Deliberately narrow. The counting argument is airtight only where the ledger
// date and the bank date agree exactly: banks settle 1-3 days after a payment is
// recorded, so any date tolerance makes "how many did the bank charge that day"
// ambiguous and turns this into guesswork against real accounting records. Same
// day + same amount + same currency is where it can be certain, which is exactly
// the recurring-charge case it was built for (July's 29 duplicated $1 fees).
//
// It will therefore MISS duplicates whose dates differ. That is the intended
// trade: a missed duplicate costs nothing, a false one gets a real expense deleted.
async function auditLedgerExtras() {
  const { charged, covered, unprovable } = await provenDebits();
  if (!charged.size) {
    return { groups: [], extraCount: 0, extraValue: 0, covered, unprovable,
      reason: 'No statement could prove what it charged.' };
  }
  const from = covered.map((c) => c.from).filter(Boolean).sort()[0];
  const to = covered.map((c) => c.to).filter(Boolean).sort().pop();

  // Family ROOTS with family_total: a bank debit settles a family, and a split
  // parent's own `amount` is only its slice, so comparing r.amount would both
  // miss real matches and invent surplus.
  const { rows: fams } = await pool.query(`${FAMILY_SQL}
      AND r.status = 'approved'
      AND COALESCE(r.payment_date, r.invoice_date) BETWEEN $1::date AND $2::date`,
    [from, to]);

  // Bucketed by day + amount + currency + PAYEE.
  //
  // Payee is not optional. Without it, three different companies invoiced $2,500
  // and paid on the same day land in one bucket and two get reported as
  // duplicates of each other — which is exactly what the first run did (Blanke
  // Touring, Campbell Sterling and a third vendor, three distinct invoices).
  // A duplicate is the SAME payee recorded twice; two vendors charging the same
  // amount on the same day is a coincidence, and a common one.
  //
  // The bank count is still per day+amount (bank descriptors don't reliably map
  // to ledger payees), so a payee is only flagged when IT ALONE holds more
  // entries than the banks charged in total for that day and amount — which
  // cannot be explained by any split of those debits between vendors.
  const held = new Map();
  for (const f of fams) {
    const day = isoDay(f.payment_date || f.invoice_date);
    const amountKey = `${day}|${Number(f.family_total).toFixed(2)}|${String(f.currency || 'USD').toUpperCase()}`;
    if (!charged.has(amountKey)) continue;   // the banks never charged this day+amount
    const payeeKey = `${amountKey}|${String(f.payee || '').trim().toLowerCase()}`;
    if (!held.has(payeeKey)) held.set(payeeKey, { amountKey, rows: [] });
    held.get(payeeKey).rows.push(f);
  }

  const groups = [];
  for (const [, { amountKey, rows }] of held) {
    const expected = charged.get(amountKey) || 0;
    if (rows.length <= expected) continue;
    const [date, amount, currency] = amountKey.split('|');
    const ordered = [...rows].sort((a, b) => (b.id || 0) - (a.id || 0)); // newest first
    groups.push({
      txn_date: date, amount: Number(amount), currency,
      bank_charged: expected, ledger_holds: rows.length, extra: rows.length - expected,
      payee: rows[0]?.payee || '',
      candidates: ordered.slice(0, rows.length - expected).map((f) => ({
        id: f.id, payee: f.payee, amount: Number(f.family_total), invoice_number: f.invoice_number,
        category: f.category, artist: f.artist, payment_status: f.payment_status,
        payment_method: f.payment_method,
      })),
      keep_ids: ordered.slice(rows.length - expected).map((f) => f.id),
    });
  }
  groups.sort((a, b) => b.extra - a.extra || String(a.txn_date).localeCompare(String(b.txn_date)));

  return {
    from, to, covered, unprovable,
    statement_debits: [...charged.values()].reduce((s, n) => s + n, 0),
    ledger_families_compared: [...held.values()].reduce((s, v) => s + v.rows.length, 0),
    groups,
    extraCount: groups.reduce((s, g) => s + g.extra, 0),
    extraValue: Math.round(groups.reduce((s, g) => s + g.extra * g.amount, 0) * 100) / 100,
    basis: 'same day + same amount + same currency + SAME PAYEE, and only where that one payee alone exceeds what the banks charged that day; duplicates dated differently, or split across payees, are not detected',
  };
}

// GET /api/statements/:id/extras/ledger — the LEDGER consequence of removing the
// extras. Read-only.
//
// Removing a phantom bank row only unmatches its ledger entry; it doesn't delete
// it. So the question that actually decides whether the books are overstated is:
// is the entry behind a deleted row a DUPLICATE of the entry behind a surviving
// row, or a distinct payment that merely looks identical?
//
// Answered by comparing the two sets within each group, never guessed. An entry
// is called a duplicate only when payee, amount AND normalised invoice number all
// agree with a surviving entry — the same normaliser the rest of the bookkeeping
// uses, so "#003" and "003" don't read as different invoices.
router.get('/:id(\\d+)/extras/ledger', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: [st] } = await pool.query('SELECT * FROM bank_statements WHERE id = $1', [req.params.id]);
    if (!st) return res.status(404).json({ success: false, error: 'Statement not found' });

    const audited = await auditStatementExtrasRaw(st);
    if (!audited.reconciles) return res.status(400).json({ success: false, error: audited.reason });

    const idsOf = (rows) => rows.map((r) => r.matched_expense_id).filter(Boolean);
    const allIds = [...new Set(audited.groups.flatMap((g) => [...idsOf(g.remove), ...idsOf(g.keep)]))];
    const byId = new Map();
    if (allIds.length) {
      const { rows: exps } = await pool.query(
        `SELECT id, payee, amount, invoice_number, category, artist, song, invoice_date,
                payment_status, payment_date, parent_id, is_deleted
           FROM expenses WHERE id = ANY($1::int[])`, [allIds]);
      exps.forEach((e) => byId.set(e.id, e));
    }

    const sig = (e) => e && [
      String(e.payee || '').trim().toLowerCase(),
      Number(e.amount).toFixed(2),
      normalizeInvoiceNum(e.invoice_number || ''),
    ].join('|');

    const groups = [];
    let dupCount = 0;
    let dupValue = 0;
    let distinctCount = 0;
    for (const g of audited.groups) {
      const keepExps = idsOf(g.keep).map((id) => byId.get(id)).filter(Boolean);
      const keepSigs = new Set(keepExps.map(sig));
      const candidates = idsOf(g.remove).map((id) => byId.get(id)).filter(Boolean).map((e) => {
        const duplicate = keepSigs.has(sig(e));
        if (duplicate) { dupCount++; dupValue += Math.abs(Number(e.amount) || 0); } else distinctCount++;
        return {
          id: e.id, payee: e.payee, amount: Number(e.amount), invoice_number: e.invoice_number,
          category: e.category, artist: e.artist, song: e.song,
          payment_status: e.payment_status, parent_id: e.parent_id, is_deleted: e.is_deleted,
          verdict: duplicate ? 'duplicate' : 'distinct',
        };
      });
      if (!candidates.length) continue;
      groups.push({
        txn_date: g.txn_date, amount: g.amount, direction: g.direction,
        expected: g.expected, held: g.held, extra: g.extra,
        keep_expense_ids: keepExps.map((e) => e.id),
        candidates,
      });
    }

    res.json({ success: true, data: {
      id: st.id, account: st.account, filename: st.filename,
      extra_rows: audited.extraCount,
      // A phantom bank row with no ledger entry behind it costs nothing to remove.
      rows_without_ledger_entry: audited.extraCount - groups.reduce((s, g) => s + g.candidates.length, 0),
      duplicate_entries: dupCount,
      duplicate_value: Math.round(dupValue * 100) / 100,
      distinct_entries: distinctCount,
      groups,
    } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/statements/:id/extras/remove — delete the surplus.
//
// Recomputes from the stored PDF every time and ignores any list the client
// sends: the only thing allowed to decide what gets deleted is the statement's
// own arithmetic, evaluated server-side at the moment of deletion.
router.post('/:id(\\d+)/extras/remove', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: [st] } = await pool.query('SELECT * FROM bank_statements WHERE id = $1', [req.params.id]);
    if (!st) return res.status(404).json({ success: false, error: 'Statement not found' });

    const audit0 = await auditStatementExtras(st);
    if (!audit0.reconciles) {
      return res.status(400).json({ success: false, error: `Refusing to remove anything: ${audit0.reason}` });
    }

    // A shortfall alongside the surplus means the two sides disagree about how
    // rows are LABELLED, not about how many exist — so "extra" isn't a duplicate,
    // it's the same transaction keyed differently. Deleting on that reading would
    // have destroyed 206 real PayPal transactions whose currencies the AI parse
    // had flattened to USD. Refuse and say so; re-parsing to correct the labels is
    // the fix, not deletion.
    if (audit0.missingCount > 0) {
      return res.status(400).json({ success: false,
        error: `Refusing to remove anything: this statement is also MISSING ${audit0.missingCount} row${audit0.missingCount === 1 ? '' : 's'} `
          + `that the statement charges, so the ${audit0.extraCount} apparent extras are rows recorded under different details `
          + `(commonly the wrong currency), not duplicates. Re-parse to correct them instead of deleting.` });
    }
    if (!audit0.extraCount) return res.json({ success: true, data: { removed: 0, ...audit0 } });

    // Booked income is a real record elsewhere (an artist_income row). Deleting
    // its bank row would strand that, so those are never touched here — they are
    // handed back for a human to unbook first.
    const all = audit0.groups.flatMap((g) => g.remove_ids.map((id) => ({
      id, income: g.booked_income_ids.length > 0,
    })));
    const blockedIds = audit0.groups.filter((g) => g.booked_income_ids.length).flatMap((g) => g.remove_ids);
    const removableIds = all.map((x) => x.id).filter((id) => !blockedIds.includes(id));

    const affectedExpenses = [...new Set(audit0.groups.flatMap((g) => g.matched_expense_ids))];

    let removed = 0;
    if (removableIds.length) {
      const del = await pool.query(
        'DELETE FROM bank_transactions WHERE statement_id = $1 AND id = ANY($2::int[])', [st.id, removableIds]);
      removed = del.rowCount;
    }

    const { rows: [{ n }] } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM bank_transactions WHERE statement_id = $1', [st.id]);
    await pool.query('UPDATE bank_statements SET txn_count = $1 WHERE id = $2', [n, st.id]);

    await audit(req.user, 'statement_extras_removed', null, null,
      `${String(st.account || '').toUpperCase()} statement "${st.filename}" (id ${st.id}): removed ${removed} `
      + `extra transaction${removed === 1 ? '' : 's'} worth ${audit0.extraValue} that the statement's own balances do not support `
      + `(it proves ${audit0.expected} rows; the app held ${audit0.held}). `
      + `${blockedIds.length} left in place because they carry booked income. `
      + `${affectedExpenses.length} ledger entr${affectedExpenses.length === 1 ? 'y' : 'ies'} lost a bank match and may themselves be duplicates: `
      + `${affectedExpenses.slice(0, 40).join(', ')}${affectedExpenses.length > 40 ? ' …' : ''}`);

    res.json({ success: true, data: {
      removed,
      value: audit0.extraValue,
      expected: audit0.expected,
      held_before: audit0.held,
      txn_count: n,
      blocked_booked_income: blockedIds.length,
      affected_expense_ids: affectedExpenses,
    } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


router.get('/:id(\\d+)/file', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: [st] } = await pool.query(`SELECT filename, r2_key FROM bank_statements WHERE id = $1`, [req.params.id]);
    if (!st) return res.status(404).json({ success: false, error: 'Statement not found' });
    if (!st.r2_key) return res.status(404).json({ success: false, error: 'No file stored — this statement was uploaded before file retention was added.' });
    const { buffer, contentType } = await downloadFile(st.r2_key);
    const name = (st.filename || 'statement').replace(/[^a-zA-Z0-9 ._-]/g, '_');
    const mime = /\.pdf$/i.test(name) ? 'application/pdf'
      : /\.csv$/i.test(name) ? 'text/csv; charset=utf-8'
      : contentType || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${name}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Re-run auto-match over every ready statement's open debits — the nightly
// freshness sweep (also callable after big ledger imports).
async function rematchAll(userName = 'auto-rematch') {
  if (rematchInFlight) return 0;
  rematchInFlight = true;
  try {
    const { rows: sts } = await pool.query(`SELECT * FROM bank_statements WHERE status = 'ready'`);
    let matched = 0;
    for (const st of sts) {
      matched += (await runAutoMatch(st, userName).catch(() => ({ matched: 0 }))).matched;
      rematchLast.set(st.id, Date.now());
    }
    return matched;
  } finally { rematchInFlight = false; }
}
router.rematchAll = rematchAll;

// ── The same pass, but it can tell you what it did ───────────────────────────
//
// `rematchAll` above returns a bare count and returns 0 when another pass holds
// the lock — which is indistinguishable from "ran and found nothing". For a
// nightly sweep logging to stdout that is fine. For a button someone pressed it
// is not: "0 matched" would be the answer both when there was nothing to find and
// when the run never happened.
//
// Its signature is also not mine to change — the nightly sweep
// (server/index.js:2410) and /reset-matching both treat the return as a number.
// So this sits beside it and shares runAutoMatch, which is the part that matters.
//
// PURELY ADDITIVE, by construction rather than by promise: runAutoMatch's own
// query selects `matched_expense_id IS NULL AND dismissed = false`, so a row that
// already has a match — auto, manual or booked — is never even considered. This
// is the difference between this and Reset matching, and it is the whole reason
// the button exists.
//
// Shares `rematchInFlight` with the nightly sweep and the per-statement freshness
// re-run, so pressing the button can never stack matcher passes on the pool. That
// is the shape of the 2026-08-04 outage: housekeeping running inside request
// handlers, unthrottled, until the pool starved.
async function runMatcherPass({ userName, statementId = null } = {}) {
  if (rematchInFlight) return { ran: false, statements: 0, scanned: 0, matched: 0, per_statement: [] };
  rematchInFlight = true;
  try {
    const { rows: sts } = statementId
      ? await pool.query(`SELECT * FROM bank_statements WHERE id = $1 AND status = 'ready'`, [statementId])
      : await pool.query(`SELECT * FROM bank_statements WHERE status = 'ready' ORDER BY period_start`);
    const per = [];
    let scanned = 0;
    let matched = 0;
    for (const st of sts) {
      // One statement failing must not abandon the rest — and the failure is
      // REPORTED per statement rather than swallowed into a smaller total,
      // because a silently short count reads as "nothing to find".
      const out = await runAutoMatch(st, userName)
        .then((r) => ({ ...r, error: null }))
        .catch((e) => ({ matched: 0, scanned: 0, error: e.message }));
      rematchLast.set(st.id, Date.now());
      scanned += out.scanned || 0;
      matched += out.matched || 0;
      per.push({
        id: st.id,
        account: st.account,
        period_start: st.period_start,
        scanned: out.scanned || 0,
        matched: out.matched || 0,
        ...(out.error ? { error: out.error } : {}),
      });
    }
    return { ran: true, statements: sts.length, scanned, matched, per_statement: per };
  } finally { rematchInFlight = false; }
}

// POST /api/statements/rematch-all — run the matcher again over what is still
// unmatched, WITHOUT clearing anything.
//
// The additive counterpart to /reset-matching. There was already an additive
// re-run, POST /:id/match, but only for ONE statement — and the page defaults to
// All statements, so on the view actually in use there was no way to ask the
// matcher to look again. The alternatives were waiting for the nightly sweep or
// pressing Reset, which clears every match including the manual ones.
//
// ?statement_id= scopes it, so the button can follow the page's selector.
router.post('/rematch-all', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const raw = req.query.statement_id ?? req.body?.statement_id;
    const statementId = raw === undefined || raw === null || raw === '' || raw === 'all'
      ? null : parseInt(raw, 10);
    if (statementId !== null && !Number.isFinite(statementId)) {
      return res.status(400).json({ success: false, error: 'statement_id must be a number, or omitted for every statement' });
    }

    const out = await runMatcherPass({ userName: req.user.name, statementId });
    if (!out.ran) {
      // 409, never a zero. The caller has to be able to say "try again in a
      // moment" instead of "the matcher found nothing".
      return res.status(409).json({
        success: false,
        error: 'A matcher pass is already running — the nightly sweep or another '
          + 'request has it. Nothing was changed; try again in a moment.',
      });
    }
    if (statementId !== null && !out.statements) {
      return res.status(404).json({ success: false, error: 'Statement not found, or not ready' });
    }
    await audit(req.user, 'statement_rematch_all', null, null,
      `Matcher re-run on demand${statementId ? ` (statement #${statementId})` : ' (every ready statement)'}: `
      + `${out.matched} of ${out.scanned} unmatched debits matched across ${out.statements} statement(s). `
      + 'Additive — no existing match was cleared.');
    res.json({ success: true, data: out });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/statements/reset-matching — clear every AUTO match and re-run
// the matcher from scratch with the current evidence (vendor links,
// aliases, FX faces, rejections). Human decisions are sacred: manual
// matches, created bookings, booked income, and dismissals are untouched.
router.post('/reset-matching', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    // MANUAL matches are cleared too (John's call, 2026-08-06).
    //
    // They used to be exempt, and that exemption hid real damage: manual matching
    // bypassed the date sanity the auto-matcher always applied, so every inverted
    // match found — a debit that left the bank up to 208 days BEFORE its invoice
    // existed, including $10,000 — was manual. Re-deriving them under the current
    // guards is the point of the reset.
    //
    // Never cleared, because clearing them destroys or strands real records:
    //   • match_method 'created' / 'created-income' — the ledger entry or income
    //     row was CREATED from this debit; unlinking orphans it.
    //   • anything carrying matched_income_id, for the same reason.
    //   • dismissals, which hold no match at all.
    //
    // Some manual matches exist precisely BECAUSE the matcher can't derive them
    // (bank descriptors that share nothing with a ledger payee). Those will not
    // come back, so the response reports how many stayed open rather than letting
    // the loss pass silently.
    const { rows: target } = await pool.query(`
      SELECT id, match_method FROM bank_transactions
       WHERE (match_method LIKE 'auto%' OR match_method = 'manual')
         AND matched_income_id IS NULL`);
    const ids = target.map((r) => r.id);
    const manualIds = target.filter((r) => r.match_method === 'manual').map((r) => r.id);

    let cleared = 0;
    if (ids.length) {
      const { rowCount } = await pool.query(`
        UPDATE bank_transactions
           SET matched_expense_id = NULL, match_method = NULL, match_score = NULL,
               matched_by = NULL, matched_at = NULL
         WHERE id = ANY($1::int[])`, [ids]);
      cleared = rowCount;
    }

    const rematched = await rematchAll(req.user.name);

    const stillOpen = async (list) => {
      if (!list.length) return 0;
      const { rows: [c] } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM bank_transactions WHERE id = ANY($1::int[]) AND matched_expense_id IS NULL',
        [list]);
      return c.n;
    };
    const unresolved = await stillOpen(ids);
    const manualUnresolved = await stillOpen(manualIds);

    await audit(req.user, 'statement_matching_reset', null, null,
      `Matching reset: ${cleared} matches cleared (${manualIds.length} of them manual), ${rematched} re-matched with current evidence; `
      + `${unresolved} left open, ${manualUnresolved} of which were previously matched by hand. `
      + `Booked entries, booked income and dismissals untouched.`);

    res.json({ success: true, data: {
      cleared,
      manual_cleared: manualIds.length,
      rematched,
      still_open: unresolved,
      manual_not_recovered: manualUnresolved,
    } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/:id(\\d+)', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    // The txns cascade away with the statement — soft-delete the ledger
    // entries that were CREATED from them first, or re-uploading the
    // statement and re-booking would record every one of them twice.
    const { rows: createdRows } = await pool.query(
      `SELECT DISTINCT matched_expense_id AS id FROM bank_transactions
        WHERE statement_id = $1 AND match_method = 'created' AND matched_expense_id IS NOT NULL`,
      [req.params.id]);
    const createdIds = createdRows.map((r) => r.id);
    const { rows: [st] } = await pool.query(`DELETE FROM bank_statements WHERE id = $1 RETURNING *`, [req.params.id]);
    if (!st) return res.status(404).json({ success: false, error: 'Statement not found' });
    let entriesRemoved = 0;
    if (createdIds.length) {
      const { rowCount } = await pool.query(
        `UPDATE expenses SET deleted = true, deleted_by = $1, deleted_at = NOW()
          WHERE (id = ANY($2) OR parent_id = ANY($2)) AND entry_source = 'bank_statement'
            AND (deleted = false OR deleted IS NULL)`,
        [req.user.name, createdIds]);
      entriesRemoved = rowCount;
    }
    await audit(req.user, 'statement_deleted', null, null,
      `${st.account.toUpperCase()} statement "${st.filename}" removed${entriesRemoved ? ` (+${entriesRemoved} booked entr${entriesRemoved === 1 ? 'y' : 'ies'} it created — soft-deleted, restorable from the archive)` : ''}`);
    res.json({ success: true, data: { entries_removed: entriesRemoved } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Auto-match ───────────────────────────────────────────────────────────────

// Core auto-matcher, shared by the match endpoint and the background PDF
// pipeline. `userName` is stamped as matched_by on every auto match.
// opts.dryRun     — decide, record WHY, write nothing.
// opts.includeBooked — also consider rows that already hold an invented booking.
//
// Both exist to answer "why didn't this match", which nothing could say before.
// The reason is collected from the loop's OWN variables at the point the decision
// is made, rather than re-derived by a second function: a parallel
// implementation of this scorer would drift, and a wrong explanation of a
// matching decision is worse than none — it sends someone to fix the wrong thing.
//
// includeBooked matters more than it looks. This query has always required
// `matched_expense_id IS NULL`, so the moment a row is booked — by
// applyCategoryRules at upload or by a person — the matcher is finished with it
// FOREVER. 1,493 rows are in that state and the rematch sweep, which needs an
// amount equal to the cent, is their only path back. That is why it offers 35
// pairs out of a 498 × 1,493 pool.
async function runAutoMatch(st, userName, opts = {}) {
    // includeBooked FORCES dryRun. A booked row already holds
    // matched_expense_id pointing at an entry the app invented; writing a new
    // match over it would leave that entry alive with nothing behind it —
    // stranded spend that still counts. Displacing it correctly is what
    // /rematch does, and stage 2 is where that lands. Until then, considering
    // booked rows is a read-only act.
    const dryRun = opts.dryRun === true || opts.includeBooked === true;
    const { rows: txns } = await pool.query(
      `SELECT * FROM bank_transactions
        WHERE statement_id = $1 AND direction = 'debit'
          AND dismissed = false
          AND (matched_expense_id IS NULL
               ${opts.includeBooked ? "OR match_method = 'created'" : ''})
        ORDER BY txn_date, id`, [st.id]);

    // Candidate window: paid rows near the statement period, plus any unpaid
    // approved row (a bank debit can settle an old invoice).
    //
    // Never an entry created from a bank line. This is where the two known bad
    // matches came from — #5758 ($1.00, auto-learned) and #4249 ($0.01,
    // auto-ref) — because a booked entry carries the vendor's name and a real
    // amount, so it looks exactly like an invoice to every tier of the scorer.
    // It just has no document behind it and never will.
    const { rows: fams } = await pool.query(
      `${FAMILY_SQL} AND COALESCE(r.entry_source, '') <> 'bank_statement'
       AND NOT ${UNDOCUMENTED_ADDED_SQL('r')}
          AND (r.payment_status IS DISTINCT FROM 'Paid'
          OR r.payment_date BETWEEN $1::date - 45 AND $2::date + 10)`,
      [st.period_start, st.period_end]);

    // Family capacity across ALL statements: total already-matched debit
    // dollars per root. A family accepts debits until its total is covered
    // (installments), never beyond.
    const claims = await loadClaimedSums();
    const matchCtx = await loadMatchContext();
    const rejections = await loadRejections();

    // Declared groups, loaded ONCE for the whole pass.
    //
    // Inside the loop this was one query per unmatched debit — 700 on a busy
    // statement, from a request handler. That is the exact shape of the
    // 2026-08-04 outage: unthrottled housekeeping queries inside a request
    // starving the pg pool.
    const groupKeys = [...new Set(fams.map((f) => f.settlement_group).filter(Boolean))];
    const settlementGroups = groupKeys.length ? await groupsByKeys(pool, groupKeys) : new Map();

    const dayDiff = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);
    let matched = 0;
    // One entry per row the matcher declined, in the matcher's own words.
    const declined = [];
    const noInvoiceIds = await loadNoInvoiceRowIds();

    for (const t of txns) {
      const amounts = [Number(t.amount)];
      if (st.account === 'paypal' && t.fee) amounts.push(Number(t.amount) - Number(t.fee)); // net fallback

      const dateOk = (f) => {
        if (f.payment_status === 'Paid') {
          // Banks settle 1-3 business days after the ledger's paid date —
          // that's up to 5 calendar days over a weekend, 7 with a holiday.
          return f.payment_date && dayDiff(f.payment_date, t.txn_date) <= 7;
        }
        // Unpaid: the debit shouldn't predate the invoice by more than a few days
        return !f.invoice_date || new Date(t.txn_date) >= new Date(new Date(f.invoice_date) - 5 * 86400000);
      };
      // FX-exact tier (proof-grade): the wire descriptor names the foreign
      // face value ("FX:GBP 100.00 1.3745") and exactly one family in that
      // currency totals exactly that, with identity-backed name evidence
      // (link / alias / email / reference). The same-currency gate below
      // can never see these — the debit settles in USD.
      const face = fxFaceOf(t);
      if (face && !isInternal(t.description)) {
        const fxCands = fams.filter((f) =>
          (f.currency || 'USD').toUpperCase() === face.currency
          && Math.abs(Number(f.family_total) - face.amount) < 0.01
          && claimedOf(claims, f.id) === 0
          && methodCompatible(st.account, f.payment_method)
          && dateOk(f)
          && !isRejected(rejections, t, f.id));
        const withId = fxCands
          .map((f) => ({ f, vm: nameEvidence(matchCtx, t, f) }))
          .filter((x) => x.vm.match && x.vm.score >= 0.95);
        if (withId.length === 1) {
          // The SECOND write in this loop, and it needs the dry-run guard as
          // much as the one at the bottom — a "read-only" pass that writes is
          // worse than no read-only pass, because it is trusted.
          if (!dryRun) {
            await pool.query(
              `UPDATE bank_transactions SET matched_expense_id = $1, match_method = 'auto-fx', match_score = $2,
                 matched_by = $3, matched_at = NOW() WHERE id = $4`,
              [withId[0].f.id, withId[0].vm.score, userName, t.id]);
          }
          // Mark fully covered in the family's own units so no later debit claims it.
          claims.set(withId[0].f.id, { total: Number(withId[0].f.family_total), n: 1 });
          matched++;
          if (dryRun) {
            declined.push({ txn_id: t.id, amount: Number(t.amount), payee: t.payee_guess || null,
              reason: 'would-match', method: 'auto-fx', expense_id: withId[0].f.id });
          }
          continue;
        }
      }

      const base = fams.filter((f) =>
        capacityOk(f, amounts[0], claims)
        && methodCompatible(st.account, f.payment_method)
        && (f.currency || 'USD').toUpperCase() === (t.currency || 'USD').toUpperCase()
        && dateOk(f)
        && !isRejected(rejections, t, f.id));

      const exact = base.filter((f) => amounts.some((a) => Math.abs(Number(f.family_total) - a) < 0.01));
      // Fee-tolerant tier: within max($35, 1%) — the debit sits a wire or
      // processing fee above the invoice. Name evidence is REQUIRED here.
      const tolerant = base.filter((f) =>
        !exact.includes(f)
        && amounts.some((a) => Math.abs(Number(f.family_total) - a) <= feeTolerance(a)));

      let pick = null;
      let method = null;
      let score = null;
      if (isInternal(t.description)) continue; // never match internal movement
      const namesDisagree = (f, vm) => namesDisagreeFor(t, f, vm);
      if (exact.length === 1) {
        const vm = nameEvidence(matchCtx, t, exact[0]);
        // Amount-only matches (no name evidence) need a payee to hang the
        // claim on — a nameless row exact-matching one invoice by amount is
        // how a currency conversion swallowed a real invoice.
        // Date is soft evidence too: a nameless debit exact-matching a
        // single invoice paid/scheduled within 3 days of the bank date is
        // credible even without a payee.
        const ev = evidenceDate(exact[0]);
        const dateClose = ev && dayDiff(ev, t.txn_date) <= 3;
        // ── Narrow override of the name veto ──────────────────────────────
        // Bank descriptors legitimately share nothing with a clean ledger
        // payee: "AMERICAN EXPRESS DES:ACH PMT ID:W8…" vs "Tyler Henry" scores
        // near zero, and the descriptor's ID: token is the card issuer's
        // payment reference, not our invoice number. So nameEvidence finds
        // nothing, the veto fires, and a correct pair is refused with no other
        // candidate that could explain it.
        //
        // Three conditions, all required, and together about as strong as
        // circumstantial evidence gets:
        //   • exactly ONE candidate matches the amount to the cent (we're
        //     inside the exact.length === 1 branch)
        //   • its paid/scheduled date is within a DAY of the bank settle
        //     (tighter than the 3-day `dateClose` used elsewhere)
        //   • nothing else has claimed it
        //
        // The veto still stands whenever any of those fails — it is what stops
        // one vendor claiming another's invoice (the 'stolen invoice' flag),
        // and this carve-out cannot fire when two invoices share the amount.
        //
        // Recorded as its own match_method so these are auditable and can be
        // reviewed or reverted as a group, rather than hiding among the
        // stronger tiers.
        const sameDay = ev && dayDiff(ev, t.txn_date) <= 1;
        const soleExactSameDay = !!sameDay && claimedOf(claims, exact[0].id) === 0;
        const vetoed = namesDisagree(exact[0], vm);

        // Amount-only evidence against an UNPAID invoice is the weakest pairing
        // this matcher can produce, and it used to be unbounded in time.
        //
        // A unique exact amount is real evidence, but nothing ties it to THIS
        // invoice, and an unpaid invoice has no payment date to corroborate
        // against — only a due date. Left open-ended, any later debit of the
        // same amount could claim any old unpaid invoice, and common amounts
        // ($350, $500, $1,000) recur constantly. That is how a debit ends up
        // against an invoice it could not have paid.
        //
        // So amount-only claims on an unpaid invoice must land near the date the
        // ledger expected the money to move. Beyond that the row is left open
        // for a human instead of guessed at — an unmatched debit is a visible
        // question, a wrong match is an invisible false payment record.
        //
        // Name-backed tiers are deliberately unaffected: a genuinely late
        // payment WITH name, alias, reference or learned evidence still matches
        // at any distance, which is the legitimate "this debit settles an old
        // invoice" case.
        const UNPAID_AMOUNT_ONLY_DAYS = 30;
        const anchor = exact[0].scheduled_payment_date || exact[0].invoice_date;
        const amountOnlyOnUnpaid = !vm.match && exact[0].payment_status !== 'Paid';
        const tooFarForAmountOnly = amountOnlyOnUnpaid
          && (!anchor || dayDiff(anchor, t.txn_date) > UNPAID_AMOUNT_ONLY_DAYS);

        if ((vm.match || (t.payee_guess || '').trim() || dateClose)
            && (!vetoed || soleExactSameDay)
            && !tooFarForAmountOnly) {
          pick = exact[0];
          method = vm.match ? methodOf(vm)
            : (vetoed && soleExactSameDay) ? 'auto-sameday'
            : (t.payee_guess || '').trim() ? 'auto-amount' : 'auto-date';
          score = vm.score;
        }
      } else if (exact.length > 1) {
        const scored = exact
          .map((f) => ({ f, vm: nameEvidence(matchCtx, t, f) }))
          .filter((x) => x.vm.match && x.vm.score >= 0.6)
          .sort((a, b) => b.vm.score - a.vm.score);
        if (scored.length && (scored.length === 1 || scored[0].vm.score > scored[1].vm.score + 0.05)) {
          pick = scored[0].f;
          method = methodOf(scored[0].vm);
          score = scored[0].vm.score;
        }
        // No name winner — fall back to date as soft evidence: take the
        // candidate paid/scheduled closest to the bank date when it's within
        // 3 days and the runner-up is clearly farther (3+ days behind).
        // Same veto: a candidate whose name flatly disagrees is out.
        if (!pick && (t.payee_guess || '').trim()) {
          const dated = exact
            .filter((f) => evidenceDate(f) && !namesDisagree(f, nameEvidence(matchCtx, t, f)))
            .map((f) => ({ f, dd: dayDiff(evidenceDate(f), t.txn_date) }))
            .sort((a, b) => a.dd - b.dd);
          if (dated.length && dated[0].dd <= 3 && (dated.length === 1 || dated[1].dd >= dated[0].dd + 3)) {
            pick = dated[0].f;
            method = 'auto-date';
            score = null;
          }
        }
      }
      if (!pick && tolerant.length) {
        const scored = tolerant
          .map((f) => ({ f, vm: nameEvidence(matchCtx, t, f) }))
          .filter((x) => x.vm.match && x.vm.score >= 0.6)
          .sort((a, b) => b.vm.score - a.vm.score);
        if (scored.length && (scored.length === 1 || scored[0].vm.score > scored[1].vm.score + 0.05)) {
          pick = scored[0].f;
          method = 'auto-fee';
          score = scored[0].vm.score;
        }
      }

      // ── The invoice is in another currency ────────────────────────────────
      //
      // Everything above compares FACE amounts and `base` keeps only candidates
      // whose currency equals the row's, so a EUR invoice was invisible to this
      // matcher: EUR 1,000 is never USD 1,183.60. PINK PANTHERS B.V. is 23 EUR
      // invoices against 12 USD debits, every one of them matched by hand.
      //
      // Converted through usdOf and compared on the band, with the SAME evidence
      // the weak tiers demand — name agreement, the date window, capacity,
      // rejections — plus one more that matters here specifically:
      //
      //   EXACTLY ONE candidate may sit inside the band.
      //
      // That vendor has many interchangeable EUR 1,000 invoices which all
      // convert to about the same figure, so picking among them by date would
      // mark the wrong invoice NUMBER settled — a false record no downstream
      // check contradicts. Two or more, and the row falls through to
      // /rematch-candidates, where a person decides.
      if (!pick) {
        const txnUsd = Math.abs(usdOf(t.amount, t.currency));
        const cross = fams.filter((f) => {
          if ((f.currency || 'USD').toUpperCase() === (t.currency || 'USD').toUpperCase()) return false;
          if (!methodCompatible(st.account, f.payment_method)) return false;
          if (!dateOk(f)) return false;
          if (isRejected(rejections, t, f.id)) return false;
          const famUsd = usdOf(f.family_total, f.currency, f.fx_rate_to_usd);
          if (!fxAgrees(txnUsd, famUsd)) return false;
          // Capacity IN USD. capacityOk compares face values — $1,180 against a
          // €1,000 total — so it refuses every cross-currency pair by unit
          // mismatch alone, which is the same category error as summing
          // amount_usd. Converted, the question is the real one: would this
          // payment overfill the invoice?
          const claimedUsd = usdOf(claimedOf(claims, f.id), f.currency, f.fx_rate_to_usd);
          return claimedUsd + txnUsd <= famUsd * (1 + FX_BAND) + 0.01;
        });
        if (cross.length === 1) {
          const vm = nameEvidence(matchCtx, t, cross[0]);
          // Name evidence is REQUIRED. A band is weaker than a cent, so the
          // pairing has to be carried by identity rather than by amount — and
          // the veto that stops one vendor claiming another's invoice applies
          // exactly as it does to every other weak tier.
          if (vm.match && !namesDisagree(cross[0], vm)) {
            pick = cross[0];
            method = 'auto-fx-band';
            score = vm.score;
          }
        }
      }

      // ── SEVERAL INVOICES, ONE PAYMENT — a group somebody marked ────────────
      //
      // John: "when 2 invoices are sent in one payment, how can I make note of
      // this when uploading their invoices so it's an easy match when statements
      // are uploaded?" Every tier above is 1:1, so a vendor paid for two
      // invoices in a single transfer matched NOTHING: each invoice is smaller
      // than the payment. 465 same-payee-same-date groups of 2+ invoices are
      // sitting in the ledger unconnected.
      //
      // This tier acts only on a group a PERSON declared (expenses.settlement_group,
      // written by /bk/settlement-groups). Guessing which invoices add up to a
      // payment is the proposal below, not this — a wrong guess here marks the
      // wrong invoice NUMBERS settled, and nothing downstream contradicts it.
      //
      // It sits AFTER every existing tier, so nothing that matches today matches
      // differently. And it settles through settleTxnWithInvoices rather than
      // writing matched_expense_id, which is what carries the four /attach
      // guards and the link rows.
      if (!pick && settlementGroups.size) {
        const groups = settlementGroups;
        const txnUsd = Math.abs(usdOf(t.amount, t.currency));
        const settleable = [];
        for (const [key, members] of groups) {
          // AUTHORITATIVE membership, not "the members inside the window". A
          // group summed from the candidates that happened to be in `fams`
          // would be a SUBSET claiming a payment sized for the whole group.
          const inPool = members.map((m) => fams.find((f) => f.id === m.id));
          if (inPool.some((f) => !f)) continue;          // a member is out of window / not a candidate
          if (inPool.some((f) => !methodCompatible(st.account, f.payment_method))) continue;
          if (inPool.some((f) => !dateOk(f))) continue;
          if (inPool.some((f) => isRejected(rejections, t, f.id))) continue;
          // Nothing in the group may already be carrying money. A group settles
          // the WHOLE of every member, so a part-paid member means this is not
          // the payment the group describes.
          if (inPool.some((f) => claimedOf(claims, f.id) !== 0)) continue;
          // Round ONCE, at the end: summing usdOf per member and comparing to a
          // rounded total is how a tie-out loses exactly a cent.
          const sumUsd = members.reduce((n, m) => n + usdOf(m.family_total, m.currency, m.fx_rate_to_usd), 0);
          if (Math.abs(sumUsd - txnUsd) > 0.01) continue;
          // Name evidence is REQUIRED, and the veto applies. The amount is
          // exact, but an exact amount is not identity — two vendors can be owed
          // the same money, and namesDisagree is what stops one claiming the
          // other's invoices. Checked on EVERY member: a group is one vendor by
          // construction, so a single disagreement condemns the group.
          const vms = inPool.map((f) => ({ f, vm: nameEvidence(matchCtx, t, f) }));
          if (!vms.some((x) => x.vm.match)) continue;
          if (vms.some((x) => namesDisagree(x.f, x.vm))) continue;
          settleable.push({ key, members });
        }
        // Two groups both totalling the line exactly is the same "refusing to
        // guess which one" rule the 1:1 exact tier applies, and lib/split-
        // breakdown.js before it. Left for a person, with the reason said.
        if (settleable.length > 1) {
          declined.push({
            txn_id: t.id, amount: Number(t.amount), payee: t.payee_guess || null,
            reason: 'ambiguous-group',
            groups: settleable.map((s) => s.key),
          });
          continue;
        }
        if (settleable.length === 1) {
          const { key, members } = settleable[0];
          const ids = members.map((m) => m.id);
          if (dryRun) {
            declined.push({ txn_id: t.id, amount: Number(t.amount), reason: 'would-match',
              method: 'group', expense_id: ids[0], group: key, linked: ids });
            matched++;
          } else {
            const client = await pool.connect();
            let out;
            try {
              out = await settleTxnWithInvoices(client, t, ids, {
                // 100, the same score /attach writes for this same action — a
                // person declared the group and the total is exact to the cent,
                // so the pairing is not carried by a fuzzy name score.
                userName, method: 'group',
                note: `Settled as a marked payment group (${key}): ${ids.length} invoices totalling the payment exactly`,
              });
            } finally { client.release(); }
            if (!out.ok) {
              // A guard refused it — say WHICH, in the guard's own words. This
              // is the reason the matcher goes through the shared settle rather
              // than writing the column: the refusals are the point.
              declined.push({ txn_id: t.id, amount: Number(t.amount), payee: t.payee_guess || null,
                reason: 'group-refused', group: key, detail: out.error });
              continue;
            }
            // EVERY member is credited, not just the primary. Miss this and the
            // next bank line can settle an invoice this payment already covered
            // — the double-claim the claims map exists to prevent.
            for (const m of members) {
              const prev = claims.get(m.id) || { total: 0, n: 0 };
              claims.set(m.id, { total: prev.total + Number(m.family_total), n: prev.n + 1 });
            }
            matched++;
            continue;
          }
          continue;
        }
      }
      if (pick) {
        if (!dryRun) {
          await pool.query(
            `UPDATE bank_transactions SET matched_expense_id = $1, match_method = $2, match_score = $3,
               matched_by = $4, matched_at = NOW() WHERE id = $5`,
            [pick.id, method, score, userName, t.id]);
        }
        const prev = claims.get(pick.id) || { total: 0, n: 0 };
        claims.set(pick.id, { total: prev.total + Number(t.amount), n: prev.n + 1 });
        matched++;
        if (dryRun) declined.push({ txn_id: t.id, amount: Number(t.amount), reason: 'would-match', method, expense_id: pick.id });
        continue;
      }

      // ── WHY NOT ────────────────────────────────────────────────────────────
      //
      // Read off the sets this iteration actually built, in the order that makes
      // the answer actionable: the cheapest thing a person could do about it
      // first. "No invoice exists for this vendor" and "the amount doesn't line
      // up" are different jobs, and lumping them into "unmatched" is why 731
      // rows read as one undifferentiated pile.
      const vendorFams = fams.filter((f) => nameEvidence(matchCtx, t, f).match);
      const nameless = !String(t.payee_guess || '').trim()
        || /^(paypal|general payment|online transfer|chk ?\d*|transfer|wire type|checkcard|purchase)\b/i
          .test(String(t.payee_guess || '').trim());
      let reason;
      if (noInvoiceIds.has(t.id)) reason = 'no-invoice-rule';
      else if (exact.length > 1) reason = 'ambiguous';
      else if (exact.length === 1) {
        // A single exact-amount candidate that still didn't take: the loop
        // refused it, and the veto is the interesting case because it is
        // deliberate rather than a gap.
        reason = namesDisagree(exact[0], nameEvidence(matchCtx, t, exact[0]))
          ? 'name-veto'
          : (dateOk(exact[0]) ? 'refused-weak-evidence' : 'outside-window');
      } else if (vendorFams.length) reason = 'amount-no-match';
      else if (nameless) reason = 'nameless-descriptor';
      else reason = 'no-candidate';
      declined.push({
        txn_id: t.id,
        amount: Number(t.amount),
        payee: t.payee_guess || null,
        reason,
        vendor_candidates: vendorFams.length,
        exact_candidates: exact.length,
      });
    }
    // The tally is what the upload summary stores; the rows are what a queue
    // needs. Both from the same list, so a count can never disagree with the
    // rows behind it.
    const reasons = {};
    for (const d of declined) reasons[d.reason] = (reasons[d.reason] || 0) + 1;
    return { matched, scanned: txns.length, reasons, declined };
}

// GET /api/statements/:id/why — why is each row on this statement unmatched?
//
// The question nothing could answer before. "731 left to match" is one
// undifferentiated pile, and the jobs behind it are completely different: an
// invoice that exists but sits a fee away from the payment, a vendor who has sent
// nothing, a descriptor naming no counterparty, a deliberate name veto. Told
// apart, a fresh statement becomes a short ordered worklist instead of a wall.
//
// Runs the REAL matcher in dry-run, so the explanation is the scorer's own
// verdict rather than a second implementation's guess about it. Writes nothing:
// both writes inside that loop are guarded, asserted by the fixture.
//
// ?include_booked=1 also considers rows already carrying an invented booking —
// 1,493 of them, invisible to the matcher since the day they were booked.
router.get('/:id(\\d+)/why', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: [st] } = await pool.query(`SELECT * FROM bank_statements WHERE id = $1`, [req.params.id]);
    if (!st) return res.status(404).json({ success: false, error: 'Statement not found' });
    if (st.status === 'parsing') return res.status(400).json({ success: false, error: 'Statement is still parsing' });

    const out = await runAutoMatch(st, req.user.name, {
      dryRun: true,
      includeBooked: req.query.include_booked === '1',
    });
    // Ordered by what a person can act on, most-actionable first, then by money.
    // Every reason the loop can emit, in the order a person should work them.
    // A reason missing from this list sorts to indexOf === -1, which puts it
    // FIRST — above 'would-match' — so adding a label to the matcher without
    // adding it here silently promotes it to the top of the worklist. Both group
    // reasons are actionable by hand (pick the group, or fix what the guard
    // named), so they sit with 'ambiguous'.
    const ORDER = ['would-match', 'ambiguous', 'ambiguous-group', 'group-refused',
      'amount-no-match', 'outside-window',
      'refused-weak-evidence', 'name-veto', 'nameless-descriptor', 'no-candidate', 'no-invoice-rule'];
    const rows = [...(out.declined || [])].sort((a, b) => {
      const d = ORDER.indexOf(a.reason) - ORDER.indexOf(b.reason);
      return d || (Math.abs(b.amount) - Math.abs(a.amount));
    });
    const value = {};
    for (const d of rows) value[d.reason] = Math.round(((value[d.reason] || 0) + Math.abs(d.amount)) * 100) / 100;
    res.json({ success: true, data: {
      statement_id: st.id, account: st.account, period_start: st.period_start, period_end: st.period_end,
      scanned: out.scanned,
      would_match: (out.reasons || {})['would-match'] || 0,
      reasons: out.reasons,
      value_by_reason: value,
      rows,
    } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/statements/:id/match — match unmatched debits against ledger families.
//
// SUPERSEDED by POST /rematch-all?statement_id=<id>, which does the same thing
// with the same additive guarantee and also reports `scanned` and the busy state.
// Nothing calls this any more (checked: no client page, no script). Left in place
// rather than deleted because it is a correct endpoint and removing a working URL
// buys nothing — but new callers should use /rematch-all so there is one answer to
// "run the matcher again", whatever the scope.
router.post('/:id(\\d+)/match', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: [st] } = await pool.query(`SELECT * FROM bank_statements WHERE id = $1`, [req.params.id]);
    if (!st) return res.status(404).json({ success: false, error: 'Statement not found' });
    if (st.status === 'parsing') return res.status(400).json({ success: false, error: 'Statement is still parsing' });

    const out = await runAutoMatch(st, req.user.name);
    await audit(req.user, 'statement_matched', null, null,
      `Auto-match on ${st.account.toUpperCase()} "${st.filename}": ${out.matched}/${out.scanned} debits matched`);
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Manual match / unmatch / dismiss ─────────────────────────────────────────

router.post('/tx/:txId(\\d+)/match', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const expenseId = parseInt(req.body.expense_id, 10);
    if (!expenseId) return res.status(400).json({ success: false, error: 'expense_id required' });
    // Always store the family root
    const { rows: [e] } = await pool.query(
      `SELECT id, parent_id, payee, entry_source FROM expenses WHERE id = $1`, [expenseId]);
    if (!e) return res.status(404).json({ success: false, error: 'Expense not found' });

    // ── A bank line cannot be the invoice for another bank line ─────────────
    //
    // An entry with entry_source = 'bank_statement' was CREATED by booking a
    // bank debit. Matching a second debit to it records that debit as
    // "invoice-backed" by a document that does not exist anywhere — and nothing
    // downstream ever contradicts it. It is the same silent-false-record hazard
    // as picking the wrong invoice, except there is no right answer to pick.
    //
    // This route had no such guard, and it was reachable: the manual match
    // search called /bk/entries with no source filter, so for the biggest
    // vendors EVERY visible result was bank-created — 8 of 8 for UBER, FACEBOOK
    // and SPOTIFY. It had already happened twice, both from the auto-matcher:
    // txn #5758 ($1.00, auto-learned) and #4249 ($0.01, auto-ref).
    //
    // The guard lives HERE and not only in the search, because the search is
    // one caller and this is the invariant.
    if (e.entry_source === 'bank_statement') {
      return res.status(400).json({
        success: false,
        error: 'That ledger entry was itself created from a bank line, so it is not an invoice — '
          + 'matching to it would record this debit as document-backed when no document exists. '
          + 'Look for the vendor\'s real invoice, or book this row instead.',
      });
    }
    // Its sibling: hand-added AND undocumented. The guard above catches an
    // entry the app invented from a bank line; this catches one a PERSON typed
    // in with no invoice attached. Both make the same false claim — that this
    // debit has a document behind it.
    {
      const why = await undocumentedAddedReason(e.id);
      if (why) return res.status(400).json({ success: false, error: why });
    }
    const rootId = e.parent_id || e.id;
    // Capacity guard: a family accepts debits until its total is covered
    // (a $4,500 split family takes 3 × $1,500 installments), never beyond —
    // over-covering means a duplicate charge or a mis-match.
    const { rows: [txnRow] } = await pool.query(
      `SELECT amount, currency, description, txn_date, match_method, matched_income_id
         FROM bank_transactions WHERE id = $1`, [req.params.txId]);
    if (!txnRow) return res.status(404).json({ success: false, error: 'Transaction not found' });
    // Matching over a BOOKED txn would orphan its created ledger entry —
    // that entry would keep counting in the ledger with no bank link.
    if (txnRow.match_method === 'created') {
      return res.status(400).json({ success: false, error: 'This debit is booked as its own ledger entry — unbook it first, then match.' });
    }
    if (txnRow.matched_income_id) {
      return res.status(400).json({ success: false, error: 'This transaction is booked as income — unbook it first.' });
    }
    const { rows: [fam] } = await pool.query(`${FAMILY_SQL} AND r.id = $1`, [rootId]);
    let prepaymentNote = '';

    // A debit that left the bank BEFORE the invoice existed cannot be paying it.
    //
    // The auto-matcher has always refused this (its dateOk test), but MANUAL
    // matching skipped the check entirely — and that gap produced 8 live
    // inverted matches, up to 208 days, including a $10,000 debit dated nearly
    // six months before its invoice. None had been confirmed yet; the moment
    // one is, the wrong match becomes a wrong payment record.
    //
    // Refused rather than warned: there is no reading under which a payment
    // precedes the invoice it settles. A late payment of an old invoice is the
    // legitimate case and stays allowed — that's the other direction.
    if (fam?.invoice_date && txnRow.txn_date) {
      const daysEarly = (new Date(fam.invoice_date) - new Date(txnRow.txn_date)) / 86400000;
      // A retainer or advance is the one legitimate way money leaves before the
      // invoice exists — a law firm billing a June invoice against a March
      // retainer, for instance. Still refused by default, because 8 of these
      // turned out to be plain mis-matches, but a caller who knows it's a
      // prepayment can say so and it's recorded as such rather than silently
      // waved through.
      if (daysEarly > 5 && req.body.allow_prepayment !== true) {
        return res.status(400).json({
          success: false,
          prepayment_possible: true,
          // Structured alongside the prose so the UI can compose its own
          // question instead of regex-parsing an error string — the message
          // is written for a human reading a log, not for a dialog.
          prepayment: {
            txn_date: isoDay(txnRow.txn_date),
            invoice_date: isoDay(fam.invoice_date),
            days_early: Math.round(daysEarly),
          },
          error: `That debit left the bank on ${isoDay(txnRow.txn_date)}, ${Math.round(daysEarly)} days BEFORE this invoice is dated (${isoDay(fam.invoice_date)}) — it can't be paying it unless it was a retainer or advance. Check the invoice date, or pick the debit that actually settled it. Pass allow_prepayment to record it deliberately as a prepayment.` });
      }
      if (daysEarly > 5) {
        prepaymentNote = ` (recorded as a prepayment — the debit predates the invoice by ${Math.round(daysEarly)} days)`;
      }
    }

    if (fam) {
      // Capacity math runs in the FAMILY's currency — a GBP 100 invoice
      // settled as a $137.45 USD wire is exact coverage, not overpay.
      const { rows: claimedRows } = await pool.query(
        `SELECT amount, currency, description, txn_date FROM bank_transactions
          WHERE matched_expense_id = $1 AND dismissed = false AND id <> $2`,
        [rootId, req.params.txId]);
      let claimedTotal = 0;
      for (const c of claimedRows) claimedTotal += await amountInFamilyCurrency(c, fam);
      const txnAmt = await amountInFamilyCurrency(txnRow, fam);
      const famTotal = Number(fam.family_total);
      const fCur = (fam.currency || 'USD').toUpperCase();
      // Mislabeled-currency grace: the wire's FX face value equals the
      // invoice total exactly (GBP 100.00 wire ↔ "100.00" recorded as USD).
      // The currency-mismatch flag already calls these out — refusing the
      // explicit match here just dead-ends the review deck.
      const face = fxFaceOf(txnRow);
      const faceExact = face && Math.abs(face.amount - famTotal) <= 0.01 && claimedTotal === 0;
      if (!faceExact && claimedTotal + txnAmt > famTotal + (claimedTotal > 0 ? 0.01 : feeTolerance(famTotal))) {
        const money = (n) => (fCur === 'USD' ? '$' : `${fCur} `) + Number(n).toFixed(2);
        return res.status(409).json({ success: false,
          error: `"${e.payee}" is already fully covered: ${money(claimedTotal)} of the ${money(famTotal)} invoice is matched to other bank transactions. Adding ${money(txnAmt)} would overpay it — unmatch one of the others first if this is the right debit.` });
      }
    }
    // A creator payment records a DIFFERENT method, and that is the whole point
    // of letting it match at all. 'manual' feeds `bucket.matched`, which is what
    // `invoice_backed_pct` reduces over; 'creator' gets its own bucket. The row
    // explains the bank line without ever claiming a document exists.
    const method = e.entry_source === CREATOR_SOURCE ? 'creator' : 'manual';
    const { rows: [txn] } = await pool.query(
      `UPDATE bank_transactions SET matched_expense_id = $1, match_method = $4, match_score = NULL,
         matched_by = $2, matched_at = NOW() WHERE id = $3 RETURNING payee_guess`,
      [rootId, req.user.name, req.params.txId, method]);
    if (!txn) return res.status(404).json({ success: false, error: 'Transaction not found' });
    // This row may arrive carrying links from a CONSOLIDATED settle — /attach,
    // or the marked-group tier in runAutoMatch. Re-pointing it at ONE invoice
    // makes those stale: the other invoices would go on reading as settled by a
    // payment that now settles something else. Same clear, same reason, as the
    // shared settle performs before it writes its own links.
    await pool.query(`DELETE FROM bank_txn_invoice_links WHERE txn_id = $1`,
      [req.params.txId]).catch(() => {});
    // Teach the matcher: this bank descriptor belongs to this ledger vendor.
    await learnPayeeMap(req.user, txn.payee_guess, e.payee);
    await audit(req.user, 'statement_manual_match', rootId, e.payee, `Bank txn #${req.params.txId} matched manually${prepaymentNote}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Booking a CREDIT as income ───────────────────────────────────────────────
// Money verifiably arrived — book it as an artist_income row (the P&L's
// revenue side) and link the credit so it reads as Booked.
router.post('/tx/:txId(\\d+)/book-income', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: [t] } = await pool.query(`SELECT * FROM bank_transactions WHERE id = $1`, [req.params.txId]);
    if (!t) return res.status(404).json({ success: false, error: 'Transaction not found' });
    if (t.direction !== 'credit') return res.status(400).json({ success: false, error: 'Only credits can become income' });
    if (t.matched_income_id) return res.status(400).json({ success: false, error: 'Already booked as income' });

    // Validate against the live vocabulary, and REJECT rather than coerce.
    // Coercing to 'Other Income' made a typo (or a custom type the server
    // hadn't heard of) look like a successful booking into the wrong line.
    const requestedType = String(req.body.income_type || '').replace(/\s+/g, ' ').trim();
    if (!requestedType) return res.status(400).json({ success: false, error: 'income_type is required' });
    if (!(await isKnownIncomeType(requestedType))) {
      return res.status(400).json({
        success: false,
        error: `Unknown income type “${requestedType}”. Create it first, then book this credit.`,
      });
    }
    const incomeType = requestedType;
    const artistName = String(req.body.artist || '').trim() || null;
    const description = String(req.body.description || t.payee_guess || t.description || 'Bank credit').slice(0, 490);

    // artist_income has no currency column — everything downstream reads it
    // as USD. Convert foreign credits at the settle-date rate; a ¥237,858
    // credit must book as ~$1,511, not $237,858.
    let usdAmount = Number(t.amount);
    let fxNote = '';
    const tCur = (t.currency || 'USD').toUpperCase();
    if (tCur !== 'USD') {
      const hist = await getHistorical(String(t.txn_date).slice(0, 10)).catch(() => null);
      const rate = hist?.rates?.[tCur] > 0 ? hist.rates[tCur] : (getCached()?.rates?.[tCur] || 0);
      if (!(rate > 0)) return res.status(400).json({ success: false, error: `No exchange rate available for ${tCur} — cannot book this credit in USD.` });
      usdAmount = Math.round((Number(t.amount) / rate) * 100) / 100;
      fxNote = ` — ${Number(t.amount).toLocaleString()} ${tCur} @ ${rate.toFixed(4)}`;
    }

    // artist_id is deliberately not resolved here (2026-08-06, John's call):
    // income isn't attributed per artist, so there is nothing downstream that
    // needs the link.
    const { rows: [inc] } = await pool.query(`
      INSERT INTO artist_income (artist_name, description, amount, income_type, income_date, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [artistName, description, usdAmount, incomeType, t.txn_date,
       `Created from bank statement credit #${t.id}${t.payee_email ? ` (${t.payee_email})` : ''}${fxNote}`,
       req.user.id || null]);

    // Atomic link — a lost race must not leave an orphaned income row
    // doubling revenue in Financials.
    const { rowCount: linked } = await pool.query(
      `UPDATE bank_transactions SET matched_income_id = $1, match_method = 'created-income',
         matched_by = $2, matched_at = NOW()
       WHERE id = $3 AND matched_income_id IS NULL AND matched_expense_id IS NULL AND dismissed = false`,
      [inc.id, req.user.name, t.id]);
    if (!linked) {
      await pool.query(`DELETE FROM artist_income WHERE id = $1`, [inc.id]).catch(() => {});
      return res.status(409).json({ success: false, error: 'Already booked' });
    }
    await audit(req.user, 'statement_income_booked', null, description,
      `Income booked from bank credit: $${t.amount} on ${String(t.txn_date).slice(0, 10)} (${incomeType})`);
    res.json({ success: true, data: { income_id: inc.id } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/tx/:txId(\\d+)/unbook-income', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: [t] } = await pool.query(`SELECT * FROM bank_transactions WHERE id = $1`, [req.params.txId]);
    if (!t?.matched_income_id) return res.status(400).json({ success: false, error: 'Not booked as income' });
    await pool.query(`DELETE FROM artist_income WHERE id = $1`, [t.matched_income_id]);
    await pool.query(
      `UPDATE bank_transactions SET matched_income_id = NULL, match_method = NULL,
         matched_by = NULL, matched_at = NULL WHERE id = $1`, [t.id]);
    await audit(req.user, 'statement_income_unbooked', null, t.payee_guess,
      `Income entry removed; bank credit #${t.id} reopened`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Unbook: for a debit that was BOOKED from this page (match_method =
// 'created'), soft-delete the created ledger entry AND unlink the debit —
// plain unlink would orphan the entry on the ledger.
router.post('/tx/:txId(\\d+)/unbook', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: [t] } = await pool.query(`SELECT * FROM bank_transactions WHERE id = $1`, [req.params.txId]);
    if (!t) return res.status(404).json({ success: false, error: 'Transaction not found' });
    if (t.match_method !== 'created' || !t.matched_expense_id) {
      return res.status(400).json({ success: false, error: 'Only booked debits can be unbooked — use unlink for matches.' });
    }
    const { rows: [e] } = await pool.query(
      `UPDATE expenses SET deleted = true, deleted_by = $1, deleted_at = NOW()
        WHERE id = $2 AND entry_source = 'bank_statement' RETURNING id, payee, category`,
      [req.user.name, t.matched_expense_id]);
    // Split bookings created children — the soft-delete must cascade.
    const { rowCount: childCount } = await pool.query(
      `UPDATE expenses SET deleted = true, deleted_by = $1, deleted_at = NOW()
        WHERE parent_id = $2 AND entry_source = 'bank_statement'`,
      [req.user.name, t.matched_expense_id]).catch(() => ({ rowCount: 0 }));
    await pool.query(
      `UPDATE bank_transactions SET matched_expense_id = NULL, match_method = NULL, match_score = NULL,
         matched_by = NULL, matched_at = NULL WHERE id = $1`, [req.params.txId]);
    // The booking taught the maps — unbooking untaught them. Split
    // bookings never taught a category lesson (no single category), so
    // only plain bookings decrement one.
    if (e) {
      if (!childCount) await unlearnCategoryMap(t.payee_guess, e.category);
      await unlearnPayeeMap(t.payee_guess, e.payee);
    }
    await audit(req.user, 'statement_unbooked', t.matched_expense_id, e?.payee || t.payee_guess,
      `Booked entry removed and bank debit #${t.id} reopened`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Unlearn: a wrong lesson re-makes the same mistake every month. When a
// match is undone, delete the payee-map rows that tie this bank descriptor
// to that ledger vendor; when a booking is undone, decay the category lesson.
async function unlearnPayeeMap(bankPayee, ledgerPayee) {
  const norm = normalizeBankPayee(bankPayee);
  if (!norm || !ledgerPayee) return;
  try {
    // Lessons are stored with RAW descriptors but looked up normalized —
    // the unlearn has to normalize too, or a lesson taught from one card
    // variant survives a correction made on another.
    const { rows } = await pool.query(
      `SELECT id, bank_payee FROM statement_payee_map
        WHERE LOWER(TRIM(ledger_payee)) = LOWER(TRIM($1))`, [ledgerPayee]);
    const ids = rows.filter((r) => normalizeBankPayee(r.bank_payee) === norm).map((r) => r.id);
    if (ids.length) await pool.query(`DELETE FROM statement_payee_map WHERE id = ANY($1)`, [ids]);
  } catch { /* unlearn is best-effort */ }
}
async function unlearnCategoryMap(bankPayee, category) {
  const norm = normalizeBankPayee(bankPayee);
  if (!norm || !category) return;
  await pool.query(
    `UPDATE statement_category_map SET times = times - 1
      WHERE LOWER(bank_payee) = LOWER($1) AND category = $2`, [norm, category]).catch(() => {});
  await pool.query(
    `DELETE FROM statement_category_map WHERE LOWER(bank_payee) = LOWER($1) AND times <= 0`,
    [norm]).catch(() => {});
}

router.delete('/tx/:txId(\\d+)/match', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: [t] } = await pool.query(
      `SELECT bt.txn_date, bt.amount, bt.payee_guess, bt.payee_email,
              bt.matched_expense_id, bt.match_method, e.payee AS ledger_payee
         FROM bank_transactions bt LEFT JOIN expenses e ON e.id = bt.matched_expense_id
        WHERE bt.id = $1`, [req.params.txId]);
    // Unlinking a BOOKED txn would orphan its created ledger entry — the
    // entry keeps counting with no bank link. Unbook deletes it properly.
    if (t?.match_method === 'created') {
      return res.status(400).json({ success: false, error: 'This debit is booked as its own ledger entry — use Unbook instead.' });
    }
    await pool.query(
      `UPDATE bank_transactions SET matched_expense_id = NULL, match_method = NULL, match_score = NULL,
         matched_by = NULL, matched_at = NULL WHERE id = $1`, [req.params.txId]);
    if (t?.ledger_payee) await unlearnPayeeMap(t.payee_guess, t.ledger_payee);
    // An explicit unmatch means "wrong pairing" — remember the no, so the
    // matcher never re-proposes it. An UNDO (deck back button) is not a
    // rejection; those callers pass ?undo=1.
    if (t?.matched_expense_id && req.query.undo !== '1') {
      await recordRejection(req.user, t, t.matched_expense_id, 'unmatch');
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Flag a transaction for review — a user-level marker (distinct from the
// integrity Flags section), toggled from the deck or any table row.
router.post('/tx/:txId(\\d+)/flag', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const on = req.body.flag !== false;
    const { rows: [t] } = await pool.query(
      `UPDATE bank_transactions SET flagged = $1,
         flagged_by = CASE WHEN $1 THEN $2 ELSE NULL END
       WHERE id = $3 RETURNING id`,
      [on, req.user.name, req.params.txId]);
    if (!t) return res.status(404).json({ success: false, error: 'Transaction not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/statements/tx/:txId/currency — correct a mislabeled currency
// (old parses hardcoded USD; "General Payment" gives the repair sweep
// nothing to read). Refused while matched/booked: the linked ledger record
// carries the old currency — unbook/unmatch first, fix, re-handle.
const TXN_ISO = /^(USD|EUR|GBP|JPY|CAD|AUD|CHF|MXN|BRL|SEK|NOK|DKK|NZD|HKD|SGD|CNY|PLN|CZK|HUF|ILS|THB|PHP|TWD)$/;
router.post('/tx/:txId(\\d+)/currency', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const cur = String(req.body.currency || '').toUpperCase().trim();
    if (!TXN_ISO.test(cur)) return res.status(400).json({ success: false, error: 'Unknown currency code' });
    const { rows: [t] } = await pool.query(`SELECT * FROM bank_transactions WHERE id = $1`, [req.params.txId]);
    if (!t) return res.status(404).json({ success: false, error: 'Transaction not found' });
    if (t.matched_expense_id || t.matched_income_id) {
      return res.status(400).json({ success: false, error: 'This transaction is matched/booked — the linked ledger record carries the old currency. Unbook/unmatch first, then fix the currency.' });
    }
    const old = (t.currency || 'USD').toUpperCase();
    await pool.query(`UPDATE bank_transactions SET currency = $1 WHERE id = $2`, [cur, req.params.txId]);
    // Fresh USD estimate at the settle-date rate for the client to render.
    let usd = Number(t.amount);
    if (cur !== 'USD') {
      const hist = await getHistorical(String(t.txn_date).slice(0, 10)).catch(() => null);
      const rate = hist?.rates?.[cur] > 0 ? hist.rates[cur] : (getCached()?.rates?.[cur] || 0);
      usd = rate > 0 ? Math.round((Number(t.amount) / rate) * 100) / 100 : Number(t.amount);
    }
    await audit(req.user, 'statement_currency_corrected', null, t.payee_guess,
      `Bank txn #${t.id} currency corrected ${old} → ${cur} (${Number(t.amount).toLocaleString()} ${cur} ≈ $${usd.toLocaleString()})`);
    res.json({ success: true, data: { currency: cur, usd } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/statements/reversals/resolve { debit_id, credit_id, undo? }
//
// A payment that bounced and came back is ONE non-event with two legs. Until it
// is resolved the debit still carries a ledger entry, so the books count money
// that never left — the $250,000 Tone transfer being the live example.
//
// Resolving is three moves that only make sense together, which is why they are
// one call rather than three buttons: drop the record the debit carries (the
// invented entry is soft-deleted; a REAL invoice is only unlinked, because that
// invoice still exists and simply was not paid by this transfer), then dismiss
// both legs so neither is counted or asked about again.
//
// It lives here, not only on Bank Matching, because the vendor page is where you
// see the pair in the context of everything else that vendor did.
router.post('/reversals/resolve', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const undo = req.body.undo === true;
    const debit = await fetchTxnWithAccount(Number(req.body.debit_id) || 0);
    const credit = await fetchTxnWithAccount(Number(req.body.credit_id) || 0);
    if (!debit || !credit) return res.status(404).json({ success: false, error: 'Transaction not found' });
    if (debit.direction !== 'debit' || credit.direction !== 'credit') {
      return res.status(400).json({ success: false, error: 'A reversal is one debit and one credit' });
    }
    if (Math.abs(Number(debit.amount) - Number(credit.amount)) > 0.01) {
      return res.status(400).json({ success: false, error: `These are not a pair — $${Number(debit.amount).toFixed(2)} out against $${Number(credit.amount).toFixed(2)} back` });
    }

    if (undo) {
      // The inverse, in reverse order: both legs come back first, then the
      // record. An entry restored onto a still-dismissed row would be counted
      // by the ledger and invisible to the statement at the same time.
      await pool.query(`UPDATE bank_transactions SET dismissed = false, dismissed_reason = NULL
         WHERE id = ANY($1::int[])`, [[debit.id, credit.id]]);
      const restoreId = Number(req.body.restore_entry_id) || 0;
      let restored = null;
      if (restoreId) {
        // Scoped to a statement-created entry, the same guard every restore in
        // this file uses — an undo must never resurrect somebody's real invoice.
        const { rows: [e] } = await pool.query(
          `UPDATE expenses SET deleted = false, deleted_by = NULL, deleted_at = NULL
            WHERE id = $1 AND entry_source = 'bank_statement' RETURNING id`, [restoreId]);
        if (e) {
          await pool.query(`UPDATE expenses SET deleted = false WHERE parent_id = $1`, [e.id]).catch(() => {});
          await pool.query(
            `UPDATE bank_transactions SET matched_expense_id = $1, match_method = 'created',
               matched_by = $2, matched_at = NOW() WHERE id = $3 AND matched_expense_id IS NULL`,
            [e.id, req.user?.name || 'unknown', debit.id]);
          restored = e.id;
        }
      }
      await audit(req.user, 'statement_reversal_unresolved', restored, debit.payee_guess || null,
        `Reversal pair #${debit.id}/#${credit.id} restored${restored ? `, booking ${restored} back` : ''}`);
      return res.json({ success: true, data: { restored_entry_id: restored } });
    }

    let removedEntryId = null;
    let unlinkedInvoiceId = null;
    if (debit.matched_expense_id) {
      if (debit.match_method === 'created') {
        const { rows: [e] } = await pool.query(
          `UPDATE expenses SET deleted = true, deleted_by = $1, deleted_at = NOW()
            WHERE id = $2 AND entry_source = 'bank_statement' RETURNING id`,
          [req.user?.name || 'unknown', debit.matched_expense_id]);
        if (!e) {
          return res.status(400).json({ success: false, error:
            'The entry on this debit is a real record, not one booked from the bank line — unbook or unmatch it by hand first.' });
        }
        await pool.query(`UPDATE expenses SET deleted = true, deleted_by = $1, deleted_at = NOW()
           WHERE parent_id = $2 AND entry_source = 'bank_statement'`, [req.user?.name || 'unknown', e.id]).catch(() => {});
        removedEntryId = e.id;
      } else {
        // A real invoice: it was never paid by this transfer, so the LINK goes
        // and the invoice stays. Deleting it here would destroy a document
        // because a different payment bounced.
        unlinkedInvoiceId = debit.matched_expense_id;
      }
      await pool.query(
        `UPDATE bank_transactions SET matched_expense_id = NULL, match_method = NULL, match_score = NULL,
           matched_by = NULL, matched_at = NULL WHERE id = $1`, [debit.id]);
      await pool.query(`DELETE FROM bank_txn_invoice_links WHERE txn_id = $1`, [debit.id]).catch(() => {});
    }
    await pool.query(
      `UPDATE bank_transactions SET dismissed = true,
         dismissed_reason = 'reversal pair — the money went out and came back'
       WHERE id = ANY($1::int[])`, [[debit.id, credit.id]]);
    await audit(req.user, 'statement_reversal_resolved', removedEntryId, debit.payee_guess || null,
      `Reversal #${debit.id}/#${credit.id} resolved — `
      + (removedEntryId ? `booking ${removedEntryId} removed` : unlinkedInvoiceId ? `invoice ${unlinkedInvoiceId} unlinked (still on the ledger)` : 'nothing was booked')
      + ', both legs dismissed');
    res.json({ success: true, data: { removed_entry_id: removedEntryId, unlinked_invoice_id: unlinkedInvoiceId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/tx/:txId(\\d+)/dismiss', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const undo = req.body.undo === true;
    if (!undo) {
      // A dismissed-but-matched zombie hides the bank proof while the
      // ledger still counts the entry as paid. Force the unlink first.
      const { rows: [cur] } = await pool.query(
        `SELECT matched_expense_id, matched_income_id FROM bank_transactions WHERE id = $1`,
        [req.params.txId]);
      if (cur?.matched_expense_id || cur?.matched_income_id) {
        return res.status(400).json({ success: false, error: 'This transaction is matched or booked — unmatch/unbook it before dismissing.' });
      }
    }
    await pool.query(
      `UPDATE bank_transactions SET dismissed = $1, dismissed_reason = $2 WHERE id = $3`,
      [!undo, undo ? null : (req.body.reason || null), req.params.txId]);

    // Dismissing a card that carried a suggestion is a "no" to that
    // pairing — the deck passes the suggested family id it showed.
    const rejectedRoot = parseInt(req.body.rejected_expense_id, 10);
    if (!undo && rejectedRoot) {
      const { rows: [txn] } = await pool.query(
        `SELECT txn_date, amount, payee_guess, payee_email FROM bank_transactions WHERE id = $1`,
        [req.params.txId]);
      await recordRejection(req.user, txn, rejectedRoot, 'dismiss');
    }

    // "Always dismiss debits like this" — persist a pattern rule and sweep
    // it across every existing unmatched debit right away.
    if (!undo && req.body.always === true) {
      const { rows: [t] } = await pool.query(`SELECT * FROM bank_transactions WHERE id = $1`, [req.params.txId]);
      const pattern = String(req.body.pattern || displayBankPayee(t?.payee_guess) || '').trim().slice(0, 120);
      if (pattern.length >= 3) {
        await pool.query(
          `INSERT INTO statement_dismiss_rules (pattern, created_by) VALUES ($1, $2)`,
          [pattern, req.user.name]);
        await pool.query(
          `UPDATE bank_transactions SET dismissed = true, dismissed_reason = $1
            WHERE direction = 'debit' AND dismissed = false AND matched_expense_id IS NULL
              AND (payee_guess ILIKE $2 OR description ILIKE $2)`,
          [`rule: ${pattern}`, `%${likeEscape(pattern)}%`]);
        await audit(req.user, 'statement_rule_added', null, null, `Always-dismiss rule "${pattern}"`);
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/statements/auto-decisions — what the system resolved without being
// asked, so "it handles recurring charges for you" is inspectable rather than
// something you have to take on faith.
//
// No new column needed: match_method already separates machine decisions from
// human ones. In production it reads `created` (a person booked it) and
// `manual` versus the `auto-*` family — auto-learned, auto-fuzzy, auto-ref,
// auto-sameday, auto-alias, auto-date, auto-fx, auto-email, auto-fee. The
// prefix IS the distinction, so this stays correct as new auto-* methods are
// added and never claims a human's match as its own.
//
// Deliberately its own endpoint rather than another field on /statements/all,
// which is already the heaviest response the page loads.
router.get('/auto-decisions', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const { rows } = await pool.query(`
      SELECT bt.id, bt.txn_date, bt.payee_guess, bt.description, bt.amount,
             bt.match_method, bt.matched_at, bt.matched_expense_id,
             e.payee AS ledger_payee, e.category, e.invoice_number, e.artist,
             -- Does a document actually back this automatic decision? Same
             -- OR-check every ledger query uses: the R2 key OR the legacy
             -- base64 column, never one or the other.
             ((e.invoice_data IS NOT NULL AND e.invoice_data != '') OR e.invoice_r2_key IS NOT NULL) AS has_invoice
        FROM bank_transactions bt
        LEFT JOIN expenses e ON e.id = bt.matched_expense_id
       WHERE bt.match_method LIKE 'auto-%'
         AND bt.matched_at IS NOT NULL
         AND bt.matched_at >= NOW() - ($1 || ' days')::INTERVAL
       ORDER BY bt.matched_at DESC
       LIMIT 200`, [String(days)]);
    // The LIMIT bounds what we SHOW, never what we report. Returning
    // rows.length as the headline made the banner read "resolved 200 lines"
    // for any window with more than 200 — a cap wearing the costume of a
    // total, which is worse than no number at all on a page whose job is
    // being able to defend a figure later.
    const { rows: [tally] } = await pool.query(`
      SELECT COUNT(*)::int AS n, COUNT(DISTINCT COALESCE(e.payee, bt.payee_guess))::int AS vendors
        FROM bank_transactions bt
        LEFT JOIN expenses e ON e.id = bt.matched_expense_id
       WHERE bt.match_method LIKE 'auto-%'
         AND bt.matched_at IS NOT NULL
         AND bt.matched_at >= NOW() - ($1 || ' days')::INTERVAL`, [String(days)]);
    // Grouped by who it paid, because the banner names vendors ("Google Cloud,
    // Adobe, Dropbox") rather than counting anonymous rows.
    const byPayee = new Map();
    for (const r of rows) {
      const k = (r.ledger_payee || r.payee_guess || 'Unknown').trim();
      if (!byPayee.has(k)) byPayee.set(k, { payee: k, count: 0, last_at: r.matched_at, ids: [] });
      const g = byPayee.get(k);
      g.count += 1;
      g.ids.push(r.id);
    }
    res.json({
      success: true,
      data: {
        days,
        total: tally?.n ?? rows.length,          // the true count
        vendor_count: tally?.vendors ?? byPayee.size,
        shown: rows.length,                      // what the panel can list
        truncated: (tally?.n ?? 0) > rows.length,
        since: rows.length ? rows[rows.length - 1].matched_at : null,
        vendors: [...byPayee.values()].sort((a, b) => b.count - a.count),
        rows,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── THE TEST THAT DECIDES WHICH ANSWER A BANK ROW GETS ───────────────────────
//
// Does this vendor ever send a document? Everything the Rules page offers turns
// on it, because the two answers are opposites: for a vendor that invoices, a
// category rule permanently prevents matching; for one that never does, it is
// the complete answer.
//
// The STRICT test, and deliberately the same one /completion's `everInvoiced`
// uses, so no two surfaces can disagree about who invoices: an invoice number
// AND not an entry this app invented from a bank line. **Without the
// entry_source clause the test is circular** — FACEBOOK reads as "195 invoices
// on file" when those 195 ARE the bank-booked rows being asked about. That
// mistake, made while measuring this, inverted the answer for every vendor.
//
// ONE definition, because /rule-suggestions decides what to offer with it and
// /category-rules decides what to warn about with it.
async function loadInvoiceCensus() {
  const [realRows, freeRows] = await Promise.all([
    pool.query(`
      SELECT LOWER(TRIM(payee)) AS p, COUNT(*)::int AS n FROM expenses
       WHERE (deleted = false OR deleted IS NULL)
         AND COALESCE(entry_source, '') <> 'bank_statement'
         AND COALESCE(TRIM(invoice_number), '') <> ''
       GROUP BY 1`).catch(() => ({ rows: [] })),
    // …and how many of those no bank row has claimed yet. This is the number
    // that makes a "match" suggestion actionable rather than a scolding.
    pool.query(`
      SELECT LOWER(TRIM(e.payee)) AS p, COUNT(*)::int AS n FROM expenses e
       WHERE (e.deleted = false OR e.deleted IS NULL)
         AND COALESCE(e.entry_source, '') <> 'bank_statement'
         AND COALESCE(TRIM(e.invoice_number), '') <> ''
         AND e.id NOT IN (SELECT bt.matched_expense_id FROM bank_transactions bt
                           WHERE bt.matched_expense_id IS NOT NULL AND bt.dismissed = false)
       GROUP BY 1`).catch(() => ({ rows: [] })),
  ]);
  return {
    real: new Map(realRows.rows.map((r) => [r.p, r.n])),
    waiting: new Map(freeRows.rows.map((r) => [r.p, r.n])),
  };
}

// A pattern that will ACTUALLY FIRE, derived from the rows themselves.
//
// applyCategoryRules matches `payee_guess ILIKE '%p%' OR description ILIKE '%p%'`
// against the raw bank descriptor. The suggestion engine tallies by the resolved
// LEDGER payee, so its pattern is a name the bank never prints: "FACEBOOK" was
// offered for 195 rows reading "PURCHASE 0123 FACEBK *VJ9GAARV92 650-5434800 CA".
// Six of fourteen offers measured could not fire at all.
//
// Two candidates, both checked against the rows before either is offered:
//
//   A. the most common `payee_guess` — the cleaned bank name, which IS a literal
//      substring of the descriptor when it doesn't carry varying digits.
//      Measured: FACEBK 195/195, "SQ *THUNDER ROAD CAFE" 25/25,
//      "AMERICAN EXPRESS" 13/13, "SQ *LEVY @ COACHELLA VA" 19/19.
//   B. the longest distinctive token shared across the descriptors — the answer
//      when A carries a card code or a per-row number. "PURCHASE 0318 SPOTIFY
//      USA INC 180-09525210 NY" covers 2/17 as a whole; the token SPOTIFY, 17/17.
//
// A wins ties: it is the longer, more specific string, so it catches fewer
// neighbours. Returns null when neither reaches MIN_COVERAGE — a rule that
// cannot be shown to fire is the bug this exists to fix, so nothing is offered.
// (Live example: "Online transfer to CHK 4814 Confirmation# …" has 25 distinct
// descriptors and nothing distinctive in common. Best candidate: 12 of 34.)
const BOOK_PATTERN_MIN_COVERAGE = 0.75;
// The pattern has to be predominantly THIS vendor's. A candidate that reaches
// more than this share of other vendors' rows, relative to its own, is rejected.
//
// This is the load-bearing guard, and a noise word-list is not a substitute for
// it. Dry-run against live descriptors before shipping, the token fallback
// produced three patterns that would each have caught a large slice of the
// statement — and the pre-existing blast-radius check could not see any of them,
// because it compares against ledger VENDOR NAMES while a descriptor token
// reaches ROWS:
//
//   APPLE.COM/BILL → "CKCD"          41/48 own rows — a bank card abbreviation
//   Majed LLC      → "MARKET STREET"  17/17 own rows — OUR OWN name, off
//                                    "…MARKET STREET:Majed…"
//   TONE           → "SERVICE"        9/9  own rows — generic
//
// The test is NOT "does it reach other rows" — measured, that rejected FACEBK
// (195 rows, $85,508, the biggest one) because 61 of its own charges are booked
// under other ledger spellings of Facebook created by the two rules already in
// force. Same vendor, same category, no harm done.
//
// What matters is whether the extra rows would be MIS-BOOKED: caught rows
// already carrying a DIFFERENT category are the ones a rule would silently
// relabel. So conflict is measured on the category, and mere overlap is
// disclosed rather than rejected.
const BOOK_PATTERN_MAX_CONFLICT_SHARE = 0.25;
// Words the bank prints on everything. A first filter, not the guard — every
// list like this is incomplete, which is what the reach test above is for.
const DESCRIPTOR_NOISE = new Set([
  'PURCHASE', 'CHECKCARD', 'CKCD', 'PAYMENT', 'PAYMENTS', 'RECURRING', 'DEBIT', 'CREDIT',
  'CARD', 'ONLINE', 'TRANSFER', 'TRANSFERS', 'WITHDRAWAL', 'DEPOSIT', 'CONFIRMATION',
  'CONF', 'BANK', 'AMERICA', 'ZELLE', 'WIRE', 'DOMESTIC', 'INTERNATIONAL', 'SERVICE',
  'SERVICES', 'FROM', 'WITH', 'THE', 'AND', 'FOR', 'INC', 'LLC', 'LTD', 'LLP', 'CORP',
  'COMPANY', 'PENDING', 'AUTHORIZED', 'MERCHANT', 'REFERENCE', 'ACCOUNT', 'CHECKING',
  // Us. It appears on every Zelle and transfer descriptor, so it covers any
  // vendor's rows perfectly and is the worst possible pattern.
  'MARKET STREET', 'MARKET', 'STREET',
]);
// ownRows: the rows this pattern has to cover. corpus: every debit as
// { key, payee, category, hay } so the reach test can be run before anything is
// offered. category: what the rule would apply, so conflict can be measured.
function bookPatternFor(ownRows, corpus, payeeKey, category) {
  const hay = ownRows.map((r) => `${r.payee_guess || ''} ${r.description || ''}`.toUpperCase());
  if (!hay.length) return null;
  const covers = (p) => {
    const u = p.toUpperCase();
    return hay.filter((h) => h.includes(u)).length;
  };
  // What else this pattern reaches, split by whether reaching it does harm.
  // Counted over every debit, which is the population the rule runs on.
  const cat = String(category || '').trim().toLowerCase();
  const reachOf = (p) => {
    const u = p.toUpperCase();
    const hit = (corpus || []).filter((c) => c.key !== payeeKey && c.hay.includes(u));
    // Already booked to a DIFFERENT category — the rows a rule would relabel.
    const conflicting = hit.filter((c) => c.category && c.category !== cat);
    // Not booked at all. The rule WOULD book these, which is often the point,
    // but they belong to another descriptor so the count is worth showing.
    const open = hit.filter((c) => !c.category);
    return {
      conflicting: conflicting.length,
      open: open.length,
      total: hit.length,
      payees: [...new Set(conflicting.map((c) => c.payee))].slice(0, 8),
    };
  };

  // A — most common payee_guess.
  const guesses = new Map();
  for (const r of ownRows) {
    const g = String(r.payee_guess || '').trim();
    if (g.length >= 4) guesses.set(g, (guesses.get(g) || 0) + 1);
  }
  const byFreq = [...guesses.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  const a = byFreq.length ? { pattern: byFreq[0][0], hits: covers(byFreq[0][0]) } : null;

  // B — longest distinctive shared token. Kept as ONE token: multi-token
  // patterns are more specific but only help when the tokens are contiguous in
  // every descriptor, and guessing wrong about that is how a pattern silently
  // stops matching. The blast-radius disclosure covers the shortness instead.
  const freq = new Map();
  for (const h of hay) {
    // '.' '/' '&' kept inside tokens so APPLE.COM/BILL survives as one thing.
    for (const t of new Set(h.split(/[^A-Z0-9./&'-]+/).filter(Boolean))) {
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  const usable = (t) => t.length >= 4
    && !DESCRIPTOR_NOISE.has(t)
    && !/^[\d.\-/]+$/.test(t)
    // Same card-code test cleanBankPayee uses: 2+ digits in a 4+ char token is
    // a reference number, not a name ("*VJ9GAARV92", "180-09525210").
    && (t.match(/\d/g) || []).length < 2;
  const bTok = [...freq.entries()]
    .filter(([t]) => usable(t))
    .sort((x, y) => y[1] - x[1] || y[0].length - x[0].length)[0];
  const b = bTok ? { pattern: bTok[0], hits: bTok[1] } : null;

  // Both candidates are judged on coverage AND reach, and the first one that
  // passes both wins. Checking reach only on the winner would silently discard a
  // safe candidate whenever the unsafe one merely covered more rows — which is
  // exactly the APPLE.COM/BILL case: "CKCD" covered 41 and "APPLE.COM/BILL" 38.
  const ranked = [a, b].filter(Boolean).sort((x, y) => y.hits - x.hits
    // Tie: prefer the longer string — fewer neighbours caught.
    || y.pattern.length - x.pattern.length);
  for (const c of ranked) {
    if (c.hits / hay.length < BOOK_PATTERN_MIN_COVERAGE) continue;
    const f = reachOf(c.pattern);
    if (f.conflicting > c.hits * BOOK_PATTERN_MAX_CONFLICT_SHARE) continue;
    return {
      pattern: c.pattern,
      hits: c.hits,
      rows: hay.length,
      // Disclosed, not hidden: what else this pattern reaches, and which part of
      // that would be a relabel rather than a booking.
      conflict_rows: f.conflicting,
      open_rows: f.open,
      reach_rows: f.total,
      conflict_payees: f.payees,
    };
  }
  return null;
}

// ── Learn the rules from decisions already made ──────────────────────────────
//
// 77% of every booked row repeats a decision made three or more times, against
// a handful of saved rules. Someone has categorised FACEBOOK by hand 195 times,
// SPOTIFY 151, UBER 101. The machinery to stop that already existed
// (applyCategoryRules); nothing ever SUGGESTED a rule, so it went unused.
//
// Suggests only — a rule books money on every future statement, so the call
// stays human. What makes a one-click accept safe is the disclosures below.
//
// ── WHAT THIS ENDPOINT IS *FOR* ──────────────────────────────────────────────
//
// It feeds /bk/rules, which is the setup page for BANK MATCHING — a page whose
// whole job is tying bank lines to invoices. So the question a suggestion has to
// answer is not "what category is this" but **"will this line ever have an
// invoice behind it?"**, because the two answers are opposites:
//
//   it will   → a category rule is a TRAP. Rule-booked rows get
//               match_method='created', which /match then REFUSES, so the rule
//               permanently converts matchable payments into rematch work.
//   it won't  → a category rule is the right and complete answer — but ONLY
//               paired with the no-invoice marker, or it books future rows
//               straight into the needs-invoice queue it looks like it clears.
//
// Measured before this was written, all three symptoms of one root cause — the
// tally keyed on the resolved LEDGER payee while the rules it wrote act on the
// raw BANK descriptor, and it only knew one kind of answer:
//
//   102 of 120 suggestions were category rules (85% of the page)
//   6 of the top 25 were vendors with invoices ALREADY WAITING unclaimed —
//     Majed LLC offered as "always book as Marketing" with 17 proposals in the
//     rematch queue, one per row; TONE at $600,000 with one waiting
//   6 of 10 rules already in force were unpaired, feeding 137 rows / $26,528
//     into the needs-invoice queue and growing with every upload
//   6 of 14 offers COULD NOT FIRE: pattern "FACEBOOK" (195 rows, $85,508 — the
//     top row of the page) against a descriptor reading
//     "PURCHASE 0123 FACEBK *VJ9GAARV92 650-5434800 CA"
//
// Hence: the strict invoice test decides which answer a payee gets, the category
// half carries a `book_pattern` proven against that payee's own descriptors, and
// nothing is offered that cannot be shown to fire.
router.get('/rule-suggestions', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const MIN_TIMES = Math.max(parseInt(req.query.min, 10) || 3, 2);
    const norm = (v) => String(v || '').trim().toLowerCase();

    const { rows } = await pool.query(`
      SELECT bt.id, bt.payee_guess, bt.description, bt.amount,
             COALESCE(bt.currency,'USD') AS currency, bt.dismissed, bt.dismissed_reason,
             bt.match_method, bt.matched_expense_id, e.payee, e.category, e.artist
        FROM bank_transactions bt
        LEFT JOIN expenses e ON e.id = bt.matched_expense_id
       WHERE bt.direction = 'debit'
         AND (e.id IS NULL OR e.deleted = false OR e.deleted IS NULL)`);

    const [cat, dis, art] = await Promise.all([
      pool.query(`SELECT pattern FROM statement_category_rules`).catch(() => ({ rows: [] })),
      pool.query(`SELECT pattern FROM statement_dismiss_rules`).catch(() => ({ rows: [] })),
      pool.query(`SELECT pattern FROM statement_artist_rules`).catch(() => ({ rows: [] })),
    ]);
    const covered = {
      category: new Set(cat.rows.map((r) => norm(r.pattern))),
      dismiss: new Set(dis.rows.map((r) => norm(r.pattern))),
      artist: new Set(art.rows.map((r) => norm(r.pattern))),
    };

    const { real: realInv, waiting: freeInv } = await loadInvoiceCensus();

    // Already answered — by a vendor/category no-invoice rule or row by row.
    // Suggesting the pairing again would offer work that is already done.
    const { rows: niRules } = await pool.query(
      `SELECT scope, pattern FROM statement_no_invoice_rules`).catch(() => ({ rows: [] }));
    const niVendor = new Set(niRules.filter((r) => r.scope === 'vendor').map((r) => norm(r.pattern)));
    const niCategory = new Set(niRules.filter((r) => r.scope === 'category').map((r) => norm(r.pattern)));
    const rowAnswered = await loadNoInvoiceRowIds();

    // Every distinct payee we have ever seen, for the blast-radius check below.
    const vendors = [...new Set(rows.map((r) => (r.payee || r.payee_guess || '').trim()).filter(Boolean))];
    // Every debit as a searchable descriptor, so a candidate book_pattern can be
    // measured against the population the rule actually runs on before it is
    // offered. Built once — bookPatternFor is called per vendor.
    const corpus = rows.map((r) => {
      const payee = (r.payee || r.payee_guess || '').trim();
      return {
        key: norm(payee), payee, category: norm(r.category),
        hay: `${r.payee_guess || ''} ${r.description || ''}`.toUpperCase(),
      };
    });

    // Tally each kind of decision per payee.
    const tally = new Map(); // payee -> { kind -> Map(value -> {n, usd}) }
    const bump = (payee, kind, value, usd) => {
      if (!payee || !value) return;
      if (!tally.has(payee)) {
        tally.set(payee, {
          category: new Map(), dismiss: new Map(), artist: new Map(),
          // The rows the category tally counted, kept so bookPatternFor can be
          // checked against the descriptors it will actually have to match.
          catRows: [],
        });
      }
      const m = tally.get(payee)[kind];
      const cur = m.get(value) || { n: 0, usd: 0 };
      cur.n += 1; cur.usd += usd;
      m.set(value, cur);
    };
    for (const r of rows) {
      const payee = (r.payee || r.payee_guess || '').trim();
      const usd = Math.abs(usdOf(r.amount, r.currency));
      if (r.dismissed) bump(payee, 'dismiss', String(r.dismissed_reason || '').slice(0, 80) || 'dismissed', usd);
      else if (r.match_method === 'created' && r.category) {
        bump(payee, 'category', r.category, usd);
        // bump() no-ops on a blank payee, so the entry may not exist.
        const t = tally.get(payee);
        if (t) t.catRows.push({ payee_guess: r.payee_guess, description: r.description });
      }
      if (!r.dismissed && r.matched_expense_id && r.artist) bump(payee, 'artist', String(r.artist).trim(), usd);
    }

    // ── WHAT A PAIRING ACTUALLY CLEARS ───────────────────────────────────────
    //
    // Counted with /completion's OWN predicate, not an approximation of it.
    // Measured against production the first time: a suggestion promised to clear
    // 3 rows and cleared 14, because the count tested only the LEDGER payee
    // while a vendor-scope no-invoice rule matches
    //   venRules.has(e.payee) OR venRules.has(bt.payee_guess)
    // — so it also clears rows filed under a different ledger name that share
    // the bank descriptor. Over-delivering is still a number on screen that
    // doesn't match what happens, which is the whole class of bug being fixed.
    const queueNow = rows.filter((r) => r.matched_expense_id && r.match_method === 'created'
      && !r.dismissed
      && !rowAnswered.has(r.id)
      && !niVendor.has(norm(r.payee)) && !niVendor.has(norm(r.payee_guess))
      && !niCategory.has(norm(r.category)));
    const clearedBy = (vendorPattern) => {
      const p = norm(vendorPattern);
      const hit = queueNow.filter((r) => norm(r.payee) === p || norm(r.payee_guess) === p);
      return {
        rows: hit.length,
        usd: Math.round(hit.reduce((s, r) => s + Math.abs(usdOf(r.amount, r.currency)), 0) * 100) / 100,
        ids: hit.map((r) => r.id),
      };
    };
    // Rows any offered pairing would clear, as a UNION. Summing the per-row
    // numbers would double-count: two vendor spellings of one descriptor each
    // clear the same rows, so the page's headline would promise more than the
    // queue holds.
    const clearedIds = new Set();

    const out = [];
    for (const [payee, kinds] of tally) {
      for (const kind of ['category', 'dismiss', 'artist']) {
        if (covered[kind].has(norm(payee))) continue;
        const entries = [...kinds[kind].entries()].sort((a, b) => b[1].n - a[1].n);
        if (!entries.length) continue;
        const [value, top] = entries[0];
        if (top.n < MIN_TIMES) continue;
        const total = entries.reduce((s, [, v]) => s + v.n, 0);
        // A genuinely split vendor is a judgement call, not a rule. UBER is
        // Travel 101x AND Meals 32x — suggesting one silently mis-books the
        // other, so below a clear majority we don't suggest at all.
        if (top.n / total < 0.6) continue;
        const common = {
          value,
          times: top.n,
          total_usd: Math.round(top.usd * 100) / 100,
          decisions_for_payee: total,
          share: Math.round((top.n / total) * 100),
          // The other answers given for this same payee, named rather than
          // hidden, so accepting is an informed choice.
          conflicts: entries.slice(1).map(([v, x]) => ({ value: v, times: x.n })),
        };

        // ── The category family splits in two, on the invoice test ───────────
        if (kind === 'category') {
          const real = realInv.get(norm(payee)) || 0;
          if (real > 0) {
            // THIS VENDOR SENDS INVOICES. A category rule here is not a
            // shortcut, it is a wrong turn: rule-booked rows get
            // match_method='created', which /match refuses outright, so the
            // rule permanently converts matchable payments into rematch work.
            // Majed LLC was offered as "always book as Marketing" with 17
            // unclaimed invoices waiting — one for every row.
            //
            // So no rule is offered at all. The row becomes the matching
            // answer, and its action is a link into the queue.
            out.push({
              kind: 'match',
              pattern: payee,
              ...common,
              booked_rows: top.n,
              real_invoices: real,
              waiting_invoices: freeInv.get(norm(payee)) || 0,
            });
            continue;
          }

          // NEVER INVOICES — a category rule is the right answer. Two things
          // have to be true before it is offered.
          const bp = bookPatternFor(kinds.catRows, corpus, norm(payee), value);
          if (!bp) {
            // No pattern can be shown to fire — 25 distinct descriptors with
            // nothing distinctive in common. Offering the booking rule anyway is
            // the no-op button this endpoint exists to stop. The no-invoice half
            // still works on its own: it matches the LEDGER payee by equality,
            // so it clears the queue rows without pretending to book anything.
            const clears = clearedBy(payee);
            clears.ids.forEach((id) => clearedIds.add(id));
            if (clears.rows > 0) {
              out.push({
                kind: 'no-invoice',
                pattern: payee,
                ...common,
                queue_rows: clears.rows,
                queue_usd: clears.usd,
                also_matches: [],
                also_matches_count: 0,
              });
            }
            continue;
          }
          // Already in force. The `covered` check above tests the LEDGER payee,
          // which is no longer what a category rule is written with — so without
          // this an accepted rule keeps being suggested forever, under the name
          // it was never stored as.
          if (covered.category.has(norm(bp.pattern))) continue;
          const clearsNow = clearedBy(payee);
          clearsNow.ids.forEach((id) => clearedIds.add(id));
          out.push({
            kind: 'category',
            // What the accepted rule will match on, and what the page shows —
            // the two must be the same string or the disclosures describe a
            // rule other than the one that gets written.
            pattern: bp.pattern,
            ledger_payee: payee,
            ...common,
            book_pattern_hits: bp.hits,
            book_pattern_rows: bp.rows,
            // Reach measured on the pattern that will ACTUALLY RUN, over the
            // rows it will run against — not on the ledger name, which never
            // reaches the matcher, and not over vendor-name strings, which
            // cannot see a descriptor token at all.
            conflict_rows: bp.conflict_rows,
            open_rows: bp.open_rows,
            reach_rows: bp.reach_rows,
            // The no-invoice half of the pairing keys on the LEDGER payee,
            // because /completion's venRules matches that by equality.
            no_invoice_pattern: payee,
            queue_rows: clearsNow.rows,
            queue_usd: clearsNow.usd,
            also_matches: bp.conflict_payees,
            also_matches_count: bp.conflict_payees.length,
          });
          continue;
        }

        // Dismiss and artist are unchanged — neither writes a booking.
        const alsoMatches = kind === 'artist' ? [] : vendors.filter(
          (v) => v !== payee && norm(v).includes(norm(payee)));
        out.push({
          kind,
          pattern: payee,
          ...common,
          also_matches: alsoMatches.slice(0, 8),
          also_matches_count: alsoMatches.length,
        });
      }
    }
    // MATCHING FIRST. This page is the setup for a page that ties bank lines to
    // invoices, so the rows with invoices waiting lead; the answers that stop
    // rows being asked about come next; the rest is bookkeeping.
    const RANK = { match: 0, category: 1, 'no-invoice': 1, dismiss: 2, artist: 3 };
    out.sort((a, b) => (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9)
      || b.times - a.times || b.total_usd - a.total_usd);
    const of = (k) => out.filter((x) => x.kind === k);
    res.json({
      success: true,
      data: {
        suggestions: out,
        // Per-kind totals so the page can head each group with its own number
        // instead of one total that mixes "work these" with "stop asking".
        counts: {
          match: of('match').length,
          category: of('category').length,
          no_invoice: of('no-invoice').length,
          dismiss: of('dismiss').length,
          artist: of('artist').length,
        },
        // What accepting every offered pairing would drop out of the
        // needs-invoice queue right now. The no-invoice half is evaluated live
        // by /completion, so this is a real number, not a projection.
        clears_queue_rows: clearedIds.size,
        waiting_invoices: of('match').reduce((s, x) => s + (x.waiting_invoices || 0), 0),
        total_rows_covered: out.reduce((s, x) => s + x.times, 0),
        total_usd: Math.round(out.reduce((s, x) => s + x.total_usd, 0) * 100) / 100,
        min_times: MIN_TIMES,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Rematch: the invoice that arrived after its statement ────────────────────
//
// Auto-match runs ONCE, at upload. `Reset matching` only clears `auto-*`
// matches, so a row that got BOOKED — an entry the app invented from the bank
// line — is never reconsidered. An invoice that shows up afterwards (a vendor
// submitting late) can therefore never find its bank line, no matter how
// obvious the pairing.
//
// That is the gap, and it is structural rather than a scoring weakness: 490 of
// 494 existing matches were already made automatically. On live data 148
// booked rows worth $149,127 pair with an unclaimed invoice on the same
// vendor, same amount, within 45 days — several on the very same day.
//
// Proposes only. Accepting means deleting a ledger entry and linking another,
// which moves reported numbers, so a person confirms each one.
// (REMATCH_WINDOW_DAYS is declared near the top of this file — the group
// proposal in enrichDetail uses the same window.)
router.get('/rematch-candidates', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || REMATCH_WINDOW_DAYS, 1), 365);

    // The BOOKED side follows the selector so every proposal is a row you can
    // actually see; offering 138 when 15 are on screen means accepting one
    // silently edits a statement you are not looking at.
    //
    // The INVOICE side stays global on purpose — an unpaid invoice belongs to
    // no statement, and filtering it would suppress real matches.
    const stmtId = parseInt(req.query.statement_id, 10);
    const scoped = Number.isFinite(stmtId);
    const { rows: booked } = await pool.query(`
      SELECT bt.id, bt.txn_date, bt.payee_guess, bt.description, bt.amount,
             COALESCE(bt.currency,'USD') AS currency, bt.matched_expense_id,
             e.payee AS booked_payee, e.category AS booked_category
        FROM bank_transactions bt
        JOIN expenses e ON e.id = bt.matched_expense_id
       WHERE bt.direction = 'debit' AND bt.dismissed = false
         AND bt.match_method = 'created'
         -- ONE definition of "booked", because this query DECIDES AN OFFER.
         --
         -- match_method = 'created' alone is not it. /rematch will only delete an
         -- entry the app itself invented (entry_source = 'bank_statement'), so
         -- proposing on the looser test lets the sweep offer swaps the endpoint
         -- must refuse — the row then fails on every swipe with "the booked entry
         -- is not statement-created", which is a dead end, not an answer.
         --
         -- It is not hypothetical: txn #2040 carried match_method 'created' while
         -- pointing at entry #22, a REAL invoice (INV-1908, with a file). The
         -- rematch card offered to replace it with a different invoice, and the
         -- guard in /rematch was the only thing standing between that offer and
         -- soft-deleting a genuine invoice. 1 of 2,180 booked rows, but the cost
         -- of the one is a destroyed record.
         AND COALESCE(e.entry_source, '') = 'bank_statement'
         AND (e.deleted = false OR e.deleted IS NULL)
         ${scoped ? 'AND bt.statement_id = $1' : ''}`, scoped ? [stmtId] : []);
    // Rows already answered with "no invoice for that" are not proposals.
    // Offering one an invoice re-opens the exact row someone just closed, and it
    // would put the proposal count above the Open count it is meant to explain.
    // Filtered in JS off the same helper /completion uses, so the two surfaces
    // agree — and so a missing column degrades instead of 500ing the endpoint.
    const noInvoiceIds = await loadNoInvoiceRowIds();
    const bookedOpen = booked.filter((t) => !noInvoiceIds.has(t.id));
    if (!bookedOpen.length) return res.json({ success: true, data: { pairs: [], contested: [], window_days: days } });

    // Invoices no bank row has claimed. `family_total` because a split invoice
    // settles as one debit — the same basis the matcher itself uses.
    //
    // The entry_source clause is belt-and-braces, and deliberately so. A
    // bank-created entry is already excluded by the NOT IN above, because it is
    // claimed by the very transaction that created it — but only while that
    // transaction is undismissed. Dismiss a booked row and its invented entry
    // becomes "unclaimed", at which point this pool would offer it to another
    // debit as the invoice. Emergent safety that one flag can undo is worth
    // making explicit.
    const { rows: free } = await pool.query(`${FAMILY_SQL}
      AND COALESCE(r.entry_source, '') <> 'bank_statement'
      AND NOT ${UNDOCUMENTED_ADDED_SQL('r')}
      AND r.id NOT IN (SELECT bt.matched_expense_id FROM bank_transactions bt
                        WHERE bt.matched_expense_id IS NOT NULL AND bt.dismissed = false)
      -- ...nor settled as one of SEVERAL invoices on a single payment. Without
      -- this, the second invoice of a consolidated payment reads as unclaimed and
      -- gets offered to another bank row, which is how one payment ends up
      -- appearing to settle two different debits.
      AND r.id NOT IN (SELECT bl.expense_id FROM bank_txn_invoice_links bl
                         JOIN bank_transactions bt2 ON bt2.id = bl.txn_id
                        WHERE bt2.matched_expense_id IS NOT NULL AND bt2.dismissed = false)`)
      // The table is young and runMigrations runs in the background — fall back
      // to the pre-link pool rather than 500 the endpoint during a deploy.
      .catch(async (err) => {
        if (!/bank_txn_invoice_links/.test(err.message || '')) throw err;
        return pool.query(`${FAMILY_SQL}
          AND COALESCE(r.entry_source, '') <> 'bank_statement'
          AND NOT ${UNDOCUMENTED_ADDED_SQL('r')}
          AND r.id NOT IN (SELECT bt.matched_expense_id FROM bank_transactions bt
                            WHERE bt.matched_expense_id IS NOT NULL AND bt.dismissed = false)`);
      });

    // Vendor identity through the shared alias index — never a local
    // alias→primary map. 48 of 193 alias rows have an alias that is itself a
    // primary name, so a one-hop map stops at the middle of an A→B→C chain.
    const { canonical } = await loadAliasIndex(pool);
    const idOf = (name) => canonical(String(name || '').trim());
    const cents = (n) => Math.round(Number(n || 0) * 100);
    const dayMs = (d) => new Date(String(d).slice(0, 10)).getTime();

    const byAmount = new Map();
    for (const f of free) {
      const k = cents(usdOf(f.family_total, f.currency, f.fx_rate_to_usd));
      if (!byAmount.has(k)) byAmount.set(k, []);
      byAmount.get(k).push(f);
    }

    // Score every plausible pairing first, then assign — because one invoice
    // can settle only ONE bank row and the raw list contains collisions (two
    // debits both matching a single invoice). Assigning greedily by closest
    // date and reporting the losers keeps the loser visible; silently dropping
    // it is how the wrong invoice ends up marked paid.
    // WHICH date is this invoice's evidence?
    //
    // `evidenceDate` privileges payment_date once an invoice is Paid — and
    // payment_date records when someone ticked Paid, not when the money moved.
    // Measured on live data: 10 invoices had an exact-amount bank line on their
    // own vendor and were refused on the window ALONE, and 6 of them pass
    // comfortably on their invoice date. Jordan Barrett's BR-001 is dated the
    // SAME DAY as its bank line and was scored 68 days away.
    //
    // So take whichever of the three dates sits closest to the bank date, and
    // report which one it was — a card saying "±8d" while implying a payment date
    // it did not use is the kind of number nobody can check.
    //
    // `evidenceDate` itself is NOT touched: it is shared with runAutoMatch, which
    // WRITES matches with no human in the loop. This function only decides what
    // to OFFER, and every offer is accepted by a person.
    const closestDate = (f, txnDate) => {
      const opts = [
        ['payment', f.payment_status === 'Paid' ? f.payment_date : null],
        ['scheduled', f.scheduled_payment_date],
        ['invoice', f.invoice_date],
      ].filter(([, d]) => !!d)
        .map(([kind, d]) => ({ kind, gap: Math.round(Math.abs(dayMs(txnDate) - dayMs(d)) / 86400000) }))
        .filter((x) => Number.isFinite(x.gap));
      if (!opts.length) return null;
      return opts.sort((a, b) => a.gap - b.gap)[0];
    };

    const scored = [];
    for (const t of bookedOpen) {
      const txnUsd = usdOf(t.amount, t.currency);
      // Exact cents FIRST — same currency, and the strongest evidence there is.
      // Then, only for candidates in another currency, the same 5% band the
      // matcher uses: converting and then demanding the cent is why a EUR
      // invoice paid in USD never became a proposal either. The rate moves
      // between invoicing and payment and the bank takes a spread, so the
      // converted figure lands near, not on.
      const exactCents = byAmount.get(cents(Math.abs(txnUsd))) || [];
      const banded = free.filter((f) =>
        (f.currency || 'USD').toUpperCase() !== (t.currency || 'USD').toUpperCase()
        && !exactCents.includes(f)
        && fxAgrees(txnUsd, usdOf(f.family_total, f.currency, f.fx_rate_to_usd)));
      for (const f of [...exactCents, ...banded]) {
        if (idOf(t.booked_payee || t.payee_guess) !== idOf(f.payee)) continue;
        if (!t.txn_date) continue;
        const best = closestDate(f, t.txn_date);
        if (!best) continue;
        const gap = best.gap;
        if (gap > days) continue;
        // A cross-currency pair has to SHOW its arithmetic. "EUR 1,000 ≈
        // $1,164.60 against $1,183.60 (+1.6%)" is checkable; a bare "match" on
        // two figures that plainly differ is not, and this card is accepted by
        // a person who has to believe it.
        const famUsd = usdOf(f.family_total, f.currency, f.fx_rate_to_usd);
        const crossCurrency = (f.currency || 'USD').toUpperCase() !== (t.currency || 'USD').toUpperCase();
        scored.push({
          txn: t, fam: f, gap, evidence_kind: best.kind, usd: Math.abs(txnUsd),
          ...(crossCurrency ? {
            fx: {
              invoice_currency: (f.currency || 'USD').toUpperCase(),
              invoice_amount: Number(f.family_total),
              invoice_usd: Math.round(Math.abs(famUsd) * 100) / 100,
              txn_usd: Math.round(Math.abs(txnUsd) * 100) / 100,
              diff_pct: Math.abs(famUsd) > 0
                ? Math.round(((Math.abs(txnUsd) - Math.abs(famUsd)) / Math.abs(famUsd)) * 1000) / 10
                : null,
            },
          } : {}),
        });
      }
    }
    scored.sort((a, b) => a.gap - b.gap || b.usd - a.usd);

    const takenTxn = new Set(), takenFam = new Set();
    const pairs = [], contested = [];
    for (const c of scored) {
      if (takenTxn.has(c.txn.id) || takenFam.has(c.fam.id)) {
        contested.push({
          txn_id: c.txn.id, expense_id: c.fam.id, gap_days: c.gap,
          lost_to: takenFam.has(c.fam.id) ? 'another bank row claimed this invoice' : 'this row already has a better candidate',
        });
        continue;
      }
      takenTxn.add(c.txn.id); takenFam.add(c.fam.id);
      pairs.push({
        txn_id: c.txn.id, txn_date: c.txn.txn_date, description: c.txn.description,
        payee_guess: c.txn.payee_guess, booked_payee: c.txn.booked_payee,
        booked_category: c.txn.booked_category, booked_expense_id: c.txn.matched_expense_id,
        usd: Math.round(c.usd * 100) / 100,
        expense_id: c.fam.id, invoice_number: c.fam.invoice_number, invoice_payee: c.fam.payee,
        invoice_date: c.fam.invoice_date, payment_status: c.fam.payment_status,
        invoice_artist: c.fam.artist, invoice_category: c.fam.category,
        has_invoice: !!c.fam.has_invoice, has_proof: !!c.fam.has_proof, has_receipt: !!c.fam.has_receipt,
        invoice_filename: c.fam.invoice_filename || null,
        proof_filename: c.fam.proof_filename || null,
        receipt_filename: c.fam.receipt_filename || null,
        family_total: c.fam.family_total, currency: c.fam.currency,
        gap_days: c.gap, same_day: c.gap === 0,
        // Which of the invoice's three dates the gap was measured from, so the
        // card can say "8 days from the invoice date" instead of implying a
        // payment date it didn't use.
        evidence_kind: c.evidence_kind,
        // Present only when the invoice is in another currency — the card shows
        // the conversion so the pairing can be checked rather than believed.
        fx: c.fx || null,
      });
    }
    pairs.sort((a, b) => b.usd - a.usd);
    res.json({
      success: true,
      data: {
        pairs, contested, window_days: days, statement_id: scoped ? stmtId : null,
        total: Math.round(pairs.reduce((s, p) => s + p.usd, 0) * 100) / 100,
        // What was actually SCORED, not what the first query returned — a
        // denominator that counts rows the pass skipped reads as coverage it
        // never had.
        booked_considered: bookedOpen.length, invoices_available: free.length,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/statements/tx/:txId/rematch { expense_id }
//
// Swap an invented booking for the real invoice. ONE call, because
// /tx/:id/match refuses a booked row outright ("unbook it first") — so doing
// this as two client calls means a failure between them deletes the ledger
// entry and leaves the bank row open with nothing recorded.
//
// Ordered so the failure mode is safe: verify the target FIRST, then delete
// the booking, then link. If the link somehow fails the booking is restored.
router.post('/tx/:txId(\\d+)/rematch', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const expenseId = parseInt(req.body.expense_id, 10);
    if (!expenseId) return res.status(400).json({ success: false, error: 'expense_id required' });

    const { rows: [t] } = await pool.query(`SELECT * FROM bank_transactions WHERE id = $1`, [req.params.txId]);
    if (!t) return res.status(404).json({ success: false, error: 'Transaction not found' });
    if (t.match_method !== 'created' || !t.matched_expense_id) {
      return res.status(400).json({ success: false, error: 'Only a booked row can be rematched — this one is already matched or open.' });
    }
    const { rows: [target] } = await pool.query(
      `SELECT id, payee, invoice_number FROM expenses
        WHERE id = $1 AND (deleted = false OR deleted IS NULL) AND (voided = false OR voided IS NULL)`,
      [expenseId]);
    if (!target) return res.status(404).json({ success: false, error: 'That invoice no longer exists' });
    // Same rule as /match: a hand-added entry with no document is not an
    // invoice, and rematching onto one trades a booking for a false claim.
    {
      const why = await undocumentedAddedReason(target.id);
      if (why) return res.status(400).json({ success: false, error: why });
    }
    const { rows: claimed } = await pool.query(
      `SELECT id FROM bank_transactions WHERE matched_expense_id = $1 AND dismissed = false AND id <> $2`,
      [expenseId, t.id]);
    if (claimed.length) {
      return res.status(409).json({ success: false, error: `Another bank row (#${claimed[0].id}) already settles that invoice.` });
    }

    const bookedEntryId = t.matched_expense_id;
    // Soft-delete the invented entry. Guarded on entry_source so this can only
    // ever remove a row the app created from a statement, never a real invoice.
    const { rows: [gone] } = await pool.query(
      `UPDATE expenses SET deleted = true, deleted_by = $1, deleted_at = NOW()
        WHERE id = $2 AND entry_source = 'bank_statement' RETURNING id, payee`,
      [req.user.name, bookedEntryId]);
    if (!gone) return res.status(400).json({ success: false, error: 'The booked entry is not statement-created — unbook it by hand first.' });
    await pool.query(`UPDATE expenses SET deleted = true, deleted_by = $1, deleted_at = NOW()
       WHERE parent_id = $2 AND entry_source = 'bank_statement'`, [req.user.name, bookedEntryId]).catch(() => {});

    try {
      await pool.query(
        `UPDATE bank_transactions SET matched_expense_id = $1,
           match_method = ${movedMatchMethodSql('$1', 'rematch')},
           match_score = 100, matched_by = $2, matched_at = NOW() WHERE id = $3`,
        [expenseId, req.user.name, t.id]);
    } catch (err) {
      // Put the booking back rather than leaving the row stranded.
      await pool.query(`UPDATE expenses SET deleted = false, deleted_by = NULL, deleted_at = NULL WHERE id = $1`,
        [bookedEntryId]).catch(() => {});
      throw err;
    }
    await audit(req.user, 'statement_rematched', expenseId, target.payee,
      `Bank txn #${t.id} swapped from its invented booking (entry #${bookedEntryId}) to invoice `
      + `${target.invoice_number ? `#${target.invoice_number} ` : ''}(entry #${expenseId})`);
    res.json({ success: true, data: { unbooked_entry_id: bookedEntryId, matched_expense_id: expenseId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/statements/tx/:txId/unrematch — put a rematch back.
//
// The review deck's ⌫ used to undo a rematch by plain unmatching, and that was
// wrong twice over:
//
//   1. It is NOT the inverse. A rematch soft-deletes the entry the app invented
//      for the row and links the real invoice in its place. Unmatching removes
//      the link but leaves the invented entry deleted, so the row lands OPEN
//      instead of back where it started — booked.
//   2. It DEAD-ENDED the card. The deck's in-memory item still said
//      match_method='created', so the card kept offering "swipe right to use this
//      invoice", while /rematch now (correctly) refused a row that was no longer
//      booked: "Only a booked row can be rematched." Every press failed and the
//      card could not be advanced.
//
// Restoring the booking fixes both: the row is booked again, which is what the
// deck's card already believed, so accepting works and the state is honest.
//
// The restore itself is not new logic — the rematch route already does exactly
// this in its own failure rollback. It just was not reachable from outside.
router.post('/tx/:txId(\\d+)/unrematch', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: [t] } = await pool.query(`SELECT * FROM bank_transactions WHERE id = $1`, [req.params.txId]);
    if (!t) return res.status(404).json({ success: false, error: 'Transaction not found' });
    if (t.match_method !== 'rematch') {
      return res.status(400).json({
        success: false,
        error: 'Only a rematched row can be un-rematched — this one was not swapped from a booking.',
      });
    }

    // Which invented entry to bring back. The caller passes the id the rematch
    // handed it, but it is VERIFIED rather than trusted: it must be a
    // soft-deleted statement-created entry whose note names this transaction.
    // bookDebitAsEntry writes that note, so the same row is also derivable
    // without the client — which is the fallback when an older client sends
    // nothing.
    const note = `Created from bank statement debit #${t.id}`;
    const hint = parseInt(req.body?.entry_id, 10);
    const { rows: [entry] } = await pool.query(
      `SELECT id FROM expenses
        WHERE entry_source = 'bank_statement' AND deleted = true
          AND ($1::int IS NULL OR id = $1::int)
          AND notes = $2
        ORDER BY id DESC LIMIT 1`,
      [Number.isFinite(hint) ? hint : null, note]);
    if (!entry) {
      return res.status(409).json({
        success: false,
        error: 'The booking this row had before the rematch could not be found, so the swap cannot be reversed '
          + 'automatically. Unmatch the row and book it again if that is what you want.',
      });
    }

    await pool.query(
      `UPDATE expenses SET deleted = false, deleted_by = NULL, deleted_at = NULL WHERE id = $1`, [entry.id]);
    await pool.query(
      `UPDATE expenses SET deleted = false, deleted_by = NULL, deleted_at = NULL
        WHERE parent_id = $1 AND entry_source = 'bank_statement'`, [entry.id]).catch(() => {});
    await pool.query(
      `UPDATE bank_transactions SET matched_expense_id = $1, match_method = 'created',
         match_score = NULL, matched_by = $2, matched_at = NOW()
       WHERE id = $3`,
      [entry.id, req.user.name, t.id]);

    await audit(req.user, 'statement_unrematched', entry.id, null,
      `Bank txn #${t.id} put back to its invented booking (entry #${entry.id}); the invoice link was removed`);
    res.json({ success: true, data: { matched_expense_id: entry.id, match_method: 'created' } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ONE settle implementation, several callers ────────────────────────────────
//
// The guards and the writes below were the body of /tx/:txId/attach. They are
// module-level functions now because the MATCHER needs them: a settlement group
// whose total equals a bank line has to be settled the same way a person
// settling it by hand would.
//
// Why the matcher must not do it itself with a plain UPDATE: that bypasses the
// four guards (undocumented-added, bank-born, split child, overpay) AND skips the
// step that makes any of this correct — soft-deleting the entry the app invented
// for that bank line. Leave it and the payment is counted twice, once as an
// invented expense and once as the real invoices.
//
// So: /attach is the first caller and keeps its exact behaviour; the matcher is
// the second. There is no second copy of the rules to drift.

/**
 * Everything that can refuse a settle. NO WRITES — the caller can ask "would
 * this be allowed" (the matcher does exactly that) without touching a row.
 *
 * @returns {{ok: true, targets: Array, prepaid: Array}
 *         | {ok: false, status: number, error: string, extra?: object}}
 */
async function settleChecks(client, t, ids, opts = {}) {
  if (t.direction !== 'debit') return { ok: false, status: 400, error: 'Only debits settle invoices' };
  if (t.matched_income_id) {
    return { ok: false, status: 400, error: 'This row is booked as income — unbook it first.' };
  }

  // Every invoice must be real, live, and not already settled by something else.
  const { rows: targets } = await client.query(
    `SELECT id, payee, invoice_number, entry_source, parent_id FROM expenses
      WHERE id = ANY($1) AND (deleted = false OR deleted IS NULL) AND (voided = false OR voided IS NULL)`, [ids]);
  if (targets.length !== ids.length) {
    return { ok: false, status: 404, error: 'One of those invoices no longer exists' };
  }
  // …and the hand-added-with-no-document case, per target. Attaching several
  // invoices to one payment must not be a way around the rule /match applies.
  for (const tg of targets) {
    const why = await undocumentedAddedReason(tg.id);
    if (why) return { ok: false, status: 400, error: why };
  }
  // A bank-created entry is not an invoice. Same guard as /match: without it a
  // debit gets recorded as invoice-backed with no document anywhere.
  const invented = targets.find((x) => x.entry_source === 'bank_statement');
  if (invented) {
    return { ok: false, status: 400, error:
      `Entry #${invented.id} was itself created from a bank line, so it is not an invoice.` };
  }
  // Matches live on the family root — the same basis the matcher uses.
  const rooted = targets.find((x) => x.parent_id);
  if (rooted) {
    return { ok: false, status: 400, error:
      `Entry #${rooted.id} is part of a split invoice — attach its parent (#${rooted.parent_id}) instead.` };
  }
  // TWO PAYMENTS, ONE INVOICE — the mirror of the case this endpoint was built
  // for. An invoice paid in instalments (a deposit and a balance, a wire split
  // across two days) is settled by several bank rows, and refusing the second
  // one outright left the only options as "match the wrong amount" or "leave
  // the invoice looking unpaid".
  //
  // So the test is no longer "is it claimed" but "would this OVERPAY it" —
  // the same rule, tolerance and currency basis /match has used since the
  // partial-payment guard was added there. Coverage counts BOTH the primary
  // column and live links, because either can be how an earlier payment was
  // recorded.
  for (const target of targets) {
    const { rows: [fam] } = await client.query(`
      SELECT e.id, COALESCE(e.currency, 'USD') AS currency, e.payee,
             e.amount + COALESCE((SELECT SUM(c.amount) FROM expenses c
                WHERE c.parent_id = e.id AND (c.deleted = false OR c.deleted IS NULL)
                  AND (c.voided = false OR c.voided IS NULL)), 0) AS family_total
        FROM expenses e WHERE e.id = $1`, [target.id]);
    if (!fam) continue;
    const { rows: others } = await client.query(`
      SELECT DISTINCT bt.id, bt.amount, bt.currency, bt.description, bt.txn_date
        FROM bank_transactions bt
        LEFT JOIN bank_txn_invoice_links bl ON bl.txn_id = bt.id
       WHERE bt.dismissed = false AND bt.id <> $2
         AND (bt.matched_expense_id = $1 OR (bl.expense_id = $1 AND bt.matched_expense_id IS NOT NULL))`,
    [target.id, t.id]).catch(() => ({ rows: [] }));
    if (!others.length) continue;
    let covered = 0;
    for (const o of others) covered += await amountInFamilyCurrency(o, fam);
    const mine = await amountInFamilyCurrency(t, fam);
    const famTotal = Number(fam.family_total);
    const fCur = (fam.currency || 'USD').toUpperCase();
    if (covered + mine > famTotal + 0.01) {
      const money = (n) => (fCur === 'USD' ? '$' : `${fCur} `) + Number(n).toFixed(2);
      return { ok: false, status: 409, error:
        `"${fam.payee}" is already covered by ${money(covered)} of its ${money(famTotal)} — adding ${money(mine)} `
        + 'would overpay it. Unmatch one of the other payments if this is the right one.' };
    }
  }

  // A debit that left the bank BEFORE an invoice existed cannot be paying it.
  //
  // /tx/:id/match has refused this since 8 live inverted matches were found —
  // up to 208 days, including a $10,000 debit dated nearly six months before
  // its invoice. This endpoint bypassed that check entirely, so the vendor page
  // (and now Bank Matching) could write exactly what /match refuses. Same test,
  // same escape hatch: a retainer or advance is the one legitimate case, and
  // saying so records it as a prepayment rather than waving it through.
  //
  // Checked over EVERY selected invoice, not just the primary — a consolidated
  // payment can carry one good invoice and one dated after the money moved.
  // Measured either way, because the audit line has to be able to SAY what was
  // overruled. The comment above claimed the override "records it as a
  // prepayment" and nothing did — an overridden pairing was indistinguishable
  // from an ordinary one, so the date inversion would read later as a bug
  // rather than as a decision somebody made on the evidence.
  const prepaid = [];
  if (t.txn_date) {
    const { rows: dated } = await client.query(
      `SELECT id, invoice_number, invoice_date FROM expenses WHERE id = ANY($1) AND invoice_date IS NOT NULL`, [ids]);
    for (const d of dated) {
      const daysEarly = (new Date(d.invoice_date) - new Date(t.txn_date)) / 86400000;
      if (daysEarly > 5) prepaid.push({ ...d, daysEarly: Math.round(daysEarly) });
    }
  }
  if (opts.allowPrepayment !== true && prepaid.length) {
    const d = prepaid[0];
    return {
      ok: false,
      status: 400,
      error: `That debit left the bank on ${isoDay(t.txn_date)}, ${d.daysEarly} days BEFORE `
        + `invoice ${d.invoice_number ? `#${d.invoice_number}` : `#${d.id}`} is dated (${isoDay(d.invoice_date)}) `
        + '— it can\'t be paying it unless it was a retainer or advance.',
      extra: {
        prepayment_possible: true,
        prepayment: {
          txn_date: isoDay(t.txn_date), invoice_date: isoDay(d.invoice_date),
          days_early: d.daysEarly,
          invoice_number: d.invoice_number || null, expense_id: d.id,
        },
      },
    };
  }

  return { ok: true, targets, prepaid };
}

/**
 * Settle one bank line with one or more invoices: check, write, audit.
 *
 * `ids[0]` becomes the primary (`matched_expense_id`); every id gets a link row.
 * One transaction — a half-applied settle would leave the ledger showing an
 * invoice settled by a payment that no longer has the booking it displaced.
 *
 * @param opts.userName  who to record as the matcher ('auto-matcher' from the matcher)
 * @param opts.user      the user object for the audit line, if there is one
 * @param opts.method    match_method to write; defaults to attach's manual/rematch rule
 * @param opts.score     match_score; 100 (a cent-exact settle) unless given
 * @param opts.note      extra sentence for the audit line, e.g. why the matcher did this
 * @param opts.allowPrepayment  override the 5-day inversion refusal
 */
async function settleTxnWithInvoices(client, t, ids, opts = {}) {
  // runMigrations() runs in the BACKGROUND after app.listen, so for the first
  // seconds of every deploy this table does not exist yet. The READ side
  // degrades silently (bank-evidence emits its pre-link SQL), but a write has
  // to say something, and "relation bank_txn_invoice_links does not exist" is
  // not something to put in front of a person mid-reconciliation.
  if (!linksAreReady()) {
    const ok = await markLinksReady(pool);
    if (!ok) {
      return { ok: false, status: 503, error:
        'Attaching invoices is still starting up after a deploy — try again in a few seconds.' };
    }
  }

  const checked = await settleChecks(client, t, ids, opts);
  if (!checked.ok) return checked;
  const { targets, prepaid } = checked;
  const userName = opts.userName || opts.user?.name || 'unknown';

  const primary = ids[0];
  await client.query('BEGIN');
  let unbookedEntryId = null;
  try {
    if (t.match_method === 'created' && t.matched_expense_id) {
      // Booked: displace the invented entry. Guarded on entry_source so this can
      // only ever remove a row the app created — never a real invoice, which is
      // the guard that saved entry #22.
      const { rows: [gone] } = await client.query(
        `UPDATE expenses SET deleted = true, deleted_by = $1, deleted_at = NOW()
          WHERE id = $2 AND entry_source = 'bank_statement' RETURNING id`,
        [userName, t.matched_expense_id]);
      if (!gone) {
        await client.query('ROLLBACK');
        return { ok: false, status: 400, error:
          'The entry on this row is not statement-created, so it is a real record — unbook or unmatch it first.' };
      }
      unbookedEntryId = gone.id;
      await client.query(`UPDATE expenses SET deleted = true, deleted_by = $1, deleted_at = NOW()
         WHERE parent_id = $2 AND entry_source = 'bank_statement'`, [userName, unbookedEntryId]);
    }
    // Re-pointing a plain match to a different invoice is allowed, because
    // /tx/:id/match always allowed it and this endpoint replaced every caller of
    // that one — "wrong invoice, use this one instead" is an ordinary correction
    // and refusing it here would have been a silent regression in the deck.
    // (A BOOKED row is different and is handled above: its invented entry has to
    // be displaced first, which is the branch that does it.)
    //
    // Old links go regardless. Without this, the invoices the row used to settle
    // keep their link rows and go on reading as settled by a payment that now
    // settles something else.
    await client.query(`DELETE FROM bank_txn_invoice_links WHERE txn_id = $1`, [t.id]);

    await client.query(
      `UPDATE bank_transactions SET matched_expense_id = $1,
         match_method = $2, match_score = $3, matched_by = $4, matched_at = NOW()
       WHERE id = $5`,
      [primary, opts.method || (unbookedEntryId ? 'rematch' : 'manual'),
        opts.score === undefined ? 100 : opts.score, userName, t.id]);
    for (const id of ids) {
      await client.query(
        `INSERT INTO bank_txn_invoice_links (txn_id, expense_id, created_by)
         VALUES ($1, $2, $3) ON CONFLICT (txn_id, expense_id) DO NOTHING`,
        [t.id, id, userName]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }

  await audit(opts.user || { name: userName }, 'statement_attached', primary, targets[0]?.payee,
    `Bank txn #${t.id} settled by ${ids.length} invoice${ids.length === 1 ? '' : 's'} `
    + `(${targets.map((x) => x.invoice_number ? '#' + x.invoice_number : 'entry ' + x.id).join(', ')})`
    + (unbookedEntryId ? `; its invented booking (entry #${unbookedEntryId}) was removed` : '')
    + (opts.note ? `. ${opts.note}` : '')
    + (prepaid.length
      ? `. RECORDED AS A PREPAYMENT on ${userName}'s say-so: the debit cleared ${isoDay(t.txn_date)}, `
        + `${prepaid.map((d) => `${d.invoice_number ? '#' + d.invoice_number : 'entry ' + d.id} is dated ${isoDay(d.invoice_date)} (${d.daysEarly}d later)`).join('; ')}`
        + ' — a retainer or advance, not a mismatch'
      : ''));

  return { ok: true, primary, linked: ids, unbookedEntryId, prepaid };
}

// POST /api/statements/tx/:txId/attach  { expense_ids: [1, 2, ...] }
//
// Settle ONE bank line with ONE OR MORE invoices.
//
// The matcher can only express one-to-one — it pairs on an amount equal to the
// cent — so a vendor paid for two invoices in a single transfer was unreconcilable
// by construction. Measured live: 8 such payments over 5 vendors, every part
// already marked Paid on the day the money moved.
//
// This is a superset of the two existing verbs, and which one applies is decided
// by the ROW, never by the caller:
//
//   open   → link the primary, exactly as /tx/:id/match does
//   booked → soft-delete the entry the app invented and link the primary, exactly
//            as /tx/:id/rematch does. That step is why this cannot be "just insert
//            some rows": leaving the invented entry behind would double-count the
//            payment, once as an invented expense and once as the real invoices.
//
// Then a link row per invoice, INCLUDING the primary, so bank_txn_invoice_links
// answers "what did this payment settle" on its own.
//
// One transaction. A half-applied attach is the worst outcome available here:
// the ledger would show an invoice settled by a payment that no longer has the
// booking it displaced.
router.post('/tx/:txId(\\d+)/attach', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const ids = [...new Set((Array.isArray(req.body.expense_ids) ? req.body.expense_ids : [])
      .map((x) => parseInt(x, 10)).filter(Number.isFinite))];
    if (!ids.length) return res.status(400).json({ success: false, error: 'expense_ids required' });

    const { rows: [t] } = await client.query(`SELECT * FROM bank_transactions WHERE id = $1`, [req.params.txId]);
    if (!t) return res.status(404).json({ success: false, error: 'Transaction not found' });

    const r = await settleTxnWithInvoices(client, t, ids, {
      user: req.user,
      userName: req.user.name,
      allowPrepayment: req.body.allow_prepayment === true,
    });
    if (!r.ok) {
      return res.status(r.status || 400).json({ success: false, error: r.error, ...(r.extra || {}) });
    }
    res.json({ success: true, data: {
      matched_expense_id: r.primary, linked: r.linked, unbooked_entry_id: r.unbookedEntryId } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/statements/tx/:txId/unattach — the inverse of the above.
//
// Clears every link and reverses the primary the RIGHT way, which depends on how
// the row got here: a row whose booking was displaced goes back to BOOKED (via
// the same restore /unrematch performs), not to open — that distinction is the
// dead end fixed in 6ef64a5, and it applies identically here.
// Detach whatever a bank row settles, and put back what the attach displaced.
//
// The one inverse, in one place: the single-row endpoint and the bulk one both
// call this, so "unmatch" cannot come to mean two things. Undoing a REMATCH
// restores the booking it soft-deleted and leaves the row BOOKED, not open —
// leaving it open is the dead end fixed in 6ef64a5, and the row could then
// never be rematched again.
//
// Returns what the row became, so a caller can report it rather than assume.
async function detachTxn(txnId, userName) {
  const { rows: [t] } = await pool.query(`SELECT * FROM bank_transactions WHERE id = $1`, [txnId]);
  if (!t) return { ok: false, reason: 'not found' };
  if (!t.matched_expense_id) return { ok: false, reason: 'settles nothing' };

  await pool.query(`DELETE FROM bank_txn_invoice_links WHERE txn_id = $1`, [t.id]).catch(() => {});

  if (t.match_method === 'rematch') {
    // Same derivation /unrematch uses — a soft-deleted statement-created entry
    // whose note names this txn.
    const note = `Created from bank statement debit #${t.id}`;
    const { rows: [entry] } = await pool.query(
      `SELECT id FROM expenses WHERE entry_source = 'bank_statement' AND deleted = true AND notes = $1
        ORDER BY id DESC LIMIT 1`, [note]);
    if (entry) {
      await pool.query(`UPDATE expenses SET deleted = false, deleted_by = NULL, deleted_at = NULL WHERE id = $1`, [entry.id]);
      await pool.query(`UPDATE expenses SET deleted = false, deleted_by = NULL, deleted_at = NULL
         WHERE parent_id = $1 AND entry_source = 'bank_statement'`, [entry.id]).catch(() => {});
      await pool.query(
        `UPDATE bank_transactions SET matched_expense_id = $1, match_method = 'created',
           match_score = NULL, matched_by = $2, matched_at = NOW() WHERE id = $3`,
        [entry.id, userName, t.id]);
      return { ok: true, txn: t, matched_expense_id: entry.id, match_method: 'created', restored: entry.id };
    }
    // No booking to restore (it was an open row when attached): fall through.
  }
  await pool.query(
    `UPDATE bank_transactions SET matched_expense_id = NULL, match_method = NULL, match_score = NULL,
       matched_by = NULL, matched_at = NULL WHERE id = $1`, [t.id]);
  return { ok: true, txn: t, matched_expense_id: null, match_method: null, restored: null };
}

router.post('/tx/:txId(\\d+)/unattach', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const r = await detachTxn(req.params.txId, req.user.name);
    if (!r.ok) {
      return res.status(r.reason === 'not found' ? 404 : 400).json({ success: false,
        error: r.reason === 'not found' ? 'Transaction not found' : 'This row settles nothing' });
    }
    await audit(req.user, 'statement_unattached', r.restored, r.txn.payee_guess,
      r.restored
        ? `Invoices detached from bank txn #${r.txn.id}; its booking (entry #${r.restored}) was restored`
        : `Invoices detached from bank txn #${r.txn.id}; the row is open again`);
    res.json({ success: true, data: { matched_expense_id: r.matched_expense_id, match_method: r.match_method } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/statements/unmatch/bulk { txn_ids } — detach a selection.
//
// PER ROW, never all-or-nothing. A selection of fifty will contain rows that
// moved under the caller — already unmatched by somebody else, or booked rather
// than matched — and failing the batch because one row disagrees makes the
// action useless on exactly the selections people make. What was skipped is
// reported rather than silently dropped, the same contract /no-invoice/bulk has.
router.post('/unmatch/bulk', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const ids = Array.isArray(req.body.txn_ids)
      ? [...new Set(req.body.txn_ids.map(Number).filter(Number.isFinite))].slice(0, 500) : [];
    if (!ids.length) return res.status(400).json({ success: false, error: 'Select at least one row' });

    const done = [];
    const restored = [];
    const skipped = [];
    for (const id of ids) {
      const r = await detachTxn(id, req.user.name).catch((e) => ({ ok: false, reason: e.message }));
      if (!r.ok) { skipped.push({ id, reason: r.reason }); continue; }
      done.push(id);
      if (r.restored) restored.push(id);
    }
    if (done.length) {
      await audit(req.user, 'statement_unattached_bulk', null, null,
        `${done.length} bank row(s) detached from their invoices`
        + (restored.length ? `; ${restored.length} went back to BOOKED with the entry the attach had displaced` : '')
        + (skipped.length ? `; ${skipped.length} skipped` : ''));
    }
    res.json({ success: true, data: { done: done.length, ids: done, restored, skipped } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/statements/vendor/bulk { txn_ids, ledger_payee }  ·  { clear: true }
//
// The same per-row move as /tx/:id/vendor, for a selection. Vendor pages hold
// 46, 151, 195 lines; answering "these twelve PayPal pulls were all the Gersh
// Agency" one row at a time is not a feature, it is a way to half-finish.
//
// Per-row outcomes, never all-or-nothing: a selection of fifty will contain rows
// that moved under the caller, and failing the batch on one is what makes a bulk
// action useless on exactly the selections people make.
router.post('/vendor/bulk', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const ids = Array.isArray(req.body.txn_ids)
      ? [...new Set(req.body.txn_ids.map(Number).filter(Number.isFinite))].slice(0, 500) : [];
    if (!ids.length) return res.status(400).json({ success: false, error: 'Select at least one row' });

    const clearing = req.body.clear === true;
    const target = String(req.body.ledger_payee || '').trim();
    if (!clearing) {
      if (!target) return res.status(400).json({ success: false, error: 'ledger_payee required' });
      if (target.length > 200) return res.status(400).json({ success: false, error: 'ledger_payee is too long' });
      // Checked ONCE for the batch, not per row — same test as the single move.
      const { rows: [known] } = await pool.query(
        `SELECT 1 AS ok
           WHERE EXISTS (SELECT 1 FROM expenses WHERE LOWER(TRIM(payee)) = LOWER($1))
              OR EXISTS (SELECT 1 FROM vendor_aliases
                          WHERE LOWER(TRIM(primary_name)) = LOWER($1)
                             OR LOWER(TRIM(alias)) = LOWER($1))`,
        [target]);
      if (!known && req.body.confirm_new !== true) {
        return res.status(400).json({ success: false,
          error: `No ledger vendor is named "${target}". Check the spelling, or pass confirm_new to create the association anyway.` });
      }
    }

    // Every column applyVendorOverride reads. payee_guess and payee_email feed
    // resolveBookingPayee when a clear has to reconstruct the original name.
    const { rows: live } = await pool.query(
      `SELECT id, payee_guess, payee_email, matched_expense_id
         FROM bank_transactions WHERE id = ANY($1::int[])`, [ids])
      // Degrades the same way the reads do: the column is young, and
      // runMigrations() runs in the background after app.listen.
      .catch((err) => {
        if (!/vendor_override/.test(err.message || '')) throw err;
        return { rows: null };
      });
    if (live === null) {
      return res.status(503).json({ success: false,
        error: 'Moving lines to another vendor is still starting up — try again in a few seconds.' });
    }
    const liveIds = new Set(live.map((r) => r.id));
    const skipped = ids.filter((id) => !liveIds.has(id)).map((id) => ({ id, reason: 'No such transaction' }));

    // Row by row, through the SAME helper the single move uses, so the ledger
    // side cannot be handled one way here and another way there. A batch UPDATE
    // would be one query and would silently skip the bookings.
    const done = [];
    let entriesMoved = 0;
    for (const txn of live) {
      const r = await applyVendorOverride(txn, clearing ? null : target, req.user)
        .catch(() => null);
      if (!r) { skipped.push({ id: txn.id, reason: 'Could not be moved' }); continue; }
      done.push(txn.id);
      if (r.entry_moved) entriesMoved++;
    }

    if (done.length) {
      await audit(req.user, clearing ? 'bank_txn_vendor_cleared_bulk' : 'bank_txn_vendor_moved_bulk', null, null,
        (clearing
          ? `${done.length} bank line(s) returned to their descriptors' vendors`
          : `${done.length} bank line(s) moved to vendor "${target}" — those lines only; `
            + `every other line from their descriptors is unaffected`)
        + (entriesMoved ? `; ${entriesMoved} booked entr${entriesMoved === 1 ? 'y' : 'ies'} moved with them` : '')
        + (skipped.length ? `; ${skipped.length} skipped` : ''));
    }
    res.json({ success: true, data: {
      done: done.length, ids: done, skipped, entries_moved: entriesMoved,
      ledger_payee: clearing ? null : target,
    } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Bank rows answered one at a time: "this one never had an invoice."
//
// Read as its OWN query rather than a column in the callers' SELECTs, because
// runMigrations() runs in the BACKGROUND after app.listen (server/index.js) —
// so on every deploy there is a window where the column does not exist yet, and
// a SELECT naming it takes the whole endpoint down with it. Coverage, the Open
// chip and the rematch proposals all read this; none of them should break for a
// few seconds after each deploy, or permanently if an earlier migration throws.
//
// Degrades to "nothing is flagged", which is what was true before the column.
//
// A `function` declaration, not a const arrow: /rematch-candidates is defined
// ABOVE this point and calls it, and a hoisted declaration makes that ordering
// a non-question rather than a fact about when handlers happen to run.
// "Nobody expects an invoice for this row" — the ONE definition.
//
// Three scopes, one answer, and the row's own flag is checked FIRST because it
// needs no rule behind it: "this Uber had no invoice" is the scope people reach
// for before "every Uber does".
//
// Extracted from /completion because the vendors directory needs the same answer.
// Re-deriving it there would have made a fifth number on a page that already had
// two controls disagreeing by 146×, which is the failure this endpoint exists to
// prevent — so the directory calls this instead.
//
// EQUALITY, never substring. "TONE" ($615k, the largest vendor) is a substring of
// "Tone Pay, Inc" and "Dean St" of "Dean Street Media", so a substring rule
// silently swallows the neighbour.
//
// Returns a predicate over a row carrying { id, category, payee, payee_guess }.
// "This vendor's spend isn't an artist's" — the overhead answer, which is the
// only thing that takes a vendor OUT of the needs-an-artist queue (attributing
// one writes the artist, so those rows leave by themselves).
//
// Extracted because three surfaces now ask it — the queue at /unattributed, the
// vendors directory count, and the vendor page's own band — and a directory
// flag that disagrees with the page it links to is the failure this codebase
// keeps paying for. Equality, never substring: "TONE" is a substring of "Tone
// Pay, Inc", and hiding $615k behind somebody else's answer is silent.
async function makeOverheadAnswered() {
  const { rows } = await pool.query(
    `SELECT pattern FROM statement_artist_rules WHERE is_overhead = TRUE`)
    // A young table, and runMigrations() runs in the BACKGROUND after
    // app.listen — degrade to "nothing is answered" rather than 500 the
    // directory for the first seconds of every deploy.
    .catch(() => ({ rows: [] }));
  const set = new Set(rows.map((r) => String(r.pattern || '').trim().toLowerCase()));
  return (...names) => names.some((n) => n && set.has(String(n).trim().toLowerCase()));
}

// Does this bank row still need an artist? Booked (an entry we invented, so no
// invoice says who it was for), alive, and nobody has answered its vendor.
// ONE definition, so the directory's count, the vendor page's band and the
// queue cannot report three different numbers.
const needsArtist = (t, answeredOverhead) =>
  !t.dismissed
  && t.match_method === 'created'
  && !!t.matched_expense_id
  // A PLACEHOLDER IS NOT AN ANSWER. This tested emptiness alone, so an entry
  // holding the literal "unknown" or "N/A" counted as attributed here while the
  // P&L, Spend by Artist and the artist drill all counted it as nobody's — the
  // vendor page reported nothing left to do on money the report showed as
  // unattributed. 43 live entries / $272,931.32 are in that state.
  && !namesAnArtist(t.artist)
  && !answeredOverhead(t.ledger_payee || t.payee, t.payee_guess);

async function makeNoInvoiceExpected() {
  const { rows: ruleRows } = await pool.query(
    `SELECT scope, pattern FROM statement_no_invoice_rules`).catch(() => ({ rows: [] }));
  const norm = (v) => String(v || '').trim().toLowerCase();
  const catRules = new Set(ruleRows.filter((r) => r.scope === 'category').map((r) => norm(r.pattern)));
  const venRules = new Set(ruleRows.filter((r) => r.scope === 'vendor').map((r) => norm(r.pattern)));
  const rowFlagged = await loadNoInvoiceRowIds();
  return (r) => rowFlagged.has(r.id)
    || catRules.has(norm(r.category))
    || venRules.has(norm(r.payee)) || venRules.has(norm(r.payee_guess));
}

async function loadNoInvoiceRowIds() {
  const { rows } = await pool.query(
    `SELECT id FROM bank_transactions WHERE COALESCE(no_invoice_expected, false) = true`)
    .catch(() => ({ rows: [] }));
  return new Set(rows.map((r) => r.id));
}

// ── Completion: booked is not the same as matched ────────────────────────────
//
// A BOOKED row is an entry the app invented from a bank line — a ledger id with
// no document behind it. A MATCHED row is tied to an invoice a vendor actually
// sent. This page exists to turn the first into the second, so it should not
// report them as the same thing. Coverage read 94% by counting booked as
// resolved; by the stricter definition it is 38%.
//
// Both numbers are true and they answer different questions — "is every bank
// line accounted for at all" vs "does it have a document behind it" — so the
// card shows both rather than picking one and being quietly wrong.
//
// ONE endpoint computes this because Coverage and the queue must never
// disagree about what "done" means; the client filters by the id set returned
// here rather than re-implementing the rule matching.
router.get('/completion', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    // Scoped to the selected statement when the page is narrowed to one.
    //
    // The page's table has always followed the statement selector. This
    // endpoint did not, so picking a month put "Explained 73% of $1,033,848"
    // directly above "Invoice-backed 37.9% of $5,773,792" on one card — two
    // percentages over different denominators, inviting a comparison that is
    // meaningless. Same for the Needs-invoice chip, whose count was 7x the
    // rows behind it.
    const stmtId = parseInt(req.query.statement_id, 10);
    const scoped = Number.isFinite(stmtId);
    // Always fetched UNSCOPED, then narrowed in JS.
    //
    // Because the per-statement breakdown below has to cover every statement
    // even while the page is narrowed to one — that is exactly when "what else
    // is left" matters — and because it must come from THIS loop. The selector
    // used to read bank_statements.open_debits, which counts only rows with no
    // ledger entry at all: it said "19 left" beside a queue of 1,765, a 146×
    // disagreement between two controls an inch apart. One definition, or the
    // page argues with itself.
    const { rows: allRows } = await pool.query(`
      SELECT bt.id, bt.statement_id, bt.txn_date, bt.payee_guess, bt.description,
             bt.match_method, bt.amount, COALESCE(bt.currency, 'USD') AS currency,
             bt.matched_expense_id, e.payee, e.category
        FROM bank_transactions bt
        LEFT JOIN expenses e ON e.id = bt.matched_expense_id
       WHERE bt.direction = 'debit' AND bt.dismissed = false`);
    const rows = scoped ? allRows.filter((r) => r.statement_id === stmtId) : allRows;
    // USD via the canonical converter, NOT the stored amount_usd column.
    //
    // /statements/all converts at request time from the live rate cache, so a
    // card built on amount_usd disagreed with the very page it sits on — by
    // $387,039 on live data, because a foreign row with a null amount_usd
    // falls back to its face value and gets counted as dollars. Two totals for
    // one thing on one screen is the drift lib/usd.js exists to prevent, and
    // its own header warns against exactly this second copy.
    //
    // bank_transactions carries no locked rate (fx_rate_to_usd is on expenses),
    // so usdOf with no third argument is precisely what the payload does.
    // On allRows, not the narrowed subset — the per-statement breakdown below
    // needs money for statements the current filter excludes.
    for (const r of allRows) r.usd = Math.abs(usdOf(r.amount, r.currency));

    // The predicate lives in makeNoInvoiceExpected so the vendors directory can
    // ask the same question. `rules` and `norm` are still needed HERE — the
    // payload returns the rule list, and the category-candidate loop below keys
    // vendors by the same normalisation — so they are re-read rather than the
    // predicate leaking its internals back out.
    const noInvoiceExpected = await makeNoInvoiceExpected();
    const { rows: ruleRows } = await pool.query(
      `SELECT scope, pattern FROM statement_no_invoice_rules`).catch(() => ({ rows: [] }));
    const norm = (v) => String(v || '').trim().toLowerCase();

    // ── Five dispositions, and only ONE of them is invoice-backed ──
    //
    // `creator` is checked BEFORE the generic non-'created' test, because a
    // creator match is not 'created' either and would otherwise fall into
    // `matched` — which is precisely what `invoice_backed_pct` reduces over
    // below. A creator payment explains its bank line and has no document; the
    // separation is the entire reason it is allowed to match at all.
    const bucket = { matched: [], creator: [], booked_expected: [], booked_not_expected: [], open: [] };
    for (const r of rows) {
      if (!r.matched_expense_id) bucket.open.push(r);
      else if (r.match_method === 'creator') bucket.creator.push(r);
      else if (r.match_method !== 'created') bucket.matched.push(r);
      else if (noInvoiceExpected(r)) bucket.booked_not_expected.push(r);
      else bucket.booked_expected.push(r);
    }

    // ── LEFT TO MATCH, per statement ─────────────────────────────────────────
    //
    // The SAME membership test as the Open chip and the queue — a row with no
    // ledger entry, or one with an invented entry and no invoice behind it —
    // computed in this loop so the statement selector cannot drift from the
    // number in the page title. It did, by 146×.
    //
    // Runs over allRows so it describes every statement regardless of the filter.
    const byStatement = {};
    for (const r of allRows) {
      const left = !r.matched_expense_id
        || (r.match_method === 'created' && !noInvoiceExpected(r));
      const g = byStatement[r.statement_id] || (byStatement[r.statement_id] = { left: 0, left_value: 0, debits: 0 });
      g.debits += 1;
      if (left) { g.left += 1; g.left_value += Number(r.usd || 0); }
    }
    // Rounded once, at the end — summing already-rounded parts has broken a
    // tie-out on this page by exactly a cent before.
    for (const g of Object.values(byStatement)) g.left_value = Math.round(g.left_value * 100) / 100;
    const agg = (a) => ({ n: a.length, value: Math.round(a.reduce((s, r) => s + Number(r.usd || 0), 0) * 100) / 100 });
    const total = rows.reduce((s, r) => s + Number(r.usd || 0), 0);
    const pct = (v) => (total > 0 ? Math.round((v / total) * 1000) / 10 : 100);

    // Vendors in the expected pile, biggest money first — the actual worklist.
    const byVendor = new Map();
    for (const r of bucket.booked_expected) {
      const name = (r.payee || r.payee_guess || '(no payee)').trim();
      const k = name.toLowerCase();
      const g = byVendor.get(k) || { key: k, vendor: name, rows: [], total: 0, categories: {} };
      g.rows.push({ txn_id: r.id, txn_date: r.txn_date, description: r.description,
        usd: Number(r.usd || 0), category: r.category, expense_id: r.matched_expense_id });
      g.total += Number(r.usd || 0);
      g.categories[r.category || '—'] = (g.categories[r.category || '—'] || 0) + 1;
      byVendor.set(k, g);
    }

    // Categories where NOT ONE vendor has ever sent us an invoice — offered as
    // suggested answers WITH their evidence, never applied automatically. Ten
    // of these are most of the $1.95M that can never be matched.
    const { rows: invRows } = await pool.query(
      `SELECT DISTINCT LOWER(TRIM(payee)) AS p FROM expenses
        WHERE invoice_number IS NOT NULL AND TRIM(invoice_number) <> ''
          AND (deleted = false OR deleted IS NULL)`).catch(() => ({ rows: [] }));
    const everInvoiced = new Set(invRows.map((r) => r.p));
    const catStat = new Map();
    for (const r of bucket.booked_expected) {
      const c = (r.category || '—').trim();
      const st = catStat.get(c) || { category: c, n: 0, value: 0, invoiced_vendors: 0, vendors: new Set() };
      st.n += 1; st.value += Number(r.usd || 0);
      const p = norm(r.payee || r.payee_guess);
      if (p && !st.vendors.has(p)) {
        st.vendors.add(p);
        if (everInvoiced.has(p)) st.invoiced_vendors += 1;
      }
      catStat.set(c, st);
    }
    const category_candidates = [...catStat.values()]
      .filter((c) => c.invoiced_vendors === 0 && c.n > 0)
      .map((c) => ({ category: c.category, n: c.n, value: Math.round(c.value * 100) / 100, vendors: c.vendors.size }))
      .sort((a, b) => b.value - a.value);

    res.json({
      success: true,
      data: {
        matched: agg(bucket.matched),
        creator: agg(bucket.creator),
        booked_expected: agg(bucket.booked_expected),
        booked_not_expected: agg(bucket.booked_not_expected),
        open: agg(bucket.open),
        total: Math.round(total * 100) / 100,
        // EXPLAINED is "not open", so creator payments count here — a line the
        // marketing team has accounted for is accounted for.
        explained_pct: pct(total - bucket.open.reduce((s, r) => s + Number(r.usd || 0), 0)),
        // INVOICE-BACKED reduces over `bucket.matched` alone. Creator payments
        // are deliberately absent: there is no invoice behind them and this
        // number must never say otherwise.
        invoice_backed_pct: pct(bucket.matched.reduce((s, r) => s + Number(r.usd || 0), 0)),
        needs_invoice_txn_ids: bucket.booked_expected.map((r) => r.id),
        // { [statement_id]: { left, left_value, debits } } — always every
        // statement, so the selector reads the same definition the title does.
        by_statement: byStatement,
        // What "left to match" totals across every statement, whatever the
        // current filter. This is the page's headline number.
        left_all: Object.values(byStatement).reduce((s, g) => s + g.left, 0),
        left_all_value: Math.round(Object.values(byStatement)
          .reduce((s, g) => s + g.left_value, 0) * 100) / 100,
        vendors: [...byVendor.values()].sort((a, b) => b.total - a.total),
        category_candidates,
        rules: ruleRows,
        statement_id: scoped ? stmtId : null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Reconciliation: what each statement has answered, and in what money ──────
//
// The library's month rows already carried a coverage bar, but /statements/months
// computes it as (matched + dismissed) / debits — and `matched_expense_id` is set
// on a BOOKED row too, an entry this app invented from the bank line with no
// document behind it. By that rule the library reported a month nearly clear
// while Bank Matching, one click away, held hundreds of rows of work on the same
// statements. Both figures were computed honestly; neither was labelled; the two
// pages simply disagreed.
//
// This returns ONE breakdown per statement, in counts and USD. The client sums
// the very statements it renders to get the month subtotal and the page total,
// so a band can never state a figure the list beneath it contradicts.
//
// Six buckets for money out, and they PARTITION the debits. `dismissed` is
// tested first: an excluded row is excluded whatever was once done to it, and
// the three counts overlap otherwise (a row can be dismissed after matching).
//
//   matched         tied to an invoice a vendor actually sent
//   creator         a creator payment — explained, and undocumented by design
//   no_invoice_due  booked, and a rule says no invoice is coming (bank fees)
//   needs_invoice   booked, and a document SHOULD exist — this is NOT done
//   open            no ledger entry at all
//   excluded        dismissed — deliberately out of scope
//
// ACCOUNTED FOR = matched + creator + no_invoice_due, which is exactly Bank
// Matching's "Categorized" chip. LEFT = needs_invoice + open, exactly its "For
// review" chip. The two pages now answer with the same sets, so every figure
// here can deep-link to the rows behind it and land on the same number.
//
// Money in is a SEPARATE side and is never summed with money out. A credit
// matches artist_income, not an invoice, and a statement carrying unbooked
// deposits is not reconciled — which a debit-only view could not say.
router.get('/reconciliation', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    // The SAME predicate the completion card and the Needs-invoice queue read.
    // Re-deriving the no-invoice rules here is how three copies of one money
    // rule end up disagreeing — it needs r.category and r.payee off the matched
    // entry, which is why the join below is a LEFT JOIN on expenses.
    const noInvoiceExpected = await makeNoInvoiceExpected();
    // EVERY column that predicate reads, or it answers on a missing field and
    // says so silently. `payee_guess` was omitted on the first version of this
    // query: a vendor rule matches the LEDGER payee OR the BANK descriptor, so
    // 50 live rows on one statement whose rule keys on the descriptor were
    // reported as still owing an invoice — 101 left against the queue's 51, the
    // exact disagreement this endpoint exists to end.
    const { rows } = await pool.query(`
      SELECT bt.id, bt.statement_id, bt.direction, bt.dismissed, bt.match_method,
             bt.amount, COALESCE(bt.currency, 'USD') AS currency,
             bt.payee_guess, bt.matched_expense_id, bt.matched_income_id,
             e.payee, e.category
        FROM bank_transactions bt
        LEFT JOIN expenses e ON e.id = bt.matched_expense_id`);

    const blank = (keys) => Object.fromEntries(keys.map((k) => [k, { n: 0, value: 0 }]));
    const by = {};

    for (const r of rows) {
      const g = by[r.statement_id]
        || (by[r.statement_id] = { debits: blank(DEBIT_BUCKETS), credits: blank(CREDIT_BUCKETS) });
      const side = r.direction === 'credit' ? g.credits : g.debits;
      const k = bucketKey(r, noInvoiceExpected);
      side[k].n += 1;
      // usdOf, never bt.amount_usd. A foreign row with a null amount_usd falls
      // back to its face value and gets counted as dollars — the column was
      // $387,039 adrift from this converter the last time a card was built on
      // it. bank_transactions carries no locked rate (fx_rate_to_usd lives on
      // expenses), so the two-argument call is the whole conversion.
      side[k].value += Math.abs(usdOf(r.amount, r.currency));
    }

    // Deliberately NOT rounded here. The client sums these into month subtotals
    // and a page total, and summing already-rounded parts has broken a tie-out
    // on these pages by exactly a cent before. Round once, at display.
    res.json({ success: true, data: { by_statement: by } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create a rule on its own, with no transaction involved.
//
// Both of these could previously only be born as a SIDE EFFECT of acting on a
// row — category rules via create-entry {always:true}, dismiss rules via
// dismiss {always:true}. A rule learned from history has no row to act on: the
// 195 FACEBOOK charges are already booked, and re-booking one to save the rule
// would be a write nobody asked for.
router.post('/category-rules', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const pattern = String(req.body.pattern || '').trim().slice(0, 120);
    const category = String(req.body.category || '').trim().slice(0, 100);
    if (pattern.length < 3) return res.status(400).json({ success: false, error: 'pattern must be at least 3 characters' });
    if (!category) return res.status(400).json({ success: false, error: 'category required' });
    const { rows: [rule] } = await pool.query(
      `INSERT INTO statement_category_rules (pattern, category, created_by) VALUES ($1, $2, $3) RETURNING *`,
      [pattern, category, req.user?.name || 'unknown']);

    // BOTH HALVES OR NEITHER.
    //
    // A category rule on its own MANUFACTURES queue work. applyCategoryRules
    // books through bookDebitAsEntry, so every rule-booked row lands with
    // match_method='created' — which /completion counts as "still needs an
    // invoice". Measured before this existed: 6 of the 10 rules in force were
    // unpaired and were feeding 137 rows / $26,528 into the queue they looked
    // like they were clearing, growing with every upload.
    //
    // So the caller can say "and no invoice is ever coming for this vendor" in
    // the same call. Two client calls would leave exactly the unpaired rule this
    // fixes if the second one failed — and the failure is invisible, because a
    // rule that quietly feeds the queue looks identical to one that doesn't.
    //
    // The pattern here is the LEDGER payee, not the descriptor the booking rule
    // matches: /completion's venRules compares it by EQUALITY against e.payee.
    // Substring would swallow the neighbour ("TONE" inside "Tone Pay, Inc").
    const niPattern = String(req.body.no_invoice_pattern || '').trim().slice(0, 120);
    let noInvoiceRule = null;
    if (niPattern) {
      try {
        const { rows: [ni] } = await pool.query(
          `INSERT INTO statement_no_invoice_rules (scope, pattern, created_by)
           VALUES ('vendor', $1, $2)
           ON CONFLICT (scope, LOWER(TRIM(pattern))) DO UPDATE SET created_at = NOW()
           RETURNING *`,
          [niPattern, req.user?.name || 'unknown']);
        noInvoiceRule = ni;
      } catch (err) {
        await pool.query(`DELETE FROM statement_category_rules WHERE id = $1`, [rule.id]).catch(() => {});
        return res.status(500).json({
          success: false,
          error: `Could not record "${niPattern}" as never invoicing, so the booking rule was rolled back `
            + `rather than left feeding the needs-invoice queue: ${err.message}`,
        });
      }
    }

    await audit(req.user, 'statement_category_rule_added', null, pattern,
      `Learned from history: always book "${pattern}" as ${category}`
      + (niPattern ? ` — and "${niPattern}" never sends an invoice, so these stop counting as unfinished` : ''));
    res.json({ success: true, data: { ...rule, no_invoice_rule: noInvoiceRule } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/rules', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const pattern = String(req.body.pattern || '').trim().slice(0, 120);
    if (pattern.length < 3) return res.status(400).json({ success: false, error: 'pattern must be at least 3 characters' });
    const { rows: [rule] } = await pool.query(
      `INSERT INTO statement_dismiss_rules (pattern, created_by) VALUES ($1, $2) RETURNING *`,
      [pattern, req.user?.name || 'unknown']);
    await audit(req.user, 'statement_dismiss_rule_added', null, pattern,
      `Learned from history: always set aside "${pattern}"`);
    res.json({ success: true, data: rule });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/no-invoice-rules', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows } = await pool.query(`SELECT * FROM statement_no_invoice_rules ORDER BY created_at DESC`);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Accepts `pattern` or `patterns` — one call either way.
//
// `patterns` exists because pairing an existing category rule needs a vendor
// rule per ledger payee its rows resolve to, and a rule that ends up
// half-paired is the leak this is fixing: the row count on the page would drop
// by less than it promised and nothing would say why.
router.post('/no-invoice-rules', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const scope = String(req.body.scope || '').trim();
    const list = (Array.isArray(req.body.patterns) ? req.body.patterns : [req.body.pattern])
      .map((p) => String(p || '').trim()).filter((p) => p.length >= 2);
    if (!['category', 'vendor'].includes(scope)) return res.status(400).json({ success: false, error: "scope must be 'category' or 'vendor'" });
    if (!list.length) return res.status(400).json({ success: false, error: 'pattern too short' });
    const written = [];
    try {
      for (const pattern of list) {
        const { rows: [rule] } = await pool.query(
          `INSERT INTO statement_no_invoice_rules (scope, pattern, created_by) VALUES ($1, $2, $3)
           ON CONFLICT (scope, LOWER(TRIM(pattern))) DO UPDATE SET created_at = NOW()
           RETURNING *`, [scope, pattern, req.user?.name || 'unknown']);
        written.push(rule);
      }
    } catch (err) {
      // All or nothing. A partial accept quietly under-delivers on the row count
      // it just promised, which is indistinguishable from the rule not working.
      const ids = written.map((r) => r.id);
      if (ids.length) await pool.query(`DELETE FROM statement_no_invoice_rules WHERE id = ANY($1)`, [ids]).catch(() => {});
      return res.status(500).json({ success: false, error: `Nothing was saved (${err.message})` });
    }
    await audit(req.user, 'no_invoice_rule_set', null, list[0],
      `Marked ${list.length === 1 ? `${scope} "${list[0]}"` : `${list.length} ${scope}s (${list.join(', ')})`} as never having an invoice`);
    res.json({ success: true, data: written.length === 1 ? written[0] : written });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Deleting puts those rows straight back in the queue — nothing about the
// ledger changes, because this rule never wrote to it. It only ever said
// "stop asking me about these".
router.delete('/no-invoice-rules/:id(\\d+)', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    await pool.query(`DELETE FROM statement_no_invoice_rules WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Artist attribution: the booked pile ──────────────────────────────────────
//
// The page's open queue is ~20 rows. The real reconciliation debt is the 2,320
// rows worth $3.26M that were BOOKED — an entry typed from the bank line — and
// therefore carry a category but no artist and no invoice. That is why Spend by
// Artist reports a sixth of actual spend.
//
// GET /api/statements/unattributed groups them by vendor and orders by money,
// because the money is concentrated: the top 25 vendors are 79% of it. The
// unit of work is a vendor, not a row.
router.get('/unattributed', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows } = await pool.query(`
      SELECT bt.id AS txn_id, bt.txn_date, bt.payee_guess, bt.description,
             bt.amount, bt.amount_usd, bt.currency, st.account,
             e.id AS expense_id, e.payee, e.category, e.artist
        FROM bank_transactions bt
        JOIN expenses e ON e.id = bt.matched_expense_id
        JOIN bank_statements st ON st.id = bt.statement_id
       WHERE bt.direction = 'debit'
         AND bt.dismissed = false
         AND bt.match_method = 'created'
         AND (e.deleted = false OR e.deleted IS NULL)
         AND COALESCE(TRIM(e.artist), '') = ''
       ORDER BY ABS(COALESCE(bt.amount_usd, bt.amount)) DESC`);

    // Answered vendors drop out — by the SAME equality rule the booking path
    // uses, so the queue can never disagree with what will actually fire.
    // Substring matching here hid "Tone Pay, Inc" behind a "TONE" rule: $975
    // quietly gone from the worklist without anyone having answered it.
    // ONLY overhead rules hide a vendor.
    //
    // An attributed vendor needs no filter at all: the SQL above already drops
    // any row that has an artist, so attributing a vendor removes its rows
    // automatically, and any row that did NOT get written stays visible. That
    // is the self-healing behaviour — a partial write shows up as leftovers to
    // finish rather than a vendor that looks done while its rows sit empty.
    //
    // Overhead is the one answer with nothing to write: those rows keep a null
    // artist on purpose, so without this they would come back forever.
    const overhead = await makeOverheadAnswered();
    const answered = (r) => overhead(r.payee, r.payee_guess);

    const groups = new Map();
    let answeredCount = 0;
    for (const r of rows) {
      if (answered(r)) { answeredCount += 1; continue; }
      const name = (r.payee || r.payee_guess || '(no payee)').trim();
      const key = name.toLowerCase();
      const g = groups.get(key) || { key, vendor: name, rows: [], total: 0, categories: {} };
      g.rows.push(r);
      // usdOf, never amount_usd. All 97 non-USD rows in this queue have a NULL
      // amount_usd, so the fallback counted a JPY/PHP/BRL debit at FACE VALUE
      // as dollars — ¥237,858 read as $237,858 — and the queue reported
      // $3,735,162 against the directory's $3,351,641 for the same rows. Same
      // trap that once put $6.16M on a page whose real figure was $5.77M.
      g.total += Math.abs(usdOf(r.amount, r.currency));
      g.categories[r.category || '—'] = (g.categories[r.category || '—'] || 0) + 1;
      groups.set(key, g);
    }
    const list = [...groups.values()].sort((a, b) => b.total - a.total);
    res.json({
      success: true,
      data: {
        vendors: list,
        vendor_count: list.length,
        row_count: list.reduce((n, g) => n + g.rows.length, 0),
        total: Math.round(list.reduce((n, g) => n + g.total, 0) * 100) / 100,
        already_answered: answeredCount,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/statements/artist-rules — answer a vendor, and apply the answer to
// the rows already booked under it.
//
// Applied server-side in one call rather than N client-side PUTs: Spotify alone
// is 151 rows, and 151 sequential round-trips is both slow and a Cloudflare
// timeout waiting to happen. autoLinkRelease is still run per row so the
// release link stays consistent with the ledger's own edit path.
router.post('/artist-rules', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const pattern = String(req.body.pattern || '').trim();
    const isOverhead = req.body.is_overhead === true;
    const artist = isOverhead ? null : String(req.body.artist || '').trim();
    if (!pattern) return res.status(400).json({ success: false, error: 'pattern required' });
    if (!isOverhead && !artist) return res.status(400).json({ success: false, error: 'artist required (or mark it overhead)' });
    // A one-character pattern would match most of the ledger. This writes to
    // real entries, so an over-broad pattern is the dangerous failure here.
    if (pattern.length < 3) return res.status(400).json({ success: false, error: 'pattern must be at least 3 characters' });

    const { rows: [rule] } = await pool.query(
      `INSERT INTO statement_artist_rules (pattern, artist, is_overhead, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (LOWER(pattern)) DO UPDATE
         SET artist = EXCLUDED.artist, is_overhead = EXCLUDED.is_overhead,
             created_by = EXCLUDED.created_by, created_at = NOW()
       RETURNING *`,
      [pattern, artist || null, isOverhead, req.user?.name || req.user?.email || 'unknown']);

    // Overhead is an answer, not a write: the rows already have a null artist,
    // so there is nothing to set — the rule only stops them being asked about.
    // The historical write is scoped by EXPENSE ID, never by the pattern.
    //
    // A pattern is a substring test, and vendor names collide in exactly the
    // places that hurt most: "TONE" ($615,000, the largest vendor in the queue)
    // is a substring of "Tone Pay, Inc"; "Dean St" is a substring of "Dean
    // Street Media"; "Boom.Digital Managem" of "BOOM.DIGITAL MANAGEMENT LL".
    // Sweeping by pattern would silently attribute a different company's spend
    // to an artist, and nothing downstream would contradict it.
    //
    // So: the caller sends the ids it actually reviewed, and the pattern is
    // kept only for FUTURE statements, where fuzzy matching is right (bank
    // descriptors vary run to run) and the stakes are one new row at a time.
    // No ids means rule-only — a deliberate no-op on history rather than a
    // guess at what the caller meant.
    let updated = 0;
    const touched = [];
    const ids = Array.isArray(req.body.entry_ids)
      ? req.body.entry_ids.map(Number).filter(Number.isFinite).slice(0, 5000)
      : [];
    if (!isOverhead && ids.length) {
      // Re-checked server-side: still booked, still artist-less, still alive.
      // The client's list can be stale, and this writes to the ledger.
      const { rows: targets } = await pool.query(`
        SELECT e.id, e.song FROM bank_transactions bt
          JOIN expenses e ON e.id = bt.matched_expense_id
         WHERE bt.direction = 'debit' AND bt.dismissed = false
           AND bt.match_method = 'created'
           AND (e.deleted = false OR e.deleted IS NULL)
           AND COALESCE(TRIM(e.artist), '') = ''
           AND e.id = ANY($1::int[])`,
        [ids]);
      for (const t of targets) {
        await pool.query(`UPDATE expenses SET artist = $1 WHERE id = $2`, [artist, t.id]);
        await autoLinkRelease(t.id, artist, t.song).catch(() => {});
        updated += 1;
        touched.push(t.id);
      }
    }
    await audit(req.user, 'artist_rule_applied', null, pattern,
      `${isOverhead ? 'Marked overhead' : `Attributed to ${artist}`} — ${updated} entr${updated === 1 ? 'y' : 'ies'} updated`);
    res.json({
      success: true,
      data: {
        rule,
        updated,
        entry_ids: touched,
        // Requested vs written: a gap means rows changed under the caller
        // (already attributed, unbooked, deleted) and the UI should say so
        // rather than report a count it didn't achieve.
        requested: ids.length,
        skipped: Math.max(0, ids.length - updated),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/artist-rules', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows } = await pool.query(`SELECT * FROM statement_artist_rules ORDER BY created_at DESC`);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Deleting a rule stops it applying to FUTURE statements. It deliberately does
// NOT strip the artist off entries it already set: those are now ordinary
// ledger data that a person may have refined by hand, and silently reverting
// them would be a destructive surprise from a "delete rule" button.
router.delete('/artist-rules/:id(\\d+)', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    await pool.query(`DELETE FROM statement_artist_rules WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Dismissal rules CRUD ─────────────────────────────────────────────────────


router.get('/rules', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows } = await pool.query(`SELECT * FROM statement_dismiss_rules ORDER BY created_at DESC`);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/rules/:id(\\d+)', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    await pool.query(`DELETE FROM statement_dismiss_rules WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Booking a debit as a ledger entry ────────────────────────────────────────
// Money verifiably left the bank but the ledger never saw it — book it as an
// approved, Paid entry with the bank's date/reference and link the debit so
// it lands in Verified. Shared by the per-row route, bulk booking, and the
// auto-category rules applied on upload.
// The counterparty when the descriptor doesn't name one.
//
// PayPal writes plain "General Payment" lines with no name at all — the only
// identifier on the row is the email. Booking used to hard-fail those with
// "payee required" even though the counterparty was perfectly identifiable, and
// there was no way through it from the UI.
//
// Resolution order matters: an EXISTING vendor that already carries this email
// first, so the payment lands on the vendor you know rather than creating a
// second one. nameEvidence already treats an email equality as 1.0 identity
// evidence, so this is the same rule the matcher trusts, applied at booking.
async function payeeFromEmail(email) {
  const em = String(email || '').trim().toLowerCase();
  if (!em || !em.includes('@')) return null;
  const { rows } = await pool.query(`
    SELECT payee, COUNT(*)::int AS n FROM expenses
     WHERE LOWER(TRIM(vendor_email)) = $1
       AND payee IS NOT NULL AND TRIM(payee) <> ''
       AND (deleted = false OR deleted IS NULL)
     GROUP BY payee ORDER BY n DESC LIMIT 1`, [em]).catch(() => ({ rows: [] }));
  if (rows[0]?.payee) return String(rows[0].payee).trim();
  const { rows: ve } = await pool.query(
    'SELECT vendor_name FROM vendor_emails WHERE LOWER(TRIM(email)) = $1 LIMIT 1',
    [em]).catch(() => ({ rows: [] }));
  return ve[0]?.vendor_name ? String(ve[0].vendor_name).trim() : null;
}

// The vendor a person has already said this descriptor means.
//
// `statement_payee_map` is the table /vendors/link writes and the matcher reads
// as 1.0 name evidence — but BOOKING never consulted it, so a PayPal line whose
// descriptor reads "Oluwanifemi Ajayi" was booked under that name while the
// ledger had known that vendor as "Nini Ajayi" for months. The result is a
// second vendor holding one invoice, sitting beside the real one. Six of them
// exist in production; the largest carries $250,975.
//
// Keyed through normalizeBankPayee, the same way aggregateBankVendors builds
// `linked_vendor` — so the name the directory SHOWS as the link is the name
// booking USES, rather than two answers to one question.
async function payeeFromLesson(bankPayee) {
  const key = normalizeBankPayee(bankPayee);
  if (key.length < 3) return null;
  // A payment channel is not a payee. A lesson on "PAYPAL" would file every
  // nameless pull under one vendor — that is the failure that put $94,660.97 of
  // other people's payments on Dean Street Media. learnPayeeMap refuses to WRITE
  // those now, but rows predating that guard are still in the table, so the read
  // side has to refuse them too.
  if (CHANNEL_ONLY_PAYEES.has(key)) return null;
  const { rows } = await pool.query(`SELECT bank_payee, ledger_payee FROM statement_payee_map`)
    .catch(() => ({ rows: [] }));
  // Normalized in JS rather than SQL because learnPayeeMap only started storing
  // the normalized form recently — legacy rows hold the raw descriptor, and a
  // key comparison in the query would miss every one of them.
  for (const r of rows) {
    if (normalizeBankPayee(r.bank_payee) !== key) continue;
    const ledger = String(r.ledger_payee || '').trim();
    if (ledger) return ledger;
  }
  return null;
}

// an explicit choice → the learned lesson → the descriptor → a vendor already
// known by this email → the email itself. The last step is deliberate: a vendor
// named after an address is ugly but identifiable and mergeable, and blocking
// the booking entirely left real money stuck with no way forward.
//
// The lesson outranks the descriptor and nothing else. A person typing a name
// still wins — that is a decision, not an inference — and the descriptor is what
// the lesson exists to translate.
async function resolveBookingPayee(t, explicit) {
  const chosen = String(explicit || '').trim();
  if (chosen) return resolveVendorAlias(chosen);
  const lesson = await payeeFromLesson(t.payee_guess);
  if (lesson) return resolveVendorAlias(lesson);
  const named = String(displayBankPayee(t.payee_guess) || '').trim();
  if (named) return resolveVendorAlias(named);
  const known = await payeeFromEmail(t.payee_email);
  if (known) return resolveVendorAlias(known);
  const em = String(t.payee_email || '').trim();
  return em || '';
}

// `recoupable` (optional) is the answer to "can this be billed back to an
// artist", given at the moment the row is booked rather than left for the
// review queue to ask later.
//
// It has THREE states, not two, and that is the point. `expenses.recoupable` is
// BOOLEAN DEFAULT TRUE and this function never used to list the column, so every
// statement-born row arrived claiming to be recoupable and nobody could tell the
// claim from an answer — 1,972 rows deep by the time it was measured. Passing a
// boolean here records the answer AND sets `recoup_reviewed`, so the row never
// enters that queue. Passing nothing leaves both exactly as they were: the row is
// unreviewed and /bk/recoup-review will ask for it.
//
// So the callers that answer are the ones a PERSON drove — a card, a form, a row
// they were looking at. The category-rule sweep and the "always book this payee"
// sweep deliberately pass nothing: a rule is a statement about a category, not
// about whose money it is, and one click that silently answers "recoupable" for
// forty unseen rows is the shape this column already got wrong once.
async function bookDebitAsEntry(t, { payee, category, artist, recoupable, reviewedBy, userName }) {
  if (t.direction !== 'debit') throw new Error('Only debits can become expenses');
  if (t.matched_expense_id) throw new Error('Already matched to a ledger entry');
  const finalPayee = await resolveBookingPayee(t, payee);
  if (!finalPayee) throw new Error('payee required — this row names no counterparty and carries no email; pick a payee to book it');
  const finalCategory = String(category || 'Other').trim().slice(0, 100);
  // An explicit artist always wins. Absent one, ask the vendor's standing
  // answer — set here rather than in the rule-booking loop so EVERY path that
  // books a debit inherits it (rule sweep, manual create-entry, batch review),
  // which is the difference between a rule and a one-off.
  let finalArtist = String(artist || '').trim() || null;
  if (!finalArtist) finalArtist = await artistForPayee(finalPayee);
  const desc = String(t.description || '').slice(0, 500);

  // Payment method inferred from the account / description
  const d = desc.toUpperCase();
  const method = t.account === 'paypal' ? 'PayPal'
    : /WIRE/.test(d) ? 'Wire'
    : /CHECKCARD|CREDIT CARD/.test(d) ? 'Credit Card'
    : /CHECK\b/.test(d) ? 'Check'
    : 'ACH';

  // Lock the historical fx rate for foreign-currency debits
  let fxRate = null;
  const cur = (t.currency || 'USD').toUpperCase();
  if (cur !== 'USD') {
    const hist = await getHistorical(String(t.txn_date).slice(0, 10)).catch(() => null);
    if (hist?.rates?.[cur] > 0) fxRate = hist.rates[cur];
  }

  // Answered only when the caller passed a real boolean. `undefined` and `null`
  // both mean "nobody said", and the row keeps the unreviewed default.
  const recoupAnswered = typeof recoupable === 'boolean';
  const { rows: [e] } = await pool.query(`
    INSERT INTO expenses
      (invoice_date, payee, description, category, artist, amount, currency,
       payment_method, status, approved_by, approved_at, created_by,
       payment_status, payment_date, paid_by, paid_marked_at, payment_ref,
       payment_terms, entry_source, fx_rate_to_usd, notes, vendor_email,
       recoupable, recoup_reviewed, recoup_reviewed_at, recoup_reviewed_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'approved',$9,NOW(),$9,
            'Paid',$1,$9,NOW(),$10,'Net 30','bank_statement',$11,$12,$13,
            $14::boolean, $15::boolean,
            CASE WHEN $15::boolean THEN NOW() END, $16::int)
    RETURNING id, payee`,
    [t.txn_date, finalPayee, desc, finalCategory, finalArtist, t.amount, cur, method,
     userName, t.reference || null,
     fxRate, `Created from bank statement debit #${t.id}`,
     // Carry the counterparty email onto the entry. Bank-booked entries never
     // had one, so every "General Payment" row stayed unidentifiable and the
     // matcher's email tier — its strongest non-reference evidence — could never
     // fire for them. Storing it makes the next payment from this person resolve
     // to this vendor instead of creating another.
     String(t.payee_email || '').trim() || null,
     // Unanswered rows keep the column's own default (TRUE) so nothing about
     // them changes — what marks them out is `recoup_reviewed = FALSE`.
     recoupAnswered ? recoupable : true,
     recoupAnswered,
     recoupAnswered ? (Number.isFinite(Number(reviewedBy)) ? Number(reviewedBy) : null) : null]);

  // Atomic link: only claim a still-open txn. Losing the race (double
  // click, category-rule sweep vs. a user booking) must NOT leave a second
  // Paid entry in the ledger — delete the entry we just created instead.
  const { rowCount: linked } = await pool.query(
    `UPDATE bank_transactions SET matched_expense_id = $1, match_method = 'created',
       matched_by = $2, matched_at = NOW()
     WHERE id = $3 AND matched_expense_id IS NULL AND matched_income_id IS NULL AND dismissed = false`,
    [e.id, userName, t.id]);
  if (!linked) {
    await pool.query(`DELETE FROM expenses WHERE id = $1 AND entry_source = 'bank_statement'`, [e.id]).catch(() => {});
    throw new Error('Already matched to a ledger entry');
  }
  await learnPayeeMap({ name: userName }, t.payee_guess, finalPayee);
  await learnCategoryMap({ name: userName }, t.payee_guess, finalCategory);
  await audit({ name: userName }, 'statement_entry_created', e.id, finalPayee,
    `Ledger entry created from bank debit: $${t.amount} on ${String(t.txn_date).slice(0, 10)} (${finalCategory})`
    + (recoupAnswered
      ? ` — answered ${recoupable ? 'RECOUPABLE' : 'not recoupable'} while matching`
      : ''));
  return e.id;
}

const fetchTxnWithAccount = async (txId) => {
  const { rows: [t] } = await pool.query(
    `SELECT bt.*, s.account FROM bank_transactions bt
      JOIN bank_statements s ON s.id = bt.statement_id WHERE bt.id = $1`, [txId]);
  return t;
};

// The standing answer to "who is this vendor's spend for". Returns an artist
// name, or null for both "no rule" and "overhead" — the caller books a null
// artist either way, and the difference between the two only matters to the
// review queue, which reads the table directly.
// Matched on the resolved payee by EQUALITY, not substring.
//
// Substring matching was measured against the live queue and it is not a
// theoretical hazard — the collisions are the biggest vendors in the book:
//
//   "TONE"                 $615,000  is inside  "Tone Pay, Inc"
//   "Dean St"              $101,221  is inside  "Dean Street Media"
//   "SPOTIFY USA INC"      $148,974  is inside  "PURCHASE SPOTIFY USA INC NY"
//   "Boom.Digital Managem"  $28,143  is inside  "BOOM.DIGITAL MANAGEMENT LL"
//
// A "TONE" rule would have auto-attributed every future Tone Pay charge to
// TONE's artist and hidden Tone Pay from the review queue as already-answered.
//
// Equality is the safe direction. A vendor arriving under a genuinely new
// spelling simply doesn't match, so it surfaces in the queue to be answered —
// a missed auto-attribution is visible, a wrong one is silent. The bank's own
// descriptor variation is already absorbed upstream by resolveBookingPayee,
// which is what maps a messy bank line onto the ledger's payee.
async function artistForPayee(payee) {
  const key = String(payee || '').trim().toLowerCase();
  if (!key) return null;
  const { rows } = await pool.query(
    `SELECT artist, is_overhead FROM statement_artist_rules WHERE LOWER(TRIM(pattern)) = $1 LIMIT 1`,
    [key]).catch(() => ({ rows: [] }));
  if (!rows.length) return null;
  return rows[0].is_overhead ? null : (rows[0].artist || null);
}

// Auto-book recurring non-invoiced overhead (Ubers, travel, software) per
// saved category rules. Runs AFTER auto-match so a rule can never shadow a
// real invoice match.
async function applyCategoryRules(statementId) {
  const { rows: rules } = await pool.query(`SELECT * FROM statement_category_rules`);
  let booked = 0;
  for (const rule of rules) {
    const { rows: txns } = await pool.query(
      `SELECT bt.*, s.account FROM bank_transactions bt
        JOIN bank_statements s ON s.id = bt.statement_id
       WHERE bt.statement_id = $1 AND bt.direction = 'debit'
         AND bt.dismissed = false AND bt.matched_expense_id IS NULL
         AND (bt.payee_guess ILIKE $2 OR bt.description ILIKE $2)`,
      [statementId, `%${likeEscape(rule.pattern)}%`]);
    for (const t of txns) {
      await bookDebitAsEntry(t, { category: rule.category, userName: rule.created_by || 'category-rule' })
        .then(() => booked++)
        .catch(() => {});
    }
  }
  return booked;
}

// POST /api/statements/tx/:txId/create-entry — body { payee?, category?,
// Split-book: one debit across several categories ($20 Marketing + $1,000
// Salary). Creates a ledger split family — parent keeps the first slice,
// children carry the rest, family total equals the bank amount, so the
// matcher / flags / reports arithmetic all see one debit = one family.
// Does the bank pull actually NAME this PayPal recipient?
//
// A "PAYPAL DES:..." pull is nameless in its payee column but not in its
// descriptor: "PAYPAL DES:PURCHASE ID:CHASEMANN8" is chase mann's, and
// "ELIOR745 DES:IAT PAYPAL" is Elior Antwi's. Amount and date alone are a
// coincidence — on 2026-08-18 the sweep paired ELIOR745's pull with a $200
// payment to Dylan Gold three days later, because Elior's own PayPal row had
// already been dismissed and was out of the pool. It deleted the wrong booking
// and $200 of real spend stopped being counted anywhere.
//
// So anything that DELETES a record has to clear this bar: every word of the
// PayPal recipient's name (3+ characters) appears in the descriptor. The
// dismiss-only branches are unchanged — closing a leg is recoverable, deleting
// a booking is the thing that loses money.
// Moved to lib/funding-pairs.js as namesRecipient (2026-08-18), where the
// vendor page and the cross-currency audit can share it — and where it learned
// that the bank truncates the REFERENCE as well as the payee column
// ("ID:STREGAENTER" is "StregaEntertainment Group"). The 10-character floor on a
// prefix match is set above the length of the name that caused the $200
// mispairing, so that pair can never come back.

// POST /api/statements/tx/:ppId/funding-pair { bank_txn_id, undo? }
//
// Close a PayPal payment against the bank pull that funded it, from the vendor
// page. The sweep does this automatically for the clean cases (193 legs already
// dismissed); what is left are the pairs where BOTH halves ended up explained by
// a ledger entry, so one real payment claims two records and the P&L counts it
// twice.
//
// The ledger entry moves with the decision, and that is the whole point of doing
// it here rather than just dismissing a row: a dismissed bank leg is not counted,
// so dismissing one that HOLDS the only ledger entry would delete the spend from
// the report instead of relocating it. The PayPal row is canonical — it carries
// the recipient's name, email and FX — so the entry lands there.
router.post('/tx/:ppId(\\d+)/funding-pair', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const undo = req.body.undo === true;
    // Same context the cross-currency audit uses. Without it this endpoint
    // would refuse the very pairs that deck proposes.
    const nameCtx = await loadMatchContext().catch(() => ({ exact: new Map(), norm: new Map(), aliases: new Map() }));
    const pp = await fetchTxnWithAccount(req.params.ppId);
    const bank = await fetchTxnWithAccount(Number(req.body.bank_txn_id) || 0);
    if (!pp || !bank) return res.status(404).json({ success: false, error: 'Transaction not found' });
    if (pp.account !== 'paypal') return res.status(400).json({ success: false, error: 'The first row must be the PayPal payment' });
    if (bank.account === 'paypal') return res.status(400).json({ success: false, error: 'The funding row must be on a bank statement, not PayPal' });
    if (pp.direction !== 'debit' || bank.direction !== 'debit') return res.status(400).json({ success: false, error: 'Both sides must be debits' });
    // SAME CURRENCY: the amounts must match. CROSS-CURRENCY: they never can.
    //
    // This was a flat equality check, which meant a GBP payment funded by a USD
    // pull could not be closed here at all — and the vendor page grew a "close
    // against the statement?" button for exactly those pairs earlier today, so
    // that button posted straight into a 400. My defect, from shipping the
    // proposal UI without exercising the write path behind it.
    //
    // Cross-currency gets the same band the audit and the sweep use (the bank pays
    // MORE than mid-market because the spread is PayPal's margin, hence
    // asymmetric), and in exchange for not being able to compare amounts it must
    // clear the STRONGER evidence bar: the pull has to NAME the recipient. Same
    // currency keeps the equality rule unchanged, so no existing close gets
    // stricter.
    const sameCurrency = String(pp.currency || 'USD').toUpperCase() === String(bank.currency || 'USD').toUpperCase();
    // ── THE PULL CAN EXCEED THE PAYMENT BY PAYPAL'S FIXED FEE ───────────────
    //
    // A Trần's $200 payment of 02-09 is funded by a $204.99 pull on 02-12, and her
    // $150 of 02-12 by $154.99 on 02-17. Same currency, so the equality above
    // refused both — and the vendor page proposed them, so John clicked "close
    // against the statement" and got "These are not the same payment — 200.00
    // against 204.99 USD". The proposal and the gate disagreed.
    //
    // It is a FEE, not a coincidence. The difference is exactly $4.99 on four live
    // pairs across three vendors (A TRAN twice, Polina Frolova, Gioangeli Sol
    // Salas Avile) — a flat charge, not a percentage. Our PayPal parse never
    // captured it: `fee` is NULL on every row in the table, so the PayPal
    // statement records the net payment and the bank records payment + fee.
    //
    // $5.00 is the cap, and it is doing real work. The same measurement found
    // three pairs differing by exactly $35.00 — $25 against $60, and one $80 pull
    // against two separate $45 payments. A $35 charge on a $25 payment is not a
    // fee, and those must keep being refused.
    //
    // A fee-sized pair earns no free pass: it falls through to the branch below
    // and clears the SAME bar a cross-currency pair does — the converted-amount
    // band, and the pull has to name the recipient (or a person says it does).
    // Exact equality remains the only way to close without that evidence.
    const MAX_PAYPAL_FEE = 5;
    const feeGap = Number(bank.amount) - Number(pp.amount);
    const feeSized = sameCurrency && feeGap > 0.01 && feeGap <= MAX_PAYPAL_FEE;
    if (!undo && sameCurrency && !feeSized) {
      if (Math.abs(Number(pp.amount) - Number(bank.amount)) > 0.01) {
        return res.status(400).json({ success: false, error: `These are not the same payment — ${Number(pp.amount).toFixed(2)} against ${Number(bank.amount).toFixed(2)} ${bank.currency || 'USD'}` });
      }
    } else if (!undo) {
      const ppUsd = usdOf(pp.amount, pp.currency || 'USD', null);
      const bankUsd = usdOf(bank.amount, bank.currency || 'USD', null);
      if (!(ppUsd > 0) || !(bankUsd > 0)) {
        return res.status(400).json({ success: false, error:
          `No exchange rate available for ${pp.currency} — cannot check these are the same payment.` });
      }
      if (!(bankUsd >= ppUsd * 0.95 && bankUsd <= ppUsd * 1.20)) {
        return res.status(400).json({ success: false, error:
          `${pp.currency} ${Number(pp.amount).toFixed(2)} converts to about $${ppUsd.toFixed(2)}, but that pull is $${bankUsd.toFixed(2)}`
          + ` — too far apart to be the same payment even allowing for PayPal's spread.` });
      }
      // A PERSON MAY OVERRULE THE NAME TEST — nothing else may.
      //
      // PayPal prints a handle, and a handle sometimes abbreviates rather than
      // contains the name: "MJSCOTT117 DES:IAT PAYPAL" is Michael Scott's pull,
      // one day after his AUD 202.25, at a 4.3% spread. Obvious to a reader,
      // unprovable by any rule. 12 live rows are that shape, and without a way to
      // say so they stay double-counted forever.
      //
      // `confirm_unnamed` is that way — the same shape as confirm_in_use on the
      // category PATCH. It relaxes ONLY the naming test: the window and the
      // converted-amount band still apply, the sweep can never set it, and the
      // branch that DELETES a booking keeps its own descriptorNames guard
      // untouched. The audit line records that a person asserted it.
      if (!namesOrLinked(nameCtx, bank.description, pp.payee_guess, bank.payee_guess)
          && req.body.confirm_unnamed !== true) {
        return res.status(400).json({ success: false, error:
          (feeSized
            ? `The pull is $${feeGap.toFixed(2)} larger than the payment, so the amounts cannot prove this and the only evidence left is the name`
            : 'The amounts differ in currency, so the only evidence left is the name')
          + ` — and that pull does not name`
          + ` ${pp.payee_guess || 'this recipient'}. It reads "${String(bank.description || '').slice(0, 60)}".`
          + ' If you recognise it as theirs, confirm it explicitly.',
          needs_confirmation: true });
      }
    }
    const days = Math.abs((new Date(pp.txn_date) - new Date(bank.txn_date)) / 86400000);
    if (days > 7) return res.status(400).json({ success: false, error: `${Math.round(days)} days apart — a funding pull settles within a few days` });
    // The last guard, and the one that matters: same amount on a nearby date is
    // a coincidence, not evidence. A funding pull says so on the statement —
    // "PAYPAL DES:…" or a recipient-named IAT/WEB transfer — and closing a line
    // that funded nothing removes real spend from the report.
    const desc = String(bank.description || '');
    if (!undo && !(/PAYPAL/i.test(desc) || (/DES:/i.test(desc) && /(PMT INFO: ?WEB|IAT)/i.test(desc)))) {
      return res.status(400).json({ success: false, error:
        'That bank line does not look like a PayPal funding pull — same amount and date is a coincidence, not the same payment.' });
    }

    if (undo) {
      // The inverse, mirroring the flip: the PAYPAL copy comes back, and the
      // record goes home with it. A delete gets its restore from the caller —
      // an action with no way back is not a decision, it is an accident waiting
      // to be permanent.
      await pool.query(`UPDATE bank_transactions SET dismissed = false, dismissed_reason = NULL
         WHERE id = $1`, [pp.id]);
      const restoreId = Number(req.body.restore_entry_id) || 0;
      let restoredEntry = null;
      if (restoreId) {
        const { rows: [e] } = await pool.query(
          `UPDATE expenses SET deleted = false, deleted_by = NULL, deleted_at = NULL
            WHERE id = $1 AND entry_source = 'bank_statement' RETURNING id`, [restoreId]);
        if (e) {
          await pool.query(`UPDATE expenses SET deleted = false WHERE parent_id = $1`, [e.id]).catch(() => {});
          await pool.query(
            `UPDATE bank_transactions SET matched_expense_id = $1, match_method = 'created',
               matched_by = $2, matched_at = NOW() WHERE id = $3 AND matched_expense_id IS NULL`,
            [e.id, req.user?.name || 'unknown', pp.id]);
          restoredEntry = e.id;
        }
      }
      // A MOVED record goes back to the PayPal row — but only if the move
      // actually lands. Clearing on a write that no-opped is what emptied a live
      // row on 2026-08-18.
      let returned = null;
      if (bank.matched_expense_id && !pp.matched_expense_id && !restoredEntry) {
        const { rowCount } = await pool.query(
          `UPDATE bank_transactions SET matched_expense_id = $1, match_method = $2,
             matched_by = $3, matched_at = NOW() WHERE id = $4 AND matched_expense_id IS NULL`,
          [bank.matched_expense_id, bank.match_method || 'created', req.user?.name || 'unknown', pp.id]);
        if (rowCount) {
          await pool.query(`UPDATE bank_transactions SET matched_expense_id = NULL, match_method = NULL,
              matched_by = NULL, matched_at = NULL WHERE id = $1`, [bank.id]);
          returned = bank.matched_expense_id;
        }
      }
      await audit(req.user, 'statement_funding_pair_undone', null, pp.payee_guess || null,
        `Funding pair undone: PayPal #${pp.id} restored`
        + (returned ? `, entry ${returned} moved back to it` : '')
        + (restoredEntry ? `, booking ${restoredEntry} restored` : ''));
      return res.json({ success: true, data: { paypal_txn_id: pp.id, entry_moved: returned, entry_restored: restoredEntry } });
    }

    // WHICH SIDE SURVIVES: the bank statement row. The P&L and Financials read
    // statement rows, and the BofA statement is the one that reconciles to a
    // printed balance — so the money stays there and the PayPal copy closes.
    // (This used to be the other way round; changed 2026-08-18 on John's call,
    // and the vendor page now finds a row by its ENTRY's payee as well as by the
    // descriptor, so a nameless "PAYPAL" pull still lands on the right vendor.)
    let removed = null;
    let moved = null;
    const carried = [];
    if (pp.matched_expense_id && !bank.matched_expense_id) {
      // The record is on the PayPal copy and the bank row is empty — move it,
      // then close the copy. Dismissing first would leave the payment nowhere.
      const { rowCount } = await pool.query(
        `UPDATE bank_transactions SET matched_expense_id = $1, match_method = $2,
           matched_by = $3, matched_at = NOW()
         WHERE id = $4 AND matched_expense_id IS NULL AND matched_income_id IS NULL AND dismissed = false`,
        [pp.matched_expense_id, pp.match_method || 'created', req.user?.name || 'unknown', bank.id]);
      if (!rowCount) return res.status(409).json({ success: false, error: 'The bank line was claimed while you were deciding — reload and try again' });
      await pool.query(
        `UPDATE bank_transactions SET matched_expense_id = NULL, match_method = NULL,
           matched_by = NULL, matched_at = NULL WHERE id = $1`, [pp.id]);
      moved = pp.matched_expense_id;
    } else if (pp.matched_expense_id && bank.matched_expense_id) {
      // Both carry a record. The invented PayPal-side one dissolves into the
      // bank record; a REAL invoice on that side is refused, because choosing
      // between a document and a guess is a person's call.
      if (pp.match_method !== 'created') {
        // The PayPal copy holds a REAL INVOICE. That is the better record, and
        // the bank row is the counted one, so the invoice MOVES rather than
        // either side being refused — which is what this button used to do.
        if (bank.match_method !== 'created') {
          return res.status(400).json({ success: false, error:
            'Both sides hold a real invoice. Unmatch whichever is wrong first — two documents disagreeing is not something to resolve automatically.' });
        }
        if (!namesOrLinked(nameCtx, bank.description, pp.payee_guess, bank.payee_guess)) {
          return res.status(400).json({ success: false, error:
            `That pull does not name ${pp.payee_guess || 'this recipient'} — it reads "${String(bank.description || '').slice(0, 60)}".` });
        }
        const { rows: [displaced] } = await pool.query(
          `UPDATE expenses SET deleted = true, deleted_by = $1, deleted_at = NOW()
            WHERE id = $2 AND entry_source = 'bank_statement'
              AND (deleted = false OR deleted IS NULL) RETURNING id`,
          [req.user?.name || 'unknown', bank.matched_expense_id]);
        if (!displaced) {
          return res.status(400).json({ success: false, error:
            'The entry on that bank line is a real record, not one booked from the descriptor — unbook it first.' });
        }
        await pool.query(`UPDATE expenses SET deleted = true, deleted_by = $1, deleted_at = NOW()
           WHERE parent_id = $2 AND entry_source = 'bank_statement'`, [req.user?.name || 'unknown', displaced.id]).catch(() => {});
        // The displaced booking dissolves into the invoice moving onto this row.
        await carryEntryState(pool, displaced.id, pp.matched_expense_id);
        // 'rematch', so /unattach knows to restore the booking just displaced.
        await pool.query(
          `UPDATE bank_transactions SET matched_expense_id = $1,
           match_method = ${movedMatchMethodSql('$1', 'rematch')},
             matched_by = $2, matched_at = NOW() WHERE id = $3`,
          [pp.matched_expense_id, req.user?.name || 'unknown', bank.id]);
        await pool.query(`UPDATE bank_txn_invoice_links SET txn_id = $1 WHERE txn_id = $2`, [bank.id, pp.id]).catch(() => {});
        await pool.query(
          `UPDATE bank_transactions SET matched_expense_id = NULL, match_method = NULL, match_score = NULL,
             matched_by = NULL, matched_at = NULL, dismissed = true,
             dismissed_reason = 'paypal copy — this payment is counted from its bank statement row'
           WHERE id = $1`, [pp.id]);
        await audit(req.user, 'statement_funding_invoice_moved', pp.matched_expense_id, pp.payee_guess || null,
          `Invoice ${pp.matched_expense_id} moved from PayPal #${pp.id} onto bank statement row #${bank.id}; `
          + `booking ${displaced.id} displaced (restorable by unattaching that row)`);
        return res.json({ success: true, data: {
          bank_txn_id: bank.id, paypal_txn_id: pp.id,
          invoice_moved: pp.matched_expense_id, booking_displaced: displaced.id,
        } });
      }
      if (!namesOrLinked(nameCtx, bank.description, pp.payee_guess, bank.payee_guess)) {
        return res.status(400).json({ success: false, error:
          `That pull does not name ${pp.payee_guess || 'this recipient'} — it reads "${String(bank.description || '').slice(0, 60)}". `
          + 'Removing a booking on a same-amount coincidence takes real spend off the report.' });
      }
      const { rows: [gone] } = await pool.query(
        `UPDATE expenses SET deleted = true, deleted_by = $1, deleted_at = NOW()
          WHERE id = $2 AND entry_source = 'bank_statement'
            AND (deleted = false OR deleted IS NULL) RETURNING id, category, artist, song`,
        [req.user?.name || 'unknown', pp.matched_expense_id]);
      if (!gone) {
        return res.status(400).json({ success: false, error:
          'The entry on the PayPal row is a real record, not one booked from the statement — unbook it first.' });
      }
      removed = gone.id;
      // The recoupment state travels with the record it belonged to. The
      // artist/song/category carry below predates this and answers a different
      // question — what the spend WAS; this answers what a person DID about it.
      carried.push(...await carryEntryState(pool, gone.id, bank.matched_expense_id));
      const { rows: [into] } = await pool.query(
        `SELECT category, artist, song FROM expenses WHERE id = $1`, [bank.matched_expense_id]);
      const fill = [];
      const vals = [];
      for (const f of ['artist', 'song', 'category']) {
        if (!String(into?.[f] || '').trim() && String(gone[f] || '').trim()) {
          vals.push(gone[f]); fill.push(`${f} = $${vals.length}`); carried.push(f);
        }
      }
      if (fill.length) {
        vals.push(bank.matched_expense_id);
        await pool.query(`UPDATE expenses SET ${fill.join(', ')} WHERE id = $${vals.length}`, vals);
      }
      await pool.query(
        `UPDATE bank_transactions SET matched_expense_id = NULL, match_method = NULL, match_score = NULL,
           matched_by = NULL, matched_at = NULL WHERE id = $1`, [pp.id]);
    }
    // Close the PayPal copy. The bank row stays live and counted.
    await pool.query(
      `UPDATE bank_transactions SET dismissed = true,
         dismissed_reason = 'paypal copy — this payment is counted from its bank statement row'
       WHERE id = $1`, [pp.id]);
    const assertedUnnamed = req.body.confirm_unnamed === true
      && !namesOrLinked(nameCtx, bank.description, pp.payee_guess, bank.payee_guess);
    await audit(req.user, 'statement_funding_pair_closed', moved || removed, pp.payee_guess || null,
      `PayPal #${pp.id} closed against bank statement row #${bank.id}`
      + (moved ? ` — ledger entry ${moved} moved onto the bank row`
        : removed ? ` — duplicate PayPal-side entry ${removed} removed${carried.length ? `, ${carried.join('/')} carried over` : ''}`
        : ' — the bank row already held the record')
      // Recorded, because it is the one close no rule would have made. Whoever
      // reads this later needs to know a person asserted the identity from a
      // descriptor that does not carry the name.
      + (assertedUnnamed
        ? `. CONFIRMED BY HAND: the pull reads "${String(bank.description || '').slice(0, 40)}", which does not name ${pp.payee_guess || 'the recipient'}`
        : ''));
    res.json({ success: true, data: { bank_txn_id: bank.id, paypal_txn_id: pp.id, entry_moved: moved, entry_removed: removed, carried } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/tx/:txId(\\d+)/split-book', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const t = await fetchTxnWithAccount(req.params.txId);
    if (!t) return res.status(404).json({ success: false, error: 'Transaction not found' });
    if (t.direction !== 'debit') return res.status(400).json({ success: false, error: 'Only debits can be split-booked' });
    // BOOKED rows are the point of this endpoint now.
    //
    // It used to refuse any row with a ledger entry, which left it reaching THREE
    // rows in the whole system — the open ones. The payments worth splitting are
    // the 2,165 booked ones: the app invented a single entry for a transfer that
    // actually covered two artists, and the only way to say so was to unbook by
    // hand first and remember to come back.
    //
    // A row matched to a REAL invoice still refuses: that document says what the
    // payment was for, and splitting past it would replace evidence with a guess.
    if (t.matched_expense_id && t.match_method !== 'created') {
      return res.status(400).json({ success: false, error:
        'This debit is matched to a real invoice — unmatch it first if the invoice is wrong.' });
    }

    const parts = Array.isArray(req.body.parts) ? req.body.parts
      .map((p) => ({
        amount: Number(p.amount),
        category: String(p.category || '').trim().slice(0, 100),
        // Who the spend was FOR. The reason to split a payment is usually that it
        // covered two artists, so a split that can only carry categories answers
        // the wrong half of the question.
        artist: String(p.artist || '').trim().slice(0, 200) || null,
      }))
      .filter((p) => p.amount > 0 && p.category) : [];
    if (parts.length < 2 || parts.length > 6) {
      return res.status(400).json({ success: false, error: '2–6 parts required, each with an amount and category' });
    }
    const sum = parts.reduce((s, p) => s + p.amount, 0);
    if (Math.abs(sum - Number(t.amount)) > 0.01) {
      return res.status(400).json({ success: false, error: `Parts total $${sum.toFixed(2)} but the debit is $${Number(t.amount).toFixed(2)}` });
    }

    const finalPayee = await resolveBookingPayee(t, req.body.payee);
    if (!finalPayee) return res.status(400).json({ success: false, error: 'payee required — this row names no counterparty and carries no email; pick a payee to book it' });
    const desc = String(t.description || '').slice(0, 500);
    const d = desc.toUpperCase();
    const method = t.account === 'paypal' ? 'PayPal'
      : /WIRE/.test(d) ? 'Wire'
      : /CHECKCARD|CREDIT CARD/.test(d) ? 'Credit Card'
      : /CHECK\b/.test(d) ? 'Check'
      : 'ACH';
    let fxRate = null;
    const cur = (t.currency || 'USD').toUpperCase();
    if (cur !== 'USD') {
      const hist = await getHistorical(String(t.txn_date).slice(0, 10)).catch(() => null);
      if (hist?.rates?.[cur] > 0) fxRate = hist.rates[cur];
    }

    const insertPart = async (part, parentId) => {
      const { rows: [e] } = await pool.query(`
        INSERT INTO expenses
          (invoice_date, payee, description, category, amount, currency,
           payment_method, status, approved_by, approved_at, created_by,
           payment_status, payment_date, paid_by, paid_marked_at, payment_ref,
           payment_terms, entry_source, fx_rate_to_usd, notes, parent_id, artist)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'approved',$8,NOW(),$8,
                'Paid',$1,$8,NOW(),$9,'Net 30','bank_statement',$10,$11,$12,$13)
        RETURNING id`,
        [t.txn_date, finalPayee, desc, part.category, part.amount, cur, method,
         req.user.name, t.reference || null, fxRate,
         `Created from bank statement debit #${t.id} (split ${part.category}`
           + `${part.artist ? ` · ${part.artist}` : ''})`, parentId, part.artist]);
      return e.id;
    };
    // Displace the entry the app invented for this row, if there is one. Guarded
    // on entry_source so this can only ever remove a row the app created — the
    // same guard that stopped a real invoice being deleted on 2026-08-17 — and
    // done BEFORE the parts are written so the money is never on the books twice.
    let displaced = null;
    if (t.matched_expense_id) {
      const { rows: [gone] } = await pool.query(
        `UPDATE expenses SET deleted = true, deleted_by = $1, deleted_at = NOW()
          WHERE id = $2 AND entry_source = 'bank_statement' RETURNING id`,
        [req.user.name, t.matched_expense_id]);
      if (!gone) {
        return res.status(400).json({ success: false, error:
          'The entry on this row is not statement-created, so it is a real record — unbook it first.' });
      }
      displaced = gone.id;
      await pool.query(`UPDATE expenses SET deleted = true, deleted_by = $1, deleted_at = NOW()
         WHERE parent_id = $2 AND entry_source = 'bank_statement'`, [req.user.name, displaced]).catch(() => {});
      await pool.query(
        `UPDATE bank_transactions SET matched_expense_id = NULL, match_method = NULL WHERE id = $1`, [t.id]);
    }

    const parentId = await insertPart(parts[0], null);
    for (const part of parts.slice(1)) await insertPart(part, parentId);

    // Atomic link, same as bookDebitAsEntry — losing a race must not leave
    // an orphaned split family doubling the ledger.
    const { rowCount: linked } = await pool.query(
      `UPDATE bank_transactions SET matched_expense_id = $1, match_method = 'created',
         matched_by = $2, matched_at = NOW()
       WHERE id = $3 AND matched_expense_id IS NULL AND matched_income_id IS NULL AND dismissed = false`,
      [parentId, req.user.name, t.id]);
    if (!linked) {
      await pool.query(`DELETE FROM expenses WHERE (id = $1 OR parent_id = $1) AND entry_source = 'bank_statement'`, [parentId]).catch(() => {});
      // Put the displaced booking back. Without this, losing the race leaves the
      // row with NO entry and its original soft-deleted — a state it was never
      // in, and the same half-state the rematch undo was fixed for.
      if (displaced) {
        await pool.query(
          `UPDATE expenses SET deleted = false, deleted_by = NULL, deleted_at = NULL
            WHERE id = $1 OR parent_id = $1`, [displaced]).catch(() => {});
        await pool.query(
          `UPDATE bank_transactions SET matched_expense_id = $1, match_method = 'created'
            WHERE id = $2 AND matched_expense_id IS NULL`, [displaced, t.id]).catch(() => {});
      }
      return res.status(409).json({ success: false, error: 'Already matched to a ledger entry' });
    }
    await learnPayeeMap(req.user, t.payee_guess, finalPayee);
    await audit(req.user, 'statement_entry_created', parentId, finalPayee,
      `Split-booked bank debit #${t.id}: `
      + parts.map((p) => `${p.category}${p.artist ? ` · ${p.artist}` : ''} $${p.amount.toFixed(2)}`).join(' + ')
      + (displaced ? `; replaced the single entry we invented for it (#${displaced})` : ''));
    res.json({ success: true, data: { expense_id: parentId, displaced_entry_id: displaced } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// artist?, always? }. With always=true, also saves a category rule for this
// payee and books every other matching unmatched debit right away.
// ── Already-paid invoices the auto-matcher can't see ─────────────────────────
//
// The auto-matcher's dateOk gate only considers a PAID family when the bank date
// is within 7 days of its payment_date:
//
//     if (f.payment_status === 'Paid')
//       return f.payment_date && dayDiff(f.payment_date, t.txn_date) <= 7;
//
// Measured against production, the duplicate pairs this created sit a MEDIAN 17
// days apart, p90 110, max 158 — someone marks an invoice Paid when the payment
// is initiated or approved, and the money leaves later. So the matcher never
// proposes the invoice, the operator books the bank row, and create-entry writes
// a SECOND ledger record for one payment. 187 such pairs exist, $245,986, and
// July produced 127 new violations — the worst month on record.
//
// This finder uses a deliberately wide window (PAID_LOOKBACK_DAYS) to warn a
// HUMAN at the moment of booking. It does NOT change dateOk: taking the
// auto-matcher to 120 days would let amount+payee coincidences auto-match at
// scale, and a confident wrong match is worse than none — it records a bill as
// settled by money that paid something else.
//
// Every other predicate is the matcher's own, so a candidate offered here would
// be a legitimate match: same-currency amount within the family's capacity,
// method-compatible with the account, name evidence, and not already rejected.
const PAID_LOOKBACK_DAYS = 120;

async function findPaidCandidates(txn) {
  const amt = Math.abs(Number(txn.amount || 0));
  if (!amt) return [];
  const [ctx, claims, rejections] = await Promise.all([
    loadMatchContext(), loadClaimedSums(), loadRejections(),
  ]);
  // Paid families with nothing yet claiming them, in the wide window.
  const { rows: fams } = await pool.query(
    `${FAMILY_SQL}
       AND r.payment_status = 'Paid'
       AND r.payment_date IS NOT NULL
       AND ABS(r.payment_date - $1::date) <= $2
       AND NOT EXISTS (
         SELECT 1 FROM bank_transactions bt
          WHERE bt.matched_expense_id = r.id AND bt.dismissed = false
       )`,
    [isoDay(txn.txn_date), PAID_LOOKBACK_DAYS]);

  const out = [];
  for (const f of fams) {
    if ((f.currency || 'USD').toUpperCase() !== 'USD') continue;   // FX needs the face-value path
    if (Math.abs(Number(f.family_total) - amt) > 0.01) continue;
    if (!methodCompatible(txn.account, f.payment_method)) continue;
    if (claimedOf(claims, f.id) !== 0) continue;
    if (isRejected(rejections, txn, f.id)) continue;
    const vm = nameEvidence(ctx, txn, f);
    if (!vm.match) continue;
    out.push({
      expense_id: f.id, payee: f.payee, amount: Number(f.family_total),
      invoice_number: f.invoice_number || null, artist: f.artist || null,
      category: f.category || null, payment_date: isoDay(f.payment_date),
      payment_method: f.payment_method || null,
      gap_days: Math.round(Math.abs((new Date(txn.txn_date) - new Date(f.payment_date)) / 86400000)),
      evidence: vm.reason, score: vm.score,
    });
  }
  // Strongest identity first, then closest in time.
  out.sort((a, b) => b.score - a.score || a.gap_days - b.gap_days);
  return out.slice(0, 5);
}

// ── Would marking this invoice Paid duplicate a booked bank row? ─────────────
//
// The remaining gap after the booking-side guard. Measured across the 184 pairs:
// 40 of them ($94,275) were invoices entered a MEDIAN 70 DAYS AFTER the bank row
// had already been booked as a stub. No matcher could have prevented those —
// there was nothing to match when the statement was booked.
//
// So the check runs from the other side, when the invoice becomes a paid record.
//
// ── Why "stub" is the whole design, not a detail ─────────────────────────────
//
// Keyed on payee + amount alone this would be useless: 135 payee+amount
// combinations recur 3+ times in the ledger, so a recurring vendor would trigger
// it every month. Requiring the bank row to be held by a STATEMENT STUB — an
// entry created from the statement, carrying no invoice number — narrows it to
// the actual duplicate shape.
//
// Even so it is ADVISORY, never a block. Measured: a hard gate would fire on 28
// of 156 unpaid invoices (17.9%), and Majed LLC alone matches 17 stub-held rows
// at $2,000 — a recurring vendor whose next invoice is probably legitimate.
// Interrupting one mark-paid in six, mostly wrongly, is worse than a notice.
async function findStubDuplicates(expense) {
  const amt = Math.abs(Number(expense?.amount || 0));
  if (!amt || !expense?.payee) return [];
  const { rows } = await pool.query(`
    SELECT bt.id AS txn_id, bt.txn_date, bt.amount, bt.payee_guess, bt.match_method,
           s.account, h.id AS holder_id, h.payee AS holder_payee, h.entry_source
      FROM bank_transactions bt
      JOIN bank_statements s ON s.id = bt.statement_id AND s.status = 'ready'
      JOIN expenses h ON h.id = bt.matched_expense_id
     WHERE bt.dismissed = false
       AND bt.direction = 'debit'
       AND ABS(bt.amount) BETWEEN $1 - 0.01 AND $1 + 0.01
       AND (h.deleted = false OR h.deleted IS NULL)
       AND h.id <> $2
       -- Held by a statement stub, not a real invoice.
       AND (h.entry_source = 'bank_statement'
            OR (bt.match_method = 'created'
                AND (h.invoice_number IS NULL OR TRIM(h.invoice_number) = '')))
     ORDER BY bt.txn_date DESC
     LIMIT 25`, [amt, expense.id || 0]);
  if (!rows.length) return [];

  // Same identity and account rules the booking guard uses, so the two can never
  // disagree about who a vendor is.
  const ctx = await loadMatchContext();
  const fam = { payee: expense.payee, vendor_email: expense.vendor_email || null, payment_method: expense.payment_method };
  return rows
    .filter((r) => methodCompatible(r.account, expense.payment_method))
    .filter((r) => nameEvidence(ctx, { payee_guess: r.holder_payee, payee_email: null, description: r.payee_guess }, fam).match)
    .map((r) => ({
      txn_id: r.txn_id, txn_date: isoDay(r.txn_date), amount: Math.abs(Number(r.amount)),
      account: r.account, payee: r.payee_guess || r.holder_payee,
      holder_id: r.holder_id, match_method: r.match_method,
    }));
}
router.findStubDuplicates = findStubDuplicates;

// ── The 187 pairs already created ────────────────────────────────────────────
//
// A pair is: one paid family with NO bank match, and one family with the same
// payee and amount that DOES have a match — the second almost always created
// from the statement by the flow above. Measured in production: 187 pairs,
// $245,986, and the created side is a bare stub 63% of the time (no invoice
// number, no file, no artist) while the original carries the real record 86-97%
// of the time.
//
// A PROPOSAL, never a verdict. A vendor who genuinely billed twice for the same
// amount looks identical to a duplicate, and merging those would erase a real
// invoice. So every pair is reviewed one at a time and "not a duplicate" is a
// first-class outcome, remembered in statement_match_rejections so the pair
// stops being offered.
router.get('/duplicate-pairs', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows } = await pool.query(`
      WITH fam AS (
        SELECT r.id, r.payee, r.amount, r.currency, r.invoice_number, r.artist, r.category,
               r.payment_date, r.payment_method, r.entry_source, r.created_at,
               (r.invoice_r2_key IS NOT NULL OR (r.invoice_data IS NOT NULL AND substr(r.invoice_data,1,1) <> '')) AS has_invoice,
               (r.w9_r2_key IS NOT NULL OR (r.w9_data IS NOT NULL AND substr(r.w9_data,1,1) <> '')) AS has_w9,
               bt.id AS txn_id, bt.txn_date, bt.match_method, s.account
          FROM expenses r
          LEFT JOIN bank_transactions bt
            ON bt.matched_expense_id = r.id AND bt.dismissed = false
          LEFT JOIN bank_statements s ON s.id = bt.statement_id
         WHERE r.parent_id IS NULL AND r.status = 'approved'
           AND (r.deleted = false OR r.deleted IS NULL)
           AND (r.voided = false OR r.voided IS NULL)
           AND r.payment_status = 'Paid'
      )
      SELECT o.id AS orphan_id, o.payee AS orphan_payee, o.amount, o.currency,
             o.invoice_number AS orphan_invoice, o.artist AS orphan_artist,
             o.category AS orphan_category, o.payment_date AS orphan_paid,
             o.has_invoice AS orphan_has_invoice, o.has_w9 AS orphan_has_w9,
             m.id AS twin_id, m.invoice_number AS twin_invoice, m.artist AS twin_artist,
             m.entry_source AS twin_source, m.has_invoice AS twin_has_invoice,
             m.has_w9 AS twin_has_w9, m.txn_id, m.txn_date, m.match_method, m.account
        FROM fam o
        JOIN fam m
          ON m.txn_id IS NOT NULL
         AND LOWER(TRIM(m.payee)) = LOWER(TRIM(o.payee))
         AND ABS(m.amount - o.amount) < 0.01
         AND m.id <> o.id
       WHERE o.txn_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM statement_match_rejections mr
            WHERE mr.expense_root_id = o.id AND mr.source = 'dup-pair'
         )
       ORDER BY ABS(m.txn_date - o.payment_date), o.id`);
    // One proposal per orphan — the closest twin wins, so a payee with several
    // same-amount rows doesn't generate a combinatorial list.
    const seen = new Set();
    const pairs = [];
    for (const r of rows) {
      if (seen.has(r.orphan_id)) continue;
      seen.add(r.orphan_id);
      pairs.push({
        ...r,
        amount: Number(r.amount),
        gap_days: Math.round(Math.abs((new Date(r.txn_date) - new Date(r.orphan_paid)) / 86400000)),
      });
    }
    res.json({
      success: true,
      data: { pairs, count: pairs.length, total: pairs.reduce((s, p) => s + p.amount, 0) },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/statements/duplicate-pairs/merge  { orphan_id, twin_id }
//
// Keep the ORIGINAL, move the bank match onto it, carry over anything only the
// twin has, soft-delete the twin. Transactional: a half-applied merge would
// leave a bank row matched to a deleted entry, which reads on every report as
// unexplained spend.
router.post('/duplicate-pairs/merge', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const orphanId = parseInt(req.body.orphan_id, 10);
    const twinId = parseInt(req.body.twin_id, 10);
    if (!orphanId || !twinId || orphanId === twinId) {
      return res.status(400).json({ success: false, error: 'orphan_id and twin_id (distinct) are required' });
    }

    await client.query('BEGIN');
    // A hang here must surface as an error, not as Cloudflare's 524 with no
    // explanation — which is exactly what the first version of this produced.
    await client.query(`SET LOCAL statement_timeout = '30s'`);
    // Two admins merging at once, or any future lock contention, should fail
    // fast and legibly rather than sitting on a lock until the gateway gives up.
    await client.query(`SET LOCAL lock_timeout = '10s'`);

    // NEVER select the *_data columns. They are multi-megabyte base64 blobs —
    // the four columns EXPENSE_LIGHT_COLS deliberately omits — and the first
    // version of this pulled three of them for two rows and wrote them back
    // through Node. That round trip timed out at Cloudflare's 100s ceiling with
    // no response at all. Presence is tested with substr(col,1,1), which reads
    // one TOAST chunk instead of the whole value; the copy happens server-side
    // below and the bytes never enter this process.
    const PRESENCE = (a) => `
      ${a}.id, ${a}.payee, ${a}.amount, ${a}.artist, ${a}.invoice_number, ${a}.payment_status,
      (${a}.invoice_r2_key IS NOT NULL OR (${a}.invoice_data IS NOT NULL AND substr(${a}.invoice_data,1,1) <> '')) AS has_invoice,
      (${a}.w9_r2_key      IS NOT NULL OR (${a}.w9_data      IS NOT NULL AND substr(${a}.w9_data,1,1)      <> '')) AS has_w9,
      (${a}.proof_r2_key   IS NOT NULL OR (${a}.proof_data   IS NOT NULL AND substr(${a}.proof_data,1,1)   <> '')) AS has_proof`;
    const { rows: [o] } = await client.query(
      `SELECT ${PRESENCE('e')} FROM expenses e WHERE e.id = $1 FOR UPDATE`, [orphanId]);
    const { rows: [tw] } = await client.query(
      `SELECT ${PRESENCE('e')} FROM expenses e WHERE e.id = $1 FOR UPDATE`, [twinId]);
    if (!o || !tw) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Entry not found' }); }

    // The twin's bank rows become the original's. Plural on purpose: an
    // installment-paid family can legitimately hold several.
    const { rowCount: moved } = await client.query(
      `UPDATE bank_transactions SET matched_expense_id = $1
        WHERE matched_expense_id = $2 AND dismissed = false`, [orphanId, twinId]);
    if (!moved) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'That twin has no live bank match to move' });
    }

    // Carry over documents the original lacks — 25% of twins hold an invoice
    // file the original doesn't. Union, not replace: never overwrite a document
    // the original already has.
    //
    // UPDATE ... FROM, so a blob is copied row-to-row inside Postgres. The
    // bytes never cross the wire, which is both faster and the reason this
    // stopped timing out.
    const carried = [];
    for (const kind of ['invoice', 'w9', 'proof']) {
      if (o[`has_${kind}`] || !tw[`has_${kind}`]) continue;
      await client.query(
        `UPDATE expenses o
            SET ${kind}_data     = t.${kind}_data,
                ${kind}_r2_key   = t.${kind}_r2_key,
                ${kind}_filename = t.${kind}_filename
           FROM expenses t
          WHERE o.id = $1 AND t.id = $2`, [orphanId, twinId]);
      carried.push(kind);
    }
    // Same for the two fields the stub sometimes has and the original doesn't.
    if (!o.artist && tw.artist) { await client.query(`UPDATE expenses SET artist = $1 WHERE id = $2`, [tw.artist, orphanId]); carried.push('artist'); }
    if (!o.invoice_number && tw.invoice_number) { await client.query(`UPDATE expenses SET invoice_number = $1 WHERE id = $2`, [tw.invoice_number, orphanId]); carried.push('invoice_number'); }

    // Marks a PERSON made outlive the row that carried them. Before this, merging
    // a twin that had been marked Uploaded for Recoupment ended that claim
    // silently — 4 of the 79 pairs waiting were in exactly that shape.
    // BEFORE the soft-delete and on the same client, so a rollback takes the
    // carry with it.
    const carriedState = await carryEntryState(client, twinId, orphanId);
    carried.push(...carriedState);

    // Soft-delete, never hard — the cascade to children and the Archive restore
    // both depend on it, and an unmergeable mistake has to be undoable.
    await client.query(
      `UPDATE expenses SET deleted = true, deleted_by = $1, deleted_at = NOW() WHERE id = $2`,
      [req.user.name, twinId]);
    await client.query(
      `UPDATE expenses SET deleted = true, deleted_by = $1, deleted_at = NOW() WHERE parent_id = $2`,
      [req.user.name, twinId]);

    // ── MUST use client.query, not the audit() helper ──────────────────────
    //
    // audit() runs on `pool`, which means a DIFFERENT connection. bk_audit_log
    // has `entry_id INTEGER REFERENCES expenses(id)`, so inserting a row that
    // references an expense requires a FOR KEY SHARE lock on it — and this
    // transaction is holding FOR UPDATE on exactly those rows, uncommitted.
    //
    // The result is an application-level self-deadlock: this transaction awaits
    // the other connection, the other connection waits for this transaction's
    // lock, and Postgres cannot see a cycle because our side isn't waiting on
    // the database at all. statement_timeout can't save it either — there is no
    // running statement on this connection to cancel. It simply hangs until
    // Cloudflare gives up at ~100s and returns a 524 with no explanation.
    //
    // Measured: the exact same call returns in 0.1s when the ids don't exist
    // (no rows locked, no audit written) and hangs past 45s the moment real
    // rows are updated. Same connection, same transaction, no conflict.
    const auditRow = (action, entryId, payee, details) => client.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1,$2,$3,$4,NULL,NULL,NULL,$5)`,
      [req.user?.name || 'unknown', action, entryId, payee || null, details]);
    await auditRow('expense_deleted', twinId, tw.payee,
      `Merged into #${orphanId} as a duplicate payment — bank match moved${carried.length ? `, carried over ${carried.join(', ')}` : ''}`);
    await auditRow('duplicate_pair_merged', orphanId, o.payee,
      `#${twinId} merged into #${orphanId}; ${moved} bank row(s) re-pointed`);

    await client.query('COMMIT');
    res.json({ success: true, data: { orphan_id: orphanId, twin_id: twinId, txns_moved: moved, carried } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/statements/duplicate-pairs/reject  { orphan_id }
// "Not a duplicate" — remembered, so the pair is never proposed again. Reuses
// statement_match_rejections, which already stores exactly this shape.
router.post('/duplicate-pairs/reject', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const orphanId = parseInt(req.body.orphan_id, 10);
    if (!orphanId) return res.status(400).json({ success: false, error: 'orphan_id required' });
    await pool.query(
      `INSERT INTO statement_match_rejections (txn_fingerprint, expense_root_id, source, created_by)
       VALUES ($1, $2, 'dup-pair', $3)
       ON CONFLICT (txn_fingerprint, expense_root_id) DO NOTHING`,
      [`dup-pair:${orphanId}`, orphanId, req.user.name]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/statements/tx/:txId/paid-candidates — what booking this row would
// duplicate. Read-only, so the client can warn before anything is written.
router.get('/tx/:txId(\\d+)/paid-candidates', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const t = await fetchTxnWithAccount(req.params.txId);
    if (!t) return res.status(404).json({ success: false, error: 'Transaction not found' });
    res.json({ success: true, data: { candidates: await findPaidCandidates(t) } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/tx/:txId(\\d+)/create-entry', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const t = await fetchTxnWithAccount(req.params.txId);
    if (!t) return res.status(404).json({ success: false, error: 'Transaction not found' });

    // Refuse to create a duplicate silently. The check lives HERE and not only
    // in the UI because two pages call this route, and a third caller added
    // later would otherwise reintroduce the bug. `confirm_new: true` is the
    // explicit override — a vendor really can bill the same amount twice, so
    // this must be a speed bump, not a wall.
    if (req.body.confirm_new !== true) {
      const candidates = await findPaidCandidates(t);
      if (candidates.length) {
        return res.status(409).json({
          success: false,
          error: `An already-paid invoice matches this payment — ${candidates[0].payee} `
            + `${candidates[0].invoice_number ? `(${candidates[0].invoice_number}) ` : ''}`
            + `paid ${candidates[0].payment_date}, ${candidates[0].gap_days} days from this bank date. `
            + 'Match to it instead of creating a second record, or re-send with confirm_new to create anyway.',
          data: { candidates },
        });
      }
    }

    const expenseId = await bookDebitAsEntry(t, {
      payee: req.body.payee, category: req.body.category, artist: req.body.artist,
      // Only a real boolean is an answer. A missing field is not "no" — see the
      // three-state note on bookDebitAsEntry.
      recoupable: typeof req.body.recoupable === 'boolean' ? req.body.recoupable : undefined,
      reviewedBy: req.user.id,
      userName: req.user.name,
    });

    const sweptSkipped = [];
    let sweptBooked = 0;
    if (req.body.always === true) {
      const pattern = String(req.body.pattern || displayBankPayee(t.payee_guess) || '').trim().slice(0, 120);
      const category = String(req.body.category || 'Other').trim().slice(0, 100);
      if (pattern.length >= 3) {
        await pool.query(
          `INSERT INTO statement_category_rules (pattern, category, created_by) VALUES ($1, $2, $3)`,
          [pattern, category, req.user.name]);
        await audit(req.user, 'statement_rule_added', null, null,
          `Auto-book rule "${pattern}" → ${category}`);
        // Sweep every existing unmatched debit that matches, across statements
        const { rows: txns } = await pool.query(
          `SELECT bt.*, s.account FROM bank_transactions bt
            JOIN bank_statements s ON s.id = bt.statement_id
           WHERE bt.direction = 'debit' AND bt.dismissed = false
             AND bt.matched_expense_id IS NULL
             AND (bt.payee_guess ILIKE $1 OR bt.description ILIKE $1)`,
          [`%${likeEscape(pattern)}%`]);
        // The sweep is the highest-volume duplicate risk in the file: one
        // "always book this payee as X" can book dozens of debits at once, and
        // every one of them bypasses the pre-flight above. Skip any row that
        // would duplicate an already-paid invoice and REPORT the count — a
        // silent skip would read as "the rule didn't work".
        for (const other of txns) {
          const dupes = await findPaidCandidates({ ...other, account: other.account }).catch(() => []);
          if (dupes.length) { sweptSkipped.push({ txn_id: other.id, matches: dupes[0].payee }); continue; }
          // No `recoupable` on the sweep. The answer given on the card was about
          // the row in front of the person; these are rows they have not seen,
          // and they stay in the review queue where somebody can look.
          await bookDebitAsEntry(other, { category, userName: req.user.name }).catch(() => {});
          sweptBooked += 1;
        }
      }
    }
    res.json({
      success: true,
      data: {
        expense_id: expenseId,
        ...(req.body.always === true
          ? { swept_booked: sweptBooked, swept_skipped: sweptSkipped }
          : {}),
      },
    });
  } catch (err) {
    const code = /required|Only debits|Already matched/.test(err.message) ? 400 : 500;
    res.status(code).json({ success: false, error: err.message });
  }
});

// POST /api/statements/tx/:txId/no-invoice — body { category?, confirm_new?, undo? }
//
// "This one never had an invoice." One click, one call: the debit gets a ledger
// entry if it doesn't have one, and the row is marked as needing no document, so
// it leaves the open queue for good.
//
// NOT a dismissal, and the difference is the whole point. Dismissing drops the
// money out of the P&L — right for a transfer, wrong for a meal, which is a real
// cost that simply never comes with a document. The spend stays counted, stays
// in Coverage, and stays in the debit total; it just stops being asked about.
//
// ONE call, not two. As `create-entry` then `no-invoice` from the client, a
// failure between them leaves the row BOOKED BUT UNFLAGGED — it returns to the
// queue with a ledger entry already against it, which is exactly the "that
// button did nothing" state this replaces.
//
// The flag is written BEFORE the booking, and rolled back if the booking fails.
// The two half-states are not equally bad: flagged-but-unbooked is harmless
// because /completion only consults the flag for rows that HAVE an entry (an
// unmatched row is `open` regardless), whereas booked-but-unflagged silently
// re-opens. So the order is chosen to make the survivable failure the only one
// reachable.
// POST /api/statements/no-invoice/bulk  { txn_ids: [...], confirm_new?, undo? }
//
// Answer a whole selection at once. FACEBOOK has 176 rows needing this answer,
// SPOTIFY 151, UBER 133 — and 1,269 rows across 399 vendors qualify in total, so
// one request per row is not a feature, it is a way to half-finish and not know
// where you stopped.
//
// Every row still goes through the SAME rules as the single-row route: only
// debits, never a row already matched to a real invoice, the flag written before
// the booking and rolled back if the booking fails. Rather than restate those
// (four rules that have each been reasoned about once already), this loops the
// shared applyNoInvoice() below, which the single route also calls.
//
// PER-ROW OUTCOMES, not all-or-nothing. A selection of 50 will contain rows that
// are already matched, or that an already-paid invoice covers, and failing the
// whole batch because one row disagrees would make the bulk action useless on
// exactly the selections people make. The response says what happened to each.
router.post('/no-invoice/bulk', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const ids = [...new Set((Array.isArray(req.body.txn_ids) ? req.body.txn_ids : [])
      .map((x) => parseInt(x, 10)).filter(Number.isFinite))].slice(0, 500);
    if (!ids.length) return res.status(400).json({ success: false, error: 'txn_ids required' });

    const done = [];
    const skipped = [];
    for (const id of ids) {
      const t = await fetchTxnWithAccount(id);
      if (!t) { skipped.push({ id, reason: 'not found' }); continue; }
      try {
        const r = await applyNoInvoice(t, req.body, req.user);
        if (r.ok) done.push(id); else skipped.push({ id, reason: r.reason, payee: t.payee_guess });
      } catch (err) {
        skipped.push({ id, reason: err.message, payee: t.payee_guess });
      }
    }
    await audit(req.user, req.body.undo === true ? 'statement_no_invoice_cleared' : 'statement_no_invoice_expected',
      null, null,
      `${done.length} bank debit${done.length === 1 ? '' : 's'} `
      + `${req.body.undo === true ? 'expecting an invoice again' : 'marked as needing no invoice'}`
      + (skipped.length ? `; ${skipped.length} skipped` : ''));
    res.json({ success: true, data: { done: done.length, ids: done, skipped } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// One row's worth of "this never had an invoice", shared by the single-row route
// and the bulk one.
//
// The ORDER here is the load-bearing part and is why it lives in one place: the
// flag is written BEFORE the booking and rolled back if the booking fails,
// because the two half-states are not equally bad. Flagged-but-unbooked is
// harmless — /completion only consults the flag for rows that HAVE an entry, and
// an unmatched row is `open` regardless. Booked-but-unflagged silently re-opens.
//
// Returns { ok } or { ok: false, reason }, so a bulk caller can report per row
// instead of failing fifty rows because one of them is already matched.
async function applyNoInvoice(t, body, user) {
  if (t.direction !== 'debit') return { ok: false, reason: 'not a debit' };

  if (body.undo === true) {
    await pool.query(`UPDATE bank_transactions SET no_invoice_expected = false WHERE id = $1`, [t.id]);
    return { ok: true, undone: true, expense_id: t.matched_expense_id };
  }

  // A row tied to a REAL invoice cannot be needing no invoice — the document is
  // already there. Refuse rather than record a contradiction.
  if (t.matched_expense_id && t.match_method !== 'created') {
    return { ok: false, reason: 'already matched to a real invoice' };
  }

  await pool.query(`UPDATE bank_transactions SET no_invoice_expected = true WHERE id = $1`, [t.id]);
  const unflag = () => pool.query(
    `UPDATE bank_transactions SET no_invoice_expected = false WHERE id = $1`, [t.id]).catch(() => {});

  let expenseId = t.matched_expense_id;
  let booked = false;
  if (!expenseId) {
    // Same duplicate speed bump as create-entry: "no invoice exists" is exactly
    // the claim an already-paid invoice refutes.
    if (body.confirm_new !== true) {
      const candidates = await findPaidCandidates(t).catch(() => []);
      if (candidates.length) {
        await unflag();
        const c = candidates[0];
        const err = new Error(`An already-paid invoice matches this payment — ${c.payee} `
          + `${c.invoice_number ? `(${c.invoice_number}) ` : ''}paid ${c.payment_date}, `
          + `${c.gap_days} days from this bank date. Match to it instead, or re-send with `
          + 'confirm_new to book this anyway.');
        err.candidates = candidates;
        err.status = 409;
        throw err;
      }
    }
    try {
      expenseId = await bookDebitAsEntry(t, {
        payee: body.payee, category: body.category, artist: body.artist,
        recoupable: typeof body.recoupable === 'boolean' ? body.recoupable : undefined,
        reviewedBy: user.id,
        userName: user.name,
      });
      booked = true;
    } catch (err) {
      await unflag();
      throw err;
    }
  }
  return { ok: true, expense_id: expenseId, booked };
}

router.post('/tx/:txId(\\d+)/no-invoice', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const t = await fetchTxnWithAccount(req.params.txId);
    if (!t) return res.status(404).json({ success: false, error: 'Transaction not found' });

    let r;
    try {
      r = await applyNoInvoice(t, req.body, req.user);
    } catch (err) {
      if (err.status === 409) {
        return res.status(409).json({ success: false, error: err.message, data: { candidates: err.candidates } });
      }
      throw err;
    }
    if (!r.ok) {
      return res.status(400).json({ success: false, error:
        r.reason === 'not a debit' ? 'Only debits can be marked as needing no invoice'
          : 'This debit is already matched to a real invoice — unmatch it first if that pairing is wrong.' });
    }
    if (r.undone) {
      await audit(req.user, 'statement_no_invoice_cleared', t.matched_expense_id || null, t.payee_guess || null,
        `Bank debit #${t.id} is expecting an invoice again — back in the open queue`);
      return res.json({ success: true, data: { no_invoice_expected: false, expense_id: t.matched_expense_id } });
    }
    await audit(req.user, 'statement_no_invoice_expected', r.expense_id, t.payee_guess || null,
      `Bank debit #${t.id} ($${t.amount}) needs no invoice`);
    res.json({ success: true, data: { no_invoice_expected: true, expense_id: r.expense_id, booked: r.booked } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Category rules CRUD ──────────────────────────────────────────────────────

// Each rule annotated with WHAT IT IS DOING, not just what it says.
//
// A category rule books through bookDebitAsEntry, so its rows land with
// match_method='created' — which /completion counts as "still needs an invoice".
// Unpaired with a no-invoice answer, the rule quietly feeds the queue it looks
// like it is clearing: 6 of the 10 rules in force were doing exactly that, 137
// rows and $26,528 between them, and nothing on the page said so. A rule list
// that shows only the pattern cannot tell a working rule from a leaking one.
// The annotation costs four extra queries, one of them over every booked debit,
// so it is OPT-IN via ?annotate=1. Bank Matching also calls this route on mount
// and only wants the count — and that page was just taken from 15,790ms to
// 427ms, which is not a number to give back for a field it doesn't read.
router.get('/category-rules', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows } = await pool.query(`SELECT * FROM statement_category_rules ORDER BY created_at DESC`);
    if (!rows.length || req.query.annotate !== '1') return res.json({ success: true, data: rows });

    const norm = (v) => String(v || '').trim().toLowerCase();
    const [{ rows: booked }, { rows: niRules }, rowAnswered, census] = await Promise.all([
      // Every booked row the queue could hold. ~2.3k rows, and the per-rule
      // counting is a substring test in JS — the same ILIKE '%p%' the rule
      // itself uses, so the number describes the rule that is really running.
      pool.query(`
        SELECT bt.id, bt.payee_guess, bt.description, bt.amount,
               COALESCE(bt.currency, 'USD') AS currency, e.payee, e.category
          FROM bank_transactions bt
          JOIN expenses e ON e.id = bt.matched_expense_id
         WHERE bt.direction = 'debit' AND bt.dismissed = false
           AND bt.match_method = 'created'
           AND (e.deleted = false OR e.deleted IS NULL)`),
      pool.query(`SELECT scope, pattern FROM statement_no_invoice_rules`).catch(() => ({ rows: [] })),
      loadNoInvoiceRowIds(),
      loadInvoiceCensus(),
    ]);
    const niVendor = new Set(niRules.filter((r) => r.scope === 'vendor').map((r) => norm(r.pattern)));
    const niCategory = new Set(niRules.filter((r) => r.scope === 'category').map((r) => norm(r.pattern)));
    const inQueue = booked.filter((r) => !rowAnswered.has(r.id)
      && !niVendor.has(norm(r.payee)) && !niCategory.has(norm(r.category)));

    const realOf = (name) => census.real.get(norm(name)) || 0;
    const data = rows.map((rule) => {
      const p = norm(rule.pattern);
      const mine = inQueue.filter((r) => norm(r.payee_guess).includes(p) || norm(r.description).includes(p));
      // Which ledger vendors those rows resolve to — the pattern a no-invoice
      // rule needs, since venRules compares the LEDGER payee by equality.
      const byPayee = new Map();
      for (const r of mine) {
        const name = (r.payee || r.payee_guess || '').trim();
        const g = byPayee.get(norm(name)) || { payee: name, rows: 0, real_invoices: realOf(name) };
        g.rows += 1;
        byPayee.set(norm(name), g);
      }
      // What a vendor-scope no-invoice rule on that name would ACTUALLY clear —
      // /completion matches e.payee OR bt.payee_guess, so it reaches rows filed
      // under a different ledger name that share the descriptor, including rows
      // this rule doesn't touch. Counting only `rows` under-promises: measured,
      // one accept promised 3 and delivered 14.
      for (const g of byPayee.values()) {
        const p = norm(g.payee);
        g.clears = inQueue.filter((r) => norm(r.payee) === p || norm(r.payee_guess) === p).length;
      }
      return {
        ...rule,
        // How many rows this rule is currently putting in the needs-invoice
        // queue. Zero means it is either paired or has no rows; non-zero is a
        // leak, reported where the leak is.
        queue_rows: mine.length,
        queue_usd: Math.round(mine.reduce((s, r) => s + Math.abs(usdOf(r.amount, r.currency)), 0) * 100) / 100,
        // Split so the client never offers "these never invoice" for a vendor
        // the ledger contradicts.
        ledger_payees: [...byPayee.values()].sort((a, b) => b.rows - a.rows).slice(0, 6),
      };
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/category-rules/:id(\\d+)', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    await pool.query(`DELETE FROM statement_category_rules WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Bulk confirm: matched-but-unpaid → Paid with the bank's date + ref ───────

router.post('/:id(\\d+)/confirm-paid', async (req, res) => {
  try {
    if (!isStrictAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const txIds = Array.isArray(req.body.tx_ids) ? req.body.tx_ids.map(Number).filter(Boolean) : [];
    if (!txIds.length) return res.status(400).json({ success: false, error: 'tx_ids required' });

    const { rows: txns } = await pool.query(
      `SELECT * FROM bank_transactions WHERE statement_id = $1 AND id = ANY($2) AND matched_expense_id IS NOT NULL`,
      [req.params.id, txIds]);

    let confirmed = 0;
    const failures = [];
    for (const t of txns) {
      try {
        // One UPDATE per family — same cascade contract as the payment PATCH.
        const { rows } = await pool.query(
          `UPDATE expenses SET payment_status = 'Paid', payment_date = $1, paid_by = $2,
             paid_marked_at = NOW(), payment_ref = COALESCE(payment_ref, $3)
           WHERE (id = $4 OR parent_id = $4) AND payment_status IS DISTINCT FROM 'Paid'
           RETURNING id, payee`,
          [t.txn_date, req.user.name, t.reference, t.matched_expense_id]);
        if (rows.length) {
          confirmed++;
          await audit(req.user, 'statement_confirmed_paid', t.matched_expense_id, rows[0].payee,
            `Marked Paid from bank statement: $${t.amount} on ${t.txn_date}${t.reference ? ` ref ${t.reference}` : ''}`);
        }
      } catch (e) {
        failures.push(`txn ${t.id}: ${e.message}`);
      }
    }
    res.json({ success: true, confirmed, failures });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Exported for the duplicate-guard test. insertRows is where a re-parse either
// double-books a month or does not, and the only way to prove which is to drive
// it directly — through the route it would need a PDF and the AI.
router.insertRows = insertRows;
router.refFromDescription = refFromDescription;
// Same reason. The reconciliation fixture has to bucket rows with the REAL
// no-invoice predicate — rebuilding it in the test would prove that the copy
// agrees with itself, which is the failure mode the predicate exists to stop.
router.makeNoInvoiceExpected = makeNoInvoiceExpected;

module.exports = router;
