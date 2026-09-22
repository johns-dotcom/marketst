// What a contract promises, as the CEO listed it (2026-09-22): deliverables
// (total · delivered · remaining), options (included · current period · ends),
// label and artist split, marketing budget, advance, term, and the signature
// status. Reads `contract.terms` (server lib/contract-terms.js). Used on the
// Contracts detail panel and the artist's Contracts tab.
import { useState } from 'react'
import { CheckCircle2, Circle, ChevronRight, PenLine } from 'lucide-react'
import api from '../api'

export const SIG_LABEL = { draft: 'Not sent', sent: 'Sent', signed: 'Signed', fully_executed: 'Fully executed' }
export const SIG_TONE = { draft: 'bg-gray-100 text-gray-600 border-gray-200', sent: 'bg-amber-50 text-amber-700 border-amber-200', signed: 'bg-blue-50 text-blue-700 border-blue-200', fully_executed: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
const money = (n) => (n === null || n === undefined ? '—' : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`)
const dateOf = (d) => (d ? new Date(d + (String(d).length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—')

export function SignatureStatusPill({ status }) {
  return <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${SIG_TONE[status] || SIG_TONE.draft}`} data-signature-status={status || 'draft'}><PenLine size={10} /> {SIG_LABEL[status] || 'Not sent'}</span>
}

export default function ContractTerms({ contract, canEdit = false, onChange, compact = false }) {
  const t = contract?.terms
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (!t) return null
  const setSignature = async (v) => {
    setBusy(true); setErr('')
    try { const r = await api.put(`/contracts/${contract.id}`, { signature_status: v || null }); onChange?.(r.data.data) } catch (e) { setErr(e?.response?.data?.error || 'Could not save') } finally { setBusy(false) }
  }
  const exercise = async () => {
    if (!window.confirm(`Exercise option ${t.options_exercised + 1}${t.options_total ? ` of ${t.options_total}` : ''}? The term extends by ${t.term_years ?? '?'} year${t.term_years === 1 ? '' : 's'}.`)) return
    setBusy(true); setErr('')
    try { const r = await api.post(`/contracts/${contract.id}/exercise-option`); onChange?.(r.data.data) } catch (e) { setErr(e?.response?.data?.error || 'Could not exercise the option') } finally { setBusy(false) }
  }
  const soon = t.days_to_period_end !== null && t.days_to_period_end <= 90
  const cell = (label, value, extra, testId) => (
    <div data-term={testId}><p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">{label}</p><p className={`${compact ? 'text-sm' : 'text-base'} font-semibold text-gray-900 tabular-nums`}>{value}</p>{extra && <p className="text-[11px] text-gray-500">{extra}</p>}</div>
  )
  return (
    <div className="space-y-3" data-contract-terms>
      <div className={`grid ${compact ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2 md:grid-cols-4'} gap-3`}>
        {cell('Deliverables', t.deliverables_total === null ? `${t.delivered} delivered` : `${t.delivered} of ${t.deliverables_total}`, t.deliverables_total === null ? 'no total on the contract' : `${t.remaining} remaining${t.scheduled ? ` · ${t.scheduled} scheduled` : ''}`, 'deliverables', 'deliverables')}
        {cell('Options', t.options_total === null ? '—' : `${t.options_exercised} of ${t.options_total} used`, t.options_total === null ? 'none recorded' : `period ${t.current_period}${t.options_remaining ? ` · ${t.options_remaining} left` : ' · last period'}`, 'options', 'options')}
        {cell('Current period ends', dateOf(t.period_end), t.days_to_period_end === null ? null : t.days_to_period_end < 0 ? <span className="text-rose-600 font-semibold">ended {-t.days_to_period_end}d ago</span> : soon ? <span className="text-amber-700 font-semibold">in {t.days_to_period_end} days</span> : `in ${t.days_to_period_end} days`, 'period-end', 'period-end')}
        {cell('Term', t.term_years === null ? '—' : `${t.term_years} yr${t.term_years === 1 ? '' : 's'}`, t.term_years !== null && t.options_total ? `${t.term_years * (1 + t.options_total)} yrs if every option is taken` : null, 'term')}
        {cell('Label split', t.label_split === null ? '—' : `${t.label_split}%`, null, 'label-split')}
        {cell('Artist split', t.artist_split === null ? '—' : `${t.artist_split}%`, null, 'artist-split')}
        {cell('Marketing budget', money(t.marketing_budget), 'agreed', 'marketing-budget')}
        {cell('Advance', money(t.advance), null, 'advance')}
      </div>
      <div className="flex items-center gap-3 flex-wrap" data-term="signature">
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Signature</span>
        <SignatureStatusPill status={t.signature} />
        <span className="text-[11px] text-gray-400">{t.signature_source === 'docusign' ? 'from DocuSign' : t.signature_source === 'manual' ? 'set by hand' : t.signature_source === 'date_signed' ? 'from the signing date' : ''}</span>
        {canEdit && (
          <select value={contract.signature_status_manual ? contract.signature_status || '' : ''} onChange={(e) => setSignature(e.target.value)} disabled={busy} className="select-base text-xs py-1" aria-label="Set signature status" data-signature-select>
            <option value="">{contract.signature_status_manual ? 'Clear the hand-set status' : 'Set by hand…'}</option>
            {Object.entries(SIG_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        )}
        {canEdit && t.options_total !== null && t.options_remaining > 0 && (
          <button type="button" onClick={exercise} disabled={busy} className="ml-auto inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-lg bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-40" data-exercise-option>Exercise option {t.options_exercised + 1} <ChevronRight size={12} /></button>
        )}
      </div>
      {!compact && t.deliverables.length > 0 && (
        <ul className="text-xs divide-y divide-divider border border-rule rounded-lg" data-term-deliverables>
          {t.deliverables.map((r) => <li key={r.id} className="flex items-center gap-2 px-3 py-1.5"><span className={r.delivered ? 'text-emerald-500' : 'text-gray-300'}>{r.delivered ? <CheckCircle2 size={13} /> : <Circle size={13} />}</span><span className="flex-1 text-gray-800">{r.project_name}</span><span className="text-gray-400">{r.release_date ? dateOf(r.release_date) : 'no date'}{r.delivered ? '' : ' · scheduled'}</span></li>)}
        </ul>
      )}
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  )
}
