import { useState } from 'react'
import { ShieldCheck, FileText, AlertTriangle } from 'lucide-react'
import ReviewDeck, { useDeckPreview } from './ReviewDeck'
import InlineFilePreview from './InlineFilePreview'
import { fileUrl } from '../utils/entryFiles'
import api from '../api'

// The SECOND review on Approvals: is this W9 signed and dated?
//
// John, 2026-08-24: "I want to add a second review to the approvals page for
// w9. The checkbox should be 'signed and dated?' (yes/no). It should be similar
// to the invoice one with a preview of the file."
//
// ── One card per DOCUMENT, not per invoice ──────────────────────────────────
// Measured on the live queue: of 30 pending approvals, 17 carry their own W9
// file. Of the 13 that do not, TWELVE have one on file for that vendor
// elsewhere — exactly one vendor genuinely has none. A per-invoice deck would
// have shown "no W9" on 43% of the queue and re-asked about the same PDF on
// every future invoice from the same person.
//
// So the server groups pending invoices under the W9 that covers them
// (lib/w9-owner.js) and this deck reviews the DOCUMENT. Answering once clears
// every invoice riding on it; a new upload is a new document and comes back.
//
// ── Yes/No, not a checkbox ──────────────────────────────────────────────────
// Same control as bulk_deal and cobrand in ApprovalChecklistDeck, for the same
// reason: "no" is a real answer here and gets recorded as one. A checkbox can
// only ever say yes or say nothing.
//
// ── The answer is PRE-FILLED from the scan ──────────────────────────────────
// John's call. The AI already reads w9_signed and w9_dated on every W9, and on
// today's queue says 16 of 16 pass. I flagged that a pre-ticked box turns an
// attestation into a formality; the mitigation is that the server records
// whether the reviewer ACCEPTED the pre-fill or changed it, so the record can
// still tell "confirmed what the scan said" from "looked and decided".

export default function W9ReviewDeck({ items = [], onReviewed, onClose }) {
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState({})   // { [entryId]: bool } — in-flight overrides
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(0)
  const [skipped, setSkipped] = useState(0)
  const [previewOn, togglePreview] = useDeckPreview()

  const card = items[index]
  const finished = index >= items.length

  // The pre-fill: what the scan read, unless the reviewer has changed it on
  // this card. `undefined` when there is no scan at all — then nothing is
  // pre-selected and the reviewer has to answer from the document.
  const scanSays = card?.scan ? (card.scan.signed === true && card.scan.dated === true) : undefined
  const current = card && answers[card.entry_id] !== undefined ? answers[card.entry_id] : scanSays

  const next = () => { setIndex((i) => i + 1); setErr('') }

  const submit = async (value) => {
    if (!card) return
    setBusy(true); setErr('')
    try {
      await api.post(`/bk/w9-reviews/${card.entry_id}`, {
        signed_and_dated: value,
        prefilled: scanSays !== undefined,
        // Accepted only when the scan offered an answer AND the reviewer kept it.
        accepted_prefill: scanSays !== undefined && value === scanSays,
      })
      setDone((n) => n + 1)
      onReviewed?.(card.entry_id, value)
      next()
    } catch (e) {
      setErr(e?.response?.data?.error || e.message)
    } finally {
      setBusy(false)
    }
  }

  const money = (a, c) => new Intl.NumberFormat('en-US', { style: 'currency', currency: c || 'USD' }).format(a || 0)

  return (
    <ReviewDeck
      index={index}
      total={items.length}
      label={card ? card.payee : ''}
      onClose={onClose}
      closeLabel={done > 0 ? 'Close' : 'Cancel'}
      z={90}
      done={finished}
      doneTitle={done ? `${done} W9${done === 1 ? '' : 's'} reviewed` : 'Nothing reviewed'}
      doneSummary={skipped ? `${skipped} skipped — they stay in the queue.` : ''}
      hint="Y yes · N no · S skip"
      aside={previewOn && card ? (
        <InlineFilePreview
          // fileUrl, not a hand-built path — it appends the auth token, which a
          // literal URL here would have silently omitted into a 401.
          url={fileUrl({ id: card.entry_id }, 'w9')}
          filename={card.w9_filename}
          label="W9"
          meta={card.payee}
          emptyText="No W9 file on this entry." />
      ) : null}
    >
      {() => {
        if (!card) return null
        return (
          <div className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <ShieldCheck size={16} className="text-gray-400" />
              <div className="min-w-0">
                <div className="text-sm font-bold text-gray-900 truncate">{card.payee}</div>
                <div className="text-[11px] text-gray-400 truncate">{card.w9_filename || 'W9 on file'}</div>
              </div>
              <button type="button" onClick={togglePreview}
                className="ml-auto text-[10px] font-semibold text-gray-400 hover:text-gray-600">
                {previewOn ? 'Hide preview' : 'Show preview'}
              </button>
            </div>

            {/* What this document is covering. The whole point of reviewing the
                document once is that it is usually more than one invoice. */}
            <div className="border border-rule rounded-lg p-2.5 mb-3">
              <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">
                Covers {card.invoices.length} pending invoice{card.invoices.length === 1 ? '' : 's'}
              </div>
              {card.invoices.slice(0, 4).map((i) => (
                <div key={i.id} className="flex items-center gap-2 text-[12px] text-gray-600 py-0.5">
                  <FileText size={11} className="text-gray-300 flex-shrink-0" />
                  <span className="truncate">{i.invoice_number || `#${i.id}`}</span>
                  <span className="ml-auto tabular-nums">{money(i.amount, i.currency)}</span>
                </div>
              ))}
              {card.invoices.length > 4 && (
                <div className="text-[11px] text-gray-400 pt-0.5">and {card.invoices.length - 4} more</div>
              )}
            </div>

            {/* What the scan read. Shown because the answer below is pre-filled
                from it — hiding the basis of a pre-selected answer would be
                worse than not pre-selecting at all. */}
            {card.scan && (
              <div className="border border-rule rounded-lg p-2.5 mb-3 bg-gray-50">
                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">The scan read</div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-gray-600">
                  <span>Form: <strong>{card.scan.form_type || 'unknown'}</strong></span>
                  <span>Signed: <strong className={card.scan.signed ? 'text-emerald-600' : 'text-rose-600'}>
                    {card.scan.signed ? 'yes' : 'no'}</strong></span>
                  <span>Dated: <strong className={card.scan.dated ? 'text-emerald-600' : 'text-rose-600'}>
                    {card.scan.dated ? 'yes' : 'no'}</strong></span>
                  {card.scan.name && <span className="truncate">Name: {card.scan.name}</span>}
                </div>
                {card.scan.discrepancies.length > 0 && (
                  <div className="flex items-start gap-1.5 mt-1.5 text-[11px] text-amber-600">
                    <AlertTriangle size={11} className="flex-shrink-0 mt-0.5" />
                    <span>{card.scan.discrepancies.map((d) => d.field).join(' · ')}</span>
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-2 py-2">
              <span className="text-sm font-semibold text-gray-700 w-[150px]">Signed and dated?</span>
              <div className="flex items-center gap-1.5">
                {[['Yes', true], ['No', false]].map(([text, val]) => {
                  const on = current === val
                  return (
                    <button key={text} type="button" disabled={busy}
                      onClick={() => setAnswers((a) => ({ ...a, [card.entry_id]: val }))}
                      className={`px-3 py-1 rounded-md text-[12px] font-bold border-2 transition-colors ${
                        on ? (val ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-gray-600 border-gray-600 text-white')
                           : 'border-gray-300 text-gray-500 hover:border-gray-400'}`}>
                      {text}
                    </button>
                  )
                })}
                {scanSays !== undefined && answers[card.entry_id] === undefined && (
                  <span className="text-[10px] text-gray-400 ml-1">pre-filled from the scan</span>
                )}
              </div>
            </div>

            <p className="text-[11px] text-gray-400 mt-1">
              Answering “no” records the problem and flags the vendor. It does not hold the invoice.
            </p>

            {err && <div className="text-[12px] text-rose-600 mt-2">{err}</div>}

            <div className="flex justify-end gap-2 mt-4">
              <button type="button" disabled={busy}
                onClick={() => { setSkipped((n) => n + 1); next() }}
                className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">Skip</button>
              <button type="button" disabled={busy || current === undefined}
                onClick={() => submit(current)}
                className="px-4 py-1.5 text-sm font-semibold rounded-lg bg-boom-600 text-white hover:bg-boom-700 disabled:opacity-40">
                {busy ? 'Saving…' : 'Record and next'}
              </button>
            </div>
          </div>
        )
      }}
    </ReviewDeck>
  )
}
