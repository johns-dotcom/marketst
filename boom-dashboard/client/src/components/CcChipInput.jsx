import { useState, useRef } from 'react'

// Chip-style email input used for CC fields across the app. Wraps a flex
// container of removable chips + an inline text input. Suggestions are
// filtered live from the team roster (name / email substring). Behavior:
//   • comma / semicolon / Enter / Tab on the input  → commit the typed value
//   • Backspace on an empty input                   → remove the last chip
//   • Paste — multi-line / comma / semicolon split → bulk-add chips
//   • Click an autocomplete suggestion             → add that teammate
//   • X button on a chip                            → remove that chip
// Invalid emails get a red chip but stay in the list so the user can fix or
// delete them — silently dropping looked broken in earlier UX tests.
const EMAIL_RE_CHIP = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function CcChipInput({ value, onChange, disabled, team, excludeEmail, placeholder, inputSty, C }) {
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const inputRef = useRef(null)

  const list = Array.isArray(value) ? value : []
  const excludeLower = String(excludeEmail || '').toLowerCase()

  const commit = (raw) => {
    const parts = String(raw || '').split(/[,;\n]/).map(p => p.trim()).filter(Boolean)
    if (!parts.length) return
    const lower = new Set(list.map(e => e.toLowerCase()))
    const next = [...list]
    for (const p of parts) {
      const k = p.toLowerCase()
      if (k === excludeLower || lower.has(k)) continue
      lower.add(k); next.push(p)
    }
    onChange(next)
    setDraft('')
  }

  const removeAt = (idx) => {
    const next = list.slice()
    next.splice(idx, 1)
    onChange(next)
  }

  // Filtered teammate suggestions — name OR email substring match, exclude
  // anyone already chipped or the To recipient. Capped at 6 to keep the
  // dropdown compact.
  const suggestions = (() => {
    if (!focused) return []
    const q = draft.trim().toLowerCase()
    const chipped = new Set(list.map(e => e.toLowerCase()))
    const out = []
    for (const u of (team || [])) {
      const email = String(u.email || '').toLowerCase()
      if (!email || chipped.has(email) || email === excludeLower) continue
      if (!q) { out.push(u); if (out.length >= 6) break; continue }
      const name = String(u.name || '').toLowerCase()
      if (email.includes(q) || name.includes(q)) {
        out.push(u)
        if (out.length >= 6) break
      }
    }
    return out
  })()

  const onKeyDown = (e) => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === 'Tab') && draft.trim()) {
      if (suggestions.length > 0 && (e.key === 'Enter' || e.key === 'Tab') && activeSuggestion >= 0 && activeSuggestion < suggestions.length) {
        e.preventDefault()
        commit(suggestions[activeSuggestion].email)
        setActiveSuggestion(0)
        return
      }
      e.preventDefault()
      commit(draft)
      setActiveSuggestion(0)
    } else if (e.key === 'Backspace' && !draft && list.length) {
      e.preventDefault()
      removeAt(list.length - 1)
    } else if (e.key === 'ArrowDown' && suggestions.length) {
      e.preventDefault()
      setActiveSuggestion(i => Math.min(i + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp' && suggestions.length) {
      e.preventDefault()
      setActiveSuggestion(i => Math.max(i - 1, 0))
    } else if (e.key === 'Escape') {
      setFocused(false)
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <div
        onClick={() => inputRef.current?.focus()}
        style={{
          ...inputSty, width: '100%', minHeight: 36,
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4,
          padding: '4px 6px', cursor: disabled ? 'default' : 'text',
        }}
      >
        {list.map((email, idx) => {
          const valid = EMAIL_RE_CHIP.test(email)
          return (
            <span
              key={`${email}-${idx}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                background: valid ? (C.isDark ? '#1e3a5f' : '#eff6ff') : (C.isDark ? '#3f1d1d' : '#fee2e2'),
                color: valid ? (C.isDark ? '#bfdbfe' : '#1e40af') : (C.isDark ? '#fecaca' : '#991b1b'),
                border: '1px solid ' + (valid ? (C.isDark ? '#1d4ed8' : '#bfdbfe') : (C.isDark ? '#7f1d1d' : '#fca5a5')),
                borderRadius: 12, padding: '2px 8px', fontSize: 12, fontWeight: 600,
                maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}
              title={valid ? email : `${email} — not a valid email`}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{email}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); removeAt(idx) }}
                  style={{
                    background: 'transparent', border: 'none', color: 'inherit',
                    cursor: 'pointer', padding: 0, lineHeight: 1,
                    fontFamily: 'inherit', fontSize: 13, opacity: .7,
                  }}
                  title="Remove"
                >×</button>
              )}
            </span>
          )
        })}
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setActiveSuggestion(0) }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setTimeout(() => setFocused(false), 120)
            if (draft.trim()) commit(draft)
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text')
            if (text && /[,;\n]/.test(text)) {
              e.preventDefault()
              commit(text)
            }
          }}
          disabled={disabled}
          placeholder={list.length ? '' : (placeholder || 'Type a name or email, press Enter')}
          style={{
            background: 'transparent', border: 'none', outline: 'none',
            color: C.text, fontFamily: 'inherit', fontSize: 13,
            flex: 1, minWidth: 120, padding: '4px 2px',
          }}
        />
      </div>

      {focused && suggestions.length > 0 && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
            background: C.cardBg, border: '1px solid ' + C.border, borderRadius: 8,
            boxShadow: C.shadow, zIndex: 50, overflow: 'hidden',
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {suggestions.map((u, idx) => (
            <button
              type="button"
              key={u.email}
              onClick={() => { commit(u.email); inputRef.current?.focus() }}
              onMouseEnter={() => setActiveSuggestion(idx)}
              style={{
                width: '100%', textAlign: 'left', padding: '8px 12px',
                background: idx === activeSuggestion ? C.elevBg : 'transparent',
                border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: C.text,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600 }}>{u.name || u.email}</span>
              <span style={{ fontSize: 12, color: C.textMuted }}>{u.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export { EMAIL_RE_CHIP }
