// A stubbed api for scripts/recoupqueue-dom-entry.jsx.
//
// Fixtured, not proxied, because the thing under test is a PARTITION: the index
// queue splits artists into "can upload now", "waiting on the bank" and
// "nothing to do" off `recoupState` + `ufr`, and ranks the first group by
// provable dollars. Live data cannot pin that — every one of the 152 live
// artists has something pending, and which band an artist lands in moves every
// time a statement is uploaded.
//
// So the fixture carries one artist per band, plus the two cases that decide
// whether the partition is written correctly:
//
//   Feel trip  provable only        → Ready, must rank FIRST ($276,200 > all)
//   Oxis       all four bands       → Ready, and the SUBPAGE nesting fixture
//   Jerri      provable + uploaded-with-no-bank-line → Ready AND flagged
//   Shonci     awaiting only        → "Nothing provable yet"
//   Zeke Bleu  unpaid only          → "Nothing to do" (cannot be uploaded)
//   Laszewo    all uploaded         → "Nothing to do"
//
// `recoupState` reads three fields and nothing else: bank_evidence (a statement
// shows it), payment_status, bank_expected (a statement COVERS the date). The
// rows below set them explicitly rather than leaning on defaults, because
// "awaiting" vs "unverified" is exactly the pair a default would blur.
export const calls = { get: [], post: [], put: [], del: [] }

// Explicit ids, not a counter: the write-path assertions name the exact rows
// that must reach POST /bk/entries/ufr-bulk, and a counter makes those numbers
// move every time a row is inserted above them.
const row = (o) => ({
  entry_source: null,
  recoupable: true,
  recoup_reviewed: true,
  deleted: false,
  status: 'approved',
  currency: 'USD',
  category: 'Marketing',
  song: 'Red Eye',
  recoupment_label: null,
  payee: 'Some Vendor',
  payment_status: 'Paid',
  bank_evidence: null,
  bank_expected: false,
  ufr: null,
  ufr_marked_at: null,
  cobrand: null,
  is_2025_expense: false,
  ...o,
})
// verified   — paid and a statement we hold shows it. Uploadable today.
const provable = (artist, amount, o = {}) => row({ ...o, artist, amount, payment_status: 'Paid', bank_evidence: { transaction_id: 9 }, ufr: null })
// awaiting   — paid, no statement covers the date yet. Not a problem, not actionable.
const awaiting = (artist, amount, o = {}) => row({ ...o, artist, amount, payment_status: 'Paid', bank_evidence: null, bank_expected: false, ufr: null })
// unpaid     — nothing has left the bank.
const unpaid   = (artist, amount, o = {}) => row({ ...o, artist, amount, payment_status: 'Unpaid', bank_evidence: null, ufr: null })
// paid, a statement COVERS the date, and nothing on it matches, and nobody has
// uploaded it — the discrepancy band, distinct from the overstatement below.
const unproven = (artist, amount, o = {}) => row({ ...o, artist, amount, payment_status: 'Paid', bank_evidence: null, bank_expected: true, ufr: null })
// uploaded, and a statement covering the date shows NOTHING. The overstatement.
const noLine   = (artist, amount, o = {}) => row({ ...o, artist, amount, payment_status: 'Paid', bank_evidence: null, bank_expected: true, ufr: 'Yes', ufr_marked_at: '2026-08-14T12:00:00Z' })
// uploaded and proven — the done state.
const claimed  = (artist, amount, o = {}) => row({ ...o, artist, amount, payment_status: 'Paid', bank_evidence: { transaction_id: 8 }, ufr: 'Yes', ufr_marked_at: '2026-08-14T12:00:00Z' })

const ENTRIES = [
  // READY — ranked by provable dollars, so this must come out on top.
  provable('Feel trip', 276200, { id: 1 }),
  awaiting('Feel trip', 1750, { id: 2 }),

  // ── OXIS: the artist the SUBPAGE assertions run against ──────────────────
  // Shaped for the nesting test, so it carries the two cases the deleted levels
  // existed for. Under the OLD four-level tree these six pending rows rendered
  // THIRTEEN headers:
  //
  //   unverified section + Red Eye + Video                        = 3
  //   verified   section + Red Eye + Marketing + "Q3 batch" label = 4
  //   awaiting   section + Grave Shift + Marketing + Video        = 4
  //   unpaid     section + Grave Shift + Marketing                = 3
  //
  // Two songs, one grouping level, so the new page must render TWO.
  //   Red Eye      two provable rows sharing a category AND a label — the
  //                exact shape where both inner levels said nothing
  //   Grave Shift  two rows with DIFFERENT categories — the one case the
  //                category bucket was for, now carried by the row's own chip
  //   Red Eye also holds an unverified row, so a song spans two bank states
  //   and the row rail + the unverified-first sort have something to prove.
  provable('Oxis', 20000, { id: 3, song: 'Red Eye', category: 'Marketing', recoupment_label: 'Q3 batch' }),
  provable('Oxis', 20949, { id: 4, song: 'Red Eye', category: 'Marketing', recoupment_label: 'Q3 batch' }),
  awaiting('Oxis', 30000, { id: 5, song: 'Grave Shift', category: 'Marketing' }),
  awaiting('Oxis', 18463, { id: 6, song: 'Grave Shift', category: 'Video' }),
  unproven('Oxis',  2500, { id: 7, song: 'Red Eye', category: 'Video' }),
  unpaid('Oxis',    5000, { id: 8, song: 'Grave Shift', category: 'Marketing' }),
  claimed('Oxis',  12000, { id: 9, song: 'Red Eye', category: 'Marketing' }),

  // READY *and* flagged — uploaded items with nothing on a statement behind them.
  provable('Jerri', 60976, { id: 10 }),
  noLine('Jerri', 3000, { id: 11 }),
  noLine('Jerri', 1500, { id: 12 }),
  claimed('Jerri', 90000, { id: 13 }),

  // NOTHING PROVABLE YET — paid, waiting on the statement that proves it.
  awaiting('Shonci', 29607, { id: 14 }),

  // NOTHING TO DO — unpaid only. Cannot be recouped, so it is not a to-do.
  unpaid('Zeke Bleu', 19380, { id: 15 }),

  // NOTHING TO DO — every provable cost already uploaded.
  claimed('Laszewo', 20114, { id: 16 }),

  // Excluded at the fetch boundary: an unreviewed bank-born row. `recoupable`
  // is BOOLEAN DEFAULT TRUE and the statement booker never sets it, so this
  // claims to be recoupable against nobody. If it reaches the page it invents
  // a 7th artist out of a schema default.
  row({ id: 17, artist: 'Ghost Bank Row', amount: 999999, entry_source: 'bank_statement', recoup_reviewed: false, bank_evidence: { transaction_id: 1 } }),
  // Not recoupable — somebody decided. Off the page while the filter says Yes.
  row({ id: 18, artist: 'Not Recoupable Co', amount: 88888, recoupable: false, bank_evidence: { transaction_id: 2 } }),
]

const AUDIT = {
  totals: {
    advances_items: 2, advances_usd: 15000,
    partial_families_count: 0, partial_families_usd: 0,
    double_claims_groups: 1, double_claims_usd: 2500,
    no_document_items: 0, no_document_usd: 0,
    pile_items: 1919, pile_usd: 3007397.33,
  },
}

const ok = (data, extra = {}) => Promise.resolve({ data: { success: true, data, ...extra } })

const api = {
  get: (url, cfg) => {
    calls.get.push(url + (cfg?.params ? '?' + JSON.stringify(cfg.params) : ''))
    if (url.startsWith('/bk/entries')) return ok(ENTRIES)
    if (url.startsWith('/bk/artist-meta')) return ok({})
    if (url.startsWith('/bk/song-status')) return ok([])
    if (url.startsWith('/bk/recoupment-audit')) return ok(AUDIT)
    if (url.startsWith('/bk/recoupments/notes')) return ok({ note: '', songs: [] })
    if (url.startsWith('/artists')) return ok([])
    return ok(null)
  },
  post: (url, body) => { calls.post.push({ url, body }); return ok({ changed: (body?.ids || []).length, skipped: 0 }) },
  put: (url, body) => { calls.put.push({ url, body }); return ok({}) },
  delete: (url) => { calls.del.push(url); return ok({}) },
}

export default api
export { ENTRIES, AUDIT }
