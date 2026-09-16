import { useState } from 'react'
import { Circle, CheckCircle2, Pin, GripVertical } from 'lucide-react'

// The list column of My Work — Notes' middle pane.
//
// Row shape is deliberately Notes': status dot · title · one line of the body ·
// a relative date on the right. Nothing else. The page previously carried
// coloured chips for 7 categories, 4 priorities and 3 statuses on every row,
// which is the "formatting" John did not like — scanning 8 open tasks should
// not require decoding a legend.
//
// ── One accent, spent on the only thing that should shout ──────────────────
// Priority is a single dot's WEIGHT, not a colour: urgent is filled and dark,
// low is a hairline. Category is small grey text. The one place colour appears
// is an overdue date, because that is the only fact on the row that is a
// problem rather than an attribute.
//
// Pure presentation. Every mutation is the page's — this file decides nothing,
// which is what lets it render under smoke on its own.

// Filled/dark for urgent down to a hairline for low. Weight carries priority so
// colour does not have to.
const PRIORITY_DOT = {
  Urgent: 'text-gray-900 fill-gray-900',
  High: 'text-gray-700 fill-gray-300',
  Medium: 'text-gray-400',
  Low: 'text-gray-300',
}

const firstLine = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > 90 ? t.slice(0, 90) + '…' : t
}

export default function TaskList({
  tasks = [],
  selectedId = null,
  onSelect,
  onToggleStatus,
  pinnedIds = [],
  onDragStart,
  onDrop,
  relativeDate,
  isOverdue,
  emptyText = 'Nothing here.',
}) {
  // Which row the cursor is over mid-drag, so there is a line showing where the
  // task will land. Rows were already draggable and the order already saved —
  // with no handle and no drop indicator there was nothing to suggest either,
  // which is indistinguishable from the feature not existing.
  const [overId, setOverId] = useState(null)
  if (!tasks.length) {
    return <div className="px-4 py-10 text-center text-[13px] text-gray-400">{emptyText}</div>
  }

  return (
    <ul className="divide-y divide-divider">
      {tasks.map((t) => {
        const done = t.status === 'Done'
        const selected = t.id === selectedId
        const pinned = pinnedIds.includes(t.id)
        const overdue = !done && isOverdue?.(t.due_date)
        const when = relativeDate?.(t.due_date)
        const body = firstLine(t.notes)
        return (
          <li
            key={t.id}
            draggable
            onDragStart={() => onDragStart?.(t.id)}
            onDragOver={(e) => { e.preventDefault(); if (overId !== t.id) setOverId(t.id) }}
            onDragLeave={() => setOverId((v) => (v === t.id ? null : v))}
            onDrop={() => { setOverId(null); onDrop?.(t.id) }}
            onDragEnd={() => setOverId(null)}
            onClick={() => onSelect?.(t.id)}
            className={`group cursor-pointer px-3 py-2.5 transition-colors ${
              overId === t.id ? 'border-t-2 border-t-boom-500' : ''} ${
              selected ? 'bg-boom-50' : 'hover:bg-gray-50'}`}
          >
            <div className="flex items-start gap-2.5">
              {/* The handle. Appears on hover so the resting list stays as quiet
                  as Notes' is, and `cursor-grab` says what it does. */}
              <GripVertical
                size={13}
                className="mt-[3px] flex-shrink-0 cursor-grab text-gray-200 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Drag to reorder"
              />
              {/* One click marks done, exactly as before — the circle is the
                  same control it has always been, just no longer sitting in a
                  coloured status chip. */}
              <button
                onClick={(e) => { e.stopPropagation(); onToggleStatus?.(t) }}
                className="mt-[3px] flex-shrink-0"
                title={done ? 'Mark as to do' : 'Mark as done'}
              >
                {done
                  ? <CheckCircle2 size={14} className="text-gray-300" />
                  : <Circle size={14} className={PRIORITY_DOT[t.priority] || 'text-gray-400'} strokeWidth={2} />}
              </button>

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className={`text-[13px] leading-snug truncate ${
                    done ? 'text-gray-400 line-through' : 'font-semibold text-gray-900'}`}>
                    {t.description || 'Untitled'}
                  </span>
                  {pinned && <Pin size={10} className="text-gray-300 flex-shrink-0" />}
                  {when && (
                    <span className={`ml-auto flex-shrink-0 text-[11px] tabular-nums ${
                      overdue ? 'text-rose-600 font-semibold' : 'text-gray-400'}`}>
                      {when}
                    </span>
                  )}
                </div>
                {/* The body preview. This is what makes it a note rather than a
                    to-do — and it is why the body is worth writing. */}
                <div className="flex items-baseline gap-2 mt-0.5">
                  <span className="text-[12px] text-gray-400 truncate">
                    {body || <span className="text-gray-300">No note</span>}
                  </span>
                  {t.category && (
                    <span className="ml-auto flex-shrink-0 text-[10px] text-gray-300 uppercase tracking-wide">
                      {t.category}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
