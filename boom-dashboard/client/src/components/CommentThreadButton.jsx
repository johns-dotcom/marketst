import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquare, X } from 'lucide-react'
import api from '../api'
import { useAuth } from '../context/AuthContext'

// Per-expense comment thread as a self-contained button + portal popover,
// so any row layout (table row, flex div) can mount it without caring
// where the thread renders. Backed by the same expense_comments endpoints
// the Artist Campaigns inline threads use — one thread per expense,
// visible from every page.
//
// Portal + fixed positioning for the same reason as FlagButton: ancestor
// overflow-hidden (cards, sticky cells) can't clip the popover.
// onThreadChange (optional): fires with the full thread array after any
// load/post/delete, so pages that ALSO render comments inline (Planning's
// row strips) stay in sync with edits made through this popover.
export default function CommentThreadButton({ entryId, initialCount = 0, placeholder = 'Add a comment…', onThreadChange }) {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [thread, setThread] = useState(null) // null = not yet loaded
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const btnRef = useRef(null)
  const popRef = useRef(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  const count = thread ? thread.length : initialCount

  const openPopover = async () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) {
      const width = 320
      const left = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), window.innerWidth - width - 8)
      const top = Math.min(r.bottom + 6, window.innerHeight - 60)
      setPos({ top, left })
    }
    setOpen(true)
    if (thread === null) {
      try {
        const res = await api.get(`/bk/entries/${entryId}/comments`)
        const t = res.data?.data || []
        setThread(t)
        onThreadChange?.(entryId, t)
      } catch {
        setThread([])
      }
    }
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const post = async () => {
    const text = draft.trim()
    if (!text || saving) return
    setSaving(true)
    try {
      const r = await api.post(`/bk/entries/${entryId}/comments`, { comment: text })
      if (r.data?.data) {
        setThread(prev => {
          const next = [...(prev || []), r.data.data]
          onThreadChange?.(entryId, next)
          return next
        })
        setDraft('')
      }
    } catch (err) {
      alert('Failed to post comment: ' + (err.response?.data?.error || err.message))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (commentId) => {
    try {
      await api.delete(`/bk/entries/comments/${commentId}`)
      setThread(prev => {
        const next = (prev || []).filter(c => c.id !== commentId)
        onThreadChange?.(entryId, next)
        return next
      })
    } catch (err) {
      alert('Failed to delete comment: ' + (err.response?.data?.error || err.message))
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); open ? setOpen(false) : openPopover() }}
        className={`relative p-1 ${count > 0 ? 'text-sky-600 hover:text-sky-700' : 'text-gray-300 hover:text-sky-600'}`}
        title={count > 0 ? `${count} comment${count === 1 ? '' : 's'}` : 'Add a comment'}
      >
        <MessageSquare size={13} />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[12px] h-3 px-0.5 rounded-full bg-sky-600 text-white text-[8px] font-bold leading-3 text-center">
            {count}
          </span>
        )}
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 60, width: 320 }}
          className="bg-card border border-rule rounded-lg shadow-lg p-3 text-xs"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="font-bold text-gray-900 inline-flex items-center gap-1.5">
              <MessageSquare size={12} className="text-sky-600" /> Comments
            </span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setOpen(false) }}
              className="text-gray-300 hover:text-gray-600"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>
          <div className="max-h-56 overflow-y-auto space-y-1.5 mb-2">
            {thread === null ? (
              <p className="text-[11px] text-gray-400 italic">Loading…</p>
            ) : thread.length === 0 ? (
              <p className="text-[11px] text-gray-400 italic">No comments yet — start the thread.</p>
            ) : thread.map(c => (
              <div key={c.id} className="group/cmt flex items-start gap-2">
                <span className="font-bold text-gray-900 shrink-0">{c.user_name}</span>
                <span className="text-gray-700 whitespace-pre-wrap break-words flex-1">{c.comment}</span>
                <span className="text-[10px] text-gray-400 shrink-0 whitespace-nowrap">
                  {new Date(c.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric' })}
                </span>
                {(c.user_id === user?.id || ['Admin', 'Superadmin'].includes(user?.role)) && (
                  <button
                    onClick={() => remove(c.id)}
                    className="opacity-0 group-hover/cmt:opacity-100 text-gray-300 hover:text-rose-500 shrink-0"
                    title="Delete comment"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, 2000))}
              onKeyDown={(e) => { if (e.key === 'Enter') post() }}
              placeholder={placeholder}
              className="flex-1 rounded-lg border border-rule px-2 py-1.5 text-xs bg-card focus:outline-none focus:ring-1 focus:ring-sky-400"
              autoFocus
            />
            <button
              onClick={post}
              disabled={saving || !draft.trim()}
              className="btn-primary text-xs disabled:opacity-40"
            >
              {saving ? '…' : 'Post'}
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
