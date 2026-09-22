// Financial reports — P&L (cash basis) and Balance Sheet.
//
// P&L: revenue from artist_income (income_date), expenses from the ledger
// (payment_status='Paid', bucketed by payment_date — cash basis, so the
// report reconciles 1:1 against the bank statements). Monthly columns.
//
// Balance Sheet (as-of date):
//   Assets      = Cash (latest statement ending_balance per account)
//               + Accounts Receivable (unpaid outbound invoices)
//   Liabilities = Accounts Payable (approved, unpaid ledger entries)
//   Equity      = Assets − Liabilities (plug)
//
// All USD: locked fx_rate_to_usd first, cached ECB rate fallback — never 1:1.
const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { getCached } = require('../services/fx');
const { normalizeBankPayee } = require('../lib/normalize-bank-payee');

const router = express.Router();
router.use(authMiddleware);

const isBkAdmin = (u) => u && (u.role === 'Admin' || u.role === 'Superadmin' || u.role === 'Approver');

// Moved to lib/usd.js so the 1099 report converts identically. Re-exported
// under the local name so the ~6 call sites below read unchanged.
const { usdOf } = require('../lib/usd');
const { resyncBreakdown } = require('../lib/split-breakdown');
const { loadLabelLevelRules, loadAllocations, applyAllocations } = require('../lib/label-level');
const { toCents, fromCents, apportion, drawMany } = require('../lib/ad-allocate');
const { artistKeyOf, PLACEHOLDER_ARTIST_KEYS, artistBucketKey } = require('../lib/artist-key');
const { autoLinkRelease } = require('../lib/release-linking');
const { pairReversals, REVERSAL_WINDOW_DAYS } = require('../lib/reversal-pairs');

// pg returns DATE columns as JS Date objects (local midnight) — slicing the
// default string gave "Thu Jan…" buckets that the report silently dropped.
const ym = (d) => {
  if (d instanceof Date) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return String(d).slice(0, 7);
};
function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ey, em] = to.slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// Pass-through / non-operating buckets. A drawdown is an advance received
// (a liability, not revenue); reimbursements wash in and out; refunds
// reverse spend. They're reported below the operating line so a $700k
// drawdown month doesn't read as a record month.
// Fallback only. The live classification lives on bk_categories
// (report_section / contra_of) so it can be changed without a deploy — see
// reportSections() below. These two sets are what a brand-new database gets
// before the seed runs, and what an unreadable table degrades to.
const BELOW_LINE_INCOME = new Set(['Drawdown Fund', 'Reimbursements', 'Refund']);
const BELOW_LINE_EXPENSE = new Set(['Advance', 'Reimbursements']);

/**
 * Where each category sits on the P&L, and what it offsets.
 *
 * Returns { section(kind, name) -> 'operating'|'below_line'|'non_recurring',
 *           contraOf(kind, name) -> expense category name | null }
 *
 * Advisory, like every other classification loader here: on error it falls back
 * to the hardcoded sets above and logs. A reporting refinement must never be
 * able to take the P&L down.
 */
async function reportSections() {
  const byKey = new Map();
  try {
    const { rows } = await pool.query(
      'SELECT kind, name, report_section, contra_of FROM bk_categories');
    for (const r of rows) {
      byKey.set(`${r.kind}:${String(r.name).trim().toLowerCase()}`,
        { section: r.report_section || 'operating', contraOf: r.contra_of || null });
    }
  } catch (err) {
    console.error('bk_categories classification unavailable — using built-in defaults:', err.message);
  }
  const look = (kind, name) => byKey.get(`${kind}:${String(name || '').trim().toLowerCase()}`);
  return {
    section: (kind, name) => {
      const hit = look(kind, name);
      if (hit) return hit.section;
      // Fallback for a category the table doesn't know about yet.
      const fallback = kind === 'income' ? BELOW_LINE_INCOME : BELOW_LINE_EXPENSE;
      return fallback.has(String(name || '').trim()) ? 'below_line' : 'operating';
    },
    contraOf: (kind, name) => look(kind, name)?.contraOf || null,
  };
}

// The label for bank debits that haven't been matched or booked yet, and
// bank credits that haven't been typed. They keep the report's totals equal
// to what the bank actually saw.
const UNORGANIZED_OUT = 'Unorganized (not yet booked)';
const UNORGANIZED_IN = 'Unclassified money in';

const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// Date params reach SQL as `$1::date`, so a malformed one used to surface as a
// raw Postgres 500 ("invalid input syntax for type date") — an unhandled input
// and a leaked internal message in one. Validate shape AND realness: '2026-02-31'
// is well-formed and still not a date.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isValidDay = (s) => {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
// Reporting spans are bounded: 1900-01-01..2100-01-01 was accepted and produced
// 2,401 month buckets, which the client renders as 2,401 table columns.
const MAX_REPORT_MONTHS = 120;
const monthSpan = (from, to) => {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
};
// Returns an error string, or null when the range is usable.
const rangeProblem = (from, to) => {
  if (!isValidDay(from) || !isValidDay(to)) return 'from and to must be YYYY-MM-DD dates';
  // BACKWARDS is not "wide" — monthSpan goes NEGATIVE, which sails through the
  // test below. from=2026-12-01&to=2026-01-31 returned 200 with `months: []`
  // and $0.00: a confident, downloadable, empty P&L instead of an error, on
  // every surface that calls this — the report, the drill, search,
  // spend-by-artist and all three exports.
  if (from > to) return 'from is after to — the range runs backwards';
  if (monthSpan(from, to) > MAX_REPORT_MONTHS) return `range too wide — ${MAX_REPORT_MONTHS} months maximum`;
  return null;
};

// Cross-statement duplicate uploads: the same charge appearing in two
// different statement files is ONE real charge. Group by
// account+date+direction+amount+payee; when a group spans statements, keep
// the copies from the single statement holding the most rows for that key
// (legitimate same-day multiples — 4× $19 FACEBK — live inside one
// statement), preferring the copy set that carries matches.
function dedupeTxns(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = [r.account, ymd(r.txn_date), r.direction, r.amount,
      (r.payee_guess || '').toLowerCase().trim()].join('|');
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const out = [];
  for (const group of byKey.values()) {
    const perStmt = new Map();
    for (const r of group) {
      if (!perStmt.has(r.statement_id)) perStmt.set(r.statement_id, []);
      perStmt.get(r.statement_id).push(r);
    }
    if (perStmt.size === 1) { out.push(...group); continue; }
    let best = null;
    for (const rs of perStmt.values()) {
      const matchedN = rs.filter((r) => r.matched_expense_id || r.matched_income_id).length;
      if (!best || rs.length > best.rs.length
        || (rs.length === best.rs.length && matchedN > best.matchedN)) {
        best = { rs, matchedN };
      }
    }
    out.push(...best.rs);
  }
  return out;
}

// Statement-mastered transaction pull shared by buildPnl and pnlDetail.
// One bank row = one unit of money movement; the ledger only supplies
// categorization. Internal noise is dismissed upstream by the statements
// pipeline, so dismissed=false excludes it here.
// Fingerprint for report dismissals: date | amount to 2dp | normalized payee,
// falling back to the email when there's no payee. Deliberately the same
// shape as txnFingerprint in routes/statements.js and, critically, the same
// payee normalizer — which strips card-code noise, so the fingerprint of a
// recurring charge is stable across statement re-uploads. A hand-rolled
// normalizer here would produce a different key for the same charge and the
// dismissal would silently reappear.
const fingerprintOf = (t) => [
  ymd(t.txn_date),
  Number(t.amount).toFixed(2),
  normalizeBankPayee(t.payee_guess) || String(t.payee_email || '').toLowerCase().trim(),
].join('|');

// ── Dismissals are ADVISORY — they must never take the report down ──────────
// buildPnl awaits both of these on every render, so an unavailable
// report_dismissals table or a missing `scope` column used to 500 the entire
// P&L: no revenue, no expenses, no balance sheet, because an optional
// exclusion feature couldn't be read.
//
// That's the wrong failure direction. The schema migrations in index.js are all
// wrapped in `.catch(() => {})`, so a constraint swap CAN fail silently and
// leave the column absent — and the page whose numbers matter most should not
// be the casualty. On error these degrade to "nothing dismissed", which shows
// the full, un-excluded figures: too much rather than nothing, and the error is
// logged so it doesn't pass unnoticed.
//
// Same convention as fetchFlags on the client ("flags are advisory — never
// block the page") and the `.catch(() => ({ rows: [] }))` on the match-rejection
// reads in routes/statements.js.
async function dismissedExpenseIds() {
  try {
    const { rows } = await pool.query(
      "SELECT expense_id FROM report_dismissals WHERE scope = 'item' AND expense_id IS NOT NULL");
    return new Set(rows.map((r) => r.expense_id));
  } catch (err) {
    console.error('report_dismissals (items) unavailable — reporting without exclusions:', err.message);
    return new Set();
  }
}

// Dismissed P&L LINES, as a Set of 'expense:Marketing' / 'income:Rent' keys —
// the same shape buildPnl buckets by, so membership is a direct lookup.
// Lower-cased because the rule is case-insensitive.
async function dismissedCategoryKeys() {
  try {
    const { rows } = await pool.query(
      "SELECT cell_kind, cell_key FROM report_dismissals WHERE scope = 'category'");
    return new Set(rows.map((r) => `${r.cell_kind}:${String(r.cell_key).trim().toLowerCase()}`));
  } catch (err) {
    console.error('report_dismissals (categories) unavailable — reporting without exclusions:', err.message);
    return new Set();
  }
}
const cellKeyOf = (kind, key) => `${kind}:${String(key || '').trim().toLowerCase()}`;

// ── Month reassignment ──────────────────────────────────────────────────────
//
// "This July payment is really June's." A per-transaction override of the month
// the P&L reports a row in. The bank row keeps its real date — see the table
// comment in server/index.js for why that is non-negotiable.
//
// Advisory in exactly the same sense as the dismissal loaders above: on error
// this degrades to "no overrides" and the report renders on real bank dates. An
// optional adjustment must never be able to take the P&L down.
const isMonthKey = (s) => /^\d{4}-\d{2}$/.test(String(s || ''));
const monthStart = (m) => `${m}-01`;
const monthEnd = (m) => {
  const [y, mm] = m.split('-').map(Number);
  return ymd(new Date(Date.UTC(y, mm, 0)));   // day 0 of next month = last of this
};

async function monthOverrides() {
  try {
    const { rows } = await pool.query(
      'SELECT txn_fingerprint, original_month, target_month FROM report_month_overrides');
    return new Map(rows.map((r) => [r.txn_fingerprint,
      { target: r.target_month, original: r.original_month }]));
  } catch (err) {
    console.error('report_month_overrides unavailable — reporting on bank dates:', err.message);
    return new Map();
  }
}

// Rows come back with report_dismissed flagged rather than filtered out, so
// the caller can partition them AFTER the shared category / FX / dedupe
// logic has run. Filtering in SQL would mean the disclosure totals were
// computed by a different code path than the reported totals — which is
// precisely how two numbers that should agree stop agreeing.
//
// ── Why this function, and only this function, applies month overrides ───────
//
// Every path that derives money calls it: buildPnl (the P&L, both exports),
// pnlDetail (the drill) and /search. A bucketing rule applied to fewer than all
// of them disagrees SILENTLY — that is how the drill once reported $3.73M the
// P&L had already excluded. One insertion point, every surface.
//
// The subtlety is the SQL window. A July row reassigned to June is not inside
// June's date window, so a June query would never see it. The fix is to OR in
// the date range of each month that has a row moving INTO the window, then
// filter on the *reported* month in JS. Bounded by the override table, which is
// small, rather than by an open-ended widening of the scan.
// ── "Paid on the ledger, and no bank row vouches for it" ────────────────────
//
// ONE definition, because there were three. buildPnl's band, the drill behind
// it and /search's ledger-unverified bucket each carried their own copy of this
// predicate, and only buildPnl's carried the correction below — so the band read
// $454,607.13 over 337 rows while its own drill read $458,472.29 over 342, and
// the five extra rows were invoices a bank line demonstrably vouches for.
//
// THE CORRECTION: one payment can settle SEVERAL invoices, and only the primary
// lands in `matched_expense_id`. The secondaries are tied to the payment through
// `bank_txn_invoice_links`, so a query that knows only about matched_expense_id
// reports them as unvouched-for — putting already-reconciled payments back into
// the very worklist people work to chase down missing evidence.
//
// `cols` is the one thing that legitimately differed between the three callers
// (each needs its own SELECT list), so it is the parameter and everything that
// decides WHICH ROWS is shared.
const UNVERIFIED_FAMILY_TOTAL = `r.amount + COALESCE((SELECT SUM(c.amount) FROM expenses c
    WHERE c.parent_id = r.id AND (c.deleted = false OR c.deleted IS NULL)
      AND (c.voided = false OR c.voided IS NULL)), 0)`;

async function unverifiedLedgerRows({ from, to, artist, cols, orderBy = '' }) {
  const { rows } = await pool.query(`
    SELECT ${cols}, ${UNVERIFIED_FAMILY_TOTAL} AS family_total
      FROM expenses r
     WHERE r.parent_id IS NULL AND r.status = 'approved'
       AND (r.deleted = false OR r.deleted IS NULL)
       AND (r.voided = false OR r.voided IS NULL)
       AND r.payment_status = 'Paid' AND r.payment_date BETWEEN $1 AND $2
       AND r.id NOT IN (SELECT bt.matched_expense_id FROM bank_transactions bt
                         JOIN bank_statements bs ON bs.id = bt.statement_id AND bs.status = 'ready'
                        WHERE bt.matched_expense_id IS NOT NULL AND bt.dismissed = false)
       ${artist ? 'AND LOWER(TRIM(r.artist)) = LOWER(TRIM($3))' : ''}
     ${orderBy}`,
    artist ? [from, to, artist] : [from, to]);

  // The secondaries. `.catch()` is load-bearing rather than defensive:
  // runMigrations() runs in the BACKGROUND after app.listen, so this table can
  // be absent for the first seconds of a deploy, and the report degrading to the
  // old (slightly over-stated) answer beats 500ing the whole page.
  const { rows: linked } = await pool.query(
    `SELECT bl.expense_id FROM bank_txn_invoice_links bl
       JOIN bank_transactions bt ON bt.id = bl.txn_id
      WHERE bt.matched_expense_id IS NOT NULL AND bt.dismissed = false`)
    .catch(() => ({ rows: [] }));
  const linkedIds = new Set(linked.map((x) => x.expense_id));
  const vouched = rows.filter((r) => !linkedIds.has(r.id));

  // Dismissing one of these never moves a counted total — the set is shown and
  // never counted — it only clears the row out of the worklist. Reported back so
  // the band can still say how many were answered that way.
  const dismissedIds = await dismissedExpenseIds();
  const kept = vouched.filter((r) => !dismissedIds.has(r.id));
  return { rows: kept, dismissed_count: vouched.length - kept.length };
}

async function bankRows(from, to) {
  const overrides = await monthOverrides();
  const wantedMonths = new Set(monthsBetween(from, to));

  // Months whose rows might have been moved into range. Excludes months already
  // covered by the plain window, so the common case adds no extra SQL at all.
  const extraMonths = [...new Set([...overrides.values()]
    .filter((o) => wantedMonths.has(o.target) && !wantedMonths.has(o.original))
    .map((o) => o.original))];

  const params = [from, to];
  const extraSql = extraMonths.map((m) => {
    params.push(monthStart(m), monthEnd(m));
    return `OR (t.txn_date BETWEEN $${params.length - 1} AND $${params.length})`;
  }).join(' ');

  const { rows } = await pool.query(`
    SELECT t.id, t.statement_id, t.txn_date, t.amount, t.direction,
           COALESCE(t.currency, 'USD') AS currency, t.payee_guess, t.description,
           -- REQUIRED by fingerprintOf. Omitting it made every item dismissal on
           -- a payee-less row (PayPal, card-code descriptors) silently ineffective:
           -- POST /dismiss stored a key ending in the email, this side recomputed
           -- one ending in an empty string, and the two could never match. The API
           -- returned success, the row listed as dismissed, and the total didn't move.
           t.payee_email,
           t.matched_expense_id, t.matched_income_id, t.match_method, t.flagged,
           s.account, s.filename,
           e.category AS m_category, e.artist AS m_artist, e.payee AS m_payee,
           -- The ROOT's own amount. A split family is the root plus its children
           -- (root.amount + SUM of children = the family total, the same
           -- convention family_total uses elsewhere in this file), so
           -- attachSplitParts needs it to give the root its share.
           e.amount AS m_root_amount,
           -- Is the entry behind this row a real invoice, or one the app invented
           -- from the bank line? The P&L takes its CATEGORY from that entry, so
           -- this is the difference between a reported figure and a guess.
           e.entry_source AS m_entry_source,
           e.song AS m_song, e.invoice_number AS m_invoice, e.fx_rate_to_usd AS m_fx,
           e.boom_rep AS m_rep,
           COALESCE(e.currency, 'USD') AS m_currency,
           ai.income_type AS m_income_type, ai.artist_name AS m_income_artist,
           ai.description AS m_income_desc
      FROM bank_transactions t
      JOIN bank_statements s ON s.id = t.statement_id AND s.status = 'ready'
      LEFT JOIN expenses e ON e.id = t.matched_expense_id
      LEFT JOIN artist_income ai ON ai.id = t.matched_income_id
     WHERE t.dismissed = false
       AND ((t.txn_date BETWEEN $1 AND $2) ${extraSql})`, params);
  const deduped = dedupeTxns(rows);
  if (!deduped.length) return deduped;

  // Fingerprint match, so the dismissal survives a statement re-upload.
  const { rows: dis } = await pool.query(
    'SELECT txn_fingerprint FROM report_dismissals WHERE txn_fingerprint IS NOT NULL')
    .catch((err) => {
      console.error('report_dismissals unavailable — reporting without exclusions:', err.message);
      return { rows: [] };
    });
  const dismissed = new Set(dis.map((d) => d.txn_fingerprint));

  // Stamp the REPORTED month on every row, then keep only what belongs in this
  // window. Downstream code buckets on `report_month` and never on txn_date —
  // the real date stays on the row because it is evidence and gets displayed.
  const out = [];
  for (const r of deduped) {
    const fp = fingerprintOf(r);
    const ov = overrides.get(fp);
    const reportMonth = ov ? ov.target : ym(r.txn_date);
    // The widened query pulls whole months; a row from an extra month that was
    // NOT itself moved is not ours. Equally, a row inside the plain window that
    // was moved out has to go.
    if (!wantedMonths.has(reportMonth)) continue;
    out.push({
      ...r,
      report_dismissed: dismissed.has(fp),
      report_month: reportMonth,
      moved_from: ov ? ov.original : null,
    });
  }
  await attachSplitParts(out);
  return out;
}

// A payment can cover two artists, or a fee and a royalty. Split-book records
// that as a family — the matched entry plus its children — and each member
// carries its OWN category and artist.
//
// Without this the report reads the ROOT only, so a $1,000 debit split
// Marketing/Jerri $600 + Royalties/Oxis $300 + Other $100 reported $1,000 of
// Marketing spend, all of it Jerri's, and Oxis never appeared in Spend by
// Artist at all. Measured before this shipped: 54 matched families, 31 with a
// child naming a different artist and 19 a different category — every one of
// them reported under the root's labels.
//
// The MONEY does not move: the row's USD is apportioned across the parts by
// their share of the family total, so every consumer still counts each bank row
// exactly once (STATEMENTS ARE THE MASTER). Only the labels get finer.
async function attachSplitParts(rows) {
  const ids = [...new Set(rows.filter((r) => r.direction === 'debit' && r.matched_expense_id)
    .map((r) => r.matched_expense_id))];
  if (!ids.length) return;
  const { rows: kids } = await pool.query(`
    SELECT id, parent_id, category, artist, amount
      FROM expenses
     WHERE parent_id = ANY($1::int[])
       AND (deleted = false OR deleted IS NULL)
       AND (voided = false OR voided IS NULL)`, [ids])
    .catch((err) => {
      // Degrade to root-only attribution rather than failing the report.
      console.error('split parts unavailable — reporting on family roots:', err.message);
      return { rows: [] };
    });
  if (!kids.length) return;
  const byParent = new Map();
  for (const k of kids) {
    const list = byParent.get(k.parent_id) || [];
    list.push(k);
    byParent.set(k.parent_id, list);
  }
  for (const r of rows) {
    const list = byParent.get(r.matched_expense_id);
    if (!list) continue;
    // The root is a part too — split-book writes the first part AS the parent,
    // so leaving it out would drop its share of the payment.
    //
    // Each part carries its OWN expense id. Without it a drill row could only
    // offer the family root to /set-artist and /recategorize, so relabelling the
    // Royalties share would have retyped whichever part the root happens to be —
    // which is why the drill used to refuse to edit a split at all.
    r.m_parts = [{ id: r.matched_expense_id, category: r.m_category, artist: r.m_artist, amount: r.m_root_amount }, ...list];
  }
}

// Rows whose override pushes them OUT of the reported range, so buildPnl can
// disclose them. They are absent from bankRows by construction — which is
// correct, and is also exactly why they need saying out loud: `sumSeries` skips
// month keys it doesn't know, so without this the money would leave the totals
// with nothing on the page to explain the difference.
async function movedOutOfRange(from, to) {
  const overrides = await monthOverrides();
  if (!overrides.size) return [];
  const wanted = new Set(monthsBetween(from, to));
  const gone = [...overrides.entries()]
    .filter(([, o]) => wanted.has(o.original) && !wanted.has(o.target));
  if (!gone.length) return [];

  const months = [...new Set(gone.map(([, o]) => o.original))];
  const params = [];
  const windows = months.map((m) => {
    params.push(monthStart(m), monthEnd(m));
    return `(t.txn_date BETWEEN $${params.length - 1} AND $${params.length})`;
  }).join(' OR ');
  const { rows } = await pool.query(`
    SELECT t.id, t.txn_date, t.amount, t.direction,
           COALESCE(t.currency, 'USD') AS currency, t.payee_guess, t.description,
           t.payee_email, t.matched_expense_id, t.matched_income_id,
           e.category AS m_category, e.payee AS m_payee, e.fx_rate_to_usd AS m_fx,
           COALESCE(e.currency, 'USD') AS m_currency,
           ai.income_type AS m_income_type
      FROM bank_transactions t
      JOIN bank_statements s ON s.id = t.statement_id AND s.status = 'ready'
      LEFT JOIN expenses e ON e.id = t.matched_expense_id
      LEFT JOIN artist_income ai ON ai.id = t.matched_income_id
     WHERE t.dismissed = false AND (${windows})`, params);
  const byFp = new Map(gone);
  return dedupeTxns(rows)
    .map((r) => ({ row: r, ov: byFp.get(fingerprintOf(r)) }))
    .filter((x) => x.ov)
    .map(({ row, ov }) => ({
      id: row.id,
      date: row.txn_date,
      payee: (row.m_payee || row.payee_guess || row.description) || '—',
      usd: txnUsd(row),
      direction: row.direction,
      from_month: ov.original,
      to_month: ov.target,
    }));
}

// Reversal pairs, fetched on their own terms rather than out of bankRows.
//
// Two reasons this can't reuse the counted set. First, bankRows filters
// `t.dismissed = false` in SQL, and the credit leg is usually ALREADY dismissed
// as housekeeping ("it isn't income") — so the very rows that prove a debit was
// undone are invisible to the report. Second, a debit on the 28th reversed on
// the 2nd has its two legs in different months, so the window has to overhang
// the reporting period on both sides.
//
// Deduped with the same dedupeTxns the counted path uses, so the ids returned
// here are the ids that appear in `rows`. Groups are keyed on
// account|date|direction|amount|payee and every copy of an in-range charge falls
// inside the widened window, so both calls select the same copy.
//
// Fail-safe direction: if an id somehow isn't in the counted set the exclusion
// does nothing and the old (overstated) number stands. Under-excluding is
// recoverable; silently removing real money is not.
async function reversalExclusions(from, to) {
  const { rows } = await pool.query(`
    SELECT t.id, t.statement_id, t.txn_date, t.amount, t.direction, t.dismissed,
           COALESCE(t.currency, 'USD') AS currency, t.payee_guess, t.description,
           t.matched_expense_id, t.matched_income_id, s.account
      FROM bank_transactions t
      JOIN bank_statements s ON s.id = t.statement_id AND s.status = 'ready'
     WHERE t.txn_date BETWEEN ($1::date - $3::int) AND ($2::date + $3::int)`,
  [from, to, REVERSAL_WINDOW_DAYS]);
  const deduped = dedupeTxns(rows);
  // Debits are filtered to live rows; credits deliberately are NOT, because the
  // credit leg is usually already dismissed as housekeeping — that asymmetry is
  // the whole reason this query is separate from bankRows.
  //
  // Without the debit filter a DISMISSED debit (an internal transfer at the same
  // amount and counterparty, closer in time) could win the credit under
  // one-to-one pairing and lock it, leaving the real counted debit unpaired and
  // still in the P&L — silently undoing the exclusion this function exists for.
  const pairs = pairReversals(
    deduped.filter((r) => r.direction === 'debit' && !r.dismissed),
    deduped.filter((r) => r.direction === 'credit'));
  const ids = new Set();
  for (const p of pairs) { ids.add(p.debit.id); ids.add(p.credit.id); }
  return { ids, pairs };
}

// The bank row's OWN currency decides the conversion. The ledger's locked
// fx_rate_to_usd speaks for the LEDGER amount's currency — applying it to a
// USD bank settle of a GBP invoice inflated the row ($137.45 → ~$189).
// Use the lock only when the bank row actually settles in that currency.
// ── THE BASIS (2026-09-20, John: a selectable basis with a data-driven default) ──
//
//   bank     statements are the master — every bank line once, the ledger
//            supplies categories (the original, and the only PROVABLE basis)
//   ledger   cash by the LEDGER: every alive approved row marked Paid, dated by
//            payment_date, counted whether or not a statement vouches for it —
//            what a label with no statements yet can read today
//   accrual  every alive approved row dated by invoice date, paid or not —
//            the commitment view Financials used to be the only home of
//
// ledgerRows returns rows in bankRows' SHAPE so everything downstream —
// reversals, dismissals (by the same fingerprint, so a payment dismissed on
// one basis is dismissed on all), sections, contra, artists, drills, exports —
// runs unchanged. Each ledger row is its own part: a split family is the root
// (its own slice) plus its children, and every row carries its own category
// and artist, so no m_parts and no root arithmetic. Income comes from
// artist_income by income_date on both ledger bases.
const BASES = new Set(['bank', 'ledger', 'accrual']);
const basisParam = (v) => (BASES.has(String(v || '')) ? String(v) : null);
const BASIS_LABEL = { bank: 'Bank statements', ledger: 'Ledger — paid', accrual: 'Accrual — invoiced' };
async function ledgerRows(from, to, basis) {
  const wanted = new Set(monthsBetween(from, to));
  const dateSql = basis === 'accrual' ? 'COALESCE(e.invoice_date, e.created_at::date)' : 'e.payment_date';
  const paidSql = basis === 'accrual' ? '' : "AND e.payment_status = 'Paid' AND e.payment_date IS NOT NULL";
  const { rows: ex } = await pool.query(`
    SELECT e.id, ${dateSql} AS txn_date, e.amount, COALESCE(e.currency, 'USD') AS currency,
           e.payee, e.vendor_email, e.description, e.flagged,
           e.category AS m_category, e.artist AS m_artist, e.payee AS m_payee, e.amount AS m_root_amount,
           e.entry_source AS m_entry_source, e.song AS m_song, e.invoice_number AS m_invoice,
           e.fx_rate_to_usd AS m_fx, COALESCE(e.currency, 'USD') AS m_currency, e.boom_rep AS m_rep,
           e.payment_status, e.status
      FROM expenses e
     WHERE COALESCE(e.status, 'approved') = 'approved'
       AND (e.deleted = false OR e.deleted IS NULL) AND (e.voided = false OR e.voided IS NULL)
       AND e.amount > 0
       ${paidSql}
       AND ${dateSql} BETWEEN $1 AND $2`, [from, to]);
  const { rows: inc } = await pool.query(`
    SELECT ai.id, ai.income_date AS txn_date, ai.amount, ai.income_type AS m_income_type,
           ai.artist_name AS m_income_artist, ai.description AS m_income_desc
      FROM artist_income ai WHERE ai.income_date BETWEEN $1 AND $2 AND ai.amount > 0`, [from, to]).catch(() => ({ rows: [] }));
  const { rows: dis } = await pool.query('SELECT txn_fingerprint FROM report_dismissals WHERE txn_fingerprint IS NOT NULL').catch(() => ({ rows: [] }));
  const dismissed = new Set(dis.map((d) => d.txn_fingerprint));
  const source = BASIS_LABEL[basis];
  const out = [];
  for (const e of ex) {
    const r = {
      id: `e${e.id}`, statement_id: null, txn_date: e.txn_date, amount: Math.abs(Number(e.amount)), direction: 'debit',
      currency: e.currency, payee_guess: e.payee, description: e.description || e.payee, payee_email: e.vendor_email || null,
      matched_expense_id: e.id, matched_income_id: null, match_method: basis, flagged: !!e.flagged,
      account: 'ledger', filename: source,
      m_category: e.m_category, m_artist: e.m_artist, m_payee: e.m_payee, m_root_amount: e.m_root_amount,
      m_entry_source: e.m_entry_source, m_song: e.m_song, m_invoice: e.m_invoice, m_fx: e.m_fx, m_currency: e.m_currency, m_rep: e.m_rep,
      m_income_type: null, m_income_artist: null, m_income_desc: null,
      unpaid: e.payment_status !== 'Paid',
    };
    const month = ym(r.txn_date);
    if (!wanted.has(month)) continue;
    out.push({ ...r, report_dismissed: dismissed.has(fingerprintOf(r)), report_month: month, moved_from: null });
  }
  for (const i of inc) {
    const r = {
      id: `i${i.id}`, statement_id: null, txn_date: i.txn_date, amount: Math.abs(Number(i.amount)), direction: 'credit',
      currency: 'USD', payee_guess: i.m_income_desc, description: i.m_income_desc, payee_email: null,
      matched_expense_id: null, matched_income_id: i.id, match_method: basis, flagged: false,
      account: 'ledger', filename: source,
      m_income_type: i.m_income_type, m_income_artist: i.m_income_artist, m_income_desc: i.m_income_desc,
    };
    const month = ym(r.txn_date);
    if (!wanted.has(month)) continue;
    out.push({ ...r, report_dismissed: dismissed.has(fingerprintOf(r)), report_month: month, moved_from: null });
  }
  return out;
}
const rowsFor = (from, to, basis) => (basis && basis !== 'bank' ? ledgerRows(from, to, basis) : bankRows(from, to));

// What the page should open on: the bank once a month has been RECONCILED
// (statements uploaded and closed), the ledger before that. A fresh label with
// no statements read as zero under the bank basis, however much it had paid.
async function defaultBasis() {
  const { rows } = await pool.query('SELECT month_key FROM statement_months WHERE reconciled_at IS NOT NULL ORDER BY month_key DESC LIMIT 1').catch(() => ({ rows: [] }));
  const { rows: [st] } = await pool.query(`SELECT COUNT(*)::int AS n FROM bank_statements WHERE status = 'ready'`).catch(() => ({ rows: [{ n: 0 }] }));
  return { default: rows.length ? 'bank' : 'ledger', reconciled_through: rows[0]?.month_key || null, statements: st?.n || 0, bases: BASIS_LABEL };
}

const txnUsd = (r) => {
  const cur = (r.currency || 'USD').toUpperCase();
  if (cur === 'USD') return parseFloat(r.amount || 0);
  const locked = (r.matched_expense_id && (r.m_currency || 'USD').toUpperCase() === cur) ? r.m_fx : null;
  return usdOf(r.amount, cur, locked);
};
const txnCategory = (r) => (r.matched_expense_id ? ((r.m_category || '').trim() || 'Uncategorized') : UNORGANIZED_OUT);
const txnIncomeType = (r) => (r.matched_income_id ? (r.m_income_type || 'Other Income') : UNORGANIZED_IN);
const txnArtist = (r) => (r.direction === 'debit' ? r.m_artist : r.m_income_artist) || null;
const artistEq = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// How this bank row's money is labelled: one part per family member, each with
// its own category, artist and SHARE of the payment. A row that isn't split
// yields exactly one part at share 1, which is byte-for-byte the old behaviour —
// that is what keeps this change invisible to the 3,646 unsplit rows.
//
// ALWAYS the whole payment — callers select the parts they want by index, never
// by re-deriving the division, so every surface apportions identically.
const txnParts = (r) => {
  const whole = [{ id: r.matched_expense_id || null, cat: txnCategory(r), artist: txnArtist(r), share: 1 }];
  const list = Array.isArray(r.m_parts) && r.m_parts.length > 1 ? r.m_parts : null;
  if (!list) return whole;
  const total = list.reduce((s, p) => s + Math.abs(Number(p.amount) || 0), 0);
  // A family whose amounts don't add up to anything can't be apportioned; fall
  // back to the root rather than inventing a division.
  if (!(total > 0)) return whole;
  return list.map((p) => ({
    // The ledger row this part IS. An unsplit row yields the family root, so a
    // caller can always write to "the part it selected" without a special case.
    id: p.id ?? r.matched_expense_id ?? null,
    cat: (p.category || '').trim() || 'Uncategorized',
    artist: (p.artist || '').trim() || null,
    share: Math.abs(Number(p.amount) || 0) / total,
  }));
};

// Does this row name the artist the whole report is filtered to? Tested over the
// PARTS, so a payment split between two artists answers yes for both — testing
// the family root alone hid every split child from an artist-filtered report.
const namesArtist = (r, a) => !!(r.matched_expense_id || r.matched_income_id)
  && (r.direction === 'credit'
    ? artistEq(txnArtist(r), a)
    : txnParts(r).some((p) => artistEq(p.artist, a)));

// Apportion a row's USD across its parts. The LAST part takes the remainder, so
// the parts always re-add to the row exactly — never total rounded pieces
// (a P&L built out of independently rounded shares drifts a cent per split).
//
// Returned aligned with `parts`: a caller wanting a subset sums the entries it
// selected. Apportioning a SUBSET would hand the remainder to the wrong part and
// report a $600 slice of a $1,000 payment as $1,000.
const splitUsd = (usd, parts) => {
  const out = [];
  let left = round2(usd);
  parts.forEach((p, i) => {
    const v = i === parts.length - 1 ? left : round2(usd * p.share);
    left = round2(left - v);
    out.push(v);
  });
  return out;
};

// ── Grouping artists for the spend-by-artist report ─────────────────────────
//
// Same rule as the rest of the app: strip everything that isn't alphanumeric and
// lower-case, so "3ee"/"3EE", "Feel Trip"/"feel trip" and "LIFE/LINE"/"LIFELINE"
// are one artist. Mirrors `normalizeArtistKey` in client/src/utils.js and the
// `normalize_artist_key(TEXT)` SQL function in index.js — three copies of one
// regex, which is unfortunate but structural: the client groups in JS, Postgres
// groups in SQL, and this runs in JS over rows already fetched. Keep them
// identical.
//
// Deliberately NOT `artistEq` above. That is LOWER(TRIM()) only, which merges
// case but not punctuation — it is the right rule for "is this row the artist
// the filter asked for" and the wrong one for "how many artists are there".
// On the live ledger this stricter key collapses 197 raw spellings to 127.
// Moved to lib/artist-key.js (2026-08-18) so routes/statements.js can ask the same
// question. It could not before: its needsArtist() tested emptiness alone, so a row
// holding "unknown" was attributed on the vendor page and unattributed here.

// Same form as lib/statement-extras.js and lib/statement-pdf.js. Local rather than
// imported: those are statement-parsing modules and this route has no other reason
// to depend on them.
//
// Restored 2026-08-18 — it sat INSIDE the block that moved to lib/artist-key.js and
// went with it. `node --check` passed and the router loaded; /reports/spend-by-artist
// then 500'd with "round2 is not defined" the first time a fixture called it. A
// deleted runtime identifier is invisible to both of those checks.
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// ── Which below-the-line categories Spend by Artist shows as "Advances" ──
//
// ONE definition, because it has two readers that must agree: the rollup in
// buildPnl that fills the column, and the artist drill that opens a cell in it.
// Two copies of a money predicate is the shape that put the Reports 'unverified'
// rule in three places, and this file's whole arrangement exists to stop a drill
// disagreeing with the cell it was opened from.
//
// EQUALITY on the name, never substring. A RENAME of this category would empty
// the column, which is why `shapeAdvances` totals everything below the line that
// is NOT in here as `other_total` and the report discloses it.
const ADVANCE_CATEGORIES = new Set(['Advance']);

async function buildPnl(from, to, artist, opts = {}) {
  const months = monthsBetween(from, to);

  // An optional listing of the rows that landed in the label-level bucket.
  //
  // /bk/advertising has to show the individual charges making up the ad pool, and
  // nothing else does: `/pnl/detail` deliberately drops label-level rows, so the
  // only alternative would be a second query with its own idea of what
  // label-level means — the exact shape that put the Reports drill at $3.73M
  // against a report saying something else. Collecting HERE, at the one call site
  // that makes the decision, is what guarantees the page lists precisely the money
  // the pool says it holds.
  //
  // Off unless asked for, so no existing caller pays for it.
  const collectLL = Array.isArray(opts.collectLabelLevel) ? opts.collectLabelLevel : null;

  // STATEMENTS ARE THE MASTER: every non-dismissed bank row counts exactly
  // once; the ledger contributes categories, artists, and FX — never a
  // second copy of the money. Ledger-paid entries with no bank evidence are
  // reported separately and NOT counted.
  const basis = basisParam(opts.basis) || 'bank';
  let rows = await rowsFor(from, to, basis);
  const unfilteredRows = rows;
  if (artist) rows = rows.filter((r) => namesArtist(r, artist));

  // REVERSALS ARE NOT EVENTS. A payment that bounced and came back is one
  // non-event with two legs; counting either side states money that never
  // moved. Removed BEFORE dismissals so a reversed row is reported as reversed
  // rather than as somebody's judgment call — they're different facts with
  // different fixes (restore a dismissal vs. there was never a payment).
  //
  // This is deliberately not left to the dismissal chore. The flag says
  // "unmatch it, then dismiss both sides"; when that second step is skipped the
  // debit keeps counting with nothing downstream to notice. On 2026-08-06 that
  // was 7 pairs and $326,434.43 of overstated expense, including a $250,000
  // transfer and the $70,929.68 Venable payment.
  // Reversal pairing works on REAL dates and is untouched by month
  // reassignment — a payment and its refund pair on when the money actually
  // moved, not on where it is reported. One consequence worth knowing: a row
  // reassigned into this range from a month outside the reversal window is not
  // checked for a reversal here. That errs toward under-excluding, which leaves
  // the old (overstated) figure standing rather than removing real money —
  // the same fail-safe direction reversalExclusions is documented to take.
  const { ids: reversedIds, pairs: reversalPairList } = await reversalExclusions(from, to);
  const reversedRows = rows.filter((r) => reversedIds.has(r.id));
  rows = rows.filter((r) => !reversedIds.has(r.id));

  // Report dismissals are removed from the counted set, but bucketed the same
  // way so the page can disclose exactly what was excluded and from where.
  // Never silently report a smaller number.
  //
  // Two grains, both landing in the same `dismissed` summary:
  //   item     — this specific transaction (flagged on the row by bankRows)
  //   category — a standing rule excluding the whole P&L line
  const catKeys = await dismissedCategoryKeys();
  const inDismissedCategory = (r) => catKeys.size > 0 && catKeys.has(
    r.direction === 'credit'
      ? cellKeyOf('income', txnIncomeType(r))
      : cellKeyOf('expense', txnCategory(r)));
  const dismissedRows = rows.filter((r) => r.report_dismissed || inDismissedCategory(r));
  rows = rows.filter((r) => !r.report_dismissed && !inDismissedCategory(r));

  // Reassigned rows, for disclosure. movedIn is counted (in a different column
  // than its bank date); movedOut has left the report altogether.
  //
  // movedOut is bank-wide even under an artist filter, the same way `coverage`
  // is. Scoping it would mean an artist view could hide money that left the
  // report, which is the one thing this disclosure exists to prevent.
  const movedIn = rows.filter((r) => r.moved_from);
  const movedOut = await movedOutOfRange(from, to);

  const income = {};
  const incomeBelow = {};
  const incomeNonRec = {};
  const expenses = {};
  const expensesBelow = {};
  const expensesNonRec = {};
  // What each contra recovery took off which line — disclosure, so a netted
  // figure can still be shown gross. Without it "Marketing 1,900,109" is
  // unverifiable: you can't tell it from 1,900,109 of gross spend.
  const contraApplied = {};

  const cls = await reportSections();
  const bucketFor = (section, kind) => {
    if (kind === 'income') {
      return section === 'below_line' ? incomeBelow : section === 'non_recurring' ? incomeNonRec : income;
    }
    return section === 'below_line' ? expensesBelow : section === 'non_recurring' ? expensesNonRec : expenses;
  };
  const add = (bucket, line, key, v) => {
    bucket[line] = bucket[line] || {};
    bucket[line][key] = (bucket[line][key] || 0) + v;
  };

  // ── Spend by artist ──────────────────────────────────────────────────────
  //
  // Accumulated in THIS loop, off the same `rows` and the same `usd`, rather
  // than re-derived by a second endpoint. That is the entire reconciliation
  // guarantee: a parallel query would have to re-apply reversal removal,
  // dismissals (both grains), month reassignment, FX and contra netting, and
  // any future change to one of those would silently desynchronise the two
  // totals. Here, artists + unattributed sums to expenseTotals.total by
  // construction.
  //
  // Scope is OPERATING expense only, matching expenseTotals — advances and
  // other below-the-line items are excluded, as is non-recurring. Contra
  // recoveries subtract, exactly as they do from the line they offset.
  // ── What backs the reported figures ──────────────────────────────────────
  //
  // STATEMENTS ARE THE MASTER (see buildPnl's header): every bank row counts
  // once, and the ledger supplies its category, artist and FX. So a category on
  // this report is only as good as whatever explains its bank row — and for most
  // of the money that is an entry the app INVENTED from the bank line itself,
  // with no invoice behind it. Bank Matching reports that ratio as a percentage;
  // here it is MONEY, on the page where money is read, because "Royalties
  // $250,000" reads like a fact and is a guess made from a bank descriptor.
  //
  // NOT a double count: an invoice with no bank row is disclosed by `unverified`
  // and never counted, so the same payment cannot land twice.
  //
  // Accumulated in THIS loop for exactly the reason bumpArtist is, and it used
  // to be the counter-example: a second pass over `rows` further down, counting
  // EVERY debit. So the panel summed $5,399,907.97 under a table reporting
  // $3,305,898.53 — the difference being $2,018,635.32 of below-the-line spend
  // the report excludes and $75,374.12 of contra recoveries it nets off. Three
  // chips adding to 163% of the report, each a percentage of a total the reader
  // could not see, under a heading reading "share of reported spend".
  //
  // Now it follows the same money the lines above do: operating section only,
  // split parts at their own share, contra recoveries subtracting. So
  // invoice + invented + none === expense_totals.total, by construction.
  //
  // What leaves the panel is still named — below_line and non_recurring ride
  // along so the client can say where the rest of the money went.
  const evidence = { invoice: 0, invented: 0, none: 0, invoice_n: 0, invented_n: 0, none_n: 0,
    below_line: 0, non_recurring: 0 };
  // Which of the three a row's categorisation actually rests on. A credit is
  // judged on its OWN record — an artist_income row is a real one, the same
  // class as an invoice — rather than falling into "nothing at all" merely for
  // having no expense id.
  const evidenceOf = (r) => {
    if (r.direction === 'credit') return r.matched_income_id ? 'invoice' : 'none';
    if (!r.matched_expense_id) return 'none';
    return r.m_entry_source === 'bank_statement' ? 'invented' : 'invoice';
  };

  // Spend that bills the LABEL rather than a release — ad platforms, measured to
  // carry no artist evidence at all. A THIRD bucket, so `by_artist.total` still
  // equals the P&L expense total and ties_to_pnl holds; only the coverage
  // denominator changes, and it is disclosed.
  const labelRules = await loadLabelLevelRules(pool);
  // The name a vendor rule is compared against — the booked entry's payee first,
  // because that is what the queue and the vendor pages show, falling back to the
  // bank's own guess.
  const payeeOf = (r) => r.m_payee || r.payee_guess || r.description || '';
  const labelLevel = { cats: {}, total: 0, count: 0 };
  const bumpLabelLevel = (cat, v) => {
    labelLevel.cats[cat] = (labelLevel.cats[cat] || 0) + v;
    labelLevel.total += v;
    labelLevel.count += 1;
  };
  // ── Advances, per artist ────────────────────────────────────────────────
  // An advance is below the line — it is recoupable money, not trading spend —
  // so it is deliberately outside `expenseTotals` and outside `byArtist`. But it
  // is also the single largest ARTIST-ATTRIBUTABLE outflow the label makes
  // ($1,482,835 Jan–Jul 2026, 74% of it already naming an artist), and Spend by
  // Artist showed none of it. So it gets its own rollup, kept apart from
  // operating spend rather than folded into it: `by_artist.total` still equals
  // the P&L expense total by construction, and the report can show both numbers
  // without either hiding the other.
  //
  // EQUALITY on the category name, never substring — the rule this repo learned
  // from "TONE" being inside "Tone Pay, Inc". Which means a RENAME of this
  // category would silently empty the column, so anything below the line that is
  // NOT in this set is totalled as `other_total` and disclosed. A number that
  // walks away shows up there instead of just vanishing.
  const byArtistAdv = {};
  const advOther = { total: 0, cats: {} };
  const bumpAdvance = (rawArtist, cat, v) => {
    if (!ADVANCE_CATEGORIES.has(String(cat || '').trim())) {
      advOther.total += v;
      advOther.cats[cat] = (advOther.cats[cat] || 0) + v;
      return;
    }
    const k = artistBucketKey(rawArtist);
    const slot = byArtistAdv[k] || (byArtistAdv[k] = { names: {}, cats: {}, total: 0 });
    const raw = String(rawArtist || '').trim();
    if (k && raw) slot.names[raw] = (slot.names[raw] || 0) + 1;
    slot.cats[cat] = (slot.cats[cat] || 0) + v;
    slot.total += v;
  };

  const byArtist = {};
  const bumpArtist = (rawArtist, cat, v) => {
    const k = artistBucketKey(rawArtist);
    const slot = byArtist[k] || (byArtist[k] = { names: {}, cats: {}, total: 0 });
    // Remember spellings so the display name can be the most common variant,
    // the same way Recoupments picks one.
    const raw = String(rawArtist || '').trim();
    if (k && raw) slot.names[raw] = (slot.names[raw] || 0) + 1;
    slot.cats[cat] = (slot.cats[cat] || 0) + v;
    slot.total += v;
  };

  for (const r of rows) {
    // report_month, NOT ym(txn_date) — bankRows has already applied any month
    // reassignment. Bucketing on the raw date here would put a moved row back
    // in the month the P&L says it left, and the drill (which reads the same
    // field) would then disagree with the cell it was opened from.
    const key = r.report_month;
    const usd = txnUsd(r);

    if (r.direction === 'credit') {
      const type = txnIncomeType(r);
      // Unclassified credits sit below the line — an unbooked drawdown must
      // not read as operating revenue until someone says what it is.
      if (type === UNORGANIZED_IN) { add(incomeBelow, type, key, usd); continue; }

      // A RECOVERY nets against the expense it recovers rather than being
      // reported as revenue. An advance refund reverses the advance; a
      // marketing reimbursement gives back marketing spend. Booking either as
      // income grosses both sides up and leaves a reader unable to prove there
      // is no double count.
      //
      // The offset lands in whichever section the TARGET expense lives in, so a
      // refund of a below-line advance stays below the line rather than
      // reappearing above it.
      const contra = cls.contraOf('income', type);
      if (contra) {
        const targetSection = cls.section('expense', contra);
        add(bucketFor(targetSection, 'expense'), contra, key, -usd);
        contraApplied[contra] = contraApplied[contra] || { total: 0, from: {} };
        contraApplied[contra].total += usd;
        contraApplied[contra].from[type] = (contraApplied[contra].from[type] || 0) + usd;
        // A recovery reduces an artist's spend by the same amount it reduces
        // the line. Omitting it would overstate every artist who was refunded.
        if (targetSection === 'operating') {
          // A rule never overrides a real attribution: if somebody named an
          // artist on this row, that stands. It only speaks where the question
          // is otherwise unanswered.
          if (!artistBucketKey(txnArtist(r)) && labelRules.has(payeeOf(r), contra)) {
            bumpLabelLevel(contra, -usd);
            // Negative, and collected like any other: a refund of ad spend REDUCES
            // the pool, and a listing that omitted it would not add up to the total
            // it sits under.
            if (collectLL) collectLL.push({ txn_id: r.id, date: r.txn_date, month: key,
              expense_id: null, payee: payeeOf(r), description: r.description || null,
              category: contra, usd: -usd, share: 1, direction: 'credit' });
          }
          else bumpArtist(txnArtist(r), contra, -usd);
          // …and it reduces what has to be backed by anything, by the same
          // amount, or the panel would describe gross spend under a net figure.
          evidence[evidenceOf(r)] -= usd;
        } else if (targetSection === 'below_line') {
          evidence.below_line -= usd;
          // Net, like the line it sits on. The P&L reports advances net of
          // refunds ($1,482,835 against a gross $1,505,835 — $23,000 of money
          // that came back), and a column that reported gross while its own
          // section reported net would be two numbers for one fact.
          bumpAdvance(txnArtist(r), contra, -usd);
        } else evidence.non_recurring -= usd;
        continue;
      }
      add(bucketFor(cls.section('income', type), 'income'), type, key, usd);
    } else {
      // One part unless this payment was split across artists or categories, in
      // which case each part carries its own labels and its own share of the
      // money. The row still counts exactly once: splitUsd re-adds to `usd`.
      const parts = txnParts(r);
      const amounts = splitUsd(usd, parts);
      const evClass = evidenceOf(r);
      // Counted ONCE per row even when it is split across several operating
      // categories — the chips count payments, not parts. A row split across
      // sections lands its money in both and its count in whichever it reaches.
      let evCounted = false;
      parts.forEach((p, i) => {
        // Under an artist filter a split payment contributes only the parts that
        // artist is named on — the row passed the filter because ONE part named
        // them, not because the whole payment was theirs.
        if (artist && !artistEq(p.artist, artist)) return;
        const sec = cls.section('expense', p.cat);
        add(bucketFor(sec, 'expense'), p.cat, key, amounts[i]);
        if (sec === 'operating') {
          if (!artistBucketKey(p.artist) && labelRules.has(payeeOf(r), p.cat)) {
            bumpLabelLevel(p.cat, amounts[i]);
            // The PART, not the payment: a charge already split across campaigns
            // contributes only the slices still nobody's, which is exactly what is
            // left to allocate.
            if (collectLL) collectLL.push({ txn_id: r.id, date: r.txn_date, month: key,
              expense_id: p.id, root_id: r.matched_expense_id || null,
              payee: payeeOf(r), description: r.description || null,
              category: p.cat, usd: amounts[i], share: p.share, direction: 'debit' });
          }
          else bumpArtist(p.artist, p.cat, amounts[i]);
          evidence[evClass] += amounts[i];
          if (!evCounted) { evidence[`${evClass}_n`] += 1; evCounted = true; }
        } else if (sec === 'below_line') {
          evidence.below_line += amounts[i];
          bumpAdvance(p.artist, p.cat, amounts[i]);
        } else evidence.non_recurring += amounts[i];
      });
    }
  }

  // Visibility, not counting: Paid ledger families no bank row vouches for.
  // Through the shared definition, so the drill and the search list exactly the
  // rows this band counts — including its dismissal filter, which is why this
  // no longer loads dismissedExpenseIds() a second time here.
  // "Paid in the ledger, no bank line" is a bank-basis question only: on the
  // ledger bases those rows ARE the report.
  const { rows: unverifiedRows, dismissed_count: unverifiedDismissed } = basis === 'bank'
    ? await unverifiedLedgerRows({
      from, to, artist,
      cols: `r.id, r.payment_date, COALESCE(r.currency,'USD') AS currency, r.fx_rate_to_usd`,
    })
    : { rows: [], dismissed_count: 0 };
  const unverifiedSeries = {};
  let unverifiedTotal = 0;
  for (const m of months) unverifiedSeries[m] = 0;
  for (const r of unverifiedRows) {
    const key = ym(r.payment_date);
    if (unverifiedSeries[key] === undefined) continue;
    const v = usdOf(r.family_total, r.currency, r.fx_rate_to_usd);
    unverifiedSeries[key] += v;
    unverifiedTotal += v;
  }

  const sumSeries = (byKey) => {
    const series = {};
    let total = 0;
    for (const m of months) series[m] = 0;
    for (const perMonth of Object.values(byKey)) {
      for (const [k, v] of Object.entries(perMonth)) {
        if (series[k] !== undefined) { series[k] += v; total += v; }
      }
    }
    return { series, total };
  };
  const incomeTotals = sumSeries(income);
  const expenseTotals = sumSeries(expenses);
  const incomeBelowTotals = sumSeries(incomeBelow);
  const expenseBelowTotals = sumSeries(expensesBelow);
  const incomeNonRecTotals = sumSeries(incomeNonRec);
  const expenseNonRecTotals = sumSeries(expensesNonRec);
  const net = {};
  const belowNet = {};
  const nonRecNet = {};
  for (const m of months) {
    net[m] = (incomeTotals.series[m] || 0) - (expenseTotals.series[m] || 0);
    belowNet[m] = (incomeBelowTotals.series[m] || 0) - (expenseBelowTotals.series[m] || 0);
    nonRecNet[m] = (incomeNonRecTotals.series[m] || 0) - (expenseNonRecTotals.series[m] || 0);
  }

  // Reconciliation coverage per month (bank-wide, not artist-scoped): a
  // month with unmatched bank debits has invisible expenses — the client
  // marks those columns as likely incomplete.
  // Coverage: how much of each month's real spend has a ledger entry explaining
  // it. Derived from the SAME rows the report counts — `rows` is already
  // deduped, reversal-free, dismissal-free and FX-converted.
  //
  // It used to be its own SQL aggregate over the entire bank_transactions table
  // with no WHERE, no dedupe, no FX and none of the report's exclusions. That
  // put money the report deliberately ignores into the denominator: March read
  // 19% covered / 294 open while including a $250,000 reversed transfer, and
  // $326,434 of reversed debits sat in the denominator overall. Below 85% the
  // client marks a month "likely incomplete", so the badge was accusing the
  // books of gaps that were really returned payments.
  //
  // A reversed payment now leaves the numerator AND the denominator, which is
  // the honest treatment: it isn't spend, so it can't be unexplained spend.
  // ── Per-artist amounts drawn out of the ad pool ──────────────────────────
  //
  // The charges carry no artist evidence — that is why the pool exists — but a
  // person knows what the ads were for, and this is where that knowledge lands.
  // Applied AFTER the row loop, so it draws from a pool that is already settled,
  // and it MOVES money: the artist's total rises, the pool's falls, the P&L is
  // untouched and by_artist.total still ties to it.
  const allocation = applyAllocations(
    await loadAllocations(pool, months),
    labelLevel,
    (artist, cat, amount) => bumpArtist(artist, cat, amount),
  );

  const coverage = {};
  //
  // Built from the UNFILTERED population on purpose. Coverage describes how
  // complete the books are for a month, which is a fact about the month, not
  // about whichever artist is selected. Using the artist-filtered set would
  // report 100% for every artist, because that filter keeps only matched rows.
  const coverageRows = unfilteredRows.filter((r) => !reversedIds.has(r.id)
    && !r.report_dismissed && !inDismissedCategory(r));
  for (const m of months) coverage[m] = { live: 0, covered: 0, open_n: 0 };
  for (const r of coverageRows) {
    if (r.direction !== 'debit') continue;
    // report_month, matching the P&L columns. The coverage badge renders on a
    // column header, so it has to describe the column it sits on — bucketing a
    // reassigned row by its bank date would put the warning above a month whose
    // figures don't include it.
    const key = r.report_month;
    if (!coverage[key]) continue;
    const usd = txnUsd(r);
    coverage[key].live += usd;
    if (r.matched_expense_id) coverage[key].covered += usd;
    else coverage[key].open_n += 1;
  }
  for (const m of months) {
    const c = coverage[m];
    // NULL, not 100, when the month holds no bank debits at all. "100%
    // reconciled" and "no statement uploaded yet" are opposite facts, and the
    // fallback reported the second as the first: August — the current month,
    // no statement, the largest unverified ledger balance of the year — read as
    // a clean 100% column, as did every future month.
    //
    // The client has ALWAYS handled this (Reports.jsx, the month header: grey
    // dot + "No bank statement data for this month — expenses unverified"). It
    // was simply never reachable, because the server never sent it.
    coverage[m] = c.live > 0
      ? { pct: Math.round((c.covered / c.live) * 100), open_n: c.open_n }
      : null;
  }

  // Category usage for the review deck's 1-9 numbering. Voided rows don't vote
  // and the window is 12 months, matching statements.js so the two decks can't
  // rank the same categories differently.
  const { rows: usageRows } = await pool.query(`
    SELECT TRIM(category) AS category, COUNT(*)::int AS n FROM expenses
     WHERE category IS NOT NULL AND status = 'approved'
       AND (deleted = false OR deleted IS NULL)
       AND (voided = false OR voided IS NULL)
       AND COALESCE(payment_date, invoice_date, created_at::date) > (CURRENT_DATE - INTERVAL '12 months')
     GROUP BY TRIM(category)`).catch(() => ({ rows: [] }));
  const categoryUsage = Object.fromEntries(usageRows.map((r) => [r.category, r.n]));

  // Artist list for the filter — case-insensitive dedupe, first spelling wins.
  const { rows: artistRows } = await pool.query(`
    SELECT TRIM(artist) AS a FROM expenses
     WHERE artist IS NOT NULL AND TRIM(artist) <> ''
       AND status = 'approved' AND (deleted = false OR deleted IS NULL)
    UNION
    SELECT TRIM(artist_name) FROM artist_income
     WHERE artist_name IS NOT NULL AND TRIM(artist_name) <> ''`);
  const seen = new Map();
  for (const r of artistRows) {
    const k = r.a.toLowerCase();
    if (!seen.has(k)) seen.set(k, r.a);
  }
  const artists = [...seen.values()].sort((a, b) => a.localeCompare(b));

  return {
    months, income, expenses,
    income_totals: incomeTotals, expense_totals: expenseTotals,
    net: { series: net, total: incomeTotals.total - expenseTotals.total },
    below: {
      income: incomeBelow, expenses: expensesBelow,
      income_totals: incomeBelowTotals, expense_totals: expenseBelowTotals,
      net: { series: belowNet, total: incomeBelowTotals.total - expenseBelowTotals.total },
    },
    // One-off asset dispositions, kept out of Net Income. A $350k catalog sale
    // otherwise makes its month read as the best trading month of the year, and
    // anyone building a run-rate has to strip it out by hand — better the
    // statement does it for them, and says it did.
    non_recurring: {
      income: incomeNonRec, expenses: expensesNonRec,
      income_totals: incomeNonRecTotals, expense_totals: expenseNonRecTotals,
      net: { series: nonRecNet, total: incomeNonRecTotals.total - expenseNonRecTotals.total },
    },
    // Recoveries netted into expense lines, so a netted figure can still be
    // read gross. { 'Marketing': { total, from: { 'Marketing Reimbursement': n } } }
    contra: contraApplied,
    unverified: {
      series: unverifiedSeries, total: unverifiedTotal, count: unverifiedRows.length,
      dismissed_count: unverifiedDismissed,
    },
    // How much of the reported spend has an actual invoice behind it. Not a
    // double count — statements are the master here, so every payment is counted
    // once; this says how much of it we can PROVE, and how much is categorised
    // from an entry the app invented off a bank descriptor.
    evidence: {
      invoice: round2(evidence.invoice), invoice_n: evidence.invoice_n,
      invented: round2(evidence.invented), invented_n: evidence.invented_n,
      none: round2(evidence.none), none_n: evidence.none_n,
      // Debits this panel does NOT describe, because the table above doesn't
      // either. Named rather than dropped: the money is real, it is just
      // reported below the line.
      below_line: round2(evidence.below_line),
      non_recurring: round2(evidence.non_recurring),
    },
    dismissed: summarizeDismissed(dismissedRows, months, catKeys),
    reversals: summarizeReversals(reversedRows, reversalPairList, months),
    // Month reassignments. `moved` is disclosure only — those rows ARE counted,
    // just in a different column than their bank date. `moved_out` is the one
    // that matters: those rows have left the report entirely, and sumSeries
    // drops unknown month keys without complaint, so nothing else on the page
    // would ever mention the money again.
    reassigned: {
      count: movedIn.length,
      total: movedIn.reduce((s, r) => s + Math.abs(txnUsd(r)), 0),
      moved_out: {
        count: movedOut.length,
        total: movedOut.reduce((s, r) => s + Math.abs(r.usd), 0),
        rows: movedOut,
      },
    },
    coverage, artists, artist: artist || null,
    // Same contract as the statements deck: its review deck numbers 1-9 by how
    // often a category is actually chosen, so a number means one thing in both
    // places. Counted over the whole approved ledger here — this deck
    // recategorises any P&L row, not only bank bookings.
    category_usage: categoryUsage,
    basis, basis_label: BASIS_LABEL[basis],
    // Ranked operating spend per artist, plus the unattributed remainder.
    // `by_artist.total` equals expenseTotals.total by construction — see
    // bumpArtist. `/reports/spend-by-artist` serves this slice; the P&L page
    // doesn't render it, but computing it here is a loop over rows already in
    // memory, and one code path is worth more than the few bytes.
    by_artist: shapeByArtist(byArtist, expenseTotals.total, labelLevel, allocation),
    // Below-the-line advances per artist, on the same artist key as `by_artist`
    // so the two merge row-for-row. Its own object, because it is its own basis.
    advances_by_artist: shapeAdvances(byArtistAdv, advOther),
  };
}

// The advance rollup, shaped like `by_artist` so a sheet can zip them together.
// Keyed on `artistBucketKey`, which is what folds "Feel Trip" and "feel trip"
// (separately $200,000 and $50,000 on the live ledger) into one artist.
function shapeAdvances(byArtistAdv, advOther) {
  const bestName = (names) => Object.entries(names)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
  const un = byArtistAdv[''] || { cats: {}, total: 0, names: {} };
  const artists = Object.entries(byArtistAdv)
    .filter(([k]) => k !== '')
    .map(([key, v]) => ({
      key,
      name: bestName(v.names) || key,
      spellings: Object.keys(v.names).sort(),
      total: round2(v.total),
    }))
    .sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : 1));
  const attributedRaw = artists.reduce((s, a) => s + a.total, 0);
  return {
    artists,
    by_key: Object.fromEntries(artists.map((a) => [a.key, a.total])),
    unattributed: round2(un.total),
    attributed_total: round2(attributedRaw),
    total: round2(attributedRaw + un.total),
    // Below-the-line spend this column does NOT cover — partner draws,
    // reimbursements, and anything that lands here because the advance category
    // was renamed. Disclosed so the money cannot leave quietly.
    other_total: round2(advOther.total),
    other_by_category: Object.fromEntries(
      Object.entries(advOther.cats).map(([c, n]) => [c, round2(n)])),
  };
}

// Turn the accumulator into something a sheet can render: artists ranked by
// spend, each with its category split and its best display spelling, and the
// unattributed remainder called out rather than dropped.
function shapeByArtist(byArtist, expectedTotal, labelLevel = { cats: {}, total: 0, count: 0 },
  allocation = { applied: 0, trimmed: [], byArtist: {} }) {
  const bestName = (names) => Object.entries(names)
    // Most-used spelling wins; ties break alphabetically so the answer is
    // stable across runs. Same rule as Recoupments' bestSpelling.
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];

  const unattributed = byArtist[''] || { cats: {}, total: 0, names: {} };
  const artists = Object.entries(byArtist)
    .filter(([k]) => k !== '')
    .map(([key, v]) => ({
      key,
      name: bestName(v.names) || key,
      // Every spelling that merged into this row, so the sheet can show its
      // work and someone can go clean the ledger up.
      spellings: Object.keys(v.names).sort(),
      total: round2(v.total),
      by_category: Object.fromEntries(
        Object.entries(v.cats).map(([c, n]) => [c, round2(n)])),
    }))
    .sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : 1));

  // Every category appearing anywhere, ranked by size, so the sheet's columns
  // are ordered by materiality rather than by whichever artist came first.
  const catTotals = {};
  for (const v of Object.values(byArtist)) {
    for (const [c, n] of Object.entries(v.cats)) catTotals[c] = (catTotals[c] || 0) + n;
  }
  const categories = Object.entries(catTotals)
    .sort((a, b) => b[1] - a[1]).map(([c]) => c);

  // Totals come from the UNROUNDED accumulators, rounded once at the end.
  //
  // Rounding the parts and then adding them is what broke the tie-out check on
  // the first deploy: 794,507.18 + 2,581,773.09 = 3,376,280.27 against a true
  // 3,376,280.26, off by exactly one cent, and `ties_to_pnl` went false on a
  // report whose arithmetic was correct. The fix is to stop building a total out
  // of rounded pieces, not to widen the tolerance until the alarm stops.
  //
  // A consequence worth knowing: the DISPLAYED components can still be a cent
  // off the displayed total, because each is independently rounded to 2dp. That
  // is ordinary in financial reporting and is not what the tie check measures.
  const attributedRaw = artists.reduce((s, a) => s + a.total, 0);
  const unattributedRaw = unattributed.total;
  const labelRaw = labelLevel.total;
  // The P&L total, unchanged: label-level spend is still spent. It is a third
  // bucket, not an exclusion.
  const totalRaw = attributedRaw + unattributedRaw + labelRaw;
  return {
    artists,
    categories,
    unattributed: {
      total: round2(unattributedRaw),
      by_category: Object.fromEntries(
        Object.entries(unattributed.cats).map(([c, n]) => [c, round2(n)])),
    },
    // Spend a rule says bills the LABEL, not a release. Disclosed on its own so
    // the coverage figure beside it can mean "of the money that CAN name an
    // artist" without hiding anything.
    label_level: {
      // What is LEFT in the pool after allocations — the unallocated remainder.
      total: round2(labelRaw),
      count: labelLevel.count || 0,
      by_category: Object.fromEntries(
        Object.entries(labelLevel.cats).map(([c, n]) => [c, round2(n)])),
      // Money a person has assigned out of the pool to specific artists. It is
      // already IN their artist totals; this states how much of each artist's
      // figure came from an assignment rather than from a row naming them.
      allocated: round2(allocation.applied || 0),
      allocated_by_artist: Object.fromEntries(
        Object.entries(allocation.byArtist || {}).map(([a, n]) => [a, round2(n)])),
      // An allocation the pool could not fund in full — said out loud, because it
      // means the pool shrank under an assignment somebody already made.
      trimmed: allocation.trimmed || [],
    },
    attributed_total: round2(attributedRaw),
    total: round2(totalRaw),
    // Share of ATTRIBUTABLE operating spend that names an artist — label-level
    // spend is out of the denominator, because no amount of work would put an
    // artist on it and a percentage that can never reach 100 is one people stop
    // reading. `coverage_pct_of_all` keeps the old, harsher reading beside it so
    // nothing is hidden by the change.
    coverage_pct: (attributedRaw + unattributedRaw)
      ? round2(100 * attributedRaw / (attributedRaw + unattributedRaw)) : 0,
    coverage_pct_of_all: totalRaw ? round2(100 * attributedRaw / totalRaw) : 0,
    // Self-check travelling with the payload: if this is ever false the report
    // has drifted from the P&L and must not be presented. Compared on the raw
    // sums — same additions as expenseTotals in a different order, so only float
    // non-associativity separates them, well inside half a cent.
    ties_to_pnl: Math.abs(totalRaw - Number(expectedTotal || 0)) < 0.005,
    pnl_expense_total: round2(expectedTotal),
  };
}

// Disclosure for reversal pairs, same contract as summarizeDismissed: an
// exclusion that MOVES A REPORTED TOTAL has to say so on the page. Venable's
// search total drops from $125,929.68 to $55,000.00 — correct, but a number
// that shrinks with no explanation is its own kind of wrong.
//
// Counts only what was actually removed from THIS period's counted set. A pair
// whose credit leg was already dismissed contributes its debit alone, which is
// exactly the money the report was overstating.
function summarizeReversals(reversedRows, pairs, months) {
  const series = {};
  for (const m of months) series[m] = 0;
  let debitTotal = 0;
  let creditTotal = 0;
  const byCell = {};
  for (const r of reversedRows) {
    const usd = txnUsd(r);
    if (r.direction === 'debit') {
      debitTotal += usd;
      const cellKey = `expense:${txnCategory(r)}`;
      byCell[cellKey] = byCell[cellKey] || { count: 0, usd: 0 };
      byCell[cellKey].count += 1;
      byCell[cellKey].usd += usd;
      const mk = ym(r.txn_date);
      if (series[mk] !== undefined) series[mk] += usd;
    } else {
      creditTotal += usd;
    }
  }
  const shown = new Set(reversedRows.map((r) => r.id));
  return {
    count: reversedRows.length,
    // The headline: expense the report would otherwise have overstated.
    total: debitTotal,
    credit_total: creditTotal,
    series,
    by_cell: byCell,
    pairs: pairs
      .filter((p) => shown.has(p.debit.id) || shown.has(p.credit.id))
      .map((p) => ({
        debit_id: p.debit.id,
        credit_id: p.credit.id,
        txn_date: ymd(p.debit.txn_date),
        reversed_on: ymd(p.credit.txn_date),
        gap_days: p.gapDays,
        amount: Number(p.debit.amount),
        payee: p.debit.payee_guess || p.credit.payee_guess || null,
        description: p.debit.description || null,
        // The debit still points at an invoice, so the ledger reports that bill
        // paid with money that came back. Surfaced here because the P&L is where
        // someone will notice; the fix is on the statements flag.
        still_matched_expense_id: p.debit.matched_expense_id || null,
      })),
  };
}

// Disclosure for report dismissals: the total excluded, plus a per-cell
// breakdown keyed the same way the P&L buckets are ('expense:Marketing',
// 'income:Publishing'), so each cell can show its own excluded amount and
// the header can show the aggregate. Uses the same txnUsd / txnCategory /
// txnIncomeType helpers as the counted path — a dismissed foreign-currency
// row converts identically to how it would have counted.
function summarizeDismissed(dismissedRows, months, catKeys = new Set()) {
  const byCell = {};
  const series = {};
  for (const m of months) series[m] = 0;
  let total = 0;
  // Lines excluded wholesale, kept separate from item-level exclusions: the UI
  // says "2 lines and 5 items excluded", because those are different actions
  // with different fixes (restore a rule vs restore a transaction).
  const categoryCells = {};
  for (const r of dismissedRows) {
    const usd = txnUsd(r);
    const kind = r.direction === 'credit' ? 'income' : 'expense';
    const key = r.direction === 'credit' ? txnIncomeType(r) : txnCategory(r);
    const cellKey = `${kind}:${key}`;
    byCell[cellKey] = byCell[cellKey] || { count: 0, usd: 0 };
    byCell[cellKey].count += 1;
    byCell[cellKey].usd += usd;
    if (catKeys.has(cellKeyOf(kind, key))) {
      categoryCells[cellKey] = categoryCells[cellKey] || { kind, key, count: 0, usd: 0 };
      categoryCells[cellKey].count += 1;
      categoryCells[cellKey].usd += usd;
    }
    const mk = ym(r.txn_date);
    if (series[mk] !== undefined) series[mk] += usd;
    total += usd;
  }
  const categories = Object.values(categoryCells);
  const categoryTotal = categories.reduce((s, c) => s + c.usd, 0);
  return {
    count: dismissedRows.length, total, series, by_cell: byCell,
    // A dismissed line with no transactions in range still exists as a rule,
    // so the count comes from the rule set, not from what happened to appear.
    categories, category_count: catKeys.size, category_total: categoryTotal,
    item_count: dismissedRows.length - categories.reduce((s, c) => s + c.count, 0),
  };
}

// Drill-down: the bank transactions behind one P&L cell (category/type ×
// month, or the row total when no month is given). Same master, same
// dedupe, same filters as buildPnl — the modal total must equal the cell.
// kind='unverified' drills the not-counted ledger row instead.
async function pnlDetail({ kind, key, keys, month, from, to, artist, drillCategory, basis = 'bank' }) {
  const artistKeySet = keys && keys.length ? new Set(keys) : null;
  let lo = from, hi = to;
  if (month) {
    lo = `${month}-01`;
    const [y, m] = month.split('-').map(Number);
    hi = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  }

  if (kind === 'unverified') {
    if (basis !== 'bank') return { rows: [], total: 0, row_count: 0, truncated: false, basis };
    // The SAME definition the band uses. This branch used to carry its own copy
    // of the predicate without the multi-invoice-link correction, so it listed
    // five payments the band did not count and disagreed with the cell it was
    // opened from by $3,865.16.
    const { rows } = await unverifiedLedgerRows({
      from: lo, to: hi, artist,
      cols: `r.id, r.payee, r.artist, r.song, r.invoice_number, r.payment_date,
             COALESCE(r.currency,'USD') AS currency, r.fx_rate_to_usd`,
      orderBy: 'ORDER BY r.payment_date, r.id',
    });
    const out = rows.map((r) => ({
      id: r.id, date: r.payment_date, payee: r.payee, artist: r.artist, song: r.song,
      invoice_number: r.invoice_number, usd: usdOf(r.family_total, r.currency, r.fx_rate_to_usd),
      amount: r.family_total, currency: r.currency,
      expense_id: r.id,
    }));
    await withFileFlags(out);
    // row_count, like every other drill kind. Its absence rendered as
    // "undefined rows" wherever the client reports the size of a cell.
    return { rows: out, total: out.reduce((s, r) => s + r.usd, 0), row_count: out.length, truncated: false };
  }

  let rows = await rowsFor(lo, hi, basis);
  if (artist) rows = rows.filter((r) => namesArtist(r, artist));
  // Same exclusion as buildPnl, or the drill-down total wouldn't equal the cell
  // it was opened from — the failure mode this whole file is arranged to avoid.
  const { ids: drillReversed } = await reversalExclusions(lo, hi);
  rows = rows.filter((r) => !drillReversed.has(r.id));
  // Section/contra classification, shared by the artist and expense branches.
  const clsD = await reportSections();
  // Same rules buildPnl applies, so the list and the cell describe one set.
  const drillLabels = await loadLabelLevelRules(pool);
  const drillPayee = (r) => r.m_payee || r.payee_guess || r.description || '';
  if (kind === 'artist') {
    // Drilling an ARTIST cell (optionally narrowed to one category column).
    //
    // The filter mirrors bumpArtist in buildPnl line for line, because a drill
    // whose total disagrees with the cell it was opened from is worse than no
    // drill: operating section only, debits positive, and contra recoveries
    // included as NEGATIVES because that is how they entered the artist total.
    //
    // Grouped by artistBucketKey, NOT the artistEq used by the `artist` query
    // param above. artistEq is LOWER(TRIM()) — it would miss "NOVA  BLAZE"
    // against a "novablaze" bucket and quietly under-report the cell.
    // `keys` (plural) drills a SET of artists — the collapsed "Other artists
    // (N)" row on the report, which is a real cell with a real total and so
    // has to be openable like any other. Falls back to the single key.
    const inCell = (bk) => (artistKeySet ? artistKeySet.has(bk) : bk === key);
    // Operating, as always — PLUS the one below-line category Spend by Artist now
    // shows in its own column, and only when that column's cell is what was
    // clicked. Without the `drillCategory` test an artist's row-total drill would
    // start including advances and stop matching the Total it was opened from;
    // with it, the Advances cell opens its own rows and nothing else moves.
    const sectionAllowed = (cat) => {
      const sec = clsD.section('expense', cat);
      if (sec === 'operating') return true;
      return sec === 'below_line' && !!drillCategory
        && ADVANCE_CATEGORIES.has(drillCategory) && cat === drillCategory;
    };
    rows = rows.filter((r) => {
      if (r.direction === 'credit') {
        if (!inCell(artistBucketKey(txnArtist(r)))) return false;
        const contra = clsD.contraOf('income', txnIncomeType(r));
        // Plain income never touches an expense line, so it is not this
        // artist's spend and must not appear here.
        if (!contra || !sectionAllowed(contra)) return false;
        if (drillCategory && contra !== drillCategory) return false;
        r.__recovery = true;
        return true;
      }
      // A split payment lands in this cell for the PARTS that name this artist,
      // and brings only their share of the money with it — same arithmetic as
      // bumpArtist, so the drill still totals to the cell it was opened from.
      const parts = txnParts(r);
      const amounts = splitUsd(txnUsd(r), parts);
      const mine = parts.map((p) => inCell(artistBucketKey(p.artist))
        && sectionAllowed(p.cat)
        && (!drillCategory || p.cat === drillCategory)
        // Label-level spend has left the unattributed BUCKET, so it leaves the
        // unattributed LIST too — otherwise the queue offers rows the report no
        // longer counts and the band above it stops matching what it opens. Only
        // the '' cell is affected: a named artist still owns its own row.
        && !(artistBucketKey(p.artist) === '' && drillLabels.has(drillPayee(r), p.cat)));
      if (!mine.some(Boolean)) return false;
      r.__partUsd = round2(amounts.reduce((s, v, i) => (mine[i] ? s + v : s), 0));
      r.__partCats = [...new Set(parts.filter((p, i) => mine[i]).map((p) => p.cat))];
      // The ledger rows behind THIS cell's share, so it can be relabelled
      // without touching the rest of the payment.
      r.__partIds = parts.filter((p, i) => mine[i]).map((p) => p.id).filter(Boolean);
      // The artist THIS cell is about, not the family root's — on a split
      // payment the row is listed under the artist whose share it carries.
      r.__partArtist = parts.find((p, i) => mine[i])?.artist ?? null;
      return true;
    });
  } else if (kind === 'income') {
    rows = rows.filter((r) => r.direction === 'credit' && txnIncomeType(r) === key);
  } else {
    // Expense cell. A contra RECOVERY belongs here too, as a negative.
    //
    // buildPnl nets recoveries off the line they recover — a Marketing
    // Reimbursement reduces Marketing — but this drill only ever collected
    // debits, so the cell and its drill disagreed by exactly the recovery.
    // Measured on a fixture: a $1,000 spend with a $250 reimbursement showed a
    // $750 cell and a $1,000 drill, presenting money the report had already
    // netted away. Same rule as the artist branch above.
    rows = rows.filter((r) => {
      if (r.direction === 'debit') {
        // Only the parts booked to THIS category, at their share of the payment
        // — a $1,000 debit split $600 Marketing / $400 Royalties belongs in both
        // cells, for $600 and $400, never for $1,000 in each.
        const parts = txnParts(r);
        const amounts = splitUsd(txnUsd(r), parts);
        const mine = parts.map((p) => p.cat === key);
        if (!mine.some(Boolean)) return false;
        r.__partUsd = round2(amounts.reduce((s, v, i) => (mine[i] ? s + v : s), 0));
        r.__partIds = parts.filter((p, i) => mine[i]).map((p) => p.id).filter(Boolean);
        return true;
      }
      if (clsD.contraOf('income', txnIncomeType(r)) !== key) return false;
      r.__recovery = true;
      return true;
    });
  }
  // Excluded from the list AND the total, so the modal total keeps equalling
  // the cell it drilled from. The cell shows the excluded amount separately.
  //
  // BOTH grains, or the drill contradicts the report it was opened from. This
  // used to test only `report_dismissed`, so a line under a standing category
  // rule — absent from the P&L, disclosed as excluded — drilled to its FULL
  // amount with `dismissed: 0`, presenting excluded money as counted. Measured
  // at $3,730,000 on Drawdown Fund alone.
  const catKeys = await dismissedCategoryKeys();
  // An artist cell spans MANY categories, so "is this whole line dismissed"
  // doesn't apply to it — but each row still has to be tested against the
  // standing category rules individually, exactly as buildPnl does. Without
  // this an artist drill would include money the report excluded.
  const inDismissedCat = (r) => catKeys.size > 0 && catKeys.has(
    r.direction === 'credit'
      ? cellKeyOf('income', txnIncomeType(r))
      : cellKeyOf('expense', txnCategory(r)));
  const wholeLineDismissed = kind !== 'artist'
    && catKeys.has(cellKeyOf(kind === 'income' ? 'income' : 'expense', key));
  const cellDismissed = rows.filter((r) =>
    r.report_dismissed || wholeLineDismissed || (kind === 'artist' && inDismissedCat(r)));
  rows = wholeLineDismissed ? [] : rows.filter((r) =>
    !r.report_dismissed && !(kind === 'artist' && inDismissedCat(r)));
  rows.sort((a, b) => (ymd(a.txn_date) < ymd(b.txn_date) ? -1 : 1));
  const out = rows.map((r) => ({
    id: r.id, date: r.txn_date,
    payee: (r.direction === 'credit'
      ? (r.m_income_desc || r.payee_guess || r.description)
      : (r.m_payee || r.payee_guess || r.description)) || '—',
    artist: r.__partArtist ?? txnArtist(r), song: r.m_song || null,
    invoice_number: r.m_invoice || null, source: r.filename,
    // A recovery reduced this artist's spend, so it subtracts here too —
    // matching how it entered the artist total in buildPnl.
    //
    // `__partUsd` is this cell's SHARE of a split payment (set by the filters
    // above); without a split it is the whole row, so unsplit rows are
    // unchanged. `amount` stays the full debit — that is what left the bank, and
    // `split_of` says so rather than leaving the two silently disagreeing.
    usd: r.__recovery ? -txnUsd(r) : (r.__partUsd ?? txnUsd(r)),
    is_recovery: !!r.__recovery,
    split_of: (!r.__recovery && r.__partUsd !== undefined
      && Math.abs(r.__partUsd - txnUsd(r)) > 0.005) ? round2(txnUsd(r)) : null,
    split_categories: r.__partCats && r.__partCats.length > 1 ? r.__partCats : null,
    amount: r.amount, currency: r.currency,
    // Recategorize hooks: the ledger/income record behind this row, or
    // the bare txn id when nothing is booked yet (book-from-reports).
    txn_id: r.id, expense_id: r.matched_expense_id || null, income_id: r.matched_income_id || null,
    // The ledger row(s) this CELL is about. On an unsplit row it is the single
    // `expense_id`; on a split payment it is only the part(s) whose share is
    // counted here, which is what an edit from this row may touch. An artist cell
    // can own two parts of one payment (two categories, same artist) — then there
    // is no single part to act on and the client says so instead of picking.
    part_expense_ids: r.__partIds?.length ? r.__partIds : null,
    // Is this row's category read off a real invoice, or off an entry the app
    // invented from the bank line? The drill showed neither, so a booked row and
    // an invoice-backed one were indistinguishable — and this page is where
    // someone decides whether a category is trustworthy.
    //
    // 'invoice' · 'invented' · 'none', the same three states Bank Matching uses.
    evidence: !r.matched_expense_id ? 'none'
      : r.m_entry_source === 'bank_statement' ? 'invented'
      : 'invoice',
    match_method: r.match_method || null,
    flagged: r.flagged || false,
    // The month this row is REPORTED in, and where it came from if it was
    // reassigned — the drill shows the real bank date, so without moved_from a
    // row would appear to be filed under the wrong month with no explanation.
    report_month: r.report_month, moved_from: r.moved_from || null,
  }));
  // The total covers every row; only the returned LIST is capped. withFileFlags
  // detoasts base64 invoice blobs per row, so an uncapped full-year drill on
  // "Unorganized" could pull thousands of multi-MB columns to render a list
  // nobody scrolls. Capping after the sum keeps the modal total equal to the
  // cell it drilled from.
  const DRILL_CAP = 500;
  // The total still NETS the recoveries — the cell and its drill have to agree,
  // and that agreement is what this file is arranged around.
  const total = out.reduce((s, r) => s + r.usd, 0);
  // But a deposit is not an expense row. Five of them sat among 500 Marketing
  // payments as negatives — TAC RECORDS, LVRN, WISE, 1/B1, MARKET.ST — which reads
  // as money going out. They come out of the list and are reported as their own
  // line, which the client can expand; the arithmetic is unchanged either way.
  const recoveryRows = out.filter((r) => r.is_recovery);
  const expenseRows = out.filter((r) => !r.is_recovery);
  const shownRows = expenseRows.slice(0, DRILL_CAP);
  await withFileFlags(shownRows);
  return {
    rows: shownRows,
    total,
    // Netted off the total above, listed separately so the reader can see what
    // came back without reading it as spend.
    recoveries: {
      count: recoveryRows.length,
      total: Math.round(recoveryRows.reduce((s, r) => s + r.usd, 0) * 100) / 100,
      rows: recoveryRows,
    },
    row_count: expenseRows.length,
    // Every expense id the cell covers, UNCAPPED — ints only, so none of the
    // detoasting cost that forced the cap on `rows`. Lets a bulk action work
    // the whole cell (569 rows) instead of only the 500 on screen, and it
    // comes from the same query the user is looking at, so the write can never
    // cover a different set than the one they saw.
    all_expense_ids: [...new Set(expenseRows.map((r) => r.expense_id).filter(Boolean))],
    truncated: expenseRows.length > DRILL_CAP,
    dismissed: {
      count: cellDismissed.length,
      total: cellDismissed.reduce((s, r) => s + txnUsd(r), 0),
    },
  };
}

// Which documents the ledger entries behind a list of rows actually have.
//
// Deliberately NOT part of bankRows. The has-file test has to OR the R2 key with
// the legacy base64 column, and comparing `invoice_data != ''` detoasts the whole
// blob — fine for the few hundred rows a drill-down or search renders, ruinous
// across the thousands bankRows feeds into every P&L build. So this runs once,
// at the end, over the ids actually being displayed.
//
// Split families: the invoice usually hangs off the parent, so a child row falls
// back to its parent's file and reports the parent as file_entry_id. Same shape
// as the W9 cross-entry rule the rest of the app uses — the file belongs to the
// invoice, not to the slice of it you happened to click.
const FILE_FLAG_COLS = `id, parent_id, invoice_filename, proof_filename, receipt_filename,
  ((invoice_data IS NOT NULL AND invoice_data != '') OR invoice_r2_key IS NOT NULL) AS has_invoice,
  ((proof_data   IS NOT NULL AND proof_data   != '') OR proof_r2_key   IS NOT NULL) AS has_proof,
  (receipt_data  IS NOT NULL AND receipt_data != '') AS has_receipt`;

async function withFileFlags(rows) {
  const ids = [...new Set(rows.map((r) => r.expense_id).filter(Boolean))];
  if (!ids.length) return rows;
  const { rows: flagRows } = await pool.query(
    `SELECT ${FILE_FLAG_COLS} FROM expenses
      WHERE id = ANY($1::int[])
         OR id IN (SELECT parent_id FROM expenses WHERE id = ANY($1::int[]) AND parent_id IS NOT NULL)`,
    [ids]);
  const byId = new Map(flagRows.map((r) => [r.id, r]));
  const anyDoc = (e) => e && (e.has_invoice || e.has_proof || e.has_receipt);
  for (const r of rows) {
    const own = byId.get(r.expense_id);
    if (!own) continue;
    const src = anyDoc(own) ? own : (own.parent_id && anyDoc(byId.get(own.parent_id)) ? byId.get(own.parent_id) : own);
    r.file_entry_id = src.id;
    r.has_invoice = !!src.has_invoice;
    r.has_proof = !!src.has_proof;
    r.has_receipt = !!src.has_receipt;
    r.invoice_filename = src.invoice_filename || null;
    r.proof_filename = src.proof_filename || null;
    r.receipt_filename = src.receipt_filename || null;
  }
  return rows;
}

// ── Balance-sheet exclusions ────────────────────────────────────────────────
//
// Whole lines ('bs_line', keyed by BS_LINE below) and individual rows
// ('bs_item', keyed by a namespaced ref). Deliberately separate scopes from the
// P&L's 'item'/'category' so neither can ever see the other's rules.
//
// ADVISORY, like every other exclusion loader in this file: on error these
// degrade to "nothing excluded" and log. The balance sheet renders unexcluded
// rather than 500-ing, because an optional feature must not be able to take a
// financial statement down.
const BS_LINE = {
  AR: 'accounts_receivable',
  AP: 'accounts_payable',
  DRAWDOWNS: 'drawdowns',
  // The whole Funded-by section. Unlike every other key here this one moves NO
  // figure — the block is derived FROM Net Assets and doesn't feed it, so
  // hiding it is presentation only. It is deliberately kept out of the
  // `excluded` totals for that reason; see buildBalanceSheet.
  FUNDING: 'funding',
  cash: (account) => `cash:${String(account || '').toLowerCase()}`,
};
// Namespaced: A/R is boom_invoices, A/P is expenses, drawdowns are
// artist_income. Bare ids from three tables would collide.
const bsRef = (kind, id) => `${kind}:${id}`;

async function bsExcludedLines() {
  try {
    const { rows } = await pool.query(
      "SELECT cell_key FROM report_dismissals WHERE scope = 'bs_line'");
    return new Set(rows.map((r) => String(r.cell_key).trim().toLowerCase()));
  } catch (err) {
    console.error('balance-sheet line exclusions unavailable — reporting unexcluded:', err.message);
    return new Set();
  }
}

async function bsExcludedItems() {
  try {
    const { rows } = await pool.query(
      "SELECT bs_ref FROM report_dismissals WHERE scope = 'bs_item' AND bs_ref IS NOT NULL");
    return new Set(rows.map((r) => r.bs_ref));
  } catch (err) {
    console.error('balance-sheet item exclusions unavailable — reporting unexcluded:', err.message);
    return new Set();
  }
}

/**
 * The earliest date a balance sheet can be produced for.
 *
 * Cash comes from statement closes, so before the first one there is no cash
 * figure at all — not zero, unknown. A sheet rendered for such a date would show
 * assets consisting only of receivables and read as a real, tiny balance sheet.
 * Refusing is the honest answer; see `balanceSheetFloor` throwing below.
 */
async function earliestBalanceSheetDate() {
  const { rows: [r] } = await pool.query(
    `SELECT MIN(period_end) AS first_close FROM bank_statements
      WHERE status = 'ready' AND ending_balance IS NOT NULL`);
  return r?.first_close ? ymd(r.first_close) : null;
}

class BalanceSheetRangeError extends Error {}

async function assertBalanceSheetDate(asOf) {
  const floor = await earliestBalanceSheetDate();
  if (floor && asOf < floor) {
    throw new BalanceSheetRangeError(
      `No balance sheet can be produced for ${asOf}. Cash is taken from bank statement closes and `
      + `the earliest one on file is ${floor}, so cash before that date is unknown — not zero. `
      + `Earliest supported date: ${floor}.`);
  }
}

async function buildBalanceSheet(asOf) {
  await assertBalanceSheetDate(asOf);

  // What a person has chosen to leave out of this statement. Loaded once and
  // applied throughout — every total, every aging bucket and the drill all read
  // the same two sets, so they cannot disagree about what is counted.
  const [exLines, exItems] = await Promise.all([bsExcludedLines(), bsExcludedItems()]);
  const lineOut = (key) => exLines.has(key);
  // Excluded amounts are tracked as they're removed, so the page can disclose
  // exactly what left rather than reporting a smaller number in silence.
  const excludedLines = [];
  let excludedItemTotal = 0;
  let excludedItemCount = 0;

  // Cash: latest ready statement per account with a captured ending balance,
  // period_end on or before the as-of date.
  const { rows: cashRows } = await pool.query(
    `SELECT DISTINCT ON (account) account, ending_balance, period_end, filename
       FROM bank_statements
      WHERE status = 'ready' AND ending_balance IS NOT NULL AND period_end <= $1
      ORDER BY account, period_end DESC`, [asOf]);
  const cashAll = cashRows.map((r) => ({
    account: r.account, balance: parseFloat(r.ending_balance),
    as_of: r.period_end, source: r.filename,
  }));
  const cash = cashAll.filter((c) => {
    if (!lineOut(BS_LINE.cash(c.account))) return true;
    excludedLines.push({ key: BS_LINE.cash(c.account), label: `Cash — ${String(c.account).toUpperCase()}`, total: c.balance });
    return false;
  });
  const cashTotal = cash.reduce((s, c) => s + c.balance, 0);

  // Composition of a line — "what is the $778k actually owed for".
  //
  // Built from the SAME filtered row array the line total is built from, never
  // from a separate query. That is the whole guarantee: the breakdown sums to
  // its line by construction, so the two can't drift the way a second query
  // eventually would. Item exclusions are therefore inherited for free — the
  // rows are already gone before this sees them.
  //
  // Sorted by value: on a list of 18 the useful ones have to be at the top, and
  // a stable order means the same sheet twice reads the same way.
  const breakdown = (rows, keyOf, usdOfRow) => {
    const by = new Map();
    for (const r of rows) {
      const key = String(keyOf(r) || '').trim() || '(uncategorised)';
      const cur = by.get(key) || { key, total: 0, count: 0 };
      cur.total += usdOfRow(r);
      cur.count += 1;
      by.set(key, cur);
    }
    return [...by.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  };

  // Aging buckets shared by A/R and A/P: days outstanding as of the report
  // date. 90+ is the "look at this" bucket.
  const agedBuckets = (rows, dateOf, usdOfRow) => {
    const aging = { current: 0, d60: 0, d90: 0, over90: 0 };
    let total = 0;
    const asOfMs = new Date(asOf).getTime();
    for (const r of rows) {
      const v = usdOfRow(r);
      total += v;
      const d = dateOf(r) ? Math.floor((asOfMs - new Date(dateOf(r)).getTime()) / 86400000) : 0;
      if (d <= 30) aging.current += v;
      else if (d <= 60) aging.d60 += v;
      else if (d <= 90) aging.d90 += v;
      else aging.over90 += v;
    }
    return { total, count: rows.length, aging };
  };

  // A/R: outbound invoices not yet paid, issued on or before as-of.
  //
  // CANNOT be restated to a past date, and says so. `boom_invoices` records
  // `payment_status` but NO payment date (server/index.js — the table has only
  // created_at), so there is no way to ask "was this outstanding then". An
  // invoice paid since is simply absent from every historical balance sheet.
  // Reported rather than silently wrong; fixing it needs a schema column.
  const { rows: arAll } = await pool.query(
    `SELECT id, amount, currency, created_at, bill_to FROM boom_invoices
      WHERE (payment_status IS DISTINCT FROM 'Paid') AND created_at::date <= $1`, [asOf]);
  // Item exclusions are applied BEFORE agedBuckets. Aging computed over rows
  // the total no longer contains would describe a different population than the
  // figure it sits under — the buckets would stop summing to the line.
  const arRows = arAll.filter((r) => {
    if (!exItems.has(bsRef('ar', r.id))) return true;
    excludedItemTotal += usdOf(r.amount, r.currency, null);
    excludedItemCount += 1;
    return false;
  });
  const ar = agedBuckets(arRows, (r) => r.created_at, (r) => usdOf(r.amount, r.currency, null));
  ar.breakdown = breakdown(arRows, (r) => r.bill_to, (r) => usdOf(r.amount, r.currency, null));
  ar.breakdown_label = 'client';
  ar.as_of_capable = false;
  ar.note = 'current unpaid invoices — boom_invoices has no payment date, so this cannot be restated to a past date';

  // A/P: what was actually owed ON the as-of date.
  //
  // This used to filter on the row's CURRENT payment_status, so anything paid
  // since vanished from the prior period: A/P at 2026-03-31 reported $7,789
  // against a true ~$232,753 — 141 invoices and $224,964 missing, a 97%
  // understatement that equity (a plug) silently absorbed. A bill is a liability
  // at as-of when it was invoiced by then and had not yet been paid by then.
  //
  // Rows marked Paid with NO payment_date can't be placed in time, so they stay
  // excluded (unchanged behaviour) and are counted separately rather than
  // quietly assumed. COALESCE on the date also closes the old `invoice_date IS
  // NULL` branch, which put undated bills into EVERY historical balance sheet.
  const { rows: apAll } = await pool.query(
    `SELECT id, amount, currency, fx_rate_to_usd, invoice_date, created_at, category FROM expenses
      WHERE status = 'approved'
        AND (deleted = false OR deleted IS NULL)
        AND (voided = false OR voided IS NULL)
        AND COALESCE(invoice_date, created_at::date) <= $1
        AND (payment_status IS DISTINCT FROM 'Paid' OR payment_date > $1)`, [asOf]);
  const apRows = apAll.filter((r) => {
    if (!exItems.has(bsRef('ap', r.id))) return true;
    excludedItemTotal += usdOf(r.amount, r.currency, r.fx_rate_to_usd);
    excludedItemCount += 1;
    return false;
  });
  const ap = agedBuckets(apRows, (r) => r.invoice_date || r.created_at, (r) => usdOf(r.amount, r.currency, r.fx_rate_to_usd));
  ap.breakdown = breakdown(apRows, (r) => r.category, (r) => usdOf(r.amount, r.currency, r.fx_rate_to_usd));
  ap.breakdown_label = 'category';
  const { rows: [undated] } = await pool.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::float AS total FROM expenses
      WHERE status = 'approved' AND payment_status = 'Paid' AND payment_date IS NULL
        AND (deleted = false OR deleted IS NULL) AND (voided = false OR voided IS NULL)
        AND COALESCE(invoice_date, created_at::date) <= $1`, [asOf]);
  ap.as_of_capable = true;
  if (undated && undated.n > 0) {
    ap.undated_paid = { count: undated.n, total: undated.total };
    ap.note = `${undated.n} paid bill(s) have no payment date and cannot be placed in time — excluded here`;
  }

  // ── Drawdowns are FUNDING, not debt ────────────────────────────────────────
  //
  // These used to sit in Liabilities, which made the sheet unreadable: $4.73M of
  // funding stacked next to $762k of unpaid invoices reported liabilities of
  // $5.49M and drove equity to −$4.63M, a number that described nothing.
  //
  // They aren't a liability. A payable is a specific bill to a specific vendor,
  // settled with cash on a due date. A drawdown is the money the business was
  // funded with, recovered out of earnings through recoupment rather than repaid.
  // Mixing the two makes "what do we owe" unanswerable. John's call, 2026-08-07.
  //
  // Still GROSS — repayments and recoupment aren't netted, because no
  // recoupment-to-date figures exist to net against (John's call, 2026-08-05).
  // The note says so rather than implying this is the outstanding balance.
  // Per-row rather than SUM(), so an individual drawdown can be excluded.
  const { rows: advAll } = await pool.query(
    `SELECT id, amount, artist_name, description FROM artist_income
      WHERE income_type = 'Drawdown Fund' AND income_date <= $1`, [asOf]);
  const advRows = advAll.filter((r) => {
    if (!exItems.has(bsRef('adv', r.id))) return true;
    excludedItemTotal += Number(r.amount || 0);
    excludedItemCount += 1;
    return false;
  });
  const drawdowns = {
    total: advRows.reduce((s, r) => s + Number(r.amount || 0), 0),
    count: advRows.length,
    // Artist where one is named, else the drawdown's own description — several
    // are facility-level and carry no artist at all.
    breakdown: breakdown(advRows, (r) => r.artist_name || r.description, (r) => Number(r.amount || 0)),
    breakdown_label: 'source',
    note: 'gross received — repayments/recoupment not yet netted',
  };

  // Recoupable spend, as a MEMO. Counted in nothing.
  //
  // This is what repays the drawdown, so a reader needs to know the pool exists.
  // It is deliberately not carried as an asset: that would require judging how
  // much is actually recoverable from future earnings, and the balance sheet
  // should not make that call on its own (John's call, 2026-08-07).
  //
  // FAMILY-AWARE, and that is not a detail. A split family's parent carries only
  // its own share — split-fee-reimb reduces the parent's `amount` — so summing
  // roots alone reports $6,465,831 against a true $6,572,891. Same
  // amount + children shape buildPnl's unverified query uses.
  const { rows: [rec] } = await pool.query(`
    SELECT COUNT(*)::int AS count,
           COALESCE(SUM(r.amount + COALESCE((SELECT SUM(c.amount) FROM expenses c
              WHERE c.parent_id = r.id AND (c.deleted = false OR c.deleted IS NULL)
                AND (c.voided = false OR c.voided IS NULL)), 0)), 0)::float AS total
      FROM expenses r
     WHERE r.parent_id IS NULL AND r.recoupable = true AND r.status = 'approved'
       AND (r.deleted = false OR r.deleted IS NULL)
       AND (r.voided = false OR r.voided IS NULL)
       AND COALESCE(r.payment_date, r.invoice_date, r.created_at::date) <= $1`, [asOf]);

  // Whole-line exclusions. Applied last, on the assembled lines, so a line that
  // is out contributes nothing to its section total while its detail (aging,
  // count, note) is still carried for the page to grey out.
  const arOut = lineOut(BS_LINE.AR);
  const apOut = lineOut(BS_LINE.AP);
  const ddOut = lineOut(BS_LINE.DRAWDOWNS);
  if (arOut) excludedLines.push({ key: BS_LINE.AR, label: 'Accounts Receivable', total: ar.total });
  if (apOut) excludedLines.push({ key: BS_LINE.AP, label: 'Accounts Payable', total: ap.total });
  if (ddOut) excludedLines.push({ key: BS_LINE.DRAWDOWNS, label: 'Drawdowns received', total: drawdowns.total });
  ar.excluded = arOut;
  ap.excluded = apOut;
  drawdowns.excluded = ddOut;

  const totalAssets = cashTotal + (arOut ? 0 : ar.total);
  const totalLiabilities = apOut ? 0 : ap.total;   // unpaid invoices, and nothing else
  const netAssets = totalAssets - totalLiabilities;
  const drawdownsCounted = ddOut ? 0 : drawdowns.total;
  // Of everything put in, how much has been consumed. Derived, so the block
  // below always sums — that is a PRESENTATION, not a proof, and the note says
  // so. The old equity line made the same admission and it still applies: a
  // figure that balances by construction can absorb an error silently, which is
  // exactly how a $225k A/P bug once went unnoticed here.
  const accumulatedDeficit = netAssets - drawdownsCounted;

  return {
    as_of: asOf,
    assets: { cash, cash_total: cashTotal, accounts_receivable: ar, total: totalAssets },
    liabilities: { accounts_payable: ap, total: totalLiabilities },
    net_assets: { total: netAssets, note: 'Assets − Liabilities' },
    // What a person left out. Every figure above is already net of these, and a
    // statement that quietly reports a smaller number is the failure this whole
    // file is arranged against — so the page is given the means to say so.
    excluded: {
      lines: excludedLines,
      line_count: excludedLines.length,
      line_total: excludedLines.reduce((s, l) => s + l.total, 0),
      item_count: excludedItemCount,
      item_total: excludedItemTotal,
      total: excludedLines.reduce((s, l) => s + l.total, 0) + excludedItemTotal,
    },
    funding: {
      // Presentation only. Deliberately NOT in `excluded` above: that block's
      // totals drive the "$X excluded from this balance sheet" banner, and
      // hiding this section removes no money. Folding it in would produce a
      // banner claiming $4.73M was excluded from a statement whose figures did
      // not move — worse than saying nothing, because it would be false.
      hidden: lineOut(BS_LINE.FUNDING),
      drawdowns,
      accumulated_deficit: { total: accumulatedDeficit,
        note: 'derived as Net Assets − Drawdowns, so this block always sums — a presentation, not a proof' },
      total: drawdownsCounted + accumulatedDeficit,
      memo: {
        recoupable: { total: rec.total, count: rec.count,
          note: 'recoupable artist spend submitted to date — shown for context, counted in nothing' },
      },
    },
    // DEPRECATED alias, kept for one release. A cached client bundle meeting
    // this server would otherwise read `bs.equity.total` and white-page the
    // whole report — the same hazard the reversal banner's `pairs || []` guards
    // against. Remove once the deployed bundle is known to read net_assets.
    equity: { total: netAssets, note: 'deprecated — use net_assets' },
    // Honesty (2026-09-20): four sources, no journal. This sheet cannot fail
    // to balance because nothing on it is double-entered — so it does not claim
    // to. Say where each figure comes from and what is unknown.
    proof: {
      balances: null,
      cash_known: cashAll.length > 0,
      note: cashAll.length
        ? 'Positions from four sources (statement balances, unpaid issued invoices, approved unpaid bills, drawdowns received). There is no journal, so this sheet cannot fail to balance and does not claim to; the funding block is derived, not proved.'
        : 'No bank statement has been uploaded, so cash is UNKNOWN — not zero. Receivables and payables come from the ledger; there is no journal, so nothing here is proved by balancing.',
      sources: [
        ...cashAll.map((c) => ({ line: `Cash — ${String(c.account).toUpperCase()}`, from: `statement ${c.source || ''} ending ${String(c.as_of).slice(0, 10)}`.trim(), as_of: String(c.as_of).slice(0, 10) })),
        { line: 'Accounts receivable', from: 'label-issued invoices not marked Paid (no payment date recorded, so as-of cannot be restated)', as_of: null },
        { line: 'Accounts payable', from: 'approved bills unpaid at the date, by invoice date', as_of: asOf },
        { line: 'Drawdowns received', from: 'artist_income rows of type Drawdown Fund', as_of: asOf },
      ],
    },
  };
}

router.get('/pnl', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const to = String(req.query.to || new Date().toISOString().slice(0, 10));
    const from = String(req.query.from || `${to.slice(0, 4)}-01-01`);
    const badRange = rangeProblem(from, to);
    if (badRange) return res.status(400).json({ success: false, error: badRange });
    const artist = String(req.query.artist || '').trim() || null;
    res.json({ success: true, data: await buildPnl(from, to, artist, { basis: basisParam(req.query.basis) }) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/reports/spend-by-artist?from=&to=
//
// Operating spend broken out per artist, for the executive view. Thin by design:
// it calls buildPnl and returns the slice buildPnl already computed inside its
// own accumulation loop, so this endpoint has no arithmetic of its own and
// cannot disagree with the P&L.
//
// Deliberately takes no `artist` param. Filtering to one artist here would be
// asking a ranked breakdown to show one row; use the P&L's artist filter for
// that, which is what it already does.
//
// `excluded` rides along because the total will look small to anyone who
// remembers the ledger's paid figure. It is smaller for four disclosed reasons —
// advances and other below-the-line items, person-dismissed rows, reversal pairs
// that never moved money, and Paid ledger rows no bank line vouches for. Sending
// them means the sheet can show the bridge instead of inviting the question.
router.get('/spend-by-artist', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const to = String(req.query.to || new Date().toISOString().slice(0, 10));
    const from = String(req.query.from || `${to.slice(0, 4)}-01-01`);
    const badRange = rangeProblem(from, to);
    if (badRange) return res.status(400).json({ success: false, error: badRange });
    const pnl = await buildPnl(from, to, null, { basis: basisParam(req.query.basis) });
    const adv = pnl.advances_by_artist || { by_key: {}, artists: [], total: 0, unattributed: 0, other_total: 0 };

    // Advances riding alongside operating spend, not inside it. `spend` keeps
    // tying to the P&L expense line; `advances` is below-the-line money the label
    // expects back; `total_out` is what the artist actually cost in cash.
    //
    // The union of both key sets, because an artist can have an advance and NO
    // operating spend — Mashbit is $194,000 of advance against a few thousand of
    // marketing, and keying off the operating rollup alone would have dropped
    // rows like that off a report about artist spend.
    const bySpendKey = new Map((pnl.by_artist?.artists || []).map((a) => [a.key, a]));
    const keys = [...new Set([...bySpendKey.keys(), ...Object.keys(adv.by_key)])];
    const advNames = new Map(adv.artists.map((a) => [a.key, a]));
    const artists = keys.map((key) => {
      const spendRow = bySpendKey.get(key);
      const advRow = advNames.get(key);
      const spend = spendRow?.total || 0;
      const advance = adv.by_key[key] || 0;
      return {
        key,
        name: spendRow?.name || advRow?.name || key,
        spellings: [...new Set([...(spendRow?.spellings || []), ...(advRow?.spellings || [])])].sort(),
        total: round2(spend),
        advances: round2(advance),
        total_out: round2(spend + advance),
        by_category: spendRow?.by_category || {},
      };
    }).sort((a, b) => b.total_out - a.total_out || (a.name < b.name ? -1 : 1));

    res.json({
      success: true,
      data: {
        from, to,
        basis: pnl.basis,
        ...pnl.by_artist,
        // Overrides the rollup's own `artists`: same rows, plus the advance
        // columns and the artists that only have an advance.
        artists,
        advances: {
          total: adv.total,
          attributed_total: adv.attributed_total,
          unattributed: adv.unattributed,
          artists: adv.artists,
          // Below-the-line spend the advance column does not cover — partner
          // draws and reimbursements. Stated, so `advances.total` plus this
          // equals the below-line expense total and nothing is unaccounted for.
          other_total: adv.other_total,
          other_by_category: adv.other_by_category,
        },
        // What the sheet's own bottom line adds up to, both bases named.
        total_out: round2((pnl.by_artist?.total || 0) + adv.total),
        excluded: {
          below_line:  round2(pnl.below?.expense_totals?.total || 0),
          dismissed:   { total: round2(pnl.dismissed?.total || 0), count: pnl.dismissed?.count || 0 },
          reversals:   { total: round2(pnl.reversals?.total || 0), count: pnl.reversals?.count || 0 },
          unverified:  { total: round2(pnl.unverified?.total || 0), count: pnl.unverified?.count || 0 },
          non_recurring: round2(pnl.non_recurring?.expense_totals?.total || 0),
        },
        coverage: pnl.coverage,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/reports/search?q=&from=&to=&artist=
//
// Find LINE ITEMS across the whole report, not report lines. The P&L payload is
// aggregated to category → month → amount and holds no payees, so the client
// filter can only ever match category names — typing a vendor like "Venable"
// against it returns nothing, which reads as "this vendor has no spend".
//
// Same master and same bucketing as buildPnl (bankRows → txnCategory /
// txnIncomeType / txnUsd), so every hit reports the exact cell it belongs to
// and clicking through lands on a drill whose total already agrees.
//
// Dismissed rows are INCLUDED and marked, deliberately: someone searching for a
// vendor needs to be told "it's here but excluded", not shown an empty result
// that implies the spend doesn't exist.
router.get('/search', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, data: { rows: [], total: 0, truncated: false } });
    const to = String(req.query.to || new Date().toISOString().slice(0, 10));
    const from = String(req.query.from || `${to.slice(0, 4)}-01-01`);
    const badRange = rangeProblem(from, to);
    if (badRange) return res.status(400).json({ success: false, error: badRange });
    const artist = String(req.query.artist || '').trim() || null;

    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    // Every term must appear somewhere in the row — "venable 6000" narrows.
    const hit = (fields) => {
      const hay = fields.filter((f) => f !== null && f !== undefined && f !== '')
        .map((f) => String(f).toLowerCase()).join('  ');
      return terms.every((t) => hay.includes(t));
    };

    let rows = await bankRows(from, to);
    if (artist) rows = rows.filter((r) => namesArtist(r, artist));
    const catKeys = await dismissedCategoryKeys();
    // Shown but not counted, like a dismissal — searching is how you find out
    // WHY a number is what it is, so a reversed payment disappearing entirely
    // would just move the confusion somewhere else.
    const { ids: searchReversed } = await reversalExclusions(from, to);

    const out = [];
    for (const r of rows) {
      const kind = r.direction === 'credit' ? 'income' : 'expense';
      const key = r.direction === 'credit' ? txnIncomeType(r) : txnCategory(r);
      const payee = (r.direction === 'credit'
        ? (r.m_income_desc || r.payee_guess || r.description)
        : (r.m_payee || r.payee_guess || r.description)) || '';
      if (!hit([payee, r.payee_guess, r.description, txnArtist(r), r.m_song, r.m_invoice,
        r.amount, txnUsd(r).toFixed(2), key, r.filename, ymd(r.txn_date)])) continue;
      out.push({
        id: r.id, txn_id: r.id,
        date: r.txn_date, payee: payee || '—',
        artist: txnArtist(r), song: r.m_song || null,
        invoice_number: r.m_invoice || null, source: r.filename,
        usd: txnUsd(r), amount: r.amount, currency: r.currency,
        expense_id: r.matched_expense_id || null, income_id: r.matched_income_id || null,
        // Which P&L cell this sits in, so the client can open it directly.
        // The REPORTED month: on the raw date, a reassigned hit would open a
        // cell that doesn't contain it.
        kind, key, month: r.report_month, moved_from: r.moved_from || null,
        // Excluded from the counted figures, but still shown — see above.
        dismissed: !!r.report_dismissed || catKeys.has(cellKeyOf(kind, key)),
        dismissed_reason: r.report_dismissed ? 'item' : (catKeys.has(cellKeyOf(kind, key)) ? 'line' : null),
        // A payment that bounced and came back. Not a judgment call like a
        // dismissal — the money never moved, so it is not spend.
        reversed: searchReversed.has(r.id),
      });
    }
    // ── The other places money can hide ───────────────────────────────────
    // Searching only the counted bank rows makes "no results" a lie: a payment
    // can be real and still absent from that set three different ways. If the
    // search can't see them, a vendor legitimately looks like it has no spend —
    // which is exactly the "I don't see Venable $35k" problem.
    //
    //   ledger-unverified  Paid on the ledger, no bank row vouches for it. The
    //                      P&L shows these but does NOT count them, so they're
    //                      invisible to a search over counted rows.
    //   unpaid             Approved but not paid. The P&L is cash basis, so
    //                      these are excluded BY DESIGN — correct for the
    //                      report, wrong to hide from a search.
    //
    // Each is tagged with its source and reported separately, never folded into
    // the counted total.
    const dismissedIds = await dismissedExpenseIds();
    const FAMILY_TOTAL = `r.amount + COALESCE((SELECT SUM(c.amount) FROM expenses c
        WHERE c.parent_id = r.id AND (c.deleted = false OR c.deleted IS NULL)
          AND (c.voided = false OR c.voided IS NULL)), 0)`;
    const LEDGER_BASE = `FROM expenses r
       WHERE r.parent_id IS NULL AND r.status = 'approved'
         AND (r.deleted = false OR r.deleted IS NULL)
         AND (r.voided = false OR r.voided IS NULL)
         ${artist ? 'AND LOWER(TRIM(r.artist)) = LOWER(TRIM($3))' : ''}`;
    const params = artist ? [from, to, artist] : [from, to];

    // The shared definition — the third copy of this predicate lived here, and
    // it was the one nobody would have thought to re-check: a search is where
    // you go to find out WHY a number is what it is, so listing a payment as
    // having no bank evidence when a bank line settles it sends the reader after
    // a problem that does not exist.
    const { rows: unverified } = await unverifiedLedgerRows({
      from, to, artist,
      cols: `r.id, r.payee, r.artist, r.song, r.invoice_number, r.category,
             r.payment_date AS date, COALESCE(r.currency,'USD') AS currency, r.fx_rate_to_usd`,
    });

    const { rows: unpaid } = await pool.query(`
      SELECT r.id, r.payee, r.artist, r.song, r.invoice_number, r.category,
             r.invoice_date AS date, COALESCE(r.currency,'USD') AS currency,
             r.fx_rate_to_usd, r.payment_status, ${FAMILY_TOTAL} AS family_total
        ${LEDGER_BASE}
         AND r.payment_status IS DISTINCT FROM 'Paid'
         AND r.invoice_date BETWEEN $1 AND $2`, params);

    const pushLedger = (list, source) => {
      for (const r of list) {
        if (dismissedIds.has(r.id)) continue;
        const usd = usdOf(r.family_total, r.currency, r.fx_rate_to_usd);
        if (!hit([r.payee, r.artist, r.song, r.invoice_number, r.category,
          r.family_total, usd.toFixed(2), ymd(r.date)])) continue;
        out.push({
          id: `${source}:${r.id}`, txn_id: null, expense_id: r.id,
          date: r.date, payee: r.payee || '—', artist: r.artist || null, song: r.song || null,
          invoice_number: r.invoice_number || null, source: null,
          usd, amount: r.family_total, currency: r.currency,
          kind: 'expense', key: r.category || 'Uncategorized', month: ym(r.date),
          // Neither is in the counted figures, for different reasons.
          dismissed: false, dismissed_reason: null, reversed: false,
          origin: source,
          payment_status: r.payment_status || 'Paid',
        });
      }
    };
    pushLedger(unverified, 'ledger-unverified');
    pushLedger(unpaid, 'unpaid');

    out.sort((a, b) => (ymd(a.date) < ymd(b.date) ? 1 : -1));

    // Group by cell so the UI can say "Legal — 2 items, $37,904.98". Only
    // counted bank rows contribute to a cell's money; the other sources are
    // reported by origin below.
    const cells = {};
    for (const r of out) {
      if (r.origin) continue;
      const ck = `${r.kind}:${r.key}`;
      cells[ck] = cells[ck] || { kind: r.kind, key: r.key, count: 0, usd: 0, dismissed: 0, reversed: 0 };
      cells[ck].count += 1;
      if (r.dismissed) cells[ck].dismissed += 1;
      else if (r.reversed) cells[ck].reversed += 1;
      else cells[ck].usd += r.usd;
    }
    // Why a match isn't in the numbers, so "found but not counted" is
    // distinguishable from "not found".
    const sumOf = (pred) => out.filter(pred).reduce((s, r) => s + r.usd, 0);
    // Mutually exclusive, in the same precedence the `cells` aggregation above
    // uses. Independent predicates summed a row that was BOTH dismissed and
    // reversed into both buckets, so counted + extras exceeded the population
    // and the "not counted" chip reported one row at twice its amount.
    const counted = (r) => !r.origin && !r.dismissed && !r.reversed;
    const isDismissed = (r) => !r.origin && r.dismissed;
    const isReversed = (r) => !r.origin && !r.dismissed && r.reversed;
    // Split by direction. Summing credits and debits into one figure produced a
    // headline that was neither spend nor income — a "refund" search reported
    // $27k of pure income under a label that reads as spend. The per-cell
    // `cells` array was always right; only the headline was not.
    const countedExpense = (r) => counted(r) && r.kind === 'expense';
    const countedIncome = (r) => counted(r) && r.kind === 'income';
    const breakdown = {
      counted: {
        n: out.filter(counted).length,
        usd: sumOf(counted),
        expense_usd: sumOf(countedExpense),
        income_usd: sumOf(countedIncome),
        expense_n: out.filter(countedExpense).length,
        income_n: out.filter(countedIncome).length,
      },
      dismissed: { n: out.filter(isDismissed).length, usd: sumOf(isDismissed) },
      reversed: { n: out.filter(isReversed).length, usd: sumOf(isReversed) },
      unverified: { n: out.filter((r) => r.origin === 'ledger-unverified').length, usd: sumOf((r) => r.origin === 'ledger-unverified') },
      unpaid: { n: out.filter((r) => r.origin === 'unpaid').length, usd: sumOf((r) => r.origin === 'unpaid') },
    };
    const CAP = 300;
    // Only the rows actually returned — no point detoasting blobs for matches
    // beyond the cap that nobody will see.
    const shown = out.slice(0, CAP);
    await withFileFlags(shown);
    res.json({
      success: true,
      data: {
        rows: shown,
        total: out.length,
        truncated: out.length > CAP,
        counted_total: breakdown.counted.usd,
        dismissed_count: breakdown.dismissed.n,
        reversed_count: breakdown.reversed.n,
        breakdown,
        cells: Object.values(cells).sort((a, b) => b.usd - a.usd),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/pnl/detail', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const kind = ['income', 'unverified', 'artist'].includes(req.query.kind) ? req.query.kind : 'expense';
    const key = String(req.query.key || '').slice(0, 100);
    // An artist drill may legitimately carry an EMPTY key — that is the
    // unattributed bucket, which is the largest cell on the report.
    if (!key && !['unverified', 'artist'].includes(kind)) {
      return res.status(400).json({ success: false, error: 'key required' });
    }
    const drillCategory = String(req.query.category || '').slice(0, 100) || null;
    // Comma-separated bucket keys for the collapsed-tail cell. Capped so a
    // hand-rolled URL can't turn one request into an unbounded filter.
    const keys = String(req.query.keys || '').split(',')
      .map((k) => k.trim()).filter(Boolean).slice(0, 500);
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : null;
    const to = String(req.query.to || new Date().toISOString().slice(0, 10));
    const from = String(req.query.from || `${to.slice(0, 4)}-01-01`);
    const badRange = rangeProblem(from, to);
    if (badRange) return res.status(400).json({ success: false, error: badRange });
    const artist = String(req.query.artist || '').trim() || null;
    const basis = basisParam(req.query.basis) || 'bank';
    const detail = await pnlDetail({ kind, key, keys, month, from, to, artist, drillCategory, basis });
    res.json({ success: true, data: { ...detail, basis } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── /bk/advertising — allocating ad-platform charges to campaigns ───────────
//
// The ad pool below this block moves REPORTED money and writes nothing to the
// ledger. Measured 2026-08-25: $267,674 of pool across Feb–Jul and ZERO
// allocations in six months, because it asks for a dollar figure per artist per
// month with no campaign, no charge list and no evidence attached — the guess is
// unfalsifiable, so nobody makes it. And because it never touches `expenses`, an
// allocation is invisible to Recoupments, the artist spend sheets and the
// recoupment audit, all of which read ledger rows.
//
// This is the ledger-side answer. A campaign is the basis; the write is a real
// split family; the slices are marked reviewed and recoupable, which is the
// supported way onto the recoupment surfaces (`withoutUnreviewedBankRows`).
//
// ── Bank is the money, Ads Manager is the basis ──
// Only real charges are ever apportioned, so there is no reconciliation
// remainder to park: an Ads export supplies PROPORTIONS and nothing else. The
// tie-out is therefore true by construction rather than by checking.
//
// ── What "unallocated" means, and why it comes from buildPnl ──
// A charge is in the pool because `label_level_spend_rules` says its vendor bills
// the label, AND no part of it names an artist (reports.js: `if
// (!artistBucketKey(p.artist) && labelRules.has(...))`). That test lives at one
// call site and this page lists exactly the rows it fired on, via
// `collectLabelLevel`. A second query with its own idea of label-level is the
// shape that once put the Reports drill at $3.73M against a report saying
// something else.
const AD_MONTH_RE = /^\d{4}-\d{2}$/;

// pg hands back a JS Date for DATE columns, and `String(aDate)` is
// "Tue May 04 2032 …" — so comparing those strings sorts by WEEKDAY NAME. That is
// not hypothetical: it put the 10th before the 4th here, and the greedy draw then
// consumed the wrong charge first. Same trap as `String(payment_date).slice(0,4)`
// returning "Mon ". Everything below orders on this.
const adDay = (d) => {
  if (!d) return '';
  if (d instanceof Date) {
    // The DAY it is, in the process timezone pg parsed it in — not toISOString(),
    // which would shift a local-midnight date back to the previous day.
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return String(d).slice(0, 10);
};

/**
 * One month of the ad pool: its charges, what is already allocated on each, and
 * the campaigns in play. Shared by the listing, the dry run and the write, so all
 * three agree about what is left by construction.
 */
async function adMonthState(month) {
  const collected = [];
  const pnl = await buildPnl(`${month}-01`, monthEnd(month), null, { collectLabelLevel: collected });
  // Debits only. A credit in the pool is a refund of ad spend — it reduces the
  // total and is reported, but there is nothing on it to allocate.
  const debits = collected.filter((x) => x.direction === 'debit' && x.root_id);
  const credits = collected.filter((x) => x.direction === 'credit');
  // ── charges this page has ALREADY finished ──
  // A fully-allocated charge is, by definition, no longer label-level: every slice
  // names an artist, so the collector never sees it. Listing only what the
  // collector returns therefore made a completed charge VANISH — and took its
  // allocation out of `allocated_cents` with it, so the page under-reported its
  // own work. Same failure as a band disagreeing with its list, which this repo
  // has shipped twice. Asking "which charges did we allocate in this month" is a
  // different and purely factual question, not a second opinion about what
  // label-level means.
  const { rows: doneRoots } = await pool.query(`
    SELECT DISTINCT COALESCE(e.parent_id, e.id) AS root
      FROM expenses e
     WHERE e.campaign_id IS NOT NULL
       AND TO_CHAR(e.payment_date, 'YYYY-MM') = $1
       AND (e.deleted IS NULL OR e.deleted = FALSE)
       AND (e.voided IS NULL OR e.voided = FALSE)`, [month]);

  const rootIds = [...new Set([
    ...debits.map((x) => x.root_id),
    ...doneRoots.map((r) => r.root),
  ])];
  // The ledger rows the label-level test actually fired on: the parts still
  // belonging to nobody. This set, not a re-derived predicate, is what "open"
  // means everywhere below.
  const openIds = new Set(debits.map((x) => x.expense_id).filter((x) => x != null));
  const usdByPart = new Map(debits.map((x) => [x.expense_id, x.usd]));

  let members = [];
  if (rootIds.length) {
    const { rows } = await pool.query(`
      SELECT e.id, e.parent_id, e.amount::float8 AS amount, COALESCE(e.currency,'USD') AS currency,
             e.fx_rate_to_usd, e.artist, e.song, e.category, e.campaign_id, e.payee,
             e.payment_date, e.payment_method, e.entry_source, e.release_id,
             e.recoup_reviewed, e.recoupable, e.invoice_date, e.description,
             e.status, e.approved_by, e.approved_at, e.payment_status,
             -- A member carrying a document must not be restructured: for the
             -- legacy receipt path that blob is the ONLY copy of the file.
             (e.receipt_data IS NOT NULL
               OR e.invoice_r2_key IS NOT NULL
               OR (e.invoice_data IS NOT NULL AND e.invoice_data <> '')) AS has_file,
             ic.name AS campaign_name
        FROM expenses e
        LEFT JOIN influencer_campaigns ic ON ic.id = e.campaign_id
       WHERE (e.id = ANY($1::int[]) OR e.parent_id = ANY($1::int[]))
         AND (e.deleted IS NULL OR e.deleted = FALSE)
         AND (e.voided IS NULL OR e.voided = FALSE)
       ORDER BY (e.parent_id IS NULL) DESC, e.id ASC`, [rootIds]);
    members = rows;
  }
  const famOf = new Map();
  for (const m of members) {
    const root = m.parent_id || m.id;
    if (!famOf.has(root)) famOf.set(root, []);
    famOf.get(root).push(m);
  }

  // One entry per charge, driven by the root ids — the union above — so a charge
  // with nothing left to allocate is still shown, with its allocations on it.
  const firstDebitOf = new Map();
  for (const d of debits) if (!firstDebitOf.has(d.root_id)) firstDebitOf.set(d.root_id, d);

  const charges = [];
  for (const rootId of rootIds) {
    const fam = famOf.get(rootId) || [];
    if (!fam.length) continue;
    const rootRow = fam.find((m) => !m.parent_id) || fam[0];
    // A finished charge has no collected part, so its identity comes off the
    // ledger row instead of off the bank row.
    const d = firstDebitOf.get(rootId) || {
      txn_id: null, date: rootRow.payment_date, month,
      payee: rootRow.payee, description: rootRow.description, category: rootRow.category,
      root_id: rootId,
    };
    const open = fam.filter((m) => openIds.has(m.id));
    const chargeCents = fam.reduce((s, m) => s + toCents(m.amount), 0);
    const openCents = open.reduce((s, m) => s + toCents(m.amount), 0);
    // Every reason a charge cannot be restructured, named rather than filtered
    // out — a page that silently omits a charge is a page whose total nobody can
    // reproduce.
    const blocked = [];
    if (rootRow.parent_id) blocked.push('family root missing');
    if (fam.some((m) => m.has_file)) blocked.push('a slice carries a document');
    if (open.length > 1) blocked.push(`${open.length} unattributed slices — split by hand, needs sorting out first`);
    if (!openCents) blocked.push('nothing unallocated');
    charges.push({
      root_id: rootId,
      txn_id: d.txn_id,
      date: d.date,
      month: d.month,
      payee: d.payee,
      description: d.description,
      category: d.category,
      currency: rootRow.currency || 'USD',
      charge_cents: chargeCents,
      open_cents: openCents,
      open_expense_id: open.length === 1 ? open[0].id : null,
      // What the P&L scores the open part at. Equal to `open_cents` for a booked
      // USD charge (the booking copies the bank amount), and deliberately shown
      // beside it rather than assumed: a foreign charge is allocated in its own
      // currency and reported in dollars.
      open_usd: round2(open.reduce((s, m) => s + (usdByPart.get(m.id) || 0), 0)),
      allocations: fam.filter((m) => m.campaign_id).map((m) => ({
        expense_id: m.id, campaign_id: m.campaign_id, campaign_name: m.campaign_name,
        artist: m.artist, song: m.song, cents: toCents(m.amount),
      })),
      // Named by somebody through the Reports drill rather than by this page.
      // Not ours to move, and counted so the arithmetic on screen adds up.
      attributed: fam.filter((m) => !m.campaign_id && String(m.artist || '').trim()).map((m) => ({
        expense_id: m.id, artist: m.artist, song: m.song, cents: toCents(m.amount),
      })),
      allocatable: blocked.length === 0,
      blocked,
    });
  }
  // Oldest first: John chose to work the backlog that way, and it is also what
  // makes the greedy draw in lib/ad-allocate.js deterministic. Ordered on `adDay`
  // — see the note on that helper for what String(aDate) does here.
  charges.sort((a, b) => adDay(a.date).localeCompare(adDay(b.date)) || a.root_id - b.root_id);

  const openTotal = charges.reduce((s, c) => s + c.open_cents, 0);
  const ll = pnl.by_artist?.label_level || {};
  return {
    month, charges, credits,
    open_cents: openTotal,
    allocatable_cents: charges.filter((c) => c.allocatable).reduce((s, c) => s + c.open_cents, 0),
    allocated_cents: charges.reduce((s, c) => s + c.allocations.reduce((t, a) => t + a.cents, 0), 0),
    // The pool as the REPORT states it, so the page can never quietly disagree
    // with the P&L it is drawing from.
    pool_usd: round2(Number(ll.total) || 0),
    open_usd: round2(charges.reduce((s, c) => s + c.open_usd, 0)),
    by_category: ll.by_category || {},
  };
}

// GET /ad-months?from=&to= — how much pool each month holds, so the page can open
// on the oldest month with money in it and show the backlog at a glance.
//
// ONE buildPnl over the whole range, grouped by the `month` the collector already
// stamps on each row — not a call per month (18 P&Ls would be unusable) and not a
// cheaper query of its own (that would be a second idea of what label-level means,
// and navigation drifting from money is how a page starts lying).
router.get('/ad-months', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? req.query.to
      : new Date().toISOString().slice(0, 10);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? req.query.from
      : `${Number(to.slice(0, 4)) - 2}-01-01`;
    const collected = [];
    await buildPnl(from, to, null, { collectLabelLevel: collected });
    const by = new Map();
    for (const c of collected) {
      if (!by.has(c.month)) by.set(c.month, { month: c.month, usd: 0, charges: 0 });
      const m = by.get(c.month);
      m.usd += c.usd;
      if (c.direction === 'debit') m.charges += 1;
    }
    const months = [...by.values()]
      .map((m) => ({ ...m, usd: round2(m.usd) }))
      .filter((m) => m.charges > 0)
      .sort((a, b) => a.month.localeCompare(b.month));
    res.json({ success: true, data: { from, to, months, total: round2(months.reduce((s, m) => s + m.usd, 0)) } });
  } catch (err) {
    console.error('GET /api/reports/ad-months:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /ad-charges?month=YYYY-MM — the pool, charge by charge, plus the campaigns.
router.get('/ad-charges', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const month = AD_MONTH_RE.test(String(req.query.month || '')) ? req.query.month : null;
    if (!month) return res.status(400).json({ success: false, error: 'month must be YYYY-MM' });

    const state = await adMonthState(month);

    // Campaigns dated in this month, plus any campaign already holding money from
    // it — a campaign run in June and paid for in July must not disappear from the
    // month whose charges funded it.
    const { rows: campaigns } = await pool.query(`
      SELECT ic.id, ic.name, ic.platform, ic.status, ic.campaign_date,
             ic.total_budget::float8 AS total_budget,
             ic.artist_id, ic.release_id,
             a.name AS artist, r.project_name AS song,
             COALESCE(al.cents, 0)::int AS allocated_cents,
             COALESCE(tot.cents, 0)::int AS allocated_cents_all_time
        FROM influencer_campaigns ic
        LEFT JOIN artists a  ON a.id = ic.artist_id
        LEFT JOIN releases r ON r.id = ic.release_id
        LEFT JOIN (
          SELECT e.campaign_id, ROUND(SUM(e.amount) * 100)::int AS cents
            FROM expenses e
           WHERE e.campaign_id IS NOT NULL
             AND (e.deleted IS NULL OR e.deleted = FALSE)
             AND (e.voided IS NULL OR e.voided = FALSE)
             AND TO_CHAR(e.payment_date, 'YYYY-MM') = $1
           GROUP BY e.campaign_id) al ON al.campaign_id = ic.id
        LEFT JOIN (
          SELECT e.campaign_id, ROUND(SUM(e.amount) * 100)::int AS cents
            FROM expenses e
           WHERE e.campaign_id IS NOT NULL
             AND (e.deleted IS NULL OR e.deleted = FALSE)
             AND (e.voided IS NULL OR e.voided = FALSE)
           GROUP BY e.campaign_id) tot ON tot.campaign_id = ic.id
       WHERE TO_CHAR(ic.campaign_date, 'YYYY-MM') = $1
          OR COALESCE(al.cents, 0) > 0
       ORDER BY a.name NULLS LAST, ic.name`, [month]);

    res.json({ success: true, data: { ...state, campaigns } });
  } catch (err) {
    console.error('GET /api/reports/ad-charges:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Resolve the requested allocations against a month, without writing.
 *
 * Returns the exact plan a write would perform, so `dry_run` and the apply share
 * one derivation — a preview computed differently from the write is a preview
 * that lies, and this page's whole safety story is that you approve what you see.
 */
async function planAdAllocation(month, requests) {
  const state = await adMonthState(month);
  const ids = [...new Set(requests.map((r) => r.campaign_id))];
  const { rows: camps } = await pool.query(`
    SELECT ic.id, ic.name, ic.platform, ic.release_id,
           a.name AS artist, r.project_name AS song
      FROM influencer_campaigns ic
      LEFT JOIN artists a  ON a.id = ic.artist_id
      LEFT JOIN releases r ON r.id = ic.release_id
     WHERE ic.id = ANY($1::int[])`, [ids]);
  const campById = new Map(camps.map((c) => [c.id, c]));
  const missing = ids.filter((i) => !campById.has(i));
  if (missing.length) {
    return { error: `Unknown campaign${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}` };
  }
  // A campaign with no artist cannot attribute anything, which is the entire
  // point of allocating. Refused here rather than writing a slice that names
  // nobody and looks allocated.
  const nameless = camps.filter((c) => !String(c.artist || '').trim());
  if (nameless.length) {
    return { error: `These campaigns have no artist, so allocating to them would attribute nothing: `
      + nameless.map((c) => c.name).join(', ') };
  }

  const allocatable = state.charges.filter((c) => c.allocatable);
  const draw = drawMany(
    allocatable.map((c) => ({ id: c.root_id, remaining_cents: c.open_cents })),
    requests.map((r) => ({ campaign_id: r.campaign_id, cents: r.cents })));

  if (draw.short_total > 0) {
    const blockedCents = state.charges.filter((c) => !c.allocatable)
      .reduce((s, c) => s + c.open_cents, 0);
    return {
      error: `${month} has ${fromCents(state.allocatable_cents).toFixed(2)} of unallocated ad charges`
        + ` — ${fromCents(requests.reduce((s, r) => s + r.cents, 0)).toFixed(2)} would over-allocate it by`
        + ` ${fromCents(draw.short_total).toFixed(2)}.`
        + (blockedCents > 0
          ? ` A further ${fromCents(blockedCents).toFixed(2)} is in charges that cannot be restructured.`
          : '')
        + ' Reduce the amount, or allocate from another month.',
      data: { allocatable: fromCents(state.allocatable_cents), short: fromCents(draw.short_total) },
    };
  }

  // Regroup by charge: one write per family, whatever it was drawn for.
  const byRoot = new Map();
  for (const p of draw.plan) {
    const c = campById.get(p.campaign_id);
    for (const s of p.slices) {
      if (!byRoot.has(s.id)) byRoot.set(s.id, []);
      byRoot.get(s.id).push({
        campaign_id: p.campaign_id, campaign_name: c.name,
        artist: c.artist, song: c.song || null, release_id: c.release_id || null,
        cents: s.cents,
      });
    }
  }
  const chargeById = new Map(state.charges.map((c) => [c.root_id, c]));
  const per_charge = [...byRoot.entries()].map(([root, slices]) => {
    const c = chargeById.get(root);
    const take = slices.reduce((s, x) => s + x.cents, 0);
    return {
      root_id: root, txn_id: c.txn_id, date: c.date, payee: c.payee, category: c.category,
      charge: fromCents(c.charge_cents), open_before: fromCents(c.open_cents),
      allocating: fromCents(take), open_after: fromCents(c.open_cents - take),
      whole_charge: take === c.open_cents,
      slices: slices.map((x) => ({ ...x, amount: fromCents(x.cents) })),
    };
  }).sort((a, b) => adDay(a.date).localeCompare(adDay(b.date)) || a.root_id - b.root_id);

  return {
    month,
    per_campaign: draw.plan.map((p) => ({
      campaign_id: p.campaign_id, campaign_name: campById.get(p.campaign_id).name,
      artist: campById.get(p.campaign_id).artist, song: campById.get(p.campaign_id).song || null,
      amount: fromCents(p.cents), charges: p.slices.length,
    })),
    per_charge,
    total: fromCents(draw.total),
    open_before: fromCents(state.allocatable_cents),
    open_after: fromCents(state.allocatable_cents - draw.total),
    state, byRoot, campById,
  };
}

// POST /ad-allocate
//   { month, campaign_id, amount, dry_run }                 one campaign
//   { month, allocations: [{campaign_id, amount}], dry_run } an import
//
// Writes a real split family per charge. The slices carry `entry_source`,
// `recoup_reviewed` and `recoupable` EXPLICITLY — see the header comment on the
// INSERT below, which is the reason this does not call POST /bk/entries/:id/split.
router.post('/ad-allocate', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const month = AD_MONTH_RE.test(String(req.body.month || '')) ? req.body.month : null;
    if (!month) return res.status(400).json({ success: false, error: 'month must be YYYY-MM' });

    const raw = Array.isArray(req.body.allocations) && req.body.allocations.length
      ? req.body.allocations
      : [{ campaign_id: req.body.campaign_id, amount: req.body.amount }];
    // Two rows for one campaign are one allocation — otherwise the second would
    // silently draw from what the first left and the campaign would show a total
    // nobody asked for.
    const merged = new Map();
    for (const r of raw) {
      const id = Number(r.campaign_id);
      const cents = toCents(Math.abs(Number(r.amount) || 0));
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ success: false, error: 'each allocation needs a campaign_id' });
      }
      if (cents <= 0) {
        return res.status(400).json({ success: false, error: 'each allocation needs an amount greater than zero' });
      }
      merged.set(id, (merged.get(id) || 0) + cents);
    }
    let requests = [...merged.entries()].map(([campaign_id, cents]) => ({ campaign_id, cents }));

    // ── proportional: an Ads Manager export ──
    // The file gives per-campaign SPEND, which will not equal the bank. Rather
    // than allocating the report's figures and parking a difference, its numbers
    // are treated as WEIGHTS and the month's actual charges are divided by them:
    // 100% of the real money is apportioned, so the tie-out holds by construction
    // and there is no remainder to explain. `apportion` is exact to the cent.
    if (req.body.proportional) {
      const state = await adMonthState(month);
      if (!state.allocatable_cents) {
        return res.status(400).json({ success: false,
          error: `${month} has no unallocated ad charges to apportion` });
      }
      const cents = apportion(state.allocatable_cents, requests.map((r) => r.cents));
      requests = requests.map((r, i) => ({ campaign_id: r.campaign_id, cents: cents[i] }))
        .filter((r) => r.cents > 0);
      if (!requests.length) {
        return res.status(400).json({ success: false,
          error: 'the weights given all resolve to zero — nothing to allocate' });
      }
    }

    const plan = await planAdAllocation(month, requests);
    if (plan.error) return res.status(400).json({ success: false, error: plan.error, data: plan.data || null });

    const publicPlan = {
      month: plan.month, per_campaign: plan.per_campaign, per_charge: plan.per_charge,
      total: plan.total, open_before: plan.open_before, open_after: plan.open_after,
    };
    if (req.body.dry_run) return res.json({ success: true, data: { ...publicPlan, dry_run: true } });

    const client = await pool.connect();
    const written = { charges: 0, slices: 0, expense_ids: [] };
    try {
      await client.query('BEGIN');
      for (const [root, slices] of plan.byRoot) {
        const charge = plan.state.charges.find((c) => c.root_id === root);
        const fam = await famRows(client, root);
        const openRow = fam.find((m) => m.id === charge.open_expense_id);
        if (!openRow) throw new Error(`charge ${root} has no single unallocated slice to draw from`);

        const take = slices.reduce((s, x) => s + x.cents, 0);
        const remainder = toCents(openRow.amount) - take;
        if (remainder < 0) throw new Error(`charge ${root} would be over-allocated`);

        let toInsert = slices;
        if (remainder > 0) {
          await client.query('UPDATE expenses SET amount = $1 WHERE id = $2', [fromCents(remainder), openRow.id]);
        } else {
          // Fully allocated: the row cannot be left at zero and cannot be deleted
          // when it is the family root, so it BECOMES the last slice. One fewer
          // child row, and the charge keeps its identity either way.
          const last = slices[slices.length - 1];
          toInsert = slices.slice(0, -1);
          await client.query(`
            UPDATE expenses
               SET amount = $1, artist = $2, song = $3, campaign_id = $4,
                   release_id = COALESCE($5, release_id),
                   recoupable = TRUE, recoup_reviewed = TRUE, recoup_reviewed_at = NOW(),
                   recoup_reviewed_by = $6, artist_campaign = 'Yes'
             WHERE id = $7`,
            [fromCents(last.cents), last.artist, last.song, last.campaign_id,
              last.release_id, req.user.id, openRow.id]);
          written.expense_ids.push(openRow.id);
        }

        for (const s of toInsert) {
          // ── Why this INSERT is here and not in POST /bk/entries/:id/split ──
          // Four columns the shared writer does not write, each load-bearing:
          //
          //   entry_source      inherited from the root. The shared writer omits
          //                     the column, so children come out NULL and read as
          //                     hand-entered invoices — the documented 88-row /
          //                     $55,470 leak onto the recoupment surfaces. Setting
          //                     it sends these rows through the designed gate
          //                     instead of that hole.
          //   recoup_reviewed   the gate itself. `withoutUnreviewedBankRows`
          //                     admits a bank-born row ONLY when this is true, so
          //                     without it John's "mark them reviewed and
          //                     recoupable" would write to columns nobody reads.
          //   recoupable        the answer that gate carries.
          //   campaign_id       the basis. A campaign's spend has to be a query.
          //
          // Teaching the shared writer these semantics would change behaviour for
          // Flags and the Reports drill, which call it for something else.
          const { rows: [ins] } = await client.query(`
            INSERT INTO expenses
              (invoice_date, payee, description, category, artist, song, amount,
               currency, payment_method, status, approved_by, approved_at,
               parent_id, payment_status, payment_date, fx_rate_to_usd,
               entry_source, campaign_id, release_id,
               recoupable, recoup_reviewed, recoup_reviewed_at, recoup_reviewed_by,
               artist_campaign, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                    $17,$18,$19,TRUE,TRUE,NOW(),$20,'Yes',$21)
            RETURNING id`,
            [openRow.invoice_date, openRow.payee, openRow.description, openRow.category,
              s.artist, s.song, fromCents(s.cents),
              openRow.currency, openRow.payment_method, openRow.status,
              openRow.approved_by, openRow.approved_at,
              root, openRow.payment_status, openRow.payment_date, openRow.fx_rate_to_usd,
              openRow.entry_source, s.campaign_id, s.release_id,
              req.user.id, req.user.name]);
          written.slices += 1;
          written.expense_ids.push(ins.id);
        }

        // The family must still add up to the charge. Asserted, not assumed: the
        // shared split writer performs no such check, and a cent per charge is
        // exactly the drift that broke the artist spend sheets' tie-out.
        const after = await famRows(client, root);
        const sum = after.reduce((s, m) => s + toCents(m.amount), 0);
        if (sum !== charge.charge_cents) {
          throw new Error(`charge ${root}: slices sum to ${fromCents(sum)} but the charge is `
            + `${fromCents(charge.charge_cents)} — refusing to leave the ledger out by `
            + `${fromCents(sum - charge.charge_cents)}`);
        }
        await writeBreakdown(client, root, after);
        written.charges += 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    for (const c of plan.per_campaign) {
      await pool.query(`
        INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
        VALUES ($1,'ad_allocated',NULL,$2,'artist',NULL,$3,$4)`,
        [req.user.name, c.campaign_name, String(c.amount),
          `Allocated ${Number(c.amount).toFixed(2)} of ${month} ad charges to ${c.artist}`
          + (c.song ? ` — ${c.song}` : '') + ` across ${c.charges} charge${c.charges === 1 ? '' : 's'}`
          + ' — ledger slices, marked reviewed and recoupable']).catch(() => {});
    }

    res.json({ success: true, data: { ...publicPlan, written } });
  } catch (err) {
    console.error('POST /api/reports/ad-allocate:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** A family's live members, root first — the one shape every step below reads. */
async function famRows(client, root) {
  const { rows } = await client.query(`
    SELECT id, parent_id, amount::float8 AS amount, COALESCE(currency,'USD') AS currency,
           fx_rate_to_usd, artist, song, category, campaign_id, payee, payment_date,
           payment_method, entry_source, release_id, invoice_date, description,
           status, approved_by, approved_at, payment_status
      FROM expenses
     WHERE (id = $1 OR parent_id = $1)
       AND (deleted IS NULL OR deleted = FALSE) AND (voided IS NULL OR voided = FALSE)
     ORDER BY (parent_id IS NULL) DESC, id ASC`, [root]);
  return rows;
}

/**
 * Keep the parent's `artist_breakdown` in step with the family.
 *
 * It is a denormalized copy read by the breakdown editor, two sensors in
 * routes/flags.js, and `DELETE /entries/:id/splits` — which is what makes undo
 * work for free. Written in family order, so `lib/split-breakdown.js` can match
 * slice i to member i by position.
 *
 * A one-member family is not a split, so the copy is cleared rather than left
 * describing a division that no longer exists.
 */
async function writeBreakdown(client, root, fam) {
  if (fam.length < 2) {
    await client.query('UPDATE expenses SET artist_breakdown = NULL WHERE id = $1', [root]);
    return;
  }
  const bd = fam.map((m) => ({
    artist: m.artist || null, song: m.song || null,
    amount: Math.round(Number(m.amount) * 100) / 100,
    campaign_id: m.campaign_id || null,
  }));
  await client.query('UPDATE expenses SET artist_breakdown = $1 WHERE id = $2', [JSON.stringify(bd), root]);
}

// DELETE /ad-allocate/:expenseId — hand one slice back to the pool.
//
// Per-slice rather than per-charge, because that is the grain the mistake is made
// at. `DELETE /bk/entries/:id/splits` (unsplit the whole family) still exists and
// still works; this is the narrower undo that does not disturb the other
// campaigns sharing the charge.
router.delete('/ad-allocate/:expenseId', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const id = Number(req.params.expenseId);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'bad id' });

    const { rows: [slice] } = await pool.query(`
      SELECT e.id, e.parent_id, e.amount::float8 AS amount, e.artist, e.campaign_id, e.payee,
             ic.name AS campaign_name
        FROM expenses e LEFT JOIN influencer_campaigns ic ON ic.id = e.campaign_id
       WHERE e.id = $1 AND (e.deleted IS NULL OR e.deleted = FALSE)`, [id]);
    if (!slice) return res.status(404).json({ success: false, error: 'Entry not found' });
    if (!slice.campaign_id) {
      return res.status(400).json({ success: false, error: 'That row is not an ad allocation — nothing to return' });
    }
    const root = slice.parent_id || slice.id;

    const client = await pool.connect();
    let outcome;
    try {
      await client.query('BEGIN');
      const fam = await famRows(client, root);
      const before = fam.reduce((s, m) => s + toCents(m.amount), 0);
      // The row the money goes back to: the family's unallocated slice, if it has
      // one. Identified by carrying neither an artist nor a campaign — the same
      // thing the pool's own test means by "belonging to nobody".
      const open = fam.find((m) => m.id !== id && !m.campaign_id && !String(m.artist || '').trim());

      if (open && slice.parent_id) {
        await client.query('UPDATE expenses SET amount = $1 WHERE id = $2',
          [fromCents(toCents(open.amount) + toCents(slice.amount)), open.id]);
        await client.query('DELETE FROM expenses WHERE id = $1', [id]);
        outcome = 'folded back into the charge';
      } else {
        // No unallocated slice to merge into — or this IS the root, which cannot be
        // deleted without destroying the bank match that points at it. Strip the
        // labels instead: same money, back to belonging to nobody.
        await client.query(`
          UPDATE expenses
             SET artist = NULL, song = NULL, campaign_id = NULL,
                 recoup_reviewed = FALSE, recoup_reviewed_at = NULL, recoup_reviewed_by = NULL
           WHERE id = $1`, [id]);
        outcome = 'returned to the pool in place';
      }

      const after = await famRows(client, root);
      const sum = after.reduce((s, m) => s + toCents(m.amount), 0);
      if (sum !== before) {
        throw new Error(`undo changed the charge total from ${fromCents(before)} to ${fromCents(sum)}`);
      }
      await writeBreakdown(client, root, after);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await pool.query(`
      INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
      VALUES ($1,'ad_unallocated',$2,$3,'artist',$4,NULL,$5)`,
      [req.user.name, id, slice.payee, String(slice.amount),
        `Returned ${Number(slice.amount).toFixed(2)} from ${slice.campaign_name || 'a campaign'}`
        + ` (${slice.artist || 'no artist'}) to the ad pool — ${outcome}`]).catch(() => {});

    res.json({ success: true, data: { expense_id: id, root_id: root, amount: slice.amount, outcome } });
  } catch (err) {
    console.error('DELETE /api/reports/ad-allocate:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Ad pool allocations ─────────────────────────────────────────────────────
//
// "Assign a set $ amount for an artist, deducted from advertisements as a whole."
// The charges carry no artist evidence; a person does. An allocation MOVES money
// from the pool to that artist — the artist's total rises, the pool's falls, the
// P&L is untouched.
//
// Keyed by MONTH, the grain the P&L buckets on. Validated against that month's
// pool at write time, so an over-assignment is refused with the numbers rather
// than silently trimmed on every future read.

// GET ?month=YYYY-MM — the allocations, plus the pool they draw from, so the UI
// can show what is left before anyone types an amount.
router.get('/ad-pool', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : null;
    if (!month) return res.status(400).json({ success: false, error: 'month must be YYYY-MM' });
    // The pool for that month, from the SAME derivation the report uses — never a
    // second query with its own idea of what label-level means.
    const pnl = await buildPnl(`${month}-01`, monthEnd(month), null);
    const { rows: allocs } = await pool.query(
      `SELECT a.id, a.artist, a.category, a.period_month, a.amount::float8 AS amount, a.note,
              a.created_at, (SELECT name FROM users WHERE id = a.created_by) AS created_by_name
         FROM ad_pool_allocations a
        WHERE a.period_month = $1
        ORDER BY a.created_at ASC, a.id ASC`, [month]);
    // `label_level` here is what REMAINS after these allocations were applied, so
    // pool = remaining + allocated.
    const remaining = Number(pnl.by_artist?.label_level?.total) || 0;
    const allocated = Number(pnl.by_artist?.label_level?.allocated) || 0;
    res.json({
      success: true,
      data: {
        month,
        pool: round2(remaining + allocated),
        allocated: round2(allocated),
        remaining: round2(remaining),
        by_category: pnl.by_artist?.label_level?.by_category || {},
        trimmed: pnl.by_artist?.label_level?.trimmed || [],
        allocations: allocs,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST { artist, month, amount, category?, note? }
//
// ── Retired 2026-08-25, in favour of /bk/advertising ──
// This wrote a REPORTING overlay: it moved the P&L and Artist Campaigns' Settled
// layer and touched no ledger row, so an allocation was invisible to Recoupments,
// the artist spend sheets and the recoupment audit. It also asked for a dollar
// figure with no campaign and no charge list attached, and the measurement says
// what that costs — $267,674 of pool across Feb–Jul 2026 and ZERO allocations in
// six months.
//
// Two mechanisms drawing on one pool is worse than one. /bk/advertising writes
// real slices, which SHRINKS the pool, and `applyAllocations` would then trim a
// row written here on the next read — disclosed in `label_level.trimmed`, but
// still a figure moving because of an unrelated action.
//
// GET and DELETE stay: a row written before this landed must remain visible and
// removable. Only the write is closed, and it says where to go.
router.post('/ad-pool', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    return res.status(400).json({
      success: false,
      error: 'Assigning ad spend by amount has been replaced by Allocate Advertising, which allocates'
        + ' against a campaign and writes real ledger splits — so the money reaches Recoupments and the'
        + ' artist spend sheets, which this never could. Open /bk/advertising.',
      data: { moved_to: '/bk/advertising' },
    });
    /* eslint-disable no-unreachable */
    const artist = String(req.body.artist || '').trim().slice(0, 255);
    const month = String(req.body.month || '');
    const amount = Math.abs(Number(req.body.amount) || 0);
    const category = String(req.body.category || 'Advertisements').slice(0, 100);
    if (!artist) return res.status(400).json({ success: false, error: 'artist required' });
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ success: false, error: 'month must be YYYY-MM' });
    if (!(amount > 0)) return res.status(400).json({ success: false, error: 'amount must be greater than zero' });

    // Refused, not trimmed. An assignment the pool cannot fund would be quietly
    // cut on every future read, and the number a person typed would never be the
    // number the report showed.
    const pnl = await buildPnl(`${month}-01`, monthEnd(month), null);
    const remainingCat = Number(pnl.by_artist?.label_level?.by_category?.[category]) || 0;
    if (amount > remainingCat + 0.005) {
      return res.status(400).json({
        success: false,
        error: `${month} has ${remainingCat.toFixed(2)} of unallocated ${category} pool left`
          + ` — ${amount.toFixed(2)} would over-assign it.`
          + ' Reduce the amount, or free some up by removing another allocation.',
        data: { remaining: round2(remainingCat) },
      });
    }
    const { rows: [row] } = await pool.query(
      `INSERT INTO ad_pool_allocations (artist, category, period_month, amount, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [artist, category, month, amount, String(req.body.note || '').slice(0, 500) || null, req.user.id]);
    await pool.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1,'ad_pool_allocated',NULL,$2,'artist',NULL,$3,$4)`,
      [req.user.name, artist, String(amount),
        `Assigned ${amount.toFixed(2)} of the ${month} ${category} pool to ${artist}`
        + ` — moves it out of label-level spend and onto that artist`]).catch(() => {});
    res.json({ success: true, data: row });
    /* eslint-enable no-unreachable */
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE — the money returns to the pool on the next request.
router.delete('/ad-pool/:id', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows } = await pool.query(
      `DELETE FROM ad_pool_allocations WHERE id = $1 RETURNING artist, amount::float8 AS amount, period_month, category`,
      [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Allocation not found' });
    const a = rows[0];
    await pool.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1,'ad_pool_unallocated',NULL,$2,'artist',$3,NULL,$4)`,
      [req.user.name, a.artist, String(a.amount),
        `Removed ${Number(a.amount).toFixed(2)} of the ${a.period_month} ${a.category} pool from ${a.artist}`
        + ' — it returns to unallocated label-level spend']).catch(() => {});
    res.json({ success: true, data: a });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Label-level spend rules ─────────────────────────────────────────────────
//
// "This vendor's spend bills the LABEL, not a release." See lib/label-level.js
// for the measurement: 490 ad-platform charges worth $289,499 with no song, no
// artist and no campaign on any of them.
//
// A rule MOVES money between buckets on Spend by Artist and Artist Campaigns —
// out of "names no artist" and into a disclosed pool — so all three of these are
// admin-gated, audit-logged and instantly reversible. Nothing is written to the
// ledger; deleting a rule puts the rows back on the next request.

// GET — the rules, each with what it currently covers, so the page can show the
// consequence rather than just the name.
router.get('/label-level-rules', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows } = await pool.query(`
      SELECT r.id, r.scope, r.rule_key, r.reason, r.created_at,
             (SELECT name FROM users WHERE id = r.created_by) AS created_by_name
        FROM label_level_spend_rules r
       ORDER BY r.scope, LOWER(r.rule_key)`);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST { scope: 'vendor'|'category', keys: [...] | key, reason }
//
// Takes a LIST, because the queue's selection is how these get made: you pick the
// Spotify and Facebook rows and say "these are not artist-level", which is two
// rules from one action.
router.post('/label-level-rules', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const scope = String(req.body.scope || 'vendor');
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
        `INSERT INTO label_level_spend_rules (scope, rule_key, reason, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (scope, rule_key) DO UPDATE SET reason = COALESCE(EXCLUDED.reason, label_level_spend_rules.reason)
         RETURNING id, scope, rule_key`, [scope, key, reason, req.user.id]);
      if (rows[0]) made.push(rows[0]);
    }
    await pool.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1,'label_level_rule_added',NULL,$2,'artist_attribution',NULL,$3,$4)`,
      [req.user.name, keys.join(', '), scope,
        `Marked as label-level (not artist-attributable): ${keys.join(', ')}`
        + (reason ? ` — ${reason}` : '')]).catch(() => {});
    res.json({ success: true, data: { made } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE — the rows come straight back to "names no artist".
router.delete('/label-level-rules/:id', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows } = await pool.query(
      `DELETE FROM label_level_spend_rules WHERE id = $1 RETURNING scope, rule_key`,
      [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Rule not found' });
    await pool.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1,'label_level_rule_removed',NULL,$2,'artist_attribution',$3,NULL,$4)`,
      [req.user.name, rows[0].rule_key, rows[0].scope,
        `No longer label-level: ${rows[0].rule_key} — its spend returns to "names no artist"`]).catch(() => {});
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/reports/recategorize — fix a category/income type straight
// from a drill-down row. Updates the ledger family root (reports bucket
// by the root's category) or the income row; audited.
router.post('/recategorize', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const category = String(req.body.category || '').trim().slice(0, 100);
    if (!category) return res.status(400).json({ success: false, error: 'category required' });
    const expenseId = parseInt(req.body.expense_id, 10);
    const incomeId = parseInt(req.body.income_id, 10);
    if (expenseId) {
      // Read the old value FIRST: the audit row was logging NULL for it, and the
      // breakdown resync needs it to find the slice this row is when position
      // cannot be trusted.
      const { rows: [was] } = await pool.query(
        `SELECT category, parent_id FROM expenses WHERE id = $1`, [expenseId]);
      const { rows: [e] } = await pool.query(
        `UPDATE expenses SET category = $1 WHERE id = $2 RETURNING id, payee, category`,
        [category, expenseId]);
      if (!e) return res.status(404).json({ success: false, error: 'Entry not found' });
      // A split family stores its slices twice; relabelling one row has to move
      // the parent's copy with it. Never fails the write — a stale copy is
      // reported, not fatal.
      const breakdown = await resyncBreakdown(pool, e.id, {
        field: 'category', from: was?.category, to: category,
      }).catch((err) => ({ synced: false, reason: err.message }));
      await pool.query(
        `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
         VALUES ($1,'entry_recategorized',$2,$3,'category',$4,$5,$6)`,
        [req.user.name, e.id, e.payee, was?.category || null, category,
          'Recategorized from the Reports drill-down'
          + (was?.parent_id ? ` — one part of a split (family ${was.parent_id})` : '')
          + (breakdown.synced ? ', stored breakdown updated' : '')]).catch(() => {});
      return res.json({ success: true, data: { breakdown } });
    }
    if (incomeId) {
      const { rows: [inc] } = await pool.query(
        `UPDATE artist_income SET income_type = $1 WHERE id = $2 RETURNING id, description`,
        [category, incomeId]);
      if (!inc) return res.status(404).json({ success: false, error: 'Income row not found' });
      await pool.query(
        `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
         VALUES ($1,'income_retyped',NULL,$2,'income_type',NULL,$3,'Income type changed from the Reports drill-down')`,
        [req.user.name, inc.description, category]).catch(() => {});
      return res.json({ success: true });
    }
    res.status(400).json({ success: false, error: 'expense_id or income_id required' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/reports/set-artist  { expense_id | expense_ids[], artist }
//
// Attribute spend to an artist straight from the drill. The sibling of
// /recategorize above: that one answers "what kind of spend is this", this one
// answers "who was it for" — the question $2.64M of the ledger currently can't
// answer, which is why Spend by Artist covers a fraction of real spending.
//
// One route for a single row and a bulk apply, because they are the same write.
// An empty artist CLEARS it, so putting a row back is this same control rather
// than a separate undo somebody has to find.
router.post('/set-artist', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const artist = String(req.body.artist ?? '').trim().slice(0, 255);
    const ids = [
      ...(Array.isArray(req.body.expense_ids) ? req.body.expense_ids : []),
      ...(req.body.expense_id != null ? [req.body.expense_id] : []),
    ].map(Number).filter(Number.isFinite);
    if (!ids.length) return res.status(400).json({ success: false, error: 'expense_id or expense_ids required' });

    // Re-read server-side: the caller's list can be stale, and this writes to
    // the ledger. `song` comes back because it decides whether the release link
    // needs recomputing at all.
    const { rows: targets } = await pool.query(
      `SELECT id, payee, artist AS old_artist, song FROM expenses
        WHERE id = ANY($1::int[])
          AND (deleted = false OR deleted IS NULL)
          AND (voided = false OR voided IS NULL)`, [ids]);
    if (!targets.length) return res.status(404).json({ success: false, error: 'No matching entries' });

    await pool.query(`UPDATE expenses SET artist = $1 WHERE id = ANY($2::int[])`,
      [artist || null, targets.map((t) => t.id)]);

    // ONLY for rows that carry a song. autoLinkRelease matches artist+song
    // against releases, and on a songless row it early-returns — but not before
    // issuing an UPDATE … SET release_id = NULL. Calling it per row on a bulk
    // of 569 songless rows would be 569 pointless writes for a column that is
    // already NULL. Attributing a bank-booked row is exactly that case.
    const withSong = targets.filter((t) => String(t.song || '').trim());
    for (const t of withSong) await autoLinkRelease(t.id, artist, t.song).catch(() => {});

    // Split families store their slices twice — see lib/split-breakdown.js. The
    // ones that are must not leave the parent's copy naming the old artist for a
    // slice the ledger has moved.
    //
    // WHICH rows those are is settled in ONE query first. This route also serves
    // "Attribute all 569" from the drill, and resyncing per row would have been
    // three queries each — 1,700 round trips inside one request for a handful of
    // real splits, which is how a housekeeping pass ends up in a request handler
    // and takes the pool with it.
    const { rows: splitKin } = await pool.query(
      `SELECT e.id FROM expenses e
         JOIN expenses p ON p.id = COALESCE(e.parent_id, e.id)
        WHERE e.id = ANY($1::int[])
          AND jsonb_typeof(p.artist_breakdown) = 'array'
          AND jsonb_array_length(p.artist_breakdown) >= 2`,
      [targets.map((t) => t.id)]).catch((err) => {
      console.error('split-kin lookup unavailable — breakdowns left as they are:', err.message);
      return { rows: [] };
    });
    const kin = new Set(splitKin.map((r) => r.id));
    const breakdowns = [];
    for (const t of targets) {
      if (!kin.has(t.id)) continue;
      const out = await resyncBreakdown(pool, t.id, {
        field: 'artist', from: t.old_artist, to: artist,
      }).catch((err) => ({ synced: false, reason: err.message }));
      breakdowns.push({ id: t.id, ...out });
    }
    const breakdownsSynced = breakdowns.filter((b) => b.synced).length;
    const breakdownsStale = breakdowns.filter((b) => !b.synced);

    await pool.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1,'entry_artist_set',$2,$3,'artist',$4,$5,$6)`,
      [req.user.name, targets.length === 1 ? targets[0].id : null,
        targets.length === 1 ? targets[0].payee : `${targets.length} entries`,
        targets.length === 1 ? (targets[0].old_artist || null) : null,
        artist || null,
        `${artist ? `Attributed to ${artist}` : 'Artist cleared'} from the Reports drill-down`
        + ` — ${targets.length} entr${targets.length === 1 ? 'y' : 'ies'}`
        + (withSong.length ? `, ${withSong.length} release link${withSong.length === 1 ? '' : 's'} recomputed` : '')
        + (breakdownsSynced ? `, ${breakdownsSynced} split breakdown${breakdownsSynced === 1 ? '' : 's'} updated` : '')
        + (breakdownsStale.length ? `, ${breakdownsStale.length} breakdown${breakdownsStale.length === 1 ? '' : 's'} left alone (${breakdownsStale[0].reason})` : '')])
      .catch(() => {});

    res.json({
      success: true,
      data: {
        updated: targets.length,
        // Requested vs written. A gap means rows changed under the caller
        // (deleted, voided) and the UI should say so rather than report a
        // count it did not achieve.
        requested: ids.length,
        skipped: Math.max(0, ids.length - targets.length),
        relinked: withSong.length,
        // Split slices whose stored copy followed, and any it refused to guess at
        // — surfaced rather than swallowed, because a stale copy is something a
        // person may need to fix by hand on Bank Matching.
        breakdowns_synced: breakdownsSynced,
        breakdowns_stale: breakdownsStale,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/reports/reassign-month  { txn_id, target_month: 'YYYY-MM' | null }
//
// Move which month the P&L reports a transaction in, without touching the bank
// row or the ledger entry behind it. Admin-gated, audited and reversible for the
// same reason /dismiss is: it moves a reported total.
//
// Passing target_month equal to the row's real month — or null — REMOVES the
// override rather than storing a no-op, so "put it back" is the same control
// rather than a separate restore path someone has to find.
router.post('/reassign-month', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const txnId = parseInt(req.body.txn_id, 10);
    if (!txnId) return res.status(400).json({ success: false, error: 'txn_id required' });
    const target = req.body.target_month === null || req.body.target_month === ''
      ? null : String(req.body.target_month);
    if (target !== null && !isMonthKey(target)) {
      return res.status(400).json({ success: false, error: 'target_month must be YYYY-MM' });
    }
    const reason = String(req.body.reason || '').trim() || null;

    // Fingerprint from the live row, exactly as /dismiss does, so the override
    // survives a statement re-upload under new ids.
    const { rows: [t] } = await pool.query(
      `SELECT id, txn_date, amount, payee_guess, payee_email, description
         FROM bank_transactions WHERE id = $1`, [txnId]);
    if (!t) return res.status(404).json({ success: false, error: 'Transaction not found' });
    const fp = fingerprintOf(t);
    const original = ym(t.txn_date);

    if (!target || target === original) {
      const { rowCount } = await pool.query(
        'DELETE FROM report_month_overrides WHERE txn_fingerprint = $1', [fp]);
      if (rowCount) {
        await pool.query(
          `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
           VALUES ($1,'report_month_restored',NULL,$2,'report_month',NULL,$3,$4)`,
          [req.user.name, t.payee_guess || t.description || '(bank row)', original,
            'Month reassignment removed from the Reports drill-down']).catch(() => {});
      }
      return res.json({ success: true, data: { target_month: null, original_month: original } });
    }

    await pool.query(
      `INSERT INTO report_month_overrides
         (txn_fingerprint, txn_id, original_month, target_month, reason, moved_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (txn_fingerprint) DO UPDATE
         SET target_month = EXCLUDED.target_month, txn_id = EXCLUDED.txn_id,
             reason = EXCLUDED.reason, moved_by = EXCLUDED.moved_by, moved_at = NOW()`,
      [fp, t.id, original, target, reason, req.user.name]);
    await pool.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1,'report_month_reassigned',NULL,$2,'report_month',$3,$4,$5)`,
      [req.user.name, t.payee_guess || t.description || '(bank row)', original, target,
        `Reported month moved from the Reports page${reason ? ` — ${reason}` : ''}`]).catch(() => {});

    res.json({ success: true, data: { target_month: target, original_month: original } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/reports/classify  { kind, category, section, contra_of }
//
// Move a P&L line between operating / non-recurring / below-the-line, or make
// it net against the expense it recovers. A standing rule on bk_categories, so
// it applies to everything in that line now and later.
//
// This exists because the classification used to be two hardcoded Sets: when
// "Partner - Felipe" and "Partner - Tyler" turned out to be owner draws rather
// than opex, correcting $530,926 of misplaced expense needed a deploy. It is a
// judgment about the business, and it changes — so it lives in data and a
// person can fix it.
router.post('/classify', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const kind = String(req.body.kind || '');
    if (!['income', 'expense'].includes(kind)) {
      return res.status(400).json({ success: false, error: "kind must be 'income' or 'expense'" });
    }
    const category = String(req.body.category || '').trim();
    if (!category) return res.status(400).json({ success: false, error: 'category required' });
    const section = String(req.body.section || 'operating');
    if (!['operating', 'below_line', 'non_recurring'].includes(section)) {
      return res.status(400).json({ success: false, error: 'section must be operating, below_line or non_recurring' });
    }
    // A contra only makes sense on an income line — it is a recovery of spend.
    const contraOf = String(req.body.contra_of || '').trim() || null;
    if (contraOf && kind !== 'income') {
      return res.status(400).json({ success: false, error: 'Only an income line can net against an expense' });
    }

    const { rowCount } = await pool.query(
      `UPDATE bk_categories SET report_section = $1, contra_of = $2, section_set = TRUE
        WHERE kind = $3 AND LOWER(TRIM(name)) = LOWER(TRIM($4))`,
      [section, contraOf, kind, category]);
    if (!rowCount) return res.status(404).json({ success: false, error: `No ${kind} category named "${category}"` });

    await pool.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1,'report_line_reclassified',NULL,$2,'report_section',NULL,$3,$4)`,
      [req.user.name, category, section,
        `P&L line moved to ${section}${contraOf ? `, netting against ${contraOf}` : ''}`]).catch(() => {});

    res.json({ success: true, data: { kind, category, section, contra_of: contraOf } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/reports/rename-category  { kind, from, to }
//
// Rename a P&L line everywhere it is stored.
//
// ── Why this is more than an UPDATE on bk_categories ─────────────────────────
//
// A category name is not held in one place. It is FREE TEXT on the ledger rows
// themselves, and several other tables point at a category BY NAME. Renaming
// only the vocabulary row would leave every one of those pointing at a string
// that no longer exists, and each failure is silent:
//
//   report_dismissals.cell_key   a standing "don't count this line" rule stops
//                                matching — excluded money quietly returns to
//                                the P&L with nothing on the page to say so
//   bk_categories.contra_of      a recovery stops netting against the expense
//                                it recovers and reappears as ordinary income
//   statement_category_map       learned payee→category lessons stop firing, so
//   statement_category_rules     the matcher forgets what it was taught
//
// So this migrates all of them in ONE transaction and reports a count per
// table. Nothing here is inferred at read time; if a table is missed, the
// damage is invisible until someone reconciles by hand.
//
// Deliberately NOT touched: release_budget_line_items.category (a separate
// BUDGET_CATEGORIES vocabulary) and admin_documents.category (document types).
// Same column name, different meaning.
router.post('/rename-category', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const kind = String(req.body.kind || '');
    if (!['income', 'expense'].includes(kind)) {
      return res.status(400).json({ success: false, error: "kind must be 'income' or 'expense'" });
    }
    const from = String(req.body.from || '').trim();
    const to = String(req.body.to || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!from || !to) return res.status(400).json({ success: false, error: 'from and to are required' });
    if (from.toLowerCase() === to.toLowerCase() && from === to) {
      return res.status(400).json({ success: false, error: 'That is already the name' });
    }

    // Renaming onto a name that already exists is a MERGE — the two lines
    // become one. Allowed, because "True Legal" → "Legal" is exactly the useful
    // case, but the response says so rather than letting it look like a rename.
    const { rows: [existing] } = await client.query(
      `SELECT name FROM bk_categories WHERE kind = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2))`,
      [kind, to]);
    const merged = !!existing;

    await client.query('BEGIN');
    const counts = {};
    const run = async (label, sql, params) => {
      const r = await client.query(sql, params).catch((err) => {
        // A table that doesn't exist in this environment must not abort the
        // rename of the tables that do.
        console.error(`[rename-category] ${label} skipped: ${err.message}`);
        return null;
      });
      if (r) counts[label] = r.rowCount;
    };

    if (kind === 'expense') {
      await run('expenses', `UPDATE expenses SET category = $1 WHERE LOWER(TRIM(category)) = LOWER(TRIM($2))`, [to, from]);
      await run('manual_expenses', `UPDATE manual_expenses SET category = $1 WHERE LOWER(TRIM(category)) = LOWER(TRIM($2))`, [to, from]);
      await run('statement_category_map', `UPDATE statement_category_map SET category = $1 WHERE LOWER(TRIM(category)) = LOWER(TRIM($2))`, [to, from]);
      await run('statement_category_rules', `UPDATE statement_category_rules SET category = $1 WHERE LOWER(TRIM(category)) = LOWER(TRIM($2))`, [to, from]);
      // Contra pointers name an EXPENSE category.
      await run('contra_pointers', `UPDATE bk_categories SET contra_of = $1 WHERE LOWER(TRIM(contra_of)) = LOWER(TRIM($2))`, [to, from]);

      // ── Rule tables keyed by a category NAME ──────────────────────────────
      // Three tables declare things about a class of spend by name, and a rename
      // that leaves them behind silently un-declares it. `recoupment_class_rules`
      // is the loudest case: eight rules hold $2,074,917 of Royalties, Salary,
      // partner draws and Rent out of the recoupment queue, and renaming
      // "Royalties" would put $600,000 back into it with nothing to say why.
      // `label_level_spend_rules` and `statement_no_invoice_rules` had the same
      // gap and are fixed here alongside — one omission, three tables.
      //
      // Each has a uniqueness constraint on (scope, key), so a rename INTO an
      // existing rule is a merge: drop the source, because the target already
      // says the same thing about the same rows. Delete first, then rename what
      // is left, or the UPDATE trips the constraint.
      for (const [label, table, col] of [
        ['recoupment_class_rules', 'recoupment_class_rules', 'rule_key'],
        ['label_level_spend_rules', 'label_level_spend_rules', 'rule_key'],
        ['statement_no_invoice_rules', 'statement_no_invoice_rules', 'pattern'],
      ]) {
        await run(`${label}:merged`, `
          DELETE FROM ${table} t
           WHERE t.scope = 'category'
             AND LOWER(TRIM(t.${col})) = LOWER(TRIM($2))
             AND EXISTS (SELECT 1 FROM ${table} k
                          WHERE k.scope = 'category'
                            AND LOWER(TRIM(k.${col})) = LOWER(TRIM($1)))`, [to, from]);
        await run(label, `
          UPDATE ${table} SET ${col} = $1
           WHERE scope = 'category' AND LOWER(TRIM(${col})) = LOWER(TRIM($2))`, [to, from]);
      }
    } else {
      await run('artist_income', `UPDATE artist_income SET income_type = $1 WHERE LOWER(TRIM(income_type)) = LOWER(TRIM($2))`, [to, from]);
    }

    // Standing P&L-line exclusions are keyed by the name.
    await run('report_dismissals', `UPDATE report_dismissals SET cell_key = $1
        WHERE scope = 'category' AND cell_kind = $2 AND LOWER(TRIM(cell_key)) = LOWER(TRIM($3))`,
    [to, kind, from]);

    // The vocabulary row itself. On a merge the old row is removed rather than
    // renamed, because (kind, name) is the primary key.
    const { rows: [old] } = await client.query(
      `SELECT name, seeded, report_section, contra_of FROM bk_categories
        WHERE kind = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2))`, [kind, from]);
    if (old && merged) {
      await client.query(`DELETE FROM bk_categories WHERE kind = $1 AND name = $2`, [kind, old.name]);
      counts.category_row = 'merged into existing';
    } else if (old) {
      await client.query(`UPDATE bk_categories SET name = $1 WHERE kind = $2 AND name = $3`, [to, kind, old.name]);
      counts.category_row = 'renamed';
    } else {
      // Renaming a value that only ever existed as free text on the rows.
      await client.query(
        `INSERT INTO bk_categories (name, kind, seeded, created_by) VALUES ($1, $2, FALSE, $3)
         ON CONFLICT (kind, name) DO NOTHING`, [to, kind, req.user.id]).catch(() => {});
      counts.category_row = 'created';
    }

    // A SEEDED name is re-inserted from lib/constants.js on every boot, so a
    // renamed one would reappear in the dropdowns at the next deploy. Leave a
    // deactivated tombstone: the boot upsert sets `seeded` and `sort_order` but
    // never `active`, so it stays out of the pickers.
    if (old?.seeded) {
      await client.query(
        `INSERT INTO bk_categories (name, kind, seeded, active) VALUES ($1, $2, TRUE, FALSE)
         ON CONFLICT (kind, name) DO UPDATE SET active = FALSE`, [old.name, kind]).catch(() => {});
      counts.tombstoned_seed = old.name;
    }

    await client.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1,'category_renamed',NULL,$2,'category',$3,$4,$5)`,
      [req.user.name, from, from, to,
        `${kind} category renamed from the Reports page${merged ? ` — MERGED into existing "${existing.name}"` : ''} · ${JSON.stringify(counts)}`]).catch(() => {});

    await client.query('COMMIT');
    res.json({ success: true, data: { kind, from, to, merged, counts } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ── Report dismissals ───────────────────────────────────────────────────────
// Excluding an item from a report MOVES A REPORTED TOTAL, so all three of
// these are admin-gated, audit-logged, and fully reversible. Kept separate
// from bank_transactions.dismissed on purpose — see the table comment in
// server/index.js.

// POST /api/reports/dismiss  { txn_id } | { expense_id }, optional reason,
// plus the cell it was dismissed from for context in the review list.
router.post('/dismiss', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const txnId = parseInt(req.body.txn_id, 10) || null;
    const expenseId = parseInt(req.body.expense_id, 10) || null;
    const reason = String(req.body.reason || '').trim() || null;
    const cellKind = String(req.body.cell_kind || '').slice(0, 16) || null;
    const cellKey = String(req.body.cell_key || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;

    // ── Balance-sheet exclusions ──────────────────────────────────────────
    // Separate scopes from the P&L's, so neither can see the other's rules.
    // scope=bs_line excludes a whole balance-sheet line; scope=bs_item excludes
    // one invoice / bill / drawdown by its namespaced ref.
    const scope = String(req.body.scope || '');
    if (scope === 'bs_line' || scope === 'bs_item') {
      const bsRefVal = String(req.body.bs_ref || '').trim() || null;
      if (scope === 'bs_item' && !/^(ar|ap|adv):\d+$/.test(bsRefVal || '')) {
        return res.status(400).json({ success: false, error: "bs_ref must look like 'ar:123', 'ap:456' or 'adv:789'" });
      }
      if (scope === 'bs_line' && !cellKey) {
        return res.status(400).json({ success: false, error: 'cell_key is required for a balance-sheet line' });
      }
      const { rowCount } = scope === 'bs_line'
        ? await pool.query(
          `INSERT INTO report_dismissals (scope, cell_kind, cell_key, reason, dismissed_by)
           VALUES ('bs_line', 'balance_sheet', $1, $2, $3)
           ON CONFLICT (LOWER(TRIM(cell_key))) WHERE scope = 'bs_line' DO NOTHING`,
          [cellKey, reason, req.user.name])
        : await pool.query(
          `INSERT INTO report_dismissals (scope, bs_ref, cell_kind, cell_key, reason, dismissed_by)
           VALUES ('bs_item', $1, 'balance_sheet', $2, $3, $4)
           ON CONFLICT (bs_ref) WHERE bs_ref IS NOT NULL DO NOTHING`,
          [bsRefVal, cellKey, reason, req.user.name]);
      if (rowCount) {
        await pool.query(
          `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
           VALUES ($1,'balance_sheet_excluded',NULL,NULL,'report_dismissal',NULL,$2,$3)`,
          [req.user.name, bsRefVal || cellKey,
            `Excluded from the balance sheet${reason ? ` — ${reason}` : ''}`]).catch(() => {});
      }
      return res.json({ success: true, data: { scope, bs_ref: bsRefVal, cell_key: cellKey } });
    }

    // scope=category — a standing rule excluding a whole P&L line, rather than
    // one transaction. Everything in that line, now and later, stops counting.
    if (String(req.body.scope || '') === 'category') {
      if (!['income', 'expense'].includes(cellKind) || !cellKey) {
        return res.status(400).json({ success: false, error: "cell_kind ('income'|'expense') and cell_key are required" });
      }
      const { rowCount } = await pool.query(
        `INSERT INTO report_dismissals (scope, cell_kind, cell_key, reason, dismissed_by)
         VALUES ('category', $1, $2, $3, $4)
         ON CONFLICT (cell_kind, LOWER(TRIM(cell_key))) WHERE scope = 'category' DO NOTHING`,
        [cellKind, cellKey, reason, req.user.name]);
      if (rowCount) {
        await pool.query(
          `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
           VALUES ($1,'report_category_dismissed',NULL,NULL,'report_dismissal',NULL,$2,$3)`,
          [req.user.name, `${cellKind}:${cellKey}`,
            `Whole P&L line excluded from Reports${reason ? ` — ${reason}` : ''}`]).catch(() => {});
      }
      return res.json({ success: true, data: { scope: 'category', cell_kind: cellKind, cell_key: cellKey } });
    }

    if (!txnId === !expenseId) {
      return res.status(400).json({ success: false, error: 'Exactly one of txn_id or expense_id is required' });
    }

    if (txnId) {
      // Fingerprint from the live row so it matches after a re-upload.
      const { rows: [t] } = await pool.query(
        `SELECT id, txn_date, amount, payee_guess, payee_email, description
           FROM bank_transactions WHERE id = $1`, [txnId]);
      if (!t) return res.status(404).json({ success: false, error: 'Transaction not found' });
      const fp = fingerprintOf(t);
      await pool.query(
        `INSERT INTO report_dismissals
           (txn_fingerprint, txn_id, cell_kind, cell_key, reason, dismissed_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (txn_fingerprint) WHERE txn_fingerprint IS NOT NULL DO NOTHING`,
        [fp, t.id, cellKind, cellKey, reason, req.user.name]);
      await pool.query(
        `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
         VALUES ($1,'report_item_dismissed',NULL,$2,'report_dismissal',NULL,$3,$4)`,
        [req.user.name, t.payee_guess || t.description || '(bank row)', cellKey || '',
          `Excluded from the P&L from the Reports page${reason ? ` — ${reason}` : ''}`]).catch(() => {});
      return res.json({ success: true });
    }

    const { rows: [e] } = await pool.query('SELECT id, payee FROM expenses WHERE id = $1', [expenseId]);
    if (!e) return res.status(404).json({ success: false, error: 'Entry not found' });
    await pool.query(
      `INSERT INTO report_dismissals
         (expense_id, cell_kind, cell_key, reason, dismissed_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (expense_id) WHERE expense_id IS NOT NULL DO NOTHING`,
      [e.id, cellKind, cellKey, reason, req.user.name]);
    await pool.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1,'report_item_dismissed',$2,$3,'report_dismissal',NULL,$4,$5)`,
      [req.user.name, e.id, e.payee, cellKey || '',
        `Hidden from the Reports worklist${reason ? ` — ${reason}` : ''}`]).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/reports/dismiss/restore  { id } | { txn_id } | { expense_id }
router.post('/dismiss/restore', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const id = parseInt(req.body.id, 10) || null;
    const txnId = parseInt(req.body.txn_id, 10) || null;
    const expenseId = parseInt(req.body.expense_id, 10) || null;
    // Balance-sheet exclusions restore by ref or by line key, so the sheet's
    // own un-exclude affordance doesn't need to know the row id either.
    const rScope = String(req.body.scope || '');
    if (!id && (rScope === 'bs_line' || rScope === 'bs_item')) {
      const ref = String(req.body.bs_ref || '').trim();
      const key = String(req.body.cell_key || '').trim();
      const { rows } = rScope === 'bs_item'
        ? await pool.query(
          `DELETE FROM report_dismissals WHERE scope = 'bs_item' AND bs_ref = $1 RETURNING *`, [ref])
        : await pool.query(
          `DELETE FROM report_dismissals
            WHERE scope = 'bs_line' AND LOWER(TRIM(cell_key)) = LOWER(TRIM($1)) RETURNING *`, [key]);
      if (!rows.length) return res.status(404).json({ success: false, error: 'Exclusion not found' });
      await pool.query(
        `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
         VALUES ($1,'balance_sheet_restored',NULL,NULL,'report_dismissal',NULL,$2,'Balance-sheet exclusion removed')`,
        [req.user.name, ref || key]).catch(() => {});
      return res.json({ success: true, restored: rows.length });
    }

    // Restore a line rule by its cell, so the P&L's own "restore" affordance
    // doesn't need to know the row id.
    if (!id && String(req.body.scope || '') === 'category') {
      const cellKind = String(req.body.cell_kind || '').trim();
      const cellKey = String(req.body.cell_key || '').trim();
      // TRIM both sides. The JS above already trims, but matching on the
      // parameter untrimmed would make an untidy caller silently restore
      // nothing and get a 404 that reads as "was never dismissed".
      const { rows } = await pool.query(
        `DELETE FROM report_dismissals
          WHERE scope = 'category' AND cell_kind = $1
            AND LOWER(TRIM(cell_key)) = LOWER(TRIM($2))
          RETURNING *`, [cellKind, cellKey]);
      if (!rows.length) return res.status(404).json({ success: false, error: 'Dismissal not found' });
      await pool.query(
        `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
         VALUES ($1,'report_category_restored',NULL,NULL,'report_dismissal',NULL,$2,'P&L line restored')`,
        [req.user.name, `${cellKind}:${cellKey}`]).catch(() => {});
      return res.json({ success: true, restored: rows.length });
    }
    if (!id && !txnId && !expenseId) {
      return res.status(400).json({ success: false, error: 'id, txn_id or expense_id required' });
    }
    // By id when restoring from the review list; by ref when un-dismissing
    // straight from a drill row.
    const { rows } = id
      ? await pool.query('DELETE FROM report_dismissals WHERE id = $1 RETURNING *', [id])
      : txnId
        ? await pool.query('DELETE FROM report_dismissals WHERE txn_id = $1 RETURNING *', [txnId])
        : await pool.query('DELETE FROM report_dismissals WHERE expense_id = $1 RETURNING *', [expenseId]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Dismissal not found' });
    await pool.query(
      `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
       VALUES ($1,'report_item_restored',$2,$3,'report_dismissal',NULL,NULL,'Restored to the P&L from the Reports page')`,
      [req.user.name, rows[0].expense_id || null, rows[0].cell_key || '']).catch(() => {});
    res.json({ success: true, restored: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/reports/dismissals — the separate review list. Resolves each row
// back to whatever it still points at so the list is readable, and marks
// rows whose transaction no longer exists (statement deleted or re-uploaded
// under new ids) as orphaned: the fingerprint still suppresses a matching
// row if one comes back, but there's nothing to show right now.
router.get('/dismissals', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const { rows } = await pool.query(`
      SELECT d.id, d.scope, d.txn_fingerprint, d.txn_id, d.expense_id, d.bs_ref,
             d.cell_kind, d.cell_key, d.reason, d.dismissed_by, d.dismissed_at,
             t.txn_date, t.amount AS txn_amount, COALESCE(t.currency,'USD') AS txn_currency,
             t.payee_guess, t.description, t.direction,
             s.account, s.filename,
             e.payee AS expense_payee, e.amount AS expense_amount,
             COALESCE(e.currency,'USD') AS expense_currency,
             e.payment_date, e.artist, e.invoice_number
        FROM report_dismissals d
        LEFT JOIN bank_transactions t ON t.id = d.txn_id
        LEFT JOIN bank_statements s ON s.id = t.statement_id
        LEFT JOIN expenses e ON e.id = d.expense_id
       ORDER BY d.dismissed_at DESC
       LIMIT 500`);
    const isBs = (s) => s === 'bs_line' || s === 'bs_item';
    const data = rows.map((r) => ({
      id: r.id,
      scope: r.scope || 'item',
      // A category rule points at a line, not a row, so the resolved-row
      // fields below are all null for it — the client keys off `scope`.
      // Balance-sheet exclusions resolve to nothing here either: they reference
      // boom_invoices / artist_income rows this query doesn't join, and their
      // amounts live on the balance sheet's own `excluded` block.
      kind: isBs(r.scope) ? 'balance_sheet' : (r.scope === 'category' ? 'category' : (r.expense_id ? 'ledger' : 'bank')),
      counted: isBs(r.scope) ? true : (r.scope === 'category' ? true : !r.expense_id),
      orphaned: isBs(r.scope) ? false : (r.scope === 'category' ? false : (!r.expense_id && !r.txn_date)),
      bs_ref: r.bs_ref || null,
      date: r.txn_date || r.payment_date || null,
      payee: r.expense_payee || r.payee_guess || r.description || '—',
      amount: r.txn_amount != null ? Number(r.txn_amount) : (r.expense_amount != null ? Number(r.expense_amount) : null),
      currency: r.expense_id ? r.expense_currency : r.txn_currency,
      direction: r.direction || null,
      artist: r.artist || null,
      invoice_number: r.invoice_number || null,
      account: r.account || null,
      source: r.filename || null,
      cell_kind: r.cell_kind, cell_key: r.cell_key,
      reason: r.reason, dismissed_by: r.dismissed_by, dismissed_at: r.dismissed_at,
      txn_id: r.txn_id, expense_id: r.expense_id,
    }));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/reports/balance-sheet/detail?kind=ar|ap|advances — the rows
// behind a balance-sheet line, shaped like the P&L drill rows so the
// client modal renders them unchanged.
router.get('/balance-sheet/detail', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const asOf = String(req.query.as_of || new Date().toISOString().slice(0, 10));
    if (!isValidDay(asOf)) return res.status(400).json({ success: false, error: 'as_of must be a YYYY-MM-DD date' });
    const kind = String(req.query.kind || '');
    let out = [];
    if (kind === 'ar') {
      const { rows } = await pool.query(
        `SELECT id, invoice_number, bill_to, amount, currency, created_at FROM boom_invoices
          WHERE (payment_status IS DISTINCT FROM 'Paid') AND created_at::date <= $1
          ORDER BY created_at`, [asOf]);
      out = rows.map((r) => ({
        id: `ar${r.id}`, bs_ref: bsRef('ar', r.id), date: r.created_at, payee: r.bill_to,
        invoice_number: r.invoice_number, usd: usdOf(r.amount, r.currency, null),
        amount: r.amount, currency: r.currency,
      }));
    } else if (kind === 'ap') {
      const { rows } = await pool.query(
        `SELECT id, payee, invoice_number, amount, currency, fx_rate_to_usd,
                invoice_date, created_at, artist FROM expenses
          -- Identical predicate to buildBalanceSheet's A/P, or the drill total
          -- wouldn't equal the line it was opened from.
          WHERE status = 'approved'
            AND (deleted = false OR deleted IS NULL)
            AND (voided = false OR voided IS NULL)
            AND COALESCE(invoice_date, created_at::date) <= $1
            AND (payment_status IS DISTINCT FROM 'Paid' OR payment_date > $1)
          ORDER BY COALESCE(invoice_date, created_at::date)`, [asOf]);
      out = rows.map((r) => ({
        id: `ap${r.id}`, bs_ref: bsRef('ap', r.id), date: r.invoice_date || r.created_at, payee: r.payee,
        artist: r.artist, invoice_number: r.invoice_number,
        usd: usdOf(r.amount, r.currency, r.fx_rate_to_usd),
        amount: r.amount, currency: r.currency,
      }));
    } else if (kind === 'advances') {
      const { rows } = await pool.query(
        `SELECT id, artist_name, description, amount, income_date FROM artist_income
          WHERE income_type = 'Drawdown Fund' AND income_date <= $1
          ORDER BY income_date`, [asOf]);
      out = rows.map((r) => ({
        id: `adv${r.id}`, bs_ref: bsRef('adv', r.id), date: r.income_date, payee: r.description,
        artist: r.artist_name, usd: Number(r.amount), amount: r.amount, currency: 'USD',
      }));
    } else {
      return res.status(400).json({ success: false, error: 'kind must be ar, ap, or advances' });
    }

    // Excluded rows are SHOWN but not counted, so the drill total keeps
    // equalling the line it was opened from. A drill that silently disagrees
    // with its own cell is how the $3.73M Drawdown Fund discrepancy happened,
    // and it is the one property this file exists to protect. Same treatment
    // the P&L drill gives its dismissals.
    const exItems = await bsExcludedItems();
    const lineExcluded = (await bsExcludedLines()).has(
      kind === 'ar' ? BS_LINE.AR : kind === 'ap' ? BS_LINE.AP : BS_LINE.DRAWDOWNS);
    for (const r of out) r.dismissed = lineExcluded || exItems.has(r.bs_ref);
    const counted = out.filter((r) => !r.dismissed);
    const dropped = out.filter((r) => r.dismissed);

    res.json({
      success: true,
      data: {
        rows: out,
        total: counted.reduce((s, r) => s + r.usd, 0),
        line_excluded: lineExcluded,
        dismissed: { count: dropped.length, total: dropped.reduce((s, r) => s + r.usd, 0) },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/balance-sheet', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const asOf = String(req.query.as_of || new Date().toISOString().slice(0, 10));
    if (!isValidDay(asOf)) return res.status(400).json({ success: false, error: 'as_of must be a YYYY-MM-DD date' });
    res.json({ success: true, data: await buildBalanceSheet(asOf) });
  } catch (err) {
    // An out-of-range date is the caller's to fix, so it comes back as 400 with
    // the earliest supported date in the message.
    res.status(err instanceof BalanceSheetRangeError ? 400 : 500)
      .json({ success: false, error: err.message });
  }
});

// ── Exports ──────────────────────────────────────────────────────────────────
//
// Two renderers, ONE row model (lib/report-rows.js). Neither export composes its
// own rows: an Excel file and a Google Sheet that both claim to be the P&L and
// quietly disagree is the failure this arrangement exists to prevent, and the
// accountant reading either one has no way to spot it.

const { KIND, pnlRows, balanceSheetRows, spendByArtistRows } = require('../lib/report-rows');
const { writeReport } = require('../services/googleSheets');

const HEADER_BG = 'FF7F1D1D';
const GREY = 'FF9CA3AF';
const money = '"$"#,##0.00;[Red]("$"#,##0.00)';

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } };
  row.height = 22;
  row.alignment = { vertical: 'middle' };
}

/** Render a row model into an ExcelJS worksheet. */
function renderExcel(wb, sheetName, model) {
  const frozen = model.freeze.rows || model.freeze.cols;
  const ws = wb.addWorksheet(sheetName, {
    views: [frozen
      ? { showGridLines: false, state: 'frozen', xSplit: model.freeze.cols, ySplit: model.freeze.rows }
      : { showGridLines: false }],
    // Printed and PDF'd as often as it is scrolled. Without this a 12-column
    // report breaks across pages mid-row with no header on page two, which is
    // the difference between a report and a dump.
    // Squeezing 25 categories onto one page wide makes every figure unreadable,
    // which is the opposite of professional. Past a dozen value columns the sheet
    // spans pages across and REPEATS the identity columns on each, so page three
    // still says which artist a row belongs to — the printed equivalent of the
    // frozen pane.
    pageSetup: (model.valueCols || 0) > 12
      ? {
        orientation: 'landscape', fitToPage: false, scale: 65,
        margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
      }
      : {
        orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
      },
  });
  ws.columns = model.widths.map((w) => ({ width: w }));
  const lastCol = Math.max(1, (model.valueCols || 0) + 1);
  if (model.freeze?.rows) ws.pageSetup.printTitlesRow = `${model.freeze.rows}:${model.freeze.rows}`;
  if (model.freeze?.cols > 0 && (model.valueCols || 0) > 12) {
    ws.pageSetup.printTitlesColumn = `A:${String.fromCharCode(64 + model.freeze.cols)}`;
  }

  // Prose belongs in a BLOCK, not smeared across the grid. Ten strings in the
  // last export were longer than 60 characters, and a long string in column A
  // spills over every column to its right — the single biggest reason this
  // looked unfinished. Merged across the used width and wrapped, with the row
  // height set from the text, since Excel does not auto-fit a merged cell.
  //
  // Merged across a BOUNDED measure, not the whole sheet: stretching a sentence
  // over sixteen columns is ~230 characters on one line, which is unreadable in
  // the other direction and leaves the height impossible to get right. Enough
  // columns for ~100 characters, then wrap — and the height follows from that
  // measure, so nothing is clipped.
  let proseCols = 1;
  let proseWidth = 0;
  while (proseCols <= lastCol && proseWidth < 100) { proseWidth += model.widths[proseCols - 1] || 0; proseCols += 1; }
  proseCols = Math.min(Math.max(proseCols, 2), lastCol);
  const proseRow = (r, text) => {
    ws.mergeCells(r.number, 1, r.number, proseCols);
    r.getCell(1).alignment = { wrapText: true, vertical: 'top' };
    const perLine = Math.max(40, Math.round(proseWidth * 1.15));
    r.height = Math.max(14, Math.ceil(String(text || '').length / perLine) * 13);
  };

  let band = 0;
  for (const row of model.rows) {
    switch (row.kind) {
      case KIND.BLANK:
        ws.addRow([]).height = 6;
        break;
      case KIND.TITLE: {
        const r = ws.addRow([row.label]);
        r.font = { bold: true, size: 16, color: { argb: HEADER_BG } };
        r.height = 22;
        ws.mergeCells(r.number, 1, r.number, lastCol);
        break;
      }
      case KIND.SUBTITLE: {
        const r = ws.addRow([row.label]);
        r.font = { size: 9, color: { argb: GREY } };
        ws.mergeCells(r.number, 1, r.number, lastCol);
        break;
      }
      case KIND.HEADER: {
        const r = ws.addRow([row.label, ...row.values]);
        styleHeader(r);
        // Category headers are long and the columns are not; wrapped, they read
        // instead of being truncated to "Artist Expense - Recordin…".
        for (let i = 1; i <= lastCol; i++) {
          r.getCell(i).alignment = { wrapText: true, vertical: 'bottom', horizontal: i === 1 ? 'left' : 'right' };
          if (model.freeze?.cols > 1 && i === model.freeze.cols) {
            r.getCell(i).border = { right: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
          }
        }
        r.height = 34;
        band = 0;
        break;
      }
      case KIND.SECTION: {
        const r = ws.addRow([row.label]);
        r.font = { bold: true, size: row.size || 11, color: { argb: HEADER_BG } };
        // A band, so sections separate the sheet instead of floating in it.
        for (let i = 1; i <= lastCol; i++) {
          r.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F6F7' } };
          r.getCell(i).border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } };
        }
        r.height = 18;
        band = 0;
        break;
      }
      case KIND.NOTE: {
        const r = ws.addRow([row.label]);
        r.font = { size: 9, italic: true, color: { argb: GREY } };
        proseRow(r, row.label);
        break;
      }
      case KIND.LINE: {
        const r = ws.addRow([row.label, ...row.values]);
        r.getCell(1).alignment = { vertical: 'middle' };
        if (row.bold) r.getCell(1).font = { bold: true };
        band += 1;
        // The frozen columns are the row's identity and its headline figure; the
        // rest is the breakdown. A hairline between them stops a 25-column grid
        // reading as one undifferentiated field of numbers, and the Total column
        // carries weight because it is what the sheet is opened for.
        const ruleAfter = model.freeze?.cols > 1 ? model.freeze.cols : 0;
        for (let i = 1; i <= lastCol; i++) {
          const c = r.getCell(i);
          if (i > 1) {
            c.numFmt = money;
            if (i === 2 && !row.bold) c.font = { bold: true, color: { argb: 'FF111827' } };
            c.alignment = { horizontal: 'right', vertical: 'middle' };
            // Round AT THE CELL. The accumulators are deliberately unrounded so
            // the totals tie out, but writing 201610.50000000012 into a sheet
            // hands that dust to whoever sums the column next.
            if (typeof c.value === 'number') c.value = Math.round(c.value * 100) / 100;
            if (row.bold) c.font = { bold: true };
          }
          if (ruleAfter && i === ruleAfter) {
            c.border = { ...(c.border || {}), right: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
          }
          // A TOTAL is ruled off, not merely emboldened.
          if (row.bold) c.border = { ...(c.border || {}), top: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
          // Banding, on the data rows only. A 100-row × 12-column grid that is
          // 91% empty is where the eye loses its place.
          else if (band % 2 === 0) {
            c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAFB' } };
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return ws;
}

// ── Reports, second pass (2026-09-20, John's calls) ─────────────────────────
// A selectable basis (above), spend by vendor / rep, invoices received, budget
// vs actual, and the monthly accountant pack. Every cut here runs off rowsFor
// + the P&L's own helpers, so none can disagree with the P&L on the same basis.

// GET /api/reports/basis — what the page should open on, and why.
router.get('/basis', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    res.json({ success: true, data: await defaultBasis() });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Operating spend grouped by vendor (payee) or rep, months across. Reversed,
// dismissed and non-operating rows are out — exactly the P&L's expense total
// partitioned a different way.
async function buildSpendBy(from, to, basis, dim) {
  const months = monthsBetween(from, to);
  const rows = await rowsFor(from, to, basis);
  const { ids: reversed } = await reversalExclusions(from, to);
  const cls = await reportSections();
  const catKeys = await dismissedCategoryKeys();
  const by = new Map();
  for (const r of rows) {
    if (r.direction !== 'debit' || reversed.has(r.id) || r.report_dismissed) continue;
    const parts = txnParts(r);
    const amounts = splitUsd(txnUsd(r), parts);
    parts.forEach((p, i) => {
      if (cls.section('expense', p.cat) !== 'operating') return;
      if (catKeys.size && catKeys.has(cellKeyOf('expense', p.cat))) return;
      const key = dim === 'rep'
        ? (String(r.m_rep || '').trim() || 'No rep')
        : (String(r.m_payee || r.payee_guess || r.description || '').trim() || 'Unnamed');
      const slot = by.get(key) || { key, series: Object.fromEntries(months.map((m) => [m, 0])), total: 0, count: 0, categories: {} };
      slot.series[r.report_month] = (slot.series[r.report_month] || 0) + amounts[i];
      slot.total += amounts[i];
      slot.count += 1;
      slot.categories[p.cat] = (slot.categories[p.cat] || 0) + amounts[i];
      by.set(key, slot);
    });
  }
  const list = [...by.values()]
    .map((s) => ({ ...s, total: round2(s.total), series: Object.fromEntries(Object.entries(s.series).map(([m, v]) => [m, round2(v)])),
      top_category: Object.entries(s.categories).sort((a, b) => b[1] - a[1])[0]?.[0] || null }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  return { from, to, basis, basis_label: BASIS_LABEL[basis], dim, months, rows: list, total: round2(list.reduce((s, r) => s + r.total, 0)), count: list.length };
}

// GET /api/reports/spend-by?dim=vendor|rep&from=&to=&basis=
router.get('/spend-by', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const to = String(req.query.to || new Date().toISOString().slice(0, 10));
    const from = String(req.query.from || `${to.slice(0, 4)}-01-01`);
    const badRange = rangeProblem(from, to);
    if (badRange) return res.status(400).json({ success: false, error: badRange });
    const dim = req.query.dim === 'rep' ? 'rep' : 'vendor';
    res.json({ success: true, data: await buildSpendBy(from, to, basisParam(req.query.basis) || 'bank', dim) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/reports/intake?from=&to= — invoices RECEIVED by month (vendor
// invoices arriving, by invoice date; bank-born rows are not invoices), with
// the pending / approved / paid split. Basis-free: this is the inflow of
// paperwork, not money.
router.get('/intake', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const to = String(req.query.to || new Date().toISOString().slice(0, 10));
    const from = String(req.query.from || `${to.slice(0, 4)}-01-01`);
    const badRange = rangeProblem(from, to);
    if (badRange) return res.status(400).json({ success: false, error: badRange });
    const months = monthsBetween(from, to);
    const { rows } = await pool.query(`
      SELECT to_char(COALESCE(e.invoice_date, e.created_at::date), 'YYYY-MM') AS month, e.status, e.payment_status,
             e.amount, COALESCE(e.currency, 'USD') AS currency, e.fx_rate_to_usd
        FROM expenses e
       WHERE e.parent_id IS NULL AND e.status IN ('pending', 'approved')
         AND (e.deleted = false OR e.deleted IS NULL) AND (e.voided = false OR e.voided IS NULL)
         AND COALESCE(e.entry_source, '') <> 'bank_statement'
         AND COALESCE(e.invoice_date, e.created_at::date) BETWEEN $1 AND $2`, [from, to]);
    const series = Object.fromEntries(months.map((m) => [m, { count: 0, usd: 0, pending_count: 0, pending_usd: 0, approved_usd: 0, paid_usd: 0 }]));
    for (const r of rows) {
      const s = series[r.month]; if (!s) continue;
      const v = usdOf(r.amount, r.currency, r.fx_rate_to_usd) || 0;
      s.count += 1; s.usd += v;
      if (r.status === 'pending') { s.pending_count += 1; s.pending_usd += v; }
      else if (r.payment_status === 'Paid') s.paid_usd += v;
      else s.approved_usd += v;
    }
    for (const s of Object.values(series)) for (const k of Object.keys(s)) if (k.endsWith('usd')) s[k] = round2(s[k]);
    res.json({ success: true, data: { from, to, months, series, total: round2(Object.values(series).reduce((t, s) => t + s.usd, 0)), count: rows.length } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/reports/budget-vs-actual?from=&to=&basis= — the simple artist
// budget sheet (Advance, Total marketing) against the P&L's own per-artist
// figures: marketing spent in the range and over all time, advance paid over
// all time. Left = budget − lifetime, because a budget is not a per-month thing.
router.get('/budget-vs-actual', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const to = String(req.query.to || new Date().toISOString().slice(0, 10));
    const from = String(req.query.from || `${to.slice(0, 4)}-01-01`);
    const badRange = rangeProblem(from, to);
    if (badRange) return res.status(400).json({ success: false, error: badRange });
    const basis = basisParam(req.query.basis) || 'bank';
    const [range, life, { rows: budgets }, { rows: roster }] = await Promise.all([
      buildPnl(from, to, null, { basis }),
      buildPnl('2000-01-01', to, null, { basis }),
      pool.query(`SELECT artist_key, section, amount FROM artist_budget_sections WHERE section IN ('advance', 'marketing')`).catch(() => ({ rows: [] })),
      pool.query(`SELECT id, name FROM artists WHERE (archived = false OR archived IS NULL)`),
    ]);
    const byKey = {};
    const slot = (k) => (byKey[k] = byKey[k] || { key: k, name: null, artist_id: null, budget_marketing: 0, budget_advance: 0, spent_marketing_range: 0, spent_marketing_life: 0, advance_paid_life: 0 });
    for (const b of budgets) { const s = slot(b.artist_key); if (b.section === 'advance') s.budget_advance = Number(b.amount) || 0; else s.budget_marketing = Number(b.amount) || 0; }
    for (const a of (range.by_artist?.artists || [])) { if (a.key) { const s = slot(a.key); s.spent_marketing_range = a.total; s.name = s.name || a.name; } }
    for (const a of (life.by_artist?.artists || [])) { if (a.key) { const s = slot(a.key); s.spent_marketing_life = a.total; s.name = s.name || a.name; } }
    for (const a of (life.advances_by_artist?.artists || [])) { if (a.key) { const s = slot(a.key); s.advance_paid_life = a.total; s.name = s.name || a.name; } }
    for (const r of roster) { const k = artistBucketKey(r.name); if (byKey[k]) { byKey[k].name = r.name; byKey[k].artist_id = r.id; } }
    const rows = Object.values(byKey).map((s) => ({
      ...s, name: s.name || s.key,
      left_marketing: s.budget_marketing ? round2(s.budget_marketing - s.spent_marketing_life) : null,
      left_advance: s.budget_advance ? round2(s.budget_advance - s.advance_paid_life) : null,
      over_marketing: s.budget_marketing > 0 && s.spent_marketing_life > s.budget_marketing,
      has_budget: s.budget_marketing > 0 || s.budget_advance > 0,
    })).sort((a, b) => (b.has_budget - a.has_budget) || (b.budget_marketing + b.budget_advance) - (a.budget_marketing + a.budget_advance) || b.spent_marketing_life - a.spent_marketing_life);
    const sum = (f) => round2(rows.reduce((t, r) => t + (r[f] || 0), 0));
    res.json({ success: true, data: { from, to, basis, basis_label: BASIS_LABEL[basis], rows,
      totals: { budget_marketing: sum('budget_marketing'), spent_marketing_range: sum('spent_marketing_range'), spent_marketing_life: sum('spent_marketing_life'), budget_advance: sum('budget_advance'), advance_paid_life: sum('advance_paid_life') },
      budgeted: rows.filter((r) => r.has_budget).length, over: rows.filter((r) => r.over_marketing).length } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── The accountant pack ─────────────────────────────────────────────────────
// One workbook: Cover (who, what range, which basis, reconciled through, what
// was excluded), P&L, Balance sheet as of the range end, Spend by artist, by
// vendor, by rep, and the Dismissed list. Downloaded from the page or sent on
// a day of the month by lib/notifier (job accountant_pack) to the recipients
// in report_pack_settings.
async function ensurePackSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS report_pack_settings (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled BOOLEAN NOT NULL DEFAULT FALSE, day INTEGER NOT NULL DEFAULT 5,
    recipients TEXT NOT NULL DEFAULT '', basis TEXT NOT NULL DEFAULT 'bank',
    last_sent_period TEXT, last_sent_at TIMESTAMPTZ, last_error TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(), updated_by INTEGER
  )`).catch(() => {});
}
async function packSettings() {
  await ensurePackSchema();
  const { rows: [r] } = await pool.query(`SELECT * FROM report_pack_settings WHERE id = 1`).catch(() => ({ rows: [] }));
  return r || { id: 1, enabled: false, day: 5, recipients: '', basis: 'bank', last_sent_period: null, last_sent_at: null, last_error: null };
}
const prevMonthRange = (now = new Date()) => {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  const to = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()).padStart(2, '0')}`;
  return { from, to };
};

async function buildPack(from, to, basis) {
  const b = basisParam(basis) || 'bank';
  const [pnl, bs, vendors, reps, label, { rows: recon }, { rows: dismissedRows }] = await Promise.all([
    buildPnl(from, to, null, { basis: b }),
    buildBalanceSheet(to).catch((e) => ({ error: e.message })),
    buildSpendBy(from, to, b, 'vendor'),
    buildSpendBy(from, to, b, 'rep'),
    pool.query(`SELECT display_name, legal_name FROM label_settings LIMIT 1`).then((r) => r.rows[0] || {}).catch(() => ({})),
    pool.query(`SELECT month_key FROM statement_months WHERE reconciled_at IS NOT NULL ORDER BY month_key DESC LIMIT 1`).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT d.scope, d.cell_kind, d.cell_key, d.reason, d.dismissed_by, d.dismissed_at,
             COALESCE(t.txn_date, e.payment_date) AS date, COALESCE(e.payee, t.payee_guess, t.description) AS payee,
             COALESCE(t.amount, e.amount) AS amount, COALESCE(e.currency, t.currency, 'USD') AS currency
        FROM report_dismissals d
        LEFT JOIN bank_transactions t ON t.id = d.txn_id
        LEFT JOIN expenses e ON e.id = d.expense_id
       ORDER BY d.dismissed_at DESC LIMIT 500`).catch(() => ({ rows: [] })),
  ]);
  const wb = new ExcelJS.Workbook();
  const fmtM = '"$"#,##0.00;[Red]("$"#,##0.00)';

  // Cover
  const cover = wb.addWorksheet('Cover', { views: [{ showGridLines: false }] });
  cover.columns = [{ width: 28 }, { width: 70 }];
  const line = (a, bv, bold = false) => { const r = cover.addRow([a, bv]); if (bold) r.font = { bold: true }; return r; };
  line(label.display_name || label.legal_name || 'market.st', 'Accountant pack', true).font = { bold: true, size: 14 };
  line('Period', `${from} to ${to}`);
  line('Basis', `${BASIS_LABEL[b]} — ${b === 'bank' ? 'every bank line once; the ledger supplies categories. Paid invoices no statement vouches for are listed, not counted.' : b === 'ledger' ? 'every approved row marked Paid, by payment date, whether or not a bank statement covers it.' : 'every approved row by invoice date, paid or not (commitments).'}`);
  line('Bank reconciled through', recon[0]?.month_key || 'no month reconciled yet');
  line('Balance sheet as of', to);
  line('Generated', new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
  cover.addRow([]);
  line('Income (operating)', round2(pnl.income_totals?.total || 0)).getCell(2).numFmt = fmtM;
  line('Expenses (operating)', round2(pnl.expense_totals?.total || 0)).getCell(2).numFmt = fmtM;
  line('Net (operating)', round2(pnl.net?.total || 0), true).getCell(2).numFmt = fmtM;
  line('Below the line — expenses', round2(pnl.below?.expense_totals?.total || 0)).getCell(2).numFmt = fmtM;
  line('Non-recurring — expenses', round2(pnl.non_recurring?.expense_totals?.total || 0)).getCell(2).numFmt = fmtM;
  cover.addRow([]);
  line('Excluded, disclosed', '', true);
  line('Dismissed items', `${pnl.dismissed?.count || 0} items, ${round2(pnl.dismissed?.total || 0)} USD — see the Dismissed sheet`);
  line('Reversal pairs', `${pnl.reversals?.count || 0} rows, ${round2(pnl.reversals?.total || 0)} USD (money that never moved)`);
  if (b === 'bank') line('Paid in ledger, no bank line', `${pnl.unverified?.count || 0} rows, ${round2(pnl.unverified?.total || 0)} USD — listed on the P&L, not counted`);
  line('Month reassignments', `${pnl.reassigned?.count || 0} moved in, ${pnl.reassigned?.moved_out?.count || 0} moved out`);
  cover.addRow([]);
  line('Sheets', 'P&L · Balance sheet · Spend by artist · Spend by vendor · Spend by rep · Dismissed');
  line('Prepared by', 'market.st dashboard — every figure opens to its rows on the Reports page');

  renderExcel(wb, 'P&L', pnlRows(pnl, { from, to, artist: null }));
  if (!bs.error) renderExcel(wb, 'Balance sheet', balanceSheetRows(bs, { as_of: to }));
  else { const ws = wb.addWorksheet('Balance sheet'); ws.addRow(['Balance sheet could not be built', bs.error]); }
  const sba = { ...pnl.by_artist, excluded: {
    below_line: pnl.below?.expense_totals?.total || 0, non_recurring: pnl.non_recurring?.expense_totals?.total || 0,
    dismissed: { total: pnl.dismissed?.total || 0, count: pnl.dismissed?.count || 0 },
    reversals: { total: pnl.reversals?.total || 0, count: pnl.reversals?.count || 0 },
    unverified: { total: pnl.unverified?.total || 0, count: pnl.unverified?.count || 0 } } };
  renderExcel(wb, 'Spend by artist', spendByArtistRows(sba, { from, to, topN: 0 }));

  const simple = (name, data, keyLabel) => {
    const ws = wb.addWorksheet(name, { views: [{ showGridLines: false, state: 'frozen', xSplit: 1, ySplit: 1 }] });
    const header = ws.addRow([keyLabel, ...data.months, 'Total', 'Rows', 'Top category']);
    styleHeader(header);
    ws.getColumn(1).width = 36;
    for (const r of data.rows) {
      const row = ws.addRow([r.key, ...data.months.map((m) => r.series[m] || 0), r.total, r.count, r.top_category || '']);
      for (let i = 2; i <= data.months.length + 2; i += 1) row.getCell(i).numFmt = fmtM;
    }
    const t = ws.addRow(['Total', ...data.months.map((m) => round2(data.rows.reduce((s, r) => s + (r.series[m] || 0), 0))), data.total, data.rows.reduce((s, r) => s + r.count, 0), '']);
    t.font = { bold: true };
    for (let i = 2; i <= data.months.length + 2; i += 1) t.getCell(i).numFmt = fmtM;
    ws.addRow([]);
    ws.addRow([`Operating spend only, ${data.basis_label}. Dismissed, reversed, below-the-line and non-recurring rows are excluded — the same total as the P&L's operating expenses.`]);
  };
  simple('Spend by vendor', vendors, 'Vendor');
  simple('Spend by rep', reps, 'Rep');

  const dws = wb.addWorksheet('Dismissed', { views: [{ showGridLines: false, state: 'frozen', ySplit: 1 }] });
  styleHeader(dws.addRow(['Date', 'Payee', 'Amount', 'Currency', 'Scope', 'Line', 'Reason', 'By', 'When']));
  dws.columns.forEach((c, i) => { c.width = [12, 36, 14, 8, 10, 24, 40, 12, 20][i] || 14; });
  for (const d of dismissedRows) dws.addRow([d.date ? String(d.date).slice(0, 10) : '', d.payee || '', d.amount != null ? Number(d.amount) : '', d.currency, d.scope || 'item', d.cell_key || '', d.reason || '', d.dismissed_by || '', d.dismissed_at ? new Date(d.dismissed_at).toISOString().slice(0, 16).replace('T', ' ') : '']);
  if (!dismissedRows.length) dws.addRow(['Nothing has been dismissed.']);

  return { workbook: wb, filename: `marketst-accountant-pack-${from}-to-${to}.xlsx`, summary: { basis: b, from, to, net: round2(pnl.net?.total || 0), income: round2(pnl.income_totals?.total || 0), expenses: round2(pnl.expense_totals?.total || 0), dismissed: pnl.dismissed?.count || 0, reconciled_through: recon[0]?.month_key || null } };
}

// Send the pack for a range to the recipients. Used by POST /pack/send and
// the notifier's monthly job. Records the outcome on the settings row.
async function sendPack({ from, to, basis, recipients, trigger = 'manual', period = null }) {
  const list = String(recipients || '').split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /.+@.+\..+/.test(s));
  if (!list.length) throw new Error('No recipients: add at least one email address');
  const { sendMail } = require('../lib/mail');
  const { layout, p, rows: lrows } = require('../lib/email-layout');
  const pack = await buildPack(from, to, basis);
  const buf = Buffer.from(await pack.workbook.xlsx.writeBuffer());
  const s = pack.summary;
  const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);
  const html = layout({
    title: `Accountant pack — ${from} to ${to}`, eyebrow: 'Reports', accent: 'forest',
    body: p(`The attached workbook holds the P&L, balance sheet as of ${to}, spend by artist, vendor and rep, and every dismissed item, on the <strong>${BASIS_LABEL[s.basis]}</strong> basis.`)
      + lrows([['Income (operating)', fmt(s.income)], ['Expenses (operating)', fmt(s.expenses)], ['Net (operating)', fmt(s.net)], ['Dismissed items', String(s.dismissed)], ['Bank reconciled through', s.reconciled_through || 'no month reconciled yet']])
      + p('Every figure opens to the rows behind it on the Reports page.'),
    cta: { label: 'Open Reports', href: `${require('../lib/email-layout').APP_URL}/reports?from=${from}&to=${to}&basis=${s.basis}` },
  });
  try {
    await sendMail({ purpose: 'team', kind: 'accountant_pack', to: list.join(', '), subject: `Accountant pack — ${from} to ${to} (${BASIS_LABEL[s.basis]})`, html,
      attachments: [{ filename: pack.filename, data: buf.toString('base64'), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }], entity: { type: 'report_pack', id: period || `${from}:${to}` } });
    await ensurePackSchema();
    await pool.query(`INSERT INTO report_pack_settings (id, last_sent_period, last_sent_at, last_error) VALUES (1, $1, NOW(), NULL)
      ON CONFLICT (id) DO UPDATE SET last_sent_period = COALESCE($1, report_pack_settings.last_sent_period), last_sent_at = NOW(), last_error = NULL`, [period]).catch(() => {});
    return { sent_to: list, filename: pack.filename, summary: s, trigger };
  } catch (e) {
    await pool.query(`UPDATE report_pack_settings SET last_error = $1 WHERE id = 1`, [e.message]).catch(() => {});
    throw e;
  }
}

// GET /api/reports/pack.xlsx?from=&to=&basis=
router.get('/pack.xlsx', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const to = String(req.query.to || new Date().toISOString().slice(0, 10));
    const from = String(req.query.from || `${to.slice(0, 4)}-01-01`);
    const badRange = rangeProblem(from, to);
    if (badRange) return res.status(400).json({ success: false, error: badRange });
    const pack = await buildPack(from, to, basisParam(req.query.basis) || 'bank');
    const buf = await pack.workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${pack.filename}"`);
    res.send(Buffer.from(buf));
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET / PUT /api/reports/pack/settings — enabled, day of month, recipients, basis.
router.get('/pack/settings', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const s = await packSettings();
    res.json({ success: true, data: { ...s, next_range: prevMonthRange(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)) } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
router.put('/pack/settings', async (req, res) => {
  try {
    if (!req.user || !['Admin', 'Superadmin'].includes(req.user.role)) return res.status(403).json({ success: false, error: 'Admin required' });
    await ensurePackSchema();
    const cur = await packSettings();
    const b = req.body || {};
    const enabled = typeof b.enabled === 'boolean' ? b.enabled : cur.enabled;
    const day = Number.isInteger(Number(b.day)) ? Math.max(1, Math.min(28, Number(b.day))) : cur.day;
    const recipients = typeof b.recipients === 'string' ? b.recipients.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean).join(', ') : cur.recipients;
    const basis = basisParam(b.basis) || cur.basis || 'bank';
    if (enabled && !recipients) return res.status(400).json({ success: false, error: 'Add at least one recipient before turning the monthly pack on' });
    const { rows: [r] } = await pool.query(`INSERT INTO report_pack_settings (id, enabled, day, recipients, basis, updated_at, updated_by) VALUES (1, $1, $2, $3, $4, NOW(), $5)
      ON CONFLICT (id) DO UPDATE SET enabled = $1, day = $2, recipients = $3, basis = $4, updated_at = NOW(), updated_by = $5 RETURNING *`, [enabled, day, recipients, basis, req.user.id]);
    res.json({ success: true, data: r });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/reports/pack/send { from?, to?, basis?, recipients? } — send it now.
router.post('/pack/send', async (req, res) => {
  try {
    if (!req.user || !['Admin', 'Superadmin'].includes(req.user.role)) return res.status(403).json({ success: false, error: 'Admin required' });
    const cur = await packSettings();
    const range = prevMonthRange();
    const from = String(req.body?.from || range.from), to = String(req.body?.to || range.to);
    const badRange = rangeProblem(from, to);
    if (badRange) return res.status(400).json({ success: false, error: badRange });
    const out = await sendPack({ from, to, basis: basisParam(req.body?.basis) || cur.basis || 'bank', recipients: req.body?.recipients || cur.recipients, trigger: `manual:${req.user.id}` });
    res.json({ success: true, data: out });
  } catch (err) {
    const code = err.code === 'MAIL_NOT_CONNECTED' ? 409 : (/No recipients/.test(err.message) ? 400 : 500);
    res.status(code).json({ success: false, error: err.message });
  }
});

router.get('/pnl/export', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const to = String(req.query.to || new Date().toISOString().slice(0, 10));
    const from = String(req.query.from || `${to.slice(0, 4)}-01-01`);
    const badRange = rangeProblem(from, to);
    if (badRange) return res.status(400).json({ success: false, error: badRange });
    const artist = String(req.query.artist || '').trim() || null;
    const pnl = await buildPnl(from, to, artist, { basis: basisParam(req.query.basis) });

    const wb = new ExcelJS.Workbook();
    renderExcel(wb, 'P&L', pnlRows(pnl, { from, to, artist }));

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="marketst-pnl-${from}-to-${to}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Same two-renderers-one-model contract as the P&L export: this builds the row
// model and hands it to renderExcel, so the Google Sheets writer can serve the
// identical sheet without a second layout.
//
// EVERY artist by default. This used to show the top 25 and collapse the rest
// into one "Other artists (82)" line — sensible for a glance, wrong for the
// document John hands to an accountant, who is looking for a named artist and
// cannot find them inside a bucket. Pass ?topN=25 to get the old shape back.
router.get('/spend-by-artist/export', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const to = String(req.query.to || new Date().toISOString().slice(0, 10));
    const from = String(req.query.from || `${to.slice(0, 4)}-01-01`);
    const badRange = rangeProblem(from, to);
    if (badRange) return res.status(400).json({ success: false, error: badRange });
    const topNRaw = req.query.topN === undefined ? 0 : parseInt(req.query.topN, 10);
    const topN = Number.isFinite(topNRaw) ? Math.max(0, Math.min(500, topNRaw)) : 0;

    const pnl = await buildPnl(from, to, null, { basis: basisParam(req.query.basis) });
    const data = {
      ...pnl.by_artist,
      excluded: {
        below_line:    pnl.below?.expense_totals?.total || 0,
        non_recurring: pnl.non_recurring?.expense_totals?.total || 0,
        dismissed:  { total: pnl.dismissed?.total || 0,  count: pnl.dismissed?.count || 0 },
        reversals:  { total: pnl.reversals?.total || 0,  count: pnl.reversals?.count || 0 },
        unverified: { total: pnl.unverified?.total || 0, count: pnl.unverified?.count || 0 },
      },
    };

    const wb = new ExcelJS.Workbook();
    renderExcel(wb, 'Spend by Artist', spendByArtistRows(data, { from, to, topN }));

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="marketst-spend-by-artist-${from}-to-${to}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/balance-sheet/export', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });
    const asOf = String(req.query.as_of || new Date().toISOString().slice(0, 10));
    if (!isValidDay(asOf)) return res.status(400).json({ success: false, error: 'as_of must be a YYYY-MM-DD date' });
    const bs = await buildBalanceSheet(asOf);

    const wb = new ExcelJS.Workbook();
    renderExcel(wb, 'Balance Sheet', balanceSheetRows(bs, { asOf, ymd }));

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="marketst-balance-sheet-${asOf}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    res.status(err instanceof BalanceSheetRangeError ? 400 : 500)
      .json({ success: false, error: err.message });
  }
});

// ── Google Sheets ────────────────────────────────────────────────────────────
//
// Writes BOTH tabs into one long-lived spreadsheet, refreshed in place, so the
// URL can be bookmarked and shared with the accountant once. Deliberately not a
// per-export file: a Drive full of near-identical "marketst-pnl-…" sheets is how
// someone ends up filing from the wrong one.
//
// Both tabs are written on every call regardless of which view the page is
// showing, because a spreadsheet whose two tabs were generated from different
// runs — and therefore possibly different data — is worse than useless. They are
// always as-of the same moment.
router.post('/export-google-sheet', async (req, res) => {
  try {
    if (!isBkAdmin(req.user)) return res.status(403).json({ success: false, error: 'Admin required' });

    const to = String(req.body.to || new Date().toISOString().slice(0, 10));
    const from = String(req.body.from || `${to.slice(0, 4)}-01-01`);
    const badRange = rangeProblem(from, to);
    if (badRange) return res.status(400).json({ success: false, error: badRange });
    const artist = String(req.body.artist || '').trim() || null;
    const asOf = String(req.body.as_of || to);
    if (!isValidDay(asOf)) return res.status(400).json({ success: false, error: 'as_of must be a YYYY-MM-DD date' });

    const [pnl, bs] = await Promise.all([buildPnl(from, to, artist), buildBalanceSheet(asOf)]);

    const result = await writeReport(pool, [
      { title: 'P&L', model: pnlRows(pnl, { from, to, artist }) },
      { title: 'Balance Sheet', model: balanceSheetRows(bs, { asOf, ymd }) },
    ], { shareWith: req.user?.email });

    res.json({
      success: true,
      data: {
        url: result.url,
        spreadsheet_id: result.spreadsheetId,
        created: result.created,
        refreshed_at: new Date().toISOString(),
        share_warning: result.shareWarning || null,
      },
    });
  } catch (err) {
    console.error('[reports] google sheet export failed:', err.message);
    // NEVER 502/504 here. Cloudflare sits in front of this app and REPLACES an
    // origin 502 with its own branded "Bad gateway" HTML page — the JSON error
    // is discarded in transit, so the person sees a generic gateway error and
    // the actual instruction ("re-mint the token with drive.file") is lost.
    // Verified against production on 2026-08-07: the endpoint worked, Google
    // returned a normal error, and the response still arrived as Cloudflare's
    // HTML. A Google-side 4xx is a configuration problem the reader can act on,
    // so it goes back as 400; anything else is 500.
    const googleStatus = err.status || 0;
    const status = (err instanceof BalanceSheetRangeError || err.sheetsConfigured === false
      || (googleStatus >= 400 && googleStatus < 500)) ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

module.exports = router;

// ── Exported for routes/artist-campaigns.js ─────────────────────────────────
//
// Artist Campaigns leads with what the BANK paid per artist, and that number
// already exists here: `buildPnl(...).by_artist` is bank-basis, funding-pair
// aware, part-aware, and `by_artist.total` equals the P&L expense total by
// construction. The campaigns page takes each artist's Marketing +
// Advertisements columns from it rather than writing its own SQL.
//
// A property on the router rather than an extracted lib on purpose: this file is
// 3,150 lines and moving buildPnl out of it — with bankRows, txnParts, splitUsd,
// the dismissal keys and the month overrides behind it — is a bigger risk than
// the feature asking for it. `app.use(require('./routes/reports'))` is unaffected.
//
// The rule this defends: a FIFTH surface deriving campaign money its own way is
// how $3.73M once disagreed with itself. If you need per-artist spend anywhere
// else, call this.
module.exports.buildPnl = buildPnl;
// The simple artist budget sheet (routes/artist-budgets.js) reads this so its
// "Advance" line and the P&L's advances column are one definition.
module.exports.ADVANCE_CATEGORIES = ADVANCE_CATEGORIES;
module.exports.buildPack = buildPack;
module.exports.packSettings = packSettings;
module.exports.sendPack = sendPack;
