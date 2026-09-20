import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

// What the page under the cursor has bound, for the ? help (context-aware)
// and for the global ⌘Z. Pages register through hooks/usePageShortcuts; the
// help reads `page`; Layout's ⌘Z calls `undo` when a page has registered one.
const Ctx = createContext(null)
const NOOP = { page: null, setPage: () => {}, registerUndo: () => {}, runUndo: () => false }
export const useShortcuts = () => useContext(Ctx) || NOOP

export function ShortcutsProvider({ children }) {
  const [page, setPage] = useState(null)          // { path, keys: [{ key, meta, shift, label }] }
  const undoRef = useRef(null)
  const registerUndo = useCallback((fn) => { undoRef.current = typeof fn === 'function' ? fn : null }, [])
  const runUndo = useCallback(() => { if (!undoRef.current) return false; undoRef.current(); return true }, [])
  const value = useMemo(() => ({ page, setPage, registerUndo, runUndo, hasUndo: () => !!undoRef.current }), [page, registerUndo, runUndo])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
