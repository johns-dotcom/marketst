import { useState, useEffect } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'
import api from '../../api'

/**
 * The spend sheet's view of one release, beside the ledger's.
 *
 * COMMITTED comes from `release_spend_plans` — what the marketing sheet says is
 * still owed. ACTUAL comes from `expenses` — what the ledger says moved. They
 * are rendered apart and never added together, because they disagree on every
 * release where both have data and there is no arithmetic that resolves that.
 *
 * SPENT and OPEN are also apart: an unpaid invoice is not an expenditure, and
 * folding it into "spent" is how an older budget surface here reported 31.3% of
 * its spend as invoices nobody had paid.
 *
 * Renders NOTHING when the release has no plan, which is the common case — 517
 * of the sheet's blocks are still unlinked, and most releases were never on the
 * sheet at all. A panel that announced its own emptiness on every release would
 * be noise on a tab that already has content.
 *
 * All state is declared above anything that derives from it, and there is no
 * early return above a hook — both are white-page shapes this codebase has
 * shipped before (see the smoke-render notes in CLAUDE.md).
 */

const money = (n) =>
  `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function Figure({ label, value, tone, hint }) {
  return (
    <div>
      <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-0.5">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${tone || 'text-gray-900'}`}>{value}</p>
      {hint && <p className="text-[11px] text-gray-400 mt-0.5">{hint}</p>}
    </div>
  )
}

export default function SpendPlanPanel({ releaseId }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.get(`/spend-plans/release/${releaseId}`)
      .then(res => { if (!cancelled) setData(res.data?.data || null) })
      .catch(() => { if (!cancelled) setData(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [releaseId])

  if (loading) return null
  if (!data || !data.plans?.length) return null

  const { plan, actual, variance, lines } = data
  const over = variance < 0
  const derived = data.plans.some(p => p.total_source === 'derived')
  const proseLines = lines.filter(l => l.amount == null && l.amount_raw)

  return (
    <div className="rounded-lg border border-rule bg-gray-50/60 p-4 mb-2">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div>
          <h4 className="text-sm font-bold text-gray-900">From the spend sheet</h4>
          <p className="text-xs text-gray-500 mt-0.5">
            {data.plans.map(p => p.source_header).join(' · ')}
            <span className="text-gray-400"> · column {data.plans.map(p => p.source_column).join(', ')}</span>
          </p>
        </div>
        <Link
          to="/artist-budgets"
          className="text-xs text-gray-500 hover:text-gray-700 inline-flex items-center gap-1"
        >
          Artist budgets <ExternalLink size={11} />
        </Link>
      </div>

      <div className="flex items-start gap-6 flex-wrap">
        <Figure
          label="Sheet total"
          value={money(plan.sheet_total)}
          hint={derived ? 'derived from a formula' : 'as printed'}
        />
        <Figure
          label="Still owed"
          value={money(plan.committed)}
          tone="text-amber-600"
          hint="lines marked “not yet”"
        />
        <div className="w-px self-stretch bg-gray-200" />
        <Figure label="Ledger — paid" value={money(actual.spent)} hint={`${actual.rows.length} ledger rows`} />
        <Figure
          label="Ledger — unpaid"
          value={money(actual.open)}
          tone={actual.open > 0 ? 'text-amber-600' : undefined}
          hint="invoices not yet paid"
        />
        <div className="w-px self-stretch bg-gray-200" />
        <Figure
          label={over ? 'Over the sheet' : 'Under the sheet'}
          value={money(Math.abs(variance))}
          tone={over ? 'text-red-500' : 'text-green-600'}
          hint="sheet total vs ledger paid"
        />
      </div>

      {/* The sheet's own paid claim is shown apart from the ledger's, and only
          when they disagree — they disagree on every release measured, so
          presenting either as the answer would be picking one. */}
      {Math.abs(plan.sheet_paid - actual.spent) > 0.005 && (
        <div className="mt-3 flex items-start gap-2 text-xs text-gray-500 border-t border-divider pt-3">
          <AlertTriangle size={13} className="mt-0.5 flex-shrink-0 text-amber-500" />
          <span>
            The sheet marks {money(plan.sheet_paid)} as paid; the ledger records {money(actual.spent)}.
            Neither is corrected from the other — the sheet tracks what was committed, the ledger what moved.
          </span>
        </div>
      )}

      <table className="w-full text-xs mt-4">
        <thead>
          <tr className="text-gray-400 text-left border-b border-divider">
            <th className="font-medium py-1.5 w-24 text-right">Amount</th>
            <th className="font-medium py-1.5 pl-3">Line</th>
            <th className="font-medium py-1.5 w-24">Sheet status</th>
          </tr>
        </thead>
        <tbody>
          {lines.map(l => (
            <tr key={`${l.plan_id}-${l.source_row}`} className="border-b border-divider last:border-0">
              <td className="py-1.5 text-right tabular-nums text-gray-900">
                {l.amount == null
                  ? <span className="text-amber-600 italic">{l.amount_raw || '—'}</span>
                  : money(l.amount)}
              </td>
              <td className="py-1.5 pl-3 text-gray-700">{l.note || <span className="text-gray-300">—</span>}</td>
              <td className={`py-1.5 ${
                l.status === 'paid' ? 'text-emerald-600'
                : l.status === 'not_yet' ? 'text-amber-600'
                : 'text-gray-400'
              }`}>
                {l.status === 'not_yet' ? 'not yet' : l.status || 'unknown'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {proseLines.length > 0 && (
        <p className="text-[11px] text-gray-400 mt-2">
          {proseLines.length} line{proseLines.length === 1 ? '' : 's'} had text where an amount should be,
          so {proseLines.length === 1 ? 'it is' : 'they are'} shown as written and excluded from the totals.
        </p>
      )}
    </div>
  )
}
