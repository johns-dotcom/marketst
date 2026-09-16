import { useState, useRef } from 'react'
import { Upload, FileSpreadsheet, AlertCircle, CheckCircle2, Loader, X } from 'lucide-react'
import api from '../api'
import PageHeader from '../components/PageHeader'
import { formatDate } from '../utils'

// Drop the Market Street master sheet .xlsx, see a dry-run preview of what would
// happen, then click Apply. Mirrors scripts/import-master-sheet.js, which
// shares the parse/diff/apply lib at server/lib/masterSheet.js.
export default function MasterSheetImport() {
  const [file, setFile] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [phase, setPhase] = useState('idle') // idle | parsing | preview | applying | done
  const [result, setResult] = useState(null) // { summary, preview, applied }
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  const reset = () => {
    setFile(null)
    setResult(null)
    setError('')
    setPhase('idle')
    if (inputRef.current) inputRef.current.value = ''
  }

  const pickFile = (f) => {
    setError('')
    if (!f) return
    if (!f.name.toLowerCase().endsWith('.xlsx')) {
      setError('Please upload an .xlsx file.')
      return
    }
    setFile(f)
    runDryRun(f)
  }

  const runDryRun = async (f) => {
    setPhase('parsing')
    setError('')
    try {
      const fd = new FormData()
      fd.append('file', f)
      const { data } = await api.post('/import/master-sheet', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      if (!data?.success) throw new Error(data?.error || 'Parse failed')
      setResult({ summary: data.summary, preview: data.preview, applied: false })
      setPhase('preview')
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Failed to parse sheet'
      setError(msg)
      setPhase('idle')
    }
  }

  const apply = async () => {
    if (!file) return
    if (!confirm(`Insert ${result.summary.willInsert} releases and create ${result.summary.newArtists} new artists? This cannot be undone.`)) return
    setPhase('applying')
    setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('apply', '1')
      const { data } = await api.post('/import/master-sheet?apply=1', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      if (!data?.success) throw new Error(data?.error || 'Apply failed')
      setResult({ summary: data.summary, preview: data.preview, applied: true })
      setPhase('done')
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Failed to apply import'
      setError(msg)
      setPhase('preview')
    }
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) pickFile(f)
  }

  return (
    <div className="max-w-5xl mx-auto px-4">
      <PageHeader
        title="Master Sheet Import"
        subtitle="Drop the Market Street master sheet (.xlsx) — releases and missing artists are inserted in one go. Existing rows are skipped."
      />

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <div className="flex-1">{error}</div>
          <button onClick={() => setError('')} className="text-red-700 hover:text-red-900">
            <X size={14} />
          </button>
        </div>
      )}

      {/* ── Drop zone (idle / parsing) ────────────────────────────────── */}
      {(phase === 'idle' || phase === 'parsing') && (
        <div
          onClick={() => inputRef.current?.click()}
          onDrop={onDrop}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed py-16 text-center cursor-pointer transition-colors ${
            dragOver ? 'border-boom-400 bg-boom-50' : 'border-rule bg-card hover:border-boom-300 hover:bg-gray-50'
          }`}
        >
          {phase === 'parsing' ? (
            <>
              <Loader className="animate-spin text-boom-500 mb-3" size={32} />
              <div className="text-base font-semibold text-gray-900">Parsing sheet…</div>
              <div className="text-sm text-gray-500 mt-1">Diffing against the database</div>
            </>
          ) : (
            <>
              <Upload className="text-gray-400 mb-3" size={36} />
              <div className="text-base font-semibold text-gray-900">Drop master sheet here</div>
              <div className="text-sm text-gray-500 mt-1">or click to choose · .xlsx only · max 10 MB</div>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => pickFile(e.target.files?.[0])}
          />
        </div>
      )}

      {/* ── Preview / done ────────────────────────────────────────────── */}
      {(phase === 'preview' || phase === 'applying' || phase === 'done') && result && (
        <Preview
          result={result}
          file={file}
          phase={phase}
          onApply={apply}
          onReset={reset}
        />
      )}
    </div>
  )
}

function Preview({ result, file, phase, onApply, onReset }) {
  const { summary, preview, applied } = result

  return (
    <div className="space-y-4">
      {/* File header */}
      <div className="flex items-center gap-3 rounded-xl border border-rule bg-card px-4 py-3">
        <FileSpreadsheet size={20} className="text-emerald-600 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-gray-900 truncate">{file?.name}</div>
          <div className="text-xs text-gray-500">
            {summary.totalRows} rows · {summary.existingReleases} existing releases · {summary.existingArtists} existing artists
          </div>
        </div>
        <button
          onClick={onReset}
          className="text-sm text-gray-500 hover:text-gray-900 px-2 py-1"
        >
          Choose different
        </button>
      </div>

      {/* Banner */}
      {applied ? (
        <div className="flex items-start gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <CheckCircle2 size={18} className="mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-semibold">
              Imported {summary.releasesInserted} releases · created {summary.artistsCreated} artists.
            </div>
            <div className="text-xs mt-1 opacity-80">
              {summary.orphanCount} existing release{summary.orphanCount === 1 ? '' : 's'} were not in the sheet and were left untouched.
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertCircle size={18} className="mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-semibold">Dry run — nothing has been written yet.</div>
            <div className="text-xs mt-1 opacity-80">Review the counts below, then hit Apply to insert.</div>
          </div>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Will insert" value={summary.willInsert} tone="emerald" />
        <Stat label="New artists" value={summary.newArtists} tone="blue" />
        <Stat label="Already in DB" value={summary.skippedDuplicate} tone="gray" />
        <Stat label="DB not in sheet" value={summary.orphanCount} tone="amber" />
      </div>

      {/* Skipped sub-counts */}
      {(summary.skippedNoArtistName > 0 || summary.skippedNoTitle > 0) && (
        <div className="text-xs text-gray-500">
          Also skipped: {summary.skippedNoArtistName} row{summary.skippedNoArtistName === 1 ? '' : 's'} with no artist,
          {' '}{summary.skippedNoTitle} with no title.
        </div>
      )}

      {/* Apply button */}
      {!applied && (
        <div className="flex justify-end">
          <button
            onClick={onApply}
            disabled={phase === 'applying' || summary.willInsert === 0}
            className="inline-flex items-center gap-2 px-4 py-2 bg-boom-600 hover:bg-boom-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors"
          >
            {phase === 'applying' ? (
              <><Loader size={14} className="animate-spin" /> Applying…</>
            ) : (
              <>Apply import — insert {summary.willInsert} releases</>
            )}
          </button>
        </div>
      )}

      {/* Previews */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ListCard
          title={`New artists to create (${summary.newArtists})`}
          empty="No new artists — all artists in the sheet already exist."
          truncatedBy={preview.newArtistsTruncated}
        >
          {preview.newArtists.map((name, i) => (
            <div key={i} className="text-sm text-gray-700 py-1 border-b border-divider last:border-b-0">{name}</div>
          ))}
        </ListCard>

        <ListCard
          title={`Sample of releases to insert (showing ${preview.sampleInserts.length} of ${summary.willInsert})`}
          empty="No new releases — everything in the sheet already exists in the DB."
          truncatedBy={preview.sampleInsertsTruncated}
        >
          {preview.sampleInserts.map((r, i) => (
            <div key={i} className="text-sm text-gray-700 py-1 border-b border-divider last:border-b-0">
              <span className="font-medium">{r.artist}</span>
              <span className="text-gray-500"> — {r.title}</span>
              {r.release_date && (
                <span className="text-xs text-gray-400 ml-2">{formatDate(r.release_date)}</span>
              )}
              {r.upc && (
                <span className="text-xs text-gray-400 ml-2">UPC {r.upc}</span>
              )}
            </div>
          ))}
        </ListCard>
      </div>

      <ListCard
        title={`Existing DB releases not in spreadsheet (${summary.orphanCount})`}
        empty="Every existing release is accounted for in the sheet."
        truncatedBy={preview.orphansTruncated}
      >
        {preview.orphans.map((o) => (
          <div key={o.id} className="text-sm text-gray-700 py-1 border-b border-divider last:border-b-0">
            <span className="text-xs text-gray-400 mr-2">#{o.id}</span>
            <span className="font-medium">{o.artist_name || '?'}</span>
            <span className="text-gray-500"> — {o.project_name}</span>
            {o.upc && <span className="text-xs text-gray-400 ml-2">UPC {o.upc}</span>}
          </div>
        ))}
      </ListCard>

      {applied && (
        <div className="flex justify-end">
          <button
            onClick={onReset}
            className="px-4 py-2 bg-card border border-rule text-gray-700 text-sm font-semibold rounded-lg hover:bg-gray-50 transition-colors"
          >
            Import another sheet
          </button>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, tone }) {
  const tones = {
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    blue:    'border-blue-200 bg-blue-50 text-blue-700',
    amber:   'border-amber-200 bg-amber-50 text-amber-700',
    gray:    'border-rule bg-card text-gray-700',
  }
  return (
    <div className={`rounded-xl border px-4 py-3 ${tones[tone] || tones.gray}`}>
      <div className="text-xs font-semibold uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  )
}

function ListCard({ title, children, empty, truncatedBy }) {
  const hasItems = Array.isArray(children) ? children.length > 0 : !!children
  return (
    <div className="rounded-xl border border-rule bg-card overflow-hidden">
      <div className="px-4 py-2.5 border-b border-divider bg-gray-50/40">
        <div className="text-xs font-bold uppercase tracking-wide text-gray-600">{title}</div>
      </div>
      <div className="p-3 max-h-72 overflow-y-auto">
        {hasItems ? children : <div className="text-sm text-gray-400 italic py-2">{empty}</div>}
        {truncatedBy > 0 && (
          <div className="text-xs text-gray-400 italic mt-2">…and {truncatedBy} more not shown</div>
        )}
      </div>
    </div>
  )
}
