import { useState, useEffect, useMemo, Fragment } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import {
  ChevronRight, ChevronDown, ChevronLeft, Loader, Download, Calendar, ArrowLeft, Search, ArrowUpDown,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ComposedChart, Line, CartesianGrid, ReferenceLine, Area, AreaChart,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import api from '../api'
import PageHeader from '../components/PageHeader'
import ReconciledBadge from '../components/ReconciledBadge'

// ── Formatters ─────────────────────────────────────────────────────────────
const fmtUsd = (n) => `$${(Number(n) || 0).toLocaleString('en-US', {
  minimumFractionDigits: 0, maximumFractionDigits: 0,
})}`
const fmtCompact = (n) => {
  const v = Number(n) || 0
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 10_000)    return `${sign}$${(abs / 1_000).toFixed(0)}K`
  if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${abs.toFixed(0)}`
}
const fmtWeek = (iso) => {
  const s = String(iso || '').slice(0, 10)
  const parts = s.split('-').map(n => parseInt(n, 10))
  if (parts.length !== 3 || parts.some(x => Number.isNaN(x))) return s
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[parts[1] - 1]} ${parts[2]}`
}
const monthLabel = (ym) => {
  const [y, m] = (ym || '').split('-').map(Number)
  if (!y || !m) return ym
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

// ── Range picker ───────────────────────────────────────────────────────────
// Presets convert to a { from, to } window anchored to today. Custom lets
// the user pick arbitrary from/to dates. Persisted to localStorage so
// muscle memory sticks across visits.
const RANGE_KEY = 'financials_range_v2'
const PRESETS = [
  { key: '3m',  label: '3m',  months: 3 },
  { key: '6m',  label: '6m',  months: 6 },
  { key: '12m', label: '12m', months: 12 },
]
function loadRange() {
  try {
    const v = JSON.parse(localStorage.getItem(RANGE_KEY) || 'null')
    if (v && typeof v === 'object') return v
  } catch {}
  return { preset: '6m', customFrom: '', customTo: '' }
}
function useRange() {
  const [range, setRangeRaw] = useState(loadRange)
  const setRange = (next) => {
    setRangeRaw(next)
    try { localStorage.setItem(RANGE_KEY, JSON.stringify(next)) } catch {}
  }
  const derived = useMemo(() => {
    const today = new Date()
    const iso = (d) => d.toISOString().slice(0, 10)
    if (range.preset === 'custom') {
      return { from: range.customFrom || null, to: range.customTo || null, months: 6 }
    }
    const preset = PRESETS.find(p => p.key === range.preset) || PRESETS[1]
    const from = new Date(today); from.setMonth(from.getMonth() - preset.months)
    return { from: iso(from), to: iso(today), months: preset.months }
  }, [range])
  return { range, setRange, derived }
}

function RangePicker({ range, setRange, derived }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex items-center bg-gray-100 rounded-xl p-1">
        {PRESETS.map(p => (
          <button
            key={p.key}
            onClick={() => setRange({ ...range, preset: p.key })}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              range.preset === p.key ? 'bg-card text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => setRange({
            ...range,
            preset: 'custom',
            customFrom: range.customFrom || derived.from || '',
            customTo:   range.customTo   || derived.to   || '',
          })}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1 ${
            range.preset === 'custom' ? 'bg-card text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <Calendar size={12} /> Custom
        </button>
      </div>
      {range.preset === 'custom' && (
        <div className="flex items-center gap-2 text-xs">
          <input
            type="date"
            value={range.customFrom}
            onChange={e => setRange({ ...range, preset: 'custom', customFrom: e.target.value })}
            className="px-2 py-1 border border-rule rounded-lg bg-card focus:outline-none focus:border-boom-400"
          />
          <span className="text-gray-400">→</span>
          <input
            type="date"
            value={range.customTo}
            onChange={e => setRange({ ...range, preset: 'custom', customTo: e.target.value })}
            className="px-2 py-1 border border-rule rounded-lg bg-card focus:outline-none focus:border-boom-400"
          />
        </div>
      )}
    </div>
  )
}

// ── KPI cards ──────────────────────────────────────────────────────────────
function DeltaChip({ current, prior }) {
  if (!prior) return null
  const pct = ((current - prior) / prior) * 100
  if (!Number.isFinite(pct)) return null
  const up = pct >= 0
  return (
    <span className={`text-[11px] font-bold ${up ? 'text-emerald-600' : 'text-rose-600'}`}>
      {up ? '↑' : '↓'} {Math.abs(pct).toFixed(0)}%
    </span>
  )
}
function KpiCard({ label, value, delta, sub, sparkline, sparkColor = '#10b981', onClick }) {
  const Wrap = onClick ? 'button' : 'div'
  return (
    <Wrap
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`card p-5 relative overflow-hidden text-left w-full ${onClick ? 'hover:border-boom-200 hover:shadow-sm cursor-pointer transition-all' : ''}`}
    >
      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">{label}</p>
      <div className="flex items-baseline gap-2 mt-1.5">
        <p className="text-2xl font-bold text-gray-900 tabular-nums">{value}</p>
        {delta}
      </div>
      {sub && <p className="text-[11px] text-gray-400 mt-1.5">{sub}</p>}
      {sparkline && sparkline.length > 1 && (
        <div className="mt-3 -mx-1 -mb-1" style={{ height: 34 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparkline.map((v, i) => ({ i, v }))}>
              <defs>
                <linearGradient id={`spark-${label.replace(/\s+/g, '')}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={sparkColor} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={sparkColor} stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="v"
                stroke={sparkColor}
                strokeWidth={1.5}
                fill={`url(#spark-${label.replace(/\s+/g, '')})`}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Wrap>
  )
}

// ── Weekly chart ───────────────────────────────────────────────────────────
// Composed chart: paid + unpaid stacked bars on the left Y axis, received-
// invoice count as a line on the right Y axis, plus an average-per-week
// reference line so operators can see spikes at a glance. Summary strip
// above the chart totals paid / unpaid / received across the range and
// callouts the biggest single week.
function WeeklyChart({ weeks }) {
  const raw = (weeks || []).map(w => ({
    week_label: fmtWeek(w.week_start),
    week_start: String(w.week_start || '').slice(0, 10),
    paid: Number(w.paid_usd) || 0,
    unpaid: Number(w.unpaid_usd) || 0,
    received_usd: Number(w.received_usd) || 0,
    received_count: Number(w.received_count) || 0,
  }))
  // Trailing-4-week moving average of CASH OUT (paid_usd) — the moving
  // avg used to average paid+unpaid, but that summed two different
  // date bases and produced a meaningless number. Cash out is the
  // one clean signal a trend line can smooth over. Null for the first
  // 3 weeks — Recharts skips nulls, leaving a clean line that starts
  // once the window has enough data.
  const data = raw.map((w, i) => {
    if (i < 3) return { ...w, ma4: null }
    let sum = 0
    for (let k = i - 3; k <= i; k++) sum += raw[k].paid
    return { ...w, ma4: sum / 4 }
  })

  const totals = data.reduce((acc, w) => ({
    paid: acc.paid + w.paid,
    unpaid: acc.unpaid + w.unpaid,
    received_usd: acc.received_usd + w.received_usd,
    received_count: acc.received_count + w.received_count,
  }), { paid: 0, unpaid: 0, received_usd: 0, received_count: 0 })
  // Weekly avg / biggest-week now use CASH OUT only. Previously they
  // summed paid + unpaid, which was a mixed-basis number (payment_date
  // + invoice_date) that didn't correspond to any real thing.
  const avgPerWeek = data.length ? totals.paid / data.length : 0
  const biggestWeek = data.reduce((best, w) => (w.paid > (best?.paid || 0) ? w : best), null)

  // Nicely-formatted tooltip payload. Recharts drives the layout; we
  // just render the values.
  // Nicely-formatted tooltip payload. Each row of the chart mixes
  // three different date bases (paid by payment_date, unpaid by
  // invoice_date, received by created_at) — the tooltip labels those
  // explicitly and does NOT show a cross-basis "Total" that summed
  // apples to oranges in the previous version.
  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null
    const row = payload[0].payload
    return (
      <div className="bg-white border border-rule rounded-lg shadow-md px-3 py-2 text-xs" style={{ minWidth: 260 }}>
        <p className="font-semibold text-gray-900 mb-1.5">Week of {row.week_start}</p>
        {/* Grid layout with a single right-aligned "amount" column so
            every row's $ starts at the same X coordinate. Previously
            the Received row appended "count · $USD" into the amount
            span, which shifted its $ left of the other two — visually
            broke the vertical alignment. The received count now lives
            in the label column as a small chip so the amount column
            stays clean. */}
        <div className="grid gap-y-1" style={{ gridTemplateColumns: '1fr auto' }}>
          <div className="inline-flex items-center gap-1.5 text-gray-500">
            <span className="inline-block w-2 h-2 rounded-sm bg-emerald-500" /> Cash out
            <span className="text-[9px] text-gray-400">(paid this week)</span>
          </div>
          <div className="font-semibold text-gray-900 tabular-nums text-right">{fmtUsd(row.paid)}</div>

          <div className="inline-flex items-center gap-1.5 text-gray-500">
            <span className="inline-block w-2 h-2 rounded-sm bg-rose-500" /> Open billing
            <span className="text-[9px] text-gray-400">(invoiced this week, still open)</span>
          </div>
          <div className="font-semibold text-gray-900 tabular-nums text-right">{fmtUsd(row.unpaid)}</div>

          <div className="inline-flex items-center gap-1.5 text-gray-500 pt-1 border-t border-rule">
            <span className="inline-block w-3 h-0.5 bg-sky-500" /> Received
            <span className="text-[9px] text-gray-400">({row.received_count} submitted)</span>
          </div>
          <div className="font-semibold text-gray-900 tabular-nums text-right pt-1 border-t border-rule">{fmtUsd(row.received_usd)}</div>
        </div>
        <p className="text-[10px] text-gray-400 pt-1 leading-tight mt-1">
          Three different date bases — don't sum the bars. Cash out is by payment_date; open billing is by invoice_date; received is by submission date.
        </p>
      </div>
    )
  }

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Weekly spend &amp; intake</h2>
          {/* Explicit basis line — the two bars are grouped side-by-side
              rather than stacked because they measure different things:
              green is cash out (payment_date), rose is new billing
              (invoice_date). Stacking implied they summed to a real
              weekly total; they don't. */}
          <p className="text-[11px] text-gray-400 mt-0.5">
            {data.length} weeks · USD-equivalent · <span className="text-gray-500">Cash out (paid) and new billing (invoiced) shown side-by-side per week — different date bases, don't sum them.</span>
          </p>
        </div>
        <div className="flex items-center gap-5 text-[11px]">
          <span className="text-gray-400">
            <span className="text-gray-500 font-semibold">Cash out: </span>
            <span className="text-emerald-700 font-bold tabular-nums">{fmtCompact(totals.paid)}</span>
          </span>
          <span className="text-gray-400">
            <span className="text-gray-500 font-semibold">Open billing: </span>
            <span className="text-rose-700 font-bold tabular-nums">{fmtCompact(totals.unpaid)}</span>
          </span>
          <span className="text-gray-400">
            <span className="text-gray-500 font-semibold">Received: </span>
            <span className="text-sky-700 font-bold tabular-nums">{totals.received_count} · {fmtCompact(totals.received_usd)}</span>
          </span>
          <span className="text-gray-400">
            <span className="text-gray-500 font-semibold">Avg / wk cash out: </span>
            <span className="text-gray-700 font-bold tabular-nums">{fmtCompact(avgPerWeek)}</span>
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={data} margin={{ top: 8, right: 24, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
          <XAxis dataKey="week_label" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
          {/* Single Y-axis in USD — the received line now plots
              received_usd on the same scale as the bars, so a right-
              side count axis is no longer needed. Count is still
              surfaced in the tooltip. */}
          <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickFormatter={fmtCompact} axisLine={false} tickLine={false} width={56} />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(15, 23, 42, 0.04)' }} />
          {avgPerWeek > 0 && (
            <ReferenceLine
              yAxisId="left"
              y={avgPerWeek}
              stroke="#94a3b8"
              strokeDasharray="4 4"
              label={{
                // insideTopLeft sits over the plot area (not on the
                // right-hand y-axis where the received-count ticks
                // live) so the "avg" callout no longer runs into
                // the axis numbers.
                value: `avg ${fmtCompact(avgPerWeek)}`,
                position: 'insideTopLeft',
                offset: 8,
                fontSize: 10,
                fill: '#64748b',
              }}
            />
          )}
          {/* Two SEPARATE grouped bars per week (not stacked): green
              measures cash out (payment_date), rose measures new
              billing that's still open (invoice_date). Keeping them
              side-by-side prevents the "these sum to a weekly total"
              misread the old stacked layout invited. */}
          <Bar yAxisId="left" dataKey="paid"   fill="#10b981" radius={[3, 3, 0, 0]} />
          <Bar yAxisId="left" dataKey="unpaid" fill="#f43f5e" radius={[3, 3, 0, 0]} />
          {/* Trailing-4-week moving average — cuts through spiky weeks
              so the exec can see the smoothed spending trajectory. */}
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="ma4"
            stroke="#f59e0b"
            strokeWidth={2}
            strokeDasharray="0"
            dot={false}
            activeDot={false}
            connectNulls={false}
          />
          {/* Received line — plots received_usd (dollar amount) on
              the left USD axis so it visually tracks the bar heights.
              Previously plotted received_count against a right-side
              count axis, which meant a spike could look like $260K
              when the actual dollar value was $161K. Count moves
              into the tooltip for context. */}
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="received_usd"
            stroke="#0ea5e9"
            strokeWidth={2}
            dot={{ r: 3, fill: '#0ea5e9', strokeWidth: 0 }}
            activeDot={{ r: 5 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="flex items-center gap-5 mt-2 text-[11px] text-gray-500 flex-wrap">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-500" /> Cash out
          <span className="text-gray-400">(by payment_date)</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-rose-500" /> Open billing
          <span className="text-gray-400">(by invoice_date, still open)</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5 bg-sky-500" /> Received $
          <span className="text-gray-400">(new invoicing per week)</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5 bg-amber-500" /> 4-week MA of cash out
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 border-t border-dashed border-slate-400" /> Avg cash out / wk
        </span>
      </div>
      {biggestWeek && biggestWeek.paid > 0 && (
        <p className="text-[11px] text-gray-500 mt-3 pt-3 border-t border-rule">
          Biggest cash-out week: <span className="font-semibold text-gray-900">{biggestWeek.week_start}</span> at
          <span className="font-bold text-gray-900 tabular-nums"> {fmtUsd(biggestWeek.paid)}</span>
          <span className="text-gray-400"> paid</span>.
        </p>
      )}
    </div>
  )
}

// ── Breakdown ──────────────────────────────────────────────────────────────
function BreakdownSection({ breakdowns, dimension, onDimensionChange, scopeFilters, range }) {
  const rows = breakdowns?.[dimension] || []
  // Two totals: sum of paid across ALL top-N rows (used for the share
  // bar's width so each row visually represents its slice of the pie),
  // and sum of unpaid (used for the range subtitle).
  const totalPaid = rows.reduce((s, r) => s + (Number(r.paid_usd) || 0), 0)
  const totalUnpaid = rows.reduce((s, r) => s + (Number(r.unpaid_usd) || 0), 0)
  const dimensionLabel =
    dimension === 'artist' ? 'artists' :
    dimension === 'song'   ? 'songs'   : 'categories'
  const expandable = dimension === 'artist' || dimension === 'song'

  // Expansion state — Set of row labels currently open. Cache maps
  // label → { loading, error, categories }. Cache survives collapse/
  // re-expand so re-clicking doesn't re-fetch.
  const [expanded, setExpanded] = useState(() => new Set())
  const [subCache, setSubCache] = useState({})
  // Per-row "show all categories" toggle. Near-zero categories
  // (< 1% share of the parent) are hidden by default — kept in the
  // stacked strip's proportions, but folded into a single "N more"
  // line under the visible list. Clicking that line adds the row's
  // label to this set so the full list renders.
  const [showAll, setShowAll] = useState(() => new Set())
  // Reset expansion + show-all when the dimension changes.
  useEffect(() => { setExpanded(new Set()); setSubCache({}); setShowAll(new Set()) }, [dimension])
  const CATEGORY_MIN_SHARE = 1 // % — anything below this is "near-zero"

  const loadSub = async (label) => {
    if (subCache[label] && (subCache[label].categories || subCache[label].error)) return
    setSubCache(c => ({ ...c, [label]: { loading: true } }))
    try {
      const qs = new URLSearchParams({ dimension, value: label })
      if (range?.from) qs.set('from', range.from)
      if (range?.to)   qs.set('to',   range.to)
      if (scopeFilters?.artist)   qs.set('artist',   scopeFilters.artist)
      if (scopeFilters?.category) qs.set('category', scopeFilters.category)
      if (scopeFilters?.rep)      qs.set('rep',      scopeFilters.rep)
      const r = await api.get(`/financials/exec/subbreakdown?${qs}`)
      const cats = r.data?.data?.categories || []
      setSubCache(c => ({ ...c, [label]: { loading: false, categories: cats } }))
    } catch (err) {
      setSubCache(c => ({ ...c, [label]: { loading: false, error: err?.response?.data?.error || err.message || 'Failed to load' } }))
    }
  }
  const toggle = (label) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(label)) { next.delete(label); return next }
      next.add(label)
      loadSub(label)
      return next
    })
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Top spend</h2>
          {rows.length > 0 && (
            <p className="text-[11px] text-gray-400 mt-0.5">
              Top {rows.length} {dimensionLabel} · {fmtCompact(totalPaid)} paid
              {totalUnpaid > 0 && <> · <span className="text-rose-600">{fmtCompact(totalUnpaid)} unpaid</span></>}
              {expandable && <> · <span className="text-gray-500">click any row to see category breakdown</span></>}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1">
          {[
            { key: 'artist',   label: 'By Artist' },
            { key: 'song',     label: 'By Song' },
            { key: 'category', label: 'By Category' },
          ].map(d => (
            <button
              key={d.key}
              onClick={() => onDimensionChange(d.key)}
              className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                dimension === d.key ? 'bg-card text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-6">No spend in the selected range.</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r, i) => {
            const paid = Number(r.paid_usd) || 0
            const unpaid = Number(r.unpaid_usd) || 0
            // Share of total-paid-among-top-N. Different from the old
            // "max-scaled" bar — makes the visual compare across rows
            // as a share of the visible pie.
            const share = totalPaid > 0 ? (paid / totalPaid) * 100 : 0
            const barWidth = Math.max(share, 1.5)
            const isOpen = expanded.has(r.label)
            const sub = subCache[r.label]
            const rowTotal = paid + unpaid
            return (
              <div
                key={`${r.label}-${i}`}
                className={isOpen ? 'border border-boom-300/60 rounded-lg bg-gray-500/[0.04] overflow-hidden' : ''}
              >
                <button
                  type="button"
                  onClick={expandable ? () => toggle(r.label) : undefined}
                  className={`w-full flex items-center gap-3 text-xs group px-1 py-1 -mx-1 text-left ${isOpen ? 'rounded-t-lg mx-0 px-2' : 'rounded-md'} ${expandable && !isOpen ? 'cursor-pointer hover:bg-gray-50 transition-colors' : (isOpen ? 'cursor-pointer' : 'cursor-default')}`}
                  aria-expanded={expandable ? isOpen : undefined}
                >
                  {expandable ? (
                    <ChevronRight
                      size={12}
                      className={`shrink-0 text-gray-400 transition-transform ${isOpen ? 'rotate-90 text-boom-500' : ''}`}
                    />
                  ) : <span className="w-3" />}
                  <span className="w-5 shrink-0 font-bold text-gray-400 tabular-nums">{i + 1}</span>
                  <span className="w-48 shrink-0 font-semibold text-gray-800 truncate" title={r.label}>{r.label}</span>
                  <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden relative">
                    <div
                      className="h-full bg-emerald-500 rounded-full transition-all"
                      style={{ width: `${barWidth}%` }}
                    />
                    {unpaid > 0 && paid > 0 && (
                      <div
                        className="absolute top-0 h-full bg-rose-400/70"
                        style={{
                          left: `${barWidth}%`,
                          width: `${Math.min(unpaid / totalPaid * 100, 100 - barWidth)}%`,
                        }}
                        title={`${fmtUsd(unpaid)} unpaid`}
                      />
                    )}
                  </div>
                  <span className="w-14 text-right text-[11px] tabular-nums text-gray-500 font-semibold">
                    {share.toFixed(0)}%
                  </span>
                  <span className="w-24 text-right font-bold tabular-nums text-gray-900">{fmtUsd(paid)}</span>
                  <span className="w-24 text-right text-[11px] tabular-nums text-rose-600" title="Unpaid">
                    {unpaid > 0 ? `+${fmtCompact(unpaid)} owed` : ''}
                  </span>
                  <span className="w-14 text-right tabular-nums text-gray-400">{r.row_count} row{r.row_count === 1 ? '' : 's'}</span>
                </button>
                {/* Nested category breakdown — a stacked strip that
                    lands EXACTLY under the parent's bar column (same
                    left/right offsets via matching flex spacers), so
                    it reads as "the parent's bar, exploded into
                    categories". Per-row bars removed to make room for
                    numeric detail; the strip covers the visual read.
                    The outer wrapper already carries the border + bg,
                    so this container just provides padding + a subtle
                    hairline separator from the parent row above. */}
                {isOpen && expandable && (
                  <div className="pt-3 pb-2 px-2 border-t border-boom-300/30">
                    {sub?.loading ? (
                      <div className="flex items-center gap-2 py-2 pl-10 text-[11px] text-gray-500">
                        <Loader size={11} className="animate-spin" /> Loading category breakdown for {r.label}…
                      </div>
                    ) : sub?.error ? (
                      <p className="text-[11px] text-rose-600 py-2 pl-10">Couldn't load: {sub.error}</p>
                    ) : !sub?.categories?.length ? (
                      <p className="text-[11px] text-gray-500 py-2 pl-10">No categorized spend for {r.label}.</p>
                    ) : (() => {
                      const cats = sub.categories.map(c => {
                        const cPaid = Number(c.paid_usd) || 0
                        const cUnpaid = Number(c.unpaid_usd) || 0
                        const cTotal = cPaid + cUnpaid
                        const cShare = rowTotal > 0 ? (cTotal / rowTotal) * 100 : 0
                        return { ...c, cPaid, cUnpaid, cTotal, cShare }
                      })
                      const bigCats   = cats.filter(c => c.cShare >= CATEGORY_MIN_SHARE)
                      const smallCats = cats.filter(c => c.cShare < CATEGORY_MIN_SHARE)
                      const isShowAll = showAll.has(r.label)
                      const visible   = isShowAll ? cats : bigCats
                      const smallTotal  = smallCats.reduce((s, c) => s + c.cTotal, 0)
                      const smallPaid   = smallCats.reduce((s, c) => s + c.cPaid, 0)
                      const smallUnpaid = smallCats.reduce((s, c) => s + c.cUnpaid, 0)
                      const smallShare  = rowTotal > 0 ? (smallTotal / rowTotal) * 100 : 0

                      // Palette rotation for the strip segments —
                      // muted, harmonious tones drawn from Tailwind's
                      // 400 range so no single segment shouts. Warm
                      // amber + rose act as accents against the cool
                      // green/teal/blue base. Emerald stays first so
                      // the biggest slice usually reads as "paid".
                      const CAT_COLORS = [
                        '#34d399', // emerald-400
                        '#38bdf8', // sky-400
                        '#a78bfa', // violet-400
                        '#fbbf24', // amber-400
                        '#2dd4bf', // teal-400
                        '#818cf8', // indigo-400
                        '#f472b6', // pink-400
                        '#a3e635', // lime-400
                        '#22d3ee', // cyan-400
                        '#fb7185', // rose-400
                        '#c084fc', // purple-400
                        '#facc15', // yellow-400
                      ]
                      const colorFor = (i) => CAT_COLORS[i % CAT_COLORS.length]

                      return (
                        <>
                          {/* Strip row — matches the parent's flex
                              layout exactly. Chevron + rank spacers
                              take the same width as parent's chevron
                              + rank, then a small "Mix" label sits
                              where the parent's artist name is, and
                              the strip fills the parent's bar column. */}
                          <div className="flex items-center gap-3 text-[11px] mb-2 px-1">
                            <span className="w-3 shrink-0" />
                            <span className="w-5 shrink-0" />
                            <span className="w-48 shrink-0 text-[9px] uppercase tracking-wider font-bold text-gray-500">Mix inside <span className="text-gray-700">{r.label}</span></span>
                            {/* Strip is slightly taller (h-5) than
                                before to give room for inline % labels
                                on the big segments. Labels only show
                                when a segment is wide enough to fit
                                the text without collision (>= 10%
                                of the strip). */}
                            <div className="flex-1 h-5 bg-gray-100 rounded-md overflow-hidden flex ring-1 ring-black/5" title={`Category mix for ${r.label}`}>
                              {cats.map((c, ci) => {
                                if (c.cShare <= 0) return null
                                const unpaidPct = c.cTotal > 0 ? (c.cUnpaid / c.cTotal) * 100 : 0
                                const showLabel = c.cShare >= 10
                                return (
                                  <div
                                    key={`seg-${c.category}-${ci}`}
                                    className="relative h-full overflow-hidden"
                                    style={{
                                      width: `${c.cShare}%`,
                                      minWidth: c.cShare > 0 ? 2 : 0,
                                      background: colorFor(ci),
                                      borderRight: ci < cats.length - 1 ? '1px solid rgba(15,17,23,0.35)' : 'none',
                                    }}
                                    title={`${c.category} · ${c.cShare.toFixed(1)}% · ${fmtUsd(c.cTotal)}${c.cUnpaid > 0 ? ` (${fmtUsd(c.cUnpaid)} unpaid)` : ''}`}
                                  >
                                    {unpaidPct > 0 && (
                                      <div className="absolute top-0 right-0 h-full bg-rose-500/60" style={{ width: `${unpaidPct}%` }} />
                                    )}
                                    {showLabel && (
                                      <span
                                        className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-slate-900/70 select-none"
                                        style={{ textShadow: '0 1px 0 rgba(255,255,255,0.35)' }}
                                      >
                                        {c.cShare.toFixed(0)}%
                                      </span>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                            <span className="w-14 shrink-0" />
                            <span className="w-24 shrink-0" />
                            <span className="w-24 shrink-0" />
                            <span className="w-14 shrink-0" />
                          </div>

                          {/* Numeric list — no per-row bar; the strip
                              above owns the visual. Small color chip
                              per row ties back to the strip segment. */}
                          <div className="space-y-0.5">
                            {visible.map((c, ci) => (
                              <div key={`${r.label}-${c.category}-${ci}`} className="flex items-center gap-3 text-[11px] px-1 py-1 rounded hover:bg-gray-500/[0.06] transition-colors">
                                <span className="w-3 shrink-0" />
                                <span className="w-5 shrink-0" />
                                <span className="w-48 shrink-0 truncate flex items-center gap-2 text-gray-700 font-medium" title={c.category}>
                                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: colorFor(cats.indexOf(c)) }} />
                                  <span className="truncate">{c.category}</span>
                                </span>
                                <span className="flex-1" />
                                <span className="w-14 text-right tabular-nums text-gray-500 font-semibold">{c.cShare.toFixed(0)}%</span>
                                <span className="w-24 text-right tabular-nums text-emerald-600 font-semibold">{fmtUsd(c.cPaid)}</span>
                                <span className={`w-24 text-right tabular-nums ${c.cUnpaid > 0 ? 'text-rose-600 font-semibold' : 'text-gray-400'}`}>
                                  {c.cUnpaid > 0 ? `+${fmtUsd(c.cUnpaid)}` : '—'}
                                </span>
                                <span className="w-14 text-right tabular-nums text-gray-400">{c.row_count} row{c.row_count === 1 ? '' : 's'}</span>
                              </div>
                            ))}
                            {smallCats.length > 0 && !isShowAll && (
                              <button
                                type="button"
                                onClick={e => { e.stopPropagation(); setShowAll(prev => { const n = new Set(prev); n.add(r.label); return n }) }}
                                className="flex items-center gap-3 text-[11px] w-full hover:bg-gray-500/[0.06] rounded px-1 py-1 text-left cursor-pointer transition-colors"
                                title={`Show ${smallCats.length} near-zero categor${smallCats.length === 1 ? 'y' : 'ies'}`}
                              >
                                <span className="w-3 shrink-0" />
                                <span className="w-5 shrink-0" />
                                <span className="w-48 shrink-0 truncate italic text-gray-500">+ {smallCats.length} more &lt; {CATEGORY_MIN_SHARE}% · click to show</span>
                                <span className="flex-1" />
                                <span className="w-14 text-right tabular-nums text-gray-400">{smallShare.toFixed(0)}%</span>
                                <span className="w-24 text-right tabular-nums text-gray-500">{fmtUsd(smallPaid)}</span>
                                <span className={`w-24 text-right tabular-nums ${smallUnpaid > 0 ? 'text-rose-600 font-semibold' : 'text-gray-400'}`}>
                                  {smallUnpaid > 0 ? `+${fmtUsd(smallUnpaid)}` : '—'}
                                </span>
                                <span className="w-14 text-right tabular-nums text-gray-400">—</span>
                              </button>
                            )}
                            {isShowAll && smallCats.length > 0 && (
                              <button
                                type="button"
                                onClick={e => { e.stopPropagation(); setShowAll(prev => { const n = new Set(prev); n.delete(r.label); return n }) }}
                                className="flex items-center gap-3 text-[11px] w-full text-gray-500 hover:text-gray-700 px-1 pt-1 transition-colors"
                              >
                                <span className="w-3 shrink-0" />
                                <span className="w-5 shrink-0" />
                                <span>Hide {smallCats.length} near-zero categor{smallCats.length === 1 ? 'y' : 'ies'}</span>
                              </button>
                            )}
                          </div>
                        </>
                      )
                    })()}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Payment aging + upcoming due ───────────────────────────────────────────
// Two-panel card. Left: aging buckets (0-30 / 30-60 / 60-90 / 90+ days
// past due) as color-scaled bars — the 90+ bucket is where boards look
// first. Right: upcoming-due windows (next 7 / 30 / 60 days) as three
// compact stat mini-cards for the near-term cash call.
function PaymentAgingSection({ aging, upcoming, onDrill }) {
  if (!aging || !upcoming) return null
  // Each bucket carries the drill-through key that hits
  // /financials/exec/rows?bucket=… so the modal can lazy-load the
  // invoices behind the bar without a second fetch on mount.
  const buckets = [
    { key: '0-30',  drill: 'aging_0_30',    label: '0–30 days past due',  color: 'bg-amber-400',  tone: 'text-amber-700 bg-amber-50 ring-amber-200/60' },
    { key: '30-60', drill: 'aging_30_60',   label: '30–60 days',           color: 'bg-orange-500', tone: 'text-orange-700 bg-orange-50 ring-orange-200/60' },
    { key: '60-90', drill: 'aging_60_90',   label: '60–90 days',           color: 'bg-rose-500',   tone: 'text-rose-700 bg-rose-50 ring-rose-200/60' },
    { key: '90+',   drill: 'aging_90_plus', label: '90+ days',             color: 'bg-rose-700',   tone: 'text-rose-800 bg-rose-100 ring-rose-300/60' },
  ]
  const overdueTotal = buckets.reduce((s, b) => s + (aging[b.key]?.usd || 0), 0)
  const overdueCount = buckets.reduce((s, b) => s + (aging[b.key]?.count || 0), 0)
  return (
    <div className="card p-5">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-6">
        {/* Aging buckets */}
        <div>
          <div className="flex items-baseline justify-between mb-4">
            <div>
              <h2 className="text-sm font-bold text-gray-900">Payment aging</h2>
              <p className="text-[11px] text-gray-400 mt-0.5">
                Unpaid invoices past their due date · {overdueCount} invoice{overdueCount === 1 ? '' : 's'} · {fmtUsd(overdueTotal)}
              </p>
            </div>
          </div>
          {overdueTotal === 0 ? (
            <div className="text-center py-6 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg">
              ✓ Nothing past due
            </div>
          ) : (
            <div className="space-y-2">
              {buckets.map(b => {
                const bucket = aging[b.key] || { count: 0, usd: 0 }
                const pct = overdueTotal > 0 ? (bucket.usd / overdueTotal) * 100 : 0
                const clickable = bucket.count > 0 && typeof onDrill === 'function'
                return (
                  <button
                    key={b.key}
                    type="button"
                    disabled={!clickable}
                    onClick={() => clickable && onDrill(b.drill)}
                    title={clickable ? `View the ${bucket.count} invoice${bucket.count === 1 ? '' : 's'} in this bucket` : undefined}
                    className={`w-full flex items-center gap-3 text-xs text-left rounded-md px-1 py-1 transition-colors ${clickable ? 'hover:bg-gray-50 cursor-pointer' : 'cursor-default'}`}
                  >
                    <span className="w-40 shrink-0 font-semibold text-gray-700">{b.label}</span>
                    <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden">
                      <div className={`h-full ${b.color} rounded-full transition-all`} style={{ width: `${Math.max(pct, bucket.usd > 0 ? 2 : 0)}%` }} />
                    </div>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ring-1 ${b.tone} tabular-nums`}>
                      {bucket.count}
                    </span>
                    <span className="w-24 text-right font-bold tabular-nums text-gray-900">{fmtUsd(bucket.usd)}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Upcoming due */}
        <div className="min-w-[260px] md:border-l md:pl-6 md:border-rule">
          <h2 className="text-sm font-bold text-gray-900 mb-1">Upcoming due</h2>
          <p className="text-[11px] text-gray-400 mb-4">Near-term cash call</p>
          <div className="space-y-1">
            {[
              { key: 'in_7',  drill: 'upcoming_7',  label: 'Next 7 days',  accent: 'text-amber-700' },
              { key: 'in_30', drill: 'upcoming_30', label: 'Next 30 days', accent: 'text-gray-700' },
              { key: 'in_60', drill: 'upcoming_60', label: 'Next 60 days', accent: 'text-gray-500' },
            ].map(w => {
              const d = upcoming[w.key] || { count: 0, usd: 0 }
              const clickable = d.count > 0 && typeof onDrill === 'function'
              return (
                <button
                  key={w.key}
                  type="button"
                  disabled={!clickable}
                  onClick={() => clickable && onDrill(w.drill)}
                  title={clickable ? `View the ${d.count} invoice${d.count === 1 ? '' : 's'} due in this window` : undefined}
                  className={`w-full flex items-center justify-between gap-3 pr-1 rounded-md px-1 py-1 transition-colors ${clickable ? 'hover:bg-gray-50 cursor-pointer' : 'cursor-default'}`}
                >
                  <span className="text-xs text-gray-500">{w.label}</span>
                  <div className="flex items-baseline gap-2">
                    <span className={`text-sm font-bold tabular-nums ${w.accent}`}>{fmtUsd(d.usd)}</span>
                    <span className="text-[11px] text-gray-400 tabular-nums">{d.count} inv</span>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Category composition trend ─────────────────────────────────────────────
// Stacked area chart showing category mix month-by-month across the range.
// Complements the top-N breakdown — the breakdown gives ranking, this gives
// composition change over time. Colors from a fixed palette so a given
// category holds its color across renders.
function CategoryTrendSection({ trend }) {
  if (!trend?.months?.length || !trend?.categories?.length) return null
  const CAT_COLORS = [
    '#10b981', // emerald  — Marketing usually dominates; strong lead color
    '#6366f1', // indigo
    '#f59e0b', // amber
    '#ec4899', // pink
    '#0ea5e9', // sky
    '#a855f7', // purple
    '#f43f5e', // rose
    '#84cc16', // lime
    '#94a3b8', // slate  — reserved for "Other"
  ]
  const colorFor = (cat, i) => cat === 'Other' ? CAT_COLORS[CAT_COLORS.length - 1] : CAT_COLORS[i % (CAT_COLORS.length - 1)]
  const monthLabelShort = (ym) => {
    const [y, m] = (ym || '').split('-').map(Number)
    if (!y || !m) return ym
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
  }
  const dataForChart = trend.months.map(row => ({ ...row, label: monthLabelShort(row.month) }))
  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-bold text-gray-900">Category composition</h2>
        <p className="text-[11px] text-gray-400">{dataForChart.length} months · USD-equivalent</p>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={dataForChart} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={fmtCompact} axisLine={false} tickLine={false} width={56} />
          <Tooltip
            formatter={(v, key) => [fmtUsd(v), key]}
            labelFormatter={(l, payload) => {
              const m = payload?.[0]?.payload?.month
              return m ? `Month of ${m}` : l
            }}
            contentStyle={{ fontSize: 12, borderRadius: 8 }}
          />
          {trend.categories.map((cat, i) => (
            <Area
              key={cat}
              type="monotone"
              dataKey={cat}
              stackId="1"
              stroke={colorFor(cat, i)}
              fill={colorFor(cat, i)}
              fillOpacity={0.72}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[11px] text-gray-500">
        {trend.categories.map((cat, i) => (
          <span key={cat} className="inline-flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: colorFor(cat, i) }} />
            {cat}
          </span>
        ))}
      </div>
    </div>
  )
}


// ── Monthly rollup ─────────────────────────────────────────────────────────
// Expandable per-month accordion, mirroring the old Spend by Month + Artist
// section. Kept per user request. Data comes from /financials/monthly-by-artist.
function PaidUnpaidBar({ paid, unpaid }) {
  const total = paid + unpaid
  if (total <= 0) return <div className="h-1.5 bg-gray-200 rounded-full" />
  const paidPct   = (paid   / total) * 100
  const unpaidPct = (unpaid / total) * 100
  return (
    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden flex">
      {paidPct > 0   && <div className="h-full bg-emerald-500" style={{ width: `${paidPct}%` }} />}
      {unpaidPct > 0 && <div className="h-full bg-rose-400"     style={{ width: `${unpaidPct}%` }} />}
    </div>
  )
}
function MonthlyRollup({ rows, loading, artistFilter, onArtistFilterChange, receivedByMonth = {} }) {
  const [sortKey, setSortKey] = useState('month')
  const [sortDir, setSortDir] = useState('desc')

  const filtered = artistFilter
    ? rows.filter(r => r.artist === artistFilter)
    : rows
  const byMonth = new Map()
  for (const r of filtered) {
    if (!byMonth.has(r.month)) byMonth.set(r.month, { month: r.month, paid: 0, unpaid: 0, total: 0, count: 0, artists: [] })
    const m = byMonth.get(r.month)
    m.paid += r.paid; m.unpaid += r.unpaid; m.total += r.total; m.count += (r.count || 0)
    m.artists.push({ ...r })
  }
  // Chronological ordering — needed for MoM deltas regardless of the
  // display sort. We compute deltas first (each month vs the month
  // immediately before it), then re-sort for display. Received data
  // gets merged in per month from the top-level map (not per-artist,
  // so an artist-filter view shows label-wide received context).
  const chrono = Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month))
  const byMonthKey = new Map(chrono.map(m => [m.month, m]))
  const withDelta = chrono.map((m, i) => {
    const priorTotal = i > 0 ? chrono[i - 1].total : null
    const priorMonth = i > 0 ? chrono[i - 1].month : null
    const deltaPct = (priorTotal && priorTotal > 0) ? ((m.total - priorTotal) / priorTotal) * 100 : null
    const receivedRow = receivedByMonth?.[m.month] || {}
    const received_usd   = Number(receivedRow.usd) || 0
    const received_count = Number(receivedRow.count) || 0
    // Two "difference" readings on the row:
    //   diff_booked = Received − (Paid + Unpaid). Net position when you
    //     count everything approved as spent — positive means the money
    //     coming in outpaced what got booked to the P&L that month.
    //   diff_paid = Received − Paid. Cash impact of what actually
    //     cleared out the door — ignores unpaid obligations still owed.
    const diff_booked = received_usd - (m.paid + m.unpaid)
    const diff_paid   = received_usd - m.paid
    return { ...m, priorTotal, priorMonth, deltaPct, received_usd, received_count, diff_booked, diff_paid }
  })
  const displaySorted = [...withDelta].sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey]
    if (sortKey === 'month') {
      return sortDir === 'desc' ? b.month.localeCompare(a.month) : a.month.localeCompare(b.month)
    }
    const an = Number(av) || 0, bn = Number(bv) || 0
    return sortDir === 'desc' ? bn - an : an - bn
  })
  const allArtists = Array.from(new Set(rows.map(r => r.artist))).sort()

  // Totals across visible months + biggest-month callout data.
  const totals = withDelta.reduce((acc, m) => ({
    paid: acc.paid + m.paid, unpaid: acc.unpaid + m.unpaid,
    total: acc.total + m.total, count: acc.count + m.count,
    received_usd: acc.received_usd + (m.received_usd || 0),
    received_count: acc.received_count + (m.received_count || 0),
  }), { paid: 0, unpaid: 0, total: 0, count: 0, received_usd: 0, received_count: 0 })
  const avgPerMonth = withDelta.length ? totals.total / withDelta.length : 0
  // Received + paid averages split out so the Avg / month tile can show
  // both — total is the sum of paid + unpaid so its average and received's
  // are equal by construction (Paid + Unpaid = Received), but the paid-
  // only average is meaningfully different and worth surfacing.
  const avgReceivedPerMonth = withDelta.length ? totals.received_usd / withDelta.length : 0
  const avgPaidPerMonth     = withDelta.length ? totals.paid / withDelta.length : 0
  const biggestMonth = withDelta.reduce((best, m) => (m.total > (best?.total || 0) ? m : best), null)
  const smallestMonth = withDelta.reduce((least, m) => (least == null || m.total < least.total ? m : least), null)

  const toggleSort = (key) => {
    setSortKey(prev => {
      if (prev === key) {
        setSortDir(d => d === 'desc' ? 'asc' : 'desc')
        return prev
      }
      // First click on a new column: sensible default direction per key.
      setSortDir(key === 'month' ? 'desc' : 'desc')
      return key
    })
  }
  const SortHeader = ({ label, keyName, className = '' }) => (
    <button
      type="button"
      onClick={() => toggleSort(keyName)}
      className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold ${sortKey === keyName ? 'text-gray-700' : 'text-gray-400 hover:text-gray-600'} ${className}`}
      title={`Sort by ${label}`}
    >
      {label}
      <ArrowUpDown size={10} className={sortKey === keyName ? 'text-gray-500' : 'text-gray-300'} />
      {sortKey === keyName && <span className="text-[9px] text-gray-400">{sortDir === 'asc' ? '↑' : '↓'}</span>}
    </button>
  )

  return (
    <div data-tour="financials-monthly" className="card p-5">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Monthly rollup</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Approved spend by month, with <span className="text-emerald-700 font-semibold">paid</span> and{' '}
            <span className="text-rose-700 font-semibold">unpaid</span> split. Click any month to open the drill-down.
          </p>
          {/* Legend for the two Difference readings — spells out the
              math so the column's "Rec − Approved" / "Rec − Paid"
              short labels are self-explanatory without hovering. */}
          <p className="text-[11px] text-gray-500 mt-1">
            <span className="font-semibold text-gray-700">Difference</span> shows two readings:{' '}
            <span className="font-semibold">Received − Approved</span> (net position — everything approved this month,
            whether paid yet or not) and <span className="font-semibold">Received − Paid</span> (cash out — only what
            actually cleared this month). Positive = took in more than we {' '}
            <span className="whitespace-nowrap">approved/paid</span>; negative = spent more than we took in.
          </p>
        </div>
        <select
          value={artistFilter}
          onChange={e => onArtistFilterChange(e.target.value)}
          className="text-xs px-2.5 py-1.5 border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400 max-w-[220px]"
          title="Narrow to a single artist"
        >
          <option value="">All artists</option>
          {allArtists.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>

      {/* Summary strip — totals across all visible months + monthly
          average + biggest / smallest month callouts + received. Six
          tiles now; grid expands to 6 columns on md+. */}
      {withDelta.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4 pb-4 border-b border-rule">
          <div>
            <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">Total paid</p>
            <p className="text-base font-bold text-emerald-700 tabular-nums mt-0.5">{fmtUsd(totals.paid)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">Total unpaid</p>
            <p className="text-base font-bold text-rose-700 tabular-nums mt-0.5">{fmtUsd(totals.unpaid)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">Received</p>
            <p className="text-base font-bold text-sky-700 tabular-nums mt-0.5">{fmtUsd(totals.received_usd)}</p>
            <p className="text-[10px] text-gray-400 mt-0.5">{totals.received_count} invoice{totals.received_count === 1 ? '' : 's'} submitted</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">Avg / month</p>
            {/* Two-line stack: received on top (sky), paid underneath
                (emerald). Same colors the tiles + rollup table already
                use so the reader doesn't have to reference a legend. */}
            <div className="mt-0.5 flex items-baseline gap-2 flex-wrap">
              <span className="text-base font-bold text-sky-700 tabular-nums" title="Average received per month">{fmtUsd(avgReceivedPerMonth)}</span>
              <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">received</span>
            </div>
            <div className="mt-0.5 flex items-baseline gap-2 flex-wrap">
              <span className="text-sm font-bold text-emerald-700 tabular-nums" title="Average paid per month">{fmtUsd(avgPaidPerMonth)}</span>
              <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">paid</span>
            </div>
            <p className="text-[10px] text-gray-400 mt-1">{withDelta.length} month{withDelta.length === 1 ? '' : 's'} · {totals.count} invoice{totals.count === 1 ? '' : 's'}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">Biggest month</p>
            {biggestMonth ? (
              <Link to={`/financials/month/${biggestMonth.month}`} className="text-sm font-bold text-gray-900 tabular-nums mt-0.5 hover:text-boom-700 block truncate">
                {monthLabel(biggestMonth.month)}
              </Link>
            ) : <p className="text-sm text-gray-400 mt-0.5">—</p>}
            {biggestMonth && <p className="text-[10px] text-gray-500 tabular-nums">{fmtUsd(biggestMonth.total)}</p>}
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">Smallest month</p>
            {smallestMonth ? (
              <Link to={`/financials/month/${smallestMonth.month}`} className="text-sm font-bold text-gray-900 tabular-nums mt-0.5 hover:text-boom-700 block truncate">
                {monthLabel(smallestMonth.month)}
              </Link>
            ) : <p className="text-sm text-gray-400 mt-0.5">—</p>}
            {smallestMonth && <p className="text-[10px] text-gray-500 tabular-nums">{fmtUsd(smallestMonth.total)}</p>}
          </div>
        </div>
      )}

      {/* Column header row — sortable. Added Received (new invoicing
          per month, by created_at) to the trio between Unpaid and vs
          Prior. Grid template gets an extra 0.9fr column to match. */}
      {withDelta.length > 0 && (
        <div className="hidden md:grid gap-3 px-4 py-2 text-[10px] uppercase tracking-wider font-semibold text-gray-400 border-b border-rule" style={{ gridTemplateColumns: '1.4fr 1fr 0.9fr 0.9fr 0.9fr 0.9fr 1fr 20px' }}>
          <SortHeader label="Month"  keyName="month" />
          <span>Paid / Unpaid split</span>
          <SortHeader label="Paid"     keyName="paid"           className="justify-end" />
          <SortHeader label="Unpaid"   keyName="unpaid"         className="justify-end" />
          <SortHeader label="Received" keyName="received_usd"   className="justify-end" />
          <span className="text-right">vs prior</span>
          <SortHeader label="Difference" keyName="diff_booked"  className="justify-end" />
          <span />
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-gray-500 py-6 justify-center">
          <Loader size={14} className="animate-spin" /> Loading monthly breakdown…
        </div>
      ) : displaySorted.length === 0 ? (
        <p className="text-center text-xs text-gray-400 py-6">No spend recorded in this window.</p>
      ) : (
        <div className="space-y-2 mt-2">
          {displaySorted.map(m => {
            const isBiggest = biggestMonth && m.month === biggestMonth.month
            return (
              <Link
                key={m.month}
                to={`/financials/month/${m.month}`}
                className={`group border rounded-lg bg-card flex flex-col md:grid gap-2 md:gap-3 px-4 py-2.5 transition-colors ${isBiggest ? 'border-amber-300 bg-amber-50/40 hover:border-amber-400' : 'border-rule hover:bg-gray-50 hover:border-boom-200'}`}
                style={{ gridTemplateColumns: '1.4fr 1fr 0.9fr 0.9fr 0.9fr 0.9fr 1fr 20px' }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`text-sm font-semibold ${isBiggest ? 'text-amber-800' : 'text-gray-900 group-hover:text-boom-700'}`}>{monthLabel(m.month)}</span>
                  {isBiggest && <span className="text-[9px] font-bold text-amber-700 bg-amber-100 rounded px-1.5 py-0.5 uppercase tracking-wider">Peak</span>}
                  <span className="text-[11px] text-gray-400 truncate">{m.artists.length} artist{m.artists.length === 1 ? '' : 's'} · {m.count} inv</span>
                </div>
                <div className="hidden md:flex items-center">
                  <div className="w-full">
                    <PaidUnpaidBar paid={m.paid} unpaid={m.unpaid} />
                  </div>
                </div>
                <span className="text-[11px] font-semibold tabular-nums text-emerald-700 md:text-right">{fmtCompact(m.paid)}</span>
                <span className="text-[11px] font-semibold tabular-nums text-rose-700 md:text-right">{fmtCompact(m.unpaid)}</span>
                <span
                  className="text-[11px] font-semibold tabular-nums text-sky-700 md:text-right"
                  title={`${m.received_count || 0} invoice${m.received_count === 1 ? '' : 's'} submitted this month`}
                >
                  {m.received_usd > 0 ? fmtCompact(m.received_usd) : <span className="text-gray-300">—</span>}
                  {m.received_count > 0 && (
                    <span className="text-[9px] text-gray-400 ml-1">· {m.received_count}</span>
                  )}
                </span>
                <span className="md:text-right">
                  <MonthDelta current={m.total} prior={m.priorTotal || 0} priorLabel={m.priorMonth ? monthLabel(m.priorMonth) : ''} />
                </span>
                {/* Difference cell — two readings stacked:
                    primary (bold) = Received − Approved (Paid+Unpaid),
                      i.e. net position vs everything approved this month.
                    secondary (muted) = Received − Paid, i.e. cash-out
                      impact that ignores unpaid obligations still owed.
                    Green when positive, rose when negative, neutral at 0.
                    Labels spell out the math so the legend above and the
                    per-row cell agree without a hover. */}
                {(() => {
                  const d1 = m.diff_booked
                  const d2 = m.diff_paid
                  const tone = (v) => v > 0 ? 'text-emerald-700' : v < 0 ? 'text-rose-700' : 'text-gray-400'
                  const sign = (v) => v > 0 ? '+' : ''
                  return (
                    <span className="text-right">
                      <span
                        className={`block text-sm font-bold tabular-nums ${tone(d1)}`}
                        title={`Received (${fmtCompact(m.received_usd)}) − Approved (Paid ${fmtCompact(m.paid)} + Unpaid ${fmtCompact(m.unpaid)}) = ${sign(d1)}${fmtUsd(d1)}. Net position: everything approved this month, whether paid yet or not.`}
                      >
                        {sign(d1)}{fmtCompact(d1)}
                        <span className="text-[9px] font-semibold text-gray-400 ml-1">Rec − Approved</span>
                      </span>
                      <span
                        className={`block text-[11px] tabular-nums mt-0.5 ${tone(d2)}`}
                        title={`Received (${fmtCompact(m.received_usd)}) − Paid (${fmtCompact(m.paid)}) = ${sign(d2)}${fmtUsd(d2)}. Cash out: only what actually cleared this month.`}
                      >
                        {sign(d2)}{fmtCompact(d2)}
                        <span className="text-[9px] font-medium text-gray-400 ml-1">Rec − Paid</span>
                      </span>
                    </span>
                  )
                })()}
                <ChevronRight size={14} className={`justify-self-end self-center ${isBiggest ? 'text-amber-500' : 'text-gray-300 group-hover:text-boom-500'}`} />
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Vendor concentration (Pareto) ──────────────────────────────────────────
// Top-12 vendors as bars + cumulative % of TOTAL spend as a line. The
// line is calibrated against the range's grand total (not just the top
// 12) so "cumulative 80%" tells you the real concentration ratio,
// not a tautology.
function VendorConcentrationSection({ vendors }) {
  if (!vendors || !Array.isArray(vendors.rows) || vendors.rows.length === 0) return null
  const grand = Number(vendors.grand_total) || 0
  let running = 0
  const rows = vendors.rows.map(v => {
    running += Number(v.total_usd) || 0
    return {
      payee: v.payee,
      payee_short: v.payee.length > 18 ? v.payee.slice(0, 16) + '…' : v.payee,
      paid_usd: Number(v.paid_usd) || 0,
      unpaid_usd: Number(v.unpaid_usd) || 0,
      total_usd: Number(v.total_usd) || 0,
      invoice_count: Number(v.invoice_count) || 0,
      cumulative_pct: grand > 0 ? (running / grand) * 100 : 0,
    }
  })
  const topPct = rows[rows.length - 1]?.cumulative_pct || 0
  const topCount = rows.length
  const Tt = ({ active, payload }) => {
    if (!active || !payload?.length) return null
    const r = payload[0].payload
    return (
      <div className="bg-white border border-rule rounded-lg shadow-md px-3 py-2 text-xs" style={{ minWidth: 220 }}>
        <p className="font-semibold text-gray-900 mb-1.5">{r.payee}</p>
        <div className="flex items-center justify-between gap-3">
          <span className="text-gray-500"><span className="inline-block w-2 h-2 rounded-sm bg-emerald-500 mr-1" />Paid</span>
          <span className="font-semibold tabular-nums text-gray-900">{fmtUsd(r.paid_usd)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-gray-500"><span className="inline-block w-2 h-2 rounded-sm bg-rose-500 mr-1" />Unpaid</span>
          <span className="font-semibold tabular-nums text-gray-900">{fmtUsd(r.unpaid_usd)}</span>
        </div>
        <div className="flex items-center justify-between gap-3 pt-1 border-t border-rule">
          <span className="text-gray-700 font-semibold">Total</span>
          <span className="font-bold tabular-nums text-gray-900">{fmtUsd(r.total_usd)}</span>
        </div>
        <p className="text-[10px] text-gray-400 pt-1">{r.invoice_count} invoice{r.invoice_count === 1 ? '' : 's'} · {r.cumulative_pct.toFixed(1)}% cumulative</p>
      </div>
    )
  }
  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Vendor concentration</h2>
          <p className="text-[11px] text-gray-400 mt-0.5">
            Top {topCount} vendors account for <span className="font-semibold text-gray-700">{topPct.toFixed(1)}%</span> of spend
          </p>
        </div>
        <div className="text-[11px] text-gray-500">
          <span className="inline-flex items-center gap-1.5 mr-3"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-slate-700" /> Vendor spend</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-0.5 bg-amber-500" /> Cumulative % of total</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={rows} margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
          <XAxis dataKey="payee_short" tick={{ fontSize: 10 }} interval={0} angle={-25} textAnchor="end" height={60} axisLine={false} tickLine={false} />
          <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickFormatter={fmtCompact} axisLine={false} tickLine={false} width={56} />
          <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} tickFormatter={(v) => `${v.toFixed(0)}%`} domain={[0, 100]} axisLine={false} tickLine={false} width={40} />
          <Tooltip content={<Tt />} cursor={{ fill: 'rgba(15, 23, 42, 0.04)' }} />
          <ReferenceLine yAxisId="right" y={80} stroke="#cbd5e1" strokeDasharray="4 4" label={{ value: '80%', position: 'right', fontSize: 9, fill: '#94a3b8' }} />
          <Bar yAxisId="left" dataKey="paid_usd"   stackId="a" fill="#10b981" />
          <Bar yAxisId="left" dataKey="unpaid_usd" stackId="a" fill="#f43f5e" radius={[3, 3, 0, 0]} />
          <Line yAxisId="right" type="monotone" dataKey="cumulative_pct" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3, fill: '#f59e0b', strokeWidth: 0 }} activeDot={{ r: 5 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Payment velocity histogram ─────────────────────────────────────────────
// Days-to-pay distribution. Median in the subhead so the exec knows
// whether "how fast do we pay" is 5 days or 45 days at a glance.
function PaymentVelocitySection({ velocity }) {
  if (!velocity || !Array.isArray(velocity.buckets) || velocity.paid_count === 0) return null
  const buckets = velocity.buckets.map(b => ({
    ...b,
    label: b.bucket === '0' ? 'Same day' : (b.bucket === '60+' ? '60+ days' : `${b.bucket} days`),
  }))
  const median = Number(velocity.median_days) || 0
  const mean = Number(velocity.mean_days) || 0
  const total = buckets.reduce((s, b) => s + b.count, 0)
  // Color late buckets increasingly rose to signal "the tail is bad".
  const colors = ['#10b981', '#22c55e', '#84cc16', '#f59e0b', '#f97316', '#ef4444']
  const Tt = ({ active, payload }) => {
    if (!active || !payload?.length) return null
    const r = payload[0].payload
    const pct = total > 0 ? (r.count / total) * 100 : 0
    return (
      <div className="bg-white border border-rule rounded-lg shadow-md px-3 py-2 text-xs" style={{ minWidth: 180 }}>
        <p className="font-semibold text-gray-900 mb-1">{r.label}</p>
        <div className="flex items-center justify-between gap-3">
          <span className="text-gray-500">Invoices</span>
          <span className="font-semibold tabular-nums text-gray-900">{r.count} ({pct.toFixed(0)}%)</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-gray-500">USD</span>
          <span className="font-semibold tabular-nums text-gray-900">{fmtUsd(r.usd)}</span>
        </div>
      </div>
    )
  }
  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Payment velocity</h2>
          <p className="text-[11px] text-gray-400 mt-0.5">
            Median <span className="font-semibold text-gray-700">{median.toFixed(0)} days</span> · Mean <span className="font-semibold text-gray-700">{mean.toFixed(0)} days</span> across {velocity.paid_count} paid invoices
          </p>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={buckets} margin={{ top: 8, right: 8, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={32} allowDecimals={false} />
          <Tooltip content={<Tt />} cursor={{ fill: 'rgba(15, 23, 42, 0.04)' }} />
          <Bar dataKey="count" radius={[4, 4, 0, 0]}>
            {buckets.map((_, i) => <Cell key={i} fill={colors[i] || '#6b7280'} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Payment method mix ─────────────────────────────────────────────────────
// Compact donut. "Not set" bucket surfaces missing data hygiene.
function PaymentMethodMixSection({ methods }) {
  if (!Array.isArray(methods) || methods.length === 0) return null
  const total = methods.reduce((s, m) => s + Number(m.usd), 0)
  const rows = methods.map(m => ({
    method: m.method,
    usd: Number(m.usd) || 0,
    count: Number(m.count) || 0,
    pct: total > 0 ? (Number(m.usd) / total) * 100 : 0,
  }))
  // Palette mirrors the ledger's METHOD_BADGE tones.
  const methodColor = (m) => ({
    Wire:          '#1e40af',
    ACH:           '#f59e0b',
    PayPal:        '#3730a3',
    Check:         '#6b21a8',
    'Credit Card': '#be185d',
    Cash:          '#065f46',
    'Not set':     '#9ca3af',
  }[m] || '#64748b')
  const Tt = ({ active, payload }) => {
    if (!active || !payload?.length) return null
    const r = payload[0].payload
    return (
      <div className="bg-white border border-rule rounded-lg shadow-md px-3 py-2 text-xs" style={{ minWidth: 180 }}>
        <p className="font-semibold text-gray-900 mb-1">{r.method}</p>
        <div className="flex items-center justify-between gap-3">
          <span className="text-gray-500">USD</span>
          <span className="font-semibold tabular-nums text-gray-900">{fmtUsd(r.usd)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-gray-500">Share</span>
          <span className="font-semibold tabular-nums text-gray-900">{r.pct.toFixed(1)}%</span>
        </div>
        <p className="text-[10px] text-gray-400 pt-1">{r.count} paid invoice{r.count === 1 ? '' : 's'}</p>
      </div>
    )
  }
  return (
    <div className="card p-5">
      <h2 className="text-sm font-bold text-gray-900">Payment method mix</h2>
      <p className="text-[11px] text-gray-400 mt-0.5 mb-3">
        Where the paid dollars flow · {fmtUsd(total)} across {rows.reduce((s, r) => s + r.count, 0)} invoices
      </p>
      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4 items-center">
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie data={rows} dataKey="usd" nameKey="method" innerRadius={55} outerRadius={90} paddingAngle={1} isAnimationActive={false}>
              {rows.map((r, i) => <Cell key={i} fill={methodColor(r.method)} />)}
            </Pie>
            <Tooltip content={<Tt />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="space-y-1.5">
          {rows.map(r => (
            <div key={r.method} className="flex items-center justify-between gap-3 text-xs">
              <span className="inline-flex items-center gap-2 min-w-0">
                <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: methodColor(r.method) }} />
                <span className="font-semibold text-gray-700 truncate">{r.method}</span>
              </span>
              <span className="flex items-baseline gap-2 tabular-nums">
                <span className="text-gray-500 text-[11px]">{r.pct.toFixed(1)}%</span>
                <span className="font-bold text-gray-900">{fmtUsd(r.usd)}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Rep leaderboard ────────────────────────────────────────────────────────
// Horizontal stacked bars — who authorized the spend. "Not assigned"
// gets its own bar as a visible accountability gap.
function RepLeaderboardSection({ reps }) {
  if (!Array.isArray(reps) || reps.length === 0) return null
  const rows = reps.map(r => ({
    rep: r.rep,
    paid_usd: Number(r.paid_usd) || 0,
    unpaid_usd: Number(r.unpaid_usd) || 0,
    total_usd: (Number(r.paid_usd) || 0) + (Number(r.unpaid_usd) || 0),
    invoice_count: Number(r.invoice_count) || 0,
  }))
  const maxTotal = Math.max(...rows.map(r => r.total_usd), 1)
  return (
    <div className="card p-5">
      <h2 className="text-sm font-bold text-gray-900">Spend by rep</h2>
      <p className="text-[11px] text-gray-400 mt-0.5 mb-3">
        Who's authorizing the money moving · top {rows.length} rep{rows.length === 1 ? '' : 's'}
      </p>
      <div className="space-y-2">
        {rows.map(r => {
          const paidPct = (r.paid_usd / maxTotal) * 100
          const unpaidPct = (r.unpaid_usd / maxTotal) * 100
          const isUnassigned = r.rep === 'Not assigned'
          return (
            <div key={r.rep} className="grid grid-cols-[140px_1fr_140px] items-center gap-3 text-xs">
              <span className={`font-semibold truncate ${isUnassigned ? 'text-rose-600' : 'text-gray-700'}`} title={r.rep}>
                {r.rep}
              </span>
              <div className="h-5 bg-gray-100 rounded-md overflow-hidden flex">
                <div className="h-full bg-emerald-500" style={{ width: `${paidPct}%` }} title={`${fmtUsd(r.paid_usd)} paid`} />
                <div className="h-full bg-rose-400" style={{ width: `${unpaidPct}%` }} title={`${fmtUsd(r.unpaid_usd)} unpaid`} />
              </div>
              <div className="text-right tabular-nums">
                <span className="font-bold text-gray-900">{fmtUsd(r.total_usd)}</span>
                <span className="text-gray-400 text-[10px] ml-1">· {r.invoice_count}</span>
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-4 text-[11px] text-gray-500 mt-3 pt-3 border-t border-rule">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-500" /> Paid</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-rose-400" /> Unpaid</span>
      </div>
    </div>
  )
}

// ── Cross-page filter bar ──────────────────────────────────────────────────
// Three chipped dropdowns (Artist / Category / Rep) that scope every
// section on the page. Empty value = "All". A visible "clear all" chip
// appears when anything is set. Options come from /filter-options and
// are refreshed on mount only — the values in the DB change slowly
// enough that a stale option list is fine between page loads.
function FilterBar({ filters, setFilters, options, execFilters }) {
  const setOne = (key) => (e) => setFilters(prev => ({ ...prev, [key]: e.target.value }))
  const clearAll = () => setFilters({ artist: '', category: '', rep: '' })
  const active = filters.artist || filters.category || filters.rep
  return (
    <div data-tour="financials-filters" className="card px-4 py-3 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mr-1">Scope:</span>
      <select
        value={filters.artist}
        onChange={setOne('artist')}
        className="rounded-md border border-rule bg-card px-2 py-1 text-xs font-semibold text-gray-700 max-w-[180px] focus:outline-none focus:ring-1 focus:ring-boom-500"
        title="Filter to a single artist"
      >
        <option value="">All artists</option>
        {(options.artists || []).map(a => <option key={a} value={a}>{a}</option>)}
      </select>
      <select
        value={filters.category}
        onChange={setOne('category')}
        className="rounded-md border border-rule bg-card px-2 py-1 text-xs font-semibold text-gray-700 max-w-[180px] focus:outline-none focus:ring-1 focus:ring-boom-500"
        title="Filter to a single category"
      >
        <option value="">All categories</option>
        {(options.categories || []).map(c => <option key={c} value={c}>{c}</option>)}
      </select>
      <select
        value={filters.rep}
        onChange={setOne('rep')}
        className="rounded-md border border-rule bg-card px-2 py-1 text-xs font-semibold text-gray-700 max-w-[160px] focus:outline-none focus:ring-1 focus:ring-boom-500"
        title="Filter to a single Market Street rep"
      >
        <option value="">All reps</option>
        {(options.reps || []).map(r => <option key={r} value={r}>{r}</option>)}
      </select>
      {active && (
        <>
          <button
            type="button"
            onClick={clearAll}
            className="text-[11px] font-semibold text-rose-600 hover:text-rose-700 underline underline-offset-2"
          >
            Clear
          </button>
          <span className="text-[11px] text-gray-400 ml-auto">
            Every card below is scoped to
            {filters.artist   && <span className="text-gray-700 font-semibold"> {filters.artist}</span>}
            {filters.artist && (filters.category || filters.rep) && <span> ·</span>}
            {filters.category && <span className="text-gray-700 font-semibold"> {filters.category}</span>}
            {filters.category && filters.rep && <span> ·</span>}
            {filters.rep      && <span className="text-gray-700 font-semibold"> {filters.rep}</span>}
          </span>
        </>
      )}
    </div>
  )
}

// ── Cash flow forecast ─────────────────────────────────────────────────────
// Three windows (30 / 60 / 90 days). Each shows Committed (already on
// the books, due in the window) + Projected (extrapolated from the
// trailing 4-week new-invoicing rate). Stacked bars visualize the mix
// so an exec can see at a glance whether the number is mostly firm
// obligations or mostly a rate projection.
function CashForecastSection({ forecast }) {
  if (!forecast) return null
  const weeklyAvg = Number(forecast.weekly_avg_usd) || 0
  const windows = [
    { key: 'in_30', label: 'Next 30 days', accent: 'text-amber-700', bar: 'bg-amber-500', pale: 'bg-amber-200' },
    { key: 'in_60', label: 'Next 60 days', accent: 'text-gray-800',  bar: 'bg-slate-600', pale: 'bg-slate-300' },
    { key: 'in_90', label: 'Next 90 days', accent: 'text-gray-500',  bar: 'bg-slate-500', pale: 'bg-slate-200' },
  ].map(w => {
    const committed = Number(forecast[w.key]?.committed) || 0
    const projected = Number(forecast[w.key]?.projected) || 0
    return { ...w, committed, projected, total: committed + projected }
  })
  const maxTotal = Math.max(...windows.map(w => w.total), 1)
  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Cash forecast</h2>
          <p className="text-[11px] text-gray-400 mt-0.5">
            Committed obligations + projected new invoicing · trailing 4-week rate ≈ <span className="font-semibold text-gray-700">{fmtUsd(weeklyAvg)}/week</span>
          </p>
        </div>
        <div className="text-[11px] text-gray-500">
          <span className="inline-flex items-center gap-1.5 mr-3"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-500" /> Committed (invoiced, due)</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-200" /> Projected (rate × window)</span>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {windows.map(w => {
          const totalPct = (w.total / maxTotal) * 100
          const committedShare = w.total > 0 ? (w.committed / w.total) * 100 : 0
          return (
            <div key={w.key} className="border border-rule rounded-lg p-3.5 bg-gray-50/40">
              <div className="flex items-baseline justify-between mb-1.5">
                <span className={`text-[11px] font-bold uppercase tracking-wider ${w.accent}`}>{w.label}</span>
                <span className="text-[10px] text-gray-400 font-semibold">plan for</span>
              </div>
              <p className="text-xl font-bold text-gray-900 tabular-nums mb-2.5">{fmtUsd(w.total)}</p>
              {/* Length-proportional bar so bigger windows have wider bars */}
              <div className="h-3 bg-gray-100 rounded-full overflow-hidden flex mb-2" style={{ width: `${Math.max(totalPct, 8)}%` }}>
                <div className={`h-full ${w.key === 'in_30' ? 'bg-amber-500' : 'bg-slate-600'} rounded-l-full`} style={{ width: `${committedShare}%` }} />
                <div className={`h-full ${w.key === 'in_30' ? 'bg-amber-200' : 'bg-slate-300'} rounded-r-full`} style={{ width: `${100 - committedShare}%` }} />
              </div>
              <div className="flex items-center justify-between text-[11px] mb-0.5">
                <span className="text-gray-500">Committed</span>
                <span className="font-semibold tabular-nums text-gray-900">{fmtUsd(w.committed)}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-gray-500">+ Projected new</span>
                <span className="font-semibold tabular-nums text-gray-900">{fmtUsd(w.projected)}</span>
              </div>
            </div>
          )
        })}
      </div>
      <p className="text-[10px] text-gray-400 mt-3 pt-3 border-t border-rule">
        Projected assumes new invoicing arrives at the trailing 4-week rate. Treat as a planning aid, not a promise.
      </p>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function Financials() {
  // Route drives the view: /financials → landing dashboard;
  // /financials/month/:month → single-month subpage.
  const { month: routeMonth } = useParams()
  if (routeMonth) return <MonthDetailPage month={routeMonth} />

  return <FinancialsLanding />
}

function FinancialsLanding() {
  const { range, setRange, derived } = useRange()
  const [execData, setExecData] = useState(null)
  const [execLoading, setExecLoading] = useState(true)
  const [dimension, setDimension] = useState('artist')
  const [monthlyData, setMonthlyData] = useState([])
  const [monthlyLoading, setMonthlyLoading] = useState(true)
  const [artistFilter, setArtistFilter] = useState('')
  const [drillBucket, setDrillBucket] = useState(null)
  const [exporting, setExporting] = useState(false)
  // Cross-page filter state. Each of the three (artist / category /
  // rep) scopes every server-side query for the page — including the
  // drill-through modal — so the exec can zoom in on one artist or
  // category without leaving the dashboard.
  const [scopeFilters, setScopeFilters] = useState({ artist: '', category: '', rep: '' })
  const [filterOptions, setFilterOptions] = useState({ artists: [], categories: [], reps: [] })
  // Fetch dropdown options once on mount. Cheap query — one distinct
  // scan of the expenses table, no user-supplied inputs.
  useEffect(() => {
    let cancelled = false
    api.get('/financials/filter-options')
      .then(r => { if (!cancelled) setFilterOptions(r.data?.data || { artists: [], categories: [], reps: [] }) })
      .catch(() => { /* best-effort */ })
    return () => { cancelled = true }
  }, [])
  const doExport = async () => {
    if (exporting) return
    setExporting(true)
    try {
      const qs = new URLSearchParams()
      if (derived.from) qs.set('from', derived.from)
      if (derived.to)   qs.set('to', derived.to)
      // Mirror the on-screen scope filters into the workbook so the
      // exported file matches what the exec was looking at.
      if (scopeFilters.artist)   qs.set('artist',   scopeFilters.artist)
      if (scopeFilters.category) qs.set('category', scopeFilters.category)
      if (scopeFilters.rep)      qs.set('rep',      scopeFilters.rep)
      const res = await api.get(`/financials/export${qs.toString() ? `?${qs}` : ''}`, { responseType: 'blob' })
      const blob = new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const stamp = new Date().toISOString().slice(0, 10)
      a.href = url
      a.download = `marketst-financials-${stamp}.xlsx`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.warn('Financials export:', err?.response?.data?.error || err.message)
    } finally {
      setExporting(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    setExecLoading(true)
    const qs = new URLSearchParams()
    if (derived.from) qs.set('from', derived.from)
    if (derived.to)   qs.set('to', derived.to)
    if (scopeFilters.artist)   qs.set('artist',   scopeFilters.artist)
    if (scopeFilters.category) qs.set('category', scopeFilters.category)
    if (scopeFilters.rep)      qs.set('rep',      scopeFilters.rep)
    api.get(`/financials/exec${qs.toString() ? `?${qs}` : ''}`)
      .then(r => { if (!cancelled) setExecData(r.data?.data || null) })
      .catch(err => console.warn('exec fetch:', err?.response?.data?.error || err.message))
      .finally(() => { if (!cancelled) setExecLoading(false) })
    return () => { cancelled = true }
  }, [derived.from, derived.to, scopeFilters.artist, scopeFilters.category, scopeFilters.rep])

  const [receivedByMonth, setReceivedByMonth] = useState({})
  useEffect(() => {
    let cancelled = false
    setMonthlyLoading(true)
    api.get('/financials/monthly-by-artist', { params: { months: derived.months } })
      .then(r => {
        if (cancelled) return
        setMonthlyData(r.data?.data || [])
        setReceivedByMonth(r.data?.received || {})
      })
      .catch(err => console.warn('monthly fetch:', err?.response?.data?.error || err.message))
      .finally(() => { if (!cancelled) setMonthlyLoading(false) })
    return () => { cancelled = true }
  }, [derived.months])

  const kpi = execData?.kpi
  return (
    <div className="space-y-6">
      <PageHeader tour="financials-header"
        title="Financials"
        subtitle="Executive spend view — paid, unpaid, and intake across every artist / song / category."
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <RangePicker range={range} setRange={setRange} derived={derived} />
            <button
              onClick={doExport}
              disabled={exporting}
              className="btn-secondary text-xs gap-1.5 inline-flex items-center disabled:opacity-60"
              title={exporting ? 'Building workbook…' : 'Multi-sheet Excel dump of the current range'}
            >
              {exporting
                ? <Loader size={13} className="animate-spin" />
                : <Download size={13} />}
              {exporting ? 'Building…' : 'Export Excel'}
            </button>
          </div>
        }
      />

      {/* Reporting basis. Financials and Reports deliberately answer different
          questions and WILL show different totals for the same range — this
          says so out loud rather than leaving someone to discover it while
          reconciling two numbers that were never meant to agree.
            Financials: COALESCE(payment_date, invoice_date), unpaid included.
            Reports P&L: strictly Paid, bucketed by payment_date, plus bank
            transactions not yet booked. */}
      <div className="flex flex-wrap items-center gap-2 -mt-3 text-[12px] text-gray-500">
        <span className="font-semibold text-gray-400 uppercase tracking-wider text-[10px]">Basis</span>
        <span>
          Commitment view — every approved invoice counts from its payment date, or its
          invoice date if unpaid. <strong className="font-semibold text-ink">Unpaid spend is included.</strong>
        </span>
        <Link to="/reports?basis=accrual" className="text-boom-600 hover:text-boom-700 font-semibold whitespace-nowrap">
          Reports carries this basis too: open Reports on accrual →
        </Link>
        <ReconciledBadge className="ml-auto" />
      </div>

      {/* KPI cards — fixed points-in-time, range-picker-independent.
          These are always current: This Week / MTD / YTD / Unpaid. */}
      <div data-tour="financials-kpis" className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {execLoading && !kpi ? (
          [0,1,2,3].map(i => <div key={i} className="card h-24 animate-pulse bg-gray-50" />)
        ) : kpi ? (
          <>
            {/* Each sparkline traces the shape of the KPI it sits under
                — not the same trailing-paid curve stamped four times.
                • This Week / MTD: per-week paid cash-out trend
                • YTD: cumulative paid across the trailing window (a
                  monotonically-increasing curve, matching the meaning
                  of "year-to-date")
                • Unpaid Pipeline: running open balance across each
                  week's end (cumulative received − cumulative paid),
                  which is what the number on the card actually
                  measures. */}
            {(() => {
              const wk = execData?.weeks || []
              const trailing = wk.slice(-8)
              // Running totals across the trailing window so YTD and
              // Unpaid Pipeline reflect cumulative shape.
              let paidCum = 0, receivedCum = 0
              const cumulative = trailing.map(w => {
                paidCum     += Number(w.paid_usd)     || 0
                receivedCum += (Number(w.paid_usd) || 0) + (Number(w.unpaid_usd) || 0)
                return { paidCum, openBal: receivedCum - paidCum }
              })
              return (
                <>
                  <KpiCard
                    label="This Week"
                    value={fmtUsd(kpi.this_week)}
                    delta={<DeltaChip current={kpi.this_week} prior={kpi.last_week} />}
                    sub={`vs ${fmtUsd(kpi.last_week)} last week (same days elapsed)`}
                    sparkline={trailing.map(w => Number(w.paid_usd) || 0)}
                    sparkColor="#10b981"
                    onClick={() => setDrillBucket('this_week')}
                  />
                  <KpiCard
                    label="Month-to-Date"
                    value={fmtUsd(kpi.mtd)}
                    delta={<DeltaChip current={kpi.mtd} prior={kpi.last_mtd} />}
                    sub={`vs ${fmtUsd(kpi.last_mtd)} same-day last month`}
                    sparkline={trailing.map(w => Number(w.paid_usd) || 0)}
                    sparkColor="#10b981"
                    onClick={() => setDrillBucket('mtd')}
                  />
                  <KpiCard
                    label="Year-to-Date"
                    value={fmtUsd(kpi.ytd)}
                    delta={<DeltaChip current={kpi.ytd} prior={kpi.last_ytd} />}
                    // Suppress the comparison line when there's no
                    // prior-year data — showing "vs $0" implies a
                    // meaningful base that doesn't exist.
                    sub={Number(kpi.last_ytd) > 0
                      ? `vs ${fmtUsd(kpi.last_ytd)} same-period last year`
                      : 'no prior-year data to compare against'}
                    sparkline={cumulative.map(x => x.paidCum)}
                    sparkColor="#6366f1"
                    onClick={() => setDrillBucket('ytd')}
                  />
                  <KpiCard
                    label="Unpaid Pipeline"
                    value={fmtUsd(kpi.unpaid_total)}
                    sub={`${kpi.unpaid_count} invoice${kpi.unpaid_count === 1 ? '' : 's'} outstanding`}
                    sparkline={cumulative.map(x => x.openBal)}
                    sparkColor="#f43f5e"
                    onClick={() => setDrillBucket('unpaid')}
                  />
                </>
              )
            })()}
          </>
        ) : (
          <div className="col-span-4 card p-6 text-center text-sm text-gray-500">
            Failed to load financial summary.
          </div>
        )}
      </div>

      {/* Cross-page scope filter — every section below respects the
          artist / category / rep selection. Placed here (below KPIs,
          above the chart) so it reads like a query builder for the
          dashboard, not a nav element. */}
      <FilterBar
        filters={scopeFilters}
        setFilters={setScopeFilters}
        options={filterOptions}
      />

      {/* Weekly chart — scoped to the range picker. */}
      {execLoading && !execData ? (
        <div className="card h-72 animate-pulse bg-gray-50" />
      ) : execData?.weeks?.length ? (
        <WeeklyChart weeks={execData.weeks} />
      ) : null}

      {/* Aging + upcoming due — cash-flow visibility. */}
      {execData?.aging && execData?.upcoming && (
        <PaymentAgingSection aging={execData.aging} upcoming={execData.upcoming} onDrill={setDrillBucket} />
      )}

      {/* Cash forecast — 30/60/90 day committed + projected. Sits
          under aging because it's the natural next question after
          "who's past due?" → "so how much cash do I need to plan for?". */}
      {execData?.forecast && (
        <CashForecastSection forecast={execData.forecast} />
      )}

      {/* Monthly rollup — scoped to the range picker's month count. */}
      <MonthlyRollup
        rows={monthlyData}
        loading={monthlyLoading}
        artistFilter={artistFilter}
        onArtistFilterChange={setArtistFilter}
        receivedByMonth={receivedByMonth}
      />

      {/* Breakdown — scoped to the range picker. Passes range +
          scope filters through so By-Artist / By-Song rows can
          lazy-fetch their category sub-breakdown scoped to the
          same window the user is viewing. */}
      {execData?.breakdowns && (
        <BreakdownSection
          breakdowns={execData.breakdowns}
          dimension={dimension}
          onDimensionChange={setDimension}
          scopeFilters={scopeFilters}
          range={{ from: derived.from, to: derived.to }}
        />
      )}

      {/* Spend by rep — accountability leaderboard. */}
      {execData?.reps?.length > 0 && (
        <RepLeaderboardSection reps={execData.reps} />
      )}

      {/* Category composition trend — swapped to the bottom so the
          exec view leads with the by-month breakdown before drilling
          into how categories move over time. */}
      {execData?.category_trend?.months?.length > 0 && (
        <CategoryTrendSection trend={execData.category_trend} />
      )}

      <p className="text-[11px] text-gray-400 text-center pt-2">
        USD-equivalent throughout. Split children roll into their parent so a co-brand invoice split N ways doesn't multi-count.
      </p>

      {drillBucket && (
        <KpiDrillModal
          bucket={drillBucket}
          scopeFilters={scopeFilters}
          onClose={() => setDrillBucket(null)}
        />
      )}
    </div>
  )
}

// ── KPI drill-down modal ───────────────────────────────────────────────────
// Lazy-fetches the invoices behind a KPI card (This Week / MTD / YTD /
// Unpaid) via GET /financials/exec/rows?bucket=…. Total footer matches
// the KPI card's number to the dollar since the window logic is
// mirrored server-side.
const BUCKET_META = {
  this_week:     { title: 'This week — paid invoices',           blurb: 'Paid Mon-today, LA week' },
  last_week:     { title: 'Last week — paid invoices',           blurb: 'Paid Mon-Sun, one week back' },
  mtd:           { title: 'Month-to-date — paid invoices',       blurb: 'Paid so far this LA month' },
  last_mtd:      { title: 'Last month — paid invoices',          blurb: 'Same-day-of-month range, last month' },
  ytd:           { title: 'Year-to-date — paid invoices',        blurb: 'Paid so far this LA year' },
  last_ytd:      { title: 'Last year — paid invoices',           blurb: 'Same period, last year' },
  unpaid:        { title: 'Unpaid pipeline',                     blurb: 'Every outstanding invoice, largest first' },
  // Payment aging drill-downs — invoice-anchored due date.
  aging_0_30:    { title: '0-30 days past due',                  blurb: 'Unpaid, 1-30 days past invoice-anchored due date' },
  aging_30_60:   { title: '30-60 days past due',                 blurb: 'Unpaid, 31-60 days past due' },
  aging_60_90:   { title: '60-90 days past due',                 blurb: 'Unpaid, 61-90 days past due' },
  aging_90_plus: { title: '90+ days past due',                   blurb: 'Unpaid, more than 90 days past due — escalate' },
  // Upcoming cash-call windows.
  upcoming_7:    { title: 'Due in the next 7 days',              blurb: 'Unpaid, due within the next week — near-term cash call' },
  upcoming_30:   { title: 'Due in the next 30 days',             blurb: 'Unpaid, due within the next month' },
  upcoming_60:   { title: 'Due in the next 60 days',             blurb: 'Unpaid, due within the next two months' },
}
function KpiDrillModal({ bucket, scopeFilters, onClose }) {
  const [payload, setPayload] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const filterArtist   = scopeFilters?.artist || ''
  const filterCategory = scopeFilters?.category || ''
  const filterRep      = scopeFilters?.rep || ''
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    const qs = new URLSearchParams({ bucket })
    if (filterArtist)   qs.set('artist',   filterArtist)
    if (filterCategory) qs.set('category', filterCategory)
    if (filterRep)      qs.set('rep',      filterRep)
    api.get(`/financials/exec/rows?${qs}`)
      .then(r => { if (!cancelled) setPayload(r.data?.data || null) })
      .catch(err => {
        if (cancelled) return
        setError(err?.response?.data?.error || err.message || 'Failed to load rows')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bucket, filterArtist, filterCategory, filterRep])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  const meta = BUCKET_META[bucket] || { title: bucket, blurb: '' }
  const rows = payload?.rows || []
  const rangeText = payload?.from && payload?.to ? `${payload.from} → ${payload.to}` : (payload?.paid_only === false ? 'All outstanding' : '')
  return (
    <div data-tour="financials-page"
      className="fixed inset-0 z-50 flex items-start justify-center bg-overlay p-4 overflow-y-auto"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-card rounded-xl shadow-xl border border-rule w-full max-w-4xl my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 py-4 border-b border-rule">
          <div>
            <h3 className="text-sm font-bold text-gray-900">{meta.title}</h3>
            <p className="text-[11px] text-gray-500 mt-0.5">{meta.blurb}{rangeText ? ` · ${rangeText}` : ''}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>
        <div className="px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-500">
              <Loader size={14} className="animate-spin" /> Loading invoices…
            </div>
          ) : error ? (
            <p className="text-sm text-rose-700 text-center py-8">{error}</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No invoices in this window.</p>
          ) : (
            <>
              <div className="overflow-x-auto max-h-[60vh]">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-b border-rule text-[10px] uppercase tracking-wider text-gray-400">
                      <th className="text-left  font-semibold py-2">Date</th>
                      <th className="text-left  font-semibold py-2">Vendor</th>
                      <th className="text-left  font-semibold py-2">Artist</th>
                      <th className="text-left  font-semibold py-2">Category</th>
                      <th className="text-right font-semibold py-2">Amount</th>
                      {(bucket === 'unpaid' || bucket.startsWith('aging_')) && <th className="text-right font-semibold py-2">Overdue</th>}
                      {bucket.startsWith('upcoming_') && <th className="text-right font-semibold py-2">Due in</th>}
                      <th className="text-left  font-semibold py-2 pl-3">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(inv => (
                      <tr key={inv.id} className="border-b border-divider hover:bg-gray-50/40">
                        <td className="py-2 text-gray-500 tabular-nums whitespace-nowrap">{inv.invoice_date ? String(inv.invoice_date).slice(0, 10) : '—'}</td>
                        <td className="py-2 font-semibold text-gray-800 truncate max-w-[220px]" title={inv.payee}>{inv.payee || '—'}</td>
                        <td className="py-2 text-gray-600 truncate max-w-[160px]" title={inv.artist}>{inv.artist || '—'}</td>
                        <td className="py-2 text-gray-500 truncate max-w-[140px]">{inv.category || '—'}</td>
                        <td className="py-2 text-right font-bold tabular-nums text-gray-900">{fmtUsd(inv.amount_usd)}</td>
                        {(bucket === 'unpaid' || bucket.startsWith('aging_')) && (
                          <td className={`py-2 text-right tabular-nums ${(inv.days_overdue || 0) > 30 ? 'text-rose-600 font-bold' : 'text-gray-500'}`}>
                            {(inv.days_overdue || 0) > 0 ? `${inv.days_overdue}d` : '—'}
                          </td>
                        )}
                        {bucket.startsWith('upcoming_') && (
                          <td className={`py-2 text-right tabular-nums ${(inv.days_until_due || 0) <= 7 ? 'text-amber-700 font-bold' : 'text-gray-500'}`}>
                            {inv.days_until_due != null ? `${inv.days_until_due}d` : '—'}
                          </td>
                        )}
                        <td className="py-2 pl-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ring-1 ${
                            inv.payment_status === 'Paid'
                              ? 'bg-emerald-50 ring-emerald-200/60 text-emerald-700'
                              : 'bg-rose-50 ring-rose-200/60 text-rose-700'
                          }`}>
                            {inv.payment_status || 'Unpaid'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between mt-3 pt-3 border-t border-rule text-xs">
                <span className="text-gray-500">
                  {payload.row_count} invoice{payload.row_count === 1 ? '' : 's'}
                  {payload.row_count === 200 && <span className="text-amber-600"> · capped at 200</span>}
                </span>
                <span className="font-bold tabular-nums text-gray-900">
                  Total: {fmtUsd(payload.total_usd)}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// Month-detail stat card + prior-month delta chip. Kept above
// MonthDetailPage so they're colocated with the only caller.
function MonthStatCard({ label, value, valueClass = 'text-gray-900', sub, delta }) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">{label}</p>
        {delta}
      </div>
      <p className={`text-2xl font-bold tabular-nums mt-1.5 ${valueClass}`}>{value}</p>
      <div className="text-[11px] text-gray-400 mt-1.5">{sub}</div>
    </div>
  )
}
// `invert=true` reverses the color semantics — used for "Unpaid",
// where a rise vs prior month is BAD (rose), not good (emerald).
function MonthDelta({ current, prior, priorLabel, invert = false }) {
  const c = Number(current) || 0
  const p = Number(prior) || 0
  if (p <= 0) return null   // no prior data → no honest comparison
  const pct = ((c - p) / p) * 100
  if (!Number.isFinite(pct)) return null
  const up = pct >= 0
  const good = invert ? !up : up
  return (
    <span
      className={`text-[10px] font-bold tabular-nums px-1.5 py-0.5 rounded ${good ? 'text-emerald-700 bg-emerald-50' : 'text-rose-700 bg-rose-50'}`}
      title={`vs ${priorLabel}`}
    >
      {up ? '↑' : '↓'} {Math.abs(pct).toFixed(0)}%
    </span>
  )
}

// ── Month detail subpage ───────────────────────────────────────────────────
// /financials/month/:month — one month at a glance. Header with month
// navigation, stat cards with prior-month deltas, daily activity chart,
// per-artist table (searchable + sortable), per-category shares, top
// vendors, and the biggest invoices from that month.
function MonthDetailPage({ month }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [artistSearch, setArtistSearch] = useState('')
  const [artistSort, setArtistSort] = useState({ key: 'total_usd', dir: 'desc' })
  // Expansion state for the By-artist table — mirrors the Top spend
  // section's pattern so a rep can click an artist row and see the
  // categories that make up their spend for the month.
  const [expanded, setExpanded] = useState(() => new Set())
  const [subCache, setSubCache] = useState({}) // { artistName: {loading, error, categories} }
  const [showAllCats, setShowAllCats] = useState(() => new Set())
  const CATEGORY_MIN_SHARE = 1 // % — near-zero categories fold into "N more"

  // Month range as YYYY-MM-DD bookends — passed to /exec/subbreakdown
  // so the category slice is scoped to just this month.
  const monthRange = (() => {
    if (!/^\d{4}-\d{2}$/.test(month || '')) return { from: null, to: null }
    const [y, m] = month.split('-').map(Number)
    const from = `${month}-01`
    // Last day of month via new Date(y, m, 0)
    const lastDay = new Date(y, m, 0).getDate()
    const to = `${month}-${String(lastDay).padStart(2, '0')}`
    return { from, to }
  })()

  const loadSub = async (artistName) => {
    if (subCache[artistName] && (subCache[artistName].categories || subCache[artistName].error)) return
    setSubCache(c => ({ ...c, [artistName]: { loading: true } }))
    try {
      const qs = new URLSearchParams({ dimension: 'artist', value: artistName })
      if (monthRange.from) qs.set('from', monthRange.from)
      if (monthRange.to)   qs.set('to',   monthRange.to)
      const r = await api.get(`/financials/exec/subbreakdown?${qs}`)
      const cats = r.data?.data?.categories || []
      setSubCache(c => ({ ...c, [artistName]: { loading: false, categories: cats } }))
    } catch (err) {
      setSubCache(c => ({ ...c, [artistName]: { loading: false, error: err?.response?.data?.error || err.message || 'Failed to load' } }))
    }
  }
  const toggleExpand = (artistName) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(artistName)) { next.delete(artistName); return next }
      next.add(artistName)
      loadSub(artistName)
      return next
    })
  }
  // Reset on month change — different month, different fetches.
  useEffect(() => { setExpanded(new Set()); setSubCache({}); setShowAllCats(new Set()) }, [month])
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api.get(`/financials/month/${encodeURIComponent(month)}`)
      .then(r => { if (!cancelled) setData(r.data?.data || null) })
      .catch(err => {
        if (cancelled) return
        setError(err?.response?.data?.error || err.message || 'Failed to load month')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [month])

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <BackLink to="/financials" label="Financials" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[0,1,2,3].map(i => <div key={i} className="card h-24 animate-pulse bg-gray-50" />)}
        </div>
        <div className="card h-64 animate-pulse bg-gray-50" />
      </div>
    )
  }
  if (error || !data) {
    return (
      <div className="space-y-4">
        <BackLink to="/financials" label="Financials" />
        <div className="card p-12 text-center">
          <p className="text-sm text-gray-500">{error || 'Failed to load month.'}</p>
        </div>
      </div>
    )
  }

  const s = data.summary
  const prev = data.prev_summary || {}
  const total = s.total_usd || 0
  const paidPct = total > 0 ? (s.paid_usd / total) * 100 : 0
  const catTotal = (data.categories || []).reduce((sum, c) => sum + (Number(c.total_usd) || 0), 0)

  // Filter + sort the artist list client-side. Cheap — even a busy
  // month has <100 artists.
  const filteredArtists = (data.artists || [])
    .filter(a => {
      if (!artistSearch.trim()) return true
      const q = artistSearch.trim().toLowerCase()
      const label = (a.artist && a.artist.trim()) ? a.artist : 'Unassigned'
      return label.toLowerCase().includes(q)
    })
    .slice()
    .sort((a, b) => {
      const k = artistSort.key
      const av = k === 'artist' ? ((a.artist || 'Unassigned').toLowerCase()) : (Number(a[k]) || 0)
      const bv = k === 'artist' ? ((b.artist || 'Unassigned').toLowerCase()) : (Number(b[k]) || 0)
      if (av < bv) return artistSort.dir === 'asc' ? -1 : 1
      if (av > bv) return artistSort.dir === 'asc' ? 1 : -1
      return 0
    })
  const toggleSort = (key) => {
    setArtistSort(prev => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'artist' ? 'asc' : 'desc' })
  }
  const SortHeader = ({ label, sortKey, align = 'right' }) => (
    <button
      type="button"
      onClick={() => toggleSort(sortKey)}
      className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold ${artistSort.key === sortKey ? 'text-gray-700' : 'text-gray-400 hover:text-gray-600'}`}
      title={`Sort by ${label}`}
    >
      {label}
      <ArrowUpDown size={10} className={artistSort.key === sortKey ? 'text-gray-500' : 'text-gray-300'} />
      {artistSort.key === sortKey && <span className="text-[9px] text-gray-400">{artistSort.dir === 'asc' ? '↑' : '↓'}</span>}
    </button>
  )

  // Daily chart data — pre-fill even for months with no activity so
  // the x-axis spans the whole month regardless.
  const daily = (data.daily || []).map(d => ({
    day: d.day_of_month,
    label: `${data.month_label.split(' ')[0].slice(0, 3)} ${d.day_of_month}`,
    paid: Number(d.paid_usd) || 0,
    unpaid: Number(d.unpaid_usd) || 0,
    total: (Number(d.paid_usd) || 0) + (Number(d.unpaid_usd) || 0),
    count: Number(d.count) || 0,
  }))

  return (
    <div className="space-y-6" data-tour="financials-month-page">
      <BackLink to="/financials" label="Financials" />
      {/* Header with prev/next month navigation. Keyboard-accessible
          via native <Link> semantics; the arrows also carry the
          previous / next month's label as a tooltip so the exec
          knows where they'll land before clicking. */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Link
              to={`/financials/month/${data.prev_month}`}
              title={data.prev_month_label}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-rule text-xs font-semibold text-gray-600 hover:text-gray-900 hover:border-gray-400 transition-colors"
            >
              <ChevronLeft size={14} />
              {data.prev_month_label}
            </Link>
            <Link
              to={`/financials/month/${data.next_month}`}
              title={data.next_month_label}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-rule text-xs font-semibold text-gray-600 hover:text-gray-900 hover:border-gray-400 transition-colors"
            >
              {data.next_month_label}
              <ChevronRight size={14} />
            </Link>
          </div>
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight">{data.month_label}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {s.total_count} invoice{s.total_count === 1 ? '' : 's'} across {s.artist_count} artist{s.artist_count === 1 ? '' : 's'} and {s.vendor_count} vendor{s.vendor_count === 1 ? '' : 's'}.
          </p>
        </div>
      </div>

      {/* Stat cards — with delta chips vs prior month. Suppress delta
          when prior month is $0 (avoids "vs $0 → +∞%"). */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MonthStatCard
          label="Total This Month"
          value={fmtUsd(total)}
          sub={`${s.total_count} invoice${s.total_count === 1 ? '' : 's'}`}
          delta={<MonthDelta current={total} prior={Number(prev.total_usd) || 0} priorLabel={data.prev_month_label} />}
        />
        <MonthStatCard
          label="Paid"
          value={fmtUsd(s.paid_usd)}
          valueClass="text-emerald-700"
          sub={<span><span className="text-emerald-600 font-bold">{paidPct.toFixed(0)}%</span> · {s.paid_count} paid</span>}
          delta={<MonthDelta current={s.paid_usd} prior={Number(prev.paid_usd) || 0} priorLabel={data.prev_month_label} />}
        />
        <MonthStatCard
          label="Unpaid"
          value={fmtUsd(s.unpaid_usd)}
          valueClass="text-rose-700"
          sub={`${s.unpaid_count} outstanding`}
          delta={<MonthDelta current={s.unpaid_usd} prior={Number(prev.unpaid_usd) || 0} priorLabel={data.prev_month_label} invert />}
        />
        <MonthStatCard
          label="Received (Intake)"
          value={fmtUsd(s.received_usd)}
          valueClass="text-sky-700"
          sub={`${s.received_count} invoice${s.received_count === 1 ? '' : 's'} submitted`}
          delta={<MonthDelta current={s.received_usd} prior={Number(prev.received_usd) || 0} priorLabel={data.prev_month_label} />}
        />
      </div>

      {/* Daily activity chart — one bar per day of the month, stacked
          paid + unpaid. Gives shape to WHEN the money moved. */}
      {daily.length > 0 && (
        <div className="card p-5">
          <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
            <div>
              <h2 className="text-sm font-bold text-gray-900">Daily activity</h2>
              <p className="text-[11px] text-gray-400 mt-0.5">Paid + unpaid dollars per day · {daily.length} days shown</p>
            </div>
            <div className="text-[11px] text-gray-500">
              <span className="inline-flex items-center gap-1.5 mr-3"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-500" /> Paid</span>
              <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-rose-400" /> Unpaid</span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={daily} margin={{ top: 4, right: 8, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 10 }} interval={4} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtCompact} axisLine={false} tickLine={false} width={52} />
              <Tooltip
                cursor={{ fill: 'rgba(15, 23, 42, 0.04)' }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const r = payload[0].payload
                  return (
                    <div className="bg-white border border-rule rounded-lg shadow-md px-3 py-2 text-xs" style={{ minWidth: 160 }}>
                      <p className="font-semibold text-gray-900 mb-1">{r.label}</p>
                      <div className="flex items-center justify-between gap-3"><span className="text-gray-500"><span className="inline-block w-2 h-2 rounded-sm bg-emerald-500 mr-1" />Paid</span><span className="font-semibold tabular-nums text-gray-900">{fmtUsd(r.paid)}</span></div>
                      <div className="flex items-center justify-between gap-3"><span className="text-gray-500"><span className="inline-block w-2 h-2 rounded-sm bg-rose-400 mr-1" />Unpaid</span><span className="font-semibold tabular-nums text-gray-900">{fmtUsd(r.unpaid)}</span></div>
                      <div className="flex items-center justify-between gap-3 pt-1 border-t border-rule"><span className="text-gray-700 font-semibold">Total</span><span className="font-bold tabular-nums text-gray-900">{fmtUsd(r.total)}</span></div>
                      <p className="text-[10px] text-gray-400 pt-1">{r.count} invoice{r.count === 1 ? '' : 's'}</p>
                    </div>
                  )
                }}
              />
              <Bar dataKey="paid"   stackId="a" fill="#10b981" />
              <Bar dataKey="unpaid" stackId="a" fill="#f43f5e" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Per-artist table — with search + sortable columns */}
      <div className="card p-5">
        <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
          <div>
            <h2 className="text-sm font-bold text-gray-900">By artist</h2>
            <p className="text-[11px] text-gray-400 mt-0.5">{filteredArtists.length} of {(data.artists || []).length} artist{(data.artists || []).length === 1 ? '' : 's'} · avg invoice {fmtUsd(s.avg_invoice_usd)}</p>
          </div>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={artistSearch}
              onChange={e => setArtistSearch(e.target.value)}
              placeholder="Search artist…"
              className="pl-7 pr-2 py-1 text-xs rounded-md border border-rule bg-card focus:outline-none focus:ring-1 focus:ring-boom-500 w-48"
            />
          </div>
        </div>
        {(data.artists || []).length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">No spend this month.</p>
        ) : filteredArtists.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">No artist matches "{artistSearch}".</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-rule">
                  <th className="text-left py-2 text-[10px] uppercase tracking-wider font-semibold text-gray-400">#</th>
                  <th className="text-left py-2"><SortHeader label="Artist" sortKey="artist" align="left" /></th>
                  <th className="text-left py-2 pl-2 text-[10px] uppercase tracking-wider font-semibold text-gray-400">Share</th>
                  <th className="text-right py-2"><SortHeader label="Paid"   sortKey="paid_usd"   /></th>
                  <th className="text-right py-2"><SortHeader label="Unpaid" sortKey="unpaid_usd" /></th>
                  <th className="text-right py-2"><SortHeader label="Total"  sortKey="total_usd"  /></th>
                  <th className="text-right py-2"><SortHeader label="Rows"   sortKey="count"      /></th>
                </tr>
              </thead>
              <tbody>
                {filteredArtists.map((a, i) => {
                  const artistTotal = Number(a.total_usd) || 0
                  const share = total > 0 ? (artistTotal / total) * 100 : 0
                  const artistLabel = a.artist && a.artist.trim() ? a.artist : 'Unassigned'
                  const isOpen = expanded.has(artistLabel)
                  const sub = subCache[artistLabel]
                  return (
                    <Fragment key={`${a.artist}-${i}`}>
                      <tr
                        className={`border-b border-divider ${isOpen ? 'bg-gray-50/60' : 'hover:bg-gray-50/40'} cursor-pointer`}
                        onClick={() => toggleExpand(artistLabel)}
                      >
                        <td className="py-2 text-gray-400 font-bold tabular-nums w-6">
                          <div className="flex items-center gap-1">
                            <ChevronRight
                              size={11}
                              className={`shrink-0 text-gray-400 transition-transform ${isOpen ? 'rotate-90 text-boom-500' : ''}`}
                            />
                            <span>{i + 1}</span>
                          </div>
                        </td>
                        <td className="py-2 font-semibold text-gray-800 truncate max-w-[220px]">
                          <Link
                            to={`/artist-campaigns/${encodeURIComponent(artistLabel)}`}
                            onClick={e => e.stopPropagation()}
                            className="hover:text-boom-700"
                          >
                            {artistLabel}
                          </Link>
                        </td>
                        <td className="py-2 pl-2 w-[30%]">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                              <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${Math.max(share, 1)}%` }} />
                            </div>
                            <span className="text-[11px] font-semibold tabular-nums w-10 text-right text-gray-600">{share.toFixed(0)}%</span>
                          </div>
                        </td>
                        <td className="py-2 text-right tabular-nums text-emerald-700">{fmtUsd(a.paid_usd)}</td>
                        <td className="py-2 text-right tabular-nums text-rose-700">{fmtUsd(a.unpaid_usd)}</td>
                        <td className="py-2 text-right font-bold tabular-nums text-gray-900">{fmtUsd(a.total_usd)}</td>
                        <td className="py-2 text-right tabular-nums text-gray-400">{a.count}</td>
                      </tr>
                      {/* Category breakdown row — spans the whole table
                          when expanded. Uses the same stacked-strip +
                          "N more < 1%" pattern the Top-spend section
                          uses so the two views are visually consistent. */}
                      {isOpen && (
                        <tr className="border-b border-divider bg-gray-50/60">
                          <td colSpan={7} className="px-4 py-3">
                            {sub?.loading ? (
                              <div className="flex items-center gap-2 text-[11px] text-gray-500">
                                <Loader size={11} className="animate-spin" /> Loading category breakdown for {artistLabel}…
                              </div>
                            ) : sub?.error ? (
                              <p className="text-[11px] text-rose-600">Couldn't load: {sub.error}</p>
                            ) : !sub?.categories?.length ? (
                              <p className="text-[11px] text-gray-500">No categorized spend for {artistLabel} this month.</p>
                            ) : (() => {
                              const cats = sub.categories.map(c => {
                                const cPaid = Number(c.paid_usd) || 0
                                const cUnpaid = Number(c.unpaid_usd) || 0
                                const cTotal = cPaid + cUnpaid
                                const cShare = artistTotal > 0 ? (cTotal / artistTotal) * 100 : 0
                                return { ...c, cPaid, cUnpaid, cTotal, cShare }
                              })
                              const bigCats   = cats.filter(c => c.cShare >= CATEGORY_MIN_SHARE)
                              const smallCats = cats.filter(c => c.cShare < CATEGORY_MIN_SHARE)
                              const isShowAll = showAllCats.has(artistLabel)
                              const visible   = isShowAll ? cats : bigCats
                              const smallTotal  = smallCats.reduce((s, c) => s + c.cTotal, 0)
                              const smallPaid   = smallCats.reduce((s, c) => s + c.cPaid, 0)
                              const smallUnpaid = smallCats.reduce((s, c) => s + c.cUnpaid, 0)
                              const smallShare  = artistTotal > 0 ? (smallTotal / artistTotal) * 100 : 0
                              // Same muted palette Top-spend uses so
                              // category colors read consistently across
                              // the two sections.
                              const CAT_COLORS = [
                                '#34d399', '#38bdf8', '#a78bfa', '#fbbf24',
                                '#2dd4bf', '#818cf8', '#f472b6', '#a3e635',
                                '#22d3ee', '#fb7185', '#c084fc', '#facc15',
                              ]
                              const colorFor = (i) => CAT_COLORS[i % CAT_COLORS.length]
                              return (
                                <div>
                                  <div className="flex items-center gap-2 mb-2">
                                    <span className="text-[9px] uppercase tracking-wider font-bold text-gray-500">
                                      Mix inside <span className="text-gray-700">{artistLabel}</span>
                                    </span>
                                  </div>
                                  {/* Stacked strip — one segment per
                                      visible category (small ones fold
                                      into a trailing gray sliver). */}
                                  <div className="flex h-5 rounded overflow-hidden bg-gray-100 mb-3">
                                    {cats.map((c, ci) => (
                                      <div
                                        key={c.category}
                                        style={{ width: `${c.cShare}%`, background: colorFor(ci), minWidth: c.cShare > 0 ? 2 : 0 }}
                                        title={`${c.category} · ${c.cShare.toFixed(1)}% · ${fmtUsd(c.cTotal)}`}
                                      />
                                    ))}
                                  </div>
                                  {/* Per-category rows */}
                                  <div className="space-y-1">
                                    {visible.map((c, ci) => {
                                      const catIndex = cats.findIndex(x => x.category === c.category)
                                      return (
                                        <div key={c.category} className="flex items-center gap-3 text-[11px]">
                                          <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: colorFor(catIndex) }} />
                                          <span className="w-40 shrink-0 font-semibold text-gray-700 truncate" title={c.category}>{c.category}</span>
                                          <div className="flex-1" />
                                          <span className="w-10 text-right tabular-nums text-gray-500 font-semibold">{c.cShare.toFixed(0)}%</span>
                                          <span className="w-24 text-right font-bold tabular-nums text-emerald-700">{fmtUsd(c.cPaid)}</span>
                                          <span className="w-24 text-right tabular-nums text-rose-700">{c.cUnpaid > 0 ? `+${fmtCompact(c.cUnpaid)} owed` : '—'}</span>
                                          <span className="w-14 text-right tabular-nums text-gray-400">{c.row_count} row{c.row_count === 1 ? '' : 's'}</span>
                                        </div>
                                      )
                                    })}
                                    {!isShowAll && smallCats.length > 0 && (
                                      <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); setShowAllCats(prev => new Set(prev).add(artistLabel)) }}
                                        className="flex items-center gap-3 text-[11px] w-full text-left hover:bg-gray-100/70 rounded px-1 -mx-1 py-0.5 transition-colors"
                                        title="Show all categories, including near-zero ones"
                                      >
                                        <span className="inline-block w-2 h-2 rounded-sm shrink-0 bg-gray-300" />
                                        <span className="w-40 shrink-0 text-gray-500 italic truncate">+ {smallCats.length} more &lt; 1% · click to show</span>
                                        <div className="flex-1" />
                                        <span className="w-10 text-right tabular-nums text-gray-400">{smallShare.toFixed(0)}%</span>
                                        <span className="w-24 text-right tabular-nums text-emerald-700">{fmtUsd(smallPaid)}</span>
                                        <span className="w-24 text-right tabular-nums text-rose-600">{smallUnpaid > 0 ? `+${fmtCompact(smallUnpaid)} owed` : '—'}</span>
                                        <span className="w-14 text-right tabular-nums text-gray-400">—</span>
                                      </button>
                                    )}
                                  </div>
                                </div>
                              )
                            })()}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Two-column: categories + top vendors */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card p-5">
          <h2 className="text-sm font-bold text-gray-900 mb-3">By category</h2>
          {(data.categories || []).length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">No categorized spend.</p>
          ) : (
            <div className="space-y-1.5">
              {data.categories.map(c => {
                const cTotal = Number(c.total_usd) || 0
                const pct = catTotal > 0 ? (cTotal / catTotal) * 100 : 0
                return (
                  <div key={c.category} className="flex items-center gap-3 text-xs">
                    <span className="w-32 shrink-0 font-semibold text-gray-700 truncate" title={c.category}>{c.category}</span>
                    <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full bg-boom-500 rounded-full" style={{ width: `${Math.max(pct, 1)}%` }} />
                    </div>
                    <span className="w-10 text-right text-[11px] tabular-nums text-gray-500 font-semibold">{pct.toFixed(0)}%</span>
                    <span className="w-24 text-right font-bold tabular-nums text-gray-900">{fmtUsd(c.total_usd)}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <div className="card p-5">
          <h2 className="text-sm font-bold text-gray-900 mb-3">Top vendors</h2>
          {(data.vendors || []).length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">No vendor spend.</p>
          ) : (
            <div className="space-y-1.5">
              {data.vendors.map((v, i) => (
                <div key={`${v.payee}-${i}`} className="flex items-center gap-3 text-xs">
                  <span className="w-5 shrink-0 font-bold text-gray-400 tabular-nums">{i + 1}</span>
                  <span className="flex-1 min-w-0 font-semibold text-gray-800 truncate" title={v.payee}>{v.payee || '—'}</span>
                  <span className="tabular-nums text-gray-400 w-10 text-right">{v.count}</span>
                  <span className="tabular-nums font-bold text-gray-900 w-24 text-right">{fmtUsd(v.total_usd)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Top invoices — 25 biggest by USD-equivalent */}
      <div className="card p-5">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-bold text-gray-900">Top invoices</h2>
          <p className="text-[11px] text-gray-400">Largest 25 · USD-equivalent</p>
        </div>
        {(data.invoices || []).length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">No invoices this month.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-rule text-[10px] uppercase tracking-wider text-gray-400">
                  <th className="text-left  font-semibold py-2">Date</th>
                  <th className="text-left  font-semibold py-2">Vendor</th>
                  <th className="text-left  font-semibold py-2">Artist</th>
                  <th className="text-left  font-semibold py-2">Category</th>
                  <th className="text-right font-semibold py-2">Amount</th>
                  <th className="text-left  font-semibold py-2 pl-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map(inv => (
                  <tr key={inv.id} className="border-b border-divider hover:bg-gray-50/40">
                    <td className="py-2 text-gray-500 tabular-nums whitespace-nowrap">{inv.invoice_date ? String(inv.invoice_date).slice(0, 10) : '—'}</td>
                    <td className="py-2 font-semibold text-gray-800 truncate max-w-[220px]" title={inv.payee}>{inv.payee || '—'}</td>
                    <td className="py-2 text-gray-600 truncate max-w-[160px]" title={inv.artist}>{inv.artist || '—'}</td>
                    <td className="py-2 text-gray-500 truncate max-w-[140px]">{inv.category || '—'}</td>
                    <td className="py-2 text-right font-bold tabular-nums text-gray-900">{fmtUsd(inv.amount_usd)}</td>
                    <td className="py-2 pl-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ring-1 ${
                        inv.payment_status === 'Paid'
                          ? 'bg-emerald-50 ring-emerald-200/60 text-emerald-700'
                          : 'bg-rose-50 ring-rose-200/60 text-rose-700'
                      }`}>
                        {inv.payment_status || 'Unpaid'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[11px] text-gray-400 text-center pt-2">
        USD-equivalent throughout. Split children roll into their parent.
      </p>
    </div>
  )
}

function BackLink({ to, label }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-gray-800 transition-colors"
    >
      <ArrowLeft size={13} /> {label}
    </Link>
  )
}
