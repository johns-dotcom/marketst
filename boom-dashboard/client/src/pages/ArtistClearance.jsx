import { useState, useEffect, useRef } from 'react'
import { Plus, Loader, Pencil, Trash2, Download, ChevronDown, ChevronRight, Music, X, FileSpreadsheet, Library, Search, Link2 } from 'lucide-react'
import api from '../api'
import Skeleton from '../components/Skeleton'

// Sub-field list mirrors the server-side template layout (rows 16-31 of
// the bookkeeper's Artist Clearance Chart). Keeping the order + keys in
// sync means the XLSX renders identically regardless of which side you
// edit. Defaults all show "TBD" on the rendered chart — matches the
// bookkeeper's "fill it in as info comes" convention.
const SUB_FIELDS = [
  { key: 'isrc',                 label: 'ISRC' },
  { key: 'timing',               label: 'Timing' },
  { key: 'explicit',             label: 'Clean or Explicit' },
  { key: 'samples_ai',           label: 'Samples / AI?' },
  { key: 'produced_by',          label: 'Produced by' },
  { key: 'musician_credits',     label: 'Musician Credits' },
  { key: 'recorded_by',          label: 'Recorded by' },
  { key: 'mixed_by',             label: 'Mixed by' },
  { key: 'mastered_by',          label: 'Mastered by' },
  { key: 'writers',              label: 'Writers (full names)' },
  { key: 'publishing_splits',    label: 'Publishing splits' },
  { key: 'publishers',           label: 'Publishers' },
  { key: 'lyrics',               label: 'Lyrics' },
  { key: 'stems_masters',        label: 'Stems / Masters?' },
  { key: 'artwork',              label: 'Artwork?' },
  { key: 'credits_approved',     label: 'Credits Approved?' },
]

const BLANK_TRACK = () => ({
  release_id: null,                 // FK back to releases when picked from catalog
  title: '', role: '', credit: '', docs_needed: '', sample_review: '',
  release_date: '', royalty_comments: '', royalty_rate: '', royalty_account: '',
  advance: '', recoupable_portion: '', agreement_on_file: '',
  ...Object.fromEntries(SUB_FIELDS.map(f => [f.key, ''])),
})

// Project a release row (from /api/clearances/catalog) onto a clearance
// track, preserving any manually-typed values that the release doesn't
// know about. Catalog only knows 5 of the ~17 fields the chart needs —
// the rest stay whatever the user already typed (or blank → TBD).
function applyReleaseToTrack(existing, release) {
  return {
    ...existing,
    release_id: release.id,
    title: release.project_name || existing.title || '',
    release_date: release.release_date ? String(release.release_date).slice(0, 10) : (existing.release_date || ''),
    isrc: release.isrc || existing.isrc || '',
    produced_by: release.producer || existing.produced_by || '',
    credit: release.featured_artists || existing.credit || '',
  }
}

// Whether this track is bound to a catalog release. Used to render the
// linked-icon affordance + hide the autocomplete suggestions once a
// release is locked in.
const isLinked = (track) => Boolean(track && track.release_id)

const BLANK_FORM = {
  artist_id: '',
  title: '',
  project_number: '',
  product_commitment: '',
  contractual_members: '',
  effective_date: '',
  main_artist_royalty_account: '',
  artist_royalty_rate: '',
  tracks: [BLANK_TRACK()],
}

export default function ArtistClearance() {
  const [artists, setArtists] = useState([])
  const [clearances, setClearances] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(BLANK_FORM)
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState('')
  // Per-track expansion state — keyed by track index. The 16 sub-fields
  // start collapsed so a 12-track EP doesn't feel overwhelming on load.
  const [expanded, setExpanded] = useState(new Set([0]))
  // Catalog of releases for the currently-selected artist. Fetched on
  // artist change so the track title input can autocomplete + the bulk
  // "Add from catalog" picker has something to show.
  const [catalog, setCatalog] = useState([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkPicks, setBulkPicks] = useState(new Set())
  const [bulkSearch, setBulkSearch] = useState('')

  useEffect(() => {
    Promise.all([
      api.get('/artists?limit=500').then(r => r.data?.data || []),
      api.get('/clearances').then(r => r.data?.data || []),
    ]).then(([a, c]) => {
      setArtists(a)
      setClearances(c)
    }).catch(e => setError(e?.response?.data?.error || e.message))
      .finally(() => setLoading(false))
  }, [])

  const refresh = () => api.get('/clearances').then(r => setClearances(r.data?.data || []))

  // Whenever the artist changes (manual pick or via startEdit), reload
  // that artist's catalog so the autocomplete + bulk picker have fresh
  // data. Clears catalog when the artist is unset.
  useEffect(() => {
    const aid = parseInt(form.artist_id, 10)
    if (!aid) { setCatalog([]); return }
    setCatalogLoading(true)
    api.get(`/clearances/catalog?artist_id=${aid}`)
      .then(r => setCatalog(r.data?.data || []))
      .catch(() => setCatalog([]))
      .finally(() => setCatalogLoading(false))
  }, [form.artist_id])

  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setTrackField = (idx, k, v) => setForm(f => ({
    ...f,
    tracks: f.tracks.map((t, i) => i === idx ? { ...t, [k]: v } : t),
  }))
  const addTrack = () => setForm(f => ({ ...f, tracks: [...f.tracks, BLANK_TRACK()] }))
  const removeTrack = (idx) => setForm(f => ({
    ...f,
    tracks: f.tracks.length === 1 ? f.tracks : f.tracks.filter((_, i) => i !== idx),
  }))
  // Bind / unbind a track to a catalog release. Bind fills the 5 fields
  // we can derive; unbind just clears the FK + title without touching
  // anything else (so manual edits the user made survive).
  const bindTrackToRelease = (idx, release) =>
    setForm(f => ({ ...f, tracks: f.tracks.map((t, i) => i === idx ? applyReleaseToTrack(t, release) : t) }))
  const unbindTrack = (idx) =>
    setForm(f => ({ ...f, tracks: f.tracks.map((t, i) => i === idx ? { ...t, release_id: null } : t) }))
  // Bulk-add multiple catalog picks as new tracks at the end of the list.
  const addPickedFromCatalog = () => {
    const picks = catalog.filter(r => bulkPicks.has(r.id))
    if (!picks.length) return
    setForm(f => {
      // If the only existing track is the default blank one, replace it
      // with the picks. Otherwise append.
      const baseTracks = (f.tracks.length === 1 && !f.tracks[0].title && !f.tracks[0].release_id)
        ? []
        : f.tracks
      const newTracks = picks.map(r => applyReleaseToTrack(BLANK_TRACK(), r))
      return { ...f, tracks: [...baseTracks, ...newTracks] }
    })
    setBulkPicks(new Set())
    setBulkSearch('')
    setBulkOpen(false)
  }
  const toggleBulkPick = (id) => setBulkPicks(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const toggleExpand = (idx) => setExpanded(prev => {
    const next = new Set(prev)
    next.has(idx) ? next.delete(idx) : next.add(idx)
    return next
  })

  const startEdit = (c) => {
    setEditing(c)
    setForm({
      artist_id: c.artist_id || '',
      title: c.title || '',
      project_number: c.project_number || '',
      product_commitment: c.product_commitment || '',
      contractual_members: c.contractual_members || '',
      effective_date: (c.effective_date || '').slice(0, 10),
      main_artist_royalty_account: c.main_artist_royalty_account || '',
      artist_royalty_rate: c.artist_royalty_rate || '',
      tracks: (c.tracks || []).length > 0 ? c.tracks : [BLANK_TRACK()],
    })
    setExpanded(new Set([0]))
    setError('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const cancelEdit = () => { setEditing(null); setForm(BLANK_FORM); setError('') }

  const handleSave = async (e) => {
    e.preventDefault()
    setError('')
    if (!form.artist_id) { setError('Pick an artist'); return }
    setSaving(true)
    try {
      const payload = { ...form, artist_id: parseInt(form.artist_id, 10) }
      if (editing) await api.put(`/clearances/${editing.id}`, payload)
      else await api.post('/clearances', payload)
      setEditing(null)
      setForm(BLANK_FORM)
      await refresh()
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this clearance + remove the file from the artist\'s Documents tab?')) return
    try {
      await api.delete(`/clearances/${id}`)
      await refresh()
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Delete failed')
    }
  }

  const handleDownload = async (c) => {
    try {
      const res = await api.get(`/clearances/${c.id}/download`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = c.file_filename || `Clearance-${c.artist_name || 'artist'}-${(c.title || 'untitled').replace(/[^a-z0-9-]/gi, '_')}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      alert(err?.response?.data?.error || 'Download failed')
    }
  }

  if (loading) return <div className="space-y-6"><Skeleton.Block h="h-24" /><Skeleton.Block h="h-64" /></div>

  const artistName = artists.find(a => a.id === parseInt(form.artist_id, 10))?.name || ''

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Form */}
        <div className="xl:col-span-2 bg-card rounded-lg border border-rule shadow-sm p-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg font-semibold text-gray-900">
              {editing ? `Edit clearance #${editing.id}` : 'New Artist Clearance Chart'}
            </h2>
            {editing && (
              <button type="button" onClick={cancelEdit}
                className="text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors">
                Cancel edit
              </button>
            )}
          </div>
          <p className="text-sm text-gray-500 mb-6">
            Saving generates an XLSX using the canonical clearance template and attaches it to
            the artist's <strong>Documents</strong> tab automatically.
          </p>

          <form onSubmit={handleSave} className="space-y-5">
            {/* Top — artist + identifiers */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Artist *</label>
                <select required value={form.artist_id} onChange={e => setField('artist_id', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none bg-white">
                  <option value="">— pick an artist —</option>
                  {artists.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Effective date</label>
                <input type="date" value={form.effective_date} onChange={e => setField('effective_date', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none" />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Project #</label>
                <input type="text" value={form.project_number} onChange={e => setField('project_number', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                <input type="text" value={form.title} onChange={e => setField('title', e.target.value)}
                  placeholder="EP / Album / Single name"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none" />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Product commitment</label>
                <input type="text" value={form.product_commitment} onChange={e => setField('product_commitment', e.target.value)}
                  placeholder="e.g. 1 EP, 2 singles"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Contractual members</label>
                <input type="text" value={form.contractual_members} onChange={e => setField('contractual_members', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none" />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Main artist royalty account</label>
                <input type="text" value={form.main_artist_royalty_account} onChange={e => setField('main_artist_royalty_account', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Artist royalty rate</label>
                <input type="text" value={form.artist_royalty_rate} onChange={e => setField('artist_royalty_rate', e.target.value)}
                  placeholder="e.g. 50%"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none" />
              </div>
            </div>

            {/* Tracks */}
            <div>
              <div className="flex items-center justify-between mb-2 gap-2">
                <label className="block text-sm font-semibold text-gray-700">
                  Tracks ({form.tracks.length})
                </label>
                <div className="flex items-center gap-1.5">
                  {form.artist_id && catalog.length > 0 && (
                    <button type="button" onClick={() => setBulkOpen(v => !v)}
                      title="Pick one or more releases from this artist's catalog to add as tracks"
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-emerald-700 hover:text-emerald-800 border border-emerald-200 hover:border-emerald-300 rounded-lg bg-emerald-50 hover:bg-emerald-100 transition-colors">
                      <Library size={12} /> From catalog ({catalog.length})
                    </button>
                  )}
                  <button type="button" onClick={addTrack}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-boom-700 hover:text-boom-800 border border-boom-200 hover:border-boom-300 rounded-lg bg-boom-50 hover:bg-boom-100 transition-colors">
                    <Plus size={12} /> Blank track
                  </button>
                </div>
              </div>

              {/* Bulk catalog picker — searchable, multi-select. Adding
                  N picks creates N new tracks pre-populated from the
                  catalog data the dashboard already has on file. */}
              {bulkOpen && (
                <div className="mb-3 border border-emerald-200 bg-emerald-50/40 rounded-lg overflow-hidden">
                  <div className="px-3 py-2 border-b border-emerald-200 bg-white flex items-center gap-2">
                    <Search size={13} className="text-gray-400" />
                    <input type="text" value={bulkSearch} onChange={e => setBulkSearch(e.target.value)}
                      placeholder="Filter catalog by track title…"
                      className="flex-1 text-sm bg-transparent focus:outline-none" />
                    {catalogLoading && <Loader size={12} className="animate-spin text-gray-400" />}
                    <button type="button" onClick={() => { setBulkOpen(false); setBulkPicks(new Set()); setBulkSearch('') }}
                      className="p-1 text-gray-400 hover:text-gray-700">
                      <X size={13} />
                    </button>
                  </div>
                  <div className="max-h-64 overflow-y-auto divide-y divide-emerald-100/60">
                    {catalog
                      .filter(r => !bulkSearch.trim() || (r.project_name || '').toLowerCase().includes(bulkSearch.trim().toLowerCase()))
                      .map(r => {
                        const picked = bulkPicks.has(r.id)
                        const alreadyLinked = form.tracks.some(t => t.release_id === r.id)
                        return (
                          <label key={r.id} className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer text-xs ${alreadyLinked ? 'opacity-50 cursor-not-allowed' : 'hover:bg-emerald-50'}`}>
                            <input type="checkbox" checked={picked} disabled={alreadyLinked}
                              onChange={() => !alreadyLinked && toggleBulkPick(r.id)}
                              className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500" />
                            <div className="flex-1 min-w-0">
                              <div className="font-semibold text-gray-800 truncate">{r.project_name}</div>
                              <div className="text-[10px] text-gray-500 flex items-center gap-2 flex-wrap">
                                {r.release_date && <span>{String(r.release_date).slice(0, 10)}</span>}
                                {r.isrc && <span className="font-mono">{r.isrc}</span>}
                                {r.producer && <span>prod. {r.producer}</span>}
                                {alreadyLinked && <span className="text-emerald-700 font-semibold">· already added</span>}
                              </div>
                            </div>
                          </label>
                        )
                      })}
                    {catalog.length === 0 && !catalogLoading && (
                      <div className="px-3 py-4 text-center text-xs text-gray-500">No releases in catalog for this artist.</div>
                    )}
                  </div>
                  <div className="px-3 py-2 border-t border-emerald-200 bg-white flex items-center justify-between">
                    <span className="text-[11px] text-gray-500">{bulkPicks.size} selected</span>
                    <button type="button" onClick={addPickedFromCatalog} disabled={bulkPicks.size === 0}
                      className="px-3 py-1 text-xs font-semibold rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                      Add {bulkPicks.size} track{bulkPicks.size === 1 ? '' : 's'}
                    </button>
                  </div>
                </div>
              )}
              <div className="space-y-3">
                {form.tracks.map((track, idx) => {
                  const isOpen = expanded.has(idx)
                  return (
                    <div key={idx} className="border border-rule rounded-lg overflow-hidden bg-card">
                      {/* Track header — number + title (autocomplete) + linked-badge + expand + remove */}
                      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b border-rule">
                        <button type="button" onClick={() => toggleExpand(idx)}
                          className="p-1 text-gray-400 hover:text-gray-700 transition-colors">
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                        <Music size={13} className="text-gray-400" />
                        <span className="text-xs font-bold text-gray-500 tabular-nums">#{idx + 1}</span>
                        <TrackTitleInput
                          track={track}
                          catalog={catalog}
                          excludeIds={new Set(form.tracks.filter((_, i) => i !== idx).map(t => t.release_id).filter(Boolean))}
                          onTitleChange={(v) => setTrackField(idx, 'title', v)}
                          onPickRelease={(r) => bindTrackToRelease(idx, r)}
                          onUnlink={() => unbindTrack(idx)}
                        />
                        {form.tracks.length > 1 && (
                          <button type="button" onClick={() => removeTrack(idx)}
                            title="Remove track"
                            className="p-1 text-gray-300 hover:text-red-600 transition-colors">
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                      {/* Track body — only render when expanded */}
                      {isOpen && (
                        <div className="p-3 space-y-3">
                          {/* Top-row track fields */}
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                            {[
                              ['role',                'Role'],
                              ['credit',              'Credit'],
                              ['docs_needed',         'Docs needed'],
                              ['sample_review',       'Sample review'],
                              ['release_date',        'Release date'],
                              ['royalty_comments',    'Royalty comments'],
                              ['royalty_rate',        'Royalty rate'],
                              ['royalty_account',     'Royalty account'],
                              ['advance',             'Advance'],
                              ['recoupable_portion',  'Recoupable portion'],
                              ['agreement_on_file',   'Agreement on file'],
                            ].map(([k, label]) => (
                              <div key={k}>
                                <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">{label}</label>
                                <input type="text" value={track[k] || ''} onChange={e => setTrackField(idx, k, e.target.value)}
                                  className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:ring-1 focus:ring-boom-500 focus:border-boom-500 outline-none bg-white" />
                              </div>
                            ))}
                          </div>
                          {/* Sub-fields — the 16 per-track details. Blank in
                              the form == "TBD" in the rendered chart, matching
                              the bookkeeper's convention. */}
                          <div className="pt-3 border-t border-divider">
                            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">
                              Track details (blank → TBD in the chart)
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                              {SUB_FIELDS.map(f => (
                                <div key={f.key}>
                                  <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">{f.label}</label>
                                  <input type="text" value={track[f.key] || ''} onChange={e => setTrackField(idx, f.key, e.target.value)}
                                    placeholder="TBD"
                                    className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:ring-1 focus:ring-boom-500 focus:border-boom-500 outline-none bg-white" />
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            {error && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
            )}

            <button type="submit" disabled={saving}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors">
              {saving ? <Loader className="animate-spin" size={16} /> : editing ? <Pencil size={16} /> : <Plus size={16} />}
              {editing ? 'Update clearance' : 'Save clearance'}
            </button>
            <p className="text-[11px] text-gray-400 text-center">
              The generated XLSX is uploaded to the artist's <strong>Documents</strong> tab. Updates replace the same file.
            </p>
          </form>
        </div>

        {/* Side panel — summary preview */}
        <div className="xl:col-span-1">
          <div className="bg-card rounded-lg border border-rule shadow-sm p-5 sticky top-4">
            <div className="flex items-center gap-2 mb-3">
              <FileSpreadsheet size={16} className="text-boom-600" />
              <h3 className="text-sm font-semibold text-gray-900">Chart preview</h3>
            </div>
            <div className="space-y-2.5 text-[12px]">
              <PreviewRow label="Artist" value={artistName || '—'} />
              <PreviewRow label="Title" value={form.title || '—'} />
              <PreviewRow label="Project #" value={form.project_number || '—'} />
              <PreviewRow label="Product commitment" value={form.product_commitment || '—'} />
              <PreviewRow label="Effective date" value={form.effective_date || '—'} />
              <PreviewRow label="Members" value={form.contractual_members || '—'} />
              <PreviewRow label="Royalty rate" value={form.artist_royalty_rate || '—'} />
            </div>
            <div className="mt-4 pt-3 border-t border-divider">
              <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">
                Tracks ({form.tracks.length})
              </div>
              <ol className="space-y-1 text-[12px]">
                {form.tracks.map((t, i) => (
                  <li key={i} className="flex items-baseline gap-2">
                    <span className="text-gray-400 tabular-nums">{i + 1}.</span>
                    <span className="text-gray-700 truncate">{t.title || <em className="text-gray-400">untitled</em>}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </div>

      {/* Saved list */}
      {clearances.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Saved clearances ({clearances.length})</h2>
          <div className="bg-card rounded-lg border border-rule shadow-sm overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-rule">
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Artist</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Title</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Tracks</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Updated</th>
                  <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {clearances.map(c => (
                  <tr key={c.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-sm font-semibold text-gray-900">{c.artist_name || '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{c.title || '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 tabular-nums">{(c.tracks || []).length}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {new Date(c.updated_at || c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => startEdit(c)} title="Edit"
                          className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors">
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => handleDownload(c)} title="Download XLSX"
                          className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors">
                          <Download size={14} />
                        </button>
                        <button onClick={() => handleDelete(c.id)} title="Delete"
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function PreviewRow({ label, value }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide w-28 flex-shrink-0">{label}</span>
      <span className="text-gray-800 truncate">{value}</span>
    </div>
  )
}

// Searchable title input. Typing into it filters the artist's catalog;
// picking a suggestion binds the track to that release (auto-fills the
// fields catalog knows). When already linked, shows a 🔗 chip + Unlink.
// excludeIds: release ids already used by sibling tracks — hidden from
// suggestions so each release only attaches once per clearance.
function TrackTitleInput({ track, catalog, excludeIds, onTitleChange, onPickRelease, onUnlink }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  // Close suggestions on outside-click so the dropdown doesn't linger
  // when the user moves on to another field.
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const linked = isLinked(track)
  const query = (track.title || '').toLowerCase().trim()
  const suggestions = (catalog || [])
    .filter(r => !excludeIds.has(r.id))
    .filter(r => !query || (r.project_name || '').toLowerCase().includes(query))
    .slice(0, 8)

  return (
    <div ref={wrapRef} className="relative flex-1 flex items-center gap-1.5">
      <input
        type="text"
        value={track.title}
        onChange={e => {
          // Editing the title de-links from a catalog release the moment
          // the value no longer matches — the user is explicitly typing
          // something custom, so we shouldn't keep claiming the row is
          // linked.
          if (linked && e.target.value !== track.title) onUnlink()
          onTitleChange(e.target.value)
          if (!open) setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        placeholder="Track title — type to search catalog…"
        className="flex-1 min-w-0 px-2 py-1 text-sm bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-boom-500 rounded"
      />
      {linked && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onUnlink() }}
          title="Linked to catalog release — click to unlink"
          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold rounded bg-emerald-100 text-emerald-700 border border-emerald-200 hover:bg-emerald-200">
          <Link2 size={10} /> Linked
        </button>
      )}
      {open && suggestions.length > 0 && (
        <div className="absolute left-0 right-10 top-full mt-1 z-20 bg-white border border-rule rounded-lg shadow-lg max-h-72 overflow-y-auto">
          {suggestions.map(r => {
            const exact = (r.project_name || '').toLowerCase() === query
            return (
              <button key={r.id} type="button"
                onMouseDown={(e) => { e.preventDefault(); onPickRelease(r); setOpen(false) }}
                className="w-full text-left px-3 py-2 hover:bg-emerald-50 border-b border-gray-100 last:border-b-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-gray-800 truncate">{r.project_name}</span>
                  {exact && <span className="text-[9px] font-bold text-emerald-700 bg-emerald-100 px-1 rounded">EXACT MATCH</span>}
                </div>
                <div className="text-[10px] text-gray-500 flex items-center gap-2 flex-wrap mt-0.5">
                  {r.release_date && <span>{String(r.release_date).slice(0, 10)}</span>}
                  {r.isrc && <span className="font-mono">{r.isrc}</span>}
                  {r.producer && <span>prod. {r.producer}</span>}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
