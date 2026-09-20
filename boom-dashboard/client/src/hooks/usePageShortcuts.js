import { useEffect } from 'react'
import useHotkeys from './useHotkeys'
import { useShortcuts } from '../context/ShortcutsContext'
import { PAGE_KEYS } from '../lib/shortcuts'

// Bind a page's handlers to ITS keys from lib/shortcuts.PAGE_KEYS, and tell
// the ? help which page is open. Handlers are keyed by the spec string:
//
//   usePageShortcuts('/flags', { j: next, k: prev, Enter: open, 'shift+a': all })
//
// A key in PAGE_KEYS with no handler is a bug in the page (the help would
// advertise a dead key) and is reported in dev; a handler for a key not in
// PAGE_KEYS is refused, so nothing is bound the help does not know about.
export default function usePageShortcuts(path, handlers, { enabled = true } = {}) {
  const { setPage } = useShortcuts()
  const keys = PAGE_KEYS[path] || []
  useEffect(() => {
    setPage(enabled ? { path, keys } : null)
    return () => setPage(null)
  }, [path, enabled]) // eslint-disable-line react-hooks/exhaustive-deps
  if (import.meta.env?.DEV) {
    for (const k of keys) if (!(k.spec in handlers)) console.warn(`[shortcuts] ${path}: key "${k.spec}" is advertised but not bound`)
    for (const spec of Object.keys(handlers)) if (!keys.some((k) => k.spec === spec)) console.warn(`[shortcuts] ${path}: handler for "${spec}" is not in PAGE_KEYS`)
  }
  useHotkeys(enabled ? keys.filter((k) => typeof handlers[k.spec] === 'function').map((k) => ({ key: k.key, meta: k.meta, shift: k.shift, handler: handlers[k.spec] })) : [])
}
