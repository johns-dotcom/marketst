// My Work — one list of what is mine, and the dates that involve me.
//
// Rebuilt 2026-09-19 (John: "improve the look"). Decisions: a plain header
// with a summary line (Home does the greeting); ONE full-width list with the
// detail expanding in place, grouped by when it is due; an inline composer
// with @ to assign; "This week, mine" from the calendar feed (my tasks, my
// releases, and the money dates I can open); a "Waiting on you" rail that
// holds only what this person can unblock and hides when empty.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Check, Circle, Trash2, AtSign, ChevronDown, ChevronRight, Calendar as CalendarIcon, Inbox, MessageSquare, Hourglass, Mail, Footprints, Loader, Flag } from 'lucide-react'
import api from '../api'
import { isPastLocal, daysUntilLocal } from '../utils'
import { useAuth } from '../context/AuthContext'
import PageHeader from '../components/PageHeader'
import EmailPreviewModal from '../components/EmailPreviewModal'
import EmptyState from '../components/EmptyState'
import { useTour } from '../components/Tour'

const TASK_CATEGORIES = ['General', 'Release', 'Marketing', 'A&R', 'Finance', 'Legal', 'Operations']
const PRIORITIES = ['Urgent', 'High', 'Medium', 'Low']
const PRIORITY_DOT = { Urgent: 'bg-red-600', High: 'bg-boom-500', Medium: 'bg-amber-400', Low: 'bg-gray-300' }
const STATUSES = ['To Do', 'In Progress', 'Done']
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const dueLabel = (d) => {
  if (!d) return null
  const n = daysUntilLocal(d)
  if (n == null) return null
  if (n < -1) return `${-n} days overdue`
  if (n === -1) return 'yesterday'
  if (n === 0) return 'today'
  if (n === 1) return 'tomorrow'
  if (n < 7) return new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' })
  return new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
const bucketOf = (t) => {
  if (!t.due_date) return 'nodate'
  const n = daysUntilLocal(t.due_date)
  if (n < 0) return 'overdue'
  if (n === 0) return 'today'
  if (n < 7) return 'week'
  return 'later'
}
const BUCKETS = [['overdue', 'Overdue'], ['today', 'Today'], ['week', 'This week'], ['later', 'Later'], ['nodate', 'No date']]

export default function MyWork() {
  const { user, canView } = useAuth()
  const { tours, isDone, doneVersion } = useTour()
  const [data, setData] = useState(null)
  const [team, setTeam] = useState([])
  const [week, setWeek] = useState(null)
  const [loop, setLoop] = useState(null)
  const [mentions, setMentions] = useState(0)
  const [expanded, setExpanded] = useState(null)
  const [showDone, setShowDone] = useState(false)
  const [pendingEmail, setPendingEmail] = useState(null)
  const [error, setError] = useState('')
  const composerRef = useRef(null)

  const load = () => api.get('/team/my-work').then((r) => setData(r.data?.data || { tasks: [], releases: [] })).catch(() => setError('Could not load your work'))
  useEffect(() => {
    load()
    api.get('/team').then((r) => setTeam(r.data?.data || [])).catch(() => {})
    api.get('/calendar').then((r) => setWeek(r.data?.events || [])).catch(() => setWeek([]))
    api.get('/dashboard/loop').then((r) => setLoop(r.data?.data || null)).catch(() => {})
    api.get('/notifications').then((r) => setMentions((r.data?.data?.mentions || []).length)).catch(() => {})
  }, [user?.id])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'n' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') && !e.metaKey && !e.ctrlKey) { e.preventDefault(); composerRef.current?.focus() } }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [])

  const tasks = data?.tasks || []
  const open = tasks.filter((t) => t.status !== 'Done')
  const done = tasks.filter((t) => t.status === 'Done')
  const overdue = open.filter((t) => isPastLocal(t.due_date))
  const dueToday = open.filter((t) => daysUntilLocal(t.due_date) === 0)
  const patch = async (id, fields) => {
    setData((d) => ({ ...d, tasks: d.tasks.map((t) => (t.id === id ? { ...t, ...fields } : t)) }))
    try { await api.put(`/team/tasks/${id}`, fields) } catch (e) { setError(e?.response?.data?.error || 'Could not save'); load() }
  }
  const toggle = (t) => patch(t.id, { status: t.status === 'Done' ? 'To Do' : 'Done' })
  const remove = async (t) => {
    if (!window.confirm('Delete this task?')) return
    setData((d) => ({ ...d, tasks: d.tasks.filter((x) => x.id !== t.id) })); setExpanded(null)
    try { await api.delete(`/team/tasks/${t.id}`) } catch { load() }
  }
  const assign = async (t, memberId) => {
    try {
      const r = await api.put(`/team/tasks/${t.id}/assign`, { user_id: memberId })
      if (r.data?.pending_email) setPendingEmail(r.data.pending_email)
      if (String(memberId) !== String(user?.id)) { setData((d) => ({ ...d, tasks: d.tasks.filter((x) => x.id !== t.id) })); setExpanded(null) }
    } catch (e) { setError(e?.response?.data?.error || 'Could not reassign') }
  }

  // ── This week, mine: the calendar's next 7 days, kept to what involves me ──
  const myReleaseIds = useMemo(() => new Set((data?.releases || []).map((r) => r.id)), [data])
  const agenda = useMemo(() => {
    if (!week) return null
    const from = localDay(); const to = localDay(new Date(Date.now() + 6 * 86400000))
    const pageFor = (t) => (t === 'payment_due' ? '/bk/payments' : t === 'contract_expiry' ? '/renewals' : null)
    return week
      .filter((e) => e.date >= from && e.date <= to)
      .filter((e) => {
        if (e.type === 'deadline') return e.to === '/my-work'
        if (e.type === 'release' || e.type.startsWith('dsp')) return myReleaseIds.has(Number(e.sourceId))
        if (e.type === 'payment_due' || e.type === 'contract_expiry') return canView(pageFor(e.type))
        return e.type === 'signed'
      })
      .sort((a, b) => a.date.localeCompare(b.date))
  }, [week, myReleaseIds, canView])

  // ── Waiting on you: only what this person can unblock ──
  const cutoffDays = (() => { const now = new Date(); const cut = new Date(now.getFullYear(), now.getMonth(), 20); if (now.getDate() > 20) cut.setMonth(cut.getMonth() + 1); return Math.ceil((cut - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000) })()
  const updatedTours = tours.filter((t) => doneVersion(t.id) && !isDone(t))
  const waiting = [
    loop?.approvals && canView('/bk/approvals') && loop.approvals.count > 0 && { icon: Inbox, text: `${loop.approvals.count} invoice${loop.approvals.count === 1 ? '' : 's'} awaiting approval`, to: '/bk/approvals' },
    mentions > 0 && { icon: MessageSquare, text: `${mentions} unread mention${mentions === 1 ? '' : 's'}`, to: '/messages' },
    // Flags new since this person last opened the page — the register's push
    // (lib/flags-register summaryFor, via the Home loop). Only kinds they can act on.
    loop?.flags && canView('/flags') && loop.flags.new > 0 && { icon: Flag, text: `${loop.flags.new} flag${loop.flags.new === 1 ? '' : 's'} new since you looked`, sub: loop.flags.count > loop.flags.new ? `${loop.flags.count} open in all` : null, to: '/flags' },
    (data?.invites_pending || []).length > 0 && { icon: Mail, text: `${data.invites_pending.length} invite${data.invites_pending.length === 1 ? '' : 's'} you sent, not yet used`, sub: data.invites_pending.map((i) => i.name).join(', '), to: '/team' },
    canView('/bk/statements') && cutoffDays <= 7 && { icon: Hourglass, text: `Statement cutoff ${cutoffDays === 0 ? 'today' : `in ${cutoffDays} day${cutoffDays === 1 ? '' : 's'}`}`, sub: 'the 20th', to: '/bk/statements' },
    updatedTours.length > 0 && { icon: Footprints, text: `${updatedTours.length} walkthrough${updatedTours.length === 1 ? '' : 's'} updated since you took ${updatedTours.length === 1 ? 'it' : 'them'}`, sub: updatedTours.map((t) => t.title).join(', '), to: null },
  ].filter(Boolean)

  if (error && !data) return <div className="text-sm text-rose-600 py-12 text-center">{error}</div>
  const summary = data ? [`${open.length} open`, dueToday.length ? `${dueToday.length} due today` : null, overdue.length ? `${overdue.length} overdue` : null].filter(Boolean).join(' · ') : 'Loading…'

  return (
    <div className="space-y-6" data-tour="my-work">
      <PageHeader title="My Work" subtitle={summary} />
      <div className={`grid gap-6 ${waiting.length ? 'lg:grid-cols-[minmax(0,1fr)_300px]' : ''}`}>
        <div className="space-y-6 min-w-0">
          <Composer ref={composerRef} team={team} user={user} onCreated={(created, pending) => { load(); if (pending) setPendingEmail(pending) }} setError={setError} />
          {error && <p className="text-xs text-rose-600" data-error>{error}</p>}

          {/* The list */}
          <div className="card divide-y divide-divider" data-tour="my-work-list" data-task-list>
            {!data ? <p className="text-sm text-gray-400 p-6 text-center">Loading…</p>
              : open.length === 0 ? (
                <div className="p-2"><EmptyState compact icon={Check} title="Nothing open" body="Add a task above, or assign yourself one from a release or an artist. Tasks others assign you land here too." /></div>
              ) : BUCKETS.map(([key, label]) => {
                const rows = open.filter((t) => bucketOf(t) === key)
                if (!rows.length) return null
                return (
                  <section key={key} data-bucket={key}>
                    <p className={`px-4 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider ${key === 'overdue' ? 'text-rose-600' : key === 'today' ? 'text-gray-900' : 'text-gray-400'}`}>{label} <span className="font-normal text-gray-400">{rows.length}</span></p>
                    <ul>
                      {rows.map((t) => <TaskRow key={t.id} task={t} expanded={expanded === t.id} onToggleExpand={() => setExpanded(expanded === t.id ? null : t.id)} onToggleDone={() => toggle(t)} onPatch={(f) => patch(t.id, f)} onDelete={() => remove(t)} onAssign={(id) => assign(t, id)} team={team} user={user} />)}
                    </ul>
                  </section>
                )
              })}
            {done.length > 0 && (
              <div className="px-4 py-2.5">
                <button onClick={() => setShowDone((v) => !v)} className="text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1" data-toggle-done>
                  {showDone ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {done.length} done
                </button>
                {showDone && (
                  <ul className="mt-2 opacity-70">
                    {done.slice(0, 20).map((t) => <TaskRow key={t.id} task={t} expanded={expanded === t.id} onToggleExpand={() => setExpanded(expanded === t.id ? null : t.id)} onToggleDone={() => toggle(t)} onPatch={(f) => patch(t.id, f)} onDelete={() => remove(t)} onAssign={(id) => assign(t, id)} team={team} user={user} />)}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* This week, mine */}
          <div className="card p-5" data-tour="my-work-week" data-agenda>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><CalendarIcon size={15} className="text-gray-400" /> This week, mine</h2>
              <Link to="/calendar" className="text-xs text-boom-600 hover:text-boom-700 font-medium">Team calendar</Link>
            </div>
            {agenda === null ? <p className="text-sm text-gray-400">Loading…</p>
              : agenda.length === 0 ? <p className="text-sm text-gray-400">Nothing dated for you in the next seven days. Your task due dates, your releases and the money dates you can open show here.</p>
              : (
                <ul className="divide-y divide-divider">
                  {Object.entries(agenda.reduce((m, e) => { (m[e.date] = m[e.date] || []).push(e); return m }, {})).map(([date, evs]) => (
                    <li key={date} className="py-2 flex gap-3" data-agenda-day={date}>
                      <div className="w-14 flex-shrink-0 text-right">
                        <p className="text-[10px] font-bold text-gray-400 uppercase">{date === localDay() ? 'Today' : new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' })}</p>
                        <p className="text-sm font-semibold text-gray-900 tabular-nums leading-tight">{new Date(date + 'T12:00:00').getDate()}</p>
                      </div>
                      <ul className="flex-1 min-w-0 space-y-1">
                        {evs.map((e) => (
                          <li key={e.id} className="flex items-center gap-2 min-w-0" data-agenda-event={e.type}>
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${e.type === 'deadline' ? 'bg-amber-500' : e.type === 'release' ? 'bg-blue-500' : e.type === 'payment_due' ? 'bg-teal-600' : e.type === 'contract_expiry' ? 'bg-red-500' : 'bg-emerald-600'}`} />
                            {e.to && e.to !== '/my-work' ? <Link to={e.to} className="text-sm text-gray-800 hover:underline truncate">{e.title}</Link> : <span className="text-sm text-gray-800 truncate">{e.title}</span>}
                            {e.meta && <span className="text-[10px] text-gray-400 flex-shrink-0">{e.meta}</span>}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        </div>

        {waiting.length > 0 && (
          <aside className="space-y-2 lg:sticky lg:top-6 lg:self-start" data-tour="my-work-waiting" data-waiting>
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Waiting on you</p>
            {waiting.map((w, i) => {
              const Icon = w.icon
              const inner = (<><Icon size={15} className="text-boom-600 flex-shrink-0 mt-0.5" /><div className="min-w-0"><p className="text-sm font-semibold text-gray-900 leading-snug">{w.text}</p>{w.sub && <p className="text-[11px] text-gray-500 truncate">{w.sub}</p>}</div>{w.to && <ChevronRight size={14} className="ml-auto text-gray-300 flex-shrink-0" />}</>)
              return w.to
                ? <Link key={i} to={w.to} className="card px-4 py-3 flex items-start gap-3 hover:border-gray-300 hover:shadow-sm transition-all" data-waiting-item>{inner}</Link>
                : <div key={i} className="card px-4 py-3 flex items-start gap-3" data-waiting-item>{inner}</div>
            })}
          </aside>
        )}
      </div>

      {pendingEmail && (
        <EmailPreviewModal open title="Send task notification" subtitle={pendingEmail.context?.assigneeName ? `To ${pendingEmail.context.assigneeName}` : undefined}
          previewKind={pendingEmail.kind} previewContext={pendingEmail.context} initialTo={pendingEmail.to} initialCc={pendingEmail.cc} initialSubject={pendingEmail.subject} initialHtml={pendingEmail.html}
          team={team} onClose={() => setPendingEmail(null)} onSent={() => setPendingEmail(null)} onSkipped={() => setPendingEmail(null)} skipLabel="Skip email" />
      )}
    </div>
  )
}

import { forwardRef } from 'react'
// The composer: one line, @ to assign, a few chips. Enter adds.
const Composer = forwardRef(function Composer({ team, user, onCreated, setError }, ref) {
  const [text, setText] = useState('')
  const [priority, setPriority] = useState('Medium')
  const [category, setCategory] = useState('General')
  const [due, setDue] = useState('')
  const [assignee, setAssignee] = useState(null)
  const [saving, setSaving] = useState(false)
  const [menu, setMenu] = useState(false)
  const at = text.lastIndexOf('@')
  const query = menu && at >= 0 ? text.slice(at + 1).toLowerCase() : null
  const matches = query !== null ? team.filter((m) => m.name?.toLowerCase().includes(query)).slice(0, 6) : []
  const pick = (m) => { setAssignee(m); setText(text.slice(0, at).trimEnd()); setMenu(false) }
  const submit = async (e) => {
    e?.preventDefault?.()
    const description = text.trim(); if (!description) return
    setSaving(true); setError('')
    try {
      const r = await api.post('/team/tasks', { user_id: assignee?.id || user.id, description, priority, category, due_date: due || null })
      setText(''); setDue(''); setAssignee(null); setPriority('Medium'); setCategory('General')
      onCreated(r.data?.data, r.data?.pending_email || null)
    } catch (err) { setError(err?.response?.data?.error || 'Could not add the task') }
    finally { setSaving(false) }
  }
  return (
    <form onSubmit={submit} className="card p-3" data-tour="my-work-add" data-composer>
      <div className="relative">
        <input ref={ref} value={text} onChange={(e) => { setText(e.target.value); setMenu(e.target.value.endsWith('@') || (menu && /@[^\s]*$/.test(e.target.value))) }}
          onKeyDown={(e) => { if (e.key === 'Escape') setMenu(false) }}
          placeholder="Add a task — press n anywhere, @ to assign someone" className="input-base w-full text-sm" data-composer-input />
        {menu && matches.length > 0 && (
          <div className="absolute left-0 right-0 top-full mt-1 bg-card border border-rule rounded-xl shadow-lg z-30 overflow-hidden" data-mention-menu>
            {matches.map((m) => (
              <button key={m.id} type="button" onMouseDown={(e) => { e.preventDefault(); pick(m) }} className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 text-left">
                <span className="w-6 h-6 rounded-full bg-gray-100 text-[10px] font-bold text-gray-600 inline-flex items-center justify-center">{m.name?.charAt(0)}</span>
                <span className="text-xs font-medium text-gray-800">{m.name}</span><span className="text-[10px] text-gray-400">{m.department}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap mt-2">
        {assignee ? (
          <button type="button" onClick={() => setAssignee(null)} className="inline-flex items-center gap-1 text-[11px] font-semibold bg-boom-50 text-boom-700 px-2 py-1 rounded-full" data-composer-assignee><AtSign size={11} /> {assignee.name} ×</button>
        ) : <span className="text-[11px] text-gray-400">for me</span>}
        <select value={priority} onChange={(e) => setPriority(e.target.value)} className="select-base text-[11px] py-1">{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="select-base text-[11px] py-1">{TASK_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="input-base text-[11px] py-1" aria-label="Due date" />
        <button type="submit" disabled={saving || !text.trim()} className="ml-auto btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1 disabled:opacity-40" data-composer-add>{saving ? <Loader size={12} className="animate-spin" /> : <Plus size={12} />} Add</button>
      </div>
    </form>
  )
})

function TaskRow({ task: t, expanded, onToggleExpand, onToggleDone, onPatch, onDelete, onAssign, team, user }) {
  const [desc, setDesc] = useState(t.description || '')
  const [notes, setNotes] = useState(t.notes || '')
  useEffect(() => { setDesc(t.description || ''); setNotes(t.notes || '') }, [t.id, t.description, t.notes])
  const done = t.status === 'Done'
  const isOverdue = !done && isPastLocal(t.due_date)
  const fromOther = t.assigned_by && String(t.assigned_by) !== String(user?.id)
  return (
    <li className={`px-4 ${expanded ? 'bg-gray-50/60' : ''}`} data-task={t.id} data-expanded={expanded ? '1' : '0'}>
      <div className="flex items-center gap-3 py-2.5">
        <button onClick={onToggleDone} aria-label={done ? 'Mark not done' : 'Mark done'} data-task-toggle
          className={`w-5 h-5 rounded-full border-2 flex-shrink-0 inline-flex items-center justify-center transition-colors ${done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-gray-300 hover:border-gray-500 text-transparent'}`}>
          <Check size={12} strokeWidth={3} />
        </button>
        <button onClick={onToggleExpand} className="flex-1 min-w-0 text-left" data-task-open>
          <p className={`text-sm truncate ${done ? 'line-through text-gray-400' : 'text-gray-900 font-medium'}`}>{t.description}</p>
          <p className="text-[11px] text-gray-400 truncate flex items-center gap-1.5 mt-0.5">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${PRIORITY_DOT[t.priority] || 'bg-gray-300'}`} />{t.priority || 'Medium'}
            {t.category && t.category !== 'General' && <span>· {t.category}</span>}
            {t.due_date && <span className={isOverdue ? 'text-rose-600 font-semibold' : ''}>· {dueLabel(t.due_date)}</span>}
            {fromOther && t.assigned_by_name && <span>· from {t.assigned_by_name.split(' ')[0]}</span>}
            {t.status === 'In Progress' && <span className="text-blue-600">· in progress</span>}
            {t.release_name && <span>· {t.release_name}</span>}
            {t.flag_kind && <span className="text-boom-600">· <Link to={`/flags?tab=${t.flag_kind}${t.flag_key && t.flag_key !== '*' ? `&focus=${encodeURIComponent(t.flag_key)}` : ''}`} onClick={(e) => e.stopPropagation()} data-task-flag-link>open flag</Link></span>}
          </p>
        </button>
        {/* Notes live NEXT TO the task, always visible (John: "I liked the notes
            section being always visible next to the task"). Saves on blur. */}
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => { if (notes !== (t.notes || '')) onPatch({ notes }) }}
          rows={Math.min(3, Math.max(1, (notes || '').split('\n').length))} placeholder="Notes…" aria-label="Notes" data-task-notes
          className="hidden sm:block w-[260px] lg:w-[320px] flex-shrink-0 text-xs leading-snug text-gray-700 placeholder:text-gray-300 bg-transparent border border-transparent hover:border-rule focus:border-rule focus:bg-card rounded-md px-2 py-1 resize-none outline-none" />
        <ChevronDown size={14} className={`text-gray-300 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </div>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => { if (notes !== (t.notes || '')) onPatch({ notes }) }} rows={1} placeholder="Notes…" aria-label="Notes"
        className="sm:hidden w-full mb-2 ml-8 text-xs text-gray-700 placeholder:text-gray-300 bg-transparent border border-transparent focus:border-rule rounded-md px-2 py-1 resize-none outline-none" />
      {expanded && (
        <div className="pb-4 pl-8 space-y-3" data-task-detail>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={() => { if (desc.trim() && desc !== t.description) onPatch({ description: desc.trim() }) }} className="input-base w-full text-sm font-medium" aria-label="Task" />
          <div className="flex items-center gap-2 flex-wrap">
            <select value={t.status} onChange={(e) => onPatch({ status: e.target.value })} className="select-base text-xs py-1">{STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
            <select value={t.priority || 'Medium'} onChange={(e) => onPatch({ priority: e.target.value })} className="select-base text-xs py-1">{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
            <select value={t.category || 'General'} onChange={(e) => onPatch({ category: e.target.value })} className="select-base text-xs py-1">{TASK_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
            <input type="date" value={t.due_date ? String(t.due_date).slice(0, 10) : ''} onChange={(e) => onPatch({ due_date: e.target.value || null })} className="input-base text-xs py-1" aria-label="Due date" />
            <select value={t.user_id || user?.id || ''} onChange={(e) => onAssign(Number(e.target.value))} className="select-base text-xs py-1" aria-label="Assigned to" data-task-assign>
              {team.map((m) => <option key={m.id} value={m.id}>{String(m.id) === String(user?.id) ? 'Me' : m.name}</option>)}
            </select>
            <button onClick={onDelete} className="ml-auto inline-flex items-center gap-1 text-xs text-gray-400 hover:text-rose-600" data-task-delete><Trash2 size={12} /> Delete</button>
          </div>
        </div>
      )}
    </li>
  )
}
