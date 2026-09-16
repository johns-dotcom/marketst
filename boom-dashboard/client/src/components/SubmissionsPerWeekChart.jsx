import { useState, useEffect, useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell } from 'recharts'
import { ChevronDown, ChevronRight, Loader } from 'lucide-react'
import api from '../api'
import getDarkColors from '../utils/darkColors'
import { useTheme } from '../context/ThemeContext'

// Reusable trailing-12-weeks bar chart. Renders whatever endpoint the
// caller passes, so long as the response shape is:
//   { data: { weeks: [{ week_start, week_end, vendor, admin, total }, ...] } }
//
// Used twice on Invoices View: once for submissions (bucketed by
// created_at) and once for paid (bucketed by payment_date). Each
// instance needs a distinct `storageKey` so their collapse states are
// independent in localStorage.

const RED = '#334155'
const DEFAULT_ENDPOINT = '/bk/payments/submissions-per-week'
const DEFAULT_STORAGE_KEY = 'bk_payments_submissions_chart_collapsed_v1'

function fmtWeekLabel(input) {
  // Accepts either a plain YYYY-MM-DD string OR a full ISO timestamp
  // (the pg driver returns DATE columns as Date objects, which JSON-
  // stringify to "2026-04-13T00:00:00.000Z"). Take only the first 10
  // chars (the calendar-date prefix) BEFORE splitting on '-' so we
  // never accidentally include the time portion in the day-number
  // parse — the original bug was `Number("13T00:00:00.000Z")` → NaN,
  // which fell back to day 1 and produced "Apr 1" / "May 1" everywhere.
  const iso = input instanceof Date ? input.toISOString().slice(0, 10) : String(input || '').slice(0, 10)
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return ''
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function fmtUSD(amount) {
  const n = Number(amount || 0)
  if (!isFinite(n) || n === 0) return '$0'
  // Compact when large — "$12.3K" reads faster than "$12,340" in dense
  // tooltip rows. Fall back to full formatting under $1000.
  if (Math.abs(n) >= 10_000) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(n)
  }
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function CustomTooltip({ active, payload, label, showAmounts }) {
  if (!active || !payload || !payload.length) return null
  const row = payload[0]?.payload || {}
  const vendor = row.vendor || 0
  const admin  = row.admin  || 0
  const total  = row.total  || 0
  const rangeEnd = row.week_end ? fmtWeekLabel(row.week_end) : null
  // Amount fields only present on the /paid-per-week endpoint response;
  // rendered when the caller opts in via showAmounts.
  const vendorAmt = row.vendor_amount || 0
  const adminAmt  = row.admin_amount  || 0
  const totalAmt  = row.total_amount  || 0
  return (
    <div className="bg-card border border-rule rounded-lg shadow-md px-3 py-2 text-xs">
      <div className="font-bold text-gray-900 mb-1">
        Week of {fmtWeekLabel(row.week_start)}
        {rangeEnd && <span className="text-gray-400 font-normal"> – {rangeEnd}</span>}
      </div>
      <div className="flex items-center justify-between gap-4 text-gray-700">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm inline-block" style={{ background: RED }} />
          Vendor portal
        </span>
        <span className="font-semibold tabular-nums">
          {vendor}{showAmounts && <span className="text-gray-400 font-normal ml-2">{fmtUSD(vendorAmt)}</span>}
        </span>
      </div>
      <div className="flex items-center justify-between gap-4 text-gray-700 mt-0.5">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm inline-block bg-gray-400" />
          Admin-entered
        </span>
        <span className="font-semibold tabular-nums">
          {admin}{showAmounts && <span className="text-gray-400 font-normal ml-2">{fmtUSD(adminAmt)}</span>}
        </span>
      </div>
      <div className="border-t border-rule mt-1.5 pt-1 flex items-center justify-between text-gray-900 font-bold">
        <span>Total</span>
        <span className="tabular-nums">
          {total}{showAmounts && <span className="text-gray-500 font-semibold ml-2">{fmtUSD(totalAmt)}</span>}
        </span>
      </div>
    </div>
  )
}

export default function SubmissionsPerWeekChart({
  onWeekClick,
  selectedWeekStart,
  endpoint = DEFAULT_ENDPOINT,
  storageKey = DEFAULT_STORAGE_KEY,
  title = 'Invoices submitted per week',
  subtitle = 'Trailing 12 weeks · vendor portal + admin-entered · Mon–Sun, LA time',
  headlineLabel = 'this week',
  // When true, the tooltip / header / footer surface USD-equivalent
  // amount totals alongside the row counts. Used on the paid chart —
  // paid rows carry a locked fx_rate_to_usd so the USD sum is stable.
  showAmounts = false,
  // Optional ISO date strings (YYYY-MM-DD). When provided, they're
  // forwarded to the endpoint as `?from=&to=` query params so the chart
  // renders any custom window. When omitted, the server picks the
  // trailing 12 weeks — matches the historical behavior.
  from = null,
  to   = null,
} = {}) {
  const { theme } = useTheme()
  const C = getDarkColors(theme)
  const [data, setData] = useState(null)     // { weeks: [...] } or null
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [collapsed, setCollapsedRaw] = useState(() => {
    try { return localStorage.getItem(storageKey) === '1' } catch { return false }
  })
  const setCollapsed = (v) => {
    setCollapsedRaw(v)
    try { localStorage.setItem(storageKey, v ? '1' : '0') } catch {}
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams()
    if (from) params.append('from', from)
    if (to)   params.append('to',   to)
    const qs = params.toString()
    const url = qs ? `${endpoint}?${qs}` : endpoint
    api.get(url)
      .then(res => {
        if (cancelled) return
        setData(res.data?.data || { weeks: [] })
      })
      .catch(err => {
        if (cancelled) return
        setError(err.response?.data?.error || err.message || 'Failed to load chart')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [endpoint, from, to])

  const weeks = data?.weeks || []
  const totals = useMemo(() => ({
    vendor: weeks.reduce((s, w) => s + (w.vendor || 0), 0),
    admin:  weeks.reduce((s, w) => s + (w.admin  || 0), 0),
    vendorAmount: weeks.reduce((s, w) => s + (w.vendor_amount || 0), 0),
    adminAmount:  weeks.reduce((s, w) => s + (w.admin_amount  || 0), 0),
    totalAmount:  weeks.reduce((s, w) => s + (w.total_amount  || 0), 0),
  }), [weeks])

  const thisWeek  = weeks[weeks.length - 1]
  const lastWeek  = weeks[weeks.length - 2]
  const wowDelta  = (thisWeek?.total ?? 0) - (lastWeek?.total ?? 0)
  const wowPct    = lastWeek?.total ? Math.round((wowDelta / lastWeek.total) * 100) : null

  return (
    <div className="card overflow-hidden mb-5">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between gap-4 px-5 py-3 hover:bg-gray-50/60 transition-colors text-left"
        title={collapsed ? 'Show submissions chart' : 'Hide submissions chart'}
      >
        <div className="flex items-center gap-3 min-w-0">
          {collapsed
            ? <ChevronRight size={14} className="text-gray-400 flex-shrink-0" />
            : <ChevronDown  size={14} className="text-gray-400 flex-shrink-0" />}
          <div className="min-w-0">
            <p className="text-sm font-bold text-gray-900">{title}</p>
            <p className="text-[11px] text-gray-400 mt-0.5">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-4 flex-shrink-0 text-xs">
          {thisWeek && (
            <span className="tabular-nums text-gray-700">
              <span className="font-bold">{thisWeek.total}</span>
              <span className="text-gray-400 font-normal ml-1">{headlineLabel}</span>
              {showAmounts && thisWeek.total_amount != null && (
                <span className="text-gray-500 font-semibold ml-2">{fmtUSD(thisWeek.total_amount)}</span>
              )}
              {wowPct != null && wowPct !== 0 && (
                <span className={`ml-2 font-semibold ${wowPct > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                  {wowPct > 0 ? '↑' : '↓'} {Math.abs(wowPct)}%
                </span>
              )}
            </span>
          )}
        </div>
      </button>

      {!collapsed && (
        <div className="border-t border-rule px-4 pt-3 pb-2">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-gray-400 text-xs">
              <Loader size={14} className="animate-spin mr-2" /> Loading…
            </div>
          ) : error ? (
            <div className="text-center py-12 text-xs text-rose-600">{error}</div>
          ) : weeks.length === 0 ? (
            <div className="text-center py-12 text-xs text-gray-400">No submissions in the last 12 weeks.</div>
          ) : (
            <>
              <div style={{ width: '100%', height: 220 }}>
                <ResponsiveContainer>
                  <BarChart data={weeks} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                    <XAxis
                      dataKey="week_start"
                      tickFormatter={fmtWeekLabel}
                      tick={{ fontSize: 11, fill: C.textMuted }}
                      axisLine={{ stroke: C.border }}
                      tickLine={{ stroke: C.border }}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fontSize: 11, fill: C.textMuted }}
                      axisLine={{ stroke: C.border }}
                      tickLine={{ stroke: C.border }}
                      width={38}
                    />
                    <Tooltip content={<CustomTooltip showAmounts={showAmounts} />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
                    <Legend
                      wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                      iconType="square"
                      iconSize={10}
                    />
                    {/* Clickable bars — when the parent passes onWeekClick, each
                        stacked column becomes a filter target. Selected bar keeps
                        its full color; the rest fade to a muted variant so the
                        selection is visible at a glance. Recharts fires onClick
                        on each Bar segment; we route both to the same handler so
                        clicking the vendor OR admin portion of the same column
                        both select that week. */}
                    <Bar
                      dataKey="vendor"
                      name="Vendor portal"
                      stackId="a"
                      radius={[0, 0, 0, 0]}
                      cursor={onWeekClick ? 'pointer' : undefined}
                      onClick={onWeekClick ? (d) => onWeekClick(d?.payload) : undefined}
                    >
                      {weeks.map((w) => {
                        const isSel = selectedWeekStart && w.week_start === selectedWeekStart
                        const isDim = selectedWeekStart && !isSel
                        return (
                          <Cell
                            key={`v-${w.week_start}`}
                            fill={RED}
                            opacity={isDim ? 0.35 : 1}
                            stroke={isSel ? '#7f1d1d' : undefined}
                            strokeWidth={isSel ? 1.5 : 0}
                          />
                        )
                      })}
                    </Bar>
                    <Bar
                      dataKey="admin"
                      name="Admin-entered"
                      stackId="a"
                      radius={[4, 4, 0, 0]}
                      cursor={onWeekClick ? 'pointer' : undefined}
                      onClick={onWeekClick ? (d) => onWeekClick(d?.payload) : undefined}
                    >
                      {weeks.map((w) => {
                        const isSel = selectedWeekStart && w.week_start === selectedWeekStart
                        const isDim = selectedWeekStart && !isSel
                        return (
                          <Cell
                            key={`a-${w.week_start}`}
                            fill="#9ca3af"
                            opacity={isDim ? 0.35 : 1}
                            stroke={isSel ? '#374151' : undefined}
                            strokeWidth={isSel ? 1.5 : 0}
                          />
                        )
                      })}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="flex items-center justify-between text-[11px] text-gray-400 px-1 pt-1 pb-1 border-t border-rule mt-2">
                <span>
                  {weeks.length}-week total:{' '}
                  <span className="font-semibold text-gray-600 tabular-nums">{totals.vendor + totals.admin}</span>
                  {showAmounts && (
                    <span className="font-semibold text-gray-600 tabular-nums ml-2">
                      · {fmtUSD(totals.totalAmount)}
                    </span>
                  )}
                </span>
                <span>
                  <span className="text-gray-500">{totals.vendor}</span> vendor portal
                  {showAmounts && <span className="text-gray-500 ml-1">({fmtUSD(totals.vendorAmount)})</span>}
                  {' · '}
                  <span className="text-gray-500">{totals.admin}</span> admin-entered
                  {showAmounts && <span className="text-gray-500 ml-1">({fmtUSD(totals.adminAmount)})</span>}
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
