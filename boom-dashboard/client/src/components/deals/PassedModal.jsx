// Moving a deal to Passed asks WHY, and whether to look again. The reason is a
// fixed list the report counts; the note carries the rest. Cancel puts the
// card back where it was.
import { useState } from 'react'
import { X } from 'lucide-react'
import { PASSED_REASONS } from '../../lib/deals'

export default function PassedModal({ deal, onConfirm, onCancel }) {
  const [reason, setReason] = useState(deal?.passed_reason || '')
  const [note, setNote] = useState(deal?.passed_note || '')
  const [revisit, setRevisit] = useState(deal?.revisit_date ? String(deal.revisit_date).slice(0, 10) : '')
  const [err, setErr] = useState('')
  if (!deal) return null
  const submit = (e) => {
    e.preventDefault()
    if (!reason) { setErr('Pick a reason — it is what the report counts.'); return }
    onConfirm({ passed_reason: reason, passed_note: note.trim() || '', revisit_date: revisit || '' })
  }
  return (
    <div className="fixed inset-0 z-[60] bg-overlay flex items-center justify-center p-4" onClick={onCancel} data-passed-modal>
      <form onSubmit={submit} className="bg-card border border-rule rounded-xl shadow-xl w-full max-w-md p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Passing on {deal.artist_name}</h2>
            <p className="text-xs text-gray-500 mt-0.5">Why, and whether to look again. The card moves to Passed and keeps its history.</p>
          </div>
          <button type="button" onClick={onCancel} aria-label="Cancel" className="p-1 text-gray-400 hover:text-gray-700 rounded hover:bg-gray-100"><X size={16} /></button>
        </div>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Reason">
          {PASSED_REASONS.map((r) => (
            <button key={r} type="button" role="radio" aria-checked={reason === r} onClick={() => { setReason(r); setErr('') }} data-passed-reason={r}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${reason === r ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{r}</button>
          ))}
        </div>
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything worth remembering — what they wanted, who they went with…" className="input-base w-full text-sm" data-passed-note />
        <label className="block">
          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Revisit on (optional)</span>
          <input type="date" value={revisit} onChange={(e) => setRevisit(e.target.value)} className="input-base mt-1 text-sm" data-passed-revisit />
          <span className="block text-[11px] text-gray-400 mt-1">It shows on the calendar and on Flags when the day arrives.</span>
        </label>
        {err && <p className="text-xs text-rose-600" data-passed-error>{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="btn-secondary">Cancel</button>
          <button type="submit" className="btn-primary" data-passed-confirm>Mark passed</button>
        </div>
      </form>
    </div>
  )
}
