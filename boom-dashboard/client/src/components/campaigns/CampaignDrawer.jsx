// One campaign, open: the money at the top, the checklist that decides "ready",
// the expected lines (link each to the invoice that fulfilled it), spend by
// channel, the invoices themselves, the lifecycle buttons, and a timeline.
import { useEffect, useRef, useState } from 'react'
import { X, Check, Circle, CheckCircle2, Link2, Unlink, Trash2, Send, ArrowRight, RotateCcw, Paperclip } from 'lucide-react'
import api from '../../api'
import { formatDate } from '../../utils'
import { STATUSES, STATUS_LABEL, STATUS_DOT, NEXT_ACTION, fmtMoney, fmtMoneyFull, relTime, eventLine, attentionLine } from '../../lib/campaigns'
import { BudgetBar } from '../../pages/SongCampaigns'

export default function CampaignDrawer({ id, team, user, onClose, onChange, onDeleted }) {
  const [c, setC] = useState(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [confirmNote, setConfirmNote] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [linking, setLinking] = useState(null)   // line id being linked
  const [newLine, setNewLine] = useState({ label: '', category: '', vendor: '', expected_amount: '' })
  const [edit, setEdit] = useState(null)
  const noteRef = useRef(null)
  const isAdmin = ['Admin', 'Superadmin', 'Approver'].includes(user?.role)

  const load = () => api.get(`/campaigns/${id}`).then((r) => { setC(r.data.data); setEdit({ budget: r.data.data.budget ?? '', owner_id: r.data.data.owner_id || '', start_date: (r.data.data.start_date || '').slice(0, 10), end_date: (r.data.data.end_date || '').slice(0, 10), notes: r.data.data.notes || '' }) }).catch((e) => setErr(e?.response?.data?.error || 'Could not load the campaign'))
  useEffect(() => { setC(null); setErr(''); setConfirming(false); setConfirmNote(''); load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  const apply = (data) => { setC((prev) => ({ ...(prev || {}), ...data, events: data.events || prev?.events })); onChange(data) }

  const move = async (status, n) => {
    setErr('')
    try { const r = await api.post(`/campaigns/${id}/status`, { status, note: n || undefined }); apply(r.data.data); setConfirming(false); setConfirmNote(''); await refreshEvents() }
    catch (e) { if (e?.response?.data?.needs_note) setConfirming(true); setErr(e?.response?.data?.error || 'Could not change the status') }
  }
  const refreshEvents = async () => { try { const r = await api.get(`/campaigns/${id}`); setC(r.data.data) } catch { /* keep */ } }
  const save = async () => {
    try { const r = await api.put(`/campaigns/${id}`, { budget: edit.budget === '' ? null : Number(edit.budget), owner_id: edit.owner_id || null, start_date: edit.start_date || null, end_date: edit.end_date || null, notes: edit.notes || null }); apply(r.data.data) } catch (e) { setErr(e?.response?.data?.error || 'Could not save') }
  }
  const addLine = async (e) => { e.preventDefault(); if (!newLine.label.trim()) return; try { const r = await api.post(`/campaigns/${id}/lines`, { ...newLine, expected_amount: newLine.expected_amount === '' ? null : Number(newLine.expected_amount) }); apply(r.data.data); setNewLine({ label: '', category: '', vendor: '', expected_amount: '' }) } catch (er) { setErr(er?.response?.data?.error || 'Could not add the line') } }
  const linkLine = async (lid, expense_id) => { try { const r = await api.put(`/campaigns/${id}/lines/${lid}`, { expense_id }); apply(r.data.data); setLinking(null) } catch (er) { setErr(er?.response?.data?.error || 'Could not link') } }
  const removeLine = async (lid) => { try { const r = await api.delete(`/campaigns/${id}/lines/${lid}`); apply(r.data.data) } catch { /* keep */ } }
  const postNote = async (e) => { e?.preventDefault?.(); const body = note.trim(); if (!body) return; try { await api.post(`/campaigns/${id}/events`, { body }); setNote(''); await refreshEvents() } catch { /* keep */ } }
  const del = async () => { if (!window.confirm('Delete this campaign? The invoices stay on the ledger; only the campaign record goes.')) return; try { await api.delete(`/campaigns/${id}`); onDeleted(id) } catch (e) { setErr(e?.response?.data?.error || 'Could not delete') } }

  const next = c ? NEXT_ACTION[c.status] : null
  const unlinked = (c?.ledger || []).filter((r) => !r.linked)
  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose} data-campaign-drawer={id}>
      <div className="relative w-full max-w-lg bg-card shadow-xl border-l border-rule h-full overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {!c ? <div className="p-6 text-sm text-gray-400">{err || 'Loading…'}</div> : (
          <>
            <div className="sticky top-0 bg-card border-b border-divider px-5 py-4 z-10">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-base font-semibold text-gray-900 truncate">{c.song}</p>
                  <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${STATUS_DOT[c.status]}`} />{STATUS_LABEL[c.status]} · {c.artist}{c.owner_name ? ` · ${c.owner_name}` : ''}</p>
                </div>
                <button onClick={onClose} aria-label="Close" className="p-1.5 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 flex-shrink-0"><X size={16} /></button>
              </div>
              <div className="mt-3"><BudgetBar c={c} /></div>
              <div className="grid grid-cols-5 gap-2 mt-2 text-center" data-campaign-money>
                {[['Budget', c.budget_usd === null ? '—' : fmtMoneyFull(c.budget_usd), 'text-gray-900'], ['Spent', fmtMoneyFull(c.spent), 'text-emerald-700'], ['Committed', fmtMoneyFull(c.committed), 'text-amber-700'], ['Expected', fmtMoneyFull(c.expected_open), 'text-gray-500'], ['Left', c.left === null ? '—' : c.left < 0 ? `-${fmtMoneyFull(-c.left)}` : fmtMoneyFull(c.left), c.left !== null && c.left < 0 ? 'text-rose-600' : 'text-gray-900']].map(([l, v, cls]) => (
                  <div key={l}><p className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">{l}</p><p className={`text-sm font-semibold tabular-nums ${cls}`} data-money={l.toLowerCase()}>{v}</p></div>
                ))}
              </div>
              {attentionLine(c) && <p className="text-xs text-rose-600 font-medium mt-2" data-campaign-attn>{attentionLine(c)}</p>}
              {err && <p className="text-xs text-rose-600 mt-2" data-campaign-error>{err}</p>}
            </div>

            {/* Lifecycle */}
            <div className="px-5 py-4 border-b border-divider" data-campaign-lifecycle>
              <div className="flex items-center gap-1 flex-wrap mb-3">
                {STATUSES.map((s, i) => <span key={s} className="inline-flex items-center gap-1"><span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${s === c.status ? 'bg-gray-900 text-white' : STATUSES.indexOf(c.status) > i ? 'text-gray-400 line-through' : 'text-gray-500 bg-gray-100'}`}>{STATUS_LABEL[s]}</span>{i < STATUSES.length - 1 && <ArrowRight size={10} className="text-gray-300" />}</span>)}
              </div>
              {c.status === 'uploaded' && <p className="text-xs text-gray-500">Every item is uploaded for recoupment{c.uploaded_at ? ` (${formatDate(c.uploaded_at)})` : ''}. A new invoice for this song would reopen it.</p>}
              {c.status === 'ready' && <p className="text-xs text-gray-600" data-campaign-ready-note>Confirmed {c.confirmed_at ? relTime(c.confirmed_at) : ''}{c.confirm_note ? ` — “${c.confirm_note}”` : ''}. Bookkeeping uploads the {c.rows} item{c.rows === 1 ? '' : 's'} from Recoupments; the campaign moves to Uploaded on its own.</p>}
              {['live', 'finished', 'planning'].includes(c.status) && (
                <div data-campaign-checklist data-ready={c.ready ? '1' : '0'}>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Before it is ready for recoupment</p>
                  <ul className="space-y-1">
                    {c.checklist.map((k) => (
                      <li key={k.key} className={`flex items-start gap-2 text-xs ${k.ok ? 'text-gray-500' : k.key === 'budget' ? 'text-amber-700' : 'text-gray-800'}`} data-check={k.key} data-ok={k.ok ? '1' : '0'}>
                        {k.ok ? <CheckCircle2 size={14} className="text-emerald-500 flex-shrink-0 mt-px" /> : <Circle size={14} className={`${k.key === 'budget' ? 'text-amber-400' : 'text-gray-300'} flex-shrink-0 mt-px`} />}<span>{k.label}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-gray-400 mt-2">Gaps warn; they never block. Confirming with gaps needs a note saying why it is fine.</p>
                </div>
              )}
              <div className="flex items-center gap-2 flex-wrap mt-3">
                {next && !(next[0] === 'ready' && (confirming || !c.ready)) && <button onClick={() => move(next[0])} className="btn-primary text-xs py-1.5" data-campaign-move={next[0]}>{next[1]} <ArrowRight size={12} /></button>}
                {next && next[0] === 'ready' && !c.ready && !confirming && <button onClick={() => setConfirming(true)} className="btn-primary text-xs py-1.5 bg-amber-600 hover:bg-amber-700 border-amber-600" data-campaign-confirm-anyway>Confirm ready anyway…</button>}
                {c.status === 'live' && <button onClick={() => move('finished')} className="hidden" aria-hidden />}
                {['finished', 'ready', 'uploaded'].includes(c.status) && <button onClick={() => move('live', 'Reopened by hand')} className="btn-secondary text-xs py-1.5 inline-flex items-center gap-1" data-campaign-reopen><RotateCcw size={12} /> Reopen</button>}
                {c.status === 'planning' && null}
                {(isAdmin || Number(c.owner_id) === Number(user?.id) || Number(c.created_by) === Number(user?.id)) && <button onClick={del} className="ml-auto text-xs text-gray-400 hover:text-rose-600 inline-flex items-center gap-1" data-campaign-delete><Trash2 size={12} /> Delete</button>}
              </div>
              {confirming && (
                <form onSubmit={(e) => { e.preventDefault(); if (confirmNote.trim()) move('ready', confirmNote.trim()) }} className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3" data-campaign-confirm-form>
                  <p className="text-xs text-amber-900 font-medium mb-1">The checklist is not clear. Say why it is fine to hand this to recoupment anyway.</p>
                  <textarea value={confirmNote} onChange={(e) => setConfirmNote(e.target.value)} rows={2} className="input-base w-full text-sm" placeholder="e.g. the last invoice is a $40 boost we are not chasing" aria-label="Confirmation note" data-campaign-confirm-note />
                  <div className="flex justify-end gap-2 mt-2"><button type="button" onClick={() => setConfirming(false)} className="btn-secondary text-xs py-1">Cancel</button><button type="submit" disabled={!confirmNote.trim()} className="btn-primary text-xs py-1 disabled:opacity-40" data-campaign-confirm-submit>Confirm ready</button></div>
                </form>
              )}
            </div>

            {/* Expected lines */}
            <div className="px-5 py-4 border-b border-divider" data-campaign-lines>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Expected spend · {c.lines.filter((l) => l.expense_id).length} of {c.lines.length} in</p>
              {c.lines.length === 0 && <p className="text-xs text-gray-400 mb-2">Nothing listed. Add what you plan to buy so “finished” means every invoice arrived.</p>}
              <ul className="space-y-1.5 mb-3">
                {c.lines.map((l) => {
                  const inv = l.expense_id ? c.ledger.find((r) => r.id === l.expense_id) : null
                  return (
                    <li key={l.id} className="flex items-start gap-2 text-xs group" data-campaign-line={l.id} data-line-in={l.expense_id ? '1' : '0'}>
                      {l.expense_id ? <CheckCircle2 size={14} className="text-emerald-500 flex-shrink-0 mt-px" /> : <Circle size={14} className="text-gray-300 flex-shrink-0 mt-px" />}
                      <div className="flex-1 min-w-0">
                        <p className={`text-gray-800 ${l.expense_id ? 'line-through decoration-gray-300 text-gray-500' : ''}`}>{l.label}{l.expected_amount !== null && l.expected_amount !== undefined ? <span className="tabular-nums text-gray-500"> · {fmtMoneyFull(l.expected_amount)}</span> : ''}{l.vendor ? <span className="text-gray-400"> · {l.vendor}</span> : ''}{l.category ? <span className="text-gray-400"> · {l.category}</span> : ''}</p>
                        {inv && <p className="text-[10px] text-gray-400">invoice: {inv.payee} {fmtMoneyFull(inv.usd)} · {inv.paid ? 'paid' : 'unpaid'}</p>}
                        {linking === l.id && (
                          <div className="mt-1 border border-rule rounded-lg p-2 bg-gray-50/60" data-campaign-link-menu>
                            {unlinked.length === 0 ? <p className="text-[11px] text-gray-400">No unlinked invoice on this song yet.</p> : unlinked.map((r) => <button key={r.id} type="button" onClick={() => linkLine(l.id, r.id)} className="block w-full text-left text-[11px] px-1.5 py-1 rounded hover:bg-gray-100" data-link-invoice={r.id}>{r.payee} · {fmtMoneyFull(r.usd)} · {r.category}{r.paid ? ' · paid' : ''}</button>)}
                            <button type="button" onClick={() => setLinking(null)} className="text-[11px] text-gray-400 mt-1">cancel</button>
                          </div>
                        )}
                      </div>
                      {l.expense_id ? <button type="button" onClick={() => linkLine(l.id, null)} title="Unlink the invoice" className="text-gray-300 hover:text-gray-700 opacity-0 group-hover:opacity-100" data-line-unlink><Unlink size={12} /></button>
                        : <button type="button" onClick={() => setLinking(l.id)} title="This invoice arrived — link it" className="text-boom-600 hover:text-boom-800" data-line-link><Link2 size={12} /></button>}
                      <button type="button" onClick={() => removeLine(l.id)} aria-label="Remove line" className="text-gray-300 hover:text-rose-600 opacity-0 group-hover:opacity-100"><Trash2 size={12} /></button>
                    </li>
                  )
                })}
              </ul>
              {c.status !== 'uploaded' && (
                <form onSubmit={addLine} className="grid grid-cols-[2fr_1fr_5rem_auto] gap-1.5" data-campaign-line-form>
                  <input value={newLine.label} onChange={(e) => setNewLine((n) => ({ ...n, label: e.target.value }))} placeholder="Add an expected line…" className="input-base text-xs py-1" aria-label="New line" data-new-line-label />
                  <input value={newLine.vendor} onChange={(e) => setNewLine((n) => ({ ...n, vendor: e.target.value }))} placeholder="Vendor" className="input-base text-xs py-1" aria-label="Vendor" />
                  <input type="number" min="0" step="1" value={newLine.expected_amount} onChange={(e) => setNewLine((n) => ({ ...n, expected_amount: e.target.value }))} placeholder="$" className="input-base text-xs py-1" aria-label="Amount" data-new-line-amount />
                  <button type="submit" className="btn-secondary text-xs py-1" data-new-line-add>Add</button>
                </form>
              )}
            </div>

            {/* Channels + invoices */}
            <div className="px-5 py-4 border-b border-divider" data-campaign-channels>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Spend by channel</p>
              {c.by_channel.length === 0 ? <p className="text-xs text-gray-400">No ledger rows carry this artist + song in a campaign category yet. Invoices land here on their own once they are attributed.</p> : (
                <ul className="space-y-1 mb-3">{c.by_channel.map((ch) => <li key={ch.category} className="flex items-center justify-between text-xs" data-channel={ch.category}><span className="text-gray-700">{ch.category} <span className="text-gray-400">· {ch.count}</span></span><span className="tabular-nums"><span className="text-emerald-700 font-semibold">{fmtMoneyFull(ch.spent)}</span>{ch.committed ? <span className="text-amber-700"> + {fmtMoneyFull(ch.committed)} unpaid</span> : ''}</span></li>)}</ul>
              )}
              {c.ledger.length > 0 && (
                <div data-campaign-invoices>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Invoices · {c.ledger.length}</p>
                  <ul className="divide-y divide-divider">{c.ledger.map((r) => (
                    <li key={r.id} className="flex items-center gap-2 py-1.5 text-xs" data-campaign-invoice={r.id}>
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${r.paid ? 'bg-emerald-500' : 'bg-amber-400'}`} title={r.paid ? 'paid' : 'unpaid'} />
                      <span className="flex-1 min-w-0 truncate text-gray-800">{r.payee} <span className="text-gray-400">· {r.category}{r.invoice_date ? ` · ${String(r.invoice_date).slice(0, 10)}` : ''}</span></span>
                      {!r.has_invoice && <span title="No document" className="text-gray-300"><Paperclip size={11} /></span>}
                      {r.ufr && <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-700 bg-emerald-50 rounded px-1" title="Uploaded for recoupment">UFR</span>}
                      <span className={`tabular-nums font-semibold ${r.paid ? 'text-gray-800' : 'text-amber-700'}`}>{fmtMoneyFull(r.usd)}</span>
                    </li>
                  ))}</ul>
                </div>
              )}
            </div>

            {/* Details */}
            {edit && (
              <div className="px-5 py-4 border-b border-divider space-y-2" data-campaign-details>
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Details</p>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Budget (USD)</span><input type="number" min="0" step="1" value={edit.budget} onChange={(e) => setEdit((f) => ({ ...f, budget: e.target.value }))} className="input-base mt-1 w-full text-sm" aria-label="Budget" data-edit-budget /></label>
                  <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Owner</span><select value={edit.owner_id} onChange={(e) => setEdit((f) => ({ ...f, owner_id: e.target.value }))} className="select-base mt-1 w-full text-sm" aria-label="Owner" data-edit-owner><option value="">— nobody —</option>{team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
                  <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Starts</span><input type="date" value={edit.start_date} onChange={(e) => setEdit((f) => ({ ...f, start_date: e.target.value }))} className="input-base mt-1 w-full text-sm" aria-label="Start date" /></label>
                  <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Ends</span><input type="date" value={edit.end_date} onChange={(e) => setEdit((f) => ({ ...f, end_date: e.target.value }))} className="input-base mt-1 w-full text-sm" aria-label="End date" /></label>
                  <label className="block col-span-2"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Notes</span><textarea rows={2} value={edit.notes} onChange={(e) => setEdit((f) => ({ ...f, notes: e.target.value }))} className="input-base mt-1 w-full text-sm" aria-label="Notes" /></label>
                </div>
                <div className="flex justify-end"><button onClick={save} className="btn-secondary text-xs py-1 inline-flex items-center gap-1" data-campaign-save><Check size={12} /> Save</button></div>
              </div>
            )}

            {/* Timeline */}
            <div className="px-5 py-4" data-campaign-timeline>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Timeline</p>
              <form onSubmit={postNote} className="flex items-start gap-2 mb-3">
                <textarea ref={noteRef} rows={2} value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); postNote() } }} placeholder="Log a note — creative approved, PR went out… Enter saves." className="input-base w-full text-sm" aria-label="New note" data-campaign-note-input />
                <button type="submit" disabled={!note.trim()} aria-label="Add note" className="btn-primary px-2.5 py-2 disabled:opacity-40"><Send size={14} /></button>
              </form>
              <ol className="space-y-2" data-campaign-events>
                {(c.events || []).map((e) => (
                  <li key={e.id} className="flex items-start gap-2" data-campaign-event={e.kind}>
                    <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${e.kind === 'confirmed' ? 'bg-emerald-500' : e.kind === 'reopened' ? 'bg-rose-500' : e.kind === 'note' ? 'bg-boom-500' : 'bg-gray-400'}`} />
                    <div className="min-w-0 flex-1"><p className={`text-sm leading-snug ${e.kind === 'note' ? 'text-gray-800 whitespace-pre-wrap' : 'text-gray-600'}`}>{eventLine(e)}</p><p className="text-[11px] text-gray-400 mt-0.5">{e.user_name ? `${e.user_name} · ` : 'automatic · '}{relTime(e.created_at)} · {formatDate(e.created_at)}</p></div>
                  </li>
                ))}
              </ol>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
