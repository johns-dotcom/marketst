/**
 * Apportioning ad-platform charges to campaigns, in integer cents.
 *
 * ── Why this is its own file, and pure ──
 * Two separate arithmetic traps live here, and both have already cost this repo a
 * production number:
 *
 *   1. `POST /bk/entries/:id/split` (routes/bookkeeping.js) NEVER CHECKS that the
 *      slices sum to the parent. It sets the parent to `first.amount` and inserts
 *      the rest verbatim. Three ways on $422.00 at naive rounding is
 *      $140.67 x 3 = $422.01 — the ledger gains a cent per charge and nothing
 *      reports it. Allocating in cents and handing the remainder to a named slice
 *      is what makes the family sum exact BY CONSTRUCTION rather than by luck.
 *
 *   2. `never-total-rounded-parts`: a total built out of independently rounded
 *      shares drifts. The artist spend sheets shipped that way and production
 *      proved it in under a minute ($781,522.61 against $781,522.62). So shares
 *      are resolved against the whole, once, and the residue is placed — never
 *      absorbed silently by whichever slice happens to be last in a loop.
 *
 * No database access, so the fixture exercises the arithmetic directly instead of
 * inferring it from what landed in a table.
 *
 * ── The money unit is CENTS, everywhere in this file ──
 * Callers convert at the boundary (`toCents` / `fromCents`). Floats never take
 * part in a division whose result is compared for equality.
 */

/** Dollars (or any float amount) to integer cents. */
const toCents = (n) => Math.round((Number(n) || 0) * 100);
/** Integer cents back to a 2dp number. */
const fromCents = (c) => Math.round(Number(c) || 0) / 100;

/**
 * Split `totalCents` in proportion to `weights`, exactly.
 *
 * Largest remainder: floor every share, then hand the leftover cents out one at a
 * time to the entries whose fractional part was biggest. Ties break on the
 * earlier index, so the same input always gives the same answer — a
 * non-deterministic apportionment would make a dry-run preview a lie.
 *
 * @param {number} totalCents  integer cents to divide
 * @param {number[]} weights   non-negative, any scale (Ads Manager spend works)
 * @returns {number[]} integer cents, aligned with `weights`, summing to
 *   EXACTLY `totalCents`
 */
function apportion(totalCents, weights) {
  const n = weights.length;
  if (!n) return [];
  const w = weights.map((x) => Math.max(0, Number(x) || 0));
  const sum = w.reduce((a, b) => a + b, 0);
  // Nothing to weight by: split as evenly as the cents allow rather than
  // returning zeros and quietly losing the money.
  if (!(sum > 0)) {
    const base = Math.floor(totalCents / n);
    const out = new Array(n).fill(base);
    for (let i = 0; i < totalCents - base * n; i += 1) out[i] += 1;
    return out;
  }
  const exact = w.map((x) => (totalCents * x) / sum);
  const out = exact.map((x) => Math.floor(x));
  let left = totalCents - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
  for (let k = 0; left > 0; k += 1, left -= 1) out[order[k % n].i] += 1;
  return out;
}

/**
 * Draw `wantCents` out of a list of charges, oldest first.
 *
 * ── Greedy, not pro-rata, and it matters ──
 * Nothing on a Facebook charge says which campaign it funded — that is the whole
 * reason this feature exists. So WHICH charge funds a campaign is arbitrary
 * either way; what is not arbitrary is the total each campaign ends up with.
 * Given that, consuming whole charges oldest-first leaves the ledger with one
 * split per boundary, where pro-rata would split every charge across every
 * campaign (58 charges x 3 campaigns = 174 child rows for one month, none of
 * them telling anyone anything the totals don't).
 *
 * A charge is never over-drawn: `remaining_cents` is what is left after earlier
 * allocations, so re-running this against a partly-allocated month is safe.
 *
 * @param {Array<{id:number, remaining_cents:number}>} charges  oldest first
 * @param {number} wantCents
 * @returns {{slices: Array<{id:number, cents:number}>, drawn: number, short: number}}
 *   `short` > 0 means the month could not fund the request — the caller REFUSES
 *   rather than allocating a partial amount, so the number a person typed is
 *   always the number that gets written.
 */
function drawFromCharges(charges, wantCents) {
  const slices = [];
  let left = Math.max(0, Math.round(wantCents));
  for (const c of charges) {
    if (left <= 0) break;
    const have = Math.max(0, Math.round(c.remaining_cents));
    if (!have) continue;
    const take = Math.min(have, left);
    slices.push({ id: c.id, cents: take });
    left -= take;
  }
  return { slices, drawn: Math.round(wantCents) - left, short: left };
}

/**
 * Several campaigns against one month's charges, applied in the order given.
 *
 * Sequential on purpose: each request draws from what the previous ones left, so
 * the sum of all slices can never exceed the month. Reported per request, so a
 * request that could not be funded is named rather than silently trimmed.
 *
 * @param {Array<{id:number, remaining_cents:number}>} charges
 * @param {Array<{campaign_id:number, cents:number}>} requests
 * @returns {{plan: Array<{campaign_id, cents, slices, short}>, total: number,
 *            short_total: number}}
 */
function drawMany(charges, requests) {
  // A working copy — callers hand us their listing and must not find it mutated.
  const left = charges.map((c) => ({ id: c.id, remaining_cents: Math.max(0, Math.round(c.remaining_cents)) }));
  const byId = new Map(left.map((c) => [c.id, c]));
  const plan = [];
  let total = 0;
  let shortTotal = 0;
  for (const r of requests) {
    const { slices, drawn, short } = drawFromCharges(left, r.cents);
    for (const s of slices) byId.get(s.id).remaining_cents -= s.cents;
    plan.push({ campaign_id: r.campaign_id, cents: drawn, requested: Math.round(r.cents), slices, short });
    total += drawn;
    shortTotal += short;
  }
  return { plan, total, short_total: shortTotal };
}

/**
 * Turn one charge's allocations into the slice list a split family needs.
 *
 * The FIRST slice is the parent's own share (the split writer keeps the parent as
 * slice one), and the family must sum to the charge to the cent. The unallocated
 * remainder stays on the parent, unattributed — which is what keeps an unfinished
 * month honest: the leftover is still in the pool, still visible, still nobody's.
 *
 * A fully-allocated charge with a single campaign yields ONE slice and no split
 * at all — the caller labels the row in place instead of creating a child that
 * duplicates its parent.
 *
 * @param {number} chargeCents  the charge's own amount
 * @param {Array<{campaign_id:number, artist:string, song:string, cents:number}>} allocs
 * @returns {{slices: Array, remainder: number}}
 * @throws if the allocations exceed the charge — a caller that got here with bad
 *   numbers must fail loudly, not write a family that doesn't add up.
 */
function familySlices(chargeCents, allocs) {
  const want = allocs.reduce((s, a) => s + Math.round(a.cents), 0);
  const total = Math.round(chargeCents);
  if (want > total) {
    throw new Error(`allocations (${fromCents(want)}) exceed the charge (${fromCents(total)})`);
  }
  const remainder = total - want;
  const slices = allocs
    .filter((a) => Math.round(a.cents) > 0)
    .map((a) => ({
      campaign_id: a.campaign_id, artist: a.artist, song: a.song,
      cents: Math.round(a.cents), allocated: true,
    }));
  // The unallocated part leads, so it is the row that stays in the pool and keeps
  // the parent's identity. When everything is allocated there is no such part and
  // the first campaign slice becomes the parent.
  if (remainder > 0) slices.unshift({ campaign_id: null, artist: null, song: null, cents: remainder, allocated: false });
  return { slices, remainder };
}

module.exports = { toCents, fromCents, apportion, drawFromCharges, drawMany, familySlices };
