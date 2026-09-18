// A stubbed api for scripts/artistbudgets-dom-entry.jsx.
//
// Fixtured rather than proxied because the thing under test is the MERGE of two
// endpoints that overlap: `/spend-plans/by-artist` (artists that have a planned
// campaign) and `/artist-budgets` (artists that have ledger spend). An artist in
// BOTH must produce exactly one card, and an artist in EITHER must not vanish —
// neither of which you can assert against live data whose overlap you do not
// control.
//
// So the fixture is built to have all three cases at once:
//   Darci    in both      — plan and ledger spend
//   Pluko    plans only   — on the sheet, nothing in the ledger yet
//   Oxis     ledger only  — spend, never on the sheet
export const calls = { get: [], post: [], put: [], del: [] }

const CAMPAIGNS_DARCI = [
  { plan_id: 1, release_id: 11, title: 'Red Eye', planned: 26660, owed: 1000, sheet_paid: 25660, ledger_paid: 20000, ledger_open: 0, lines: 6, total_source: 'printed' },
  { plan_id: 2, release_id: 12, title: 'High Grade', planned: 13000, owed: 0, sheet_paid: 13000, ledger_paid: 9000, ledger_open: 500, lines: 4, total_source: 'printed' },
  { plan_id: 3, release_id: 13, title: 'Code Red', planned: 13000, owed: 7500, sheet_paid: 5500, ledger_paid: 4000, ledger_open: 0, lines: 5, total_source: 'printed' },
  { plan_id: 4, release_id: 14, title: 'Grave Shift', planned: 12500, owed: 5500, sheet_paid: 7000, ledger_paid: 3000, ledger_open: 0, lines: 3, total_source: 'printed' },
  // A fifth, so the "N more" expander has something to reveal — the card shows
  // four and the toggle is the only way to see this one.
  { plan_id: 5, release_id: 15, title: 'Let Em Watch', planned: 12228.12, owed: 0, sheet_paid: 12228.12, ledger_paid: 12228.12, ledger_open: 0, lines: 5, total_source: 'derived' },
]

const BY_ARTIST = {
  artists: [
    {
      artist_key: 'darci', artist: 'Darci', campaign_count: 5,
      planned: 77388.12, owed: 14000, sheet_paid: 63388.12,
      ledger_paid: 48228.12, ledger_open: 500, paid_pct: 62,
      campaigns: CAMPAIGNS_DARCI,
    },
    {
      artist_key: 'pluko', artist: 'Pluko', campaign_count: 1,
      planned: 5000, owed: 5000, sheet_paid: 0,
      ledger_paid: 0, ledger_open: 0, paid_pct: 0,
      campaigns: [{ plan_id: 9, release_id: 21, title: 'Nowhere', planned: 5000, owed: 5000, sheet_paid: 0, ledger_paid: 0, ledger_open: 0, lines: 2, total_source: 'printed' }],
    },
  ],
  totals: { artists: 2, campaigns: 6, planned: 82388.12, owed: 19000, ledger_paid: 48228.12, ledger_open: 500 },
  unlinked: { count: 359, total: 1588922.19 },
}

// `/artist-budgets` — Darci overlaps by key, Oxis is ledger-only.
const LEDGER = {
  artists: [
    { artist_key: 'darci', artist: 'Darci', budget: 0, spent: 48228.12, open: 500, committed: 48728.12, count: 9, open_count: 1, verified: 40000, awaiting: 8228.12, unverified: 0, unpaid: 500, variance: 0, has_budget: false, over_committed: false },
    { artist_key: 'oxis', artist: 'Oxis', budget: 0, spent: 204149.77, open: 34504.44, committed: 238654.21, count: 31, open_count: 4, verified: 200000, awaiting: 4149.77, unverified: 0, unpaid: 34504.44, variance: 0, has_budget: false, over_committed: false },
  ],
  totals: { artists: 2, with_budget: 0, budget: 0, spent: 252377.89, open: 35004.44, committed: 287382.33, open_count: 5 },
  sections: [],
}

const QUEUE = [
  {
    id: 701, release_id: null, source_header: 'Erin Kirby - Bad Luck', source_column: 'H',
    parsed_left: 'Erin Kirby', parsed_right: 'Bad Luck', match_status: 'unmatched',
    match_order: null, suggestions: [{ releaseId: 55, label: 'Erin Kirby — Bad Luck (2021)', score: 0.94 }],
    sheet_total: 550, total_source: 'printed', matched_at: null,
    release_artist: null, release_title: null,
    lines: [
      { plan_id: 701, source_row: 2, amount: 500, amount_raw: null, note: 'Lauren PR', status: 'paid', status_raw: 'Tyler ' },
      { plan_id: 701, source_row: 3, amount: 50, amount_raw: null, note: 'Video', status: 'not_yet', status_raw: 'Not Yet ' },
    ],
    money: { lines_total: 550, committed: 50, sheet_paid: 500, sheet_unknown: 0, prose_lines: 0 },
  },
]

const ok = (data, extra = {}) => Promise.resolve({ data: { success: true, data, ...extra } })

const api = {
  get: (url, cfg) => {
    calls.get.push(url + (cfg?.params ? '?' + JSON.stringify(cfg.params) : ''))
    if (url.startsWith('/spend-plans/by-artist')) {
      const key = cfg?.params?.artist_key
      if (key) return ok({ ...BY_ARTIST, artists: BY_ARTIST.artists.filter((a) => a.artist_key === key) })
      return ok(BY_ARTIST)
    }
    if (url.startsWith('/bk/artist-names')) return ok({ names: ['Darci', 'Oxis', 'Pluko', 'Rosa Vale'] })
    if (url.startsWith('/artist-budgets')) return ok(LEDGER)
    if (url.startsWith('/spend-plans/queue')) {
      return Promise.resolve({ data: { success: true, data: QUEUE, total: 359 } })
    }
    if (url.startsWith('/releases')) return ok([])
    return ok(null)
  },
  post: (url, body) => { calls.post.push({ url, body }); return ok({ id: 701, match_status: 'matched' }) },
  put: (url, body) => { calls.put.push({ url, body }); return ok({}) },
  delete: (url) => { calls.del.push(url); return ok({}) },
}

export default api
export { BY_ARTIST, LEDGER, QUEUE }
