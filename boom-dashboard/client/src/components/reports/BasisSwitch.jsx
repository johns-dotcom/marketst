// The basis toggle (2026-09-20): which money the report counts. Three bases,
// one sentence each, the default chosen by the server from the data (ledger
// until a bank month is reconciled, then the bank). The sentence is the
// page's basis note — it replaces the fixed "statements are the master"
// paragraph, which was only true of one basis.
export const BASIS_TEXT = {
  bank: {
    label: 'Bank statements',
    short: 'Cash the bank proves',
    note: 'Statements are the master: every bank line counts exactly once and the ledger supplies categories. Paid invoices no statement vouches for are listed, not counted. Unpaid invoices are excluded.',
  },
  ledger: {
    label: 'Ledger — paid',
    short: 'Cash by the ledger',
    note: 'Every approved invoice marked Paid, dated by its payment date, whether or not a bank statement covers it yet. Unpaid invoices are excluded. Switch to Bank statements once a month is reconciled to prove these figures.',
  },
  accrual: {
    label: 'Accrual — invoiced',
    short: 'Commitments',
    note: 'Every approved invoice dated by its invoice date, paid or not — what the label has committed to, not what has left the bank. This is the view Financials used to carry.',
  },
}

export default function BasisSwitch({ basis, onChange, info, className = '' }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`} data-basis-switch>
      <span className="font-semibold text-gray-400 uppercase tracking-wider text-[10px]">Basis</span>
      <div className="flex gap-1" role="radiogroup" aria-label="Report basis">
        {Object.entries(BASIS_TEXT).map(([key, b]) => (
          <button key={key} role="radio" aria-checked={basis === key} onClick={() => onChange(key)} data-basis={key}
            title={b.note}
            className={`px-2.5 py-1 rounded-lg text-[12px] font-semibold border ${basis === key ? 'border-boom-600 text-boom-600 bg-boom-50/40' : 'border-rule text-gray-500 bg-card hover:text-ink'}`}>
            {b.label}
          </button>
        ))}
      </div>
      {info && info.default && (
        <span className="text-[11px] text-gray-400" data-basis-default>
          {info.default === basis ? 'default' : `default is ${BASIS_TEXT[info.default]?.label}`}
          {info.reconciled_through ? ` · bank reconciled through ${info.reconciled_through}` : info.statements ? ` · ${info.statements} statement${info.statements === 1 ? '' : 's'} uploaded, none reconciled` : ' · no bank statement uploaded yet'}
        </span>
      )}
    </div>
  )
}
