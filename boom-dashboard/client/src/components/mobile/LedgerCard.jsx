import { ChevronDown, ChevronRight, Flag, FolderOpen } from 'lucide-react'

const PAID_STYLES = {
  Paid:    'bg-emerald-100 text-emerald-800',
  Unpaid:  'bg-red-100 text-red-800',
  Partial: 'bg-yellow-100 text-yellow-800',
}

function shortDate(d) {
  if (!d) return '—'
  const s = String(d).slice(0, 10)
  const parts = s.split('-')
  if (parts.length !== 3) return '—'
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[parseInt(parts[1], 10) - 1]} ${parseInt(parts[2], 10)}, ${parts[0]}`
}

/**
 * One ledger entry as a mobile card. Presentational — BkLedger owns all
 * state and handlers. Paid pill tap cycles status; split chevron expands
 * the family; body tap opens the detail sheet. Carries data-entry-id so
 * the existing ?focus= deep-link effect can scroll to it.
 */
export default function LedgerCard({
  entry, isChild, splitCount, expanded, focused, inPlan,
  fmt, onOpen, onCyclePaid, onToggleGroup,
}) {
  const status = entry.payment_status || 'Unpaid'
  return (
    <div
      data-entry-id={entry.id}
      onClick={onOpen}
      className={`bg-card border rounded-xl px-3 py-2.5 cursor-pointer active:opacity-80 ${
        focused ? 'border-amber-400 ring-2 ring-amber-300' : 'border-rule'
      } ${isChild ? 'ml-5' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-bold text-ink truncate">{entry.payee || '—'}</div>
        <div className="text-sm font-extrabold text-ink whitespace-nowrap">
          {fmt(entry.amount, entry.currency)}
        </div>
      </div>
      <div className="text-xs text-gray-500 truncate mt-0.5">
        {shortDate(entry.invoice_date)}
        {entry.artist ? ` · ${entry.artist}` : ''}
        {entry.song ? ` – ${entry.song}` : ''}
      </div>
      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
        <button
          onClick={(e) => { e.stopPropagation(); onCyclePaid() }}
          className={`px-2 py-0.5 rounded text-[10px] font-bold ${PAID_STYLES[status] || PAID_STYLES.Unpaid}`}
        >
          {status}
        </button>
        {entry.category && (
          <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-600 truncate max-w-[140px]">
            {entry.category}
          </span>
        )}
        {entry.flagged && (
          <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800">
            <Flag size={10} fill="currentColor" /> Flagged
          </span>
        )}
        {inPlan && (
          <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-bold bg-violet-100 text-violet-800">
            <FolderOpen size={10} /> In plan
          </span>
        )}
        {splitCount > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleGroup() }}
            className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800"
          >
            {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            {splitCount} split{splitCount === 1 ? '' : 's'}
          </button>
        )}
        {entry.is_bulk_deal && (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-teal-100 text-teal-800">Bulk</span>
        )}
      </div>
    </div>
  )
}
