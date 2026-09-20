import { Layers } from 'lucide-react'

// The strip above the Ledger table (2026-09-20): what the current filter
// holds, in the numbers the footer already computes — rows, total by
// currency, the USD reading, paid against unpaid — plus the group-by picker.
// The footer stays: it is the proof at the end of a long scroll; this is the
// same figure where the eye lands first.
export const GROUP_OPTIONS = [['none', 'No grouping'], ['vendor', 'By vendor'], ['artist', 'By artist'], ['category', 'By category'], ['month', 'By month']]

export default function LedgerSummary({ rows, fmt, byCurrency, sortedCurrencies, usdLine, attention, groupBy, onGroupBy, C, selectStyle }) {
  const primary = sortedCurrencies[0] || 'USD'
  const paid = rows.filter((r) => r.payment_status === 'Paid')
  const unpaid = rows.filter((r) => r.payment_status !== 'Paid')
  const sumIn = (list, cur) => list.filter((r) => (r.currency || 'USD') === cur).reduce((s, r) => s + (Number(r.amount) || 0), 0)
  const box = { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }
  const label = { fontSize: 10, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.textFaint }
  const value = { fontSize: 15, fontWeight: 900, color: C.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
  const sub = { fontSize: 11, color: C.textMuted, whiteSpace: 'nowrap' }
  return (
    <div data-ledger-summary style={{ display: 'flex', alignItems: 'center', gap: 22, padding: '8px 16px', borderBottom: `1px solid ${C.border}`, background: C.elevBg, flexWrap: 'wrap' }}>
      <div style={box}><span style={label}>Rows</span><span style={value} data-summary-rows>{rows.length.toLocaleString()}</span></div>
      <div style={box}>
        <span style={label}>Total</span>
        <span style={value} data-summary-total>{sortedCurrencies.length ? fmt(byCurrency[primary], primary) : fmt(0, 'USD')}{sortedCurrencies.length > 1 && <span style={{ ...sub, marginLeft: 6, fontWeight: 500 }}>+ {sortedCurrencies.slice(1).map((c) => fmt(byCurrency[c], c)).join(' + ')}</span>}</span>
        {usdLine && <span style={sub}>{usdLine}</span>}
      </div>
      <div style={box}>
        <span style={label}>Paid</span>
        <span style={value} data-summary-paid>{fmt(sumIn(paid, primary), primary)}</span>
        <span style={sub}>{paid.length} row{paid.length === 1 ? '' : 's'}</span>
      </div>
      <div style={box}>
        <span style={label}>Unpaid</span>
        <span style={{ ...value, color: unpaid.length ? '#b45309' : C.text }} data-summary-unpaid>{fmt(sumIn(unpaid, primary), primary)}</span>
        <span style={sub}>{unpaid.length} row{unpaid.length === 1 ? '' : 's'}</span>
      </div>
      {attention != null && (
        <div style={box}>
          <span style={label}>Needs attention</span>
          <span style={{ ...value, color: attention ? '#b45309' : C.text }} data-summary-attention>{attention}</span>
          <span style={sub}>no document, no W-9, no bank line, not in QuickBooks, flagged</span>
        </div>
      )}
      <label style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.textMuted, fontWeight: 700 }}>
        <Layers style={{ width: 13, height: 13 }} />
        <select value={groupBy} onChange={(e) => onGroupBy(e.target.value)} style={selectStyle} data-ledger-groupby title="Group the rows with a subtotal per group">
          {GROUP_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
    </div>
  )
}
