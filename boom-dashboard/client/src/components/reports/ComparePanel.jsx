import { compareLines } from '../../lib/pnlRollup'

// Prior period / same period last year beside the P&L (2026-09-20). The
// compared P&L is a SECOND fetch of the same endpoint for the shifted range, on
// the same basis, so the comparison is the report's own arithmetic and never a
// reimplementation of it. Rendered as its own panel — three totals, then every
// line with current, compared, delta and percent, biggest movers first — rather
// than as extra columns in the month table, whose row builders are many.
const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n) || 0)
const pct = (p) => (p == null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(0)}%`)
const Delta = ({ v, good }) => {
  if (!v) return <span className="text-gray-400">—</span>
  const up = v > 0
  const tone = good === 'up' ? (up ? 'text-emerald-600' : 'text-rose-600') : good === 'down' ? (up ? 'text-rose-600' : 'text-emerald-600') : 'text-ink'
  return <span className={`font-semibold tabular-nums ${tone}`}>{up ? '+' : '−'}{fmt(Math.abs(v))}</span>
}

export default function ComparePanel({ cur, prev, mode, range, onDrill, filter = '' }) {
  const c = compareLines(cur, prev)
  if (!c) return null
  const title = mode === 'yoy' ? 'Same period last year' : 'Previous period'
  const q = filter.trim().toLowerCase()
  const lines = q ? c.lines.filter((l) => l.key.toLowerCase().includes(q)) : c.lines
  return (
    <div className="bg-card border border-rule rounded-xl overflow-hidden mb-4" data-compare-panel data-compare-mode={mode}>
      <div className="px-4 py-2.5 border-b border-rule flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-bold text-ink">Compared with {title.toLowerCase()}</span>
        <span className="text-[11px] text-gray-400">{range.from} → {range.to}, same basis</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-divider border-b border-divider">
        {[['Income', c.totals.income, 'up'], ['Expenses', c.totals.expenses, 'down'], ['Net', c.totals.net, 'up']].map(([label, t, good]) => (
          <div key={label} className="px-4 py-3" data-compare-total={label.toLowerCase()}>
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{label}</p>
            <p className="text-lg font-black text-ink tabular-nums">{fmt(t.cur)}</p>
            <p className="text-[12px] text-gray-500 tabular-nums">was {fmt(t.prev)} · <Delta v={t.delta} good={good} /> <span className="text-gray-400">({pct(t.pct)})</span></p>
          </div>
        ))}
      </div>
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-gray-400 border-b border-divider">
            <th className="text-left px-4 py-1.5 font-bold">Line</th>
            <th className="text-right px-3 py-1.5 font-bold">This range</th>
            <th className="text-right px-3 py-1.5 font-bold">Compared</th>
            <th className="text-right px-3 py-1.5 font-bold">Change</th>
            <th className="text-right px-4 py-1.5 font-bold">%</th>
          </tr>
        </thead>
        <tbody>
          {lines.slice(0, 40).map((l) => (
            <tr key={`${l.kind}:${l.key}`} className="border-b border-divider hover:bg-gray-50 cursor-pointer" onClick={() => onDrill?.(l.kind === 'income' ? 'income' : 'expense', l.key)} data-compare-line={l.key}>
              <td className="px-4 py-1.5 text-ink"><span className="text-[10px] uppercase tracking-wider text-gray-400 mr-2">{l.group}</span>{l.key}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{fmt(l.cur)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{fmt(l.prev)}</td>
              <td className="px-3 py-1.5 text-right"><Delta v={l.delta} good={l.kind === 'income' ? 'up' : 'down'} /></td>
              <td className="px-4 py-1.5 text-right tabular-nums text-gray-500">{pct(l.pct)}</td>
            </tr>
          ))}
          {!lines.length && <tr><td colSpan={5} className="px-4 py-3 text-gray-400 italic">No lines in either range.</td></tr>}
        </tbody>
      </table>
      {c.lines.length > 40 && <p className="px-4 py-2 text-[11px] text-gray-400">Showing the 40 biggest movers of {c.lines.length} lines.</p>}
    </div>
  )
}
