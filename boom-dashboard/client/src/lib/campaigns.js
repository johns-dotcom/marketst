// Song campaigns: the vocabulary and pure rules shared by the board, the
// drawer, the Recoupments "Ready" queue and the harness.
export const STATUSES = ['planning', 'live', 'finished', 'ready', 'uploaded']
export const STATUS_LABEL = { planning: 'Planning', live: 'Live', finished: 'Spending finished', ready: 'Ready for recoupment', uploaded: 'Uploaded' }
export const STATUS_SHORT = { planning: 'Planning', live: 'Live', finished: 'Finished', ready: 'Ready', uploaded: 'Uploaded' }
export const STATUS_DOT = { planning: 'bg-gray-400', live: 'bg-blue-500', finished: 'bg-amber-500', ready: 'bg-emerald-500', uploaded: 'bg-gray-300' }
export const STATUS_HEADER = { planning: 'text-gray-600', live: 'text-blue-600', finished: 'text-amber-600', ready: 'text-emerald-600', uploaded: 'text-gray-400' }
// What the next button on a card says, per status.
export const NEXT_ACTION = { planning: ['live', 'Go live'], live: ['finished', 'Spending finished'], finished: ['ready', 'Confirm ready'] }

export const fmtMoney = (n) => {
  const v = Number(n) || 0
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(v % 1_000_000 ? 1 : 0)}m`
  if (v >= 10_000) return `$${Math.round(v / 1000)}k`
  if (v >= 1000) return `$${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}
export const fmtMoneyFull = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

// The budget bar: spent · committed · expected as shares of the larger of budget and total.
export const barShares = (c) => {
  const denom = Math.max(Number(c.budget_usd) || 0, Number(c.total) || 0) || 1
  const pct = (v) => Math.max(0, Math.min(100, ((Number(v) || 0) / denom) * 100))
  return { spent: pct(c.spent), committed: pct(c.committed), expected: pct(c.expected_open), budgetAt: c.budget_usd ? pct(c.budget_usd) : null }
}

export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const daysFromToday = (v) => {
  const t = String(v || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null
  const [y, m, d] = t.split('-').map(Number); const [Y, M, D] = localDay().split('-').map(Number)
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(Y, M - 1, D)) / 86400000)
}
export const relTime = (iso) => {
  if (!iso) return ''
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (d <= 0) return 'today'; if (d === 1) return 'yesterday'; if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30); return mo < 12 ? `${mo}mo ago` : `${Math.floor(mo / 12)}y ago`
}
export const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?'

// Needs attention: over budget, reopened by a late invoice, finished but unconfirmed, or past its end date and still open.
export const needsAttention = (c) => (c.over_budget && c.status !== 'uploaded') || (c.status === 'live' && !!c.reopened_at) || c.status === 'finished'
  || (['planning', 'live'].includes(c.status) && c.end_date && daysFromToday(c.end_date) < 0)
export const attentionLine = (c) => {
  if (c.status === 'live' && c.reopened_at) return 'Reopened — an invoice arrived after confirmation'
  if (c.over_budget && c.status !== 'uploaded') return `Over budget by ${fmtMoney(c.total - c.budget_usd)}`
  if (c.status === 'finished') return 'Spending finished — confirm it ready'
  if (['planning', 'live'].includes(c.status) && c.end_date && daysFromToday(c.end_date) < 0) return `Ended ${-daysFromToday(c.end_date)}d ago, still ${STATUS_SHORT[c.status].toLowerCase()}`
  return ''
}

export const FILTER_KEYS = ['q', 'owner', 'status', 'artist', 'attn', 'view', 'campaign']
export const filterCampaigns = (list, f, userId) => list.filter((c) => {
  if (f.q) { const q = f.q.toLowerCase(); if (![c.artist, c.song, c.owner_name, c.release_name, c.notes].some((v) => String(v || '').toLowerCase().includes(q))) return false }
  if (f.owner) { const want = f.owner === 'me' ? Number(userId) : Number(f.owner); if (Number(c.owner_id) !== want) return false }
  if (f.status && c.status !== f.status) return false
  if (f.artist && c.artist_key !== f.artist) return false
  if (f.attn === '1' && !needsAttention(c)) return false
  return true
})
export const sumBy = (list, k) => list.reduce((a, c) => a + (Number(c[k]) || 0), 0)

export const eventLine = (e) => {
  if (!e) return ''
  if (e.kind === 'note') return e.body || ''
  if (e.kind === 'created') return e.body || 'Created'
  if (e.kind === 'finished') return `Spending marked finished${e.body ? ` — ${e.body}` : ''}`
  if (e.kind === 'confirmed') return `Confirmed ready for recoupment${e.body ? ` — ${e.body}` : ''}`
  if (e.kind === 'reopened') return `Reopened${e.body ? ` — ${e.body}` : ''}`
  if (e.kind === 'status') return e.body || `Moved to ${STATUS_LABEL[e.to_status] || e.to_status}`
  return e.body || e.kind
}
