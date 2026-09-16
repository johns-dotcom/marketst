import { useState, useRef, useCallback } from 'react'
import { Upload, FileText, CheckCircle2, XCircle, Loader, Trash2, Link2, AlertCircle, ChevronDown, Pencil } from 'lucide-react'
import api from '../api'
import getDarkColors from '../utils/darkColors'
import { useTheme } from '../context/ThemeContext'
import { CATEGORIES } from '../constants'
import { useCategories } from '../context/CategoriesContext'

const RED = '#334155'
const GREEN = '#16a34a'
const BLUE = '#3b82f6'

function fmt(v) {
  if (!v && v !== 0) return ''
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
}

// Convert File to base64
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1]) // strip data:...;base64,
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// Fuzzy match: are two payee names similar enough?
function payeesMatch(a, b) {
  if (!a || !b) return false
  const na = a.toLowerCase().replace(/[^a-z0-9]/g, '')
  const nb = b.toLowerCase().replace(/[^a-z0-9]/g, '')
  return na === nb || na.includes(nb) || nb.includes(na)
}

function amountsMatch(a, b) {
  if (!a || !b) return false
  return Math.abs(Number(a) - Number(b)) < 0.02
}

export default function BkBulkUpload() {
  // Live expense categories. Bound to the same name the module-level
  // import used, so every CATEGORIES reference in this component now
  // reads the vocabulary from context (which falls back to that same
  // constant if the fetch fails). Categories are user-created on the
  // Statements and Reports pages — a hardcoded list here would leave
  // this dropdown unable to render its own rows' values.
  const CATEGORIES = useCategories()
  const { theme } = useTheme()
  const C = getDarkColors(theme)

  // ── State ──
  const [invoiceFiles, setInvoiceFiles] = useState([])   // [{file, name, status, parsed, b64}]
  const [proofFiles, setProofFiles] = useState([])        // [{file, name, status, parsed, b64}]
  const [phase, setPhase] = useState('upload')             // upload | parsing | review | submitting | done
  const [parseProgress, setParseProgress] = useState({ current: 0, total: 0, label: '' })
  const [entries, setEntries] = useState([])               // editable parsed entries for review
  const [submitProgress, setSubmitProgress] = useState({ current: 0, total: 0 })
  const [submitResult, setSubmitResult] = useState(null)
  const [error, setError] = useState('')
  const invoiceRef = useRef(null)
  const proofRef = useRef(null)

  // ── File handlers ──
  const addFiles = useCallback((files, type) => {
    const accepted = Array.from(files).filter(f =>
      /\.(pdf|jpe?g|png)$/i.test(f.name)
    )
    if (type === 'invoice') {
      setInvoiceFiles(prev => [...prev, ...accepted.map(f => ({ file: f, name: f.name, status: 'pending', parsed: null, b64: null }))])
    } else {
      setProofFiles(prev => [...prev, ...accepted.map(f => ({ file: f, name: f.name, status: 'pending', parsed: null, b64: null }))])
    }
  }, [])

  const removeFile = (type, idx) => {
    if (type === 'invoice') setInvoiceFiles(prev => prev.filter((_, i) => i !== idx))
    else setProofFiles(prev => prev.filter((_, i) => i !== idx))
  }

  const handleDrop = useCallback((e, type) => {
    e.preventDefault()
    e.stopPropagation()
    addFiles(e.dataTransfer.files, type)
  }, [addFiles])

  const handleDragOver = (e) => { e.preventDefault(); e.stopPropagation() }

  // ── Parse all files ──
  const startParsing = async () => {
    if (!invoiceFiles.length) return
    setPhase('parsing')
    setError('')
    const total = invoiceFiles.length + proofFiles.length
    let current = 0

    // Parse invoices. Important: the file-read and the AI-parse are NOW
    // wrapped in SEPARATE try/catches. Previously a single try covered both,
    // so any AI parse failure (rate-limit / timeout / large file / Anthropic
    // hiccup) would wipe the already-successfully-read base64. That row
    // then submitted with invoice_data = null and the batch endpoint had
    // nothing to upload to R2 — leaving the user with a ledger row and no
    // viewable invoice. Keeping the b64 means we can still upload the file
    // even when metadata extraction fails (user can fill in fields by hand).
    const parsedInvoices = [...invoiceFiles]
    for (let i = 0; i < parsedInvoices.length; i++) {
      const item = parsedInvoices[i]
      current++
      setParseProgress({ current, total, label: `Parsing invoice: ${item.name}` })
      let b64 = null
      try {
        b64 = await fileToBase64(item.file)
      } catch (err) {
        // File read truly failed (huge file, weird encoding, etc.) — nothing
        // to upload either. This is the only path that should null out b64.
        parsedInvoices[i] = { ...item, status: 'error', parsed: {}, b64: null }
        continue
      }
      let parsed = {}
      try {
        const fd = new FormData()
        fd.append('file', item.file)
        const res = await api.post('/bk/parse', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
        parsed = res.data.data || {}
      } catch (err) {
        console.warn(`AI parse failed for "${item.name}" — file will still upload, but you'll need to fill in metadata manually.`, err?.response?.data?.error || err.message)
      }
      parsedInvoices[i] = { ...item, status: 'done', parsed, b64 }
    }
    setInvoiceFiles(parsedInvoices)

    // Parse proofs — same b64-preservation pattern as invoices above.
    const parsedProofs = [...proofFiles]
    for (let i = 0; i < parsedProofs.length; i++) {
      const item = parsedProofs[i]
      current++
      setParseProgress({ current, total, label: `Parsing proof: ${item.name}` })
      let b64 = null
      try {
        b64 = await fileToBase64(item.file)
      } catch (err) {
        parsedProofs[i] = { ...item, status: 'error', parsed: {}, b64: null }
        continue
      }
      let parsed = {}
      try {
        const fd = new FormData()
        fd.append('file', item.file)
        const res = await api.post('/bk/parse-proof', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
        parsed = res.data.data || {}
      } catch (err) {
        console.warn(`AI parse failed for proof "${item.name}" — file will still upload.`, err?.response?.data?.error || err.message)
      }
      parsedProofs[i] = { ...item, status: 'done', parsed, b64 }
    }
    setProofFiles(parsedProofs)

    // Auto-match proofs to invoices
    const matchedEntries = parsedInvoices.map((inv, idx) => {
      const p = inv.parsed || {}
      // Find best matching proof
      let matchedProofIdx = -1
      for (let j = 0; j < parsedProofs.length; j++) {
        const proof = parsedProofs[j]
        if (proof.status !== 'done' || !proof.parsed) continue
        const pp = proof.parsed
        if (payeesMatch(p.payee, pp.payee) && amountsMatch(p.amount, pp.amount)) {
          matchedProofIdx = j
          break
        }
      }
      return {
        _idx: idx,
        invoice_date: p.invoice_date || '',
        payee: p.payee || '',
        amount: p.amount || '',
        invoice_number: p.invoice_number || '',
        category: p.category || '',
        artist: p.artist || '',
        song: p.song || '',
        description: p.description || '',
        currency: p.currency || 'USD',
        payment_method: p.payment_method || '',
        invoice_data: inv.b64,
        invoice_filename: inv.name,
        // Matched proof
        matchedProofIdx,
        proof_data: matchedProofIdx >= 0 ? parsedProofs[matchedProofIdx].b64 : null,
        proof_filename: matchedProofIdx >= 0 ? parsedProofs[matchedProofIdx].name : null,
        payment_status: matchedProofIdx >= 0 ? 'Paid' : 'Unpaid',
        payment_date: matchedProofIdx >= 0 ? (parsedProofs[matchedProofIdx].parsed?.payment_date || '') : '',
        payment_ref: matchedProofIdx >= 0 ? (parsedProofs[matchedProofIdx].parsed?.reference_number || '') : '',
        include: true,
      }
    })
    setEntries(matchedEntries)
    setPhase('review')
  }

  // ── Update entry field ──
  const updateEntry = (idx, field, value) => {
    setEntries(prev => prev.map((e, i) => i === idx ? { ...e, [field]: value } : e))
  }

  // ── Manually match a proof to an entry ──
  const matchProof = (entryIdx, proofIdx) => {
    const proof = proofFiles[proofIdx]
    if (!proof || proof.status !== 'done') return
    setEntries(prev => prev.map((e, i) => {
      if (i !== entryIdx) return e
      return {
        ...e,
        matchedProofIdx: proofIdx,
        proof_data: proof.b64,
        proof_filename: proof.name,
        payment_status: 'Paid',
        payment_date: proof.parsed?.payment_date || e.payment_date,
        payment_ref: proof.parsed?.reference_number || e.payment_ref,
      }
    }))
  }

  const unmatchProof = (entryIdx) => {
    setEntries(prev => prev.map((e, i) => {
      if (i !== entryIdx) return e
      return { ...e, matchedProofIdx: -1, proof_data: null, proof_filename: null, payment_status: 'Unpaid', payment_date: '', payment_ref: '' }
    }))
  }

  // ── Submit all entries ──
  const submitAll = async () => {
    const toSubmit = entries.filter(e => e.include && e.payee && e.amount)
    if (!toSubmit.length) return
    setPhase('submitting')
    setSubmitProgress({ current: 0, total: toSubmit.length })
    setError('')

    try {
      const res = await api.post('/bk/entries/batch', {
        entries: toSubmit.map(e => ({
          invoice_date: e.invoice_date || null,
          payee: e.payee,
          amount: Number(e.amount),
          description: e.description,
          category: e.category,
          artist: e.artist,
          song: e.song,
          invoice_number: e.invoice_number,
          currency: e.currency || 'USD',
          payment_method: e.payment_method,
          payment_status: e.payment_status,
          payment_date: e.payment_date || null,
          payment_ref: e.payment_ref || null,
          invoice_data: e.invoice_data,
          invoice_filename: e.invoice_filename,
          proof_data: e.proof_data,
          proof_filename: e.proof_filename,
          settlement_label: e.settlement_label || null,
        }))
      })
      // Server reports per-entry success/failure now. Surface any
      // partial failures so the user knows which files didn't make it.
      const failedRows = res.data.failed || []
      setSubmitResult({
        count: res.data.count,
        failed: failedRows,
        failedCount: res.data.failedCount || 0,
        // Which "one payment" groups took, and which were REFUSED. An invoice
        // created but not grouped is the failure that reads as success: the page
        // says "12 uploaded" and the payment still fails to match later, with
        // nothing anywhere saying why.
        groups: res.data.groups || [],
        groupErrors: res.data.group_errors || [],
      })
      setPhase('done')
    } catch (err) {
      setError('Failed to submit: ' + (err.response?.data?.error || err.message))
      setPhase('review')
    }
  }

  // ── Unmatched proofs ──
  const usedProofIdxs = new Set(entries.filter(e => e.matchedProofIdx >= 0).map(e => e.matchedProofIdx))
  const unmatchedProofs = proofFiles.map((p, i) => ({ ...p, _idx: i })).filter(p => p.status === 'done' && !usedProofIdxs.has(p._idx))

  // ── Styles ──
  const cardSty = { background: C.cardBg, borderRadius: 12, border: '1px solid ' + C.border, overflow: 'hidden' }
  const dropZone = (active) => ({
    border: '2px dashed ' + (active ? BLUE : C.border),
    borderRadius: 12, padding: '40px 20px', textAlign: 'center',
    cursor: 'pointer', transition: 'all 0.15s', background: active ? (C.isDark ? '#1a1d28' : '#f0f7ff') : C.cardBg,
  })
  const inputSty = {
    width: '100%', border: '1px solid ' + C.border, borderRadius: 6, padding: '5px 8px',
    fontSize: 12, fontFamily: 'inherit', outline: 'none', color: C.text, background: C.cardBg,
  }
  const btnPrimary = {
    background: RED, border: 'none', borderRadius: 8, padding: '10px 24px',
    fontSize: 14, fontWeight: 700, color: '#fff', fontFamily: 'inherit', cursor: 'pointer',
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════════

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 16px' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: C.text, margin: 0 }}>Bulk Upload</h1>
        <p style={{ color: '#888', fontSize: 13, margin: '4px 0 0' }}>
          Upload invoices and proofs of payment in batch. Files are AI-parsed, auto-matched, and added to the ledger.
        </p>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', color: '#991b1b', padding: '10px 14px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 16 }}>
          <AlertCircle style={{ width: 16, height: 16, flexShrink: 0 }} /> {error}
          <button onClick={() => setError('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#991b1b', cursor: 'pointer' }}>&#x2715;</button>
        </div>
      )}

      {/* ── PHASE: UPLOAD ── */}
      {phase === 'upload' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
            {/* Invoice drop zone */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Invoices</div>
              <div
                style={dropZone(false)}
                onDrop={e => handleDrop(e, 'invoice')}
                onDragOver={handleDragOver}
                onClick={() => invoiceRef.current?.click()}
              >
                <Upload style={{ width: 28, height: 28, color: '#bbb', margin: '0 auto 8px' }} />
                <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Drop invoices here</div>
                <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>PDF, JPG, or PNG</div>
                <input
                  ref={invoiceRef}
                  type="file"
                  multiple
                  accept=".pdf,.jpg,.jpeg,.png"
                  style={{ display: 'none' }}
                  onChange={e => { addFiles(e.target.files, 'invoice'); e.target.value = '' }}
                />
              </div>
              {invoiceFiles.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {invoiceFiles.map((f, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid ' + C.border }}>
                      <FileText style={{ width: 14, height: 14, color: '#b45309', flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: C.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                      <button onClick={() => removeFile('invoice', i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', padding: 0 }}>
                        <Trash2 style={{ width: 13, height: 13 }} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Proof drop zone */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Proofs of Payment</div>
              <div
                style={dropZone(false)}
                onDrop={e => handleDrop(e, 'proof')}
                onDragOver={handleDragOver}
                onClick={() => proofRef.current?.click()}
              >
                <Upload style={{ width: 28, height: 28, color: '#bbb', margin: '0 auto 8px' }} />
                <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Drop proofs here</div>
                <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>PDF, JPG, or PNG (optional)</div>
                <input
                  ref={proofRef}
                  type="file"
                  multiple
                  accept=".pdf,.jpg,.jpeg,.png"
                  style={{ display: 'none' }}
                  onChange={e => { addFiles(e.target.files, 'proof'); e.target.value = '' }}
                />
              </div>
              {proofFiles.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {proofFiles.map((f, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid ' + C.border }}>
                      <FileText style={{ width: 14, height: 14, color: GREEN, flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: C.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                      <button onClick={() => removeFile('proof', i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', padding: 0 }}>
                        <Trash2 style={{ width: 13, height: 13 }} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
            <span style={{ fontSize: 12, color: '#999', alignSelf: 'center' }}>
              {invoiceFiles.length} invoice{invoiceFiles.length !== 1 ? 's' : ''}
              {proofFiles.length > 0 && `, ${proofFiles.length} proof${proofFiles.length !== 1 ? 's' : ''}`}
            </span>
            <button
              onClick={startParsing}
              disabled={!invoiceFiles.length}
              style={{ ...btnPrimary, opacity: invoiceFiles.length ? 1 : 0.4 }}
            >
              Parse &amp; Match
            </button>
          </div>
        </>
      )}

      {/* ── PHASE: PARSING ── */}
      {phase === 'parsing' && (
        <div style={{ ...cardSty, padding: '60px 40px', textAlign: 'center' }}>
          <Loader style={{ width: 32, height: 32, color: RED, margin: '0 auto 16px', animation: 'spin 0.8s linear infinite' }} />
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>
            Parsing files... {parseProgress.current} of {parseProgress.total}
          </div>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>{parseProgress.label}</div>
          <div style={{ width: 300, height: 6, background: '#f3f4f6', borderRadius: 3, margin: '0 auto', overflow: 'hidden' }}>
            <div style={{
              width: `${parseProgress.total ? Math.round((parseProgress.current / parseProgress.total) * 100) : 0}%`,
              height: '100%', background: RED, borderRadius: 3, transition: 'width 0.3s',
            }} />
          </div>
          <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
        </div>
      )}

      {/* ── PHASE: REVIEW ── */}
      {phase === 'review' && (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 12 }}>
            {entries.filter(e => e.include).length} invoices ready
            {entries.filter(e => e.matchedProofIdx >= 0).length > 0 &&
              ` \u00b7 ${entries.filter(e => e.matchedProofIdx >= 0).length} matched with proofs`
            }
            {unmatchedProofs.length > 0 &&
              ` \u00b7 ${unmatchedProofs.length} unmatched proof${unmatchedProofs.length !== 1 ? 's' : ''}`
            }
          </div>
          <div style={{ ...cardSty, overflowX: 'auto', marginBottom: 16 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: C.thBg }}>
                  <th style={{ padding: '8px 10px', textAlign: 'center', fontSize: 10, fontWeight: 800, color: C.thText, letterSpacing: '0.07em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}></th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: C.thText, letterSpacing: '0.07em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Payee</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 10, fontWeight: 800, color: C.thText, letterSpacing: '0.07em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Amount</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: C.thText, letterSpacing: '0.07em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Date</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: C.thText, letterSpacing: '0.07em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Invoice #</th>
                  {/* "These two were sent in one payment." The matcher is 1:1 on
                      an amount equal to the cent, so a vendor paid for two
                      invoices in one transfer matches NOTHING unless somebody
                      says so — and upload is when you know. */}
                  <th title="Invoices sent in ONE payment. Give them the same letter and the matcher will settle a bank line that totals them exactly."
                    style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: C.thText, letterSpacing: '0.07em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>One payment</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: C.thText, letterSpacing: '0.07em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Category</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: C.thText, letterSpacing: '0.07em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Artist</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: C.thText, letterSpacing: '0.07em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Song</th>
                  <th style={{ padding: '8px 10px', textAlign: 'center', fontSize: 10, fontWeight: 800, color: C.thText, letterSpacing: '0.07em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Proof</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: C.thText, letterSpacing: '0.07em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, idx) => (
                  <tr key={idx} style={{ background: entry.include ? C.rowBg : (C.isDark ? '#1a1515' : '#fef2f2'), borderBottom: '1px solid ' + C.tdBorder }}>
                    <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={entry.include}
                        onChange={e => updateEntry(idx, 'include', e.target.checked)}
                        style={{ cursor: 'pointer' }}
                      />
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <input value={entry.payee} onChange={e => updateEntry(idx, 'payee', e.target.value)} style={{ ...inputSty, fontWeight: 700 }} />
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <input type="number" step="0.01" value={entry.amount} onChange={e => updateEntry(idx, 'amount', e.target.value)} style={{ ...inputSty, textAlign: 'right', fontWeight: 700, width: 100 }} />
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <input type="date" value={entry.invoice_date} onChange={e => updateEntry(idx, 'invoice_date', e.target.value)} style={{ ...inputSty, width: 120 }} />
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <input value={entry.invoice_number} onChange={e => updateEntry(idx, 'invoice_number', e.target.value)} style={{ ...inputSty, width: 100 }} />
                    </td>
                    {/* A letter, not a checkbox: three invoices might be two
                        payments, and a boolean cannot say which is which. The
                        letter is only a label — the server resolves it into a
                        group once the ids exist, and validates that the members
                        could physically BE one payment (same vendor, 2+ of them,
                        none already settled). */}
                    <td style={{ padding: '6px 8px' }}>
                      <select value={entry.settlement_label || ''}
                        onChange={e => updateEntry(idx, 'settlement_label', e.target.value)}
                        title="Same letter = one payment"
                        style={{ ...inputSty, width: 74, cursor: 'pointer',
                          fontWeight: entry.settlement_label ? 800 : 400 }}>
                        <option value="">—</option>
                        {['A', 'B', 'C', 'D', 'E'].map(L => <option key={L} value={L}>{L}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <select value={entry.category} onChange={e => updateEntry(idx, 'category', e.target.value)} style={{ ...inputSty, width: 130, cursor: 'pointer' }}>
                        <option value="">—</option>
                        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <input value={entry.artist} onChange={e => updateEntry(idx, 'artist', e.target.value)} style={{ ...inputSty, width: 120 }} />
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <input value={entry.song} onChange={e => updateEntry(idx, 'song', e.target.value)} style={{ ...inputSty, width: 120 }} />
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                      {entry.matchedProofIdx >= 0 ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'center' }}>
                          <CheckCircle2 style={{ width: 14, height: 14, color: GREEN }} />
                          <span style={{ fontSize: 10, color: GREEN, fontWeight: 700, maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {entry.proof_filename}
                          </span>
                          <button onClick={() => unmatchProof(idx)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', padding: 0 }}>
                            <XCircle style={{ width: 12, height: 12 }} />
                          </button>
                        </div>
                      ) : unmatchedProofs.length > 0 ? (
                        <select
                          value=""
                          onChange={e => { if (e.target.value) matchProof(idx, parseInt(e.target.value)) }}
                          style={{ ...inputSty, width: 120, fontSize: 11, cursor: 'pointer' }}
                        >
                          <option value="">Match proof...</option>
                          {unmatchedProofs.map(p => (
                            <option key={p._idx} value={p._idx}>{p.name}</option>
                          ))}
                        </select>
                      ) : (
                        <span style={{ fontSize: 11, color: '#ccc' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                        background: entry.payment_status === 'Paid' ? '#dcfce7' : '#fef9c3',
                        color: entry.payment_status === 'Paid' ? '#15803d' : '#92400e',
                      }}>
                        {entry.payment_status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button
              onClick={() => { setPhase('upload'); setEntries([]); setInvoiceFiles(prev => prev.map(f => ({ ...f, status: 'pending', parsed: null, b64: null }))); setProofFiles(prev => prev.map(f => ({ ...f, status: 'pending', parsed: null, b64: null }))) }}
              style={{ background: 'none', border: '1px solid ' + C.border, borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 600, color: C.text, fontFamily: 'inherit', cursor: 'pointer' }}
            >
              Back
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 13, color: '#888' }}>
                {entries.filter(e => e.include).length} of {entries.length} selected
                {' \u00b7 '}
                {fmt(entries.filter(e => e.include).reduce((s, e) => s + (Number(e.amount) || 0), 0))} total
              </span>
              <button
                onClick={submitAll}
                disabled={!entries.filter(e => e.include && e.payee && e.amount).length}
                style={{ ...btnPrimary, opacity: entries.filter(e => e.include && e.payee && e.amount).length ? 1 : 0.4 }}
              >
                Add {entries.filter(e => e.include).length} to Ledger
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── PHASE: SUBMITTING ── */}
      {phase === 'submitting' && (
        <div style={{ ...cardSty, padding: '60px 40px', textAlign: 'center' }}>
          <Loader style={{ width: 32, height: 32, color: RED, margin: '0 auto 16px', animation: 'spin 0.8s linear infinite' }} />
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>
            Adding entries to ledger...
          </div>
          <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
        </div>
      )}

      {/* ── PHASE: DONE ── */}
      {phase === 'done' && submitResult && (
        <div style={{ ...cardSty, padding: '60px 40px', textAlign: 'center' }}>
          <CheckCircle2 style={{ width: 48, height: 48, color: GREEN, margin: '0 auto 16px' }} />
          <div style={{ fontSize: 20, fontWeight: 800, color: C.text, marginBottom: 8 }}>
            {submitResult.count} {submitResult.count === 1 ? 'entry' : 'entries'} added
          </div>
          <p style={{ fontSize: 14, color: '#888', marginBottom: 24 }}>
            All invoices have been added to the ledger.
            {entries.filter(e => e.matchedProofIdx >= 0).length > 0 &&
              ` ${entries.filter(e => e.matchedProofIdx >= 0 && e.include).length} matched with proofs of payment.`
            }
          </p>
          {/* Partial-failure summary — the server returns per-entry failures
              now, so the user sees which files didn't make it instead of
              finding ledger rows with broken view-invoice buttons later. */}
          {submitResult.failedCount > 0 && (
            <div style={{
              maxWidth: 480, margin: '0 auto 24px', textAlign: 'left',
              background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8,
              padding: '12px 14px', color: '#991b1b', fontSize: 13,
            }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>
                {submitResult.failedCount} {submitResult.failedCount === 1 ? 'invoice' : 'invoices'} couldn't be saved
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                {submitResult.failed.slice(0, 10).map((f, i) => (
                  <li key={i} style={{ marginBottom: 2 }}>
                    <strong>{f.payee || '—'}</strong>
                    {f.filename ? ` (${f.filename})` : ''}
                    {f.error ? ` — ${f.error}` : ''}
                  </li>
                ))}
                {submitResult.failed.length > 10 && (
                  <li style={{ marginTop: 4, fontStyle: 'italic' }}>
                    …and {submitResult.failed.length - 10} more
                  </li>
                )}
              </ul>
              <div style={{ marginTop: 8, fontSize: 12, color: '#7c2d12' }}>
                These rows have been rolled back — no ledger entries were created for them. Retry by re-uploading the same files.
              </div>
            </div>
          )}
          {/* What happened to the "one payment" markers. Reported both ways:
              a group that took is what makes the bank line match itself later,
              and a group that was REFUSED leaves invoices that will not match —
              silence there would read as success. */}
          {(submitResult.groups?.length > 0 || submitResult.groupErrors?.length > 0) && (
            <div style={{
              maxWidth: 480, margin: '0 auto 24px', textAlign: 'left',
              background: C.isDark ? '#15181f' : '#f8fafc',
              border: '1px solid ' + C.border, borderRadius: 8,
              padding: '12px 14px', fontSize: 13, color: C.text,
            }}>
              {submitResult.groups?.map(g => (
                <div key={g.group} style={{ marginBottom: 4 }}>
                  <strong>{g.label}</strong>: {g.members.length} invoices marked as one payment
                  <div style={{ fontSize: 11.5, color: '#888' }}>
                    A bank line totalling them exactly will settle all of them.
                  </div>
                </div>
              ))}
              {submitResult.groupErrors?.map((g, i) => (
                <div key={i} style={{ marginTop: 6, color: '#b45309' }}>
                  <strong>{g.label}</strong> was not grouped — {g.error}
                  <div style={{ fontSize: 11.5 }}>
                    The invoices were still added. Group them from the ledger with One payment.
                  </div>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <button
              onClick={() => { setPhase('upload'); setInvoiceFiles([]); setProofFiles([]); setEntries([]); setSubmitResult(null) }}
              style={{ background: 'none', border: '1px solid ' + C.border, borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 600, color: C.text, fontFamily: 'inherit', cursor: 'pointer' }}
            >
              Upload More
            </button>
            <a
              href="/bk/ledger"
              style={{ ...btnPrimary, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
            >
              View Ledger
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
