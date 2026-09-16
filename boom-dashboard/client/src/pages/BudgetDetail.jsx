import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Loader, Plus, Trash2, Lock, Unlock, CheckCircle2, Save, X,
  AlertTriangle, ChevronDown, ChevronRight,
  Mic2, Sliders, Music2, Users, Plane, MoreHorizontal, Building2,
} from 'lucide-react'
import api from '../api'
import { fmtMoney } from '../utils'

// ── Constants ──────────────────────────────────────────────────────
// Section labels + column headers match the Excel templates exactly.
// Client keeps them here (not fetched) so the page renders instantly
// on load; server-side SECTION_SET is the source of truth for
// validation.
const SECTIONS = [
  { key: 'producers',        label: 'Producers',        qtyLabel: '# Tracks',  priceLabel: 'Price Per Unit', icon: Mic2,      tint: 'text-rose-600'    },
  { key: 'studio',           label: 'Studio',           qtyLabel: 'Days',       priceLabel: 'Rate Per Day',   icon: Building2, tint: 'text-amber-600'   },
  { key: 'mixing_mastering', label: 'Mixing/Mastering', qtyLabel: '# Tracks',   priceLabel: 'Day Rate',       icon: Sliders,   tint: 'text-emerald-600' },
  { key: 'musicians',        label: 'Musicians',        qtyLabel: 'Quantity',   priceLabel: 'Estimated Cost', icon: Users,     tint: 'text-sky-600'     },
  { key: 'travel',           label: 'Travel',           qtyLabel: 'Quantity',   priceLabel: 'Rate',           icon: Plane,     tint: 'text-violet-600'  },
  { key: 'other',            label: 'Other',            qtyLabel: 'Quantity',   priceLabel: 'Estimated Cost', icon: MoreHorizontal, tint: 'text-slate-500'   },
]
const CURRENCIES = [
  { value: 'USD', label: 'USD' }, { value: 'EUR', label: 'EUR' }, { value: 'GBP', label: 'GBP' },
  { value: 'CAD', label: 'CAD' }, { value: 'AUD', label: 'AUD' },
]

export default function BudgetDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [budget, setBudget] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('plan') // 'plan' | 'costs'
  const [artists, setArtists] = useState([])   // dropdown source
  const [releases, setReleases] = useState([]) // dropdown source

  const refetch = () => {
    setLoading(true)
    api.get(`/budgets/${id}`)
      .then(r => { setBudget(r.data?.data || null); setError(null) })
      .catch(err => setError(err?.response?.data?.error || err.message || 'Failed to load'))
      .finally(() => setLoading(false))
  }
  useEffect(refetch, [id])
  // Load artist + release rosters once for the header pickers. Cheap
  // best-effort — errors are swallowed since these are optional UX.
  useEffect(() => {
    api.get('/artists').then(r => setArtists(Array.isArray(r.data?.data) ? r.data.data : (Array.isArray(r.data) ? r.data : []))).catch(() => {})
    api.get('/releases').then(r => setReleases(Array.isArray(r.data?.data) ? r.data.data : (Array.isArray(r.data) ? r.data : []))).catch(() => {})
  }, [])

  const readOnly = budget?.status === 'locked'

  // Optimistic header field save — draft budgets update on blur;
  // amount fields update on Enter or blur. Rejects when locked.
  const updateHeader = async (patch) => {
    if (readOnly) return
    setBudget(b => ({ ...b, ...patch }))
    try {
      setSaving(true)
      const r = await api.put(`/budgets/${id}`, patch)
      if (r.data?.data) setBudget(b => ({ ...b, ...r.data.data }))
    } catch (err) {
      alert(`Save failed: ${err?.response?.data?.error || err.message}`)
      refetch()
    } finally { setSaving(false) }
  }

  const doTransition = async (verb) => {
    if (!window.confirm({
      approve: 'Approve this budget? Anyone can still edit line items until it is locked.',
      lock:    'Lock this budget? No more edits will be possible until unlocked.',
      reopen:  'Reopen this budget to a draft state?',
    }[verb])) return
    try {
      const r = await api.post(`/budgets/${id}/${verb}`)
      if (r.data?.data) setBudget(b => ({ ...b, ...r.data.data }))
    } catch (err) {
      alert(`${verb} failed: ${err?.response?.data?.error || err.message}`)
    }
  }

  const doDelete = async () => {
    if (!window.confirm(`Delete this budget? Line items will be removed. This cannot be undone.`)) return
    try {
      await api.delete(`/budgets/${id}`)
      navigate('/budget')
    } catch (err) {
      alert(`Delete failed: ${err?.response?.data?.error || err.message}`)
    }
  }

  if (loading && !budget) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="card p-12 flex items-center justify-center gap-2 text-sm text-gray-500">
          <Loader size={16} className="animate-spin" /> Loading budget…
        </div>
      </div>
    )
  }
  if (error || !budget) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="card p-12 text-center text-sm text-rose-700">{error || 'Not found'}</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <BackLink />
      {/* ── Header (Artist / Project / Type / Currency / Status) ── */}
      <div className="card p-5">
        <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Recording Budget</p>
            <h1 className="text-2xl font-bold text-gray-900 mt-1">
              {budget.artist_display || <span className="text-gray-400 italic">Unnamed artist</span>}
              {budget.project_title && <span className="text-gray-500 font-semibold">  ·  {budget.project_title}</span>}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <StatusChip status={budget.status} />
            {budget.status === 'draft' && (
              <button type="button" onClick={() => doTransition('approve')}
                className="btn-primary text-xs gap-1.5 inline-flex items-center">
                <CheckCircle2 size={13} /> Approve
              </button>
            )}
            {budget.status === 'approved' && (
              <>
                <button type="button" onClick={() => doTransition('lock')}
                  className="btn-secondary text-xs gap-1.5 inline-flex items-center">
                  <Lock size={13} /> Lock
                </button>
                <button type="button" onClick={() => doTransition('reopen')}
                  className="btn-secondary text-xs gap-1.5 inline-flex items-center">
                  <Unlock size={13} /> Reopen to draft
                </button>
              </>
            )}
            {budget.status === 'locked' && (
              <button type="button" onClick={() => doTransition('reopen')}
                className="btn-secondary text-xs gap-1.5 inline-flex items-center">
                <Unlock size={13} /> Unlock
              </button>
            )}
            {budget.status === 'draft' && (
              <button type="button" onClick={doDelete}
                className="text-xs font-semibold text-rose-600 hover:text-rose-700 px-2 py-1">
                <Trash2 size={13} className="inline mr-1" /> Delete
              </button>
            )}
          </div>
        </div>

        {/* Header field grid — Artist picker + Project title + Type +
            Currency + Track count. Locked = read-only. */}
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3 text-xs">
          <HeaderField label="Artist" className="md:col-span-2">
            {/* Combobox: filter the roster as you type; press Enter
                or blur to commit. Selecting a roster row sets
                artist_id + clears the freeform artist_name; typing
                a value that doesn't match commits as freeform
                (artist_name set, artist_id cleared). */}
            <ArtistPicker
              artists={artists}
              value={{ id: budget.artist_id, name: budget.artist_name, display: budget.artist_display }}
              disabled={readOnly}
              onPickRoster={(a) => updateHeader({ artist_id: a.id, artist_name: null })}
              onCommitFreeform={(name) => updateHeader({ artist_id: null, artist_name: name || null })}
            />
          </HeaderField>
          <HeaderField label="Project Title" className="md:col-span-2">
            <input
              type="text"
              value={budget.project_title || ''}
              disabled={readOnly}
              onChange={e => setBudget(b => ({ ...b, project_title: e.target.value }))}
              onBlur={e => updateHeader({ project_title: e.target.value })}
              placeholder="e.g. LP1, Deluxe Edition…"
              className="w-full border border-rule rounded px-2 py-1.5 text-xs bg-card"
            />
          </HeaderField>
          <HeaderField label="Release">
            <select
              value={budget.release_id || ''}
              disabled={readOnly}
              onChange={e => updateHeader({ release_id: e.target.value ? Number(e.target.value) : null })}
              className="w-full border border-rule rounded px-2 py-1.5 text-xs bg-card"
            >
              <option value="">— none —</option>
              {releases.map(r => <option key={r.id} value={r.id}>{r.project_name || r.title || `#${r.id}`}</option>)}
            </select>
          </HeaderField>
          <HeaderField label="Currency">
            <select
              value={budget.currency || 'USD'}
              disabled={readOnly}
              onChange={e => updateHeader({ currency: e.target.value })}
              className="w-full border border-rule rounded px-2 py-1.5 text-xs bg-card"
            >
              {CURRENCIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </HeaderField>

          <HeaderField label="Type">
            <div className="flex items-center gap-1 bg-gray-100 rounded p-0.5">
              <button type="button" disabled={readOnly}
                onClick={() => updateHeader({ type: 'budget' })}
                className={`flex-1 px-2 py-1 rounded text-xs font-semibold ${budget.type === 'budget' ? 'bg-card text-gray-900 shadow-sm' : 'text-gray-500'}`}
              >Budget</button>
              <button type="button" disabled={readOnly}
                onClick={() => updateHeader({ type: 'fund' })}
                className={`flex-1 px-2 py-1 rounded text-xs font-semibold ${budget.type === 'fund' ? 'bg-card text-gray-900 shadow-sm' : 'text-gray-500'}`}
              >Fund</button>
            </div>
          </HeaderField>
          <HeaderField label="Advance Amount">
            <MoneyInput value={budget.advance_amount} readOnly={readOnly} currency={budget.currency}
              onCommit={v => updateHeader({ advance_amount: v })} />
          </HeaderField>
          {budget.type === 'fund' && (
            <HeaderField label="Total Recording Fund">
              <MoneyInput value={budget.fund_amount} readOnly={readOnly} currency={budget.currency}
                onCommit={v => updateHeader({ fund_amount: v })} />
            </HeaderField>
          )}
          <HeaderField label="Proposed # Tracks">
            <input
              type="number"
              min="0"
              value={budget.proposed_tracks ?? ''}
              disabled={readOnly}
              onChange={e => setBudget(b => ({ ...b, proposed_tracks: e.target.value }))}
              onBlur={e => updateHeader({ proposed_tracks: e.target.value === '' ? null : Number(e.target.value) })}
              className="w-full border border-rule rounded px-2 py-1.5 text-xs bg-card"
            />
          </HeaderField>
          <HeaderField label="Contingency %">
            <input
              type="number"
              step="0.5"
              min="0"
              max="100"
              value={budget.contingency_pct ?? ''}
              disabled={readOnly}
              onChange={e => setBudget(b => ({ ...b, contingency_pct: e.target.value }))}
              onBlur={e => updateHeader({ contingency_pct: e.target.value === '' ? 0 : Number(e.target.value) })}
              className="w-full border border-rule rounded px-2 py-1.5 text-xs bg-card"
            />
          </HeaderField>
        </div>

        {/* Fund summary panel — mirrors the "Recording Fund Available"
            block from the Fund template. Only renders for fund-type
            budgets. */}
        {budget.type === 'fund' && (
          <div className="mt-4 pt-4 border-t border-rule grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <FundStat label="Recording Fund Available"
              amount={(Number(budget.fund_amount) || 0) - (Number(budget.advance_amount) || 0)}
              currency={budget.currency} />
            <FundStat label="Total LP Budget"
              amount={Number(budget.total_budget) || 0}
              currency={budget.currency} />
            <FundStat label="Balance Due to Artist on Delivery"
              amount={(Number(budget.fund_amount) || 0) - (Number(budget.advance_amount) || 0) - (Number(budget.total_budget) || 0)}
              currency={budget.currency}
              negativeTone />
            <FundStat label="Contingency"
              amount={Number(budget.contingency_amount) || 0}
              currency={budget.currency}
              muted />
          </div>
        )}
      </div>

      {/* Tab switcher */}
      <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1 w-fit">
        <button
          type="button"
          onClick={() => setTab('plan')}
          className={`px-4 py-1.5 rounded-lg text-xs font-semibold ${tab === 'plan' ? 'bg-card text-gray-900 shadow-sm' : 'text-gray-500'}`}
        >Planning</button>
        <button
          type="button"
          onClick={() => setTab('costs')}
          className={`px-4 py-1.5 rounded-lg text-xs font-semibold ${tab === 'costs' ? 'bg-card text-gray-900 shadow-sm' : 'text-gray-500'}`}
        >Costs to Date</button>
      </div>

      {tab === 'plan' ? (
        <PlanningTab budget={budget} refetch={refetch} readOnly={readOnly} />
      ) : (
        <CostsToDateTab budget={budget} refetch={refetch} />
      )}
    </div>
  )
}

function BackLink() {
  return (
    <Link to="/budget" className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-gray-800">
      <ArrowLeft size={13} /> Recording Budgets
    </Link>
  )
}
// ── ArtistPicker ───────────────────────────────────────────────────
// Type-to-filter combobox for the budget's artist. Picking a roster
// row commits an artist_id; typing a value that doesn't match a
// roster entry commits as freeform (artist_name only, artist_id
// cleared). Keyboard: ↑/↓ move the highlight, Enter picks, Escape
// closes without committing.
function ArtistPicker({ artists, value, onPickRoster, onCommitFreeform, disabled }) {
  // `display` is the currently-committed label (roster name or the
  // freeform artist_name). `draft` is the in-progress query. When
  // draft is empty and the picker isn't focused, we show `display`.
  const committed = value?.display || value?.name || ''
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [highlight, setHighlight] = useState(-1)
  const wrapRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  // Sync draft when the committed value changes (initial load,
  // external save from another field, etc.).
  useEffect(() => { if (!open) setDraft(committed) }, [committed, open])
  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false); setDraft(committed); setHighlight(-1)
      }
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { setOpen(false); setDraft(committed); setHighlight(-1) }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, committed])

  const q = draft.trim().toLowerCase()
  const filtered = q
    ? artists.filter(a => (a.name || '').toLowerCase().includes(q))
    : artists
  const trimmed = draft.trim()
  const exactMatch = trimmed
    ? artists.find(a => (a.name || '').toLowerCase() === trimmed.toLowerCase())
    : null
  // "Use as freeform" appears when the query is non-empty and not
  // an exact roster match — always keeps the escape hatch to type
  // an artist that isn't yet in the system.
  const showFreeformOption = trimmed && !exactMatch

  const commitFreeform = () => {
    if (trimmed && trimmed !== committed) onCommitFreeform(trimmed)
    setOpen(false); setHighlight(-1)
  }
  const pick = (artist) => {
    if (artist === '__freeform__') { commitFreeform(); return }
    onPickRoster(artist)
    setOpen(false); setDraft(artist.name); setHighlight(-1)
  }

  const optionsForKeys = [
    ...(showFreeformOption ? [{ __freeform__: true, label: `Use "${trimmed}" as freeform` }] : []),
    ...filtered,
  ]
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      setHighlight(i => Math.min(optionsForKeys.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(i => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const opt = optionsForKeys[highlight]
      if (opt && opt.__freeform__) commitFreeform()
      else if (opt) pick(opt)
      else if (trimmed) commitFreeform()   // no highlight but query → freeform
    }
  }
  useEffect(() => {
    if (highlight >= 0 && listRef.current) {
      const el = listRef.current.children[highlight]
      if (el) el.scrollIntoView({ block: 'nearest' })
    }
  }, [highlight])

  return (
    <div ref={wrapRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={open ? draft : committed}
        disabled={disabled}
        onFocus={() => { if (!disabled) { setOpen(true); setDraft(committed); setHighlight(-1) } }}
        onChange={e => { setDraft(e.target.value); setHighlight(0); if (!open) setOpen(true) }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Delay closing so a mousedown on the dropdown can register
          // before the blur nukes the panel. If the user typed a new
          // value that doesn't match, commit as freeform.
          setTimeout(() => {
            if (!wrapRef.current || !wrapRef.current.contains(document.activeElement)) {
              if (open && trimmed && trimmed !== committed && !exactMatch) commitFreeform()
              setOpen(false); setHighlight(-1)
            }
          }, 120)
        }}
        placeholder="Type to search or add a new artist…"
        className="w-full border border-rule rounded px-2 py-1.5 text-xs bg-card focus:outline-none focus:ring-1 focus:ring-boom-500"
      />
      {open && (optionsForKeys.length > 0) && (
        <div className="absolute z-20 left-0 right-0 top-full mt-1 max-h-72 overflow-y-auto bg-card border border-rule rounded-md shadow-lg">
          <ul ref={listRef} className="py-1 text-xs">
            {optionsForKeys.map((opt, i) => {
              const isHi = i === highlight
              if (opt.__freeform__) {
                return (
                  <li
                    key="__freeform__"
                    onMouseDown={(e) => { e.preventDefault(); commitFreeform() }}
                    onMouseEnter={() => setHighlight(i)}
                    className={`px-3 py-1.5 cursor-pointer ${isHi ? 'bg-boom-50 text-boom-700' : 'text-gray-500'} border-b border-rule italic`}
                  >
                    + {opt.label}
                  </li>
                )
              }
              return (
                <li
                  key={opt.id}
                  onMouseDown={(e) => { e.preventDefault(); pick(opt) }}
                  onMouseEnter={() => setHighlight(i)}
                  className={`px-3 py-1.5 cursor-pointer ${isHi ? 'bg-gray-100 text-gray-900' : 'text-gray-700 hover:bg-gray-50'}`}
                >
                  {opt.name}
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {open && optionsForKeys.length === 0 && trimmed && (
        <div className="absolute z-20 left-0 right-0 top-full mt-1 bg-card border border-rule rounded-md shadow-lg px-3 py-2 text-xs text-gray-500">
          No matches. Press Enter to save as freeform.
        </div>
      )}
    </div>
  )
}

function HeaderField({ label, children, className = '' }) {
  return (
    <div className={className}>
      <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">{label}</label>
      {children}
    </div>
  )
}
function StatusChip({ status }) {
  const tone = {
    draft:    { bg: 'bg-gray-100',    text: 'text-gray-700',    icon: null },
    approved: { bg: 'bg-emerald-100', text: 'text-emerald-800', icon: <CheckCircle2 size={12} /> },
    locked:   { bg: 'bg-slate-200',   text: 'text-slate-800',   icon: <Lock size={12} /> },
  }[status] || { bg: 'bg-gray-100', text: 'text-gray-700' }
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider px-2 py-1 rounded ${tone.bg} ${tone.text}`}>
      {tone.icon}
      {status}
    </span>
  )
}
function FundStat({ label, amount, currency, negativeTone, muted }) {
  const tone = muted
    ? 'text-gray-500'
    : negativeTone
      ? (amount < 0 ? 'text-rose-700' : 'text-emerald-700')
      : 'text-gray-900'
  return (
    <div>
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">{label}</p>
      <p className={`text-sm font-bold tabular-nums mt-0.5 ${tone}`}>{fmtMoney(amount, currency)}</p>
    </div>
  )
}
// Editable money input — commits on blur / Enter. Displays with $ /
// currency symbol via toLocaleString but strips it before saving.
function MoneyInput({ value, onCommit, readOnly, currency = 'USD' }) {
  const [draft, setDraft] = useState(value == null ? '' : String(value))
  useEffect(() => { setDraft(value == null ? '' : String(value)) }, [value])
  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      disabled={readOnly}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => {
        const n = Number(String(draft).replace(/[$,\s]/g, ''))
        onCommit(Number.isFinite(n) ? n : 0)
      }}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
      className="w-full border border-rule rounded px-2 py-1.5 text-xs bg-card tabular-nums"
      placeholder={fmtMoney(0, currency)}
    />
  )
}

// ── Planning tab ───────────────────────────────────────────────────
// Six section cards + a sticky mini-summary strip at the top +
// contingency / TOTAL BUDGET at the bottom.
//
// Redesigned to be scannable at any state:
//   • Empty sections collapse to a single row (icon + name + count +
//     $0 + Add first item), so an all-empty budget fits above the fold.
//   • Populated sections auto-expand and stay expanded while editing.
//   • The subtotal → contingency → total chain lives in a sticky
//     strip at the top so the running total is always visible while
//     scrolling the section list.
function PlanningTab({ budget, refetch, readOnly }) {
  const subtotal = SECTIONS.reduce(
    (s, sec) => s + (Number(budget.section_totals?.[sec.key]) || 0), 0
  )
  const contPct = Number(budget.contingency_pct) || 0
  const contingency = subtotal * (contPct / 100)
  const total = subtotal + contingency
  const [expandAll, setExpandAll] = useState(false)

  return (
    <div className="space-y-3">
      {/* Sticky running-total strip. Follows the user down the
          section list so the TOTAL is always readable. */}
      <div className="sticky top-0 z-10 -mx-4 md:mx-0">
        <div className="card px-4 py-3 shadow-sm">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-center">
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Sections subtotal</p>
              <p className="text-base font-bold text-gray-900 tabular-nums mt-0.5">{fmtMoney(subtotal, budget.currency)}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Contingency ({contPct.toFixed(1)}%)</p>
              <p className="text-base font-bold text-gray-700 tabular-nums mt-0.5">{fmtMoney(contingency, budget.currency)}</p>
            </div>
            <div className="md:col-span-1">
              <p className="text-[10px] font-semibold text-boom-500 uppercase tracking-wider">Total Budget</p>
              <p className="text-xl font-bold text-boom-700 tabular-nums mt-0.5">{fmtMoney(total, budget.currency)}</p>
            </div>
            <div className="text-right">
              <button
                type="button"
                onClick={() => setExpandAll(v => !v)}
                className="text-[11px] font-semibold text-gray-500 hover:text-gray-900 inline-flex items-center gap-1"
                title={expandAll ? 'Collapse empty sections' : 'Expand every section'}
              >
                {expandAll ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {expandAll ? 'Collapse all' : 'Expand all'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Sections. Compact-when-empty; user can expand any of them
          via the header chevron. subtotal is passed through so each
          card can render its own share indicator. */}
      <div className="space-y-2">
        {SECTIONS.map(s => (
          <SectionCard
            key={s.key}
            budget={budget}
            section={s}
            items={budget.sections?.[s.key] || []}
            readOnly={readOnly}
            onChanged={refetch}
            grandSubtotal={subtotal}
            forceExpanded={expandAll}
          />
        ))}
      </div>

      {/* Total block — kept for parity with the Excel template, even
          though the sticky strip above surfaces the same numbers.
          Positioned at the end of the section list so scrolling to
          the bottom closes the ledger visually. */}
      <div className="card p-5 mt-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-500 font-semibold">
            Miscellaneous / Contingency {contPct.toFixed(1)}%
          </span>
          <span className="tabular-nums text-gray-700 font-bold">
            {fmtMoney(contingency, budget.currency)}
          </span>
        </div>
        <div className="mt-3 pt-3 border-t-2 border-boom-500 flex items-center justify-between">
          <span className="text-base font-bold text-gray-900 uppercase tracking-wider">Total Budget</span>
          <span className="text-2xl font-bold text-boom-700 tabular-nums">
            {fmtMoney(total, budget.currency)}
          </span>
        </div>
        {budget.type === 'budget' && (
          <div className="mt-2 pt-2 border-t border-rule flex items-center justify-between text-xs text-gray-500">
            <span>Total Project Costs (Budget + Advances)</span>
            <span className="tabular-nums font-semibold text-gray-700">
              {fmtMoney(total + (Number(budget.advance_amount) || 0), budget.currency)}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── SectionCard ────────────────────────────────────────────────────
// Per-section card. Compact one-liner when empty; expands into a
// full editable table when populated OR when the user explicitly
// expands it. Header carries a section icon, live total, share bar
// against the running budget subtotal, and the primary Add-row CTA.
function SectionCard({ budget, section, items, readOnly, onChanged, grandSubtotal = 0, forceExpanded = false }) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ description: '', qty: '', unit_price: '' })
  const [busy, setBusy] = useState(false)
  // A section is auto-open when it has line items OR the user is
  // adding a row OR the "expand all" toggle at the top is on. Empty
  // sections start closed to reduce vertical clutter.
  const hasItems = items.length > 0
  const [open, setOpen] = useState(hasItems)
  useEffect(() => { if (hasItems) setOpen(true) }, [hasItems])
  const isOpen = forceExpanded || open || adding || hasItems

  const total = items.reduce((s, i) => s + (Number(i.amount) || 0), 0)
  const share = grandSubtotal > 0 ? (total / grandSubtotal) * 100 : 0
  const Icon = section.icon || MoreHorizontal

  const startAdd = (e) => {
    if (e) { e.stopPropagation(); e.preventDefault() }
    setAdding(true); setOpen(true)
  }

  const commitNew = async () => {
    if (busy) return
    const qty = Number(draft.qty) || 0
    const price = Number(String(draft.unit_price).replace(/[$,\s]/g, '')) || 0
    if (!draft.description.trim() && qty === 0 && price === 0) {
      setAdding(false); setDraft({ description: '', qty: '', unit_price: '' }); return
    }
    setBusy(true)
    try {
      await api.post(`/budgets/${budget.id}/line-items`, {
        section: section.key,
        description: draft.description.trim(),
        qty, unit_price: price,
      })
      setDraft({ description: '', qty: '', unit_price: '' })
      setAdding(false)
      onChanged()
    } catch (err) {
      alert(`Add failed: ${err?.response?.data?.error || err.message}`)
    } finally { setBusy(false) }
  }

  return (
    <div className={`card overflow-hidden transition-shadow ${isOpen ? 'shadow-sm' : ''}`}>
      {/* Header row — click to expand/collapse. Doubles as the
          section total display and hosts the Add-row action. */}
      <button
        type="button"
        onClick={() => !hasItems && setOpen(v => !v)}
        className={`w-full px-4 py-2.5 flex items-center gap-3 text-left ${!hasItems && !readOnly ? 'hover:bg-gray-50 cursor-pointer' : 'cursor-default'}`}
      >
        {/* Chevron shown only for empty sections (populated stay open) */}
        {!hasItems ? (
          isOpen
            ? <ChevronDown  size={14} className="text-gray-400 shrink-0" />
            : <ChevronRight size={14} className="text-gray-400 shrink-0" />
        ) : (
          <span className="w-3.5" />
        )}
        <span className={`shrink-0 inline-flex items-center justify-center rounded-md bg-gray-100 w-7 h-7 ${section.tint}`}>
          <Icon size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-gray-900">{section.label}</h3>
          <p className="text-[10px] text-gray-400">
            {hasItems ? (
              <>
                {items.length} line item{items.length === 1 ? '' : 's'}
                {share > 0 && <span className="text-gray-300"> · {share.toFixed(0)}% of subtotal</span>}
              </>
            ) : (
              <span className="italic">nothing here yet</span>
            )}
          </p>
        </div>
        {/* Live share bar — hairline slot under the total that
            communicates the section's slice of the budget without
            adding a dedicated column. */}
        {hasItems && share > 0 && (
          <div className="hidden md:block w-24 h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className={`h-full rounded-full bg-boom-500 opacity-80`} style={{ width: `${Math.min(share, 100)}%` }} />
          </div>
        )}
        <span className={`text-sm tabular-nums shrink-0 ${hasItems ? 'font-bold text-gray-900' : 'text-gray-400'}`}>
          {fmtMoney(total, budget.currency)}
        </span>
        {!readOnly && (
          <span
            role="button"
            tabIndex={0}
            onClick={startAdd}
            onKeyDown={(e) => { if (e.key === 'Enter') startAdd(e) }}
            className="text-xs font-semibold text-boom-600 hover:text-boom-700 inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-boom-50 shrink-0 cursor-pointer"
            title="Add a line item"
          >
            <Plus size={12} /> {hasItems ? 'Add row' : 'Add first item'}
          </span>
        )}
      </button>

      {/* Table body — only rendered when the section is open. Keeps
          empty sections to a single row of chrome. */}
      {isOpen && (
      <table className="w-full text-xs border-t border-rule">
        <thead>
          <tr className="border-b border-rule text-[10px] uppercase tracking-wider text-gray-400 bg-gray-50/60">
            <th className="text-left py-1.5 pl-4 pr-2 font-semibold w-1/2">Description</th>
            <th className="text-right py-1.5 px-2 font-semibold w-24">{section.qtyLabel}</th>
            <th className="text-right py-1.5 px-2 font-semibold w-32">{section.priceLabel}</th>
            <th className="text-right py-1.5 px-2 font-semibold w-32">Total</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && !adding && (
            <tr>
              <td colSpan={5} className="text-center text-gray-400 py-3 text-[11px] italic">
                {!readOnly && <button type="button" onClick={() => startAdd()} className="text-boom-600 font-semibold hover:underline">+ Add the first item</button>}
                {readOnly && 'No line items.'}
              </td>
            </tr>
          )}
          {items.map(item => (
            <LineItemRow
              key={item.id} budget={budget} item={item} readOnly={readOnly}
              onChanged={onChanged}
            />
          ))}
          {adding && (
            <tr className="bg-boom-50/40">
              <td className="pl-4 pr-2 py-2">
                <input
                  autoFocus
                  type="text"
                  value={draft.description}
                  onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
                  placeholder="Description"
                  className="w-full border border-rule rounded px-2 py-1 text-xs bg-card"
                />
              </td>
              <td className="px-2 py-2 text-right">
                <input
                  type="text" inputMode="decimal"
                  value={draft.qty}
                  onChange={e => setDraft(d => ({ ...d, qty: e.target.value }))}
                  placeholder="0"
                  className="w-full border border-rule rounded px-2 py-1 text-xs bg-card text-right tabular-nums"
                />
              </td>
              <td className="px-2 py-2 text-right">
                <input
                  type="text" inputMode="decimal"
                  value={draft.unit_price}
                  onChange={e => setDraft(d => ({ ...d, unit_price: e.target.value }))}
                  placeholder="0"
                  className="w-full border border-rule rounded px-2 py-1 text-xs bg-card text-right tabular-nums"
                />
              </td>
              <td className="px-2 py-2 text-right text-gray-500 tabular-nums">
                {fmtMoney((Number(draft.qty) || 0) * (Number(String(draft.unit_price).replace(/[$,\s]/g, '')) || 0), budget.currency)}
              </td>
              <td className="pr-2">
                <div className="flex items-center gap-1">
                  <button type="button" onClick={commitNew} disabled={busy}
                    className="text-emerald-600 hover:text-emerald-700 p-1" title="Save (Enter)"><Save size={13} /></button>
                  <button type="button" onClick={() => { setAdding(false); setDraft({ description: '', qty: '', unit_price: '' }) }}
                    className="text-gray-400 hover:text-gray-700 p-1" title="Cancel"><X size={13} /></button>
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      )}
    </div>
  )
}

function LineItemRow({ budget, item, readOnly, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item)
  useEffect(() => { setDraft(item) }, [item])
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      await api.put(`/budgets/${budget.id}/line-items/${item.id}`, {
        description: draft.description,
        qty: Number(draft.qty) || 0,
        unit_price: Number(String(draft.unit_price).replace(/[$,\s]/g, '')) || 0,
      })
      setEditing(false)
      onChanged()
    } catch (err) {
      alert(`Save failed: ${err?.response?.data?.error || err.message}`)
    } finally { setBusy(false) }
  }
  const del = async () => {
    if (!window.confirm(`Delete "${item.description || 'this line'}"?`)) return
    try {
      await api.delete(`/budgets/${budget.id}/line-items/${item.id}`)
      onChanged()
    } catch (err) {
      alert(`Delete failed: ${err?.response?.data?.error || err.message}`)
    }
  }

  if (editing) {
    return (
      <tr className="bg-amber-50/50">
        <td className="pl-4 pr-2 py-1.5">
          <input value={draft.description || ''} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
            className="w-full border border-rule rounded px-2 py-1 text-xs bg-card" />
        </td>
        <td className="px-2 py-1.5 text-right">
          <input value={draft.qty || ''} onChange={e => setDraft(d => ({ ...d, qty: e.target.value }))}
            className="w-full border border-rule rounded px-2 py-1 text-xs bg-card text-right tabular-nums" />
        </td>
        <td className="px-2 py-1.5 text-right">
          <input value={draft.unit_price || ''} onChange={e => setDraft(d => ({ ...d, unit_price: e.target.value }))}
            className="w-full border border-rule rounded px-2 py-1 text-xs bg-card text-right tabular-nums" />
        </td>
        <td className="px-2 py-1.5 text-right text-gray-500 tabular-nums">
          {fmtMoney((Number(draft.qty) || 0) * (Number(String(draft.unit_price).replace(/[$,\s]/g, '')) || 0), budget.currency)}
        </td>
        <td className="pr-2">
          <div className="flex items-center gap-1">
            <button type="button" onClick={save} disabled={busy}
              className="text-emerald-600 p-1"><Save size={13} /></button>
            <button type="button" onClick={() => { setEditing(false); setDraft(item) }}
              className="text-gray-400 p-1"><X size={13} /></button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <tr className="border-b border-divider hover:bg-gray-50/40">
      <td className={`pl-4 pr-2 py-1.5 ${readOnly ? 'text-gray-600' : 'cursor-pointer'}`}
        onClick={() => !readOnly && setEditing(true)}>
        {item.description || <span className="text-gray-400 italic">—</span>}
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">{Number(item.qty) || 0}</td>
      <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">{fmtMoney(item.unit_price, budget.currency)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums font-bold text-gray-900">{fmtMoney(item.amount, budget.currency)}</td>
      <td className="pr-2">
        {!readOnly && (
          <button type="button" onClick={del} title="Delete row"
            className="text-gray-300 hover:text-rose-600 p-1"><Trash2 size={12} /></button>
        )}
      </td>
    </tr>
  )
}

// ── Costs to Date tab ─────────────────────────────────────────────
// Rows are grouped by ledger CATEGORY (Advance / Marketing / Legal /
// Recording / etc.) rather than the 6-section recording template.
// The per-expense dropdown picks a ledger category, defaulting to
// the expense's own category and letting the user override it for
// budget-attribution purposes.
function CostsToDateTab({ budget }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refetch = () => {
    setLoading(true)
    api.get(`/budgets/${budget.id}/actuals`)
      .then(r => { setData(r.data?.data || null); setError(null) })
      .catch(err => setError(err?.response?.data?.error || err.message))
      .finally(() => setLoading(false))
  }
  useEffect(refetch, [budget.id])

  if (loading && !data) {
    return <div className="card p-12 flex items-center justify-center gap-2 text-sm text-gray-500"><Loader size={16} className="animate-spin" /> Loading actuals…</div>
  }
  if (error) return <div className="card p-8 text-center text-sm text-rose-700">{error}</div>
  if (!data?.match_name) {
    return (
      <div className="card p-8 text-center text-sm text-gray-500">
        <AlertTriangle size={20} className="mx-auto text-amber-500 mb-2" />
        No artist set — costs to date can't be calculated. Set an artist in the header above.
      </div>
    )
  }

  const setOverride = async (expenseId, category) => {
    try {
      await api.put(`/budgets/expense/${expenseId}/section`, {
        category: category === '__default__' ? null : category,
      })
      refetch()
    } catch (err) {
      alert(`Failed: ${err?.response?.data?.error || err.message}`)
    }
  }

  // Only render category rows that actually have data (planned OR
  // spent). Keeps the table focused on the categories relevant to
  // this artist / release instead of listing all 16 ledger cats.
  // Sorted by (planned + spent) desc so the biggest lines lead.
  const categoryRows = Object.entries(data.by_category || {})
    .map(([cat, v]) => ({ category: cat, ...v }))
    .filter(r => (r.planned || 0) !== 0 || (r.spent || 0) !== 0)
    .sort((a, b) => ((b.planned + b.spent) - (a.planned + a.spent)))

  return (
    <div className="space-y-4">
      {/* Fund / Budget summary block */}
      <div className="card p-5">
        <h3 className="text-sm font-bold text-gray-900 mb-3">Costs to Date · {data.match_name}</h3>
        {budget.type === 'fund' ? (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
            <FundStat label="Recording Fund"                   amount={data.summary.fund}                   currency={budget.currency} />
            <FundStat label="less Execution Advance"           amount={data.summary.advance}                currency={budget.currency} muted />
            <FundStat label="Remainder for Recording"          amount={data.summary.remainder_after_advance} currency={budget.currency} />
            <FundStat label="less Recording Costs to Date"     amount={data.summary.spent}                  currency={budget.currency} muted />
            <FundStat label="Balance of Fund"                  amount={data.summary.balance_of_fund}        currency={budget.currency} negativeTone />
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
            <FundStat label="Planned"   amount={data.summary.budget_planned} currency={budget.currency} />
            <FundStat label="Spent"     amount={data.summary.spent}          currency={budget.currency} />
            <FundStat label="Remaining" amount={data.summary.remaining}      currency={budget.currency} negativeTone />
          </div>
        )}
      </div>

      {/* By-category table */}
      <div className="card overflow-hidden">
        <div className="px-4 py-2.5 border-b border-rule bg-gray-50">
          <h3 className="text-sm font-bold text-gray-900">By category</h3>
          <p className="text-[10px] text-gray-400">
            USD-equivalent. Categories match the ledger; each expense keeps its own category by default, or you can override any row below.
          </p>
        </div>
        {categoryRows.length === 0 ? (
          <p className="text-center text-xs text-gray-400 py-6">No planned lines and no spend yet — add line items on the Planning tab, or ledger expenses under this artist will appear here.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-rule text-[10px] uppercase tracking-wider text-gray-400">
                <th className="text-left py-2 pl-4 pr-2 font-semibold">Category</th>
                <th className="text-right py-2 px-2 font-semibold">Planned</th>
                <th className="text-right py-2 px-2 font-semibold">Spent</th>
                <th className="text-right py-2 px-2 font-semibold">Remaining</th>
                <th className="text-right py-2 pl-2 pr-4 font-semibold">%</th>
              </tr>
            </thead>
            <tbody>
              {categoryRows.map(row => {
                const pct = row.planned > 0 ? (row.spent / row.planned) * 100 : 0
                const overspent = row.remaining < 0
                return (
                  <tr key={row.category} className="border-b border-divider">
                    <td className="pl-4 pr-2 py-2 font-semibold text-gray-700">{row.category}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-gray-700">{fmtMoney(row.planned, budget.currency)}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-emerald-700">{fmtMoney(row.spent, budget.currency)}</td>
                    <td className={`px-2 py-2 text-right tabular-nums font-bold ${overspent ? 'text-rose-700' : 'text-gray-900'}`}>{fmtMoney(row.remaining, budget.currency)}</td>
                    <td className={`pl-2 pr-4 py-2 text-right tabular-nums ${overspent ? 'text-rose-700 font-bold' : 'text-gray-500'}`}>{row.planned > 0 ? `${pct.toFixed(0)}%` : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Expense list with per-row category override */}
      <div className="card overflow-hidden">
        <div className="px-4 py-2.5 border-b border-rule bg-gray-50">
          <h3 className="text-sm font-bold text-gray-900">Ledger expenses</h3>
          <p className="text-[10px] text-gray-400">
            {data.all.length} expense{data.all.length === 1 ? '' : 's'} matched to <span className="font-semibold">{data.match_name}</span>.
            Change the category to reclassify an expense against this budget.
          </p>
        </div>
        {data.all.length === 0 ? (
          <p className="text-center text-xs text-gray-400 py-6">No expenses yet.</p>
        ) : (
          <div className="overflow-x-auto max-h-[60vh]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-rule text-[10px] uppercase tracking-wider text-gray-400">
                  <th className="text-left py-2 pl-4 pr-2 font-semibold">Date</th>
                  <th className="text-left py-2 px-2 font-semibold">Vendor</th>
                  <th className="text-left py-2 px-2 font-semibold">Category</th>
                  <th className="text-right py-2 px-2 font-semibold">Amount</th>
                  <th className="text-left py-2 px-2 font-semibold">Status</th>
                  <th className="text-left py-2 pl-2 pr-4 font-semibold">Budget category</th>
                </tr>
              </thead>
              <tbody>
                {data.all.map(e => {
                  const current = e.budget_category_override || '__default__'
                  const isOverridden = !!e.budget_category_override
                  return (
                    <tr key={e.id} className="border-b border-divider hover:bg-gray-50/40">
                      <td className="pl-4 pr-2 py-2 text-gray-500 whitespace-nowrap tabular-nums">{e.invoice_date ? String(e.invoice_date).slice(0, 10) : '—'}</td>
                      <td className="px-2 py-2 text-gray-800 truncate max-w-[220px]" title={e.payee}>{e.payee || '—'}</td>
                      <td className="px-2 py-2 text-gray-500">{e.category || '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums font-bold text-gray-900">{fmtMoney(e.amount_usd)}</td>
                      <td className="px-2 py-2">
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          e.payment_status === 'Paid' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
                        }`}>{e.payment_status || 'Unpaid'}</span>
                      </td>
                      <td className="pl-2 pr-4 py-2">
                        <select
                          value={current}
                          onChange={ev => setOverride(e.id, ev.target.value)}
                          className={`text-[11px] border rounded px-1.5 py-1 bg-card ${isOverridden ? 'border-amber-400 text-amber-800 font-semibold' : 'border-rule text-gray-700'}`}
                          title={isOverridden ? 'Overridden — click to change. Choose default to revert.' : 'Defaults to the expense\'s own category. Change to override.'}
                        >
                          <option value="__default__">— use default ({e.default_category}) —</option>
                          {(data.category_labels || []).map(c => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
