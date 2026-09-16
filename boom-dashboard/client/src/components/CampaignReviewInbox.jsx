import { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronRight, Flag, MessageSquare, ExternalLink, UserPlus, X, Check, Music2 } from 'lucide-react'
import api from '../api'
import CommentThreadButton from './CommentThreadButton'
import { useAuth } from '../context/AuthContext'
import { formatDate } from '../utils'

// "Needs review" inbox for the Artist Campaigns home page. Aggregates
// flagged items and open comment threads across every artist (from
// /artist-campaigns/review-feed), stacked hierarchically:
//
//   artist (collapsible) → song (collapsible) → item rows
//
// Each item carries a full comment thread (same expense_comments the
// row threads use everywhere else, so the discussion follows the item)
// and can be assigned to MULTIPLE reviewers; "Assigned to me" scopes
// the whole tree to the signed-in user's queue.
export default function CampaignReviewInbox() {
  const { user } = useAuth()
  const [feed, setFeed] = useState(null)        // { flags, comments, assignments }
  const [team, setTeam] = useState([])          // [{ id, name }]
  // Starts CLOSED. Expanded it is 100 items and ~17 artist rows before the page's
  // own content, so the cards this page exists for sat below the fold. The count
  // in the header is the part you need at a glance; the tree is what you open when
  // you are working it.
  const [open, setOpen] = useState(false)
  const [mineOnly, setMineOnly] = useState(false)

  useEffect(() => {
    api.get('/artist-campaigns/review-feed')
      .then(r => setFeed(r.data?.data || { flags: [], comments: [], assignments: {} }))
      .catch(() => setFeed({ flags: [], comments: [], assignments: {} }))
    api.get('/team')
      .then(r => setTeam((r.data?.data || r.data || []).map(u => ({ id: u.id, name: u.name }))))
      .catch(() => setTeam([]))
  }, [])

  // Merge flags + comment threads into one list keyed by expense — an
  // item that is both flagged AND discussed renders once with both
  // signals.
  const items = useMemo(() => {
    if (!feed) return []
    const byId = new Map()
    for (const f of feed.flags) {
      byId.set(f.id, { ...f, kind: 'flag', activity_at: f.flagged_at })
    }
    for (const c of feed.comments) {
      const existing = byId.get(c.id)
      if (existing) {
        Object.assign(existing, {
          comment_count: c.comment_count, last_comment: c.last_comment,
          last_comment_by: c.last_comment_by,
          activity_at: (c.last_comment_at || '') > (existing.activity_at || '') ? c.last_comment_at : existing.activity_at,
        })
      } else {
        byId.set(c.id, { ...c, kind: 'comment', activity_at: c.last_comment_at })
      }
    }
    let list = [...byId.values()]
    if (mineOnly && user?.id) {
      list = list.filter(it => (feed.assignments[it.id] || []).some(a => a.user_id === user.id))
    }
    return list
  }, [feed, mineOnly, user])

  // artist → song → items tree. Artists ordered by their most recent
  // activity (fresh review work floats up); songs alphabetical with
  // (no song) last; items newest-first within a song.
  const tree = useMemo(() => {
    const byArtist = new Map()
    for (const it of items) {
      const aKey = (it.artist || '').trim().toLowerCase() || '__none__'
      if (!byArtist.has(aKey)) byArtist.set(aKey, { key: aKey, name: (it.artist || '').trim() || '(no artist)', items: [], latest: '' })
      const a = byArtist.get(aKey)
      a.items.push(it)
      if ((it.activity_at || '') > a.latest) a.latest = it.activity_at || ''
    }
    return [...byArtist.values()]
      .sort((x, y) => y.latest.localeCompare(x.latest))
      .map(a => {
        const bySong = new Map()
        for (const it of a.items) {
          const sKey = (it.song || '').trim() || '(no song)'
          if (!bySong.has(sKey)) bySong.set(sKey, [])
          bySong.get(sKey).push(it)
        }
        const songs = [...bySong.entries()]
          .sort(([s1], [s2]) => {
            if (s1 === '(no song)') return 1
            if (s2 === '(no song)') return -1
            return s1.localeCompare(s2)
          })
          .map(([song, list]) => ({
            song,
            items: list.sort((x, y) => (y.activity_at || '').localeCompare(x.activity_at || '')),
            totals: sumByCurrency(list),
          }))
        return { ...a, songs, totals: sumByCurrency(a.items) }
      })
  }, [items])

  // Collapse state — everything starts collapsed so 90+ items stay
  // scannable; counts on the headers say where the work is.
  const [openArtists, setOpenArtists] = useState(() => new Set())
  const [openSongs, setOpenSongs] = useState(() => new Set())
  const toggleSet = (setter) => (key) => setter(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })
  const toggleArtist = toggleSet(setOpenArtists)
  const toggleSong = toggleSet(setOpenSongs)

  const assigneesFor = (id) => feed?.assignments?.[id] || []

  // Keep inbox comment counts in sync with the thread popover — posting
  // a comment from here should update the row's count immediately.
  const onThreadChange = (entryId, thread) => {
    setFeed(prev => {
      if (!prev) return prev
      const last = thread[thread.length - 1]
      const rest = prev.comments.filter(c => c.id !== entryId)
      if (!thread.length) return { ...prev, comments: rest }
      const existing = prev.comments.find(c => c.id === entryId)
      const base = existing || prev.flags.find(f => f.id === entryId) || { id: entryId }
      return {
        ...prev,
        comments: [...rest, {
          ...base,
          id: entryId,
          comment_count: thread.length,
          last_comment: last.comment,
          last_comment_by: last.user_name,
          last_comment_at: last.created_at,
        }],
      }
    })
  }

  // ── Assign popover (portal, same pattern as the label/flag menus) ─────
  const [assignMenu, setAssignMenu] = useState(null) // { entryId, top, left, draft:Set }
  const popRef = useRef(null)
  const openAssignMenu = (e, entryId) => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    setAssignMenu({
      entryId,
      top: Math.min(r.bottom + 6, window.innerHeight - 60),
      left: Math.min(Math.max(8, r.left - 110), window.innerWidth - 240),
      draft: new Set(assigneesFor(entryId).map(a => a.user_id)),
      saving: false,
    })
  }
  useEffect(() => {
    if (!assignMenu) return
    const onDown = (e) => { if (!popRef.current?.contains(e.target)) setAssignMenu(null) }
    const onKey = (e) => { if (e.key === 'Escape') setAssignMenu(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [assignMenu])

  const toggleDraft = (uid) => setAssignMenu(prev => {
    if (!prev) return prev
    const draft = new Set(prev.draft)
    draft.has(uid) ? draft.delete(uid) : draft.add(uid)
    return { ...prev, draft }
  })

  const saveAssignments = async () => {
    if (!assignMenu || assignMenu.saving) return
    const { entryId, draft } = assignMenu
    setAssignMenu(prev => prev ? { ...prev, saving: true } : prev)
    try {
      const r = await api.post('/artist-campaigns/review-assign', { entry_id: entryId, user_ids: [...draft] })
      const assignees = r.data?.data?.assignees || []
      setFeed(prev => prev ? { ...prev, assignments: { ...prev.assignments, [entryId]: assignees } } : prev)
      setAssignMenu(null)
    } catch (err) {
      alert('Failed to save assignees: ' + (err.response?.data?.error || err.message))
      setAssignMenu(prev => prev ? { ...prev, saving: false } : prev)
    }
  }

  if (!feed || items.length === 0) {
    // Nothing needing review (or still loading) — render nothing rather
    // than an empty shell; the inbox earns its space only when work
    // exists. (When "Assigned to me" empties the list, keep the shell so
    // the user can toggle back.)
    if (!mineOnly) return null
  }

  return (
    <div className="card overflow-visible">
      <div className="px-4 py-3 flex items-center gap-2">
        <button onClick={() => setOpen(o => !o)} className="text-gray-400 hover:text-gray-700 -ml-1 p-0.5">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <Flag size={13} className="text-amber-600" />
        <span className="text-sm font-bold text-gray-900">Needs review</span>
        <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-amber-100 text-amber-800 text-[11px] font-bold">
          {items.length}
        </span>
        <span className="text-[11px] text-gray-400 hidden sm:inline">flagged items + open comment threads · artist → song → item</span>
        <button
          onClick={() => setMineOnly(m => !m)}
          className={`ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold ring-1 transition-colors ${
            mineOnly
              ? 'bg-boom-600 text-white ring-boom-600'
              : 'text-gray-500 bg-gray-50 ring-gray-200/60 hover:bg-gray-100'
          }`}
          title="Only items assigned to me"
        >
          Assigned to me
        </button>
      </div>

      {open && (
        <div className="border-t border-divider">
          {tree.length === 0 && (
            <p className="px-4 py-3 text-xs text-gray-400 italic">Nothing assigned to you right now.</p>
          )}
          {tree.map(artist => {
            const aOpen = openArtists.has(artist.key)
            return (
              <div key={artist.key} className="border-b border-gray-50 last:border-b-0">
                {/* ── Artist stack header ── */}
                <button
                  onClick={() => toggleArtist(artist.key)}
                  className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-gray-50/60 text-left"
                >
                  {aOpen ? <ChevronDown size={13} className="text-gray-400" /> : <ChevronRight size={13} className="text-gray-400" />}
                  <span className="text-xs font-bold text-gray-900 uppercase tracking-wide">{artist.name}</span>
                  <span className="inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded-full bg-amber-50 text-amber-700 ring-1 ring-amber-200/60 text-[10px] font-bold">
                    {artist.items.length}
                  </span>
                  <span className="ml-auto text-[11px] font-bold text-gray-500 tabular-nums">{fmtTotals(artist.totals)}</span>
                  <Link
                    to={`/artist-campaigns/${encodeURIComponent(artist.name === '(no artist)' ? 'unassigned' : artist.name)}`}
                    onClick={e => e.stopPropagation()}
                    className="text-gray-400 hover:text-boom-600 p-1"
                    title="Open this artist's campaigns page"
                  >
                    <ExternalLink size={12} />
                  </Link>
                </button>

                {aOpen && artist.songs.map(sec => {
                  const sKey = `${artist.key}::${sec.song}`
                  const sOpen = openSongs.has(sKey)
                  return (
                    <div key={sKey}>
                      {/* ── Song stack header ── */}
                      <button
                        onClick={() => toggleSong(sKey)}
                        className="w-full pl-9 pr-4 py-2 flex items-center gap-1.5 bg-gray-50/50 hover:bg-gray-50 text-left border-t border-gray-50"
                      >
                        {sOpen ? <ChevronDown size={11} className="text-gray-400" /> : <ChevronRight size={11} className="text-gray-400" />}
                        <Music2 size={10} className="text-gray-400" />
                        <span className={`text-[11px] font-semibold ${sec.song === '(no song)' ? 'text-amber-600 italic' : 'text-gray-700'}`}>{sec.song}</span>
                        <span className="text-[10px] text-gray-400">({sec.items.length})</span>
                        <span className="ml-auto text-[10px] text-gray-400 tabular-nums">{fmtTotals(sec.totals)}</span>
                      </button>

                      {/* ── Item rows ── */}
                      {sOpen && sec.items.map(it => {
                        const assignees = assigneesFor(it.id)
                        return (
                          <div key={it.id} className="pl-12 pr-4 py-2.5 flex items-start gap-2.5 border-t border-gray-50">
                            <span className="mt-0.5 shrink-0">
                              {it.kind === 'flag'
                                ? <Flag size={12} className="text-amber-600" />
                                : <MessageSquare size={12} className="text-sky-600" />}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-baseline gap-2 flex-wrap">
                                <span className="text-xs font-bold text-gray-900 truncate max-w-[220px]">{it.payee || `#${it.id}`}</span>
                                <span className="text-xs font-bold text-gray-700 tabular-nums">{fmtAmount(it.amount, it.currency)}</span>
                              </div>
                              <p className="text-[11px] text-gray-600 mt-0.5 line-clamp-2">
                                {it.kind === 'flag' ? (
                                  <>
                                    {(it.flag_reason || '').trim() || 'Flagged for review'}
                                    <span className="text-gray-400"> — {it.flagged_by_name || 'unknown'}{it.flagged_at ? ` · ${formatDate(it.flagged_at)}` : ''}</span>
                                  </>
                                ) : (
                                  <>
                                    “{it.last_comment}”
                                    <span className="text-gray-400"> — {it.last_comment_by || 'unknown'}</span>
                                  </>
                                )}
                                {it.kind === 'flag' && it.comment_count > 0 && (
                                  <span className="text-sky-600"> · “{it.last_comment}” — {it.last_comment_by}</span>
                                )}
                              </p>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {assignees.map(a => (
                                <span
                                  key={a.user_id}
                                  className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ring-1 ${
                                    a.user_id === user?.id
                                      ? 'bg-boom-50 text-boom-700 ring-boom-200/60'
                                      : 'bg-gray-50 text-gray-600 ring-gray-200/60'
                                  }`}
                                  title={`Assigned to ${a.name}`}
                                >
                                  {a.name}
                                </span>
                              ))}
                              <button
                                onClick={(e) => openAssignMenu(e, it.id)}
                                className="text-gray-400 hover:text-boom-600 p-1"
                                title={assignees.length ? 'Edit who reviews this' : 'Assign users to review this'}
                              >
                                <UserPlus size={13} />
                              </button>
                              {/* Full comment thread — same expense_comments
                                  the row threads use everywhere, so review
                                  discussion follows the item across pages. */}
                              <CommentThreadButton
                                entryId={it.id}
                                initialCount={it.comment_count || 0}
                                placeholder="Add a review note…"
                                onThreadChange={onThreadChange}
                              />
                              <Link
                                to={`/artist-campaigns/${encodeURIComponent((it.artist || '').trim() || 'unassigned')}`}
                                className="text-gray-400 hover:text-boom-600 p-1"
                                title="Open this artist's campaigns page"
                              >
                                <ExternalLink size={13} />
                              </Link>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}

      {assignMenu && createPortal(
        <div
          ref={popRef}
          onClick={e => e.stopPropagation()}
          style={{ position: 'fixed', top: assignMenu.top, left: assignMenu.left, zIndex: 60, width: 230 }}
          className="bg-card border border-rule rounded-lg shadow-lg p-2 text-xs"
        >
          <div className="flex items-center justify-between px-1 pb-1.5">
            <span className="font-bold text-gray-900">Assign reviewers</span>
            <button onClick={() => setAssignMenu(null)} className="text-gray-300 hover:text-gray-600"><X size={13} /></button>
          </div>
          <div className="max-h-52 overflow-y-auto">
            {team.map(u => (
              <label key={u.id} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-gray-50/80 cursor-pointer">
                <input
                  type="checkbox"
                  checked={assignMenu.draft.has(u.id)}
                  onChange={() => toggleDraft(u.id)}
                  className="h-3.5 w-3.5 rounded border-gray-300 text-boom-600 focus:ring-boom-500"
                />
                <span className="text-gray-800">{u.name}</span>
              </label>
            ))}
            {team.length === 0 && <p className="px-1.5 py-1 text-gray-400 italic">No users found.</p>}
          </div>
          <div className="flex justify-end gap-2 pt-1.5 mt-1 border-t border-divider">
            <button onClick={() => setAssignMenu(null)} className="btn-secondary text-[11px] px-2 py-1">Cancel</button>
            <button onClick={saveAssignments} disabled={assignMenu.saving} className="btn-primary text-[11px] px-2 py-1 inline-flex items-center gap-1">
              <Check size={11} /> {assignMenu.saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

// ── helpers ────────────────────────────────────────────────────────────────
function sumByCurrency(list) {
  const map = {}
  for (const it of list) {
    const cur = (it.currency || 'USD').toUpperCase()
    map[cur] = (map[cur] || 0) + (Number(it.amount) || 0)
  }
  return map
}

function fmtAmount(v, cur) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(Number(v) || 0)
}

function fmtTotals(totals) {
  return Object.entries(totals).map(([cur, v]) => fmtAmount(v, cur)).join(' + ')
}
