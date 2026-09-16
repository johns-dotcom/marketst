import { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, ChevronRight, ChevronDown, ArrowLeft, Music, Disc3, Activity, FileText, Briefcase, X, Link2, Plus, Trash2, ExternalLink, Loader, Pencil, Paperclip, ArrowUpDown, RefreshCw, Download, Users, Tag, Check, Archive } from 'lucide-react'
import api from '../api'
import { formatDate } from '../utils'
import FilesPanel from '../components/FilesPanel'
import PageHeader from '../components/PageHeader'
import { useAuth } from '../context/AuthContext'

const GENRE_COLORS = {
  'Hip-Hop':        'bg-violet-100 text-violet-700',
  'Hip Hop':        'bg-violet-100 text-violet-700',
  'R&B':            'bg-pink-100 text-pink-700',
  'Dance/R&B':      'bg-fuchsia-100 text-fuchsia-700',
  'Pop':            'bg-sky-100 text-sky-700',
  'Indie Pop':      'bg-cyan-100 text-cyan-700',
  'Dance Pop':      'bg-blue-100 text-blue-700',
  'EDM':            'bg-blue-100 text-blue-700',
  'Electronic':     'bg-indigo-100 text-indigo-700',
  'Dance':          'bg-teal-100 text-teal-700',
  'Phonk':          'bg-orange-100 text-orange-700',
  'Trap':           'bg-red-100 text-red-700',
  'Drill':          'bg-red-100 text-red-700',
  'Rock':           'bg-amber-100 text-amber-700',
  'Pop Rock':       'bg-yellow-100 text-yellow-700',
  'Alternative Pop':'bg-lime-100 text-lime-700',
  'Alternative':    'bg-lime-100 text-lime-700',
  'Hyperpop':       'bg-rose-100 text-rose-700',
  'Ambient':        'bg-emerald-100 text-emerald-700',
  'Soul':           'bg-orange-100 text-orange-700',
  'Gospel':         'bg-yellow-100 text-yellow-700',
  'Country':        'bg-amber-100 text-amber-700',
  'Latin':          'bg-green-100 text-green-700',
  'Reggaeton':      'bg-green-100 text-green-700',
  'Afrobeats':      'bg-green-100 text-green-700',
}

function genreColor(genre) {
  if (!genre) return 'bg-gray-100 text-gray-500'
  // exact match first
  if (GENRE_COLORS[genre]) return GENRE_COLORS[genre]
  // partial match
  const key = Object.keys(GENRE_COLORS).find(k => genre.toLowerCase().includes(k.toLowerCase()))
  return key ? GENRE_COLORS[key] : 'bg-gray-100 text-gray-500'
}

const PLATFORMS = [
  'Spotify','Apple Music','YouTube','SoundCloud','Tidal',
  'Instagram','TikTok','Twitter/X','Facebook',
  'Website','Linktree','DistroKid','TuneCore','Other',
]

const PLATFORM_COLORS = {
  'Spotify':      'bg-green-100 text-green-700',
  'Apple Music':  'bg-pink-100 text-pink-700',
  'YouTube':      'bg-red-100 text-red-700',
  'SoundCloud':   'bg-orange-100 text-orange-700',
  'Tidal':        'bg-blue-100 text-blue-700',
  'Instagram':    'bg-purple-100 text-purple-700',
  'TikTok':       'bg-gray-100 text-gray-700',
  'Twitter/X':    'bg-sky-100 text-sky-700',
  'Facebook':     'bg-blue-100 text-blue-700',
  'Website':      'bg-indigo-100 text-indigo-700',
  'Linktree':     'bg-lime-100 text-lime-700',
  'DistroKid':    'bg-violet-100 text-violet-700',
  'TuneCore':     'bg-amber-100 text-amber-700',
  'Other':        'bg-gray-100 text-gray-500',
}

function LinksTab({ artistId, links, onRefresh }) {
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ platform: 'Spotify', url: '', label: '' })
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState({})

  const saveLink = async () => {
    if (!form.url.trim()) return
    setSaving(true)
    try {
      await api.post(`/artists/${artistId}/links`, form)
      setForm({ platform: 'Spotify', url: '', label: '' })
      setShowForm(false)
      onRefresh()
    } catch { } finally { setSaving(false) }
  }

  const deleteLink = async (linkId) => {
    setDeletingId(linkId)
    try {
      await api.delete(`/artists/${artistId}/links/${linkId}`)
      onRefresh()
    } catch { } finally { setDeletingId(null) }
  }

  const saveEdit = async (linkId) => {
    setSaving(true)
    try {
      await api.put(`/artists/${artistId}/links/${linkId}`, editForm)
      setEditingId(null)
      onRefresh()
    } catch { } finally { setSaving(false) }
  }

  return (
    <div className="p-5 space-y-3">
      {links.length === 0 && !showForm && (
        <p className="text-sm text-gray-400 text-center py-6">No links added yet.</p>
      )}

      {links.map(link => {
        const badgeCls = PLATFORM_COLORS[link.platform] || PLATFORM_COLORS['Other']
        const isEditing = editingId === link.id
        const isDeleting = deletingId === link.id

        return (
          <div key={link.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:border-gray-200 group transition-all">
            {isEditing ? (
              <div className="flex-1 flex items-center gap-2 flex-wrap">
                <select
                  value={editForm.platform}
                  onChange={e => setEditForm(f => ({ ...f, platform: e.target.value }))}
                  className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-boom-500 bg-white"
                >
                  {PLATFORMS.map(p => <option key={p}>{p}</option>)}
                </select>
                <input
                  type="url"
                  value={editForm.url}
                  onChange={e => setEditForm(f => ({ ...f, url: e.target.value }))}
                  className="flex-1 min-w-0 text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-boom-500"
                  placeholder="URL"
                />
                <input
                  type="text"
                  value={editForm.label}
                  onChange={e => setEditForm(f => ({ ...f, label: e.target.value }))}
                  className="text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-boom-500 w-32"
                  placeholder="Label (optional)"
                />
                <button onClick={() => saveEdit(link.id)} disabled={saving} className="text-xs font-semibold text-boom-600 hover:text-boom-700 px-3 py-1.5 rounded-lg border border-boom-200 hover:bg-boom-50 transition-colors">
                  {saving ? <Loader size={12} className="animate-spin" /> : 'Save'}
                </button>
                <button onClick={() => setEditingId(null)} className="text-xs text-gray-400 hover:text-gray-600 p-1"><X size={13} /></button>
              </div>
            ) : (
              <>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0 ${badgeCls}`}>
                  {link.platform}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-gray-700 truncate">{link.label || link.url}</p>
                  {link.label && <p className="text-[10px] text-gray-400 truncate">{link.url}</p>}
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <a href={link.url} target="_blank" rel="noopener noreferrer" className="p-1.5 text-gray-400 hover:text-boom-600 rounded-lg hover:bg-boom-50 transition-colors">
                    <ExternalLink size={13} />
                  </a>
                  <button onClick={() => { setEditingId(link.id); setEditForm({ platform: link.platform, url: link.url, label: link.label || '' }) }} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors">
                    <Pencil size={13} />
                  </button>
                  <button onClick={() => deleteLink(link.id)} disabled={isDeleting} className="p-1.5 text-gray-400 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors">
                    {isDeleting ? <Loader size={13} className="animate-spin" /> : <Trash2 size={13} />}
                  </button>
                </div>
              </>
            )}
          </div>
        )
      })}

      {showForm ? (
        <div className="border border-gray-200 rounded-xl p-4 space-y-3 bg-gray-50">
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={form.platform}
              onChange={e => setForm(f => ({ ...f, platform: e.target.value }))}
              className="text-sm border border-gray-200 rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-boom-500 bg-white"
            >
              {PLATFORMS.map(p => <option key={p}>{p}</option>)}
            </select>
            <input
              autoFocus
              type="url"
              value={form.url}
              onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') saveLink(); if (e.key === 'Escape') setShowForm(false) }}
              placeholder="https://..."
              className="flex-1 min-w-0 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-boom-500 bg-white"
            />
            <input
              type="text"
              value={form.label}
              onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
              placeholder="Label (optional)"
              className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-boom-500 bg-white w-40"
            />
          </div>
          <div className="flex items-center gap-2 justify-end">
            <button onClick={() => setShowForm(false)} className="text-xs text-gray-400 hover:text-gray-600 p-1.5"><X size={14} /></button>
            <button
              onClick={saveLink}
              disabled={saving || !form.url.trim()}
              className="text-xs font-semibold bg-gray-900 text-white px-4 py-1.5 rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-40 flex items-center gap-1.5"
            >
              {saving ? <><Loader size={12} className="animate-spin" /> Saving…</> : 'Add Link'}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="w-full flex items-center justify-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-gray-600 border border-dashed border-gray-200 hover:border-gray-300 rounded-xl py-2.5 transition-all"
        >
          <Plus size={13} /> Add Link
        </button>
      )}
    </div>
  )
}

function artistInitials(name = '') {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
}

export default function Artists() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const isSuperadmin = user?.role?.toLowerCase() === 'superadmin'
  const [artists, setArtists] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedArtist, setSelectedArtist] = useState(null)
  const [artistReleases, setArtistReleases] = useState([])
  const [artistContracts, setArtistContracts] = useState([])
  const [artistDeals, setArtistDeals] = useState([])
  const [artistLinks, setArtistLinks] = useState([])
  const [artistFiles, setArtistFiles] = useState([])
  const [artistFileCount, setArtistFileCount] = useState(0)
  const [artistTab, setArtistTab] = useState('releases')
  const [genreFilter, setGenreFilter] = useState('All')
  const [releaseFilter, setReleaseFilter] = useState('All')
  // Active-only: hides any artist who hasn't released in the past 365
  // days AND has no upcoming release. Server marks each row with
  // has_recent_release via an EXISTS subquery against releases where
  // release_date >= today − 365 days (which naturally captures both
  // recent past + any future-dated release).
  const [activeOnly, setActiveOnly] = useState(false)
  const [sortBy, setSortBy] = useState('name-asc')
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [exportOpen, setExportOpen] = useState(false)
  const [exportGenres, setExportGenres] = useState([])
  // 0 = all time, otherwise N days back. Strictly past — matches "past N
  // months" phrasing the operator types into requests.
  const [exportWindow, setExportWindow] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [genreOpen, setGenreOpen] = useState(false)
  const [genreSearch, setGenreSearch] = useState('')
  const exportRef = useRef(null)
  const genreRef = useRef(null)
  const debounceRef = useRef(null)

  const limit = 1000

  const handleSearch = (e) => {
    const value = e.target.value
    setSearchTerm(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value)
      setPage(1)
    }, 300)
  }

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [])

  useEffect(() => {
    fetchArtists()
  }, [page, debouncedSearch])

  const fetchArtists = async () => {
    try {
      setLoading(true)
      const params = { page, limit }
      if (debouncedSearch) params.search = debouncedSearch
      const response = await api.get('/artists', { params })
      setArtists(response.data.data || [])
      setTotalPages(Math.ceil(response.data.total / limit) || 1)
    } catch (err) {
      setError('Failed to load artists')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const deleteArtist = async (id, name) => {
    if (!window.confirm(`Delete ${name}? Artists with releases can't be deleted — delete or reassign their releases first.`)) return
    try {
      await api.delete(`/artists/${id}`)
      setSelectedArtist(null)
      fetchArtists()
    } catch (err) {
      alert('Failed to delete: ' + (err.response?.data?.error || err.message))
    }
  }

  // Archive / restore — soft action; the artist row stays in place but
  // moves out of the active roster grid into the bottom Archived section.
  // Used when a deal ends — keeps historical releases / contracts /
  // expense references intact while clearing the artist out of the
  // working roster view.
  const toggleArchive = async (id, archived) => {
    // Optimistic local update so the card moves immediately.
    setArtists(prev => prev.map(a => a.id === id ? { ...a, archived } : a))
    // Auto-expand the Archived section on archive so the user actually
    // SEES where the card went — otherwise the card just vanishes from
    // the active grid and the section header below stays collapsed,
    // looking like nothing happened.
    if (archived) setShowArchived(true)
    try {
      await api.patch(`/artists/${id}/archive`, { archived })
    } catch (err) {
      const msg = err?.response?.data?.error || err.message
      console.error('Failed to archive artist:', msg)
      // Surface the failure to the user instead of silently bouncing
      // the card back. The most common reason a PATCH 500s here is the
      // artists.archived column missing on the DB — telling the operator
      // gives them something to act on instead of "it's not working".
      alert(`Couldn't ${archived ? 'archive' : 'restore'} this artist:\n\n${msg}`)
      // Rollback by refetching.
      fetchArtists()
    }
  }
  // Default expanded so archived cards are immediately visible after a
  // user clicks Archive. When the bucket is empty the section doesn't
  // render at all (gated below), so leaving this true is safe.
  const [showArchived, setShowArchived] = useState(true)

  // Close the export popover on outside click
  useEffect(() => {
    if (!exportOpen) return
    const handler = (e) => {
      if (exportRef.current && !exportRef.current.contains(e.target)) setExportOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [exportOpen])

  // Close the genre popover on outside click
  useEffect(() => {
    if (!genreOpen) return
    const handler = (e) => {
      if (genreRef.current && !genreRef.current.contains(e.target)) {
        setGenreOpen(false)
        setGenreSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [genreOpen])

  const toggleExportGenre = (g) => {
    setExportGenres(prev => prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g])
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const qsParts = []
      if (exportGenres.length) qsParts.push(`genres=${exportGenres.map(encodeURIComponent).join(',')}`)
      if (exportWindow > 0)    qsParts.push(`since_days=${exportWindow}`)
      const qs = qsParts.length ? `?${qsParts.join('&')}` : ''
      const res = await api.get(`/artists/export${qs}`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      const label = exportGenres.length
        ? exportGenres.map(g => g.replace(/[^a-zA-Z0-9_-]/g, '_')).join('-').slice(0, 40)
        : 'all'
      const windowLabel = exportWindow > 0 ? `-last${exportWindow}d` : ''
      a.download = `roster-${label}${windowLabel}-${new Date().toISOString().slice(0,10)}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
      setExportOpen(false)
    } catch (err) {
      console.error('Roster export failed:', err)
      alert('Export failed')
    } finally {
      setExporting(false)
    }
  }

  const handleSyncImages = async () => {
    setSyncing(true)
    setSyncMsg('')
    try {
      const response = await api.post('/artists/sync-images')
      const { updated, total } = response.data.data
      setSyncMsg(`Updated ${updated}/${total}`)
      await fetchArtists()
      setTimeout(() => setSyncMsg(''), 5000)
    } catch (err) {
      setSyncMsg(err.response?.data?.error || 'Sync failed')
      setTimeout(() => setSyncMsg(''), 6000)
    } finally {
      setSyncing(false)
    }
  }

  const handleViewArtist = (artistId) => {
    navigate(`/artists/${artistId}`)
  }

  const refreshArtistLinks = async () => {
    if (!selectedArtist) return
    try {
      const response = await api.get(`/artists/${selectedArtist.id}`)
      setArtistLinks(response.data.data.links || [])
    } catch (err) {
      console.error('Failed to refresh links:', err)
    }
  }

  const genres = useMemo(() => {
    const set = new Set(artists.map(a => a.genre).filter(Boolean))
    return ['All', ...Array.from(set).sort()]
  }, [artists])

  const genreCounts = useMemo(() => {
    const counts = { All: artists.length }
    for (const a of artists) {
      if (!a.genre) continue
      counts[a.genre] = (counts[a.genre] || 0) + 1
    }
    return counts
  }, [artists])

  const rosterStats = useMemo(() => {
    const total = artists.length
    const totalReleases = artists.reduce((sum, a) => sum + (a.total_releases || 0), 0)
    // Active = same definition as the "Active only" filter — has at least
    // one non-archived release within the past 365 days OR scheduled for
    // any future date. Server stamps `has_recent_release` per row.
    const active = artists.filter(a => a.has_recent_release === true).length
    const genreCount = new Set(artists.map(a => a.genre).filter(Boolean)).size
    return { total, totalReleases, active, genreCount }
  }, [artists])

  // Active roster only — archived artists are kept on file but rendered
  // in a separate Archived section below the main grid.
  const filtered = useMemo(() => {
    let result = artists.filter(a => !a.archived)

    if (genreFilter !== 'All') {
      result = result.filter(a => a.genre === genreFilter)
    }

    if (releaseFilter === 'Has Releases') {
      result = result.filter(a => (a.total_releases || 0) > 0)
    } else if (releaseFilter === 'No Releases') {
      result = result.filter(a => (a.total_releases || 0) === 0)
    }

    if (activeOnly) {
      result = result.filter(a => a.has_recent_release === true)
    }

    return [...result].sort((a, b) => {
      if (sortBy === 'name-asc') return a.name.localeCompare(b.name)
      if (sortBy === 'name-desc') return b.name.localeCompare(a.name)
      if (sortBy === 'releases-desc') return (b.total_releases || 0) - (a.total_releases || 0)
      if (sortBy === 'releases-asc') return (a.total_releases || 0) - (b.total_releases || 0)
      return 0
    })
  }, [artists, genreFilter, releaseFilter, activeOnly, sortBy])

  // Archived bucket — separate list, doesn't honor genre / release filters
  // since those mainly govern the active workflow view. Sorted by name.
  const archived = useMemo(() => {
    return artists
      .filter(a => a.archived)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }, [artists])

  const getCompletionPct = (r) => {
    const keys = ['yt_video','content','marketing_plan','official_thread','uploaded','recoup_added','budget','stem_pitch','s4a_pitch','amazon_pitch','pandora','marquee','dsp_email','musixmatch']
    const done = keys.filter(k => r[k]).length
    return Math.round((done / keys.length) * 100)
  }

  const getStatusBadge = (status) => {
    if (status === 'Active') return 'badge badge-green'
    if (status === 'Expired') return 'badge badge-red'
    if (status === 'Terminated') return 'badge badge-red'
    return 'badge badge-yellow'
  }

  const getStageDot = (stage) => {
    const map = {
      Scouting: 'bg-gray-400',
      Meeting: 'bg-blue-500',
      Offer: 'bg-amber-500',
      Negotiation: 'bg-violet-500',
      Signed: 'bg-emerald-500',
      Passed: 'bg-gray-300',
    }
    return map[stage] || 'bg-gray-400'
  }

  if (selectedArtist) {
    const ARTIST_TABS = [
      { id: 'releases',  label: 'Releases',  count: artistReleases.length },
      { id: 'contracts', label: 'Contracts', count: artistContracts.length },
      { id: 'deals',     label: 'Deals',     count: artistDeals.length },
      { id: 'links',     label: 'Links',     count: artistLinks.length },
      { id: 'files',     label: 'Files',     count: artistFileCount },
    ]

    return (
      <div className="space-y-6">
        <button
          onClick={() => setSelectedArtist(null)}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
        >
          <ArrowLeft size={16} />
          Back to Artists
        </button>

        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-full flex-shrink-0 overflow-hidden bg-gray-100">
            {selectedArtist.image_url ? (
              <img src={selectedArtist.image_url} alt={selectedArtist.name} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-lg font-bold text-gray-400">
                {artistInitials(selectedArtist.name)}
              </div>
            )}
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-semibold text-gray-900">{selectedArtist.name}</h1>
            <p className="text-sm text-gray-500 mt-1">{selectedArtist.genre} · {selectedArtist.total_releases} releases</p>
          </div>
          {isSuperadmin && (
            <button
              onClick={() => deleteArtist(selectedArtist.id, selectedArtist.name)}
              className="p-2 text-gray-300 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              title="Delete artist"
            >
              <Trash2 size={18} />
            </button>
          )}
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="card px-5 py-4 flex items-center gap-4">
            <div className="w-10 h-10 bg-violet-50 rounded-lg flex items-center justify-center">
              <Music size={20} className="text-violet-600" strokeWidth={1.5} />
            </div>
            <div>
              <p className="text-sm text-gray-500 font-medium">Genre</p>
              <p className="text-base font-semibold text-gray-900">{selectedArtist.genre || '—'}</p>
            </div>
          </div>
          <div className="card px-5 py-4 flex items-center gap-4">
            <div className="w-10 h-10 bg-boom-50 rounded-lg flex items-center justify-center">
              <Disc3 size={20} className="text-boom-600" strokeWidth={1.5} />
            </div>
            <div>
              <p className="text-sm text-gray-500 font-medium">Releases</p>
              <p className="text-base font-semibold text-gray-900">{artistReleases.length}</p>
            </div>
          </div>
          <div className="card px-5 py-4 flex items-center gap-4">
            <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center">
              <FileText size={20} className="text-blue-600" strokeWidth={1.5} />
            </div>
            <div>
              <p className="text-sm text-gray-500 font-medium">Contracts</p>
              <p className="text-base font-semibold text-gray-900">{artistContracts.length}</p>
            </div>
          </div>
          <div className="card px-5 py-4 flex items-center gap-4">
            <div className="w-10 h-10 bg-emerald-50 rounded-lg flex items-center justify-center">
              <Briefcase size={20} className="text-emerald-600" strokeWidth={1.5} />
            </div>
            <div>
              <p className="text-sm text-gray-500 font-medium">Deals</p>
              <p className="text-base font-semibold text-gray-900">{artistDeals.length}</p>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="card overflow-hidden">
          <div className="flex border-b border-gray-100 px-5">
            {ARTIST_TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setArtistTab(t.id)}
                className={`flex items-center gap-2 py-3.5 mr-6 text-sm font-semibold border-b-2 transition-all ${
                  artistTab === t.id ? 'border-red-500 text-red-500' : 'border-transparent text-gray-400 hover:text-gray-600'
                }`}
              >
                {t.label}
                <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold tabular-nums ${
                  artistTab === t.id ? 'bg-red-50 text-red-500' : 'bg-gray-100 text-gray-400'
                }`}>{t.count}</span>
              </button>
            ))}
          </div>

          {/* Releases tab */}
          {artistTab === 'releases' && (
            <div className="divide-y divide-gray-100">
              {artistReleases.length === 0 ? (
                <p className="p-5 text-sm text-gray-400 text-center">No releases</p>
              ) : (
                artistReleases.map((release) => {
                  const pct = getCompletionPct(release)
                  const today = new Date()
                  const rd = new Date(release.release_date)
                  const isUpcoming = rd >= today
                  return (
                    <div key={release.id} onClick={() => navigate(`/releases/${release.id}`)} className="px-5 py-3.5 hover:bg-surface-50 transition-colors flex items-center justify-between gap-4 cursor-pointer">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{release.project_name}</p>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <p className="text-xs text-gray-500">{formatDate(release.release_date)}</p>
                          {release.release_type && <span className="text-xs text-gray-400">{release.release_type}</span>}
                          {release.assigned_to_name && (
                            <span className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded-full">{release.assigned_to_name}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <div className="flex items-center gap-1.5">
                          <div className="w-16 bg-gray-100 rounded-full h-1.5">
                            <div className={`h-1.5 rounded-full ${pct === 100 ? 'bg-emerald-500' : 'bg-boom-500'}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-xs text-gray-400 tabular-nums w-7">{pct}%</span>
                        </div>
                        <span className={isUpcoming ? 'badge badge-yellow' : 'badge badge-green'}>
                          {isUpcoming ? 'Upcoming' : 'Released'}
                        </span>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          )}

          {/* Contracts tab */}
          {artistTab === 'contracts' && (
            <div className="divide-y divide-gray-100">
              {artistContracts.length === 0 ? (
                <p className="p-5 text-sm text-gray-400 text-center">No contracts on file</p>
              ) : (
                artistContracts.map((c) => (
                  <div key={c.id} className="px-5 py-3.5 hover:bg-surface-50 transition-colors flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">{c.type}</p>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-500">
                        {c.date_signed && <span>Signed {formatDate(c.date_signed)}</span>}
                        {c.expiration_date && <><span>·</span><span>Expires {formatDate(c.expiration_date)}</span></>}
                        {c.royalty_split && <><span>·</span><span>{c.royalty_split}% royalty</span></>}
                      </div>
                    </div>
                    <span className={getStatusBadge(c.status)}>{c.status}</span>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Links tab */}
          {artistTab === 'links' && (
            <LinksTab
              artistId={selectedArtist.id}
              links={artistLinks}
              onRefresh={refreshArtistLinks}
            />
          )}

          {/* Files tab */}
          {artistTab === 'files' && (
            <FilesPanel
              entityType="artist"
              entityId={selectedArtist.id}
              basePath="/artists"
              initialFiles={artistFiles}
              onCountChange={(count) => setArtistFileCount(count)}
            />
          )}

          {/* Deals tab */}
          {artistTab === 'deals' && (
            <div className="divide-y divide-gray-100">
              {artistDeals.length === 0 ? (
                <p className="p-5 text-sm text-gray-400 text-center">No deal history</p>
              ) : (
                artistDeals.map((d) => (
                  <div key={d.id} className="px-5 py-3.5 hover:bg-surface-50 transition-colors flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                          d.stage === 'Signed' ? 'bg-emerald-500' :
                          d.stage === 'Passed' ? 'bg-gray-300' :
                          d.stage === 'Negotiation' ? 'bg-violet-500' :
                          d.stage === 'Offer' ? 'bg-amber-500' :
                          d.stage === 'Meeting' ? 'bg-blue-500' : 'bg-gray-400'
                        }`} />
                        <p className="text-sm font-medium text-gray-900">{d.stage}</p>
                        {d.ar_rep && <span className="text-xs text-gray-400">· {d.ar_rep}</span>}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-500">
                        {d.genre && <span>{d.genre}</span>}
                        {d.source && <><span>·</span><span>Source: {d.source}</span></>}
                        {d.added_date && <><span>·</span><span>{formatDate(d.added_date)}</span></>}
                      </div>
                      {d.notes && <p className="text-xs text-gray-400 mt-1 truncate">{d.notes}</p>}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (loading && artists.length === 0 && !searchTerm) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-boom-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Loading artists...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <PageHeader
        title="Roster"
        subtitle={loading ? '—' : `${filtered.length} artist${filtered.length !== 1 ? 's' : ''}${genreFilter !== 'All' ? ` · ${genreFilter}` : ''}${releaseFilter !== 'All' ? ` · ${releaseFilter}` : ''}${activeOnly ? ' · Active only' : ''}`}
        actions={<>
          <div className="relative" ref={exportRef}>
            <button
              onClick={() => setExportOpen(v => !v)}
              title="Export roster to Excel (alphabetical by name)"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-gray-600 hover:text-boom-700 border border-gray-200 hover:border-boom-300 rounded-lg hover:bg-boom-50 transition-colors"
            >
              <Download size={13} />
              Export
            </button>
            {exportOpen && (
              <div className="absolute right-0 mt-2 w-72 bg-white border border-gray-200 rounded-xl shadow-lg z-50 p-3">
                <div className="text-xs font-semibold text-gray-700 mb-2">Export Roster</div>

                {/* Release window — strictly past N days. "All time" means no
                    release filter at all (every artist on the roster). The
                    last_release_date column the server adds always shows up
                    in the export so the bookkeeper sees WHY each row qualified. */}
                <div className="mb-3">
                  <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Release window</div>
                  <div className="grid grid-cols-3 gap-1">
                    {[
                      { days: 0,    label: 'All time' },
                      { days: 30,   label: '1 mo'     },
                      { days: 90,   label: '3 mo'     },
                      { days: 180,  label: '6 mo'     },
                      { days: 365,  label: '12 mo'    },
                      { days: 730,  label: '24 mo'    },
                    ].map(opt => (
                      <button
                        key={opt.days}
                        type="button"
                        onClick={() => setExportWindow(opt.days)}
                        className={`px-2 py-1 text-[11px] font-semibold rounded-md border transition-colors ${
                          exportWindow === opt.days
                            ? 'bg-boom-50 border-boom-300 text-boom-700'
                            : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Genres</div>
                <div className="flex items-center justify-between mb-2">
                  <button
                    onClick={() => setExportGenres([])}
                    className="text-[11px] text-gray-500 hover:text-gray-700"
                  >All genres</button>
                  <button
                    onClick={() => setExportGenres(genres.filter(g => g !== 'All'))}
                    className="text-[11px] text-gray-500 hover:text-gray-700"
                  >Select all</button>
                </div>
                <div className="max-h-56 overflow-y-auto space-y-1 border-t border-gray-100 pt-2">
                  {genres.filter(g => g !== 'All').map(g => (
                    <label key={g} className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer hover:bg-gray-50 rounded px-1.5 py-1">
                      <input
                        type="checkbox"
                        checked={exportGenres.includes(g)}
                        onChange={() => toggleExportGenre(g)}
                        className="rounded border-gray-300 text-boom-600 focus:ring-boom-500"
                      />
                      <span className="flex-1">{g}</span>
                    </label>
                  ))}
                </div>
                <button
                  onClick={handleExport}
                  disabled={exporting}
                  className="mt-3 w-full px-3 py-1.5 text-xs font-semibold bg-boom-600 text-white rounded-lg hover:bg-boom-700 disabled:opacity-50 transition-colors"
                >
                  {(() => {
                    if (exporting) return 'Exporting…'
                    const parts = []
                    parts.push(exportGenres.length ? `${exportGenres.length} genre${exportGenres.length !== 1 ? 's' : ''}` : 'full roster')
                    if (exportWindow > 0) {
                      const label = exportWindow === 30 ? 'past 1 mo'
                        : exportWindow === 90  ? 'past 3 mo'
                        : exportWindow === 180 ? 'past 6 mo'
                        : exportWindow === 365 ? 'past 12 mo'
                        : exportWindow === 730 ? 'past 24 mo'
                        : `past ${exportWindow}d`
                      parts.push(label)
                    }
                    return `Download ${parts.join(' · ')}`
                  })()}
                </button>
              </div>
            )}
          </div>
          <button
            onClick={handleSyncImages}
            disabled={syncing}
            title="Sync profile images from Spotify"
            className="p-1.5 text-gray-300 hover:text-green-500 rounded-lg hover:bg-green-50 transition-colors disabled:opacity-40"
          >
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          </button>
          {syncMsg && <span className="text-xs text-gray-400">{syncMsg}</span>}
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
            <input
              type="text"
              placeholder="Search artists…"
              value={searchTerm}
              onChange={handleSearch}
              className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-boom-500 placeholder:text-gray-300 bg-white"
            />
            {loading && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <div className="w-3.5 h-3.5 border-2 border-boom-500 border-t-transparent rounded-full animate-spin" />
              </div>
            )}
          </div>
        </>}
      />

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card px-5 py-4 flex items-center gap-4">
          <div className="w-10 h-10 bg-boom-50 rounded-lg flex items-center justify-center">
            <Users size={20} className="text-boom-600" strokeWidth={1.5} />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-gray-500 font-medium">Total Artists</p>
            <p className="text-lg font-semibold text-gray-900 tabular-nums">{rosterStats.total}</p>
          </div>
        </div>
        <div className="card px-5 py-4 flex items-center gap-4">
          <div className="w-10 h-10 bg-violet-50 rounded-lg flex items-center justify-center">
            <Tag size={20} className="text-violet-600" strokeWidth={1.5} />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-gray-500 font-medium">Genres</p>
            <p className="text-lg font-semibold text-gray-900 tabular-nums">{rosterStats.genreCount}</p>
          </div>
        </div>
        <div className="card px-5 py-4 flex items-center gap-4">
          <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center">
            <Disc3 size={20} className="text-blue-600" strokeWidth={1.5} />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-gray-500 font-medium">Total Releases</p>
            <p className="text-lg font-semibold text-gray-900 tabular-nums">{rosterStats.totalReleases}</p>
          </div>
        </div>
        <div className="card px-5 py-4 flex items-center gap-4">
          <div className="w-10 h-10 bg-emerald-50 rounded-lg flex items-center justify-center">
            <Activity size={20} className="text-emerald-600" strokeWidth={1.5} />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-gray-500 font-medium">Active Roster</p>
            <p className="text-lg font-semibold text-gray-900 tabular-nums">{rosterStats.active}</p>
          </div>
        </div>
      </div>

      {/* Filters toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Genre dropdown */}
        <div className="relative" ref={genreRef}>
          <button
            onClick={() => setGenreOpen(v => !v)}
            className="flex items-center gap-2 pl-3 pr-2 py-1.5 text-xs font-semibold border border-gray-200 rounded-lg bg-white text-gray-700 hover:border-gray-300 transition-colors"
          >
            <Tag size={13} className="text-gray-400" />
            <span>Genre:</span>
            <span className="text-gray-900">{genreFilter}</span>
            {genreFilter !== 'All' && (
              <span className="text-[10px] font-bold text-gray-400 tabular-nums">{genreCounts[genreFilter] || 0}</span>
            )}
            <ChevronDown size={13} className={`text-gray-400 transition-transform ${genreOpen ? 'rotate-180' : ''}`} />
          </button>
          {genreOpen && (
            <div className="absolute left-0 mt-2 w-64 bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden">
              <div className="p-2 border-b border-gray-100">
                <div className="relative">
                  <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    autoFocus
                    type="text"
                    placeholder="Search genres…"
                    value={genreSearch}
                    onChange={e => setGenreSearch(e.target.value)}
                    className="w-full pl-7 pr-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-boom-500 placeholder:text-gray-300"
                  />
                </div>
              </div>
              <div className="max-h-72 overflow-y-auto py-1">
                {genres
                  .filter(g => !genreSearch || g.toLowerCase().includes(genreSearch.toLowerCase()))
                  .map(g => {
                    const isActive = genreFilter === g
                    return (
                      <button
                        key={g}
                        onClick={() => { setGenreFilter(g); setGenreOpen(false); setGenreSearch('') }}
                        className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-left hover:bg-gray-50 transition-colors ${isActive ? 'text-gray-900 font-semibold' : 'text-gray-600'}`}
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          {isActive && <Check size={12} className="text-boom-600 flex-shrink-0" />}
                          {!isActive && <span className="w-3 flex-shrink-0" />}
                          <span className="truncate">{g}</span>
                        </span>
                        <span className="text-[10px] font-bold text-gray-400 tabular-nums">{genreCounts[g] || 0}</span>
                      </button>
                    )
                  })}
              </div>
            </div>
          )}
        </div>

        {/* Release activity filter */}
        <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
          {['All', 'Has Releases', 'No Releases'].map(opt => (
            <button
              key={opt}
              onClick={() => setReleaseFilter(opt)}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
                releaseFilter === opt
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              {opt}
            </button>
          ))}
        </div>

        {/* Active-roster toggle — narrows to artists with at least one
            release in the past 365 days or any upcoming release. Server-
            derived `has_recent_release` flag. */}
        <button
          onClick={() => setActiveOnly(v => !v)}
          title={activeOnly
            ? 'Showing only artists with a release in the past 365 days or an upcoming one — click to show all'
            : 'Show only artists with a release in the past 365 days or an upcoming one'}
          className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all border ${
            activeOnly
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200 shadow-sm'
              : 'bg-white text-gray-500 border-gray-200 hover:text-gray-700 hover:border-gray-300'
          }`}
        >
          {activeOnly ? '● Active only' : 'Active only'}
        </button>

        <div className="flex-1" />

        {/* Sort dropdown */}
        <div className="relative flex-shrink-0">
          <ArrowUpDown size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className="pl-7 pr-7 py-1.5 text-xs font-semibold border border-gray-200 rounded-lg bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-boom-500 appearance-none cursor-pointer hover:border-gray-300 transition-colors"
          >
            <option value="name-asc">Name A → Z</option>
            <option value="name-desc">Name Z → A</option>
            <option value="releases-desc">Most Releases</option>
            <option value="releases-asc">Fewest Releases</option>
          </select>
          <ChevronDown size={13} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        </div>
      </div>

      {error && <div className="text-sm text-red-600 text-center py-12">{error}</div>}

      {/* Artist Grid */}
      {filtered.length === 0 && !loading ? (
        <p className="text-sm text-gray-400 text-center py-12">No artists found</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((artist) => renderArtistCard(artist, { isArchived: false, onArchive: toggleArchive, onView: handleViewArtist, genreColor, artistInitials }))}
        </div>
      )}

      {/* Archived section — collapsible. Only renders when there's at
          least one archived artist on file so the page isn't cluttered
          with an empty header. Restoring an artist puts them back into
          the main roster grid without losing any history. */}
      {archived.length > 0 && (
        <div className="mt-8">
          <button
            type="button"
            onClick={() => setShowArchived(v => !v)}
            className="w-full flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-gray-400 hover:text-gray-600 px-1 py-2 border-t border-divider"
            title={showArchived ? 'Hide archived artists' : 'Show archived artists'}
          >
            {showArchived ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Archive size={12} />
            Archived
            <span className="text-gray-300 font-semibold normal-case">· {archived.length} {archived.length === 1 ? 'artist' : 'artists'}</span>
          </button>
          {showArchived && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
              {archived.map(artist => renderArtistCard(artist, { isArchived: true, onArchive: toggleArchive, onView: handleViewArtist, genreColor, artistInitials }))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Per-card render — extracted so the active grid and the archived
// section render with identical chrome, just with the archive/restore
// toggle in opposite states. The button is a sibling inside the
// wrapping <button onClick={view}>, so we stopPropagation on the
// archive click to avoid navigating into the artist detail.
function renderArtistCard(artist, { isArchived, onArchive, onView, genreColor, artistInitials }) {
  const initials = artistInitials(artist.name)
  const releaseCount = artist.total_releases || 0
  return (
    <div key={artist.id} className="relative group">
      <button
        type="button"
        onClick={() => onView(artist.id)}
        className={`w-full bg-white border border-gray-100 rounded-xl px-4 py-3.5 pr-12 text-left hover:border-gray-300 hover:shadow-md hover:-translate-y-0.5 transition-all duration-150 flex items-center gap-3.5 ${
          isArchived ? 'opacity-60' : ''
        }`}
      >
        {/* Avatar */}
        <div className="w-11 h-11 rounded-full flex-shrink-0 overflow-hidden bg-gray-100 ring-1 ring-gray-200/60 group-hover:ring-gray-300 transition-all">
          {artist.image_url ? (
            <img src={artist.image_url} alt={artist.name} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-xs font-bold text-gray-500">
              {initials}
            </div>
          )}
        </div>
        {/* Info */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900 truncate tracking-tight">
            {artist.name}
          </p>
          <div className="flex items-center gap-2 mt-1">
            {artist.genre && (
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${genreColor(artist.genre)}`}>
                {artist.genre}
              </span>
            )}
            <span className="text-[11px] text-gray-400 tabular-nums">
              {releaseCount} {releaseCount === 1 ? 'release' : 'releases'}
            </span>
          </div>
        </div>
        <ChevronRight size={14} className="text-gray-300 group-hover:text-gray-500 group-hover:translate-x-0.5 flex-shrink-0 transition-all" />
      </button>
      {/* Archive / Restore action — sibling of the view button so its
          clicks can't bubble into navigation. Hover-revealed for active
          cards; always visible for archived (Restore is the primary
          action there). */}
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onArchive(artist.id, !isArchived) }}
        className={`absolute top-2 right-2 p-1 rounded transition-opacity ${
          isArchived
            ? 'opacity-100 text-emerald-700 hover:bg-emerald-50 text-[10px] font-bold uppercase tracking-wider px-1.5'
            : 'opacity-0 group-hover:opacity-100 text-gray-400 hover:text-amber-600 hover:bg-amber-50'
        }`}
        title={isArchived ? 'Restore this artist to the active roster' : 'Archive this artist — moves them out of the active roster'}
      >
        {isArchived ? 'Restore' : <Archive size={13} />}
      </button>
    </div>
  )
}
