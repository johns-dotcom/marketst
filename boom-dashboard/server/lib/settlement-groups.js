/**
 * Invoices marked as paid TOGETHER — one payment settles the whole group.
 *
 * ── Why this exists ──
 * The matcher pairs a bank line against ONE invoice family on an amount equal to
 * the cent. So a vendor paid for two invoices in a single transfer matches
 * nothing: each invoice is smaller than the payment, and the line falls through
 * to be found by hand. Live, there are 465 same-payee-same-date groups of 2+
 * invoices sitting in the ledger that nobody has connected.
 *
 * A group is a declared fact — "these will arrive as one payment" — recorded at
 * upload or afterwards, which lets the matcher sum them and settle the line.
 *
 * ── One definition, two callers ──
 * `routes/bookkeeping.js` writes groups; `routes/statements.js` reads them in the
 * matcher. Both come through here, so what counts as a group cannot differ
 * between the thing that creates one and the thing that acts on one.
 *
 * ── What a group may NOT be ──
 * Validated rather than free-form, because a group that cannot physically be one
 * payment is worse than no group: it teaches the matcher to settle a line with
 * invoices that were never paid by it.
 *
 *   • same vendor, through the alias index — one payee spelled two ways is one
 *     vendor, and splitting on the spelling would refuse a legitimate group
 *   • FAMILY ROOTS only — matches live on the root, the basis both the matcher
 *     and /attach already use; a split child cannot be settled independently
 *   • 2+ members — a group of one is not a group, and is deleted rather than kept
 *   • nothing already settled by a DIFFERENT bank line
 */
const crypto = require('crypto');
const { loadAliasIndex } = require('./vendor-aliases');

/** Short, readable, and unique enough — this is a join key, not a secret. */
const newGroupKey = () => 'sg_' + crypto.randomBytes(6).toString('hex');

/** The family root of every id given, deduped. Matches live on roots. */
async function rootsOf(db, ids) {
  const { rows } = await db.query(
    `SELECT id, parent_id, payee, amount, currency, fx_rate_to_usd, invoice_number,
            settlement_group, entry_source, payment_status
       FROM expenses
      WHERE id = ANY($1::int[])
        AND (deleted = false OR deleted IS NULL) AND (voided = false OR voided IS NULL)`,
    [ids]);
  return rows;
}

/**
 * Can these invoices be one payment?
 *
 * @returns {Promise<{ok: boolean, error?: string, members?: number[]}>}
 *   `members` are FAMILY ROOT ids, deduped — what actually gets marked.
 */
async function validateGroup(db, ids) {
  const wanted = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
  if (wanted.length < 2) {
    return { ok: false, error: 'Pick at least two invoices — a group of one is not a payment group.' };
  }
  if (wanted.length > 25) {
    return { ok: false, error: 'That is more than 25 invoices; group them in smaller payments.' };
  }
  const rows = await rootsOf(db, wanted);
  if (rows.length !== wanted.length) {
    return { ok: false, error: 'One of those invoices no longer exists.' };
  }

  const child = rows.find((r) => r.parent_id);
  if (child) {
    return { ok: false,
      error: `Invoice #${child.id} is part of a split — group its parent (#${child.parent_id}) instead.` };
  }
  // A bank-created entry is not an invoice. Same guard /attach and /match apply:
  // without it a debit becomes "invoice-backed" with no document anywhere.
  const invented = rows.find((r) => r.entry_source === 'bank_statement');
  if (invented) {
    return { ok: false,
      error: `Entry #${invented.id} was created from a bank line, so it is not an invoice.` };
  }

  // Same vendor, alias-aware. `canonical()` resolves a whole alias class, so
  // "Oxis Music, LLC" and "Oxis Music" are one vendor rather than two groups.
  const alias = await loadAliasIndex(db).catch(() => null);
  const key = (p) => {
    const n = String(p || '').trim();
    const c = alias && typeof alias.canonical === 'function' ? (alias.canonical(n) || n) : n;
    return c.toLowerCase().replace(/[^a-z0-9]/g, '');
  };
  const vendors = [...new Set(rows.map((r) => key(r.payee)))];
  if (vendors.length > 1) {
    return { ok: false,
      error: 'Those invoices are from different vendors — one payment cannot settle invoices from two vendors. '
        + `Saw: ${[...new Set(rows.map((r) => r.payee))].join(', ')}` };
  }

  // Already settled by a bank line? Then a group would be claiming it twice.
  const { rows: settled } = await db.query(`
    SELECT DISTINCT e.id, e.invoice_number
      FROM expenses e
      JOIN bank_transactions bt ON bt.matched_expense_id = e.id AND bt.dismissed = false
      JOIN bank_statements bs ON bs.id = bt.statement_id AND bs.status = 'ready'
     WHERE e.id = ANY($1::int[])`, [wanted]);
  if (settled.length) {
    const s = settled[0];
    return { ok: false,
      error: `Invoice ${s.invoice_number ? `#${s.invoice_number}` : `#${s.id}`} is already matched to a bank line. `
        + 'Unmatch it first if it really was part of this payment.' };
  }

  return { ok: true, members: rows.map((r) => r.id) };
}

/**
 * The authoritative membership of the named groups, with each member's FAMILY
 * total (root + live children).
 *
 * Read by the matcher, which sees only candidates inside its date window — so it
 * must ask HERE what a group actually contains. A group summed from the members
 * that happened to be in the window would be a subset claiming the whole
 * payment, which is the one thing this feature must never do.
 *
 * FACE amounts and currency per member: the caller converts with `usdOf`, never
 * `amount_usd`, and rounds once at the end rather than summing rounded parts.
 */
async function groupsByKeys(db, keys) {
  const wanted = [...new Set((keys || []).filter(Boolean))];
  if (!wanted.length) return new Map();
  const { rows } = await db.query(`
    SELECT e.settlement_group AS grp, e.id, e.payee, e.invoice_number,
           COALESCE(e.currency, 'USD') AS currency, e.fx_rate_to_usd,
           e.payment_method, e.payment_status, e.invoice_date,
           e.amount + COALESCE((SELECT SUM(c.amount) FROM expenses c
              WHERE c.parent_id = e.id AND (c.deleted = false OR c.deleted IS NULL)
                AND (c.voided = false OR c.voided IS NULL)), 0) AS family_total
      FROM expenses e
     WHERE e.settlement_group = ANY($1::text[])
       AND e.parent_id IS NULL
       AND (e.deleted = false OR e.deleted IS NULL) AND (e.voided = false OR e.voided IS NULL)
     ORDER BY e.settlement_group, e.id`, [wanted]);

  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.grp)) by.set(r.grp, []);
    by.get(r.grp).push(r);
  }
  // A group whose other members were deleted is no longer a group — returning it
  // would let one leftover invoice claim a payment sized for several.
  for (const [k, members] of [...by.entries()]) if (members.length < 2) by.delete(k);
  return by;
}

module.exports = { newGroupKey, validateGroup, groupsByKeys };
