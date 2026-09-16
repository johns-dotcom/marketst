// Recoupment audit — /recoupments/audit
//
// The Recoupments page answers "what can we recoup". This one answers the
// question that page cannot ask about itself: "is anything missing, and is
// anything claimed that shouldn't be?"
//
// Five checks, measured against production on 2026-08-20 before any of this was
// built. Two are money NOT claimed, three are money claimed wrongly:
//
//   advances          13 rows   $391,958.60   bank-verified, no artist, unanswered
//                     11 of them $390,530.22   are the Advance category itself
//   bank pile      1,919 rows $3,007,397.33   never judged recoupable, unreachable
//   claimed twice      9 grps    $30,760.97   3 of them span two artists
//   no document       16 rows    $68,928.68   claimed with no file to show anyone
//   half a payment    10 fams     $6,239.00   part of one payment claimed
//
// Every figure comes from GET /bk/recoupment-audit. This page derives NO money of
// its own — the predicates behind these numbers are the kind that end up in three
// files disagreeing with each other, so they live in one query and the page
// renders what it is given.
//
// It deliberately does NOT include "claimed with no bank line" (48 rows,
// $141,891.83). That chip already exists on the Recoupments page, and one
// condition with two homes is how two homes start disagreeing.

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft, RefreshCw, AlertTriangle, Copy, FileWarning, Scissors,
  PiggyBank, Layers, Check, Trash2, ExternalLink, ChevronRight,
} from 'lucide-react'
import api from '../api'
import PageHeader from '../components/PageHeader'
import Skeleton from '../components/Skeleton'
import PayeeLink from '../components/PayeeLink'
import BankEvidenceDot from '../components/BankEvidenceDot'
import { useToast } from '../context/ToastContext'
import { formatDate } from '../utils'

const usd = (v) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2,
}).format(Number(v) || 0)

// Compact money for a tile: $390.5k reads faster than $390,530.22 at 11px, and
// the exact figure is one hover away.
const compact = (v) => {
  const n = Math.abs(Number(v) || 0)
  if (n >= 1000000) return `$${(n / 1000000).toFixed(2)}M`
  if (n >= 1000) return `$${Math.round(n / 1000)}k`
  return usd(n)
}

// The row's own USD, computed server-side by usdOf so a foreign row is never
// scored at face value or at zero.
const rowUsd = (r) => Number(r?.amount_usd_calc ?? r?.amount ?? 0)

const CHECKS = [
  { id: 'advances', label: 'Advances waiting for an artist', icon: PiggyBank,
    tone: 'text-boom-700',
    blurb: 'Bank-verified payments in Advance, Recording, Tour/Live or Artist Expense that name nobody. An advance is an artist’s own money, so a row here is a recoupable cost with nobody to bill.' },
  { id: 'pile', label: 'Bank costs never answered', icon: Layers,
    tone: 'text-amber-700',
    blurb: 'Statement-born spend nobody has judged recoupable. `recoupable` is TRUE by default on all of it, which is not a decision — so it is off the Recoupments page until somebody answers, one row or one whole class at a time.' },
  { id: 'double', label: 'Possibly claimed twice', icon: Copy,
    tone: 'text-rose-700',
    blurb: 'Same vendor, same invoice number, claimed more than once. A sensor, not a verdict — separate deliverables do get billed on one number. The ones spanning two artists come first, because those may charge one cost to two people.' },
  { id: 'nodoc', label: 'Claimed with no document', icon: FileWarning,
    tone: 'text-rose-700',
    blurb: 'Uploaded for recoupment with no invoice file anywhere in the family — the parent’s counts, since that is where a split child’s document lives. If the artist asks to see it, there is nothing to send.' },
  { id: 'partial', label: 'Half a payment claimed', icon: Scissors,
    tone: 'text-amber-700',
    blurb: 'A split payment where one slice was claimed and its siblings were not. Nobody decides this on purpose; it is what a split looks like when the claim was made before it.' },
]

export default function RecoupmentsAudit() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [active, setActive] = useState('advances')
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const load = async () => {
    setLoading(true); setErr('')
    try {
      const res = await api.get('/bk/recoupment-audit')
      setData(res.data?.data || null)
    } catch (e) {
      setErr(e.response?.data?.error || e.message)
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const t = data?.totals || {}
  const counts = {
    advances: { n: t.advances_items || 0, usd: t.advances_usd || 0 },
    pile: { n: t.pile_items || 0, usd: t.pile_usd || 0 },
    double: { n: t.double_claims_groups || 0, usd: t.double_claims_usd || 0 },
    nodoc: { n: t.no_document_items || 0, usd: t.no_document_usd || 0 },
    partial: { n: t.partial_families_count || 0, usd: t.partial_families_usd || 0 },
  }
  // Money not claimed and money claimed wrongly are different problems and are
  // NOT added together anywhere on this page. A single "$1.5M of exposure"
  // headline would be adding up things that need opposite actions.
  const missing = (counts.advances.usd || 0) + (counts.partial.usd || 0)
  const suspect = (counts.double.usd || 0) + (counts.nodoc.usd || 0)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Recoupment audit"
        subtitle="Five checks on the recoupment ledger — money that should be claimed and has not been, and money claimed that cannot be shown."
        actions={(
          <>
            <Link to="/recoupments"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-bold text-gray-500 border border-rule hover:text-ink hover:border-gray-300">
              <ArrowLeft size={13} /> Recoupments
            </Link>
            <button type="button" onClick={load} disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-bold text-gray-500 border border-rule hover:text-ink hover:border-gray-300 disabled:opacity-40">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Recheck
            </button>
          </>
        )}
      />

      {err && (
        <div className="card p-3 border-l-4 border-l-rose-500">
          <p className="text-[12.5px] text-rose-600 font-bold">{err}</p>
        </div>
      )}

      {loading && !data && <Skeleton.StatCards count={5} />}

      {data && (
        <>
          {/* Two sentences of arithmetic, stated rather than merged into one
              number: these five checks want opposite actions. */}
          <div className="card p-3">
            <p className="text-[12px] text-gray-500">
              <span className="font-bold text-ink">{usd(missing)}</span> looks claimable and is not
              claimed{' '}
              <span className="text-gray-400">
                ({counts.advances.n} advance{counts.advances.n === 1 ? '' : 's'},{' '}
                {counts.partial.n} part-claimed payment{counts.partial.n === 1 ? '' : 's'})
              </span>
              {' · '}
              <span className="font-bold text-rose-700">{usd(suspect)}</span> is claimed and needs a
              second look{' '}
              <span className="text-gray-400">
                ({counts.double.n} possible duplicate{counts.double.n === 1 ? '' : 's'},{' '}
                {counts.nodoc.n} with no document)
              </span>
              {counts.pile.n > 0 && (
                <>
                  {' · '}
                  <span className="font-bold text-amber-700">{usd(counts.pile.usd)}</span> of bank
                  spend has never been judged either way{' '}
                  <span className="text-gray-400">({counts.pile.n.toLocaleString()} rows)</span>
                </>
              )}
            </p>
          </div>

          {/* Tiles double as the section selector — five checks, one open. */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            {CHECKS.map((c) => {
              const on = active === c.id
              const k = counts[c.id]
              const clean = k.n === 0
              return (
                <button key={c.id} type="button" onClick={() => setActive(c.id)}
                  title={c.blurb}
                  className={`card p-3 text-left transition ${
                    on ? 'ring-2 ring-boom-400' : 'hover:border-gray-300'
                  } ${clean ? 'opacity-60' : ''}`}>
                  <div className="flex items-center gap-1.5">
                    <c.icon size={13} className={clean ? 'text-gray-400' : c.tone} />
                    <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
                      {c.id === 'pile' ? 'Unanswered' : c.id === 'advances' ? 'Not claimed'
                        : c.id === 'partial' ? 'Not claimed' : 'Claimed'}
                    </span>
                  </div>
                  <div className={`mt-1.5 text-[19px] font-black tabular-nums ${
                    clean ? 'text-gray-400' : c.tone}`}
                    title={usd(k.usd)}>
                    {clean ? '—' : compact(k.usd)}
                  </div>
                  <div className="text-[11px] font-bold text-ink leading-tight">{c.label}</div>
                  <div className="mt-0.5 text-[10.5px] text-gray-400 tabular-nums">
                    {clean ? 'nothing found' : `${k.n.toLocaleString()} ${
                      c.id === 'double' ? 'group' : c.id === 'partial' ? 'payment' : 'item'}${
                      k.n === 1 ? '' : 's'}`}
                    {c.id === 'double' && t.double_claims_cross_artist > 0 && (
                      <span className="text-rose-600 font-bold">
                        {' · '}{t.double_claims_cross_artist} across two artists
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>

          <p className="text-[11px] text-gray-400 px-1">
            {CHECKS.find((c) => c.id === active)?.blurb}
          </p>

          {active === 'advances' && (
            <Advances rows={data.advances} artistOptions={data.artist_options || []}
              busy={busy} setBusy={setBusy} onDone={load} toast={toast} />
          )}
          {active === 'pile' && (
            <Pile pile={data.pile} busy={busy} setBusy={setBusy} onDone={load} toast={toast} />
          )}
          {active === 'double' && (
            <DoubleClaims groups={data.double_claims} busy={busy} setBusy={setBusy}
              onDone={load} toast={toast} />
          )}
          {active === 'nodoc' && (
            <NoDocument rows={data.no_document} busy={busy} setBusy={setBusy}
              onDone={load} toast={toast} />
          )}
          {active === 'partial' && (
            <PartialFamilies families={data.partial_families} busy={busy} setBusy={setBusy}
              onDone={load} toast={toast} />
          )}
        </>
      )}
    </div>
  )
}

// ── Empty state ──────────────────────────────────────────────────────────────
// "Nothing found" is a RESULT here, not an absence, so it says which check ran.
function Clean({ what }) {
  return (
    <div className="card p-6 text-center">
      <Check size={20} className="mx-auto text-emerald-500" />
      <p className="mt-2 text-[13px] font-bold text-ink">Nothing to answer</p>
      <p className="mt-1 text-[11.5px] text-gray-400">{what}</p>
    </div>
  )
}

// ── 1. Advances waiting for an artist ────────────────────────────────────────
function Advances({ rows, artistOptions, busy, setBusy, onDone, toast }) {
  // Keyed by row id so two rows being answered at once cannot share a value.
  const [picked, setPicked] = useState({})
  if (!rows?.length) return <Clean what="No advance, recording or tour cost is missing its artist." />

  const answer = async (row, recoupable) => {
    const artist = (picked[row.id] ?? row.artist_proposal ?? '').trim()
    if (recoupable && !artist) {
      toast?.error?.('Name the artist first — a recoupable advance with nobody to bill is what this list is for')
      return
    }
    setBusy(true)
    try {
      await api.post('/bk/recoup-review', {
        ids: [row.id], recoupable, ...(recoupable ? { artist } : {}),
      })
      toast?.success?.(recoupable
        ? `${usd(rowUsd(row))} now recoupable against ${artist}`
        : `${row.payee} marked not recoupable`)
      onDone()
    } catch (e) {
      toast?.error?.(e.response?.data?.error || e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="card divide-y divide-divider">
      <datalist id="audit-artists">
        {artistOptions.map((a) => <option key={a} value={a} />)}
      </datalist>
      {rows.map((r) => (
        <div key={r.id} className="p-3">
          <div className="flex items-start gap-3 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <BankEvidenceDot row={r} />
                <PayeeLink payee={r.payee} className="text-[13px] font-bold text-ink truncate" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
                  {r.category}
                </span>
              </div>
              <div className="mt-0.5 text-[11px] text-gray-400 tabular-nums">
                paid {formatDate(r.payment_date) || '—'}
                {r.currency && r.currency !== 'USD' && ` · ${r.amount} ${r.currency}`}
                {r.description && ` · ${String(r.description).slice(0, 60)}`}
              </div>
              {/* The one thing that stops this becoming a double count. */}
              {r.ledger_twin && (
                <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-rose-600">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <span>
                    {r.ledger_twin.count === 1
                      ? 'An invoice row already exists at this vendor and amount'
                      : `${r.ledger_twin.count} invoice rows already exist at this vendor and amount`}
                    {' — '}
                    {r.ledger_twin.rows.map((tw, i) => (
                      <span key={tw.id}>
                        {i > 0 && ', '}
                        <Link to={`/bk/ledger?search=${encodeURIComponent(r.payee)}`}
                          className="font-bold hover:underline">
                          #{tw.id}{tw.artist ? ` (${tw.artist})` : ''}{tw.ufr === 'Yes' ? ' claimed' : ''}
                        </Link>
                      </span>
                    ))}
                    . Match the bank line to it on{' '}
                    <Link to="/bk/statements" className="font-bold hover:underline">Bank Matching</Link>
                    {' '}rather than answering here, or the same cost is claimed twice.
                  </span>
                </div>
              )}
            </div>
            <div className="text-[15px] font-black tabular-nums text-ink whitespace-nowrap">
              {usd(rowUsd(r))}
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <input
              list="audit-artists"
              value={picked[r.id] ?? r.artist_proposal ?? ''}
              onChange={(e) => setPicked((p) => ({ ...p, [r.id]: e.target.value }))}
              placeholder="Which artist is this advance against?"
              className="flex-1 min-w-[14rem] px-2 py-1.5 text-[12.5px] border border-gray-300 rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
            />
            {/* A proposal, and it says so. The payee names the artist on 4 of the
                11 live advances; the other 7 are a person's job. */}
            {r.artist_proposal && (picked[r.id] ?? r.artist_proposal) === r.artist_proposal && (
              <span className="text-[10px] text-gray-400"
                title="Taken from the payee, which contains an artist name already used in the ledger. Nothing is written until you press the button.">
                from the payee — check it
              </span>
            )}
            <button type="button" disabled={busy} onClick={() => answer(r, true)}
              className="px-3 py-1.5 rounded-lg text-[12px] font-bold text-white bg-boom-600 hover:bg-boom-700 disabled:opacity-40">
              Recoupable
            </button>
            <button type="button" disabled={busy} onClick={() => answer(r, false)}
              title="Records the decision and clears recoupable, so the row stops claiming to be recoupable everywhere else"
              className="px-3 py-1.5 rounded-lg text-[12px] font-bold text-gray-500 border border-rule hover:text-ink hover:border-gray-300 disabled:opacity-40">
              Not recoupable
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── 2. The bank pile ─────────────────────────────────────────────────────────
function Pile({ pile, busy, setBusy, onDone, toast }) {
  const [sel, setSel] = useState(() => new Set())
  const open = (pile?.by_category || []).filter((c) => !c.ruled)
  const ruledCats = (pile?.by_category || []).filter((c) => c.ruled)
  const selUsd = useMemo(
    () => open.filter((c) => sel.has(c.category)).reduce((t, c) => t + c.usd, 0),
    [open, sel])
  const selItems = useMemo(
    () => open.filter((c) => sel.has(c.category)).reduce((t, c) => t + c.n, 0),
    [open, sel])

  const toggle = (cat) => setSel((p) => {
    const n = new Set(p); n.has(cat) ? n.delete(cat) : n.add(cat); return n
  })

  const declare = async () => {
    if (!sel.size) return
    setBusy(true)
    try {
      const { data } = await api.post('/bk/recoupment-class-rules', {
        scope: 'category', keys: [...sel],
      })
      toast?.success?.(`${data?.data?.made?.length || 0} categories marked never recoupable`)
      setSel(new Set()); onDone()
    } catch (e) {
      toast?.error?.(e.response?.data?.error || e.message)
    } finally { setBusy(false) }
  }
  const undo = async (rule) => {
    setBusy(true)
    try {
      await api.delete(`/bk/recoupment-class-rules/${rule.id}`)
      toast?.success?.(`${rule.rule_key} is back in the queue`)
      onDone()
    } catch (e) {
      toast?.error?.(e.response?.data?.error || e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      <div className="card p-3">
        <p className="text-[11.5px] text-gray-500">
          Marking a class never recoupable <b>writes nothing to the ledger</b> — it takes those rows
          out of this queue and nothing else. Deleting the rule puts them straight back. Rows that
          need a person, one at a time, are on{' '}
          <Link to="/recoupments" className="font-bold hover:underline">Recoupments</Link>.
        </p>
      </div>

      {open.length === 0 ? (
        <Clean what="Every class of bank spend has been answered or ruled out." />
      ) : (
        <div className="card overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-rule">
            <span className="text-[11px] font-bold uppercase tracking-wider text-gray-400">
              {open.length} categories · {pile.remaining_items.toLocaleString()} rows ·{' '}
              {usd(pile.remaining_usd)}
            </span>
            {sel.size > 0 && (
              <>
                <span className="text-[11px] text-gray-400 tabular-nums">
                  {sel.size} selected · {selItems.toLocaleString()} rows · {usd(selUsd)}
                </span>
                <button type="button" onClick={declare} disabled={busy}
                  className="ml-auto px-3 py-1.5 rounded-lg text-[12px] font-bold text-white bg-gray-700 hover:bg-gray-800 disabled:opacity-40">
                  Never recoupable
                </button>
              </>
            )}
          </div>
          <div className="max-h-[28rem] overflow-y-auto divide-y divide-divider">
            {open.map((c) => (
              <label key={c.category}
                className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-gray-50/60">
                <input type="checkbox" checked={sel.has(c.category)}
                  onChange={() => toggle(c.category)} className="rounded border-gray-300" />
                <span className="text-[12.5px] font-bold text-ink flex-1 truncate">{c.category}</span>
                <span className="text-[11px] text-gray-400 tabular-nums w-20 text-right">
                  {c.n.toLocaleString()} rows
                </span>
                <span className="text-[13px] font-bold tabular-nums text-ink w-28 text-right">
                  {usd(c.usd)}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {(pile?.rules || []).length > 0 && (
        <div className="card p-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-gray-400">
            Never recoupable · {pile.rules.length} rule{pile.rules.length === 1 ? '' : 's'}
            {pile.covered_items > 0 && (
              <span className="text-gray-400 font-normal normal-case tracking-normal">
                {' — '}covering {pile.covered_items.toLocaleString()} rows, {usd(pile.covered_usd)}
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {pile.rules.map((r) => (
              <span key={r.id}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-rule text-[11.5px]">
                <span className="text-gray-400">{r.scope}</span>
                <span className="font-bold text-ink">{r.rule_key}</span>
                <button type="button" onClick={() => undo(r)} disabled={busy}
                  title="Put this class back in the queue"
                  className="text-gray-400 hover:text-rose-600 disabled:opacity-40">
                  <Trash2 size={11} />
                </button>
              </span>
            ))}
          </div>
          {/* Two live categories differ only by a suffix, so the equality rule is
              worth stating where somebody is making rules. */}
          {ruledCats.length > 0 && (
            <p className="mt-2 text-[10.5px] text-gray-400">
              Rules match a category or vendor <b>exactly</b> — a rule on “Salary” does not cover
              “Salary (Felipe)”.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── 3. Possibly claimed twice ────────────────────────────────────────────────
function DoubleClaims({ groups, busy, setBusy, onDone, toast }) {
  if (!groups?.length) return <Clean what="No vendor has the same invoice number claimed twice." />

  const unclaim = async (row) => {
    setBusy(true)
    try {
      await api.post('/bk/entries/ufr-bulk', { ids: [row.id], ufr: false })
      toast?.success?.(`#${row.id} is no longer claimed for recoupment`)
      onDone()
    } catch (e) {
      toast?.error?.(e.response?.data?.error || e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={`${g.payee}|${g.invoice_number}`}
          className={`card p-3 ${g.cross_artist ? 'border-l-4 border-l-rose-500' : ''}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <PayeeLink payee={g.payee} className="text-[13px] font-bold text-ink" />
            <span className="text-[11px] text-gray-400">invoice {g.invoice_number}</span>
            <span className="text-[11px] text-gray-400">· {g.rows.length} claims</span>
            {g.cross_artist && (
              <span className="inline-flex items-center gap-1 text-[10.5px] font-bold text-rose-700">
                <AlertTriangle size={11} />
                charged to {g.artists.join(' and ')}
              </span>
            )}
            <span className="ml-auto text-[15px] font-black tabular-nums text-ink">{usd(g.usd)}</span>
          </div>
          <div className="mt-2 divide-y divide-divider">
            {g.rows.map((r) => (
              <div key={r.id} className="flex items-center gap-2 py-1.5 text-[12px]">
                <BankEvidenceDot row={r} />
                <span className="text-gray-400 tabular-nums w-14">#{r.id}</span>
                <span className="font-bold text-ink truncate flex-1">
                  {r.artist || <span className="text-gray-400">no artist</span>}
                  {r.song && <span className="text-gray-400 font-normal"> · {r.song}</span>}
                </span>
                <span className="text-gray-400 tabular-nums whitespace-nowrap">
                  {formatDate(r.invoice_date) || '—'}
                </span>
                <span className="font-bold tabular-nums w-24 text-right">{usd(rowUsd(r))}</span>
                <button type="button" onClick={() => unclaim(r)} disabled={busy}
                  title="Take this one off the recoupment claim. The other stays."
                  className="px-2 py-1 rounded-md text-[11px] font-bold text-gray-500 border border-rule hover:text-rose-600 hover:border-rose-300 disabled:opacity-40">
                  Unclaim
                </button>
              </div>
            ))}
          </div>
          {/* Said once per group, because the honest answer is often "both are
              real" and the page must not push toward unclaiming. */}
          <p className="mt-1.5 text-[10.5px] text-gray-400">
            Two deliverables billed on one invoice number are legitimate. Unclaim only the one that
            is genuinely the same cost twice.
          </p>
        </div>
      ))}
    </div>
  )
}

// ── 4. Claimed with no document ──────────────────────────────────────────────
function NoDocument({ rows, busy, setBusy, onDone, toast }) {
  if (!rows?.length) return <Clean what="Every claimed cost has an invoice on file." />

  // By artist, because that is the conversation this protects: one artist asking
  // to see what they were charged for.
  const byArtist = useMemo(() => {
    const m = new Map()
    for (const r of rows) {
      const k = (r.artist || '').trim() || '— no artist'
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(r)
    }
    return [...m.entries()]
      .map(([artist, list]) => ({ artist, list, usd: list.reduce((t, r) => t + rowUsd(r), 0) }))
      .sort((a, b) => b.usd - a.usd)
  }, [rows])

  const unclaim = async (r) => {
    setBusy(true)
    try {
      await api.post('/bk/entries/ufr-bulk', { ids: [r.id], ufr: false })
      toast?.success?.(`#${r.id} is no longer claimed for recoupment`)
      onDone()
    } catch (e) {
      toast?.error?.(e.response?.data?.error || e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      {byArtist.map((a) => (
        <div key={a.artist} className="card overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-rule">
            <span className="text-[12.5px] font-bold text-ink">{a.artist}</span>
            <span className="text-[11px] text-gray-400 tabular-nums">
              {a.list.length} item{a.list.length === 1 ? '' : 's'}
            </span>
            <span className="ml-auto text-[13px] font-black tabular-nums text-rose-700">
              {usd(a.usd)}
            </span>
          </div>
          <div className="divide-y divide-divider">
            {a.list.map((r) => (
              <div key={r.id} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
                <BankEvidenceDot row={r} />
                <PayeeLink payee={r.payee} className="font-bold text-ink truncate flex-1" />
                <span className="text-gray-400 truncate max-w-[10rem]">{r.song || r.category}</span>
                <span className="text-gray-400 tabular-nums whitespace-nowrap">
                  claimed {formatDate(r.ufr_marked_at) || '—'}
                </span>
                <span className="font-bold tabular-nums w-24 text-right">{usd(rowUsd(r))}</span>
                {/* The vendor page is where the file gets attached, so the fix is
                    one click from the finding. */}
                <Link to={`/bk/vendors/${encodeURIComponent(r.payee || '')}`} target="_blank"
                  rel="noopener noreferrer"
                  title="Open the vendor page to attach the invoice"
                  className="px-2 py-1 rounded-md text-[11px] font-bold text-gray-500 border border-rule hover:text-ink hover:border-gray-300 inline-flex items-center gap-1">
                  Attach <ExternalLink size={10} />
                </Link>
                <button type="button" onClick={() => unclaim(r)} disabled={busy}
                  title="There is no invoice and there is not going to be one — take it off the claim"
                  className="px-2 py-1 rounded-md text-[11px] font-bold text-gray-500 border border-rule hover:text-rose-600 hover:border-rose-300 disabled:opacity-40">
                  Unclaim
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── 5. Half a payment claimed ────────────────────────────────────────────────
function PartialFamilies({ families, busy, setBusy, onDone, toast }) {
  if (!families?.length) return <Clean what="No split payment is part-claimed." />

  const claimRest = async (f) => {
    setBusy(true)
    try {
      const { data } = await api.post('/bk/entries/ufr-bulk', { ids: f.open_ids, ufr: true })
      toast?.success?.(`${data?.data?.changed ?? f.open_ids.length} more slices claimed for ${f.payee}`)
      onDone()
    } catch (e) {
      toast?.error?.(e.response?.data?.error || e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      {families.map((f) => (
        <div key={f.root_id} className="card p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <PayeeLink payee={f.payee} className="text-[13px] font-bold text-ink" />
            {f.artist && <span className="text-[11px] text-gray-400">{f.artist}</span>}
            <span className="text-[11px] text-gray-400">
              · payment #{f.root_id} split {f.members.length} ways
            </span>
            <div className="ml-auto text-right">
              <div className="text-[15px] font-black tabular-nums text-amber-700">
                {usd(f.open_usd)}
              </div>
              <div className="text-[10px] text-gray-400 tabular-nums">
                not claimed · {usd(f.claimed_usd)} was
              </div>
            </div>
          </div>
          <div className="mt-2 divide-y divide-divider">
            {f.members.map((m) => (
              <div key={m.id} className="flex items-center gap-2 py-1.5 text-[12px]">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  m.ufr === 'Yes' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                <span className="text-gray-400 tabular-nums w-14">
                  #{m.id}{m.parent_id ? '' : ' root'}
                </span>
                <span className="truncate flex-1 text-ink">
                  {m.song || m.category || '—'}
                </span>
                <span className={`text-[10.5px] font-bold uppercase tracking-wider ${
                  m.ufr === 'Yes' ? 'text-emerald-700' : 'text-amber-700'}`}>
                  {m.ufr === 'Yes' ? 'claimed' : 'not claimed'}
                </span>
                <span className="font-bold tabular-nums w-24 text-right">{usd(rowUsd(m))}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button type="button" onClick={() => claimRest(f)} disabled={busy}
              className="px-3 py-1.5 rounded-lg text-[12px] font-bold text-white bg-boom-600 hover:bg-boom-700 disabled:opacity-40">
              Claim the other {f.open_ids.length} {f.open_ids.length === 1 ? 'slice' : 'slices'}
            </button>
            <Link to={`/recoupments/${encodeURIComponent(f.artist || '')}`}
              className="text-[11.5px] font-bold text-gray-500 hover:text-ink inline-flex items-center gap-1">
              Open {f.artist || 'the artist'} <ChevronRight size={12} />
            </Link>
            <span className="ml-auto text-[10.5px] text-gray-400">
              Claiming stamps each slice with today’s date, so they land on this month’s statement.
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
