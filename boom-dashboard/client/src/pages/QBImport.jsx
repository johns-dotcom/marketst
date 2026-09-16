import { useState, useRef, useEffect, useCallback } from 'react'
import { useCategories } from '../context/CategoriesContext'
import {
  Upload, FileText, CheckCircle2, AlertCircle, ChevronRight,
  ArrowLeft, Loader, X, TrendingUp, TrendingDown, RefreshCw,
  Info,
} from 'lucide-react'
import api from '../api'
import { formatDate } from '../utils'
import PageHeader from '../components/PageHeader'

// ─── QB-aware CSV parser ──────────────────────────────────────────────────────

function parseCSVRow(line) {
  const result = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (c === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += c
    }
  }
  result.push(current.trim())
  return result
}

function parseCSV(rawText) {
  const lines = rawText.split('\n').map(l => l.replace(/\r$/, ''))

  // QuickBooks puts title / date-range rows before the real header.
  // Find the first row that looks like a data header by checking for
  // "date" AND ("amount" or "debit" or "description" or "memo").
  let headerIdx = -1
  for (let i = 0; i < Math.min(25, lines.length); i++) {
    const lower = lines[i].toLowerCase()
    if (lower.includes('date') &&
        (lower.includes('amount') || lower.includes('debit') || lower.includes('memo') || lower.includes('description'))) {
      headerIdx = i
      break
    }
  }
  if (headerIdx === -1) {
    return { error: 'Could not find a header row. Make sure the CSV has Date and Amount columns.', rows: [] }
  }

  const rawHeaders = parseCSVRow(lines[headerIdx])
  const headers = rawHeaders.map(h => h.toLowerCase().replace(/[^a-z0-9 /]/g, '').trim())

  const find = (...candidates) =>
    headers.findIndex(h => candidates.some(c => h === c || h.includes(c)))

  const colMap = {
    date:        find('date'),
    description: find('memo/description', 'memo', 'description', 'narration', 'particulars'),
    name:        find('name', 'payee', 'vendor', 'customer', 'counterparty'),
    type:        find('transaction type', 'type', 'txn type'),
    amount:      find('amount'),
    debit:       find('debit', 'withdrawal', 'charge'),
    credit:      find('credit', 'deposit', 'payment'),
    account:     find('account', 'category', 'class'),
    num:         find('num', 'ref no', 'reference', 'invoice no'),
  }

  // Must have at least date + (amount or debit/credit)
  if (colMap.date === -1) return { error: 'No Date column found.', rows: [] }
  if (colMap.amount === -1 && colMap.debit === -1 && colMap.credit === -1) {
    return { error: 'No Amount, Debit, or Credit column found.', rows: [] }
  }

  const dataRows = []
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const cells = parseCSVRow(lines[i])
    if (cells.length < 2) continue
    if (cells.every(c => !c)) continue  // blank row

    const get = idx => (idx >= 0 && idx < cells.length ? cells[idx] : '')

    // Resolve amount — handle debit/credit split columns or single amount column
    let rawAmount = ''
    if (colMap.amount >= 0) {
      rawAmount = get(colMap.amount)
    } else {
      const debit  = parseFloat(get(colMap.debit).replace(/[$,\s]/g, ''))  || 0
      const credit = parseFloat(get(colMap.credit).replace(/[$,\s]/g, '')) || 0
      rawAmount = credit > 0 ? String(credit) : String(-debit)
    }

    const numericAmount = parseFloat(rawAmount.replace(/[$,\s]/g, ''))
    if (isNaN(numericAmount) || numericAmount === 0) continue

    // Description: prefer memo/description column, fall back to name
    let description = get(colMap.description) || get(colMap.name) || 'Imported transaction'
    if (colMap.name >= 0 && get(colMap.name) && get(colMap.description) && get(colMap.name) !== get(colMap.description)) {
      description = `${get(colMap.name)} – ${get(colMap.description)}`
    }

    // Normalise date — QB uses MM/DD/YYYY; try to coerce to YYYY-MM-DD
    let dateStr = get(colMap.date)
    const dateParts = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
    if (dateParts) dateStr = `${dateParts[3]}-${dateParts[1].padStart(2,'0')}-${dateParts[2].padStart(2,'0')}`

    // Infer income vs expense from transaction type column or amount sign
    const txnType = get(colMap.type).toLowerCase()
    let suggestedType = numericAmount < 0 ? 'expense' : 'income'
    if (['invoice', 'sales receipt', 'payment', 'deposit', 'credit memo'].some(t => txnType.includes(t))) {
      suggestedType = 'income'
    } else if (['bill', 'check', 'expense', 'purchase', 'credit card', 'journal entry'].some(t => txnType.includes(t))) {
      suggestedType = 'expense'
    }

    dataRows.push({
      _id:         i,          // stable key for React
      date:        dateStr,
      description: description.replace(/^"+|"+$/g, ''),
      raw_amount:  numericAmount,
      amount:      Math.abs(numericAmount),
      record_type: suggestedType,
      txn_type:    get(colMap.type),
      account:     get(colMap.account),
      // user-assigned (filled in step 2)
      artist_id:   null,
      artist_name: '',
      category:    suggestedType === 'expense' ? 'Other' : null,
      income_type: suggestedType === 'income'  ? 'Other' : null,
      recoupable:  false,
      include:     true,
    })
  }

  if (dataRows.length === 0) {
    return { error: 'No valid transactions found. Check that amount values are numeric.', rows: [] }
  }

  return { error: null, rows: dataRows, colMap, headers: rawHeaders }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const INCOME_TYPES = [
  'Streaming','Sync Licensing','Physical Sales','Digital Download',
  'Merch','Performance','YouTube','Label Deal','Other',
]

// ─── Main component ───────────────────────────────────────────────────────────

export default function QBImport() {
  // Was a fifth hardcoded copy of the expense list. Categories are created
  // at runtime now, so an import mapping built from a stale copy couldn't
  // target them.
  const EXPENSE_CATEGORIES = useCategories()
  const [step, setStep]         = useState(1)          // 1 upload · 2 review · 3 done
  const [csvText, setCsvText]   = useState('')
  const [parseError, setParseError] = useState(null)
  const [rows, setRows]         = useState([])
  const [artists, setArtists]   = useState([])
  const [globalArtistId, setGlobalArtistId]     = useState('')
  const [globalArtistName, setGlobalArtistName] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult]     = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef(null)

  // Fetch artist list once
  useEffect(() => {
    api.get('/artists?limit=200').then(res => {
      const data = res.data?.data || res.data || []
      // Some endpoints return { data, total }
      setArtists(Array.isArray(data) ? data : (data.data || []))
    }).catch(() => {})
  }, [])

  // ── File handling ──
  const handleFile = useCallback((file) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = e => setCsvText(e.target.result)
    reader.readAsText(file)
  }, [])

  const onFileInput = e => handleFile(e.target.files[0])

  const onDrop = e => {
    e.preventDefault(); setDragOver(false)
    handleFile(e.dataTransfer.files[0])
  }

  // ── Parse ──
  const handleParse = () => {
    setParseError(null)
    const { error, rows: parsed } = parseCSV(csvText)
    if (error) { setParseError(error); return }
    setRows(parsed)
    setStep(2)
  }

  // ── Row helpers ──
  const updateRow = (id, patch) =>
    setRows(prev => prev.map(r => r._id === id ? { ...r, ...patch } : r))

  const applyGlobalArtist = () => {
    if (!globalArtistId && !globalArtistName) return
    setRows(prev => prev.map(r => ({
      ...r,
      artist_id:   globalArtistId   || r.artist_id,
      artist_name: globalArtistName || r.artist_name,
    })))
  }

  // ── Commit ──
  const handleImport = async () => {
    const toImport = rows.filter(r => r.include)
    if (toImport.length === 0) return
    setImporting(true)
    try {
      const res = await api.post('/import/bulk', { rows: toImport })
      setResult(res.data.data)
      setStep(3)
    } catch (err) {
      setParseError(err.response?.data?.error || 'Import failed — please try again.')
    } finally {
      setImporting(false)
    }
  }

  const reset = () => {
    setStep(1); setCsvText(''); setRows([])
    setParseError(null); setResult(null)
    setGlobalArtistId(''); setGlobalArtistName('')
    if (fileRef.current) fileRef.current.value = ''
  }

  // ── Derived counts ──
  const included   = rows.filter(r => r.include)
  const incomeRows = included.filter(r => r.record_type === 'income')
  const expRows    = included.filter(r => r.record_type === 'expense')

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-4">
        <span className="inline-flex items-center px-3 py-1 bg-amber-200 text-amber-900 rounded-full text-xs font-bold tracking-wider uppercase">
          Work in progress
        </span>
      </div>
      {/* Header */}
      <PageHeader
        title="QuickBooks Import"
        subtitle="Export a Transaction List or Profit & Loss report from QuickBooks, then upload it here."
      />

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8">
        {['Upload', 'Review', 'Done'].map((label, idx) => {
          const n = idx + 1
          const active    = step === n
          const completed = step > n
          return (
            <div key={label} className="flex items-center gap-2">
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                active    ? 'bg-boom-600 text-white' :
                completed ? 'bg-emerald-100 text-emerald-700' :
                            'bg-gray-100 text-gray-400'
              }`}>
                {completed
                  ? <CheckCircle2 size={13} />
                  : <span className="w-4 h-4 flex items-center justify-center rounded-full border border-current text-[10px]">{n}</span>
                }
                {label}
              </div>
              {idx < 2 && <ChevronRight size={14} className="text-gray-300" />}
            </div>
          )
        })}
      </div>

      {/* ─── Step 1: Upload ─── */}
      {step === 1 && (
        <div className="space-y-6">
          {/* How-to callout */}
          <div className="flex gap-3 bg-blue-50 border border-blue-100 rounded-xl p-4">
            <Info size={16} className="text-blue-500 mt-0.5 flex-shrink-0" />
            <div className="text-sm text-blue-800 space-y-1">
              <p className="font-semibold">How to export from QuickBooks</p>
              <p>Go to <strong>Reports → Transaction List by Date</strong> (or any report with Date &amp; Amount columns), set your date range, then click <strong>Export → Export to Excel/CSV</strong>.</p>
              <p className="text-blue-600">Most standard QB CSV exports will work automatically.</p>
            </div>
          </div>

          {/* Drop zone */}
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            className={`border-2 border-dashed rounded-2xl p-12 flex flex-col items-center justify-center gap-3 cursor-pointer transition-all ${
              dragOver
                ? 'border-boom-400 bg-boom-50'
                : 'border-rule hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            <Upload size={28} className={dragOver ? 'text-boom-500' : 'text-gray-300'} />
            <div className="text-center">
              <p className="text-sm font-semibold text-gray-700">Drop your CSV here</p>
              <p className="text-xs text-gray-400 mt-0.5">or click to browse</p>
            </div>
            <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={onFileInput} />
          </div>

          {/* Or paste */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Or paste CSV text directly
            </label>
            <textarea
              value={csvText}
              onChange={e => setCsvText(e.target.value)}
              rows={8}
              placeholder="Paste your QuickBooks CSV export here…"
              className="w-full text-xs font-mono border border-rule rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-boom-400 resize-y text-gray-700 placeholder:text-gray-300"
            />
          </div>

          {parseError && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-100 rounded-xl p-4 text-sm text-red-700">
              <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
              <span>{parseError}</span>
            </div>
          )}

          <button
            onClick={handleParse}
            disabled={!csvText.trim()}
            className="px-6 py-2.5 text-sm font-semibold bg-gray-900 text-white rounded-xl hover:bg-gray-800 transition-colors disabled:opacity-40 flex items-center gap-2"
          >
            Parse File
            <ChevronRight size={15} />
          </button>
        </div>
      )}

      {/* ─── Step 2: Review ─── */}
      {step === 2 && (
        <div className="space-y-5">
          {/* Summary bar */}
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2 bg-gray-50 border border-rule rounded-xl px-4 py-2.5">
              <FileText size={15} className="text-gray-400" />
              <span className="text-sm font-semibold text-gray-700">{included.length} rows selected</span>
            </div>
            <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-2.5">
              <TrendingUp size={15} className="text-emerald-500" />
              <span className="text-sm font-semibold text-emerald-700">
                {incomeRows.length} income · ${incomeRows.reduce((s, r) => s + r.amount, 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
            <div className="flex items-center gap-2 bg-red-50 border border-red-100 rounded-xl px-4 py-2.5">
              <TrendingDown size={15} className="text-red-400" />
              <span className="text-sm font-semibold text-red-700">
                {expRows.length} expenses · ${expRows.reduce((s, r) => s + r.amount, 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
            <button
              onClick={() => { setStep(1); setParseError(null) }}
              className="ml-auto flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              <ArrowLeft size={13} /> Re-upload
            </button>
          </div>

          {/* Global artist assignment */}
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 flex items-end gap-3 flex-wrap">
            <div className="flex-1 min-w-40">
              <label className="block text-xs font-semibold text-blue-700 mb-1.5">Apply one artist to all rows</label>
              <select
                value={globalArtistId}
                onChange={e => {
                  const id = e.target.value
                  const artist = artists.find(a => String(a.id) === id)
                  setGlobalArtistId(id)
                  setGlobalArtistName(artist?.name || '')
                }}
                className="w-full text-sm border border-blue-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-400 bg-card"
              >
                <option value="">— Select artist —</option>
                {artists.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <button
              onClick={applyGlobalArtist}
              disabled={!globalArtistId}
              className="px-4 py-2 text-sm font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-40"
            >
              Apply to all
            </button>
            <p className="text-xs text-blue-500 w-full -mt-1">You can also set artist per-row below.</p>
          </div>

          {/* Row table */}
          <div className="border border-rule rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-rule">
                    <th className="px-3 py-3 text-left">
                      <input
                        type="checkbox"
                        checked={rows.every(r => r.include)}
                        onChange={e => setRows(prev => prev.map(r => ({ ...r, include: e.target.checked })))}
                        className="rounded border-gray-300 accent-boom-600"
                      />
                    </th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Date</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Description</th>
                    <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Amount</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Type</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Artist</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Category</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map(row => (
                    <tr key={row._id} className={`transition-colors ${row.include ? 'bg-card hover:bg-gray-50' : 'bg-gray-50 opacity-50'}`}>
                      {/* Include checkbox */}
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={row.include}
                          onChange={e => updateRow(row._id, { include: e.target.checked })}
                          className="rounded border-gray-300 accent-boom-600"
                        />
                      </td>

                      {/* Date */}
                      <td className="px-3 py-2 whitespace-nowrap text-gray-600 text-xs">
                        {formatDate(row.date)}
                      </td>

                      {/* Description */}
                      <td className="px-3 py-2 max-w-xs">
                        <input
                          type="text"
                          value={row.description}
                          onChange={e => updateRow(row._id, { description: e.target.value })}
                          className="w-full text-xs text-gray-800 bg-transparent border-0 focus:outline-none focus:bg-card focus:border focus:border-gray-300 rounded px-1 py-0.5 -mx-1"
                        />
                      </td>

                      {/* Amount */}
                      <td className={`px-3 py-2 text-right font-semibold text-xs whitespace-nowrap ${
                        row.record_type === 'income' ? 'text-emerald-600' : 'text-red-500'
                      }`}>
                        {row.record_type === 'income' ? '+' : '-'}$
                        {row.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>

                      {/* Type toggle */}
                      <td className="px-3 py-2">
                        <div className="flex rounded-lg overflow-hidden border border-rule w-fit">
                          <button
                            onClick={() => updateRow(row._id, { record_type: 'income', income_type: row.income_type || 'Other', category: null })}
                            className={`px-2 py-1 text-[11px] font-semibold transition-colors ${
                              row.record_type === 'income' ? 'bg-emerald-500 text-white' : 'text-gray-400 hover:bg-gray-50'
                            }`}
                          >Inc</button>
                          <button
                            onClick={() => updateRow(row._id, { record_type: 'expense', category: row.category || 'Other', income_type: null })}
                            className={`px-2 py-1 text-[11px] font-semibold transition-colors ${
                              row.record_type === 'expense' ? 'bg-red-400 text-white' : 'text-gray-400 hover:bg-gray-50'
                            }`}
                          >Exp</button>
                        </div>
                      </td>

                      {/* Artist */}
                      <td className="px-3 py-2">
                        <select
                          value={row.artist_id || ''}
                          onChange={e => {
                            const id = e.target.value
                            const artist = artists.find(a => String(a.id) === id)
                            updateRow(row._id, { artist_id: id || null, artist_name: artist?.name || '' })
                          }}
                          className="text-xs border border-rule rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-boom-400 min-w-28"
                        >
                          <option value="">No artist</option>
                          {artists.map(a => (
                            <option key={a.id} value={a.id}>{a.name}</option>
                          ))}
                        </select>
                      </td>

                      {/* Category / Income type */}
                      <td className="px-3 py-2">
                        {row.record_type === 'expense' ? (
                          <select
                            value={row.category || 'Other'}
                            onChange={e => updateRow(row._id, { category: e.target.value })}
                            className="text-xs border border-rule rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-boom-400 min-w-28"
                          >
                            {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        ) : (
                          <select
                            value={row.income_type || 'Other'}
                            onChange={e => updateRow(row._id, { income_type: e.target.value })}
                            className="text-xs border border-rule rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-boom-400 min-w-28"
                          >
                            {INCOME_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {parseError && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-100 rounded-xl p-4 text-sm text-red-700">
              <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
              <span>{parseError}</span>
            </div>
          )}

          {/* Import button */}
          <div className="flex items-center gap-4">
            <button
              onClick={handleImport}
              disabled={importing || included.length === 0}
              className="px-6 py-2.5 text-sm font-semibold bg-boom-600 text-white rounded-xl hover:bg-boom-700 transition-colors disabled:opacity-40 flex items-center gap-2"
            >
              {importing
                ? <><Loader size={14} className="animate-spin" /> Importing…</>
                : <>Import {included.length} transactions</>
              }
            </button>
            <p className="text-xs text-gray-400">
              {rows.length - included.length > 0 && `${rows.length - included.length} rows excluded`}
            </p>
          </div>
        </div>
      )}

      {/* ─── Step 3: Done ─── */}
      {step === 3 && result && (
        <div className="flex flex-col items-center justify-center py-16 gap-6 text-center">
          <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center">
            <CheckCircle2 size={32} className="text-emerald-500" />
          </div>
          <div>
            <p className="text-xl font-bold text-gray-900">Import complete</p>
            <p className="text-sm text-gray-500 mt-1">
              {result.imported} transactions added to your Financials
            </p>
          </div>
          <div className="flex gap-4">
            <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-6 py-4 text-center">
              <p className="text-2xl font-bold text-emerald-600">{result.income}</p>
              <p className="text-xs text-emerald-600 font-medium mt-1">Income entries</p>
            </div>
            <div className="bg-red-50 border border-red-100 rounded-xl px-6 py-4 text-center">
              <p className="text-2xl font-bold text-red-500">{result.expenses}</p>
              <p className="text-xs text-red-500 font-medium mt-1">Expense entries</p>
            </div>
          </div>
          <div className="flex gap-3">
            <a
              href="/financials"
              className="px-5 py-2.5 text-sm font-semibold bg-gray-900 text-white rounded-xl hover:bg-gray-800 transition-colors"
            >
              View in Financials
            </a>
            <button
              onClick={reset}
              className="px-5 py-2.5 text-sm font-semibold border border-rule text-gray-700 rounded-xl hover:bg-gray-50 transition-colors flex items-center gap-2"
            >
              <RefreshCw size={14} />
              Import another file
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
