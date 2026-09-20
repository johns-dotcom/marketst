const express = require('express');
const router = express.Router();
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { TERMS, DEFAULT_TERMS, resolveDue, isDay, businessDay } = require('../lib/payment-terms');

router.use(authMiddleware);

// The invoice's own date. An invoice created today is dated today; an edit keeps
// the date the invoice was issued on, because re-saving a document must not move
// the deadline the client was given.
const dayOf = (v) => {
  if (isDay(v)) return v;
  // pg hands back a DATE/TIMESTAMP as a JS Date, and String(date).slice(0, 10) is
  // "Tue Jun 10" — not a date, so the fallback below took over and anchored on
  // TODAY. An invoice issued in June, re-termed to Net 60, came out due 60 days
  // from today instead of from June: a deadline that moves every time somebody
  // fixes a typo. Caught by back-dating a row in the fixture, because with
  // created_at = today the two answers coincide and the test proves nothing.
  //
  // Same trap lib/funding-pairs.js documents on dayStamp, where it turned a 1-day
  // gap into 9,131. UTC, via toISOString, like every other date in this codebase.
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v || '');
  if (isDay(s.slice(0, 10))) return s.slice(0, 10);
  const p = new Date(s);
  return Number.isNaN(p.getTime()) ? null : p.toISOString().slice(0, 10);
};

/**
 * The date an invoice BEARS, attached to every row this router hands out.
 *
 * Derived from `created_at` through `businessDay`, which is the same function the
 * due-date arithmetic anchors on — so the date printed on the document and the
 * date its deadline was counted from cannot be two different days. The client
 * prints this string and does no date math of its own; rendering `created_at`
 * with `toLocaleDateString` is what put them a day apart.
 */
const withInvoiceDate = (row) => {
  if (!row) return row;
  // `invoice_day` is the stored column SELECTed AS TEXT, and that cast is not
  // decoration: node-pg parses a DATE into a JS Date at LOCAL midnight, so on a
  // machine east of UTC `toISOString().slice(0, 10)` reads the day before.
  // Railway runs UTC and would never have shown it — the same coincidence of
  // configuration that hid the created_at timezone bug until somebody read a row
  // from a laptop in Los Angeles. Asking Postgres for the text is the one form
  // that cannot be misparsed.
  //
  // Null falls back to `businessDay(created_at)`, which is what this function has
  // always returned — so an invoice raised before the column existed prints the
  // date it has always printed.
  const stored = isDay(row.invoice_day) ? row.invoice_day : null;
  const { invoice_day, ...rest } = row;
  return { ...rest, invoice_date: stored || businessDay(row.created_at) };
};

// GET the terms this app offers — one list, so the dropdown cannot drift from the
// arithmetic behind it.
router.get('/terms', (req, res) => {
  res.json({ success: true, data: { terms: TERMS.map((t) => ({ label: t.label, days: t.days, custom: t.custom })), default: DEFAULT_TERMS } });
});

// GET the due date for a choice, so the live preview shows exactly what a save
// would store rather than a second implementation's opinion of it.
router.get('/due-date', async (req, res) => {
  // The anchor is the SERVER's, not the caller's. `invoice_id` re-terms an
  // existing invoice from the date it was issued; with neither that nor an
  // explicit date, a new invoice is dated today in the company's timezone. The
  // caller used to compute this and send it, which is how the preview came to
  // show a deadline counted from a different day than the one it printed.
  let issued = dayOf(req.query.date);
  if (!issued && /^\d+$/.test(String(req.query.invoice_id || ''))) {
    // A lookup failure must not break the preview: fall through to today rather
    // than 500 on a page whose only job here is to show a date.
    try {
      const { rows } = await pool.query(
        'SELECT created_at, invoice_date::text AS invoice_day FROM boom_invoices WHERE id = $1',
        [req.query.invoice_id]);
      if (rows.length) issued = (isDay(rows[0].invoice_day) ? rows[0].invoice_day : businessDay(rows[0].created_at));
    } catch { /* fall through to today */ }
  }
  if (!issued) issued = businessDay(new Date());
  const out = resolveDue(req.query.terms, issued, req.query.custom);
  // 200 with the error named: the preview asks this on every keystroke of a custom
  // date, and a half-typed date is not a failure worth a 400.
  res.json({ success: true, data: { ...out, invoice_date: issued } });
});

// GET all invoices
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT *, invoice_date::text AS invoice_day FROM boom_invoices ORDER BY invoice_number DESC'
    );
    res.json({ success: true, data: rows.map(withInvoiceDate) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET next invoice number
router.get('/next-number', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT COALESCE(MAX(invoice_number), -1) + 1 AS next_number FROM boom_invoices'
    );
    res.json({ success: true, data: { next_number: rows[0].next_number } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST create invoice
router.post('/', async (req, res) => {
  try {
    const { bill_to, bill_to_address, description, amount, purchase_order, line_items, currency,
      payment_terms, due_date } = req.body;

    // Get next invoice number
    const { rows: numRows } = await pool.query(
      'SELECT COALESCE(MAX(invoice_number), -1) + 1 AS next_number FROM boom_invoices'
    );
    const invoice_number = numRows[0].next_number;

    // RECOMPUTED here, never taken from the request. `due_by` used to be a free
    // string the caller supplied, so the printed deadline and the terms could say
    // different things and neither was checked. Now the terms are the input and
    // both the date and the printed line are derived from them.
    // A new invoice is dated today unless the caller says otherwise — today in the
    // COMPANY's timezone, and `created_at` is pinned to the very instant that day
    // was read from. Letting the column default to NOW() instead leaves a window
    // around midnight in which the stored timestamp lands on the next day and the
    // printed date stops matching the deadline; passing it closes that by
    // construction rather than by being unlikely.
    const raisedAt = new Date();
    // STORED, not merely counted from. Before this the supplied date moved the
    // DUE date and the document still printed businessDay(created_at) — so an
    // invoice created dated last week printed today and was due from last week,
    // which is precisely the two-different-days state this module exists to
    // prevent. Unreachable from the form, which never sent one; reachable from
    // the API, which is enough.
    const issued = dayOf(req.body.invoice_date) || businessDay(raisedAt);
    const due = resolveDue(payment_terms || DEFAULT_TERMS, issued, due_date);
    if (due.error) return res.status(400).json({ success: false, error: due.error });

    const cur = (currency || 'USD').toUpperCase().slice(0, 6);
    const { rows } = await pool.query(
      `INSERT INTO boom_invoices (invoice_number, bill_to, bill_to_address, description, amount, purchase_order, due_by, line_items, currency, created_by, payment_terms, due_date, invoice_date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *, invoice_date::text AS invoice_day`,
      [invoice_number, bill_to, bill_to_address || null, description, amount, purchase_order || 'N/A', due.due_by || 'UPON RECEIPT', line_items ? JSON.stringify(line_items) : null, cur, req.user?.name || 'Unknown', due.terms, due.due_date, issued, raisedAt]
    );
    res.json({ success: true, data: withInvoiceDate(rows[0]) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT update invoice
router.put('/:id', async (req, res) => {
  try {
    if (!['Admin', 'Superadmin', 'Approver'].includes(req.user?.role)) return res.status(403).json({ success: false, error: 'Bookkeeping roles only' });
    // `due_by` is no longer settable directly — it is DERIVED. Leaving it writable
    // alongside payment_terms would let the printed deadline and the terms
    // disagree, which is the state this change exists to remove.
    const allowed = ['payment_status', 'bill_to', 'bill_to_address', 'description', 'amount', 'purchase_order', 'line_items', 'currency'];
    const fields = Object.keys(req.body).filter(k => allowed.includes(k));
    const patch = {};
    // Re-terming an invoice recomputes from the date it was ISSUED, not today.
    // Anchoring on today would move a deadline the client has already been given
    // every time somebody fixed a typo in the description.
    if (req.body.payment_terms !== undefined || req.body.due_date !== undefined
        || req.body.invoice_date !== undefined) {
      const { rows: cur } = await pool.query(
        'SELECT created_at, payment_terms, due_date, invoice_date::text AS invoice_day FROM boom_invoices WHERE id = $1',
        [req.params.id]);
      if (!cur.length) return res.status(404).json({ success: false, error: 'Invoice not found' });
      // MOVING THE DATE MOVES THE DEADLINE. Net 30 means thirty days from the day
      // the invoice is dated, so an edited date that left due_by where it was
      // would print a document whose own two dates disagree — the single thing
      // lib/payment-terms.js exists to make impossible. Custom terms are the
      // exception and stay exactly as typed, because there the deadline was never
      // derived from the issue date in the first place.
      //
      // businessDay, not dayOf, on the fallback: the UTC day of a 5pm-Pacific
      // timestamp is tomorrow, so re-terming an invoice raised in the evening
      // used to move its deadline a day past what the document printed.
      const askedDate = req.body.invoice_date !== undefined ? dayOf(req.body.invoice_date) : null;
      if (req.body.invoice_date !== undefined && !askedDate) {
        return res.status(400).json({ success: false, error: 'Please give the invoice date as YYYY-MM-DD.' });
      }
      const issued = askedDate
        || (isDay(cur[0].invoice_day) ? cur[0].invoice_day : businessDay(cur[0].created_at));
      if (askedDate) patch.invoice_date = askedDate;
      if (!issued) return res.status(400).json({ success: false, error: 'this invoice has no readable issue date to count terms from' });
      const terms = req.body.payment_terms !== undefined ? req.body.payment_terms : cur[0].payment_terms;
      const custom = req.body.due_date !== undefined ? req.body.due_date : dayOf(cur[0].due_date);
      const due = resolveDue(terms, issued, custom);
      if (due.error) return res.status(400).json({ success: false, error: due.error });
      patch.payment_terms = due.terms;
      patch.due_date = due.due_date;
      patch.due_by = due.due_by || 'UPON RECEIPT';
    }
    const patchKeys = Object.keys(patch);
    if (!fields.length && !patchKeys.length) return res.status(400).json({ success: false, error: 'No valid fields' });
    const setClauses = [...fields, ...patchKeys].map((f, i) => `${f} = $${i + 2}`);
    const values = [...fields.map(f => req.body[f]), ...patchKeys.map(k => patch[k])];
    const { rows } = await pool.query(
      `UPDATE boom_invoices SET ${setClauses.join(', ')} WHERE id = $1
        RETURNING *, invoice_date::text AS invoice_day`,
      [req.params.id, ...values]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Invoice not found' });
    res.json({ success: true, data: withInvoiceDate(rows[0]) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE invoice
router.delete('/:id', async (req, res) => {
  try {
    if (!['Admin', 'Superadmin', 'Approver'].includes(req.user?.role)) return res.status(403).json({ success: false, error: 'Bookkeeping roles only' });
    await pool.query('DELETE FROM boom_invoices WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
