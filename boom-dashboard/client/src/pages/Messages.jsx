import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  MessagesSquare, Hash, Lock, Plus, Search, Send, X, Pencil, Trash2, Check,
  SmilePlus, CornerDownRight, Bell, BellOff, ChevronLeft, AtSign, Bot,
  Paperclip, Image as ImageIcon, Download, FileText, ArrowRight,
} from 'lucide-react'
import api from '../api'
import { useAuth } from '../context/AuthContext'
import { useSocket } from '../context/SocketContext'
import { useToast } from '../context/ToastContext'
import Skeleton from '../components/Skeleton'

/**
 * /messages — the team message board.
 *
 * Reads /api/chat (server/routes/chat.js) for everything that persists and
 * server/lib/realtime.js for everything live. Mutations are REST; the socket
 * carries presence, typing, and the server's fan-out of changes other people
 * made. Nothing here writes over a socket.
 *
 * ── Subscriptions ──
 * Every `on()` returns its own unsubscribe and every effect calls it. Skipping
 * that stacks a second handler each time you switch channels, and the third
 * message you receive renders three times.
 *
 * `on` is in the dependency arrays on purpose: SocketContext holds the socket
 * in state, so `on` changes identity once when the socket connects, which is
 * what re-runs these effects and actually attaches them (a child's effect runs
 * before its provider's, so the first pass has no socket yet).
 */

const REACTIONS = ['👍', '🎉', '👀', '❤️', '😂', '🔥']

// Mirrors ATTACH_MAX_FILES in server/routes/chat.js — the server is still the
// authority, this just stops the overflow becoming a 400 after the upload.
const ATTACH_MAX_FILES = 10

function fmtBytes(n) {
  if (!Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export default function Messages() {
  const { channelId: channelIdParam } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { on, emit, online } = useSocket()
  const toast = useToast()

  const activeId = Number(channelIdParam) || null

  const [channels, setChannels] = useState(null)      // null = not loaded
  const [roster, setRoster] = useState([])
  const [messages, setMessages] = useState(null)      // null = not loaded
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [denied, setDenied] = useState(null)          // 'forbidden' | null
  const [typers, setTypers] = useState({})            // userId -> name
  const [thread, setThread] = useState(null)          // { root, replies } | null
  const [composerBusy, setComposerBusy] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState('')
  const [picker, setPicker] = useState(null)          // 'channel' | 'dm' | 'browse' | null
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)        // null = not searching
  const [mobilePane, setMobilePane] = useState('list')

  const listRef = useRef(null)
  const activeIdRef = useRef(null)
  activeIdRef.current = activeId

  const activeChannel = useMemo(
    () => (channels || []).find(c => c.id === activeId) || null,
    [channels, activeId]
  )

  // ── loading ───────────────────────────────────────────────────────────────

  const loadChannels = useCallback(async () => {
    try {
      const r = await api.get('/chat/channels')
      const list = r.data?.data || []
      setChannels(list)
      return list
    } catch (err) {
      setChannels([])
      return []
    }
  }, [])

  useEffect(() => {
    loadChannels()
    api.get('/chat/users')
      .then(r => setRoster(r.data?.data || []))
      .catch(() => setRoster([]))
  }, [loadChannels])

  // Land on the most recent conversation when no channel is in the URL.
  useEffect(() => {
    if (activeId || !channels?.length) return
    const general = channels.find(c => c.name === 'general') || channels[0]
    if (general) navigate(`/messages/${general.id}`, { replace: true })
  }, [activeId, channels, navigate])

  const loadMessages = useCallback(async (id) => {
    if (!id) return
    setMessages(null)
    setDenied(null)
    try {
      const r = await api.get(`/chat/channels/${id}/messages`, { params: { limit: 50 } })
      if (activeIdRef.current !== id) return   // navigated away mid-flight
      setMessages(r.data?.data || [])
      setHasMore(!!r.data?.has_more)
    } catch (err) {
      if (activeIdRef.current !== id) return
      setMessages([])
      setHasMore(false)
      if (err.response?.status === 403) setDenied('forbidden')
      else toast.error(err.response?.data?.error || 'Could not load messages')
    }
  }, [toast])

  useEffect(() => {
    setThread(null)
    setEditingId(null)
    setTypers({})
    if (activeId) loadMessages(activeId)
    else setMessages(null)
  }, [activeId, loadMessages])

  // Mark read on open, and whenever a message lands while you're looking at it.
  //
  // The `chat:read` window event tells the sidebar badge in Layout.jsx to
  // re-read /api/chat/unread. Without it the badge would keep counting the
  // channel you are currently sitting in until you navigated away — Layout
  // otherwise only refetches on a route change and on `message:new`.
  const newestId = messages?.length ? messages[messages.length - 1].id : 0
  useEffect(() => {
    if (!activeId || !newestId) return
    api.post(`/chat/channels/${activeId}/read`)
      .then(() => window.dispatchEvent(new Event('chat:read')))
      .catch(() => {})
    setChannels(prev => (prev || []).map(c => (c.id === activeId ? { ...c, unread: 0 } : c)))
  }, [activeId, newestId])

  // Stick to the bottom as messages arrive.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [newestId, activeId])

  // ── live wiring ───────────────────────────────────────────────────────────

  useEffect(() => {
    const offs = [
      on('message:new', (msg) => {
        if (!msg) return
        if (msg.thread_root_id) {
          setThread(t => (t && t.root.id === msg.thread_root_id
            ? { ...t, replies: [...t.replies, msg] } : t))
          setMessages(prev => (prev || []).map(m => (
            m.id === msg.thread_root_id ? { ...m, reply_count: (m.reply_count || 0) + 1 } : m
          )))
        } else if (msg.channel_id === activeIdRef.current) {
          setMessages(prev => {
            const list = prev || []
            return list.some(m => m.id === msg.id) ? list : [...list, msg]
          })
        }
        // Bump the sidebar for every channel, active or not.
        setChannels(prev => (prev || []).map(c => {
          if (c.id !== msg.channel_id) return c
          const mine = msg.user_id === user?.id
          const looking = c.id === activeIdRef.current
          return {
            ...c,
            last_message: msg.thread_root_id ? c.last_message : {
              body: msg.body, created_at: msg.created_at,
              author_name: msg.author_name, is_system: msg.is_system,
            },
            unread: (mine || looking || msg.thread_root_id) ? c.unread : (c.unread || 0) + 1,
          }
        }))
      }),
      on('message:update', (msg) => {
        if (!msg) return
        setMessages(prev => (prev || []).map(m => (m.id === msg.id ? msg : m)))
        setThread(t => (t ? {
          root: t.root.id === msg.id ? msg : t.root,
          replies: t.replies.map(r => (r.id === msg.id ? msg : r)),
        } : t))
      }),
      on('message:delete', ({ id }) => {
        setMessages(prev => (prev || []).filter(m => m.id !== id))
        setThread(t => (t ? (t.root.id === id ? null : { ...t, replies: t.replies.filter(r => r.id !== id) }) : t))
      }),
      on('channel:new', ({ id }) => {
        emit('channel:subscribe', { channelId: id })
        loadChannels()
      }),
      on('typing', ({ channelId, userId, name }) => {
        if (channelId !== activeIdRef.current || userId === user?.id) return
        setTypers(prev => ({ ...prev, [userId]: name }))
      }),
      on('typing:stop', ({ channelId, userId }) => {
        if (channelId !== activeIdRef.current) return
        setTypers(prev => { const next = { ...prev }; delete next[userId]; return next })
      }),
    ]
    return () => offs.forEach(off => off())
  }, [on, emit, user?.id, loadChannels])

  // A typing signal that never got its stop (tab closed, connection dropped)
  // would otherwise pin "X is typing…" to the footer forever.
  useEffect(() => {
    if (!Object.keys(typers).length) return
    const t = setTimeout(() => setTypers({}), 6000)
    return () => clearTimeout(t)
  }, [typers])

  // ── actions ───────────────────────────────────────────────────────────────

  const sendMessage = useCallback(async (body, threadRootId, files) => {
    if (!activeId) return
    setComposerBusy(true)
    try {
      // Multipart ONLY when there are files. A text-only send stays plain JSON:
      // the server accepts both, and the upload rate limit in index.js keys off
      // the content type — sending every message as multipart would put a
      // 30-per-15-minutes cap on ordinary conversation.
      let payload = { body, thread_root_id: threadRootId || null }
      let config
      if (files?.length) {
        const fd = new FormData()
        fd.append('body', body || '')
        if (threadRootId) fd.append('thread_root_id', String(threadRootId))
        for (const f of files) fd.append('files', f)
        payload = fd
        // Let the browser set Content-Type so it can add the multipart boundary;
        // naming it ourselves produces a body the server cannot parse.
        config = { headers: { 'Content-Type': undefined } }
      }
      const r = await api.post(`/chat/channels/${activeId}/messages`, payload, config)
      const msg = r.data?.data
      // The socket echo usually lands first; this is the fallback for a
      // dropped connection, and it de-dupes on id either way.
      if (msg && !msg.thread_root_id) {
        setMessages(prev => {
          const list = prev || []
          return list.some(m => m.id === msg.id) ? list : [...list, msg]
        })
      } else if (msg) {
        setThread(t => (t && t.root.id === msg.thread_root_id
          ? { ...t, replies: t.replies.some(r2 => r2.id === msg.id) ? t.replies : [...t.replies, msg] }
          : t))
      }
      return true
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not send message')
      return false
    } finally {
      setComposerBusy(false)
    }
  }, [activeId, toast])

  const saveEdit = async (id) => {
    const body = editDraft.trim()
    if (!body) return
    try {
      await api.patch(`/chat/messages/${id}`, { body })
      setEditingId(null)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not edit message')
    }
  }

  const removeMessage = async (id) => {
    if (!window.confirm('Delete this message?')) return
    try {
      await api.delete(`/chat/messages/${id}`)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not delete message')
    }
  }

  const react = async (id, emoji) => {
    try {
      await api.post(`/chat/messages/${id}/react`, { emoji })
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not react')
    }
  }

  const openThread = async (root) => {
    setThread({ root, replies: [] })
    try {
      const r = await api.get(`/chat/channels/${root.channel_id}/messages`, {
        params: { thread: root.id, limit: 100 },
      })
      setThread(t => (t && t.root.id === root.id ? { ...t, replies: r.data?.data || [] } : t))
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not load thread')
    }
  }

  const loadEarlier = async () => {
    if (!messages?.length || loadingMore) return
    setLoadingMore(true)
    try {
      const r = await api.get(`/chat/channels/${activeId}/messages`, {
        params: { before: messages[0].id, limit: 50 },
      })
      const older = r.data?.data || []
      setMessages(prev => [...older, ...(prev || [])])
      setHasMore(!!r.data?.has_more)
    } catch {
      toast.error('Could not load earlier messages')
    } finally {
      setLoadingMore(false)
    }
  }

  const toggleMute = async () => {
    if (!activeId) return
    try {
      const r = await api.post(`/chat/channels/${activeId}/mute`)
      const muted = !!r.data?.data?.muted
      setChannels(prev => (prev || []).map(c => (c.id === activeId ? { ...c, muted } : c)))
      // Muting removes this channel's unread from the nav badge, so the badge
      // has to be told — the count changed without a message arriving.
      window.dispatchEvent(new Event('chat:read'))
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not update channel')
    }
  }

  const runSearch = async (q) => {
    setQuery(q)
    if (q.trim().length < 2) { setResults(null); return }
    try {
      const r = await api.get('/chat/search', { params: { q } })
      setResults(r.data?.data || [])
    } catch {
      setResults([])
    }
  }

  const openChannel = (id) => {
    setResults(null)
    setQuery('')
    setMobilePane('room')
    navigate(`/messages/${id}`)
  }

  const afterCreate = async (id) => {
    setPicker(null)
    emit('channel:subscribe', { channelId: id })
    await loadChannels()
    openChannel(id)
  }

  // ── render ────────────────────────────────────────────────────────────────

  const grouped = useMemo(() => groupByDay(messages || []), [messages])
  const sidebar = useMemo(() => splitChannels(channels || []), [channels])
  const typingLine = Object.values(typers)

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] sm:h-[calc(100vh-8rem)]">
      <div className="flex-1 min-h-0 flex rounded-2xl border border-rule bg-card overflow-hidden">

        {/* ── Sidebar ───────────────────────────────────────────────────── */}
        <aside className={`${mobilePane === 'list' ? 'flex' : 'hidden'} sm:flex w-full sm:w-64 lg:w-72 shrink-0 flex-col border-r border-divider bg-gray-50/50`}>
          <div className="p-3 border-b border-divider">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={query}
                onChange={e => runSearch(e.target.value)}
                placeholder="Search messages"
                className="w-full rounded-lg border border-rule bg-card pl-7 pr-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-boom-400"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-2 py-2 space-y-4">
            {results !== null ? (
              <SearchResults results={results} onOpen={openChannel} />
            ) : channels === null ? (
              <div className="space-y-2 px-1 pt-1">
                {Array.from({ length: 6 }).map((_, i) => <Skeleton.Line key={i} h="h-4" />)}
              </div>
            ) : (
              <>
                <SidebarGroup
                  title="Channels"
                  action={{ label: 'New channel', onClick: () => setPicker('channel') }}
                  secondary={{ label: 'Browse', onClick: () => setPicker('browse') }}
                >
                  {sidebar.channels.map(c => (
                    <ChannelRow key={c.id} channel={c} active={c.id === activeId} onClick={() => openChannel(c.id)} />
                  ))}
                  {!sidebar.channels.length && <EmptyHint text="No channels yet." />}
                </SidebarGroup>

                <SidebarGroup
                  title="Direct messages"
                  action={{ label: 'New message', onClick: () => setPicker('dm') }}
                >
                  {sidebar.dms.map(c => (
                    <ChannelRow
                      key={c.id} channel={c} active={c.id === activeId}
                      onlinePeer={c.peer ? online.has(Number(c.peer.id)) : false}
                      onClick={() => openChannel(c.id)}
                    />
                  ))}
                  {!sidebar.dms.length && <EmptyHint text="No conversations yet." />}
                </SidebarGroup>

                {sidebar.threads.length > 0 && (
                  <SidebarGroup title="Threads">
                    {sidebar.threads.map(c => (
                      <ChannelRow key={c.id} channel={c} active={c.id === activeId} onClick={() => openChannel(c.id)} />
                    ))}
                  </SidebarGroup>
                )}
              </>
            )}
          </div>
        </aside>

        {/* ── Message pane ──────────────────────────────────────────────── */}
        <section className={`${mobilePane === 'room' ? 'flex' : 'hidden'} sm:flex flex-1 min-w-0 flex-col`}>
          {denied === 'forbidden' ? (
            <CenteredNote
              icon={Lock}
              title="You're not in this channel"
              body="Private channels are visible only to their members. Ask someone in it to add you, or pick another conversation."
            />
          ) : !activeId ? (
            <CenteredNote
              icon={MessagesSquare}
              title="Pick a conversation"
              body="Channels and direct messages live in the rail on the left."
            />
          ) : (
            <>
              <header className="px-4 py-2.5 border-b border-divider flex items-center gap-2">
                <button onClick={() => setMobilePane('list')} className="sm:hidden text-gray-400 hover:text-gray-700 p-1 -ml-1">
                  <ChevronLeft size={16} />
                </button>
                <ChannelTitle channel={activeChannel} online={online} />
                <button
                  onClick={toggleMute}
                  className="ml-auto text-gray-400 hover:text-gray-700 p-1.5 rounded-lg hover:bg-gray-100"
                  title={activeChannel?.muted ? 'Unmute this channel' : 'Mute this channel'}
                >
                  {activeChannel?.muted ? <BellOff size={14} /> : <Bell size={14} />}
                </button>
              </header>

              <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3">
                {messages === null ? (
                  <div className="space-y-3 pt-2">
                    {Array.from({ length: 5 }).map((_, i) => <Skeleton.Line key={i} h="h-4" w={i % 2 ? 'w-2/3' : 'w-1/2'} />)}
                  </div>
                ) : !messages.length ? (
                  <div className="text-center pt-16">
                    <MessagesSquare size={24} className="mx-auto text-gray-200 mb-2" />
                    <p className="text-xs text-gray-400">
                      Nothing here yet — start the conversation.
                    </p>
                  </div>
                ) : (
                  <>
                    {hasMore && (
                      <div className="text-center pb-3">
                        <button
                          onClick={loadEarlier}
                          disabled={loadingMore}
                          className="text-[11px] font-semibold text-boom-600 hover:text-boom-700 disabled:opacity-50"
                        >
                          {loadingMore ? 'Loading…' : 'Load earlier messages'}
                        </button>
                      </div>
                    )}
                    {grouped.map(day => (
                      <div key={day.key}>
                        <DayDivider label={day.label} />
                        {day.items.map((m, i) => (
                          <MessageRow
                            key={m.id}
                            message={m}
                            previous={day.items[i - 1]}
                            me={user}
                            roster={roster}
                            editing={editingId === m.id}
                            editDraft={editDraft}
                            setEditDraft={setEditDraft}
                            onStartEdit={() => { setEditingId(m.id); setEditDraft(m.body || '') }}
                            onCancelEdit={() => setEditingId(null)}
                            onSaveEdit={() => saveEdit(m.id)}
                            onDelete={() => removeMessage(m.id)}
                            onReact={(emoji) => react(m.id, emoji)}
                            onOpenThread={() => openThread(m)}
                          />
                        ))}
                      </div>
                    ))}
                  </>
                )}
              </div>

              <Composer
                key={activeId}
                placeholder={`Message ${labelOf(activeChannel)}`}
                roster={roster}
                me={user}
                busy={composerBusy}
                typingLine={typingLine}
                onTyping={(active) => emit(active ? 'typing' : 'typing:stop', { channelId: activeId })}
                onSend={(body, files) => sendMessage(body, null, files)}
              />
            </>
          )}
        </section>

        {/* ── Thread drawer ─────────────────────────────────────────────── */}
        {thread && (
          <aside className="hidden lg:flex w-96 shrink-0 flex-col border-l border-divider">
            <header className="px-4 py-2.5 border-b border-divider flex items-center gap-2">
              <CornerDownRight size={13} className="text-boom-600" />
              <p className="text-sm font-bold text-gray-900">Thread</p>
              <button onClick={() => setThread(null)} className="ml-auto text-gray-400 hover:text-gray-700 p-1">
                <X size={15} />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              <MessageRow message={thread.root} me={user} roster={roster} readOnly />
              <div className="my-2 border-t border-divider" />
              {thread.replies.map((m, i) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  previous={thread.replies[i - 1]}
                  me={user}
                  roster={roster}
                  onDelete={() => removeMessage(m.id)}
                  compact
                />
              ))}
              {!thread.replies.length && (
                <p className="text-[11px] text-gray-400 italic pt-2">No replies yet.</p>
              )}
            </div>
            <Composer
              key={`thread-${thread.root.id}`}
              placeholder="Reply…"
              roster={roster}
              me={user}
              busy={composerBusy}
              typingLine={[]}
              onTyping={() => {}}
              onSend={(body, files) => sendMessage(body, thread.root.id, files)}
            />
          </aside>
        )}
      </div>

      {picker === 'channel' && <NewChannelModal roster={roster} me={user} onClose={() => setPicker(null)} onCreated={afterCreate} onError={toast.error} />}
      {picker === 'dm' && <NewDmModal roster={roster} me={user} online={online} onClose={() => setPicker(null)} onCreated={afterCreate} onError={toast.error} />}
      {picker === 'browse' && <BrowseChannelsModal onClose={() => setPicker(null)} onJoined={afterCreate} onError={toast.error} />}
    </div>
  )
}

// ── sidebar pieces ──────────────────────────────────────────────────────────

function splitChannels(list) {
  return {
    channels: list.filter(c => c.type === 'channel'),
    dms: list.filter(c => c.type === 'dm'),
    threads: list.filter(c => c.type === 'object'),
  }
}

function labelOf(channel) {
  if (!channel) return ''
  if (channel.type === 'dm') return channel.display_name || 'Direct message'
  return `#${channel.name || 'channel'}`
}

function SidebarGroup({ title, action, secondary, children }) {
  return (
    <div>
      <div className="flex items-center gap-1 px-2 pb-1">
        <p className="text-[10px] font-black uppercase tracking-wider text-gray-400">{title}</p>
        {secondary && (
          <button onClick={secondary.onClick} className="ml-auto text-[10px] font-bold text-gray-400 hover:text-boom-600">
            {secondary.label}
          </button>
        )}
        {action && (
          <button
            onClick={action.onClick}
            className={`${secondary ? '' : 'ml-auto'} text-gray-400 hover:text-boom-600 p-0.5`}
            title={action.label}
          >
            <Plus size={13} />
          </button>
        )}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function EmptyHint({ text }) {
  return <p className="px-2 py-1 text-[11px] text-gray-400 italic">{text}</p>
}

function ChannelRow({ channel, active, onlinePeer, onClick }) {
  const unread = channel.unread || 0
  const isDm = channel.type === 'dm'
  const Icon = channel.is_private ? Lock : Hash
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
        active ? 'bg-boom-50 text-boom-700' : 'hover:bg-gray-100 text-gray-700'
      }`}
    >
      {isDm ? (
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${onlinePeer ? 'bg-emerald-500' : 'bg-gray-300'}`} />
      ) : (
        <Icon size={12} className="shrink-0 text-gray-400" />
      )}
      <span className={`flex-1 truncate text-xs ${unread ? 'font-black text-gray-900' : 'font-semibold'}`}>
        {isDm ? (channel.display_name || 'Direct message') : channel.name}
      </span>
      {channel.muted && <BellOff size={10} className="shrink-0 text-gray-300" />}
      {unread > 0 && (
        <span className="shrink-0 min-w-[17px] h-[17px] px-1 rounded-full bg-boom-600 text-white text-[10px] font-black leading-[17px] text-center">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  )
}

function ChannelTitle({ channel, online }) {
  if (!channel) return <p className="text-sm font-bold text-gray-900">Messages</p>
  const isDm = channel.type === 'dm'
  const peerOnline = isDm && channel.peer ? online.has(Number(channel.peer.id)) : false
  return (
    <div className="min-w-0">
      <p className="text-sm font-bold text-gray-900 truncate flex items-center gap-1.5">
        {isDm
          ? <span className={`w-1.5 h-1.5 rounded-full ${peerOnline ? 'bg-emerald-500' : 'bg-gray-300'}`} />
          : (channel.is_private ? <Lock size={12} className="text-gray-400" /> : <Hash size={12} className="text-gray-400" />)}
        {isDm ? (channel.display_name || 'Direct message') : channel.name}
      </p>
      <p className="text-[10px] text-gray-400 truncate">
        {channel.topic || (isDm
          ? (peerOnline ? 'Online now' : 'Offline')
          : `${(channel.members || []).length} member${(channel.members || []).length === 1 ? '' : 's'}`)}
      </p>
    </div>
  )
}

function SearchResults({ results, onOpen }) {
  if (!results.length) {
    return <p className="px-2 py-3 text-[11px] text-gray-400 italic">No matches.</p>
  }
  return (
    <div className="space-y-1">
      <p className="px-2 pb-1 text-[10px] font-black uppercase tracking-wider text-gray-400">
        {results.length} result{results.length === 1 ? '' : 's'}
      </p>
      {results.map(r => (
        <button
          key={r.id}
          onClick={() => onOpen(r.channel_id)}
          className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-gray-100"
        >
          <p className="text-[10px] font-bold text-gray-400 truncate">
            {r.channel_type === 'dm' ? (r.dm_peer || 'Direct message') : `#${r.channel_name}`}
            {' · '}{r.author_name || 'Market Street · Bot'}
          </p>
          <p className="text-xs text-gray-700 line-clamp-2">{r.body}</p>
        </button>
      ))}
    </div>
  )
}

// ── message pieces ──────────────────────────────────────────────────────────

/**
 * Group messages into day buckets.
 *
 * Both the bucket key and its label come from the SAME Date object read in the
 * SAME (local) timezone. Deriving a label from a key that was built elsewhere
 * is how a day boundary ends up off by one, and `String(d).slice(0, 10)` yields
 * "Tue Sep 01", not a date.
 */
function groupByDay(list) {
  const out = []
  for (const m of list) {
    const d = new Date(m.created_at)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    if (!out.length || out[out.length - 1].key !== key) {
      out.push({ key, label: dayLabel(d), items: [] })
    }
    out[out.length - 1].items.push(m)
  }
  return out
}

function dayLabel(d) {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const same = (a, b) => a.toDateString() === b.toDateString()
  if (same(d, today)) return 'Today'
  if (same(d, yesterday)) return 'Yesterday'
  return d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  })
}

function fmtTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function DayDivider({ label }) {
  return (
    <div className="flex items-center gap-2 py-3">
      <div className="flex-1 border-t border-divider" />
      <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">{label}</span>
      <div className="flex-1 border-t border-divider" />
    </div>
  )
}

function MessageRow({
  message: m, previous, me, roster, editing, editDraft, setEditDraft,
  onStartEdit, onCancelEdit, onSaveEdit, onDelete, onReact, onOpenThread,
  readOnly, compact,
}) {
  const [showReactions, setShowReactions] = useState(false)

  // Collapse the author/time header when the same person posts again within
  // five minutes — reads as a continued thought rather than a new statement.
  const grouped = !!previous
    && previous.user_id === m.user_id
    && previous.is_system === m.is_system
    && (new Date(m.created_at) - new Date(previous.created_at)) < 5 * 60 * 1000

  const mine = m.user_id === me?.id
  const isMod = ['Admin', 'Superadmin'].includes(me?.role)
  const mentionsMe = !!me?.name && typeof m.body === 'string'
    && m.body.toLowerCase().includes('@' + me.name.toLowerCase())
  const canEdit = mine && !m.is_system && !readOnly
  const canDelete = (mine || isMod) && !readOnly

  return (
    <div className={`group/msg relative ${grouped ? 'mt-0.5' : 'mt-3'}`}>
      {!grouped && (
        <div className="flex items-baseline gap-2">
          {m.is_system ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-gray-900">
              {/* A filled mark, not a bare glyph — at a glance the feed has to
                  read as "this was not a person", the same way Slack's app
                  badge does. */}
              <span className="inline-flex items-center justify-center w-4 h-4 rounded bg-boom-600">
                <Bot size={10} className="text-white" />
              </span>
              Market Street
              <span className="px-1 py-px rounded bg-gray-100 text-[9px] font-black uppercase tracking-wide text-gray-500">Bot</span>
            </span>
          ) : (
            <span className={`text-xs font-bold ${mine ? 'text-boom-700' : 'text-gray-900'}`}>
              {m.author_name || 'Unknown'}
            </span>
          )}
          <span className="text-[10px] text-gray-400">{fmtTime(m.created_at)}</span>
        </div>
      )}

      {editing ? (
        <div className="mt-1 flex items-end gap-1.5">
          <textarea
            value={editDraft}
            onChange={e => setEditDraft(e.target.value.slice(0, 8000))}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSaveEdit() }
              if (e.key === 'Escape') onCancelEdit()
            }}
            rows={2}
            autoFocus
            className="flex-1 rounded-lg border border-rule px-2 py-1.5 text-xs bg-card focus:outline-none focus:ring-1 focus:ring-boom-400 resize-none"
          />
          <button onClick={onSaveEdit} className="text-emerald-600 hover:text-emerald-700 p-1" title="Save"><Check size={14} /></button>
          <button onClick={onCancelEdit} className="text-gray-400 hover:text-gray-600 p-1" title="Cancel"><X size={14} /></button>
        </div>
      ) : (
        <div className={`rounded-lg px-2.5 py-1.5 text-xs leading-relaxed whitespace-pre-wrap break-words ${
          mentionsMe ? 'bg-boom-50 ring-1 ring-boom-200/60 text-gray-800' : 'text-gray-800'
        } ${compact ? '' : ''}`}>
          {m.is_system
            ? <SystemBody body={m.body} link={m.meta?.link} />
            : <RenderedBody body={m.body} roster={roster} me={me} />}
          {m.edited_at && <span className="text-[9px] text-gray-400 ml-1.5">(edited)</span>}
        </div>
      )}

      {Array.isArray(m.attachments) && m.attachments.length > 0 && (
        <div className="mt-1 px-2.5 flex flex-wrap gap-2">
          {m.attachments.map(a => <Attachment key={a.id} att={a} />)}
        </div>
      )}

      {/* Reactions */}
      {Array.isArray(m.reactions) && m.reactions.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1 px-2.5">
          {m.reactions.map(r => {
            const iReacted = Array.isArray(r.users) && r.users.map(Number).includes(Number(me?.id))
            return (
              <button
                key={r.emoji}
                onClick={() => onReact?.(r.emoji)}
                disabled={!onReact}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[11px] ${
                  iReacted ? 'border-boom-300 bg-boom-50 text-boom-700' : 'border-rule bg-card text-gray-600 hover:bg-gray-50'
                }`}
              >
                <span>{r.emoji}</span>
                <span className="font-bold">{r.count}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Reply count */}
      {!compact && (m.reply_count > 0) && (
        <button
          onClick={onOpenThread}
          className="ml-2.5 mt-1 inline-flex items-center gap-1 text-[11px] font-bold text-boom-600 hover:text-boom-700"
        >
          <CornerDownRight size={11} />
          {m.reply_count} {m.reply_count === 1 ? 'reply' : 'replies'}
        </button>
      )}

      {/* Hover actions */}
      {!editing && !readOnly && (onReact || onOpenThread || canEdit || canDelete) && (
        <div className="absolute -top-2 right-1 hidden group-hover/msg:flex items-center gap-0.5 bg-card border border-rule rounded-md shadow-sm px-0.5 z-10">
          {onReact && (
            <div className="relative">
              <button
                onClick={() => setShowReactions(v => !v)}
                className="text-gray-400 hover:text-boom-600 p-1" title="Add reaction"
              >
                <SmilePlus size={12} />
              </button>
              {showReactions && (
                <div className="absolute bottom-full right-0 mb-1 flex gap-0.5 bg-card border border-rule rounded-lg shadow-lg px-1 py-1">
                  {REACTIONS.map(e => (
                    <button
                      key={e}
                      onClick={() => { onReact(e); setShowReactions(false) }}
                      className="text-sm hover:scale-125 transition-transform px-0.5"
                    >
                      {e}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {onOpenThread && !compact && (
            <button onClick={onOpenThread} className="text-gray-400 hover:text-boom-600 p-1" title="Reply in thread">
              <CornerDownRight size={12} />
            </button>
          )}
          {canEdit && onStartEdit && (
            <button onClick={onStartEdit} className="text-gray-400 hover:text-boom-600 p-1" title="Edit message">
              <Pencil size={12} />
            </button>
          )}
          {canDelete && onDelete && (
            <button onClick={onDelete} className="text-gray-400 hover:text-rose-600 p-1" title="Delete message">
              <Trash2 size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// Highlight known @Name tokens as chips — the same treatment CampaignChat gives
// them, so the two surfaces read as one product. A mention of YOU gets the
// accent background.
function RenderedBody({ body, roster, me }) {
  const regex = useMemo(() => {
    const names = (roster || []).map(r => r.name).filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const all = ['channel', 'here', 'everyone', ...names]
    return new RegExp(`@(${all.join('|')})\\b`, 'gi')
  }, [roster])

  if (!body) return null
  const parts = []
  let last = 0
  let match
  regex.lastIndex = 0
  while ((match = regex.exec(body))) {
    if (match.index > last) parts.push(body.slice(last, match.index))
    const isMe = !!me?.name && match[1].toLowerCase() === me.name.toLowerCase()
    parts.push(
      <span key={match.index} className={`font-bold rounded px-0.5 ${isMe ? 'bg-boom-100 text-boom-700' : 'text-boom-600'}`}>
        @{match[1]}
      </span>
    )
    last = match.index + match[0].length
  }
  if (last < body.length) parts.push(body.slice(last))
  return <>{parts}</>
}

/**
 * A bot message: `*asterisks*` render bold, and meta.link becomes "View →".
 *
 * Deliberately NOT markdown. The only thing the bot emits is emphasis on the
 * nouns it already controls (who did what, to which record), so a parser would
 * be a dependency and an injection surface for one syntax. Everything outside
 * the asterisks is rendered as plain text by React, which escapes it.
 *
 * The link is an in-app path, so it routes client-side rather than reloading —
 * '/bk/ledger?entry=41' must land on the ledger with the drawer open, not
 * restart the app.
 */
function SystemBody({ body, link }) {
  const parts = []
  const re = /\*([^*]+)\*/g
  let last = 0
  let m
  while ((m = re.exec(body || ''))) {
    if (m.index > last) parts.push(body.slice(last, m.index))
    parts.push(<strong key={m.index} className="font-bold text-gray-900">{m[1]}</strong>)
    last = m.index + m[0].length
  }
  if (last < (body || '').length) parts.push(body.slice(last))

  return (
    <span className="text-gray-700">
      {parts}
      {link && (
        <Link
          to={link}
          className="ml-2 inline-flex items-center gap-0.5 text-[11px] font-bold text-boom-600 hover:text-boom-700 whitespace-nowrap"
        >
          View <ArrowRight size={10} />
        </Link>
      )}
    </span>
  )
}

// ── composer ────────────────────────────────────────────────────────────────

function Composer({ placeholder, roster, me, busy, typingLine, onTyping, onSend }) {
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState([])
  const [dragging, setDragging] = useState(false)
  const [mentionQuery, setMentionQuery] = useState(null)   // { query, start } | null
  const inputRef = useRef(null)
  const fileRef = useRef(null)
  const typingRef = useRef(false)
  const stopTimer = useRef(null)
  const dragDepth = useRef(0)

  const addFiles = (incoming) => {
    const list = Array.from(incoming || []).filter(Boolean)
    if (!list.length) return
    setFiles(prev => {
      // The server caps at 10 per message; stop here so the overflow is visible
      // in the tray rather than arriving as a 400 after the upload.
      const next = [...prev, ...list].slice(0, ATTACH_MAX_FILES)
      return next
    })
  }
  const removeFile = (i) => setFiles(prev => prev.filter((_, n) => n !== i))

  // Debounced typing signal: one 'typing' on the first keystroke, one
  // 'typing:stop' 2s after the last. Emitting per-keystroke would put a socket
  // frame on the wire for every character typed by every person in the room.
  const signalTyping = () => {
    if (!typingRef.current) { typingRef.current = true; onTyping(true) }
    clearTimeout(stopTimer.current)
    stopTimer.current = setTimeout(() => { typingRef.current = false; onTyping(false) }, 2000)
  }
  const stopTyping = () => {
    clearTimeout(stopTimer.current)
    if (typingRef.current) { typingRef.current = false; onTyping(false) }
  }
  useEffect(() => () => clearTimeout(stopTimer.current), [])

  // @-autocomplete: active when the text before the caret ends in "@partial".
  // Same rule as CampaignChat.jsx's.
  const onChange = (e) => {
    const v = e.target.value.slice(0, 8000)
    setDraft(v)
    signalTyping()
    const caret = e.target.selectionStart
    const before = v.slice(0, caret)
    const at = before.lastIndexOf('@')
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1]))) {
      const q = before.slice(at + 1)
      if (q.length <= 40 && !q.includes('\n')) { setMentionQuery({ query: q.toLowerCase(), start: at }); return }
    }
    setMentionQuery(null)
  }

  const matches = useMemo(() => {
    if (mentionQuery == null) return []
    const people = (roster || [])
      .filter(u => u.id !== me?.id && (u.name || '').toLowerCase().includes(mentionQuery.query))
      .map(u => ({ key: `u${u.id}`, name: u.name }))
    const broadcast = ['channel', 'here', 'everyone']
      .filter(w => w.startsWith(mentionQuery.query))
      .map(w => ({ key: `b${w}`, name: w, broadcast: true }))
    return [...broadcast, ...people].slice(0, 6)
  }, [mentionQuery, roster, me])

  const insertMention = (m) => {
    const el = inputRef.current
    const caret = el ? el.selectionStart : draft.length
    setDraft(draft.slice(0, mentionQuery.start) + '@' + m.name + ' ' + draft.slice(caret))
    setMentionQuery(null)
    requestAnimationFrame(() => el?.focus())
  }

  const submit = async () => {
    const body = draft.trim()
    // An attachment with no caption is a valid message — the server allows it.
    if ((!body && !files.length) || busy) return
    stopTyping()
    const ok = await onSend(body, files)
    if (ok) { setDraft(''); setFiles([]); setMentionQuery(null) }
  }

  // Paste-to-upload: a screenshot on the clipboard arrives as a file on the
  // paste event. Only intercept when there ARE files — pasting text must stay
  // ordinary text.
  const onPaste = (e) => {
    const pasted = Array.from(e.clipboardData?.files || [])
    if (!pasted.length) return
    e.preventDefault()
    addFiles(pasted)
  }

  // dragDepth counts enter/leave pairs. Without it, dragging across a child
  // element fires dragleave on the parent and the highlight flickers off while
  // the file is still over the drop zone.
  const onDragEnter = (e) => { e.preventDefault(); dragDepth.current += 1; if (e.dataTransfer?.types?.includes('Files')) setDragging(true) }
  const onDragLeave = (e) => { e.preventDefault(); dragDepth.current -= 1; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false) } }
  const onDrop = (e) => { e.preventDefault(); dragDepth.current = 0; setDragging(false); addFiles(e.dataTransfer?.files) }

  return (
    <div
      className={`relative border-t border-divider p-3 ${dragging ? 'bg-boom-50/60' : ''}`}
      style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
      onDragEnter={onDragEnter}
      onDragOver={e => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="absolute inset-2 rounded-xl border-2 border-dashed border-boom-400 bg-boom-50/80 flex items-center justify-center pointer-events-none z-10">
          <p className="text-xs font-bold text-boom-700">Drop to attach</p>
        </div>
      )}
      {typingLine.length > 0 && (
        <p className="absolute -top-5 left-4 text-[10px] text-gray-400 italic">
          {typingLine.length === 1 ? `${typingLine[0]} is typing…` : `${typingLine.length} people are typing…`}
        </p>
      )}
      {mentionQuery != null && matches.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 mb-1 bg-card border border-rule rounded-lg shadow-lg overflow-hidden z-20">
          {matches.map(m => (
            <button
              key={m.key}
              onMouseDown={e => { e.preventDefault(); insertMention(m) }}
              className="w-full flex items-center gap-1.5 text-left px-3 py-1.5 text-xs font-semibold text-gray-800 hover:bg-boom-50"
            >
              <AtSign size={11} className="text-gray-400" />
              {m.name}
              {m.broadcast && <span className="ml-auto text-[10px] font-normal text-gray-400">notifies everyone here</span>}
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="inline-flex items-center gap-1.5 max-w-[200px] pl-2 pr-1 py-1 rounded-lg border border-rule bg-gray-50 text-[11px]">
              {f.type?.startsWith('image/') ? <ImageIcon size={11} className="shrink-0 text-gray-400" /> : <Paperclip size={11} className="shrink-0 text-gray-400" />}
              <span className="truncate font-semibold text-gray-700">{f.name}</span>
              <span className="shrink-0 text-gray-400">{fmtBytes(f.size)}</span>
              <button onClick={() => removeFile(i)} className="shrink-0 text-gray-400 hover:text-rose-600 p-0.5" title="Remove">
                <X size={10} />
              </button>
            </span>
          ))}
          {files.length >= ATTACH_MAX_FILES && (
            <span className="text-[10px] text-gray-400 self-center">Max {ATTACH_MAX_FILES} files</span>
          )}
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={e => { addFiles(e.target.files); e.target.value = '' }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="shrink-0 text-gray-400 hover:text-boom-600 p-2.5 rounded-lg hover:bg-gray-100"
          title="Attach a file"
        >
          <Paperclip size={15} />
        </button>
        <textarea
          ref={inputRef}
          value={draft}
          onChange={onChange}
          onPaste={onPaste}
          onBlur={stopTyping}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && mentionQuery != null && matches.length > 0) {
              e.preventDefault(); insertMention(matches[0]); return
            }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return }
            if (e.key === 'Escape') setMentionQuery(null)
          }}
          placeholder={`${placeholder}  (@ to mention · paste or drop a file to attach)`}
          rows={2}
          className="flex-1 rounded-lg border border-rule px-3 py-2 text-xs bg-card focus:outline-none focus:ring-1 focus:ring-boom-400 resize-none"
        />
        <button
          onClick={submit}
          disabled={busy || (!draft.trim() && !files.length)}
          className="btn-primary p-2.5 rounded-lg disabled:opacity-40"
          title="Send (Enter)"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  )
}

// ── attachments ─────────────────────────────────────────────────────────────

/**
 * One attachment: an image renders inline, anything else is a download chip.
 *
 * ── How the bytes are reached, and why it differs by storage ──
 * The server never puts a session token in a URL (see routes/chat.js), so there
 * are exactly two ways to load one of these:
 *
 *   att.url present  — a short-lived presigned R2 URL. Safe directly in an
 *                      <img src> or an <a href>; it carries no session, is
 *                      scoped to one object, and expires.
 *   att.url absent   — the bytes are in our database. They come through
 *                      GET /api/chat/attachments/:id behind the normal
 *                      Authorization header, which an <img src> cannot send —
 *                      so we fetch through axios and hand the tag a blob URL.
 *
 * The presigned case deliberately does NOT go through axios: that would be a
 * cross-origin XHR to the bucket and would need CORS configured on R2. A plain
 * <img src> and a plain link do not.
 */
function Attachment({ att }) {
  const isImage = /^image\//.test(att.mime || '')
  if (isImage) return <AttachmentImage att={att} />
  return <AttachmentChip att={att} />
}

function AttachmentImage({ att }) {
  const [blobUrl, setBlobUrl] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (att.url) return undefined            // presigned — nothing to fetch
    let revoked = false
    let made = null
    api.get(`/chat/attachments/${att.id}`, { responseType: 'blob' })
      .then(r => {
        if (revoked) return
        made = URL.createObjectURL(r.data)
        setBlobUrl(made)
      })
      .catch(() => setFailed(true))
    // Revoke on unmount — an object URL pins its blob in memory for the life of
    // the document otherwise, and a long channel scroll makes a lot of them.
    return () => { revoked = true; if (made) URL.revokeObjectURL(made) }
  }, [att.id, att.url])

  const src = att.url || blobUrl
  if (failed) return <AttachmentChip att={att} />
  if (!src) return <div className="w-40 h-28 rounded-lg skeleton-shimmer" />

  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="block" title={att.filename}>
      <img
        src={src}
        alt={att.filename}
        onError={() => setFailed(true)}
        className="max-h-60 max-w-[min(100%,20rem)] rounded-lg border border-rule object-contain bg-gray-50"
      />
    </a>
  )
}

function AttachmentChip({ att }) {
  const [busy, setBusy] = useState(false)
  const isPdf = /pdf/i.test(att.mime || '')

  // A presigned URL is already a working link, so use it directly. Otherwise
  // pull the bytes through the authenticated endpoint and save them client-side,
  // which is also what puts the real filename on the saved file.
  const download = async (e) => {
    if (att.url) return                       // let the anchor do its job
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      const r = await api.get(`/chat/attachments/${att.id}`, { responseType: 'blob' })
      const url = URL.createObjectURL(r.data)
      const a = document.createElement('a')
      a.href = url
      a.download = att.filename || 'file'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } finally {
      setBusy(false)
    }
  }

  return (
    <a
      href={att.url || '#'}
      onClick={download}
      target={att.url ? '_blank' : undefined}
      rel={att.url ? 'noopener noreferrer' : undefined}
      className="inline-flex items-center gap-2 max-w-[18rem] pl-2 pr-3 py-1.5 rounded-lg border border-rule bg-card hover:bg-gray-50 transition-colors"
      title={att.filename}
    >
      {isPdf ? <FileText size={14} className="shrink-0 text-rose-500" /> : <Paperclip size={14} className="shrink-0 text-gray-400" />}
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold text-gray-800">{att.filename}</span>
        <span className="block text-[10px] text-gray-400">{fmtBytes(att.size_bytes)}</span>
      </span>
      <Download size={12} className={`shrink-0 ml-auto ${busy ? 'opacity-40' : 'text-gray-400'}`} />
    </a>
  )
}

// ── panels + modals ─────────────────────────────────────────────────────────

function CenteredNote({ icon: Icon, title, body }) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center max-w-sm">
        <Icon size={26} className="mx-auto text-gray-300 mb-3" />
        <p className="text-sm font-bold text-gray-900">{title}</p>
        <p className="text-xs text-gray-500 mt-1 leading-relaxed">{body}</p>
      </div>
    </div>
  )
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-card border border-rule shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-divider flex items-center">
          <p className="text-sm font-bold text-gray-900">{title}</p>
          <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-700 p-1"><X size={15} /></button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}

function NewChannelModal({ roster, me, onClose, onCreated, onError }) {
  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [picked, setPicked] = useState(() => new Set())
  const [busy, setBusy] = useState(false)

  // Mirrors the server's normalisation so the preview can't disagree with what
  // gets stored.
  const clean = name.trim().replace(/^#/, '').replace(/\s+/g, '-').toLowerCase()
    .replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80)

  const create = async () => {
    if (!clean || busy) return
    setBusy(true)
    try {
      const r = await api.post('/chat/channels', {
        name: clean, topic, is_private: isPrivate, member_ids: [...picked],
      })
      const id = r.data?.data?.id
      if (id) onCreated(id)
    } catch (err) {
      onError(err.response?.data?.error || 'Could not create channel')
    } finally { setBusy(false) }
  }

  return (
    <Modal title="New channel" onClose={onClose}>
      <label className="block text-[10px] font-black uppercase tracking-wider text-gray-400 mb-1">Name</label>
      <div className="flex items-center gap-1 rounded-lg border border-rule bg-card px-2">
        <Hash size={12} className="text-gray-400" />
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') create() }}
          placeholder="marketing"
          autoFocus
          className="flex-1 py-2 text-xs bg-transparent focus:outline-none"
        />
      </div>
      {clean && clean !== name.trim().toLowerCase() && (
        <p className="text-[10px] text-gray-400 mt-1">Will be created as #{clean}</p>
      )}

      <label className="block text-[10px] font-black uppercase tracking-wider text-gray-400 mb-1 mt-3">Topic (optional)</label>
      <input
        value={topic}
        onChange={e => setTopic(e.target.value)}
        placeholder="What's this channel for?"
        className="w-full rounded-lg border border-rule bg-card px-2 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-boom-400"
      />

      <label className="flex items-center gap-2 mt-3 cursor-pointer">
        <input type="checkbox" checked={isPrivate} onChange={e => setIsPrivate(e.target.checked)} className="rounded" />
        <span className="text-xs text-gray-700">Private — only invited people can see it</span>
      </label>

      <label className="block text-[10px] font-black uppercase tracking-wider text-gray-400 mb-1 mt-3">Add people</label>
      <div className="max-h-40 overflow-y-auto rounded-lg border border-rule divide-y divide-divider">
        {(roster || []).filter(u => u.id !== me?.id).map(u => (
          <label key={u.id} className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-gray-50">
            <input
              type="checkbox"
              checked={picked.has(u.id)}
              onChange={() => setPicked(prev => {
                const next = new Set(prev)
                if (next.has(u.id)) next.delete(u.id); else next.add(u.id)
                return next
              })}
              className="rounded"
            />
            <span className="text-xs text-gray-700">{u.name}</span>
          </label>
        ))}
      </div>

      <button onClick={create} disabled={!clean || busy} className="btn-primary w-full mt-4 py-2 rounded-lg text-xs disabled:opacity-40">
        {busy ? 'Creating…' : 'Create channel'}
      </button>
    </Modal>
  )
}

function NewDmModal({ roster, me, online, onClose, onCreated, onError }) {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const people = (roster || [])
    .filter(u => u.id !== me?.id)
    .filter(u => (u.name || '').toLowerCase().includes(q.toLowerCase()))

  const open = async (userId) => {
    if (busy) return
    setBusy(true)
    try {
      const r = await api.post('/chat/dm', { user_id: userId })
      const id = r.data?.data?.id
      if (id) onCreated(id)
    } catch (err) {
      onError(err.response?.data?.error || 'Could not open conversation')
    } finally { setBusy(false) }
  }

  return (
    <Modal title="New message" onClose={onClose}>
      <input
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Search people"
        autoFocus
        className="w-full rounded-lg border border-rule bg-card px-2 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-boom-400"
      />
      <div className="mt-2 max-h-64 overflow-y-auto divide-y divide-divider">
        {people.map(u => (
          <button
            key={u.id}
            onClick={() => open(u.id)}
            disabled={busy}
            className="w-full flex items-center gap-2 px-2 py-2 text-left hover:bg-gray-50 disabled:opacity-50"
          >
            <span className={`w-1.5 h-1.5 rounded-full ${online.has(Number(u.id)) ? 'bg-emerald-500' : 'bg-gray-300'}`} />
            <span className="text-xs font-semibold text-gray-800">{u.name}</span>
            <span className="ml-auto text-[10px] text-gray-400">{u.role}</span>
          </button>
        ))}
        {!people.length && <p className="px-2 py-3 text-[11px] text-gray-400 italic">Nobody matches that.</p>}
      </div>
    </Modal>
  )
}

function BrowseChannelsModal({ onClose, onJoined, onError }) {
  const [list, setList] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.get('/chat/channels/public')
      .then(r => setList(r.data?.data || []))
      .catch(() => setList([]))
  }, [])

  const join = async (id) => {
    if (busy) return
    setBusy(true)
    try {
      await api.post(`/chat/channels/${id}/join`)
      onJoined(id)
    } catch (err) {
      onError(err.response?.data?.error || 'Could not join channel')
    } finally { setBusy(false) }
  }

  return (
    <Modal title="Browse channels" onClose={onClose}>
      {list === null ? (
        <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton.Line key={i} h="h-4" />)}</div>
      ) : !list.length ? (
        <p className="text-[11px] text-gray-400 italic">You're already in every public channel.</p>
      ) : (
        <div className="max-h-72 overflow-y-auto divide-y divide-divider">
          {list.map(c => (
            <div key={c.id} className="flex items-center gap-2 py-2">
              <Hash size={12} className="text-gray-400" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-gray-900 truncate">{c.name}</p>
                <p className="text-[10px] text-gray-400 truncate">
                  {c.topic || `${c.member_count} member${c.member_count === 1 ? '' : 's'}`}
                </p>
              </div>
              <button
                onClick={() => join(c.id)}
                disabled={busy}
                className="text-[11px] font-bold text-boom-600 hover:text-boom-700 disabled:opacity-50"
              >
                Join
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
