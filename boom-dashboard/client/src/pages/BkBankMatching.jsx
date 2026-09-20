import { Fragment, useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { Landmark, Loader, CheckCircle2, AlertCircle, AlertTriangle, RefreshCw, Link2, X, ChevronDown, ChevronRight, Plus, Ban, Zap, Flag, Undo2, FileText, FileX, Layers } from 'lucide-react'
import api from '../api'
import UnmatchedLedgerPanel from '../components/UnmatchedLedgerPanel'
import CategorySelect from '../components/CategorySelect'
import { useCategoriesContext } from '../context/CategoriesContext'
import ReviewDeck, { DeckButton, useDeckPreview } from '../components/ReviewDeck'
import InlineFilePreview from '../components/InlineFilePreview'
// The one picker for "which invoice(s) did this payment settle" — shared with
// the vendor page so the two cannot drift on what attaching means.
import InvoiceAttachPicker from '../components/InvoiceAttachPicker'
import ArtistSelect from '../components/ArtistSelect'
import FilePreview from '../components/FilePreview'
import { pickDoc, fileUrl } from '../utils/entryFiles'
// Shared with the Spend by Artist report via server/routes/reports.js's mirror
// of the same placeholder list — the two must agree on what counts as an artist.
import { artistBucket } from '../utils'
import {
  acctLabel, stmtLabel, viewStmtFile, fmt,
  cleanBankPayee, fmtDate, suggestionWhen, displayCaseTitle,
  normTxt, restates,
  CANDIDATE_FIELDS, candidateDiff, nearIdentical, sharedLine, txVendorLinkName,
} from '../utils/bankDisplay'
// The bank month, held outside the component tree so it survives switching to
// another Banking tab (each tab is its own route, so this page unmounts).
import {
  useBankScope, setBankStatement, fetchStatementDetail,
  fetchStatements as loadBankStatements, reloadBankCompletion,
} from '../lib/bankScope'
import PayeeLink from '../components/PayeeLink'
import PickerMenu from '../components/PickerMenu'

// "Is this recoupable?" — asked where the row is being decided.
//
// THREE states, which is why this is two buttons and not a checkbox.
// `expenses.recoupable` is BOOLEAN DEFAULT TRUE and the booking path never set
// it, so a row nobody has looked at already claims to be recoupable — a ticked
// checkbox would draw that claim as an answer. Unanswered is BOTH buttons
// unpressed, and a row booked that way behaves exactly as bookings did before:
// it goes to the recoupment queue and somebody is asked there.
//
// Pressing the answer already showing clears it back to unanswered, so a
// mis-click is undoable without leaving the card.
//
// Ink fill for whichever side was chosen, per the statements design language —
// red is for alerts here, and neither answer is a problem.
function RecoupAnswer({ value, onChange, disabled = false, compact = false }) {
  const pad = compact ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-[11.5px]'
  const cls = (on) => `rounded-lg font-bold ${pad} disabled:opacity-40 ${on
    ? 'bg-ink text-card'
    : 'border border-rule text-gray-500 hover:text-ink hover:border-gray-300'}`
  const pick = (v) => onChange(value === v ? null : v)
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className={`font-semibold text-gray-500 ${compact ? 'text-[10px]' : 'text-[11px]'}`}>
        Recoupable?
      </span>
      <button type="button" disabled={disabled} onClick={() => pick(true)}
        title="This cost can be billed back to the artist. Recorded as an answer, so the row never reaches the recoupment queue."
        className={cls(value === true)}>Yes</button>
      <button type="button" disabled={disabled} onClick={() => pick(false)}
        title="The label absorbs this one. Clears recoupable, so the row stops claiming to be recoupable everywhere else."
        className={cls(value === false)}>No</button>
      <span className="text-[10px] text-gray-400">
        {value === true ? 'bills back to the artist'
          : value === false ? 'the label absorbs it'
            : 'unanswered — Recoupments will ask'}
      </span>
    </div>
  )
}

// What the ledger already says about this row, as the same three states.
//
// Reads the PAIR from FAMILY_SQL: `recoup_reviewed` is what separates an answer
// from the column's default. Only a row this app booked can be answered here —
// a row matched to a real invoice carries the invoice's own recoupable, decided
// where the invoice was entered, and this page must not overwrite it.
const recoupAnswerOf = (item) => (item?.matched?.recoup_reviewed === true
  ? item.matched.recoupable !== false
  : null)

// Bank Matching — tie every line on the bank statements to the ledger.
// Admin/Superadmin only (Approvers don't see bank balances).
//
// This page is the WORK; /bk/statements is the FILES (upload, month coverage,
// statement flags). Not to be confused with /bk/ledger-matching ("Bookkeeper
// Reconcile"), which diffs the outside bookkeeper's spreadsheet against our
// ledger — a different job that the similar name keeps sending people to.
//
// Every open bank line has exactly three honest answers: it's this invoice
// (match), there is no invoice for it (book), or it isn't really spending
// (set aside). The P&L counts bank rows, so all three MOVE REPORTED NUMBERS —
// which is why the UI separates the reversible actions from the ones that
// don't just reorganize, they change what gets reported.

export default function BkBankMatching() {
  const { user } = useAuth()
  // Live category vocabularies — see context/CategoriesContext. The deck
  // snapshots a usage-sorted copy at open (deck.cats) so numbering stays
  // stable mid-run; these are the source it sorts.
  const { expense: catExpense, income: catIncome } = useCategoriesContext()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // ── URL is the source of truth for what you're looking at ───────────────
  //
  // On the old combined page these were plain booleans, so nothing deep-linked,
  // the back button didn't leave the deck, and a refresh dropped you back to
  // the statement library. They live in the query string now.
  //
  //   ?statement=<id|all>   which statement's rows (default: all)
  //   ?filter=open|all|…    disposition filter
  //
  // QUEUE-FIRST: 'all' is the default because reconciliation is a month of work
  // spread across whatever files it arrived in, not a file you open.
  const urlQ = new URLSearchParams(window.location.search)
  // Which statement, from the SHARED bank scope rather than local state.
  //
  // This page is one tab of the Banking family and the other three are separate
  // routes, so switching to Categorized unmounts it — a month held in useState
  // would not survive the trip. lib/bankScope.js holds it outside the tree and
  // seeds itself from ?statement=, so every deep link into this page still
  // lands scoped exactly as it did.
  //
  // 'all' stays THIS PAGE'S token and never enters the store: /statements/all
  // is a real endpoint here, while the ledger's token for the same idea is ''.
  // The store keeps one canonical value (null) and both pages translate at
  // their own edge — see its header for why that matters.
  const bankScope = useBankScope()
  const openId = bankScope.statementId ?? 'all'
  const setOpenId = (v) => setBankStatement(v)
  const statements = bankScope.statements
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [matching, setMatching] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // Mini-ledger view controls
  // Every filter this page understands. A ?filter= it does not know used to
  // light no tab and render an empty table under three zeroed counts, which
  // reads as "nothing here" rather than "that is not a filter" — cheap to close
  // now that the tabs claim to partition the set.
  //
  // 'credits' is the one legacy alias: money in left this page, so an old link
  // lands on For review rather than nowhere.
  const KNOWN_FILTERS = new Set(['all', 'open', 'categorized', 'dismissed', 'likely', 'suggested',
    'flagged', 'confirm', 'matched', 'booked', 'needs-invoice', 'reversals'])
  const urlFilter = urlQ.get('filter') === 'credits' ? 'open' : urlQ.get('filter')
  const [dispFilter, setDispFilter] = useState(
    urlFilter && KNOWN_FILTERS.has(urlFilter) ? urlFilter : 'open')
  const [catFilter, setCatFilter] = useState('') // set by clicking a total chip
  // Which lens the page is in. One at a time: the chips, the table column, the
  // filter and the sort all follow it. Artist describes work already DONE (it
  // comes from the matched entry), category describes work still to do.
  const [dimBy, setDimBy] = useState(urlQ.get('by') === 'artist' ? 'artist' : 'category')
  // Which candidate is armed on each open row, keyed by txn id. Defaults to the
  // top-scored one, so the ordinary case is still a single click on Match —
  // but linking is now a deliberate confirmation rather than a side effect of
  // clicking a candidate, which is what made picking the wrong one of three
  // identical invoices so easy.
  const [candSel, setCandSel] = useState({})
  // What the matcher did without being asked. Declared here with the rest of
  // the view state — a hook whose dep array names state declared below it
  // throws on render and turns this page white, which has already happened
  // once on this file.
  const [rowMenu, setRowMenu] = useState(null) // which row's overflow menu is open
  const [previewFile, setPreviewFile] = useState(null)

  // The `Chip` component and the statements-strip / dimension-chip state that
  // used it are gone with the bands they served. ONE chip language survives, in
  // the filter row: the pill group. Two more visual languages for the same
  // control is how the page got to eight bands.
  // The attribution queue — booked rows with no artist, grouped by vendor.
  // Its own view because it is a different question from the open queue:
  // not "what is this charge" but "who was this vendor's spend for".
  // The four completion states, from ONE server definition so this card and
  // the Needs-invoice queue can never disagree about what "done" means.
  // From the store: the header band above this page reads the same figures, and
  // two independent reads of /statements/completion is how a band and the queue
  // beneath it start reporting different amounts of work.
  const completion = bankScope.completion
  // Proposed swaps: a booked row and the invoice that probably settles it.
  // null = not loaded yet, an object = loaded, 'error' = the request failed.
  // These were all `null` before, so a failed fetch was indistinguishable from
  // "still loading" and from "nothing to show" — and the page rendered the
  // third meaning: Review silently dropped to open-only and the Needs-invoice
  // chip read 0, making 1,746 rows of work look finished.
  const [rematch, setRematch] = useState(null)
  const [rematchBusy, setRematchBusy] = useState(null)
  const [suggestions, setSuggestions] = useState(null)
  // Proposals indexed by bank row. The deck's ordering, its primary action and
  // its scope all ask "does this row already have an invoice waiting?", so the
  // lookup lives in one place rather than three scans of the same array.
  const rematchByTxn = new Map((rematch === 'error' ? [] : rematch?.pairs || []).map((p) => [p.txn_id, p]))
  const [autoDecisions, setAutoDecisions] = useState(null)
  const [autoOpen, setAutoOpen] = useState(false)
  const [txSearch, setTxSearch] = useState('')
  // 'auto' defers to the active filter — confidence while working the open
  // queue, date everywhere else. Clicking a column header pins a real key.
  const [sortKey, setSortKey] = useState('auto')
  const [sortDir, setSortDir] = useState('desc')
  // Inline manual-match search, keyed by the txn being matched
  const [matchingTx, setMatchingTx] = useState(null)
  const [matchQuery, setMatchQuery] = useState('')
  const [matchResults, setMatchResults] = useState([])
  // Inline create-entry form, keyed by the txn it books
  const [entryTx, setEntryTx] = useState(null)
  const [entryForm, setEntryForm] = useState({ payee: '', category: 'Marketing', artist: '', recoupable: null })
  const [creatingEntry, setCreatingEntry] = useState(false)
  // The entry form is answering "no invoice for that", so submitting it must
  // also mark the row — booking alone leaves it in the open queue.
  const [entryNoInvoice, setEntryNoInvoice] = useState(false)
  // Which row's no-invoice call is in flight (the button shows it, and a second
  // click can't double-book).
  const [noInvBusy, setNoInvBusy] = useState(null)
  // Always-dismiss rules
  const [rules, setRules] = useState([])
  // The page-level ⋯ menu. Everything that isn't the queue or the primary
  // action lives here: the statement file, rules, reset.
  const [pageMenu, setPageMenu] = useState(false)
  // Bulk selection over unmatched debits
  const [unmatchedSel, setUnmatchedSel] = useState(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkCategory, setBulkCategory] = useState('Travel')
  const [catRules, setCatRules] = useState([])
  const [entryAlways, setEntryAlways] = useState(false)
  // Swipe review deck — one open item at a time, right=accept left=skip
  const [deck, setDeck] = useState(null) // { items, index, claimed, history, stats }
  const [deckSel, setDeckSel] = useState('')
  // The card's category vocabulary, in the order its 1-9 keys use.
  //
  // ONE definition, because three copies of this ternary is how the menu and
  // the keyboard came to disagree: the hotkey handler read the usage-sorted
  // deck.cats while the dropdown numbered the context order, so "1 · Recording"
  // and pressing 1 selected different categories. Anything that numbers
  // categories must read this.
  const deckOptsFor = (item) => (
    item?.direction === 'credit' ? catIncome : (deck?.cats || catExpense)
  )
  // WHO the spend was for, chosen while reviewing rather than in a second pass
  // on the vendor page. The card already asks what a payment was FOR; asking
  // who it was for at the same moment is the difference between the queue
  // producing attributed spend and producing 2,165 rows that name nobody.
  const [deckArtist, setDeckArtist] = useState('')
  // Artist chosen on a TABLE row before booking it, keyed by txn id.
  //
  // The deck has asked "who was this for?" since it was built; the table never
  // did, so booking from the list produced a row naming nobody — which is how
  // the booked pile came to hold 2,000+ unattributed rows. The endpoint has
  // always accepted an artist (bookDebitAsEntry, routes/statements.js); only
  // this control never sent one.
  const [rowArtist, setRowArtist] = useState({})
  // The recoupable answer on the card, and on a TABLE row about to be booked
  // (keyed by txn id, like rowArtist). null = nobody has answered, which is not
  // the same as "no" — see RecoupAnswer.
  const [deckRecoup, setDeckRecoup] = useState(null)
  const [rowRecoup, setRowRecoup] = useState({})
  const [deckSplit, setDeckSplit] = useState(null) // null | [{amount, category, artist}, ...]
  // Artist roster for the split parts. Same source Reports uses; ArtistSelect
  // renders a stored value the roster doesn't know, so an unusual spelling on an
  // existing row is never blanked by the dropdown.
  const [roster, setRoster] = useState([])
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
  const [deckForceBook, setDeckForceBook] = useState(false) // override a match-primary card to book-as-category
  const [deckSearchOpen, setDeckSearchOpen] = useState(false) // ledger search on the card
  // The document panel beside the card. Shared with the other two decks (one
  // localStorage key), so it is the same answer to "show me documents while I
  // review" wherever you set it.
  const [previewOn, togglePreview] = useDeckPreview()
  const skippedThisSession = useRef(new Set()) // skip = "not now" — demote on the next deck run, never persisted
  const [deckBusy, setDeckBusy] = useState(false)
  const [deckDx, setDeckDx] = useState(0)
  const [resetBusy, setResetBusy] = useState(false)

  // Extra items — rows the app holds that a statement's own balances don't
  // support. The audit re-downloads and re-parses every stored PDF, so it runs
  // only when asked, never on page load.



  const [pnmOpen, setPnmOpen] = useState(false) // "no bank evidence" section — collapsed by default
  const [rowGroupsOpen, setRowGroupsOpen] = useState(new Set()) // expanded ×N row groups
  // Monthly close (soft) — per-month checklist + reconciled badge
  // Batch review — vendor-grouped clearing of ALL open debits

  // ── Which DIRECTION of the reconciliation you are working ──
  //
  // 'statement' is everything this page has always been: bank lines needing a
  // ledger row. 'ledger' is the other half — paid invoices the bank never shows
  // — which had no surface at all, and is the half where money actually goes
  // missing. A switch rather than a second page, because it is one job seen from
  // two ends; the entire existing page renders untouched under 'statement'.
  const [direction, setDirection] = useState(() => {
    try { return localStorage.getItem('bank_matching_direction') || 'statement' } catch { return 'statement' }
  })
  const chooseDirection = (d) => {
    setDirection(d)
    try { localStorage.setItem('bank_matching_direction', d) } catch {}
  }

  // Mirror view state into the URL. replaceState, not push: changing a filter
  // shouldn't put a stop on the back stack — back should leave the page.
  //
  // MUST sit below every state it depends on. A dependency array is evaluated
  // during render, so listing `batchView` while it was still declared 38 lines
  // further down threw "Cannot access 'batchView' before initialization" on
  // mount and rendered the page white.
  useEffect(() => {
    const q = new URLSearchParams()
    // ?statement is written by the store (it is shared with three other tabs);
    // this effect must PRESERVE it rather than rebuild it, or switching a
    // filter here would silently unscope the other three.
    if (openId && openId !== 'all') q.set('statement', String(openId))
    if (dispFilter && dispFilter !== 'open') q.set('filter', dispFilter)
    if (dimBy === 'artist') q.set('by', 'artist')
    const qs = q.toString()
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname)
  }, [openId, dispFilter, dimBy])
  const [batchProgress, setBatchProgress] = useState(null) // { done, total }
  // Which row's candidate comparison is open. A single id, not a set: the whole
  // point is that the page shows one decision at a time.
  const [openCand, setOpenCand] = useState(null)
  // How many row GROUPS are painted. Reset whenever the statement or the filter
  // changes — a cap grown while reading one statement must not carry into the
  // next, where it would silently paint 500 rows again.
  const [txCap, setTxCap] = useState(120)
  useEffect(() => { setTxCap(120); setOpenCand(null) }, [openId, dispFilter, txSearch, catFilter, sortKey, sortDir])
  // A category filter from one statement means nothing on the next. Its own
  // effect, keyed on openId ALONE: folding it into the line above would list
  // catFilter as both a dependency and a target and clear it on every change.
  useEffect(() => { setCatFilter('') }, [openId])

  // ── CROSS-CURRENCY FUNDING PAIRS ───────────────────────────────────────────
  //
  // Every PayPal payment is bank-funded, so it appears on both statements and one
  // copy has to close or the money counts twice. The sweep pairs them on an exact
  // amount, which a GBP payment funded by a USD pull can never satisfy: 77 pairs,
  // ~$24,139 of double-counted spend, and John met two of them on Karen Curry's
  // page as "an extra".
  //
  // A DECK, on John's call, not an auto-close: closing a leg moves reported
  // totals, and the evidence here is a name plus a converted amount inside a
  // band, not an equality. He reads each one, or bulk-closes the unambiguous
  // ones — and every close is individually reversible.
  const [fxDeck, setFxDeck] = useState(null) // { pairs, index, closed, skipped, failures }
  const [fxSummary, setFxSummary] = useState(null)
  // The vendor a row links to lives in utils/bankDisplay now (txVendorLinkName),
  // because three surfaces need the same answer: this table, the Bank Ledger's
  // payee cell, and its ExtraTxRow. The list here had six entries under a
  // comment claiming it was "the same list the server refuses to learn payee
  // lessons for"; the server had thirteen. That comment was the tell.

  // PayPal rows the app can already pair with a bank pull, keyed by txn id.
  //
  // John, 2026-08-19: two PayPal rows sat in the Open queue asking to be matched
  // to an invoice when the app had ALREADY worked out they were copies of bank
  // lines whose invoices were matched — and the actions the row offered ("No
  // invoice", "Unbook") were both wrong for them. 11 rows are in that state.
  //
  // Loaded once on page load rather than only when the deck opens: 179ms against
  // a 617ms /statements/all, and the row cannot explain itself without it. Fired
  // after the table has its data so it never blocks the first paint — this page
  // took 17 seconds once and does not get to regress.
  const [fxPairIdx, setFxPairIdx] = useState(new Map())
  const [fxBusy, setFxBusy] = useState(false)
  const loadFxPairs = async () => {
    setFxBusy(true)
    try {
      const { data } = await api.get('/statements/funding-pairs/cross-currency', { params: { days: 4 } })
      const d = data?.data || {}
      // ONE candidate only. Two pulls of similar size in the same week is exactly
      // the coincidence that mispaired a $200 payment, and a deck is the wrong
      // place to guess between them — those stay counted and unlisted here.
      const pairs = (d.proposals || []).filter((p) => (p.candidates || []).length === 1)
      // The SECOND tier: nothing proves these, but a person may recognise them.
      // PayPal prints a handle that sometimes abbreviates the name — "MJSCOTT117"
      // is Michael Scott — so no rule can pair them and they sat unresolved
      // forever. Shaped like a proposal so one card renders both, but carried
      // separately and marked, because they must never read as confidently.
      const unproven = (d.unclear || [])
        .filter((u) => u.unproven_candidate && u.paypal)
        .map((u) => ({ paypal: u.paypal, candidates: [u.unproven_candidate], unproven: true }))
      setFxSummary({
        total: pairs.length,
        usd: pairs.reduce((t, p) => t + Number(p.paypal?.usd || 0), 0),
        unproven: unproven.length,
        unprovenUsd: unproven.reduce((t, p) => t + Number(p.paypal?.usd || 0), 0),
        ambiguous: (d.proposals || []).length - pairs.length,
        unclear: (d.unclear || []).length - unproven.length,
      })
      // Only the PROVEN tier marks a row. The unproven ones are a person's
      // recognition, not the app's claim, and a row must not say "already
      // answered" about something no rule can show.
      setFxPairIdx(new Map(pairs.map((p) => [p.paypal.id, p.candidates[0]])))
      return [...pairs, ...unproven]
    } catch (err) {
      setError(err.response?.data?.error || err.message)
      return []
    } finally { setFxBusy(false) }
  }
  const openFxDeck = async () => {
    const pairs = await loadFxPairs()
    if (pairs.length) setFxDeck({ pairs, index: 0, closed: 0, skipped: 0, failures: [] })
  }
  const fxAdvance = (patch = {}) => setFxDeck((d) => (d ? { ...d, index: d.index + 1, ...patch } : d))
  const closeFxPair = async (pair) => {
    if (fxBusy) return
    setFxBusy(true)
    try {
      await api.post(`/statements/tx/${pair.paypal.id}/funding-pair`,
        // The server refuses an unnamed cross-currency pair unless a person says
        // so explicitly, and records that they did. Only this button can send it —
        // the bulk action below never touches the unproven tier.
        { bank_txn_id: pair.candidates[0].id, ...(pair.unproven ? { confirm_unnamed: true } : {}) })
      setFxDeck((d) => (d ? { ...d, index: d.index + 1, closed: d.closed + 1 } : d))
    } catch (err) {
      // Record the refusal against the pair rather than stopping the deck: the
      // server has several reasons to say no (a real invoice on both sides, the
      // row claimed meanwhile) and each is a thing to read afterwards, not a
      // reason to abandon the other 76.
      const msg = err.response?.data?.error || err.message
      setFxDeck((d) => (d ? { ...d, index: d.index + 1,
        failures: [...d.failures, { payee: pair.paypal.payee, error: msg }] } : d))
    } finally { setFxBusy(false) }
  }
  // Bulk: the same endpoint, once per pair, sequentially. Not a new bulk route —
  // that endpoint carries every guard and both undo paths, and a second
  // implementation of "close a funding pair" is how the two would drift.
  const closeAllFxPairs = async () => {
    if (!fxDeck || fxBusy) return
    setFxBusy(true)
    // PROVABLE ONLY. Bulk-confirming things no rule could prove is precisely the
    // automation this tier exists to avoid.
    const remaining = fxDeck.pairs.slice(fxDeck.index).filter((p) => !p.unproven)
    let closed = 0
    const failures = []
    for (const pair of remaining) {
      setBatchProgress({ done: closed + failures.length, total: remaining.length })
      try {
        await api.post(`/statements/tx/${pair.paypal.id}/funding-pair`, { bank_txn_id: pair.candidates[0].id })
        closed += 1
      } catch (err) {
        failures.push({ payee: pair.paypal.payee, error: err.response?.data?.error || err.message })
      }
    }
    setBatchProgress(null)
    setFxDeck((d) => (d ? { ...d, index: d.pairs.length,
      closed: d.closed + closed, failures: [...d.failures, ...failures] } : d))
    setFxBusy(false)
    // Reload what the closes changed: the open statement's rows and the coverage
    // counts. Same pair the other bulk actions on this page refresh.
    if (openId) await fetchDetail(openId)
    await fetchCompletion()
  }
  const deckDrag = useRef(null)
  const searchTimer = useRef(null)


  const isAdminRole = user && (user.role === 'Admin' || user.role === 'Superadmin')

  const fetchStatements = async () => {
    await loadBankStatements({ force: true })
    setLoading(false)
  }
  useEffect(() => { if (isAdminRole) fetchStatements() }, [isAdminRole])

  // Deep link from Bank Vendors: /bk/statements?q=<payee> opens the
  // all-transactions review pre-filtered to that payee.
  useEffect(() => {
    if (!isAdminRole) return
    const params = new URLSearchParams(window.location.search)
    const jump = params.get('q')
    if (jump) {
      setTxSearch(jump)
      // An explicit filter wins. /bk/rules links here as
      // ?q=<vendor>&filter=needs-invoice to land on that vendor's booked rows,
      // and forcing 'all' unconditionally dropped them into 2,800 rows with the
      // search doing all the work — the link named a queue and opened a haystack.
      const f = params.get('filter')
      setDispFilter(f && KNOWN_FILTERS.has(f) ? f : 'all')
      // A ?q= link from Vendors / Reports / Rules names a payee, not a month,
      // so it must look at every statement — and the scope is now shared, so it
      // can arrive holding whatever month another tab was on. The main effect
      // below does the fetch once this lands.
      setBankStatement(null)
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [isAdminRole]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.querySelector('main')?.scrollTo({ top: 0 })
    window.scrollTo({ top: 0 })
  }, [openId, detailLoading])

  const resetMatching = async () => {
    if (resetBusy) return
    if (!confirm('Reset matching?\n\nEvery match — auto AND manual — is cleared, then the matcher re-runs with the current evidence: vendor links, aliases, FX face values, and your recorded rejections.\n\n'
      + 'Manual matches are included, so any the matcher can\'t re-derive on its own will come back as open items for you to re-match. That is usually why they were manual in the first place.\n\n'
      + 'Never touched: booked entries, booked income, dismissals.')) return
    setResetBusy(true)
    try {
      const res = await api.post('/statements/reset-matching')
      const d = res.data.data || {}
      alert(`Reset complete.\n\n${d.cleared} matches cleared (${d.manual_cleared ?? 0} of them manual)\n${d.rematched} re-matched with current evidence\n`
        + `${d.still_open ?? 0} left open`
        + (d.manual_not_recovered ? `\n\n${d.manual_not_recovered} that you had matched by hand could not be re-derived — they're back in the open list and need re-matching.` : ''))
      await fetchStatements()
      // Refresh what THIS page owns. Flags and month coverage live on the
      // Statements library now and refresh themselves when it loads.
      fetchDetail(openId || 'all')
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setResetBusy(false) }
  }

  // Batch review — grouped by vendor — was DELETED here, not disabled.
  //
  // It had been unreachable for some time and nobody reported it:
  // `openBatchReview` was the only thing that ever populated `batchGroups`
  // and nothing called it, so the subpage rendered "Loading open
  // transactions…" forever. BkStatements still carries the identical
  // vestige. A feature that rotted in two files unnoticed is not one
  // anybody is using.
  //
  // Not wired back up, on purpose. The selection bulk bar already does
  // every write it did — book to a category, dismiss, match, no-invoice,
  // unmatch, unbook, mark paid — over the filtered set, and searching a
  // payee IS the vendor grouping. Its defaults were also materially less
  // careful than the rest of the page: it proposed a MATCH at score ≥ 70
  // where "Accept N likely" uses ≥ 90, fell back to booking as 'Other',
  // and arrived with every row pre-ticked. One click over a vendor
  // cluster is exactly the shape the category sweeps deliberately avoid.
  //
  // If the vendor-cluster job is wanted back, it is a Refine entry plus
  // the existing bulk bar, not a second subpage with its own writers.

  const fetchDetail = async (id) => {
    // fetchDetail runs after every dismiss / unmatch / book, so it must not
    // disturb anything the user has set up around the table.
    setDetailLoading(true)
    try {
      // Through the store: single-flighted and cached per id, so this page and
      // the header above it cost ONE 703KB read between them, and coming back
      // to a statement already loaded costs none. `force` because every caller
      // here is a post-write refresh — the server decides the new disposition
      // and a cached answer would be the state before the write.
      setDetail(await fetchStatementDetail(id, { force: true, rethrow: true }))
      setUnmatchedSel(new Set())
      // Matching activity is what creates and clears statement flags, but the
      // flag list lives on the Statements library now and is recomputed
      // server-side on read — it will be current whenever that page loads.
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally { setDetailLoading(false) }
  }

  // Load the queue. The old page fetched transactions from the statement row
  // you clicked; that row stayed on the Statements library, so nothing here
  // was fetching anything and the table rendered empty under a working header.
  //
  // Queue-first means the default view ('all') has to load itself on mount, and
  // reload whenever the statement filter changes. Batch review reads
  // /statements/all separately, so it is left alone while it's open.
  useEffect(() => {
    if (!isAdminRole) return
    fetchDetail(openId || 'all')
  }, [isAdminRole, openId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Accepts one file or a whole batch (multi-select / multi-drop). Files
  // upload sequentially to the selected account; PDFs parse server-side in
  // the background, so after the uploads we poll the list until every one
  // of ours has flipped from 'parsing' to ready/error.

  // Run the matcher again over what is still UNMATCHED — additive, never a reset.
  //
  // Follows the statement selector: one statement, or every ready one. Both go
  // through /rematch-all, so there is one code path and the "all" case is not a
  // second implementation.
  //
  // ── Why the report says two different numbers ──
  //
  // The matcher can only see rows with NO ledger entry. Measured: 11 of the
  // 1,757 "left to match". The other 1,746 are BOOKED — an entry the app
  // invented, with no invoice behind it — and they are structurally invisible to
  // it; finding their invoices is the rematch sweep's job, a different mechanism.
  //
  // So a bare "0 matched" under a header saying 1,757 would read as broken. The
  // summary names both scopes and reports `scanned` next to `matched`, which is
  // what makes a zero explicable instead of alarming.
  const runMatch = async () => {
    if (matching) return
    setMatching(true)
    try {
      const scope = openId && openId !== 'all' ? `?statement_id=${openId}` : ''
      const { data } = await api.post(`/statements/rematch-all${scope}`)
      const d = data.data || {}
      // Refresh everything the pass could have changed, and the proposals — the
      // booked half of the report comes from /rematch-candidates, which computes
      // live, so there is no second server implementation of that sweep.
      const [, rm] = await Promise.all([
        fetchDetail(openId || 'all'),
        api.get(`/statements/rematch-candidates${openId && openId !== 'all' ? `?statement_id=${openId}` : ''}`)
          .then((r) => r.data.data).catch(() => null),
      ])
      setRematch(rm || 'error')
      fetchStatements()
      fetchCompletion()

      const waiting = rm?.pairs?.length ?? null
      const booked = rm?.booked_considered ?? null
      alert(
        `Matcher run · ${d.statements} statement${d.statements === 1 ? '' : 's'}\n\n`
        + `  ${d.scanned} unmatched debit${d.scanned === 1 ? '' : 's'} scanned  →  ${d.matched} matched\n`
        + (booked != null
          ? `  ${booked.toLocaleString()} booked row${booked === 1 ? '' : 's'} re-checked  →  ${waiting} ${waiting === 1 ? 'has' : 'have'} an invoice waiting\n`
          : '  booked rows: the proposals could not be re-checked — reopen the page to retry\n')
        + `\nThe booked rows need an invoice, not a match${waiting ? " — they're under Needs invoice" : ''}. `
        + 'Nothing already matched was touched.'
      )
    } catch (err) {
      // 409 = another pass holds the lock. Distinct from "found nothing", and
      // the server says so rather than returning a misleading zero.
      const msg = err.response?.data?.error || err.message
      if (err.response?.status === 409) alert(msg)
      else setError(msg)
    } finally { setMatching(false) }
  }

  // Re-parse the stored original and add anything the first pass missed. PDF
  // parsing is an AI call and a long statement can come back short — that's how
  // a month sits at 27/35 with a half-filled bar. Additive only: the endpoint
  // never deletes or updates existing rows, so matches, bookings and dismissals
  // survive untouched.


  const confirmPaidIds = async (ids) => {
    if (!ids.length || confirming) return
    if (!window.confirm(`Mark ${ids.length} ledger ${ids.length === 1 ? 'entry' : 'entries'} as Paid using the bank's date and reference?`)) return
    setConfirming(true)
    try {
      const res = await api.post(`/statements/${openId}/confirm-paid`, { tx_ids: ids })
      if (res.data.failures?.length) alert(`Some failed:\n${res.data.failures.join('\n')}`)
      await fetchDetail(openId)
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally { setConfirming(false) }
  }

  // One place that knows how to answer the prepayment guard.
  //
  // The server refuses a match whose debit predates its invoice by more than
  // five days — 8 of those turned out to be plain mis-matches — and it returns
  // prepayment_possible so a caller who knows better can say so. Nothing read
  // that flag, so the error named the escape hatch (`pass allow_prepayment`)
  // and offered no way to reach it: a dead end that told you the answer.
  //
  // Interactive callers route through here. Bulk paths deliberately do NOT —
  // being asked this thirty times in a row is not a confirmation, it's an
  // obstacle course, and a bulk run should surface the refusals afterwards.
  // Every match this page records goes through /attach — the endpoint that can
  // also express "this payment settled several invoices", and that now carries
  // the prepayment guard /match has. One write path; this helper's job is the
  // prepayment confirm, not a second way to link a row.
  const postMatch = async (txId, expenseId) => {
    try {
      await api.post(`/statements/tx/${txId}/attach`, { expense_ids: [expenseId] })
      return true
    } catch (err) {
      const d = err.response?.data
      if (!d?.prepayment_possible) throw err
      const p = d.prepayment || {}
      const ok = window.confirm(
        `Record this as a prepayment?\n\n`
        + `The money left the bank on ${fmtDate(p.txn_date)}, ${p.days_early} days before the invoice is `
        + `dated ${fmtDate(p.invoice_date)}. That is only right if it was a retainer or an advance held `
        + `against this invoice.\n\n`
        + `If it wasn't, the fix is to correct the invoice date or pick the debit that actually settled it.\n\n`
        + `OK links them and labels the match a prepayment.`)
      if (!ok) return false
      await api.post(`/statements/tx/${txId}/attach`, { expense_ids: [expenseId], allow_prepayment: true })
      return true
    }
  }
  // The table's inline matcher. Same endpoint as the deck's, so a match made from
  // the table and one made from a card are the same operation — and both get the
  // prepayment guard and the multi-invoice shape for free.
  const manualMatch = async (txId, expenseIds, opts = {}) => {
    const ids = Array.isArray(expenseIds) ? expenseIds : [expenseIds]
    try {
      await api.post(`/statements/tx/${txId}/attach`,
        { expense_ids: ids, ...(opts.allowPrepayment ? { allow_prepayment: true } : {}) })
      setMatchingTx(null); setMatchQuery(''); setMatchResults([])
      await fetchDetail(openId)
    } catch (err) {
      const d = err.response?.data
      if (d?.prepayment_possible) {
        const p = d.prepayment || {}
        if (window.confirm(
          'Record this as a prepayment?\n\n'
          + `The money left the bank on ${fmtDate(p.txn_date)}, ${p.days_early} days before invoice `
          + `${p.invoice_number ? `#${p.invoice_number}` : `#${p.expense_id}`} is dated ${fmtDate(p.invoice_date)}. `
          + 'That is only right if it was a retainer or an advance held against it.')) {
          return manualMatch(txId, ids, { allowPrepayment: true })
        }
        return
      }
      alert('Match failed: ' + (d?.error || err.message))
    }
  }
  const unmatch = async (txId) => {
    try { await api.delete(`/statements/tx/${txId}/match`); await fetchDetail(openId) }
    catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
  }
  // Answer a whole selection with "these never had an invoice".
  //
  // The single-row version has existed since e8a78dd and only 19 rows have ever
  // been marked with it, because 1,269 rows qualify across 399 vendors and you
  // cannot get through that one click at a time. Filtering to a vendor and
  // hitting select-all is the shape that actually clears a pile.
  //
  // One request for the set. The server answers PER ROW — a selection of fifty
  // will contain some already matched to a real invoice, and failing the batch
  // because one row disagrees would make this useless on exactly the selections
  // people make. What was skipped is reported rather than silently dropped.
  // Detach a selection from its invoices. The server answers per row, and a
  // row that was REMATCHED comes back BOOKED rather than open — the booking the
  // attach displaced is restored, which is what makes this safe to do in bulk.
  const bulkUnmatch = async (ids) => {
    if (bulkBusy || !ids.length) return
    if (!window.confirm(`Unmatch ${ids.length} payment${ids.length === 1 ? '' : 's'} from their invoices?\n\n`
      + 'Those invoices go back to waiting for a bank line. A row that displaced a booking when it was '
      + 'matched gets that booking back, so nothing is left unexplained.')) return
    setBulkBusy(true)
    try {
      const { data } = await api.post('/statements/unmatch/bulk', { txn_ids: ids })
      const d = data.data || {}
      // Silent on a clean run — the table refreshes and says it. Spoken only
      // when the outcome differs from what was asked for, which is the same
      // rule bulkNoInvoice follows.
      if (d.skipped?.length) {
        alert(`${d.done} unmatched. ${d.skipped.length} skipped:\n\n`
          + d.skipped.slice(0, 8).map((x) => `#${x.id} — ${x.reason}`).join('\n')
          + (d.skipped.length > 8 ? `\n…and ${d.skipped.length - 8} more` : ''))
      }
      setUnmatchedSel(new Set())
      await fetchDetail(openId)
    } catch (err) {
      alert('Failed: ' + (err.response?.data?.error || err.message))
    } finally { setBulkBusy(false) }
  }
  const bulkUnbook = async (ids) => {
    if (bulkBusy || !ids.length) return
    if (!window.confirm(`Unbook ${ids.length} payment${ids.length === 1 ? '' : 's'}?\n\n`
      + 'The ledger entry the app invented for each one is removed and the row reopens. '
      + 'Nothing with an invoice behind it is touched.')) return
    setBulkBusy(true)
    let done = 0
    try {
      for (const id of ids) { await api.post(`/statements/tx/${id}/unbook`); done += 1 }
      setUnmatchedSel(new Set())
      await fetchDetail(openId)
    } catch (err) {
      alert(`${done} of ${ids.length} unbooked, then: ` + (err.response?.data?.error || err.message))
      await fetchDetail(openId)
    } finally { setBulkBusy(false) }
  }

  // Write the artist onto a row that ALREADY has an entry. Only when it
  // changed: a no-op PUT still costs an audit line, and on a deck you hold the
  // arrow key through, that is one per card.
  //
  // Deliberately not fatal. Losing the artist is worth a warning; losing the
  // review decision because the attribution failed is not, and the card has
  // already moved on in the caller's mind.
  const applyDeckArtist = async (item) => {
    const want = deckArtist.trim()
    const have = (item.matched?.artist || '').trim()
    // FAMILY_SQL exposes the entry as matched.id — expense_id is not a field
    // on it, and reading one that does not exist fails silently as "no id".
    const id = item.matched?.id ?? item.matched_expense_id
    if (!id || want === have) return
    try { await api.put(`/bk/entries/${id}`, { artist: want || null }) }
    catch (err) { console.warn('artist not saved for entry', id, err?.response?.data?.error || err.message) }
  }

  // Write the recoupable answer onto a row that ALREADY has an entry — a
  // 'rebook' card whose category did not change, where nothing is re-booked and
  // the create-entry path that carries the answer never runs. Called from
  // 'keep' too, where it is a no-op by design: that card is a row matched to a
  // real invoice, dismissed, or booked as income, and the gate below refuses
  // all three rather than the caller having to know which.
  //
  // Goes through /bk/recoup-review, the endpoint the Recoupments queue itself
  // posts to, so ONE place records this decision: it sets recoupable AND
  // recoup_reviewed together, writes bk_audit_log, and refuses anything that is
  // not a bank-born row. A second endpoint that wrote recoupable on its own is
  // exactly how the column came to mean two different things.
  //
  // Skipped when the answer is the one already stored — a no-op still costs an
  // audit line, and on a deck you hold the arrow key through that is one per
  // card. Same reason applyDeckArtist compares first.
  //
  // Non-fatal, also for applyDeckArtist's reason: losing the answer is worth a
  // console warning; losing the review decision because the answer failed is
  // not, and the card has already moved on in the reviewer's mind.
  const applyDeckRecoup = async (item) => {
    if (typeof deckRecoup !== 'boolean' || deckRecoup === recoupAnswerOf(item)) return
    const id = item.matched?.id ?? item.matched_expense_id
    // Only a row THIS APP booked. A matched row's recoupable came off the
    // invoice a vendor sent, decided where that invoice was entered, and the
    // server refuses it anyway — asking would just log a 404 per card.
    if (!id || !wasBookedByUs(item)) return
    try { await api.post('/bk/recoup-review', { ids: [id], recoupable: deckRecoup }) }
    catch (err) { console.warn('recoupable not saved for entry', id, err?.response?.data?.error || err.message) }
  }

  const bulkNoInvoice = async (ids, opts = {}) => {
    if (bulkBusy || !ids.length) return
    if (!opts.confirmNew && !window.confirm(
      `Mark ${ids.length} payment${ids.length === 1 ? '' : 's'} as never needing an invoice?\n\n`
      + 'They stop being asked about. Nothing moves in the ledger, and each one can be put back '
      + 'from its own row.')) return
    setBulkBusy(true)
    try {
      const { data } = await api.post('/statements/no-invoice/bulk',
        { txn_ids: ids, ...(opts.confirmNew ? { confirm_new: true } : {}) })
      const d = data.data || {}
      // A row an already-paid invoice covers is held back on purpose — that
      // invoice is the evidence against "no invoice exists". Offer the override
      // once for the whole set rather than per row.
      const paidHolds = (d.skipped || []).filter((x) => /already-paid invoice/i.test(String(x.reason)))
      if (paidHolds.length && !opts.confirmNew) {
        if (window.confirm(
          `${d.done} marked. ${paidHolds.length} held back because an already-paid invoice `
          + 'looks like it covers them.\n\nOK marks those too, booking a second record of that payment.')) {
          setBulkBusy(false)
          return bulkNoInvoice(paidHolds.map((x) => x.id), { confirmNew: true })
        }
      } else if ((d.skipped || []).length) {
        alert(`${d.done} marked. ${d.skipped.length} skipped:\n\n`
          + d.skipped.slice(0, 8).map((x) => `#${x.id}${x.payee ? ` ${x.payee}` : ''} — ${x.reason}`).join('\n')
          + (d.skipped.length > 8 ? `\n…and ${d.skipped.length - 8} more` : ''))
      }
      setUnmatchedSel(new Set())
      await fetchDetail(openId)
      fetchCompletion()
    } catch (err) {
      alert('Failed: ' + (err.response?.data?.error || err.message))
    } finally { setBulkBusy(false) }
  }

  // Booked rows: unbook = delete the created ledger entry AND reopen the
  // debit — a plain unlink would orphan the entry on the ledger.
  const unbook = async (t) => {
    if (!window.confirm(`Unbook this debit?\n\nThe ${fmt(t.amount)} ledger entry created for "${t.matched?.payee || t.payee_guess}" will be deleted and the debit reopens as unmatched.`)) return
    try { await api.post(`/statements/tx/${t.id}/unbook`); await fetchDetail(openId) }
    catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
  }
  const dismissTx = async (txId, undo = false) => {
    try { await api.post(`/statements/tx/${txId}/dismiss`, { undo }); await fetchDetail(openId) }
    catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
  }
  const dismissAlways = async (t) => {
    const pattern = (t.payee_guess || '').trim()
    if (pattern.length < 3) { alert('No usable payee on this debit — dismiss it individually.'); return }
    if (!window.confirm(`Always dismiss debits matching "${pattern}"?\n\nEvery current and future statement will auto-dismiss them. You can delete the rule below.`)) return
    try {
      await api.post(`/statements/tx/${t.id}/dismiss`, { always: true, pattern })
      await Promise.all([fetchDetail(openId), fetchRules()])
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
  }
  const fetchRules = async () => {
    try {
      const [d, c] = await Promise.all([api.get('/statements/rules'), api.get('/statements/category-rules')])
      setRules(d.data.data || [])
      setCatRules(c.data.data || [])
    } catch { /* non-admin or offline */ }
  }
  const fetchCompletion = () => reloadBankCompletion()
  // Record that a category (or one vendor) never has an invoice behind it.
  // Writes NOTHING to the ledger — it only stops those rows being asked about,
  // which is why deleting the rule puts them straight back.
  const markNoInvoice = async (scope, pattern, meta = {}) => {
    if (!window.confirm(scope === 'category'
      ? `Mark the category "${pattern}" as never having an invoice?\n\n`
        + `${meta.n || 0} booked row${meta.n === 1 ? '' : 's'} (${fmt(meta.value || 0)}) stop counting as unfinished.\n\n`
        + 'Nothing in the ledger changes and no money moves — this only records that no document is coming. Reversible from the rules list at the foot of the page.'
      : `Mark "${pattern}" as never sending an invoice?`)) return
    try {
      await api.post('/statements/no-invoice-rules', { scope, pattern })
      await fetchCompletion()
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
  }
  const fetchSuggestions = async () => {
    try {
      const { data } = await api.get('/statements/rule-suggestions')
      setSuggestions(data.data || null)
    } catch { /* non-admin or offline */ }
  }
  const fetchRematch = async () => {
    try {
      const q = openId && openId !== 'all' ? `?statement_id=${openId}` : ''
      const { data } = await api.get(`/statements/rematch-candidates${q}`)
      setRematch(data.data || null)
    } catch (err) {
      // A count that quietly under-reports is worse than an error on a page
      // whose whole job is saying how much work is left.
      setRematch(err.response?.status === 403 ? null : 'error')
    }
  }
  // Swap the invented booking for the real invoice. ONE server call — as two
  // (unbook, then match) a failure between them deletes the ledger entry and
  // leaves the bank row open with nothing recorded.
  const acceptRematch = async (p) => {
    if (rematchBusy) return
    if (!window.confirm(
      `Match this to invoice ${p.invoice_number ? `#${p.invoice_number}` : `entry #${p.expense_id}`}?\n\n`
      + `The entry we invented for this bank line ("${p.booked_payee}", ${p.booked_category}) is deleted and the `
      + `real invoice takes its place.\n\n`
      + `${fmt(p.usd)} · ${p.gap_days === 0 ? 'same day' : `${p.gap_days} days apart`} · this moves the row from booked to invoice-backed.`)) return
    setRematchBusy(p.txn_id)
    try {
      await api.post(`/statements/tx/${p.txn_id}/rematch`, { expense_id: p.expense_id })
      await Promise.all([fetchDetail(openId), fetchRematch(), fetchCompletion()])
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setRematchBusy(null) }
  }
  const fetchAutoDecisions = async () => {
    try {
      const { data } = await api.get('/statements/auto-decisions?days=30')
      setAutoDecisions(data.data || null)
    } catch { /* non-admin or offline */ }
  }
  const bulkBook = async (ids) => {
    if (!ids.length || bulkBusy) return
    if (!window.confirm(`Book ${ids.length} selected debit${ids.length === 1 ? '' : 's'} as ${bulkCategory} entries?\n\nEach becomes an approved, Paid ledger entry under its bank payee.`)) return
    setBulkBusy(true)
    try {
      for (const id of ids) {
        await api.post(`/statements/tx/${id}/create-entry`, { category: bulkCategory }).catch(() => {})
      }
      setUnmatchedSel(new Set())
      await fetchDetail(openId)
    } finally { setBulkBusy(false) }
  }
  // Book each selected row to ITS OWN auto-suggested category (the
  // Suggested chip's bulk action — Spotify→Advertisements, Gusto→Salary,
  // fees→Bank Fees, all in one confirm).
  const bulkBookSuggested = async (rows) => {
    if (!rows.length || bulkBusy) return
    const byCat = {}
    for (const t of rows) byCat[t.suggested_category] = (byCat[t.suggested_category] || 0) + 1
    if (!window.confirm(
      `Book ${rows.length} debit${rows.length === 1 ? '' : 's'} to their suggested categories?\n\n` +
      Object.entries(byCat).map(([c, n]) => `• ${c}: ${n}`).join('\n')
    )) return
    setBulkBusy(true)
    try {
      for (const t of rows) {
        await api.post(`/statements/tx/${t.id}/create-entry`, { category: t.suggested_category }).catch(() => {})
      }
      setUnmatchedSel(new Set())
      await fetchDetail(openId)
    } finally { setBulkBusy(false) }
  }
  const bulkRestore = async (ids) => {
    if (!ids.length || bulkBusy) return
    setBulkBusy(true)
    try {
      for (const id of ids) {
        await api.post(`/statements/tx/${id}/dismiss`, { undo: true }).catch(() => {})
      }
      setUnmatchedSel(new Set())
      await fetchDetail(openId)
    } finally { setBulkBusy(false) }
  }
  // Inline categorize-and-book: picking a category on an open row IS the
  // booking action — one click, entry lands on the master ledger.
  // Name the artist on a row that is ALREADY booked.
  //
  // Booking with an artist (bookInline) only helps rows still open. 1,944 rows
  // are already booked and name nobody — every one of them predates that
  // control, and they are the pile the Reports "not attributed to an artist"
  // line is made of. A booked row already has a ledger entry, so this is the
  // same plain entry update the review deck and the vendor page make.
  const saveBookedArtist = async (t, artist) => {
    const id = t.matched_expense_id
    if (!id || bulkBusy) return
    const want = (artist || '').trim()
    if (want === (t.matched?.artist || '').trim()) return
    setBulkBusy(true)
    try {
      // null, not '' — an empty string is a value, and the placeholder rules
      // treat junk in the artist field as an attribution nobody agrees with.
      await api.put(`/bk/entries/${id}`, { artist: want || null })
      await fetchDetail(openId)
    } catch (err) {
      alert('Failed: ' + (err.response?.data?.error || err.message))
    } finally { setBulkBusy(false) }
  }

  const bookInline = async (t, category) => {
    if (bulkBusy) return
    setBulkBusy(true)
    try {
      // The artist is optional and rides along when one was picked. Left out
      // entirely when blank, so bookDebitAsEntry can still fall back to the
      // vendor's standing answer (artistForPayee) rather than being handed an
      // empty string that overrides it.
      const artist = (rowArtist[t.id] || '').trim()
      // Same rule for the recoupable answer: sent only when somebody actually
      // answered. Left out, the row books exactly as it always did and the
      // recoupment queue asks about it later.
      const recoup = rowRecoup[t.id]
      await api.post(`/statements/tx/${t.id}/create-entry`,
        { category, ...(artist ? { artist } : {}),
          ...(typeof recoup === 'boolean' ? { recoupable: recoup } : {}) })
      setRowArtist((p) => { const n = { ...p }; delete n[t.id]; return n })
      setRowRecoup((p) => { const n = { ...p }; delete n[t.id]; return n })
      await fetchDetail(openId)
    } catch (err) {
      alert('Failed: ' + (err.response?.data?.error || err.message))
    } finally { setBulkBusy(false) }
  }
  // Credits book as income entries — the P&L's revenue side.
  const bookIncome = async (t, incomeType) => {
    if (bulkBusy) return
    setBulkBusy(true)
    try {
      await api.post(`/statements/tx/${t.id}/book-income`, { income_type: incomeType })
      await fetchDetail(openId)
    } catch (err) {
      alert('Failed: ' + (err.response?.data?.error || err.message))
    } finally { setBulkBusy(false) }
  }
  // ── Swipe review deck ─────────────────────────────────────────────────────
  const deckDefaultFor = (item) => item.direction === 'credit'
    // A reversal gets NO revenue pre-fill. Falling through to
    // 'Streaming / Distribution' here would let one swipe book money-back on an
    // expense as streaming income.
    ? (item.income?.income_type
        || item.suggested_income_type
        || ((item.looks_like_reversal || item.reversal_of) ? '' : 'Streaming / Distribution'))
    : (item.match_method === 'created' && item.matched?.category) ? item.matched.category
    : (item.suggested_category || item.vendor_hint?.usual_category || 'Other')
  // NOTE: the pre-fill above deliberately still reads plain `match_method`. It
  // only picks which category is selected, and a mislabelled row's category is
  // still the best guess for it — unlike the checks below, nothing destructive
  // hangs off it.

  // Is this card money coming back on a payment already recorded? Either the
  // pairing found the original debit, or the descriptor says so.
  const isReversalCard = (item) => !!(item && (item.reversal_of || item.looks_like_reversal))

  // Did the APP invent this row's ledger entry?
  //
  // `match_method === 'created'` is the label for that, and it is not always
  // true: txn #2040 carried it while pointing at entry #22 — a real invoice
  // (INV-1908, with a file, approved months before the statement was uploaded).
  // The card told the reviewer "this row was booked … with an entry we
  // invented" and offered to delete it for a different invoice.
  //
  // `entry_source` is what the server actually enforces on /rematch and
  // /unbook, so the card asks the same question those endpoints ask. It rides
  // along on `matched` via FAMILY_SQL, so this costs nothing. Older entries
  // predate the column (1,235 rows are null), which is exactly why the test is
  // "is it bank_statement" and never "is it not something else".
  const wasBookedByUs = (item) => item?.match_method === 'created'
    && item?.matched?.entry_source === 'bank_statement'
  const deckPrimary = (item) => {
    // MATCHING OUTRANKS RECATEGORISING.
    //
    // This check used to sit inside the debit block further down, after the
    // `rebook` early return below — and a rematch proposal is BY DEFINITION a
    // booked row (match_method === 'created'), so `rebook` always won and the
    // rematch card was dead code. The deck showed a $33,215 wire as "booked as
    // Rent — swipe right to keep, or pick a better category", offering every
    // action except the one this page exists for.
    if (item.direction === 'debit' && rematchByTxn.has(item.id)) {
      return { type: 'rematch', target: rematchByTxn.get(item.id) }
    }
    // A booked row the sweep found no proposal for, but which the matcher DID
    // score candidates against. Those were invisible too: the card only ever
    // offered "keep or recategorise". Now it offers the invoices, and accepting
    // one goes through /rematch — /match refuses a booked row outright.
    if (item.matched_expense_id && wasBookedByUs(item)) {
      const live = (item.suggestions || []).filter((x) => !x.rejected && !deck?.claimed?.has(x.id))
      if (live.length && !deckForceBook) return { type: 'rebook', options: live }
      return { type: 'rebook' }
    }
    if (item.dismissed || item.matched_income_id || item.matched_expense_id) return { type: 'keep' }
    // The user said "this isn't that invoice — it's just a category booking".
    if (deckForceBook) return { type: item.direction === 'credit' ? 'income' : 'book' }
    // Money back on a payment already recorded. Accepting pairs it with the
    // original debit and dismisses both, so the two net to zero and neither
    // reaches the P&L — rather than booking revenue that never was.
    // 'Book as income instead…' remains available via deckForceBook for a
    // credit that only LOOKS like a reversal.
    if (item.direction === 'credit' && isReversalCard(item)) return { type: 'reversal' }
    if (item.direction === 'debit') {
      // Skip suggestions whose invoice was already claimed earlier in this
      // deck run — one bank debit per invoice; suggestions were computed
      // before the run started and go stale as cards are accepted.
      const live = (item.suggestions || []).filter((s) => !s.rejected && !deck?.claimed?.has(s.id))
      const strong = live.find((s) => (s.score || 0) >= 85)
      if (strong) return { type: 'match', target: strong }
      // Candidates exist but none is strong. This used to fall through to
      // BOOK, which is how a page built for matching ended up proposing a
      // booking on nearly every card — only 1 in 10 open rows with candidates
      // scores 85+, most sit at 55-67%.
      //
      // So: ask the question instead of answering it in the wrong direction.
      // The card lists the candidates and arms nothing, because accepting a
      // 55% guess in one keystroke is exactly how the wrong invoice gets
      // marked paid. Booking stays available as a secondary action.
      if (live.length) return { type: 'choose', options: live }
    }
    return { type: item.direction === 'credit' ? 'income' : 'book' }
  }
  // Which entry the document panel shows for this card.
  //
  // ONLY the entry the card's action is about. Never one the reviewer merely
  // hovered or scrolled past: a panel that can show a different invoice from the
  // one `→` accepts is the same silent-false-record shape as matching the wrong
  // row, and the whole point of putting the document on screen is that the
  // approval and the evidence agree.
  //
  //   rematch / match   the proposed invoice — exactly what → accepts
  //   rebook / choose   the top-scoring candidate, LABELLED as a candidate;
  //                     neither card arms one, so a swipe can't contradict it
  //   keep              the invoice already matched to this row
  //   book / income     no ledger entry exists yet, so there is nothing to show
  //
  // Returns the subject even when it has no file, so the panel can name what it
  // found nothing for — "no document" on a matched row is real signal.
  const deckDocFor = (item, primary) => {
    if (!item || !primary) return null
    const of = (row, label, extra = '') => {
      if (!row) return null
      const who = row.invoice_payee || row.payee || ''
      const num = row.invoice_number ? `inv ${row.invoice_number}` : `entry #${row.expense_id || row.id}`
      const doc = pickDoc(row)
      return {
        label,
        meta: [who, extra].filter(Boolean).join(' · '),
        filename: doc ? (row[doc.name] || `${num} — ${doc.label}`) : num,
        url: doc ? fileUrl(row, doc.type) : null,
      }
    }
    if (primary.type === 'rematch') return of(primary.target, 'Proposed invoice')
    if (primary.type === 'match') return of(primary.target, 'Proposed invoice')
    if (primary.type === 'rebook' || primary.type === 'choose') {
      const top = primary.options?.[0]
      return top
        ? of(top, primary.options.length > 1 ? `Top candidate of ${primary.options.length}` : 'Candidate',
            'use the 📄 on a row to see the others')
        : null
    }
    if (primary.type === 'keep' && item.matched) return of(item.matched, 'Matched invoice')
    return null
  }
  const openDeck = (allTxns, opts = {}) => {
    // Re-review: run the deck over EXACTLY the rows the user filtered to —
    // booked/matched/dismissed included — to second-guess past decisions
    // (redistribute a bloated "Other", audit a category, revisit dismissals).
    const rereview = opts.rereview === true
    // Open rows PLUS booked rows that already have an invoice waiting. This
    // page's job is tying bank lines to the ledger, and the booked pile is
    // where most of that work actually is — 138 of those rows have a proposed
    // invoice worth $145,762, and the deck could not see one of them.
    const open = rereview ? [...allTxns] : allTxns.filter((t) => deckWants(t, rematchByTxn))
    // MATCHING FIRST. This used to rank a suggested CATEGORY at 0 — ahead of
    // rows carrying invoice candidates — so the first thing the deck offered
    // was something to book, on a page that exists to match. Booking is now
    // what's left when no invoice can be found, not the head of the queue.
    //
    // Cards skipped earlier this session still sink to the back: a skip means
    // "not now", so don't lead with it again. Re-review keeps the table's order.
    const rank = (t) => (
      (rematchByTxn.has(t.id) || (t.suggestions || []).some((x) => !x.rejected && (x.score || 0) >= 85)) ? 0
        : (t.suggestions || []).some((x) => !x.rejected) ? 1
          : 2
    ) + (skippedThisSession.current.has(t.id) ? 10 : 0)
    const items = rereview ? open : [...open].sort((a, b) => rank(a) - rank(b) || Number(b.amount) - Number(a.amount))
    if (!items.length) return
    // Hotkeys 1-9 map to the MOST-USED categories (booked-from-statement
    // counts), snapshot at deck open so the numbering is stable all run.
    // Stable sort keeps the canonical order for unused categories.
    const usage = detail?.category_usage || {}
    const cats = [...catExpense].sort((a, b) => (usage[b] || 0) - (usage[a] || 0))
    setDeck({ items, index: 0, cats, rereview, claimed: new Set(), history: [], stats: { booked: 0, income: 0, matched: 0, dismissed: 0, skipped: 0, flagged: 0, kept: 0, rebooked: 0, reopened: 0, noInvoice: 0 } })
    setDeckSel(deckDefaultFor(items[0]))
    setDeckArtist(items[0]?.matched?.artist || '')
    setDeckRecoup(recoupAnswerOf(items[0]))
    setDeckSplit(null)
    setDeckForceBook(false)
    setDeckDx(0)
  }
  const deckAdvance = (statKey, meta) => {
    setDeck((d) => {
      if (!d) return d
      const entry = { index: d.index, action: statKey, itemId: d.items[d.index]?.id, claimedId: meta?.claimedId || null, ...meta }
      const next = { ...d, index: d.index + 1, history: [...(d.history || []), entry], stats: { ...d.stats, [statKey]: d.stats[statKey] + 1 } }
      const nextItem = d.items[next.index]
      setDeckSel(nextItem ? deckDefaultFor(nextItem) : '')
      // Reset with the card. An artist chosen for one payment must never ride
      // along to the next — the same rule the category default follows.
      setDeckArtist(nextItem?.matched?.artist || '')
      // Same rule as the artist: an answer given for one payment must never
      // ride along to the next card.
      setDeckRecoup(recoupAnswerOf(nextItem))
      setDeckSplit(null)
      setDeckForceBook(false)
      setDeckSearchOpen(false)
      setMatchQuery('')
      setMatchResults([])
      setDeckDx(0)
      return next
    })
  }
  // Back = revisit the previous card AND undo what was done to it — every
  // deck action has a server-side inverse (unbook / unbook-income / unlink /
  // un-dismiss); skips have nothing to undo.
  const deckBack = async () => {
    if (!deck || deckBusy) return
    const prev = deck.history?.[deck.history.length - 1]
    if (!prev) return
    setDeckBusy(true)
    try {
      if (prev.action === 'flagged') {
        await api.post(`/statements/tx/${prev.itemId}/flag`, { flag: false })
        const it = deck.items[prev.index]
        if (it) it.flagged = false
      } else if (prev.action === 'matched') {
        if (prev.rematchedFrom != null) {
          // A REMATCH's inverse is not an unmatch. The accept deleted the entry
          // the app had invented for this row and linked a real invoice; undoing
          // has to bring that booking back, or the row ends up OPEN — a state it
          // was never in — and the card keeps offering a rematch the server
          // refuses. This is the bug John hit: "used the undo button but now
          // can't go forward again."
          await api.post(`/statements/tx/${prev.itemId}/unrematch`, { entry_id: prev.rematchedFrom })
        } else {
          // ?undo=1: an undo is NOT a rejection — don't teach the matcher "no"
          await api.delete(`/statements/tx/${prev.itemId}/match?undo=1`)
        }
        if (prev.claimedId) deck.claimed.delete(prev.claimedId)
      } else if (prev.action === 'booked') {
        await api.post(`/statements/tx/${prev.itemId}/unbook`)
      } else if (prev.action === 'income') {
        await api.post(`/statements/tx/${prev.itemId}/unbook-income`)
      } else if (prev.action === 'dismissed') {
        await api.post(`/statements/tx/${prev.itemId}/dismiss`, { undo: true })
      } else if (prev.action === 'rebooked') {
        await api.post(`/statements/tx/${prev.itemId}/unbook`)
        await api.post(`/statements/tx/${prev.itemId}/create-entry`,
          { category: prev.oldCategory, ...(prev.oldPayee ? { payee: prev.oldPayee } : {}) })
      } else if (prev.action === 'noInvoice') {
        // Clear the marker, and unbook only if THAT card's accept is what
        // created the entry — a card that was already booked keeps its entry.
        await api.post(`/statements/tx/${prev.itemId}/no-invoice`, { undo: true })
        if (prev.bookedHere) await api.post(`/statements/tx/${prev.itemId}/unbook`)
        const it = deck.items[prev.index]
        if (it) it.no_invoice_expected = false
      } else if (prev.action === 'reopened') {
        if (prev.kind === 'restore') await api.post(`/statements/tx/${prev.itemId}/dismiss`, {})
        else if (prev.kind === 'unmatch') await api.post(`/statements/tx/${prev.itemId}/match`, { expense_id: prev.oldExpenseId })
        else if (prev.kind === 'unbook-income') await api.post(`/statements/tx/${prev.itemId}/book-income`, { income_type: prev.oldIncomeType })
      }
      setDeck((d) => {
        if (!d) return d
        const next = {
          ...d, index: prev.index, history: d.history.slice(0, -1),
          stats: { ...d.stats, [prev.action]: Math.max(0, d.stats[prev.action] - 1) },
        }
        setDeckSel(deckDefaultFor(d.items[prev.index]))
        setDeckArtist(d.items[prev.index]?.matched?.artist || '')
        setDeckRecoup(recoupAnswerOf(d.items[prev.index]))
        setDeckSplit(null)
        setDeckForceBook(false)
        setDeckDx(0)
        return next
      })
    } catch (err) {
      alert('Failed to undo: ' + (err.response?.data?.error || err.message))
    } finally { setDeckBusy(false) }
  }
  const closeDeck = async () => { setDeck(null); await fetchDetail(openId) }

  // ── When the card is describing a row that has since moved on ─────────────
  //
  // The deck's items AND its rematch proposals are a snapshot taken when it
  // opened. A row can change after that — an undo, another tab, the nightly
  // matcher sweep, the "Match again" button — and then the card offers an action
  // the server correctly refuses. Before this, that surfaced as a raw alert and
  // the card could not be advanced at all: John pressed undo, pressed accept, got
  // "Only a booked row can be rematched", and was stuck ("can't go forward
  // again"). The only way out was Esc and losing your place.
  //
  // So a stale-state refusal is not an error to report, it is a signal to REFRESH
  // and re-ask. Re-fetch the statement, replace this one item with the truth, drop
  // any proposal that no longer applies, and let the card recompute its primary
  // action. The reviewer keeps their position and sees the real question.
  //
  // The 409 self-heal below in deckAccept is the same idea for a claimed invoice;
  // this generalises it to "the row is not what the card thinks".
  const STALE_REFUSAL = /only a booked row|already matched|already booked|booked as its own|booked as income|already been undone/i
  const resyncCard = async (item, serverMessage) => {
    try {
      const res = await api.get(`/statements/${item.statement_id}`)
      const fresh = (res.data.data?.transactions || []).find((t) => t.id === item.id)
      setDeck((d) => {
        if (!d) return d
        const items = [...d.items]
        // Keep the object identity of the array slot but take the server's state.
        if (fresh) items[d.index] = { ...item, ...fresh }
        return { ...d, items }
      })
      // A proposal computed against the old state must not survive the refresh,
      // or the card recomputes straight back into the action that just failed.
      setRematch((r) => (r && r !== 'error' && fresh
        ? { ...r, pairs: (r.pairs || []).filter((p) => p.txn_id !== item.id) }
        : r))
      setDeckSel(deckDefaultFor(fresh || item))
      setDeckArtist((fresh || item)?.matched?.artist || '')
      setDeckRecoup(recoupAnswerOf(fresh || item))
      setDeckForceBook(false)
      setDeckDx(0)
      alert(`This row changed since the deck opened, so that action no longer applies:\n\n${serverMessage}\n\n`
        + 'The card has been refreshed with what the row actually looks like now — take another look.')
    } catch {
      alert(`${serverMessage}\n\nThe row could not be refreshed either — close the deck and reopen it to resync.`)
    }
  }

  const deckAccept = async () => {
    if (!deck || deckBusy) return
    const item = deck.items[deck.index]
    if (!item) return
    setDeckBusy(true)
    const primary = deckPrimary(item)
    try {
      if (deckSplit) {
        const parts = deckSplit
          .filter((p) => Number(p.amount) > 0 && p.category)
          .map((p) => ({ amount: Number(p.amount), category: p.category, artist: p.artist || null }))
        const sum = parts.reduce((s, p) => s + Number(p.amount), 0)
        if (parts.length < 2 || Math.abs(sum - Number(item.amount)) > 0.01) {
          alert(`Split parts must total ${fmt(item.amount)} (currently ${fmt(sum)})`)
          setDeckBusy(false)
          return
        }
        await api.post(`/statements/tx/${item.id}/split-book`, { parts })
        deckAdvance('booked')
      } else if (primary.type === 'rematch') {
        // Swap the invented booking for the invoice we found. One server call
        // — as two, a failure between them deletes the entry and leaves the
        // row open with nothing recorded.
        const { data } = await api.post(`/statements/tx/${item.id}/rematch`, { expense_id: primary.target.expense_id })
        deck.claimed.add(primary.target.expense_id)
        // Keep the id of the booking this DISPLACED. Without it ⌫ could only
        // unmatch, which leaves the row open rather than booked — not the
        // inverse — and left the card dead-ended, still offering a rematch that
        // /rematch then refused because the row was no longer booked.
        deckAdvance('matched', {
          claimedId: primary.target.expense_id,
          rematchedFrom: data?.data?.unbooked_entry_id ?? null,
        })
      } else if (primary.type === 'choose') {
        // Nothing is armed on purpose — the card is asking which invoice.
        // Accept is inert here; picking a candidate is what commits.
        setDeckBusy(false)
        return
      } else if (primary.type === 'match') {
        if (!await postMatch(item.id, primary.target.id)) return  // finally{} below resets deckBusy
        deck.claimed.add(primary.target.id)
        deckAdvance('matched', { claimedId: primary.target.id })
      } else if (primary.type === 'reversal') {
        // Pair with the original debit and dismiss both. deckDismissPair also
        // unbooks/unmatches the twin first, so the original expense stops
        // counting too — otherwise the expense stays and the refund vanishes.
        setDeckBusy(false)
        await deckDismissPair(item)
        return
      } else if (primary.type === 'keep') {
        // Keeping can still mean naming the artist. The recoupable call is here
        // for symmetry with rebook and no-ops on this card: 'keep' is a real
        // invoice, a dismissal or an income booking, and none of those is this
        // page's to answer.
        await applyDeckArtist(item)
        await applyDeckRecoup(item)
        deckAdvance('kept') // reviewed, decision stands
      } else if (primary.type === 'rebook') {
        const cur = item.matched?.category
        if (deckSel === cur) {
          await applyDeckArtist(item)
          await applyDeckRecoup(item)
          deckAdvance('kept')
        } else {
          // Re-categorize a booked entry: unbook the created expense, book
          // fresh under the new category (same vendor name). The artist rides
          // along on the booking rather than being written afterwards, so the
          // entry is never briefly on the books unattributed.
          await api.post(`/statements/tx/${item.id}/unbook`)
          // The recoupable answer rides along on the booking for the same
          // reason the artist does — the entry is never briefly on the books
          // claiming to be recoupable when the reviewer just said it isn't.
          await api.post(`/statements/tx/${item.id}/create-entry`,
            { category: deckSel, ...(deckArtist.trim() ? { artist: deckArtist.trim() } : {}),
              ...(typeof deckRecoup === 'boolean' ? { recoupable: deckRecoup } : {}),
              ...(item.matched?.payee ? { payee: item.matched.payee } : {}) })
          deckAdvance('rebooked', { oldCategory: cur, oldPayee: item.matched?.payee })
        }
      } else if (primary.type === 'income') {
        await api.post(`/statements/tx/${item.id}/book-income`, { income_type: deckSel })
        deckAdvance('income')
      } else {
        // A linked vendor's booking lands under its canonical ledger name,
        // not a descriptor-derived one.
        await api.post(`/statements/tx/${item.id}/create-entry`,
          { category: deckSel, ...(deckArtist.trim() ? { artist: deckArtist.trim() } : {}),
            ...(typeof deckRecoup === 'boolean' ? { recoupable: deckRecoup } : {}),
            ...(item.vendor_hint?.vendor ? { payee: item.vendor_hint.vendor } : {}) })
        deckAdvance('booked')
      }
    } catch (err) {
      if (err.response?.status === 409 && primary.type === 'match') {
        // The invoice was claimed outside this deck run (or before it
        // started). Mark it claimed and let the card recompute its
        // fallback action instead of dead-ending on an error.
        setDeck((d) => { if (d) d.claimed.add(primary.target.id); return d ? { ...d } : d })
        setDeckSel(deckDefaultFor(item))
        setDeckArtist(item?.matched?.artist || '')
        setDeckRecoup(recoupAnswerOf(item))
        setDeckDx(0)
      } else {
        const msg = err.response?.data?.error || err.message
        // A refusal that means "the row is not in the state this card assumed"
        // is recoverable: refresh and re-ask rather than dead-ending.
        if (err.response?.status === 400 && STALE_REFUSAL.test(msg)) {
          await resyncCard(item, msg)
        } else {
          alert('Failed: ' + msg)
        }
        setDeckDx(0)
      }
    } finally { setDeckBusy(false) }
  }
  // Match this card to a specific suggested invoice (not the primary) —
  // same claimed-tracking and 409 self-heal as deckAccept.
  // One-tap pick from the alternates list or the ledger search.
  //
  // A thin wrapper over deckAttach so the deck has ONE write path: every match it
  // records goes through /attach, whether one invoice was picked or three. The
  // alternative was two endpoints reached from the same card — which is how a
  // guard gets added to one and not the other, exactly as the prepayment check
  // was on /match and missing from /attach until this task.
  const deckMatchTo = (item, sugg) => deckAttach(item, [sugg.id])
  // Attach one invoice or several to this card's bank line.
  //
  // ONE endpoint for both, and the same one the vendor page uses: /attach picks
  // match-or-rematch from the row's own state and writes every link in a single
  // transaction. The deck used to post a bare expense_id to /match, which cannot
  // express "this transfer settled two invoices" at all — the shape the matcher
  // can never propose, because it pairs on an amount equal to the cent.
  //
  // The prepayment guard survives the move: /attach now runs the same check
  // /match does (a debit that left the bank before an invoice existed cannot be
  // paying it — 8 live inverted matches, up to 208 days), and the confirm below
  // is the same one postMatch showed.
  const deckAttach = async (item, expenseIds, opts = {}) => {
    if (deckBusy || !expenseIds?.length) return
    setDeckBusy(true)
    try {
      await api.post(`/statements/tx/${item.id}/attach`,
        { expense_ids: expenseIds, ...(opts.allowPrepayment ? { allow_prepayment: true } : {}) })
      for (const id of expenseIds) deck.claimed.add(id)
      deckAdvance('matched', { claimedId: expenseIds[0] })
    } catch (err) {
      const d = err.response?.data
      if (d?.prepayment_possible) {
        const p = d.prepayment || {}
        const ok = window.confirm(
          'Record this as a prepayment?\n\n'
          + `The money left the bank on ${fmtDate(p.txn_date)}, ${p.days_early} days before invoice `
          + `${p.invoice_number ? `#${p.invoice_number}` : `#${p.expense_id}`} is dated ${fmtDate(p.invoice_date)}. `
          + 'That is only right if it was a retainer or an advance held against it.\n\n'
          + "If it wasn't, the fix is to correct the invoice date or pick the debit that actually settled it.")
        setDeckBusy(false)
        if (ok) return deckAttach(item, expenseIds, { allowPrepayment: true })
        return
      }
      if (err.response?.status === 409) {
        // The user picked these deliberately, so a silent no-op reads as a broken
        // button. Say WHY the server refused, and remember the claim.
        setDeck((dk) => { if (dk) expenseIds.forEach((id) => dk.claimed.add(id)); return dk ? { ...dk } : dk })
        alert(d?.error || 'One of those invoices is already settled by another bank row.')
      } else if (STALE_REFUSAL.test(String(d?.error || ''))) {
        await resyncCard(item, d.error)
      } else {
        alert('Failed: ' + (d?.error || err.message))
      }
    } finally { setDeckBusy(false) }
  }

  // Reversed transfers: dismiss the card AND its reversal twin in one tap —
  // a failed payment is neither expense nor income.
  const deckDismissPair = async (item) => {
    if (deckBusy) return
    setDeckBusy(true)
    try {
      const otherId = item.reversed_by?.id || item.reversal_of?.id
      // The twin may be booked or matched — undo that first, or the dismiss
      // is (correctly) refused by the server.
      if (item.reversed_by?.booked && otherId) {
        await api.post(`/statements/tx/${otherId}/unbook-income`).catch(() => {})
      }
      if (item.reversal_of?.matched && otherId) {
        if (item.reversal_of.method === 'created') {
          await api.post(`/statements/tx/${otherId}/unbook`).catch(() => {})
        } else {
          await api.delete(`/statements/tx/${otherId}/match`).catch(() => {})
        }
      }
      await api.post(`/statements/tx/${item.id}/dismiss`, {})
      if (otherId) await api.post(`/statements/tx/${otherId}/dismiss`, {}).catch(() => {})
      deckAdvance('dismissed')
    } catch (err) {
      alert('Failed: ' + (err.response?.data?.error || err.message))
    } finally { setDeckBusy(false) }
  }
  // Flag for review — an independent MARKER, not an action: it toggles on
  // the card and you still categorize/match/skip. A flagged item stays in
  // Open (and future deck runs) until it's actually handled; a flagged
  // item that gets booked keeps its flag for later review.
  const deckFlag = async () => {
    if (!deck || deckBusy) return
    const item = deck.items[deck.index]
    if (!item) return
    setDeckBusy(true)
    try {
      const next = !item.flagged
      await api.post(`/statements/tx/${item.id}/flag`, { flag: next })
      item.flagged = next
      setDeck((d) => (d ? { ...d, stats: { ...d.stats, flagged: Math.max(0, d.stats.flagged + (next ? 1 : -1)) } } : d))
    } catch (err) {
      alert('Failed: ' + (err.response?.data?.error || err.message))
    } finally { setDeckBusy(false) }
  }
  const toggleFlagTx = async (t) => {
    try {
      await api.post(`/statements/tx/${t.id}/flag`, { flag: !t.flagged })
      await fetchDetail(openId)
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
  }
  // Correct a mislabeled currency in place (old parses hardcoded USD).
  // Server refuses while matched/booked; amount stays the face value, the
  // USD estimate and every total recompute from the real currency.
  const deckSetCurrency = async (item, cur) => {
    if (deckBusy || cur === (item.currency || 'USD')) return
    setDeckBusy(true)
    try {
      const res = await api.post(`/statements/tx/${item.id}/currency`, { currency: cur })
      item.currency = res.data.data.currency
      item.usd = res.data.data.usd
      setDeck((d) => (d ? { ...d } : d))
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setDeckBusy(false) }
  }

  // Unbook, from the card. Deletes the entry the app invented for this row and
  // reopens it, so the row can be matched to a real invoice instead.
  //
  // The table has had this since the page was built; the deck never did, which
  // meant a reviewer who reached a booked row they wanted to undo had to leave
  // the deck, find the row, and lose their place.
  //
  // It does NOT advance the deck, and that is the point: unbooking is a
  // correction to the row in front of you, not a decision about it. The card
  // stays put and re-renders against the row's new state — now open — so the
  // next thing you do is choose an invoice for it. That also means no new undo
  // path: `deckBack` keeps its existing inverses and never has to reason about
  // a card that changed shape mid-review.
  const deckUnbook = async (item) => {
    if (!deck || deckBusy) return
    if (!window.confirm(
      `Unbook this ${fmt(item.amount)} row?\n\n`
      + `The ${item.matched?.category || 'ledger'} entry we created for it is deleted and the row reopens, `
      + 'ready to match against a real invoice. Nothing else changes.')) return
    setDeckBusy(true)
    try {
      await api.post(`/statements/tx/${item.id}/unbook`)
      // Same refresh the stale-card path uses: re-read the row, drop any rematch
      // proposal computed against the booking that no longer exists.
      const res = await api.get(`/statements/${item.statement_id}`)
      const fresh = (res.data.data?.transactions || []).find((t) => t.id === item.id)
      setDeck((d) => {
        if (!d) return d
        const items = [...d.items]
        if (fresh) items[d.index] = { ...item, ...fresh }
        return { ...d, items }
      })
      setRematch((r) => (r && r !== 'error'
        ? { ...r, pairs: (r.pairs || []).filter((p) => p.txn_id !== item.id) }
        : r))
      setDeckSel(deckDefaultFor(fresh || item))
      setDeckArtist((fresh || item)?.matched?.artist || '')
      setDeckRecoup(recoupAnswerOf(fresh || item))
      setDeckForceBook(false)
      // The row moved from booked to open, which is a number on the header.
      fetchCompletion()
    } catch (err) {
      alert('Failed: ' + (err.response?.data?.error || err.message))
    } finally { setDeckBusy(false) }
  }

  // Re-review "undo the past decision" actions — the card advances and the
  // item returns to the open pool for a fresh decision later.
  const deckReopen = async (item, kind) => {
    if (!deck || deckBusy) return
    setDeckBusy(true)
    try {
      if (kind === 'restore') {
        await api.post(`/statements/tx/${item.id}/dismiss`, { undo: true })
        deckAdvance('reopened', { kind })
      } else if (kind === 'unmatch') {
        // no ?undo — re-review unmatch IS an explicit "wrong pairing"
        await api.delete(`/statements/tx/${item.id}/match`)
        deckAdvance('reopened', { kind, oldExpenseId: item.matched_expense_id })
      } else if (kind === 'unbook-income') {
        await api.post(`/statements/tx/${item.id}/unbook-income`)
        deckAdvance('reopened', { kind, oldIncomeType: item.income?.income_type })
      }
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setDeckBusy(false) }
  }
  const deckSkip = () => {
    if (!deck || deckBusy) return
    const item = deck.items[deck.index]
    if (item) skippedThisSession.current.add(item.id)
    deckAdvance('skipped')
  }
  const deckDismiss = async () => {
    if (!deck || deckBusy) return
    const item = deck.items[deck.index]
    if (item?.matched_expense_id || item?.matched_income_id) {
      alert("Unmatch/unbook this transaction first — matched items can't be dismissed.")
      return
    }
    setDeckBusy(true)
    try {
      // Dismissing a card that showed a suggestion is a "no" to that
      // pairing — send it so the matcher never re-proposes it.
      const topSugg = (item.suggestions || []).find((s) => !s.rejected)
      await api.post(`/statements/tx/${item.id}/dismiss`, topSugg ? { rejected_expense_id: topSugg.id } : {})
      deckAdvance('dismissed')
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setDeckBusy(false) }
  }
  // "No invoice for that" from the deck — the same one call the table makes.
  //
  // A SEPARATE control from Dismiss on purpose, and next to it, because their
  // effect on reported spend is opposite: this keeps the money and answers the
  // row; Dismiss takes the money out of the P&L. One key each, so a fast run
  // can't reach for the wrong one by muscle memory.
  const deckNoInvoice = async () => {
    if (!deck || deckBusy) return
    const item = deck.items[deck.index]
    if (!item) return
    if (item.direction !== 'debit') {
      alert('Only money OUT can be marked as needing no invoice.')
      return
    }
    if (item.matched_expense_id && item.match_method !== 'created') {
      alert('This is already matched to a real invoice — unmatch it first if that pairing is wrong.')
      return
    }
    setDeckBusy(true)
    try {
      // deckSel is the category the card is showing, so 1-9 picks it first and
      // this records what the reviewer actually chose rather than a default.
      const { data } = await api.post(`/statements/tx/${item.id}/no-invoice`,
        { category: deckSel, ...(typeof deckRecoup === 'boolean' ? { recoupable: deckRecoup } : {}) })
      item.no_invoice_expected = true
      deckAdvance('noInvoice', { bookedHere: data?.data?.booked === true })
    } catch (err) {
      const d = err.response?.data
      if (err.response?.status === 409) {
        setDeckBusy(false)
        if (!window.confirm(`${d.error}\n\nOK books this anyway as a second record.`)) return
        setDeckBusy(true)
        try {
          const { data } = await api.post(`/statements/tx/${item.id}/no-invoice`,
            { category: deckSel, confirm_new: true,
              ...(typeof deckRecoup === 'boolean' ? { recoupable: deckRecoup } : {}) })
          item.no_invoice_expected = true
          deckAdvance('noInvoice', { bookedHere: data?.data?.booked === true })
        } catch (e2) { alert('Failed: ' + (e2.response?.data?.error || e2.message)) }
        finally { setDeckBusy(false) }
        return
      }
      alert('Failed: ' + (d?.error || err.message))
    } finally { setDeckBusy(false) }
  }
  // Keyboard: → accept · ← skip · D dismiss · N no invoice · R recoupable · 1-9 pick category
  useEffect(() => {
    if (!deck) return
    const onKey = (e) => {
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'ArrowRight') { e.preventDefault(); deckAccept() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); deckSkip() }
      else if (e.key === 'Backspace') { e.preventDefault(); deckBack() }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); deckFlag() }
      else if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowDown') { e.preventDefault(); deckDismiss() }
      else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); deckNoInvoice() }
      else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); togglePreview() }
      // R cycles the recoupable answer: unanswered → yes → no → unanswered.
      // Three states on one key because that is what the field has, and a key
      // that could only say "yes" would make the default look answered.
      else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        setDeckRecoup((v) => (v === null ? true : v === true ? false : null))
      }
      else if (e.key === 'Escape') { e.preventDefault(); closeDeck() }
      else if (/^[1-9]$/.test(e.key)) {
        const item = deck.items[deck.index]
        if (!item) return
        const pick = deckOptsFor(item)[Number(e.key) - 1]
        if (pick) setDeckSel(pick)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }) // eslint-disable-line react-hooks/exhaustive-deps

  const unbookIncome = async (t) => {
    if (!window.confirm(`Unbook this credit?\n\nThe ${fmt(t.amount)} income entry (${t.income?.income_type || 'income'}) will be deleted and the credit reopens.`)) return
    try { await api.post(`/statements/tx/${t.id}/unbook-income`); await fetchDetail(openId) }
    catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
  }
  useEffect(() => { if (isAdminRole) { fetchRules(); fetchAutoDecisions() } }, [isAdminRole]) // eslint-disable-line react-hooks/exhaustive-deps
  // The funding-pair index, once, and deliberately AFTER the row data rather
  // than alongside it: a row that cannot say "this is already answered
  // elsewhere" is a smaller problem than a table that waits on a second
  // request to draw. 179ms, and nothing on screen depends on it arriving.
  useEffect(() => { if (isAdminRole) loadFxPairs() }, [isAdminRole]) // eslint-disable-line react-hooks/exhaustive-deps
  // Landing on ?view=attribute must load the queue. The equivalent gap is what
  // made the table render empty after the page split: the fetch lived on a
  // click handler, so arriving by URL showed working chrome over no data.
  // Load the proposals when you open the queue they belong to, not on mount —
  // the sweep pairs every booked row against every unclaimed invoice.
  // Loaded up front, not only when the Needs-invoice filter is opened: the
  // deck's ordering, its primary action and its scope all depend on knowing
  // which rows already have an invoice waiting, and the header count does too.
  useEffect(() => {
    if (isAdminRole) fetchSuggestions()
  }, [isAdminRole]) // eslint-disable-line react-hooks/exhaustive-deps
  // Follows the statement selector, like the table does. Without this the
  // card, the chip and the proposals describe a different population from the
  // rows underneath them.
  useEffect(() => {
    if (isAdminRole) { fetchRematch(); fetchCompletion() }
  }, [isAdminRole, openId]) // eslint-disable-line react-hooks/exhaustive-deps
  // opts.noInvoice: the form is being used to ANSWER "no invoice for that", so
  // submitting must go through /no-invoice — booking alone leaves the row in the
  // open queue, which is the whole complaint this replaces.
  const openEntryForm = (t, opts = {}) => {
    setEntryTx(entryTx === t.id ? null : t.id)
    setEntryForm({
      // Unanswered, always. The form opens on a row nobody has judged yet, and
      // pre-filling either answer would put words in the reviewer's mouth on the
      // one field whose default is already the problem.
      recoupable: null,
      payee: cleanBankPayee(t.payee_guess),
      // The server's own suggestion when it has one. 'Marketing' as a blanket
      // prefill is a guess dressed as an answer, and it was the prefill on every
      // Uber, every payroll run and every bank fee.
      category: t.suggested_category || t.matched?.category || t.vendor_hint?.usual_category || 'Marketing',
      artist: '',
    })
    setEntryAlways(false)
    setEntryNoInvoice(opts.noInvoice === true)
  }
  // "No invoice for that" — RESOLVE the row: book it if it has no entry, mark it
  // as needing no document, and drop it out of the open queue. One call, so a
  // failure can't leave it booked-but-still-asked-about.
  //
  // Deliberately NOT a dismissal: the cost stays in the P&L and in Coverage.
  // "Not really spending" is the action that removes money from reported spend,
  // and the two sit side by side, so the distinction has to survive a fast click
  // — hence one confirm naming what happens to the money.
  const rowNoInvoice = async (t, { confirmNew = false } = {}) => {
    if (noInvBusy) return
    const cat = t.matched?.category || t.suggested_category || t.vendor_hint?.usual_category
    // No suggestion to lean on: ask for the category rather than silently filing
    // real money under 'Other'. The form's submit runs this same endpoint.
    if (!t.matched_expense_id && !cat) { openEntryForm(t, { noInvoice: true }); return }
    if (!confirmNew && !window.confirm(
      `Mark this ${fmt(t.amount)} as needing no invoice?\n\n`
      + `${t.matched_expense_id
        ? `It stays booked${t.matched?.category ? ` as ${t.matched.category}` : ''}`
        : `It books as a Paid ${cat} entry under "${cleanBankPayee(t.payee_guess) || t.payee_email || 'this payee'}"`}`
      + ' and leaves the open queue.\n\n'
      + 'The money still counts as spending — this only records that no document is coming. Reversible.')) return
    setNoInvBusy(t.id)
    try {
      await api.post(`/statements/tx/${t.id}/no-invoice`, { category: cat, ...(confirmNew ? { confirm_new: true } : {}) })
      await Promise.all([fetchDetail(openId), fetchCompletion()])
    } catch (err) {
      const d = err.response?.data
      // An already-Paid invoice covers this payment — which is the ledger
      // contradicting the claim that no invoice exists. Say so and let the
      // decision be explicit, same speed bump create-entry uses.
      if (err.response?.status === 409) {
        setNoInvBusy(null)
        if (window.confirm(`${d.error}\n\nOK books this anyway as a second record.`)) {
          await rowNoInvoice(t, { confirmNew: true })
        }
        return
      }
      // The row names no counterparty, so it can't be booked unattended.
      if (/payee required/i.test(d?.error || '')) { openEntryForm(t, { noInvoice: true }); return }
      alert('Failed: ' + (d?.error || err.message))
    } finally { setNoInvBusy(null) }
  }
  // Put it back in the queue — an answer you can't take back is one people
  // won't give. Leaves the ledger entry alone: this only clears the marker.
  const undoNoInvoice = async (t) => {
    if (noInvBusy) return
    setNoInvBusy(t.id)
    try {
      await api.post(`/statements/tx/${t.id}/no-invoice`, { undo: true })
      await Promise.all([fetchDetail(openId), fetchCompletion()])
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setNoInvBusy(null) }
  }
  const bulkDismiss = async (ids) => {
    if (!ids.length || bulkBusy) return
    if (!window.confirm(`Dismiss ${ids.length} selected debit${ids.length === 1 ? '' : 's'}?`)) return
    setBulkBusy(true)
    try {
      for (const id of ids) {
        await api.post(`/statements/tx/${id}/dismiss`, {}).catch(() => {})
      }
      setUnmatchedSel(new Set())
      await fetchDetail(openId)
    } finally { setBulkBusy(false) }
  }
  const acceptHighConfidence = async (candidates) => {
    if (!candidates.length || bulkBusy) return
    if (!window.confirm(
      `Link ${candidates.length} debit${candidates.length === 1 ? '' : 's'} to their top suggestion (90%+ confidence)?\n\n` +
      candidates.slice(0, 8).map((t) => `• ${t.payee_guess || t.description?.slice(0, 40)} → ${t.suggestions[0].payee}`).join('\n') +
      (candidates.length > 8 ? `\n…and ${candidates.length - 8} more` : '')
    )) return
    setBulkBusy(true)
    try {
      const errors = []
      for (const t of candidates) {
        await api.post(`/statements/tx/${t.id}/match`, { expense_id: t.suggestions[0].id })
          .catch((err) => errors.push(`${t.payee_guess || t.description?.slice(0, 40)}: ${err.response?.data?.error || err.message}`))
      }
      await fetchDetail(openId)
      if (errors.length) alert(`${errors.length} of ${candidates.length} could not be linked:\n\n${errors.slice(0, 6).join('\n')}${errors.length > 6 ? `\n…and ${errors.length - 6} more` : ''}`)
    } finally { setBulkBusy(false) }
  }
  const createEntry = async (t) => {
    if (creatingEntry) return
    if (!entryForm.payee.trim()) return
    setCreatingEntry(true)
    try {
      // Same form, two answers. When it was opened to say "no invoice for that",
      // the booking and the marker go in ONE call — posting create-entry here
      // and the marker after it is the split that leaves a row booked and still
      // being asked about.
      if (entryNoInvoice) {
        try {
          await api.post(`/statements/tx/${t.id}/no-invoice`, { ...entryForm })
        } catch (err) {
          // An already-Paid invoice covers this payment. Name it and offer the
          // override rather than dead-ending on an error that tells you the
          // answer and gives you no way to act on it.
          if (err.response?.status !== 409) throw err
          if (!window.confirm(`${err.response.data.error}\n\nOK books this anyway as a second record.`)) return
          await api.post(`/statements/tx/${t.id}/no-invoice`, { ...entryForm, confirm_new: true })
        }
        setEntryTx(null)
        setEntryNoInvoice(false)
        await Promise.all([fetchDetail(openId), fetchCompletion()])
        return
      }
      await api.post(`/statements/tx/${t.id}/create-entry`, { ...entryForm, always: entryAlways })
      setEntryTx(null)
      await fetchDetail(openId)
      if (entryAlways) fetchRules()
    } catch (err) {
      alert('Failed: ' + (err.response?.data?.error || err.message))
    } finally { setCreatingEntry(false) }
  }

  // Debounced ledger search for manual matching
  const onMatchQuery = (q) => {
    setMatchQuery(q)
    clearTimeout(searchTimer.current)
    if (q.trim().length < 2) { setMatchResults([]); return }
    searchTimer.current = setTimeout(async () => {
      try {
        // source=invoices, because this box is asking "which INVOICE settles
        // this bank line" and it was answering with other bank lines. Measured
        // before the filter: for the biggest vendors every visible result was an
        // entry the app had created from a bank debit — 8 of 8 for UBER, FACEBOOK
        // and SPOTIFY, 139 of 141 results for UBER overall. Picking one recorded
        // the debit as document-backed with no document anywhere.
        //
        // The server refuses such a match outright now; this keeps it from being
        // offered in the first place.
        // roots=1 — whole invoices only, server-side. The client already dropped
        // children, but AFTER the row limit, so a vendor with many split parts
        // spent the budget on rows that were then thrown away.
        const res = await api.get(`/bk/entries?source=invoices&roots=1&search=${encodeURIComponent(q.trim())}`)
        const list = (res.data.data || []).filter((e) => !e.parent_id).slice(0, 8)
        setMatchResults(list)
      } catch { setMatchResults([]) }
    }, 300)
  }

  if (!isAdminRole) {
    return (
      <div className="p-8 text-center text-gray-500">
        <Landmark size={28} className="mx-auto mb-2 text-gray-300" />
        Statements are visible to Admins only.
      </div>
    )
  }

  // Where the unanswered work lives, from the statements list rather than the
  // loaded detail — /statements/:id returns ONE statement's rows, so when you
  // narrow to a month the client can no longer see the others, which is
  // exactly when "what else is left" matters. The selector and the strip below
  // both read this, so they cannot disagree about the count.
  // ── ONE definition of "left to match" ──────────────────────────────────────
  //
  // From /completion, which owns it: a bank line with no ledger entry, or with
  // one this app invented and no invoice behind it, minus anything answered by a
  // no-invoice rule or marker. The same membership as the Open chip and the
  // queue.
  //
  // It used to come from `bank_statements.open_debits`, which counts only rows
  // with no ledger entry at all — so the selector read "19 left" an inch from a
  // badge reading 1,765, a 146x disagreement between two controls describing the
  // same thing. Four numbers on this page answered "how much is left"
  // differently; now one does.
  // The headline "N left" and the per-statement counts moved into the Banking
  // header (components/BankShell.jsx), which reads the same /completion payload
  // from the same store — so there is still exactly one definition, it is just
  // stated once above the tab bar instead of twice below it.
  const compOk = completion && completion !== 'error'

  // Server-owned membership for the Needs-invoice queue. A Set so the filter
  // is O(1) per row, and derived here (not inside the render IIFE) so the chip
  // count and the filtered rows read the same thing.
  // The document, wherever a decision about it is made.
  //
  // Uses the shared pickDoc/fileUrl from utils/entryFiles — whose own header
  // explains it was extracted so there is ONE answer to "does this row have a
  // file". fileUrl prefers file_entry_id, which is what makes it correct on a
  // split family: the invoice hangs off the parent, not the slice you clicked.
  //
  // Absence is stated, not hidden. On a matched row "no doc" is a real signal
  // — that match has nothing backing it — and a missing button reads as a
  // missing feature.
  const DocButton = ({ row, quiet = false }) => {
    if (!row) return null
    const doc = pickDoc(row)
    if (!doc) {
      return quiet ? null : (
        <span title="No document is attached to this entry"
          className="text-[11px] font-bold uppercase tracking-wide text-amber-600 shrink-0">no doc</span>
      )
    }
    const name = row[doc.name] || `${doc.label}.pdf`
    return (
      <button
        onClick={(e) => { e.stopPropagation(); setPreviewFile({ url: fileUrl(row, doc.type), filename: name }) }}
        title={`Open the ${doc.label}${row[doc.name] ? ` — ${row[doc.name]}` : ''}`}
        className="text-gray-400 hover:text-ink shrink-0">
        <FileText size={12} />
      </button>
    )
  }

  const needsInvoiceIds = new Set(completion === 'error' ? [] : completion?.needs_invoice_txn_ids || [])
  // THE definition of "a card the deck will build" — used by openDeck's filter
  // and by the Review count, so the button cannot promise a different number
  // from the deck it opens. It did: the button said 152 (debits only) over a
  // deck of 158, because the deck also reviews the 6 open CREDITS.
  const deckWants = (t, proposals) => !t.dismissed && !t.matched_income_id
    // Answered. "No invoice for that" means stop asking, so the deck stops
    // asking — including when the rematch sweep later turns up a candidate for
    // it, which would otherwise re-open the exact row someone just closed.
    // "Expect one" on the row puts it back.
    && !t.no_invoice_expected
    && (!t.matched_expense_id || proposals.has(t.id))
    // MONEY OUT, and only money that actually went out.
    //
    // This deck answers one question — does this payment have an invoice behind
    // it — and neither money-in nor a refund has an answer to it. They used to be
    // admitted anyway: credits that cancel a debit were let in so a reversal
    // could be paired and both sides dismissed. On the live deck that was 5 of 10
    // cards, on a page whose header counts what is left to MATCH.
    //
    // Nothing is stranded by their leaving, which is what makes this safe:
    //   · reversals are already named on Flags as `reversal-still-matched`, with
    //     the remedy spelled out — SCS LA LLC and SP MERCADO CENTRAL are on there
    //     right now, so the deck was the duplicate, not the home
    //   · credits keep their row controls in the table below (bookIncome), which
    //     is where the other 517 of them were already handled
    // The Reversals chip in the filter row keeps them one click away.
    && t.direction === 'debit'
    && !t.looks_like_reversal && !t.reversal_of && !t.reversed_by

  const txns = detail?.transactions || []
  const debits = txns.filter((t) => t.direction === 'debit')
  const credits = txns.filter((t) => t.direction === 'credit')
  const toConfirm = debits.filter((t) => t.matched && t.matched.payment_status !== 'Paid' && !t.dismissed)
  const verified = debits.filter((t) => t.matched && t.matched.payment_status === 'Paid' && !t.dismissed)
  const unmatched = debits.filter((t) => !t.matched_expense_id && !t.dismissed)
  const dismissed = debits.filter((t) => t.dismissed)
  const paidNoMatch = detail?.paid_no_match || []

  const TxLine = ({ t, right }) => (
    <div className="flex items-center gap-3 px-3 py-2 border-b border-divider last:border-0 text-[13px]">
      <span className="text-gray-400 w-20 shrink-0 font-mono text-[12px]">{fmtDate(t.txn_date)}</span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-ink truncate">{t.payee_guess || '—'}</div>
        <div className="text-[11px] text-gray-400 truncate" title={t.description}>{t.description}</div>
      </div>
      <span className="font-bold text-ink whitespace-nowrap">{fmt(t.amount)}{t.currency !== 'USD' ? ` ${t.currency}` : ''}</span>
      {right}
    </div>
  )

  return (
    <div data-tour="bank-matching" className='p-4 sm:p-6 max-w-6xl mx-auto'>
      {/* ── BAND 1 — the title, the one number, the one action ───────────────
          This band held eight controls, and the page had eight bands above its
          first transaction row. Worse, four numbers on screen answered "how much
          is left" differently: the selector said 19, the badge 1,765, Review
          161, All 3,175. Everything that is not the queue or the primary action
          now sits behind ⋯ — one click away, and no longer competing. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* No <h1> and no "N left" here any more. Both are in the Banking
            header directly above — the page title reads "Banking", the tab
            reads "For review", and repeating either an inch below them is what
            made a screen with one job look like it had three. */}
        {/* The two ends of the same reconciliation. Statement → ledger is what
            this page has always done; ledger → statement is the half that was
            missing. */}
        <span className="inline-flex items-center rounded-lg border border-rule overflow-hidden">
          {[['statement', 'Statement → ledger'], ['ledger', 'Ledger → statement']].map(([d, label]) => (
            <button data-tour="bank-matching-direction" key={d} onClick={() => chooseDirection(d)}
              className={`text-[11px] font-bold px-2.5 py-1.5 transition-colors ${
                direction === d ? 'bg-boom-600 text-white' : 'text-gray-500 hover:text-ink hover:bg-gray-50'}`}>
              {label}
            </button>
          ))}
        </span>
        <span data-tour="bank-matching-review" className="ml-auto inline-flex items-center gap-2">
          {/* The primary action, in ink. The count is the MATCHING work — open
              rows plus booked rows with an invoice waiting — counted with the
              deck's own predicate so the button can't promise a number the deck
              it opens doesn't have. */}
          {(() => {
          const failed = rematch === 'error'
          const pending = rematch === null
          // Counted with the deck's OWN predicate over the same rows it gets,
          // rather than re-deriving from `unmatched` — which is debits-only and
          // silently dropped the 6 open credits the deck does review.
          const n = txns.filter((t) => deckWants(t, rematchByTxn)).length
          const proposals = failed || pending ? 0
            : rematchByTxn.size ? txns.filter((t) => t.matched_expense_id && rematchByTxn.has(t.id)).length : 0
          if (!n && !failed && !pending) return null
          return (
            <>
              {failed && (
                <button onClick={fetchRematch}
                  title="The match proposals couldn't be loaded, so this count is incomplete"
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-rose-600 hover:underline">
                  <AlertCircle size={12} /> proposals didn&rsquo;t load — retry
                </button>
              )}
              <button onClick={() => openDeck(txns)}
                title={failed
                  ? `${unmatched.length} unanswered. The booked rows with an invoice waiting could not be loaded, so this count is incomplete.`
                  : pending ? 'Still counting the matching work…'
                    : proposals
                      ? `${unmatched.length} unanswered and ${proposals} booked row${proposals === 1 ? '' : 's'} with an invoice waiting — matching first. The rest of what's left has nothing to act on yet.`
                      : `Review the ${n} item${n === 1 ? '' : 's'} that have something to act on, one at a time`}
                className="inline-flex items-center gap-1.5 bg-ink text-card rounded-lg px-3.5 py-1.5 text-[13px] font-bold hover:opacity-85 transition">
                <Zap size={13} />
                {/* No number until it is the RIGHT number. Proposals resolve
                    faster than the table's own fetch, so rendering the count
                    early showed a figure that silently changed — and on failure,
                    one that stayed plausibly wrong. */}
                Review{pending ? '' : failed ? ` ${unmatched.length}+` : ` ${n}`}
                {pending && <Loader size={12} className="animate-spin" />}
              </button>
            </>
          )
        })()}
          {/* Everything that isn't the queue.
              Each of these was its own header button competing with the primary
              action: Batch review, View file, Attribute (whose own tooltip says
              the work happens on Reports), Reset matching (destructive and
              rare), Statements, and the automation banner. Grouped by what they
              do, with the one that re-runs the matcher last. */}
          <span className="relative">
            <button onClick={() => setPageMenu(!pageMenu)}
              title="More — the statement file, rules, reset"
              className={`w-8 h-8 rounded-lg text-[16px] leading-none border ${
                pageMenu ? 'bg-gray-100 text-ink border-gray-300'
                  : 'bg-card text-gray-500 border-rule hover:text-ink hover:border-gray-300'}`}>
              &#8943;
            </button>
            {pageMenu && (
              <div className="absolute right-0 top-9 z-30 min-w-[272px] rounded-lg border border-rule bg-card shadow-modal overflow-hidden">

                <div className="px-3 pt-2 pb-1 border-t border-divider text-[11px] font-semibold text-gray-400">Elsewhere</div>
                {openId && openId !== 'all' && statements.find((st) => String(st.id) === String(openId))?.r2_key && (
                  <button onClick={() => { viewStmtFile(openId); setPageMenu(false) }}
                    className="block w-full text-left px-3 py-1.5 text-[13px] hover:bg-gray-50">
                    Open the statement file
                  </button>
                )}
                <a href="/bk/statements" className="block px-3 py-1.5 text-[13px] hover:bg-gray-50">
                  Statements — upload, coverage, flags
                </a>
                <a href="/bk/rules" className="block px-3 py-1.5 text-[13px] hover:bg-gray-50">
                  Upload rules — standing decisions
                </a>
                {/* Attribution is ledger METADATA, not bank-to-invoice matching.
                    Reports does it per-row and in bulk, in the drill where the
                    spend is read; this is only the doorway to it. */}
                <a href="/reports" className="block px-3 py-1.5 text-[13px] hover:bg-gray-50">
                  Attribute spend to an artist — on Reports
                </a>
                {/* The automation receipt. It was a banner across the top on
                    every visit; it is an audit trail, which is something you go
                    and look at, not something that should greet you. Kept
                    reachable so the receipts panel below it isn't orphaned. */}
                {autoDecisions && autoDecisions.total > 0 && (
                  <button onClick={() => { setAutoOpen(true); setPageMenu(false) }}
                    className="block w-full text-left px-3 py-1.5 text-[13px] hover:bg-gray-50">
                    What the rules decided
                    <span className="text-gray-400 tabular-nums"> · {autoDecisions.total} line{autoDecisions.total === 1 ? '' : 's'}</span>
                  </button>
                )}
                <div className="px-3 pt-2 pb-1 border-t border-divider text-[11px] font-semibold text-gray-400">Re-runs the matcher</div>
                <button onClick={() => { setPageMenu(false); resetMatching() }} disabled={resetBusy}
                  title="Clear every AUTO match and re-run the matcher with the current evidence (vendor links, aliases, FX, rejections). Manual matches, bookings, income, and dismissals are untouched."
                  className="flex items-center gap-2 w-full text-left px-3 py-1.5 pb-2.5 text-[13px] text-gray-500 hover:bg-gray-50 disabled:opacity-50">
                  <RefreshCw size={12} className={resetBusy ? 'animate-spin' : ''} />
                  Reset matching — every auto match
                </button>
              </div>
            )}
          </span>
        </span>
      </div>

      {/* Ledger → statement replaces the body wholesale. The existing page —
          bands, deck, batch view, every handler — renders unchanged under the
          other direction, so this cannot regress it. */}
      {direction === 'ledger' ? (
        <div className="mt-4"><UnmatchedLedgerPanel /></div>
      ) : (<>

      {/* Kept, though it costs a line: it is the only sentence on the page that
          says what the three answers ARE, and the page is not only read by the
          person who built it. A caption, not a band — no controls in it. */}
      <p className="text-[12px] text-gray-400 mt-1">
        Bank lines are the evidence. Match each one to an invoice, book it, or set it aside.
      </p>



      {/* ── BAND 2 — one progress line ───────────────────────────────────────
          Three stat cards became one bar, because what they held are parts of
          one whole and the GAP between them IS this page's job:
            ink   — matched: a real invoice behind it
            grey  — booked: accounted for, but by an entry the app invented
            track — open: nothing at all
          "Explained" counts the first two, "invoice-backed" only the first. As
          two separate cards they read as unrelated scores, and the bigger, more
          prominent one (94%) was the one furthest from the truth of the work. */}
      {detail && (() => {
        const usdOfRow = (t) => Number(t.usd ?? t.amount ?? 0)
        const live = debits.filter((t) => !t.dismissed)
        const total = live.reduce((n, t) => n + Math.abs(usdOfRow(t)), 0)
        const openAmt = live.filter((t) => !t.matched_expense_id)
          .reduce((n, t) => n + Math.abs(usdOfRow(t)), 0)
        // Round once, at the end. Summing rounded parts has broken a tie-out
        // here before by exactly a cent.
        const localPct = total > 0 ? Math.round(((total - openAmt) / total) * 100) : 100
        const ib = compOk ? completion.invoice_backed_pct : null
        const ex = compOk ? completion.explained_pct : localPct
        return (
          <div className="mt-2.5 mb-3">
            <div className="flex h-1.5 rounded-full overflow-hidden bg-gray-100">
              {ib != null && <div className="bg-ink" style={{ width: `${Math.max(0, Math.min(100, ib))}%` }} />}
              <div className="bg-gray-300" style={{ width: `${Math.max(0, Math.min(100, ex - (ib ?? ex)))}%` }} />
            </div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mt-1.5 text-[12px]">
              {ib != null ? (
                <>
                  <span className="text-gray-500">
                    <strong className="font-bold text-ink tabular-nums">{ib}%</strong> invoice-backed
                  </span>
                  <span className="text-gray-400 tabular-nums">{fmt(completion.matched.value)} has a document behind it</span>
                  <span className="text-gray-400 tabular-nums">{ex}% explained at all</span>
                </>
              ) : (
                /* Completion unknown — the figure this page can compute itself,
                   rather than a blank where the headline was. */
                <span className="text-gray-500">
                  <strong className="font-bold text-ink tabular-nums">{localPct}%</strong> explained
                  <span className="text-gray-400"> · {fmt(total - openAmt)} of {fmt(total)}</span>
                </span>
              )}
              {/* The mirror direction: ledger rows with no bank line to prove
                  them. They have no row in this table, so this is a link, not a
                  filter — as a stat card it competed with the queue's own
                  numbers for a worklist that lives on Flags. */}
              {paidNoMatch.length > 0 && (
                <a href="/flags"
                  title="Invoices marked paid with no bank line to prove it — worked on the Flags page"
                  className="ml-auto text-gray-400 hover:text-ink hover:underline tabular-nums">
                  {paidNoMatch.length} paid on the ledger with no bank proof →
                </a>
              )}
            </div>
          </div>
        )
      })()}

      {/* We think we found the invoice.
          Auto-match runs once, at upload, and never revisits a booked row — so
          an invoice submitted after its statement landed could never find its
          bank line. These are those pairs. Proposals only: accepting deletes
          the entry we invented and links the real one, which moves reported
          numbers, so each is confirmed by hand. */}
      {dispFilter === 'needs-invoice' && rematch?.pairs?.length > 0 && (
        <div className="mb-3 rounded-lg border border-rule bg-card shadow-card overflow-hidden">
          <div className="px-3.5 py-2 border-b border-divider flex flex-wrap items-baseline gap-x-2">
            <span className="text-[12px] font-semibold text-ink">
              {rematch.pairs.length} of these already have an invoice
            </span>
            <span className="text-[12px] text-gray-400 tabular-nums">
              {fmt(rematch.total)} · same vendor, same amount, within {rematch.window_days} days
            </span>
            {rematch.contested?.length > 0 && (
              <span className="text-[11px] text-ink-faint ml-auto"
                title="Two bank rows wanted the same invoice; the closer date won and the other is left for you">
                {rematch.contested.length} contested
              </span>
            )}
          </div>
          <div className="max-h-[420px] overflow-auto">
            {rematch.pairs.slice(0, 40).map((p) => (
              <div key={p.txn_id} className={`flex flex-wrap items-center gap-3 px-3.5 py-2.5 border-b border-divider last:border-0 ${
                rematchBusy === p.txn_id ? 'opacity-50' : ''}`}>
                {/* The bank line as it stands: our invented entry. */}
                <span className="min-w-[210px] flex-1">
                  <span className="block text-[13px] font-semibold text-ink truncate">
                    {displayCaseTitle(p.payee_guess || p.booked_payee)}
                  </span>
                  <span className="block text-[11px] text-gray-400 truncate">
                    {fmtDate(p.txn_date)} · booked as {p.booked_category || '—'}
                  </span>
                </span>
                <span className="text-[11px] text-ink-faint shrink-0">&rarr;</span>
                {/* The invoice we think settles it. */}
                <span className="min-w-[210px] flex-1">
                  <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
                    <span className="truncate">
                      {p.invoice_number ? `inv ${p.invoice_number}` : `entry #${p.expense_id}`}
                      <span className="font-normal text-gray-400"> · {p.invoice_payee}</span>
                    </span>
                    <DocButton row={{ ...p, id: p.expense_id }} quiet />
                  </span>
                  <span className="block text-[11px] text-gray-400 truncate">
                    {fmtDate(p.invoice_date)} · {p.payment_status || 'Unpaid'}
                    {p.invoice_artist ? ` · ${p.invoice_artist}` : ''}
                  </span>
                </span>
                {/* What agrees and what doesn't — the date gap is the only
                    thing that varies once vendor and amount are equal, so it
                    is the number worth showing. */}
                <span className={`text-[11px] font-bold tabular-nums shrink-0 ${
                  p.same_day ? 'text-emerald-600' : p.gap_days <= 7 ? 'text-gray-500' : 'text-amber-600'}`}>
                  {p.same_day ? 'same day' : `${p.gap_days}d apart`}
                </span>
                <span className="text-[13px] font-bold text-ink tabular-nums shrink-0 w-24 text-right">{fmt(p.usd)}</span>
                <button onClick={() => acceptRematch(p)} disabled={!!rematchBusy}
                  className="shrink-0 px-3 py-1.5 rounded-lg bg-ink text-card text-[12px] font-bold hover:opacity-85 disabled:opacity-40 transition">
                  {rematchBusy === p.txn_id ? <Loader size={12} className="animate-spin" /> : 'Use this invoice'}
                </button>
              </div>
            ))}
          </div>
          {rematch.pairs.length > 40 && (
            <div className="px-3.5 py-2 border-t border-divider text-[11px] text-gray-400">
              Showing the 40 largest of {rematch.pairs.length}. Accept some and the rest move up.
            </div>
          )}
        </div>
      )}


      {/* The receipts. Automation you cannot inspect is automation you have to
          take on faith, and this page's whole job is being able to defend a
          number later.
          Opened from the ⋯ menu now rather than from a banner that greeted you
          on every visit — an audit trail is something you go and look at. It
          carries its own close, because the banner's Hide button went with the
          banner and a panel you can't shut is worse than one you never opened. */}
      {autoOpen && autoDecisions && (
        <div className="mb-3 rounded-lg border border-rule bg-card shadow-card overflow-hidden">
          <div className="px-3.5 py-2 border-b border-divider text-[11px] text-gray-500 flex items-start gap-3">
            <span className="min-w-0">
              Matched without being asked, newest first — {autoDecisions.total} in the last {autoDecisions.days} days
              {autoDecisions.truncated ? `, most recent ${autoDecisions.shown} listed` : ''}.
              Every one is reversible: open the row and unmatch it.
            </span>
            <button onClick={() => setAutoOpen(false)} title="Close"
              className="ml-auto shrink-0 text-[12px] font-bold text-gray-400 hover:text-ink">Close</button>
          </div>
          <div className="max-h-72 overflow-auto">
            {autoDecisions.rows.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-3.5 py-1.5 border-b border-divider last:border-0 text-[12px]">
                <span className="text-gray-400 tabular-nums w-20 shrink-0">{fmtDate(r.txn_date)}</span>
                <span className="font-semibold text-ink truncate min-w-0 flex-1">{r.ledger_payee || r.payee_guess}</span>
                {/* WHICH entry, and whether a document backs it. Without these,
                    "every one is reversible — open the row and unmatch it" was
                    advice you couldn't act on from here: auditing an automatic
                    decision meant leaving the panel and hunting for the entry. */}
                {r.matched_expense_id && (
                  <a href={`/bk/ledger?focus=${r.matched_expense_id}`} target="_blank" rel="noreferrer"
                    title="Open the ledger entry this was matched to"
                    className="text-[11px] font-semibold text-gray-500 hover:text-ink hover:underline shrink-0">
                    {r.invoice_number ? `inv ${r.invoice_number}` : `entry #${r.matched_expense_id}`}
                  </a>
                )}
                {r.matched_expense_id && <DocButton row={{ ...r, id: r.matched_expense_id }} />}
                <span className="text-gray-400 truncate w-32 shrink-0">{r.category || ''}</span>
                <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500 bg-gray-100 rounded px-1 shrink-0">
                  {String(r.match_method).replace('auto-', '')}
                </span>
                <span className="tabular-nums font-semibold text-ink w-24 text-right shrink-0">{fmt(r.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {/* The attribution queue replaces the transaction table rather than
          stacking under it — it is a different question, not a filter of the
          same one. */}
      {openId && (detailLoading ? (
        <div className="text-[13px] text-gray-400 py-8 text-center">Loading transactions…</div>
      ) : detail && (() => {
        const dispOf = (t) => t.dismissed ? 'dismissed'
          : !t.matched_expense_id ? 'open'
          : t.match_method === 'created' ? 'booked'
          : (t.matched && t.matched.payment_status !== 'Paid') ? 'confirm'
          : 'matched'
        const withDisp = debits.map((t) => ({ ...t, disp: dispOf(t) }))
        const creditRows = credits.map((t) => ({
          ...t,
          disp: t.dismissed ? 'dismissed' : t.matched_income_id ? 'booked-income' : 'open-credit',
        }))
        const counts = withDisp.reduce((m, t) => { m[t.disp] = (m[t.disp] || 0) + 1; return m }, {})
        // Same set as the "Accept N likely" button — the chip filters to
        // exactly the rows that button would act on. One debit per invoice:
        // when two likely rows share a top suggestion, only the higher-scoring
        // one qualifies (the server rejects a second claim on the same invoice).
        const isLikely = (t) => t.disp === 'open' && (t.suggestions?.[0]?.score || 0) >= 90
        const hiConf = []
        const seenSugg = new Set()
        for (const t of [...withDisp.filter(isLikely)].sort((a, b) => b.suggestions[0].score - a.suggestions[0].score)) {
          if (seenSugg.has(t.suggestions[0].id)) continue
          seenSugg.add(t.suggestions[0].id)
          hiConf.push(t)
        }
        const likelyIds = new Set(hiConf.map((t) => t.id))
        const suggestedRows = withDisp.filter((t) => t.disp === 'open' && t.suggested_category)
        // Money that came back — either side of it. BOTH sides, because a pair is
        // only judgeable together: a $1,010 debit and its $1,010 credit are one
        // event, and showing one without the other is how a refund looks like
        // revenue. This is the same test `deckWants` now excludes on, written
        // once and read by the chip and its filter.
        const isReversalRow = (t) => !!(t.looks_like_reversal || t.reversal_of || t.reversed_by)
        const reversalRows = [...withDisp, ...creditRows].filter(isReversalRow)
        // needs-invoice, SCOPED TO WHAT IS ON SCREEN.
        //
        // `needsInvoiceIds` comes from /statements/completion, which answers
        // globally; `withDisp` is one statement when the picker is narrowed. The
        // ROWS were already scoped correctly, the COUNT was not — an invisible
        // over-count while these were eleven independent chips, and a visible
        // one now that three of them are meant to partition the same set.
        const needsInvoiceHere = withDisp.filter((t) => needsInvoiceIds.has(t.id))
        // CATEGORIZED = answered AND finished. Booked-but-still-owed-an-invoice
        // is deliberately subtracted: "Booked is not matched" is this page's
        // whole thesis, and a row the app invented an entry for with no document
        // behind it is not done. matched and confirm are never in the server's
        // needs_invoice set (it is booked-with-no-invoice), so in practice the
        // subtraction only bites on booked.
        //
        // What this buys: open + needs-invoice + categorized + dismissed ==
        // debits.length, so the three tabs partition the debits exactly. The
        // old chips did not — Open and Booked overlapped by every needs-invoice
        // row and summed to 4,921 against an All of 3,175.
        const CATEGORIZED_DISP = new Set(['matched', 'booked', 'confirm'])
        const categorizedRows = withDisp.filter(
          (t) => CATEGORIZED_DISP.has(t.disp) && !needsInvoiceIds.has(t.id))
        const CHIPS = [
          // The `all` filter excludes dismissed rows (see the rows chain below),
          // so the count has to as well, or the Refine entry advertises more
          // than the table it opens.
          ['all', 'All lines', debits.length - (counts.dismissed || 0)],
          // OPEN = not matched to a real ledger invoice.
          //
          // This counted only rows with no ledger entry at all (14), which is a
          // corner of the backlog, not the backlog. A BOOKED row has an entry —
          // but one the app invented from the bank line, with no invoice behind
          // it — so by the page's own definition of complete it is still open.
          //
          // The two sets are disjoint: one has no entry, the other has an
          // invented one. Excludes the rows marked as never getting an invoice,
          // so this number can actually reach zero.
          ['open', 'For review', (counts.open || 0) + needsInvoiceHere.length],
          ['categorized', 'Categorized', categorizedRows.length],
          ['likely', 'Likely', hiConf.length],
          ['suggested', 'Suggested', suggestedRows.length],
          ['flagged', 'Flagged', [...withDisp, ...creditRows].filter((t) => t.flagged).length],
          ['confirm', 'To confirm', counts.confirm || 0],
          ['matched', 'Matched', counts.matched || 0],
          ['booked', 'Booked', counts.booked || 0],
          // Booked is not done. These are rows we invented an entry for and
          // that a real invoice should still exist behind. Membership comes
          // from the server's id set rather than re-deriving the no-invoice
          // rules here, so the chip and the Coverage card can't drift apart.
          // Omitted entirely while unknown. Rendering "Needs invoice 0" on a
          // failed load says the work is done when 1,746 rows are waiting.
          ...(completion && completion !== 'error'
            ? [['needs-invoice', 'Needs invoice', needsInvoiceHere.length]] : []),
          // Money in has left this page. A credit is matched to artist_income,
          // not to an invoice — a different table and a different job.
          //
          // Reversals now leave the REVIEW DECK too: money that came back is
          // neither an expense to invoice nor income, so it has no answer to the
          // only question the deck asks. This chip is where they went — it is the
          // reason removing them from the deck doesn't hide them, and it covers
          // both sides of a pair, which is the only way to see one.
          //
          // Flags carries the same rows with their remedy spelled out
          // (`reversal-still-matched`); this chip is the local view of them.
          ['reversals', 'Reversals', reversalRows.length],
          ['dismissed', 'Excluded', counts.dismissed || 0],
        ]
        const q = txSearch.trim().toLowerCase()
        const matchesSearch = (t) => !q
          || (t.payee_guess || '').toLowerCase().includes(q)
          || (t.description || '').toLowerCase().includes(q)
          || (t.matched?.payee || '').toLowerCase().includes(q)
          || (t.payee_email || '').toLowerCase().includes(q)
          || String(t.amount).includes(q)
        // ── The page's DIMENSION — one derivation, four consumers ──────────
        //
        // The chip totals, the table column, the filter and the sort all ask
        // "what does this row belong to". They used to answer it twice (this
        // helper, plus an inline copy in the totals loop), which is how a chip
        // ends up summing rows the filter then doesn't show.
        //
        // ARTIST is a property of the MATCH, not the bank row: it comes from
        // t.matched.artist, so an unmatched debit has none by construction.
        // 477 of 2,829 debits carry one, across 93 artists.
        const NO_ARTIST = 'No artist'
        // bucket -> most-common spelling, so "feel trip" and "Feel Trip" are one
        // chip labelled the way it's usually written. Same rule Recoupments uses.
        const artistNames = (() => {
          const seen = {}
          for (const t of withDisp) {
            const raw = (t.matched?.artist || '').trim()
            const k = artistBucket(raw)
            if (!k || !raw) continue
            ;(seen[k] = seen[k] || {})[raw] = (seen[k][raw] || 0) + 1
          }
          const best = {}
          for (const [k, variants] of Object.entries(seen)) {
            best[k] = Object.entries(variants).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0]
          }
          return best
        })()
        const rowDim = (t) => {
          if (dimBy === 'artist') {
            const k = artistBucket(t.matched?.artist)
            return k ? (artistNames[k] || t.matched.artist.trim()) : NO_ARTIST
          }
          return t.disp === 'open' ? 'Unorganized'
            : (t.matched?.category || '').trim() || 'Uncategorized'
        }
        const rowCat = rowDim
        let rows = dispFilter === 'needs-invoice'
          ? withDisp.filter((t) => needsInvoiceIds.has(t.id) && matchesSearch(t))
          : dispFilter === 'open'
          // Same population the chip counts — a chip whose number doesn't match
          // the rows beneath it is the bug that produced two Review buttons.
          ? withDisp.filter((t) => (t.disp === 'open' || needsInvoiceIds.has(t.id)) && matchesSearch(t))

          : dispFilter === 'likely'
          ? withDisp.filter((t) => likelyIds.has(t.id) && matchesSearch(t))
          : dispFilter === 'suggested'
          ? withDisp.filter((t) => t.disp === 'open' && t.suggested_category && matchesSearch(t))
          : dispFilter === 'flagged'
          ? [...withDisp, ...creditRows].filter((t) => t.flagged && matchesSearch(t))
          : dispFilter === 'reversals'
          ? reversalRows.filter(matchesSearch)
          : dispFilter === 'categorized'
          ? categorizedRows.filter(matchesSearch)
          : withDisp.filter((t) =>
              (dispFilter === 'all' ? t.disp !== 'dismissed' : t.disp === dispFilter)
              && matchesSearch(t))
        if (catFilter && dispFilter !== 'credits') {
          rows = rows.filter((t) => rowCat(t) === catFilter)
        }
        // Confidence is the natural order for a match-first page: the rows the
        // ledger can explain lead, the guesses follow, and the ones it can't
        // explain at all sink — still present, which matters because the two
        // biggest open items (Venable $70,929, Tone $250,000) have no candidate.
        //
        // Applied only while the OPEN filter is active. Ordering matched or
        // booked rows by match confidence says nothing.
        const topScore = (t) => Number((t.suggestions || []).find((x) => !x.rejected)?.score || 0)
        const effSortKey = sortKey === 'auto' ? (dispFilter === 'open' ? 'confidence' : 'date') : sortKey
        rows = [...rows].sort((a, b) => {
          const dir = sortDir === 'asc' ? 1 : -1
          if (effSortKey === 'confidence') {
            const d = topScore(b) - topScore(a)
            // Tie-break by amount so a screenful of no-candidate rows still
            // leads with the money that matters most.
            return (d !== 0 ? d : Number(b.amount) - Number(a.amount)) * (sortDir === 'asc' ? -1 : 1)
          }
          if (effSortKey === 'amount') return (Number(a.amount) - Number(b.amount)) * dir
          if (effSortKey === 'payee') return String(a.payee_guess || '').localeCompare(String(b.payee_guess || '')) * dir
          if (effSortKey === 'category') {
            // An absence isn't a value: 'No artist' pins to the bottom in both
            // directions rather than sorting alphabetically among the N's,
            // matching how the chip strip already orders it.
            const [ka, kb] = [rowDim(a), rowDim(b)]
            if (ka === NO_ARTIST || kb === NO_ARTIST) {
              return ka === kb ? 0 : ka === NO_ARTIST ? 1 : -1
            }
            return ka.localeCompare(kb) * dir
          }
          return (String(a.txn_date) < String(b.txn_date) ? -1 : 1) * dir
        })

        // The per-dimension totals strip is gone — a report summary on a
        // worklist. It was a Category|Artist toggle plus five value chips plus
        // "+88 more", and with 2,698 of 3,175 debits carrying no artist most of
        // it read "No artist". Its two jobs both survive: the lens is a control
        // on the column it re-groups, and filtering is a click on the value in
        // that column. What it uniquely offered — spend per category — is what
        // the Reports P&L is for.
        //
        // All totals in USD estimates (t.usd) — summing raw amounts read a
        // ¥237,858 yen row as $237,858.
        const usdOfT = (t) => Number(t.usd ?? t.amount ?? 0)

        const liveDebits = withDisp.filter((t) => t.disp !== 'dismissed')
        const debitsTotal = liveDebits.reduce((s, t) => s + usdOfT(t), 0)
        const coveredTotal = liveDebits.filter((t) => t.matched_expense_id).reduce((s, t) => s + usdOfT(t), 0)
        const pct = debitsTotal > 0 ? Math.round((coveredTotal / debitsTotal) * 100) : 0

        const selRows = withDisp.filter((t) => unmatchedSel.has(t.id))
        const selOpen = selRows.filter((t) => t.disp === 'open')
        const selConfirm = selRows.filter((t) => t.disp === 'confirm')
        const selSuggested = selOpen.filter((t) => t.suggested_category)
        const selDismissed = selRows.filter((t) => t.disp === 'dismissed')
        // Rows that CAN be answered "no invoice": open or booked, and not already
        // answered. A row matched to a real invoice is excluded because the
        // document is already there — the server refuses it, and offering a
        // button that will be refused is the dead-end this page keeps fixing.
        const selNoInvoice = selRows.filter((t) =>
          (t.disp === 'open' || t.disp === 'booked') && !t.no_invoice_expected)
        // Two different undos, counted separately and labelled separately.
        // Unmatching returns an invoice to the pool; unbooking DELETES an entry
        // the app invented. One button covering both would do more than it says.
        const selMatched = selRows.filter((t) => t.matched_expense_id && t.match_method !== 'created')
        const selBooked = selRows.filter((t) => t.matched_expense_id && t.match_method === 'created')

        // `effSortKey` rather than `sortKey`, so the arrow appears on the
        // column actually doing the sorting while sortKey is still 'auto'.
        // Otherwise the open queue sorts by confidence with no header marked
        // and the order looks arbitrary.
        const sortHeader = (key, label, cls = '') => (
          <th className={`px-2 py-2 text-left text-[11px] font-semibold text-gray-400 cursor-pointer select-none whitespace-nowrap ${cls}`}
            onClick={() => effSortKey === key ? setSortDir(sortDir === 'asc' ? 'desc' : 'asc') : (setSortKey(key), setSortDir(key === 'payee' || key === 'category' ? 'asc' : 'desc'))}>
            {label}{effSortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
          </th>
        )
        // Dot + text: color carries the meaning without shouting.
        const DISP_DOT = {
          open:            'bg-rose-500',
          confirm:         'bg-amber-500',
          matched:         'bg-emerald-500',
          booked:          'bg-emerald-600',
          dismissed:       'bg-gray-300',
          'open-credit':   'bg-sky-400',
          'booked-income': 'bg-sky-600',
        }
        const DISP_LABEL = {
          open: 'Open', confirm: 'Unpaid match', matched: 'Matched', booked: 'Booked',
          dismissed: 'Dismissed', 'open-credit': 'Credit', 'booked-income': 'Income',
        }

        // ── Three buckets, and everything else behind Refine ───────────────
        //
        // Eleven chips behind a more/less toggle read as a breakdown of All, and
        // they were not one: Open and Booked overlapped by every needs-invoice
        // row and summed to 4,921 against an All of 3,175.
        //
        // QuickBooks asks the question in three: For review / Categorized /
        // Excluded. These three DO partition the debits — see CATEGORIZED_DISP
        // above — so the row that looks like arithmetic now is arithmetic. The
        // other nine filters are real worklists and stay reachable, one click
        // deeper, in the Refine menu beside the search box.
        //
        // `dispFilter` is still ONE string and the filter vocabulary is
        // unchanged apart from the added 'categorized'. That is deliberate: the
        // buckets are a presentation over the existing value, so every deep link
        // into this page (BkRules' ?filter=needs-invoice, BkLedger's
        // ?filter=booked, the ?q= links from Vendors and Reports) keeps working
        // by construction rather than by a translation table anybody has to
        // maintain.
        const BUCKETS = [['open', 'For review'], ['categorized', 'Categorized'], ['dismissed', 'Excluded']]
        const bucketChips = BUCKETS.map(([k, label]) => {
          const chip = CHIPS.find(([c]) => c === k)
          return [k, label, chip ? chip[2] : 0]
        })
        // Which bucket a refinement belongs under. `all`, `flagged` and
        // `reversals` are deliberately absent: each spans every disposition AND
        // the credit side, so lighting a tab for them would put a count next to
        // rows it does not cover. They show as the Refine pill alone.
        const BUCKET_OF = {
          open: 'open', likely: 'open', suggested: 'open', 'needs-invoice': 'open',
          categorized: 'categorized', confirm: 'categorized', matched: 'categorized', booked: 'categorized',
          dismissed: 'dismissed',
        }
        const activeBucket = BUCKET_OF[dispFilter] || null
        // Everything that is not itself a bucket, grouped so the menu says which
        // bucket each one narrows. Built from the SAME CHIPS tuples as the tabs,
        // so a count cannot drift between the tab and the menu entry under it.
        const chipOf = (k) => CHIPS.find(([c]) => c === k)
        const refineGroup = (label, keys) => ({
          key: label, label,
          items: keys.map(chipOf).filter(Boolean).map(([value, l, n]) => ({
            value, label: n > 0 ? `${l}  ${n.toLocaleString()}` : l,
          })),
        })
        const REFINE_GROUPS = [
          refineGroup('', ['all']),
          refineGroup('In review', ['likely', 'suggested', 'needs-invoice']),
          refineGroup('Categorized', ['confirm', 'matched', 'booked']),
          refineGroup('Across every state', ['flagged', 'reversals']),
        ].filter((g) => g.items.length)
        const REFINE_OPTIONS = REFINE_GROUPS.flatMap((g) => g.items)
        // The pill only appears for a refinement, never for a bare bucket —
        // standing on "For review" is not a narrowing anybody needs told about.
        const activeRefine = REFINE_OPTIONS.find((o) => o.value === dispFilter) || null

        return (
        <div className="space-y-3">
          {/* Upload receipt — what the automation did on ingest */}
          {detail.statement?.import_summary && (
            <p className="text-[12px] text-gray-400">
              On upload: {detail.statement.import_summary.auto_matched ?? 0} auto-matched
              · {detail.statement.import_summary.rule_booked ?? 0} booked by rule
              · {detail.statement.import_summary.rule_dismissed ?? 0} dismissed by rule
              {(detail.statement.import_summary.dup_skipped ?? 0) > 0 && (
                <span className="text-amber-600 font-semibold"> · {detail.statement.import_summary.dup_skipped} duplicate{detail.statement.import_summary.dup_skipped === 1 ? '' : 's'} skipped</span>
              )}
            </p>
          )}

          {/* ONE SURFACE. The controls used to float on the grey page above a
              carded table — three separate groups, none of them attached to the
              thing they act on. They are now the header of the same card: the
              statement selector and tabs on top, search and bulk actions under
              them, the rows below, one border around the lot. This is most of
              what "looks homemade" was. */}
          <div data-tour="bank-matching-filters" className="bg-card border border-rule border-b-0 rounded-t-xl px-3.5 pt-3 pb-3 space-y-3">
          {/* ── BAND 3 — narrowing: which statement, which state ────────────
              The selector lives here now, with the filters, because that is what
              it is. It used to sit in the title row next to a strip of statement
              chips doing the same job with a different number. */}
          <div className="flex flex-wrap items-center gap-2">
            {/* The statement picker lives in the Banking header above. It
                scopes all four tabs, carries the same per-statement "N left",
                and having one here as well is what made choosing a month feel
                like a thing you did twice. */}
            {/* TABS, not a segmented pill.
                Same filter, same keys, same counts — CHIPS is untouched, so the
                numbers cannot drift from what the chips reported. What changes is
                that this now reads like the rest of the app: underline tabs in
                brand red, the language ReleaseDetail and Team already use. A
                banking screen states its queues along the top, and "looks
                homemade" is largely this control having been invented here. */}
            <div className="flex items-end gap-4 border-b border-rule -mb-px overflow-x-auto">
              {bucketChips.map(([key, label, n]) => (
                <button key={key} onClick={() => setDispFilter(key)}
                  title={key === 'open' ? 'Nothing decided yet, plus the rows booked with no invoice behind them'
                    : key === 'categorized' ? 'Answered and finished — matched to an invoice, or booked and not owed one'
                    : 'Set aside: transfers, duplicates and lines that need no entry'}
                  className={`relative pb-2 pt-1 text-[13px] font-semibold whitespace-nowrap transition -mb-px border-b-2 ${
                    activeBucket === key
                      ? 'text-boom-600 border-boom-500'
                      : 'text-gray-500 border-transparent hover:text-ink'}`}>
                  {label}
                  {n > 0 && (
                    <span className={`ml-1.5 tabular-nums text-[12px] ${activeBucket === key ? 'text-boom-600' : 'text-gray-400'}`}>
                      {n.toLocaleString()}
                    </span>
                  )}
                </button>
              ))}
              {/* THE FUNDING-PAIR QUEUE, at the right end of the tabs — it is
                  another queue, so it belongs beside the others rather than in a
                  band of its own at the foot of the page. Loaded on demand: the
                  audit scans every live debit. */}
              <span className="ml-auto flex items-center gap-2 pb-2 whitespace-nowrap">
                {!fxSummary ? (
                  <button onClick={openFxDeck} disabled={fxBusy}
                    className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-gray-500 hover:text-ink">
                    {fxBusy ? <Loader size={12} className="animate-spin" /> : <Zap size={12} />}
                    Funding pairs
                  </button>
                ) : (
                  <>
                    <span className="text-[12px] text-gray-500">
                      <strong className="font-bold text-ink tabular-nums">{fxSummary.total}</strong> funding pairs
                      {fxSummary.usd > 0 && <span className="tabular-nums"> · ${fxSummary.usd.toFixed(2)} twice</span>}
                    </span>
                    {fxSummary.total > 0 && (
                      <button onClick={openFxDeck} disabled={fxBusy}
                        className="text-[12px] font-bold text-boom-600 hover:underline">review →</button>
                    )}
                  </>
                )}
              </span>

            </div>
          </div>

          {/* ── BAND 4 — search, and what you can do to what's showing ───────
              Every action on the current rows, in one row. Re-review and Re-run
              matching each had their own half-empty band above this one, on the
              right, with dead space around them. */}
          <div className="flex flex-wrap items-center gap-2">
            <input value={txSearch} onChange={(e) => setTxSearch(e.target.value)} placeholder="Search payee, description, amount…"
              className="flex-1 min-w-[180px] border border-rule rounded-lg px-3 py-1.5 text-[13px] bg-card text-ink outline-none" />
            {/* REFINE — the nine filters that are not one of the three buckets.
                PickerMenu rather than a hand-rolled dropdown: it is portalled
                (this sits inside an overflow-x-auto wrapper, which clips an
                absolutely-positioned menu), it closes on outside mousedown, and
                its keyboard handling stops propagating — the review decks bind
                bare D / F / R / 1-9, and a filter box that also dismisses the
                card is worse than no filter box. It is already the category
                picker on this page, so it adds no new visual language.
                `value` stays '' so the trigger is a fixed-width target; what is
                active shows as the pill beside it. */}
            <PickerMenu
              value=""
              placeholder="Refine ▾"
              menuWidth={264}
              groups={REFINE_GROUPS}
              options={REFINE_OPTIONS}
              onSelect={setDispFilter}
              title="Narrow to a subset — likely matches, needs-invoice, flagged, reversals…"
              className="text-[13px] border border-rule rounded-lg px-2.5 py-1.5 bg-card text-ink hover:border-gray-300"
            />
            {/* What is narrowing this, once the menu has closed. Clearing
                returns to For review, the page's default — not to the bucket the
                refinement sat under, because the refinement is usually why you
                came. */}
            {activeRefine && (
              <button onClick={() => setDispFilter('open')}
                title="Clear this refinement and go back to For review"
                className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-ink border border-ink rounded-lg px-2 py-1">
                {activeRefine.label}
                <X size={11} />
              </button>
            )}
            {/* The dimension filter, when one is on. Set by clicking a value in
                the table's own Category/Artist column. Sits here beside Refine
                now: BAND 3 says which statement and which bucket, BAND 4 says
                what is narrowing it further and what you can do about it. */}
            {catFilter && (
              <button onClick={() => setCatFilter('')}
                title={`Clear the ${dimBy} filter`}
                className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-ink border border-ink rounded-lg px-2 py-1">
                {dimBy === 'artist' ? 'Artist' : 'Category'}: {catFilter}
                <X size={11} />
              </button>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {/* Re-review the FILTERED rows — second-guess past decisions:
                  redistribute a bloated category, audit dismissals. Shows
                  whenever the current filter includes handled items. */}
              {rows.length > 0 && rows.some((t) => t.dismissed || t.matched_expense_id || t.matched_income_id) && (
                <button onClick={() => openDeck(rows, { rereview: true })}
                  title={`Run the deck over the ${rows.length} filtered row${rows.length === 1 ? '' : 's'}${catFilter ? ` (${catFilter})` : ''} — keep, re-categorize, unmatch, or restore each one`}
                  className="inline-flex items-center gap-1.5 border border-rule text-gray-600 hover:text-ink hover:border-gray-300 rounded-lg px-3 py-1.5 text-[12px] font-bold">
                  <Undo2 size={12} /> Re-review {rows.length}
                </button>
              )}
              {/* ONE additive re-run, following the statement selector.
                  It was gated on `openId !== 'all'`, so on the page's DEFAULT
                  view — All statements — there was no way to ask the matcher to
                  look again. The alternatives were waiting for the nightly sweep
                  or pressing Reset matching, which clears every match including
                  the manual ones. That is the "without resetting" John asked for.
                  No confirm: it only reads rows that have no match, and each
                  match it makes is reversible on its own row. Reset confirms
                  because it destroys; nagging here would just train people to
                  click through the dialog that matters. */}
              <button onClick={runMatch} disabled={matching}
                title={openId && openId !== 'all'
                  ? 'Run the matcher again over this statement\'s unmatched rows. Nothing already matched is touched.'
                  : 'Run the matcher again over every statement\'s unmatched rows. Nothing already matched is touched — this is the additive counterpart to Reset matching.'}
                className="inline-flex items-center gap-1.5 border border-rule rounded-lg px-3 py-1.5 text-[12px] font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                <RefreshCw size={12} className={matching ? 'animate-spin' : ''} />
                {matching ? 'Matching…' : 'Match again'}
              </button>
              {hiConf.length > 0 && (
                <button onClick={() => acceptHighConfidence(hiConf)} disabled={bulkBusy}
                  className="inline-flex items-center gap-1.5 bg-ink text-card hover:opacity-85 rounded-lg px-3 py-1.5 text-[12px] font-bold disabled:opacity-40">
                  {bulkBusy ? <Loader size={12} className="animate-spin" /> : <Link2 size={12} />}
                  Accept {hiConf.length} likely
                </button>
              )}
              {selSuggested.length > 0 && (
                <button onClick={() => bulkBookSuggested(selSuggested)} disabled={bulkBusy}
                  className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg px-3 py-1.5 text-[12px] font-bold disabled:opacity-40">
                  {bulkBusy ? <Loader size={12} className="animate-spin" /> : <Zap size={12} />}
                  Book {selSuggested.length} to suggestions
                </button>
              )}
              {selDismissed.length > 0 && (
                <button onClick={() => bulkRestore(selDismissed.map((t) => t.id))} disabled={bulkBusy}
                  className="border border-rule text-gray-600 hover:bg-gray-50 rounded-lg px-3 py-1.5 text-[12px] font-bold disabled:opacity-40">
                  Restore {selDismissed.length}
                </button>
              )}
              {selOpen.length > 0 && (
                <>
                  <div className="inline-flex items-stretch rounded-lg overflow-hidden border border-emerald-300">
                    <select value={bulkCategory} onChange={(e) => setBulkCategory(e.target.value)}
                      className="bg-card text-emerald-800 text-[12px] font-semibold px-2 py-1.5 outline-none border-r border-emerald-200">
                      {catExpense.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <button onClick={() => bulkBook(selOpen.map((t) => t.id))} disabled={bulkBusy}
                      className="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-[12px] font-bold disabled:opacity-40">
                      Book {selOpen.length}
                    </button>
                  </div>
                  <button onClick={() => bulkDismiss(selOpen.map((t) => t.id))} disabled={bulkBusy}
                    className="border border-rose-300 text-rose-700 hover:bg-rose-100 rounded-lg px-3 py-1.5 text-[12px] font-bold disabled:opacity-40">
                    Dismiss {selOpen.length}
                  </button>
                </>
              )}
              {/* Offered on OPEN and BOOKED rows alike — a booked row is the
                  commonest shape here (the app invented an entry, no invoice is
                  coming), and restricting this to open rows would miss 1,257 of
                  the 1,269 that qualify. */}
              {selNoInvoice.length > 0 && (
                <button onClick={() => bulkNoInvoice(selNoInvoice.map((t) => t.id))} disabled={bulkBusy}
                  title="These payments never had an invoice — payroll, card autopay, subscriptions. Stops them being asked about; reversible per row."
                  className="border border-rule text-gray-600 hover:text-ink hover:bg-gray-50 rounded-lg px-3 py-1.5 text-[12px] font-bold disabled:opacity-40">
                  No invoice needed · {selNoInvoice.length}
                </button>
              )}
              {selMatched.length > 0 && (
                <button onClick={() => bulkUnmatch(selMatched.map((t) => t.id))} disabled={bulkBusy}
                  title="Detach these from their invoices. The invoices go back to waiting for a bank line; a row that displaced a booking gets it back."
                  className="inline-flex items-center gap-1.5 border border-rule text-gray-600 hover:text-ink rounded-lg px-3 py-1.5 text-[12px] font-bold disabled:opacity-40">
                  Unmatch {selMatched.length}
                </button>
              )}
              {selBooked.length > 0 && (
                <button onClick={() => bulkUnbook(selBooked.map((t) => t.id))} disabled={bulkBusy}
                  title="Remove the entry the app invented for each of these and reopen the row. Rows with a real invoice are not included."
                  className="inline-flex items-center gap-1.5 border border-rule text-gray-600 hover:text-ink rounded-lg px-3 py-1.5 text-[12px] font-bold disabled:opacity-40">
                  Unbook {selBooked.length}
                </button>
              )}
              {selConfirm.length > 0 && (
                <button onClick={() => confirmPaidIds(selConfirm.map((t) => t.id))} disabled={confirming}
                  className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg px-3 py-1.5 text-[12px] font-bold disabled:opacity-40">
                  {confirming ? <Loader size={12} className="animate-spin" /> : <CheckCircle2 size={13} />}
                  Mark {selConfirm.length} Paid
                </button>
              )}
            </div>
          </div>

          </div>
          {/* The mini-ledger */}
          <div className="bg-card border border-rule rounded-b-xl rounded-t-none overflow-x-auto -mt-3">
            <table className="w-full" style={{ minWidth: 820 }}>
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-rule">
                  <th className="pl-3 py-2 w-8">
                    <input type="checkbox"
                      checked={rows.length > 0 && rows.every((t) => unmatchedSel.has(t.id))}
                      onChange={() => {
                        const all = rows.every((t) => unmatchedSel.has(t.id))
                        setUnmatchedSel((prev) => {
                          const n = new Set(prev)
                          rows.forEach((t) => { all ? n.delete(t.id) : n.add(t.id) })
                          return n
                        })
                      }} />
                  </th>
                  {sortHeader('date', 'Date', 'w-24')}
                  {sortHeader('payee', 'Payee')}
                  {/* THE LENS LIVES ON THE COLUMN IT CHANGES.
                      It was a Category|Artist toggle above a strip of 5 value
                      chips plus "+88 more" — a report summary sitting on a
                      worklist, and 2,698 of 3,175 debits have no artist at all,
                      so most of that strip was "No artist". Here it is one
                      control on the one column it re-groups, and clicking a
                      VALUE in the column filters to it (the chips' other job).
                      Sorting stays on the label; switching stays on the arrows. */}
                  <th className="px-2 py-2 text-left w-44">
                    <span className="inline-flex items-center gap-1.5">
                      <span onClick={() => effSortKey === 'category'
                        ? setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
                        : (setSortKey('category'), setSortDir('asc'))}
                        className="text-[11px] font-semibold text-gray-400 cursor-pointer select-none whitespace-nowrap hover:text-ink">
                        {dimBy === 'artist' ? 'Artist' : 'Category'}
                        {effSortKey === 'category' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </span>
                      <button
                        onClick={() => { setDimBy(dimBy === 'artist' ? 'category' : 'artist'); setCatFilter('') }}
                        title={dimBy === 'artist'
                          ? 'Show the spend category instead'
                          : 'Show the artist on the matched ledger entry instead'}
                        className="text-[11px] font-bold text-gray-300 hover:text-ink px-1 rounded border border-transparent hover:border-rule">
                        {dimBy === 'artist' ? 'category' : 'artist'}
                      </button>
                    </span>
                  </th>
                  {sortHeader('amount', 'Amount', 'w-24 text-right')}
                  <th className="px-2 py-2 text-left text-[11px] font-semibold text-gray-400 w-32">Status</th>
                  <th className="px-2 py-2 w-48"></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={7} className="px-10 py-12">
                    {/* Artist + Open is empty BY CONSTRUCTION, not by accident:
                        the artist comes from the matched ledger entry, and an
                        open row is by definition unmatched. An unexplained
                        blank table reads as a broken filter, so this draws the
                        reason and offers the two ways out. */}
                    {dimBy === 'artist' && dispFilter === 'open' ? (
                      <div className="flex flex-col items-center">
                        <div className="flex items-center mb-5">
                          <div className="w-[104px] rounded-lg border border-rule bg-elev px-3 py-2.5">
                            <div className="text-[11px] font-semibold text-gray-400">Bank line</div>
                            <div className="text-[12px] mt-0.5 text-ink">date, amount</div>
                          </div>
                          <div className="w-14 h-px bg-rule" />
                          <div className="w-[18px] h-[18px] shrink-0 rounded-full border border-alert-bd bg-alert-bg text-alert text-[11px] flex items-center justify-center">&times;</div>
                          <div className="w-14 h-px bg-rule" />
                          <div className="w-[104px] rounded-lg border border-rule bg-elev px-3 py-2.5">
                            <div className="text-[11px] font-semibold text-gray-400">Artist</div>
                            <div className="text-[12px] mt-0.5 text-ink">from the entry</div>
                          </div>
                        </div>
                        <div className="max-w-[440px] text-center">
                          <div className="text-[14px] font-semibold text-ink mb-1">Nothing here, and that&rsquo;s correct</div>
                          <p className="text-[13px] leading-relaxed text-gray-500">
                            Open items have no artist yet &mdash; an artist comes from the entry a transaction is
                            matched to. Matching them is what fills this view.
                          </p>
                        </div>
                        <div className="flex gap-2 mt-4">
                          <button onClick={() => setDimBy('category')}
                            className="px-3.5 py-2 rounded-lg bg-ink text-card text-[13px] font-bold hover:opacity-85 transition">
                            Switch to Category
                          </button>
                          <button onClick={() => setDispFilter('all')}
                            className="px-3.5 py-2 rounded-lg border border-rule text-[13px] font-semibold text-gray-600 hover:bg-gray-50 transition">
                            Show all lines
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-center text-[13px] text-gray-400">Nothing here &mdash; adjust the filter or search.</div>
                    )}
                  </td></tr>
                )}
                {(() => {
                const renderTxRow = (t) => (
                  <Fragment key={t.id}>
                    <tr className={`border-b border-divider hover:bg-gray-50/60 ${t.disp === 'dismissed' ? 'opacity-50' : ''}`}>
                      <td className="pl-3 py-2 align-top">
                        <input type="checkbox" checked={unmatchedSel.has(t.id)}
                          onChange={() => setUnmatchedSel((prev) => { const n = new Set(prev); n.has(t.id) ? n.delete(t.id) : n.add(t.id); return n })} />
                      </td>
                      <td className="px-2 py-2 align-top text-[12px] text-gray-400 tabular-nums whitespace-nowrap">{fmtDate(t.txn_date)}</td>
                      <td className="px-2 py-2 align-top min-w-0">
                        {(() => {
                          // Present rows the way the statement does: name as
                          // the title, email as its own quiet line, and the
                          // transaction type only when it says something
                          // ("General Payment" on every row is noise).
                          const title = t.matched?.payee || (t.payee_guess || '').trim() || t.description || '—'
                          const desc = (t.description || '').trim()
                          // Only render lines that ADD information — the fee
                          // rows were printing the same words three times.
                          const genericDesc = /^general payment( — .*)?$/i.test(desc) || restates(title, desc)
                          const bankDiffers = t.matched && (t.payee_guess || '').trim() && !restates(t.matched.payee, t.payee_guess)
                          return (
                            <>
                              <div className="text-[13px] font-semibold text-ink truncate max-w-[280px]" title={title}>
                                {(() => {
                                  // A NEW TAB, via the shared PayeeLink, rather
                                  // than the in-place <Link> this used to be.
                                  // Navigating away from here does not just cost
                                  // a scroll position: it drops the bulk
                                  // selection, the rows scrolled into view past
                                  // the first 120, the sort, the armed
                                  // candidates — and `rowRecoup` / `rowArtist`,
                                  // which are unsaved ANSWERS on rows somebody
                                  // was about to book. That is work, not a place.
                                  //
                                  // `payee` is the href name, `children` the
                                  // display text: `title` may be the description
                                  // and is case-normalised for reading, and
                                  // passing it as the payee would both put a
                                  // sentence in the URL and undo displayCaseTitle.
                                  const name = txVendorLinkName(t)
                                  if (!name) return displayCaseTitle(title)
                                  return (
                                    <PayeeLink payee={name} className="hover:text-boom-600">
                                      {displayCaseTitle(title)}
                                    </PayeeLink>
                                  )
                                })()}
                                {t.matched?.invoice_number ? <span className="text-gray-400 font-normal"> · inv {t.matched.invoice_number}</span> : null}
                              </div>
                              {/* This row is a PayPal copy of a bank line the app
                                  can already pair it with. Saying so stops the
                                  queue asking for work it has itself worked out —
                                  and the two actions on the row ("No invoice",
                                  "Unbook") are both the wrong answer for it. */}
                              {(() => {
                                const twin = fxPairIdx.get(t.id)
                                if (!twin) return null
                                return (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); openFxDeck() }}
                                    title={`This is the PayPal copy of a ${twin.amount} bank line on ${String(twin.date).slice(0, 10)} — close it in the funding-pair deck`}
                                    className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-bold text-violet-700 hover:underline"
                                  >
                                    <Zap size={10} /> funding pair · ${twin.amount} on {String(twin.date).slice(5, 10)}
                                  </button>
                                )
                              })()}
                              {t.payee_email && (
                                <div className="text-[11px] text-gray-400 font-mono truncate max-w-[280px]">{t.payee_email}</div>
                              )}
                              {desc && !genericDesc && (
                                <div className="text-[11px] text-gray-400 truncate max-w-[280px]" title={desc}>{desc}</div>
                              )}
                              {bankDiffers && (
                                <div className="text-[11px] text-gray-400 truncate max-w-[280px]">bank: {t.payee_guess}</div>
                              )}
                              {openId === 'all' && t.statement_filename && (
                                <div className="text-[11px] text-gray-300 truncate max-w-[280px]">{t.statement_filename}</div>
                              )}
                            </>
                          )
                        })()}
                      </td>
                      <td className="px-2 py-2 align-top">
                        {t.disp === 'open' ? (
                          // Row-level booking in the mini-ledger. Creating here
                          // is useful for the same reason as in the deck: this
                          // is the moment you find the category missing.
                          //
                          // DEMOTED, NOT SLOWED. Booking is still one click —
                          // it resolves 82% of bank rows and making it harder
                          // would wreck the page's main job. But this page is
                          // for MATCHING, so when the ledger offers a candidate
                          // the loud emerald control isn't the answer and
                          // shouldn't look like it. With no candidate, booking
                          // IS the only move, so it keeps the emphasis.
                          <div className="space-y-1">
                            {/* WHO it was for, asked BEFORE the click that
                                commits. Picking the category books the row, so
                                the artist has to be set first — that ordering is
                                the whole design: an artist control that appeared
                                after booking would be asking at the exact moment
                                people move on, which is how thousands of booked
                                rows ended up naming nobody.

                                Optional on purpose. Most rows are overhead and
                                belong to no artist, and blank is not sent at all
                                so the vendor's standing answer still applies. */}
                            <ArtistSelect
                              value={rowArtist[t.id] || ''}
                              options={roster}
                              placeholder="artist…"
                              disabled={bulkBusy}
                              onChange={(v) => setRowArtist((p) => ({ ...p, [t.id]: v }))}
                              className={`w-full border border-dashed rounded-lg px-2 py-1 text-[12px] bg-card cursor-pointer ${
                                (rowArtist[t.id] || '').trim()
                                  ? 'border-violet-300 text-violet-700 font-semibold'
                                  : 'border-rule text-gray-400 hover:text-ink hover:border-gray-300'}`}
                            />
                            {/* BEFORE the category, for the same reason the
                                artist is: picking a category IS the booking, so
                                anything asked after it would be asked of a row
                                that has already gone. Optional — unanswered
                                books as it always did. */}
                            <RecoupAnswer compact
                              value={rowRecoup[t.id] ?? null}
                              disabled={bulkBusy}
                              onChange={(v) => setRowRecoup((p) => ({ ...p, [t.id]: v }))}
                            />
                          <CategorySelect
                            value=""
                            kind="expense"
                            disabled={bulkBusy}
                            onChange={(v) => v && bookInline(t, v)}
                            placeholder={(t.suggestions || []).length ? 'or book as…' : 'Categorize…'}
                            className={`w-full border border-dashed rounded-lg px-2 py-1 text-[12px] bg-card cursor-pointer ${
                              (t.suggestions || []).length
                                ? 'border-rule text-gray-500 hover:text-ink hover:border-gray-300'
                                : 'border-emerald-300 text-emerald-700 font-semibold'}`}
                          />
                          </div>
                        ) : t.disp === 'open-credit' ? (
                          <CategorySelect
                            value=""
                            kind="income"
                            disabled={bulkBusy}
                            onChange={(v) => v && bookIncome(t, v)}
                            placeholder="Income type…"
                            className="w-full border border-dashed border-sky-300 rounded-lg px-2 py-1 text-[12px] bg-card text-sky-700 font-semibold cursor-pointer"
                          />
                        ) : t.disp === 'booked-income' ? (
                          <span className="text-[12px] text-gray-600">{t.income?.income_type || 'Income'}</span>
                        ) : (
                          // Follows the lens, so the column always agrees with
                          // the header above it — and the VALUE filters, which is
                          // the job the removed chip strip used to do. Filtering
                          // from the value you can see beats hunting for it in a
                          // strip of five plus "+88 more".
                          <span className="flex items-center gap-1.5 flex-wrap">
                            {(() => {
                              // A booked row's artist is EDITABLE — under the
                              // artist lens the control is the cell, so the
                              // value isn't rendered twice.
                              if (t.disp === 'booked' && dimBy === 'artist') return null
                              const val = dimBy === 'artist' ? rowDim(t) : (t.matched?.category || '')
                              const muted = !val || val === NO_ARTIST
                              if (muted) return <span className="text-[12px] text-gray-300">{val || '—'}</span>
                              return (
                                <button onClick={() => setCatFilter(catFilter === val ? '' : val)}
                                  title={catFilter === val ? `Clear the ${dimBy} filter` : `Show only ${val}`}
                                  className={`text-[12px] text-left hover:text-ink hover:underline ${
                                    catFilter === val ? 'text-ink font-semibold' : 'text-gray-600'}`}>
                                  {val}
                                </button>
                              )
                            })()}
                            {/* What backs this match — or that nothing does. */}
                            {t.matched && <DocButton row={{ ...t.matched, id: t.matched_expense_id }} />}
                            {/* Booked rows only. A MATCHED row's artist comes off
                                the invoice a vendor sent; changing it there is a
                                different decision and belongs on the ledger. A
                                booked row's artist was never asked for by
                                anything — that is the gap. */}
                            {t.disp === 'booked' && (
                              <ArtistSelect
                                value={t.matched?.artist || ''}
                                options={roster}
                                placeholder="artist…"
                                disabled={bulkBusy}
                                onChange={(v) => saveBookedArtist(t, v)}
                                className={`w-full border border-dashed rounded-lg px-2 py-1 text-[12px] bg-card cursor-pointer ${
                                  (t.matched?.artist || '').trim()
                                    ? 'border-rule text-gray-600'
                                    : 'border-violet-300 text-violet-600 font-semibold'}`}
                              />
                            )}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 align-top text-right font-semibold text-[13px] text-ink whitespace-nowrap tabular-nums">
                        {t.currency !== 'USD' ? (
                          <>
                            {Number(t.amount).toLocaleString()} {t.currency}
                            <div className="text-[11px] font-normal text-gray-400 tabular-nums">≈{fmt(t.usd ?? t.amount)}</div>
                          </>
                        ) : fmt(t.amount)}
                      </td>
                      <td className="px-2 py-2 align-top whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-gray-600">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DISP_DOT[t.disp]}`} />
                          {DISP_LABEL[t.disp]}
                          {t.match_method && t.disp !== 'open' && t.disp !== 'dismissed' && (
                            <span className="text-[11px] font-normal text-gray-400">· {t.match_method}</span>
                          )}
                          {/* An open row's best candidate score. "Open" alone
                              says nothing about whether this is a 30-second
                              confirm or a real question. */}
                          {/* THE PROPOSAL, ON THE ROW. One line: what the matcher
                              thinks this is, and a way in. Everything the two
                              comparison boxes said is still there — it just opens
                              when you ask for it, and only one at a time. */}
                          {t.disp === 'open' && (t.suggestions || []).length > 0 && (() => {
                            const live = t.suggestions.filter((x) => !x.rejected)
                            if (!live.length) return null
                            const best = live.reduce((a, b) => ((Number(b.score) || 0) > (Number(a.score) || 0) ? b : a))
                            const isOpen = openCand === t.id
                            return (
                              <button
                                onClick={(e) => { e.stopPropagation(); setOpenCand(isOpen ? null : t.id) }}
                                title={isOpen ? 'Hide the comparison' : 'Show the invoice this is proposed against'}
                                className={`ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold
                                  ${isOpen ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
                                           : 'text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-500/10'}`}>
                                <Zap size={11} />
                                {live.length > 1 ? `${live.length} candidates` : `inv ${best.invoice_number || cleanBankPayee(best.payee) || '—'}`}
                                <span className="tabular-nums text-gray-400">{Math.max(...live.map((x) => Number(x.score) || 0))}%</span>
                                <span className="text-gray-400">{isOpen ? '▴' : '▾'}</span>
                              </button>
                            )
                          })()}
                          {/* SEVERAL INVOICES, ONE PAYMENT — the offer.
                              Every tier of the matcher is 1:1 on an amount equal
                              to the cent, so a vendor paid for two invoices in
                              one transfer matched nothing and the row sat here
                              looking like a mystery. The server names the
                              invoices whose totals add up to this payment
                              exactly; accepting posts the same /attach a person
                              uses by hand.

                              Never auto-applied, so this is a button and not a
                              state. And when two different combinations hit the
                              same total it says so instead of picking — the same
                              "refuse to guess which one" rule the exact tier
                              applies. */}
                          {t.disp === 'open' && t.group_proposal && (() => {
                            const gp = t.group_proposal
                            const first = (gp.invoices || [])[0] || []
                            const label = first.map((x) => x.invoice_number ? `#${x.invoice_number}` : `entry ${x.id}`).join(' + ')
                            if (gp.ambiguous) {
                              return (
                                <span className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold text-gray-500"
                                  title={`${gp.combinations} different sets of invoices each total ${fmt(gp.total)} exactly, so which one this payment settled cannot be read off the amount. `
                                    + `Pick the right ones with Match.\nSearched the ${gp.considered} largest of ${gp.available} unsettled invoices.`}>
                                  <Layers size={11} />
                                  {gp.combinations} sets total this
                                </span>
                              )
                            }
                            return (
                              <button
                                onClick={(e) => { e.stopPropagation(); manualMatch(t.id, gp.expense_ids) }}
                                title={`${first.length} invoices for this vendor total ${fmt(gp.total)} exactly:\n`
                                  + first.map((x) => `• ${x.invoice_number ? `#${x.invoice_number}` : `entry ${x.id}`} — ${fmt(x.usd)}`).join('\n')
                                  + `\n\nSettles this line with all of them.`
                                  + (gp.capped ? `\n\nSearched the ${gp.considered} largest of ${gp.available} unsettled invoices for this vendor.` : '')}
                                className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold
                                  text-ink hover:bg-gray-100 dark:hover:bg-white/10">
                                <Layers size={11} />
                                {first.length} invoices = this payment
                                <span className="text-gray-400 font-normal">{label}</span>
                              </button>
                            )
                          })()}
                          {t.disp === 'dismissed' && t.dismissed_reason && (t.dismissed_reason.startsWith('rule:') || t.dismissed_reason.startsWith('internal') || t.dismissed_reason.startsWith('paypal')) && (
                            <span className="text-[11px] font-normal text-gray-400" title={t.dismissed_reason}>
                              · {t.dismissed_reason.startsWith('rule:') ? 'auto' : t.dismissed_reason.startsWith('paypal') ? 'funding leg' : 'internal'}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-2 py-2 align-top">
                        <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                          <button onClick={() => toggleFlagTx(t)}
                            title={t.flagged ? `Flagged${t.flagged_by ? ` by ${t.flagged_by}` : ''} — click to unflag` : 'Flag for review'}
                            className="p-0.5">
                            <Flag size={12} className={t.flagged ? 'text-amber-500 fill-amber-400' : 'text-gray-300 hover:text-amber-500'} />
                          </button>
                          {t.disp === 'open' && (
                            <>
                              <button onClick={() => { setMatchingTx(matchingTx === t.id ? null : t.id); setMatchQuery(''); setMatchResults([]) }}
                                className="inline-flex items-center gap-1 text-[11px] font-semibold text-gray-400 hover:text-ink hover:underline"><Link2 size={12} /> Match</button>
                              <button onClick={() => setRowMenu(rowMenu === t.id ? null : t.id)}
                                title="More actions for this line"
                                className={`w-6 h-6 rounded-lg text-[15px] leading-none shrink-0 ${
                                  rowMenu === t.id ? 'bg-gray-100 text-ink' : 'text-gray-400 hover:bg-gray-100 hover:text-ink'}`}>&#8943;</button>
                            </>
                          )}
                          {t.disp === 'confirm' && (
                            <>
                              <button onClick={() => confirmPaidIds([t.id])} disabled={confirming}
                                className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 hover:underline"><CheckCircle2 size={12} /> Mark Paid</button>
                              <a href={`/bk/ledger?focus=${t.matched_expense_id}`} className="text-[11px] text-gray-400 hover:text-ink hover:underline">ledger →</a>
                              <button onClick={() => unmatch(t.id)} title="Wrong match — detach" className="text-gray-300 hover:text-rose-600"><X size={13} /></button>
                            </>
                          )}
                          {t.disp === 'matched' && (
                            <>
                              <a href={`/bk/ledger?focus=${t.matched_expense_id}`} className="text-[11px] text-gray-400 hover:text-ink hover:underline">ledger →</a>
                              <button onClick={() => unmatch(t.id)} title="Detach from the ledger entry" className="text-gray-300 hover:text-rose-600"><X size={13} /></button>
                            </>
                          )}
                          {t.disp === 'booked' && (
                            <>
                              {/* Why this booked row isn't in the queue. Without
                                  it, a row that left the open list looks
                                  identical to one still waiting for a document,
                                  and the only difference — the answer someone
                                  gave — is invisible and unreachable. */}
                              {t.no_invoice_expected && (
                                <span title="Marked as needing no invoice — the spend still counts, the row just isn't asked about"
                                  className="text-[11px] text-gray-400">no invoice expected</span>
                              )}
                              <a href={`/bk/ledger?focus=${t.matched_expense_id}`} className="text-[11px] text-gray-400 hover:text-ink hover:underline">ledger →</a>
                              {t.no_invoice_expected ? (
                                <button onClick={() => undoNoInvoice(t)} disabled={noInvBusy === t.id}
                                  title="Put it back in the open queue — the ledger entry stays, only the marker clears"
                                  className="text-[11px] font-semibold text-gray-400 hover:text-ink disabled:opacity-50">Expect one</button>
                              ) : (
                                <button onClick={() => rowNoInvoice(t)} disabled={noInvBusy === t.id}
                                  title="No document is coming for this one — it leaves the queue and the spend stays counted"
                                  className="text-[11px] font-semibold text-gray-400 hover:text-ink disabled:opacity-50">No invoice</button>
                              )}
                              <button onClick={() => unbook(t)} title="Delete the created ledger entry and reopen this debit"
                                className="text-[11px] font-semibold text-gray-400 hover:text-rose-600">Unbook</button>
                            </>
                          )}
                          {t.disp === 'open-credit' && (
                            <button onClick={() => dismissTx(t.id)} className="text-[11px] font-semibold text-gray-400 hover:text-gray-600">Dismiss</button>
                          )}
                          {t.disp === 'booked-income' && (
                            <button onClick={() => unbookIncome(t)} title="Delete the income entry and reopen this credit"
                              className="text-[11px] font-semibold text-gray-400 hover:text-rose-600">Unbook</button>
                          )}
                          {t.disp === 'dismissed' && (
                            <button onClick={() => dismissTx(t.id, true)} className="text-[11px] font-semibold text-gray-400 hover:text-gray-600">Restore</button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {/* Overflow, GROUPED BY CONSEQUENCE rather than by what the
                        code happens to call these operations. Linking and
                        flagging are free — you can undo them and no report
                        changes. Booking and dismissing move a reported total,
                        because the P&L counts bank rows: a dismissal makes
                        money vanish from it and a booking gives money a
                        category it will be reported under. Same click cost,
                        very different blast radius, so they don't sit in one
                        undifferentiated list. */}
                    {rowMenu === t.id && (
                      <tr className="border-b border-divider">
                        <td></td>
                        <td colSpan={6} className="px-2 pb-2 pt-0">
                          <div className="flex justify-end">
                            <div className="min-w-[280px] rounded-lg border border-rule bg-card shadow-modal overflow-hidden">
                              <div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-gray-400">Free to undo</div>
                              <button onClick={() => { toggleFlagTx(t); setRowMenu(null) }}
                                className="block w-full text-left px-3 py-1.5 text-[13px] hover:bg-gray-50">
                                {t.flagged ? 'Remove flag' : 'Flag for review'}
                              </button>
                              <button onClick={() => { setMatchingTx(t.id); setMatchQuery(''); setMatchResults([]); setRowMenu(null) }}
                                className="block w-full text-left px-3 py-1.5 text-[13px] hover:bg-gray-50">
                                Search the ledger for a match
                              </button>
                              <div className="px-3 pt-2 pb-1 border-t border-divider text-[11px] font-semibold text-gray-400">
                                Moves a reported total
                              </div>
                              {/* The FORM, named as the form. It used to read
                                  "No invoice for that — book it", which is the
                                  decision the action row now makes in one click;
                                  here it is the long way round, for when the
                                  payee or category needs choosing. */}
                              <button onClick={() => { openEntryForm(t); setRowMenu(null) }}
                                title="Create a ledger entry from this line — custom payee / artist / always-rule"
                                className="flex items-center gap-2.5 w-full text-left px-3 py-1.5 text-[13px] hover:bg-gray-50">
                                <span className="w-1.5 h-1.5 border border-gray-500 rotate-45 shrink-0" />
                                Book it myself — choose payee and category
                              </button>
                              <button onClick={() => { dismissTx(t.id); setRowMenu(null) }}
                                className="flex items-center gap-2.5 w-full text-left px-3 py-1.5 text-[13px] hover:bg-gray-50">
                                <span className="w-1.5 h-1.5 border border-gray-500 rotate-45 shrink-0" />
                                Not really spending — set aside
                              </button>
                              <button onClick={() => { dismissAlways(t); setRowMenu(null) }}
                                title={`Always dismiss debits matching "${t.payee_guess || ''}"`}
                                className="flex items-center gap-2.5 w-full text-left px-3 py-1.5 text-[13px] text-gray-500 hover:bg-gray-50">
                                <span className="w-1.5 h-1.5 border border-gray-400 rotate-45 shrink-0" />
                                …and always, for this payee
                              </button>
                              {/* Deliberately NOT a dismissal. Dismissing drops
                                  the money out of the P&L — right for a
                                  transfer, wrong for a meal, which is a real
                                  cost that simply never comes with an invoice.
                                  This keeps the spend counted and stops the row
                                  being asked about. */}
                              <div className="px-3 pt-2 pb-1 border-t border-divider text-[11px] font-semibold text-gray-400">
                                Answers it, keeps the money
                              </div>
                              {/* Row scope and vendor scope are both useful and
                                  they are not the same claim: one Uber had no
                                  invoice; every Uber does. Row scope first
                                  because it's the narrower, safer answer. */}
                              {t.no_invoice_expected ? (
                                <button onClick={() => { undoNoInvoice(t); setRowMenu(null) }}
                                  title="Put this row back in the open queue. The ledger entry stays; only the marker clears."
                                  className="block w-full text-left px-3 py-1.5 text-[13px] hover:bg-gray-50">
                                  Actually, an invoice is coming
                                </button>
                              ) : (
                                <button onClick={() => { rowNoInvoice(t); setRowMenu(null) }}
                                  title="This one line never had an invoice. It books and leaves the queue; the spend stays in the P&L."
                                  className="block w-full text-left px-3 py-1.5 text-[13px] hover:bg-gray-50">
                                  This one had no invoice
                                </button>
                              )}
                              <button
                                onClick={() => { markNoInvoice('vendor', (t.matched?.payee || t.payee_guess || '').trim()); setRowMenu(null) }}
                                title="Meals, payroll, rent — real costs that never come with an invoice. The spend stays in the P&L and in Coverage; it just stops counting as unfinished."
                                className="block w-full text-left px-3 py-1.5 pb-2.5 text-[13px] hover:bg-gray-50">
                                This vendor never sends an invoice
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    {/* ONE open at a time, and only when asked.
                        This panel used to render for EVERY open row with a
                        candidate — two eight-field comparison boxes each, dozens
                        of them stacked, which is what made the page a mile long.
                        The proposal is now stated in one line on the row itself
                        and the comparison opens underneath it on demand, the way
                        a banking screen does it. Nothing is hidden that was not
                        already a click away; what changed is that the page no
                        longer opens every decision at once. */}
                    {t.disp === 'open' && (t.suggestions || []).length > 0 && openCand === t.id && matchingTx !== t.id && entryTx !== t.id && (
                      <tr className="border-b border-divider">
                        <td></td>
                        {/* THE PRIMARY ACTION — one card per candidate.
                            These were chips, then a flat aligned list, and both
                            had the same failure: near-identical candidates
                            rendered near-identically. An Egoflow row offers INV
                            052626-BR / 062526-BR / 072926-BR, all 85%, all
                            $7,750; a PayPal row offers three invoices matching
                            on payee, amount, score, status AND date. Picking
                            the wrong one marks the wrong invoice paid, and
                            nothing downstream ever contradicts it. 10 of the 12
                            open debits carry more than one candidate, so this
                            is the page's main interaction, not an edge case.

                            The cards suppress what the candidates SHARE (said
                            once, above) and highlight only what separates them.
                            Matching is now a deliberate second click on a named
                            button rather than a side effect of clicking a
                            candidate. */}
                        <td colSpan={6} className="px-2 pb-3 pt-0">
                          {(() => {
                            const cands = t.suggestions
                            const differing = candidateDiff(cands)
                            const flat = nearIdentical(cands)
                            const sel = Math.min(candSel[t.id] ?? 0, cands.length - 1)
                            const chosen = cands[sel]
                            // Nothing but the invoice number separates them.
                            // Rare now that the server sends artist/song, but
                            // it is the one state where the honest answer is
                            // "the ledger cannot tell these apart — go look at
                            // the document", not a wall of muted fields that
                            // implies it can.
                            const noSeparator = cands.length > 1 && differing.size === 0
                            return (
                              <div className="pl-1">
                                <div className="flex items-baseline flex-wrap gap-x-3 gap-y-1 mb-2">
                                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-gray-500">
                                    <Zap size={12} className="text-amber-500" /> {cands.length > 1 ? 'Which invoice' : 'Proposed match'}
                                  </span>
                                  <span className="text-[12px] text-gray-500 tabular-nums">{sharedLine(cands)}</span>
                                  {/* Highlighting is suppressed when nearly every field differs — the
                                      cards are plainly different invoices and lighting all eight rows
                                      said nothing. Saying so keeps the absence deliberate. */}
                                  {cands.length > 1 && differing.size === 0 && !noSeparator && (
                                    <span className="text-[11px] text-gray-400">these differ throughout — read them side by side</span>
                                  )}
                                </div>

                                {flat && cands.length > 1 && (
                                  <div className="flex items-start gap-2.5 px-3 py-2 mb-3 rounded-lg border border-alert-bd bg-alert-bg max-w-[880px]">
                                    <span className="w-4 h-4 mt-px shrink-0 rounded-full bg-alert text-card text-[11px] font-extrabold flex items-center justify-center">!</span>
                                    <span className="text-[12px] leading-relaxed text-ink">
                                      Same vendor, amount and confidence. Marking the wrong one paid is silent —
                                      nothing downstream will contradict it.
                                      {noSeparator
                                        ? ' The ledger holds nothing that separates these: open the invoice files before choosing.'
                                        : ' Only the highlighted fields tell them apart.'}
                                    </span>
                                  </div>
                                )}

                                <div className="flex flex-wrap gap-3">
                                  {cands.map((s, i) => {
                                    const score = Number(s.score) || 0
                                    const on = i === sel
                                    const partial = s.remaining != null
                                      && Number(s.remaining) < Number(s.family_total) - 0.009
                                    return (
                                      <button key={s.id} type="button"
                                        onClick={() => setCandSel((m) => ({ ...m, [t.id]: i }))}
                                        title={`${score}% match${(s.why || []).length ? ` — ${s.why.join(', ')}` : ''}${s.rejected ? ' — previously unmatched' : ''}`}
                                        className={`w-[344px] text-left rounded-xl border bg-card px-3 pt-3 pb-2.5 transition ${
                                          on ? 'border-ink ring-1 ring-ink' : 'border-rule hover:border-gray-300'
                                        } ${s.rejected ? 'opacity-70 hover:opacity-100' : ''}`}>
                                        <div className="flex items-center gap-2.5 mb-2">
                                          <span className={`w-3.5 h-3.5 rounded-full border-[1.5px] flex items-center justify-center shrink-0 ${on ? 'border-ink' : 'border-gray-300'}`}>
                                            <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-ink' : 'bg-transparent'}`} />
                                          </span>
                                          {/* The invoice number is ALWAYS the
                                              differentiator, so it always wears
                                              the diff highlight. */}
                                          {/* Amber ONLY while the diff language is in play. With field
                                              highlighting suppressed this pill was the last amber thing on
                                              the card, which made it read as decoration rather than signal.
                                              Emphasis without colour when there's nothing to compare. */}
                                          <span className={`text-[14px] font-bold tracking-tight tabular-nums px-1.5 -mx-0.5 rounded ${
                                            differing.size ? 'bg-diff-bg ring-1 ring-diff-bd' : 'text-ink'}`}>
                                            {s.invoice_number || 'no inv #'}
                                          </span>
                                          <DocButton row={s} quiet />
                                          <span className="ml-auto text-[11px] font-semibold text-gray-400 tabular-nums">{score}%</span>
                                        </div>
                                        <div className="flex flex-col gap-px">
                                          {CANDIDATE_FIELDS.map(([key, label, render]) => {
                                            const differs = differing.has(key)
                                            return (
                                              <div key={key}
                                                className={`grid grid-cols-[78px_1fr] gap-2.5 items-baseline px-1.5 -mx-1.5 py-0.5 rounded ${
                                                  differs ? 'bg-diff-bg ring-1 ring-diff-bd' : ''}`}>
                                                <span className="text-[11px] font-medium text-gray-400">{label}</span>
                                                <span className={`text-[12px] tabular-nums truncate ${
                                                  differs ? 'text-ink font-semibold' : 'text-gray-500'}`}
                                                  title={render(s)}>{render(s)}</span>
                                              </div>
                                            )
                                          })}
                                        </div>
                                        <div className="mt-2 pt-2 border-t border-divider flex items-center flex-wrap gap-1.5 text-[11px] text-gray-500">
                                          <span>{suggestionWhen(s)}</span>
                                          {partial && (
                                            <span className="text-[9px] font-bold uppercase tracking-wide text-amber-700 bg-amber-50 rounded px-1">
                                              {fmt(s.remaining)} left
                                            </span>
                                          )}
                                          {(s.why || []).slice(0, 2).map((w) => (
                                            <span key={w} className="text-[9px] font-bold uppercase tracking-wide text-gray-500 bg-gray-100 rounded px-1">{w}</span>
                                          ))}
                                          {s.rejected && <span className="text-[9px] font-bold uppercase tracking-wide text-rose-500">rejected before</span>}
                                        </div>
                                      </button>
                                    )
                                  })}
                                </div>

                                {/* Consequence is legible in the buttons: linking
                                    is reversible, the other two move a reported
                                    total. The diamond marks the difference. */}
                                <div className="flex items-center flex-wrap gap-2 mt-3 pt-3 border-t border-rule">
                                  <button onClick={() => manualMatch(t.id, chosen.id)}
                                    className="px-4 py-2 rounded-lg bg-ink text-card text-[13px] font-bold hover:opacity-85 transition">
                                    Match {chosen.invoice_number || cleanBankPayee(chosen.payee)}
                                  </button>
                                  {/* This used to call openEntryForm, which only
                                      unfolded a payee/category form — so a button
                                      that reads like a decision behaved like a
                                      detour and the row stayed in the queue
                                      either way. It now settles the row: books
                                      it, marks it as needing no document, done.
                                      The form is still reachable from the ⋯ menu
                                      for when the category needs choosing. */}
                                  <button onClick={() => rowNoInvoice(t)} disabled={noInvBusy === t.id}
                                    title="Meals, payroll, rent — a real cost with no document coming. It books and leaves the queue; the money still counts as spending."
                                    className="px-3.5 py-2 rounded-lg border border-rule bg-card text-[13px] font-semibold hover:border-gray-300 transition flex items-center gap-2 disabled:opacity-50">
                                    {noInvBusy === t.id
                                      ? <Loader size={12} className="animate-spin" />
                                      : <span className="w-1.5 h-1.5 border border-gray-500 rotate-45 shrink-0" />}
                                    No invoice for that
                                  </button>
                                  <button onClick={() => dismissTx(t.id)}
                                    className="px-3.5 py-2 rounded-lg border border-rule bg-card text-[13px] font-semibold hover:border-gray-300 transition flex items-center gap-2">
                                    <span className="w-1.5 h-1.5 border border-gray-500 rotate-45 shrink-0" />
                                    Not really spending
                                  </button>
                                  <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                                    <span className="w-1.5 h-1.5 border border-current rotate-45 shrink-0" />
                                    moves a reported total
                                  </span>
                                  <button onClick={() => { setMatchingTx(t.id); setMatchQuery(''); setMatchResults([]) }}
                                    className="ml-auto text-[12px] font-bold text-gray-500 hover:text-ink px-2 py-1.5">
                                    None of these — search the ledger
                                  </button>
                                </div>
                              </div>
                            )
                          })()}
                        </td>
                      </tr>
                    )}
                    {matchingTx === t.id && (
                      <tr className="border-b border-divider bg-gray-50/60">
                        <td></td>
                        <td colSpan={6} className="px-2 py-2">
                          <input autoFocus value={matchQuery} onChange={(e) => onMatchQuery(e.target.value)}
                            placeholder="Search the ledger by payee, artist, invoice #…"
                            className="w-full border border-rule rounded-lg px-3 py-2 text-[13px] bg-card text-ink outline-none" />
                          {matchResults.map((e) => (
                            <div key={e.id} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-gray-100 rounded">
                              <button onClick={() => manualMatch(t.id, e.id)}
                                className="flex-1 min-w-0 text-left flex items-center gap-2">
                                <span className="font-semibold text-ink">{e.payee}</span>
                                <span className="text-gray-400">{e.invoice_number || ''}</span>
{/* THE WHOLE INVOICE, not the parent's share. A split
                                    invoice keeps its own part in `amount` and the
                                    rest on children, so #570 read $500.00 against
                                    a document for $2,005.00 — and a $2,005 payment
                                    looked like it matched nothing. The matcher
                                    always scored the family total; this list was
                                    the thing disagreeing with it. */}
                                <span className="ml-auto font-bold">
                                  {fmt(e.family_total ?? e.amount)}
                                  {e.split_count > 0 && (
                                    <span className="ml-1 font-normal text-[11px] text-gray-400"
                                      title={`Split into ${e.split_count + 1} parts — ${fmt(e.amount)} on the invoice row and the rest on its parts. A payment settles the whole ${fmt(e.family_total)}.`}>
                                      · {e.split_count + 1} parts
                                    </span>
                                  )}
                                </span>
                                <span className={`text-[11px] font-bold ${e.payment_status === 'Paid' ? 'text-emerald-600' : 'text-amber-600'}`}>{e.payment_status || 'Unpaid'}</span>
                              </button>
                              <DocButton row={e} />
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                    {entryTx === t.id && (
                      <tr className="border-b border-divider bg-emerald-50/40">
                        <td></td>
                        <td colSpan={6} className="px-2 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <input value={entryForm.payee} onChange={(e) => setEntryForm((f) => ({ ...f, payee: e.target.value }))}
                              placeholder="Payee" className="flex-1 min-w-[160px] border border-rule rounded-lg px-3 py-2 text-[13px] bg-card text-ink outline-none" />
                            <select value={entryForm.category} onChange={(e) => setEntryForm((f) => ({ ...f, category: e.target.value }))}
                              className="border border-rule rounded-lg px-2 py-2 text-[13px] bg-card text-ink">
                              {catExpense.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                            <input value={entryForm.artist} onChange={(e) => setEntryForm((f) => ({ ...f, artist: e.target.value }))}
                              placeholder="Artist (optional)" className="w-36 border border-rule rounded-lg px-3 py-2 text-[13px] bg-card text-ink outline-none" />
                            <RecoupAnswer
                              value={entryForm.recoupable}
                              disabled={creatingEntry}
                              onChange={(v) => setEntryForm((f) => ({ ...f, recoupable: v }))}
                            />
                            {/* The button says which of the two answers this
                                submit gives. Same fields, different consequence:
                                one books the row, the other books it AND settles
                                it, and a button labelled the same either way is
                                how "No invoice for that" came to feel inert. */}
                            <button onClick={() => createEntry(t)} disabled={creatingEntry || !entryForm.payee.trim()}
                              title={entryNoInvoice
                                ? 'Books it and marks it as needing no invoice — it leaves the open queue and the spend stays counted'
                                : 'Creates a Paid ledger entry from this bank line'}
                              className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg px-3 py-2 text-[12px] font-bold disabled:opacity-40">
                              {creatingEntry ? <Loader size={12} className="animate-spin" /> : <Plus size={13} />}
                              {entryNoInvoice ? `Book ${fmt(t.amount)} — no invoice expected` : `Book ${fmt(t.amount)} as Paid`}
                            </button>
                          </div>
                          {/* Hidden in no-invoice mode: that submit doesn't write
                              a category rule, so offering the checkbox there is a
                              control that silently does nothing. Vendor scope
                              lives in the ⋯ menu, where it does work. */}
                          {!entryNoInvoice && (
                            <label className="flex items-center gap-1.5 mt-2 text-[12px] text-gray-600 cursor-pointer w-fit">
                              <input type="checkbox" checked={entryAlways} onChange={(e) => setEntryAlways(e.target.checked)} />
                              Always book "{(t.payee_guess || '').trim() || 'this payee'}" debits as {entryForm.category} — on this and every future statement
                            </label>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
                // Collapse runs of identical HANDLED rows — seven $1.00
                // "External transfer fee · Booked" rows become one ×7 row.
                // Open rows always render individually (they need actions).
                const gkey = (t) => ['booked', 'matched', 'dismissed', 'booked-income'].includes(t.disp)
                  ? [t.disp, Number(t.amount).toFixed(2), normTxt(t.matched?.payee || t.payee_guess || t.description),
                     t.matched?.category || t.income?.income_type || '', t.match_method || ''].join('|')
                  : null
                const display = []
                const gmap = new Map()
                for (const t of rows) {
                  const k = gkey(t)
                  if (!k) { display.push({ members: [t] }); continue }
                  if (gmap.has(k)) { gmap.get(k).members.push(t); continue }
                  const g = { gk: k, members: [t] }
                  gmap.set(k, g)
                  display.push(g)
                }
                // A BOTTOM TO THE PAGE. Every row rendered at once is what made
                // this scroll for screens — a statement is 300-500 lines and all
                // of them were painted whether or not anybody was going to read
                // that far.
                //
                // The cap is only safe because of what it SAYS. A queue that
                // shows 120 of 512 and stops silently reads as "all done", which
                // is the failure that hid FACEBOOK's 118 unanswered lines. The
                // footer names the remainder AND how many of the hidden rows
                // still need an answer, so the number that matters is never
                // behind the fold.
                const capped = display.slice(0, txCap)
                const hidden = display.slice(txCap)
                const hiddenRows = hidden.reduce((n, g) => n + g.members.length, 0)
                const hiddenOpen = hidden.reduce((n, g) => n + g.members.filter((t) => t.disp === 'open' || t.disp === 'confirm').length, 0)
                const painted = capped.map((g) => {
                  if (!g.gk || g.members.length < 3 || rowGroupsOpen.has(g.gk)) {
                    return (
                      <Fragment key={g.gk || g.members[0].id}>
                        {g.gk && g.members.length >= 3 && (
                          <tr className="border-b border-divider bg-gray-50/40">
                            <td></td>
                            <td colSpan={6} className="px-2 py-1">
                              <button onClick={() => setRowGroupsOpen((prev) => { const n = new Set(prev); n.delete(g.gk); return n })}
                                className="inline-flex items-center gap-1 text-[11px] font-semibold text-gray-400 hover:text-ink">
                                <ChevronDown size={11} /> collapse {g.members.length} identical
                              </button>
                            </td>
                          </tr>
                        )}
                        {g.members.map(renderTxRow)}
                      </Fragment>
                    )
                  }
                  const first = g.members[0]
                  const dates = g.members.map((t) => String(t.txn_date).slice(0, 10)).sort()
                  const total = g.members.reduce((s, t) => s + Number(t.usd ?? t.amount ?? 0), 0)
                  const allSel = g.members.every((t) => unmatchedSel.has(t.id))
                  const title = first.matched?.payee || (first.payee_guess || '').trim() || first.description || '—'
                  return (
                    <tr key={'g' + g.gk} className={`border-b border-divider hover:bg-gray-50/60 ${first.disp === 'dismissed' ? 'opacity-50' : ''}`}>
                      <td className="pl-3 py-2 align-top">
                        <input type="checkbox" checked={allSel}
                          onChange={() => setUnmatchedSel((prev) => { const n = new Set(prev); g.members.forEach((t) => { allSel ? n.delete(t.id) : n.add(t.id) }); return n })} />
                      </td>
                      <td className="px-2 py-2 align-top text-[12px] text-gray-400 tabular-nums whitespace-nowrap">
                        {fmtDate(dates[0])}{dates[dates.length - 1] !== dates[0] ? ` – ${fmtDate(dates[dates.length - 1])}` : ''}
                      </td>
                      <td className="px-2 py-2 align-top min-w-0">
                        <button onClick={() => setRowGroupsOpen((prev) => { const n = new Set(prev); n.add(g.gk); return n })}
                          className="group/exp text-left" title={`${g.members.length} identical transactions — click to expand`}>
                          <span className="text-[13px] font-semibold text-ink truncate max-w-[260px] inline-block align-bottom">{displayCaseTitle(title)}</span>
                          <span className="ml-1.5 text-[11px] font-bold text-gray-500 bg-gray-100 rounded px-1.5 py-0.5 group-hover/exp:bg-gray-200">×{g.members.length}</span>
                        </button>
                      </td>
                      <td className="px-2 py-2 align-top">
                        <span className="text-[12px] text-gray-600">{first.matched?.category || first.income?.income_type || '—'}</span>
                      </td>
                      <td className="px-2 py-2 align-top text-right font-semibold text-[13px] text-ink whitespace-nowrap tabular-nums">
                        {fmt(total)}
                        <div className="text-[11px] font-normal text-gray-400 tabular-nums">{g.members.length} × {fmt(first.amount)}</div>
                      </td>
                      <td className="px-2 py-2 align-top whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-gray-600">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DISP_DOT[first.disp]}`} />
                          {DISP_LABEL[first.disp]}
                          {first.match_method && first.disp !== 'dismissed' && (
                            <span className="text-[11px] font-normal text-gray-400">· {first.match_method}</span>
                          )}
                        </span>
                      </td>
                      <td className="px-2 py-2 align-top">
                        <div className="flex items-center justify-end">
                          <button onClick={() => setRowGroupsOpen((prev) => { const n = new Set(prev); n.add(g.gk); return n })}
                            className="text-[11px] font-semibold text-gray-400 hover:text-ink">expand</button>
                        </div>
                      </td>
                    </tr>
                  )
                })
                if (!hidden.length) return painted
                return [...painted, (
                  <tr key="__more" className="border-b border-divider bg-gray-50/60 dark:bg-white/5">
                    <td></td>
                    <td colSpan={6} className="px-2 py-2.5">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                        <button onClick={() => setTxCap((n) => n + 200)}
                          className="font-bold text-boom-600 hover:underline">
                          Show 200 more
                        </button>
                        <span className="text-gray-500">
                          {hiddenRows} more row{hiddenRows === 1 ? '' : 's'} not shown
                        </span>
                        {/* The only number that must never be hidden by a cap. */}
                        {hiddenOpen > 0 && (
                          <span className="font-semibold text-amber-700 dark:text-amber-400">
                            {hiddenOpen} of them still need an answer
                          </span>
                        )}
                        <button onClick={() => setTxCap(display.reduce((n, g) => n + 1, 0) + 1000)}
                          className="ml-auto text-gray-400 hover:text-ink font-semibold">
                          show all
                        </button>
                      </div>
                    </td>
                  </tr>
                )]
                })()}
              </tbody>
            </table>
            {/* What you are looking at and what you could be doing instead.
                Says how much of the whole is on screen, so a narrow filter
                never reads as "this is everything". */}
            <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 border-t border-rule">
              <span className="text-[12px] text-gray-400 tabular-nums">
                {rows.length} of {debits.length} line{debits.length === 1 ? '' : 's'} &middot; {dispFilter}
                {catFilter ? ` · ${catFilter}` : ''}
              </span>
              <span className="text-[12px] text-gray-500">
                {unmatchedSel.size > 0
                  ? `${unmatchedSel.size} selected — answer them together`
                  : 'Select several lines to answer them together'}
              </span>
            </div>
          </div>

          {/* Paid on ledger, absent from bank — ledger-side check. One quiet
              header line with a count; rows only when expanded. */}
          {paidNoMatch.length > 0 && (
            <div id="paid-no-match" className="bg-card border border-rule rounded-xl overflow-hidden">
              <button onClick={() => setPnmOpen(!pnmOpen)} className="w-full flex items-center gap-2 px-4 py-2 text-left">
                {pnmOpen ? <ChevronDown size={14} className="text-gray-400 shrink-0" /> : <ChevronRight size={14} className="text-gray-400 shrink-0" />}
                <span className="text-[13px] font-bold text-gray-500">No bank evidence</span>
                <span className="text-[11px] font-extrabold px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 tabular-nums">{paidNoMatch.length}</span>
                <span className="text-[12px] text-gray-400">marked Paid on the ledger in this period, but no matching debit here</span>
              </button>
              {pnmOpen && paidNoMatch.map((f) => (
                <div key={f.id} className="px-3 py-2 border-t border-divider text-[13px]">
                  <div className="flex items-center gap-3">
                    <span className="text-gray-400 w-20 shrink-0 text-[12px] tabular-nums">{fmtDate(f.payment_date)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-ink truncate">{f.payee}</div>
                      <div className="text-[11px] text-gray-400">{f.payment_method || 'no method'}{f.invoice_number ? ` · inv ${f.invoice_number}` : ''}</div>
                    </div>
                    <span className="font-semibold text-ink whitespace-nowrap tabular-nums">{fmt(f.family_total)}</span>
                    <a href={`/bk/ledger?focus=${f.id}`} className="text-[11px] text-gray-400 hover:text-ink hover:underline whitespace-nowrap">ledger →</a>
                  </div>
                  {(f.bank_candidates || []).length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 mt-1.5 pl-[92px]">
                      <span className="text-[11px] font-extrabold uppercase tracking-wider text-gray-400">Found in bank:</span>
                      {f.bank_candidates.map((c) => (
                        <button key={c.id} onClick={() => manualMatch(c.id, f.id)}
                          title="Match this ledger entry to the bank debit"
                          className="inline-flex items-center gap-1.5 text-[11px] font-semibold border border-emerald-300 text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded-lg px-2 py-1">
                          <Link2 size={11} />
                          {fmtDate(c.txn_date)} · {fmt(c.amount)}{c.payee_guess ? ` · ${c.payee_guess.slice(0, 22)}` : ''} · {c.score}%
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

        </div>
        )
      })())}

      {/* ── Swipe review deck ── */}
      {deck && (() => {
        const item = deck.items[deck.index]
        const done = !item
        const primary = item ? deckPrimary(item) : null
        const opts = item?.direction === 'credit' ? catIncome : (deck.cats || catExpense)
        const accepting = deckDx > 60
        const skipping = deckDx < -60
        const doc = previewOn ? deckDocFor(item, primary) : null
        return (
          <ReviewDeck
            index={deck.index}
            total={deck.items.length}
            onClose={closeDeck}
            label={
              <button onClick={togglePreview}
                title={previewOn ? 'Hide the document panel (P)' : 'Show the document beside each card (P)'}
                className="inline-flex items-center gap-1.5 text-white/60 hover:text-white font-semibold">
                <FileText size={12} /> {previewOn ? 'Preview on' : 'Preview off'}
              </button>
            }
            aside={doc ? (
              <InlineFilePreview url={doc.url} filename={doc.filename} label={doc.label} meta={doc.meta}
                emptyText="Nothing is attached to this entry — so there is no document backing this match." />
            ) : previewOn ? (
              <InlineFilePreview url={null} label="No invoice on this card"
                emptyText="This card is a booking or a credit, not an invoice match — there is no document to show yet." />
            ) : null}
            closeLabel="Done — close"
            closeOnBackdrop
            done={done}
            doneTitle="Statement reviewed"
            doneSummary={
              `${deck.stats.booked} booked · ${deck.stats.income} income · ${deck.stats.matched} matched · ${deck.stats.dismissed} dismissed`
              + (deck.stats.noInvoice > 0 ? ` · ${deck.stats.noInvoice} need no invoice` : '')
              + (deck.stats.flagged > 0 ? ` · ${deck.stats.flagged} flagged for review` : '')
              + (deck.stats.skipped > 0 ? ` · ${deck.stats.skipped} skipped (still open)` : '')
            }
            doneActionLabel="Back to the statement"
            hint="swipe or use keys · → accept · ← skip · F flag · ⌫ back/undo · D dismiss · N no invoice · R recoupable yes/no · 1-9 pick category · P preview · Esc close"
          >
            {() => (
                  <div
                    className="bg-card rounded-2xl shadow-2xl p-6 select-none touch-none cursor-grab active:cursor-grabbing"
                    style={{
                      transform: `translateX(${deckDx}px) rotate(${deckDx / 24}deg)`,
                      transition: deckDrag.current ? 'none' : 'transform 0.18s ease',
                      borderTop: accepting ? '3px solid #059669' : skipping ? '3px solid #9ca3af' : '3px solid transparent',
                    }}
                    onPointerDown={(e) => {
                      // Buttons and the category select live inside the card —
                      // capturing their pointerdown swallows the click. Only
                      // start a drag from the card body itself.
                      if (e.target.closest('button, select, option, a')) return
                      deckDrag.current = e.clientX
                      e.currentTarget.setPointerCapture(e.pointerId)
                    }}
                    onPointerMove={(e) => { if (deckDrag.current !== null) setDeckDx(e.clientX - deckDrag.current) }}
                    onPointerUp={() => {
                      const dx = deckDx
                      deckDrag.current = null
                      if (dx > 120) deckAccept()
                      else if (dx < -120) deckSkip()
                      else setDeckDx(0)
                    }}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <span className="flex items-center gap-1.5">
                        <span className={`text-[11px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded ${item.direction === 'credit' ? 'bg-sky-50 text-sky-700' : 'bg-rose-50 text-rose-700'}`}>
                          {item.direction === 'credit' ? 'Money in' : 'Money out'}
                        </span>
                        {item.flagged && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-50 text-amber-700">
                            <Flag size={9} /> flagged
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-[12px] text-gray-400">{fmtDate(item.txn_date)}</span>
                    </div>
                    <div className={`text-3xl font-black ${item.direction === 'credit' ? 'text-sky-700' : 'text-ink'}`}>
                      {item.currency !== 'USD'
                        ? <>{Number(item.amount).toLocaleString()} {item.currency} <span className="text-base font-bold text-gray-400">≈{fmt(item.usd ?? item.amount)}</span></>
                        : fmt(item.amount)}
                    </div>
                    {/* Old parses hardcoded USD — let the reviewer correct the
                        currency against the statement file, right here. */}
                    {!item.matched_expense_id && !item.matched_income_id ? (
                      <div className="mb-2">
                        <select value={item.currency || 'USD'} onChange={(e) => deckSetCurrency(item, e.target.value)} disabled={deckBusy}
                          title="Statement shows a different currency? Correct it here — the amount stays as the face value; totals and matching use the real currency."
                          className="text-[11px] font-semibold text-gray-400 bg-card border border-transparent hover:border-rule rounded px-1 py-0.5 cursor-pointer outline-none">
                          {['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'MXN', 'BRL', 'SEK', 'NOK', 'DKK', 'NZD', 'HKD', 'SGD', 'CNY', 'PLN', 'CZK', 'HUF', 'ILS', 'THB', 'PHP', 'TWD'].map((c) => (
                            <option key={c} value={c}>{c === (item.currency || 'USD') ? `${c} — change if wrong` : c}</option>
                          ))}
                        </select>
                      </div>
                    ) : <div className="mb-2" />}
                    <div className="text-[15px] font-bold text-ink">{(item.payee_guess || '').trim() || item.description || '—'}</div>
                    {item.payee_email && <div className="text-[12px] text-gray-400 font-mono">{item.payee_email}</div>}
                    {item.description && item.description !== (item.payee_guess || '').trim() && !/^general payment/i.test(item.description) && (
                      <div className="text-[12px] text-gray-400 mt-0.5">{item.description}</div>
                    )}

                    {(item.reversed_by || item.reversal_of) && (
                      <button onClick={() => deckDismissPair(item)} disabled={deckBusy}
                        className="w-full mt-4 flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-left hover:bg-amber-100 disabled:opacity-50">
                        <AlertTriangle size={15} className="text-amber-600 shrink-0" />
                        <span className="min-w-0">
                          <span className="block text-[12px] font-bold text-amber-800">
                            {item.reversed_by
                              ? `This payment came back on ${fmtDate(item.reversed_by.txn_date)} — reversed or refunded`
                              : `This is the reversal/refund of a ${fmtDate(item.reversal_of.txn_date)} payment`}
                          </span>
                          <span className="block text-[11px] text-amber-700">Tap to dismiss both sides — money that came back is neither expense nor income.</span>
                        </span>
                      </button>
                    )}
                    {/* Descriptor says reversal/refund but no twin was found —
                        the original payment may predate the statements on file.
                        Worth saying, so it isn't silently treated as revenue. */}
                    {!item.reversed_by && !item.reversal_of && item.looks_like_reversal && !item.matched_income_id && !item.matched_expense_id && (
                      <div className="w-full mt-4 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
                        <AlertTriangle size={15} className="text-amber-600 shrink-0" />
                        <span className="min-w-0">
                          <span className="block text-[12px] font-bold text-amber-800">Looks like a reversal or refund</span>
                          <span className="block text-[11px] text-amber-700">No original payment found in the uploaded statements, so there’s nothing to pair it against.</span>
                        </span>
                      </div>
                    )}

                    <div className="mt-4 rounded-xl border border-rule bg-gray-50/60 p-3">
                      {deckSplit ? (() => {
                        const sum = deckSplit.reduce((s, p) => s + (Number(p.amount) || 0), 0)
                        const remaining = Number(item.amount) - sum
                        return (
                          <>
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-[11px] font-extrabold uppercase tracking-wider text-emerald-600">
                                Swipe right to book split
                                {wasBookedByUs(item) ? ' — replaces the single entry we invented' : ''}
                              </span>
                              <button onClick={() => setDeckSplit(null)} className="text-[11px] text-gray-400 hover:text-gray-600">cancel</button>
                            </div>
                            {deckSplit.map((p, i) => (
                              <div key={i} className="flex items-center gap-1.5 mb-1.5">
                                <input type="number" step="0.01" min="0" value={p.amount}
                                  onChange={(e) => setDeckSplit(deckSplit.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))}
                                  className="w-24 border border-rule rounded-lg px-2 py-1.5 text-[13px] font-mono bg-card text-ink" />
                                <select value={p.category}
                                  onChange={(e) => setDeckSplit(deckSplit.map((x, j) => j === i ? { ...x, category: e.target.value } : x))}
                                  className="flex-1 border border-rule rounded-lg px-2 py-1.5 text-[13px] bg-card text-ink">
                                  {(deck.cats || catExpense).map((c) => <option key={c} value={c}>{c}</option>)}
                                </select>
                                {/* WHO it was for. Splitting a payment is usually
                                    about two artists, not two categories, so a
                                    split that only carried categories answered
                                    the wrong half of the question. */}
                                <ArtistSelect
                                  value={p.artist || ''}
                                  options={roster}
                                  placeholder="Artist…"
                                  onChange={(v) => setDeckSplit(deckSplit.map((x, j) => j === i ? { ...x, artist: v } : x))}
                                  className="w-32 border border-rule rounded-lg px-2 py-1.5 text-[13px] bg-card text-ink outline-none"
                                />
                                {deckSplit.length > 2 && (
                                  <button onClick={() => setDeckSplit(deckSplit.filter((_, j) => j !== i))}
                                    className="text-gray-300 hover:text-rose-600 p-1"><X size={13} /></button>
                                )}
                              </div>
                            ))}
                            <div className="flex items-center justify-between">
                              {deckSplit.length < 6 ? (
                                <button onClick={() => setDeckSplit([...deckSplit, { amount: Math.max(0, remaining).toFixed(2), category: 'Other', artist: '' }])}
                                  className="text-[11px] font-bold text-gray-400 hover:text-ink hover:underline">+ add part</button>
                              ) : <span />}
                              <span className={`text-[11px] font-bold font-mono ${Math.abs(remaining) < 0.01 ? 'text-emerald-600' : 'text-rose-600'}`}>
                                {Math.abs(remaining) < 0.01 ? 'balanced ✓' : `${remaining > 0 ? 'remaining' : 'over by'} ${fmt(Math.abs(remaining))}`}
                              </span>
                            </div>
                          </>
                        )
                      })() : primary.type === 'rematch' ? (
                        <>
                          <div className="text-[11px] font-extrabold uppercase tracking-wider text-emerald-600 mb-1">
                            Swipe right to use this invoice
                          </div>
                          {/* The invoice's own amount belongs on this line. The
                              card shows the BANK amount at the top, and "does
                              this invoice settle this line" is largely an amount
                              question — leaving it to a click made the reviewer
                              take the pairing on trust. A total that doesn't
                              equal the debit is said so explicitly: a $650 line
                              against a $1,200 invoice is a part payment, not a
                              settled one, and that is a different decision. */}
                          <div className="flex items-center gap-2 text-[13px] font-bold text-ink">
                            <span className="min-w-0 truncate">
                              {primary.target.invoice_number ? `inv ${primary.target.invoice_number}` : `entry #${primary.target.expense_id}`}
                              <span className="font-normal text-gray-400"> · {primary.target.invoice_payee}</span>
                            </span>
                            <DocButton row={{ ...primary.target, id: primary.target.expense_id }} />
                            <span className="ml-auto tabular-nums shrink-0">
                              {(primary.target.currency || 'USD') !== 'USD'
                                ? `${Number(primary.target.family_total).toLocaleString()} ${primary.target.currency}`
                                : fmt(primary.target.family_total)}
                            </span>
                          </div>
                          {(primary.target.currency || 'USD') === 'USD'
                            && Math.abs(Number(primary.target.family_total) - Number(item.usd ?? item.amount)) >= 0.01 && (
                            <div className="text-[11px] font-semibold text-amber-600 mt-0.5">
                              Invoice is {fmt(Math.abs(Number(primary.target.family_total) - Number(item.usd ?? item.amount)))}{' '}
                              {Number(primary.target.family_total) > Number(item.usd ?? item.amount) ? 'more' : 'less'} than this bank line
                            </div>
                          )}
                          {/* Two currencies: SHOW the arithmetic. A card pairing
                              "EUR 1,000" with "$1,183.60" is asking to be taken
                              on faith otherwise — and the whole point of this
                              deck is that a person can check it. */}
                          {primary.target.fx && (
                            <div className="text-[11px] font-semibold text-sky-700 bg-sky-50 border border-sky-200 rounded px-1.5 py-1 mt-1">
                              {Number(primary.target.fx.invoice_amount).toLocaleString()} {primary.target.fx.invoice_currency}
                              {' ≈ '}{fmt(primary.target.fx.invoice_usd)} against {fmt(primary.target.fx.txn_usd)} on the statement
                              {primary.target.fx.diff_pct != null && (
                                <span className="font-bold">
                                  {' — '}{primary.target.fx.diff_pct > 0 ? '+' : ''}{primary.target.fx.diff_pct}%
                                </span>
                              )}
                              <div className="font-normal text-sky-800/80 mt-0.5">
                                The rate moves between invoicing and payment, so these agree within the 5% window rather than to the cent.
                              </div>
                            </div>
                          )}
                          <div className="text-[12px] text-gray-500 mt-0.5">
                            {fmtDate(primary.target.invoice_date)} · {primary.target.payment_status || 'Unpaid'}
                            {primary.target.invoice_artist ? ` · ${primary.target.invoice_artist}` : ''}
                            {' · '}{primary.target.same_day ? 'same day as the debit' : `${primary.target.gap_days} days apart`}
                          </div>
                          <p className="text-[12px] text-gray-500 mt-2">
                            This row was booked as <strong className="font-semibold text-ink">{primary.target.booked_category || '—'}</strong> with
                            an entry we invented. Accepting deletes that and links the real invoice instead.
                          </p>
                        </>
                      ) : primary.type === 'choose' ? (
                        <>
                          {/* Nothing armed. Candidates exist but none is strong,
                              and a page for matching should ask which one rather
                              than quietly propose a booking past them. */}
                          <div className="text-[11px] font-extrabold uppercase tracking-wider text-gray-500 mb-1">
                            Which invoice is this?
                          </div>
                          {/* The shared picker, so this page and the vendor page
                              cannot drift on what "attach" means. Ticking several
                              is the point: one transfer often settles two
                              invoices, and the matcher can never propose that —
                              it needs ONE invoice equal to the payment to the
                              cent, which is why these cards exist at all. */}
                          <InvoiceAttachPicker
                            candidates={primary.options.slice(0, 6)}
                            lineUsd={Number(item.usd ?? item.amount) || 0}
                            lineDate={item.txn_date}
                            busy={deckBusy}
                            onPreview={setPreviewFile}
                            onAttach={(ids) => deckAttach(item, ids)}
                          />
                          <p className="text-[11px] text-gray-400 mt-2">
                            None of these scores high enough to accept on a swipe — pick one, tick several if the
                            payment covered more than one, or book it below if no invoice covers it.
                          </p>
                        </>
                      ) : primary.type === 'reversal' ? (
                        <>
                          <div className="text-[11px] font-extrabold uppercase tracking-wider text-amber-600 mb-1">
                            Swipe right to net this off — not income
                          </div>
                          <p className="text-[12px] text-gray-600">
                            {item.reversal_of
                              ? <>Money back on the {fmtDate(item.reversal_of.txn_date)} payment. Accepting dismisses both sides so they cancel — the expense stops counting and no revenue is invented.</>
                              : <>This looks like a reversal or refund, but the original payment isn’t in any uploaded statement, so there’s nothing to pair it with. Dismiss it, or book it deliberately below.</>}
                          </p>
                          <button onClick={() => { setDeckForceBook(true); setDeckSel('') }}
                            className="mt-2 text-[11px] font-bold text-gray-400 hover:text-ink">
                            It really is income — let me pick a type…
                          </button>
                        </>
                      ) : primary.type === 'keep' ? (
                        <>
                          <div className="text-[11px] font-extrabold uppercase tracking-wider text-gray-500 mb-1">Swipe right to keep as-is</div>
                          <div className="text-[13px] font-bold text-ink">
                            {item.dismissed
                              ? `Dismissed${item.dismissed_reason ? ` — ${item.dismissed_reason}` : ''}`
                              : item.matched_income_id
                                ? `Booked income${item.income?.income_type ? ` — ${item.income.income_type}` : ''}${item.income?.artist_name ? ` · ${item.income.artist_name}` : ''}`
                                : `Matched to ${item.matched?.payee || `entry #${item.matched_expense_id}`}${item.matched ? ` · ${fmt(item.matched.family_total)}` : ''}${item.match_method ? ` · ${item.match_method}` : ''}`}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {item.dismissed && (
                              <button onClick={() => deckReopen(item, 'restore')} disabled={deckBusy}
                                className="text-[11px] font-bold text-gray-500 hover:text-ink border border-rule rounded px-2 py-1">
                                Restore to open
                              </button>
                            )}
                            {item.matched_expense_id && (
                              <button onClick={() => deckReopen(item, 'unmatch')} disabled={deckBusy}
                                className="text-[11px] font-bold text-gray-500 hover:text-rose-600 border border-rule rounded px-2 py-1"
                                title="Wrong pairing — unlink it and remember the no">
                                Unmatch
                              </button>
                            )}
                            {item.matched_income_id && (
                              <button onClick={() => deckReopen(item, 'unbook-income')} disabled={deckBusy}
                                className="text-[11px] font-bold text-gray-500 hover:text-rose-600 border border-rule rounded px-2 py-1">
                                Unbook income
                              </button>
                            )}
                          </div>
                        </>
                      ) : primary.type === 'rebook' ? (
                        <>
                          {/* The invoices this booked row could actually be.
                              A booked row is an entry the app invented; if the
                              ledger holds a real invoice for it, matching is
                              the answer and recategorising is not. These were
                              scored by the matcher and never shown — the card
                              offered only "keep or recategorise" on a page that
                              exists to match. Accepting goes through /rematch
                              because /match refuses a booked row outright. */}
                          {primary.options?.length > 0 && (
                            <div className="mb-3">
                              <div className="text-[11px] font-semibold text-gray-500 mb-1">
                                Is this one of these invoices?
                              </div>
                              {/* Booked rows are where consolidated payments
                                  actually live — the app invented ONE entry for a
                                  transfer that settled two invoices, so ticking
                                  both is the only way to record the truth.
                                  /attach displaces the invented entry and links
                                  every ticked invoice in one transaction, which
                                  is what the old per-row confirm could not do. */}
                              <InvoiceAttachPicker
                                candidates={primary.options.slice(0, 6)}
                                lineUsd={Number(item.usd ?? item.amount) || 0}
                                lineDate={item.txn_date}
                                busy={deckBusy}
                                onPreview={setPreviewFile}
                                onAttach={(idsPicked) => {
                                  if (!window.confirm(
                                    `Attach ${idsPicked.length === 1 ? 'this invoice' : `these ${idsPicked.length} invoices`} to the `
                                    + `${fmt(item.amount)} payment?\n\n`
                                    + `The ${item.matched?.category || 'booked'} entry we invented for this line is deleted `
                                    + 'and the real invoice takes its place.')) return
                                  deckAttach(item, idsPicked)
                                }}
                              />
                            </div>
                          )}
                          <div className="text-[11px] font-semibold text-emerald-600 mb-1">
                            {primary.options?.length
                              ? `Or keep it booked as ${item.matched?.category || '?'} — swipe right, or pick a better category`
                              : `Booked as ${item.matched?.category || '?'} — swipe right to keep, or pick a better category`}
                          </div>
                          <CategorySelect
                            value={deckSel}
                            kind="expense"
                            numbered
                            options={deckOptsFor(item)}
                            onChange={setDeckSel}
                            className="w-full border border-emerald-300 rounded-lg px-2 py-2 text-[13px] font-semibold bg-card text-emerald-700"
                          />
                          {deckSel !== item.matched?.category && (
                            <div className="text-[11px] text-amber-600 font-semibold mt-1">
                              Will re-book: {item.matched?.category} → {deckSel}
                            </div>
                          )}
                          {/* WHO it was for. The card asks what a payment was
                              FOR; asking who it was for in the same moment is
                              the difference between this queue producing
                              attributed spend and producing rows that name
                              nobody — 2,165 of them today. */}
                          <div className="mt-2">
                            <div className="text-[11px] font-semibold text-gray-500 mb-1">
                              {item.matched?.artist ? 'Artist' : 'Artist — nobody is named yet'}
                            </div>
                            <ArtistSelect
                              value={deckArtist}
                              options={roster}
                              placeholder="Artist…"
                              onChange={setDeckArtist}
                              className="w-full border border-rule rounded-lg px-2 py-2 text-[13px] font-semibold bg-card text-ink"
                            />
                            {deckArtist.trim() !== (item.matched?.artist || '').trim() && (
                              <div className="text-[11px] text-violet-600 font-semibold mt-1">
                                {deckArtist.trim()
                                  ? `Will attribute to ${deckArtist.trim()}`
                                  : `Will clear ${item.matched?.artist}`}
                              </div>
                            )}
                          </div>
                          {/* And whether it can be billed back. Only on a row
                              THIS APP booked: a card sitting on a real invoice
                              shows the invoice's own answer, and this page is
                              not where that gets changed. */}
                          {wasBookedByUs(item) && (
                            <div className="mt-2">
                              <RecoupAnswer value={deckRecoup} onChange={setDeckRecoup} disabled={deckBusy} />
                              {deckRecoup !== recoupAnswerOf(item) && (
                                <div className="text-[11px] text-ink font-semibold mt-1">
                                  {typeof deckRecoup === 'boolean'
                                    ? `Will record: ${deckRecoup ? 'recoupable' : 'not recoupable'}`
                                    : 'Will leave the stored answer as it is'}
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      ) : primary.type === 'match' ? (
                        <>
                          <div className="text-[11px] font-extrabold uppercase tracking-wider text-gray-500 mb-1">Swipe right to match</div>
                          <div className="text-[13px] font-bold text-ink">{primary.target.payee}</div>
                          <div className="text-[11px] text-gray-500">
                            {fmt(primary.target.family_total)}{primary.target.remaining != null && Number(primary.target.remaining) < Number(primary.target.family_total) - 0.009 ? ` (${fmt(primary.target.remaining)} left)` : ''}{primary.target.invoice_number ? ` · inv ${primary.target.invoice_number}` : ''} · {suggestionWhen(primary.target)} · {primary.target.score}% match
                          </div>
                          {(primary.target.why || []).length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {primary.target.why.map((w) => (
                                <span key={w} className="text-[9px] font-bold uppercase tracking-wide text-gray-500 bg-gray-100 rounded px-1 py-px">{w}</span>
                              ))}
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <div className={`text-[11px] font-extrabold uppercase tracking-wider mb-1 ${item.direction === 'credit' ? 'text-sky-600' : 'text-emerald-600'}`}>
                            Swipe right to book as{item.suggested_category || item.suggested_income_type ? ' (suggested)' : ''}
                          </div>
                          {item.vendor_hint && !deckForceBook && (
                            <div className="text-[11px] text-gray-500 mb-1.5">
                              Linked vendor: <span className="font-bold text-ink">{item.vendor_hint.vendor}</span> — no open invoice.
                              Booking creates the ledger entry under this vendor{item.vendor_hint.usual_category ? ` (usual category: ${item.vendor_hint.usual_category})` : ''}.
                            </div>
                          )}
                          {/* The primary booking surface — where you most
                              often discover a category is missing, so it can
                              create one inline. Credits create income types,
                              debits create expense categories. */}
                          <CategorySelect
                            value={deckSel}
                            kind={item.direction === 'credit' ? 'income' : 'expense'}
                            numbered
                            options={deckOptsFor(item)}
                            onChange={setDeckSel}
                            placeholder={item.direction === 'credit' ? 'Pick an income type…' : 'Pick a category…'}
                            className={`w-full border rounded-lg px-2 py-2 text-[13px] font-semibold bg-card ${item.direction === 'credit' ? 'border-sky-300 text-sky-700' : 'border-emerald-300 text-emerald-700'}`}
                          />
                          {/* Debits only: an artist is who spend was FOR, and
                              income has its own artist field on a different
                              record. The booking carries it, so the entry is
                              never briefly on the books unattributed. */}
                          {item.direction !== 'credit' && (
                            <div className="mt-2">
                              <div className="text-[11px] font-semibold text-gray-500 mb-1">Artist (optional)</div>
                              <ArtistSelect
                                value={deckArtist}
                                options={roster}
                                placeholder="Artist…"
                                onChange={setDeckArtist}
                                className="w-full border border-rule rounded-lg px-2 py-2 text-[13px] font-semibold bg-card text-ink"
                              />
                              {/* Asked in the same breath as who it was for,
                                  and for the same reason: the booking carries
                                  the answer, so the entry is never on the books
                                  claiming to be recoupable when it isn't. */}
                              <div className="mt-2">
                                <RecoupAnswer value={deckRecoup} onChange={setDeckRecoup} disabled={deckBusy} />
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>

                    {/* `rebook` is no longer excluded: a booked row is exactly
                        the row worth splitting — the app invented ONE entry for a
                        transfer that covered two artists, and that is 2,165 of
                        them against 3 open ones. The endpoint displaces the
                        invented entry as part of the same write. `keep` stays out:
                        those rows are matched to a real invoice, and its document
                        already says what the payment was for. */}
                    {item.direction === 'debit' && !deckSplit && primary.type !== 'keep' && (
                      <div className="mt-1.5 flex items-center gap-3">
                        <button onClick={() => setDeckSplit([
                          { amount: '', category: deckSel || 'Other' },
                          { amount: '', category: 'Other' },
                        ])}
                          className="text-[11px] font-bold text-gray-400 hover:text-ink">
                          Split across categories…
                        </button>
                        {primary.type === 'match' && (
                          <button onClick={() => { setDeckForceBook(true); setDeckSel(deckDefaultFor(item)) }}
                            className="text-[11px] font-bold text-gray-400 hover:text-ink"
                            title="Not this invoice — book the debit as a plain category expense instead">
                            Book as category instead…
                          </button>
                        )}
                        {deckForceBook && (
                          <button onClick={() => setDeckForceBook(false)}
                            className="text-[11px] font-bold text-gray-400 hover:text-ink">
                            Use the match instead
                          </button>
                        )}
                        <button onClick={() => { setDeckSearchOpen(!deckSearchOpen); setMatchQuery(''); setMatchResults([]) }}
                          className="text-[11px] font-bold text-gray-400 hover:text-ink"
                          title="Search the whole ledger for the invoice this pays">
                          Search ledger…
                        </button>
                      </div>
                    )}

                    {/* Unbook, on the cards where it means something: a row whose
                        ledger entry this app invented. The deck could undo one
                        only by backing out of the card that made it, so a booking
                        made in another session was unreachable without leaving.
                        Deliberately a text link, not a seventh round button — the
                        action row is for the decision, this is a correction. */}
                    {wasBookedByUs(item) && !deckSplit && (
                      <div className="mt-1.5 flex items-center gap-3">
                        <button onClick={() => deckUnbook(item)} disabled={deckBusy}
                          className="text-[11px] font-bold text-gray-400 hover:text-rose-600 disabled:opacity-40"
                          title={`Delete the ${item.matched?.category || 'ledger'} entry we created for this row and reopen it`}>
                          Unbook this row…
                        </button>
                        <span className="text-[11px] text-gray-300">
                          removes the entry we invented · the row reopens for matching
                        </span>
                      </div>
                    )}

                    {deckSearchOpen && (
                      <div className="mt-2">
                        <input autoFocus value={matchQuery} onChange={(e) => onMatchQuery(e.target.value)}
                          placeholder="Search the ledger by payee, artist, invoice #…"
                          className="w-full border border-rule rounded-lg px-3 py-2 text-[13px] bg-card text-ink outline-none" />
                        {/* A search result is chosen ON SIGHT — payee, number,
                            amount — with no way to open the invoice and check.
                            The 📄 is the same shared pickDoc/fileUrl the rest of
                            the page uses, and it stops the click that follows
                            from being a guess. Rendered OUTSIDE the row button:
                            nesting a button inside a button is invalid and the
                            inner click would also fire the match. */}
                        {matchResults.map((e) => (
                          <div key={e.id} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-gray-100 rounded">
                            <button onClick={() => deckMatchTo(item, { id: e.id })} disabled={deckBusy}
                              className="flex-1 min-w-0 text-left flex items-center gap-2 disabled:opacity-50">
                              <span className="font-semibold text-ink truncate">{e.payee}</span>
                              <span className="text-gray-400">{e.invoice_number || ''}</span>
{/* THE WHOLE INVOICE, not the parent's share. A split
                                    invoice keeps its own part in `amount` and the
                                    rest on children, so #570 read $500.00 against
                                    a document for $2,005.00 — and a $2,005 payment
                                    looked like it matched nothing. The matcher
                                    always scored the family total; this list was
                                    the thing disagreeing with it. */}
                                <span className="ml-auto font-bold whitespace-nowrap">
                                  {fmt(e.family_total ?? e.amount)}
                                  {e.split_count > 0 && (
                                    <span className="ml-1 font-normal text-[11px] text-gray-400"
                                      title={`Split into ${e.split_count + 1} parts — ${fmt(e.amount)} on the invoice row and the rest on its parts. A payment settles the whole ${fmt(e.family_total)}.`}>
                                      · {e.split_count + 1} parts
                                    </span>
                                  )}
                                </span>
                              <span className={`text-[11px] font-bold ${e.payment_status === 'Paid' ? 'text-emerald-600' : 'text-amber-600'}`}>{e.payment_status || 'Unpaid'}</span>
                            </button>
                            <DocButton row={e} />
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Ledger near-misses — one tap matches instead of booking.
                        Suggestions below the 85% auto-threshold only surface
                        here; the primary stays book-as-category. */}
                    {item.direction === 'debit' && (() => {
                      const alts = (item.suggestions || [])
                        .filter((s) => !deck.claimed?.has(s.id) && !(primary.type === 'match' && s.id === primary.target.id))
                        .slice(0, 3)
                      if (!alts.length) return null
                      return (
                        <div className="mt-2">
                          <div className="text-[11px] font-extrabold uppercase tracking-wider text-gray-400 mb-1">
                            {primary.type === 'match' ? 'Other ledger matches' : 'Ledger matches'}
                          </div>
                          {alts.map((s) => (
                            <button key={s.id} onClick={() => deckMatchTo(item, s)} disabled={deckBusy}
                              className="w-full flex items-center gap-2 text-left border border-rule rounded-lg px-2.5 py-1.5 mb-1 hover:border-gray-300 hover:bg-gray-50 disabled:opacity-50">
                              <Link2 size={12} className="text-gray-400 shrink-0" />
                              <span className="min-w-0 flex-1">
                                <span className="block text-[12px] font-semibold text-ink truncate">{s.payee}</span>
                                <span className="block text-[11px] text-gray-400">
                                  {fmt(s.family_total)}{s.remaining != null && Number(s.remaining) < Number(s.family_total) - 0.009 ? ` (${fmt(s.remaining)} left)` : ''}{s.invoice_number ? ` · inv ${s.invoice_number}` : ''} · {suggestionWhen(s)}
                                </span>
                                {((s.why || []).length > 0 || s.rejected) && (
                                  <span className="flex flex-wrap gap-1 mt-0.5">
                                    {s.rejected && (
                                      <span className="text-[9px] font-bold uppercase tracking-wide text-rose-600 bg-rose-50 border border-rose-200 rounded px-1 py-px">previously unmatched</span>
                                    )}
                                    {(s.why || []).map((w) => (
                                      <span key={w} className="text-[9px] font-bold uppercase tracking-wide text-gray-500 bg-gray-100 rounded px-1 py-px">{w}</span>
                                    ))}
                                  </span>
                                )}
                              </span>
                              <span className="text-[11px] font-bold text-gray-400 shrink-0">{s.score}%</span>
                            </button>
                          ))}
                        </div>
                      )
                    })()}

                    {/* Each action shows its name under the circle on hover */}
                    <div className="flex items-start justify-center gap-3 mt-5">
                      <DeckButton onClick={deckBack} disabled={deckBusy || !(deck.history?.length)}
                        title="Back — undo the previous card (⌫)" label="Undo">
                        <Undo2 size={18} />
                      </DeckButton>
                      <DeckButton onClick={deckDismiss} disabled={deckBusy || !!(item.matched_expense_id || item.matched_income_id)}
                        tone="rose" label="Dismiss"
                        title={item.matched_expense_id || item.matched_income_id ? 'Unmatch/unbook first — a matched transaction can\'t be dismissed' : 'Dismiss (D)'}>
                        <Ban size={18} />
                      </DeckButton>
                      {/* Sits beside Dismiss because that is the pair people
                          confuse, and it is drawn differently on purpose: this
                          KEEPS the money and answers the row, Dismiss takes the
                          money out of the P&L. Debits only — a credit has no
                          invoice to expect. */}
                      {item.direction === 'debit' && (
                        <DeckButton onClick={deckNoInvoice} disabled={deckBusy || item.no_invoice_expected
                            || !!(item.matched_expense_id && item.match_method !== 'created')}
                          label="No invoice"
                          title={item.no_invoice_expected
                            ? 'Already marked as needing no invoice'
                            : item.matched_expense_id && item.match_method !== 'created'
                              ? 'Already matched to a real invoice — unmatch first if that pairing is wrong'
                              : 'No invoice for that — books it and drops it out of the queue. The spend still counts. (N)'}>
                          <FileX size={17} />
                        </DeckButton>
                      )}
                      <DeckButton onClick={deckFlag} disabled={deckBusy}
                        tone={item.flagged ? 'amberOn' : 'amber'}
                        title={item.flagged ? 'Unflag (F)' : 'Flag for review — stays on this card, you can still categorize (F)'}
                        label={item.flagged ? 'Unflag' : 'Flag'}>
                        <Flag size={17} className={item.flagged ? 'fill-amber-400' : ''} />
                      </DeckButton>
                      <DeckButton onClick={deckSkip} disabled={deckBusy}
                        title="Skip — decide later (←)" label="Skip">
                        <ChevronRight size={20} className="rotate-180" />
                      </DeckButton>
                      <DeckButton onClick={deckAccept} disabled={deckBusy} tone="accept" size="xl"
                        title="Accept (→)"
                        label={deckSplit ? 'Book split' : primary.type === 'match' ? 'Match' : primary.type === 'reversal' ? 'Net off' : primary.type === 'income' ? 'Book income' : 'Book'}>
                        {deckBusy ? <Loader size={22} className="animate-spin" /> : <CheckCircle2 size={26} />}
                      </DeckButton>
                    </div>
                  </div>
            )}
          </ReviewDeck>

        )
      })()}

      {/* Upload rules — auto-dismiss + auto-book, applied to every statement */}
      {/* Rules moved to their own page.
          They are STANDING DECISIONS — accepted once, applied to every future
          statement — and they were sitting on the page where today's work
          happens, which had grown to nine stacked bands above its own table.
          A link, not a disappearance: the suggestions are valuable precisely
          because this page's data produced them. */}
      {/* ── The cross-currency funding-pair deck ─────────────────────────────
          One payment on two statements in two currencies. Both legs are shown
          with the evidence that links them — the recipient's name, how far apart
          the dates are, and the spread between the converted amounts — because
          this is a proposal, not an equality, and John has to be able to
          disagree with it. */}
      {fxDeck && (() => {
        const total = fxDeck.pairs.length
        const done = fxDeck.index >= total
        const pair = done ? null : fxDeck.pairs[fxDeck.index]
        const money = (n, cur) => `${cur === 'USD' ? '$' : `${cur} `}${Number(n).toFixed(2)}`
        const gap = pair
          ? Math.abs(Math.round((new Date(pair.candidates[0].date) - new Date(pair.paypal.date)) / 86400000))
          : 0
        // Token classes, not hex. This page is Tailwind-token based, so a card
        // written in #6b7280 and #e5e7eb reads as grey-on-grey the moment anyone
        // opens it in dark mode — and the deck is a full-screen surface, so there
        // is nowhere for that to hide.
        const leg = (title, sub, main, note, highlight) => (
          <div className={`flex-1 min-w-0 rounded-xl border px-3 py-2.5 ${highlight ? 'border-indigo-300 dark:border-indigo-500/50' : 'border-rule'}`}>
            <div className="text-[11px] font-extrabold uppercase tracking-wider text-gray-500">{title}</div>
            <div className="text-[17px] font-extrabold text-ink mt-0.5" style={{ fontFamily: 'ui-monospace, monospace' }}>{main}</div>
            <div className="text-[11px] text-gray-600 mt-0.5">{sub}</div>
            {note && <div className="text-[11px] text-gray-500 mt-1 break-words">{note}</div>}
          </div>
        )
        return (
          <ReviewDeck
            index={fxDeck.index}
            total={total}
            label="Funding pairs · cross-currency"
            onClose={async () => { setFxDeck(null); if (openId) await fetchDetail(openId); await fetchCompletion() }}
            done={done}
            doneTitle={fxDeck.closed ? `${fxDeck.closed} pair${fxDeck.closed === 1 ? '' : 's'} closed` : 'Nothing closed'}
            doneSummary={[
              fxDeck.closed ? `${fxDeck.closed} payment${fxDeck.closed === 1 ? '' : 's'} now counted once instead of twice.` : '',
              fxDeck.skipped ? `${fxDeck.skipped} left alone.` : '',
              fxDeck.failures.length
                ? `${fxDeck.failures.length} refused: ${fxDeck.failures.slice(0, 3).map((f) => `${f.payee} — ${f.error}`).join(' · ')}`
                : '',
              'Every close is reversible from the vendor page.',
            ].filter(Boolean).join(' ')}
            hint={pair ? 'The bank pays more than mid-market — the difference is PayPal’s spread, not a different payment.' : ''}
          >
            {() => (
              /* THE CHILD IS THE CARD. ReviewDeck supplies the backdrop, the
                 header and the progress bar, but no panel — only its `done` state
                 has a background. Mine rendered a bare div, so the card was
                 transparent and the table behind it read straight through the
                 text. Same wrapper the statements deck on this page uses. */
              <div className="bg-card rounded-2xl shadow-2xl p-6 text-ink">
                <div className="text-[13px] font-extrabold text-ink mb-0.5">{pair.paypal.payee || '(no name)'}</div>
                <div className={`text-[11px] text-gray-500 ${pair.unproven ? 'mb-1.5' : 'mb-2.5'}`}>
                  {pair.unproven ? 'A pull of about the right size, at about the right time' : 'One payment, on both statements'}
                  {' — '}{gap === 0 ? 'the same day' : `${gap} day${gap === 1 ? '' : 's'} apart`}
                  {typeof pair.candidates[0].spread_pct === 'number' && ` · ${pair.candidates[0].spread_pct}% spread`}
                </div>
                {/* Said plainly, on the card, because this one is a judgement and
                    not a finding. The descriptor is quoted so the reader can see
                    exactly what they are being asked to recognise. */}
                {pair.unproven && (
                  <div className="text-[11px] text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 border border-amber-300 dark:border-amber-500/40 rounded-lg px-2.5 py-1.5 mb-2.5">
                    <strong>Nothing proves this is theirs.</strong> The pull reads
                    {' '}“{pair.candidates[0].description || pair.candidates[0].payee || '—'}”, which does not contain
                    {' '}{pair.paypal.payee || 'the name'} — PayPal often prints a handle instead. Confirm only if you
                    recognise it; it will be recorded as your judgement, and it is excluded from “close all”.
                  </div>
                )}
                <div className="flex gap-2.5 flex-wrap">
                  {leg('PayPal statement',
                    `${pair.paypal.date} · ${pair.paypal.state}`,
                    money(pair.paypal.amount, pair.paypal.currency),
                    pair.paypal.currency !== 'USD' ? `≈ $${Number(pair.paypal.usd).toFixed(2)} converted` : null)}
                  {leg('Bank statement — the funding pull',
                    `${pair.candidates[0].date} · ${pair.candidates[0].state}`,
                    money(pair.candidates[0].amount, pair.candidates[0].currency),
                    pair.candidates[0].payee ? `payee "${pair.candidates[0].payee}"` : null,
                    '#c7d2fe')}
                </div>
                {/* LABELLED BUTTONS, not DeckButton.
                    DeckButton is a ROUND ICON button — rounded-full, a fixed
                    size, contents centred, with `label` as a hover caption. The
                    statements deck passes it a 26px icon. I passed it sentences,
                    so each one was crammed into a circle and wrapped into a blob;
                    John's screenshot is that. These decisions need words on them,
                    so they get real buttons. */}
                <div className="flex gap-2 mt-4 flex-wrap items-center">
                  <button onClick={() => closeFxPair(pair)} disabled={fxBusy}
                    title="The PayPal copy closes; the record stays on the bank row, which is what the P&L counts."
                    className={`rounded-lg px-3.5 py-2 text-[13px] font-bold whitespace-nowrap
                      ${pair.unproven
                        ? 'border border-amber-400 text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-500/10'
                        : 'bg-ink text-card hover:opacity-85'}
                      ${fxBusy ? 'opacity-40 cursor-default' : ''}`}>
                    {pair.unproven ? 'I recognise it — close' : 'Same payment — close'}
                  </button>
                  <button onClick={() => fxAdvance({ skipped: fxDeck.skipped + 1 })} disabled={fxBusy}
                    title="Leave both legs alone. It stays counted twice until somebody decides."
                    className={`rounded-lg border border-rule px-3.5 py-2 text-[13px] font-semibold text-gray-600 hover:text-ink hover:border-gray-300 whitespace-nowrap ${fxBusy ? 'opacity-40 cursor-default' : ''}`}>
                    Not the same — skip
                  </button>
                  <button onClick={closeAllFxPairs} disabled={fxBusy}
                    title={`Close this and the remaining provable pairs. Each is checked by the server independently and any refusal is listed at the end.`}
                    className={`ml-auto text-[12px] font-bold text-boom-600 hover:underline whitespace-nowrap ${fxBusy ? 'opacity-40 cursor-default' : ''}`}>
                    close all {fxDeck.pairs.slice(fxDeck.index).filter((x) => !x.unproven).length} provable
                  </button>
                </div>
                {batchProgress && (
                  <div className="text-[11px] text-gray-500 mt-2">closing… {batchProgress.done} of {batchProgress.total}</div>
                )}
              </div>
            )}
          </ReviewDeck>
        )
      })()}

      {previewFile && (
        <FilePreview url={previewFile.url} filename={previewFile.filename} onClose={() => setPreviewFile(null)} />
      )}

      {(
        <div className="mt-4 flex items-center gap-2 text-[12px]">
          <a href="/bk/rules" className="inline-flex items-center gap-1.5 text-gray-500 hover:text-ink border border-rule hover:border-gray-300 rounded-lg px-2.5 py-1.5 font-semibold">
            <Ban size={13} /> Upload rules
            {(rules.length + catRules.length + (completion !== 'error' && completion?.rules?.length || 0)) > 0 && (
              <span className="tabular-nums text-gray-400">
                {rules.length + catRules.length + (completion !== 'error' && completion?.rules?.length || 0)}
              </span>
            )}
          </a>
          {suggestions?.suggestions?.length > 0 && (
            <a href="/bk/rules" className="font-bold text-emerald-700 hover:underline">
              {suggestions.suggestions.length} suggested from what you already do
            </a>
          )}
        </div>
      )}


      </>)}

    </div>
  )
}
