// Client-side shaping of a P&L payload: quarter / year columns, the prior and
// year-earlier ranges for comparison, and the line-by-line variance list.
// Pure functions, tested by scripts/reports-dom and reusable by the exports if
// they ever grow columns.

export const periodOf = (ym, gran) => {
  if (gran === 'year') return ym.slice(0, 4)
  if (gran === 'quarter') return `${ym.slice(0, 4)}-Q${Math.floor((Number(ym.slice(5, 7)) - 1) / 3) + 1}`
  return ym
}
export const periodLabel = (p) => {
  if (/^\d{4}$/.test(p)) return p
  if (/^\d{4}-Q[1-4]$/.test(p)) return `Q${p.slice(6)} ${p.slice(0, 4)}`
  const [y, m] = p.split('-')
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1] || m} ${y}`
}

// Sum every month-keyed series in the payload into periods. `months` becomes
// the period list; `month_of_period` remembers which months make each one, so
// a drill on a quarter cell can ask for its from/to. Untouched at 'month'.
export function rollupPnl(pnl, gran) {
  if (!pnl || !Array.isArray(pnl.months) || gran === 'month') return pnl
  const monthSet = new Set(pnl.months)
  const periods = [...new Set(pnl.months.map((m) => periodOf(m, gran)))]
  const isSeries = (o) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length > 0 && Object.keys(o).every((k) => monthSet.has(k))
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      if (isSeries(v)) {
        const out = Object.fromEntries(periods.map((p) => [p, 0]))
        for (const [k, n] of Object.entries(v)) out[periodOf(k, gran)] += Number(n) || 0
        return out
      }
      const o = {}
      for (const [k, x] of Object.entries(v)) o[k] = k === 'months' ? periods : walk(x)
      return o
    }
    return v
  }
  return { ...walk(pnl), months: periods, granularity: gran, month_of_period: Object.fromEntries(periods.map((p) => [p, pnl.months.filter((m) => periodOf(m, gran) === p)])) }
}

const lastDay = (y, m) => new Date(y, m, 0).getDate()
// A period's own from/to, for a drill that the server only knows by month or range.
export const periodRange = (p, monthOfPeriod) => {
  const ms = monthOfPeriod?.[p] || [p]
  const a = ms[0], b = ms[ms.length - 1]
  const [by, bm] = b.split('-').map(Number)
  return { from: `${a}-01`, to: `${b}-${String(lastDay(by, bm)).padStart(2, '0')}` }
}

// The comparison range: the same number of months immediately before, or the
// same months a year earlier.
export function shiftRange(from, to, mode) {
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  const span = (ty - fy) * 12 + (tm - fm) + 1
  const back = mode === 'yoy' ? 12 : span
  const f = new Date(fy, fm - 1 - back, 1)
  const t = new Date(ty, tm - 1 - back, 1)
  const pad = (n) => String(n).padStart(2, '0')
  return {
    from: `${f.getFullYear()}-${pad(f.getMonth() + 1)}-01`,
    to: `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(lastDay(t.getFullYear(), t.getMonth() + 1))}`,
  }
}

const sumSeries = (s) => Object.values(s || {}).reduce((a, b) => a + (Number(b) || 0), 0)
const lineTotals = (map) => Object.fromEntries(Object.entries(map || {}).map(([k, s]) => [k, sumSeries(s)]))

// Line-by-line: current vs compared, delta and percent, biggest movers first.
export function compareLines(cur, prev) {
  if (!cur || !prev) return null
  const groups = [
    ['income', 'Income', cur.income, prev.income],
    ['expense', 'Expenses', cur.expenses, prev.expenses],
  ]
  const lines = []
  for (const [kind, label, a, b] of groups) {
    const ta = lineTotals(a), tb = lineTotals(b)
    for (const key of new Set([...Object.keys(ta), ...Object.keys(tb)])) {
      const c = ta[key] || 0, p = tb[key] || 0
      lines.push({ kind, group: label, key, cur: c, prev: p, delta: c - p, pct: p ? ((c - p) / Math.abs(p)) * 100 : null })
    }
  }
  lines.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
  const tot = (k) => ({ cur: Number(cur[k]?.total || 0), prev: Number(prev[k]?.total || 0) })
  const totals = {
    income: tot('income_totals'), expenses: tot('expense_totals'), net: tot('net'),
  }
  for (const t of Object.values(totals)) { t.delta = t.cur - t.prev; t.pct = t.prev ? (t.delta / Math.abs(t.prev)) * 100 : null }
  return { lines, totals }
}
