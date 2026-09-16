import { useState, useEffect } from 'react'
import { FileText, Loader } from 'lucide-react'
import BottomSheet from '../ui/BottomSheet'
import FlagButton from '../FlagButton'

const PAID_STYLES = {
  Paid:    'bg-emerald-100 text-emerald-800',
  Unpaid:  'bg-red-100 text-red-800',
  Partial: 'bg-yellow-100 text-yellow-800',
}

function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{label}</span>
      <span className="text-[13px] text-ink break-words">{children || '—'}</span>
    </div>
  )
}

function shortDate(d) {
  if (!d) return null
  return String(d).slice(0, 10)
}

/**
 * Mobile detail drawer for a ledger entry. v1 quick actions only:
 * paid-status cycle, flag, notes editing, and file VIEWING. Everything
 * else (splits, inline field matrix, uploads) stays desktop-only.
 */
export default function LedgerEntrySheet({
  entry, onClose, fmt,
  onCyclePaid, onSaveNotes, savingNotes,
  onToggleFlag, onSaveFlagReason,
  onViewFile,
}) {
  const [notesDraft, setNotesDraft] = useState('')
  useEffect(() => { setNotesDraft(entry?.notes || '') }, [entry?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!entry) return null

  const status = entry.payment_status || 'Unpaid'
  const files = [
    { type: 'invoice', label: 'Invoice', has: !!entry.has_invoice },
    { type: 'w9',      label: 'W9',      has: !!(entry.has_w9 || entry.w9_entry_id) },
    { type: 'proof',   label: 'Proof',   has: !!entry.has_proof },
    { type: 'receipt', label: 'Receipt', has: !!entry.has_receipt },
  ]
  const notesDirty = (notesDraft || '') !== (entry.notes || '')

  return (
    <BottomSheet open={!!entry} onClose={onClose} title={entry.payee || 'Entry'}>
      {/* Headline */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-2xl font-extrabold text-ink">{fmt(entry.amount, entry.currency)}</div>
        <div className="flex items-center gap-2">
          <button
            onClick={onCyclePaid}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold ${PAID_STYLES[status] || PAID_STYLES.Unpaid}`}
            title="Tap to cycle"
          >
            {status}
          </button>
          <FlagButton
            flagged={!!entry.flagged}
            reason={entry.flag_reason || ''}
            onToggle={onToggleFlag}
            onSaveReason={onSaveFlagReason}
            size="sm"
            alwaysVisible
            flaggedBy={entry.flagged_by || ''}
            flaggedAt={entry.flagged_at || null}
          />
        </div>
      </div>

      {/* Details (read-only in v1) */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 mb-4">
        <Field label="Artist">{entry.artist}</Field>
        <Field label="Song">{entry.song}</Field>
        <Field label="Category">{entry.category}</Field>
        <Field label="Invoice #">{entry.invoice_number}</Field>
        <Field label="Invoice date">{shortDate(entry.invoice_date)}</Field>
        <Field label="Due date">{shortDate(entry.scheduled_payment_date)}</Field>
        <Field label="Method">{entry.payment_method}</Field>
        <Field label="Paid date">{shortDate(entry.payment_date)}</Field>
        <Field label="Vendor email">{entry.vendor_email}</Field>
        <Field label="Terms">{entry.payment_terms}</Field>
        <Field label="Recoupable">{entry.recoupable ? 'Yes' : 'No'}</Field>
        <Field label="Campaign">{entry.artist_campaign || '—'}</Field>
        <Field label="Bulk deal">{entry.is_bulk_deal ? 'Yes' : 'No'}</Field>
        <Field label="QB">{entry.in_quickbooks === 'Yes' ? 'Done' : 'Pending'}</Field>
      </div>
      {entry.description && (
        <div className="mb-4">
          <Field label="Description">{entry.description}</Field>
        </div>
      )}

      {/* Notes — the one editable field in mobile v1 */}
      <div className="mb-4">
        <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Notes</div>
        <textarea
          value={notesDraft}
          onChange={(e) => setNotesDraft(e.target.value)}
          rows={3}
          placeholder="Add a note…"
          className="w-full py-2 px-3 rounded-xl border border-rule bg-card text-[13px] text-ink outline-none resize-y"
        />
        {notesDirty && (
          <button
            onClick={() => onSaveNotes(notesDraft)}
            disabled={savingNotes}
            className="mt-1.5 w-full py-2 rounded-xl bg-boom-600 text-white text-[13px] font-bold disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            {savingNotes && <Loader size={13} className="animate-spin" />}
            Save notes
          </button>
        )}
      </div>

      {/* Files — view-only in mobile v1 */}
      <div className="pb-2">
        <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">Files</div>
        <div className="grid grid-cols-2 gap-2">
          {files.map(f => (
            <button
              key={f.type}
              onClick={() => f.has && onViewFile(f.type)}
              disabled={!f.has}
              className={`flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl text-[13px] font-bold border ${
                f.has ? 'border-rule bg-card text-emerald-700' : 'border-divider bg-card text-gray-300'
              }`}
            >
              <FileText size={14} />
              {f.label}{!f.has && ' —'}
            </button>
          ))}
        </div>
      </div>
    </BottomSheet>
  )
}
