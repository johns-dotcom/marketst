/**
 * Which ledger entry holds a payee's W9 — alias-aware, one definition.
 *
 * There is no W9 table. A W9 lives on whichever `expenses` row it was uploaded
 * onto, and every other invoice from that vendor is covered by it. Asking "does
 * this invoice have a W9" of the ROW is therefore the wrong question and gives
 * the wrong answer: measured on the live approvals queue (2026-08-24), 13 of 30
 * pending invoices carry no W9 of their own, but 12 of those vendors have one on
 * file elsewhere. Exactly ONE vendor genuinely has none.
 *
 * That gap is the same shape as the bug that once reported 51.4% W9 coverage
 * against a real 97.1% — a per-entry count answering a per-vendor question.
 *
 * ── This logic already exists twice, and this is not a third copy ────────────
 * `w9_by_payee` in the vendors CTE (routes/bookkeeping.js ~814) and
 * GET /bk/vendor-w9-status (~4188) both resolve the same thing. Rather than
 * write a third, new code imports this and a fixture asserts it returns the
 * SAME entry id as the live endpoint for every pending approval.
 *
 * Converging the two originals belongs in its own change: the CTE sits inside
 * the query that was the prime suspect in a 17-second page load, and this is
 * not the change to touch it in.
 *
 * ── Aliases go BOTH ways ────────────────────────────────────────────────────
 * `vendor_aliases` records (primary_name, alias). A W9 uploaded under either
 * spelling covers the other, so the lookup unions both directions. Dropping one
 * direction silently loses the W9 for every vendor whose form was filed under
 * their legal name while the invoices use their trading name.
 */

const pool = require('../db');

/**
 * SQL for "rows whose payee is this payee, or any alias of it, in either
 * direction". `$1` is the payee. Exposed so a caller can inline it in a larger
 * query instead of round-tripping.
 */
const SAME_VENDOR_SQL = (alias = 'x') => `(
  LOWER(TRIM(${alias}.payee)) = LOWER(TRIM($1))
  OR LOWER(TRIM(${alias}.payee)) IN (
    SELECT LOWER(TRIM(va.alias))        FROM vendor_aliases va WHERE LOWER(TRIM(va.primary_name)) = LOWER(TRIM($1))
    UNION
    SELECT LOWER(TRIM(va.primary_name)) FROM vendor_aliases va WHERE LOWER(TRIM(va.alias))        = LOWER(TRIM($1))
  )
)`;

/**
 * Does this row carry a W9 FILE?
 *
 * Tests w9_data OR w9_r2_key, matching GET /bk/vendor-w9-status exactly —
 * changing the test here would make the two disagree, which is the whole thing
 * this module exists to prevent. (Files live in R2 now; w9_data is the legacy
 * base64 column that predates the cutover and still holds real forms.)
 */
const HAS_W9_SQL = (alias = 'x') =>
  `((${alias}.w9_data IS NOT NULL AND ${alias}.w9_data != '') OR ${alias}.w9_r2_key IS NOT NULL)`;

/**
 * The entry holding this payee's most recent W9, or null.
 *
 * MAX(id) / ORDER BY id DESC — the same "most recent wins" the two existing
 * call sites use. Not by date: a W9 has no reliable date column, and the upload
 * order is what both originals already trust.
 *
 * @param {string} payee
 * @param {object} [q] pool, or a pinned client inside a transaction
 * @returns {Promise<{id:number, payee:string, w9_scan:object|null,
 *                    w9_filename:string|null, w9_r2_key:string|null,
 *                    w9_review:object|null} | null>}
 */
async function w9OwnerFor(payee, q = pool) {
  const name = String(payee || '').trim();
  if (!name) return null;
  const { rows } = await q.query(
    `SELECT x.id, x.payee, x.w9_scan, x.w9_filename, x.w9_r2_key, x.w9_review
       FROM expenses x
      WHERE ${HAS_W9_SQL('x')}
        AND (x.deleted = false OR x.deleted IS NULL)
        AND x.status != 'rejected'
        AND ${SAME_VENDOR_SQL('x')}
      ORDER BY x.id DESC
      LIMIT 1`,
    [name]
  ).catch(() => ({ rows: [] }));
  return rows[0] || null;
}

/**
 * Resolve many payees at once, without a query per row.
 *
 * The approvals queue is 30 rows today but the same endpoint serves the whole
 * pending set; a per-row lookup is the correlated-subquery shape that made
 * /statements/all take 17 seconds. One pass, then matched in JS.
 *
 * @param {string[]} payees
 * @returns {Promise<Map<string, object>>} keyed by LOWER(TRIM(payee))
 */
async function w9OwnersFor(payees, q = pool) {
  const names = [...new Set((payees || [])
    .map((p) => String(p || '').trim())
    .filter(Boolean))];
  const out = new Map();
  if (!names.length) return out;

  // One row per (requested payee → owning entry). The join carries the payee
  // that was ASKED for, because an alias hit resolves to a different spelling
  // and the caller needs to look it up by the name it has.
  const { rows } = await q.query(
    `SELECT n.name AS asked, x.id, x.payee, x.w9_scan, x.w9_filename, x.w9_r2_key, x.w9_review
       FROM unnest($1::text[]) AS n(name)
       JOIN LATERAL (
         SELECT y.id, y.payee, y.w9_scan, y.w9_filename, y.w9_r2_key, y.w9_review
           FROM expenses y
          WHERE ${HAS_W9_SQL('y')}
            AND (y.deleted = false OR y.deleted IS NULL)
            AND y.status != 'rejected'
            AND (
              LOWER(TRIM(y.payee)) = LOWER(TRIM(n.name))
              OR LOWER(TRIM(y.payee)) IN (
                SELECT LOWER(TRIM(va.alias))        FROM vendor_aliases va WHERE LOWER(TRIM(va.primary_name)) = LOWER(TRIM(n.name))
                UNION
                SELECT LOWER(TRIM(va.primary_name)) FROM vendor_aliases va WHERE LOWER(TRIM(va.alias))        = LOWER(TRIM(n.name))
              )
            )
          ORDER BY y.id DESC
          LIMIT 1
       ) x ON TRUE`,
    [names]
  ).catch((err) => { console.error('w9OwnersFor:', err.message); return { rows: [] }; });

  for (const r of rows) out.set(String(r.asked).trim().toLowerCase(), r);
  return out;
}

module.exports = { w9OwnerFor, w9OwnersFor, SAME_VENDOR_SQL, HAS_W9_SQL };
