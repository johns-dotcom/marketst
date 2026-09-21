// The deal, open. Top to bottom: who owns it and where it stands · the timeline
// (a dated note per touch, every stage move logged) · what Signed will need ·
// the editable details, terms and contact · move stage · documents.
import { useEffect, useRef, useState } from 'react'
import { X, Save, Check, Send, Trash2, CheckCircle2, Circle, ArrowRight } from 'lucide-react'
import api from '../../api'
import { formatDate } from '../../utils'
import FilesPanel from '../FilesPanel'
import { Button, Input, Select } from '../ui'
import { STAGES, LIVE_STAGES, PRIORITIES, DEAL_TYPES, preSignChecklist, eventLine, relTime, initials } from '../../lib/deals'

const PRIORITY_SELECT_TONE = {
  High: 'bg-red-50 text-red-700 border-red-200 focus:border-red-300',
  Medium: 'bg-amber-50 text-amber-700 border-amber-200 focus:border-amber-300',
  Low: 'bg-gray-100 text-gray-700 border-gray-200 focus:border-gray-300',
}
const TERM_KEYS = ['advance', 'royalty_split', 'term_months', 'territory', 'num_releases', 'option_periods']
const CONTACT_KEYS = ['artist_email', 'artist_phone', 'manager_name', 'manager_email', 'spotify_url']
const socialsToText = (v) => (Array.isArray(v) ? v.map((x) => `${x.platform} ${x.handle}`).join('\n') : '')
const textToSocials = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [platform, ...rest] = l.split(/\s+/); return { platform, handle: rest.join(' ') } }).filter((x) => x.platform && x.handle)

const EVENT_DOT = { note: 'bg-boom-500', stage: 'bg-violet-500', created: 'bg-gray-400', passed: 'bg-gray-400', signed: 'bg-emerald-500' }

export default function DealDrawer({ deal, team, user, onClose, onSaved, onMoveStage, onFileCount }) {
  const [editForm, setEditForm] = useState({})
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [events, setEvents] = useState(null)
  const [note, setNote] = useState('')
  const [posting, setPosting] = useState(false)
  const noteRef = useRef(null)
  const isAdmin = ['Admin', 'Superadmin'].includes(user?.role)

  useEffect(() => {
    if (!deal) return
    setEditForm({
      last_contact_date: (deal.last_contact_date || '').slice(0, 10),
      next_followup_date: (deal.next_followup_date || '').slice(0, 10),
      priority: deal.priority || 'Medium',
      spotify_monthly_listeners: deal.spotify_monthly_listeners ?? '',
      deal_type: deal.deal_type || '',
      offer_amount: deal.offer_amount ?? '',
      source: deal.source || '',
      ...Object.fromEntries([...TERM_KEYS, ...CONTACT_KEYS].map((k) => [k, deal[k] ?? ''])),
      socials_text: socialsToText(deal.socials),
    })
    setStatus('')
  }, [deal?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!deal) return
    let live = true
    setEvents(null)
    api.get(`/deals/${deal.id}/events`).then((r) => { if (live) setEvents(r.data?.data || []) }).catch(() => { if (live) setEvents([]) })
    return () => { live = false }
  }, [deal?.id])

  if (!deal) return null
  const checklist = preSignChecklist(deal)
  const ready = checklist.filter((c) => c.ok).length

  const save = async () => {
    setSaving(true)
    try {
      const listeners = editForm.spotify_monthly_listeners; const offer = editForm.offer_amount
      const payload = {
        last_contact_date: editForm.last_contact_date || null,
        next_followup_date: editForm.next_followup_date || null,
        priority: editForm.priority || null,
        spotify_monthly_listeners: listeners === '' || listeners == null ? null : Number(listeners),
        deal_type: editForm.deal_type || null,
        offer_amount: offer === '' || offer == null ? null : Number(offer),
        source: editForm.source || null,
        ...Object.fromEntries(TERM_KEYS.map((k) => [k, editForm[k] === '' || editForm[k] == null ? '' : (k === 'territory' ? editForm[k] : Number(editForm[k]))])),
        ...Object.fromEntries(CONTACT_KEYS.map((k) => [k, editForm[k] ?? ''])),
        socials: textToSocials(editForm.socials_text),
      }
      const r = await api.put(`/deals/${deal.id}`, payload)
      onSaved(r.data.data, r.data.signing)
      setStatus('saved'); setTimeout(() => setStatus((s) => (s === 'saved' ? '' : s)), 2000)
    } catch { setStatus('error') } finally { setSaving(false) }
  }
  const setOwner = async (ownerId) => {
    try { const r = await api.put(`/deals/${deal.id}`, { owner_id: ownerId || null }); onSaved(r.data.data) } catch { setStatus('error') }
  }
  const postNote = async (e) => {
    e?.preventDefault?.()
    const body = note.trim(); if (!body || posting) return
    setPosting(true)
    try {
      const r = await api.post(`/deals/${deal.id}/events`, { body })
      setEvents((ev) => [r.data.data, ...(ev || [])]); setNote('')
      if (r.data.deal) onSaved(r.data.deal)
    } catch { setStatus('error') } finally { setPosting(false); noteRef.current?.focus() }
  }
  const deleteNote = async (ev) => {
    try { await api.delete(`/deals/${deal.id}/events/${ev.id}`); setEvents((list) => list.filter((x) => x.id !== ev.id)) } catch { /* keep */ }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose} data-deal-drawer={deal.id}>
      <div className="relative w-full max-w-md bg-card shadow-xl border-l border-rule h-full overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-card border-b border-divider px-5 py-4 flex items-start justify-between gap-3 z-10">
          <div className="min-w-0">
            <p className="text-base font-semibold text-gray-900 truncate">{deal.artist_name}</p>
            <p className="text-xs text-gray-400 mt-0.5">{deal.stage}{deal.genre && ` · ${deal.genre}`}{LIVE_STAGES.includes(deal.stage) && ` · ${deal.days_in_stage ?? 0}d here`}{deal.added_date && ` · added ${formatDate(deal.added_date)}`}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors flex-shrink-0"><X size={16} /></button>
        </div>

        {/* Owner */}
        <div className="px-5 py-3 border-b border-divider flex items-center gap-3" data-deal-owner-row>
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Owner</span>
          <select value={deal.owner_id || ''} onChange={(e) => setOwner(e.target.value ? Number(e.target.value) : null)} className="select-base text-xs py-1 flex-1" aria-label="Owner" data-deal-owner-select>
            <option value="">— nobody —</option>
            {team.map((m) => <option key={m.id} value={m.id}>{String(m.id) === String(user?.id) ? `Me (${m.name})` : m.name}</option>)}
          </select>
          {deal.ar_rep && !deal.owner_id && <span className="text-[11px] text-gray-400">rep: {deal.ar_rep}</span>}
        </div>

        {/* Passed */}
        {deal.stage === 'Passed' && (
          <div className="px-5 py-3 border-b border-divider bg-gray-50/60" data-deal-passed>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Passed</p>
            <p className="text-sm text-gray-800">{deal.passed_reason || 'No reason recorded'}{deal.passed_note ? ` — ${deal.passed_note}` : ''}</p>
            <p className="text-xs text-gray-500 mt-1">{deal.revisit_date ? `Revisit on ${formatDate(deal.revisit_date)}` : 'No revisit date'} · <button type="button" className="underline hover:text-gray-800" onClick={() => onMoveStage(deal, 'Passed')}>edit</button></p>
          </div>
        )}

        {/* Timeline */}
        <div className="px-5 py-4 border-b border-divider" data-deal-timeline>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Timeline</p>
          <form onSubmit={postNote} className="flex items-start gap-2 mb-3">
            <textarea ref={noteRef} rows={2} value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); postNote() } }}
              placeholder="Log a touch — called the manager, sent the offer… Enter saves, Shift+Enter for a new line." className="input-base w-full text-sm" aria-label="New note" data-deal-note-input />
            <button type="submit" disabled={!note.trim() || posting} aria-label="Add note" className="btn-primary px-2.5 py-2 disabled:opacity-40" data-deal-note-submit><Send size={14} /></button>
          </form>
          {events === null ? <p className="text-xs text-gray-400">Loading…</p>
            : events.length === 0 ? <p className="text-xs text-gray-400">Nothing logged yet. The first note starts the history.</p>
            : (
              <ol className="space-y-2" data-deal-events>
                {events.map((e) => (
                  <li key={e.id} className="flex items-start gap-2 group" data-deal-event={e.kind}>
                    <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${EVENT_DOT[e.kind] || 'bg-gray-300'}`} />
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm leading-snug ${e.kind === 'note' ? 'text-gray-800 whitespace-pre-wrap' : 'text-gray-600'}`}>{eventLine(e)}</p>
                      <p className="text-[11px] text-gray-400 mt-0.5">{e.user_name ? `${e.user_name} · ` : ''}{relTime(e.created_at)} · {formatDate(e.created_at)}</p>
                    </div>
                    {e.kind === 'note' && (isAdmin || Number(e.user_id) === Number(user?.id)) && (
                      <button type="button" onClick={() => deleteNote(e)} aria-label="Delete note" className="p-0.5 text-gray-300 hover:text-rose-600 opacity-0 group-hover:opacity-100"><Trash2 size={12} /></button>
                    )}
                  </li>
                ))}
              </ol>
            )}
        </div>

        {/* Pre-sign checklist */}
        {LIVE_STAGES.includes(deal.stage) && (
          <div className="px-5 py-4 border-b border-divider" data-deal-checklist data-ready={ready} data-total={checklist.length}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Before Signed</p>
              <span className={`text-[11px] font-semibold ${ready === checklist.length ? 'text-emerald-600' : 'text-gray-500'}`}>{ready} of {checklist.length} ready</span>
            </div>
            <ul className="space-y-1">
              {checklist.map((c) => (
                <li key={c.key} className={`flex items-start gap-2 text-xs ${c.ok ? 'text-gray-500' : 'text-gray-800'}`} data-check={c.key} data-ok={c.ok ? '1' : '0'}>
                  {c.ok ? <CheckCircle2 size={14} className="text-emerald-500 flex-shrink-0 mt-px" /> : <Circle size={14} className="text-gray-300 flex-shrink-0 mt-px" />}
                  <span className={c.ok ? 'line-through decoration-gray-300' : ''}>{c.label}</span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-gray-400 mt-2">Signed creates the roster row, books the advance and opens the contract. Missing items do not block it — they make the contract form emptier.</p>
          </div>
        )}

        {/* Details, terms, contact */}
        <div className="px-5 py-4 border-b border-divider space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Details</p>
            {status === 'saved' && <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 font-medium"><Check size={11} /> Saved</span>}
            {status === 'error' && <span className="text-[11px] text-red-600 font-medium">Save failed</span>}
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Priority</span>
              <Select value={editForm.priority || 'Medium'} onChange={(e) => setEditForm((f) => ({ ...f, priority: e.target.value }))} className={`mt-1 font-semibold ${PRIORITY_SELECT_TONE[editForm.priority] || PRIORITY_SELECT_TONE.Medium}`}>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</Select></label>
            <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Deal Type</span>
              <Select value={editForm.deal_type || ''} onChange={(e) => setEditForm((f) => ({ ...f, deal_type: e.target.value }))} className="mt-1" data-term="deal_type"><option value="">—</option>{DEAL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></label>
            <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Last Contact</span>
              <Input type="date" value={editForm.last_contact_date || ''} onChange={(e) => setEditForm((f) => ({ ...f, last_contact_date: e.target.value }))} className="mt-1" /></label>
            <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Next Follow-up</span>
              <Input type="date" value={editForm.next_followup_date || ''} onChange={(e) => setEditForm((f) => ({ ...f, next_followup_date: e.target.value }))} className="mt-1" data-term="next_followup_date" /></label>
            <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Source</span>
              <Input placeholder="Referral, showcase, inbound…" value={editForm.source ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, source: e.target.value }))} className="mt-1" /></label>
            <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Spotify Monthly</span>
              <Input inputMode="numeric" placeholder="e.g. 250,000" value={editForm.spotify_monthly_listeners === '' || editForm.spotify_monthly_listeners == null ? '' : Number(editForm.spotify_monthly_listeners).toLocaleString('en-US')}
                onChange={(e) => { const raw = e.target.value.replace(/,/g, ''); if (raw === '' || /^\d+$/.test(raw)) setEditForm((f) => ({ ...f, spotify_monthly_listeners: raw })) }} className="mt-1" /></label>
          </div>
          <div className="pt-2" data-deal-terms>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Terms · typed at Offer</p>
            <div className="grid grid-cols-2 gap-2.5">
              <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Advance</span>
                <div className="relative mt-1"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none">$</span>
                  <Input type="number" step="0.01" min="0" placeholder="0" value={editForm.advance ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, advance: e.target.value }))} className="pl-7" data-term="advance" /></div></label>
              <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Artist royalty %</span>
                <Input type="number" step="0.5" min="0" max="100" placeholder="e.g. 50" value={editForm.royalty_split ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, royalty_split: e.target.value }))} className="mt-1" data-term="royalty_split" /></label>
              <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Term (months)</span>
                <Input type="number" step="1" min="0" placeholder="e.g. 24" value={editForm.term_months ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, term_months: e.target.value }))} className="mt-1" data-term="term_months" /></label>
              <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Territory</span>
                <Input placeholder="World" value={editForm.territory ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, territory: e.target.value }))} className="mt-1" data-term="territory" /></label>
              <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Releases committed</span>
                <Input type="number" step="1" min="0" placeholder="e.g. 3" value={editForm.num_releases ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, num_releases: e.target.value }))} className="mt-1" data-term="num_releases" /></label>
              <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Option periods</span>
                <Input type="number" step="1" min="0" placeholder="0" value={editForm.option_periods ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, option_periods: e.target.value }))} className="mt-1" data-term="option_periods" /></label>
            </div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mt-4 mb-2">Contact · goes onto the roster at signing</p>
            <div className="grid grid-cols-2 gap-2.5">
              <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Artist email</span>
                <Input type="email" placeholder="artist@email.com" value={editForm.artist_email ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, artist_email: e.target.value }))} className="mt-1" data-term="artist_email" /></label>
              <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Artist phone</span>
                <Input placeholder="+1 …" value={editForm.artist_phone ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, artist_phone: e.target.value }))} className="mt-1" /></label>
              <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Manager</span>
                <Input placeholder="Name" value={editForm.manager_name ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, manager_name: e.target.value }))} className="mt-1" /></label>
              <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Manager email</span>
                <Input type="email" placeholder="manager@email.com" value={editForm.manager_email ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, manager_email: e.target.value }))} className="mt-1" /></label>
              <label className="block col-span-2"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Spotify artist link</span>
                <Input placeholder="https://open.spotify.com/artist/…" value={editForm.spotify_url ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, spotify_url: e.target.value }))} className="mt-1" /></label>
              <label className="block col-span-2"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Socials · one per line, "platform handle"</span>
                <textarea rows="2" placeholder={'instagram @rosavale\ntiktok @rosa.vale'} value={editForm.socials_text ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, socials_text: e.target.value }))} className="input-base w-full mt-1 text-sm" data-term="socials" /></label>
            </div>
          </div>
          <div className="flex justify-end pt-1">
            <Button size="sm" onClick={save} disabled={saving} data-deal-save><Save size={13} />{saving ? 'Saving…' : 'Save Changes'}</Button>
          </div>
        </div>

        {/* Move stage */}
        <div className="px-5 py-4 border-b border-divider" data-deal-move>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Move Stage</p>
          <div className="flex flex-wrap gap-1.5">
            {STAGES.map((s) => (
              <button key={s} onClick={() => { if (s !== deal.stage) onMoveStage(deal, s) }} data-move-to={s}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all inline-flex items-center gap-1 ${s === deal.stage ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {s}{s === STAGES[STAGES.indexOf(deal.stage) + 1] && LIVE_STAGES.includes(deal.stage) && <ArrowRight size={10} />}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="px-5 pt-4 pb-1"><p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Documents</p></div>
          <FilesPanel entityType="deal" entityId={deal.id} basePath="/deals" onCountChange={(count) => onFileCount(deal.id, count)} />
        </div>
      </div>
    </div>
  )
}
