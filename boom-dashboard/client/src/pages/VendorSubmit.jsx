import { useState, useRef, useCallback, useEffect } from 'react'
import { normalizeInvoiceNum } from '../utils'
import { CATEGORIES, CURRENCY_OPTIONS as CURRENCIES } from '../constants'
import { useCategories } from '../context/CategoriesContext'
import { useBoomReps } from '../context/BoomRepsContext'
import '../styles/marketst-form.css'
import useUnsavedWarning from '../hooks/useUnsavedWarning'

// Always render a safe, human-readable string — Claude may sometimes return
// each issue as an object instead of a string, which crashes React.
function issueText(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') return v.issue || v.problem || v.description || v.message || v.field || JSON.stringify(v)
  return String(v)
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const isValidEmail = (s) => EMAIL_RE.test(String(s || '').trim())

// Supporting files, over and above the one required invoice. MUST match the
// `file_extra` maxCount in server/routes/vendor-submit.js: multer rejects the
// entire request when the count is exceeded, so a mismatch here does not drop
// the extras, it fails the submission.
const EXTRA_FILE_MAX = 9
// Must match INVOICE_MAX in server/routes/vendor-submit.js. The server REFUSES a
// batch over the cap rather than trimming it — silently dropping invoices 11 and
// 12 would show a success page for a submission that lost two bills — so the
// browser's job is to make that refusal unreachable, not to be the only guard.
const INVOICE_MAX = 10

// Mirrors lib/payment-fields.js. Used only to decide whether the account number
// is required on an INTERNATIONAL wire: an IBAN already contains it, a SWIFT/BIC
// does not. The server decides for real; this just avoids asking for a box the
// vendor has no answer for.
// ABA routing checksum (mod 10 with weights 3-7-1), as lib/payment-fields.js
// checks it. Mirrored so a mistyped routing number is caught on step 1, not as
// a 400 after the whole wizard.
const abaValid = (v) => { const d = String(v || '').replace(/\D/g, ''); if (d.length !== 9) return false; const w = [3, 7, 1, 3, 7, 1, 3, 7, 1]; return d.split('').reduce((t, c, i) => t + Number(c) * w[i], 0) % 10 === 0 }
const alnumUp = (v) => String(v || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
const looksLikeIban = (v) => /^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(alnumUp(v))
const looksLikeSwift = (v) => /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(alnumUp(v))
/** A SWIFT names the bank but not the account, so then we must ask for one. */
const swiftNeedsAccount = (v) => looksLikeSwift(v) && !looksLikeIban(v)

// A labelled text input, matching the chrome the rest of step 1 already uses.
// Small enough to live here; the payment block is its only caller and a shared
// component would just be indirection.
function Field({ label, required, value, onChange, placeholder, className = '', type = 'text' }) {
  return (
    <div className={className}>
      <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">
        {label} {required && <span className="text-red-600">*</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border-2 border-rule rounded-lg px-3 py-2.5 text-sm outline-none focus:border-red-500 transition-colors bg-card"
      />
    </div>
  )
}

// ── DropZone component ───────────────────────────────────────────────────────
function DropZone({ id, label, required, hint, file, onFile }) {
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef()

  const handleDrop = useCallback(e => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) onFile(f)
  }, [onFile])

  return (
    <div>
      {label && (
        <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">
          {label} {required && <span className="text-red-600">*</span>}
        </label>
      )}
      <div
        role="button" tabIndex={0}
        aria-label={file ? `${label || 'File'}: ${file.name}. Press Enter to replace it` : `${label || 'File'}: click or press Enter to choose a file`}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click() } }}
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`
          border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-all
          ${file
            ? 'border-green-400 border-solid bg-green-50'
            : dragOver
              ? 'border-red-500 bg-red-50'
              : 'border-rule bg-gray-50 hover:border-red-400 hover:bg-red-50'
          }
        `}
      >
        {file
          ? <p className="text-sm font-bold text-green-700">{file.name}</p>
          : <p className="text-sm font-bold text-gray-700">Click or drop file</p>
        }
        <p className="text-xs text-gray-400 mt-1">PDF, JPG, PNG — up to 25 MB</p>
      </div>
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,.webp"
        className="sr-only"
        tabIndex={-1}
        onChange={e => e.target.files[0] && onFile(e.target.files[0])}
      />
    </div>
  )
}

// ── RosterPicker ─────────────────────────────────────────────────────────────
// Type-to-filter combobox over the Market Street artist roster with an "Artist not on
// our roster" escape hatch. Two modes:
//   • Roster mode (default) — input acts as a search filter over `roster`.
//     Dropdown lists matches, always closes with a "+ Not on our roster"
//     option that flips into free-text mode.
//   • Off-roster mode — plain text input tagged with an amber "Off-roster"
//     chip and an × to switch back. The vendor's typed value passes through
//     untouched; the server later re-verifies against the current roster so
//     a since-added artist won't get labelled off-roster in the ledger.
//
// Kept inline (not shared with SearchableSelect) because that component is
// light-only + doesn't have the free-text escape hatch, and cross-page reuse
// of this pattern isn't yet a real need.
function RosterPicker({ value, offRoster, onChange, roster, placeholder, warningRing }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(-1)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false); setQuery(''); setHighlighted(-1)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const baseInputCls = 'w-full border-2 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors min-w-0'
  const ringCls = warningRing || 'border-rule focus:border-red-500'

  if (offRoster) {
    // Free-text mode. The chip sits inside the input's right padding so it
    // stays anchored regardless of the vendor's typed length.
    return (
      <div ref={wrapRef} className="relative flex-[2] min-w-0">
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value, true)}
          placeholder={placeholder}
          className={`${baseInputCls} ${ringCls} pr-28`}
        />
        <button
          type="button"
          onClick={() => onChange('', false)}
          title="This artist is on our roster after all — go back to the picker"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-800 ring-1 ring-amber-300 hover:bg-amber-200"
        >
          Off-roster
          <span className="text-amber-700 font-black">×</span>
        </button>
      </div>
    )
  }

  // Roster mode. When focused, `query` overlays `value` and drives filtering;
  // committing (click or Enter) resolves it into the selected artist name.
  const q = query.trim().toLowerCase()
  const filtered = q
    ? roster.filter(a => a.toLowerCase().includes(q))
    : roster
  const cap = 60 // Keep the dropdown scannable — vendors rarely need every roster name at once
  const shown = filtered.slice(0, cap)

  const commitRoster = (name) => {
    onChange(name, false)
    setOpen(false); setQuery(''); setHighlighted(-1)
  }
  const commitOffRoster = () => {
    const typed = query.trim() || value.trim()
    onChange(typed, true)
    setOpen(false); setQuery(''); setHighlighted(-1)
  }

  const onKeyDown = (e) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      e.preventDefault(); setOpen(true); return
    }
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      // The off-roster row is the "last" option — index === shown.length
      setHighlighted(h => Math.min(h + 1, shown.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted(h => Math.max(h - 1, -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlighted >= 0 && highlighted < shown.length) commitRoster(shown[highlighted])
      else if (highlighted === shown.length) commitOffRoster()
      else if (shown.length === 1 && q) commitRoster(shown[0])
      else if (shown.length === 0 && q) commitOffRoster()
    } else if (e.key === 'Escape') {
      setOpen(false); setQuery(''); setHighlighted(-1)
    }
  }

  return (
    <div ref={wrapRef} className="relative flex-[2] min-w-0">
      <input
        type="text"
        value={open ? query : value}
        onChange={e => { setQuery(e.target.value); setHighlighted(-1); if (!open) setOpen(true) }}
        onFocus={() => { setOpen(true); setQuery('') }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={`${baseInputCls} ${ringCls}`}
      />
      {open && (
        <div
          className="absolute z-50 left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-lg border border-rule bg-card shadow-lg"
        >
          {shown.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-400">
              {roster.length === 0
                ? 'Loading roster…'
                : q ? `No roster matches for "${query.trim()}"` : 'No artists yet'}
            </div>
          ) : (
            shown.map((name, idx) => (
              <div
                key={name}
                onMouseDown={e => { e.preventDefault(); commitRoster(name) }}
                onMouseEnter={() => setHighlighted(idx)}
                className={`px-3 py-2 text-sm cursor-pointer ${
                  idx === highlighted ? 'bg-red-50 text-red-700' : 'text-gray-800 hover:bg-gray-50'
                } ${name.toLowerCase() === (value || '').toLowerCase() ? 'font-bold' : ''}`}
              >
                {name}
              </div>
            ))
          )}
          {filtered.length > cap && (
            <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-400 bg-gray-50 border-t border-rule">
              Showing first {cap} of {filtered.length} — keep typing to narrow
            </div>
          )}
          {/* Persistent off-roster escape hatch. Distinct visual so it doesn't
              look like just another roster row — amber tint mirrors the chip
              the vendor sees once they're in off-roster mode. */}
          <div
            onMouseDown={e => { e.preventDefault(); commitOffRoster() }}
            onMouseEnter={() => setHighlighted(shown.length)}
            className={`px-3 py-2 text-xs font-semibold cursor-pointer border-t border-rule ${
              highlighted === shown.length
                ? 'bg-amber-100 text-amber-900'
                : 'bg-amber-50 text-amber-800 hover:bg-amber-100'
            }`}
          >
            {q
              ? <>+ Use <span className="font-black">"{query.trim()}"</span> — not on our roster</>
              : <>+ Artist not on our roster</>}
          </div>
        </div>
      )}
    </div>
  )
}

// ── One invoice, on step 2 ───────────────────────────────────────────────────
//
// A row is a document plus the number printed on it, and that pairing is the
// point: the server compares what was typed here against what the AI reads off
// THIS file, so the two must be adjacent and unmistakably about each other. The
// supporting files sit inside the row for the same reason — "additional files"
// floating at the bottom of the step would be ambiguous the moment there are
// two invoices.
function InvoiceRow({ index, inv, total, isReimb, errors, onNumber, onFile, onReceipt, onExtras, onRemove }) {
  const bad = errors.length > 0
  return (
    <div className={`border-2 rounded-xl overflow-hidden ${bad ? 'border-red-300 bg-red-50/40' : 'border-rule'}`}>
      <div className="px-4 py-2 flex items-center gap-2 bg-gray-50 border-b border-rule">
        <span className="w-5 h-5 rounded-full bg-gray-700 text-white text-[11px] font-black flex items-center justify-center flex-shrink-0">
          {index + 1}
        </span>
        <span className="text-xs font-black uppercase tracking-wide text-gray-600">
          {isReimb ? 'Reimbursement' : 'Invoice'} {total > 1 ? `${index + 1} of ${total}` : ''}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove invoice ${index + 1}`}
            className="ml-auto text-xs font-bold text-gray-400 hover:text-red-600 px-2 py-1"
          >
            Remove
          </button>
        )}
      </div>
      <div className="p-4 flex flex-col gap-3">
        {errors.map((e, k) => (
          <p key={k} className="text-xs font-semibold text-red-600">{e}</p>
        ))}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <DropZone
              label={isReimb ? 'Receipt / Invoice' : 'Invoice File'}
              required
              file={inv.file}
              onFile={onFile}
            />
            {inv.validating && (
              <div className="mt-1.5 flex items-center gap-2 text-xs text-blue-600">
                <span className="animate-spin">⟳</span> Scanning invoice...
              </div>
            )}
            {/* The document did not print a way to pay the vendor. Shown apart
                from the amber advisory because an approver acts on it. */}
            {!isReimb && inv.validation?.payment_methods?.acceptable === false && (
              <div className="mt-1.5 bg-red-50 border-2 border-red-300 rounded-lg p-3">
                <p className="text-xs font-bold text-red-700 mb-1">Payment info missing on the invoice</p>
                <p className="text-xs text-red-700">
                  {inv.validation.payment_methods.message
                    || 'Please add your bank account + routing number, or your PayPal email / handle, directly on the invoice and re-upload.'}
                </p>
                <p className="text-[10px] text-red-500 mt-2">
                  A "Pay" link to a portal (Stripe, QuickBooks, etc.) is not accepted — we need the info on the document so AP can push funds directly.
                </p>
              </div>
            )}
            {inv.validation && !inv.validation.valid && (() => {
              const payMsg = inv.validation.payment_methods?.message
              const otherIssues = (Array.isArray(inv.validation.issues) ? inv.validation.issues : [])
                .filter(i => !payMsg || issueText(i) !== payMsg)
              if (otherIssues.length === 0) return null
              return (
                <div className="mt-1.5 bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <p className="text-xs font-bold text-amber-700 mb-1">Our scan flagged a few notes:</p>
                  {otherIssues.map((issue, k) => (
                    <p key={k} className="text-xs text-amber-700 flex items-start gap-1.5">
                      <span className="text-amber-400 mt-0.5">•</span> {issueText(issue)}
                    </p>
                  ))}
                  <p className="text-[10px] text-amber-500 mt-2">You can still submit — an admin will review.</p>
                </div>
              )
            })()}
            {inv.validation && inv.validation.valid && (
              <div className="mt-1.5 flex items-center gap-2 text-xs text-green-600 font-semibold">
                <span>✓</span> Invoice looks good
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">
              Invoice Number <span className="text-red-600">*</span>
            </label>
            <input
              type="text"
              value={inv.invoiceNum}
              onChange={e => onNumber(e.target.value)}
              placeholder="e.g. INV-2024-001"
              aria-label={`Invoice number for invoice ${index + 1}`}
              className={`w-full border-2 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors ${
                inv.dup.duplicate
                  ? 'border-amber-400 bg-amber-50 focus:border-amber-500'
                  : 'border-rule focus:border-red-500'
              }`}
            />
            <p className="text-xs text-gray-400 mt-1.5 leading-snug">
              Must match the number printed on the document.
            </p>
            {/* Amber, not red, and it does not stop anyone. The check matches on
                a normalized number — 001 and 1 are the same to it, and #, INV-
                and No. all collapse together — so it is a useful heads-up and a
                bad verdict. */}
            {inv.dup.duplicate && (
              <div className="mt-1.5 bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="text-xs font-bold text-amber-800 mb-1">We may already have this one</p>
                <p className="text-xs text-amber-800">
                  Something with invoice number "{inv.invoiceNum.trim()}" is already on file for you.
                  If this is a different invoice that happens to reuse the number, carry on —
                  we&rsquo;ll check it on our side.
                </p>
              </div>
            )}
            {isReimb && (
              <div className="mt-3">
                <DropZone
                  label="Supporting Receipt"
                  required
                  file={inv.receiptFile}
                  onFile={onReceipt}
                  hint="Original receipt, email confirmation, etc."
                />
              </div>
            )}
          </div>
        </div>

        {/* Additional files, for THIS invoice. Not a DropZone: that component
            holds ONE file and shows its name in place, which is the wrong shape
            for a list somebody adds to and removes from. */}
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">
            Additional Files
            <span className="text-gray-400 normal-case font-normal tracking-normal ml-1">
              — optional. Extra pages or timesheets for this invoice.
            </span>
          </p>
          {inv.extraFiles.length > 0 && (
            <div className="flex flex-col gap-1.5 mb-2">
              {inv.extraFiles.map((f, k) => (
                <div key={`${f.name}-${k}`} className="flex items-center gap-2 bg-gray-50 border border-rule rounded-lg px-3 py-2">
                  <span className="flex-1 text-sm font-semibold text-gray-700 truncate" title={f.name}>{f.name}</span>
                  <span className="text-xs text-gray-400 flex-shrink-0">{(f.size / 1024).toFixed(0)} KB</span>
                  <button
                    type="button"
                    onClick={() => onExtras(prev => prev.filter((_, j) => j !== k))}
                    className="text-gray-400 hover:text-red-600 text-lg leading-none px-1 flex-shrink-0"
                    aria-label={`Remove ${f.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {inv.extraFiles.length < EXTRA_FILE_MAX && (
            <label className="block border-2 border-dashed border-rule rounded-lg px-3 py-2.5 text-center cursor-pointer bg-gray-50 hover:border-red-400 hover:bg-red-50 transition-colors">
              <span className="text-sm font-bold text-gray-700">
                + Add {inv.extraFiles.length ? 'another file' : 'files'}
              </span>
              <input
                type="file"
                multiple
                accept=".pdf,.jpg,.jpeg,.png,.webp"
                className="sr-only"
                onChange={e => {
                  // Truncate to the cap HERE rather than letting the server
                  // silently drop the overflow: multer's maxCount rejects the
                  // whole request, so a vendor who picked twelve files would
                  // otherwise see the submit fail with nothing that says why.
                  const picked = Array.from(e.target.files || [])
                  onExtras(prev => [...prev, ...picked].slice(0, EXTRA_FILE_MAX))
                  e.target.value = ''   // so re-picking the same file fires onChange again
                }}
              />
            </label>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Success screen ───────────────────────────────────────────────────────────
// `count` is how many invoices the SERVER says it created, not how many the page
// thought it sent — a vendor who submitted five needs to be told five arrived by
// the thing that wrote them.
function SuccessScreen({ vendorName, onReset, count = 1 }) {
  const many = count > 1
  return (
    <div className="ms-form ms-success min-h-screen bg-gray-100 flex flex-col items-center justify-center p-6" data-step="3">
      <div className="mb-8"><span className="ms-sign">Market.st</span></div>
      <div className="ms-card ms-card-big bg-card border border-rule rounded-2xl p-12 max-w-md w-full text-center shadow-lg">
        <div className="mx-auto mb-4 w-16 h-16 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-3xl font-bold">✓</div>
        <h1 className="ms-h1 text-xl font-black text-gray-900 mb-2">
          {many ? `${count} Invoices Received` : 'Invoice Received'}
        </h1>
        <p className="text-sm text-gray-500 mb-1">Thanks, <span className="text-red-600 font-bold">{vendorName}</span>.</p>
        <p className="text-sm text-gray-500 leading-relaxed mb-5">
          {many
            ? `Your ${count} invoices and documents have been submitted to Market Street and are now under review — each one is reviewed on its own.`
            : 'Your invoice and documents have been submitted to Market Street and are now under review.'}
        </p>
        {/* Payment terms, stated to the vendor at the one moment they are
            actually wondering. Not decorative — it is what the submission really
            does: routes/vendor-submit.js writes payment_terms 'Net 30' and a
            scheduled_payment_date of NOW() + 30 days, so the clock starts at
            SUBMISSION, not at approval or at the invoice date. The date below is
            computed the same way for that reason.

            Phrased as "on or around" and "once approved" because the stored date
            is a schedule, not a promise — approval is a separate step and this
            screen must not commit Market Street to a payment it has not reviewed. */}
        <div className="text-left bg-gray-50 border border-rule rounded-xl px-4 py-3 mb-6">
          <p className="text-[13px] font-bold text-gray-900 mb-1">Payment terms: Net 30</p>
          <p className="text-[12px] text-gray-500 leading-relaxed">
            Once approved, this invoice is scheduled for payment 30 days from today
            {' — on or around '}
            <span className="font-semibold text-gray-700">
              {new Date(Date.now() + 30 * 86400000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
            </span>.
          </p>
        </div>
        <hr className="border-rule mb-6" />
        <p className="text-xs text-gray-400 mb-4">We'll be in touch if we need anything else.</p>
        <button
          onClick={onReset}
          className="ms-enter ms-enter--ink bg-red-600 hover:bg-red-700 text-white font-bold text-sm px-6 py-3 rounded-lg transition-colors"
        >
          <span className="ms-enter-bracket" aria-hidden>]</span> Submit Another <kbd className="ms-enter-key" aria-hidden>Enter</kbd>
        </button>
      </div>
    </div>
  )
}

// ── Main form ────────────────────────────────────────────────────────────────
export default function VendorSubmit() {
  // Live expense categories. Bound to the same name the module-level
  // import used, so every CATEGORIES reference in this component now
  // reads the vocabulary from context (which falls back to that same
  // constant if the fetch fails). Categories are user-created on the
  // Statements and Reports pages — a hardcoded list here would leave
  // this dropdown unable to render its own rows' values.
  const CATEGORIES = useCategories()
  const BOOM_REPS = useBoomReps()
  // Tab title — the public form shouldn't read "Admin Dashboard" (the
  // server also rewrites the /submit HTML title for link previews).
  useEffect(() => {
    const prev = document.title
    document.title = 'Market Street — Vendor Submit'
    return () => { document.title = prev }
  }, [])
  const [mode, setMode] = useState('invoice') // 'invoice' | 'reimbursement'
  const [step, setStep] = useState(1) // 1: Your Info, 2: Documents, 3: Project Info
  const [submitted, setSubmitted] = useState(false)
  // Closing the tab mid-form loses the attached files (the draft keeps only text).
  useUnsavedWarning(!submitted && step > 1)
  const [submittedName, setSubmittedName] = useState('')
  const [submittedCount, setSubmittedCount] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [parsing, setParsing] = useState(false)
  // Admin-only skip-validation toggle. State lives here so it's stable across
  // renders, but the setter is only exposed when ?admin_preview=1 is set.
  const [skipValidation, setSkipValidationRaw] = useState(false)

  // Section 1
  const [vendorName, setVendorName]       = useState('')
  const [vendorEmail, setVendorEmail]     = useState('')
  // Optional extra emails (accounting@, manager, etc.) — saved server-side
  // per vendor and CC'd on payment-confirmation emails. Max 4 extras.
  const [extraEmails, setExtraEmails]     = useState([])
  const [paymentPref, setPaymentPref]     = useState('')
  // No `vendorBank`: bank name moved INTO the payment block, where PayPal
  // vendors are not asked for one they do not have. See payBankName below.
  //
  // The mailing address came BACK on 2026-08-31, optional. It was dropped
  // earlier that day to stop asking for two addresses, and the cost of that
  // showed up immediately: a 1099-NEC needs the RECIPIENT's address, a bank
  // address is the bank's, and chasing 190 vendors for it in January is a worse
  // afternoon than one optional box now. Optional rather than required because
  // it is not needed to PAY anyone — only to file at year end.
  const [vendorAddress, setVendorAddress] = useState('')
  // ── How we actually pay them ─────────────────────────────────────────────
  // Until now the form collected a payment PREFERENCE and a bank NAME, and the
  // real coordinates lived only inside the uploaded PDF — which is why an invoice
  // that did not print them was refused outright. They are fields now, so a
  // vendor who forgot to put them on the invoice can still be paid.
  //
  // The server is the authority on which of these are required
  // (server/lib/payment-fields.js); this list only decides what to render.
  const [payAccount, setPayAccount]   = useState('')
  const [payRouting, setPayRouting]   = useState('')
  const [payHolder, setPayHolder]     = useState('')
  const [payIbanSwift, setPayIbanSwift] = useState('')
  const [payBankAddress, setPayBankAddress] = useState('')
  const [payPaypal, setPayPaypal]     = useState('')
  // The rest of what a payment run needs, as opposed to what merely identifies
  // an account: an ACH batch carries a checking/savings transaction code and the
  // receiving bank, and a wire needs the beneficiary's own address. These were
  // only ever inside the PDF.
  const [payAccountType, setPayAccountType] = useState('')
  const [payBankName, setPayBankName] = useState('')
  const [payBeneficiaryAddress, setPayBeneficiaryAddress] = useState('')
  const [payIntermediaryBank, setPayIntermediaryBank] = useState('')
  // 'Domestic' | 'International'. A wire is two instruments wearing one name:
  // a US wire is an ABA plus an account number and has no IBAN to give.
  const [payWireScope, setPayWireScope] = useState('')
  // What we already hold for this email, if anything: { on_file, method, last4 }
  const [payOnFile, setPayOnFile]     = useState(null)
  const [payReuse, setPayReuse]       = useState(false)
  const [w9OnFile, setW9OnFile]           = useState(false)

  // Section 2
  const [artistRows, setArtistRows] = useState([{ artist: '', song: '', amount: '', off_roster: false }])
  // Market Street artist roster — fetched once on mount for the RosterPicker. Never
  // gates the form: an empty roster (offline, endpoint 500) just means the
  // picker shows an empty list and every row lands as off-roster, which the
  // server re-validates anyway.
  const [roster, setRoster] = useState([])
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/vendor/roster')
        if (!r.ok) return
        const d = await r.json()
        if (!cancelled && Array.isArray(d?.artists)) setRoster(d.artists)
      } catch {}
    })()
    return () => { cancelled = true }
  }, [])
  // Lowercase index of the current roster for fast case-insensitive
  // membership + snap-to-canonical-casing checks. Rebuilt whenever the
  // roster fetch resolves.
  const rosterIndex = (() => {
    const m = new Map()
    for (const name of roster) m.set(name.toLowerCase(), name)
    return m
  })()
  // Whenever the roster arrives after an AI pre-fill (race — either can
  // land first), re-check row 0's artist. If it matches the roster we
  // snap to canonical casing and clear off_roster; if it doesn't and the
  // row isn't empty we mark off_roster so the vendor sees the chip.
  useEffect(() => {
    if (roster.length === 0) return
    setArtistRows(prev => prev.map(row => {
      const name = (row.artist || '').trim()
      if (!name) return row
      const match = rosterIndex.get(name.toLowerCase())
      if (match) return { ...row, artist: match, off_roster: false }
      return { ...row, off_roster: true }
    }))
  }, [roster.length])
  // Optional social handles (per submission). Default to empty list — only
  // serialized if the vendor actually adds something.
  const [socialRows, setSocialRows] = useState([{ platform: 'Instagram', handle: '', amount: '' }])
  const [category, setCategory]     = useState('')
  const [currency, setCurrency]     = useState('USD')
  const [boomRep, setBoomRep]       = useState('')
  // Short description of what the invoice is for. Separate from the
  // collapsible Notes below — description is a first-class field on the
  // expense row (persists to /bk/entries → description column), Notes
  // is free-form context that lands on the notes column.
  const [description, setDescription] = useState('')

  // ── Section 3: THE INVOICES ────────────────────────────────────────────────
  //
  // John, 2026-09-15: "allow users to upload multiple invoices in one
  // submission" — and then, looking at step 2: "i feel like it should be in
  // step 2."
  //
  // So Documents IS the list. Every invoice is a row here — its document, its
  // number, its own supporting files — and step 3 then walks the project
  // questions one invoice at a time. That is the shape a vendor expects:
  // Documents is where documents go, and somebody with five bills has five
  // documents before they have anything else to say about them.
  //
  // The first build put "Add another invoice" at the END of step 3, because
  // banking an invoice needs a COMPLETE one and artist/amount/category live
  // there. This inverts that: a row exists as soon as it has a file, and
  // completeness is checked per invoice on the way out of step 2 and again at
  // Submit. It is a better fit for the same reason the ask was made.
  //
  // ONE array, and it is the whole truth about the batch. Step 3's answers live
  // on `project` inside each row; the flat step-3 fields further down are the
  // working copy of whichever invoice step 3 is showing, loaded and saved as
  // you page between them.
  const blankInvoice = () => ({
    // Stable identity. Async work (the scan, the dup check) used to write back by
    // INDEX, so removing a row while a scan ran landed the verdict on the wrong
    // row — or on none, leaving `validating: true` forever and Submit refused.
    key: `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    file: null,
    invoiceNum: '',
    // Anything else the vendor wants to send WITH THIS invoice: extra pages, a
    // timesheet, a screenshot of the brief. Separate from `file` on purpose —
    // that one is the document the AI reads and the invoice-number gate judges,
    // and which document that is must never depend on the order they were
    // picked.
    extraFiles: [],
    receiptFile: null,
    validation: null,          // the AI read of THIS document
    validating: false,
    dup: { checking: false, duplicate: false },
    project: null,             // step 3's answers, once they have been given
  })
  const [invoices, setInvoices] = useState([blankInvoice()])
  // Which invoice step 3 is showing.
  const [active, setActive] = useState(0)
  // Per-invoice errors the server sent back, keyed by position, so a refusal
  // lands on the row it belongs to rather than as one sentence about a batch.
  const [invoiceErrors, setInvoiceErrors] = useState([])

  const updateInvoice = (i, patch) => setInvoices(list =>
    list.map((inv, k) => (k === i ? { ...inv, ...patch } : inv)))
  // By key, for anything that completes after the list may have changed. `when`
  // lets a scan apply only if the row still holds the file it read.
  const updateInvoiceByKey = (key, patch, when = () => true) => setInvoices(list =>
    list.map((inv) => (inv.key === key && when(inv) ? { ...inv, ...patch } : inv)))

  // The numbers as one string, so effects can depend on "did any invoice number
  // change" without re-running whenever an unrelated part of a row does.
  // DECLARED HERE, beside the array, because the draft-save effect lists it in
  // its dependency array — and a dependency array runs DURING RENDER, so a const
  // declared below it is a temporal-dead-zone throw on first paint. Smoke caught
  // exactly that: "Cannot access 'invoiceNumbersKey' before initialization",
  // rendering 90 bytes.
  const invoiceNumbersKey = invoices.map(inv => inv.invoiceNum.trim()).join('\u0000')

  // The W9 is the VENDOR's, not an invoice's — one form covers every invoice in
  // the submission, the same way it covers every separate submission through
  // `w9_entry_id`. Asked once, at the top of step 2.
  const [w9File, setW9File]             = useState(null)


  // Similar-submission guard — same vendor + same total amount within
  // 30 days (the invoice-number dup check can't catch these). Debounced;
  // non-blocking amber warning on step 3.
  const [similarSub, setSimilarSub] = useState(null)

  // AI prefill summary — which values the invoice parse filled in, shown
  // as a "please verify" banner on step 3 (cleared if parse fills nothing).
  const [aiPrefilled, setAiPrefilled] = useState(null)

  // AI validation state. The INVOICE read lives on its row (`validation` /
  // `validating`) — with several invoices on screen there is no such thing as
  // "the" invoice scan. The W9 is the vendor's, so its read stays here.
  const [w9Validation, setW9Validation] = useState(null)
  const [validatingW9, setValidatingW9] = useState(false)
  // Non-fatal AI warnings surfaced from the parse endpoint (e.g., the
  // scan swapped a social handle into the artist field and we fixed it
  // — the vendor should still eyeball the fields). Rendered as an
  // amber banner at the top of step 3.
  const [aiWarnings, setAiWarnings] = useState([])

  /** Attach a document to invoice `i` and read it. */
  const validateInvoiceFile = async (i, file) => {
    const key = invoices[i]?.key
    updateInvoiceByKey(key, { file, validation: null, validating: !!file && !isReimb })
    if (!file || isReimb) return
    // Apply the verdict only if THIS file is still the row's document — a
    // replacement mid-scan must not inherit the old file's read.
    const still = (inv) => inv.file === file
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch('/api/vendor/validate-invoice', { method: 'POST', body: fd })
      if (!r.ok) { updateInvoiceByKey(key, { validation: null, validating: false }, still); return }
      const data = await r.json()
      updateInvoiceByKey(key, {
        validation: (data && typeof data === 'object') ? data : null,
        validating: false,
      }, still)
    } catch {
      updateInvoiceByKey(key, { validation: null, validating: false }, still)   // fail open
    }
  }

  const validateW9File = async (file) => {
    setW9File(file)
    setW9Validation(null)
    if (!file) return
    setValidatingW9(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch('/api/vendor/validate-w9', { method: 'POST', body: fd })
      if (!r.ok) { setW9Validation(null); return }
      const data = await r.json()
      if (data && typeof data === 'object') setW9Validation(data)
    } catch {
      setW9Validation(null)
    } finally {
      setValidatingW9(false)
    }
  }

  // Notes
  const [showNotes, setShowNotes] = useState(false)
  const [notes, setNotes]         = useState('')

  // ── Draft persistence ─────────────────────────────────────────────────
  // Text fields auto-save to localStorage so a closed tab / dead battery
  // doesn't cost the vendor the whole form. Files can't be persisted;
  // resume drops back to the Documents step so they get re-attached.
  // Declared after every field it references (notes is the last one).
  const DRAFT_KEY = 'vendor_submit_draft_v1'
  const [draftAvailable, setDraftAvailable] = useState(null)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY)
      if (!raw) return
      const d = JSON.parse(raw)
      const meaningful = d && (d.vendorName || d.vendorEmail || d.description
        || (Array.isArray(d.invoiceNums) && d.invoiceNums.some(Boolean))
        || (Array.isArray(d.artistRows) && d.artistRows.some(r => r?.artist || r?.song || r?.amount)))
      if (meaningful) setDraftAvailable(d)
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (submitted || draftAvailable) return // don't clobber a pending-decision draft
    const t = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          savedAt: new Date().toISOString(),
          mode, step, vendorName, vendorEmail, extraEmails, paymentPref,
          // Bank NAME is safe to keep in a localStorage draft; account numbers,
          // routing numbers and IBANs are deliberately NOT saved. A draft lives
          // in the browser until it is resumed or expires, and an abandoned one
          // on a shared machine should not be a copy of somebody's bank details.
          payBankName, payWireScope, vendorAddress,
          invoiceNums: invoices.map(inv => inv.invoiceNum),
          artistRows, socialRows, category, currency, boomRep, description, notes,
        }))
      } catch {}
    }, 600)
    return () => clearTimeout(t)
  }, [submitted, draftAvailable, mode, step, vendorName, vendorEmail, extraEmails, paymentPref, payBankName, payWireScope, vendorAddress,
      invoiceNumbersKey, artistRows, socialRows, category, currency, boomRep, description, notes])
  const resumeDraft = () => {
    const d = draftAvailable
    if (!d) return
    if (d.mode === 'invoice' || d.mode === 'reimbursement') setMode(d.mode)
    setVendorName(d.vendorName || '')
    setVendorEmail(d.vendorEmail || '')
    if (Array.isArray(d.extraEmails)) setExtraEmails(d.extraEmails.filter(e => typeof e === 'string'))
    setPaymentPref(d.paymentPref || '')
    setPayBankName(d.payBankName || '')
    setPayWireScope(d.payWireScope || '')
    setVendorAddress(d.vendorAddress || '')
    if (Array.isArray(d.invoiceNums) && d.invoiceNums.length) {
      setInvoices(d.invoiceNums.map(n => ({ ...blankInvoice(), invoiceNum: String(n || '') })))
    }
    if (Array.isArray(d.artistRows) && d.artistRows.length) setArtistRows(d.artistRows)
    if (Array.isArray(d.socialRows) && d.socialRows.length) setSocialRows(d.socialRows)
    setCategory(d.category || '')
    setCurrency(d.currency || 'USD')
    setBoomRep(d.boomRep || '')
    setDescription(d.description || '')
    setNotes(d.notes || '')
    // Files aren't persisted — land on Documents so they get re-attached
    // (or step 1 if the draft never got that far).
    setStep((d.step || 1) >= 2 ? 2 : 1)
    setDraftAvailable(null)
  }
  const discardDraft = () => {
    try { localStorage.removeItem(DRAFT_KEY) } catch {}
    setDraftAvailable(null)
  }

  // ── Similar-submission check (debounced) ─────────────────────────────
  useEffect(() => {
    if (step !== 3) { setSimilarSub(null); return }
    // Strip $/commas like the submit path does — parseFloat('1,200') is 1,
    // which made the duplicate-amount check query the wrong total.
    const total = artistRows.reduce((s, r) => s + (parseFloat(String(r.amount).replace(/[$,\s]/g, '')) || 0), 0)
    const email = vendorEmail.trim()
    const name = vendorName.trim()
    if (!(total > 0) || (!email && !name)) { setSimilarSub(null); return }
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ amount: String(total), currency })
        if (email) params.set('email', email)
        if (name) params.set('vendor_name', name)
        const r = await fetch(`/api/vendor/check-similar?${params.toString()}`)
        if (!r.ok) { if (r.status !== 429) setSimilarSub(null); return }
        const d = await r.json()
        setSimilarSub(d?.similar || null)
      } catch { setSimilarSub(null) }
    }, 800)
    return () => clearTimeout(t)
  }, [step, artistRows, vendorEmail, vendorName, currency])

  // Debounced vendor lookup — checks W9 status and auto-fills contact fields
  // (address, bank, payment preference) if we have them on file. The server
  // only returns the prefill when the typed email matches the one on file
  // (email-as-shared-secret — the endpoint is public, so name alone must
  // not leak PII), which is why the effect also re-runs on vendorEmail.
  // Only fills fields the vendor hasn't typed yet, so we never overwrite input.
  useEffect(() => {
    if (!vendorName || vendorName.length < 3) { setW9OnFile(false); return }
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ name: vendorName })
        const email = vendorEmail.trim()
        if (email && isValidEmail(email)) params.set('email', email)
        const r = await fetch(`/api/vendor/lookup?${params.toString()}`)
        // Rate-limited (429) is not "no W9 on file" — keep whatever state
        // we last knew rather than forcing the vendor to re-upload a W9.
        if (r.status === 429) return
        if (!r.ok) { setW9OnFile(false); return }
        const d = await r.json()
        setW9OnFile(!!d?.on_file)
        if (d && typeof d === 'object') {
          // Functional updates — the closure's bank name / pref are 600ms
          // stale; reading them here clobbered anything the vendor typed
          // between scheduling and the lookup resolving.
          // `d.address` is dropped rather than re-homed: it is the vendor's old
          // MAILING address and the form no longer has a field that means that.
          // Pre-filling a bank-address box with it would be worse than asking.
          // Returning vendors get theirs back rather than retyping it.
          if (typeof d.address === 'string')            setVendorAddress(prev => prev || d.address)
          if (typeof d.bank === 'string')               setPayBankName(prev => prev || d.bank)
          if (typeof d.payment_preference === 'string') setPaymentPref(prev => prev || d.payment_preference)
        }
      } catch { setW9OnFile(false) }
    }, 600)
    return () => clearTimeout(t)
  }, [vendorName, vendorEmail])

  const addArtistRow = () => {
    if (artistRows.length >= 6) return
    setArtistRows(rows => [...rows, { artist: '', song: '', amount: '', off_roster: false }])
  }
  const removeArtistRow = i => setArtistRows(rows => rows.filter((_, idx) => idx !== i))
  // Overloaded: two-arg patch (i, {field: val, ...}) OR three-arg (i, field, val).
  // The RosterPicker fires the two-arg form because it updates artist +
  // off_roster together and the single-shot avoids a torn intermediate state.
  const updateArtistRow = (i, fieldOrPatch, val) => {
    const patch = typeof fieldOrPatch === 'object' ? fieldOrPatch : { [fieldOrPatch]: val }
    setArtistRows(rows => rows.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  }

  const SOCIAL_PLATFORMS = ['Instagram', 'TikTok', 'YouTube', 'Twitter / X', 'Facebook', 'Other']
  const addSocialRow = () => {
    setSocialRows(rows => [...rows, { platform: 'Instagram', handle: '', amount: '' }])
  }
  const removeSocialRow = i => setSocialRows(rows => rows.filter((_, idx) => idx !== i))
  const updateSocialRow = (i, field, val) =>
    setSocialRows(rows => rows.map((r, idx) => idx === i ? { ...r, [field]: val } : r))

  // Early-feedback dupe check — server still enforces the same gate on submit.
  // Pass BOTH email and vendor_name so the check catches dups that came in
  // through a non-portal path (e.g. an admin manually added the invoice via
  // BkAddInvoice without capturing the vendor's email). The server matches
  // on either signal.
  // Runs for every row, and remembers WHICH number it checked
  // (`dup.for`) so re-rendering the list does not re-ask about numbers that
  // have not changed. Debounced once for the batch rather than per keystroke
  // per row.
  useEffect(() => {
    const email = vendorEmail.trim()
    const name  = vendorName.trim()
    if (!email && !name) return
    const t = setTimeout(() => {
      invoices.forEach((inv, i) => {
        const num = inv.invoiceNum.trim()
        if (!num) {
          if (inv.dup.duplicate || inv.dup.for) updateInvoiceByKey(inv.key, { dup: { checking: false, duplicate: false } })
          return
        }
        if (inv.dup.for === num || inv.dup.checking) return
        const key = inv.key
        updateInvoiceByKey(key, { dup: { ...inv.dup, checking: true } })
        ;(async () => {
          try {
            const params = new URLSearchParams({ invoice_number: num })
            if (email) params.set('email', email)
            if (name)  params.set('vendor_name', name)
            const r = await fetch(`/api/vendor/check-dup?${params.toString()}`)
            const d = r.ok ? await r.json() : null
            updateInvoiceByKey(key, { dup: { checking: false, duplicate: !!d?.duplicate, for: num } })
          } catch {
            updateInvoiceByKey(key, { dup: { checking: false, duplicate: false, for: num } })
          }
        })()
      })
    }, 500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorEmail, vendorName, invoiceNumbersKey])

  // Which payment fields this method needs. The SERVER decides
  // (server/lib/payment-fields.js) — this mirror exists so the vendor is told
  // before they press a button rather than by a 400 afterwards. When the two
  // disagree the server wins, which is the only safe direction.
  // "Use the details on file" only covers the METHOD on file: the server resolves
  // the fallback only when the methods agree, so a vendor who switched to Wire
  // with ACH on file must type the wire block or be refused after step 3.
  useEffect(() => { if (payOnFile?.on_file && payReuse && payOnFile.method && payOnFile.method !== paymentPref) setPayReuse(false) }, [paymentPref]) // eslint-disable-line react-hooks/exhaustive-deps
  const payMissing = (() => {
    if (payOnFile?.on_file && payReuse && (!payOnFile.method || payOnFile.method === paymentPref)) return []
    const m = []
    if (paymentPref === 'ACH') {
      if (!payAccount.trim()) m.push('account number')
      if (!payRouting.trim()) m.push('routing number')
      if (!payAccountType.trim()) m.push('account type')
      if (!payHolder.trim()) m.push('name on the account')
      if (!payBankName.trim()) m.push('bank name')
      if (!payBankAddress.trim()) m.push('bank address')
    } else if (paymentPref === 'Wire') {
      // The scope IS the first question — the rest of the list is its answer.
      if (!payWireScope) m.push('whether your bank is in the US or outside it')
      else if (payWireScope === 'Domestic') {
        if (!payRouting.trim()) m.push('routing number')
        if (!payAccount.trim()) m.push('account number')
        if (!payHolder.trim()) m.push('name on the account')
        if (!payBankName.trim()) m.push('bank name')
        // Bank address and beneficiary address are optional on a domestic wire:
        // the ABA identifies the bank, and most US wires need nothing more.
      } else {
        if (!payIbanSwift.trim()) m.push('IBAN or SWIFT/BIC')
        if (swiftNeedsAccount(payIbanSwift) && !payAccount.trim()) m.push('account number')
        if (!payHolder.trim()) m.push('name on the account')
        if (!payBankName.trim()) m.push('bank name')
        if (!payBankAddress.trim()) m.push('bank address')
        if (!payBeneficiaryAddress.trim()) m.push('beneficiary address')
        // Intermediary bank is intentionally absent: most wires do not need one.
      }
    } else if (paymentPref === 'PayPal') {
      if (!payPaypal.trim()) m.push('PayPal email or handle')
      else if (!(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payPaypal.trim()) || /^@?[A-Za-z0-9._-]{3,}$/.test(payPaypal.trim()))) m.push('a PayPal email or handle we can recognise')
    }
    // Shape, mirrored from the server's validators so a typo is caught here and
    // not as a 400 after the whole wizard.
    const usAccount = paymentPref === 'ACH' || (paymentPref === 'Wire' && payWireScope === 'Domestic')
    if (usAccount && payRouting.trim() && !abaValid(payRouting)) m.push('a valid 9-digit routing number (this one does not check out)')
    if (usAccount && payAccount.trim() && !/^\d{4,17}$/.test(payAccount.trim())) m.push('an account number of 4 to 17 digits')
    if (paymentPref === 'Wire' && payWireScope === 'International' && payIbanSwift.trim() && !looksLikeIban(payIbanSwift) && !looksLikeSwift(payIbanSwift)) m.push('an IBAN or SWIFT/BIC in the usual shape')
    return m
  })()

  // Everything step 3 still needs, named. The submit button used to be gated on
  // `submitting` alone, so a missing field was discovered by a server 400 that
  // reported ONE problem at a time — fill it in, press again, learn the next one.
  // The server still enforces all of this; this only means the vendor finds out
  // before they press the button.
  const step3Missing = (() => {
    const m = []
    const rows = artistRows.filter(r => (r.artist || '').trim())
    if (!rows.length) m.push('an artist or project')
    else if (rows.some(r => !(r.song || '').trim())) m.push('a song for every artist row')
    const total = artistRows.reduce((sum, r) => {
      const v = r.amount ? parseFloat(String(r.amount).replace(/[$,\s]/g, '')) : 0
      return sum + (isNaN(v) ? 0 : v)
    }, 0)
    if (!total) m.push('the invoice amount')
    if (!category) m.push('a category')
    if (!boomRep) m.push('your Market Street rep')
    if (!socialRows.some(r => (r.handle || '').trim())) m.push('a social handle (or "N/A")')
    return m
  })()


  const isReimb = mode === 'reimbursement'
  // Reimbursements require the supporting receipt — the DropZone marked it
  // required but nothing enforced it, so receipt-less reimbursements slipped
  // through to submit.
  // dupCheck is deliberately NOT part of this. It used to be, which disabled
  // Continue with no explanation the vendor could act on — and the underlying
  // test matches far too broadly (leading zeros stripped, so 001 and 1 are one
  // number; #, INV- and No. all collapse to the same key). A vendor whose
  // invoices restart at 1 each year could not submit at all. They see the
  // notice below and decide; the collision is flagged for us on Approvals.
  // Every row, not just one: the batch advances when all of it is ready.
  const canAdvanceStep2 = invoices.length > 0
    && invoices.every(inv => inv.file && inv.invoiceNum.trim() && (!isReimb || inv.receiptFile))
    && (isReimb || w9OnFile || w9File)

  // Do we already hold payment details for this email? Debounced, and email-EXACT
  // — the server matches nothing weaker, because a name collision that showed one
  // vendor another's bank details is not a mistake worth risking for convenience.
  useEffect(() => {
    const email = vendorEmail.trim()
    if (!isValidEmail(email)) { setPayOnFile(null); setPayReuse(false); return }
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/vendor/payment-on-file?email=${encodeURIComponent(email)}`)
        if (!r.ok || cancelled) return
        const d = await r.json()
        if (cancelled) return
        setPayOnFile(d?.on_file ? d : null)
        // Pre-selected, but the vendor still has to look at it — the panel says
        // "still correct?" rather than quietly reusing an account.
        // Never clobber a method the vendor already chose (the /lookup effect above
        // has the same rule); a Wire half-typed must not flip to ACH when the email lands.
        if (d?.on_file) { setPayReuse(true); if (d.method) setPaymentPref(prev => prev || d.method) }
      } catch { /* offline or blocked — they type their details, which is fine */ }
    }, 500)
    return () => { cancelled = true; clearTimeout(t) }
  }, [vendorEmail])

  const goToStep2 = () => {
    setError('')
    // Admin-preview skip-validation: jump straight to step 2 without
    // checking required fields. Only reachable when ?admin_preview=1.
    if (skipValidation) { setStep(2); return }
    if (!vendorName.trim())     { setError('Please enter your legal / government name.'); return }
    if (!vendorEmail.trim())    { setError('Please enter your email address.'); return }
    if (!isValidEmail(vendorEmail)) { setError('Please enter a valid email address (e.g. you@example.com).'); return }
    if (extraEmails.some(e => e.trim() && !isValidEmail(e))) {
      setError('One of your additional email addresses is invalid — fix or remove it.'); return
    }
    if (!paymentPref)           { setError('Please select your preferred payment method.'); return }
    if (payMissing.length) {
      setError(`Please enter your ${payMissing.join(', ')} — we cannot pay you without it.`); return
    }
    setStep(2)
  }

  /**
   * Read ONE invoice document: what number it prints, and what it can pre-fill.
   *
   * Extracted from goToStep3 so the batch can run it PER ROW. Returns null when
   * the parse fails or says nothing — the server runs the same gate at submit
   * and has the final say, so a failed read here falls open rather than
   * blocking a vendor over an AI hiccup.
   */
  const parseInvoiceDoc = async (file) => {
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch('/api/vendor/parse-invoice', { method: 'POST', body: fd })
      if (!r.ok) return null
      const d = await r.json()
      const data = (d && typeof d.data === 'object' && d.data) || {}
      if (!Object.keys(data).length) return null
      return {
        data,
        ai_warnings: Array.isArray(d.ai_warnings) ? d.ai_warnings : [],
        suggest_socials: Array.isArray(d.suggest_socials) ? d.suggest_socials : [],
      }
    } catch { return null }
  }

  /** Fill the step-3 fields from one invoice's parse, never clobbering typing. */
  const applyParsed = (res, pr = null) => {
    if (!res) { setAiPrefilled(null); setAiWarnings([]); return }
    const d = res
    const data = res.data
    const safe = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v))
    const parsedOk = true
          // Read the project being LOADED, not the render closure: this runs right
          // after setArtistRows(...) for the new invoice, before React re-renders, so
          // `artistRows` here still belongs to the invoice being left.
          const base = pr || { artistRows, category, description }
          const row0 = base.artistRows?.[0] || {}
          const firstRowEmpty = !row0.artist && !row0.song && !row0.amount
          // Collect what the parse is about to fill so step 3 can show a
          // "pre-filled — please verify" banner. Mirrors the don't-clobber
          // conditions of the individual setters below.
          {
            const summary = {}
            if (firstRowEmpty) {
              if (safe(data.artist).trim()) summary.artist = safe(data.artist).trim()
              const parsedSong = safe(data.song) || safe(data.description)
              if (parsedSong.trim()) summary.song = parsedSong.trim()
              if (data.amount != null) summary.amount = String(data.amount)
            }
            if (!base.category && typeof data.category === 'string' && CATEGORIES.includes(data.category)) summary.category = data.category
            if (typeof data.currency === 'string' && data.currency !== 'USD' && CURRENCIES.some(c => c.value === data.currency)) summary.currency = data.currency
            setAiPrefilled(Object.keys(summary).length ? summary : null)
          }
          if (firstRowEmpty) {
            setArtistRows(prev => {
              const first = prev[0] || { artist: '', song: '', amount: '', off_roster: false }
              const parsedArtist = first.artist || safe(data.artist)
              // Snap to the roster's canonical casing when the parse matches
              // an existing artist (case-insensitive). If it doesn't match,
              // the row lands as off_roster so the vendor sees the chip and
              // can either confirm or switch back into picker mode.
              const rosterHit = rosterIndex.get(parsedArtist.trim().toLowerCase())
              const filled = {
                artist: rosterHit || parsedArtist,
                song:   first.song   || safe(data.song) || safe(data.description),
                amount: first.amount || (data.amount != null ? String(data.amount) : ''),
                off_roster: parsedArtist.trim() && !rosterHit ? true : false,
              }
              return [filled, ...prev.slice(1)]
            })
          }
          if (!base.category && typeof data.category === 'string' && CATEGORIES.includes(data.category)) {
            setCategory(data.category)
          }
          if (typeof data.currency === 'string' && CURRENCIES.some(c => c.value === data.currency)) {
            setCurrency(data.currency)
          }
          // Pre-fill description from the AI parse if the vendor hasn't
          // already typed one. Same don't-clobber rule the other fields use.
          if (!base.description && typeof data.description === 'string' && data.description.trim()) {
            setDescription(data.description.trim())
          }

          // Surface any non-fatal warnings the server flagged (e.g.,
          // the scan initially misread a handle as the artist and we
          // fixed it — vendor should verify).
          const warnings = Array.isArray(d.ai_warnings) ? d.ai_warnings : []
          setAiWarnings(warnings)

          // Prefill the socials step with any @handles the parse pulled
          // out of the invoice, but only if the vendor hasn't already
          // typed anything. First-row-empty rule mirrors the artist
          // prefill above.
          const suggested = Array.isArray(d.suggest_socials) ? d.suggest_socials : []
          if (suggested.length) {
            const firstRow = socialRows[0]
            const firstIsEmpty = !firstRow?.handle && !firstRow?.platform_other && (!firstRow?.platform || firstRow.platform === 'Instagram')
            if (firstIsEmpty) {
              const seen = new Set()
              const merged = []
              for (const s of suggested) {
                const h = String(s?.handle || '').trim()
                if (!h || seen.has(h.toLowerCase())) continue
                seen.add(h.toLowerCase())
                merged.push({ platform: s.platform || 'Instagram', handle: h, amount: '' })
              }
              if (merged.length) setSocialRows(merged)
            }
          }
  }

  const goToStep3 = async () => {
    setError('')
    setInvoiceErrors([])
    // Admin-preview skip-validation: jump to step 3 without the invoice / W9
    // gates or the AI parse roundtrip.
    if (skipValidation) { setActive(0); loadProject(0); setStep(3); return }

    // ── Every row, not just one ──────────────────────────────────────────────
    // A batch that reported its faults one invoice at a time would be the
    // vendor fixing a row, pressing Next, and being told about the next one.
    const missing = []
    invoices.forEach((inv, i) => {
      const errs = []
      if (!inv.file) errs.push('Please upload your invoice file.')
      if (!inv.invoiceNum.trim()) errs.push('Please enter your invoice number.')
      if (isReimb && !inv.receiptFile) errs.push('Please attach your supporting receipt.')
      if (errs.length) missing.push({ index: i, errors: errs })
    })
    // Two cards cannot share a number ("001" and "1" are two numbers, as on the server).
    const seenNum = new Map()
    invoices.forEach((inv, i) => {
      const n = normalizeInvoiceNum(inv.invoiceNum)
      if (!n) return
      if (seenNum.has(n)) missing.push({ index: i, errors: [`This invoice has the same number as invoice ${seenNum.get(n) + 1}. Two invoices in one submission cannot share a number.`] })
      else seenNum.set(n, i)
    })
    if (!isReimb && !w9OnFile && !w9File) {
      setError('Please upload your W9 or W8 form.')
      if (missing.length) setInvoiceErrors(missing)
      return
    }
    if (missing.length) {
      setInvoiceErrors(missing)
      setError(invoices.length > 1
        ? `Invoice ${missing[0].index + 1} — ${missing[0].errors[0]}`
        : missing[0].errors[0])
      return
    }

    // The documents are read CONCURRENTLY. Ten invoices read one after another
    // is ten AI round trips in series with a spinner on top of them.
    setParsing(true)
    // A document already read is not read again (Back → Next used to re-spend a
    // parse per invoice and reset every answer).
    const results = await Promise.all(
      invoices.map(inv => (inv.parsed !== undefined && inv.parsedFor === inv.file
        ? Promise.resolve(inv.parsed)
        : (inv.file && !isReimb ? parseInvoiceDoc(inv.file) : Promise.resolve(null))))
    )

    // The invoice-number gate, per row. Same rule as the server's, run early so
    // the vendor fixes it here rather than being refused after Submit.
    const faults = []
    results.forEach((res, i) => {
      if (!res) return
      const docNumRaw = typeof res.data.invoice_number === 'string' ? res.data.invoice_number.trim() : ''
      if (!docNumRaw) {
        faults.push({ index: i, errors: ['Your uploaded invoice does not contain an invoice number. Please add one to the document and re-upload.'] })
      } else if (normalizeInvoiceNum(docNumRaw) !== normalizeInvoiceNum(invoices[i].invoiceNum)) {
        faults.push({ index: i, errors: [`The invoice number on your document ("${docNumRaw}") doesn't match the number you entered ("${invoices[i].invoiceNum}"). Please correct one of them.`] })
      }
    })
    setParsing(false)
    if (faults.length) {
      setInvoiceErrors(faults)
      setError(invoices.length > 1
        ? `Invoice ${faults[0].index + 1} — ${faults[0].errors[0]}`
        : faults[0].errors[0])
      return
    }

    // Keep each read WITH ITS INVOICE, so paging to invoice 3 pre-fills from
    // invoice 3's document and not from whichever was read last.
    setInvoices(list => list.map((inv, i) => ({ ...inv, parsed: results[i], parsedFor: inv.file })))
    const start = Math.min(Math.max(active, 0), invoices.length - 1)
    setActive(start)
    loadProject(start, results[start])
    setStep(3)
  }

  /** One invoice's amount — the sum of its artist rows, which is what the form
   *  has always meant by the invoice total. */
  const invoiceTotal = (inv) => ((inv.project?.artistRows) || []).reduce((sum, r) => {
    const val = r.amount ? parseFloat(String(r.amount).replace(/[$,\s]/g, '')) : 0
    return sum + (Number.isNaN(val) ? 0 : val)
  }, 0)

  /**
   * What is wrong with ONE invoice, in the vendor's words.
   *
   * Reads the row, so it can judge an invoice the form is not currently showing
   * — which is the whole point once there are several. Submit runs it over
   * every one of them before it sends anything.
   */
  const invoiceProblems = (inv) => {
    const out = []
    if (!inv.file) out.push('Please upload your invoice file.')
    if (!inv.invoiceNum.trim()) out.push('Please enter your invoice number.')
    if (isReimb && !inv.receiptFile) out.push('Please attach your supporting receipt.')
    const pr = inv.project
    if (!pr) { out.push('Please enter at least one artist or project.'); return out }
    const first = pr.artistRows.find(r => r.artist.trim())
    if (!first) out.push('Please enter at least one artist or project.')
    if (pr.artistRows.some(r => r.artist.trim() && !(r.song || '').trim())) {
      out.push('Please enter a song / track for every artist row.')
    }
    if (!(invoiceTotal(inv) > 0)) out.push('Please enter the invoice amount.')
    if (!pr.category) out.push('Please select a category.')
    if (!pr.boomRep) out.push('Please select your Market Street Rep.')
    return out
  }

  const handleSubmit = async e => {
    e.preventDefault()
    if (step !== 3) return   // only the review step submits
    setError('')

    // ── Every invoice in the submission ──────────────────────────────────────
    // The one in the form, plus any that have been banked. Order matters: the
    // form holds either a NEW invoice (append) or one being edited (replace),
    // and the server reports its faults by position.
    // The invoice on screen has not been written back to the array yet — the
    // save happens when you page away from it, and Submit is not paging.
    const allInvoices = invoices.map((inv, i) => (
      i === active ? { ...inv, project: currentProject() } : inv))

    // Checked here as well as on "Add another", because the LAST invoice never
    // goes through that button — Submit is the only thing between it and the
    // server. Every artist row must name a song: vendor submissions without one
    // land on the Recoupments page in the N/A bucket for an admin to backfill.
    for (let i = 0; i < allInvoices.length; i += 1) {
      const problems = invoiceProblems(allInvoices[i])
      if (problems.length) {
        setError(allInvoices.length > 1 ? `Invoice ${i + 1} — ${problems[0]}` : problems[0])
        // Open the offending card rather than describing it. With one invoice
        // this is the form the vendor is already looking at.
        if (allInvoices.length > 1 && i !== active) goToInvoice(i)
        return
      }
    }

    // Kept for the similar-submission guard below, which asks about the invoice
    // the vendor is looking at. Every invoice's own artist and total are built
    // per row in `fieldsFor`.
    const onScreen = allInvoices[active] || allInvoices[0]
    const firstArtist = (onScreen.project?.artistRows || []).find(r => r.artist.trim())
    const totalAmount = invoiceTotal(onScreen)

    // Invoice AI scan is advisory — don't block submission on issues, admins
    // will review on approval. Still wait for the scan itself to finish so
    // the resulting notes make it into the admin view.
    if (!isReimb && invoices.some(inv => inv.validating)) {
      setError('Please wait for the invoice scan to complete.'); return
    }
    if (!isReimb && !w9OnFile && w9Validation && !w9Validation.valid) {
      setError('Please upload a valid, signed and dated W9 or W8 form. See the issues listed above.'); return
    }
    if (!isReimb && !w9OnFile && validatingW9) {
      setError('Please wait for the W9 scan to complete.'); return
    }

    // Socials are required — vendors who don't use social media should type
    // "N/A" in the handle field. Empty handles block submit so admins always
    // have an explicit signal (handle present + N/A literal, or a real
    // handle) instead of a missing field they have to chase down.
    const hasSocialAnswer = socialRows.some(s => (s.handle || '').trim())
    if (!hasSocialAnswer) {
      setError('Please add at least one social media handle, or type "N/A" if you don\'t use social media.'); return
    }

    const fd = new FormData()
    fd.append('vendor_name', vendorName)
    fd.append('vendor_email', vendorEmail)
    // Extra emails: trimmed, valid, deduped, excluding the main address.
    {
      const seen = new Set([vendorEmail.trim().toLowerCase()])
      const extras = extraEmails
        .map(e => e.trim())
        .filter(e => e && isValidEmail(e) && !seen.has(e.toLowerCase()) && seen.add(e.toLowerCase()))
      if (extras.length) fd.append('additional_emails', JSON.stringify(extras))
    }
    fd.append('vendor_address', vendorAddress)
    fd.append('payment_preference', paymentPref)
    // Payment coordinates. When the vendor confirmed what we already hold, the
    // fields are empty on purpose — the server reads its stored record. Anything
    // typed wins over it, and a change is flagged for an approver.
    if (!(payOnFile?.on_file && payReuse)) {
      fd.append('payment_account_number', payAccount)
      fd.append('payment_routing_number', payRouting)
      fd.append('payment_account_type', payAccountType)
      fd.append('payment_holder_name', payHolder)
      fd.append('payment_bank_name', payBankName)
      fd.append('payment_wire_scope', payWireScope)
      fd.append('payment_iban_swift', payIbanSwift)
      fd.append('payment_bank_address', payBankAddress)
      fd.append('payment_beneficiary_address', payBeneficiaryAddress)
      fd.append('payment_intermediary_bank', payIntermediaryBank)
      fd.append('payment_paypal', payPaypal)
    } else {
      fd.append('payment_reuse_on_file', 'true')
    }
    fd.append('is_reimbursement', mode === 'reimbursement' ? 'yes' : 'no')

    // One invoice's values, in the shape the server reads.
    const fieldsFor = (inv) => {
      const snap = inv.project || blankProject()
      const rows = snap.artistRows.filter(r => r.artist.trim())
      const primary = rows[0]
      const out = {
        invoice_number: inv.invoiceNum,
        category: snap.category,
        currency: snap.currency,
        boom_rep: snap.boomRep,
        description: snap.description,
        notes: snap.notes,
        amount: invoiceTotal(inv).toFixed(2),
        artist: primary.artist.trim(),
        song: (primary.song || '').trim(),
        // Primary-artist off-roster claim — server re-validates against the
        // live artists table before persisting, so a stale client can't cause
        // a false positive if the artist has been added since the roster load.
        off_roster_artist: primary.off_roster ? 'true' : 'false',
      }
      // Multi-artist breakdown if more than one row
      if (rows.length > 1) {
        out.artist_breakdown = rows.map(r => ({
          artist: r.artist.trim(),
          song: (r.song || '').trim(),
          amount: r.amount ? parseFloat(String(r.amount).replace(/[$,\s]/g, '')) : null,
          off_roster: !!r.off_roster,
        }))
      }
      return out
    }

    if (allInvoices.length === 1) {
      // ── ONE invoice: byte-for-byte the payload this form has always sent ────
      // Not a fallback — the common path. 418 live submissions from 190 vendors
      // go through these exact keys, and a batch feature is no reason for the
      // single-invoice case to start posting a shape nothing has ever received.
      const f = fieldsFor(allInvoices[0])
      fd.append('invoice_number_hint', f.invoice_number)
      fd.append('category', f.category)
      fd.append('currency', f.currency)
      fd.append('boom_rep', f.boom_rep)
      fd.append('description', f.description)
      fd.append('notes', f.notes)
      fd.append('amount', f.amount)
      fd.append('artist', f.artist)
      fd.append('song', f.song)
      fd.append('off_roster_artist', f.off_roster_artist)
      if (f.artist_breakdown) fd.append('artist_breakdown', JSON.stringify(f.artist_breakdown))
      const snap = allInvoices[0]
      if (snap.file) fd.append('file', snap.file)
      // Supporting files go under a DIFFERENT key. `file` stays the one document
      // the AI parse reads and the invoice-number gate judges, so which document
      // is being checked never depends on upload order.
      for (const x of snap.extraFiles) fd.append('file_extra', x)
      if (snap.receiptFile) fd.append('receipt_file', snap.receiptFile)
    } else {
      // ── Several: one JSON list, and each invoice's files under its own key ──
      // Indexed rather than repeated under one name, for the same reason `file`
      // and `file_extra` are separate keys: which document belongs to which
      // invoice must never depend on the order the browser happened to send.
      fd.append('invoices', JSON.stringify(allInvoices.map(fieldsFor)))
      allInvoices.forEach((snap, i) => {
        if (snap.file) fd.append(`invoice_file_${i}`, snap.file)
        for (const x of snap.extraFiles) fd.append(`invoice_extra_${i}`, x)
        if (snap.receiptFile) fd.append(`invoice_receipt_${i}`, snap.receiptFile)
      })
    }
    if (w9File) fd.append('w9_file', w9File)

    // Optional social handles — only send rows where a handle was typed
    const validSocial = socialRows
      .map(s => {
        const row = { platform: (s.platform || '').trim(), handle: (s.handle || '').trim() }
        const amountNum = parseFloat(s.amount)
        if (Number.isFinite(amountNum) && amountNum > 0) row.amount = amountNum
        return row
      })
      .filter(s => s.handle)
    if (validSocial.length) fd.append('social_handles', JSON.stringify(validSocial))

    setSubmitting(true)
    try {
      const r = await fetch('/api/vendor/submit', { method: 'POST', body: fd })
      const d = await r.json()
      if (!r.ok) {
        // The server says it has no W9 for this vendor while we are showing the
        // "W9 on file — no need to resubmit" panel IN PLACE OF the upload field.
        // Believe the server, drop the badge and send them back to Documents so
        // there is a dropzone to act on — otherwise the error names a field the
        // page does not render and the submission cannot be completed at all.
        // The two now share one resolver server-side, so this should only fire
        // if the lookup and the submit disagree transiently.
        if (/W9 or W8 form/i.test(d.error || '')) {
          setW9OnFile(false)
          setStep(2)
        }
        // A batch refusal names every card that has something wrong with it, so
        // the list can mark them all at once. Nothing was written — the server
        // checks the whole submission before it inserts anything — so this is a
        // list of things to fix, not a report of what got through.
        if (Array.isArray(d.invoice_errors) && d.invoice_errors.length) {
          setInvoiceErrors(d.invoice_errors)
        }
        setError(d.error || 'Submission failed.'); setSubmitting(false); return
      }
      setInvoiceErrors([])
      setSubmittedCount(d?.invoice_count || allInvoices.length)
      setSubmittedName(vendorName)
      try { localStorage.removeItem(DRAFT_KEY) } catch {}
      setSubmitted(true)
    } catch {
      setError('Network error. Please try again.')
      setSubmitting(false)
    }
  }

  // ── Paging step 3 across the invoices ──────────────────────────────────────
  // The step-3 fields are flat state, and they are the WORKING COPY of whichever
  // invoice is on screen. Saved into the array when you leave an invoice, loaded
  // out of it when you arrive. Holding all N in the array and binding the JSX
  // straight to `invoices[active]` would be tidier and would rewire every field
  // on a public form for no behaviour change.
  const blankProject = () => ({
    artistRows: [{ artist: '', song: '', amount: '', off_roster: false }],
    category: '', currency: 'USD', boomRep: '', description: '', notes: '',
  })

  const currentProject = () => ({
    artistRows: artistRows.map(r => ({ ...r })),
    category, currency, boomRep, description, notes,
  })

  const saveProject = (i) => {
    if (i == null || i < 0) return
    setInvoices(list => list.map((inv, k) => (k === i ? { ...inv, project: currentProject() } : inv)))
  }

  // A FRESH invoice starts with the previous one's category, currency and rep —
  // five invoices are almost always five of the same kind of work for the same
  // rep (the rule CLAUDE.md states; it was never implemented).
  const freshProject = (i, fromScreen) => {
    const prev = fromScreen || invoices.slice(0, i).reverse().find(x => x.project)?.project || null
    return { ...blankProject(), ...(prev ? { category: prev.category || '', currency: prev.currency || 'USD', boomRep: prev.boomRep || '' } : {}) }
  }
  /** Put invoice `i`'s answers in the fields. `parsed` pre-fills a fresh one. */
  const loadProject = (i, parsed) => {
    const pr = invoices[i]?.project || freshProject(i, i > 0 && active !== i ? currentProject() : null)
    setArtistRows(pr.artistRows.map(r => ({ ...r })))
    setCategory(pr.category)
    setCurrency(pr.currency)
    setBoomRep(pr.boomRep)
    setDescription(pr.description)
    setNotes(pr.notes || '')
    setShowNotes(!!(pr.notes || '').trim())
    setSimilarSub(null)
    // Only a never-answered invoice gets the AI's suggestions. Re-applying them
    // to one the vendor has already filled in would argue with their own edits.
    if (!invoices[i]?.project) applyParsed(parsed ?? invoices[i]?.parsed ?? null, pr)
    else { setAiPrefilled(null); setAiWarnings([]) }
  }

  /** Move step 3 to another invoice, keeping what is on screen. */
  const goToInvoice = (i) => {
    if (i < 0 || i >= invoices.length || i === active) return
    saveProject(active)
    setActive(i)
    setError('')
    // Read out of the array as it will be AFTER the save above — setInvoices is
    // async, so `loadProject` would otherwise see the pre-save copy when moving
    // away from and back to the same invoice.
    const saved = { ...invoices[i] }
    const pr = saved.project || freshProject(i, currentProject())
    setArtistRows(pr.artistRows.map(r => ({ ...r })))
    setCategory(pr.category); setCurrency(pr.currency); setBoomRep(pr.boomRep)
    setDescription(pr.description); setNotes(pr.notes || '')
    setShowNotes(!!(pr.notes || '').trim())
    setSimilarSub(null)
    if (!saved.project) applyParsed(saved.parsed || null, pr)
    else { setAiPrefilled(null); setAiWarnings([]) }
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // ── The list on step 2 ─────────────────────────────────────────────────────
  const addInvoice = () => {
    if (invoices.length >= INVOICE_MAX) return
    setInvoices(list => [...list, blankInvoice()])
    setInvoiceErrors([])
    setError('')
  }

  const removeInvoice = (i) => {
    if (invoices.length <= 1) return       // a submission is at least one invoice
    setInvoices(list => list.filter((_, k) => k !== i))
    setInvoiceErrors([])
    setActive(a => (i < a ? a - 1 : Math.min(a, invoices.length - 2)))
  }

  // ── Derived from the batch ─────────────────────────────────────────────────
  // DECLARED HERE, below the helpers they call, and that placement is the whole
  // point: `batchTotal` reads `invoiceTotal` and `snapshotInvoice`, and a const
  // read above its own declaration is a temporal-dead-zone ReferenceError on
  // every render — which has taken two pages in this app pure white while
  // `vite build` and `npm run smoke` both stayed green.

  // How many invoices Submit would send: everything banked, plus the one in the
  // form — unless the form is holding one of the banked ones, in which case it
  // replaces rather than adds.
  const submitCount = invoices.length
  // The batch's money, for the list header. Currencies are NOT summed across
  // invoices — this app converts money in one place and a public form is not it
  // — so a mixed-currency batch shows no total rather than a wrong one.
  const batchCurrencies = [...new Set(invoices.map((inv, i) => (
    i === active ? currency : (inv.project?.currency || 'USD'))))]
  const batchTotal = invoices.reduce((t, inv, i) => t + (
    i === active ? invoiceTotal({ ...inv, project: currentProject() }) : invoiceTotal(inv)), 0)

  const reset = () => {
    setSubmitted(false); setSubmittedName('')
    // Keep vendor contact info + mode so they don't have to re-enter it.
    // Clear invoice-specific fields and jump back to the Documents step.
    setArtistRows([{ artist: '', song: '', amount: '', off_roster: false }])
    setSocialRows([{ platform: 'Instagram', handle: '', amount: '' }])
    setCategory(''); setCurrency('USD'); setBoomRep('')
    // The W-9 just submitted is now on file — do not demand it again for the next invoice.
    if (w9File) setW9OnFile(true)
    setInvoices([blankInvoice()]); setActive(0); setW9File(null)
    setW9Validation(null)
    setNotes(''); setShowNotes(false); setDescription(''); setError('')
    setInvoiceErrors([])
    setSubmitting(false)
    setStep(2)
  }

  if (submitted) return <SuccessScreen vendorName={submittedName} onReset={reset} count={submittedCount} />

  // Admin-preview banner gate, now the ?admin_preview=1 query param alone.
  //
  // The `adminPreview` PROP is gone with /admin/vendor-preview, which was a
  // second nav row that rendered this form and still wrote real submissions.
  // The param survives because it is the honest form of the same thing: it says
  // "I know this is the live form and I am about to create a real approval",
  // and it takes deliberately typing it. Real /submit links from vendor emails
  // or docs carry no query string, so a vendor can never see this banner.
  const adminPreview = (
    typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('admin_preview') === '1'
  )
  // Guard so vendor state can never flip this on even by accident.
  const setSkipValidation = (v) => { if (adminPreview) setSkipValidationRaw(v) }

  return (
    <div className="ms-form min-h-screen bg-gray-100" data-step={step} style={{fontSize:14}}>
      {/* Header — the street sign */}
      <header className="bg-card border-b border-rule px-7 flex items-center h-14">
        <span className="ms-sign">Market.st</span>
        <span className="ms-sign-sub">{isReimb ? 'Reimbursements' : 'Vendor invoices'}</span>
      </header>

      {adminPreview && (
        <div className="bg-amber-100 border-b border-amber-300 text-amber-900 text-xs font-semibold py-2 px-5 flex items-center justify-center gap-4 flex-wrap">
          <span>
            Admin preview — submissions here are <b>real</b> and land on Approvals.
            {' '}To try changes without creating anything, use{' '}
            <a href="/admin/vendor-lab" className="underline">/admin/vendor-lab</a>.
          </span>
          <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={skipValidation}
              onChange={e => setSkipValidation(e.target.checked)}
              style={{ accentColor: '#b45309', width: 13, height: 13 }}
            />
            <span>Skip validation between steps</span>
          </label>
        </div>
      )}

      <div className="max-w-xl mx-auto px-5 pb-20" style={{marginTop:36}}>
        <h1 className="ms-h1 text-xl font-black text-gray-900 mb-1">
          {isReimb ? 'Submit a Reimbursement' : 'Submit an Invoice'}
        </h1>
        <p className="text-sm text-gray-500 mb-6 leading-relaxed">
          Required fields are marked <span className="text-red-600">*</span>. We'll review your submission before it goes to the ledger.
        </p>

        {/* Mode toggle */}
        <div className="ms-toggle flex bg-card border-2 border-rule rounded-xl overflow-hidden mb-5">
          {['invoice','reimbursement'].map(m => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 py-3 text-sm font-bold transition-all ${
                mode === m ? 'bg-red-600 text-white' : 'text-gray-400 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              {m === 'invoice' ? 'Invoice' : 'Reimbursement'}
            </button>
          ))}
        </div>

        {/* Info banner */}
        {!isReimb ? (
          <div className="ms-note flex gap-2.5 bg-gray-50 border-2 border-rule rounded-xl p-3 mb-5 text-sm text-slate-600 font-semibold">
            <span className="text-gray-400 font-black mt-0.5">i</span>
            <span>Bill to <strong>Market Street</strong>. Include your invoice number, date, description, total amount, and your payment instructions (bank account + routing number, or PayPal email). A "Pay" link to a portal is not enough.</span>
          </div>
        ) : (
          <div className="ms-note flex gap-2.5 bg-blue-50 border-2 border-blue-200 rounded-xl p-3 mb-5 text-sm text-blue-800 font-semibold">
            <span className="text-blue-400 font-black mt-0.5">i</span>
            <span>Attach your receipt. No W9 / W8 required for reimbursements.</span>
          </div>
        )}

        {/* Resume-draft banner — offered until the vendor picks; the
            autosave effect pauses while it's showing so the stored
            draft can't be clobbered by the fresh empty form. */}
        {draftAvailable && !submitted && (
          <div className="flex items-center gap-3 flex-wrap bg-red-50 border-2 border-red-200 rounded-xl p-3 mb-5 text-sm text-red-900">
            <span>
              <span className="font-bold">Welcome back — </span>
              you have an unfinished submission
              {draftAvailable.savedAt ? ` from ${new Date(draftAvailable.savedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}.
              Your files will need re-attaching.
            </span>
            <span className="ml-auto inline-flex gap-2">
              <button type="button" onClick={resumeDraft} className="px-3 py-1.5 rounded-lg text-xs font-black text-white bg-red-600 hover:bg-red-700">
                Resume draft
              </button>
              <button type="button" onClick={discardDraft} className="px-3 py-1.5 rounded-lg text-xs font-bold text-gray-600 bg-white border border-gray-200 hover:border-gray-300">
                Start fresh
              </button>
            </span>
          </div>
        )}

        {/* Step indicator */}
        <div className="ms-steps flex items-center gap-2 mb-5">
          {[1, 2, 3].map(s => (
            <div key={s} className="flex items-center gap-2 flex-1" data-state={s < step ? 'done' : s === step ? 'current' : 'todo'}
              style={{ '--a': s === 1 ? 'var(--ms-brick)' : s === 2 ? 'var(--ms-royal)' : 'var(--ms-forest)' }}>
              <div className="ms-awning" aria-hidden />
              <div className="flex items-center gap-2">
              <div className={`w-7 h-7 rounded-full text-xs font-black flex items-center justify-center flex-shrink-0 transition-all ${
                s < step ? 'bg-green-500 text-white' : s === step ? 'bg-red-600 text-white' : 'bg-gray-200 text-gray-400'
              }`}>{s < step ? '✓' : s}</div>
              <span className={`text-xs font-bold ${s === step ? 'text-gray-900' : 'text-gray-400'}`}>
                {s === 1 ? 'Your Info' : s === 2 ? 'Documents' : 'Project Info'}
              </span>
              </div>
              {s < 3 && <div className={`flex-1 h-0.5 ${s < step ? 'bg-green-400' : 'bg-gray-200'}`} />}
            </div>
          ))}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm mb-5 font-semibold">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} onKeyDown={e => {
          // Enter advances the step it is on; it never submits from steps 1–2.
          // (Step 2 has one text field with no submit button, so the browser's
          // implicit submission used to POST the whole form from there.)
          if (e.key !== 'Enter' || step === 3) return
          const t = e.target
          if (!t || /^(TEXTAREA|BUTTON|A)$/.test(t.tagName) || (t.tagName === 'INPUT' && /^(button|submit|file)$/.test(t.type))) return
          e.preventDefault()
          if (step === 1) goToStep2()
          else if (canAdvanceStep2 && !parsing) goToStep3()
        }}>

          {/* ── Step 1: Your Info ─────────────────────────────────────────── */}
          {step === 1 && (<>

          {/* ── Section 1: Your Info ─────────────────────────────────────────── */}
          <div className="ms-card bg-card border border-rule rounded-xl overflow-hidden mb-2.5">
            <div className="ms-card-head px-5 py-3 border-b border-rule bg-gray-50 flex items-center gap-2.5">
              <span className="w-5 h-5 rounded-full bg-red-600 text-white text-xs font-black flex items-center justify-center">1</span>
              <span className="text-sm font-black text-gray-900">Your Info</span>
            </div>
            <div className="p-5 flex flex-col gap-3.5">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">
                  Legal / Government Name <span className="text-red-600">*</span>
                </label>
                <input
                  type="text"
                  value={vendorName}
                  onChange={e => setVendorName(e.target.value)}
                  placeholder="Full legal name or company name (must match W9/W8)"
                  required
                  className="w-full border-2 border-rule rounded-lg px-3 py-2.5 text-sm outline-none focus:border-red-500 transition-colors"
                />
                {w9OnFile && (
                  <div className="flex gap-2 items-center bg-green-50 border-2 border-green-300 rounded-lg p-2.5 text-sm text-green-800 font-semibold mt-2">
                    <span>✓</span> We have your W9 on file — no need to resubmit.
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">
                    Email <span className="text-red-600">*</span>
                    {!isReimb && <span className="text-gray-400 normal-case font-normal tracking-normal ml-1">— for 1099</span>}
                  </label>
                  <input
                    type="email"
                    value={vendorEmail}
                    onChange={e => setVendorEmail(e.target.value)}
                    placeholder="your@email.com"
                    required
                    className={`w-full border-2 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors ${
                      vendorEmail.trim() && !isValidEmail(vendorEmail)
                        ? 'border-red-500 bg-red-50 focus:border-red-600'
                        : 'border-rule focus:border-red-500'
                    }`}
                  />
                  {vendorEmail.trim() && !isValidEmail(vendorEmail) && (
                    <p className="text-xs text-red-600 mt-1 font-semibold">Please enter a valid email address.</p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">
                    Preferred Payment <span className="text-red-600">*</span>
                  </label>
                  <select
                    value={paymentPref}
                    onChange={e => setPaymentPref(e.target.value)}
                    required
                    className="w-full border-2 border-rule rounded-lg px-3 py-2.5 text-sm outline-none focus:border-red-500 transition-colors bg-card"
                  >
                    <option value="">— Select —</option>
                    <option value="ACH">ACH (Bank Transfer)</option>
                    <option value="Wire">Wire Transfer</option>
                    <option value="PayPal">PayPal</option>
                  </select>
                </div>
              </div>

              {/* ── Payment details ────────────────────────────────────────
                  Shown once a method is chosen, because the fields differ by
                  method and asking for a routing number from someone paying by
                  PayPal is how a form teaches people to type anything. */}
              {paymentPref && (
                <div className="border-2 border-rule rounded-xl p-4 bg-gray-50">
                  {payOnFile?.on_file && payReuse ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold text-gray-700">
                        {payOnFile.method} ••••{payOnFile.last4}
                      </span>
                      {payOnFile.holder_name && (
                        <span className="text-sm text-gray-500">· {payOnFile.holder_name}</span>
                      )}
                      <span className="text-sm text-gray-500">— still correct?</span>
                      <button type="button" onClick={() => { setPayReuse(false) }}
                        className="text-sm font-bold text-red-600 hover:text-red-700 underline">
                        Enter different details
                      </button>
                      {/* Confirmed rather than assumed: we pre-fill for
                          convenience, but a vendor who never looks at the
                          account we are about to pay is the case worth avoiding. */}
                    </div>
                  ) : (
                    <>
                      <p className="text-xs text-gray-500 mb-3">
                        We pay from these details. Put them here even if they are already on your
                        invoice — that way nothing depends on us reading the document correctly.
                        {payOnFile?.on_file && (
                          <button type="button" onClick={() => setPayReuse(true)}
                            className="ml-1 font-bold text-red-600 hover:text-red-700 underline">
                            Use the {payOnFile.method} ••••{payOnFile.last4} we have on file
                          </button>
                        )}
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {paymentPref === 'ACH' && (<>
                          <Field label="Account number" required value={payAccount} onChange={setPayAccount}
                            placeholder="000123456789" />
                          <Field label="Routing number" required value={payRouting} onChange={setPayRouting}
                            placeholder="9 digits, from the bottom of a check" />
                          {/* A select, not a text box. An ACH batch carries a
                              different transaction code for checking than for
                              savings, and the wrong one is a returned payment —
                              so this is a two-value field and should look like
                              one rather than invite "chequing". */}
                          <div>
                            <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">
                              Account type <span className="text-red-600">*</span>
                            </label>
                            <select
                              value={payAccountType}
                              onChange={e => setPayAccountType(e.target.value)}
                              className="w-full border-2 border-rule rounded-lg px-3 py-2.5 text-sm outline-none focus:border-red-500 transition-colors bg-card"
                            >
                              <option value="">— Select —</option>
                              <option value="Checking">Checking</option>
                              <option value="Savings">Savings</option>
                            </select>
                          </div>
                          <Field label="Name on the account" required value={payHolder} onChange={setPayHolder} />
                          <Field label="Bank name" required value={payBankName} onChange={setPayBankName}
                            placeholder="e.g. Chase, Bank of America, Wells Fargo" />
                          <Field label="Bank address" required value={payBankAddress} onChange={setPayBankAddress}
                            placeholder="Your bank's street address, City, State, ZIP"
                            className="sm:col-span-2" />
                        </>)}
                        {paymentPref === 'Wire' && (<>
                          {/* Asked FIRST, and alone. A domestic US wire is an ABA
                              plus an account number and has no IBAN to give — so
                              demanding one was a required field with no correct
                              answer. The rest of this block is the answer to
                              this question, which is why nothing else shows
                              until it is answered. */}
                          <div className="sm:col-span-2">
                            <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">
                              Where is your bank? <span className="text-red-600">*</span>
                            </label>
                            <select
                              value={payWireScope}
                              onChange={e => setPayWireScope(e.target.value)}
                              className="w-full border-2 border-rule rounded-lg px-3 py-2.5 text-sm outline-none focus:border-red-500 transition-colors bg-card"
                            >
                              <option value="">— Select —</option>
                              <option value="Domestic">United States (domestic wire)</option>
                              <option value="International">Outside the US (international wire)</option>
                            </select>
                          </div>

                          {payWireScope === 'Domestic' && (<>
                            <Field label="Routing number (ABA)" required value={payRouting} onChange={setPayRouting}
                              placeholder="9 digits, from the bottom of a check" />
                            <Field label="Account number" required value={payAccount} onChange={setPayAccount}
                              placeholder="000123456789" />
                            <Field label="Name on the account" required value={payHolder} onChange={setPayHolder} />
                            <Field label="Bank name" required value={payBankName} onChange={setPayBankName}
                              placeholder="e.g. Chase, Bank of America" />
                            {/* Optional: the ABA already identifies the bank. */}
                            <Field label="Bank address" value={payBankAddress} onChange={setPayBankAddress}
                              placeholder="Optional for a US wire"
                              className="sm:col-span-2" />
                          </>)}

                          {payWireScope === 'International' && (<>
                            <Field label="IBAN or SWIFT/BIC" required value={payIbanSwift} onChange={setPayIbanSwift}
                              placeholder="GB82 WEST 1234 5698 7654 32" />
                            {/* Required only alongside a SWIFT/BIC. An IBAN
                                already CONTAINS the account number, so asking
                                twice is a box with no new answer. */}
                            <Field label="Account number" required={swiftNeedsAccount(payIbanSwift)}
                              value={payAccount} onChange={setPayAccount}
                              placeholder={swiftNeedsAccount(payIbanSwift)
                                ? 'Required — a SWIFT/BIC names your bank, not your account'
                                : 'Not needed if you gave an IBAN'} />
                            <Field label="Name on the account" required value={payHolder} onChange={setPayHolder} />
                            <Field label="Bank name" required value={payBankName} onChange={setPayBankName}
                              placeholder="e.g. HSBC, Barclays" />
                            <Field label="Bank address" required value={payBankAddress} onChange={setPayBankAddress}
                              placeholder="Your bank's street address, City, Country"
                              className="sm:col-span-2" />
                            <Field label="Beneficiary address" required value={payBeneficiaryAddress} onChange={setPayBeneficiaryAddress}
                              placeholder="YOUR address, as the account holder — City, Country"
                              className="sm:col-span-2" />
                            {/* Optional, and labelled so — most wires need no
                                correspondent bank, and a required field with no
                                correct answer is how a column fills up with "N/A". */}
                            <Field label="Intermediary / correspondent bank" value={payIntermediaryBank} onChange={setPayIntermediaryBank}
                              placeholder="Only if your bank requires one — otherwise leave blank"
                              className="sm:col-span-2" />
                          </>)}
                        </>)}
                        {paymentPref === 'PayPal' && (
                          <Field label="PayPal email or handle" required value={payPaypal} onChange={setPayPaypal}
                            placeholder="you@example.com or @yourhandle" className="sm:col-span-2" />
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Mailing address — OPTIONAL, and only for the 1099. Labelled
                  with the reason, because a vendor who is told why a box exists
                  fills it in and a vendor who is not, skips it. */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">
                  Mailing Address
                  <span className="text-gray-400 normal-case font-normal tracking-normal ml-1">
                    — optional, used only for your 1099 at year end
                  </span>
                </label>
                <input
                  type="text"
                  value={vendorAddress}
                  onChange={e => setVendorAddress(e.target.value)}
                  placeholder="Street address, City, State, ZIP"
                  className="w-full border-2 border-rule rounded-lg px-3 py-2.5 text-sm outline-none focus:border-red-500 transition-colors"
                />
              </div>

              {/* Additional emails (optional) — saved to the vendor's record
                  and CC'd on payment-confirmation emails. */}
              <div>
                {extraEmails.map((em, i) => (
                  <div key={i} className="flex gap-2 items-start mb-2">
                    <div className="flex-1">
                      <input
                        type="email"
                        value={em}
                        onChange={e => setExtraEmails(prev => prev.map((v, j) => j === i ? e.target.value : v))}
                        placeholder="additional@email.com"
                        className={`w-full border-2 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors ${
                          em.trim() && !isValidEmail(em)
                            ? 'border-red-500 bg-red-50 focus:border-red-600'
                            : 'border-rule focus:border-red-500'
                        }`}
                      />
                      {em.trim() && !isValidEmail(em) && (
                        <p className="text-xs text-red-600 mt-1 font-semibold">Please enter a valid email address.</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setExtraEmails(prev => prev.filter((_, j) => j !== i))}
                      className="mt-2.5 text-gray-400 hover:text-red-600 text-lg leading-none px-1"
                      aria-label="Remove email"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {extraEmails.length < 4 && (
                  <button
                    type="button"
                    onClick={() => setExtraEmails(prev => [...prev, ''])}
                    className="text-xs font-bold text-red-600 hover:text-red-700"
                  >
                    + Add another email <span className="text-gray-400 font-normal">(optional — CC'd on payment confirmations)</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Step 1 Next button */}
          <button type="button" onClick={goToStep2}
            className="ms-enter w-full bg-red-600 hover:bg-red-700 text-white font-black text-base rounded-xl py-3.5 transition-colors mt-3">
            <span className="ms-enter-bracket" aria-hidden>]</span> Next — Upload Documents <kbd className="ms-enter-key" aria-hidden>Enter</kbd>
          </button>
          </>)}

          {/* ── Step 3: Project Info (pre-filled by AI) ─────────────────── */}
          {step === 3 && (<>

          {/* ── Which invoice these answers belong to ────────────────────────
              Only when there is more than one. With a single invoice a pager
              reading "1 of 1" is furniture that explains nothing, and this step
              then looks exactly as it has for every vendor who ever used it. */}
          {invoices.length > 1 && (
            <div className="bg-card border-2 border-rule rounded-xl overflow-hidden mb-2.5">
              <div className="px-4 py-2.5 flex items-center gap-2 flex-wrap border-b border-rule bg-gray-50">
                <span className="text-sm font-black text-gray-900">
                  Invoice {active + 1} of {invoices.length}
                </span>
                <span className="text-xs font-semibold text-gray-500 truncate max-w-[14rem]">
                  #{invoices[active].invoiceNum || '—'}
                  {invoices[active].file && <> · {invoices[active].file.name}</>}
                </span>
                <div className="ml-auto flex gap-1.5">
                  <button type="button" onClick={() => goToInvoice(active - 1)}
                    disabled={active === 0}
                    className="px-2.5 py-1.5 text-xs font-bold border-2 border-rule rounded-lg text-gray-600 hover:border-gray-400 disabled:opacity-30 disabled:cursor-not-allowed">
                    ‹ Prev
                  </button>
                  <button type="button" onClick={() => goToInvoice(active + 1)}
                    disabled={active === invoices.length - 1}
                    className="px-2.5 py-1.5 text-xs font-bold border-2 border-rule rounded-lg text-gray-600 hover:border-gray-400 disabled:opacity-30 disabled:cursor-not-allowed">
                    Next ›
                  </button>
                </div>
              </div>
              {/* Every invoice as a chip, so an unfinished one is visible from
                  whichever you happen to be looking at. A vendor should never
                  press Submit and only then learn that invoice 4 is blank. */}
              <div className="px-4 py-2.5 flex gap-1.5 flex-wrap">
                {invoices.map((inv, i) => {
                  const done = i === active
                    ? step3Missing.length === 0
                    : invoiceProblems(inv).length === 0
                  const bad = invoiceErrors.some(e => e.index === i)
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => goToInvoice(i)}
                      title={inv.invoiceNum || `Invoice ${i + 1}`}
                      aria-label={`Go to invoice ${i + 1}`}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold border-2 transition-colors ${
                        i === active
                          ? 'border-red-500 bg-red-50 text-red-700'
                          : bad
                            ? 'border-red-300 text-red-600'
                            : done
                              ? 'border-green-300 bg-green-50 text-green-700'
                              : 'border-rule text-gray-400 hover:border-gray-400'
                      }`}
                    >
                      {done && i !== active ? '✓ ' : ''}{i + 1}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Violet banner: what the AI parse pre-filled — the vendor
              should verify these before submitting. */}
          {aiPrefilled && (
            <div className="mb-2.5 rounded-xl border-2 border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900">
              <div className="font-bold mb-1">We pre-filled these from your invoice — please correct anything that's wrong:</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                {aiPrefilled.amount && <span>Amount: <b>{aiPrefilled.amount}</b></span>}
                {aiPrefilled.artist && <span>Artist: <b>{aiPrefilled.artist}</b></span>}
                {aiPrefilled.song && <span>Song: <b>{aiPrefilled.song}</b></span>}
                {aiPrefilled.category && <span>Category: <b>{aiPrefilled.category}</b></span>}
                {aiPrefilled.currency && <span>Currency: <b>{aiPrefilled.currency}</b></span>}
              </div>
            </div>
          )}

          {/* Amber banner: possible duplicate — same amount from this
              vendor within 30 days. Non-blocking; sometimes two charges
              genuinely match. */}
          {similarSub && (
            <div className="mb-2.5 rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <div className="font-bold">Possible duplicate submission</div>
              <p className="text-[13px] mt-0.5">
                We already have a {Number(similarSub.amount).toLocaleString('en-US', { style: 'currency', currency: similarSub.currency || 'USD' })} submission
                from you{similarSub.invoice_number ? ` (invoice #${similarSub.invoice_number})` : ''}
                {similarSub.date ? ` dated ${new Date(similarSub.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}.
                If this is the same charge, please don't submit it twice.
              </p>
            </div>
          )}

          {/* Amber banner: non-fatal AI parse warnings (e.g., the scan
              initially misread a social handle as the artist). Nudges
              the vendor to double-check the pre-filled fields. */}
          {aiWarnings.length > 0 && (
            <div className="mb-2.5 rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <div className="font-bold mb-1">Please double-check the artist and song below.</div>
              <ul className="list-disc pl-5 space-y-0.5 text-[13px]">
                {aiWarnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          <div className="ms-card bg-card border border-rule rounded-xl overflow-hidden mb-2.5">
            <div className="ms-card-head px-5 py-3 border-b border-rule bg-gray-50 flex items-center gap-2.5">
              <span className="w-5 h-5 rounded-full bg-red-600 text-white text-xs font-black flex items-center justify-center">3</span>
              <span className="text-sm font-black text-gray-900">Project Info</span>
            </div>
            <div className="p-5 flex flex-col gap-3.5">
              {/* Artist rows */}
              <div>
                <div className="flex gap-2 mb-1.5">
                  <span className="flex-[2] text-xs font-bold uppercase tracking-wide text-gray-500">Artist / Project <span className="text-red-600">*</span></span>
                  <span className="flex-[1.5] text-xs font-bold uppercase tracking-wide text-gray-500">Song / Track <span className="text-red-600">*</span></span>
                  <span className="flex-[0.9] text-xs font-bold uppercase tracking-wide text-gray-500">Amount <span className="text-red-600">*</span></span>
                  <span className="w-10 flex-shrink-0" />
                </div>
                {artistRows.map((row, i) => {
                  // The AI parse can misread a social handle (e.g.
                  // "crazyauntieann") as the artist. Flag when the
                  // typed value looks handle-shaped so the vendor
                  // corrects it before submit. Matches the server's
                  // detection: starts with @, or lowercase-only with
                  // an underscore/period, length 3-30. Only applied in
                  // off-roster mode — roster names are trusted.
                  const artistStr = String(row.artist || '').trim()
                  const looksHandle = row.off_roster && artistStr && (
                    artistStr.startsWith('@') ||
                    (/^[a-z0-9._]{3,30}$/.test(artistStr) && /[._]/.test(artistStr))
                  )
                  return (
                  <div key={i} className="flex flex-col gap-1 mb-2">
                    <div className="flex gap-2 items-start">
                    <RosterPicker
                      value={row.artist}
                      offRoster={!!row.off_roster}
                      roster={roster}
                      placeholder={i === 0 ? 'Search Market Street roster or "+ Not on our roster"' : 'Search roster'}
                      warningRing={looksHandle ? 'border-amber-400 focus:border-amber-500 bg-amber-50' : 'border-rule focus:border-red-500'}
                      onChange={(artist, offRoster) => updateArtistRow(i, { artist, off_roster: offRoster })}
                    />
                    <input
                      type="text"
                      value={row.song}
                      onChange={e => updateArtistRow(i, 'song', e.target.value)}
                      placeholder="Song / Track *"
                      required={i === 0}
                      className="flex-[1.5] border-2 border-rule rounded-lg px-3 py-2.5 text-sm outline-none focus:border-red-500 transition-colors min-w-0"
                    />
                    <input
                      type="text"
                      value={row.amount}
                      onChange={e => updateArtistRow(i, 'amount', e.target.value)}
                      placeholder="$ Amount *"
                      required={i === 0}
                      className="flex-[0.9] border-2 border-rule rounded-lg px-3 py-2.5 text-sm outline-none focus:border-red-500 transition-colors min-w-0"
                    />
                    {i === 0
                      ? <div className="w-10 flex-shrink-0" />
                      : <button
                          type="button"
                          onClick={() => removeArtistRow(i)}
                          className="flex-shrink-0 w-10 h-10 border-2 border-rule rounded-lg text-gray-300 hover:border-red-500 hover:text-red-500 transition-all text-sm font-bold"
                        >×</button>
                    }
                    </div>
                    {looksHandle && (
                      <div className="text-[12px] font-semibold text-amber-700 pl-1">
                        That looks like a social-media handle, not an artist name.
                        Put the artist's proper name here and move the handle to the Social Media section below.
                      </div>
                    )}
                  </div>
                  )
                })}
                {artistRows.length < 6 && (
                  <button
                    type="button"
                    onClick={addArtistRow}
                    className="w-full border-2 border-dashed border-rule rounded-lg py-2 text-sm font-semibold text-gray-400 hover:border-red-400 hover:text-red-500 hover:bg-red-50 transition-all mt-1"
                  >
                    + Add another artist
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">
                    Category <span className="text-red-600">*</span>
                  </label>
                  <select
                    value={category}
                    onChange={e => setCategory(e.target.value)}
                    required
                    className="w-full border-2 border-rule rounded-lg px-3 py-2.5 text-sm outline-none focus:border-red-500 transition-colors bg-card"
                  >
                    <option value="">— Select —</option>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">
                    Currency <span className="text-red-600">*</span>
                  </label>
                  <select
                    value={currency}
                    onChange={e => setCurrency(e.target.value)}
                    className="w-full border-2 border-rule rounded-lg px-3 py-2.5 text-sm outline-none focus:border-red-500 transition-colors bg-card"
                  >
                    {CURRENCIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">
                    Market Street Rep <span className="text-red-600">*</span>
                  </label>
                  <select
                    value={boomRep}
                    onChange={e => setBoomRep(e.target.value)}
                    required
                    className="w-full border-2 border-rule rounded-lg px-3 py-2.5 text-sm outline-none focus:border-red-500 transition-colors bg-card"
                  >
                    <option value="">— Select a rep —</option>
                    {BOOM_REPS.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">
                    Description
                    <span className="text-gray-400 normal-case font-normal tracking-normal ml-1">— brief summary of what this invoice is for</span>
                  </label>
                  <textarea
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    rows={2}
                    placeholder="e.g. Instagram promo for Song X, 2 posts + 1 story"
                    className="w-full border-2 border-rule rounded-lg px-3 py-2.5 text-sm outline-none focus:border-red-500 transition-colors resize-y"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Required: Social media handles. Vendors without socials must
              type "N/A" so admins know it's an explicit answer, not a
              forgotten field. The handleSubmit validator requires at least
              one row to have a non-empty handle. */}
          <div className="ms-card bg-card border border-rule rounded-xl overflow-hidden mb-2.5">
            <div className="px-5 py-3 border-b border-rule bg-gray-50 flex items-center justify-between gap-2.5">
              <div className="flex items-center gap-2.5">
                <span className="text-sm font-black text-gray-900">Social Media</span>
                <span className="text-red-500 text-sm font-bold leading-none">*</span>
                <span className="text-xs text-gray-400 font-medium">Required</span>
              </div>
            </div>
            <div className="p-5 flex flex-col gap-2.5">
              <p className="text-xs text-gray-500 leading-snug -mt-1">
                Add your handle for the platform(s) you use to promote your work.
                If you don't use social media at all, type <span className="font-bold text-gray-700">N/A</span> in the handle field.
              </p>
              <div className="flex gap-2 mb-1">
                <span className="flex-[1] text-xs font-bold uppercase tracking-wide text-gray-500">Platform</span>
                <span className="flex-[2] text-xs font-bold uppercase tracking-wide text-gray-500">Social media handle</span>
                <span className="w-10 flex-shrink-0" />
              </div>
              {socialRows.map((row, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <select
                    value={row.platform}
                    onChange={e => updateSocialRow(i, 'platform', e.target.value)}
                    className="flex-[1] border-2 border-rule rounded-lg px-3 py-2.5 text-sm outline-none focus:border-red-500 transition-colors bg-card min-w-0"
                  >
                    {SOCIAL_PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <input
                    type="text"
                    value={row.handle}
                    onChange={e => updateSocialRow(i, 'handle', e.target.value)}
                    placeholder="@yourhandle or N/A"
                    className="flex-[2] border-2 border-rule rounded-lg px-3 py-2.5 text-sm outline-none focus:border-red-500 transition-colors min-w-0"
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={row.amount || ''}
                    onChange={e => updateSocialRow(i, 'amount', e.target.value)}
                    placeholder="$ (optional)"
                    title="Amount paid to this creator (optional)"
                    className="w-20 flex-shrink-0 border-2 border-rule rounded-lg px-3 py-2.5 text-sm outline-none focus:border-red-500 transition-colors"
                  />
                  {i === 0
                    ? <div className="w-10 flex-shrink-0" />
                    : <button
                        type="button"
                        onClick={() => removeSocialRow(i)}
                        className="flex-shrink-0 w-10 h-10 border-2 border-rule rounded-lg text-gray-300 hover:border-red-500 hover:text-red-500 transition-all text-sm font-bold"
                      >×</button>
                  }
                </div>
              ))}
              {(
                <button
                  type="button"
                  onClick={addSocialRow}
                  className="w-full border-2 border-dashed border-rule rounded-lg py-2 text-sm font-semibold text-gray-400 hover:border-red-400 hover:text-red-500 hover:bg-red-50 transition-all mt-1"
                >
                  + Add another handle
                </button>
              )}
            </div>
          </div>

          {/* Step 3 continues below with Notes + Submit */}

          {/* This is a marker — step 2 Documents section follows */}
          </>)}

          {/* ── Step 2: Documents ─────────────────────────────────────────── */}
          {step === 2 && (<>
          <div className="ms-card bg-card border border-rule rounded-xl overflow-hidden mb-2.5">
            <div className="ms-card-head px-5 py-3 border-b border-rule bg-gray-50 flex items-center gap-2.5">
              <span className="w-5 h-5 rounded-full bg-red-600 text-white text-xs font-black flex items-center justify-center">2</span>
              <span className="text-sm font-black text-gray-900">Documents</span>
              {invoices.length > 1 && (
                <span className="ml-auto text-xs font-bold text-gray-400">
                  {invoices.length} invoices
                </span>
              )}
            </div>
            <div className="p-5 flex flex-col gap-4">

              {/* ── The W9 comes FIRST, and once ────────────────────────────
                  It belongs to the vendor, not to an invoice — one form covers
                  every invoice here, the same way it covers separate
                  submissions through `w9_entry_id`. Putting it above the list
                  is what stops it reading as something each invoice needs. */}
              {!isReimb && (
                <div>
                  {w9OnFile ? (
                    <div>
                      <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">
                        W9 or W8 Form
                      </label>
                      <div className="flex gap-2 items-center bg-green-50 border-2 border-green-300 rounded-xl px-4 py-3 text-sm text-green-800 font-semibold">
                        <span>✓</span> W9 on file — no need to resubmit
                      </div>
                    </div>
                  ) : (
                    <>
                      <DropZone
                        label="W9 or W8 Form"
                        required
                        file={w9File}
                        onFile={validateW9File}
                        hint="Must be signed and dated. W9 for US, W8 for international. One form covers every invoice below."
                      />
                      {validatingW9 && (
                        <div className="mt-1.5 flex items-center gap-2 text-xs text-blue-600">
                          <span className="animate-spin">⟳</span> Scanning W9...
                        </div>
                      )}
                      {w9Validation && !w9Validation.valid && (
                        <div className="mt-1.5 bg-red-50 border border-red-200 rounded-lg p-3">
                          <p className="text-xs font-bold text-red-700 mb-1">{typeof w9Validation.form_type === 'string' ? w9Validation.form_type : 'W9'} issues found:</p>
                          {(Array.isArray(w9Validation.issues) ? w9Validation.issues : []).map((issue, i) => (
                            <p key={i} className="text-xs text-red-600 flex items-start gap-1.5">
                              <span className="text-red-400 mt-0.5">•</span> {issueText(issue)}
                            </p>
                          ))}
                          <p className="text-[10px] text-red-400 mt-2">Form must be signed and dated to be accepted.</p>
                        </div>
                      )}
                      {w9Validation && w9Validation.valid && (
                        <div className="mt-1.5 flex items-center gap-2 text-xs text-green-600 font-semibold">
                          <span>✓</span> {typeof w9Validation.form_type === 'string' ? w9Validation.form_type : 'W9'} looks good
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* ── The invoices ───────────────────────────────────────────── */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-2">
                  {isReimb ? 'Reimbursements' : 'Invoices'} <span className="text-red-600">*</span>
                  <span className="text-gray-400 normal-case font-normal tracking-normal ml-1">
                    — one row per {isReimb ? 'claim' : 'invoice'}. We&rsquo;ll ask about the project for each on the next step.
                  </span>
                </label>
                <div className="flex flex-col gap-3">
                  {invoices.map((inv, i) => (
                    <InvoiceRow
                      key={i}
                      index={i}
                      inv={inv}
                      total={invoices.length}
                      isReimb={isReimb}
                      errors={(invoiceErrors.find(e => e.index === i)?.errors) || []}
                      onNumber={(v) => updateInvoice(i, { invoiceNum: v })}
                      onFile={(f) => (isReimb ? updateInvoice(i, { file: f }) : validateInvoiceFile(i, f))}
                      onReceipt={(f) => updateInvoice(i, { receiptFile: f })}
                      onExtras={(fn) => updateInvoice(i, { extraFiles: fn(inv.extraFiles) })}
                      onRemove={invoices.length > 1 ? () => removeInvoice(i) : null}
                    />
                  ))}
                </div>
                {invoices.length < INVOICE_MAX ? (
                  <button
                    type="button"
                    onClick={addInvoice}
                    className="w-full mt-3 border-2 border-dashed border-rule rounded-xl py-3 text-sm font-bold text-gray-500 hover:border-red-400 hover:text-red-600 hover:bg-red-50 transition-all"
                  >
                    + Add another invoice
                  </button>
                ) : (
                  <p className="text-xs text-gray-400 mt-3">
                    That&rsquo;s the maximum of {INVOICE_MAX} invoices in one submission.
                    Send the rest as a second submission.
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="flex gap-3 mt-3">
            <button type="button" onClick={() => { setStep(1); setError('') }}
              className="ms-back flex-1 border-2 border-rule text-gray-600 font-bold text-sm rounded-xl py-3 hover:bg-gray-50 transition-colors">
              ← Back
            </button>
            <button type="button" onClick={goToStep3} disabled={parsing}
              className="ms-enter flex-[2] bg-red-600 hover:bg-red-700 disabled:bg-gray-300 text-white font-black text-base rounded-xl py-3.5 transition-colors">
              <span className="ms-enter-bracket" aria-hidden>]</span> {parsing ? 'Scanning invoice...' : 'Next — Review & Submit'} <kbd className="ms-enter-key" aria-hidden>Enter</kbd>
            </button>
          </div>
          </>)}

          {/* ── Step 3: Project Info + Submit ─────────────────────────────── */}
          {step === 3 && (<>

          {/* ── Section 2: Project Info ── (pre-filled by AI) */}

          {/* ── Notes ────────────────────────────────────────────────────────── */}
          <div className="ms-card bg-card border border-rule rounded-xl overflow-hidden mb-2.5">
            <div className="p-4 px-5">
              <button
                type="button"
                onClick={() => setShowNotes(v => !v)}
                className="text-sm text-gray-400 font-semibold flex items-center gap-1.5 hover:text-gray-900 transition-colors"
              >
                <span style={{fontSize:10}}>{showNotes ? '▾' : '▸'}</span>
                Add a note <span className="text-gray-300 font-normal">(optional)</span>
              </button>
              {showNotes && (
                <textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Anything we should know about this invoice…"
                  rows={3}
                  className="mt-3 w-full border-2 border-rule rounded-lg px-3 py-2.5 text-sm outline-none focus:border-red-500 transition-colors resize-y"
                />
              )}
            </div>
          </div>

          {/* ── Submit ───────────────────────────────────────────────────────── */}
          {step3Missing.length > 0 && (
            <div className="mt-3 bg-amber-50 border-2 border-amber-200 rounded-xl px-4 py-3">
              <p className="text-xs font-bold text-amber-800 mb-1">
                Still needed before you can submit:
              </p>
              <ul className="text-xs text-amber-700 space-y-0.5">
                {step3Missing.map((x) => (
                  <li key={x} className="flex items-start gap-1.5">
                    <span className="text-amber-400 mt-0.5">•</span>{x}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* Adding invoices moved to STEP 2 — the Documents list. This step is
              one invoice's answers at a time now, so the only thing that
              belongs here is getting to the next one. */}
          {invoices.length > 1 && active < invoices.length - 1 && (
            <button
              type="button"
              onClick={() => goToInvoice(active + 1)}
              className="w-full mt-3 border-2 border-rule rounded-xl py-3 text-sm font-bold text-gray-600 hover:border-red-400 hover:text-red-600 transition-all"
            >
              Next invoice ({active + 2} of {invoices.length}) ›
            </button>
          )}

          <div className="flex gap-3 mt-3">
            <button type="button" onClick={() => { saveProject(active); setStep(2); setError('') }}
              className="ms-back flex-1 border-2 border-rule text-gray-600 font-bold text-sm rounded-xl py-3 hover:bg-gray-50 transition-colors">
              ← Back
            </button>
            <button
              type="submit"
              disabled={submitting || step3Missing.length > 0}
              className="ms-enter flex-[2] bg-red-600 hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-black text-base rounded-xl py-3.5 transition-colors"
            >
              <span className="ms-enter-bracket" aria-hidden>]</span> {submitting ? 'Submitting…'
                : submitCount > 1 ? `Submit ${submitCount} Invoices`
                  : isReimb ? 'Submit Reimbursement' : 'Submit Invoice'} <kbd className="ms-enter-key" aria-hidden>Enter</kbd>
            </button>
          </div>
          <p className="ms-foot text-center text-xs text-gray-300 mt-3">Secure submission — Market Street only</p>
          </>)}

        </form>
      </div>
    </div>
  )
}
