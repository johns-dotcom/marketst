// Brand — the label's logos and photos in one place. Anyone signed in can add
// a file and download any of them; removing one is for the person who added
// it or an admin. Files download through /uploads (auth via getFileUrl), which
// serves SVG and unknown types as attachments — so a logo never renders as a
// document on our origin; only raster images preview inline.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Image as ImageIcon, Download, Trash2, Upload, FileText, FileArchive, PenTool } from 'lucide-react'
import api from '../api'
import { getFileUrl } from '../utils'
import { useAuth } from '../context/AuthContext'
import PageHeader from '../components/PageHeader'
import EmptyState from '../components/EmptyState'

const CATS = [['all', 'All'], ['logo', 'Logos'], ['photo', 'Photos'], ['other', 'Other']]
const fmtBytes = (n) => (!n ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`)
const isRaster = (m) => /^image\/(png|jpeg|gif|webp)$/.test(m || '')
const kindIcon = (m, name) => (/svg|postscript|illustrator/.test(m || '') || /\.(svg|ai|eps)$/i.test(name || '') ? PenTool : /zip/.test(m || '') ? FileArchive : /pdf/.test(m || '') ? FileText : ImageIcon)
const kindLabel = (m, name) => { const ext = (name || '').split('.').pop().toUpperCase(); return ext.length <= 4 ? ext : (m || '').split('/').pop().toUpperCase() }

export default function Brand() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'Admin' || user?.role === 'Superadmin'
  const [files, setFiles] = useState(null)
  const [cat, setCat] = useState('all')
  const [uploadCat, setUploadCat] = useState('logo')
  const [busy, setBusy] = useState(0)
  const [note, setNote] = useState('')
  const [drag, setDrag] = useState(false)
  const inputRef = useRef(null)
  const load = () => api.get('/brand').then((r) => setFiles(r.data?.data || [])).catch(() => setFiles([]))
  useEffect(() => { load() }, [])

  const upload = async (list) => {
    const arr = Array.from(list || []); if (!arr.length) return
    setBusy(arr.length); setNote('')
    let failed = []
    for (const f of arr) {
      const fd = new FormData(); fd.append('file', f); fd.append('category', uploadCat)
      try { await api.post('/brand', fd, { headers: { 'Content-Type': 'multipart/form-data' } }) }
      catch (e) { failed.push(`${f.name}: ${e?.response?.data?.error || 'upload failed'}`) }
      setBusy((b) => b - 1)
    }
    await load()
    setNote(failed.length ? failed.join(' · ') : `Added ${arr.length - failed.length} file${arr.length - failed.length === 1 ? '' : 's'}.`)
    setTimeout(() => setNote(''), 6000)
  }
  const remove = async (f) => {
    if (!window.confirm(`Remove ${f.original_name}? Anyone who downloaded it keeps their copy.`)) return
    try { await api.delete(`/brand/${f.id}`); setFiles((prev) => prev.filter((x) => x.id !== f.id)) }
    catch (e) { setNote(e?.response?.data?.error || 'Could not remove'); setTimeout(() => setNote(''), 4000) }
  }
  const shown = useMemo(() => (files || []).filter((f) => cat === 'all' || (f.category || 'other') === cat), [files, cat])
  const counts = useMemo(() => (files || []).reduce((m, f) => { const c = f.category || 'other'; m[c] = (m[c] || 0) + 1; m.all = (m.all || 0) + 1; return m }, {}), [files])

  return (
    <div className="space-y-5" data-brand>
      <PageHeader title="Brand" subtitle="The label's logos and photos. Add what the team should be able to grab; download what you need." />

      {/* Upload */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files) }}
        className={`card p-5 border-2 border-dashed transition-colors ${drag ? 'border-boom-500 bg-boom-50/40' : 'border-rule'}`} data-brand-drop>
        <div className="flex items-center gap-4 flex-wrap">
          <Upload size={18} className="text-gray-400" />
          <div className="flex-1 min-w-[200px]">
            <p className="text-sm font-semibold text-gray-900">Drop files here, or choose them</p>
            <p className="text-xs text-gray-500">PNG, JPG, GIF, WebP, SVG, PDF, AI, EPS or ZIP · up to 25 MB each. Vector files download rather than preview.</p>
          </div>
          <label className="text-xs text-gray-500 inline-flex items-center gap-2">Add as
            <select value={uploadCat} onChange={(e) => setUploadCat(e.target.value)} className="select-base text-xs" data-upload-category>
              <option value="logo">Logo</option><option value="photo">Photo</option><option value="other">Other</option>
            </select>
          </label>
          <button type="button" onClick={() => inputRef.current?.click()} disabled={busy > 0} className="btn-primary text-sm px-4 py-2" data-choose-files>{busy > 0 ? `Uploading ${busy}…` : 'Choose files'}</button>
          <input ref={inputRef} type="file" multiple className="hidden" accept=".png,.jpg,.jpeg,.gif,.webp,.svg,.pdf,.ai,.eps,.zip,.tif,.tiff" onChange={(e) => { upload(e.target.files); e.target.value = '' }} data-file-input />
        </div>
        {note && <p className="text-xs text-gray-600 mt-3" data-brand-note>{note}</p>}
      </div>

      {/* Filter */}
      <div className="flex items-center gap-1.5 flex-wrap" data-brand-filter>
        {CATS.map(([k, label]) => (
          <button key={k} type="button" onClick={() => setCat(k)} aria-pressed={cat === k} data-cat={k}
            className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${cat === k ? 'bg-gray-900 text-white border-gray-900' : 'bg-card text-gray-600 border-rule hover:border-gray-400'}`}>
            {label}{counts[k] ? <span className={`ml-1.5 tabular-nums ${cat === k ? 'text-gray-300' : 'text-gray-400'}`}>{counts[k]}</span> : null}
          </button>
        ))}
      </div>

      {files === null ? <p className="text-sm text-gray-400 py-8 text-center">Loading…</p>
        : files.length === 0 ? (
          <EmptyState icon={ImageIcon} title="No brand files yet"
            body="Logos, press photos and artwork the team should be able to grab live here. The first upload starts the library."
            action={{ label: 'Choose files', onClick: () => inputRef.current?.click() }} />
        ) : shown.length === 0 ? (
          <p className="text-sm text-gray-400 py-8 text-center">Nothing filed as {CATS.find(([k]) => k === cat)?.[1].toLowerCase()} yet.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4" data-brand-grid>
            {shown.map((f) => {
              const Icon = kindIcon(f.mime_type, f.original_name)
              const url = getFileUrl(f.filename)
              const canRemove = isAdmin || Number(f.uploaded_by) === Number(user?.id)
              return (
                <div key={f.id} className="card overflow-hidden group flex flex-col" data-brand-file={f.id} data-category={f.category || 'other'}>
                  <a href={url} target="_blank" rel="noreferrer" className="block aspect-square bg-gray-50 flex items-center justify-center overflow-hidden" title={`Download ${f.original_name}`}>
                    {isRaster(f.mime_type)
                      ? <img src={url} alt={f.original_name} className="w-full h-full object-contain p-3" loading="lazy" />
                      : <div className="flex flex-col items-center gap-1.5 text-gray-400"><Icon size={26} strokeWidth={1.5} /><span className="text-[10px] font-bold tracking-wider">{kindLabel(f.mime_type, f.original_name)}</span></div>}
                  </a>
                  <div className="px-3 py-2.5 flex-1 flex flex-col gap-1">
                    <p className="text-xs font-semibold text-gray-900 truncate" title={f.original_name}>{f.original_name}</p>
                    <p className="text-[10px] text-gray-400 truncate">{fmtBytes(f.file_size)}{f.uploaded_by_name ? ` · ${f.uploaded_by_name.split(' ')[0]}` : ''}{f.uploaded_at ? ` · ${new Date(f.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}</p>
                    <div className="flex items-center gap-1 mt-auto pt-1">
                      <a href={url} download={f.original_name} className="inline-flex items-center gap-1 text-[11px] font-semibold text-boom-700 hover:underline" data-download><Download size={11} /> Download</a>
                      {canRemove && <button type="button" onClick={() => remove(f)} className="ml-auto p-1 text-gray-300 hover:text-rose-600 opacity-0 group-hover:opacity-100 transition-opacity" title="Remove" data-remove><Trash2 size={12} /></button>}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
    </div>
  )
}
