import { useState, useEffect, useMemo, useRef } from 'react'
import { Upload, Loader, AlertCircle, CheckCircle, X, ExternalLink } from 'lucide-react'
import api from '../api'
import PageHeader from '../components/PageHeader'
import { formatDate } from '../utils'

/**
 * Bulk Re-upload Invoices.
 *
 * Lists entries whose stored invoice_data blob is suspiciously small
 * (truncated at some point in the past — typically stuck at 10,000 base64
 * chars / 7.5 KB decoded). Admin drags in the original PDFs, the page
 * auto-matches each one to an entry by filename or embedded invoice-number
 * token (INV####), and fires sequential re-uploads through the existing
 * per-entry file endpoint. Each successful upload flips the entry from the
 * legacy truncated blob to a clean R2 object.
 *
 * Route: /bk/bulk-reupload   (Admin / Approver)
 */

const STATUS_STYLE = {
  ready:     'bg-gray-100 text-gray-600',
  uploading: 'bg-blue-100 text-blue-700',
  done:      'bg-emerald-100 text-emerald-700',
  error:     'bg-red-100 text-red-700',
  unmatched: 'bg-amber-100 text-amber-700',
}

function bytesLabel(n) {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export default function BkBulkReupload() {
  const [broken, setBroken] = useState([])
  const [loading, setLoading] = useState(true)
  const [files, setFiles] = useState([]) // { file, matchedEntryId, status, error }
  const [dragActive, setDragActive] = useState(false)
  const [uploadingAll, setUploadingAll] = useState(false)
  const inputRef = useRef(null)

  const fetchBroken = async () => {
    setLoading(true)
    try {
      const r = await api.get('/bk/admin/corrupt-invoices')
      setBroken(r.data.data || [])
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchBroken() }, [])

  // Fast lookups for auto-matching dropped files to entries.
  const byFilename = useMemo(() => {
    const m = new Map()
    for (const e of broken) {
      if (e.invoice_filename) m.set(e.invoice_filename.toLowerCase(), e.id)
    }
    return m
  }, [broken])

  const byInvToken = useMemo(() => {
    // Build INV-token → entryId map. Prefer the invoice_number if it looks
    // like INV####, else fall back to any INV-token inside the filename.
    const m = new Map()
    for (const e of broken) {
      const tokens = new Set()
      const invFromNumber = (e.invoice_number || '').match(/[A-Z]+\d+/gi) || []
      const invFromFile   = (e.invoice_filename || '').match(/[A-Z]+\d+/gi) || []
      ;[...invFromNumber, ...invFromFile].forEach(t => tokens.add(t.toUpperCase()))
      for (const t of tokens) {
        if (!m.has(t)) m.set(t, e.id)
      }
    }
    return m
  }, [broken])

  const matchFile = (file) => {
    const lower = file.name.toLowerCase()
    if (byFilename.has(lower)) return byFilename.get(lower)
    // Try invoice-number token (INV0538, #003, etc.)
    const tokens = (file.name.match(/[A-Z]+\d+/gi) || []).map(t => t.toUpperCase())
    for (const t of tokens) {
      if (byInvToken.has(t)) return byInvToken.get(t)
    }
    return null
  }

  const ingestFiles = (list) => {
    const accepted = Array.from(list).filter(f => /\.(pdf|png|jpe?g)$/i.test(f.name))
    if (!accepted.length) return
    const next = accepted.map(file => ({
      file,
      matchedEntryId: matchFile(file),
      status: matchFile(file) ? 'ready' : 'unmatched',
      error: null,
    }))
    setFiles(prev => [...prev, ...next])
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragActive(false)
    ingestFiles(e.dataTransfer.files)
  }

  const removeFile = (idx) => {
    setFiles(prev => prev.filter((_, i) => i !== idx))
  }

  const pickEntry = (idx, entryId) => {
    setFiles(prev => prev.map((f, i) => i === idx ? { ...f, matchedEntryId: entryId ? Number(entryId) : null, status: entryId ? 'ready' : 'unmatched', error: null } : f))
  }

  const uploadOne = async (idx) => {
    const f = files[idx]
    if (!f?.matchedEntryId) return
    setFiles(prev => prev.map((x, i) => i === idx ? { ...x, status: 'uploading', error: null } : x))
    try {
      const fd = new FormData()
      fd.append('file', f.file)
      await api.post(`/bk/entries/${f.matchedEntryId}/file/invoice`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setFiles(prev => prev.map((x, i) => i === idx ? { ...x, status: 'done' } : x))
    } catch (err) {
      setFiles(prev => prev.map((x, i) => i === idx ? { ...x, status: 'error', error: err.response?.data?.error || err.message } : x))
    }
  }

  const uploadAll = async () => {
    setUploadingAll(true)
    try {
      for (let i = 0; i < files.length; i++) {
        if (files[i].status === 'ready') await uploadOne(i)
      }
    } finally {
      setUploadingAll(false)
      fetchBroken()
    }
  }

  const readyCount = files.filter(f => f.status === 'ready').length
  const doneCount = files.filter(f => f.status === 'done').length
  const errorCount = files.filter(f => f.status === 'error').length
  const unmatchedCount = files.filter(f => f.status === 'unmatched').length

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bulk Re-upload Invoices"
        subtitle="Drop original PDFs to replace truncated or corrupted invoice files"
      />

      {/* Broken list */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Truncated / Suspiciously Small Invoices</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              invoice_data ≤ ~8 KB AND not yet migrated to R2. Drop matching PDFs below to fix.
            </p>
          </div>
          <button
            onClick={fetchBroken}
            disabled={loading}
            className="text-xs font-semibold text-gray-500 hover:text-gray-800 disabled:opacity-50"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {loading ? (
          <p className="text-sm text-gray-400 py-6 text-center">Loading…</p>
        ) : broken.length === 0 ? (
          <p className="text-sm text-emerald-600 py-6 text-center font-medium">No corrupted invoices detected.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 border-b border-rule">
                  <th className="py-2 pr-3">Payee</th>
                  <th className="py-2 pr-3">Invoice #</th>
                  <th className="py-2 pr-3">Filename</th>
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3 text-right">Stored</th>
                  <th className="py-2 pr-3">ID</th>
                </tr>
              </thead>
              <tbody>
                {broken.map(e => (
                  <tr key={e.id} className="border-b border-rule/50 hover:bg-gray-50">
                    <td className="py-2 pr-3 font-medium text-gray-900">{e.payee || '—'}</td>
                    <td className="py-2 pr-3 text-gray-700">{e.invoice_number || '—'}</td>
                    <td className="py-2 pr-3 text-gray-500 font-mono text-xs">{e.invoice_filename || '—'}</td>
                    <td className="py-2 pr-3 text-xs text-gray-500">{formatDate(e.invoice_date)}</td>
                    <td className="py-2 pr-3 text-right text-xs text-red-600 font-semibold">{bytesLabel(e.base64_length)}</td>
                    <td className="py-2 pr-3 text-xs text-gray-400">#{e.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Drop zone */}
      {broken.length > 0 && (
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Drop Replacement PDFs</h2>
          <div
            onDragOver={e => { e.preventDefault(); setDragActive(true) }}
            onDragLeave={() => setDragActive(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            className={`border-2 border-dashed rounded-lg px-6 py-10 text-center cursor-pointer transition-all ${
              dragActive ? 'border-boom-600 bg-boom-50' : 'border-gray-300 hover:border-gray-400'
            }`}
          >
            <Upload size={28} className={`mx-auto mb-2 ${dragActive ? 'text-boom-600' : 'text-gray-400'}`} />
            <p className="text-sm font-medium text-gray-700">Drop PDFs here, or click to pick</p>
            <p className="text-xs text-gray-500 mt-1">Auto-matched to entries by filename or INV-token</p>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".pdf,.png,.jpg,.jpeg"
              className="hidden"
              onChange={e => { ingestFiles(e.target.files); e.target.value = '' }}
            />
          </div>

          {/* File list + matches */}
          {files.length > 0 && (
            <div className="mt-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-gray-500">{files.length} file{files.length === 1 ? '' : 's'} staged</span>
                  {unmatchedCount > 0 && <span className="text-amber-700 font-semibold">{unmatchedCount} unmatched</span>}
                  {doneCount > 0 && <span className="text-emerald-700 font-semibold">{doneCount} uploaded</span>}
                  {errorCount > 0 && <span className="text-red-700 font-semibold">{errorCount} failed</span>}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setFiles([])}
                    disabled={uploadingAll}
                    className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-40 px-2"
                  >
                    Clear
                  </button>
                  <button
                    onClick={uploadAll}
                    disabled={uploadingAll || readyCount === 0}
                    className="btn-primary text-xs px-4 py-1.5 disabled:opacity-40"
                  >
                    {uploadingAll ? 'Uploading…' : `Upload ${readyCount} matched`}
                  </button>
                </div>
              </div>

              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 border-b border-rule">
                    <th className="py-2 pr-3">File</th>
                    <th className="py-2 pr-3">Matched Entry</th>
                    <th className="py-2 pr-3 text-right">Size</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((f, idx) => {
                    const matched = broken.find(e => e.id === f.matchedEntryId)
                    const isDone = f.status === 'done'
                    return (
                      <tr key={idx} className="border-b border-rule/50">
                        <td className="py-2 pr-3 font-mono text-xs text-gray-700 truncate max-w-[280px]">{f.file.name}</td>
                        <td className="py-2 pr-3">
                          {isDone ? (
                            <span className="text-xs text-gray-500">
                              {matched ? `${matched.payee} · ${matched.invoice_number || matched.invoice_filename}` : `#${f.matchedEntryId}`}
                            </span>
                          ) : (
                            <select
                              value={f.matchedEntryId || ''}
                              onChange={e => pickEntry(idx, e.target.value)}
                              disabled={f.status === 'uploading' || uploadingAll}
                              className="text-xs border border-rule rounded px-2 py-1 max-w-[320px]"
                            >
                              <option value="">— pick an entry —</option>
                              {broken.map(e => (
                                <option key={e.id} value={e.id}>
                                  {e.payee} · {e.invoice_number || e.invoice_filename} (#{e.id})
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right text-xs text-gray-500">{bytesLabel(f.file.size)}</td>
                        <td className="py-2 pr-3">
                          <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${STATUS_STYLE[f.status]}`}>
                            {f.status === 'uploading' && <Loader size={10} className="animate-spin" />}
                            {f.status === 'done' && <CheckCircle size={10} />}
                            {f.status === 'error' && <AlertCircle size={10} />}
                            {f.status}
                          </span>
                          {f.error && <p className="text-[10px] text-red-600 mt-1 truncate max-w-[200px]" title={f.error}>{f.error}</p>}
                        </td>
                        <td className="py-2 pr-3">
                          {!isDone && (
                            <button
                              onClick={() => removeFile(idx)}
                              disabled={f.status === 'uploading' || uploadingAll}
                              className="text-gray-400 hover:text-red-600 disabled:opacity-40"
                              title="Remove"
                            >
                              <X size={14} />
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
