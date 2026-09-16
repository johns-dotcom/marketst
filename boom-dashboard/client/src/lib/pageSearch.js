// Finding a PAGE by typing what you call it.
//
// Pure and separate so the ranking can be asserted in node. It is the half of
// the palette that never touches the network — fifty rows already in the bundle
// — and a page you are trying to reach should not wait on a request.
//
// This palette searched releases, artists, contracts and deals — none of which
// appear in the top fifteen pages by views. It could not find a VENDOR, the
// single most-visited page in the app, and it could not find a PAGE at all. For
// the person who is 88% of the usage it was inert.
//
// Pages match locally against label, path and the `synonyms` string every nav
// entry now carries, so "w9" reaches Vendors, "p&l" reaches Reports and "payroll"
// reaches Salary. No round trip: the whole vocabulary is fifty rows already in
// the bundle, and a page you are trying to reach should not wait on a network.
//
// Scoring is deliberately crude and stable — an exact label match, then a label
// prefix, then a label substring, then anything in the synonyms — because a
// palette that reorders subtly between keystrokes is worse than one that ranks
// imperfectly.
export function scorePage(page, q) {
  const label = page.label.toLowerCase()
  const hay = `${label} ${page.path.toLowerCase()} ${(page.synonyms || '').toLowerCase()}`
  if (label === q) return 100
  if (label.startsWith(q)) return 80
  if (label.includes(q)) return 60
  if (page.path.toLowerCase().includes(q)) return 40
  if (hay.includes(q)) return 20
  return 0
}


/**
 * The visible page results for a query: allowed, matching, ranked, capped.
 *
 * `canView` is applied BEFORE ranking, not after, so the cap of six is six
 * pages you can actually open. Filtering afterwards would silently return four
 * when two of the top six were forbidden.
 */
export function searchPages(pages, query, canView) {
  const q = String(query || '').trim().toLowerCase()
  if (q.length < 2) return []
  return pages
    .filter((p) => (canView ? canView(p.path) : true))
    .map((p) => ({ ...p, score: scorePage(p, q) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.label.length - b.label.length)
    .slice(0, 6)
}
