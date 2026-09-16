/**
 * The category vocabulary an AI parse is allowed to choose from — the LIVE one,
 * most-used first.
 *
 * ── Why this exists ──
 * Both parse prompts were built from the CATEGORIES constant:
 *
 *     "category": one of ${JSON.stringify(CATEGORIES)} or null
 *
 * That constant holds 26 names. The ledger uses 39. So fourteen categories could
 * never be suggested by the AI, and they hold $1,612,154 of real spend —
 * including "Artist Expense - Recording" ($130,575), which is why a
 * mixing/mastering invoice always landed on "Mixing & Mastering" or "Production".
 * The right answer was not in the list the model was shown.
 *
 * CLAUDE.md already states this rule for the client — "the constants are the seed
 * and the offline fallback only" — and the server was breaking it.
 *
 * ── Why usage counts, not just names ──
 * "Prefer the categories we actually use" is evidence, not an instruction. A
 * label with 1,256 Marketing rows and 1 Design row has told you which is likely;
 * showing the model the counts lets it weigh that itself, and it keeps working as
 * the numbers change without anyone editing a prompt.
 *
 * ── Degrades, never fails ──
 * On any error this returns the constant, exactly as reportSections() and
 * loadNoInvoiceRowIds do. A refinement to category ranking must never be able to
 * stop an invoice from being parsed.
 */

const { CATEGORIES, INCOME_CATEGORIES } = require('./constants');

/**
 * @param {object} pool  pg pool, passed in like loadAliasIndex(pool)
 * @param {'expense'|'income'} kind
 * @returns {{ list: string[], prompt: string, source: 'live'|'constant' }}
 *   list   — names, most-used first
 *   prompt — "Marketing (1256 uses) · Bank Fees (561) · …" for the prompt body
 *   source — which vocabulary was used, so a caller can log or assert on it
 */
async function categoryVocabulary(pool, kind = 'expense') {
  const fallback = kind === 'income' ? INCOME_CATEGORIES : CATEGORIES;
  try {
    // Usage counted from the rows the category is actually ON, not from
    // bk_categories — a category can be seeded and unused, or heavily used and
    // custom, and only the ledger knows which.
    //
    // LEFT JOIN so a live-but-unused category still appears: it is a legitimate
    // choice, it just sorts last. sort_order breaks ties so the seeded sequence
    // survives among the equally-unused ones.
    const { rows } = kind === 'income'
      ? await pool.query(`
          SELECT c.name, COUNT(i.id)::int AS uses
            FROM bk_categories c
            LEFT JOIN artist_income i
              ON LOWER(TRIM(i.income_type)) = LOWER(TRIM(c.name))
           WHERE c.kind = 'income' AND c.active = TRUE
           GROUP BY c.name, c.sort_order
           ORDER BY uses DESC, c.sort_order ASC NULLS LAST, c.name ASC`)
      : await pool.query(`
          SELECT c.name, COUNT(e.id)::int AS uses
            FROM bk_categories c
            LEFT JOIN expenses e
              ON LOWER(TRIM(e.category)) = LOWER(TRIM(c.name))
             AND (e.deleted = false OR e.deleted IS NULL)
             AND (e.voided = false OR e.voided IS NULL)
           WHERE c.kind = 'expense' AND c.active = TRUE
           GROUP BY c.name, c.sort_order
           ORDER BY uses DESC, c.sort_order ASC NULLS LAST, c.name ASC`);

    const list = rows.map((r) => String(r.name).trim()).filter(Boolean);
    // An empty table is not a vocabulary. Falling through to the constant is the
    // same guard /api/categories applies for a fresh database.
    if (!list.length) return { list: fallback, prompt: fallback.join(' · '), source: 'constant' };

    return {
      list,
      prompt: rows.map((r) => (r.uses > 0 ? `${r.name} (${r.uses} uses)` : String(r.name))).join(' · '),
      source: 'live',
    };
  } catch (err) {
    console.error('category vocabulary unavailable — using the seed constant:', err.message);
    return { list: fallback, prompt: fallback.join(' · '), source: 'constant' };
  }
}

module.exports = { categoryVocabulary };
