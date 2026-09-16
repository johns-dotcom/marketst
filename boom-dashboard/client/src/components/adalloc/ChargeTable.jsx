// The charges themselves — what the bank actually paid the ad platforms.
//
// This table is the evidence behind every number above it. The reason the
// existing ad pool has never been used once in six months is that it asked for a
// dollar figure with nothing like this on screen: no charges, no dates, no
// running total, so any amount typed was unfalsifiable. Here the allocation and
// the money it came out of are visible at the same time.
//
// Pure presentation. Every mutation belongs to the page.

import { Lock } from 'lucide-react'

const usd = (c) => (Number(c || 0) / 100).toLocaleString('en-US',
  { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
const day = (d) => String(d || '').slice(0, 10)

export default function ChargeTable({ charges = [], highlight = [], onUndo }) {
  if (!charges.length) {
    return <div className="px-3 py-8 text-center text-[13px] text-gray-400">
      No unallocated ad charges in this month.
    </div>
  }
  const hot = new Set(highlight)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider border-b border-divider">
            <th className="px-3 py-2">Date</th>
            <th className="px-3 py-2">Payee</th>
            <th className="px-3 py-2 text-right">Charge</th>
            <th className="px-3 py-2">Allocated to</th>
            <th className="px-3 py-2 text-right">Unallocated</th>
          </tr>
        </thead>
        <tbody>
          {charges.map((c) => (
            <tr key={c.root_id}
              className={`border-b border-divider/60 ${hot.has(c.root_id) ? 'bg-boom-50' : 'hover:bg-gray-50'}`}>
              <td className="px-3 py-2 text-gray-500 tabular-nums whitespace-nowrap">{day(c.date)}</td>
              <td className="px-3 py-2">
                <span className="font-medium text-gray-900">{c.payee}</span>
                <span className="text-[11px] text-gray-400 ml-1.5">{c.category}</span>
                {/* Named, never hidden. A charge this page cannot restructure is
                    still money in the pool, and a total nobody can reproduce is
                    worse than an awkward row. */}
                {!c.allocatable && (
                  <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-amber-600"
                    title={c.blocked.join('; ')}>
                    <Lock size={10} /> {c.blocked[0]}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-gray-500">{usd(c.charge_cents)}</td>
              <td className="px-3 py-2">
                {c.allocations.length === 0 && c.attributed.length === 0 && (
                  <span className="text-gray-300">—</span>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {c.allocations.map((a) => (
                    <span key={a.expense_id}
                      className="inline-flex items-center gap-1 text-[11px] bg-gray-50 border border-rule rounded-full pl-2 pr-1 py-0.5">
                      <span className="font-semibold text-gray-700">{a.artist}</span>
                      <span className="text-gray-400 tabular-nums">{usd(a.cents)}</span>
                      {onUndo && (
                        <button onClick={() => onUndo(a)} title={`Return ${usd(a.cents)} to the pool`}
                          className="text-gray-300 hover:text-rose-500 px-0.5">&times;</button>
                      )}
                    </span>
                  ))}
                  {/* Somebody named these on the Reports drill, not here. Shown so
                      the arithmetic on the row adds up, without an undo we do not
                      own. */}
                  {c.attributed.map((a) => (
                    <span key={a.expense_id}
                      className="inline-flex items-center gap-1 text-[11px] text-gray-400 border border-dashed border-rule rounded-full px-2 py-0.5"
                      title="Attributed elsewhere in the app, not by this page">
                      {a.artist || 'unnamed'} <span className="tabular-nums">{usd(a.cents)}</span>
                    </span>
                  ))}
                </div>
              </td>
              <td className={`px-3 py-2 text-right tabular-nums font-medium ${
                c.open_cents ? 'text-gray-900' : 'text-emerald-600'}`}>
                {c.open_cents ? usd(c.open_cents) : 'done'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
