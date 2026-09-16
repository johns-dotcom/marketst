// Creator payments — money the marketing team sends creators with no invoice.
//
// Two tabs over one dataset. PAYMENTS is the ledger: what went out, to whom,
// for which artist and song, and whether a statement has proved it yet.
// CREATORS is the directory the Vendors page deliberately does not hold — these
// people have a PayPal handle and socials, not a W9 and payment terms — plus
// the one compliance number that matters, which is per-creator-per-year
// exposure over $600.
//
// Every row here is an `expenses` row with entry_source = 'creator_payment', so
// it already appears in Recoupments, Artist Campaigns and the P&L. Nothing on
// this page re-derives money: `amount_usd_calc` comes from the server's usdOf.

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Plus, Search, Trash2, AlertTriangle, X, Users, Receipt, ArrowRightLeft, Info } from 'lucide-react'
import api from '../api'
import PageHeader from '../components/PageHeader'
import BankEvidenceDot from '../components/BankEvidenceDot'
import { recoupState } from '../utils'

const usd = (n) => (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

// The same four words the rest of the app uses for a paid row's proof state.
// recoupState is imported rather than re-derived — Recoupments, Artist Spend and
// this page must never disagree about whether a payment is confirmed.
const STATE_LABEL = {
  verified: 'On a statement',
  awaiting_statement: 'Paid, statement not in yet',
  unverified: 'Paid, but the statement does not show it',
  unpaid: 'Unpaid',
}

const BLANK = {
  payee: '', vendor_email: '', paypal_handle: '', artist: '', song: '',
  amount: '', payment_date: new Date().toISOString().slice(0, 10),
  category: 'Marketing', notes: '', social_handles: '',
}

export default function BkCreators() {
  const [tab, setTab] = useState('payments')
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [dir, setDir] = useState([])
  const [dirSummary, setDirSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [rows_, setRows_] = useState([{ ...BLANK }])   // the form's payment rows
  const [deal, setDeal] = useState({ paid: true, is_bulk_deal: false, payment_date: new Date().toISOString().slice(0, 10) })
  const [saving, setSaving] = useState(false)
  // Expenses added on Artist Campaigns / Recoupments. They are stranded there:
  // undocumented hand-added rows cannot be matched to a bank line, so they can
  // never be reconciled until they move here.
  const [conv, setConv] = useState([])
  const [convSummary, setConvSummary] = useState(null)
  const [picked, setPicked] = useState(new Set())

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [a, b, c] = await Promise.all([
        api.get('/creators', { params: q.trim() ? { q: q.trim() } : {} }),
        api.get('/creators/directory'),
        api.get('/creators/convertible'),
      ])
      setRows(a.data?.data || [])
      setTotal(a.data?.total || 0)
      setDir(b.data?.data || [])
      setDirSummary(b.data?.summary || null)
      setConv(c.data?.data || [])
      setConvSummary(c.data?.summary || null)
      // Pre-select only what the classifier proposes converting. The review
      // rows are visible and selectable, never selected FOR you.
      setPicked(new Set((c.data?.data || []).filter((r) => r.proposed === 'convert').map((r) => r.id)))
    } catch (e) {
      setErr(e?.response?.data?.error || e.message)
    } finally {
      setLoading(false)
    }
  }, [q])

  useEffect(() => { load() }, [load])

  const parseSocials = (text) => String(text || '')
    .split(',').map((x) => x.trim()).filter(Boolean)
    .map((chunk) => {
      const [a, b] = chunk.split(':').map((x) => (x || '').trim())
      return b ? { platform: a.toLowerCase(), handle: b } : { platform: 'other', handle: a }
    })

  // Mirrors REQUIRED_FIELDS in routes/creators.js. The server is the gate; this
  // exists so the button and the hint can say WHICH field is missing before the
  // round trip.
  const gapsFor = (r) => {
    const g = []
    if (!String(r.payee || '').trim()) g.push('a creator name')
    if (!(Number(r.amount) > 0)) g.push('an amount')
    if (!String(r.artist || '').trim()) g.push('an artist')
    if (!String(r.song || '').trim()) g.push('a song')
    if (!String(r.vendor_email || '').trim()) g.push('an email')
    if (!String(r.paypal_handle || '').trim()) g.push('a PayPal handle')
    if (!parseSocials(r.social_handles).length) g.push('socials')
    return g
  }
  const rowComplete = (r) => gapsFor(r).length === 0


  const save = async () => {
    setSaving(true); setErr(null)
    try {
      // One request for the whole batch. The server validates every row before
      // writing any, so a bad row cannot leave half a bulk deal in the ledger.
      await api.post('/creators/batch', {
        ...deal,
        payments: rows_.map((r) => ({
          ...r,
          amount: Number(r.amount),
          social_handles: parseSocials(r.social_handles),
        })),
      })
      setRows_([{ ...BLANK }]); setDeal({ paid: true, is_bulk_deal: false, payment_date: new Date().toISOString().slice(0, 10) })
      setAdding(false); await load()
    } catch (e) {
      setErr(e?.response?.data?.error || e.message)
    } finally {
      setSaving(false)
    }
  }

  const convert = async () => {
    if (!picked.size) return
    setSaving(true); setErr(null)
    try {
      const r = await api.post('/creators/convert', { ids: [...picked] })
      const { converted, relabelled_matches } = r.data?.data || {}
      setErr(null)
      await load()
      window.alert(`${converted} moved in.` + (relabelled_matches
        ? ` ${relabelled_matches} already matched to a bank line — those matches now record the creator disposition, so they stop counting as invoice-backed.`
        : ''))
    } catch (e) {
      setErr(e?.response?.data?.error || e.message)
    } finally {
      setSaving(false)
    }
  }

  // Mark paid, or put it back. The two columns move together server-side —
  // `payment_status` and `payment_date` — because Paid with no date reads one way
  // to recoupState() and another to every date-bounded report.
  const [payingId, setPayingId] = useState(null)
  const setPaid = async (r, paid) => {
    setPayingId(r.id)
    try {
      const today = new Date().toISOString().slice(0, 10)
      await api.put(`/creators/${r.id}`, {
        payment_status: paid ? 'Paid' : 'Unpaid',
        ...(paid ? { payment_date: today } : {}),
      })
      // Patched, not refetched: this list sorts by payment_date, so a refetch
      // would reorder it under the cursor the moment a row is marked.
      setRows((prev) => prev.map((x) => (x.id === r.id
        ? { ...x, payment_status: paid ? 'Paid' : 'Unpaid', payment_date: paid ? today : null }
        : x)))
    } catch (e) {
      setErr(e?.response?.data?.error || e.message)
    } finally { setPayingId(null) }
  }

  const remove = async (row) => {
    if (!window.confirm(`Delete the ${usd(row.amount_usd_calc)} payment to ${row.payee}?`)) return
    try { await api.delete(`/creators/${row.id}`); await load() }
    catch (e) { setErr(e?.response?.data?.error || e.message) }
  }

  const exposed = useMemo(() => dir.filter((c) => c.w9_missing), [dir])

  // Which gaps are UNIVERSAL across the move-in queue.
  //
  // Artist Campaigns and Recoupments never collected contact details, so every
  // one of the 121 rows is missing email, PayPal handle and socials. Printing
  // that on all 121 lines is a wall of identical text that hides the gaps which
  // actually differ — 5 rows missing a song, for instance. The universal ones go
  // in the banner once; only what varies stays on the row.
  const universalGaps = useMemo(() => {
    const movers = conv.filter((r) => r.proposed === 'convert')
    if (!movers.length) return new Set()
    const every = ['email', 'PayPal handle', 'socials', 'song', 'artist']
      .filter((g) => movers.every((r) => r.missing.includes(g)))
    return new Set(every)
  }, [conv])

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <PageHeader
        title="Creator Payments"
        subtitle="Payments made without an invoice — tracked, matchable to PayPal statements, and counted in Artist Campaigns and Recoupments."
        actions={
          <button onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold bg-boom-600 text-white hover:bg-boom-700">
            <Plus size={15} /> Record a payment
          </button>
        }
      />

      {err && (
        <div className="card p-3 mb-4 border-l-4 border-l-rose-500 text-sm text-rose-700">{err}</div>
      )}

      {/* The compliance number, above the fold and only when it is non-zero.
          Many small payments to one creator is exactly how a 1099 obligation
          accumulates without anybody noticing. */}
      {dirSummary?.w9_missing > 0 && (
        <div className="card p-3 mb-4 border-l-4 border-l-amber-500 flex items-start gap-2.5">
          <AlertTriangle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-gray-700">
            <strong>{dirSummary.w9_missing}</strong> creator{dirSummary.w9_missing === 1 ? '' : 's'} passed
            {' '}{usd(dirSummary.threshold)} in a calendar year with no W9 on file
            {' '}({usd(dirSummary.w9_missing_value)} total).
            <span className="text-gray-400"> A 1099 needs one.</span>
          </div>
        </div>
      )}

      <div className="flex gap-0 border-b border-divider mb-4">
        {[['payments', 'Payments', Receipt], ['creators', 'Creators', Users],
          ['movein', 'To move in', ArrowRightLeft]].map(([id, label, Icon]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`inline-flex items-center gap-1.5 text-xs font-medium px-4 py-2.5 -mb-px transition-colors ${
              tab === id ? 'text-boom-600 border-b-2 border-boom-500'
                         : 'text-gray-400 border-b-2 border-transparent hover:text-gray-600'}`}>
            <Icon size={13} />{label}
            <span className="text-gray-300">
              {id === 'payments' ? rows.length : id === 'creators' ? dir.length : conv.length}
            </span>
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 pb-2">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Creator, email, handle, artist, song…"
              className="pl-8 pr-3 py-1.5 text-xs border border-rule rounded-lg w-64 bg-card" />
          </div>
          <span className="text-xs text-gray-400 tabular-nums">{usd(total)}</span>
        </div>
      </div>

      {loading && <div className="text-sm text-gray-400 py-8">Loading…</div>}

      {!loading && tab === 'payments' && (
        rows.length === 0 ? (
          <div className="text-sm text-gray-400 py-8">
            No creator payments yet. “Record a payment” adds one.
          </div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider border-b border-divider">
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Creator</th>
                  <th className="px-3 py-2">PayPal</th>
                  <th className="px-3 py-2">Artist · Song</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">Proof</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-divider/60 hover:bg-gray-50">
                    <td className="px-3 py-2 text-gray-500 tabular-nums whitespace-nowrap">
                      {String(r.payment_date || '').slice(0, 10)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-900">{r.payee}</div>
                      {r.vendor_email && <div className="text-[11px] text-gray-400">{r.vendor_email}</div>}
                    </td>
                    <td className="px-3 py-2 text-gray-500">{r.paypal_handle || '—'}</td>
                    <td className="px-3 py-2 text-gray-600">
                      {r.artist || <span className="text-gray-300">no artist</span>}
                      {r.song && <span className="text-gray-400"> · {r.song}</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{usd(r.amount_usd_calc)}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-500">
                        <BankEvidenceDot row={r} />
                        {STATE_LABEL[recoupState(r)]}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {/* Unpaid rows get the action; paid rows get a quiet way
                          back, because the mistake worth undoing is marking the
                          wrong one paid. */}
                      {r.payment_status === 'Paid' ? (
                        <button onClick={() => setPaid(r, false)} disabled={payingId === r.id}
                          className="text-[11px] text-gray-300 hover:text-gray-600 mr-2 disabled:opacity-40"
                          title="Undo — put this back to unpaid">
                          unpay
                        </button>
                      ) : (
                        <button onClick={() => setPaid(r, true)} disabled={payingId === r.id}
                          className="text-[11px] font-semibold text-boom-600 hover:text-boom-700 mr-2 disabled:opacity-40"
                          title="Mark this payment as made, dated today">
                          {payingId === r.id ? '…' : 'Mark paid'}
                        </button>
                      )}
                      <button onClick={() => remove(r)} className="text-gray-300 hover:text-rose-500" title="Delete">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {!loading && tab === 'creators' && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider border-b border-divider">
                <th className="px-3 py-2">Creator</th>
                <th className="px-3 py-2">PayPal</th>
                <th className="px-3 py-2">Socials</th>
                <th className="px-3 py-2">Artists</th>
                <th className="px-3 py-2 text-right">Payments</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2">W9</th>
              </tr>
            </thead>
            <tbody>
              {dir.map((c) => (
                <tr key={c.payee} className="border-b border-divider/60 hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900">{c.payee}</div>
                    {c.email && <div className="text-[11px] text-gray-400">{c.email}</div>}
                  </td>
                  <td className="px-3 py-2 text-gray-500">{c.paypal_handle || '—'}</td>
                  <td className="px-3 py-2 text-[11px] text-gray-500">
                    {Array.isArray(c.social_handles) && c.social_handles.length
                      ? c.social_handles.map((h) => `${h.platform}: ${h.handle}`).join(' · ')
                      : <span className="text-gray-300">none</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-600 text-[12px]">{c.artists.join(', ') || '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-500">{c.payments}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium">{usd(c.total)}</td>
                  <td className="px-3 py-2">
                    {c.w9_missing ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-600"
                        title={`Over ${usd(dirSummary?.threshold || 600)} in ${c.years_over.join(', ')}`}>
                        <AlertTriangle size={12} /> needed
                      </span>
                    ) : c.w9_on_file ? (
                      <span className="text-[11px] text-emerald-600">on file</span>
                    ) : (
                      <span className="text-[11px] text-gray-300">under threshold</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && tab === 'movein' && (
        conv.length === 0 ? (
          <div className="text-sm text-gray-400 py-8">
            Nothing waiting. Expenses added on Artist Campaigns or Recoupments show up here.
          </div>
        ) : (
          <>
            <div className="card p-3 mb-3 flex items-start gap-2.5">
              <Info size={15} className="text-gray-400 flex-shrink-0 mt-0.5" />
              <div className="text-[13px] text-gray-600">
                These were added on <strong>Artist Campaigns</strong> and <strong>Recoupments</strong>.
                None has an invoice, so none of them can be matched to a bank line where they sit —
                moving them here is what makes them reconcilable.
                {convSummary && (
                  <div className="text-gray-400 mt-1">
                    {convSummary.convert} look like creator payments ({usd(convSummary.convert_value)}).
                    {convSummary.review > 0 && <> {convSummary.review} need a look first ({usd(convSummary.review_value)}) — ad spend and advances are not creator payments, and moving them would drop those vendors out of the Vendors directory.</>}
                    {convSummary.already_matched > 0 && <> {convSummary.already_matched} are already matched to a bank line; moving those also corrects the match so they stop counting as invoice-backed.</>}
                    {universalGaps.size > 0 && (
                      <div className="mt-1">
                        Every one of them is missing <strong>{[...universalGaps].join(', ')}</strong> — those
                        pages never asked for it. They move in flagged, and the Creators tab is where you fill it in.
                      </div>
                    )}
                  </div>
                )}
              </div>
              <button onClick={convert} disabled={saving || !picked.size}
                className="ml-auto flex-shrink-0 px-3 py-1.5 rounded-lg text-sm font-semibold bg-boom-600 text-white hover:bg-boom-700 disabled:opacity-40">
                {saving ? 'Moving…' : `Move ${picked.size} in`}
              </button>
            </div>
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider border-b border-divider">
                    <th className="px-3 py-2 w-8"></th>
                    <th className="px-3 py-2">Payee</th>
                    <th className="px-3 py-2">Artist · Song</th>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="px-3 py-2">From</th>
                    <th className="px-3 py-2">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {conv.map((r) => {
                    const review = r.proposed === 'review'
                    return (
                      <tr key={r.id} className={`border-b border-divider/60 ${review ? 'bg-amber-50/40' : 'hover:bg-gray-50'}`}>
                        <td className="px-3 py-2">
                          <input type="checkbox" checked={picked.has(r.id)}
                            onChange={(e) => setPicked((p) => {
                              const n = new Set(p); e.target.checked ? n.add(r.id) : n.delete(r.id); return n
                            })}
                            style={{ accentColor: '#334155' }} />
                        </td>
                        <td className="px-3 py-2 font-medium text-gray-900">{r.payee}</td>
                        <td className="px-3 py-2 text-gray-600">
                          {r.artist || <span className="text-gray-300">no artist</span>}
                          {r.song && <span className="text-gray-400"> · {r.song}</span>}
                        </td>
                        <td className="px-3 py-2 text-gray-500">{r.category}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{usd(r.amount_usd_calc)}</td>
                        <td className="px-3 py-2 text-[11px] text-gray-400">
                          {r.entry_source === 'recoupments' ? 'Recoupments' : 'Artist Campaigns'}
                        </td>
                        <td className="px-3 py-2 text-[11px]">
                          {review && (
                            <span className="text-amber-700 font-semibold">{r.review_reasons.join(' · ')}</span>
                          )}
                          {!review && (() => {
                            const own = r.missing.filter((g) => !universalGaps.has(g))
                            return own.length > 0
                              ? <span className="text-gray-400">missing {own.join(', ')}</span>
                              : null
                          })()}
                          {r.already_matched && <span className="text-emerald-600 ml-1.5">already matched</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )
      )}

      {adding && (
        <div className="fixed inset-0 bg-overlay flex items-center justify-center z-50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setAdding(false) }}>
          <div className="bg-card rounded-xl shadow-lg w-full max-w-4xl max-h-[90vh] overflow-y-auto p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-bold text-gray-900">
                Record creator payments
                {rows_.length > 1 && <span className="text-gray-400 font-medium"> · {rows_.length} creators</span>}
              </h2>
              <button onClick={() => setAdding(false)} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
            </div>

            {/* What the whole batch shares. Everything a creator can differ on —
                artist, song, amount — lives on the ROW, because one bulk deal
                routinely spans several artists and several songs and crediting
                them all to the first row's artist is the attribution bug this
                shape exists to avoid. */}
            <div className="grid grid-cols-3 gap-3 mb-4 pb-4 border-b border-divider">
              {/* "Deal name" removed 2026-08-27 — it only ever landed in
                  `description` and nothing read it back out. */}
              {/* Paid, or committed but not yet paid. Until now these rows were
                  created Paid unconditionally with today's date, so there was no
                  way to log "we owe this creator" — and nothing to mark as paid,
                  because everything already was. */}
              <label className="block">
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Paid?</span>
                <div className="mt-1 flex gap-1">
                  {[['Paid', true], ['Not yet', false]].map(([label, val]) => (
                    <button key={label} type="button"
                      onClick={() => setDeal((d) => ({
                        ...d, paid: val,
                        // The date moves with the answer, so an unpaid row cannot
                        // carry a payment date it has not earned.
                        payment_date: val ? (d.payment_date || new Date().toISOString().slice(0, 10)) : '',
                      }))}
                      className={`px-2.5 py-1.5 rounded-lg text-[12px] font-bold border-2 transition-colors ${
                        (deal.paid !== false) === val
                          ? (val ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-gray-600 border-gray-600 text-white')
                          : 'border-rule text-gray-500 hover:border-gray-300'}`}>
                      {label}
                    </button>
                  ))}
                </div>
              </label>
              <label className="block">
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Paid on</span>
                <input type="date" value={deal.payment_date} disabled={deal.paid === false}
                  onChange={(e) => setDeal((d) => ({ ...d, payment_date: e.target.value }))}
                  className="mt-1 w-full px-2.5 py-1.5 text-sm border border-rule rounded-lg bg-card disabled:opacity-40" />
              </label>
              <label className="flex items-end gap-2 pb-1.5 cursor-pointer">
                <input type="checkbox" checked={deal.is_bulk_deal}
                  onChange={(e) => setDeal((d) => ({ ...d, is_bulk_deal: e.target.checked }))}
                  style={{ accentColor: '#334155' }} />
                <span className="text-xs text-gray-600 font-medium">
                  Bulk deal
                  <span className="block text-[10px] font-normal text-gray-400">Marks every row, so it stays findable as one piece of work</span>
                </span>
              </label>
            </div>

            <div className="space-y-2">
              {rows_.map((r, i) => (
                <div key={i} className="border border-rule rounded-lg p-2.5">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Creator {i + 1}</span>
                    {rows_.length > 1 && (
                      <button type="button" onClick={() => setRows_((rs) => rs.filter((_, k) => k !== i))}
                        className="ml-auto text-gray-300 hover:text-rose-500" title="Remove">
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {/* Every one of these is required — the server enforces the
                        same list (REQUIRED_FIELDS in routes/creators.js), so the
                        red ring here is a courtesy, not the gate. An empty field
                        is marked only once it has been touched and left, so the
                        form does not open covered in errors. */}
                    {[
                      ['payee', 'Creator name', 'text'],
                      ['amount', 'Amount (USD)', 'number'],
                      ['artist', 'Artist', 'text'],
                      ['song', 'Song', 'text'],
                      ['vendor_email', 'Email', 'email'],
                      ['paypal_handle', 'PayPal handle', 'text'],
                    ].map(([k, label, type]) => {
                      const empty = !String(r[k] ?? '').trim() || (k === 'amount' && !(Number(r[k]) > 0))
                      const shown = empty && r._touched?.[k]
                      return (
                        <label key={k} className="block">
                          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                            {label} <span className="text-boom-600">*</span>
                          </span>
                          <input type={type} value={r[k]}
                            onChange={(e) => setRows_((rs) => rs.map((x, k2) => (k2 === i ? { ...x, [k]: e.target.value } : x)))}
                            onBlur={() => setRows_((rs) => rs.map((x, k2) => (k2 === i ? { ...x, _touched: { ...x._touched, [k]: true } } : x)))}
                            className={`mt-1 w-full px-2.5 py-1.5 text-sm border rounded-lg bg-card ${
                              shown ? 'border-rose-400 ring-1 ring-rose-200' : 'border-rule'}`} />
                        </label>
                      )
                    })}
                    <label className="block col-span-2">
                      <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                        Socials <span className="text-boom-600">*</span>
                        <span className="font-normal normal-case tracking-normal text-gray-400"> — “tiktok: @name, instagram: @name”</span>
                      </span>
                      <input value={r.social_handles}
                        onChange={(e) => setRows_((rs) => rs.map((x, k2) => (k2 === i ? { ...x, social_handles: e.target.value } : x)))}
                        onBlur={() => setRows_((rs) => rs.map((x, k2) => (k2 === i ? { ...x, _touched: { ...x._touched, social_handles: true } } : x)))}
                        className={`mt-1 w-full px-2.5 py-1.5 text-sm border rounded-lg bg-card ${
                          !parseSocials(r.social_handles).length && r._touched?.social_handles
                            ? 'border-rose-400 ring-1 ring-rose-200' : 'border-rule'}`} />
                    </label>
                  </div>
                </div>
              ))}
            </div>

            <button type="button"
              onClick={() => setRows_((rs) => [...rs, {
                ...BLANK,
                // Carry the previous row's artist and song forward: several
                // creators on ONE song is the common case, and retyping it is
                // how a row ends up unattributed.
                artist: rs[rs.length - 1]?.artist || '',
                song: rs[rs.length - 1]?.song || '',
              }])}
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-boom-600 hover:text-boom-700">
              <Plus size={13} /> Add another creator
            </button>

            <div className="flex items-center gap-3 mt-4 pt-3 border-t border-divider">
              <span className="text-sm text-gray-500">
                {rows_.length} payment{rows_.length === 1 ? '' : 's'} ·{' '}
                <strong className="text-gray-800 tabular-nums">
                  {usd(rows_.reduce((t, r) => t + (Number(r.amount) || 0), 0))}
                </strong>
              </span>
              <span className="text-[11px] text-gray-400">
                {rows_.every(rowComplete)
                  ? 'Each creator is a separate PayPal payment and matches its own statement line.'
                  : (() => {
                      const bad = rows_.map((r, i) => [i + 1, gapsFor(r)]).filter(([, g]) => g.length)
                      const [n, g] = bad[0]
                      return `Creator ${n} still needs ${g.join(', ')}${bad.length > 1 ? ` (and ${bad.length - 1} more incomplete)` : ''}.`
                    })()}
              </span>
              <div className="ml-auto flex gap-2">
                <button onClick={() => setAdding(false)} className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">Cancel</button>
                <button onClick={save}
                  disabled={saving || !rows_.every(rowComplete)}
                  className="px-4 py-1.5 text-sm font-semibold rounded-lg bg-boom-600 text-white hover:bg-boom-700 disabled:opacity-40">
                  {saving ? 'Saving…' : `Save ${rows_.length} payment${rows_.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
