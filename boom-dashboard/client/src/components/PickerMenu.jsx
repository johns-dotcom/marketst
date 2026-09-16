import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

// A dropdown you can type into — the thing a native <select> cannot be.
//
// Why it exists: the artist list is ~100 names and the category list ~30, and a
// native select gives you nothing but scrolling and first-letter jumping. On the
// Reports drill, picking the right artist meant scrolling a 100-item OS menu for
// every row.
//
// Shared by CategorySelect and ArtistSelect rather than written twice: those two
// already agree about the things that matter (a stored value the list doesn't
// know still renders; the menu carries its own "create/other" action), and a
// second implementation is how they would start disagreeing.
//
// PORTALLED, and positioned from the trigger's rect. The pickers sit inside the
// drill modal and inside scrollable tables, both of which have `overflow` set —
// an absolutely-positioned menu is CLIPPED by those, which is exactly the class
// of bug a native select never had and a hand-rolled one always does. Fixed
// positioning in a portal escapes it, and the menu flips above the trigger when
// there isn't room below.
//
// Keyboard: type to filter, ↑/↓ to move, Enter to take the highlighted row, Esc
// to close. Every key event stops propagating, because the review decks bind
// bare 1-9 / D / F and a filter box that also dismisses the card is worse than
// no filter box.
//
// Props:
//   value      current value (string) — shown on the trigger
//   options    [{ value, label }] — label may differ (the decks number theirs)
//   onSelect   (value) => void
//   actions    [{ key, label, onSelect, pinTop }] — pinned under the list
//              ("+ New…"), or ABOVE it with pinTop. Above matters for anything a
//              caller needs to be able to reach: the artist list is ~100 names,
//              so "— no artist —" pinned at the bottom was a control that
//              existed and could not be found.
//   onCreate   (query) => void — offered when what you typed matches nothing.
//              Takes the QUERY, so the name is not typed twice: the whole point
//              of the row is that you have already written it into the filter,
//              and an action that then opens an empty box is the same dead end
//              as having no action at all.
//   createLabel (query) => string — how that row reads ('+ Use "Roschmann"')
//   placeholder / title / disabled / className / style / autoFocus
export default function PickerMenu({
  value = '',
  options = [],
  // Optional sections: [{ key, label, items: [{ value, label }] }]. When given,
  // `options` is ignored for rendering — pass the SAME set through both, since
  // the create-row's duplicate test reads `options`.
  groups = [],
  onSelect,
  actions = [],
  onCreate,
  createLabel = (q) => `+ Use “${q}”`,
  placeholder = 'Select…',
  title,
  disabled = false,
  className = '',
  style,
  autoFocus = false,
  menuWidth,
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hi, setHi] = useState(0)
  const [rect, setRect] = useState(null)
  const triggerRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  const hit = (o) => !query || String(o.label ?? o.value).toLowerCase().includes(query.toLowerCase())
  // ── Sections ──────────────────────────────────────────────────────────────
  //
  // `groups` is [{ key, label, items: [{ value, label }] }]. Headers are rows so
  // they render in order, but they are NOT selectable: `isHeader` excludes them
  // from `take()` and from arrow navigation, which is index-based over this same
  // flat array. A header that could be highlighted is a header that Enter can
  // "pick", which would set the category to a section name.
  //
  // A group whose items all fail the filter is dropped entirely — a lone header
  // over nothing reads as a rendering bug.
  const matched = groups.length
    ? groups.flatMap((g) => {
      const items = (g.items || []).filter(hit)
      return items.length ? [{ isHeader: true, key: g.key, label: g.label }, ...items] : []
    })
    : options.filter(hit)
  // Selectable rows only, for "did the filter find anything" and for the
  // create-row's exact-match test.
  const matchedOptions = matched.filter((o) => !o.isHeader)
  // Offered only when the typed name isn't already there — an exact match means
  // the thing exists and "create" would be an invitation to make a duplicate.
  const q = query.trim()
  const exact = q && options.some((o) => String(o.value).toLowerCase() === q.toLowerCase())
  const createRow = (onCreate && q.length >= 2 && !exact)
    ? [{ key: '__create', label: createLabel(q), isAction: true, isCreate: true, onSelect: () => onCreate(q) }]
    : []
  // A pinned-top action stays put while you filter, so it is reachable at any
  // scroll position and any query.
  const topActions = actions.filter((a) => a.pinTop).map((a) => ({ ...a, isAction: true, isTop: true }))
  const rows = [...topActions, ...matched, ...createRow,
    ...actions.filter((a) => !a.pinTop).map((a) => ({ ...a, isAction: true }))]
  // With sections, row 0 is a HEADER — so a bare setHi(0) would park the
  // highlight on a section label. Reset to the first selectable row instead.
  const firstPick = Math.max(0, rows.findIndex((r) => !r.isHeader))

  const place = () => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const below = window.innerHeight - r.bottom
    // Flip up when the space below can't hold a usable menu — a picker that
    // opens into 40px of viewport is unusable in exactly the crowded places
    // this is used.
    const MENU_MAX = 300
    const up = below < 200 && r.top > below
    setRect({
      left: r.left,
      top: up ? undefined : r.bottom + 4,
      bottom: up ? window.innerHeight - r.top + 4 : undefined,
      width: menuWidth || Math.max(r.width, 200),
      maxHeight: Math.min(MENU_MAX, (up ? r.top : below) - 16),
    })
  }

  useLayoutEffect(() => { if (open) place() }, [open])
  useEffect(() => {
    if (!open) return undefined
    inputRef.current?.focus()
    // Reposition rather than drift: these live inside scrollable modals and
    // tables, so a menu pinned to stale coordinates would detach from its row.
    const onScroll = () => place()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (triggerRef.current?.contains(e.target)) return
      if (listRef.current?.parentElement?.contains(e.target)) return
      close()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (!open || hi < 0 || !listRef.current) return
    // Optional-called: not every environment implements it, and a picker must
    // not throw while someone is arrowing through it.
    listRef.current.children[hi]?.scrollIntoView?.({ block: 'nearest' })
  }, [hi, open])

  useEffect(() => { if (autoFocus) setOpen(true) }, [autoFocus])

  const close = () => { setOpen(false); setQuery(''); setHi(0) }
  const take = (row) => {
    close()
    if (row.isAction) row.onSelect?.()
    else onSelect?.(row.value)
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        title={title}
        onClick={(e) => { e.stopPropagation(); if (!disabled) setOpen((v) => !v) }}
        className={className}
        style={{ textAlign: 'left', ...(style || {}) }}>
        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value || placeholder}
        </span>
      </button>
      {open && rect && createPortal(
        <div
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed', left: rect.left, top: rect.top, bottom: rect.bottom,
            width: rect.width, zIndex: 9999,
            background: 'var(--color-bg-card, #fff)',
            border: '1px solid var(--color-border, #e5e7eb)',
            borderRadius: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
          <input
            ref={inputRef}
            value={query}
            placeholder="Type to filter…"
            onChange={(e) => { setQuery(e.target.value); setHi(firstPick) }}
            onKeyDown={(e) => {
              // The decks bind bare keys; never let a filter keystroke reach them.
              e.stopPropagation()
              // Step OVER headers. `step` walks until it finds a selectable row
              // and returns the current index if there is none in that
              // direction, so the highlight never parks on a section label.
              const step = (from, dir) => {
                for (let i = from + dir; i >= 0 && i < rows.length; i += dir) {
                  if (!rows[i]?.isHeader) return i
                }
                return from
              }
              if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => step(i, 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => step(i, -1)) }
              else if (e.key === 'Enter') { e.preventDefault(); if (rows[hi] && !rows[hi].isHeader) take(rows[hi]) }
              else if (e.key === 'Escape') { e.preventDefault(); close() }
            }}
            style={{
              border: 'none', borderBottom: '1px solid var(--color-border, #e5e7eb)',
              padding: '7px 10px', fontSize: 12.5, fontFamily: 'inherit', outline: 'none',
              background: 'transparent', color: 'var(--color-text, #111)',
            }} />
          <div ref={listRef} style={{ overflowY: 'auto', maxHeight: rect.maxHeight }}>
            {/* Tested against MATCHED options, not against `rows`. With a
                "+ New category…" action pinned underneath, the list is never
                literally empty — so a search that found nothing rendered a lone
                create button and no explanation of why the list vanished. */}
            {matchedOptions.length === 0 && (
              <div style={{ padding: '10px', fontSize: 12, color: 'var(--color-text-faint, #9ca3af)' }}>
                Nothing matches “{query}”.{createRow.length ? ' Add it below.' : ''}
              </div>
            )}
            {rows.map((row, i) => (
              row.isHeader ? (
                <div
                  key={`__h_${row.key}`}
                  style={{
                    padding: '7px 10px 3px', fontSize: 10, fontWeight: 800,
                    textTransform: 'uppercase', letterSpacing: '.06em',
                    color: 'var(--color-text-faint, #9ca3af)',
                    borderTop: i > 0 ? '1px solid var(--color-border, #e5e7eb)' : 'none',
                    // Sticky so the section a long list is scrolled into stays
                    // named — otherwise the header scrolls away and the items
                    // below it are unlabelled again.
                    position: 'sticky', top: 0,
                    background: 'var(--color-bg-card, #fff)',
                  }}>
                  {row.label}
                </div>
              ) : (
              <button
                key={row.isAction ? `__a_${row.key}` : `${row.value}__${i}`}
                type="button"
                onMouseEnter={() => setHi(i)}
                onClick={() => take(row)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', border: 'none',
                  padding: '6px 10px', fontSize: 12.5, fontFamily: 'inherit', cursor: 'pointer',
                  background: i === hi ? 'var(--color-gray-100, #f3f4f6)' : 'transparent',
                  color: row.isCreate ? 'var(--color-text, #111)'
                    : row.isAction ? 'var(--color-text-faint, #6b7280)' : 'var(--color-text, #111)',
                  fontWeight: !row.isAction && row.value === value ? 800 : 500,
                  borderTop: row.isAction && !row.isTop && i > 0
                    && !rows[i - 1]?.isAction && !rows[i - 1]?.isHeader
                    ? '1px solid var(--color-border, #e5e7eb)' : 'none',
                  borderBottom: row.isTop && !rows[i + 1]?.isTop
                    ? '1px solid var(--color-border, #e5e7eb)' : 'none',
                }}>
                {row.label ?? row.value}
              </button>
              )
            ))}
          </div>
        </div>, document.body)}
    </>
  )
}
