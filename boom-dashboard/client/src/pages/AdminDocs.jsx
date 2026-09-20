import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Plus, ArrowLeft, AlertTriangle, X, FileText, ShieldCheck, Lock, Upload } from 'lucide-react'
import api from '../api'
import { formatDate } from '../utils'
import PageHeader from '../components/PageHeader'
import FilesPanel from '../components/FilesPanel'
import Skeleton from '../components/Skeleton'
import { useAuth } from '../context/AuthContext'

const CATEGORIES = [
  'Legal', 'NDAs', 'Compliance', 'HR / People',
  'Financial', 'IP / Brand', 'Internal Policies', 'Templates',
]
const STATUSES = ['Active', 'Draft', 'Expired', 'Archived']
const CONFIDENTIALITY = ['Internal', 'Restricted']
const TABS = ['All', ...CATEGORIES]

const BLANK_DOC = {
  title: '', category: '', counterparty: '',
  status: 'Active', confidentiality: 'Internal',
  date_signed: '', expiration_date: '',
  tags: [], notes: '', is_template: false,
}

export default function AdminDocs() {
  const { user } = useAuth()
  const isSuperadmin = user?.role === 'Superadmin'

  const [docs, setDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState('All')
  const [statusFilter, setStatusFilter] = useState('')
  const [confFilter, setConfFilter] = useState('')

  const [selected, setSelected] = useState(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(BLANK_DOC)
  const [saving, setSaving] = useState(false)

  const [creating, setCreating] = useState(false)
  const [newDraft, setNewDraft] = useState(BLANK_DOC)
  const [creatingSaving, setCreatingSaving] = useState(false)

  const [expiring, setExpiring] = useState([])
  const [expiringOpen, setExpiringOpen] = useState(true)

  // Quick-upload: drop a file (or click the toolbar button) to create a
  // minimal admin_documents row + attach the file in one step. Title comes
  // from the filename (extension stripped); category stays blank so the
  // user can fill it in later.
  const quickInputRef = useRef(null)
  const [quickUploading, setQuickUploading] = useState({ done: 0, total: 0 })
  const [dragActive, setDragActive] = useState(false)

  useEffect(() => {
    fetchDocs()
    fetchExpiring()
  }, [])

  const fetchDocs = async () => {
    try {
      setLoading(true)
      const res = await api.get('/admin-docs')
      setDocs(res.data?.data || [])
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load admin documents')
    } finally { setLoading(false) }
  }
  const fetchExpiring = async () => {
    try {
      const res = await api.get('/admin-docs/expiring')
      setExpiring(res.data?.data || [])
    } catch { /* non-critical */ }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return docs.filter(d => {
      if (activeTab === 'Templates') { if (!d.is_template) return false }
      else if (activeTab !== 'All') { if (d.category !== activeTab) return false }
      if (statusFilter && d.status !== statusFilter) return false
      if (confFilter && d.confidentiality !== confFilter) return false
      if (q) {
        const blob = `${d.title} ${d.counterparty || ''} ${(d.tags || []).join(' ')}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [docs, search, activeTab, statusFilter, confFilter])

  const openDoc = (d) => {
    setSelected(d); setEditing(false); setDraft(BLANK_DOC)
  }
  const beginEdit = () => {
    if (!selected) return
    setDraft({
      title: selected.title || '', category: selected.category || '',
      counterparty: selected.counterparty || '',
      status: selected.status || 'Active',
      confidentiality: selected.confidentiality || 'Internal',
      date_signed: selected.date_signed ? String(selected.date_signed).slice(0, 10) : '',
      expiration_date: selected.expiration_date ? String(selected.expiration_date).slice(0, 10) : '',
      tags: Array.isArray(selected.tags) ? selected.tags : [],
      notes: selected.notes || '',
      is_template: !!selected.is_template,
    })
    setEditing(true)
  }
  const saveEdit = async () => {
    if (!selected) return
    setSaving(true)
    try {
      const res = await api.put(`/admin-docs/${selected.id}`, draft)
      const updated = res.data?.data
      if (updated) {
        setSelected(updated)
        setDocs(prev => prev.map(d => d.id === updated.id ? { ...d, ...updated } : d))
        fetchExpiring()
      }
      setEditing(false)
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed')
    } finally { setSaving(false) }
  }
  const deleteDoc = async () => {
    if (!selected) return
    if (!window.confirm(`Delete "${selected.title}"? This also removes any attached files.`)) return
    try {
      await api.delete(`/admin-docs/${selected.id}`)
      setDocs(prev => prev.filter(d => d.id !== selected.id))
      setSelected(null)
      fetchExpiring()
    } catch (err) {
      setError(err.response?.data?.error || 'Delete failed')
    }
  }

  // Strip the extension from a filename so the row title reads as a name,
  // not a path. "Lease_Agreement.pdf" → "Lease_Agreement".
  const stripExt = (name) => name.replace(/\.[^.]+$/, '') || name

  const quickUpload = async (fileList) => {
    const files = Array.from(fileList || []).filter(Boolean)
    if (!files.length) return
    setError('')
    setQuickUploading({ done: 0, total: files.length })
    const created = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      try {
        const docRes = await api.post('/admin-docs', { title: stripExt(file.name) })
        const newDoc = docRes.data?.data
        if (!newDoc?.id) throw new Error('Create failed')
        const fd = new FormData()
        fd.append('file', file)
        await api.post(`/admin-docs/${newDoc.id}/files`, fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
        created.push({ ...newDoc, file_count: 1 })
      } catch (err) {
        setError(err.response?.data?.error || `Upload failed for ${file.name}`)
      }
      setQuickUploading(s => ({ ...s, done: i + 1 }))
    }
    if (created.length) setDocs(prev => [...created, ...prev])
    setQuickUploading({ done: 0, total: 0 })
    if (quickInputRef.current) quickInputRef.current.value = ''
  }

  const onPageDrop = (e) => {
    e.preventDefault(); e.stopPropagation(); setDragActive(false)
    if (e.dataTransfer?.files?.length) quickUpload(e.dataTransfer.files)
  }
  const onPageDrag = (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault(); e.stopPropagation()
    setDragActive(e.type === 'dragenter' || e.type === 'dragover')
  }

  const submitNew = async () => {
    if (!newDraft.title || !newDraft.category) {
      setError('Title and category are required')
      return
    }
    setCreatingSaving(true)
    try {
      const res = await api.post('/admin-docs', newDraft)
      const created = res.data?.data
      if (created) {
        setDocs(prev => [created, ...prev])
        setSelected(created)
        setCreating(false)
        setNewDraft(BLANK_DOC)
        fetchExpiring()
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Create failed')
    } finally { setCreatingSaving(false) }
  }

  // ── Detail view ────────────────────────────────────────────────────────────
  if (selected) {
    return (
      <div className="max-w-4xl space-y-5">
        <button onClick={() => { setSelected(null); setEditing(false) }}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft size={14} /> Back to documents
        </button>

        <div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">{selected.title}</h1>
              <p className="text-sm text-gray-500 mt-1 flex items-center gap-2">
                <span>{selected.category}</span>
                {selected.confidentiality === 'Restricted' && (
                  <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-100 font-medium">
                    <Lock size={11} /> Restricted
                  </span>
                )}
                {selected.is_template && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-100 font-medium">
                    Template
                  </span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!editing ? (
                <>
                  <button onClick={beginEdit} className="text-sm font-medium text-boom-600 hover:text-boom-700">Edit</button>
                  <button onClick={deleteDoc} className="text-sm font-medium text-red-500 hover:text-red-600">Delete</button>
                </>
              ) : (
                <>
                  <button onClick={() => setEditing(false)} disabled={saving}
                    className="text-sm font-medium text-gray-500 hover:text-gray-700">Cancel</button>
                  <button onClick={saveEdit} disabled={saving}
                    className="text-sm px-3 py-1.5 bg-gray-900 text-white rounded-lg font-semibold hover:bg-gray-700 disabled:opacity-50">
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg text-sm">{error}</div>
        )}

        {/* Metadata card */}
        <div className="card p-5 space-y-4">
          {!editing ? (
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
              <Field label="Status" value={selected.status} />
              <Field label="Confidentiality" value={selected.confidentiality} />
              <Field label="Counterparty" value={selected.counterparty || '—'} />
              <Field label="Date Signed" value={formatDate(selected.date_signed) || '—'} />
              <Field label="Expires" value={formatDate(selected.expiration_date) || '—'} />
              <Field label="Created By" value={selected.created_by_name || '—'} />
              {Array.isArray(selected.tags) && selected.tags.length > 0 && (
                <div className="col-span-2">
                  <p className="text-xs font-medium text-gray-500 mb-1.5">Tags</p>
                  <div className="flex flex-wrap gap-1.5">
                    {selected.tags.map((t, i) => (
                      <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">{t}</span>
                    ))}
                  </div>
                </div>
              )}
              {selected.notes && (
                <div className="col-span-2">
                  <p className="text-xs font-medium text-gray-500 mb-1.5">Notes</p>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{selected.notes}</p>
                </div>
              )}
            </div>
          ) : (
            <DocForm draft={draft} setDraft={setDraft} isSuperadmin={isSuperadmin} />
          )}
        </div>

        {/* Attached files */}
        <div className="card overflow-hidden">
          <div className="px-5 pt-4 pb-1">
            <h2 className="text-sm font-semibold text-gray-900">Files</h2>
          </div>
          <FilesPanel entityType="admin_document" entityId={selected.id} basePath="/admin-docs" />
        </div>
      </div>
    )
  }

  // ── List view ──────────────────────────────────────────────────────────────
  const uploading = quickUploading.total > 0
  return (
    <div
      className="space-y-6 relative"
      onDragEnter={onPageDrag} onDragLeave={onPageDrag} onDragOver={onPageDrag} onDrop={onPageDrop}
    >
      <input
        ref={quickInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={e => { quickUpload(e.target.files) }}
      />

      {/* Drop overlay — shown while dragging any file over the page. */}
      {dragActive && (
        <div className="fixed inset-0 z-40 bg-boom-50/80 border-4 border-dashed border-boom-400 rounded-lg flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-boom-700">
            <Upload size={32} />
            <p className="text-lg font-semibold">Drop to upload</p>
            <p className="text-sm">Each file becomes a new document</p>
          </div>
        </div>
      )}

      <PageHeader tour="admin-docs-header"
        title="Admin Docs"
        subtitle="Legal, NDAs, compliance, HR, IP, internal policies & templates"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => quickInputRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-2 px-4 py-2 bg-card text-gray-700 text-sm font-semibold rounded-lg border border-rule hover:bg-gray-50 disabled:opacity-50 transition-colors"
              title="Upload a file as a new document (title from filename)"
            >
              <Upload size={15} />
              {uploading ? `Uploading ${quickUploading.done}/${quickUploading.total}…` : 'Upload File'}
            </button>
            <button onClick={() => { setCreating(true); setNewDraft(BLANK_DOC) }}
              className="inline-flex items-center gap-2 px-4 py-2 bg-gray-900 text-white text-sm font-semibold rounded-lg hover:bg-gray-700 transition-colors">
              <Plus size={15} /> New Document
            </button>
          </div>
        }
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg text-sm flex items-start justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => setError('')}><X size={14} /></button>
        </div>
      )}

      {/* Expiring banner */}
      {expiring.length > 0 && expiringOpen && (
        <div className="card border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start justify-between mb-2">
            <div className="flex items-center gap-2 text-amber-700 font-semibold">
              <AlertTriangle size={16} />
              {expiring.length} document{expiring.length !== 1 ? 's' : ''} expiring within 60 days
            </div>
            <button onClick={() => setExpiringOpen(false)} className="text-amber-500 hover:text-amber-700">
              <X size={14} />
            </button>
          </div>
          <div className="space-y-1">
            {expiring.slice(0, 5).map(d => (
              <button key={d.id}
                onClick={() => { const full = docs.find(x => x.id === d.id); if (full) openDoc(full) }}
                className="block w-full text-left text-sm text-amber-900 hover:underline">
                {d.title} — {d.category}{d.counterparty ? ` (${d.counterparty})` : ''} —
                <span className={`ml-1 font-semibold ${d.days_left <= 14 ? 'text-red-700' : ''}`}>
                  {d.days_left} day{d.days_left !== 1 ? 's' : ''}
                </span>
              </button>
            ))}
            {expiring.length > 5 && (
              <p className="text-xs text-amber-700">+{expiring.length - 5} more</p>
            )}
          </div>
        </div>
      )}

      {/* New doc form */}
      {creating && (
        <div className="card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">New Document</h2>
            <button onClick={() => setCreating(false)} className="text-gray-400 hover:text-gray-600">
              <X size={15} />
            </button>
          </div>
          <DocForm draft={newDraft} setDraft={setNewDraft} isSuperadmin={isSuperadmin} />
          <div className="flex items-center justify-end gap-2">
            <button onClick={() => setCreating(false)} disabled={creatingSaving}
              className="text-sm font-medium text-gray-500 hover:text-gray-700">Cancel</button>
            <button onClick={submitNew} disabled={creatingSaving}
              className="text-sm px-4 py-2 bg-gray-900 text-white rounded-lg font-semibold hover:bg-gray-700 disabled:opacity-50">
              {creatingSaving ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text" placeholder="Search title, counterparty, tag…"
            value={search} onChange={e => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
          />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400">
          <option value="">All Statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={confFilter} onChange={e => setConfFilter(e.target.value)}
          className="px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400">
          <option value="">All Levels</option>
          {CONFIDENTIALITY.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Category tabs */}
      <div className="border-b border-rule -mb-3 overflow-x-auto">
        <div className="flex gap-4 min-w-max">
          {TABS.map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`pb-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-boom-500 text-boom-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}>
              {tab}
              {tab !== 'All' && (
                <span className="ml-1.5 text-xs text-gray-400">
                  {tab === 'Templates'
                    ? docs.filter(d => d.is_template).length
                    : docs.filter(d => d.category === tab).length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div data-tour="admin-docs-list" className="card overflow-hidden">
        {loading ? (
          <div className="p-5 space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton.Block key={i} h="h-10" />)}</div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center">
            <FileText size={28} className="mx-auto text-gray-300 mb-2" />
            <p className="text-sm text-gray-500">No documents match your filters.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-rule">
              <tr className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                <th className="text-left px-4 py-2.5">Title</th>
                <th className="text-left px-4 py-2.5">Category</th>
                <th className="text-left px-4 py-2.5">Counterparty</th>
                <th className="text-left px-4 py-2.5">Date Signed</th>
                <th className="text-left px-4 py-2.5">Expires</th>
                <th className="text-left px-4 py-2.5">Status</th>
                <th className="text-left px-4 py-2.5">Confidentiality</th>
                <th className="text-left px-4 py-2.5">Files</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map(d => (
                <tr key={d.id} onClick={() => openDoc(d)}
                  className="hover:bg-surface-50 cursor-pointer transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900 flex items-center gap-2">
                    {d.confidentiality === 'Restricted' && <Lock size={12} className="text-red-500" />}
                    {d.is_template && <ShieldCheck size={12} className="text-purple-500" />}
                    {d.title}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{d.category || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{d.counterparty || '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(d.date_signed) || '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(d.expiration_date) || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      d.status === 'Active' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' :
                      d.status === 'Expired' ? 'bg-red-50 text-red-700 border border-red-100' :
                      d.status === 'Archived' ? 'bg-gray-100 text-gray-500' :
                      'bg-amber-50 text-amber-700 border border-amber-100'
                    }`}>{d.status}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{d.confidentiality}</td>
                  <td className="px-4 py-3 text-gray-500">{d.file_count || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Field({ label, value }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 mb-1.5">{label}</p>
      <p className="text-sm font-semibold text-gray-900">{value}</p>
    </div>
  )
}

function DocForm({ draft, setDraft, isSuperadmin }) {
  const [tagDraft, setTagDraft] = useState('')
  const addTag = () => {
    const t = tagDraft.trim()
    if (!t) return
    setDraft(d => ({ ...d, tags: [...(d.tags || []), t] }))
    setTagDraft('')
  }
  const removeTag = (i) => setDraft(d => ({ ...d, tags: d.tags.filter((_, idx) => idx !== i) }))

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="col-span-2">
        <label className="block text-xs font-medium text-gray-500 mb-1.5">Title *</label>
        <input className="input-base text-sm w-full"
          value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1.5">Category *</label>
        <select className="input-base text-sm w-full"
          value={draft.category} onChange={e => setDraft(d => ({ ...d, category: e.target.value }))}>
          <option value="">— Select —</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1.5">Counterparty</label>
        <input className="input-base text-sm w-full"
          value={draft.counterparty} onChange={e => setDraft(d => ({ ...d, counterparty: e.target.value }))} />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1.5">Status</label>
        <select className="input-base text-sm w-full"
          value={draft.status} onChange={e => setDraft(d => ({ ...d, status: e.target.value }))}>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1.5">
          Confidentiality
          {!isSuperadmin && <span className="text-xs text-gray-400 ml-1">(Superadmin sets Restricted)</span>}
        </label>
        <select className="input-base text-sm w-full"
          value={draft.confidentiality}
          onChange={e => setDraft(d => ({ ...d, confidentiality: e.target.value }))}>
          {CONFIDENTIALITY.filter(c => isSuperadmin || c !== 'Restricted').map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1.5">Date Signed</label>
        <input type="date" className="input-base text-sm w-full"
          value={draft.date_signed} onChange={e => setDraft(d => ({ ...d, date_signed: e.target.value }))} />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1.5">Expiration Date</label>
        <input type="date" className="input-base text-sm w-full"
          value={draft.expiration_date} onChange={e => setDraft(d => ({ ...d, expiration_date: e.target.value }))} />
      </div>
      <div className="col-span-2">
        <label className="block text-xs font-medium text-gray-500 mb-1.5">Tags</label>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {(draft.tags || []).map((t, i) => (
            <span key={i} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">
              {t}
              <button onClick={() => removeTag(i)} className="text-gray-400 hover:text-red-500"><X size={10} /></button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input className="input-base text-sm flex-1"
            placeholder="Add a tag and press Enter"
            value={tagDraft} onChange={e => setTagDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }} />
          <button type="button" onClick={addTag}
            className="px-3 py-1.5 text-xs font-semibold border border-rule rounded-lg hover:bg-gray-50">Add</button>
        </div>
      </div>
      <div className="col-span-2">
        <label className="block text-xs font-medium text-gray-500 mb-1.5">Notes</label>
        <textarea rows="3" className="input-base text-sm w-full"
          value={draft.notes} onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))} />
      </div>
      <label className="col-span-2 inline-flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
        <input type="checkbox" checked={!!draft.is_template}
          onChange={e => setDraft(d => ({ ...d, is_template: e.target.checked }))}
          className="rounded border-gray-300 text-boom-600 focus:ring-boom-500" />
        Treat as a reusable template (shows in the Templates tab)
      </label>
    </div>
  )
}
