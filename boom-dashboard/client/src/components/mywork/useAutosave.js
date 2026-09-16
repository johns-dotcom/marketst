import { useRef, useEffect, useCallback } from 'react'

/**
 * Debounced field autosave that cannot write to the wrong record.
 *
 * The Notes-app behaviour John asked for has no save button, which means the
 * write happens on a timer — and a timer is where this goes wrong.
 *
 * ── The failure this exists to prevent ──────────────────────────────────────
 * Type into task A, click task B before the debounce fires. The naive version
 * reads "the current task" when the timer lands and writes A's text onto B —
 * corrupting one note and losing the other. Every field here is therefore
 * captured WITH ITS ID at the moment of the keystroke; the flush uses that
 * captured id and never looks at what is selected now.
 *
 * ── And the other one ───────────────────────────────────────────────────────
 * A controlled textarea fires onChange when its value is set on mount. Left
 * unguarded that writes an empty body over a real one the instant you open a
 * task. `prime()` records what the server already has, and a save is skipped
 * when the value has not actually changed.
 *
 * Nothing here is React-specific beyond the hook wrapper: pending writes live
 * in a ref, so a re-render cannot drop them and a flush can run from an effect
 * teardown, which is what makes "flush on selection change" reliable.
 */
export default function useAutosave(save, { delay = 600 } = {}) {
  // { [`${id}:${field}`]: { id, field, value } } — keyed so the newest edit of
  // a field replaces the older one, but edits to DIFFERENT records coexist.
  const pending = useRef(new Map())
  const timer = useRef(null)
  const baseline = useRef(new Map())
  const saveRef = useRef(save)
  useEffect(() => { saveRef.current = save }, [save])

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (!pending.current.size) return
    // Take the whole batch and clear FIRST, so a keystroke landing mid-flush
    // starts a fresh pending set rather than being wiped by this one.
    const batch = [...pending.current.values()]
    pending.current = new Map()
    // Group by record: two fields edited on one task are one request.
    const byId = new Map()
    for (const p of batch) {
      if (!byId.has(p.id)) byId.set(p.id, {})
      byId.get(p.id)[p.field] = p.value
    }
    for (const [id, patch] of byId) {
      try {
        await saveRef.current(id, patch)
        for (const [field, value] of Object.entries(patch)) {
          baseline.current.set(`${id}:${field}`, value)
        }
      } catch {
        // Put it back so the next flush retries rather than silently dropping
        // somebody's writing.
        for (const [field, value] of Object.entries(patch)) {
          pending.current.set(`${id}:${field}`, { id, field, value })
        }
      }
    }
  }, [])

  /** Record what the server already holds, so mount does not save a no-op. */
  const prime = useCallback((id, values) => {
    for (const [field, value] of Object.entries(values || {})) {
      baseline.current.set(`${id}:${field}`, value ?? '')
    }
  }, [])

  /** A keystroke. The id is captured HERE, not read at flush time. */
  const change = useCallback((id, field, value) => {
    if (id == null) return
    const key = `${id}:${field}`
    if (baseline.current.get(key) === value) {
      // Back to what the server has — drop any pending write for it.
      pending.current.delete(key)
      return
    }
    pending.current.set(key, { id, field, value })
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, delay)
  }, [flush, delay])

  // A pending write must survive the component going away — closing the page
  // mid-sentence should not lose the sentence.
  useEffect(() => () => { flush() }, [flush])

  const hasPending = () => pending.current.size > 0
  return { change, flush, prime, hasPending }
}
