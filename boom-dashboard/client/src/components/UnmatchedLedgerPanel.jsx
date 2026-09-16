// Direction ONE of Bank Matching: paid ledger rows with no statement line.
//
// The page has always looked the other way — statement lines needing a ledger
// row. That misses the half that actually loses money: an invoice marked paid
// that the bank never shows. John, 2026-08-24: "one for paid ledger items not
// yet matched to a statement item, and the other for statement items not paired
// with a ledger item."
//
// ── Three sections, because they are three different jobs ───────────────────
// The asymmetry John named is the whole design: a statement line can be passed
// as needing no match, a paid ledger row cannot. So there is NO dismiss here.
// The exits are matching it, or correcting what is wrong with it.
//
//   NEEDS A MATCH      a statement covers that date and the money is not on it.
//   NOT IN YET         dated past the newest statement we hold. Nothing is
//                      wrong — separated so it stops looking like a problem,
//                      which is what John asked for.
//   STATEMENT MISSING  inside the covered span and still uncovered: a month
//                      nobody uploaded. Without this split it would hide in
//                      "not in yet" forever and the gap would never be noticed.
//
// The server proves these three PARTITION the paid-and-unmatched set
// (scripts/unmatched-partition-fixture.cjs), so nothing here is invisible and
// nothing is counted twice.

import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Clock, FileWarning, ExternalLink, Search } from 'lucide-react'
import api from '../api'

const usd = (n) => (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const day = (d) => String(d || '').slice(0, 10)

const SECTIONS = [
  {
    key: 'needs_match', label: 'Needs a match', icon: AlertTriangle, tone: 'rose',
    blurb: 'A statement covers the payment date and the money is not on it. This is the real work.',
  },
  {
    key: 'awaiting_statement', label: 'Statement not in yet', icon: Clock, tone: 'gray',
    blurb: 'Paid after the newest statement we hold. Nothing is wrong — it will match when that statement arrives.',
  },
  {
    key: 'missing_statement', label: 'Statement missing', icon: FileWarning, tone: 'amber',
    blurb: 'Inside the months we do hold, but no statement covers it. That month was never uploaded.',
  },
]

const TONE = {
  rose: 'text-rose-600 border-l-rose-500',
  amber: 'text-amber-600 border-l-amber-500',
  gray: 'text-gray-400 border-l-gray-300',
}

export default function UnmatchedLedgerPanel() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [open, setOpen] = useState('needs_match')
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const r = await api.get('/statements/unmatched-ledger')
      setData(r.data?.data || null)
    } catch (e) {
      setErr(e?.response?.data?.error || e.message)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  if (loading) return <div className="text-sm text-gray-400 py-8">Loading…</div>
  if (err) return <div className="card p-3 border-l-4 border-l-rose-500 text-sm text-rose-700">{err}</div>
  if (!data) return null

  const match = (r) => {
    const t = q.trim().toLowerCase()
    if (!t) return true
    return [r.payee, r.artist, r.song, r.invoice_number, r.category]
      .some((v) => String(v || '').toLowerCase().includes(t))
  }

  const latest = (side) => data.coverage?.find((c) => c.side === side)?.latest

  return (
    <div>
      {/* What we hold, said plainly. "Not in yet" is only meaningful next to the
          date it is measured against. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-gray-500 mb-3">
        <span>Statements on file through</span>
        {['bank', 'paypal'].map((s) => (
          <span key={s} className="tabular-nums">
            <strong className="text-ink">{s === 'bank' ? 'Bank' : 'PayPal'}</strong>{' '}
            {latest(s) ? day(latest(s)) : 'none'}
          </span>
        ))}
        <div className="relative ml-auto">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Payee, artist, song, invoice…"
            className="pl-7 pr-2 py-1 text-[12px] border border-rule rounded-lg w-56 bg-card" />
        </div>
      </div>

      <div className="space-y-2">
        {SECTIONS.map((s) => {
          const band = data[s.key] || { n: 0, value: 0, rows: [] }
          const rows = band.rows.filter(match)
          const isOpen = open === s.key
          const Icon = s.icon
          return (
            <div key={s.key} className={`card border-l-4 ${TONE[s.tone].split(' ')[1]}`}>
              <button onClick={() => setOpen(isOpen ? null : s.key)}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left">
                <Icon size={15} className={TONE[s.tone].split(' ')[0]} />
                <span className="text-sm font-bold text-ink">{s.label}</span>
                <span className="text-[13px] text-gray-500 tabular-nums">
                  <strong className="text-ink">{band.n}</strong>
                  {band.value ? <span className="text-gray-400"> · {usd(band.value)}</span> : null}
                </span>
                <span className="text-[11px] text-gray-400 ml-2 hidden md:inline truncate">{s.blurb}</span>
                <span className="ml-auto text-[11px] text-gray-400">{isOpen ? 'Hide' : 'Show'}</span>
              </button>

              {isOpen && (
                band.n === 0 ? (
                  <div className="px-3 pb-3 text-[13px] text-gray-400">Nothing here.</div>
                ) : (
                  <div className="overflow-x-auto border-t border-divider">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider border-b border-divider">
                          <th className="px-3 py-2">Paid</th>
                          <th className="px-3 py-2">Payee</th>
                          <th className="px-3 py-2">Artist · Song</th>
                          <th className="px-3 py-2">Invoice</th>
                          <th className="px-3 py-2 text-right">Amount</th>
                          <th className="px-3 py-2">Method</th>
                          <th className="px-3 py-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.slice(0, 200).map((r) => (
                          <tr key={r.id} className="border-b border-divider/60 hover:bg-gray-50">
                            <td className="px-3 py-2 text-gray-500 tabular-nums whitespace-nowrap">{day(r.payment_date)}</td>
                            <td className="px-3 py-2 font-medium text-gray-900">{r.payee}</td>
                            <td className="px-3 py-2 text-gray-600">
                              {r.artist || <span className="text-gray-300">—</span>}
                              {r.song && <span className="text-gray-400"> · {r.song}</span>}
                            </td>
                            <td className="px-3 py-2 text-[12px] text-gray-500">
                              {r.invoice_number || <span className="text-gray-300">none</span>}
                              {!r.has_invoice && <span className="text-gray-300"> · no file</span>}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums font-medium">{usd(r.amount_usd_calc)}</td>
                            <td className="px-3 py-2 text-[12px] text-gray-500">{r.payment_method || '—'}</td>
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              {/* The two exits John allowed. No dismiss: a paid
                                  ledger row needs a match, or needs correcting. */}
                              <Link to={`/bk/vendors/${encodeURIComponent(r.payee || '')}`}
                                className="text-[11px] font-semibold text-boom-600 hover:text-boom-700 mr-2"
                                title="Attach it to a bank line on this vendor's page">
                                Find the line
                              </Link>
                              <Link to={`/bk/ledger?q=${encodeURIComponent(r.invoice_number || r.payee || '')}`}
                                className="text-[11px] text-gray-400 hover:text-gray-600 inline-flex items-center gap-0.5"
                                title="Open it in the Ledger to correct the payment date, or un-mark it paid">
                                Correct <ExternalLink size={10} />
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {rows.length > 200 && (
                      <div className="px-3 py-2 text-[11px] text-gray-400 border-t border-divider">
                        Showing 200 of {rows.length}. Narrow it with the search above.
                      </div>
                    )}
                  </div>
                )
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
