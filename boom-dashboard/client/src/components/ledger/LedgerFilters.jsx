import { useEffect, useRef, useState } from 'react'
import { SlidersHorizontal, X, Bookmark, BookmarkPlus, AlertTriangle, ChevronDown } from 'lucide-react'

// The Ledger's filter chrome (2026-09-20, John: "Filters button + chips + URL
// + saved views"). Nine dropdowns used to sit in two rows above the table;
// they live behind ONE button now, every active one shows as a removable chip,
// and a set of filters can be saved under a name. The page owns the state and
// the URL sync; these components only render it.
//
//   fields: [{ key, label, value, onChange, options: [{ value, label }] }]
//           (or `render` for a custom control, e.g. the artist typeahead)

export function FilterPopover({ fields, activeCount = 0, onClearAll, C, buttonStyle }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button" onClick={() => setOpen((v) => !v)} data-ledger-filters-button
        style={{ ...buttonStyle, display: 'inline-flex', alignItems: 'center', gap: 5, ...(activeCount ? { borderColor: C.text, color: C.text, fontWeight: 700 } : null) }}
        title="Every filter: QuickBooks, recoupable, flags, source, bulk deal, category, artist, payment status, method, amount">
        <SlidersHorizontal style={{ width: 13, height: 13 }} /> Filters{activeCount ? ` · ${activeCount}` : ''} <ChevronDown style={{ width: 11, height: 11 }} />
      </button>
      {open && (
        <div data-ledger-filters-popover style={{ position: 'absolute', left: 0, top: 'calc(100% + 6px)', zIndex: 220, width: 560, maxWidth: 'calc(100vw - 32px)', background: C.cardBg, border: `1.5px solid ${C.border}`, borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,.16)', padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: C.text }}>Filters</span>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {activeCount > 0 && <button type="button" onClick={onClearAll} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: C.textMuted }} data-ledger-filters-clear>Clear all</button>}
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted }}><X style={{ width: 14, height: 14 }} /></button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
            {fields.map((f) => (
              <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: C.textMuted, fontWeight: 700, minWidth: 0 }} data-ledger-filter={f.key}>
                {f.label}
                {f.render ? f.render() : (
                  <select value={f.value} onChange={(e) => f.onChange(e.target.value)} style={{ fontSize: 12, padding: '5px 8px', borderRadius: 7, border: `1px solid ${f.value ? C.text : C.border}`, background: C.selectBg, color: C.text, fontFamily: 'inherit', fontWeight: f.value ? 700 : 500 }}>
                    <option value="">{f.allLabel || `All ${f.label.toLowerCase()}`}</option>
                    {(f.options || []).map((o) => (typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>))}
                  </select>
                )}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const optionLabel = (f) => {
  if (f.display) return f.display
  const o = (f.options || []).find((x) => (typeof x === 'string' ? x : x.value) === f.value)
  return o ? (typeof o === 'string' ? o : o.label) : f.value
}

// One chip per active filter; × clears just that one.
export function ActiveChips({ fields, C }) {
  const active = fields.filter((f) => f.value !== '' && f.value != null && f.value !== false)
  if (!active.length) return null
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }} data-ledger-chips>
      {active.map((f) => (
        <span key={f.key} data-ledger-chip={f.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, padding: '3px 8px 3px 9px', borderRadius: 999, background: C.elevBg, border: `1px solid ${C.border}`, color: C.text }}>
          <span style={{ color: C.textMuted, fontWeight: 600 }}>{f.label}</span> {optionLabel(f)}
          <button type="button" onClick={() => f.onChange(f.clearValue !== undefined ? f.clearValue : '')} aria-label={`Clear ${f.label}`} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted, padding: 0, display: 'inline-flex' }}><X style={{ width: 11, height: 11 }} /></button>
        </span>
      ))}
    </div>
  )
}

// From/to on the invoice date, with the ranges people actually ask for.
const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const QUICK_RANGES = [
  ['all', 'All dates', () => ['', '']],
  ['month', 'This month', () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth(), 1)), iso(new Date(n.getFullYear(), n.getMonth() + 1, 0))] }],
  ['last', 'Last month', () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth() - 1, 1)), iso(new Date(n.getFullYear(), n.getMonth(), 0))] }],
  ['quarter', 'This quarter', () => { const n = new Date(); const q = Math.floor(n.getMonth() / 3) * 3; return [iso(new Date(n.getFullYear(), q, 1)), iso(new Date(n.getFullYear(), q + 3, 0))] }],
  ['ytd', 'This year', () => { const n = new Date(); return [iso(new Date(n.getFullYear(), 0, 1)), iso(n)] }],
  ['lastyear', 'Last year', () => { const n = new Date(); return [`${n.getFullYear() - 1}-01-01`, `${n.getFullYear() - 1}-12-31`] }],
]
export function DateRange({ from, to, onChange, C, inputStyle }) {
  const which = QUICK_RANGES.find(([, , fn]) => { const [a, b] = fn(); return a === from && b === to })?.[0] || (from || to ? 'custom' : 'all')
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} data-ledger-daterange>
      <select value={which} onChange={(e) => { const r = QUICK_RANGES.find(([k]) => k === e.target.value); if (r) { const [a, b] = r[2](); onChange(a, b) } }} style={inputStyle} title="Invoice date range" data-ledger-quickrange>
        {QUICK_RANGES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        {which === 'custom' && <option value="custom">Custom</option>}
      </select>
      <input type="date" value={from} max={to || undefined} onChange={(e) => onChange(e.target.value, to)} style={{ ...inputStyle, width: 130 }} title="From (invoice date)" data-ledger-from />
      <span style={{ color: C.textFaint, fontSize: 12 }}>→</span>
      <input type="date" value={to} min={from || undefined} onChange={(e) => onChange(from, e.target.value)} style={{ ...inputStyle, width: 130 }} title="To (invoice date)" data-ledger-to />
    </span>
  )
}

// Rows that need something: no document, no W-9, paid with no bank line, not
// in QuickBooks, or flagged. One toggle, defined once here for the summary and
// the filter to share.
export const needsAttention = (e, { qbConnected = false, isBankRow = () => false, bankUnverified = () => false } = {}) => {
  if (e.flagged) return 'flagged'
  if (!isBankRow(e)) {
    if (!e.has_invoice && !e.has_receipt && !e.receipt_filename && !e.invoice_filename) return 'no document'
    if (!e.has_w9 && !e.w9_entry_id && !e.is_reimbursement) return 'no W-9'
  }
  if (bankUnverified(e)) return 'paid, no bank line'
  if (qbConnected && e.in_quickbooks === 'No' && e.payment_status === 'Paid') return 'not in QuickBooks'
  return null
}
export function AttentionToggle({ on, count, onChange, C, buttonStyle }) {
  return (
    <button type="button" onClick={() => onChange(!on)} data-ledger-attention aria-pressed={on}
      title="Only rows that need something: no document, no W-9, paid with no bank line, not in QuickBooks, or flagged"
      style={{ ...buttonStyle, display: 'inline-flex', alignItems: 'center', gap: 5, ...(on ? { borderColor: '#d97706', color: '#b45309', fontWeight: 700, background: 'rgba(245,158,11,.08)' } : null) }}>
      <AlertTriangle style={{ width: 13, height: 13 }} /> Needs attention{count != null ? ` · ${count}` : ''}
    </button>
  )
}

// Saved views: a named set of filters, kept in this browser. Apply = one
// click; the URL then carries the same set so it can be pasted to someone.
const VIEWS_KEY = 'bk_ledger_views_v1'
const loadViews = () => { try { return JSON.parse(localStorage.getItem(VIEWS_KEY) || '[]') } catch { return [] } }
const saveViews = (v) => { try { localStorage.setItem(VIEWS_KEY, JSON.stringify(v)) } catch { /* private mode */ } }
export const BUILT_IN_VIEWS = [
  { id: 'unpaid-month', name: 'Unpaid, this month', params: { paid: 'Unpaid', range: 'month' } },
  { id: 'attention', name: 'Needs attention', params: { attention: '1' } },
  { id: 'not-qb', name: 'Not in QuickBooks', params: { qb: 'No', paid: 'Paid' } },
  { id: 'flagged', name: 'Flagged', params: { flag: 'Yes' } },
]
export function SavedViews({ current, onApply, C, isActive }) {
  const [views, setViews] = useState(loadViews)
  const save = () => {
    const name = window.prompt('Name this view (the current filters are saved)')
    if (!name?.trim()) return
    const next = [...views.filter((v) => v.name !== name.trim()), { id: `v${Date.now()}`, name: name.trim(), params: current }]
    setViews(next); saveViews(next)
  }
  const remove = (id) => { const next = views.filter((v) => v.id !== id); setViews(next); saveViews(next) }
  const all = [...BUILT_IN_VIEWS, ...views]
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }} data-ledger-views>
      <Bookmark style={{ width: 12, height: 12, color: C.textFaint }} />
      {all.map((v) => {
        const active = isActive?.(v.params)
        return (
          <span key={v.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
            <button type="button" onClick={() => onApply(v.params)} data-ledger-view={v.id}
              style={{ fontSize: 11.5, fontWeight: 700, padding: '3px 9px', borderRadius: 999, border: `1px solid ${active ? C.text : C.border}`, background: active ? C.text : C.cardBg, color: active ? C.cardBg : C.textMuted, cursor: 'pointer', fontFamily: 'inherit' }}>
              {v.name}
            </button>
            {!BUILT_IN_VIEWS.some((b) => b.id === v.id) && (
              <button type="button" onClick={() => remove(v.id)} aria-label={`Delete view ${v.name}`} title="Delete this saved view" style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textFaint, padding: '0 2px', display: 'inline-flex' }}><X style={{ width: 10, height: 10 }} /></button>
            )}
          </span>
        )
      })}
      <button type="button" onClick={save} data-ledger-view-save title="Save the current filters as a view" style={{ fontSize: 11.5, fontWeight: 700, padding: '3px 9px', borderRadius: 999, border: `1px dashed ${C.border}`, background: 'transparent', color: C.textMuted, cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <BookmarkPlus style={{ width: 11, height: 11 }} /> Save view
      </button>
    </div>
  )
}
