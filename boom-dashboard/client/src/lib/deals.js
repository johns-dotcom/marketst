// The deal pipeline's vocabulary and its pure rules — shared by the board, the
// list, the drawer, the report and the harness, so a card and a table row can
// never disagree about what "stale" or "ready to sign" means.
export const STAGES = ['Scouting', 'Meeting', 'Offer', 'Negotiation', 'Signed', 'Passed']
export const LIVE_STAGES = ['Scouting', 'Meeting', 'Offer', 'Negotiation']
export const CLOSED_STAGES = ['Signed', 'Passed']
export const PRIORITIES = ['High', 'Medium', 'Low']
export const DEAL_TYPES = ['360 Deal', 'Master License', 'Single License', 'Distribution', 'Publishing', 'Other']
export const PASSED_REASONS = ['Budget', 'Went elsewhere', 'Not ready', 'No fit', 'Unresponsive', 'Other']

// Days in a stage before a card reads amber, then red. Mirrors DAYS.deal_stale
// (21) on the server's Flags detector for the red line.
export const STALE_AMBER = 14
export const STALE_RED = 21

export const STAGE_DOT = { Scouting: 'bg-gray-400', Meeting: 'bg-blue-500', Offer: 'bg-amber-500', Negotiation: 'bg-violet-500', Signed: 'bg-emerald-500', Passed: 'bg-gray-300' }
export const STAGE_HEADER = { Scouting: 'text-gray-600', Meeting: 'text-blue-600', Offer: 'text-amber-600', Negotiation: 'text-violet-600', Signed: 'text-emerald-600', Passed: 'text-gray-400' }
export const PRIORITY_PILL_TONE = { High: 'bg-red-100 text-red-700', Medium: 'bg-amber-100 text-amber-700', Low: 'bg-gray-100 text-gray-600' }

export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const dayOf = (v) => (v ? String(v).slice(0, 10) : '')
export const daysFromToday = (v) => {
  const t = dayOf(v); if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null
  const [y, m, d] = t.split('-').map(Number); const [Y, M, D] = localDay().split('-').map(Number)
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(Y, M - 1, D)) / 86400000)
}
export const isOverdue = (v) => { const n = daysFromToday(v); return n !== null && n < 0 }

export const fmtMoney = (n) => {
  const v = Number(n) || 0
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(v % 1_000_000 ? 1 : 0)}m`
  if (v >= 10_000) return `$${Math.round(v / 1000)}k`
  if (v >= 1000) return `$${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}
export const fmtMoneyFull = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
export const sumAdvance = (deals) => deals.reduce((a, d) => a + (Number(d.advance) || 0), 0)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const shortDate = (v) => { const m = dayOf(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : '' }
export const relTime = (iso) => {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime(); const d = Math.floor(ms / 86400000)
  if (d <= 0) { const h = Math.floor(ms / 3600000); return h <= 0 ? 'just now' : `${h}h ago` }
  if (d === 1) return 'yesterday'
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30); return mo < 12 ? `${mo}mo ago` : `${Math.floor(mo / 12)}y ago`
}
export const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?'

// Follow-up state for a card: overdue · today · soon · later · none.
export const followupState = (deal) => {
  if (!LIVE_STAGES.includes(deal.stage) || !deal.next_followup_date) return { kind: 'none', label: '' }
  const n = daysFromToday(deal.next_followup_date)
  if (n < 0) return { kind: 'overdue', label: `Overdue ${-n}d` }
  if (n === 0) return { kind: 'today', label: 'Follow up today' }
  if (n <= 7) return { kind: 'soon', label: `Follow up ${shortDate(deal.next_followup_date)}` }
  return { kind: 'later', label: `Follow up ${shortDate(deal.next_followup_date)}` }
}
export const staleTone = (deal) => {
  if (!LIVE_STAGES.includes(deal.stage)) return 'none'
  const d = Number(deal.days_in_stage) || 0
  return d >= STALE_RED ? 'red' : d >= STALE_AMBER ? 'amber' : 'none'
}
// "Needs attention" is one predicate: overdue follow-up, or stuck past the red line.
export const needsAttention = (deal) => followupState(deal).kind === 'overdue' || staleTone(deal) === 'red'

// What Signed will need. Not a gate — missing items are shown, never blocking.
export const preSignChecklist = (deal) => [
  { key: 'deal_type', label: 'Deal type', ok: !!deal.deal_type },
  { key: 'advance', label: 'Advance (0 is an answer)', ok: deal.advance !== null && deal.advance !== undefined && deal.advance !== '' },
  { key: 'royalty_split', label: 'Artist royalty %', ok: Number(deal.royalty_split) > 0 },
  { key: 'term_months', label: 'Term in months', ok: Number(deal.term_months) > 0 },
  { key: 'territory', label: 'Territory', ok: !!String(deal.territory || '').trim() },
  { key: 'artist_email', label: 'Artist email (keys the roster row and the advance payment)', ok: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(deal.artist_email || '')) },
  { key: 'owner', label: 'Owner', ok: !!deal.owner_id },
  { key: 'file', label: 'A document on the deal (offer or term sheet)', ok: Number(deal.file_count) > 0 },
]

// Filters live in the URL: q owner type priority stage attn view sort deal
export const FILTER_KEYS = ['q', 'owner', 'type', 'stage', 'attn', 'view', 'sort', 'deal']
export const filterDeals = (deals, f, userId) => deals.filter((d) => {
  if (f.q) { const q = f.q.toLowerCase(); if (![d.artist_name, d.genre, d.source, d.owner_name, d.deal_type, d.last_event_body].some((v) => String(v || '').toLowerCase().includes(q))) return false }
  if (f.owner) { const want = f.owner === 'me' ? Number(userId) : Number(f.owner); if (Number(d.owner_id) !== want) return false }
  if (f.type && d.deal_type !== f.type) return false
  if (f.stage && d.stage !== f.stage) return false
  if (f.attn === '1' && !needsAttention(d)) return false
  return true
})
export const SORTS = {
  stage: (a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || a.artist_name.localeCompare(b.artist_name),
  artist: (a, b) => a.artist_name.localeCompare(b.artist_name),
  advance: (a, b) => (Number(b.advance) || 0) - (Number(a.advance) || 0),
  days: (a, b) => (Number(b.days_in_stage) || 0) - (Number(a.days_in_stage) || 0),
  followup: (a, b) => (dayOf(a.next_followup_date) || '9999') .localeCompare(dayOf(b.next_followup_date) || '9999'),
  touched: (a, b) => String(b.last_event_at || '').localeCompare(String(a.last_event_at || '')),
  owner: (a, b) => String(a.owner_name || 'zz').localeCompare(String(b.owner_name || 'zz')),
}
export const sortDeals = (deals, sort) => { const [key, dir] = String(sort || 'stage').split(':'); const fn = SORTS[key] || SORTS.stage; const out = [...deals].sort(fn); return dir === 'desc' ? out.reverse() : out }

// The timeline line for an event
export const eventLine = (e) => {
  if (!e) return ''
  if (e.kind === 'note') return e.body || ''
  if (e.kind === 'created') return e.body || `Added in ${e.to_stage || 'Scouting'}`
  if (e.kind === 'passed') return `Passed${e.body ? ` — ${e.body}` : ''}`
  if (e.kind === 'stage' || e.kind === 'signed') return e.to_stage === 'Signed' ? 'Signed' : `Moved ${e.from_stage ? `${e.from_stage} → ` : ''}${e.to_stage}`
  return e.body || e.kind
}
