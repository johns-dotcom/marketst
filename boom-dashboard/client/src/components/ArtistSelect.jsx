import { useState, useRef, useEffect } from 'react'
import PickerMenu from './PickerMenu'

// An artist <select> that also takes a name it has never heard of.
//
// The sibling of CategorySelect, and it copies the behaviour that actually
// matters there: **a stored value that isn't in the list still renders**. A
// <select> whose value matches no <option> renders BLANK, which invites
// someone to silently reassign the row — and here unmatched is the NORMAL
// case, not the edge one. The roster holds 50 artists; roughly 90 distinct
// names appear in the ledger, because `expenses.artist` is free text and
// always has been.
//
// What it deliberately does NOT do, unlike CategorySelect: create anything.
// Categories are rows in `bk_categories`, so a new one has to be made before
// it can be picked. An artist is just a string on the expense — typing it IS
// the assignment. Auto-creating a roster entry would turn every typo into a
// permanent artist record that then needs merging.
//
// Styling comes in via className/style so this can sit on both the Tailwind
// pages and the inline-styled Bk pages, same as CategorySelect.
export default function ArtistSelect({
  value = '',
  onChange,
  options = [],
  className = '',
  style,
  disabled = false,
  placeholder = 'Artist…',
  title,
  allowClear = true,
  // What "— no artist —" hands back. Empty string for a row control, where
  // clearing IS the write. A BULK control needs a value it can hold and show
  // until the button is pressed — an empty string would read as "nothing chosen"
  // and leave the Apply button disabled, so no selection could ever be cleared.
  clearValue = '',
}) {
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { if (typing) inputRef.current?.focus() }, [typing])

  // Append the current value when the roster doesn't know it — the blank-select
  // problem above. Appended rather than sorted in, so the roster's own order is
  // untouched.
  const list = value && !options.includes(value) ? [...options, value] : options

  const commit = () => {
    const name = draft.replace(/\s+/g, ' ').trim()
    setTyping(false)
    setDraft('')
    if (name) onChange?.(name)
  }
  const cancel = () => { setTyping(false); setDraft('') }

  if (typing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Decks on other pages bind bare 1-9 / D / F keys; don't fire them
          // while someone is typing a name.
          e.stopPropagation()
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          else if (e.key === 'Escape') { e.preventDefault(); cancel() }
        }}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        placeholder="Artist name"
        maxLength={255}
        disabled={disabled}
        className={className}
        style={style}
      />
    )
  }

  // A filterable menu, not a native select. ~100 artists appear in the ledger,
  // so a native dropdown is a scrolling exercise on every row — and this
  // control's whole job is picking the RIGHT name out of a long list of similar
  // ones ("Adria Khan" vs "Adria Khan x Giraffage").
  return (
    <PickerMenu
      value={value}
      options={list.map((a) => ({ value: a, label: a }))}
      onSelect={(v) => onChange?.(v)}
      // Typing a name the roster has never heard of IS the assignment —
      // expenses.artist is free text — so the filter box doubles as the entry
      // box and the name is never typed twice. It still creates no roster
      // record: auto-creating one would turn every typo into a permanent artist
      // that then needs merging. The name simply appears in the ledger half of
      // the list from then on.
      onCreate={(q) => onChange?.(q)}
      createLabel={(q) => `+ Use “${q}” as the artist`}
      actions={[
        // Clearing is the same control as setting, so putting a row back into
        // "not attributed" doesn't need a separate undo to be discovered.
        // PINNED TOP. It was pinned under the list, which for ~100 artists meant
        // scrolling past every name to find it — John's "I want to be able to
        // mark as no artist" was a control that existed and could not be reached.
        ...(allowClear && (value || clearValue)
          ? [{ key: 'clear', label: '— no artist —', pinTop: true, onSelect: () => onChange?.(clearValue) }]
          : []),
        { key: 'other', label: '+ Someone else…', onSelect: () => setTyping(true) },
      ]}
      placeholder={placeholder}
      title={title}
      disabled={disabled}
      className={className}
      style={style}
    />
  )
}
