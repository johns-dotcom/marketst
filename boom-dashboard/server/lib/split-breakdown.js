/**
 * Keep `expenses.artist_breakdown` in step when ONE MEMBER of a split family is
 * relabelled.
 *
 * ── Why this file exists ──
 * A split payment is stored twice. The family rows are the truth — a parent plus
 * one child per slice, each with its own `artist`, `category` and `amount`, and
 * that is what the P&L reads (`attachSplitParts` in routes/reports.js) and what
 * `DELETE /entries/:id/splits` re-adds to restore the original total. The
 * parent's `artist_breakdown` JSON is a DENORMALIZED COPY of the same list,
 * written by the split paths in routes/bookkeeping.js and read by the breakdown
 * editor and by two flag sensors in routes/flags.js.
 *
 * Until the Reports drill could relabel a single part, nothing wrote to one row
 * of a family, so the copy could not drift. Now it can, and a change that moved
 * the child but not the JSON would leave the ledger and the split editor naming
 * different artists for the same slice. Fix the producer, keep the copy whole.
 *
 * ── How a slice is identified ──
 * BY POSITION, and only when position is provably safe. The split writer does
 * `const [first, ...rest] = artist_breakdown`, putting the first slice on the
 * parent and inserting the rest as children in order, so family member i is
 * breakdown slice i — as long as nothing has been added or removed since. Two
 * guards prove that before anything is written: the counts must match, and the
 * amounts must agree pairwise. A 50/50 split makes amount matching hopeless on
 * its own (both slices are the same number), which is why position leads.
 *
 * When those guards fail, the fallback is a UNIQUE match on amount plus the
 * value being replaced. If that is ambiguous too, this writes NOTHING and says
 * why. Guessing which half of a payment somebody meant is worse than leaving a
 * stale copy and reporting it.
 *
 * ── It never creates a breakdown ──
 * A song-split family has children and a NULL `artist_breakdown`. Populating one
 * would hand the breakdown editor a list it never had, so a family without a
 * multi-slice breakdown is left alone.
 */

/** Money comparison, to the cent — amounts arrive as strings from pg. */
const sameMoney = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005;
const sameText = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/**
 * @param {object} db      pg pool or a client already inside a transaction
 * @param {number} writtenId  the expense row that was just relabelled
 * @param {object} change  `{ field: 'artist'|'category', from, to }`
 * @returns {Promise<{synced: boolean, reason?: string, root?: number, slice?: number}>}
 *   `synced: false` is a normal outcome, not an error — most rows are not split.
 */
async function resyncBreakdown(db, writtenId, { field, from, to } = {}) {
  if (!['artist', 'category'].includes(field)) return { synced: false, reason: 'unsupported field' };
  const id = Number(writtenId);
  if (!Number.isFinite(id)) return { synced: false, reason: 'no id' };

  const { rows: [me] } = await db.query(
    `SELECT id, parent_id FROM expenses WHERE id = $1`, [id]);
  if (!me) return { synced: false, reason: 'row not found' };
  const root = me.parent_id || me.id;

  const { rows: [parent] } = await db.query(
    `SELECT id, artist_breakdown FROM expenses WHERE id = $1`, [root]);
  const bd = parent?.artist_breakdown;
  if (!Array.isArray(bd) || bd.length < 2) {
    return { synced: false, reason: 'no multi-slice breakdown stored', root };
  }
  // A slice with no `category` key cannot record a category change — the split
  // editor only ever wrote artist/song/amount. Saying so beats inventing a key
  // that every other reader would then have to tolerate.
  if (field === 'category' && !bd.some((sl) => sl && Object.prototype.hasOwnProperty.call(sl, 'category'))) {
    return { synced: false, reason: 'stored breakdown carries no category', root };
  }

  // The family, in the order the split writer used: parent first, children by id.
  const { rows: family } = await db.query(
    `SELECT id, amount FROM expenses
      WHERE id = $1 OR (parent_id = $1 AND (deleted = false OR deleted IS NULL) AND (voided = false OR voided IS NULL))
      ORDER BY (id = $1) DESC, id ASC`, [root]);

  let idx = -1;
  const positionSafe = family.length === bd.length
    && family.every((m, i) => sameMoney(m.amount, bd[i]?.amount));
  if (positionSafe) {
    idx = family.findIndex((m) => m.id === id);
  } else {
    // Amount plus the value being replaced, and it must be the only match.
    const mine = family.find((m) => m.id === id);
    const hits = bd
      .map((sl, i) => ({ sl, i }))
      .filter(({ sl }) => sameMoney(sl?.amount, mine?.amount) && sameText(sl?.[field], from));
    if (hits.length !== 1) {
      return {
        synced: false,
        reason: hits.length === 0
          ? 'no breakdown slice matches this row'
          : `${hits.length} breakdown slices match this row — refusing to guess which one`,
        root,
      };
    }
    idx = hits[0].i;
  }
  if (idx < 0) return { synced: false, reason: 'row is not in its own family listing', root };

  // Mutate the ONE slice, in place, preserving every other key on it —
  // `is_reimbursement` is what the fee/reimbursement carve-off reads, and `song`
  // is what the editor shows.
  const next = bd.map((sl, i) => (i === idx ? { ...sl, [field]: to || null } : sl));
  await db.query(`UPDATE expenses SET artist_breakdown = $1 WHERE id = $2`,
    [JSON.stringify(next), root]);
  return { synced: true, root, slice: idx };
}

module.exports = { resyncBreakdown };
