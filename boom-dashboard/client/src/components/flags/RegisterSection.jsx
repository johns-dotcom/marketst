import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, UserPlus, X, Clock, EyeOff, RotateCcw, Check } from 'lucide-react'

// The generic section for REGISTER categories on /flags — workflow stalls,
// compliance gaps, setup health (server/lib/flags-register.js). One row per
// flag: what, where it came from, how old, who holds it, and four verbs — Open
// (the page that resolves it), Assign (a task in somebody's My Work), Snooze,
// Dismiss. The data-quality categories keep their own richer sections; this
// one exists so ~30 new kinds cost one component, not thirty.

export const SEV_DOT = { high: 'bg-rose-500', medium: 'bg-amber-500', low: 'bg-blue-500' }

export function ageLabel(days) {
  if (days == null) return null
  if (days === 0) return 'today'
  if (days === 1) return '1 day'
  if (days < 14) return `${days} days`
  if (days < 60) return `${Math.round(days / 7)} weeks`
  return `${Math.round(days / 30)} months`
}

const fmtUsd = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n) || 0)
const isoIn = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)

// Owner chip + the Assign popover. `current` is { id, user_name, status } or null.
// key '*' assigns the whole category (the data-quality sections use that).
export function AssignControl({ kind, flagKey = '*', current, team = [], onAssign, onUnassign, title, to, severity, size = 'sm' }) {
  const [open, setOpen] = useState(false)
  const [userId, setUserId] = useState('')
  const [due, setDue] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  const submit = async () => {
    if (!userId) return
    setBusy(true)
    try { await onAssign({ kind, key: flagKey, user_id: Number(userId), due_date: due || null, title, to, severity }); setOpen(false); setUserId(''); setDue('') }
    finally { setBusy(false) }
  }
  const pad = size === 'xs' ? 'px-1.5 py-0.5 text-[10.5px]' : 'px-2 py-1 text-[11px]'

  if (current) {
    return (
      <span className={`inline-flex items-center gap-1 rounded-md bg-violet-50 text-violet-700 border border-violet-200 font-semibold ${pad}`} data-flag-owner title={current.status ? `task ${current.status}` : 'assigned'}>
        <UserPlus size={11} /> {current.user_name || 'assigned'}
        {current.status === 'Done' && <Check size={11} className="text-emerald-500" />}
        {onUnassign && (
          <button onClick={() => onUnassign(kind, flagKey)} className="ml-0.5 text-violet-400 hover:text-violet-700" title="Remove the owner (their task closes)" aria-label="Unassign"><X size={11} /></button>
        )}
      </span>
    )
  }
  return (
    <span className="relative inline-block" ref={ref}>
      <button onClick={() => setOpen((v) => !v)} className={`inline-flex items-center gap-1 rounded-md border border-rule text-gray-500 hover:text-ink hover:border-gray-400 font-semibold ${pad}`} data-flag-assign>
        <UserPlus size={11} /> Assign
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-64 card p-3 shadow-lg text-left" data-flag-assign-popover>
          <p className="text-[11px] font-bold text-ink mb-2">{flagKey === '*' ? 'Who works through this category?' : 'Who takes this one?'}</p>
          <select value={userId} onChange={(e) => setUserId(e.target.value)} className="w-full border border-rule rounded-lg px-2 py-1.5 text-[12px] bg-card text-ink mb-2" data-flag-assignee>
            <option value="">Pick a person…</option>
            {team.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <label className="block text-[10.5px] text-gray-400 mb-2">Due <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="ml-1 border border-rule rounded px-1.5 py-0.5 text-[11px] bg-card text-ink" /></label>
          <p className="text-[10.5px] text-gray-400 mb-2">Makes one task in their My Work, linked back here. It closes itself when the flag clears.</p>
          <button onClick={submit} disabled={!userId || busy} className="w-full rounded-lg bg-boom-600 text-white text-[12px] font-bold py-1.5 disabled:opacity-40" data-flag-assign-submit>{busy ? 'Assigning…' : 'Assign'}</button>
        </div>
      )}
    </span>
  )
}

function SnoozeMenu({ onPick }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  return (
    <span className="relative inline-block" ref={ref}>
      <button onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 rounded-md border border-rule px-2 py-1 text-[11px] font-semibold text-gray-500 hover:text-ink hover:border-gray-400" data-flag-snooze title="Hide until a date; it returns then, or sooner if the row changes">
        <Clock size={11} /> Snooze
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-40 card p-1 shadow-lg text-left">
          {[[7, 'a week'], [30, 'a month'], [90, 'three months']].map(([d, label]) => (
            <button key={d} onClick={() => { setOpen(false); onPick(isoIn(d)) }} className="w-full text-left px-2 py-1.5 rounded-md text-[12px] text-ink hover:bg-gray-100" data-flag-snooze-days={d}>for {label}</button>
          ))}
        </div>
      )}
    </span>
  )
}

export default function RegisterSection({ cat, team, focusKey, isNew, onDismiss, onAssign, onUnassign }) {
  const items = cat.items || []
  const focusRef = useRef(null)
  useEffect(() => { focusRef.current?.scrollIntoView?.({ block: 'center' }) }, [focusKey])
  if (!items.length) return <p className="text-sm text-gray-400 p-4">Nothing flagged.</p>

  return (
    <div className="card divide-y divide-divider" data-register-section={cat.kind}>
      {items.map((it) => {
        const off = it.dismissed || it.snoozed
        const fresh = !off && isNew?.(it.first_seen)
        const focused = focusKey != null && String(focusKey) === String(it.key)
        return (
          <div key={it.key} ref={focused ? focusRef : null} data-flag-row={it.key} data-flag-new={fresh ? '1' : undefined}
            className={`flex items-start gap-3 px-4 py-3 ${off ? 'opacity-50' : ''} ${focused ? 'ring-2 ring-boom-300 ring-inset' : ''}`}>
            <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${SEV_DOT[it.severity] || SEV_DOT.medium}`} title={it.severity} />
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="text-[13px] font-semibold text-ink truncate">{it.title}</p>
                {fresh && <span className="text-[10px] font-bold uppercase tracking-wider text-boom-600 bg-boom-50 rounded px-1.5 py-0.5" data-flag-new-pill>new</span>}
                {it.age_days != null && !fresh && <span className="text-[10.5px] text-gray-400 tabular-nums" title={`first seen ${String(it.first_seen).slice(0, 10)}`}>{ageLabel(it.age_days)}</span>}
                {it.usd != null && it.usd > 0 && <span className="text-[11px] font-semibold text-gray-600 tabular-nums">{fmtUsd(it.usd)}</span>}
                {it.snoozed && <span className="text-[10.5px] text-gray-400">snoozed until {String(it.snooze_until).slice(0, 10)}</span>}
                {it.dismissed && <span className="text-[10.5px] text-gray-400">dismissed{it.dismissed_by_name ? ` by ${it.dismissed_by_name}` : ''}</span>}
              </div>
              {it.detail && <p className="text-[11.5px] text-gray-500 mt-0.5 break-words">{it.detail}</p>}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <AssignControl kind={cat.kind} flagKey={it.key} current={it.task} team={team} onAssign={onAssign} onUnassign={onUnassign} title={it.title} to={it.to} severity={it.severity} size="xs" />
              {off ? (
                <button onClick={() => onDismiss(cat.kind, it.key, null, true)} className="inline-flex items-center gap-1 rounded-md border border-rule px-2 py-1 text-[11px] font-semibold text-gray-500 hover:text-ink" data-flag-restore><RotateCcw size={11} /> Restore</button>
              ) : (
                <>
                  <SnoozeMenu onPick={(until) => onDismiss(cat.kind, it.key, until, false)} />
                  <button onClick={() => onDismiss(cat.kind, it.key, null, false)} className="inline-flex items-center gap-1 rounded-md border border-rule px-2 py-1 text-[11px] font-semibold text-gray-500 hover:text-ink" data-flag-dismiss title="Hide for good — unless the row changes, then it comes back"><EyeOff size={11} /> Dismiss</button>
                </>
              )}
              {it.to && (
                <Link to={it.to} className="inline-flex items-center gap-1 rounded-md bg-boom-600 text-white px-2 py-1 text-[11px] font-bold hover:bg-boom-700" data-flag-open>
                  Open <ExternalLink size={11} />
                </Link>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
