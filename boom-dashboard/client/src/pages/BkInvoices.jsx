import { useState, useEffect, useRef, useMemo } from 'react'
import { Loader, AlertCircle, FileText, Search, Upload, LayoutList, LayoutGrid } from 'lucide-react'
import FilePreview from '../components/FilePreview'
import api from '../api'
import getDarkColors from '../utils/darkColors'
import { useTheme } from '../context/ThemeContext'
import SubmissionsPerWeekChart from '../components/SubmissionsPerWeekChart'

const RED = '#334155'

const STATUS_BADGE = {
  approved: { bg: '#d1fae5', color: '#065f46', label: 'Approved' },
  pending:  { bg: '#fef9c3', color: '#92400e', label: 'Pending' },
  rejected: { bg: '#fee2e2', color: '#991b1b', label: 'Rejected' },
}
const badgeBase = {
  display: 'inline-flex', alignItems: 'center',
  padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700,
  whiteSpace: 'nowrap',
}

function fmt(v, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(v || 0)
}

function fmtDate(d) {
  if (!d) return '—'
  const s = String(d).slice(0, 10)
  const parts = s.split('-')
  if (parts.length !== 3) return '—'
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[parseInt(parts[1],10)-1]} ${parseInt(parts[2],10)}, ${parts[0]}`
}

function StatusBadge({ status }) {
  // Literal fallback — this component is module-scope, where the theme
  // object `C` doesn't exist (referencing it here was a ReferenceError on
  // any status outside the palette). Mirrors the fallback at the call site.
  const s = STATUS_BADGE[status?.toLowerCase()] || { bg: '#f3f4f6', color: '#6b7280', label: status || '—' }
  return <span style={{ ...badgeBase, background: s.bg, color: s.color }}>{s.label}</span>
}

function FileLink({ entryId, type, label, hasFile, onUploaded, onPreview }) {
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef(null)
  const color = type === 'invoice' ? '#2563eb' : type === 'w9' ? '#ea580c' : '#7c3aed'

  const handleUpload = async (file) => {
    if (!file) return
    setUploading(true)
    try {
      const api = (await import('../api')).default
      const fd = new FormData(); fd.append('file', file)
      await api.post(`/bk/entries/${entryId}/file/${type}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      if (onUploaded) onUploaded(entryId, type)
    } catch {} finally { setUploading(false) }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {uploading ? (
        <span style={{ fontSize: 11, color: '#999' }}>...</span>
      ) : hasFile ? (
        <>
          <button
            onClick={() => {
              const url = `/api/bk/entries/${entryId}/file/${type}?token=${localStorage.getItem('token')}`
              onPreview ? onPreview(url, `${label}-${entryId}`) : window.open(url, '_blank')
            }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', color }}
          >
            <FileText style={{ width: 13, height: 13 }} /> {label}
          </button>
          <button onClick={() => inputRef.current?.click()} title="Replace" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: 10 }}
            onMouseEnter={e => e.currentTarget.style.color = RED} onMouseLeave={e => e.currentTarget.style.color = '#999'}>↻</button>
        </>
      ) : (
        <button onClick={() => inputRef.current?.click()} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: 11, fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <Upload style={{ width: 11, height: 11 }} /> Upload
        </button>
      )}
      <input ref={inputRef} type="file" accept=".pdf,.jpg,.jpeg,.png" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = '' }} />
    </span>
  )
}

export default function BkInvoices() {
  const { theme } = useTheme()
  const C = getDarkColors(theme)
  const TH = { background: C.thBg, color: C.thText, fontSize: 10, fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase', padding: '10px 14px', textAlign: 'left', borderBottom: '1px solid ' + C.thBorder, whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1 }
  const TD = { padding: '10px 14px', verticalAlign: 'middle', borderBottom: '1px solid ' + C.tdBorder, fontSize: 13 }
  const inputSty = { background: C.inputBg, border: '1.5px solid ' + C.inputBorder, borderRadius: 8, padding: '8px 12px 8px 36px', color: C.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', width: 280 }
  const dateSty = { background: C.inputBg, border: '1.5px solid ' + C.inputBorder, borderRadius: 8, padding: '8px 12px', color: C.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', cursor: 'pointer' }
  const toolbarBtn = { background: 'none', border: '1.5px solid ' + C.border, color: C.textMuted, padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [view, setView] = useState('table')
  const [previewFile, setPreviewFile] = useState(null)
  const openPreview = (url, name) => setPreviewFile({ url, filename: name })
  const [toDate, setToDate] = useState('')
  // Rejected-invoices subsection state. One-shot fetch on mount — not
  // tied to the search / date-range filters above because the rejected
  // tail is small and archival; operators typically want to see the
  // full list, not a filtered slice.
  const [rejectedEntries, setRejectedEntries] = useState([])
  const [rejectedLoading, setRejectedLoading] = useState(true)
  const [rejectedCollapsed, setRejectedCollapsed] = useState(true)
  // Which date column the from/to range filters on server-side.
  //   'invoice_date' (default) — matches the toolbar's date-picker semantic
  //   'created_at'             — set when a submissions-chart bar is clicked
  //   'payment_date'           — set when a paid-chart bar is clicked
  const [dateBasis, setDateBasis] = useState('invoice_date')

  // Chart range picker. `preset` is one of the quick-look weeks values
  // or 'custom'. `customFrom` / `customTo` only matter when preset ==
  // 'custom'. Persisted to localStorage so the range survives refresh.
  const CHART_RANGE_KEY = 'bk_invoices_chart_range_v1'
  const CHART_PRESETS = [
    { key: '4w',  label: '4w',  weeks: 4  },
    { key: '12w', label: '12w', weeks: 12 },
    { key: '26w', label: '26w', weeks: 26 },
    { key: '52w', label: '52w', weeks: 52 },
  ]
  const [chartRange, setChartRangeRaw] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(CHART_RANGE_KEY) || 'null')
      if (stored && typeof stored === 'object') return stored
    } catch {}
    return { preset: '12w', customFrom: '', customTo: '' }
  })
  const setChartRange = (next) => {
    setChartRangeRaw(next)
    try { localStorage.setItem(CHART_RANGE_KEY, JSON.stringify(next)) } catch {}
  }
  // Resolve chart-range state into concrete from/to strings passed to the
  // chart endpoints. Presets anchor `to` at LA-today and count weeks back.
  // Custom uses the user's exact strings, empty-string coerced to null so
  // the server falls back to its trailing-12 default for missing sides.
  const chartFromTo = useMemo(() => {
    if (chartRange.preset === 'custom') {
      return { from: chartRange.customFrom || null, to: chartRange.customTo || null }
    }
    const preset = CHART_PRESETS.find(p => p.key === chartRange.preset) || CHART_PRESETS[1]
    // Anchor "today" in LA time to match the server's week bucketing —
    // toISOString() is UTC, which after ~5pm PT is tomorrow's date and
    // truncates to NEXT week's Monday (an extra empty bar + a zeroed
    // "this week" headline every Sunday evening).
    const laToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
    const [y, m, d] = laToday.split('-').map(Number)
    const today = new Date(y, m - 1, d)
    const pad = (n) => String(n).padStart(2, '0')
    const dstr = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
    // Server's generate_series is inclusive on both endpoints, and both
    // sides get snapped to their week's Monday via DATE_TRUNC. So a
    // preset of N weeks means "today's week + (N-1) previous weeks";
    // go back (N-1)*7 days, not N*7. Otherwise 12w renders 13 bars.
    const back = new Date(today); back.setDate(today.getDate() - ((preset.weeks - 1) * 7))
    return { from: dstr(back), to: dstr(today) }
  }, [chartRange])

  // Race guard: increment on every fetch start; late responses whose gen
  // doesn't match the latest are dropped so an old server response can't
  // clobber a newer one.
  const fetchGenRef = useRef(0)
  const hasLoadedRef = useRef(false)

  const fetchInvoices = async () => {
    const myGen = ++fetchGenRef.current
    try {
      // Full-page spinner only before the FIRST load — refetches (every
      // debounced keystroke, date change, chart click) used to unmount the
      // whole page including the focused search input.
      if (!hasLoadedRef.current) setLoading(true)
      setError('')
      const params = new URLSearchParams()
      if (debouncedSearch) params.append('search', debouncedSearch)
      if (fromDate) params.append('from', fromDate)
      if (toDate) params.append('to', toDate)
      // Only send `basis` when the range was set from a chart click. The
      // toolbar date-pickers default to invoice_date, matching the server
      // default — sending the param unnecessarily just makes the URL noisy.
      if ((fromDate || toDate) && dateBasis !== 'invoice_date') params.append('basis', dateBasis)
      const res = await api.get(`/bk/invoices?${params}`)
      if (myGen !== fetchGenRef.current) return
      hasLoadedRef.current = true
      setEntries(res.data.data || [])
    } catch (err) {
      if (myGen !== fetchGenRef.current) return
      setError('Failed to load invoices: ' + (err.response?.data?.error || err.message))
    } finally {
      if (myGen === fetchGenRef.current) setLoading(false)
    }
  }

  // Debounce the search box so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => { fetchInvoices() }, [debouncedSearch, fromDate, toDate, dateBasis])

  // Rejected invoices — one-shot fetch. Re-runs when the section is
  // expanded so operators can pull the latest without a page refresh.
  const fetchRejected = async () => {
    try {
      setRejectedLoading(true)
      const res = await api.get('/bk/invoices?status=rejected')
      setRejectedEntries(res.data.data || [])
    } catch {
      setRejectedEntries([])
    } finally {
      setRejectedLoading(false)
    }
  }
  useEffect(() => { fetchRejected() }, [])

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '24rem' }}>
        <div style={{ textAlign: 'center' }}>
          <Loader style={{ width: 28, height: 28, color: RED, margin: '0 auto 8px', animation: 'spin 0.8s linear infinite' }} />
          <p style={{ color: '#777', fontSize: 14 }}>Loading invoices…</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    )
  }

  // Chart-click filter dispatch. Each chart passes a `basis` matching the
  // column it bucketed by, so a click filters the list on that same
  // column. Clicking the same bar twice with the same basis clears the
  // filter (toggle-off), matching the "click filter chip to remove"
  // convention used elsewhere.
  const handleWeekClick = (basis) => (week) => {
    if (!week?.week_start || !week?.week_end) return
    const same = dateBasis === basis && fromDate === week.week_start && toDate === week.week_end
    if (same) {
      setFromDate('')
      setToDate('')
      setDateBasis('invoice_date')
      return
    }
    setFromDate(week.week_start)
    setToDate(week.week_end)
    setDateBasis(basis)
  }

  // Selection state for each chart — only highlight when the current
  // filter came from that chart's basis. Prevents a stale highlight when
  // the user manually edits the date inputs (which reset basis to
  // invoice_date via the toolbar path below).
  const submittedSelectedWeek = dateBasis === 'created_at'    ? fromDate : null
  const paidSelectedWeek      = dateBasis === 'payment_date'  ? fromDate : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.pageBg, fontSize: 14 }}>

      {/* Weekly charts — clicking a bar filters the invoice list below to
          that Mon–Sun window, and to the matching date column (creation
          date for submissions, payment date for paid). Both live above
          the sticky toolbar so they scroll away naturally. Independent
          collapse state via distinct storageKey props. */}
      <div style={{ padding: '12px 16px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Range picker — one control drives both charts so the intake-vs-
            outflow comparison stays apples-to-apples. Preset chips cover
            the quick-look ranges; 'Custom' reveals from/to date pickers
            for anything in between. Selection persists to localStorage. */}
        <div data-tour="invoices-range" style={{
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
          padding: '8px 12px', background: C.cardBg,
          border: '1px solid ' + C.border, borderRadius: 10,
          fontSize: 12,
        }}>
          <span style={{ color: C.textMuted, fontWeight: 700, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em', marginRight: 4 }}>Time range</span>
          {CHART_PRESETS.map(p => {
            const isActive = chartRange.preset === p.key
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => setChartRange({ preset: p.key, customFrom: chartRange.customFrom, customTo: chartRange.customTo })}
                style={{
                  padding: '4px 10px', borderRadius: 999,
                  fontSize: 11, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
                  border: '1.5px solid ' + (isActive ? RED : C.border),
                  background: isActive ? '#fee2e2' : 'transparent',
                  color: isActive ? RED : C.textMuted,
                }}
              >{p.label}</button>
            )
          })}
          <button
            type="button"
            onClick={() => setChartRange({ ...chartRange, preset: 'custom' })}
            style={{
              padding: '4px 10px', borderRadius: 999,
              fontSize: 11, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
              border: '1.5px solid ' + (chartRange.preset === 'custom' ? RED : C.border),
              background: chartRange.preset === 'custom' ? '#fee2e2' : 'transparent',
              color: chartRange.preset === 'custom' ? RED : C.textMuted,
            }}
          >Custom…</button>
          {chartRange.preset === 'custom' && (
            <>
              <span style={{ color: C.textFaint, marginLeft: 4 }}>From</span>
              <input
                type="date"
                value={chartRange.customFrom}
                onChange={e => setChartRange({ ...chartRange, customFrom: e.target.value })}
                style={{ ...dateSty, padding: '4px 8px', fontSize: 12 }}
              />
              <span style={{ color: C.textFaint }}>To</span>
              <input
                type="date"
                value={chartRange.customTo}
                onChange={e => setChartRange({ ...chartRange, customTo: e.target.value })}
                style={{ ...dateSty, padding: '4px 8px', fontSize: 12 }}
              />
            </>
          )}
        </div>

        <SubmissionsPerWeekChart
          endpoint="/bk/payments/submissions-per-week"
          storageKey="bk_invoices_submissions_chart_collapsed_v1"
          title="Invoices submitted per week"
          subtitle="Bucketed by submission date · Mon–Sun, LA time · USD-equivalent"
          headlineLabel="submitted this week"
          onWeekClick={handleWeekClick('created_at')}
          selectedWeekStart={submittedSelectedWeek}
          from={chartFromTo.from}
          to={chartFromTo.to}
          showAmounts
        />
        <SubmissionsPerWeekChart
          endpoint="/bk/payments/paid-per-week"
          storageKey="bk_invoices_paid_chart_collapsed_v1"
          title="Invoices paid per week"
          subtitle="Bucketed by payment date · Mon–Sun, LA time · USD-equivalent"
          headlineLabel="paid this week"
          onWeekClick={handleWeekClick('payment_date')}
          selectedWeekStart={paidSelectedWeek}
          showAmounts
          from={chartFromTo.from}
          to={chartFromTo.to}
        />
      </div>

      {/* Toolbar */}
      <div data-tour="invoices-toolbar" style={{
        padding: '10px 16px', display: 'flex', gap: 8, alignItems: 'center',
        justifyContent: 'space-between', borderBottom: '1px solid ' + C.border,
        background: C.cardBg, flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 10,
      }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', flex: 1 }}>
          <div style={{ position: 'relative' }}>
            <Search style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', width: 15, height: 15, color: '#aaa' }} />
            <input
              type="text" placeholder="Payee, description, invoice #..."
              value={search} onChange={e => setSearch(e.target.value)}
              style={inputSty}
            />
          </div>
          <input type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); setDateBasis('invoice_date') }} style={dateSty} title="From date" />
          <input type="date" value={toDate}   onChange={e => { setToDate(e.target.value);   setDateBasis('invoice_date') }} style={dateSty} title="To date" />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          <span style={{ color: '#9ca3af', fontSize: 12, whiteSpace: 'nowrap' }}>{entries.length} invoices</span>
          <div style={{ display: 'flex', gap: 2, background: C.elevBg, borderRadius: 6, padding: 2 }}>
            <button onClick={() => setView('table')} style={{ padding: '4px 6px', borderRadius: 4, background: view === 'table' ? C.cardBg : 'transparent', border: 'none', cursor: 'pointer', display: 'flex' }}>
              <LayoutList style={{ width: 14, height: 14, color: view === 'table' ? C.text : '#999' }} />
            </button>
            <button onClick={() => setView('cards')} style={{ padding: '4px 6px', borderRadius: 4, background: view === 'cards' ? C.cardBg : 'transparent', border: 'none', cursor: 'pointer', display: 'flex' }}>
              <LayoutGrid style={{ width: 14, height: 14, color: view === 'cards' ? C.text : '#999' }} />
            </button>
          </div>
          {(search || fromDate || toDate) && (
            <>
              <div style={{ width: 1, height: 20, background: C.border }} />
              <button
                style={toolbarBtn}
                onClick={() => { setSearch(''); setFromDate(''); setToDate(''); setDateBasis('invoice_date') }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = RED; e.currentTarget.style.color = RED }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.textMuted }}
              >
                Clear
              </button>
            </>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ margin: '10px 16px 0', background: '#fef2f2', border: '1px solid #fca5a5', color: '#991b1b', padding: '10px 14px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <AlertCircle style={{ width: 16, height: 16, flexShrink: 0 }} />
          {error}
          <button onClick={() => setError('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#991b1b', fontSize: 14, cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {/* Filter summary banner — makes it explicit what subset of the
          ledger is being shown when a chart bar is clicked (or when the
          user manually narrows via the toolbar's date pickers). Only
          renders while a date filter is active. */}
      {(fromDate || toDate) && (() => {
        // Local formatting — construct via Y/M-1/D so the string doesn't
        // get shifted a day by UTC parsing of a bare YYYY-MM-DD.
        const fmtDate = (iso) => {
          const parts = String(iso || '').slice(0, 10).split('-').map(Number)
          if (parts.length !== 3 || !parts[0]) return iso
          const [y, m, d] = parts
          return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        }
        // Header verb keyed off which date column the range applies to.
        // Matches the semantic the user clicked (paid vs submitted) or
        // the toolbar default (invoice date).
        const verb = dateBasis === 'payment_date' ? 'Invoices paid'
                   : dateBasis === 'created_at'   ? 'Invoices submitted'
                   :                                'Invoices dated'
        // Detect a full Mon–Sun week span so the copy can read "the
        // week of Jun 22" instead of "Jun 22, 2026 – Jun 28, 2026".
        let phrase
        if (fromDate && toDate) {
          const spanDays = Math.round(
            (new Date(toDate + 'T00:00:00') - new Date(fromDate + 'T00:00:00')) / 86400000
          )
          const startDay = new Date(fromDate + 'T00:00:00').getDay() // 0 = Sun, 1 = Mon
          phrase = (spanDays === 6 && startDay === 1)
            ? `the week of ${fmtDate(fromDate)}`
            : `between ${fmtDate(fromDate)} and ${fmtDate(toDate)}`
        } else if (fromDate) {
          phrase = `on or after ${fmtDate(fromDate)}`
        } else {
          phrase = `on or before ${fmtDate(toDate)}`
        }
        // Blue-tinted so it reads as informational context, distinct
        // from the neutral toolbar and the red error banner.
        return (
          <div style={{
            margin: '10px 16px 0',
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            color: '#1e40af',
            padding: '10px 14px',
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 13,
          }}>
            <FileText style={{ width: 16, height: 16, flexShrink: 0 }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 700 }}>
                Showing {verb.toLowerCase()} {phrase}
              </div>
              <div style={{ fontSize: 11, color: '#3b82f6', marginTop: 2 }}>
                {entries.length} invoice{entries.length === 1 ? '' : 's'} match{entries.length === 1 ? 'es' : ''} this filter
                {dateBasis !== 'invoice_date' && <span style={{ marginLeft: 6, opacity: 0.75 }}>· selected from chart</span>}
              </div>
            </div>
            <button
              type="button"
              onClick={() => { setFromDate(''); setToDate(''); setDateBasis('invoice_date') }}
              style={{
                background: 'transparent',
                border: '1px solid #93c5fd',
                color: '#1e40af',
                padding: '4px 10px',
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 700,
                fontFamily: 'inherit',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Clear filter
            </button>
          </div>
        )
      })()}

      {/* Table */}
      <div data-tour="invoices-list" style={{ flex: 1, overflowX: 'auto', overflowY: 'auto' }}>
        {entries.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: '#999', fontSize: 14 }}>
            No invoices found.
          </div>
        ) : view === 'cards' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, padding: 16 }}>
            {entries.map(entry => {
              const status = STATUS_BADGE[entry.status?.toLowerCase()] || { bg: '#f3f4f6', color: '#6b7280', label: entry.status || '—' }
              return (
                <div key={entry.id} style={{ background: C.cardBg, borderRadius: 10, border: '1px solid ' + C.border, padding: '16px 18px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{entry.payee}</div>
                    <span style={{ ...badgeBase, background: status.bg, color: status.color }}>{status.label}</span>
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 900, color: RED, marginBottom: 8 }}>{fmt(entry.amount, entry.currency)}</div>
                  <div style={{ display: 'flex', gap: 12, fontSize: 12, color: '#777', marginBottom: 8 }}>
                    <span>{fmtDate(entry.invoice_date)}</span>
                    {entry.invoice_number && <span>#{entry.invoice_number}</span>}
                    {entry.category && <span>{entry.category}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 8, borderTop: '1px solid ' + C.tdBorder, paddingTop: 8 }}>
                    <FileLink entryId={entry.id} type="invoice" label="Invoice" hasFile={entry.has_invoice} onPreview={openPreview} onUploaded={(id, type) => setEntries(prev => prev.map(e => e.id === id ? { ...e, [`has_${type}`]: true } : e))} />
                    <FileLink entryId={entry.w9_entry_id || entry.id} type="w9" label="W9" hasFile={entry.has_w9 || !!entry.w9_entry_id} onPreview={openPreview} onUploaded={(id, type) => setEntries(prev => prev.map(e => e.id === id ? { ...e, [`has_${type}`]: true } : e))} />
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <table style={{ width: '100%', minWidth: 560, borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={TH}>Date</th>
                <th style={TH}>Payee</th>
                <th style={TH}>Invoice #</th>
                <th style={{ ...TH, textAlign: 'right' }}>Amount</th>
                <th style={TH}>Category</th>
                <th style={TH}>Status</th>
                <th style={TH}>Files</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr
                  key={entry.id}
                  style={{ background: C.rowBg }}
                  onMouseEnter={e => e.currentTarget.style.background = C.rowHover}
                  onMouseLeave={e => e.currentTarget.style.background = C.rowBg}
                >
                  <td style={{ ...TD, color: '#9ca3af', fontWeight: 600, whiteSpace: 'nowrap' }}>{fmtDate(entry.invoice_date)}</td>
                  <td style={{ ...TD, fontWeight: 700 }}>{entry.payee}</td>
                  <td style={{ ...TD, color: '#555' }}>{entry.invoice_number || '—'}</td>
                  <td style={{ ...TD, textAlign: 'right', fontWeight: 900, color: RED, whiteSpace: 'nowrap' }}>{fmt(entry.amount, entry.currency)}</td>
                  <td style={{ ...TD, color: '#777' }}>{entry.category || '—'}</td>
                  <td style={TD}><StatusBadge status={entry.status} /></td>
                  <td style={TD}>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <FileLink entryId={entry.id} type="invoice" label="Invoice" hasFile={entry.has_invoice} onPreview={openPreview} onUploaded={(id, type) => setEntries(prev => prev.map(e => e.id === id ? { ...e, [`has_${type}`]: true } : e))} />
                      <FileLink entryId={entry.w9_entry_id || entry.id} type="w9" label="W9" hasFile={entry.has_w9 || !!entry.w9_entry_id} onPreview={openPreview} onUploaded={(id, type) => setEntries(prev => prev.map(e => e.id === id ? { ...e, [`has_${type}`]: true } : e))} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {/* ── Rejected invoices subsection ──────────────────────────────────
          Archival tail of rows rejected via the Approvals page. Collapsed
          by default so the main invoices list stays uncluttered; clicking
          the header expands. Not date-filtered — the audit trail is
          usually looked up by vendor or reason, not by date range. */}
      <div style={{ background: C.cardBg, borderRadius: 10, marginTop: 24, marginBottom: 32, boxShadow: C.cardShadow, overflow: 'hidden' }}>
        <button
          onClick={() => {
            const next = !rejectedCollapsed
            setRejectedCollapsed(next)
            // Refresh on expand so newly-rejected rows appear without a
            // page reload.
            if (!next) fetchRejected()
          }}
          style={{
            width: '100%', textAlign: 'left', background: 'transparent',
            border: 'none', padding: '14px 20px',
            display: 'flex', alignItems: 'center', gap: 10,
            cursor: 'pointer', fontFamily: 'inherit',
            color: C.text,
          }}
        >
          <span style={{
            display: 'inline-block',
            transform: rejectedCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
            transition: 'transform 0.15s',
            color: C.textMuted,
          }}>▸</span>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Rejected invoices</span>
          <span
            style={{
              ...badgeBase,
              background: '#fee2e2', color: '#991b1b',
              padding: '2px 10px', fontSize: 11,
            }}
          >
            {rejectedLoading ? '…' : rejectedEntries.length}
          </span>
          <span style={{ fontSize: 12, color: C.textMuted, marginLeft: 4 }}>
            invoices rejected via the Approvals page
          </span>
        </button>
        {!rejectedCollapsed && (
          rejectedLoading ? (
            <div style={{ padding: '24px 20px', color: C.textMuted, fontSize: 13, textAlign: 'center' }}>
              Loading rejected invoices…
            </div>
          ) : rejectedEntries.length === 0 ? (
            <div style={{ padding: '24px 20px', color: C.textMuted, fontSize: 13, textAlign: 'center' }}>
              No rejected invoices on file.
            </div>
          ) : (
            <div style={{ overflowX: 'auto', borderTop: '1px solid ' + C.border }}>
              <table style={{ width: '100%', minWidth: 560, borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={TH}>Date</th>
                    <th style={TH}>Payee</th>
                    <th style={TH}>Invoice #</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Amount</th>
                    <th style={TH}>Artist</th>
                    <th style={TH}>Rejected</th>
                    <th style={TH}>Reason</th>
                    <th style={TH}>Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {rejectedEntries.map(entry => (
                    <tr
                      key={entry.id}
                      style={{ background: C.rowBg }}
                      onMouseEnter={e => e.currentTarget.style.background = C.rowHover}
                      onMouseLeave={e => e.currentTarget.style.background = C.rowBg}
                    >
                      <td style={{ ...TD, color: '#9ca3af', fontWeight: 600, whiteSpace: 'nowrap' }}>{fmtDate(entry.invoice_date)}</td>
                      <td style={{ ...TD, fontWeight: 700 }}>{entry.payee}</td>
                      <td style={{ ...TD, color: '#555' }}>{entry.invoice_number || '—'}</td>
                      <td style={{ ...TD, textAlign: 'right', fontWeight: 800, color: '#555', whiteSpace: 'nowrap' }}>{fmt(entry.amount, entry.currency)}</td>
                      <td style={{ ...TD, color: '#555' }}>{entry.artist || '—'}</td>
                      <td style={{ ...TD, color: C.textMuted, fontSize: 11, whiteSpace: 'nowrap' }}>
                        {entry.rejected_at ? fmtDate(entry.rejected_at) : '—'}
                        {entry.rejected_by_name && (
                          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 1 }}>by {entry.rejected_by_name}</div>
                        )}
                      </td>
                      <td style={{ ...TD, color: '#555', maxWidth: 320, fontSize: 12 }}>
                        {entry.reject_reason || <span style={{ color: '#bbb', fontStyle: 'italic' }}>no reason recorded</span>}
                      </td>
                      <td style={TD}>
                        <FileLink
                          entryId={entry.id}
                          type="invoice"
                          label="Invoice"
                          hasFile={entry.has_invoice}
                          onPreview={openPreview}
                          onUploaded={(id, type) => setRejectedEntries(prev => prev.map(e => e.id === id ? { ...e, [`has_${type}`]: true } : e))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      {previewFile && <FilePreview url={previewFile.url} filename={previewFile.filename} onClose={() => setPreviewFile(null)} />}
    </div>
  )
}
