import { useEffect, useRef, useState } from 'react'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid, Cell, LabelList } from 'recharts'
import { periodLabel } from '../../lib/pnlRollup'

// Charts above the Reports table (2026-09-20, John: "charts above the table,
// chart for incoming invoice amount as well"). Five small charts, each one
// question, each on ONE axis, all reading the same payloads the tables read
// so a chart can never disagree with the number under it:
//
//   Net by period          income and expenses as paired bars, net as a line
//   Expense mix            top eight operating lines, the rest as Other
//   Spend by artist        top ten
//   Invoices received      vendor invoices arriving by month (count in the label)
//   Top vendors            top eight
//
// Categorical colour is FIXED by role, never cycled: income blue, expenses
// orange, pending yellow, aqua for magnitude bars. Validated for CVD on both
// surfaces (dataviz skill). Widths are measured, not ResponsiveContainer,
// which needs ResizeObserver (absent in jsdom).
const C = { income: '#2a78d6', expense: '#eb6834', mag: '#1baf7a', pending: '#eda100', net: '#0b0b0b', grid: 'rgba(120,120,120,.18)', ink: '#6b7280' }
const fmtK = (n) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}m` : Math.abs(n) >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`)
const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n) || 0)
const sum = (s) => Object.values(s || {}).reduce((a, b) => a + (Number(b) || 0), 0)

function useWidth(ref, fallback = 520) {
  const [w, setW] = useState(fallback)
  useEffect(() => {
    const measure = () => { const cw = ref.current?.clientWidth; if (cw) setW(cw) }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [ref])
  return w
}

function Panel({ title, sub, children, testId }) {
  const ref = useRef(null)
  const w = useWidth(ref)
  return (
    <div className="bg-card border border-rule rounded-xl p-3 min-w-0" data-chart={testId}>
      <p className="text-[12px] font-bold text-ink">{title}</p>
      {sub && <p className="text-[11px] text-gray-400 mb-1">{sub}</p>}
      <div ref={ref} className="w-full">{typeof children === 'function' ? children(Math.max(240, w - 8)) : children}</div>
    </div>
  )
}

const axis = { tick: { fontSize: 10, fill: C.ink }, axisLine: false, tickLine: false }
const tip = { contentStyle: { fontSize: 12, borderRadius: 8 }, cursor: { fill: 'rgba(120,120,120,.08)' } }

export default function ReportCharts({ pnl, byArtist, intake, vendors, onDrill }) {
  if (!pnl) return null
  const months = pnl.months || []
  const netData = months.map((m) => ({ m, label: periodLabel(m), Income: Number(pnl.income_totals?.series?.[m] || 0), Expenses: Number(pnl.expense_totals?.series?.[m] || 0), Net: Number(pnl.net?.series?.[m] || 0) }))
  const mix = Object.entries(pnl.expenses || {}).map(([key, s]) => ({ key, total: sum(s) })).filter((x) => x.total > 0).sort((a, b) => b.total - a.total)
  const mixTop = mix.slice(0, 8)
  const mixOther = mix.slice(8).reduce((a, b) => a + b.total, 0)
  if (mixOther > 0) mixTop.push({ key: 'Other', total: mixOther, other: true })
  const artists = (byArtist?.artists || pnl.by_artist?.artists || []).filter((a) => a.total > 0).slice(0, 10).map((a) => ({ key: a.name || a.key, total: Number(a.total) || 0, id: a.key }))
  const intakeData = (intake?.months || []).map((m) => ({ m, label: periodLabel(m), Received: Number(intake.series?.[m]?.usd || 0), Pending: Number(intake.series?.[m]?.pending_usd || 0), count: intake.series?.[m]?.count || 0 }))
  const vendorRows = (vendors?.rows || []).slice(0, 8).map((v) => ({ key: v.key, total: v.total }))
  const empty = !netData.some((d) => d.Income || d.Expenses) && !intakeData.some((d) => d.Received)
  if (empty) {
    return <div className="text-[12px] text-gray-400 border border-dashed border-rule rounded-xl px-4 py-3" data-charts-empty>Charts appear once this range holds money on this basis — nothing to draw yet.</div>
  }
  const H = 190
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3" data-report-charts>
      <Panel title="Income, expenses and net" sub="operating, by period" testId="net">
        {(w) => (
          <BarChart width={w} height={H} data={netData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2} barCategoryGap="30%">
            <CartesianGrid vertical={false} stroke={C.grid} />
            <XAxis dataKey="label" {...axis} />
            <YAxis {...axis} tickFormatter={fmtK} width={44} />
            <Tooltip {...tip} formatter={(v) => fmt(v)} />
            <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={8} />
            <Bar dataKey="Income" fill={C.income} radius={[4, 4, 0, 0]} maxBarSize={22} />
            <Bar dataKey="Expenses" fill={C.expense} radius={[4, 4, 0, 0]} maxBarSize={22} />
            <Line type="monotone" dataKey="Net" stroke={C.net} strokeWidth={2} dot={{ r: 3 }} />
          </BarChart>
        )}
      </Panel>
      <Panel title="Where the money went" sub="top operating lines, the rest as Other" testId="mix">
        {(w) => (
          <BarChart width={w} height={H} data={mixTop} layout="vertical" margin={{ top: 4, right: 40, left: 8, bottom: 0 }} barCategoryGap="25%">
            <CartesianGrid horizontal={false} stroke={C.grid} />
            <XAxis type="number" {...axis} tickFormatter={fmtK} />
            <YAxis type="category" dataKey="key" {...axis} width={110} />
            <Tooltip {...tip} formatter={(v) => fmt(v)} />
            <Bar dataKey="total" name="Spent" radius={[0, 4, 4, 0]} maxBarSize={16} onClick={(d) => onDrill && !d?.other && onDrill('expense', d.key)} cursor="pointer">
              {mixTop.map((d) => <Cell key={d.key} fill={d.other ? '#9ca3af' : C.expense} />)}
              <LabelList dataKey="total" position="right" formatter={fmtK} style={{ fontSize: 10, fill: C.ink }} />
            </Bar>
          </BarChart>
        )}
      </Panel>
      {artists.length > 0 && (
        <Panel title="Spend by artist" sub="top ten, operating" testId="artists">
          {(w) => (
            <BarChart width={w} height={H} data={artists} layout="vertical" margin={{ top: 4, right: 40, left: 8, bottom: 0 }} barCategoryGap="25%">
              <CartesianGrid horizontal={false} stroke={C.grid} />
              <XAxis type="number" {...axis} tickFormatter={fmtK} />
              <YAxis type="category" dataKey="key" {...axis} width={110} />
              <Tooltip {...tip} formatter={(v) => fmt(v)} />
              <Bar dataKey="total" name="Spent" fill={C.mag} radius={[0, 4, 4, 0]} maxBarSize={16} onClick={(d) => onDrill && onDrill('artist', d.id)} cursor="pointer">
                <LabelList dataKey="total" position="right" formatter={fmtK} style={{ fontSize: 10, fill: C.ink }} />
              </Bar>
            </BarChart>
          )}
        </Panel>
      )}
      {intakeData.length > 0 && (
        <Panel title="Invoices received" sub="vendor invoices by invoice month; the label is how many" testId="intake">
          {(w) => (
            <BarChart width={w} height={H} data={intakeData} margin={{ top: 14, right: 8, left: 0, bottom: 0 }} barGap={2} barCategoryGap="30%">
              <CartesianGrid vertical={false} stroke={C.grid} />
              <XAxis dataKey="label" {...axis} />
              <YAxis {...axis} tickFormatter={fmtK} width={44} />
              <Tooltip {...tip} formatter={(v) => fmt(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={8} />
              <Bar dataKey="Received" fill={C.income} radius={[4, 4, 0, 0]} maxBarSize={22}>
                <LabelList dataKey="count" position="top" style={{ fontSize: 10, fill: C.ink }} />
              </Bar>
              <Bar dataKey="Pending" name="of which awaiting approval" fill={C.pending} radius={[4, 4, 0, 0]} maxBarSize={22} />
            </BarChart>
          )}
        </Panel>
      )}
      {vendorRows.length > 0 && (
        <Panel title="Top vendors" sub="operating spend, this range" testId="vendors">
          {(w) => (
            <BarChart width={w} height={H} data={vendorRows} layout="vertical" margin={{ top: 4, right: 40, left: 8, bottom: 0 }} barCategoryGap="25%">
              <CartesianGrid horizontal={false} stroke={C.grid} />
              <XAxis type="number" {...axis} tickFormatter={fmtK} />
              <YAxis type="category" dataKey="key" {...axis} width={110} />
              <Tooltip {...tip} formatter={(v) => fmt(v)} />
              <Bar dataKey="total" name="Spent" fill={C.mag} radius={[0, 4, 4, 0]} maxBarSize={16}>
                <LabelList dataKey="total" position="right" formatter={fmtK} style={{ fontSize: 10, fill: C.ink }} />
              </Bar>
            </BarChart>
          )}
        </Panel>
      )}
      {netData.length > 1 && (
        <Panel title="Net, running" sub="cumulative operating net across the range" testId="cumulative">
          {(w) => {
            let acc = 0
            const data = netData.map((d) => { acc += d.Net; return { label: d.label, Cumulative: Math.round(acc) } })
            return (
              <LineChart width={w} height={H} data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={C.grid} />
                <XAxis dataKey="label" {...axis} />
                <YAxis {...axis} tickFormatter={fmtK} width={44} />
                <Tooltip {...tip} formatter={(v) => fmt(v)} />
                <Line type="monotone" dataKey="Cumulative" stroke={C.income} strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            )
          }}
        </Panel>
      )}
    </div>
  )
}
