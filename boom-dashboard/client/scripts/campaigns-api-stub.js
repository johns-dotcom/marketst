// Song campaigns stub: five campaigns, one per status, shaped like GET /campaigns
// (money, checklist, owner_name, expense_ids) and one detail with lines,
// ledger, channels and events. Scenarios: full · empty.
export const calls = { get: [], post: [], put: [], del: [] }
const ok = (data, extra = {}) => Promise.resolve({ data: { success: true, data, ...extra } })
const scenario = () => globalThis.__CAMP_SCENARIO__ || 'full'
const ago = (d) => new Date(Date.now() - d * 86400000).toISOString()
const iso = (n) => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const check = (lines_in, all_paid, docs, has_spend, budgetOk, over) => [
  { key: 'lines_in', label: lines_in ? 'Every expected line has its invoice' : '1 expected line still without an invoice', ok: lines_in },
  { key: 'all_paid', label: all_paid ? 'Every invoice is paid' : '1 invoice not paid yet', ok: all_paid },
  { key: 'docs', label: docs ? 'Every row has its document' : '1 row with no document', ok: docs },
  { key: 'has_spend', label: has_spend ? '3 ledger rows attributed to this song' : 'No spend attributed to this song yet', ok: has_spend },
  { key: 'budget', label: over ? 'Over budget by $500' : 'Within budget', ok: budgetOk },
]
const camp = (o) => ({ currency: 'USD', owner_id: 1, owner_name: 'John Skead', release_name: null, line_count: 0, lines_open: 0, rows: 0, unpaid: 0, no_doc: 0, linked: 0, spent: 0, committed: 0, expected_open: 0, expected_total: 0, budget_usd: null, total: 0, left: null, over_budget: false, by_channel: [], checklist: check(true, true, true, false, false, false), ready: false, expense_ids: [], ufr_done: false, start_date: null, end_date: null, finished_at: null, confirmed_at: null, confirm_note: null, uploaded_at: null, reopened_at: null, reopen_reason: null, notes: null, created_at: ago(20), updated_at: ago(1), ...o })
export let CAMPAIGNS = [
  camp({ id: 1, artist: 'Rosa Vale', artist_key: 'rosa vale', song: 'Night Drive', song_key: 'night drive', status: 'planning', budget: 5000, budget_usd: 5000, left: 3800, total: 1200, expected_open: 1200, expected_total: 1200, lines_open: 1, line_count: 1, end_date: iso(30) }),
  camp({ id: 2, artist: 'Kite & Ash', artist_key: 'kite & ash', song: 'Paper Moon', song_key: 'paper moon', status: 'live', owner_id: 2, owner_name: 'Sam Chen', budget: 3000, budget_usd: 3000, spent: 2000, committed: 500, expected_open: 1000, total: 3500, left: -500, over_budget: true, rows: 3, unpaid: 1, no_doc: 1, lines_open: 1, line_count: 3, checklist: check(false, false, false, true, false, true), expense_ids: [11, 12, 13], end_date: iso(-2) }),
  camp({ id: 3, artist: 'Juno Park', artist_key: 'juno park', song: 'Slow Light', song_key: 'slow light', status: 'finished', budget: 2000, budget_usd: 2000, spent: 1500, total: 1500, left: 500, rows: 2, finished_at: ago(9), checklist: check(true, true, true, true, true, false), ready: true, expense_ids: [21, 22] }),
  camp({ id: 4, artist: 'Lo Tide', artist_key: 'lo tide', song: 'Undertow', song_key: 'undertow', status: 'ready', budget: 1000, budget_usd: 1000, spent: 900, total: 900, left: 100, rows: 2, confirmed_at: ago(3), confirm_note: 'the boost is not worth chasing', checklist: check(true, true, true, true, true, false), ready: true, expense_ids: [31, 32] }),
  camp({ id: 5, artist: 'Mara Sol', artist_key: 'mara sol', song: 'Dusk', song_key: 'dusk', status: 'uploaded', budget: 4000, budget_usd: 4000, spent: 3900, total: 3900, left: 100, rows: 4, confirmed_at: ago(30), uploaded_at: ago(20), ufr_done: true, expense_ids: [41, 42, 43, 44] }),
]
export const TEAM = [{ id: 1, name: 'John Skead' }, { id: 2, name: 'Sam Chen' }, { id: 3, name: 'Rosa Lind' }]
const detail = (c) => ({ ...c,
  lines: c.id === 2 ? [{ id: 201, label: 'IG ads', expected_amount: 1200, vendor: 'Ads Co', category: 'Advertisements', expense_id: 11 }, { id: 202, label: 'PR month', expected_amount: 800, expense_id: 12 }, { id: 203, label: 'Creators', expected_amount: 1000, expense_id: null }] : [],
  ledger: c.id === 2 ? [{ id: 11, payee: 'Ads Co', category: 'Advertisements', amount: 1200, currency: 'USD', usd: 1200, paid: true, has_invoice: true, ufr: false, linked: true, invoice_date: '2026-09-01' }, { id: 12, payee: 'PR Co', category: 'Marketing', amount: 800, currency: 'USD', usd: 800, paid: true, has_invoice: true, ufr: false, linked: true, invoice_date: '2026-09-03' }, { id: 13, payee: 'Creator X', category: 'Marketing', amount: 500, currency: 'USD', usd: 500, paid: false, has_invoice: false, ufr: false, linked: false, invoice_date: '2026-09-10' }] : [],
  by_channel: c.id === 2 ? [{ category: 'Advertisements', spent: 1200, committed: 0, count: 1 }, { category: 'Marketing', spent: 800, committed: 500, count: 2 }] : [],
  events: [{ id: 901, kind: 'created', body: 'Created in planning', user_name: 'John Skead', created_at: ago(20) }, ...(c.status === 'live' ? [{ id: 902, kind: 'status', body: null, from_status: 'planning', to_status: 'live', user_name: 'Sam Chen', created_at: ago(15) }] : [])],
})
const api = {
  get(url, opts) {
    calls.get.push(url)
    if (url === '/campaigns') { const st = opts?.params?.status; const list = scenario() === 'empty' ? [] : CAMPAIGNS.filter((c) => !st || c.status === st); return ok(list) }
    if (url === '/campaigns/songs') return ok({ releases: [{ id: 9, project_name: 'Night Drive', release_date: '2026-10-01' }], ledger: ['Night Drive', 'B-side'], existing: [{ song: 'Night Drive', status: 'planning' }] })
    const m = url.match(/^\/campaigns\/(\d+)$/); if (m) { const c = CAMPAIGNS.find((x) => x.id === Number(m[1])); return c ? ok(detail(c)) : Promise.reject({ response: { status: 404, data: { error: 'Campaign not found' } } }) }
    if (url === '/team') return ok(TEAM)
    if (url === '/bk/artist-names') return ok({ names: ['Rosa Vale', 'Kite & Ash', 'Juno Park', 'New Prospect'] })
    return ok([])
  },
  post(url, body) {
    calls.post.push({ url, body })
    const st = url.match(/^\/campaigns\/(\d+)\/status$/)
    if (st) {
      const c = CAMPAIGNS.find((x) => x.id === Number(st[1]))
      if (body.status === 'ready' && !c.ready && !body.note) return Promise.reject({ response: { status: 400, data: { error: 'The checklist is not clear. Confirm anyway with a note saying why.', needs_note: true, checklist: c.checklist } } })
      const next = { ...c, status: body.status, ...(body.status === 'finished' ? { finished_at: new Date().toISOString() } : {}), ...(body.status === 'ready' ? { confirmed_at: new Date().toISOString(), confirm_note: body.note || null } : {}), ...(body.status === 'live' ? { finished_at: null, confirmed_at: null, confirm_note: null } : {}) }
      CAMPAIGNS = CAMPAIGNS.map((x) => (x.id === c.id ? next : x)); return ok(detail(next))
    }
    if (url === '/campaigns') { const c = camp({ id: 50, ...body, artist_key: body.artist.toLowerCase(), song_key: body.song.toLowerCase(), budget_usd: body.budget, left: body.budget, owner_name: TEAM.find((t) => t.id === Number(body.owner_id))?.name || null, line_count: (body.lines || []).length, lines_open: (body.lines || []).length, expected_open: (body.lines || []).reduce((a, l) => a + (Number(l.expected_amount) || 0), 0) }); CAMPAIGNS = [c, ...CAMPAIGNS]; return ok(detail(c)) }
    if (/\/events$/.test(url)) return ok({ id: 999, kind: 'note', body: body.body, user_name: 'John Skead', created_at: new Date().toISOString() })
    if (/\/lines$/.test(url)) { const id = Number(url.split('/')[2]); const c = CAMPAIGNS.find((x) => x.id === id); return ok({ ...detail(c), lines: [...detail(c).lines, { id: 777, ...body, expense_id: null }], lines_open: c.lines_open + 1 }) }
    return ok({})
  },
  put(url, body) {
    calls.put.push({ url, body })
    const ln = url.match(/^\/campaigns\/(\d+)\/lines\/(\d+)$/)
    if (ln) { const c = CAMPAIGNS.find((x) => x.id === Number(ln[1])); const d = detail(c); return ok({ ...d, lines: d.lines.map((l) => (l.id === Number(ln[2]) ? { ...l, ...body } : l)), expected_open: body.expense_id ? 0 : d.expected_open, lines_open: body.expense_id ? 0 : d.lines_open }) }
    const m = url.match(/^\/campaigns\/(\d+)$/); if (m) { const c = CAMPAIGNS.find((x) => x.id === Number(m[1])); const next = { ...c, ...body, budget_usd: body.budget ?? c.budget_usd }; CAMPAIGNS = CAMPAIGNS.map((x) => (x.id === c.id ? next : x)); return ok(detail(next)) }
    return ok(body)
  },
  delete(url) { calls.del.push(url); const m = url.match(/^\/campaigns\/(\d+)$/); if (m) CAMPAIGNS = CAMPAIGNS.filter((x) => x.id !== Number(m[1])); return ok({}) },
}
export default api
