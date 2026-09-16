/**
 * Vendor alias resolution — one definition of "these names are the same vendor".
 *
 * `vendor_aliases` maps an alternate spelling (DBA, business name, a merged-away
 * vendor) to a primary. Six files query that table and four of them built their
 * own lookup: the 1099 report, the W9 cross-entry check, vendor-submit, and the
 * statement matcher. Four answers to one question is how they drift — the same
 * failure that produced today's reversal bug, where statements.js knew about
 * reversals and reports.js did not.
 *
 * ── Two things the ad-hoc versions got wrong ────────────────────────────────
 *
 * 1. RESOLUTION WAS ONE HOP. `SELECT primary_name WHERE alias = $1 LIMIT 1`
 *    stops at the first primary. In production 48 of 193 alias rows have an
 *    alias that is ITSELF a primary_name, so A→B→C resolves to B and stops.
 *
 * 2. GROUPING NEVER UNIONED. The matcher built its group as
 *      const grp = aliases.get(p) || aliases.get(a) || new Set()
 *    which takes whichever set already exists but never merges two pre-existing
 *    sets. When a later row links two already-formed groups, members are left
 *    pointing at different sets — 6 names were in that state. Union-find fixes
 *    it properly and is cycle-safe, which matters because nothing in the schema
 *    prevents A→B and B→A.
 *
 * Names are compared lower-cased and trimmed, matching every existing consumer
 * and the LOWER() indexes on the table. Note the table's UNIQUE(alias) is on the
 * RAW text, so case-variant duplicates can point at different primaries; see
 * `ambiguousAliases` for surfacing those rather than silently last-write-wins.
 */

const key = (s) => String(s || '').trim().toLowerCase();

// Corporate suffixes and filler that identify no vendor on their own.
const NOISE_ALIAS = new Set([
  'llc', 'l.l.c', 'l.l.c.', 'inc', 'inc.', 'incorporated', 'corp', 'corp.', 'corporation',
  'co', 'co.', 'company', 'ltd', 'ltd.', 'limited', 'llp', 'lp', 'plc', 'gmbh', 'ag', 'sa',
  'sl', 'bv', 'pty', 'kg', 'group', 'holding', 'holdings', 'enterprise', 'enterprises',
  'partner', 'partners', 'the', 'and', '&', 'dba', 'llc.', 'll',
]);

/**
 * Is this alias too weak to identify a vendor?
 *
 * THIS GUARD IS LOAD-BEARING, and it is why transitive resolution is safe here.
 *
 * Production holds alias rows whose alias is literally "Inc", "LLC" and "I" —
 * almost certainly a name-splitting bug at entry creation, preserved because
 * `UNIQUE(alias)` is case-sensitive while every reader lower-cases, so "Inc",
 * "INC" and "inc" are three rows pointing at three DIFFERENT vendors.
 *
 * One hop, those rows are merely useless. Transitively, they are bridges: "Inc"
 * joined a $680k vendor to an unrelated $1.5k one, and "LLC" joined two more.
 * Union-find without this filter would have made those single vendors for
 * matching purposes — strictly worse than the partial grouping it replaced.
 *
 * So: an alias must carry at least two LETTERS and must not be a bare corporate
 * suffix. Rejecting is safe — the worst case is that two spellings of one vendor
 * stay separate, which is today's behaviour.
 *
 * The letter test is Unicode-aware (`\p{L}`) on purpose. An earlier /[a-z]{3}/
 * version rejected "房建" and "A Trần" — real vendors whose aliases are their
 * romanisations, which is precisely what this table exists for. A Latin-only
 * rule quietly unlinks every non-Latin vendor.
 */
function isNoiseAlias(name) {
  const k = key(name);
  if (NOISE_ALIAS.has(k)) return true;
  // Letter COUNT, not string length: "房建" is a complete two-character name,
  // so a raw length floor rejects it while accepting the useless "Inc".
  // Single-letter junk ("I") falls out of the same rule.
  if ((k.match(/\p{L}/gu) || []).length < 2) return true;
  // "inc llc" and friends: nothing but suffix words.
  const words = k.split(/[^a-z0-9&]+/).filter(Boolean);
  if (words.length && words.every((w) => NOISE_ALIAS.has(w))) return true;
  return false;
}

/**
 * Union-find over the alias pairs. Returns equivalence classes that are true
 * classes: every member of a group maps to the SAME Set instance, transitively,
 * regardless of row order or chain length.
 *
 * @param {Array<{primary_name: string, alias: string}>} rows
 * @returns {{ groups: Map<string, Set<string>>, canonical: (name: string) => string }}
 */
function buildAliasIndex(rows = []) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) { parent.set(x, x); return x; }
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    // Path compression — chains are common here, so this is not academic.
    let cur = x;
    while (parent.get(cur) !== root) { const nxt = parent.get(cur); parent.set(cur, root); cur = nxt; }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // `preferred` remembers which names were ever a primary_name, so the class can
  // report a sensible display name rather than whichever string won the union.
  const preferred = new Map();
  const rejected = [];
  for (const r of rows) {
    const a = key(r.alias);
    const p = key(r.primary_name);
    if (!a || !p || a === p) continue;
    // See isNoiseAlias: these are bridges between unrelated vendors.
    if (isNoiseAlias(a) || isNoiseAlias(p)) { rejected.push({ alias: r.alias, primary_name: r.primary_name }); continue; }
    find(a); find(p);
    union(a, p);
    preferred.set(p, (preferred.get(p) || 0) + 1);
    if (!preferred.has(a)) preferred.set(a, 0);
  }

  const groups = new Map();
  const byRoot = new Map();
  for (const name of parent.keys()) {
    const root = find(name);
    if (!byRoot.has(root)) byRoot.set(root, new Set());
    byRoot.get(root).add(name);
  }
  // Every member points at the SAME Set instance — callers rely on identity.
  for (const set of byRoot.values()) for (const name of set) groups.set(name, set);

  // The class's display name: the member that was a primary most often, ties
  // broken alphabetically so the answer is stable across runs.
  const canonicalOf = new Map();
  for (const set of new Set(groups.values())) {
    const best = [...set].sort((x, y) =>
      (preferred.get(y) || 0) - (preferred.get(x) || 0) || (x < y ? -1 : 1))[0];
    for (const name of set) canonicalOf.set(name, best);
  }

  return {
    groups,
    // A name with no alias row resolves to itself — never undefined, so callers
    // can use it unconditionally.
    canonical: (name) => canonicalOf.get(key(name)) || key(name),
    // Alias rows ignored as too weak to identify a vendor. Surfaced rather than
    // dropped silently so they can be cleaned up.
    rejected,
  };
}

/** Every alias whose case-variants point at different primaries. */
function ambiguousAliases(rows = []) {
  const byAlias = new Map();
  for (const r of rows) {
    const a = key(r.alias);
    if (!a) continue;
    if (!byAlias.has(a)) byAlias.set(a, new Set());
    byAlias.get(a).add(key(r.primary_name));
  }
  return [...byAlias.entries()].filter(([, s]) => s.size > 1).map(([alias, s]) => ({ alias, primaries: [...s] }));
}

/** Load the table and build the index. `.catch` mirrors existing call sites: a
 *  missing table degrades to "no aliases", never takes matching down. */
async function loadAliasIndex(pool) {
  const { rows } = await pool.query('SELECT primary_name, alias FROM vendor_aliases')
    .catch(() => ({ rows: [] }));
  return buildAliasIndex(rows);
}

module.exports = { buildAliasIndex, ambiguousAliases, loadAliasIndex, isNoiseAlias, aliasKey: key };
