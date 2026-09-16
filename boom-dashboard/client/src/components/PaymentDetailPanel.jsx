import { useState } from 'react'
import { Eye, EyeOff, Loader, AlertTriangle, Check } from 'lucide-react'
import api from '../api'
import { useTheme } from '../context/ThemeContext'
import getDarkColors from '../utils/darkColors'
import CategorySelect from './CategorySelect'

/**
 * Everything about one invoice, under its row on the Payment Dashboard.
 *
 * John, 2026-09-03: "I want more details from the ledger and vendor submit form
 * to appear on the payments page ... if it becomes too crowded, I want it
 * collapsable or toggleable."
 *
 * A row panel rather than more columns, at his choice. The Ledger solved the
 * same problem with a Columns menu and thirteen default-off columns; here the
 * long values (bank and beneficiary addresses, intermediary bank, notes) would
 * each need a column wide enough to be useless, and the panel lets them wrap.
 *
 * ── Three sections, and the line between them is not cosmetic ──
 *
 *   LEDGER DETAIL   ours. Editable, through the same PUT the Ledger uses.
 *   VENDOR FORM     theirs. READ-ONLY — it records what somebody stated when
 *                   they asked to be paid, and editing it here would change
 *                   that record with nothing to say it had been changed.
 *   BANK            last 4 by default. The full number is one click away and
 *                   that click is audited.
 *
 * ── Why the account number is not just... shown ──
 * It is stored single-copy and encrypted, and the ONLY route that decrypts it
 * writes a `bk_audit_log` row PER READ. Rendering it as a field would fire that
 * audit for every row on screen — turning the record of "somebody deliberately
 * looked at a vendor's bank account" into noise — and would put the number in
 * every screenshot of the page. So the panel shows last 4, and Reveal fetches
 * the rest for that one vendor, once, on purpose.
 *
 * ── Blank is a real answer here ──
 * `payment_snapshot` only started being written on 2026-08-31. On an invoice
 * older than that these fields are EMPTY, and that means "submitted before we
 * asked", not "the vendor gave us nothing". Nothing falls back to the vendor's
 * CURRENT details, because that would print today's account onto an invoice
 * from March — the exact confusion the per-invoice snapshot exists to prevent.
 */

const NOT_CAPTURED =
  'Blank means this invoice was submitted before the form collected it '
  + '(the per-invoice payment record starts 2026-08-31). It is not a missing '
  + 'answer, and it deliberately does not fall back to the vendor’s current details.'

const VERDICT = {
  match:     { color: '#15803d', label: 'Matches the invoice' },
  mismatch:  { color: '#dc2626', label: 'Disagrees with the invoice' },
  absent:    { color: '#a16207', label: 'Not printed on the invoice' },
  unscanned: { color: '#9ca3af', label: 'Not checked' },
}

// Defined at MODULE scope, not inside the panel.
//
// A component declared in another component's body is a NEW TYPE on every
// render, so React unmounts and remounts it rather than updating it — and the
// local state inside goes with it. The first version of this file had both of
// these inline, which reset the input to the row's stored value on every
// keystroke's re-render, so an edit never survived to blur and nothing was ever
// written. `npm run paymentsend-dom detail` is what caught it.
function Field({ label, value, title, L, V, faint }) {
  return (
    <div title={title}>
      <div style={L}>{label}</div>
      <div style={V}>
        {value || value === 0 ? value : <span style={{ color: faint }}>—</span>}
      </div>
    </div>
  )
}

function Editable({ label, field, entry, editableFields, onSave, saving, options, L, V, C, faint }) {
  const [local, setLocal] = useState(entry[field] ?? '')
  // Re-sync when the row changes underneath (an undo, a refetch) — but not on
  // every render, or typing would be clobbered.
  const [seen, setSeen] = useState(entry[field] ?? '')
  if ((entry[field] ?? '') !== seen) {
    setSeen(entry[field] ?? '')
    setLocal(entry[field] ?? '')
  }
  if (!editableFields.includes(field)) {
    return <Field label={label} value={entry[field]} L={L} V={V} faint={faint} />
  }
  const common = {
    value: local ?? '',
    onChange: (e) => setLocal(e.target.value),
    onBlur: () => onSave(field, local === '' ? null : local),
    style: {
      width: '100%', fontSize: 12.5, padding: '4px 6px', borderRadius: 6,
      border: '1px solid ' + C.border, background: C.inputBg || C.cardBg, color: C.text,
    },
  }
  return (
    <div>
      <div style={L}>
        {label}
        {saving === field && <Loader style={{ width: 9, height: 9, marginLeft: 4, display: 'inline' }} className="animate-spin" />}
      </div>
      {options
        ? <select {...common}>{options.map((o) => <option key={o} value={o}>{o || '—'}</option>)}</select>
        : <input {...common} />}
    </div>
  )
}

export default function PaymentDetailPanel({
  entry, colSpan, isAdmin, onEdit, editableFields,
}) {
  const { theme } = useTheme()
  const C = getDarkColors(theme)
  const [revealed, setRevealed] = useState(null)
  const [revealing, setRevealing] = useState(false)
  const [revealErr, setRevealErr] = useState('')
  const [saving, setSaving] = useState('')

  const snap = entry.payment_snapshot && typeof entry.payment_snapshot === 'object'
    ? entry.payment_snapshot : {}
  const check = entry.payment_check && typeof entry.payment_check === 'object'
    ? entry.payment_check : null
  const socials = Array.isArray(entry.social_handles) ? entry.social_handles : []

  const reveal = async () => {
    setRevealing(true); setRevealErr('')
    try {
      const { data } = await api.get(
        `/bk/vendors/${encodeURIComponent(entry.payee || '')}/payment-details`)
      if (!data?.success) throw new Error(data?.error || 'Could not read it')
      if (!data.data?.on_file) { setRevealErr('No stored payment details for this vendor.'); return }
      setRevealed(data.data)
    } catch (err) {
      setRevealErr(err.response?.data?.error || err.message || 'Could not read it')
    } finally { setRevealing(false) }
  }

  const save = async (field, value) => {
    if (String(value ?? '') === String(entry[field] ?? '')) return
    setSaving(field)
    try { await onEdit(entry, field, value) } finally { setSaving('') }
  }

  const L = { fontSize: 10, fontWeight: 800, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 3 }
  const V = { fontSize: 12.5, color: C.text, wordBreak: 'break-word' }
  const box = { border: '1px solid ' + C.border, borderRadius: 8, padding: 12, background: C.cardBg }
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }

  // Prop BAGS, not wrapper components. `const Ed = (props) => <Editable .../>`
  // is a new component type on every render, which remounts Editable and throws
  // away what is being typed — the same bug as declaring it inline, moved one
  // level out. Spreading a plain object has no such effect.
  const FDP = { L, V, faint: C.textFaint }
  const EDP = { ...FDP, entry, editableFields, onSave: save, saving, C }

  return (
    <tr>
      <td colSpan={colSpan} style={{ padding: 0, background: C.elevBg, borderBottom: '1px solid ' + C.tdBorder }}>
        <div style={{ padding: '12px 16px', display: 'grid', gap: 12 }}>

          {/* ── Ours, and editable ── */}
          <div style={box}>
            <div style={{ ...L, marginBottom: 8 }}>Ledger detail</div>
            <div style={grid}>
              <div>
                <div style={L}>Category</div>
                <CategorySelect
                  value={entry.category || ''}
                  onChange={(v) => save('category', v)}
                  style={{ width: '100%', fontSize: 12.5 }}
                />
              </div>
              <Editable {...EDP} label="Artist" field="artist" />
              <Editable {...EDP} label="Song" field="song" />
              <Editable {...EDP} label="Invoice #" field="invoice_number" />
              <Editable {...EDP} label="Terms" field="payment_terms"
                options={['', 'Due on receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60', 'Net 90']} />
              <Editable {...EDP} label="Method" field="payment_method"
                options={['', 'ACH', 'Wire Domestic', 'Wire International', 'PayPal', 'Check', 'Credit Card']} />
              <Editable {...EDP} label="Market Street rep" field="boom_rep" />
              <Editable {...EDP} label="Notes" field="notes" />
            </div>
          </div>

          {/* ── Theirs, and read-only ── */}
          <div style={box}>
            <div style={{ ...L, marginBottom: 8 }}>
              What the vendor submitted
              <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, marginLeft: 6 }}>
                read-only
              </span>
            </div>
            <div style={grid}>
              <Field {...FDP} label="Vendor name (as typed)" value={entry.vendor_name} />
              <Field {...FDP} label="Email" value={entry.vendor_email} />
              <Field {...FDP} label="CC emails" value={entry.vendor_cc_emails} />
              <Field {...FDP} label="Address" value={entry.vendor_address} />
              <Field {...FDP} label="Socials" value={socials.length
                ? socials.map((s) => `${s.platform}: ${s.handle}`).join(', ') : null} />
              <Field {...FDP} label="Extra files" value={entry.vendor_file_count || null} />
              {/* W-9 is a VENDOR fact, not a row one: the form lives on whichever
                  entry it was uploaded onto and covers every other invoice from
                  that vendor, aliases included. `w9_entry_id` is that resolution
                  (server-side, lib/w9-owner); `has_w9` alone answers a different
                  question and, on the live queue, reports four times as many
                  invoices missing a form as are genuinely uncovered. Paired the
                  same way the Ledger, Approvals and Invoices pages pair them. */}
              <div>
                <div style={L}>W-9</div>
                {(entry.has_w9 || entry.w9_entry_id) ? (
                  <div style={{ ...V, color: '#15803d' }}>
                    on file
                    {!entry.has_w9 && entry.w9_entry_id && (
                      <span style={{ color: '#9ca3af', fontWeight: 400 }}> · filed on another invoice</span>
                    )}
                  </div>
                ) : (
                  <div style={{ ...V, color: '#b45309' }}>
                    <AlertTriangle style={{ width: 11, height: 11, display: 'inline', marginRight: 3 }} />
                    none on file for this vendor
                  </div>
                )}
              </div>
              <Field {...FDP} label="W-9 TIN" value={entry.w9_tin_last4 ? `••${entry.w9_tin_last4}` : null} />
              <Field {...FDP} label="Tax class" value={entry.w9_tax_classification} />
              {entry.off_roster_artist && (
                <div>
                  <div style={L}>Artist</div>
                  <div style={{ ...V, color: '#a16207' }}>
                    <AlertTriangle style={{ width: 11, height: 11, display: 'inline', marginRight: 3 }} />
                    off-roster
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── How to pay them ── */}
          <div style={box}>
            <div style={{ ...L, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>Bank details</span>
              {isAdmin && !revealed && (
                <button onClick={reveal} disabled={revealing}
                  style={{
                    fontSize: 10, fontWeight: 700, textTransform: 'none', letterSpacing: 0,
                    padding: '2px 8px', borderRadius: 5, cursor: 'pointer',
                    border: '1px solid ' + C.border, background: C.cardBg, color: C.text,
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                  }}>
                  {revealing ? <Loader style={{ width: 10, height: 10 }} className="animate-spin" />
                             : <Eye style={{ width: 10, height: 10 }} />}
                  Reveal full numbers
                </button>
              )}
              {revealed && (
                <button onClick={() => setRevealed(null)}
                  style={{
                    fontSize: 10, fontWeight: 700, textTransform: 'none', letterSpacing: 0,
                    padding: '2px 8px', borderRadius: 5, cursor: 'pointer',
                    border: '1px solid ' + C.border, background: C.cardBg, color: C.text,
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                  }}>
                  <EyeOff style={{ width: 10, height: 10 }} /> Hide
                </button>
              )}
            </div>

            {revealErr && (
              <div style={{ fontSize: 11.5, color: '#dc2626', marginBottom: 8 }}>{revealErr}</div>
            )}
            {revealed && (
              <div style={{ fontSize: 10.5, color: C.textFaint, marginBottom: 8 }}>
                This read was recorded in the bookkeeping audit log.
              </div>
            )}

            <div style={grid} title={Object.keys(snap).length ? undefined : NOT_CAPTURED}>
              <Field {...FDP} label="Method" value={snap.method || entry.payment_method} />
              <Field {...FDP} label="Account type" value={snap.account_type} title={NOT_CAPTURED} />
              <Field {...FDP} label="Name on account" value={snap.holder_name} title={NOT_CAPTURED} />
              <Field {...FDP} label="Bank" value={snap.bank_name} title={NOT_CAPTURED} />
              <Field
                label="Account"
                value={revealed?.account_number
                  || (entry.payment_last4 ? `••••${entry.payment_last4}` : null)}
                title={NOT_CAPTURED}
              />
              {revealed?.routing_number && <Field {...FDP} label="Routing" value={revealed.routing_number} />}
              {revealed?.iban_swift && <Field {...FDP} label="IBAN / SWIFT" value={revealed.iban_swift} />}
              <Field {...FDP} label="Wire scope" value={snap.wire_scope} title={NOT_CAPTURED} />
              <Field {...FDP} label="Bank address" value={snap.bank_address} title={NOT_CAPTURED} />
              <Field {...FDP} label="Beneficiary address" value={snap.beneficiary_address} title={NOT_CAPTURED} />
              <Field {...FDP} label="Intermediary bank" value={snap.intermediary_bank} title={NOT_CAPTURED} />
              <Field {...FDP} label="PayPal" value={snap.paypal_handle || entry.paypal_handle} />
              {check?.verdict && (
                <div>
                  <div style={L}>Details vs invoice</div>
                  <div style={{ ...V, color: (VERDICT[check.verdict] || VERDICT.unscanned).color }}>
                    {check.verdict === 'match' && <Check style={{ width: 11, height: 11, display: 'inline', marginRight: 3 }} />}
                    {(VERDICT[check.verdict] || VERDICT.unscanned).label}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </td>
    </tr>
  )
}
