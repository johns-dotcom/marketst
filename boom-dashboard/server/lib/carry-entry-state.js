/**
 * When one ledger row dissolves into another, the marks a PERSON made must
 * survive — ONE definition.
 *
 * ── Why this exists ──
 * The statement subsystem routinely dissolves rows: a duplicate merges into its
 * original, a PayPal copy dissolves into its bank twin. Each of those paths
 * carried a hand-picked list of fields across — the duplicate merge carried
 * invoice/W9/proof files, artist and invoice_number; the funding-pair close
 * carried artist, song and category — and NOBODY carried the recoupment state.
 *
 * So merging a duplicate that had been marked "Uploaded for Recoupment" ended
 * that claim silently. John, 2026-08-19: "I don't want this statement matching
 * process to mess up any 'uploaded for recoupment' statuses." At the time 4 of
 * the 79 pairs waiting in the duplicate queue were in exactly that shape, and
 * 205 live rows / $928,127 carry the mark.
 *
 * ── The rule: a carry may only ADD ──
 * Every field moves only when the survivor does not already have it, and no
 * carry may ever take something away. A survivor is never made *less* claimed,
 * *less* flagged, or moved into a different month than it already sat in.
 */

// Fields whose absence on the survivor is the only reason to copy them.
// Deliberately NOT here: payment_status, paid_by, notes, category, song. Those
// have their own considered rules in each caller; this is the recoupment state
// they were all missing, and nothing else.
const CARRIED = ['ufr', 'ufr_marked_at', 'recoupment_label', 'recoupable', 'flagged', 'flag_reason'];

const SELECT = `SELECT ${CARRIED.join(', ')} FROM expenses WHERE id = $1`;

/**
 * @param {object} q       pool, or a pinned client inside the caller's transaction
 * @param {number} fromId  the row being dissolved
 * @param {number} intoId  the row that survives
 * @returns {Promise<string[]>} the fields actually moved, for the audit line
 */
async function carryEntryState(q, fromId, intoId) {
  if (!fromId || !intoId || fromId === intoId) return [];
  const { rows: [from] } = await q.query(SELECT, [fromId]);
  const { rows: [into] } = await q.query(SELECT, [intoId]);
  if (!from || !into) return [];

  const set = {};
  const carried = [];
  const take = (field, value) => { set[field] = value; carried.push(field); };

  // ── Uploaded for recoupment ──────────────────────────────────────────────
  // 'Yes' is the mark; 'No' is merely the absence of one, so a 'No' must never
  // overwrite a 'Yes'. If either record was uploaded, the survivor was.
  const intoUploaded = into.ufr === 'Yes';
  const resultUploaded = intoUploaded || from.ufr === 'Yes';
  if (!intoUploaded && from.ufr === 'Yes') take('ufr', 'Yes');

  // The date decides WHICH MONTHLY STATEMENT the row sits in, so a survivor
  // that already has one keeps it — carrying the other row's date would move
  // settled money into a different month's statement.
  if (resultUploaded && !into.ufr_marked_at && from.ufr_marked_at) {
    take('ufr_marked_at', from.ufr_marked_at);
  }
  if (!String(into.recoupment_label || '').trim() && String(from.recoupment_label || '').trim()) {
    take('recoupment_label', from.recoupment_label);
  }

  // ── A raised concern outlives the row that raised it ─────────────────────
  if (!into.flagged && from.flagged) {
    take('flagged', true);
    if (!String(into.flag_reason || '').trim() && String(from.flag_reason || '').trim()) {
      take('flag_reason', from.flag_reason);
    }
  }

  // ── recoupable is the asymmetric one ─────────────────────────────────────
  // It is BOOLEAN DEFAULT TRUE, so the deliberate human act is marking a row
  // FALSE — which makes carrying it SUBTRACTIVE: it pushes the survivor off the
  // Recoupments page. That is the opposite of what this file is for, so it is
  // carried only while the survivor is not claimed as uploaded. Marking a row
  // non-recoupable while it is claimed as uploaded contradicts itself, and
  // between the two the claim wins.
  if (from.recoupable === false && into.recoupable !== false && !resultUploaded) {
    take('recoupable', false);
  }

  if (!carried.length) return [];
  const cols = Object.keys(set);
  const vals = cols.map((c) => set[c]);
  vals.push(intoId);
  await q.query(
    `UPDATE expenses SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${vals.length}`,
    vals);
  return carried;
}

module.exports = { carryEntryState, CARRIED };
