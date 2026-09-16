// ── Bank statement display vocabulary — ONE definition ───────────────────────
//
// Shared by the Statements library (BkStatements) and Bank Matching
// (BkBankMatching). These moved out of BkStatements when the review work got
// its own page: both surfaces render the same transactions, and two copies of
// `cleanBankPayee` or `stmtLabel` is the failure this codebase keeps paying for
// — four ad-hoc alias resolvers, two nav lists, the ledger's Source badge that
// silently lost a bucket.
//
// Pure display helpers only. Anything that decides what a row MEANS (matching,
// categorisation, dismissal) stays server-side.

export const ACCOUNTS = [
  { key: 'bofa', label: 'Bank of America' },
  { key: 'paypal', label: 'PayPal' },
]
export const acctLabel = (k) => ACCOUNTS.find((a) => a.key === k)?.label || k

export const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// Friendly statement name — "July 2026" beats the bank's raw
// "FQ6W4BBNTMMJ8-MSR-20260701000000-…" filename (kept as a tooltip).
export const stmtLabel = (st) => {
  if (!st?.period_start) return st?.filename || ''
  const [y, m] = String(st.period_start).slice(0, 7).split('-')
  return `${MONTH_FULL[Number(m) - 1]} ${y}`
}

// Open the original uploaded statement (PDF/CSV) in a new tab. The auth
// middleware accepts ?token= so a plain browser link works.
export const viewStmtFile = (id) =>
  window.open(`/api/statements/${id}/file?token=${localStorage.getItem('token')}`, '_blank', 'noopener')

// A statement, named the way a person thinks of it: the month it covers, then
// the account, short — "May 2026 · BofA". `filename` is what the bank called
// the file ("eStmt_2026-05-29 (1).pdf", "FQ6W4BBNTMMJ8-MSR-20260601000000-2"),
// which is unreadable in a dropdown and sorts by nothing useful.
//
// The SHORT account form on purpose: this is a <option>, and "Bank of America"
// pushes the month out of a narrow select. `acctLabel` above is the long form,
// for prose. Lived in BkLedger until the statement picker became shared chrome.
export const stmtOptionLabel = (st) => {
  const d = st?.period_end || st?.period_start
  const when = d
    ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', {
      month: 'short', year: 'numeric', timeZone: 'UTC' })
    : String(st?.filename || '').slice(0, 18)
  const acct = st?.account === 'bofa' ? 'BofA'
    : st?.account === 'paypal' ? 'PayPal'
      : String(st?.account || '').toUpperCase()
  return `${when}${acct ? ` · ${acct}` : ''}`
}

export const fmt = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// Mirror of the server's displayBankPayee: strips card-code tokens so
// "FACEBK *BXJJYTMFP2 650-543..." prefills as vendor "FACEBK".
export const cleanBankPayee = (s) => String(s || '')
  .replace(/[*#]/g, ' ')
  .split(/\s+/)
  .filter((w) => w && !(w.length >= 4 && (w.match(/\d/g) || []).length >= 2)
    && !(w.length >= 5 && /\d/.test(w) && /[a-z]/i.test(w)) // mixed alnum ≥5 = card code ("2THTXF")
    && !/^\d{4,}$/.test(w))
  .join(' ')
  .trim() || String(s || '').trim()

export const fmtDate = (d) => {
  if (!d) return '—'
  const s = String(d).slice(0, 10)
  const [y, m, day] = s.split('-')
  return y ? `${m}/${day}/${y}` : s
}

// A suggestion's status line: "Paid 06/17/2026", "Unpaid · due 06/20/2026",
// "Unpaid · invoiced 06/12/2026".
//
// The date is the one the server SCORED against (evidence_date), so it always
// explains that suggestion's own ±Nd chip. Reviewing a card previously showed a
// day-delta with neither date on screen, which meant leaving the deck to decide
// whether a match was right. `evidence_kind` comes from the server for the same
// reason — deriving "is this a paid date" here would be a second opinion that
// can drift from the scorer's.
export const suggestionWhen = (s) => {
  const status = s.payment_status || 'Unpaid'
  if (!s.evidence_date || !s.evidence_kind) return status
  const when = fmtDate(s.evidence_date)
  if (s.evidence_kind === 'paid') return `${status} ${when}`
  return `${status} · ${s.evidence_kind === 'scheduled' ? 'due' : 'invoiced'} ${when}`
}

// ── Telling near-identical candidates apart ──────────────────────────────────
//
// When one bank line offers several invoices, the useful question is never
// "what does this invoice say" — it is "how is THIS one different from the one
// below it". So a card renders every field but emphasises only the ones that
// differ across that row's candidates, and mutes what they share.
//
// This is not cosmetic. A live PayPal line offers three invoices identical on
// payee, amount, score, status and date; before the server sent artist/song
// they were separable only by invoice number, and the old flat list rendered
// them near-identically. Picking wrong marks the wrong invoice paid, and
// nothing downstream ever contradicts it.
//
// Entered carries the TIME because same-day entry is the common case (all
// three PayPal candidates were entered on 2026-06-17); the clock is what
// separates them.
export const CANDIDATE_FIELDS = [
  // Vendor leads, and it is on the card even though sharedLine() names it
  // above when every candidate agrees. That line only prints the payee when it
  // is COMMON to all — so in the one case where the vendor is what separates
  // the candidates, it was the one field nowhere on screen. Not an edge case:
  // 8 of the 10 live multi-candidate rows offer candidates with different
  // payees. As a field it just joins the diff, muted when shared and
  // highlighted when it isn't, which is the right behaviour in both cases.
  ['payee', 'Vendor', (s) => s.payee || '—'],
  ['entered_at', 'Entered', (s) => (s.entered_at
    ? new Date(s.entered_at).toLocaleString(undefined,
      { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—')],
  ['description', 'Covers', (s) => s.description || '—'],
  ['invoice_date', 'Issued', (s) => fmtDate(s.invoice_date)],
  ['artist', 'Artist', (s) => s.artist || '—'],
  ['song', 'Song', (s) => s.song || '—'],
  ['boom_rep', 'Approver', (s) => s.boom_rep || '—'],
  ['family_total', 'Amount', (s) => fmt(s.family_total)],
]

// Which field keys differ across a row's candidates.
//
// Compared on the RENDERED string, never the raw value: two timestamps a
// millisecond apart display identically, and highlighting a field that looks
// the same in both cards teaches the reader to distrust the highlight.
export function candidateDiff(cands) {
  const differing = new Set()
  if (!cands || cands.length < 2) return differing
  for (const [key, , render] of CANDIDATE_FIELDS) {
    const first = render(cands[0])
    if (cands.some((c) => render(c) !== first)) differing.add(key)
  }
  // The highlight has to EARN its keep.
  //
  // Marking what differs only helps when what differs is the minority — a
  // couple of fields separating candidates that otherwise agree, which is the
  // Egoflow and PayPal case this was built for. When most fields differ, every
  // row lights up and the card becomes a wall of amber that says nothing: the
  // candidates are plainly different invoices and the reader can just read
  // them. Signal, not decoration.
  //
  // Deliberately NOT applied to nearIdentical() below — that fires on vendor,
  // amount and confidence agreeing, which is a different and still-correct
  // test, and it's the one that warns a wrong pick is silent.
  return differing.size > CANDIDATE_FIELDS.length / 2 ? new Set() : differing
}

// Same vendor, same money, same confidence — the shape where the old UI was
// actively dangerous rather than merely unhelpful.
export const nearIdentical = (cands) => (cands || []).length > 1
  && cands.every((c) => String(c.payee || '') === String(cands[0].payee || '')
    && fmt(c.family_total) === fmt(cands[0].family_total)
    && Number(c.score) === Number(cands[0].score))

// What the candidates SHARE, said once above the cards so each card doesn't
// have to repeat it: "Egoflow · $7,750.00 · all 3 at 85%".
export function sharedLine(cands) {
  if (!(cands || []).length) return ''
  const parts = []
  if (cands.every((c) => c.payee === cands[0].payee)) parts.push(cands[0].payee)
  if (cands.every((c) => fmt(c.family_total) === fmt(cands[0].family_total))) parts.push(fmt(cands[0].family_total))
  parts.push(cands.every((c) => Number(c.score) === Number(cands[0].score))
    ? `all ${cands.length} at ${cands[0].score}%`
    : `${cands.length} candidates, ${Math.min(...cands.map((c) => c.score))}–${Math.max(...cands.map((c) => c.score))}%`)
  return parts.join(' · ')
}

// Case-normalize SHOUTING bank titles for display ("HOTEL LIVE AQUA CDMX" →
// "Hotel Live Aqua CDMX"); the raw descriptor stays in the tooltip.
export const KEEP_UPPER = new Set(['LLC', 'INC', 'LTD', 'LLP', 'PLC', 'CO', 'USA', 'UK', 'EU', 'AI', 'TV', 'DJ', 'NYC', 'LA', 'CDMX', 'II', 'III', 'IV', 'DES', 'ID'])
export const displayCaseTitle = (s) => {
  const str = String(s || '')
  if (!/[A-Z]/.test(str) || str !== str.toUpperCase()) return str
  return str.toLowerCase().replace(/[a-z][a-z0-9]*/g, (w) =>
    KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))
}

// Loose containment — is one string just a restatement of the other?
// ("External transfer fee - 3 Day -" vs "…- 3 Day - 06/29/2026")
export const normTxt = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
export const restates = (a, b) => {
  const na = normTxt(a), nb = normTxt(b)
  if (!na || !nb) return false
  return na.startsWith(nb) || nb.startsWith(na)
}

// ── Descriptors that name a payment CHANNEL, not a payee ─────────────────────
//
// Every vendor paid through PayPal shares the descriptor "PAYPAL", so a vendor
// link there is a link to a page about nothing — and worse, to a page about the
// wrong somebody. The server already refuses to learn a payee lesson keyed on
// one of these: a single lesson on "PAYPAL" once claimed all 154 PayPal pulls,
// $94,660.97 of other people's payments, for one vendor whose own rows are a
// monthly salary transfer.
//
// This list lives here because THREE surfaces now need it — the Bank Matching
// row, the Bank Ledger row, and ExtraTxRow — and it had already drifted while
// there were only two copies. BkBankMatching held six entries under a comment
// claiming they were "the same list the server refuses to learn payee lessons
// for"; the server (routes/statements.js) held thirteen, missing `wire transfer
// fee` and carrying seven the client never had. This is the UNION, so the two
// halves suppress the same rows.
//
// The consequence is deliberate and worth stating: `ACH`, `WIRE`, `TRANSFER`
// and `ONLINE TRANSFER` descriptors stop offering a link. Those name a rail,
// not a counterparty. FACEBK is deliberately NOT here — Facebook IS the vendor.
export const CHANNEL_ONLY_PAYEES = new Set([
  'paypal', 'venmo', 'zelle', 'cash app', 'cashapp', 'square', 'stripe',
  'wire', 'transfer', 'ach', 'bill pay', 'online transfer', 'external transfer',
  'wire transfer fee',
])

// Tested BOTH ways, because the two halves of the app normalize differently:
// the client compared the raw descriptor lowercased, the server compares
// `normalizeBankPayee` (whose mirror here is `cleanBankPayee`). Checking only
// one leaves a descriptor that one half suppresses and the other links.
//
// Neither catches trailing tokens — "PAYPAL *INST XFER 4829" cleans to
// "paypal inst xfer" and passes. That gap is left SYMMETRIC with the server
// rather than closed here: a third normalization rule invented on the client is
// how these two lists drifted in the first place.
export const isChannelOnlyPayee = (s) => {
  const raw = String(s || '').trim().toLowerCase()
  if (!raw) return true
  return CHANNEL_ONLY_PAYEES.has(raw) || CHANNEL_ONLY_PAYEES.has(cleanBankPayee(s).toLowerCase())
}

// The vendor a transaction names, preferring the LEDGER payee over the bank
// descriptor. A matched or booked row links through its entry; only an
// unmatched one falls back to what the bank printed. Linking the raw descriptor
// would land on an empty vendor page for exactly the rows a person is most
// likely to click — the ones that look wrong.
//
// Returns '' when the row names nobody, so callers can render plain text rather
// than a dead link. Note `description` is deliberately never a source: a
// description is a sentence, and a sentence makes a nonsense vendor page.
export const txVendorName = (t) => String(t?.matched?.payee || t?.payee_guess || '').trim()

// The name to LINK for a transaction, or '' when it should stay plain text.
export const txVendorLinkName = (t) => {
  const n = txVendorName(t)
  return n && !isChannelOnlyPayee(n) ? n : ''
}
