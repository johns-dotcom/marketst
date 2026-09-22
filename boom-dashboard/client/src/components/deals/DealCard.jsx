// One card on the board. Everything on it is a state the person can act on:
// who owns it, how long it has sat, whether the follow-up is due, the last
// touch, the money, the documents. Drag it or press Next to move it.
import { GripVertical, X, ChevronRight, Paperclip, Clock } from 'lucide-react'
import { STAGES, LIVE_STAGES, followupState, staleTone, fmtMoney, relTime, initials, eventLine } from '../../lib/deals'

const FU_TONE = { overdue: 'text-rose-600 font-semibold', today: 'text-amber-600 font-semibold', soon: 'text-gray-600', later: 'text-gray-400' }
const STALE = { red: 'bg-rose-50 text-rose-700 border-rose-200', amber: 'bg-amber-50 text-amber-700 border-amber-200', none: 'bg-gray-50 text-gray-500 border-gray-200' }

export default function DealCard({ deal, dragging, onOpen, onDelete, onNext, onDragStart, onDragEnd }) {
  const fu = followupState(deal)
  const stale = staleTone(deal)
  const live = LIVE_STAGES.includes(deal.stage)
  const nextStage = STAGES[STAGES.indexOf(deal.stage) + 1]
  return (
    <div draggable onDragStart={(e) => onDragStart(e, deal.id)} onDragEnd={onDragEnd} data-deal-card={deal.id} data-row data-attn={fu.kind === 'overdue' || stale === 'red' ? '1' : '0'}
      className={`p-2.5 rounded-lg border bg-card hover:shadow-sm transition-all group ${dragging ? 'opacity-30' : ''} ${fu.kind === 'overdue' ? 'border-rose-200' : 'border-gray-150 hover:border-gray-300'}`}
      style={{ cursor: 'grab' }}>
      <div className="flex items-start gap-1.5">
        <GripVertical size={12} className="text-gray-300 mt-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
        <button onClick={() => onOpen(deal)} className="flex-1 min-w-0 text-left" data-row-open data-deal-open>
          <div className="flex items-start gap-1.5">
            <p className="text-[13px] font-semibold text-gray-900 truncate leading-tight flex-1">{deal.artist_name}</p>
            {deal.owner_name && <span title={`Owner: ${deal.owner_name}`} className="w-5 h-5 rounded-full bg-boom-100 text-boom-700 text-[9px] font-bold inline-flex items-center justify-center flex-shrink-0" data-deal-owner>{initials(deal.owner_name)}</span>}
          </div>
          <p className="text-[11px] text-gray-400 mt-0.5 truncate">{[deal.genre, deal.deal_type].filter(Boolean).join(' · ') || (deal.source ? `via ${deal.source}` : '')}</p>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            {Number(deal.advance) > 0 && <span className="text-[11px] font-semibold text-gray-800 tabular-nums" data-deal-advance>{fmtMoney(deal.advance)}</span>}
            {live && <span title={`${deal.days_in_stage ?? 0} days in ${deal.stage}`} className={`inline-flex items-center gap-0.5 text-[10px] font-medium border rounded px-1 py-px tabular-nums ${STALE[stale]}`} data-deal-days={deal.days_in_stage ?? 0} data-stale={stale}><Clock size={9} /> {deal.days_in_stage ?? 0}d</span>}
            {deal.file_count > 0 && <span className="inline-flex items-center gap-0.5 text-[10px] text-gray-400"><Paperclip size={9} /> {deal.file_count}</span>}
          </div>
          {fu.kind !== 'none' && <p className={`text-[10px] mt-1 ${FU_TONE[fu.kind]}`} data-deal-followup={fu.kind}>{fu.label}</p>}
          {deal.last_event_at && (
            <p className="text-[10px] text-gray-400 mt-1 truncate" data-deal-last title={eventLine({ kind: deal.last_event_kind, body: deal.last_event_body })}>
              {eventLine({ kind: deal.last_event_kind, body: deal.last_event_body, to_stage: deal.stage })} · {relTime(deal.last_event_at)}{deal.last_event_user ? ` · ${initials(deal.last_event_user)}` : ''}
            </p>
          )}
          {deal.stage === 'Passed' && deal.passed_reason && <p className="text-[10px] text-gray-400 mt-1 truncate">Passed — {deal.passed_reason}{deal.revisit_date ? ` · revisit ${String(deal.revisit_date).slice(0, 10)}` : ''}</p>}
        </button>
        <button onClick={() => onDelete(deal.id)} aria-label="Delete deal" className="p-0.5 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"><X size={12} /></button>
      </div>
      {live && nextStage && (
        <button onClick={() => onNext(deal, nextStage)} data-key="m" className="mt-1.5 w-full flex items-center justify-center gap-0.5 text-[11px] font-medium text-gray-400 hover:text-boom-600 py-0.5 rounded hover:bg-boom-50/50 transition-all">
          {nextStage === 'Signed' ? 'Sign' : 'Next'} <ChevronRight size={11} />
        </button>
      )}
    </div>
  )
}
