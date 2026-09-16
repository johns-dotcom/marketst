import { useEffect, useRef } from 'react'

function isInputFocused() {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

/**
 * useHotkeys — declarative keyboard shortcuts.
 *
 * Each shortcut: { key, meta?, shift?, handler }
 *   key   — e.key value ('n', 'Enter', 'ArrowLeft', '?', '1', '/', etc.)
 *   meta  — requires Cmd (Mac) or Ctrl (Win)
 *   shift — requires Shift (for letter keys)
 *   handler — callback(event)
 *
 * Rules:
 *   • Meta shortcuts fire even when an input is focused (Cmd+Enter, Cmd+K, etc.)
 *   • Non-meta shortcuts are ignored when an input/textarea/select is focused.
 *   • For non-letter keys like '?' that inherently need shift, don't set shift:true.
 */
export default function useHotkeys(shortcuts) {
  const ref = useRef(shortcuts)
  ref.current = shortcuts

  useEffect(() => {
    function handler(e) {
      for (const s of ref.current) {
        const wantKey = s.key
        const pressedKey = e.key

        // Key matching — case-insensitive for single chars, exact for named keys
        const match = wantKey.length === 1
          ? pressedKey.toLowerCase() === wantKey.toLowerCase()
          : pressedKey === wantKey
        if (!match) continue

        // Meta (Cmd/Ctrl)
        const wantMeta = s.meta || false
        const hasMeta = e.metaKey || e.ctrlKey
        if (wantMeta && !hasMeta) continue
        if (!wantMeta && hasMeta) continue

        // Shift — only enforced when explicitly required
        if (s.shift && !e.shiftKey) continue
        // Block unintended shift+letter (typing capital letters)
        if (!s.shift && e.shiftKey && wantKey.length === 1 && /[a-z]/i.test(wantKey)) continue

        // Non-meta shortcuts: skip when typing in an input
        if (!wantMeta && isInputFocused()) continue

        e.preventDefault()
        s.handler(e)
        return
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
}
