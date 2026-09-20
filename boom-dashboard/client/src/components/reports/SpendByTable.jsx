import { periodLabel, periodOf } from '../../lib/pnlRollup'

// Spend by vendor / by rep (2026-09-20): the P&L's operating expenses cut a
// different way, months across, from GET /reports/spend-by. Same basis, same
// exclusions, so the footer equals the P&L's operating expense total.
const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n) || 0)

export default function SpendByTable({ data, dim, gran = 'month', filter = '', onOpen }) {
  if (!data) return null
  const periods = [...new Set(data.months.map((m) => periodOf(m, gran)))]
  const cell = (row, p) => data.months.filter((m) => periodOf(m, gran) === p).reduce((s, m) => s + (row.series[m] || 0), 0)
  const q = filter.trim().toLowerCase()
  const rows = q ? data.rows.filter((r) => r.key.toLowerCase().includes(q)) : data.rows
  const label = dim === 'rep' ? 'Rep' : 'Vendor'
  return (
    <div className="bg-card border border-rule rounded-xl overflow-hidden" data-spendby={dim}>
      <div className="px-4 py-2.5 border-b border-rule flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-bold text-ink">Spend by {label.toLowerCase()}</span>
        <span className="text-[11px] text-gray-400">{data.count} {label.toLowerCase()}{data.count === 1 ? '' : 's'} · {data.basis_label} · operating only, equals the P&L's expense total</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px] whitespace-nowrap">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-gray-400 border-b border-divider">
              <th className="text-left px-4 py-1.5 font-bold sticky left-0 bg-card">{label}</th>
              {periods.map((p) => <th key={p} className="text-right px-3 py-1.5 font-bold">{periodLabel(p)}</th>)}
              <th className="text-right px-3 py-1.5 font-bold">Total</th>
              <th className="text-right px-3 py-1.5 font-bold">Rows</th>
              <th className="text-left px-4 py-1.5 font-bold">Mostly</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-divider hover:bg-gray-50" data-spendby-row={r.key}>
                <td className="px-4 py-1.5 text-ink font-medium sticky left-0 bg-card">
                  {onOpen ? <button onClick={() => onOpen(r)} className="hover:text-boom-600 text-left">{r.key}</button> : r.key}
                </td>
                {periods.map((p) => { const v = cell(r, p); return <td key={p} className="px-3 py-1.5 text-right tabular-nums">{v ? fmt(v) : <span className="text-gray-300">—</span>}</td> })}
                <td className="px-3 py-1.5 text-right tabular-nums font-bold">{fmt(r.total)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{r.count}</td>
                <td className="px-4 py-1.5 text-gray-500">{r.top_category || ''}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={periods.length + 4} className="px-4 py-3 text-gray-400 italic">{q ? `No ${label.toLowerCase()} matches “${filter}”.` : `No operating spend in this range on the ${data.basis_label} basis.`}</td></tr>}
          </tbody>
          <tfoot>
            <tr className="border-t border-rule font-bold">
              <td className="px-4 py-2 sticky left-0 bg-card">Total{q ? ' (matching)' : ''}</td>
              {periods.map((p) => <td key={p} className="px-3 py-2 text-right tabular-nums">{fmt(rows.reduce((s, r) => s + cell(r, p), 0))}</td>)}
              <td className="px-3 py-2 text-right tabular-nums">{fmt(rows.reduce((s, r) => s + r.total, 0))}</td>
              <td className="px-3 py-2 text-right tabular-nums text-gray-500">{rows.reduce((s, r) => s + r.count, 0)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
