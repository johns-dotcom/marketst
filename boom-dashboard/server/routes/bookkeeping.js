/**
 * /api/bk — Bookkeeping routes
 *
 * Covers: ledger, add/edit/delete, file management, approvals, AI parse,
 * vendors, payments, analytics, history, 1099, invoice search, W9s,
 * exports (Excel + QB CSV), and the two dashboard-integration endpoints.
 *
 * Auth: all routes require a valid JWT (authMiddleware).
 * Admin check: approve/reject/export/clear-history require Admin or Superadmin.
 */

const express = require('express');
const multer  = require('multer');
const pool    = require('../db');
const auth    = require('../middleware/auth');
const { rescanInvoice, rescanW9, INVOICE_SCAN_FIELDS, W9_SCAN_FIELDS } = require('../services/aiScan');
const { callClaude } = require('../services/claude');
const { CATEGORIES, PAYMENT_METHODS } = require('../lib/constants');
const paymentCrypto = require('../lib/payment-crypto');
const qbo = require('../lib/qbo'); // QuickBooks push queue — enqueue is a no-op until QuickBooks is connected
const { categoryVocabulary } = require('../lib/category-vocab');
const { parseInvoiceLines } = require('../lib/invoice-lines');
const { extractPdfText } = require('../lib/statement-pdf');
const { uploadFile, getSignedFileUrl, downloadFile, loadFileBase64, loadFileBuffer, deleteFile } = require('../lib/r2');
const { sniffMime } = require('../lib/sniffMime');
const { postEvent } = require('../lib/activityBot');
const { normalizeInvoiceNum } = require('../lib/normalize-invoice-num');
const { bankEvidenceCols, noBankEvidenceSql } = require('../lib/bank-evidence');
const { excludeBankRows, excludeCreatorRows } = require('../lib/ledger-source');
const { w9OwnersFor } = require('../lib/w9-owner');
const { W9_TAX_PROMPT, parseW9Tax, exemptionFor } = require('../lib/w9-tax');
const { storeW9Tax, readAndStoreW9Tax } = require('../services/w9Tax');
const { usdOf } = require('../lib/usd');
const { loadRecoupmentClassRules, notClassRuledSql } = require('../lib/recoupment-class');
const { loadArtistProposals, loadLedgerTwins, attachRecoupContext } = require('../lib/recoup-context');
const { isNoiseAlias, loadAliasIndex } = require('../lib/vendor-aliases');
const { normalizeSocialRows } = require('../lib/socials');
const { newGroupKey, validateGroup } = require('../lib/settlement-groups');
const { autoLinkRelease } = require('../lib/release-linking');
const { getVendorEmailRows, mergeVendorCc } = require('../lib/vendorEmails');
const { requirePagePermission } = require('../middleware/pagePermission');

const router = express.Router();
router.use(auth);
// Bookkeeping endpoints require the user have SOME bookkeeping page
// grant (Admin / Superadmin / Approver bypass this entirely — those
// three roles are unrestricted). Every bk page is listed so a User
// granted any one of them can reach /api/bk/*; the finer-grained
// per-endpoint gating (e.g., only /bk/ledger users can hit
// /api/bk/entries) is deferred — the client-side page gate already
// hides the routes and the sidebar links.
//
// '/bk/lookup' has no page behind it any more, and stays in this list
// deliberately. Permissions are STORED BY PATH, so a user whose grants
// still carry it would lose /api/bk/* entirely if it were dropped —
// the same reason /bk/ledger-matching kept its path when it was
// renamed. It grants nothing on its own; it only keeps an existing
// row from silently becoming a revocation.
router.use(requirePagePermission(
  '/bk/ledger', '/bk/bank-ledger', '/bk/add', '/bk/reimburse', '/bk/approvals',
  '/bk/vendors', '/bk/payments', '/bk/invoices', '/bk/lookup', '/bk/1099',
  '/bk/bulk-deals', '/bk/bulk-upload', '/bk/bulk-reupload',
  '/bk/ledger-matching', '/bk/bank-matching', '/recoupments', '/recoupments/planning', '/artist-campaigns',
));

// ── multer: memory storage so we base64-encode before writing to DB ─────────
const { secureFileFilter } = require('../middleware/secureUpload');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: secureFileFilter,
});

// ── helpers ──────────────────────────────────────────────────────────────────

// Bookkeeping admin gate — Admin, Superadmin, or the "Approver" semi-admin
// role. Approver was added so trusted A&R leads (Soli) can run the full
// Approvals page workflow — approve/reject, edit, split, manage vendor
// aliases, merge vendors, etc. Admin actions outside bookkeeping (user
// management, artist/release deletes) use their own role checks elsewhere
// and aren't affected.
const isAdmin = (user) =>
  user && (user.role === 'Admin' || user.role === 'Superadmin' || user.role === 'Approver');

// The same gate under the name the rest of the codebase uses for it.
//
// CLAUDE.md has always called this `isBkAdmin`, and `GET /vendors/:payee/
// payment-details` — the ONLY route that decrypts a vendor's bank details —
// calls it by that name. It was never defined here, so that route threw
// `ReferenceError: isBkAdmin is not defined` inside its try block and answered
// 500 to everybody, including Superadmins. Verified against production on
// 2026-09-01 before this line existed: two vendors, both
// `{"success":false,"error":"isBkAdmin is not defined"}`.
//
// An alias rather than a rename, because `isAdmin` has ~90 call sites here and
// churning them would bury the one-line fix that matters in a diff nobody can
// read.
const isBkAdmin = isAdmin;

// ── The approval checklist ─────────────────────────────────────────────────
//
// John, 2026-08-19: approvers must confirm what they looked at before an
// invoice is accepted. Six questions, and they are NOT the same kind of
// question — which is the whole reason this is a validator and not a
// "six booleans, all true" check:
//
//   CONFIRMATIONS  artist · song · amount · category
//     "is this right?" — only `true` is an answer. `false` means the invoice is
//     wrong and belongs in a fix or a rejection, not an approval.
//
//   ANSWERS        bulk_deal · cobrand
//     "is this one?" — `true` and `false` are BOTH valid, and the endpoint
//     writes them to is_bulk_deal / cobrand. Absent is not an answer.
//     This is the only thing that ever separates "someone decided no" from
//     "nobody ever looked" on those two columns: both are BOOLEAN DEFAULT
//     FALSE, across 3,174 and 3,527 live rows respectively.
//
// Lives on the SERVER because a disabled button is not a gate. The deck's
// disabled state is a convenience on top of this.
const CHECKLIST_CONFIRM = ['artist', 'song', 'amount', 'category'];
const CHECKLIST_ANSWER = ['bulk_deal', 'cobrand', 'recoupable', 'campaign'];

function validateApprovalChecklist(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'This invoice needs the approval checklist completed — approve it from the review deck on the Approvals page.' };
  }
  const missing = CHECKLIST_CONFIRM.filter((k) => raw[k] !== true);
  if (missing.length) {
    return { ok: false,
      error: 'Not confirmed: ' + missing.join(', ') + '. Every item has to be confirmed before this invoice can be approved — if one of them is wrong, fix it or reject the invoice.' };
  }
  // Cobrand spend IS campaign spend, so answering cobrand answers campaign — the
  // same implication that already forces category = 'Marketing'. Treated as
  // ANSWERED here rather than refused, because "automatically yes" is the
  // behaviour asked for and demanding a second click for a value the approver
  // cannot change would be theatre.
  const impliedCampaign = raw.cobrand === true;
  const unanswered = CHECKLIST_ANSWER.filter((k) => {
    if (k === 'campaign' && impliedCampaign) return false;
    return typeof raw[k] !== 'boolean';
  });
  if (unanswered.length) {
    return { ok: false,
      error: 'Not answered: ' + unanswered.join(', ') + '. Answer yes or no — leaving it blank is what makes "no" and "nobody looked" the same thing.' };
  }
  return { ok: true, value: {
    artist: true, song: true, amount: true, category: true,
    bulk_deal: raw.bulk_deal === true,
    cobrand: raw.cobrand === true,
    recoupable: raw.recoupable === true,
    // Forced, not merely defaulted: a client that sent cobrand=true with
    // campaign=false does not get to store the contradiction.
    campaign: impliedCampaign ? true : raw.campaign === true,
    campaign_implied_by_cobrand: impliedCampaign || undefined,
  } };
}

/** The checklist plus who answered it and when. Pure — no DB, so it can be
 *  built before a transaction and written inside it. */
function stampChecklist(checklist, user) {
  return { ...checklist, by: user?.name || null, at: new Date().toISOString() };
}

/**
 * Write the checklist onto the entry and apply the two answers it carries.
 *
 * Takes the connection so it can run INSIDE the caller's transaction — the
 * stored checklist and the row it describes must not be able to disagree, and
 * a separate PUT from the client beforehand is two round trips that can
 * half-fail.
 *
 * Mirrors the cobrand rule from PUT /entries/:id: cobrand spend IS marketing
 * spend, so answering yes forces category = 'Marketing'. That is exactly why
 * the deck re-arms the category tick when this answer changes — otherwise an
 * approver confirms "category: Services" and the row saves as Marketing,
 * contradicting the checklist they just completed.
 *
 * @param {object} q  pool, or a pinned client inside a transaction
 */
async function writeApprovalChecklist(q, entryId, stamped) {
  await q.query(
    `UPDATE expenses
        SET approval_checklist = $1,
            is_bulk_deal = $2,
            cobrand = $3,
            category = CASE WHEN $3 THEN 'Marketing' ELSE category END,
            -- The answer, written to the column the recoupment surfaces read.
            -- NB: no backticks in here — this is inside a JS template literal.
            --
            -- expenses.recoupable is BOOLEAN DEFAULT TRUE, which is why nothing
            -- in this app can currently prove an artist's recoupable total is
            -- right: 1,292 rows read recoupable because nobody looked, and only
            -- the 179 marked NOT recoupable ever required an act. Asking at
            -- approval makes it a decision for every invoice from here on, which
            -- is the only way that asymmetry closes.
            recoupable = $4,
            -- artist_campaign is TEXT holding 'Yes' / 'No', defaulting to 'Yes'
            -- — so like recoupable it reads yes whether somebody decided it or
            -- nobody looked (3,221 'Yes' against 242 'No' on the live ledger).
            -- The answer makes it a decision.
            artist_campaign = CASE WHEN $5 THEN 'Yes' ELSE 'No' END
      WHERE id = $6`,
    [JSON.stringify(stamped), stamped.bulk_deal, stamped.cobrand, stamped.recoupable,
      stamped.campaign, entryId]
  );
}

// ── Per-user rep visibility (allow-list model) ─────────────────────────────
//
// Visibility tiers, applied to every Approvals + Payments read / action:
//   • Admin / Superadmin → sees every rep. Helpers no-op.
//   • Approver / User    → sees rows where boom_rep matches their own
//                          user.boom_rep (admin-assigned) OR is in their
//                          allow-list. NULL boom_rep on the entry is
//                          hidden from non-admins.
//   • Other roles / null → sees nothing (defensive default).
//
// Approvers now share the "no filter" branch with Admin / Superadmin —
// they're expected to review + act on every invoice regardless of rep,
// same as Admin. Regular Users are still scoped to their own rep +
// explicit allow-list. Action-level admin gates (approve / reject /
// merge vendors / etc.) are unchanged; only row-visibility opens up.

// Build a SQL fragment that limits to rows the current user is allowed
// to see. Mutates `params` (pushes whatever placeholders are needed)
// and returns the parameterized clause. Returns '' for Admin /
// Superadmin / Approver so callers can splice unconditionally:
//
//   const vis = userVisibleRepsClause(req.user, params);
//   if (vis) conditions.push(vis);
//
// `alias` defaults to 'e'; pass null for unaliased queries.
function userVisibleRepsClause(user, params, alias = 'e') {
  if (!user) return 'FALSE';
  if (user.role === 'Admin' || user.role === 'Superadmin' || user.role === 'Approver') return '';
  if (user.role !== 'User') return 'FALSE';

  const col = alias ? `${alias}.boom_rep` : 'boom_rep';
  // Build the SQL conditionally on whether the user has a boom_rep
  // assignment. Earlier this helper pushed `null` as a parameter and
  // relied on `$N IS NOT NULL` to short-circuit the own-rep branch,
  // but that caused Postgres to throw "could not determine data type
  // of parameter" because the type of a bare NULL parameter can't be
  // inferred from `IS NOT NULL` alone. Building two distinct SQL
  // shapes — own-rep + allow-list when assigned, allow-list only when
  // not — sidesteps the issue entirely.
  if (user.boom_rep) {
    params.push(user.boom_rep);
    const repIdx = params.length;
    params.push(user.id);
    const idIdx = params.length;
    return `(
      LOWER(TRIM(${col})) = LOWER(TRIM($${repIdx}))
      OR ${col} IN (
        SELECT visible_rep FROM user_visible_reps WHERE user_id = $${idIdx}
      )
    )`;
  }
  // No boom_rep assigned — only the explicit allow-list applies. For
  // Approvers this means they see nothing unless admin has configured
  // visible-reps. For Users likewise (which matches the spec: "the
  // default for users is they should only be able to see payments
  // with them as a rep" — no rep assigned, no rows visible).
  params.push(user.id);
  const idIdx = params.length;
  return `(${col} IN (
    SELECT visible_rep FROM user_visible_reps WHERE user_id = $${idIdx}
  ))`;
}

// Per-entry visibility check. Returns true if the user is allowed to
// see / act on this entry. Used by action endpoints as a defense-in-
// depth backstop against ID-guessing.
async function userCanActOnEntry(user, entryId) {
  if (!user) return false;
  if (user.role === 'Admin' || user.role === 'Superadmin' || user.role === 'Approver') return true;
  const params = [entryId];
  const vis = userVisibleRepsClause(user, params, 'e');
  // vis === '' only happens for Admin/Superadmin/Approver, all of
  // whom already short-circuited to true above. Kept as a safety
  // net; if somehow reached, allow the action rather than silently
  // 403 a whole batch.
  if (!vis) return true;
  const { rows } = await pool.query(
    `SELECT 1 FROM expenses e WHERE e.id = $1 AND ${vis} LIMIT 1`,
    params
  );
  return rows.length > 0;
}

// Bulk pre-check for batch endpoints. Given an array of entry ids,
// returns the first id that's hidden from the current user (so the
// caller can 403 the whole batch with a useful error message). Returns
// null when every id is visible. Admin / Superadmin / Approver always
// return null — they see everything.
async function findInvisibleEntry(user, entryIds) {
  if (!user) return { id: null, boom_rep: null };
  if (user.role === 'Admin' || user.role === 'Superadmin' || user.role === 'Approver') return null;
  if (!Array.isArray(entryIds) || !entryIds.length) return null;
  const params = [entryIds];
  const vis = userVisibleRepsClause(user, params, 'e');
  if (!vis) return null;
  // Find ids the user CAN'T see. We negate the clause: row exists AND
  // NOT (visible). NULL boom_rep is excluded by the visibility clauses
  // implicitly, so this catches them as invisible.
  const { rows } = await pool.query(
    `SELECT e.id, e.boom_rep
       FROM expenses e
      WHERE e.id = ANY($1::int[])
        AND NOT ${vis}
      LIMIT 1`,
    params
  );
  return rows[0] || null;
}

// Convert a payment-terms string into the number of days it represents.
// Supports "Net N" (any N) and "Due on receipt". Anything unrecognized
// falls back to 30 so we always produce a sensible due date.
function termDays(terms) {
  const t = String(terms || '').trim();
  if (/^due\s*on\s*receipt$/i.test(t)) return 0;
  const m = t.match(/^net\s+(\d+)/i);
  if (m) return parseInt(m[1], 10);
  return 30;
}

// Today's date in Market Street's headquarters timezone (LA), as YYYY-MM-DD.
// Used to anchor "payment date = the day the row was flipped to Paid"
// across every status-flip path. Postgres-equivalent SQL expression:
//   (NOW() AT TIME ZONE 'America/Los_Angeles')::DATE
// Use the JS helper when populating a parameterised INSERT value;
// use the inline SQL expression when writing to a column via a CASE.
function todayLA() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Compute scheduled_payment_date from a SUBMISSION date + term days. The
// submission date is when Market Street received the invoice (NOW() at create time
// == the row's created_at), NOT the invoice_date printed on the document.
// Anchoring to submission gives a consistent 30-day window regardless of
// how stale the invoice itself is — a vendor's 90-day-old invoice still
// gets the full 30 days from when we got it. Returns null when the
// submission date can't be parsed.
function computeDueDate(submissionDate, terms) {
  if (!submissionDate) return null;
  const d = new Date(submissionDate);
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + termDays(terms));
  return d.toISOString().slice(0, 10);
}

const { applyArtistNormalization } = require('../lib/artist-normalization');

// Every column on `expenses` EXCEPT the four base64 TEXT blobs
// (invoice_data, w9_data, proof_data, receipt_data). The blobs can be 10+ MB
// each, and list endpoints were returning them only to discard them in JS —
// wasting Postgres-to-Node wire transfer, heap, and GC pressure on rows that
// the client never reads the bytes for. File bytes are served via the
// dedicated /entries/:id/file/:type download endpoint.
//
// Keep this list in sync with the CREATE TABLE expenses block in
// server/index.js + any ALTER TABLE ADD COLUMN migration lines that follow.
// A missed column here silently omits the field from list responses.
const EXPENSE_LIGHT_COLS = [
  'id', 'invoice_date', 'payee', 'description', 'category', 'artist', 'song',
  'invoice_number', 'amount', 'currency',
  'payment_method', 'payment_date', 'in_quickbooks', 'qb_entry_date',
  'uploaded_to_stem', 'stem_upload_date',
  'invoice_filename', 'w9_filename', 'proof_filename', 'receipt_filename',
  'invoice_r2_key', 'w9_r2_key', 'proof_r2_key',
  'vendor_submitted', 'vendor_name', 'vendor_email', 'vendor_address', 'vendor_bank', 'paypal_handle',
  'status', 'approved_by', 'approved_at',
  'payment_status', 'payment_terms', 'scheduled_payment_date', 'paid_by', 'payment_ref', 'paid_marked_at', 'fx_rate_to_usd',
  'artist_breakdown', 'cobrand', 'is_reimbursement', 'recoupable', 'ufr', 'ufr_marked_at', 'artist_campaign', 'recoupment_label', 'social_handles', 'is_2025_expense',
  // Whether somebody has ANSWERED "is this bank-born cost recoupable?" — the gate
  // the recoupment surfaces admit statement-born rows on, distinct from the
  // `recoupable` default above. Omitted from this list, it would be silently
  // absent from every list response and the gate would never open.
  'recoup_reviewed', 'recoup_reviewed_at',
  // Which campaign this row's money belongs to (/bk/advertising). Absent from
  // this list, an allocated ad slice would come back with no campaign and the
  // page would show its own writes as unallocated.
  'campaign_id',
  // The vendor's payment details as they stood for THIS invoice: which account
  // (last 4 only) and whether the form agreed with the document. Absent from this
  // list, the Approvals flag would never render and the payments dashboard could
  // not say which account it is about.
  'payment_check', 'payment_last4',
  // The W-9's tax identity, minus the secret. `w9_tin_enc` is DELIBERATELY not
  // listed — it is the fifth column this list omits on purpose, and the only
  // one omitted for being sensitive rather than for being a multi-MB blob.
  // Listing it would ship an encrypted SSN in every list response on four
  // pages; `w9_tin_last4` is what any screen needs to show, and the full value
  // is decrypted only by the one route allowed to.
  'w9_tin_last4', 'w9_tin_type', 'w9_tax_classification', 'w9_tax_scanned_at',
  // HOW this invoice was to be paid, frozen at submission. Omitted from this
  // list it would be written and never read — the failure this file has already
  // seen twice (the creator payment_status column, the vendor payment columns).
  'payment_snapshot',
  // Which invoices this one is paid together with. Absent from this list the
  // ledger cannot show a group chip and Bulk Upload cannot read back what it set.
  'settlement_group',
  'approval_checklist',
  // The W9 attestation. Absent from this list it would be missing from every
  // list response and the deck could never tell a reviewed W9 from a new one.
  'w9_review',
  'confirmation_sent',
  'is_bulk_deal', 'bulk_deal_quantity', 'bulk_deal_unit', 'bulk_deal_completed',
  'notes', 'boom_rep', 'deleted', 'deleted_by', 'deleted_at', 'parent_id', 'no_auto_split',
  'voided', 'voided_at', 'voided_by',
  'ai_scan', 'w9_scan', 'release_id',
  'rush_requested', 'rush_requested_at', 'rush_requested_by', 'rush_reason',
  'on_hold', 'hold_at', 'hold_by', 'hold_reason',
  'budget_section_override',
  'flagged', 'flagged_at', 'flagged_by', 'flag_reason',
  'off_roster_artist',
  'entry_source',
  'item_finished', 'item_finished_at', 'item_finished_by',
  'created_at', 'created_by',
];

// Build a comma-separated SQL column list. With an alias ("e"), each column
// is prefixed (e.id, e.invoice_date, …). Without, the raw names are used —
// suitable for single-row SELECT … FROM expenses WHERE id = $1 queries.
const expenseCols = (alias) =>
  (alias ? EXPENSE_LIGHT_COLS.map(c => `${alias}.${c}`) : EXPENSE_LIGHT_COLS).join(', ');

// ── The Ledger's own column set ──────────────────────────────────────────────
//
// /bk/entries returns 99 columns. The ledger reads 59 of them. On 3,656 rows the
// difference is most of an 8.67 MB response — and not mainly in values: 99 JSON
// keys repeated 3,656 times is roughly 5 MB of key names alone.
//
// Derived by scanning BkLedger.jsx AND every local module it hands a row object
// to (BankEvidenceDot reads `bank_expected`, SocialsCell reads `social_handles`,
// entryFiles reads the has_* flags), because grepping the page alone would have
// dropped columns its own children need. If you add a field to the ledger UI,
// add it here too or it will simply be undefined.
//
// Opt-in via ?view=ledger. The default response is unchanged, so BkLookup,
// BkArchive, BkStatements and RecoupmentsPlanning are untouched.
const LEDGER_VIEW_COLS = [
  'id', 'invoice_date', 'payee', 'description', 'category', 'artist',
  'song', 'invoice_number', 'amount', 'currency', 'payment_method', 'payment_date',
  'in_quickbooks', 'receipt_filename', 'vendor_submitted', 'vendor_email', 'vendor_address', 'vendor_bank',
  'status', 'approved_by', 'payment_status', 'payment_terms', 'scheduled_payment_date', 'paid_by',
  'payment_ref', 'fx_rate_to_usd', 'artist_breakdown', 'cobrand', 'is_reimbursement', 'recoupable',
  'ufr', 'artist_campaign', 'recoupment_label', 'social_handles', 'is_bulk_deal', 'bulk_deal_quantity',
  'bulk_deal_unit', 'notes', 'boom_rep', 'deleted', 'parent_id', 'voided',
  'voided_at', 'voided_by', 'release_id', 'flagged', 'flagged_at', 'flagged_by',
  'flag_reason', 'entry_source', 'created_at',
];

// Human-readable labels for each internal action code. Keeps the Activity
// page readable when it renders bookkeeping entries alongside app-wide ones.
const BK_ACTION_LABELS = {
  expense_added: 'Added invoice',
  expense_updated: 'Updated invoice',
  expense_deleted: 'Deleted invoice',
  expense_restored: 'Restored invoice',
  expense_approved: 'Approved invoice',
  expense_approved_split: 'Approved & split invoice',
  expense_rejected: 'Rejected invoice',
  expense_split: 'Split invoice',
  expense_unsplit: 'Unsplit invoice',
  expense_voided: 'Voided invoice',
  expense_unvoided: 'Restored voided invoice',
  scan_dismissed: 'Dismissed AI scan',
  bulk_approve: 'Bulk approved invoices',
  vendor_renamed: 'Renamed vendor',
  vendor_alias_added: 'Added vendor alias',
  vendor_alias_reassigned: 'Reassigned vendor alias',
  vendor_merged: 'Merged vendors',
  payment_updated: 'Updated payment',
  installment_added: 'Recorded payment installment',
  installment_removed: 'Removed payment installment',
  recoupment_artist_note_set: 'Updated artist recoupment note',
  recoupment_song_note_set: 'Updated song recoupment note',
  payment_confirmation_sent: 'Sent payment confirmation',
  payment_approval_email_sent: 'Sent approval email',
  payment_approval_email_test: 'Sent test approval email',
  invoice_uploaded: 'Uploaded invoice',
  w9_uploaded: 'Uploaded W9',
  proof_uploaded: 'Uploaded proof of payment',
  receipt_uploaded: 'Uploaded receipt',
};

// Log a bookkeeping action to both bk_audit_log (detailed, per-entry history
// used by the Approvals "Recent Activity" widget and per-entry audit modal)
// AND activity_log (the unified feed on the Activity page). Accepts either a
// user object (preferred — lets us fill activity_log.user_id) or a bare name
// string for legacy callers.
async function logBkAction(userOrName, action, entryId, entryPayee, field, oldVal, newVal, details) {
  const userName = typeof userOrName === 'string' ? userOrName : userOrName?.name || null;
  const userId = typeof userOrName === 'object' ? userOrName?.id || null : null;

  try {
    await pool.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [userName, action, entryId || null, entryPayee || null, field || null,
       oldVal != null ? String(oldVal) : null,
       newVal != null ? String(newVal) : null,
       details || null]
    );
  } catch (_) { /* best-effort */ }

  // Mirror to activity_log for the unified Activity page feed.
  try {
    const prettyAction = BK_ACTION_LABELS[action] || action;
    let detail = details || null;
    if (!detail && field && (oldVal != null || newVal != null)) {
      detail = `${field}: ${oldVal ?? '—'} → ${newVal ?? '—'}`;
    }
    await pool.query(
      `INSERT INTO activity_log (user_id, action, detail, entry_id, entry_payee, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [userId, prettyAction, detail, entryId || null, entryPayee || null]
    );
  } catch (_) { /* best-effort */ }
}

// autoLinkRelease now lives in ../lib/release-linking so releases.js can hook
// the reverse direction (retroactive linking on release create/rename) without
// pulling in the whole bookkeeping router. Same contract as before — see the
// lib file for the two-pass matching details.

// Walk to the family root for any expense id. Returns null if the id doesn't
// exist. The root is the parent of a split family, or the entry itself when
// it isn't split. Installments always live on the root — splits are an
// internal accounting construct, the vendor was paid once.
async function resolveFamilyRoot(expenseId, client = pool) {
  const { rows } = await client.query(
    `SELECT id, parent_id, payee FROM expenses WHERE id = $1`,
    [expenseId]
  );
  if (!rows.length) return null;
  const rootId = rows[0].parent_id || rows[0].id;
  if (rootId === rows[0].id) return { rootId, payee: rows[0].payee };
  const { rows: rootRows } = await client.query(
    `SELECT id, payee FROM expenses WHERE id = $1`, [rootId]
  );
  return rootRows.length ? { rootId, payee: rootRows[0].payee } : null;
}

// Copy the family-shared payment fields from a just-updated row to every
// other row in its split family (parent + siblings + children). Extracted
// verbatim from PUT /payments/:id so PUT /entries/:id and the proof-upload
// paths apply the exact same cascade — a family must never disagree on
// payment state. `target` must carry the POST-update values for the copied
// columns (use the UPDATE's RETURNING row). Returns { hasFamily, rootId }.
async function cascadePaymentFieldsToFamily(target, client = pool) {
  const rootId = target.parent_id || target.id;
  const { rows: sibCheck } = await client.query(
    `SELECT 1 FROM expenses
      WHERE (id = $1 OR parent_id = $1)
        AND id != $2
        AND (deleted = false OR deleted IS NULL)
      LIMIT 1`,
    [rootId, target.id]
  );
  const hasFamily = sibCheck.length > 0;

  if (hasFamily) {
    await client.query(`
      UPDATE expenses
         SET payment_status = $1,
             payment_date   = $2,
             paid_by        = $3,
             -- COALESCE, not overwrite: a child row edited from the Ledger
             -- often has no method/ref of its own while the parent carries
             -- the real ones — force-copying the target's NULLs would erase
             -- the family's payment reference.
             payment_method = COALESCE($4, payment_method),
             payment_ref    = COALESCE($5, payment_ref),
             paid_marked_at = $6,
             -- Mirror the lock-clearing logic on the target row. The
             -- whole family shares currency + paid timing, so when the
             -- target's lock was cleared, every sibling's lock should
             -- be too. stampFxRateAsync re-stamps each row with the
             -- fresh rate.
             fx_rate_to_usd = $7,
             -- Mirror the rush + hold clearing logic on the target
             -- row. A paid sibling with a stale RUSH / HOLD badge
             -- would otherwise still show up under the quick-filter.
             rush_requested    = CASE WHEN $1 = 'Paid' THEN FALSE ELSE rush_requested END,
             rush_requested_at = CASE WHEN $1 = 'Paid' THEN NULL  ELSE rush_requested_at END,
             rush_requested_by = CASE WHEN $1 = 'Paid' THEN NULL  ELSE rush_requested_by END,
             rush_reason       = CASE WHEN $1 = 'Paid' THEN NULL  ELSE rush_reason END,
             on_hold           = CASE WHEN $1 = 'Paid' THEN FALSE ELSE on_hold END,
             hold_at           = CASE WHEN $1 = 'Paid' THEN NULL  ELSE hold_at END,
             hold_by           = CASE WHEN $1 = 'Paid' THEN NULL  ELSE hold_by END,
             hold_reason       = CASE WHEN $1 = 'Paid' THEN NULL  ELSE hold_reason END
       WHERE (id = $8 OR parent_id = $8)
         AND id != $9
         AND (deleted = false OR deleted IS NULL)
         AND (voided = false OR voided IS NULL)
    `, [target.payment_status, target.payment_date, target.paid_by,
        target.payment_method, target.payment_ref, target.paid_marked_at,
        target.fx_rate_to_usd,
        rootId, target.id]);
  }
  return { hasFamily, rootId };
}

// Recompute derived payment_status for a family from its installment rows
// and cascade the result + last-installment summary fields across every row
// in the family. Mirrors the existing PUT /payments/:id cascade behavior so
// the Ledger / Approvals / Recoupments views stay consistent.
//
// Status rules:
//   • 0 installments         → revert to 'Unpaid', clear payment_date / paid_marked_at
//   • 0 < SUM < family_total → 'Partial'
//   • SUM ≥ family_total     → 'Paid' (within 1¢ tolerance for FP noise)
async function recomputeFamilyPaymentStatus(rootId, client = pool) {
  const { rows: famRows } = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS total
       FROM expenses
      WHERE (id = $1 OR parent_id = $1)
        AND (deleted = false OR deleted IS NULL)`,
    [rootId]
  );
  const familyTotal = Number(famRows[0]?.total ?? 0);

  const { rows: payRows } = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS paid,
            COUNT(*)::int AS n,
            MAX(payment_date) AS last_date
       FROM expense_payments WHERE expense_id = $1`,
    [rootId]
  );
  const paid = Number(payRows[0]?.paid ?? 0);
  const n = Number(payRows[0]?.n ?? 0);
  const lastDate = payRows[0]?.last_date || null;

  if (n === 0) {
    // No installments — drop back to Unpaid. The single-proof legacy path can
    // still flip a row to Paid via PUT /payments/:id or the proof uploader.
    // Also clear fx_rate_to_usd so reverting to Unpaid drops the lock;
    // re-stamping happens the next time the family becomes Paid.
    await client.query(
      `UPDATE expenses
          SET payment_status = 'Unpaid',
              payment_date   = NULL,
              paid_marked_at = NULL,
              fx_rate_to_usd = NULL
        WHERE (id = $1 OR parent_id = $1)
          AND (deleted = false OR deleted IS NULL)`,
      [rootId]
    );
    return { paid: 0, status: 'Unpaid', count: 0, familyTotal };
  }

  const fullyPaid = paid + 0.005 >= familyTotal;
  const status = fullyPaid ? 'Paid' : 'Partial';
  await client.query(
    `UPDATE expenses
        SET payment_status = $1,
            payment_date   = COALESCE($2, payment_date),
            paid_marked_at = CASE
              WHEN $1 = 'Paid' AND payment_status IS DISTINCT FROM 'Paid' THEN NOW()
              WHEN $1 = 'Paid' THEN COALESCE(paid_marked_at, NOW())
              ELSE NULL
            END,
            -- Drop the locked rate whenever the family slips out of 'Paid'
            -- (e.g. a payment was deleted, leaving Partial). The fresh
            -- stamp below re-locks once the family is back at Paid.
            fx_rate_to_usd = CASE WHEN $1 = 'Paid' THEN fx_rate_to_usd ELSE NULL END,
            -- Auto-clear rush + hold state once the family is fully
            -- paid via installments. Partial state leaves both in place
            -- — the invoice still has outstanding balance worth flagging.
            rush_requested    = CASE WHEN $1 = 'Paid' THEN FALSE ELSE rush_requested END,
            rush_requested_at = CASE WHEN $1 = 'Paid' THEN NULL  ELSE rush_requested_at END,
            rush_requested_by = CASE WHEN $1 = 'Paid' THEN NULL  ELSE rush_requested_by END,
            rush_reason       = CASE WHEN $1 = 'Paid' THEN NULL  ELSE rush_reason END,
            on_hold           = CASE WHEN $1 = 'Paid' THEN FALSE ELSE on_hold END,
            hold_at           = CASE WHEN $1 = 'Paid' THEN NULL  ELSE hold_at END,
            hold_by           = CASE WHEN $1 = 'Paid' THEN NULL  ELSE hold_by END,
            hold_reason       = CASE WHEN $1 = 'Paid' THEN NULL  ELSE hold_reason END
      WHERE (id = $3 OR parent_id = $3)
        AND (deleted = false OR deleted IS NULL)`,
    [status, lastDate, rootId]
  );

  // Stamp the FX rate on every now-Paid row in the family. Fire-and-forget
  // so the cascade returns immediately; the stamp runs in the background
  // (idempotent — only writes rows with NULL fx_rate_to_usd, only when
  // payment_status='Paid').
  if (status === 'Paid') {
    const { rows: famIds } = await client.query(
      `SELECT id FROM expenses WHERE id = $1 OR parent_id = $1`,
      [rootId]
    ).catch(() => ({ rows: [] }));
    const { stampFxRateAsync } = require('../services/fxStamp');
    for (const r of famIds) stampFxRateAsync(r.id);
  }

  return { paid, status, count: n, familyTotal };
}

// Snippet used in list-endpoint SELECTs to expose installment summary fields
// per row. Reads from the family root in every case so children of a split
// show the same numbers as their parent.
const INSTALLMENT_SUMMARY_SELECT = `
  COALESCE((SELECT SUM(amount) FROM expense_payments
             WHERE expense_id = COALESCE(e.parent_id, e.id)), 0)::float AS installments_total,
  COALESCE((SELECT COUNT(*)   FROM expense_payments
             WHERE expense_id = COALESCE(e.parent_id, e.id)), 0)::int   AS installment_count,
  (
    SELECT COALESCE(SUM(amount), 0)::float
      FROM expenses x
     WHERE (x.id = COALESCE(e.parent_id, e.id) OR x.parent_id = COALESCE(e.parent_id, e.id))
       AND (x.deleted = false OR x.deleted IS NULL)
  ) AS family_amount
`;

// ── Ledger / Entries ──────────────────────────────────────────────────────────

// ── Shared CTEs: the vendor alias graph and the CC address book ──────────────
//
// Extracted because TWO pages need them now — the Ledger's /bk/entries and the
// Payment Dashboard's /bk/payments — and a second copy is a second answer to
// "which addresses belong to this vendor". VENDOR_CC_CTE reads alias_pairs, so
// any query using it must include BOTH, in that order.
//
// Copied verbatim out of the ledger query; that query interpolates these now,
// so the two cannot drift.
const ALIAS_PAIRS_CTE = `      alias_pairs AS (
        SELECT LOWER(TRIM(va.primary_name)) AS a, LOWER(TRIM(va.alias)) AS b FROM vendor_aliases va
        UNION
        SELECT LOWER(TRIM(va.alias)) AS a, LOWER(TRIM(va.primary_name)) AS b FROM vendor_aliases va
      )`;

const VENDOR_CC_CTE = `      -- The extra addresses a vendor typed on the submit form (step 1's "CC").
      --
      -- The one thing that form collects which lives nowhere on the entry:
      -- vendor_emails is keyed by vendor NAME, so it is the vendor's property
      -- rather than the invoice's, and the ledger could not show it at all.
      -- Sampled on production 2026-09-01: 2 of 20 vendor-submitted payees have
      -- one, so the column is sparse and real, not decorative.
      --
      -- Alias-aware through the same alias_pairs the W9 lookup uses: an address
      -- is saved under the CANONICAL name (see POST /vendors/emails), so an
      -- invoice filed under an alias would otherwise show none.
      -- (No backticks in here: this is inside a JS template literal.)
      vendor_cc AS (
        SELECT k.payee_key, STRING_AGG(DISTINCT ve.email, ', ' ORDER BY ve.email) AS emails
          FROM (
            SELECT LOWER(TRIM(ve.vendor_name)) AS payee_key, LOWER(TRIM(ve.vendor_name)) AS name_key
              FROM vendor_emails ve
            UNION
            SELECT ap.a AS payee_key, ap.b AS name_key FROM alias_pairs ap
          ) k
          JOIN vendor_emails ve ON LOWER(TRIM(ve.vendor_name)) = k.name_key
         GROUP BY k.payee_key
      )`;

// GET /api/bk/entries
router.get('/entries', async (req, res) => {
  try {
    const {
      status = 'approved', from, to, category, artist, song, payee,
      payment_status, search, deleted = 'false',
    } = req.query;
    // Voided rows are excluded by default so every page that pulls this
    // endpoint (Recoupments, etc.) inherits the "voided doesn't leak
    // outside the ledger" rule. The ledger opts back in explicitly with
    // ?include_voided=true so voided rows still render there with the
    // dimmed strikethrough treatment.
    const includeVoided = req.query.include_voided === 'true';

    // The deleted-rows listing is the Archive page's feed — deleted
    // financial history is admin-only (Admin / Superadmin), matching the
    // client-side gate on /bk/approvals/archive.
    if (deleted === 'true' && !['Admin', 'Superadmin'].includes(req.user?.role)) {
      return res.status(403).json({ success: false, error: 'Admin required' });
    }
    const conditions = ['(e.deleted = $1)'];
    const params = [deleted === 'true'];
    if (!includeVoided) {
      conditions.push('(e.voided = false OR e.voided IS NULL)');
    }
    // ?roots=1 — WHOLE INVOICES ONLY, for the surfaces that pick one to settle a
    // bank line.
    //
    // A split child is not an invoice you can attach: /tx/:id/attach refuses it
    // ("attach its parent instead"). The ledger search offered them anyway — 10 of
    // 35 results for one vendor — so the pool contained rows the endpoint would
    // reject, which is the invariant the rematch dead-end established: everything
    // on offer must be acceptable.
    //
    // Opt-IN, because the Ledger page legitimately lists children; over twenty
    // callers read this endpoint and none of them should change by default.
    if (req.query.roots === '1') conditions.push('e.parent_id IS NULL');

    if (status !== 'all') {
      params.push(status);
      conditions.push(`e.status = $${params.length}`);
    }
    if (from)   { params.push(from);   conditions.push(`e.invoice_date >= $${params.length}`); }
    if (to)     { params.push(to);     conditions.push(`e.invoice_date <= $${params.length}`); }
    if (category) { params.push(category); conditions.push(`e.category = $${params.length}`); }
    if (artist) { params.push(`%${artist}%`); conditions.push(`e.artist ILIKE $${params.length}`); }
    if (song)   { params.push(`%${song}%`);   conditions.push(`e.song ILIKE $${params.length}`); }
    if (payee)  { params.push(`%${payee}%`);  conditions.push(`e.payee ILIKE $${params.length}`); }
    if (payment_status) { params.push(payment_status); conditions.push(`e.payment_status = $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      conditions.push(`(e.payee ILIKE $${n} OR e.description ILIKE $${n} OR e.invoice_number ILIKE $${n} OR e.artist ILIKE $${n})`);
    }

    // Rep scoping, the same clause /bk/payments has always applied.
    //
    // Empty for Admin / Superadmin / Approver, so those three see exactly what
    // they saw before. For a User it is the difference between "the rows I am
    // the rep on" and the whole ledger — and without it here, scoping the
    // Payments dashboard bought nothing: a User granted /bk/payments could read
    // every row through this endpoint instead, which is the one that page calls.
    //
    // No User holds a bookkeeping page grant today (checked on production
    // 2026-09-01), so this changes nothing anybody currently sees. It is a door
    // shut before somebody is handed a key, not a leak being stopped.
    const repBlock = userVisibleRepsClause(req.user, params);
    if (repBlock) conditions.push(repBlock);

    // ── ?source= : which half of the ledger ──────────────────────────────────
    //
    // Two kinds of record share this table and the difference is not cosmetic.
    // Measured: 2,326 of 3,692 rows (62%, $3,640,421) were created BY booking a
    // bank debit — and every one of them has no invoice number, no file, no
    // flag, no artist, and is already approved and Paid. The ledger's controls
    // are built for invoices, so on 62% of its rows all of them are inert.
    //
    //   source=bank      → only those rows      (the Bank Ledger)
    //   source=invoices  → everything else      (the ledger proper)
    //   absent           → today's behaviour, unchanged
    //
    // OPT-IN, and that matters more than it looks: over twenty callers read this
    // endpoint — Archive, Lookup, Approvals, BkStatements, Recoupments planning,
    // the vendor pages, Bank Matching's match search. A new DEFAULT filter would
    // silently change every one of them.
    //
    // `IS DISTINCT FROM`, never `<>`: entry_source is nullable and 1,316 invoice
    // rows have it NULL, which `<> 'bank_statement'` drops.
    const source = req.query.source;
    if (source === 'bank') {
      conditions.push(`e.entry_source = 'bank_statement'`);
    } else if (source === 'invoices') {
      conditions.push(`e.entry_source IS DISTINCT FROM 'bank_statement'`);
    } else if (source !== undefined) {
      // Rejected rather than ignored. A typo'd source silently returning
      // everything is the same failure as the `limit` that was accepted and
      // ignored until someone measured it.
      return res.status(400).json({ success: false, error: "source must be 'bank' or 'invoices'" });
    }

    // ── Why this is written with CTEs ──────────────────────────────────────
    //
    // Every derived field here used to be a correlated subquery, so ten of them
    // ran once PER ROW. On 3,656 rows the ledger's own call took 14.5 seconds.
    //
    // The worst by far was w9_entry_id: for each row it scanned all of
    // `expenses` testing `w9_data != ''` — a TOAST read — against a
    // vendor_aliases UNION. That is O(n²) with blob reads inside. It is now one
    // pass that resolves the alias graph and picks the newest W9-bearing entry
    // per payee, joined on payee. Roughly 400 distinct payees instead of 3,656
    // scans, and IDENTICAL output: same ORDER BY x.id DESC, same alias
    // equivalence in both directions.
    //
    // `substr(col, 1, 1) <> ''` rather than `col != ''` for the has-file tests:
    // substr can read a single TOAST chunk instead of fetching the whole
    // multi-megabyte base64 string just to learn it is non-empty. 405 rows still
    // carry legacy blobs with no R2 key, so this is not hypothetical. The
    // IS NOT NULL guard stays first so migrated rows short-circuit for free.
    // `limit` was accepted and silently ignored — ?limit=100 returned all 3,656
    // rows in the same 14 seconds, so any caller passing it believed it worked.
    // Honour it now. Rejected rather than clamped when it isn't a positive
    // integer, because a typo'd limit quietly returning everything is the same
    // failure in a different coat.
    let limitSql = '';
    if (req.query.limit !== undefined) {
      const n = Number(req.query.limit);
      if (!Number.isInteger(n) || n < 1) {
        return res.status(400).json({ success: false, error: 'limit must be a positive integer' });
      }
      params.push(n);
      limitSql = `LIMIT $${params.length}`;
    }

    const ledgerView = req.query.view === 'ledger';
    const cols = ledgerView
      ? LEDGER_VIEW_COLS.map((c) => `e.${c}`).join(', ')
      : expenseCols('e');
    // Bank-mode extra: has anyone answered "no invoice is coming for this"?
    //
    // Scoped to source=bank rather than added to bankEvidenceCols(), which is
    // shared by the Ledger, Payments, Approvals and Invoices endpoints — a
    // column added there is a column four pages depend on, and this one is new
    // enough that its migration is still recent history. Confined here, the
    // worst case touches one page.
    //
    // bool_or over the family root's transactions, matching how bank_evidence
    // resolves a split child through COALESCE(parent_id, id).
    const bankOnlyCols = source === 'bank' ? `
        (SELECT bool_or(COALESCE(nbt.no_invoice_expected, false))
           FROM bank_transactions nbt
          WHERE nbt.matched_expense_id = COALESCE(e.parent_id, e.id)
            AND nbt.dismissed = false) AS no_invoice_expected,` : '';
    // The ledger reads none of these three, and each is its own subquery.
    const installments = ledgerView ? '' : `${INSTALLMENT_SUMMARY_SELECT},`;
    const extras = ledgerView ? '' : `
        (SELECT COUNT(*) FROM expense_comments ec WHERE ec.expense_id = e.id)::int AS comment_count,
        (SELECT u.name FROM users u WHERE u.id = e.flagged_by) AS flagged_by_name,`;

    const { rows } = await pool.query(`
      WITH scoped AS (
        SELECT e.id FROM expenses e WHERE ${conditions.join(' AND ')}
      ),
      -- One row per payee that has a W9 on file anywhere, newest first.
      w9_owners AS (
        SELECT LOWER(TRIM(x.payee)) AS payee_key, MAX(x.id) AS w9_id
          FROM expenses x
         WHERE (x.w9_r2_key IS NOT NULL
                OR (x.w9_data IS NOT NULL AND substr(x.w9_data, 1, 1) <> ''))
           AND (x.deleted = false OR x.deleted IS NULL)
           AND x.payee IS NOT NULL
         GROUP BY LOWER(TRIM(x.payee))
      ),
      -- The alias graph, both directions, so "Eddie" resolves to "Edward"'s W9
      -- and vice versa — the same equivalence the old correlated subquery
      -- expressed with its UNION.
${ALIAS_PAIRS_CTE},
      -- Best W9 per payee: its own, or any alias's. MAX(id) matches the old
      -- ORDER BY x.id DESC LIMIT 1.
      w9_by_payee AS (
        SELECT p.payee_key, MAX(p.w9_id) AS w9_entry_id FROM (
          SELECT payee_key, w9_id FROM w9_owners
          UNION ALL
          SELECT ap.a AS payee_key, w.w9_id FROM alias_pairs ap JOIN w9_owners w ON w.payee_key = ap.b
        ) p
        GROUP BY p.payee_key
      ),
      receipts AS (
        SELECT ef.entity_id AS id,
               COUNT(*)::int AS n,
               -- The supporting documents a VENDOR attached to their own
               -- submission, told apart from an admin-added reimbursement
               -- receipt by the label vendor-submit writes. Same rows, two
               -- questions: receipt_count is "how many files hang off this
               -- entry", this is "how many of them did the vendor send".
               COUNT(*) FILTER (WHERE ef.label = 'Vendor invoice attachment')::int AS vendor_n
          FROM entity_files ef
         WHERE ef.entity_type = 'expense_receipt'
           AND ef.entity_id IN (SELECT id FROM scoped)
         GROUP BY ef.entity_id
      ),
${VENDOR_CC_CTE}
      SELECT
        ${cols},
        (e.invoice_r2_key IS NOT NULL OR (e.invoice_data IS NOT NULL AND substr(e.invoice_data, 1, 1) <> '')) AS has_invoice,
        (e.w9_r2_key      IS NOT NULL OR (e.w9_data      IS NOT NULL AND substr(e.w9_data,      1, 1) <> '')) AS has_w9,
        (e.proof_r2_key   IS NOT NULL OR (e.proof_data   IS NOT NULL AND substr(e.proof_data,   1, 1) <> '')) AS has_proof,
        (e.receipt_data IS NOT NULL AND substr(e.receipt_data, 1, 1) <> '') AS has_receipt,
        COALESCE(r.n, 0) AS receipt_count,
        COALESCE(r.vendor_n, 0) AS vendor_file_count,
        vcc.emails AS vendor_cc_emails,
        ${extras}
        ${bankOnlyCols}
        ${bankEvidenceCols('e')},
        ${installments}
        -- WHAT THE INVOICE IS ACTUALLY WORTH.
        --
        -- A split invoice keeps its own SHARE in e.amount and puts the rest on
        -- child rows, so invoice #570 reads $500.00 here while the document says
        -- $2,005.00. Every surface that picks an invoice to settle a bank line
        -- was showing the share: a $2,005 payment looked like it matched nothing.
        --
        -- The matcher itself has always been right — FAMILY_SQL scores against
        -- r.amount + child_total and nothing is matched to a child (asserted: 0
        -- of 719). It was the human-facing lists that disagreed with it.
        --
        -- Same shape /bk/bulk-deals already uses for combined_amount, and the
        -- deleted/voided filters live inside the aggregate so a removed child
        -- cannot inflate the total.
        (e.amount + COALESCE(kids.child_total, 0)) AS family_total,
        COALESCE(kids.child_count, 0)::int AS split_count,
        w9.w9_entry_id
      FROM expenses e
      LEFT JOIN (
        SELECT c.parent_id,
               SUM(c.amount) AS child_total,
               COUNT(*) AS child_count
          FROM expenses c
         WHERE c.parent_id IS NOT NULL
           AND (c.deleted = false OR c.deleted IS NULL)
           AND (c.voided = false OR c.voided IS NULL)
         GROUP BY c.parent_id
      ) kids ON kids.parent_id = e.id
      LEFT JOIN receipts r ON r.id = e.id
      LEFT JOIN vendor_cc vcc ON vcc.payee_key = LOWER(TRIM(e.payee))
      LEFT JOIN w9_by_payee w9 ON w9.payee_key = LOWER(TRIM(e.payee))
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.invoice_date DESC NULLS LAST, e.id DESC
      ${limitSql}
    `, params);

    // Null-normalize the filename columns so clients can check them with a
    // single truthiness test rather than distinguishing undefined vs '' vs null.
    //
    // Only columns the query actually selected — blanket-assigning all four would
    // add three null keys back to every row of a ?view=ledger response, which is
    // precisely the per-row key overhead the view exists to avoid.
    const FILENAME_COLS = ['invoice_filename', 'w9_filename', 'proof_filename', 'receipt_filename'];
    const present = FILENAME_COLS.filter((c) => rows.length === 0 || c in rows[0]);
    const safe = rows.map((r) => {
      const out = { ...r };
      for (const c of present) out[c] = r[c] || null;
      return out;
    });

    res.json({ success: true, data: safe });
  } catch (err) {
    console.error('GET /api/bk/entries:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/entries
router.post('/entries', async (req, res) => {
  try {
    const {
      invoice_date, payee, description, category, artist: rawArtist, song,
      invoice_number, amount, currency = 'USD', payment_method,
      boom_rep, notes, cobrand = false, is_reimbursement = false,
      vendor_email, vendor_name, vendor_bank, vendor_address, artist_breakdown,
      payment_status, payment_date, payment_ref, payment_terms, scheduled_payment_date,
      // JSONB — array of { platform, handle } or a pre-stringified JSON.
      // Normalized just before the INSERT so pg gets a string either way.
      social_handles,
      // recoupable + ufr columns ARE on the table but were previously
      // dropped here. That meant the Recoupments "Add Expense" modal's
      // recoupable=true never landed — the new row defaulted to false
      // and got filtered off the page. Coerce the various shapes the
      // client might send (boolean, 'true'/'Yes'/'on' strings, 1) into
      // the canonical column values.
      recoupable, ufr,
      // Rush / Hold tokens applied at create time from the Add Invoice
      // page. Server enforces mutex — sending both fails; sending on a
      // row that's being created Paid silently drops both (the trigger
      // would clear them anyway).
      rush_requested, rush_reason, on_hold, hold_reason,
      // Origin tag — non-null when the request came from a page other
      // than the vanilla ledger/add-invoice flow. Whitelisted below so
      // a caller can't stash arbitrary strings on the column.
      entry_source,
      // The approval checklist, answered at CREATE time by Add Invoice.
      //
      // An admin's add is written `status = 'approved'` a few lines below, so it
      // never reaches the Approvals queue and, until now, was never asked any of
      // this. Measured on production 2026-08-27: 894 hand-added approved
      // invoices worth $3,091,450 carry no checklist at all — 771 of them read
      // recoupable=true and 684 read artist_campaign='Yes' purely because those
      // columns default that way and nobody was asked. Against 16 rows in the
      // whole ledger that DO carry one.
      //
      // Validated with the same validateApprovalChecklist the approve route
      // uses, and applied with the same writeApprovalChecklist, so "approved"
      // means one thing however the invoice got there.
      checklist,
    } = req.body;
    const ALLOWED_SOURCES = new Set(['recoupments', 'artist_campaigns']);
    const entrySource = ALLOWED_SOURCES.has(entry_source) ? entry_source : null;

    // ── The checklist gate, BEFORE anything is written ────────────────────
    //
    // Optional: every other caller of this route (vendor submit, Bulk Upload,
    // the Recoupments / Artist Campaigns add-expense modals, creator payments)
    // sends none and is unaffected. But a checklist that ARRIVES has to be valid
    // before the INSERT, not after — a 400 later would leave behind exactly the
    // row this exists to prevent: approved, filed, and never asked.
    let checklistCheck = null;
    if (checklist !== undefined && checklist !== null) {
      checklistCheck = validateApprovalChecklist(checklist);
      if (!checklistCheck.ok) {
        return res.status(400).json({ success: false, error: checklistCheck.error });
      }
    }
    // ── When a checklist arrives, IT is the answer ────────────────────────
    //
    // The form's own Cobrand and Recoupable boxes are what somebody typed; the
    // checklist is what they were ASKED. Where they differ the checklist wins,
    // and it has to win BEFORE the insert — the split children below are built
    // from these same values, so deciding afterwards would leave a parent that
    // is cobrand/Marketing/not-recoupable above children that are none of those.
    // That is the exact divergence the approve route's split branch guards
    // against, arriving by a different door.
    const answered = checklistCheck && checklistCheck.ok ? checklistCheck.value : null;
    const cobrandEffective = answered
      ? answered.cobrand
      : (cobrand === true || cobrand === 'true');
    // Cobrand rule: a cobrand item is Marketing spend by definition —
    // force the category regardless of what the caller sent. Mirrored in
    // PUT /entries/:id for after-the-fact cobrand flips.
    const entryCategory = cobrandEffective ? 'Marketing' : category;
    // Coerce to booleans + enforce mutex + gate on Paid.
    const rushBool = rush_requested === true || rush_requested === 'true';
    const holdBool = on_hold === true || on_hold === 'true';
    if (rushBool && holdBool) {
      return res.status(400).json({
        success: false,
        error: 'rush_requested and on_hold are mutually exclusive — send only one',
      });
    }
    const rushOnCreate = rushBool && (req.body.payment_status !== 'Paid');
    const holdOnCreate = holdBool && (req.body.payment_status !== 'Paid');
    const rushReasonTrimmed = rushOnCreate ? String(rush_reason || '').trim().slice(0, 500) : null;
    const holdReasonTrimmed = holdOnCreate ? String(hold_reason || '').trim().slice(0, 500) : null;
    const flagBy = (rushOnCreate || holdOnCreate) ? (req.user?.name || req.user?.email || null) : null;
    // Normalize the artist string against artist_normalization —
    // "Ezra feat. Kendrick" gets collapsed to "Ezra" before the row
    // lands in the ledger when an operator has registered that mapping
    // via the Multi-Artist flag on /flags. New rows stay raw when no
    // mapping is registered.
    const artist = await applyArtistNormalization(rawArtist);
    // Accept both { social_handles: [{platform, handle}, ...] } and a
    // pre-serialized JSON string. Empty / all-blank rows collapse to null
    // so an untouched socials editor doesn't stamp `[]` onto the row.
    let socialHandlesJson = null;
    if (Array.isArray(social_handles)) {
      const cleaned = normalizeSocialRows(social_handles);
      if (cleaned) socialHandlesJson = JSON.stringify(cleaned);
    } else if (typeof social_handles === 'string' && social_handles.trim()) {
      socialHandlesJson = social_handles;
    }
    // Added expenses default to recoupable. Callers that omit the field
    // (Add Invoice, Add Reimbursement, the Artist Campaigns modal) get
    // TRUE — matching the schema default the vendor-submit and batch
    // inserts already inherit — so new spend lands on the Recoupments
    // page instead of silently falling outside it. An explicit false
    // ('No', unchecked box) is still honored.
    const recoupableBool = answered ? answered.recoupable
      : (recoupable === undefined || recoupable === null
        ? true
        : (recoupable === true || recoupable === 'true' || recoupable === 'Yes'
            || recoupable === 'on' || recoupable === 1));
    const ufrText =
      ufr === 'Yes' || ufr === true || ufr === 'true' || ufr === 'on' || ufr === 1
        ? 'Yes' : 'No';
    const ufrMarkedAt = ufrText === 'Yes' ? new Date() : null;

    // Duplicate-invoice gate. Catches "INV-38468" vs "38468" / "#003" vs
    // "003" / "00003" vs "3" — same normalized number for same vendor.
    // Set `force_duplicate: true` on the body to override (used by the
    // client's "Add anyway" affordance once the user has acknowledged).
    if (invoice_number && !req.body.force_duplicate) {
      const dup = await findDuplicateInvoice({ payee, vendor_email, invoice_number });
      if (dup) {
        return res.status(409).json({
          success: false,
          error: `Invoice #${invoice_number} looks like a duplicate of an existing entry for ${dup.payee || payee}. Set force_duplicate to override.`,
          duplicate: dup,
        });
      }
    }

    // The Approvals queue is for invoices only — rows from the Add Invoice
    // page and the public vendor submit form. Internal spend rows born on
    // the Recoupments / Artist Campaigns add-expense modals (entry_source
    // set) skip the queue and land approved no matter who created them.
    // Everything else keeps the role gate: admins auto-approve, regular
    // users go to pending/approvals.
    const status = (entrySource || isAdmin(req.user)) ? 'approved' : 'pending';
    // Added expenses (Recoupments / Artist Campaigns modals) are Paid unless
    // the caller explicitly says otherwise — an omitted payment_status from
    // an older client bundle must not create Unpaid rows on those pages.
    const paidStatus = payment_status || (entrySource ? 'Paid' : 'Unpaid');
    const paidBy = paidStatus === 'Paid' ? req.user.name : null;
    const terms = payment_terms || 'Net 30';
    // Default due date = SUBMISSION date (now) + term days when the caller
    // doesn't supply one. Anchored to submission, not invoice_date, so a
    // stale invoice still gets a fresh 30-day window from when Market Street got it.
    // An explicit scheduled_payment_date passed by the caller still wins.
    const dueDate = scheduled_payment_date || computeDueDate(new Date(), terms);

    // Stamp paid_marked_at when an entry is created already-Paid (admin
     // marking as paid at insert time). The 14-day window starts from now.
    const paidMarkedAt = paidStatus === 'Paid' ? new Date() : null;
    // Bulk deal, from the Add Invoice marker. Quantity and unit are only
    // meaningful when the flag is on, so they are dropped when it is off rather
    // than left as orphan values a later toggle would resurrect.
    const isBulkDeal = answered ? answered.bulk_deal
      : (req.body.is_bulk_deal === true || req.body.is_bulk_deal === 'true');
    const bulkQtyRaw = Number(req.body.bulk_deal_quantity);
    const bulkQty = isBulkDeal && Number.isFinite(bulkQtyRaw) && bulkQtyRaw > 0
      ? Math.round(bulkQtyRaw) : null;
    const bulkUnit = isBulkDeal ? (String(req.body.bulk_deal_unit || '').trim().slice(0, 50) || null) : null;
    const { rows } = await pool.query(`
      INSERT INTO expenses
        (invoice_date, payee, description, category, artist, song,
         invoice_number, amount, currency, payment_method,
         boom_rep, notes, cobrand, is_reimbursement,
         vendor_email, vendor_name, vendor_bank, vendor_address,
         social_handles, artist_breakdown,
         payment_status, payment_date, payment_ref, paid_by, paid_marked_at, payment_terms,
         scheduled_payment_date,
         recoupable, ufr, ufr_marked_at,
         is_bulk_deal, bulk_deal_quantity, bulk_deal_unit,
         rush_requested, rush_requested_at, rush_requested_by, rush_reason,
         on_hold, hold_at, hold_by, hold_reason,
         status, approved_by, approved_at, created_by, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
              $40, $41, $42,
              $31, CASE WHEN $31 THEN NOW() ELSE NULL END, CASE WHEN $31 THEN $32 ELSE NULL END, $33,
              $34, CASE WHEN $34 THEN NOW() ELSE NULL END, CASE WHEN $34 THEN $32 ELSE NULL END, $35,
              $36, $37, $38, $39, NOW())
      RETURNING *
    `, [invoice_date || null, payee, description, entryCategory, artist, song,
        invoice_number, amount, currency, payment_method,
        boom_rep, notes, cobrandEffective, is_reimbursement,
        vendor_email, vendor_name, vendor_bank || null, vendor_address || null,
        socialHandlesJson, artist_breakdown ? JSON.stringify(artist_breakdown) : null,
        paidStatus,
        // payment_date default: when creating a row already-Paid and the
        // caller didn't supply one, stamp today (LA) so the ledger has
        // "the day the row was flipped to Paid" on file. Mirrors the
        // same fallback applied by PUT /payments/:id and PUT /entries/:id.
        payment_date || (paidStatus === 'Paid' ? todayLA() : null),
        payment_ref || null,
        paidBy, paidMarkedAt, terms,
        dueDate,
        recoupableBool, ufrText, ufrMarkedAt,
        // Rush / Hold on create. $31 = rushOnCreate bool, $32 = flagBy
        // (shared between rush + hold; each CASE picks it based on which
        // flag is TRUE), $33 = rushReason, $34 = holdOnCreate bool,
        // $35 = holdReason. Mutex is enforced above so at most one of
        // $31 / $34 is true.
        rushOnCreate, flagBy, rushReasonTrimmed,
        holdOnCreate, holdReasonTrimmed,
        status,
        status === 'approved' ? req.user.name : null,
        status === 'approved' ? new Date() : null,
        req.user.name,
        // $40-$42 — the bulk-deal marker, captured at ENTRY rather than waiting
        // for the approval checklist to ask. The person typing the invoice knows
        // whether it is a bulk deal; the approver was previously guessing.
        //
        // The checklist still ASKS (see CHECKLIST_ANSWER): both columns are
        // BOOLEAN DEFAULT FALSE, so a `false` here is indistinguishable from
        // "nobody looked", and the checklist answer remains the only record of a
        // decision. What changes is that the approver now sees what was submitted.
        isBulkDeal, bulkQty, bulkUnit]);

    const parentId = rows[0].id;

    // Auto-split: if artist_breakdown has 2+ entries, create child rows.
    // Transactional (dedicated client — pool.query('BEGIN') doesn't pin a
    // connection): the parent's amount is cut to the first slice before the
    // children exist, so a mid-flight failure would silently shrink the
    // invoice. Children inherit the same payment/recoupment state the
    // parent was created with — payment_terms was previously passed as a
    // literal null and recoupable/paid_marked_at/scheduled_payment_date
    // were omitted entirely (recoupable defaults TRUE at the schema level,
    // so slices of non-recoupable invoices leaked onto Recoupments).
    if (artist_breakdown && Array.isArray(artist_breakdown) && artist_breakdown.length > 1) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const [first, ...rest] = artist_breakdown;

        // Update parent with the first slice. CATEGORY, DESCRIPTION and RECOUPABLE
        // are per-slice now, and COALESCEd so an old caller sending only
        // {artist, song, amount} is unchanged — every field it omits keeps the
        // value the parent was created with.
        //
        // Why they had to become per-slice: a reimbursement sheet is twenty
        // different purchases (a subscription, five ride-shares, eight items for
        // one artist's event). Children used to inherit the parent's single
        // category and single description, so filing that invoice threw away
        // exactly the information that made splitting it worth doing.
        await client.query(
          `UPDATE expenses SET artist = $1, song = COALESCE($2, song), amount = $3,
             category = COALESCE($5, category), description = COALESCE($6, description),
             recoupable = COALESCE($7, recoupable), invoice_date = COALESCE($8, invoice_date)
           WHERE id = $4`,
          [first.artist, first.song || null, first.amount, parentId,
           first.category || null, first.description || null,
           typeof first.recoupable === 'boolean' ? first.recoupable : null,
           first.invoice_date || null]
        );

        for (const split of rest) {
          await client.query(`
            INSERT INTO expenses
              (invoice_date, payee, description, category, artist, song, amount,
               currency, payment_method, status, approved_by, approved_at,
               parent_id, cobrand, is_reimbursement, boom_rep, created_by,
               vendor_email, vendor_name, vendor_bank, payment_status, payment_date,
               paid_by, payment_terms, invoice_number, recoupable,
               paid_marked_at, scheduled_payment_date, artist_breakdown)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,NULL)
          `, [split.invoice_date || invoice_date || null, payee,
              split.description || description, split.category || entryCategory,
              split.artist, split.song || song, split.amount,
              currency, payment_method, status,
              status === 'approved' ? req.user.name : null,
              status === 'approved' ? new Date() : null,
              parentId, cobrandEffective, is_reimbursement, boom_rep, req.user.name,
              vendor_email, vendor_name, vendor_bank || null,
              paidStatus, payment_date || (paidStatus === 'Paid' ? todayLA() : null), paidBy,
              terms, invoice_number,
              // Per slice, falling back to the invoice's own flag. Without this a
              // sheet of twenty reimbursements puts its subscriptions and
              // ride-shares onto Recoupments: the column defaults TRUE.
              typeof split.recoupable === 'boolean' ? split.recoupable : recoupableBool,
              paidMarkedAt, dueDate]);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    // Auto-link to release by artist + song
    if (song && artist) autoLinkRelease(parentId, artist, song);

    // Stamp the origin tag on the whole split family — must run AFTER the
    // child inserts above so newly-created children pick it up. The
    // WHERE id = $2 OR parent_id = $2 clause covers both the parent and
    // every child that was just inserted.
    if (entrySource) {
      await pool.query(
        `UPDATE expenses SET entry_source = $1 WHERE id = $2 OR parent_id = $2`,
        [entrySource, parentId]
      );
      rows[0].entry_source = entrySource;
    }

    // ── The checklist, stored on the row it describes ─────────────────────
    //
    // Only when the row was created APPROVED. A pending row's checklist belongs
    // to the approver who will see it in the queue, not to the person who
    // submitted it — storing one here would let a submitter pre-answer their own
    // approval, and the deck would then show a completed checklist nobody with
    // approval authority ever filled in.
    //
    // The same writeApprovalChecklist the approve route uses, so the row's
    // cobrand / category / bulk deal / recoupable / artist_campaign end up
    // exactly where an approval would have put them.
    let checklistStored = false;
    if (answered && status === 'approved') {
      const stamped = stampChecklist(answered, req.user);
      await writeApprovalChecklist(pool, parentId, stamped);
      // Children were created a moment ago from the same answers, so they
      // already agree on cobrand, category and recoupable. `artist_campaign` is
      // the one the INSERT above does not carry — it defaults to 'Yes' at the
      // schema level, which is the very "nobody looked" the checklist exists to
      // end, so the answer is applied to the family rather than the root alone.
      await pool.query(
        `UPDATE expenses SET artist_campaign = CASE WHEN $1 THEN 'Yes' ELSE 'No' END
          WHERE parent_id = $2`, [stamped.campaign, parentId]).catch(() => {});
      rows[0].approval_checklist = stamped;
      rows[0].cobrand = stamped.cobrand;
      rows[0].recoupable = stamped.recoupable;
      rows[0].is_bulk_deal = stamped.bulk_deal;
      rows[0].artist_campaign = stamped.campaign ? 'Yes' : 'No';
      if (stamped.cobrand) rows[0].category = 'Marketing';
      checklistStored = true;
    }

    await logBkAction(req.user, 'expense_added', parentId, payee, null, null, null,
      `Added ${amount} — ${payee} (${status})${artist_breakdown?.length > 1 ? ` — split ${artist_breakdown.length} ways` : ''}`
      + (checklistStored
        ? '. Approval checklist completed on the Add Invoice review: '
          + `bulk deal ${answered.bulk_deal ? 'yes' : 'no'}, cobrand ${answered.cobrand ? 'yes' : 'no'}, `
          + `recoupable ${answered.recoupable ? 'yes' : 'no'}, campaign ${answered.campaign ? 'yes' : 'no'}`
        : ''));

    // `checklist_stored` is reported rather than assumed: a caller that sent one
    // on a row that lands PENDING has to be able to say so instead of implying
    // the invoice was reviewed.
    res.json({ success: true, data: rows[0], checklist_stored: checklistStored });
  } catch (err) {
    console.error('POST /api/bk/entries:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/entries/batch — create multiple entries with file data.
//
// Per-entry isolation: each invoice is its own try/catch so one R2 upload
// failure mid-batch doesn't kill the whole submission. If the INSERT
// succeeded but the R2 upload (or the follow-up r2_key UPDATE) failed,
// the row is DELETED so the user doesn't end up with a ledger row whose
// invoice can never be viewed. Failures are tracked + returned to the
// client so the UI can surface which files didn't make it.
router.post('/entries/batch', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    const { entries } = req.body;
    if (!entries || !Array.isArray(entries) || !entries.length) {
      return res.status(400).json({ success: false, error: 'No entries provided' });
    }

    const created = [];
    const failed  = []; // [{ payee, filename, error }]
    // label → the ids created under it, for the settlement groups below.
    const byLabel = new Map();
    for (const entry of entries) {
      const {
        invoice_date, payee, description, category, artist: rawArtist, song,
        invoice_number, amount, currency = 'USD', payment_method,
        boom_rep, notes, vendor_email, vendor_bank,
        payment_status, payment_date, payment_ref,
        invoice_data, invoice_filename,
        proof_data, proof_filename,
        // "These arrived as ONE payment" — a client-side label (A, B, C…),
        // not a group key. The ids do not exist until the INSERT below, so the
        // grouping is resolved server-side after the batch; see the block after
        // the loop. Correlating on the client would mean matching created rows
        // back to submitted ones by payee+amount, which is ambiguous exactly
        // when it matters: two invoices from one vendor.
        settlement_label,
      } = entry;

      // Match single-entry POST /entries: normalize multi-artist strings
      // against artist_normalization on the way in.
      const artist = await applyArtistNormalization(rawArtist);

      const paidStatus = payment_status || 'Unpaid';
      const paidBy = paidStatus === 'Paid' ? req.user.name : null;
      const paidMarkedAt = paidStatus === 'Paid' ? new Date() : null;
      // Submission-anchored due date (NOW + Net 30 days). Manual override
      // via entry.scheduled_payment_date still wins. See computeDueDate.
      const dueDate = entry.scheduled_payment_date || computeDueDate(new Date(), 'Net 30');

      let newId = null;
      try {
        // Per-entry duplicate guard. Same normalized-invoice-number check
        // as POST /entries. Skipped when the caller flags the entry with
        // `force_duplicate: true` (the bulk-upload UI surfaces detected
        // dups on the review screen and lets the user opt-in).
        if (invoice_number && !entry.force_duplicate) {
          const dup = await findDuplicateInvoice({ payee, vendor_email, invoice_number });
          if (dup) {
            throw new Error(`Duplicate of existing entry #${dup.id} (invoice #${dup.invoice_number}, ${dup.payee})`);
          }
        }

        // INSERT without file blobs — filenames go in, r2 keys filled after upload.
        const { rows } = await pool.query(`
          INSERT INTO expenses
            (invoice_date, payee, description, category, artist, song,
             invoice_number, amount, currency, payment_method,
             boom_rep, notes, vendor_email, vendor_bank,
             payment_status, payment_date, payment_ref, paid_by, paid_marked_at,
             payment_terms, scheduled_payment_date,
             invoice_filename, proof_filename,
             status, approved_by, approved_at, created_by, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'approved',$24,NOW(),$25,NOW())
          RETURNING id, payee, amount, artist
        `, [invoice_date || null, payee, description, category, artist, song,
            invoice_number, amount, currency, payment_method,
            boom_rep, notes, vendor_email, vendor_bank || null,
            paidStatus,
            // Same payment_date fallback as POST /entries: created
            // already-Paid + no caller-supplied date → stamp today (LA).
            payment_date || (paidStatus === 'Paid' ? todayLA() : null),
            payment_ref || null, paidBy, paidMarkedAt,
            'Net 30', dueDate,
            invoice_filename || null, proof_filename || null,
            req.user.name, req.user.name]);

        newId = rows[0].id;

        // Decode base64 from the request body, upload to R2, persist the key.
        const ts = Date.now();
        const safe = (n) => n.replace(/[^a-zA-Z0-9.-]/g, '_');
        let invoiceR2Key = null, proofR2Key = null;
        if (invoice_data) {
          const buf = Buffer.from(invoice_data, 'base64');
          const mime = sniffMime(buf) || 'application/octet-stream';
          invoiceR2Key = `vendors/${newId}/invoice/${ts}_${safe(invoice_filename || 'invoice.pdf')}`;
          await uploadFile(invoiceR2Key, buf, mime);
        }
        if (proof_data) {
          const buf = Buffer.from(proof_data, 'base64');
          const mime = sniffMime(buf) || 'application/octet-stream';
          proofR2Key = `vendors/${newId}/proof/${ts}_${safe(proof_filename || 'proof.pdf')}`;
          await uploadFile(proofR2Key, buf, mime);
        }
        if (invoiceR2Key || proofR2Key) {
          await pool.query(
            `UPDATE expenses SET invoice_r2_key = COALESCE($1, invoice_r2_key),
                                 proof_r2_key   = COALESCE($2, proof_r2_key)
               WHERE id = $3`,
            [invoiceR2Key, proofR2Key, newId]
          );
        }

        // Sanity check: client said it sent a file, but neither the R2 path
        // ran nor we have a key. Surface this loudly — it's the failure
        // mode that produces "ledger row exists but no viewable invoice".
        if (invoice_data && !invoiceR2Key) {
          console.error(`[batch] entry ${newId} had invoice_data but no R2 key was set — file lost.`);
        }

        // Auto-link to release
        if (song && artist) autoLinkRelease(newId, artist, song);

        await logBkAction(req.user, 'expense_added', newId, payee, null, null, null,
          `Batch: ${amount} — ${payee}`);

        created.push(rows[0]);
        if (String(settlement_label || '').trim()) {
          const key = String(settlement_label).trim();
          if (!byLabel.has(key)) byLabel.set(key, []);
          byLabel.get(key).push(newId);
        }
        console.log(`[batch] entry ${newId} saved (payee=${payee}, invoice_r2_key=${invoiceR2Key ? 'set' : 'none'}, proof_r2_key=${proofR2Key ? 'set' : 'none'})`);
      } catch (entryErr) {
        // Roll back this entry's INSERT so the user doesn't end up with a
        // ledger row whose invoice file never made it.
        if (newId) {
          await pool.query(`DELETE FROM expenses WHERE id = $1`, [newId])
            .catch(delErr => console.error(`[batch] cleanup DELETE failed for entry ${newId}:`, delErr.message));
        }
        const msg = entryErr?.message || String(entryErr);
        console.error(`[batch] entry failed (payee=${payee}, file=${invoice_filename}):`, msg);
        failed.push({ payee, filename: invoice_filename || null, error: msg });
      }
    }

    // ── "Two invoices, one payment", declared at upload ────────────────────
    //
    // John asked for exactly this: a way to note it WHILE uploading the
    // invoices, so the statement matches itself later. Validated through the
    // same lib/settlement-groups the Ledger's "One payment" button uses, so
    // upload and after-the-fact marking cannot disagree about what a group is.
    //
    // Refusals are REPORTED, never silent. An invoice created but not grouped is
    // the failure that would otherwise read as success: the batch says "12
    // uploaded" and the payment still fails to match, with nothing saying why.
    const groups = [];
    const groupErrors = [];
    for (const [label, ids] of byLabel) {
      if (ids.length < 2) {
        groupErrors.push({ label, error: 'Only one invoice ended up in this group, so it was left ungrouped.' });
        continue;
      }
      const check = await validateGroup(pool, ids);
      if (!check.ok) { groupErrors.push({ label, error: check.error }); continue; }
      const group = newGroupKey();
      await pool.query(`UPDATE expenses SET settlement_group = $1 WHERE id = ANY($2::int[])`,
        [group, check.members]);
      for (const id of check.members) {
        await logBkAction(req.user, 'settlement_group_set', id, null, 'settlement_group', null, group,
          `Marked at upload as one payment with ${check.members.length - 1} other invoice(s)`);
      }
      groups.push({ label, group, members: check.members });
    }

    res.json({
      success: true,
      data: created,
      count: created.length,
      failed,
      failedCount: failed.length,
      groups,
      group_errors: groupErrors,
    });
  } catch (err) {
    console.error('POST /api/bk/entries/batch:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/bk/entries/:id
// Did marking this invoice Paid just duplicate a bank row already booked as a
// statement stub? 40 of the 184 known duplicate pairs ($94,275) were created this
// way — the invoice entered a median 70 days after the bank row was booked, so
// nothing on the statements side could have caught it.
//
// ADVISORY ONLY. It runs AFTER the write has succeeded and never affects it: a
// hard gate would fire on 28 of 156 unpaid invoices, and one recurring vendor
// matches 17 stub-held rows at the same amount. Anything that throws here is
// swallowed — an advisory lookup must never be able to fail a payment update.
//
// `require` is lazy and inside the function, matching the existing
// `require('./statements').aggregateBankVendors()` call in this file. statements.js
// requires no sibling routers, so there is no cycle.
async function stubDuplicateWarning(updated, body) {
  try {
    if (!updated || String(body?.payment_status || '') !== 'Paid') return undefined;
    const candidates = await require('./statements').findStubDuplicates(updated);
    if (!candidates.length) return undefined;
    return {
      count: candidates.length,
      total: candidates.reduce((s, c) => s + c.amount, 0),
      candidates: candidates.slice(0, 5),
    };
  } catch (err) {
    console.warn('[stub-duplicate check] skipped:', err.message);
    return undefined;
  }
}

router.put('/entries/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = [
      'invoice_date','payee','description','category','artist','song',
      'invoice_number','amount','currency','payment_method','payment_date',
      'in_quickbooks','qb_entry_date','uploaded_to_stem','stem_upload_date',
      'payment_status','payment_terms','scheduled_payment_date','paid_by',
      'cobrand','is_reimbursement','notes','boom_rep','vendor_email',
      'vendor_name','vendor_address','vendor_bank','recoupable','release_id',
      'is_bulk_deal','bulk_deal_quantity','bulk_deal_unit','bulk_deal_completed','payment_ref','ufr',
      // Direct editing of ufr_marked_at lets users move a UFR'd row to a
      // different monthly statement on the Recoupments page (statement
      // bucket is derived from this timestamp via the 20th-cutoff rule).
      'ufr_marked_at',
      'artist_campaign',
      'recoupment_label','social_handles',
      'is_2025_expense',
    ];

    // Auto-record paid_by when marking as Paid
    if (req.body.payment_status === 'Paid' && !req.body.paid_by) {
      req.body.paid_by = req.user.name;
    }

    // Cobrand rule: flipping an entry to cobrand forces category to
    // Marketing — cobrand spend IS marketing spend. Clearing cobrand
    // leaves the category alone. Same rule as POST /entries.
    // Track when WE injected the category (vs the user editing it) so the
    // AI-rescan trigger below can ignore it — a cobrand toggle must not
    // block the response on a multi-second Claude rescan.
    let cobrandInjectedCategory = false;
    if (req.body.cobrand === true || req.body.cobrand === 'true') {
      if (!Object.prototype.hasOwnProperty.call(req.body, 'category')) cobrandInjectedCategory = true;
      req.body.category = 'Marketing';
    }

    // social_handles is a JSONB column — the pg driver needs a string for
    // INSERT/UPDATE. Caller may send the array directly; we serialize here
    // so every entry point (vendor submit, approvals edit, etc.) gets the
    // same on-the-wire treatment. Empty arrays clear the column.
    if (Object.prototype.hasOwnProperty.call(req.body, 'social_handles')) {
      const sh = req.body.social_handles;
      if (sh == null) req.body.social_handles = null;
      else if (Array.isArray(sh)) {
        const cleaned = normalizeSocialRows(sh);
        req.body.social_handles = cleaned ? JSON.stringify(cleaned) : null;
      } else if (typeof sh === 'string') {
        req.body.social_handles = sh.trim() ? sh : null;
      }
    }

    // ── Optional compare-and-set, for undo / redo ────────────────────────────
    //
    // `expect: { field, value }` — apply only if that column still holds
    // `value`. Undo is a NEW WRITE that puts an old value back, so without this
    // an undo silently overwrites whatever somebody else changed in between.
    //
    // It goes in the UPDATE's own WHERE clause rather than being checked
    // against `oldEntry` below. The read and the write are separate statements,
    // so a check on the read is a TOCTOU race — narrow, but this is money
    // fields and the atomic form costs one AND.
    //
    // IS NOT DISTINCT FROM, never `=`: the expected value is very often NULL
    // (an empty category, no song), and `col = NULL` is NULL, so an equality
    // guard would refuse every undo back to blank.
    const expect = req.body.expect && typeof req.body.expect === 'object'
      ? req.body.expect : null;
    delete req.body.expect;
    if (expect && !allowed.includes(expect.field)) {
      return res.status(400).json({ success: false, error: `Cannot guard on ${expect.field}` });
    }

    const fields = Object.keys(req.body).filter(k => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ success: false, error: 'No valid fields to update' });

    // Fetch old values for change tracking — metadata only, skip file blobs.
    const { rows: oldRows } = await pool.query(`SELECT ${expenseCols()} FROM expenses WHERE id = $1`, [id]);
    const oldEntry = oldRows[0];

    const setClauses = fields.map((f, i) => `${f} = $${i + 2}`);
    const values     = fields.map(f => req.body[f]);

    // Stamp / clear paid_marked_at when payment_status transitions in/out of
    // 'Paid'. If the row was already Paid and stays Paid, the timestamp is
    // preserved (no Set clause appended). This ties the Payment Dashboard's
    // 14-day window to when the row was MARKED paid in our system.
    if (Object.prototype.hasOwnProperty.call(req.body, 'payment_status')) {
      const newStatus = req.body.payment_status;
      const wasPaid = oldEntry?.payment_status === 'Paid';
      if (newStatus === 'Paid' && !wasPaid) {
        setClauses.push(`paid_marked_at = NOW()`);
        // Auto-clear rush + hold flags once the row is paid. Stale
        // badges on a paid invoice both clutter the Payment Dashboard
        // and surface it incorrectly under the Rush/Hold quick-filters.
        // Matches the same clearing logic in PUT /payments/:id and the
        // clear_rush_on_paid trigger.
        setClauses.push(`rush_requested = FALSE`);
        setClauses.push(`rush_requested_at = NULL`);
        setClauses.push(`rush_requested_by = NULL`);
        setClauses.push(`rush_reason = NULL`);
        setClauses.push(`on_hold = FALSE`);
        setClauses.push(`hold_at = NULL`);
        setClauses.push(`hold_by = NULL`);
        setClauses.push(`hold_reason = NULL`);
        // Auto-stamp payment_date with today (LA) when the caller didn't
        // supply one in this update AND the row didn't already have one.
        // "The date paid should be the day the row was switched to Paid"
        // — applied across every flip path.
        const bodyHasDate = Object.prototype.hasOwnProperty.call(req.body, 'payment_date') && req.body.payment_date;
        if (!bodyHasDate && !oldEntry?.payment_date) {
          setClauses.push(`payment_date = (NOW() AT TIME ZONE 'America/Los_Angeles')::DATE`);
        }
      } else if (newStatus !== 'Paid' && wasPaid) {
        setClauses.push(`paid_marked_at = NULL`);
        // Clear the locked FX rate so the row goes back to live conversion
        // until it's marked Paid again. Without this, an admin who
        // accidentally marked a row Paid then reverted it would leave a
        // stale locked rate in place.
        setClauses.push(`fx_rate_to_usd = NULL`);
      }
    }

    // Edge case: admin corrects the currency OR payment_date on an
    // already-paid row. The previously-stamped rate is now stale (wrong
    // currency lookup, or wrong as-of date). Clear it so the
    // stampFxRateAsync call below re-fetches the rate for the new
    // currency / new date and re-locks at the corrected values.
    if (oldEntry?.payment_status === 'Paid' && oldEntry?.fx_rate_to_usd != null) {
      const ymd = (d) => {
        if (!d) return null;
        if (d instanceof Date) return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
        const s = String(d);
        return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
      };
      const newCurrency = Object.prototype.hasOwnProperty.call(req.body, 'currency')
        ? String(req.body.currency || '').toUpperCase()
        : null;
      const oldCurrency = String(oldEntry.currency || 'USD').toUpperCase();
      const currencyChanging = newCurrency != null && newCurrency !== oldCurrency;

      const dateProvided = Object.prototype.hasOwnProperty.call(req.body, 'payment_date');
      const dateChanging = dateProvided && ymd(req.body.payment_date) !== ymd(oldEntry.payment_date);

      // The Paid → not-Paid branch above may have already pushed
      // fx_rate_to_usd = NULL. Don't push it twice — duplicate SET
      // clauses break the parameterized UPDATE.
      const alreadyClearing = setClauses.some(c => c.includes('fx_rate_to_usd'));
      if (!alreadyClearing && (currencyChanging || dateChanging)) {
        setClauses.push(`fx_rate_to_usd = NULL`);
      }
    }

    // Stamp / clear ufr_marked_at when ufr transitions in/out of 'Yes'.
    // Mirrors the paid_marked_at pattern above. Preserved when staying Yes
    // so the original upload timestamp doesn't reset on unrelated edits.
    //
    // SKIPPED when the request body already includes ufr_marked_at — the
    // Recoupments page lets users move a UFR'd row to a different monthly
    // statement by overriding this timestamp explicitly. The auto-stamp
    // would otherwise duplicate the SET clause (parameterized UPDATE
    // errors) AND overwrite the user's chosen date.
    const ufrTsExplicit = Object.prototype.hasOwnProperty.call(req.body, 'ufr_marked_at');
    if (Object.prototype.hasOwnProperty.call(req.body, 'ufr') && !ufrTsExplicit) {
      const newUfr = req.body.ufr;
      const wasUfr = oldEntry?.ufr === 'Yes';
      if (newUfr === 'Yes' && !wasUfr) {
        setClauses.push(`ufr_marked_at = NOW()`);
      } else if (newUfr !== 'Yes' && wasUfr) {
        setClauses.push(`ufr_marked_at = NULL`);
      }
    }

    // RETURNING light cols, not * — the four base64 blob columns would
    // otherwise ride back on every edit response (multi-MB on legacy rows).
    const { rows } = await pool.query(
      `UPDATE expenses SET ${setClauses.join(', ')} WHERE id = $1${
        expect ? ` AND ${expect.field} IS NOT DISTINCT FROM $${values.length + 2}` : ''
      } RETURNING ${expenseCols()}`,
      expect ? [id, ...values, expect.value] : [id, ...values]
    );

    // With a guard, zero rows means the row is THERE but no longer holds what
    // the caller expected — a conflict, not a missing entry. 409 with the value
    // it actually holds, so the client can say what changed instead of retrying
    // into the same wall. `oldEntry` was read before the UPDATE, so it is the
    // current value from this request's point of view.
    if (!rows.length && expect) {
      return res.status(409).json({
        success: false,
        error: 'That row changed since this edit — nothing was written.',
        conflict: {
          field: expect.field,
          expected: expect.value,
          actual: oldEntry ? oldEntry[expect.field] : null,
        },
      });
    }
    if (!rows.length) return res.status(404).json({ success: false, error: 'Entry not found' });

    // Marking Campaign=Yes (Ledger toggle or any editor) must actually put
    // the row back on the Artist Campaigns page — clear any campaigns-page
    // dismissal ('artist_campaign' = hidden) or not-campaign segregation
    // ('artist_campaign_not_campaign') that would keep it off. The reverse
    // direction is handled by the campaigns endpoints, which write
    // artist_campaign='No' when a row is marked not-campaign.
    if (req.body.artist_campaign === 'Yes') {
      await pool.query(
        `DELETE FROM flag_dismissals
          WHERE entry_id = $1 AND flag_kind IN ('artist_campaign', 'artist_campaign_not_campaign')`,
        [id]
      ).catch(() => {});
    }

    // Split-family cascade — documented invariant: toggling payment_status /
    // payment_date / paid_by on ANY row of a split family writes the whole
    // family, exactly like PUT /payments/:id. The Ledger's payment cell PUTs
    // here, so without this a split parent went Paid while its children
    // stayed Unpaid. The copy carries the full shared payment set
    // (status/date/paid_by/method/ref/marked_at/fx + rush/hold clears).
    const PAYMENT_CASCADE_TRIGGERS = ['payment_status', 'payment_date', 'paid_by'];
    let paymentCascade = { hasFamily: false, rootId: null };
    if (PAYMENT_CASCADE_TRIGGERS.some(f => fields.includes(f))) {
      // Skip the cascade when the family's payment state is DERIVED from
      // installment rows (expense_payments) — force-copying one row's
      // state would clobber recomputeFamilyPaymentStatus's result. Same
      // guard the proof-upload paths use.
      const famRoot = rows[0].parent_id || rows[0].id;
      const { rows: inst } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM expense_payments WHERE expense_id = $1', [famRoot]
      );
      if ((inst[0]?.n ?? 0) === 0) {
        paymentCascade = await cascadePaymentFieldsToFamily(rows[0]);
      }
    }

    // ── The due date belongs to the INVOICE, not to our slices of it ────────
    //
    // A vendor gives one date for one invoice; the split into per-artist rows is
    // our own bookkeeping. Left per-row, one invoice appears twice in the
    // Payments queue — which sorts strictly by this column — at two different
    // positions, and neither is wrong. Measured on production 2026-09-01: 8 of
    // 110 split families already hold two different due dates, before this page
    // could even edit one.
    //
    // Kept OUT of cascadePaymentFieldsToFamily deliberately, though it looks
    // like it belongs there. That helper runs on every payment_status change,
    // so folding this in would copy one row's due date over its siblings' every
    // time somebody marked an invoice paid — a silent write with no user behind
    // it. This one runs only when the date itself was the edit.
    if (fields.includes('scheduled_payment_date')) {
      const dueRoot = rows[0].parent_id || rows[0].id;
      await pool.query(
        `UPDATE expenses SET scheduled_payment_date = $1
          WHERE (id = $2 OR parent_id = $2)
            AND id != $3
            AND (deleted = false OR deleted IS NULL)
            AND (voided = false OR voided IS NULL)`,
        [rows[0].scheduled_payment_date, dueRoot, rows[0].id]
      ).catch((e) => console.error('[due-date] family cascade failed:', e.message));
    }

    // Stamp the FX rate if the row is now Paid (and not yet stamped).
    // Fire-and-forget — idempotent on the helper side.
    if (rows[0].payment_status === 'Paid' && rows[0].fx_rate_to_usd == null) {
      const { stampFxRateAsync } = require('../services/fxStamp');
      stampFxRateAsync(rows[0].id);
    }
    // Family rows that just went Paid via the cascade need their own FX
    // stamps too — mirrors the sibling stamping in PUT /payments/:id.
    if (rows[0].payment_status === 'Paid' && paymentCascade.hasFamily) {
      const { stampFxRateAsync } = require('../services/fxStamp');
      const { rows: sibIds } = await pool.query(
        `SELECT id FROM expenses WHERE (id = $1 OR parent_id = $1) AND id != $2
           AND (deleted = false OR deleted IS NULL) AND (voided = false OR voided IS NULL)`,
        [paymentCascade.rootId, rows[0].id]
      ).catch(() => ({ rows: [] }));
      for (const r of sibIds) stampFxRateAsync(r.id);
    }

    // Build before/after diff for activity log
    if (oldEntry) {
      const changes = {};
      for (const f of fields) {
        const oldVal = oldEntry[f];
        const newVal = req.body[f];
        const o = oldVal == null ? '' : String(oldVal);
        const n = newVal == null ? '' : String(newVal);
        if (o !== n) changes[f] = { from: oldVal, to: newVal };
      }
      if (Object.keys(changes).length) req._activityDetail = JSON.stringify(changes);
    }

    // Auto-split when song field contains multiple songs (comma or / separated)
    // Only if this entry doesn't already have children, isn't a child itself,
    // and hasn't been manually unsplit (no_auto_split keeps commas-in-song-titles
    // from being re-split after the user explicitly fixed them).
    if (fields.includes('song') && rows[0].song && !rows[0].parent_id && !rows[0].no_auto_split) {
      const songVal = rows[0].song.trim();
      // Split on comma or slash, trim each, filter empty
      const songs = songVal.split(/[,\/]/).map(s => s.trim()).filter(Boolean);
      if (songs.length >= 2) {
        // Check if entry already has children
        const { rows: existingChildren } = await pool.query(
          'SELECT id FROM expenses WHERE parent_id = $1 AND (deleted = false OR deleted IS NULL) LIMIT 1', [id]
        );
        if (!existingChildren.length) {
          const entry = rows[0];
          const perSong = Math.round((parseFloat(entry.amount) / songs.length) * 100) / 100;
          const remainder = Math.round((parseFloat(entry.amount) - perSong * songs.length) * 100) / 100;

          // Shrink-parent + insert-children is all-or-nothing (dedicated
          // client — pool.query('BEGIN') doesn't pin a connection): a
          // mid-flight failure would otherwise leave the parent cut to one
          // slice with the other songs missing. Children inherit the
          // family-shared payment + recoupment state (recoupable defaults
          // TRUE at the schema level, so omitting it leaked slices of
          // non-recoupable invoices onto Recoupments).
          const splitClient = await pool.connect();
          try {
            await splitClient.query('BEGIN');

            // Update parent with first song
            await splitClient.query('UPDATE expenses SET song = $1, amount = $2, artist_breakdown = $3 WHERE id = $4', [
              songs[0], perSong + remainder,
              JSON.stringify(songs.map((s, i) => ({ artist: entry.artist || '', song: s, amount: i === 0 ? perSong + remainder : perSong }))),
              id
            ]);

            // Create children for remaining songs
            for (let i = 1; i < songs.length; i++) {
              await splitClient.query(`
                INSERT INTO expenses
                  (invoice_date, payee, description, category, artist, song, amount,
                   currency, payment_method, status, approved_by, approved_at,
                   parent_id, cobrand, is_reimbursement, boom_rep, created_by,
                   vendor_email, vendor_name, vendor_bank, payment_status, payment_date,
                   paid_by, payment_terms, invoice_number, recoupable,
                   paid_marked_at, scheduled_payment_date, fx_rate_to_usd, artist_campaign)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
              `, [entry.invoice_date, entry.payee, entry.description, entry.category,
                  entry.artist, songs[i], perSong,
                  entry.currency, entry.payment_method, entry.status,
                  entry.approved_by, entry.approved_at,
                  Number(id), entry.cobrand, entry.is_reimbursement, entry.boom_rep, req.user.name,
                  entry.vendor_email, entry.vendor_name, entry.vendor_bank,
                  entry.payment_status, entry.payment_date, entry.paid_by,
                  entry.payment_terms, entry.invoice_number, entry.recoupable,
                  // Children inherit the campaign flag — the column defaults
                  // to 'Yes', which silently re-campaigned splits of rows
                  // marked Campaign=No (phantom artist cards).
                  entry.paid_marked_at, entry.scheduled_payment_date, entry.fx_rate_to_usd,
                  entry.artist_campaign || 'Yes']);
            }

            await splitClient.query('COMMIT');
          } catch (err) {
            await splitClient.query('ROLLBACK').catch(() => {});
            throw err;
          } finally {
            splitClient.release();
          }

          await logBkAction(req.user, 'expense_split', Number(id), entry.payee,
            null, null, null, `Auto-split into ${songs.length} songs: ${songs.join(', ')}`);

          // Auto-link each song to its release
          for (const s of songs) {
            autoLinkRelease(Number(id), entry.artist, s);
          }
        }
      }
    }

    // Auto-link to release when song or artist changes. Awaited so the
    // response we send back already reflects the new release_id (or null),
    // which lets the client update its local state without a re-fetch.
    if (fields.includes('song') || fields.includes('artist')) {
      const newReleaseId = await autoLinkRelease(Number(id), rows[0].artist, rows[0].song);
      rows[0].release_id = newReleaseId;
    }

    await logBkAction(req.user, 'expense_updated', Number(id), rows[0].payee,
      fields.join(','), null, null, JSON.stringify(req.body));

    // Rerun AI discrepancy scans if the edit touched any field that feeds them
    // and the entry already has a scan on record (i.e. it was vendor-submitted).
    const scanTriggerFields = cobrandInjectedCategory ? fields.filter(f => f !== 'category') : fields;
    const touchedInvoiceFields = scanTriggerFields.some(f => INVOICE_SCAN_FIELDS.includes(f));
    const touchedW9Fields      = scanTriggerFields.some(f => W9_SCAN_FIELDS.includes(f));
    const hasInvoiceScan = oldEntry && oldEntry.ai_scan;
    const hasW9Scan      = oldEntry && oldEntry.w9_scan;

    const rescans = [];
    if (touchedInvoiceFields && hasInvoiceScan) rescans.push(rescanInvoice(Number(id)).then(r => ['ai_scan', r?.ok ? r.scan : null]));
    if (touchedW9Fields      && hasW9Scan)      rescans.push(rescanW9(Number(id)).then(r => ['w9_scan', r?.ok ? r.scan : null]));

    let updated = rows[0];
    if (rescans.length) {
      const results = await Promise.all(rescans);
      for (const [col, val] of results) if (val) updated = { ...updated, [col]: val };
    }

    res.json({ success: true, data: updated, duplicate_warning: await stubDuplicateWarning(updated, req.body) });
  } catch (err) {
    console.error('PUT /api/bk/entries/:id:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/entries/:id/rescan — re-run AI invoice + W9 scans on demand.
// Body (optional): { types: ['invoice','w9'] } — defaults to both.
router.post('/entries/:id/rescan', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const id = Number(req.params.id);
    const types = Array.isArray(req.body?.types) && req.body.types.length
      ? req.body.types
      : ['invoice', 'w9'];
    const out = {};
    const errors = [];
    if (types.includes('invoice')) {
      const r = await rescanInvoice(id).catch(err => { console.error('rescanInvoice failed', err); return { ok: false, reason: err.message }; });
      if (r?.ok) out.ai_scan = r.scan;
      else if (r?.reason) errors.push(`Invoice: ${r.reason}`);
    }
    if (types.includes('w9')) {
      const r = await rescanW9(id).catch(err => { console.error('rescanW9 failed', err); return { ok: false, reason: err.message }; });
      if (r?.ok) out.w9_scan = r.scan;
      else if (r?.reason) errors.push(`W9: ${r.reason}`);
    }
    if (!Object.keys(out).length && errors.length) {
      return res.status(400).json({ success: false, error: errors.join(' / ') });
    }
    res.json({ success: true, data: out, warnings: errors.length ? errors : undefined });
  } catch (err) {
    console.error('POST /api/bk/entries/:id/rescan:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/entries/:id/dismiss-scan — clear AI discrepancy warnings
// body: { type: 'invoice' | 'w9', discrepancy?: { field, form_value, document_value } }
//   discrepancy absent → null the whole scan column (dismiss all)
//   discrepancy present → remove only the matching item from the array
router.post('/entries/:id/dismiss-scan', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { type, discrepancy } = req.body;
    const column = type === 'w9' ? 'w9_scan' : type === 'invoice' ? 'ai_scan' : null;
    if (!column) return res.status(400).json({ success: false, error: 'type must be "invoice" or "w9"' });

    let rows;
    if (discrepancy) {
      // Remove the single discrepancy matching field+form_value+document_value.
      // Uses a subquery to rebuild the array without that item so unrelated
      // discrepancies and the summary/scanned_at metadata are preserved.
      ({ rows } = await pool.query(
        `UPDATE expenses
            SET ${column} = jsonb_set(
              ${column},
              '{discrepancies}',
              COALESCE(
                (SELECT jsonb_agg(d)
                 FROM jsonb_array_elements(${column}->'discrepancies') d
                 WHERE NOT (
                   d->>'field'          = $2
                   AND d->>'form_value'     = $3
                   AND d->>'document_value' = $4
                 )),
                '[]'::jsonb
              )
            )
          WHERE id = $1
          RETURNING payee, ${column} AS scan`,
        [req.params.id, discrepancy.field, discrepancy.form_value, discrepancy.document_value]
      ));
    } else {
      ({ rows } = await pool.query(
        `UPDATE expenses SET ${column} = NULL WHERE id = $1 RETURNING payee, NULL AS scan`,
        [req.params.id]
      ));
    }
    if (!rows.length) return res.status(404).json({ success: false, error: 'Entry not found' });
    await logBkAction(req.user, 'scan_dismissed', Number(req.params.id), rows[0].payee,
      discrepancy ? `${column}: ${discrepancy.field}` : column);
    res.json({ success: true, scan: rows[0].scan ?? null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/entries/:id/flag  body: { flagged: boolean, flag_reason?: string }
//
// Per-expense flag-for-review. Same shape as the artist_meta /
// song_campaign_status flag endpoints: pass flagged=true (with an
// optional reason) to raise the chip; flagged=false clears everything
// including the stored reason.
//
// Access: any authenticated caller with a bk page permission (enforced
// by the router-level requirePagePermission). This is intentionally
// looser than approve/reject/payment mutations — flagging is a
// collaborative annotation (Artist Campaigns is a shared surface where
// any User should be able to flag an out-of-scope row for someone else
// to review), and PUT /entries/:id already lets any authenticated user
// edit the flagged column directly. bk_audit_log captures every
// flag/unflag with the actor's user id.
router.post('/entries/:id/flag', async (req, res) => {
  try {
    const flagged = !!req.body?.flagged;
    const reasonRaw = req.body?.flag_reason;
    // Cap reason at 500 chars — plenty for a review note, small
    // enough to bound a bad-input paste. Trim to avoid whitespace-
    // only reasons masquerading as content.
    const reason = reasonRaw == null
      ? null
      : String(reasonRaw).slice(0, 500).trim() || null;
    const userId = req.user?.id || null;
    const { rows } = await pool.query(`
      UPDATE expenses
         SET flagged     = $1::bool,
             flagged_at  = CASE WHEN $1::bool THEN NOW() ELSE NULL END,
             flagged_by  = CASE WHEN $1::bool THEN $2::int ELSE NULL END,
             flag_reason = CASE WHEN $1::bool THEN $3::text ELSE NULL END
       WHERE id = $4
       RETURNING id, flagged, flagged_at, flagged_by, flag_reason,
                 (SELECT name FROM users WHERE id = flagged_by) AS flagged_by_name
    `, [flagged, userId, reason, Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Entry not found' });
    await logBkAction(req.user,
      flagged ? 'expense_flagged' : 'expense_unflagged',
      Number(req.params.id), null, 'flagged', null,
      reason ? reason.slice(0, 120) : String(flagged));
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /api/bk/entries/:id/flag:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/entries/:id/finish — per-item "checked" marker toggled
// from the Artist Campaigns song view. Independent of the song-level
// finished flag on song_campaign_status; an operator ticks each row
// as reviewed, and the group header rolls those up as "N of M done".
router.post('/entries/:id/finish', async (req, res) => {
  try {
    const id = Number(req.params.id);
    // Access: same as /flag — any authenticated bk-page user. This is a
    // per-row "reviewed" checkbox on Artist Campaigns; a User with a
    // different boom_rep still needs to be able to mark items done as
    // they work through a shared campaign. Audit-logged below.
    const finished = !!req.body?.finished;
    const userId = req.user?.id || null;
    const { rows } = await pool.query(`
      UPDATE expenses
         SET item_finished     = $1::bool,
             item_finished_at  = CASE WHEN $1::bool THEN NOW() ELSE NULL END,
             item_finished_by  = CASE WHEN $1::bool THEN $2::int ELSE NULL END
       WHERE id = $3
       RETURNING id, item_finished, item_finished_at, item_finished_by,
                 (SELECT name FROM users WHERE id = item_finished_by) AS item_finished_by_name
    `, [finished, userId, id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Entry not found' });
    await logBkAction(req.user,
      finished ? 'expense_item_finished' : 'expense_item_unfinished',
      id, null, 'item_finished', null, String(finished));
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /api/bk/entries/:id/finish:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/bk/entries/:id  (soft delete)
// Open to any authenticated user — same gate as the parallel PUT
// /entries/:id. Soft-delete is reversible via the matching /restore
// endpoint and the on-page 10s Undo toast, and every delete is captured
// in bk_audit_log via logBkAction below for accountability.

// ── A deleted invoice must stop explaining a bank line ───────────────────────
//
// John, 2026-08-18: "I just deleted an invoice from strega but it stayed matched
// to a bank statement item." It did — nothing in the delete path touched
// `bank_transactions`, so the row kept reading MATCHED against an invoice the
// ledger no longer had.
//
// Fixed at the SOURCE rather than in the readers on purpose: 18 queries join
// `expenses` on `matched_expense_id` and exactly ONE of them guards against a
// deleted row. Teaching the other 17 to filter means every future join is
// another chance to forget; clearing the match once means all 18 are right and
// stay right.
//
// The pairs it broke are recorded in the audit log so a restore can put them
// back. That is deliberately the audit log and not a new column: the log already
// records this deletion, restore is its only reader, and a schema change here
// would need a degrade path in every query that touched the new column while
// runMigrations (which runs AFTER app.listen) caught up.
const BANK_MATCH_FIELD = 'bank_match';
async function unlinkBankRowsForFamily(rootId) {
  // Captured in a CTE because RETURNING after the UPDATE would hand back the
  // NULL we just wrote, losing the very thing restore needs.
  const { rows: unlinked } = await pool.query(`
    WITH fam AS (SELECT id FROM expenses WHERE id = $1 OR parent_id = $1),
         hit AS (SELECT bt.id AS txn_id, bt.matched_expense_id AS exp_id,
                        bt.match_method AS method
                   FROM bank_transactions bt
                  WHERE bt.matched_expense_id IN (SELECT id FROM fam))
    UPDATE bank_transactions bt
       SET matched_expense_id = NULL, match_method = NULL, match_score = NULL,
           matched_by = NULL, matched_at = NULL
      FROM hit
     WHERE bt.id = hit.txn_id
    RETURNING hit.txn_id, hit.exp_id, hit.method`, [rootId]).catch(() => ({ rows: [] }));
  // Multi-invoice links too — a consolidated payment can name several invoices,
  // and bank-evidence.js reads them as proof a payment is covered. None of those
  // readers filter deleted either.
  const { rows: links } = await pool.query(`
    DELETE FROM bank_txn_invoice_links
     WHERE expense_id IN (SELECT id FROM expenses WHERE id = $1 OR parent_id = $1)
    RETURNING txn_id, expense_id`, [rootId]).catch(() => ({ rows: [] }));
  return {
    unlinked,
    links,
    // "txn=expense=method" per pair, links marked so restore rebuilds the right
    // kind of attachment.
    memo: [
      ...unlinked.map((r) => `${r.txn_id}=${r.exp_id}=${r.method || 'manual'}`),
      ...links.map((r) => `${r.txn_id}=${r.expense_id}=link`),
    ].join(','),
  };
}
// The inverse, read back off the audit line the delete wrote.
async function relinkBankRowsForFamily(rootId) {
  const { rows } = await pool.query(
    `SELECT old_value FROM bk_audit_log
      WHERE entry_id = $1 AND action = 'expense_deleted' AND field = $2
        AND old_value IS NOT NULL AND old_value <> ''
      ORDER BY ts DESC LIMIT 1`, [rootId, BANK_MATCH_FIELD]).catch(() => ({ rows: [] }));
  if (!rows.length) return { relinked: 0, links: 0, remembered: false };
  let relinked = 0; let links = 0;
  for (const part of String(rows[0].old_value).split(',').filter(Boolean)) {
    const [txnId, expId, method] = part.split('=');
    if (!txnId || !expId) continue;
    if (method === 'link') {
      const r = await pool.query(
        `INSERT INTO bank_txn_invoice_links (txn_id, expense_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`, [txnId, expId]).catch(() => ({ rowCount: 0 }));
      links += r.rowCount || 0;
      continue;
    }
    // NEVER overwrite a newer match. The row may have been matched to something
    // else in the meantime, and that decision outranks an undo.
    const r = await pool.query(
      `UPDATE bank_transactions
          SET matched_expense_id = $2, match_method = $3, matched_by = 'restore', matched_at = NOW()
        WHERE id = $1 AND matched_expense_id IS NULL AND matched_income_id IS NULL`,
      [txnId, expId, method || 'manual']).catch(() => ({ rowCount: 0 }));
    relinked += r.rowCount || 0;
  }
  return { relinked, links, remembered: true };
}

router.delete('/entries/:id', async (req, res) => {
  try {
    // Who may delete this row.
    //
    // There was no check at all: any account that could reach /api/bk/* could
    // soft-delete ANY expense by id, and the delete cascades to the split
    // children and unlinks the bank rows that were matched to it. The rest of
    // the router has gated on this since the visibility work — approve, reject,
    // the payment writes — and these two were simply missed.
    //
    // The gate is the same helper, so it is the same answer: a no-op for
    // Admin / Superadmin / Approver, and for a User it asks whether the row is
    // one of theirs. Refused with 403 rather than 404: pretending the entry
    // does not exist would be lying about the ledger to somebody who works here.
    if (!(await userCanActOnEntry(req.user, Number(req.params.id)))) {
      return res.status(403).json({ success: false, error: 'You do not have visibility into this entry' });
    }
    const { rows } = await pool.query(
      `UPDATE expenses SET deleted = true, deleted_by = $2, deleted_at = NOW() WHERE id = $1 RETURNING payee`,
      [req.params.id, req.user?.name || null]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Entry not found' });
    // Also soft-delete child splits
    await pool.query('UPDATE expenses SET deleted = true, deleted_by = $2, deleted_at = NOW() WHERE parent_id = $1', [req.params.id, req.user?.name || null]);
    // …and stop the bank rows claiming an invoice that no longer exists.
    const broke = await unlinkBankRowsForFamily(Number(req.params.id));
    await logBkAction(req.user, 'expense_deleted', Number(req.params.id), rows[0].payee,
      broke.memo ? BANK_MATCH_FIELD : null, broke.memo || null, null,
      broke.memo
        ? `${broke.unlinked.length} bank statement row(s) unmatched and ${broke.links.length} invoice link(s) removed, `
          + 'because a deleted invoice cannot explain a payment — restoring this entry puts them back'
        : null);
    res.json({ success: true,
      data: { bank_rows_unmatched: broke.unlinked.length, invoice_links_removed: broke.links.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/entries/:id/restore
// Pairs with the DELETE above and is the undo path for the Recoupments /
// Ledger trash-can buttons. Gated the same way, for the same reason: an undo
// that reaches further than the action it undoes is its own hole.
router.post('/entries/:id/restore', async (req, res) => {
  try {
    if (!(await userCanActOnEntry(req.user, Number(req.params.id)))) {
      return res.status(403).json({ success: false, error: 'You do not have visibility into this entry' });
    }
    const { rows } = await pool.query(
      `UPDATE expenses SET deleted = false, deleted_by = NULL, deleted_at = NULL WHERE id = $1 RETURNING payee`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Entry not found' });
    // Also restore child splits
    await pool.query('UPDATE expenses SET deleted = false, deleted_by = NULL, deleted_at = NULL WHERE parent_id = $1', [req.params.id]);
    const back = await relinkBankRowsForFamily(Number(req.params.id));
    await logBkAction(req.user, 'expense_restored', Number(req.params.id), rows[0].payee,
      null, null, null,
      back.remembered
        ? `${back.relinked} bank statement row(s) re-matched and ${back.links} invoice link(s) restored`
        : null);
    res.json({ success: true, data: { bank_rows_rematched: back.relinked, invoice_links_restored: back.links } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/entries/:id/void — mark an invoice voided. Stays on the ledger
// for audit but is excluded from the Payment Dashboard. Cascades to children
// of a split family so a voided parent doesn't leave orphan children payable.
router.post('/entries/:id/void', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows } = await pool.query(
      `UPDATE expenses SET voided = true, voided_at = NOW(), voided_by = $1
       WHERE id = $2 RETURNING payee`,
      [req.user.name, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Entry not found' });
    await pool.query(
      `UPDATE expenses SET voided = true, voided_at = NOW(), voided_by = $1
       WHERE parent_id = $2`,
      [req.user.name, req.params.id]
    );
    await logBkAction(req.user, 'expense_voided', Number(req.params.id), rows[0].payee);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/entries/:id/unvoid
router.post('/entries/:id/unvoid', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows } = await pool.query(
      `UPDATE expenses SET voided = false, voided_at = NULL, voided_by = NULL
       WHERE id = $1 RETURNING payee`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Entry not found' });
    await pool.query(
      `UPDATE expenses SET voided = false, voided_at = NULL, voided_by = NULL
       WHERE parent_id = $1`,
      [req.params.id]
    );
    await logBkAction(req.user, 'expense_unvoided', Number(req.params.id), rows[0].payee);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── File management ───────────────────────────────────────────────────────────

// POST /api/bk/entries/:id/split — split an existing entry between multiple artists
router.post('/entries/:id/split', async (req, res) => {
  try {
    // Open to any authenticated user — same gate the parallel PUT
    // /entries/:id uses for direct field edits. The Flags page (and
    // future flows) lets non-admins fix multi-name / co-artist data
    // they spot. Every split is captured in bk_audit_log via
    // logBkAction below so accountability is preserved. Unsplit
    // (DELETE /:id/splits) stays admin-only — the structurally riskier
    // operation.

    const { artist_breakdown } = req.body;
    const entryId = Number(req.params.id);

    if (!artist_breakdown || !Array.isArray(artist_breakdown) || artist_breakdown.length < 2) {
      return res.status(400).json({ success: false, error: 'At least 2 artist splits required' });
    }

    const { rows: orig } = await pool.query(`SELECT ${expenseCols()} FROM expenses WHERE id = $1`, [entryId]);
    if (!orig.length) return res.status(404).json({ success: false, error: 'Entry not found' });
    const entry = orig[0];

    // Re-splitting deletes existing children — refuse when one of them is a
    // fee/reimb child carrying a receipt (receipt_data is the ONLY copy of
    // that file; the delete below would destroy it irrecoverably).
    const { rows: receiptKids } = await pool.query(
      `SELECT id FROM expenses WHERE parent_id = $1 AND receipt_data IS NOT NULL LIMIT 1`,
      [entryId]
    );
    if (receiptKids.length) {
      return res.status(400).json({
        success: false,
        error: 'This invoice has a fee/reimbursement child with an attached receipt — re-splitting would permanently delete it. Unsplit it first.',
      });
    }

    // Delete-children → shrink-parent → insert-children is all-or-nothing:
    // a mid-flight failure would otherwise leave the parent cut to the first
    // slice with the other slices missing — money silently gone from the
    // ledger. Dedicated client because pool.query('BEGIN') doesn't pin a
    // connection.
    const client = await pool.connect();
    const childIds = [];
    try {
      await client.query('BEGIN');

      // Delete existing children if re-splitting
      await client.query('DELETE FROM expenses WHERE parent_id = $1', [entryId]);

      const [first, ...rest] = artist_breakdown;

      // Update parent with first split
      await client.query(`
        UPDATE expenses
        SET artist = $1, song = $2, amount = $3, artist_breakdown = $4
        WHERE id = $5
      `, [first.artist, first.song || entry.song, first.amount,
          JSON.stringify(artist_breakdown), entryId]);

      // Create children for the rest. Children inherit the family-shared
      // payment + recoupment state — recoupable in particular defaults TRUE
      // at the schema level, so omitting it here leaked slices of
      // non-recoupable invoices onto the Recoupments page.
      for (const split of rest) {
        const { rows: inserted } = await client.query(`
          INSERT INTO expenses
            (invoice_date, payee, description, category, artist, song, amount,
             currency, payment_method, status, approved_by, approved_at,
             parent_id, cobrand, is_reimbursement, boom_rep, created_by,
             vendor_email, vendor_name, payment_status, payment_terms,
             invoice_number, recoupable, payment_date, paid_by,
             paid_marked_at, scheduled_payment_date, fx_rate_to_usd, artist_campaign)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
          RETURNING id
        `, [entry.invoice_date, entry.payee, entry.description, entry.category,
            split.artist, split.song || entry.song, split.amount,
            entry.currency, entry.payment_method, entry.status,
            entry.approved_by, entry.approved_at,
            entryId, entry.cobrand, entry.is_reimbursement, entry.boom_rep,
            req.user.name, entry.vendor_email, entry.vendor_name,
            entry.payment_status, entry.payment_terms, entry.invoice_number,
            entry.recoupable, entry.payment_date, entry.paid_by,
            entry.paid_marked_at, entry.scheduled_payment_date, entry.fx_rate_to_usd,
            entry.artist_campaign || 'Yes']);
        childIds.push(inserted[0].id);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await logBkAction(req.user, 'expense_split', entryId, entry.payee,
      null, null, null, `Split into ${artist_breakdown.length} entries`);

    res.json({ success: true, data: { parent_id: entryId, child_ids: childIds } });
  } catch (err) {
    console.error('POST /api/bk/entries/:id/split:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/entries/:id/split-fee-reimb — carve a reimbursement portion off an
// invoice. Parent stays as the fee portion (is_reimbursement=false), one child
// row gets created for the reimbursement portion (is_reimbursement=true) with
// its own receipt attached.
router.post('/entries/:id/split-fee-reimb', upload.single('receipt_file'), async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    const entryId = Number(req.params.id);
    const fee_amount   = parseFloat(req.body.fee_amount);
    const reimb_amount = parseFloat(req.body.reimb_amount);

    if (!fee_amount || !reimb_amount || fee_amount <= 0 || reimb_amount <= 0) {
      return res.status(400).json({ success: false, error: 'Both fee and reimbursement amounts must be positive.' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Please attach a receipt for the reimbursement portion.' });
    }

    const { rows: orig } = await pool.query(`SELECT ${expenseCols()} FROM expenses WHERE id = $1 AND (deleted = false OR deleted IS NULL)`, [entryId]);
    if (!orig.length) return res.status(404).json({ success: false, error: 'Entry not found' });
    const entry = orig[0];

    if (entry.parent_id) {
      return res.status(400).json({ success: false, error: 'Split the parent invoice, not a child.' });
    }
    if (entry.is_reimbursement) {
      return res.status(400).json({ success: false, error: 'This entry is already a reimbursement.' });
    }

    const { rows: childRows } = await pool.query('SELECT id FROM expenses WHERE parent_id = $1 LIMIT 1', [entryId]);
    if (childRows.length) {
      return res.status(400).json({ success: false, error: 'Entry already has children; remove the existing split first.' });
    }

    const total = Number(entry.amount) || 0;
    if (Math.abs((fee_amount + reimb_amount) - total) > 0.01) {
      return res.status(400).json({
        success: false,
        error: `Fee + reimbursement (${fee_amount + reimb_amount}) must equal the invoice total (${total}).`,
      });
    }

    const breakdown = [
      { artist: entry.artist, song: entry.song, amount: fee_amount,   is_reimbursement: false },
      { artist: entry.artist, song: entry.song, amount: reimb_amount, is_reimbursement: true  },
    ];

    const receiptB64   = req.file.buffer.toString('base64');
    const receiptFname = req.file.originalname;

    // Dedicated client for the transaction — the previous
    // pool.query('BEGIN') didn't pin a connection, so BEGIN/COMMIT could
    // land on different pool connections and the "transaction" was
    // ineffective.
    let childId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE expenses
         SET amount = $1, artist_breakdown = $2,
             receipt_data = NULL, receipt_filename = NULL
         WHERE id = $3`,
        [fee_amount, JSON.stringify(breakdown), entryId]
      );

      const { rows: inserted } = await client.query(`
        INSERT INTO expenses
          (invoice_date, payee, description, category, artist, song, amount,
           currency, payment_method, status, approved_by, approved_at,
           parent_id, cobrand, is_reimbursement, boom_rep, created_by,
           vendor_email, vendor_name, payment_status, payment_terms,
           invoice_number, receipt_data, receipt_filename, recoupable,
           payment_date, paid_by, paid_marked_at, scheduled_payment_date, artist_campaign)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
        RETURNING id
      `, [entry.invoice_date, entry.payee, entry.description, entry.category,
          entry.artist, entry.song, reimb_amount,
          entry.currency, entry.payment_method, entry.status,
          entry.approved_by, entry.approved_at,
          entryId, entry.cobrand, true, entry.boom_rep,
          req.user.name, entry.vendor_email, entry.vendor_name,
          entry.payment_status, entry.payment_terms, entry.invoice_number,
          receiptB64, receiptFname, entry.recoupable,
          entry.payment_date, entry.paid_by, entry.paid_marked_at, entry.scheduled_payment_date,
          entry.artist_campaign || 'Yes']);
      childId = inserted[0].id;

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await logBkAction(req.user, 'expense_split_fee_reimb', entryId, entry.payee,
      null, null, null, `Carved out reimbursement: fee ${fee_amount}, reimb ${reimb_amount}`);

    res.json({ success: true, data: { parent_id: entryId, child_id: childId } });
  } catch (err) {
    console.error('POST /api/bk/entries/:id/split-fee-reimb:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/bk/entries/:id/splits — remove all splits, restore parent to full amount.
// Body (optional): { song: 'Final song name' } — overrides the parent's song
// after unsplitting (default: comma-join all child song names so the original
// title with intentional commas comes back). Always sets no_auto_split=true so
// updating the song afterwards doesn't re-trigger auto-split.
router.delete('/entries/:id/splits', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const entryId = Number(req.params.id);
    const { rows: orig } = await pool.query(`SELECT ${expenseCols()} FROM expenses WHERE id = $1`, [entryId]);
    if (!orig.length) return res.status(404).json({ success: false, error: 'Entry not found' });

    // Pull the current children (covers song-splits where artist_breakdown may
    // not be populated as well as artist-splits where it is).
    const { rows: children } = await pool.query(
      `SELECT id, song, amount FROM expenses WHERE parent_id = $1 AND (deleted = false OR deleted IS NULL)`,
      [entryId]
    );
    const breakdown = orig[0].artist_breakdown;
    const hasBreakdown = Array.isArray(breakdown) && breakdown.length >= 2;
    if (!children.length && !hasBreakdown) {
      return res.status(400).json({ success: false, error: 'Entry is not split' });
    }

    // Restore the original total by summing children + the parent's own amount,
    // falling back to the artist_breakdown if children were missing.
    const childTotal = children.reduce((s, c) => s + (Number(c.amount) || 0), 0);
    const totalAmount = children.length
      ? childTotal + (Number(orig[0].amount) || 0)
      : breakdown.reduce((s, b) => s + (Number(b.amount) || 0), 0);

    // Combined song name: parent's current song first, then each child's song,
    // deduplicated case-insensitively (artist-splits typically share a song).
    // Override with the caller-provided value when present.
    const requestedSong = typeof req.body?.song === 'string' ? req.body.song.trim() : '';
    const parentSong = (orig[0].song || '').trim();
    const childSongs = children.map(c => (c.song || '').trim()).filter(Boolean);
    const seen = new Set();
    const uniqueSongs = [parentSong, ...childSongs].filter(s => {
      if (!s) return false;
      const key = s.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const combinedSong = requestedSong || uniqueSongs.join(', ') || parentSong;

    // A fee/reimb child's receipt_data is the ONLY copy of that receipt
    // (receipts were never migrated to R2), and split-fee-reimb cleared the
    // parent's receipt fields when it carved the child off. Pull the
    // receipt back onto the parent before the children are deleted —
    // otherwise unsplit (the exact escape hatch the /split receipt guard
    // points users to) would destroy it.
    const { rows: receiptKid } = await pool.query(
      `SELECT receipt_data, receipt_filename FROM expenses
        WHERE parent_id = $1 AND receipt_data IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
      [entryId]
    );

    // Delete + restore is all-or-nothing (dedicated client — pool.query
    // BEGIN doesn't pin a connection): a failure between the two would
    // otherwise leave the children gone with the parent still at its
    // sliced amount.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM expenses WHERE parent_id = $1', [entryId]);
      await client.query(`
        UPDATE expenses
        SET artist_breakdown = NULL, amount = $1, song = $2, no_auto_split = TRUE,
            receipt_data     = COALESCE(receipt_data, $4),
            receipt_filename = COALESCE(receipt_filename, $5)
        WHERE id = $3
      `, [totalAmount, combinedSong, entryId,
          receiptKid[0]?.receipt_data || null, receiptKid[0]?.receipt_filename || null]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await logBkAction(req.user, 'expense_unsplit', entryId, orig[0].payee,
      'song', null, combinedSong,
      `Unsplit ${children.length || (breakdown && breakdown.length) || 0} rows; restored amount to ${totalAmount}`);

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/bk/entries/:id/splits:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const FILE_TYPES = { invoice: ['invoice_data','invoice_filename'],
                     w9:      ['w9_data','w9_filename'],
                     proof:   ['proof_data','proof_filename'],
                     receipt: ['receipt_data','receipt_filename'] };

// R2-migrated types — file lives in Cloudflare R2, DB stores only the key.
// receipt is not yet migrated; it still falls through to the legacy blob path.
const FILE_R2_COLUMNS = { invoice: 'invoice_r2_key', w9: 'w9_r2_key', proof: 'proof_r2_key' };

// ── Per-expense comment threads ──────────────────────────────────────────────
// Row-level discussions on the Artist Campaigns page (same idea as
// release_comments on the release detail page). Open to any user who can
// reach /api/bk — the thread is the point of collaboration.

// GET /api/bk/comments?ids=1,2,3 — bulk thread fetch so list pages can
// render comments inline without an N+1 (Planning shows them as row
// strips like the flag notes).
router.get('/comments', async (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',').map(Number).filter(Number.isFinite).slice(0, 500);
    if (!ids.length) return res.json({ success: true, data: [] });
    const { rows } = await pool.query(`
      SELECT c.id, c.expense_id, c.user_id, c.comment, c.created_at,
             COALESCE(u.name, 'Former user') AS user_name
        FROM expense_comments c
        LEFT JOIN users u ON u.id = c.user_id
       WHERE c.expense_id = ANY($1::int[])
       ORDER BY c.created_at ASC, c.id ASC
    `, [ids]);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/entries/:id/comments
router.get('/entries/:id/comments', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.expense_id, c.user_id, c.comment, c.created_at,
             COALESCE(u.name, 'Former user') AS user_name
        FROM expense_comments c
        LEFT JOIN users u ON u.id = c.user_id
       WHERE c.expense_id = $1
       ORDER BY c.created_at ASC, c.id ASC
    `, [Number(req.params.id)]);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/entries/:id/comments  body: { comment }
router.post('/entries/:id/comments', async (req, res) => {
  try {
    const text = String(req.body?.comment || '').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ success: false, error: 'Comment is required' });
    const entryId = Number(req.params.id);
    const { rows: exists } = await pool.query(
      `SELECT payee FROM expenses WHERE id = $1 AND (deleted = false OR deleted IS NULL)`, [entryId]
    );
    if (!exists.length) return res.status(404).json({ success: false, error: 'Entry not found' });
    const { rows } = await pool.query(`
      INSERT INTO expense_comments (expense_id, user_id, comment)
      VALUES ($1, $2, $3)
      RETURNING id, expense_id, user_id, comment, created_at
    `, [entryId, req.user?.id || null, text]);
    await logBkAction(req.user, 'expense_comment_added', entryId, exists[0].payee,
      null, null, null, text.slice(0, 120));
    res.json({ success: true, data: { ...rows[0], user_name: req.user?.name || 'Unknown' } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/bk/entries/comments/:commentId — own comment, or any as admin
router.delete('/entries/comments/:commentId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT user_id, expense_id FROM expense_comments WHERE id = $1`, [Number(req.params.commentId)]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Comment not found' });
    if (rows[0].user_id !== req.user?.id && !isAdmin(req.user)) {
      return res.status(403).json({ success: false, error: 'You can only delete your own comments' });
    }
    await pool.query(`DELETE FROM expense_comments WHERE id = $1`, [Number(req.params.commentId)]);
    await logBkAction(req.user, 'expense_comment_deleted', rows[0].expense_id, null);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/entries/:id/audit — audit trail for a specific expense
router.get('/entries/:id/audit', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM bk_audit_log WHERE entry_id = $1 ORDER BY ts DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/entries/:id/file-info/:type — diagnostic: reports what's
// actually stored for a row's file (source, byte length, first-bytes hex/
// text, magic-byte checks, filename). Inspects both R2 (via *_r2_key) and
// the legacy base64 column, plus the parent row for invoice-type.
// Admin only. Open in a browser while logged in:
//   /api/bk/entries/<id>/file-info/invoice?token=<jwt>
router.get('/entries/:id/file-info/:type', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const type = req.params.type;
    if (!FILE_TYPES[type]) return res.status(400).json({ success: false, error: 'Invalid file type' });
    const [dataCol, nameCol] = FILE_TYPES[type];
    const keyCol = FILE_R2_COLUMNS[type]; // null for receipt

    const cols = keyCol
      ? `e.${dataCol} AS self_data, e.${keyCol} AS self_r2_key, e.${nameCol} AS self_name,
         p.${dataCol} AS parent_data, p.${keyCol} AS parent_r2_key, p.${nameCol} AS parent_name`
      : `e.${dataCol} AS self_data, e.${nameCol} AS self_name,
         p.${dataCol} AS parent_data, p.${nameCol} AS parent_name`;

    const { rows } = await pool.query(
      `SELECT e.id, e.parent_id, e.payee, ${cols}
         FROM expenses e
         LEFT JOIN expenses p ON p.id = e.parent_id
        WHERE e.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Entry not found' });
    const r = rows[0];

    const describeBuf = (buf) => {
      const head = buf.slice(0, 32);
      const textHead = Array.from(buf.slice(0, 64)).map(c => (c >= 0x20 && c < 0x7F) ? String.fromCharCode(c) : '.').join('');
      return {
        bytes: buf.length,
        first32_hex: head.toString('hex'),
        first64_text: textHead,
        sniffed_mime: sniffMime(buf),
      };
    };

    const describeSource = async (r2Key, b64, name) => {
      if (r2Key) {
        try {
          const { buffer, contentType } = await downloadFile(r2Key);
          return { present: true, source: 'r2', r2_key: r2Key, name, r2_content_type: contentType, ...describeBuf(buffer) };
        } catch (err) {
          return { present: true, source: 'r2', r2_key: r2Key, name, error: err.message };
        }
      }
      if (b64) {
        const buf = Buffer.from(b64, 'base64');
        return { present: true, source: 'legacy_blob', name, base64_length: b64.length, ...describeBuf(buf) };
      }
      return { present: false };
    };

    res.json({
      success: true,
      data: {
        entry: { id: r.id, payee: r.payee, parent_id: r.parent_id },
        self: await describeSource(r.self_r2_key || null, r.self_data, r.self_name),
        parent: await describeSource(r.parent_r2_key || null, r.parent_data, r.parent_name),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/entries/:id/file/:type
//
// Serves the bytes directly from the Node server — R2 fetches are proxied
// through here rather than 302-redirecting, so the browser only talks to our
// origin and the R2 bucket doesn't need a CORS policy for the dashboard.
//
// During the migration window, any one row can be in either state:
//   - new rows: invoice_r2_key populated, invoice_data NULL
//   - pre-migration rows: invoice_data populated, invoice_r2_key NULL
// R2 wins if present; otherwise we fall back to the legacy base64 column.
router.get('/entries/:id/file/:type', async (req, res) => {
  try {
    const type = req.params.type;
    if (!FILE_TYPES[type]) return res.status(400).json({ success: false, error: 'Invalid file type' });

    const [dataCol, nameCol] = FILE_TYPES[type];
    const keyCol = FILE_R2_COLUMNS[type]; // null for receipt

    // Split-child rows carry invoice_data / invoice_r2_key = NULL — the PDF
    // lives on the parent. Coalesce both for invoice; w9/proof are per-row.
    const selectCols = keyCol
      ? (type === 'invoice'
          ? `COALESCE(e.${keyCol}, p.${keyCol}) AS r2_key,
             COALESCE(e.${dataCol}, p.${dataCol}) AS blob,
             COALESCE(e.${nameCol}, p.${nameCol}) AS name`
          : `e.${keyCol} AS r2_key, e.${dataCol} AS blob, e.${nameCol} AS name`)
      : `e.${dataCol} AS blob, e.${nameCol} AS name`;

    const { rows } = type === 'invoice'
      ? await pool.query(
          `SELECT ${selectCols} FROM expenses e
             LEFT JOIN expenses p ON p.id = e.parent_id
            WHERE e.id = $1`,
          [req.params.id]
        )
      : await pool.query(
          `SELECT ${selectCols} FROM expenses e WHERE e.id = $1`,
          [req.params.id]
        );
    if (!rows.length) return res.status(404).json({ success: false, error: 'File not found' });

    const row = rows[0];
    let buf, name;

    if (row.r2_key) {
      const { buffer } = await downloadFile(row.r2_key);
      buf = buffer;
      name = row.name || `${type}.pdf`;
    } else if (row.blob) {
      buf = Buffer.from(row.blob, 'base64');
      name = row.name || `${type}.pdf`;
    } else {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    // Source of truth is the actual content, not the filename — scanner
    // software sometimes saves JPEGs as .pdf, which caused "Failed to load
    // PDF document" in the preview iframe.
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
    const EXT_MIME = {
      pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
    };
    const mime = sniffMime(buf) || EXT_MIME[ext] || 'application/octet-stream';

    // If the filename extension doesn't match the actual content, rewrite it
    // so browsers/download dialogs don't mislabel the file on save.
    const MIME_EXT = {
      'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg',
      'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
    };
    const correctExt = MIME_EXT[mime];
    const finalName = (correctExt && ext !== correctExt)
      ? name.replace(/\.[a-z0-9]+$/i, '') + '.' + correctExt
      : name;

    // Content-Disposition only allows ASCII in the plain filename= param.
    // For non-ASCII (accents, curly quotes, em dashes, etc.) include the
    // RFC 5987 filename*=UTF-8'' form so the real name survives downloads.
    const asciiName = finalName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    const disposition = /[^\x20-\x7E]/.test(finalName)
      ? `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(finalName)}`
      : `inline; filename="${asciiName}"`;

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', disposition);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/entries/:id/file/:type
router.post('/entries/:id/file/:type', upload.single('file'), async (req, res) => {
  try {
    const type = req.params.type;
    if (!FILE_TYPES[type]) return res.status(400).json({ success: false, error: 'Invalid file type' });
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    const id = req.params.id;
    const filename = req.file.originalname;
    const buffer = req.file.buffer;
    const nameCol = FILE_TYPES[type][1];

    if (FILE_R2_COLUMNS[type]) {
      // R2 path: invoice / w9 / proof
      const ts = Date.now();
      const safe = (n) => n.replace(/[^a-zA-Z0-9.-]/g, '_');
      const mime = sniffMime(buffer) || req.file.mimetype || 'application/octet-stream';
      const key = `vendors/${id}/${type}/${ts}_${safe(filename)}`;
      await uploadFile(key, buffer, mime);
      await pool.query(
        `UPDATE expenses SET ${FILE_R2_COLUMNS[type]} = $1, ${nameCol} = $2 WHERE id = $3`,
        [key, filename, id]
      );
    } else {
      // Legacy path (receipt still lives in the DB as base64)
      const dataCol = FILE_TYPES[type][0];
      await pool.query(
        `UPDATE expenses SET ${dataCol} = $1, ${nameCol} = $2 WHERE id = $3`,
        [buffer.toString('base64'), filename, id]
      );
    }

    // A W-9 arriving here read NOTHING before: only proof and invoice uploads
    // triggered a scan, so an admin attaching a late W-9 — the ordinary way a
    // chased form arrives — left the vendor unfilable until somebody re-ran the
    // backfill. Background and best-effort: the upload has already succeeded
    // and the file is safely in R2, so a failed read is a log line, not a 500.
    if (type === 'w9' && process.env.ANTHROPIC_API_KEY) {
      readAndStoreW9Tax({
        entryId: Number(id), base64: buffer.toString('base64'), filename,
        userName: req.user?.name || 'upload', audit: logBkAction,
      }).then((r) => console.log(`[w9-tax] entry ${id} upload: ${r.stored ? 'stored' : 'not stored'}`
        + ` — ${r.tax_classification || 'no line 3'}, ${r.tin_last4 ? `TIN ••${r.tin_last4}` : 'no TIN'}`
        + (r.reason ? ` (${r.reason})` : '')))
        .catch((err) => console.error(`[w9-tax] entry ${id} upload:`, err.message));
    }

    // Proof of payment is the trigger that marks an invoice Paid. Do this
    // synchronously so the Payment Dashboard never gets stuck on Unpaid (and
    // the send-confirmation button shows up) — even if the background AI
    // scan can't run (no ANTHROPIC_API_KEY, network failure, etc.).
    //
    // Skip when the expense has installment rows: payment_status is derived
    // from those, and a partially-paid invoice shouldn't jump to Paid just
    // because one transaction's proof was attached on the parent.
    if (type === 'proof') {
      const root = await resolveFamilyRoot(id);
      const proofRootId = root?.rootId ?? Number(id);
      const { rows: ip } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM expense_payments WHERE expense_id = $1', [proofRootId]
      );
      if ((ip[0]?.n ?? 0) === 0) {
        // Family-wide: a proof document covers the whole invoice, so every
        // row of a split family flips together — same invariant as the
        // PUT /payments/:id cascade. Per-row COALESCEs keep any values a
        // row already had; the payment_status guard makes this idempotent.
        await pool.query(
          `UPDATE expenses
              SET payment_status = 'Paid',
                  paid_by        = COALESCE(NULLIF(paid_by, ''), $1),
                  paid_marked_at = COALESCE(paid_marked_at, NOW()),
                  -- Stamp today (LA) as the payment_date fallback when the
                  -- row didn't already have one. If the background AI scan
                  -- below extracts a real date from the proof, it'll
                  -- override this auto-today value (see scanProofInBackground).
                  payment_date   = COALESCE(payment_date, (NOW() AT TIME ZONE 'America/Los_Angeles')::DATE),
                  -- Auto-clear rush + hold state on paid. Matches the
                  -- same logic in PUT /payments/:id and PUT /entries/:id.
                  rush_requested    = FALSE,
                  rush_requested_at = NULL,
                  rush_requested_by = NULL,
                  rush_reason       = NULL,
                  on_hold           = FALSE,
                  hold_at           = NULL,
                  hold_by           = NULL,
                  hold_reason       = NULL
            WHERE (id = $2 OR parent_id = $2)
              AND payment_status IS DISTINCT FROM 'Paid'
              AND (deleted = false OR deleted IS NULL)
              AND (voided = false OR voided IS NULL)`,
          [req.user?.name || null, proofRootId]
        );
      }
    }

    const { rows } = await pool.query('SELECT payee, payment_status, payment_date, payment_ref FROM expenses WHERE id = $1', [id]);
    await logBkAction(req.user, `${type}_uploaded`, Number(id),
      rows[0]?.payee, null, null, null, filename);

    res.json({ success: true });

    // When proof of payment is uploaded, auto-scan with AI in the background
    // to extract payment date, reference number, and mark as paid. Base64 is
    // computed from the live multer buffer — no R2 round-trip.
    if (type === 'proof' && process.env.ANTHROPIC_API_KEY) {
      const entry = rows[0];
      scanProofInBackground(id, buffer.toString('base64'), filename, entry, req.user.name).catch(err => {
        console.error('Background proof scan failed for entry', id, err.message);
      });
    }

    // Invoice uploaded outside the vendor-submit flow (Add Invoice page, ledger
    // replace, bulk re-upload) still gets the discrepancy scan so the Approvals
    // page surfaces mismatches no matter how the file arrived. Background; the
    // row already carries the form data rescanInvoice compares against.
    if (type === 'invoice' && process.env.ANTHROPIC_API_KEY) {
      rescanInvoice(Number(id)).catch(err => {
        console.error('Background invoice scan failed for entry', id, err.message);
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Background AI scan for proof of payment — extracts date, ref, method
async function scanProofInBackground(entryId, b64, filename, entry, userName) {
  const prompt = `You are extracting payment information from a proof of payment document (bank statement, receipt, transfer confirmation, check image, etc.). Analyze this document and return ONLY valid JSON:
{
  "payment_date": "YYYY-MM-DD or null — the date the payment was made/processed",
  "payment_method": one of ${JSON.stringify(PAYMENT_METHODS)} or null,
  "reference_number": "transaction/confirmation/check number or null"
}
Look for: transaction date, payment date, processed date, check date, transfer date. Prefer the actual payment/transaction date over statement dates. Return only JSON.`;

  const result = await callClaude({
    prompt,
    base64: b64,
    filename,
    maxTokens: 512,
    parseJson: true,
  });
  if (!result.ok) return;
  const parsed = result.data;

  // Family scope — the proof document covers the whole invoice, so the
  // extracted date/ref/method (and the Paid flip) apply to every row of a
  // split family, mirroring the sync mark-as-paid path and the
  // PUT /payments/:id cascade. Per-row guards (COALESCE / CASE) keep any
  // value an individual row already had.
  const root = await resolveFamilyRoot(entryId);
  const rootId = root?.rootId ?? Number(entryId);
  // Same installments guard as the sync path: when expense_payments rows
  // exist, payment_status is derived from them — don't force Paid.
  const { rows: ip } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM expense_payments WHERE expense_id = $1', [rootId]
  );
  const hasInstallments = (ip[0]?.n ?? 0) > 0;

  // Build update fields — only fill in what's missing
  const updates = [];
  const values = [];
  let paramIdx = 1;

  // Auto-mark as paid
  if (entry.payment_status !== 'Paid' && !hasInstallments) {
    updates.push(`payment_status = $${paramIdx++}`);
    values.push('Paid');
    updates.push(`paid_by = COALESCE(NULLIF(paid_by,''), $${paramIdx++})`);
    values.push(userName);
    updates.push(`paid_marked_at = COALESCE(paid_marked_at, NOW())`);
    // Clear rush + hold state — same auto-clear pattern used by every
    // other path that flips a row to Paid (PUT /payments/:id,
    // PUT /entries/:id, sync proof upload).
    updates.push(`rush_requested = FALSE`);
    updates.push(`rush_requested_at = NULL`);
    updates.push(`rush_requested_by = NULL`);
    updates.push(`rush_reason = NULL`);
    updates.push(`on_hold = FALSE`);
    updates.push(`hold_at = NULL`);
    updates.push(`hold_by = NULL`);
    updates.push(`hold_reason = NULL`);
  }

  // payment_date: AI date wins over the today-fallback we stamped during
  // the sync mark-as-paid. We can't tell "auto today" from "manual today"
  // without a flag column, so the heuristic is: override when the current
  // value is null OR equals today's LA date (which is the only value the
  // auto-fallback could have stamped). User-set dates that aren't today
  // are preserved. Applied per-row in SQL so each family member keeps its
  // own manually-set date.
  if (parsed.payment_date) {
    updates.push(`payment_date = CASE
      WHEN payment_date IS NULL
        OR payment_date = (NOW() AT TIME ZONE 'America/Los_Angeles')::DATE
      THEN $${paramIdx++}::date ELSE payment_date END`);
    values.push(parsed.payment_date);
  }

  if (parsed.reference_number) {
    updates.push(`payment_ref = COALESCE(NULLIF(payment_ref,''), $${paramIdx++})`);
    values.push(parsed.reference_number);
  }

  if (parsed.payment_method) {
    updates.push(`payment_method = COALESCE(NULLIF(payment_method,''), $${paramIdx++})`);
    values.push(parsed.payment_method);
  }

  if (updates.length > 0) {
    // Installment-managed families keep their derived per-row state — the
    // scan's fills then apply to the uploaded row only, not family-wide.
    const scope = hasInstallments
      ? `id = $${paramIdx}`
      : `(id = $${paramIdx} OR parent_id = $${paramIdx})`;
    values.push(hasInstallments ? Number(entryId) : rootId);
    await pool.query(
      `UPDATE expenses SET ${updates.join(', ')}
        WHERE ${scope}
          AND (deleted = false OR deleted IS NULL)
          AND (voided = false OR voided IS NULL)`,
      values
    );
    console.log(`Proof scan for entry ${entryId} (family root ${rootId}): date=${parsed.payment_date}, ref=${parsed.reference_number}, method=${parsed.payment_method}`);
  }
}

// DELETE /api/bk/entries/:id/file/:type
router.delete('/entries/:id/file/:type', async (req, res) => {
  try {
    const type = req.params.type;
    if (!FILE_TYPES[type]) return res.status(400).json({ success: false, error: 'Invalid file type' });

    const [dataCol, nameCol] = FILE_TYPES[type];
    const keyCol = FILE_R2_COLUMNS[type]; // undefined for receipt (legacy base64 only)

    // Grab the R2 key before clearing so we can delete the object afterward.
    let r2Key = null;
    if (keyCol) {
      const { rows } = await pool.query(`SELECT ${keyCol} AS key FROM expenses WHERE id = $1`, [req.params.id]);
      r2Key = rows[0]?.key || null;
    }

    // Clear BOTH stores. invoice/w9/proof live in R2 now, so nulling only the
    // legacy *_data column left *_r2_key set — and has_<type> ORs the key, so
    // the file "came back" on the next fetch and the delete looked like it
    // never saved. Null the key column too.
    await pool.query(
      keyCol
        ? `UPDATE expenses SET ${dataCol} = NULL, ${nameCol} = NULL, ${keyCol} = NULL WHERE id = $1`
        : `UPDATE expenses SET ${dataCol} = NULL, ${nameCol} = NULL WHERE id = $1`,
      [req.params.id]
    );

    // Best-effort R2 cleanup — don't fail the request if the object is already gone.
    if (r2Key) deleteFile(r2Key).catch(err => console.warn('R2 delete failed:', err.message));

    // Audit trail — file removals were the one destructive action that
    // left no bk_audit_log record.
    const { rows: entryRows } = await pool.query('SELECT payee FROM expenses WHERE id = $1', [req.params.id]).catch(() => ({ rows: [] }));
    await logBkAction(req.user, 'file_deleted', Number(req.params.id), entryRows[0]?.payee || null, null, null, null, `Removed ${type} file`);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Approvals ─────────────────────────────────────────────────────────────────

// GET /api/bk/approvals
router.get('/approvals', async (req, res) => {
  try {
    // Hide child splits and roll their amounts into the parent — same pattern
    // as the ledger/invoices list. Without this, a 3-way-split invoice shows
    // up as 3 separate approval cards. The parent already carries the full
    // artist_breakdown JSON, so the UI's breakdown editor still works.
    const colsNoAmount = EXPENSE_LIGHT_COLS
      .filter(c => c !== 'amount')
      .map(c => `e.${c}`)
      .join(', ');
    // Approver / User visibility filter — built via the shared
    // userVisibleRepsClause helper so the Approvals queue matches what
    // the Payments page shows. Admin / Superadmin = empty clause (no
    // filter). Anyone else = restricted to their own boom_rep + any
    // reps an admin has added to their visible-reps allow-list.
    //
    // Previously this query rolled its own SQL and referenced the
    // long-dropped approver_rep_blocks table — when an Approver hit
    // /bk/approvals, PG threw `relation "approver_rep_blocks" does
    // not exist`. Routing through the helper keeps the Approvals
    // filter in lockstep with /bk/payments.
    const repBlockParams = [];
    const repBlockSql = userVisibleRepsClause(req.user, repBlockParams, 'e');
    const repBlockClause = repBlockSql ? `AND ${repBlockSql}` : '';
    const [approvalsRes, aliasRes, artistsRes, releasesRes] = await Promise.all([
      pool.query(`
        SELECT ${colsNoAmount},
          (e.amount + COALESCE((SELECT SUM(c.amount) FROM expenses c
            WHERE c.parent_id = e.id AND (c.deleted = false OR c.deleted IS NULL)), 0)) AS amount,
          ((e.invoice_data IS NOT NULL AND e.invoice_data != '') OR e.invoice_r2_key IS NOT NULL) AS has_invoice,
          ((e.w9_data      IS NOT NULL AND e.w9_data      != '') OR e.w9_r2_key      IS NOT NULL) AS has_w9,
          (SELECT x.id FROM expenses x
           WHERE ((x.w9_data IS NOT NULL AND x.w9_data != '') OR x.w9_r2_key IS NOT NULL)
             AND (x.deleted = false OR x.deleted IS NULL)
             AND (
               LOWER(TRIM(x.payee)) = LOWER(TRIM(e.payee))
               OR LOWER(TRIM(x.payee)) IN (
                 SELECT LOWER(TRIM(va.alias)) FROM vendor_aliases va
                  WHERE LOWER(TRIM(va.primary_name)) = LOWER(TRIM(e.payee))
                 UNION
                 SELECT LOWER(TRIM(va.primary_name)) FROM vendor_aliases va
                  WHERE LOWER(TRIM(va.alias)) = LOWER(TRIM(e.payee))
               )
             )
           ORDER BY x.id DESC LIMIT 1) AS w9_entry_id,
          -- Supporting files the VENDOR attached alongside their invoice
          -- (file_extra on the submit form, stored as expense_receipt rows).
          -- NOTE: no backticks in these comments. This is inside a JS template
          -- literal, and a backtick in a -- comment ends the string; the error
          -- then points at the SQL, not at the comment.
          --
          -- Selected as a list rather than a count so the card can render one
          -- chip per file with a direct URL, the way the invoice and W9 chips
          -- already work — a count would mean an extra fetch per card.
          --
          -- Approvals is where a vendor submission is FIRST read, so a file that
          -- does not appear here is a file nobody sees at the moment it matters.
          COALESCE((
            SELECT json_agg(json_build_object('id', ef.id, 'name', ef.original_name)
                            ORDER BY ef.uploaded_at)
              FROM entity_files ef
             WHERE ef.entity_type = 'expense_receipt' AND ef.entity_id = e.id
          ), '[]'::json) AS attachments
        FROM expenses e
        WHERE e.status = 'pending'
          AND (e.deleted = false OR e.deleted IS NULL)
          AND (e.voided = false OR e.voided IS NULL)
          AND e.parent_id IS NULL
          ${repBlockClause}
        ORDER BY e.created_at ASC
      `, repBlockParams),
      pool.query('SELECT primary_name, alias FROM vendor_aliases'),
      // Roster + active-catalog snapshots for unknown-artist / unknown-song
      // detection below. Active releases only — archived ones shouldn't
      // satisfy the catalog check (otherwise we'd accept a song that's no
      // longer on the catalog).
      pool.query(`SELECT id, name FROM artists`),
      pool.query(`
        SELECT r.id, r.project_name, a.id AS artist_id, a.name AS artist_name
          FROM releases r LEFT JOIN artists a ON a.id = r.artist_id
         WHERE (r.archived = false OR r.archived IS NULL)
           AND r.project_name IS NOT NULL AND TRIM(r.project_name) != ''
      `),
    ]);

    // Silence vendor-name discrepancies when the mismatch is explained by a
    // vendor_aliases row for THIS vendor. Two patterns get filtered:
    //   1) Clean names — form_value="Chase Mann", document_value="Foreign Exchange
    //      Records" with that DBA aliased to Chase Mann.
    //   2) Descriptive sentences — e.g. W9 value
    //      "Line 2 business name 'Mixed By Miles Inc'; Line 1 shows individual
    //      name 'Miles Walker'". Adding "Miles Walker" as an alias of the
    //      submitted payee should silence that discrepancy even though the
    //      value isn't a clean name string.
    // Check runs at read time so alias additions take effect immediately (no rescan).
    const norm = (s) => String(s || '').toLowerCase().trim();
    // Bidirectional adjacency: aliasesOf.get(norm(x)) = Set of every other name
    // x is aliased to/from. Lets us resolve a payee's full known-name set.
    const aliasesOf = new Map();
    for (const { primary_name, alias } of aliasRes.rows) {
      const p = norm(primary_name), a = norm(alias);
      if (!p || !a) continue;
      if (!aliasesOf.has(p)) aliasesOf.set(p, new Set());
      if (!aliasesOf.has(a)) aliasesOf.set(a, new Set());
      aliasesOf.get(p).add(a);
      aliasesOf.get(a).add(p);
    }
    const namesForPayee = (payee) => {
      const p = norm(payee);
      const set = new Set();
      if (p) set.add(p);
      for (const n of (aliasesOf.get(p) || [])) set.add(n);
      return set;
    };
    const isAliasedName = (field) => {
      const f = String(field || '').toLowerCase();
      return f.includes('vendor') || f.includes('payee') || f.includes('name');
    };
    // Whole-word match so a short alias like "Bob" doesn't match "Bobby".
    // \W boundary works on punctuation, quotes, spaces — exactly the noise the
    // AI's descriptive sentences wrap names in.
    const mentions = (value, name) => {
      const v = String(value || '');
      if (!v || !name) return false;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|\\W)${escaped}(\\W|$)`, 'i').test(v);
    };
    const explained = (value, names) => {
      const v = norm(value);
      if (!v) return false;
      for (const n of names) {
        if (!n) continue;
        if (v === n) return true;
        if (mentions(value, n)) return true;
      }
      return false;
    };

    // Strip currency symbols + grouping to compare amounts as numbers.
    // Treats $1,100.00 / "1100" / 1100 the same.
    const parseAmount = (v) => {
      if (v == null) return null;
      const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
      return Number.isFinite(n) ? n : null;
    };
    // Discrepancy fields that should be silenced when the family/breakdown
    // total now matches the document — e.g. AI scan ran before the entry was
    // split, parent.amount was just one share, but the family total is now
    // correct so the "amount" finding is stale.
    const isAmountField = (field) =>
      /amount|total|sum/i.test(String(field || ''));

    // ── Unknown-artist / unknown-song detection ──────────────────────────────
    // Mirrors the matcher in routes/flags.js so the Approvals inline flag
    // and the Flags page use the same normalization. NFKD + diacritic strip
    // + alphanumeric-only catches case + spacing + punctuation noise, so
    // "DeLuca" / "Deluca" / "De Luca" all collapse to "deluca". Levenshtein
    // 1–2 (length-scaled) finds typo-close suggestions.
    function normName(s) {
      return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
    }
    function levDist(a, b) {
      if (a === b) return 0;
      if (!a.length) return b.length;
      if (!b.length) return a.length;
      const m = a.length, n = b.length;
      const v = new Array(n + 1);
      for (let j = 0; j <= n; j++) v[j] = j;
      for (let i = 1; i <= m; i++) {
        let prev = v[0]; v[0] = i;
        for (let j = 1; j <= n; j++) {
          const tmp = v[j];
          v[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, v[j], v[j - 1]);
          prev = tmp;
        }
      }
      return v[n];
    }
    const rosterByNorm = new Map();
    for (const a of artistsRes.rows) {
      const k = normName(a.name);
      if (k && !rosterByNorm.has(k)) rosterByNorm.set(k, a);
    }
    const releasesByNorm = new Map();
    for (const r of releasesRes.rows) {
      const k = normName(r.project_name);
      if (k && !releasesByNorm.has(k)) releasesByNorm.set(k, r);
    }
    // Find the closest-by-edit-distance entry in a normalized name index.
    // Returns { onRoster, suggestion } — onRoster=true means the query is
    // already a known name (no flag needed). Otherwise suggestion is the
    // nearest match within the length-scaled Levenshtein threshold (1–3
    // depending on length), or null if nothing is close enough.
    function findClosest(query, byNorm) {
      const qk = normName(query);
      if (!qk || qk.length < 2) return { onRoster: false, suggestion: null };
      if (byNorm.has(qk)) return { onRoster: true, suggestion: null };
      let best = null;
      for (const [k, v] of byNorm) {
        if (Math.abs(k.length - qk.length) > 3) continue;
        const d = levDist(qk, k);
        const longer = Math.max(k.length, qk.length);
        const threshold = longer <= 6 ? 1 : longer <= 12 ? 2 : 3;
        if (d > 0 && d <= threshold && (!best || d < best.d)) {
          best = { d, v };
          if (d === 1) break;
        }
      }
      return { onRoster: false, suggestion: best?.v || null };
    }

    for (const row of approvalsRes.rows) {
      const names = namesForPayee(row.payee);
      // The approvals SELECT already aliases `amount` to the family total
      // (parent.amount + SUM(children.amount)). Fall back to the breakdown
      // JSON sum if the entry hasn't been split yet but carries one.
      let familyTotal = parseAmount(row.amount);
      if (familyTotal == null && Array.isArray(row.artist_breakdown)) {
        const sum = row.artist_breakdown.reduce(
          (s, b) => s + (parseAmount(b?.amount) || 0), 0);
        if (sum > 0) familyTotal = sum;
      }

      for (const col of ['ai_scan', 'w9_scan']) {
        const scan = row[col];
        if (!scan || !Array.isArray(scan.discrepancies)) continue;
        const before = scan.discrepancies.length;
        scan.discrepancies = scan.discrepancies.filter(d => {
          // Amount silencer (invoice scans only — w9 has no amount field).
          // If the family/breakdown sum now matches the document amount, the
          // mismatch is stale (e.g. scan ran pre-split). Tolerance is 1 cent.
          if (col === 'ai_scan' && isAmountField(d.field) && familyTotal != null) {
            const docVal = parseAmount(d.document_value);
            if (docVal != null && Math.abs(docVal - familyTotal) < 0.01) {
              return false;
            }
          }

          if (!isAliasedName(d.field)) return true;
          // Invoice discrepancies use `document_value`; W9 discrepancies use `w9_value`.
          // Previous filter only checked document_value, so W9 mismatches were never silenced.
          const other = d.document_value != null ? d.document_value : d.w9_value;
          return !(explained(d.form_value, names) && explained(other, names));
        });
        // Once filtering empties the discrepancy list, the AI's prior summary
        // still narrates the (now-resolved) issue. Replace it so the green
        // "passed" banner doesn't keep flagging it.
        if (before > 0 && scan.discrepancies.length === 0) {
          scan.summary = 'All form fields match — discrepancies resolved by alias or split totals.';
        }
      }

      // Unknown-roster / unknown-catalog flag annotation. Non-empty fields
      // only: blank artist / song never flags (some categories legitimately
      // have no artist or song). When a Levenshtein-close match exists, we
      // surface it so the UI can offer a one-click "use suggestion" fix.
      if (row.artist && row.artist.trim()) {
        const { onRoster, suggestion } = findClosest(row.artist, rosterByNorm);
        if (!onRoster) {
          row.unknown_artist = true;
          if (suggestion) {
            row.suggested_artist_id = suggestion.id;
            row.suggested_artist_name = suggestion.name;
          }
        }
      }
      if (row.song && row.song.trim()) {
        const { onRoster: inCatalog, suggestion } = findClosest(row.song, releasesByNorm);
        if (!inCatalog) {
          row.unknown_song = true;
          if (suggestion) {
            row.suggested_release_id = suggestion.id;
            row.suggested_song_name = suggestion.project_name;
            row.suggested_release_artist = suggestion.artist_name;
          }
        }
      }
    }

    // ── Possible duplicates ──────────────────────────────────────────────
    //
    // The vendor form used to REFUSE a submission whose invoice number
    // collided with one already on file, telling the vendor to email us — so
    // a false positive meant the invoice never arrived. False positives were
    // the common case (normalizeInvoiceNum strips leading zeros, so 001 and 1
    // are one number; 88 live entries share "1"), and 393 pairs already in the
    // ledger would have been refused. The judgement moved here, where a person
    // can see both entries and decide.
    //
    // Computed per request rather than stored on a column: no schema change,
    // it covers rows that already exist instead of only new ones, and the flag
    // disappears by itself if the colliding entry is later deleted.
    //
    // Matched with normalizeInvoiceNum in JS, never re-expressed in SQL —
    // lib/normalize-invoice-num.js is the one definition and routes/flags.js
    // carries an explicit warning against hand-copying its rules.
    const needDup = approvalsRes.rows.filter((r) => String(r.invoice_number || '').trim());
    if (needDup.length) {
      const idents = [...new Set(needDup.flatMap((r) => [r.vendor_email, r.vendor_name, r.payee]
        .map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)))];
      const { rows: cands } = await pool.query(`
        SELECT id, invoice_number, amount, invoice_date, status, payee, vendor_name, vendor_email
          FROM expenses
         WHERE invoice_number IS NOT NULL AND TRIM(invoice_number) <> ''
           AND (deleted = false OR deleted IS NULL)
           AND (voided = false OR voided IS NULL)
           AND status <> 'rejected'
           AND (LOWER(TRIM(vendor_email)) = ANY($1)
             OR LOWER(TRIM(vendor_name))  = ANY($1)
             OR LOWER(TRIM(payee))        = ANY($1))`, [idents]).catch(() => ({ rows: [] }));
      const identsOf = (r) => [r.vendor_email, r.vendor_name, r.payee]
        .map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
      for (const row of needDup) {
        const mine = identsOf(row);
        const key = normalizeInvoiceNum(row.invoice_number);
        const hits = cands.filter((c) => c.id !== row.id
          && normalizeInvoiceNum(c.invoice_number) === key
          && identsOf(c).some((x) => mine.includes(x)));
        if (hits.length) {
          row.possible_duplicates = hits.map((c) => ({
            id: c.id,
            invoice_number: c.invoice_number,
            amount: c.amount,
            invoice_date: c.invoice_date,
            status: c.status,
          }));
        }
      }
    }

    res.json({ success: true, data: approvalsRes.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/entries/:id/approve
const { sendVendorApprovedEmail, sendVendorRejectedEmail } = require('../services/email');
const { prepareEmail: prepareEmailPayload } = require('../services/emailDispatch');

// ── The W9 review ───────────────────────────────────────────────────────────
//
// The SECOND review on Approvals, beside the invoice checklist. One question:
// is this W9 signed and dated?
//
// ── Keyed to the DOCUMENT, not the invoice ──────────────────────────────────
// Measured on the live queue (2026-08-24): of 30 pending approvals, 17 carry
// their own W9 file. Of the 13 that do not, TWELVE have a W9 on file for that
// vendor elsewhere — exactly one vendor genuinely has none. A per-invoice review
// would have shown "no W9" on 43% of the queue and asked for the same PDF to be
// re-attested on every future invoice from the same person.
//
// So the answer is written onto the entry that HOLDS the file, resolved through
// lib/w9-owner.js (alias-aware, and asserted to agree with
// GET /bk/vendor-w9-status). Reviewing once covers every invoice that vendor
// sends; a NEW upload is a new entry and is unreviewed again, which is the
// behaviour you want from a document attestation.
//
// ── It does NOT gate approval ───────────────────────────────────────────────
// John's call, and the right one: an approver who is blocked by a document
// problem the VENDOR has to fix is an approver who clicks "yes" to get
// unblocked. The answer is recorded and flagged. validateApprovalChecklist is
// untouched.
router.get('/w9-reviews', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: pending } = await pool.query(
      `SELECT e.id, e.payee, e.amount, e.currency, e.invoice_number, e.invoice_date, e.boom_rep
         FROM expenses e
        WHERE COALESCE(e.status, 'pending') = 'pending'
          AND (e.deleted IS NULL OR e.deleted = FALSE)
          AND e.parent_id IS NULL
        ORDER BY e.id DESC`);

    const owners = await w9OwnersFor(pending.map((p) => p.payee));

    // Group the PENDING INVOICES under the W9 document that covers them, so the
    // deck shows one card per document with the invoices riding on it.
    const byOwner = new Map();
    const noW9 = [];
    for (const inv of pending) {
      const owner = owners.get(String(inv.payee || '').trim().toLowerCase());
      if (!owner) { noW9.push(inv); continue; }
      if (!byOwner.has(owner.id)) byOwner.set(owner.id, { ...owner, invoices: [] });
      byOwner.get(owner.id).invoices.push(inv);
    }

    const cards = [...byOwner.values()].map((o) => {
      const scan = typeof o.w9_scan === 'string' ? (() => { try { return JSON.parse(o.w9_scan); } catch { return null; } })() : o.w9_scan;
      return {
        entry_id: o.id,
        payee: o.payee,
        w9_filename: o.w9_filename,
        w9_r2_key: o.w9_r2_key,
        // What the AI already read. The deck PRE-FILLS the answer from this
        // (John's call) and records whether the reviewer kept it — see POST.
        scan: scan ? {
          signed: scan.w9_signed === true,
          dated: scan.w9_dated === true,
          form_type: scan.form_type || null,
          name: scan.w9_name || scan.w9_business_name || null,
          discrepancies: Array.isArray(scan.discrepancies) ? scan.discrepancies : [],
        } : null,
        review: o.w9_review || null,
        invoices: o.invoices,
      };
    });

    res.json({
      success: true,
      data: {
        // Only unreviewed documents are work. Reviewed ones stay out of the
        // deck but are returned in `reviewed` so the page can show the count.
        queue: cards.filter((c) => !c.review),
        reviewed: cards.filter((c) => c.review),
        // Pending invoices whose vendor has NO W9 anywhere. Not a queue item —
        // there is nothing to look at. It is a vendor problem, surfaced rather
        // than silently counted as reviewed.
        no_w9: noW9,
      },
    });
  } catch (err) {
    console.error('GET /api/bk/w9-reviews:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/w9-reviews/:id(\\d+)', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { signed_and_dated, prefilled, accepted_prefill } = req.body || {};
    if (typeof signed_and_dated !== 'boolean') {
      return res.status(400).json({ success: false, error:
        'Answer yes or no — leaving it blank is what makes "no" and "nobody looked" the same thing.' });
    }
    const { rows: [target] } = await pool.query(
      `SELECT id, payee, w9_scan FROM expenses WHERE id = $1`, [req.params.id]);
    if (!target) return res.status(404).json({ success: false, error: 'Entry not found' });

    const scan = typeof target.w9_scan === 'string' ? (() => { try { return JSON.parse(target.w9_scan); } catch { return null; } })() : target.w9_scan;
    const review = {
      signed_and_dated,
      // Whether the reviewer ACCEPTED the pre-filled answer or changed it.
      // The pre-fill was chosen deliberately; this is what keeps the record
      // meaningful afterwards — "confirmed what the scan said" and "looked and
      // decided" are different claims, and a tax attestation should be able to
      // tell them apart.
      prefilled: prefilled === true,
      accepted_prefill: prefilled === true && accepted_prefill === true,
      scan_said: scan ? { signed: scan.w9_signed === true, dated: scan.w9_dated === true, form_type: scan.form_type || null } : null,
      by: req.user?.name || null,
      at: new Date().toISOString(),
    };
    await pool.query('UPDATE expenses SET w9_review = $1 WHERE id = $2', [JSON.stringify(review), target.id]);
    // Signature is (user, action, id, payee, field, oldVal, newVal, details) —
    // the message is the EIGHTH argument, not the fifth.
    await logBkAction(req.user, 'w9_review', target.id, target.payee,
      'w9_review', null, signed_and_dated ? 'yes' : 'no',
      `W9 reviewed: signed and dated = ${signed_and_dated ? 'yes' : 'no'}`).catch(() => {});
    res.json({ success: true, data: { entry_id: target.id, review } });
  } catch (err) {
    console.error('POST /api/bk/w9-reviews/:id:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/entries/:id/approve', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    const { artist_breakdown, notes, notify, checklist } = req.body;
    const entryId = Number(req.params.id);

    // Defense in depth: an Approver can't act on an entry that's hidden
    // from them by the rep-block list. /bk/approvals already filters
    // these out of the visible queue; this check stops an Approver from
    // approving a blocked entry by direct API call.
    if (!(await userCanActOnEntry(req.user, entryId))) {
      return res.status(403).json({ success: false, error: 'You do not have visibility into this entry' });
    }

    // THE GATE — after authorization, before every write below. A 400 here
    // must leave the invoice exactly as it was.
    const check = validateApprovalChecklist(checklist);
    if (!check.ok) return res.status(400).json({ success: false, error: check.error });

    // Get original entry. Include invoice_data (and invoice_filename is
    // already in the light set) because we attach the invoice PDF to the
    // vendor-approved email below. w9/proof/receipt blobs stay omitted.
    const { rows: orig } = await pool.query(
      `SELECT ${expenseCols()}, invoice_data FROM expenses WHERE id = $1`,
      [entryId]
    );
    if (!orig.length) return res.status(404).json({ success: false, error: 'Entry not found' });
    const entry = orig[0];

    // Built here, WRITTEN inside whichever branch runs below. Writing it on the
    // pool up front would stamp a checklist onto a row whose split transaction
    // then rolled back — a pending invoice carrying an approval record.
    //
    // The local entry is updated either way, because the split branch copies
    // entry.cobrand onto the children it creates and answering cobrand forces
    // category = 'Marketing'; stale values here leave parent and children
    // disagreeing about both.
    const stampedChecklist = stampChecklist(check.value, req.user);
    entry.cobrand = check.value.cobrand;
    entry.is_bulk_deal = check.value.bulk_deal;
    if (check.value.cobrand) entry.category = 'Marketing';

    if (artist_breakdown && Array.isArray(artist_breakdown) && artist_breakdown.length > 1) {
      // Split approval: update parent with first artist, insert children for rest.
      // Clear any pre-existing children first — otherwise approving an
      // already-split entry would duplicate the rows (same pattern as
      // POST /entries/:id/split).
      //
      // Refuse when an existing child is a fee/reimb child carrying a
      // receipt — receipt_data is the ONLY copy of that file and the
      // delete below would destroy it irrecoverably.
      const { rows: receiptKids } = await pool.query(
        `SELECT id FROM expenses WHERE parent_id = $1 AND receipt_data IS NOT NULL LIMIT 1`,
        [entryId]
      );
      if (receiptKids.length) {
        return res.status(400).json({
          success: false,
          error: 'This invoice has a fee/reimbursement child with an attached receipt — approving with a new split would permanently delete it. Approve without a breakdown, or unsplit first.',
        });
      }

      // All-or-nothing (dedicated client — pool.query('BEGIN') doesn't pin
      // a connection): the parent's amount is cut to the first slice before
      // the children exist. Children inherit the family-shared payment +
      // recoupment + vendor state — previously they were born with NULL
      // payment_status/vendor_email/invoice_number and default-TRUE
      // recoupable regardless of the parent.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Inside the transaction on purpose: if the split rolls back, the
        // invoice must not be left pending with an approval checklist on it.
        await writeApprovalChecklist(client, entryId, stampedChecklist);
        await client.query('DELETE FROM expenses WHERE parent_id = $1', [entryId]);

        const [first, ...rest] = artist_breakdown;
        await client.query(`
          UPDATE expenses
          SET status = 'approved', approved_by = $1, approved_at = NOW(),
              artist = $2, song = $3, amount = $4,
              artist_breakdown = $5,
              notes = COALESCE(NULLIF($6,''), notes)
          WHERE id = $7
        `, [req.user.name, first.artist, first.song || entry.song,
            first.amount, JSON.stringify(artist_breakdown), notes || null, entryId]);

        for (const split of rest) {
          await client.query(`
            INSERT INTO expenses
              (invoice_date, payee, description, category, artist, song, amount,
               currency, payment_method, status, approved_by, approved_at,
               parent_id, cobrand, is_reimbursement, boom_rep, created_by,
               vendor_email, vendor_name, payment_status, payment_date,
               paid_by, paid_marked_at, payment_terms, scheduled_payment_date,
               invoice_number, recoupable, artist_campaign,
               -- The payment record follows the money. Splitting a $10k invoice
               -- three ways used to leave three children with NO payment verdict
               -- and NO account, so the one row that says where the money went
               -- was the parent nobody opens. Copied at the split rather than
               -- resolved to the family root on read: children are immutable
               -- after creation, so a copy cannot drift, and every future reader
               -- gets it without being taught the family rule.
               payment_check, payment_last4, payment_snapshot)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'approved',$10,NOW(),$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
          `, [entry.invoice_date, entry.payee, entry.description, entry.category,
              split.artist, split.song || entry.song, split.amount,
              entry.currency, entry.payment_method, req.user.name,
              entryId, entry.cobrand, entry.is_reimbursement, entry.boom_rep, req.user.name,
              entry.vendor_email, entry.vendor_name, entry.payment_status, entry.payment_date,
              entry.paid_by, entry.paid_marked_at, entry.payment_terms, entry.scheduled_payment_date,
              entry.invoice_number, entry.recoupable, entry.artist_campaign || 'Yes',
              // JSONB columns: pg needs the object serialized, and `entry` came
              // back from a SELECT so these are already parsed objects.
              entry.payment_check ? JSON.stringify(entry.payment_check) : null,
              entry.payment_last4 || null,
              entry.payment_snapshot ? JSON.stringify(entry.payment_snapshot) : null]);
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      await logBkAction(req.user, 'expense_approved_split', entryId, entry.payee,
        null, 'pending', 'approved',
        `Split into ${artist_breakdown.length} entries · checklist ${JSON.stringify(stampedChecklist)}`);
    } else {
      // Simple approval — also cascade approval to any existing child splits
      // so split families don't end up with the parent approved and orphan
      // children stuck pending (they're hidden from the approvals page now).
      await writeApprovalChecklist(pool, entryId, stampedChecklist);

      await pool.query(`
        UPDATE expenses
        SET status = 'approved', approved_by = $1, approved_at = NOW(),
            notes = COALESCE(NULLIF($2,''), notes)
        WHERE id = $3
      `, [req.user.name, notes || null, entryId]);

      await pool.query(`
        UPDATE expenses
        SET status = 'approved', approved_by = $1, approved_at = NOW()
        WHERE parent_id = $2 AND status = 'pending'
          AND (deleted = false OR deleted IS NULL)
      `, [req.user.name, entryId]);

      // The checklist rides along in the audit trail too, but expenses
      // .approval_checklist is the record of truth: logBkAction swallows its
      // own failures by design, and an audit trail that can silently not write
      // is not one.
      await logBkAction(req.user, 'expense_approved', entryId, entry.payee,
        'status', 'pending', 'approved', `checklist ${JSON.stringify(stampedChecklist)}`);
    }

    // Auto-link expense to release by matching artist + song (non-blocking)
    if (entry.song && entry.artist) {
      pool.query(`
        UPDATE expenses e
        SET release_id = r.id
        FROM releases r JOIN artists a ON r.artist_id = a.id
        WHERE e.id = $1 AND e.release_id IS NULL
          AND normalize_artist_key(a.name) = normalize_artist_key(e.artist)
          AND LOWER(TRIM(r.project_name)) = LOWER(TRIM(e.song))
      `, [entryId]).catch(() => {});
    }

    // Email is no longer fired synchronously. Instead, when the caller asked
    // for notification AND the entry is vendor-submitted with an email on
    // file, we return a `pending_email` payload describing the kind +
    // context. The client opens EmailPreviewModal, the admin can edit
    // recipient/CC/subject/body inline, and the modal POSTs to /api/email/send.
    let pending_email = null;
    if (notify && entry.vendor_submitted && entry.vendor_email) {
      try {
        const preview = await prepareEmailPayload('vendor_approved', { entryId, cc_rep: true });
        pending_email = {
          kind: 'vendor_approved',
          context: { entryId },
          ...preview,
        };
      } catch (err) {
        console.warn('prepare approval preview failed:', err.message);
      }
    }

    qbo.enqueue('bill', entryId, req.user.id);
    res.json({ success: true, pending_email });

    // Activity feed. Fired AFTER the response and never awaited — the approval
    // has already committed and been reported, so nothing the bot does can
    // affect it. postEvent swallows and logs its own failures.
    postEvent({
      text: `*${req.user.name}* approved *${entry.payee || 'an invoice'}*`
        + (entry.amount ? ` — ${entry.currency || 'USD'} ${Number(entry.amount).toLocaleString()}` : ''),
      icon: 'check',
      link: `/bk/ledger?entry=${entryId}`,
    }).catch(e => console.error('[activityBot] event dropped:', e.message));
  } catch (err) {
    console.error('POST /api/bk/entries/:id/approve:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/entries/:id/unreject
//
// Put a rejected submission back in front of an approver. Goes to 'pending',
// never straight to 'approved': a rejection was a decision, and undoing it
// restores the question rather than answering it the other way. An entry that
// jumped from rejected to approved would also skip the visibility and split
// checks the Approvals page applies.
//
// Mirrors the reject cascade — reject also marks pending children, so those have
// to come back with the parent or the family is left half-rejected and the
// children stay invisible on the Approvals page.
//
// The rejection reason is NOT erased. It stays in bk_audit_log (which is where
// the archive reads it from) and in `notes`, so the history of "this was
// rejected for X, then restored" survives. Removing it would make a restored
// invoice indistinguishable from one that was never rejected.
router.post('/entries/:id/unreject', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    if (!(await userCanActOnEntry(req.user, Number(req.params.id)))) {
      return res.status(403).json({ success: false, error: 'You do not have visibility into this entry' });
    }
    const { rows: [entry] } = await pool.query(
      'SELECT id, payee, status, parent_id FROM expenses WHERE id = $1', [req.params.id]);
    if (!entry) return res.status(404).json({ success: false, error: 'Entry not found' });
    if (entry.status !== 'rejected') {
      return res.status(400).json({ success: false, error: `That entry is ${entry.status}, not rejected` });
    }

    await pool.query(`UPDATE expenses SET status = 'pending' WHERE id = $1`, [req.params.id]);
    const { rowCount: kids } = await pool.query(`
      UPDATE expenses SET status = 'pending'
       WHERE parent_id = $1 AND status = 'rejected'
         AND (deleted = false OR deleted IS NULL)`, [req.params.id]);

    await logBkAction(req.user, 'expense_unrejected', Number(req.params.id),
      entry.payee, 'status', 'rejected', 'pending', null);

    res.json({ success: true, data: { id: entry.id, status: 'pending', children_restored: kids } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/entries/:id/reject
router.post('/entries/:id/reject', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    if (!(await userCanActOnEntry(req.user, Number(req.params.id)))) {
      return res.status(403).json({ success: false, error: 'You do not have visibility into this entry' });
    }
    const { reason, notify } = req.body;

    // Fetch entry before updating (need vendor info + invoice file for email)
    const { rows: orig } = await pool.query(
      'SELECT payee, vendor_submitted, vendor_name, vendor_email, amount, currency, invoice_number, invoice_data, invoice_r2_key, invoice_filename, boom_rep FROM expenses WHERE id = $1',
      [req.params.id]
    );
    if (!orig.length) return res.status(404).json({ success: false, error: 'Entry not found' });
    const entry = orig[0];

    await pool.query(`
      UPDATE expenses SET status = 'rejected',
        notes = CASE WHEN notes IS NULL THEN $2 ELSE notes || ' | Rejected: ' || $2 END
      WHERE id = $1
    `, [req.params.id, reason || '']);

    // Cascade rejection to any pending child splits — they're hidden from
    // the approvals page now, so leaving them as 'pending' would orphan them.
    await pool.query(`
      UPDATE expenses SET status = 'rejected'
      WHERE parent_id = $1 AND status = 'pending'
        AND (deleted = false OR deleted IS NULL)
    `, [req.params.id]);

    await logBkAction(req.user, 'expense_rejected', Number(req.params.id),
      entry.payee, 'status', 'pending', 'rejected', reason || null);

    // Return preview payload — client opens EmailPreviewModal and posts to
    // /api/email/send when the admin clicks Send.
    let pending_email = null;
    if (notify && entry.vendor_submitted && entry.vendor_email) {
      try {
        const preview = await prepareEmailPayload('vendor_rejected', {
          entryId: Number(req.params.id), cc_rep: true, reason,
        });
        pending_email = {
          kind: 'vendor_rejected',
          context: { entryId: Number(req.params.id), reason },
          ...preview,
        };
      } catch (err) {
        console.warn('prepare rejection preview failed:', err.message);
      }
    }

    res.json({ success: true, pending_email });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/bulk-approve
// body: { ids: number[], notify_ids?: number[] }
router.post('/bulk-approve', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { ids, notify_ids } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ success: false, error: 'No ids provided' });

    // Visibility check: every entry in the bulk must be visible to
    // the actor. Reuses the shared findInvisibleEntry helper so the
    // bulk-approve check stays in sync with the /bk/approvals filter
    // and the per-entry action guards. Any invisible entry → reject
    // the whole batch (silently skipping would be surprising and
    // could leave items pending without the admin knowing).
    {
      const invisible = await findInvisibleEntry(req.user, ids);
      if (invisible) {
        return res.status(403).json({
          success: false,
          error: `Bulk includes an entry you don't have visibility into (id ${invisible.id}, rep ${invisible.boom_rep || 'none'}).`,
        });
      }
    }

    // Every id needs its own completed checklist. This route has had no caller
    // since the Approvals page moved bulk approval into the review deck, but an
    // unguarded route IS the bypass — anyone holding a token can still POST to
    // it, and a checklist you can skip by calling a different endpoint is not a
    // checklist. Guarding it is smaller and safer than deleting it, which would
    // also mean touching the mock adapter, activityLogger and the Activity
    // page's label for no gain in safety.
    const { checklists } = req.body;
    const stampedById = new Map();
    for (const id of ids) {
      const check = validateApprovalChecklist(checklists && checklists[id]);
      if (!check.ok) {
        return res.status(400).json({ success: false,
          error: `Invoice ${id}: ${check.error}` });
      }
      stampedById.set(Number(id), stampChecklist(check.value, req.user));
    }

    for (const [id, stamped] of stampedById) {
      await writeApprovalChecklist(pool, id, stamped);
    }

    const { rowCount } = await pool.query(`
      UPDATE expenses
      SET status = 'approved', approved_by = $1, approved_at = NOW()
      WHERE id = ANY($2::int[]) AND status = 'pending'
    `, [req.user.name, ids]);

    // Cascade to any pending child splits of these parents (children are
    // hidden from the approvals page now, so they can't be bulk-selected
    // directly).
    await pool.query(`
      UPDATE expenses
      SET status = 'approved', approved_by = $1, approved_at = NOW()
      WHERE parent_id = ANY($2::int[]) AND status = 'pending'
        AND (deleted = false OR deleted IS NULL)
    `, [req.user.name, ids]);

    await logBkAction(req.user, 'bulk_approve', null, null, null, null, null,
      `Bulk approved ${rowCount} entries`);

    // Build a queue of preview payloads for any ids the caller wants to
    // notify about. Client iterates these in a per-vendor wizard.
    const toNotify = Array.isArray(notify_ids) ? notify_ids.filter(n => ids.includes(n)) : [];
    const pending_emails = [];
    if (toNotify.length) {
      const { rows: entries } = await pool.query(
        `SELECT id, vendor_submitted, vendor_email
           FROM expenses WHERE id = ANY($1::int[])`,
        [toNotify]
      );
      for (const e of entries) {
        if (!e.vendor_submitted || !e.vendor_email) continue;
        try {
          const preview = await prepareEmailPayload('vendor_approved', { entryId: e.id, cc_rep: true });
          pending_emails.push({
            kind: 'vendor_approved',
            context: { entryId: e.id },
            ...preview,
          });
        } catch (err) {
          console.warn('prepare bulk-approve preview failed for', e.id, err.message);
        }
      }
    }

    for (const id of ids) qbo.enqueue('bill', Number(id), req.user.id);
    res.json({ success: true, approved: rowCount, notified: toNotify.length, pending_emails });

    // One line for the batch, not one per invoice — a 40-invoice bulk approve
    // posting 40 times would bury every other event in the feed.
    if (rowCount > 0) {
      postEvent({
        text: `*${req.user.name}* approved *${rowCount}* invoice${rowCount === 1 ? '' : 's'}`,
        icon: 'check',
        link: '/bk/approvals/archive',
      }).catch(e => console.error('[activityBot] event dropped:', e.message));
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── AI Parsing ────────────────────────────────────────────────────────────────

// ── AI document validation (mirror of the vendor portal checks) ──────────────
// These two endpoints — /validate-invoice and /validate-w9 — give the
// internal Add Invoice page the same gating the public vendor portal
// has on invoice uploads and W9/W8 uploads. Same prompts, same return
// shape; the page surfaces a clear "Issues found" banner so staff
// don't add half-baked invoices to the ledger.

// Coerce the various shapes Claude returns issues in into a plain string[]
// for the client to render directly. Without this, an object slipped into
// the array crashes React with "Objects are not valid as a React child."
function normalizeIssueArray(value) {
  const toString = (v) => {
    if (v == null) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
      return v.issue || v.problem || v.description || v.message || v.field || JSON.stringify(v);
    }
    return String(v);
  };
  let issues = value;
  if (typeof issues === 'string') issues = [issues];
  else if (!Array.isArray(issues)) issues = [];
  return issues.map(toString).filter(Boolean);
}

// POST /api/bk/validate-invoice (multipart: file)
// Mirror of the vendor portal's /validate-invoice check — confirms the
// uploaded document is actually an invoice, billed to Market Street, has an invoice
// number / date / amount / description. Used by the Add Invoice page to
// flag issues before the entry hits the ledger.
router.post('/validate-invoice', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ valid: false, issues: ['No file uploaded'] });
    const prompt = `You are validating an invoice submitted to Market Street (a record label). Check this document and return ONLY valid JSON:
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

If ANY requirement fails, set valid=false and list the specific issues. Be strict — reject anything that is not a proper invoice. Return only JSON.`;

    const result = await callClaude({
      prompt,
      buffer: req.file.buffer,
      filename: req.file.originalname,
      maxTokens: 512,
      parseJson: true,
      cacheDocument: true,
    });
    if (!result.ok) {
      // AI unavailable / errored — fail open so the staff workflow isn't
      // blocked by a hiccup. The downstream dup gate + manual review on
      // the Add Invoice page still catch garbage.
      return res.json({ valid: true, issues: [] });
    }
    const parsed = result.data || {};
    res.json({
      ...parsed,
      issues: normalizeIssueArray(parsed.issues),
      valid: parsed.valid !== false,
    });
  } catch (err) {
    console.error('POST /api/bk/validate-invoice:', err.message);
    res.json({ valid: true, issues: [] });
  }
});

// POST /api/bk/validate-w9 (multipart: file)
// Mirror of the vendor portal's /validate-w9 — confirms the document is
// actually a W-9 or W-8 form, signed, dated, with the required fields
// filled. Today's date is anchored in the prompt so the model doesn't
// flag real-past signings as "future."
router.post('/validate-w9', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ valid: false, issues: ['No file uploaded'] });
    const nowDate = new Date();
    const todayISO = nowDate.toISOString().slice(0, 10);
    const todayHuman = nowDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const prompt = `You are validating a W-9 or W-8 tax form submitted to Market Street.

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

Only flag genuine problems that would make the form legally invalid. Return only JSON.`;

    const result = await callClaude({
      prompt,
      buffer: req.file.buffer,
      filename: req.file.originalname,
      maxTokens: 512,
      parseJson: true,
      cacheDocument: true,
    });
    if (!result.ok) return res.json({ valid: true, issues: [] });
    const parsed = result.data || {};

    // Belt-and-suspenders: even with today's date in the prompt, the model
    // occasionally mis-classifies. Strip any "future date" issue when the
    // extracted form_date is actually on or before today.
    let issues = normalizeIssueArray(parsed.issues);
    const formDate = typeof parsed.form_date === 'string' ? parsed.form_date : null;
    const dateInPast = formDate && /^\d{4}-\d{2}-\d{2}/.test(formDate) && formDate.slice(0, 10) <= todayISO;
    if (dateInPast) {
      issues = issues.filter(s => !/future date/i.test(s) && !/dated in the future/i.test(s));
    }
    const valid = parsed.valid !== false || (dateInPast && issues.length === 0);
    res.json({ ...parsed, issues, valid });
  } catch (err) {
    console.error('POST /api/bk/validate-w9:', err.message);
    res.json({ valid: true, issues: [] });
  }
});

// POST /api/bk/extract-invoice-number (multipart: file)
// Focused AI extraction of the invoice number printed on the document.
// Returns { ok, invoice_number }. Used by the Add Invoice page to cross-
// check the typed invoice number against what's actually printed —
// mirrors the same submit-time gate the vendor portal applies.
router.post('/extract-invoice-number', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, invoice_number: null });
    const prompt = `Extract ONLY the invoice number printed on this invoice/receipt document. Return ONLY valid JSON:
{"invoice_number": "the exact invoice number string as printed, or null if no invoice number / receipt reference is shown"}

Rules:
- Only return a number that is clearly labelled as an invoice number, receipt number, or reference number on the document.
- Do NOT infer a number from dates, totals, account numbers, routing numbers, phone numbers, or order line counts.
- If no invoice/receipt number is shown, return null.
Return only JSON.`;

    const result = await callClaude({
      prompt,
      buffer: req.file.buffer,
      filename: req.file.originalname,
      maxTokens: 128,
      parseJson: true,
      cacheDocument: true,
    });
    if (!result.ok) return res.json({ ok: false, invoice_number: null });
    const raw = result.data?.invoice_number;
    const num = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    res.json({ ok: true, invoice_number: num });
  } catch (err) {
    console.error('POST /api/bk/extract-invoice-number:', err.message);
    res.json({ ok: false, invoice_number: null });
  }
});

// POST /api/bk/parse  (multipart: file)
// POST /api/bk/parse-lines — line items off a multi-line invoice.
//
// SEPARATE from /parse on purpose. /parse answers "what is this invoice" for the
// bulk upload and the public vendor form; changing its contract would touch both.
// This answers a different question: "what are the lines inside it", for an
// invoice that is really twenty small expenses stapled together.
//
// The division of labour is the whole safety argument:
//   · the AMOUNTS and the TOTAL come from the text, deterministically, and must
//     reconcile to the total the document prints, or `reconciles` is false and the
//     caller is told why. No model touches the money.
//   · the CATEGORY and ARTIST per line come from one Claude call over the already
//     extracted lines. A wrong label mislabels a row a person is reviewing; it
//     cannot change a figure.
// If that call fails the lines still come back, unlabelled — the split editor is
// perfectly usable with the categories blank, so an AI outage must not block
// filing an invoice.
router.post('/parse-lines', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    let text = '';
    try {
      text = await extractPdfText(req.file.buffer);
    } catch (err) {
      return res.status(400).json({ success: false, error:
        `Could not read text out of this file (${err.message}). Line splitting needs a text-based PDF — `
        + 'a photograph or a scan has no line structure to read.' });
    }
    const parsed = parseInvoiceLines(text);
    if (!parsed.lines.length) {
      return res.status(400).json({ success: false,
        error: `No numbered line items found — ${parsed.reason || 'this may not be an itemised invoice'}.` });
    }

    // The names a line is ALLOWED to be attributed to: the signed roster UNION
    // every artist name the ledger already uses. Roster alone is the wrong test —
    // Oxis owns 8 lines of the sheet that prompted this and is not on it.
    const [rosterRows, ledgerRows, vocab] = await Promise.all([
      pool.query(`SELECT name FROM artists WHERE archived IS NOT TRUE`).catch(() => ({ rows: [] })),
      pool.query(`SELECT DISTINCT TRIM(artist) AS name FROM expenses
                   WHERE artist IS NOT NULL AND TRIM(artist) <> ''
                     AND (deleted = false OR deleted IS NULL)`).catch(() => ({ rows: [] })),
      categoryVocabulary(pool, 'expense'),
    ]);
    const known = [...new Set([...rosterRows.rows, ...ledgerRows.rows]
      .map((r) => String(r.name || '').trim()).filter((n) => n.length >= 2))];

    // Label the lines. ONE call for the whole sheet: 20 short strings, and the
    // model is given the amounts only as context — it returns labels keyed by line
    // number, so there is no path by which its answer can alter a figure.
    let labels = {};
    let labelled = false;
    let labelError = process.env.ANTHROPIC_API_KEY ? null : 'ANTHROPIC_API_KEY is not set';
    if (process.env.ANTHROPIC_API_KEY) {
      const prompt = `You are labelling the line items of a reimbursement invoice for a music label.

For EACH numbered line below, return a category and, when the line is for a specific artist, that artist.

Return ONLY valid JSON: {"lines": [{"n": <line number>, "category": "<one of the categories below>", "artist": "<an artist from the list below, or null>"}]}

CATEGORY — the label's own vocabulary, most-used first:
${vocab.prompt}

Choose from that list ONLY. Prefer a category the label uses often over a rarely used one when both could fit.

The "Artist Expense - …" categories are for work or costs incurred FOR A NAMED ARTIST and take precedence over their plain equivalents whenever a line names one.

ARTIST — you may ONLY use a name from this list, exactly as spelled here, or null:
${known.join(' · ')}

Rules that matter more than they look:
- A line naming a person who is NOT in that list gets artist null. Never invent a name and never guess at a spelling.
- Staff and partners are not artists. A line like "Coffee for Tyler @ exec meeting" is company overhead with NO artist, even though it names somebody.
- Subscriptions, software, bank fees and general travel are label overhead: no artist.
- A ride-share to an industry event is Travel, not an artist expense, unless the line says it was for a named artist.

THE LINES:
${parsed.lines.map((l) => `${l.n}. ${[l.date, l.vendor].filter(Boolean).join(' ')} — ${l.description}`
  + `${l.note ? ` (note: ${l.note})` : ''} — $${l.amount.toFixed(2)}`).join('\n')}

Return the JSON object and NOTHING else — no preamble, no explanation, no markdown
fence. Do not say what you are about to do. The first character of your reply must
be {.`;
      // Report WHY when this comes back empty. The first production run returned
      // `labels_from: none` with no explanation, which is the same silent-failure
      // shape as swallowing an error: the parse looked fine and the reason it had
      // not labelled anything was unavailable to anyone reading the response.
      let out = null;
      try {
        out = await callClaude({ prompt, maxTokens: 4096, parseJson: true });
        if (out && out.ok === false) labelError = out.error || 'the model did not return usable JSON';
      } catch (err) {
        labelError = err.message;
      }
      // SALVAGE. The instruction above asks for bare JSON; this makes it not
      // matter. The first production run failed with `Unexpected token 'I',
      // "I'll analy"...` — the model narrated before answering, and a whole
      // 20-line labelling was thrown away over a preamble. Pull the outermost
      // {...} out of the raw reply and parse that.
      let payload = out?.ok ? out.data : null;
      if (!payload && out?.raw) {
        const raw = String(out.raw);
        const a = raw.indexOf('{');
        const b = raw.lastIndexOf('}');
        if (a >= 0 && b > a) {
          try { payload = JSON.parse(raw.slice(a, b + 1)); labelError = null; }
          catch { /* keep the original parse error */ }
        }
      }
      const arr = Array.isArray(payload) ? payload
        : (payload?.lines || payload?.data?.lines || null);
      if (!arr && payload) {
        labelError = `unexpected shape from the model: ${Object.keys(payload).join(', ') || typeof payload}`;
      }
      if (Array.isArray(arr)) {
        labelled = true;
        for (const row of arr) {
          const n = Number(row?.n);
          if (!Number.isFinite(n)) continue;
          // The model's artist is CHECKED against the allowed list rather than
          // trusted — a hallucinated or mis-spelled name becomes null, not a new
          // artist. Same posture as the roster validation in /parse.
          const artist = known.find((k) => k.toLowerCase() === String(row?.artist || '').trim().toLowerCase()) || null;
          labels[n] = { category: String(row?.category || '').trim() || null, artist };
        }
      }
    }

    const lines = parsed.lines.map((l) => {
      const lab = labels[l.n] || {};
      const category = vocab.list.find((c) => c.toLowerCase() === String(lab.category || '').toLowerCase()) || null;
      return {
        ...l,
        category,
        artist: lab.artist || null,
        // John's rule: recoupable only when the line names an artist. `recoupable`
        // defaults TRUE in the schema, so without this every subscription and
        // ride-share on the sheet would land on Recoupments against nobody.
        recoupable: Boolean(lab.artist),
      };
    });

    res.json({ success: true, data: {
      lines,
      printed_total: parsed.printed_total,
      line_total: parsed.line_total,
      reconciles: parsed.reconciles,
      reason: parsed.reason,
      // So the UI can say where each half came from, and never imply the model
      // produced the arithmetic.
      amounts_from: 'document text',
      labels_from: labelled ? 'ai' : 'none',
      // Never a silent 'none'. The lines are still usable unlabelled; the person
      // filling them in deserves to know the suggestion step failed and why.
      labels_error: labelled ? null : labelError,
      category_vocabulary: vocab.source,
    } });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/parse', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    // Pull the current signed-artist roster and lowercase-normalized
    // versions so we can:
    //   (a) hand the roster to Claude as context in the prompt so it
    //       prefers real artist names over social handles when they
    //       both appear in the invoice text ("services for @xyz —
    //       Nobody Serious" → artist should be "Nobody Serious", not
    //       "xyz").
    //   (b) post-parse-validate the returned artist / song to catch
    //       the classic influencer-invoice swap.
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
  "payment_method": one of ${JSON.stringify(PAYMENT_METHODS)} or null,
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

IMPORTANT: A document IS attached and you CAN read it. Read every visible field carefully and extract what you can — even if the scan is imperfect, low resolution, or photographed at an angle, do your best to OCR. Most invoices have at least a payee name, an amount, and a date — find them. Only leave a field null if that specific field is genuinely absent or unreadable, NOT because the whole document seems hard. NEVER claim "no document was attached" — one is. Return only the JSON object, no explanation.`;

    const result = await callClaude({
      prompt,
      buffer: req.file.buffer,
      filename: req.file.originalname,
      maxTokens: 512,
      parseJson: true,
      // Cache the document — a subsequent /validate-invoice + /extract-
      // invoice-number on the same file gets the cache read (10% of full
      // input price) instead of re-uploading. Matches the other two
      // endpoints on the parse triple-call.
      cacheDocument: true,
    });

    // Post-parse validation — catches the classic influencer-invoice
    // swap even when the prompt fails to prevent it. Two heuristics:
    //   (1) artist looks like a social handle (starts with @, or all-
    //       lowercase-no-spaces + underscore/period) AND song matches
    //       a known roster artist → swap them. Handle goes into
    //       suggest_socials.
    //   (2) any @handle mentions in the description → surfaced in
    //       suggest_socials so the client can prefill the socials step.
    const ai_warnings = [];
    let suggest_socials = [];
    if (result.ok && result.data) {
      const d = result.data;
      const looksLikeHandle = (s) => {
        const t = String(s || '').trim();
        if (!t) return false;
        if (t.startsWith('@')) return true;
        // All-lowercase, no spaces, has . or _, length 3-30 = handle-shape.
        return /^[a-z0-9._]{3,30}$/.test(t) && /[._]/.test(t);
      };
      const normArtist = (s) => String(s || '').toLowerCase().trim();

      const artistLooksHandle = looksLikeHandle(d.artist);
      const songMatchesRoster = d.song && rosterLower.has(normArtist(d.song).replace(/\s*[-–—/].*$/, '').trim())
                              || (d.song && rosterLower.has(normArtist(d.song)));

      if (artistLooksHandle && (songMatchesRoster || rosterLower.has(normArtist(d.song)))) {
        // Swap: promote song → artist, drop the handle.
        const stashedHandle = String(d.artist || '').replace(/^@/, '');
        // The song may be "Nobody Serious - No Sir" or just "Nobody
        // Serious". Try to split on the first dash/slash and treat the
        // left half as artist, right half as song.
        const rawSong = String(d.song || '').trim();
        const splitMatch = rawSong.match(/^\s*([^-–—/]+?)\s*[-–—/]\s*(.+)\s*$/);
        if (splitMatch && rosterLower.has(splitMatch[1].toLowerCase().trim())) {
          d.artist = splitMatch[1].trim();
          d.song   = splitMatch[2].trim();
        } else if (rosterLower.has(normArtist(rawSong))) {
          d.artist = rawSong;
          d.song   = null;
        }
        if (stashedHandle && !suggest_socials.some(s => s.handle === stashedHandle)) {
          suggest_socials.push({ platform: 'Instagram', handle: stashedHandle });
        }
        ai_warnings.push(
          `The scan initially misread a social-media handle as the artist. ` +
          `Fixed automatically — please verify the Artist / Song fields.`
        );
      } else if (artistLooksHandle) {
        // Couldn't safely swap, but flag it for the operator.
        ai_warnings.push(
          `Artist field looks like a social-media handle. Double-check that ` +
          `it's the artist being promoted, not the vendor's own handle.`
        );
      }

      // Extract any @handles from description so the socials step can
      // prefill even when we didn't swap.
      const descHandles = String(d.description || '').match(/@[A-Za-z0-9._]{3,30}/g) || [];
      for (const raw of descHandles) {
        const h = raw.replace(/^@/, '');
        if (!suggest_socials.some(s => s.handle === h)) {
          suggest_socials.push({ platform: 'Instagram', handle: h });
        }
      }
    }
    // Log every outcome (success, disabled, error) so a persistent "no
    // fields extracted" is debuggable from Railway logs. Includes a raw-
    // response snippet on non-ok so a JSON-parse regression / unexpected
    // model output is visible without needing a repro session.
    if (result.ok) {
      const filled = Object.entries(result.data || {}).filter(([, v]) => v != null && v !== '').length;
      console.log(`[parse] ${req.file.originalname} → ${filled} fields extracted`);
    } else if (result.disabled) {
      console.warn(`[parse] ${req.file.originalname} → AI DISABLED (${result.error})`);
    } else {
      console.warn(`[parse] ${req.file.originalname} → AI ERROR: ${result.error}`);
      if (result.raw) console.warn(`[parse] raw model output (first 500 chars): ${String(result.raw).slice(0, 500)}`);
    }

    // Include ai_status + ai_error so the client can distinguish
    // "AI not configured on this deploy" / "AI call failed" / "AI ran but
    // returned no fields" — otherwise every failure looks the same and
    // the user gets a generic "couldn't extract" toast.
    res.json({
      success: true,
      data: result.ok ? result.data : {},
      ai_status: result.disabled ? 'disabled' : (result.ok ? 'ok' : 'error'),
      ai_error: result.ok ? null : (result.error || null),
      // Non-fatal hints: warnings about likely mis-parses (e.g., handle
      // in the artist field) + any handles extracted from the invoice
      // that the client can prefill into the socials step.
      ai_warnings,
      suggest_socials,
    });
  } catch (err) {
    console.error('POST /api/bk/parse:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/suggest-vendor?q=... — fuzzy vendor name match
router.get('/suggest-vendor', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ success: true, data: [] });
  try {
    const { rows } = await pool.query(`
      SELECT payee AS name, COUNT(*) FILTER (WHERE parent_id IS NULL) AS invoice_count, SUM(amount) AS total_spent,
             MAX(vendor_email) AS email,
             MAX(vendor_address) AS address,
             MAX(vendor_bank) AS bank
      FROM expenses
      WHERE (deleted = false OR deleted IS NULL)
        AND status != 'rejected'
        AND payee IS NOT NULL AND payee != ''
        AND (LOWER(payee) LIKE $1 OR LOWER(vendor_name) LIKE $1)
        -- Creators are not vendors. This directory is DERIVED from expenses.payee,
        -- so without the filter every creator paid $40 on /bk/creators joins the
        -- 418 real vendors that carry W9s, payment terms and aliases. Creators
        -- have their own directory, where a PayPal handle and socials have a home.
        AND ${excludeCreatorRows('expenses')}
      GROUP BY payee
      ORDER BY COUNT(*) FILTER (WHERE parent_id IS NULL) DESC
      LIMIT 5
    `, [`%${q.toLowerCase()}%`]);
    res.json({ success: true, data: rows });
  } catch {
    res.json({ success: true, data: [] });
  }
});

// GET /api/bk/vendor-w9-status?payee=... — yes/no on whether the vendor (or
// any of their aliases) has a W9 on file. Used by the Add Invoice page to
// show a "W9 already on file" banner when the typed payee matches an
// existing vendor exactly. Lightweight: returns only the boolean + the
// entry id of the most recent W9 source, so the client can build a
// preview URL without pulling the full vendor detail.
router.get('/vendor-w9-status', async (req, res) => {
  const payee = (req.query.payee || '').trim();
  if (!payee) return res.json({ success: true, data: { has_w9: false, w9_entry_id: null } });
  try {
    const { rows } = await pool.query(
      `SELECT x.id, x.payee
         FROM expenses x
        WHERE ((x.w9_data IS NOT NULL AND x.w9_data != '') OR x.w9_r2_key IS NOT NULL)
          AND (x.deleted = false OR x.deleted IS NULL)
          AND x.status != 'rejected'
          AND (
            LOWER(TRIM(x.payee)) = LOWER(TRIM($1))
            OR LOWER(TRIM(x.payee)) IN (
              SELECT LOWER(TRIM(va.alias))        FROM vendor_aliases va WHERE LOWER(TRIM(va.primary_name)) = LOWER(TRIM($1))
              UNION
              SELECT LOWER(TRIM(va.primary_name)) FROM vendor_aliases va WHERE LOWER(TRIM(va.alias))        = LOWER(TRIM($1))
            )
          )
        ORDER BY x.id DESC
        LIMIT 1`,
      [payee]
    );
    if (!rows.length) return res.json({ success: true, data: { has_w9: false, w9_entry_id: null } });
    res.json({ success: true, data: { has_w9: true, w9_entry_id: rows[0].id, payee_on_file: rows[0].payee } });
  } catch (err) {
    res.json({ success: true, data: { has_w9: false, w9_entry_id: null } });
  }
});

// Expand a batch of vendor names to include every alias-linked partner,
// used by the multi-vendor W9 export queries (handoff / ledger-matching
// ZIPs). Single round-trip to vendor_aliases.
//
// Given a list of lowercased requestor names, returns:
//   searchList        — flat array of ALL names to search (requestors + all
//                       linked aliases). Feed to `LOWER(payee) = ANY($1)`.
//   requestorForName  — Map<foundLc, Set<requestorLc>>. When a row comes
//                       back with `payee = foundLc`, this tells you WHICH
//                       of the caller's original requestors it satisfies —
//                       so "vendors without W9" reports credit the alias
//                       to the spelling the caller asked about.
async function expandVendorAliases(pool, requestedLc) {
  const requestors = [...new Set(
    (Array.isArray(requestedLc) ? requestedLc : [...requestedLc])
      .map(s => String(s || '').trim().toLowerCase())
      .filter(Boolean)
  )];
  if (!requestors.length) return { searchList: [], requestorForName: new Map() };

  const expansion = new Map(); // requestorLc -> Set of names to search
  for (const r of requestors) expansion.set(r, new Set([r]));

  const { rows } = await pool.query(`
    SELECT LOWER(TRIM(primary_name)) AS primary_lc,
           LOWER(TRIM(alias))        AS alias_lc
      FROM vendor_aliases
     WHERE LOWER(TRIM(primary_name)) = ANY($1::text[])
        OR LOWER(TRIM(alias))        = ANY($1::text[])
  `, [requestors]);

  for (const { primary_lc, alias_lc } of rows) {
    if (expansion.has(primary_lc)) expansion.get(primary_lc).add(alias_lc);
    if (expansion.has(alias_lc))   expansion.get(alias_lc).add(primary_lc);
  }

  const searchListSet = new Set();
  const requestorForName = new Map();
  for (const [requestor, names] of expansion) {
    for (const n of names) {
      searchListSet.add(n);
      if (!requestorForName.has(n)) requestorForName.set(n, new Set());
      requestorForName.get(n).add(requestor);
    }
  }
  return { searchList: [...searchListSet], requestorForName };
}

// normalizeInvoiceNum is required from ../lib/normalize-invoice-num
// at the top of this file. Single source of truth so the routes here,
// /routes/vendor-submit, and the client mirror in utils.js can't drift.

// Shared duplicate-invoice lookup used by POST /entries and the batch
// endpoint. Catches the "INV-38468" vs "38468" case (and #003 vs 003,
// 00003 vs 3, etc.) by comparing the NORMALIZED invoice number against
// every existing one for the same payee or vendor email — alias-aware so
// a vendor can't re-submit the same invoice under a DBA to bypass dedup.
async function findDuplicateInvoice({ payee, vendor_email, invoice_number }) {
  const num = String(invoice_number || '').trim();
  if (!num) return null;
  const normalizedNew = normalizeInvoiceNum(num);
  // Index by either side of the vendor identity: payee (which is what
  // staff type in) or vendor_email (which is what the vendor portal
  // captures). One of the two reliably matches every entry created.
  const params = [];
  const orParts = [];
  if (payee) {
    params.push(payee);
    const p = `$${params.length}`;
    // Match the payee directly (payee column or vendor_name column) OR
    // through the vendor_aliases table — same DBA-resolving pattern the
    // rest of the codebase uses. Otherwise a vendor could re-submit
    // the same invoice under an alias to bypass the dedup gate.
    orParts.push(
      `LOWER(TRIM(e.payee)) = LOWER(TRIM(${p})) ` +
      `OR LOWER(TRIM(e.vendor_name)) = LOWER(TRIM(${p})) ` +
      `OR LOWER(TRIM(e.payee)) IN (` +
        `SELECT LOWER(TRIM(va.alias))        FROM vendor_aliases va WHERE LOWER(TRIM(va.primary_name)) = LOWER(TRIM(${p})) ` +
        `UNION ` +
        `SELECT LOWER(TRIM(va.primary_name)) FROM vendor_aliases va WHERE LOWER(TRIM(va.alias))        = LOWER(TRIM(${p}))` +
      `) ` +
      `OR LOWER(TRIM(e.vendor_name)) IN (` +
        `SELECT LOWER(TRIM(va.alias))        FROM vendor_aliases va WHERE LOWER(TRIM(va.primary_name)) = LOWER(TRIM(${p})) ` +
        `UNION ` +
        `SELECT LOWER(TRIM(va.primary_name)) FROM vendor_aliases va WHERE LOWER(TRIM(va.alias))        = LOWER(TRIM(${p}))` +
      `)`
    );
  }
  if (vendor_email) {
    params.push(vendor_email);
    orParts.push(`LOWER(e.vendor_email) = LOWER($${params.length})`);
  }
  if (!orParts.length) return null;
  // ── Answer with the INVOICE, not with whichever row happened to match ─────
  // A split invoice is a family: the parent keeps its own share in e.amount and
  // the rest live on child rows, and EVERY row carries the same invoice_number.
  // So this matched children as readily as parents and returned the first hit.
  //
  // Live example, 2026-08-31: invoice SR-PW-SEP-049 from Niche Societies is
  // $4,050.00 across 8 rows. Add Invoice reported "already exists as entry
  // #4440 — $700.00" — a middle child, one eighth of the invoice — and the
  // "Open existing entry" link went to that child rather than the invoice.
  //
  // Both halves are fixed here: resolve to the family ROOT, and report what the
  // family is WORTH. Same combined_amount shape /bk/approvals and /bk/bulk-deals
  // already use.
  const { rows } = await pool.query(
    `SELECT r.id, r.payee, r.invoice_number, r.invoice_date, r.currency, r.payment_status, r.status,
            e.invoice_number AS matched_invoice_number,
            (r.amount + COALESCE((SELECT SUM(c.amount) FROM expenses c
                WHERE c.parent_id = r.id AND (c.deleted = false OR c.deleted IS NULL)), 0)) AS amount,
            (SELECT COUNT(*)::int FROM expenses c
                WHERE c.parent_id = r.id AND (c.deleted = false OR c.deleted IS NULL)) AS child_rows
       FROM expenses e
       JOIN expenses r ON r.id = COALESCE(e.parent_id, e.id)
      WHERE (${orParts.join(' OR ')})
        AND e.invoice_number IS NOT NULL AND e.invoice_number != ''
        AND (e.deleted = false OR e.deleted IS NULL)
        AND (r.deleted = false OR r.deleted IS NULL)
        AND e.status != 'rejected'`,
    params
  );
  // Compare on the number of the row that MATCHED. A child carries the same
  // invoice number as its parent, so either side resolving to the same root is
  // the right answer — but the comparison must be against what was found.
  const hit = rows.find(r => normalizeInvoiceNum(r.matched_invoice_number) === normalizedNew);
  if (!hit) return null;
  const { matched_invoice_number, ...invoice } = hit;
  return invoice;
}

// GET /api/bk/check-dup?payee=...&invoice_number=...
router.get('/check-dup', async (req, res) => {
  const payee = (req.query.payee || '').trim();
  const num   = (req.query.invoice_number || '').trim();
  if (!payee || !num) return res.json({ duplicate: false, similar: [] });
  try {
    // Alias-aware vendor match — see findDuplicateInvoice above for the
    // pattern. Without the alias union, a DBA could bypass dedup.
    const vendorMatchClause = `(
      LOWER(TRIM(e.payee)) = LOWER(TRIM($1))
      OR LOWER(TRIM(e.vendor_name)) = LOWER(TRIM($1))
      OR LOWER(TRIM(e.payee)) IN (
        SELECT LOWER(TRIM(va.alias))        FROM vendor_aliases va WHERE LOWER(TRIM(va.primary_name)) = LOWER(TRIM($1))
        UNION
        SELECT LOWER(TRIM(va.primary_name)) FROM vendor_aliases va WHERE LOWER(TRIM(va.alias))        = LOWER(TRIM($1))
      )
      OR LOWER(TRIM(e.vendor_name)) IN (
        SELECT LOWER(TRIM(va.alias))        FROM vendor_aliases va WHERE LOWER(TRIM(va.primary_name)) = LOWER(TRIM($1))
        UNION
        SELECT LOWER(TRIM(va.primary_name)) FROM vendor_aliases va WHERE LOWER(TRIM(va.alias))        = LOWER(TRIM($1))
      )
    )`;

    // ── The invoice is the FAMILY, not the row that matched ──────────────────
    // A split invoice puts its share on the parent and the rest on children, and
    // every row carries the same invoice_number — so a bare lookup with LIMIT 1
    // returned an arbitrary family member. Live, 2026-08-31: SR-PW-SEP-049 from
    // Niche Societies is $4,050.00 over 8 rows, and this reported "entry #4440 —
    // $700.00", a middle child, with the Open link pointing at it.
    //
    // Resolving through COALESCE(e.parent_id, e.id) makes every row of a family
    // answer with the same root, so LIMIT 1 stops being a lottery.
    const FAMILY = `
       FROM expenses e
       JOIN expenses r ON r.id = COALESCE(e.parent_id, e.id)`;
    const FAMILY_COLS = `
              r.id, r.invoice_date, r.payment_status, r.invoice_number, r.status,
              (r.amount + COALESCE((SELECT SUM(c.amount) FROM expenses c
                  WHERE c.parent_id = r.id AND (c.deleted = false OR c.deleted IS NULL)), 0)) AS amount,
              (SELECT COUNT(*)::int FROM expenses c
                  WHERE c.parent_id = r.id AND (c.deleted = false OR c.deleted IS NULL)) AS child_rows`;
    const FAMILY_LIVE = `
         AND (e.deleted = false OR e.deleted IS NULL)
         AND (r.deleted = false OR r.deleted IS NULL)
         AND e.status != 'rejected'`;

    // Exact match
    const { rows: exact } = await pool.query(
      // `status` matters as much as the amount here. This query deliberately
      // includes PENDING entries — an invoice awaiting approval is still a
      // duplicate — but the warning that renders it linked to the LEDGER, which
      // only shows approved rows. John, 2026-08-18: "this invoice apparently
      // exists on file but won't show up in the ledger." Entry 1659 was pending;
      // 24 entries are. Returning the status lets the warning say WHERE it is.
      `SELECT ${FAMILY_COLS} ${FAMILY}
       WHERE ${vendorMatchClause}
         AND LOWER(e.invoice_number)=LOWER($2)
         ${FAMILY_LIVE}
       LIMIT 1`,
      [payee, num]
    );

    if (exact.length > 0) {
      return res.json({ duplicate: true, entry: exact[0], similar: [] });
    }

    // Similar match — find all invoice numbers for this vendor and compare normalized forms
    const { rows: vendorInvoices } = await pool.query(
      `SELECT ${FAMILY_COLS}, e.invoice_number AS matched_invoice_number ${FAMILY}
       WHERE ${vendorMatchClause}
         AND e.invoice_number IS NOT NULL AND e.invoice_number != ''
         ${FAMILY_LIVE}`,
      [payee]
    );

    const normalizedInput = normalizeInvoiceNum(num);
    const seenRoots = new Set();
    const similar = vendorInvoices.filter(inv => {
      // Compare on the number of the row that MATCHED, then de-duplicate by
      // ROOT — otherwise an 8-row split family lists the same invoice 8 times.
      const matched = inv.matched_invoice_number || inv.invoice_number;
      const normalizedExisting = normalizeInvoiceNum(matched);
      if (normalizedExisting !== normalizedInput) return false;
      if (String(matched).toLowerCase() === num.toLowerCase()) return false;
      if (seenRoots.has(inv.id)) return false;
      seenRoots.add(inv.id);
      return true;
    }).map(({ matched_invoice_number, ...rest }) => rest);

    res.json({ duplicate: false, similar });
  } catch {
    res.json({ duplicate: false, similar: [] });
  }
});

// ── Expense receipts (multiple per entry, stored in entity_files) ────────────

// POST /api/bk/entries/:id/receipts
router.post('/entries/:id/receipts', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    const sanitized = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storedFilename = `${Date.now()}-${sanitized}`;
    const r2Key = `entity_files/expense_receipt/${req.params.id}/${storedFilename}`;
    await uploadFile(r2Key, req.file.buffer, req.file.mimetype);
    const { rows } = await pool.query(
      `INSERT INTO entity_files (entity_type, entity_id, filename, original_name, file_size, uploaded_by, r2_key, mime_type)
       VALUES ('expense_receipt', $1, $2, $3, $4, $5, $6, $7)
       RETURNING id, filename, original_name, file_size, uploaded_at`,
      [req.params.id, storedFilename, req.file.originalname, req.file.size, req.user?.id || null, r2Key, req.file.mimetype]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/entries/:id/receipts
router.get('/entries/:id/receipts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, filename, original_name, file_size, uploaded_at
       FROM entity_files
       WHERE entity_type = 'expense_receipt' AND entity_id = $1
       ORDER BY uploaded_at DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/entries/:id/receipts/:fileId — serve the file
router.get('/entries/:id/receipts/:fileId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r2_key, file_data, mime_type, original_name FROM entity_files
       WHERE id = $1 AND entity_type = 'expense_receipt' AND entity_id = $2`,
      [req.params.fileId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'File not found' });
    const buf = await loadFileBuffer(rows[0].r2_key, rows[0].file_data);
    if (!buf) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Type', rows[0].mime_type || 'application/pdf');
    const asciiName = (rows[0].original_name || 'receipt').replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Disposition', `inline; filename="${asciiName}"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/bk/entries/:id/receipts/:fileId
router.delete('/entries/:id/receipts/:fileId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM entity_files WHERE id = $1 AND entity_type = 'expense_receipt' AND entity_id = $2 RETURNING id, r2_key`,
      [req.params.fileId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'File not found' });
    if (rows[0].r2_key) {
      deleteFile(rows[0].r2_key).catch(err => console.warn('R2 delete failed:', err.message));
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/parse-proof  (multipart: file)
// AI scans proof of payment to extract payment date and method
router.post('/parse-proof', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    const prompt = `You are extracting payment information from a proof of payment document (bank statement, receipt, transfer confirmation, check image, etc.). Analyze this document and return ONLY valid JSON:
{
  "payment_date": "YYYY-MM-DD or null — the date the payment was made/processed",
  "payment_method": one of ${JSON.stringify(PAYMENT_METHODS)} or null,
  "amount": number (no currency symbols) or null,
  "reference_number": "transaction/confirmation/check number or null",
  "payee": "who was paid or null"
}
Look for: transaction date, payment date, processed date, check date, transfer date, statement date. Prefer the actual payment/transaction date over statement dates. Return only JSON.`;

    const result = await callClaude({
      prompt,
      buffer: req.file.buffer,
      filename: req.file.originalname,
      maxTokens: 512,
      parseJson: true,
    });
    if (!result.ok && result.error) console.warn('AI parse-proof:', result.error);

    res.json({ success: true, data: result.ok ? result.data : {} });
  } catch (err) {
    console.error('POST /api/bk/parse-proof:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Vendors ───────────────────────────────────────────────────────────────────

// GET /api/bk/vendors
// GET /api/bk/vendors/unified — one row per COMPANY: the ledger vendor
// directory enriched with bank-statement aggregates, joined through the
// payee map (explicit links authoritative), aliases, and name equality.
// Bank groups with no identity land in `unlinked` — a finishable queue.
// GET /api/bk/artist-names — every name an artist picker should offer.
//
// The pickers used to read /artists, which is the SIGNED ROSTER: 50 names.
// `expenses.artist` is free text and holds 107 distinct names, so 99 of the
// artists with spend — $828,380, including Jerri at $133,961, Oxis, Laszewo,
// Tyler Henry — could not be picked at all. You had to retype the name, which
// is precisely how a fourth spelling of an existing artist gets created.
//
// So: the roster UNION the names already in the ledger, deduped
// case-insensitively with the ROSTER's spelling winning — it is the one a
// person maintains, and "bradeazy" in the ledger should not outvote "Bradeazy"
// on the roster.
//
// Placeholders are excluded. "N/A", "Unknown", "TBD" are in the ledger because
// somebody had to type something; offering them back turns a non-answer into a
// suggestion. Same list the P&L uses to keep them out of Spend by Artist.
const ARTIST_PLACEHOLDERS = new Set([
  'na', 'nan', 'none', 'null', 'unassigned', 'tbd', 'tba',
  'various', 'variousartists', 'misc', 'miscellaneous', 'other', 'general',
]);
router.get('/artist-names', async (req, res) => {
  try {
    // isAdmin here IS the bookkeeping gate (Admin | Superadmin | Approver) —
    // the name isBkAdmin belongs to the statements router.
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const [{ rows: roster }, { rows: used }] = await Promise.all([
      pool.query(`SELECT name FROM artists WHERE COALESCE(TRIM(name), '') <> '' ORDER BY name`),
      pool.query(`
        SELECT DISTINCT TRIM(artist) AS name FROM expenses
         WHERE COALESCE(TRIM(artist), '') <> ''
           AND (deleted = false OR deleted IS NULL)`),
    ]);
    const key = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    // EVERY roster name is offered, even when two of them normalize alike —
    // ".ashade" and "Ashade", "Buppy" and another Buppy are two rows somebody
    // deliberately keeps, and a picker that silently drops one of them is the
    // complaint that started this. The key set exists only to suppress LEDGER
    // spellings of a name the roster already has.
    const out = [];
    const seenExact = new Set();
    const rosterKeys = new Set();
    for (const r of roster) {
      const name = String(r.name || '').trim();
      const k = key(name);
      if (!k || ARTIST_PLACEHOLDERS.has(k) || seenExact.has(name.toLowerCase())) continue;
      seenExact.add(name.toLowerCase());
      rosterKeys.add(k);
      out.push({ name, on_roster: true });
    }
    for (const r of used) {
      const name = String(r.name || '').trim();
      const k = key(name);
      if (!k || ARTIST_PLACEHOLDERS.has(k) || rosterKeys.has(k) || seenExact.has(name.toLowerCase())) continue;
      seenExact.add(name.toLowerCase());
      // Ledger spellings still dedupe against each other, so "Bradeazy" and
      // "bradeazy" are one entry rather than two.
      rosterKeys.add(k);
      out.push({ name, on_roster: false });
    }
    const names = out
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    res.json({
      success: true,
      data: {
        names: names.map((n) => n.name),
        // Disclosed so a caller can say where a name came from rather than
        // implying the roster is the whole story.
        roster_count: names.filter((n) => n.on_roster).length,
        ledger_only_count: names.filter((n) => !n.on_roster).length,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/vendors/unified', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: ledger } = await pool.query(`
      WITH inv AS (
        SELECT e.payee, e.parent_id, e.amount, e.invoice_date, e.vendor_email,
               -- The BOOLEAN, not the blob. w9_data is one of the four multi-MB
               -- base64 TEXT columns EXPENSE_LIGHT_COLS exists to keep out of
               -- list queries; projecting it through a CTE would risk carrying
               -- every W9 in the ledger through this aggregate.
               ((e.w9_data IS NOT NULL AND e.w9_data != '') OR e.w9_r2_key IS NOT NULL) AS has_w9,
               -- Does a bank line owe this invoice? Evaluated ONCE per row here
               -- rather than inside two aggregate FILTERs, which would run the
               -- helper's subqueries four times over every ledger row.
               --
               -- noBankEvidenceSql and NOT a fresh predicate: it is already the
               -- test behind the Flags paid-no-match count and
               -- /bk/payments?bank=unverified, and it is funding-pair aware. A
               -- hand-rolled "is there a debit for this?" reports every
               -- PayPal-funded invoice as unattached, because the match lives on
               -- the PayPal leg while the BofA pull that funded it is dismissed.
               (${noBankEvidenceSql('e')}) AS owed_a_bank_line
          FROM expenses e
         WHERE (e.deleted = false OR e.deleted IS NULL)
           AND (e.voided = false OR e.voided IS NULL)
           AND e.payee IS NOT NULL AND e.payee != ''
           AND e.status = 'approved'
           -- Creators are not vendors — same rule as GET /vendors above.
           AND ${excludeCreatorRows('e')}
      )
      SELECT
        payee,
        -- Families, not rows: a split invoice is ONE invoice. Counting
        -- children inflated this against the detail page's roll-up.
        COUNT(*) FILTER (WHERE parent_id IS NULL)::int AS invoice_count,
        -- The matching work available on this vendor's own page. FAMILIES only,
        -- on the same basis as invoice_count and as what the vendor page lists —
        -- a split settles as one debit, so counting children would promise more
        -- work than exists.
        COUNT(*) FILTER (WHERE parent_id IS NULL AND owed_a_bank_line)::int AS to_attach,
        COALESCE(SUM(amount) FILTER (WHERE parent_id IS NULL AND owed_a_bank_line), 0) AS to_attach_total,
        COALESCE(SUM(amount), 0) AS total_spent,
        MAX(invoice_date) AS last_invoice,
        BOOL_OR(has_w9) AS w9_on_file,
        MAX(vendor_email) AS vendor_email,
        (SELECT STRING_AGG(va.alias, ', ') FROM vendor_aliases va WHERE LOWER(va.primary_name) = LOWER(payee)) AS aliases
      FROM inv
      GROUP BY payee`);
    // Alias resolution via the shared index, NOT a local Map. The version this
    // replaces was
    //   new Map(aliasRows.map(a => [a.alias.toLowerCase(), a.primary_name]))
    // which is one-hop and last-write-wins — the fifth ad-hoc copy that
    // lib/vendor-aliases.js exists to eliminate. Its header documents why that
    // shape is wrong: 48 of 193 alias rows have an alias that is itself a
    // primary_name, so A→B→C resolves to B and stops. canonical() is
    // transitive, cycle-safe, and applies the isNoiseAlias guard that keeps
    // "Inc" from bridging two unrelated companies.
    const aliasIdx = await loadAliasIndex(pool);

    const bankGroups = await require('./statements').aggregateBankVendors();

    const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
    const byKey = new Map(); // lower payee -> unified row
    for (const v of ledger) {
      byKey.set(v.payee.toLowerCase().trim(), {
        name: v.payee,
        invoices: v.invoice_count,
        // Invoices this vendor has that a bank line should settle and none does —
        // the count the vendor page's matcher works through, on the same
        // definition (noBankEvidenceSql, families only) so the directory and the
        // page cannot report different numbers for the same vendor.
        to_attach: v.to_attach,
        to_attach_total: Math.round(Number(v.to_attach_total) * 100) / 100,
        invoice_total: Math.round(Number(v.total_spent) * 100) / 100,
        last_invoice: iso(v.last_invoice),
        w9_on_file: v.w9_on_file,
        vendor_email: v.vendor_email,
        aliases: v.aliases,
        bank: null,
      });
    }
    // Resolve each bank group to a company: explicit link → alias → exact
    // name; inference from matches attaches but is marked unconfirmed.
    //
    // Every candidate is resolved through the alias index first, so a name that
    // has been merged away lands on the company it was merged INTO. That is the
    // whole fix for ghost rows: `statement_payee_map` keeps naming the losing
    // side of an old merge (merge used to leave it untouched), and the loop used
    // to trust that dead name over the alias the merge had just recorded.
    const unlinked = [];
    // A name only deserves a company row of its own if nothing else claims it.
    const resolvesElsewhere = (name) => {
      const c = aliasIdx.canonical(name);
      return c !== String(name || '').trim().toLowerCase();
    };
    // Exact name → canonical name → ANY member of the alias class that is a real
    // ledger vendor. The third step matters: canonical() picks the member that
    // was most often a primary_name, which is not necessarily the member holding
    // the invoices. Without it a group could resolve to a canonical name with no
    // expenses, miss byKey, and fall through to the Unlinked section — moving
    // bank money out of the directory instead of onto the right company.
    const lookupCompany = (name) => {
      if (!name) return null;
      const exact = byKey.get(String(name).toLowerCase().trim());
      if (exact) return exact;
      const canon = byKey.get(aliasIdx.canonical(name));
      if (canon) return canon;
      const cls = aliasIdx.groups.get(aliasIdx.canonical(name));
      if (cls) for (const member of cls) { const m = byKey.get(member); if (m) return m; }
      return null;
    };
    for (const g of bankGroups) {
      const candidates = [
        { name: g.linked_vendor, inferred: false },
        { name: g.name, inferred: false },
        { name: g.ledger_vendor, inferred: true },
      ];
      let row = null, inferred = false;
      for (const c of candidates) {
        if (!c.name) continue;
        const hit = lookupCompany(c.name);
        if (hit) { row = hit; inferred = c.inferred; break; }
        // An explicit link to a company with no approved entries YET is still a
        // company — six of these are real (a vendor linked before its first
        // invoice landed). But if the linked name is an alias of something, it
        // is not a company, it is the losing side of a merge, and synthesizing
        // a row for it resurrects the row the merge was meant to remove.
        if (!c.inferred && c.name === g.linked_vendor && !resolvesElsewhere(c.name)) {
          // A bank-only company: bank activity, no invoices of its own yet. Its
          // `to_attach` is 0 rather than absent — the same key on every row, so a
          // consumer never has to distinguish "no work" from "field missing".
          row = { name: c.name, invoices: 0, invoice_total: 0, to_attach: 0, to_attach_total: 0,
            last_invoice: null, w9_on_file: false, vendor_email: null, aliases: null, bank: null };
          byKey.set(c.name.toLowerCase().trim(), row);
          break;
        }
      }
      if (!row) {
        unlinked.push({ key: g.key, name: g.name, txns: g.txns, total: g.total,
          open_n: g.open_n, open_total: g.open_total,
          needs_n: g.needs_n || 0, needs_total: g.needs_total || 0,
          needs_artist_n: g.needs_artist_n || 0, needs_artist_total: g.needs_artist_total || 0,
          last_seen: g.last_seen });
        continue;
      }
      if (!row.bank) {
        row.bank = { txns: 0, total: 0, open_n: 0, open_total: 0, needs_n: 0, needs_total: 0,
          needs_artist_n: 0, needs_artist_total: 0,
          last_seen: null, learned_category: null, payees: [], inferred };
      }
      row.bank.txns += g.txns;
      row.bank.total = Math.round((row.bank.total + g.total) * 100) / 100;
      row.bank.open_n += g.open_n;
      row.bank.open_total = Math.round((row.bank.open_total + g.open_total) * 100) / 100;
      // Summed across every bank payee in this company's alias group, so TONE /
      // TONE PAY INC / Tone Pay, Inc report one number rather than three.
      row.bank.needs_n += (g.needs_n || 0);
      row.bank.needs_total = Math.round((row.bank.needs_total + (g.needs_total || 0)) * 100) / 100;
      // Booked lines naming no artist, summed the same way across the group.
      row.bank.needs_artist_n += (g.needs_artist_n || 0);
      row.bank.needs_artist_total = Math.round((row.bank.needs_artist_total + (g.needs_artist_total || 0)) * 100) / 100;
      if (!row.bank.last_seen || (g.last_seen && g.last_seen > row.bank.last_seen)) row.bank.last_seen = g.last_seen;
      if (!row.bank.learned_category) row.bank.learned_category = g.learned_category || g.top_category;
      row.bank.payees.push(g.name);
      row.bank.inferred = row.bank.inferred && inferred;
    }
    const vendors = [...byKey.values()].map((r) => ({
      ...r,
      last_activity: [r.last_invoice, r.bank?.last_seen].filter(Boolean).sort().pop() || null,
      // Relationship $ for the default sort: ledger spend + bank money not
      // yet represented in the ledger (open). Matched/booked bank dollars
      // already live in invoice_total — adding full bank total would
      // double-count.
      relationship: Math.round((Number(r.invoice_total) + Number(r.bank?.open_total || 0)) * 100) / 100,
    })).sort((a, b) => b.relationship - a.relationship);
    unlinked.sort((a, b) => b.total - a.total);
    res.json({ success: true, data: { vendors, unlinked } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/vendors', async (req, res) => {
  try {
    // This directory is DERIVED from expenses, so scoping it means scoping the
    // rows it derives from — otherwise the vendor list, its invoice counts and
    // its totals describe spend the reader is not allowed to see, which is the
    // same disclosure in aggregate form. TRUE for the three bookkeeping roles,
    // so their view is byte-identical to before.
    const vendorParams = [];
    const vendorRepBlock = userVisibleRepsClause(req.user, vendorParams, null) || 'TRUE';
    const { rows } = await pool.query(`
      SELECT
        payee,
        -- Families, not rows — see the note in /vendors/unified.
        COUNT(*) FILTER (WHERE status = 'approved' AND parent_id IS NULL) AS invoice_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0) AS total_spent,
        COALESCE(SUM(amount) FILTER (WHERE status = 'approved' AND (currency IS NULL OR UPPER(currency) = 'USD')), 0) AS total_spent_usd,
        COUNT(DISTINCT UPPER(COALESCE(currency, 'USD'))) AS currency_count,
        MAX(invoice_date) FILTER (WHERE status = 'approved') AS last_invoice,
        BOOL_OR((w9_data IS NOT NULL AND w9_data != '') OR w9_r2_key IS NOT NULL) AS w9_on_file,
        MAX(vendor_email) AS vendor_email,
        MAX((w9_scan->>'w9_name')::text) AS w9_name,
        MAX((w9_scan->>'w9_business_name')::text) AS w9_business_name,
        (SELECT COUNT(*) FROM vendor_aliases va WHERE LOWER(va.primary_name) = LOWER(payee))::int AS alias_count,
        (SELECT STRING_AGG(va.alias, ', ') FROM vendor_aliases va WHERE LOWER(va.primary_name) = LOWER(payee)) AS aliases
      FROM expenses
      WHERE (deleted = false OR deleted IS NULL)
        AND (voided = false OR voided IS NULL)
        AND payee IS NOT NULL AND payee != ''
        AND status = 'approved'
        AND ${vendorRepBlock}
        -- Creators are not vendors. This directory is DERIVED from expenses.payee,
        -- so without the filter every creator paid $40 on /bk/creators joins the
        -- 418 real vendors that carry W9s, payment terms and aliases. Creators
        -- have their own directory, where a PayPal handle and socials have a home.
        AND ${excludeCreatorRows('expenses')}
      GROUP BY payee
      ORDER BY total_spent DESC
    `, vendorParams);
    // Flag name mismatches — smart about middle names, initials, formatting
    function namesMatch(a, b) {
      if (!a || !b) return false;
      const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
      const na = norm(a), nb = norm(b);
      // Exact match after normalization
      if (na === nb) return true;
      // Substring containment (handles "LLC" additions etc.)
      const stripped = (s) => s.replace(/\s/g, '');
      if (stripped(na).includes(stripped(nb)) || stripped(nb).includes(stripped(na))) return true;
      // Split into words and compare first + last name, tolerating middle name differences
      const wa = na.split(' ').filter(Boolean);
      const wb = nb.split(' ').filter(Boolean);
      if (wa.length >= 2 && wb.length >= 2) {
        const firstMatch = wa[0] === wb[0];
        const lastMatch = wa[wa.length - 1] === wb[wb.length - 1];
        if (firstMatch && lastMatch) {
          // First and last name match — middle name differences are OK
          // Also check if middle initial matches full middle name
          return true;
        }
      }
      return false;
    }

    const data = rows.map(v => {
      let w9_mismatch = false;
      if (v.w9_on_file && v.w9_name) {
        const matchesLine1 = namesMatch(v.payee, v.w9_name);
        const matchesLine2 = v.w9_business_name && namesMatch(v.payee, v.w9_business_name);
        w9_mismatch = !matchesLine1 && !matchesLine2;
      }
      return { ...v, w9_mismatch };
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/vendors/scan-w9s — batch scan W9s to extract names and flag mismatches
router.post('/vendors/scan-w9s', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ success: false, error: 'ANTHROPIC_API_KEY not set' });

    // Find vendors with W9 data but no w9_scan (only IDs, not file data — load one at a time)
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (payee) id, payee, w9_filename
      FROM expenses
      WHERE ((w9_data IS NOT NULL AND w9_data != '') OR w9_r2_key IS NOT NULL)
        AND (w9_scan IS NULL)
        AND (deleted = false OR deleted IS NULL)
        AND status = 'approved'
      ORDER BY payee, id DESC
      LIMIT 10
    `);

    if (rows.length === 0) return res.json({ success: true, data: { scanned: 0, remaining: 0 } });

    let scanned = 0;
    const prompt = 'Extract the legal name (line 1) and business name (line 2, if different) from this W-9 or W-8 form. Return ONLY valid JSON: { "w9_name": "name on line 1", "w9_business_name": "line 2 or null", "form_type": "W-9" or "W-8BEN" or "unknown" }';

    for (const row of rows) {
      try {
        // Load W9 content one at a time (R2 or legacy base64) to avoid memory issues
        const { rows: fileRows } = await pool.query(
          'SELECT w9_data, w9_r2_key FROM expenses WHERE id = $1',
          [row.id]
        );
        if (!fileRows.length) continue;
        const w9Data = await loadFileBase64(fileRows[0].w9_r2_key, fileRows[0].w9_data);
        if (!w9Data) continue;

        const result = await callClaude({
          prompt,
          base64: w9Data,
          filename: row.w9_filename || '',
          maxTokens: 256,
          parseJson: true,
        });
        const parsed = result.ok ? result.data : { w9_name: null };

        // Store on ALL entries for this payee that have W9 data
        await pool.query(
          `UPDATE expenses SET w9_scan = $1 WHERE LOWER(payee) = LOWER($2) AND ((w9_data IS NOT NULL AND w9_data != '') OR w9_r2_key IS NOT NULL)`,
          [JSON.stringify(parsed), row.payee]
        );
        scanned++;
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.error(`W9 scan failed for ${row.payee}:`, err.message);
      }
    }

    // Count remaining
    const { rows: remaining } = await pool.query(`
      SELECT COUNT(DISTINCT payee) AS n FROM expenses
      WHERE ((w9_data IS NOT NULL AND w9_data != '') OR w9_r2_key IS NOT NULL)
        AND w9_scan IS NULL
        AND (deleted = false OR deleted IS NULL) AND status = 'approved'
    `);

    res.json({ success: true, data: { scanned, remaining: parseInt(remaining[0].n) } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/vendors/scan-w9-tax — read the TIN and line 3 off the W-9s.
//
// A SECOND pass over documents the app already has, and the reason it is not
// folded into /vendors/scan-w9s is that that endpoint's work is done: it fills
// `w9_scan` and skips anything that has one. Reusing it would have meant either
// re-reading 299 forms that already have a name on file, or bolting a second
// "unless it is missing the new fields" condition onto a query whose skip rule
// is the thing that makes it resumable.
//
// Batched at 10 a call and resumable on `remaining`, exactly like its
// neighbour: 299 vendors is 299 Claude calls, the client drives it in a loop,
// and a browser tab closing mid-run costs the current batch and nothing else.
//
// Writes across the WHOLE payee — every row of theirs that carries a W-9 — so
// the fields resolve the same way `w9_by_payee` and lib/w9-owner already
// resolve the document itself. A vendor's TIN is a fact about the vendor, and
// storing it on one arbitrary invoice of theirs would make it a fact about
// whichever row got scanned.
router.post('/vendors/scan-w9-tax', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ success: false, error: 'ANTHROPIC_API_KEY not set' });
    // No key, no storage — the same refusal lib/payment-crypto makes for bank
    // details, for the same reason: the alternative is an SSN in plain text in
    // a column whose name says it is encrypted. Loud beats silent.
    if (!paymentCrypto.isConfigured()) {
      return res.status(503).json({ success: false,
        error: 'PAYMENT_DETAILS_KEY is not set, so a TIN cannot be stored encrypted. Refusing to store one in plain text.' });
    }

    const force = req.query.force === '1';
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (LOWER(TRIM(payee))) id, payee, w9_filename
        FROM expenses
       WHERE ((w9_data IS NOT NULL AND w9_data != '') OR w9_r2_key IS NOT NULL)
         AND (deleted = false OR deleted IS NULL)
         AND status = 'approved'
         ${force ? '' : 'AND w9_tax_scanned_at IS NULL'}
       ORDER BY LOWER(TRIM(payee)), id DESC
       LIMIT 10`);

    const results = [];
    for (const row of rows) {
      try {
        const { rows: fileRows } = await pool.query(
          'SELECT w9_data, w9_r2_key FROM expenses WHERE id = $1', [row.id]);
        const w9Data = fileRows.length ? await loadFileBase64(fileRows[0].w9_r2_key, fileRows[0].w9_data) : null;
        if (!w9Data) { results.push({ payee: row.payee, ok: false, reason: 'the W-9 file could not be loaded' }); continue; }

        const ai = await callClaude({
          prompt: W9_TAX_PROMPT, base64: w9Data, filename: row.w9_filename || '',
          maxTokens: 512, parseJson: true,
        });
        if (!ai.ok) { results.push({ payee: row.payee, ok: false, reason: ai.reason || 'the form could not be read' }); continue; }
        const parsed = parseW9Tax(ai.data);

        // Written through the shared writer, which is also what a submission, an
        // upload and a rescan use — so a TIN read here is stored identically to
        // one read anywhere else. It always stamps `w9_tax_scanned_at`, which is
        // what makes this batch terminate: an unreadable form is answered ("the
        // form does not say") rather than handed back on the next call forever.
        const stored = await storeW9Tax({
          payee: row.payee, parsed, entryId: row.id,
          userName: req.user?.name || 'scan', audit: logBkAction,
        });

        results.push({ payee: row.payee, ok: true, tin_last4: parsed.tin_last4,
          tin_type: parsed.tin_type, tax_classification: parsed.tax_classification,
          form_type: parsed.form_type, issues: parsed.issues, rows: stored.rows });
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        console.error(`[w9-tax] ${row.payee}:`, err.message);
        results.push({ payee: row.payee, ok: false, reason: err.message });
      }
    }

    const { rows: left } = await pool.query(`
      SELECT COUNT(DISTINCT LOWER(TRIM(payee)))::int AS n FROM expenses
       WHERE ((w9_data IS NOT NULL AND w9_data != '') OR w9_r2_key IS NOT NULL)
         AND w9_tax_scanned_at IS NULL
         AND (deleted = false OR deleted IS NULL) AND status = 'approved'`);

    res.json({ success: true, data: { scanned: results.filter((r) => r.ok).length, results, remaining: left[0].n } });
  } catch (err) {
    console.error('POST /api/bk/vendors/scan-w9-tax:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/vendors/:payee/tin — the full TIN, once, on purpose.
//
// Mirrors /vendors/:payee/payment-details: admin only, decrypts, and writes an
// audit row PER READ. A filing needs the whole number, so there has to be one
// way to get it; making that way leave a trace is what keeps it from becoming
// the way everything gets it.
router.get('/vendors/:payee/tin', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Bookkeeping access required' });
    const payee = String(req.params.payee || '').trim();
    if (!payee) return res.status(400).json({ success: false, error: 'payee required' });
    const { rows } = await pool.query(
      `SELECT w9_tin_enc, w9_tin_last4, w9_tin_type, w9_tax_classification
         FROM expenses
        WHERE LOWER(TRIM(payee)) = LOWER(TRIM($1)) AND w9_tin_enc IS NOT NULL
          AND (deleted = false OR deleted IS NULL)
        ORDER BY w9_tax_scanned_at DESC NULLS LAST LIMIT 1`, [payee]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'No TIN on file for this vendor' });
    let tin = null;
    try { tin = paymentCrypto.decrypt(rows[0].w9_tin_enc); }
    catch (e) { return res.status(500).json({ success: false, error: `The stored TIN could not be decrypted: ${e.message}` }); }
    await logBkAction(req.user, 'w9_tin_viewed', null, payee, null, null, null,
      `Full TIN read for ${payee} (••${rows[0].w9_tin_last4})`).catch(() => {});
    res.json({ success: true, data: {
      tin, tin_type: rows[0].w9_tin_type, last4: rows[0].w9_tin_last4,
      tax_classification: rows[0].w9_tax_classification } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/1099/export?year=2026[&include_tin=1]
//
// The filing itself, as a workbook an accountant or a filing service can use.
// /bk/1099 computes the numbers; until now there was nothing to hand anybody.
//
// FOUR SHEETS, because a 1099 run is four different questions and a single flat
// sheet answers none of them well:
//
//   Filing          one row per vendor per FORM — a vendor who was paid rent and
//                   fees gets two, because that is two forms. NEC box 1 and MISC
//                   box 1 are different filings, and guessing one box per vendor
//                   is how rent ends up reported as nonemployee compensation.
//   1096 Summary    the per-form totals a 1096 transmittal needs, plus the
//                   count. This is the number that has to tie to the ledger.
//   Needs attention every reportable vendor missing a TIN, an address or a W-9.
//                   The chase list, in the same workbook, so "who do I email"
//                   is not a separate export.
//   Excluded        who was left out and WHY — corporations, foreign payees,
//                   reimbursements. An exclusion nobody can see is
//                   indistinguishable from an omission.
//
// TINs are MASKED by default. `include_tin=1` writes the full number, requires
// strict admin, and logs an audit row naming the row count — because that file
// is a spreadsheet of social security numbers and its existence should be a
// deliberate act with a trace, not the default shape of a download.
router.get('/1099/export', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const wantTin = req.query.include_tin === '1';
    if (wantTin && !['Admin', 'Superadmin'].includes(req.user?.role)) {
      return res.status(403).json({ success: false,
        error: 'Full TINs are Admin/Superadmin only. Re-run the export without include_tin for the masked version.' });
    }

    const { data, meta } = await compute1099(year);
    const reportable = data.filter((v) => v.needs_1099 && !v.exempt);
    const excluded = data.filter((v) => v.needs_1099 && v.exempt);

    // Decrypt only what the requested file actually needs, and only for the
    // vendors going ON it.
    const tins = new Map();
    if (wantTin && reportable.length) {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (LOWER(TRIM(payee))) payee, w9_tin_enc
           FROM expenses
          WHERE w9_tin_enc IS NOT NULL AND (deleted = false OR deleted IS NULL)
          ORDER BY LOWER(TRIM(payee)), w9_tax_scanned_at DESC NULLS LAST`);
      for (const r of rows) {
        try { tins.set(String(r.payee).trim().toLowerCase(), paymentCrypto.decrypt(r.w9_tin_enc)); }
        catch { /* a value that will not decrypt is reported as missing below */ }
      }
    }

    // Which form a category belongs on. Rent is 1099-MISC box 1; everything
    // else a label pays a contractor is 1099-NEC box 1. Gross proceeds to an
    // attorney are MISC box 10 and are NOT auto-assigned here — that depends on
    // whether the payment was fees or a settlement, which the category cannot
    // say, so legal spend lands on NEC with a note for a human.
    const formFor = (category) => {
      const c = String(category || '').toLowerCase();
      if (/rent/.test(c)) return { form: '1099-MISC', box: 'Box 1 — Rents' };
      if (/royalt/.test(c)) return { form: '1099-MISC', box: 'Box 2 — Royalties' };
      if (/legal|attorney/.test(c)) return { form: '1099-NEC', box: 'Box 1 — Nonemployee comp (check if gross proceeds → MISC box 10)' };
      return { form: '1099-NEC', box: 'Box 1 — Nonemployee compensation' };
    };

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Market Street Dashboard';

    // ── Filing ──
    const ws = wb.addWorksheet('Filing');
    ws.columns = [
      { header: 'Form', key: 'form', width: 12 },
      { header: 'Box', key: 'box', width: 46 },
      { header: 'Recipient name', key: 'payee', width: 30 },
      { header: 'TIN', key: 'tin', width: 16 },
      { header: 'TIN type', key: 'tin_type', width: 10 },
      { header: 'Tax classification', key: 'cls', width: 24 },
      { header: 'Address', key: 'address', width: 40 },
      { header: 'Email', key: 'email', width: 28 },
      { header: 'Amount (USD)', key: 'amount', width: 15 },
      { header: 'Category', key: 'category', width: 24 },
      { header: 'Missing for filing', key: 'missing', width: 34 },
    ];
    let rowsWritten = 0;
    for (const v of reportable) {
      const full = tins.get(v.payee.toLowerCase()) || null;
      // Either kind of TIN clears this — an EIN and an SSN are the same field.
      // "read but not stored" is called out separately: a row showing ••1234
      // that still cannot be filed needs to say why, not just "TIN".
      const missing = [
        v.has_tin ? null : (v.tin_last4 ? 'TIN read but NOT STORED (no encryption key)' : 'TIN'),
        v.address ? null : 'address',
        v.w9_on_file ? null : 'W-9',
        v.entity_type_known ? null : 'tax classification',
      ].filter(Boolean);
      // ONE ROW PER FORM. A vendor paid rent and fees is two filings, and
      // collapsing them to their total would file the whole sum in one box.
      const byForm = new Map();
      for (const [category, amount] of Object.entries(v.categories || {})) {
        const f = formFor(category);
        const k = `${f.form}|${f.box}`;
        if (!byForm.has(k)) byForm.set(k, { ...f, amount: 0, categories: [] });
        const e = byForm.get(k);
        e.amount += amount;
        e.categories.push(category);
      }
      // A vendor with a total but no category breakdown still gets a row —
      // dropping them would take money out of a filing to keep a sheet tidy.
      if (!byForm.size) byForm.set('1099-NEC|', { form: '1099-NEC', box: 'Box 1 — Nonemployee compensation', amount: v.total, categories: ['(uncategorised)'] });
      for (const e of byForm.values()) {
        ws.addRow({
          form: e.form, box: e.box, payee: v.payee,
          tin: wantTin ? (full || '') : (v.tin_last4 ? `•••••${v.tin_last4}` : ''),
          tin_type: v.tin_type || '', cls: v.tax_classification || '',
          address: v.address || '', email: v.vendor_email || '',
          amount: Math.round(e.amount * 100) / 100,
          category: e.categories.join(', '),
          missing: missing.join(', '),
        });
        rowsWritten += 1;
      }
    }
    ws.getRow(1).font = { bold: true };
    ws.getColumn('amount').numFmt = '#,##0.00';

    // ── 1096 Summary ──
    const sum = wb.addWorksheet('1096 Summary');
    sum.columns = [
      { header: 'Form', key: 'form', width: 14 },
      { header: 'Recipients', key: 'n', width: 12 },
      { header: 'Total (USD)', key: 'total', width: 16 },
    ];
    const perForm = new Map();
    ws.eachRow((row, i) => {
      if (i === 1) return;
      const form = row.getCell('form').value;
      const amt = Number(row.getCell('amount').value) || 0;
      const name = row.getCell('payee').value;
      if (!perForm.has(form)) perForm.set(form, { total: 0, names: new Set() });
      perForm.get(form).total += amt;
      perForm.get(form).names.add(name);
    });
    for (const [form, f] of perForm) {
      sum.addRow({ form, n: f.names.size, total: Math.round(f.total * 100) / 100 });
    }
    sum.addRow({});
    sum.addRow({ form: 'Basis', n: '', total: meta.basis });
    sum.addRow({ form: 'Threshold', n: '', total: `$${meta.threshold} — ${meta.threshold_note}` });
    sum.addRow({ form: 'Excluded', n: meta.exempt_count, total: `$${meta.exempt_total} — see the Excluded sheet` });
    sum.addRow({ form: 'Cannot file yet', n: meta.unfilable_count, total: `$${meta.unfilable_total} — see Needs attention` });
    sum.getRow(1).font = { bold: true };
    sum.getColumn('total').numFmt = '#,##0.00';

    // ── Needs attention ──
    const chase = wb.addWorksheet('Needs attention');
    chase.columns = [
      { header: 'Recipient', key: 'payee', width: 30 },
      { header: 'Total (USD)', key: 'total', width: 14 },
      { header: 'Email', key: 'email', width: 28 },
      { header: 'W-9 on file', key: 'w9', width: 12 },
      { header: 'TIN', key: 'tin', width: 10 },
      { header: 'Address', key: 'address', width: 10 },
      { header: 'Tax classification', key: 'cls', width: 20 },
      { header: 'What to ask for', key: 'ask', width: 44 },
    ];
    for (const v of reportable) {
      const missing = [
        v.w9_on_file ? null : 'a W-9',
        v.has_tin ? null : (v.tin_last4 ? 'nothing from them — their TIN was read but not stored, set PAYMENT_DETAILS_KEY and re-scan' : 'their TIN'),
        v.address ? null : 'a mailing address',
        v.entity_type_known ? null : 'their tax classification (W-9 line 3)',
      ].filter(Boolean);
      if (!missing.length) continue;
      chase.addRow({
        payee: v.payee, total: v.total, email: v.vendor_email || '',
        w9: v.w9_on_file ? 'yes' : 'NO', tin: v.has_tin ? 'yes' : 'NO',
        address: v.address ? 'yes' : 'NO', cls: v.tax_classification || '—',
        ask: missing.join(', '),
      });
    }
    chase.getRow(1).font = { bold: true };
    chase.getColumn('total').numFmt = '#,##0.00';

    // ── Excluded ──
    const exs = wb.addWorksheet('Excluded');
    exs.columns = [
      { header: 'Recipient', key: 'payee', width: 30 },
      { header: 'Total (USD)', key: 'total', width: 14 },
      { header: 'Tax classification', key: 'cls', width: 24 },
      { header: 'Why it is excluded', key: 'why', width: 76 },
    ];
    for (const v of excluded) {
      exs.addRow({ payee: v.payee, total: v.total, cls: v.tax_classification || '—', why: v.exempt_reason || '' });
    }
    // Corporations that stay IN because of what they were paid for. Listed on
    // this sheet on purpose: somebody scanning it for "why is this vendor not
    // excluded" should find the answer here rather than conclude it was missed.
    for (const v of reportable.filter((x) => x.exempt_code === 'corp_but_reportable')) {
      exs.addRow({ payee: v.payee, total: v.total, cls: v.tax_classification || '—',
        why: `NOT excluded — ${v.exempt_reason}` });
    }
    exs.getRow(1).font = { bold: true };
    exs.getColumn('total').numFmt = '#,##0.00';

    await logBkAction(req.user, '1099_exported', null, null, null, null, null,
      `${year} 1099 workbook: ${rowsWritten} filing row(s) over ${reportable.length} recipient(s), `
      + `${meta.exempt_count} excluded, ${meta.unfilable_count} not yet filable`
      + (wantTin ? ` — WITH FULL TINs (${tins.size} decrypted)` : ' — TINs masked')).catch(() => {});

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="1099-${year}${wantTin ? '-with-TINs' : '-masked'}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('GET /api/bk/1099/export:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/bk/vendors/rename — rename a vendor across all their expenses
router.put('/vendors/rename', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { oldName, newName } = req.body;
    if (!oldName || !newName) return res.status(400).json({ success: false, error: 'oldName and newName required' });

    const { rowCount } = await pool.query(
      `UPDATE expenses SET payee = $1 WHERE LOWER(TRIM(payee)) = LOWER(TRIM($2)) AND (deleted = false OR deleted IS NULL)`,
      [newName.trim(), oldName.trim()]
    );
    // Also update vendor_name if it matches
    await pool.query(
      `UPDATE expenses SET vendor_name = $1 WHERE LOWER(TRIM(vendor_name)) = LOWER(TRIM($2)) AND (deleted = false OR deleted IS NULL)`,
      [newName.trim(), oldName.trim()]
    ).catch(() => {});

    // Carry saved vendor emails to the new name. Drop any that would
    // collide with an address already saved under the new name first, so
    // the case-insensitive unique index can't reject the rename.
    await pool.query(
      `DELETE FROM vendor_emails ve
        WHERE LOWER(TRIM(ve.vendor_name)) = LOWER(TRIM($2))
          AND EXISTS (SELECT 1 FROM vendor_emails t
                       WHERE LOWER(TRIM(t.vendor_name)) = LOWER(TRIM($1))
                         AND LOWER(t.email) = LOWER(ve.email))`,
      [newName.trim(), oldName.trim()]
    ).catch(() => {});
    await pool.query(
      `UPDATE vendor_emails SET vendor_name = $1 WHERE LOWER(TRIM(vendor_name)) = LOWER(TRIM($2))`,
      [newName.trim(), oldName.trim()]
    ).catch(() => {});

    await logBkAction(req.user, 'vendor_renamed', null, oldName, 'payee', oldName, newName.trim(), `${rowCount} entries updated`);

    res.json({ success: true, updated: rowCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/vendors/aliases/:payee — get all aliases for a vendor
// GET /api/bk/vendors/added-expenses
// The invoice-less side of the vendor world: expenses born on the
// Recoupments / Artist Campaigns add modals (entry_source set). Because
// there's no invoice number to dedupe against, this endpoint does the
// tracking the normal vendor flow gets for free:
//   - per-payee aggregation with NORMALIZED keys (lowercase, strip
//     non-alphanumerics) so "Hello and Help" / "helloandhelp" collapse
//   - potential duplicate ENTRIES: same normalized payee + same amount
//     + same currency within a 7-day window
//   - spelling-variant groups that probably want a vendor merge
// Registered ABOVE /vendors/:payee so the param route can't swallow it.
router.get('/vendors/added-expenses', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, payee, artist, song, amount, currency,
             COALESCE(invoice_date, created_at::date) AS spent_date,
             payment_status, entry_source, created_at
        FROM expenses
       WHERE entry_source IN ('recoupments', 'artist_campaigns')
         AND (deleted = false OR deleted IS NULL)
         AND (voided = false OR voided IS NULL)
       ORDER BY id DESC
    `);

    const normKey = (p) => String(p || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const byKey = new Map();
    for (const r of rows) {
      const key = normKey(r.payee) || '__none__';
      if (!byKey.has(key)) {
        byKey.set(key, { key, spellings: {}, items: [], totals: {}, artists: new Set(), last_date: null });
      }
      const b = byKey.get(key);
      const spelled = String(r.payee || '').trim() || '(no payee)';
      b.spellings[spelled] = (b.spellings[spelled] || 0) + 1;
      b.items.push(r);
      const cur = (r.currency || 'USD').toUpperCase();
      b.totals[cur] = (b.totals[cur] || 0) + Number(r.amount || 0);
      if (r.artist && String(r.artist).trim()) b.artists.add(String(r.artist).trim());
      const d = r.spent_date ? String(r.spent_date).slice(0, 10) : null;
      if (d && (!b.last_date || d > b.last_date)) b.last_date = d;
    }

    // Duplicate-entry candidates within each payee bucket: same amount +
    // currency within 7 days. Pairwise inside a bucket (buckets are small).
    const dupePairs = [];
    const dayMs = 86400000;
    for (const b of byKey.values()) {
      const items = b.items;
      for (let i = 0; i < items.length && dupePairs.length < 100; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i], c = items[j];
          if (Number(a.amount) !== Number(c.amount)) continue;
          if ((a.currency || 'USD').toUpperCase() !== (c.currency || 'USD').toUpperCase()) continue;
          const da = a.spent_date ? new Date(a.spent_date).getTime() : null;
          const dc = c.spent_date ? new Date(c.spent_date).getTime() : null;
          if (da == null || dc == null || Math.abs(da - dc) > 7 * dayMs) continue;
          dupePairs.push({
            payee: Object.entries(b.spellings).sort((x, y) => y[1] - x[1])[0][0],
            amount: Number(a.amount),
            currency: (a.currency || 'USD').toUpperCase(),
            a: { id: a.id, artist: a.artist, song: a.song, date: a.spent_date },
            b: { id: c.id, artist: c.artist, song: c.song, date: c.spent_date },
          });
        }
      }
    }

    const vendors = [...byKey.values()].map(b => ({
      key: b.key,
      payee: Object.entries(b.spellings).sort((x, y) => y[1] - x[1])[0][0],
      spellings: Object.keys(b.spellings),
      count: b.items.length,
      totals: b.totals,
      artists: [...b.artists].sort(),
      last_date: b.last_date,
    }));

    // Spelling-variant groups — same normalized key, 2+ raw spellings.
    // These want a vendor rename/merge so totals stop fragmenting.
    const nameVariants = vendors
      .filter(v => v.spellings.length > 1)
      .map(v => ({ payee: v.payee, spellings: v.spellings, count: v.count }));

    res.json({ success: true, data: { vendors, dupePairs, nameVariants } });
  } catch (err) {
    console.error('GET /api/bk/vendors/added-expenses:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/vendors/aliases/:payee', async (req, res) => {
  try {
    const payee = decodeURIComponent(req.params.payee);
    const { rows } = await pool.query(
      `SELECT * FROM vendor_aliases WHERE LOWER(primary_name) = LOWER($1) ORDER BY alias ASC`,
      [payee]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/vendors/:payee/w9 — upload or replace the vendor's W9
//
// Vendors don't have their own table; the W9 lives on whichever expense row
// the w9_entry_id subquery surfaces for the payee (the highest-id expense
// with a W9). To swap it, we pick the highest-id active expense for this
// payee and write the new W9 there — because id > any prior holder, that
// row becomes the canonical W9 record going forward.
router.post('/vendors/:payee/w9', upload.single('file'), async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    const payee = decodeURIComponent(req.params.payee);

    const { rows: target } = await pool.query(
      `SELECT id, payee FROM expenses
        WHERE LOWER(TRIM(payee)) = LOWER(TRIM($1))
          AND (deleted = false OR deleted IS NULL)
        ORDER BY id DESC
        LIMIT 1`,
      [payee]
    );
    if (!target.length) return res.status(404).json({ success: false, error: 'Vendor has no expenses' });
    const entryId = target[0].id;
    const filename = req.file.originalname;
    const sanitized = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const r2Key = `vendors/${entryId}/w9/${Date.now()}_${sanitized}`;
    const mime = sniffMime(req.file.buffer) || req.file.mimetype || 'application/octet-stream';

    await uploadFile(r2Key, req.file.buffer, mime);
    await pool.query(
      `UPDATE expenses SET w9_r2_key = $1, w9_filename = $2, w9_scan = NULL WHERE id = $3`,
      [r2Key, filename, entryId]
    );

    await logBkAction(req.user, 'w9_uploaded', entryId, target[0].payee, null, null, null, filename);

    res.json({ success: true, data: { entry_id: entryId, filename, r2_key: r2Key } });
  } catch (err) {
    console.error('POST /api/bk/vendors/:payee/w9:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Vendor saved emails ─────────────────────────────────────────────────
// Extra addresses per vendor (accounting@, manager, etc.). Stored in
// vendor_emails keyed by payee name (alias-aware on read). They default
// into the CC line of payment-confirmation emails.

// GET /api/bk/vendors/emails/:payee — list saved emails (walks aliases)
router.get('/vendors/emails/:payee', async (req, res) => {
  try {
    const payee = decodeURIComponent(req.params.payee);
    const rows = await getVendorEmailRows(payee);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/vendors/emails — { payee, email, label? }
router.post('/vendors/emails', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const payee = String(req.body?.payee || '').trim();
    const email = String(req.body?.email || '').trim();
    const label = String(req.body?.label || '').trim() || null;
    if (!payee || !email) return res.status(400).json({ success: false, error: 'payee and email required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email address' });
    }
    // Store under the canonical primary name when the payee is an alias, so
    // the address follows the vendor through renames/merges.
    const { rows: asAlias } = await pool.query(
      'SELECT primary_name FROM vendor_aliases WHERE LOWER(alias) = LOWER($1)', [payee]
    );
    const canonical = asAlias.length ? asAlias[0].primary_name : payee;
    const { rows } = await pool.query(
      `INSERT INTO vendor_emails (vendor_name, email, label, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [canonical, email, label, req.user.name]
    );
    await logBkAction(req.user, 'vendor_email_added', null, canonical, null, null, null, `Saved email: ${email}${label ? ` (${label})` : ''}`);
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, error: 'That email is already saved for this vendor' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/bk/vendors/emails/:id — remove a saved email
router.delete('/vendors/emails/:id', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows } = await pool.query('DELETE FROM vendor_emails WHERE id = $1 RETURNING vendor_name, email', [req.params.id]);
    if (rows.length) {
      await logBkAction(req.user, 'vendor_email_removed', null, rows[0].vendor_name, null, null, null, `Removed email: ${rows[0].email}`);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/vendors/aliases — add an alias for a vendor
router.post('/vendors/aliases', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { primary_name, alias } = req.body;
    if (!primary_name || !alias) return res.status(400).json({ success: false, error: 'primary_name and alias required' });
    // A bare corporate suffix identifies no vendor. Production already holds
    // rows aliasing "Inc", "LLC" and "I", and because UNIQUE(alias) is
    // case-sensitive those exist several times over pointing at DIFFERENT
    // vendors — so resolving transitively they bridge unrelated companies.
    // Refuse at the door rather than filtering forever downstream.
    if (isNoiseAlias(alias)) {
      return res.status(400).json({ success: false,
        error: `"${String(alias).trim()}" is too generic to be an alias — it would link unrelated vendors.` });
    }

    // Check if alias already exists
    const { rows: existing } = await pool.query(
      'SELECT id, primary_name FROM vendor_aliases WHERE LOWER(alias) = LOWER($1)', [alias.trim()]
    );
    if (existing.length > 0) {
      if (existing[0].primary_name.toLowerCase() === primary_name.trim().toLowerCase()) {
        return res.json({ success: true, data: existing[0] });
      }
      // Reassign the alias to the new vendor
      await pool.query('UPDATE vendor_aliases SET primary_name = $1 WHERE id = $2', [primary_name.trim(), existing[0].id]);
      await logBkAction(req.user, 'vendor_alias_reassigned', null, primary_name, null, existing[0].primary_name, primary_name.trim(), `Reassigned alias "${alias}" from "${existing[0].primary_name}"`);
      return res.json({ success: true, data: { ...existing[0], primary_name: primary_name.trim() }, reassigned: true });
    }

    const { rows } = await pool.query(
      `INSERT INTO vendor_aliases (primary_name, alias, created_by) VALUES ($1, $2, $3) RETURNING *`,
      [primary_name.trim(), alias.trim(), req.user.name]
    );
    await logBkAction(req.user, 'vendor_alias_added', null, primary_name, null, null, null, `Added alias: ${alias}`);
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/bk/vendors/aliases/:id — remove an alias
router.delete('/vendors/aliases/:id', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    await pool.query('DELETE FROM vendor_aliases WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/vendor-duplicates — likely duplicate vendors with a merge
// recommendation. Same-normalized names score 100; fuzzy pairs come from
// vendorsMatch (suffix-strip, parentheticals, token overlap). Intentional
// alias pairs and acknowledged not-duplicates are skipped.
// The EXACT tier (norm-equal = pure case/punctuation/whitespace variants)
// auto-merges into the highest-volume spelling — no human judgment needed
// there. Throttled per process; acked pairs are respected.
let vdAutoLast = 0;
let vdAutoInFlight = false;
router.get('/vendor-duplicates', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    // Detector-only scoring, in its own module. lib/vendorMatch.js is SHARED
    // with the bank matcher (statements.js:615 is its name-evidence tier) and
    // the ledger-diff reconciliation, and the two jobs want opposite error
    // trade-offs: a wrong MATCH writes a silent false payment record, while a
    // wrong SUGGESTION costs one "not duplicates" click. So the loosening that
    // makes this detector useful must not reach that file.
    const { candidatePairs, scorePair } = require('../lib/vendorDuplicates');
    const fetchVendors = async () => (await pool.query(`
      SELECT TRIM(payee) AS payee, COUNT(*)::int AS n, COALESCE(SUM(amount), 0) AS total
        FROM expenses
       WHERE payee IS NOT NULL AND TRIM(payee) <> ''
         AND (deleted = false OR deleted IS NULL)
       GROUP BY TRIM(payee)`)).rows;
    let vendors = await fetchVendors();
    const { rows: aliasRows } = await pool.query(`SELECT primary_name, alias FROM vendor_aliases`).catch(() => ({ rows: [] }));
    const aliasPair = new Set(aliasRows
      .filter((a) => a.primary_name && a.alias)
      .map((a) => [a.primary_name.toLowerCase().trim(), a.alias.toLowerCase().trim()].sort().join('||')));
    const { rows: acks } = await pool.query(
      `SELECT fingerprint FROM statement_flag_acks WHERE fingerprint LIKE 'vdup:%'`).catch(() => ({ rows: [] }));
    const acked = new Set(acks.map((r) => r.fingerprint));

    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

    // Auto-merge the exact tier: group by non-empty norm; merge every
    // variant into the highest-volume spelling (skipping user-acked pairs).
    let autoMerged = 0;
    if (!vdAutoInFlight && Date.now() - vdAutoLast > 10 * 60 * 1000) {
      vdAutoInFlight = true;
      vdAutoLast = Date.now();
      try {
        const byNorm = new Map();
        for (const v of vendors) {
          const k = norm(v.payee);
          if (!k) continue;
          if (!byNorm.has(k)) byNorm.set(k, []);
          byNorm.get(k).push(v);
        }
        for (const list of byNorm.values()) {
          if (list.length < 2) continue;
          const target = list.reduce((a, b) => (b.n > a.n ? b : a));
          for (const v of list) {
            if (v === target) continue;
            const pairKey = [v.payee.toLowerCase(), target.payee.toLowerCase()].sort().join('||');
            if (acked.has('vdup:' + pairKey) || aliasPair.has(pairKey)) continue;
            await pool.query(
              `UPDATE expenses SET payee = $1 WHERE LOWER(TRIM(payee)) = LOWER(TRIM($2)) AND (deleted = false OR deleted IS NULL)`,
              [target.payee, v.payee]);
            await pool.query(
              `UPDATE expenses SET vendor_name = $1 WHERE LOWER(TRIM(vendor_name)) = LOWER(TRIM($2)) AND (deleted = false OR deleted IS NULL)`,
              [target.payee, v.payee]).catch(() => {});
            // Never record a suffix-only loser as an alias. This path runs
            // UNATTENDED on a GET, so anything it writes wrong compounds silently.
            if (!isNoiseAlias(v.payee)) {
              await pool.query(
                `INSERT INTO vendor_aliases (primary_name, alias, created_by) VALUES ($1, $2, $3)
                 ON CONFLICT (alias) DO NOTHING`,
                [target.payee, v.payee, req.user.name]).catch(() => {});
            }
            try {
              await logBkAction(req.user, 'vendor_auto_merged', null, target.payee, null, v.payee, target.payee,
                `Auto-merged formatting variant "${v.payee}" into "${target.payee}"`);
            } catch { /* audit best-effort */ }
            autoMerged++;
          }
        }
        if (autoMerged > 0) vendors = await fetchVendors();
      } finally { vdAutoInFlight = false; }
    }

    // ── Candidate pairs, then scoring — both from lib/vendorDuplicates ───────
    //
    // This used to bucket the pairwise scan by the first letter of the
    // normalised name, which meant two names starting with DIFFERENT letters
    // were never compared. Measured on the live 874 names: 60 pairs the scorer
    // already matches were hidden by that alone, including every
    // "PURCHASE <VENDOR> <CITY>" descriptor and the case that prompted this —
    // "Kate Stephenson" against "Zelle payment to Kate Stephenson for…", which
    // scores 0.88. The blocking was the only reason nobody was asked.
    //
    // Blocking is now "shares a distinctive token", which is what actually makes
    // two vendor names candidates: ~1,500 pairs in ~15ms rather than 381k
    // unblocked, with no structural blind spot.
    const pairIdx = candidatePairs(vendors);
    const groups = [];
    for (const [i, j] of pairIdx) {
      const A = vendors[i], B = vendors[j];
      const pairKey = [A.payee.toLowerCase(), B.payee.toLowerCase()].sort().join('||');
      if (aliasPair.has(pairKey)) continue;
      const fp = 'vdup:' + pairKey;
      if (acked.has(fp)) continue;
      const hit = scorePair(A.payee, B.payee);
      if (!hit) continue;
      const recommended = A.n >= B.n ? A.payee : B.payee;
      groups.push({
        fingerprint: fp, score: hit.score, reason: hit.reason, tier: hit.tier, recommended,
        vendors: [A, B].map((v) => ({ payee: v.payee, invoices: v.n, total: Math.round(Number(v.total) * 100) / 100 })),
      });
    }
    // Confident pairs first, weak ones last, money as the tiebreak within a tier.
    // The weak tier exists so a mid-word overlap is DEMOTED rather than dropped:
    // a hard filter would have hidden "LAWRENCE H. KATZ, P." against "Law
    // Offices of Lawrence H. Katz, P.C." (four live rows, one firm). In a list a
    // human reviews, ordering is the tool and exclusion throws the answer away.
    const TIER_RANK = { exact: 0, strong: 1, weak: 2 };
    groups.sort((a, b) => (TIER_RANK[a.tier] ?? 3) - (TIER_RANK[b.tier] ?? 3)
      || b.score - a.score
      || (b.vendors[0].total + b.vendors[1].total) - (a.vendors[0].total + a.vendors[1].total));
    res.json({ success: true, data: groups.slice(0, 200), auto_merged: autoMerged });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/vendor-duplicates/ack — "not duplicates": persist the pair's
// fingerprint so the Vendor Flags page never re-suggests it. Lives here
// (not under /statements) so Approvers — full bookkeeping access — can use
// it without loosening the statements-only ack endpoint.
router.post('/vendor-duplicates/ack', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const fp = String(req.body.fingerprint || '').slice(0, 500);
    if (!fp.startsWith('vdup:')) return res.status(400).json({ success: false, error: 'fingerprint required' });
    await pool.query(
      `INSERT INTO statement_flag_acks (fingerprint, created_by) VALUES ($1, $2)
       ON CONFLICT (fingerprint) DO NOTHING`, [fp, req.user.name]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/bk/vendor-duplicates/ack — put a dismissed pair back.
//
// Mirrors the POST above, in this file and with the same `isAdmin` gate, for the
// reason the POST's own comment gives: Approvers have full bookkeeping access and
// dismiss pairs, but /statements/flags/ack is isStrictAdmin. With only that one,
// an Approver could mark a pair "not duplicates" in the review deck and then be
// refused when they pressed Undo — a deck offering an action it cannot perform.
//
// Accepts the fingerprint on the query string as well as the body: a DELETE with
// a body is awkward for some clients, and the deck sends a query param.
router.delete('/vendor-duplicates/ack', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const fp = String(req.body?.fingerprint || req.query.fingerprint || '').slice(0, 500);
    if (!fp.startsWith('vdup:')) return res.status(400).json({ success: false, error: 'fingerprint required' });
    const { rowCount } = await pool.query(
      `DELETE FROM statement_flag_acks WHERE fingerprint = $1`, [fp]);
    res.json({ success: true, restored: rowCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Merge two vendors: rename the source's rows to the target, repoint the bank
// links, record the alias — and record WHAT IT TOUCHED so it can be undone.
//
// Extracted from the route because the deck, the Vendors page, the unified
// vendors page and Vendor Flags all merge, and every one of them should produce
// an undoable merge rather than only the newest caller.
async function mergeVendors({ source, target, user }) {
  // The whole user object, not just a name: logBkAction reads `.id` off it, and
  // the extracted version was about to start writing audit rows with a null
  // user_id that the inline route had always filled in.
  const userName = typeof user === 'string' ? user : (user?.name || null);
  const src = String(source).trim();
  const tgt = String(target).trim();

  // RETURNING id on each write, so the undo can address exactly the rows this
  // merge moved. Without that the reverse has to go by NAME, which would drag
  // rows that always belonged to the target back to a name they never had.
  const { rows: renamed } = await pool.query(
    `UPDATE expenses SET payee = $1
      WHERE LOWER(TRIM(payee)) = LOWER(TRIM($2)) AND (deleted = false OR deleted IS NULL)
      RETURNING id`,
    [tgt, src]
  );
  const { rows: renamedVendorName } = await pool.query(
    `UPDATE expenses SET vendor_name = $1
      WHERE LOWER(TRIM(vendor_name)) = LOWER(TRIM($2)) AND (deleted = false OR deleted IS NULL)
      RETURNING id`,
    [tgt, src]
  ).catch(() => ({ rows: [] }));

  // Bank money has to follow the company. `statement_payee_map` maps a bank
  // payee to a LEDGER VENDOR NAME, and this used to leave it pointing at the name
  // it had just merged away — so the Vendors directory kept synthesizing a
  // company row for the dead name, complete with its bank total, and the merge
  // looked like it had done nothing. Repointing here is what makes a merge stick.
  //
  // Same statement routes/statements.js uses when the bank-payee cleanup sweep
  // renames a vendor, including the .catch(): a missing table must never fail the
  // merge itself, which has already committed the rename above.
  let payeeMapIds = [];
  try {
    const r = await pool.query(
      `UPDATE statement_payee_map SET ledger_payee = $1
        WHERE LOWER(TRIM(ledger_payee)) = LOWER(TRIM($2)) RETURNING id`,
      [tgt, src]);
    payeeMapIds = r.rows.map((x) => x.id);
  } catch { /* advisory — the rename is what matters */ }

  // Add source as an alias for target (so we remember the merge).
  // Same guard as the auto path — a merge whose losing name is a bare suffix must
  // still rename the rows, but must not record the alias: "Inc" as an alias links
  // every company that ends in Inc.
  //
  // RETURNING id, and ON CONFLICT DO NOTHING means an ALREADY-EXISTING alias
  // returns no row. That distinction is load-bearing: the undo may only delete an
  // alias this merge actually created, or undoing a re-merge would erase a
  // relationship somebody recorded earlier.
  let aliasInserted = false;
  if (!isNoiseAlias(src)) {
    const ins = await pool.query(
      `INSERT INTO vendor_aliases (primary_name, alias, created_by) VALUES ($1, $2, $3)
       ON CONFLICT (alias) DO NOTHING RETURNING id`,
      [tgt, src, userName]
    ).catch(() => ({ rows: [] }));
    aliasInserted = ins.rows.length > 0;
  }

  const expenseIds = renamed.map((r) => r.id);
  const vendorNameIds = renamedVendorName.map((r) => r.id);

  // The log must NEVER be able to fail the merge.
  //
  // runMigrations() runs in the BACKGROUND after app.listen, so for the first
  // seconds of every deploy this table does not exist — and unlike the read-side
  // degradations elsewhere in this codebase, the write here IS the user's action.
  // A merge that 500s because its audit row could not be written would be the
  // feature eating the work. So: best-effort, and a null logId travels back to
  // the caller, which reads it as "this one cannot be undone" and says so.
  let logId = null;
  try {
    const { rows: [log] } = await pool.query(
      `INSERT INTO vendor_merge_log
         (source, target, expense_ids, vendor_name_ids, payee_map_ids, alias_inserted, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [src, tgt, expenseIds, vendorNameIds, payeeMapIds, aliasInserted, userName]);
    logId = log?.id ?? null;
  } catch { /* the merge stands; it just cannot be reversed from the UI */ }

  // Both counts, because a merge that moved 0 invoices but repointed 4 bank links
  // did real work — reporting only `merged: 0` is exactly why merging a bank-only
  // name read as a no-op.
  await logBkAction(user, 'vendor_merged', null, src, null, src, tgt,
    `Merged ${src} into ${tgt} (${expenseIds.length} entries, ${payeeMapIds.length} bank link${payeeMapIds.length === 1 ? '' : 's'})`);

  return { merged: expenseIds.length, relinked: payeeMapIds.length, logId };
}

// POST /api/bk/vendors/merge — merge two vendors (renames source to target and adds alias)
router.post('/vendors/merge', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { source, target } = req.body;
    if (!source || !target) return res.status(400).json({ success: false, error: 'source and target vendor names required' });
    if (String(source).trim().toLowerCase() === String(target).trim().toLowerCase()) {
      return res.status(400).json({ success: false, error: 'source and target are the same vendor' });
    }
    const out = await mergeVendors({ source, target, user: req.user });
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/vendors/merges?vendor=NAME — the merges this vendor was made of.
//
// vendor_merge_log has recorded every merge by ID since it was added, and the
// only way to reach an undo was the button on the duplicate deck, in the seconds
// after merging. A day later there was nothing: the alias in "Also known as" is
// the only visible trace, and DELETING that alias removes the trace while
// leaving the merge in place — the entries stay renamed, so the old vendor
// simply vanishes. That is what happened to "jacob allen".
//
// So the merges are listed on the vendor itself, with what each one moved, and
// undone ones stay visible rather than disappearing from the record.
router.get('/vendors/merges', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const vendor = String(req.query.vendor || '').trim();
    if (!vendor) return res.status(400).json({ success: false, error: 'vendor required' });
    const { rows } = await pool.query(`
      SELECT id, source, target, alias_inserted, created_by, created_at, undone_at, undone_by,
             COALESCE(array_length(expense_ids, 1), 0) AS entries,
             COALESCE(array_length(payee_map_ids, 1), 0) AS bank_links
        FROM vendor_merge_log
       WHERE LOWER(TRIM(target)) = LOWER(TRIM($1)) OR LOWER(TRIM(source)) = LOWER(TRIM($1))
       ORDER BY created_at DESC`, [vendor]).catch(() => ({ rows: [] }));
    res.json({
      success: true,
      data: {
        merges: rows.map((r) => ({ ...r, direction: String(r.target).toLowerCase().trim() === vendor.toLowerCase().trim() ? 'into' : 'out_of' })),
        // Said plainly, because "no merges listed" has two very different
        // meanings: nothing was ever merged, or it happened before this log
        // existed and cannot be undone by machine.
        logged_since: '2026-08-16',
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/vendors/unmerge/:logId — put a merge back, row by row.
//
// The reverse is only safe BY ID. Going by name would rewrite every row now
// called by the target name back to the source, including rows that were always
// the target's — which is the whole reason vendor_merge_log exists.
router.post('/vendors/unmerge/:logId(\\d+)', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows: [log] } = await pool.query(
      `SELECT * FROM vendor_merge_log WHERE id = $1`, [req.params.logId]);
    if (!log) return res.status(404).json({ success: false, error: 'No record of that merge — it cannot be undone automatically.' });
    if (log.undone_at) {
      return res.status(409).json({ success: false, error: 'That merge has already been undone.' });
    }

    const back = async (sql, ids) => {
      if (!ids || !ids.length) return 0;
      const r = await pool.query(sql, [log.source, ids]).catch(() => ({ rowCount: 0 }));
      return r.rowCount || 0;
    };
    const restored = await back(
      `UPDATE expenses SET payee = $1 WHERE id = ANY($2::int[])`, log.expense_ids);
    await back(
      `UPDATE expenses SET vendor_name = $1 WHERE id = ANY($2::int[])`, log.vendor_name_ids);
    const relinked = await back(
      `UPDATE statement_payee_map SET ledger_payee = $1 WHERE id = ANY($2::int[])`, log.payee_map_ids);

    // Only if THIS merge created it. An alias that predated the merge is
    // somebody else's recorded decision.
    if (log.alias_inserted) {
      await pool.query(
        `DELETE FROM vendor_aliases WHERE LOWER(TRIM(alias)) = LOWER(TRIM($1)) AND LOWER(TRIM(primary_name)) = LOWER(TRIM($2))`,
        [log.source, log.target]).catch(() => {});
    }

    await pool.query(
      `UPDATE vendor_merge_log SET undone_at = NOW(), undone_by = $1 WHERE id = $2`,
      [req.user.name, log.id]);
    await logBkAction(req.user, 'vendor_merge_undone', null, log.target, null, log.target, log.source,
      `Undid the merge of ${log.source} into ${log.target} (${restored} entries, ${relinked} bank link${relinked === 1 ? '' : 's'} restored)`);

    res.json({ success: true, restored, relinked, source: log.source, target: log.target });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/vendors/:payee
// GET /api/bk/vendors/:payee/payment-details
//
// The only place a stored account number is ever decrypted. Admin-gated, and it
// writes an audit row PER READ — not per change. Access to payment details is
// itself the sensitive event: a change is visible in the data afterwards, a read
// leaves no trace unless one is made deliberately.
//
// Looked up by the vendor's email, which is how the details were keyed on the way
// in. Falls back to the most recent email seen on that payee's invoices, because
// this route is reached from a vendor PAGE, which knows a name.
router.get('/vendors/:payee/payment-details', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const payee = String(req.params.payee || '').trim();
    if (!payee) return res.status(400).json({ success: false, error: 'payee required' });

    const { rows: emailRows } = await pool.query(
      `SELECT vendor_email FROM expenses
        WHERE LOWER(TRIM(payee)) = LOWER(TRIM($1)) AND vendor_email IS NOT NULL AND vendor_email <> ''
        ORDER BY created_at DESC LIMIT 1`, [payee]);
    const email = emailRows[0]?.vendor_email;
    if (!email) return res.json({ success: true, data: { on_file: false } });

    const { rows } = await pool.query(
      `SELECT * FROM vendor_payment_details WHERE LOWER(vendor_email) = LOWER($1)`, [email]);
    const r = rows[0];
    if (!r) return res.json({ success: true, data: { on_file: false } });

    await logBkAction(req.user, 'payment_details_viewed', null, payee,
      'payment_details', null, null,
      `Viewed stored payment details for ${payee} (${r.method}, ****${r.account_last4 || '?'})`)
      .catch(() => {});

    res.json({ success: true, data: {
      on_file: true,
      method: r.method,
      holder_name: r.holder_name,
      bank_address: r.bank_address,
      paypal_handle: r.paypal_handle,
      // The rest of what it takes to FILE the payment rather than identify the
      // account. The query is SELECT *, but this response is a whitelist — so a
      // column added to the table and not added HERE is collected from the
      // vendor, stored, and invisible to the only person who needs it. Same
      // class as omitting a column the client branches on.
      account_type: r.account_type,
      bank_name: r.bank_name,
      beneficiary_address: r.beneficiary_address,
      intermediary_bank: r.intermediary_bank,
      account_number: paymentCrypto.decrypt(r.account_enc),
      routing_number: paymentCrypto.decrypt(r.routing_enc),
      iban_swift: paymentCrypto.decrypt(r.iban_enc),
      last4: r.account_last4,
      updated_at: r.updated_at,
      // Null values here mean the key is missing or the ciphertext failed
      // authentication — say so, rather than letting an empty field read as
      // "this vendor gave us nothing".
      readable: paymentCrypto.isConfigured(),
    } });
  } catch (err) {
    console.error('GET /api/bk/vendors/:payee/payment-details:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/vendors/:payee', async (req, res) => {
  try {
    const payee = decodeURIComponent(req.params.payee);
    const { rows } = await pool.query(`
      SELECT ${expenseCols('e')},
        -- WHO raised the flag, by name. expenseCols already carries flagged,
        -- flag_reason and flagged_by — but flagged_by is a user ID, and a tooltip
        -- reading "flagged by 1" tells nobody anything.
        (SELECT u.name FROM users u WHERE u.id = e.flagged_by) AS flagged_by_name,
        ((e.invoice_data IS NOT NULL AND e.invoice_data != '') OR e.invoice_r2_key IS NOT NULL) AS has_invoice,
        ((e.w9_data      IS NOT NULL AND e.w9_data      != '') OR e.w9_r2_key      IS NOT NULL) AS has_w9,
        ((e.proof_data   IS NOT NULL AND e.proof_data   != '') OR e.proof_r2_key   IS NOT NULL) AS has_proof,
        (SELECT x.id FROM expenses x
         WHERE ((x.w9_data IS NOT NULL AND x.w9_data != '') OR x.w9_r2_key IS NOT NULL)
           AND (x.deleted = false OR x.deleted IS NULL)
           AND (
             LOWER(TRIM(x.payee)) = LOWER(TRIM(e.payee))
             OR LOWER(TRIM(x.payee)) IN (
               SELECT LOWER(TRIM(va.alias)) FROM vendor_aliases va
                WHERE LOWER(TRIM(va.primary_name)) = LOWER(TRIM(e.payee))
               UNION
               SELECT LOWER(TRIM(va.primary_name)) FROM vendor_aliases va
                WHERE LOWER(TRIM(va.alias)) = LOWER(TRIM(e.payee))
             )
           )
         ORDER BY x.id DESC LIMIT 1) AS w9_entry_id,
        ${bankEvidenceCols('e')}
      FROM expenses e
      WHERE LOWER(TRIM(e.payee)) = LOWER(TRIM($1))
        AND (e.deleted = false OR e.deleted IS NULL)
        AND (e.voided = false OR e.voided IS NULL)
        AND e.status = 'approved'
      ORDER BY e.invoice_date DESC
    `, [payee]);

    // Count only non-child entries for invoice count
    const rootEntries = rows.filter(r => !r.parent_id);
    const stats = {
      payee,
      invoice_count: rootEntries.length,
      total_spent:   rows.filter(r => r.status === 'approved')
                        .reduce((s, r) => s + parseFloat(r.amount || 0), 0),
      w9_on_file:    rows.some(r => r.has_w9),
      vendor_email:  rows.find(r => r.vendor_email)?.vendor_email || null,
    };

    res.json({ success: true, data: { ...stats, invoices: rows } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Payments ──────────────────────────────────────────────────────────────────

// GET /api/bk/payments
// Scope: the payment dashboard only surfaces actionable or recently-actioned
// rows — i.e., anything not yet Paid, plus anything Paid within the last 14
// days (for confirmation-email follow-up). Older paid rows live in the
// ledger. Pass ?scope=all to bypass the window (used for future tooling —
// no caller sends it today).
router.get('/payments', async (req, res) => {
  try {
    const { payment_status, from, to, search, scope } = req.query;
    const conditions = [
      "e.status = 'approved'",
      '(e.deleted = false OR e.deleted IS NULL)',
      '(e.voided = false OR e.voided IS NULL)',
      // Added expenses (born on the Recoupments / Artist Campaigns pages)
      // are internal spend records, not invoices awaiting payment — they
      // never belong in the payment queue. They stay on the Ledger and
      // in /payments/export (which reports payment history, not the queue).
      //
      // `bank_statement` joins them for the same reason and with far more
      // force: those rows are created BY booking a bank debit, so the money
      // has already left the account. There is nothing to schedule, approve,
      // chase or send a confirmation for. Measured before this line existed:
      // 2,325 of the 2,590 rows on this dashboard — 90% — were
      // statement-created, burying the 265 invoices that actually needed
      // attention.
      //
      // Nothing on this page wants them. The `bank=unverified` worklist looks
      // for payments with NO bank match, and a statement-created row always has
      // one by construction; the confirmation-email flow only applies to
      // vendor-submitted invoices.
      "(e.entry_source IS NULL OR e.entry_source NOT IN ('recoupments', 'artist_campaigns', 'bank_statement'))",
    ];
    // The bank=unverified worklist opts out of the 14-day window: an
    // unverified payment from three months ago is exactly what it's for.
    if (scope !== 'all' && req.query.bank !== 'unverified') {
      // 14-day window measured from when the row was MARKED paid, not the
      // date on the proof / payment_date. Fallback to payment_date for legacy
      // rows where paid_marked_at hasn't been backfilled yet.
      conditions.push(
        `(e.payment_status IS DISTINCT FROM 'Paid'
          OR COALESCE(e.paid_marked_at, e.payment_date::timestamp, e.created_at) >= NOW() - INTERVAL '14 days')`
      );
    }
    const params = [];

    // Approver rep-block filter — empty string for non-Approvers so this
    // is a no-op for Admin / Superadmin. Mirrors the /bk/approvals filter
    // so Approvers see the same "hidden" set across both pages.
    const repBlock = userVisibleRepsClause(req.user, params);
    if (repBlock) conditions.push(repBlock);

    if (payment_status && payment_status !== 'All') {
      params.push(payment_status);
      conditions.push(`e.payment_status = $${params.length}`);
    }
    if (from) { params.push(from); conditions.push(`e.invoice_date >= $${params.length}`); }
    if (to)   { params.push(to);   conditions.push(`e.invoice_date <= $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      conditions.push(`(e.payee ILIKE $${n} OR e.artist ILIKE $${n} OR e.invoice_number ILIKE $${n} OR e.description ILIKE $${n})`);
    }
    // ?bank=unverified — marked Paid, but no bank transaction on a ready
    // statement that should have shown it. Funding-pair aware (see
    // lib/bank-evidence.js): a PayPal-paid invoice is only expected on the
    // PayPal statement, so its dismissed BofA funding leg is not a miss.
    // Implies scope=all — the 14-day queue window would hide most of them.
    if (req.query.bank === 'unverified') conditions.push(noBankEvidenceSql('e'));

    // Show every row (parent + children) so multi-artist invoices appear once
    // per artist split, matching the ledger. is_split flags rows that are
    // either a child or have children so the UI can badge them as splits.
    // has_invoice / file_entry_id follow the parent so children of a split
    // still surface the invoice PDF.
    const { rows } = await pool.query(`
      WITH scoped AS (
        SELECT e.id FROM expenses e WHERE ${conditions.join(' AND ')}
      ),
${ALIAS_PAIRS_CTE},
${VENDOR_CC_CTE},
      pay_files AS (
        SELECT ef.entity_id AS id,
               COUNT(*)::int AS n,
               COUNT(*) FILTER (WHERE ef.label = 'Vendor invoice attachment')::int AS vendor_n
          FROM entity_files ef
         WHERE ef.entity_type = 'expense_receipt'
           AND ef.entity_id IN (SELECT id FROM scoped)
         GROUP BY ef.entity_id
      )
      SELECT e.id, e.invoice_date, e.payee, e.description,
             e.artist, e.song, e.amount, e.currency,
             e.invoice_number, e.category, e.vendor_email, e.vendor_bank, e.boom_rep,
             e.payment_method, e.payment_status, e.payment_date, e.paid_by,
             e.scheduled_payment_date, e.payment_terms, e.notes, e.confirmation_sent,
             e.rush_requested, e.rush_requested_at, e.rush_requested_by, e.rush_reason,
             e.on_hold, e.hold_at, e.hold_by, e.hold_reason,
             e.parent_id,
             COALESCE(e.parent_id, e.id) AS file_entry_id,
             (e.parent_id IS NOT NULL OR EXISTS (
                SELECT 1 FROM expenses c WHERE c.parent_id = e.id
                  AND (c.deleted = false OR c.deleted IS NULL)
             )) AS is_split,
             ((e.invoice_data IS NOT NULL AND e.invoice_data != '') OR
              (p.invoice_data IS NOT NULL AND p.invoice_data != '') OR
              e.invoice_r2_key IS NOT NULL OR p.invoice_r2_key IS NOT NULL) AS has_invoice,
             ((e.w9_data IS NOT NULL AND e.w9_data != '') OR e.w9_r2_key IS NOT NULL) AS has_w9,
             ((e.proof_data IS NOT NULL AND e.proof_data != '') OR e.proof_r2_key IS NOT NULL) AS has_proof,
             ${bankEvidenceCols('e')},
             ${INSTALLMENT_SUMMARY_SELECT}
             -- ── What the vendor actually submitted ──────────────────────────
             --
             -- The row detail panel reads these. They are READ-ONLY there, for
             -- the reason the ledger gives: they record what somebody stated
             -- when they asked to be paid, and the bank fields are mirrored in
             -- an encrypted profile this page has no write path to.
             --
             -- A split CHILD shows its FAMILY's answers. The submission belongs
             -- to the invoice; children are our own division of it and carry
             -- none of these columns, so every one resolves through the parent
             -- or each slice reads as a vendor who answered nothing. The parent
             -- is already LEFT JOINed as p.
             --
             -- Account, routing and IBAN are deliberately NOT here. They are
             -- single-copy and encrypted, and the only route that decrypts them
             -- writes an audit row PER READ; selecting them for every row of a
             -- 50-row page would fire that audit 50 times per render and put a
             -- bank account number in every screenshot. last4 says WHICH
             -- account; the number itself stays one deliberate click away on
             -- GET /bk/vendors/:payee/payment-details.
             ,COALESCE(e.payment_snapshot, p.payment_snapshot) AS payment_snapshot
             ,COALESCE(e.payment_check,    p.payment_check)    AS payment_check
             ,COALESCE(e.payment_last4,    p.payment_last4)    AS payment_last4
             ,COALESCE(e.paypal_handle,    p.paypal_handle)    AS paypal_handle
             ,COALESCE(e.vendor_name,      p.vendor_name)      AS vendor_name
             ,COALESCE(e.vendor_address,   p.vendor_address)   AS vendor_address
             ,COALESCE(e.social_handles,   p.social_handles)   AS social_handles
             ,COALESCE(e.off_roster_artist, p.off_roster_artist) AS off_roster_artist
             ,e.is_reimbursement, e.recoupable, e.ufr, e.artist_campaign
             ,e.cobrand, e.is_bulk_deal, e.in_quickbooks
             ,e.w9_tin_last4, e.w9_tin_type, e.w9_tax_classification
             ,COALESCE(f.n, 0)        AS receipt_count
             ,COALESCE(f.vendor_n, 0) AS vendor_file_count
             ,vcc.emails              AS vendor_cc_emails
      FROM expenses e
      LEFT JOIN expenses p ON p.id = e.parent_id
      LEFT JOIN pay_files f ON f.id = e.id
      LEFT JOIN vendor_cc vcc ON vcc.payee_key = LOWER(TRIM(e.payee))
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.invoice_date DESC
    `, params);

    // ── W-9 coverage is a VENDOR question ────────────────────────────────
    //
    // `has_w9` above answers "does THIS invoice carry the form", which is the
    // wrong question: a W-9 lives on whichever row it was uploaded onto and
    // covers every other invoice from that vendor. Measured on the live queue
    // 2026-09-14 — the row-level flag reports 122 unpaid rows missing a W-9
    // where only 32 are genuinely uncovered, across 22 vendors. That is the
    // per-entry-count-answering-a-per-vendor-question shape lib/w9-owner exists
    // to prevent, and it is alias-aware in both directions, so a form filed
    // under a legal name still covers the trading name.
    //
    // One batched pass, not a lookup per row — see the note in w9OwnersFor
    // about the correlated subquery that made /statements/all take 17 seconds.
    // The client pairs w9_entry_id with has_w9 exactly as the Ledger,
    // Approvals and Invoices pages already do.
    const w9Owners = await w9OwnersFor(rows.map((r) => r.payee));
    for (const r of rows) {
      const owner = w9Owners.get(String(r.payee || '').trim().toLowerCase());
      r.w9_entry_id = owner ? owner.id : null;
    }

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /api/bk/payments:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Shared range resolver for the weekly-chart endpoints. Accepts optional
// `from`/`to` query params (YYYY-MM-DD). When both are missing, defaults
// to the trailing 12 weeks anchored on today in LA. When only one is
// missing, fills the other based on the caller's intent. Clamps the
// span to 2 years max so a bad param can't runaway a query. Returns
// safe SQL-ready DATE strings.
function resolveChartRange(query = {}) {
  const MAX_SPAN_DAYS = 730; // 2 years upper bound
  const isValidIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const fromRaw = isValidIso(query.from) ? query.from : null;
  const toRaw   = isValidIso(query.to)   ? query.to   : null;

  // If callers gave nothing, use the trailing 84 days (12 calendar weeks)
  // — matches the old hardcoded behavior so no visual regression at the
  // default range.
  if (!fromRaw && !toRaw) {
    // Sentinels resolved in SQL to LA-local dates via (NOW() AT TIME ZONE ...)::DATE
    return { from: null, to: null };
  }

  // If one side is missing, span 12 weeks from the provided side.
  let from = fromRaw;
  let to   = toRaw;
  if (from && !to) {
    const d = new Date(from + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 84);
    to = d.toISOString().slice(0, 10);
  }
  if (to && !from) {
    const d = new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 84);
    from = d.toISOString().slice(0, 10);
  }

  // Normalize order (from ≤ to) so a reversed pair still returns data.
  if (from > to) { const tmp = from; from = to; to = tmp; }

  // Clamp span. If the caller asks for more than 2 years, snap `from`
  // forward so we return exactly 2 years ending at `to`.
  const spanMs = new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z');
  if (spanMs / (1000 * 60 * 60 * 24) > MAX_SPAN_DAYS) {
    const d = new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - MAX_SPAN_DAYS);
    from = d.toISOString().slice(0, 10);
  }
  return { from, to };
}

// GET /api/bk/payments/submissions-per-week?from=YYYY-MM-DD&to=YYYY-MM-DD
// Weekly submission counts. Defaults to the trailing 12 calendar weeks
// when no range is supplied — matches the old behavior. Counts EVERY
// expense row that landed in the DB regardless of approval status
// (pending, approved, rejected all count, since we're measuring intake
// volume). Excludes soft-deleted + voided.
//
// Splits by source: `vendor_submitted = true` (vendor portal) vs the
// admin path (Add Invoice, Bulk Upload, etc.). Weeks are Mon–Sun in LA
// time — DATE_TRUNC('week', ...) uses ISO weeks (Monday start). Zero-
// fills gaps so every week in the requested window shows up in the
// response even if no invoices landed that week.
router.get('/payments/submissions-per-week', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    const { from, to } = resolveChartRange(req.query);
    // SQL: when the caller didn't send a range, use LA-today as the
    // anchor and go back 84 days (12 weeks). When they did, use the
    // resolved from/to. Same params drive both the generate_series
    // (which builds the X-axis) and the counts CTE window.
    const fromSql = from ? `$1::DATE` : `((NOW() AT TIME ZONE 'America/Los_Angeles')::DATE - INTERVAL '84 days')::DATE`;
    const toSql   = to   ? `$2::DATE` : `(NOW() AT TIME ZONE 'America/Los_Angeles')::DATE`;
    const params  = (from && to) ? [from, to] : [];

    const { rows } = await pool.query(`
      WITH weeks AS (
        SELECT generate_series(
          DATE_TRUNC('week', ${fromSql}::TIMESTAMP)::DATE,
          DATE_TRUNC('week', ${toSql}::TIMESTAMP)::DATE,
          INTERVAL '1 week'
        )::DATE AS week_start
      ),
      counts AS (
        SELECT
          DATE_TRUNC('week', (created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::DATE AS week_start,
          COUNT(*) FILTER (WHERE vendor_submitted = TRUE) AS vendor,
          COUNT(*) FILTER (WHERE vendor_submitted = FALSE OR vendor_submitted IS NULL) AS admin,
          -- USD-equivalent amount sums. For submissions we count every
          -- row regardless of payment state, so fx_rate_to_usd may be
          -- unset on brand-new rows (stampFxRateAsync fills it shortly
          -- after insert). COALESCE to 1.0 treats those as USD — the
          -- alternative (excluding them) would systematically undercount
          -- new intake. For an intake-volume chart the approximation is
          -- acceptable; the paid chart's totals are the authoritative
          -- dollar figure since those rows carry the locked rate.
          SUM(amount * COALESCE(fx_rate_to_usd, 1.0)) FILTER (WHERE vendor_submitted = TRUE) AS vendor_amount,
          SUM(amount * COALESCE(fx_rate_to_usd, 1.0)) FILTER (WHERE vendor_submitted = FALSE OR vendor_submitted IS NULL) AS admin_amount
        FROM expenses
        WHERE created_at >= (${fromSql} - INTERVAL '7 days')
          AND created_at <= (${toSql}   + INTERVAL '7 days')
          AND (deleted = false OR deleted IS NULL)
          AND (voided  = false OR voided  IS NULL)
        GROUP BY 1
      )
      SELECT
        TO_CHAR(w.week_start, 'YYYY-MM-DD') AS week_start,
        TO_CHAR((w.week_start + INTERVAL '6 days')::DATE, 'YYYY-MM-DD') AS week_end,
        COALESCE(c.vendor, 0)::INT AS vendor,
        COALESCE(c.admin,  0)::INT AS admin,
        (COALESCE(c.vendor, 0) + COALESCE(c.admin, 0))::INT AS total,
        COALESCE(c.vendor_amount, 0)::FLOAT AS vendor_amount,
        COALESCE(c.admin_amount,  0)::FLOAT AS admin_amount,
        (COALESCE(c.vendor_amount, 0) + COALESCE(c.admin_amount, 0))::FLOAT AS total_amount
      FROM weeks w
      LEFT JOIN counts c USING (week_start)
      ORDER BY w.week_start ASC
    `, params);

    res.json({ success: true, data: { weeks: rows } });
  } catch (err) {
    console.error('GET /api/bk/payments/submissions-per-week:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/payments/paid-per-week
// Trailing-12-weeks weekly count of invoices PAID (payment_date bucketed
// into Mon–Sun LA weeks). Same shape as /submissions-per-week so both
// charts can share one client component. Only counts rows that actually
// hit Paid AND have a payment_date — a null payment_date means we can't
// place them on a week even if their status is Paid.
//
// The vendor / admin split still applies: measures where the paid
// invoice originally came from, not who marked it paid. Useful for
// answering "of the money we released last week, how much went to
// vendor-portal submissions vs staff-entered rows?"
router.get('/payments/paid-per-week', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    const { from, to } = resolveChartRange(req.query);
    const fromSql = from ? `$1::DATE` : `((NOW() AT TIME ZONE 'America/Los_Angeles')::DATE - INTERVAL '84 days')::DATE`;
    const toSql   = to   ? `$2::DATE` : `(NOW() AT TIME ZONE 'America/Los_Angeles')::DATE`;
    const params  = (from && to) ? [from, to] : [];

    const { rows } = await pool.query(`
      WITH weeks AS (
        SELECT generate_series(
          DATE_TRUNC('week', ${fromSql}::TIMESTAMP)::DATE,
          DATE_TRUNC('week', ${toSql}::TIMESTAMP)::DATE,
          INTERVAL '1 week'
        )::DATE AS week_start
      ),
      counts AS (
        SELECT
          DATE_TRUNC('week', payment_date::TIMESTAMP)::DATE AS week_start,
          COUNT(*) FILTER (WHERE vendor_submitted = TRUE) AS vendor,
          COUNT(*) FILTER (WHERE vendor_submitted = FALSE OR vendor_submitted IS NULL) AS admin,
          -- USD-equivalent amount sums. Paid rows carry a locked
          -- fx_rate_to_usd (stamped at payment time), so summing
          -- amount * fx_rate_to_usd is stable — no drift as live FX
          -- rates change.
          SUM(amount * COALESCE(fx_rate_to_usd, 1.0)) FILTER (WHERE vendor_submitted = TRUE) AS vendor_amount,
          SUM(amount * COALESCE(fx_rate_to_usd, 1.0)) FILTER (WHERE vendor_submitted = FALSE OR vendor_submitted IS NULL) AS admin_amount
        FROM expenses
        WHERE payment_status = 'Paid'
          AND payment_date IS NOT NULL
          AND payment_date >= (${fromSql} - INTERVAL '7 days')
          AND payment_date <= (${toSql}   + INTERVAL '7 days')
          AND (deleted = false OR deleted IS NULL)
          AND (voided  = false OR voided  IS NULL)
        GROUP BY 1
      )
      SELECT
        TO_CHAR(w.week_start, 'YYYY-MM-DD') AS week_start,
        TO_CHAR((w.week_start + INTERVAL '6 days')::DATE, 'YYYY-MM-DD') AS week_end,
        COALESCE(c.vendor, 0)::INT AS vendor,
        COALESCE(c.admin,  0)::INT AS admin,
        (COALESCE(c.vendor, 0) + COALESCE(c.admin, 0))::INT AS total,
        COALESCE(c.vendor_amount, 0)::FLOAT AS vendor_amount,
        COALESCE(c.admin_amount,  0)::FLOAT AS admin_amount,
        (COALESCE(c.vendor_amount, 0) + COALESCE(c.admin_amount, 0))::FLOAT AS total_amount
      FROM weeks w
      LEFT JOIN counts c USING (week_start)
      ORDER BY w.week_start ASC
    `, params);

    res.json({ success: true, data: { weeks: rows } });
  } catch (err) {
    console.error('GET /api/bk/payments/paid-per-week:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/payments/export — Excel export of current filtered payments
router.get('/payments/export', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    const { filter } = req.query; // all, unpaid, overdue, due_soon, paid
    const conditions = [
      "status = 'approved'",
      '(deleted = false OR deleted IS NULL)',
      '(voided = false OR voided IS NULL)',
    ];
    const params = [];
    const now = new Date().toISOString().slice(0, 10);
    const weekFromNow = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

    // Approver rep-block — export must match what the user can see on
    // the Payments page (otherwise they could "download what they can't
    // see"). Pass alias=null because this query is on the unaliased
    // `expenses` table.
    const repBlock = userVisibleRepsClause(req.user, params, null);
    if (repBlock) conditions.push(repBlock);

    if (filter === 'unpaid') conditions.push("payment_status != 'Paid'");
    else if (filter === 'overdue') {
      conditions.push("payment_status != 'Paid'");
      conditions.push(`scheduled_payment_date < '${now}'`);
      conditions.push('scheduled_payment_date IS NOT NULL');
    } else if (filter === 'due_soon') {
      conditions.push("payment_status != 'Paid'");
      conditions.push(`scheduled_payment_date >= '${now}'`);
      conditions.push(`scheduled_payment_date <= '${weekFromNow}'`);
    } else if (filter === 'paid') {
      conditions.push("payment_status = 'Paid'");
    }

    const { rows } = await pool.query(`
      SELECT id, invoice_date, payee, artist, song, amount, currency,
             invoice_number, category, payment_method, payment_status,
             payment_date, paid_by, scheduled_payment_date, payment_terms, notes
      FROM expenses
      WHERE ${conditions.join(' AND ')}
      ORDER BY scheduled_payment_date ASC NULLS LAST, invoice_date DESC
    `, params);

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Market Street Dashboard';
    const labels = { all: 'All Payments', unpaid: 'Unpaid', overdue: 'Overdue', due_soon: 'Due Soon', paid: 'Paid' };
    const ws = wb.addWorksheet(labels[filter] || 'Payments');

    ws.columns = [
      { header: 'Invoice Date',    key: 'invoice_date',          width: 14 },
      { header: 'Payee',           key: 'payee',                 width: 28 },
      { header: 'Artist',          key: 'artist',                width: 20 },
      { header: 'Invoice #',       key: 'invoice_number',        width: 16 },
      { header: 'Amount',          key: 'amount',                width: 14 },
      { header: 'Currency',        key: 'currency',              width: 10 },
      { header: 'Method',          key: 'payment_method',        width: 14 },
      { header: 'Due Date',        key: 'scheduled_payment_date',width: 14 },
      { header: 'Status',          key: 'payment_status',        width: 12 },
      { header: 'Date Paid',       key: 'payment_date',          width: 14 },
      { header: 'Paid By',         key: 'paid_by',               width: 16 },
      { header: 'Terms',           key: 'payment_terms',         width: 12 },
      { header: 'Notes',           key: 'notes',                 width: 30 },
    ];

    ws.getRow(1).font      = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
    ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    for (const r of rows) {
      ws.addRow({
        ...r,
        invoice_date: r.invoice_date ? new Date(r.invoice_date).toLocaleDateString('en-US') : '',
        payment_date: r.payment_date ? new Date(r.payment_date).toLocaleDateString('en-US') : '',
        scheduled_payment_date: r.scheduled_payment_date ? new Date(r.scheduled_payment_date).toLocaleDateString('en-US') : '',
        amount: parseFloat(r.amount || 0),
      });
    }
    ws.getColumn('amount').numFmt = '"$"#,##0.00';

    // Total row
    const totalRow = ws.addRow({ payee: 'TOTAL', amount: rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0) });
    totalRow.font = { bold: true };
    totalRow.getCell('amount').numFmt = '"$"#,##0.00';

    const safeName = (labels[filter] || 'payments').replace(/\s+/g, '-').toLowerCase();
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Disposition', `attachment; filename="marketst-${safeName}-${now}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('GET /api/bk/payments/export:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/payments/send-approval-email
// Sends Felipe (CC Jesse) an Excel summary + invoice PDFs for the selected
// payment IDs. With { test: true } (admin-only), redirects to john@deanst.co
// with no CC for copy review.
// `dry_run: true` builds the email body (HTML, recipients, subject, attachment
// labels) but skips the actual gmail send — used to populate the inline-HTML
// EmailPreviewModal. `html_override`, when supplied on a real send, replaces
// the rendered body with the admin's edited HTML (sanitized).
router.post('/payments/send-approval-email', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { ids, test, recipients, body: customBody, dry_run, html_override, to: toOverride, cc: ccOverride, subject: subjectOverride } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, error: 'ids required' });
    // Rep-block visibility check on the whole batch. If any selected
    // entry is hidden from this Approver, reject the request rather
    // than silently dropping rows — the user would otherwise wonder
    // why their email shows fewer items than they checked.
    {
      const blocked = await findInvisibleEntry(req.user, ids);
      if (blocked) {
        return res.status(403).json({
          success: false,
          error: `Selection includes an entry you don't have visibility into (id ${blocked.id}, rep ${blocked.boom_rep}).`,
        });
      }
    }
    const pick = ['both', 'felipe', 'jesse'].includes(recipients) ? recipients : 'both';

    // Resolve the family root for each selected id first. A split invoice is
    // ONE payment to ONE vendor — the per-artist / fee-vs-reimb / per-song
    // children are an internal accounting construct. So we approve (and show)
    // the full invoice, never a partial slice. Selecting any slice pulls in
    // its parent + every sibling so the email always reflects the FULL amount,
    // even when only one slice was checked on the dashboard.
    const { rows: selRoots } = await pool.query(
      `SELECT DISTINCT COALESCE(parent_id, id) AS root_id
         FROM expenses
        WHERE id = ANY($1::int[]) AND status = 'approved' AND (deleted = false OR deleted IS NULL)`,
      [ids]
    );
    const rootIds = selRoots.map(r => r.root_id);
    if (!rootIds.length) return res.status(404).json({ success: false, error: 'No matching approved entries' });

    // Pull the FULL families for those roots (parent + all non-deleted
    // children). file_entry_id (= the root) is both the attachment-dedupe key
    // and the family grouping key for the per-invoice detail table below.
    const { rows } = await pool.query(
      `SELECT e.id, e.invoice_date, e.payee, e.artist, e.song, e.amount, e.currency, e.invoice_number,
              e.category, e.payment_method, e.scheduled_payment_date, e.payment_terms, e.notes,
              e.boom_rep, e.is_reimbursement,
              COALESCE(e.parent_id, e.id) AS file_entry_id,
              COALESCE(e.invoice_data, p.invoice_data)         AS invoice_data,
              COALESCE(e.invoice_r2_key, p.invoice_r2_key)     AS invoice_r2_key,
              COALESCE(e.invoice_filename, p.invoice_filename) AS invoice_filename
       FROM expenses e
       LEFT JOIN expenses p ON p.id = e.parent_id
       WHERE (e.id = ANY($1::int[]) OR e.parent_id = ANY($1::int[]))
         AND e.status = 'approved' AND (e.deleted = false OR e.deleted IS NULL)
       ORDER BY e.artist ASC NULLS LAST, e.invoice_date DESC`,
      [rootIds]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'No matching approved entries' });

    // Collapse rows into invoice families keyed by root (file_entry_id). Each
    // family is one real invoice; its FULL amount is the sum of every slice.
    // Used for the per-invoice detail table + the "N invoices" count. The
    // Totals-by-Artist table below still iterates the raw slices so the
    // per-artist budget breakdown stays intact.
    const familyMap = new Map();
    for (const r of rows) {
      const k = r.file_entry_id;
      if (!familyMap.has(k)) familyMap.set(k, []);
      familyMap.get(k).push(r);
    }
    const families = Array.from(familyMap.values()).map(fam => {
      const primary = fam.find(r => r.id === r.file_entry_id) || fam[0];
      const total = fam.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
      const artists = [...new Set(fam.map(r => (r.artist || '').trim()).filter(Boolean))];
      const songs = [...new Set(fam.map(r => (r.song || '').trim()).filter(Boolean))];
      return {
        payee: primary.payee,
        invoice_number: primary.invoice_number,
        currency: primary.currency,
        scheduled_payment_date: primary.scheduled_payment_date,
        notes: (primary.notes || '').trim(),
        isReimb: fam.some(r => r.is_reimbursement),
        isSplit: fam.length > 1,
        sliceCount: fam.length,
        total,
        artists,
        songs,
      };
    }).sort((a, b) => {
      const aa = (a.artists[0] || '').toLowerCase();
      const bb = (b.artists[0] || '').toLowerCase();
      if (aa !== bb) return aa < bb ? -1 : 1;
      return b.total - a.total;
    });
    const invoiceCount = families.length;

    // Group totals by (artist, currency) so EUR/GBP etc. aren't silently
    // added into USD totals. Produces rows keyed by artist+currency and a
    // grand total per currency.
    const byArtistCurrency = {};
    const grandByCurrency = {};
    for (const r of rows) {
      const artist = (r.artist && r.artist.trim()) || '(no artist)';
      const cur = r.currency || 'USD';
      const amt = parseFloat(r.amount || 0);
      const key = artist + '||' + cur;
      if (!byArtistCurrency[key]) byArtistCurrency[key] = { artist, currency: cur, amount: 0 };
      byArtistCurrency[key].amount += amt;
      grandByCurrency[cur] = (grandByCurrency[cur] || 0) + amt;
    }
    const artistRanked = Object.values(byArtistCurrency).sort((a, b) => {
      if (a.artist === b.artist) return a.currency === 'USD' ? -1 : b.currency === 'USD' ? 1 : a.currency.localeCompare(b.currency);
      return b.amount - a.amount;
    });
    const fmtMoney = (n, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(n || 0);
    const grandTotalDisplay = Object.entries(grandByCurrency)
      .filter(([, v]) => v)
      .sort(([a], [b]) => a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b))
      .map(([cur, amt]) => fmtMoney(amt, cur))
      .join(' + ') || fmtMoney(0);

    // Build Excel summary
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Market Street Dashboard';
    const ws = wb.addWorksheet('Approval Summary');
    ws.columns = [
      { header: 'Invoice Date',   key: 'invoice_date',            width: 14 },
      { header: 'Payee',          key: 'payee',                   width: 28 },
      { header: 'Artist',         key: 'artist',                  width: 20 },
      { header: 'Song',           key: 'song',                    width: 20 },
      { header: 'Rep',            key: 'boom_rep',                width: 12 },
      { header: 'Invoice #',      key: 'invoice_number',          width: 16 },
      { header: 'Amount',         key: 'amount',                  width: 14 },
      { header: 'Currency',       key: 'currency',                width: 10 },
      { header: 'Method',         key: 'payment_method',          width: 14 },
      { header: 'Due Date',       key: 'scheduled_payment_date',  width: 14 },
      { header: 'Category',       key: 'category',                width: 16 },
      { header: 'Reimbursement?', key: 'is_reimbursement',        width: 16 },
      { header: 'Notes',          key: 'notes',                   width: 30 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
    ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    for (const r of rows) {
      ws.addRow({
        ...r,
        invoice_date: r.invoice_date ? new Date(r.invoice_date).toLocaleDateString('en-US') : '',
        scheduled_payment_date: r.scheduled_payment_date ? new Date(r.scheduled_payment_date).toLocaleDateString('en-US') : '',
        amount: parseFloat(r.amount || 0),
        is_reimbursement: r.is_reimbursement ? 'Yes' : 'No',
      });
    }
    ws.getColumn('amount').numFmt = '#,##0.00';  // no fixed $, each row's currency column indicates native currency
    // One total row per currency — avoids summing €1000 and $1000 as one misleading total
    for (const [cur, amt] of Object.entries(grandByCurrency)) {
      const row = ws.addRow({ payee: `TOTAL (${cur})`, currency: cur, amount: amt });
      row.font = { bold: true };
      row.getCell('amount').numFmt = '#,##0.00';
    }
    const excelBuf = await wb.xlsx.writeBuffer();

    // Attachments: Excel + each invoice PDF
    const today = new Date().toISOString().slice(0, 10);
    const attachments = [{
      filename: `marketst-approval-summary-${today}.xlsx`,
      data: Buffer.from(excelBuf).toString('base64'),
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }];
    // Attach one PDF per unique invoice — if a parent and multiple splits of
    // the same invoice are selected, all share one file_entry_id.
    const seenFileIds = new Set();
    const seenNames = new Set();
    for (const r of rows) {
      if (!r.invoice_filename) continue;
      if (!r.invoice_r2_key && !r.invoice_data) continue;
      if (seenFileIds.has(r.file_entry_id)) continue;
      seenFileIds.add(r.file_entry_id);
      let name = (r.invoice_filename || `invoice-${r.file_entry_id}`).replace(/[^\w\s.()&+-]/g, '_');
      if (seenNames.has(name.toLowerCase())) {
        const ext = name.match(/\.[^.]+$/)?.[0] || '';
        name = name.replace(/\.[^.]+$/, '') + `-${r.file_entry_id}${ext}`;
      }
      seenNames.add(name.toLowerCase());
      const mime = /\.pdf$/i.test(name) ? 'application/pdf'
                 : /\.png$/i.test(name) ? 'image/png'
                 : /\.jpe?g$/i.test(name) ? 'image/jpeg'
                 : 'application/octet-stream';
      const data = await loadFileBase64(r.invoice_r2_key, r.invoice_data);
      if (data) attachments.push({ filename: name, data, mimeType: mime });
    }
    const uniqueInvoiceCount = seenFileIds.size;

    // HTML body
    const artistRows = artistRanked.map(r => `
      <tr>
        <td style="padding:7px 12px;border:1px solid #e5e5e5;font-size:13px;">${r.artist}${r.currency !== 'USD' ? ` <span style="font-size:10px;color:#999;font-weight:700;">${r.currency}</span>` : ''}</td>
        <td style="padding:7px 12px;border:1px solid #e5e5e5;text-align:right;font-size:13px;font-weight:700;">${fmtMoney(r.amount, r.currency)}</td>
      </tr>`).join('');

    // Per-invoice detail rendered in the body so reviewers can skim without
    // downloading the Excel. Tightened to the four columns that actually
    // drive an approval glance — Vendor, Artist/Song, Due, Amount. The
    // operational columns (invoice date, rep, payment method) live in the
    // attached Excel; they're noise in a quick approve-everything read.
    // Invoice # rides under the vendor name as a small secondary line.
    //
    // One row PER INVOICE (family), never per slice — a split invoice shows
    // its FULL combined amount once, with a SPLIT badge listing the artists
    // it's allocated across. The Totals by Artist table still shows the slice
    // breakdown, so both views reconcile to the same grand total.
    const fmtShortDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    const escapeCell = (v) => v == null ? '' : String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const detailRows = families.map(f => {
      const due = fmtShortDate(f.scheduled_payment_date);
      // Artist/Song cell: a single-artist invoice (incl. fee+reimb or per-song
      // splits under one artist) reads as "Artist / song"; a multi-artist
      // split lists the artists with a SPLIT badge so it's clear why one line
      // covers several budgets.
      let artistCell;
      if (f.artists.length > 1) {
        artistCell = `
          <div style="color:#111;">${f.artists.map(escapeCell).join(', ')}</div>
          <div style="font-size:9px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:.04em;margin-top:2px;">Split · ${f.sliceCount} items</div>`;
      } else {
        artistCell = `${escapeCell(f.artists[0] || '—')}${f.songs.length ? `<div style="font-size:10px;color:#999;">${f.songs.map(escapeCell).join(', ')}</div>` : ''}`;
      }
      return `
        <tr>
          <td style="padding:7px 10px;border:1px solid #e5e5e5;font-size:13px;">
            <div style="font-weight:700;color:#111;">${escapeCell(f.payee || '—')}</div>
            ${f.invoice_number ? `<div style="font-size:10px;color:#999;font-family:ui-monospace,Menlo,monospace;">#${escapeCell(f.invoice_number)}</div>` : ''}
          </td>
          <td style="padding:7px 10px;border:1px solid #e5e5e5;font-size:12px;color:#444;">${artistCell}</td>
          <td style="padding:7px 10px;border:1px solid #e5e5e5;font-size:11px;color:#666;white-space:nowrap;text-align:center;">${due || '—'}</td>
          <td style="padding:7px 10px;border:1px solid #e5e5e5;font-size:14px;font-weight:800;text-align:right;white-space:nowrap;color:${f.isReimb ? '#0369a1' : '#111'};">${fmtMoney(f.total, f.currency)}${f.isReimb ? ' <span style="font-size:9px;font-weight:700;background:#dbeafe;color:#1d4ed8;padding:1px 4px;border-radius:3px;text-transform:uppercase;letter-spacing:.04em;">REIMB</span>' : ''}</td>
        </tr>
        ${f.notes ? `
        <tr>
          <td colspan="4" style="padding:0 10px 6px 10px;border:1px solid #e5e5e5;border-top:none;font-size:10px;color:#888;font-style:italic;">${escapeCell(f.notes)}</td>
        </tr>` : ''}
      `;
    }).join('');
    // The summary goes to whoever the sender picked; greet the team rather
    // than a hard-coded name.
    const recipientLabel = 'team';
    // Render message body: if the caller provided custom text, escape it and
    // convert blank lines → paragraphs, single newlines → <br>. Otherwise use
    // the default two-line greeting+intro.
    const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let bodyHtml;
    if (typeof customBody === 'string' && customBody.trim()) {
      bodyHtml = escapeHtml(customBody.trim())
        .split(/\n{2,}/)
        .map(p => `<p style="margin:0 0 14px;font-size:14px;">${p.replace(/\n/g, '<br>')}</p>`)
        .join('');
    } else {
      bodyHtml = `<p style="margin:0 0 14px;font-size:14px;">Hey ${recipientLabel},</p>
          <p style="margin:0 0 14px;font-size:14px;">Here are some pending invoices for your approval. Summary is attached as an excel with pdfs for each invoice. Let me know if you have any questions.</p>`;
    }
    const summaryInner = `
          ${test ? '<div style="background:#fef3c7;border-left:3px solid #ca8a04;padding:8px 12px;margin:0 0 14px;border-radius:0 6px 6px 0;font-size:12px;color:#92400e;font-weight:600;">[TEST PREVIEW] — not sent to Felipe or Jesse.</div>' : ''}
          ${bodyHtml}
          <div style="font-size:11px;font-weight:800;color:#666;text-transform:uppercase;letter-spacing:.05em;margin:20px 0 6px;">Totals by Artist</div>
          <table style="width:100%;border-collapse:collapse;background:#fff;">
            <thead>
              <tr>
                <th style="padding:7px 12px;border:1px solid #e5e5e5;text-align:left;font-size:11px;font-weight:800;color:#666;text-transform:uppercase;letter-spacing:.05em;">Artist</th>
                <th style="padding:7px 12px;border:1px solid #e5e5e5;text-align:right;font-size:11px;font-weight:800;color:#666;text-transform:uppercase;letter-spacing:.05em;">Amount</th>
              </tr>
            </thead>
            <tbody>${artistRows}</tbody>
            <tfoot>
              <tr>
                <td style="padding:10px 12px;border:1px solid #e5e5e5;background:#fef2f2;font-weight:800;font-size:13px;">GRAND TOTAL</td>
                <td style="padding:10px 12px;border:1px solid #e5e5e5;background:#fef2f2;text-align:right;font-weight:900;font-size:16px;color:#334155;">${grandTotalDisplay}</td>
              </tr>
            </tfoot>
          </table>

          <div style="font-size:11px;font-weight:800;color:#666;text-transform:uppercase;letter-spacing:.05em;margin:20px 0 6px;">All ${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'}</div>
          <table style="width:100%;border-collapse:collapse;background:#fff;">
            <thead>
              <tr style="background:#f3f4f6;">
                <th style="padding:7px 10px;border:1px solid #e5e5e5;text-align:left;font-size:10px;font-weight:800;color:#666;text-transform:uppercase;letter-spacing:.04em;">Vendor</th>
                <th style="padding:7px 10px;border:1px solid #e5e5e5;text-align:left;font-size:10px;font-weight:800;color:#666;text-transform:uppercase;letter-spacing:.04em;">Artist / Song</th>
                <th style="padding:7px 10px;border:1px solid #e5e5e5;text-align:center;font-size:10px;font-weight:800;color:#666;text-transform:uppercase;letter-spacing:.04em;">Due</th>
                <th style="padding:7px 10px;border:1px solid #e5e5e5;text-align:right;font-size:10px;font-weight:800;color:#666;text-transform:uppercase;letter-spacing:.04em;">Amount</th>
              </tr>
            </thead>
            <tbody>${detailRows}</tbody>
          </table>
          <p style="margin:14px 0 0;font-size:11px;color:#888;">The same information is also attached as an Excel for download. Each invoice's PDF is attached separately.</p>
`;
    const html = require('../lib/email-layout').layout({ title: 'Invoices for approval', eyebrow: 'Approvals', accent: 'mustard', body: summaryInner });

    let to, cc;
    if (test) {
      to = 'john@deanst.co';
      cc = undefined;
    } else if (pick === 'felipe') {
      to = 'john@deanst.co';
      cc = undefined;
    } else if (pick === 'jesse') {
      to = 'john@deanst.co';
      cc = undefined;
    } else {
      to = 'john@deanst.co';
      cc = 'john@deanst.co';
    }
    const subject = subjectOverride
      || `${test ? '[TEST] ' : ''}${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'} for approval — ${grandTotalDisplay} total`;

    // dry_run: return the rendered HTML + recipients + attachment labels so
    // the client can populate EmailPreviewModal. No email goes out.
    if (dry_run) {
      return res.json({
        success: true,
        data: {
          to: toOverride || to,
          cc: ccOverride !== undefined ? ccOverride : (cc || ''),
          subject, html,
          attachmentLabels: attachments.map(a => a.filename),
          count: invoiceCount, totals: grandByCurrency, artists: artistRanked.length,
        },
      });
    }

    // Real send. Inline-edited HTML wins over the template body.
    const { sendEmail, sanitizeEmailHtml } = require('../services/email');
    const sendHtml = html_override ? sanitizeEmailHtml(html_override) : html;
    const sendTo = toOverride || to;
    const sendCc = ccOverride !== undefined ? (ccOverride || undefined) : cc;
    await sendEmail({ to: sendTo, cc: sendCc, subject, html: sendHtml, attachments, purpose: 'payments', kind: 'approval_summary' });

    await logBkAction(req.user, test ? 'payment_approval_email_test' : 'payment_approval_email_sent',
      null, `${invoiceCount} invoices`, null, null, null,
      `to=${sendTo}${sendCc ? `, cc=${sendCc}` : ''}, total=${grandTotalDisplay}${html_override ? ' — custom body' : ''}`);

    res.json({ success: true, to: sendTo, cc: sendCc || null, count: invoiceCount, totals: grandByCurrency, artists: artistRanked.length });
  } catch (err) {
    console.error('POST /api/bk/payments/send-approval-email:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/bk/payments/:id
//
// Splits represent ONE real payment sliced across artists/projects — so a
// change in any row of a split family propagates to the parent + every
// sibling. Otherwise you end up with the parent marked Paid and children
// stuck Unpaid (or vice versa), which breaks the Payment Dashboard view.
router.put('/payments/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    // Rep-block guard: an Approver can't touch payment state on an entry
    // whose rep is hidden from them. Matches /bk/payments visibility.
    if (!(await userCanActOnEntry(req.user, Number(req.params.id)))) {
      return res.status(403).json({ success: false, error: 'You do not have visibility into this entry' });
    }
    const { payment_status, payment_date, paid_by, scheduled_payment_date, payment_method, payment_ref } = req.body;
    const effectivePaidBy = (payment_status === 'Paid' && !paid_by) ? req.user.name : paid_by;

    await client.query('BEGIN');

    // paid_marked_at:
    //   • set to NOW() when payment_status flips to 'Paid' (and only if it
    //     wasn't already Paid — re-marking a paid row doesn't reset the timer)
    //   • cleared when flipping back to anything other than 'Paid'
    //   • untouched when payment_status isn't part of this update
    const { rows } = await client.query(`
      UPDATE expenses
      SET payment_status = COALESCE($1::text, payment_status),
          -- payment_date: caller-supplied wins; else when newly flipping
          -- to Paid AND no existing date, stamp today (LA). "The date
          -- paid is the day the row was switched to Paid" — applied
          -- across every flip path so the ledger never has a Paid row
          -- with an empty payment_date.
          --
          -- Type-cast every $2 reference to date up-front. Without a
          -- cast on the IS NOT NULL check Postgres can't infer $2's
          -- type from the CASE (only cast-uses appear elsewhere), so
          -- the prepared statement fails with "could not determine
          -- data type of parameter $2".
          payment_date   = CASE
            WHEN $2::date IS NOT NULL THEN $2::date
            WHEN $1 = 'Paid' AND payment_status IS DISTINCT FROM 'Paid' AND payment_date IS NULL
              THEN (NOW() AT TIME ZONE 'America/Los_Angeles')::DATE
            ELSE payment_date
          END,
          paid_by        = COALESCE($3::text, paid_by),
          -- ::text, NOT ::date. scheduled_payment_date is a TEXT column
          -- (index.js declares it TEXT), so COALESCE($4::date, text-column) is
          -- rejected by Postgres AT PLAN TIME. The statement then fails for
          -- every row regardless of the value, and regardless of whether $4 is
          -- even supplied. That made PUT /bk/payments/:id return 500 on every
          -- call from 2026-07-07 until 2026-08-31: the Payments page could not
          -- mark anything paid, singly or in bulk, and the client swallowed the
          -- message so it surfaced only as "Failed to bulk update".
          --
          -- lib/bank-evidence.js hit exactly this and says so in its header --
          -- the lesson was written down in one file while the hazard survived
          -- in this one. If you ever want a real date here, cast defensively:
          -- the column is free text and a bare ::date throws on any malformed
          -- value.
          --
          -- (And no backticks in these comments: this is inside a JS template
          -- literal, where a backtick in a -- comment ends the string.)
          scheduled_payment_date = COALESCE($4::text, scheduled_payment_date),
          payment_method = COALESCE($5::text, payment_method),
          payment_ref    = COALESCE($6::text, payment_ref),
          paid_marked_at = CASE
            WHEN $1 IS NULL THEN paid_marked_at
            WHEN $1 = 'Paid' AND payment_status IS DISTINCT FROM 'Paid' THEN NOW()
            WHEN $1 = 'Paid' THEN paid_marked_at
            ELSE NULL
          END,
          -- fx_rate_to_usd: drop the lock when going off Paid, OR when
          -- payment_date is changing while staying Paid. SET expressions
          -- all reference the OLD column values during a single UPDATE
          -- in Postgres, so the bare payment_date in the CASE refers to
          -- the row prior value -- exactly what we want to compare $2
          -- against. stampFxRateAsync below re-fetches the rate.
          fx_rate_to_usd = CASE
            WHEN $1 IS NOT NULL AND $1 != 'Paid' THEN NULL
            WHEN $2::date IS NOT NULL AND $2::date IS DISTINCT FROM payment_date THEN NULL
            ELSE fx_rate_to_usd
          END,
          -- Auto-clear rush + hold state once the row is paid. No need
          -- to keep a stale "RUSH" / "HOLD" badge on a paid entry.
          rush_requested      = CASE WHEN $1 = 'Paid' THEN FALSE ELSE rush_requested END,
          rush_requested_at   = CASE WHEN $1 = 'Paid' THEN NULL  ELSE rush_requested_at END,
          rush_requested_by   = CASE WHEN $1 = 'Paid' THEN NULL  ELSE rush_requested_by END,
          rush_reason         = CASE WHEN $1 = 'Paid' THEN NULL  ELSE rush_reason END,
          on_hold             = CASE WHEN $1 = 'Paid' THEN FALSE ELSE on_hold END,
          hold_at             = CASE WHEN $1 = 'Paid' THEN NULL  ELSE hold_at END,
          hold_by             = CASE WHEN $1 = 'Paid' THEN NULL  ELSE hold_by END,
          hold_reason         = CASE WHEN $1 = 'Paid' THEN NULL  ELSE hold_reason END
      WHERE id = $7
      RETURNING id, payee, parent_id, payment_status, payment_date, paid_by,
                payment_method, payment_ref, scheduled_payment_date, paid_marked_at,
                fx_rate_to_usd
    `, [payment_status, payment_date || null, effectivePaidBy, scheduled_payment_date || null,
        payment_method, payment_ref || null, req.params.id]);

    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Entry not found' });
    }
    const target = rows[0];

    // Cascade to the whole split family (parent + all its children except
    // the one we just updated). Shared with PUT /entries/:id and the
    // proof-upload paths via cascadePaymentFieldsToFamily.
    const { hasFamily, rootId } = await cascadePaymentFieldsToFamily(target, client);

    await client.query('COMMIT');

    // Stamp the FX rate on every row that's now Paid (target + family).
    // Fire-and-forget — response returns immediately; the stamp runs in
    // the background and is idempotent.
    if (target.payment_status === 'Paid') {
      const { stampFxRateAsync } = require('../services/fxStamp');
      stampFxRateAsync(target.id);
      if (hasFamily) {
        const { rows: sibIds } = await pool.query(
          `SELECT id FROM expenses WHERE (id = $1 OR parent_id = $1) AND id != $2
             AND (deleted = false OR deleted IS NULL) AND (voided = false OR voided IS NULL)`,
          [rootId, target.id]
        ).catch(() => ({ rows: [] }));
        for (const r of sibIds) stampFxRateAsync(r.id);
      }
    }

    if (payment_status === 'Paid') qbo.enqueue('payment', Number(req.params.id), req.user.id);
    await logBkAction(req.user, 'payment_updated', Number(req.params.id),
      target.payee, 'payment_status', null, payment_status,
      hasFamily ? `cascaded to split family (root=${rootId})` : null);
    // AFTER the COMMIT above, deliberately. The finder queries on `pool` — a
    // different connection — and bk_audit_log.entry_id references expenses(id),
    // so running it while this transaction still held row locks is exactly the
    // self-deadlock that hung the merge endpoint for 125s with no error.
    res.json({
      success: true,
      data: target,
      duplicate_warning: await stubDuplicateWarning(target, { payment_status }),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/bk/payments/:id/rush — user requests this payment be paid ASAP.
// Sets rush_* on the row. The badge surfaces on the Payment Dashboard
// (and via the "Rush" quick-filter) — that's the entire notification
// channel; no email is sent. Auto-cleared when the row flips to Paid
// (see PUT above).
router.post('/payments/:id/rush', async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
    if (!(await userCanActOnEntry(req.user, id))) {
      return res.status(403).json({ success: false, error: 'You do not have visibility into this entry' });
    }

    const { rows } = await pool.query(
      `UPDATE expenses
         SET rush_requested = TRUE,
             rush_requested_at = NOW(),
             rush_requested_by = $1,
             rush_reason = $2,
             -- Mutex with hold. Rush = "expedite this"; hold = "pause this".
             -- Setting rush clears any existing hold, matching the mutex
             -- enforced on POST /hold and POST /hold/bulk.
             on_hold = FALSE,
             hold_at = NULL,
             hold_by = NULL,
             hold_reason = NULL
       WHERE id = $3
         AND (deleted = false OR deleted IS NULL)
         AND payment_status IS DISTINCT FROM 'Paid'
       RETURNING id, payee, vendor_name, amount, currency, invoice_number,
                 artist, scheduled_payment_date, payment_method,
                 rush_requested, rush_requested_at, rush_requested_by, rush_reason,
                 on_hold, hold_at, hold_by, hold_reason`,
      [req.user.name || req.user.email || 'Unknown', reason || null, id]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        error: 'Entry not found, already paid, or deleted.',
      });
    }
    const row = rows[0];

    await logBkAction(req.user, 'payment_rush_requested', id, row.payee,
      'rush_requested', false, true, reason || null);

    res.json({ success: true, data: row });
  } catch (err) {
    console.error('POST /payments/:id/rush:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/bk/payments/:id/rush — clear the rush request (e.g. mistake,
// or admin acknowledges and removes the badge after handling).
router.delete('/payments/:id/rush', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
    if (!(await userCanActOnEntry(req.user, id))) {
      return res.status(403).json({ success: false, error: 'You do not have visibility into this entry' });
    }

    const { rows } = await pool.query(
      `UPDATE expenses
         SET rush_requested = FALSE,
             rush_requested_at = NULL,
             rush_requested_by = NULL,
             rush_reason = NULL
       WHERE id = $1
         AND (deleted = false OR deleted IS NULL)
       RETURNING id, payee, rush_requested`,
      [id]
    );

    if (!rows.length) return res.status(404).json({ success: false, error: 'Entry not found' });

    await logBkAction(req.user, 'payment_rush_cleared', id, rows[0].payee,
      'rush_requested', true, false, null);

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/payments/rush/bulk — bulk-request rush on multiple payments.
// Accepts a list of ids, filters to the ones the caller can actually act
// on (visibility), and flips rush_* on every eligible row in one SQL
// update. No notification email is sent — the rush badge on the Payment
// Dashboard plus the "Rush" quick-filter are the notification channel.
//
// Body: { ids: number[], reason?: string }
// Returns: { rushed: row[], rushedCount, skipped, invisible }
//   - rushed: full rows for each invoice we actually flipped to rush
//   - skipped: visible-to-user but ineligible (already paid / already rushed / deleted)
//   - invisible: ids the caller has no visibility on (rep-scoping rejected them)
router.post('/payments/rush/bulk', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0)
      : [];
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (!ids.length) return res.status(400).json({ success: false, error: 'No ids supplied' });

    // Per-row visibility check. The client only selects rows it can see, so
    // this is normally a no-op, but a malicious / out-of-date client could
    // include hidden ids. Loop is fine for bounded selection sizes.
    const visibleIds = [];
    for (const id of ids) {
      if (await userCanActOnEntry(req.user, id)) visibleIds.push(id);
    }
    if (!visibleIds.length) {
      return res.status(403).json({ success: false, error: 'No visible entries to rush' });
    }

    const requester = req.user.name || req.user.email || 'Unknown';
    const { rows } = await pool.query(
      `UPDATE expenses
         SET rush_requested = TRUE,
             rush_requested_at = NOW(),
             rush_requested_by = $1,
             rush_reason = $2,
             -- Mutex with hold (see POST /payments/:id/rush).
             on_hold = FALSE,
             hold_at = NULL,
             hold_by = NULL,
             hold_reason = NULL
       WHERE id = ANY($3::int[])
         AND (deleted = false OR deleted IS NULL)
         AND payment_status IS DISTINCT FROM 'Paid'
         AND (rush_requested = FALSE OR rush_requested IS NULL)
       RETURNING id, payee, vendor_name, amount, currency, invoice_number,
                 artist, scheduled_payment_date, payment_method,
                 rush_requested, rush_requested_at, rush_requested_by, rush_reason,
                 on_hold, hold_at, hold_by, hold_reason`,
      [requester, reason || null, visibleIds]
    );

    // One audit-log entry per affected row, so the audit trail reads the
    // same whether the rush came from the single-row or bulk endpoint.
    for (const row of rows) {
      await logBkAction(req.user, 'payment_rush_requested', row.id, row.payee,
        'rush_requested', false, true, reason || null);
    }

    // No notification email — the rush badge on the Payment Dashboard
    // (and the "Rush" quick-filter) is the notification channel. Removed
    // the prior consolidated email after John asked for the inbox to
    // stay quiet on rush requests.

    res.json({
      success: true,
      data: {
        rushed: rows,
        rushedCount: rows.length,
        skipped: visibleIds.length - rows.length,
        invisible: ids.length - visibleIds.length,
      },
    });
  } catch (err) {
    console.error('POST /payments/rush/bulk:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/payments/:id/hold — mark a row as on-hold. Opposite intent
// of rush: "don't pay yet." Held rows drop out of the Overdue and Due
// Soon quick-filters + their stat-card totals on the Payment Dashboard
// (still counted in Total Unpaid — the money is still owed). Mutually
// exclusive with rush — setting hold clears rush; auto-cleared on Paid
// (same trigger + CASE clauses as rush). Reason is optional (rush
// requires one; hold is a lighter-weight pause signal).
router.post('/payments/:id/hold', async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
    if (!(await userCanActOnEntry(req.user, id))) {
      return res.status(403).json({ success: false, error: 'You do not have visibility into this entry' });
    }

    const { rows } = await pool.query(
      `UPDATE expenses
         SET on_hold = TRUE,
             hold_at = NOW(),
             hold_by = $1,
             hold_reason = $2,
             -- Mutex with rush. Placing a hold clears any existing rush
             -- flag; the two states are contradictory.
             rush_requested = FALSE,
             rush_requested_at = NULL,
             rush_requested_by = NULL,
             rush_reason = NULL
       WHERE id = $3
         AND (deleted = false OR deleted IS NULL)
         AND payment_status IS DISTINCT FROM 'Paid'
       RETURNING id, payee, vendor_name, amount, currency, invoice_number,
                 artist, scheduled_payment_date, payment_method,
                 rush_requested, rush_requested_at, rush_requested_by, rush_reason,
                 on_hold, hold_at, hold_by, hold_reason`,
      [req.user.name || req.user.email || 'Unknown', reason || null, id]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        error: 'Entry not found, already paid, or deleted.',
      });
    }
    const row = rows[0];

    await logBkAction(req.user, 'payment_hold_placed', id, row.payee,
      'on_hold', false, true, reason || null);

    res.json({ success: true, data: row });
  } catch (err) {
    console.error('POST /payments/:id/hold:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/bk/payments/:id/hold — release the hold (row is ready to
// be paid again). Mirrors DELETE /payments/:id/rush.
router.delete('/payments/:id/hold', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
    if (!(await userCanActOnEntry(req.user, id))) {
      return res.status(403).json({ success: false, error: 'You do not have visibility into this entry' });
    }

    const { rows } = await pool.query(
      `UPDATE expenses
         SET on_hold = FALSE,
             hold_at = NULL,
             hold_by = NULL,
             hold_reason = NULL
       WHERE id = $1
         AND (deleted = false OR deleted IS NULL)
       RETURNING id, payee, on_hold`,
      [id]
    );

    if (!rows.length) return res.status(404).json({ success: false, error: 'Entry not found' });

    await logBkAction(req.user, 'payment_hold_released', id, rows[0].payee,
      'on_hold', true, false, null);

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/payments/hold/bulk — bulk-hold multiple payments. Mirrors
// POST /payments/rush/bulk; shared reason is optional.
router.post('/payments/hold/bulk', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0)
      : [];
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (!ids.length) return res.status(400).json({ success: false, error: 'No ids supplied' });

    const visibleIds = [];
    for (const id of ids) {
      if (await userCanActOnEntry(req.user, id)) visibleIds.push(id);
    }
    if (!visibleIds.length) {
      return res.status(403).json({ success: false, error: 'No visible entries to hold' });
    }

    const requester = req.user.name || req.user.email || 'Unknown';
    const { rows } = await pool.query(
      `UPDATE expenses
         SET on_hold = TRUE,
             hold_at = NOW(),
             hold_by = $1,
             hold_reason = $2,
             -- Mutex with rush (see POST /payments/:id/hold).
             rush_requested = FALSE,
             rush_requested_at = NULL,
             rush_requested_by = NULL,
             rush_reason = NULL
       WHERE id = ANY($3::int[])
         AND (deleted = false OR deleted IS NULL)
         AND payment_status IS DISTINCT FROM 'Paid'
         AND (on_hold = FALSE OR on_hold IS NULL)
       RETURNING id, payee, vendor_name, amount, currency, invoice_number,
                 artist, scheduled_payment_date, payment_method,
                 rush_requested, rush_requested_at, rush_requested_by, rush_reason,
                 on_hold, hold_at, hold_by, hold_reason`,
      [requester, reason || null, visibleIds]
    );

    for (const row of rows) {
      await logBkAction(req.user, 'payment_hold_placed', row.id, row.payee,
        'on_hold', false, true, reason || null);
    }

    res.json({
      success: true,
      data: {
        held: rows,
        heldCount: rows.length,
        skipped: visibleIds.length - rows.length,
        invisible: ids.length - visibleIds.length,
      },
    });
  } catch (err) {
    console.error('POST /payments/hold/bulk:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Installments ──────────────────────────────────────────────────────────────
// Multi-payment invoices. An installment is one real transaction against an
// expense (or the root of its split family). Adding an installment derives
// payment_status as Unpaid (0) → Partial → Paid; removing the last one
// reverts to Unpaid. Status cascades to the whole split family so the Ledger
// / Approvals / Recoupments views stay consistent.

// GET /api/bk/payments/:id/installments
router.get('/payments/:id/installments', async (req, res) => {
  try {
    if (!(await userCanActOnEntry(req.user, Number(req.params.id)))) {
      return res.status(403).json({ success: false, error: 'You do not have visibility into this entry' });
    }
    const ctx = await resolveFamilyRoot(req.params.id);
    if (!ctx) return res.status(404).json({ success: false, error: 'Entry not found' });
    const { rows } = await pool.query(
      `SELECT id, expense_id, amount::float AS amount, payment_date, payment_method,
              payment_ref, paid_by, proof_filename,
              (proof_r2_key IS NOT NULL) AS has_proof,
              notes, created_at, created_by
         FROM expense_payments
        WHERE expense_id = $1
        ORDER BY payment_date NULLS LAST, id`,
      [ctx.rootId]
    );
    const { rows: famRows } = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS total
         FROM expenses
        WHERE (id = $1 OR parent_id = $1)
          AND (deleted = false OR deleted IS NULL)`,
      [ctx.rootId]
    );
    const familyTotal = Number(famRows[0]?.total ?? 0);
    const paid = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
    res.json({
      success: true,
      data: {
        rootId: ctx.rootId,
        familyTotal,
        installmentsTotal: paid,
        remaining: Math.max(0, familyTotal - paid),
        installments: rows,
      },
    });
  } catch (err) {
    console.error('GET /api/bk/payments/:id/installments:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/payments/:id/installments
// multipart fields: amount, payment_date, payment_method, payment_ref, paid_by, notes
// optional file:    proof
router.post('/payments/:id/installments', upload.single('proof'), async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
  try {
    if (!(await userCanActOnEntry(req.user, Number(req.params.id)))) {
      return res.status(403).json({ success: false, error: 'You do not have visibility into this entry' });
    }
    const ctx = await resolveFamilyRoot(req.params.id);
    if (!ctx) return res.status(404).json({ success: false, error: 'Entry not found' });

    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: 'amount must be a positive number' });
    }

    const payment_date   = req.body.payment_date || null;
    const payment_method = req.body.payment_method || null;
    const payment_ref    = req.body.payment_ref || null;
    const paid_by        = (req.body.paid_by || req.user.name || '').trim() || null;
    const notes          = req.body.notes || null;

    // Optional proof file → R2 under the family root's key prefix.
    let proof_filename = null, proof_r2_key = null;
    if (req.file && req.file.buffer) {
      proof_filename = req.file.originalname;
      const safeName = proof_filename.replace(/[^a-zA-Z0-9._-]+/g, '_');
      proof_r2_key   = `vendors/${ctx.rootId}/installment_proof/${Date.now()}_${safeName}`;
      try {
        await uploadFile(proof_r2_key, req.file.buffer, req.file.mimetype);
      } catch (err) {
        return res.status(500).json({ success: false, error: 'Proof upload failed: ' + err.message });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: ins } = await client.query(
        `INSERT INTO expense_payments
           (expense_id, amount, payment_date, payment_method, payment_ref, paid_by,
            proof_filename, proof_r2_key, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, expense_id, amount::float AS amount, payment_date, payment_method,
                   payment_ref, paid_by, proof_filename,
                   (proof_r2_key IS NOT NULL) AS has_proof,
                   notes, created_at, created_by`,
        [ctx.rootId, amount, payment_date, payment_method, payment_ref, paid_by,
         proof_filename, proof_r2_key, notes, req.user.name || null]
      );

      // Mirror the new installment's method / ref / paid_by onto the summary
      // columns of the family. Keeps existing surfaces (Ledger, vendor pages,
      // payment confirmation email defaults) showing the most recent payment.
      await client.query(
        `UPDATE expenses
            SET payment_method = COALESCE($1, payment_method),
                payment_ref    = COALESCE(NULLIF($2,''), payment_ref),
                paid_by        = COALESCE(NULLIF($3,''), paid_by)
          WHERE (id = $4 OR parent_id = $4)
            AND (deleted = false OR deleted IS NULL)`,
        [payment_method, payment_ref, paid_by, ctx.rootId]
      );

      const summary = await recomputeFamilyPaymentStatus(ctx.rootId, client);
      await client.query('COMMIT');

      await logBkAction(req.user, 'installment_added', ctx.rootId, ctx.payee,
        'installments_total', null, String(summary.paid),
        `${summary.count} installment${summary.count === 1 ? '' : 's'} · status=${summary.status}`);

      res.json({ success: true, data: { installment: ins[0], summary } });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // Cleanup uploaded proof if the DB write failed.
      if (proof_r2_key) { try { await deleteFile(proof_r2_key); } catch (_) {} }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('POST /api/bk/payments/:id/installments:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/bk/installments/:installmentId
router.delete('/installments/:installmentId', async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
  const client = await pool.connect();
  try {
    const { rows: existing } = await client.query(
      `SELECT id, expense_id, amount::float AS amount, proof_r2_key
         FROM expense_payments WHERE id = $1`,
      [req.params.installmentId]
    );
    if (!existing.length) return res.status(404).json({ success: false, error: 'Installment not found' });
    const inst = existing[0];

    await client.query('BEGIN');
    await client.query('DELETE FROM expense_payments WHERE id = $1', [inst.id]);
    const summary = await recomputeFamilyPaymentStatus(inst.expense_id, client);
    await client.query('COMMIT');

    if (inst.proof_r2_key) { try { await deleteFile(inst.proof_r2_key); } catch (_) {} }

    const { rows: pr } = await pool.query('SELECT payee FROM expenses WHERE id = $1', [inst.expense_id]);
    await logBkAction(req.user, 'installment_removed', inst.expense_id, pr[0]?.payee,
      'installments_total', String(inst.amount), String(summary.paid),
      `${summary.count} installment${summary.count === 1 ? '' : 's'} · status=${summary.status}`);

    res.json({ success: true, data: { summary } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('DELETE /api/bk/installments/:installmentId:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/bk/installments/:installmentId/proof — stream the proof file from R2.
router.get('/installments/:installmentId/proof', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT proof_filename, proof_r2_key FROM expense_payments WHERE id = $1`,
      [req.params.installmentId]
    );
    if (!rows.length || !rows[0].proof_r2_key) {
      return res.status(404).json({ success: false, error: 'No proof on file' });
    }
    const { proof_filename, proof_r2_key } = rows[0];
    const buf = await loadFileBuffer(proof_r2_key, null);
    if (!buf) return res.status(404).json({ success: false, error: 'Proof file missing in storage' });

    const fname = proof_filename || 'proof';
    const ext = (fname.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    const mime = ext === 'pdf' ? 'application/pdf'
               : ext === 'png' ? 'image/png'
               : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
               : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${fname.replace(/"/g, '')}"`);
    res.send(buf);
  } catch (err) {
    console.error('GET /api/bk/installments/:installmentId/proof:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/payments/:id/send-confirmation
const {
  sendPaymentConfirmationEmail, sendBulkPaymentConfirmationEmail,
  buildPaymentConfirmationHtml, buildPaymentConfirmationSubject,
} = require('../services/email');

// Resolve the family root + computed family total for a payment confirmation.
// Splits (per-song / fee-vs-reimb / artist-breakdown) are internal — the
// vendor was billed once, so the email should show the original invoice
// total and pull files/metadata from the parent.
async function loadConfirmationContext(targetId) {
  const { rows: targetRows } = await pool.query(
    `SELECT id, parent_id FROM expenses WHERE id = $1`,
    [targetId]
  );
  if (!targetRows.length) return null;
  const rootId = targetRows[0].parent_id || targetRows[0].id;

  const { rows: rootRows } = await pool.query(
    `SELECT id, payee, vendor_email, vendor_name, amount, currency, invoice_number,
            payment_date, payment_method, boom_rep,
            invoice_data, invoice_r2_key, invoice_filename,
            proof_data, proof_r2_key, proof_filename
       FROM expenses WHERE id = $1`,
    [rootId]
  );
  if (!rootRows.length) return null;
  const root = rootRows[0];

  const { rows: famRows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS total
       FROM expenses
      WHERE (id = $1 OR parent_id = $1)
        AND (deleted = false OR deleted IS NULL)`,
    [rootId]
  );
  const familyTotal = Number(famRows[0]?.total ?? root.amount);
  const hasFamily = Math.abs(familyTotal - Number(root.amount)) > 0.001;
  return { rootId, root, familyTotal, hasFamily };
}

// Resolve a comma-separated email list to a clean comma-joined string. Each
// entry must match a basic RFC-ish address regex. Returns { cc, invalid }:
// `cc` is the canonicalized string (or null when empty); `invalid` is the
// first malformed entry or null.
function normalizeCc(input) {
  if (input == null) return { cc: null, invalid: null };
  const raw = String(input).trim();
  if (!raw) return { cc: null, invalid: null };
  const parts = raw.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const p of parts) if (!emailRe.test(p)) return { cc: null, invalid: p };
  return { cc: parts.join(', '), invalid: null };
}

// POST /api/bk/payments/:id/confirmation-preview
// Returns the rendered confirmation HTML + the default field values, so the
// Payment Dashboard modal can show a live preview and let users edit the
// To / CC / Subject / personal message before sending. Pure preview — no
// side effects.
router.post('/payments/:id/confirmation-preview', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    if (!(await userCanActOnEntry(req.user, Number(req.params.id)))) {
      return res.status(403).json({ success: false, error: 'You do not have visibility into this entry' });
    }

    const ctx = await loadConfirmationContext(req.params.id);
    if (!ctx) return res.status(404).json({ success: false, error: 'Entry not found' });
    const { root, familyTotal } = ctx;

    const vendorName = root.vendor_name || root.payee;
    const defaults = {
      to: root.vendor_email || '',
      cc: '',
      subject: buildPaymentConfirmationSubject({ vendorName, invoiceNumber: root.invoice_number }),
      message: '',
    };

    // Resolve rep CC when toggled on AND the user hasn't provided an explicit
    // cc override. Lets the modal default-fill the rep on first open.
    if (req.body?.cc_rep === true && root.boom_rep && (req.body.cc == null)) {
      const r = await pool.query('SELECT email FROM users WHERE LOWER(name) = LOWER($1) LIMIT 1', [root.boom_rep]).catch(() => ({ rows: [] }));
      if (r.rows.length) defaults.cc = r.rows[0].email;
    }
    // Saved vendor emails default into CC on first open (explicit cc
    // override wins — the user already saw and edited the chip list).
    if (req.body?.cc == null) {
      defaults.cc = await mergeVendorCc(root.payee, defaults.cc, defaults.to).catch(() => defaults.cc);
    }

    const to = req.body?.to != null ? String(req.body.to) : defaults.to;
    const cc = req.body?.cc != null ? String(req.body.cc) : defaults.cc;
    const subject = req.body?.subject != null ? String(req.body.subject) : defaults.subject;
    const message = req.body?.message != null ? String(req.body.message) : defaults.message;

    const html = buildPaymentConfirmationHtml({
      vendorName,
      amount: familyTotal,
      currency: root.currency,
      invoiceNumber: root.invoice_number,
      paymentDate: root.payment_date,
      paymentMethod: root.payment_method,
      personalMessage: message,
    });

    res.json({
      success: true,
      data: {
        to, cc, subject, message, html,
        defaults,
        vendorName,
        amount: familyTotal,
        currency: root.currency,
        invoiceNumber: root.invoice_number,
        paymentDate: root.payment_date,
        paymentMethod: root.payment_method,
        boomRep: root.boom_rep || null,
        hasInvoice: !!(root.invoice_filename && (root.invoice_r2_key || root.invoice_data)),
        hasProof: !!(root.proof_filename && (root.proof_r2_key || root.proof_data)),
      },
    });
  } catch (err) {
    console.error('POST /api/bk/payments/:id/confirmation-preview:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/payments/:id/send-confirmation', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    if (!(await userCanActOnEntry(req.user, Number(req.params.id)))) {
      return res.status(403).json({ success: false, error: 'You do not have visibility into this entry' });
    }

    // Pull the target to discover family membership (parent vs child).
    const { rows: targetRows } = await pool.query(
      `SELECT id, parent_id FROM expenses WHERE id = $1`,
      [req.params.id]
    );
    if (!targetRows.length) return res.status(404).json({ success: false, error: 'Entry not found' });
    const rootId = targetRows[0].parent_id || targetRows[0].id;

    // Pull the root row — files (invoice/proof), vendor metadata, and
    // invoice_number all live on the parent in a split family. Sending from
    // a child must still produce a vendor-facing email with the original
    // invoice total + attachments.
    const { rows: rootRows } = await pool.query(
      `SELECT id, payee, vendor_email, vendor_name, amount, currency, invoice_number,
              payment_date, payment_method, boom_rep,
              invoice_data, invoice_r2_key, invoice_filename,
              proof_data, proof_r2_key, proof_filename
       FROM expenses WHERE id = $1`,
      [rootId]
    );
    if (!rootRows.length) return res.status(404).json({ success: false, error: 'Entry not found' });
    const entry = rootRows[0];

    // Family total = root.amount + every non-deleted child's amount. Matches
    // what the vendor was originally invoiced — splits are an internal
    // bookkeeping construct (per-song / fee-vs-reimb / artist breakdown) and
    // the vendor should see the single number they billed.
    const { rows: famRows } = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS total
         FROM expenses
        WHERE (id = $1 OR parent_id = $1)
          AND (deleted = false OR deleted IS NULL)`,
      [rootId]
    );
    const familyTotal = Number(famRows[0]?.total ?? entry.amount);
    const hasFamily = Math.abs(familyTotal - Number(entry.amount)) > 0.001;

    if (!entry.vendor_email) return res.status(400).json({ success: false, error: 'No vendor email on file' });
    if (!entry.proof_r2_key && !entry.proof_data) return res.status(400).json({ success: false, error: 'Proof of payment not uploaded' });

    // Build attachments (always from the root — that's where files live).
    const attachments = [];
    if (entry.invoice_filename && (entry.invoice_r2_key || entry.invoice_data)) {
      const fname = entry.invoice_filename;
      const mime = fname.match(/\.pdf$/i) ? 'application/pdf' : fname.match(/\.png$/i) ? 'image/png' : 'image/jpeg';
      const data = await loadFileBase64(entry.invoice_r2_key, entry.invoice_data);
      if (data) attachments.push({ filename: fname, data, mimeType: mime });
    }
    if (entry.proof_filename && (entry.proof_r2_key || entry.proof_data)) {
      const fname = entry.proof_filename;
      const mime = fname.match(/\.pdf$/i) ? 'application/pdf' : fname.match(/\.png$/i) ? 'image/png' : 'image/jpeg';
      const data = await loadFileBase64(entry.proof_r2_key, entry.proof_data);
      if (data) attachments.push({ filename: fname, data, mimeType: mime });
    }

    // Resolve recipient / CC. Modal can override `to`, `cc`, `subject`, and
    // `message`. The legacy `cc_rep` boolean still default-fills the rep CC
    // for callers that don't pass an explicit `cc` (e.g. older clients).
    // Default for everything else: NOT to CC the rep.
    const toOverride = req.body?.to != null ? String(req.body.to).trim() : '';
    const subjectOverride = req.body?.subject != null ? String(req.body.subject).trim() : '';
    const messageOverride = req.body?.message != null ? String(req.body.message) : '';
    const htmlOverride = req.body?.html_override != null ? String(req.body.html_override) : '';

    const recipient = toOverride || entry.vendor_email;
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!recipient || !emailRe.test(recipient)) {
      return res.status(400).json({ success: false, error: 'Recipient email is missing or invalid.' });
    }

    let cc = null;
    if (req.body?.cc != null) {
      const { cc: norm, invalid } = normalizeCc(req.body.cc);
      if (invalid) return res.status(400).json({ success: false, error: `Invalid CC email: ${invalid}` });
      cc = norm;
    } else {
      if (req.body?.cc_rep === true && entry.boom_rep) {
        const repResult = await pool.query('SELECT email FROM users WHERE LOWER(name) = LOWER($1) LIMIT 1', [entry.boom_rep]).catch(() => ({ rows: [] }));
        if (repResult.rows.length) cc = repResult.rows[0].email;
      }
      // No explicit CC from the caller — fold in the vendor's saved emails.
      cc = await mergeVendorCc(entry.payee, cc || '', recipient).catch(() => cc) || null;
    }

    await sendPaymentConfirmationEmail({
      vendorName: entry.vendor_name || entry.payee,
      vendorEmail: entry.vendor_email,
      to: recipient,
      amount: familyTotal,
      currency: entry.currency,
      invoiceNumber: entry.invoice_number,
      paymentDate: entry.payment_date,
      paymentMethod: entry.payment_method,
      cc,
      subject: subjectOverride || undefined,
      personalMessage: messageOverride || undefined,
      htmlOverride: htmlOverride || undefined,
      attachments,
    });

    // Mark the whole family confirmed so siblings stop showing the button.
    await pool.query(
      `UPDATE expenses SET confirmation_sent = TRUE
        WHERE (id = $1 OR parent_id = $1)
          AND (deleted = false OR deleted IS NULL)`,
      [rootId]
    );

    const noteFragment = htmlOverride && htmlOverride.trim()
      ? ' — custom body'
      : (messageOverride && messageOverride.trim() ? ' — custom note' : '');
    // Non-fatal, like the bulk sender's. The email has left and the row is
    // marked; a failure to write the audit line must not turn that into a 500,
    // because the client reads a 500 as "it didn't send" and the next click
    // sends the vendor a second copy.
    await logBkAction(req.user, 'payment_confirmation_sent', Number(req.params.id),
      entry.payee, null, null, null,
      `Sent to ${recipient}${cc ? ` (CC ${cc})` : ' (no CC)'}${hasFamily ? ` — family total ${familyTotal} ${entry.currency || 'USD'}` : ''}${noteFragment}`)
      .catch((e) => console.error('[confirmation] audit line not written:', e.message));

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/bk/payments/:id/send-confirmation:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/payments/send-confirmations-bulk
// Body: { ids: number[], cc_rep?: boolean, cc?: string }
// Groups the given paid-and-not-yet-confirmed entries by vendor_email and
// sends one combined confirmation email per vendor (instead of N separate
// emails). Falls back to sending individual emails when a vendor only has
// one entry in the bundle. `cc` is an optional comma-separated list of extra
// recipients applied to every vendor email in the bundle — merged with the
// per-group rep CC and de-duplicated.
router.post('/payments/send-confirmations-bulk', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return res.status(400).json({ success: false, error: 'No ids provided' });
    {
      const blocked = await findInvisibleEntry(req.user, ids);
      if (blocked) {
        return res.status(403).json({
          success: false,
          error: `Selection includes an entry you don't have visibility into (id ${blocked.id}, rep ${blocked.boom_rep}).`,
        });
      }
    }
    const ccRep = req.body?.cc_rep === true;

    // Caller-supplied extra CCs. Validated once up front so a single bad
    // address fails the whole batch with a clear error instead of silently
    // dropping recipients on every email.
    let extraCcEmails = [];
    if (req.body?.cc != null && String(req.body.cc).trim()) {
      const { cc: norm, invalid } = normalizeCc(req.body.cc);
      if (invalid) return res.status(400).json({ success: false, error: `Invalid CC email: ${invalid}` });
      if (norm) extraCcEmails = norm.split(/\s*,\s*/).filter(Boolean);
    }
    const mergeCcs = (...sources) => {
      const seen = new Set(); const out = [];
      for (const src of sources) {
        if (!src) continue;
        const parts = Array.isArray(src) ? src : String(src).split(/\s*,\s*/);
        for (const p of parts) {
          const k = (p || '').trim().toLowerCase();
          if (!k || seen.has(k)) continue;
          seen.add(k); out.push(p.trim());
        }
      }
      return out.length ? out.join(', ') : null;
    };

    // Resolve to family roots so a split invoice is one line per email — and
    // the family total is used (not the bare parent share). Selecting both
    // parent + child of the same split de-dupes to one entry here.
    const { rows: entries } = await pool.query(
      `WITH roots AS (
         SELECT DISTINCT COALESCE(parent_id, id) AS root_id
           FROM expenses
          WHERE id = ANY($1::int[])
            AND (deleted = false OR deleted IS NULL)
       )
       SELECT p.id, p.payee, p.vendor_email, p.vendor_name, p.currency,
              p.invoice_number, p.payment_date, p.payment_method, p.boom_rep,
              p.confirmation_sent,
              p.invoice_data, p.invoice_r2_key, p.invoice_filename,
              p.proof_data, p.proof_r2_key, p.proof_filename,
              (p.amount + COALESCE(
                (SELECT SUM(c.amount) FROM expenses c
                  WHERE c.parent_id = p.id
                    AND (c.deleted = false OR c.deleted IS NULL)), 0)
              ) AS amount
         FROM roots r
         JOIN expenses p ON p.id = r.root_id
        WHERE (p.deleted = false OR p.deleted IS NULL)`,
      [ids]
    );

    // Filter to entries that are eligible: have vendor_email + proof, and
    // haven't already been confirmed.
    const eligible = entries.filter(e =>
      e.vendor_email &&
      (e.proof_r2_key || e.proof_data) &&
      !e.confirmation_sent
    );
    if (!eligible.length) {
      return res.status(400).json({ success: false, error: 'No eligible entries (need vendor email + proof, and not already confirmed).' });
    }

    // Group by vendor_email (case-insensitive).
    const groups = new Map();
    for (const e of eligible) {
      const key = e.vendor_email.toLowerCase().trim();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }

    const results = { sent: 0, vendors: 0, errors: [] };

    for (const [, group] of groups) {
      const first = group[0];
      // Resolve rep CC from the first entry's boom_rep when toggle is on,
      // then merge with the caller-supplied extra CC list (dropping the
      // vendor email itself so we don't CC the To recipient).
      let repCc = null;
      if (ccRep && first.boom_rep) {
        const r = await pool.query('SELECT email FROM users WHERE LOWER(name) = LOWER($1) LIMIT 1', [first.boom_rep]).catch(() => ({ rows: [] }));
        if (r.rows.length) repCc = r.rows[0].email;
      }
      const vendorLower = String(first.vendor_email || '').toLowerCase();
      let groupCc = mergeCcs(repCc, extraCcEmails.filter(e => e.toLowerCase() !== vendorLower));
      // Fold in the vendor's saved extra emails (vendor_emails table) — but
      // only when the caller didn't hand us an explicit CC list (an explicit
      // list means the user already reviewed the chips and their edit wins).
      if (!extraCcEmails.length) {
        groupCc = await mergeVendorCc(first.payee, groupCc || '', first.vendor_email).catch(() => groupCc) || null;
      }

      // Build per-item attachments.
      const items = [];
      for (const e of group) {
        const attachments = [];
        if (e.invoice_filename && (e.invoice_r2_key || e.invoice_data)) {
          const fname = e.invoice_filename;
          const mime = fname.match(/\.pdf$/i) ? 'application/pdf' : fname.match(/\.png$/i) ? 'image/png' : 'image/jpeg';
          const data = await loadFileBase64(e.invoice_r2_key, e.invoice_data);
          if (data) attachments.push({ filename: fname, data, mimeType: mime });
        }
        if (e.proof_filename && (e.proof_r2_key || e.proof_data)) {
          const fname = e.proof_filename;
          const mime = fname.match(/\.pdf$/i) ? 'application/pdf' : fname.match(/\.png$/i) ? 'image/png' : 'image/jpeg';
          const data = await loadFileBase64(e.proof_r2_key, e.proof_data);
          if (data) attachments.push({ filename: fname, data, mimeType: mime });
        }
        items.push({
          invoiceNumber: e.invoice_number,
          amount: e.amount,
          currency: e.currency,
          paymentDate: e.payment_date,
          paymentMethod: e.payment_method,
          attachments,
        });
      }

      // Audit trail of exactly what amount went out per invoice in this
      // email — handy when a vendor / admin disputes whether an edit
      // landed before the email rendered.
      const auditTrail = group.map(e => `#${e.invoice_number || e.id}=${e.amount} ${e.currency || 'USD'}`).join(', ');
      console.log(`[bulk confirmation] ${first.vendor_email} (${group.length} items): ${auditTrail}`);

      try {
        if (items.length === 1) {
          // Single-item: keep the existing one-invoice template.
          await sendPaymentConfirmationEmail({
            vendorName: first.vendor_name || first.payee,
            vendorEmail: first.vendor_email,
            amount: items[0].amount,
            currency: items[0].currency,
            invoiceNumber: items[0].invoiceNumber,
            paymentDate: items[0].paymentDate,
            paymentMethod: items[0].paymentMethod,
            cc: groupCc,
            attachments: items[0].attachments,
          });
        } else {
          await sendBulkPaymentConfirmationEmail({
            vendorName: first.vendor_name || first.payee,
            vendorEmail: first.vendor_email,
            items,
            cc: groupCc,
          });
        }

        // Mark the entire family (root + every child) confirmed for each
        // sent invoice. Group's `id` is now the family root after the dedupe
        // above, so we cascade with parent_id IN (...) as well.
        const groupIds = group.map(e => e.id);
        await pool.query(
          `UPDATE expenses SET confirmation_sent = TRUE
            WHERE (id = ANY($1::int[]) OR parent_id = ANY($1::int[]))
              AND (deleted = false OR deleted IS NULL)`,
          [groupIds]
        );
        // Per-entry audit row records the exact amount + currency that was
        // sent, so we can reconcile "did the vendor see X or Y?" later.
        for (const e of group) {
          await logBkAction(req.user, 'payment_confirmation_sent', e.id,
            e.payee, 'amount_sent', null, `${e.amount} ${e.currency || 'USD'}`,
            `Bulk-sent to ${e.vendor_email}${repCc ? ` (CC ${repCc})` : ' (no CC)'} — group of ${items.length}, amount=${e.amount} ${e.currency || 'USD'}`).catch(() => {});
        }
        results.sent += groupIds.length;
        results.vendors += 1;
      } catch (err) {
        results.errors.push({ vendor_email: first.vendor_email, error: err.message });
      }
    }

    res.json({ success: true, data: results });
  } catch (err) {
    console.error('POST /api/bk/payments/send-confirmations-bulk:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/payments/:id/mark-sent
router.post('/payments/:id/mark-sent', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    if (!(await userCanActOnEntry(req.user, Number(req.params.id)))) {
      return res.status(403).json({ success: false, error: 'You do not have visibility into this entry' });
    }
    await pool.query('UPDATE expenses SET confirmation_sent = TRUE WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/payments/:id/mark-unsent
// Flip confirmation_sent back to FALSE so the row reappears as pending with
// the Send button. Useful when an email went out with stale data and the
// admin needs to re-send after editing.
router.post('/payments/:id/mark-unsent', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    if (!(await userCanActOnEntry(req.user, Number(req.params.id)))) {
      return res.status(403).json({ success: false, error: 'You do not have visibility into this entry' });
    }
    const { rows } = await pool.query(
      'UPDATE expenses SET confirmation_sent = FALSE WHERE id = $1 RETURNING payee',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Entry not found' });
    await logBkAction(req.user, 'payment_confirmation_unsent', Number(req.params.id),
      rows[0].payee, 'confirmation_sent', 'TRUE', 'FALSE',
      'Reset to pending so confirmation can be re-sent').catch(() => {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/payments/mark-unsent-bulk
// Body: { ids: number[] } OR { vendor_email: 'foo@bar' } OR
//       { payee: 'Vendor Name' }. Resets confirmation_sent for matching
// rows. Convenience for the "we just sent the wrong amount, bring them
// all back" case.
router.post('/payments/mark-unsent-bulk', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : null;
    const vendorEmail = typeof req.body?.vendor_email === 'string' && req.body.vendor_email.trim() ? req.body.vendor_email.trim() : null;
    const payee = typeof req.body?.payee === 'string' && req.body.payee.trim() ? req.body.payee.trim() : null;
    if (!ids?.length && !vendorEmail && !payee) {
      return res.status(400).json({ success: false, error: 'Provide ids[], vendor_email, or payee' });
    }
    if (ids?.length) {
      const blocked = await findInvisibleEntry(req.user, ids);
      if (blocked) {
        return res.status(403).json({
          success: false,
          error: `Selection includes an entry you don't have visibility into (id ${blocked.id}, rep ${blocked.boom_rep}).`,
        });
      }
    }

    const conditions = ['confirmation_sent = TRUE'];
    const params = [];
    if (ids?.length) { params.push(ids); conditions.push(`id = ANY($${params.length}::int[])`); }
    if (vendorEmail) { params.push(vendorEmail); conditions.push(`LOWER(vendor_email) = LOWER($${params.length})`); }
    if (payee)       { params.push(payee);       conditions.push(`LOWER(payee) = LOWER($${params.length})`); }
    // For the vendor_email / payee branches (no explicit ids), tack on
    // the rep-block filter so an Approver can't bulk-reset blocked
    // entries by passing a payee that matches them.
    const repBlock = userVisibleRepsClause(req.user, params, null);
    if (repBlock) conditions.push(repBlock);

    const { rows } = await pool.query(
      `UPDATE expenses SET confirmation_sent = FALSE WHERE ${conditions.join(' AND ')} RETURNING id, payee`,
      params
    );
    for (const r of rows) {
      await logBkAction(req.user, 'payment_confirmation_unsent', r.id, r.payee,
        'confirmation_sent', 'TRUE', 'FALSE', 'Bulk reset').catch(() => {});
    }
    res.json({ success: true, data: { reset: rows.length, ids: rows.map(r => r.id) } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Analytics ─────────────────────────────────────────────────────────────────

// GET /api/bk/analytics
router.get('/analytics', async (req, res) => {
  try {
    // Label-level spend analytics — totals by category, by month, by artist.
    // There is no rep-scoped version of "what did the label spend": narrowing
    // the rows would hand back a number that looks like the label's and is not.
    // So this is a role gate rather than a row filter, matching how the bank
    // balances are kept off the Approver surfaces.
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Bookkeeping access required' });
    const { from, to, category, artist } = req.query;
    // Voided rows stay in the ledger for the audit trail but must not
    // count as spend — same rule as GET /entries.
    const conditions = ["status = 'approved'", '(deleted = false OR deleted IS NULL)', '(voided = false OR voided IS NULL)'];
    const params = [];

    if (from)     { params.push(from);     conditions.push(`invoice_date >= $${params.length}`); }
    if (to)       { params.push(to);       conditions.push(`invoice_date <= $${params.length}`); }
    if (category) { params.push(category); conditions.push(`category = $${params.length}`); }
    if (artist)   { params.push(`%${artist}%`); conditions.push(`artist ILIKE $${params.length}`); }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const [byCategory, byArtist, byMonth, paymentSummary] = await Promise.all([
      pool.query(`SELECT category, SUM(amount) AS total, COUNT(*) AS count FROM expenses ${where} GROUP BY category ORDER BY total DESC`, params),
      pool.query(`SELECT TRIM(artist) AS artist, SUM(amount) AS total, COUNT(*) AS count FROM expenses ${where} AND artist IS NOT NULL AND TRIM(artist) != '' GROUP BY TRIM(artist) ORDER BY total DESC LIMIT 20`, params),
      pool.query(`SELECT TO_CHAR(DATE_TRUNC('month', invoice_date), 'YYYY-MM') AS month, SUM(amount) AS total, COUNT(*) AS count FROM expenses ${where} AND invoice_date IS NOT NULL GROUP BY DATE_TRUNC('month', invoice_date) ORDER BY month ASC`, params),
      pool.query(`SELECT payment_status, SUM(amount) AS total, COUNT(*) AS count FROM expenses ${where} GROUP BY payment_status`, params),
    ]);

    const totals = byCategory.rows.reduce((acc, r) => acc + parseFloat(r.total || 0), 0);
    const totalPaid    = paymentSummary.rows.find(r => r.payment_status === 'Paid')?.total || 0;
    const totalUnpaid  = paymentSummary.rows.find(r => r.payment_status === 'Unpaid')?.total || 0;

    res.json({
      success: true,
      data: {
        by_category:     byCategory.rows,
        by_artist:       byArtist.rows,
        by_month:        byMonth.rows,
        payment_summary: paymentSummary.rows,
        total_spend:     totals,
        total_paid:      parseFloat(totalPaid),
        total_unpaid:    parseFloat(totalUnpaid),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── History / Audit ───────────────────────────────────────────────────────────

// GET /api/bk/approval-history — recent approval/rejection actions
router.get('/approval-history', async (req, res) => {
  try {
    // The audit trail of who approved and rejected what. An audit log is only
    // useful whole, and a partial one is misleading, so it is gated rather than
    // filtered.
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Bookkeeping access required' });
    const { rows } = await pool.query(`
      SELECT * FROM bk_audit_log
      WHERE action IN ('expense_approved', 'expense_approved_split', 'expense_rejected', 'bulk_approved')
      ORDER BY ts DESC LIMIT 50
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// (Removed /bk/history and /bk/history/clear — the standalone History page was
// deprecated in favor of the unified Activity feed. bk_audit_log is still
// written to and powers /bk/approval-history + /entries/:id/audit.)

// ── W9s ───────────────────────────────────────────────────────────────────────

// GET /api/bk/w9s
router.get('/w9s', async (req, res) => {
  try {
    // Vendor tax documents. A W9 belongs to a VENDOR, not to a rep, so there is
    // no honest way to slice this list by rep — and it carries legal names and
    // tax status. Gated.
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Bookkeeping access required' });
    const { rows } = await pool.query(`
      SELECT
        payee,
        BOOL_OR((w9_data IS NOT NULL AND w9_data != '') OR w9_r2_key IS NOT NULL) AS has_w9,
        MAX(invoice_date) AS last_invoice,
        MAX(vendor_email) AS vendor_email,
        COUNT(*) FILTER (WHERE status = 'approved') AS invoice_count
      FROM expenses
      WHERE (deleted = false OR deleted IS NULL)
        AND payee IS NOT NULL AND payee != ''
        AND status = 'approved'
        -- Creators are not vendors. This directory is DERIVED from expenses.payee,
        -- so without the filter every creator paid $40 on /bk/creators joins the
        -- 418 real vendors that carry W9s, payment terms and aliases. Creators
        -- have their own directory, where a PayPal handle and socials have a home.
        AND ${excludeCreatorRows('expenses')}
      GROUP BY payee
      ORDER BY payee ASC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 1099 ──────────────────────────────────────────────────────────────────────

// 1099 reporting threshold by TAX YEAR. The OBBBA (July 2025) raised the
// 1099-NEC / 1099-MISC threshold from $600 to $2,000 for payments made in
// calendar years beginning after 2025, indexed for inflation thereafter.
//
// So the threshold is a function of the year, not a constant — running a 2025
// report at the 2026 number under-reports, and vice versa. The old code
// hardcoded 600 while dead client code used 2000; they disagreed.
//
// CONFIRM WITH THE ACCOUNTANT before filing: this encodes our reading of the
// statute, and inflation indexing may move the 2027+ figure.
const threshold1099 = (year) => (Number(year) >= 2026 ? 2000 : 600);

// GET /api/bk/1099?year=YYYY
//
// A 1099 reports what you PAID a vendor during a calendar year. Every part of
// that sentence was wrong before:
//
//   • bucketed on invoice_date, so a December invoice paid in January landed in
//     the wrong tax year
//   • no payment_status filter, so UNPAID invoices were counted as paid money
//   • SUM(amount) across mixed currencies, so a €5,000 invoice added as 5000
//   • reimbursements included, though reimbursing a documented expense is
//     generally not 1099-reportable
//   • aliases not rolled up, so one vendor under two spellings could sit below
//     the threshold twice and never be reported at all
//
// What it still CANNOT do: exclude corporations. 1099-NEC isn't issued to
// C/S-corps (attorneys excepted), and entity type is nowhere in the schema —
// w9_scan captures only payee / email / address. Every row therefore carries
// entity_type_known: false, and the response says how many vendors need that
// review. Better to report the gap than to imply a filing-ready list.
// The one implementation. Both the JSON report and the Excel export call it,
// so an export can never disagree with the screen it was exported from — the
// old code had two separate queries with two different bugs.
async function compute1099(year) {
  {
    const threshold = threshold1099(year);

    // Payment basis: what actually left in this calendar year. Reimbursements
    // are fetched (not filtered out in SQL) so they can be reported as an
    // explicit exclusion rather than silently vanishing.
    const { rows } = await pool.query(`
      SELECT e.id, e.parent_id, e.payee, e.amount, COALESCE(e.currency, 'USD') AS currency,
             e.fx_rate_to_usd, e.payment_date, e.category, e.vendor_email,
             COALESCE(e.is_reimbursement, false) AS is_reimbursement
        FROM expenses e
       WHERE e.status = 'approved'
         AND (e.deleted = false OR e.deleted IS NULL)
         AND (e.voided = false OR e.voided IS NULL)
         AND e.payment_status = 'Paid'
         AND e.payment_date IS NOT NULL
         AND EXTRACT(YEAR FROM e.payment_date) = $1
         AND e.payee IS NOT NULL AND TRIM(e.payee) <> ''
    `, [year]);

    // Alias rollup: "Eddie Marange" and "Edward Marange" are one payee for
    // 1099 purposes. Without this, a vendor split across spellings can sit
    // under the threshold twice — the failure mode that loses a filing.
    const { rows: aliasRows } = await pool.query(
      'SELECT primary_name, alias FROM vendor_aliases').catch(() => ({ rows: [] }));
    const aliasTo = new Map(aliasRows.map(a => [String(a.alias).trim().toLowerCase(), a.primary_name]));
    const canonical = (payee) => aliasTo.get(String(payee).trim().toLowerCase()) || String(payee).trim();

    // W9 on file is a per-VENDOR fact across all time, not just this year's
    // rows — the same cross-entry sharing rule the rest of the app uses.
    //
    // Resolved through lib/w9-owner rather than a DISTINCT over payees, because
    // the page now needs to OPEN the document and not merely know it exists:
    // that helper answers both questions at once — does this vendor have a W-9,
    // and WHICH ENTRY holds it — and it is the app's one definition of the
    // alias walk (a form filed under a legal name covers the trading name and
    // vice versa). Writing a third copy of that walk is what its header exists
    // to prevent.
    //
    // It is stricter than the DISTINCT it replaces in one way: it skips rejected
    // entries. That is the definition every other surface already uses, so this
    // makes the 1099 page agree with the Approvals deck and the vendor list
    // rather than quietly holding its own opinion.
    // (resolved below, once the vendor list exists — it takes the payees as
    //  input, so it cannot run before the rollup that produces them)

    // The tax identity read off those forms — the two fields a filing needs.
    //
    // Folded onto the CANONICAL payee for the same reason the money is: a
    // vendor filed under two spellings has one TIN, and rolling the money
    // together while leaving the TIN under the other spelling produces a
    // reportable vendor with no number on them.
    //
    // Newest scan wins, and it is never the encrypted value that comes out
    // here: this builds the LIST, and a list does not need the number.
    const { rows: taxRows } = await pool.query(`
      SELECT DISTINCT ON (LOWER(TRIM(payee)))
             payee, w9_tin_last4, w9_tin_type, w9_tax_classification,
             (w9_tin_enc IS NOT NULL) AS has_tin, w9_tax_scanned_at, vendor_address
        FROM expenses
       WHERE w9_tax_scanned_at IS NOT NULL
         AND (deleted = false OR deleted IS NULL)
       ORDER BY LOWER(TRIM(payee)), w9_tax_scanned_at DESC`);
    const taxByPayee = new Map();
    for (const t of taxRows) {
      const k = canonical(t.payee).toLowerCase();
      // First write wins per canonical key, and the rows arrive newest-first.
      if (!taxByPayee.has(k)) taxByPayee.set(k, t);
    }
    // An address is a filing field too, and it is NOT on the tax rows only —
    // most vendors' address sits on their ordinary invoices.
    const { rows: addrRows } = await pool.query(`
      SELECT DISTINCT ON (LOWER(TRIM(payee))) payee, vendor_address
        FROM expenses
       WHERE COALESCE(TRIM(vendor_address), '') <> ''
         AND (deleted = false OR deleted IS NULL)
       ORDER BY LOWER(TRIM(payee)), invoice_date DESC`);
    const addrByPayee = new Map();
    for (const a of addrRows) {
      const k = canonical(a.payee).toLowerCase();
      if (!addrByPayee.has(k)) addrByPayee.set(k, a.vendor_address);
    }

    const byVendor = new Map();
    for (const r of rows) {
      const key = canonical(r.payee);
      const k = key.toLowerCase();
      if (!byVendor.has(k)) {
        byVendor.set(k, {
          payee: key, total: 0, reimbursed_excluded: 0, invoice_count: 0,
          vendor_email: null, categories: {}, currencies: new Set(),
        });
      }
      const v = byVendor.get(k);
      // Locked fx_rate_to_usd first — the rate as of the payment day.
      const usd = usdOf(r.amount, r.currency, r.fx_rate_to_usd);
      if (r.is_reimbursement) {
        v.reimbursed_excluded += usd;
      } else {
        v.total += usd;
        // Count invoice FAMILIES, not rows, so a split isn't three invoices.
        if (!r.parent_id) v.invoice_count += 1;
        v.categories[r.category || 'Uncategorized'] = (v.categories[r.category || 'Uncategorized'] || 0) + usd;
      }
      v.currencies.add(String(r.currency).toUpperCase());
      if (!v.vendor_email && r.vendor_email) v.vendor_email = r.vendor_email;
    }

    // Now that the vendors are known, ask which entry holds each one's W-9.
    // Deliberately here and not above: it takes the payee list as its input, and
    // reading `byVendor` before the loop that fills it is a temporal-dead-zone
    // throw on every request — the shape that has taken two pages white in this
    // repo, and one `node --check` will not catch it.
    const w9Owners = await w9OwnersFor([...byVendor.values()].map((v) => v.payee));
    const w9Payees = new Set([...w9Owners.keys()]);

    const round = (n) => Math.round(n * 100) / 100;
    const data = [...byVendor.values()]
      .map(v => ({
        payee: v.payee,
        total: round(v.total),
        reimbursed_excluded: round(v.reimbursed_excluded),
        invoice_count: v.invoice_count,
        vendor_email: v.vendor_email,
        w9_on_file: w9Payees.has(v.payee.toLowerCase()),
        currencies: [...v.currencies].sort(),
        // Rent goes on 1099-MISC box 1; nonemployee compensation on 1099-NEC
        // box 1. Reported as a category split rather than a single box guess,
        // because one vendor can be both.
        categories: Object.fromEntries(Object.entries(v.categories).map(([k, n]) => [k, round(n)])),
        needs_1099: round(v.total) >= threshold,
        ...(() => {
          const t = taxByPayee.get(v.payee.toLowerCase()) || null;
          const cls = t?.w9_tax_classification || null;
          const ex = exemptionFor(cls, Object.keys(v.categories));
          return {
            // Which entry holds their W-9, so the page can open it. Named
            // `w9_entry_id` because that is what every other file URL in this
            // app is built from (`entry.w9_entry_id || entry.id`).
            w9_entry_id: w9Owners.get(v.payee.toLowerCase())?.id || null,
            w9_filename: w9Owners.get(v.payee.toLowerCase())?.w9_filename || null,
            tin_last4: t?.w9_tin_last4 || null,
            tin_type: t?.w9_tin_type || null,
            has_tin: t?.has_tin === true,
            tax_classification: cls,
            // The form answered line 3, so nobody has to.
            entity_type_known: !!cls,
            w9_tax_scanned_at: t?.w9_tax_scanned_at || null,
            address: addrByPayee.get(v.payee.toLowerCase()) || null,
            // NEVER a silent drop: the reason travels with the row and a person
            // can disagree with it. `exempt` false with a reason set is the
            // attorney/medical case — a corporation that IS reportable.
            exempt: ex?.exempt === true,
            exempt_code: ex?.code || null,
            exempt_reason: ex?.reason || null,
          };
        })(),
      }))
      .filter(v => v.total > 0)
      .sort((a, b) => b.total - a.total);

    // Three buckets, and the difference between them is the whole point:
    //   reportable   over the threshold and not exempt — these get a form
    //   exempt       over the threshold, and the FORM says no 1099 is due
    //   unfilable    over the threshold, not exempt, and missing what a filing
    //                needs (a TIN, or an address) — the chase list
    const reportable = data.filter(v => v.needs_1099 && !v.exempt);
    const exempt = data.filter(v => v.needs_1099 && v.exempt);
    const unfilable = reportable.filter(v => !v.has_tin || !v.address);
    return {
      data,
      year,
      meta: {
        basis: 'cash — payments made in the calendar year, by payment_date',
        threshold,
        threshold_note: year >= 2026
          ? 'OBBBA raised the 1099-NEC/MISC threshold to $2,000 for payments made after 2025. Confirm with your accountant.'
          : 'Pre-2026 threshold of $600. Confirm with your accountant.',
        reportable_count: reportable.length,
        reportable_total: round(reportable.reduce((s, v) => s + v.total, 0)),
        missing_w9: reportable.filter(v => !v.w9_on_file).length,
        // What a filing still cannot do, named rather than implied.
        missing_tin: reportable.filter(v => !v.has_tin).length,
        missing_address: reportable.filter(v => !v.address).length,
        unfilable_count: unfilable.length,
        unfilable_total: round(unfilable.reduce((s, v) => s + v.total, 0)),
        // Entity type now comes off line 3 of the form. What is left is the
        // vendors whose W-9 we have never read, or who have none — and that is
        // a number that goes DOWN when somebody runs the scan, unlike the old
        // "all of them" which never could.
        needs_entity_review: reportable.filter(v => !v.entity_type_known).length,
        entity_type_captured: true,
        exempt_count: exempt.length,
        exempt_total: round(exempt.reduce((s, v) => s + v.total, 0)),
        exempt_note: 'Excluded because the W-9 says so (corporation, or a foreign W-8 payee). '
          + 'Attorney and medical payments to a corporation stay IN the run — each exclusion carries its reason.',
        excludes: ['reimbursements', 'unpaid invoices', 'voided and deleted rows',
          'vendors whose W-9 reports a corporation (except attorney / medical spend)'],
      },
    };
  }
}

// GET /api/bk/1099?year=YYYY
router.get('/1099', async (req, res) => {
  try {
    // Already gated (Admin / Superadmin / Approver) — left as it was. The
    // fixture asserts it anyway, because "this one was already right" is a
    // claim worth re-checking whenever the ones next to it move.
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    res.json({ success: true, ...(await compute1099(year)) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Invoice search ────────────────────────────────────────────────────────────

// GET /api/bk/invoices
router.get('/invoices', async (req, res) => {
  try {
    const { search, from, to } = req.query;
    // `basis` picks which date column the from/to range filters on. Default
    // preserves the historical behavior (filter by invoice_date). The
    // Invoices View charts pass `basis=created_at` for the submissions chart
    // and `basis=payment_date` for the paid chart so a bar click filters
    // on the same column the chart was bucketed by.
    const allowedBases = { invoice_date: 'invoice_date', created_at: 'created_at', payment_date: 'payment_date' };
    const basisCol = allowedBases[String(req.query.basis || '').toLowerCase()] || 'invoice_date';
    // `status` picks the workflow bucket. Default 'approved' for backwards
    // compat with the existing Invoices View table. 'rejected' powers the
    // "Rejected invoices" subsection at the bottom of the same page.
    const allowedStatus = new Set(['approved', 'rejected', 'pending']);
    const status = allowedStatus.has(String(req.query.status || '').toLowerCase())
      ? String(req.query.status).toLowerCase()
      : 'approved';
    const conditions = [
      `e.status = '${status}'`,
      '(e.deleted = false OR e.deleted IS NULL)',
      '(e.voided = false OR e.voided IS NULL)',
    ];
    const params = [];

    if (from)   { params.push(from);   conditions.push(`e.${basisCol} >= $${params.length}`); }
    if (to)     { params.push(to);     conditions.push(`e.${basisCol} <= $${params.length}`); }
    // Rep scoping — see the note on GET /entries. A no-op for the three
    // bookkeeping roles; the reason it is here is that this endpoint lists the
    // same rows by another route.
    const repBlock = userVisibleRepsClause(req.user, params, 'e');
    if (repBlock) conditions.push(repBlock);
    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      conditions.push(`(e.payee ILIKE $${n} OR e.invoice_number ILIKE $${n} OR e.description ILIKE $${n} OR e.artist ILIKE $${n})`);
    }

    // Exclude child splits — show only parents/standalone entries with combined totals
    conditions.push('e.parent_id IS NULL');

    // For rejected rows, pull the most recent rejection record from the
    // audit log so the client can render "Rejected by X on Y — reason Z"
    // without a second query. Non-rejected rows short-circuit to NULL.
    const rejectionJoin = status === 'rejected'
      ? `LEFT JOIN LATERAL (
           SELECT ts, user_name, details
             FROM bk_audit_log
            WHERE entry_id = e.id AND action = 'expense_rejected'
            ORDER BY ts DESC LIMIT 1
         ) rj ON TRUE`
      : '';
    const rejectionCols = status === 'rejected'
      ? `, rj.ts AS rejected_at, rj.user_name AS rejected_by_name, rj.details AS reject_reason`
      : '';

    const { rows } = await pool.query(`
      SELECT e.id, e.invoice_date, e.payee, e.invoice_number, e.description, e.artist, e.currency,
             e.payment_status, e.status,
             (e.amount + COALESCE((SELECT SUM(c.amount) FROM expenses c WHERE c.parent_id = e.id AND (c.deleted = false OR c.deleted IS NULL)), 0)) AS amount,
             ((e.invoice_data IS NOT NULL AND e.invoice_data != '') OR e.invoice_r2_key IS NOT NULL) AS has_invoice,
             ((e.w9_data IS NOT NULL AND e.w9_data != '') OR e.w9_r2_key IS NOT NULL) AS has_w9,
             ((e.proof_data IS NOT NULL AND e.proof_data != '') OR e.proof_r2_key IS NOT NULL) AS has_proof,
             e.invoice_filename, e.w9_filename, e.proof_filename,
             (SELECT COUNT(*) FROM expenses c WHERE c.parent_id = e.id AND (c.deleted = false OR c.deleted IS NULL))::int AS split_count,
             (SELECT x.id FROM expenses x
              WHERE ((x.w9_data IS NOT NULL AND x.w9_data != '') OR x.w9_r2_key IS NOT NULL)
                AND (x.deleted = false OR x.deleted IS NULL)
                AND (
                  LOWER(TRIM(x.payee)) = LOWER(TRIM(e.payee))
                  OR LOWER(TRIM(x.payee)) IN (
                    SELECT LOWER(TRIM(va.alias)) FROM vendor_aliases va
                     WHERE LOWER(TRIM(va.primary_name)) = LOWER(TRIM(e.payee))
                    UNION
                    SELECT LOWER(TRIM(va.primary_name)) FROM vendor_aliases va
                     WHERE LOWER(TRIM(va.alias)) = LOWER(TRIM(e.payee))
                  )
                )
              ORDER BY x.id DESC LIMIT 1) AS w9_entry_id
             ${rejectionCols}
      FROM expenses e
      ${rejectionJoin}
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.invoice_date DESC NULLS LAST, e.id DESC
      LIMIT 200
    `, params);

    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Exports ───────────────────────────────────────────────────────────────────

// GET /api/bk/export — Bookkeeper-style workbook with two tabs (Unpaid + Paid).
//
// Layout matches the spreadsheet the bookkeeper already maintains: title
// rows, a two-row column-header band with grouped "Paid" + "Approval"
// sub-columns, and one row per real invoice (split children collapse into
// their parent's family total). Amounts are converted to USD on the fly
// using the cached FX rates so multi-currency invoices line up.
router.get('/export', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    // Same ?source= contract as /bk/entries, so a page's export contains the
    // page. An export that silently included the other 2,326 rows would be a
    // workbook that disagrees with the screen it was downloaded from — and this
    // one goes to the accountant.
    const src = req.query.source;
    if (src !== undefined && src !== 'bank' && src !== 'invoices') {
      return res.status(400).json({ success: false, error: "source must be 'bank' or 'invoices'" });
    }
    const sourceSql = src === 'bank' ? `AND e.entry_source = 'bank_statement'`
      : src === 'invoices' ? `AND e.entry_source IS DISTINCT FROM 'bank_statement'`
        : '';

    const ExcelJS = require('exceljs');
    const fxService = require('../services/fx');
    const fx = fxService.getCached();
    const rates = (fx && fx.rates) || { USD: 1 };

    // Family total = parent.amount + SUM(children.amount). The bookkeeper
    // sees one row per real-world invoice; per-artist splits are an internal
    // accounting construct. Installment columns surface partial-payment
    // progress: an invoice marked Partial still belongs in the Unpaid tab,
    // but the PAID Date/Amount/Via sub-columns should reflect what HAS been
    // paid so far.
    const { rows } = await pool.query(`
      SELECT e.id, e.invoice_date, e.payee, e.description, e.artist, e.song,
             e.invoice_number, e.amount, e.currency,
             e.payment_method, e.payment_date, e.payment_status, e.paid_by,
             e.scheduled_payment_date, e.boom_rep, e.notes, e.approved_by,
             e.approved_at, e.created_at, e.created_by,
             e.vendor_name, e.vendor_email, e.vendor_bank,
             ((e.w9_data IS NOT NULL AND e.w9_data != '') OR e.w9_r2_key IS NOT NULL) AS has_w9_direct,
             (SELECT 1 FROM expenses x
               WHERE (
                 LOWER(TRIM(x.payee)) = LOWER(TRIM(e.payee))
                 OR LOWER(TRIM(x.payee)) IN (
                   SELECT LOWER(TRIM(va.alias))        FROM vendor_aliases va WHERE LOWER(TRIM(va.primary_name)) = LOWER(TRIM(e.payee))
                   UNION
                   SELECT LOWER(TRIM(va.primary_name)) FROM vendor_aliases va WHERE LOWER(TRIM(va.alias))        = LOWER(TRIM(e.payee))
                 )
               )
                 AND ((x.w9_data IS NOT NULL AND x.w9_data != '') OR x.w9_r2_key IS NOT NULL)
                 AND (x.deleted = false OR x.deleted IS NULL)
               LIMIT 1) AS has_w9_vendor,
             (e.amount + COALESCE(
               (SELECT SUM(c.amount) FROM expenses c
                 WHERE c.parent_id = e.id
                   AND (c.deleted = false OR c.deleted IS NULL)), 0)
             ) AS family_amount,
             COALESCE(
               (SELECT string_agg(DISTINCT child.artist, ', ' ORDER BY child.artist)
                 FROM expenses child
                WHERE child.parent_id = e.id
                  AND child.artist IS NOT NULL
                  AND child.artist != ''
                  AND (child.deleted = false OR child.deleted IS NULL)),
               ''
             ) AS child_artists,
             -- Installments roll up onto the family root (parent.id).
             COALESCE((SELECT SUM(amount) FROM expense_payments
                        WHERE expense_id = e.id), 0)::float AS installments_total,
             COALESCE((SELECT COUNT(*)   FROM expense_payments
                        WHERE expense_id = e.id), 0)::int   AS installment_count,
             (SELECT payment_date FROM expense_payments
                WHERE expense_id = e.id
                ORDER BY payment_date DESC NULLS LAST, id DESC
                LIMIT 1) AS latest_installment_date,
             (SELECT payment_method FROM expense_payments
                WHERE expense_id = e.id
                ORDER BY payment_date DESC NULLS LAST, id DESC
                LIMIT 1) AS latest_installment_method
        FROM expenses e
       WHERE (e.deleted = false OR e.deleted IS NULL)
         AND (e.voided = false OR e.voided IS NULL)
         AND e.status = 'approved'
         AND e.parent_id IS NULL
         ${sourceSql}
       ORDER BY e.invoice_date DESC NULLS LAST, e.id DESC
    `);

    const toUsd = (amount, currency) => {
      const n = parseFloat(amount || 0);
      if (!Number.isFinite(n)) return 0;
      const cur = (currency || 'USD').toUpperCase();
      const rate = rates[cur];
      if (!rate || cur === 'USD') return n;
      return n / rate; // rates[currency] = 1 USD in foreign units → divide
    };
    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-US') : '';
    const yearTag = new Date().getFullYear();

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Market Street Dashboard';
    wb.created = new Date();

    // Single helper builds either tab. `paidMode` flips the title + filter +
    // which Paid sub-columns get filled. `yearTagOverride` lets the per-year
    // tabs ("2026", "PAID 2025") show their own year in the title band.
    const buildSheet = (sheetName, sourceRows, paidMode, yearTagOverride) => {
      const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 6 }] });
      const sheetYearTag = yearTagOverride ?? yearTag;

      // 23 columns: A through W
      const lastCol = 'W';
      const totalCols = 23;

      // Column widths
      const widths = [
        14, 14, 14, 28, 18, 38, 14, 30, 11,    // A-I
        14, 14,                                  // J-K  approval (date, by)
        14, 14, 12,                              // L-N  paid (date, amount, via)
        14, 24, 12, 24, 18, 14, 14, 14, 20,     // O-W
      ];
      widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

      // Row 1 — Big company title, white text on red
      ws.mergeCells(`A1:${lastCol}1`);
      const t1 = ws.getCell('A1');
      t1.value = 'MARKET STREET';
      t1.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
      t1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
      t1.alignment = { horizontal: 'center', vertical: 'middle' };
      ws.getRow(1).height = 26;

      // Row 2 — Section title with green tint
      ws.mergeCells(`A2:${lastCol}2`);
      const t2 = ws.getCell('A2');
      t2.value = paidMode
        ? `PAID INVOICES SUMMARY {${sheetYearTag}}`
        : `OUTSTANDING INVOICES SUMMARY {${sheetYearTag}}`;
      t2.font = { bold: true, size: 13, color: { argb: 'FF1F4E3D' } };
      t2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6F0C6' } };
      t2.alignment = { horizontal: 'center', vertical: 'middle' };
      ws.getRow(2).height = 22;

      // Row 3 — Week-ending date
      ws.getCell('B3').value = 'WEEK ENDING:';
      ws.getCell('B3').font = { bold: true, size: 11 };
      ws.getCell('B3').alignment = { horizontal: 'right' };
      ws.getCell('C3').value = new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      });
      ws.getCell('C3').font = { italic: true, size: 11 };

      // Row 4 — Spacer (kept blank for breathing room)
      ws.getRow(4).height = 8;

      // Rows 5-6 — Two-row header band. Single-row columns merge vertically;
      // grouped columns (Approval, Paid) span horizontally on row 5 and have
      // sub-labels on row 6.
      const HDR_TOP = 5;
      const HDR_BOT = 6;

      const headerFont = { bold: true, size: 10, color: { argb: 'FF1F2937' } };
      const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E6E6' } };
      const groupFillApproval = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
      const groupFillPaid     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
      const thinBorder = { top: { style: 'thin', color: { argb: 'FF9CA3AF' } }, left: { style: 'thin', color: { argb: 'FF9CA3AF' } }, bottom: { style: 'thin', color: { argb: 'FF9CA3AF' } }, right: { style: 'thin', color: { argb: 'FF9CA3AF' } } };

      const setSingleHeader = (col, label, fill) => {
        ws.mergeCells(`${col}${HDR_TOP}:${col}${HDR_BOT}`);
        const c = ws.getCell(`${col}${HDR_TOP}`);
        c.value = label;
        c.font = headerFont;
        c.fill = fill || headerFill;
        c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        c.border = thinBorder;
        // Border on the bottom-row cell too (it's merged but ExcelJS needs both
        // ends styled for some renderers)
        ws.getCell(`${col}${HDR_BOT}`).border = thinBorder;
      };
      const setGroupHeader = (startCol, endCol, label, subs, fill) => {
        ws.mergeCells(`${startCol}${HDR_TOP}:${endCol}${HDR_TOP}`);
        const top = ws.getCell(`${startCol}${HDR_TOP}`);
        top.value = label;
        top.font = headerFont;
        top.fill = fill;
        top.alignment = { horizontal: 'center', vertical: 'middle' };
        top.border = thinBorder;
        // Sub-labels on the bottom row
        const startIdx = startCol.charCodeAt(0) - 64;
        subs.forEach((sub, i) => {
          const col = String.fromCharCode(64 + startIdx + i);
          const c = ws.getCell(`${col}${HDR_BOT}`);
          c.value = sub;
          c.font = { ...headerFont, size: 9 };
          c.fill = fill;
          c.alignment = { horizontal: 'center', vertical: 'middle' };
          c.border = thinBorder;
        });
      };

      setSingleHeader('A', 'DATE\nSUBMITTED');
      setSingleHeader('B', 'DATE\nRECD');
      setSingleHeader('C', 'INVOICE #');
      setSingleHeader('D', 'VENDOR');
      setSingleHeader('E', 'ARTIST');
      setSingleHeader('F', 'DESCRIPTION');
      setSingleHeader('G', 'AMOUNT\n[USD]');
      setSingleHeader('H', 'NOTES /\nCOMMENTS');
      setSingleHeader('I', 'PRIORITY\n(HIGH/LOW)');
      setGroupHeader('J', 'K', 'INVOICE APPROVAL', ['DATE', 'BY'], groupFillApproval);
      setGroupHeader('L', 'N', 'PAID', ['DATE', 'AMOUNT', 'VIA'], groupFillPaid);
      setSingleHeader('O', 'DUE\nDATE');
      setSingleHeader('P', 'PAYEE NAME');
      setSingleHeader('Q', 'METHOD');
      setSingleHeader('R', 'EMAIL /\nPHONE');
      setSingleHeader('S', 'BANK');
      setSingleHeader('T', 'ROUTING');
      setSingleHeader('U', 'ACCT\nENDING');
      setSingleHeader('V', 'W9/W8');
      setSingleHeader('W', 'RECD FROM');

      ws.getRow(HDR_TOP).height = 28;
      ws.getRow(HDR_BOT).height = 18;

      // Data rows start at row 7
      const DATA_START = 7;
      let dataRow = DATA_START;
      let totalUsd = 0;

      for (const r of sourceRows) {
        const usd = toUsd(r.family_amount, r.currency);
        totalUsd += usd;
        // Merge child artists into the parent's artist field so a split
        // invoice shows all artists on one row.
        const allArtists = r.child_artists
          ? (r.artist ? `${r.artist}, ${r.child_artists}` : r.child_artists)
          : (r.artist || '');
        const w9Label = r.has_w9_direct || r.has_w9_vendor ? 'W9 ON FILE' : '';

        // Installment summary: when one or more partial payments have been
        // recorded against this invoice, the PAID columns reflect the
        // running total (USD) and most recent installment. For Partial
        // rows this means the bookkeeper sees what's been paid so far on
        // the Unpaid tab; for fully-paid rows the installment totals
        // override the legacy single payment_* fields.
        const hasInstallments = (r.installment_count || 0) > 0;
        const installCount = r.installment_count || 0;
        const installTotalUsd = toUsd(r.installments_total || 0, r.currency);

        // Append a partial-payment indicator to NOTES so the row reads
        // clearly without adding a new column. Skipped for fully paid rows
        // since the Paid columns already convey the full picture.
        let notesText = r.notes || '';
        if (r.payment_status === 'Partial' && hasInstallments) {
          const remaining = Math.max(0, usd - installTotalUsd);
          const partialNote = `PARTIAL: paid ${installTotalUsd.toFixed(2)} of ${usd.toFixed(2)} USD across ${installCount} payment${installCount === 1 ? '' : 's'} — balance ${remaining.toFixed(2)} USD`;
          notesText = notesText ? `${notesText}\n\n${partialNote}` : partialNote;
        }

        const row = ws.getRow(dataRow);
        row.getCell('A').value = fmtDate(r.created_at);
        row.getCell('B').value = fmtDate(r.invoice_date);
        row.getCell('C').value = r.invoice_number || '';
        row.getCell('D').value = r.payee || '';
        row.getCell('E').value = allArtists;
        row.getCell('F').value = r.description || '';
        row.getCell('G').value = usd;
        row.getCell('G').numFmt = '"$"#,##0.00';
        row.getCell('H').value = notesText;
        row.getCell('I').value = ''; // PRIORITY — manual
        row.getCell('J').value = fmtDate(r.approved_at);
        row.getCell('K').value = r.approved_by || '';

        // Paid sub-columns:
        //   • Fully Paid + installments → use installment totals (more
        //     accurate when paid in tranches)
        //   • Fully Paid + no installments → legacy single-payment fields
        //   • Partial + installments → show installment progress (Unpaid
        //     tab gets a populated PAID row so the bookkeeper can see
        //     what's been paid so far)
        //   • Otherwise blank
        if (hasInstallments) {
          row.getCell('L').value = fmtDate(r.latest_installment_date);
          row.getCell('M').value = installTotalUsd;
          row.getCell('M').numFmt = '"$"#,##0.00';
          // For multi-installment rows, "Multiple" reads cleaner than the
          // method of just the last one. Single installments show the method.
          row.getCell('N').value = installCount > 1
            ? `${installCount} payments`
            : (r.latest_installment_method || r.payment_method || '');
          // Tint the partial row's amount cell to draw the eye
          if (r.payment_status === 'Partial') {
            row.getCell('M').font = { italic: true, color: { argb: 'FF92400E' } };
          }
        } else if (r.payment_status === 'Paid') {
          row.getCell('L').value = fmtDate(r.payment_date);
          row.getCell('M').value = usd;
          row.getCell('M').numFmt = '"$"#,##0.00';
          row.getCell('N').value = r.payment_method || '';
        }
        row.getCell('O').value = fmtDate(r.scheduled_payment_date);
        row.getCell('P').value = r.vendor_name || r.payee || '';
        row.getCell('Q').value = r.payment_method || '';
        row.getCell('R').value = r.vendor_email || '';
        row.getCell('S').value = r.vendor_bank || '';
        row.getCell('T').value = ''; // ROUTING — not stored
        row.getCell('U').value = ''; // ACCT ENDING — not stored
        row.getCell('V').value = w9Label;
        row.getCell('W').value = r.boom_rep || r.created_by || '';

        // Subtle alternating row tint for readability
        if (dataRow % 2 === 0) {
          for (let i = 1; i <= totalCols; i++) {
            row.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAFA' } };
          }
        }
        row.alignment = { vertical: 'middle', wrapText: true };
        dataRow++;
      }

      // Totals row
      if (dataRow > DATA_START) {
        const totalRow = ws.getRow(dataRow);
        totalRow.getCell('F').value = 'TOTAL [USD]';
        totalRow.getCell('F').font = { bold: true };
        totalRow.getCell('F').alignment = { horizontal: 'right' };
        totalRow.getCell('G').value = totalUsd;
        totalRow.getCell('G').numFmt = '"$"#,##0.00';
        totalRow.getCell('G').font = { bold: true };
        totalRow.getCell('G').border = { top: { style: 'medium' } };
      }

      // Autofilter over the data range so the bookkeeper can sort/filter
      // by any column without redoing the header band.
      if (dataRow > DATA_START) {
        ws.autoFilter = {
          from: { row: HDR_BOT, column: 1 },
          to:   { row: dataRow - 1, column: totalCols },
        };
      }
    };

    // Group by year so the bookkeeper gets one tab per year (matching the
    // existing format). Unpaid rows bucket by invoice_date year; paid rows
    // bucket by payment_date year (cash-basis — when the money actually
    // moved), falling back to invoice_date when payment_date is missing.
    // Rows with no usable date land in a single "No Date" tab so they're
    // never silently dropped.
    const yearOfRow = (r, paidMode) => {
      const d = paidMode
        ? (r.payment_date || r.invoice_date)
        : r.invoice_date;
      if (!d) return null;
      const y = new Date(d).getFullYear();
      return Number.isFinite(y) ? y : null;
    };

    const unpaidByYear = new Map();
    const paidByYear   = new Map();
    for (const r of rows) {
      const isPaid = r.payment_status === 'Paid';
      const target = isPaid ? paidByYear : unpaidByYear;
      const y = yearOfRow(r, isPaid);
      const key = y == null ? 'No Date' : y;
      if (!target.has(key)) target.set(key, []);
      target.get(key).push(r);
    }

    // Sort years descending; keep "No Date" at the end of its group.
    const sortKeys = (m) => Array.from(m.keys()).sort((a, b) => {
      if (a === 'No Date') return 1;
      if (b === 'No Date') return -1;
      return b - a;
    });

    // Tab order: unpaid years first (newest → oldest), then paid years
    // (newest → oldest). Mirrors the bookkeeper's existing workbook.
    for (const y of sortKeys(unpaidByYear)) {
      buildSheet(String(y), unpaidByYear.get(y), false, y === 'No Date' ? '—' : y);
    }
    for (const y of sortKeys(paidByYear)) {
      buildSheet(`PAID ${y}`, paidByYear.get(y), true, y === 'No Date' ? '—' : y);
    }

    // Fallback: if there are zero approved invoices in the DB, still ship
    // a workbook with an empty Unpaid tab so the response is well-formed.
    if (!unpaidByYear.size && !paidByYear.size) {
      buildSheet(String(yearTag), [], false);
    }

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Disposition', `attachment; filename="marketst-ledger-${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('GET /api/bk/export:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/export-lookup — Excel export with lookup filters
//
// NO CALLER since the Expense Lookup page was removed. Kept because it is the
// only filtered Excel export in the app — /bk/export takes ?source= and nothing
// else — so deleting it would destroy the capability rather than relocate it.
// Reachable by URL. Wire it into the Ledger's export menu, or delete it, but
// don't leave it in this state indefinitely.
router.get('/export-lookup', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    const { artist, song, payee, category, from, to, search } = req.query;
    // Match every other export endpoint — pending vendor submissions stay
    // in the Approvals queue, not in lookup results; voided rows don't
    // count as spend.
    const conditions = ["e.status = 'approved'", '(e.deleted = false OR e.deleted IS NULL)', '(e.voided = false OR e.voided IS NULL)'];
    const params = [];

    if (artist) { params.push(`%${artist}%`); conditions.push(`e.artist ILIKE $${params.length}`); }
    if (song)   { params.push(`%${song}%`);   conditions.push(`e.song ILIKE $${params.length}`); }
    if (payee)  { params.push(`%${payee}%`);   conditions.push(`e.payee ILIKE $${params.length}`); }
    if (category) { params.push(category);     conditions.push(`e.category = $${params.length}`); }
    if (from) { params.push(from); conditions.push(`e.invoice_date >= $${params.length}`); }
    if (to)   { params.push(to);   conditions.push(`e.invoice_date <= $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      conditions.push(`(e.payee ILIKE $${n} OR e.description ILIKE $${n} OR e.invoice_number ILIKE $${n} OR e.artist ILIKE $${n})`);
    }

    const { rows } = await pool.query(`
      SELECT e.id, e.invoice_date, e.payee, e.description, e.category, e.artist, e.song,
             e.invoice_number, e.amount, e.currency, e.payment_method, e.payment_date,
             e.payment_status, e.paid_by, e.boom_rep, e.notes, e.status, e.cobrand
      FROM expenses e
      WHERE ${conditions.join(' AND ')} AND e.parent_id IS NULL
      ORDER BY e.invoice_date DESC NULLS LAST, e.id DESC
    `, params);

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Market Street Dashboard';
    wb.created = new Date();
    const ws = wb.addWorksheet('Expense Lookup', {
      views: [{ showGridLines: false }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } },
    });

    // Column definitions — keys map row-object properties to columns; widths
    // are tuned for typical content. Headers are added manually below so we
    // can sit them under a title block instead of forcing them into row 1.
    const cols = [
      { key: 'invoice_date',   header: 'Date',           width: 12 },
      { key: 'payee',          header: 'Payee',          width: 30 },
      { key: 'artist',         header: 'Artist',         width: 20 },
      { key: 'song',           header: 'Song',           width: 22 },
      { key: 'amount',         header: 'Amount',         width: 14 },
      { key: 'currency',       header: 'Currency',       width: 10 },
      { key: 'category',       header: 'Category',       width: 22 },
      { key: 'invoice_number', header: 'Invoice #',      width: 16 },
      { key: 'cobrand',        header: 'Cobrand',        width: 10 },
      { key: 'description',    header: 'Description',    width: 38 },
      { key: 'payment_method', header: 'Payment Method', width: 14 },
      { key: 'payment_date',   header: 'Payment Date',   width: 12 },
      { key: 'payment_status', header: 'Payment Status', width: 14 },
      { key: 'boom_rep',       header: 'Market Street Rep',       width: 14 },
      { key: 'notes',          header: 'Notes',          width: 30 },
    ];
    ws.columns = cols.map(c => ({ key: c.key, width: c.width }));
    const lastColLetter = ws.getColumn(cols.length).letter;

    // Title block (rows 1–3). Row 1 is the report title; row 2 the timestamp;
    // row 3 surfaces the filters that produced this view so the file is
    // self-explanatory when opened standalone.
    const titleRow = ws.addRow(['Market Street — Expense Lookup']);
    titleRow.height = 26;
    titleRow.font = { bold: true, size: 16, color: { argb: 'FF111111' } };
    ws.mergeCells(`A1:${lastColLetter}1`);
    titleRow.alignment = { vertical: 'middle', horizontal: 'left' };

    const tsRow = ws.addRow([`Generated ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}`]);
    tsRow.font = { italic: true, size: 10, color: { argb: 'FF6B7280' } };
    ws.mergeCells(`A2:${lastColLetter}2`);

    const filterBits = [];
    if (artist)   filterBits.push(`Artist: ${artist}`);
    if (song)     filterBits.push(`Song: ${song}`);
    if (payee)    filterBits.push(`Payee: ${payee}`);
    if (category) filterBits.push(`Category: ${category}`);
    if (from || to) filterBits.push(`Date: ${from || '…'} to ${to || '…'}`);
    if (search)   filterBits.push(`Search: ${search}`);
    const filterRow = ws.addRow([filterBits.length ? `Filters · ${filterBits.join(' · ')}` : 'Filters · (all expenses)']);
    filterRow.font = { size: 10, color: { argb: 'FF6B7280' } };
    ws.mergeCells(`A3:${lastColLetter}3`);

    // Header row at row 4.
    const HEADER_ROW = 4;
    const headerVals = cols.map(c => c.header);
    const header = ws.getRow(HEADER_ROW);
    header.values = headerVals;
    header.height = 22;
    header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
    header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    header.eachCell((cell) => {
      cell.border = {
        top:    { style: 'thin', color: { argb: 'FFB91C1C' } },
        bottom: { style: 'thin', color: { argb: 'FFB91C1C' } },
        left:   { style: 'thin', color: { argb: 'FFB91C1C' } },
        right:  { style: 'thin', color: { argb: 'FFB91C1C' } },
      };
    });

    // Freeze everything above row 5 + auto-filter on the header range, so the
    // file behaves like a real report when opened in Excel.
    ws.views = [{ state: 'frozen', xSplit: 0, ySplit: HEADER_ROW, topLeftCell: `A${HEADER_ROW + 1}`, activeCell: `A${HEADER_ROW + 1}`, showGridLines: false }];
    ws.autoFilter = `A${HEADER_ROW}:${lastColLetter}${HEADER_ROW}`;
    ws.pageSetup.printTitlesRow = `${HEADER_ROW}:${HEADER_ROW}`;

    // Currency-aware number formats — Excel can't auto-display a different
    // symbol per row, so format each cell individually instead of the column.
    const CURRENCY_FMT = {
      USD: '"$"#,##0.00',
      EUR: '"€"#,##0.00',
      GBP: '"£"#,##0.00',
      JPY: '"¥"#,##0',
      CAD: '"CA$"#,##0.00',
      AUD: '"A$"#,##0.00',
      MXN: '"MX$"#,##0.00',
      BRL: '"R$"#,##0.00',
      CHF: '"CHF "#,##0.00',
      SEK: '"kr "#,##0.00',
      NOK: '"kr "#,##0.00',
      DKK: '"kr "#,##0.00',
    };
    const fmtFor = (cur) => CURRENCY_FMT[cur] || `"${cur} "#,##0.00`;

    // Per-cell alignment by column key — keeps wide text columns left-aligned
    // and shorter code-like columns centered for legibility.
    const ALIGN = {
      invoice_date:   { horizontal: 'center', vertical: 'middle' },
      payee:          { horizontal: 'left',   vertical: 'middle' },
      artist:         { horizontal: 'left',   vertical: 'middle' },
      song:           { horizontal: 'left',   vertical: 'middle' },
      amount:         { horizontal: 'right',  vertical: 'middle' },
      currency:       { horizontal: 'center', vertical: 'middle' },
      category:       { horizontal: 'left',   vertical: 'middle' },
      invoice_number: { horizontal: 'center', vertical: 'middle' },
      cobrand:        { horizontal: 'center', vertical: 'middle' },
      description:    { horizontal: 'left',   vertical: 'top', wrapText: true },
      payment_method: { horizontal: 'center', vertical: 'middle' },
      payment_date:   { horizontal: 'center', vertical: 'middle' },
      payment_status: { horizontal: 'center', vertical: 'middle' },
      boom_rep:       { horizontal: 'center', vertical: 'middle' },
      notes:          { horizontal: 'left',   vertical: 'top', wrapText: true },
    };
    const THIN_BORDER = { style: 'thin', color: { argb: 'FFE5E7EB' } };

    rows.forEach((r, i) => {
      const cur = (r.currency || 'USD').toUpperCase();
      const row = ws.addRow({
        ...r,
        invoice_date: r.invoice_date ? new Date(r.invoice_date) : null,
        payment_date: r.payment_date ? new Date(r.payment_date) : null,
        amount: parseFloat(r.amount || 0),
        cobrand: r.cobrand ? 'Yes' : 'No',
      });
      const banded = i % 2 === 1;
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const key = cols[colNumber - 1]?.key;
        if (banded) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
        cell.border = { top: THIN_BORDER, bottom: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER };
        if (key && ALIGN[key]) cell.alignment = ALIGN[key];
      });
      row.getCell('invoice_date').numFmt = 'mm/dd/yyyy';
      row.getCell('payment_date').numFmt = 'mm/dd/yyyy';
      row.getCell('amount').numFmt = fmtFor(cur);
    });

    // Totals — bucketed by currency so a result set with USD + EUR + GBP rows
    // doesn't get added together under a single "$" sign. Each currency emits
    // its own TOTAL and (if applicable) COBRAND TOTAL row, formatted with the
    // matching symbol.

    const buckets = {}; // { USD: { total, cobrand }, EUR: {...} }
    for (const r of rows) {
      const cur = (r.currency || 'USD').toUpperCase();
      if (!buckets[cur]) buckets[cur] = { total: 0, cobrand: 0 };
      const amt = parseFloat(r.amount || 0);
      buckets[cur].total += amt;
      if (r.cobrand) buckets[cur].cobrand += amt;
    }
    const codes = Object.keys(buckets).sort((a, b) => buckets[b].total - buckets[a].total);

    const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
    const TOTAL_TOP  = { style: 'medium', color: { argb: 'FF9CA3AF' } };
    const styleTotalRow = (row, color) => {
      row.font = { bold: true, color: { argb: color }, size: 11 };
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.fill = TOTAL_FILL;
        cell.border = { top: TOTAL_TOP, bottom: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER };
        const key = cols[colNumber - 1]?.key;
        if (key === 'amount') cell.alignment = { horizontal: 'right', vertical: 'middle' };
        else if (key === 'payee') cell.alignment = { horizontal: 'right', vertical: 'middle' };
        else cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });
    };

    // Blank spacer row so totals visually detach from the data.
    if (rows.length) ws.addRow([]);

    for (const cur of codes) {
      const row = ws.addRow({ payee: `TOTAL (${cur})`, currency: cur, amount: buckets[cur].total });
      styleTotalRow(row, 'FF111111');
      row.getCell('amount').numFmt = fmtFor(cur);
    }
    for (const cur of codes) {
      if (!buckets[cur].cobrand) continue;
      const row = ws.addRow({ payee: `COBRAND TOTAL (${cur})`, currency: cur, amount: buckets[cur].cobrand });
      styleTotalRow(row, 'FF1D4ED8');
      row.getCell('amount').numFmt = fmtFor(cur);
    }

    const label = artist || song || payee || 'results';
    const safeName = String(label).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Disposition', `attachment; filename="expense-lookup-${safeName}-${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('GET /api/bk/export-lookup:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Recoupment notes ──────────────────────────────────────────────────────
// Overarching standing notes attached to an artist or to one of their songs.
// Lives in recoupment_notes (see server/index.js). song_key NULL = artist-
// level note; song_key set = per-song note under that artist. Keys are
// normalized to lowercase + trimmed so casing variants merge.

function normalizeNoteKey(s) {
  return String(s || '').trim().toLowerCase();
}

// ── POST /api/bk/entries/bulk  { ids, field, value } ─────────────────────────
//
// One field, many rows. The ledger had inline editing and nothing else, which is
// fine on the invoiced half — 1,414 of its 1,478 rows arrive with an artist
// already on them. On the bank half it is the whole problem: 1,919 of 1,972
// statement-born rows name no artist and NONE names a song, so the only way to
// answer them was 1,919 separate edits.
//
// Deliberately ONE field per call rather than a patch object. Every action here
// is "these forty rows are all Marketing" or "these twelve are all Jerri" — a
// single answer applied widely — and a multi-field bulk write is a much easier
// thing to fire by accident and a much harder one to undo.
//
// ── The whitelist ──
// `field` is checked against BULK_FIELDS and nothing else. A bulk endpoint that
// takes a column name from the request body is a way to write any column in the
// ledger, and `amount`, `payment_status` and `status` are all one typo from a
// silent restatement. Amounts are edited one row at a time on purpose.
//
// `payment_status` is absent for a second reason: it CASCADES to a whole split
// family in a transaction (see the payment-status PATCH), so bulk-setting it over
// a selection that contains two children of one parent would run the cascade
// twice over the same family. That needs its own design, not a list entry.
const BULK_FIELDS = {
  // Free text, and the two that feed release linking.
  artist:         { type: 'text',  col: 'artist' },
  song:           { type: 'text',  col: 'song' },
  category:       { type: 'text',  col: 'category' },
  payment_method: { type: 'text',  col: 'payment_method' },
  // Yes/No columns stored as TEXT, matching the single-row PUT's vocabulary.
  in_quickbooks:  { type: 'yesno', col: 'in_quickbooks' },
  // A real boolean.
  recoupable:     { type: 'bool',  col: 'recoupable' },
};
// `ufr` is NOT in that list, and must not be added: /entries/ufr-bulk below owns
// it because setting the flag is only half the write. `ufr_marked_at` is what the
// Recoupments page reads to decide which monthly statement an item rides on (the
// 20th-cutoff rule), and it has to be stamped on the way in, cleared on the way
// out, and PRESERVED on a re-claim. A generic column write would set the flag and
// land every item in no statement period at all.

router.post('/entries/bulk', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : [])
      .map(Number).filter(Number.isFinite).slice(0, 2000);
    if (!ids.length) return res.status(400).json({ success: false, error: 'ids required' });

    const field = String(req.body.field || '');
    const spec = BULK_FIELDS[field];
    if (!spec) {
      return res.status(400).json({ success: false,
        error: `field must be one of: ${Object.keys(BULK_FIELDS).join(', ')}` });
    }

    // Normalize the value per type, so the column never receives a shape the
    // single-row path would not have written.
    let value;
    if (spec.type === 'bool') {
      if (typeof req.body.value !== 'boolean') {
        return res.status(400).json({ success: false, error: `${field} must be true or false` });
      }
      value = req.body.value;
    } else if (spec.type === 'yesno') {
      const v = req.body.value;
      const yes = v === true || v === 'Yes' || v === 'yes';
      const no  = v === false || v === 'No' || v === 'no';
      if (!yes && !no) return res.status(400).json({ success: false, error: `${field} must be Yes or No` });
      value = yes ? 'Yes' : 'No';
    } else {
      value = req.body.value == null ? null : String(req.body.value).trim().slice(0, 255) || null;
    }

    // A COMMA IN A BULK SONG IS REFUSED.
    //
    // PUT /entries/:id auto-splits an entry when its song field gains a comma —
    // one row becomes one child per song, with the amount divided. That is the
    // right behaviour for one invoice covering two songs. Applied across a
    // selection it would turn one click into hundreds of new child rows, on rows
    // whose amounts nobody meant to divide, and there is no single action that
    // undoes it. So the endpoint says no rather than doing something enormous
    // quietly. Splitting stays a per-row decision.
    if (field === 'song' && value && value.includes(',')) {
      return res.status(400).json({ success: false,
        error: 'A song with a comma splits an entry into one row per song, which is a per-row decision — set these individually' });
    }

    // Read the OLD values first: they are the undo payload, and they decide
    // which rows are actually changing. Voided and deleted rows are out of
    // scope, the same as every other list endpoint here.
    const { rows: targets } = await pool.query(
      `SELECT id, payee, artist, song, ${spec.col} AS old_value
         FROM expenses
        WHERE id = ANY($1::int[])
          AND (deleted IS NULL OR deleted = FALSE)
          AND (voided IS NULL OR voided = FALSE)`, [ids]);
    if (!targets.length) return res.status(404).json({ success: false, error: 'No matching entries' });

    // Reported apart, because "set 40" and "set 4, 36 already were" are
    // different outcomes and the caller should be able to tell which happened.
    const norm = (v) => (v == null || v === '' ? null : (spec.type === 'bool' ? !!v : String(v)));
    const changing = targets.filter((t) => norm(t.old_value) !== norm(value));
    const already = targets.length - changing.length;

    if (changing.length) {
      await pool.query(
        `UPDATE expenses SET ${spec.col} = $2 WHERE id = ANY($1::int[])`,
        [changing.map((t) => t.id), value]);
    }

    // autoLinkRelease per row, exactly as the single-row PUT does when song or
    // artist changes. Skipping it here would leave bulk-edited rows with a stale
    // release_id while an identical inline edit updated it — the two paths have
    // to agree or the ledger disagrees with itself depending on how you typed.
    let relinked = 0;
    if (field === 'artist' || field === 'song') {
      const { rows: after } = await pool.query(
        `SELECT id, artist, song FROM expenses WHERE id = ANY($1::int[])`,
        [changing.map((t) => t.id)]);
      for (const r of after) {
        if (r.artist && r.song) {
          const linked = await autoLinkRelease(r.id, r.artist, r.song).catch(() => null);
          if (linked) relinked += 1;
        }
      }
    }

    // ONE audit row for the action, not one per entry: this was a single
    // decision, and 400 near-identical log lines bury the rest of the day.
    await logBkAction(req.user, 'expense_bulk_updated', null,
      `${changing.length} entr${changing.length === 1 ? 'y' : 'ies'}`,
      field, null, String(value),
      `Bulk set ${field} = ${value === null ? '(cleared)' : value} on ${changing.length} entr`
      + `${changing.length === 1 ? 'y' : 'ies'}`
      + (already ? ` — ${already} already had that value` : '')
      + (relinked ? ` — ${relinked} relinked to a release` : ''));

    res.json({ success: true, data: {
      field, value,
      changed: changing.length,
      already,
      requested: ids.length,
      skipped: Math.max(0, ids.length - targets.length),
      relinked,
      // The undo payload. Sent back so one bulk action is one undo rather than
      // N, and so a row that ALREADY held the new value is not "restored" to it.
      previous: changing.map((t) => ({ id: t.id, value: t.old_value })),
    } });
  } catch (err) {
    console.error('POST /api/bk/entries/bulk:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Settlement groups: "these invoices arrive as ONE payment" ────────────────
//
// John: "when 2 invoices are sent in one payment, how can I make note of this
// when uploading their invoices so it's an easy match when statements are
// uploaded?" Today you cannot, and the matcher is strictly 1:1 on an amount
// equal to the cent — so when two invoices are paid together NEITHER matches,
// because each is smaller than the payment. Those rows are found by hand.
//
// Marking a group is a declaration: the matcher may then sum the group and
// settle the line with all of it at once (see the marked-group tier in
// routes/statements.js). Live, 465 same-payee-same-date groups of 2+ invoices
// are already sitting in the ledger with nobody having connected any of them.
//
// ── Why its own endpoint and not /entries/bulk ──
// That route writes ONE whitelisted column across a selection, and BULK_FIELDS
// deliberately refuses anything payment-shaped. A settlement group is not a
// field value — it is a validated relationship BETWEEN rows (same vendor, family
// roots, 2+ members, none already settled elsewhere), and those checks live in
// lib/settlement-groups.js so the thing that CREATES a group and the matcher
// that ACTS on one cannot disagree about what a group is.
//
// POST   /api/bk/settlement-groups   { expense_ids }  → { group, members }
// DELETE /api/bk/settlement-groups/:group             → ungroups, nothing else
router.post('/settlement-groups', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const ids = (Array.isArray(req.body.expense_ids) ? req.body.expense_ids : []).map(Number);

    const check = await validateGroup(pool, ids);
    if (!check.ok) return res.status(400).json({ success: false, error: check.error });
    const members = check.members;

    // What those rows held before, so a member moved out of an older group can
    // leave it in a valid state rather than as a group of one.
    const { rows: before } = await pool.query(
      `SELECT id, payee, invoice_number, settlement_group FROM expenses WHERE id = ANY($1::int[])`, [members]);
    const oldGroups = [...new Set(before.map((r) => r.settlement_group).filter(Boolean))];

    // Reuse the key when this is the same group being re-confirmed, so the
    // Ledger's chip does not change identity under a no-op edit.
    const untouched = oldGroups.length === 1
      ? (await pool.query(
        `SELECT COUNT(*)::int AS n FROM expenses
          WHERE settlement_group = $1 AND NOT (id = ANY($2::int[]))
            AND (deleted = false OR deleted IS NULL) AND (voided = false OR voided IS NULL)`,
        [oldGroups[0], members])).rows[0].n
      : -1;
    const group = untouched === 0 ? oldGroups[0] : newGroupKey();

    await pool.query(`UPDATE expenses SET settlement_group = $1 WHERE id = ANY($2::int[])`, [group, members]);

    // A group of one is not a group — and left behind it would teach the matcher
    // that one invoice is owed a payment sized for several.
    const orphaned = [];
    for (const g of oldGroups) {
      if (g === group) continue;
      const { rows: left } = await pool.query(
        `SELECT id FROM expenses WHERE settlement_group = $1
           AND (deleted = false OR deleted IS NULL) AND (voided = false OR voided IS NULL)`, [g]);
      if (left.length < 2) {
        await pool.query(`UPDATE expenses SET settlement_group = NULL WHERE settlement_group = $1`, [g]);
        orphaned.push(g);
      }
    }

    const label = before.map((r) => r.invoice_number ? '#' + r.invoice_number : 'entry ' + r.id).join(', ');
    for (const r of before) {
      await logBkAction(req.user, 'settlement_group_set', r.id, r.payee,
        'settlement_group', r.settlement_group || null, group,
        `Marked as paid together with ${members.length - 1} other invoice${members.length === 2 ? '' : 's'} (${label})`
        + (orphaned.length ? `; group${orphaned.length === 1 ? '' : 's'} ${orphaned.join(', ')} dropped to one member and was cleared` : ''));
    }

    res.json({ success: true, data: { group, members, orphaned } });
  } catch (err) {
    console.error('POST /api/bk/settlement-groups:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/settlement-groups/:group', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const group = String(req.params.group || '').trim();
    if (!group) return res.status(400).json({ success: false, error: 'group required' });

    // Ungrouping only clears the marker. It deliberately does NOT unmatch
    // anything: if the group already settled a bank line, that settle stands on
    // its own link rows, and silently tearing it down here would unreconcile a
    // payment as a side effect of tidying up a label.
    const { rows } = await pool.query(
      `UPDATE expenses SET settlement_group = NULL WHERE settlement_group = $1
       RETURNING id, payee, invoice_number`, [group]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'No such group' });

    for (const r of rows) {
      await logBkAction(req.user, 'settlement_group_cleared', r.id, r.payee,
        'settlement_group', group, null,
        `No longer marked as paid together (group had ${rows.length} invoices)`);
    }
    res.json({ success: true, data: { group, cleared: rows.map((r) => r.id) } });
  } catch (err) {
    console.error('DELETE /api/bk/settlement-groups:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// GET /api/bk/recoupments/notes?artist=<name>
// Returns the artist-level note + a { songKey: note } map for that artist.
// POST /api/bk/entries/ufr-bulk  { ids: [], ufr: bool }
//
// Claim (or un-claim) many costs for recoupment in one action.
//
// Why it exists: 622 items worth $1,174,870.19 are bank-VERIFIED and have never
// been uploaded for recoupment — provable money nobody claimed. Clearing that with
// the per-row PUT is 622 requests, which is not a workflow, so the page could not
// offer the action and the money stayed unclaimed.
//
// The timestamp rule is LIFTED FROM the single-row PUT above and must stay
// identical: stamp on the transition INTO 'Yes', clear on the transition out, and
// PRESERVE it when a row is already 'Yes'. The Recoupments page derives which
// monthly statement an item belongs to from `ufr_marked_at` (the 20th-cutoff
// rule), so resetting it on a re-claim would silently move items between
// statements, and failing to set it would land them in none.
router.post('/entries/ufr-bulk', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : [])
      .map(Number).filter(Number.isFinite).slice(0, 2000);
    if (!ids.length) return res.status(400).json({ success: false, error: 'ids required' });
    if (typeof req.body.ufr !== 'boolean') {
      return res.status(400).json({ success: false, error: 'ufr must be true or false' });
    }
    const want = req.body.ufr ? 'Yes' : 'No';

    // Scoped to RECOUPABLE rows: "uploaded for recoupment" is meaningless on a
    // cost that is not recoupable, and a bulk endpoint taking arbitrary ids
    // should not be the way that gets set anyway.
    const { rows: targets } = await pool.query(
      `SELECT id, ufr FROM expenses
        WHERE id = ANY($1::int[])
          AND recoupable = TRUE
          AND (deleted IS NULL OR deleted = FALSE)
          AND (voided IS NULL OR voided = FALSE)`, [ids]);
    if (!targets.length) return res.status(404).json({ success: false, error: 'No matching recoupable entries' });

    // Reported separately, because "claimed 622" and "claimed 4, 618 already were"
    // are different outcomes and the caller should see which happened.
    const changing = targets.filter((t) => (t.ufr === 'Yes') !== (want === 'Yes'));
    const already = targets.length - changing.length;

    if (changing.length) {
      await pool.query(`
        UPDATE expenses
           SET ufr = $2,
               ufr_marked_at = CASE
                 WHEN $2 = 'Yes' AND ufr IS DISTINCT FROM 'Yes' THEN NOW()
                 WHEN $2 <> 'Yes' AND ufr = 'Yes' THEN NULL
                 ELSE ufr_marked_at
               END
         WHERE id = ANY($1::int[])`, [changing.map((t) => t.id), want]);
    }

    await pool.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1,$2,$3,$4,'ufr',NULL,$5,$6)`,
      [req.user.name, want === 'Yes' ? 'ufr_bulk_marked' : 'ufr_bulk_cleared',
        changing.length === 1 ? changing[0].id : null,
        `${changing.length} recoupable entr${changing.length === 1 ? 'y' : 'ies'}`,
        want,
        `${want === 'Yes' ? 'Uploaded for recoupment' : 'Removed from recoupment'} in bulk`
        + ` — ${changing.length} changed`
        + (already ? `, ${already} already ${want === 'Yes' ? 'claimed' : 'unclaimed'}` : '')]).catch(() => {});

    res.json({
      success: true,
      data: {
        ufr: want, changed: changing.length, already,
        requested: ids.length,
        // A gap means rows were not recoupable, or were deleted/voided under the
        // caller — said rather than silently absorbed.
        skipped: Math.max(0, ids.length - targets.length),
      },
    });
  } catch (err) {
    console.error('POST /api/bk/entries/ufr-bulk:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Is this bank-born cost recoupable? ──────────────────────────────────────
//
// Statement-born rows are kept off Recoupments because `recoupable` is
// BOOLEAN DEFAULT TRUE and bookDebitAsEntry never sets it — 1,972 rows arrive
// marked recoupable against nobody, $3,101,837 of it. A default is not a
// decision, so the recoupment surfaces admit a bank-born row only once somebody
// has ANSWERED the question.
//
// The queue is only rows that NAME AN ARTIST. A recoupable cost has to belong to
// someone; attributing bank spend is the Reports drill's job, and those rows
// arrive here afterwards. 53 qualify today ($94,439.69).

// GET /api/bk/recoup-review — the queue.
//
// It used to require an artist (`COALESCE(TRIM(e.artist),'') <> ''`), which made
// it unable to see the money that matters most. Measured 2026-08-20: of the 1,972
// unanswered statement rows, that clause admitted **53 ($94,455)** and left
// **1,919 ($3,022,524)** unreachable — not on the Recoupments page, not in this
// queue, not counted anywhere. Among them: 11 payments in `Advance`, worth
// $390,530.22, every one of them an artist's own money and the most recoupable
// thing a label has.
//
// So the artist gate is gone and the queue answers both questions at once — is
// this recoupable, and if so whose is it (see the POST's optional `artist`).
// What keeps the list finishable instead is `notClassRuledSql`: whole classes of
// spend that can never be recoupable (Royalties, Salary, partner draws, Rent)
// are declared once in `recoupment_class_rules` rather than clicked 63 times.
//
// Two derived fields exist so the person answering is not guessing:
//
//   artist_proposal — an artist that already carries recoupable money whose name
//     the payee contains. Koastle LLC → Koastle, Oxis Music, LLC → Oxis. It fires
//     on 4 of the 11 advances and on 9 rows of the whole pile, so it is a
//     convenience on a row a human is already reading and NOTHING more. It is
//     never applied for them: one shared 'PAYPAL' descriptor once filed 154 pulls
//     under the wrong vendor, and a payee is not an identity.
//
//   ledger_twin — is there an invoice-side row at the same payee and amount? True
//     on 28 pile rows ($26,382.40), including the Oxis Music LLC $10,000 advance,
//     which has ELEVEN ledger rows at that amount — a monthly $10,000 arrangement,
//     eight of them already claimed. Answering "recoupable" there would claim the
//     same cost twice, and the row cannot say so by itself.
router.get('/recoup-review', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows } = await pool.query(`
      SELECT e.id, e.invoice_date, e.payment_date, e.payee, e.description, e.category,
             e.artist, e.song, e.amount, e.currency, e.fx_rate_to_usd, e.recoupable,
             e.entry_source, e.parent_id,
             ${bankEvidenceCols('e')}
        FROM expenses e
       WHERE e.entry_source = 'bank_statement'
         AND COALESCE(e.recoup_reviewed, FALSE) = FALSE
         AND COALESCE(e.status, 'approved') = 'approved'
         AND (e.deleted IS NULL OR e.deleted = FALSE)
         AND (e.voided IS NULL OR e.voided = FALSE)
         AND ${notClassRuledSql('e')}
       ORDER BY (CASE WHEN e.fx_rate_to_usd > 0 THEN e.amount / e.fx_rate_to_usd
                      ELSE e.amount END) DESC NULLS LAST, e.id DESC`);
    // Both computed once for the whole list, not per row — see lib/recoup-context.
    const [proposals, twins] = await Promise.all([
      loadArtistProposals(pool), loadLedgerTwins(pool),
    ]);
    res.json({ success: true, data: attachRecoupContext(rows, { proposals, twins }) });
  } catch (err) {
    console.error('GET /api/bk/recoup-review:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/recoup-review  { ids: [], recoupable: bool }
//
// BOTH answers are decisions and both are recorded — "no" is as much an answer as
// "yes", and a row leaves the queue either way. Saying no also clears
// `recoupable`, so the row stops claiming to be recoupable anywhere else.
router.post('/recoup-review', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.id])
      .map(Number).filter(Number.isFinite).slice(0, 1000);
    if (!ids.length) return res.status(400).json({ success: false, error: 'ids required' });
    if (typeof req.body.recoupable !== 'boolean') {
      return res.status(400).json({ success: false, error: 'recoupable must be true or false' });
    }
    const keep = req.body.recoupable;
    // Optional `artist` — assigning the artist and answering "is this recoupable"
    // is ONE action for these rows, because for a bank-born row they are one
    // decision: an advance is recoupable *against somebody*, and answering yes
    // without a name puts money on a card nobody can bill. 1,919 of the 1,972
    // unanswered rows have no artist, so this is the normal case here, not an
    // edge one. Only ever what a person picked — `artist_proposal` on the GET is
    // a suggestion the client pre-fills, never a value the server assumes.
    const artist = typeof req.body.artist === 'string'
      ? req.body.artist.trim().slice(0, 255) : null;
    if (artist && !keep) {
      return res.status(400).json({ success: false,
        error: 'An artist only means something on a recoupable cost — answer recoupable, or leave the artist off' });
    }
    // Re-read server-side: this writes to the ledger and the caller's list can be
    // stale. Scoped to bank-born rows, because that is the only population this
    // gate is about — it must not be a back door for retyping invoices.
    const { rows: targets } = await pool.query(
      `SELECT id, payee, artist, recoupable FROM expenses
        WHERE id = ANY($1::int[]) AND entry_source = 'bank_statement'
          AND (deleted IS NULL OR deleted = FALSE) AND (voided IS NULL OR voided = FALSE)`, [ids]);
    if (!targets.length) return res.status(404).json({ success: false, error: 'No matching bank-born entries' });

    // COALESCE on the artist: a row that already names one keeps it. Bulk-
    // answering a selection must not overwrite the one row in it somebody had
    // already attributed by hand.
    await pool.query(
      `UPDATE expenses
          SET recoup_reviewed = TRUE, recoup_reviewed_at = NOW(), recoup_reviewed_by = $2,
              recoupable = $3,
              artist = CASE WHEN $4::text IS NULL THEN artist
                            ELSE COALESCE(NULLIF(TRIM(artist), ''), $4::text) END
        WHERE id = ANY($1::int[])`, [targets.map((t) => t.id), req.user.id, keep, artist]);

    await pool.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1,'recoup_reviewed',$2,$3,'recoupable',NULL,$4,$5)`,
      [req.user.name, targets.length === 1 ? targets[0].id : null,
        targets.length === 1 ? targets[0].payee : `${targets.length} bank rows`,
        String(keep),
        `Answered "is this recoupable?" for ${targets.length} statement-born row${targets.length === 1 ? '' : 's'}`
        + ` — ${keep ? 'recoupable, now on the artist' : 'NOT recoupable, cleared'}`
        + (artist ? ` — artist set to ${artist} where the row had none` : '')]).catch(() => {});

    res.json({ success: true, data: { reviewed: targets.length, recoupable: keep,
      artist: artist || null,
      requested: ids.length, skipped: Math.max(0, ids.length - targets.length) } });
  } catch (err) {
    console.error('POST /api/bk/recoup-review:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Categories where "this row names no artist" is a MISTAKE, not the normal state.
//
// Everywhere else in the bank pile a missing artist is ordinary — rent, cards,
// bank fees and label-level ad spend genuinely belong to nobody. In these
// categories the money IS an artist's by definition, so a row without a name is a
// recoupable cost with nobody to bill it to. Measured on the pile 2026-08-20:
// 13 rows, $391,958.60 — Advance 11/$390,530.22, Tour/Live 1/$903.38,
// Artist Expense - Recording 1/$525.00.
//
// `Artist Expense - %` is matched by PREFIX on purpose, unlike a class rule,
// which is equality-only. Four such categories are live (Legal, Other, PR,
// Recording) and the next one added should not silently fall out of this band —
// the prefix names the intent, so there is no ambiguity of the "TONE" / "Tone
// Pay, Inc" kind to trip over.
const RECOUP_ADVANCE_CATEGORIES = ['Advance', 'Recording', 'Tour/Live'];
const RECOUP_ADVANCE_CATEGORY_SQL = (e = 'e') =>
  `(${e}.category = ANY($1::text[]) OR ${e}.category LIKE 'Artist Expense - %')`;

// ── Never-recoupable classes of spend ────────────────────────────────────────
//
// See lib/recoupment-class.js for the measurement. Short version: the per-row
// gate above cannot finish, because 1,919 of the 1,972 unanswered statement rows
// name no artist and 560 of those are Bank Fees worth $3,251.43 between them.
// Eight category rules take $2,074,917 of Royalties / Salary / partner draws /
// Rent / cards off the queue and leave the two piles that are a real question:
// Advance ($390,530.22) and Marketing ($70,046.88).
//
// A rule writes nothing to the ledger and moves no money — those rows are
// already off the Recoupments page — so DELETE is a complete undo.
router.get('/recoupment-class-rules', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const rules = await loadRecoupmentClassRules(pool);
    res.json({ success: true, data: rules.rows });
  } catch (err) {
    console.error('GET /api/bk/recoupment-class-rules:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST { scope: 'vendor'|'category', keys: [...] | key, reason }
//
// Takes a LIST, because that is how these get made: you select the Salary and
// Rent groups in the queue and say "none of this is ever an artist's cost",
// which is two rules from one action.
router.post('/recoupment-class-rules', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const scope = String(req.body.scope || 'category');
    if (!['vendor', 'category'].includes(scope)) {
      return res.status(400).json({ success: false, error: "scope must be 'vendor' or 'category'" });
    }
    const keys = [...new Set([
      ...(Array.isArray(req.body.keys) ? req.body.keys : []),
      ...(req.body.key ? [req.body.key] : []),
    ].map((k) => String(k || '').trim()).filter(Boolean))].slice(0, 200);
    if (!keys.length) return res.status(400).json({ success: false, error: 'key or keys required' });
    const reason = String(req.body.reason || '').slice(0, 500) || null;

    const made = [];
    for (const key of keys) {
      const { rows } = await pool.query(
        `INSERT INTO recoupment_class_rules (scope, rule_key, reason, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (scope, rule_key) DO UPDATE
           SET reason = COALESCE(EXCLUDED.reason, recoupment_class_rules.reason)
         RETURNING id, scope, rule_key`, [scope, key, reason, req.user.id]);
      if (rows[0]) made.push(rows[0]);
    }
    await pool.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1,'recoup_class_rule_added',NULL,$2,'recoupable',NULL,$3,$4)`,
      [req.user.name, keys.join(', '), scope,
        `Declared never recoupable against an artist (${scope}): ${keys.join(', ')}`
        + ` — removes those rows from the recoupment review queue; nothing written to the ledger`
        + (reason ? ` — ${reason}` : '')]).catch(() => {});
    res.json({ success: true, data: { made } });
  } catch (err) {
    console.error('POST /api/bk/recoupment-class-rules:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE — the rows come straight back into the queue.
router.delete('/recoupment-class-rules/:id', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows } = await pool.query(
      `DELETE FROM recoupment_class_rules WHERE id = $1 RETURNING scope, rule_key`,
      [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Rule not found' });
    await pool.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1,'recoup_class_rule_removed',NULL,$2,'recoupable',$3,NULL,$4)`,
      [req.user.name, rows[0].rule_key, rows[0].scope,
        `No longer a never-recoupable class: ${rows[0].rule_key}`
        + ` — its rows return to the recoupment review queue`]).catch(() => {});
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('DELETE /api/bk/recoupment-class-rules/:id:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/bk/recoupment-audit ─────────────────────────────────────────────
//
// "What would make me sure nothing has been missed?" Five answers, one endpoint,
// because every one of them is a predicate about money and a predicate about
// money that lives in two places disagrees with itself eventually — the Reports
// 'unverified' rule lived in three files and the fix went into one.
//
// Two of the five are about money NOT claimed; three are about money claimed
// wrongly. Measured against production on 2026-08-20 (the figures the fixture
// asserts):
//
//   advances          11 rows   $390,530.22   bank-verified, no artist, unanswered
//   pile           1,919 rows $3,007,397.33   unanswered and unreachable until now
//   double_claims      9 grps    $30,760.97   3 of them span two artists
//   no_document       16 rows    $68,928.68   claimed with no file to show anyone
//   partial_families  10 fams     $6,239.00   half a payment claimed, half not
//
// What is deliberately NOT here: "claimed with no bank line" (48 rows,
// $141,891.83) already has a chip on the Recoupments page, and rebuilding it
// would give one condition two homes.
router.get('/recoupment-audit', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    // Live everywhere below. `entry_source IS NULL` on 1,201 hand-entered rows,
    // so `<> 'bank_statement'` is NULL for them and silently drops every invoice.
    const ALIVE = `(e.deleted IS NULL OR e.deleted = FALSE)
                   AND (e.voided IS NULL OR e.voided = FALSE)
                   AND COALESCE(e.status, 'approved') = 'approved'`;

    const [advRes, pileRes, claimedRes, famRes, rules, artistRes] = await Promise.all([
      // ── 1. Advances waiting for an artist ──
      // Scoped to the categories where "no artist" is an ERROR rather than the
      // normal state. An advance is an artist's own money by definition, so a
      // row here is not label overhead that happens to lack a name — it is a
      // recoupable cost with nobody to bill.
      pool.query(`
        SELECT e.id, e.payee, e.category, e.description, e.amount, e.currency,
               e.fx_rate_to_usd, e.invoice_date, e.payment_date, e.artist,
               ${bankEvidenceCols('e')}
          FROM expenses e
         WHERE e.entry_source = 'bank_statement'
           AND COALESCE(e.recoup_reviewed, FALSE) = FALSE
           AND COALESCE(TRIM(e.artist), '') = ''
           AND ${RECOUP_ADVANCE_CATEGORY_SQL('e')}
           AND ${ALIVE}
         ORDER BY (CASE WHEN e.fx_rate_to_usd > 0 THEN e.amount / e.fx_rate_to_usd
                        ELSE e.amount END) DESC NULLS LAST`, [RECOUP_ADVANCE_CATEGORIES]),

      // ── 2. The pile, by category, with what the rules already cover ──
      // Reported whole AND net so the page can say what a rule did. Grouped in
      // SQL rather than shipping 1,919 rows to be counted in the browser.
      pool.query(`
        SELECT COALESCE(NULLIF(TRIM(e.category), ''), '—') AS category,
               COUNT(*)::int AS n,
               SUM(CASE WHEN e.fx_rate_to_usd > 0 THEN e.amount / e.fx_rate_to_usd
                        ELSE e.amount END)::float8 AS usd,
               BOOL_OR(NOT (${notClassRuledSql('e')})) AS ruled
          FROM expenses e
         WHERE e.entry_source = 'bank_statement'
           AND COALESCE(e.recoup_reviewed, FALSE) = FALSE
           AND COALESCE(TRIM(e.artist), '') = ''
           AND ${ALIVE}
         GROUP BY 1
         ORDER BY 3 DESC NULLS LAST`),

      // ── 3 + 4. Every CLAIMED row, with whether its family holds a document ──
      // One query serves the double-claim sensor and the no-document band; both
      // read the same population and splitting them would let the two disagree.
      //
      // has_doc ORs the PARENT's file columns: a split child's invoice lives on
      // its parent, and checking the row alone once reported 78 missing where 23
      // were. Both storage paths are ORed too — R2 key or legacy base64.
      pool.query(`
        SELECT e.id, e.payee, e.artist, e.song, e.category, e.invoice_number,
               e.amount, e.currency, e.fx_rate_to_usd, e.invoice_date,
               e.payment_date, e.ufr_marked_at, e.parent_id, e.recoupment_label,
               (((e.invoice_data IS NOT NULL AND e.invoice_data <> '') OR e.invoice_r2_key IS NOT NULL)
                 OR ((p.invoice_data IS NOT NULL AND p.invoice_data <> '') OR p.invoice_r2_key IS NOT NULL)
               ) AS has_doc,
               ${bankEvidenceCols('e')}
          FROM expenses e
          LEFT JOIN expenses p ON p.id = e.parent_id
         WHERE e.ufr = 'Yes'
           AND COALESCE(e.recoupable, FALSE) = TRUE
           AND ${ALIVE}
           AND ${excludeBankRows('e')}`),

      // ── 5. Split families where part of one payment is claimed and part is not ──
      // The family root is COALESCE(parent_id, id). Only recoupable members are
      // considered: a family whose non-recoupable slice is unclaimed is correct,
      // not incomplete.
      pool.query(`
        SELECT COALESCE(e.parent_id, e.id) AS root_id,
               e.id, e.payee, e.artist, e.song, e.category, e.ufr,
               e.amount, e.currency, e.fx_rate_to_usd, e.invoice_date, e.parent_id
          FROM expenses e
         WHERE COALESCE(e.recoupable, FALSE) = TRUE
           AND ${ALIVE}
           AND ${excludeBankRows('e')}
           AND COALESCE(e.parent_id, e.id) IN (
             SELECT COALESCE(x.parent_id, x.id)
               FROM expenses x
              WHERE COALESCE(x.recoupable, FALSE) = TRUE
                AND (x.deleted IS NULL OR x.deleted = FALSE)
                AND (x.voided IS NULL OR x.voided = FALSE)
                AND COALESCE(x.status, 'approved') = 'approved'
              GROUP BY 1
             HAVING COUNT(*) > 1
                AND COUNT(*) FILTER (WHERE x.ufr = 'Yes') > 0
                AND COUNT(*) FILTER (WHERE x.ufr IS DISTINCT FROM 'Yes') > 0
           )
         ORDER BY root_id, e.id`),

      loadRecoupmentClassRules(pool),

      // The artist vocabulary for the advances picker. Sent with the audit so the
      // page is ONE fetch: the alternative is pulling 3,400 ledger rows into the
      // browser to collect 200 names. Most-used spelling first, which is the rule
      // `shapeByArtist` and Recoupments already follow, so the list offers the
      // name the rest of the app shows. The picker still accepts free text — an
      // advance can be the first cost an artist ever has.
      pool.query(`
        SELECT e.artist AS name, COUNT(*)::int AS n
          FROM expenses e
         WHERE COALESCE(TRIM(e.artist), '') <> ''
           AND (e.deleted IS NULL OR e.deleted = FALSE)
           AND (e.voided IS NULL OR e.voided = FALSE)
         GROUP BY e.artist
         ORDER BY n DESC, LOWER(e.artist) ASC
         LIMIT 400`),
    ]);

    const usd = (r) => usdOf(r.amount, r.currency, r.fx_rate_to_usd);
    // Round ONCE, at the end. Summing rounded parts broke a tie-out by exactly
    // a cent last time.
    const sum = (rows) => Math.round(rows.reduce((t, r) => t + usd(r), 0) * 100) / 100;

    // ── advances ──
    const [proposals, twins] = await Promise.all([
      loadArtistProposals(pool), loadLedgerTwins(pool),
    ]);
    const advances = attachRecoupContext(advRes.rows, { proposals, twins });

    // ── the pile ──
    const pileRows = pileRes.rows.map((r) => ({
      category: r.category, n: r.n,
      usd: Math.round((Number(r.usd) || 0) * 100) / 100,
      ruled: r.ruled === true,
    }));
    const pile = {
      by_category: pileRows,
      total_usd: Math.round(pileRows.reduce((t, r) => t + r.usd, 0) * 100) / 100,
      total_items: pileRows.reduce((t, r) => t + r.n, 0),
      covered_usd: Math.round(pileRows.filter((r) => r.ruled)
        .reduce((t, r) => t + r.usd, 0) * 100) / 100,
      covered_items: pileRows.filter((r) => r.ruled).reduce((t, r) => t + r.n, 0),
      rules: rules.rows,
    };
    pile.remaining_usd = Math.round((pile.total_usd - pile.covered_usd) * 100) / 100;
    pile.remaining_items = pile.total_items - pile.covered_items;

    // ── double claims ──
    // Same vendor, same invoice number, claimed more than once. A SENSOR, not a
    // verdict: three of the nine live groups look like genuinely separate
    // deliverables billed on one number. Cross-artist groups sort first, because
    // those are the ones where one cost may be charged to two people.
    const claimed = claimedRes.rows;
    const groups = new Map();
    for (const r of claimed) {
      const num = normalizeInvoiceNum(r.invoice_number || '');
      if (!num) continue; // no number is not evidence of anything
      const key = `${(r.payee || '').trim().toLowerCase()}|${num}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const double_claims = [...groups.values()]
      .filter((v) => v.length > 1)
      .map((v) => ({
        payee: v[0].payee,
        invoice_number: v[0].invoice_number,
        rows: v,
        artists: [...new Set(v.map((r) => (r.artist || '').trim()).filter(Boolean))],
        usd: sum(v),
      }))
      .map((g) => ({ ...g, cross_artist: g.artists.length > 1 }))
      .sort((a, b) => (b.cross_artist - a.cross_artist) || (b.usd - a.usd));

    // ── claimed with nothing to show ──
    const no_document = claimed.filter((r) => r.has_doc !== true)
      .sort((a, b) => usd(b) - usd(a));

    // ── half a payment claimed ──
    const byRoot = new Map();
    for (const r of famRes.rows) {
      if (!byRoot.has(r.root_id)) byRoot.set(r.root_id, []);
      byRoot.get(r.root_id).push(r);
    }
    const partial_families = [...byRoot.entries()].map(([root_id, members]) => {
      const claimedM = members.filter((m) => m.ufr === 'Yes');
      const openM = members.filter((m) => m.ufr !== 'Yes');
      const root = members.find((m) => m.id === root_id) || members[0];
      return {
        root_id, payee: root.payee, artist: root.artist, song: root.song,
        members, claimed_usd: sum(claimedM), open_usd: sum(openM),
        open_ids: openM.map((m) => m.id),
      };
    }).filter((f) => f.open_ids.length > 0 && f.claimed_usd > 0)
      .sort((a, b) => b.open_usd - a.open_usd);

    res.json({ success: true, data: {
      advances,
      pile,
      artist_options: artistRes.rows.map((r) => r.name),
      double_claims,
      no_document,
      partial_families,
      totals: {
        advances_usd: sum(advances), advances_items: advances.length,
        pile_usd: pile.remaining_usd, pile_items: pile.remaining_items,
        double_claims_usd: Math.round(double_claims
          .reduce((t, g) => t + g.usd, 0) * 100) / 100,
        double_claims_groups: double_claims.length,
        double_claims_cross_artist: double_claims.filter((g) => g.cross_artist).length,
        no_document_usd: sum(no_document), no_document_items: no_document.length,
        partial_families_usd: Math.round(partial_families
          .reduce((t, f) => t + f.open_usd, 0) * 100) / 100,
        partial_families_count: partial_families.length,
        partial_families_items: partial_families.reduce((t, f) => t + f.open_ids.length, 0),
      },
    } });
  } catch (err) {
    console.error('GET /api/bk/recoupment-audit:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/recoupments/notes', async (req, res) => {
  try {
    const artist = String(req.query.artist || '').trim();
    if (!artist) return res.status(400).json({ success: false, error: 'artist required' });
    const aKey = normalizeNoteKey(artist);
    const { rows } = await pool.query(
      `SELECT song_key, note, updated_at, updated_by
         FROM recoupment_notes
        WHERE artist_key = $1`,
      [aKey]
    );
    let artistNote = '';
    const songNotes = {};
    for (const r of rows) {
      if (r.song_key == null) artistNote = r.note || '';
      else songNotes[r.song_key] = r.note || '';
    }
    res.json({ success: true, data: { artistKey: aKey, artistNote, songNotes } });
  } catch (err) {
    console.error('GET /api/bk/recoupments/notes:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/bk/recoupments/notes
// body: { artist, song?, note }
// Upserts the note. Empty string deletes the row so the table doesn't carry
// dead entries forever.
router.put('/recoupments/notes', async (req, res) => {
  try {
    const artist = String(req.body?.artist || '').trim();
    if (!artist) return res.status(400).json({ success: false, error: 'artist required' });
    const aKey = normalizeNoteKey(artist);
    const songRaw = req.body?.song;
    const songKey = (songRaw == null || String(songRaw).trim() === '') ? null : normalizeNoteKey(songRaw);
    const note = String(req.body?.note || '');

    if (!note.trim()) {
      // Empty → delete.
      if (songKey == null) {
        await pool.query(
          `DELETE FROM recoupment_notes WHERE artist_key = $1 AND song_key IS NULL`,
          [aKey]
        );
      } else {
        await pool.query(
          `DELETE FROM recoupment_notes WHERE artist_key = $1 AND song_key = $2`,
          [aKey, songKey]
        );
      }
      return res.json({ success: true, data: { artistKey: aKey, songKey, note: '' } });
    }

    // Upsert. Two indexes (one for artist-only, one for artist+song) so the
    // ON CONFLICT target swaps based on whether song_key is null.
    if (songKey == null) {
      await pool.query(
        `INSERT INTO recoupment_notes (artist_key, song_key, note, updated_at, updated_by)
         VALUES ($1, NULL, $2, NOW(), $3)
         ON CONFLICT (artist_key) WHERE song_key IS NULL
         DO UPDATE SET note = EXCLUDED.note, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
        [aKey, note, req.user?.name || null]
      );
    } else {
      await pool.query(
        `INSERT INTO recoupment_notes (artist_key, song_key, note, updated_at, updated_by)
         VALUES ($1, $2, $3, NOW(), $4)
         ON CONFLICT (artist_key, song_key) WHERE song_key IS NOT NULL
         DO UPDATE SET note = EXCLUDED.note, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
        [aKey, songKey, note, req.user?.name || null]
      );
    }

    await logBkAction(req.user, songKey ? 'recoupment_song_note_set' : 'recoupment_artist_note_set',
      null, artist, songKey ? 'song_note' : 'artist_note', null, note.slice(0, 80),
      songKey ? `song=${songKey}` : null);

    res.json({ success: true, data: { artistKey: aKey, songKey, note } });
  } catch (err) {
    console.error('PUT /api/bk/recoupments/notes:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Unified per-artist meta (dismissal + priority) ─────────────────────────
// Single source of truth for both Recoupments and Artist Campaigns pages.
// Global state shared across users so the team works the same view. Keyed
// by lowercase-trimmed artist_key (the same key both pages use to group).
//
// Dismissed: Recoupments-only (Artist Campaigns has no dismiss concept).
// Priority:  shared across both pages — high/medium/low on one page is the
//            same value seen on the other.
const PRIORITY_LEVELS = new Set(['high', 'medium', 'low']);

// GET /api/bk/artist-meta
// Returns { [artist_key]: { dismissed, priority, ... } } for every row.
router.get('/artist-meta', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT artist_key, dismissed, dismissed_at, dismissed_by,
             priority, priority_updated_at, priority_updated_by,
             flagged, flagged_at, flagged_by, flag_reason,
             complete, complete_at, complete_by,
             ready_for_planning, ready_for_planning_at, ready_for_planning_by,
             (SELECT name FROM users WHERE id = dismissed_by) AS dismissed_by_name,
             (SELECT name FROM users WHERE id = priority_updated_by) AS priority_updated_by_name,
             (SELECT name FROM users WHERE id = flagged_by) AS flagged_by_name,
             (SELECT name FROM users WHERE id = complete_by) AS complete_by_name,
             (SELECT name FROM users WHERE id = ready_for_planning_by) AS ready_for_planning_by_name
        FROM artist_meta
    `);
    const map = {};
    for (const r of rows) map[r.artist_key] = r;
    res.json({ success: true, data: map });
  } catch (err) {
    console.error('GET /api/bk/artist-meta:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/bk/artist-meta  body: { artist, dismissed?, priority? }
// Partial-update upsert. Only touches fields the caller actually sent.
// Pass priority: null to clear it. Pass dismissed: false to restore.
//
// Rewritten from a single CASE-heavy upsert into TWO targeted upserts
// (one per field) — the old version had a maze of CASE WHEN nested
// across six parameters that was hard to reason about, and was the
// suspected cause of recurring "I can't change priority" reports.
// Splitting makes both paths trivial to read and impossible to silently
// no-op via a logic slip.
router.put('/artist-meta', async (req, res) => {
  try {
    const artist = String(req.body?.artist || '').trim();
    if (!artist) return res.status(400).json({ success: false, error: 'artist required' });
    const aKey = normalizeNoteKey(artist);

    const userId = req.user?.id || null;
    const hasDismissed = Object.prototype.hasOwnProperty.call(req.body, 'dismissed');
    const hasPriority  = Object.prototype.hasOwnProperty.call(req.body, 'priority');
    const hasFlagged   = Object.prototype.hasOwnProperty.call(req.body, 'flagged');
    const hasFlagReason = Object.prototype.hasOwnProperty.call(req.body, 'flag_reason');
    const hasComplete  = Object.prototype.hasOwnProperty.call(req.body, 'complete');
    const hasReady     = Object.prototype.hasOwnProperty.call(req.body, 'ready_for_planning');
    if (!hasDismissed && !hasPriority && !hasFlagged && !hasFlagReason && !hasComplete && !hasReady) {
      return res.status(400).json({ success: false, error: 'Nothing to update — pass dismissed, priority, flagged, flag_reason, complete, or ready_for_planning' });
    }

    let priority = null;
    if (hasPriority) {
      priority = req.body.priority;
      if (priority != null) {
        priority = String(priority).toLowerCase();
        if (!PRIORITY_LEVELS.has(priority)) {
          return res.status(400).json({ success: false, error: 'priority must be high | medium | low | null' });
        }
      }
    }
    const dismissed = hasDismissed ? !!req.body.dismissed : null;
    const flagged   = hasFlagged   ? !!req.body.flagged   : null;
    const complete  = hasComplete  ? !!req.body.complete  : null;
    // Cap reason at 500 chars — plenty for a review note, small enough
    // that a paste-bomb can't blow up the row.
    const flagReason = hasFlagReason
      ? (req.body.flag_reason == null ? null : String(req.body.flag_reason).slice(0, 500))
      : null;

    // Diagnostic log — surfaces every priority/dismiss/flag write on
    // Railway so we can correlate "I clicked but nothing happened"
    // reports with what actually hit the server.
    console.log('[artist-meta PUT]', JSON.stringify({
      aKey, userId, hasDismissed, hasPriority, hasFlagged, hasFlagReason,
      dismissed, priority, flagged, flagReason: flagReason?.slice(0, 60),
    }));

    // Ensure a row exists before either targeted update runs. Cheap
    // no-op on conflict; means the UPDATE branches below always have
    // something to write to. Explicit ::text cast on aKey so pg never
    // has to guess the column type.
    await pool.query(
      `INSERT INTO artist_meta (artist_key) VALUES ($1::text)
       ON CONFLICT (artist_key) DO NOTHING`,
      [aKey]
    );

    // Targeted PRIORITY update.
    if (hasPriority) {
      await pool.query(
        `UPDATE artist_meta
            SET priority            = $1::text,
                priority_updated_at = NOW(),
                priority_updated_by = $2::int
          WHERE artist_key = $3::text`,
        [priority, userId, aKey]
      );
    }

    // Targeted DISMISSED update — separate query so it can't accidentally
    // overwrite a priority that wasn't part of the request.
    if (hasDismissed) {
      await pool.query(
        `UPDATE artist_meta
            SET dismissed    = $1::bool,
                dismissed_at = CASE WHEN $1::bool THEN NOW() ELSE NULL END,
                dismissed_by = CASE WHEN $1::bool THEN $2::int ELSE NULL END
          WHERE artist_key = $3::text`,
        [dismissed, userId, aKey]
      );
    }

    // Targeted FLAG update — flips the boolean, stamps who/when, and
    // clears the reason if the flag is being cleared. Reason can also
    // be updated on its own (without toggling the flag) by sending
    // just flag_reason.
    if (hasFlagged) {
      await pool.query(
        `UPDATE artist_meta
            SET flagged    = $1::bool,
                flagged_at = CASE WHEN $1::bool THEN NOW() ELSE NULL END,
                flagged_by = CASE WHEN $1::bool THEN $2::int ELSE NULL END,
                flag_reason = CASE WHEN $1::bool THEN flag_reason ELSE NULL END
          WHERE artist_key = $3::text`,
        [flagged, userId, aKey]
      );
    }
    if (hasFlagReason) {
      await pool.query(
        `UPDATE artist_meta SET flag_reason = NULLIF($1::text, '') WHERE artist_key = $2::text`,
        [flagReason || '', aKey]
      );
    }

    // Targeted READY-FOR-PLANNING update — Recoupments workflow marker.
    // Same flip-boolean + stamp-who/when shape as COMPLETE below.
    if (hasReady) {
      const ready = !!req.body.ready_for_planning;
      await pool.query(
        `UPDATE artist_meta
            SET ready_for_planning    = $1::bool,
                ready_for_planning_at = CASE WHEN $1::bool THEN NOW() ELSE NULL END,
                ready_for_planning_by = CASE WHEN $1::bool THEN $2::int ELSE NULL END
          WHERE artist_key = $3::text`,
        [ready, userId, aKey]
      );
    }

    // Targeted COMPLETE update — flips the boolean, stamps who/when.
    // Clearing the flag also clears the stamps so nothing stale
    // lingers on a re-opened row.
    if (hasComplete) {
      await pool.query(
        `UPDATE artist_meta
            SET complete    = $1::bool,
                complete_at = CASE WHEN $1::bool THEN NOW() ELSE NULL END,
                complete_by = CASE WHEN $1::bool THEN $2::int ELSE NULL END
          WHERE artist_key = $3::text`,
        [complete, userId, aKey]
      );
    }

    // Re-read so the response reflects the merged state.
    const { rows } = await pool.query(`
      SELECT artist_key, dismissed, dismissed_at, dismissed_by,
             priority, priority_updated_at, priority_updated_by,
             flagged, flagged_at, flagged_by, flag_reason,
             complete, complete_at, complete_by,
             ready_for_planning, ready_for_planning_at, ready_for_planning_by,
             (SELECT name FROM users WHERE id = dismissed_by) AS dismissed_by_name,
             (SELECT name FROM users WHERE id = priority_updated_by) AS priority_updated_by_name,
             (SELECT name FROM users WHERE id = flagged_by) AS flagged_by_name,
             (SELECT name FROM users WHERE id = complete_by) AS complete_by_name,
             (SELECT name FROM users WHERE id = ready_for_planning_by) AS ready_for_planning_by_name
        FROM artist_meta WHERE artist_key = $1
    `, [aKey]);

    // Audit log — one entry per mutation flavor. Flag events use
    // their own action name so they show up cleanly in the log.
    if (hasDismissed) {
      await logBkAction(req.user, dismissed ? 'artist_dismissed' : 'artist_restored',
        null, artist, 'dismissed', null, String(dismissed));
    }
    if (hasPriority) {
      await logBkAction(req.user, 'artist_priority_set',
        null, artist, 'priority', null, priority == null ? 'none' : priority);
    }
    if (hasFlagged) {
      await logBkAction(req.user, flagged ? 'artist_flagged' : 'artist_unflagged',
        null, artist, 'flagged', null, flagReason ? flagReason.slice(0, 120) : String(flagged));
    } else if (hasFlagReason) {
      await logBkAction(req.user, 'artist_flag_reason_updated',
        null, artist, 'flag_reason', null, flagReason ? flagReason.slice(0, 120) : '(cleared)');
    }
    if (hasComplete) {
      await logBkAction(req.user,
        complete ? 'artist_campaign_completed' : 'artist_campaign_reopened',
        null, artist, 'complete', null, String(complete));
    }

    res.json({ success: true, data: rows[0] || { artist_key: aKey } });
  } catch (err) {
    console.error('PUT /api/bk/artist-meta:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Song campaign status ──────────────────────────────────────────────────────
// One row per (artist, song) flagged as "finished and matched up" —
// surfaced as a badge on both the Artist Campaigns song header and the
// Recoupments song bucket header. Same shape as artist-meta endpoints
// so the client patterns rhyme. Key is the same `normalizeArtistKey`
// the rest of the artist code uses, song_key is lowercase + trim
// (matching how songs are grouped on the page).

// GET /api/bk/song-status
// Returns { "<artist_key>|<song_key>": { finished, finished_at, ... } }
router.get('/song-status', async (req, res) => {
  try {
    // Return rows that carry ANY signal — finished OR notes. Historically
    // the filter was finished=TRUE only, but notes are persisted
    // independently of finished state so an in-progress campaign with a
    // note has to come through here too.
    const { rows } = await pool.query(`
      SELECT s.artist_key, s.song_key, s.finished, s.finished_at,
             s.finished_by,
             (SELECT name FROM users WHERE id = s.finished_by) AS finished_by_name,
             s.notes, s.notes_updated_at,
             (SELECT name FROM users WHERE id = s.notes_updated_by) AS notes_updated_by_name,
             s.flagged, s.flagged_at, s.flagged_by, s.flag_reason,
             (SELECT name FROM users WHERE id = s.flagged_by) AS flagged_by_name,
             s.ready_for_planning, s.ready_for_planning_at,
             (SELECT name FROM users WHERE id = s.ready_for_planning_by) AS ready_for_planning_by_name
        FROM song_campaign_status s
       WHERE s.finished = TRUE
          OR (s.notes IS NOT NULL AND s.notes <> '')
          OR s.flagged = TRUE
          OR s.ready_for_planning = TRUE
    `);
    const map = {};
    for (const r of rows) map[`${r.artist_key}|${r.song_key}`] = r;
    res.json({ success: true, data: map });
  } catch (err) {
    console.error('GET /api/bk/song-status:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/bk/song-status  body: { artist, song, finished?, notes? }
// Upserts the row. `finished` and `notes` are both optional — send
// whichever field(s) actually changed. Body must include at least one.
// Pass finished=false to reopen; pass notes='' to clear.
router.put('/song-status', async (req, res) => {
  try {
    const artist = String(req.body?.artist || '').trim();
    const song   = String(req.body?.song   || '').trim();
    if (!artist || !song) {
      return res.status(400).json({ success: false, error: 'artist and song required' });
    }
    const hasFinished   = Object.prototype.hasOwnProperty.call(req.body || {}, 'finished');
    const hasNotes      = Object.prototype.hasOwnProperty.call(req.body || {}, 'notes');
    const hasFlagged    = Object.prototype.hasOwnProperty.call(req.body || {}, 'flagged');
    const hasFlagReason = Object.prototype.hasOwnProperty.call(req.body || {}, 'flag_reason');
    const hasReady      = Object.prototype.hasOwnProperty.call(req.body || {}, 'ready_for_planning');
    if (!hasFinished && !hasNotes && !hasFlagged && !hasFlagReason && !hasReady) {
      return res.status(400).json({ success: false, error: 'finished, notes, flagged, flag_reason, or ready_for_planning required' });
    }
    const finished = hasFinished ? !!req.body.finished : null;
    // Trim + cap at 4000 chars so a paste-bomb can't blow up the row.
    const notes = hasNotes
      ? String(req.body.notes ?? '').slice(0, 4000)
      : null;
    const flagged = hasFlagged ? !!req.body.flagged : null;
    // Flag reason cap: 500 chars — plenty for a review note, small
    // enough to bound a bad-input paste.
    const flagReason = hasFlagReason
      ? (req.body.flag_reason == null ? null : String(req.body.flag_reason).slice(0, 500))
      : null;
    const userId = req.user?.id || null;

    // artist_key uses normalize_artist_key (lowercase + strip
    // non-alphanumerics) so spelling variants share a row. song_key
    // is lowercase + trim because songs ARE allowed to have
    // punctuation that distinguishes them (e.g. "Loop" vs "Loop II").
    const { rows: keyRows } = await pool.query(
      `SELECT normalize_artist_key($1) AS akey, LOWER(TRIM($2)) AS skey`,
      [artist, song]
    );
    const aKey = keyRows[0]?.akey || '';
    const sKey = keyRows[0]?.skey || '';
    if (!aKey || !sKey) {
      return res.status(400).json({ success: false, error: 'normalized keys are empty' });
    }

    // Run one INSERT ... ON CONFLICT with a fixed 7-param shape. hasFinished
    // and hasNotes are booleans that gate whether each field is written vs.
    // preserved, so callers can send just notes OR just finished OR both.
    // Trades a bit of extra CASE noise for the guarantee that partial
    // updates never accidentally reset the other field.
    await pool.query(`
      INSERT INTO song_campaign_status
        (artist_key, song_key, finished, finished_at, finished_by, notes, notes_updated_at, notes_updated_by)
      VALUES (
        $1, $2,
        CASE WHEN $3::bool THEN $4::bool ELSE FALSE END,
        CASE WHEN $3::bool AND $4::bool THEN NOW() ELSE NULL END,
        CASE WHEN $3::bool AND $4::bool THEN $5::int ELSE NULL END,
        CASE WHEN $6::bool THEN NULLIF($7::text, '') ELSE NULL END,
        CASE WHEN $6::bool THEN NOW() ELSE NULL END,
        CASE WHEN $6::bool THEN $5::int ELSE NULL END
      )
      ON CONFLICT (artist_key, song_key) DO UPDATE SET
        finished    = CASE WHEN $3::bool THEN $4::bool           ELSE song_campaign_status.finished    END,
        finished_at = CASE WHEN $3::bool THEN (CASE WHEN $4::bool THEN NOW()    ELSE NULL END) ELSE song_campaign_status.finished_at END,
        finished_by = CASE WHEN $3::bool THEN (CASE WHEN $4::bool THEN $5::int  ELSE NULL END) ELSE song_campaign_status.finished_by END,
        notes            = CASE WHEN $6::bool THEN NULLIF($7::text, '') ELSE song_campaign_status.notes            END,
        notes_updated_at = CASE WHEN $6::bool THEN NOW()                ELSE song_campaign_status.notes_updated_at END,
        notes_updated_by = CASE WHEN $6::bool THEN $5::int              ELSE song_campaign_status.notes_updated_by END
    `, [aKey, sKey, hasFinished, finished ?? false, userId, hasNotes, notes ?? '']);

    // Flag updates — kept in a separate targeted UPDATE so the
    // existing finished/notes upsert path stays unchanged. Ensure a
    // row exists first (cheap no-op if the upsert above already
    // created one; needed when the caller passes ONLY flag fields).
    if (hasFlagged || hasFlagReason || hasReady) {
      await pool.query(
        `INSERT INTO song_campaign_status (artist_key, song_key) VALUES ($1, $2)
         ON CONFLICT (artist_key, song_key) DO NOTHING`,
        [aKey, sKey]
      );
    }
    // Targeted READY-FOR-PLANNING update — song-level counterpart of the
    // artist_meta marker; same flip + who/when stamp shape.
    if (hasReady) {
      const ready = !!req.body.ready_for_planning;
      await pool.query(
        `UPDATE song_campaign_status
            SET ready_for_planning    = $1::bool,
                ready_for_planning_at = CASE WHEN $1::bool THEN NOW() ELSE NULL END,
                ready_for_planning_by = CASE WHEN $1::bool THEN $2::int ELSE NULL END
          WHERE artist_key = $3 AND song_key = $4`,
        [ready, userId, aKey, sKey]
      );
    }
    if (hasFlagged) {
      await pool.query(
        `UPDATE song_campaign_status
            SET flagged    = $1::bool,
                flagged_at = CASE WHEN $1::bool THEN NOW() ELSE NULL END,
                flagged_by = CASE WHEN $1::bool THEN $2::int ELSE NULL END,
                flag_reason = CASE WHEN $1::bool THEN flag_reason ELSE NULL END
          WHERE artist_key = $3 AND song_key = $4`,
        [flagged, userId, aKey, sKey]
      );
    }
    if (hasFlagReason) {
      await pool.query(
        `UPDATE song_campaign_status SET flag_reason = NULLIF($1::text, '')
          WHERE artist_key = $2 AND song_key = $3`,
        [flagReason || '', aKey, sKey]
      );
    }

    const { rows } = await pool.query(`
      SELECT artist_key, song_key, finished, finished_at, finished_by,
             (SELECT name FROM users WHERE id = finished_by) AS finished_by_name,
             notes, notes_updated_at,
             (SELECT name FROM users WHERE id = notes_updated_by) AS notes_updated_by_name,
             flagged, flagged_at, flagged_by, flag_reason,
             (SELECT name FROM users WHERE id = flagged_by) AS flagged_by_name,
             ready_for_planning, ready_for_planning_at,
             (SELECT name FROM users WHERE id = ready_for_planning_by) AS ready_for_planning_by_name
        FROM song_campaign_status WHERE artist_key = $1 AND song_key = $2
    `, [aKey, sKey]);

    if (hasFinished) {
      await logBkAction(req.user,
        finished ? 'song_campaign_finished' : 'song_campaign_reopened',
        null, `${artist} — ${song}`, 'finished', null, String(finished));
    }
    if (hasNotes) {
      await logBkAction(req.user, 'song_campaign_notes_updated',
        null, `${artist} — ${song}`, 'notes', null, notes ? notes.slice(0, 120) : '(cleared)');
    }
    if (hasFlagged) {
      await logBkAction(req.user,
        flagged ? 'song_campaign_flagged' : 'song_campaign_unflagged',
        null, `${artist} — ${song}`, 'flagged', null, flagReason ? flagReason.slice(0, 120) : String(flagged));
    } else if (hasFlagReason) {
      await logBkAction(req.user, 'song_campaign_flag_reason_updated',
        null, `${artist} — ${song}`, 'flag_reason', null, flagReason ? flagReason.slice(0, 120) : '(cleared)');
    }

    res.json({ success: true, data: rows[0] || { artist_key: aKey, song_key: sKey, finished, notes } });
  } catch (err) {
    console.error('PUT /api/bk/song-status:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/export-recoupments?artist=<name>&groupBy=song|category
// Excel export tailored to the Recoupments artist detail page. One workbook,
// one sheet. Body groups by song (default) or category, with secondary buckets
// inside each. Section headers + subtotals + a grand total row so the layout
// scans top-down like the on-screen view.
router.get('/export-recoupments', async (req, res) => {
  try {
    const { artist, groupBy = 'song', paymentStatus = '' } = req.query;
    if (!artist || !String(artist).trim()) {
      return res.status(400).json({ success: false, error: 'artist required' });
    }
    const primaryField = groupBy === 'category' ? 'category' : 'song';
    const secondaryField = primaryField === 'song' ? 'category' : 'song';
    // Mirrors the page's 'All Payments / Paid / Unpaid' filter. Anything
    // outside that whitelist is ignored so the export defaults to ALL.
    const paymentFilter = ['Paid', 'Unpaid'].includes(String(paymentStatus)) ? String(paymentStatus) : '';

    // Same scope the Recoupments page uses: status='approved', recoupable,
    // not deleted, and NOT booked from a bank statement.
    //
    // A SPLIT FAMILY IS SUMMED WHOLE — every row, parent included, and there is
    // no EXISTS filter here on purpose. All three split writers SHRINK the
    // parent to its own slice (`/entries/:id/split` does `SET amount =
    // first.amount`; so do the auto-split-by-song in PUT /entries/:id and
    // /entries/:id/split-fee-reimb), so parent.amount + SUM(children.amount) IS
    // the invoice. Filtering the parent out drops its slice and under-reports.
    //
    // This comment used to claim "the parent that's been split is excluded by
    // EXISTS check". It was wrong from the commit that wrote it (2b6e136) — no
    // such clause was ever in this query — and it is what TODO #18 was built
    // on: read as gospel, it made the Recoupments page look like the one that
    // double-counts. Measured on production 2026-09-02: 111 split families, 275
    // children, ZERO parents still carrying a whole invoice, and adding the
    // filter would have cut $47,226.01 off a $3,126,376.38 page.
    // `scripts/split-family-total-fixture.cjs` pins it; verified it goes red
    // when the EXISTS clause is added back here.
    //
    // The bank exclusion has to be here and not only on the client, or Export
    // hands back rows the page it was clicked from doesn't show. See
    // lib/ledger-source.js. NOTE the two sides use different predicates: this
    // drops every bank-born row (`excludeBankRows`), the page drops only the
    // UNREVIEWED ones (`withoutUnreviewedBankRows`). They agree today because 0
    // reviewed bank rows are recoupable; the first one that is will show up on
    // the page and be missing from this export.
    const isUnassigned = String(artist).trim().toLowerCase() === 'unassigned';
    const artistFilter = isUnassigned
      ? `(e.artist IS NULL OR TRIM(e.artist) = '')`
      : `normalize_artist_key(e.artist) = normalize_artist_key($1)`;
    const params = isUnassigned ? [] : [String(artist).trim()];
    // Optional Paid/Unpaid scope — uses 'IS DISTINCT FROM' for Unpaid so
    // NULL / Partial / anything-not-Paid all sweep into the "Unpaid" bucket,
    // matching the on-screen filter.
    const paymentClause = paymentFilter === 'Paid'
      ? `AND e.payment_status = 'Paid'`
      : paymentFilter === 'Unpaid'
        ? `AND e.payment_status IS DISTINCT FROM 'Paid'`
        : '';
    const { rows: items } = await pool.query(`
      SELECT e.id, e.invoice_date, e.payment_date, e.payment_status, e.payee,
             e.song, e.category, e.artist, e.description, e.invoice_number,
             e.amount, e.currency, e.recoupable, e.ufr, e.cobrand,
             e.recoupment_label, e.parent_id,
             e.social_handles,
             p.social_handles AS parent_social_handles
        FROM expenses e
        LEFT JOIN expenses p ON p.id = e.parent_id
       WHERE ${artistFilter}
         AND e.status = 'approved'
         AND e.recoupable = true
         AND ${excludeBankRows('e')}
         AND (e.deleted = false OR e.deleted IS NULL)
         AND (e.voided  = false OR e.voided  IS NULL)
         ${paymentClause}
       ORDER BY e.invoice_date DESC NULLS LAST, e.id DESC
    `, params);

    // Build a structured tree: primary -> secondary -> label -> items.
    // Mirror the on-screen rules: case-insensitive bucket keys with most-
    // common spelling for display, empty values land in an 'N/A' bucket.
    const norm = (s) => (s || '').trim();
    const lc = (s) => norm(s).toLowerCase();
    const bestSpelling = (counts) =>
      Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];

    const tree = {}; // { primaryKey: { name, items[], secondary: { ... } } }
    const primarySpellings = {};
    const secondarySpellings = {};
    for (const it of items) {
      const pRaw = norm(it[primaryField]);
      const pKey = pRaw ? lc(pRaw) : '__na_p__';
      if (!tree[pKey]) tree[pKey] = { items: [], secondary: {} };
      if (!primarySpellings[pKey]) primarySpellings[pKey] = {};
      if (pRaw) primarySpellings[pKey][pRaw] = (primarySpellings[pKey][pRaw] || 0) + 1;
      tree[pKey].items.push(it);

      const sRaw = norm(it[secondaryField]);
      const sKey = sRaw ? lc(sRaw) : '__na_s__';
      const sStore = tree[pKey].secondary;
      if (!sStore[sKey]) sStore[sKey] = { items: [] };
      if (!secondarySpellings[`${pKey}|${sKey}`]) secondarySpellings[`${pKey}|${sKey}`] = {};
      if (sRaw) secondarySpellings[`${pKey}|${sKey}`][sRaw] = (secondarySpellings[`${pKey}|${sKey}`][sRaw] || 0) + 1;
      sStore[sKey].items.push(it);
    }

    // Pinning rule used on the page: Advance first, Marketing second when
    // we're looking at category-keyed buckets. Identifier == lowercase key.
    const PINNED = { advance: 0, marketing: 1 };
    const sortByPinThenTotal = (a, b, isCategoryAxis) => {
      // N/A always sinks.
      if (a.key === '__na_p__' || a.key === '__na_s__') return 1;
      if (b.key === '__na_p__' || b.key === '__na_s__') return -1;
      if (isCategoryAxis) {
        const ap = PINNED[a.key]; const bp = PINNED[b.key];
        if (ap !== undefined && bp !== undefined) return ap - bp;
        if (ap !== undefined) return -1;
        if (bp !== undefined) return 1;
      }
      return b.total - a.total;
    };

    const sumAmt = (its) => its.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const sumUfr = (its) => its.filter(e => e.ufr === 'Yes').reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const countUfr = (its) => its.filter(e => e.ufr === 'Yes').length;

    const primaryBuckets = Object.entries(tree).map(([key, b]) => ({
      key,
      name: key === '__na_p__' ? `N/A — no ${primaryField}` :
            bestSpelling(primarySpellings[key] || {}) || key,
      items: b.items,
      total: sumAmt(b.items),
      secondary: Object.entries(b.secondary).map(([sk, sb]) => ({
        key: sk,
        name: sk === '__na_s__' ? `No ${secondaryField}` :
              bestSpelling(secondarySpellings[`${key}|${sk}`] || {}) || sk,
        items: sb.items,
        total: sumAmt(sb.items),
      })).sort((a, b) => sortByPinThenTotal(a, b, secondaryField === 'category')),
    })).sort((a, b) => sortByPinThenTotal(a, b, primaryField === 'category'));

    // ── Workbook ──
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Market Street Dashboard';
    const sheetName = String(artist).replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Recoupments';
    const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });

    const CURRENCY_FMT = {
      USD: '"$"#,##0.00', EUR: '"€"#,##0.00', GBP: '"£"#,##0.00', JPY: '"¥"#,##0',
      CAD: '"CA$"#,##0.00', AUD: '"A$"#,##0.00', MXN: '"MX$"#,##0.00',
      BRL: '"R$"#,##0.00', CHF: '"CHF "#,##0.00',
      SEK: '"kr "#,##0.00', NOK: '"kr "#,##0.00', DKK: '"kr "#,##0.00',
    };
    const fmtFor = (cur) => CURRENCY_FMT[(cur || 'USD').toUpperCase()] || `"${cur} "#,##0.00`;

    // Header columns. Defined once; section header rows use merged cells
    // across these so we can flip back to data-row layout without resetting
    // column widths. Status column is text (Paid / Unpaid) and is separate
    // from the Paid On date so a row with no payment_date but Paid status
    // (rare but possible) still surfaces clearly.
    ws.columns = [
      { header: 'Date',         key: 'date',     width: 12 },
      { header: 'Status',       key: 'status',   width: 10 },
      { header: 'Paid On',      key: 'paid_on',  width: 12 },
      { header: 'Payee',        key: 'payee',    width: 30 },
      { header: 'Category',     key: 'category', width: 18 },
      { header: 'Song',         key: 'song',     width: 22 },
      { header: 'Label',        key: 'label',    width: 26 },
      { header: 'Socials',      key: 'socials',  width: 30 },
      { header: 'Invoice #',    key: 'inv_no',   width: 14 },
      { header: 'Amount',       key: 'amount',   width: 14 },
      { header: 'Cur',          key: 'cur',      width: 6  },
      { header: 'UFR',          key: 'ufr',      width: 6  },
      { header: 'Cobrand',      key: 'cobrand',  width: 9  },
      { header: 'Notes',        key: 'notes',    width: 30 },
    ];
    const N_COLS = ws.columns.length;
    // Column-index constants (1-based, matches exceljs getCell). Bumped
    // by one after slotting Socials between Label and Invoice #.
    const COL_AMOUNT  = 10;
    const COL_CUR     = 11;
    const COL_UFR     = 12;
    const COL_COBRAND = 13;

    // Bucket helpers used by every level of subtotal — keep one definition.
    const bucketByCur = (its) => {
      const out = {};
      for (const it of its) {
        const c = (it.currency || 'USD').toUpperCase();
        out[c] = (out[c] || 0) + parseFloat(it.amount || 0);
      }
      return out;
    };
    const cobrandByCur = (its) => bucketByCur(its.filter(x => x.cobrand));
    const ufrByCurOf   = (its) => bucketByCur(its.filter(x => x.ufr === 'Yes'));

    // ── Title row + as-of ──────────────────────────────────────────────
    const titleRow = ws.insertRow(1, [`Recoupments — ${primaryBuckets[0]?.items?.[0]?.artist || artist}${paymentFilter ? ` · ${paymentFilter} only` : ''}`]);
    ws.mergeCells(1, 1, 1, N_COLS);
    titleRow.font = { bold: true, size: 16 };
    titleRow.alignment = { vertical: 'middle' };

    const asOfRow = ws.insertRow(2, [`As of ${new Date().toISOString().slice(0, 10)} · Grouped by ${primaryField} · ${items.length} item${items.length === 1 ? '' : 's'}`]);
    ws.mergeCells(2, 1, 2, N_COLS);
    asOfRow.font = { italic: true, color: { argb: 'FF6B7280' } };

    // ── Top summary block: Recoupable / Cobrand / UFR per currency ─────
    const grandByCur = bucketByCur(items);
    const grandCobrandByCur = cobrandByCur(items);
    const grandUfrByCur = ufrByCurOf(items);
    const curCodes = Object.keys(grandByCur);

    ws.insertRow(3, []);
    const summaryHdr = ws.insertRow(4, []);
    summaryHdr.getCell(COL_AMOUNT).value  = 'TOTAL RECOUPABLE';
    summaryHdr.getCell(COL_UFR).value     = 'UFR TOTAL';
    summaryHdr.getCell(COL_COBRAND).value = 'COBRAND TOTAL';
    summaryHdr.font = { bold: true, color: { argb: 'FF6B7280' } };
    summaryHdr.alignment = { horizontal: 'left' };
    let summaryRowIdx = 5;
    for (const c of curCodes) {
      const r = ws.insertRow(summaryRowIdx++, []);
      r.getCell(COL_AMOUNT).value  = grandByCur[c];
      r.getCell(COL_CUR).value     = c;
      r.getCell(COL_UFR).value     = grandUfrByCur[c] || 0;
      r.getCell(COL_COBRAND).value = grandCobrandByCur[c] || 0;
      r.getCell(COL_AMOUNT).numFmt  = fmtFor(c);
      r.getCell(COL_UFR).numFmt     = fmtFor(c);
      r.getCell(COL_COBRAND).numFmt = fmtFor(c);
      r.font = { bold: true };
    }
    ws.insertRow(summaryRowIdx++, []);

    // ── Column headers ─────────────────────────────────────────────────
    const hdr = ws.insertRow(summaryRowIdx++, ws.columns.map(c => c.header));
    hdr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
    hdr.alignment = { vertical: 'middle' };
    hdr.height = 22;

    // Helper: emit a subtotal block (one row per currency, optional Cobrand
    // sub-line per currency). `level` controls indent + style intensity.
    // Used at the end of every primary section AND at the bottom of the
    // sheet for the page-level totals.
    const emitSubtotalBlock = (sectionItems, sectionName, level /* 'section' | 'grand' */) => {
      const sumByCur = bucketByCur(sectionItems);
      const cbByCur  = cobrandByCur(sectionItems);
      const sumCurs  = Object.keys(sumByCur);
      const cbCurs   = Object.keys(cbByCur);

      // Cobrand totals come FIRST (above the grand total), matching the
      // user-described layout: 'cobrand total on top of grand total'.
      // Excel merges keep the TOP-LEFT cell's value, so the label has to
      // be assigned to col 1 before merging col 1 → col 8.
      for (const c of cbCurs) {
        const label = `${level === 'grand' ? 'COBRAND TOTAL' : 'Cobrand subtotal'}${sectionName ? ` — ${sectionName}` : ''} (${c})`;
        const r = ws.insertRow(currentRowIdx++, [label]);
        ws.mergeCells(currentRowIdx - 1, 1, currentRowIdx - 1, COL_AMOUNT - 1);
        r.getCell(1).alignment = { horizontal: 'right' };
        r.getCell(COL_AMOUNT).value = cbByCur[c];
        r.getCell(COL_CUR).value    = c;
        r.getCell(COL_AMOUNT).numFmt = fmtFor(c);
        r.font = level === 'grand'
          ? { bold: true, size: 11, color: { argb: 'FF1D4ED8' } }
          : { bold: true, color: { argb: 'FF1D4ED8' } };
        r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: level === 'grand' ? 'FFDBEAFE' : 'FFEFF6FF' } };
      }
      // Grand subtotal per currency.
      for (const c of sumCurs) {
        const label = `${level === 'grand' ? 'GRAND TOTAL' : 'Subtotal'}${sectionName ? ` — ${sectionName}` : ''} (${c})`;
        const r = ws.insertRow(currentRowIdx++, [label]);
        ws.mergeCells(currentRowIdx - 1, 1, currentRowIdx - 1, COL_AMOUNT - 1);
        r.getCell(1).alignment = { horizontal: 'right' };
        r.getCell(COL_AMOUNT).value = sumByCur[c];
        r.getCell(COL_CUR).value    = c;
        r.getCell(COL_AMOUNT).numFmt = fmtFor(c);
        r.font = level === 'grand'
          ? { bold: true, size: 12, color: { argb: 'FF334155' } }
          : { bold: true, color: { argb: 'FF111827' } };
        r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: level === 'grand' ? 'FFFEE2E2' : 'FFF3F4F6' } };
      }
    };

    let currentRowIdx = summaryRowIdx;

    // Body — primary → secondary → label → items, with subtotal blocks
    // emitted AFTER all items in a primary section. Section headers stay
    // clean (no inline numbers) so the layout reads top-down.
    for (const pri of primaryBuckets) {
      // Primary section header (merged, slate background, no inline totals)
      const priHdr = ws.insertRow(currentRowIdx, [pri.name.toUpperCase()]);
      ws.mergeCells(currentRowIdx, 1, currentRowIdx, N_COLS);
      priHdr.getCell(1).font = { bold: true, size: 12 };
      priHdr.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
      currentRowIdx++;

      for (const sec of pri.secondary) {
        // Secondary sub-header — lighter slate, indented title, no totals
        if (pri.secondary.length > 1 || sec.key !== '__na_s__') {
          const secHdr = ws.insertRow(currentRowIdx, [`   ${sec.name}`]);
          ws.mergeCells(currentRowIdx, 1, currentRowIdx, N_COLS);
          secHdr.getCell(1).font = { bold: true, italic: true, color: { argb: 'FF374151' } };
          secHdr.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
          currentRowIdx++;
        }

        // Third-level grouping inside each secondary bucket: by
        // recoupment_label. Mirrors the on-screen rule — only render label
        // sub-headers when at least one item in this bucket carries a
        // label (otherwise emit items flat under the secondary header so
        // unlabeled sections don't get an empty 'No label' bar). Best
        // spelling of each label key wins; lowercased keys merge case
        // variants like 'Digital Marketing' vs 'digital marketing'.
        const labelBuckets = (() => {
          const byKey = {}
          const spellings = {}
          for (const it of sec.items) {
            const raw = norm(it.recoupment_label)
            const k = raw ? lc(raw) : '__no_label__'
            if (!byKey[k]) byKey[k] = []
            byKey[k].push(it)
            if (raw) {
              if (!spellings[k]) spellings[k] = {}
              spellings[k][raw] = (spellings[k][raw] || 0) + 1
            }
          }
          return Object.entries(byKey).map(([key, its]) => ({
            key,
            name: key === '__no_label__' ? 'No label' :
                  bestSpelling(spellings[key] || {}) || key,
            items: its,
            total: sumAmt(its),
          })).sort((a, b) => {
            // No-label bucket sinks regardless of total.
            if (a.key === '__no_label__' && b.key !== '__no_label__') return 1;
            if (b.key === '__no_label__' && a.key !== '__no_label__') return -1;
            return b.total - a.total;
          })
        })();
        const hasAnyLabel = labelBuckets.some(b => b.key !== '__no_label__');

        for (const lab of labelBuckets) {
          // Label sub-header — only when this bucket has at least one
          // labeled item somewhere. Indigo to match the on-screen chip,
          // double-indented to read as nested below the secondary bar.
          if (hasAnyLabel) {
            const labHdr = ws.insertRow(currentRowIdx, [
              lab.key === '__no_label__' ? '      (no label)' : `      ◆ ${lab.name}`,
            ]);
            ws.mergeCells(currentRowIdx, 1, currentRowIdx, N_COLS);
            labHdr.getCell(1).font = lab.key === '__no_label__'
              ? { italic: true, color: { argb: 'FF9CA3AF' } }
              : { bold: true, color: { argb: 'FF3730A3' } };
            labHdr.getCell(1).fill = { type: 'pattern', pattern: 'solid',
              fgColor: { argb: lab.key === '__no_label__' ? 'FFF9FAFB' : 'FFEEF2FF' } };
            labHdr.outlineLevel = 2;
            currentRowIdx++;
          }

          // Items — outline level depends on whether they sit under a
          // label sub-header (3) or directly under the secondary (2) so
          // Excel's collapse arrows nest correctly.
          for (const it of lab.items) {
            const cur = (it.currency || 'USD').toUpperCase();
            const paid = it.payment_status === 'Paid';
            // Socials are stored as JSONB on expenses. Render them as a
            // human-readable string mirroring the Ledger column ("IG @joe,
            // TT @joe_tt"), skipping rows where the field is missing /
            // empty / malformed so the cell doesn't end up reading "[]".
            // Split children fall back to the parent invoice's socials so
            // each artist row still surfaces the handles captured on the
            // original vendor submission (matches the on-page chip).
            const ownSocials = Array.isArray(it.social_handles) ? it.social_handles : [];
            const parentSocials = Array.isArray(it.parent_social_handles) ? it.parent_social_handles : [];
            const socialsArr = ownSocials.length ? ownSocials : parentSocials;
            const socialsCell = socialsArr
              .map(s => {
                const p = (s?.platform || '').trim();
                const h = (s?.handle || '').trim();
                if (!p && !h) return null;
                return p ? `${p} ${h}` : h;
              })
              .filter(Boolean)
              .join(', ');
            const r = ws.insertRow(currentRowIdx, {
              date:     it.invoice_date  ? new Date(it.invoice_date).toISOString().slice(0, 10) : '',
              status:   paid ? 'Paid' : 'Unpaid',
              paid_on:  it.payment_date  ? new Date(it.payment_date).toISOString().slice(0, 10) : '',
              payee:    it.payee || '',
              category: it.category || '',
              song:     it.song || '',
              label:    it.recoupment_label || '',
              socials:  socialsCell,
              inv_no:   it.invoice_number || '',
              amount:   parseFloat(it.amount || 0),
              cur:      cur,
              ufr:      it.ufr === 'Yes' ? '✓' : '',
              cobrand:  it.cobrand ? 'CB' : '',
              notes:    it.description || '',
            });
            r.getCell('amount').numFmt = fmtFor(cur);
            r.outlineLevel = hasAnyLabel ? 3 : 2;
            // Status pill — green text on Paid, red on Unpaid.
            r.getCell('status').font = { bold: true,
              color: { argb: paid ? 'FF047857' : 'FFB91C1C' } };
            if (it.ufr === 'Yes') {
              r.getCell('ufr').font = { bold: true, color: { argb: 'FF047857' } };
              r.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECFDF5' } }; });
            }
            if (it.cobrand) {
              r.getCell('cobrand').font = { bold: true, color: { argb: 'FF1D4ED8' } };
            }
            currentRowIdx++;
          }
        }
      }

      // ── End-of-section totals ──
      // For each primary section, drop a Cobrand subtotal + Subtotal
      // block right after the last item so the user can read totals
      // bottom-up section by section. Skip when section has 0 items.
      if (pri.items.length > 0) {
        emitSubtotalBlock(pri.items, pri.name, 'section');
        // Empty separator before the next section.
        ws.insertRow(currentRowIdx++, []);
      }
    }

    // ── Bottom-of-sheet totals — Cobrand first, then Grand ──
    ws.insertRow(currentRowIdx++, []);
    emitSubtotalBlock(items, null, 'grand');

    const buf = await wb.xlsx.writeBuffer();
    const safeName = String(artist).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const filenameTag = paymentFilter ? `-${paymentFilter.toLowerCase()}` : '';
    res.setHeader('Content-Disposition', `attachment; filename="recoupments-${safeName}${filenameTag}-${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('GET /api/bk/export-recoupments:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/download-files — ZIP of invoices/proofs/w9s for matching entries
router.get('/download-files', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    const { artist, song, payee, category, from, to, search, types } = req.query;
    // types = comma-separated list: invoice,proof,w9,receipt (default: all)
    const includeTypes = types ? types.split(',') : ['invoice', 'proof', 'w9', 'receipt'];
    // Same filter as the visible Lookup table — pending submissions stay
    // in Approvals; voided rows don't count as spend.
    const conditions = ["e.status = 'approved'", '(e.deleted = false OR e.deleted IS NULL)', '(e.voided = false OR e.voided IS NULL)'];
    const params = [];

    if (artist) { params.push(`%${artist}%`); conditions.push(`e.artist ILIKE $${params.length}`); }
    if (song)   { params.push(`%${song}%`);   conditions.push(`e.song ILIKE $${params.length}`); }
    if (payee)  { params.push(`%${payee}%`);   conditions.push(`e.payee ILIKE $${params.length}`); }
    if (category) { params.push(category);     conditions.push(`e.category = $${params.length}`); }
    if (from) { params.push(from); conditions.push(`e.invoice_date >= $${params.length}`); }
    if (to)   { params.push(to);   conditions.push(`e.invoice_date <= $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      conditions.push(`(e.payee ILIKE $${n} OR e.description ILIKE $${n} OR e.invoice_number ILIKE $${n} OR e.artist ILIKE $${n})`);
    }

    const { rows } = await pool.query(`
      SELECT e.id, e.payee, e.artist, e.invoice_number, e.invoice_date,
             e.invoice_data, e.invoice_r2_key, e.invoice_filename,
             e.proof_data,   e.proof_r2_key,   e.proof_filename,
             e.w9_data,      e.w9_r2_key,      e.w9_filename,
             e.receipt_data, e.receipt_filename
      FROM expenses e
      WHERE ${conditions.join(' AND ')} AND e.parent_id IS NULL
      ORDER BY e.invoice_date DESC NULLS LAST, e.id DESC
    `, params);

    const archiver = require('archiver');
    const label = artist || song || payee || 'expenses';
    const typeLabel = includeTypes.length === 1 ? includeTypes[0] + 's' : 'files';
    const safeName = String(label).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);

    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-${typeLabel}.zip"`);
    res.setHeader('Content-Type', 'application/zip');

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);

    let fileCount = 0;
    for (const r of rows) {
      const prefix = (r.payee || 'unknown').replace(/[/\\:*?"<>|]/g, '_');
      const datePart = r.invoice_date ? String(r.invoice_date).slice(0,10) : r.id;

      if (includeTypes.includes('invoice') && (r.invoice_r2_key || r.invoice_data)) {
        const buf = await loadFileBuffer(r.invoice_r2_key, r.invoice_data);
        if (buf) {
          const ext = (r.invoice_filename || '').split('.').pop() || 'pdf';
          archive.append(buf, { name: `Invoices/${prefix}_${datePart}.${ext}` });
          fileCount++;
        }
      }
      if (includeTypes.includes('proof') && (r.proof_r2_key || r.proof_data)) {
        const buf = await loadFileBuffer(r.proof_r2_key, r.proof_data);
        if (buf) {
          const ext = (r.proof_filename || '').split('.').pop() || 'pdf';
          archive.append(buf, { name: `Proofs/${prefix}_${datePart}.${ext}` });
          fileCount++;
        }
      }
      if (includeTypes.includes('w9') && (r.w9_r2_key || r.w9_data)) {
        const buf = await loadFileBuffer(r.w9_r2_key, r.w9_data);
        if (buf) {
          const ext = (r.w9_filename || '').split('.').pop() || 'pdf';
          archive.append(buf, { name: `W9s/${prefix}.${ext}` });
          fileCount++;
        }
      }
      if (includeTypes.includes('receipt') && r.receipt_data) {
        const ext = (r.receipt_filename || '').split('.').pop() || 'pdf';
        archive.append(Buffer.from(r.receipt_data, 'base64'), { name: `Receipts/${prefix}_${datePart}.${ext}` });
        fileCount++;
      }
    }

    if (fileCount === 0) {
      archive.append('No files found for this search.', { name: 'README.txt' });
    }

    await archive.finalize();
  } catch (err) {
    console.error('GET /api/bk/download-files:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

// Sanitize a payee/vendor string for use inside a ZIP filename. Replaces
// characters that confuse Windows/macOS/Linux file browsers and trims to a
// reasonable length so the bookkeeper doesn't open a ZIP full of cryptic
// filenames. Falls back to "Unknown" so we never produce an empty name.
function safeNameForZip(s) {
  const cleaned = String(s || '')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'Unknown';
}

// ── Fuzzy vendor matcher used by the ledger-diff endpoint below ─────────────
// Shared with the bank-statement matcher — lives in lib/vendorMatch.js.
const { vendorsMatch } = require('../lib/vendorMatch');

// POST /api/bk/ledger-diff — bookkeeper uploads their weekly invoice
// summary xlsx. We auto-detect the columns on every relevant sheet
// (skipping the SUM / totals sheets), pull the Market Street dashboard ledger,
// and return a structured JSON diff so the page can render the
// reconciliation report inline.
//
// Match strategy:
//   - Primary key: normalizeInvoiceNum (so "#11" ≡ "INV-11" ≡ "11").
//   - Secondary: fuzzy vendor match via vendorsMatch above so spelling
//     drift doesn't false-positive a mismatch.
//
// Diff categories:
//   - matched               — same vendor + invoice # + amount + paid state
//   - amount_mismatch       — same invoice # + matched vendor, different amount
//   - paid_status_mismatch  — one side paid, the other isn't
//   - vendor_name_variation — matched but the vendor names differ (informational)
//   - missing_from_dashboard — invoice # in bookkeeper, not in Market Street's ledger
//   - missing_from_bookkeeper — invoice # in Market Street's ledger, not in the sheet
//   - no_invoice_num        — bookkeeper row has no normalizable invoice #
router.post('/ledger-diff', upload.single('file'), async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);

    // Shared with the older /ledger-matching endpoint — flatten ExcelJS's
    // cell-value variants (formula / richText / hyperlink) to a plain string.
    const cellText = (cell) => {
      let v = cell?.value;
      if (v instanceof Date) {
        // ISO date — matches what we get from Postgres so comparisons work.
        return v.toISOString().slice(0, 10);
      }
      if (v && typeof v === 'object') {
        if ('result' in v) v = v.result;
        else if ('text' in v) v = v.text;
        else if ('richText' in v) v = (v.richText || []).map(r => r.text).join('');
        else if ('hyperlink' in v) v = v.text || v.hyperlink;
      }
      return String(v ?? '').trim();
    };

    // Coerce an amount cell to a number — strips commas / currency symbols
    // / parens (for negatives) so accounting-formatted cells parse cleanly.
    const cellAmount = (cell) => {
      const t = cellText(cell);
      if (!t) return null;
      const cleaned = t.replace(/[,$£€¥]/g, '').replace(/[()]/g, '-').replace(/[^0-9.-]/g, '').trim();
      if (!cleaned) return null;
      const n = parseFloat(cleaned);
      return Number.isFinite(n) ? n : null;
    };

    // Header-row autodetect — same shape as the older endpoint but tuned
    // for the bookkeeper's "OUTSTANDING INVOICES SUMMARY" template where
    // the real header sits in row 6 after a title block + week-ending row.
    const detectHeaderRow = (ws) => {
      const max = Math.min(20, ws.actualRowCount);
      let best = { row: 0, score: 0 };
      for (let r = 1; r <= max; r++) {
        const row = ws.getRow(r);
        const values = [];
        row.eachCell({ includeEmpty: false }, c => values.push(cellText(c)));
        if (values.length < 2) continue;
        if (new Set(values).size === 1) continue;
        if (values.some(v => v.length > 80)) continue;
        let score = 0;
        for (const v of values) {
          const lc = v.toLowerCase();
          if (/\b(vendor|payee|invoice|inv|amount|date|artist|description|notes?|paid|approval|priority)\b/.test(lc)) score++;
        }
        if (score > best.score) best = { row: r, score };
      }
      return best.score >= 2 ? best.row : 0;
    };

    // Find the columns we care about by header name (forgiving fuzzy
    // match). Each returned value is the 1-indexed column number or null.
    const findColumns = (headerRow) => {
      const map = {};
      headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
        const t = cellText(cell).toLowerCase();
        if (!t) return;
        if (!map.vendor && /\b(vendor|supplier|company)\b/.test(t)) map.vendor = col;
        else if (!map.payee_name && /\bpayee\s*name\b/.test(t)) map.payee_name = col;
        if (!map.invoice && (/\binvoice\s*#/.test(t) || /\binvoice\s*(num|number|no)\b/.test(t) || /^inv\b/.test(t))) map.invoice = col;
        if (!map.amount && /\bamount\b/.test(t) && !/paid/i.test(t)) map.amount = col;
        if (!map.artist && /\bartist\b/.test(t)) map.artist = col;
        if (!map.description && /\bdescription\b/.test(t)) map.description = col;
        if (!map.invoice_date && /\b(invoice\s*date|date\s*recd|date\s*received)\b/.test(t)) map.invoice_date = col;
        if (!map.due_date && /\bdue\s*date\b/.test(t)) map.due_date = col;
      });
      // The bookkeeper's PAID-block is two columns ("DATE" + "AMOUNT") under
      // a "PAID" parent header. Scan the row below the header for those
      // labels (some workbooks merge the parent across two cells).
      const subHeaderRow = headerRow.worksheet.getRow(headerRow.number + 1);
      subHeaderRow.eachCell({ includeEmpty: false }, (cell, col) => {
        const t = cellText(cell).toLowerCase();
        if (!map.paid_date && t === 'date') map.paid_date = col;
        if (!map.paid_amount && t === 'amount') map.paid_amount = col;
      });
      return map;
    };

    // Coerce a value (string / Date / null) to a YYYY-MM-DD string for
    // safe equality comparison. Used on BOTH sides of the diff because
    // node-postgres returns date columns as JS Date objects and the
    // bookkeeper sheet ships dates as either Date objects (cellText
    // converts) or strings — without this helper, the paid-date diff
    // would never match correctly (`String(dateObj).slice(0, 10)` gives
    // "Mon Jun 18" for a Date).
    const ymd = (v) => {
      if (!v) return '';
      if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
      const s = String(v);
      const m = s.match(/^\d{4}-\d{2}-\d{2}/);
      return m ? m[0] : '';
    };

    // ── Phase 1: parse the bookkeeper sheets ───────────────────────────────
    // Also extract the workbook's "WEEK ENDING" date if present — used
    // later to cap the missing_from_bookkeeper filter so very-recent
    // dashboard rows (added after the bookkeeper's snapshot) don't get
    // flagged as missing just because the sheet hasn't been refreshed yet.
    let weekEnding = null;
    for (const ws of wb.worksheets) {
      const max = Math.min(20, ws.actualRowCount);
      for (let r = 1; r <= max && !weekEnding; r++) {
        const row = ws.getRow(r);
        row.eachCell({ includeEmpty: false }, (cell, col) => {
          if (weekEnding) return;
          const t = cellText(cell);
          if (!t || !/week\s*ending/i.test(t)) return;
          // Date sits in the next non-empty cell to the right.
          for (let c = col + 1; c <= row.cellCount; c++) {
            const v = row.getCell(c).value;
            if (v instanceof Date) { weekEnding = v.toISOString().slice(0, 10); break; }
            const tt = cellText(row.getCell(c));
            if (tt && /^\d{4}-\d{2}-\d{2}/.test(tt)) { weekEnding = tt.slice(0, 10); break; }
          }
        });
      }
    }

    const bookkeeperRows = [];
    const sheetsSkipped = [];
    for (const ws of wb.worksheets) {
      const name = ws.name || '';
      // Summary/totals sheets carry no invoice rows.
      if (/^(sum|summary|totals?|grand\s*total)$/i.test(name.trim())) {
        sheetsSkipped.push({ sheet: name, reason: 'summary' });
        continue;
      }
      const headerRowIdx = detectHeaderRow(ws);
      if (!headerRowIdx) { sheetsSkipped.push({ sheet: name, reason: 'no_header' }); continue; }
      const cols = findColumns(ws.getRow(headerRowIdx));
      if (!cols.vendor || !cols.invoice) {
        sheetsSkipped.push({ sheet: name, reason: 'missing_vendor_or_invoice_col' });
        continue;
      }
      // Data starts on the row after the PAID-subheader (or directly after
      // the header if there's no subheader row). Skip header+1 if it looks
      // like the "DATE / AMOUNT" subheader row.
      const subRow = ws.getRow(headerRowIdx + 1);
      const subVals = [];
      subRow.eachCell({ includeEmpty: false }, c => subVals.push(cellText(c).toLowerCase()));
      const isSubHeader = subVals.some(v => v === 'date' || v === 'amount' || v === 'via');
      const firstDataRow = headerRowIdx + (isSubHeader ? 2 : 1);
      for (let r = firstDataRow; r <= ws.actualRowCount; r++) {
        const row = ws.getRow(r);
        const vendor = cellText(row.getCell(cols.vendor));
        const invoice = cellText(row.getCell(cols.invoice));
        if (!vendor && !invoice) continue;
        bookkeeperRows.push({
          sheet: name,
          rowNum: r,
          vendor,
          payee_name: cols.payee_name ? cellText(row.getCell(cols.payee_name)) : null,
          invoice,
          amount: cols.amount ? cellAmount(row.getCell(cols.amount)) : null,
          paid_date: cols.paid_date ? cellText(row.getCell(cols.paid_date)) : null,
          paid_amount: cols.paid_amount ? cellAmount(row.getCell(cols.paid_amount)) : null,
          invoice_date: cols.invoice_date ? cellText(row.getCell(cols.invoice_date)) : null,
          due_date: cols.due_date ? cellText(row.getCell(cols.due_date)) : null,
          artist: cols.artist ? cellText(row.getCell(cols.artist)) : null,
          description: cols.description ? cellText(row.getCell(cols.description)) : null,
        });
      }
    }

    // ── Phase 2: pull dashboard expenses + index by normalized invoice # ───
    // parent_id IS NULL so split children don't double-count.
    const { rows: dashRows } = await pool.query(`
      SELECT e.id, e.payee, e.invoice_number,
             e.invoice_date, e.payment_date, e.amount, e.currency,
             e.payment_status, e.paid_by, e.artist, e.song, e.description,
             COALESCE((
               e.amount +
               COALESCE((SELECT SUM(c.amount) FROM expenses c
                          WHERE c.parent_id = e.id
                            AND (c.deleted = false OR c.deleted IS NULL)), 0)
             ), e.amount) AS family_amount
        FROM expenses e
       WHERE (e.deleted = false OR e.deleted IS NULL)
         AND e.status != 'rejected'
         AND e.parent_id IS NULL
         AND e.invoice_number IS NOT NULL
         AND e.invoice_number != ''
    `);
    const dashByInv = new Map();
    for (const d of dashRows) {
      const n = normalizeInvoiceNum(d.invoice_number);
      if (!n || n === '0') continue;
      if (!dashByInv.has(n)) dashByInv.set(n, []);
      dashByInv.get(n).push(d);
    }

    // ── Phase 3: match each bookkeeper row to a dashboard candidate ────────
    const matchedDashIds = new Set();
    const diffs = [];
    for (const b of bookkeeperRows) {
      const normInv = normalizeInvoiceNum(b.invoice);
      if (!normInv || normInv === '0') {
        diffs.push({
          kind: 'no_invoice_num', sheet: b.sheet, rowNum: b.rowNum,
          bookkeeper: b, dashboard: null,
          issues: ['Bookkeeper row has no invoice # — cannot match.'],
        });
        continue;
      }
      const candidates = dashByInv.get(normInv) || [];
      if (candidates.length === 0) {
        diffs.push({
          kind: 'missing_from_dashboard', sheet: b.sheet, rowNum: b.rowNum,
          bookkeeper: b, dashboard: null,
          issues: ['Invoice # not found in the Market Street dashboard ledger.'],
        });
        continue;
      }
      // Pick the dashboard candidate with the strongest vendor match.
      // Try VENDOR first, then PAYEE NAME if the bookkeeper sheet has it.
      let best = null;
      for (const c of candidates) {
        const m1 = vendorsMatch(b.vendor, c.payee);
        const m2 = b.payee_name ? vendorsMatch(b.payee_name, c.payee) : null;
        const m = m2 && m2.score > m1.score ? m2 : m1;
        if (!best || m.score > best.match.score) best = { row: c, match: m };
      }
      // If the vendor doesn't match at all, this is a coincidental
      // invoice-number collision (different vendor, same number) — not
      // actually a match. Don't claim the dashboard row (so it can still
      // surface as missing_from_bookkeeper) and route the bookkeeper
      // row to missing_from_dashboard with an explanatory note.
      if (!best.match.match) {
        const note = !b.vendor || !b.vendor.trim()
          ? `Invoice # ${b.invoice} exists in the dashboard for "${best.row.payee}", but the bookkeeper row has no vendor — couldn't confirm a match.`
          : `Invoice # exists in the dashboard but under a different vendor ("${best.row.payee}" vs bookkeeper "${b.vendor}"). Treating as not found; verify whether either side is wrong.`;
        diffs.push({
          kind: 'missing_from_dashboard',
          sheet: b.sheet, rowNum: b.rowNum,
          bookkeeper: b, dashboard: null,
          issues: [note],
        });
        continue;
      }
      matchedDashIds.add(best.row.id);
      const issues = [];
      // Vendor name variation — matched but the names aren't identical.
      // Score 1.0 = exact, anything less is some kind of fuzzy match.
      if (best.match.score < 1.0) {
        issues.push(`Vendor names differ: bookkeeper "${b.vendor}" vs dashboard "${best.row.payee}"`);
      }
      // Amount mismatch — use the family_amount (parent + children) so
      // split invoices compare against their full billed amount.
      const dashAmount = parseFloat(best.row.family_amount ?? best.row.amount);
      if (b.amount != null && Number.isFinite(dashAmount) && Math.abs(b.amount - dashAmount) > 0.01) {
        issues.push(`Amount mismatch: bookkeeper $${b.amount.toFixed(2)} vs dashboard $${dashAmount.toFixed(2)}`);
      }
      // Paid-status mismatch. Bookkeeper considers a row paid when it has
      // a paid_date or paid_amount > 0. Dashboard truth is payment_status.
      const bookPaid = !!(b.paid_date && b.paid_date.trim()) || (b.paid_amount != null && b.paid_amount > 0);
      const dashPaid = String(best.row.payment_status || '').toLowerCase() === 'paid';
      if (bookPaid !== dashPaid) {
        issues.push(`Paid status differs: bookkeeper says ${bookPaid ? 'PAID' : 'unpaid'}, dashboard says ${dashPaid ? 'PAID' : 'unpaid'}`);
      }
      // Paid-date mismatch (only when both sides agree it's paid).
      // Run BOTH sides through ymd() — postgres date columns come back
      // as JS Date objects and bare String() coercion produces locale
      // strings like "Mon Jun 18 2026" that don't slice to YYYY-MM-DD.
      if (bookPaid && dashPaid) {
        const bd = ymd(b.paid_date);
        const dd = ymd(best.row.payment_date);
        if (bd && dd && bd !== dd) {
          issues.push(`Paid date differs: bookkeeper ${bd} vs dashboard ${dd}`);
        }
      }
      // Categorize the diff. Strongest single signal wins so each row
      // lands in ONE bucket. Amount > paid-status > paid-date > vendor
      // variation > clean.
      let kind = 'matched';
      if (issues.some(i => i.startsWith('Amount mismatch'))) kind = 'amount_mismatch';
      else if (issues.some(i => i.startsWith('Paid status'))) kind = 'paid_status_mismatch';
      else if (issues.some(i => i.startsWith('Paid date'))) kind = 'paid_date_mismatch';
      else if (issues.some(i => i.startsWith('Vendor names'))) kind = 'vendor_name_variation';
      diffs.push({
        kind, sheet: b.sheet, rowNum: b.rowNum,
        bookkeeper: b,
        dashboard: best.row,
        vendor_match_reason: best.match.reason,
        issues,
      });
    }

    // ── Phase 4: dashboard rows that no bookkeeper row claimed ─────────────
    // Filter out anything outside the date window the workbook covers — the
    // sheet years are usually a subset (e.g. 2024-2026). If we surfaced every
    // legacy invoice the bookkeeper never saw, the diff would drown in noise.
    const sheetYears = new Set();
    for (const ws of wb.worksheets) {
      const m = String(ws.name || '').match(/\b(20\d\d)\b/);
      if (m) sheetYears.add(parseInt(m[1], 10));
    }
    for (const d of dashRows) {
      if (matchedDashIds.has(d.id)) continue;
      // Year filter: ignore dashboard rows outside the workbook's year
      // span. Without this, every 2019 row would surface as "missing on
      // bookkeeper" even though the bookkeeper never tracked that period.
      // When no year was inferrable from sheet names, fall open.
      if (sheetYears.size > 0) {
        const candidateYear = d.invoice_date ? new Date(d.invoice_date).getUTCFullYear()
                            : d.payment_date ? new Date(d.payment_date).getUTCFullYear()
                            : null;
        if (candidateYear && !sheetYears.has(candidateYear)) continue;
      }
      // Week-ending cap: if the workbook's WEEK ENDING date is set, hide
      // rows whose invoice_date is AFTER that date — those landed in the
      // dashboard after the bookkeeper took their snapshot, so flagging
      // them as "missing" produces predictable false positives.
      if (weekEnding) {
        const invYmd = ymd(d.invoice_date);
        if (invYmd && invYmd > weekEnding) continue;
      }
      diffs.push({
        kind: 'missing_from_bookkeeper',
        sheet: null, rowNum: null,
        bookkeeper: null,
        dashboard: d,
        issues: ['Market Street ledger has this row; bookkeeper workbook does not.'],
      });
    }

    // ── Phase 5: aggregate summary ─────────────────────────────────────────
    const summary = {
      bookkeeper_rows: bookkeeperRows.length,
      dashboard_rows: dashRows.length,
      sheets_processed: wb.worksheets.length - sheetsSkipped.length,
      sheets_skipped: sheetsSkipped,
      sheet_years: [...sheetYears].sort(),
      week_ending: weekEnding,
      counts: {
        matched: 0,
        amount_mismatch: 0,
        paid_status_mismatch: 0,
        paid_date_mismatch: 0,
        vendor_name_variation: 0,
        missing_from_dashboard: 0,
        missing_from_bookkeeper: 0,
        no_invoice_num: 0,
      },
    };
    for (const r of diffs) summary.counts[r.kind] = (summary.counts[r.kind] || 0) + 1;

    res.json({ success: true, data: { summary, diffs } });
  } catch (err) {
    console.error('POST /api/bk/ledger-diff:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Shared workbook builder for the diff exports ──────────────────────────────
// Used by THREE endpoints below: per-category Excel, full multi-sheet
// report, and the handoff ZIP (which embeds the workbook). Building it
// in one place means the bookkeeper sees the same layout / formatting
// whether they get a single tab or the whole report.
const DIFF_CATEGORIES = [
  // High-priority action sheets first so the bookkeeper sees them on tab open.
  { key: 'amount_mismatch',        label: 'Amount Mismatches',     priority: 'HIGH', action: 'Reconcile each row — confirm the correct amount with the vendor / receipts.' },
  { key: 'paid_status_mismatch',   label: 'Paid Status Differs',   priority: 'HIGH', action: 'Sync the paid / unpaid state in whichever ledger is wrong.' },
  { key: 'missing_from_dashboard', label: 'Missing on Market Street',       priority: 'HIGH', action: 'Confirm these were really billed to Market Street; if yes Market Street needs to add them.' },
  { key: 'missing_from_bookkeeper',label: 'Missing on Bookkeeper', priority: 'HIGH', action: 'Add these rows to your books — Market Street has them in its ledger already.' },
  // Medium / informational sheets after.
  { key: 'paid_date_mismatch',     label: 'Paid Date Differs',     priority: 'MED',  action: 'Confirm the correct payment date in either ledger.' },
  { key: 'vendor_name_variation',  label: 'Vendor Name Variations',priority: 'INFO', action: 'Standardize vendor spellings so future weeks reconcile cleanly.' },
  { key: 'no_invoice_num',         label: 'No Invoice Number',     priority: 'INFO', action: 'These bookkeeper rows have no invoice # to match against — confirm whether they need a number on file.' },
  { key: 'matched',                label: 'Clean Matches',         priority: 'OK',   action: 'No action — included so you can confirm nothing got missed.' },
];

const PRIORITY_FILL = {
  HIGH: 'FFFEE2E2', // light red
  MED:  'FFFEF3C7', // light amber
  INFO: 'FFE5E7EB', // light gray
  OK:   'FFD1FAE5', // light green
};
const PRIORITY_TEXT = {
  HIGH: 'FF991B1B',
  MED:  'FF92400E',
  INFO: 'FF374151',
  OK:   'FF065F46',
};

// ── Diff-export helpers (shared across full-report + per-category + ZIP) ──

// Brand palette for the diff exports. Pulled out so every helper /
// endpoint references the same colours.
const DIFF_BRAND = {
  RED:    'FF334155',
  BAND:   'FFF9FAFB',
  GRAY:   'FF6B7280',
  BORDER: 'FFE5E7EB',
  HL_FILL:'FFFEE2E2', // light red — used to flag the specific cells in dispute
  HL_TEXT:'FF991B1B',
};

// Map a vendorsMatch() reason string to chip-style cell formatting +
// a human label. The bookkeeper sees a colour per tier so "exact"
// matches stand apart from "tokens-0.73" matches at a glance.
// Plain-English chip labels — describes what the user needs to know,
// not which step of the algorithm fired. Tooltip on the on-page chip
// keeps the original `reason` so power users can still trace it.
function diffConfidenceMeta(reason) {
  if (!reason || reason === 'no-match' || reason === 'empty') {
    return { label: '—', fill: null, text: 'FFB0B5BD' };
  }
  if (reason === 'exact')            return { label: 'Identical',      fill: 'FFD1FAE5', text: 'FF065F46' };
  if (reason === 'parentheticals')   return { label: 'Aside differs',  fill: 'FFD1FAE5', text: 'FF065F46' };
  if (reason === 'suffixes')         return { label: 'Suffix differs', fill: 'FFDBEAFE', text: 'FF1E40AF' };
  if (reason === 'substring')        return { label: 'Shorter name',   fill: 'FFFEF3C7', text: 'FF92400E' };
  if (reason === 'suffix-substring') return { label: 'Partial match',  fill: 'FFFEF3C7', text: 'FF92400E' };
  if (reason.startsWith('tokens-'))  return { label: 'Reordered',      fill: 'FFFFEDD5', text: 'FFC2410C' };
  return { label: reason, fill: 'FFE5E7EB', text: 'FF374151' };
}

// $ at stake for a single diff row. Definition varies by category — for
// amount mismatches it's the delta, for missing rows it's the full
// referenced amount, for matched rows it's $0.
function diffRowDollarDelta(diff) {
  const b = diff.bookkeeper || {};
  const d = diff.dashboard || {};
  const bv = Number.isFinite(Number(b.amount)) ? Number(b.amount) : 0;
  const dRaw = d.family_amount ?? d.amount;
  const dv = Number.isFinite(Number(dRaw)) ? Number(dRaw) : 0;
  switch (diff.kind) {
    case 'amount_mismatch':         return Math.abs(bv - dv);
    case 'paid_status_mismatch':
    case 'paid_date_mismatch':
    case 'vendor_name_variation':   return dv || bv;
    case 'missing_from_bookkeeper': return dv;
    case 'missing_from_dashboard':  return bv;
    case 'no_invoice_num':          return bv;
    default:                        return 0;
  }
}

// Aggregate count + $ at stake per vendor (skipping clean matches).
function diffTopVendors(diffs, n = 8) {
  const m = new Map();
  for (const d of diffs) {
    if (d.kind === 'matched') continue;
    const v = (d.dashboard?.payee || d.bookkeeper?.vendor || 'Unknown').trim();
    if (!m.has(v)) m.set(v, { vendor: v, count: 0, amount: 0 });
    const e = m.get(v); e.count++; e.amount += diffRowDollarDelta(d);
  }
  return [...m.values()].sort((a, b) => b.amount - a.amount).slice(0, n);
}

// Top N individual rows by $ at stake.
function diffTopByImpact(diffs, n = 10) {
  return diffs
    .filter(r => r.kind !== 'matched')
    .map(r => ({
      vendor:   (r.dashboard?.payee || r.bookkeeper?.vendor || '—').trim(),
      invoice:  r.dashboard?.invoice_number || r.bookkeeper?.invoice || '—',
      category: (DIFF_CATEGORIES.find(c => c.key === r.kind) || {}).label || r.kind,
      delta:    diffRowDollarDelta(r),
    }))
    .sort((a, b) => b.delta - a.delta)
    .slice(0, n);
}

// Shared column shape used by every diff sheet. Issues + Match are
// columns 3 and 4 so the bookkeeper sees WHY before having to scroll
// sideways through 14 evidence columns. Issues renders as coloured
// tags (richText), not prose, so it stays narrow.
const DIFF_COLUMNS = [
  { header: 'Sheet',               key: 'sheet',          width: 11 },
  { header: 'Row',                 key: 'rowNum',         width: 6  },
  { header: 'Issues',              key: 'issues',         width: 28, wrap: true },
  { header: 'Match',               key: 'match',          width: 18 },
  { header: 'Vendor',              key: 'bk_vendor',      width: 24 },
  { header: 'Invoice #',           key: 'bk_invoice',     width: 14 },
  { header: 'Amount',              key: 'bk_amount',      width: 12, type: 'currency' },
  { header: 'Paid date',           key: 'bk_paid_date',   width: 11, type: 'date' },
  { header: 'Paid amount',         key: 'bk_paid_amount', width: 11, type: 'currency' },
  { header: 'Artist',              key: 'bk_artist',      width: 14 },
  { header: 'Description',         key: 'bk_description', width: 28, wrap: true },
  { header: 'Payee',               key: 'dash_payee',     width: 24 },
  { header: 'Invoice #',           key: 'dash_invoice',   width: 14 },
  { header: 'Amount',              key: 'dash_amount',    width: 12, type: 'currency' },
  { header: 'Payment status',      key: 'dash_status',    width: 11 },
  { header: 'Payment date',        key: 'dash_pay_date',  width: 11, type: 'date' },
  { header: 'Artist',              key: 'dash_artist',    width: 14 },
  { header: 'Dash id',             key: 'dash_id',        width: 8  },
];

// Map issue prose prefixes to a canonical tag id. Each row can have
// MULTIPLE issues (e.g., amount + paid status + vendor variation); we
// surface every one of them as a coloured tag in the Issues column and
// highlight every relevant cell — not just the primary "kind".
function diffParseIssueTags(issues) {
  const tags = [];
  for (const s of issues || []) {
    if (/^Amount mismatch/.test(s))           tags.push('amount');
    else if (/^Paid status differs/.test(s))  tags.push('paid_status');
    else if (/^Paid date differs/.test(s))    tags.push('paid_date');
    else if (/^Vendor names differ/.test(s))  tags.push('vendor');
    else if (/Market Street ledger has this row/i.test(s)) tags.push('missing_bk');
    else if (/not in.*ledger/i.test(s) || /not in boom/i.test(s)) tags.push('missing_dash');
    else if (/no invoice/i.test(s))           tags.push('no_invoice');
  }
  return tags;
}

const DIFF_TAG_META = {
  amount:       { label: 'AMOUNT',        color: 'FFB91C1C' }, // red-700
  paid_status:  { label: 'PAID STATUS',   color: 'FFC2410C' }, // orange-700
  paid_date:    { label: 'PAID DATE',     color: 'FFA16207' }, // amber-700
  vendor:       { label: 'VENDOR',        color: 'FF6D28D9' }, // violet-700
  missing_bk:   { label: 'MISSING ON BK', color: 'FF374151' },
  missing_dash: { label: 'MISSING ON MARKET STREET', color: 'FF374151' },
  no_invoice:   { label: 'NO INVOICE #',  color: 'FF374151' },
};

// Derive the cells to flag red from the parsed tag set — so a row that
// has THREE problems gets six cells highlighted, not two.
function diffHighlightKeysFromTags(tags) {
  const keys = new Set();
  for (const t of tags) {
    if (t === 'amount')      { keys.add('bk_amount');    keys.add('dash_amount'); }
    if (t === 'paid_status') { keys.add('bk_paid_date'); keys.add('dash_status'); }
    if (t === 'paid_date')   { keys.add('bk_paid_date'); keys.add('dash_pay_date'); }
    if (t === 'vendor')      { keys.add('bk_vendor');    keys.add('dash_payee'); }
  }
  return keys;
}

// Lay out one diff sheet — title row, action note, BOOKKEEPER | DASHBOARD
// banner, column header, body, subtotal. Used by buildDiffWorkbook (one
// tab per category) AND /ledger-diff-export (one tab total) so both
// endpoints produce identical output.
function writeDiffSheet(ws, { catRows, title, note, noteColor }) {
  const THIN  = { style: 'thin',  color: { argb: DIFF_BRAND.BORDER } };
  const HEAVY = { style: 'medium', color: { argb: 'FF1F2937' } };
  ws.columns = DIFF_COLUMNS.map(c => ({ key: c.key, width: c.width }));
  const lastColLetter = ws.getColumn(DIFF_COLUMNS.length).letter;

  // Locate side boundaries so the banner + separator borders land in the
  // right columns even if we reorder DIFF_COLUMNS later.
  const colOf = (k) => DIFF_COLUMNS.findIndex(c => c.key === k) + 1;
  const colLetter = (n) => ws.getColumn(n).letter;
  const bkStart  = colOf('bk_vendor');
  const bkEnd    = colOf('bk_description');
  const dashStart = colOf('dash_payee');
  const dashEnd  = colOf('dash_id');

  // Row 1: Title
  ws.addRow([title]);
  ws.mergeCells(`A1:${lastColLetter}1`);
  Object.assign(ws.getCell('A1'), {
    font: { bold: true, size: 16, color: { argb: 'FF111111' } },
    alignment: { vertical: 'middle', horizontal: 'left' },
  });
  ws.getRow(1).height = 26;
  // Row 2: Action note
  ws.addRow([note || '']);
  ws.mergeCells(`A2:${lastColLetter}2`);
  Object.assign(ws.getCell('A2'), {
    font: { italic: true, size: 10, color: { argb: noteColor || DIFF_BRAND.GRAY } },
    alignment: { vertical: 'middle', horizontal: 'left', wrapText: true },
  });
  ws.getRow(2).height = 22;

  // Row 3: Section banner — BOOKKEEPER | DASHBOARD
  const banner = ws.addRow([]);
  banner.height = 18;
  ws.mergeCells(`${colLetter(bkStart)}${banner.number}:${colLetter(bkEnd)}${banner.number}`);
  ws.mergeCells(`${colLetter(dashStart)}${banner.number}:${colLetter(dashEnd)}${banner.number}`);
  const bkBan = ws.getCell(`${colLetter(bkStart)}${banner.number}`);
  bkBan.value = 'BOOKKEEPER RECORD';
  bkBan.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } };
  bkBan.font = { bold: true, size: 10, color: { argb: 'FF1E3A8A' } };
  bkBan.alignment = { vertical: 'middle', horizontal: 'center' };
  const dashBan = ws.getCell(`${colLetter(dashStart)}${banner.number}`);
  dashBan.value = 'MARKET STREET DASHBOARD RECORD';
  dashBan.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF2F2' } };
  dashBan.font = { bold: true, size: 10, color: { argb: 'FF991B1B' } };
  dashBan.alignment = { vertical: 'middle', horizontal: 'center' };

  // Row 4: column headers
  const headerRow = ws.addRow(DIFF_COLUMNS.map(c => c.header));
  headerRow.height = 22;
  headerRow.eachCell((cell, col) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DIFF_BRAND.RED } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
    // Heavy separator on the BK→Dash seam (right edge of bk_description,
    // left edge of dash_payee). Reads as a single thick vertical rule.
    if (col === bkEnd)    cell.border = { ...cell.border, right: HEAVY };
    if (col === dashStart) cell.border = { ...cell.border, left:  HEAVY };
  });
  ws.autoFilter = { from: { row: headerRow.number, column: 1 },
                    to:   { row: headerRow.number, column: DIFF_COLUMNS.length } };

  // Body rows
  let bkSum = 0, dashSum = 0;
  catRows.forEach((r, i) => {
    const b = r.bookkeeper || {};
    const d = r.dashboard || {};
    const meta = diffConfidenceMeta(r.vendor_match_reason);
    const tags = diffParseIssueTags(r.issues);
    const highlight = diffHighlightKeysFromTags(tags);

    // Empty out 0 / null noise so unpaid rows don't show "$0.00" everywhere.
    // 0 is conventionally "not filled in" in the bookkeeper's source.
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) !== 0) ? Number(v) : null;
    const bkAmt   = Number.isFinite(Number(b.amount)) ? Number(b.amount) : null; // amount IS meaningful at 0 if explicit; keep
    const dashAmt = Number.isFinite(Number(d.family_amount ?? d.amount))
                       ? Number(d.family_amount ?? d.amount) : null;
    const data = {
      sheet:         r.sheet || '',
      rowNum:        r.rowNum || '',
      issues:        '',                              // set below as richText
      match:         meta.label,
      bk_vendor:     b.vendor || '',
      bk_invoice:    b.invoice || '',
      bk_amount:     bkAmt,
      bk_paid_date:  b.paid_date ? new Date(b.paid_date) : null,
      bk_paid_amount:num(b.paid_amount),
      bk_artist:     b.artist || '',
      bk_description:b.description || '',
      dash_payee:    d.payee || '',
      dash_invoice:  d.invoice_number || '',
      dash_amount:   dashAmt,
      dash_status:   d.payment_status || '',
      dash_pay_date: d.payment_date ? new Date(d.payment_date) : null,
      dash_artist:   d.artist || '',
      dash_id:       d.id || '',
    };
    bkSum   += bkAmt   || 0;
    dashSum += dashAmt || 0;

    const row = ws.addRow(data);

    // Issues column — coloured tag pills via richText. Drops the prose
    // duplication of values that are already shown red in adjacent cells.
    if (tags.length > 0) {
      const richText = [];
      tags.forEach((t, idx) => {
        const tm = DIFF_TAG_META[t];
        if (!tm) return;
        if (idx > 0) richText.push({ text: '  ·  ', font: { color: { argb: 'FF9CA3AF' }, size: 9 } });
        richText.push({ text: tm.label, font: { bold: true, color: { argb: tm.color }, size: 10 } });
      });
      row.getCell('issues').value = { richText };
    }

    const banded = i % 2 === 1;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const colDef = DIFF_COLUMNS[col - 1];
      cell.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
      cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: !!colDef?.wrap };
      // Cell-level decisions, in priority order.
      if (highlight.has(colDef.key)) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DIFF_BRAND.HL_FILL } };
        cell.font = { bold: true, color: { argb: DIFF_BRAND.HL_TEXT } };
      } else if (colDef.key === 'match' && meta.fill) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: meta.fill } };
        cell.font = { bold: true, size: 10, color: { argb: meta.text } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
      } else if (banded) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DIFF_BRAND.BAND } };
      }
      if (colDef?.type === 'currency' && typeof cell.value === 'number') {
        cell.numFmt = '"$"#,##0.00;[Red]-"$"#,##0.00';
        cell.alignment = { ...cell.alignment, horizontal: 'right' };
      } else if (colDef?.type === 'date' && cell.value instanceof Date) {
        cell.numFmt = 'yyyy-mm-dd';
      }
      // Heavy separator on the BK→Dash seam, every row.
      if (col === bkEnd)     cell.border = { ...cell.border, right: HEAVY };
      if (col === dashStart) cell.border = { ...cell.border, left:  HEAVY };
    });
  });

  // Subtotal footer
  if (catRows.length > 0) {
    ws.addRow([]);
    const sub = ws.addRow({
      bk_vendor:  `TOTAL — ${catRows.length} row${catRows.length === 1 ? '' : 's'}`,
      bk_amount:  bkSum,
      dash_amount: dashSum,
    });
    sub.eachCell({ includeEmpty: false }, (cell, col) => {
      const colDef = DIFF_COLUMNS[col - 1];
      cell.font = { bold: true, size: 11, color: { argb: 'FF111111' } };
      cell.border = { top: { style: 'medium', color: { argb: 'FF111111' } }, bottom: THIN };
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
      if (colDef?.type === 'currency') {
        cell.numFmt = '"$"#,##0.00;[Red]-"$"#,##0.00';
        cell.alignment = { ...cell.alignment, horizontal: 'right' };
      }
      if (col === bkEnd)     cell.border = { ...cell.border, right: HEAVY };
      if (col === dashStart) cell.border = { ...cell.border, left:  HEAVY };
    });
  }
  return ws;
}

// Build the full multi-sheet diff workbook. Returns the xlsx buffer.
async function buildDiffWorkbook({ summary, diffs }) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Market Street Dashboard';
  wb.created = new Date();
  const THIN = { style: 'thin', color: { argb: DIFF_BRAND.BORDER } };

  // ── Summary sheet (the cover) ──────────────────────────────────────────
  const ws = wb.addWorksheet('Summary', {
    views: [{ showGridLines: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = [{ width: 30 }, { width: 14 }, { width: 16 }, { width: 12 }, { width: 64 }];

  ws.addRow(['Ledger Reconciliation Report']);
  ws.mergeCells('A1:E1');
  Object.assign(ws.getCell('A1'), {
    font: { bold: true, size: 24, color: { argb: 'FF111111' } },
    alignment: { vertical: 'middle', horizontal: 'left' },
  });
  ws.getRow(1).height = 34;
  ws.addRow(['Market Street  ⇄  External Bookkeeper']);
  ws.mergeCells('A2:E2');
  Object.assign(ws.getCell('A2'), {
    font: { italic: true, size: 12, color: { argb: DIFF_BRAND.GRAY } },
    alignment: { vertical: 'middle', horizontal: 'left' },
  });
  ws.addRow([]);

  // Meta block — small, dim, ledger-style.
  const metaRows = [
    ['Generated',         new Date().toLocaleDateString('en-US', { dateStyle: 'long' })],
    ['Workbook snapshot', summary?.week_ending ? `Week ending ${summary.week_ending}` : '—'],
    ['Years covered',     (summary?.sheet_years || []).join(', ') || '—'],
    ['Bookkeeper rows',   (summary?.bookkeeper_rows || 0).toLocaleString()],
    ['Dashboard rows',    (summary?.dashboard_rows  || 0).toLocaleString()],
  ];
  for (const [k, v] of metaRows) {
    const r = ws.addRow([k, v]);
    r.getCell(1).font = { bold: true, size: 10, color: { argb: DIFF_BRAND.GRAY } };
    r.getCell(2).font = { size: 11 };
  }
  ws.addRow([]);

  // Headline "$ at stake" banner — the single most important number.
  const totalAtStake = (diffs || []).reduce((s, d) => s + diffRowDollarDelta(d), 0);
  const stakeRow = ws.addRow(['Total $ at stake', totalAtStake]);
  ws.mergeCells(`B${stakeRow.number}:E${stakeRow.number}`);
  stakeRow.getCell(1).font = { bold: true, size: 12, color: { argb: 'FF111111' } };
  stakeRow.getCell(2).font = { bold: true, size: 16, color: { argb: DIFF_BRAND.RED } };
  stakeRow.getCell(2).numFmt = '"$"#,##0.00';
  stakeRow.getCell(2).alignment = { vertical: 'middle', horizontal: 'left' };
  stakeRow.height = 26;
  ws.addRow([]);

  // Category table — now with a $ at stake column.
  const catHeader = ws.addRow(['Category', 'Rows', '$ at stake', 'Priority', 'What this means / what to do']);
  catHeader.height = 22;
  catHeader.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DIFF_BRAND.RED } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
  });
  for (const cat of DIFF_CATEGORIES) {
    const count = summary?.counts?.[cat.key] || 0;
    const atStake = (diffs || [])
      .filter(d => d.kind === cat.key)
      .reduce((s, d) => s + diffRowDollarDelta(d), 0);
    const r = ws.addRow([cat.label, count, atStake, cat.priority, cat.action]);
    r.alignment = { vertical: 'top', wrapText: true };
    r.getCell(1).font = { bold: count > 0, size: 11 };
    r.getCell(2).numFmt = '#,##0';
    r.getCell(2).alignment = { vertical: 'top', horizontal: 'right' };
    r.getCell(3).numFmt = '"$"#,##0.00';
    r.getCell(3).alignment = { vertical: 'top', horizontal: 'right' };
    r.getCell(3).font = { bold: count > 0, size: 11, color: { argb: count > 0 ? 'FF111111' : 'FFB0B5BD' } };
    r.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PRIORITY_FILL[cat.priority] } };
    r.getCell(4).font = { bold: true, size: 10, color: { argb: PRIORITY_TEXT[cat.priority] } };
    r.getCell(4).alignment = { vertical: 'middle', horizontal: 'center' };
    r.getCell(5).font = { size: 10, color: { argb: 'FF333333' } };
    if (count === 0) r.eachCell(c => { c.font = { ...(c.font || {}), color: { argb: 'FFB0B5BD' } }; });
    r.eachCell(c => { c.border = { top: THIN, bottom: THIN, left: THIN, right: THIN }; });
  }

  const sectionTitle = (text) => {
    ws.addRow([]);
    const r = ws.addRow([text]);
    ws.mergeCells(`A${r.number}:E${r.number}`);
    r.getCell(1).font = { bold: true, size: 13, color: { argb: 'FF111111' } };
    r.height = 22;
  };
  const miniHeader = (cells) => {
    const r = ws.addRow(cells);
    r.eachCell((cell, col) => {
      if (col > cells.filter(Boolean).length) return;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      cell.font = { bold: true, size: 10, color: { argb: DIFF_BRAND.GRAY } };
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
      cell.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
    });
    return r;
  };

  // Top discrepancies by $ at stake — where to start.
  const topImpact = diffTopByImpact(diffs || [], 10);
  if (topImpact.length > 0) {
    sectionTitle('Top discrepancies by $ at stake');
    miniHeader(['Vendor', 'Invoice #', 'Category', '$ at stake', '']);
    for (const t of topImpact) {
      const r = ws.addRow([t.vendor, t.invoice, t.category, t.delta, '']);
      r.getCell(1).font = { size: 11 };
      r.getCell(2).font = { size: 11, color: { argb: 'FF6B7280' } };
      r.getCell(3).font = { size: 10, color: { argb: 'FF374151' } };
      r.getCell(4).numFmt = '"$"#,##0.00';
      r.getCell(4).alignment = { horizontal: 'right' };
      r.getCell(4).font = { bold: true, size: 11 };
      for (let c = 1; c <= 4; c++) r.getCell(c).border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
    }
  }

  // Top vendors by $ at stake — useful for batch-handling one vendor at a time.
  const topV = diffTopVendors(diffs || [], 8);
  if (topV.length > 0) {
    sectionTitle('Top vendors by $ at stake');
    miniHeader(['Vendor', 'Discrepancies', '$ at stake', '', '']);
    for (const v of topV) {
      const r = ws.addRow([v.vendor, v.count, v.amount, '', '']);
      r.getCell(1).font = { size: 11 };
      r.getCell(2).numFmt = '#,##0';
      r.getCell(2).alignment = { horizontal: 'right' };
      r.getCell(3).numFmt = '"$"#,##0.00';
      r.getCell(3).alignment = { horizontal: 'right' };
      r.getCell(3).font = { bold: true, size: 11 };
      for (let c = 1; c <= 3; c++) r.getCell(c).border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
    }
  }

  // Confidence chip legend — how to read the "Match" column on each tab.
  sectionTitle('Match confidence legend');
  const intro = ws.addRow(['How vendor names were matched on each row. Red-flagged cells on each tab are the specific values in dispute.']);
  ws.mergeCells(`A${intro.number}:E${intro.number}`);
  intro.getCell(1).font = { italic: true, color: { argb: DIFF_BRAND.GRAY }, size: 10 };
  intro.alignment = { wrapText: true };
  const tiers = [
    { reason: 'exact',            note: 'Vendor name identical on both sides.' },
    { reason: 'parentheticals',   note: 'Same name; one side has extra info in parentheses — e.g. "ACME LLC (DBA UKG)" vs "ACME LLC".' },
    { reason: 'suffixes',         note: 'Same name; one side has a different business suffix — e.g. "ACME LLC" vs "ACME INC".' },
    { reason: 'substring',        note: 'One side\'s name is fully contained in the other — e.g. "PINK PANTHERS" vs "PINK PANTHERS B.V.".' },
    { reason: 'suffix-substring', note: 'One side fully contains the other after dropping business suffixes.' },
    { reason: 'tokens-0.80',      note: 'Same words in a different order — e.g. "Niccolo Cosci" vs "COSCI, NICCOLO".' },
  ];
  for (const t of tiers) {
    const meta = diffConfidenceMeta(t.reason);
    const r = ws.addRow([meta.label, t.note, '', '', '']);
    ws.mergeCells(`B${r.number}:E${r.number}`);
    if (meta.fill) {
      r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: meta.fill } };
      r.getCell(1).font = { bold: true, size: 10, color: { argb: meta.text } };
    } else {
      r.getCell(1).font = { size: 10, color: { argb: DIFF_BRAND.GRAY } };
    }
    r.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
    r.getCell(1).border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
    r.getCell(2).font = { size: 10, color: { argb: 'FF333333' } };
    r.getCell(2).alignment = { vertical: 'middle', horizontal: 'left' };
  }

  // Footer hint
  ws.addRow([]);
  const hint = ws.addRow(['Each non-empty category has its own tab in this workbook. Red-highlighted cells on each tab are the specific values in dispute.']);
  ws.mergeCells(`A${hint.number}:E${hint.number}`);
  hint.getCell(1).font = { italic: true, color: { argb: DIFF_BRAND.GRAY }, size: 10 };

  // ── Per-category sheets ────────────────────────────────────────────────
  for (const cat of DIFF_CATEGORIES) {
    const catRows = (diffs || []).filter(r => r.kind === cat.key);
    if (catRows.length === 0) continue;
    const sheetName = cat.label.slice(0, 31);
    const catWs = wb.addWorksheet(sheetName, {
      views: [{ showGridLines: false, state: 'frozen', ySplit: 4 }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    writeDiffSheet(catWs, {
      catRows,
      title: `${cat.label} (${catRows.length})`,
      note: cat.action,
      noteColor: PRIORITY_TEXT[cat.priority],
    });
  }

  return await wb.xlsx.writeBuffer();
}

// POST /api/bk/ledger-diff-report — multi-sheet workbook covering EVERY
// non-empty category. The "forward this straight to the bookkeeper"
// deliverable. Body: { diff: { summary, diffs } }.
router.post('/ledger-diff-report', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const diff = req.body?.diff || req.body;
    if (!diff || !Array.isArray(diff.diffs)) {
      return res.status(400).json({ success: false, error: 'diff payload required' });
    }
    const buf = await buildDiffWorkbook(diff);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ledger-reconciliation-${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('POST /api/bk/ledger-diff-report:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/ledger-diff-handoff — the full handoff bundle.
// Body: { diff: { summary, diffs } }.
// ZIP layout (vendor-first, the bookkeeper's mental model):
//
//   ledger-reconciliation-<date>/
//   ├── 00 - START HERE - Reconciliation Report.xlsx
//   ├── 00 - README.txt
//   ├── 01 - Invoices/
//   │   ├── <Vendor>/<invoice#> — <invoice_date>.<ext>
//   │   └── <Vendor>/_VENDOR_SUMMARY.txt
//   ├── 02 - W9s and W8s/
//   │   ├── <Vendor>.<ext>
//   │   └── _MISSING.txt           (vendors with no W9 on file)
//   └── 03 - Proof of Payment/
//       └── <Vendor>/<invoice#> — PAID <payment_date>.<ext>
//
// Numbered top-level folders so they sort naturally; root files prefixed
// "00 -" so the START HERE files appear first.
router.post('/ledger-diff-handoff', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const diff = req.body?.diff || req.body;
    if (!diff || !Array.isArray(diff.diffs)) {
      return res.status(400).json({ success: false, error: 'diff payload required' });
    }

    const archiver = require('archiver');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="ledger-reconciliation-${new Date().toISOString().slice(0,10)}.zip"`);
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', err => { throw err; });
    archive.pipe(res);

    // 1) Workbook at the root
    const wbBuf = await buildDiffWorkbook(diff);
    archive.append(Buffer.from(wbBuf), { name: '00 - START HERE - Reconciliation Report.xlsx' });

    // 2) Collect dashboard entry ids referenced by the diff. These are the
    //    rows we'll pull invoice / proof / W9 files for. Bookkeeper-only
    //    rows (missing_from_dashboard) have no dashboard side -> no files
    //    to attach; they're surfaced in the workbook for the bookkeeper to
    //    push back on Market Street.
    const dashIds = new Set();
    const vendorsLc = new Set();
    for (const r of diff.diffs) {
      if (r.dashboard?.id) dashIds.add(r.dashboard.id);
      const v = (r.dashboard?.payee || r.bookkeeper?.vendor || '').trim().toLowerCase();
      if (v) vendorsLc.add(v);
    }

    let invoicesAdded = 0;
    let proofsAdded = 0;
    let w9sAdded = 0;
    const vendorsWithoutW9 = [];

    if (dashIds.size > 0) {
      // 3) Pull invoice + proof files in one query. Family roots only;
      //    children inherit the parent's invoice file in this product.
      const { rows: fileRows } = await pool.query(`
        SELECT id, payee, invoice_number, invoice_date, payment_date,
               invoice_filename, invoice_data, invoice_r2_key,
               proof_filename,   proof_data,   proof_r2_key
          FROM expenses
         WHERE id = ANY($1::int[])
           AND (deleted = false OR deleted IS NULL)
      `, [[...dashIds]]);

      // Per-vendor accumulators so we can write a small _VENDOR_SUMMARY.txt
      // alongside each vendor folder.
      const perVendor = new Map(); // vendorName -> [{invoice, dateISO, hasInvoice, hasProof}]
      const usedNamesByFolder = new Map();
      const safe = (s) => safeNameForZip(s);
      const uniqueFilename = (folder, base, ext) => {
        if (!usedNamesByFolder.has(folder)) usedNamesByFolder.set(folder, new Set());
        const used = usedNamesByFolder.get(folder);
        let name = `${base}.${ext}`;
        let n = 2;
        while (used.has(name)) { name = `${base} (${n}).${ext}`; n++; }
        used.add(name);
        return name;
      };

      for (const r of fileRows) {
        const vendor = safe(r.payee || 'Unknown vendor');
        const inv = safe(String(r.invoice_number || `id-${r.id}`).trim());
        const invDate = r.invoice_date ? new Date(r.invoice_date).toISOString().slice(0, 10) : null;
        const payDate = r.payment_date ? new Date(r.payment_date).toISOString().slice(0, 10) : null;
        const entry = { invoice: r.invoice_number, dateISO: invDate, payDate, hasInvoice: false, hasProof: false };

        // Invoice
        try {
          const buf = await loadFileBuffer(r.invoice_r2_key, r.invoice_data);
          if (buf) {
            const ext = ((r.invoice_filename || '').split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf';
            const base = invDate ? `${inv} — ${invDate}` : inv;
            const folder = `01 - Invoices/${vendor}`;
            const name = uniqueFilename(folder, base, ext);
            archive.append(buf, { name: `${folder}/${name}` });
            invoicesAdded++;
            entry.hasInvoice = true;
          }
        } catch (err) { console.warn(`[handoff] invoice ${r.id}:`, err.message); }

        // Proof of payment
        try {
          const buf = await loadFileBuffer(r.proof_r2_key, r.proof_data);
          if (buf) {
            const ext = ((r.proof_filename || '').split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf';
            const base = payDate ? `${inv} — PAID ${payDate}` : `${inv} — PAID`;
            const folder = `03 - Proof of Payment/${vendor}`;
            const name = uniqueFilename(folder, base, ext);
            archive.append(buf, { name: `${folder}/${name}` });
            proofsAdded++;
            entry.hasProof = true;
          }
        } catch (err) { console.warn(`[handoff] proof ${r.id}:`, err.message); }

        if (!perVendor.has(vendor)) perVendor.set(vendor, []);
        perVendor.get(vendor).push(entry);
      }

      // 4) _VENDOR_SUMMARY.txt for each invoice folder so the bookkeeper
      //    can see at a glance which invoices made it into the zip and
      //    which were missing files.
      for (const [vendor, entries] of perVendor) {
        if (entries.length === 0) continue;
        const lines = [
          `# ${vendor} — ${entries.length} invoice${entries.length === 1 ? '' : 's'} referenced`,
          `# (an X means the file is NOT in this folder — original wasn't uploaded to Market Street yet)`,
          '',
          'Invoice #              Invoice date    Inv?    Proof?',
        ];
        for (const e of entries.sort((a, b) => String(a.invoice || '').localeCompare(String(b.invoice || '')))) {
          lines.push(
            `${String(e.invoice || '—').padEnd(22, ' ')}${String(e.dateISO || '—').padEnd(16, ' ')}${e.hasInvoice ? '✓' : 'X '}      ${e.hasProof ? '✓' : 'X'}`
          );
        }
        archive.append(lines.join('\n') + '\n', { name: `01 - Invoices/${vendor}/_VENDOR_SUMMARY.txt` });
      }
    }

    // 5) W9s — one per unique vendor that appeared in the diff. Most-recent
    //    on file wins (DISTINCT ON LOWER(payee) ORDER BY id DESC). Match
    //    against the vendor names that came from EITHER side of the diff,
    //    alias-aware so a vendor's W9 filed under a DBA still gets picked
    //    up (and doesn't get falsely flagged as missing).
    if (vendorsLc.size > 0) {
      const { searchList, requestorForName } = await expandVendorAliases(pool, vendorsLc);
      const { rows: w9Rows } = await pool.query(`
        SELECT DISTINCT ON (LOWER(payee)) id, payee, w9_data, w9_r2_key, w9_filename
          FROM expenses
         WHERE LOWER(payee) = ANY($1::text[])
           AND (deleted = false OR deleted IS NULL)
           AND ((w9_data IS NOT NULL AND w9_data != '') OR w9_r2_key IS NOT NULL)
         ORDER BY LOWER(payee) ASC, id DESC
      `, [searchList]);
      const foundLc = new Set();
      const w9Used = new Set();
      for (const r of w9Rows) {
        try {
          const buf = await loadFileBuffer(r.w9_r2_key, r.w9_data);
          if (!buf) continue;
          const payeeLc = (r.payee || '').toLowerCase();
          // Credit every requestor spelling that resolves to this payee —
          // finding "Edward Marange" satisfies a request for "Eddie".
          const requestors = requestorForName.get(payeeLc);
          if (requestors && requestors.size) {
            for (const rq of requestors) foundLc.add(rq);
          } else {
            foundLc.add(payeeLc);
          }
          const ext = ((r.w9_filename || '').split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf';
          const base = safeNameForZip(r.payee || 'Unknown');
          let name = `${base}.${ext}`; let n = 2;
          while (w9Used.has(name)) { name = `${base} (${n}).${ext}`; n++; }
          w9Used.add(name);
          archive.append(buf, { name: `02 - W9s and W8s/${name}` });
          w9sAdded++;
        } catch (err) { console.warn('[handoff] W9 error:', err.message); }
      }
      for (const v of vendorsLc) if (!foundLc.has(v)) vendorsWithoutW9.push(v);
      if (vendorsWithoutW9.length > 0) {
        const note = [
          `# Vendors referenced in the reconciliation with no W9 / W8 on file (${vendorsWithoutW9.length}):`,
          `# Market Street needs to chase these before remitting future payments.`,
          '',
          ...vendorsWithoutW9.sort().map(v => `- ${v}`),
        ].join('\n') + '\n';
        archive.append(note, { name: '02 - W9s and W8s/_MISSING.txt' });
      }
    }

    // 6) README at the root explaining the bundle
    const readme = [
      'MARKET STREET — LEDGER RECONCILIATION HANDOFF',
      '=============================================',
      '',
      `Generated:        ${new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })}`,
      diff.summary?.week_ending ? `Workbook snapshot: week ending ${diff.summary.week_ending}` : '',
      diff.summary?.sheet_years?.length ? `Years covered:    ${diff.summary.sheet_years.join(', ')}` : '',
      '',
      'WHAT\'S IN THIS ZIP',
      '------------------',
      '',
      '00 - START HERE - Reconciliation Report.xlsx',
      '    Multi-sheet workbook. Summary tab on open, then one tab per',
      '    discrepancy category in priority order (Amount mismatches,',
      '    Paid status differs, Missing on Market Street, Missing on bookkeeper,',
      '    Paid date differs, Vendor name variations, No invoice number,',
      '    Clean matches).',
      '',
      '01 - Invoices/',
      '    One folder per vendor referenced in the report. Each folder',
      '    contains the original invoice PDFs Market Street has on file, named',
      '    "<invoice #> — <invoice date>.<ext>" so they sort by number',
      '    + date when opened. A small _VENDOR_SUMMARY.txt lists every',
      '    referenced invoice for that vendor and notes which are',
      '    missing their attachment on Market Street\'s side.',
      '',
      '02 - W9s and W8s/',
      '    One W9 / W8 per unique vendor (most recent on file). The',
      '    _MISSING.txt file lists vendors that appear in the report',
      '    but have no W9 / W8 attached on Market Street\'s side — chase those.',
      '',
      '03 - Proof of Payment/',
      '    Same vendor folder layout as Invoices. PDFs named',
      '    "<invoice #> — PAID <payment date>.<ext>". Only includes',
      '    rows that already have a proof of payment uploaded to Market Street.',
      '',
      'COUNTS',
      '------',
      '',
      `Bookkeeper rows parsed:    ${(diff.summary?.bookkeeper_rows || 0).toLocaleString()}`,
      `Dashboard rows considered: ${(diff.summary?.dashboard_rows  || 0).toLocaleString()}`,
      '',
      ...DIFF_CATEGORIES.map(c => `  ${c.label.padEnd(26, ' ')} ${(diff.summary?.counts?.[c.key] || 0).toString().padStart(6, ' ')}  [${c.priority}]`),
      '',
      `Invoice files included:    ${invoicesAdded.toLocaleString()}`,
      `Proof-of-payment files:    ${proofsAdded.toLocaleString()}`,
      `W9 / W8 files included:    ${w9sAdded.toLocaleString()}`,
      `Vendors missing W9 / W8:   ${vendorsWithoutW9.length.toLocaleString()}`,
      '',
      'QUESTIONS / DISCREPANCIES',
      '--------------------------',
      '',
      'Reply to john@deanst.co with the specific row reference',
      '(category sheet + Market Street dashboard id or bookkeeper sheet + row #)',
      'when something needs clarification.',
      '',
    ].filter(Boolean).join('\n');
    archive.append(readme, { name: '00 - README.txt' });

    await archive.finalize();
  } catch (err) {
    console.error('POST /api/bk/ledger-diff-handoff:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/ledger-diff-export — accepts the diff payload + a category
// from the Bookkeeper Reconcile page (/bk/ledger-matching) and streams back a styled .xlsx of those
// rows. Page-driven export (rather than re-uploading the source workbook)
// so the user gets exactly what's on screen including any filtering they
// did. Body: { rows: [...], category: '...', summary?: {...} }.
router.post('/ledger-diff-export', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows = [], category = 'all', summary = null } = req.body || {};
    if (!Array.isArray(rows)) return res.status(400).json({ success: false, error: 'rows must be an array' });

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Market Street Dashboard';
    wb.created = new Date();

    // Use the canonical category def + writeDiffSheet helper so this
    // single-tab export visually matches a tab from the full report.
    const cat = DIFF_CATEGORIES.find(c => c.key === category)
             || { label: 'Ledger diff', action: '', priority: 'INFO' };
    const ws = wb.addWorksheet(cat.label.slice(0, 31), {
      views: [{ showGridLines: false, state: 'frozen', ySplit: 4 }],
      pageSetup: {
        orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
      },
    });

    const metaBits = [];
    metaBits.push(`Generated ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}`);
    metaBits.push(`${rows.length} row${rows.length === 1 ? '' : 's'}`);
    if (summary?.week_ending) metaBits.push(`week ending ${summary.week_ending}`);
    if (summary?.sheet_years?.length) metaBits.push(`years ${summary.sheet_years.join(', ')}`);

    writeDiffSheet(ws, {
      catRows: rows,
      title: `Bookkeeper Reconcile — ${cat.label}`,
      note: cat.action ? `${cat.action}  ·  ${metaBits.join(' · ')}` : metaBits.join(' · '),
      noteColor: PRIORITY_TEXT[cat.priority],
    });

    const buf = await wb.xlsx.writeBuffer();
    const safeCat = String(category).replace(/[^a-z0-9_-]/gi, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ledger-diff-${safeCat}-${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('POST /api/bk/ledger-diff-export:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── BK-style Excel export ──────────────────────────────────────────────
// Uses the external bookkeeper's source workbook as a styling TEMPLATE:
// loads the uploaded BK xlsx, captures row 9's per-column style on each
// year-data sheet, splices out the bookkeeper's data rows, then writes
// Market Street dashboard data into the same rows using the captured style.
// Guarantees pixel-perfect match — same theme, fonts, fills, widths,
// heights, frozen panes — because we're starting from the user's file.

// Map a Market Street expenses row to the bookkeeper's column shape. Values that
// Market Street doesn't structure (HENRY/FAVELA sign-offs, ROUTING/ACCT ENDING
// when vendor_bank is free text) stay empty per the user's choice to
// preserve the layout but only populate what Market Street has.
function bkRowFromExpense(e) {
  // W9/W8 detection by filename suffix — Market Street stores both under w9_*.
  let w9Status = '';
  if (e.w9_filename) {
    w9Status = /w8/i.test(e.w9_filename) ? 'W8 ON FILE' : 'W9 ON FILE';
  }
  // RECD FROM — format boom_rep "John Skead" -> "SKEAD, JOHN" to match
  // the bookkeeper's "LASTNAME, FIRSTNAME" convention.
  let recdFrom = '';
  if (e.boom_rep) {
    const parts = String(e.boom_rep).trim().split(/\s+/);
    recdFrom = parts.length >= 2
      ? `${parts.at(-1).toUpperCase()}, ${parts.slice(0, -1).join(' ').toUpperCase()}`
      : String(e.boom_rep).toUpperCase();
  }
  // DUE DATE — prefer the stored scheduled_payment_date so manual
  // overrides survive. Otherwise derive from created_at + payment_terms
  // "Net N" so the BK Excel matches Market Street's submission-anchored policy.
  let dueDate = null;
  if (e.scheduled_payment_date) {
    dueDate = new Date(e.scheduled_payment_date);
  } else if (e.created_at && e.payment_terms) {
    const m = String(e.payment_terms).match(/(\d+)/);
    if (m) {
      const d = new Date(e.created_at);
      d.setUTCDate(d.getUTCDate() + parseInt(m[1], 10));
      dueDate = d;
    }
  }
  const amount = Number.isFinite(Number(e.family_amount ?? e.amount))
                   ? Number(e.family_amount ?? e.amount) : null;
  const isPaid = e.payment_status === 'Paid';
  return {
    date_submitted: e.invoice_date ? new Date(e.invoice_date) : null,
    date_recd:      e.created_at ? new Date(e.created_at) : null,
    invoice_num:    e.invoice_number || '',
    vendor:         e.payee || '',
    artist:         e.artist || '',
    description:    [e.song, e.description].filter(Boolean).join(' — ').slice(0, 250),
    amount,
    notes:          e.notes || '',
    priority:       e.rush_requested ? 'HIGH' : 'LOW',
    henry:          '',
    favela:         '',
    paid_date:      isPaid && e.payment_date ? new Date(e.payment_date) : null,
    paid_amount:    isPaid ? amount : null,
    paid_via:       isPaid ? (e.payment_method || '') : '',
    due_date:       dueDate,
    payee_name:     e.vendor_name || e.payee || '',
    method:         e.payment_method || '',
    email:          e.vendor_email || '',
    bank:           e.vendor_bank || '',
    routing:        '', // Market Street stores vendor_bank as free text — no structured routing
    acct:           '',
    w9_status:      w9Status,
    recd_from:      recdFrom,
    payment_confirmed_via: e.payment_ref || '',
    extra_comments: '',
  };
}

// Replace data rows (row 9+) in a BK year-data sheet. ExcelJS's
// spliceRows() is unreliable on loaded workbooks (it silently no-ops),
// so we overwrite cell values in place instead: capture row 9's per-
// column style, then overwrite rows 9..(9 + boomRows.length - 1) with
// Market Street data using that style, and clear+hide any trailing rows the
// bookkeeper had beyond our data. Rows 1-8 are left untouched so the
// banner / subtitle / WEEK ENDING / column headers stay identical.
// Canonical numFmts the bookkeeper uses across every year + PAID sheet.
// Used as a FALLBACK when row 9's cell-level format isn't a date/currency
// (the bookkeeper's PAID sheets in particular don't reliably have the
// correct format set on row 9 — some rows have date format, others have
// currency leaking in from the adjacent column).
const BK_DATE_FMT     = 'mm/dd/yy;@';
const BK_CURRENCY_FMT = '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)';
// Per-column expected numFmt. Used to OVERRIDE the captured row-9 style
// for cells where the captured format is wrong for the column's semantic
// type (date / currency / text). Setting via getColumn(N).numFmt would
// trigger an ExcelJS shared-style bug where mutating one column's numFmt
// silently changes the cell-level numFmt of cells in adjacent columns —
// so we keep this purely per-cell and only override when needed.
const BK_EXPECTED_NUMFMT = {
  2:  BK_DATE_FMT,      // DATE SUBMITTED
  3:  BK_DATE_FMT,      // DATE RECD
  8:  BK_CURRENCY_FMT,  // AMOUNT [USD]
  13: BK_DATE_FMT,      // PAID DATE
  14: BK_CURRENCY_FMT,  // PAID AMOUNT
  16: BK_DATE_FMT,      // DUE DATE
};

function replaceBkDataRows(ws, boomRows, isPaidSheet) {
  const NUM_COLS = isPaidSheet ? 26 : 24;
  // FLATTEN shared-formula chains in the data region BEFORE any writes.
  // The bookkeeper's source has the row-number column (A) wired as a
  // shared-formula chain (A9=1 literal, A10=A9+1 master at A11 with
  // ref=A11:A74, A12+ clones referencing A11). When we overwrite A11
  // with a Market Street row index, ExcelJS chokes on save with "Shared Formula
  // master must exist above and or left of clone for cell A18" because
  // the clones still point at a master that no longer exists. Converting
  // every formula cell in the data region to its precomputed `.result`
  // before we touch anything breaks the chain into independent static
  // values and the overwrites become trivial. Idempotent + safe — a
  // cell without a formula is left alone.
  const lastDataRow = Math.max(ws.actualRowCount || 0, ws.rowCount || 0);
  for (let r = 9; r <= lastDataRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= NUM_COLS; c++) {
      const cell = row.getCell(c);
      const v = cell.value;
      if (v && typeof v === 'object' && ('sharedFormula' in v || 'formula' in v)) {
        cell.value = v.result != null ? v.result : null;
      }
    }
  }
  // Capture row 9's per-column style as the template.
  const templateRow = ws.getRow(9);
  const cellStyles = [];
  for (let col = 1; col <= NUM_COLS; col++) {
    const cell = templateRow.getCell(col);
    cellStyles[col - 1] = {
      font:      cell.font      ? JSON.parse(JSON.stringify(cell.font))      : undefined,
      fill:      cell.fill      ? JSON.parse(JSON.stringify(cell.fill))      : undefined,
      border:    cell.border    ? JSON.parse(JSON.stringify(cell.border))    : undefined,
      alignment: cell.alignment ? JSON.parse(JSON.stringify(cell.alignment)) : undefined,
      numFmt:    cell.numFmt,
    };
  }
  const oldCount = Math.max(0, ws.actualRowCount - 8);
  const newCount = boomRows.length;
  const sweepCount = Math.max(oldCount, newCount);
  for (let i = 0; i < sweepCount; i++) {
    const rowIdx = 9 + i;
    const row = ws.getRow(rowIdx);
    if (i < newCount) {
      const m = bkRowFromExpense(boomRows[i]);
      const rowData = [
        i + 1,
        m.date_submitted, m.date_recd, m.invoice_num,
        m.vendor, m.artist, m.description, m.amount,
        m.notes, m.priority, m.henry, m.favela,
        m.paid_date, m.paid_amount, m.paid_via,
        m.due_date, m.payee_name, m.method, m.email,
        m.bank, m.routing, m.acct, m.w9_status, m.recd_from,
      ];
      if (isPaidSheet) rowData.push(m.payment_confirmed_via, m.extra_comments);
      for (let col = 1; col <= NUM_COLS; col++) {
        const cell = row.getCell(col);
        cell.value = rowData[col - 1] ?? null;
        const s = cellStyles[col - 1];
        if (!s) continue;
        // Set the WHOLE style object at once. Setting cell.font /
        // cell.fill / cell.numFmt separately can mutate shared style
        // references inside ExcelJS — a known pitfall where two cells
        // that started with the same numFmt end up sharing a style
        // object, and assigning cell.numFmt on one mutates the other.
        // Building a fresh style object per cell + assigning via
        // cell.style = … forces ExcelJS to allocate a distinct style.
        const expected = BK_EXPECTED_NUMFMT[col];
        cell.style = {
          font:      s.font      || undefined,
          fill:      s.fill      || undefined,
          border:    s.border    || undefined,
          alignment: s.alignment || undefined,
          numFmt:    expected || s.numFmt || undefined,
        };
      }
      row.hidden = false;
    } else {
      // Excess BK rows beyond what Market Street has — clear values + hide so the
      // sheet looks clean. ExcelJS persists row.hidden through save.
      for (let col = 1; col <= NUM_COLS; col++) {
        const cell = row.getCell(col);
        cell.value = null;
        cell.style = {};
      }
      row.hidden = true;
    }
    row.commit();
  }
}

// Walk the SUM sheet and replace the cross-sheet formulas (e.g.,
// '2026'!H133) with computed totals — those formulas pointed to stale
// row numbers after we re-populated the data sheets.
function replaceBkSumTotals(ws, totals) {
  ws.eachRow({ includeEmpty: true }, (row) => {
    const lbl = row.getCell(2).value;
    if (typeof lbl !== 'string') return;
    const mYear = lbl.match(/^YEAR\s+(\d{4})/i);
    if (mYear) row.getCell(3).value = totals[`outstanding_${mYear[1]}`] || 0;
    const mPaid = lbl.match(/^PAID\s*\{?(\d{4})\}?/i);
    if (mPaid) row.getCell(3).value = totals[`paid_${mPaid[1]}`] || 0;
  });
}


// POST /api/bk/bk-style-export — produces an Excel that mirrors the
// external bookkeeper's workbook EXACTLY, populated with Market Street data.
// The client re-uploads the BK source xlsx so the server can use it
// as a styling template (preserves theme, fonts, fills, widths, heights,
// frozen panes). Then we just replace the data rows on each year sheet.
// Multipart body: { file: BK xlsx, diff: JSON string of diff payload }.
router.post('/bk-style-export', upload.single('file'), async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Source BK xlsx required as styling template' });
    }
    // Accept either the new minimal shape (sheet_years field + optional
    // week_ending field — small enough to never hit multer's default
    // 1MB field-size limit) or the legacy full-diff JSON field.
    let years = [];
    if (req.body?.sheet_years) {
      try { years = JSON.parse(req.body.sheet_years); }
      catch { return res.status(400).json({ success: false, error: 'sheet_years must be valid JSON' }); }
    } else if (req.body?.diff) {
      try {
        const diff = JSON.parse(req.body.diff);
        years = diff?.summary?.sheet_years || [];
      } catch { return res.status(400).json({ success: false, error: 'diff payload must be valid JSON' }); }
    }
    years = years.map(n => parseInt(n, 10)).filter(Number.isFinite);
    if (years.length === 0) {
      return res.status(400).json({ success: false, error: 'sheet_years required' });
    }

    // Pull every non-deleted, non-rejected dashboard row whose year (by
    // invoice_date, falling back to created_at) lies within the workbook's
    // year span. Family roots only — child split rows roll into the parent.
    // row_year comes from Postgres EXTRACT so bucketing isn't subject to
    // node-pg / V8 timezone quirks at year boundaries.
    // Sort by payee then invoice_date so each vendor's rows cluster
    // together inside a sheet — matches the bookkeeper's tab convention.
    const { rows: allRows } = await pool.query(`
      SELECT
        e.id, e.invoice_date, e.invoice_number, e.payee, e.artist, e.song, e.description, e.category,
        e.amount, e.currency, e.notes, e.boom_rep, e.rush_requested,
        e.payment_status, e.payment_date, e.payment_method, e.payment_terms,
        e.scheduled_payment_date,
        e.paid_by, e.payment_ref,
        e.vendor_email, e.vendor_name, e.vendor_bank, e.vendor_address,
        e.w9_filename, e.created_at, e.created_by,
        EXTRACT(YEAR FROM COALESCE(e.invoice_date, e.created_at))::int AS row_year,
        COALESCE((
          e.amount +
          COALESCE((SELECT SUM(c.amount) FROM expenses c
                     WHERE c.parent_id = e.id
                       AND (c.deleted = false OR c.deleted IS NULL)), 0)
        ), e.amount) AS family_amount
      FROM expenses e
      WHERE (e.deleted = false OR e.deleted IS NULL)
        AND e.status != 'rejected'
        AND e.parent_id IS NULL
        AND EXTRACT(YEAR FROM COALESCE(e.invoice_date, e.created_at)) = ANY($1::int[])
      ORDER BY LOWER(e.payee) ASC NULLS LAST, e.invoice_date ASC NULLS LAST, e.id ASC
    `, [years]);

    // Bucket by (paid?, year). row_year is the Postgres-computed year so
    // bucketing isn't off-by-one at year boundaries.
    const byBucket = new Map();
    for (const r of allRows) {
      const year = r.row_year;
      if (!year || !years.includes(year)) continue;
      const isPaid = r.payment_status === 'Paid';
      const key = `${isPaid ? 'paid' : 'outstanding'}_${year}`;
      if (!byBucket.has(key)) byBucket.set(key, []);
      byBucket.get(key).push(r);
    }

    // Totals for the SUM sheet.
    const totals = {};
    for (const y of years) {
      totals[`outstanding_${y}`] = (byBucket.get(`outstanding_${y}`) || [])
        .reduce((s, r) => s + Number(r.family_amount || 0), 0);
      totals[`paid_${y}`] = (byBucket.get(`paid_${y}`) || [])
        .reduce((s, r) => s + Number(r.family_amount || 0), 0);
    }

    // Load the BK source workbook as a styling template.
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);

    // Walk each sheet in the template. Year sheets get their data
    // rows replaced; SUM gets its formulas overwritten with computed
    // totals; any other sheet (rare) is left alone.
    for (const ws of wb.worksheets) {
      const name = ws.name;
      const outMatch = name.match(/^(\d{4})$/);
      if (outMatch) {
        const y = parseInt(outMatch[1], 10);
        if (years.includes(y)) {
          replaceBkDataRows(ws, byBucket.get(`outstanding_${y}`) || [], false);
        }
        continue;
      }
      const paidMatch = name.match(/^PAID\s+(\d{4})$/i);
      if (paidMatch) {
        const y = parseInt(paidMatch[1], 10);
        if (years.includes(y)) {
          replaceBkDataRows(ws, byBucket.get(`paid_${y}`) || [], true);
        }
        continue;
      }
      if (name === 'SUM') {
        replaceBkSumTotals(ws, totals);
      }
    }

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="marketst-bk-style-${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('POST /api/bk/bk-style-export:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/ledger-matching — bookkeeper uploads an xlsx with rows
// of (Vendor, Invoice #), one or more sheets. We auto-detect the two
// columns on each sheet, look up every row against the expenses table
// (LOWER(payee) match + normalizeInvoiceNum() match), and stream back a
// single ZIP containing one folder per sheet. Each folder holds the
// matched invoice files plus a matches.csv that mirrors the input rows
// with a Status column (matched / multiple / not_found / no_file /
// missing_field) so the bookkeeper can see exactly what's missing.
router.post('/ledger-matching', upload.single('file'), async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    const ExcelJS = require('exceljs');
    const archiver = require('archiver');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);

    // Pull a cell value out of ExcelJS, flattening formula / rich-text
    // / hyperlink shapes down to a plain string. ExcelJS returns objects
    // for those types; comparing them as strings is fragile.
    const cellText = (cell) => {
      let v = cell?.value;
      if (v && typeof v === 'object') {
        if ('result' in v) v = v.result;
        else if ('text' in v) v = v.text;
        else if ('richText' in v) v = (v.richText || []).map(r => r.text).join('');
        else if ('hyperlink' in v) v = v.text || v.hyperlink;
      }
      return String(v ?? '').trim();
    };

    // Header-row autodetect — bookkeeper workbooks regularly carry a
    // title row + a long instructions paragraph + a blank line before
    // the actual column headers. Scan the first 15 rows; the header is
    // the one whose cells look like short, distinct labels and contain
    // recognizable keywords (vendor / invoice / amount / date / ...).
    const detectHeaderRow = (ws) => {
      const max = Math.min(15, ws.actualRowCount);
      let best = { row: 0, score: 0 };
      for (let r = 1; r <= max; r++) {
        const row = ws.getRow(r);
        const values = [];
        row.eachCell({ includeEmpty: false }, c => values.push(cellText(c)));
        if (values.length < 2) continue;
        // Merged title / banner row — every cell is identical.
        if (new Set(values).size === 1) continue;
        // Any single cell longer than 80 chars is probably a paragraph,
        // not a header. Skip the whole row.
        if (values.some(v => v.length > 80)) continue;
        let score = 0;
        for (const v of values) {
          const lc = v.toLowerCase();
          if (/\b(vendor|payee|invoice|inv|amount|date|artist|company|paid|due|reference|ref|account|number|status|notes?|description)\b/.test(lc)) score++;
        }
        if (score > best.score) best = { row: r, score };
      }
      return best.score >= 1 ? best.row : 0;
    };

    // Header detector — fuzzy match on common spellings.
    //
    // When the workbook compares two ledgers (e.g. a Mark-Paid sheet with
    // both Master and Dashboard sides), the same sheet carries TWO vendor
    // columns and TWO invoice columns. Files live on the dashboard side,
    // so prefer headers containing "dashboard" over those containing
    // "master" — and over anything else as a tie-breaker. Returns the
    // 1-indexed column numbers plus the chosen header text so the
    // matches.csv can surface which columns were used.
    const findCols = (headerRow) => {
      const cells = [];
      headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
        const v = cellText(cell).toLowerCase();
        if (v) cells.push({ col, text: v, raw: cellText(cell) });
      });
      const vendorCandidates = cells.filter(({ text }) =>
        /\b(vendor|payee|supplier|company)\b/.test(text) ||
        /\bbill\s*to\b/.test(text)
      );
      const invoiceCandidates = cells.filter(({ text }) =>
        (/\binvoice\b/.test(text) && /(#|num|no\b|no\.|number)/.test(text)) ||
        text === 'invoice' || text === 'inv #' || text === 'inv#' || text === 'inv no' || text === 'inv number' || text === 'inv' ||
        /^inv\s*#$/.test(text) || /\bmaster\s*inv\b/.test(text) || /\bdashboard\s*inv\b/.test(text)
      );
      const pickPreferred = (list) => {
        if (!list.length) return null;
        const dash = list.find(c => /\bdashboard\b/.test(c.text));
        if (dash) return dash;
        const nonMaster = list.find(c => !/\bmaster\b/.test(c.text));
        if (nonMaster) return nonMaster;
        return list[0];
      };
      const v = pickPreferred(vendorCandidates);
      const i = pickPreferred(invoiceCandidates);
      return {
        vendorCol: v?.col ?? null,
        invoiceCol: i?.col ?? null,
        vendorHeader: v?.raw || null,
        invoiceHeader: i?.raw || null,
      };
    };

    // CSV row escape — wraps every field in quotes, doubles internal
    // quotes per RFC 4180 so Excel opens the output cleanly.
    const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

    res.setHeader('Content-Disposition', `attachment; filename="ledger-matching-${new Date().toISOString().slice(0,10)}.zip"`);
    res.setHeader('Content-Type', 'application/zip');

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', err => { throw err; });
    archive.pipe(res);

    // Per-sheet status counters surfaced in a top-level summary.txt so
    // the bookkeeper sees the overall result without opening every CSV.
    const summary = [];

    // Aggregate vendor names across every sheet so we can pull one W9 per
    // unique vendor at the end and drop them into a top-level W9s/ folder.
    // Keyed lowercased to match the existing LOWER(payee) lookup pattern.
    const allVendorsLc = new Set();

    for (const ws of wb.worksheets) {
      const sheetName = safeNameForZip(ws.name || `Sheet${ws.id}`);
      const headerRowIdx = detectHeaderRow(ws);
      const headerRow = headerRowIdx ? ws.getRow(headerRowIdx) : null;
      const { vendorCol, invoiceCol, vendorHeader, invoiceHeader } = headerRow
        ? findCols(headerRow)
        : { vendorCol: null, invoiceCol: null };

      // Sheet that doesn't have both columns gets a single matches.csv
      // explaining why it was skipped. Better than silently dropping it.
      if (!vendorCol || !invoiceCol) {
        const skipNote = `Could not auto-detect columns on this sheet.
Looked for: a Vendor / Payee column AND an Invoice # column.
Header row detected: ${headerRowIdx ? `row ${headerRowIdx}` : 'not found (scanned rows 1–15)'}
Found Vendor column: ${vendorCol ? `col ${vendorCol}` : 'no'}
Found Invoice # column: ${invoiceCol ? `col ${invoiceCol}` : 'no'}
Rename your headers (e.g. "Vendor", "Invoice #") and try again.`;
        archive.append(skipNote, { name: `${sheetName}/_SKIPPED.txt` });
        summary.push(`${ws.name}: SKIPPED — columns not found`);
        continue;
      }

      // Pass 1: collect spreadsheet rows for this sheet. Data starts on
      // the row after the detected header.
      const rows = []; // { rowNum, vendor, invoiceRaw }
      const lastRow = ws.actualRowCount;
      for (let r = headerRowIdx + 1; r <= lastRow; r++) {
        const row = ws.getRow(r);
        const vendor = cellText(row.getCell(vendorCol));
        const invoiceRaw = cellText(row.getCell(invoiceCol));
        if (!vendor && !invoiceRaw) continue; // skip blank rows
        rows.push({ rowNum: r, vendor, invoiceRaw });
      }

      if (rows.length === 0) {
        archive.append('Vendor,Invoice #,Status,Note\n', { name: `${sheetName}/matches.csv` });
        summary.push(`${ws.name}: 0 rows`);
        continue;
      }

      // Pass 2: one DB query for every unique vendor on this sheet, then
      // match in JS using normalizeInvoiceNum so legacy "INV-001" /
      // "001" / "1" all resolve to the same expense. Per-sheet keeps the
      // query small even if the workbook has thousands of total rows.
      const uniqVendors = [...new Set(rows.map(r => r.vendor.toLowerCase()).filter(Boolean))];
      for (const v of uniqVendors) allVendorsLc.add(v);
      let candidates = [];
      if (uniqVendors.length) {
        const { rows: dbRows } = await pool.query(`
          SELECT id, payee, invoice_number, invoice_date,
                 invoice_data, invoice_r2_key, invoice_filename
          FROM expenses
          WHERE LOWER(payee) = ANY($1::text[])
            AND (deleted = false OR deleted IS NULL)
            AND parent_id IS NULL
        `, [uniqVendors]);
        candidates = dbRows;
      }

      // Build a lookup keyed by "vendor_lc|normalized_invoice#" → [rows]
      const lookup = new Map();
      for (const c of candidates) {
        const normNum = normalizeInvoiceNum(c.invoice_number);
        if (!normNum || normNum === '0') continue;
        const key = `${(c.payee || '').toLowerCase()}|${normNum}`;
        if (!lookup.has(key)) lookup.set(key, []);
        lookup.get(key).push(c);
      }

      // Pass 3: resolve each spreadsheet row, append files and CSV rows.
      // The first line of matches.csv documents which spreadsheet columns
      // were treated as Vendor / Invoice #, since some workbooks have
      // multiple candidates per side (e.g. Master + Dashboard columns).
      const csvLines = [
        `# Matched against: Vendor="${(vendorHeader || '').replace(/"/g, '""')}" (col ${vendorCol}), Invoice #="${(invoiceHeader || '').replace(/"/g, '""')}" (col ${invoiceCol}), header row ${headerRowIdx}`,
        'Vendor,Invoice #,Status,File / Note',
      ];
      const usedFilenames = new Set();
      let matched = 0, multiple = 0, notFound = 0, noFile = 0, missing = 0;

      for (const { vendor, invoiceRaw } of rows) {
        if (!vendor || !invoiceRaw) {
          missing++;
          csvLines.push([csvCell(vendor), csvCell(invoiceRaw), csvCell('missing_field'), csvCell('Vendor and/or Invoice # blank in spreadsheet')].join(','));
          continue;
        }
        const key = `${vendor.toLowerCase()}|${normalizeInvoiceNum(invoiceRaw)}`;
        const hits = lookup.get(key) || [];

        if (hits.length === 0) {
          notFound++;
          csvLines.push([csvCell(vendor), csvCell(invoiceRaw), csvCell('not_found'), csvCell('No expense found matching this vendor + invoice #')].join(','));
          continue;
        }

        const statusLabel = hits.length > 1 ? 'multiple' : 'matched';
        if (hits.length > 1) multiple++; else matched++;

        // Collect any invoice files attached to the matched expenses.
        const fileNotes = [];
        let attachedAny = false;
        for (let i = 0; i < hits.length; i++) {
          const c = hits[i];
          const buf = await loadFileBuffer(c.invoice_r2_key, c.invoice_data);
          if (!buf) continue;
          attachedAny = true;
          const ext = ((c.invoice_filename || '').split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf';
          const suffix = hits.length > 1 ? `_(${i + 1}of${hits.length})` : '';
          let baseName = `${safeNameForZip(vendor)} - ${safeNameForZip(invoiceRaw)}${suffix}`;
          // Disambiguate if two spreadsheet rows somehow map to the
          // same filename (e.g., same vendor + invoice on different
          // input rows).
          let candidate = `${baseName}.${ext}`;
          let n = 2;
          while (usedFilenames.has(candidate)) {
            candidate = `${baseName} (${n}).${ext}`;
            n++;
          }
          usedFilenames.add(candidate);
          archive.append(buf, { name: `${sheetName}/${candidate}` });
          fileNotes.push(candidate);
        }

        if (!attachedAny) {
          noFile++;
          csvLines.push([csvCell(vendor), csvCell(invoiceRaw), csvCell('no_file'),
            csvCell(`Matched expense id${hits.length > 1 ? 's' : ''} ${hits.map(h => h.id).join(', ')} but no invoice file on record`)].join(','));
        } else {
          csvLines.push([csvCell(vendor), csvCell(invoiceRaw), csvCell(statusLabel), csvCell(fileNotes.join(' | '))].join(','));
        }
      }

      archive.append(csvLines.join('\n') + '\n', { name: `${sheetName}/matches.csv` });
      summary.push(`${ws.name}: ${rows.length} rows — matched:${matched}, multiple:${multiple}, not_found:${notFound}, no_file:${noFile}, missing:${missing}`);
    }

    // Top-level W9s/ folder — one file per unique vendor that appeared in
    // the workbook. We pull the most recent W9/W8 on record per vendor
    // (DISTINCT ON LOWER(payee)) regardless of whether the matching invoice
    // row resolved — the bookkeeper reconciling vendor paperwork wants the
    // W9 in hand even when an invoice number couldn't be matched.
    let w9Included = 0;
    const vendorsWithoutW9 = [];
    if (allVendorsLc.size > 0) {
      // Alias-aware: expand each requested vendor name to include DBA /
      // legal-name partners so a W9 filed under one spelling counts for
      // any spelling in the workbook.
      const { searchList, requestorForName } = await expandVendorAliases(pool, allVendorsLc);
      const { rows: w9Rows } = await pool.query(`
        SELECT DISTINCT ON (LOWER(payee))
               id, payee, w9_data, w9_r2_key, w9_filename
          FROM expenses
         WHERE LOWER(payee) = ANY($1::text[])
           AND (deleted = false OR deleted IS NULL)
           AND ((w9_data IS NOT NULL AND w9_data != '') OR w9_r2_key IS NOT NULL)
         ORDER BY LOWER(payee) ASC, id DESC
      `, [searchList]);

      const w9UsedNames = new Set();
      const foundVendorsLc = new Set();
      for (const r of w9Rows) {
        try {
          const buf = await loadFileBuffer(r.w9_r2_key, r.w9_data);
          if (!buf) continue;
          const payeeLc = (r.payee || '').toLowerCase();
          // Credit every workbook-side spelling that resolves to this payee.
          const requestors = requestorForName.get(payeeLc);
          if (requestors && requestors.size) {
            for (const rq of requestors) foundVendorsLc.add(rq);
          } else {
            foundVendorsLc.add(payeeLc);
          }
          const ext = ((r.w9_filename || '').split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf';
          const base = safeNameForZip(r.payee);
          let name = `${base}.${ext}`;
          let n = 2;
          while (w9UsedNames.has(name)) {
            name = `${base} (${n}).${ext}`;
            n++;
          }
          w9UsedNames.add(name);
          archive.append(buf, { name: `W9s/${name}` });
          w9Included++;
        } catch (err) {
          console.warn(`[ledger-matching] W9 ${r.id} failed:`, err.message);
        }
      }

      // Surface vendors that had spreadsheet rows but no W9 on file so the
      // bookkeeper knows what's missing before they go chase paperwork.
      for (const v of allVendorsLc) {
        if (!foundVendorsLc.has(v)) vendorsWithoutW9.push(v);
      }
      if (vendorsWithoutW9.length) {
        const note = [
          `# Vendors in this workbook with no W9 / W8 on file (${vendorsWithoutW9.length}):`,
          ...vendorsWithoutW9.sort().map(v => `- ${v}`),
        ].join('\n') + '\n';
        archive.append(note, { name: 'W9s/_MISSING.txt' });
      }
    }
    summary.push(`W9s: ${w9Included} included, ${vendorsWithoutW9.length} vendor${vendorsWithoutW9.length === 1 ? '' : 's'} missing W9 on file`);

    archive.append(summary.join('\n') + '\n', { name: 'summary.txt' });
    await archive.finalize();
  } catch (err) {
    console.error('POST /api/bk/ledger-matching:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/export-invoices-zip — ZIP of every approved invoice file,
// named "<Payee> - <Date> - <Invoice #>.<ext>" so the bookkeeper sees a
// flat list sorted alphabetically by vendor when they open it. Only one
// row per family (parent) since the file lives on the parent.
router.get('/export-invoices-zip', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    const { rows } = await pool.query(`
      SELECT id, payee, invoice_date, invoice_number,
             invoice_data, invoice_r2_key, invoice_filename
        FROM expenses
       WHERE status = 'approved'
         AND (deleted = false OR deleted IS NULL)
         AND parent_id IS NULL
         AND ((invoice_data IS NOT NULL AND invoice_data != '') OR invoice_r2_key IS NOT NULL)
       ORDER BY LOWER(TRIM(COALESCE(payee, ''))) ASC,
                invoice_date ASC NULLS LAST,
                id ASC
    `);

    const archiver = require('archiver');
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="marketst-invoices-${today}.zip"`);
    res.setHeader('Content-Type', 'application/zip');

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('warning', (err) => console.warn('[export-invoices-zip] archive warning:', err.message));
    archive.on('error', (err) => { throw err; });
    archive.pipe(res);

    const usedNames = new Set();
    let fileCount = 0;
    for (const r of rows) {
      const buf = await loadFileBuffer(r.invoice_r2_key, r.invoice_data);
      if (!buf) continue;
      const ext = ((r.invoice_filename || '').split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf';
      const payee = safeNameForZip(r.payee);
      const date  = r.invoice_date ? String(r.invoice_date).slice(0, 10) : '';
      const inv   = safeNameForZip(r.invoice_number || `id${r.id}`);
      const datePart = date ? ` - ${date}` : '';
      let base = `${payee}${datePart} - ${inv}`;
      // Disambiguate when two rows would land on the same filename
      // (same payee + date + invoice number — rare but possible).
      let name = `${base}.${ext}`;
      let i = 2;
      while (usedNames.has(name)) {
        name = `${base} (${i}).${ext}`;
        i++;
      }
      usedNames.add(name);
      archive.append(buf, { name });
      fileCount++;
    }

    if (fileCount === 0) {
      archive.append('No approved invoices with attached files were found.', { name: 'README.txt' });
    }

    await archive.finalize();
  } catch (err) {
    console.error('GET /api/bk/export-invoices-zip:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/export-w9s-zip — ZIP of every vendor's most recent W9/W8,
// one file per vendor (deduped by payee, case-insensitive), named
// "<Vendor>.<ext>". DISTINCT ON keeps the latest entry's W9 when a vendor
// has uploaded multiple over time.
router.get('/export-w9s-zip', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    const { rows } = await pool.query(`
      SELECT DISTINCT ON (LOWER(TRIM(payee)))
             id, payee, w9_data, w9_r2_key, w9_filename
        FROM expenses
       WHERE (deleted = false OR deleted IS NULL)
         AND ((w9_data IS NOT NULL AND w9_data != '') OR w9_r2_key IS NOT NULL)
       ORDER BY LOWER(TRIM(payee)) ASC, id DESC
    `);

    const archiver = require('archiver');
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="marketst-w9s-${today}.zip"`);
    res.setHeader('Content-Type', 'application/zip');

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('warning', (err) => console.warn('[export-w9s-zip] archive warning:', err.message));
    archive.on('error', (err) => { throw err; });
    archive.pipe(res);

    const usedNames = new Set();
    let fileCount = 0;
    for (const r of rows) {
      const buf = await loadFileBuffer(r.w9_r2_key, r.w9_data);
      if (!buf) continue;
      const ext = ((r.w9_filename || '').split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf';
      const base = safeNameForZip(r.payee);
      let name = `${base}.${ext}`;
      let i = 2;
      while (usedNames.has(name)) {
        name = `${base} (${i}).${ext}`;
        i++;
      }
      usedNames.add(name);
      archive.append(buf, { name });
      fileCount++;
    }

    if (fileCount === 0) {
      archive.append('No W9/W8 files were found.', { name: 'README.txt' });
    }

    await archive.finalize();
  } catch (err) {
    console.error('GET /api/bk/export-w9s-zip:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/export-qbo  — QuickBooks-compatible CSV
router.get('/export-qbo', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    const { rows } = await pool.query(`
      SELECT invoice_date, payee, description, amount, category, payment_method, invoice_number
      FROM expenses
      WHERE status = 'approved' AND (deleted = false OR deleted IS NULL)
        AND (voided = false OR voided IS NULL) AND qb_entry_date IS NULL
      ORDER BY invoice_date DESC
    `);

    const fmt = (v) => v != null ? `"${String(v).replace(/"/g,'""')}"` : '""';
    const header = ['Date','Vendor','Description','Amount','Account','Payment Method','Ref No'].join(',');
    const csvLines = rows.map(r =>
      [fmt(r.invoice_date ? new Date(r.invoice_date).toLocaleDateString('en-US') : ''),
       fmt(r.payee), fmt(r.description), fmt(r.amount), fmt(r.category),
       fmt(r.payment_method), fmt(r.invoice_number)].join(',')
    );
    const csv = [header, ...csvLines].join('\n');

    res.setHeader('Content-Disposition', `attachment; filename="marketst-qbo-export-${new Date().toISOString().slice(0,10)}.csv"`);
    res.setHeader('Content-Type', 'text/csv');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/export-csv  — full CSV export (all columns)
router.get('/export-csv', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    // Same ?source= contract as /bk/entries and /bk/export — the CSV has to
    // contain the page it was downloaded from, or the two exports on one menu
    // disagree with each other.
    const src = req.query.source;
    if (src !== undefined && src !== 'bank' && src !== 'invoices') {
      return res.status(400).json({ success: false, error: "source must be 'bank' or 'invoices'" });
    }
    const sourceSql = src === 'bank' ? `AND entry_source = 'bank_statement'`
      : src === 'invoices' ? `AND entry_source IS DISTINCT FROM 'bank_statement'`
        : '';

    const { rows } = await pool.query(`
      SELECT id, invoice_date, payee, description, category, artist, song,
             invoice_number, amount, currency, payment_method, payment_date,
             payment_status, paid_by, payment_terms, scheduled_payment_date,
             in_quickbooks, qb_entry_date, uploaded_to_stem,
             boom_rep, cobrand, is_reimbursement, notes, approved_by, created_at
      FROM expenses
      WHERE (deleted = false OR deleted IS NULL) AND status = 'approved'
        AND (voided = false OR voided IS NULL)
        ${sourceSql}
      ORDER BY invoice_date DESC
    `);

    const esc = (v) => v != null ? `"${String(v).replace(/"/g,'""')}"` : '""';
    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-US') : '';
    const headers = ['Date','Payee','Description','Category','Artist','Song','Invoice #',
      'Amount','Currency','Payment Method','Payment Date','Payment Status','Paid By',
      'Terms','Due Date','QB','QB Date','Stem','Market Street Rep','Cobrand','Reimbursement','Notes','Approved By'];
    const csvRows = rows.map(r => [
      esc(fmtDate(r.invoice_date)), esc(r.payee), esc(r.description), esc(r.category),
      esc(r.artist), esc(r.song), esc(r.invoice_number),
      r.amount || 0, esc(r.currency || 'USD'), esc(r.payment_method),
      esc(fmtDate(r.payment_date)), esc(r.payment_status), esc(r.paid_by),
      esc(r.payment_terms), esc(fmtDate(r.scheduled_payment_date)),
      esc(r.in_quickbooks), esc(fmtDate(r.qb_entry_date)), esc(r.uploaded_to_stem),
      esc(r.boom_rep), r.cobrand ? 'Yes' : 'No', r.is_reimbursement ? 'Yes' : 'No',
      esc(r.notes), esc(r.approved_by),
    ].join(','));

    const csv = [headers.join(','), ...csvRows].join('\n');
    res.setHeader('Content-Disposition', `attachment; filename="marketst-ledger-${new Date().toISOString().slice(0,10)}.csv"`);
    res.setHeader('Content-Type', 'text/csv');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/export-1099  — 1099 summary Excel
router.get('/export-1099', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const ExcelJS = require('exceljs');
    // Same computation as GET /1099 — see compute1099. This used to be a second
    // query with its own bugs (invoice_date basis, no Paid filter, mixed
    // currencies, hardcoded $600), so an export could disagree with the report.
    const { data, meta } = await compute1099(year);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`1099 - ${year}`);
    ws.columns = [
      { header: 'Vendor',        key: 'payee',        width: 30 },
      { header: 'Total Paid USD', key: 'total',       width: 16 },
      { header: 'Invoices',      key: 'count',        width: 11 },
      { header: 'Email',         key: 'vendor_email', width: 28 },
      { header: 'W9 on File',    key: 'w9_on_file',   width: 12 },
      { header: 'Reportable',    key: 'needs_1099',   width: 12 },
      { header: 'Entity type verified', key: 'entity', width: 20 },
      { header: 'Currencies',    key: 'currencies',   width: 14 },
      { header: 'Reimbursements excluded', key: 'reimb', width: 22 },
    ];
    ws.getRow(1).font = { bold: true };

    for (const r of data) {
      ws.addRow({
        payee: r.payee,
        total: r.total,
        count: r.invoice_count,
        vendor_email: r.vendor_email || '',
        w9_on_file: r.w9_on_file ? 'Yes' : 'No',
        needs_1099: r.needs_1099 ? 'Yes' : 'No',
        // Spelled out per row: this is the one thing the report cannot decide,
        // and a blank column would read as "nothing to check".
        entity: 'NO — check by hand',
        currencies: r.currencies.join(', '),
        reimb: r.reimbursed_excluded || 0,
      });
    }
    ws.getColumn('total').numFmt = '"$"#,##0.00';
    ws.getColumn('reimb').numFmt = '"$"#,##0.00';

    // Basis and caveats travel WITH the file. A spreadsheet gets emailed to an
    // accountant detached from the UI that explained it.
    ws.addRow([]);
    ws.addRow([`Basis: ${meta.basis}`]);
    ws.addRow([`Threshold for ${year}: $${meta.threshold.toLocaleString()}`]);
    ws.addRow([meta.threshold_note]);
    ws.addRow([`Excludes: ${meta.excludes.join('; ')}`]);
    ws.addRow(['Corporations are NOT excluded — entity type is not captured in this system. '
      + `All ${meta.reportable_count} reportable vendors need entity type verified before filing.`]);
    ws.addRow([`Reportable vendors: ${meta.reportable_count} · missing W9: ${meta.missing_w9}`]);

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Disposition', `attachment; filename="marketst-1099-${year}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Dashboard integration endpoints ──────────────────────────────────────────

// GET /api/bk/pending-count
router.get('/pending-count', async (req, res) => {
  try {
    // Match the /approvals queue's WHERE clause — voided rows and split
    // children are hidden there, so counting them here left the sidebar
    // badge showing phantom pending items.
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS count FROM expenses
        WHERE status = 'pending'
          AND (deleted = false OR deleted IS NULL)
          AND (voided = false OR voided IS NULL)
          AND parent_id IS NULL`
    );
    res.json({ count: parseInt(rows[0].count) });
  } catch (err) {
    res.status(500).json({ count: 0 });
  }
});

// GET /api/bk/dashboard-summary
router.get('/dashboard-summary', async (req, res) => {
  try {
    // Every money/count query here excludes soft-deleted AND voided rows —
    // paid_mtd previously filtered on neither, so deleted/voided invoices
    // inflated "paid this month".
    const [mtd, paid, pendingQb, pendingApprovals, recent] = await Promise.all([
      pool.query(`
        SELECT COALESCE(SUM(amount),0) AS logged_mtd, COUNT(*) AS invoice_count
        FROM expenses
        WHERE status = 'approved' AND (deleted = false OR deleted IS NULL)
          AND (voided = false OR voided IS NULL)
          AND DATE_TRUNC('month', invoice_date) = DATE_TRUNC('month', CURRENT_DATE)
      `),
      pool.query(`
        SELECT COALESCE(SUM(amount),0) AS paid_mtd
        FROM expenses
        WHERE status = 'approved' AND payment_status = 'Paid'
          AND (deleted = false OR deleted IS NULL)
          AND (voided = false OR voided IS NULL)
          AND DATE_TRUNC('month', invoice_date) = DATE_TRUNC('month', CURRENT_DATE)
      `),
      pool.query(`SELECT COUNT(*) AS n FROM expenses WHERE status='approved' AND qb_entry_date IS NULL AND (deleted=false OR deleted IS NULL) AND (voided=false OR voided IS NULL)`),
      pool.query(`SELECT COUNT(*) AS n FROM expenses WHERE status='pending' AND (deleted=false OR deleted IS NULL) AND (voided=false OR voided IS NULL) AND parent_id IS NULL`),
      pool.query(`
        SELECT payee, amount, invoice_date, category
        FROM expenses WHERE status='approved' AND (deleted=false OR deleted IS NULL)
          AND (voided=false OR voided IS NULL)
        ORDER BY invoice_date DESC NULLS LAST, id DESC LIMIT 3
      `),
    ]);

    res.json({
      logged_mtd:        parseFloat(mtd.rows[0].logged_mtd),
      invoice_count:     parseInt(mtd.rows[0].invoice_count),
      paid_mtd:          parseFloat(paid.rows[0].paid_mtd),
      pending_qb:        parseInt(pendingQb.rows[0].n),
      pending_approvals: parseInt(pendingApprovals.rows[0].n),
      recent: recent.rows.map(r => ({
        payee:    r.payee,
        amount:   parseFloat(r.amount || 0),
        date:     r.invoice_date,
        category: r.category || '',
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Bulk Deals ───────────────────────────────────────────────────────────────

// GET /api/bk/bulk-deals
router.get('/bulk-deals', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.id, e.payee, e.artist, e.song, e.amount, e.currency, e.category,
             e.invoice_date, e.description, e.notes, e.payment_status,
             e.bulk_deal_quantity, e.bulk_deal_unit, e.bulk_deal_completed,
             e.artist_breakdown, e.social_handles,
             (e.amount + COALESCE(ch.child_total, 0)) AS combined_amount,
             COALESCE(bd.total_items, 0)::int AS total_items,
             COALESCE(bd.completed_items, 0)::int AS completed_items,
             bd.last_delivery_at,
             COALESCE(ch.child_count, 0)::int AS split_count,
             -- Paid-vs-delivered view: installment rows are the precise
             -- signal when they exist; otherwise fall back to summing the
             -- family rows whose payment_status is Paid.
             COALESCE(ip.installments_paid, 0)::float AS installments_paid,
             COALESCE(ip.installment_count, 0)::int   AS installment_count,
             (CASE WHEN e.payment_status = 'Paid' THEN e.amount ELSE 0 END
               + COALESCE(ch.paid_child_total, 0))::float AS status_paid_total
      FROM expenses e
      LEFT JOIN (
        SELECT expense_id,
               COUNT(*) AS total_items,
               COUNT(*) FILTER (WHERE completed) AS completed_items,
               MAX(completed_at) AS last_delivery_at
        FROM bulk_deal_items GROUP BY expense_id
      ) bd ON bd.expense_id = e.id
      LEFT JOIN (
        SELECT parent_id, COUNT(*) AS child_count, SUM(amount) AS child_total,
               SUM(amount) FILTER (WHERE payment_status = 'Paid') AS paid_child_total
        FROM expenses WHERE parent_id IS NOT NULL
          AND (deleted = false OR deleted IS NULL)
          AND (voided = false OR voided IS NULL)
        GROUP BY parent_id
      ) ch ON ch.parent_id = e.id
      LEFT JOIN (
        SELECT expense_id, SUM(amount) AS installments_paid, COUNT(*) AS installment_count
        FROM expense_payments GROUP BY expense_id
      ) ip ON ip.expense_id = e.id
      WHERE e.is_bulk_deal = true AND (e.deleted = false OR e.deleted IS NULL)
        AND (e.voided = false OR e.voided IS NULL)
        AND e.status = 'approved' AND e.parent_id IS NULL
      ORDER BY e.invoice_date DESC NULLS LAST, e.id DESC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/bulk-deals/:expenseId/items
router.get('/bulk-deals/:expenseId/items', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM bulk_deal_items WHERE expense_id = $1 ORDER BY position, id',
      [req.params.expenseId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bk/bulk-deals/:expenseId/items
router.post('/bulk-deals/:expenseId/items', async (req, res) => {
  try {
    const { title, video_url, platform } = req.body;
    if (!title) return res.status(400).json({ success: false, error: 'Title is required' });
    const { rows: posRows } = await pool.query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM bulk_deal_items WHERE expense_id = $1',
      [req.params.expenseId]
    );
    const { rows } = await pool.query(
      `INSERT INTO bulk_deal_items (expense_id, title, video_url, platform, position)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.expenseId, title, video_url || null, platform || null, posRows[0].next_pos]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/bk/bulk-deals/items/:itemId
router.put('/bulk-deals/items/:itemId', async (req, res) => {
  try {
    const allowed = ['title', 'video_url', 'platform', 'completed', 'position'];
    const fields = Object.keys(req.body).filter(k => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ success: false, error: 'No valid fields' });

    // Auto-set completed_at
    if ('completed' in req.body) {
      if (req.body.completed) {
        fields.push('completed_at');
        req.body.completed_at = new Date().toISOString();
      } else {
        fields.push('completed_at');
        req.body.completed_at = null;
      }
    }

    const setClauses = fields.map((f, i) => `${f} = $${i + 2}`);
    const values = fields.map(f => req.body[f]);
    const { rows } = await pool.query(
      `UPDATE bulk_deal_items SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      [req.params.itemId, ...values]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Item not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/bk/bulk-deals/items/:itemId
router.delete('/bulk-deals/items/:itemId', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM bulk_deal_items WHERE id = $1', [req.params.itemId]);
    if (!rowCount) return res.status(404).json({ success: false, error: 'Item not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bk/vendor-zip?payee=… — single-vendor variant of the bulk
// invoice ZIP. Looks up every (non-deleted, non-rejected) expense for
// the given payee, builds a styled Excel ledger summarising them, and
// streams a ZIP containing the ledger + every invoice file + the
// vendor's W9 / W8. Used by /bk/bulk-zip's "By vendor" section.
router.get('/vendor-zip', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const payee = (req.query.payee || '').trim();
    if (!payee) return res.status(400).json({ success: false, error: 'payee required' });

    // Family roots only — split children inherit the parent's invoice
    // file in this product, so listing children would just produce
    // duplicate file attachments. family_amount aggregates the splits.
    const { rows } = await pool.query(`
      SELECT e.id, e.invoice_date, e.invoice_number, e.payee, e.artist, e.song,
             e.description, e.category, e.amount, e.currency,
             e.payment_status, e.payment_date, e.payment_method, e.paid_by, e.payment_terms,
             e.scheduled_payment_date, e.notes,
             e.invoice_filename, e.invoice_data, e.invoice_r2_key,
             e.w9_filename, e.w9_data, e.w9_r2_key,
             COALESCE((
               e.amount +
               COALESCE((SELECT SUM(c.amount) FROM expenses c
                          WHERE c.parent_id = e.id
                            AND (c.deleted = false OR c.deleted IS NULL)), 0)
             ), e.amount) AS family_amount
        FROM expenses e
       WHERE LOWER(e.payee) = LOWER($1)
         AND (e.deleted = false OR e.deleted IS NULL)
         AND e.status != 'rejected'
         AND e.parent_id IS NULL
       ORDER BY e.invoice_date ASC NULLS LAST, e.id ASC
    `, [payee]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: `No invoices on file for "${payee}".` });
    }

    const archiver = require('archiver');
    const ExcelJS = require('exceljs');
    const canonicalName = rows[0].payee || payee;
    const safeName = safeNameForZip(canonicalName);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-${new Date().toISOString().slice(0,10)}.zip"`);
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => { throw err; });
    archive.pipe(res);

    // ── 1) Build the ledger.xlsx — branded, frozen header, currency +
    // date number formats, banded rows. Same look as the other Market Street
    // exports so the output reads like part of the same set.
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Market Street Dashboard';
    const ws = wb.addWorksheet('Ledger', {
      views: [{ showGridLines: false, state: 'frozen', ySplit: 4 }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    const COLUMNS = [
      { header: 'Invoice Date',     key: 'invoice_date',   width: 12, type: 'date' },
      { header: 'Invoice #',        key: 'invoice_number', width: 16 },
      { header: 'Artist',           key: 'artist',         width: 18 },
      { header: 'Song',             key: 'song',           width: 22 },
      { header: 'Description',      key: 'description',    width: 32, wrap: true },
      { header: 'Category',         key: 'category',       width: 14 },
      { header: 'Amount',           key: 'family_amount',  width: 13, type: 'currency' },
      { header: 'Currency',         key: 'currency',       width: 9 },
      { header: 'Payment status',   key: 'payment_status', width: 12 },
      { header: 'Payment date',     key: 'payment_date',   width: 12, type: 'date' },
      { header: 'Payment method',   key: 'payment_method', width: 12 },
      { header: 'Paid by',          key: 'paid_by',        width: 16 },
      { header: 'Terms',            key: 'payment_terms',  width: 11 },
      { header: 'Due date',         key: 'scheduled_payment_date', width: 12, type: 'date' },
      { header: 'Notes',            key: 'notes',          width: 30, wrap: true },
      { header: 'File',             key: 'file_name',      width: 32 },
    ];
    ws.columns = COLUMNS.map(c => ({ key: c.key, width: c.width }));
    const lastColLetter = ws.getColumn(COLUMNS.length).letter;
    const BRAND_RED = 'FF334155';
    const ROW_BAND  = 'FFF9FAFB';
    const BORDER   = 'FFE5E7EB';
    const THIN = { style: 'thin', color: { argb: BORDER } };

    // Title + subtitle rows.
    ws.addRow([`${canonicalName} — Invoice Ledger`]);
    ws.mergeCells(`A1:${lastColLetter}1`);
    Object.assign(ws.getCell('A1'), {
      font: { bold: true, size: 16, color: { argb: 'FF111111' } },
      alignment: { vertical: 'middle', horizontal: 'left' },
    });
    ws.getRow(1).height = 26;
    const totalAmount = rows.reduce((s, r) => s + Number(r.family_amount || 0), 0);
    const paidCount = rows.filter(r => r.payment_status === 'Paid').length;
    ws.addRow([
      `${rows.length} invoice${rows.length === 1 ? '' : 's'}  ·  ` +
      `${paidCount} paid / ${rows.length - paidCount} unpaid  ·  ` +
      `Total $${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}  ·  ` +
      `Generated ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}`
    ]);
    ws.mergeCells(`A2:${lastColLetter}2`);
    Object.assign(ws.getCell('A2'), {
      font: { italic: true, size: 10, color: { argb: 'FF6B7280' } },
      alignment: { vertical: 'middle', horizontal: 'left' },
    });
    ws.addRow([]); // spacer

    // Column headers.
    const headerRow = ws.addRow(COLUMNS.map(c => c.header));
    headerRow.height = 22;
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_RED } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
      cell.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
    });
    ws.autoFilter = { from: { row: headerRow.number, column: 1 },
                      to:   { row: headerRow.number, column: COLUMNS.length } };

    // Data rows + decide the per-invoice attached filename up-front so
    // the ledger row can point at it. The actual file is appended below.
    const usedFilenames = new Set();
    const fileAssignments = [];
    rows.forEach((r, i) => {
      const hasInvoice = Boolean(r.invoice_r2_key) || Boolean(r.invoice_data);
      let attachedName = '';
      if (hasInvoice) {
        const ext = ((r.invoice_filename || '').split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf';
        const invNum = safeNameForZip(String(r.invoice_number || `id-${r.id}`).trim()) || `id-${r.id}`;
        const dateTag = r.invoice_date ? new Date(r.invoice_date).toISOString().slice(0, 10) : '';
        const base = dateTag ? `${invNum} — ${dateTag}` : invNum;
        let candidate = `${base}.${ext}`;
        let n = 2;
        while (usedFilenames.has(candidate)) { candidate = `${base} (${n}).${ext}`; n++; }
        usedFilenames.add(candidate);
        attachedName = candidate;
        fileAssignments.push({ r, name: candidate });
      } else {
        fileAssignments.push({ r, name: null });
      }

      const data = {
        invoice_date:  r.invoice_date ? new Date(r.invoice_date) : null,
        invoice_number: r.invoice_number || '',
        artist: r.artist || '',
        song: r.song || '',
        description: r.description || '',
        category: r.category || '',
        family_amount: Number.isFinite(Number(r.family_amount)) ? Number(r.family_amount) : null,
        currency: (r.currency || 'USD').toUpperCase(),
        payment_status: r.payment_status || '',
        payment_date: r.payment_date ? new Date(r.payment_date) : null,
        payment_method: r.payment_method || '',
        paid_by: r.paid_by || '',
        payment_terms: r.payment_terms || '',
        scheduled_payment_date: r.scheduled_payment_date ? new Date(r.scheduled_payment_date) : null,
        notes: r.notes || '',
        file_name: attachedName || '(no file on record)',
      };
      const row = ws.addRow(data);
      const banded = i % 2 === 1;
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const colDef = COLUMNS[col - 1];
        cell.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
        cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: !!colDef?.wrap };
        if (banded) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_BAND } };
        if (colDef?.type === 'currency' && typeof cell.value === 'number') {
          cell.numFmt = '"$"#,##0.00;[Red]-"$"#,##0.00';
          cell.alignment = { ...cell.alignment, horizontal: 'right' };
        } else if (colDef?.type === 'date' && cell.value instanceof Date) {
          cell.numFmt = 'yyyy-mm-dd';
        }
      });
    });

    // Total row at the bottom.
    ws.addRow([]);
    const totalRow = ws.addRow({});
    totalRow.getCell('invoice_number').value = 'TOTAL';
    totalRow.getCell('invoice_number').font = { bold: true, size: 11 };
    totalRow.getCell('family_amount').value = totalAmount;
    totalRow.getCell('family_amount').font = { bold: true, size: 11 };
    totalRow.getCell('family_amount').numFmt = '"$"#,##0.00;[Red]-"$"#,##0.00';
    totalRow.getCell('family_amount').alignment = { horizontal: 'right' };
    for (let col = 1; col <= COLUMNS.length; col++) {
      totalRow.getCell(col).border = { top: { style: 'medium', color: { argb: 'FF111111' } }, bottom: THIN };
    }

    const ledgerBuf = await wb.xlsx.writeBuffer();
    archive.append(Buffer.from(ledgerBuf), { name: `00 - ${safeName} ledger.xlsx` });

    // ── 2) Append each invoice file under invoices/
    let invoicesAdded = 0;
    let missingFile = 0;
    for (const { r, name } of fileAssignments) {
      if (!name) { missingFile++; continue; }
      try {
        const buf = await loadFileBuffer(r.invoice_r2_key, r.invoice_data);
        if (!buf) { missingFile++; continue; }
        archive.append(buf, { name: `invoices/${name}` });
        invoicesAdded++;
      } catch (err) {
        console.warn(`[vendor-zip] invoice ${r.id} failed:`, err.message);
        missingFile++;
      }
    }

    // ── 3) Append the most-recent W9 / W8 for this vendor (if any).
    // Alias-aware lookup — matches GET /vendor-w9-status. If the vendor
    // has a vendor_aliases entry on either side (alias→primary or
    // primary→alias), look up the W9 on the linked name too. Without
    // this, a vendor whose W9 is filed under their legal name but
    // whose pages use a DBA never has the W9 surface in the ZIP.
    const { rows: w9Rows } = await pool.query(`
      SELECT id, w9_data, w9_r2_key, w9_filename
        FROM expenses
       WHERE (deleted = false OR deleted IS NULL)
         AND status != 'rejected'
         AND ((w9_data IS NOT NULL AND w9_data != '') OR w9_r2_key IS NOT NULL)
         AND (
           LOWER(TRIM(payee)) = LOWER(TRIM($1))
           OR LOWER(TRIM(payee)) IN (
             SELECT LOWER(TRIM(va.alias))        FROM vendor_aliases va WHERE LOWER(TRIM(va.primary_name)) = LOWER(TRIM($1))
             UNION
             SELECT LOWER(TRIM(va.primary_name)) FROM vendor_aliases va WHERE LOWER(TRIM(va.alias))        = LOWER(TRIM($1))
           )
         )
       ORDER BY id DESC
       LIMIT 1
    `, [payee]);
    let w9Added = false;
    if (w9Rows.length) {
      try {
        const buf = await loadFileBuffer(w9Rows[0].w9_r2_key, w9Rows[0].w9_data);
        if (buf) {
          const ext = ((w9Rows[0].w9_filename || '').split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf';
          const isW8 = /w8/i.test(w9Rows[0].w9_filename || '');
          archive.append(buf, { name: `${isW8 ? 'W8' : 'W9'} - ${safeName}.${ext}` });
          w9Added = true;
        }
      } catch (err) {
        console.warn(`[vendor-zip] W9 ${w9Rows[0].id} failed:`, err.message);
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error('GET /api/bk/vendor-zip:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
