// Deal pipeline stub: nine deals across every stage, shaped like GET /deals
// (owner_name, days_in_stage, last_event_*, file_count), a team, a timeline
// per deal, and the funnel report. Scenarios: full · empty.
export const calls = { get: [], post: [], put: [], del: [] }
const ok = (data, extra = {}) => Promise.resolve({ data: { success: true, data, ...extra } })
const now = new Date()
const iso = (n) => { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString()
const scenario = () => globalThis.__DEALS_SCENARIO__ || 'full'
const deal = (o) => ({ genre: null, deal_type: null, priority: 'Medium', owner_id: 1, owner_name: 'John Skead', days_in_stage: 3, file_count: 0, advance: null, next_followup_date: null, last_event_kind: 'created', last_event_body: 'Added', last_event_at: ago(3), last_event_user: 'John Skead', source: null, passed_reason: null, revisit_date: null, added_date: iso(-30), ...o })
export let DEALS = [
  deal({ id: 1, artist_name: 'Rosa Vale', genre: 'Indie pop', stage: 'Scouting', days_in_stage: 2, source: 'Showcase' }),
  deal({ id: 2, artist_name: 'Night Drive Collective', genre: 'Electronic', stage: 'Meeting', days_in_stage: 16, next_followup_date: iso(-3), last_event_kind: 'note', last_event_body: 'Called the manager', last_event_at: ago(4), last_event_user: 'Sam Chen', owner_id: 2, owner_name: 'Sam Chen', file_count: 1 }),
  deal({ id: 3, artist_name: 'Kite & Ash', genre: 'Folk', stage: 'Offer', deal_type: '360 Deal', advance: 25000, days_in_stage: 25, next_followup_date: iso(2), priority: 'High', royalty_split: 50, term_months: 24, territory: 'World', artist_email: 'kite@example.test', file_count: 2 }),
  deal({ id: 4, artist_name: 'Juno Park', genre: 'R&B', stage: 'Offer', deal_type: 'Master License', advance: 8000, days_in_stage: 5, next_followup_date: iso(0), source: 'Referral' }),
  deal({ id: 5, artist_name: 'Lo Tide', genre: 'Ambient', stage: 'Negotiation', deal_type: 'Distribution', advance: 3000, days_in_stage: 9, next_followup_date: iso(12), source: 'Inbound' }),
  deal({ id: 6, artist_name: 'Mara Sol', genre: 'Latin pop', stage: 'Signed', deal_type: '360 Deal', advance: 40000, source: 'Referral', last_event_kind: 'stage', last_event_body: null, last_event_at: ago(20) }),
  deal({ id: 7, artist_name: 'The Quiet Hours', genre: 'Rock', stage: 'Passed', passed_reason: 'Budget', revisit_date: iso(-1), source: 'Showcase', last_event_kind: 'passed', last_event_body: 'Budget — wanted 60k', last_event_at: ago(40) }),
  deal({ id: 8, artist_name: 'Ivy Rune', genre: 'Pop', stage: 'Passed', passed_reason: 'Went elsewhere', source: 'Inbound' }),
  deal({ id: 9, artist_name: 'Dex Marlow', genre: 'Hip hop', stage: 'Scouting', days_in_stage: 1, owner_id: 2, owner_name: 'Sam Chen', priority: 'Low' }),
]
export const TEAM = [{ id: 1, name: 'John Skead', department: 'Operations' }, { id: 2, name: 'Sam Chen', department: 'A&R' }, { id: 3, name: 'Rosa Lind', department: 'Marketing' }]
const EVENTS = { 3: [
  { id: 31, kind: 'note', body: 'Sent the offer sheet — 25k, 50/50, 24 months', user_id: 1, user_name: 'John Skead', created_at: ago(2) },
  { id: 30, kind: 'stage', from_stage: 'Meeting', to_stage: 'Offer', user_id: 1, user_name: 'John Skead', created_at: ago(25) },
  { id: 29, kind: 'created', to_stage: 'Scouting', body: 'Added from Showcase', user_id: 1, user_name: 'John Skead', created_at: ago(40) },
] }
const FUNNEL = { range: { from: null, to: null }, deals: 9,
  totals: { live: 6, live_advance: 36000, signed: 1, signed_advance: 40000, passed: 2, win_rate: 33.3 },
  funnel: [{ stage: 'Scouting', reached: 9, conversion: null }, { stage: 'Meeting', reached: 7, conversion: 77.8 }, { stage: 'Offer', reached: 5, conversion: 71.4 }, { stage: 'Negotiation', reached: 2, conversion: 40 }, { stage: 'Signed', reached: 1, conversion: 50 }],
  stage_days: [{ stage: 'Scouting', avg_days: 6.5, completed: 7, sitting: 2 }, { stage: 'Meeting', avg_days: 12, completed: 5, sitting: 1 }, { stage: 'Offer', avg_days: 18.3, completed: 2, sitting: 2 }, { stage: 'Negotiation', avg_days: 30, completed: 1, sitting: 1 }, { stage: 'Signed', avg_days: null, completed: 0, sitting: 0 }],
  by_source: [{ key: 'Referral', signed: 1, passed: 0, open: 1, advance_signed: 40000, win_rate: 100 }, { key: 'Showcase', signed: 0, passed: 1, open: 1, advance_signed: 0, win_rate: 0 }, { key: 'Inbound', signed: 0, passed: 1, open: 1, advance_signed: 0, win_rate: 0 }, { key: '—', signed: 0, passed: 0, open: 3, advance_signed: 0, win_rate: null }],
  by_owner: [{ key: 'John Skead', signed: 1, passed: 2, open: 4, advance_signed: 40000, win_rate: 33.3 }, { key: 'Sam Chen', signed: 0, passed: 0, open: 2, advance_signed: 0, win_rate: null }],
  passed_reasons: [{ reason: 'Budget', n: 1 }, { reason: 'Went elsewhere', n: 1 }] }
const api = {
  get(url) {
    calls.get.push(url)
    if (url === '/deals') return ok(scenario() === 'empty' ? [] : DEALS)
    if (url === '/team') return ok(TEAM)
    if (url === '/deals/report/funnel') return ok(FUNNEL)
    const ev = url.match(/^\/deals\/(\d+)\/events$/); if (ev) return ok(EVENTS[ev[1]] || [])
    if (/^\/deals\/\d+\/files/.test(url)) return ok([])
    return ok([])
  },
  post(url, body) {
    calls.post.push({ url, body })
    const ev = url.match(/^\/deals\/(\d+)\/events$/)
    if (ev) { const d = DEALS.find((x) => x.id === Number(ev[1])); const e = { id: 900 + calls.post.length, kind: 'note', body: body.body, user_id: 1, user_name: 'John Skead', created_at: new Date().toISOString() }; return ok(e, { deal: { ...d, last_event_kind: 'note', last_event_body: body.body, last_event_at: e.created_at, last_event_user: 'John Skead' } }) }
    if (url === '/deals') { const d = deal({ id: 50, ...body, owner_name: TEAM.find((m) => m.id === Number(body.owner_id))?.name || null, days_in_stage: 0 }); DEALS = [d, ...DEALS]; return ok(d) }
    return ok({ id: 99, ...body })
  },
  put(url, body) {
    calls.put.push({ url, body })
    const m = url.match(/^\/deals\/(\d+)$/)
    if (m) { const d = DEALS.find((x) => x.id === Number(m[1])); const next = { ...d, ...body, owner_name: body.owner_id !== undefined ? (TEAM.find((t) => t.id === Number(body.owner_id))?.name || null) : d.owner_name }; if (body.stage && body.stage !== d.stage) { next.days_in_stage = 0; next.last_event_kind = body.stage === 'Passed' ? 'passed' : 'stage'; next.last_event_at = new Date().toISOString() } DEALS = DEALS.map((x) => (x.id === d.id ? next : x)); return ok(next, body.stage === 'Signed' ? { signing: { artist: { id: 7 }, created: { artist: true, advance: true } } } : {}) }
    return ok(body)
  },
  delete(url) { calls.del.push(url); const m = url.match(/^\/deals\/(\d+)$/); if (m) DEALS = DEALS.filter((x) => x.id !== Number(m[1])); return ok({}) },
}
export default api
