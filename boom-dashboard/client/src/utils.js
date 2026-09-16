// Build absolute URL for a stored file path or filename
export function getFileUrl(filenameOrPath) {
  if (!filenameOrPath) return null
  const base = import.meta.env.VITE_API_URL
    ? import.meta.env.VITE_API_URL.replace(/\/api$/, '')
    : (import.meta.env.PROD ? '' : 'http://localhost:3001')
  // Accept either '/uploads/foo.pdf' or just 'foo.pdf'
  const filePath = filenameOrPath.startsWith('/') ? filenameOrPath : `/uploads/${filenameOrPath}`
  // /uploads is JWT-gated server-side. These render as plain <a href> /
  // window.open links (no Authorization header), so pass the session
  // token as a query param — same pattern as the /bk file endpoints.
  const token = localStorage.getItem('token')
  return base + filePath + (token ? `?token=${encodeURIComponent(token)}` : '')
}

export const formatDate = (dateStr, fallback = '-') => {
  if (!dateStr) return fallback
  // Postgres DATE columns come back as 'YYYY-MM-DD' (no time / TZ). Parsing
  // that through `new Date()` treats it as UTC midnight; `toLocaleDateString`
  // then shifts to the browser's local zone, which drops a day for any
  // user west of UTC (e.g. May 12 in the DB renders as May 11 in PT). Parse
  // the date parts directly off the string instead — same approach as
  // BkLedger's fmtShortDate. Fall back to Date() only for non-ISO inputs
  // (timestamps with time component, ISO 8601 with TZ).
  const s = String(dateStr)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const mo = months[parseInt(m[2], 10) - 1]
    const d = parseInt(m[3], 10)
    if (mo && Number.isFinite(d)) return `${mo} ${d}, ${m[1]}`
  }
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return fallback
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// Normalize invoice number — strip prefixes (#, INV-, INV, Invoice, No., No),
// leading zeros, dashes, spaces. Mirror of normalizeInvoiceNum in
// server/routes/bookkeeping.js. Loops the prefix-strip so combos like
// "Invoice #202645" peel both "invoice " AND "#" — a single-pass regex
// would leave "#202645" stuck against a doc value of "202645".
// Aggressive artist-name normalizer. Returns a stable key that collapses
// punctuation, whitespace, and case so common typo/punctuation variants
// of the same artist bucket together. "LIFE/LINE", "LIFELINE", and
// "Life Line" all resolve to "lifeline".
//
// This is for GROUPING in the UI only — the original (best-spelling)
// name is still preserved for display via existing best-spelling logic.
// The trade-off: legitimately-different artists whose names match after
// stripping (e.g. "21 Savage" vs "21Savage") would collide, but that
// case is so rare in practice (and so easy to spot in the merged card)
// that the win on accidental-duplicate consolidation is worth it.
export function normalizeArtistKey(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Values someone typed into the artist field that name no artist. They are not
// artists and must not rank as them — on the bank-matching page "N/A" was the
// FOURTH largest "artist" at $190,874 before this rule reached it.
//
// MIRROR of PLACEHOLDER_ARTIST_KEYS in server/lib/artist-key.js (it lived in
// routes/reports.js until 2026-08-18, when routes/statements.js needed the same
// answer). Two copies because one runs in the browser and one in the API; if they
// drift, the same spend is an artist on one screen and unattributed on the other.
// Keep them identical — a `node -e` diff of the two sets is in the commit that
// moved it, and the vendor page's "no artist" label now depends on the server
// applying this rule before the row is sent.
export const PLACEHOLDER_ARTIST_KEYS = new Set([
  'na', 'nan', 'none', 'null', 'unassigned', 'tbd', 'tba',
  'various', 'variousartists', 'misc', 'miscellaneous', 'other', 'general',
]);

// The bucket a row's artist belongs to. '' means "no artist" — either the field
// is empty or it holds a placeholder. Callers decide how to label and where to
// sort that bucket; on a page of bank rows it is the large majority, so it
// belongs last rather than first.
export function artistBucket(name) {
  const k = normalizeArtistKey(name);
  return PLACEHOLDER_ARTIST_KEYS.has(k) ? '' : k;
}

// ── Where a ledger row came from ─────────────────────────────────────────────
//
// `entry_source` is 'bank_statement' for rows booked off a bank statement,
// 'recoupments' / 'artist_campaigns' for rows created on those pages, and
// undefined/null for the hand-entered and vendor-submitted invoices that
// predate the column. Client mirror of server/lib/ledger-source.js.
//
// Statement-born rows are DIRECT SPEND: no invoice document, no invoice number,
// and nobody has looked at them. `expenses.recoupable` defaults TRUE and the
// statement booker never sets it, so without this they arrive on the
// recoupment surfaces already marked recoupable against an artist.
//
// Deliberately keyed on the source, not on `recoupable` — nothing rewrites a
// row's flag. Once ledger matching is good enough that these rows carry a real
// artist and category they belong on those pages, and reverting is then
// removing the call sites rather than reconstructing which rows a person had
// deliberately marked non-recoupable.
export function isBankStatementRow(e) {
  return e?.entry_source === 'bank_statement';
}

// Convenience for the fetch boundary — filter here, once per page, rather than
// in each derived view. A page's stat tiles, grouping memo, "non-recoupable"
// panel and label list are all separate chances to let the rows back in.
export function withoutBankRows(rows) {
  return (rows || []).filter(r => !isBankStatementRow(r));
}

/**
 * "Marked Paid, but the bank never showed it" — one definition.
 *
 * Lifted verbatim out of components/BankEvidenceDot.jsx, which is where this
 * judgement was first written and which now imports it back. The dot renders on
 * four pages and the Recoupments flag asks the same question about the same
 * rows; two copies would eventually disagree about a single row, and a row that
 * is verified on one screen and unverified on another is worse than no signal.
 *
 * All three parts are required:
 *   paid           an unpaid invoice has no payment to find on a statement
 *   no evidence    nothing on a ready statement matches it
 *   bank_expected  a ready statement COVERS that payment date (±3 days)
 *
 * That last one is the honest-silence rule. Without a statement covering the
 * date there is nothing this could have matched, so "no bank line" reports a
 * missing upload, not a missing payment. Both fields come from
 * server/lib/bank-evidence.js and ride along on the expense list endpoints.
 */
export function bankUnverified(row) {
  return recoupState(row) === 'unverified';
}

/**
 * What the BANK says about one recoupable cost — four states, one definition.
 *
 *   verified            a ready statement shows the payment. Provable to a partner.
 *   awaiting_statement  paid, and NO ready statement covers the date yet. This is
 *                       the normal case for a cost uploaded the same month it was
 *                       paid, and it is not a problem — there is nothing it could
 *                       have matched. Counted, and shown as its own state so it
 *                       stops looking identical to `verified`.
 *   unverified          paid, a statement DOES cover the date, and no line matches.
 *                       The only one of the four that is a discrepancy.
 *   unpaid              nothing has left the bank, so nothing is expected.
 *
 * `bankUnverified` above is exactly the third of these and keeps its name, so the
 * evidence dot on Ledger, Payments, Vendors and Invoices cannot come to disagree
 * with the bands on Recoupments — one row, one answer, four screens.
 *
 * Both `bank_evidence` and `bank_expected` come from server/lib/bank-evidence.js
 * and ride along on every expense list endpoint.
 */
export function recoupState(row) {
  if (!row) return 'unpaid';
  if (row.bank_evidence) return 'verified';
  if (row.payment_status !== 'Paid') return 'unpaid';
  return row.bank_expected ? 'unverified' : 'awaiting_statement';
}

// The states that COUNT toward what an artist can be shown: money that has left
// the bank, whether or not the statement proving it has been uploaded yet.
export const RECOUP_COUNTED = ['verified', 'awaiting_statement'];
export const recoupCounted = (row) => RECOUP_COUNTED.includes(recoupState(row));

/**
 * Bank-born rows on the recoupment surfaces: allowed ONLY once reviewed.
 *
 * `withoutBankRows` (above) keeps every statement-born row off these pages, for
 * the reason documented there: `recoupable` is `BOOLEAN DEFAULT TRUE` and
 * `bookDebitAsEntry` never sets it, so all 1,972 of them arrive marked recoupable
 * against nobody — $3,101,837 of unvetted spend, of which only 53 even name an
 * artist.
 *
 * The gate is therefore REVIEWED, not `recoupable`: a default is not a decision.
 * Once somebody has answered "is this recoupable?" on a bank-born row, it belongs
 * here like any other cost.
 *
 * Deliberately a NEW function. `withoutBankRows` means what it says and ten other
 * sites depend on that.
 */
export function withoutUnreviewedBankRows(rows) {
  return (rows || []).filter(r => !isBankStatementRow(r) || r.recoup_reviewed === true);
}

export function normalizeInvoiceNum(num) {
  if (!num) return ''
  let s = String(num).toLowerCase().trim()
  let prev
  do {
    prev = s
    // Prefix-separator char class matches the server-side canonical
    // normalizer in server/lib/normalize-invoice-num.js — includes `/`
    // and `_` so "INV/01" and "INV_01" normalize to the same key as
    // "INV-01".
    s = s.replace(/^(invoice|inv|no\.?|#)[\s\-.:_/]*/i, '')
  } while (s && s !== prev)
  return s.replace(/[-\s.]/g, '').replace(/^0+/, '') || '0'
}

// ── Currency helpers ─────────────────────────────────────────────────────
// `rates` is the { USD: 1, EUR: 0.92, ... } map from /api/fx/rates: 1 USD =
// X foreign. Convert by dividing: usd = amount / rates[currency].

// Plain currency formatter — same shape we already use across pages but
// centralized here so callers don't reinvent it.
export function fmtMoney(amount, currency = 'USD') {
  const cur = (currency || 'USD').toUpperCase()
  const n = Number(amount) || 0
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n)
}

// Convert a foreign amount to USD. Returns null when the rate is missing
// or the amount can't be parsed — callers decide whether to render the
// USD equivalent or fall back to native-only.
//
// `lockedRate` (optional, 4th arg) is the per-entry locked rate stamped
// when a row is marked Paid — preferred over the live `rates` table so
// that paid invoices show a frozen USD value forever. NULL/undefined
// means "no lock yet, fall back to live rates" (unpaid rows).
export function toUsd(amount, currency, rates, lockedRate) {
  if (amount === '' || amount == null) return null
  const n = Number(amount)
  if (!isFinite(n)) return null
  const cur = (currency || 'USD').toUpperCase()
  if (cur === 'USD') return n
  const locked = Number(lockedRate)
  const effRate = (Number.isFinite(locked) && locked > 0)
    ? locked
    : rates?.[cur]
  if (!effRate || !isFinite(effRate) || effRate <= 0) return null
  return n / effRate
}

// Parse a free-text amount query into a matcher `(amount:number) => bool`.
// Supports the shapes the Ledger + Payment Dashboard search bars accept:
//   ""              → matches everything (falsy query, no filter)
//   "500"           → exact match on 500 (±$0.01 float tolerance)
//   "500.50"        → exact match on 500.50 (±$0.01)
//   "500-1000"      → range [500, 1000] inclusive
//   ">500", ">=500" → greater than / greater-or-equal
//   "<500", "<=500" → less than / less-or-equal
// Currency symbols, commas, and whitespace are stripped before parsing,
// so "$1,234.56" behaves like "1234.56". Returns null for invalid
// input — caller treats that as "no filter" (better than filtering
// everything out on a typo).
export function parseAmountQuery(raw) {
  const s = String(raw || '').trim().replace(/[$,\s]/g, '');
  if (!s) return null;
  // Range: "500-1000" — anchored ^-$ so a stray dash inside a number
  // (unlikely for amounts, but safe) doesn't accidentally match.
  const rangeMatch = s.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
  if (rangeMatch) {
    const lo = parseFloat(rangeMatch[1]);
    const hi = parseFloat(rangeMatch[2]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    const [min, max] = lo <= hi ? [lo, hi] : [hi, lo];
    return (n) => Number.isFinite(n) && n >= min && n <= max;
  }
  // Comparison: >=, <=, >, < (order matters — try compound first).
  const cmpMatch = s.match(/^(>=|<=|>|<)(\d+(?:\.\d+)?)$/);
  if (cmpMatch) {
    const op = cmpMatch[1];
    const v = parseFloat(cmpMatch[2]);
    if (!Number.isFinite(v)) return null;
    if (op === '>=') return (n) => Number.isFinite(n) && n >= v;
    if (op === '<=') return (n) => Number.isFinite(n) && n <= v;
    if (op === '>')  return (n) => Number.isFinite(n) && n >  v;
    if (op === '<')  return (n) => Number.isFinite(n) && n <  v;
  }
  // Plain number → exact match with a small float tolerance so 500.00
  // still matches "500". Tolerance is $0.005 — half a cent, tight
  // enough to reject 500 vs 501, loose enough to survive float noise.
  const num = parseFloat(s);
  if (Number.isFinite(num) && /^\d+(\.\d+)?$/.test(s)) {
    return (n) => Number.isFinite(n) && Math.abs(n - num) < 0.005;
  }
  return null;
}

// Entry-aware wrapper. Reads amount / currency / fx_rate_to_usd off the
// entry so every caller can switch from passing three args to passing
// the row itself.
export function entryToUsd(entry, rates) {
  if (!entry) return null
  return toUsd(entry.amount, entry.currency, rates, entry.fx_rate_to_usd)
}

// Sum USD-equivalents across a list of expense rows, honoring per-row
// locked rates. Replaces totalsToUsd at every call site that has the
// underlying entries (which is most of them — the {currency:amount} map
// is only useful for native-breakdown display). Returns null if NOTHING
// could be converted (so callers can hide the line rather than mislead).
export function itemsToUsd(items, rates) {
  let total = 0
  let anyConverted = false
  for (const e of (items || [])) {
    const v = entryToUsd(e, rates)
    if (v != null) { total += v; anyConverted = true }
  }
  return anyConverted ? total : null
}

// "(≈ $X USD)" suffix when items include any non-USD entries. Empty
// otherwise. Honors per-row locked rates via itemsToUsd.
export function usdItemsSuffix(items, rates, opts = {}) {
  if (!items || !items.length) return ''
  if (items.every(e => (e?.currency || 'USD').toUpperCase() === 'USD')) return ''
  const usd = itemsToUsd(items, rates)
  if (usd == null) return ''
  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: opts.precise ? 2 : 0,
    maximumFractionDigits: opts.precise ? 2 : 0,
  })
  return ` (≈ ${fmt.format(usd)} USD)`
}

// Headline "$X" — no parens, no "≈", no " USD" — for stat cards that
// promote the USD-equivalent to the prominent number. Items-aware so
// it honors per-row locked rates.
export function fmtUsdItems(items, rates, opts = {}) {
  const usd = itemsToUsd(items, rates)
  if (usd == null) return ''
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: opts.precise ? 2 : 0,
    maximumFractionDigits: opts.precise ? 2 : 0,
  }).format(usd)
}

// Format the USD equivalent of a foreign amount as a parenthetical
// suffix string ("≈ $540"). Returns '' for USD amounts and missing
// rates — wrap it in JSX directly:
//
//     {fmtMoney(amt, cur)}<span className="text-gray-400">{usdSuffix(amt, cur, rates)}</span>
export function usdSuffix(amount, currency, rates, opts = {}) {
  const cur = (currency || 'USD').toUpperCase()
  if (cur === 'USD') return ''
  const usd = toUsd(amount, currency, rates)
  if (usd == null) return ''
  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: opts.precise ? 2 : 0,
    maximumFractionDigits: opts.precise ? 2 : 0,
  })
  return ` (≈ ${fmt.format(usd)})`
}

// Convenience: returns "€500.00 (≈ $540)" for one-shot usage.
export function fmtMoneyWithUsd(amount, currency, rates, opts = {}) {
  return fmtMoney(amount, currency) + usdSuffix(amount, currency, rates, opts)
}

// Entry-aware version of usdSuffix — honors the row's locked rate. Use
// this whenever you have the row object (most ledger rendering paths).
export function usdSuffixForEntry(entry, rates, opts = {}) {
  if (!entry) return ''
  const cur = (entry.currency || 'USD').toUpperCase()
  if (cur === 'USD') return ''
  const usd = entryToUsd(entry, rates)
  if (usd == null) return ''
  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: opts.precise ? 2 : 0,
    maximumFractionDigits: opts.precise ? 2 : 0,
  })
  return ` (≈ ${fmt.format(usd)})`
}

// Sum a { currency: amount } map into a single USD-equivalent number.
// Useful for one-line "≈ $X total" summaries below mixed-currency
// breakdowns. Returns null if EVERY currency in the map lacks a rate
// (so callers can hide the line rather than mislead).
export function totalsToUsd(byCurrency, rates) {
  let total = 0
  let anyConverted = false
  for (const [cur, amt] of Object.entries(byCurrency || {})) {
    const v = toUsd(amt, cur, rates)
    if (v != null) { total += v; anyConverted = true }
  }
  return anyConverted ? total : null
}

// "(≈ $X USD)" suffix for a { currency: amount } map. Returns '' when
// the map is empty, USD-only, or no rates are available — so it's safe
// to append unconditionally:
//
//     {fmtTotals(byCur)}<span>{usdTotalSuffix(byCur, rates)}</span>
export function usdTotalSuffix(byCurrency, rates, opts = {}) {
  if (!byCurrency) return ''
  const keys = Object.keys(byCurrency).filter(k => byCurrency[k])
  if (keys.length === 0) return ''
  if (keys.length === 1 && keys[0].toUpperCase() === 'USD') return ''
  const usd = totalsToUsd(byCurrency, rates)
  if (usd == null) return ''
  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: opts.precise ? 2 : 0,
    maximumFractionDigits: opts.precise ? 2 : 0,
  })
  return ` (≈ ${fmt.format(usd)} USD)`
}

// ── Socials (social_handles JSONB) helpers ────────────────────────────
// Historically each entry was { platform, handle }. To support split
// invoices where different handles belong to different artists, entries
// now carry an optional `artist` tag: { platform, handle, artist? }.
// Untagged entries render for every artist (backwards compatible), so a
// legacy row with no tags behaves the way it did before.

// Normalize a raw social_handles array into a clean list. Drops empty
// rows and trims whitespace. Preserves the artist tag when present.
export function normalizeSocials(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const s of raw) {
    const platform = String(s?.platform || '').trim()
    const handle = String(s?.handle || '').trim()
    const artist = String(s?.artist || '').trim()
    if (!handle) continue
    const row = { platform, handle }
    if (artist) row.artist = artist
    out.push(row)
  }
  return out
}

// Filter a socials array down to entries tagged for the given artist
// PLUS every untagged entry (untagged = shared across the family).
// Case-insensitive artist match with trimming. Passing an empty/null
// artistName returns the list unchanged.
export function filterSocialsForArtist(list, artistName) {
  if (!Array.isArray(list)) return []
  const key = String(artistName || '').trim().toLowerCase()
  if (!key) return list
  return list.filter(s => {
    const a = String(s?.artist || '').trim().toLowerCase()
    return !a || a === key
  })
}

// Extract the unique artist names present in an invoice's split family
// (parent + every breakdown row). Used to populate the "For artist"
// dropdown in the socials editor when a row has splits. Preserves the
// first-seen casing so the dropdown reads naturally.
export function familyArtists(entry, extraRows = []) {
  const seen = new Set()
  const out = []
  const push = (name) => {
    const t = String(name || '').trim()
    if (!t) return
    const k = t.toLowerCase()
    if (seen.has(k)) return
    seen.add(k)
    out.push(t)
  }
  push(entry?.artist)
  if (Array.isArray(entry?.artist_breakdown)) {
    for (const r of entry.artist_breakdown) push(r?.artist)
  }
  for (const r of extraRows) push(r?.artist)
  return out
}

// ── Local calendar-date helpers ──────────────────────────────────────────
// `new Date('YYYY-MM-DD')` parses as UTC midnight, which is the previous
// evening in US timezones — so "due today" rows looked overdue all day and
// setHours(0,0,0,0) landed on yesterday. Compare calendar dates as LOCAL
// dates instead. Accepts date-only strings or full ISO timestamps (the
// leading 10 chars are the calendar date either way).

export function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function dateOnly(value) {
  if (!value) return null
  const s = String(value).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

// True when the date is strictly before today (local). "Due today" is NOT past.
export function isPastLocal(value) {
  const s = dateOnly(value)
  return !!s && s < localDateStr()
}

// Whole days from today (local) to the date: 0 = today, negative = past,
// null = missing/invalid.
export function daysUntilLocal(value) {
  const s = dateOnly(value)
  if (!s) return null
  const [y, m, d] = s.split('-').map(Number)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((new Date(y, m - 1, d) - today) / 86400000)
}

// Ordering for a drill list: by name, by money, or by date.
//
// Extracted so it can be tested directly. Two things in it are easy to get wrong
// and invisible once wrong:
//
//   • MONEY IS COMPARED IN USD, never at face value. A drill mixes currencies —
//     an AUD row sits next to a USD one — and ordering 861.29 above 904.99 by the
//     printed number is the same class of error as adding them together.
//   • localeCompare with sensitivity 'base', so "Alvaro" and "alvaro" order
//     together and case does not decide it.
//
// `dir` is +1 for the direction named in the label and -1 reversed. Date falls
// back to id so rows sharing a day keep a stable order rather than shuffling on
// every render.
export function drillComparator({ key, dir = 1 } = {}) {
  if (key === 'payee') {
    return (a, b) => dir * String(a?.payee || '')
      .localeCompare(String(b?.payee || ''), undefined, { sensitivity: 'base' })
  }
  if (key === 'amount') {
    const usd = (r) => Number(r?.usd ?? r?.amount) || 0
    return (a, b) => dir * (usd(b) - usd(a))
  }
  return (a, b) => {
    const d = String(a?.date || '').localeCompare(String(b?.date || ''))
    return dir * (d || ((a?.id || 0) - (b?.id || 0)))
  }
}
