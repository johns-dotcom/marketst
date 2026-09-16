/**
 * Spend that is never recoupable against an artist.
 *
 * ── Why this exists ──
 * `expenses.recoupable` is `BOOLEAN DEFAULT TRUE` and `bookDebitAsEntry` never
 * lists the column, so every statement-born row arrives claiming to be
 * recoupable. `recoup_reviewed` is the gate that lets a person answer one of
 * them — but measured on 2026-08-20, 1,919 of the 1,972 unanswered rows carry no
 * artist at all ($3,022,524), and 560 of those are Bank Fees worth $3,251.43
 * between them. Per-row review is the wrong instrument for that shape: it gives a
 * $12 card charge the same ceremony as a $200,000 advance, and the queue can
 * never reach zero.
 *
 * Eight categories account for $2,074,917 of the remainder and not one dollar of
 * it can be billed to an artist:
 *
 *     Royalties                600,000.00    8 rows
 *     Partner - Felipe         330,675.66    8
 *     Salary                   315,686.69   63
 *     Royalty Service Expense  250,975.00    2
 *     Partner - Tyler          204,115.00    7
 *     Salary (Felipe)          191,646.66    7
 *     Credit Card               99,812.03   21
 *     Rent                      82,005.06   11
 *
 * Saying so once, per class, leaves the rows that are a real question: Advance
 * ($390,530.22 over 11 payments, every one of them an artist's money) and
 * Marketing ($70,046.88).
 *
 * ── What it does NOT do ──
 * It moves no money and writes nothing to the ledger. Those rows are already off
 * the Recoupments page — the client's `withoutUnreviewedBankRows` admits a
 * bank-born row only once `recoup_reviewed` is true — so a rule only removes them
 * from the QUEUE of things still to answer. `recoupable` is left alone, which is
 * what makes deleting a rule a complete undo: the rows come straight back.
 *
 * That is the difference from `recoup_reviewed`, and it is deliberate. A per-row
 * answer is one person's decision about one payment and is meant to persist. A
 * rule is a statement about a class of spend, has to cover rows that arrive next
 * month, and has to be retractable without reconstructing who decided what.
 *
 * ── EQUALITY, never substring ──
 * The trap `statement_no_invoice_rules` and `label_level_spend_rules` both
 * document: "TONE" ($615k) is a substring of "Tone Pay, Inc" and "Dean St" of
 * "Dean Street Media". Here the same rule is load-bearing in the other direction
 * — `Salary` and `Salary (Felipe)` are two separate live categories, as are
 * `Partner - Felipe` and `Partner - Tyler`. A `Salary` rule must leave the
 * `Salary (Felipe)` rows exactly where they are, which is why eight decisions are
 * eight rules and not four.
 */

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Load the rules for one request.
 *
 * Degrades to "no rules" on any error, the table not existing included:
 * `runMigrations()` runs in the BACKGROUND after `app.listen`, and a queue that
 * 500s during a deploy window is worse than a queue that briefly offers rows a
 * rule already covers.
 *
 * @returns {{ vendors: Set<string>, categories: Set<string>, rows: object[],
 *             size: number, has: (payee: string, category: string) => boolean }}
 */
async function loadRecoupmentClassRules(pool) {
  const empty = {
    vendors: new Set(), categories: new Set(), rows: [], size: 0, has: () => false,
  };
  try {
    const { rows } = await pool.query(
      `SELECT id, scope, rule_key, reason, created_at,
              (SELECT name FROM users WHERE id = r.created_by) AS created_by_name
         FROM recoupment_class_rules r
        ORDER BY r.scope, LOWER(r.rule_key)`);
    const vendors = new Set();
    const categories = new Set();
    for (const r of rows) {
      if (r.scope === 'vendor') vendors.add(norm(r.rule_key));
      else if (r.scope === 'category') categories.add(norm(r.rule_key));
    }
    return {
      vendors, categories, rows, size: rows.length,
      /**
       * Is this spend in a never-recoupable class? A CATEGORY rule answers for
       * everything in it; a VENDOR rule answers for that payee whatever the
       * category.
       */
      has: (payee, category) => categories.has(norm(category)) || vendors.has(norm(payee)),
    };
  } catch (err) {
    console.error('recoupment class rules unavailable — queue offers everything:', err.message);
    return empty;
  }
}

/**
 * WHERE-clause fragment: this row is NOT covered by any rule.
 *
 * Written as a NOT EXISTS against the table rather than an `IN (…)` built from
 * the loaded rows, so the SQL stays one statement and the queue cannot disagree
 * with the rules list because of a stale read between the two queries.
 *
 * Normalizes on BOTH sides the same way `norm()` does — lower, trim, collapse
 * runs of whitespace — because a rule typed with a trailing space would
 * otherwise match nothing while looking correct in the list.
 *
 * @param {string} e  alias of the `expenses` table
 */
const notClassRuledSql = (e = 'e') => `NOT EXISTS (
  SELECT 1 FROM recoupment_class_rules rcr
   WHERE (rcr.scope = 'category'
            AND regexp_replace(LOWER(TRIM(rcr.rule_key)), '\\s+', ' ', 'g')
              = regexp_replace(LOWER(TRIM(COALESCE(${e}.category, ''))), '\\s+', ' ', 'g'))
      OR (rcr.scope = 'vendor'
            AND regexp_replace(LOWER(TRIM(rcr.rule_key)), '\\s+', ' ', 'g')
              = regexp_replace(LOWER(TRIM(COALESCE(${e}.payee, ''))), '\\s+', ' ', 'g'))
)`;

module.exports = { loadRecoupmentClassRules, notClassRuledSql, norm };
