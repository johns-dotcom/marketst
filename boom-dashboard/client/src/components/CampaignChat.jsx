import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquare, X, Send, Pencil, Trash2, Check } from 'lucide-react'
import api from '../api'
import { useAuth } from '../context/AuthContext'

// Slide-over chat, one unique room per page that mounts it.
//
//   <CampaignChat room="campaigns:laszewo" title="Laszewo" path="/artist-campaigns/Laszewo" />
//
// - Floating button (bottom-right) with an unread badge; clicking slides
//   the panel in from the right.
// - Polls every 8s (+ on window focus). This used to say there was no
//   websocket infra in this app; there is now — server/lib/realtime.js, added
//   for the /messages board, and Railway carries websockets fine. This panel
//   is deliberately still on the poll: it reads campaign_chat_messages, a
//   separate store from the board's chat_messages, and moving it over is its
//   own migration (see BUILD_MESSAGE_BOARD.md §7.2). Until then an 8s lag on
//   a page-local comment thread is acceptable; on the message board it is not.
// - @mentions: typing "@" opens a teammate autocomplete; sends persist a
//   bell notification for each mentioned user (server-side).
// - Edit / delete own messages (admins can delete anything). Deletes are
//   soft server-side; edited messages show an "(edited)" marker.
//
// Mount with key={room} so all state resets when navigating between
// pages/subpages — every room is fully independent.
export default function CampaignChat({ room, title, path }) {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState(null)   // null = not loaded
  const [lastReadId, setLastReadId] = useState(0)
  const [team, setTeam] = useState([])
  const [draft, setDraft] = useState('')
  const [draftMentions, setDraftMentions] = useState(() => new Set()) // user ids inserted via @
  const [sending, setSending] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState('')
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const openRef = useRef(false)
  openRef.current = open

  const encRoom = encodeURIComponent(room)

  // ── Data ────────────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    try {
      const r = await api.get(`/artist-campaigns/chat/${encRoom}`)
      const d = r.data?.data || {}
      setMessages(d.messages || [])
      setLastReadId(d.last_read_id || 0)
    } catch { setMessages([]) }
  }, [encRoom])

  const pollCountRef = useRef(0)
  const poll = useCallback(async () => {
    try {
      // Every 5th tick (~40s) do a FULL refresh instead of the after-id
      // slice — the incremental fetch can only append, so teammates'
      // edits and deletes never propagated until a remount.
      pollCountRef.current += 1
      const maxId = (mRef.current && mRef.current.length) ? mRef.current[mRef.current.length - 1].id : 0
      const fullRefresh = !maxId || pollCountRef.current % 5 === 0
      const r = await api.get(`/artist-campaigns/chat/${encRoom}`, { params: fullRefresh ? {} : { after: maxId } })
      const d = r.data?.data || {}
      if (fullRefresh) {
        setMessages(d.messages || [])
        if (!maxId) setLastReadId(d.last_read_id || 0)
      } else if ((d.messages || []).length) {
        setMessages(prev => {
          const seen = new Set((prev || []).map(m => m.id))
          return [...(prev || []), ...d.messages.filter(m => !seen.has(m.id))]
        })
      }
    } catch { /* transient poll failure — next tick retries */ }
  }, [encRoom])

  // Ref mirror of messages so poll() reads current state without being
  // recreated per message (which would reset the interval).
  const mRef = useRef(null)
  useEffect(() => { mRef.current = messages }, [messages])

  useEffect(() => {
    fetchAll()
    api.get('/team')
      .then(r => setTeam((r.data?.data || r.data || []).map(u => ({ id: u.id, name: u.name }))))
      .catch(() => setTeam([]))
    const iv = setInterval(poll, 8000)
    const onFocus = () => poll()
    window.addEventListener('focus', onFocus)
    return () => { clearInterval(iv); window.removeEventListener('focus', onFocus) }
  }, [fetchAll, poll])

  // Mark read whenever the panel is open and new messages exist.
  const maxId = messages?.length ? messages[messages.length - 1].id : 0
  useEffect(() => {
    if (!open || !maxId || maxId <= lastReadId) return
    setLastReadId(maxId)
    api.post(`/artist-campaigns/chat/${encRoom}/read`, { last_id: maxId }).catch(() => {})
  }, [open, maxId, lastReadId, encRoom])

  // Auto-scroll to bottom on open + when messages arrive while open.
  useEffect(() => {
    if (open && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [open, maxId])

  const unread = useMemo(() => {
    if (!messages) return 0
    return messages.filter(m => m.id > lastReadId && m.user_id !== user?.id).length
  }, [messages, lastReadId, user])

  // ── @mention autocomplete ────────────────────────────────────────────────
  // Active when the text before the caret ends in "@partial".
  const [mentionQuery, setMentionQuery] = useState(null) // { query, start } | null
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
    const next = draft.slice(0, mentionQuery.start) + '@' + u.name + ' ' + draft.slice(caret)
    setDraft(next)
    setDraftMentions(prev => new Set(prev).add(u.id))
    setMentionQuery(null)
    requestAnimationFrame(() => el?.focus())
  }

  // Mentions actually sent = ids whose @Name still appears in the body
  // (typing @Chase then deleting it shouldn't ping Chase).
  const mentionsIn = (text, fromSet) => {
    const ids = []
    for (const uid of fromSet) {
      const u = team.find(t => t.id === uid)
      if (u && text.includes('@' + u.name)) ids.push(uid)
    }
    // Also catch hand-typed exact @Full Name matches nobody clicked.
    for (const u of team) {
      if (u.id !== user?.id && !ids.includes(u.id) && text.includes('@' + u.name)) ids.push(u.id)
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
        body,
        mentions: mentionsIn(body, draftMentions),
        room_title: title,
        room_path: path,
      })
      const msg = r.data?.data
      if (msg) setMessages(prev => [...(prev || []), msg])
      setDraft('')
      setDraftMentions(new Set())
      setMentionQuery(null)
    } catch (err) {
      alert('Failed to send: ' + (err.response?.data?.error || err.message))
    } finally { setSending(false) }
  }

  const saveEdit = async (id) => {
    const body = editDraft.trim()
    if (!body) return
    try {
      const r = await api.put(`/artist-campaigns/chat/messages/${id}`, {
        body, mentions: mentionsIn(body, new Set()),
      })
      const upd = r.data?.data
      setMessages(prev => (prev || []).map(m => m.id === id ? { ...m, ...upd } : m))
      setEditingId(null)
    } catch (err) {
      alert('Failed to edit: ' + (err.response?.data?.error || err.message))
    }
  }

  const remove = async (id) => {
    if (!confirm('Delete this message?')) return
    try {
      await api.delete(`/artist-campaigns/chat/messages/${id}`)
      setMessages(prev => (prev || []).filter(m => m.id !== id))
    } catch (err) {
      alert('Failed to delete: ' + (err.response?.data?.error || err.message))
    }
  }

  // ── Rendering helpers ─────────────────────────────────────────────────────
  // Highlight known @Name tokens as chips; my own mentions get the boom
  // accent so a callout is unmissable.
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
      const isMe = m[1] === user?.name
      parts.push(
        <span key={m.index} className={`font-bold rounded px-0.5 ${isMe ? 'bg-boom-100 text-boom-700' : 'text-boom-600'}`}>
          @{m[1]}
        </span>
      )
      last = m.index + m[0].length
    }
    if (last < body.length) parts.push(body.slice(last))
    return parts
  }

  const fmtTime = (ts) => {
    if (!ts) return ''
    const d = new Date(ts)
    const today = new Date()
    const sameDay = d.toDateString() === today.toDateString()
    return sameDay
      ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }

  const isModerator = ['Admin', 'Superadmin'].includes(user?.role)

  return (
    <>
      {/* Floating opener — fixed bottom-right on every campaigns page.
          On phones it sits at bottom-36 to clear the BottomNav + FAB stack
          (bottom-5 put it on top of the nav, underneath the FAB). */}
      {!open && createPortal(
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-36 right-4 sm:bottom-5 sm:right-5 z-40 inline-flex items-center gap-2 px-4 py-2.5 rounded-full shadow-lg text-sm font-bold text-white bg-boom-600 hover:bg-boom-700 transition-colors"
          title={`Open the ${title} chat`}
        >
          <MessageSquare size={15} />
          Chat
          {unread > 0 && (
            <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-white text-boom-700 text-[10px] font-black leading-[18px] text-center">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>,
        document.body
      )}

      {/* Slide-over panel */}
      {open && createPortal(
        <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-[380px] flex flex-col bg-card border-l border-rule shadow-2xl" style={{ animation: 'chatSlideIn 0.18s ease-out' }}>
          <style>{`@keyframes chatSlideIn { from { transform: translateX(30px); opacity: 0 } to { transform: translateX(0); opacity: 1 } }`}</style>

          {/* Header */}
          <div className="px-4 py-3 border-b border-divider flex items-center gap-2">
            <MessageSquare size={14} className="text-boom-600" />
            <div className="min-w-0">
              <p className="text-sm font-bold text-gray-900 truncate">Chat · {title}</p>
              <p className="text-[10px] text-gray-400">unique to this page · @ to mention someone</p>
            </div>
            <button onClick={() => setOpen(false)} className="ml-auto text-gray-400 hover:text-gray-700 p-1">
              <X size={16} />
            </button>
          </div>

          {/* Messages */}
          <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages === null && <p className="text-xs text-gray-400 italic">Loading…</p>}
            {messages?.length === 0 && (
              <div className="text-center pt-10">
                <MessageSquare size={22} className="mx-auto text-gray-200 mb-2" />
                <p className="text-xs text-gray-400">No messages yet — start the conversation for {title}.</p>
              </div>
            )}
            {(messages || []).map((m, i) => {
              const prev = messages[i - 1]
              // Collapse the name/time header when the same author posts
              // within 5 minutes — reads like a continued thought.
              const grouped = prev && prev.user_id === m.user_id
                && (new Date(m.created_at) - new Date(prev.created_at)) < 5 * 60 * 1000
              const mine = m.user_id === user?.id
              const mentionsMe = Array.isArray(m.mentions) && m.mentions.includes(user?.id)
              return (
                <div key={m.id} className={`group/msg ${grouped ? '-mt-2' : ''}`}>
                  {!grouped && (
                    <div className="flex items-baseline gap-2">
                      <span className={`text-xs font-bold ${mine ? 'text-boom-700' : 'text-gray-900'}`}>{m.user_name || 'Unknown'}</span>
                      <span className="text-[10px] text-gray-400">{fmtTime(m.created_at)}</span>
                    </div>
                  )}
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
                      <button onClick={() => saveEdit(m.id)} className="text-emerald-600 hover:text-emerald-700 p-1" title="Save"><Check size={14} /></button>
                      <button onClick={() => setEditingId(null)} className="text-gray-400 hover:text-gray-600 p-1" title="Cancel"><X size={14} /></button>
                    </div>
                  ) : (
                    <div className={`relative rounded-lg px-2.5 py-1.5 mt-0.5 text-xs leading-relaxed whitespace-pre-wrap break-words ${
                      mentionsMe ? 'bg-boom-50 ring-1 ring-boom-200/60 text-gray-800' : 'bg-gray-50/80 text-gray-800'
                    }`}>
                      {renderBody(m.body)}
                      {m.edited_at && <span className="text-[9px] text-gray-400 ml-1.5">(edited)</span>}
                      {(mine || isModerator) && (
                        <span className="absolute -top-2 right-1 hidden group-hover/msg:inline-flex items-center gap-0.5 bg-card border border-rule rounded-md shadow-sm px-0.5">
                          {mine && (
                            <button
                              onClick={() => { setEditingId(m.id); setEditDraft(m.body) }}
                              className="text-gray-400 hover:text-boom-600 p-1" title="Edit message"
                            >
                              <Pencil size={11} />
                            </button>
                          )}
                          <button onClick={() => remove(m.id)} className="text-gray-400 hover:text-rose-600 p-1" title="Delete message">
                            <Trash2 size={11} />
                          </button>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Composer — safe-area padding so the send row clears the home
              indicator when the panel is full-screen on phones. */}
          <div className="relative border-t border-divider p-3" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
            {mentionQuery != null && mentionMatches.length > 0 && (
              <div className="absolute bottom-full left-3 right-3 mb-1 bg-card border border-rule rounded-lg shadow-lg overflow-hidden">
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
                placeholder={`Message ${title}… (@ to mention)`}
                rows={2}
                className="flex-1 rounded-lg border border-rule px-3 py-2 text-xs bg-card focus:outline-none focus:ring-1 focus:ring-boom-400 resize-none"
              />
              <button
                onClick={send}
                disabled={sending || !draft.trim()}
                className="btn-primary p-2.5 rounded-lg disabled:opacity-40"
                title="Send (Enter)"
              >
                <Send size={14} />
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
