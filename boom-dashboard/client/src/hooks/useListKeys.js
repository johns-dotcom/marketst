import { useCallback, useEffect, useRef } from 'react'

// Row navigation for any list page, driven by the DOM so a 4,000-line table
// only has to gain attributes, not state:
//
//   <tr data-row …>                       a row j / k can land on
//     <button data-key="p">Mark paid</button>   Enter / verbs click the matching control
//     <a data-row-open href=…>                  Enter prefers this; else the row itself
//     <input type="checkbox" data-key="x">      x selects
//
// The focused row carries data-row-focused="1" (index.css draws the rail) and
// is scrolled into view. Focus clears when the rows re-render away.
export default function useListKeys({ root = 'main', enabled = true } = {}) {
  const idx = useRef(-1)
  // Rows under a [hidden] ancestor are out; geometry is not consulted (jsdom has none).
  const rows = useCallback(() => Array.from((document.querySelector(root) || document).querySelectorAll('[data-row]')).filter((r) => !r.closest('[hidden]')), [root])
  const paint = useCallback(() => {
    const list = rows()
    list.forEach((r, i) => { if (i === idx.current) r.setAttribute('data-row-focused', '1'); else r.removeAttribute('data-row-focused') })
    const el = list[idx.current]
    if (el) { try { el.scrollIntoView({ block: 'nearest' }) } catch { /* jsdom */ } }
  }, [rows])
  const move = useCallback((d) => {
    const list = rows(); if (!list.length) return
    idx.current = idx.current < 0 ? (d > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, idx.current + d))
    paint()
  }, [rows, paint])
  const focused = useCallback(() => rows()[idx.current] || null, [rows])
  const click = (el) => { if (!el) return false; el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); return true }
  // Enter: the row's open control, else the row itself.
  const open = useCallback(() => { const r = focused(); if (!r) return false; return click(r.querySelector('[data-row-open]')) || click(r) }, [focused])
  // A verb key clicks the row control that carries it.
  const verb = useCallback((key) => { const r = focused(); if (!r) return false; return click(r.querySelector(`[data-key="${key}"]`)) }, [focused])
  useEffect(() => { if (!enabled) { idx.current = -1; paint() } }, [enabled, paint])
  return { next: () => move(1), prev: () => move(-1), open, verb, focused, clear: () => { idx.current = -1; paint() } }
}

// f: focus the page's filter box — the first [data-filter] input.
export const focusFilter = () => {
  const el = Array.from(document.querySelectorAll('[data-filter]')).find((x) => x.offsetParent !== null) || document.querySelector('[data-filter]')
  if (el) { el.focus(); el.select?.(); return true }
  return false
}
