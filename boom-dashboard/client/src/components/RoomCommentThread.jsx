import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { MessageSquare, Send, Pencil, Trash2, Check, X, ChevronDown, ChevronRight } from 'lucide-react'
import api from '../api'
import { useAuth } from '../context/AuthContext'

// Inline page-scoped comment thread — the "discussion section" flavor of
// the campaign chat. Same room-based API (campaign_chat_messages), its
// own room namespace, so it never mixes with the slide-over chat rooms.
//
//   <RoomCommentThread room="campaigns-notes:laszewo" title="Laszewo"
//                      path="/artist-campaigns/Laszewo" />
//
// Supports @mention autocomplete (mentions land in the bell, same as
// chat), editing and deleting your own comments (admins can delete
// anything), and light polling so teammates' comments appear without a
// reload.
export default function RoomCommentThread({ room, title, path }) {
  const { user } = useAuth()
  const [messages, setMessages] = useState(null)
  const [team, setTeam] = useState([])
  const [collapsed, setCollapsed] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftMentions, setDraftMentions] = useState(() => new Set())
  const [sending, setSending] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState('')
  const inputRef = useRef(null)
  const mRef = useRef(null)
  useEffect(() => { mRef.current = messages }, [messages])

  const encRoom = encodeURIComponent(room)

  const pollCountRef = useRef(0)
  const poll = useCallback(async () => {
    try {
      // Every 4th tick (~60s) do a FULL refresh — the after-id slice can
      // only append, so teammates' edits/deletes never propagated.
      pollCountRef.current += 1
      const maxId = mRef.current?.length ? mRef.current[mRef.current.length - 1].id : 0
      const fullRefresh = !maxId || pollCountRef.current % 4 === 0
      const r = await api.get(`/artist-campaigns/chat/${encRoom}`, { params: fullRefresh ? {} : { after: maxId } })
      const d = r.data?.data || {}
      if (fullRefresh) setMessages(d.messages || [])
      else if ((d.messages || []).length) {
        setMessages(prev => {
          const seen = new Set((prev || []).map(m => m.id))
          return [...(prev || []), ...d.messages.filter(m => !seen.has(m.id))]
        })
      }
    } catch { if (mRef.current == null) setMessages([]) }
  }, [encRoom])

  useEffect(() => {
    poll()
    api.get('/team')
      .then(r => setTeam((r.data?.data || r.data || []).map(u => ({ id: u.id, name: u.name }))))
      .catch(() => setTeam([]))
    const iv = setInterval(poll, 15000)
    const onFocus = () => poll()
    window.addEventListener('focus', onFocus)
    return () => { clearInterval(iv); window.removeEventListener('focus', onFocus) }
  }, [poll])

  // ── @mention autocomplete (same pattern as CampaignChat) ────────────────
  const [mentionQuery, setMentionQuery] = useState(null)
  const onDraftChange = (e) => {
    const v = e.target.value
    setDraft(v)
    const caret = e.target.selectionStart
    const before = v.slice(0, caret)
    const at = before.lastIndexOf('@')
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1]))) {
      const q = before.slice(at + 1)
      if (q.length <= 40 && !q.includes('\n')) { setMentionQuery({ query: q.toLowerCase(), start: at }); return }
    }
    setMentionQuery(null)
  }
  const mentionMatches = useMemo(() => {
    if (mentionQuery == null) return []
    return team.filter(u => u.id !== user?.id && u.name.toLowerCase().includes(mentionQuery.query)).slice(0, 6)
  }, [mentionQuery, team, user])
  const insertMention = (u) => {
    const el = inputRef.current
    const caret = el ? el.selectionStart : draft.length
    setDraft(draft.slice(0, mentionQuery.start) + '@' + u.name + ' ' + draft.slice(caret))
    setDraftMentions(prev => new Set(prev).add(u.id))
    setMentionQuery(null)
    requestAnimationFrame(() => el?.focus())
  }
  const mentionsIn = (text) => {
    const ids = []
    for (const u of team) {
      if (u.id !== user?.id && text.includes('@' + u.name)) ids.push(u.id)
    }
    return ids
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  const send = async () => {
    const body = draft.trim()
    if (!body || sending) return
    setSending(true)
    try {
      const r = await api.post(`/artist-campaigns/chat/${encRoom}`, {
        body, mentions: mentionsIn(body), room_title: title, room_path: path,
      })
      if (r.data?.data) setMessages(prev => [...(prev || []), r.data.data])
      setDraft('')
      setDraftMentions(new Set())
    } catch (err) {
      alert('Failed to post: ' + (err.response?.data?.error || err.message))
    } finally { setSending(false) }
  }

  const saveEdit = async (id) => {
    const body = editDraft.trim()
    if (!body) return
    try {
      const r = await api.put(`/artist-campaigns/chat/messages/${id}`, { body, mentions: mentionsIn(body) })
      setMessages(prev => (prev || []).map(m => m.id === id ? { ...m, ...r.data?.data } : m))
      setEditingId(null)
    } catch (err) {
      alert('Failed to edit: ' + (err.response?.data?.error || err.message))
    }
  }

  const remove = async (id) => {
    if (!confirm('Delete this comment?')) return
    try {
      await api.delete(`/artist-campaigns/chat/messages/${id}`)
      setMessages(prev => (prev || []).filter(m => m.id !== id))
    } catch (err) {
      alert('Failed to delete: ' + (err.response?.data?.error || err.message))
    }
  }

  const nameRegex = useMemo(() => {
    if (!team.length) return null
    const names = team.map(t => t.name).filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    return new RegExp(`@(${names.join('|')})`, 'g')
  }, [team])
  const renderBody = (body) => {
    if (!nameRegex) return body
    const parts = []
    let last = 0, m
    nameRegex.lastIndex = 0
    while ((m = nameRegex.exec(body))) {
      if (m.index > last) parts.push(body.slice(last, m.index))
      parts.push(
        <span key={m.index} className={`font-bold rounded px-0.5 ${m[1] === user?.name ? 'bg-boom-100 text-boom-700' : 'text-boom-600'}`}>
          @{m[1]}
        </span>
      )
      last = m.index + m[0].length
    }
    if (last < body.length) parts.push(body.slice(last))
    return parts
  }

  const fmtTime = (ts) => ts
    ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
      new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : ''

  const isModerator = ['Admin', 'Superadmin'].includes(user?.role)
  const count = messages?.length || 0

  return (
    <div className="card p-4">
      <button onClick={() => setCollapsed(c => !c)} className="flex items-center gap-2 w-full text-left">
        {collapsed ? <ChevronRight size={13} className="text-gray-400" /> : <ChevronDown size={13} className="text-gray-400" />}
        <MessageSquare size={13} className="text-sky-600" />
        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Comments</h3>
        {count > 0 && (
          <span className="inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded-full bg-sky-50 text-sky-700 ring-1 ring-sky-200/60 text-[10px] font-bold">
            {count}
          </span>
        )}
        <span className="text-[10px] text-gray-400 ml-1">@ to mention someone</span>
      </button>

      {!collapsed && (
        <>
          <div className="mt-3 space-y-2.5 max-h-80 overflow-y-auto">
            {messages === null && <p className="text-[11px] text-gray-400 italic">Loading…</p>}
            {messages?.length === 0 && (
              <p className="text-[11px] text-gray-400 italic">No comments yet — start the discussion.</p>
            )}
            {(messages || []).map(m => {
              const mine = m.user_id === user?.id
              return (
                <div key={m.id} className="group/cmt flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className={`text-xs font-bold ${mine ? 'text-boom-700' : 'text-gray-900'}`}>{m.user_name || 'Unknown'}</span>
                      <span className="text-[10px] text-gray-400">{fmtTime(m.created_at)}</span>
                      {m.edited_at && <span className="text-[9px] text-gray-400">(edited)</span>}
                    </div>
                    {editingId === m.id ? (
                      <div className="mt-1 flex items-end gap-1.5">
                        <textarea
                          value={editDraft}
                          onChange={e => setEditDraft(e.target.value.slice(0, 4000))}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(m.id) }
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          rows={2}
                          autoFocus
                          className="flex-1 rounded-lg border border-rule px-2 py-1.5 text-xs bg-card focus:outline-none focus:ring-1 focus:ring-boom-400 resize-none"
                        />
                        <button onClick={() => saveEdit(m.id)} className="text-emerald-600 hover:text-emerald-700 p-1" title="Save"><Check size={13} /></button>
                        <button onClick={() => setEditingId(null)} className="text-gray-400 hover:text-gray-600 p-1" title="Cancel"><X size={13} /></button>
                      </div>
                    ) : (
                      <p className="text-xs text-gray-700 whitespace-pre-wrap break-words leading-relaxed">
                        {renderBody(m.body)}
                      </p>
                    )}
                  </div>
                  {editingId !== m.id && (mine || isModerator) && (
                    <span className="shrink-0 opacity-0 group-hover/cmt:opacity-100 inline-flex items-center">
                      {mine && (
                        <button onClick={() => { setEditingId(m.id); setEditDraft(m.body) }} className="text-gray-300 hover:text-boom-600 p-1" title="Edit">
                          <Pencil size={11} />
                        </button>
                      )}
                      <button onClick={() => remove(m.id)} className="text-gray-300 hover:text-rose-500 p-1" title="Delete">
                        <Trash2 size={11} />
                      </button>
                    </span>
                  )}
                </div>
              )
            })}
          </div>

          <div className="relative mt-3">
            {mentionQuery != null && mentionMatches.length > 0 && (
              <div className="absolute bottom-full left-0 right-16 mb-1 bg-card border border-rule rounded-lg shadow-lg overflow-hidden z-10">
                {mentionMatches.map(u => (
                  <button
                    key={u.id}
                    onMouseDown={e => { e.preventDefault(); insertMention(u) }}
                    className="w-full text-left px-3 py-1.5 text-xs font-semibold text-gray-800 hover:bg-boom-50"
                  >
                    @{u.name}
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={draft}
                onChange={onDraftChange}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey && mentionQuery != null && mentionMatches.length > 0) {
                    e.preventDefault(); insertMention(mentionMatches[0]); return
                  }
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
                  if (e.key === 'Escape') setMentionQuery(null)
                }}
                placeholder="Add a comment… (@ to mention)"
                rows={2}
                className="flex-1 rounded-lg border border-rule px-3 py-2 text-xs bg-card focus:outline-none focus:ring-1 focus:ring-boom-400 resize-none"
              />
              <button
                onClick={send}
                disabled={sending || !draft.trim()}
                className="btn-primary p-2.5 rounded-lg disabled:opacity-40"
                title="Post (Enter)"
              >
                <Send size={13} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
