import { useRef, useState, useMemo } from 'react'
import { Upload, FileText, Trash2, Download, Loader, AlertCircle, CheckCircle2, GitCompare, Package, FileSpreadsheet } from 'lucide-react'
import api from '../api'
import getDarkColors from '../utils/darkColors'
import { useTheme } from '../context/ThemeContext'

const RED = '#334155'

// Diff categories — order drives the tab strip + which one opens first.
// "matched" is hidden by default (the operator wants discrepancies, not a
// list of clean rows) but kept in the data so the summary shows total reach.
const CATEGORIES = [
  { key: 'amount_mismatch',       label: 'Amount mismatch',        tone: 'red',    desc: 'Same invoice on both sides, different totals.' },
  { key: 'paid_status_mismatch',  label: 'Paid status differs',    tone: 'red',    desc: 'One side says paid, the other says unpaid.' },
  { key: 'paid_date_mismatch',    label: 'Paid date differs',      tone: 'amber',  desc: 'Both say paid but the recorded date is different.' },
  { key: 'missing_from_dashboard',label: 'Missing on Market Street',        tone: 'red',    desc: "In the bookkeeper sheet, but Market Street's ledger has no matching row." },
  { key: 'missing_from_bookkeeper',label: 'Missing on bookkeeper', tone: 'red',    desc: "In Market Street's ledger, but the bookkeeper sheet has no row." },
  { key: 'vendor_name_variation', label: 'Vendor name variation',  tone: 'gray',   desc: 'Matched on invoice # but the vendor spelling differs — verify it\'s the same vendor.' },
  { key: 'no_invoice_num',        label: 'No invoice #',           tone: 'gray',   desc: 'Bookkeeper row had no parseable invoice # — could not match.' },
  { key: 'matched',               label: 'Clean matches',          tone: 'green',  desc: 'No discrepancies found on these rows.' },
]

const TONE_CHIP = {
  red:   'bg-rose-50 text-rose-700 ring-rose-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  gray:  'bg-gray-100 text-gray-700 ring-gray-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
}

// Confidence chip palette — mirror of diffConfidenceMeta() on the server
// so the chip on screen is the same colour as the chip in the workbook.
// Labels describe what the user needs to know, not the algorithm step
// — the original `reason` (incl. Jaccard score for token matches) stays
// in the chip's title attribute for power users who want detail.
const CONFIDENCE_META = (reason) => {
  if (!reason || reason === 'no-match' || reason === 'empty') return null
  if (reason === 'exact')            return { label: 'Identical',      bg: '#D1FAE5', fg: '#065F46', border: '#A7F3D0' }
  if (reason === 'parentheticals')   return { label: 'Aside differs',  bg: '#D1FAE5', fg: '#065F46', border: '#A7F3D0' }
  if (reason === 'suffixes')         return { label: 'Suffix differs', bg: '#DBEAFE', fg: '#1E40AF', border: '#BFDBFE' }
  if (reason === 'substring')        return { label: 'Shorter name',   bg: '#FEF3C7', fg: '#92400E', border: '#FDE68A' }
  if (reason === 'suffix-substring') return { label: 'Partial match',  bg: '#FEF3C7', fg: '#92400E', border: '#FDE68A' }
  if (reason.startsWith('tokens-'))  return { label: 'Reordered',      bg: '#FFEDD5', fg: '#C2410C', border: '#FED7AA' }
  return { label: reason, bg: '#E5E7EB', fg: '#374151', border: '#D1D5DB' }
}

// Plain-English tooltip per chip label. Includes the Jaccard score for
// "Reordered" matches since that one varies (1.0 means identical word
// set, 0.7 is the loose end).
const CONFIDENCE_TOOLTIP = (reason) => {
  if (reason === 'exact')            return 'Identical — vendor name matches on both sides.'
  if (reason === 'parentheticals')   return 'Aside differs — same name, one side has extra info in (parentheses).'
  if (reason === 'suffixes')         return 'Suffix differs — same name, one side has LLC / Inc / Corp / etc. and the other doesn\'t (or has a different one).'
  if (reason === 'substring')        return 'Shorter name — one side\'s name is fully contained in the other.'
  if (reason === 'suffix-substring') return 'Partial match — one side contains the other after dropping business suffixes.'
  if (reason && reason.startsWith('tokens-')) {
    const s = reason.replace('tokens-', '')
    return `Reordered — same words in a different order. Word-overlap score ${s} (1.0 = identical word set).`
  }
  return `Vendor matched via "${reason}"`
}

function ConfidenceChip({ reason }) {
  const m = CONFIDENCE_META(reason)
  if (!m) return null
  return (
    <span title={CONFIDENCE_TOOLTIP(reason)} style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 999,
      fontSize: 10, fontWeight: 700, lineHeight: 1.5, whiteSpace: 'nowrap',
      background: m.bg, color: m.fg, border: `1px solid ${m.border}`,
    }}>{m.label}</span>
  )
}

// Issue tags — same palette as the workbook. Parses the prose array
// returned by /ledger-diff into compact coloured tags so the Notes
// column stops duplicating values that are already in the BK / Dashboard
// columns of the same row.
const ISSUE_TAG_META = {
  amount:       { label: 'AMOUNT',         bg: '#FEE2E2', fg: '#B91C1C', border: '#FECACA' },
  paid_status:  { label: 'PAID STATUS',    bg: '#FFEDD5', fg: '#C2410C', border: '#FED7AA' },
  paid_date:    { label: 'PAID DATE',      bg: '#FEF3C7', fg: '#A16207', border: '#FDE68A' },
  vendor:       { label: 'VENDOR',         bg: '#EDE9FE', fg: '#6D28D9', border: '#DDD6FE' },
  missing_bk:   { label: 'MISSING ON BK',  bg: '#E5E7EB', fg: '#374151', border: '#D1D5DB' },
  missing_dash: { label: 'MISSING ON MARKET STREET',bg: '#E5E7EB', fg: '#374151', border: '#D1D5DB' },
  no_invoice:   { label: 'NO INVOICE #',   bg: '#E5E7EB', fg: '#374151', border: '#D1D5DB' },
}

function parseIssueTags(issues) {
  const tags = []
  for (const s of issues || []) {
    if (/^Amount mismatch/.test(s))            tags.push('amount')
    else if (/^Paid status differs/.test(s))   tags.push('paid_status')
    else if (/^Paid date differs/.test(s))     tags.push('paid_date')
    else if (/^Vendor names differ/.test(s))   tags.push('vendor')
    else if (/Market Street ledger has this row/i.test(s)) tags.push('missing_bk')
    else if (/not in.*ledger/i.test(s) || /not in boom/i.test(s)) tags.push('missing_dash')
    else if (/no invoice/i.test(s))            tags.push('no_invoice')
  }
  return tags
}

function IssueTags({ issues }) {
  const tags = parseIssueTags(issues)
  if (tags.length === 0) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {tags.map((t, i) => {
        const m = ISSUE_TAG_META[t]
        if (!m) return null
        return (
          <span key={i} title={(issues || []).find(s => parseIssueTags([s])[0] === t) || m.label}
            style={{
              display: 'inline-block', padding: '1px 7px', borderRadius: 4,
              fontSize: 9, fontWeight: 800, letterSpacing: '0.04em',
              background: m.bg, color: m.fg, border: `1px solid ${m.border}`,
              whiteSpace: 'nowrap',
            }}>{m.label}</span>
        )
      })}
    </div>
  )
}

const fmt$ = (n) => {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) }
  catch { return `$${v.toFixed(2)}` }
}

const fmtDate = (s) => {
  if (!s) return '—'
  const t = String(s).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t : '—'
}

// Server-side Excel build — POST the rows + category + summary to
// /api/bk/ledger-diff-export and stream the styled .xlsx back. Mirrors
// the rest of the app's Excel exports (same branded header, frozen
// header row, auto-filter, alternating row bands) so the workbook
// dropped in the user's downloads feels like part of the same set.
async function downloadCategoryXlsx({ rows, category, summary }) {
  const res = await api.post('/bk/ledger-diff-export', {
    rows, category, summary,
  }, { responseType: 'blob' })
  // Server returns a JSON error body when something's wrong; the blob
  // type tells us which shape arrived.
  if (res.data && res.data.type && /json/i.test(res.data.type)) {
    const text = await res.data.text()
    try { const j = JSON.parse(text); throw new Error(j.error || 'Export failed') }
    catch (e) { throw e }
  }
  const url = URL.createObjectURL(res.data)
  const a = document.createElement('a')
  a.href = url
  a.download = `ledger-diff-${category || 'all'}-${new Date().toISOString().slice(0,10)}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}

export default function LedgerMatching() {
  const { theme } = useTheme()
  const C = getDarkColors(theme)

  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [reportBusy, setReportBusy] = useState(false) // full multi-sheet workbook
  const [handoffBusy, setHandoffBusy] = useState(false) // handoff ZIP
  const [bkStyleBusy, setBkStyleBusy] = useState(false) // BK-format excel
  const [error, setError] = useState('')
  const [diff, setDiff] = useState(null) // { summary, diffs }
  const [activeCat, setActiveCat] = useState(null)
  const inputRef = useRef(null)

  const reset = () => {
    setFile(null); setError(''); setDiff(null); setActiveCat(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  const onPick = (f) => {
    setError(''); setDiff(null); setActiveCat(null)
    if (!f) return
    if (!/\.(xlsx|xls)$/i.test(f.name || '')) {
      setError('Please upload an .xlsx or .xls spreadsheet.')
      return
    }
    setFile(f)
  }
  const onDrop = (e) => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files?.[0]; if (f) onPick(f) }

  const handleDiff = async () => {
    if (!file || busy) return
    setBusy(true); setError(''); setDiff(null); setActiveCat(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await api.post('/bk/ledger-diff', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      const data = res.data?.data
      if (!data) throw new Error('Empty response from server')
      setDiff(data)
      // Open the first non-empty discrepancy category so the user lands
      // straight on something actionable.
      const firstNonEmpty = CATEGORIES.find(c => c.key !== 'matched' && (data.summary.counts[c.key] || 0) > 0)
      setActiveCat(firstNonEmpty ? firstNonEmpty.key : 'matched')
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to run diff')
    } finally {
      setBusy(false)
    }
  }

  // Full multi-sheet workbook — Summary cover + one tab per non-empty
  // category, every tab branded + frozen + auto-filtered. The one to
  // forward straight to the bookkeeper.
  const handleFullReport = async () => {
    if (!diff || reportBusy) return
    setReportBusy(true); setError('')
    try {
      const res = await api.post('/bk/ledger-diff-report', { diff }, { responseType: 'blob' })
      if (res.data && res.data.type && /json/i.test(res.data.type)) {
        const text = await res.data.text()
        try { const j = JSON.parse(text); throw new Error(j.error || 'Failed to build report') }
        catch (e) { throw e }
      }
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = `ledger-reconciliation-${new Date().toISOString().slice(0,10)}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      let msg = err.response?.data?.error || err.message || 'Failed to build report'
      if (err.response?.data instanceof Blob) {
        try { const j = JSON.parse(await err.response.data.text()); msg = j.error || msg } catch {}
      }
      setError(msg)
    } finally {
      setReportBusy(false)
    }
  }

  // BK Excel — uses the bookkeeper's source xlsx as a styling template
  // (re-uploaded here from local state) and just replaces the data rows
  // with Market Street dashboard data. Guarantees pixel-perfect match because the
  // theme, fonts, fills, column widths, row heights, and frozen panes
  // come straight from the user's file.
  const handleBkStyle = async () => {
    if (!diff || bkStyleBusy) return
    if (!file) { setError('Re-upload the bookkeeper xlsx and re-run the match before exporting BK Excel.'); return }
    setBkStyleBusy(true); setError('')
    try {
      // Only ship the two fields the server needs out of the diff
      // payload. The full diff (with every row) would exceed multer's
      // default 1MB field-size limit for any non-trivial dashboard.
      const fd = new FormData()
      fd.append('file', file)
      fd.append('sheet_years', JSON.stringify(diff?.summary?.sheet_years || []))
      if (diff?.summary?.week_ending) fd.append('week_ending', diff.summary.week_ending)
      const res = await api.post('/bk/bk-style-export', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        responseType: 'blob',
      })
      if (res.data && res.data.type && /json/i.test(res.data.type)) {
        const text = await res.data.text()
        try { const j = JSON.parse(text); throw new Error(j.error || 'Failed to build BK Excel') }
        catch (e) { throw e }
      }
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = `marketst-bk-style-${new Date().toISOString().slice(0,10)}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      let msg = err.response?.data?.error || err.message || 'Failed to build BK Excel'
      if (err.response?.data instanceof Blob) {
        try { const j = JSON.parse(await err.response.data.text()); msg = j.error || msg } catch {}
      }
      setError(msg)
    } finally {
      setBkStyleBusy(false)
    }
  }

  // Bookkeeper handoff ZIP — the multi-sheet workbook PLUS every invoice
  // file, W9 / W8, and proof of payment Market Street has on file for the rows in
  // the diff, organized vendor-first.
  const handleHandoff = async () => {
    if (!diff || handoffBusy) return
    setHandoffBusy(true); setError('')
    try {
      const res = await api.post('/bk/ledger-diff-handoff', { diff }, { responseType: 'blob' })
      if (res.data && res.data.type && /json/i.test(res.data.type)) {
        const text = await res.data.text()
        try { const j = JSON.parse(text); throw new Error(j.error || 'Failed to build handoff ZIP') }
        catch (e) { throw e }
      }
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = `ledger-reconciliation-${new Date().toISOString().slice(0,10)}.zip`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      let msg = err.response?.data?.error || err.message || 'Failed to build handoff ZIP'
      if (err.response?.data instanceof Blob) {
        try { const j = JSON.parse(await err.response.data.text()); msg = j.error || msg } catch {}
      }
      setError(msg)
    } finally {
      setHandoffBusy(false)
    }
  }

  const filteredRows = useMemo(() => {
    if (!diff) return []
    const cat = activeCat || 'matched'
    return diff.diffs.filter(r => r.kind === cat)
  }, [diff, activeCat])

  const exportCategoryXlsx = async () => {
    if (exportBusy) return
    setExportBusy(true)
    setError('')
    try {
      await downloadCategoryXlsx({
        rows: filteredRows,
        category: activeCat || 'all',
        summary: diff?.summary || null,
      })
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Failed to export Excel')
    } finally {
      setExportBusy(false)
    }
  }

  const dropZoneSty = {
    border: `2px dashed ${file ? RED : C.border}`,
    borderRadius: 12, padding: 32, textAlign: 'center', cursor: 'pointer',
    background: C.cardBg, transition: 'border-color 120ms',
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '28px 24px' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 data-tour="reconcile-header" style={{ fontSize: 24, fontWeight: 800, color: C.text, margin: 0 }}>Bookkeeper Reconcile</h1>
        <p style={{ color: '#888', fontSize: 13, margin: '6px 0 0' }}>
          Upload the external bookkeeper's weekly invoice summary. We'll match each row against the
          Market Street ledger by normalized invoice # + fuzzy vendor name, then flag every difference —
          amount mismatches, paid status drift, rows missing on either side, vendor-name variations.
        </p>
        {/* Says what this page is NOT. It was called "Ledger Matching", which
            is exactly what you'd click looking for the bank matcher. */}
        <p style={{ color: '#999', fontSize: 12, margin: '8px 0 0' }}>
          Looking for bank statement ↔ ledger matching? That's the review deck on{' '}
          <a href="/bk/statements" style={{ color: RED, fontWeight: 600, textDecoration: 'none' }}>Statements</a>.
        </p>
      </div>

      {/* Spreadsheet requirements */}
      <div data-tour="reconcile-requirements" style={{
        background: '#f8fafc', border: `1px solid ${C.border}`, borderRadius: 10,
        padding: 12, marginBottom: 18, fontSize: 12, color: '#555',
      }}>
        <div style={{ fontWeight: 700, color: C.text, marginBottom: 4 }}>What gets matched</div>
        Each sheet needs a header row with <strong>Vendor</strong> + <strong>Invoice #</strong> columns
        (Amount, Paid Date, Artist, Description picked up too). Invoice numbers compare after
        stripping <code>#</code> / <code>INV-</code> prefixes and leading zeros. Vendor names use a
        tiered fuzzy match — exact, then parens-stripped, substring, business-suffix stripped, and
        token-set overlap — so <code>10FIFTY LLC (UKG CENTRAL)</code> still matches <code>10FIFTY LLC</code>.
        Summary / Totals tabs are skipped automatically.
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, marginBottom: 14, borderRadius: 10,
                      background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 13 }}>
          <AlertCircle style={{ width: 16, height: 16, flexShrink: 0 }} /> {error}
          <button onClick={() => setError('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#991b1b', cursor: 'pointer' }}>&#x2715;</button>
        </div>
      )}

      <div data-tour="reconcile-upload" style={dropZoneSty} onDrop={onDrop} onDragOver={e => e.preventDefault()} onClick={() => inputRef.current?.click()}>
        <Upload style={{ width: 28, height: 28, color: '#bbb', margin: '0 auto 8px' }} />
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
          {file ? file.name : 'Drop your spreadsheet here, or click to browse'}
        </div>
        <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>.xlsx or .xls · max 10 MB</div>
        <input ref={inputRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
               onChange={e => { onPick(e.target.files?.[0]); e.target.value = '' }} />
      </div>

      {file && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, marginTop: 12, borderRadius: 10,
                      background: C.cardBg, border: `1px solid ${C.border}` }}>
          <FileText style={{ width: 16, height: 16, color: '#b45309' }} />
          <span style={{ flex: 1, fontSize: 13, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {file.name} <span style={{ color: '#999' }}>· {(file.size / 1024).toFixed(1)} KB</span>
          </span>
          <button onClick={reset} disabled={busy}
                  style={{ background: 'none', border: 'none', cursor: busy ? 'not-allowed' : 'pointer', color: '#999', padding: 4, display: 'inline-flex', opacity: busy ? 0.5 : 1 }}
                  title="Remove">
            <Trash2 style={{ width: 14, height: 14 }} />
          </button>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <button data-tour="reconcile-run" onClick={handleDiff} disabled={!file || busy}
                style={{
                  width: '100%', padding: '12px 16px', background: RED, color: '#fff', border: 'none', borderRadius: 10,
                  fontSize: 14, fontWeight: 700, fontFamily: 'inherit',
                  cursor: (!file || busy) ? 'not-allowed' : 'pointer', opacity: (!file || busy) ? 0.5 : 1,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}>
          {busy ? <><Loader style={{ width: 16, height: 16 }} className="animate-spin" /> Matching…</>
                : <><GitCompare style={{ width: 16, height: 16 }} /> Match &amp; flag differences</>}
        </button>
      </div>

      {diff && (
        <div style={{ marginTop: 24 }}>
          {/* Forward-to-bookkeeper actions — multi-sheet workbook + full handoff ZIP */}
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 10, padding: 12, marginBottom: 16,
            background: '#fafbfd', border: `1px solid ${C.border}`, borderRadius: 12,
          }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>Send this to the bookkeeper</div>
              <div style={{ fontSize: 11, color: '#777', marginTop: 2 }}>
                The reconciliation report opens to a Summary tab with drill-downs per discrepancy.
                BK Excel mirrors the bookkeeper's workbook layout populated with Market Street's data — drop-in
                replacement. The ZIP also includes invoice files, W9s, and proofs of payment.
              </div>
            </div>
            <button onClick={handleHandoff} disabled={handoffBusy || reportBusy || bkStyleBusy}
              style={{
                padding: '10px 14px', background: RED, color: '#fff', border: 'none', borderRadius: 10,
                fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                cursor: (handoffBusy || reportBusy || bkStyleBusy) ? 'wait' : 'pointer',
                opacity: (handoffBusy || reportBusy || bkStyleBusy) ? 0.6 : 1,
                display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap',
              }}
              title="Workbook + all invoice files + W9s + proofs of payment, organized for the bookkeeper">
              {handoffBusy
                ? <><Loader style={{ width: 14, height: 14 }} className="animate-spin" /> Building handoff…</>
                : <><Package style={{ width: 14, height: 14 }} /> Bookkeeper handoff (.zip)</>}
            </button>
            <button onClick={handleFullReport} disabled={reportBusy || handoffBusy || bkStyleBusy}
              style={{
                padding: '10px 14px', background: '#fff', color: C.text,
                border: `1px solid ${C.border}`, borderRadius: 10,
                fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                cursor: (reportBusy || handoffBusy || bkStyleBusy) ? 'wait' : 'pointer',
                opacity: (reportBusy || handoffBusy || bkStyleBusy) ? 0.6 : 1,
                display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap',
              }}
              title="Multi-sheet workbook — every category on its own tab">
              {reportBusy
                ? <><Loader style={{ width: 14, height: 14 }} className="animate-spin" /> Building…</>
                : <><FileSpreadsheet style={{ width: 14, height: 14 }} /> Full Excel report</>}
            </button>
            <button onClick={handleBkStyle} disabled={bkStyleBusy || reportBusy || handoffBusy}
              style={{
                padding: '10px 14px', background: '#fff', color: C.text,
                border: `1px solid ${C.border}`, borderRadius: 10,
                fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                cursor: (bkStyleBusy || reportBusy || handoffBusy) ? 'wait' : 'pointer',
                opacity: (bkStyleBusy || reportBusy || handoffBusy) ? 0.6 : 1,
                display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap',
              }}
              title="Bookkeeper's workbook layout populated with Market Street dashboard data">
              {bkStyleBusy
                ? <><Loader style={{ width: 14, height: 14 }} className="animate-spin" /> Building…</>
                : <><FileSpreadsheet style={{ width: 14, height: 14 }} /> BK Excel</>}
            </button>
          </div>

          {/* Summary tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 16 }}>
            {CATEGORIES.map(cat => {
              const n = diff.summary.counts[cat.key] || 0
              const active = activeCat === cat.key
              return (
                <button key={cat.key} onClick={() => setActiveCat(cat.key)} disabled={n === 0}
                  style={{
                    textAlign: 'left', padding: '10px 12px', borderRadius: 10,
                    border: active ? `2px solid ${RED}` : `1px solid ${C.border}`,
                    background: C.cardBg, cursor: n === 0 ? 'default' : 'pointer',
                    opacity: n === 0 ? 0.5 : 1, fontFamily: 'inherit',
                  }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#666' }}>
                    {cat.label}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: C.text, marginTop: 2 }}>
                    {n.toLocaleString()}
                  </div>
                </button>
              )
            })}
          </div>

          {/* Workbook header context */}
          <div style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>
            Parsed {diff.summary.bookkeeper_rows.toLocaleString()} bookkeeper rows from{' '}
            {diff.summary.sheets_processed} sheet{diff.summary.sheets_processed === 1 ? '' : 's'}
            {diff.summary.sheet_years?.length > 0 && ` (years ${diff.summary.sheet_years.join(', ')})`}
            · {diff.summary.dashboard_rows.toLocaleString()} dashboard rows considered.
            {diff.summary.week_ending && (
              <> · Workbook snapshot: <strong>week ending {diff.summary.week_ending}</strong> (dashboard rows newer than this are excluded from "missing on bookkeeper").</>
            )}
            {diff.summary.sheets_skipped?.length > 0 && (
              <>{' '}Skipped: {diff.summary.sheets_skipped.map(s => `${s.sheet} (${s.reason})`).join(', ')}.</>
            )}
          </div>

          {/* Active category description + export */}
          {activeCat && (() => {
            const cat = CATEGORIES.find(c => c.key === activeCat)
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{cat.label}</div>
                  <div style={{ fontSize: 12, color: '#777' }}>{cat.desc}</div>
                </div>
                {filteredRows.length > 0 && (
                  <button onClick={exportCategoryXlsx} disabled={exportBusy}
                    style={{
                      padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                      background: '#fff', color: C.text, border: `1px solid ${C.border}`,
                      cursor: exportBusy ? 'wait' : 'pointer', opacity: exportBusy ? 0.6 : 1,
                      display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'inherit',
                    }}>
                    {exportBusy
                      ? <Loader style={{ width: 12, height: 12 }} className="animate-spin" />
                      : <Download style={{ width: 12, height: 12 }} />}
                    Export Excel ({filteredRows.length})
                  </button>
                )}
              </div>
            )
          })()}

          {/* Rows */}
          {filteredRows.length === 0 ? (
            <div style={{
              padding: 32, textAlign: 'center', color: '#999', fontSize: 13,
              background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10,
            }}>
              {activeCat === 'matched' ? (
                <span style={{ color: '#16a34a' }}>
                  <CheckCircle2 style={{ width: 16, height: 16, display: 'inline-block', verticalAlign: 'middle', marginRight: 4 }} />
                  No clean matches to show — pick a discrepancy category above.
                </span>
              ) : 'Nothing in this category. Pick another tab above.'}
            </div>
          ) : (
            <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', borderBottom: `1px solid ${C.border}` }}>
                      <th style={thStyle}>Sheet</th>
                      <th style={thStyle}>Bookkeeper</th>
                      <th style={thStyle}>Dashboard</th>
                      <th style={thStyle}>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((r, i) => (
                      <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, background: i % 2 ? '#fafafa' : '#fff' }}>
                        <td style={tdStyle}>
                          <div style={{ fontWeight: 700, color: C.text }}>{r.sheet || '—'}</div>
                          {r.rowNum != null && <div style={{ color: '#999', fontSize: 11 }}>row {r.rowNum}</div>}
                        </td>
                        <td style={tdStyle}>
                          {r.bookkeeper ? (
                            <>
                              <div style={{ fontWeight: 700, color: C.text }}>{r.bookkeeper.vendor || '—'}</div>
                              <div style={{ color: '#666', fontSize: 11 }}>
                                #{r.bookkeeper.invoice || '—'}
                                {r.bookkeeper.amount != null && ` · ${fmt$(r.bookkeeper.amount)}`}
                              </div>
                              <div style={{ color: '#999', fontSize: 11, marginTop: 2 }}>
                                {r.bookkeeper.artist && <>artist: {r.bookkeeper.artist}</>}
                                {r.bookkeeper.paid_date && <> · paid {fmtDate(r.bookkeeper.paid_date)}</>}
                                {r.bookkeeper.paid_amount != null && <> · {fmt$(r.bookkeeper.paid_amount)}</>}
                              </div>
                            </>
                          ) : <span style={{ color: '#bbb' }}>— not in bookkeeper —</span>}
                        </td>
                        <td style={tdStyle}>
                          {r.dashboard ? (
                            <>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                <div style={{ fontWeight: 700, color: C.text }}>
                                  {r.dashboard.payee || '—'}{' '}
                                  <span style={{ color: '#999', fontWeight: 400, fontSize: 10 }}>#{r.dashboard.id}</span>
                                </div>
                                {r.vendor_match_reason && <ConfidenceChip reason={r.vendor_match_reason} />}
                              </div>
                              <div style={{ color: '#666', fontSize: 11 }}>
                                #{r.dashboard.invoice_number || '—'}
                                {(r.dashboard.family_amount ?? r.dashboard.amount) != null &&
                                  ` · ${fmt$(r.dashboard.family_amount ?? r.dashboard.amount)}`}
                              </div>
                              <div style={{ color: '#999', fontSize: 11, marginTop: 2 }}>
                                {r.dashboard.artist && <>artist: {r.dashboard.artist}</>}
                                {r.dashboard.payment_status && <> · {r.dashboard.payment_status}</>}
                                {r.dashboard.payment_date && <> {fmtDate(r.dashboard.payment_date)}</>}
                              </div>
                            </>
                          ) : <span style={{ color: '#bbb' }}>— not in dashboard —</span>}
                        </td>
                        <td style={{ ...tdStyle, maxWidth: 220 }}>
                          <IssueTags issues={r.issues} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const thStyle = {
  textAlign: 'left', padding: '8px 10px', fontSize: 10, fontWeight: 700,
  textTransform: 'uppercase', letterSpacing: '0.04em', color: '#666',
}
const tdStyle = {
  padding: '8px 10px', verticalAlign: 'top',
}
