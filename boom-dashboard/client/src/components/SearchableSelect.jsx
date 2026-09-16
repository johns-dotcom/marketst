import { useState, useRef, useEffect } from 'react'

/**
 * A searchable select dropdown — type to filter, click or arrow-key to select.
 *
 * Props:
 *   value       — current selected value (string)
 *   onChange     — called with new value when selected
 *   options      — array of strings to choose from
 *   placeholder  — placeholder text when no value selected
 *   style        — style object for the input
 *   allLabel     — label for the "all" / reset option (e.g., "All artists")
 */
export default function SearchableSelect({ value, onChange, options, placeholder, style = {}, allLabel }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(-1)
  const wrapRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Scroll highlighted into view
  useEffect(() => {
    if (highlighted >= 0 && listRef.current) {
      const el = listRef.current.children[highlighted]
      if (el) el.scrollIntoView({ block: 'nearest' })
    }
  }, [highlighted])

  const filtered = query
    ? options.filter(o => o.toLowerCase().includes(query.toLowerCase()))
    : options

  const handleSelect = (val) => {
    onChange(val)
    setOpen(false)
    setQuery('')
    setHighlighted(-1)
  }

  const handleKeyDown = (e) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true)
      e.preventDefault()
      return
    }
    if (!open) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted(h => Math.min(h + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted(h => Math.max(h - 1, -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlighted >= 0 && highlighted < filtered.length) {
        handleSelect(filtered[highlighted])
      } else if (filtered.length === 1) {
        handleSelect(filtered[0])
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
      setQuery('')
    }
  }

  const displayValue = open ? query : (value || '')

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        type="text"
        value={displayValue}
        placeholder={placeholder || 'Search...'}
        onChange={e => {
          setQuery(e.target.value)
          setHighlighted(-1)
          if (!open) setOpen(true)
          // If cleared, reset selection
          if (!e.target.value && value) onChange('')
        }}
        onFocus={() => { setOpen(true); setQuery('') }}
        onKeyDown={handleKeyDown}
        style={{
          ...style,
          cursor: 'text',
        }}
      />
      {open && (
        <div
          ref={listRef}
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0,
            maxHeight: 240, overflowY: 'auto', zIndex: 50,
            background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)', marginTop: 4,
          }}
        >
          {allLabel && (
            <div
              onClick={() => handleSelect('')}
              style={{
                padding: '7px 12px', fontSize: 12, cursor: 'pointer',
                color: !value ? '#334155' : '#999', fontWeight: !value ? 700 : 400,
                background: highlighted === -1 ? '#f9fafb' : 'transparent',
                borderBottom: '1px solid #f3f4f6',
              }}
              onMouseEnter={() => setHighlighted(-1)}
            >
              {allLabel}
            </div>
          )}
          {filtered.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: 12, color: '#aaa', textAlign: 'center' }}>
              No matches
            </div>
          ) : (
            filtered.map((opt, idx) => (
              <div
                key={opt}
                onClick={() => handleSelect(opt)}
                style={{
                  padding: '7px 12px', fontSize: 12, cursor: 'pointer',
                  color: opt === value ? '#334155' : '#333',
                  fontWeight: opt === value ? 700 : 400,
                  background: highlighted === idx ? '#f3f4f6' : 'transparent',
                }}
                onMouseEnter={() => setHighlighted(idx)}
              >
                {opt}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
