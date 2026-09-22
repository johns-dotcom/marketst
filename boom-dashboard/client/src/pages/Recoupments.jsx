import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom'
import { addToPlan, loadPlan, planSize } from '../lib/recoupmentPlan'
import { Loader, Search, X, ChevronDown, ChevronRight, Check, CheckCircle2, Tag, Edit2, Music2, FileText, ArrowLeft, FolderOpen, Plus, Upload, Sparkles, Trash2, Undo2, Download, Copy, AtSign, StickyNote, ExternalLink, CalendarClock, AlertTriangle } from 'lucide-react'
import { CURRENCIES, CATEGORIES, SOCIAL_PLATFORMS } from '../constants'
import { useCategories } from '../context/CategoriesContext'
import api from '../api'
import PayeeLink from '../components/PayeeLink'
import PageHeader from '../components/PageHeader'
import Skeleton from '../components/Skeleton'
import FilePreview from '../components/FilePreview'
import CommentThreadButton from '../components/CommentThreadButton'
import FlagButton from '../components/FlagButton'
import { formatDate, usdSuffix, totalsToUsd, usdTotalSuffix, toUsd, itemsToUsd, usdItemsSuffix, fmtUsdItems, usdSuffixForEntry, entryToUsd, normalizeArtistKey, familyArtists, filterSocialsForArtist, withoutBankRows, withoutUnreviewedBankRows, bankUnverified, recoupState, recoupCounted } from '../utils'
import BankEvidenceDot from '../components/BankEvidenceDot'
import { useFxRates } from '../context/FxRatesContext'
import { useToast } from '../context/ToastContext'
import EmptyState from '../components/EmptyState'
import Breadcrumb from '../components/Breadcrumb'
import useArtistLink from '../hooks/useArtistLink'

function fmt(v, currency = 'USD') {
  if (!v && v !== 0) return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(0)
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', minimumFractionDigits: 2 }).format(Number(v))
}

// ── Recoupment statement windows ────────────────────────────────────────────
// Statements are released on the 20th of each month and cover the prior
// release-to-release window: the June statement is released June 20 and
// includes every item uploaded for recoupment between May 21 and June 20
// (inclusive). So a row stamped on day ≤20 belongs to that month's
// statement; a row stamped on day ≥21 rolls forward into the next month's
// statement (with year roll-over for Dec 21 → next Jan).
function statementMonthFor(timestamp) {
  if (!timestamp) return null
  const d = new Date(timestamp)
  if (isNaN(d.getTime())) return null
  // UTC getters — the local-time versions bucketed the same row into
  // different statements depending on the viewer's timezone (a 2:00 UTC
  // stamp is "the 20th" in Chicago and "the 21st" in London), so two
  // teammates could reconcile different months for the same item.
  let year = d.getUTCFullYear()
  let month = d.getUTCMonth() + 1 // 1..12
  if (d.getUTCDate() >= 21) {
    month += 1
    if (month > 12) { month = 1; year += 1 }
  }
  return `${year}-${String(month).padStart(2, '0')}`
}

// "Jun 2026" for the tab label.
function statementLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '')
  if (!m) return ym || ''
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, 1)
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

// "May 21 – Jun 20, 2026" — surfaced in the tab tooltip so users can see the
// exact upload window each statement covers without having to remember the
// 21/20 rule.
function statementWindowLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '')
  if (!m) return ''
  const year = parseInt(m[1], 10)
  const month = parseInt(m[2], 10)
  let startYear = year
  let startMonth = month - 1
  if (startMonth < 1) { startMonth = 12; startYear = year - 1 }
  const start = new Date(startYear, startMonth - 1, 21)
  const end   = new Date(year, month - 1, 20)
  const f = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${f(start)} – ${f(end)}`
}

// Sum an entry list into a { CUR: amount } map. Keeps each currency
// separate so a €500 row doesn't get blindly added into the USD total.
function groupByCurrency(list) {
  const map = {}
  for (const e of list) {
    if (!e?.amount) continue
    const cur = (e.currency || 'USD').toUpperCase()
    map[cur] = (map[cur] || 0) + parseFloat(e.amount || 0)
  }
  return map
}

// Render a { CUR: amount } map as "$1,234.56" (single currency) or
// "$1,234.56 + €1,000.00" (mixed). USD sorts first, then the rest.
// A card cannot render seven currencies on one line. The 1,830-item Unassigned
// group produced "$2,494,979.87 + A$3,110.59 + R$3,118.16 + CA$2,890.98 +
// CHF 671.08 + €2,838.68 + £1,253.88 + …" and, sitting in a flex-shrink-0
// column, that string refused to shrink — so it crushed the artist name and the
// "N items · M groups" line down to one word per line.
//
// Show the leading currencies, count the rest, keep the full breakdown in the
// title. The ≈USD line underneath is the comparable figure anyway.
function fmtTotalsCompact(totals, max = 2) {
  const parts = Object.entries(totals || {}).filter(([, v]) => v)
  if (!parts.length) { const z = fmt(0); return { text: z, full: z, overflow: 0 } }
  parts.sort(([a], [b]) => a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b))
  const full = parts.map(([cur, v]) => fmt(v, cur)).join(' + ')
  if (parts.length <= max) return { text: full, full, overflow: 0 }
  const head = parts.slice(0, max).map(([cur, v]) => fmt(v, cur)).join(' + ')
  return { text: `${head} + ${parts.length - max} more`, full, overflow: parts.length - max }
}

function fmtTotals(totals) {
  const parts = Object.entries(totals).filter(([, v]) => v)
  if (!parts.length) return fmt(0)
  parts.sort(([a], [b]) => a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b))
  return parts.map(([cur, v]) => fmt(v, cur)).join(' + ')
}

// Normalize the social_handles array from the server (each item is
// { platform, handle }) into a flat list of usable strings, dropping
// entries that are empty / whitespace. Used both for rendering the
// inline chip on each row AND for letting the search bar match by
// handle so users can hunt down "where did we spend on @joe_smith?".
function socialsList(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .map(s => {
      const platform = (s?.platform || '').trim()
      const handle = (s?.handle || '').trim()
      if (!handle && !platform) return null
      return { platform, handle, amount: s?.amount, display: (platform ? `${platform} ${handle}` : handle) + (s?.amount ? ` · $${s.amount}` : '') }
    })
    .filter(Boolean)
}

export default function Recoupments() {
  // Live expense categories. Bound to the same name the module-level
  // import used, so every CATEGORIES reference in this component now
  // reads the vocabulary from context (which falls back to that same
  // constant if the fetch fails). Categories are user-created on the
  // Statements and Reports pages — a hardcoded list here would leave
  // this dropdown unable to render its own rows' values.
  const CATEGORIES = useCategories()
  // URL-driven artist focus. The index view (/recoupments) lists artists as
  // navigable cards; an artist subpage (/recoupments/:artistName) renders
  // just that artist's songs/labels/items. Same component handles both so
  // the editing handlers, modals, and bulk actions live in one place.
  const { artistName: rawArtistParam } = useParams()
  // The profile this artist page belongs to, for the breadcrumb. Null while
  // resolving or off-roster; the name then renders as text.
  const artistLink = useArtistLink(rawArtistParam ? decodeURIComponent(rawArtistParam) : '')
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const routeArtist = rawArtistParam ? decodeURIComponent(rawArtistParam) : ''
  const isDetail = !!routeArtist
  // Song campaigns marketing has confirmed done: the READY queue (2026-09-21).
  // Every item pre-selected; Upload all is the same ufr-bulk write the rows
  // use, and the campaign moves to Uploaded on the next list read.
  const [readyCampaigns, setReadyCampaigns] = useState([])
  const loadReady = () => api.get('/campaigns', { params: { status: 'ready' } }).then((r) => setReadyCampaigns(r.data?.data || [])).catch(() => setReadyCampaigns([]))
  useEffect(() => { if (!isDetail) loadReady() }, [isDetail]) // eslint-disable-line react-hooks/exhaustive-deps
  // Detail-view "statement" tab. 'pending' means items not yet uploaded for
  // recoupment; otherwise a YYYY-MM string identifies the calendar month in
  // which the row was UFR-stamped (ufr_marked_at). Lives in the URL so each
  // statement is bookmarkable / shareable.
  const statement = searchParams.get('statement') || 'pending'
  const setStatement = (s) => setSearchParams(prev => {
    const next = new URLSearchParams(prev)
    if (!s || s === 'pending') next.delete('statement'); else next.set('statement', s)
    return next
  }, { replace: true })
  const { rates: fxRates, fetchedAt: fxFetchedAt } = useFxRates()
  const toast = useToast()

  const [entries, setEntries] = useState([])
  // Bank-born costs that NAME AN ARTIST and have never been answered. They are
  // kept off this page because `recoupable` is DEFAULT TRUE and nothing set it —
  // 1,972 rows, $3,101,837, claiming to be recoupable against nobody. A default
  // is not a decision, so this is where the decision gets made. 53 qualify.
  // The recoupment audit's own figures, for the pointer under the header. This
  // page shows none of the audit's rows: /recoupments/audit owns those five
  // checks, and the bank-review queue moved there wholesale when it stopped
  // requiring an artist — it went from 53 rows to 1,919, which is a worklist and
  // not a band on somebody else's page.
  const [audit, setAudit] = useState(null)
  const [loading, setLoading] = useState(true)
  const [filterArtist, setFilterArtist] = useState('')
  const [filterUfr, setFilterUfr] = useState('')
  // Uploaded for recoupment, with nothing on a bank statement behind it.
  //
  // Marking a row UFR claims to a partner that Market Street spent this money on their
  // artist. When no bank line matches, the claim has no evidence under it — and
  // until now the page said nothing. 43 live rows / $134,931 across ~9 artists.
  //
  // The ufr clause is what makes this usable rather than wallpaper: the bank
  // half alone is true of 281 of the 1,460 rows on this page. bankUnverified()
  // is the same predicate the dot uses on Ledger, Payments and Vendors, so a row
  // cannot read verified on one screen and unverified on another.
  const isUfrUnverified = (e) => e?.ufr === 'Yes' && bankUnverified(e)
  const [filterLabel, setFilterLabel] = useState('')
  // Index card ordering — 'total' (default, biggest recoupable total) or
  // 'pending' (most items still waiting to be uploaded for recoupment).
  // Priority-banded artists stay pinned to the top in both modes.
  // Defaults to the problem, not the backlog: unverified spend is a claim the
  // bank does not support, and it is concentrated enough that ordering by it puts
  // the whole of it on the first screen. Falls back to 'pending' when nothing is
  // unverified, which is the old behaviour.
  const [indexSort, setIndexSort] = useState('provable')
  // Priority subtabs — the H/M/L bands get their own tabs instead of
  // being stacked in one long list. 'all' keeps the banded view.
  const [priorityTab, setPriorityTab] = useState('all')
  // "Ready for planning" filter — '' all, 'yes' only ready, 'no' hide ready.
  const [filterReady, setFilterReady] = useState('')
  // Page-level notes (index view) — shared scratchpad rendered between the
  // stats and the filters. Persisted in recoupment_notes under a sentinel
  // artist key so it rides the existing notes endpoints.
  const [indexNote, setIndexNote] = useState('')
  const [indexNoteLoaded, setIndexNoteLoaded] = useState(false)
  const [indexNoteSaving, setIndexNoteSaving] = useState(false)
  const INDEX_NOTE_KEY = '__recoupments_index__'
  useEffect(() => {
    api.get('/bk/recoupments/notes', { params: { artist: INDEX_NOTE_KEY } })
      .then(r => { setIndexNote(r.data?.data?.artistNote || ''); setIndexNoteLoaded(true) })
      .catch(() => setIndexNoteLoaded(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const lastSavedIndexNote = useRef('')
  useEffect(() => { if (indexNoteLoaded) lastSavedIndexNote.current = indexNote }, [indexNoteLoaded]) // eslint-disable-line react-hooks/exhaustive-deps
  const saveIndexNote = async () => {
    if (indexNote === lastSavedIndexNote.current) return
    setIndexNoteSaving(true)
    try {
      await api.put('/bk/recoupments/notes', { artist: INDEX_NOTE_KEY, note: indexNote })
      lastSavedIndexNote.current = indexNote
    } catch (err) {
      console.error('Failed to save recoupments notes:', err)
    } finally { setIndexNoteSaving(false) }
  }
  const [filterPayment, setFilterPayment] = useState('')
  const [search, setSearch] = useState('')
  const [savingId, setSavingId] = useState(null)

  // Bottom "Non-recoupable expenses" panel — collapsed by default per
  // artist, with the expanded state persisted in localStorage so a user
  // who opened it once stays opened on return visits to that artist.
  const NON_RECOUP_KEY = (a) => `recoup_show_nonrecoup_${(a || '').toLowerCase()}`
  const [showNonRecoup, setShowNonRecoup] = useState(false)

  // Collapsed-section memory. Keys we use throughout the page:
  //   'stats'             — top stat cards
  //   'deal'              — deal summary card
  //   'filters'           — filter bar
  //   `g:${aKey}:${gKey}`           — primary group (song / category)
  //   `s:${aKey}:${gKey}:${sKey}`   — secondary bucket
  //   `l:${aKey}:${gKey}:${sKey}:${lKey}` — label sub-bucket
  // Persisted to localStorage so the user's choices survive reloads. A
  // single Set of strings keeps the API simple (`has()` / `add()` /
  // `delete()`) and the serialized form trivial to inspect.
  const COLLAPSED_KEY = 'recoup_collapsed_v1'
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const arr = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')
      return new Set(Array.isArray(arr) ? arr : [])
    } catch { return new Set() }
  })
  const isCollapsed = (key) => collapsed.has(key)
  const toggleCollapsed = (key) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])) } catch {}
      return next
    })
  }
  const setAllCollapsed = (keys, collapse) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (collapse) keys.forEach(k => next.add(k))
      else keys.forEach(k => next.delete(k))
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])) } catch {}
      return next
    })
  }

  // Default view: only currently-recoupable items. The new 'Recoupable'
  // filter lets the user show non-recoupable items too so they can promote
  // them onto the page without leaving for the Ledger.
  const [filterRecoupable, setFilterRecoupable] = useState('Yes')

  // What the secondary grouping uses (the level under artist). 'song' is
  // the default — most users think about recoupments in song terms. Switch
  // to 'category' to group by spend category instead (Marketing, Advance, etc.).
  // Items missing the field for the active grouping go into an 'N/A' bucket.
  const [groupBy, setGroupBy] = useState('song')

  // Multi-select + bulk-label workflow. Users group payments together when
  // uploading for recoupment (e.g. "Digital Marketing — Song X") so they can
  // see, later, which items they batched. `selectedIds` is the current
  // selection; `labelModal` opens the editor with an optional "also mark UFR"
  // flag for the combined Set-Label-and-Upload action.
  const [selectedIds, setSelectedIds] = useState(new Set())
  // localStorage-backed plan of items staged for the next Tone
  // upload. Mirror in React state so the "In plan" chip on each row
  // and the header "N in plan" pill update without a page refresh.
  const [plan, setPlan] = useState(() => loadPlan())
  // Refresh from storage on window focus so a plan modified in
  // another tab (or wiped after Done on the Planning page) shows up
  // here on tab switch.
  useEffect(() => {
    const rehydrate = () => setPlan(loadPlan())
    window.addEventListener('focus', rehydrate)
    return () => window.removeEventListener('focus', rehydrate)
  }, [])
  const [labelModal, setLabelModal] = useState(null) // { mode: 'bulk' | 'single', ids: number[], initial: string, alsoUfr: boolean }
  const [savingLabel, setSavingLabel] = useState(false)

  // Notes editor — per-row free-form notes (existing `notes` column on
  // expenses). Modal opens via the sticky-note icon on each row; saving
  // PUTs the new notes value with a 10s undo toast like every other edit
  // on the page.
  const [notesModal, setNotesModal] = useState(null) // { id, initial: string }
  const [savingNotes, setSavingNotes] = useState(false)

  // Song editor — opens for a single row (chip click) or for an entire
  // group (pencil button on the group header). For a group rename, every
  // item in the group gets a `song` PUT, cleaning up case-variant duplicates
  // ("Face it all" → "Face It All") in the underlying data, not just display.
  const [songModal, setSongModal] = useState(null) // { mode: 'single' | 'group', ids: number[], initial: string }
  const [savingSong, setSavingSong] = useState(false)

  // Category editor — same shape as the song editor, different field on
  // the PUT body. Powers the per-row category chip + the group-header
  // rename pencil when grouping by category.
  const [categoryModal, setCategoryModal] = useState(null) // { mode, ids, initial }
  const [savingCategory, setSavingCategory] = useState(false)

  // Payee (vendor name) editor — rename the bold name at the top of each
  // row. PUT /bk/entries/:id { payee } updates this one entry; bulk-rename
  // across every expense for a vendor still lives on /bk/vendors.
  const [payeeModal, setPayeeModal] = useState(null) // { id, initial }
  const [savingPayee, setSavingPayee] = useState(false)

  // Socials editor — mirrors the Ledger's Socials column. social_handles
  // is JSONB on expenses; rows are [{ platform, handle }] and only rows
  // with a handle survive the save. Editing always targets the row's own
  // social_handles — never a split child's parent — so the placeholder is
  // hidden on child rows (their socials are inherited).
  const [socialsModal, setSocialsModal] = useState(null) // { id }
  const [socialsRows, setSocialsRows] = useState([])
  const [savingSocials, setSavingSocials] = useState(false)

  // ── Undo toast ──────────────────────────────────────────────────────────
  // Every mutation on this page funnels through showUndo() so the user has
  // 10s to revert. State holds the latest single undo only — a new
  // mutation replaces the prior pending undo (the prior change is
  // committed for good). Matches the BkPayments undo pattern; window is
  // 10s here per user request vs 6s there.
  const [undoAction, setUndoAction] = useState(null) // { message, undo: async fn }
  const undoTimerRef = useRef(null)
  const showUndo = (message, undoFn) => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    setUndoAction({ message, undo: undoFn })
    undoTimerRef.current = setTimeout(() => setUndoAction(null), 10000)
  }
  const executeUndo = async () => {
    if (!undoAction) return
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    const fn = undoAction.undo
    setUndoAction(null)
    try { await fn() } catch (e) { console.error('Undo failed:', e) }
  }

  // Invoice preview — opens FilePreview with the GET /entries/:id/file/invoice
  // endpoint. For split-family children the invoice file lives on the parent,
  // so we fall through to parent_id when the child has no own file (see
  // hasInvoiceFile / invoiceUrl below).
  const [previewFile, setPreviewFile] = useState(null) // { url, filename } | null

  // Add-Expense flow (lifted from the Artist Budget page so this page can
  // eventually replace it). The detail subpage shows an 'Add Expense' button
  // that posts to /api/artists/:id/budget/expenses — the same endpoint the
  // Budget page uses. Needs the artist's DB id + releases list; both fetched
  // lazily when the modal opens.
  const [artistInfo, setArtistInfo] = useState(null) // { id, releases }
  const [addModalOpen, setAddModalOpen] = useState(false)
  const ADD_FORM_DEFAULTS = {
    release_id: '', payee: '', description: '', category: '',
    amount: '', currency: 'USD', date: '', song: '',
    notes: '', ufr: false, paid: true,
    // Only used on the INDEX view (no route artist) where the user has
    // to type which artist the new expense belongs to. Ignored on the
    // detail view since artistInfo.id pins it.
    artist: '',
    // Optional socials list — [{platform, handle}, ...]. Empty rows are
    // dropped on submit so we don't stamp `[]` onto the expense.
    socials: [{ platform: 'Instagram', handle: '' }],
  }
  const [addForm, setAddForm] = useState(ADD_FORM_DEFAULTS)
  const [addReceipt, setAddReceipt] = useState(null)
  const [addSaving, setAddSaving] = useState(false)
  const [addError, setAddError] = useState('')

  // Resolve the artist row (id + releases) for the route artist. Skips on
  // the index page and on the synthetic 'Unassigned' subpage (no artist row
  // exists for unassigned items).
  useEffect(() => {
    if (!isDetail || !routeArtist) { setArtistInfo(null); return }
    if (routeArtist.toLowerCase() === 'unassigned') { setArtistInfo(null); return }
    let cancelled = false
    api.get('/artists?limit=10000')
      .then(async r => {
        if (cancelled) return
        const all = r.data?.data || []
        const match = all.find(a => (a.name || '').toLowerCase() === routeArtist.toLowerCase())
        if (!match) { setArtistInfo(null); return }
        // Pull releases (for the Add-Expense release dropdown) AND the
        // budget endpoint (for dealSummary). Parallel so the page renders
        // as soon as both resolve.
        const [artistRes, budgetRes] = await Promise.all([
          api.get(`/artists/${match.id}`).catch(() => null),
          api.get(`/artists/${match.id}/budget`).catch(() => null),
        ])
        if (cancelled) return
        setArtistInfo({
          id: match.id,
          releases: artistRes?.data?.data?.releases || [],
          dealSummary: budgetRes?.data?.data?.dealSummary || null,
        })
      })
      .catch(() => { if (!cancelled) setArtistInfo(null) })
    return () => { cancelled = true }
  }, [isDetail, routeArtist])

  // Recoupment notes for the artist currently being viewed in detail mode.
  // Lives in a separate table on the server (see /bk/recoupments/notes) —
  // unrelated to per-expense notes. Two layers:
  //   • artistNote — single string shown above the groups
  //   • songNotes  — { songKeyLC: 'note text' } shown under each song-group
  //                   header. Keys are lowercased trimmed song names.
  const [artistNote, setArtistNote] = useState('')
  const [songNotes, setSongNotes] = useState({})
  const [editingArtistNote, setEditingArtistNote] = useState(false)
  const [editingSongNoteKey, setEditingSongNoteKey] = useState(null) // lc songKey or null
  useEffect(() => {
    if (!isDetail || !routeArtist) { setArtistNote(''); setSongNotes({}); return }
    let cancelled = false
    api.get('/bk/recoupments/notes', { params: { artist: routeArtist } })
      .then(r => {
        if (cancelled) return
        const d = r.data?.data || {}
        setArtistNote(d.artistNote || '')
        setSongNotes(d.songNotes || {})
      })
      .catch(() => { /* best-effort — empty state is the safe default */ })
    return () => { cancelled = true }
  }, [isDetail, routeArtist])

  // Single upsert call for both artist-level and per-song notes. Empty note
  // clears the row server-side; we mirror that in local state so the UI
  // refreshes without a round-trip refetch.
  const saveRecoupmentNote = async ({ song, note }) => {
    if (!routeArtist) return
    try {
      await api.put('/bk/recoupments/notes', { artist: routeArtist, song: song || null, note })
      if (song == null) {
        setArtistNote(note.trim() ? note : '')
      } else {
        const key = song.trim().toLowerCase()
        setSongNotes(prev => {
          const next = { ...prev }
          if (note.trim()) next[key] = note
          else delete next[key]
          return next
        })
      }
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert('Failed to save note: ' + (err.response?.data?.error || err.message))
    }
  }

  // Split modal — divides one expense into N artist-specific child rows
  // via POST /bk/entries/:id/split. Same shape the Flags page uses; pre-
  // fills with the current artist + one blank row, amount distributed
  // equally with leftover cents pinned to the first row.
  const [splitModal, setSplitModal] = useState(null) // { row, rows: [{artist, song, amount}] }
  const [splitSaving, setSplitSaving] = useState(false)
  const openSplitModal = (row) => {
    if (row.parent_id) {
      alert('This row is already a split child. Open the parent on the Ledger to re-split.')
      return
    }
    const total = Number(row.amount) || 0
    const seedNames = [row.artist || '', '']
    const per = total ? Math.floor((total / seedNames.length) * 100) / 100 : 0
    const leftover = total ? Math.round((total - per * seedNames.length) * 100) / 100 : 0
    setSplitModal({
      row,
      rows: seedNames.map((name, i) => ({
        artist: name,
        song: row.song || '',
        amount: total ? String((i === 0 ? per + leftover : per).toFixed(2)) : '',
      })),
    })
  }
  const updateSplitRow = (idx, field, value) =>
    setSplitModal(prev => prev && {
      ...prev,
      rows: prev.rows.map((r, i) => i === idx ? { ...r, [field]: value } : r),
    })
  const addSplitRow = () =>
    setSplitModal(prev => prev && {
      ...prev,
      rows: [...prev.rows, { artist: '', song: prev.row.song || '', amount: '' }],
    })
  const removeSplitRow = (idx) =>
    setSplitModal(prev => prev && {
      ...prev,
      rows: prev.rows.length > 2 ? prev.rows.filter((_, i) => i !== idx) : prev.rows,
    })
  const submitSplit = async () => {
    if (!splitModal) return
    const valid = splitModal.rows.filter(r => r.artist && r.artist.trim() && r.amount !== '' && !isNaN(Number(r.amount)))
    if (valid.length < 2) {
      alert('Need at least 2 rows with an artist name and amount.')
      return
    }
    setSplitSaving(true)
    try {
      await api.post(`/bk/entries/${splitModal.row.id}/split`, {
        artist_breakdown: valid.map(r => ({
          artist: r.artist.trim(),
          song: (r.song || '').trim() || null,
          amount: Number(r.amount),
        })),
      })
      // Re-fetch — the split server-side reshapes the family (parent stays
      // as the first split, children added). Easier to refetch than to
      // reconstruct the family in local state.
      setSplitModal(null)
      await fetchEntries()
    } catch (err) {
      alert('Split failed: ' + (err.response?.data?.error || err.message))
    } finally {
      setSplitSaving(false)
    }
  }

  // Soft-delete an expense (server cascades to split-family children;
  // restore is still available from the Ledger). Optimistic — yanks the
  // row from local state, rolls back if the API rejects.
  const [deletingId, setDeletingId] = useState(null)
  const handleDeleteEntry = async (entry) => {
    if (!window.confirm(`Delete ${entry.payee || 'this entry'}? It will be soft-deleted — you can undo for 10s, or restore later from the Ledger.`)) return
    setDeletingId(entry.id)
    const snapshot = entries
    setEntries(snapshot.filter(e => e.id !== entry.id))
    try {
      await api.delete(`/bk/entries/${entry.id}`)
      showUndo(`Deleted "${entry.payee || 'entry'}"`, async () => {
        await api.post(`/bk/entries/${entry.id}/restore`)
        setEntries(snapshot)
      })
    } catch (err) {
      setEntries(snapshot)
      alert('Failed to delete: ' + (err.response?.data?.error || err.message))
    } finally {
      setDeletingId(null)
    }
  }

  const openAddModal = () => {
    setAddForm({ ...ADD_FORM_DEFAULTS, currency: 'USD' })
    setAddReceipt(null)
    setAddError('')
    setAddModalOpen(true)
  }
  const closeAddModal = () => {
    if (addSaving) return
    setAddModalOpen(false)
  }
  const saveNewExpense = async () => {
    setAddError('')
    // Two paths: artist is pinned via the route (detail view) -> use the
    // artists/:id/budget/expenses endpoint which auto-derives song from
    // release_id and stamps the artist name from the DB row. On the index
    // view there's no route artist; the user types the name into a free
    // input and we POST straight to /bk/entries (no artist row required).
    const useIndexPath = !artistInfo?.id
    if (useIndexPath && !(addForm.artist || '').trim()) {
      setAddError('Artist is required.'); return
    }
    if (!addForm.payee.trim())       { setAddError('Payee is required.'); return }
    // description is optional — payee + amount + artist/song context is
    // enough to identify the row.
    if (addForm.amount === '' || isNaN(Number(addForm.amount))) { setAddError('Amount is required and must be a number.'); return }
    setAddSaving(true)
    // Optional socials — dropped when the user hasn't typed a handle.
    const cleanedSocials = (addForm.socials || [])
      .map(s => ({ platform: (s.platform || '').trim(), handle: (s.handle || '').trim() }))
      .filter(s => s.handle)
    try {
      let res
      if (useIndexPath) {
        // POST /bk/entries — recoupable=true so it lands on this page.
        const payload = {
          payee: addForm.payee.trim(),
          description: addForm.description.trim(),
          amount: Number(addForm.amount),
          currency: (addForm.currency || 'USD').toUpperCase(),
          invoice_date: addForm.date || null,
          category: addForm.category || null,
          song: (addForm.song || '').trim() || null,
          notes: addForm.notes || null,
          artist: addForm.artist.trim(),
          recoupable: true,
          ufr: addForm.ufr ? 'Yes' : 'No',
          payment_status: addForm.paid ? 'Paid' : 'Unpaid',
          payment_date: addForm.paid ? (addForm.date || new Date().toISOString().slice(0, 10)) : null,
          // Tags this row as "born on the Recoupments page" so the ledger
          // shows a distinct badge + left-border accent, regardless of the
          // recoupable flag (which can be toggled elsewhere).
          entry_source: 'recoupments',
        }
        if (cleanedSocials.length) payload.social_handles = cleanedSocials
        res = await api.post('/bk/entries', payload)
      } else {
        const fd = new FormData()
        fd.append('payee', addForm.payee.trim())
        fd.append('description', addForm.description.trim())
        fd.append('amount', String(Number(addForm.amount)))
        fd.append('currency', (addForm.currency || 'USD').toUpperCase())
        if (addForm.date)       fd.append('date', addForm.date)
        if (addForm.category)   fd.append('category', addForm.category)
        if (addForm.release_id) fd.append('release_id', String(addForm.release_id))
        if (addForm.song)       fd.append('song', addForm.song.trim())
        if (addForm.notes)      fd.append('notes', addForm.notes)
        fd.append('ufr',  addForm.ufr ? 'true' : 'false')
        fd.append('paid', addForm.paid ? 'true' : 'false')
        if (cleanedSocials.length) fd.append('social_handles', JSON.stringify(cleanedSocials))
        if (addReceipt) fd.append('receipt', addReceipt)
        res = await api.post(`/artists/${artistInfo.id}/budget/expenses`, fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
      }
      // The endpoint returns the new entry's id on the data envelope — use
      // it as the undo handle (soft-delete the freshly-created expense if
      // the user changes their mind).
      const newId = res.data?.data?.id ?? res.data?.id
      const payee = addForm.payee.trim()
      setAddModalOpen(false)
      setAddForm(ADD_FORM_DEFAULTS)
      setAddReceipt(null)
      await fetchEntries()
      if (newId) {
        showUndo(`Added "${payee}"`, async () => {
          await api.delete(`/bk/entries/${newId}`)
          setEntries(p => p.filter(e => e.id !== newId))
        })
      }
    } catch (err) {
      setAddError(err.response?.data?.error || err.message || 'Failed to save')
    } finally {
      setAddSaving(false)
    }
  }

  // `silent` keeps the existing data on screen instead of flashing the
  // skeleton. Used for the focus / visibility refetch so a quick window
  // refocus doesn't yank the user back to a loading state and feel like
  // a reload. The initial mount fetch leaves it false on purpose so the
  // first render shows the skeleton.
  const lastFetchRef = useRef(0)
  const fetchEntries = async (opts = {}) => {
    const { silent = false } = opts
    try {
      if (!silent) setLoading(true)
      const res = await api.get('/bk/entries', { params: { status: 'approved', deleted: 'false' } })
      // Statement-born rows reach this page ONLY ONCE REVIEWED — that is the
      // flag this comment used to say should be removed "once ledger matching is
      // trustworthy", and reviewing is what trustworthy means here.
      //
      // `recoupable` defaults TRUE and the statement booker never sets it, so
      // 1,972 rows ($3,101,837) claim to be recoupable against nobody. A default
      // is not a decision. `recoup_reviewed` is the decision, and the queue below
      // is where it gets made. Filtered at the boundary so the stat tiles, the
      // grouping memo, the 'Non-recoupable' panel and the label list all inherit
      // it. See withoutUnreviewedBankRows in utils.js.
      setEntries(withoutUnreviewedBankRows(res.data.data))
      // Alongside, and deliberately NOT awaited: the audit answers questions about
      // rows this page does not show, so it cannot come out of the filtered list
      // above — and the page must render its own money without waiting on it.
      api.get('/bk/recoupment-audit')
        .then(r => setAudit(r.data?.data?.totals || null))
        .catch(() => setAudit(null))
      lastFetchRef.current = Date.now()
    } catch (err) {
      console.error('Failed to load recoupments:', err)
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => { fetchEntries() }, [])

  // ── Per-artist meta (dismissal + priority) ───────────────────────────────
  // Map keyed by lowercased artist name. Refetched on focus alongside the
  // entries list so multi-admin edits propagate. Failures are silent so a
  // backend hiccup doesn't break the rest of the page — meta defaults to
  // empty, all artists render as Active with no priority.
  const [artistMeta, setArtistMeta] = useState({}) // { lower(name): { dismissed, priority, ... } }
  const fetchArtistMeta = async () => {
    try {
      const res = await api.get('/bk/artist-meta')
      setArtistMeta(res.data?.data || {})
    } catch (err) {
      console.warn('Failed to fetch artist meta:', err?.response?.data?.error || err.message)
    }
  }
  useEffect(() => { fetchArtistMeta() }, [])

  // Song-campaign finished flags — same map the Artist Campaigns page
  // reads from /bk/song-status. Surfaces a Finished badge on song-bucket
  // headers in the detail view's grouped output. Toggling here writes
  // the same row Artist Campaigns shows.
  const [songStatus, setSongStatus] = useState({})
  const songFinishedKey = (artistName, songName) =>
    `${normalizeArtistKey(artistName)}|${String(songName || '').toLowerCase().trim()}`
  const isSongFinished = (artistName, songName) =>
    !!songStatus[songFinishedKey(artistName, songName)]?.finished
  const fetchSongStatus = async () => {
    try {
      const res = await api.get('/bk/song-status')
      setSongStatus(res.data?.data || {})
    } catch (err) {
      console.warn('Failed to fetch song status:', err?.response?.data?.error || err.message)
    }
  }
  useEffect(() => { fetchSongStatus() }, [])
  // Song-level "ready for planning" — release-scoped marker on the same
  // song_campaign_status row; toggleable here and on the Campaigns song
  // subpage header.
  const isSongReady = (artistName, songName) =>
    !!songStatus[songFinishedKey(artistName, songName)]?.ready_for_planning
  const toggleSongReady = async (artistName, songName, value) => {
    const key = songFinishedKey(artistName, songName)
    const prev = songStatus[key] || null
    setSongStatus(s => ({ ...s, [key]: { ...(s[key] || {}), ready_for_planning: value } }))
    try {
      const { data } = await api.put('/bk/song-status', { artist: artistName, song: songName, ready_for_planning: value })
      if (data?.data?.artist_key && data?.data?.song_key) {
        setSongStatus(s => ({ ...s, [`${data.data.artist_key}|${data.data.song_key}`]: data.data }))
      }
      toast(value ? `"${songName}" marked ready for planning` : `"${songName}" no longer marked ready`)
    } catch (err) {
      toast.error(`Couldn't save: ${err?.response?.data?.error || err.message}`)
      setSongStatus(s => {
        const out = { ...s }
        if (prev) out[key] = prev
        else delete out[key]
        return out
      })
    }
  }

  const toggleSongFinished = async (artistName, songName, currentFinished) => {
    const next = !currentFinished
    const key = songFinishedKey(artistName, songName)
    const prev = songStatus[key] || null
    setSongStatus(s => ({
      ...s,
      [key]: { ...(s[key] || {}), artist_key: normalizeArtistKey(artistName),
               song_key: String(songName || '').toLowerCase().trim(),
               finished: next, finished_at: next ? new Date().toISOString() : null },
    }))
    try {
      const { data } = await api.put('/bk/song-status', {
        artist: artistName, song: songName, finished: next,
      })
      if (data?.data?.artist_key && data?.data?.song_key) {
        const echoKey = `${data.data.artist_key}|${data.data.song_key}`
        setSongStatus(s => ({ ...s, [echoKey]: data.data }))
      }
      toast(next ? `Marked "${songName}" finished` : `Reopened "${songName}"`)
    } catch (err) {
      const msg = err?.response?.data?.error || err.message
      toast.error(`Couldn't save: ${msg}`)
      setSongStatus(s => {
        const out = { ...s }
        if (prev) out[key] = prev
        else delete out[key]
        return out
      })
    }
  }

  // Set or clear an artist's priority. `value` ∈ 'high' | 'medium' | 'low' |
  // null. Optimistic local update first; on success ALSO REFETCH so the
  // local state mirrors the server (defensive against optimistic-state
  // drift); on failure roll back via refetch AND surface the failure as
  // a toast so the user can act on it instead of staring at a button
  // that silently bounced back.
  const setArtistPriority = async (artistName, value) => {
    const key = (artistName || '').toLowerCase().trim()
    setArtistMeta(prev => ({ ...prev, [key]: { ...(prev[key] || {}), artist_key: key, priority: value } }))
    try {
      const { data } = await api.put('/bk/artist-meta', { artist: artistName, priority: value })
      // Use the server-echoed row as the source of truth — guards against
      // any local-vs-server drift if the server normalized differently.
      if (data?.data?.artist_key) {
        setArtistMeta(prev => ({ ...prev, [data.data.artist_key]: data.data }))
      }
    } catch (err) {
      const msg = err?.response?.data?.error || err.message
      console.error('Failed to save priority:', msg)
      toast.error(`Couldn't save priority: ${msg}`)
      fetchArtistMeta()
    }
  }
  // ── "2025 Expenses" bucket ─────────────────────────────────────────────
  // Prior-year spend gets tagged out of the live recoupment flow and
  // collected on /recoupments/2025 (artist cards → songs → items).
  const toggle2025 = async (entry) => {
    const next = !entry.is_2025_expense
    setEntries(prev => prev.map(e => e.id === entry.id ? { ...e, is_2025_expense: next } : e))
    try {
      await api.put(`/bk/entries/${entry.id}`, { is_2025_expense: next })
      toast(next ? 'Moved to 2025 Expenses' : 'Removed from 2025 Expenses')
    } catch (err) {
      setEntries(prev => prev.map(e => e.id === entry.id ? { ...e, is_2025_expense: !next } : e))
      toast.error(`Couldn't save: ${err?.response?.data?.error || err.message}`)
    }
  }
  // Release-level: tag/untag every item in a song bucket at once.
  const toggleGroup2025 = async (items, value) => {
    const ids = items.map(i => i.id)
    setEntries(prev => prev.map(e => ids.includes(e.id) ? { ...e, is_2025_expense: value } : e))
    let fail = 0
    for (const id of ids) {
      try { await api.put(`/bk/entries/${id}`, { is_2025_expense: value }) } catch { fail++ }
    }
    if (fail) { toast.error(`${fail} of ${ids.length} failed — refetching`); fetchEntries({ silent: true }) }
    else toast(value ? `${ids.length} item${ids.length === 1 ? '' : 's'} moved to 2025 Expenses` : `${ids.length} item${ids.length === 1 ? '' : 's'} removed from 2025 Expenses`)
  }
  const count2025 = useMemo(() => entries.filter(e => e.is_2025_expense).length, [entries])
  // Controls that cost space at REST are gated on somebody actually using the
  // feature. Measured on production 2026-09-14: `is_2025_expense` is set on 0
  // of 1,414 recoupable rows, and `ready_for_planning` on 0 of 146 artists —
  // yet the 2025 tag rendered a grey button on every one of 1,209 detail rows
  // and the planning filter held a slot in the index filter bar.
  //
  // Nothing is deleted and no hover-reveal affordance is gated: those cost
  // nothing at rest and are the only way to create the first one, so the UI
  // comes back on its own the moment a row or an artist is marked. Gating the
  // way IN as well would make the feature unreachable forever.
  const anyReadyForPlanning = useMemo(
    () => Object.values(artistMeta || {}).some(m => m?.ready_for_planning), [artistMeta])

  // Mark / unmark an artist as "ready for planning" — the reviewed-and-
  // stageable workflow state. Same optimistic + server-echo pattern as
  // setArtistPriority; stored on the shared artist_meta row.
  const setArtistReady = async (artistName, value) => {
    const key = (artistName || '').toLowerCase().trim()
    setArtistMeta(prev => ({ ...prev, [key]: { ...(prev[key] || {}), artist_key: key, ready_for_planning: value } }))
    try {
      const { data } = await api.put('/bk/artist-meta', { artist: artistName, ready_for_planning: value })
      if (data?.data?.artist_key) {
        setArtistMeta(prev => ({ ...prev, [data.data.artist_key]: data.data }))
      }
      toast(value ? `${artistName} marked ready for planning` : `${artistName} no longer marked ready`)
    } catch (err) {
      const msg = err?.response?.data?.error || err.message
      toast.error(`Couldn't save: ${msg}`)
      fetchArtistMeta()
    }
  }

  // Move an artist to / from the Dismissed section. Same optimistic +
  // server-echo pattern as setArtistPriority.
  const toggleArtistDismissed = async (artistName, dismissed) => {
    const key = (artistName || '').toLowerCase().trim()
    setArtistMeta(prev => ({ ...prev, [key]: { ...(prev[key] || {}), artist_key: key, dismissed } }))
    try {
      const { data } = await api.put('/bk/artist-meta', { artist: artistName, dismissed })
      if (data?.data?.artist_key) {
        setArtistMeta(prev => ({ ...prev, [data.data.artist_key]: data.data }))
      }
    } catch (err) {
      const msg = err?.response?.data?.error || err.message
      console.error('Failed to save dismissed state:', msg)
      toast.error(`Couldn't ${dismissed ? 'dismiss' : 'restore'} artist: ${msg}`)
      fetchArtistMeta()
    }
  }

  // Refetch when the tab/window regains focus so edits made on the Ledger
  // (or elsewhere) propagate back without needing a hard refresh.
  // Throttled to one fetch per 10s and runs silently (no skeleton flash)
  // so clicking anywhere on the page — which briefly fires `focus` on
  // some browsers — doesn't read as a reload.
  useEffect(() => {
    const maybeRefetch = () => {
      if (Date.now() - lastFetchRef.current < 10_000) return
      fetchEntries({ silent: true })
      // Meta gets refetched on focus too — admin sets a priority on one
      // tab, the other tab picks it up next time the user focuses it.
      // Negligible payload, no spinner, runs in parallel.
      fetchArtistMeta()
    }
    const onVis = () => { if (document.visibilityState === 'visible') maybeRefetch() }
    const onFocus = () => maybeRefetch()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const toggleUfr = async (id, currentUfr) => {
    const newVal = currentUfr === 'Yes' ? 'No' : 'Yes'
    setSavingId(id)
    try {
      await api.put(`/bk/entries/${id}`, { ufr: newVal })
      setEntries(prev => prev.map(e => e.id === id ? { ...e, ufr: newVal } : e))
      showUndo(newVal === 'Yes' ? 'Marked as Uploaded' : 'Unmarked Uploaded', async () => {
        await api.put(`/bk/entries/${id}`, { ufr: currentUfr || 'No' })
        setEntries(prev => prev.map(e => e.id === id ? { ...e, ufr: currentUfr || 'No' } : e))
      })
    } catch {} finally { setSavingId(null) }
  }

  // Paid/Unpaid toggle — offered only on added expenses (entry_source rows
  // born on this page or Artist Campaigns). The server stamps payment_date /
  // paid_by / paid_marked_at on the flip to Paid and clears them flipping
  // back, so the local mirror only tracks status + date for display.
  const togglePaid = async (entry) => {
    const wasPaid = entry.payment_status === 'Paid'
    const next = wasPaid ? 'Unpaid' : 'Paid'
    const prevDate = entry.payment_date
    const localDate = next === 'Paid' ? (prevDate || new Date().toISOString().slice(0, 10)) : null
    setSavingId(entry.id)
    try {
      await api.put(`/bk/entries/${entry.id}`, { payment_status: next })
      setEntries(prev => prev.map(e => e.id === entry.id ? { ...e, payment_status: next, payment_date: localDate } : e))
      showUndo(next === 'Paid' ? 'Marked as Paid' : 'Marked as Unpaid', async () => {
        await api.put(`/bk/entries/${entry.id}`, { payment_status: wasPaid ? 'Paid' : 'Unpaid', payment_date: prevDate })
        setEntries(prev => prev.map(e => e.id === entry.id ? { ...e, payment_status: wasPaid ? 'Paid' : 'Unpaid', payment_date: prevDate } : e))
      })
    } catch {} finally { setSavingId(null) }
  }

  // Move a UFR'd item to a different monthly statement. Statement bucket
  // is derived from ufr_marked_at via the 20th-cutoff rule, so we simply
  // override that timestamp. Picking the 1st of the chosen month puts the
  // row safely inside that statement's window (Mar 16–Apr 15 for the
  // April statement, etc.) — Day 1 of April is day < 16 -> April bucket.
  // `ym` arrives as 'YYYY-MM' from a <input type="month"> picker.
  const [editingUfrFor, setEditingUfrFor] = useState(null)
  const moveUfrToStatement = async (id, ym) => {
    if (!ym || !/^\d{4}-\d{2}$/.test(ym)) { setEditingUfrFor(null); return }
    const entry = entries.find(e => e.id === id)
    const prevTs = entry?.ufr_marked_at || null
    // Noon UTC on the 1st — any sub-day timezone shift still lands the
    // date safely on day 1 of the target month.
    const newTs = `${ym}-01T12:00:00.000Z`
    if (statementMonthFor(prevTs) === ym) { setEditingUfrFor(null); return }
    setEntries(prev => prev.map(e => e.id === id ? { ...e, ufr_marked_at: newTs } : e))
    setEditingUfrFor(null)
    try {
      await api.put(`/bk/entries/${id}`, { ufr_marked_at: newTs })
      const targetLabel = statementLabel(ym)
      showUndo(`Moved to ${targetLabel} statement`, async () => {
        const rollbackTs = prevTs || null
        await api.put(`/bk/entries/${id}`, { ufr_marked_at: rollbackTs })
        setEntries(prev => prev.map(e => e.id === id ? { ...e, ufr_marked_at: rollbackTs } : e))
      })
    } catch (err) {
      const msg = err?.response?.data?.error || err.message
      toast.error(`Couldn't move statement: ${msg}`)
      setEntries(prev => prev.map(e => e.id === id ? { ...e, ufr_marked_at: prevTs } : e))
    }
  }

  // Bulk move — apply moveUfrToStatement across every selected UFR'd row
  // in one shot. Use case: June's statement going out late means costs
  // uploaded after Jun 15 should stay in the June bucket instead of
  // rolling into July. Select the misbucketed rows, pick "June 2026",
  // done. Items that aren't UFR'd are silently skipped (statement
  // bucket only applies to uploaded items).
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false)
  const [bulkMoveYm, setBulkMoveYm] = useState('')
  const [bulkMoveSaving, setBulkMoveSaving] = useState(false)
  const openBulkMove = () => {
    // Default the picker to whichever statement is currently being viewed
    // — usually the user wants to push items OUT of the visible tab.
    const seed = statement && /^\d{4}-\d{2}$/.test(statement)
      ? statement
      : statementMonthFor(new Date().toISOString()) || ''
    setBulkMoveYm(seed)
    setBulkMoveOpen(true)
  }
  const submitBulkMove = async () => {
    const ym = bulkMoveYm
    if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return
    const ids = Array.from(selectedIds)
    // Eligible = UFR'd (has a statement bucket) AND not already in the
    // target month. Filtering here keeps the toast count honest and
    // skips no-op PUTs.
    const eligible = entries.filter(e =>
      ids.includes(e.id) && e.ufr === 'Yes' && e.ufr_marked_at &&
      statementMonthFor(e.ufr_marked_at) !== ym
    )
    if (!eligible.length) {
      toast.error('No selected items can be moved (need UFR + not already in that month).')
      setBulkMoveOpen(false)
      return
    }
    const newTs = `${ym}-01T12:00:00.000Z`
    // Snapshot prev timestamps for undo.
    const prevByid = new Map(eligible.map(e => [e.id, e.ufr_marked_at]))
    setBulkMoveSaving(true)
    setEntries(prev => prev.map(e =>
      prevByid.has(e.id) ? { ...e, ufr_marked_at: newTs } : e
    ))
    try {
      await Promise.all(
        eligible.map(e => api.put(`/bk/entries/${e.id}`, { ufr_marked_at: newTs }))
      )
      const targetLabel = statementLabel(ym)
      showUndo(`Moved ${eligible.length} item${eligible.length === 1 ? '' : 's'} to ${targetLabel} statement`, async () => {
        await Promise.all(
          Array.from(prevByid.entries()).map(([id, ts]) =>
            api.put(`/bk/entries/${id}`, { ufr_marked_at: ts || null })
          )
        )
        setEntries(prev => prev.map(e =>
          prevByid.has(e.id) ? { ...e, ufr_marked_at: prevByid.get(e.id) || null } : e
        ))
      })
      setBulkMoveOpen(false)
    } catch (err) {
      const msg = err?.response?.data?.error || err.message
      toast.error(`Couldn't move statement: ${msg}`)
      // Rollback optimistic update on failure.
      setEntries(prev => prev.map(e =>
        prevByid.has(e.id) ? { ...e, ufr_marked_at: prevByid.get(e.id) || null } : e
      ))
    } finally {
      setBulkMoveSaving(false)
    }
  }

  // Per-expense flag-for-review — same expenses.flagged column + endpoint
  // the Artist Campaigns and Ledger flags write. Optimistic; the
  // server-echoed row (with flagged_by_name) overwrites on success.
  const toggleExpenseFlag = async (entryId, flagged, reason = null) => {
    setEntries(prev => prev.map(e => e.id === entryId ? {
      ...e,
      flagged,
      flag_reason: flagged ? (reason ?? e.flag_reason ?? null) : null,
      flagged_at: flagged ? new Date().toISOString() : null,
    } : e))
    try {
      const body = { flagged }
      if (reason != null) body.flag_reason = reason
      const { data } = await api.post(`/bk/entries/${entryId}/flag`, body)
      if (data?.data) setEntries(prev => prev.map(e => e.id === entryId ? { ...e, ...data.data } : e))
    } catch (err) {
      alert('Failed to update flag: ' + (err.response?.data?.error || err.message))
    }
  }
  const saveExpenseFlagReason = async (entryId, reason) => {
    setEntries(prev => prev.map(e => e.id === entryId ? { ...e, flag_reason: reason || null } : e))
    try {
      await api.post(`/bk/entries/${entryId}/flag`, { flagged: true, flag_reason: reason || '' })
    } catch (err) {
      alert('Failed to save reason: ' + (err.response?.data?.error || err.message))
    }
  }

  // Toggle recoupable. Optimistic update with rollback on failure.
  const toggleRecoupable = async (id, currentRecoupable) => {
    const newVal = !currentRecoupable
    setSavingId(id)
    setEntries(prev => prev.map(e => e.id === id ? { ...e, recoupable: newVal } : e))
    try {
      await api.put(`/bk/entries/${id}`, { recoupable: newVal })
      showUndo(newVal ? 'Marked Recoupable' : 'Removed Recoupable', async () => {
        await api.put(`/bk/entries/${id}`, { recoupable: currentRecoupable })
        setEntries(prev => prev.map(e => e.id === id ? { ...e, recoupable: currentRecoupable } : e))
      })
    } catch {
      setEntries(prev => prev.map(e => e.id === id ? { ...e, recoupable: currentRecoupable } : e))
    } finally { setSavingId(null) }
  }

  // Toggle the cobrand flag on a single expense. Optimistic — flip in
  // local state, PUT, rollback on failure. Mirrors toggleRecoupable.
  const toggleCobrand = async (id, current) => {
    const next = !current
    setSavingId(id)
    // Server forces category=Marketing when cobrand flips on — mirror
    // locally, and remember the previous category so undo restores it.
    const prevCategory = entries.find(e => e.id === id)?.category
    const patchOn = next ? { category: 'Marketing' } : {}
    setEntries(prev => prev.map(e => e.id === id ? { ...e, cobrand: next, ...patchOn } : e))
    try {
      await api.put(`/bk/entries/${id}`, { cobrand: next })
      showUndo(next ? 'Marked as Cobrand' : 'Removed Cobrand', async () => {
        await api.put(`/bk/entries/${id}`, { cobrand: current, ...(next ? { category: prevCategory } : {}) })
        setEntries(prev => prev.map(e => e.id === id ? { ...e, cobrand: current, ...(next ? { category: prevCategory } : {}) } : e))
      })
    } catch {
      setEntries(prev => prev.map(e => e.id === id ? { ...e, cobrand: current, ...(next ? { category: prevCategory } : {}) } : e))
    } finally { setSavingId(null) }
  }

  // Toggle row selection. Driven by a per-item checkbox.
  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  const clearSelection = () => setSelectedIds(new Set())

  // Bulk-select helpers. selectAllVisible() picks every filtered item in
  // the current view; selectIds(list) takes an explicit array (used by the
  // per-section 'Select section' buttons). Both toggle off if every target
  // id is already in the selection.
  const selectAllVisible = () => {
    // Scope to the CURRENT statement tab — selecting `filtered` grabbed
    // rows on other tabs too, and bulk actions then mutated invisible
    // rows (e.g. re-labeling already-uploaded items from the Pending tab).
    const allIds = statementFiltered.map(e => e.id)
    const everySelected = allIds.length > 0 && allIds.every(id => selectedIds.has(id))
    setSelectedIds(everySelected ? new Set() : new Set(allIds))
  }
  const selectIds = (ids) => {
    const everySelected = ids.length > 0 && ids.every(id => selectedIds.has(id))
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (everySelected) ids.forEach(id => next.delete(id))
      else ids.forEach(id => next.add(id))
      return next
    })
  }

  // Open the label editor. Two modes:
  //   - 'single' edits one item (the chip on a row was clicked)
  //   - 'bulk'   edits every currently-selected item (action-bar button)
  // alsoUfr=true is the "Set Label & Mark UFR" combined action — the workflow
  // the user described: mark these as uploaded AND record what label they
  // were uploaded under.
  const openLabelModal = (mode, ids, initial = '', alsoUfr = false) => {
    setLabelModal({ mode, ids, initial: initial || '', alsoUfr })
  }

  // Apply a label (and optionally toggle UFR) to a set of ids. Fires one
  // PUT per id; could be batched server-side if this gets slow.
  const applyLabel = async (rawLabel, ids, alsoUfr) => {
    const label = (rawLabel || '').trim()
    // Snapshot prior state per affected id so undo can restore both label
    // AND ufr (when alsoUfr was set) to whatever they were before.
    const prev = {}
    for (const id of ids) {
      const e = entries.find(x => x.id === id)
      if (e) prev[id] = { recoupment_label: e.recoupment_label || null, ufr: e.ufr || null }
    }
    setSavingLabel(true)
    try {
      const body = { recoupment_label: label || null }
      if (alsoUfr) body.ufr = 'Yes'
      // allSettled — Promise.all rejected on the first failure while
      // sibling PUTs had already landed server-side, leaving the screen
      // out of sync with the DB and no message shown.
      const results = await Promise.allSettled(ids.map(id => api.put(`/bk/entries/${id}`, body).then(() => id)))
      const okIds = new Set(results.filter(r => r.status === 'fulfilled').map(r => r.value))
      const failCount = ids.length - okIds.size
      setEntries(p => p.map(e => okIds.has(e.id)
        ? { ...e, recoupment_label: label || null, ufr: alsoUfr ? 'Yes' : e.ufr }
        : e
      ))
      if (failCount) { toast.error(`${failCount} of ${ids.length} failed — refetching`); fetchEntries({ silent: true }) }
      setLabelModal(null)
      if (selectedIds.size > 0) clearSelection()
      showUndo(
        `${label ? `Labeled "${label}"` : 'Cleared label'} on ${ids.length} item${ids.length === 1 ? '' : 's'}${alsoUfr ? ' + Uploaded' : ''}`,
        async () => {
          await Promise.all(ids.map(id => prev[id] && api.put(`/bk/entries/${id}`, prev[id])))
          setEntries(p => p.map(e => prev[e.id] ? { ...e, ...prev[e.id] } : e))
        }
      )
    } catch (err) {
      console.error('Failed to apply label:', err)
    } finally {
      setSavingLabel(false)
    }
  }

  // Notes editor — per-row free-form notes. Open via the sticky-note
  // icon on each row; saves PUT the new value and run through the
  // standard 10s undo toast so a slip is recoverable.
  const openNotesModal = (entry) => {
    setNotesModal({ id: entry.id, initial: entry.notes || '' })
  }
  const applyNotes = async (rawText, id) => {
    const next = (rawText || '').trim()
    const prevEntry = entries.find(x => x.id === id)
    const prevNotes = prevEntry?.notes || null
    setSavingNotes(true)
    try {
      await api.put(`/bk/entries/${id}`, { notes: next || null })
      setEntries(p => p.map(e => e.id === id ? { ...e, notes: next || null } : e))
      setNotesModal(null)
      showUndo(
        next ? 'Note saved' : 'Note cleared',
        async () => {
          await api.put(`/bk/entries/${id}`, { notes: prevNotes })
          setEntries(p => p.map(e => e.id === id ? { ...e, notes: prevNotes } : e))
        }
      )
    } catch (err) {
      console.error('Failed to save note:', err)
    } finally {
      setSavingNotes(false)
    }
  }

  // Derived data
  // Deduplicate artist names, keep the most common spelling. Uses the
  // punctuation-aware key so "LIFE/LINE" and "LIFELINE" collapse into one.
  const allArtists = (() => {
    const map = {}
    entries.forEach(e => {
      if (!e.artist) return
      const key = normalizeArtistKey(e.artist)
      if (!map[key]) map[key] = {}
      map[key][e.artist] = (map[key][e.artist] || 0) + 1
    })
    return Object.values(map).map(variants => {
      return Object.entries(variants).sort((a, b) => b[1] - a[1])[0][0]
    }).sort()
  })()

  // Unique labels seen on visible-or-recoupable entries — feeds the label
  // filter dropdown AND the autocomplete <datalist> inside the editor modal.
  // Pulled from `entries` (not `filtered`) so the dropdown still lists labels
  // even when the current filter happens to hide every member of a label.
  const existingLabels = useMemo(() => {
    const s = new Set()
    for (const e of entries) {
      const v = (e.recoupment_label || '').trim()
      if (v) s.add(v)
    }
    return [...s].sort((a, b) => a.localeCompare(b))
  }, [entries])

  // Unique song spellings — keyed by lowercased name so the autocomplete
  // datalist gives one suggestion per song. Picks the most common spelling
  // per song key (same rule the grouping uses).
  const existingSongs = useMemo(() => {
    const variants = {} // { lower: { spelling: count } }
    for (const e of entries) {
      const v = (e.song || '').trim()
      if (!v) continue
      const k = v.toLowerCase()
      if (!variants[k]) variants[k] = {}
      variants[k][v] = (variants[k][v] || 0) + 1
    }
    return Object.values(variants)
      .map(vs => Object.entries(vs).sort((a, b) => b[1] - a[1])[0][0])
      .sort((a, b) => a.localeCompare(b))
  }, [entries])

  // Categories — union of the canonical CATEGORIES list and any wild
  // values seen on existing entries (e.g. legacy categories not in the
  // canonical set). Same case-dedupe rule the song list uses.
  const categoryOptions = useMemo(() => {
    const variants = {}
    const seed = (v) => {
      const k = (v || '').toLowerCase()
      if (!k) return
      if (!variants[k]) variants[k] = {}
      variants[k][v] = (variants[k][v] || 0) + 1
    }
    for (const c of CATEGORIES) seed(c)
    for (const e of entries) seed((e.category || '').trim())
    return Object.values(variants)
      .map(vs => Object.entries(vs).sort((a, b) => b[1] - a[1])[0][0])
      .sort((a, b) => a.localeCompare(b))
  }, [entries])

  // Lookup table for fast parent resolution on split-family children.
  // Built once per `entries` change so each row's has_invoice check is O(1).
  const entryById = useMemo(() => {
    const m = {}
    for (const e of entries) m[e.id] = e
    return m
  }, [entries])

  // Files live on the parent in a split family — children inherit visibility
  // via `parent_id`. If the entry has its own invoice, use that; otherwise
  // fall through to the parent's. Mirrors the file_entry_id pattern used by
  // the Lookup + Export endpoints.
  const hasInvoiceFile = (entry) => {
    if (entry.has_invoice) return true
    if (entry.parent_id) return !!entryById[entry.parent_id]?.has_invoice
    return false
  }
  const invoiceUrl = (entry) => {
    // Prefer the row's OWN file — a split child with its own attached
    // invoice used to open the parent's document (or 404).
    const id = (!entry.has_invoice && entry.parent_id) ? entry.parent_id : entry.id
    return `/api/bk/entries/${id}/file/invoice?token=${localStorage.getItem('token')}`
  }
  // Socials live on the parent for vendor split-families — only the
  // parent row carries the social_handles JSONB, children get nothing.
  // Mirror the invoice-file inheritance so each child still surfaces
  // the vendor's handles inline. Returns the parsed list from
  // socialsList() ready to render.
  const entrySocials = (entry) => {
    const own = socialsList(entry.social_handles)
    if (own.length) {
      // Own list — filter to this row's artist so a parent with tagged
      // socials only surfaces the relevant ones on the child.
      return socialsList(filterSocialsForArtist(entry.social_handles, entry.artist))
    }
    if (entry.parent_id) {
      // Inherited from parent — same filter, using the child's artist.
      const parentRaw = entryById[entry.parent_id]?.social_handles
      return socialsList(filterSocialsForArtist(parentRaw, entry.artist))
    }
    return []
  }

  const openSongModal = (mode, ids, initial = '') => {
    setSongModal({ mode, ids, initial: initial || '' })
  }
  const openSocialsModal = (entry) => {
    const existing = Array.isArray(entry.social_handles) ? entry.social_handles : []
    setSocialsRows(existing.length
      ? existing.map(s => ({ platform: s?.platform || 'Instagram', handle: s?.handle || '', artist: s?.artist || '', amount: s?.amount ?? '' }))
      : [{ platform: 'Instagram', handle: '', artist: '', amount: '' }])
    // Carry the artist family into the modal so the "For artist"
    // dropdown can be populated when the invoice has splits.
    setSocialsModal({ id: entry.id, familyArtists: familyArtists(entry) })
  }
  const applySocials = async (rawRows, id) => {
    const cleaned = (rawRows || [])
      .map(r => {
        const platform = (r.platform || 'Instagram').trim()
        const handle = (r.handle || '').trim()
        const artist = (r.artist || '').trim()
        if (!handle) return null
        const row = { platform, handle }
        if (artist) row.artist = artist
        const amountNum = parseFloat(r.amount)
        if (Number.isFinite(amountNum) && amountNum > 0) row.amount = amountNum
        return row
      })
      .filter(Boolean)
    const prevEntry = entries.find(x => x.id === id)
    const prevHandles = Array.isArray(prevEntry?.social_handles) ? prevEntry.social_handles : []
    setSavingSocials(true)
    try {
      const nextVal = cleaned.length ? cleaned : null
      await api.put(`/bk/entries/${id}`, { social_handles: nextVal })
      setEntries(p => p.map(e => e.id === id ? { ...e, social_handles: nextVal } : e))
      setSocialsModal(null)
      showUndo(
        cleaned.length ? `Updated socials (${cleaned.length})` : 'Cleared socials',
        async () => {
          const restore = prevHandles.length ? prevHandles : null
          await api.put(`/bk/entries/${id}`, { social_handles: restore })
          setEntries(p => p.map(e => e.id === id ? { ...e, social_handles: restore } : e))
        }
      )
    } catch (err) {
      console.error('Failed to save socials:', err)
    } finally {
      setSavingSocials(false)
    }
  }
  const openCategoryModal = (mode, ids, initial = '') => {
    setCategoryModal({ mode, ids, initial: initial || '' })
  }
  const openPayeeModal = (id, initial = '') => {
    setPayeeModal({ id, initial: initial || '' })
  }
  const applyPayee = async (rawPayee, id) => {
    const next = (rawPayee || '').trim()
    if (!next) return
    const prev = entries.find(e => e.id === id)?.payee || ''
    setSavingPayee(true)
    try {
      await api.put(`/bk/entries/${id}`, { payee: next })
      setEntries(p => p.map(e => e.id === id ? { ...e, payee: next } : e))
      setPayeeModal(null)
      showUndo(`Renamed to "${next}"`, async () => {
        await api.put(`/bk/entries/${id}`, { payee: prev })
        setEntries(p => p.map(e => e.id === id ? { ...e, payee: prev } : e))
      })
    } catch (err) {
      alert('Failed to rename: ' + (err.response?.data?.error || err.message))
    } finally {
      setSavingPayee(false)
    }
  }

  const applyCategory = async (rawCat, ids) => {
    const next = (rawCat || '').trim()
    const prev = {}
    for (const id of ids) {
      const e = entries.find(x => x.id === id)
      if (e) prev[id] = e.category || null
    }
    setSavingCategory(true)
    try {
      const results = await Promise.allSettled(ids.map(id => api.put(`/bk/entries/${id}`, { category: next || null }).then(() => id)))
      const okIds = new Set(results.filter(r => r.status === 'fulfilled').map(r => r.value))
      const failCount = ids.length - okIds.size
      setEntries(p => p.map(e => okIds.has(e.id) ? { ...e, category: next || null } : e))
      if (failCount) { toast.error(`${failCount} of ${ids.length} failed — refetching`); fetchEntries({ silent: true }) }
      setCategoryModal(null)
      showUndo(
        `${next ? `Set category to "${next}"` : 'Cleared category'} on ${ids.length} item${ids.length === 1 ? '' : 's'}`,
        async () => {
          await Promise.all(ids.map(id => api.put(`/bk/entries/${id}`, { category: prev[id] })))
          setEntries(p => p.map(e => prev[e.id] !== undefined ? { ...e, category: prev[e.id] } : e))
        }
      )
    } catch (err) {
      console.error('Failed to update category:', err)
    } finally {
      setSavingCategory(false)
    }
  }


  const applySong = async (rawSong, ids) => {
    const next = (rawSong || '').trim()
    const prev = {}
    for (const id of ids) {
      const e = entries.find(x => x.id === id)
      if (e) prev[id] = e.song || null
    }
    setSavingSong(true)
    try {
      const results = await Promise.allSettled(ids.map(id => api.put(`/bk/entries/${id}`, { song: next || null }).then(() => id)))
      const okIds = new Set(results.filter(r => r.status === 'fulfilled').map(r => r.value))
      const failCount = ids.length - okIds.size
      setEntries(p => p.map(e => okIds.has(e.id) ? { ...e, song: next || null } : e))
      if (failCount) { toast.error(`${failCount} of ${ids.length} failed — refetching`); fetchEntries({ silent: true }) }
      setSongModal(null)
      showUndo(
        `${next ? `Set song to "${next}"` : 'Cleared song'} on ${ids.length} item${ids.length === 1 ? '' : 's'}`,
        async () => {
          await Promise.all(ids.map(id => api.put(`/bk/entries/${id}`, { song: prev[id] })))
          setEntries(p => p.map(e => prev[e.id] !== undefined ? { ...e, song: prev[e.id] } : e))
        }
      )
    } catch (err) {
      console.error('Failed to update song:', err)
    } finally {
      setSavingSong(false)
    }
  }

  const filtered = useMemo(() => {
    let list = [...entries]
    if (filterRecoupable === 'Yes') list = list.filter(e => !!e.recoupable)
    else if (filterRecoupable === 'No') list = list.filter(e => !e.recoupable)
    if (routeArtist) {
      // 'Unassigned' is the synthetic group key the grouper uses for entries
      // with a missing / blank artist field — matching against e.artist
      // literally would never hit, so route there explicitly.
      if (routeArtist.toLowerCase() === 'unassigned') {
        list = list.filter(e => !(e.artist || '').trim())
      } else {
        // Punctuation-aware match: a route arriving as "LIFE/LINE"
        // still matches rows stored under "LIFELINE" or "Life Line".
        const target = normalizeArtistKey(routeArtist)
        list = list.filter(e => normalizeArtistKey(e.artist) === target)
      }
    } else if (filterArtist) {
      const target = normalizeArtistKey(filterArtist)
      list = list.filter(e => normalizeArtistKey(e.artist) === target)
    }
    if (filterUfr === 'Yes') list = list.filter(e => e.ufr === 'Yes')
    if (filterUfr === 'No') list = list.filter(e => e.ufr !== 'Yes')
    if (filterUfr === 'unverified') list = list.filter(isUfrUnverified)
    if (filterPayment === 'Paid') list = list.filter(e => e.payment_status === 'Paid')
    if (filterPayment === 'Unpaid') list = list.filter(e => e.payment_status !== 'Paid')
    if (filterLabel === '__none__') list = list.filter(e => !(e.recoupment_label || '').trim())
    else if (filterLabel) list = list.filter(e => (e.recoupment_label || '').trim() === filterLabel)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(e =>
        (e.payee || '').toLowerCase().includes(q) ||
        (e.artist || '').toLowerCase().includes(q) ||
        (e.song || '').toLowerCase().includes(q) ||
        (e.description || '').toLowerCase().includes(q) ||
        (e.category || '').toLowerCase().includes(q) ||
        (e.recoupment_label || '').toLowerCase().includes(q) ||
        // Match against socials too — handles + platforms — so users
        // can find "where did we pay @joe_smith?" without digging
        // through the Ledger. entrySocials() falls through to the
        // parent for vendor split children so search still hits them.
        entrySocials(e).some(s =>
          s.handle.toLowerCase().includes(q) || s.platform.toLowerCase().includes(q)
        )
      )
    }
    return list
  }, [entries, filterRecoupable, filterArtist, routeArtist, filterUfr, filterLabel, filterPayment, search])

  // ── Statement tabs (detail view only) ──────────────────────────────────────
  // availableStatements = distinct YYYY-MM keys for every month in which one
  // of this artist's items was uploaded for recoupment (ufr === 'Yes' and a
  // ufr_marked_at timestamp on record). Sorted descending so the most recent
  // statement leads the tab strip after the 'pending' bucket.
  const availableStatements = useMemo(() => {
    if (!isDetail) return []
    const months = new Map() // ym → { count, label }
    for (const e of filtered) {
      if (e.ufr !== 'Yes' || !e.ufr_marked_at) continue
      const ym = statementMonthFor(e.ufr_marked_at)
      if (!ym) continue
      const bucket = months.get(ym) || { ym, count: 0, label: statementLabel(ym), window: statementWindowLabel(ym) }
      bucket.count += 1
      months.set(ym, bucket)
    }
    return [...months.values()].sort((a, b) => (a.ym < b.ym ? 1 : -1))
  }, [filtered, isDetail])

  // Count for the 'Pending' tab — items not yet UFR'd. The statement filter
  // below uses the same predicate to subset rows when 'pending' is active.
  const pendingCount = useMemo(() => {
    if (!isDetail) return 0
    return filtered.filter(e => e.ufr !== 'Yes').length
  }, [filtered, isDetail])

  // Count for the 'Uploaded' tab — every item already UFR'd, regardless
  // of which statement month it landed on. Complement of pendingCount.
  const uploadedCount = useMemo(() => {
    if (!isDetail) return 0
    return filtered.filter(e => e.ufr === 'Yes').length
  }, [filtered, isDetail])

  // statementFiltered narrows `filtered` to the rows belonging to the
  // currently-selected statement tab. Bypassed entirely on the INDEX view —
  // the artist cards always summarize the whole roster, not a month slice.
  const statementFiltered = useMemo(() => {
    if (!isDetail) return filtered
    if (statement === 'pending') {
      return filtered.filter(e => e.ufr !== 'Yes')
    }
    // Inverse of 'pending' — every UFR'd item collapsed into one view
    // regardless of which monthly statement it would normally bucket into.
    // Useful for an "everything we've already uploaded" audit.
    if (statement === 'uploaded') {
      return filtered.filter(e => e.ufr === 'Yes')
    }
    // 'all' bypasses the statement-date slice entirely — every row that
    // survives the filter bar shows up regardless of whether it's been
    // uploaded for recoupment or which statement month it landed on.
    if (statement === 'all') {
      return filtered
    }
    // Monthly bucket — match the row's STATEMENT month, which rolls items
    // uploaded on day ≥21 forward into the next month (statements are
    // released on the 20th, so an upload on the 26th lands on the NEXT
    // statement, not the one already out the door).
    if (!/^\d{4}-\d{2}$/.test(statement)) {
      return filtered.filter(e => e.ufr !== 'Yes') // unknown key, fall back to pending
    }
    return filtered.filter(e => {
      if (e.ufr !== 'Yes' || !e.ufr_marked_at) return false
      return statementMonthFor(e.ufr_marked_at) === statement
    })
  }, [filtered, statement, isDetail])

  // Group by artist → song/category. Both levels use a lowercased key so
  // capitalization variants ("Face it all" vs "Face It All") merge into one
  // bucket; the display name is whichever spelling appears most often. The
  // underlying expense rows keep their original `song` values — only the
  // display normalizes. To clean up the underlying data, the user can rename
  // a whole group via the pencil button on the group header (bulk PUT) or
  // edit a single item's song chip on the row.
  // Pure grouping helper. Extracted from the existing grouped useMemo so it
  // can also run on payment-status subsets — the DETAIL view splits the
  // listing into Paid Invoices and Unpaid Invoices sections, each with the
  // same artist→song/category hierarchy. Closes over `groupBy` and `fxRates`.
  const computeGrouped = (items) => {
    const byArtist = {}
    const artistNames = {}     // { aKey: { variantName: count } }
    const groupSpellings = {}  // { aKey: { gKey: { variantName: count } } }
    for (const e of items) {
      // Punctuation-aware artist key — collapses "LIFE/LINE",
      // "LIFELINE", "Life Line" into a single bucket. The
      // best-spelling logic below still picks the most-common
      // original variant as the display name.
      const aKey = e.artist ? normalizeArtistKey(e.artist) : 'unassigned'
      if (!byArtist[aKey]) byArtist[aKey] = {}
      if (!artistNames[aKey]) artistNames[aKey] = {}
      artistNames[aKey][e.artist || 'Unassigned'] = (artistNames[aKey][e.artist || 'Unassigned'] || 0) + 1

      // Group by whichever field the user selected. Empty values land in
      // an 'N/A' bucket (lowercase key '__na__' so it can't collide with
      // a real song/category named 'N/A').
      const fieldVal = (groupBy === 'category' ? e.category : e.song) || ''
      const trimmed = fieldVal.trim()
      const rawName = trimmed || 'N/A'
      const gKey = trimmed ? trimmed.toLowerCase() : '__na__'
      if (!byArtist[aKey][gKey]) byArtist[aKey][gKey] = []
      byArtist[aKey][gKey].push(e)

      if (!groupSpellings[aKey]) groupSpellings[aKey] = {}
      if (!groupSpellings[aKey][gKey]) groupSpellings[aKey][gKey] = {}
      groupSpellings[aKey][gKey][rawName] = (groupSpellings[aKey][gKey][rawName] || 0) + 1
    }
    const bestSpelling = (variants) =>
      Object.entries(variants).sort((a, b) => b[1] - a[1])[0]?.[0]
    const bestArtistName = (key) => bestSpelling(artistNames[key] || {}) || key
    const bestGroupName  = (aKey, gKey) => bestSpelling(groupSpellings[aKey]?.[gKey] || {}) || gKey

    // Pick a single number per artist/group for sort-by-total ordering.
    // Converts each amount to its USD equivalent so a ¥50,000 row (≈ $320)
    // doesn't dwarf a $600 row in the rank just because the raw number is
    // bigger. Items without a known FX rate fall back to face value — the
    // visible totals still show native + USD-suffix separately.
    const rank = (items) => items.reduce((s, e) => {
      const v = entryToUsd(e, fxRates)
      return s + (v == null ? parseFloat(e.amount || 0) : v)
    }, 0)

    return Object.entries(byArtist)
      .map(([aKey, groups]) => {
        const allItems = Object.values(groups).flat()
        return {
          artist: bestArtistName(aKey),
          artistKey: aKey,
          groups: Object.entries(groups).map(([gKey, items]) => {
            // 'source' drives the header styling + whether the rename pencil
            // shows. With explicit grouping the source is determined by the
            // groupBy mode and whether the items have a value in that field.
            // Items in the '__na__' bucket are by definition missing the
            // value, so their source is 'none' regardless of groupBy.
            const source = gKey === '__na__'
              ? 'none'
              : groupBy
            return {
              name: bestGroupName(aKey, gKey),
              key: gKey,
              source,
              items: items.sort((a, b) => b.amount - a.amount),
              total: rank(items),
              totalByCurrency: groupByCurrency(items),
              ufrCount: items.filter(e => e.ufr === 'Yes').length,
              cobrandTotalByCurrency: groupByCurrency(items.filter(e => !!e.cobrand)),
              cobrandCount: items.filter(e => !!e.cobrand).length,
            }
          }).sort((a, b) => {
            // N/A bucket sinks to the bottom regardless of total.
            if (a.key === '__na__' && b.key !== '__na__') return 1
            if (b.key === '__na__' && a.key !== '__na__') return -1
            // When grouping by Category, pin Advance first and Marketing
            // second regardless of size — both are workflow-critical and
            // belong at the top so users don't scroll past them. Lower
            // priority number = higher up the list.
            if (groupBy === 'category') {
              const PINNED = { advance: 0, marketing: 1 }
              const ap = PINNED[a.key]
              const bp = PINNED[b.key]
              if (ap !== undefined && bp !== undefined) return ap - bp
              if (ap !== undefined) return -1
              if (bp !== undefined) return 1
            }
            return b.total - a.total
          }),
          total: rank(allItems),
          totalByCurrency: groupByCurrency(allItems),
          ufrTotalByCurrency: groupByCurrency(allItems.filter(e => e.ufr === 'Yes')),
          ufrCount: allItems.filter(e => e.ufr === 'Yes').length,
          ufrUnverifiedCount: allItems.filter(isUfrUnverified).length,
          itemCount: allItems.length,
          cobrandTotalByCurrency: groupByCurrency(allItems.filter(e => !!e.cobrand)),
          cobrandCount: allItems.filter(e => !!e.cobrand).length,
          // Paid-only sub-totals — used by the INDEX view artist cards so the
          // progress bars only measure what's actually been spent (and is
          // therefore eligible to be uploaded for recoupment). Unpaid items
          // sit in the Unpaid section of the DETAIL view but don't count
          // against the artist's recoupment progress bars.
          paidItemCount: allItems.filter(e => e.payment_status === 'Paid').length,
          paidUfrCount: allItems.filter(e => e.payment_status === 'Paid' && e.ufr === 'Yes').length,
          paidTotalByCurrency: groupByCurrency(allItems.filter(e => e.payment_status === 'Paid')),
          paidUfrTotalByCurrency: groupByCurrency(allItems.filter(e => e.payment_status === 'Paid' && e.ufr === 'Yes')),
          // Flat row list so artist-level USD totals can honor per-row
          // locked rates (via itemsToUsd / usdItemsSuffix). Without this,
          // the only path to a USD-equivalent was through the by-currency
          // map, which loses per-row context.
          allItems,
          paidItems:    allItems.filter(e => e.payment_status === 'Paid'),
          paidUfrItems: allItems.filter(e => e.payment_status === 'Paid' && e.ufr === 'Yes'),
          // What the BANK says, per state — the same recoupState the tiles and
          // the evidence dot use. Kept as ITEM LISTS, not just totals, so the
          // card's strip and any subtotal reduce over the same rows and cannot
          // drift from each other.
          stateItems: {
            verified: allItems.filter(e => recoupState(e) === 'verified'),
            awaiting_statement: allItems.filter(e => recoupState(e) === 'awaiting_statement'),
            unverified: allItems.filter(e => recoupState(e) === 'unverified'),
            unpaid: allItems.filter(e => recoupState(e) === 'unpaid'),
          },
          // Provable and never claimed — this artist's share of the biggest
          // actionable figure on the page.
          provableUnclaimedItems: allItems.filter(e => recoupState(e) === 'verified' && e.ufr !== 'Yes'),
          // The rest of the pending pile, split by what can actually be DONE
          // about it. Same four `recoupState` bands used everywhere else,
          // narrowed to rows nobody has uploaded — an uploaded row is not a
          // to-do. All 152 artists have SOMETHING pending, so "pending" alone
          // ranks nothing; only 107 have a provable item and 15 have nothing
          // but unpaid invoices. The index queue's columns, its ranking and its
          // partitions all reduce over these four lists, so they cannot drift.
          awaitingUnclaimedItems:   allItems.filter(e => e.ufr !== 'Yes' && recoupState(e) === 'awaiting_statement'),
          unverifiedUnclaimedItems: allItems.filter(e => e.ufr !== 'Yes' && recoupState(e) === 'unverified'),
          unpaidUnclaimedItems:     allItems.filter(e => e.ufr !== 'Yes' && recoupState(e) === 'unpaid'),
          // Uploaded, and the bank does not back it — the one band that is a
          // discrepancy rather than a queue. 9 artists / 43 items live here.
          ufrUnverifiedItems: allItems.filter(isUfrUnverified),
        }
      })
      .sort((a, b) => b.total - a.total)
  }
  // `grouped` powers the INDEX view (all artists) and the bulk-action /
  // header bits of the detail view that need the artist's full roster.
  // The four state-scoped groupings below power the DETAIL view's stacked
  // sections. They run against `statementFiltered` so each statement tab only
  // renders the rows that belong to it (pending = not yet UFR'd; YYYY-MM = items
  // UFR-stamped that month).
  //
  // `groupedPaid` used to be one of them and is gone: "Paid" covered three
  // different situations and only one of them is a problem.
  // fxRates is in the dep array so the artist/group ordering recomputes
  // once the FX map arrives — sort uses USD-equivalent totals.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const grouped       = useMemo(() => computeGrouped(filtered),                                                              [filtered, groupBy, fxRates])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // ── The detail listing: ONE grouping level ───────────────────────────────
  // Statement period and bank state used to be NESTING. Every item sat at the
  // bottom of a four-level tree — a tab strip, wrapping four stacked state
  // sections, wrapping song groups, wrapping category buckets, wrapping label
  // buckets. Measured on production 2026-09-14, counting only headers that
  // actually render: **1,530 headers around 1,209 pending rows**, 1.27 headers
  // per row. It was worst where there was least to organise — omnom's 20 rows
  // sat under 29 headers.
  //
  // The two inner levels were not organising anything. **524 of the 667
  // category headers (79%) wrapped a single category bucket** — a "Marketing"
  // bar over a list that was entirely Marketing — and the label level rendered
  // **12 headers in total across all 146 artists**. Both values are already
  // chips on every row, so the buckets restated the row one indent to the left.
  //
  // So: song is the only grouping level, and both axes became filters. The four
  // states are chips (same `recoupState` bands as the index queue, so the two
  // pages partition the same way), and the statement period is chips too.
  const [filterState, setFilterState] = useState('')
  const detailItems = useMemo(
    () => (filterState ? statementFiltered.filter(e => recoupState(e) === filterState) : statementFiltered),
    [statementFiltered, filterState])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const detailArtistGroup = useMemo(() => computeGrouped(detailItems)[0] || null, [detailItems, groupBy, fxRates])
  // Counts behind the state chips. Off `statementFiltered`, NOT `detailItems` —
  // a chip has to keep saying how many rows it would show AFTER it is clicked,
  // which is exactly the number that disappears if you count the filtered list.
  const stateCounts = useMemo(() => {
    const c = { verified: 0, awaiting_statement: 0, unverified: 0, unpaid: 0 }
    for (const e of statementFiltered) c[recoupState(e)]++
    return c
  }, [statementFiltered])
  // Rows inside a song group lead with the discrepancy, then the provable
  // money, then what is merely waiting — the order the four stacked sections
  // used to impose, kept now that they are gone. Amount breaks the tie, which
  // is what computeGrouped already sorted on.
  const STATE_RANK = { unverified: 0, verified: 1, awaiting_statement: 2, unpaid: 3 }
  const byStateThenAmount = (a, b) =>
    (STATE_RANK[recoupState(a)] - STATE_RANK[recoupState(b)]) || (b.amount - a.amount)

  // Stat-card totals are mixed-currency aware — keep each currency separate
  // (a €500 expense doesn't get blindly added to USD totals). fmtTotals
  // renders "$X" for a single currency or "$X + €Y" when there's a mix.
  //
  // A SPLIT FAMILY IS SUMMED WHOLE, and that is correct — do not add a filter
  // for parent-of-children here. The server hands this page the parent AND its
  // children, but the parent has been SHRUNK to its own slice by every writer
  // that can split one (`/entries/:id/split` sets the parent's amount to the
  // first slice; so do the auto-split-by-song in PUT /entries/:id and
  // /entries/:id/split-fee-reimb). So parent + children IS the invoice, once.
  //
  // TODO #18 read this as double-counting and asked for the parents to be
  // dropped, on the strength of a comment in /bk/export-recoupments claiming an
  // EXISTS filter that was never in that query. Measured on production
  // 2026-09-02: 111 split families, 275 children, ZERO parents still carrying a
  // whole invoice, and the proposed fix would have removed $47,226.01 of real
  // recoupable spend from a $3,126,376.38 page.
  //
  // `family_total` / `split_count` on each row are for DISPLAY — "what is this
  // invoice worth" on a row that shows its own slice. Summing family_total
  // instead of, or alongside, the rows is the one thing here that WOULD
  // double-count. This page reads neither, deliberately.
  // Pinned by server/scripts/split-family-total-fixture.cjs.
  const totalsByCurrency = useMemo(() => groupByCurrency(filtered), [filtered])
  const ufrFiltered = useMemo(() => filtered.filter(e => e.ufr === 'Yes'), [filtered])
  const ufrUnverifiedFiltered = useMemo(() => ufrFiltered.filter(isUfrUnverified), [ufrFiltered])
  const pendingFiltered = useMemo(() => filtered.filter(e => e.ufr !== 'Yes'), [filtered])
  const ufrTotalsByCurrency = useMemo(() => groupByCurrency(ufrFiltered), [ufrFiltered])
  const pendingTotalsByCurrency = useMemo(() => groupByCurrency(pendingFiltered), [pendingFiltered])

  // What the BANK says about each recoupable cost. recoupState is the same
  // definition bankUnverified now delegates to, so a row cannot read verified in
  // a band here and unverified on the evidence dot elsewhere.
  //
  // The HEADLINE is verified + awaiting: money that has left the bank, whether or
  // not the statement proving it has been uploaded yet. A cost uploaded the same
  // month it was paid belongs in the claim — there is simply no statement to check
  // it against yet, which is a different thing from a missing payment.
  const countedItems = useMemo(() => filtered.filter(recoupCounted), [filtered])

  // PROVABLE AND UNCLAIMED — the bank shows the payment and nobody has uploaded
  // it for recoupment. 622 items / $1,174,870.19 on the live page, invisible until
  // now because "Pending Upload" is simply `ufr !== 'Yes'` and therefore mixes
  // this in with unpaid invoices and unverified spend.
  const provableUnclaimed = useMemo(
    () => filtered.filter(e => recoupState(e) === 'verified' && e.ufr !== 'Yes'),
    [filtered])
  const [claimBusy, setClaimBusy] = useState(false)
  // The pending pile, split by what can be DONE about it — the page-level twin
  // of the four `*UnclaimedItems` lists on each artist. `pendingBands.verified`
  // IS `provableUnclaimed`; it is listed here so the summary line's four
  // figures visibly come from one partition of one list and must add up.
  const pendingBands = useMemo(() => {
    const b = { verified: [], awaiting_statement: [], unverified: [], unpaid: [] }
    for (const e of pendingFiltered) (b[recoupState(e)] || b.unpaid).push(e)
    return b
  }, [pendingFiltered])
  // Index-only Notes disclosure. Default closed: it is a scratchpad the team
  // reads occasionally, and as an always-open 3-row textarea it was costing
  // ~120px directly above the work.
  const [notesOpen, setNotesOpen] = useState(false)
  // Grouped by artist, biggest first: a whole artist is usually one decision.
  const provableByArtist = useMemo(() => {
    const m = new Map()
    for (const e of provableUnclaimed) {
      const k = normalizeArtistKey(e.artist) || '(none)'
      if (!m.has(k)) m.set(k, { name: String(e.artist || '').trim() || '(no artist)', items: [] })
      m.get(k).items.push(e)
    }
    return [...m.values()]
      .map(a => ({ ...a, usd: itemsToUsd(a.items, fxRates) || 0 }))
      .sort((x, y) => y.usd - x.usd)
  }, [provableUnclaimed, fxRates])

  const claimForRecoupment = async (items) => {
    const ids = items.map(e => e.id)
    if (!ids.length || claimBusy) return
    if (!window.confirm(
      `Upload ${ids.length} item${ids.length === 1 ? '' : 's'} for recoupment`
      + `${itemsToUsd(items, fxRates) ? ` — ${fmtUsdItems(items, fxRates)}` : ''}?\n\n`
      + 'Every one has a bank statement behind it, so the claim has evidence under it. '
      + 'This stamps today as the upload date, which is what decides the statement period.')) return
    setClaimBusy(true)
    try {
      const { data } = await api.post('/bk/entries/ufr-bulk', { ids, ufr: true })
      if (data?.data?.skipped) {
        alert(`${data.data.changed} uploaded — ${data.data.skipped} were skipped (not recoupable, or changed underneath).`)
      }
      await fetchEntries({ silent: true })
    } catch (err) {
      alert('Failed: ' + (err.response?.data?.error || err.message))
    } finally { setClaimBusy(false) }
  }
  // Cobrand subtotal across the currently-filtered view. Rendered as its
  // own stat tile alongside the recoupable totals so cobrand spend is
  // legible at a glance without having to filter by it.
  const cobrandFiltered = useMemo(() => filtered.filter(e => !!e.cobrand), [filtered])
  const cobrandTotalsByCurrency = useMemo(() => groupByCurrency(cobrandFiltered), [cobrandFiltered])

  // Paid / Unpaid splits — independent of UFR (which tracks uploaded-for-
  // recoupment status). Same multi-currency treatment as the other totals
  // so a EUR row doesn't get blindly added to USD. Rendered as their own
  // stat tiles next to UFR so the user can see cash flow status alongside
  // recoupment workflow status at the top of the page.

  // Non-recoupable expenses for the current artist, derived directly from
  // the already-fetched entries list (so it always reflects the latest
  // state of edits). Deliberately bypasses the page's other filters —
  // users want every non-recoupable item for context, not a re-narrowed
  // subset. MUST live above the `if (loading) return` below — moving it
  // under the early-return broke the Rules of Hooks (the useMemo wasn't
  // called on the initial loading=true render, then was called once
  // loading flipped false, blowing up the page with "Rendered more hooks
  // than during the previous render").
  const nonRecoupableItems = useMemo(() => {
    if (!isDetail) return []
    const matchArtist = (e) => {
      if (routeArtist.toLowerCase() === 'unassigned') return !(e.artist || '').trim()
      return normalizeArtistKey(e.artist) === normalizeArtistKey(routeArtist)
    }
    return entries
      .filter(e => matchArtist(e) && !e.recoupable)
      .sort((a, b) => {
        const ad = a.invoice_date || ''
        const bd = b.invoice_date || ''
        if (ad !== bd) return ad < bd ? 1 : -1
        return (b.id || 0) - (a.id || 0)
      })
  }, [entries, isDetail, routeArtist])

  const nonRecoupTotalByCur = useMemo(() => groupByCurrency(nonRecoupableItems), [nonRecoupableItems])

  // Pull the per-artist expanded state from localStorage on route change.
  // Same hooks-ordering reason as above for keeping this above the early
  // return.
  useEffect(() => {
    if (!isDetail || !routeArtist) return
    try {
      const stored = localStorage.getItem(NON_RECOUP_KEY(routeArtist))
      setShowNonRecoup(stored === '1')
    } catch { setShowNonRecoup(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDetail, routeArtist])
  const toggleShowNonRecoup = () => {
    setShowNonRecoup(prev => {
      const next = !prev
      try { localStorage.setItem(NON_RECOUP_KEY(routeArtist), next ? '1' : '0') } catch {}
      return next
    })
  }

  if (loading) return (
    <div className="space-y-6">
      <Skeleton.PageHeader />
      <Skeleton.StatCards count={3} />
      <Skeleton.Table rows={8} cols={6} />
    </div>
  )

  // On the detail page we want the displayed artist name to be the
  // canonical spelling pulled from the data (route param could be any
  // case variant). Fall back to the route value if no entries match yet.
  const detailArtist = isDetail
    ? (grouped[0]?.artist || routeArtist)
    : null
  // Shared artist-meta entry for the detail view — used to render the
  // "Complete on Campaigns" chip below the header. Empty when the
  // artist has no meta row yet.
  const detailMeta = isDetail
    ? (artistMeta[(detailArtist || '').toLowerCase().trim()] || {})
    : {}

  return (
    <div className="space-y-6" data-tour="recoupments-page">
      {isDetail && (
        <div className="flex items-center justify-between">
          <Link
            to="/recoupments"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-gray-800 transition-colors"
          >
            <ArrowLeft size={13} /> All artists
          </Link>
          <div className="flex items-center gap-2">
            {/* Collapse / Expand every group. One level to walk now — it used
                to also flip the secondary and label sub-buckets, which no
                longer exist. Keys off `detailArtistGroup`, the same object the
                list renders from, so "collapse all" can't miss a group the
                current period + band filter is showing. */}
            {(() => {
              const allKeys = []
              const artistKey = detailArtistGroup?.artistKey
              if (artistKey) {
                for (const g of detailArtistGroup.groups) allKeys.push(`g:${artistKey}:${g.key}`)
              }
              const anyExpanded = allKeys.some(k => !collapsed.has(k))
              if (allKeys.length === 0) return null
              return (
                <button
                  onClick={() => setAllCollapsed(allKeys, anyExpanded)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-gray-700 bg-card border border-rule hover:bg-gray-50 hover:border-gray-300 transition-colors"
                  title={anyExpanded ? 'Collapse every group on this page' : 'Expand every group on this page'}
                >
                  {anyExpanded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  {anyExpanded ? 'Collapse all' : 'Expand all'}
                </button>
              )
            })()}
            {/* Excel export — bundles every recoupable item for this artist
                into a single sheet, organized by the current Group By so the
                downloaded layout matches what's on screen. Token in the URL
                so the browser can hand off the download cleanly without an
                Authorization header. */}
            <a
              // Honors the on-screen payment filter — set the "All Payments"
              // dropdown to "Paid" or "Unpaid" before clicking Export to
              // download only that subset.
              href={`/api/bk/export-recoupments?artist=${encodeURIComponent(routeArtist)}&groupBy=${encodeURIComponent(groupBy)}${filterPayment ? `&paymentStatus=${encodeURIComponent(filterPayment)}` : ''}&token=${localStorage.getItem('token') || ''}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-gray-700 bg-card border border-rule hover:bg-gray-50 hover:border-gray-300 transition-colors"
              title={filterPayment
                ? `Download ${filterPayment.toLowerCase()} recoupable items for this artist`
                : 'Download every recoupable item for this artist (set the All Payments filter to Paid / Unpaid to narrow the export)'}
              download
            >
              <Download size={13} /> Export Excel{filterPayment ? ` · ${filterPayment}` : ''}
            </a>
            {/* Add / edit the artist note. The note CARD renders only when
                there is a note — it used to hold a full card's height on every
                subpage just to offer "Add note…" — so this is now the way in. */}
            {!(artistNote || '').trim() && (
              <button
                onClick={() => setEditingArtistNote(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-gray-700 bg-card border border-rule hover:bg-gray-50 hover:border-gray-300 transition-colors"
                title="Add an overarching note for this artist"
              >
                <StickyNote size={13} /> Note
              </button>
            )}
            {/* Jump straight to this artist's section of the planning
                scratchpad — ?artist= drills the Planning page into their
                song→category detail. */}
            <Link
              to={`/recoupments/planning?artist=${encodeURIComponent(routeArtist.trim().toLowerCase())}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-gray-700 bg-card border border-rule hover:bg-gray-50 hover:border-gray-300 transition-colors"
              title="Open this artist in the recoupment planning scratchpad"
            >
              <FolderOpen size={13} /> Planning
            </Link>
            {/* Only render the add button once we know the artist's DB id —
                the synthetic 'Unassigned' subpage and not-yet-loaded states
                hide it since the POST endpoint needs an artist row. */}
            {artistInfo?.id && (
              <button
                onClick={openAddModal}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-boom-600 hover:bg-boom-700 transition-colors"
                title="Add a new expense for this artist"
              >
                <Plus size={13} /> Add Expense
              </button>
            )}
          </div>
        </div>
      )}
      {/* Index-view actions row. Detail view has its own row above with
          back-arrow + collapse-all + export + the artist-pinned Add
          button; the index uses the same modal but in a no-artist-pinned
          mode (user types the artist into the form). */}
      {!isDetail && (
        <div className="flex items-center justify-end gap-2">
          {/* Working-set scratchpad for the next recoupment upload —
              lives at /recoupments/planning. No commits happen there;
              it's a filter + checklist that helps you decide what
              goes into the next batch. */}
          {/* 2025 Expenses bucket — prior-year spend tagged off the live
              flow. Amber to read as "archived-ish", count when nonempty. */}
          {/* Only when the bucket holds something. The route still exists and
              still works if you type it; this is the button, not the feature. */}
          {count2025 > 0 && (
            <Link
              to="/recoupments/2025"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors bg-amber-50 text-amber-700 border-amber-200 hover:border-amber-300"
              title="Prior-year spend tagged as 2025 Expenses — organized by artist"
            >
              <CalendarClock size={13} /> 2025 Expenses ({count2025})
            </Link>
          )}
          <Link
            to="/recoupments/planning"
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
              planSize(plan) > 0
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:border-emerald-300'
                : 'bg-card text-gray-700 border-rule hover:border-gray-300'
            }`}
            title={planSize(plan) > 0
              ? `${planSize(plan)} item${planSize(plan) === 1 ? '' : 's'} staged — click to group + label before Done`
              : 'Planning scratchpad — pick items for the next recoupment upload'}
          >
            <FolderOpen size={13} /> Planning{planSize(plan) > 0 ? ` (${planSize(plan)})` : ''}
          </Link>
          <button
            onClick={openAddModal}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-boom-600 hover:bg-boom-700 transition-colors"
            title="Add a recoupable expense from this page"
          >
            <Plus size={13} /> Add Expense
          </button>
        </div>
      )}
      {isDetail && (
        <Breadcrumb items={[
          { label: 'Recoupments', path: '/recoupments' },
          artistLink ? { label: detailArtist, path: `/artists/${artistLink.id}` } : { label: detailArtist },
        ]} />
      )}
      <PageHeader tour="recoupments-header"
        title={isDetail ? detailArtist : 'Recoupments'}
        subtitle={isDetail
          ? `${filtered.length} item${filtered.length === 1 ? '' : 's'} across ${grouped[0]?.groups.length || 0} group${(grouped[0]?.groups.length || 0) === 1 ? '' : 's'}`
          : `${filtered.length} recoupable item${filtered.length === 1 ? '' : 's'} across ${grouped.length} artist${grouped.length === 1 ? '' : 's'}`
        }
      />

      {/* Cross-page status chip — mirrors the same meta.complete flag the
          Artist Campaigns page sets. Purely informational here; the
          toggle lives on that page so the two views can't drift. */}
      {isDetail && detailMeta.complete && (
        <div className="-mt-3">
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
            title={`Marked complete on Artist Campaigns${detailMeta.complete_by_name ? ` by ${detailMeta.complete_by_name}` : ''}${detailMeta.complete_at ? ` on ${new Date(detailMeta.complete_at).toLocaleDateString()}` : ''}`}
          >
            <CheckCircle2 size={11} /> Complete on Campaigns
          </span>
        </div>
      )}

      {/* Artist-level overarching note. Detail subpage only, and rendered ONLY
          when there is a note (or one is being written) — it used to be an
          always-present card whose entire empty state was an "Add note…" link,
          which is now a button in the header row above. Commits on blur or
          Cmd/Ctrl+Enter. */}
      {isDetail && (editingArtistNote || (artistNote || '').trim()) && (
        <div className="card px-5 py-4">
          <div className="flex items-start gap-3">
            <StickyNote size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 mb-1">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Artist Note</p>
                {!editingArtistNote && artistNote && (
                  <button
                    onClick={() => setEditingArtistNote(true)}
                    className="text-[11px] font-semibold text-boom-600 hover:text-boom-700"
                  >Edit</button>
                )}
              </div>
              {editingArtistNote ? (
                <textarea
                  defaultValue={artistNote}
                  autoFocus
                  rows={3}
                  placeholder="Overarching context for this artist — caps, pending payouts, deal reminders, etc."
                  className="w-full text-sm border border-gray-200 rounded-md px-3 py-2 focus:border-boom-400 focus:outline-none resize-y"
                  onBlur={async (e) => {
                    if (e.target.value !== artistNote) await saveRecoupmentNote({ note: e.target.value })
                    setEditingArtistNote(false)
                  }}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' && (e.metaKey || e.ctrlKey)) || e.key === 'Escape') {
                      e.preventDefault()
                      e.currentTarget.blur()
                    }
                  }}
                />
              ) : (
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{artistNote}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Deal summary — only on the detail subpage, when contract terms exist
          for the artist. Pulled from /api/artists/:id/budget so this view can
          show recoupment progress against the deal advance. Migrated from the
          Artist Budgets page so that view can be retired. */}
      {isDetail && artistInfo?.dealSummary && artistInfo.dealSummary.lines?.length > 0 && (
        <div className="card px-5 py-4">
          <div
            onClick={() => toggleCollapsed('deal')}
            className="flex items-center justify-between gap-3 mb-2 cursor-pointer hover:opacity-90"
            title={isCollapsed('deal') ? 'Expand Deal Terms' : 'Collapse Deal Terms'}
          >
            <div className="flex items-center gap-2">
              {isCollapsed('deal')
                ? <ChevronRight size={14} className="text-gray-400 flex-shrink-0" />
                : <ChevronDown size={14} className="text-gray-400 flex-shrink-0" />}
              <div>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Deal Terms</p>
                {!isCollapsed('deal') && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    Parsed from {new Set(artistInfo.dealSummary.lines.map(l => l.contract_id)).size} contract{new Set(artistInfo.dealSummary.lines.map(l => l.contract_id)).size === 1 ? '' : 's'} —
                    <Link to={`/artists?artist=${artistInfo.id}`} onClick={e => e.stopPropagation()} className="text-boom-600 hover:text-boom-700 ml-1">view on Contracts</Link>
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-4 text-right flex-shrink-0">
              <div>
                <p className="text-[10px] font-bold text-gray-400 uppercase">Advance</p>
                <p className="text-sm font-bold text-gray-700 tabular-nums">{fmt(artistInfo.dealSummary.totalAdvance || 0, 'USD')}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold text-gray-400 uppercase">Total Deal</p>
                <p className="text-sm font-bold text-gray-900 tabular-nums">{fmt(artistInfo.dealSummary.total || 0, 'USD')}</p>
              </div>
            </div>
          </div>
          {/* Per-line breakdown — collapsed under a small toggle so the
              card stays compact by default. */}
          {!isCollapsed('deal') && (
          <details className="mt-2">
            <summary className="text-[11px] font-semibold text-boom-600 hover:text-boom-700 cursor-pointer">Show contract lines</summary>
            <table className="mt-2 w-full text-xs">
              <thead>
                <tr className="text-left text-gray-400">
                  <th className="py-1 pr-3 font-semibold">Contract</th>
                  <th className="py-1 pr-3 font-semibold">Item</th>
                  <th className="py-1 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody>
                {artistInfo.dealSummary.lines.map((l, i) => (
                  <tr key={i} className="border-t border-gray-50">
                    <td className="py-1.5 pr-3 text-gray-600">{l.contract_type || `Contract #${l.contract_id}`}</td>
                    <td className="py-1.5 pr-3 text-gray-700">{l.label}{l.note ? <span className="text-gray-400"> · {l.note}</span> : null}</td>
                    <td className="py-1.5 text-right tabular-nums font-semibold text-gray-800">{fmt(l.amount || 0, 'USD')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          )}
        </div>
      )}

      {/* ── The one summary line ─────────────────────────────────
          Replaces five stat tiles, a collapsible claim panel, an audit strip and
          an always-open notes textarea — four blocks that between them pushed the
          first artist off the first screen.

          The tiles answered questions this page is not for. "Pending Upload"
          added $2.18M out of four different situations, only $1.17M of which can
          be uploaded today; Paid / Unpaid described cash flow, and an unpaid
          invoice cannot be uploaded at all, so it is not a to-do. So: ONE
          actionable figure, then the three bands that are not actionable yet,
          named as such, then the discrepancy band in red.

          The four figures are one partition of `pendingFiltered`, so they add up
          to it by construction. The DETAIL page keeps the full tile grid — this
          is the index only. */}
      {!isDetail && readyCampaigns.length > 0 && (
        <div data-tour="recoupments-ready" data-recoupments-ready className="card px-4 py-3 border-emerald-200 bg-emerald-50/40">
          <div className="flex items-center justify-between gap-3 mb-2">
            <p className="text-sm font-semibold text-emerald-900 inline-flex items-center gap-1.5"><CheckCircle2 size={15} /> {readyCampaigns.length} song campaign{readyCampaigns.length === 1 ? '' : 's'} ready for recoupment</p>
            <span className="text-[11px] text-emerald-800">Marketing confirmed these done. Upload marks every item UFR; the campaign moves to Uploaded on its own.</span>
          </div>
          <ul className="divide-y divide-emerald-100">
            {readyCampaigns.map((c) => (
              <li key={c.id} className="py-1.5 flex items-center gap-3 text-sm" data-ready-campaign={c.id}>
                <div className="flex-1 min-w-0"><span className="font-semibold text-gray-900">{c.song}</span> <span className="text-gray-500">· {c.artist}</span>{c.confirm_note && <span className="block text-[11px] text-gray-500 truncate">“{c.confirm_note}”</span>}</div>
                <span className="text-xs text-gray-600 tabular-nums">{c.rows} item{c.rows === 1 ? '' : 's'} · {fmtUsdItems([{ amount: c.spent, currency: 'USD' }], fxRates) || '$0'}{c.unpaid ? <span className="text-amber-700"> · {c.unpaid} unpaid</span> : ''}</span>
                <button type="button" disabled={claimBusy || !c.expense_ids?.length} onClick={async () => { await claimForRecoupment(c.expense_ids.map((id) => ({ id }))); loadReady() }} className="btn-primary text-xs py-1 disabled:opacity-40" data-ready-upload={c.id}>Upload all</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!isDetail && (
        <div data-tour="recoupments-summary" className="card px-4 py-3">
          <div className="flex items-baseline gap-x-2.5 gap-y-1 flex-wrap">
            <span className="text-2xl font-bold tabular-nums text-ink">
              {fmtUsdItems(provableUnclaimed, fxRates) || '$0'}
            </span>
            <span className="text-[12.5px] font-bold text-gray-600">ready to upload</span>
            <span className="text-[11.5px] text-gray-400 tabular-nums"
              title="Paid, and a bank statement we have uploaded shows the payment. The claim already has evidence under it.">
              {provableUnclaimed.length} item{provableUnclaimed.length === 1 ? '' : 's'} across{' '}
              {provableByArtist.length} artist{provableByArtist.length === 1 ? '' : 's'} · the bank shows every one
            </span>
            {provableUnclaimed.length > 0 && (
              <button onClick={() => claimForRecoupment(provableUnclaimed)} disabled={claimBusy}
                title="Upload every provable item on the page for recoupment. Today's date becomes the upload date, which is what decides the statement period."
                className="ml-auto shrink-0 inline-flex items-center gap-1.5 bg-ink text-card hover:opacity-85 rounded-lg px-3 py-1.5 text-[12px] font-bold disabled:opacity-40">
                Upload all {provableUnclaimed.length}
              </button>
            )}
          </div>
          {/* Second row: everything that is NOT a to-do, plus the two pointers
              off the page. Kept to one line of 11.5px text — the point of the
              row is that the reader can skip it. */}
          <div className="mt-2 pt-2 border-t border-divider flex items-center gap-x-3 gap-y-1 flex-wrap text-[11.5px] text-gray-500 tabular-nums">
            {pendingBands.awaiting_statement.length > 0 && (
              <span title="Paid, and no uploaded statement covers the payment date yet. Normal for spend paid this month — there is nothing it could have matched.">
                <b className="text-sky-700">{fmtUsdItems(pendingBands.awaiting_statement, fxRates)}</b>{' '}
                awaiting the bank
              </span>
            )}
            {pendingBands.unpaid.length > 0 && (
              <span title="Not paid yet, so nothing has left the bank and there is nothing to recoup. Shown so the figure is accounted for, not because it is actionable.">
                · <b className="text-gray-600">{fmtUsdItems(pendingBands.unpaid, fxRates)}</b> unpaid
              </span>
            )}
            {pendingBands.unverified.length > 0 && (
              <button type="button"
                onClick={() => setFilterUfr(filterUfr === 'No' ? '' : 'No')}
                title="Paid, a statement DOES cover the date, and no line on it matches. The one band that is a discrepancy rather than a queue."
                className="text-left hover:underline">
                · <b className="text-rose-600">{fmtUsdItems(pendingBands.unverified, fxRates)}</b>{' '}
                paid with no bank line
              </button>
            )}
            {ufrUnverifiedFiltered.length > 0 && (
              <button type="button"
                onClick={() => setFilterUfr(filterUfr === 'unverified' ? '' : 'unverified')}
                title={filterUfr === 'unverified'
                  ? 'Currently showing only these — click to clear'
                  : 'Already uploaded for recoupment, and no bank line backs it up. This is the figure being overstated.'}
                className={`text-left ${filterUfr === 'unverified' ? 'underline' : 'hover:underline'}`}>
                · <b className="text-rose-600">{ufrUnverifiedFiltered.length} uploaded with no bank line</b>{' '}
                <span className="text-gray-400">{fmtUsdItems(ufrUnverifiedFiltered, fxRates)}</span>
              </button>
            )}
            <span className="ml-auto flex items-center gap-3 shrink-0">
              {/* Notes — same shared scratchpad, now one click away instead of
                  a permanent 120px block above the queue. */}
              <button type="button" onClick={() => setNotesOpen(v => !v)}
                title="Shared context for the recoupments workflow"
                className={`inline-flex items-center gap-1 font-bold ${
                  indexNote.trim() ? 'text-amber-600 hover:text-amber-700' : 'text-gray-400 hover:text-gray-600'}`}>
                <StickyNote size={11} /> Notes{indexNote.trim() ? ' · 1' : ''}
              </button>
              {/* The audit asks what this page cannot ask about itself. Its two
                  kinds of finding stay separate — money that should be claimed
                  and money that should not have been want opposite actions. */}
              {audit && (
                <Link to="/recoupments/audit" className="inline-flex items-center gap-1 font-bold text-gray-400 hover:text-gray-600">
                  {(audit.advances_items > 0 || audit.partial_families_count > 0
                    || audit.double_claims_groups > 0 || audit.no_document_items > 0
                    || audit.pile_items > 0)
                    ? <>Audit{' '}
                        <span className="font-normal text-gray-400">
                          {fmt((audit.advances_usd || 0) + (audit.partial_families_usd || 0))} unclaimed
                          {(audit.double_claims_groups > 0 || audit.no_document_items > 0) && (
                            <>, <span className="text-rose-700">
                              {fmt((audit.double_claims_usd || 0) + (audit.no_document_usd || 0))} to re-check
                            </span></>
                          )}
                        </span> →</>
                    : <><CheckCircle2 size={11} className="text-emerald-500" /> Audit clear →</>}
                </Link>
              )}
            </span>
          </div>
          {notesOpen && (
            <div className="mt-3 pt-3 border-t border-divider">
              <textarea
                value={indexNote}
                onChange={e => setIndexNote(e.target.value.slice(0, 4000))}
                onBlur={saveIndexNote}
                autoFocus
                placeholder="Shared context for the recoupments workflow — statement blockers, items to chase, decisions the next person should know about."
                rows={3}
                className="w-full text-sm rounded border border-rule bg-transparent px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-500/40 resize-y"
                style={{ fontFamily: 'inherit', lineHeight: 1.5 }}
              />
              <div className="text-[10px] text-gray-400 text-right mt-1">
                {indexNote.length}/4000 · saves on blur{indexNoteSaving ? ' · saving…' : ''}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Stat cards — multi-currency aware. Cards drop to a smaller font
          when the page has mixed currencies so the "$X + €Y" string fits.
          Total / UFR / Pending / Paid / Unpaid always render so cash
          flow status reads alongside the recoupment-workflow status.
          A Remaining vs Deal card slots in on the detail page when the
          artist has a deal on file. */}
      {isDetail && (() => {
        const showDeal = isDetail && artistInfo?.dealSummary?.total > 0
        // Three baseline tiles + Deal. Paid and Unpaid are gone: the bank-state
        // chips under this grid now name all four bands with live counts, and
        // "Paid" is simply the other three added up. Two readouts of the same
        // partition, ten inches apart, is how a page starts disagreeing with
        // itself — and Unpaid was never a to-do here anyway, which is the same
        // reason the index dropped those two tiles a week earlier.
        const cardCount = 3 + (showDeal ? 1 : 0)
        const gridCols = cardCount === 4
          ? 'sm:grid-cols-2 lg:grid-cols-4'
          : 'sm:grid-cols-3'
        const statsCollapsed = isCollapsed('stats')
        return (
      <div>
        {/* Slim toggle bar above the stat grid. When the grid is hidden
            the bar shows the headline total inline so the user doesn't
            lose all signal. Clicking anywhere on the bar toggles. */}
        <div
          onClick={() => toggleCollapsed('stats')}
          className="flex items-center justify-between cursor-pointer text-[10px] font-bold uppercase tracking-wide text-gray-400 hover:text-gray-600 px-1 py-1"
          title={statsCollapsed ? 'Show stat cards' : 'Hide stat cards'}
        >
          <span className="inline-flex items-center gap-1">
            {statsCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
            Stats
            {statsCollapsed && (
              <span className="ml-2 text-gray-500 normal-case font-semibold tabular-nums">
                {fmtUsdItems(filtered, fxRates) || fmtTotals(totalsByCurrency)} · {filtered.length} item{filtered.length === 1 ? '' : 's'}
              </span>
            )}
          </span>
        </div>
        {!statsCollapsed && (() => {
          // USD-equivalent is the headline number — it's the figure that
          // actually matters for recoupment / cash decisions. Native
          // breakdown becomes a small caption, only shown when there's
          // a non-USD currency in the mix (otherwise it duplicates the
          // headline). Per-row locked rates (fx_rate_to_usd) are honored
          // automatically via the items-aware itemsToUsd / fmtUsdItems
          // helpers, so paid invoices stay frozen at their payment-day
          // rate forever.
          const hasNonUsd = (items) => items.some(e => (e?.currency || 'USD').toUpperCase() !== 'USD')
          const StatCard = ({ label, items, tone, button, onClick, active, note }) => {
            const usd = fmtUsdItems(items, fxRates)
            const native = fmtTotals(groupByCurrency(items))
            const showCaption = hasNonUsd(items)
            // Match the Artist Campaigns stat-card visual density: tighter
            // padding (p-3), text-xl headline (was text-2xl), single subtitle
            // line combining native + item count so the card doesn't take
            // three lines when it only needs one.
            const headlineCls = `font-bold ${tone} mt-1 text-xl tabular-nums`
            const itemCount = `${items.length} item${items.length === 1 ? '' : 's'}`
            // The native breakdown moves into the TOOLTIP. It was taking a line on
            // every tile — "$2,098,832.93 + A$145.00 + €20,270.00 + €5,610.00 · 890
            // items" — to describe 1.3% of the money. The USD headline above it was
            // always the number being read.
            const inner = (
              <>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">{label}</p>
                <p className={headlineCls}
                  title={(showCaption && native) ? `${native} — converted at locked or live rates` : undefined}
                >{usd || native || '—'}{showCaption && native && <span className="text-[10px] font-normal text-gray-400 ml-1">≈</span>}</p>
                <p className="text-[10px] text-gray-400 mt-0.5 tabular-nums">{itemCount}</p>
                {note || null}
              </>
            )
            if (button) {
              return (
                <button
                  type="button"
                  onClick={onClick}
                  className={`card p-3 text-left transition-colors ${active ? `ring-2 ${active}` : 'hover:bg-gray-50/40'}`}
                  title={active ? 'Currently filtered — click to clear' : 'Click to filter'}
                >{inner}</button>
              )
            }
            return <div className="card p-3">{inner}</div>
          }
          return (
      <div className={`grid grid-cols-1 ${gridCols} gap-4`}>
        {/* Statement basis. "Recoupable" now means money that LEFT THE BANK:
            proven by a statement, or paid with no statement covering it yet. The
            note under it splits the two, because the second half is a claim the
            bank has not confirmed — and the split is the whole point of the
            change, not a footnote. */}
        {/* The per-band split that used to hang under this figure is gone —
            the bank-state chips below the grid say it with live counts and a
            click that actually filters the list. */}
        <StatCard label="Recoupable · bank basis" items={countedItems} tone="text-gray-900"
          note={(
            <span className="mt-1 block text-[10px] tabular-nums text-left text-gray-400">
              money that left the bank, proven or not yet
            </span>
          )} />
        <StatCard label="Uploaded for Recoupment" items={ufrFiltered} tone="text-emerald-600"
          note={ufrUnverifiedFiltered.length > 0 && (
            // On THIS tile because this is the figure being overstated: the
            // headline claims $X was uploaded for recoupment, and some of it has
            // no bank line behind it. Clicking narrows the page to exactly those.
            <button
              type="button"
              onClick={() => setFilterUfr(filterUfr === 'unverified' ? '' : 'unverified')}
              title={filterUfr === 'unverified'
                ? 'Currently showing only these — click to clear'
                : 'Show only the uploaded items with no matching bank transaction'}
              className={`mt-1 text-[10px] font-bold tabular-nums text-left ${
                filterUfr === 'unverified' ? 'text-rose-700 underline' : 'text-rose-600 hover:underline'}`}
            >
              {ufrUnverifiedFiltered.length} with no bank line · {fmtUsdItems(ufrUnverifiedFiltered, fxRates)}
            </button>
          )} />
        {/* Everything not yet uploaded — which includes unpaid invoices and
            spend the bank has not confirmed. The note is the actionable half: the
            part a statement already proves. */}
        <StatCard label="Pending Upload" items={pendingFiltered} tone="text-amber-600"
          note={provableUnclaimed.length > 0 && (
            // Detail-page only, so `filtered` is already this one artist —
            // the click uploads their provable items rather than opening a
            // panel (the index's claim panel is gone; its job moved into the
            // summary line and the per-artist Upload button in the queue).
            <button type="button" onClick={() => claimForRecoupment(provableUnclaimed)} disabled={claimBusy}
              title="These have a bank statement behind them and have never been uploaded for recoupment — the claim is already provable. Click to upload all of them."
              className="mt-1 block text-[10px] font-bold tabular-nums text-left text-emerald-700 hover:underline disabled:opacity-40">
              Upload {provableUnclaimed.length} provable now · {fmtUsdItems(provableUnclaimed, fxRates)} →
            </button>
          )} />
        {/* Remaining vs Deal — only when we have a deal AND we're on the
            detail page. Compares total spent (USD-equivalent across all
            currencies) against the deal's total. Green if there's still
            room before the artist is recouped, red if overspent. */}
        {isDetail && artistInfo?.dealSummary?.total > 0 && (() => {
          // Remaining-vs-Deal honors locked rates too — spentUsd sums
          // each row's USD value (locked or live as appropriate).
          const spentUsd = itemsToUsd(filtered, fxRates) ?? 0
          const remaining = (artistInfo.dealSummary.total || 0) - spentUsd
          const recouped = remaining <= 0
          return (
            <div className="card p-3">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Remaining vs Deal</p>
              <p className={`text-xl font-bold mt-1 tabular-nums ${recouped ? 'text-red-600' : 'text-emerald-600'}`}>
                {fmt(remaining, 'USD')}
              </p>
              <p className="text-[10px] text-gray-400 mt-0.5">
                {recouped ? 'Recouped + over by ' : 'Capacity left of '}
                {fmt(artistInfo.dealSummary.total, 'USD')}
              </p>
            </div>
          )
        })()}
      </div>
          )
        })()}
      </div>
        )
      })()}

      {/* Filters — collapsible header bar above the row. When hidden,
          only the slim bar remains so the user can reach search etc.
          quickly without scrolling. */}
      <div data-tour="recoupments-filters">
        <div
          onClick={() => toggleCollapsed('filters')}
          className="flex items-center justify-between cursor-pointer text-[10px] font-bold uppercase tracking-wide text-gray-400 hover:text-gray-600 px-1 py-1"
          title={isCollapsed('filters') ? 'Show filters' : 'Hide filters'}
        >
          <span className="inline-flex items-center gap-1">
            {isCollapsed('filters') ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
            Filters
            {isCollapsed('filters') && (search || filterArtist || filterUfr || filterLabel || filterPayment || filterRecoupable !== 'Yes') && (
              <span className="ml-2 text-gray-500 normal-case font-semibold">Active</span>
            )}
          </span>
        </div>
        {!isCollapsed('filters') && (
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text" placeholder="Search payee, artist, song..."
            value={search} onChange={e => setSearch(e.target.value)}
            className="w-full pl-8 pr-8 py-2 text-sm border border-rule rounded-lg focus:outline-none focus:ring-2 focus:ring-boom-400 bg-card"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
              <X size={13} />
            </button>
          )}
        </div>
        {/* Artist dropdown only on the index view — the detail page is
            already focused on one artist via the URL. */}
        {!isDetail && (
          <select value={filterArtist} onChange={e => setFilterArtist(e.target.value)}
            className="px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400">
            <option value="">All Artists</option>
            {allArtists.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
        {/* Card ordering — priority artists stay pinned in both modes. */}
        {!isDetail && (
          <select value={indexSort} onChange={e => setIndexSort(e.target.value)}
            className="px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
            title="Order the artist cards">
            <option value="provable">Sort: Most ready to upload ($)</option>
            <option value="provable_count">Sort: Most ready to upload (items)</option>
            <option value="unverified">Sort: Most unverified</option>
            <option value="total">Sort: Highest lifetime total</option>
          </select>
        )}
        {/* Ready-for-planning filter — reads the artist_meta marker set
            via the clipboard toggle on each card. */}
        {!isDetail && anyReadyForPlanning && (
          <select value={filterReady} onChange={e => setFilterReady(e.target.value)}
            className="px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
            title="Filter artists by their ready-for-planning marker">
            <option value="">Planning: All</option>
            <option value="yes">Ready for planning</option>
            <option value="no">Not ready</option>
          </select>
        )}
        <select value={filterRecoupable} onChange={e => setFilterRecoupable(e.target.value)}
          className="px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
          title="Switch to 'Not Recoupable' or 'All' to promote items back into the recoupable set.">
          <option value="Yes">Recoupable</option>
          <option value="No">Not Recoupable</option>
          <option value="">All</option>
        </select>
        <select value={filterUfr} onChange={e => setFilterUfr(e.target.value)}
          className="px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400">
          <option value="">All UFR Status</option>
          <option value="Yes">Uploaded</option>
          <option value="No">Not Uploaded</option>
          <option value="unverified">Uploaded, no bank match</option>
        </select>
        <select value={filterPayment} onChange={e => setFilterPayment(e.target.value)}
          className="px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
          title="Filter by payment status">
          <option value="">All Payments</option>
          <option value="Paid">Paid</option>
          <option value="Unpaid">Unpaid</option>
        </select>
        <select value={filterLabel} onChange={e => setFilterLabel(e.target.value)}
          className="px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
          title="Filter by recoupment label (the batch you uploaded items under)">
          <option value="">All Labels</option>
          <option value="__none__">— (no label)</option>
          {existingLabels.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        {isDetail && (
          <select value={groupBy} onChange={e => setGroupBy(e.target.value)}
            className="px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
            title="Group items by song or by spend category">
            <option value="song">Group by Song</option>
            <option value="category">Group by Category</option>
          </select>
        )}
        {(search || filterArtist || filterUfr || filterLabel || filterPayment || filterRecoupable !== 'Yes') && (
          <button onClick={() => { setSearch(''); setFilterArtist(''); setFilterUfr(''); setFilterLabel(''); setFilterPayment(''); setFilterRecoupable('Yes') }}
            className="px-3 py-2 text-xs font-semibold text-gray-500 hover:text-gray-700 border border-rule rounded-lg hover:bg-gray-50">
            Clear
          </button>
        )}
        {/* Select-all toggle for every visible item. Detail page only —
            the index page has artist cards, not selectable rows. Label
            flips between Select / Deselect based on whether everything
            visible is already selected. */}
        {isDetail && statementFiltered.length > 0 && (() => {
          const allIds = statementFiltered.map(e => e.id)
          const allSelected = allIds.every(id => selectedIds.has(id))
          return (
            <button
              onClick={selectAllVisible}
              className={`ml-auto px-3 py-2 text-xs font-semibold border rounded-lg transition-colors ${
                allSelected
                  ? 'text-boom-700 border-boom-300 bg-boom-50 hover:bg-boom-100'
                  : 'text-gray-600 border-rule hover:border-gray-300 hover:bg-gray-50'
              }`}
              title={allSelected
                ? 'Deselect every visible item'
                : `Select every visible item on this tab (${statementFiltered.length}) — bulk-label, mark UFR, or delete from the action bar`}
            >
              {allSelected
                ? `Deselect all (${statementFiltered.length})`
                : `Select all (${statementFiltered.length})`}
            </button>
          )
        })()}
      </div>
        )}
      </div>

      {/* ── INDEX view: the upload queue ────────────────────────────────────
          Was a 2-up grid of 152 cards, each carrying three progress bars, a
          four-part caption, two chips, a cobrand pill and five hover buttons —
          and leading with the artist's LIFETIME recoupable total, a number that
          does not move as the agent works and is therefore not a to-do.

          It also could not triage: ALL 152 artists have something pending, so
          "who needs costs uploaded" answered "everyone". What separates them is
          whether the bank can already prove it — 107 artists can upload
          something today, 30 are waiting on a statement, 15 have nothing but
          unpaid invoices. And the work is concentrated: the top 10 artists hold
          60% of the provable dollars, the top 20 hold 74%.

          So: one row per artist, ranked by provable dollars, leading with what
          to upload and how much, with the two non-actionable partitions folded
          away at the bottom. Every column reduces over the `*UnclaimedItems`
          lists built in computeGrouped, which is also what the ranking sorts on
          — a row cannot show a figure the sort disagrees with. */}
      {!isDetail && (
        grouped.length === 0 ? (
          <EmptyState
            title="Nothing recoupable yet"
            body="Recoupable spend appears here once an invoice is approved with an artist on it. Each artist becomes a row you can upload for recoupment."
            source={{ label: 'Approvals', to: '/bk/approvals' }}
          />
        ) : (() => {
          // ── Dismissal partition + sort ──────────────────────────────────
          // Priority is a tag (chips + subtabs), never a rank — rows sort
          // purely by the selected mode. Dismissed artists drop into a
          // collapsible section at the bottom so the team can keep them on
          // file without cluttering the live workflow.
          const metaFor = (a) => artistMeta[(a.artist || '').toLowerCase().trim()] || {}
          let active      = grouped.filter(a => !metaFor(a).dismissed)
          const dismissed = grouped.filter(a =>  metaFor(a).dismissed)
          // Only while the control that sets it is on screen. Gating the
          // dropdown on `anyReadyForPlanning` without gating the filter would
          // let a stale 'yes' keep hiding every artist with nothing visible to
          // clear it — the marker can go to zero while the filter is still set.
          if (anyReadyForPlanning && filterReady === 'yes') active = active.filter(a => !!metaFor(a).ready_for_planning)
          if (anyReadyForPlanning && filterReady === 'no')  active = active.filter(a => !metaFor(a).ready_for_planning)
          // Priority subtab counts BEFORE the tab filter so every tab
          // shows how many artists live behind it.
          const priCounts = { all: active.length, high: 0, medium: 0, low: 0, none: 0 }
          for (const a of active) {
            const p = metaFor(a).priority
            priCounts[p === 'high' ? 'high' : p === 'medium' ? 'medium' : p === 'low' ? 'low' : 'none']++
          }
          if (priorityTab !== 'all') {
            active = active.filter(a => {
              const p = metaFor(a).priority
              return priorityTab === 'none' ? !p : p === priorityTab
            })
          }

          const usdOf = (items) => itemsToUsd(items || [], fxRates) || 0
          // Priority is a TAG, not a rank — it never reorders the rows (the
          // subtabs + rails carry it). Every mode falls through to provable
          // dollars then lifetime total, so the two folded-away partitions
          // (where the selected key is zero for everyone) still come out in a
          // stable, meaningful order rather than insertion order.
          const cmp = (a, b) => {
            if (indexSort === 'provable_count') {
              const d = (b.provableUnclaimedItems?.length || 0) - (a.provableUnclaimedItems?.length || 0)
              if (d) return d
            }
            if (indexSort === 'unverified') {
              // Money the bank does not confirm — concentrated on a handful of
              // artists, which is why it is no longer the default: it ranked the
              // exceptions above the work.
              const d = usdOf(b.ufrUnverifiedItems) + usdOf(b.unverifiedUnclaimedItems)
                      - usdOf(a.ufrUnverifiedItems) - usdOf(a.unverifiedUnclaimedItems)
              if (d) return d
            }
            const dp = usdOf(b.provableUnclaimedItems) - usdOf(a.provableUnclaimedItems)
            if (dp && indexSort !== 'total') return dp
            const da = usdOf(b.awaitingUnclaimedItems) - usdOf(a.awaitingUnclaimedItems)
            if (da && indexSort !== 'total') return da
            return (b.total || 0) - (a.total || 0)
          }

          // ── Three partitions, by what can be DONE ─────────────────────────
          // The test is the same `provableUnclaimedItems` list the Ready column
          // shows and the ranking sorts on, so a row can never sit in "nothing
          // provable" while displaying a provable figure.
          const canUpload = (a) => (a.provableUnclaimedItems?.length || 0) > 0
          const isWaiting = (a) => !canUpload(a)
            && ((a.awaitingUnclaimedItems?.length || 0) > 0 || (a.unverifiedUnclaimedItems?.length || 0) > 0)
          const readyArtists   = active.filter(canUpload).sort(cmp)
          const waitingArtists = active.filter(isWaiting).sort(cmp)
          const clearArtists   = active.filter(a => !canUpload(a) && !isWaiting(a))
            .sort((a, b) => (a.artist || '').localeCompare(b.artist || ''))
          // Cross-cutting, not a partition: these artists also appear in one of
          // the three above. Uploaded with nothing on a statement behind it is
          // the only band that is an ERROR rather than a queue position, and it
          // is small enough (9 artists / 43 items) to name every one.
          const noBankLine = active.filter(a => (a.ufrUnverifiedItems?.length || 0) > 0)
            .sort((a, b) => usdOf(b.ufrUnverifiedItems) - usdOf(a.ufrUnverifiedItems))
          dismissed.sort((a, b) => (a.artist || '').localeCompare(b.artist || ''))

          // Priority rail colors. The chip row is gone from the row body — the
          // 2px left rail carries priority now, and the H/M/L buttons that set
          // it live in the hover cluster.
          const PRIORITY_STYLE = {
            high:   { rail: 'border-l-rose-500',  chip: 'bg-rose-100 text-rose-700',   label: 'High'   },
            medium: { rail: 'border-l-amber-400', chip: 'bg-amber-100 text-amber-700', label: 'Medium' },
            low:    { rail: 'border-l-sky-400',   chip: 'bg-sky-100 text-sky-700',     label: 'Low'    },
          }

          // ONE grid template for the header strip and every row, so a column
          // label can never drift off the figures underneath it.
          const COLS = 'grid items-center gap-x-3 grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_6rem_4.5rem_6.5rem_7rem]'
          // Whole dollars in the columns so they stay scannable at a glance;
          // each figure is rounded ONCE from its own unrounded sum (never a
          // total of rounded parts), and the exact cents ride in the tooltip.
          const money0 = (items) => new Intl.NumberFormat('en-US', {
            style: 'currency', currency: 'USD', maximumFractionDigits: 0,
          }).format(Math.round(usdOf(items)))

          const renderRow = (artist, { isDismissedRow } = {}) => {
            const name     = artist.artist || 'Unassigned'
            const meta     = metaFor(artist)
            const pri      = meta.priority
            const priStyle = pri ? PRIORITY_STYLE[pri] : null
            const ready    = artist.provableUnclaimedItems || []
            const awaiting = artist.awaitingUnclaimedItems || []
            const unpaid   = artist.unpaidUnclaimedItems || []
            const unproven = artist.unverifiedUnclaimedItems || []
            const noLine   = artist.ufrUnverifiedItems || []
            const upPct    = artist.paidItemCount ? (artist.paidUfrCount / artist.paidItemCount * 100) : 0
            return (
              <div key={name}
                className={`group relative border-l-2 ${priStyle ? priStyle.rail : 'border-l-transparent'} ${
                  isDismissedRow ? 'opacity-60' : ''} hover:bg-gray-50/60 transition-colors`}
              >
                {/* The row background IS the link. It sits UNDER the content
                    (z-0) and the content layer is pointer-events-none, so a
                    click anywhere that isn't a control navigates — while every
                    button lives outside the Link's DOM tree entirely. Inside a
                    Link, react-router intercepts the synthetic click before the
                    bubble path is honored, so stopPropagation on a nested
                    button is not enough; that bug is why the old card's action
                    overlay was a sibling too. */}
                <Link to={`/recoupments/${encodeURIComponent(name)}`}
                  aria-label={`Open ${name}`} className="absolute inset-0 z-0" />
                <div className={`relative z-10 pointer-events-none ${COLS} px-3 py-2`}>
                  {/* Artist. The two status chips became icons and the cobrand
                      pill became a tooltip — on 152 rows they were four widths
                      of colored text competing with the figures that rank the
                      list. */}
                  <div className="min-w-0 flex items-center gap-1.5">
                    <span className={`truncate text-[13px] font-bold transition-colors ${
                      artist.artist ? 'text-ink group-hover:text-boom-700' : 'text-gray-400 italic'}`}>
                      {name}
                    </span>
                    {meta.complete && (
                      <span className="shrink-0 pointer-events-auto leading-none"
                        title={`Marked complete on Artist Campaigns${meta.complete_by_name ? ` by ${meta.complete_by_name}` : ''}`}>
                        <CheckCircle2 size={11} className="text-emerald-500" />
                      </span>
                    )}
                    {meta.ready_for_planning && (
                      <span className="shrink-0 pointer-events-auto leading-none"
                        title={`Ready for planning${meta.ready_for_planning_by_name ? ` — marked by ${meta.ready_for_planning_by_name}` : ''}`}>
                        <FolderOpen size={11} className="text-sky-500" />
                      </span>
                    )}
                    {artist.cobrandCount > 0 && (
                      <span className="shrink-0 pointer-events-auto leading-none"
                        title={`${artist.cobrandCount} cobrand item${artist.cobrandCount === 1 ? '' : 's'} — ${fmtTotalsCompact(artist.cobrandTotalByCurrency).text}`}>
                        <Sparkles size={11} className="text-purple-400" />
                      </span>
                    )}
                    {priStyle && (
                      <span className={`shrink-0 px-1 rounded text-[9px] font-bold uppercase tracking-wider ${priStyle.chip}`}>
                        {priStyle.label}
                      </span>
                    )}
                    <span className="shrink-0 text-[10.5px] text-gray-400 tabular-nums pointer-events-auto"
                      title={`${artist.itemCount} recoupable item${artist.itemCount === 1 ? '' : 's'} across ${artist.groups.length} group${artist.groups.length === 1 ? '' : 's'} — ${fmtUsdItems(artist.allItems, fxRates)} lifetime`}>
                      {artist.itemCount}
                    </span>
                  </div>

                  {/* READY TO UPLOAD — the reason this page exists, so it leads
                      and it is the only ink-weight figure on the row. */}
                  <div className="hidden md:block text-right pointer-events-auto"
                    title={ready.length
                      ? `${ready.length} item${ready.length === 1 ? '' : 's'} · ${fmtUsdItems(ready, fxRates)} — paid, and a statement we already hold shows every one. Provable to a partner today.`
                      : 'Nothing provable to upload right now'}>
                    {ready.length > 0 ? (
                      <>
                        <span className="text-[13px] font-bold tabular-nums text-ink">{money0(ready)}</span>
                        <span className="ml-1.5 text-[10.5px] tabular-nums text-gray-400">{ready.length}</span>
                      </>
                    ) : <span className="text-[11px] text-gray-300">—</span>}
                  </div>

                  {/* AWAITING BANK — paid, no statement covers the date yet.
                      Not a problem and not actionable; the unpaid and the
                      paid-with-no-line figures ride in the tooltip because
                      neither can be uploaded either. */}
                  <div className="hidden md:block text-right pointer-events-auto"
                    title={[
                      awaiting.length ? `${awaiting.length} paid · ${fmtUsdItems(awaiting, fxRates)} — no uploaded statement covers the payment date yet` : null,
                      unpaid.length   ? `${unpaid.length} unpaid · ${fmtUsdItems(unpaid, fxRates)} — nothing has left the bank` : null,
                      unproven.length ? `${unproven.length} paid with no bank line · ${fmtUsdItems(unproven, fxRates)} — a statement covers the date and nothing on it matches` : null,
                    ].filter(Boolean).join('\n') || 'Nothing else pending'}>
                    {awaiting.length > 0
                      ? <>
                          <span className="text-[12px] font-semibold tabular-nums text-sky-700">{money0(awaiting)}</span>
                          <span className="ml-1.5 text-[10.5px] tabular-nums text-gray-400">{awaiting.length}</span>
                        </>
                      : unpaid.length > 0
                        ? <span className="text-[11px] tabular-nums text-gray-400">{money0(unpaid)} unpaid</span>
                        : <span className="text-[11px] text-gray-300">—</span>}
                  </div>

                  {/* UPLOADED — count-based progress over PAID items only. The
                      dollar-weighted twin bar is gone: two bars measuring the
                      same thing on 152 rows, and the columns now carry the
                      dollars. Denominator is paid items because an unpaid
                      invoice cannot be uploaded, so counting it would put 100%
                      permanently out of reach. */}
                  <div className="hidden md:flex items-center gap-1.5 pointer-events-auto"
                    title={`${artist.paidUfrCount} of ${artist.paidItemCount} PAID item${artist.paidItemCount === 1 ? '' : 's'} uploaded for recoupment — ${fmtUsdItems(artist.paidUfrItems, fxRates)} of ${fmtUsdItems(artist.paidItems, fxRates)}. Unpaid invoices are excluded: they cannot be uploaded.`}>
                    <div className="flex-1 h-1 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${upPct}%` }} />
                    </div>
                    <span className="text-[10px] text-gray-400 tabular-nums shrink-0">
                      {artist.paidUfrCount}/{artist.paidItemCount}
                    </span>
                  </div>

                  {/* FLAG — uploaded, and nothing on a statement backs it up.
                      The one band that is an error rather than a queue
                      position, so it is the only red on the row. */}
                  <div className="hidden md:block text-right pointer-events-auto">
                    {noLine.length > 0 && (
                      <button type="button"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setFilterUfr('unverified'); setFilterArtist(artist.artist || '') }}
                        title={`${noLine.length} item${noLine.length === 1 ? '' : 's'} uploaded for recoupment with no matching transaction on the statement covering the payment date — ${fmtUsdItems(noLine, fxRates)}. Click to show only these.`}
                        className="inline-flex items-center gap-0.5 text-[10.5px] font-bold text-rose-600 tabular-nums hover:underline">
                        <AlertTriangle size={10} /> {noLine.length}
                      </button>
                    )}
                  </div>

                  {/* Upload. Same `claimForRecoupment` the summary line calls —
                      one writer, one confirm, one undo path. */}
                  <div className="hidden md:block text-right pointer-events-auto">
                    {ready.length > 0 && !isDismissedRow && (
                      <button type="button"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); claimForRecoupment(ready) }}
                        disabled={claimBusy}
                        title={`Upload all ${ready.length} provable item${ready.length === 1 ? '' : 's'} for ${name} — ${fmtUsdItems(ready, fxRates)}`}
                        className="w-full bg-ink text-card hover:opacity-85 rounded-md px-2 py-1 text-[11px] font-bold disabled:opacity-40">
                        Upload {ready.length}
                      </button>
                    )}
                  </div>

                  {/* Per-artist controls. Hidden until the row is hovered or
                      something inside it takes focus, but the column keeps its
                      width at all times so the figures never shift under the
                      cursor. */}
                  <div className="flex items-center justify-end gap-1 pointer-events-auto opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    {!isDismissedRow && (
                      <button type="button"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setArtistReady(artist.artist, !meta.ready_for_planning) }}
                        className={`w-6 h-6 rounded border flex items-center justify-center transition-colors ${
                          meta.ready_for_planning
                            ? 'bg-sky-100 text-sky-700 border-sky-200'
                            : 'bg-card text-gray-400 border-gray-200 hover:text-sky-600 hover:bg-sky-50'}`}
                        title={meta.ready_for_planning
                          ? 'Ready for planning — click to unmark'
                          : 'Mark this artist as ready for planning'}>
                        <FolderOpen size={11} />
                      </button>
                    )}
                    {!isDismissedRow && (
                      <div className="flex items-center rounded border border-gray-200 bg-card"
                        title="Set priority — H high, M medium, L low. Click an active level to clear.">
                        {[
                          { value: 'high',   label: 'H', active: 'bg-rose-100 text-rose-700',   hover: 'hover:text-rose-700 hover:bg-rose-50' },
                          { value: 'medium', label: 'M', active: 'bg-amber-100 text-amber-700', hover: 'hover:text-amber-700 hover:bg-amber-50' },
                          { value: 'low',    label: 'L', active: 'bg-sky-100 text-sky-700',     hover: 'hover:text-sky-700 hover:bg-sky-50' },
                        ].map(p => {
                          const isActive = pri === p.value
                          return (
                            <button key={p.value} type="button"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setArtistPriority(artist.artist, isActive ? null : p.value) }}
                              className={`text-[10px] font-bold w-5 h-6 flex items-center justify-center transition-colors ${
                                isActive ? p.active : `text-gray-400 ${p.hover}`}`}
                              title={isActive ? `Clear ${p.value} priority` : `Set ${p.value} priority`}>
                              {p.label}
                            </button>
                          )
                        })}
                      </div>
                    )}
                    <button type="button"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleArtistDismissed(artist.artist, !isDismissedRow) }}
                      className={`rounded flex items-center justify-center ${
                        isDismissedRow
                          ? 'text-emerald-700 hover:bg-emerald-50 text-[10px] font-bold uppercase tracking-wider px-1.5 h-6'
                          : 'w-6 h-6 text-gray-400 hover:text-rose-600 hover:bg-rose-50'}`}
                      title={isDismissedRow ? 'Restore to active recoupment' : 'Dismiss from recoupment — moves to the bottom of the page'}>
                      {isDismissedRow ? 'Restore' : <X size={11} />}
                    </button>
                  </div>
                </div>
              </div>
            )
          }

          // Column labels. Same COLS template as the rows, and only rendered
          // over the main queue — the folded sections inherit the reading.
          const headerStrip = (
            <div className={`${COLS} px-3 pb-1.5 text-[9px] font-bold uppercase tracking-wider text-gray-400`}>
              <div>Artist</div>
              <div className="hidden md:block text-right">Ready to upload</div>
              <div className="hidden md:block text-right">Awaiting bank</div>
              <div className="hidden md:block">Uploaded</div>
              <div className="hidden md:block" />
              <div className="hidden md:block" />
              <div />
            </div>
          )

          // A folded partition. Same rows, same columns — the only difference
          // is that it starts CLOSED, because nothing in it can be uploaded.
          //
          // Default-closed is not something the `collapsed` set can express:
          // absence of a key means expanded, so a section the user has never
          // touched renders open — which is how all three of these shipped
          // open on the first run of the harness, putting 45 artists nobody
          // can act on back above the fold. So these persist an OPEN marker
          // instead, under a prefixed key: presence means the user opened it,
          // absence means folded. Same Set, same localStorage, inverted sense —
          // and the prefix keeps it from ever colliding with a real
          // collapsed-key (the group / bucket / label keys all carry their own).
          const isOpen     = (key) => isCollapsed(`open:${key}`)
          const toggleOpen = (key) => toggleCollapsed(`open:${key}`)
          const foldedSection = (key, title, hint, rows, tone = 'text-gray-400') => {
            if (rows.length === 0) return null
            const shut = !isOpen(key)
            return (
              <div className="mt-4">
                <button type="button" onClick={() => toggleOpen(key)}
                  className="w-full flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider px-1 py-2 border-t border-divider hover:text-gray-600"
                  title={shut ? `Show ${title.toLowerCase()}` : `Hide ${title.toLowerCase()}`}>
                  {shut ? <ChevronRight size={12} className="text-gray-400" /> : <ChevronDown size={12} className="text-gray-400" />}
                  <span className={tone}>{title}</span>
                  <span className="text-gray-300 font-semibold normal-case tabular-nums">
                    · {rows.length} artist{rows.length === 1 ? '' : 's'}
                  </span>
                  <span className="ml-auto text-[10.5px] font-normal normal-case text-gray-400 tracking-normal hidden sm:inline">
                    {hint}
                  </span>
                </button>
                {!shut && (
                  <div className="card divide-y divide-divider overflow-hidden mt-1">
                    {rows.map(a => renderRow(a))}
                  </div>
                )}
              </div>
            )
          }

          const dismissedCollapsed = isCollapsed('dismissed_section')
          return (
            <>
              {/* Priority subtabs — segment the rows by their H/M/L band.
                  Rendered only when a priority has actually been SET on someone:
                  all 152 artists were unset, so the row read "High 0 · Medium 0 ·
                  Low 0 · No priority 152" and cost a line to say nothing. The
                  per-row H/M/L buttons are untouched, so the moment one is used
                  the tabs come back. */}
              {(priCounts.high + priCounts.medium + priCounts.low) > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                {[
                  { id: 'all',    label: 'All',         active: 'bg-gray-900 text-white' },
                  { id: 'high',   label: 'High',        active: 'bg-rose-600 text-white' },
                  { id: 'medium', label: 'Medium',      active: 'bg-amber-500 text-white' },
                  { id: 'low',    label: 'Low',         active: 'bg-sky-500 text-white' },
                  { id: 'none',   label: 'No priority', active: 'bg-gray-500 text-white' },
                ].map(t => (
                  <button
                    key={t.id}
                    onClick={() => setPriorityTab(t.id)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                      priorityTab === t.id
                        ? `${t.active} border-transparent`
                        : 'bg-card text-gray-600 border-rule hover:border-gray-300'
                    }`}
                  >
                    {t.label}
                    <span className={`text-[10px] font-black tabular-nums ${priorityTab === t.id ? 'text-white/70' : 'text-gray-400'}`}>
                      {priCounts[t.id]}
                    </span>
                  </button>
                ))}
              </div>
              )}
              {active.length === 0 ? (
                <div className="card p-10 text-center">
                  <p className="text-sm text-gray-400">No artists in this priority band{filterReady ? ' with the current Planning filter' : ''}.</p>
                </div>
              ) : (
                <>
                  {/* The queue proper. Only artists with something the bank can
                      already prove — everyone else is folded below, because a
                      row you cannot act on is the thing that made 152 cards
                      unrankable in the first place. */}
                  {readyArtists.length > 0 ? (
                    <div>
                      <div className="flex items-baseline gap-2 px-1 pb-1">
                        <h3 className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Ready to upload</h3>
                        <span className="text-[10.5px] text-gray-400 tabular-nums">
                          {readyArtists.length} artist{readyArtists.length === 1 ? '' : 's'} ·{' '}
                          {fmtUsdItems(readyArtists.flatMap(a => a.provableUnclaimedItems), fxRates)}
                        </span>
                      </div>
                      {headerStrip}
                      <div className="card divide-y divide-divider overflow-hidden">
                        {readyArtists.map(a => renderRow(a))}
                      </div>
                    </div>
                  ) : (
                    <div className="card p-10 text-center">
                      <CheckCircle2 size={18} className="mx-auto text-emerald-500 mb-2" />
                      <p className="text-sm text-gray-500">Nothing provable is waiting to be uploaded.</p>
                      <p className="text-[11.5px] text-gray-400 mt-1">
                        Everything the bank can prove has been claimed. The folded sections below are waiting on statements or on payment.
                      </p>
                    </div>
                  )}

                  {/* Uploaded with no bank line. Cross-cutting — these artists
                      also appear above — and an ERROR rather than a queue
                      position, which is why it gets its own named list instead
                      of a red fragment on each row. */}
                  {foldedSection(
                    'queue_no_bank_line',
                    'Uploaded with no bank line',
                    `${noBankLine.reduce((n, a) => n + a.ufrUnverifiedItems.length, 0)} items · ${fmtUsdItems(noBankLine.flatMap(a => a.ufrUnverifiedItems), fxRates)} claimed with nothing on a statement behind it`,
                    noBankLine,
                    'text-rose-600',
                  )}
                  {foldedSection(
                    'queue_waiting',
                    'Nothing provable yet',
                    `${fmtUsdItems(waitingArtists.flatMap(a => [...a.awaitingUnclaimedItems, ...a.unverifiedUnclaimedItems]), fxRates)} paid, waiting on the statement that proves it`,
                    waitingArtists,
                  )}
                  {foldedSection(
                    'queue_clear',
                    'Nothing to do',
                    'every provable cost is uploaded — what is left is unpaid, so it cannot be recouped yet',
                    clearArtists,
                  )}
                </>
              )}
              {dismissed.length > 0 && (
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => toggleCollapsed('dismissed_section')}
                    className="w-full flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-gray-400 hover:text-gray-600 px-1 py-2 border-t border-divider"
                    title={dismissedCollapsed ? 'Show dismissed artists' : 'Hide dismissed artists'}
                  >
                    {dismissedCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    Dismissed
                    <span className="text-gray-300 font-semibold normal-case">· {dismissed.length} artist{dismissed.length === 1 ? '' : 's'}</span>
                  </button>
                  {!dismissedCollapsed && (
                    <div className="card divide-y divide-divider overflow-hidden mt-1">
                      {dismissed.map(a => renderRow(a, { isDismissedRow: true }))}
                    </div>
                  )}
                </div>
              )}
            </>
          )
        })()
      )}

      {/* ── DETAIL view: one grouping level ─────────────────────────────────
          Song groups, and nothing nested inside them. See the `filterState`
          block above computeGrouped for the measurement that removed the other
          three levels; in short, 1,530 headers were wrapping 1,209 rows and two
          of the four levels were restating a chip the row already carried.

          What the state sections DID carry is the priority order and the
          per-row state, and both are kept: rows sort unverified-first inside a
          group (`byStateThenAmount`), and each row gets a 2px state rail. The
          rail is the bank's opinion, the emerald wash and the UFR badge are
          ours — the same split the page states elsewhere as "the stamp says we
          CLAIMED this money; the dot says whether the BANK can prove it". */}
      {isDetail && (
        <div className="space-y-3">
          {/* One bar for both filters. The statement period is a SLICE of the
              artist's rows and the bank state is a band within it, so they read
              left-to-right as period → state, with the grouping axis parked on
              the right. It replaces a full-width tab card: 130 of 146 artists
              have no UFR'd month at all, so for them that card held Pending /
              Uploaded / Total — three filters of one list — and nothing else. */}
          <div className="card px-3 py-2 flex items-center gap-x-2 gap-y-2 flex-wrap">
            <span className="text-[9px] font-bold uppercase tracking-wider text-gray-400 mr-0.5">Period</span>
            {(() => {
              const periods = [
                { key: 'pending',  label: 'Pending',  count: pendingCount,    on: 'bg-amber-100 text-amber-800',
                  tip: 'Items not yet uploaded for recoupment.' },
                { key: 'uploaded', label: 'Uploaded', count: uploadedCount,   on: 'bg-emerald-100 text-emerald-800',
                  tip: 'Every item already uploaded for recoupment, across all statement months.' },
                { key: 'all',      label: 'All',      count: filtered.length, on: 'bg-gray-800 text-white',
                  tip: 'Every item on this artist that matches the current filters — no statement-date slice.' },
                ...availableStatements.map(s => ({
                  key: s.ym, label: s.label, count: s.count, on: 'bg-gray-700 text-white',
                  tip: `${s.label} statement — covers uploads ${s.window} (released on the 20th).`,
                })),
              ]
              return periods.map(p => {
                const active = statement === p.key
                return (
                  <button key={p.key} type="button" onClick={() => setStatement(p.key)} title={p.tip}
                    className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-bold transition-colors ${
                      active ? p.on : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100'}`}>
                    {p.label}
                    <span className={`tabular-nums text-[10px] ${active ? 'opacity-70' : 'text-gray-400'}`}>{p.count}</span>
                  </button>
                )
              })
            })()}

            <span className="w-px h-4 bg-divider mx-1" />
            <span className="text-[9px] font-bold uppercase tracking-wider text-gray-400 mr-0.5">Bank</span>
            {(() => {
              // The same four `recoupState` bands the index queue partitions on,
              // in the same priority order — the discrepancy first, then the
              // provable money. A band with nothing in it renders no chip: an
              // artist usually sits in one or two of the four, and four chips
              // reading 0 is the stacked-empty-sections problem in miniature.
              const bands = [
                { key: '',                   label: 'All',        count: statementFiltered.length, dot: null,
                  tip: 'Every band.' },
                { key: 'unverified',         label: 'Unverified', count: stateCounts.unverified, dot: 'bg-rose-500',
                  tip: 'Paid, a statement covering the payment date exists, and nothing on it matches. The only one of the four that is a discrepancy.' },
                { key: 'verified',           label: 'Verified',   count: stateCounts.verified, dot: 'bg-emerald-500',
                  tip: 'A bank statement shows the payment. Provable to a partner.' },
                { key: 'awaiting_statement', label: 'Awaiting',   count: stateCounts.awaiting_statement, dot: 'bg-sky-400',
                  tip: 'Paid, and no uploaded statement covers the date yet — nothing to check it against. Normal, not a problem.' },
                { key: 'unpaid',             label: 'Unpaid',     count: stateCounts.unpaid, dot: 'bg-gray-400',
                  tip: 'Approved but not yet paid. Recoupable once payment clears.' },
              ]
              return bands.filter(b => b.key === '' || b.count > 0).map(b => {
                const active = filterState === b.key
                return (
                  <button key={b.key || 'all'} type="button"
                    onClick={() => setFilterState(active && b.key ? '' : b.key)} title={b.tip}
                    className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-bold transition-colors ${
                      active ? 'bg-ink text-card' : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100'}`}>
                    {b.dot && <span className={`w-1.5 h-1.5 rounded-full ${b.dot}`} />}
                    {b.label}
                    <span className={`tabular-nums text-[10px] ${active ? 'opacity-70' : 'text-gray-400'}`}>{b.count}</span>
                  </button>
                )
              })
            })()}

            <span className="ml-auto flex items-center gap-2 shrink-0">
              <select value={groupBy} onChange={e => setGroupBy(e.target.value)}
                className="px-2 py-1 text-[11px] font-bold border border-rule rounded-md bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
                title="The one level this list groups by">
                <option value="song">Group: Song</option>
                <option value="category">Group: Category</option>
              </select>
            </span>
          </div>

          {(detailArtistGroup?.groups?.length || 0) === 0 ? (
            <div className="card px-5 py-10 text-center">
              <p className="text-sm text-gray-400">
                {filterState
                  ? `Nothing in that band for ${detailArtist} in this period.`
                  : `Nothing in this statement period for ${detailArtist}.`}
              </p>
              {filterState && (
                <button onClick={() => setFilterState('')}
                  className="mt-2 text-[11.5px] font-bold text-boom-600 hover:underline">
                  Show every band
                </button>
              )}
            </div>
          ) : detailArtistGroup.groups.map(group => {
                    const groupCollapseKey = `g:${detailArtistGroup.artistKey}:${group.key}`
                    const groupCollapsed = isCollapsed(groupCollapseKey)
                    return (
                    // Each group is a self-contained card. It is now the ONLY
                    // container between the filter bar and a row.
                    <div
                      key={group.key}
                      className="group/grp card overflow-hidden"
                    >
                      {/* Group subheader. Icon distinguishes song vs category
                          grouping. The pencil rename only shows for song
                          groups — we don't bulk-rename categories from this
                          page. The whole bar is clickable to toggle collapse;
                          nested buttons / checkboxes call stopPropagation so
                          they don't accidentally trigger it. No background
                          tint anymore — the card's left rail carries the
                          group identity, so the header reads as a card
                          header (white bg) rather than another lavender
                          bar competing with the categories below it. */}
                      <div
                        onClick={() => toggleCollapsed(groupCollapseKey)}
                        className={`flex items-center justify-between px-4 py-3 border-b cursor-pointer hover:bg-gray-50/60 transition-colors ${
                          group.source === 'none' ? 'border-amber-100/60' : 'border-divider'
                        }`}
                        title={groupCollapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
                      >
                        <div className="flex items-center gap-1.5">
                          {groupCollapsed
                            ? <ChevronRight size={12} className="text-gray-400 flex-shrink-0" />
                            : <ChevronDown size={12} className="text-gray-400 flex-shrink-0" />}
                          {/* Section-level Select-all checkbox — toggles
                              every item in this primary group. Indeterminate
                              state when only some are selected. */}
                          {(() => {
                            const ids = group.items.map(i => i.id)
                            const allSel = ids.length > 0 && ids.every(id => selectedIds.has(id))
                            const someSel = !allSel && ids.some(id => selectedIds.has(id))
                            return (
                              <input
                                type="checkbox"
                                checked={allSel}
                                ref={el => { if (el) el.indeterminate = someSel }}
                                onChange={() => selectIds(ids)}
                                className="w-3.5 h-3.5 accent-boom-600 cursor-pointer flex-shrink-0"
                                title={allSel
                                  ? `Deselect all ${ids.length} items in ${group.name}`
                                  : `Select all ${ids.length} items in ${group.name}`}
                                onClick={e => e.stopPropagation()}
                              />
                            )
                          })()}
                          {group.source === 'song' ? (
                            <Music2 size={13} className="text-boom-500 flex-shrink-0" />
                          ) : group.source === 'category' ? (
                            <FolderOpen size={13} className="text-boom-500 flex-shrink-0" />
                          ) : (
                            <FolderOpen size={13} className="text-amber-500 flex-shrink-0" />
                          )}
                          <span className={`text-sm font-bold ${
                            group.source === 'none' ? 'text-amber-800 italic' : 'text-gray-900'
                          }`}>{group.name}</span>
                          {group.source === 'none' && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-amber-100 text-amber-700">
                              No {groupBy}
                            </span>
                          )}
                          {(group.source === 'song' || group.source === 'category') && (
                            <button
                              onClick={e => {
                                e.stopPropagation()
                                ;(group.source === 'song'
                                  ? openSongModal('group', group.items.map(i => i.id), group.name)
                                  : openCategoryModal('group', group.items.map(i => i.id), group.name)
                                )
                              }}
                              className="opacity-0 group-hover/grp:opacity-100 transition-opacity p-1 rounded hover:bg-gray-200/70 text-gray-400 hover:text-gray-700"
                              title={`Rename ${group.source} for all ${group.items.length} item${group.items.length === 1 ? '' : 's'} in this group`}
                            >
                              <Edit2 size={11} />
                            </button>
                          )}
                          {/* Per-song note affordance. Only attaches to song
                              buckets — category groups span many songs so a
                              "song note" wouldn't fit there. Existing notes
                              show as a small amber dot on the icon; click
                              toggles an inline editor below the header. */}
                          {group.source === 'song' && (() => {
                            const hasNote = !!(songNotes[group.key] || '').trim()
                            const isEditing = editingSongNoteKey === group.key
                            return (
                              <button
                                onClick={e => {
                                  e.stopPropagation()
                                  setEditingSongNoteKey(isEditing ? null : group.key)
                                }}
                                className={`transition-opacity p-1 rounded hover:bg-amber-50 ${
                                  hasNote
                                    ? 'opacity-100 text-amber-600'
                                    : 'opacity-0 group-hover/grp:opacity-100 text-gray-400 hover:text-amber-600'
                                }`}
                                title={hasNote ? 'Edit song note' : 'Add a note for this song'}
                              >
                                <StickyNote size={11} />
                              </button>
                            )
                          })()}
                          {/* Finished + matched-up badge. Same state the
                              Artist Campaigns song header uses, toggleable
                              from either page. Hidden on category /
                              no-song buckets — only song campaigns can
                              be "finished". */}
                          {group.source === 'song' && (() => {
                            const artistName = grouped[0]?.artist || routeArtist
                            const finished = isSongFinished(artistName, group.name)
                            return finished ? (
                              <span
                                role="button"
                                tabIndex={0}
                                onClick={e => { e.stopPropagation(); toggleSongFinished(artistName, group.name, true) }}
                                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleSongFinished(artistName, group.name, true) } }}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold text-emerald-700 bg-emerald-50 ring-1 ring-emerald-200/60 hover:bg-emerald-100 cursor-pointer"
                                title="Campaign finished + matched up — click to reopen"
                              >
                                <CheckCircle2 size={10} /> Finished
                              </span>
                            ) : (
                              <span
                                role="button"
                                tabIndex={0}
                                onClick={e => { e.stopPropagation(); toggleSongFinished(artistName, group.name, false) }}
                                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleSongFinished(artistName, group.name, false) } }}
                                className="opacity-0 group-hover/grp:opacity-100 inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold text-gray-400 hover:text-emerald-700 hover:bg-emerald-50 cursor-pointer transition-opacity"
                                title="Mark this song campaign as finished + matched up"
                              >
                                <CheckCircle2 size={10} /> Mark finished
                              </span>
                            )
                          })()}
                          {/* Release-level ready-for-planning toggle — sky
                              chip when set, hover-reveal action when not.
                              Shared with the Campaigns song subpage. */}
                          {group.source === 'song' && (() => {
                            const artistName = grouped[0]?.artist || routeArtist
                            const ready = isSongReady(artistName, group.name)
                            return ready ? (
                              <span
                                role="button"
                                tabIndex={0}
                                onClick={e => { e.stopPropagation(); toggleSongReady(artistName, group.name, false) }}
                                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleSongReady(artistName, group.name, false) } }}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold text-sky-700 bg-sky-50 ring-1 ring-sky-200/60 hover:bg-sky-100 cursor-pointer"
                                title="Ready for recoupment planning — click to unmark"
                              >
                                <FolderOpen size={10} /> Ready for planning
                              </span>
                            ) : (
                              <span
                                role="button"
                                tabIndex={0}
                                onClick={e => { e.stopPropagation(); toggleSongReady(artistName, group.name, true) }}
                                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleSongReady(artistName, group.name, true) } }}
                                className="opacity-0 group-hover/grp:opacity-100 inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold text-gray-400 hover:text-sky-700 hover:bg-sky-50 cursor-pointer transition-opacity"
                                title="Mark this release as ready for recoupment planning"
                              >
                                <FolderOpen size={10} /> Mark ready
                              </span>
                            )
                          })()}
                          {/* Release-level "2025 Expenses" action — tags every
                              item in this bucket into (or out of) the
                              prior-year bucket at /recoupments/2025. */}
                          {(() => {
                            const all2025 = group.items.length > 0 && group.items.every(i => i.is_2025_expense)
                            return all2025 ? (
                              <span
                                role="button"
                                tabIndex={0}
                                onClick={e => { e.stopPropagation(); toggleGroup2025(group.items, false) }}
                                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleGroup2025(group.items, false) } }}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold text-amber-700 bg-amber-50 ring-1 ring-amber-200/60 hover:bg-amber-100 cursor-pointer"
                                title="Every item here is in 2025 Expenses — click to bring them all back"
                              >
                                <CalendarClock size={10} /> 2025
                              </span>
                            ) : (
                              <span
                                role="button"
                                tabIndex={0}
                                onClick={e => { e.stopPropagation(); toggleGroup2025(group.items, true) }}
                                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleGroup2025(group.items, true) } }}
                                className="opacity-0 group-hover/grp:opacity-100 inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold text-gray-400 hover:text-amber-700 hover:bg-amber-50 cursor-pointer transition-opacity"
                                title="Tag every item in this release as a 2025 Expense (moves to the 2025 subpage)"
                              >
                                <CalendarClock size={10} /> Mark 2025
                              </span>
                            )
                          })()}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className={`text-xs font-bold tabular-nums ${group.source === 'none' ? 'text-amber-800' : 'text-gray-700'}`}>{fmtTotals(group.totalByCurrency)}<span className="font-medium text-gray-400">{usdItemsSuffix(group.items, fxRates)}</span></span>
                          {/* Cobrand chip on the primary group header — same
                              treatment as the artist card cobrand pill but
                              sized inline with the group total. Hidden when
                              the group has no cobrand items. */}
                          {group.cobrandCount > 0 && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums text-purple-700 bg-purple-50 border border-purple-100">
                              <Sparkles size={9} /> {fmtTotals(group.cobrandTotalByCurrency)}
                            </span>
                          )}
                          <span className={`text-[10px] ${group.source === 'none' ? 'text-amber-600/80' : 'text-gray-400'}`}>{group.ufrCount}/{group.items.length} UFR</span>
                        </div>
                      </div>

                      {/* Inline song-note row — visible regardless of group
                          collapse state so the context stays read-able even
                          when items are folded. Edit state opens a textarea;
                          commits on blur or Cmd/Ctrl+Enter. */}
                      {group.source === 'song' && (editingSongNoteKey === group.key || (songNotes[group.key] || '').trim()) && (
                        <div className="px-5 py-2 bg-amber-50/60 border-b border-amber-100">
                          {editingSongNoteKey === group.key ? (
                            <textarea
                              defaultValue={songNotes[group.key] || ''}
                              autoFocus
                              rows={2}
                              placeholder={`Note for "${group.name}" — context, budget caps, mech-royalty timing, etc.`}
                              className="w-full text-xs border border-amber-200 rounded-md px-2 py-1.5 focus:border-amber-400 focus:outline-none resize-y bg-card"
                              onBlur={async (e) => {
                                const prev = songNotes[group.key] || ''
                                if (e.target.value !== prev) await saveRecoupmentNote({ song: group.name, note: e.target.value })
                                setEditingSongNoteKey(null)
                              }}
                              onKeyDown={(e) => {
                                if ((e.key === 'Enter' && (e.metaKey || e.ctrlKey)) || e.key === 'Escape') {
                                  e.preventDefault()
                                  e.currentTarget.blur()
                                }
                              }}
                            />
                          ) : (
                            <div className="flex items-start gap-2">
                              <StickyNote size={11} className="text-amber-500 flex-shrink-0 mt-0.5" />
                              <p
                                className="text-xs text-amber-900 whitespace-pre-wrap flex-1 cursor-text"
                                onClick={(e) => { e.stopPropagation(); setEditingSongNoteKey(group.key) }}
                                title="Click to edit"
                              >{songNotes[group.key]}</p>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Items. Nothing between the group header and the row:
                          the category and label buckets that used to sit here
                          were restating chips the row already carries.

                          Visual treatment on a row:
                          • a 2px LEFT RAIL in the four bank-state tones — the
                            state the four stacked sections used to carry,
                          • an emerald background wash and a solid UFR badge when
                            the item has been uploaded.
                          Two channels for two orthogonal axes: the rail is what
                          the BANK says, the wash is what WE claimed. */}
                            {!groupCollapsed && [...group.items].sort(byStateThenAmount).map(entry => {
                        const isUfr = entry.ufr === 'Yes'
                        const isSelected = selectedIds.has(entry.id)
                        // An axis is "established by an ancestor" when the
                        // group header already says it — only ONE axis can be,
                        // now that the group IS the only ancestor. The chip for
                        // the other axis always renders, which is what lets the
                        // category bucket go away: grouped by song, every row
                        // shows its own category chip instead of sitting under a
                        // "Marketing" bar that said it once for the whole list.
                        // Rows without a value still get the "Add ___"
                        // placeholder so empty data stays fixable inline.
                        const songAxisGrouped = group.source === 'song'
                        const categoryAxisGrouped = group.source === 'category'
                        const hideSongChip = songAxisGrouped && !!(entry.song || '').trim()
                        const hideCategoryChip = categoryAxisGrouped && !!(entry.category || '').trim()
                        // The left rail is the BANK's opinion, in the four
                        // `recoupState` tones — the state the four stacked
                        // sections used to carry, put back on the row rather
                        // than on a panel. It cannot be the shared
                        // BankEvidenceDot: that renders nothing for `awaiting`
                        // and `unpaid` on purpose ("a grey dot on every row of
                        // an un-uploaded month trains people to ignore the
                        // dot"), which was fine when a section header named the
                        // band and is a hole now that none does.
                        const RAIL = {
                          verified:           'border-l-emerald-500',
                          awaiting_statement: 'border-l-sky-400',
                          unverified:         'border-l-rose-500',
                          unpaid:             'border-l-gray-300',
                        }
                        const st = recoupState(entry)
                        return (
                        <div key={entry.id} className={`group flex items-center justify-between px-5 py-2.5 border-b border-gray-50 border-l-2 ${RAIL[st]} transition-colors ${
                          // THREE washes, down from six. Selection and the
                          // upload plan are things the user just did; the UFR
                          // wash is the claim stamp. `entry_source` had two more
                          // — a purple "born on Recoupments" and an indigo "born
                          // on Artist Campaigns" — and it is NULL on 90.2% of
                          // rows, firing on 0.6% and 8.5%. That is a colour
                          // vocabulary to learn for under a tenth of the list,
                          // competing with the rail that says something you act
                          // on. Provenance moved to the row's tooltip, which
                          // already said it.
                          isSelected
                            ? 'bg-boom-50/40'
                            : entry.id in plan
                              // Staged in the upload plan — sky wash so planned
                              // items are scannable on this list without opening
                              // the Planning page.
                              ? 'bg-sky-50 hover:bg-sky-50'
                              : isUfr
                                ? 'bg-emerald-50/40 hover:bg-emerald-50/70'
                                : 'hover:bg-gray-50/30'
                        }`}
                        title={[
                          st === 'verified'           ? 'Bank-verified — a statement we hold shows this payment' :
                          st === 'unverified'         ? 'Marked Paid, and the statement covering that date shows no matching line' :
                          st === 'awaiting_statement' ? 'Paid — no uploaded statement covers this date yet' :
                                                        'Not paid yet — nothing has left the bank',
                          entry.id in plan ? `In the upload plan${plan[entry.id] ? ` — label "${plan[entry.id]}"` : ''} (see Planning)` : null,
                          entry.entry_source === 'recoupments'      ? 'Added from the Recoupments page'      : null,
                          entry.entry_source === 'artist_campaigns' ? 'Added from the Artist Campaigns page' : null,
                        ].filter(Boolean).join('\n')}
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            {/* Checkbox — drives the bulk-label / bulk-UFR action bar below.
                                Fades in on row hover to match the placeholder chips —
                                keeps rows visually clean unless the user is targeting
                                one. */}
                            <input
                              type="checkbox"
                              checked={selectedIds.has(entry.id)}
                              onChange={() => toggleSelect(entry.id)}
                              className={`w-4 h-4 accent-boom-600 cursor-pointer flex-shrink-0 transition-opacity ${
                                isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                              }`}
                              aria-label={`Select ${entry.payee || 'item'}`}
                            />
                            <div className="min-w-0 flex-1">
                              {/* Bold payee/vendor name doubles as a click
                                  target for inline-renaming. Falls back to
                                  description when no payee is set; either way
                                  the editor writes to the `payee` column. */}
                              <button
                                onClick={() => openPayeeModal(entry.id, entry.payee || '')}
                                className="text-sm text-gray-800 font-medium truncate hover:text-boom-700 hover:underline decoration-dotted underline-offset-4 transition-colors text-left max-w-full"
                                title="Click to rename this entry's payee"
                              >
                                {entry.payee || entry.description || '—'}
                              </button>
                              <p className="text-[11px] text-gray-500 flex items-center gap-1.5 flex-wrap mt-1">
                                <span className="tabular-nums">{entry.invoice_date ? formatDate(entry.invoice_date) : '—'}</span>
                                {entry.payment_status === 'Paid' && entry.payment_date && (
                                  <span className="text-green-700">
                                    · Paid {formatDate(entry.payment_date)}
                                  </span>
                                )}
                                {entry.invoice_number && <span className="text-gray-400">· #{entry.invoice_number}</span>}
                                {/* Cobrand toggle — clickable chip when set,
                                    muted 'Add cobrand' placeholder when not.
                                    Mirrors the song/category/label chip
                                    pattern so editing is consistent. */}
                                {entry.cobrand ? (
                                  <button
                                    onClick={() => toggleCobrand(entry.id, entry.cobrand)}
                                    disabled={savingId === entry.id}
                                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-gray-100 ring-1 ring-blue-200/60 text-blue-700 hover:bg-gray-200 transition-colors ${savingId === entry.id ? 'opacity-50' : ''}`}
                                    title="Cobrand expense — click to remove"
                                  >
                                    <Sparkles size={9} className="text-blue-500" />
                                    Cobrand
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => toggleCobrand(entry.id, entry.cobrand)}
                                    disabled={savingId === entry.id}
                                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-gray-400 hover:text-blue-700 hover:bg-blue-50 hover:ring-1 hover:ring-blue-200/60 transition-opacity opacity-0 group-hover:opacity-100 ${savingId === entry.id ? 'opacity-50' : ''}`}
                                    title="Mark this expense as cobrand"
                                  >
                                    <Sparkles size={9} />
                                    Add cobrand
                                  </button>
                                )}
                                {/* Category chip — click to edit a single item's
                                    category. Teal so it's visibly distinct from
                                    the sky-blue song chip and the indigo label
                                    chip.
                                    Inside a category-grouped bucket the chip
                                    would otherwise restate the breadcrumb. To
                                    avoid clutter without losing the affordance
                                    (the user needs a way to MOVE an item out
                                    of that bucket), we collapse it down to a
                                    compact "Move" link with just the icon when
                                    the row sits inside the matching bucket. */}
                                {(entry.category || '').trim() ? (
                                  hideCategoryChip ? (
                                    <button
                                      onClick={() => openCategoryModal('single', [entry.id], entry.category)}
                                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-gray-400 hover:text-teal-700 hover:bg-teal-50 hover:ring-1 hover:ring-teal-200/60 transition-opacity opacity-0 group-hover:opacity-100"
                                      title={`Category: ${entry.category} — click to move to a different category`}
                                    >
                                      <FolderOpen size={9} />
                                      Move
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() => openCategoryModal('single', [entry.id], entry.category)}
                                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-gray-100 ring-1 ring-teal-200/60 text-teal-700 hover:bg-gray-200 transition-colors max-w-[200px] truncate"
                                      title={`Category: ${entry.category} — click to edit`}
                                    >
                                      <FolderOpen size={9} className="text-teal-500" />
                                      <span className="truncate">{entry.category}</span>
                                    </button>
                                  )
                                ) : (
                                  <button
                                    onClick={() => openCategoryModal('single', [entry.id], '')}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-gray-400 hover:text-teal-700 hover:bg-teal-50 hover:ring-1 hover:ring-teal-200/60 transition-opacity opacity-0 group-hover:opacity-100"
                                    title="Set the category for this item"
                                  >
                                    <FolderOpen size={9} />
                                    Add category
                                  </button>
                                )}
                                {/* Song chip — click to edit just this item's
                                    song. Use to fix a typo / move one item out
                                    of the wrong group without renaming the
                                    whole bucket. Sky color so it's visibly
                                    distinct from the indigo recoupment-label
                                    chip rendered just after. Hidden when the
                                    row's parent group already establishes
                                    the song. */}
                                {!hideSongChip && ((entry.song || '').trim() ? (
                                  <button
                                    onClick={() => openSongModal('single', [entry.id], entry.song)}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-gray-100 ring-1 ring-sky-200/60 text-sky-700 hover:bg-gray-200 transition-colors max-w-[200px] truncate"
                                    title={`Song: ${entry.song} — click to edit`}
                                  >
                                    <Music2 size={9} className="text-sky-500" />
                                    <span className="truncate">{entry.song}</span>
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => openSongModal('single', [entry.id], '')}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-gray-400 hover:text-sky-700 hover:bg-sky-50 hover:ring-1 hover:ring-sky-200/60 transition-opacity opacity-0 group-hover:opacity-100"
                                    title="Set the song this item belongs to"
                                  >
                                    <Music2 size={9} />
                                    Add song
                                  </button>
                                ))}
                                {/* Recoupment label chip — click to edit. Shows
                                    on the second line so it doesn't crowd the actions. */}
                                {(entry.recoupment_label || '').trim() ? (
                                  <button
                                    onClick={() => openLabelModal('single', [entry.id], entry.recoupment_label, false)}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-gray-100 ring-1 ring-indigo-200/60 text-indigo-700 hover:bg-gray-200 transition-colors max-w-[260px] truncate"
                                    title={`Recoupment label: ${entry.recoupment_label} — click to edit`}
                                  >
                                    <Tag size={9} className="text-indigo-500" />
                                    <span className="truncate">{entry.recoupment_label}</span>
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => openLabelModal('single', [entry.id], '', false)}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-gray-400 hover:text-indigo-700 hover:bg-indigo-50 hover:ring-1 hover:ring-indigo-200/60 transition-opacity opacity-0 group-hover:opacity-100"
                                    title="Add a recoupment label"
                                  >
                                    <Tag size={9} />
                                    Add label
                                  </button>
                                )}
                                {/* Notes — sticky-note icon button. Amber-
                                    filled when notes exist (with the first
                                    chars previewed inline so the user can
                                    skim without opening), muted gray
                                    placeholder when none. Click opens the
                                    full editor modal. */}
                                {(entry.notes || '').trim() ? (
                                  <button
                                    onClick={() => openNotesModal(entry)}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-gray-100 ring-1 ring-amber-200/60 text-amber-800 hover:bg-gray-200 transition-colors max-w-[260px]"
                                    title={`Note: ${entry.notes}`}
                                  >
                                    <StickyNote size={9} className="text-amber-500" />
                                    <span className="truncate">{entry.notes}</span>
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => openNotesModal(entry)}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-gray-400 hover:text-amber-800 hover:bg-amber-50 hover:ring-1 hover:ring-amber-200/60 transition-opacity opacity-0 group-hover:opacity-100"
                                    title="Add a note to this expense"
                                  >
                                    <StickyNote size={9} />
                                    Add note
                                  </button>
                                )}
                                {/* Socials — mirrors the Ledger's Socials column.
                                    Clickable on rows that own the handles; read-
                                    only span for split children inheriting from
                                    their parent (editing the child would write
                                    to the wrong row). Placeholder "Add socials"
                                    appears on parent/standalone rows when empty
                                    so the affordance is always visible, like
                                    the Ledger column. */}
                                {(() => {
                                  const socials = entrySocials(entry)
                                  const hasOwn = Array.isArray(entry.social_handles) && entry.social_handles.length > 0
                                  if (socials.length) {
                                    const tooltip = socials
                                      .map(s => s.platform ? `${s.platform}: ${s.handle}` : s.handle)
                                      .join('\n')
                                    const first = socials[0]
                                    const extra = socials.length - 1
                                    return hasOwn ? (
                                      <button
                                        onClick={() => openSocialsModal(entry)}
                                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-gray-100 ring-1 ring-sky-200/60 text-sky-700 hover:bg-gray-200 transition-colors max-w-[200px]"
                                        title={`${tooltip}\n— click to edit`}
                                      >
                                        <AtSign size={9} className="text-sky-500" />
                                        <span className="truncate">
                                          {first.platform ? `${first.platform} ` : ''}{first.handle}
                                        </span>
                                        {extra > 0 && <span className="text-sky-500 font-bold">+{extra}</span>}
                                      </button>
                                    ) : (
                                      <span
                                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-gray-100 ring-1 ring-sky-200/60 text-sky-700 max-w-[200px]"
                                        title={`${tooltip}\n(inherited from parent invoice)`}
                                      >
                                        <AtSign size={9} className="text-sky-500" />
                                        <span className="truncate">
                                          {first.platform ? `${first.platform} ` : ''}{first.handle}
                                        </span>
                                        {extra > 0 && <span className="text-sky-500 font-bold">+{extra}</span>}
                                      </span>
                                    )
                                  }
                                  if (entry.parent_id) return null
                                  return (
                                    <button
                                      onClick={() => openSocialsModal(entry)}
                                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-gray-400 hover:text-sky-700 hover:bg-sky-50 hover:ring-1 hover:ring-sky-200/60 transition-opacity opacity-0 group-hover:opacity-100"
                                      title="Add social handles for this expense"
                                    >
                                      <AtSign size={9} />
                                      Add socials
                                    </button>
                                  )
                                })()}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-4 flex-shrink-0">
                            <span className="text-sm font-bold text-boom-600 tabular-nums" title={usdSuffixForEntry(entry, fxRates, { precise: true }).trim().replace(/^\(|\)$/g, '') || undefined}>
                              {fmt(entry.amount, entry.currency)}
                              {(entry.currency || 'USD').toUpperCase() !== 'USD' && (
                                <span className="ml-1 font-normal text-gray-400 text-xs">{usdSuffixForEntry(entry, fxRates)}</span>
                              )}
                            </span>
                            {/* Added expenses get a clickable status so users
                                can flip Paid/Unpaid inline; invoices keep the
                                read-only pill (payment state belongs to the
                                Payment Dashboard). */}
                            {['recoupments', 'artist_campaigns'].includes(entry.entry_source) ? (
                              <button
                                onClick={() => togglePaid(entry)}
                                disabled={savingId === entry.id}
                                title={entry.payment_status === 'Paid' ? 'Click to mark as unpaid' : 'Click to mark as paid'}
                                className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold transition-opacity hover:opacity-70 ${
                                  entry.payment_status === 'Paid' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
                                }`}
                              >
                                {entry.payment_status || 'Unpaid'}
                              </button>
                            ) : (
                              <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${
                                entry.payment_status === 'Paid' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
                              }`}>
                                {entry.payment_status || 'Unpaid'}
                              </span>
                            )}
                            {/* 2025 Expenses tag. Rendered only once the bucket
                                is in use anywhere, or on a row already in it —
                                see `anyReadyForPlanning` above. The group
                                header's hover-only "Mark 2025" is the way in,
                                and tagging one row brings this back on every
                                row at once. */}
                            {(count2025 > 0 || entry.is_2025_expense) && (
                            <button
                              onClick={() => toggle2025(entry)}
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold transition-colors ${
                                entry.is_2025_expense
                                  ? 'bg-amber-100 text-amber-700 ring-1 ring-amber-200/60 hover:bg-amber-200'
                                  : 'text-gray-300 hover:text-amber-700 hover:bg-amber-50'
                              }`}
                              title={entry.is_2025_expense ? '2025 Expense — click to remove from the bucket' : 'Tag as a 2025 Expense (moves to the 2025 subpage)'}
                            >
                              <CalendarClock size={9} /> 2025
                            </button>
                            )}
                            {/* View invoice — opens the file in the existing
                                FilePreview overlay. Falls back to the parent's
                                file for split-family children (see invoiceUrl). */}
                            {hasInvoiceFile(entry) ? (
                              <button
                                onClick={() => setPreviewFile({
                                  url: invoiceUrl(entry),
                                  filename: `Invoice-${entry.payee || entry.id}`,
                                })}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
                                title="View invoice"
                              >
                                <FileText size={12} />
                                Invoice
                              </button>
                            ) : (
                              <span
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-gray-300 cursor-default"
                                title="No invoice on file"
                              >
                                <FileText size={12} />
                                —
                              </span>
                            )}
                            {/* Recoupable toggle */}
                            <button
                              onClick={() => toggleRecoupable(entry.id, entry.recoupable)}
                              disabled={savingId === entry.id}
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold transition-all ${
                                entry.recoupable
                                  ? 'bg-boom-100 text-boom-700 hover:bg-boom-200'
                                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                              } ${savingId === entry.id ? 'opacity-50' : ''}`}
                              title={entry.recoupable ? 'Mark as not recoupable' : 'Mark as recoupable'}
                            >
                              {entry.recoupable && <Check size={11} />}
                              Recoup
                            </button>
                            {/* UFR toggle — uploaded for recoupment.
                                Active state is intentionally heavy (solid
                                fill + white text + CheckCircle2 + shadow)
                                so it reads as a STAMP, not just another
                                pastel chip alongside Recoup / Paid. */}
                            <button
                              onClick={() => toggleUfr(entry.id, entry.ufr)}
                              disabled={savingId === entry.id}
                              className={`inline-flex items-center gap-1 rounded-md text-xs font-bold transition-all ${
                                isUfr
                                  ? 'bg-emerald-500 text-white px-3 py-1 shadow-sm hover:bg-emerald-600 ring-1 ring-emerald-600/20'
                                  : 'bg-card text-gray-500 px-2.5 py-1 border border-dashed border-gray-300 hover:border-emerald-400 hover:text-emerald-600 hover:bg-emerald-50/40'
                              } ${savingId === entry.id ? 'opacity-50' : ''}`}
                              title={isUfr ? 'Uploaded for recoupment — click to undo' : 'Mark as uploaded for recoupment'}
                            >
                              {isUfr ? <CheckCircle2 size={13} strokeWidth={2.5} /> : null}
                              {isUfr ? 'Uploaded' : 'UFR'}
                            </button>
                            {/* The stamp says we CLAIMED this money; the dot says
                                whether a bank line backs the claim. Guarded by
                                isUfr on purpose — the dot's own condition is true
                                of 281 of the 1,460 rows on this page, and shown
                                on all of them it would be wallpaper within a day.
                                Same component as Ledger / Payments / Vendors, so
                                a rose dot means the same thing everywhere. */}
                            {isUfr && <BankEvidenceDot row={entry} className="ml-0.5" />}
                            {/* When the UFR stamp is set, show the date it
                                was uploaded next to the badge so staleness is
                                visible at a glance. Click the date to open a
                                native month picker — selecting a different
                                month moves the row to that monthly statement
                                (overrides ufr_marked_at; the statement bucket
                                is derived from this timestamp). */}
                            {isUfr && entry.ufr_marked_at && (
                              editingUfrFor === entry.id ? (
                                <input
                                  type="month"
                                  autoFocus
                                  defaultValue={statementMonthFor(entry.ufr_marked_at) || ''}
                                  onChange={(e) => moveUfrToStatement(entry.id, e.target.value)}
                                  onBlur={() => setEditingUfrFor(null)}
                                  onKeyDown={(e) => { if (e.key === 'Escape') setEditingUfrFor(null) }}
                                  className="text-[10px] font-medium text-emerald-700 tabular-nums border border-emerald-300 rounded px-1 py-0.5 bg-card focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                />
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setEditingUfrFor(entry.id)}
                                  className="text-[10px] font-medium text-emerald-700/70 tabular-nums hover:text-emerald-700 hover:underline decoration-dotted underline-offset-2 cursor-pointer"
                                  title={`Uploaded for recoupment on ${formatDate(entry.ufr_marked_at)}. Click to move to a different monthly statement.`}
                                >
                                  {formatDate(entry.ufr_marked_at)}
                                </button>
                              )
                            )}
                            {/* Split — divides this expense across multiple
                                artists. Hidden on split children (parent_id
                                set) since you split parents, not children. */}
                            {!entry.parent_id && (
                              <button
                                onClick={() => openSplitModal(entry)}
                                title="Split this invoice across multiple artists"
                                className="text-xs font-semibold px-2 py-1 rounded-md text-boom-700 bg-boom-50 hover:bg-boom-100 border border-boom-200 inline-flex items-center gap-1"
                              >
                                <Copy size={11} /> Split
                              </button>
                            )}
                            <FlagButton
                              flagged={!!entry.flagged}
                              reason={entry.flag_reason || ''}
                              flaggedBy={entry.flagged_by_name || ''}
                              flaggedAt={entry.flagged_at}
                              onToggle={(next, reason) => toggleExpenseFlag(entry.id, next, reason ?? null)}
                              onSaveReason={(reason) => saveExpenseFlagReason(entry.id, reason)}
                              size="sm"
                              alwaysVisible
                            />
                            {/* Comment thread — "recoupable against X release",
                                "recoupable across the whole contract", etc. */}
                            <CommentThreadButton
                              entryId={entry.id}
                              initialCount={Number(entry.comment_count) || 0}
                              placeholder={'e.g. "Recoupable against the Gimme Love release"'}
                            />
                            {/* Jump to this row in the master Ledger —
                                ?focus= scrolls it into view + spotlights it
                                (auto-expands the parent group for children). */}
                            <Link
                              to={`/bk/ledger?focus=${entry.id}`}
                              className="p-1.5 rounded-md text-gray-300 hover:bg-gray-50 hover:text-boom-600 transition-colors"
                              title="Open this row in the Ledger"
                            >
                              <ExternalLink size={13} />
                            </Link>
                            {/* Delete (soft) — server cascades to split-family
                                children. The row gets yanked locally on
                                optimistic update; rolls back on API failure. */}
                            <button
                              onClick={() => handleDeleteEntry(entry)}
                              disabled={deletingId === entry.id}
                              className={`p-1.5 rounded-md text-gray-300 hover:bg-red-50 hover:text-red-600 transition-colors ${deletingId === entry.id ? 'opacity-50' : ''}`}
                              title="Delete this expense (soft-delete — recover from the Ledger)"
                            >
                              {deletingId === entry.id ? <Loader size={13} className="animate-spin" /> : <Trash2 size={13} />}
                            </button>
                          </div>
                        </div>
                        )
                      })}
                    </div>
                  )})}
        </div>
      )}

      <style>{`@keyframes slideUp { from { transform: translateX(-50%) translateY(20px); opacity: 0 } to { transform: translateX(-50%) translateY(0); opacity: 1 } }`}</style>

      {previewFile && (
        <FilePreview url={previewFile.url} filename={previewFile.filename} onClose={() => setPreviewFile(null)} />
      )}

      {/* Non-recoupable expenses panel — bottom of the detail page. Hidden
          entirely when the artist has nothing here; otherwise renders as a
          collapsed bar with a per-artist localStorage-backed expand state. */}
      {isDetail && nonRecoupableItems.length > 0 && (
        <div className="card overflow-hidden">
          <button
            onClick={toggleShowNonRecoup}
            className="w-full flex items-center justify-between px-5 py-3 hover:bg-gray-50/60 transition-colors text-left"
            title={showNonRecoup
              ? 'Hide non-recoupable expenses'
              : 'Show non-recoupable expenses for this artist'}
          >
            <div className="flex items-center gap-2 text-gray-500">
              {showNonRecoup ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className="text-xs font-semibold uppercase tracking-wide">
                Non-recoupable expenses
              </span>
              <span className="text-xs text-gray-400">
                · {nonRecoupableItems.length} item{nonRecoupableItems.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="text-right">
              <div className="text-sm font-bold text-gray-600 tabular-nums">{fmtTotals(nonRecoupTotalByCur)}</div>
              {usdItemsSuffix(nonRecoupableItems, fxRates) && (
                <div className="text-[10px] text-gray-400 tabular-nums">{usdItemsSuffix(nonRecoupableItems, fxRates).trim().replace(/^\(|\)$/g, '')}</div>
              )}
            </div>
          </button>
          {showNonRecoup && (
            <div className="border-t border-divider">
              {nonRecoupableItems.map(entry => (
                <div key={entry.id} className="flex items-center justify-between px-5 py-2.5 border-b border-gray-50 hover:bg-gray-50/30 transition-colors">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-gray-700 font-medium truncate">{entry.payee || entry.description || '—'}</p>
                      <p className="text-[11px] text-gray-500 flex items-center gap-1.5 flex-wrap mt-0.5">
                        <span className="tabular-nums">{entry.invoice_date ? formatDate(entry.invoice_date) : '—'}</span>
                        {entry.payment_status === 'Paid' && entry.payment_date && (
                          <span className="text-green-700">· Paid {formatDate(entry.payment_date)}</span>
                        )}
                        {entry.category && <span className="text-gray-400">· {entry.category}</span>}
                        {entry.song && <span className="text-gray-400">· {entry.song}</span>}
                        {entry.invoice_number && <span className="text-gray-400">· #{entry.invoice_number}</span>}
                        {(() => {
                          const socials = entrySocials(entry)
                          if (!socials.length) return null
                          const tooltip = socials.map(s => s.platform ? `${s.platform}: ${s.handle}` : s.handle).join('\n')
                          const first = socials[0]
                          const extra = socials.length - 1
                          return (
                            <span
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-gray-100 ring-1 ring-sky-200/60 text-sky-700 max-w-[180px]"
                              title={tooltip}
                            >
                              <AtSign size={9} className="text-sky-500" />
                              <span className="truncate">{first.platform ? `${first.platform} ` : ''}{first.handle}</span>
                              {extra > 0 && <span className="text-sky-500 font-bold">+{extra}</span>}
                            </span>
                          )
                        })()}
                        {/* Note icon — same opener as the main rows. */}
                        {(entry.notes || '').trim() ? (
                          <button
                            onClick={() => openNotesModal(entry)}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-gray-100 ring-1 ring-amber-200/60 text-amber-800 hover:bg-gray-200 max-w-[200px]"
                            title={`Note: ${entry.notes}`}
                          >
                            <StickyNote size={9} className="text-amber-500" />
                            <span className="truncate">{entry.notes}</span>
                          </button>
                        ) : (
                          <button
                            onClick={() => openNotesModal(entry)}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-gray-400 hover:text-amber-800 hover:bg-amber-50 hover:ring-1 hover:ring-amber-200/60"
                            title="Add a note to this expense"
                          >
                            <StickyNote size={9} />
                            Add note
                          </button>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-sm font-bold text-gray-700 tabular-nums" title={usdSuffixForEntry(entry, fxRates, { precise: true }).trim().replace(/^\(|\)$/g, '') || undefined}>
                      {fmt(entry.amount, entry.currency)}
                      {(entry.currency || 'USD').toUpperCase() !== 'USD' && (
                        <span className="ml-1 font-normal text-gray-400 text-xs">{usdSuffixForEntry(entry, fxRates)}</span>
                      )}
                    </span>
                    {/* Same clickable Paid/Unpaid treatment as the recoupable
                        rows above — added expenses only. */}
                    {['recoupments', 'artist_campaigns'].includes(entry.entry_source) ? (
                      <button
                        onClick={() => togglePaid(entry)}
                        disabled={savingId === entry.id}
                        title={entry.payment_status === 'Paid' ? 'Click to mark as unpaid' : 'Click to mark as paid'}
                        className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold transition-opacity hover:opacity-70 ${
                          entry.payment_status === 'Paid' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
                        }`}
                      >
                        {entry.payment_status || 'Unpaid'}
                      </button>
                    ) : (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${
                        entry.payment_status === 'Paid' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
                      }`}>
                        {entry.payment_status || 'Unpaid'}
                      </span>
                    )}
                    {/* 2025 Expenses tag — same control as the recoupable rows. */}
                    <button
                      onClick={() => toggle2025(entry)}
                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold transition-colors ${
                        entry.is_2025_expense
                          ? 'bg-amber-100 text-amber-700 ring-1 ring-amber-200/60 hover:bg-amber-200'
                          : 'text-gray-300 hover:text-amber-700 hover:bg-amber-50'
                      }`}
                      title={entry.is_2025_expense ? '2025 Expense — click to remove from the bucket' : 'Tag as a 2025 Expense (moves to the 2025 subpage)'}
                    >
                      <CalendarClock size={9} /> 2025
                    </button>
                    {/* View invoice — same opener as the recoupable rows so
                        non-recoupable expenses expose their invoice file too. */}
                    {hasInvoiceFile(entry) ? (
                      <button
                        onClick={() => setPreviewFile({
                          url: invoiceUrl(entry),
                          filename: `Invoice-${entry.payee || entry.id}`,
                        })}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
                        title="View invoice"
                      >
                        <FileText size={12} />
                        Invoice
                      </button>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-gray-300 cursor-default"
                        title="No invoice on file"
                      >
                        <FileText size={12} />
                        —
                      </span>
                    )}
                    {/* Promote to recoupable — reuses the same handler used
                        on the main rows, so the undo toast / optimistic
                        update / rollback all match the rest of the page. */}
                    <button
                      onClick={() => toggleRecoupable(entry.id, entry.recoupable)}
                      disabled={savingId === entry.id}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold bg-boom-50 text-boom-700 hover:bg-boom-100 transition-colors disabled:opacity-50"
                      title="Mark this expense as recoupable — moves it into the main list above"
                    >
                      Mark recoupable
                    </button>
                    {!entry.parent_id && (
                      <button
                        onClick={() => openSplitModal(entry)}
                        title="Split this invoice across multiple artists"
                        className="text-xs font-semibold px-2 py-1 rounded-md text-boom-700 bg-card border border-boom-200 hover:bg-boom-50 inline-flex items-center gap-1"
                      >
                        <Copy size={11} /> Split
                      </button>
                    )}
                    <FlagButton
                      flagged={!!entry.flagged}
                      reason={entry.flag_reason || ''}
                      flaggedBy={entry.flagged_by_name || ''}
                      flaggedAt={entry.flagged_at}
                      onToggle={(next, reason) => toggleExpenseFlag(entry.id, next, reason ?? null)}
                      onSaveReason={(reason) => saveExpenseFlagReason(entry.id, reason)}
                      size="sm"
                      alwaysVisible
                    />
                    <CommentThreadButton
                      entryId={entry.id}
                      initialCount={Number(entry.comment_count) || 0}
                      placeholder={'e.g. "Recoupable across the whole contract"'}
                    />
                    <Link
                      to={`/bk/ledger?focus=${entry.id}`}
                      className="p-1.5 rounded-md text-gray-300 hover:bg-gray-50 hover:text-boom-600 transition-colors"
                      title="Open this row in the Ledger"
                    >
                      <ExternalLink size={13} />
                    </Link>
                    <button
                      onClick={() => handleDeleteEntry(entry)}
                      disabled={deletingId === entry.id}
                      className={`p-1.5 rounded-md text-gray-300 hover:bg-red-50 hover:text-red-600 transition-colors ${deletingId === entry.id ? 'opacity-50' : ''}`}
                      title="Delete this expense (soft-delete — recover from the Ledger)"
                    >
                      {deletingId === entry.id ? <Loader size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Undo toast — 10-second window to revert the last mutation on this
          page (toggle, label, song, category, payee rename, delete, add).
          New mutations replace the prior pending undo. Sits above the bulk-
          action bar so it stays visible even during selection. */}
      {undoAction && (
        // bg-[#111827] (arbitrary value) instead of bg-gray-900 — the
        // gray palette is theme-aware (inverted in dark mode), so
        // bg-gray-900 + text-white would resolve to near-white on
        // near-white and the toast would vanish in dark mode. Floating
        // notification overlays should read as dark in BOTH themes.
        <div className="fixed left-1/2 -translate-x-1/2 bottom-24 z-50 flex items-center gap-3 bg-[#111827] text-white rounded-xl shadow-2xl px-5 py-3"
          style={{ animation: 'slideUp 0.18s ease-out' }}>
          <span className="text-sm font-medium">{undoAction.message}</span>
          <button
            onClick={executeUndo}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-card/15 hover:bg-card/25 transition-colors"
          >
            <Undo2 size={12} /> Undo
          </button>
          <button
            onClick={() => {
              if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
              setUndoAction(null)
            }}
            className="text-white/50 hover:text-white text-xs"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Floating bulk-action bar — appears once any row is checked. Lets the
          user batch-label and/or batch-UFR the selection in one action. */}
      {selectedIds.size > 0 && (
        // Same dark-overlay rule as the undo toast above — use a literal
        // hex so it stays a dark surface in dark mode (palette inversion
        // would otherwise wash this out to near-white).
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-[#111827] text-white rounded-xl shadow-2xl px-5 py-3"
          style={{ animation: 'slideUp 0.18s ease-out' }}>
          <span className="text-sm font-bold">{selectedIds.size} selected</span>
          <span className="text-xs text-white/50">·</span>
          <span className="text-sm tabular-nums">
            {fmtTotals(groupByCurrency(filtered.filter(e => selectedIds.has(e.id))))}
            <span className="text-white/50">{usdItemsSuffix(filtered.filter(e => selectedIds.has(e.id)), fxRates)}</span>
          </span>
          <div className="w-px h-5 bg-card/15 mx-1" />
          {/* Add to plan — stashes the selected IDs into the shared
              localStorage plan store. Reachable from the Planning
              page where the operator groups + labels them before
              committing UFR. Only shows when Pending items are
              selected (already-UFR'd rows can't be planned again). */}
          {(() => {
            const selectedList = Array.from(selectedIds)
            const eligible = selectedList.filter(id => {
              const e = entries.find(x => x.id === id)
              return e && e.ufr !== 'Yes'
            })
            if (!eligible.length) return null
            return (
              <button
                onClick={() => {
                  setPlan(addToPlan(eligible))
                  clearSelection()
                  toast(`Added ${eligible.length} item${eligible.length === 1 ? '' : 's'} to the plan`)
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-card/10 hover:bg-card/20 transition-colors"
                title="Stage these items on the Planning page for grouping + labeling before upload"
              >
                <FolderOpen size={12} /> Add to plan ({eligible.length})
              </button>
            )
          })()}
          <button
            onClick={() => {
              const ids = Array.from(selectedIds)
              const first = entries.find(e => ids.includes(e.id))?.recoupment_label || ''
              openLabelModal('bulk', ids, first, false)
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-card/10 hover:bg-card/20 transition-colors"
          >
            <Tag size={12} /> Set Label
          </button>
          <button
            onClick={() => {
              const ids = Array.from(selectedIds)
              const first = entries.find(e => ids.includes(e.id))?.recoupment_label || ''
              openLabelModal('bulk', ids, first, true)
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-500 hover:bg-emerald-600 transition-colors"
            title="Set the same label on every selected item AND mark them all as Uploaded for Recoupment"
          >
            <Check size={12} /> Set Label & Mark UFR
          </button>
          {/* Bulk move — only surfaced when at least one selected row is
              UFR'd (has a statement bucket). The 20th-cutoff rule means
              new uploads on day 21+ roll forward to next month; this
              lets the operator pull them back. */}
          {(() => {
            const movable = filtered.filter(e =>
              selectedIds.has(e.id) && e.ufr === 'Yes' && !!e.ufr_marked_at
            )
            if (!movable.length) return null
            return (
              <button
                onClick={openBulkMove}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-500 hover:bg-amber-600 transition-colors"
                title={`Move ${movable.length} UFR'd item${movable.length === 1 ? '' : 's'} to a different monthly statement`}
              >
                <FolderOpen size={12} /> Move to month ({movable.length})
              </button>
            )
          })()}
          <button
            onClick={clearSelection}
            className="text-xs font-semibold text-white/60 hover:text-white px-2 py-1"
          >
            Clear
          </button>
        </div>
      )}

      {/* Bulk Move modal — native <input type="month"> picks a target
          statement bucket. Submit applies the same first-of-month UTC
          stamp moveUfrToStatement uses, in parallel across every
          eligible selected row. */}
      {bulkMoveOpen && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-6"
          onClick={() => !bulkMoveSaving && setBulkMoveOpen(false)}>
          <div className="bg-card rounded-2xl shadow-2xl w-full max-w-md p-6"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center">
                <FolderOpen size={16} />
              </div>
              <h3 className="text-base font-bold text-gray-900">Move to statement month</h3>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              {(() => {
                const movable = filtered.filter(e =>
                  selectedIds.has(e.id) && e.ufr === 'Yes' && !!e.ufr_marked_at
                )
                const skipped = selectedIds.size - movable.length
                return (
                  <>
                    {movable.length} UFR'd item{movable.length === 1 ? '' : 's'} will move to the chosen month.
                    {skipped > 0 && ` ${skipped} non-UFR'd item${skipped === 1 ? '' : 's'} in the selection will be skipped.`}
                  </>
                )
              })()}
            </p>
            <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-1">Statement month</label>
            <input
              type="month"
              autoFocus
              value={bulkMoveYm}
              onChange={e => setBulkMoveYm(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && bulkMoveYm) submitBulkMove() }}
              className="w-full px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => !bulkMoveSaving && setBulkMoveOpen(false)}
                disabled={bulkMoveSaving}
                className="px-3 py-1.5 rounded-lg text-xs font-bold text-gray-700 bg-card border border-rule hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={submitBulkMove}
                disabled={bulkMoveSaving || !bulkMoveYm}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-white bg-amber-500 hover:bg-amber-600 disabled:opacity-50"
              >
                {bulkMoveSaving ? <Loader size={12} className="animate-spin" /> : <FolderOpen size={12} />}
                Move
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Label-editor modal. Used by both single-row chip clicks and bulk
          action-bar buttons. Native <datalist> handles autocomplete from
          previously-used labels for free. */}
      {labelModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-6"
          onClick={() => !savingLabel && setLabelModal(null)}>
          <div className="bg-card rounded-2xl shadow-2xl w-full max-w-md p-6"
            onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900 mb-1">
              {labelModal.mode === 'bulk'
                ? `${labelModal.alsoUfr ? 'Label & Upload' : 'Label'} ${labelModal.ids.length} item${labelModal.ids.length === 1 ? '' : 's'}`
                : 'Recoupment label'}
            </h3>
            <p className="text-xs text-gray-500 mb-4">
              {labelModal.mode === 'bulk' && labelModal.alsoUfr
                ? 'Marks every selected item as Uploaded for Recoupment under this shared label so you can find them as a group later.'
                : 'A free-form note (e.g. "Digital Marketing — Song X") that ties items together as one upload batch.'}
            </p>
            <input
              type="text"
              defaultValue={labelModal.initial}
              placeholder='e.g. "Digital Marketing — Song X"'
              list="recoupment-label-options"
              autoFocus
              disabled={savingLabel}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  applyLabel(e.currentTarget.value, labelModal.ids, labelModal.alsoUfr)
                } else if (e.key === 'Escape') {
                  setLabelModal(null)
                }
              }}
              ref={(el) => {
                if (el) {
                  // Stash the live value on the modal node so the action buttons
                  // below can read it without a controlled-input round-trip.
                  el.dataset.role = 'label-input'
                }
              }}
              className="w-full px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
            />
            <datalist id="recoupment-label-options">
              {existingLabels.map(l => <option key={l} value={l} />)}
            </datalist>
            <div className="flex items-center justify-between gap-2 mt-5">
              {/* Clear button — only shows when editing an existing label so
                  users can remove an item from its batch in one click. */}
              {labelModal.initial ? (
                <button
                  onClick={() => applyLabel('', labelModal.ids, false)}
                  disabled={savingLabel}
                  className="text-xs font-semibold text-red-600 hover:text-red-700 disabled:opacity-50"
                >
                  Clear label
                </button>
              ) : <span />}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setLabelModal(null)}
                  disabled={savingLabel}
                  className="px-4 py-2 text-sm font-semibold text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={(e) => {
                    const input = e.currentTarget.closest('.bg-card')?.querySelector('input[data-role="label-input"]')
                    applyLabel(input?.value || '', labelModal.ids, labelModal.alsoUfr)
                  }}
                  disabled={savingLabel}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-white bg-boom-600 hover:bg-boom-700 rounded-lg disabled:opacity-50"
                >
                  {savingLabel ? <Loader size={13} className="animate-spin" /> : <Check size={13} />}
                  {labelModal.alsoUfr ? 'Save & Mark UFR' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Notes modal — per-row free-form notes. Auto-focused textarea,
          Esc cancels, Cmd/Ctrl+Enter saves. Same scrim / card chrome
          as the rest of the page so nothing reads as a foreign surface. */}
      {notesModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-6"
          onClick={() => !savingNotes && setNotesModal(null)}>
          <div className="bg-card rounded-2xl shadow-2xl w-full max-w-lg p-6"
            onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900 mb-1 inline-flex items-center gap-2">
              <StickyNote size={15} className="text-amber-600" /> Note
            </h3>
            <p className="text-xs text-gray-500 mb-4">
              Free-form note for this expense. Same field shown on the Ledger's Notes column.
            </p>
            <textarea
              defaultValue={notesModal.initial}
              autoFocus
              disabled={savingNotes}
              rows={5}
              placeholder="Anything you want future-you (or another admin) to know about this expense…"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setNotesModal(null)
                } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  applyNotes(e.currentTarget.value, notesModal.id)
                }
              }}
              ref={(el) => { if (el) el.dataset.role = 'notes-input' }}
              className="w-full px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400 resize-y"
            />
            <div className="flex items-center justify-between gap-2 mt-5">
              {/* Clear button — only when there's something to clear. */}
              {notesModal.initial ? (
                <button
                  onClick={() => applyNotes('', notesModal.id)}
                  disabled={savingNotes}
                  className="text-xs font-semibold text-red-600 hover:text-red-700 disabled:opacity-50"
                >
                  Clear note
                </button>
              ) : <span />}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setNotesModal(null)}
                  disabled={savingNotes}
                  className="px-4 py-2 text-sm font-semibold text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={(e) => {
                    const ta = e.currentTarget.closest('.bg-card')?.querySelector('textarea[data-role="notes-input"]')
                    applyNotes(ta?.value || '', notesModal.id)
                  }}
                  disabled={savingNotes}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-white bg-boom-600 hover:bg-boom-700 rounded-lg disabled:opacity-50"
                >
                  {savingNotes ? <Loader size={13} className="animate-spin" /> : <Check size={13} />}
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Song-editor modal. Two modes:
          • 'single' edits one row (chip click on a row),
          • 'group'  renames the song for every item in a group — the bulk
            cleanup for case-variant duplicates ("Face it all" → "Face It
            All"). Autocompletes against the union of existing song spellings. */}
      {songModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-6"
          onClick={() => !savingSong && setSongModal(null)}>
          <div className="bg-card rounded-2xl shadow-2xl w-full max-w-md p-6"
            onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900 mb-1">
              {songModal.mode === 'group'
                ? `Rename song for ${songModal.ids.length} item${songModal.ids.length === 1 ? '' : 's'}`
                : 'Song'}
            </h3>
            <p className="text-xs text-gray-500 mb-4">
              {songModal.mode === 'group'
                ? "Updates the 'song' field on every item in this group — use it to normalize capitalization (e.g. 'Face it all' → 'Face It All') across a whole batch."
                : "Edit just this item's song. Move it into a different group by setting the matching song name."}
            </p>
            <input
              type="text"
              defaultValue={songModal.initial}
              placeholder="Song name"
              list="recoupment-song-options"
              autoFocus
              disabled={savingSong}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applySong(e.currentTarget.value, songModal.ids)
                else if (e.key === 'Escape') setSongModal(null)
              }}
              ref={(el) => { if (el) el.dataset.role = 'song-input' }}
              className="w-full px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
            />
            <datalist id="recoupment-song-options">
              {existingSongs.map(s => <option key={s} value={s} />)}
            </datalist>
            <div className="flex items-center justify-between gap-2 mt-5">
              {songModal.initial ? (
                <button
                  onClick={() => applySong('', songModal.ids)}
                  disabled={savingSong}
                  className="text-xs font-semibold text-red-600 hover:text-red-700 disabled:opacity-50"
                  title="Clear the song field on the selected item(s)"
                >
                  Clear song
                </button>
              ) : <span />}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setSongModal(null)}
                  disabled={savingSong}
                  className="px-4 py-2 text-sm font-semibold text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={(e) => {
                    const input = e.currentTarget.closest('.bg-card')?.querySelector('input[data-role="song-input"]')
                    applySong(input?.value || '', songModal.ids)
                  }}
                  disabled={savingSong}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-white bg-boom-600 hover:bg-boom-700 rounded-lg disabled:opacity-50"
                >
                  {savingSong ? <Loader size={13} className="animate-spin" /> : <Check size={13} />}
                  {songModal.mode === 'group' ? 'Rename all' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Category-editor modal — same shape as the song editor; writes the
          'category' field on the selected entry/ies. Autocomplete pulls from
          the canonical CATEGORIES list plus any wild values already on the
          data so legacy / non-canonical categories stay reachable. */}
      {categoryModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-6"
          onClick={() => !savingCategory && setCategoryModal(null)}>
          <div className="bg-card rounded-2xl shadow-2xl w-full max-w-md p-6"
            onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900 mb-1">
              {categoryModal.mode === 'group'
                ? `Rename category for ${categoryModal.ids.length} item${categoryModal.ids.length === 1 ? '' : 's'}`
                : 'Category'}
            </h3>
            <p className="text-xs text-gray-500 mb-4">
              {categoryModal.mode === 'group'
                ? "Updates the 'category' field on every item in this group — useful for cleaning up legacy / typo'd categories in one pass."
                : "Pick the spend category from the dropdown. Includes the canonical list plus any custom values already on your expenses."}
            </p>
            {/* Native <select> shows every option on click instead of the
                datalist's match-the-typed-text filtering. Includes any existing
                value already on this row (even if non-canonical) so the current
                state isn't accidentally cleared. */}
            <select
              defaultValue={
                categoryOptions.includes(categoryModal.initial) || !categoryModal.initial
                  ? categoryModal.initial
                  : '__keep__'
              }
              autoFocus
              disabled={savingCategory}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setCategoryModal(null)
              }}
              ref={(el) => { if (el) el.dataset.role = 'category-input' }}
              className="w-full px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
            >
              <option value="">— (no category)</option>
              {/* If the current value isn't in the canonical/derived list,
                  surface it as a "keep current" option so saving without a
                  change doesn't blank the field. */}
              {categoryModal.initial && !categoryOptions.includes(categoryModal.initial) && (
                <option value="__keep__">{categoryModal.initial} (current)</option>
              )}
              {categoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <div className="flex items-center justify-between gap-2 mt-5">
              {categoryModal.initial ? (
                <button
                  onClick={() => applyCategory('', categoryModal.ids)}
                  disabled={savingCategory}
                  className="text-xs font-semibold text-red-600 hover:text-red-700 disabled:opacity-50"
                  title="Clear the category field on the selected item(s)"
                >
                  Clear category
                </button>
              ) : <span />}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCategoryModal(null)}
                  disabled={savingCategory}
                  className="px-4 py-2 text-sm font-semibold text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={(e) => {
                    const sel = e.currentTarget.closest('.bg-card')?.querySelector('[data-role="category-input"]')
                    // '__keep__' sentinel means the row's current non-canonical value
                    // was selected — pass through unchanged.
                    const raw = sel?.value ?? ''
                    const next = raw === '__keep__' ? (categoryModal.initial || '') : raw
                    applyCategory(next, categoryModal.ids)
                  }}
                  disabled={savingCategory}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-white bg-boom-600 hover:bg-boom-700 rounded-lg disabled:opacity-50"
                >
                  {savingCategory ? <Loader size={13} className="animate-spin" /> : <Check size={13} />}
                  {categoryModal.mode === 'group' ? 'Rename all' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Payee editor — renames the bold vendor name on one row via PUT
          /bk/entries/:id. Scoped to a single entry by design: bulk-rename
          a vendor across all their expenses still lives on /bk/vendors. */}
      {payeeModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-6"
          onClick={() => !savingPayee && setPayeeModal(null)}>
          <div className="bg-card rounded-2xl shadow-2xl w-full max-w-md p-6"
            onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900 mb-1">Rename payee</h3>
            <p className="text-xs text-gray-500 mb-4">
              Updates the payee on this expense only. To rename a vendor across
              every expense, use the Vendors page.
            </p>
            <input
              type="text"
              defaultValue={payeeModal.initial}
              placeholder="Payee / vendor name"
              autoFocus
              disabled={savingPayee}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyPayee(e.currentTarget.value, payeeModal.id)
                else if (e.key === 'Escape') setPayeeModal(null)
              }}
              ref={(el) => { if (el) el.dataset.role = 'payee-input' }}
              className="w-full px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
            />
            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                onClick={() => setPayeeModal(null)}
                disabled={savingPayee}
                className="px-4 py-2 text-sm font-semibold text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={(e) => {
                  const input = e.currentTarget.closest('.bg-card')?.querySelector('input[data-role="payee-input"]')
                  applyPayee(input?.value || '', payeeModal.id)
                }}
                disabled={savingPayee}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-white bg-boom-600 hover:bg-boom-700 rounded-lg disabled:opacity-50"
              >
                {savingPayee ? <Loader size={13} className="animate-spin" /> : <Check size={13} />}
                {savingPayee ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {socialsModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6"
          onClick={() => !savingSocials && setSocialsModal(null)}>
          <div
            className="bg-card rounded-t-2xl rounded-b-none sm:rounded-2xl shadow-2xl w-full max-w-md p-6 max-h-[85dvh] overflow-y-auto"
            style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
            onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900 mb-1">Socials</h3>
            <p className="text-xs text-gray-500 mb-4">
              Platform + handle for this expense. Vendor-supplied on submit; editable here.
              Same field shown on the Ledger.
            </p>
            <div className="space-y-2 mb-3">
              {socialsRows.length === 0 && (
                <div className="text-xs text-gray-400">No socials yet — add one below.</div>
              )}
              {socialsRows.map((row, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <select
                      value={row.platform || 'Instagram'}
                      onChange={e => setSocialsRows(rs => rs.map((r, idx) => idx === i ? { ...r, platform: e.target.value } : r))}
                      disabled={savingSocials}
                      className="px-2 py-2 text-xs border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400 shrink-0"
                      style={{ width: 124 }}
                    >
                      {SOCIAL_PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                    <input
                      type="text"
                      value={row.handle || ''}
                      onChange={e => setSocialsRows(rs => rs.map((r, idx) => idx === i ? { ...r, handle: e.target.value } : r))}
                      placeholder="@handle or url"
                      disabled={savingSocials}
                      className="flex-1 px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400 min-w-0"
                    />
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={row.amount || ''}
                      onChange={e => setSocialsRows(rs => rs.map((r, idx) => idx === i ? { ...r, amount: e.target.value } : r))}
                      placeholder="$"
                      title="Amount paid to this creator (optional)"
                      disabled={savingSocials}
                      className="w-20 px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
                    />
                    <button
                      type="button"
                      onClick={() => setSocialsRows(rs => rs.filter((_, idx) => idx !== i))}
                      disabled={savingSocials}
                      className="text-gray-400 hover:text-red-600 disabled:opacity-50 p-1"
                      title="Remove"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {/* Per-row artist tag — surfaces only when the invoice
                      is a split (multiple artists in the family). Empty =
                      shared across every artist on the invoice. */}
                  {(socialsModal?.familyArtists || []).length > 1 && (
                    <div className="flex items-center gap-2 pl-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500 shrink-0" style={{ minWidth: 62 }}>For artist</span>
                      <select
                        value={row.artist || ''}
                        onChange={e => setSocialsRows(rs => rs.map((r, idx) => idx === i ? { ...r, artist: e.target.value } : r))}
                        disabled={savingSocials}
                        className="flex-1 px-2 py-1.5 text-xs border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400 min-w-0"
                      >
                        <option value="">All artists (untagged)</option>
                        {(socialsModal.familyArtists || []).map(a => <option key={a} value={a}>{a}</option>)}
                      </select>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setSocialsRows(rs => [...rs, { platform: 'Instagram', handle: '', artist: '', amount: '' }])}
              disabled={savingSocials}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold border border-dashed border-rule rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <Plus size={12} /> Add row
            </button>
            {/* Running total of per-creator amounts vs the row amount. */}
            {(() => {
              const sum = socialsRows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)
              if (!(sum > 0)) return null
              const target = entries.find(en => en.id === socialsModal.id)
              const cur = target?.currency || 'USD'
              const rowAmt = target != null ? Number(target.amount) : null
              const balanced = rowAmt != null && Math.abs(sum - rowAmt) < 0.01
              return (
                <div className={`text-xs rounded-lg px-3 py-2 mt-3 flex items-center justify-between ${
                  rowAmt == null
                    ? 'bg-gray-50 text-gray-600 ring-1 ring-gray-200/60'
                    : balanced
                      ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60'
                      : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200/60'
                }`}>
                  <span className="font-semibold">
                    Total: <span className="tabular-nums">{fmt(sum, cur)}</span>
                    {rowAmt != null && <> of <span className="tabular-nums">{fmt(rowAmt, cur)}</span></>}
                  </span>
                  {rowAmt != null && !balanced && (
                    <span className="font-bold tabular-nums">
                      {rowAmt - sum > 0 ? `${fmt(rowAmt - sum, cur)} left` : `${fmt(sum - rowAmt, cur)} over`}
                    </span>
                  )}
                  {balanced && <CheckCircle2 size={13} />}
                </div>
              )
            })()}
            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                onClick={() => setSocialsModal(null)}
                disabled={savingSocials}
                className="px-4 py-2 text-sm font-semibold text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => applySocials(socialsRows, socialsModal.id)}
                disabled={savingSocials}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-white bg-boom-600 hover:bg-boom-700 rounded-lg disabled:opacity-50"
              >
                {savingSocials ? <Loader size={13} className="animate-spin" /> : <Check size={13} />}
                {savingSocials ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add-Expense modal. Same fields and same POST endpoint
          (/api/artists/:id/budget/expenses) the Artist Budget page uses —
          server-side recoupable is forced true on this path, so every row
          created here lands on the Recoupments view automatically. Closing
          this gap is the prerequisite for retiring the Budget page. */}
      {addModalOpen && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-6"
          onClick={closeAddModal}>
          <div className="bg-card rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}>
            <div className="px-6 py-5 border-b border-divider flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-gray-900">
                  {isDetail ? `Add Expense — ${detailArtist}` : 'Add Expense'}
                </h3>
                <p className="text-xs text-gray-500 mt-0.5">Saved as a real expense — appears here and in the Ledger / Lookup / Financials. Auto-marked recoupable.</p>
              </div>
              <button onClick={closeAddModal} disabled={addSaving} className="text-gray-400 hover:text-gray-700 disabled:opacity-50">
                <X size={18} />
              </button>
            </div>

            <div className="px-6 py-5 grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Artist input on the INDEX view — pinned via route on
                  detail, so we hide this when there's an artistInfo.id
                  to avoid the redundant field. allArtists supplies the
                  autocomplete suggestions so common typos collapse to
                  an existing spelling. */}
              {!artistInfo?.id && (
                <div className="md:col-span-2">
                  <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-1">Artist <span className="text-red-500">*</span></label>
                  <input
                    type="text"
                    list="recoupment-add-artist-options"
                    value={addForm.artist}
                    onChange={e => setAddForm(f => ({ ...f, artist: e.target.value }))}
                    placeholder="Which artist owns this expense?"
                    className="w-full px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
                  />
                  <datalist id="recoupment-add-artist-options">
                    {allArtists.map(a => <option key={a} value={a} />)}
                  </datalist>
                </div>
              )}
              <div className="md:col-span-2">
                <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-1">Payee <span className="text-red-500">*</span></label>
                <input type="text" value={addForm.payee} onChange={e => setAddForm(f => ({ ...f, payee: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400" />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-1">Category</label>
                <select value={addForm.category} onChange={e => setAddForm(f => ({ ...f, category: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400">
                  <option value="">—</option>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-1">Date</label>
                <input type="date" value={addForm.date} onChange={e => setAddForm(f => ({ ...f, date: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400" />
              </div>
              <div className="md:col-span-2">
                <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-1">Description <span className="text-red-500">*</span></label>
                <input type="text" value={addForm.description} onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400" />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-1">Amount <span className="text-red-500">*</span></label>
                <input type="number" step="0.01" value={addForm.amount} onChange={e => setAddForm(f => ({ ...f, amount: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400" />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-1">Currency</label>
                <select value={addForm.currency} onChange={e => setAddForm(f => ({ ...f, currency: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400">
                  {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-1">Song <span className="text-gray-400 normal-case font-medium">(optional — drops it into the matching Recoupments group)</span></label>
                <input type="text" list="recoupment-song-options" value={addForm.song} onChange={e => setAddForm(f => ({ ...f, song: e.target.value }))}
                  placeholder="e.g. Face It All"
                  className="w-full px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400" />
              </div>
              {/* Release dropdown only relevant on the detail view —
                  artistInfo.releases is the artist's release list. Hidden
                  on the index since we'd just show "(none)". */}
              {artistInfo?.id && (
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-1">Release</label>
                  <select value={addForm.release_id} onChange={e => setAddForm(f => ({ ...f, release_id: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400">
                    <option value="">— (none)</option>
                    {(artistInfo?.releases || []).map(r => <option key={r.id} value={r.id}>{r.project_name}</option>)}
                  </select>
                </div>
              )}
              {/* Optional socials — [platform][handle], unlimited rows.
                  Empty rows are dropped on submit so no `[]` gets stamped
                  onto the expense. */}
              <div className="md:col-span-2">
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500">Socials <span className="text-gray-400 normal-case font-medium">(optional)</span></label>
                  {(
                    <button
                      type="button"
                      onClick={() => setAddForm(f => ({ ...f, socials: [...(f.socials || []), { platform: 'Instagram', handle: '' }] }))}
                      className="text-[11px] font-semibold text-boom-600 hover:text-boom-700 inline-flex items-center gap-1"
                    >
                      <Plus size={11} /> Add another
                    </button>
                  )}
                </div>
                <div className="space-y-1.5">
                  {addForm.socials.map((s, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <select
                        value={s.platform}
                        onChange={e => setAddForm(f => ({ ...f, socials: f.socials.map((r, idx) => idx === i ? { ...r, platform: e.target.value } : r) }))}
                        className="px-2 py-2 text-xs border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400 shrink-0"
                        style={{ width: 124 }}
                      >
                        {SOCIAL_PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                      <input
                        type="text"
                        value={s.handle}
                        onChange={e => setAddForm(f => ({ ...f, socials: f.socials.map((r, idx) => idx === i ? { ...r, handle: e.target.value } : r) }))}
                        placeholder="@handle or profile URL"
                        className="flex-1 min-w-0 px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
                      />
                      {addForm.socials.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setAddForm(f => ({ ...f, socials: f.socials.filter((_, idx) => idx !== i) }))}
                          title="Remove this social"
                          className="p-1 text-gray-400 hover:text-red-600"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <div className="md:col-span-2">
                <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-1">Notes</label>
                <textarea rows={2} value={addForm.notes} onChange={e => setAddForm(f => ({ ...f, notes: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400 resize-y" />
              </div>
              <div className="md:col-span-2">
                <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-1">Receipt <span className="text-gray-400 normal-case font-medium">(optional)</span></label>
                <div className="flex items-center gap-2">
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-dashed border-gray-300 hover:border-boom-400 hover:text-boom-700 cursor-pointer transition-colors">
                    <Upload size={12} /> Choose file
                    <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp"
                      onChange={e => setAddReceipt(e.target.files?.[0] || null)}
                      className="hidden" />
                  </label>
                  {addReceipt && (
                    <span className="text-xs text-gray-600 truncate">{addReceipt.name}</span>
                  )}
                  {addReceipt && (
                    <button onClick={() => setAddReceipt(null)} className="text-xs text-red-600 hover:text-red-700">Remove</button>
                  )}
                </div>
              </div>
              <div className="md:col-span-2 flex flex-wrap items-center gap-x-6 gap-y-2 pt-1">
                <span className="inline-flex items-center gap-2 text-sm text-gray-500">
                  <span className="inline-flex items-center justify-center w-4 h-4 rounded bg-emerald-500 text-white text-[10px] font-bold">✓</span>
                  Recoupable <span className="text-xs text-gray-400">(auto)</span>
                </span>
                <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input type="checkbox" checked={addForm.ufr} onChange={e => setAddForm(f => ({ ...f, ufr: e.target.checked }))}
                    className="w-4 h-4 accent-boom-600" />
                  Uploaded for Recoupment
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input type="checkbox" checked={addForm.paid} onChange={e => setAddForm(f => ({ ...f, paid: e.target.checked }))}
                    className="w-4 h-4 accent-boom-600" />
                  Marked as paid
                </label>
              </div>
              {addError && (
                <div className="md:col-span-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{addError}</div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-divider flex items-center justify-end gap-2 bg-gray-50/40">
              <button onClick={closeAddModal} disabled={addSaving}
                className="px-4 py-2 text-sm font-semibold text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 disabled:opacity-50">
                Cancel
              </button>
              <button onClick={saveNewExpense} disabled={addSaving}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-white bg-boom-600 hover:bg-boom-700 rounded-lg disabled:opacity-50">
                {addSaving ? <Loader size={13} className="animate-spin" /> : <Check size={13} />}
                {addSaving ? 'Saving…' : 'Save Expense'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Split modal — divides one parent expense across multiple artists.
          Server creates child rows (parent_id set) that inherit the file
          from the parent; the parent stays as the canonical record but no
          longer counts toward any single artist's recoupment total. */}
      {splitModal && (() => {
        const cur = splitModal.row.currency || 'USD'
        const total = Number(splitModal.row.amount) || 0
        const allocated = splitModal.rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)
        const remaining = total - allocated
        const remainingClose = Math.abs(remaining) < 0.01
        return (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-6"
            onClick={() => !splitSaving && setSplitModal(null)}>
            <div className="bg-card rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto"
              onClick={e => e.stopPropagation()}>
              <div className="px-6 py-5 border-b border-divider flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-gray-900">Split across artists</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {splitModal.row.payee || '—'} · {fmt(total, cur)} {cur !== 'USD' && (
                      <span className="text-gray-400">{usdSuffixForEntry(splitModal.row, fxRates)}</span>
                    )}
                  </p>
                </div>
                <button onClick={() => setSplitModal(null)} disabled={splitSaving}
                  className="text-gray-400 hover:text-gray-700 disabled:opacity-50">
                  <X size={18} />
                </button>
              </div>

              <div className="px-6 py-5">
                <div className="grid grid-cols-12 gap-2 text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-2">
                  <div className="col-span-4">Artist <span className="text-red-500">*</span></div>
                  <div className="col-span-4">Song</div>
                  <div className="col-span-3">Amount ({cur}) <span className="text-red-500">*</span></div>
                  <div className="col-span-1"></div>
                </div>
                <div className="space-y-2">
                  {splitModal.rows.map((r, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2 items-center">
                      <input type="text" value={r.artist}
                        onChange={e => updateSplitRow(i, 'artist', e.target.value)}
                        placeholder="Artist name"
                        list="recoupment-split-artist-options"
                        className="col-span-4 px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400" />
                      <input type="text" value={r.song}
                        onChange={e => updateSplitRow(i, 'song', e.target.value)}
                        placeholder="(optional)"
                        list="recoupment-song-options"
                        className="col-span-4 px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400" />
                      <input type="number" step="0.01" value={r.amount}
                        onChange={e => updateSplitRow(i, 'amount', e.target.value)}
                        className="col-span-3 px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400" />
                      <button onClick={() => removeSplitRow(i)}
                        disabled={splitModal.rows.length <= 2}
                        title={splitModal.rows.length <= 2 ? 'Need at least 2 rows' : 'Remove row'}
                        className="col-span-1 p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <datalist id="recoupment-split-artist-options">
                  {allArtists.map(a => <option key={a} value={a} />)}
                </datalist>

                <div className="mt-3 flex items-center justify-between">
                  <button onClick={addSplitRow}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold text-boom-700 bg-boom-50 hover:bg-boom-100 border border-boom-200">
                    <Plus size={12} /> Add row
                  </button>
                  <div className="text-xs text-gray-600">
                    Allocated <span className="font-bold text-gray-900">{fmt(allocated, cur)}</span>
                    {' · '}
                    Remaining{' '}
                    <span className={`font-bold ${remainingClose ? 'text-emerald-700' : 'text-red-600'}`}>
                      {fmt(remaining, cur)}
                    </span>
                  </div>
                </div>

                <div className="mt-4 text-[11px] text-gray-500 leading-relaxed">
                  Original parent expense is preserved (with the invoice file). Child rows are created per artist
                  and inherit the file via the family link. Mark Recoupable / UFR / Paid status carry to children.
                </div>
              </div>

              <div className="px-6 py-4 border-t border-divider flex items-center justify-end gap-2 bg-gray-50/40">
                <button onClick={() => setSplitModal(null)} disabled={splitSaving}
                  className="px-4 py-2 text-sm font-semibold text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={submitSplit} disabled={splitSaving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-white bg-boom-600 hover:bg-boom-700 rounded-lg disabled:opacity-50">
                  {splitSaving ? <Loader size={13} className="animate-spin" /> : <Check size={13} />}
                  {splitSaving ? 'Splitting…' : 'Save split'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
