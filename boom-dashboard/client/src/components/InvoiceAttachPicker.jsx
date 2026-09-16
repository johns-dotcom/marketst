import { useState } from 'react'
import { FileText } from 'lucide-react'
import { pickDoc, fileUrl } from '../utils/entryFiles'
import { toUsd } from '../utils'
import { useFxRates } from '../context/FxRatesContext'

// Choosing the invoice(s) one payment settled.
//
// Built for the vendor page and now used by Bank Matching too, because those two
// were about to hold two answers to the same question — and the last time this
// page had two implementations of one idea it shipped two Review buttons
// reporting different counts.
//
// The interaction it owns:
//   · tick several invoices, because one transfer often covers several (measured:
//     8 such payments across 5 vendors, and the matcher can never pair them —
//     it needs ONE invoice equal to the payment to the cent)
//   · a running total against the line, since "do these add up" is the whole
//     question on a consolidated payment and it is not arithmetic to do in your
//     head against a table
//   · a document button per candidate, so the invoice is read before it is chosen
//   · the amount delta in USD on BOTH sides, via the shared toUsd with the
//     invoice's locked rate — a EUR invoice measured against a USD debit at face
//     value reports a difference in no currency at all
//
// It renders candidates and reports a selection; it does NOT know how to write
// one. Both callers post to /statements/tx/:id/attach themselves, because their
// surrounding flows differ (a deck advances, a table refreshes in place).
//
// Props:
//   candidates  [{ id, invoice_number, payee, family_total|amount, currency,
//                  payment_status, payment_date, invoice_date, fx_rate_to_usd,
//                  has_invoice… }]
//   lineUsd     the bank line's USD amount, for the delta and the running total
//   lineDate    the bank line's date, for the day gap
//   busy        disables everything while a write is in flight
//   onAttach    (expenseIds[]) => void
//   onPreview   ({url, filename}) => void — the caller owns the viewer
//   dark        style tokens for the inline-styled vendor page; omitted → Tailwind
export default function InvoiceAttachPicker({
  candidates = [], lineUsd = 0, lineDate = null, busy = false,
  onAttach, onPreview, emptyText, dark = null,
}) {
  const { rates: fxRates } = useFxRates()
  const [sel, setSel] = useState(() => new Set())

  const famTotal = (inv) => Number(inv.family_total ?? inv.amount ?? 0)
  const scored = candidates.map((inv) => {
    const gap = inv.payment_date && lineDate
      ? Math.round(Math.abs(new Date(inv.payment_date) - new Date(lineDate)) / 86400000)
      : null
    const invUsd = toUsd(famTotal(inv), inv.currency, fxRates, inv.fx_rate_to_usd)
    const delta = invUsd == null ? null : Math.round((invUsd - Number(lineUsd || 0)) * 100) / 100
    return {
      inv, invUsd, gap, delta,
      exact: delta !== null && Math.abs(delta) < 0.005 && gap !== null && gap <= 45,
    }
  }).sort((a, b) => (Math.abs(a.delta ?? 1e9) - Math.abs(b.delta ?? 1e9)) || ((a.gap ?? 1e9) - (b.gap ?? 1e9)))

  const picked = scored.filter((c) => sel.has(c.inv.id))
  const anyUnknown = picked.some((c) => c.invUsd == null)
  const sum = picked.reduce((s, c) => s + (c.invUsd || 0), 0)
  const diff = Math.round((sum - Number(lineUsd || 0)) * 100) / 100
  const covers = !anyUnknown && Math.abs(diff) < 0.005

  const money = (n, cur) => new Intl.NumberFormat('en-US', {
    style: 'currency', currency: (cur || 'USD').toUpperCase(),
  }).format(Number(n) || 0)

  // Two skins, one behaviour. The vendor page is one of the six inline-styled
  // pages (pixel-precise tables); Bank Matching is Tailwind. Rather than fork the
  // component, the caller passes its tokens.
  const C = dark
  const rowSty = C ? { display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', fontSize: 12.5 } : undefined
  const rowCls = C ? undefined : 'flex items-center gap-2.5 py-1 text-[12.5px]'

  return (
    <div>
      {scored.length === 0 ? (
        <div style={C ? { fontSize: 12, color: C.textFaint, padding: '6px 0' } : undefined}
          className={C ? undefined : 'text-[12px] text-gray-400 py-1.5'}>
          {emptyText || 'No invoice of this vendor’s is waiting for a bank line.'}
        </div>
      ) : scored.map(({ inv, invUsd, gap, delta, exact }) => {
        const doc = pickDoc(inv)
        return (
          <div key={inv.id} style={rowSty} className={rowCls}>
            <input type="checkbox" checked={sel.has(inv.id)} disabled={busy}
              onChange={() => setSel((prev) => {
                const next = new Set(prev)
                if (next.has(inv.id)) next.delete(inv.id); else next.add(inv.id)
                return next
              })}
              style={{ cursor: busy ? 'default' : 'pointer', flexShrink: 0 }} />
            <span style={C ? { color: C.text, fontWeight: 700, minWidth: 120 } : undefined}
              className={C ? undefined : 'font-bold text-ink min-w-[110px] truncate'}>
              {inv.invoice_number ? `inv ${inv.invoice_number}` : `entry #${inv.id}`}
            </span>
            <span style={C ? { color: C.text, fontFamily: 'ui-monospace, monospace', minWidth: 92, textAlign: 'right' } : undefined}
              className={C ? undefined : 'font-mono text-ink min-w-[86px] text-right'}>
              {money(famTotal(inv), inv.currency)}
            </span>
            {exact ? (
              <span style={C ? { fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#047857', background: '#ecfdf5', padding: '2px 6px', borderRadius: 4 } : undefined}
                className={C ? undefined : 'text-[10px] font-extrabold uppercase tracking-wide text-emerald-700 bg-emerald-50 rounded px-1.5 py-0.5'}
                title="Same amount to the cent and inside the matcher's own date window — the pairing the automatic sweep would accept.">exact</span>
            ) : delta === null ? (
              <span style={C ? { fontSize: 11, color: C.textFaint, fontWeight: 600 } : undefined}
                className={C ? undefined : 'text-[11px] text-gray-400 font-semibold'}
                title="No exchange rate for this invoice's currency, so the difference against the line can't be stated. Compare the amounts yourself.">
                {(inv.currency || 'USD').toUpperCase()} vs USD
              </span>
            ) : (
              <span style={C ? { fontSize: 11, color: delta > 0 ? '#b45309' : C.textFaint, fontWeight: 600 } : undefined}
                className={C ? undefined : `text-[11px] font-semibold ${delta > 0 ? 'text-amber-700' : 'text-gray-400'}`}
                title="Difference between this invoice and the bank line, both in USD. A part payment is a different decision from a settled invoice.">
                {delta > 0 ? '+' : ''}{money(delta)}
              </span>
            )}
            <span style={C ? { fontSize: 11, color: C.textFaint } : undefined}
              className={C ? undefined : 'text-[11px] text-gray-400'}>
              {inv.payment_status === 'Paid'
                ? <>paid {inv.payment_date ? String(inv.payment_date).slice(0, 10) : '—'}{gap !== null ? ` · ${gap}d apart` : ''}</>
                : <span style={C ? { color: '#b45309', fontWeight: 600 } : undefined}
                    className={C ? undefined : 'text-amber-700 font-semibold'}
                    title="This invoice isn't marked Paid. If this line is its payment, attaching says the money moved — worth marking it Paid too.">
                    not marked paid
                  </span>}
            </span>
            {doc && onPreview && (
              <button onClick={() => onPreview({ url: fileUrl(inv, doc.type), filename: inv[doc.name] || doc.label })}
                title={`Read the ${doc.label} before pairing`}
                style={C ? { background: 'none', border: 'none', cursor: 'pointer', color: C.textFaint, padding: 0, display: 'inline-flex' } : undefined}
                className={C ? undefined : 'text-gray-400 hover:text-ink shrink-0'}>
                <FileText style={{ width: 13, height: 13 }} />
              </button>
            )}
            <button onClick={() => onAttach([inv.id])} disabled={busy}
              style={C ? { marginLeft: 'auto', background: '#059669', border: 'none', borderRadius: 6, color: '#fff', fontSize: 11, fontWeight: 800, fontFamily: 'inherit', padding: '4px 10px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1, flexShrink: 0 } : undefined}
              className={C ? undefined : 'ml-auto bg-emerald-600 hover:bg-emerald-700 text-white rounded-md px-2.5 py-1 text-[11px] font-extrabold disabled:opacity-50 shrink-0'}>
              {busy ? '…' : 'pair'}
            </button>
          </div>
        )
      })}

      {/* The running total. Only once something is ticked — an empty row of
          arithmetic above an untouched list is noise. */}
      {picked.length > 0 && (
        <div style={C ? { display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, paddingTop: 8, borderTop: '1px solid ' + C.tdBorder, fontSize: 12.5 } : undefined}
          className={C ? undefined : 'flex items-center gap-2.5 mt-2 pt-2 border-t border-divider text-[12.5px]'}>
          <span style={C ? { color: C.textFaint, fontWeight: 700 } : undefined}
            className={C ? undefined : 'text-gray-400 font-bold'}>{picked.length} selected</span>
          <span style={C ? { color: C.text, fontFamily: 'ui-monospace, monospace', fontWeight: 700 } : undefined}
            className={C ? undefined : 'font-mono font-bold text-ink'}>{anyUnknown ? '—' : money(sum)}</span>
          {anyUnknown ? (
            <span style={C ? { fontSize: 11, color: C.textFaint } : undefined} className={C ? undefined : 'text-[11px] text-gray-400'}>
              one is in another currency with no rate — compare them yourself
            </span>
          ) : covers ? (
            <span style={C ? { fontSize: 11, fontWeight: 700, color: '#047857' } : undefined}
              className={C ? undefined : 'text-[11px] font-bold text-emerald-700'}>✓ covers this payment exactly</span>
          ) : (
            <span style={C ? { fontSize: 11, fontWeight: 600, color: '#b45309' } : undefined}
              className={C ? undefined : 'text-[11px] font-semibold text-amber-700'}
              title="Attaching is still allowed — a part payment is a real thing — but the difference is worth knowing before you record it.">
              {diff > 0 ? 'over by ' : 'short by '}{money(Math.abs(diff))} against this line
            </span>
          )}
          <button onClick={() => onAttach(picked.map((c) => c.inv.id))} disabled={busy}
            style={C ? { marginLeft: 'auto', background: '#059669', border: 'none', borderRadius: 6, color: '#fff', fontSize: 11.5, fontWeight: 800, fontFamily: 'inherit', padding: '5px 12px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1, flexShrink: 0 } : undefined}
            className={C ? undefined : 'ml-auto bg-emerald-600 hover:bg-emerald-700 text-white rounded-md px-3 py-1.5 text-[11.5px] font-extrabold disabled:opacity-50 shrink-0'}>
            {busy ? 'attaching…' : `Attach ${picked.length === 1 ? 'this invoice' : `these ${picked.length}`}`}
          </button>
        </div>
      )}
    </div>
  )
}
