import { useEffect, useRef, useState } from 'react'
import { Trash2, Pin, PinOff, Clock, CheckCircle2, Circle } from 'lucide-react'

// The detail pane — Notes' editor, and the reason this rebuild exists.
//
// John chose "somewhere to write", so the body is the pane: a plain textarea
// filling the space, autosaving, with no save button. Everything else about the
// task sits in one quiet metadata line above it rather than in a form.
//
// ── Why the fields moved here rather than staying in a modal ────────────────
// The old page opened an edit form over the list to change a due date. In a
// two-pane layout the detail IS the form — the pane is already showing this
// task, so a modal on top of it would be a second copy of the same thing.
//
// ── The autosave contract ───────────────────────────────────────────────────
// `onEdit(id, field, value)` is called per keystroke and debounced upstream by
// useAutosave, which captures the id AT THE KEYSTROKE. This component must
// therefore never batch or delay on its own — doing so would reintroduce the
// exact race the hook exists to close.
//
// `prime` runs when the selection changes so the first render's controlled-input
// echo is recognised as "unchanged" and does not write an empty body over a real
// one.

const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent']
const CATEGORIES = ['General', 'Release', 'Marketing', 'A&R', 'Finance', 'Legal', 'Operations']

export default function TaskDetail({
  task,
  onEdit,
  onFlush,
  onPrime,
  onToggleStatus,
  onDelete,
  onSnooze,
  onTogglePin,
  pinned = false,
  releases = [],
  relativeDate,
  isOverdue,
  // The @mention flow. `team` is the roster; `onAssign(taskId, member)` hands the
  // task over and is what raises the notification preview upstream.
  team = [],
  onAssign,
}) {
  const lastId = useRef(null)

  // ── The draft, and why the inputs are not bound to `task` ─────────────────
  // They were, and the pane was unusable: `task` comes from the page's fetched
  // data, and `onEdit` only queues a debounced write, so the value a user typed
  // was not the value React rendered. Every keystroke echoed the SERVER's copy
  // back into the box.
  //
  // A controlled text input has to be driven by state that changes on the
  // keystroke. That is not a second source of truth for the note — it is a draft
  // of one field, reconciled by the write that is already happening.
  //
  // Keyed on `task.id` ONLY: re-seeding whenever `task` changes identity would
  // clobber what is being typed every time the autosave patches the task back
  // into the page's state.
  const [draft, setDraft] = useState({ description: '', notes: '' })
  useEffect(() => {
    setDraft({ description: task?.description ?? '', notes: task?.notes ?? '' })
  }, [task?.id])                              // eslint-disable-line react-hooks/exhaustive-deps

  // Selection changed: flush whatever was pending for the PREVIOUS task before
  // touching this one, then tell the autosave what the server already holds.
  useEffect(() => {
    if (!task) return
    if (lastId.current !== null && lastId.current !== task.id) onFlush?.()
    lastId.current = task.id
    onPrime?.(task.id, { description: task.description ?? '', notes: task.notes ?? '' })
  }, [task?.id])                              // eslint-disable-line react-hooks/exhaustive-deps

  // ── @mention ──────────────────────────────────────────────────────────────
  // Typing "@" in the title offers the roster; picking somebody hands the task
  // to them. This is the flow the two-pane rebuild dropped: it lived in the
  // add-task form's description field, and when that form went, so did the only
  // way to assign a task to anyone.
  //
  // It lives on the TITLE because that is where it was — you write "call @dylan"
  // and the @dylan is the assignment, not part of the sentence. The mention text
  // is stripped when it resolves.
  const [mention, setMention] = useState(null)   // { query, at } while open
  const matches = mention
    ? team.filter((m) => m && m.name && m.name.toLowerCase().includes(mention.query)).slice(0, 6)
    : []

  // Watch the TITLE for an @ that has not been closed by a space yet.
  const titleChange = (value) => {
    edit('description', value)
    const at = value.lastIndexOf('@')
    if (at === -1) { setMention(null); return }
    const after = value.slice(at + 1)
    if (after.includes(' ')) { setMention(null); return }
    setMention({ query: after.toLowerCase(), at })
  }

  const pick = async (member) => {
    const at = mention?.at ?? -1
    // Strip the "@query" out of the title — it was an instruction, not text.
    const cleaned = at >= 0
      ? (draft.description.slice(0, at) + draft.description.slice(at + 1 + (mention?.query.length || 0))).trim()
      : draft.description
    setMention(null)
    setDraft((d) => ({ ...d, description: cleaned }))
    onEdit?.(task.id, 'description', cleaned)
    await onFlush?.()          // the title must land before the task moves owner
    onAssign?.(task.id, member)
  }

  const edit = (field, value) => {
    setDraft(d => ({ ...d, [field]: value }))   // instant, local
    onEdit?.(task.id, field, value)             // debounced, upstream
  }

  if (!task) {
    return (
      <div className="flex-1 flex items-center justify-center text-[13px] text-gray-300">
        Select a task
      </div>
    )
  }

  const done = task.status === 'Done'
  const overdue = !done && isOverdue?.(task.due_date)
  const field = 'w-full px-2 py-1 text-[12px] border border-rule rounded-md bg-card'

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Title. Edits in place like everything else — it is the note's first
          line, which is exactly what Notes does with it. */}
      <div className="relative">
        <input
          value={draft.description}
          onChange={(e) => titleChange(e.target.value)}
          onBlur={() => { onFlush?.(); setTimeout(() => setMention(null), 150) }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && mention) { e.preventDefault(); setMention(null) }
            if (e.key === 'Enter' && matches.length) { e.preventDefault(); pick(matches[0]) }
          }}
          placeholder="Untitled — type @ to hand it to somebody"
          className={`w-full bg-transparent border-0 outline-none px-5 pt-5 pb-1 text-[19px] font-bold tracking-tight ${
            done ? 'text-gray-400 line-through' : 'text-gray-900'}`}
        />
        {/* Blur is delayed above so a click here lands before the menu closes. */}
        {mention && matches.length > 0 && (
          <div className="absolute left-5 right-5 top-full z-20 -mt-1 bg-card border border-rule rounded-lg shadow-lg overflow-hidden">
            <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-400 border-b border-divider">
              Assign to
            </div>
            {matches.map((m) => (
              <button key={m.id} type="button" onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(m)}
                className="w-full text-left px-3 py-2 text-[13px] hover:bg-boom-50 flex items-center gap-2">
                <span className="font-semibold text-gray-800">{m.name}</span>
                {m.email && <span className="text-[11px] text-gray-400 truncate">{m.email}</span>}
              </button>
            ))}
          </div>
        )}
        {mention && matches.length === 0 && mention.query.length > 0 && (
          <div className="absolute left-5 right-5 top-full z-20 -mt-1 bg-card border border-rule rounded-lg px-3 py-2 text-[12px] text-gray-400">
            Nobody on the team matches “{mention.query}”.
          </div>
        )}
      </div>

      {/* One quiet line of metadata. No chips, no colour — except an overdue
          date, the only fact here that is a problem rather than an attribute. */}
      <div className="flex flex-wrap items-center gap-2 px-5 pb-3 text-[12px] text-gray-400 border-b border-divider">
        <button onClick={() => onToggleStatus?.(task)}
          className="inline-flex items-center gap-1.5 hover:text-gray-700">
          {done ? <CheckCircle2 size={13} className="text-emerald-500" /> : <Circle size={13} />}
          {done ? 'Done' : 'To do'}
        </button>
        <span className="text-gray-200">·</span>
        <select value={task.priority || 'Medium'}
          onChange={(e) => { onEdit?.(task.id, 'priority', e.target.value); onFlush?.() }}
          className="bg-transparent border-0 outline-none text-gray-500 cursor-pointer hover:text-gray-700">
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <span className="text-gray-200">·</span>
        <select value={task.category || 'General'}
          onChange={(e) => { onEdit?.(task.id, 'category', e.target.value); onFlush?.() }}
          className="bg-transparent border-0 outline-none text-gray-500 cursor-pointer hover:text-gray-700">
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="text-gray-200">·</span>
        <input type="date" value={task.due_date ? String(task.due_date).slice(0, 10) : ''}
          onChange={(e) => { onEdit?.(task.id, 'due_date', e.target.value || null); onFlush?.() }}
          className={`bg-transparent border-0 outline-none cursor-pointer ${
            overdue ? 'text-rose-600 font-semibold' : 'text-gray-500 hover:text-gray-700'}`} />
        {task.due_date && relativeDate && (
          <span className={overdue ? 'text-rose-600' : 'text-gray-300'}>{relativeDate(task.due_date)}</span>
        )}

        <span className="ml-auto inline-flex items-center gap-3">
          <button onClick={() => onSnooze?.(task)} title="Push out a week"
            className="hover:text-gray-700"><Clock size={13} /></button>
          <button onClick={() => onTogglePin?.(task.id)} title={pinned ? 'Unpin' : 'Pin to the top'}
            className="hover:text-gray-700">{pinned ? <PinOff size={13} /> : <Pin size={13} />}</button>
          <button onClick={() => onDelete?.(task.id)} title="Delete"
            className="hover:text-rose-500"><Trash2 size={13} /></button>
        </span>
      </div>

      {/* The body. This is the pane. */}
      <textarea
        value={draft.notes}
        onChange={(e) => edit('notes', e.target.value)}
        onBlur={() => onFlush?.()}
        placeholder="Write…"
        className="flex-1 w-full resize-none bg-transparent border-0 outline-none px-5 py-4 text-[14px] leading-relaxed text-gray-800 placeholder:text-gray-300"
      />

      {/* A task attached to a release keeps that link — it was on the old page
          and dropping it silently is exactly what the rebuild must not do. */}
      {releases.length > 0 && (
        <div className="px-5 py-2.5 border-t border-divider flex items-center gap-2 text-[12px] text-gray-400">
          <span>Release</span>
          <select value={task.release_id || ''}
            onChange={(e) => { onEdit?.(task.id, 'release_id', e.target.value || null); onFlush?.() }}
            className={field}>
            <option value="">None</option>
            {releases.map((r) => (
              <option key={r.id} value={r.id}>{r.project_name || r.title || `#${r.id}`}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}
