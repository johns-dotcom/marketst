// A notes field that behaves like a small document, stored as plain markdown-ish
// text (so `tasks.notes` stays TEXT and every other reader sees what was typed).
//
//   Rendered when idle — bullets, numbered lists, checkboxes (click to tick),
//   headings, **bold**, _italic_, `code`, bare links — and a textarea while
//   focused. Enter continues a list, Enter on an empty item ends it, Tab and
//   Shift+Tab indent, ⌘B / ⌘I wrap, ⌘⇧8 toggles bullets, Esc or ⌘Enter saves.
//   Saves on blur and 1.2s after the last keystroke; a checkbox saves at once.
//
//   compact  — the strip beside a task (no toolbar, clamped preview)
//   full     — the document view in the expanded row (toolbar, grows freely)
import { useEffect, useRef, useState } from 'react'
import { List, ListOrdered, CheckSquare, Bold, Italic, Heading2 } from 'lucide-react'

const LIST_RE = /^(\s*)([-*]\s\[[ xX]\]\s|[-*]\s|(\d+)\.\s)(.*)$/

// ── inline markdown → React nodes (no HTML is ever injected) ──
function inline(str, key = 0) {
  const out = []
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])|https?:\/\/[^\s<>)]+)/g
  let last = 0; let m; let i = 0
  while ((m = re.exec(str))) {
    if (m.index > last) out.push(str.slice(last, m.index))
    const k = `${key}-${i += 1}`
    if (m[2] || m[3]) out.push(<strong key={k}>{m[2] || m[3]}</strong>)
    else if (m[4]) out.push(<code key={k} className="px-1 rounded bg-gray-100 text-[0.92em]">{m[4]}</code>)
    else if (m[5] || m[6]) out.push(<em key={k}>{m[5] || m[6]}</em>)
    else out.push(<a key={k} href={m[0]} target="_blank" rel="noopener noreferrer" className="text-boom-600 underline" onClick={(e) => e.stopPropagation()}>{m[0].replace(/^https?:\/\//, '')}</a>)
    last = m.index + m[0].length
  }
  if (last < str.length) out.push(str.slice(last))
  return out
}

export function NotesView({ text, onToggleCheck, className = '' }) {
  const lines = String(text || '').split('\n')
  const blocks = []
  let para = []
  const flush = () => { if (para.length) { blocks.push(<p key={`p${blocks.length}`} className="my-0.5">{para.map((l, i) => <span key={i}>{i > 0 && <br />}{inline(l, i)}</span>)}</p>); para = [] } }
  lines.forEach((line, idx) => {
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    const li = line.match(LIST_RE)
    if (h) { flush(); const Tag = h[1].length === 1 ? 'h3' : 'h4'; blocks.push(<Tag key={idx} className={`font-semibold text-gray-900 mt-1.5 mb-0.5 ${h[1].length === 1 ? 'text-[1.05em]' : ''}`}>{inline(h[2], idx)}</Tag>); return }
    if (li) {
      flush()
      const depth = Math.floor(li[1].replace(/\t/g, '  ').length / 2)
      const check = li[2].match(/\[([ xX])\]/)
      const num = li[3]
      blocks.push(
        <div key={idx} className="flex items-start gap-1.5 my-0.5" style={{ paddingLeft: `${depth * 1.1}rem` }} data-notes-line={idx}>
          {check ? (
            <button type="button" role="checkbox" aria-checked={check[1] !== ' '} data-notes-check={idx}
              onClick={(e) => { e.stopPropagation(); onToggleCheck?.(idx) }}
              className={`mt-[0.2em] w-[1.05em] h-[1.05em] rounded border flex-shrink-0 inline-flex items-center justify-center text-[0.75em] leading-none ${check[1] !== ' ' ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-gray-400 text-transparent hover:border-gray-600'}`}>✓</button>
          ) : num ? <span className="text-gray-500 tabular-nums flex-shrink-0 min-w-[1.2em]">{num}.</span>
            : <span className="text-gray-500 flex-shrink-0 leading-[1.2]">•</span>}
          <span className={check && check[1] !== ' ' ? 'line-through text-gray-400' : ''}>{inline(li[4], idx)}</span>
        </div>)
      return
    }
    if (!line.trim()) { flush(); return }
    para.push(line)
  })
  flush()
  return <div className={`notes-view leading-snug text-gray-700 break-words ${className}`} data-notes-view>{blocks}</div>
}

// The line-level edits, pure over (text, selection) so they are testable and the
// toolbar and the keyboard share them.
function lineBounds(v, s, e) {
  const start = v.lastIndexOf('\n', s - 1) + 1
  const endIdx = v.indexOf('\n', Math.max(e, s))
  return [start, endIdx === -1 ? v.length : endIdx]
}
export function toggleMarker(v, s, e, kind) {
  const [a, b] = lineBounds(v, s, e)
  const lines = v.slice(a, b).split('\n')
  const mk = (i) => (kind === 'bullet' ? '- ' : kind === 'check' ? '- [ ] ' : `${i + 1}. `)
  const stripped = lines.map((l) => { const m = l.match(LIST_RE); return m ? [m[1], m[4], m[2]] : [l.match(/^\s*/)[0], l.trimStart(), null] })
  const allHave = stripped.every(([, , m]) => m && (kind === 'bullet' ? /^[-*]\s$/.test(m) : kind === 'check' ? /\[/.test(m) : /^\d/.test(m)))
  const next = stripped.map(([ind, rest], i) => (allHave ? ind + rest : ind + mk(i) + rest)).join('\n')
  const out = v.slice(0, a) + next + v.slice(b)
  return [out, a + next.length]
}
export function wrapSelection(v, s, e, mark) {
  const sel = v.slice(s, e)
  if (sel.startsWith(mark) && sel.endsWith(mark) && sel.length >= mark.length * 2) { const inner = sel.slice(mark.length, -mark.length); return [v.slice(0, s) + inner + v.slice(e), s, s + inner.length] }
  return [v.slice(0, s) + mark + sel + mark + v.slice(e), s + mark.length, e + mark.length]
}
export function toggleHeading(v, s, e) {
  const [a, b] = lineBounds(v, s, e)
  const line = v.slice(a, b)
  const next = /^##\s/.test(line) ? line.replace(/^##\s/, '') : /^#\s/.test(line) ? line.replace(/^#\s/, '## ') : `# ${line}`
  return [v.slice(0, a) + next + v.slice(b), a + next.length]
}
export function continueList(v, s, e) {
  const start = v.lastIndexOf('\n', s - 1) + 1
  const line = v.slice(start, s)
  const m = line.match(LIST_RE)
  if (!m) return null
  if (!m[4].trim() && e === s) { const out = v.slice(0, start) + m[1] + v.slice(s); return [out, start + m[1].length] } // empty item → end the list
  let marker = m[2]
  if (m[3]) marker = `${Number(m[3]) + 1}. `
  marker = marker.replace(/\[[xX]\]/, '[ ]')
  const ins = `\n${m[1]}${marker}`
  return [v.slice(0, s) + ins + v.slice(e), s + ins.length]
}
export function indentLines(v, s, e, out) {
  const [a, b] = lineBounds(v, s, e)
  const lines = v.slice(a, b).split('\n')
  const next = lines.map((l) => (out ? l.replace(/^ {1,2}/, '') : `  ${l}`)).join('\n')
  const delta = next.length - (b - a)
  return [v.slice(0, a) + next + v.slice(b), Math.max(a, s + (out ? Math.max(-2, delta) : 2)), Math.max(a, e + delta)]
}
export function toggleCheckAt(v, lineIdx) {
  const lines = v.split('\n')
  const l = lines[lineIdx]; if (l === undefined) return v
  lines[lineIdx] = /\[ \]/.test(l) ? l.replace('[ ]', '[x]') : l.replace(/\[[xX]\]/, '[ ]')
  return lines.join('\n')
}

export default function NotesEditor({ value, onChange, onSave, compact = false, placeholder = 'Notes…', className = '', autoFocus = false, ...rest }) {
  const [editing, setEditing] = useState(!!autoFocus)
  const ta = useRef(null)
  const caret = useRef(null)
  const saved = useRef(value || '')
  const timer = useRef(null)
  const v = value || ''
  const latest = useRef(v); latest.current = v

  // `saved` is the value the server holds (as far as this field knows) — a save
  // is sent only when the text moved away from it.
  const commit = (next) => { if (next !== saved.current) { saved.current = next; onSave?.(next) } }
  const schedule = (next) => { clearTimeout(timer.current); timer.current = setTimeout(() => commit(next), 1200) }
  // Unmounting (the row expands and the compact strip gives way to the full
  // editor) flushes a pending save rather than dropping it.
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); commit(latest.current) } }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!editing || !ta.current) return
    ta.current.focus()
    if (caret.current) { const [s, e] = caret.current; try { ta.current.setSelectionRange(s, e ?? s) } catch { /* jsdom */ } caret.current = null }
    else try { const n = ta.current.value.length; ta.current.setSelectionRange(n, n) } catch { /* jsdom */ }
  })
  const set = (next, s, e) => { caret.current = [s, e ?? s]; onChange(next); schedule(next) }

  const onKeyDown = (e) => {
    const el = e.target; const s = el.selectionStart; const en = el.selectionEnd
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); el.blur(); return }
    if (e.key === 'Enter' && !e.shiftKey) { const r = continueList(v, s, en); if (r) { e.preventDefault(); set(r[0], r[1]) } return }
    if (e.key === 'Tab') { const [a] = lineBounds(v, s, en); if (LIST_RE.test(v.slice(a, v.indexOf('\n', a) === -1 ? v.length : v.indexOf('\n', a))) || e.shiftKey) { e.preventDefault(); const r = indentLines(v, s, en, e.shiftKey); set(r[0], r[1], r[2]) } return }
    if (e.metaKey || e.ctrlKey) {
      const k = e.key.toLowerCase()
      if (k === 'b') { e.preventDefault(); const r = wrapSelection(v, s, en, '**'); set(r[0], r[1], r[2]) }
      else if (k === 'i') { e.preventDefault(); const r = wrapSelection(v, s, en, '_'); set(r[0], r[1], r[2]) }
      else if (e.shiftKey && (k === '8' || e.code === 'Digit8')) { e.preventDefault(); const r = toggleMarker(v, s, en, 'bullet'); set(r[0], r[1]) }
      else if (e.shiftKey && (k === '7' || e.code === 'Digit7')) { e.preventDefault(); const r = toggleMarker(v, s, en, 'number'); set(r[0], r[1]) }
      else if (e.shiftKey && (k === '9' || e.code === 'Digit9')) { e.preventDefault(); const r = toggleMarker(v, s, en, 'check'); set(r[0], r[1]) }
    }
  }
  const onBlur = () => { clearTimeout(timer.current); commit(v); setEditing(false) }
  const act = (fn) => (e) => {
    e.preventDefault(); e.stopPropagation()
    if (!editing) { setEditing(true) }
    const el = ta.current
    const s = el ? el.selectionStart : v.length; const en = el ? el.selectionEnd : v.length
    const r = fn(v, s, en); set(r[0], r[1], r[2])
  }
  const onToggleCheck = (idx) => { const next = toggleCheckAt(v, idx); onChange(next); clearTimeout(timer.current); commit(next) }
  const rows = Math.min(compact ? 8 : 40, Math.max(compact ? 1 : 4, v.split('\n').length + (compact ? 0 : 1)))
  const size = compact ? 'text-xs' : 'text-sm'

  return (
    <div className={`notes-editor ${className}`} data-notes-editor={compact ? 'compact' : 'full'} data-editing={editing ? '1' : '0'} onClick={(e) => e.stopPropagation()} {...rest}>
      {!compact && (
        <div className="flex items-center gap-0.5 mb-1 text-gray-500" data-notes-toolbar>
          {[['bullet', List, 'Bullet list (⌘⇧8)', (a, b, c) => toggleMarker(a, b, c, 'bullet')],
            ['number', ListOrdered, 'Numbered list (⌘⇧7)', (a, b, c) => toggleMarker(a, b, c, 'number')],
            ['check', CheckSquare, 'Checklist (⌘⇧9)', (a, b, c) => toggleMarker(a, b, c, 'check')],
            ['heading', Heading2, 'Heading', toggleHeading],
            ['bold', Bold, 'Bold (⌘B)', (a, b, c) => wrapSelection(a, b, c, '**')],
            ['italic', Italic, 'Italic (⌘I)', (a, b, c) => wrapSelection(a, b, c, '_')],
          ].map(([id, Icon, title, fn]) => (
            <button key={id} type="button" title={title} aria-label={title} onMouseDown={act(fn)} data-notes-tool={id}
              className="w-7 h-7 inline-flex items-center justify-center rounded hover:bg-gray-100 hover:text-gray-800"><Icon size={14} /></button>
          ))}
          <span className="ml-auto text-[10px] text-gray-400 hidden sm:inline">Enter continues a list · Tab indents · saves as you type</span>
        </div>
      )}
      {editing ? (
        <textarea ref={ta} value={v} onChange={(e) => { onChange(e.target.value); schedule(e.target.value) }} onKeyDown={onKeyDown} onBlur={onBlur}
          rows={rows} placeholder={placeholder} aria-label="Notes" spellCheck
          className={`w-full ${size} leading-snug text-gray-800 placeholder:text-gray-300 bg-card border border-rule rounded-md px-2 py-1 resize-none outline-none focus:ring-1 focus:ring-boom-300`} />
      ) : (
        <div role="textbox" tabIndex={0} aria-label="Notes" data-notes-open
          onClick={(e) => { if (!e.target.closest('a,button')) setEditing(true) }} onFocus={(e) => { if (e.target === e.currentTarget) setEditing(true) }}
          className={`w-full ${size} rounded-md px-2 py-1 border border-transparent cursor-text ${compact ? 'hover:border-rule max-h-[4.6rem] overflow-hidden' : 'min-h-[5rem] hover:bg-gray-50/60'}`}>
          {v.trim() ? <NotesView text={v} onToggleCheck={onToggleCheck} /> : <span className="text-gray-300">{placeholder}</span>}
        </div>
      )}
    </div>
  )
}
