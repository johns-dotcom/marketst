import { useRef } from 'react'
import { Loader, CheckCircle2, Undo2, Send, Zap, Pause, Upload, FileText, Receipt } from 'lucide-react'
import BottomSheet from '../ui/BottomSheet'

function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{label}</span>
      <span className="text-[13px] text-ink break-words">{children || '—'}</span>
    </div>
  )
}

function ActionBtn({ icon: Icon, label, onClick, tone = 'neutral', disabled, busy }) {
  const tones = {
    green:   'bg-emerald-600 text-white',
    red:     'bg-red-50 text-red-700 border border-red-200',
    amber:   'bg-amber-50 text-amber-800 border border-amber-200',
    neutral: 'bg-card text-gray-700 border border-rule',
    blue:    'bg-blue-50 text-blue-700 border border-blue-200',
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={`flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl text-[13px] font-bold active:scale-[0.98] disabled:opacity-50 ${tones[tone]}`}
    >
      {busy ? <Loader size={14} className="animate-spin" /> : <Icon size={14} />}
      {label}
    </button>
  )
}

/**
 * Detail + actions drawer for a tapped payment card. Replaces the
 * desktop status popover / inline row actions on mobile. All mutations
 * go through the handlers BkPayments already uses for the table.
 */
export default function PaymentSheet({
  entry, onClose, fmt, fmtDate, busy, uploading, displayAmount,
  onMarkPaid, onMarkUnpaid, onSendConfirmation,
  onRush, onClearRush, onHold, onClearHold,
  onUploadProof, onViewInvoice, onViewProof,
}) {
  const fileRef = useRef(null)
  if (!entry) return null
  const isPaid = entry.payment_status === 'Paid'

  return (
    <BottomSheet open={!!entry} onClose={onClose} title={entry.payee || 'Payment'}>
      {/* Amount headline — family total for split parents, matching the card */}
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-2xl font-extrabold text-ink">{fmt(displayAmount ?? entry.amount, entry.currency)}</div>
          {displayAmount != null && Number(displayAmount) !== Number(entry.amount) && (
            <div className="text-[11px] text-gray-400">Split family total · this slice {fmt(entry.amount, entry.currency)}</div>
          )}
        </div>
        <div className="text-xs text-gray-500">
          {isPaid ? `Paid ${fmtDate(entry.payment_date)}` : entry.scheduled_payment_date ? `Due ${fmtDate(entry.scheduled_payment_date)}` : 'No due date'}
        </div>
      </div>

      {entry.rush_requested && !isPaid && entry.rush_reason && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
          <span className="font-bold">Rush:</span> {entry.rush_reason}
        </div>
      )}
      {entry.on_hold && !isPaid && entry.hold_reason && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-gray-100 border border-rule text-xs text-gray-700">
          <span className="font-bold">On hold:</span> {entry.hold_reason}
        </div>
      )}

      {/* Details */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 mb-4">
        <Field label="Invoice #">{entry.invoice_number}</Field>
        <Field label="Method">{entry.payment_method}</Field>
        <Field label="Artist">{entry.artist}</Field>
        <Field label="Market Street rep">{entry.boom_rep}</Field>
        <Field label="Terms">{entry.payment_terms}</Field>
        <Field label="Invoice date">{fmtDate(entry.invoice_date)}</Field>
        <Field label="Vendor email">{entry.vendor_email}</Field>
        <Field label="Reference">{entry.payment_ref}</Field>
      </div>
      {entry.notes && (
        <div className="mb-4">
          <Field label="Notes">{entry.notes}</Field>
        </div>
      )}

      {/* Actions */}
      <div className="grid grid-cols-2 gap-2 pb-2">
        {!isPaid ? (
          <ActionBtn icon={CheckCircle2} label="Mark Paid" tone="green" busy={busy} onClick={onMarkPaid} />
        ) : (
          <ActionBtn icon={Undo2} label="Mark Unpaid" tone="neutral" busy={busy} onClick={onMarkUnpaid} />
        )}
        <ActionBtn
          icon={Upload}
          label={entry.has_proof ? 'Replace proof' : 'Upload proof'}
          tone="blue"
          busy={uploading}
          onClick={() => fileRef.current?.click()}
        />
        {isPaid && entry.vendor_email && (
          <ActionBtn
            icon={Send}
            label={entry.confirmation_sent ? 'Resend confirmation' : 'Send confirmation'}
            tone="blue"
            onClick={onSendConfirmation}
          />
        )}
        {!isPaid && (entry.rush_requested
          ? <ActionBtn icon={Zap} label="Clear rush" tone="amber" onClick={onClearRush} />
          : <ActionBtn icon={Zap} label="Request rush" tone="amber" onClick={onRush} />
        )}
        {!isPaid && (entry.on_hold
          ? <ActionBtn icon={Pause} label="Release hold" tone="neutral" onClick={onClearHold} />
          : <ActionBtn icon={Pause} label="Put on hold" tone="neutral" onClick={onHold} />
        )}
        {entry.has_invoice && (
          <ActionBtn icon={FileText} label="View invoice" tone="neutral" onClick={onViewInvoice} />
        )}
        {entry.has_proof && (
          <ActionBtn icon={Receipt} label="View proof" tone="neutral" onClick={onViewProof} />
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,.webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) onUploadProof(f)
        }}
      />
    </BottomSheet>
  )
}
