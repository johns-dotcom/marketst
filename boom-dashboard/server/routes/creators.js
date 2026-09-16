/**
 * /api/creators — payments made to creators without an invoice.
 *
 * The marketing team pays creators directly, usually small amounts, and no
 * invoice ever exists. Before this there was nowhere to put that money: entered
 * as an ordinary hand-added expense it could never be reconciled, because
 * UNDOCUMENTED_ADDED_SQL in routes/statements.js refuses to match a bank line to
 * an undocumented hand-added row — that refusal exists so `invoice_backed_pct`
 * cannot claim a document that isn't there.
 *
 * These are ledger rows, not a separate store. `entry_source = 'creator_payment'`
 * is the only thing that distinguishes them, and it buys four behaviours for
 * free:
 *
 *   • Recoupments and Artist Campaigns filter with excludeBankRows, which a
 *     creator row passes — so they appear on both without a line of new code.
 *   • Artist Campaigns moves them Committed → Settled the moment a statement
 *     covers them, on the existing `bank_evidence IS NOT NULL` guard.
 *   • The P&L reduces over the ledger, so the money counts once, where it should.
 *   • Statement matching keys on expense ids, so they reconcile like anything
 *     else — except the match records match_method = 'creator', which keeps them
 *     out of the invoice-backed figure. Explained and documented are different
 *     claims and these rows are honestly only the first.
 *
 * They are kept OUT of the Vendors directory (see excludeCreatorRows) — that
 * directory is derived from expenses.payee and is about vendors with W9s,
 * payment terms and aliases.
 */

const express = require('express');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { requirePagePermission } = require('../middleware/pagePermission');
const { usdOf } = require('../lib/usd');
const { bankEvidenceCols } = require('../lib/bank-evidence');
const { CREATOR_SOURCE, isCreatorRow } = require('../lib/ledger-source');

const router = express.Router();
router.use(authMiddleware);
// Marketing enters these, so the grant is on this page — not on the bookkeeping
// set. An Approver or Admin reaching it through their own grants still works.
router.use(requirePagePermission('/bk/creators', '/bk/ledger'));

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * The calendar year of a DATE column, and its YYYY-MM-DD.
 *
 * node-postgres hands back a JS Date for a DATE column, so `String(d).slice(0,4)`
 * yields "Mon " rather than "2026" — every payment would land in one nonsense
 * bucket and the $600 warning would never fire. Local getFullYear is right here
 * because pg builds that Date at LOCAL midnight for the stored calendar day;
 * reaching for getUTCFullYear would shift a 1 January payment into the year
 * before for anyone west of UTC.
 */
const yearOf = (d) => {
  if (!d) return 'undated';
  if (d instanceof Date) return String(d.getFullYear());
  return String(d).slice(0, 4);
};
const dayOf = (d) => {
  if (!d) return null;
  if (!(d instanceof Date)) return String(d).slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * A creator payment's value in dollars.
 *
 * usdOf DIVIDES by the stored rate and is the only conversion allowed here.
 * `amount_usd` falls back to face value on a foreign row and once reported
 * $6,159,482 against a page showing $5,772,443.
 */
const rowUsd = (e) => usdOf(e.amount, e.currency, e.fx_rate_to_usd);

// Every column the page reads. Leaf rows only where a total is computed — a
// split parent's children carry the real attribution and counting both doubles
// the family.
const LIVE = `
  (e.deleted IS NULL OR e.deleted = FALSE)
  AND (e.voided IS NULL OR e.voided = FALSE)
  AND ${isCreatorRow('e')}
`;

// ── GET / — the ledger ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { q, artist, creator, from, to } = req.query;
    const where = [LIVE];
    const args = [];
    // One placeholder per pushed value, numbered from the array itself. An
    // earlier version templated the numbers ahead of the push and happened to
    // work only while `q` was the first filter applied.
    const put = (v) => { args.push(v); return `$${args.length}`; };
    if (q) {
      const p = put(`%${q}%`);
      where.push(`(LOWER(e.payee) LIKE LOWER(${p}) OR LOWER(e.vendor_email) LIKE LOWER(${p})
                   OR LOWER(e.paypal_handle) LIKE LOWER(${p}) OR LOWER(e.song) LIKE LOWER(${p})
                   OR LOWER(e.artist) LIKE LOWER(${p}))`);
    }
    if (artist)  where.push(`LOWER(e.artist) = LOWER(${put(artist)})`);
    if (creator) where.push(`LOWER(e.payee) = LOWER(${put(creator)})`);
    if (from)    where.push(`e.payment_date >= ${put(from)}`);
    if (to)      where.push(`e.payment_date <= ${put(to)}`);

    const { rows } = await pool.query(`
      SELECT e.id, e.payee, e.vendor_email, e.paypal_handle, e.social_handles,
             e.artist, e.song, e.amount, e.currency, e.fx_rate_to_usd,
             e.category, e.payment_date, e.payment_method, e.notes, e.boom_rep,
             -- payment_status was MISSING, and the page reads it: recoupState is
             -- "payment_status is not Paid, therefore unpaid", so every creator
             -- payment rendered as Unpaid while being Paid in the database. All 5
             -- live rows read wrong. Omitting a column the client branches on is
             -- the same class of bug as omitting one from EXPENSE_LIGHT_COLS.
             -- NB: no backticks in here — this is a JS template literal.
             e.payment_status,
             e.recoupable, e.ufr, e.created_at, e.created_by,
             ${bankEvidenceCols('e')}
        FROM expenses e
       WHERE ${where.join(' AND ')}
       ORDER BY e.payment_date DESC NULLS LAST, e.id DESC
       LIMIT 1000`, args);

    for (const r of rows) r.amount_usd_calc = r2(rowUsd(r));
    // Round ONCE, at the row, then sum. Summing rounded components broke a
    // tie-out here by exactly $0.01 before.
    const total = r2(rows.reduce((t, r) => t + rowUsd(r), 0));
    res.json({ success: true, data: rows, total, count: rows.length });
  } catch (err) {
    console.error('GET /api/creators:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /directory — one row per creator ────────────────────────────────────
//
// W9 exposure is computed PER CREATOR PER CALENDAR YEAR, not per payment. A
// per-ENTRY has_w9 count is the documented trap that once reported 51.4% W9
// coverage against a real 97.1% — the form belongs to the person, not the row.
router.get('/directory', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.id, e.payee, e.vendor_email, e.paypal_handle, e.social_handles,
             e.amount, e.currency, e.fx_rate_to_usd, e.payment_date, e.artist,
             (e.w9_r2_key IS NOT NULL OR e.w9_filename IS NOT NULL) AS has_w9
        FROM expenses e
       WHERE ${LIVE}
         AND e.payee IS NOT NULL AND e.payee <> ''`);

    const byCreator = new Map();
    for (const r of rows) {
      const key = String(r.payee).trim().toLowerCase();
      if (!byCreator.has(key)) {
        byCreator.set(key, {
          payee: r.payee, email: null, paypal_handle: null, social_handles: null,
          w9_on_file: false, payments: 0, total: 0, by_year: {}, artists: new Set(),
          last_payment: null,
        });
      }
      const c = byCreator.get(key);
      // First non-empty wins for contact details — a later blank must not erase
      // a handle somebody already recorded.
      c.email = c.email || r.vendor_email || null;
      c.paypal_handle = c.paypal_handle || r.paypal_handle || null;
      if (!c.social_handles && Array.isArray(r.social_handles) && r.social_handles.length) {
        c.social_handles = r.social_handles;
      }
      if (r.has_w9) c.w9_on_file = true;
      if (r.artist) c.artists.add(r.artist);
      const usd = rowUsd(r);
      c.payments += 1;
      c.total += usd;
      const year = yearOf(r.payment_date);
      c.by_year[year] = (c.by_year[year] || 0) + usd;
      const day = dayOf(r.payment_date);
      if (day && (!c.last_payment || day > c.last_payment)) c.last_payment = day;
    }

    const THRESHOLD = 600;
    const out = [...byCreator.values()].map((c) => {
      const by_year = Object.fromEntries(Object.entries(c.by_year).map(([y, v]) => [y, r2(v)]));
      // A year is exposed when it crosses the threshold and no W9 exists for
      // that creator. Rounded per year, then compared — the threshold is a
      // dollar figure, so comparing the raw float would flag $599.995.
      const years_over = Object.entries(by_year)
        .filter(([y, v]) => y !== 'undated' && v >= THRESHOLD)
        .map(([y]) => y);
      return {
        ...c,
        artists: [...c.artists].sort(),
        total: r2(c.total),
        by_year,
        years_over,
        w9_required: years_over.length > 0,
        w9_missing: years_over.length > 0 && !c.w9_on_file,
      };
    }).sort((a, b) => b.total - a.total);

    res.json({
      success: true,
      data: out,
      summary: {
        creators: out.length,
        total: r2(out.reduce((t, c) => t + c.total, 0)),
        w9_missing: out.filter((c) => c.w9_missing).length,
        w9_missing_value: r2(out.filter((c) => c.w9_missing).reduce((t, c) => t + c.total, 0)),
        threshold: THRESHOLD,
      },
    });
  } catch (err) {
    console.error('GET /api/creators/directory:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST / — record a payment ───────────────────────────────────────────────
//
// Straight into the ledger as approved, per John: the money has already left.
// Defaults are what make the row visible where it belongs — category 'Marketing'
// because Artist Campaigns counts only ['Marketing', 'Advertisements'], and
// payment_status 'Paid' because an unpaid creator payment is not a thing.
// Paid, or committed-but-not-yet-paid?
//
// These rows used to be created `payment_status = 'Paid'` unconditionally with the
// date defaulting to today, so there was no way to log "we owe this creator" —
// and no way to mark anything as paid, because everything already was. The
// marketing team commits before it pays, so both states have to exist.
//
// Default stays PAID: that is the common case (the payment is usually made and
// then logged), and flipping the default would silently turn every existing habit
// into an unpaid pile.
function paidState(b) {
  const explicitlyUnpaid = b.payment_status === 'Unpaid' || b.paid === false;
  if (explicitlyUnpaid) return { payment_status: 'Unpaid', payment_date: null };
  return {
    payment_status: 'Paid',
    payment_date: b.payment_date || new Date().toISOString().slice(0, 10),
  };
}

router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    // The SAME rule the batch endpoint uses. Two write paths with two notions of
    // "complete" is how one of them quietly becomes the way to skip the other.
    const gaps = missingRequired(b);
    if (gaps.length) {
      return res.status(400).json({ success: false, error: `This payment needs ${gaps.join(', ')}` });
    }
    const payee = String(b.payee).replace(/\s+/g, ' ').trim();
    const amount = Number(b.amount);
    const socials = Array.isArray(b.social_handles) ? b.social_handles : null;
    const { rows: [row] } = await pool.query(`
      INSERT INTO expenses (
        payee, vendor_email, paypal_handle, social_handles,
        artist, song, amount, currency, fx_rate_to_usd, category, description, notes,
        payment_date, invoice_date, payment_method, payment_status, status,
        entry_source, boom_rep, created_by, created_at)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$17,'PayPal',$18,'approved',
              $14,$15,$16,NOW())
      RETURNING *`,
      [payee, b.vendor_email || null, b.paypal_handle || null,
        socials ? JSON.stringify(socials) : null,
        b.artist || null, b.song || null, amount, (b.currency || 'USD').toUpperCase(),
        b.fx_rate_to_usd || null, b.category || 'Marketing', b.description || null,
        b.notes || null, paidState(b).payment_date,
        CREATOR_SOURCE, b.boom_rep || req.user?.name || null, req.user?.name || null,
        // invoice_date stays today even when the payment has not happened — the
        // commitment is dated now; the PAYMENT is what is outstanding.
        new Date().toISOString().slice(0, 10), paidState(b).payment_status]);
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    console.error('POST /api/creators:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /batch — several creators in one go ────────────────────────────────
//
// John: "some are bulk deals. Add the ability to add multiple artists and songs
// and multiple creators, with the ability to assign those creators to different
// songs/artists."
//
// SEPARATE PAYMENTS, not one split. PayPal sends one transaction per recipient,
// so five creators paid for one song is five statement lines and must be five
// rows — each matching its own line. A split family would give one parent
// looking for one bank line that never exists.
//
// The bulk-deal marker rides on every row so the family is findable as one
// piece of work afterwards: `is_bulk_deal` is the column /bk/bulk-deals already
// reads, and `description` carries the deal name.
//
// All-or-nothing. Half a bulk deal in the ledger is worse than none, because
// the missing half is invisible — nobody knows to look for it.
router.post('/batch', async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const rows = Array.isArray(b.payments) ? b.payments : [];
    if (!rows.length) return res.status(400).json({ success: false, error: 'No payments to record' });

    // Validate EVERY row before writing ANY of them — reporting "row 4 is
    // missing an amount" after rows 1-3 are already in the ledger makes the
    // person clean up a half-written batch.
    const problems = [];
    rows.forEach((r, i) => {
      const gaps = missingRequired(r);
      if (gaps.length) problems.push(`Creator ${i + 1} needs ${gaps.join(', ')}`);
    });
    if (problems.length) return res.status(400).json({ success: false, error: problems.join('; ') });

    await client.query('BEGIN');
    const made = [];
    for (const r of rows) {
      const socials = Array.isArray(r.social_handles) && r.social_handles.length ? r.social_handles : null;
      const { rows: [row] } = await client.query(`
        INSERT INTO expenses (
          payee, vendor_email, paypal_handle, social_handles,
          artist, song, amount, currency, category, description, notes,
          payment_date, invoice_date, payment_method, payment_status, status,
          entry_source, is_bulk_deal, boom_rep, created_by, created_at)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$17,'PayPal',$18,'approved',
                $13,$14,$15,$16,NOW())
        RETURNING id, payee, amount, artist, song`,
        [String(r.payee).replace(/\s+/g, ' ').trim(), r.vendor_email || null, r.paypal_handle || null,
          socials ? JSON.stringify(socials) : null,
          // Each row carries its OWN artist and song. That is the whole point:
          // one bulk deal can span several artists and several songs, and
          // crediting them all to the first row's artist is the attribution bug
          // this shape exists to avoid.
          r.artist || b.artist || null, r.song || b.song || null,
          Number(r.amount), (r.currency || b.currency || 'USD').toUpperCase(),
          r.category || b.category || 'Marketing',
          // `deal_name` is gone from the form — it only ever landed here, in
          // `description`, and nothing read it back out. A row's own description
          // is what remains.
          r.description || null, r.notes || b.notes || null,
          // Per ROW where given, else the batch's answer. An unpaid batch has no
          // payment date at all: paidState clears it, so a row cannot carry a
          // date it has not earned.
          paidState({ ...b, payment_date: r.payment_date || b.payment_date }).payment_date,
          CREATOR_SOURCE, b.is_bulk_deal === true,
          b.boom_rep || req.user?.name || null, req.user?.name || null,
          // invoice_date is TODAY regardless: the commitment is dated now, and
          // the payment is what may still be outstanding.
          new Date().toISOString().slice(0, 10),
          paidState(b).payment_status]);
      made.push(row);
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: {
      created: made.length,
      total: r2(made.reduce((t, m) => t + Number(m.amount || 0), 0)),
      artists: [...new Set(made.map((m) => m.artist).filter(Boolean))],
      songs: [...new Set(made.map((m) => m.song).filter(Boolean))],
      rows: made,
    } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/creators/batch:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ── PUT /:id ────────────────────────────────────────────────────────────────
router.put('/:id(\\d+)', async (req, res) => {
  try {
    const b = req.body || {};
    // Whitelisted. An open update would let this endpoint rewrite entry_source
    // and turn a creator payment into something the no-document rule exempts by
    // accident — the exemption must stay keyed to rows created here.
    const FIELDS = ['payee', 'vendor_email', 'paypal_handle', 'artist', 'song', 'amount',
      'currency', 'fx_rate_to_usd', 'category', 'description', 'notes', 'payment_date',
      'boom_rep', 'recoupable', 'ufr'];
    const sets = [], args = [];
    // Marking paid / unpaid. Kept OUT of the loop below because the two columns
    // move together: Paid with no date, or a date with no Paid, is a row that
    // reads one way to recoupState() and the other to every date-bounded report.
    if (b.payment_status !== undefined) {
      if (!['Paid', 'Unpaid'].includes(b.payment_status)) {
        return res.status(400).json({ success: false, error: "payment_status must be 'Paid' or 'Unpaid'" });
      }
      const paid = b.payment_status === 'Paid';
      args.push(b.payment_status);
      sets.push(`payment_status = $${args.length}`);
      args.push(paid ? (b.payment_date || new Date().toISOString().slice(0, 10)) : null);
      sets.push(`payment_date = $${args.length}`);
    }
    for (const f of FIELDS) {
      if (b[f] === undefined) continue;
      // payment_date is written by the block above when the status moves, so
      // taking it here as well would put the same column in the SET list twice.
      if (f === 'payment_date' && b.payment_status !== undefined) continue;
      args.push(b[f] === '' ? null : b[f]);
      sets.push(`${f} = $${args.length}`);
    }
    if (Array.isArray(b.social_handles)) {
      args.push(JSON.stringify(b.social_handles));
      sets.push(`social_handles = $${args.length}::jsonb`);
    }
    if (!sets.length) return res.status(400).json({ success: false, error: 'Nothing to update' });
    args.push(req.params.id);
    const { rows: [row] } = await pool.query(
      `UPDATE expenses SET ${sets.join(', ')} WHERE id = $${args.length}
         AND ${isCreatorRow('expenses')} RETURNING *`, args);
    if (!row) return res.status(404).json({ success: false, error: 'Creator payment not found' });
    res.json({ success: true, data: row });
  } catch (err) {
    console.error('PUT /api/creators/:id:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /:id — soft, like every other ledger row ─────────────────────────
router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const { rows: [row] } = await pool.query(
      `UPDATE expenses SET deleted = TRUE, deleted_by = $1, deleted_at = NOW()
        WHERE id = $2 AND ${isCreatorRow('expenses')} RETURNING id, payee`,
      [req.user?.name || null, req.params.id]);
    if (!row) return res.status(404).json({ success: false, error: 'Creator payment not found' });
    res.json({ success: true, data: row });
  } catch (err) {
    console.error('DELETE /api/creators/:id:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Expenses added from Artist Campaigns and Recoupments ────────────────────
//
// Those two pages let somebody add an expense inline, and what they add is
// almost always a creator payment: measured on production 2026-08-24, 131 live
// rows (122 from artist_campaigns, 9 from recoupments), $150,560, median $120,
// 115 of them under $600, and NOT ONE with an invoice file. Names like
// "Danielonthescreen", "oejee", "Rager Club", "maro6@libero.it".
//
// They are stranded: UNDOCUMENTED_ADDED_SQL refuses to match an undocumented
// hand-added row to a bank line, so none of them can ever be reconciled while
// they sit where they are. Converting them to creator payments is what makes
// them matchable.
//
// ── Ten of them are not creator payments, and they hold 75% of the value ────
// ads (Shonci) $28,757 and META (Jerri) $21,709 are ad-platform spend.
// Gary Johnson $27,500 and Mariam Mirzoyan $30,000 are artist ADVANCES —
// recoupable against the artist, with consequences well beyond a label. Alex
// Poeppel ×4 is $5,000 of Recording.
//
// Converting those would also drop them out of the Vendors directory (creators
// are excluded from it) and take their W9s and payment terms with them. So they
// are PROPOSED FOR REVIEW rather than converted, and shown on the page with the
// reason. John's call: convert the 121, flag the ten.
//
// The rule is deliberately two plain tests rather than a hand-listed set of ids
// — a list would not classify the next row somebody adds.
// Every field a creator payment must carry, and what to call it in an error.
//
// John, 2026-08-24: "these should all be required."
//
// The point is the data, not the ceremony. The 121 rows moving in from Artist
// Campaigns and Recoupments have NO email, PayPal handle or socials, because
// those pages never asked — and that gap is why the creator directory and the
// W9 aggregate are half-blind. Requiring them here is what stops the same hole
// being dug again with every new payment.
//
// It does constrain the workflow: nobody can record a payment until they have
// all seven. That is the trade, and it is deliberate.
//
// Enforced on the SERVER, because a disabled button is not a gate — the same
// reason validateApprovalChecklist exists rather than trusting the deck.
const REQUIRED_FIELDS = [
  ['payee', 'creator name'],
  ['amount', 'amount'],
  ['artist', 'artist'],
  ['song', 'song'],
  ['vendor_email', 'email'],
  ['paypal_handle', 'PayPal handle'],
  ['social_handles', 'socials'],
];

/** What this payment is missing, in words. Empty means it is complete. */
function missingRequired(r) {
  const gaps = [];
  for (const [key, label] of REQUIRED_FIELDS) {
    if (key === 'amount') {
      const n = Number(r.amount);
      if (!Number.isFinite(n) || n <= 0) gaps.push('a positive amount');
      continue;
    }
    if (key === 'social_handles') {
      // At least ONE handle. The client sends the parsed array; a caller
      // posting the raw string gets the same answer, because a string is not
      // an array of handles.
      if (!Array.isArray(r.social_handles) || !r.social_handles.length) gaps.push('socials');
      continue;
    }
    if (!String(r[key] ?? '').trim()) gaps.push(label);
  }
  return gaps;
}

const CONVERT_CATEGORIES = ['Marketing', 'Advertisements'];
const CONVERT_MAX_USD = 5000;
const SOURCE_PAGES = ['artist_campaigns', 'recoupments'];

/** Why this row should not convert unattended, or [] if it should. */
function reviewReasons(e, usd) {
  const why = [];
  if (!CONVERT_CATEGORIES.includes(e.category)) {
    why.push(`category is ${e.category || 'unset'}, not campaign spend`);
  }
  if (usd > CONVERT_MAX_USD) {
    why.push(`$${Math.round(usd).toLocaleString()} is too large for a creator payment`);
  }
  return why;
}

/** What a converted row is still missing. Flagged, never blocking. */
function missingInfo(e) {
  const m = [];
  if (!e.vendor_email) m.push('email');
  if (!e.paypal_handle) m.push('PayPal handle');
  if (!Array.isArray(e.social_handles) || !e.social_handles.length) m.push('socials');
  if (!e.song) m.push('song');
  if (!e.artist) m.push('artist');
  return m;
}

// GET /api/creators/convertible — the candidates, classified.
router.get('/convertible', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.id, e.payee, e.amount, e.currency, e.fx_rate_to_usd, e.category,
             e.artist, e.song, e.vendor_email, e.paypal_handle, e.social_handles,
             e.payment_date, e.invoice_date, e.entry_source, e.recoupable, e.ufr,
             ${bankEvidenceCols('e')}
        FROM expenses e
       WHERE (e.deleted IS NULL OR e.deleted = FALSE)
         AND (e.voided IS NULL OR e.voided = FALSE)
         AND e.entry_source = ANY($1::text[])
         -- LEAF ROWS ONLY. A split parent's children carry the real
         -- attribution; converting both would double the family everywhere it
         -- is counted.
         AND NOT EXISTS (SELECT 1 FROM expenses c WHERE c.parent_id = e.id
                           AND (c.deleted IS NULL OR c.deleted = FALSE))
       ORDER BY e.id DESC`, [SOURCE_PAGES]);

    const out = rows.map((e) => {
      const usd = r2(rowUsd(e));
      const why = reviewReasons(e, usd);
      return {
        ...e,
        amount_usd_calc: usd,
        proposed: why.length ? 'review' : 'convert',
        review_reasons: why,
        missing: missingInfo(e),
        // Already reconciled. Converting one of these must ALSO move its
        // match to the creator disposition, or it keeps claiming a document
        // that has never existed.
        already_matched: !!e.bank_evidence,
      };
    });
    const conv = out.filter((r) => r.proposed === 'convert');
    res.json({
      success: true,
      data: out,
      summary: {
        total: out.length,
        convert: conv.length,
        review: out.length - conv.length,
        convert_value: r2(conv.reduce((t, r) => t + r.amount_usd_calc, 0)),
        review_value: r2(out.filter((r) => r.proposed === 'review').reduce((t, r) => t + r.amount_usd_calc, 0)),
        already_matched: out.filter((r) => r.already_matched).length,
      },
    });
  } catch (err) {
    console.error('GET /api/creators/convertible:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/creators/convert — { ids: [], dry_run } — move them here.
//
// UNDOABLE. Each row's previous entry_source goes into bk_audit_log before the
// write, so the whole batch can be reversed. This repo's rule: store the old
// value for undo, because a migration that cannot be reversed is a migration
// nobody dares run.
router.post('/convert', async (req, res) => {
  try {
    const ids = (req.body?.ids || []).map(Number).filter(Number.isFinite);
    const dryRun = req.body?.dry_run === true;
    if (!ids.length) return res.status(400).json({ success: false, error: 'No rows selected' });

    const { rows } = await pool.query(
      `SELECT e.id, e.payee, e.entry_source, e.payment_method
         FROM expenses e
        WHERE e.id = ANY($1::int[]) AND e.entry_source = ANY($2::text[])`,
      [ids, SOURCE_PAGES]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'None of those rows can be converted' });

    // The bank transactions pointing at them, so an already-reconciled row does
    // not keep claiming invoice-backing after it becomes a creator payment.
    const { rows: txns } = await pool.query(
      `SELECT id, matched_expense_id, match_method FROM bank_transactions
        WHERE matched_expense_id = ANY($1::int[]) AND dismissed = false`,
      [rows.map((r) => r.id)]);
    const relabel = txns.filter((t) => t.match_method !== 'creator');

    if (dryRun) {
      return res.json({ success: true, dry_run: true, data: {
        would_convert: rows.length,
        would_relabel_matches: relabel.length,
        rows: rows.map((r) => ({ id: r.id, payee: r.payee, from: r.entry_source })),
      } });
    }

    const who = req.user?.name || null;
    for (const r of rows) {
      await pool.query(
        `INSERT INTO bk_audit_log (user_name, action, entry_id, entry_payee, field, old_value, new_value, details)
         VALUES ($1, 'creator_convert', $2, $3, 'entry_source', $4, $5, $6)`,
        [who, r.id, r.payee, r.entry_source, CREATOR_SOURCE,
          `Moved to Creator Payments from ${r.entry_source}`]);
    }
    await pool.query(
      `UPDATE expenses
          SET entry_source = $1,
              -- Creator payments are PayPal by definition. Only fill a method
              -- that is missing — an ACH or Wire somebody recorded is a fact,
              -- and overwriting it would be inventing one.
              payment_method = COALESCE(payment_method, 'PayPal')
        WHERE id = ANY($2::int[])`, [CREATOR_SOURCE, rows.map((r) => r.id)]);

    if (relabel.length) {
      await pool.query(
        `UPDATE bank_transactions SET match_method = 'creator' WHERE id = ANY($1::int[])`,
        [relabel.map((t) => t.id)]);
    }

    res.json({ success: true, data: {
      converted: rows.length,
      relabelled_matches: relabel.length,
    } });
  } catch (err) {
    console.error('POST /api/creators/convert:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/creators/unconvert — put them back where they came from.
router.post('/unconvert', async (req, res) => {
  try {
    const ids = (req.body?.ids || []).map(Number).filter(Number.isFinite);
    if (!ids.length) return res.status(400).json({ success: false, error: 'No rows selected' });
    // The ORIGINAL source, read back from the audit row this conversion wrote.
    // Guessing 'artist_campaigns' would be wrong for the 9 that came from
    // Recoupments, and there would be no way to tell afterwards.
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (entry_id) entry_id, old_value
         FROM bk_audit_log
        WHERE action = 'creator_convert' AND entry_id = ANY($1::int[])
        ORDER BY entry_id, ts DESC`, [ids]);
    let n = 0;
    for (const r of rows) {
      const { rowCount } = await pool.query(
        `UPDATE expenses SET entry_source = $1 WHERE id = $2 AND ${isCreatorRow('expenses')}`,
        [r.old_value, r.entry_id]);
      n += rowCount;
    }
    res.json({ success: true, data: { reversed: n, of: ids.length } });
  } catch (err) {
    console.error('POST /api/creators/unconvert:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
