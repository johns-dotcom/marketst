// One artist's spend sheet, as a grid you can type in.
//
// ── The budget is the category rows, and that IS the creation flow ──
// There is no "create a budget" step, because that is where this feature has died
// three times: all 7 `recording_budgets` are drafts with ZERO line items (five
// created inside 40 minutes), and `artist_budget_items` holds one row across the
// twelve biggest-spending artists. Every row is already on screen with its
// actuals beside it. Type a number into one and the sheet has a budget. Clear it
// and it doesn't.
//
// John, 2026-09-15: "it should look more spreadsheet like" — and the budget moved
// one level down with it: "the section total is the sum of its children and stops
// being typed directly." So the section BUDGET cell is not an input any more. It
// is the sum of the cells underneath it, computed on the server, and the only way
// to change it is to change one of them.
//
// Measured before the move: `artist_budget_sections` held ZERO rows across all
// 156 artists, so there was no budget anywhere to migrate. A section row that
// turns up anyway is still counted, labelled `legacy`.
//
// ── What "spreadsheet" is made of here ──
//   one column set        BUDGET · SPENT · OPEN · COMMITTED · VARIANCE · % on
//                         every row at every level, so a column means one thing
//   frozen edges          header, totals row and the label column stay put
//   keyboard              ↑ ↓ Enter Tab move between cells, Esc reverts
//   paste                 a column copied out of Excel fills the cells below,
//                         after showing you what it is about to change
//   sort and filter       by any column, and the totals row reduces over the
//                         rows you can actually see — never over the full set
//
// ── The four states ──
// John: "if an item is marked as paid but its statement hasn't been uploaded yet,
// it should be noted that it's paid but not confirmed done."
//
// That is `recoupState()` from utils — reused, not re-implemented, so this page
// and Recoupments can never disagree about the same row:
//
//   verified            the bank shows it
//   awaiting_statement  paid, no uploaded statement covers the date — "not
//                       confirmed done"
//   unverified          paid, a statement DOES cover it, nothing matches. A
//                       discrepancy, not a waiting state.
//   unpaid              an invoice nobody has paid

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, Download, Loader, AlertTriangle, ChevronDown, ChevronRight,
  ArrowUp, ArrowDown, ClipboardPaste, X, Keyboard,
} from 'lucide-react'
import api from '../api'
import PageHeader from '../components/PageHeader'
import Skeleton from '../components/Skeleton'
import Breadcrumb from '../components/Breadcrumb'
import PayeeLink from '../components/PayeeLink'
import BankEvidenceDot from '../components/BankEvidenceDot'
import { useToast } from '../context/ToastContext'
import { formatDate, recoupState } from '../utils'

const usd = (v) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2,
}).format(Number(v) || 0)
const usd0 = (v) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
}).format(Number(v) || 0)
// A grid reads better with holes than with zeros: the eye should land on the
// cells that carry money.
const money = (v) => (Math.abs(Number(v) || 0) < 0.005 ? '—' : usd(v))

const STATE = {
  verified: { label: 'confirmed', cls: 'text-emerald-700',
    tip: 'A bank statement shows this payment.' },
  awaiting_statement: { label: 'paid, not confirmed', cls: 'text-sky-600',
    tip: 'Marked paid, but no uploaded statement covers that date yet — so nothing proves it went out.' },
  unverified: { label: 'no bank line', cls: 'text-rose-600',
    tip: 'Marked paid, and a statement DOES cover that date, but no line on it matches. Either the payment did not happen or the match is missing.' },
  unpaid: { label: 'unpaid', cls: 'text-gray-400',
    tip: 'An invoice that has not been paid.' },
}

const FILTERS = [
  ['all', 'All rows'],
  ['money', 'Only rows with money'],
  ['over', 'Over budget'],
  ['unplanned', 'Unplanned spend'],
  ['open', 'Has open invoices'],
  ['budgeted', 'Budgeted'],
]

const matchesFilter = (c, f) => {
  if (f === 'money') return c.budget > 0 || c.committed > 0
  if (f === 'over') return c.budget > 0 && c.variance < 0
  if (f === 'unplanned') return c.unplanned
  if (f === 'open') return c.open > 0
  if (f === 'budgeted') return c.budget > 0
  return true
}

// The columns, in one place, because the header, the body, the footer and the
// keyboard order all have to agree about them.
const COLS = [
  { key: 'budget', label: 'Budget' },
  { key: 'spent', label: 'Spent' },
  { key: 'open', label: 'Open' },
  { key: 'committed', label: 'Committed' },
  { key: 'variance', label: 'Variance' },
  { key: 'pct', label: '%' },
]

const catKeyOf = (c) => `${c.section}||${c.category}`

/**
 * A number as Excel hands it over: "$1,200.00", "1,200", "(500)", "", "-".
 *
 * Returns null for anything that is not a number, which the paste preview shows
 * as a skipped row rather than as a zero. A silent zero would clear a budget
 * because one cell in the copied column held a label.
 */
function parseCell(raw) {
  const s = String(raw ?? '').trim()
  if (!s || s === '-' || s === '—') return 0
  const neg = /^\(.*\)$/.test(s)
  const n = Number(s.replace(/[()$,\s]/g, ''))
  if (!Number.isFinite(n)) return null
  return neg ? -n : n
}

export default function ArtistBudgetSheet() {
  const { artistKey } = useParams()
  // "New budget" passes the spelling it was opened with. The server names a
  // sheet from its ledger rows, then the roster; an off-roster name with no
  // spend yet has neither, and would otherwise be titled by its key.
  const [searchParams] = useSearchParams()
  const openedAs = searchParams.get('name') || ''
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [drafts, setDrafts] = useState({})
  const [saving, setSaving] = useState('')
  const [openSections, setOpenSections] = useState(null)
  const [openCats, setOpenCats] = useState(() => new Set())
  const [filter, setFilter] = useState('all')
  // ── Which way the sheet is sliced ──────────────────────────────────────────
  // John, 2026-09-15: "the budgets should be artist based but also release
  // based." Both, and they are two PARTITIONS of one artist's money rather than
  // one being a subdivision of the other — so each stores its own budget and the
  // header states both totals when they differ. Picking a winner quietly is how
  // a page ends up disagreeing with itself.
  //
  // The original spreadsheet plans per release: its Expenses tab is one block
  // per release, and its hidden Accounting tab is Artist | Project | Planned
  // Marketing | Amount Spent | Amount remaining.
  const [grain, setGrain] = useState('category')
  const [sort, setSort] = useState(null)       // { col, dir } — null is sheet order
  const [paste, setPaste] = useState(null)     // the preview, before anything is written
  // The planned campaigns from the marketing spend sheet. Fetched apart from the
  // sheet itself so a missing or empty plan never blocks the page that existed
  // before it — the campaigns block simply does not render.
  const [campaigns, setCampaigns] = useState(null)
  const toast = useToast()

  // Escape has to beat the blur that follows it. Setting the draft back and then
  // blurring races React's re-render, so the input still holds the typed text
  // when onBlur reads it — this flag makes the save skip instead.
  const escaped = useRef(false)
  const inputs = useRef(new Map())

  const load = async () => {
    try {
      const r = await api.get(`/artist-budgets/${encodeURIComponent(artistKey)}`)
      setData(r.data?.data || null)
    } catch (e) {
      setErr(e.response?.data?.error || e.message)
    } finally { setLoading(false) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [artistKey])

  useEffect(() => {
    let alive = true
    api.get('/spend-plans/by-artist', { params: { artist_key: artistKey } })
      .then((r) => { if (alive) setCampaigns((r.data?.data?.artists || [])[0] || null) })
      .catch(() => { if (alive) setCampaigns(null) })
    return () => { alive = false }
  }, [artistKey])

  // Open the sections that have something in them. An artist with nothing at all
  // gets every section open instead of a page of six closed rows — that artist is
  // exactly the one who is here to type a budget.
  useEffect(() => {
    if (!data || openSections) return
    const live = data.sections.filter((s) => s.budget > 0 || s.committed > 0).map((s) => s.key)
    setOpenSections(new Set(live.length ? live : data.sections.map((s) => s.key)))
  }, [data, openSections])

  const isOpen = (key) => !openSections || openSections.has(key)
  const toggleSection = (key) => setOpenSections((prev) => {
    const next = new Set(prev || [])
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const toggleCat = (key) => setOpenCats((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  // ── What is on screen ──────────────────────────────────────────────────────
  // Built once, and used for three things that must not disagree: the rows, the
  // totals row, and the order the keyboard walks in.
  const view = useMemo(() => {
    if (!data) return { sections: [], cells: [], filtered: false, shown: 0, total: 0 }
    const dir = sort?.dir === 'asc' ? 1 : -1
    const cmp = (a, b) => {
      if (!sort) return 0
      if (sort.col === 'name') return String(a.category || a.label).localeCompare(String(b.category || b.label)) * dir
      const av = Number(a[sort.col] ?? 0); const bv = Number(b[sort.col] ?? 0)
      return (av - bv) * dir
    }
    let shown = 0; let total = 0
    const sections = data.sections.map((s) => {
      total += s.categories.length
      const cats = s.categories.filter((c) => matchesFilter(c, filter)).sort(cmp)
      shown += cats.length
      return { ...s, cats }
    }).filter((s) => (
      // A section survives if it still has a row under it, or if it carries a
      // legacy budget of its own that would otherwise vanish off the sheet.
      s.cats.length > 0 || s.legacy_budget > 0
    )).sort(cmp)

    // Keyboard order is exactly what is rendered, open sections only — walking
    // into a cell you cannot see is how a budget gets typed into the wrong row.
    const cells = []
    for (const s of sections) {
      if (!isOpen(s.key)) continue
      for (const c of s.cats) cells.push(catKeyOf(c))
    }
    return { sections, cells, filtered: filter !== 'all', shown, total }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [data, filter, sort, openSections])

  // The release grain, filtered and sorted by the same controls. The residual
  // row is appended last and never filtered out: it is the money that has no
  // release, and a view that dropped it would report a third of the artist and
  // look complete.
  const releaseView = useMemo(() => {
    if (!data) return { rows: [], residual: null, shown: 0, total: 0 }
    const dir = sort?.dir === 'asc' ? 1 : -1
    const rows = (data.releases || [])
      .filter((r) => matchesFilter(r, filter))
      .sort((a, b) => {
        if (!sort) return 0
        if (sort.col === 'name') return String(a.title).localeCompare(String(b.title)) * dir
        return ((Number(a[sort.col] ?? 0)) - (Number(b[sort.col] ?? 0))) * dir
      })
    return {
      rows,
      residual: data.unassigned_release || null,
      shown: rows.length,
      total: (data.releases || []).length,
    }
  }, [data, filter, sort])

  // Totals reduce over the ROWS ON SCREEN. With no filter this equals the
  // server's own totals; with one it must not, and saying so is the difference
  // between a subtotal and a number that looks wrong.
  const shownTotals = useMemo(() => {
    const t = { budget: 0, spent: 0, open: 0, committed: 0 }
    for (const s of view.sections) {
      for (const c of s.cats) {
        t.budget += c.budget; t.spent += c.spent; t.open += c.open; t.committed += c.committed
      }
      t.budget += s.legacy_budget || 0
    }
    const r2 = (n) => Math.round(n * 100) / 100
    return {
      budget: r2(t.budget), spent: r2(t.spent), open: r2(t.open), committed: r2(t.committed),
      variance: r2(t.budget - t.spent),
      pct: t.budget > 0 ? Math.round((t.spent / t.budget) * 100) : null,
    }
  }, [view])

  // What the release grain adds up to, over the rows on screen — the residual
  // included, because it is money this artist spent.
  const releaseTotals = useMemo(() => {
    const t = { budget: 0, spent: 0, open: 0, committed: 0 }
    for (const r of releaseView.rows) {
      t.budget += r.budget; t.spent += r.spent; t.open += r.open; t.committed += r.committed
    }
    const res = releaseView.residual
    if (res) { t.spent += res.spent; t.open += res.open; t.committed += res.committed }
    const r2 = (n) => Math.round(n * 100) / 100
    return {
      budget: r2(t.budget), spent: r2(t.spent), open: r2(t.open), committed: r2(t.committed),
      variance: r2(t.budget - t.spent),
      pct: t.budget > 0 ? Math.round((t.spent / t.budget) * 100) : null,
    }
  }, [releaseView])

  const rowsByCategory = useMemo(() => {
    const m = new Map()
    for (const r of data?.rows || []) {
      const key = `${r.section}||${r.budget_category}`
      if (!m.has(key)) m.set(key, [])
      m.get(key).push(r)
    }
    return m
  }, [data])

  // ── Writes ─────────────────────────────────────────────────────────────────
  const budgetOf = useCallback((key) => {
    for (const s of data?.sections || []) {
      for (const c of s.categories) if (catKeyOf(c) === key) return c.budget
    }
    return 0
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [data])

  // Saved on blur, and only when the number actually changed — an input that
  // fires a write every time it loses focus makes the audit trail useless.
  const saveCell = async (cell, raw) => {
    const key = catKeyOf(cell)
    const amount = raw === '' ? 0 : Number(String(raw).replace(/[$,\s]/g, ''))
    if (!Number.isFinite(amount) || amount < 0) {
      toast?.error?.('A budget is zero or more')
      setDrafts((d) => { const n = { ...d }; delete n[key]; return n })
      return
    }
    if (amount === budgetOf(key)) {
      setDrafts((d) => { const n = { ...d }; delete n[key]; return n })
      return
    }
    setSaving(key)
    try {
      await api.put(`/artist-budgets/${encodeURIComponent(artistKey)}/category`,
        { category: cell.category, amount })
      await load()
      setDrafts((d) => { const n = { ...d }; delete n[key]; return n })
    } catch (e) {
      toast?.error?.(e.response?.data?.error || e.message)
    } finally { setSaving('') }
  }

  /** One release's budget. Same blur-and-only-if-changed rule as a category. */
  const saveRelease = async (row, raw) => {
    const key = `rel:${row.release_id}`
    const amount = raw === '' ? 0 : Number(String(raw).replace(/[$,\s]/g, ''))
    if (!Number.isFinite(amount) || amount < 0) {
      toast?.error?.('A budget is zero or more')
      setDrafts((d) => { const n = { ...d }; delete n[key]; return n })
      return
    }
    if (amount === row.budget) {
      setDrafts((d) => { const n = { ...d }; delete n[key]; return n })
      return
    }
    setSaving(key)
    try {
      await api.put(`/artist-budgets/${encodeURIComponent(artistKey)}/release`,
        { release_id: row.release_id, amount })
      await load()
      setDrafts((d) => { const n = { ...d }; delete n[key]; return n })
    } catch (e) {
      toast?.error?.(e.response?.data?.error || e.message)
    } finally { setSaving('') }
  }

  const applyPaste = async () => {
    const items = paste.rows.filter((r) => r.amount != null)
      .map((r) => ({ category: r.category, amount: r.amount }))
    if (!items.length) { setPaste(null); return }
    setSaving('paste')
    try {
      await api.put(`/artist-budgets/${encodeURIComponent(artistKey)}/categories`, { items })
      await load()
      setPaste(null)
      toast?.success?.(`${items.length} budget${items.length === 1 ? '' : 's'} pasted`)
    } catch (e) {
      toast?.error?.(e.response?.data?.error || e.message)
    } finally { setSaving('') }
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────
  const move = (fromKey, delta) => {
    const i = view.cells.indexOf(fromKey)
    if (i < 0) return
    const next = view.cells[i + delta]
    if (!next) return
    const el = inputs.current.get(next)
    if (el) { el.focus(); el.select() }
  }

  const onCellKeyDown = (e, cell) => {
    const key = catKeyOf(cell)
    if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); move(key, 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(key, -1) }
    else if (e.key === 'Tab') { e.preventDefault(); move(key, e.shiftKey ? -1 : 1) }
    else if (e.key === 'Escape') {
      escaped.current = true
      setDrafts((d) => { const n = { ...d }; delete n[key]; return n })
      e.currentTarget.blur()
    }
  }

  // A column of numbers out of Excel arrives as one paste on ONE cell. It fills
  // down from there through the cells the keyboard would walk — and shows what it
  // will change before it changes anything, because a paste is easy to aim wrong
  // and there is no undo on a budget.
  const onCellPaste = (e, cell) => {
    const text = e.clipboardData?.getData('text/plain') || ''
    const parts = text.split(/\r\n|\r|\n|\t/).map((s) => s.trim()).filter((s, i, a) =>
      !(s === '' && i === a.length - 1))
    if (parts.length < 2) return            // a single value is an ordinary paste
    e.preventDefault()
    const start = view.cells.indexOf(catKeyOf(cell))
    if (start < 0) return
    // Keyed to the SECTION LABEL as well as the category: the preview names both,
    // and a category object carries only its section's key.
    const byKey = new Map()
    for (const s of view.sections) {
      for (const c of s.cats) byKey.set(catKeyOf(c), { cat: c, section: s.label })
    }
    const rows = parts.slice(0, view.cells.length - start).map((raw, i) => {
      const target = byKey.get(view.cells[start + i])
      const amount = parseCell(raw)
      return {
        key: view.cells[start + i],
        section: target?.section || '',
        category: target?.cat?.category || '',
        from: target?.cat?.budget ?? 0,
        raw,
        amount: amount == null || amount < 0 ? null : Math.round(amount * 100) / 100,
        why: amount == null ? 'not a number' : amount < 0 ? 'negative' : null,
      }
    })
    setPaste({ rows, dropped: parts.length - rows.length })
  }

  if (loading) return <div className="space-y-5"><Skeleton.PageHeader /><Skeleton.StatCards count={3} /></div>
  if (err) {
    return (
      <div className="card p-4 border-l-4 border-l-rose-500">
        <p className="text-[13px] font-bold text-rose-600">{err}</p>
        <Link to="/artist-budgets" className="text-[12px] font-bold text-gray-500 hover:text-ink">
          ← All sheets
        </Link>
      </div>
    )
  }
  if (!data) return null
  const t = data.totals

  const shownName = data.artist === artistKey && openedAs ? openedAs : data.artist
  return (
    <div className="space-y-5" data-tour="budget-detail-page">
      <Breadcrumb items={[
        { label: 'Artists', path: '/artists' },
        data.artist_id ? { label: shownName, path: `/artists/${data.artist_id}` } : { label: shownName },
        { label: 'Budget', path: `/artist-budgets/${encodeURIComponent(artistKey)}${openedAs ? `?name=${encodeURIComponent(openedAs)}` : ''}` },
        { label: 'Full breakdown' },
      ]} />
      <PageHeader tour="budget-detail-header"
        title={shownName}
        subtitle="The full breakdown: every expense category as its own row, with spend matched to it. The simple sheet (Advance, Total marketing, releases) is the everyday view."
        actions={(
          <>
            <Link to={`/artist-budgets/${encodeURIComponent(artistKey)}${openedAs ? `?name=${encodeURIComponent(openedAs)}` : ''}`}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-bold text-gray-500 border border-rule hover:text-ink hover:border-gray-300">
              <ArrowLeft size={13} /> Simple sheet
            </Link>
            <Link to="/artist-budgets"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-bold text-gray-500 border border-rule hover:text-ink hover:border-gray-300">
              All budgets
            </Link>
            <button type="button"
              onClick={() => {
                const token = localStorage.getItem('token')
                const base = import.meta.env.VITE_API_URL || '/api'
                window.open(
                  `${base}/artist-budgets/${encodeURIComponent(artistKey)}/export?token=${token}`,
                  '_blank')
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-bold text-white bg-boom-600 hover:bg-boom-700">
              <Download size={13} /> Excel
            </button>
          </>
        )}
      />

      {/* Planned campaigns, from the marketing spend sheet. Its figures are the
          sheet's; the grid below is the ledger's against a budget typed here, and
          the two are not added together anywhere. */}
      <CampaignBlock c={campaigns} />

      {/* The headline, and the honest split under it. */}
      <div className="card p-4">
        <div className="flex items-baseline gap-6 flex-wrap">
          <Figure label="Budget" value={t.budget} muted={!t.budget} />
          <Figure label="Spent" value={t.spent} strong />
          {t.open > 0 && <Figure label="Open" value={t.open} cls="text-amber-700" />}
          <Figure label="Committed" value={t.committed}
            cls={t.over_committed ? 'text-rose-600' : 'text-ink'} />
          <Figure label="Variance" value={t.variance}
            cls={!t.budget ? 'text-gray-300' : t.variance < 0 ? 'text-rose-600' : 'text-emerald-700'}
            display={t.budget ? undefined : '—'} />
        </div>
        {t.over_committed && (
          <p className="mt-2 text-[11.5px] text-rose-600 inline-flex items-center gap-1">
            <AlertTriangle size={11} />
            Within budget on what has been spent, but over it once the open invoices are paid.
          </p>
        )}
        <div className="mt-3 pt-3 border-t border-divider flex items-center gap-4 flex-wrap text-[11.5px]">
          <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
            of what has been spent
          </span>
          {[['verified', t.verified], ['awaiting_statement', t.awaiting],
            ['unverified', t.unverified]]
            .filter(([, v]) => v > 0)
            .map(([k, v]) => (
              <span key={k} className={STATE[k].cls} title={STATE[k].tip}>
                <b className="tabular-nums">{usd0(v)}</b> {STATE[k].label}
              </span>
            ))}
          {t.unverified > 0 && (
            <span className="inline-flex items-center gap-1 text-[11px] text-rose-600">
              <AlertTriangle size={11} /> a payment with no bank line behind it
            </span>
          )}
        </div>
      </div>

      {/* ── The grid ────────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-[11px] font-bold uppercase tracking-wider text-gray-400">
            Group by
          </label>
          <select value={grain} onChange={(e) => { setGrain(e.target.value); setSort(null) }}
            aria-label="Group by"
            className="px-2 py-1.5 text-[12px] border border-rule rounded-lg bg-card font-bold">
            <option value="category">Category</option>
            <option value="release">Release</option>
          </select>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}
            className="px-2 py-1.5 text-[12px] border border-rule rounded-lg bg-card">
            {FILTERS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          {sort && (
            <button type="button" onClick={() => setSort(null)}
              className="text-[11.5px] px-2 py-1.5 rounded-lg border border-rule text-gray-500 hover:text-ink inline-flex items-center gap-1">
              <X size={11} /> Sorted by {COLS.find((c) => c.key === sort.col)?.label || 'name'} — reset
            </button>
          )}
          <button type="button"
            onClick={() => setOpenSections(new Set(
              openSections && openSections.size ? [] : data.sections.map((s) => s.key)))}
            className="text-[11.5px] px-2 py-1.5 rounded-lg border border-rule text-gray-500 hover:text-ink">
            {openSections && openSections.size ? 'Collapse all' : 'Expand all'}
          </button>
          <span className="ml-auto text-[11px] text-gray-400 inline-flex items-center gap-1.5">
            <Keyboard size={12} />
            ↑ ↓ Enter to move · Esc reverts
            <span className="inline-flex items-center gap-1 ml-2">
              <ClipboardPaste size={12} /> paste a column from Excel into any budget cell
            </span>
          </span>
        </div>

        {/* ── The two partitions, stated ────────────────────────────────────
            They are the same money sliced two ways, so they do not have to add
            to the same number — and when they do not, that is worth saying out
            loud rather than leaving somebody to notice the totals row changed
            when they flipped the control. */}
        {data.release_totals?.budget > 0 && t.budget > 0
          && Math.abs(data.release_totals.budget - t.budget) >= 0.005 && (
          <p className="text-[11.5px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            This artist is planned <b className="tabular-nums">{usd(t.budget)}</b> by category
            and <b className="tabular-nums">{usd(data.release_totals.budget)}</b> by release.
            They are the same money split two ways, so neither is wrong — but one
            of them is out of date.
          </p>
        )}

        <div className="card overflow-auto max-h-[70vh]">
          <table className="w-full text-[12px] border-separate border-spacing-0">
            <thead>
              <tr>
                <Th sticky left col="name" sort={sort} setSort={setSort} align="left">
                  {grain === 'release' ? 'Release' : 'Section · category'}
                </Th>
                {COLS.map((c) => (
                  <Th key={c.key} sticky col={c.key} sort={sort} setSort={setSort}
                    width={c.key === 'pct' ? 'w-16' : 'w-32'}>
                    {c.label}
                  </Th>
                ))}
                <th className="sticky top-0 z-20 bg-card border-b border-rule w-24" />
              </tr>
            </thead>

            <tbody>
              {grain === 'release' && releaseView.rows.map((r) => {
                const key = `rel:${r.release_id}`
                return (
                  <tr key={key} className="group hover:bg-gray-50">
                    <Td left sticky className="text-gray-700">
                      {r.title}
                      {r.release_date && (
                        <span className="ml-2 text-[10.5px] text-gray-400">
                          {String(r.release_date).slice(0, 10)}
                        </span>
                      )}
                      {r.unplanned && <Tag cls="text-amber-700"
                        tip="Money was spent on this release and no budget was set for it.">unplanned</Tag>}
                      {r.over_committed && <Tag cls="text-rose-600"
                        tip="Inside budget on what has been spent, over it once the open invoices are paid.">over-committed</Tag>}
                      {/* What the imported marketing sheet planned for this
                          release. Shown BESIDE the typed budget, never merged
                          into it — the sheet records what was committed and the
                          cell records what somebody decided. */}
                      {r.sheet_total > 0 && (
                        <span className="ml-2 text-[10.5px] text-gray-400"
                          title="From the imported marketing spend sheet">
                          sheet {usd(r.sheet_total)}
                        </span>
                      )}
                    </Td>
                    <Td num className="p-0">
                      <BudgetInput
                        cell={{ ...r, category: r.title }} cellKey={key}
                        drafts={drafts} setDrafts={setDrafts}
                        saving={saving} escaped={escaped} inputs={inputs}
                        onSave={(cell, raw) => saveRelease(r, raw)}
                        onKeyDown={onCellKeyDown} onPaste={onCellPaste}
                      />
                    </Td>
                    <Td num className={r.spent > 0 ? 'text-ink' : 'text-gray-300'}>{money(r.spent)}</Td>
                    <Td num className={r.open > 0 ? 'text-amber-700' : 'text-gray-300'}>{money(r.open)}</Td>
                    <Td num className={r.over_committed ? 'text-rose-600' : 'text-gray-500'}>{money(r.committed)}</Td>
                    <VarianceCell row={r} />
                    <PctCell row={r} />
                    <Td className="text-right text-[10.5px] text-gray-400">
                      {r.count ? `${r.count} item${r.count === 1 ? '' : 's'}` : ''}
                    </Td>
                  </tr>
                )
              })}
              {/* The residual, always last and never filtered away. READ-ONLY:
                  it is what is left over, and a budget cell here would invite
                  planning against "everything not attributed yet". */}
              {grain === 'release' && releaseView.residual && releaseView.residual.committed > 0 && (
                <tr className="bg-gray-50/60">
                  <Td left sticky tone="section" className="text-gray-500 italic">
                    {releaseView.residual.title}
                    <span className="ml-2 not-italic text-[10.5px] text-gray-400">
                      spend on this artist that names no release — it cannot be budgeted here
                    </span>
                  </Td>
                  <Td num tone="section" className="text-gray-300">—</Td>
                  <Td num tone="section" className="text-ink">{money(releaseView.residual.spent)}</Td>
                  <Td num tone="section" className={releaseView.residual.open > 0 ? 'text-amber-700' : 'text-gray-300'}>
                    {money(releaseView.residual.open)}
                  </Td>
                  <Td num tone="section" className="text-gray-500">{money(releaseView.residual.committed)}</Td>
                  <Td num tone="section" className="text-gray-300">—</Td>
                  <Td num tone="section" className="text-gray-300">—</Td>
                  <Td tone="section" className="text-right text-[10.5px] text-gray-400">
                    {releaseView.residual.count ? `${releaseView.residual.count} items` : ''}
                  </Td>
                </tr>
              )}
              {grain === 'category' && view.sections.map((s) => {
                const open = isOpen(s.key)
                return (
                  <FragmentRows key={s.key}>
                    <tr>
                      <Td left sticky tone="section" className="font-bold text-ink">
                        <button type="button" onClick={() => toggleSection(s.key)}
                          className="inline-flex items-center gap-1 hover:text-boom-600">
                          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          {s.label}
                        </button>
                        {s.unplanned && <Tag cls="text-amber-700"
                          tip="Money was spent or committed in this section and no budget was set for it.">unplanned</Tag>}
                        {s.over_committed && <Tag cls="text-rose-600"
                          tip="Inside budget on what has been spent, over it once the open invoices are paid.">over-committed</Tag>}
                      </Td>
                      {/* Not an input. The section is the sum of its children. */}
                      <Td num tone="section" className="font-bold text-ink"
                        title={`The sum of ${s.budgeted_count} budgeted categor${s.budgeted_count === 1 ? 'y' : 'ies'} below`}>
                        {money(s.budget)}
                      </Td>
                      <Td num tone="section" className="font-bold text-ink">{money(s.spent)}</Td>
                      <Td num tone="section" className={s.open > 0 ? 'text-amber-700' : 'text-gray-300'}>{money(s.open)}</Td>
                      <Td num tone="section" className={s.over_committed ? 'text-rose-600' : 'text-gray-600'}>{money(s.committed)}</Td>
                      <VarianceCell row={s} bold tone="section" />
                      <PctCell row={s} tone="section" />
                      <Td tone="section" className="text-right text-[10.5px] text-gray-400">
                        {s.count ? `${s.count} item${s.count === 1 ? '' : 's'}` : ''}
                      </Td>
                    </tr>

                    {open && s.cats.map((c) => {
                      const key = catKeyOf(c)
                      const rows = rowsByCategory.get(key) || []
                      const drilled = openCats.has(key)
                      return (
                        <FragmentRows key={key}>
                          <tr className="group hover:bg-gray-50">
                            <Td left sticky className="pl-7 text-gray-600">
                              {c.category}
                              {!c.in_catalog && <Tag cls="text-gray-400"
                                tip="Not in the category list any more. Shown because it carries spend or a budget.">retired</Tag>}
                            </Td>
                            <Td num className="p-0">
                              <BudgetInput
                                cell={c} cellKey={key} drafts={drafts} setDrafts={setDrafts}
                                saving={saving} escaped={escaped} inputs={inputs}
                                onSave={saveCell} onKeyDown={onCellKeyDown} onPaste={onCellPaste}
                              />
                            </Td>
                            <Td num className={c.spent > 0 ? 'text-ink' : 'text-gray-300'}>{money(c.spent)}</Td>
                            <Td num className={c.open > 0 ? 'text-amber-700' : 'text-gray-300'}>{money(c.open)}</Td>
                            <Td num className={c.over_committed ? 'text-rose-600' : 'text-gray-500'}>{money(c.committed)}</Td>
                            <VarianceCell row={c} />
                            <PctCell row={c} />
                            <Td className="text-right">
                              {rows.length > 0 && (
                                <button type="button" onClick={() => toggleCat(key)}
                                  className="text-[10.5px] font-bold text-gray-400 hover:text-ink">
                                  {drilled ? 'hide' : `${rows.length} item${rows.length === 1 ? '' : 's'}`}
                                </button>
                              )}
                            </Td>
                          </tr>

                          {drilled && rows.map((r) => {
                            const st = STATE[recoupState(r)]
                            return (
                              <tr key={`r${r.id}`} className="group hover:bg-gray-50 text-[11.5px]">
                                <Td left sticky className="pl-12">
                                  <span className="inline-flex items-center gap-1.5">
                                    <BankEvidenceDot row={r} />
                                    <PayeeLink payee={r.payee} className="text-ink" />
                                    {r.song && <span className="text-gray-400">· {r.song}</span>}
                                    <span className="text-gray-400">
                                      {formatDate(r.payment_date || r.invoice_date) || '—'}
                                    </span>
                                  </span>
                                </Td>
                                <Td />
                                {/* The same columns mean the same things here: a
                                    paid row is spend, an unpaid one is not. */}
                                <Td num className="text-gray-600">
                                  {r.is_open ? '' : usd(r.amount_usd_calc)}
                                  {!r.is_open && r.currency && r.currency !== 'USD' && (
                                    <span className="text-gray-400"> ({r.amount} {r.currency})</span>
                                  )}
                                </Td>
                                <Td num className="text-amber-700">
                                  {r.is_open ? usd(r.amount_usd_calc) : ''}
                                </Td>
                                <Td /><Td />
                                <Td className={`text-right text-[10.5px] ${st.cls}`} title={st.tip} colSpan={2}>
                                  {st.label}
                                </Td>
                              </tr>
                            )
                          })}
                        </FragmentRows>
                      )
                    })}

                    {open && s.legacy_budget > 0 && (
                      <tr className="text-gray-500">
                        <Td left sticky className="pl-7">
                          (section-level budget)
                          <Tag cls="text-gray-400"
                            tip="Typed before the budget moved to the category rows. It still counts toward the section; clearing it needs the old section route.">legacy</Tag>
                        </Td>
                        <Td num>{money(s.legacy_budget)}</Td>
                        <Td /><Td /><Td /><Td /><Td /><Td />
                      </tr>
                    )}
                  </FragmentRows>
                )
              })}
            </tbody>

            <tfoot>
              {(() => {
                // The totals row belongs to the grain on screen. Reading the
                // category totals under a release body would be a footer that
                // does not add up its own rows.
                const T = grain === 'release' ? releaseTotals : shownTotals
                return (
                  <tr className="font-bold">
                    <Td left sticky foot className="text-ink">
                      TOTAL{view.filtered && <span className="ml-2 text-[10px] font-normal text-amber-700">filtered</span>}
                    </Td>
                    <Td num foot className="text-ink">{money(T.budget)}</Td>
                    <Td num foot className="text-ink">{money(T.spent)}</Td>
                    <Td num foot className={T.open > 0 ? 'text-amber-700' : 'text-gray-300'}>
                      {money(T.open)}
                    </Td>
                    <Td num foot className="text-ink">{money(T.committed)}</Td>
                    <Td num foot className={
                      !T.budget ? 'text-gray-300'
                        : T.variance < 0 ? 'text-rose-600' : 'text-emerald-700'}>
                      {T.budget ? usd(T.variance) : '—'}
                    </Td>
                    <Td num foot className="text-gray-500">
                      {T.pct == null ? '—' : `${T.pct}%`}
                    </Td>
                    <Td foot />
                  </tr>
                )
              })()}
            </tfoot>
          </table>
        </div>

        {/* Say what the totals row is a total OF. A subtotal that looks like a
            total is the same bug as a total that looks like a subtotal. */}
        <p className="text-[11px] text-gray-400 px-1">
          {grain === 'release'
            ? (view.filtered
              ? <>Totals cover the <b>{releaseView.shown}</b> of {releaseView.total} releases this
                filter shows, plus the unnamed residual.</>
              : <>{releaseView.total} release{releaseView.total === 1 ? '' : 's'}.
                {releaseView.residual?.committed > 0 && <>
                  {' '}<b className="tabular-nums">{usd(releaseView.residual.committed)}</b> of this
                  artist's spend names no release and sits in the last row — it cannot be
                  budgeted against a release, and leaving it out would report a fraction of
                  the artist as if it were all of them.
                </>}</>)
            : (view.filtered
              ? <>Totals cover the <b>{view.shown}</b> of {view.total} categories this filter shows —
                not the whole sheet. The sheet's own total is {usd(t.budget)} budget
                against {usd(t.spent)} spent.</>
              : <>{view.total} categories across {view.sections.length} sections. The budget is typed
                on the category rows; a section is the sum of the rows under it.</>)}
        </p>
      </div>

      {paste && (
        <PastePreview paste={paste} busy={saving === 'paste'}
          onCancel={() => setPaste(null)} onApply={applyPaste} />
      )}

      {/* ── Open, unpaid invoices ──────────────────────────────────────────
          The same money the OPEN column above carries, listed by payee instead of
          by category — a worklist, not a second total. Deliberately outside the
          spend figure: an invoice sitting in a drawer is not an expenditure, and
          counting it as one is what made the older pages read 31% high —
          $538,345 of "spend" across the eight biggest artists was invoices nobody
          had paid.

          Oldest first, because the oldest is the one most likely to be a
          surprise. */}
      {data.open_rows.length > 0 && (
        <div className="card overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-rule flex-wrap">
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700">
              Open · unpaid invoices
            </span>
            <span className="text-[11px] text-gray-400 tabular-nums">
              {data.open_rows.length} invoice{data.open_rows.length === 1 ? '' : 's'} ·
              still to pay
            </span>
            <span className="ml-auto text-[15px] font-black tabular-nums text-amber-700">
              {usd(t.open)}
            </span>
          </div>
          <table className="w-full text-[12px]">
            <tbody className="divide-y divide-divider">
              {data.open_rows.map((r) => (
                <tr key={`o${r.id}`} className="hover:bg-gray-50/60">
                  <td className="px-3 py-1.5">
                    <PayeeLink payee={r.payee} className="font-bold text-ink" />
                    {r.song && <span className="text-gray-400"> · {r.song}</span>}
                  </td>
                  <td className="px-3 py-1.5 text-gray-500">{r.category || '—'}</td>
                  <td className="px-3 py-1.5 text-right text-gray-400 tabular-nums whitespace-nowrap">
                    {formatDate(r.invoice_date) || '—'}
                    <Age date={r.invoice_date} />
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-bold text-ink w-32">
                    {usd(r.amount_usd_calc)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-rule font-bold">
                <td className="px-3 py-2 text-ink" colSpan={3}>STILL TO PAY</td>
                <td className="px-3 py-2 text-right tabular-nums text-amber-700">{usd(t.open)}</td>
              </tr>
              <tr className="border-t border-divider">
                <td className="px-3 py-2 text-gray-500" colSpan={3}>
                  Committed — spent plus open
                </td>
                <td className={`px-3 py-2 text-right tabular-nums font-black ${
                  t.over_committed ? 'text-rose-600' : 'text-ink'}`}>
                  {usd(t.committed)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <p className="text-[11px] text-gray-400 px-1">
        Expenses land in a category by their own category field — nothing is assigned by hand.
        A category you have not budgeted still shows its spend, marked unplanned.
        Spent is money that has left the bank; open invoices are counted separately
        and added into the committed total.
      </p>
    </div>
  )
}

// React.Fragment with a key, without importing Fragment at every call site.
function FragmentRows({ children }) { return <>{children}</> }

// ── Grid furniture ───────────────────────────────────────────────────────────

function Th({ children, col, sort, setSort, sticky, left, align = 'right', width = '' }) {
  const active = sort?.col === col
  return (
    <th
      className={`${sticky ? 'sticky top-0 z-20' : ''} ${left ? 'left-0 z-30' : ''} bg-card
        border-b border-rule ${left ? 'border-r' : ''} px-2 py-1.5 ${width}
        text-[10px] font-bold uppercase tracking-wider
        ${active ? 'text-ink' : 'text-gray-400'} ${align === 'left' ? 'text-left' : 'text-right'}`}
    >
      <button type="button"
        onClick={() => setSort((prev) => (
          prev?.col === col
            ? (prev.dir === 'desc' ? { col, dir: 'asc' } : null)
            : { col, dir: col === 'name' ? 'asc' : 'desc' }))}
        className={`inline-flex items-center gap-1 hover:text-ink ${align === 'right' ? 'flex-row-reverse' : ''}`}
        title="Sort by this column"
      >
        {children}
        {active && (sort.dir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
      </button>
    </th>
  )
}

function Td({ children, className = '', num, left, sticky, foot, tone, ...rest }) {
  // A frozen cell scrolls OVER the rows beside it, so its background has to be
  // opaque and has to match its row — an alpha tint or an inherited one from the
  // <tr> leaves the label column showing through and a pale notch where the
  // section header should be solid.
  const bg = tone === 'section' ? 'bg-gray-50' : 'bg-card'
  return (
    <td
      className={`px-2 h-7 border-b border-divider ${left ? 'border-r' : ''}
        ${sticky ? 'sticky left-0 z-10' : ''}
        ${sticky || foot || tone ? bg : ''}
        ${sticky && !tone && !foot ? 'group-hover:bg-gray-50' : ''}
        ${foot ? 'sticky bottom-0 z-20 border-t-2 border-rule bg-card' : ''}
        ${num ? 'text-right tabular-nums' : ''} ${className}`}
      {...rest}
    >
      {children}
    </td>
  )
}

function Tag({ children, cls, tip }) {
  return (
    <span className={`ml-2 text-[9.5px] font-bold uppercase tracking-wider ${cls}`} title={tip}>
      {children}
    </span>
  )
}

// Variance measures against SPENT, as it always has on this sheet. A row with
// spend and no budget says so in words rather than printing minus its own spend,
// which reads as overspending against a budget nobody set.
function VarianceCell({ row, bold, tone }) {
  if (!row.budget) {
    return (
      <Td num tone={tone} className={row.unplanned ? 'text-amber-700 text-[10.5px]' : 'text-gray-300'}>
        {row.unplanned ? 'unplanned' : '—'}
      </Td>
    )
  }
  return (
    <Td num tone={tone} className={`${bold ? 'font-bold ' : ''}${row.variance < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
      {usd(row.variance)}
    </Td>
  )
}

function PctCell({ row, tone }) {
  if (row.pct == null) return <Td num tone={tone} className="text-gray-300">—</Td>
  return (
    <Td num tone={tone} className={row.pct > 100 ? 'text-rose-600' : 'text-gray-500'}
      title="Spent as a share of the budget">
      {row.pct}%
    </Td>
  )
}

// The budget cell. Thirty-two of these are the whole budget.
function BudgetInput({ cell, cellKey, drafts, setDrafts, onSave, saving, escaped, inputs, onKeyDown, onPaste }) {
  const val = drafts[cellKey] ?? (cell.budget ? String(cell.budget) : '')
  return (
    <span className="relative flex items-center justify-end">
      {saving === cellKey && (
        <Loader size={11} className="absolute left-1 animate-spin text-gray-400" />
      )}
      <input
        ref={(el) => { if (el) inputs.current.set(cellKey, el); else inputs.current.delete(cellKey) }}
        value={val}
        onChange={(e) => setDrafts((d) => ({ ...d, [cellKey]: e.target.value }))}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => {
          if (escaped.current) { escaped.current = false; return }
          onSave(cell, e.target.value.trim())
        }}
        onKeyDown={(e) => onKeyDown(e, cell)}
        onPaste={(e) => onPaste(e, cell)}
        inputMode="decimal"
        placeholder="—"
        aria-label={`Budget for ${cell.category}`}
        title={cell.updated_by_name ? `Set by ${cell.updated_by_name}` : 'Type a budget for this category'}
        className="w-full px-2 h-7 text-right text-[12px] tabular-nums bg-transparent
          border border-transparent rounded-none hover:bg-gray-50
          focus:border-boom-400 focus:bg-card focus:outline-none focus:ring-1 focus:ring-boom-400"
      />
    </span>
  )
}

/**
 * What a pasted column is about to do, before it does it.
 *
 * A paste lands on cells the user cannot all see at once, and there is no undo on
 * a budget — so the write waits behind this. Rows that are not numbers are shown
 * as SKIPPED rather than silently written as zero: one label in a copied column
 * would otherwise clear a budget.
 */
function PastePreview({ paste, busy, onCancel, onApply }) {
  const writes = paste.rows.filter((r) => r.amount != null)
  const skips = paste.rows.filter((r) => r.amount == null)
  const changes = writes.filter((r) => Math.abs(r.amount - r.from) >= 0.005)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
      onClick={onCancel}>
      <div className="card w-full max-w-lg max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-rule">
          <ClipboardPaste size={15} className="text-gray-400" />
          <h2 className="text-[13px] font-bold text-ink flex-1">
            Paste {writes.length} budget{writes.length === 1 ? '' : 's'}
          </h2>
          <button type="button" onClick={onCancel}><X size={14} className="text-gray-400" /></button>
        </div>
        <div className="overflow-auto flex-1">
          <table className="w-full text-[12px]">
            <tbody className="divide-y divide-divider">
              {paste.rows.map((r) => (
                <tr key={r.key} className={r.amount == null ? 'text-gray-400' : ''}>
                  <td className="px-3 py-1.5">
                    {r.category || <em className="text-gray-400">past the last row</em>}
                    <span className="block text-[10px] text-gray-400">{r.section}</span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-400 w-28">
                    {r.from ? usd(r.from) : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums w-32">
                    {r.amount == null
                      ? <span className="text-[11px] text-amber-700">
                          skipped — {r.why} (“{String(r.raw).slice(0, 12)}”)
                        </span>
                      : <b className={Math.abs(r.amount - r.from) >= 0.005 ? 'text-ink' : 'text-gray-300'}>
                          {usd(r.amount)}
                        </b>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 border-t border-rule flex items-center gap-2 flex-wrap">
          <p className="text-[11px] text-gray-400 flex-1">
            {changes.length} cell{changes.length === 1 ? '' : 's'} change
            {skips.length > 0 && <> · {skips.length} skipped</>}
            {paste.dropped > 0 && <> · {paste.dropped} past the last row</>}
          </p>
          <button type="button" onClick={onCancel}
            className="text-[12.5px] px-3 py-1.5 rounded-lg border border-rule text-gray-600 hover:bg-gray-100">
            Cancel
          </button>
          <button type="button" onClick={onApply} disabled={busy || !writes.length}
            className="btn-primary text-[12.5px] px-3 py-1.5 inline-flex items-center gap-1.5 disabled:opacity-50">
            {busy && <Loader size={12} className="animate-spin" />}
            Paste {writes.length}
          </button>
        </div>
      </div>
    </div>
  )
}

// How long an open invoice has been sitting. Stated in the row rather than left
// to date arithmetic: "13 Jul" and "43 days" are the same fact, and only one of
// them tells you it needs attention.
function Age({ date }) {
  if (!date) return null
  const d = new Date(String(date).slice(0, 10) + 'T12:00:00Z')
  if (Number.isNaN(d.getTime())) return null
  const days = Math.floor((Date.now() - d.getTime()) / 86400000)
  if (days < 30) return null
  return (
    <span className={`ml-1.5 text-[10px] font-bold ${
      days >= 90 ? 'text-rose-600' : 'text-amber-700'}`}
      title={`Invoiced ${days} days ago and still unpaid`}>
      {days}d
    </span>
  )
}

function Figure({ label, value, strong, muted, cls, display }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{label}</div>
      <div className={`text-[20px] font-black tabular-nums ${
        cls || (muted ? 'text-gray-300' : strong ? 'text-ink' : 'text-ink')}`}>
        {display ?? usd(value)}
      </div>
    </div>
  )
}

// The spend sheet's planned campaigns for one artist.
//
// Renders nothing when the artist has none — 359 of the sheet's blocks are still
// unlinked and most artists predate it, so an empty state here would be noise on
// a page that already has content.
function CampaignBlock({ c }) {
  if (!c || !c.campaigns?.length) return null
  const m = (v) => `$${Number(v || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
        <h2 className="text-[13px] font-bold text-ink">
          Planned campaigns
          <span className="ml-2 text-[11px] font-normal text-gray-400">
            {c.campaign_count} from the spend sheet
          </span>
        </h2>
        <div className="flex items-baseline gap-5 text-[11.5px]">
          <span><b className="tabular-nums text-ink">{m(c.planned)}</b> <span className="text-gray-400">planned</span></span>
          {c.owed > 0 && (
            <span><b className="tabular-nums text-amber-700">{m(c.owed)}</b> <span className="text-gray-400">still owed</span></span>
          )}
          <span><b className="tabular-nums text-ink">{m(c.ledger_paid)}</b> <span className="text-gray-400">paid</span></span>
        </div>
      </div>
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="border-b border-rule text-[10px] font-bold uppercase tracking-wider text-gray-400">
            <th className="text-left py-1.5">Campaign</th>
            <th className="text-right py-1.5 w-28">Planned</th>
            <th className="text-right py-1.5 w-28">Still owed</th>
            <th className="text-right py-1.5 w-28">Ledger paid</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-divider">
          {c.campaigns.map((x) => (
            <tr key={x.plan_id}>
              <td className="py-1.5 text-gray-700">{x.title || <em className="text-gray-400">untitled</em>}</td>
              <td className="py-1.5 text-right tabular-nums text-ink">{m(x.planned)}</td>
              <td className="py-1.5 text-right tabular-nums">
                {x.owed > 0 ? <span className="text-amber-700">{m(x.owed)}</span>
                            : <span className="text-gray-300">—</span>}
              </td>
              <td className="py-1.5 text-right tabular-nums text-gray-600">{m(x.ledger_paid)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
