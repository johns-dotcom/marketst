import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, X, Music2, ExternalLink, RotateCcw, Disc3, RefreshCw, Archive } from 'lucide-react'
import api from '../api'
import { formatDate } from '../utils'
import PageHeader from '../components/PageHeader'
import Skeleton from '../components/Skeleton'
import useHotkeys from '../hooks/useHotkeys'

// Convert a Spotify URI or raw ID to a full https:// URL
function spotifyUrl(uri) {
  if (!uri) return null
  if (uri.startsWith('http')) return uri
  const match = uri.match(/^spotify:(track|album|playlist|artist):(.+)$/)
  if (match) return `https://open.spotify.com/${match[1]}/${match[2]}`
  // Assume bare track ID
  return `https://open.spotify.com/track/${uri}`
}

const GENRE_OPTIONS = ['All', 'Hip-Hop', 'EDM', 'Pop', 'Alt', 'R&B', 'Electronic', 'Hip Hop/Rap', 'Hip-Hop/Rap', 'Latin']
const TYPE_OPTIONS  = ['All', 'single', 'EP', 'album']

const MONTH_OPTIONS = [
  { value: '01', label: 'January' },
  { value: '02', label: 'February' },
  { value: '03', label: 'March' },
  { value: '04', label: 'April' },
  { value: '05', label: 'May' },
  { value: '06', label: 'June' },
  { value: '07', label: 'July' },
  { value: '08', label: 'August' },
  { value: '09', label: 'September' },
  { value: '10', label: 'October' },
  { value: '11', label: 'November' },
  { value: '12', label: 'December' },
]

const TIME_PRESETS = [
  { value: 'all',       label: 'All Time' },
  { value: 'this_year', label: 'This Year' },
  { value: '6mo',       label: '6 Mo' },
  { value: '12mo',      label: '12 Mo' },
  { value: '24mo',      label: '2 Yrs' },
  { value: 'custom',    label: 'Custom' },
]

const TYPE_COLORS = {
  single: 'bg-blue-100 text-blue-700',
  EP:     'bg-purple-100 text-purple-700',
  album:  'bg-emerald-100 text-emerald-700',
}

export default function Catalog() {
  const [releases, setReleases]     = useState([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState('')
  const [search, setSearch]           = useState('')
  const [genre, setGenre]             = useState('All')
  const [releaseType, setReleaseType] = useState('All')
  const [timePreset, setTimePreset]   = useState('all')
  const [filterYear, setFilterYear]   = useState('')
  const [filterMonth, setFilterMonth] = useState('')
  const [customFrom, setCustomFrom]   = useState('')
  const [customTo, setCustomTo]       = useState('')
  const [movingId, setMovingId]       = useState(null)
  const [syncing, setSyncing]       = useState(false)
  const [visibleCount, setVisibleCount] = useState(60)
  const [syncResult, setSyncResult] = useState(null)
  const [filterArtist, setFilterArtist] = useState('')
  // When true, the page shows archived releases (delayed/never-released) and
  // the per-card action switches to Unarchive. Filters + search still apply.
  const [showArchived, setShowArchived] = useState(false)

  const TIME_PRESETS = ['all', 'this_year', '6mo', '12mo', '24mo', 'custom']
  useHotkeys([
    { key: 's', handler: () => handleSyncArtwork() },
    ...TIME_PRESETS.map((p, i) => ({ key: String(i + 1), handler: () => setTimePreset(p) })),
  ])

  useEffect(() => {
    fetchCatalog()
    setVisibleCount(60)
  }, [genre, releaseType, timePreset, filterYear, filterMonth, customFrom, customTo, showArchived])

  const fetchCatalog = async () => {
    try {
      setLoading(true)
      // Archived view: pull archived releases across catalog + pipeline.
      // Default view: catalog only (in_catalog=true, unarchived).
      const params = showArchived
        ? { archived: true, in_catalog: 'any' }
        : { in_catalog: true }
      if (genre !== 'All') params.genre = genre
      if (releaseType !== 'All') params.release_type = releaseType

      if (timePreset === 'this_year') {
        const y = new Date().getFullYear()
        params.date_from = `${y}-01-01`
        params.date_to   = `${y}-12-31`
      } else if (timePreset === '6mo') {
        const d = new Date()
        d.setMonth(d.getMonth() - 6)
        params.date_from = d.toISOString().split('T')[0]
      } else if (timePreset === '12mo') {
        const d = new Date()
        d.setFullYear(d.getFullYear() - 1)
        params.date_from = d.toISOString().split('T')[0]
      } else if (timePreset === '24mo') {
        const d = new Date()
        d.setFullYear(d.getFullYear() - 2)
        params.date_from = d.toISOString().split('T')[0]
      } else if (timePreset === 'custom') {
        if (customFrom) params.date_from = customFrom
        if (customTo)   params.date_to   = customTo
      } else if (filterYear) {
        params.month = filterMonth ? `${filterYear}-${filterMonth}` : filterYear
      }

      const res = await api.get('/releases', { params })
      setReleases(res.data.data || [])
    } catch (err) {
      setError('Failed to load catalog')
    } finally {
      setLoading(false)
    }
  }

  const handlePreset = (preset) => {
    setTimePreset(preset)
    setFilterYear('')
    setFilterMonth('')
    setCustomFrom('')
    setCustomTo('')
  }

  const handleFilterYear = (y) => {
    setFilterYear(y)
    setTimePreset('')
  }

  const handleFilterMonth = (m) => {
    // If month picked but no year, default to current year
    if (m && !filterYear) setFilterYear(String(new Date().getFullYear()))
    setFilterMonth(m)
    setTimePreset('')
  }

  const clearDateFilters = () => {
    setFilterYear('')
    setFilterMonth('')
    setCustomFrom('')
    setCustomTo('')
    setTimePreset('all')
  }

  const handleSyncArtwork = async () => {
    setSyncing(true)
    setSyncResult(null)
    let totalUpdated = 0
    try {
      // Keep batching until the server reports no releases remaining, or
      // until the remaining count stops decreasing (nothing more to match).
      // Hard cap on iterations so a misbehaving backend can't hang the UI.
      let lastRemaining = null
      for (let iter = 0; iter < 30; iter++) {
        const res = await api.post('/releases/sync-artwork')
        const { updated, remaining, total } = res.data.data
        totalUpdated += updated
        setSyncResult({ updated: totalUpdated, remaining })
        if (remaining === 0 || total === 0) break
        if (lastRemaining !== null && remaining >= lastRemaining) break
        lastRemaining = remaining
        await new Promise(r => setTimeout(r, 500))
      }
      if (totalUpdated > 0) fetchCatalog()
      setTimeout(() => setSyncResult(null), 8000)
    } catch (err) {
      setSyncResult({ error: err.response?.data?.error || 'Sync failed' })
      setTimeout(() => setSyncResult(null), 6000)
    } finally {
      setSyncing(false)
    }
  }

  const handleMoveBackToPipeline = async (id) => {
    if (!window.confirm('Move this release back to the tracker?')) return
    setMovingId(id)
    try {
      await api.put(`/releases/${id}/catalog`)
      setReleases(prev => prev.filter(r => r.id !== id))
    } catch (err) {
      alert('Failed to update release')
    } finally {
      setMovingId(null)
    }
  }

  const handleUnarchive = async (id) => {
    setMovingId(id)
    try {
      await api.put(`/releases/${id}/archive`)
      // Drop from view — it's no longer archived so it doesn't belong here.
      setReleases(prev => prev.filter(r => r.id !== id))
    } catch (err) {
      alert('Failed to unarchive release')
    } finally {
      setMovingId(null)
    }
  }

  // Reset pagination when client-side filters change
  useEffect(() => { setVisibleCount(60) }, [search, filterArtist])

  // Deduplicate artist names case-insensitively, keep most common spelling
  const allArtists = (() => {
    const map = {}
    releases.forEach(r => {
      if (!r.artist_name) return
      const key = r.artist_name.toLowerCase()
      if (!map[key]) map[key] = {}
      map[key][r.artist_name] = (map[key][r.artist_name] || 0) + 1
    })
    return Object.values(map).map(v => Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]).sort()
  })()

  const filtered = releases.filter(r => {
    if (filterArtist && !(r.artist_name || '').toLowerCase().includes(filterArtist.toLowerCase())) return false
    if (!search) return true
    const s = search.toLowerCase()
    return (
      r.artist_name?.toLowerCase().includes(s) ||
      r.project_name?.toLowerCase().includes(s) ||
      r.upc?.toLowerCase().includes(s) ||
      r.isrc?.toLowerCase().includes(s)
    )
  })

  // Paginate — show visibleCount releases, with a Load More button
  const paginated = filtered.slice(0, visibleCount)
  const hasMore = filtered.length > visibleCount

  // Group by year for the timeline view
  const byYear = paginated.reduce((acc, r) => {
    const y = r.release_date ? new Date(r.release_date).getFullYear() : 'Unknown'
    if (!acc[y]) acc[y] = []
    acc[y].push(r)
    return acc
  }, {})
  const sortedYears = Object.keys(byYear).sort((a, b) => b - a)

  const currentYear = new Date().getFullYear()
  const availableYears = []
  for (let y = currentYear; y >= currentYear - 10; y--) availableYears.push(String(y))

  return (
    <div>
      {/* Header */}
      <PageHeader
        title={showArchived ? 'Archived Releases' : 'Catalog'}
        subtitle={loading ? '—' : `${filtered.length} ${showArchived ? 'archived ' : ''}release${filtered.length !== 1 ? 's' : ''}`}
        actions={<>
          {syncResult && (
            <span className={`text-xs ${syncResult.error ? 'text-red-500' : 'text-gray-500'}`}>
              {syncResult.error
                ? syncResult.error
                : syncResult.updated > 0
                  ? `✓ ${syncResult.updated} artworks synced${syncResult.remaining > 0 ? ` · ${syncResult.remaining} remaining` : ''}`
                  : syncResult.remaining > 0
                    ? `${syncResult.remaining} releases without artwork (no Spotify match found)`
                    : 'All artwork up to date'}
            </span>
          )}
          <button
            onClick={() => setShowArchived(v => !v)}
            title={showArchived ? 'Return to the catalog view' : 'View archived releases (delayed or never-released)'}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm border rounded-xl transition-colors ${
              showArchived
                ? 'bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100'
                : 'bg-card border-rule text-gray-600 hover:bg-gray-50'
            }`}
          >
            <Archive size={13} />
            {showArchived ? 'Back to catalog' : 'View archived'}
          </button>
          <button
            onClick={handleSyncArtwork}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 bg-card border border-rule rounded-xl hover:bg-gray-50 disabled:opacity-50 transition-colors"
            title="Fetch cover art from Spotify for all catalog releases"
          >
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing…' : 'Sync Artwork'}
          </button>
        </>}
      />

      {/* Filters */}
      <div className="flex flex-col gap-3 mb-6">
        {/* Row 1: search + filters */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Search */}
          <div className="relative min-w-[200px] max-w-xs flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search artist, title, UPC, ISRC…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-8 py-2 text-sm border border-rule rounded-lg focus:outline-none focus:ring-2 focus:ring-boom-400 bg-card"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
                <X size={13} />
              </button>
            )}
          </div>

          {/* Artist — typeable with datalist suggestions; matches by substring */}
          <div className="relative">
            <input
              type="text"
              list="catalog-artists-list"
              value={filterArtist}
              onChange={e => setFilterArtist(e.target.value)}
              placeholder="All Artists"
              className="px-3 py-2 pr-7 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400 min-w-[180px]"
            />
            <datalist id="catalog-artists-list">
              {allArtists.map(a => <option key={a} value={a} />)}
            </datalist>
            {filterArtist && (
              <button onClick={() => setFilterArtist('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500"
                aria-label="Clear artist filter">
                <X size={13} />
              </button>
            )}
          </div>

          {/* Genre */}
          <select value={genre} onChange={e => setGenre(e.target.value)}
            className="px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400">
            {GENRE_OPTIONS.map(g => <option key={g} value={g}>{g === 'All' ? 'All Genres' : g}</option>)}
          </select>

          {/* Type */}
          <select value={releaseType} onChange={e => setReleaseType(e.target.value)}
            className="px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400">
            {TYPE_OPTIONS.map(t => <option key={t} value={t}>{t === 'All' ? 'All Types' : t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
          </select>

          {(search || filterArtist || genre !== 'All' || releaseType !== 'All') && (
            <button onClick={() => { setSearch(''); setFilterArtist(''); setGenre('All'); setReleaseType('All') }}
              className="px-3 py-2 text-xs font-semibold text-gray-500 hover:text-gray-700 border border-rule rounded-lg hover:bg-gray-50 transition-colors">
              Clear
            </button>
          )}

          <span className="text-xs text-gray-400 ml-auto">{filtered.length} releases</span>
        </div>

        {/* Row 2: time filters */}
        <div className="flex items-center gap-2 flex-wrap">
          {timePreset === 'custom' ? (
            /* Custom date range inputs */
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={customFrom}
                onChange={e => setCustomFrom(e.target.value)}
                className="text-sm text-gray-600 border border-rule rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-400 bg-card"
              />
              <span className="text-xs text-gray-400">to</span>
              <input
                type="date"
                value={customTo}
                onChange={e => setCustomTo(e.target.value)}
                className="text-sm text-gray-600 border border-rule rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-400 bg-card"
              />
              {(customFrom || customTo) && (
                <button onClick={clearDateFilters} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors">
                  <X size={11} /> Clear
                </button>
              )}
            </div>
          ) : (
            /* Year + Month dropdowns — month always visible, auto-sets year if needed */
            <>
              <div className={`flex items-center gap-1.5 px-3 py-2 bg-card border rounded-xl transition-colors ${filterYear ? 'border-boom-400' : 'border-rule'}`}>
                <select
                  value={filterYear}
                  onChange={e => handleFilterYear(e.target.value)}
                  className="text-sm text-gray-600 bg-transparent border-0 outline-none cursor-pointer">
                  <option value="">Year</option>
                  {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>

              <div className={`flex items-center gap-1.5 px-3 py-2 bg-card border rounded-xl transition-colors ${filterMonth ? 'border-boom-400' : 'border-rule'}`}>
                <select
                  value={filterMonth}
                  onChange={e => handleFilterMonth(e.target.value)}
                  className="text-sm text-gray-600 bg-transparent border-0 outline-none cursor-pointer">
                  <option value="">Month</option>
                  {MONTH_OPTIONS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>

              {(filterYear || filterMonth) && (
                <button onClick={clearDateFilters} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors">
                  <X size={11} /> Clear
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* States */}
      {error && <div className="text-center py-12 text-sm text-red-600">{error}</div>}

      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton.Block key={i} h="h-64" className="rounded-2xl" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Disc3 size={40} className="text-gray-200 mb-4" />
          <p className="text-gray-500 font-medium">
            {showArchived ? 'No archived releases' : 'No releases in the catalog yet'}
          </p>
          <p className="text-sm text-gray-400 mt-1">
            {showArchived
              ? 'Archive delayed or never-released projects from the Release Tracker or their detail page.'
              : 'Mark releases as "Released" from the Release Tracker to add them here.'}
          </p>
        </div>
      ) : (
        /* Timeline grouped by year */
        <div className="space-y-10">
          {sortedYears.map(yr => (
            <div key={yr}>
              <div className="flex items-center gap-3 mb-4">
                <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest">{yr}</h2>
                <div className="flex-1 h-px bg-gray-100" />
                <span className="text-xs text-gray-400">{byYear[yr].length} release{byYear[yr].length !== 1 ? 's' : ''}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {byYear[yr].map(release => (
                  <CatalogCard
                    key={release.id}
                    release={release}
                    movingId={movingId}
                    onMoveBack={showArchived ? handleUnarchive : handleMoveBackToPipeline}
                    archivedMode={showArchived}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* Load More */}
          {hasMore && (
            <div className="text-center py-6">
              <button
                onClick={() => setVisibleCount(v => v + 60)}
                className="px-6 py-2.5 text-sm font-semibold text-gray-600 bg-card border border-rule rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-colors"
              >
                Load More ({filtered.length - visibleCount} remaining)
              </button>
            </div>
          )}
          {!hasMore && filtered.length > 60 && (
            <p className="text-center text-xs text-gray-400 py-4">Showing all {filtered.length} releases</p>
          )}
        </div>
      )}
    </div>
  )
}

function CatalogCard({ release, movingId, onMoveBack, archivedMode = false }) {
  const [showActions, setShowActions] = useState(false)
  const navigate = useNavigate()

  const typeLabel = release.release_type
    ? release.release_type.charAt(0).toUpperCase() + release.release_type.slice(1)
    : null
  const typeColor = TYPE_COLORS[release.release_type] || 'bg-gray-100 text-gray-600'

  const handleCardClick = () => {
    navigate(`/releases/${release.id}`, { state: { from: 'catalog' } })
  }

  return (
    <div
      className="group bg-card rounded-2xl border border-divider overflow-hidden hover:shadow-md transition-all duration-200 cursor-pointer"
      onClick={handleCardClick}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {/* Cover art */}
      <div className="relative aspect-square bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center overflow-hidden">
        {release.cover_art_url && release.cover_art_url !== 'not_found' ? (
          <img
            src={release.cover_art_url}
            alt={`${release.project_name} cover art`}
            className="w-full h-full object-cover"
            loading="lazy"
            onError={e => { e.target.style.display = 'none' }}
          />
        ) : (
          <Music2 size={32} className="text-gray-300" />
        )}
        {/* Type badge */}
        {typeLabel && (
          <span className={`absolute top-2 left-2 text-[10px] font-bold px-2 py-0.5 rounded-full ${typeColor}`}>
            {typeLabel}
          </span>
        )}
        {/* Hover actions overlay */}
        <div className={`absolute inset-0 bg-black/40 flex items-center justify-center gap-2 transition-opacity duration-150 ${showActions ? 'opacity-100' : 'opacity-0'}`}>
          {spotifyUrl(release.spotify_uri) && (
            <a
              href={spotifyUrl(release.spotify_uri)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="p-1.5 bg-white/20 hover:bg-white/30 rounded-full text-white transition-colors"
              title="Open in Spotify"
            >
              <ExternalLink size={13} />
            </a>
          )}
          {release.apple_music_link && (
            <a
              href={release.apple_music_link}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="p-1.5 bg-white/20 hover:bg-white/30 rounded-full text-white transition-colors"
              title="Open in Apple Music"
            >
              <ExternalLink size={13} />
            </a>
          )}
          <button
            onClick={e => { e.stopPropagation(); onMoveBack(release.id) }}
            disabled={movingId === release.id}
            className="p-1.5 bg-white/20 hover:bg-white/30 rounded-full text-white transition-colors disabled:opacity-50"
            title={archivedMode ? 'Unarchive release' : 'Move back to tracker'}
          >
            {archivedMode
              ? <Archive size={13} className={movingId === release.id ? 'animate-spin' : ''} />
              : <RotateCcw size={13} className={movingId === release.id ? 'animate-spin' : ''} />}
          </button>
        </div>
      </div>

      {/* Info */}
      <div className="p-3">
        <p className="text-xs font-semibold text-gray-900 leading-tight truncate" title={release.project_name}>
          {release.project_name}
        </p>
        <p className="text-xs text-gray-500 truncate mt-0.5" title={release.artist_name}>
          {release.artist_name}
        </p>
        <div className="flex items-center justify-between mt-2">
          <p className="text-[10px] text-gray-400">{formatDate(release.release_date)}</p>
          {release.genre && (
            <p className="text-[10px] text-gray-400 truncate ml-2">{release.genre}</p>
          )}
        </div>
        {(release.upc || release.isrc) && (
          <div className="mt-2 pt-2 border-t border-gray-50 space-y-0.5">
            {release.upc  && <p className="text-[10px] text-gray-400 font-mono truncate">UPC {release.upc}</p>}
            {release.isrc && <p className="text-[10px] text-gray-400 font-mono truncate">ISRC {release.isrc}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
