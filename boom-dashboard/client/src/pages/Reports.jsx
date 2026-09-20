import { useEffect, useState, useRef, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { FileBarChart, Download, Loader, Landmark, X, AlertTriangle, Zap, Undo2, ChevronLeft, CheckCircle2, Flag, Ban, Search, FileText, Table2, ExternalLink, CalendarClock, Pencil, ArrowDownUp } from 'lucide-react'
import FilePreview from '../components/FilePreview'
import { pickDoc, fileUrl } from '../utils/entryFiles'
import api from '../api'
import CategorySelect from '../components/CategorySelect'
import ArtistSelect from '../components/ArtistSelect'
import PayeeLink from '../components/PayeeLink'
import { useCategoriesContext } from '../context/CategoriesContext'
import ReviewDeck, { DeckButton, useDeckPreview } from '../components/ReviewDeck'
import InlineFilePreview from '../components/InlineFilePreview'
import ListSearch, { matchesQuery } from '../components/ListSearch'
import { drillComparator } from '../utils'
import ReconciledBadge from '../components/ReconciledBadge'
import BasisSwitch, { BASIS_TEXT } from '../components/reports/BasisSwitch'
import ReportCharts from '../components/reports/ReportCharts'
import ComparePanel from '../components/reports/ComparePanel'
import SpendByTable from '../components/reports/SpendByTable'
import BudgetVsActual from '../components/reports/BudgetVsActual'
import PackModal from '../components/reports/PackModal'
import { rollupPnl, periodRange, periodLabel, shiftRange } from '../lib/pnlRollup'

// Reports — P&L (cash basis) and Balance Sheet, live from the ledger,
// income entries, outbound invoices, and bank-statement ending balances.
// Operating activity above the line; drawdowns/advances/reimbursements
// below it. Every P&L cell drills down to its underlying entries.

// A missing field is NOT zero. `Number(n || 0)` used to turn undefined into a
// confident "$0.00", which is how a response-shape regression becomes a
// plausible wrong number instead of a visible gap. Show an em dash instead.
const fmt = (n) => {
  if (n === null || n === undefined || n === '') return '—'
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  const s = `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return v < 0 ? `(${s})` : s
}

// Money on a row whose direction is already implied by the row itself (an
// expense line, a below-the-line outflow). `negative` FLIPS the sign rather
// than prefixing a character: prefixing produced "−($1,200.00)" whenever the
// underlying value was itself negative — a refund inside an expense line —
// which reads as neither positive nor negative.
const fmtFlow = (n, negative = false) => {
  if (n === null || n === undefined || n === '') return '—'
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  const eff = negative ? -v : v
  const s = `$${Math.abs(eff).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return eff < 0 ? `−${s}` : s
}
const monthLabel = (ymStr) => {
  // Quarter / year columns (lib/pnlRollup) label themselves.
  if (!/^\d{4}-\d{2}$/.test(String(ymStr))) return periodLabel(String(ymStr))
  const [y, m] = ymStr.split('-')
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1]} ${y.slice(2)}`
}
const today = () => new Date().toISOString().slice(0, 10)
const fmtDay = (d) => (d ? String(d).length > 10 ? new Date(d).toISOString().slice(0, 10) : String(d).slice(0, 10) : '')

// The document a row can show, if any. Renders nothing for rows with no ledger
// entry behind them — an unbooked bank charge has no invoice to open, and a
// disabled button on every such row would be noise.
//
// A row's own invoice comes first, then proof of payment, then receipt, and the
// tooltip names what will actually open rather than always saying "invoice".
function DocButton({ row, onOpen }) {
  const doc = pickDoc(row)
  if (!doc) return null
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onOpen({ url: fileUrl(row, doc.type), filename: row[doc.name] || doc.label }) }}
      title={`View ${doc.label}${row[doc.name] ? ` — ${row[doc.name]}` : ''}`}
      aria-label={`View ${doc.label}`}
      className="shrink-0 p-1 rounded text-gray-400 hover:text-boom-700 hover:bg-gray-100">
      <FileText size={13} />
    </button>
  )
}

export default function Reports() {
  // Live category vocabularies. Both the numbered deck dropdown and the deck's
  // 1-9 hotkeys read these, so a newly created category is immediately
  // pickable by number as well as by mouse.
  const { expense: catExpense, income: catIncome } = useCategoriesContext()
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState(searchParams.get('tab') || 'pnl')
  const [byArtist, setByArtist] = useState(null)
  // How many artists to list before collapsing the tail. 127 artists with 63
  // of them under $1,000 is not a slide.
  // ALL artists by default. The export URL below sends this value, so a screen
  // defaulting to Top 25 quietly re-truncated the workbook that was just made
  // fully expanded — what you see and what you download have to be the same
  // thing. The selector stays as a way to shorten the screen deliberately.
  const [artistTopN, setArtistTopN] = useState(0)
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`)
  const [to, setTo] = useState(today())
  const [asOf, setAsOf] = useState(today())
  const [artistF, setArtistF] = useState('')
  const [pnlRaw, setPnl] = useState(null)
  const [bs, setBs] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [sheeting, setSheeting] = useState(false)
  const [sheet, setSheet] = useState(null)   // {url, at, created, warning}
  // Drill-down modal: which cell, and its entries
  const [drill, setDrill] = useState(null) // { kind, key, month }
  const [drillData, setDrillData] = useState(null)
  // ── Second pass (2026-09-20): basis · compare · granularity · charts · cuts · pack ──
  // Basis: from the email link, else what this browser last chose, else the
  // server's data-driven default (ledger until a bank month is reconciled).
  const basisChosen = useRef(!!(searchParams.get('basis') || localStorage.getItem('reports_basis')))
  const [basis, setBasis] = useState(() => searchParams.get('basis') || localStorage.getItem('reports_basis') || null)
  const [basisInfo, setBasisInfo] = useState(null)
  const [compare, setCompare] = useState(() => localStorage.getItem('reports_compare') || 'none')   // none | prior | yoy
  const [gran, setGran] = useState(() => localStorage.getItem('reports_gran') || 'month')           // month | quarter | year
  const [showCharts, setShowCharts] = useState(() => localStorage.getItem('reports_charts') !== '0')
  const [prevPnl, setPrevPnl] = useState(null)
  const [intake, setIntake] = useState(null)
  const [vendors, setVendors] = useState(null)
  const [reps, setReps] = useState(null)
  const [bva, setBva] = useState(null)
  const [packOpen, setPackOpen] = useState(false)
  // Every P&L reader below sees PERIODS: months, quarters or years.
  const pnl = useMemo(() => rollupPnl(pnlRaw, gran), [pnlRaw, gran])
  // Invoice / proof / receipt overlay, opened from a row's document button.
  // Same shared FilePreview the ledger and approvals pages use.
  const [previewFile, setPreviewFile] = useState(null)

  const fetchPnl = async (artistOverride) => {
    setLoading(true); setError('')
    const artist = artistOverride !== undefined ? artistOverride : artistF
    try {
      const res = await api.get('/reports/pnl', { params: { from, to, basis, ...(artist ? { artist } : {}) } })
      setPnl(res.data.data)
      // The comparison is a SECOND run of the same report for the shifted range
      // on the same basis; the charts' extra series ride along. None of these
      // may take the P&L down — each fails to null on its own.
      const extras = []
      if (compare !== 'none') {
        const r = shiftRange(from, to, compare)
        extras.push(api.get('/reports/pnl', { params: { from: r.from, to: r.to, basis, ...(artist ? { artist } : {}) } }).then((x) => setPrevPnl({ ...x.data.data, range: r })).catch(() => setPrevPnl(null)))
      } else setPrevPnl(null)
      if (showCharts) {
        extras.push(api.get('/reports/intake', { params: { from, to } }).then((x) => setIntake(x.data.data)).catch(() => setIntake(null)))
        extras.push(api.get('/reports/spend-by', { params: { dim: 'vendor', from, to, basis } }).then((x) => setVendors(x.data.data)).catch(() => setVendors(null)))
      }
      await Promise.all(extras)
    } catch (err) { setError(err.response?.data?.error || err.message) }
    finally { setLoading(false) }
  }
  const fetchSpendBy = async (dim) => {
    setLoading(true); setError('')
    try {
      const res = await api.get('/reports/spend-by', { params: { dim, from, to, basis } })
      if (dim === 'rep') setReps(res.data.data); else setVendors(res.data.data)
    } catch (err) { setError(err.response?.data?.error || err.message) }
    finally { setLoading(false) }
  }
  const fetchBva = async () => {
    setLoading(true); setError('')
    try { const res = await api.get('/reports/budget-vs-actual', { params: { from, to, basis } }); setBva(res.data.data) }
    catch (err) { setError(err.response?.data?.error || err.message) }
    finally { setLoading(false) }
  }
  const fetchBs = async () => {
    setLoading(true); setError('')
    try {
      const res = await api.get(`/reports/balance-sheet?as_of=${asOf}`)
      setBs(res.data.data)
    } catch (err) { setError(err.response?.data?.error || err.message) }
    finally { setLoading(false) }
  }
  // Spend by artist. Server-side this is a slice of the SAME buildPnl run the
  // P&L uses, so `ties_to_pnl` should always be true — it travels on the
  // payload as a self-check, and the tab refuses to present numbers without it
  // rather than showing a breakdown that disagrees with the P&L.
  const fetchArtists = async () => {
    setLoading(true); setError('')
    try {
      const res = await api.get(`/reports/spend-by-artist?from=${from}&to=${to}&basis=${basis}`)
      setByArtist(res.data.data)
    } catch (err) { setError(err.response?.data?.error || err.message) }
    finally { setLoading(false) }
  }
  // The dismissed tab loads its own data (see fetchDismissals below) — it
  // must not fall through to fetchBs().
  // The basis default comes from the data; nothing money-shaped is fetched
  // until a basis is known, so the page never briefly shows the wrong one.
  useEffect(() => {
    api.get('/reports/basis')
      .then((r) => { const info = r.data?.data || null; setBasisInfo(info); if (!basisChosen.current) setBasis((b) => b || info?.default || 'bank') })
      .catch(() => { if (!basisChosen.current) setBasis((b) => b || 'bank') })
  }, [])
  useEffect(() => { if (basis) { try { localStorage.setItem('reports_basis', basis) } catch { /* private mode */ } } }, [basis])
  useEffect(() => { try { localStorage.setItem('reports_compare', compare); localStorage.setItem('reports_gran', gran); localStorage.setItem('reports_charts', showCharts ? '1' : '0') } catch { /* private mode */ } }, [compare, gran, showCharts])
  useEffect(() => {
    if (!basis) return
    if (tab === 'pnl') fetchPnl()
    else if (tab === 'bs') fetchBs()
    else if (tab === 'artists') fetchArtists()
    else if (tab === 'vendors') fetchSpendBy('vendor')
    else if (tab === 'reps') fetchSpendBy('rep')
    else if (tab === 'budget') fetchBva()
  }, [tab, basis, compare, showCharts]) // eslint-disable-line react-hooks/exhaustive-deps

  // Monotonic request token. Without it a slow response could land after the
  // user had already opened a DIFFERENT cell, leaving the modal showing one
  // cell's header over another cell's rows — and `applyBulk` / `recategorize`
  // post against the displayed rows using `drill.kind`/`drill.key`, so a bulk
  // recategorise in that state edits the wrong transactions. Stale responses
  // are dropped, never rendered.
  const drillReq = useRef(0)
  // Closing also invalidates: a response landing after the user dismissed the
  // modal must not repopulate it, and must not leave a document overlay behind.
  const closeDrill = () => { drillReq.current += 1; setDrill(null); setPreviewFile(null) }
  const openDrill = async (kind, key, month, category, opts = {}) => {
    const req = ++drillReq.current
    setDrill({ kind, key, month, category, keys: opts.keys, label: opts.label })
    setDrillData(null)
    setDrillSel(new Set())
    setBulkCat('')
    setDrillQ('')
    setRecOpen(false)
    try {
      const res = kind.startsWith('bs-')
        ? await api.get('/reports/balance-sheet/detail', { params: { kind: kind.slice(3), as_of: asOf } })
        : await api.get('/reports/pnl/detail', {
          params: {
            kind, key, basis,
            // A quarter or year cell asks for its own from/to; a month cell asks by month.
            ...(month && pnl?.month_of_period ? periodRange(month, pnl.month_of_period) : { from, to }),
            ...(month && !pnl?.month_of_period ? { month } : {}),
            ...(category ? { category } : {}),
            ...(opts.keys?.length ? { keys: opts.keys.join(',') } : {}),
            // The artist drill is already scoped by its own key; layering the
            // page's artist filter on top would AND two different artist rules.
            ...(artistF && kind !== 'artist' ? { artist: artistF } : {}),
          },
        })
      if (req !== drillReq.current) return
      setDrillData(res.data.data)
    } catch (err) {
      if (req !== drillReq.current) return
      setDrillData({ rows: [], total: 0, error: err.response?.data?.error || err.message })
    }
  }
  // Recategorize/deck affordances only apply to P&L cells — balance-sheet
  // drills are read-only lists.
  const drillEditable = drill && ['income', 'expense'].includes(drill.kind)

  // Attributing an artist is allowed on the ARTIST drill too.
  //
  // It wasn't, and the effect was backwards: the cell literally titled "Not
  // attributed to an artist" was the one place you could not attribute one. You
  // could recategorise there (that control is not gated), so the drill offered
  // the answer to a question nobody had asked and withheld the one it was named
  // after.
  //
  // Kept separate from `drillEditable` rather than widening it: that flag also
  // gates row selection, the bulk bar and the month reassignment, which belong to
  // the P&L cells and mean nothing on an artist drill.
  const artistAssignable = drill && ['income', 'expense', 'artist'].includes(drill.kind)
    && drill.kind !== 'income'

  // ── Dismissals ────────────────────────────────────────────────────────────
  // Excluding an item removes it from the list AND the reported total, so
  // every surface that can dismiss also shows what's been excluded. The
  // dismissed set lives in its own table and its own tab, never mixed with
  // the statements pipeline's own dismissals.
  const [dismissals, setDismissals] = useState(null) // null = not loaded
  const [dismissBusy, setDismissBusy] = useState(null)
  const [dismissQ, setDismissQ] = useState('')
  // The list holds up to 500 rows and mixes line rules with individual items,
  // so it needs a way in. Filters the loaded set — this endpoint returns
  // everything, so there's nothing off-screen to miss.
  const dismissalsFiltered = (dismissals || []).filter((d) => matchesQuery(dismissQ, [
    d.payee, d.cell_key, d.cell_kind, d.reason, d.dismissed_by,
    d.artist, d.invoice_number, d.account, d.amount,
    d.scope === 'category' ? 'whole line' : null,
    // Balance-sheet exclusions have no payee or amount resolved into this list,
    // so without these they'd be unfindable by search.
    d.bs_ref,
    d.scope === 'bs_line' ? 'balance sheet whole line' : d.scope === 'bs_item' ? 'balance sheet row' : null,
  ]))
  const [dismissalsError, setDismissalsError] = useState(null)
  const fetchDismissals = async () => {
    setDismissalsError(null)
    try {
      const res = await api.get('/reports/dismissals')
      setDismissals(res.data.data || [])
    } catch (err) {
      // Settle to an empty list, not null: `null` renders "Loading…" forever, so
      // a failed fetch looked like a request that never came back. And keep the
      // message on this tab rather than the shared `error`, which painted a
      // dismissals failure across the P&L.
      setDismissals([])
      setDismissalsError(err.response?.data?.error || err.message)
    }
  }
  useEffect(() => { if (tab === 'dismissed') fetchDismissals() }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps
  // Roster for the artist picker. Suggestions only — the picker accepts any
  // name, because ~90 artists appear in the ledger against 50 on the roster.
  useEffect(() => {
    // The signed roster UNION the names already in the ledger. /artists alone is
    // 50 names against 107 artists with spend, so 99 of them — $828,380 —
    // could not be picked at all and had to be retyped, which is how a fourth
    // spelling of an existing artist gets created.
    api.get('/bk/artist-names')
      .then((r) => { const l = r.data?.data?.names ?? []; setRoster(Array.isArray(l) ? l : []) })
      // The roster alone is a worse list, but it is a list — better than a
      // picker with nothing in it if this endpoint is unavailable.
      .catch(() => api.get('/artists')
        .then((r) => { const l = r.data?.data ?? r.data ?? []; setRoster(Array.isArray(l) ? l.map((a) => a.name).filter(Boolean) : []) })
        .catch(() => {}))
  }, [])

  // A row is dismissable if we can identify it: a bank txn (counted money) or
  // an unverified ledger row (shown, never counted).
  const dismissRow = async (r, reason) => {
    const ref = r.txn_id ? { txn_id: r.txn_id } : r.expense_id ? { expense_id: r.expense_id } : null
    if (!ref || dismissBusy) return
    setDismissBusy(r.id)
    try {
      await api.post('/reports/dismiss', {
        ...ref,
        cell_kind: drill?.kind || null,
        cell_key: drill?.key || null,
        ...(reason ? { reason } : {}),
      })
      // Both the drill and the report change, so both refetch.
      if (drill) await openDrill(drill.kind, drill.key, drill.month, drill.category, { keys: drill.keys, label: drill.label })
      if (tab === 'pnl') fetchPnl()
    } catch (err) { alert('Failed to dismiss: ' + (err.response?.data?.error || err.message)) }
    finally { setDismissBusy(null) }
  }
  // ── Balance-sheet exclusions ──────────────────────────────────────────────
  //
  // Standing rules, stored server-side, in their own scope so nothing here
  // touches the P&L. A whole line ('bs_line', keyed by cell_key) or a single
  // invoice / bill / drawdown ('bs_item', keyed by its namespaced bs_ref).
  const bsExclude = async (payload, confirmText) => {
    if (dismissBusy) return
    const reason = window.prompt(confirmText)
    if (reason === null) return       // cancelled
    setDismissBusy(payload.bs_ref || payload.cell_key)
    try {
      await api.post('/reports/dismiss', { ...payload, ...(reason ? { reason } : {}) })
      await fetchBs()
      if (drill) await openDrill(drill.kind, drill.key, drill.month, drill.category, { keys: drill.keys, label: drill.label })
    } catch (err) { alert('Failed to exclude: ' + (err.response?.data?.error || err.message)) }
    finally { setDismissBusy(null) }
  }
  const bsRestore = async (payload) => {
    if (dismissBusy) return
    setDismissBusy(payload.bs_ref || payload.cell_key)
    try {
      await api.post('/reports/dismiss/restore', payload)
      await fetchBs()
      if (drill) await openDrill(drill.kind, drill.key, drill.month, drill.category, { keys: drill.keys, label: drill.label })
    } catch (err) { alert('Failed to restore: ' + (err.response?.data?.error || err.message)) }
    finally { setDismissBusy(null) }
  }

  // Which lines have their composition expanded. Collapsed by default — A/P
  // alone has 18 categories, and always-open would bury the headline figures.
  const [bsOpen, setBsOpen] = useState(new Set())
  const toggleBs = (key) => setBsOpen((prev) => {
    const n = new Set(prev)
    n.has(key) ? n.delete(key) : n.add(key)
    return n
  })

  // One balance-sheet line, with its exclude / restore control and its
  // composition. Written as a helper rather than repeated four times so the
  // excluded presentation — struck through, greyed, and still showing its
  // amount — can't drift between lines.
  const bsLine = ({ key, label, sub, amount, excluded, onOpen, breakdown, breakdownLabel, indent = true }) => {
    const rows = breakdown || []
    const open = bsOpen.has(key) && !excluded
    return (
      <div key={key}>
        <div className={`group flex items-center justify-between py-1 text-[13px] rounded ${onOpen && !excluded ? 'cursor-pointer hover:bg-gray-50/60' : ''}`}
          onClick={onOpen && !excluded ? onOpen : undefined}
          title={onOpen && !excluded ? 'Click to see the detail' : undefined}>
          <span className={`flex items-center gap-1 ${indent ? 'pl-3' : ''} ${excluded ? 'text-gray-400 line-through' : 'text-ink'}`}>
            {rows.length > 0 && !excluded && (
              <button
                onClick={(e) => { e.stopPropagation(); toggleBs(key) }}
                title={open ? 'Hide the breakdown' : `Break down by ${breakdownLabel || 'category'}`}
                className="-ml-3 w-3 shrink-0 text-gray-400 hover:text-ink">
                <ChevronLeft size={11} className={`transition-transform ${open ? '-rotate-90' : 'rotate-180'}`} />
              </button>
            )}
            {label}{sub ? <span className="text-gray-400 text-[11px] no-underline"> {sub}</span> : null}
          </span>
          <span className="flex items-center gap-1.5">
            <span className={`font-mono tabular-nums ${excluded ? 'text-gray-400 line-through' : ''}`}>{fmt(amount)}</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                if (excluded) return bsRestore({ scope: 'bs_line', cell_key: key })
                bsExclude({ scope: 'bs_line', cell_key: key },
                  `Exclude “${label}” (${fmt(amount)}) from the balance sheet?\n\nA standing rule — this line stops counting, now and later. Reason (optional):`)
              }}
              disabled={dismissBusy === key}
              title={excluded ? 'Restore this line' : 'Exclude this line from the balance sheet'}
              className={`p-0.5 rounded ${excluded ? 'text-emerald-600 hover:text-emerald-700' : 'text-gray-300 hover:text-rose-600 opacity-0 group-hover:opacity-100 focus:opacity-100'}`}>
              {dismissBusy === key ? <Loader size={12} className="animate-spin" /> : excluded ? <Undo2 size={12} /> : <Ban size={12} />}
            </button>
          </span>
        </div>
        {/* Composition. Built server-side from the same rows as the line total,
            so these always sum to the figure above them. */}
        {open && rows.map((b) => (
          <div key={b.key} className="flex items-center justify-between py-0.5 pl-8 pr-[22px] text-[12px] text-gray-500">
            <span className="truncate">
              {b.key}
              {b.count > 1 && <span className="text-gray-400 text-[10.5px]"> ×{b.count}</span>}
            </span>
            <span className="font-mono tabular-nums">{fmt(b.total)}</span>
          </div>
        ))}
      </div>
    )
  }

  // Rename a P&L line. Not cosmetic — the name is free text on every ledger row
  // and several tables point at it, so the server migrates all of them in one
  // transaction and reports what it touched. Renaming onto an existing name
  // MERGES the two lines, which is usually the intent ("True Legal" → "Legal")
  // but is worth saying out loud before it happens.
  const [renameBusy, setRenameBusy] = useState(null)
  // What the rename actually touched. Shown rather than assumed: a rename
  // spans six tables and "updated expenses 147, report_dismissals 1" is the
  // only way to see that a standing rule moved with it.
  const [notice, setNotice] = useState('')
  const renameCategory = async (kind, key) => {
    if (renameBusy) return
    const next = window.prompt(
      `Rename the “${key}” ${kind} line to what?\n\n`
      + 'This updates every ledger row, plus any standing exclusion, learned '
      + 'booking rule and netting pointer that names it. If the new name '
      + 'already exists, the two lines MERGE.',
      key)
    if (next === null) return
    const to = next.replace(/\s+/g, ' ').trim()
    if (!to || to === key) return
    setRenameBusy(`${kind}:${key}`)
    try {
      const res = await api.post('/reports/rename-category', { kind, from: key, to })
      const d = res.data?.data || {}
      const touched = Object.entries(d.counts || {})
        .filter(([, v]) => typeof v === 'number' && v > 0)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')
      await fetchPnl()
      fetchDismissals()
      setNotice(d.merged
        ? `Merged “${key}” into “${to}”${touched ? ` — updated ${touched}` : ''}`
        : `Renamed “${key}” to “${to}”${touched ? ` — updated ${touched}` : ''}`)
    } catch (err) { alert('Rename failed: ' + (err.response?.data?.error || err.message)) }
    finally { setRenameBusy(null) }
  }

  // Dismiss a whole P&L line. A standing rule, not a snapshot: everything in
  // that line stops counting, including transactions that land there later.
  const dismissCategory = async (kind, key) => {
    if (dismissBusy) return
    const reason = window.prompt(
      `Dismiss the entire “${key}” line?\n\n`
      + `This REMOVES it from ${kind === 'income' ? 'Total Income' : 'Total Expenses'} and keeps removing anything `
      + `booked to it in future — it is a standing rule, not a one-off.\n\nReason (optional):`)
    if (reason === null) return // cancelled
    setDismissBusy(`cat:${kind}:${key}`)
    try {
      await api.post('/reports/dismiss', { scope: 'category', cell_kind: kind, cell_key: key, ...(reason ? { reason } : {}) })
      fetchPnl()
      if (dismissals !== null) fetchDismissals()
    } catch (err) { alert('Failed to dismiss: ' + (err.response?.data?.error || err.message)) }
    finally { setDismissBusy(null) }
  }
  const restoreCategory = async (kind, key) => {
    if (dismissBusy) return
    setDismissBusy(`cat:${kind}:${key}`)
    try {
      await api.post('/reports/dismiss/restore', { scope: 'category', cell_kind: kind, cell_key: key })
      await fetchDismissals()
      fetchPnl()
    } catch (err) { alert('Failed to restore: ' + (err.response?.data?.error || err.message)) }
    finally { setDismissBusy(null) }
  }

  const restoreDismissal = async (id) => {
    if (dismissBusy) return
    setDismissBusy(id)
    try {
      await api.post('/reports/dismiss/restore', { id })
      await fetchDismissals()
      if (tab === 'pnl') fetchPnl()
    } catch (err) { alert('Failed to restore: ' + (err.response?.data?.error || err.message)) }
    finally { setDismissBusy(null) }
  }

  // Recategorize straight from a drill row: booked/matched rows update the
  // ledger family (or income row); unbooked bank rows get BOOKED with the
  // chosen category/type. Cell totals move, so both drill + P&L refetch.
  const [drillBusy, setDrillBusy] = useState(null)
  // Bulk recategorize: check rows (or select all), pick once, apply to all.
  const [drillSel, setDrillSel] = useState(new Set())
  // ── Filter inside a drill-down ────────────────────────────────────────────
  // A single cell can hold 50+ rows (Services over eight months is 56), so the
  // modal needs a way in. Everything downstream reads the FILTERED list, not
  // drillData.rows: the Review button's count and the deck it opens, select-all,
  // and the bulk apply. A filter that narrowed the list but left "Review 56"
  // and "Select all" meaning all 56 would be a trap.
  const [drillQ, setDrillQ] = useState('')
  const drillRows = drillData?.rows || []
  // Collapsed by default: the point is that deposits stop sitting among the
  // expense rows, and it reopens per cell rather than staying open across them.
  const [recOpen, setRecOpen] = useState(false)
  // Sort, applied to the whole FILTERED set rather than to what happens to be
  // rendered — sorting a page would just reshuffle the rows you can already see
  // and leave the biggest number 300 rows down.
  //
  // Each key carries the direction that is useful first: names A→Z, money
  // largest first, dates earliest first. Clicking the active key flips it, so
  // "which is the smallest" is one click and not a missing feature.
  const [drillSort, setDrillSort] = useState({ key: 'date', dir: 1 })
  const toggleSort = (key, defaultDir) => setDrillSort((p) => (
    p.key === key ? { key, dir: -p.dir } : { key, dir: defaultDir }
  ))

  const drillShown = drillRows.filter((r) => matchesQuery(drillQ, [
    r.payee, r.artist, r.song, r.invoice_number, r.source, r.amount, r.usd, r.currency, r.date,
  ])).slice().sort(drillComparator(drillSort))
  // Sum of what's visible. The header keeps showing the true cell total; this
  // sits beside it, never in place of it.
  const drillShownTotal = drillShown.reduce((s, r) => s + (Number(r.usd) || 0), 0)
  // Prune the selection to what's visible whenever the query changes. Without
  // this you could select rows, narrow the filter, hit Apply, and recategorize
  // rows you can no longer see.
  useEffect(() => {
    setDrillSel((prev) => {
      if (!prev.size) return prev
      const visible = new Set(drillShown.map((r) => r.id))
      const next = new Set([...prev].filter((id) => visible.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [drillQ]) // eslint-disable-line react-hooks/exhaustive-deps
  const [bulkCat, setBulkCat] = useState('')
  const [bulkArtist, setBulkArtist] = useState('')
  const [roster, setRoster] = useState([])
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkProgress, setBulkProgress] = useState(null) // { done, total }
  const applyBulk = async () => {
    if (!bulkCat || bulkBusy || !drillSel.size) return
    // Visible AND selected — the selection is pruned on filter change too,
    // this is the belt to that braces.
    const rows = drillShown.filter((r) => drillSel.has(r.id))
    setBulkBusy(true)
    setBulkProgress({ done: 0, total: rows.length })
    const errors = []
    for (const r of rows) {
      try {
        if (drill.kind === 'income') {
          if (r.income_id) await api.post('/reports/recategorize', { income_id: r.income_id, category: bulkCat })
          else await api.post(`/statements/tx/${r.txn_id}/book-income`, { income_type: bulkCat })
        } else {
          if (r.expense_id) await api.post('/reports/recategorize', { expense_id: r.expense_id, category: bulkCat })
          else await api.post(`/statements/tx/${r.txn_id}/create-entry`, { category: bulkCat })
        }
      } catch (err) { errors.push(`${r.payee}: ${err.response?.data?.error || err.message}`) }
      setBulkProgress((p) => (p ? { ...p, done: p.done + 1 } : p))
    }
    setBulkProgress(null)
    setBulkBusy(false)
    await openDrill(drill.kind, drill.key, drill.month, drill.category, { keys: drill.keys, label: drill.label })
    if (tab === 'pnl') fetchPnl()
    if (errors.length) alert(`${rows.length - errors.length} moved, ${errors.length} failed:\n` + errors.slice(0, 5).join('\n'))
  }
  // ── Attribute spend to an artist ─────────────────────────────────────────
  //
  // The sibling of recategorize below: that answers "what kind of spend is
  // this", this answers "who was it for" — the question $2.64M of the ledger
  // can't currently answer, which is why Spend by Artist covers a fraction of
  // real spending.
  //
  // One server call for any number of rows, so "apply to all 569" is a single
  // request rather than 569, and it reaches past the 500-row render cap by
  // using the ids the drill already returned for the whole cell.
  // The bulk pickers need a value meaning "no artist" that they can HOLD and
  // display until Apply is pressed. Empty string can't: it reads as "nothing
  // chosen" and disables the button, which is why clearing a selection was
  // impossible. The label doubles as the value so the trigger reads correctly.
  const NO_ARTIST = '— no artist —'

  const setArtist = async (expenseIds, artist, { rowId } = {}) => {
    // Nulls can reach here from a mapped selection; writing one would 400 the
    // whole batch and lose the rest of it.
    const ids = (expenseIds || []).filter(Boolean)
    if (!ids.length || drillBusy || bulkBusy) return
    expenseIds = ids
    const many = expenseIds.length > 1
    if (many && !window.confirm(
      `${artist ? `Attribute ${expenseIds.length} entries to "${artist}"` : `Clear the artist on ${expenseIds.length} entries`}?\n\n`
      + 'This edits the ledger. It moves the spend between buckets on Spend by Artist; it does not change any total.')) return
    if (rowId) setDrillBusy(rowId); else setBulkBusy(true)
    try {
      const { data } = await api.post('/reports/set-artist', { expense_ids: expenseIds, artist })
      if (data.data?.skipped) {
        alert(`${data.data.updated} of ${data.data.requested} updated — ${data.data.skipped} had already changed (deleted or voided) and were left alone.`)
      }
      // A split family stores its slices twice. If the server could not tell
      // which stored slice this row is, the ledger moved and the copy the split
      // editor reads did not — say so rather than leaving it to be found later.
      if (data.data?.breakdowns_stale?.length) {
        const b = data.data.breakdowns_stale[0]
        alert(`Artist updated on the ledger.\n\nThe stored split breakdown on payment #${b.root} was left alone: ${b.reason}.`
          + '\n\nRe-cut that split on Bank Matching if the breakdown editor needs to agree.')
      }
      await openDrill(drill.kind, drill.key, drill.month, drill.category, { keys: drill.keys, label: drill.label })
      if (tab === 'pnl') fetchPnl()
      setBulkArtist('')
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setDrillBusy(null); setBulkBusy(false) }
  }

  const recategorize = async (r, value) => {
    if (!value || drillBusy) return
    setDrillBusy(r.id)
    try {
      if (drill.kind === 'income') {
        if (r.income_id) await api.post('/reports/recategorize', { income_id: r.income_id, category: value })
        else await api.post(`/statements/tx/${r.txn_id}/book-income`, { income_type: value })
      } else {
        // The PART(S) this cell is about — on an unsplit row that is the family
        // root itself, and on a payment wholly inside this cell it is every
        // slice, because moving one and leaving the rest is what the old code did.
        const targets = editableHere(r) ? partIdsOf(r) : []
        if (targets.length) {
          for (const id of targets) await api.post('/reports/recategorize', { expense_id: id, category: value })
        } else if (r.txn_id) {
          await api.post(`/statements/tx/${r.txn_id}/create-entry`, { category: value })
        }
      }
      await openDrill(drill.kind, drill.key, drill.month, drill.category, { keys: drill.keys, label: drill.label })
      if (tab === 'pnl') fetchPnl()
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setDrillBusy(null) }
  }

  // ── Reassign the month a row is REPORTED in ───────────────────────────────
  // The bank row keeps its real date; only the P&L column changes. Both the
  // cell it leaves and the cell it joins move, so the drill and the report both
  // refetch — same contract as recategorize above.
  //
  // Choosing the row's own bank month removes the override, so "put it back" is
  // this same control rather than a separate undo somebody has to find.
  const monthsForReassign = () => {
    // The reported range plus three months either side. Period-end adjustments
    // routinely cross the edge of the range you happen to be looking at, and
    // moving outside it is allowed — the report discloses it.
    const step = (y, m, n) => { let t = y * 12 + (m - 1) + n; return [Math.floor(t / 12), (t % 12) + 1] }
    let [y, m] = step(...from.slice(0, 7).split('-').map(Number), -3)
    const [ey, em] = step(...to.slice(0, 7).split('-').map(Number), 3)
    const out = []
    while (y < ey || (y === ey && m <= em)) {
      out.push(`${y}-${String(m).padStart(2, '0')}`)
      ;[y, m] = step(y, m, 1)
    }
    return out
  }
  const reassignMonth = async (r, month) => {
    if (drillBusy || !r.txn_id) return
    setDrillBusy(r.id)
    try {
      await api.post('/reports/reassign-month', { txn_id: r.txn_id, target_month: month || null })
      await openDrill(drill.kind, drill.key, drill.month, drill.category, { keys: drill.keys, label: drill.label })
      if (tab === 'pnl') fetchPnl()
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setDrillBusy(null) }
  }

  const [bulkMonth, setBulkMonth] = useState('')
  const applyBulkMonth = async () => {
    if (!bulkMonth || bulkBusy || !drillSel.size) return
    const rows = drillShown.filter((r) => drillSel.has(r.id) && r.txn_id)
    if (!rows.length) return
    setBulkBusy(true)
    setBulkProgress({ done: 0, total: rows.length })
    const errors = []
    for (const r of rows) {
      try {
        await api.post('/reports/reassign-month', { txn_id: r.txn_id, target_month: bulkMonth })
      } catch (err) { errors.push(`${r.payee}: ${err.response?.data?.error || err.message}`) }
      setBulkProgress((p) => (p ? { ...p, done: p.done + 1 } : p))
    }
    setBulkProgress(null)
    setBulkBusy(false)
    await openDrill(drill.kind, drill.key, drill.month, drill.category, { keys: drill.keys, label: drill.label })
    if (tab === 'pnl') fetchPnl()
    if (errors.length) alert(`${rows.length - errors.length} moved, ${errors.length} failed:\n` + errors.slice(0, 5).join('\n'))
  }

  // ── Review deck over a drill cell — the statements-deck flow pointed at
  //    one report line: card per item, → accept · ← skip · ⌫ undo · 1-9
  //    pick category · Esc close. Rows are snapshotted at open; the drill
  //    and P&L refetch on close.
  const [revDeck, setRevDeck] = useState(null) // { rows, index, sel, history, changed }
  // The document panel beside the card, on the same shared setting as the other
  // two decks — this is one preference, not three.
  const [previewOn, togglePreview] = useDeckPreview()
  const [revBusy, setRevBusy] = useState(false)
  // Ordered by how often each category is actually used, so the deck's 1-9 keys
  // and the numbers printed in its dropdown mean the same thing — and the same
  // thing they mean in the statements deck. Stable sort keeps the canonical
  // order for anything unused.
  const revOpts = () => {
    const base = drill?.kind === 'income' ? catIncome : catExpense
    const usage = pnl?.category_usage
    if (!usage) return base
    return [...base].sort((a, b) => (usage[b] || 0) - (usage[a] || 0))
  }
  const revDefaultSel = () => (revOpts().includes(drill?.key) ? drill.key : '')
  // WHICH ledger rows a drill row edits. There are three shapes, and measuring
  // production is what turned up the third.
  //
  //   1. Unsplit — one entry, the family root. What this page always did.
  //   2. A split payment whose parts land in DIFFERENT cells. This cell is about
  //      one part, `part_expense_ids` names it, and an edit here moves that part
  //      and leaves the rest of the payment alone. `split_of` is set, because this
  //      cell's share is less than the payment.
  //   3. A split payment whose parts ALL land in THIS cell — split by artist
  //      inside one category, say. `split_of` is NULL (the cell holds the whole
  //      payment) and there are several part ids. Editing means all of them:
  //      writing only the root, which is what this page used to do, moved one
  //      slice and quietly left the others behind.
  //
  // Measured on the live report across seven cells: 20 rows are one cell's SHARE
  // of a split payment (9 naming a single part, 11 naming several) and 42 MORE are
  // shape 3 — one with five parts. Treating "several ids" as "nothing to act on"
  // disabled the controls on all 42, money that is perfectly answerable here.
  const partIdsOf = (r) => {
    const parts = r?.part_expense_ids
    if (Array.isArray(parts) && parts.length) return parts
    return r?.expense_id ? [r.expense_id] : []
  }
  // Can this row be answered HERE? Only if the cell holds either the whole
  // payment or exactly one part of it. A cell holding SOME of a split payment's
  // parts (an artist cell spanning two categories) has no single answer, so it
  // goes to Bank Matching where all of it is visible.
  const editableHere = (r) => {
    const ids = partIdsOf(r)
    return ids.length === 1 || (ids.length > 1 && !r?.split_of)
  }
  const isAmbiguousSplit = (r) => !!r?.split_of && partIdsOf(r).length !== 1
  // The single id for the paths that genuinely take one (recategorize, which is
  // one row per call). Null when the row spans several parts.
  const partIdOf = (r) => (editableHere(r) ? (partIdsOf(r).length === 1 ? partIdsOf(r)[0] : null) : null)
  const revHasRecord = (r) => (drill?.kind === 'income' ? r.income_id : (editableHere(r) ? partIdsOf(r).length : 0))
  const openReviewDeck = () => {
    if (!drillShown.length) return
    setRevDeck({ rows: drillShown, index: 0, sel: revDefaultSel(), history: [], changed: 0 })
  }
  // What the deck is WORTH, in three readings — all reduced over the deck's own
  // snapshot, never over `drillData.total`.
  //
  // The snapshot is `drillShown` at open, so a filtered drill opens a filtered
  // deck: taking the denominator from the cell would put "$12k of $188k" above a
  // deck that only holds $61k of it, and the bar would never reach the end.
  // Summary and list, same set — a rule this page has already broken twice.
  //
  // `usd` is signed: a recovery row (a reimbursement received) is negative, which
  // is how buildPnl nets it off the line. It stays negative here.
  const revSum = (rows) => (rows || []).reduce((t, x) => t + (Number(x?.usd) || 0), 0)
  const revMoney = revDeck ? {
    total: revSum(revDeck.rows),
    // Cards already passed, whatever was decided about them.
    done: revSum(revDeck.rows.slice(0, revDeck.index)),
    // Money actually changed. Derived from `history`, so ⌫ reverses it by the
    // same act that reverses the count — a separate counter would need undoing
    // in two places and would eventually disagree with itself.
    changed: revSum(revDeck.history.filter((h) => h.applied).map((h) => h.row)),
  } : null
  const revAdvance = (entry) => setRevDeck((d) => (d ? {
    ...d, index: d.index + 1, sel: revDefaultSel(),
    history: entry ? [...d.history, entry] : d.history,
    changed: d.changed + (entry?.applied ? 1 : 0),
  } : d))
  const revAccept = async () => {
    if (!revDeck || revBusy) return
    const r = revDeck.rows[revDeck.index]
    if (!r) return
    const sel = revDeck.sel
    const hasRecord = revHasRecord(r)
    // No change (or nothing picked for a booked row) = keep as-is, advance.
    if (!sel || (hasRecord && sel === drill.key)) { revAdvance({ index: revDeck.index, applied: false }); return }
    setRevBusy(true)
    try {
      if (drill.kind === 'income') {
        if (r.income_id) await api.post('/reports/recategorize', { income_id: r.income_id, category: sel })
        else await api.post(`/statements/tx/${r.txn_id}/book-income`, { income_type: sel })
      } else {
        // The PARTS this cell is about — never r.expense_id. The deck had no
        // split guard at all: a split row posted the FAMILY ROOT's id, so
        // accepting a category on the Royalties card silently retyped whichever
        // part the root was. The drill list has refused to edit splits since it
        // shipped; the deck was quietly doing the thing the list was avoiding.
        const targets = editableHere(r) ? partIdsOf(r) : []
        if (targets.length) {
          for (const id of targets) await api.post('/reports/recategorize', { expense_id: id, category: sel })
        } else if (r.txn_id) {
          await api.post(`/statements/tx/${r.txn_id}/create-entry`, { category: sel })
        }
      }
      revAdvance({ index: revDeck.index, applied: true, kind: hasRecord ? 'recat' : 'book', old: drill.key, row: r })
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setRevBusy(false) }
  }
  const revBack = async () => {
    if (!revDeck || revBusy) return
    const prev = revDeck.history[revDeck.history.length - 1]
    if (!prev) return
    setRevBusy(true)
    try {
      if (prev.applied) {
        const r = prev.row
        if (prev.kind === 'dismiss') {
          // Undo of a dismissal is a restore — NOT an unbook. Without this
          // branch it would fall through below and try to unbook a row that
          // was never booked by the deck.
          await api.post('/reports/dismiss/restore',
            r.txn_id ? { txn_id: r.txn_id } : { expense_id: r.expense_id })
        } else if (prev.kind === 'recat') {
          // Undo the same rows the accept wrote — the parts, not the root.
          if (drill.kind === 'income') {
            await api.post('/reports/recategorize', { income_id: r.income_id, category: prev.old })
          } else {
            for (const id of partIdsOf(r)) await api.post('/reports/recategorize', { expense_id: id, category: prev.old })
          }
        } else if (drill.kind === 'income') {
          await api.post(`/statements/tx/${r.txn_id}/unbook-income`)
        } else {
          await api.post(`/statements/tx/${r.txn_id}/unbook`)
        }
      }
      setRevDeck((d) => (d ? {
        ...d, index: prev.index, sel: revDefaultSel(),
        history: d.history.slice(0, -1), changed: d.changed - (prev.applied ? 1 : 0),
      } : d))
    } catch (err) { alert('Failed to undo: ' + (err.response?.data?.error || err.message)) }
    finally { setRevBusy(false) }
  }
  // Reassign the month from the deck. Does NOT advance — like Flag, this is an
  // adjustment to the card, not a verdict on it; you may still want to
  // recategorize the same row before moving on.
  //
  // Rows are snapshotted at open, so the snapshot is patched in place. Without
  // that the card would keep showing the old month right after you changed it,
  // which reads as the change having failed.
  const revMonth = async (month) => {
    if (!revDeck || revBusy || !month) return
    const r = revDeck.rows[revDeck.index]
    if (!r || !r.txn_id) return
    setRevBusy(true)
    try {
      await api.post('/reports/reassign-month', { txn_id: r.txn_id, target_month: month })
      const realMonth = String(r.date || '').slice(0, 7)
      setRevDeck((d) => (d ? {
        ...d,
        rows: d.rows.map((x, i) => (i === d.index
          ? { ...x, report_month: month, moved_from: month === realMonth ? null : realMonth }
          : x)),
      } : d))
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setRevBusy(false) }
  }
  // Dismiss from the deck — same action and same D key as the statements
  // deck. Advances, because dismissing IS a decision about the card. The
  // card is snapshotted at open, so the dismissed row stays in this run's
  // array; the drill and P&L refetch on close.
  const revDismiss = async () => {
    if (!revDeck || revBusy) return
    const r = revDeck.rows[revDeck.index]
    if (!r || !(r.txn_id || r.expense_id)) return
    setRevBusy(true)
    try {
      await api.post('/reports/dismiss', {
        ...(r.txn_id ? { txn_id: r.txn_id } : { expense_id: r.expense_id }),
        cell_kind: drill?.kind || null,
        cell_key: drill?.key || null,
      })
      revAdvance({ index: revDeck.index, applied: true, kind: 'dismiss', row: r })
    } catch (err) { alert('Failed to dismiss: ' + (err.response?.data?.error || err.message)) }
    finally { setRevBusy(false) }
  }

  // Flag toggle — same marker as the statements deck (bank_transactions
  // .flagged); stays on the card, no advance.
  const revFlag = async () => {
    if (!revDeck || revBusy) return
    const r = revDeck.rows[revDeck.index]
    if (!r?.txn_id) return
    setRevBusy(true)
    try {
      const next = !r.flagged
      await api.post(`/statements/tx/${r.txn_id}/flag`, { flag: next })
      r.flagged = next
      setRevDeck((d) => (d ? { ...d } : d))
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setRevBusy(false) }
  }
  const closeRevDeck = async () => {
    const had = revDeck?.changed > 0
    setRevDeck(null)
    if (drill) await openDrill(drill.kind, drill.key, drill.month, drill.category, { keys: drill.keys, label: drill.label })
    if (had && tab === 'pnl') fetchPnl()
  }
  useEffect(() => {
    if (!revDeck) return
    const h = (e) => {
      if (e.target.tagName === 'SELECT' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return
      // Typing is not a command. CategorySelect can open a text input to create a
      // category inline, and without this every letter in "Production" was also a
      // deck action — d dismissed the row, f flagged it, digits reassigned it.
      // The statements deck has had this guard since it was built; this one
      // didn't, and P would have been one more way to trip it.
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'Escape') { e.preventDefault(); closeRevDeck() }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); revAccept() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); if (revDeck.index < revDeck.rows.length) revAdvance({ index: revDeck.index, applied: false }) }
      else if (e.key === 'Backspace') { e.preventDefault(); revBack() }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); revFlag() }
      else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); revDismiss() }
      else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); togglePreview() }
      else if (/^[1-9]$/.test(e.key)) { const o = revOpts()[Number(e.key) - 1]; if (o) setRevDeck((d) => (d ? { ...d, sel: o } : d)) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  const exportExcel = async () => {
    if (exporting) return
    setExporting(true)
    try {
      const url = tab === 'pnl'
        ? `/reports/pnl/export?from=${from}&to=${to}&basis=${basis}${artistF ? `&artist=${encodeURIComponent(artistF)}` : ''}`
        : tab === 'artists'
          ? `/reports/spend-by-artist/export?from=${from}&to=${to}&topN=${artistTopN}&basis=${basis}`
          : `/reports/balance-sheet/export?as_of=${asOf}`
      const res = await api.get(url, { responseType: 'blob' })
      const blob = new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = tab === 'pnl' ? `marketst-pnl-${from}-to-${to}.xlsx`
        : tab === 'artists' ? `marketst-spend-by-artist-${from}-to-${to}.xlsx`
        : `marketst-balance-sheet-${asOf}.xlsx`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(a.href)
    } catch (err) { setError(err.response?.data?.error || err.message) }
    finally { setExporting(false) }
  }

  // One long-lived spreadsheet, refreshed in place — the URL stays the same so
  // it can be bookmarked and shared with the accountant once. Both tabs are
  // written every time, so they are never as-of different runs.
  const exportSheet = async () => {
    if (sheeting) return
    setSheeting(true)
    setError('')
    try {
      const res = await api.post('/reports/export-google-sheet', {
        from, to, as_of: asOf, artist: artistF || undefined,
      })
      const d = res.data?.data || {}
      setSheet({ url: d.url, at: d.refreshed_at, created: d.created, warning: d.share_warning })
      // Opened rather than just linked: the click asked to see the sheet. A
      // popup blocker only costs the new tab — the link below survives.
      if (d.url) window.open(d.url, '_blank', 'noopener')
    } catch (err) { setError(err.response?.data?.error || err.message) }
    finally { setSheeting(false) }
  }

  const inputCls = 'border border-rule rounded-lg px-3 py-1.5 text-sm bg-card text-ink'
  const cellR = 'px-2 py-1.5 text-right font-mono text-[12.5px] whitespace-nowrap'
  const drillCell = 'cursor-pointer hover:bg-boom-50/40 hover:text-boom-700'
  const below = pnl?.below || { income: {}, expenses: {}, income_totals: { series: {}, total: 0 }, expense_totals: { series: {}, total: 0 }, net: { series: {}, total: 0 } }
  const hasBelow = Object.keys(below.income).length > 0 || Object.keys(below.expenses).length > 0
  // Same defensive shape as `below`: an older server answers without this key,
  // and an unguarded read here white-pages the whole report.
  const nonRec = pnl?.non_recurring || { income: {}, expenses: {}, income_totals: { series: {}, total: 0 }, expense_totals: { series: {}, total: 0 }, net: { series: {}, total: 0 } }
  const hasNonRec = Object.keys(nonRec.income).length > 0 || Object.keys(nonRec.expenses).length > 0

  // Category/type line rows for both sections — cells drill down on click.
  // Per-cell excluded amount, keyed the way the server buckets it. Shown on
  // the line label so a total that's been reduced says so in place, rather
  // than only in an aggregate somewhere else on the page.
  const cellDismissed = (kind, key) => pnl?.dismissed?.by_cell?.[`${kind}:${key}`] || null

  // ── Filter the P&L's own lines ────────────────────────────────────────────
  // Matches the line NAME only. The cells are twelve monthly figures plus a
  // total, so "matching a line by amount" would be ambiguous — amounts live in
  // the drill-down.
  //
  // The honesty problem this creates: Total Income / Total Expenses / Net come
  // from the server over EVERY line, so a view filtered to two lines still
  // shows a total covering all of them. Left alone that reads as the sum of
  // what's on screen. So while a filter is active the real totals are relabelled
  // "(all lines)" and a separate subtotal row shows the visible lines' sum.
  const [pnlQ, setPnlQ] = useState('')
  const filtering = pnlQ.trim().length > 0

  // ── Line-ITEM search ──────────────────────────────────────────────────────
  // The filter above only sees category names, because that's all /reports/pnl
  // returns. Typing a payee like "Venable" against it matches nothing, which
  // reads as "this vendor has no spend" — the opposite of the truth. So the
  // same box also queries /reports/search, which looks inside the cells.
  const [itemHits, setItemHits] = useState(null) // null = not searched
  const [itemBusy, setItemBusy] = useState(false)
  const itemTimer = useRef(null)
  const itemReq = useRef(0)
  useEffect(() => {
    if (itemTimer.current) clearTimeout(itemTimer.current)
    const q = pnlQ.trim()
    if (tab !== 'pnl' || q.length < 2) { setItemHits(null); return }
    // Debounced: this hits the statements master, so it shouldn't fire per
    // keystroke.
    itemTimer.current = setTimeout(async () => {
      // Debouncing cancels the TIMER, not a request already in flight. Without
      // a token, typing "ven" then "venable" can let the slower "ven" response
      // land last and render its rows and money under the "venable" heading.
      const req = ++itemReq.current
      setItemBusy(true)
      try {
        const res = await api.get('/reports/search', {
          params: { q, from, to, ...(artistF ? { artist: artistF } : {}) },
        })
        if (req !== itemReq.current) return
        setItemHits(res.data.data)
      } catch { if (req === itemReq.current) setItemHits(null) }
      finally { if (req === itemReq.current) setItemBusy(false) }
    }, 300)
    return () => { if (itemTimer.current) clearTimeout(itemTimer.current) }
  }, [pnlQ, tab, from, to, artistF]) // eslint-disable-line react-hooks/exhaustive-deps
  const visibleEntries = (byKey) => Object.entries(byKey).sort().filter(([k]) => matchesQuery(pnlQ, [k]))
  const allLineCount = pnl
    ? Object.keys(pnl.income).length + Object.keys(pnl.expenses).length
      + Object.keys(below.income || {}).length + Object.keys(below.expenses || {}).length
    : 0
  const shownLineCount = pnl
    ? visibleEntries(pnl.income).length + visibleEntries(pnl.expenses).length
      + visibleEntries(below.income || {}).length + visibleEntries(below.expenses || {}).length
    : 0

  // Sum of the VISIBLE lines only — rendered as its own row, never in place of
  // a real total.
  const subtotalOf = (byKey) => {
    const series = {}
    let total = 0
    for (const m of (pnl?.months || [])) series[m] = 0
    for (const [, perMonth] of visibleEntries(byKey)) {
      for (const [m, v] of Object.entries(perMonth)) {
        if (series[m] !== undefined) series[m] += v
        total += v
      }
    }
    return { series, total }
  }
  const subtotalRow = (byKey, label, negative = false) => {
    if (!filtering) return null
    const n = visibleEntries(byKey).length
    if (!n) return null
    const s = subtotalOf(byKey)
    return (
      <tr className="border-b border-divider bg-boom-50/30">
        <td className="px-3 py-1.5 text-[12px] font-bold text-boom-700 pl-6 sticky left-0 bg-boom-50/30">
          {label} — {n} matching {n === 1 ? 'line' : 'lines'}
        </td>
        {(pnl?.months || []).map((m) => (
          <td key={m} className={`${cellR} font-bold text-boom-700`}>
            {s.series[m] ? `${fmtFlow(s.series[m], negative)}` : <span className="text-gray-300">—</span>}
          </td>
        ))}
        <td className={`${cellR} font-black text-boom-700`}>{fmtFlow(s.total, negative)}</td>
      </tr>
    )
  }
  // Keeps a section header from being orphaned when nothing in it matches.
  const noMatchRow = (byKey, key) => {
    if (!filtering || visibleEntries(byKey).length) return null
    return (
      <tr key={`nomatch-${key}`} className="border-b border-divider">
        <td colSpan={(pnl?.months?.length || 0) + 2} className="px-3 py-1.5 pl-6 text-[12px] text-gray-400 italic">
          no lines match “{pnlQ}”
        </td>
      </tr>
    )
  }

  const lineRows = (byKey, kind, negative = false) => visibleEntries(byKey).map(([key, perMonth]) => (
    <tr key={`${kind}:${key}`} className="border-b border-divider group">
      <td className="px-3 py-1.5 text-[13px] text-ink pl-6 sticky left-0 bg-card">
        <span className="inline-flex items-center gap-1.5">
          <span>{key}</span>
          {/* Rename the line. Hover-revealed, like Dismiss. */}
          <button
            onClick={() => renameCategory(kind, key)}
            disabled={renameBusy === `${kind}:${key}`}
            title={`Rename “${key}” everywhere it's stored`}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-gray-300 hover:text-boom-600 disabled:opacity-40 shrink-0">
            {renameBusy === `${kind}:${key}` ? <Loader size={11} className="animate-spin" /> : <Pencil size={11} />}
          </button>
          {/* Dismiss the whole line. Hover-revealed so it doesn't compete with
              the numbers, which are what the page is for. */}
          <button
            onClick={() => dismissCategory(kind, key)}
            disabled={dismissBusy === `cat:${kind}:${key}`}
            title={`Dismiss the entire “${key}” line — stops counting toward ${kind === 'income' ? 'Total Income' : 'Total Expenses'}`}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-gray-300 hover:text-rose-600 disabled:opacity-40 shrink-0">
            {dismissBusy === `cat:${kind}:${key}` ? <Loader size={11} className="animate-spin" /> : <Ban size={11} />}
          </button>
          {(() => {
            const d = cellDismissed(kind, key)
            if (!d) return null
            return (
              <button onClick={() => setTab('dismissed')}
                title={`${d.count} item${d.count === 1 ? '' : 's'} totalling ${fmt(d.usd)} excluded from this line — click to review`}
                className="text-[10px] font-bold text-amber-600 hover:text-amber-700 underline decoration-dotted shrink-0">
                {fmtFlow(d.usd, true)}
              </button>
            )
          })()}
        </span>
      </td>
      {pnl.months.map((m) => (
        <td key={m} className={`${cellR} ${perMonth[m] ? drillCell : ''}`}
          onClick={() => perMonth[m] && openDrill(kind, key, m)}>
          {perMonth[m] ? `${fmtFlow(perMonth[m], negative)}` : <span className="text-gray-300">—</span>}
        </td>
      ))}
      <td className={`${cellR} font-bold ${drillCell}`} onClick={() => openDrill(kind, key, null)}>
        {fmtFlow(Object.values(perMonth).reduce((a, b) => a + b, 0), negative)}
      </td>
    </tr>
  ))

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-2 mb-1">
        <FileBarChart size={20} className="text-boom-600" />
        <h1 data-tour="reports-header" className="text-xl font-extrabold text-ink">Reports</h1>
        <ReconciledBadge />
      </div>
      <p className="text-sm text-gray-500 mb-2" data-basis-note>{BASIS_TEXT[basis]?.note || 'Choosing a basis…'} Click any number to see the transactions behind it.</p>
      {/* Counterpart to the basis note on Financials — the two pages use
          different date bases and different inclusion rules, so their totals
          for one range legitimately differ. Say which is which. */}
      <div className="flex flex-wrap items-center gap-3 mb-4 text-[12px] text-gray-500">
        <BasisSwitch basis={basis || 'bank'} onChange={(b) => { basisChosen.current = true; setBasis(b) }} info={basisInfo} />
        {basis !== 'accrual' && (
          <button onClick={() => { basisChosen.current = true; setBasis('accrual') }} className="text-boom-600 hover:text-boom-700 font-semibold whitespace-nowrap">
            Need unpaid commitments? Switch to accrual →
          </button>
        )}
      </div>

      {/* Aggregate exclusion notice. The whole point of "excluded but
          disclosed" — if anything has been dismissed, the reader is told
          before they read a single number, not after. */}
      {tab === 'pnl' && (pnl?.dismissed?.count > 0 || pnl?.dismissed?.category_count > 0) && (
        <div className="flex flex-wrap items-center gap-2 mb-4 px-3 py-2 rounded-lg border border-amber-200 bg-amber-50/60 text-[12.5px]">
          <AlertTriangle size={14} className="text-amber-600 shrink-0" />
          <span className="text-amber-900">
            <strong className="font-bold">{fmt(pnl.dismissed.total)}</strong> is dismissed and{' '}
            <strong className="font-bold">not counted</strong> below
            {/* Lines and items are separated because undoing them differs: a
                line is a standing rule, an item is one transaction. */}
            {(() => {
              const parts = []
              const nCat = pnl.dismissed.category_count || 0
              const nItem = pnl.dismissed.item_count ?? pnl.dismissed.count
              if (nCat) parts.push(`${nCat} whole ${nCat === 1 ? 'line' : 'lines'}`)
              if (nItem) parts.push(`${nItem} individual ${nItem === 1 ? 'item' : 'items'}`)
              return parts.length ? ` — ${parts.join(' and ')}.` : '.'
            })()}
          </span>
          <button onClick={() => setTab('dismissed')}
            className="ml-auto font-bold text-amber-800 hover:text-amber-900 whitespace-nowrap">
            Review dismissed →
          </button>
        </div>
      )}

      {/* Reversals get their own notice rather than being folded into the
          dismissal banner. A dismissal is somebody's judgment call you can undo;
          a reversal is a fact about the bank — the money came back. Different
          statements, different fixes. */}
      {tab === 'pnl' && pnl?.reversals?.count > 0 && (() => {
        // `|| []` is not paranoia: an older server (rollback, or a cached bundle
        // meeting a previous deploy) can return `reversals` without `pairs`, and
        // an unguarded .length here throws inside render — white-paging the whole
        // report rather than just this banner.
        const pairs = pnl.reversals.pairs || []
        const stillPaid = pairs.filter((p) => p.still_matched_expense_id).length
        const creditTotal = Number(pnl.reversals.credit_total) || 0
        return (
        <div className="flex flex-wrap items-center gap-2 mb-4 px-3 py-2 rounded-lg border border-indigo-200 bg-indigo-50/60 text-[12.5px]">
          <Undo2 size={14} className="text-indigo-600 shrink-0" />
          <span className="text-indigo-900">
            <strong className="font-bold">{fmt(pnl.reversals.total)}</strong> of payments were{' '}
            <strong className="font-bold">reversed</strong> and are not counted
            {pairs.length ? ` — ${pairs.length} ${pairs.length === 1 ? 'payment' : 'payments'} that came back within days.` : '.'}
            {/* Both legs leave the report, so a reversal can pull Total Income
                down as well as Total Expenses. Saying only the debit side would
                leave the income movement unexplained. */}
            {creditTotal > 0 && ` The matching ${fmt(creditTotal)} of returned money is excluded from income too.`}
            {/* The ledger still thinks these bills are paid. That's a worse
                problem than the report, so it doesn't get buried. */}
            {stillPaid > 0 && (
              <strong className="font-bold">{` ${stillPaid} still marked paid on the ledger.`}</strong>
            )}
          </span>
          {/* Statements, not Flags. The reversal cards live on the statements
              review deck; /flags has no reversal section at all, so the old
              target was a link that appeared to offer a fix and delivered none. */}
          <Link to="/bk/statements" className="ml-auto font-bold text-indigo-800 hover:text-indigo-900 whitespace-nowrap">
            Review reversals →
          </Link>
        </div>
        )
      })()}

      {/* Month reassignments. Two different facts, deliberately worded apart:
          money moved BETWEEN columns is still counted, money moved OUT of the
          range is gone from every total on this page. The second one is the
          reason this banner exists at all — sumSeries drops month keys it
          doesn't recognise, so nothing else would ever mention it again. */}
      {tab === 'pnl' && (pnl?.reassigned?.count > 0 || pnl?.reassigned?.moved_out?.count > 0) && (() => {
        // Same guard as the reversal banner above, for the same reason: an older
        // server can answer without `reassigned` and an unguarded read here
        // white-pages the whole report instead of just this strip.
        const ra = pnl.reassigned || {}
        const out = ra.moved_out || { count: 0, total: 0 }
        return (
          <div className="flex flex-wrap items-center gap-2 mb-4 px-3 py-2 rounded-lg border border-violet-200 bg-violet-50/60 text-[12.5px]">
            <CalendarClock size={14} className="text-violet-600 shrink-0" />
            <span className="text-violet-900">
              {ra.count > 0 && (
                <>
                  <strong className="font-bold">{ra.count}</strong>{' '}
                  {ra.count === 1 ? 'item is' : 'items are'} reported in a different month than{' '}
                  {ra.count === 1 ? 'its' : 'their'} bank date — <strong className="font-bold">{fmt(ra.total)}</strong> moved between columns.
                </>
              )}
              {out.count > 0 && (
                <strong className="font-bold">
                  {ra.count > 0 ? ' ' : ''}
                  {out.count} {out.count === 1 ? 'item' : 'items'} ({fmt(out.total)}) moved OUTSIDE this date range and {out.count === 1 ? 'is' : 'are'} not in any total below.
                </strong>
              )}
            </span>
          </div>
        )
      })()}

      <div data-tour="reports-controls" className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex gap-1">
          {[['pnl', 'Profit & Loss'], ['bs', 'Balance Sheet'], ['artists', 'Spend by Artist'], ['vendors', 'Vendors'], ['reps', 'Reps'], ['budget', 'Budget vs actual'], ['dismissed', 'Dismissed']].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold border ${tab === key ? 'border-boom-600 text-boom-600 bg-boom-50/40' : 'border-rule text-gray-500 bg-card'}`}>
              {label}
              {/* Prefer the loaded list length — it includes dismissed
                  unverified rows, which never counted toward a total and so
                  aren't in pnl.dismissed. Falls back to the P&L figure before
                  the list has been opened. */}
              {key === 'dismissed' && (dismissals?.length ?? pnl?.dismissed?.count ?? 0) > 0 && (
                <span className="ml-1.5 text-[10px] font-bold text-amber-600">
                  {dismissals?.length ?? pnl.dismissed.count}
                </span>
              )}
            </button>
          ))}
        </div>
        {tab === 'pnl' ? (
          <>
            {/* max/min so the two cannot be crossed. A backwards range used to
                produce a confident, downloadable, EMPTY report on every surface
                rather than an error; the server refuses it now, and this stops
                it being asked for. */}
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
            <span className="text-gray-400 text-sm">→</span>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={inputCls} />
            <select value={artistF} onChange={(e) => { setArtistF(e.target.value); fetchPnl(e.target.value) }}
              className={`${inputCls} max-w-[180px]`}>
              <option value="">All artists</option>
              {(pnl?.artists || []).map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <button onClick={() => fetchPnl()} className="border border-rule rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-600 hover:bg-gray-50">Run</button>
            <select value={gran} onChange={(e) => setGran(e.target.value)} className={inputCls} title="Column granularity" data-gran>
              <option value="month">Months</option>
              <option value="quarter">Quarters</option>
              <option value="year">Years</option>
            </select>
            <select value={compare} onChange={(e) => setCompare(e.target.value)} className={inputCls} title="Compare with an earlier range, same basis" data-compare>
              <option value="none">No comparison</option>
              <option value="prior">vs previous period</option>
              <option value="yoy">vs same period last year</option>
            </select>
            <button onClick={() => setShowCharts((v) => !v)} className={`border rounded-lg px-3 py-1.5 text-sm font-semibold ${showCharts ? 'border-boom-600 text-boom-600 bg-boom-50/40' : 'border-rule text-gray-600 hover:bg-gray-50'}`} data-charts-toggle>Charts</button>
            {/* Filters the P&L's own lines. Purely client-side over the loaded
                report, so it needs no Run — unlike the date range and artist
                filters beside it, which refetch. */}
            {pnl && allLineCount > 0 && (
              <ListSearch
                value={pnlQ}
                onChange={setPnlQ}
                placeholder="Search lines or line items — category, vendor, amount…"
                count={shownLineCount}
                total={allLineCount}
                width={250}
              />
            )}
          </>
        ) : tab === 'bs' ? (
          <>
            <span className="text-sm text-gray-500">As of</span>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className={inputCls} />
            <button onClick={fetchBs} className="border border-rule rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-600 hover:bg-gray-50">Run</button>
          </>
        ) : tab === 'dismissed' ? (
          <button onClick={fetchDismissals} className="border border-rule rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-600 hover:bg-gray-50">Refresh</button>
        ) : (
          <>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
            <span className="text-gray-400 text-sm">→</span>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={inputCls} />
            {(tab === 'vendors' || tab === 'reps') && (
              <select value={gran} onChange={(e) => setGran(e.target.value)} className={inputCls} data-gran>
                <option value="month">Months</option><option value="quarter">Quarters</option><option value="year">Years</option>
              </select>
            )}
            <button onClick={() => (tab === 'artists' ? fetchArtists() : tab === 'budget' ? fetchBva() : fetchSpendBy(tab === 'reps' ? 'rep' : 'vendor'))} className="border border-rule rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-600 hover:bg-gray-50">Run</button>
            <ListSearch value={pnlQ} onChange={setPnlQ} placeholder={tab === 'budget' ? 'Filter artists…' : `Filter ${tab}…`} width={200} />
          </>
        )}
        {/* Neither export covers the dismissed list — there's no report to
            export, and both only know the P&L and balance-sheet shapes. */}
        {tab !== 'dismissed' && (
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setPackOpen(true)} title="One workbook for the accountant: cover, P&L, balance sheet, spend by artist / vendor / rep, dismissed — download now or send monthly"
              className="inline-flex items-center gap-1.5 border border-rule rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-600 hover:bg-gray-50" data-pack-open>
              <FileText size={14} /> Accountant pack
            </button>
            <button onClick={exportSheet} disabled={sheeting}
              title="Write both tabs into the shared Google Sheet"
              className="inline-flex items-center gap-1.5 border border-rule rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50">
              {sheeting ? <Loader size={14} className="animate-spin" /> : <Table2 size={14} />} Google Sheet
            </button>
            <button onClick={exportExcel} disabled={exporting}
              className="inline-flex items-center gap-1.5 bg-boom-600 hover:bg-boom-700 text-white rounded-lg px-3 py-1.5 text-sm font-bold disabled:opacity-50">
              {exporting ? <Loader size={14} className="animate-spin" /> : <Download size={14} />} Export Excel
            </button>
          </div>
        )}
      </div>

      {/* The sheet is one living document, so the link persists after the
          export and says when it was last written. Without the stamp there is
          no way to tell a freshly-refreshed sheet from a month-old one. */}
      {sheet?.url && (
        <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-gray-600 bg-gray-50/70 border border-rule rounded-lg px-3 py-2">
          <Table2 size={14} className="text-emerald-600 shrink-0" />
          <span>{sheet.created ? 'Created' : 'Refreshed'} {sheet.at ? new Date(sheet.at).toLocaleString() : 'just now'} — both tabs.</span>
          <a href={sheet.url} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-semibold text-boom-700 hover:underline">
            Open sheet <ExternalLink size={12} />
          </a>
          {sheet.warning && (
            <span className="text-amber-700">Written, but sharing failed: {sheet.warning}</span>
          )}
        </div>
      )}

      {error && <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-lg px-3 py-2 text-sm mb-4">{error}</div>}
      {notice && (
        <div className="flex items-start gap-2 bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg px-3 py-2 text-sm mb-4">
          <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-600" />
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice('')} className="text-emerald-700 hover:text-emerald-900 shrink-0"><X size={14} /></button>
        </div>
      )}
      {loading && <div className="text-sm text-gray-400 py-8 text-center">Building report…</div>}

      {/* ── Line-item search results ──
          Appears whenever the query finds transactions, whether or not it also
          matched a category name. Grouped by the cell each item belongs to, so
          the answer to "where is this vendor's money" is the first thing read. */}
      {tab === 'pnl' && pnlQ.trim().length >= 2 && (itemBusy || itemHits) && (
        <div className="bg-card border border-rule rounded-xl mb-4 overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-divider bg-gray-50/60">
            <Search size={13} className="text-gray-400 shrink-0" />
            <span className="text-[12.5px] font-bold text-ink">
              {itemBusy && !itemHits ? 'Searching line items…'
                : itemHits?.total === 0 ? `No line items match “${pnlQ.trim()}”`
                  : `${itemHits.total} line item${itemHits.total === 1 ? '' : 's'} match “${pnlQ.trim()}”`}
            </span>
            {/* Spend and income are reported separately and each says which it
                is. They used to be added into one unlabelled figure sitting
                beside the match COUNT — so "12 line items … $55,000.00" read as
                one sentence about one set, when the count covered every match
                (dismissed, reversed, unpaid) and the money covered only the
                counted ones, mixing credits and debits into the bargain. */}
            {itemHits?.total > 0 && (() => {
              const c = itemHits.breakdown?.counted
              if (!c) return null
              const parts = []
              if (c.expense_n) parts.push(<span key="e" className="font-mono text-[12.5px] font-bold text-ink">{fmt(c.expense_usd)} spend</span>)
              if (c.income_n) parts.push(<span key="i" className="font-mono text-[12.5px] font-bold text-emerald-700">{fmt(c.income_usd)} in</span>)
              if (!parts.length) return <span className="text-[11px] font-bold text-gray-400">none counted</span>
              return <span className="flex items-center gap-2">{parts}</span>
            })()}
            {/* Why matches aren't in the figures. Without this, extra results
                just look like the total is wrong. */}
            {(() => {
              const b = itemHits?.breakdown
              if (!b) return null
              const parts = []
              if (b.dismissed.n) parts.push(`${b.dismissed.n} dismissed`)
              if (b.reversed?.n) parts.push(`${b.reversed.n} reversed`)
              if (b.unverified.n) parts.push(`${b.unverified.n} paid with no bank match`)
              if (b.unpaid.n) parts.push(`${b.unpaid.n} unpaid`)
              if (!parts.length) return null
              const extra = b.dismissed.usd + (b.reversed?.usd || 0) + b.unverified.usd + b.unpaid.usd
              return (
                <span className="text-[11px] font-bold text-amber-700"
                  title="These match your search but are not in the P&L figures — dismissed items are excluded, reversed payments came back so no money moved, unverified ones are shown but not counted, and unpaid invoices fall outside a cash-basis report.">
                  + {fmt(extra)} not counted ({parts.join(' · ')})
                </span>
              )
            })()}
            {itemHits?.truncated && (
              <span className="text-[11px] text-gray-400">showing first {itemHits.rows.length}</span>
            )}
          </div>

          {itemHits?.cells?.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-4 py-2 border-b border-divider">
              {itemHits.cells.map((c) => (
                <button key={`${c.kind}:${c.key}`} onClick={() => openDrill(c.kind, c.key, null)}
                  title={`Open the ${c.key} cell`}
                  className="inline-flex items-center gap-1.5 border border-rule rounded-lg px-2 py-1 text-[11.5px] font-semibold text-gray-600 hover:border-boom-300 hover:text-boom-700">
                  {c.key}
                  <span className="font-mono text-[11px] text-gray-400">{fmt(c.usd)}</span>
                  {/* ×N must count the rows the money covers. It used to show
                      every match while the amount excluded dismissed and
                      reversed ones, so the pair didn't describe one set. */}
                  <span className="text-[10px] text-gray-400">
                    ×{c.count - (c.dismissed || 0) - (c.reversed || 0)}
                    {(c.dismissed || c.reversed) ? <span className="text-amber-600"> +{(c.dismissed || 0) + (c.reversed || 0)} excl</span> : null}
                  </span>
                </button>
              ))}
            </div>
          )}

          {itemHits?.rows?.length > 0 && (
            <div className="max-h-[280px] overflow-y-auto">
              {itemHits.rows.map((r) => (
                <div key={r.id} className={`flex items-center gap-3 px-4 py-1.5 border-b border-divider text-[12.5px] ${r.dismissed || r.reversed ? 'opacity-60' : ''}`}>
                  <span className="font-mono text-[11px] text-gray-400 shrink-0 w-[76px]">{fmtDay(r.date)}</span>
                  <span className="min-w-0 flex-1">
                    <PayeeLink payee={r.payee} className="block font-semibold text-ink truncate" />
                    {(r.artist || r.song || r.invoice_number) && (
                      <span className="block text-[11px] text-gray-400 truncate">
                        {[r.artist, r.song, r.invoice_number ? `inv ${r.invoice_number}` : null].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                  {/* Unpaid invoices have no drill to open: the P&L is cash
                      basis, so its cells exclude them by construction and the
                      modal came up "No entries." on a row the page had just
                      shown. Rendered as a plain label instead of a control that
                      leads nowhere. */}
                  {r.origin === 'unpaid' ? (
                    <span className="shrink-0 text-[11px] font-semibold text-gray-400" title="Unpaid — not in the cash-basis P&L, so there is no cell to open">
                      {r.key}
                    </span>
                  ) : (
                  <button onClick={() => openDrill(r.origin === 'ledger-unverified' ? 'unverified' : r.kind, r.key, r.origin ? null : r.month)}
                    title={r.origin ? `Open ${r.key}` : `Open ${r.key} · ${monthLabel(r.month || '')}`}
                    className="shrink-0 text-[11px] font-semibold text-gray-500 hover:text-boom-700 underline decoration-dotted">
                    {r.key}
                  </button>
                  )}
                  {/* Every row says whether it's in the numbers, and if not, why.
                      A search that mixes counted and uncounted money without
                      labelling each row is worse than one that hides the
                      uncounted rows entirely. */}
                  {r.dismissed && (
                    <span className="shrink-0 text-[10px] font-extrabold uppercase tracking-wider text-amber-700"
                      title={r.dismissed_reason === 'line' ? 'Its whole line is dismissed' : 'This item is dismissed'}>
                      dismissed
                    </span>
                  )}
                  {r.reversed && (
                    <span className="shrink-0 text-[10px] font-extrabold uppercase tracking-wider text-indigo-700"
                      title="This payment was reversed — the money came back within days, so it is not spend and both legs are excluded from the P&L.">
                      reversed
                    </span>
                  )}
                  {r.origin === 'ledger-unverified' && (
                    <span className="shrink-0 text-[10px] font-extrabold uppercase tracking-wider text-rose-600"
                      title="Marked Paid on the ledger, but no bank transaction vouches for it — shown on the P&L, never counted.">
                      no bank match
                    </span>
                  )}
                  {r.origin === 'unpaid' && (
                    <span className="shrink-0 text-[10px] font-extrabold uppercase tracking-wider text-gray-500"
                      title={`${r.payment_status || 'Unpaid'} — a cash-basis P&L excludes it until it's paid.`}>
                      {r.payment_status || 'unpaid'}
                    </span>
                  )}
                  <DocButton row={r} onOpen={setPreviewFile} />
                  <span className="font-mono font-bold shrink-0">{fmt(r.usd)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── P&L ── */}
      {tab === 'pnl' && pnl && !loading && showCharts && (
        <div className="mb-4"><ReportCharts pnl={pnl} intake={intake} vendors={vendors} onDrill={(kind, key) => openDrill(kind, key, null)} /></div>
      )}
      {tab === 'pnl' && pnl && !loading && compare !== 'none' && prevPnl && (
        <ComparePanel cur={pnlRaw} prev={prevPnl} mode={compare} range={prevPnl.range} filter={pnlQ} onDrill={(kind, key) => openDrill(kind, key, null)} />
      )}
      {tab === 'pnl' && pnl && !loading && compare !== 'none' && !prevPnl && (
        <p className="text-[12px] text-gray-400 mb-3" data-compare-missing>The comparison range could not be loaded.</p>
      )}
      {tab === 'vendors' && !loading && <SpendByTable data={vendors} dim="vendor" gran={gran} filter={pnlQ} />}
      {tab === 'reps' && !loading && <SpendByTable data={reps} dim="rep" gran={gran} filter={pnlQ} />}
      {tab === 'budget' && !loading && <BudgetVsActual data={bva} filter={pnlQ} />}
      <PackModal open={packOpen} onClose={() => setPackOpen(false)} from={from} to={to} basis={basis || 'bank'} />
      {tab === 'pnl' && pnl && !loading && (
        <div className="bg-card border border-rule rounded-xl overflow-x-auto">
          <table className="w-full" style={{ minWidth: 160 + pnl.months.length * 96 }}>
            <thead>
              <tr className="border-b-2 border-rule">
                <th className="px-3 py-2 text-left text-[10px] font-extrabold uppercase tracking-wider text-gray-400 sticky left-0 bg-card">&nbsp;</th>
                {pnl.months.map((m) => {
                  const cov = pnl.coverage?.[m]
                  const incomplete = cov && cov.pct < 85
                  return (
                    <th key={m} className="px-2 py-2 text-right text-[10px] font-extrabold uppercase tracking-wider text-gray-400"
                      title={cov
                        ? `${cov.pct}% of bank debits reconciled${cov.open_n ? ` — ${cov.open_n} open` : ''}${incomplete ? '; expenses likely missing from this column' : ''}`
                        : 'No bank statement data for this month — expenses unverified'}>
                      <span className="inline-flex items-center gap-1 justify-end">
                        {incomplete && <AlertTriangle size={10} className="text-amber-500" />}
                        {!cov && <span className="w-1.5 h-1.5 rounded-full bg-gray-300 inline-block" />}
                        {monthLabel(m)}
                      </span>
                    </th>
                  )
                })}
                <th className="px-2 py-2 text-right text-[10px] font-extrabold uppercase tracking-wider text-gray-500">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr><td colSpan={pnl.months.length + 2} className="px-3 pt-3 pb-1 text-[11px] font-extrabold uppercase tracking-wider text-boom-700">Income</td></tr>
              {lineRows(pnl.income, 'income')}
              {noMatchRow(pnl.income, 'income')}
              {subtotalRow(pnl.income, 'Subtotal of shown')}
              <tr className="border-b border-rule bg-gray-50/60">
                <td className="px-3 py-1.5 text-[13px] font-bold text-ink sticky left-0 bg-gray-50">
                  Total Income{filtering && <span className="font-normal text-gray-400"> (all lines)</span>}
                </td>
                {pnl.months.map((m) => <td key={m} className={`${cellR} font-bold`}>{fmt(pnl.income_totals.series[m])}</td>)}
                <td className={`${cellR} font-black`}>{fmt(pnl.income_totals.total)}</td>
              </tr>

              <tr><td colSpan={pnl.months.length + 2} className="px-3 pt-4 pb-1 text-[11px] font-extrabold uppercase tracking-wider text-boom-700">Expenses</td></tr>
              {lineRows(pnl.expenses, 'expense')}
              {noMatchRow(pnl.expenses, 'expense')}
              {subtotalRow(pnl.expenses, 'Subtotal of shown')}
              <tr className="border-b border-rule bg-gray-50/60">
                <td className="px-3 py-1.5 text-[13px] font-bold text-ink sticky left-0 bg-gray-50">
                  Total Expenses{filtering && <span className="font-normal text-gray-400"> (all lines)</span>}
                </td>
                {pnl.months.map((m) => <td key={m} className={`${cellR} font-bold`}>{fmt(pnl.expense_totals.series[m])}</td>)}
                <td className={`${cellR} font-black`}>{fmt(pnl.expense_totals.total)}</td>
              </tr>

              <tr className="bg-boom-50/40">
                <td className="px-3 py-2 text-[13px] font-black text-ink sticky left-0 bg-boom-50/40">
                  Net Income (operating){filtering && <span className="font-normal text-gray-400"> — all lines</span>}
                </td>
                {pnl.months.map((m) => (
                  <td key={m} className={`${cellR} font-black ${pnl.net.series[m] < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{fmt(pnl.net.series[m])}</td>
                ))}
                <td className={`${cellR} font-black ${pnl.net.total < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{fmt(pnl.net.total)}</td>
              </tr>

              {/* Recoveries netted into the expense they recover. Stated, or a
                  netted figure is indistinguishable from gross spend. */}
              {Object.keys(pnl.contra || {}).length > 0 && (
                <tr>
                  <td colSpan={pnl.months.length + 2} className="px-3 pt-1.5 pb-0.5 text-[11px] text-gray-400 sticky left-0 bg-card">
                    {Object.entries(pnl.contra).sort().map(([target, info]) => (
                      <span key={target} className="mr-3">
                        {target} is net of <strong className="font-semibold text-gray-500">{fmt(info.total)}</strong> recovered
                        {Object.keys(info.from || {}).length ? ` (${Object.keys(info.from).join(', ')})` : ''}.
                      </span>
                    ))}
                  </td>
                </tr>
              )}

              {/* Non-recurring, BELOW Net Income. A single catalog sale would
                  otherwise make its month read as the best trading month of the
                  year, and anyone building a run-rate would strip it by hand. */}
              {hasNonRec && (
                <>
                  <tr><td colSpan={pnl.months.length + 2} className="px-3 pt-4 pb-1 text-[11px] font-extrabold uppercase tracking-wider text-gray-400">Non-recurring — asset sales &amp; one-offs</td></tr>
                  {lineRows(nonRec.income, 'income')}
                  {lineRows(nonRec.expenses, 'expense', true)}
                  <tr className="border-b border-rule bg-gray-50/60">
                    <td className="px-3 py-1.5 text-[13px] font-bold text-gray-500 sticky left-0 bg-gray-50">Non-recurring net</td>
                    {pnl.months.map((m) => <td key={m} className={`${cellR} font-bold text-gray-500`}>{fmt(nonRec.net.series[m])}</td>)}
                    <td className={`${cellR} font-black text-gray-500`}>{fmt(nonRec.net.total)}</td>
                  </tr>
                  <tr>
                    <td colSpan={pnl.months.length + 2} className="px-3 pb-1 pl-6 text-[11px] text-gray-400 sticky left-0 bg-card">
                      Excluded from Net Income above — one-time dispositions, not trading revenue.
                    </td>
                  </tr>
                </>
              )}

              {hasBelow && (
                <>
                  <tr><td colSpan={pnl.months.length + 2} className="px-3 pt-4 pb-1 text-[11px] font-extrabold uppercase tracking-wider text-gray-400">Below the line — advances & pass-through</td></tr>
                  {lineRows(below.income, 'income')}
                  {lineRows(below.expenses, 'expense', true)}
                  {filtering && !visibleEntries(below.income).length && !visibleEntries(below.expenses).length && (
                    <tr className="border-b border-divider">
                      <td colSpan={pnl.months.length + 2} className="px-3 py-1.5 pl-6 text-[12px] text-gray-400 italic">
                        no lines match “{pnlQ}”
                      </td>
                    </tr>
                  )}
                  <tr className="border-b border-rule bg-gray-50/60">
                    <td className="px-3 py-1.5 text-[13px] font-bold text-gray-500 sticky left-0 bg-gray-50">Below-line net</td>
                    {pnl.months.map((m) => <td key={m} className={`${cellR} font-bold text-gray-500`}>{fmt(below.net.series[m])}</td>)}
                    <td className={`${cellR} font-black text-gray-500`}>{fmt(below.net.total)}</td>
                  </tr>
                </>
              )}

              {/* Sums EVERY section. Leaving one out would make the report's own
                  bottom line disagree with the statements it was built from. */}
              {(hasBelow || hasNonRec) && (
                <tr>
                  <td className="px-3 py-2 text-[13px] font-black text-ink sticky left-0 bg-card">Net Change in Cash</td>
                  {pnl.months.map((m) => {
                    const v = (pnl.net.series[m] || 0) + (nonRec.net.series[m] || 0) + (below.net.series[m] || 0)
                    return <td key={m} className={`${cellR} font-black ${v < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{fmt(v)}</td>
                  })}
                  {(() => {
                    const t = pnl.net.total + nonRec.net.total + below.net.total
                    return <td className={`${cellR} font-black ${t < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{fmt(t)}</td>
                  })()}
                </tr>
              )}

              {pnl.unverified?.total > 0 && (
                <>
                  <tr><td colSpan={pnl.months.length + 2} className="px-3 pt-4 pb-1 text-[11px] font-extrabold uppercase tracking-wider text-gray-400">Not counted — no bank evidence</td></tr>
                  <tr className="opacity-60">
                    <td className="px-3 py-1.5 text-[13px] text-gray-500 pl-6 sticky left-0 bg-card"
                      title="Ledger entries marked Paid that no bank transaction vouches for — excluded from every total above. Fix the payment dates, upload the missing statement, or unmark them.">
                      Ledger-paid, unverified <span className="text-[11px] text-gray-400">({pnl.unverified.count})</span>
                    </td>
                    {pnl.months.map((m) => (
                      <td key={m} className={`${cellR} text-gray-500 ${pnl.unverified.series[m] ? drillCell : ''}`}
                        onClick={() => pnl.unverified.series[m] && openDrill('unverified', 'Unverified', m)}>
                        {pnl.unverified.series[m] ? fmt(pnl.unverified.series[m]) : <span className="text-gray-300">—</span>}
                      </td>
                    ))}
                    <td className={`${cellR} font-bold text-gray-500 ${drillCell}`} onClick={() => openDrill('unverified', 'Unverified', null)}>
                      {fmt(pnl.unverified.total)}
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>

          {/* How much of the report an invoice can actually vouch for.
              Statements are the master here, so every payment is counted once —
              this is not about the total being wrong. It is about what the
              CATEGORIES are worth: the P&L reads each one off whatever entry
              explains its bank row, and for most of the money that entry is one
              the app invented from a bank descriptor. "Royalties $250,000" reads
              like a fact and is, for those rows, our own guess.
              Bank Matching states this as a percentage; here it is money. */}
          {pnl.evidence && (pnl.evidence.invented > 0 || pnl.evidence.none > 0) && (() => {
            const ev = pnl.evidence
            const total = ev.invoice + ev.invented + ev.none
            if (total <= 0) return null
            const pct = (v) => `${((v / total) * 100).toFixed(1)}%`
            // A contra recovery subtracts from whichever bucket it offsets, so a
            // small bucket can go negative. The bar must not be handed a
            // negative width.
            const barPct = (v) => `${Math.max(0, (v / total) * 100).toFixed(1)}%`
            return (
              <div className="mt-3 border border-rule rounded-xl bg-gray-50/60 px-3.5 py-3">
                <div className="text-[11px] font-extrabold uppercase tracking-wider text-gray-400 mb-2">
                  What backs these figures
                </div>
                <div className="flex h-2 rounded-full overflow-hidden mb-2.5" title="Share of reported spend by what explains it">
                  <div style={{ width: barPct(ev.invoice) }} className="bg-emerald-500" />
                  <div style={{ width: barPct(ev.invented) }} className="bg-amber-400" />
                  <div style={{ width: barPct(ev.none) }} className="bg-rose-400" />
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12px]">
                  <span className="text-gray-600">
                    <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-1.5" />
                    <strong className="font-bold text-ink">{fmt(ev.invoice)}</strong> backed by an invoice
                    <span className="text-gray-400"> · {ev.invoice_n} rows · {pct(ev.invoice)}</span>
                  </span>
                  <span className="text-gray-600">
                    <span className="inline-block w-2 h-2 rounded-full bg-amber-400 mr-1.5" />
                    <strong className="font-bold text-ink">{fmt(ev.invented)}</strong> categorised from an entry we invented
                    <span className="text-gray-400"> · {ev.invented_n} rows · {pct(ev.invented)}</span>
                  </span>
                  {ev.none > 0 && (
                    <span className="text-gray-600">
                      <span className="inline-block w-2 h-2 rounded-full bg-rose-400 mr-1.5" />
                      <strong className="font-bold text-ink">{fmt(ev.none)}</strong> nothing at all
                      <span className="text-gray-400"> · {ev.none_n} rows</span>
                    </span>
                  )}
                </div>
                {/* The sum, stated. These three used to describe EVERY bank
                    debit while the table above reported operating spend only,
                    so they added to 163% of the report and each percentage was
                    a share of a total nobody could see. They now total the
                    expense figure above them, and what sits outside it is
                    named on the next line rather than folded in. */}
                <div className="text-[12px] text-gray-500 mt-2 pt-2 border-t border-rule">
                  <strong className="font-bold text-ink">{fmt(total)}</strong> in total — the expense figure above.
                  {(ev.below_line > 0 || ev.non_recurring > 0) && (
                    <span className="text-gray-400">
                      {' '}Outside it: {fmt((ev.below_line || 0) + (ev.non_recurring || 0))} below the line
                      (advances, partner draws, reimbursements) — real payments this report reports separately.
                    </span>
                  )}
                </div>
                <p className="text-[11.5px] text-gray-400 mt-2">
                  Every payment is counted once — statements are the master, so this is not a double count.
                  It is how much of the categorisation an invoice can prove. Attach invoices from a vendor’s
                  page or from the drill below.
                </p>
              </div>
            )
          })()}
        </div>
      )}

      {/* ── Balance Sheet ── */}
      {tab === 'bs' && bs && !loading && (
        <div className="max-w-xl">
          {/* Every figure below is already net of these. A statement that
              quietly reports a smaller number is the failure this page is
              arranged against, so what was left out is named before the sheet. */}
          {(bs.excluded?.line_count > 0 || bs.excluded?.item_count > 0) && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-3 px-3 py-2 rounded-lg border border-amber-200 bg-amber-50/60 text-[12.5px] text-amber-900">
              <Ban size={14} className="text-amber-600 shrink-0" />
              <span>
                <strong className="font-bold">{fmt(bs.excluded.total)}</strong> excluded from this balance sheet
                {bs.excluded.line_count > 0 && ` — ${bs.excluded.lines.map((l) => l.label).join(', ')}`}
                {bs.excluded.item_count > 0 && `${bs.excluded.line_count > 0 ? ' and' : ' —'} ${bs.excluded.item_count} individual row${bs.excluded.item_count === 1 ? '' : 's'} (${fmt(bs.excluded.item_total)})`}.
              </span>
              <button onClick={() => setTab('dismissed')}
                className="ml-auto font-bold text-amber-800 hover:text-amber-900 whitespace-nowrap">
                Review →
              </button>
            </div>
          )}
          <div className="bg-card border border-rule rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-rule">
              <span className="text-sm font-bold text-ink">As of {bs.as_of}</span>
            </div>
            {bs.proof && (
              <div className={`px-4 py-2.5 border-b border-rule text-[12px] ${bs.proof.cash_known ? 'text-gray-500' : 'text-amber-800 bg-amber-50/60'}`} data-bs-proof data-bs-cash-known={bs.proof.cash_known ? '1' : '0'}>
                <p>{bs.proof.note}</p>
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11px] font-semibold text-gray-400 hover:text-ink">Where each line comes from</summary>
                  <ul className="mt-1 space-y-0.5 text-[11px]">
                    {bs.proof.sources.map((src) => <li key={src.line}><span className="font-semibold text-ink">{src.line}</span> — {src.from}</li>)}
                  </ul>
                </details>
              </div>
            )}
            <div className="px-4 py-3">
              <div className="text-[11px] font-extrabold uppercase tracking-wider text-boom-700 mb-1">Assets</div>
              {bs.assets.cash.length === 0 && (
                <div className="flex items-center gap-2 text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mb-1">
                  <Landmark size={13} /> Cash balances are being extracted from your stored statement PDFs automatically — open the Statements page once and check back in a few minutes.
                </div>
              )}
              {bs.assets.cash.map((c) => bsLine({
                key: `cash:${String(c.account).toLowerCase()}`,
                label: `Cash — ${c.account.toUpperCase()}`,
                sub: `as of ${fmtDay(c.as_of)}`,
                amount: c.balance,
              }))}
              {/* An excluded cash account is absent from `assets.cash`, so it is
                  listed from the exclusion block instead — otherwise there would
                  be no way to put it back from this page. */}
              {(bs.excluded?.lines || []).filter((l) => l.key.startsWith('cash:')).map((l) => bsLine({
                key: l.key, label: l.label, amount: l.total, excluded: true,
              }))}
              {(() => {
                const agingLine = (a) => a && (a.d60 > 0.005 || a.d90 > 0.005 || a.over90 > 0.005) && (
                  <div className="pl-3 pb-1 text-[11px] text-gray-400 tabular-nums">
                    current {fmt(a.current)} · 31–60 {fmt(a.d60)} · 61–90 {fmt(a.d90)} ·{' '}
                    <span className={a.over90 > 0.005 ? 'text-amber-600 font-semibold' : ''}>90+ {fmt(a.over90)}</span>
                  </div>
                )
                return (
                  <>
                    {bsLine({
                      key: 'accounts_receivable',
                      label: 'Accounts Receivable',
                      sub: `${bs.assets.accounts_receivable.count} unpaid invoice${bs.assets.accounts_receivable.count === 1 ? '' : 's'}`,
                      amount: bs.assets.accounts_receivable.total,
                      excluded: bs.assets.accounts_receivable.excluded,
                      breakdown: bs.assets.accounts_receivable.breakdown,
                      breakdownLabel: bs.assets.accounts_receivable.breakdown_label,
                      onOpen: () => openDrill('bs-ar', 'Accounts Receivable', null),
                    })}
                    {!bs.assets.accounts_receivable.excluded && agingLine(bs.assets.accounts_receivable.aging)}
                    <div className="flex justify-between py-1.5 border-t border-rule text-[13px] font-bold">
                      <span>Total Assets</span><span className="font-mono tabular-nums">{fmt(bs.assets.total)}</span>
                    </div>

                    <div className="text-[11px] font-extrabold uppercase tracking-wider text-boom-700 mt-4 mb-1">Liabilities</div>
                    {bsLine({
                      key: 'accounts_payable',
                      label: 'Accounts Payable',
                      sub: `${bs.liabilities.accounts_payable.count} unpaid bill${bs.liabilities.accounts_payable.count === 1 ? '' : 's'}`,
                      amount: bs.liabilities.accounts_payable.total,
                      excluded: bs.liabilities.accounts_payable.excluded,
                      breakdown: bs.liabilities.accounts_payable.breakdown,
                      breakdownLabel: bs.liabilities.accounts_payable.breakdown_label,
                      onOpen: () => openDrill('bs-ap', 'Accounts Payable', null),
                    })}
                    {!bs.liabilities.accounts_payable.excluded && agingLine(bs.liabilities.accounts_payable.aging)}
                  </>
                )
              })()}
              <div className="flex justify-between py-1.5 border-t border-rule text-[13px] font-bold">
                <span>Total Liabilities</span><span className="font-mono">{fmt(bs.liabilities.total)}</span>
              </div>

              {/* Net assets, then what funded them. Drawdowns used to sit in
                  Liabilities, which made that total read $5.49M and left
                  "what do we owe" unanswerable. `?? bs.equity` so a new bundle
                  against an old server degrades instead of white-paging. */}
              <div className="flex justify-between py-1.5 mt-2 border-t-2 border-rule text-[13px] font-black">
                <span>Net Assets <span className="text-gray-400 text-[11px] font-normal">(Assets − Liabilities)</span></span>
                <span className={`font-mono ${(bs.net_assets?.total ?? bs.equity?.total ?? 0) < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
                  {fmt(bs.net_assets?.total ?? bs.equity?.total)}
                </span>
              </div>

              {/* Hidden entirely, so nothing here is left to click — the way
                  back has to be rendered in its place. The Dismissed tab also
                  lists it, but that's a poor path for something turned off a
                  minute ago. */}
              {bs.funding?.hidden && (
                <button
                  onClick={() => bsRestore({ scope: 'bs_line', cell_key: 'funding' })}
                  disabled={dismissBusy === 'funding'}
                  className="mt-4 inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-gray-400 hover:text-boom-700 disabled:opacity-40">
                  {dismissBusy === 'funding' ? <Loader size={11} className="animate-spin" /> : <Undo2 size={11} />}
                  Show “Funded by”
                </button>
              )}

              {bs.funding && !bs.funding.hidden && (
                <>
                  <div className="group flex items-center gap-1.5 mt-4 mb-1">
                    <span className="text-[11px] font-extrabold uppercase tracking-wider text-boom-700">Funded by</span>
                    <button
                      onClick={() => bsExclude({ scope: 'bs_line', cell_key: 'funding' },
                        'Hide the “Funded by” section?\n\nThis changes no figures — Assets, Liabilities and Net Assets stay exactly as they are. It only removes the section, on screen and in the exports. Reason (optional):')}
                      disabled={dismissBusy === 'funding'}
                      title="Hide this section — changes no figures"
                      className="p-0.5 rounded text-gray-300 hover:text-rose-600 opacity-0 group-hover:opacity-100 focus:opacity-100">
                      {dismissBusy === 'funding' ? <Loader size={11} className="animate-spin" /> : <Ban size={11} />}
                    </button>
                  </div>
                  {bsLine({
                    key: 'drawdowns',
                    label: 'Drawdowns received',
                    sub: `${bs.funding.drawdowns.count} drawdown${bs.funding.drawdowns.count === 1 ? '' : 's'}`,
                    amount: bs.funding.drawdowns.total,
                    excluded: bs.funding.drawdowns.excluded,
                    breakdown: bs.funding.drawdowns.breakdown,
                    breakdownLabel: bs.funding.drawdowns.breakdown_label,
                    onOpen: () => openDrill('bs-advances', 'Drawdowns received', null),
                  })}
                  {bs.funding.drawdowns.note && !bs.funding.drawdowns.excluded && (
                    <div className="pl-3 text-[11px] text-gray-400">{bs.funding.drawdowns.note}</div>
                  )}
                  <div className="flex justify-between py-1 text-[13px]">
                    <span className="text-ink pl-3" title="Net assets minus drawdowns. Derived so the block sums; nothing proves it.">Unexplained difference (derived)</span>
                    <span className={`font-mono tabular-nums ${bs.funding.accumulated_deficit.total < 0 ? 'text-rose-600' : ''}`}>
                      {fmt(bs.funding.accumulated_deficit.total)}
                    </span>
                  </div>
                  <div className="flex justify-between py-1.5 border-t border-rule text-[13px] font-bold">
                    <span>Total</span><span className="font-mono tabular-nums">{fmt(bs.funding.total)}</span>
                  </div>
                  <p className="text-[11px] text-gray-400 mt-1">
                    The deficit is derived as Net Assets − Drawdowns, so this block always sums. It's a presentation, not a proof.
                  </p>
                  {bs.funding.memo?.recoupable?.count > 0 && (
                    <p className="text-[11px] text-gray-500 mt-1.5 pl-3 border-l-2 border-rule">
                      <span className="font-semibold text-ink">Memo</span> — {fmt(bs.funding.memo.recoupable.total)} of
                      recoupable artist spend across {bs.funding.memo.recoupable.count.toLocaleString()} entries.
                      Not counted as an asset here.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
          <p className="text-[11px] text-gray-400 mt-2">Cash comes from the latest uploaded statement per account; A/R from unpaid outbound invoices; A/P from approved unpaid bills (USD-converted). Liabilities are unpaid invoices only — drawdowns are funding, not debt, and are reported under Funded by.</p>
        </div>
      )}

      {/* ── Dismissed ── the separate home for excluded items ── */}
      {tab === 'artists' && byArtist && !loading && (
        <div className="bg-card border border-rule rounded-xl p-4 sm:p-5">
          {/* The self-check travels on the payload. If the breakdown ever stops
              agreeing with the P&L, say so loudly instead of presenting it —
              a per-artist number that contradicts the P&L is worse than none. */}
          {byArtist.ties_to_pnl === false && (
            <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              <strong>Do not present this.</strong> The breakdown totals {fmt(byArtist.total)} but the
              P&amp;L reports {fmt(byArtist.pnl_expense_total)} for the same range. Something has drifted.
            </div>
          )}

          <div className="flex flex-wrap items-end justify-between gap-3 mb-1">
            <div>
              <h2 className="text-lg font-extrabold text-ink">Spend by Artist</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Operating spend, statement-verified cash basis · advances shown separately · {from} → {to}
              </p>
            </div>
            {/* Both bases, side by side, each labelled. One combined figure would
                be neither "what we spent" nor "what we can't get back". */}
            <div className="flex items-end gap-5 text-right">
              <div>
                <div className="text-2xl font-black text-ink tabular-nums">{fmt(byArtist.total)}</div>
                <div className="text-[11px] text-gray-500">operating spend</div>
              </div>
              {Number(byArtist.advances?.total || 0) > 0 && (
                <>
                  <div>
                    <div className="text-2xl font-black text-gray-500 tabular-nums">{fmt(byArtist.advances.total)}</div>
                    <div className="text-[11px] text-gray-500">advances</div>
                  </div>
                  <div>
                    <div className="text-2xl font-black text-ink tabular-nums">{fmt(byArtist.total_out)}</div>
                    <div className="text-[11px] text-gray-500">total out</div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Coverage stated up front. 29% is the first thing anyone asks. */}
          <div className="mt-3 mb-4 rounded-lg border border-rule bg-gray-50/60 px-3 py-2.5">
            <div className="flex items-center justify-between text-xs font-semibold text-gray-700">
              <span>{byArtist.coverage_pct}% names an artist</span>
              {/* Counts the artists this PERCENTAGE is about — the ones with
                  operating spend. `artists` also carries advance-only artists
                  now, and a coverage figure quoting a headcount that includes
                  rows it does not measure is the band-and-list mismatch this
                  report has already shipped twice. */}
              <span className="tabular-nums text-gray-500">
                {fmt(byArtist.attributed_total)} of {fmt(byArtist.total)} ·{' '}
                {(byArtist.artists || []).filter((a) => Number(a.total || 0) !== 0).length} artists
              </span>
            </div>
            <div className="mt-1.5 h-2 rounded-full bg-gray-200 overflow-hidden">
              <div className="h-full bg-boom-600" style={{ width: `${Math.min(100, byArtist.coverage_pct)}%` }} />
            </div>
            <p className="text-[11px] text-gray-500 mt-1.5">
              The remainder is label overhead and unmatched bank spend — ad platforms, travel, bank
              fees, transfers. Most of it will never belong to one artist. Placeholder artist values
              (N/A, Unknown, TBD) count here, not as artists.
            </p>
            {Number(byArtist.advances?.total || 0) > 0 && (
              <p className="text-[11px] text-gray-500 mt-1.5 pt-1.5 border-t border-divider">
                <strong className="text-gray-600">Advances</strong> are below the line on the P&amp;L —
                recoupable money the label expects back — so they are not in the spend figure above.
                {' '}{fmt(byArtist.advances.attributed_total)} of {fmt(byArtist.advances.total)} names an artist
                {Number(byArtist.advances.unattributed || 0) > 0 && (
                  <> ; {fmt(byArtist.advances.unattributed)} does not yet and sits on the unattributed row</>
                )}.
                {(() => {
                  const advOnly = (byArtist.artists || [])
                    .filter((a) => Number(a.total || 0) === 0 && Number(a.advances || 0) !== 0).length
                  return advOnly > 0
                    ? ` ${advOnly} artist${advOnly === 1 ? '' : 's'} appear${advOnly === 1 ? 's' : ''} here for an advance alone, with no operating spend in this window.`
                    : ''
                })()}
                {Number(byArtist.advances.other_total || 0) > 0 && (
                  <> A further {fmt(byArtist.advances.other_total)} sits below the line in partner draws
                    and reimbursements, which are not artist costs and are not shown.</>
                )}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 mb-2">
            <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Show</label>
            <select value={artistTopN} onChange={(e) => setArtistTopN(Number(e.target.value))}
              className="text-xs border border-rule rounded-lg px-2 py-1 bg-card text-ink">
              {[10, 25, 50, 0].map((n) => (
                <option key={n} value={n}>{n === 0 ? 'All artists' : `Top ${n}`}</option>
              ))}
            </select>
            <span className="text-[11px] text-gray-400">
              {artistTopN
                ? 'the rest collapse into one line — nothing is dropped, and Export Excel follows this'
                : 'every artist listed · Export Excel matches what you see'}
            </span>
          </div>

          {/* Same shape as the P&L: a matrix you read across and click into.
              Rows are artists, columns are spend categories, and every number
              opens the transactions behind it. The row TOTAL drills the whole
              artist; a category cell drills just that intersection. */}
          {(() => {
            const all = byArtist.artists || []
            // BIGGEST ARTIST SPEND FIRST, and the ones no artist has at all go
            // last. The server's order is the P&L's, which put Royalties, Salary,
            // Rent, Salary (Felipe) and Credit Card immediately beside the frozen
            // column — five categories that are '—' for every artist on a page
            // titled Spend by Artist — while Marketing, the largest, sat off the
            // right edge. The columns are kept, not dropped: the overhead row
            // below is the only thing with money in them and that is worth
            // reading; they just stop being the first thing.
            const artistSpend = (c) => all.reduce((n, a) => n + Math.abs(Number(a.by_category?.[c] || 0)), 0)
            const cats = [...(byArtist.categories || [])].sort((x, y) => {
              const dx = artistSpend(x); const dy = artistSpend(y)
              if ((dx > 0) !== (dy > 0)) return dy > 0 ? 1 : -1
              return dy - dx
            })
            // Two frozen columns, so the number the page exists for is never the
            // one you have to scroll to find. Their widths are fixed because the
            // second one's `left` offset has to equal the first one's width — a
            // sticky column at the wrong offset either floats over the grid or
            // leaves a gap that the scrolling cells show through.
            const W_ARTIST = 190
            const W_TOTAL = 108
            // Advances and Total out are frozen alongside Total. They are the
            // reason the column exists — scrolled away behind 29 categories they
            // would be the same invisible number they were as one line in the
            // bridge at the bottom. Narrower than Total, since they are read, not
            // compared across.
            const W_ADV = 100
            const L_ADV = W_ARTIST + W_TOTAL
            const L_OUT = L_ADV + W_ADV
            const advOf = (a) => Number(a?.advances || 0)
            const advTotal = Number(byArtist.advances?.total || 0)
            const frozen = 'sticky z-10 bg-card'
            const shown = artistTopN ? all.slice(0, artistTopN) : all
            const tail = artistTopN ? all.slice(artistTopN) : []
            const tailTotal = tail.reduce((sum, a) => sum + Number(a.total || 0), 0)
            const un = byArtist.unattributed || { by_category: {}, total: 0 }

            // `sticky` passes the offset that pins this cell. A frozen cell
            // needs its own z and an OPAQUE background, or the scrolling columns
            // show through it — which is what was clipping the leading digits off
            // "$140,214.52" into "40,214.52".
            const num = (v, onClick, extraCls = '', sticky = null) => (
              <td style={sticky || undefined}
                className={`${cellR} ${sticky ? `${frozen} border-r border-rule` : ''} ${v ? `${drillCell} ${extraCls}` : 'text-gray-300'}`}
                onClick={v ? onClick : undefined}>
                {v ? fmtFlow(v) : '—'}
              </td>
            )
            // Scrolls in BOTH directions with its header pinned. 94 artists
            // against 29 categories: by row 30 the columns were unlabelled, so a
            // number in the middle of the grid meant nothing without scrolling
            // back up to find out which category it was in. The artist column
            // stays pinned left for the same reason — it is the row's identity,
            // and `sticky left-0` was already there. The corner cell needs BOTH,
            // and a higher z so it isn't painted over by either.
            return (
              <div className="border border-rule rounded-xl overflow-auto max-h-[70vh]">
                <table className="w-full" style={{ minWidth: W_ARTIST + W_TOTAL + W_ADV * 2 + cats.length * 104 }}>
                  <thead>
                    <tr className="border-b-2 border-rule">
                      <th style={{ left: 0, width: W_ARTIST, minWidth: W_ARTIST }}
                        className="px-3 py-2 text-left text-[10px] font-extrabold uppercase tracking-wider text-gray-400 sticky top-0 z-30 bg-card">Artist</th>
                      {/* TOTAL SECOND, frozen with the name. It used to be the
                          last of forty columns — the figure anyone opens this page
                          for, reachable only by scrolling past thirty-nine that
                          are mostly blank. */}
                      <th style={{ left: W_ARTIST, width: W_TOTAL, minWidth: W_TOTAL }}
                        className="px-2 py-2 text-right text-[10px] font-extrabold uppercase tracking-wider text-gray-500 sticky top-0 z-30 bg-card"
                        title="Operating spend. This is the column that ties to the P&L expense line.">Spend</th>
                      {/* Advances sit BESIDE spend, never inside it. An advance is
                          recoupable — money the label expects back — so folding it
                          into Total would stop this report answering "what did we
                          spend that we can't get back". Below the line on the P&L,
                          and shown here because it is the biggest
                          artist-attributable outflow there is. */}
                      <th style={{ left: L_ADV, width: W_ADV, minWidth: W_ADV }}
                        className="px-2 py-2 text-right text-[10px] font-extrabold uppercase tracking-wider text-gray-500 sticky top-0 z-30 bg-card"
                        title="Artist advances — below the line on the P&L, because they are recoupable. Not included in Spend.">Advances</th>
                      <th style={{ left: L_OUT, width: W_ADV, minWidth: W_ADV }}
                        className="px-2 py-2 text-right text-[10px] font-extrabold uppercase tracking-wider text-gray-500 sticky top-0 z-30 bg-card border-r border-rule"
                        title="Spend + advances — what this artist has cost in cash.">Total out</th>
                      {cats.map((c) => (
                        <th key={c} className={`px-2 py-2 text-right text-[10px] font-extrabold uppercase tracking-wider whitespace-nowrap sticky top-0 z-20 bg-card ${artistSpend(c) > 0 ? 'text-gray-400' : 'text-gray-300'}`}
                          title={artistSpend(c) > 0 ? undefined : 'No artist spend in this window — only label overhead sits in this column'}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((a) => (
                      <tr key={a.key} className="border-b border-divider">
                        <td style={{ left: 0, width: W_ARTIST, minWidth: W_ARTIST }}
                          className={`px-3 py-1.5 text-[12.5px] text-ink ${frozen} whitespace-nowrap overflow-hidden text-ellipsis`}
                          title={a.spellings?.length > 1
                            ? `Merges ${a.spellings.length} spellings: ${a.spellings.join(' / ')}`
                            : a.name}>
                          {a.name}
                          {a.spellings?.length > 1 && (
                            <span className="ml-1.5 text-[10px] text-gray-400">×{a.spellings.length}</span>
                          )}
                        </td>
                        {num(Number(a.total || 0), () => openDrill('artist', a.key, null), 'font-bold',
                          { left: W_ARTIST, width: W_TOTAL, minWidth: W_TOTAL })}
                        {num(advOf(a), () => openDrill('artist', a.key, null, 'Advance'), 'text-gray-600',
                          { left: L_ADV, width: W_ADV, minWidth: W_ADV })}
                        {num(Number(a.total_out || 0), () => openDrill('artist', a.key, null), 'font-bold text-gray-500',
                          { left: L_OUT, width: W_ADV, minWidth: W_ADV })}
                        {cats.map((c) => num(Number(a.by_category?.[c] || 0),
                          () => openDrill('artist', a.key, null, c)))}
                      </tr>
                    ))}

                    {/* The tail is collapsed but NOT drillable — it is several
                        artists, so there is no single cell it could open. */}
                    {/* The collapsed tail is a real cell with a real total, so
                        it drills like any other — over the whole set of artists
                        it stands for. Its LABEL expands the table instead, so
                        you can also reach each of those artists individually. */}
                    {tail.length > 0 && (() => {
                      const tailKeys = tail.map((a) => a.key)
                      const tailLabel = `Other artists (${tail.length})`
                      return (
                        <tr className="border-b border-divider">
                          <td style={{ left: 0, width: W_ARTIST, minWidth: W_ARTIST }}
                            className={`px-3 py-1.5 text-[12.5px] ${frozen} whitespace-nowrap`}>
                            <button onClick={() => setArtistTopN(0)}
                              title={`Show all ${all.length} artists individually — currently folded: ${tail.map((a) => a.name).join(', ')}`}
                              className="text-gray-500 hover:text-boom-700 underline decoration-dotted underline-offset-2">
                              {tailLabel}
                            </button>
                          </td>
                          {num(tailTotal, () => openDrill('artist', '', null, null, { keys: tailKeys, label: tailLabel }), 'font-bold text-gray-500',
                            { left: W_ARTIST, width: W_TOTAL, minWidth: W_TOTAL })}
                          {num(tail.reduce((sm, a) => sm + advOf(a), 0),
                            () => openDrill('artist', '', null, 'Advance', { keys: tailKeys, label: tailLabel }), 'text-gray-500',
                            { left: L_ADV, width: W_ADV, minWidth: W_ADV })}
                          {num(tail.reduce((sm, a) => sm + Number(a.total_out || 0), 0),
                            () => openDrill('artist', '', null, null, { keys: tailKeys, label: tailLabel }), 'font-bold text-gray-500',
                            { left: L_OUT, width: W_ADV, minWidth: W_ADV })}
                          {cats.map((c) => {
                            const v = tail.reduce((sm, a) => sm + Number(a.by_category?.[c] || 0), 0)
                            return num(v, () => openDrill('artist', '', null, c, { keys: tailKeys, label: tailLabel }), 'text-gray-500')
                          })}
                        </tr>
                      )
                    })()}

                    <tr className="border-b border-divider bg-gray-50/60">
                      <td style={{ left: 0, width: W_ARTIST, minWidth: W_ARTIST }}
                        className="px-3 py-1.5 text-[12.5px] font-semibold text-gray-600 sticky z-10 bg-gray-50 whitespace-nowrap"
                        title="Label overhead and unmatched bank spend — click any figure for the transactions">
                        Not attributed to an artist
                      </td>
                      {num(Number(un.total || 0), () => openDrill('artist', '', null), 'font-bold',
                        { left: W_ARTIST, width: W_TOTAL, minWidth: W_TOTAL, background: 'rgb(var(--color-gray-50))' })}
                      {num(Number(byArtist.advances?.unattributed || 0),
                        () => openDrill('artist', '', null, 'Advance'), 'text-gray-600',
                        { left: L_ADV, width: W_ADV, minWidth: W_ADV, background: 'rgb(var(--color-gray-50))' })}
                      {num(Number(un.total || 0) + Number(byArtist.advances?.unattributed || 0),
                        () => openDrill('artist', '', null), 'font-bold text-gray-500',
                        { left: L_OUT, width: W_ADV, minWidth: W_ADV, background: 'rgb(var(--color-gray-50))' })}
                      {cats.map((c) => num(Number(un.by_category?.[c] || 0),
                        () => openDrill('artist', '', null, c)))}
                    </tr>

                    <tr className="border-t-2 border-rule">
                      <td style={{ left: 0, width: W_ARTIST, minWidth: W_ARTIST }}
                        className={`px-3 py-2 text-[12.5px] font-extrabold text-ink ${frozen}`}>TOTAL SPEND</td>
                      <td style={{ left: W_ARTIST, width: W_TOTAL, minWidth: W_TOTAL }}
                        className={`${cellR} font-extrabold ${frozen}`}>{fmtFlow(Number(byArtist.total || 0))}</td>
                      <td style={{ left: L_ADV, width: W_ADV, minWidth: W_ADV }}
                        className={`${cellR} font-extrabold ${frozen}`}>{advTotal ? fmtFlow(advTotal) : '—'}</td>
                      <td style={{ left: L_OUT, width: W_ADV, minWidth: W_ADV }}
                        className={`${cellR} font-extrabold ${frozen} border-r border-rule`}>{fmtFlow(Number(byArtist.total_out || byArtist.total || 0))}</td>
                      {cats.map((c) => {
                        const v = all.reduce((sm, a) => sm + Number(a.by_category?.[c] || 0), 0)
                          + Number(un.by_category?.[c] || 0)
                        return (
                          <td key={c} className={`${cellR} font-extrabold`}>{v ? fmtFlow(v) : '—'}</td>
                        )
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>
            )
          })()}
          <p className="text-[11px] text-gray-400 mt-2">
            Click any figure to see the transactions behind it — a row total for the whole artist, a
            category cell for just that intersection.
          </p>

          {/* The bridge. Anyone who has seen the ledger remembers a bigger
              number; show why before they ask. */}
          {(() => {
            const ex = byArtist.excluded || {}
            const rows = [
              ['Below-the-line (artist advances, drawdowns)', ex.below_line, null],
              ['Non-recurring / one-off items', ex.non_recurring, null],
              ['Excluded by review — transfers, internal movements', ex.dismissed?.total, ex.dismissed?.count],
              ['Reversal pairs — money that never moved', ex.reversals?.total, ex.reversals?.count],
              ['Marked paid in the ledger, no bank line behind it', ex.unverified?.total, ex.unverified?.count],
            ].filter(([, v]) => Number(v || 0) > 0)
            if (!rows.length) return null
            return (
              <div className="mt-5 pt-4 border-t border-rule">
                <h3 className="text-xs font-extrabold uppercase tracking-wide text-gray-500 mb-1">What this total excludes</h3>
                <p className="text-[11px] text-gray-500 mb-2">
                  This is operating spend the statements vouch for. The ledger's &ldquo;paid&rdquo;
                  figure is larger, for these reasons:
                </p>
                <table className="w-full text-xs">
                  <tbody>
                    {rows.map(([label, v, count]) => (
                      <tr key={label} className="border-b border-rule/60 last:border-0">
                        <td className="py-1.5 text-gray-700">
                          {label}{count ? <span className="text-gray-400"> · {count} {count === 1 ? 'item' : 'items'}</span> : null}
                        </td>
                        <td className="py-1.5 text-right font-semibold tabular-nums text-gray-700">{fmt(v)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-[11px] text-gray-400 mt-2">
                  The last line is a reconciliation backlog, not a decision — those rows appear on the
                  P&amp;L but are never counted, because no statement vouches for them.
                </p>
              </div>
            )
          })()}
        </div>
      )}

      {tab === 'dismissed' && (
        <div>
          <p className="text-sm text-gray-500 mb-3">
            Items excluded from the reports on this page. Bank rows marked <strong className="text-ink font-semibold">not counted</strong> have been
            removed from the P&amp;L total; unverified ledger rows never counted toward it and were only hidden from the worklist.
            This list is separate from the dismissals the statements pipeline makes on its own.
          </p>
          {dismissals !== null && dismissals.length > 0 && (
            <div className="mb-3">
              <ListSearch
                value={dismissQ}
                onChange={setDismissQ}
                placeholder="Filter by payee, line, reason, who…"
                count={dismissalsFiltered.length}
                total={dismissals.length}
              />
            </div>
          )}
          {dismissalsError ? (
            <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-lg px-3 py-2 text-sm">
              Couldn’t load dismissals — {dismissalsError}{' '}
              <button onClick={fetchDismissals} className="font-bold underline">Retry</button>
            </div>
          ) : dismissals === null ? (
            <div className="text-sm text-gray-400 py-8 text-center">Loading…</div>
          ) : dismissals.length === 0 ? (
            <div className="bg-card border border-rule rounded-xl px-4 py-10 text-center">
              <Ban size={22} className="mx-auto mb-2 text-gray-300" />
              <p className="text-sm text-gray-500">Nothing dismissed.</p>
              <p className="text-[12px] text-gray-400 mt-1">Dismiss an item from any drill-down and it will appear here, with a way back.</p>
            </div>
          ) : (
            dismissalsFiltered.length === 0 ? (
            <div className="bg-card border border-rule rounded-xl px-4 py-8 text-center">
              <p className="text-sm text-gray-500">No dismissals match “{dismissQ}”.</p>
              <button onClick={() => setDismissQ('')} className="mt-2 text-[12px] font-bold text-boom-600 hover:text-boom-700">Clear filter</button>
            </div>
            ) : (
            <div className="bg-card border border-rule rounded-xl overflow-hidden">
              {dismissalsFiltered.map((d) => (d.scope === 'bs_line' || d.scope === 'bs_item') ? (
                // A balance-sheet exclusion. Its amount lives on the balance
                // sheet's own `excluded` block, not here — this list joins
                // bank_transactions and expenses, and these reference
                // boom_invoices / artist_income rows it never sees.
                <div key={d.id} className="flex items-start gap-3 px-4 py-3 border-b border-divider last:border-b-0 bg-amber-50/30">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 bg-amber-500" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-[13px] font-bold text-ink truncate">{d.bs_ref || d.cell_key}</span>
                      <span className="text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                        balance sheet · {d.scope === 'bs_line' ? 'whole line' : 'one row'}
                      </span>
                    </div>
                    <p className="text-[11px] text-gray-400">
                      {d.scope === 'bs_line'
                        ? 'Standing rule — this line is left out of the balance sheet, now and later.'
                        : 'This row is left out of the balance sheet. The P&L is unaffected.'}
                    </p>
                    {d.reason && <p className="text-[12px] text-gray-500 mt-0.5">“{d.reason}”</p>}
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      excluded by {d.dismissed_by || 'unknown'}{d.dismissed_at ? ` · ${fmtDay(d.dismissed_at)}` : ''}
                    </p>
                  </div>
                  <button
                    onClick={async () => {
                      await bsRestore(d.scope === 'bs_item'
                        ? { scope: 'bs_item', bs_ref: d.bs_ref }
                        : { scope: 'bs_line', cell_key: d.cell_key })
                      fetchDismissals()
                    }}
                    disabled={dismissBusy === (d.bs_ref || d.cell_key)}
                    title="Restore — put this back on the balance sheet"
                    className="shrink-0 inline-flex items-center gap-1 border border-rule rounded-lg px-2 py-1 text-[11.5px] font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-40">
                    {dismissBusy === (d.bs_ref || d.cell_key)
                      ? <Loader size={12} className="animate-spin" /> : <Undo2 size={12} />} Restore
                  </button>
                </div>
              ) : d.scope === 'category' ? (
                // A line rule, not a row: no date, payee or amount to show —
                // it's a standing exclusion, and it keeps applying to anything
                // booked to that line later.
                <div key={d.id} className="flex items-start gap-3 px-4 py-3 border-b border-divider last:border-b-0 bg-amber-50/30">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 bg-rose-500" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-[13px] font-bold text-ink truncate">{d.cell_key}</span>
                      <span className="text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-50 text-rose-700">
                        whole line · {d.cell_kind === 'income' ? 'income' : 'expense'}
                      </span>
                      {(() => {
                        const hit = (pnl?.dismissed?.categories || []).find(
                          (c) => c.kind === d.cell_kind && String(c.key).toLowerCase() === String(d.cell_key).toLowerCase())
                        if (!hit) return null
                        return (
                          <span className="font-mono text-[12px] text-amber-700">
                            {fmt(hit.usd)} excluded in range · {hit.count} {hit.count === 1 ? 'txn' : 'txns'}
                          </span>
                        )
                      })()}
                    </div>
                    <p className="text-[11px] text-gray-400">
                      Standing rule — anything booked here in future is excluded too.
                    </p>
                    {d.reason && <p className="text-[12px] text-gray-500 mt-0.5">“{d.reason}”</p>}
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      dismissed by {d.dismissed_by || 'unknown'}{d.dismissed_at ? ` · ${fmtDay(d.dismissed_at)}` : ''}
                    </p>
                  </div>
                  <button onClick={() => restoreCategory(d.cell_kind, d.cell_key)}
                    disabled={dismissBusy === `cat:${d.cell_kind}:${d.cell_key}`}
                    title="Restore — put this line back into the P&L"
                    className="shrink-0 inline-flex items-center gap-1 border border-rule rounded-lg px-2 py-1 text-[11.5px] font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-40">
                    {dismissBusy === `cat:${d.cell_kind}:${d.cell_key}`
                      ? <Loader size={11} className="animate-spin" /> : <Undo2 size={11} />} Restore
                  </button>
                </div>
              ) : (
                <div key={d.id} className="flex items-start gap-3 px-4 py-3 border-b border-divider last:border-b-0">
                  <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${d.counted ? 'bg-amber-500' : 'bg-gray-300'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-[13px] font-bold text-ink truncate">{d.payee}</span>
                      {d.amount != null && (
                        <span className="font-mono text-[12px] text-gray-500">
                          {Number(d.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })} {d.currency}
                        </span>
                      )}
                      <span className={`text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                        d.counted ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                        {d.counted ? 'not counted' : 'hidden only'}
                      </span>
                      {d.orphaned && (
                        <span className="text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-100 text-gray-500"
                          title="The transaction this pointed at no longer exists — the statement was deleted or re-uploaded. The exclusion still applies if a matching row comes back.">
                          no longer present
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-gray-400 truncate">
                      {[fmtDay(d.date), d.cell_key, d.artist, d.invoice_number ? `inv ${d.invoice_number}` : null,
                        d.account ? String(d.account).toUpperCase() : null].filter(Boolean).join(' · ')}
                    </p>
                    {d.reason && <p className="text-[12px] text-gray-500 mt-0.5">“{d.reason}”</p>}
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      dismissed by {d.dismissed_by || 'unknown'}{d.dismissed_at ? ` · ${fmtDay(d.dismissed_at)}` : ''}
                    </p>
                  </div>
                  <button onClick={() => restoreDismissal(d.id)} disabled={dismissBusy === d.id}
                    title="Restore — put this item back into the report"
                    className="shrink-0 inline-flex items-center gap-1 border border-rule rounded-lg px-2 py-1 text-[11.5px] font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-40">
                    {dismissBusy === d.id ? <Loader size={11} className="animate-spin" /> : <Undo2 size={11} />} Restore
                  </button>
                </div>
              ))}
            </div>
            )
          )}
        </div>
      )}

      {/* ── Drill-down modal ── */}
      {drill && (
        <div className="fixed inset-0 z-50 bg-overlay flex items-center justify-center p-4" onClick={closeDrill}>
          {/* max-w-2xl was 672px, and these rows have grown five controls since
              it was chosen — evidence chip, recategorize, artist, month,
              dismiss. Fixed-width controls plus gaps came to more than the
              modal, and the NAME is the only flexible element, so it was the
              one crushed to nothing. */}
          <div className="bg-card border border-rule rounded-xl w-full max-w-4xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-rule">
              {/* An artist drill's key is a normalized slug ("novablaze"), and
                  the unattributed bucket's key is the empty string — neither is
                  showable. Resolve back to the display name the row carried. */}
              <span className="text-sm font-bold text-ink">
                {drill.kind === 'artist'
                  ? (drill.label
                      || (byArtist?.artists || []).find((a) => a.key === drill.key)?.name
                      || (drill.key ? drill.key : 'Not attributed to an artist'))
                  : drill.key}
                {drill.kind === 'artist' && drill.category && (
                  <span className="font-semibold text-gray-500"> · {drill.category}</span>
                )}
              </span>
              <span className="text-[12px] text-gray-400">{drill.month ? monthLabel(drill.month) : `${from} → ${to}`}{artistF && drill.kind !== 'artist' ? ` · ${artistF}` : ''}</span>
              {drillData && (
                <span className="ml-auto text-right">
                  <span className="font-mono text-sm font-bold">{fmt(drillData.total)}</span>
                  {/* Filtering must not make the header total look like the sum
                      of the visible rows. The cell total stays; the filtered
                      sum appears beneath it, labelled. */}
                  {drillQ.trim() && drillShown.length !== drillRows.length && (
                    <span className="block text-[10.5px] font-bold text-boom-600">
                      {fmt(drillShownTotal)} shown
                    </span>
                  )}
                  {/* The modal total must equal the cell, so anything excluded
                      is stated beside it rather than folded in silently. */}
                  {drillData.dismissed?.count > 0 && (
                    <button onClick={() => { closeDrill(); setTab("dismissed") }}
                      title={`${drillData.dismissed.count} item${drillData.dismissed.count === 1 ? '' : 's'} excluded from this cell — click to review`}
                      className="block text-[10.5px] font-bold text-amber-600 hover:text-amber-700 underline decoration-dotted">
                      +{fmt(drillData.dismissed.total)} dismissed
                    </button>
                  )}
                  {/* The total above covers every row; the list below is capped.
                      Said out loud, because a truncated list that doesn't
                      announce itself reads as the complete set. */}
                  {drillData.truncated && (
                    <span className="block text-[10.5px] font-bold text-gray-400"
                      title={`The ${drillShown.length} rows listed come to ${fmt(drillShownTotal)}. The ${fmt(drillData.total)} above is the whole cell — every row, including the ones past the cap.`}>
                      showing first {drillData.rows.length} of {drillData.row_count} · {fmt(drillShownTotal)} listed — the total covers all of them
                    </span>
                  )}
                </span>
              )}
              {drillShown.length > 0 && (drillEditable || artistAssignable) && (
                <button onClick={openReviewDeck}
                  title="Review these one card at a time — → accept · ← skip · 1-9 pick category"
                  className="inline-flex items-center gap-1.5 bg-ink text-card hover:opacity-85 rounded-lg px-2.5 py-1 text-[12px] font-bold">
                  <Zap size={12} /> Review {drillShown.length}
                </button>
              )}
              <button onClick={closeDrill} className="text-gray-400 hover:text-gray-600 p-1"><X size={16} /></button>
            </div>
            {/* Filter the rows behind this cell. Gated on the UNFILTERED count so
                the input never disappears along with the rows it emptied. Only
                worth showing once there's enough to scan. */}
            {drillRows.length > 5 && (
              <div className="px-4 py-2 border-b border-divider flex flex-wrap items-center gap-x-3 gap-y-2">
                <ListSearch
                  value={drillQ}
                  onChange={setDrillQ}
                  placeholder="Filter — payee, artist, song, inv #, amount…"
                  count={drillShown.length}
                  total={drillRows.length}
                  width={300}
                />
                {/* Beside the filter, because they answer the same question —
                    "find me this row" — and the Review deck below takes the rows
                    in exactly this order, so sorting also chooses what you work
                    through first. */}
                <span className="flex items-center gap-1 text-[11px] text-gray-400 font-semibold">
                  <ArrowDownUp size={11} />
                  Sort
                </span>
                {[
                  { key: 'date', label: 'Date', dir: 1, asc: 'earliest first', desc: 'latest first' },
                  { key: 'payee', label: 'Name', dir: 1, asc: 'A → Z', desc: 'Z → A' },
                  { key: 'amount', label: 'Amount', dir: 1, asc: 'largest first', desc: 'smallest first' },
                ].map((o) => {
                  const on = drillSort.key === o.key
                  const which = on && drillSort.dir !== o.dir ? o.desc : o.asc
                  return (
                    <button key={o.key} onClick={() => toggleSort(o.key, o.dir)}
                      title={on ? `Sorted by ${o.label.toLowerCase()} — ${which}. Click to reverse.` : `Sort by ${o.label.toLowerCase()} (${o.asc})`}
                      className={`text-[11px] font-bold rounded-full px-2 py-0.5 border transition-colors ${on
                        ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
                        : 'bg-card text-gray-500 border-rule hover:text-ink'}`}>
                      {o.label}
                      {on && <span className="font-normal"> · {which}</span>}
                    </button>
                  )
                })}
              </div>
            )}
            {/* Bulk bar: select rows below (or all), pick once, apply once.
                Shown on the ARTIST drill too. It was gated on drillEditable —
                P&L cells only — while the row CHECKBOXES were gated on
                drillEditable || artistAssignable, so on an artist cell you could
                tick every row and then find nothing to act with: no select-all,
                no category picker, no Attribute button. Selecting into a void.
                The month control is the one thing here that really is P&L-only,
                and it keeps its own gate below. */}
            {(drillEditable || artistAssignable) && drillShown.length > 1 && (
              <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-divider bg-gray-50/50">
                <label className="flex items-center gap-1.5 text-[12px] font-semibold text-gray-500 cursor-pointer">
                  <input type="checkbox"
                    checked={drillSel.size === drillShown.length && drillShown.length > 0}
                    onChange={() => setDrillSel(drillSel.size === drillShown.length ? new Set() : new Set(drillShown.map((r) => r.id)))} />
                  Select all
                </label>
                {/* What the selection is WORTH — the figure that decides whether
                    a bulk apply is worth doing. Reduced over the selected rows
                    themselves, so it agrees with the list above it. */}
                <span className="text-[12px] text-gray-400 tabular-nums">
                  {drillSel.size} selected
                  {drillSel.size > 0 && (
                    <span className="font-bold text-gray-500"> · {fmt(drillShown.reduce((t, r) => t + (drillSel.has(r.id) ? (Number(r.usd) || 0) : 0), 0))}</span>
                  )}
                </span>
                {/* Attribute the WHOLE cell, not the visible page.
                    The list is capped at 500 rows because each one detoasts
                    its invoice file flags; the ids aren't, so a bulk can cover
                    all of them. Without this, attributing a 569-row cell meant
                    select-all, apply, reopen, repeat — and the cap made it
                    look finished when it wasn't. Only offered when there is
                    genuinely more than the screen holds. */}
                {drill.kind !== 'income' && drillData.truncated && !drillQ.trim() && (drillData.all_expense_ids?.length > 0) && (
                  <span className="flex items-center gap-1.5">
                    <ArtistSelect
                      value={bulkArtist}
                      options={roster}
                      onChange={setBulkArtist}
                      placeholder="Artist…"
                      clearValue={NO_ARTIST}
                      className="border border-rule rounded-lg px-2 py-1 text-[12px] bg-card text-ink outline-none"
                    />
                    <button
                      onClick={() => setArtist(drillData.all_expense_ids, bulkArtist === NO_ARTIST ? '' : bulkArtist)}
                      disabled={!bulkArtist || bulkBusy}
                      title={`Attribute every entry in this cell — all ${drillData.all_expense_ids.length}, not just the ${drillShown.length} listed`}
                      className="inline-flex items-center gap-1.5 border border-ink text-ink hover:bg-gray-50 rounded-lg px-2.5 py-1 text-[12px] font-bold disabled:opacity-40">
                      {bulkBusy ? <Loader size={12} className="animate-spin" /> : null}
                      {bulkArtist === NO_ARTIST ? 'Clear artist on' : 'Attribute all'} {drillData.all_expense_ids.length}
                    </button>
                  </span>
                )}
                {drillSel.size > 0 && (() => {
                  // What the selection can actually be given. A row with no
                  // ledger entry has nothing to write an artist to, and saying
                  // "Attribute 6" when two of them cannot take one overstates
                  // what the button does — the same lesson as the vendor page's
                  // selection-scoped attribution.
                  const sel = drillShown.filter((r) => drillSel.has(r.id))
                  // The PART each selected row is about — and a row whose cell
                  // owns several parts of one payment is excluded, exactly as it
                  // is excluded from the per-row control. A bulk that quietly
                  // wrote the family root would relabel money outside the cell.
                  const withEntry = sel.filter((r) => editableHere(r) && partIdsOf(r).length)
                  return (
                  <span className="ml-auto flex items-center gap-1.5">
                    <CategorySelect
                      value={bulkCat}
                      kind={drill.kind === 'income' ? 'income' : 'expense'}
                      onChange={setBulkCat}
                      placeholder={drill.kind === 'income' ? 'Income type…' : 'Category…'}
                      className="border border-rule rounded-lg px-2 py-1 text-[12px] bg-card text-ink outline-none"
                    />
                    <button onClick={applyBulk} disabled={!bulkCat || bulkBusy}
                      className="inline-flex items-center gap-1.5 bg-ink text-card hover:opacity-85 rounded-lg px-2.5 py-1 text-[12px] font-bold disabled:opacity-40">
                      {bulkBusy ? <Loader size={12} className="animate-spin" /> : null}
                      {bulkProgress ? `${bulkProgress.done}/${bulkProgress.total}` : `Apply to ${drillSel.size}`}
                    </button>
                    {/* Attribute the selection to an artist. Its own control
                        and its own button for the same reason the month one is
                        separate: a single combined Apply would leave it
                        ambiguous which edit was about to happen. */}
                    {drill.kind !== 'income' && (
                      <>
                        <span className="w-px h-5 bg-gray-200" />
                        <ArtistSelect
                          value={bulkArtist}
                          options={roster}
                          onChange={setBulkArtist}
                          placeholder="Artist…"
                          clearValue={NO_ARTIST}
                          className="border border-rule rounded-lg px-2 py-1 text-[12px] bg-card text-ink outline-none"
                        />
                        <button
                          onClick={() => setArtist(withEntry.flatMap((r) => partIdsOf(r)), bulkArtist === NO_ARTIST ? '' : bulkArtist)}
                          disabled={!bulkArtist || bulkBusy || !withEntry.length}
                          title={withEntry.length === sel.length
                            ? "Attribute the rows you've selected"
                            : `${withEntry.length} of the ${sel.length} selected rows have one ledger entry to write an artist to; the rest are unbooked bank lines, or payments this cell holds several parts of — book or re-cut those first.`}
                          className="inline-flex items-center gap-1.5 bg-ink text-card hover:opacity-85 rounded-lg px-2.5 py-1 text-[12px] font-bold disabled:opacity-40">
                          {bulkBusy ? <Loader size={12} className="animate-spin" /> : null}
                          {bulkArtist === NO_ARTIST ? 'Clear artist on' : 'Attribute'} {withEntry.length}
                          {withEntry.length !== sel.length && (
                            <span className="font-normal opacity-70">of {sel.length}</span>
                          )}
                        </button>
                      </>
                    )}
                    {/* Move the selection to another month. Separate control and
                        separate button from the category one — they are
                        different edits, and one combined Apply would make it
                        ambiguous which was about to happen.
                        P&L cells only: an artist cell spans the whole window, so
                        "which month is this in" is not a question it asks. */}
                    {drillEditable && (
                      <>
                        <span className="w-px h-5 bg-gray-200" />
                        <select value={bulkMonth} onChange={(e) => setBulkMonth(e.target.value)}
                          className="border border-rule rounded-lg px-2 py-1 text-[12px] bg-card text-ink outline-none">
                          <option value="">Move to month…</option>
                          {monthsForReassign().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
                        </select>
                        <button onClick={applyBulkMonth} disabled={!bulkMonth || bulkBusy}
                          className="inline-flex items-center gap-1.5 border border-rule text-gray-600 hover:bg-gray-50 rounded-lg px-2.5 py-1 text-[12px] font-bold disabled:opacity-40">
                          Move {drillSel.size}
                        </button>
                      </>
                    )}
                  </span>
                  )
                })()}
              </div>
            )}
            <div className="overflow-y-auto">
              {/* WHAT CAME BACK, netted off the total above but not listed as
                  spend. Five deposits sat among 500 Marketing payments as
                  negatives, which reads as money going out. The line stays
                  because the cell total nets them — hiding it entirely would
                  leave the rows below unable to add up to the header. */}
              {drillData?.recoveries?.count > 0 && (
                <div className="px-4 py-2 border-b border-divider bg-emerald-50/40">
                  <button onClick={() => setRecOpen((v) => !v)}
                    className="w-full flex items-center gap-2 text-left">
                    <span className="text-[12px] font-bold text-emerald-800">
                      less {drillData.recoveries.count} reimbursement{drillData.recoveries.count === 1 ? '' : 's'} received
                    </span>
                    <span className="font-mono text-[12px] font-bold text-emerald-800">
                      {fmt(drillData.recoveries.total)}
                    </span>
                    <span className="ml-auto text-[11px] font-semibold text-emerald-700">
                      {recOpen ? 'hide' : 'show'}
                    </span>
                  </button>
                  <p className="text-[11px] text-emerald-800/70 mt-0.5">
                    Money that came back for this line. It reduces the total above rather than being
                    reported as income, so the two sides can never both count it.
                  </p>
                  {recOpen && drillData.recoveries.rows.map((r) => (
                    <div key={`rec-${r.id}`} className="flex items-center gap-3 px-1 py-1 text-[12.5px]">
                      <span className="font-mono text-[11px] text-gray-400 shrink-0">{fmtDay(r.date)}</span>
                      <PayeeLink payee={r.payee} className="min-w-0 flex-1 truncate font-semibold text-ink" />
                      <span className="font-mono font-bold text-emerald-800 shrink-0">{fmt(r.usd)}</span>
                    </div>
                  ))}
                </div>
              )}
              {!drillData ? (
                <div className="px-4 py-6 text-sm text-gray-400 text-center">Loading entries…</div>
              ) : drillData.error ? (
                <div className="px-4 py-6 text-sm text-rose-600 text-center">{drillData.error}</div>
              ) : drillRows.length === 0 ? (
                <div className="px-4 py-6 text-sm text-gray-400 text-center">No entries.</div>
              ) : drillShown.length === 0 ? (
                // Distinct from "No entries." — the cell has rows, the query
                // just didn't match any of them.
                <div className="px-4 py-6 text-center">
                  <p className="text-sm text-gray-500">Nothing here matches “{drillQ}”.</p>
                  <button onClick={() => setDrillQ('')}
                    className="mt-1 text-[12px] font-bold text-boom-600 hover:text-boom-700">Clear filter</button>
                </div>
              ) : drillShown.map((r) => (
                <div key={r.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 border-b border-divider text-[13px] ${r.dismissed ? 'opacity-45' : ''}`}>
                  {(drillEditable || artistAssignable) && (                    <input type="checkbox" checked={drillSel.has(r.id)}
                      onChange={() => setDrillSel((prev) => { const n = new Set(prev); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n })}
                      className="shrink-0" />
                  )}
                  <span className="font-mono text-[11px] text-gray-400 shrink-0">{fmtDay(r.date)}</span>
                  {/* The date shown is always the real bank date — it's
                      evidence. When the row is reported in a different month,
                      say so here rather than leaving it looking misfiled. */}
                  {r.moved_from && (
                    <span title={`Bank date is ${monthLabel(r.moved_from)}; reported in ${monthLabel(r.report_month)}`}
                      className="shrink-0 inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-bold bg-violet-50 text-violet-700 border border-violet-200">
                      <CalendarClock size={9} />{monthLabel(r.report_month)}
                    </span>
                  )}
                  {/* A floor, not just flex-1: "shrink to nothing" is a legal
                      answer to flex-1 and it is the one the browser was giving.
                      Below this width the controls wrap instead. */}
                  <span className="min-w-[200px] flex-1 basis-[220px]">
                    <PayeeLink payee={r.payee} className="block font-semibold text-ink truncate" />
                    {(r.artist || r.song || r.invoice_number || r.source) && (
                      <span className="block text-[11px] text-gray-400 truncate">
                        {[r.artist, r.song, r.invoice_number ? `inv ${r.invoice_number}` : null, r.source].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                  {/* What this row's category is worth. A booked row and an
                      invoice-backed one looked identical here, so the page could
                      not tell you whether "Royalties" came off an invoice or off
                      a bank descriptor we guessed from. */}
                  {r.evidence === 'invented' && (
                    // Straight to the attach picker for THIS line, on the vendor
                    // page. Deliberately a link and not a picker of its own: the
                    // vendor page already knows how to choose invoices, tick
                    // several for one payment, show the running total and read the
                    // document first. A second copy here would be a second answer
                    // to the same question, which is the duplication this codebase
                    // keeps paying for.
                    <a href={`/bk/vendors/${encodeURIComponent(r.payee || '')}?attach=${r.txn_id}`}
                      target="_blank" rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 hover:bg-amber-100"
                      title="No invoice behind this — the category comes from an entry we invented from the bank line. Opens this payment's attach picker on the vendor page.">
                      no invoice · attach
                    </a>
                  )}
                  {r.evidence === 'invoice' && (
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-emerald-700"
                      title="Backed by a real invoice in the ledger">
                      ✓ invoice
                    </span>
                  )}
                  <DocButton row={r} onOpen={setPreviewFile} />
                  {/* A payment split across artists or categories appears in
                      several cells, each for its own share. Showing $600 against
                      a $1,000 bank debit with nothing to explain it reads as a
                      wrong number, so the row says which part of the payment
                      this cell is. */}
                  {r.split_of ? (
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-gray-500"
                      title={`This payment was ${fmt(r.split_of)} and is split across ${
                        r.split_categories?.length > 1 ? r.split_categories.join(', ') : 'several categories or artists'
                      }. Only this cell's share is counted here — the rest is counted in the other cells, never twice.${
                        partIdOf(r) ? ' The controls on this row act on THIS part only.' : ''
                      }${
                        isAmbiguousSplit(r) ? ' This cell holds several of its parts, so it is re-cut on Bank Matching.' : ''
                      }`}>
                      split of {fmt(r.split_of)}
                    </span>
                  ) : null}
                  <span className="font-mono font-bold shrink-0">
                    {fmt(r.usd)}{r.currency && r.currency !== 'USD' ? <span className="text-[10px] text-gray-400 font-normal"> ({r.currency})</span> : null}
                  </span>
                  {(() => {
                    // Recategorize in place. Booked/matched rows: change the
                    // category (moves it to another cell). Unbooked bank
                    // rows: booking them IS the categorization.
                    const isIncome = drill.kind === 'income'
                    const opts = isIncome ? catIncome : catExpense
                    const parts = isIncome ? [] : partIdsOf(r)
                    const hasRecord = isIncome ? r.income_id : (editableHere(r) ? parts.length : 0)
                    const current = hasRecord && opts.includes(drill.key) ? drill.key : ''
                    if (!hasRecord && !r.txn_id) return null
                    // A split payment is editable HERE, for the part this cell is
                    // about — `part_expense_ids` names it, so the Royalties share
                    // moves and the Marketing share does not. This used to refuse
                    // outright, because the only id the row carried was the family
                    // root's and writing to it retyped the wrong part.
                    //
                    // What still cannot be answered here: a cell that owns SEVERAL
                    // parts of one payment (an artist cell spanning two
                    // categories). There is no single part to act on, so it goes
                    // to Bank Matching where the whole payment is visible.
                    if (isAmbiguousSplit(r)) {
                      return (
                        <a href={`/bk/bank-matching?q=${encodeURIComponent(r.payee || '')}`}
                          title={`This cell holds ${r.split_categories?.length || 'several'} parts of one ${fmt(r.split_of)} payment, so there is no single part to relabel here. Re-cut the split on Bank Matching, where all of it is visible.`}
                          className="shrink-0 text-[11.5px] font-semibold text-gray-500 hover:text-ink underline decoration-dotted">
                          edit split
                        </a>
                      )
                    }
                    return (
                      <CategorySelect
                        value={current}
                        kind={isIncome ? 'income' : 'expense'}
                        disabled={drillBusy === r.id}
                        onChange={(v) => recategorize(r, v)}
                        placeholder={hasRecord
                          ? (r.split_of ? 'Recategorize part…'
                            : parts.length > 1 ? `Recategorize all ${parts.length}…` : 'Recategorize…')
                          : (isIncome ? 'Book income…' : 'Book as…')}
                        className="shrink-0 border border-rule rounded-lg px-1.5 py-1 text-[11.5px] bg-card text-gray-500 hover:text-ink outline-none disabled:opacity-50"
                      />
                    )
                  })()}
                  {/* Who the spend was FOR. Only rows with a ledger entry can
                      carry an artist — an unbooked bank row has nothing to
                      write it to — so those are disabled and SAY why rather
                      than being quietly absent. On this drill that is 7 rows
                      of 500. Income rows have no artist field at all. */}
                  {artistAssignable && !isAmbiguousSplit(r) && (
                    <ArtistSelect
                      value={r.artist || ''}
                      options={roster}
                      disabled={drillBusy === r.id || !editableHere(r) || !partIdsOf(r).length}
                      title={!partIdsOf(r).length || !editableHere(r)
                        ? 'Book it first — an unbooked bank row has no ledger entry to attribute'
                        : r.split_of
                          ? `Attribute just this ${fmt(r.usd)} part of the ${fmt(r.split_of)} payment — the rest keeps its own artist`
                          : partIdsOf(r).length > 1
                            ? `This payment is split ${partIdsOf(r).length} ways inside this cell — all ${partIdsOf(r).length} parts get this artist`
                            : 'Attribute this spend to an artist'}
                      placeholder={!editableHere(r) || !partIdsOf(r).length ? 'Book first'
                        : r.split_of ? 'Artist for part…'
                        : partIdsOf(r).length > 1 ? `Artist for all ${partIdsOf(r).length}…` : 'Artist…'}
                      onChange={(v) => setArtist(partIdsOf(r), v, { rowId: r.id })}
                      className="shrink-0 border border-rule rounded-lg px-1.5 py-1 text-[11.5px] bg-card text-gray-500 hover:text-ink outline-none disabled:opacity-40 max-w-[130px]"
                    />
                  )}
                  {/* Reassign the reported month. Bank rows only: an unverified
                      ledger row isn't counted in the P&L, so there's no column
                      for it to move between. Selecting the row's own bank month
                      clears the override. */}
                  {drillEditable && r.txn_id && (
                    <select
                      value={r.report_month || ''}
                      disabled={drillBusy === r.id}
                      onChange={(e) => reassignMonth(r, e.target.value)}
                      title="Which month the P&L reports this in — the bank date does not change"
                      className={`shrink-0 border rounded-lg px-1.5 py-1 text-[11.5px] bg-card outline-none disabled:opacity-50 ${
                        r.moved_from ? 'border-violet-300 text-violet-700 font-semibold' : 'border-rule text-gray-500 hover:text-ink'}`}>
                      {/* The row's own months are always present, or a value
                          outside the offered window would render as blank and
                          the next change would silently move it. */}
                      {[...new Set([...monthsForReassign(), r.report_month, r.moved_from].filter(Boolean))]
                        .sort().map((m) => (
                          <option key={m} value={m}>{monthLabel(m)}{m === r.moved_from ? ' (bank date)' : ''}</option>
                        ))}
                    </select>
                  )}
                  {/* Balance-sheet rows exclude by their namespaced bs_ref —
                      they carry neither a txn_id nor an expense_id, and using
                      the expense_id would collide with the P&L's own dismissal
                      of the same bill (that column is UNIQUE). */}
                  {r.bs_ref && (
                    <button
                      onClick={() => {
                        if (r.dismissed) return bsRestore({ scope: 'bs_item', bs_ref: r.bs_ref })
                        bsExclude({ scope: 'bs_item', bs_ref: r.bs_ref, cell_key: drill?.key || null },
                          `Exclude ${r.payee} — ${fmt(r.usd)} from the balance sheet?\n\nIt stops counting toward ${drill?.key || 'this line'}. Reason (optional):`)
                      }}
                      disabled={dismissBusy === r.bs_ref}
                      title={r.dismissed ? 'Restore to the balance sheet' : 'Exclude from the balance sheet'}
                      className={`shrink-0 p-1 ${r.dismissed ? 'text-emerald-600 hover:text-emerald-700' : 'text-gray-300 hover:text-rose-600'} disabled:opacity-40`}>
                      {dismissBusy === r.bs_ref ? <Loader size={13} className="animate-spin" />
                        : r.dismissed ? <Undo2 size={13} /> : <Ban size={13} />}
                    </button>
                  )}
                  {/* Dismiss. Only where the row is identifiable — a P&L row
                      always carries a txn_id; the unverified drill carries an
                      expense_id. */}
                  {(r.txn_id || r.expense_id) && (
                    <button
                      onClick={() => {
                        const counts = !!r.txn_id
                        const reason = window.prompt(counts
                          ? `Dismiss ${r.payee} — ${fmt(r.usd)}?\n\nThis REMOVES it from the ${drill.key} total. Reason (optional):`
                          : `Hide ${r.payee} — ${fmt(r.usd)} from this worklist?\n\nThis row isn't counted in the P&L, so no total changes. Reason (optional):`)
                        if (reason === null) return // cancelled
                        dismissRow(r, reason)
                      }}
                      disabled={dismissBusy === r.id}
                      title={r.txn_id
                        ? 'Dismiss — excludes this item from the report total'
                        : 'Hide from this worklist — not counted in the P&L either way'}
                      className="shrink-0 p-1 text-gray-300 hover:text-rose-600 disabled:opacity-40">
                      {dismissBusy === r.id ? <Loader size={13} className="animate-spin" /> : <Ban size={13} />}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Review deck over the drill rows — shared shell, report-specific card ── */}
      {revDeck && (() => {
        const r = revDeck.rows[revDeck.index]
        const done = !r
        const opts = revOpts()
        const hasRecord = r ? revHasRecord(r) : false
        // The row's own document — pickDoc is the one answer to "is there a
        // file", the same one this page's DocButton uses.
        const rDoc = previewOn && r ? pickDoc(r) : null
        return (
          <ReviewDeck
            index={revDeck.index}
            total={revDeck.rows.length}
            sub={`${fmt(revMoney.done)} of ${fmt(revMoney.total)}`}
            label={
              <span className="inline-flex items-center gap-2 min-w-0">
                <span className="truncate">{drill.key}</span>
                <button onClick={togglePreview}
                  title={previewOn ? 'Hide the document panel (P)' : 'Show the document beside each card (P)'}
                  className="inline-flex items-center gap-1 text-white/60 hover:text-white font-semibold shrink-0">
                  <FileText size={12} /> {previewOn ? 'on' : 'off'}
                </button>
              </span>
            }
            aside={previewOn && r ? (
              <InlineFilePreview
                url={rDoc ? fileUrl(r, rDoc.type) : null}
                filename={rDoc ? (r[rDoc.name] || rDoc.label) : null}
                label={rDoc ? rDoc.label : 'No document'}
                meta={[r.payee, r.invoice_number ? `inv ${r.invoice_number}` : null].filter(Boolean).join(' · ')}
                emptyText="No invoice, proof or receipt on this row — an unbooked bank charge has no document behind it." />
            ) : null}
            onClose={closeRevDeck}
            // Opens on top of the drill modal (z-50), so it needs a higher layer.
            z={70}
            done={done}
            doneTitle="All reviewed"
            doneSummary={`${revDeck.changed} item${revDeck.changed === 1 ? '' : 's'}`
              + `${revDeck.changed ? ` · ${fmt(revMoney.changed)}` : ''}`
              + ` changed in “${drill.key}” — recategorized, booked, or dismissed.`
              + ` Reviewed ${fmt(revMoney.total)} across ${revDeck.rows.length} item${revDeck.rows.length === 1 ? '' : 's'}.`}
            hint="→ accept · ← skip · D dismiss · F flag · ⌫ back/undo · 1-9 pick category · P preview · Esc close"
          >
            {() => (
                <div className="bg-card rounded-2xl p-6 shadow-2xl">
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex items-center gap-1.5">
                      <span className={`text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded ${hasRecord ? 'bg-gray-100 text-gray-500' : 'bg-rose-50 text-rose-700'}`}>
                        {hasRecord ? `currently ${drill.key}` : 'not booked yet'}
                      </span>
                      {r.flagged && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-50 text-amber-700">
                          <Flag size={9} /> flagged
                        </span>
                      )}
                    </span>
                    <span className="font-mono text-[12px] text-gray-400">{fmtDay(r.date)}</span>
                  </div>
                  <div className="text-3xl font-black text-ink">
                    {fmt(r.usd)}
                    {r.currency && r.currency !== 'USD' ? <span className="text-base font-bold text-gray-400"> · {Number(r.amount).toLocaleString()} {r.currency}</span> : null}
                  </div>
                  {/* Weight, so a card reads as "most of this line" or "a
                      rounding error in it" without leaving the deck. Of the
                      DECK, not of the cell — those differ the moment the drill
                      is filtered, and the header's denominator is this one. */}
                  {revMoney.total !== 0 && (
                    <div className="text-[11px] font-bold text-gray-400 tabular-nums">
                      {Math.abs(r.usd / revMoney.total) < 0.001 ? '<0.1' : (Math.abs(r.usd / revMoney.total) * 100).toFixed(1)}%
                      {' '}{r.is_recovery ? 'off' : 'of'} the {fmt(revMoney.total)} in this deck
                    </div>
                  )}
                  <div className="text-[15px] font-bold text-ink mt-1 truncate">
                    <PayeeLink payee={r.payee} />
                  </div>
                  {(r.artist || r.song || r.invoice_number || r.source) && (
                    <div className="text-[12px] text-gray-400 truncate">
                      {[r.artist, r.song, r.invoice_number ? `inv ${r.invoice_number}` : null, r.source].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  <div className="mt-4 rounded-xl border border-rule bg-gray-50/60 p-3">
                    <div className="text-[10px] font-extrabold uppercase tracking-wider text-emerald-600 mb-1">
                      {hasRecord ? 'Accept to keep — or pick a better category' : 'Pick a category to book, then accept'}
                    </div>
                    <CategorySelect
                      value={revDeck.sel}
                      kind={drill.kind === 'income' ? 'income' : 'expense'}
                      numbered
                      options={revOpts()}
                      onChange={(v) => setRevDeck((d) => (d ? { ...d, sel: v } : d))}
                      placeholder={hasRecord ? `Keep ${drill.key}` : 'Pick a category…'}
                      className="w-full border border-emerald-300 rounded-lg px-2 py-2 text-[13px] font-semibold bg-card text-emerald-700"
                    />
                    {hasRecord && revDeck.sel && revDeck.sel !== drill.key && (
                      <div className="text-[11px] text-amber-600 font-semibold mt-1">Will move: {drill.key} → {revDeck.sel}</div>
                    )}
                    {/* Reported month. Applies immediately rather than on
                        Accept — Accept means "this category is right", and
                        overloading it with a second, unrelated edit would make
                        it unclear what the button was about to do. */}
                    {r.txn_id && (
                      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-divider">
                        <span className="text-[10px] font-extrabold uppercase tracking-wider text-gray-400 shrink-0">Reported in</span>
                        <select
                          value={r.report_month || String(r.date || '').slice(0, 7)}
                          disabled={revBusy}
                          onChange={(e) => revMonth(e.target.value)}
                          className={`flex-1 border rounded-lg px-2 py-1 text-[12px] font-semibold bg-card outline-none disabled:opacity-50 ${
                            r.moved_from ? 'border-violet-300 text-violet-700' : 'border-rule text-gray-600'}`}>
                          {[...new Set([...monthsForReassign(), r.report_month, String(r.date || '').slice(0, 7)].filter(Boolean))]
                            .sort().map((m) => (
                              <option key={m} value={m}>
                                {monthLabel(m)}{m === String(r.date || '').slice(0, 7) ? ' (bank date)' : ''}
                              </option>
                            ))}
                        </select>
                      </div>
                    )}
                  </div>
                  <div className="flex items-start justify-center gap-3 mt-5">
                    <DeckButton onClick={revBack} disabled={revBusy || !revDeck.history.length}
                      title="Back — undo the previous card (⌫)" label="Undo">
                      <Undo2 size={18} />
                    </DeckButton>
                    <DeckButton onClick={revFlag} disabled={revBusy || !r.txn_id}
                      tone={r.flagged ? 'amberOn' : 'amber'}
                      title={r.flagged ? 'Unflag (F)' : 'Flag for review — stays on this card (F)'}
                      label={r.flagged ? 'Unflag' : 'Flag'}>
                      <Flag size={17} className={r.flagged ? 'fill-amber-400' : ''} />
                    </DeckButton>
                    <DeckButton onClick={revDismiss} disabled={revBusy || !(r.txn_id || r.expense_id)}
                      tone="rose" label="Dismiss"
                      title={r.txn_id
                        ? 'Dismiss — excludes this item from the report total (D)'
                        : 'Hide from this worklist — no total changes (D)'}>
                      <Ban size={18} />
                    </DeckButton>
                    <DeckButton onClick={() => revAdvance({ index: revDeck.index, applied: false })}
                      disabled={revBusy} title="Skip (←)" label="Skip">
                      <ChevronLeft size={18} />
                    </DeckButton>
                    <DeckButton onClick={revAccept} disabled={revBusy || (!hasRecord && !revDeck.sel)}
                      tone="accept" size="lg" title="Accept (→)" label={hasRecord ? 'Apply' : 'Book'}>
                      {revBusy ? <Loader size={20} className="animate-spin" /> : <CheckCircle2 size={24} />}
                    </DeckButton>
                  </div>
                </div>
            )}
          </ReviewDeck>
        )
      })()}

      {/* Last in the tree so it sits above the drill modal and the review deck,
          both of which a document can be opened from. */}
      {previewFile && (
        <FilePreview url={previewFile.url} filename={previewFile.filename}
          onClose={() => setPreviewFile(null)} />
      )}
    </div>
  )
}
