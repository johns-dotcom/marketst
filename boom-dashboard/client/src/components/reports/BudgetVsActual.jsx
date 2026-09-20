import { Link } from 'react-router-dom'

// Budget vs actual (2026-09-20): the simple artist budget sheet's two typed
// lines — Advance, Total marketing — against the P&L's own per-artist figures
// on the chosen basis. Marketing shows both the range and lifetime, because a
// budget is not a per-month thing; Left is budget minus lifetime.
const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n) || 0)
const Bar = ({ spent, budget }) => {
  if (!budget) return <span className="text-gray-300 text-[11px]">no budget</span>
  const pct = Math.min(100, Math.round((spent / budget) * 100))
  const over = spent > budget
  return (
    <span className="inline-flex items-center gap-2 min-w-[140px]">
      <span className="flex-1 h-1.5 rounded-full bg-gray-200 overflow-hidden"><span className={`block h-full rounded-full ${over ? 'bg-rose-500' : pct >= 80 ? 'bg-amber-400' : 'bg-emerald-400'}`} style={{ width: `${pct}%` }} /></span>
      <span className={`text-[11px] tabular-nums ${over ? 'text-rose-600 font-bold' : 'text-gray-500'}`}>{Math.round((spent / budget) * 100)}%</span>
    </span>
  )
}

export default function BudgetVsActual({ data, filter = '' }) {
  if (!data) return null
  const q = filter.trim().toLowerCase()
  const rows = q ? data.rows.filter((r) => r.name.toLowerCase().includes(q)) : data.rows
  const t = data.totals
  return (
    <div className="bg-card border border-rule rounded-xl overflow-hidden" data-budget-vs-actual>
      <div className="px-4 py-2.5 border-b border-rule flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-bold text-ink">Budget vs actual</span>
        <span className="text-[11px] text-gray-400">{data.budgeted} artist{data.budgeted === 1 ? '' : 's'} with a budget{data.over ? ` · ${data.over} over on marketing` : ''} · spent on the {data.basis_label} basis · budgets from the artist budget sheets</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px] whitespace-nowrap">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-gray-400 border-b border-divider">
              <th className="text-left px-4 py-1.5 font-bold">Artist</th>
              <th className="text-right px-3 py-1.5 font-bold">Marketing budget</th>
              <th className="text-right px-3 py-1.5 font-bold">Spent, this range</th>
              <th className="text-right px-3 py-1.5 font-bold">Spent, all time</th>
              <th className="text-right px-3 py-1.5 font-bold">Left</th>
              <th className="text-left px-3 py-1.5 font-bold">Used</th>
              <th className="text-right px-3 py-1.5 font-bold">Advance budget</th>
              <th className="text-right px-3 py-1.5 font-bold">Advance paid</th>
              <th className="text-right px-4 py-1.5 font-bold">Left</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={`border-b border-divider hover:bg-gray-50 ${r.has_budget ? '' : 'text-gray-500'}`} data-bva-row={r.key} data-bva-over={r.over_marketing ? '1' : undefined}>
                <td className="px-4 py-1.5 font-medium text-ink">{r.artist_id ? <Link to={`/artist-budgets/${encodeURIComponent(r.key)}?name=${encodeURIComponent(r.name)}`} className="hover:text-boom-600">{r.name}</Link> : r.name}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.budget_marketing ? fmt(r.budget_marketing) : <span className="text-gray-300">—</span>}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmt(r.spent_marketing_range)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmt(r.spent_marketing_life)}</td>
                <td className={`px-3 py-1.5 text-right tabular-nums ${r.left_marketing != null && r.left_marketing < 0 ? 'text-rose-600 font-bold' : ''}`}>{r.left_marketing != null ? fmt(r.left_marketing) : <span className="text-gray-300">—</span>}</td>
                <td className="px-3 py-1.5"><Bar spent={r.spent_marketing_life} budget={r.budget_marketing} /></td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.budget_advance ? fmt(r.budget_advance) : <span className="text-gray-300">—</span>}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.advance_paid_life ? fmt(r.advance_paid_life) : <span className="text-gray-300">—</span>}</td>
                <td className={`px-4 py-1.5 text-right tabular-nums ${r.left_advance != null && r.left_advance < 0 ? 'text-rose-600 font-bold' : ''}`}>{r.left_advance != null ? fmt(r.left_advance) : <span className="text-gray-300">—</span>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={9} className="px-4 py-3 text-gray-400 italic">{q ? `No artist matches “${filter}”.` : 'No artist has a budget or spend yet. Type an Advance and a Total marketing figure on an artist\'s budget sheet and it appears here.'}</td></tr>}
          </tbody>
          <tfoot>
            <tr className="border-t border-rule font-bold">
              <td className="px-4 py-2">Total</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(t.budget_marketing)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(t.spent_marketing_range)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(t.spent_marketing_life)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(t.budget_marketing - t.spent_marketing_life)}</td>
              <td />
              <td className="px-3 py-2 text-right tabular-nums">{fmt(t.budget_advance)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(t.advance_paid_life)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{fmt(t.budget_advance - t.advance_paid_life)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
