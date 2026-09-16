import { useState, useEffect } from 'react'
import { Loader, Link2, SkipForward, Search } from 'lucide-react'
import api from '../api'

/**
 * The pieces that maintain the spend sheet, lifted out of the old
 * /import/spend-plans page so they can live on the budgets page itself.
 *
 * They were a separate route until John's call on 2026-09-03: "this should
 * replace the artist budgets sheet ... not live inside imports". Matching a
 * block to a release is budget work — you do it while looking at the budget —
 * so the queue belongs beside the cards, not behind an Import menu.
 *
 * Nothing changed on the way across except the export shape; the endpoints and
 * request bodies are the same, so what this does is what the CLI
 * (`scripts/import-spend-plans.js`) does.
 */

const money = (n) =>
  `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const STATUS_LABEL = {
  matched: 'Linked',
  unmatched: 'No match',
  ambiguous: 'Header ambiguous',
  duplicate_release: 'Duplicate release',
  skipped: 'Skipped',
}

const STATUS_TONE = {
  matched: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  unmatched: 'bg-gray-100 text-gray-600 border-gray-200',
  ambiguous: 'bg-amber-50 text-amber-700 border-amber-200',
  duplicate_release: 'bg-amber-50 text-amber-700 border-amber-200',
  skipped: 'bg-gray-100 text-gray-500 border-gray-200',
}

const LINE_TONE = {
  paid: 'text-emerald-600',
  not_yet: 'text-amber-600',
}

function Stat({ label, value, hint, tone }) {
  return (
    <div className="rounded-lg border border-rule bg-card px-4 py-3">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className={`text-lg font-semibold mt-0.5 ${tone || 'text-gray-900'}`}>{value}</div>
      {hint && <div className="text-xs text-gray-400 mt-0.5">{hint}</div>}
    </div>
  )
}

function QueueRow({ plan, onLink, onSkip, busy }) {
  const [search, setSearch] = useState('')
  const [hits, setHits] = useState([])
  const [searching, setSearching] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!search.trim()) { setHits([]); return }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get('/releases', {
          params: { search: search.trim(), in_catalog: 'any' },
        })
        if (!cancelled) setHits((data?.data || []).slice(0, 8))
      } catch {
        if (!cancelled) setHits([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [search])

  return (
    <div className="border border-rule rounded-lg bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-gray-900 break-words">
              {plan.source_header || <em className="text-gray-400">(no header)</em>}
            </span>
            <span className={`text-[11px] px-2 py-0.5 rounded-full border ${STATUS_TONE[plan.match_status]}`}>
              {STATUS_LABEL[plan.match_status] || plan.match_status}
            </span>
            <span className="text-[11px] text-gray-400 font-mono">col {plan.source_column}</span>
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {money(plan.sheet_total)} printed
            {plan.total_source === 'derived' && (
              <span className="text-amber-600"> · total derived from a formula</span>
            )}
            {plan.money.committed > 0 && <> · {money(plan.money.committed)} still owed</>}
            {plan.money.prose_lines > 0 && (
              <span className="text-amber-600"> · {plan.money.prose_lines} amount cell(s) held text</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setOpen(o => !o)}
            className="text-xs px-2.5 py-1.5 rounded-md border border-rule text-gray-600 hover:bg-gray-100"
          >
            {open ? 'Hide lines' : `${plan.lines.length} lines`}
          </button>
          <button
            onClick={() => onSkip(plan)}
            disabled={busy}
            className="text-xs px-2.5 py-1.5 rounded-md border border-rule text-gray-600 hover:bg-gray-100 inline-flex items-center gap-1 disabled:opacity-50"
          >
            <SkipForward size={13} /> Not a tracked release
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3 border-t border-divider pt-3">
          <table className="w-full text-xs">
            <tbody>
              {plan.lines.map(l => (
                <tr key={l.source_row} className="border-b border-divider last:border-0">
                  <td className="py-1 pr-3 text-gray-400 font-mono w-10">r{l.source_row}</td>
                  <td className="py-1 pr-3 text-right w-28 tabular-nums text-gray-900">
                    {l.amount == null
                      ? <span className="text-amber-600 italic">{l.amount_raw || '—'}</span>
                      : money(l.amount)}
                  </td>
                  <td className="py-1 pr-3 text-gray-700">{l.note || <span className="text-gray-300">—</span>}</td>
                  <td className={`py-1 w-24 ${LINE_TONE[l.status] || 'text-gray-400'}`}>
                    {l.status === 'not_yet' ? 'not yet' : l.status || 'unknown'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Suggestions — never auto-applied. Nothing links without a click. */}
      {plan.suggestions?.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">Suggested:</span>
          {plan.suggestions.map(s => (
            <button
              key={s.releaseId}
              onClick={() => onLink(plan, s.releaseId)}
              disabled={busy}
              className="text-xs px-2.5 py-1 rounded-md border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 inline-flex items-center gap-1 disabled:opacity-50"
            >
              <Link2 size={12} /> {s.label}
              <span className="text-emerald-500">{s.score}</span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 relative">
        <div className="flex items-center gap-2">
          <Search size={14} className="text-gray-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search for a different release…"
            className="flex-1 text-xs px-2.5 py-1.5 rounded-md border border-rule bg-card text-gray-900"
          />
          {searching && <Loader size={13} className="animate-spin text-gray-400" />}
        </div>
        {hits.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {hits.map(h => (
              <button
                key={h.id}
                onClick={() => { onLink(plan, h.id); setSearch(''); setHits([]) }}
                disabled={busy}
                className="text-xs px-2.5 py-1 rounded-md border border-rule text-gray-700 hover:bg-gray-100 disabled:opacity-50"
              >
                {h.artist_name} — {h.project_name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}


export { QueueRow, Stat, money, STATUS_LABEL, STATUS_TONE }
