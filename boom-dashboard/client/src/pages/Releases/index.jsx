import { useState, useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { Link } from 'react-router-dom'
import { Search, X, Plus, Pencil, Save, Calendar, List, User, Archive, Trash2, Clock, Library } from 'lucide-react'
import api from '../../api'
import { formatDate, daysUntilLocal } from '../../utils'
import PageHeader from '../../components/PageHeader'
import Skeleton from '../../components/Skeleton'
import { Button } from '../../components/ui'
import { useAuth } from '../../context/AuthContext'
import useHotkeys from '../../hooks/useHotkeys'
import {
  CHECKLIST_ITEMS, CHECKLIST_GROUPS,
  GENRE_OPTIONS, PRIORITY_OPTIONS, TYPE_OPTIONS, MONTHS,
  DSP_STATUSES, DSP_STATUS_STYLES,
  BUDGET_CATEGORIES, TAB_IDS,
  daysUntil, getCompletionPercentage, getPriorityBadge,
} from './constants'
import NotificationBanner from './NotificationBanner'
import CalendarView from './CalendarView'
import SpendPlanPanel from './SpendPlanPanel'
import AddReleaseModal from './AddReleaseModal'
import MergeFlow from './MergeFlow'

export default function Releases() {
  const { user: currentUser } = useAuth()
  const [releases, setReleases] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const searchDebounceRef = useRef(null)
  // Only show the full-page skeleton on first mount; subsequent refetches
  // (filter / search changes) update the table quietly so focus isn't lost.
  const hasLoadedOnce = useRef(false)
  // Race guard: increment on every releases fetch; late responses whose gen
  // doesn't match the latest are dropped. Prevents an in-flight
  // `bypassFilters=false` from clobbering a newer `bypassFilters=true`
  // (or vice versa) when filters + search change close together.
  const fetchGenRef = useRef(0)
  const [year, setYear] = useState('')
  const [month, setMonth] = useState('')
  const [genre, setGenre] = useState('All')
  const [priority, setPriority] = useState('All')
  const [releaseType, setReleaseType] = useState('All')
  const [upcoming, setUpcoming] = useState('Upcoming')
  const [expandedId, setExpandedId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [savingId, setSavingId] = useState(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [artists, setArtists] = useState([])
  const [teamMembers, setTeamMembers] = useState([])
  const [metadataEdit, setMetadataEdit] = useState({})
  const [savingMetadataId, setSavingMetadataId] = useState(null)

  // Budget line items state
  const [budgetItems, setBudgetItems] = useState({})       // { [releaseId]: { items: [], budget_cap: null } }
  const [budgetLoading, setBudgetLoading] = useState({})   // { [releaseId]: bool }
  const [newBudgetItem, setNewBudgetItem] = useState({})   // { [releaseId]: { category, description, amount } }
  const [savingBudgetItem, setSavingBudgetItem] = useState({}) // { [releaseId]: bool }
  const [deletingBudgetItem, setDeletingBudgetItem] = useState(null)

  // Core field editing state
  const [editingCoreId, setEditingCoreId] = useState(null)
  const [coreEdit, setCoreEdit] = useState({})
  const [savingCoreId, setSavingCoreId] = useState(null)

  // Per-release tab state (checklist | metadata | details)
  const [expandedTab, setExpandedTab] = useState({})
  const getTab = (id) => expandedTab[id] || 'checklist'
  const setTab = (id, tab) => setExpandedTab(prev => ({ ...prev, [id]: tab }))

  // View mode: list | calendar
  const [viewMode, setViewMode] = useState('list')

  // Assignment saving
  const [savingAssignId, setSavingAssignId] = useState(null)

  // DSP tracker state: { [releaseId]: [...dsps] }
  const [dspData, setDspData] = useState({})
  const [savingDsp, setSavingDsp] = useState(null) // "releaseId:dspName"

  // Activity log state: { [releaseId]: [...entries] }
  const [activityData, setActivityData] = useState({})

  // Comments state: { [releaseId]: [...comments] }
  const [commentsData, setCommentsData] = useState({})
  const [commentDraft, setCommentDraft] = useState({}) // { [releaseId]: string }
  const [postingComment, setPostingComment] = useState(null) // releaseId

  // Show archived toggle
  const [showArchived, setShowArchived] = useState(false)
  const [focusedIdx, setFocusedIdx] = useState(-1)

  // Merge: ids selected via the per-row checkbox, captured with a snapshot of
  // their metadata so the modal still works if the filter changes after pick.
  // The parent owns the selection; MergeFlow owns the modal state + POST.
  const [selectedForMerge, setSelectedForMerge] = useState({})

  const toggleMergeSelection = (release) => {
    setSelectedForMerge(prev => {
      const next = { ...prev }
      if (next[release.id]) delete next[release.id]
      else next[release.id] = {
        id: release.id,
        project_name: release.project_name,
        artist_name: release.artist_name,
        release_date: release.release_date,
        upc: release.upc,
        isrc: release.isrc,
      }
      return next
    })
  }

  const clearMergeSelection = () => setSelectedForMerge({})

  // Callback MergeFlow fires after a successful merge — drop the source rows.
  const handleMerged = (sourceIds) => {
    setReleases(prev => prev.filter(r => !sourceIds.includes(r.id)))
  }

  // Callback AddReleaseModal fires after creating a release.
  const handleReleaseCreated = (release) => {
    setReleases(prev => [release, ...prev])
  }

  // Jump-to navigation for the notification banner chips: open list view,
  // clear date filters, expand the release, and default its tab to the
  // checklist. The useEffect that reads pendingScrollId.current handles the
  // scroll after the refetch settles.
  const handleNotifJumpTo = (releaseId) => {
    pendingScrollId.current = releaseId
    setYear('')
    setMonth('')
    setViewMode('list')
    setExpandedId(releaseId)
    setTab(releaseId, 'checklist')
  }

  // Jump-to navigation for a calendar-cell release click. Same as above,
  // minus the explicit tab default (preserves whichever tab was last open).
  const handleCalendarReleaseClick = (release) => {
    pendingScrollId.current = release.id
    setYear('')
    setMonth('')
    setViewMode('list')
    setExpandedId(release.id)
  }

  useHotkeys([
    { key: 'n', handler: () => setShowAddModal(true) },
    { key: 'v', handler: () => setViewMode(v => v === 'list' ? 'calendar' : 'list') },
    { key: 'j', handler: () => setFocusedIdx(i => Math.min(i + 1, filteredReleases.length - 1)) },
    { key: 'k', handler: () => setFocusedIdx(i => Math.max(i - 1, 0)) },
    { key: 'Enter', handler: () => {
      if (focusedIdx >= 0 && focusedIdx < filteredReleases.length) {
        const r = filteredReleases[focusedIdx]
        setExpandedId(prev => prev === r.id ? null : r.id)
      }
    }},
    ...TAB_IDS.map((tab, i) => ({
      key: String(i + 1),
      handler: () => { if (expandedId) setTab(expandedId, tab) },
    })),
  ])

  // Ref map: release id → DOM row element, for scroll-to on expand
  const rowRefs = useRef({})
  // pendingScrollId: set by chip/calendar clicks to trigger a scroll once loading finishes
  const pendingScrollId = useRef(null)

  // Scroll to the expanded row.
  // Fires when expandedId or viewMode changes (direct expand click),
  // AND when loading transitions to false (chip/calendar navigation that triggers a refetch).
  useEffect(() => {
    if (viewMode !== 'list' || loading) return
    // Use pendingScrollId if set (from chip/calendar click), otherwise use expandedId
    const targetId = pendingScrollId.current ?? expandedId
    if (!targetId) return
    const el = rowRefs.current[targetId]
    if (el) {
      pendingScrollId.current = null
      setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80)
    }
  }, [expandedId, viewMode, loading])

  useEffect(() => {
    fetchReleases()
    fetchArtists()
    fetchTeam()
  }, [year, month, genre, priority, releaseType, upcoming, showArchived])

  // Debounce the search box so we don't fetch on every keystroke.
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    searchDebounceRef.current = setTimeout(() => setDebouncedSearch(searchTerm), 300)
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current) }
  }, [searchTerm])

  // When search term is entered, fetch all releases (bypass filters)
  // When cleared, re-fetch with filters
  useEffect(() => {
    if (debouncedSearch && debouncedSearch.length >= 2) {
      fetchReleases(true)
    } else if (debouncedSearch === '') {
      fetchReleases(false)
    }
  }, [debouncedSearch])

  const fetchReleases = async (bypassFilters = false) => {
    const myGen = ++fetchGenRef.current
    try {
      if (!hasLoadedOnce.current) setLoading(true)
      const params = {}
      if (!bypassFilters) {
        if (year && month) params.month = `${year}-${month}`
        else if (year) params.month = year
        if (genre !== 'All') params.genre = genre
        if (priority !== 'All') params.priority = priority
        if (releaseType !== 'All') params.type = releaseType
        if (upcoming === 'Upcoming') params.upcoming = true
        else if (upcoming === 'Past') params.upcoming = false
      }
      if (showArchived) params.archived = true
      const response = await api.get('/releases', { params })
      if (myGen !== fetchGenRef.current) return
      setReleases(response.data.data || [])
    } catch (err) {
      if (myGen !== fetchGenRef.current) return
      setError('Failed to load releases')
    } finally {
      if (myGen === fetchGenRef.current) {
        setLoading(false)
        hasLoadedOnce.current = true
      }
    }
  }

  const fetchArtists = async () => {
    try {
      const response = await api.get('/artists')
      setArtists(response.data.data || [])
    } catch (err) {
      console.error('Failed to load artists:', err)
    }
  }

  const fetchTeam = async () => {
    try {
      const response = await api.get('/team')
      setTeamMembers(response.data.data || [])
    } catch (err) {
      console.error('Failed to load team:', err)
    }
  }

  const filteredReleases = releases.filter(release => {
    if (!searchTerm) return true
    const s = searchTerm.toLowerCase()
    return release.artist_name?.toLowerCase().includes(s) ||
      release.project_name?.toLowerCase().includes(s) ||
      release.isrc?.toLowerCase().includes(s) ||
      release.upc?.toLowerCase().includes(s)
  })

  // Notification: upcoming releases (next 14 days) with incomplete checklists
  const notifications = filteredReleases.filter(r => {
    const d = daysUntilLocal(r.release_date) ?? -1
    return d >= 0 && d <= 14 && getCompletionPercentage(r) < 100
  })

  const toggleChecklist = async (releaseId, item) => {
    setSavingId(releaseId)
    // flushSync forces the functional updater to run NOW so nextVal is
    // computed from the freshest state (rapid toggles stay safe) and is
    // defined before the PUT body is built. Without it React defers the
    // updater past the synchronous part of this handler, the body became
    // `{ key: undefined }` → `{}`, and the old full-replace server handler
    // wiped every other checklist flag. The server is partial-update now,
    // but the body still must carry the real value.
    let nextVal
    flushSync(() => {
      setReleases(prev => prev.map(r => {
        if (r.id !== releaseId) return r
        nextVal = !r[item.key]
        return { ...r, [item.key]: nextVal }
      }))
    })
    if (nextVal === undefined) { setSavingId(null); return } // release not found
    try {
      await api.put(`/releases/${releaseId}/checklist`, { [item.key]: nextVal })
    } catch (err) {
      console.error('Failed to update checklist:', err)
      // Roll the optimistic flip back so the UI matches the server again.
      setReleases(prev => prev.map(r => r.id === releaseId ? { ...r, [item.key]: !nextVal } : r))
    } finally {
      setSavingId(null)
    }
  }

  // --- Assignment ---
  const handleAssign = async (releaseId, userId) => {
    setSavingAssignId(releaseId)
    try {
      const response = await api.put(`/releases/${releaseId}/assign`, { assigned_to: userId || null })
      setReleases(releases.map(r => r.id === releaseId ? response.data.data : r))
    } catch (err) {
      console.error('Failed to assign release:', err)
    } finally {
      setSavingAssignId(null)
    }
  }

  // --- DSP ---
  const fetchDsp = async (releaseId) => {
    if (dspData[releaseId]) return
    try {
      const r = await api.get(`/dsp/${releaseId}`)
      setDspData(prev => ({ ...prev, [releaseId]: r.data.data }))
    } catch (err) { console.error('Failed to load DSP data', err) }
  }

  const updateDsp = async (releaseId, dspName, field, value) => {
    const key = `${releaseId}:${dspName}`
    setSavingDsp(key)
    try {
      const current = (dspData[releaseId] || []).find(d => d.dsp_name === dspName) || {}
      const updated = { ...current, [field]: value, dsp_name: dspName }
      const r = await api.put(`/dsp/${releaseId}`, updated)
      setDspData(prev => ({
        ...prev,
        [releaseId]: (prev[releaseId] || []).map(d => d.dsp_name === dspName ? r.data.data : d)
      }))
    } catch (err) { console.error('Failed to update DSP', err) }
    finally { setSavingDsp(null) }
  }

  // --- Activity ---
  const fetchActivity = async (releaseId) => {
    try {
      const r = await api.get(`/releases/${releaseId}/activity`)
      setActivityData(prev => ({ ...prev, [releaseId]: r.data.data }))
    } catch (err) { console.error('Failed to load activity', err) }
  }

  // --- Comments ---
  const fetchComments = async (releaseId) => {
    try {
      const r = await api.get(`/releases/${releaseId}/comments`)
      setCommentsData(prev => ({ ...prev, [releaseId]: r.data.data }))
    } catch (err) { console.error('Failed to load comments', err) }
  }

  const postComment = async (releaseId) => {
    const body = commentDraft[releaseId]?.trim()
    if (!body) return
    setPostingComment(releaseId)
    try {
      const r = await api.post(`/releases/${releaseId}/comments`, { text: body })
      setCommentsData(prev => ({ ...prev, [releaseId]: [...(prev[releaseId] || []), r.data.data] }))
      setCommentDraft(prev => ({ ...prev, [releaseId]: '' }))
    } catch (err) { alert('Failed to post comment') }
    finally { setPostingComment(null) }
  }

  const deleteComment = async (releaseId, commentId) => {
    try {
      await api.delete(`/releases/${releaseId}/comments/${commentId}`)
      setCommentsData(prev => ({ ...prev, [releaseId]: (prev[releaseId] || []).filter(c => c.id !== commentId) }))
    } catch (err) { alert('Failed to delete comment') }
  }

  // --- Budget Line Items ---
  const fetchBudgetItems = async (releaseId) => {
    if (budgetLoading[releaseId]) return
    setBudgetLoading(prev => ({ ...prev, [releaseId]: true }))
    try {
      const r = await api.get(`/releases/${releaseId}/budget-items`)
      setBudgetItems(prev => ({ ...prev, [releaseId]: r.data.data }))
    } catch (err) { console.error('Failed to load budget items', err) }
    finally { setBudgetLoading(prev => ({ ...prev, [releaseId]: false })) }
  }

  const addBudgetItem = async (releaseId) => {
    const item = newBudgetItem[releaseId] || {}
    if (!item.category || item.amount === '' || item.amount === undefined) return
    setSavingBudgetItem(prev => ({ ...prev, [releaseId]: true }))
    try {
      const r = await api.post(`/releases/${releaseId}/budget-items`, {
        category: item.category,
        description: item.description || '',
        amount: item.amount,
      })
      setBudgetItems(prev => ({
        ...prev,
        [releaseId]: { ...prev[releaseId], items: [...(prev[releaseId]?.items || []), r.data.data] }
      }))
      setNewBudgetItem(prev => ({ ...prev, [releaseId]: { category: '', description: '', amount: '' } }))
    } catch (err) { alert('Failed to add line item') }
    finally { setSavingBudgetItem(prev => ({ ...prev, [releaseId]: false })) }
  }

  const deleteBudgetItem = async (releaseId, itemId) => {
    setDeletingBudgetItem(itemId)
    try {
      await api.delete(`/releases/${releaseId}/budget-items/${itemId}`)
      setBudgetItems(prev => ({
        ...prev,
        [releaseId]: { ...prev[releaseId], items: (prev[releaseId]?.items || []).filter(i => i.id !== itemId) }
      }))
    } catch (err) { alert('Failed to delete line item') }
    finally { setDeletingBudgetItem(null) }
  }

  // --- Catalog ---
  const handleMoveToCatalog = async (releaseId) => {
    if (!window.confirm('Mark this release as released and move it to the Catalog?')) return
    try {
      await api.put(`/releases/${releaseId}/catalog`)
      setReleases(prev => prev.filter(r => r.id !== releaseId))
      if (expandedId === releaseId) setExpandedId(null)
    } catch (err) { alert('Failed to move release to catalog') }
  }

  // --- Archive / Delete ---
  const handleArchive = async (releaseId) => {
    try {
      const r = await api.put(`/releases/${releaseId}/archive`)
      const { archived } = r.data.data
      // If we just archived a release while the "Show Archived" toggle is off,
      // drop it from the visible list so the row disappears immediately.
      if (archived && !showArchived) {
        setReleases(prev => prev.filter(rel => rel.id !== releaseId))
        if (expandedId === releaseId) setExpandedId(null)
      } else {
        setReleases(prev => prev.map(rel =>
          rel.id === releaseId ? { ...rel, archived } : rel
        ))
      }
    } catch (err) { alert('Failed to archive release') }
  }

  const handleDelete = async (releaseId, projectName) => {
    if (!window.confirm(`Permanently delete "${projectName}"? This cannot be undone.`)) return
    try {
      await api.delete(`/releases/${releaseId}`)
      setReleases(prev => prev.filter(r => r.id !== releaseId))
      if (expandedId === releaseId) setExpandedId(null)
    } catch (err) {
      alert(err?.response?.data?.error || 'Failed to delete release')
    }
  }

  // --- Core field editing ---
  const startCoreEdit = (release) => {
    setEditingCoreId(release.id)
    setCoreEdit({
      artist_name: release.artist_name || '',
      project_name: release.project_name || '',
      release_date: release.release_date ? release.release_date.split('T')[0] : '',
      release_type: release.release_type || '',
      genre: release.genre || '',
      priority: release.priority || 'standard',
    })
  }

  const cancelCoreEdit = () => {
    setEditingCoreId(null)
    setCoreEdit({})
  }

  const saveCoreEdit = async (releaseId) => {
    setSavingCoreId(releaseId)
    try {
      const response = await api.put(`/releases/${releaseId}`, coreEdit)
      setReleases(releases.map(r => r.id === releaseId ? response.data.data : r))
      setEditingCoreId(null)
      setCoreEdit({})
    } catch (err) {
      console.error('Failed to save release:', err)
      alert('Failed to save release')
    } finally {
      setSavingCoreId(null)
    }
  }

  // --- Metadata editing ---
  const handleSaveMetadata = async (releaseId) => {
    if (!metadataEdit[releaseId]) return
    setSavingMetadataId(releaseId)
    try {
      await api.put(`/releases/${releaseId}/metadata`, metadataEdit[releaseId])
      setReleases(releases.map(r => r.id === releaseId ? { ...r, ...metadataEdit[releaseId] } : r))
      setMetadataEdit({ ...metadataEdit, [releaseId]: null })
    } catch (err) {
      alert('Failed to save metadata')
    } finally {
      setSavingMetadataId(null)
    }
  }

  const updateMetadataField = (releaseId, field, value) => {
    setMetadataEdit({
      ...metadataEdit,
      [releaseId]: { ...metadataEdit[releaseId], [field]: value }
    })
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton.PageHeader />
        <Skeleton.Table rows={8} cols={8} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Release Tracker"
        subtitle="Manage your release checklist"
        actions={<>
          <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
            <button onClick={() => setViewMode('list')} className={`px-3 py-2 flex items-center gap-1.5 text-xs font-medium transition-colors ${viewMode === 'list' ? 'bg-gray-900 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>
              <List size={14} /> List
            </button>
            <button onClick={() => setViewMode('calendar')} className={`px-3 py-2 flex items-center gap-1.5 text-xs font-medium transition-colors ${viewMode === 'calendar' ? 'bg-gray-900 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>
              <Calendar size={14} /> Calendar
            </button>
          </div>
          <Button onClick={() => setShowAddModal(true)}>
            <Plus size={16} /> Add Release
          </Button>
        </>}
      />

      <NotificationBanner notifications={notifications} onJumpTo={handleNotifJumpTo} />

      {/* Filters */}
      <div className="flex gap-2 flex-wrap items-center">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300" size={14} />
          <input type="text" placeholder="Search artist, project, ISRC, UPC…" value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-boom/20 focus:border-boom transition-all bg-white" />
        </div>
        <div className="flex items-center gap-1.5 bg-white border border-gray-200 rounded-xl px-2 py-1 flex-wrap">
          <select value={year} onChange={(e) => setYear(e.target.value)}
            className="text-sm text-gray-600 bg-transparent border-0 outline-none cursor-pointer py-1 pr-1">
            <option value="">All Years</option>
            {[2027,2026,2025,2024,2023,2022,2021].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <span className="text-gray-200">|</span>
          <select value={month} onChange={(e) => setMonth(e.target.value)}
            className="text-sm text-gray-600 bg-transparent border-0 outline-none cursor-pointer py-1 pr-1">
            <option value="">All Months</option>
            {MONTHS.map((m, i) => <option key={m} value={String(i+1).padStart(2,'0')}>{m}</option>)}
          </select>
          <span className="text-gray-200">|</span>
          <select value={genre} onChange={(e) => setGenre(e.target.value)}
            className="text-sm text-gray-600 bg-transparent border-0 outline-none cursor-pointer py-1 pr-1">
            {GENRE_OPTIONS.map(g => <option key={g} value={g}>{g === 'All' ? 'Genre' : g}</option>)}
          </select>
          <span className="text-gray-200">|</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value)}
            className="text-sm text-gray-600 bg-transparent border-0 outline-none cursor-pointer py-1 pr-1">
            {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{p === 'All' ? 'Priority' : p}</option>)}
          </select>
          <span className="text-gray-200">|</span>
          <select value={releaseType} onChange={(e) => setReleaseType(e.target.value)}
            className="text-sm text-gray-600 bg-transparent border-0 outline-none cursor-pointer py-1 pr-1">
            {TYPE_OPTIONS.map(t => <option key={t} value={t}>{t === 'All' ? 'Type' : t}</option>)}
          </select>
        </div>
        <button onClick={() => setShowArchived(v => !v)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border transition-colors ${
            showArchived ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-400 border-gray-200 hover:text-gray-600'
          }`}>
          <Archive size={12} /> Archived
        </button>
      </div>

      {error && <div className="text-center py-12 text-sm text-red-600">{error}</div>}

      {/* ===== CALENDAR VIEW ===== */}
      {viewMode === 'calendar' && (
        <CalendarView
          filteredReleases={filteredReleases}
          onReleaseClick={handleCalendarReleaseClick}
        />
      )}

      {/* ===== LIST VIEW ===== */}
      {viewMode === 'list' && (
        <div className="bg-card rounded-2xl border border-rule-light shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-divider">
            <p className="text-xs text-gray-400 font-medium">{filteredReleases.length} releases</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-divider bg-gray-50/50">
                  <th className="pl-4 pr-1 py-3 w-8" title="Select for merge"></th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Artist</th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Project</th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Date</th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Format</th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Genre</th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Priority</th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Assigned</th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Completion</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filteredReleases.length === 0 ? (
                  <tr><td colSpan="9" className="px-5 py-16 text-center text-sm text-gray-300">No releases found</td></tr>
                ) : (
                  filteredReleases.map((release, rIdx) => {
                    const isExpanded = expandedId === release.id
                    const completion = getCompletionPercentage(release)
                    const isEditingCore = editingCoreId === release.id
                    const isFocused = focusedIdx === rIdx

                    return (
                      <tbody key={release.id} ref={el => { rowRefs.current[release.id] = el; if (isFocused && el) el.scrollIntoView({ block: 'nearest' }) }}>
                        <tr
                          onClick={() => { setExpandedId(isExpanded ? null : release.id); setFocusedIdx(rIdx); if (isEditingCore) cancelCoreEdit() }}
                          className={`cursor-pointer transition-colors ${isExpanded ? 'bg-gray-50/80' : selectedForMerge[release.id] ? 'bg-rose-50/50 ring-1 ring-inset ring-rose-200' : isFocused ? 'bg-boom-50/60 ring-1 ring-inset ring-boom-200' : 'hover:bg-gray-50/60'}`}
                        >
                          <td className="pl-4 pr-1 py-3.5 w-8" onClick={e => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={!!selectedForMerge[release.id]}
                              onChange={() => toggleMergeSelection(release)}
                              title="Select to merge with other releases"
                              className="rounded border-gray-300 text-rose-600 focus:ring-rose-500 cursor-pointer"
                            />
                          </td>
                          <td className="px-5 py-3.5 text-sm font-semibold text-gray-900 whitespace-nowrap">{release.artist_name || '—'}</td>
                          <td className="px-5 py-3.5 text-sm text-gray-600">
                            <Link
                              to={`/releases/${release.id}`}
                              onClick={e => e.stopPropagation()}
                              className="hover:text-boom-600 transition-colors"
                            >{release.project_name}</Link>
                          </td>
                          <td className="px-5 py-3.5 text-sm text-gray-400 whitespace-nowrap">{formatDate(release.release_date)}</td>
                          <td className="px-5 py-3.5 text-sm text-gray-400">{release.release_type || '—'}</td>
                          <td className="px-5 py-3.5 text-sm text-gray-400">{release.genre || '—'}</td>
                          <td className="px-5 py-3.5">
                            {release.priority && release.priority !== 'standard' && release.release_date && new Date(release.release_date) >= new Date() ? (
                              <span className={getPriorityBadge(release.priority)}>{release.priority}</span>
                            ) : <span className="text-gray-300 text-sm">—</span>}
                          </td>
                          <td className="px-5 py-3.5">
                            {release.assigned_to_name
                              ? <span className="text-xs font-medium text-gray-500 bg-gray-100 px-2 py-1 rounded-full">{release.assigned_to_name}</span>
                              : <span className="text-gray-300 text-xs">—</span>
                            }
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-3">
                              <div className="w-16 bg-gray-100 rounded-full h-1">
                                <div className={`h-1 rounded-full transition-all ${completion === 100 ? 'bg-emerald-400' : 'bg-boom'}`} style={{ width: `${completion}%` }} />
                              </div>
                              <span className="text-xs text-gray-400 tabular-nums w-7">{completion}%</span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleArchive(release.id)
                                }}
                                title={release.archived ? 'Unarchive' : 'Archive (use for delayed or never-released)'}
                                className={`ml-1 p-1 rounded transition-colors ${
                                  release.archived
                                    ? 'text-amber-500 hover:bg-amber-50'
                                    : 'text-gray-300 hover:text-amber-500 hover:bg-amber-50'
                                }`}
                              >
                                <Archive size={13} />
                              </button>
                            </div>
                          </td>
                        </tr>

                        {isExpanded && (() => {
                          const tab = getTab(release.id)
                          const countdown = daysUntil(release.release_date)
                          const doneCnt = CHECKLIST_ITEMS.filter(i => release[i.key]).length
                          const TABS = [
                            { id: 'checklist', label: 'Checklist', badge: `${doneCnt}/${CHECKLIST_ITEMS.length}` },
                            { id: 'metadata',  label: 'Metadata & Links' },
                            { id: 'dsp',       label: 'DSP' },
                            { id: 'budget',    label: 'Budget' },
                            { id: 'activity',  label: 'Activity' },
                            { id: 'comments',  label: 'Comments' },
                            { id: 'details',   label: 'Details' },
                          ]
                          return (
                          <tr>
                            <td colSpan="9" className="px-0 py-0">
                              <div className="border-t border-divider">

                                {/* Light header */}
                                <div className="bg-card px-6 py-4 flex items-center justify-between gap-4 flex-wrap border-b border-divider">
                                  <div>
                                    <div className="flex items-center gap-3 mb-1 flex-wrap">
                                      <Link
                                        to={`/releases/${release.id}`}
                                        onClick={e => e.stopPropagation()}
                                        className="text-gray-900 font-bold text-base tracking-tight hover:text-boom-600 transition-colors"
                                      >{release.project_name}</Link>
                                      <span className="text-gray-400 text-sm">{release.artist_name}</span>
                                      {release.priority && release.priority !== 'standard' && release.release_date && new Date(release.release_date) >= new Date() && (
                                        <span className={getPriorityBadge(release.priority)}>{release.priority}</span>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-2 text-xs text-gray-400 flex-wrap">
                                      <span>{release.release_type} · {release.genre}</span>
                                      <span>·</span>
                                      <span>{formatDate(release.release_date)}</span>
                                      <span>·</span>
                                      <span className={`font-semibold ${countdown.cls}`}>{countdown.label}</span>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-3 flex-shrink-0">
                                    <div className="text-right">
                                      <div className="text-gray-900 font-bold text-xl tabular-nums leading-none">{completion}%</div>
                                      <div className="text-gray-400 text-xs mt-0.5">{doneCnt} of {CHECKLIST_ITEMS.length}</div>
                                    </div>
                                    <svg className="w-10 h-10 flex-shrink-0" style={{transform:'rotate(-90deg)'}} viewBox="0 0 36 36">
                                      <circle cx="18" cy="18" r="15.9" fill="none" stroke="#f3f4f6" strokeWidth="3.5"/>
                                      <circle cx="18" cy="18" r="15.9" fill="none" stroke="#ef4444" strokeWidth="3.5"
                                        strokeDasharray={`${completion} ${100 - completion}`} strokeLinecap="round"/>
                                    </svg>
                                  </div>
                                </div>

                                {/* Tabs — horizontally scrollable so all 7 stay reachable on phones */}
                                <div className="flex border-b border-divider px-4 sm:px-6 bg-card overflow-x-auto" style={{ WebkitOverflowScrolling: 'touch' }} onClick={e => e.stopPropagation()}>
                                  {TABS.map(t => (
                                    <button key={t.id} onClick={() => {
                                    setTab(release.id, t.id)
                                    if (t.id === 'dsp') fetchDsp(release.id)
                                    if (t.id === 'activity') fetchActivity(release.id)
                                    if (t.id === 'comments') fetchComments(release.id)
                                    if (t.id === 'budget') fetchBudgetItems(release.id)
                                  }}
                                      className={`flex items-center gap-2 py-3 mr-6 text-xs font-semibold border-b-2 transition-all whitespace-nowrap flex-shrink-0 ${
                                        tab === t.id ? 'border-red-500 text-red-500' : 'border-transparent text-gray-400 hover:text-gray-600'
                                      }`}>
                                      {t.label}
                                      {t.badge && (
                                        <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold tabular-nums ${
                                          tab === t.id ? 'bg-red-50 text-red-500' : 'bg-gray-100 text-gray-400'
                                        }`}>{t.badge}</span>
                                      )}
                                    </button>
                                  ))}
                                </div>

                                {/* Tab content */}
                                <div className="p-4 sm:p-6 bg-card overflow-x-auto" onClick={e => e.stopPropagation()}>

                                  {/* CHECKLIST TAB */}
                                  {tab === 'checklist' && (
                                    <div className="space-y-6">
                                      {CHECKLIST_GROUPS.map(group => {
                                        const items = CHECKLIST_ITEMS.filter(i => i.group === group)
                                        const done = items.filter(i => release[i.key]).length
                                        return (
                                          <div key={group}>
                                            <div className="flex items-center gap-3 mb-3">
                                              <span className="text-xs font-bold text-gray-400 uppercase tracking-widest whitespace-nowrap">{group}</span>
                                              <div className="flex-1 h-px bg-gray-100"/>
                                              <span className="text-xs text-gray-300 tabular-nums">{done}/{items.length}</span>
                                            </div>
                                            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                                              {items.map(item => (
                                                <button key={item.key}
                                                  onClick={() => toggleChecklist(release.id, item)}
                                                  disabled={savingId === release.id}
                                                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-medium transition-all border text-left ${
                                                    release[item.key]
                                                      ? 'bg-red-500 border-red-500 text-white shadow-sm'
                                                      : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300 hover:bg-gray-50'
                                                  }`}>
                                                  <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                                                    release[item.key] ? 'border-white/50' : 'border-gray-300'
                                                  }`}>
                                                    {release[item.key] && (
                                                      <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 12 12">
                                                        <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                                                      </svg>
                                                    )}
                                                  </span>
                                                  {item.label}
                                                </button>
                                              ))}
                                            </div>
                                          </div>
                                        )
                                      })}
                                    </div>
                                  )}

                                  {/* METADATA TAB */}
                                  {tab === 'metadata' && (
                                    <div className="space-y-5">
                                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                        {[
                                          { key: 'upc',               label: 'UPC / EAN',         placeholder: 'UPC code' },
                                          { key: 'isrc',              label: 'ISRC',               placeholder: 'ISRC code' },
                                          { key: 'apple_id',          label: 'Apple ID',           placeholder: 'Apple ID' },
                                          { key: 'spotify_uri',       label: 'Spotify URI',        placeholder: 'spotify:...' },
                                          { key: 'presave_link',      label: 'Pre-Save Link',      placeholder: 'https://...' },
                                          { key: 'presave_analytics', label: 'Pre-Save Analytics', placeholder: 'https://...' },
                                          { key: 'ugc_link',          label: 'UGC Link',           placeholder: 'https://...' },
                                          { key: 'apple_music_link',  label: 'Apple Music Link',   placeholder: 'https://...' },
                                          { key: 'producer',          label: 'Producer',           placeholder: 'Producer name' },
                                          { key: 'featured_artists',  label: 'Featured Artists',   placeholder: 'Comma-separated' },
                                          { key: 'subgenre',          label: 'Subgenre',           placeholder: 'e.g. Trap' },
                                        ].map(({ key, label, placeholder }) => (
                                          <div key={key}>
                                            <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">{label}</label>
                                            <input type="text"
                                              value={metadataEdit[release.id]?.[key] ?? release[key] ?? ''}
                                              onChange={(e) => updateMetadataField(release.id, key, e.target.value)}
                                              className="input-base" placeholder={placeholder}/>
                                          </div>
                                        ))}
                                        <div>
                                          <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Cover Art Status</label>
                                          <select
                                            value={metadataEdit[release.id]?.cover_art_status ?? release.cover_art_status ?? 'Pending'}
                                            onChange={(e) => updateMetadataField(release.id, 'cover_art_status', e.target.value)}
                                            className="select-base w-full">
                                            <option>Pending</option><option>In Progress</option><option>Approved</option><option>Final</option>
                                          </select>
                                        </div>
                                      </div>
                                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        {[
                                          { key: 'distributor_notes', label: 'Distributor Notes', placeholder: 'Notes for distributor...' },
                                          { key: 'notes',             label: 'Internal Notes',    placeholder: 'Additional notes...' },
                                        ].map(({ key, label, placeholder }) => (
                                          <div key={key}>
                                            <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">{label}</label>
                                            <textarea rows={3}
                                              value={metadataEdit[release.id]?.[key] ?? release[key] ?? ''}
                                              onChange={(e) => updateMetadataField(release.id, key, e.target.value)}
                                              className="input-base resize-none" placeholder={placeholder}/>
                                          </div>
                                        ))}
                                      </div>
                                      <div className="flex justify-end">
                                        <button onClick={() => handleSaveMetadata(release.id)}
                                          disabled={savingMetadataId === release.id || !metadataEdit[release.id]}
                                          className="btn-primary text-xs py-2 px-5">
                                          {savingMetadataId === release.id ? 'Saving...' : 'Save Metadata'}
                                        </button>
                                      </div>
                                    </div>
                                  )}

                                  {/* DSP TAB */}
                                  {tab === 'dsp' && (
                                    <div>
                                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                                        {(dspData[release.id] || []).map(dsp => {
                                          const isSaving = savingDsp === `${release.id}:${dsp.dsp_name}`
                                          return (
                                            <div key={dsp.dsp_name} className="border border-rule rounded-xl p-3.5 bg-card">
                                              <div className="flex items-center justify-between mb-2.5">
                                                <p className="text-sm font-semibold text-gray-900">{dsp.dsp_name}</p>
                                                {isSaving && <div className="w-3.5 h-3.5 border-2 border-boom-500 border-t-transparent rounded-full animate-spin" />}
                                              </div>
                                              <select
                                                value={dsp.status || 'Not Submitted'}
                                                onChange={e => updateDsp(release.id, dsp.dsp_name, 'status', e.target.value)}
                                                className={`w-full text-xs font-semibold px-2 py-1.5 rounded-lg border-0 outline-none cursor-pointer mb-2 ${DSP_STATUS_STYLES[dsp.status] || DSP_STATUS_STYLES['Not Submitted']}`}
                                              >
                                                {DSP_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                                              </select>
                                              <div className="grid grid-cols-2 gap-1.5">
                                                <div>
                                                  <label className="text-xs text-gray-400 font-medium">Submitted</label>
                                                  <input type="date"
                                                    value={dsp.submitted_date ? dsp.submitted_date.split('T')[0] : ''}
                                                    onChange={e => updateDsp(release.id, dsp.dsp_name, 'submitted_date', e.target.value || null)}
                                                    className="w-full text-xs input-base py-1 mt-0.5" />
                                                </div>
                                                <div>
                                                  <label className="text-xs text-gray-400 font-medium">Live</label>
                                                  <input type="date"
                                                    value={dsp.live_date ? dsp.live_date.split('T')[0] : ''}
                                                    onChange={e => updateDsp(release.id, dsp.dsp_name, 'live_date', e.target.value || null)}
                                                    className="w-full text-xs input-base py-1 mt-0.5" />
                                                </div>
                                              </div>
                                            </div>
                                          )
                                        })}
                                        {!dspData[release.id] && (
                                          <div className="col-span-3 py-8 text-center text-sm text-gray-400">Loading DSP data…</div>
                                        )}
                                      </div>
                                    </div>
                                  )}

                                  {/* ACTIVITY TAB */}
                                  {tab === 'activity' && (
                                    <div>
                                      {!activityData[release.id] ? (
                                        <div className="py-8 text-center text-sm text-gray-400">Loading activity…</div>
                                      ) : activityData[release.id].length === 0 ? (
                                        <div className="py-8 text-center text-sm text-gray-400">No activity recorded yet.</div>
                                      ) : (
                                        <div className="space-y-0 divide-y divide-gray-100">
                                          {activityData[release.id].map((entry, i) => (
                                            <div key={i} className="flex items-start gap-3 py-3">
                                              <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                                                <span className="text-xs font-bold text-gray-500">
                                                  {entry.user_name?.charAt(0)?.toUpperCase() || '?'}
                                                </span>
                                              </div>
                                              <div className="flex-1 min-w-0">
                                                <p className="text-sm text-gray-700">{entry.detail}</p>
                                                <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
                                                  <Clock size={10} />
                                                  {entry.user_name} · {new Date(entry.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                                                </p>
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  )}

                                  {/* COMMENTS TAB */}
                                  {tab === 'comments' && (
                                    <div className="space-y-4">
                                      {/* Existing comments */}
                                      {!commentsData[release.id] ? (
                                        <div className="py-8 text-center text-sm text-gray-400">Loading…</div>
                                      ) : commentsData[release.id].length === 0 ? (
                                        <div className="py-6 text-center text-sm text-gray-400">No comments yet. Be the first.</div>
                                      ) : (
                                        <div className="space-y-0 divide-y divide-gray-100">
                                          {commentsData[release.id].map(c => (
                                            <div key={c.id} className="flex items-start gap-3 py-3 group">
                                              <div className="w-7 h-7 rounded-full bg-boom-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                                                <span className="text-xs font-bold text-boom-700">
                                                  {c.user_name?.charAt(0)?.toUpperCase() || '?'}
                                                </span>
                                              </div>
                                              <div className="flex-1 min-w-0">
                                                <div className="flex items-baseline gap-2">
                                                  <span className="text-xs font-semibold text-gray-800">{c.user_name}</span>
                                                  <span className="text-xs text-gray-400">
                                                    {new Date(c.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                                                  </span>
                                                </div>
                                                <p className="text-sm text-gray-700 mt-0.5 whitespace-pre-wrap">{c.text || c.body}</p>
                                              </div>
                                              {(currentUser?.id === c.user_id || (currentUser?.hierarchy_level ?? 99) <= 2) && (
                                                <button
                                                  onClick={() => deleteComment(release.id, c.id)}
                                                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-gray-300 hover:text-red-400 flex-shrink-0"
                                                >
                                                  <X size={12} />
                                                </button>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      )}

                                      {/* New comment input */}
                                      <div className="flex items-start gap-3 pt-2 border-t border-divider">
                                        <div className="w-7 h-7 rounded-full bg-boom-100 flex items-center justify-center flex-shrink-0 mt-1">
                                          <span className="text-xs font-bold text-boom-700">
                                            {currentUser?.name?.charAt(0)?.toUpperCase()}
                                          </span>
                                        </div>
                                        <div className="flex-1 flex gap-2">
                                          <textarea
                                            rows={2}
                                            placeholder="Add a comment…"
                                            value={commentDraft[release.id] || ''}
                                            onChange={e => setCommentDraft(prev => ({ ...prev, [release.id]: e.target.value }))}
                                            onKeyDown={e => {
                                              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) postComment(release.id)
                                            }}
                                            className="flex-1 text-sm px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-boom-500/30 focus:border-boom-400 focus:bg-white resize-none transition-colors placeholder:text-gray-400"
                                          />
                                          <button
                                            onClick={() => postComment(release.id)}
                                            disabled={!commentDraft[release.id]?.trim() || postingComment === release.id}
                                            className="self-end btn-primary text-xs py-2 px-3 disabled:opacity-40 disabled:cursor-not-allowed"
                                          >
                                            {postingComment === release.id ? '…' : 'Post'}
                                          </button>
                                        </div>
                                      </div>
                                    </div>
                                  )}

                                  {/* BUDGET TAB */}
                                  {tab === 'budget' && (() => {
                                    const budgetData = budgetItems[release.id]
                                    const items = budgetData?.items || []
                                    const cap = budgetData?.budget_cap ? parseFloat(budgetData.budget_cap) : null
                                    const total = items.reduce((sum, i) => sum + parseFloat(i.amount), 0)
                                    const byCategory = BUDGET_CATEGORIES.reduce((acc, cat) => {
                                      const catItems = items.filter(i => i.category === cat)
                                      if (catItems.length > 0) acc[cat] = catItems
                                      return acc
                                    }, {})
                                    // Items with an unrecognized category (edge case)
                                    const otherItems = items.filter(i => !BUDGET_CATEGORIES.includes(i.category))
                                    if (otherItems.length > 0) byCategory['Other'] = [...(byCategory['Other'] || []), ...otherItems]
                                    const form = newBudgetItem[release.id] || { category: '', description: '', amount: '' }
                                    const isSaving = !!savingBudgetItem[release.id]
                                    const isLoading = !!budgetLoading[release.id]

                                    return (
                                      <div className="space-y-6">

                                        {/* What the marketing spend sheet committed for this
                                            release, beside what the ledger actually paid.
                                            Renders nothing when the release has no plan. */}
                                        <SpendPlanPanel releaseId={release.id} />

                                        {/* Summary bar */}
                                        {(items.length > 0 || cap != null) && (
                                          <div className="flex items-center gap-6 pb-5 border-b border-divider flex-wrap">
                                            <div>
                                              <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-0.5">Total Spent</p>
                                              <p className="text-xl font-bold text-gray-900 tabular-nums">${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                                            </div>
                                            {cap != null && (
                                              <>
                                                <div>
                                                  <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-0.5">Budget Cap</p>
                                                  <p className="text-xl font-bold text-gray-900 tabular-nums">${cap.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                                                </div>
                                                <div>
                                                  <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-0.5">Remaining</p>
                                                  <p className={`text-xl font-bold tabular-nums ${cap - total < 0 ? 'text-red-500' : 'text-green-600'}`}>
                                                    ${Math.abs(cap - total).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                    {cap - total < 0 ? ' over' : ' left'}
                                                  </p>
                                                </div>
                                                <div className="flex-1 min-w-[120px]">
                                                  <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                                                    <div
                                                      className={`h-full rounded-full transition-all ${total / cap > 1 ? 'bg-red-500' : total / cap > 0.8 ? 'bg-amber-400' : 'bg-green-500'}`}
                                                      style={{ width: `${Math.min(100, (total / cap) * 100)}%` }}
                                                    />
                                                  </div>
                                                  <p className="text-xs text-gray-400 mt-1 tabular-nums">{Math.round((total / cap) * 100)}% used</p>
                                                </div>
                                              </>
                                            )}
                                          </div>
                                        )}

                                        {/* Line items grouped by category */}
                                        {isLoading ? (
                                          <div className="flex items-center gap-2 text-sm text-gray-400">
                                            <div className="w-4 h-4 border-2 border-gray-200 border-t-red-400 rounded-full animate-spin"/>
                                            Loading...
                                          </div>
                                        ) : items.length === 0 ? (
                                          <p className="text-sm text-gray-400">No line items yet. Add one below.</p>
                                        ) : (
                                          <div className="space-y-5">
                                            {Object.entries(byCategory).map(([cat, catItems]) => {
                                              const catTotal = catItems.reduce((s, i) => s + parseFloat(i.amount), 0)
                                              return (
                                                <div key={cat}>
                                                  <div className="flex items-center gap-3 mb-2">
                                                    <span className="text-xs font-bold text-gray-400 uppercase tracking-widest whitespace-nowrap">{cat}</span>
                                                    <div className="flex-1 h-px bg-gray-100"/>
                                                    <span className="text-xs font-semibold text-gray-500 tabular-nums">${catTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                                  </div>
                                                  <div className="space-y-1">
                                                    {catItems.map(item => (
                                                      <div key={item.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-50 group">
                                                        <div className="flex-1 min-w-0">
                                                          <span className="text-sm text-gray-700">{item.description || <span className="text-gray-400 italic">No description</span>}</span>
                                                        </div>
                                                        <span className="text-sm font-semibold text-gray-900 tabular-nums flex-shrink-0">
                                                          ${parseFloat(item.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                        </span>
                                                        <button
                                                          onClick={() => deleteBudgetItem(release.id, item.id)}
                                                          disabled={deletingBudgetItem === item.id}
                                                          className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 transition-all flex-shrink-0"
                                                        >
                                                          <X size={14}/>
                                                        </button>
                                                      </div>
                                                    ))}
                                                  </div>
                                                </div>
                                              )
                                            })}
                                          </div>
                                        )}

                                        {/* Add line item form */}
                                        <div className="pt-4 border-t border-divider">
                                          <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">Add Line Item</p>
                                          <div className="flex items-end gap-2 flex-wrap">
                                            <div>
                                              <label className="block text-xs text-gray-400 mb-1">Category</label>
                                              <select
                                                value={form.category}
                                                onChange={e => setNewBudgetItem(prev => ({ ...prev, [release.id]: { ...form, category: e.target.value } }))}
                                                className="select-base text-sm"
                                              >
                                                <option value="">— Select —</option>
                                                {BUDGET_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                                              </select>
                                            </div>
                                            <div className="flex-1 min-w-[160px]">
                                              <label className="block text-xs text-gray-400 mb-1">Description</label>
                                              <input
                                                type="text"
                                                placeholder="e.g. Director fee"
                                                value={form.description}
                                                onChange={e => setNewBudgetItem(prev => ({ ...prev, [release.id]: { ...form, description: e.target.value } }))}
                                                className="input-base text-sm w-full"
                                              />
                                            </div>
                                            <div className="w-28">
                                              <label className="block text-xs text-gray-400 mb-1">Amount ($)</label>
                                              <input
                                                type="number"
                                                min="0"
                                                step="0.01"
                                                placeholder="0.00"
                                                value={form.amount}
                                                onChange={e => setNewBudgetItem(prev => ({ ...prev, [release.id]: { ...form, amount: e.target.value } }))}
                                                className="input-base text-sm w-full"
                                              />
                                            </div>
                                            <button
                                              onClick={() => addBudgetItem(release.id)}
                                              disabled={isSaving || !form.category || form.amount === ''}
                                              className="btn-primary text-xs py-2 px-4 flex-shrink-0"
                                            >
                                              {isSaving ? 'Saving...' : 'Add'}
                                            </button>
                                          </div>
                                        </div>

                                      </div>
                                    )
                                  })()}

                                  {/* DETAILS TAB */}
                                  {tab === 'details' && (
                                    <div className="space-y-6">
                                      {/* Assignment */}
                                      <div className="flex items-center gap-4 pb-5 border-b border-divider">
                                        <div className="flex items-center gap-2 text-xs font-bold text-gray-400 uppercase tracking-wider">
                                          <User size={13} /> Assigned To
                                        </div>
                                        <div className="flex items-center gap-2">
                                          <select
                                            value={release.assigned_to || ''}
                                            onChange={(e) => handleAssign(release.id, e.target.value ? parseInt(e.target.value) : null)}
                                            disabled={savingAssignId === release.id}
                                            className="select-base text-sm"
                                          >
                                            <option value="">Unassigned</option>
                                            {teamMembers.map(m => (
                                              <option key={m.id} value={m.id}>{m.name}</option>
                                            ))}
                                          </select>
                                          {savingAssignId === release.id && (
                                            <div className="w-4 h-4 border-2 border-boom-500 border-t-transparent rounded-full animate-spin" />
                                          )}
                                        </div>
                                      </div>

                                      {/* Core details */}
                                      {!isEditingCore ? (
                                        <div>
                                          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-6 mb-5">
                                            {[
                                              { label: 'Artist',       value: release.artist_name },
                                              { label: 'Project',      value: release.project_name },
                                              { label: 'Release Date', value: formatDate(release.release_date) },
                                              { label: 'Format',       value: release.release_type },
                                              { label: 'Genre',        value: release.genre },
                                            ].map(({ label, value }) => (
                                              <div key={label}>
                                                <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">{label}</p>
                                                <p className="text-sm font-semibold text-gray-900 capitalize">{value || '—'}</p>
                                              </div>
                                            ))}
                                            <div>
                                              <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Priority</p>
                                              {release.priority
                                                ? <span className={getPriorityBadge(release.priority)}>{release.priority}</span>
                                                : <p className="text-sm text-gray-400">—</p>}
                                            </div>
                                          </div>
                                          <button onClick={() => startCoreEdit(release)}
                                            className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-red-500 transition-colors">
                                            <Pencil size={12}/> Edit Details
                                          </button>
                                        </div>
                                      ) : (
                                        <div>
                                          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-5">
                                            <div>
                                              <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Artist</label>
                                              <input type="text" value={coreEdit.artist_name}
                                                onChange={(e) => setCoreEdit({ ...coreEdit, artist_name: e.target.value })}
                                                list={`artist-list-${release.id}`} className="input-base"/>
                                              <datalist id={`artist-list-${release.id}`}>
                                                {artists.map(a => <option key={a.id} value={a.name}/>)}
                                              </datalist>
                                            </div>
                                            <div>
                                              <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Project</label>
                                              <input type="text" value={coreEdit.project_name}
                                                onChange={(e) => setCoreEdit({ ...coreEdit, project_name: e.target.value })} className="input-base"/>
                                            </div>
                                            <div>
                                              <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Release Date</label>
                                              <input type="date" value={coreEdit.release_date}
                                                onChange={(e) => setCoreEdit({ ...coreEdit, release_date: e.target.value })} className="input-base"/>
                                            </div>
                                            <div>
                                              <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Format</label>
                                              <select value={coreEdit.release_type}
                                                onChange={(e) => setCoreEdit({ ...coreEdit, release_type: e.target.value })} className="select-base w-full">
                                                <option value="">—</option>
                                                <option value="Single">Single</option><option value="EP">EP</option>
                                                <option value="Album">Album</option><option value="Compilation">Compilation</option>
                                              </select>
                                            </div>
                                            <div>
                                              <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Genre</label>
                                              <input type="text" value={coreEdit.genre}
                                                onChange={(e) => setCoreEdit({ ...coreEdit, genre: e.target.value })} className="input-base" placeholder="e.g. Hip-Hop"/>
                                            </div>
                                            <div>
                                              <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Priority</label>
                                              <select value={coreEdit.priority}
                                                onChange={(e) => setCoreEdit({ ...coreEdit, priority: e.target.value })} className="select-base w-full">
                                                <option value="standard">Standard</option>
                                                <option value="priority">Priority</option>
                                                <option value="high priority">High Priority</option>
                                              </select>
                                            </div>
                                          </div>
                                          <div className="flex items-center gap-3">
                                            <button onClick={() => saveCoreEdit(release.id)} disabled={savingCoreId === release.id} className="btn-primary text-xs py-2 px-4">
                                              <Save size={12}/>{savingCoreId === release.id ? 'Saving...' : 'Save'}
                                            </button>
                                            <button onClick={cancelCoreEdit} className="btn-secondary text-xs py-2 px-4">Cancel</button>
                                          </div>
                                        </div>
                                      )}

                                      {/* Danger Zone */}
                                      <div className="pt-5 border-t border-divider">
                                        <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">Actions</p>
                                        <div className="flex items-center gap-3 flex-wrap">
                                          <button
                                            onClick={() => handleMoveToCatalog(release.id)}
                                            className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-2 rounded-lg border border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 hover:border-emerald-300 transition-colors"
                                          >
                                            <Library size={13} />
                                            Mark as Released
                                          </button>
                                          <button
                                            onClick={() => handleArchive(release.id, release.archived)}
                                            className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:border-amber-300 hover:text-amber-600 hover:bg-amber-50 transition-colors"
                                          >
                                            <Archive size={13} />
                                            {release.archived ? 'Unarchive' : 'Archive'}
                                          </button>
                                          {(currentUser?.hierarchy_level ?? 99) <= 2 && (
                                            <button
                                              onClick={() => handleDelete(release.id, release.project_name)}
                                              className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:border-red-300 hover:text-red-600 hover:bg-red-50 transition-colors"
                                            >
                                              <Trash2 size={13} />
                                              Delete Permanently
                                            </button>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  )}

                                </div>
                              </div>
                            </td>
                          </tr>
                          )
                        })()}
                      </tbody>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <MergeFlow
        selectedForMerge={selectedForMerge}
        onClearSelection={clearMergeSelection}
        onMerged={handleMerged}
      />

      <AddReleaseModal
        show={showAddModal}
        onClose={() => setShowAddModal(false)}
        onCreated={handleReleaseCreated}
        artists={artists}
      />
    </div>
  )
}
