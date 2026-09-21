import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom'
import { ChevronLeft, ExternalLink, Check, Send, Trash2, Pencil, X, Save, Archive } from 'lucide-react'
import api from '../api'
import { useAuth } from '../context/AuthContext'
import { formatDate } from '../utils'
import Breadcrumb from '../components/Breadcrumb'

const GENRE_OPTIONS = ['Hip-Hop', 'EDM', 'Pop', 'Alt', 'R&B', 'Electronic', 'Hip Hop/Rap', 'Hip-Hop/Rap', 'Latin']
const TYPE_OPTIONS  = ['single', 'EP', 'album']
const PRIORITY_OPTIONS = ['standard', 'priority', 'high priority']
const COVER_ART_OPTIONS = ['Pending', 'In Progress', 'Done']

const CHECKLIST_ITEMS = [
  { key: 'yt_video',        label: 'YT Video',        group: 'Content' },
  { key: 'content',         label: 'Content',          group: 'Content' },
  { key: 'marketing_plan',  label: 'Marketing Plan',   group: 'Content' },
  { key: 'official_thread', label: 'Official Thread',  group: 'Content' },
  { key: 'uploaded',        label: 'Uploaded',         group: 'Distribution' },
  { key: 'recoup_added',    label: 'Recoup Added',     group: 'Distribution' },
  { key: 'budget',          label: 'Budget',           group: 'Distribution' },
  { key: 'stem_pitch',      label: 'Stem Pitch',       group: 'Pitching' },
  { key: 's4a_pitch',       label: 'S4A Pitch',        group: 'Pitching' },
  { key: 'amazon_pitch',    label: 'Amazon Pitch',     group: 'Pitching' },
  { key: 'pandora',         label: 'Pandora',          group: 'Pitching' },
  { key: 'marquee',         label: 'Marquee',          group: 'Pitching' },
  { key: 'dsp_email',       label: 'DSP Email',        group: 'Pitching' },
  { key: 'musixmatch',      label: 'Musixmatch',       group: 'Pitching' },
]
const CHECKLIST_GROUPS = ['Content', 'Distribution', 'Pitching']

const PRIORITY_STYLES = {
  'high priority': 'bg-red-50 text-red-600 border-red-200',
  'priority':      'bg-amber-50 text-amber-600 border-amber-200',
  'standard':      'bg-gray-100 text-gray-500 border-rule',
}

export default function ReleaseDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { user: currentUser } = useAuth()

  const fromCatalog = location.state?.from === 'catalog'

  const [release, setRelease]           = useState(null)
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState('')

  // Sidebar editing state
  const [sidebarEditing, setSidebarEditing] = useState(false)
  const [sidebarDraft, setSidebarDraft]     = useState({})
  const [savingSidebar, setSavingSidebar]   = useState(false)

  const [comments, setComments]         = useState([])
  const [commentsLoading, setCommentsLoading] = useState(true)
  const [newComment, setNewComment]     = useState('')
  const [savingComment, setSavingComment] = useState(false)

  const [activity, setActivity]         = useState([])
  const [activityLoading, setActivityLoading] = useState(true)

  const [budgetItems, setBudgetItems]   = useState([])
  const [budgetCap, setBudgetCap]       = useState(null)
  const [budgetLoading, setBudgetLoading] = useState(true)

  const [activeTab, setActiveTab]       = useState('checklist')
  const [archiving, setArchiving]       = useState(false)

  const handleArchive = async () => {
    setArchiving(true)
    try {
      const res = await api.put(`/releases/${id}/archive`)
      const { archived } = res.data.data
      setRelease(prev => prev ? { ...prev, archived } : prev)
    } catch (err) {
      alert('Failed to archive release')
    } finally {
      setArchiving(false)
    }
  }

  useEffect(() => {
    fetchRelease()
    fetchComments()
    fetchActivity()
    fetchBudget()
  }, [id])

  const fetchRelease = async () => {
    try {
      setLoading(true)
      const res = await api.get(`/releases/${id}`)
      setRelease(res.data.data)
    } catch {
      setError('Release not found')
    } finally {
      setLoading(false)
    }
  }

  const fetchComments = async () => {
    try {
      const res = await api.get(`/releases/${id}/comments`)
      setComments(res.data.data || [])
    } catch {} finally { setCommentsLoading(false) }
  }

  const fetchActivity = async () => {
    try {
      // Fetch both audit trail and general activity
      const [auditRes, actRes] = await Promise.all([
        api.get(`/releases/${id}/audit`).catch(() => ({ data: { data: [] } })),
        api.get(`/releases/${id}/activity`).catch(() => ({ data: { data: [] } })),
      ])
      // Merge and sort by timestamp desc
      const audit = (auditRes.data.data || []).map(a => ({
        id: `audit-${a.id}`,
        user_name: a.user_name,
        detail: a.action === 'checklist'
          ? `${a.new_value === 'checked' ? 'Checked' : 'Unchecked'} "${a.field}"`
          : a.field
            ? `Changed ${a.field.replace(/_/g, ' ')}${a.old_value ? ` from "${a.old_value}"` : ''} to "${a.new_value}"`
            : a.details || a.action,
        created_at: a.ts,
        type: 'audit',
      }))
      const general = (actRes.data.data || []).map(a => ({
        id: `act-${a.id}`,
        user_name: a.user_name,
        detail: a.detail,
        created_at: a.created_at,
        type: 'activity',
      }))
      const merged = [...audit, ...general].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      setActivity(merged)
    } catch {} finally { setActivityLoading(false) }
  }

  const fetchBudget = async () => {
    try {
      const res = await api.get(`/releases/${id}/budget-items`)
      setBudgetItems(res.data.data?.items || [])
      setBudgetCap(res.data.data?.budget_cap ?? null)
    } catch {} finally { setBudgetLoading(false) }
  }

  const handleChecklistToggle = async (key) => {
    if (!release) return
    const updated = { ...release, [key]: !release[key] }
    setRelease(updated)
    try {
      const payload = {}
      CHECKLIST_ITEMS.forEach(i => { payload[i.key] = updated[i.key] || false })
      const res = await api.put(`/releases/${id}/checklist`, payload)
      setRelease(prev => ({ ...prev, ...res.data.data }))
    } catch {
      setRelease(prev => ({ ...prev, [key]: !updated[key] }))
    }
  }

  const handlePostComment = async (e) => {
    e.preventDefault()
    if (!newComment.trim()) return
    setSavingComment(true)
    try {
      const res = await api.post(`/releases/${id}/comments`, { text: newComment.trim() })
      setComments(prev => [...prev, res.data.data])
      setNewComment('')
    } catch {} finally { setSavingComment(false) }
  }

  const handleDeleteComment = async (commentId) => {
    if (!window.confirm('Delete this comment?')) return
    try {
      await api.delete(`/releases/${id}/comments/${commentId}`)
      setComments(prev => prev.filter(c => c.id !== commentId))
    } catch {}
  }

  const startSidebarEdit = () => {
    if (!release) return
    setSidebarDraft({
      // Core fields
      project_name:      release.project_name || '',
      artist_name:       release.artist_name || '',
      release_date:      release.release_date ? release.release_date.split('T')[0] : '',
      release_type:      release.release_type || '',
      genre:             release.genre || '',
      subgenre:          release.subgenre || '',
      priority:          release.priority || 'standard',
      cover_art_status:  release.cover_art_status || '',
      // Metadata fields
      upc:               release.upc || '',
      isrc:              release.isrc || '',
      apple_id:          release.apple_id || '',
      producer:          release.producer || '',
      featured_artists:  release.featured_artists || '',
      // Link fields
      spotify_uri:       release.spotify_uri || '',
      apple_music_link:  release.apple_music_link || '',
      presave_link:      release.presave_link || '',
      ugc_link:          release.ugc_link || '',
      // Notes
      notes:             release.notes || '',
      distributor_notes: release.distributor_notes || '',
    })
    setSidebarEditing(true)
  }

  const cancelSidebarEdit = () => {
    setSidebarEditing(false)
    setSidebarDraft({})
  }

  const saveSidebarEdit = async () => {
    setSavingSidebar(true)
    try {
      // Core fields go to PUT /:id
      const corePayload = {
        // Blank title → null so the server's COALESCE keeps the current
        // name; a release can be renamed but never accidentally blanked.
        project_name: (sidebarDraft.project_name || '').trim() || null,
        artist_name:  sidebarDraft.artist_name,
        release_date: sidebarDraft.release_date,
        release_type: sidebarDraft.release_type,
        genre:        sidebarDraft.genre,
        subgenre:     sidebarDraft.subgenre,
        priority:     sidebarDraft.priority,
      }
      // Metadata/links/notes fields go to PUT /:id/metadata
      const metaPayload = {
        cover_art_status:  sidebarDraft.cover_art_status,
        upc:               sidebarDraft.upc,
        isrc:              sidebarDraft.isrc,
        apple_id:          sidebarDraft.apple_id,
        producer:          sidebarDraft.producer,
        featured_artists:  sidebarDraft.featured_artists,
        spotify_uri:       sidebarDraft.spotify_uri,
        apple_music_link:  sidebarDraft.apple_music_link,
        presave_link:      sidebarDraft.presave_link,
        ugc_link:          sidebarDraft.ugc_link,
        notes:             sidebarDraft.notes,
        distributor_notes: sidebarDraft.distributor_notes,
      }
      const [coreRes] = await Promise.all([
        api.put(`/releases/${id}`, corePayload),
        api.put(`/releases/${id}/metadata`, metaPayload),
      ])
      // Merge updates: core res returns artist_name etc; re-fetch for full data
      const full = await api.get(`/releases/${id}`)
      setRelease(full.data.data)
      setSidebarEditing(false)
      setSidebarDraft({})
    } catch {
      alert('Failed to save changes')
    } finally {
      setSavingSidebar(false)
    }
  }

  const draftField = (field, value) => setSidebarDraft(prev => ({ ...prev, [field]: value }))

  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <div className="w-8 h-8 border-2 border-boom-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (error || !release) return (
    <div className="text-center py-24">
      <p className="text-sm text-gray-500">{error || 'Release not found'}</p>
      <button onClick={() => navigate('/releases')} className="mt-4 text-sm text-boom-600 hover:text-boom-700">
        ← Back to releases
      </button>
    </div>
  )

  const checklistItems = CHECKLIST_ITEMS.map(i => ({ ...i, done: !!release[i.key] }))
  const totalDone = checklistItems.filter(i => i.done).length
  const completion = Math.round((totalDone / checklistItems.length) * 100)

  const daysUntil = release.release_date
    ? Math.ceil((new Date(release.release_date) - new Date()) / 86400000)
    : null
  const isPast    = daysUntil !== null && daysUntil < 0
  const isUrgent  = daysUntil !== null && !isPast && daysUntil <= 7

  const budgetTotal = budgetItems.reduce((s, i) => s + parseFloat(i.amount || 0), 0)

  return (
    <div data-tour="release-page">
      <Breadcrumb items={[
        { label: 'Releases', path: fromCatalog ? '/catalog' : '/releases' },
        { label: release.artist_name, path: `/artists/${release.artist_id}` },
        { label: release.project_name },
      ]} />

      {/* Header */}
      <div className="flex items-start justify-between gap-6 mb-8">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap mb-1.5">
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">{release.project_name}</h1>
            {release.priority && (
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${PRIORITY_STYLES[release.priority] || PRIORITY_STYLES.standard}`}>
                {release.priority}
              </span>
            )}
            {release.release_type && (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-rule">
                {release.release_type}
              </span>
            )}
            {release.archived && (
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-400">Archived</span>
            )}
          </div>
          <div className="flex items-center gap-2.5 text-sm">
            <Link to="/artists" className="font-semibold text-gray-700 hover:text-boom-600 transition-colors">
              {release.artist_name}
            </Link>
            {release.release_date && (
              <>
                <span className="text-gray-300">·</span>
                <span className={`text-sm ${isUrgent ? 'text-red-500 font-semibold' : 'text-gray-500'}`}>
                  {formatDate(release.release_date)}
                  {daysUntil !== null && (
                    <span className="ml-1.5 text-xs font-normal text-gray-400">
                      {isPast ? `(${Math.abs(daysUntil)}d ago)` : daysUntil === 0 ? '(Today)' : `(${daysUntil}d)`}
                    </span>
                  )}
                </span>
              </>
            )}
            {release.assigned_to_name && (
              <>
                <span className="text-gray-300">·</span>
                <span className="text-sm text-gray-500">
                  <span className="text-gray-400">assigned to </span>
                  <Link to={`/team`} className="font-medium text-gray-600 hover:text-boom-600 transition-colors">
                    {release.assigned_to_name}
                  </Link>
                </span>
              </>
            )}
          </div>
        </div>

        {/* Completion */}
        <div className="flex-shrink-0 text-right">
          <p className={`text-2xl font-bold tracking-tight ${completion === 100 ? 'text-emerald-500' : 'text-gray-800'}`}>
            {completion}%
          </p>
          <div className="w-24 h-1 bg-gray-100 rounded-full overflow-hidden mt-2 mb-1.5">
            <div
              className={`h-full rounded-full transition-all duration-500 ${completion === 100 ? 'bg-emerald-500' : 'bg-boom-500'}`}
              style={{ width: `${completion}%` }}
            />
          </div>
          <p className="text-[10px] text-gray-400">{totalDone} of {checklistItems.length} done</p>
        </div>
      </div>

      {/* Body */}
      <div className="grid gap-8" style={{ gridTemplateColumns: '1fr 296px' }}>

        {/* Left: tabs */}
        <div>
          <div className="flex gap-0 border-b border-gray-150 mb-6" style={{ borderColor: '#e8e8e8' }}>
            {[
              { key: 'checklist', label: 'Checklist' },
              { key: 'comments',  label: comments.length ? `Comments (${comments.length})` : 'Comments' },
              { key: 'budget',    label: 'Budget' },
              { key: 'activity',  label: 'History' },
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`text-xs font-medium px-4 py-2.5 -mb-px transition-colors ${
                  activeTab === tab.key
                    ? 'text-boom-600 border-b-2 border-boom-500'
                    : 'text-gray-400 border-b-2 border-transparent hover:text-gray-600'
                }`}
              >{tab.label}</button>
            ))}
          </div>

          {/* ── Checklist ── */}
          {activeTab === 'checklist' && (
            <div className="space-y-6">
              {CHECKLIST_GROUPS.map(group => {
                const items = checklistItems.filter(i => i.group === group)
                const groupDone = items.filter(i => i.done).length
                return (
                  <div key={group}>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{group}</p>
                      <span className="text-[10px] text-gray-400">{groupDone}/{items.length}</span>
                    </div>
                    <div className="bg-card border border-divider rounded-2xl overflow-hidden">
                      {items.map((item, idx) => (
                        <button
                          key={item.key}
                          onClick={() => handleChecklistToggle(item.key)}
                          className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                            idx < items.length - 1 ? 'border-b border-gray-50' : ''
                          } ${item.done ? '' : 'hover:bg-gray-50/70'}`}
                        >
                          <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 transition-all ${
                            item.done ? 'bg-emerald-500' : 'border-2 border-rule bg-card'
                          }`}>
                            {item.done && <Check size={10} strokeWidth={3} className="text-white" />}
                          </div>
                          <span className={`text-sm transition-colors ${
                            item.done ? 'text-gray-400 line-through decoration-gray-300' : 'text-gray-700'
                          }`}>
                            {item.label}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* ── Comments ── */}
          {activeTab === 'comments' && (
            <div className="space-y-4">
              {commentsLoading ? (
                <div className="flex justify-center py-10">
                  <div className="w-5 h-5 border-2 border-boom-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : comments.length === 0 ? (
                <p className="text-center text-sm text-gray-300 py-10">No comments yet</p>
              ) : (
                <div className="space-y-4">
                  {comments.map(c => (
                    <div key={c.id} className="flex gap-3 group">
                      <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0 text-[11px] font-bold text-gray-500 mt-0.5">
                        {c.user_name?.charAt(0)?.toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 mb-0.5">
                          <span className="text-xs font-semibold text-gray-800">{c.user_name}</span>
                          <span className="text-[10px] text-gray-400" title={new Date(c.created_at).toLocaleString()}>
                            {(() => {
                              const diff = Date.now() - new Date(c.created_at).getTime()
                              const mins = Math.floor(diff / 60000)
                              if (mins < 1) return 'just now'
                              if (mins < 60) return `${mins}m ago`
                              const hrs = Math.floor(mins / 60)
                              if (hrs < 24) return `${hrs}h ago`
                              const days = Math.floor(hrs / 24)
                              if (days < 7) return `${days}d ago`
                              return formatDate(c.created_at)
                            })()}
                          </span>
                        </div>
                        <p className="text-sm text-gray-700 leading-relaxed">{c.text || c.body}</p>
                      </div>
                      {(c.user_id === currentUser?.id || currentUser?.hierarchy_level <= 2) && (
                        <button
                          onClick={() => handleDeleteComment(c.id)}
                          className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-all flex-shrink-0 mt-1"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <form onSubmit={handlePostComment} className="flex gap-2 pt-2 border-t border-divider">
                <input
                  type="text"
                  placeholder="Add a comment…"
                  value={newComment}
                  onChange={e => setNewComment(e.target.value)}
                  className="flex-1 text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-boom-400 placeholder:text-gray-300"
                />
                <button
                  type="submit"
                  disabled={savingComment || !newComment.trim()}
                  className="flex items-center justify-center w-9 h-9 text-white bg-boom-600 hover:bg-boom-700 disabled:opacity-40 rounded-lg transition-colors flex-shrink-0"
                >
                  <Send size={13} />
                </button>
              </form>
            </div>
          )}

          {/* ── Budget ── */}
          {activeTab === 'budget' && (
            <div>
              {budgetLoading ? (
                <div className="flex justify-center py-10">
                  <div className="w-5 h-5 border-2 border-boom-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : (
                <div className="space-y-2">
                  {budgetCap !== null && (
                    <div className="flex items-center justify-between px-4 py-3 bg-gray-50 rounded-xl border border-divider mb-4">
                      <span className="text-xs font-semibold text-gray-500">Budget Cap</span>
                      <span className="text-sm font-bold text-gray-800">
                        ${parseFloat(budgetCap).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                  )}
                  {budgetItems.length === 0 ? (
                    <p className="text-center text-sm text-gray-300 py-10">No budget items</p>
                  ) : (
                    <>
                      {budgetItems.map(item => (
                        <div key={item.id} className="flex items-center gap-3 px-4 py-2.5 bg-card border border-divider rounded-xl">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-700">{item.description || item.category}</p>
                            {item.description && <p className="text-[10px] text-gray-400">{item.category}</p>}
                          </div>
                          <span className="text-sm font-semibold text-gray-700">
                            ${parseFloat(item.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                          </span>
                        </div>
                      ))}
                      <div className={`flex items-center justify-between px-4 py-3 rounded-xl border mt-2 ${
                        budgetCap !== null && budgetTotal > budgetCap
                          ? 'bg-red-50 border-red-200'
                          : 'bg-gray-50 border-divider'
                      }`}>
                        <span className="text-xs font-bold text-gray-600">Total</span>
                        <span className={`text-sm font-bold ${
                          budgetCap !== null && budgetTotal > budgetCap ? 'text-red-600' : 'text-gray-800'
                        }`}>
                          ${budgetTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                          {budgetCap !== null && (
                            <span className="text-[11px] font-medium text-gray-400 ml-1.5">
                              / ${parseFloat(budgetCap).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                            </span>
                          )}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Activity ── */}
          {activeTab === 'activity' && (
            <div>
              {activityLoading ? (
                <div className="flex justify-center py-10">
                  <div className="w-5 h-5 border-2 border-boom-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : activity.length === 0 ? (
                <p className="text-center text-sm text-gray-300 py-10">No activity yet</p>
              ) : (
                <div className="relative pl-6">
                  {/* Timeline line */}
                  <div className="absolute left-[7px] top-2 bottom-2 w-px bg-gray-200" />
                  <div className="space-y-4">
                    {activity.map(a => {
                      const diff = Date.now() - new Date(a.created_at).getTime()
                      const mins = Math.floor(diff / 60000)
                      const timeAgo = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins/60)}h ago` : `${Math.floor(mins/1440)}d ago`
                      return (
                        <div key={a.id} className="relative flex items-start gap-3">
                          <div className={`absolute -left-6 mt-1.5 w-3.5 h-3.5 rounded-full border-2 border-white ${
                            a.type === 'audit' ? 'bg-boom-500' : 'bg-gray-300'
                          }`} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-gray-700 leading-snug">
                              <span className="font-semibold text-gray-900">{a.user_name}</span>{' '}
                              {a.detail}
                            </p>
                            <p className="text-[10px] text-gray-400 mt-0.5" title={new Date(a.created_at).toLocaleString()}>
                              {timeAgo}
                            </p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: info sidebar */}
        <div className="space-y-3">

          {/* Edit / Save / Cancel controls */}
          <div className="flex items-center justify-end gap-2">
            {sidebarEditing ? (
              <>
                <button
                  onClick={cancelSidebarEdit}
                  disabled={savingSidebar}
                  className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 px-3 py-1.5 rounded-lg border border-rule bg-card transition-colors disabled:opacity-40"
                >
                  <X size={12} /> Cancel
                </button>
                <button
                  onClick={saveSidebarEdit}
                  disabled={savingSidebar}
                  className="flex items-center gap-1.5 text-xs text-white bg-boom-600 hover:bg-boom-700 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
                >
                  {savingSidebar ? (
                    <span className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Save size={12} />
                  )}
                  Save
                </button>
              </>
            ) : (
              <button
                onClick={startSidebarEdit}
                className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 px-3 py-1.5 rounded-lg border border-rule bg-card transition-colors"
              >
                <Pencil size={12} /> Edit
              </button>
            )}
          </div>

          {/* Core details */}
          <div className="bg-card border border-divider rounded-2xl p-4">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider pb-2.5 mb-3 border-b border-gray-50">Details</p>
            {sidebarEditing ? (
              <div className="space-y-2.5">
                <SidebarField label="Title">
                  <input className={inputCls} value={sidebarDraft.project_name} onChange={e => draftField('project_name', e.target.value)} />
                </SidebarField>
                <SidebarField label="Artist">
                  <input className={inputCls} value={sidebarDraft.artist_name} onChange={e => draftField('artist_name', e.target.value)} />
                </SidebarField>
                <SidebarField label="Date">
                  <input type="date" className={inputCls} value={sidebarDraft.release_date} onChange={e => draftField('release_date', e.target.value)} />
                </SidebarField>
                <SidebarField label="Type">
                  <select className={inputCls} value={sidebarDraft.release_type} onChange={e => draftField('release_type', e.target.value)}>
                    <option value="">—</option>
                    {TYPE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </SidebarField>
                <SidebarField label="Genre">
                  <select className={inputCls} value={sidebarDraft.genre} onChange={e => draftField('genre', e.target.value)}>
                    <option value="">—</option>
                    {GENRE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </SidebarField>
                <SidebarField label="Subgenre">
                  <input className={inputCls} value={sidebarDraft.subgenre} onChange={e => draftField('subgenre', e.target.value)} />
                </SidebarField>
                <SidebarField label="Priority">
                  <select className={inputCls} value={sidebarDraft.priority} onChange={e => draftField('priority', e.target.value)}>
                    {PRIORITY_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </SidebarField>
                <SidebarField label="Cover Art">
                  <select className={inputCls} value={sidebarDraft.cover_art_status} onChange={e => draftField('cover_art_status', e.target.value)}>
                    <option value="">—</option>
                    {COVER_ART_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </SidebarField>
              </div>
            ) : (
              <div className="space-y-3">
                {[
                  { label: 'Artist',    value: release.artist_name },
                  { label: 'Date',      value: formatDate(release.release_date) },
                  { label: 'Type',      value: release.release_type },
                  { label: 'Genre',     value: [release.genre, release.subgenre].filter(Boolean).join(' / ') },
                  { label: 'Priority',  value: release.priority },
                  { label: 'Assignee',  value: release.assigned_to_name },
                  { label: 'Cover Art', value: release.cover_art_status },
                ].filter(row => row.value).map(({ label, value }) => (
                  <div key={label} className="flex items-start justify-between gap-3">
                    <span className="text-xs text-gray-400 flex-shrink-0">{label}</span>
                    <span className="text-xs font-medium text-gray-700 text-right">{value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Metadata */}
          {(sidebarEditing || [release.upc, release.isrc, release.apple_id, release.producer, release.featured_artists].some(Boolean)) && (
            <div className="bg-card border border-divider rounded-2xl p-4">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider pb-2.5 mb-3 border-b border-gray-50">Metadata</p>
              {sidebarEditing ? (
                <div className="space-y-2.5">
                  <SidebarField label="UPC">
                    <input className={inputCls} value={sidebarDraft.upc} onChange={e => draftField('upc', e.target.value)} placeholder="—" />
                  </SidebarField>
                  <SidebarField label="ISRC">
                    <input className={inputCls} value={sidebarDraft.isrc} onChange={e => draftField('isrc', e.target.value)} placeholder="—" />
                  </SidebarField>
                  <SidebarField label="Apple ID">
                    <input className={inputCls} value={sidebarDraft.apple_id} onChange={e => draftField('apple_id', e.target.value)} placeholder="—" />
                  </SidebarField>
                  <SidebarField label="Producer">
                    <input className={inputCls} value={sidebarDraft.producer} onChange={e => draftField('producer', e.target.value)} placeholder="—" />
                  </SidebarField>
                  <SidebarField label="Features">
                    <input className={inputCls} value={sidebarDraft.featured_artists} onChange={e => draftField('featured_artists', e.target.value)} placeholder="—" />
                  </SidebarField>
                </div>
              ) : (
                <div className="space-y-3">
                  {[
                    { label: 'UPC',      value: release.upc },
                    { label: 'ISRC',     value: release.isrc },
                    { label: 'Apple ID', value: release.apple_id },
                    { label: 'Producer', value: release.producer },
                    { label: 'Features', value: release.featured_artists },
                  ].filter(r => r.value).map(({ label, value }) => (
                    <div key={label} className="flex items-start justify-between gap-3">
                      <span className="text-xs text-gray-400 flex-shrink-0">{label}</span>
                      <span className="text-xs font-medium text-gray-600 text-right font-mono break-all">{value}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Links */}
          {(sidebarEditing || [release.spotify_uri, release.apple_music_link, release.presave_link, release.ugc_link].some(Boolean)) && (
            <div className="bg-card border border-divider rounded-2xl p-4">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider pb-2.5 mb-3 border-b border-gray-50">Links</p>
              {sidebarEditing ? (
                <div className="space-y-2.5">
                  <SidebarField label="Spotify">
                    <input className={inputCls} value={sidebarDraft.spotify_uri} onChange={e => draftField('spotify_uri', e.target.value)} placeholder="URL or spotify:track:…" />
                  </SidebarField>
                  <SidebarField label="Apple Music">
                    <input className={inputCls} value={sidebarDraft.apple_music_link} onChange={e => draftField('apple_music_link', e.target.value)} placeholder="https://…" />
                  </SidebarField>
                  <SidebarField label="Pre-save">
                    <input className={inputCls} value={sidebarDraft.presave_link} onChange={e => draftField('presave_link', e.target.value)} placeholder="https://…" />
                  </SidebarField>
                  <SidebarField label="UGC">
                    <input className={inputCls} value={sidebarDraft.ugc_link} onChange={e => draftField('ugc_link', e.target.value)} placeholder="https://…" />
                  </SidebarField>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {[
                    { label: 'Spotify',     href: toSpotifyUrl(release.spotify_uri) },
                    { label: 'Apple Music', href: release.apple_music_link },
                    { label: 'Pre-save',    href: release.presave_link },
                    { label: 'UGC',         href: release.ugc_link },
                  ].filter(l => l.href).map(({ label, href }) => (
                    <a
                      key={label}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between px-3 py-2 bg-gray-50 hover:bg-boom-50 border border-divider hover:border-boom-200 rounded-lg transition-all group"
                    >
                      <span className="text-xs font-medium text-gray-600 group-hover:text-boom-700">{label}</span>
                      <ExternalLink size={11} className="text-gray-400 group-hover:text-boom-500" />
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Notes */}
          {(sidebarEditing || release.notes || release.distributor_notes) && (
            <div className="bg-card border border-divider rounded-2xl p-4">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider pb-2.5 mb-3 border-b border-gray-50">Notes</p>
              {sidebarEditing ? (
                <div className="space-y-3">
                  <div>
                    <p className="text-[10px] text-gray-400 mb-1">General</p>
                    <textarea
                      className="w-full text-xs border border-rule rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-boom-400 resize-none"
                      rows={3}
                      value={sidebarDraft.notes}
                      onChange={e => draftField('notes', e.target.value)}
                      placeholder="General notes…"
                    />
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-400 mb-1">Distributor</p>
                    <textarea
                      className="w-full text-xs border border-rule rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-boom-400 resize-none"
                      rows={3}
                      value={sidebarDraft.distributor_notes}
                      onChange={e => draftField('distributor_notes', e.target.value)}
                      placeholder="Distributor notes…"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {release.notes && (
                    <div>
                      <p className="text-[10px] text-gray-400 mb-1">General</p>
                      <p className="text-xs text-gray-600 leading-relaxed">{release.notes}</p>
                    </div>
                  )}
                  {release.distributor_notes && (
                    <div>
                      <p className="text-[10px] text-gray-400 mb-1">Distributor</p>
                      <p className="text-xs text-gray-600 leading-relaxed">{release.distributor_notes}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="bg-card border border-divider rounded-2xl p-4">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider pb-2.5 mb-3 border-b border-gray-50">Actions</p>
            <button
              onClick={handleArchive}
              disabled={archiving}
              title={release.archived ? 'Move this release back into the active pipeline / catalog.' : 'Archive this release — useful for delayed or never-released projects. You can unarchive later.'}
              className={`w-full flex items-center justify-center gap-2 text-xs font-semibold px-3 py-2 rounded-lg border transition-colors disabled:opacity-50 ${
                release.archived
                  ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                  : 'border-rule text-gray-600 hover:border-amber-300 hover:text-amber-600 hover:bg-amber-50'
              }`}
            >
              <Archive size={13} />
              {archiving ? 'Working…' : release.archived ? 'Unarchive' : 'Archive release'}
            </button>
          </div>

        </div>
      </div>
    </div>
  )
}

// Helper component for sidebar edit rows
function SidebarField({ label, children }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-gray-400 w-20 flex-shrink-0">{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

const inputCls = 'w-full text-[11px] border border-rule rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-boom-400 bg-card'

// Convert a Spotify URI or raw ID to a full https:// URL
function toSpotifyUrl(uri) {
  if (!uri) return null
  if (uri.startsWith('http')) return uri
  const match = uri.match(/^spotify:(track|album|playlist|artist):(.+)$/)
  if (match) return `https://open.spotify.com/${match[1]}/${match[2]}`
  return `https://open.spotify.com/track/${uri}`
}
