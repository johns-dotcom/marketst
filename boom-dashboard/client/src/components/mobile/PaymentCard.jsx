import { Zap, Pause, GitBranch, Mail } from 'lucide-react'

const STATUS_STYLES = {
  Paid:    'bg-emerald-100 text-emerald-800',
  Unpaid:  'bg-red-100 text-red-800',
  Partial: 'bg-yellow-100 text-yellow-800',
}

/**
 * One payment row as a mobile card. Presentational — all data and
 * callbacks come from BkPayments, which owns the state and handlers.
 * Checkbox tap = select for bulk actions; body tap = open detail sheet.
 */
export default function PaymentCard({
  entry, displayAmount, currency, fmt, fmtDate,
  overdue, dueSoon, splitCount,
  selected, onToggleSelect, onOpen,
}) {
  const status = entry.payment_status || 'Unpaid'
  const due = entry.scheduled_payment_date
  const dueClass = overdue ? 'text-red-600 font-bold' : dueSoon ? 'text-orange-600 font-semibold' : 'text-gray-500'

  return (
    <div
      className="bg-card border border-rule rounded-xl px-3 py-3 flex items-start gap-3 cursor-pointer active:opacity-80"
      onClick={onOpen}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        onClick={(e) => e.stopPropagation()}
        className="mt-1 w-5 h-5 shrink-0 accent-boom-600"
        aria-label={`Select ${entry.payee}`}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="text-sm font-bold text-ink truncate">{entry.payee || '—'}</div>
          <div className="text-sm font-extrabold text-ink whitespace-nowrap">{fmt(displayAmount, currency)}</div>
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <div className="text-xs text-gray-500 truncate">
            {[entry.artist, entry.invoice_number ? `#${entry.invoice_number}` : null].filter(Boolean).join(' · ') || '—'}
          </div>
          <div className={`text-[11px] whitespace-nowrap ${dueClass}`}>
            {status === 'Paid' ? `Paid ${fmtDate(entry.payment_date)}` : due ? `Due ${fmtDate(due)}` : 'No due date'}
          </div>
        </div>
        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
          <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold ${STATUS_STYLES[status] || STATUS_STYLES.Unpaid}`}>
            {status}
          </span>
          {entry.rush_requested && status !== 'Paid' && (
            <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800">
              <Zap size={10} fill="currentColor" /> Rush
            </span>
          )}
          {entry.on_hold && status !== 'Paid' && (
            <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-bold bg-gray-200 text-gray-700">
              <Pause size={10} /> Hold
            </span>
          )}
          {splitCount > 0 && (
            <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800">
              <GitBranch size={10} /> Split ×{splitCount}
            </span>
          )}
          {status === 'Paid' && entry.confirmation_sent && (
            <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700">
              <Mail size={10} /> Confirmed
            </span>
          )}
          {entry.payment_method && (
            <span className="text-[10px] text-gray-400 font-semibold">{entry.payment_method}</span>
          )}
        </div>
      </div>
    </div>
  )
}
