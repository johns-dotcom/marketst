// Artist budgets — a card per artist, that artist's planned campaigns inside it.
//
// John, 2026-09-03: "this should replace the artist budgets sheet (and look like
// a budget sheet: individual artist cards with planned campaign budgets inside
// of them), not live inside imports."
//
// ── Why this replaced the table ──
// The old index had a Budget column and it was EMPTY for all 152 artists —
// `artist_budget_sections` had never been filled in, the fourth budget attempt
// to die at a setup step. The marketing spend sheet is the first thing in this
// app that carries real planned numbers ($4,952,054.13 across 1,373 releases),
// so the budget half of this page now comes from there instead of from a form
// nobody completed.
//
// ── Three figures, never blended ──
//   PLANNED     the sheet's printed total for that artist's campaigns
//   STILL OWED  its lines marked "not yet"
//   PAID        what `expenses` actually recorded against those releases
// They disagree on every release where both have data, so the card shows all
// three and computes no combined number. See routes/spend-plans.js.
//
// ── Nobody disappears ──
// An artist with ledger spend and no campaign on the sheet is still listed,
// with an empty planned figure — the same principle the old page had, and the
// reason it listed 91 artists who had never had a budget. Dropping them would
// make this page answer "who is on the spreadsheet" instead of "what are we
// spending per artist".

import { useEffect, useMemo, useState, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Search, AlertCircle, X, RefreshCw, ChevronDown, ChevronRight, Upload, FileSpreadsheet, CheckCircle2, Loader, Plus } from 'lucide-react'
import api from '../api'
import PageHeader from '../components/PageHeader'
import Skeleton from '../components/Skeleton'
import { QueueRow, Stat } from '../components/SpendSheetPanels'
import ArtistSelect from '../components/ArtistSelect'
import useArtistNames from '../hooks/useArtistNames'
import { artistBucket } from '../utils'

const usd = (v) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
}).format(Number(v) || 0)

const usd2 = (v) => `$${Number(v || 0).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
})}`

// ── One artist ───────────────────────────────────────────────────────────────
function ArtistCard({ a }) {
  const [open, setOpen] = useState(false)
  const campaigns = a.campaigns || []
  const shown = open ? campaigns : campaigns.slice(0, 4)
  const hasPlan = a.planned > 0

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <Link
            to={`/artist-budgets/${encodeURIComponent(a.artist_key)}`}
            className="font-bold text-ink hover:text-boom-600 hover:underline text-[15px]"
          >
            {a.artist}
          </Link>
          <p className="text-[11px] text-gray-400 mt-0.5">
            {a.campaign_count
              ? `${a.campaign_count} campaign${a.campaign_count === 1 ? '' : 's'} on the sheet`
              : 'no campaigns on the sheet'}
          </p>
        </div>
        {a.owed > 0 && (
          <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full whitespace-nowrap">
            {usd(a.owed)} owed
          </span>
        )}
      </div>

      {/* Two shapes, because there are two kinds of card and one set of headings
          cannot describe both. With a plan, "Paid" means paid ON THOSE
          CAMPAIGNS and is comparable to Planned. Without one there is nothing to
          compare against, so the card shows the artist's ledger spend under its
          own label rather than borrowing a heading that would imply a plan. */}
      {hasPlan ? (
        <div className="grid grid-cols-3 gap-2 mb-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Planned</p>
            <p className="text-[15px] font-bold text-ink tabular-nums">{usd(a.planned)}</p>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Still owed</p>
            <p className={`text-[15px] font-bold tabular-nums ${a.owed > 0 ? 'text-amber-700' : 'text-gray-300'}`}>
              {a.owed > 0 ? usd(a.owed) : '—'}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400"
              title="Paid on this artist's planned campaigns — not their whole ledger.">
              Paid
            </p>
            <p className="text-[15px] font-bold text-ink tabular-nums">{usd(a.ledger_paid)}</p>
          </div>
        </div>
      ) : (
        <div className="mb-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Ledger spend</p>
          <p className="text-[15px] font-bold text-ink tabular-nums">{usd(a.artist_total_spent || 0)}</p>
          <p className="text-[10px] text-gray-400 mt-0.5">
            nothing planned for this artist on the sheet
            {a.artist_total_open > 0 && <> · {usd(a.artist_total_open)} unpaid</>}
          </p>
        </div>
      )}

      {/* Spend outside the plan is worth seeing on a budget card: it is money on
          this artist that no campaign accounts for. */}
      {hasPlan && a.artist_total_spent > a.ledger_paid + 0.5 && (
        <p className="text-[10px] text-gray-400 -mt-2 mb-3">
          {usd(a.artist_total_spent - a.ledger_paid)} more ledger spend on this artist
          sits outside these campaigns
        </p>
      )}

      {/* Progress is paid AGAINST PLANNED, and only when there is a plan to
          measure against. A bar with no denominator would imply one. */}
      {hasPlan && (
        <div className="mb-3">
          <div className="flex h-1.5 rounded-full overflow-hidden bg-gray-100">
            <span className="bg-emerald-500" style={{ width: `${a.paid_pct || 0}%` }} />
          </div>
          <p className="mt-1 text-[10px] text-gray-400 tabular-nums">
            {a.paid_pct}% of the plan paid
            {a.ledger_open > 0 && <> · {usd(a.ledger_open)} in unpaid invoices</>}
          </p>
        </div>
      )}

      {campaigns.length > 0 && (
        <div className="border-t border-divider pt-2">
          <table className="w-full text-[12px]">
            <tbody>
              {shown.map((c) => (
                <tr key={c.plan_id} className="border-b border-divider last:border-0">
                  <td className="py-1 pr-2">
                    <Link
                      to={`/releases?search=${encodeURIComponent(c.title || '')}`}
                      className="text-gray-700 hover:text-boom-600 hover:underline"
                    >
                      {c.title || <em className="text-gray-400">untitled</em>}
                    </Link>
                  </td>
                  <td className="py-1 text-right tabular-nums text-ink w-24">{usd2(c.planned)}</td>
                  <td className="py-1 text-right tabular-nums w-24">
                    {c.owed > 0
                      ? <span className="text-amber-700">{usd2(c.owed)} owed</span>
                      : <span className="text-emerald-600">paid</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {campaigns.length > 4 && (
            <button
              onClick={() => setOpen((o) => !o)}
              className="mt-2 text-[11px] text-gray-500 hover:text-gray-700 inline-flex items-center gap-1"
            >
              {open
                ? <><ChevronDown size={12} /> Show fewer</>
                : <><ChevronRight size={12} /> {campaigns.length - 4} more</>}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Upload ───────────────────────────────────────────────────────────────────
function ImportPanel({ onImported }) {
  const [file, setFile] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [phase, setPhase] = useState('idle')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  const post = async (f, apply) => {
    const fd = new FormData()
    fd.append('file', f)
    const { data } = await api.post(`/spend-plans/import${apply ? '?apply=1' : ''}`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    if (!data?.success) throw new Error(data?.error || 'Failed')
    return data.data
  }

  const pick = async (f) => {
    setError('')
    if (!f) return
    if (!f.name.toLowerCase().endsWith('.xlsx')) { setError('Please upload an .xlsx file.'); return }
    setFile(f); setPhase('parsing')
    try { setResult(await post(f, false)); setPhase('preview') }
    catch (e) { setError(e.response?.data?.error || e.message); setPhase('idle') }
  }

  const apply = async () => {
    const s = result.stats
    if (!confirm(
      `Import ${s.blocks} release blocks and ${s.lines} expense lines (${usd2(s.sheetTotal)})?\n\n` +
      `${s.matched} link to a release automatically; ${s.blocks - s.matched} go to the queue.\n\n` +
      `This writes NOTHING to the expense ledger.`
    )) return
    setPhase('applying')
    try { setResult(await post(file, true)); setPhase('done'); onImported?.() }
    catch (e) { setError(e.response?.data?.error || e.message); setPhase('preview') }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700">
          <AlertCircle size={15} className="mt-0.5" /><span className="flex-1">{error}</span>
          <button onClick={() => setError('')}><X size={13} /></button>
        </div>
      )}

      {phase === 'idle' && (
        <label
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); pick(e.dataTransfer.files?.[0]) }}
          className={`block rounded-lg border-2 border-dashed p-10 text-center cursor-pointer transition ${
            dragOver ? 'border-boom-500 bg-boom-50' : 'border-rule hover:border-gray-400'
          }`}
        >
          <FileSpreadsheet className="mx-auto text-gray-400 mb-3" size={30} />
          <p className="text-[13px] font-bold text-gray-700">Drop the expense sheet .xlsx here</p>
          <p className="text-[11.5px] text-gray-400 mt-1">
            Reads the <span className="font-mono">Expenses</span> tab. Nothing is written until you confirm,
            and nothing is ever written to the ledger.
          </p>
          <input type="file" accept=".xlsx" className="hidden"
            onChange={(e) => pick(e.target.files?.[0])} />
        </label>
      )}

      {(phase === 'parsing' || phase === 'applying') && (
        <div className="card p-10 text-center">
          <Loader className="mx-auto animate-spin text-gray-400 mb-3" size={26} />
          <p className="text-[12.5px] text-gray-500">
            {phase === 'parsing' ? 'Reading the sheet…' : 'Importing…'}
          </p>
        </div>
      )}

      {result && (phase === 'preview' || phase === 'done') && (
        <>
          {phase === 'done' && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800">
              <CheckCircle2 size={15} />
              Imported — {result.written.plansInserted} new, {result.written.plansUpdated} updated,
              {' '}{result.written.linesWritten} lines. The ledger was not touched.
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Release blocks" value={result.stats.blocks} />
            <Stat label="Expense lines" value={result.stats.lines} />
            <Stat label="Sheet total" value={usd2(result.stats.sheetTotal)} />
            <Stat label="Links automatically" value={result.stats.matched}
              hint={`${result.stats.blocks - result.stats.matched} to the queue`} />
          </div>
          <div className="card p-4">
            <h3 className="text-[13px] font-bold text-ink mb-2">Reported, not corrected</h3>
            <ul className="text-[11.5px] text-gray-600 space-y-1">
              <li>{result.stats.totalDisagreements} printed totals disagree with their own lines</li>
              <li>{result.stats.derivedTotals} totals came from a formula with no stored value</li>
              <li>{result.stats.nonNumericAmounts} amount cells hold text instead of a number</li>
              <li className="text-gray-400 pt-1">
                Recoupability is not in this file — the “Red = Non Recoup” legend was used once in
                the whole workbook — so it is not imported.
              </li>
            </ul>
          </div>
          <div className="flex items-center gap-2">
            {phase === 'preview' && (
              <button onClick={apply} className="btn-primary inline-flex items-center gap-1.5 text-[12.5px]">
                <Upload size={14} /> Import {result.stats.blocks} blocks
              </button>
            )}
            <button
              onClick={() => { setFile(null); setResult(null); setPhase('idle'); setError('') }}
              className="text-[12.5px] px-3 py-1.5 rounded-lg border border-rule text-gray-600 hover:bg-gray-100"
            >
              {phase === 'done' ? 'Import another' : 'Cancel'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
// Start a budget by hand. John, 2026-09-18: "I want users to be able to
// manually add artist budgets." Until now the only way onto this page was the
// imported marketing sheet — an artist with no block on it had no card, and a
// label with no sheet had no page.
//
// There is nothing to CREATE here, on purpose: a sheet exists for every artist
// key, and typing in a category cell is what makes the budget (see the sheet's
// header note on why "create a budget" is where this feature died three times
// at Boom). So this only asks WHO, then opens their sheet. The picker is the
// roster ∪ the names already on the ledger, typable — an off-roster name is
// allowed, exactly as on every other artist field.
function NewBudgetModal({ onClose }) {
  const navigate = useNavigate()
  const names = useArtistNames()
  const [name, setName] = useState('')
  const key = artistBucket(name)
  const go = () => {
    if (!key) return
    onClose()
    navigate(`/artist-budgets/${encodeURIComponent(key)}?name=${encodeURIComponent(name.trim())}`)
  }
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-overlay" onClick={onClose}>
      <div className="card p-5 w-full max-w-md space-y-4" onClick={(e) => e.stopPropagation()} data-modal="new-budget">
        <div>
          <h2 className="text-[15px] font-bold text-ink">New budget</h2>
          <p className="text-[12px] text-gray-500 mt-1">
            Pick an artist. Their sheet opens with every category as a row — type a budget in any cell and it is saved.
          </p>
        </div>
        <ArtistSelect value={name} onChange={setName} options={names} placeholder="Artist…" allowClear={false}
          className="w-full" />
        {name && !key && (
          <p className="text-[12px] text-rose-600">"{name}" is a placeholder, not an artist.</p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose}
            className="text-[12.5px] px-3 py-1.5 rounded-lg border border-rule text-gray-600 hover:bg-gray-100">Cancel</button>
          <button type="button" onClick={go} disabled={!key}
            className="btn-primary text-[12.5px] px-3 py-1.5 disabled:opacity-50">Open sheet</button>
        </div>
      </div>
    </div>
  )
}

export default function ArtistBudgets() {
  const [newBudget, setNewBudget] = useState(false)
  const [tab, setTab] = useState('budgets')
  const [data, setData] = useState(null)
  const [ledger, setLedger] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('planned')
  const [queue, setQueue] = useState([])
  const [queueTotal, setQueueTotal] = useState(0)
  const [queueLoading, setQueueLoading] = useState(false)
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    // Both, because they answer different halves. by-artist has the plan and the
    // spend on the linked releases; /artist-budgets has each artist's TOTAL
    // ledger spend, which is what keeps an artist with no campaign on the sheet
    // from vanishing off this page.
    Promise.all([
      api.get('/spend-plans/by-artist').then(r => r.data?.data).catch(() => null),
      api.get('/artist-budgets').then(r => r.data?.data).catch(() => null),
    ])
      .then(([plans, led]) => { setData(plans); setLedger(led) })
      .catch((e) => setErr(e.response?.data?.error || e.message))
      .finally(() => setLoading(false))
  }, [])

  const loadQueue = useCallback(() => {
    setQueueLoading(true)
    api.get('/spend-plans/queue', { params: { limit: 50 } })
      .then((r) => { setQueue(r.data?.data || []); setQueueTotal(r.data?.total || 0) })
      .catch((e) => setErr(e.response?.data?.error || e.message))
      .finally(() => setQueueLoading(false))
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (tab === 'queue') loadQueue() }, [tab, loadQueue])

  // Merge the two sources on artist_key — both sides key with artistBucketKey,
  // so an artist present in either appears exactly once.
  const rows = useMemo(() => {
    const byKey = new Map()
    for (const a of data?.artists || []) byKey.set(a.artist_key, { ...a })
    for (const l of ledger?.artists || []) {
      const cur = byKey.get(l.artist_key)
      if (cur) { cur.artist_total_spent = l.spent; cur.artist_total_open = l.open }
      else {
        // ledger_paid stays ZERO here, deliberately. On every other card it
        // means "paid on this artist's planned campaigns"; putting the artist's
        // WHOLE ledger spend in it gave one column two meanings and made the
        // "most paid" sort compare unlike things. The total is carried
        // separately and the card labels it as what it is.
        byKey.set(l.artist_key, {
          artist_key: l.artist_key, artist: l.artist, campaigns: [], campaign_count: 0,
          planned: 0, owed: 0, sheet_paid: 0, ledger_paid: 0, ledger_open: 0,
          paid_pct: null, artist_total_spent: l.spent, artist_total_open: l.open,
        })
      }
    }
    const list = [...byKey.values()]
      .filter((a) => !q.trim() || a.artist.toLowerCase().includes(q.trim().toLowerCase()))
    const by = {
      planned: (a, b) => b.planned - a.planned,
      owed: (a, b) => b.owed - a.owed,
      paid: (a, b) => b.ledger_paid - a.ledger_paid,
      campaigns: (a, b) => b.campaign_count - a.campaign_count,
      name: (a, b) => a.artist.localeCompare(b.artist),
    }
    return list.sort(by[sort] || by.planned)
  }, [data, ledger, q, sort])

  // Totals are reduced over the SAME rows the grid renders, never over one of
  // the two sources. The header used to print /by-artist's figures — 341
  // artists — above a grid showing 403, because the 62 artists with ledger
  // spend and no campaign are merged in below.
  const t = useMemo(() => rows.reduce((acc, a) => ({
    artists: acc.artists + 1,
    campaigns: acc.campaigns + a.campaign_count,
    planned: acc.planned + a.planned,
    owed: acc.owed + a.owed,
    ledger_paid: acc.ledger_paid + a.ledger_paid,
    with_plan: acc.with_plan + (a.planned > 0 ? 1 : 0),
  }), { artists: 0, campaigns: 0, planned: 0, owed: 0, ledger_paid: 0, with_plan: 0 }), [rows])
  const unlinked = data?.unlinked

  const act = async (plan, fn) => {
    setBusyId(plan.id)
    try {
      await fn()
      setQueue((qq) => qq.filter((p) => p.id !== plan.id))
      setQueueTotal((n) => Math.max(0, n - 1))
      load()
    } catch (e) {
      setErr(e.response?.data?.error || 'That did not save.')
    } finally { setBusyId(null) }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Artist budgets"
        subtitle="What each artist was budgeted, what is still owed, and what the ledger actually paid. Type a budget on an artist's sheet, or import the marketing spend sheet."
        actions={
          <>
            <button onClick={load}
              className="text-[12.5px] px-3 py-1.5 rounded-lg border border-rule text-gray-600 hover:bg-gray-100 inline-flex items-center gap-1.5">
              <RefreshCw size={13} /> Refresh
            </button>
            <button onClick={() => setNewBudget(true)} data-action="new-budget"
              className="btn-primary text-[12.5px] px-3 py-1.5 inline-flex items-center gap-1.5">
              <Plus size={13} /> New budget
            </button>
          </>
        }
      />
      {newBudget && <NewBudgetModal onClose={() => setNewBudget(false)} />}

      {err && (
        <div className="card p-3 border-l-4 border-l-rose-500 flex items-start gap-2">
          <p className="text-[12.5px] font-bold text-rose-600 flex-1">{err}</p>
          <button onClick={() => setErr('')}><X size={13} /></button>
        </div>
      )}

      {!loading && (
        <div className="card p-3">
          <p className="text-[12px] text-gray-500">
            <b className="text-ink tabular-nums">{t.artists}</b> artists ·{' '}
            <b className="text-ink tabular-nums">{t.campaigns}</b> campaigns ·{' '}
            <b className="text-ink tabular-nums">{usd(t.planned)}</b> planned ·{' '}
            <b className="text-amber-700 tabular-nums">{usd(t.owed)}</b> still owed ·{' '}
            <b className="text-ink tabular-nums">{usd(t.ledger_paid)}</b> paid on those campaigns
            {t.artists > t.with_plan && (
              <span className="text-gray-400">
                {' · '}{t.artists - t.with_plan} with ledger spend and nothing on the sheet
              </span>
            )}
          </p>
        </div>
      )}

      {/* The queue is the page's own backlog, so it is stated here rather than
          hidden behind a tab nobody opens. */}
      {unlinked?.count > 0 && tab !== 'queue' && (
        <div className="card p-3 border-l-4 border-l-amber-500 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-[12.5px] text-gray-600">
            <b className="text-amber-700 tabular-nums">{unlinked.count}</b> blocks from the sheet
            are not linked to a release yet — <b className="tabular-nums">{usd(unlinked.total)}</b> that
            no artist card can show.
          </p>
          <button onClick={() => setTab('queue')}
            className="btn-primary text-[12px] px-3 py-1.5">Review them</button>
        </div>
      )}

      <div className="flex gap-1 border-b border-divider">
        {[
          ['budgets', 'Budgets'],
          ['queue', `Unlinked${unlinked?.count ? ` (${unlinked.count})` : ''}`],
          ['import', 'Import sheet'],
        ].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-3 py-2 text-[12.5px] font-bold border-b-2 -mb-px ${
              tab === k ? 'border-boom-600 text-ink' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>{label}</button>
        ))}
      </div>

      {tab === 'budgets' && (
        <>
          <div className="card p-3 flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[12rem]">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)}
                placeholder="Find an artist…"
                className="w-full pl-8 pr-2 py-1.5 text-[12.5px] border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400" />
            </div>
            <select value={sort} onChange={(e) => setSort(e.target.value)}
              className="px-2 py-1.5 text-[12px] border border-rule rounded-lg bg-card">
              <option value="planned">Sort: biggest plan</option>
              <option value="owed">Sort: most owed</option>
              <option value="paid">Sort: most paid</option>
              <option value="campaigns">Sort: most campaigns</option>
              <option value="name">Sort: name</option>
            </select>
          </div>

          {loading ? (
            <Skeleton.StatCards count={3} />
          ) : rows.length === 0 ? (
            <div className="card p-8 text-center">
              {data?.totals?.artists || ledger?.totals?.artists ? (
                <p className="text-[12.5px] text-gray-500">No artist matches.</p>
              ) : (
                <div className="space-y-3">
                  <p className="text-[12.5px] text-gray-500">
                    No budgets yet. Start one by hand, or import the marketing spend sheet from the Import sheet tab.
                  </p>
                  <button onClick={() => setNewBudget(true)} data-action="new-budget-empty"
                    className="btn-primary text-[12.5px] px-3 py-1.5 inline-flex items-center gap-1.5">
                    <Plus size={13} /> New budget
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {rows.map((a) => <ArtistCard key={a.artist_key} a={a} />)}
            </div>
          )}
        </>
      )}

      {tab === 'queue' && (
        queueLoading ? <Skeleton.Table rows={5} /> : (
          <div className="space-y-3">
            {queue.length === 0 ? (
              <div className="card p-8 text-center">
                <CheckCircle2 className="mx-auto text-emerald-500 mb-2" size={26} />
                <p className="text-[12.5px] text-gray-500">Nothing left to link.</p>
              </div>
            ) : (
              <>
                {queue.map((p) => (
                  <QueueRow key={p.id} plan={p} busy={busyId === p.id}
                    onLink={(plan, releaseId) =>
                      act(plan, () => api.post(`/spend-plans/${plan.id}/link`, { release_id: releaseId }))}
                    onSkip={(plan) => act(plan, () => api.post(`/spend-plans/${plan.id}/skip`))} />
                ))}
                {queueTotal > queue.length && (
                  <p className="text-[11px] text-gray-400 text-center py-2">
                    Showing {queue.length} of {queueTotal} — answer these and refresh for the next batch.
                  </p>
                )}
              </>
            )}
          </div>
        )
      )}

      {tab === 'import' && <ImportPanel onImported={() => { load(); loadQueue() }} />}
    </div>
  )
}
