// The pipeline as a table — the same deals, filters and sort as the board,
// read a row at a time. Click a header to sort (again to flip); rows carry
// data-row so j / k / Enter work through useListKeys.
import { ArrowUp, ArrowDown, Paperclip } from 'lucide-react'
import { STAGE_DOT, LIVE_STAGES, followupState, staleTone, fmtMoneyFull, relTime, initials, eventLine, shortDate } from '../../lib/deals'

const COLS = [
  ['artist', 'Artist'], ['stage', 'Stage'], ['owner', 'Owner'], ['type', 'Type', false], ['advance', 'Advance', true, 'right'],
  ['days', 'In stage', true, 'right'], ['followup', 'Follow-up'], ['touched', 'Last touch'], ['source', 'Source', false],
]
const FU_TONE = { overdue: 'text-rose-600 font-semibold', today: 'text-amber-600 font-semibold', soon: 'text-gray-700', later: 'text-gray-400', none: 'text-gray-300' }
const STALE_TONE = { red: 'text-rose-600 font-semibold', amber: 'text-amber-600', none: 'text-gray-600' }

export default function DealList({ deals, sort, onSort, onOpen }) {
  const [key, dir] = String(sort || 'stage').split(':')
  const header = (id, label, sortable = true, align) => (
    <th key={id} className={`px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-gray-500 whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}>
      {sortable ? (
        <button type="button" onClick={() => onSort(key === id ? (dir === 'desc' ? id : `${id}:desc`) : id)} className={`inline-flex items-center gap-1 hover:text-gray-900 ${key === id ? 'text-gray-900' : ''}`} data-deal-sort={id}>
          {label}{key === id && (dir === 'desc' ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}
        </button>
      ) : label}
    </th>
  )
  return (
    <div className="bg-card border border-rule rounded-xl overflow-x-auto" data-deal-list>
      <table className="w-full text-sm">
        <thead className="border-b border-divider bg-gray-50/60"><tr>{COLS.map(([id, label, sortable, align]) => header(id, label, sortable !== false, align))}</tr></thead>
        <tbody>
          {deals.map((d) => {
            const fu = followupState(d); const stale = staleTone(d)
            return (
              <tr key={d.id} data-row data-deal-row={d.id} onClick={() => onOpen(d)} className="border-b border-divider last:border-0 hover:bg-gray-50/70 cursor-pointer">
                <td className="px-3 py-2 min-w-[12rem]">
                  <button type="button" data-row-open className="text-left font-semibold text-gray-900 hover:underline" onClick={(e) => { e.stopPropagation(); onOpen(d) }}>{d.artist_name}</button>
                  <span className="block text-[11px] text-gray-400">{d.genre || ''}{d.file_count > 0 && <span className="inline-flex items-center gap-0.5 ml-1.5"><Paperclip size={9} /> {d.file_count}</span>}</span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap"><span className="inline-flex items-center gap-1.5 text-xs text-gray-700"><span className={`w-2 h-2 rounded-full ${STAGE_DOT[d.stage]}`} />{d.stage}</span>{d.stage === 'Passed' && d.passed_reason && <span className="block text-[10px] text-gray-400">{d.passed_reason}</span>}</td>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-700">{d.owner_name ? <span className="inline-flex items-center gap-1.5"><span className="w-5 h-5 rounded-full bg-boom-100 text-boom-700 text-[9px] font-bold inline-flex items-center justify-center">{initials(d.owner_name)}</span>{d.owner_name}</span> : <span className="text-gray-300">—</span>}</td>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-600">{d.deal_type || <span className="text-gray-300">—</span>}</td>
                <td className="px-3 py-2 whitespace-nowrap text-right tabular-nums text-gray-800">{Number(d.advance) > 0 ? fmtMoneyFull(d.advance) : <span className="text-gray-300">—</span>}</td>
                <td className={`px-3 py-2 whitespace-nowrap text-right tabular-nums text-xs ${STALE_TONE[stale]}`}>{LIVE_STAGES.includes(d.stage) ? `${d.days_in_stage ?? 0}d` : <span className="text-gray-300">—</span>}</td>
                <td className={`px-3 py-2 whitespace-nowrap text-xs ${FU_TONE[fu.kind]}`}>{fu.kind === 'none' ? (d.stage === 'Passed' && d.revisit_date ? `Revisit ${shortDate(d.revisit_date)}` : '—') : fu.label}</td>
                <td className="px-3 py-2 text-xs text-gray-500 max-w-[16rem] truncate" title={eventLine({ kind: d.last_event_kind, body: d.last_event_body, to_stage: d.stage })}>{d.last_event_at ? `${eventLine({ kind: d.last_event_kind, body: d.last_event_body, to_stage: d.stage })} · ${relTime(d.last_event_at)}` : <span className="text-gray-300">—</span>}</td>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">{d.source || <span className="text-gray-300">—</span>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {deals.length === 0 && <p className="px-4 py-8 text-center text-sm text-gray-400" data-deal-list-empty>No deals match these filters.</p>}
    </div>
  )
}
