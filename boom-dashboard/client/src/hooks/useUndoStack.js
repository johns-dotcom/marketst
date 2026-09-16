import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A linear undo / redo stack for field edits, guarded against conflicts.
 *
 * ── Why this is not the toast it replaces ──
 * The Payment Dashboard had ONE undo slot on a 6-second timer, replaced by the
 * next action. That is right for "I just did the wrong thing" and useless for
 * editing a row: the second edit throws away the ability to undo the first.
 *
 * ── An undo is a WRITE, which is the whole difficulty ──
 * Undo here is not a rollback. There is no transaction to abort — the edit was
 * committed the moment it was made — so undoing means writing the old value
 * back, and that write can land on top of a change somebody else made in
 * between. So every write carries the value it EXPECTS to find, the server puts
 * that expectation in the UPDATE's own WHERE clause, and a mismatch comes back
 * 409 with the value the row actually holds. See `expect` in
 * PUT /bk/entries/:id.
 *
 * ── An entry holds MANY writes, deliberately ──
 * Marking an invoice paid sets several columns and cascades across a split
 * family. If a stack entry were one field, that would be one action needing
 * four undos, and a partial undo would leave the family half-paid. One entry,
 * a list of writes, applied in reverse.
 *
 * ── What it does NOT do ──
 * It is cleared on reload, by design (John's call). An undo applied an hour
 * later reverts a field to a value from a different sitting, and the older the
 * entry the likelier its expectation is stale — which would turn the guard from
 * a safety net into a wall of refusals.
 *
 * A multi-write entry that conflicts HALFWAY is reported as partial rather than
 * hidden: the writes before the conflict already landed and there is no honest
 * way to unwind them without hitting the same race again. `conflict.applied`
 * says how many, so the message can say so instead of implying nothing changed.
 */

const LIMIT = 50

export default function useUndoStack({ apply, enabled = true }) {
  // `stack` is the full history; `index` is how many of it are currently
  // applied. Undo moves the index down, redo moves it up, and a NEW edit
  // truncates everything above it — the standard editor model, so redo after a
  // fresh edit cannot resurrect a branch the user has walked away from.
  const [stack, setStack] = useState([])
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(null)

  // Kept in refs so the keyboard handler does not need to re-bind on every edit.
  const ref = useRef({ stack, index, busy })
  ref.current = { stack, index, busy }

  const push = useCallback((label, writes) => {
    const list = (Array.isArray(writes) ? writes : [writes]).filter(Boolean)
    if (!list.length) return
    setStack((s) => {
      const truncated = s.slice(0, ref.current.index)
      const next = [...truncated, { label, writes: list }]
      const over = Math.max(0, next.length - LIMIT)
      setIndex(next.length - over)
      return over ? next.slice(over) : next
    })
  }, [])

  const clear = useCallback(() => { setStack([]); setIndex(0); setConflict(null) }, [])

  // direction: 'undo' walks writes in REVERSE (so a composite entry unwinds in
  // the order it was built), 'redo' replays them forward.
  const run = useCallback(async (direction) => {
    const { stack: s, index: i, busy: b } = ref.current
    if (b) return
    const entry = direction === 'undo' ? s[i - 1] : s[i]
    if (!entry) return

    setBusy(true)
    setConflict(null)
    const writes = direction === 'undo' ? [...entry.writes].reverse() : entry.writes
    let applied = 0
    try {
      for (const w of writes) {
        const value  = direction === 'undo' ? w.from : w.to
        const expect = direction === 'undo' ? w.to   : w.from
        // eslint-disable-next-line no-await-in-loop
        const res = await apply({ id: w.id, field: w.field, value, expect })
        if (res && res.conflict) {
          setConflict({ ...res.conflict, label: entry.label, applied, total: writes.length })
          return
        }
        applied += 1
      }
      setIndex(direction === 'undo' ? i - 1 : i + 1)
    } finally {
      setBusy(false)
    }
  }, [apply])

  const undo = useCallback(() => run('undo'), [run])
  const redo = useCallback(() => run('redo'), [run])

  useEffect(() => {
    if (!enabled) return undefined
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.key.toLowerCase() !== 'z') return
      // Never steal the shortcut from a field somebody is typing in — the
      // browser's own text undo is what they mean there.
      const t = e.target
      const tag = t && t.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return
      e.preventDefault()
      if (e.shiftKey) redo(); else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, undo, redo])

  return {
    push, undo, redo, clear,
    canUndo: index > 0,
    canRedo: index < stack.length,
    depth: index,
    total: stack.length,
    nextUndoLabel: index > 0 ? stack[index - 1].label : null,
    nextRedoLabel: index < stack.length ? stack[index].label : null,
    busy,
    conflict,
    dismissConflict: () => setConflict(null),
  }
}
