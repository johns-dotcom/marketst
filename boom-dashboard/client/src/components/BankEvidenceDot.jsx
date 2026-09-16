// "Did this actually leave the bank?" — a dot, in the statements dot-status
// language, fed by the bank_evidence / bank_expected columns that
// server/lib/bank-evidence.js adds to the expense list endpoints.
//
// Three states, and the third one matters:
//
//   emerald  matched to a bank transaction on a ready statement
//   rose     marked Paid, a statement covering that date exists, and nothing
//            on it matches — the "paid, no bank match" condition
//   nothing  no opinion. Either it isn't paid yet, or no statement covering
//            that date has been uploaded, so silence is the honest answer.
//
// The absent third state is deliberate: rendering a grey "unverified" dot on
// every row of an un-uploaded month would train people to ignore the dot.
//
// Rows are passed whole rather than as unpacked props so a caller can't
// accidentally pair `bank_evidence` from one row with `payment_status` from
// another.
//
// The rose condition itself now lives in utils.js as bankUnverified(), because
// the Recoupments page asks the same question about the same rows and a second
// copy would eventually disagree with this one.
import { bankUnverified } from '../utils'

const ACCOUNT_LABEL = { bofa: 'Bank of America', paypal: 'PayPal' }

const fmtDay = (d) => {
  if (!d) return ''
  const s = String(d).slice(0, 10)
  const [y, m, day] = s.split('-')
  return y ? `${m}/${day}/${y}` : s
}

// `onClick` is optional and the component is unchanged without it. Four pages
// render this dot and only the Ledger acts on it; a control that appeared
// everywhere would put a destructive action on pages that have no way to
// explain or undo it.
export default function BankEvidenceDot({ row, size = 7, className = '', onClick = null }) {
  if (!row) return null
  const ev = row.bank_evidence

  let tone = null
  let tip = ''
  if (ev) {
    tone = 'bg-emerald-500'
    const acct = ACCOUNT_LABEL[ev.account] || String(ev.account || '').toUpperCase()
    tip = `Bank-verified — matched to the ${acct} statement${ev.txn_date ? ` (${fmtDay(ev.txn_date)})` : ''}`
  } else if (bankUnverified(row)) {
    tone = 'bg-rose-500'
    tip = 'Marked Paid, but no matching transaction on the statement covering that date — check the payment date, the method, or whether it was actually paid'
  }
  if (!tone) return null

  if (onClick) {
    // A real <button>, so it is keyboard-reachable and announces itself. The
    // hit area is padded well beyond the 7px dot — a target that small is a
    // usability problem on its own, and doubly so when the thing behind it
    // changes reported figures.
    return (
      <button
        type="button"
        title={`${tip}\n\nClick to review this match`}
        aria-label={`${tip}. Click to review this match.`}
        onClick={(e) => { e.stopPropagation(); onClick(e) }}
        className={`inline-flex items-center justify-center shrink-0 -m-1 p-1 rounded-full cursor-pointer
          focus:outline-none focus-visible:ring-2 focus-visible:ring-boom-500 ${className}`}
      >
        <span className={`block rounded-full ${tone}`} style={{ width: size, height: size }} />
      </button>
    )
  }

  return (
    <span
      title={tip}
      aria-label={tip}
      className={`inline-block rounded-full shrink-0 ${tone} ${className}`}
      style={{ width: size, height: size }}
    />
  )
}
