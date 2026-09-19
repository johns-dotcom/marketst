import { useState, useEffect } from 'react'
import { useParams, Link, useSearchParams } from 'react-router-dom'
import { Music, FileText, ExternalLink, Users, Disc3, Globe2, Loader, Plus, Trash2, Link2, Archive, Activity, Wallet, PiggyBank, Megaphone, ArrowRight } from 'lucide-react'
import api from '../api'
import { formatDate, daysUntilLocal, isPastLocal, artistBucket } from '../utils'
import Skeleton from '../components/Skeleton'
import Breadcrumb from '../components/Breadcrumb'
import FilesPanel from '../components/FilesPanel'
import { useAuth } from '../context/AuthContext'
import { Button, Input, Select, Textarea } from '../components/ui'

const DEVLOG_ENTRY_TYPES = [
  'Meeting', 'Demo Received', 'Feedback Sent', 'Offer Made',
  'Follow-up', 'Call', 'Email', 'Note',
]

// Same pattern as the genre badges on the Roster — a tinted pill matching
// the entry-type's semantic color. Kept light so the badges sit comfortably
// inside a timeline row without competing with the summary text.
const DEVLOG_TYPE_TONE = {
  'Meeting':       'bg-blue-100 text-blue-700',
  'Demo Received': 'bg-violet-100 text-violet-700',
  'Feedback Sent': 'bg-amber-100 text-amber-700',
  'Offer Made':    'bg-emerald-100 text-emerald-700',
  'Follow-up':     'bg-orange-100 text-orange-700',
  'Call':          'bg-sky-100 text-sky-700',
  'Email':         'bg-indigo-100 text-indigo-700',
  'Note':          'bg-gray-100 text-gray-600',
}

const CHECKLIST_KEYS = ['yt_video','recoup_added','uploaded','stem_pitch','s4a_pitch','amazon_pitch','pandora','budget','marketing_plan','official_thread','marquee','content','dsp_email','musixmatch']

function fmt(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n || 0)
}

function fmtNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(n)
}

function fmtDuration(ms) {
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function completion(release) {
  const done = CHECKLIST_KEYS.filter(k => release[k]).length
  return Math.round((done / CHECKLIST_KEYS.length) * 100)
}

const TAB_STYLE = (active) => `px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
  active ? 'border-boom-600 text-boom-700' : 'border-transparent text-gray-400 hover:text-gray-600'
}`

// ── Spotify sub-components ───────────────────────────────────────────────

function PopularityRing({ value, size = 64, label }) {
  const r = (size - 8) / 2
  const c = 2 * Math.PI * r
  const offset = c - (value / 100) * c
  const color = value >= 70 ? '#22c55e' : value >= 40 ? '#f59e0b' : '#ef4444'
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#f3f4f6" strokeWidth="5" />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="5"
          strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round" className="transition-all duration-700" />
      </svg>
      <span className="text-lg font-black text-gray-900 -mt-[calc(50%+14px)] mb-[calc(50%-14px)]">{value}</span>
      {label && <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">{label}</span>}
    </div>
  )
}

function SpotifyTab({ artistId }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)
    api.get(`/artists/${artistId}/spotify`)
      .then(res => {
        setData(res.data.data)
        setError(null)
      })
      .catch(err => setError(err.response?.data?.error || 'Failed to load Spotify data'))
      .finally(() => setLoading(false))
  }, [artistId])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="flex flex-col items-center gap-3">
          <Loader className="animate-spin text-green-500" size={24} />
          <p className="text-sm text-gray-400">Fetching Spotify data...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="card p-8 text-center">
        <Disc3 size={32} className="mx-auto mb-3 text-gray-300" />
        <p className="text-sm text-gray-500">{error}</p>
        <p className="text-xs text-gray-400 mt-1">Make sure SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are set.</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="card p-8 text-center">
        <Music size={32} className="mx-auto mb-3 text-gray-300" />
        <p className="text-sm text-gray-500">Artist not found on Spotify</p>
        <p className="text-xs text-gray-400 mt-1">Add a Spotify link to improve matching accuracy.</p>
      </div>
    )
  }

  const { profile, top_tracks, albums } = data

  const singles = albums?.filter(a => a.album_type === 'single') || []
  const fullAlbums = albums?.filter(a => a.album_type === 'album') || []

  return (
    <div className="space-y-6">
      {/* Profile stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {profile?.popularity > 0 && (
          <div className="card px-4 py-4 flex flex-col items-center">
            <PopularityRing value={profile.popularity} />
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wide mt-2">Popularity</span>
          </div>
        )}
        {profile?.followers > 0 && (
          <div className="card px-4 py-4 text-center">
            <Users size={18} className="mx-auto text-green-500 mb-1.5" />
            <p className="text-2xl font-black text-gray-900">{fmtNum(profile.followers)}</p>
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Followers</span>
          </div>
        )}
        <div className="card px-4 py-4 text-center">
          <Music size={18} className="mx-auto text-green-500 mb-1.5" />
          <p className="text-2xl font-black text-gray-900">{top_tracks?.length || 0}</p>
          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Tracks Found</span>
        </div>
        <div className="card px-4 py-4 text-center">
          <Disc3 size={18} className="mx-auto text-green-500 mb-1.5" />
          <p className="text-2xl font-black text-gray-900">{albums?.length || 0}</p>
          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Releases</span>
        </div>
        {albums?.[0]?.markets_count > 0 && (
          <div className="card px-4 py-4 text-center">
            <Globe2 size={18} className="mx-auto text-green-500 mb-1.5" />
            <p className="text-2xl font-black text-gray-900">{albums[0].markets_count}</p>
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Markets</span>
          </div>
        )}
      </div>

      {/* Genres */}
      {profile?.genres?.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-gray-500">Genres:</span>
          {profile.genres.map(g => (
            <span key={g} className="text-xs font-medium bg-green-50 text-green-700 px-2.5 py-1 rounded-full">{g}</span>
          ))}
        </div>
      )}

      {/* Open on Spotify link */}
      {profile?.external_url && (
        <a href={profile.external_url} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-2 text-xs font-semibold text-green-600 hover:text-green-700 transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
          Open on Spotify
        </a>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Tracks */}
        {top_tracks?.length > 0 && (
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Top Tracks</h3>
            <div className="space-y-1">
              {top_tracks.map((t, i) => (
                <a key={t.id} href={t.external_url} target="_blank" rel="noreferrer"
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 transition-colors group">
                  <span className="text-xs font-bold text-gray-300 w-5 text-right">{i + 1}</span>
                  {t.album?.image ? (
                    <img src={t.album.image} alt="" className="w-9 h-9 rounded object-cover flex-shrink-0" />
                  ) : (
                    <div className="w-9 h-9 rounded bg-gray-100 flex items-center justify-center flex-shrink-0">
                      <Music size={12} className="text-gray-400" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate group-hover:text-green-600 transition-colors">{t.name}</p>
                    <p className="text-[10px] text-gray-400 truncate">{t.album?.name}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="w-14 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-green-500" style={{ width: `${t.popularity}%` }} />
                    </div>
                    <span className="text-[10px] font-bold text-gray-400 w-6">{t.popularity}</span>
                  </div>
                </a>
              ))}
            </div>
          </div>
        )}

      </div>

      {/* Discography */}
      {albums?.length > 0 && (
        <div className="card p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">Spotify Discography</h3>
          <p className="text-[10px] text-gray-400 mb-4">{fullAlbums.length} album{fullAlbums.length !== 1 ? 's' : ''} · {singles.length} single{singles.length !== 1 ? 's' : ''}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {albums.slice(0, 18).map(a => (
              <a key={a.id} href={a.external_url} target="_blank" rel="noreferrer"
                className="group text-center">
                {a.image ? (
                  <img src={a.image} alt="" className="w-full aspect-square rounded-lg object-cover shadow-sm group-hover:shadow-md transition-shadow" />
                ) : (
                  <div className="w-full aspect-square rounded-lg bg-gray-100 flex items-center justify-center">
                    <Disc3 size={20} className="text-gray-300" />
                  </div>
                )}
                <p className="text-xs font-medium text-gray-900 mt-1.5 truncate group-hover:text-green-600 transition-colors">{a.name}</p>
                <p className="text-[10px] text-gray-400">{a.release_date?.substring(0, 4)} · {a.total_tracks} track{a.total_tracks !== 1 ? 's' : ''}</p>
              </a>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}

// ── Development Log tab ───────────────────────────────────────────────────

// Entries + setEntries are owned by the parent so the TABS label can show a
// live count without waiting for the user to open the tab. Same pattern as
// Releases (which reads off the parent's data.releases).
function DevLogTab({ artistId, user, isAdmin, entries, setEntries }) {
  const [form, setForm] = useState({
    date: new Date().toISOString().split('T')[0],
    entry_type: 'Note',
    summary: '',
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const handleAdd = async (e) => {
    e.preventDefault()
    if (!form.summary.trim()) return
    setSaving(true)
    setSaveError('')
    try {
      const res = await api.post(`/artists/${artistId}/devlog`, form)
      setEntries(prev => [res.data.data, ...prev])
      setForm({
        date: new Date().toISOString().split('T')[0],
        entry_type: 'Note',
        summary: '',
      })
    } catch (err) {
      setSaveError(err.response?.data?.error || 'Failed to add entry')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (entryId) => {
    if (!window.confirm('Delete this entry?')) return
    try {
      await api.delete(`/artists/${artistId}/devlog/${entryId}`)
      setEntries(prev => prev.filter(e => e.id !== entryId))
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete')
    }
  }

  // Server enforces the same check — UI just hides the affordance from users
  // who don't own the entry and aren't admins.
  const canDelete = (entry) => isAdmin || (user?.id != null && entry.created_by === user.id)

  return (
    <div className="space-y-4">
      {/* Inline add form */}
      <div className="card p-4">
        <form onSubmit={handleAdd} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Input
              type="date"
              value={form.date}
              onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
              required
            />
            <Select
              value={form.entry_type}
              onChange={e => setForm(f => ({ ...f, entry_type: e.target.value }))}
            >
              {DEVLOG_ENTRY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </Select>
            <div className="hidden sm:block" />
          </div>
          <Textarea
            placeholder="What happened? (e.g., 'Met with manager, discussed Q3 release plan')"
            value={form.summary}
            onChange={e => setForm(f => ({ ...f, summary: e.target.value }))}
            rows={2}
            required
          />
          {saveError && <p className="text-xs text-red-600">{saveError}</p>}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={saving || !form.summary.trim()}>
              <Plus size={13} /> {saving ? 'Adding…' : 'Add Entry'}
            </Button>
          </div>
        </form>
      </div>

      {/* Timeline */}
      {entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Activity size={28} className="text-gray-300" strokeWidth={1.5} />
          <p className="text-sm text-gray-400 mt-3">No development activity logged yet.</p>
        </div>
      ) : (
        <ol className="space-y-2">
          {entries.map(entry => (
            <li key={entry.id} className="card px-4 py-3 flex items-start gap-3 group">
              <div className="w-20 flex-shrink-0 text-right pt-0.5">
                <p className="text-xs font-semibold text-gray-700 tabular-nums">{formatDate(entry.date)}</p>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  {entry.entry_type && (
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${DEVLOG_TYPE_TONE[entry.entry_type] || 'bg-gray-100 text-gray-600'}`}>
                      {entry.entry_type}
                    </span>
                  )}
                  {entry.created_by_name && (
                    <span className="text-[10px] text-gray-400">{entry.created_by_name}</span>
                  )}
                </div>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{entry.summary}</p>
              </div>
              {canDelete(entry) && (
                <button
                  onClick={() => handleDelete(entry.id)}
                  className="p-1.5 text-gray-300 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0"
                  title="Delete entry"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

// ── Main ArtistProfile ────────────────────────────────────────────────────

const usd0 = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(v) || 0)

export default function ArtistProfile() {
  const { id } = useParams()
  const { user, canView } = useAuth()
  const isAdmin = ['Superadmin', 'Admin', 'Approver'].includes(user?.role)
  const [data, setData] = useState(null)
  const [devlog, setDevlog] = useState([])
  const [loading, setLoading] = useState(true)
  // ?tab= opens the profile on a given tab — how the NDA page's "Saved a copy
  // to X's Documents" link and any hub deep-link land where they say.
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState(() => {
    const t = searchParams.get('tab')
    return t && /^[a-z]+$/.test(t) ? t : 'overview'
  })
  // Live document count for the Documents tab label. FilesPanel fires
  // onCountChange after its fetch + every upload / delete; we mirror that
  // here so the "Documents (N)" label stays in sync without a refetch.
  const [docCount, setDocCount] = useState(null)
  // The hub tabs (2026-09-18): the artist's money surfaces, read-only here,
  // each with the way to the full page. Fetched when the tab opens, not with
  // the profile — a bookkeeper's question, not every visitor's.
  const [sheet, setSheet] = useState(null)        // /artist-budgets/:key/simple
  const [campaign, setCampaign] = useState(null)  // this artist's card from /artist-campaigns
  const [showLinkForm, setShowLinkForm] = useState(false)
  const [linkForm, setLinkForm] = useState({ platform: 'Spotify', url: '', label: '' })
  const [archivingId, setArchivingId] = useState(null)

  const handleArchiveRelease = async (releaseId) => {
    setArchivingId(releaseId)
    try {
      const res = await api.put(`/releases/${releaseId}/archive`)
      const { archived } = res.data.data
      setData(prev => prev
        ? { ...prev, releases: (prev.releases || []).map(r => r.id === releaseId ? { ...r, archived } : r) }
        : prev)
    } catch (err) {
      alert('Failed to archive release')
    } finally {
      setArchivingId(null)
    }
  }

  const PLATFORMS = [
    'Spotify','Apple Music','YouTube','SoundCloud','Tidal',
    'Instagram','TikTok','Twitter/X','Facebook',
    'Website','Linktree','DistroKid','TuneCore','Other',
  ]

  const fetchArtist = () => {
    return api.get(`/artists/${id}`)
      .then(res => setData(res.data.data))
      .catch(() => {})
  }

  const fetchDevlog = () => {
    return api.get(`/artists/${id}/devlog`)
      .then(res => setDevlog(res.data.data || []))
      // Devlog endpoint returns 404 / empty until the migration runs on a
      // given env — don't block the whole page on it.
      .catch(() => setDevlog([]))
  }

  useEffect(() => {
    setLoading(true)
    Promise.all([fetchArtist(), fetchDevlog()]).finally(() => setLoading(false))
  }, [id])

  const handleAddLink = async (e) => {
    e.preventDefault()
    if (!linkForm.url) return
    try {
      await api.post(`/artists/${id}/links`, linkForm)
      setLinkForm({ platform: 'Spotify', url: '', label: '' })
      setShowLinkForm(false)
      fetchArtist()
    } catch (err) {
      console.error('Failed to add link:', err)
    }
  }

  const handleDeleteLink = async (linkId) => {
    try {
      await api.delete(`/artists/${id}/links/${linkId}`)
      fetchArtist()
    } catch (err) {
      console.error('Failed to delete link:', err)
    }
  }

  // Hooks above the early returns (smoke's HOOK_AFTER_RETURN rule): these
  // no-op until the tab is opened, and artistKey is '' while data is null.
  const artistKey = artistBucket(data?.name)
  useEffect(() => {
    if (tab !== 'budget' || !artistKey || sheet) return undefined
    let alive = true
    api.get(`/artist-budgets/${encodeURIComponent(artistKey)}/simple`)
      .then((r) => { if (alive) setSheet(r.data?.data || false) })
      .catch(() => { if (alive) setSheet(false) })
    return () => { alive = false }
  }, [tab, artistKey, sheet])
  useEffect(() => {
    if (tab !== 'campaigns' || !artistKey || campaign) return undefined
    let alive = true
    api.get('/artist-campaigns')
      .then((r) => {
        const rows = r.data?.data?.artists || r.data?.data || []
        const mine = Array.isArray(rows) ? rows.find((x) => x.artist_key === artistKey) : null
        if (alive) setCampaign(mine || false)
      })
      .catch(() => { if (alive) setCampaign(false) })
    return () => { alive = false }
  }, [tab, artistKey, campaign])

  if (loading) {
    return <Skeleton.ArtistProfile />
  }

  if (!data) {
    return (
      <div className="text-center py-24">
        <p className="text-gray-500">Artist not found.</p>
        <Link to="/artists" className="text-boom-600 text-sm mt-2 inline-block">Back to roster</Link>
      </div>
    )
  }

  const releases = data.releases || []
  const contracts = data.contracts || []
  const deals = data.deals || []
  const expenses = data.expenses || []
  const income = data.income || []
  // Local-calendar comparison — new Date('YYYY-MM-DD') is UTC midnight,
  // which classified a release dropping TODAY as past all day.
  const upcomingReleases = releases.filter(r => r.release_date && daysUntilLocal(r.release_date) >= 0)
  const pastReleases = releases.filter(r => !r.release_date || daysUntilLocal(r.release_date) < 0)
  const activeContracts = contracts.filter(c => c.status === 'Active')
  const budget = data.budget
  const budgetTotal = parseFloat(budget?.total_budget || budget?.amount || 0)

  // Expense by category, bucketed per currency — raw cross-currency sums
  // rendered with a $ sign were fabricated numbers on mixed-currency
  // artists. Each entry: [cat, { USD: n, EUR: n, ... }], sorted by the
  // category's largest single-currency amount.
  const byCat = {}
  expenses.forEach(e => {
    const cat = e.category || 'Other'
    const cur = (e.currency || 'USD').toUpperCase()
    byCat[cat] = byCat[cat] || {}
    byCat[cat][cur] = (byCat[cat][cur] || 0) + parseFloat(e.amount || 0)
  })
  const catMax = (m) => Math.max(...Object.values(m))
  const sortedCats = Object.entries(byCat).sort(([, a], [, b]) => catMax(b) - catMax(a))
  const fmtCatTotals = (m) => {
    const parts = Object.entries(m).filter(([, v]) => v)
    parts.sort(([a], [b]) => a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b))
    return parts.map(([c, v]) => new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(v)).join(' · ')
  }

  const links = data.links || []

  // Count release links
  const RELEASE_LINK_KEYS = ['spotify_uri', 'apple_music_link', 'presave_link', 'presave_analytics', 'ugc_link']
  const releaseLinkCount = releases.reduce((count, r) => count + RELEASE_LINK_KEYS.filter(k => r[k]).length, 0)
  const totalLinkCount = links.length + releaseLinkCount

  const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'spotify', label: 'Spotify', icon: true },
    { id: 'releases', label: `Releases (${releases.length})` },
    { id: 'spends', label: `Spends (${expenses.length})` },
    { id: 'links', label: `Links (${totalLinkCount})` },
    { id: 'devlog', label: `Development (${devlog.length})` },
    // Contracts tab gated by the same canView check the standalone
    // Contracts page uses, so a Restricted User without /contracts
    // grant doesn't see the tab here either. Default-unrestricted
    // Users see it (contracts are no longer sensitive-by-default).
    ...(canView('/contracts') ? [{ id: 'contracts', label: `Contracts (${contracts.length})` }] : []),
    // The hub: the artist's money surfaces, each read-only here with the way
    // to its page. Gated exactly as the pages are, so a tab never opens onto
    // a page the person would be bounced from.
    ...(canView('/artist-budgets') ? [{ id: 'budget', label: 'Budget' }] : []),
    ...(canView('/recoupments') ? [{ id: 'recoupments', label: 'Recoupments' }] : []),
    ...(canView('/artist-campaigns') ? [{ id: 'campaigns', label: 'Campaigns' }] : []),
    // Documents — non-contract artist files (riders, IDs, photos, etc.)
    // backed by entity_files/entity_type='artist'. Count shows ?
    // until FilesPanel reports back via onCountChange.
    { id: 'documents', label: `Documents${docCount != null ? ` (${docCount})` : ''}` },
  ]

  return (
    <div className="space-y-6">
      <Breadcrumb items={[
        { label: 'Artists', path: '/artists' },
        { label: data.name },
      ]} />

      {/* Header */}
      <div className="flex items-start gap-5">
        {data.image_url && data.image_url !== 'not_found' ? (
          <img src={data.image_url} alt={data.name} className="w-20 h-20 rounded-xl object-cover flex-shrink-0" />
        ) : (
          <div className="w-20 h-20 rounded-xl bg-boom-100 flex items-center justify-center flex-shrink-0">
            <span className="text-2xl font-black text-boom-600">{data.name?.charAt(0)?.toUpperCase()}</span>
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h1 className="text-3xl font-black text-gray-900 tracking-tight">{data.name}</h1>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            {data.genre && <span className="text-sm text-gray-500">{data.genre}</span>}
            <span className="text-sm text-gray-400">{releases.length} release{releases.length !== 1 ? 's' : ''}</span>
            {activeContracts.length > 0 && (
              <span className="text-xs font-semibold bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">
                {activeContracts.length} active contract{activeContracts.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          {/* Links */}
          {data.links && data.links.length > 0 && (
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {data.links.map(link => (
                <a key={link.id} href={link.url} target="_blank" rel="noreferrer"
                  className="text-xs font-medium text-gray-400 hover:text-boom-600 border border-rule rounded px-2 py-0.5 transition-colors">
                  {link.platform}
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3">
        <div className="card px-4 py-3">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Releases</p>
          <p className="text-xl font-black text-gray-900 mt-1">{releases.length}</p>
        </div>
        <div className="card px-4 py-3">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Upcoming</p>
          <p className="text-xl font-black text-gray-900 mt-1">{upcomingReleases.length}</p>
        </div>
      </div>

      {/* Budget progress */}
      {budgetTotal > 0 && (
        <div className="card px-5 py-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-gray-900">Budget</span>
            <span className="text-xs text-gray-500">{fmt(data.totalExpenses)} / {fmt(budgetTotal)} ({Math.round((data.totalExpenses / budgetTotal) * 100)}%)</span>
          </div>
          <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${data.totalExpenses > budgetTotal ? 'bg-red-500' : data.totalExpenses / budgetTotal > 0.8 ? 'bg-amber-400' : 'bg-emerald-500'}`}
              style={{ width: `${Math.min((data.totalExpenses / budgetTotal) * 100, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-rule">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} className={TAB_STYLE(tab === t.id)}>
            <span className="flex items-center gap-1.5">
              {t.icon && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className={tab === t.id ? 'text-green-500' : 'text-gray-400'}>
                  <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
                </svg>
              )}
              {t.label}
            </span>
          </button>
        ))}
      </div>

      {/* Spotify Tab */}
      {tab === 'spotify' && <SpotifyTab artistId={id} />}

      {/* Overview */}
      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Upcoming releases */}
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Upcoming Releases</h2>
            {upcomingReleases.length === 0 ? (
              <p className="text-sm text-gray-400 py-4 text-center">No upcoming releases</p>
            ) : (
              <div className="space-y-2">
                {upcomingReleases.slice(0, 5).map(r => {
                  const comp = completion(r)
                  return (
                    <Link key={r.id} to={`/releases/${r.id}`} className="flex items-center justify-between p-2.5 rounded-lg hover:bg-gray-50 transition-colors">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-900 truncate">{r.project_name}</p>
                        <p className="text-xs text-gray-400">{formatDate(r.release_date)} · {r.release_type}</p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${comp === 100 ? 'bg-emerald-500' : 'bg-boom-500'}`} style={{ width: `${comp}%` }} />
                        </div>
                        <span className="text-xs font-bold text-gray-400 w-8">{comp}%</span>
                      </div>
                    </Link>
                  )
                })}
              </div>
            )}
          </div>

          {/* Spending by category */}
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Spending by Category</h2>
            {sortedCats.length === 0 ? (
              <p className="text-sm text-gray-400 py-4 text-center">No expenses</p>
            ) : (
              <div className="space-y-2">
                {sortedCats.map(([cat, totals]) => (
                  <div key={cat} className="flex items-center gap-3">
                    <span className="text-xs text-gray-500 w-24 text-right truncate">{cat}</span>
                    <div className="flex-1 h-4 bg-gray-100 rounded overflow-hidden">
                      <div className="h-full bg-boom-500 rounded" style={{ width: `${(catMax(totals) / catMax(sortedCats[0][1])) * 100}%` }} />
                    </div>
                    <span className="text-xs font-bold text-gray-700 min-w-[64px] text-right whitespace-nowrap">{fmtCatTotals(totals)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent deals */}
          {deals.length > 0 && (
            <div className="card p-5">
              <h2 className="text-sm font-semibold text-gray-900 mb-3">Deal History</h2>
              <div className="space-y-2">
                {deals.slice(0, 5).map(d => (
                  <div key={d.id} className="flex items-center justify-between py-2">
                    <div>
                      <p className="text-sm font-medium text-gray-800">{d.stage}</p>
                      {d.ar_rep && <p className="text-xs text-gray-400">Rep: {d.ar_rep}</p>}
                    </div>
                    <span className="text-xs text-gray-400">{formatDate(d.added_date)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Links */}
      {tab === 'links' && (() => {
        // Collect release links from all releases
        const RELEASE_LINK_FIELDS = [
          { key: 'spotify_uri', platform: 'Spotify' },
          { key: 'apple_music_link', platform: 'Apple Music' },
          { key: 'presave_link', platform: 'Presave' },
          { key: 'presave_analytics', platform: 'Presave Analytics' },
          { key: 'ugc_link', platform: 'UGC' },
        ]
        const releaseLinks = []
        releases.forEach(r => {
          RELEASE_LINK_FIELDS.forEach(({ key, platform }) => {
            if (r[key]) {
              releaseLinks.push({
                id: `release-${r.id}-${key}`,
                platform,
                url: r[key],
                label: r.project_name,
                releaseName: r.project_name,
                releaseId: r.id,
              })
            }
          })
        })

        const allLinksCount = links.length + releaseLinks.length

        return (
          <div className="space-y-6">
            {/* Artist Links */}
            <div className="card p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-gray-900">Artist Links ({links.length})</h2>
                <button
                  onClick={() => setShowLinkForm(v => !v)}
                  className="flex items-center gap-1.5 text-xs font-semibold text-boom-600 hover:text-boom-700 transition-colors"
                >
                  <Plus size={13} />
                  Add Link
                </button>
              </div>

              {showLinkForm && (
                <form onSubmit={handleAddLink} className="mb-4 p-3 bg-gray-50 rounded-lg border border-rule space-y-2">
                  <div className="flex items-center gap-2">
                    <select
                      value={linkForm.platform}
                      onChange={e => setLinkForm(f => ({ ...f, platform: e.target.value }))}
                      className="text-xs border border-rule rounded-lg px-2.5 py-2 bg-card text-gray-700"
                    >
                      {PLATFORMS.map(p => <option key={p}>{p}</option>)}
                    </select>
                    <input
                      type="url"
                      value={linkForm.url}
                      onChange={e => setLinkForm(f => ({ ...f, url: e.target.value }))}
                      placeholder="https://..."
                      required
                      autoFocus
                      className="flex-1 text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-boom-500"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={linkForm.label}
                      onChange={e => setLinkForm(f => ({ ...f, label: e.target.value }))}
                      placeholder="Description (optional)"
                      className="flex-1 text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-boom-500"
                    />
                    <button type="submit" className="text-xs font-semibold text-white bg-boom-600 hover:bg-boom-700 px-3 py-2 rounded-lg transition-colors">Save</button>
                    <button type="button" onClick={() => { setShowLinkForm(false); setLinkForm({ platform: 'Spotify', url: '', label: '' }) }} className="text-xs text-gray-400 hover:text-gray-600 px-2 py-2">Cancel</button>
                  </div>
                </form>
              )}

              {links.length === 0 ? (
                <div className="text-center py-6">
                  <Link2 size={24} className="mx-auto mb-2 text-gray-300" />
                  <p className="text-sm text-gray-400">No artist links added yet</p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {links.map(link => (
                    <div key={link.id} className="flex items-center justify-between p-3 rounded-lg border border-divider hover:border-rule transition-colors group">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <span className="text-xs font-semibold text-gray-500 bg-gray-100 px-2.5 py-1 rounded-full flex-shrink-0">{link.platform}</span>
                        <div className="min-w-0 flex-1">
                          <a href={link.url} target="_blank" rel="noreferrer" className="text-sm text-boom-600 hover:text-boom-700 truncate transition-colors flex items-center gap-1">
                            {link.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}
                            <ExternalLink size={11} className="flex-shrink-0" />
                          </a>
                          {link.label && <p className="text-xs text-gray-400 mt-0.5">{link.label}</p>}
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeleteLink(link.id)}
                        className="opacity-0 group-hover:opacity-100 p-1 text-gray-300 hover:text-red-500 transition-all flex-shrink-0"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Release Links */}
            {releaseLinks.length > 0 && (
              <div className="card p-5">
                <h2 className="text-sm font-semibold text-gray-900 mb-4">Release Links ({releaseLinks.length})</h2>
                <div className="space-y-1.5">
                  {releaseLinks.map(link => (
                    <div key={link.id} className="flex items-center p-3 rounded-lg border border-divider hover:border-rule transition-colors">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <span className="text-xs font-semibold text-gray-500 bg-gray-100 px-2.5 py-1 rounded-full flex-shrink-0">{link.platform}</span>
                        <div className="min-w-0 flex-1">
                          <a href={link.url} target="_blank" rel="noreferrer" className="text-sm text-boom-600 hover:text-boom-700 truncate transition-colors flex items-center gap-1">
                            {link.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}
                            <ExternalLink size={11} className="flex-shrink-0" />
                          </a>
                          <p className="text-xs text-gray-400 mt-0.5">
                            <Link to={`/releases/${link.releaseId}`} className="hover:text-boom-600 transition-colors">{link.releaseName}</Link>
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {/* Releases */}
      {tab === 'releases' && (
        <div className="space-y-2">
          {releases.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-12">No releases</p>
          ) : releases.map(r => {
            const comp = completion(r)
            const isPast = r.release_date && isPastLocal(r.release_date)
            const isArchived = !!r.archived
            const isBusy = archivingId === r.id
            return (
              <Link key={r.id} to={`/releases/${r.id}`}
                className={`flex items-center gap-4 p-4 card hover:border-boom-300 transition-all ${isArchived ? 'opacity-60' : ''}`}
              >
                {r.cover_art_url && r.cover_art_url !== 'not_found' ? (
                  <img src={r.cover_art_url} alt="" className="w-12 h-12 rounded-lg object-cover flex-shrink-0" />
                ) : (
                  <div className="w-12 h-12 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                    <Music size={16} className="text-gray-400" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-gray-900 truncate">{r.project_name}</p>
                    {isArchived && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-400 flex-shrink-0">Archived</span>}
                  </div>
                  <p className="text-xs text-gray-400">{formatDate(r.release_date)} · {r.release_type} {r.genre ? `· ${r.genre}` : ''}</p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <div className="w-20 h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${comp === 100 ? 'bg-emerald-500' : 'bg-boom-500'}`} style={{ width: `${comp}%` }} />
                  </div>
                  <span className={`text-xs font-bold w-8 ${comp === 100 ? 'text-emerald-600' : 'text-gray-400'}`}>{comp}%</span>
                  {isPast && <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">Released</span>}
                  <button
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      if (!isBusy) handleArchiveRelease(r.id)
                    }}
                    disabled={isBusy}
                    title={isArchived ? 'Unarchive release' : 'Archive release (use for delayed or never-released)'}
                    className={`p-1.5 rounded-md transition-colors ${
                      isArchived
                        ? 'text-amber-500 hover:bg-amber-50'
                        : 'text-gray-300 hover:text-amber-500 hover:bg-amber-50'
                    } disabled:opacity-40`}
                  >
                    <Archive size={13} />
                  </button>
                </div>
              </Link>
            )
          })}
        </div>
      )}

      {/* Spends — every approved ledger expense on this artist */}
      {tab === 'spends' && (() => {
        const fmtMoney = (v, cur) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(v || 0)
        // Per-currency totals: overall + unpaid slice.
        const totals = {}
        const unpaidTotals = {}
        expenses.forEach(e => {
          const cur = (e.currency || 'USD').toUpperCase()
          const amt = parseFloat(e.amount || 0)
          totals[cur] = (totals[cur] || 0) + amt
          if (e.payment_status !== 'Paid') unpaidTotals[cur] = (unpaidTotals[cur] || 0) + amt
        })
        const fmtTotals = (map) => {
          const parts = Object.entries(map).filter(([, v]) => v)
          if (!parts.length) return fmtMoney(0)
          parts.sort(([a], [b]) => a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b))
          return parts.map(([cur, amt]) => fmtMoney(amt, cur)).join(' + ')
        }
        const PAID_STYLES = {
          Paid: 'bg-emerald-100 text-emerald-800',
          Unpaid: 'bg-red-100 text-red-800',
          Partial: 'bg-yellow-100 text-yellow-800',
        }
        return (
          <div className="space-y-4">
            {/* Summary strip */}
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              <div className="card px-4 py-3">
                <p className="text-[10px] font-extrabold uppercase tracking-wider text-gray-400 mb-1">Total spend</p>
                <p className="text-lg font-black text-gray-900 tabular-nums">{fmtTotals(totals)}</p>
                <p className="text-[11px] text-gray-400">{expenses.length} expense{expenses.length === 1 ? '' : 's'}</p>
              </div>
              <div className="card px-4 py-3">
                <p className="text-[10px] font-extrabold uppercase tracking-wider text-gray-400 mb-1">Unpaid</p>
                <p className={`text-lg font-black tabular-nums ${Object.keys(unpaidTotals).length ? 'text-red-600' : 'text-gray-900'}`}>{fmtTotals(unpaidTotals)}</p>
                <p className="text-[11px] text-gray-400">{expenses.filter(e => e.payment_status !== 'Paid').length} open</p>
              </div>
              <div className="card px-4 py-3 col-span-2 lg:col-span-1">
                <p className="text-[10px] font-extrabold uppercase tracking-wider text-gray-400 mb-1">Top category</p>
                <p className="text-lg font-black text-gray-900 truncate">{sortedCats[0]?.[0] || '—'}</p>
                <p className="text-[11px] text-gray-400">{sortedCats[0] ? fmtCatTotals(sortedCats[0][1]) : 'no spend yet'}</p>
              </div>
            </div>

            {/* Expense table */}
            {expenses.length === 0 ? (
              <div className="card p-10 text-center text-sm text-gray-400">No expenses on this artist yet.</div>
            ) : (
              <div className="card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-xs">
                    <thead>
                      <tr className="bg-gray-50 border-b border-rule text-left">
                        <th className="px-4 py-2.5 font-bold text-gray-500 uppercase tracking-wider text-[10px]">Date</th>
                        <th className="px-3 py-2.5 font-bold text-gray-500 uppercase tracking-wider text-[10px]">Payee</th>
                        <th className="px-3 py-2.5 font-bold text-gray-500 uppercase tracking-wider text-[10px]">Song</th>
                        <th className="px-3 py-2.5 font-bold text-gray-500 uppercase tracking-wider text-[10px]">Category</th>
                        <th className="px-3 py-2.5 font-bold text-gray-500 uppercase tracking-wider text-[10px] text-right">Amount</th>
                        <th className="px-3 py-2.5 font-bold text-gray-500 uppercase tracking-wider text-[10px]">Status</th>
                        <th className="px-4 py-2.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {expenses.map(e => (
                        <tr key={e.id} className="border-b border-gray-50 last:border-b-0 hover:bg-gray-50/60">
                          <td className="px-4 py-2 whitespace-nowrap text-gray-600">{e.invoice_date ? String(e.invoice_date).slice(0, 10) : '—'}</td>
                          <td className="px-3 py-2 font-bold text-gray-900 truncate max-w-[180px]" title={e.description || ''}>{e.payee || '—'}</td>
                          <td className="px-3 py-2 text-gray-600 truncate max-w-[160px]">{e.song || '—'}</td>
                          <td className="px-3 py-2 text-gray-600">{e.category || '—'}</td>
                          <td className="px-3 py-2 text-right font-bold tabular-nums whitespace-nowrap">{fmtMoney(e.amount, e.currency)}</td>
                          <td className="px-3 py-2">
                            <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold ${PAID_STYLES[e.payment_status] || PAID_STYLES.Unpaid}`}>
                              {e.payment_status || 'Unpaid'}
                            </span>
                            {e.recoupable && (
                              <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold bg-violet-100 text-violet-800 ml-1">Recoup</span>
                            )}
                            {e.cobrand && (
                              <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800 ml-1">Cobrand</span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-right">
                            {canView('/bk/ledger') && (
                              <Link
                                to={`/bk/ledger?focus=${e.id}`}
                                className="text-[11px] font-bold text-boom-600 hover:text-boom-700 whitespace-nowrap"
                                title="Open in the Ledger"
                              >
                                Ledger →
                              </Link>
                            )}
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
      })()}

      {/* Development log */}
      {tab === 'devlog' && (
        <DevLogTab
          artistId={id}
          user={user}
          isAdmin={isAdmin}
          entries={devlog}
          setEntries={setDevlog}
        />
      )}

      {/* Contracts — visibility mirrors the standalone Contracts page
          (canView('/contracts')). Each contract row embeds a FilesPanel
          so the user can preview / download the actual contract
          document right from the artist page instead of bouncing to
          /contracts. Same component + entityType the main Contracts
          page uses, so the file list stays in sync. */}
      {tab === 'contracts' && canView('/contracts') && (
        <div className="space-y-2">
          {contracts.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-12">No contracts</p>
          ) : contracts.map(c => (
            <div key={c.id} className="card overflow-hidden">
              <div className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{c.type}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {formatDate(c.date_signed)} - {formatDate(c.expiration_date)}
                      {c.territory ? ` · ${c.territory}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                      c.status === 'Active' ? 'bg-emerald-100 text-emerald-700' :
                      c.status === 'Expired' ? 'bg-gray-100 text-gray-500' : 'bg-amber-100 text-amber-700'
                    }`}>{c.status}</span>
                    {c.royalty_split && <span className="text-xs text-gray-500">{c.royalty_split}</span>}
                    {c.advance && <span className="text-xs font-bold text-gray-700">{c.advance}</span>}
                  </div>
                </div>
                {c.notes && <p className="text-xs text-gray-400 mt-2">{c.notes}</p>}
              </div>
              {/* Documents — same FilesPanel + entityType the standalone
                  Contracts page uses. Renders an upload affordance for
                  admins and view/download for everyone else. */}
              <div className="border-t border-divider">
                <FilesPanel
                  entityType="contract"
                  entityId={c.id}
                  basePath="/contracts"
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Documents — non-contract attachments for this artist (riders,
          IDs, photos, demos, etc.) backed by entity_files. Same drag-
          and-drop FilesPanel that contracts use, just scoped to the
          artist entity instead. */}
      {/* Budget — the simple sheet's lines, read-only, and the way to the sheet */}
      {tab === 'budget' && canView('/artist-budgets') && (
        <div className="card p-5" data-tab="budget">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><Wallet size={15} className="text-gray-400" /> Budget</h3>
              <p className="text-[11px] text-gray-500 mt-0.5">Advance and marketing totals, the releases under marketing, and what the ledger has paid against each.</p>
            </div>
            <Link to={`/artist-budgets/${encodeURIComponent(artistKey)}?name=${encodeURIComponent(data.name)}`}
              className="btn-primary text-[12px] px-3 py-1.5 inline-flex items-center gap-1.5 whitespace-nowrap" data-open="budget">
              Open the sheet <ArrowRight size={12} />
            </Link>
          </div>
          {sheet === null && <p className="text-sm text-gray-400 py-6 text-center">Loading…</p>}
          {sheet === false && <p className="text-sm text-gray-400 py-6 text-center">The budget sheet is not available to your account.</p>}
          {sheet && (
            <table className="w-full text-[13px]">
              <thead><tr className="text-[10px] font-bold uppercase tracking-wider text-gray-400 border-b border-divider">
                <th className="text-left py-1.5">&nbsp;</th><th className="text-right py-1.5 w-32">Budget</th><th className="text-right py-1.5 w-32">Spent</th><th className="text-right py-1.5 w-32">Left</th>
              </tr></thead>
              <tbody className="tabular-nums">
                <tr className="border-b border-divider"><td className="py-2 font-semibold text-ink">Advance</td><td className="text-right">{sheet.advance.budget ? usd0(sheet.advance.budget) : '—'}</td><td className="text-right">{sheet.advance.spent ? usd0(sheet.advance.spent) : '—'}</td><td className={`text-right ${sheet.advance.left < 0 ? 'text-rose-600' : ''}`}>{sheet.advance.budget ? usd0(sheet.advance.left) : '—'}</td></tr>
                <tr className="border-b border-divider bg-gray-50/60"><td className="py-2 font-semibold text-ink">Total marketing</td><td className="text-right">{sheet.marketing.budget ? usd0(sheet.marketing.budget) : '—'}</td><td className="text-right">{sheet.marketing.spent ? usd0(sheet.marketing.spent) : '—'}</td><td className={`text-right ${sheet.marketing.left < 0 ? 'text-rose-600' : ''}`}>{sheet.marketing.budget ? usd0(sheet.marketing.left) : '—'}</td></tr>
                {sheet.marketing.releases.map((r) => (
                  <tr key={r.release_id} className="border-b border-divider"><td className="py-1.5 pl-5 text-gray-700">{r.title}</td><td className="text-right">{r.budget ? usd0(r.budget) : '—'}</td><td className="text-right">{r.spent ? usd0(r.spent) : '—'}</td><td className={`text-right ${r.left < 0 ? 'text-rose-600' : ''}`}>{r.budget ? usd0(r.left) : '—'}</td></tr>
                ))}
                <tr className="border-b border-divider"><td className="py-2 text-gray-600">Other spend</td><td className="text-right text-gray-400">—</td><td className="text-right">{sheet.other.spent ? usd0(sheet.other.spent) : '—'}</td><td className="text-right text-gray-400">—</td></tr>
                <tr className="font-bold"><td className="py-2">Total</td><td className="text-right">{sheet.totals.budget ? usd0(sheet.totals.budget) : '—'}</td><td className="text-right">{sheet.totals.spent ? usd0(sheet.totals.spent) : '—'}</td><td className={`text-right ${sheet.totals.left < 0 ? 'text-rose-600' : ''}`}>{sheet.totals.budget ? usd0(sheet.totals.left) : '—'}</td></tr>
              </tbody>
            </table>
          )}
          {sheet && !sheet.totals.sheet && !sheet.totals.spent && (
            <p className="text-[12px] text-gray-500 mt-3 text-center">Nothing budgeted or spent yet. Open the sheet and type the advance and the marketing total.</p>
          )}
        </div>
      )}

      {/* Recoupments — what this artist owes back, on the page built to prove it */}
      {tab === 'recoupments' && canView('/recoupments') && (
        <div className="card p-5" data-tab="recoupments">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><PiggyBank size={15} className="text-gray-400" /> Recoupments</h3>
              <p className="text-[11px] text-gray-500 mt-0.5 max-w-lg">
                Every recoupable cost on {data.name}, in the four bank states — confirmed on a statement, paid but not yet confirmed, paid with no bank line, unpaid — and which have been uploaded for recoupment. The full page carries the upload controls.
              </p>
            </div>
            <Link to={`/recoupments/${encodeURIComponent(data.name)}`}
              className="btn-primary text-[12px] px-3 py-1.5 inline-flex items-center gap-1.5 whitespace-nowrap" data-open="recoupments">
              Open on Recoupments <ArrowRight size={12} />
            </Link>
          </div>
        </div>
      )}

      {/* Campaigns — settled and committed marketing, from the campaigns page's own rollup */}
      {tab === 'campaigns' && canView('/artist-campaigns') && (
        <div className="card p-5" data-tab="campaigns">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><Megaphone size={15} className="text-gray-400" /> Campaigns</h3>
              <p className="text-[11px] text-gray-500 mt-0.5">Marketing and advertising on {data.name}: what the bank has settled, and what is committed on invoices not yet paid.</p>
            </div>
            <Link to={`/artist-campaigns/${encodeURIComponent(data.name)}`}
              className="btn-primary text-[12px] px-3 py-1.5 inline-flex items-center gap-1.5 whitespace-nowrap" data-open="campaigns">
              Open on Campaigns <ArrowRight size={12} />
            </Link>
          </div>
          {campaign === null && <p className="text-sm text-gray-400 py-4 text-center">Loading…</p>}
          {campaign === false && <p className="text-[12px] text-gray-500 py-4 text-center">No campaign spend on {data.name} yet. It appears here as marketing invoices are approved and statements matched.</p>}
          {campaign && (
            <div className="grid grid-cols-3 gap-3 tabular-nums">
              <div><p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Settled</p><p className="text-[15px] font-bold text-ink">{usd0(campaign.settled)}</p></div>
              <div><p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Committed</p><p className="text-[15px] font-bold text-ink">{usd0(campaign.committed)}</p><p className="text-[10px] text-gray-400">{campaign.committed_count || 0} invoice{campaign.committed_count === 1 ? '' : 's'}</p></div>
              <div><p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Planned</p><p className="text-[15px] font-bold text-ink">{campaign.planned_budget ? usd0(campaign.planned_budget) : '—'}</p></div>
            </div>
          )}
        </div>
      )}

      {tab === 'documents' && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-divider">
            <h3 className="text-sm font-semibold text-gray-900">Documents</h3>
            <p className="text-[11px] text-gray-500 mt-0.5">
              Anything not a contract — riders, IDs, photos, demos, mood boards. Drag a
              file into the area below or click to browse.
            </p>
          </div>
          <FilesPanel
            entityType="artist"
            entityId={id}
            basePath="/artists"
            onCountChange={setDocCount}
          />
        </div>
      )}
    </div>
  )
}
