import { Fragment, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { Landmark, Upload, Trash2, Loader, CheckCircle2, AlertCircle, AlertTriangle, RefreshCw, Link2, X, ChevronDown, ChevronRight, Plus, Ban, Zap, Flag, Search, Clock, Undo2, FileText } from 'lucide-react'
import api from '../api'
import ListSearch, { matchesQuery } from '../components/ListSearch'
import {
  ACCOUNTS, acctLabel, MONTH_FULL, stmtLabel, viewStmtFile, fmt,
  cleanBankPayee, fmtDate, suggestionWhen, displayCaseTitle,
  normTxt, restates,
} from '../utils/bankDisplay'
import NextStepPrompt, { useNextStep } from '../components/NextStepPrompt'

// Statements — upload BofA / PayPal statement CSVs and reconcile them against
// the ledger. Admin/Superadmin only (Approvers don't see bank balances).
// Buckets: Confirm payments (matched + unpaid), Verified (matched + paid),
// Needs attention (unmatched debits + paid rows with no bank evidence).

// ── Reconciliation arithmetic, written once ──────────────────────────────────
//
// Every figure this page prints — the page total, a month subtotal, a single
// statement's bar — is the SAME reduction over a different set of statements.
// It has to be, or a band states a number the list beneath it contradicts: this
// repo has shipped "Explained 73%" directly above "Invoice-backed 37.9%" over
// two different denominators, and a statement selector reading "19 left" beside
// a queue of 1,765.
//
// The buckets come from GET /statements/reconciliation, which partitions every
// row (see server/lib/statement-buckets.js). Rolling them up here — over the
// very statements rendered below — is what keeps the band and the list honest.
const ACCOUNTED = ['matched', 'creator', 'no_invoice_due']
const LEFT_KEYS = ['needs_invoice', 'open']

function rollUp(recon, ids) {
  const out = { debits: {}, credits: {} }
  for (const id of ids) {
    const g = recon?.[id]
    if (!g) continue
    for (const side of ['debits', 'credits']) {
      for (const [k, b] of Object.entries(g[side] || {})) {
        const t = out[side][k] || (out[side][k] = { n: 0, value: 0 })
        t.n += b.n
        t.value += b.value
      }
    }
  }
  return out
}

const pick = (side, keys) => keys.reduce(
  (s, k) => ({ n: s.n + (side?.[k]?.n || 0), value: s.value + (side?.[k]?.value || 0) }),
  { n: 0, value: 0 })

// ACCOUNTED / (ACCOUNTED + LEFT), by MONEY — this is a money page, and a month
// whose last open line is $70,929 is not 99% done. Excluded rows are out of the
// denominator, not on the wrong side of it: a dismissed row is a decision, not
// a debt. Nothing to judge reads 100, never 0 — an empty statement is not
// failing, and a red bar on a statement with no work is a false alarm.
function coverageOf(side) {
  const a = pick(side, ACCOUNTED).value
  const l = pick(side, LEFT_KEYS).value
  return a + l > 0 ? Math.round((a / (a + l)) * 100) : 100
}

// The library's existing tri-tone, kept as-is so the bars still read the way
// they always have — only the number driving them changed.
const covTone = (pct) => (pct >= 95 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-400' : 'bg-rose-400')

// One line of a statement's breakdown.
//
// `to` makes the line a link to the rows behind it. Only four sets on Bank
// Matching are EXACTLY these sets — Categorized, For review, Needs invoice and
// Excluded — so only those lines link. The rest are plain text on purpose: a
// link that lands on a page showing a different number is worse than no link,
// and this page has already shipped a chip whose count was 7x its own rows.
function BucketLine({ label, n, value, share, to, sub, strong }) {
  const body = (
    <>
      <span className={`flex-1 truncate ${sub ? 'text-gray-400' : strong ? 'font-semibold text-ink' : 'text-ink'}`}>{label}</span>
      <span className="w-12 text-right tabular-nums text-gray-400 shrink-0">{n}</span>
      <span className={`w-28 text-right tabular-nums shrink-0 ${sub ? 'text-gray-400' : 'text-ink'}`}>{n === 0 ? '—' : fmt(value)}</span>
      <span className="w-10 text-right tabular-nums text-gray-300 shrink-0">{share == null || n === 0 ? '' : `${share}%`}</span>
    </>
  )
  const cls = `flex items-center gap-2 text-[12px] py-0.5 ${sub ? 'pl-4' : ''}`
  if (!to || n === 0) return <div className={`${cls} ${to ? 'pr-4' : 'pr-4'}`}>{body}<span className="w-3 shrink-0" /></div>
  return (
    <a href={to} onClick={(e) => e.stopPropagation()}
      className={`${cls} pr-4 rounded hover:bg-white group/line`}
      title="Open these rows in Bank Matching">
      {body}
      <ChevronRight size={11} className="shrink-0 text-gray-300 group-hover/line:text-ink" />
    </a>
  )
}

export default function BkStatements() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [nextStep, showNextStep, clearNextStep] = useNextStep()
  // NOTE: the transaction table, its search, filters, selections and the review
  // deck all live on Bank Matching (ccee55a). Their state used to be declared
  // here and had been unused ever since — which is how a click handler survived
  // pointing at a view that no longer existed, and blanked the page.
  // Live category vocabularies — see context/CategoriesContext. The deck
  // snapshots a usage-sorted copy at open (deck.cats) so numbering stays
  // stable mid-run; these are the source it sorts.
  const [statements, setStatements] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [account, setAccount] = useState('bofa')
  const [uploading, setUploading] = useState(false)
  const [matching, setMatching] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [showCredits, setShowCredits] = useState(false)
  // Mini-ledger view controls
  const [sortKey, setSortKey] = useState('date')
  const [sortDir, setSortDir] = useState('desc')
  // Inline manual-match search, keyed by the txn being matched
  const [matchingTx, setMatchingTx] = useState(null)
  const [matchQuery, setMatchQuery] = useState('')
  const [matchResults, setMatchResults] = useState([])
  // Inline create-entry form, keyed by the txn it books
  const [entryTx, setEntryTx] = useState(null)
  const [entryForm, setEntryForm] = useState({ payee: '', category: 'Marketing', artist: '' })
  const [creatingEntry, setCreatingEntry] = useState(false)
  // Always-dismiss rules
  const [rules, setRules] = useState([])
  const [rulesOpen, setRulesOpen] = useState(false)
  const [flags, setFlags] = useState([])
  const [ackedFlags, setAckedFlags] = useState([])
  const [showAcked, setShowAcked] = useState(false)
  const [catsExpanded, setCatsExpanded] = useState(false)
  const [remindersOpen, setRemindersOpen] = useState(false)
  const dragDepth = useRef(0)
  const [flagsLoading, setFlagsLoading] = useState(false)
  const [flagsView, setFlagsView] = useState(false) // Flags as their own subpage (replaces the library, like focus mode)
  // Filter the flags worklist. This subpage can carry a couple of hundred
  // findings across ~18 check types; the sectioning helps but you still can't
  // find one payee. Client-side — /statements/flags returns the whole set.
  const [flagSearch, setFlagSearch] = useState('')
  // Personal reminders (bell + email delivery; managed here)
  const [reminders, setReminders] = useState([])
  const [reminderTitle, setReminderTitle] = useState('')
  const [reminderDay, setReminderDay] = useState(5)
  const [reminderBusy, setReminderBusy] = useState(false)
  // Global search — every transaction across every statement
  const [globalQ, setGlobalQ] = useState('')
  const [globalHits, setGlobalHits] = useState(null) // null = panel hidden
  const [globalBusy, setGlobalBusy] = useState(false)
  const globalTimer = useRef(null)
  // Bulk selection over unmatched debits
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkCategory, setBulkCategory] = useState('Travel')
  const [catRules, setCatRules] = useState([])
  const [entryAlways, setEntryAlways] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [batch, setBatch] = useState(null) // { done, total, phase: 'uploading'|'parsing' }
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
  const [deckSplit, setDeckSplit] = useState(null) // null | [{amount, category}, ...]
  const [deckForceBook, setDeckForceBook] = useState(false) // override a match-primary card to book-as-category
  const [deckSearchOpen, setDeckSearchOpen] = useState(false) // ledger search on the card
  const [deckBusy, setDeckBusy] = useState(false)
  const [deckDx, setDeckDx] = useState(0)
  const [resetBusy, setResetBusy] = useState(false)
  const [reparsing, setReparsing] = useState(null) // statement id being re-parsed

  // Extra items — rows the app holds that a statement's own balances don't
  // support. The audit re-downloads and re-parses every stored PDF, so it runs
  // only when asked, never on page load.
  const [extras, setExtras] = useState(null)        // { statements, total_extra, total_value, ... }
  const [extrasBusy, setExtrasBusy] = useState(false)
  const [extrasOpen, setExtrasOpen] = useState(null) // statement id whose detail is open
  const [extrasRemoving, setExtrasRemoving] = useState(null)

  const extrasFor = (id) => extras?.statements?.find((s) => s.id === id)

  // Rows holding another payment's details. The portfolio sweep returns only a
  // count per statement — the detail names vendors and rewrites live rows, so it
  // is fetched for the one statement being looked at, not for thirteen nobody
  // opened.
  const [misfiled, setMisfiled] = useState({})       // { [statementId]: payload }
  const [misfiledOpen, setMisfiledOpen] = useState(null)
  const [misfiledBusy, setMisfiledBusy] = useState(null)
  const [misfiledFixing, setMisfiledFixing] = useState(null)

  const openMisfiled = async (id) => {
    if (misfiledOpen === id) { setMisfiledOpen(null); return }
    setMisfiledOpen(id)
    if (misfiled[id]) return
    setMisfiledBusy(id)
    try {
      const res = await api.get(`/statements/${id}/misfiled`)
      setMisfiled((m) => ({ ...m, [id]: res.data.data }))
    } catch (err) {
      alert(err.response?.data?.error || err.message)
      setMisfiledOpen(null)
    } finally { setMisfiledBusy(null) }
  }

  const repairMisfiled = async (st) => {
    const d = misfiled[st.id]
    if (!d?.repairs?.length) return
    const changing = d.repairs.filter((r) => r.payee_changes)
    const losing = changing.filter((r) => r.matched_expense_id || r.matched_income_id)
    if (!window.confirm(
      `Repair ${d.repairs.length} row${d.repairs.length === 1 ? '' : 's'} on "${st.filename}".\n\n`
      + `Each one currently repeats another payment's details while a payment the statement `
      + `charges is missing. The rows keep their id, date and amount; only who was paid changes.\n\n`
      + `${changing.length} change the vendor.\n`
      + `${losing.length} will lose their invoice match, because that invoice was matched to the OLD name — `
      + `it goes back to the attach pool for you to place.\n\nNothing in the ledger is deleted except bookings the app itself invented.`
    )) return
    setMisfiledFixing(st.id)
    try {
      const res = await api.post(`/statements/${st.id}/misfiled/repair`)
      const r = res.data.data
      alert(`Repaired ${r.repaired} row${r.repaired === 1 ? '' : 's'}.\n`
        + `${r.unmatched} lost a match; ${r.unbooked} invented booking${r.unbooked === 1 ? '' : 's'} removed.`)
      setMisfiled((m) => ({ ...m, [st.id]: undefined }))
      setMisfiledOpen(null)
      await fetchStatements()
      await checkExtras()
    } catch (err) {
      alert(err.response?.data?.error || err.message)
    } finally { setMisfiledFixing(null) }
  }

  const checkExtras = async () => {
    if (extrasBusy) return
    setExtrasBusy(true)
    try {
      const res = await api.get('/statements/extras')
      setExtras(res.data.data)
    } catch (err) {
      window.alert('Could not check statements: ' + (err.response?.data?.error || err.message))
    } finally { setExtrasBusy(false) }
  }

  const removeExtras = async (st) => {
    const e = extrasFor(st.id)
    if (!e || !e.extraCount) return
    // Mismatched rows are not duplicates — the server refuses these too, but
    // saying so here explains WHY instead of surfacing a bare 400.
    if (e.missingCount > 0) {
      window.alert(
        `Nothing to remove here.\n\nThis statement is also missing ${e.missingCount} transaction${e.missingCount === 1 ? '' : 's'} `
        + `that it charges, so the ${e.extraCount} apparent extras are the same transactions recorded under different details `
        + `— commonly the wrong currency — not duplicates.\n\nRe-parse the statement to correct them.`)
      return
    }
    const ledger = [...new Set(e.groups.flatMap((g) => g.matched_expense_ids))]
    if (!window.confirm(
      `Remove ${e.extraCount} extra transaction${e.extraCount === 1 ? '' : 's'} from the ${acctLabel(st.account)} statement?\n\n`
      + `The statement's own balances prove it holds ${e.expected} transactions. The app has ${e.held}.\n`
      + `Combined value of the extras: ${fmt(e.extraValue)}.\n\n`
      + (ledger.length
        ? `${ledger.length} ledger entr${ledger.length === 1 ? 'y' : 'ies'} will lose a bank match and may themselves be duplicates — worth reviewing after.\n\n`
        : '')
      + 'Only the surplus copies are deleted; the ones carrying matches and dismissals are kept where possible. Nothing in the ledger is deleted.')) return
    setExtrasRemoving(st.id)
    try {
      const res = await api.post(`/statements/${st.id}/extras/remove`)
      const d = res.data.data
      window.alert(
        `Removed ${d.removed} extra transaction${d.removed === 1 ? '' : 's'} worth ${fmt(d.value)}.\n\n`
        + `Statement now holds ${d.txn_count}, matching the ${d.expected} its balances prove`
        + (d.txn_count === d.expected ? '.' : ` (${d.txn_count - d.expected} still differ).`)
        + (d.blocked_booked_income ? `\n\n${d.blocked_booked_income} left in place because they carry booked income — unbook those first.` : '')
        + (d.affected_expense_ids?.length ? `\n\n${d.affected_expense_ids.length} ledger entries lost a bank match. If they were created from the duplicate rows, they are duplicates too.` : ''))
      await fetchStatements()
      await checkExtras()
      fetchFlags()
    } catch (err) {
      window.alert('Could not remove: ' + (err.response?.data?.error || err.message))
    } finally { setExtrasRemoving(null) }
  }
  const [pnmOpen, setPnmOpen] = useState(false) // "no bank evidence" section — collapsed by default
  const [rowGroupsOpen, setRowGroupsOpen] = useState(new Set()) // expanded ×N row groups
  const [flagSecToggles, setFlagSecToggles] = useState({}) // flag-type section expand/collapse overrides
  // Is every statement PROVED, and is one missing? See /statements/integrity.
  //
  // Kept separate from `flags` deliberately: that list is 366 entries and 0
  // acknowledged, which is past the point where anybody reads it. This is two
  // sentences that are either reassuring or not.
  const [integrity, setIntegrity] = useState(null)
  const [backfilling, setBackfilling] = useState(false)
  // Monthly close (soft) — per-month checklist + reconciled badge
  const [months, setMonths] = useState([])
  const [monthExpanded, setMonthExpanded] = useState(new Set())
  // { [statement_id]: { debits: {bucket: {n, value}}, credits: {...} } }, or
  // null while it loads / after it fails. NEVER {} on failure: an empty map
  // reduces to "0 left, 100%", which reads as finished work rather than a
  // failed request — the exact mistake that made 1,746 waiting rows look done.
  const [recon, setRecon] = useState(null)
  const [stmtExpanded, setStmtExpanded] = useState(new Set())
  // Batch review — vendor-grouped clearing of ALL open debits
  const [batchView, setBatchView] = useState(false)
  const [batchGroups, setBatchGroups] = useState(null) // null = loading
  const [batchExpanded, setBatchExpanded] = useState(new Set())
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchProgress, setBatchProgress] = useState(null) // { done, total }
  const fileRef = useRef(null)
  const searchTimer = useRef(null)

  const flagsShown = flags.filter((f) => matchesQuery(flagSearch, [f.title, f.detail, f.type, f.q, f.severity]))

  const isAdminRole = user && (user.role === 'Admin' || user.role === 'Superadmin')

  const fetchStatements = async () => {
    try {
      const res = await api.get('/statements')
      setStatements(res.data.data || [])
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally { setLoading(false) }
  }
  useEffect(() => { if (isAdminRole) fetchStatements() }, [isAdminRole])

  // What each statement has answered, and in what money. One request for every
  // statement — the bars, the subtotals and the breakdowns are all reductions
  // over this, so a second read could not disagree with the first.
  const fetchRecon = async () => {
    try { setRecon((await api.get('/statements/reconciliation')).data?.data?.by_statement || {}) }
    catch { setRecon(null) }
  }
  useEffect(() => { if (isAdminRole) fetchRecon() }, [isAdminRole])

  const fetchIntegrity = async () => {
    try { setIntegrity((await api.get('/statements/integrity')).data?.data || null) }
    catch { /* the band simply does not render — it must never break the page */ }
  }
  useEffect(() => { if (isAdminRole) fetchIntegrity() }, [isAdminRole])

  // Carry a missing opening balance forward from the previous statement's
  // closing one. Writes ONE COLUMN on bank_statements and touches no
  // transaction — see the route for why that is the whole guarantee.
  const backfillOpenings = async () => {
    if (backfilling) return
    const n = integrity?.summary?.backfillable || 0
    if (!window.confirm(
      `Carry the opening balance forward onto ${n} statement${n === 1 ? '' : 's'}?\n\n`
      + 'Each one takes the closing balance of the statement before it, which is what a bank statement '
      + 'means by an opening balance. Nothing is re-parsed and no transaction is touched — no match, '
      + 'no dismissal and no row is affected, so nothing you have already worked reopens.')) return
    setBackfilling(true)
    try {
      const r = await api.post('/statements/backfill-beginning-balance')
      const d = r.data?.data || {}
      await Promise.all([fetchIntegrity(), fetchFlags?.()].filter(Boolean))
      alert(`${d.filled_count || 0} statement${(d.filled_count || 0) === 1 ? '' : 's'} now carry an opening balance.`
        + (d.skipped?.length ? `\n\n${d.skipped.length} skipped:\n` + d.skipped.map((x) => `• ${x.filename}: ${x.reason}`).join('\n') : ''))
    } catch (err) {
      alert('Failed: ' + (err.response?.data?.error || err.message))
    } finally { setBackfilling(false) }
  }

  // Deep link from Bank Vendors: /bk/statements?q=<payee> opens the
  // all-transactions review pre-filtered to that payee.
  useEffect(() => {
    if (!isAdminRole) return
    const params = new URLSearchParams(window.location.search)
    const jump = params.get('q')
    if (jump) {
      // Bank Matching owns the transaction search now; forward the term there.
      openStatement('all', jump)
    } else if (params.get('view') === 'flags') {
      setFlagsView(true)
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [isAdminRole]) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchFlags = async () => {
    setFlagsLoading(true)
    try {
      const res = await api.get('/statements/flags')
      const d = res.data.data
      setFlags(Array.isArray(d) ? d : d?.flags || [])
      setAckedFlags(Array.isArray(d) ? [] : d?.acked || [])
    } catch { /* flags are advisory — never block the page */ }
    finally { setFlagsLoading(false) }
  }
  // Jump into the statement a flag points at, pre-filtered to the payee.
  const openFlag = (f) => {
    if (!f.statement_id) return
    setFlagsView(false)
    setTxSearch(f.q || '')
    setDispFilter('all')
    openStatement(f.statement_id)
  }
  const flagAction = async (f) => {
    try {
      if (f.action?.kind === 'unmatch') {
        await api.delete(`/statements/tx/${f.action.txn_id}/match`)
      } else if (f.action?.kind === 'dismiss-pair') {
        for (const id of f.action.txn_ids) await api.post(`/statements/tx/${id}/dismiss`, {})
      } else if (f.action?.kind === 'unbook-income') {
        await api.post(`/statements/tx/${f.action.txn_id}/unbook-income`)
      } else if (f.action?.kind === 'mark-unpaid') {
        if (!confirm(`Mark "${f.action.payee || 'this entry'}" as Unpaid on the ledger?\n\nUse this when the bank never shows the payment because it didn't actually happen.`)) return
        await api.put(`/bk/payments/${f.action.entry_id}`, { payment_status: 'Unpaid' })
      } else if (f.action?.kind === 'relink') {
        const names = f.action.bank_payees || []
        if (!names.length) return
        if (!confirm(`Point ${names.length === 1 ? `"${names[0]}"` : `${names.length} bank vendors`} at ${f.action.ledger_payee}?\n\nThis replaces the learned link, so future statements file these under ${f.action.ledger_payee}. Existing matches are not touched.`)) return
        // One failure must not abandon the other 17 — /vendors/link refuses
        // names under 3 characters and payment-channel descriptors, and a
        // thrown loop would leave the repoint half done with no report of it.
        const failed = []
        for (const b of names) {
          try { await api.post('/statements/vendors/link', { bank_payee: b, ledger_payee: f.action.ledger_payee }) }
          catch (err) { failed.push(`${b}: ${err.response?.data?.error || err.message}`) }
        }
        if (failed.length) alert(`Repointed ${names.length - failed.length} of ${names.length}.\n\nNot done:\n${failed.join('\n')}`)
      } else if (f.action?.kind === 'unbook-rematch') {
        if (!confirm(`Fix the duplicate?\n\nThe booked copy is removed (restorable from the archive) and the bank debit is matched to ${f.action.payee}'s original invoice instead.`)) return
        await api.post(`/statements/tx/${f.action.txn_id}/unbook`)
        await api.post(`/statements/tx/${f.action.txn_id}/match`, { expense_id: f.action.expense_id })
      }
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    fetchFlags()
  }
  // "Same vendor under another name" — the second real answer on a
  // name-disagreement card. Writes the alias and leaves the match alone; the
  // server's check reads aliases live, so the flag retires itself rather than
  // needing a separate acknowledgement.
  const aliasAction = async (f) => {
    const { bank_payee: bank, ledger_payee: ledger } = f.alt_action || {}
    if (!bank || !ledger) return
    if (!confirm(`Record "${bank}" as another name for ${ledger}?\n\nThe match stays. Every future bank line spelled "${bank}" will be treated as ${ledger}, here and on the vendor pages.`)) return
    try {
      await api.post('/bk/vendors/aliases', { primary_name: ledger, alias: bank })
      fetchFlags()
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
  }
  const ackFlag = async (f) => {
    try { await api.post('/statements/flags/ack', { fingerprint: f.fingerprint }); fetchFlags() }
    catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
  }
  const unackFlag = async (f) => {
    try { await api.delete('/statements/flags/ack', { data: { fingerprint: f.fingerprint } }); fetchFlags() }
    catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
  }
  // Re-check when a statement is opened/closed — matching activity is what
  // creates or clears most flags.
  useEffect(() => { if (isAdminRole) fetchFlags() }, [isAdminRole]) // eslint-disable-line react-hooks/exhaustive-deps

  // Focus mode swaps a tall library for a short breadcrumb — the browser
  // keeps the old scroll offset and strands you at the bottom. Reset it on
  // every view switch (open AND back). The app shell scrolls Layout's
  // <main overflow-auto>, NOT the window — scroll both to be safe.
  useEffect(() => {
    document.querySelector('main')?.scrollTo({ top: 0 })
    window.scrollTo({ top: 0 })
  }, [flagsView, batchView])

  const fetchMonths = async () => {
    try {
      const res = await api.get('/statements/months')
      setMonths(Array.isArray(res.data.data) ? res.data.data : [])
    } catch { /* advisory */ }
  }
  useEffect(() => { if (isAdminRole) fetchMonths() }, [isAdminRole]) // eslint-disable-line react-hooks/exhaustive-deps

  // Full match reset: clear every auto AND manual match, then re-run with the
  // current evidence (links/aliases/FX/rejections).
  //
  // Manual matches are included deliberately — they used to be exempt, and that
  // exemption hid every inverted match found on 2026-08-06 (a debit dated up to
  // 208 days BEFORE its invoice, including $10,000), because manual matching
  // bypassed the date sanity the auto-matcher always applied.
  //
  // The cost is real and the dialog says so: a manual match usually exists
  // because the matcher COULDN'T derive it, so some won't come back and will need
  // re-doing by hand. Booked entries and booked income are never cleared —
  // unlinking those orphans the ledger row they created.

  const reconcileMonth = async (key, undo) => {
    try {
      await api.post(`/statements/months/${key}/reconcile`, undo ? { undo: true } : {})
      await fetchMonths()
      fetchFlags()
      // The hand-off: a reconciled month is a month the P&L can be trusted for.
      if (!undo) {
        showNextStep({
          title: `${key} reconciled`,
          body: 'Every line on the statement is answered, so the month is ready to read on Reports.',
          to: '/reports',
          label: 'Open Reports',
        })
      }
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
  }

  // ── Batch review: group ALL open debits by vendor, propose per row,
  //    select-all-with-review, one Apply per group. ─────────────────────────

  const fetchReminders = async () => {
    try {
      const res = await api.get('/reminders')
      setReminders(Array.isArray(res.data.data) ? res.data.data : [])
    } catch { /* advisory */ }
  }
  useEffect(() => { if (isAdminRole) fetchReminders() }, [isAdminRole]) // eslint-disable-line react-hooks/exhaustive-deps

  const addReminder = async (title, day) => {
    const t = String(title || '').trim()
    if (!t || reminderBusy) return
    setReminderBusy(true)
    try {
      await api.post('/reminders', { title: t, cadence: 'monthly', day_of_month: day, link: '/bk/statements', notify_email: true })
      setReminderTitle('')
      await fetchReminders()
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setReminderBusy(false) }
  }
  const toggleReminder = async (r) => {
    try { await api.put(`/reminders/${r.id}`, { active: !r.active }); fetchReminders() } catch {}
  }
  const deleteReminder = async (r) => {
    if (!window.confirm(`Delete reminder "${r.title}"?`)) return
    try { await api.delete(`/reminders/${r.id}`); fetchReminders() } catch {}
  }

  const onGlobalSearch = (q) => {
    setGlobalQ(q)
    clearTimeout(globalTimer.current)
    if (q.trim().length < 2) { setGlobalHits(null); return }
    globalTimer.current = setTimeout(async () => {
      setGlobalBusy(true)
      try {
        const res = await api.get('/statements/search', { params: { q: q.trim() } })
        setGlobalHits(Array.isArray(res.data.data) ? res.data.data : [])
      } catch { setGlobalHits([]) }
      finally { setGlobalBusy(false) }
    }, 300)
  }
  const openHit = (h) => {
    setGlobalHits(null)
    openStatement(h.statement_id, globalQ)
  }

  // Opening a statement means opening it ON BANK MATCHING.
  //
  // This used to GET /statements/:id into `detail` and render a transaction
  // table below. That table moved to Bank Matching when the pages were split
  // (ccee55a) — but the fetch, the state and the three click handlers stayed
  // here, and the page's three sections are all guarded on `!openId`. So
  // clicking a statement switched every section OFF and rendered nothing in
  // their place: a header, a Reminders card, and an empty page.
  //
  // The API was never at fault — every /statements/:id returns 200 with rows.
  // The view simply wasn't here any more.
  //
  // `?statement=` is the param Bank Matching already reads for its selector
  // (BkBankMatching.jsx:63), so this lands on that statement's rows rather than
  // on all thirteen.
  const openStatement = (id, q) => {
    const params = new URLSearchParams()
    if (id && id !== 'all') params.set('statement', String(id))
    // Both remaining callers open a statement in order to FIND something in it —
    // a ?q= deep link and a global-search hit — so the term travels with them
    // rather than landing on an unfiltered page of 3,700 rows.
    if (q && q.trim()) params.set('q', q.trim())
    const qs = params.toString()
    navigate(`/bk/bank-matching${qs ? `?${qs}` : ''}`)
  }

  // Accepts one file or a whole batch (multi-select / multi-drop). Files
  // upload sequentially to the selected account; PDFs parse server-side in
  // the background, so after the uploads we poll the list until every one
  // of ours has flipped from 'parsing' to ready/error.
  const handleUpload = async (fileList) => {
    const files = [...(fileList || [])].filter((f) => /\.(csv|pdf)$/i.test(f.name))
    if (!files.length) return
    setUploading(true)
    setError('')
    const uploaded = []
    const failures = []
    try {
      setBatch({ done: 0, total: files.length, phase: 'uploading' })
      for (const f of files) {
        try {
          const fd = new FormData()
          fd.append('file', f)
          fd.append('account', account)
          const res = await api.post('/statements/upload', fd)
          uploaded.push(res.data.data)
        } catch (err) {
          failures.push(`${f.name}: ${err.response?.data?.error || err.message}`)
        }
        setBatch((b) => b && { ...b, done: b.done + 1 })
      }
      fetchStatements()

      const parsingIds = uploaded.filter((u) => u.status === 'parsing').map((u) => u.id)
      if (parsingIds.length) {
        setBatch({ done: 0, total: parsingIds.length, phase: 'parsing' })
        for (let i = 0; i < 300; i++) {
          await new Promise((r) => setTimeout(r, 3000))
          const res = await api.get('/statements').catch(() => null)
          const mine = (res?.data?.data || []).filter((s) => parsingIds.includes(s.id))
          const still = mine.filter((s) => s.status === 'parsing')
          setBatch({ done: parsingIds.length - still.length, total: parsingIds.length, phase: 'parsing' })
          if (!still.length) {
            mine.filter((s) => s.status === 'error')
              .forEach((s) => failures.push(`${s.filename}: ${s.error || 'parse failed'}`))
            break
          }
        }
      }

      await fetchStatements()
      // Single successful upload → straight to matching it. Checking `ready`
      // first because a PDF parses in the background, and landing on a statement
      // that is still parsing shows an empty table with no explanation.
      if (uploaded.length === 1 && !failures.length) {
        const d = await api.get(`/statements/${uploaded[0].id}`).catch(() => null)
        if (d?.data?.data?.statement?.status === 'ready') openStatement(uploaded[0].id)
      }
      if (failures.length) setError(`Some uploads failed — ${failures.join(' · ')}`)
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setBatch(null)
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const reparseStatement = async (st) => {
    if (reparsing) return
    if (!window.confirm(
      `Re-parse the ${acctLabel(st.account)} statement "${st.filename}"?\n\n`
      + 'Runs the parser over the original file again and adds any transactions it finds that are missing.\n\n'
      + 'Nothing is deleted or overwritten — existing rows keep their matches and bookings.')) return
    setReparsing(st.id)
    const report = (d) => {
      if (d?.error) { window.alert('Re-parse failed: ' + d.error); return }
      const bits = [
        `${d.added} transaction${d.added === 1 ? '' : 's'} added`,
        `${d.already_present} already present`,
      ]
      if (d.duplicate_of_other_statement) bits.push(`${d.duplicate_of_other_statement} already on another statement`)
      // Reported, never acted on — the parser disagreeing with reconciled
      // history is a question for a human, not grounds to delete anything.
      if (d.only_in_database) bits.push(`${d.only_in_database} in the app but not in this parse — nothing removed`)

      const lines = [
        `Re-parsed ${d.parsed} row${d.parsed === 1 ? '' : 's'}.`, '',
        bits.join('\n'), '',
        `Statement now holds ${d.txn_count}.`,
      ]
      if (d.method === 'rules') {
        lines.push('', "Parsed by rules and checked against the statement's own opening and closing balances and section totals, so this row count is arithmetically confirmed.")
      }

      // A statement holding substantially MORE than the parse accounts for is
      // the opposite problem from a short parse, and it used to be reported as
      // if it were unremarkable — then followed by advice about truncation,
      // which points the wrong way entirely. A doubling signature is what a
      // duplicate import looks like.
      //
      // A small surplus is normal and not worth alarming about: the rules
      // parser ignores rows with no amount ($0.00 lines), so a healthy
      // statement can sit slightly above what it reports.
      const surplus = (d.txn_count || 0) - (d.parsed || 0)
      const doubled = d.parsed > 0 && d.txn_count >= d.parsed * 1.5
      if (doubled) {
        lines.push('', `⚠ This statement holds ${surplus} more rows than the parse found — roughly ${(d.txn_count / d.parsed).toFixed(1)}× as many.`
          + (d.method === 'rules'
            ? " Because the parse balances, the statement itself does not support those extra rows; that is what a duplicate import looks like."
            : '')
          + ' Nothing was removed — worth a look before trusting this month.')
      } else if (d.added === 0) {
        lines.push('', 'Nothing new — the parser produced the same rows as before.'
          + (d.method === 'rules'
            // Truncation is an AI-path failure. Saying it after a
            // balance-verified rule parse would send you to fix a non-problem.
            ? ''
            : ' If you expected more, the PDF may be truncating; upload the CSV export instead.'))
        if (surplus > 0 && d.method === 'rules') {
          // Do NOT explain this away. The first guess was "$0.00 lines the
          // parser skips"; the actual cause on the July statement was 29
          // duplicated $1.00 fee rows from the original import, each matched to
          // its own ledger entry — a real $29 overstatement, not a rounding
          // curiosity. A balanced parse is evidence the app holds rows the
          // statement does not support.
          lines.push(`(${surplus} row${surplus === 1 ? '' : 's'} in the app aren't in this parse. Since the parse balances against the statement's own totals, the statement doesn't support them — most often duplicates from an earlier import. Nothing was removed.)`)
        }
      }
      window.alert(lines.join('\n'))
    }
    try {
      const res = await api.post(`/statements/${st.id}/reparse`)
      const d = res.data.data || {}

      // A PDF re-parse is a Claude call over the whole statement — minutes, not
      // seconds — so the server returns immediately and finishes in the
      // background. Waiting on the request is what produced HTTP 524 (the
      // Cloudflare timeout) while the parse itself was still running fine.
      // Poll the statement until it leaves 'parsing', then read the outcome the
      // background job wrote into import_summary.reparse.
      if (d.started) {
        const deadline = Date.now() + 20 * 60 * 1000 // the server gives up at 25m
        for (;;) {
          await new Promise((r) => setTimeout(r, 5000))
          let row = null
          try {
            const list = await api.get('/statements')
            setStatements(list.data.data || [])
            row = (list.data.data || []).find((x) => x.id === st.id)
          } catch { /* transient — keep polling */ }
          if (row && row.status !== 'parsing') { report(row.import_summary?.reparse); break }
          if (Date.now() > deadline) {
            window.alert('Still parsing. It will finish in the background — reopen Statements in a few minutes to see the result.')
            break
          }
        }
      } else {
        report(d)
      }

      await fetchStatements()
      fetchFlags()
    } catch (err) {
      window.alert('Re-parse failed: ' + (err.response?.data?.error || err.message))
    } finally { setReparsing(null) }
  }

  const deleteStatement = async (st) => {
    if (!window.confirm(`Delete the ${acctLabel(st.account)} statement "${st.filename}"?\n\nIts parsed transactions and matches are removed. Ledger entries are not touched.`)) return
    try {
      await api.delete(`/statements/${st.id}`)
      fetchStatements()
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    }
  }




  if (!isAdminRole) {
    return (
      <div className="p-8 text-center text-gray-500">
      <NextStepPrompt prompt={nextStep} onClose={clearNextStep} />
        <Landmark size={28} className="mx-auto mb-2 text-gray-300" />
        Statements are visible to Admins only.
      </div>
    )
  }



  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto"
      onDragEnter={(e) => { e.preventDefault(); if (!uploading) { dragDepth.current++; setDragOver(true) } }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragOver(false) }}
      onDrop={(e) => {
        e.preventDefault()
        dragDepth.current = 0
        setDragOver(false)
        if (uploading) return
        const fs = [...(e.dataTransfer?.files || [])].filter((f) => /\.(csv|pdf)$/i.test(f.name))
        if (fs.length) handleUpload(fs)
      }}>
      {/* Header: title + flags + compact upload controls. The big drop zone
          is gone — drag files anywhere on the page, or click Upload. */}
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <Landmark size={20} className="text-ink" />
        <h1 className="text-xl font-extrabold text-ink">Statements</h1>
        {/* Review lives on Bank Matching now. Kept here as a link because this
            is where you land after an upload, and the next thing you do is
            match what just arrived. */}
        {statements.some((s) => s.status === 'ready') && (
          <a href="/bk/bank-matching"
            title="Open Bank Matching — review open items, run the deck, or work by vendor"
            className="flex items-center gap-1 text-[11px] font-extrabold px-2 py-1 rounded-full border bg-card text-gray-500 border-rule hover:text-ink">
            <Zap size={11} /> Review &amp; match
          </a>
        )}
        {statements.some((s) => s.status === 'ready') && (
          <button onClick={() => { setBatchView(false); setFlagsView(true) }}
            title="Open the flags review page"
            className={`flex items-center gap-1 text-[11px] font-extrabold px-2 py-1 rounded-full border ${
              flags.length === 0
                ? 'bg-card text-gray-500 border-rule hover:text-ink'
                : flags.some((f) => f.severity === 'error')
                  ? 'bg-rose-50 text-rose-700 border-rose-200'
                  : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
            <Flag size={11} /> {flags.length > 0 ? `${flags.length} flag${flags.length === 1 ? '' : 's'}` : 'Flags'}
          </button>
        )}
        {/* Extra items. Not run on load — it re-downloads and re-parses every
            stored PDF, which is cheap per statement but not free. */}
        {statements.some((s) => s.status === 'ready') && (
          <button onClick={checkExtras} disabled={extrasBusy}
            title="Re-parse every stored statement and compare it with what the app holds. A statement whose balances reconcile proves its own contents, so anything beyond that is wrong."
            className={`flex items-center gap-1 text-[11px] font-extrabold px-2 py-1 rounded-full border disabled:opacity-50 ${
              !extras ? 'bg-card text-gray-500 border-rule hover:text-ink'
                : extras.total_extra > 0 ? 'bg-rose-50 text-rose-700 border-rose-200'
                  : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
            {extrasBusy ? <Loader size={11} className="animate-spin" /> : <Search size={11} />}
            {extrasBusy ? 'Checking…' : !extras ? 'Check for extras'
              : extras.total_extra > 0 ? `${extras.total_extra} to review` : 'No extras'}
          </button>
        )}
        {extras && extras.unverifiable > 0 && extras.total_extra === 0 && (
          <span className="text-[11px] text-gray-400" title="Only statements whose balances reconcile can be checked.">
            {extras.checked} checked · {extras.unverifiable} couldn’t be
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <select value={account} onChange={(e) => setAccount(e.target.value)}
            className="border border-rule rounded-lg px-2.5 py-1.5 text-[13px] bg-card text-ink">
            {ACCOUNTS.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
          </select>
          <button onClick={() => !uploading && fileRef.current?.click()} disabled={uploading}
            className="inline-flex items-center gap-1.5 bg-ink text-card hover:opacity-85 rounded-lg px-3 py-1.5 text-[13px] font-bold disabled:opacity-50"
            title="CSV export (exact) or monthly PDF (AI-parsed). Or drag files anywhere on this page.">
            <Upload size={14} /> Upload
          </button>
        </div>
      </div>
      {!flagsView && !batchView && (
        <p className="text-[13px] text-gray-400 mb-3">Reconcile bank statements against the ledger. Drag files anywhere to upload — CSV (exact) or PDF (AI-parsed), matching runs automatically.</p>
      )}
      <input ref={fileRef} type="file" multiple accept=".csv,.pdf,text/csv,application/pdf" className="hidden"
        onChange={(e) => handleUpload(e.target.files)} />

      {/* Drop target overlay while dragging files over the page */}
      {dragOver && !uploading && (
        <div className="fixed inset-0 z-[85] bg-black/30 flex items-center justify-center pointer-events-none">
          <div className="bg-card border-2 border-dashed border-ink rounded-2xl px-12 py-10 text-center shadow-2xl">
            <Upload size={26} className="mx-auto mb-2 text-ink" />
            <p className="text-sm font-bold text-ink">Drop to upload to {acctLabel(account)}</p>
            <p className="text-xs text-gray-400 mt-1">CSV or PDF, up to 30 MB each</p>
          </div>
        </div>
      )}

      {uploading && (
        <div className="flex items-center gap-2 bg-card border border-rule rounded-lg px-3 py-2 text-[13px] font-semibold text-gray-600 mb-4 mt-2">
          <Loader size={14} className="animate-spin text-gray-400" />
          {batch?.phase === 'parsing'
            ? `AI parsing PDFs — ${batch.done}/${batch.total} done… (5–10 min each; you can leave, the parse finishes server-side)`
            : batch && batch.total > 1
              ? `Uploading ${Math.min(batch.done + 1, batch.total)}/${batch.total}…`
              : 'Parsing statement…'}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg px-3 py-2 text-sm mb-4 mt-2">
          <AlertCircle size={15} /> {error}
          <button onClick={() => setError('')} className="ml-auto text-rose-700 hover:text-rose-900"><X size={14} /></button>
        </div>
      )}

      {/* Focus mode: an open statement replaces the library with a breadcrumb */}

      {/* Global search — finds a transaction in ANY statement and jumps to it */}
      {!flagsView && !batchView && statements.length > 0 && (
        <div className="relative mb-4 max-w-xl">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input value={globalQ} onChange={(e) => onGlobalSearch(e.target.value)}
            placeholder="Search payee, description, email, reference, amount…"
            className="w-full border border-rule rounded-lg pl-9 pr-9 py-1.5 text-[13px] bg-card text-ink" />
          {globalQ && (
            <button onClick={() => { setGlobalQ(''); setGlobalHits(null) }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500"><X size={14} /></button>
          )}
          {globalHits !== null && (
            <div className="absolute z-20 left-0 right-0 mt-1 bg-card border border-rule rounded-xl shadow-lg max-h-96 overflow-y-auto">
              {globalBusy ? (
                <div className="px-4 py-3 text-[13px] text-gray-400">Searching…</div>
              ) : globalHits.length === 0 ? (
                <div className="px-4 py-3 text-[13px] text-gray-400">No transactions match "{globalQ}".</div>
              ) : globalHits.map((h) => (
                <button key={h.id} onClick={() => openHit(h)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left border-b border-divider last:border-0 hover:bg-gray-50">
                  <span className="font-mono text-[11px] text-gray-400 shrink-0">{fmtDate(h.txn_date)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-ink truncate">
                      {h.matched_payee || h.payee_guess || h.description || '(no payee)'}
                    </span>
                    <span className="block text-[11px] text-gray-400 truncate">
                      {h.filename}
                      {h.dismissed ? ' · dismissed' : h.match_method === 'created' ? ' · booked' : h.matched_expense_id ? ' · matched' : h.matched_income_id ? ' · booked income' : ' · open'}
                    </span>
                  </span>
                  <span className={`font-mono text-[13px] font-bold shrink-0 ${h.direction === 'credit' ? 'text-sky-600' : 'text-ink'}`}>
                    {h.direction === 'credit' ? '+' : ''}{fmt(h.amount)}{h.currency !== 'USD' ? ` ${h.currency}` : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Statement library — grouped by account, slim rows, friendly names,
          coverage bars. Hidden entirely while a statement is open. */}
      {!flagsView && !batchView && (loading ? (
        <div className="text-sm text-gray-400 py-8 text-center">Loading…</div>
      ) : statements.length === 0 ? (
        <div className="text-sm text-gray-400 py-10 text-center border border-dashed border-rule rounded-xl">
          No statements yet — drag one anywhere on this page, or click Upload.
        </div>
      ) : (
        <div className="space-y-3 mb-6">
          {/* Review everything at once — same mini-ledger + deck, all statements */}
          {statements.some((s) => s.status === 'ready') && (
            <div
              className="bg-card border border-rule hover:border-gray-300 rounded-xl px-4 py-2.5 cursor-pointer transition"
              onClick={() => openStatement('all')}>
              <div className="flex items-center gap-3">
                <Zap size={16} className="text-gray-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-bold text-ink">All transactions</span>
                  <span className="text-xs text-gray-400 ml-2">review every item across every statement</span>
                </div>
                {/* The page total, reduced over every statement — the same
                    reduction the month subtotals and each statement's own bar
                    below use. It read `debits - matched - dismissed`, which
                    counts a BOOKED row as matched and subtracts a
                    dismissed-after-matching row twice; on a fixture holding one
                    row of every disposition that expression reported 1 open
                    against 3 real. Absent while the figures are unknown rather
                    than zeroed — "0 left" is the one thing a failed request
                    must never say. */}
                {recon && (() => {
                  const all = rollUp(recon, statements.map((x) => x.id))
                  const out = pick(all.debits, [...ACCOUNTED, ...LEFT_KEYS])
                  const left = pick(all.debits, LEFT_KEYS)
                  const unbooked = pick(all.credits, ['open'])
                  return (
                    <span className="text-[12px] text-gray-400 whitespace-nowrap tabular-nums">
                      {fmt(out.value)} out · {coverageOf(all.debits)}% accounted for
                      {left.n > 0 && <> · <span className="font-semibold text-ink">{fmt(left.value)} left</span></>}
                      {unbooked.n > 0 && <> · {unbooked.n} deposit{unbooked.n === 1 ? '' : 's'} unbooked</>}
                    </span>
                  )
                })()}
                {/* Re-running the matcher is matching work — it lives on Bank
                    Matching now, next to the queue it changes. */}
                <a href="/bk/bank-matching" onClick={(e) => e.stopPropagation()}
                  title="Open Bank Matching to review open items or re-run the matcher"
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-gray-400 hover:text-ink border border-rule hover:border-gray-300 rounded-lg px-2 py-1">
                  <Link2 size={12} /> Match
                </a>
              </div>
            </div>
          )}
          {/* Month-first library: ONE list — a row per month, both accounts'
              coverage inline; expanding reveals the statements and the
              reconcile action. SOFT close: changes after a close raise a
              flag, never a lock. */}
          {(() => {
            const stByMonth = new Map()
            const processing = []
            for (const st of statements) {
              const mk = st.period_start ? String(st.period_start).slice(0, 7) : null
              if (!mk) { processing.push(st); continue }
              if (!stByMonth.has(mk)) stByMonth.set(mk, [])
              stByMonth.get(mk).push(st)
            }
            const monthOf = Object.fromEntries(months.map((m) => [m.month_key, m]))
            const keys = [...new Set([...stByMonth.keys(), ...months.map((m) => m.month_key)])]
              .sort((a, b) => b.localeCompare(a))
            const recCount = months.filter((m) => m.reconciled_at).length
            return (
              <>
              {/* ── Is anything missed? ─────────────────────────────────────
                  Two sentences: is every statement that arrived PROVED, and is
                  one outstanding. Both balance checks skip silently when they
                  cannot run, so "no flags" never meant "proved" — this is where
                  that distinction becomes visible. */}
              {integrity && (
                <div className="bg-card border border-rule rounded-xl overflow-hidden mb-3">
                  <div className="flex items-center gap-2 px-4 py-2 border-b border-divider flex-wrap">
                    {integrity.summary.unprovable === 0
                      ? <CheckCircle2 size={14} className="text-emerald-500" />
                      : <AlertCircle size={14} className="text-amber-500" />}
                    <span className="text-sm font-bold text-ink">Is anything missed?</span>
                    <span className="text-xs text-gray-400 tabular-nums">
                      {/* "checked", not "add up": a PayPal statement is proved by
                          its pairing rather than by arithmetic, and calling that
                          "adds up" would overstate it. */}
                      {integrity.summary.proved + integrity.summary.proved_by_chain
                        + (integrity.summary.proved_by_pairing || 0)}/{integrity.summary.total} statements check out
                    </span>
                    {integrity.summary.backfillable > 0 && (
                      <button onClick={backfillOpenings} disabled={backfilling}
                        title="Carry each missing opening balance forward from the previous statement's closing one. No transaction is touched, so nothing you have already matched or dismissed reopens."
                        className="ml-auto text-[11px] font-extrabold px-2 py-1 rounded-full border bg-card text-gray-500 border-rule hover:text-ink disabled:opacity-50">
                        {backfilling ? 'Working…' : `Carry ${integrity.summary.backfillable} opening balance${integrity.summary.backfillable === 1 ? '' : 's'} forward`}
                      </button>
                    )}
                  </div>

                  {/* An account that simply stopped. The gap flag fires BETWEEN
                      two statements, so it can never say this. */}
                  {integrity.accounts.map((a) => (
                    <div key={a.account} className="flex items-center gap-2 px-4 py-1.5 border-b border-divider text-[12.5px] flex-wrap">
                      <span className="font-bold text-ink uppercase text-[11px] w-16">{a.account}</span>
                      {a.overdue ? (
                        <span className="text-rose-600 font-semibold">
                          No statement since {a.last_period_end} — {a.days_since} days, and one was expected by {a.expected_by}
                        </span>
                      ) : (
                        <span className="text-gray-500">
                          Up to date — last period ended {a.last_period_end}
                          {a.days_since != null && ` (${a.days_since} days ago)`}
                          {a.expected_by && `, next expected by ${a.expected_by}`}
                        </span>
                      )}
                    </div>
                  ))}

                  {/* What cannot be proved, and why. Never a bare count: an
                      unchecked statement is not a small problem in proportion
                      to its row count. */}
                  {integrity.summary.unprovable > 0 && (
                    <div className="px-4 py-2 text-[12.5px]">
                      <div className="font-semibold text-amber-700 mb-1">
                        {integrity.summary.unprovable} statement{integrity.summary.unprovable === 1 ? '' : 's'} cannot be
                        proved — {integrity.summary.unprovable_rows} rows,{' '}
                        ${integrity.summary.unprovable_debits.toLocaleString('en-US', { minimumFractionDigits: 2 })} of money out
                      </div>
                      {integrity.statements.filter((x) => x.status === 'unprovable').map((x) => (
                        <div key={x.id} className="flex items-start gap-2 py-0.5 text-gray-500">
                          <span className="font-mono text-[11px] text-gray-400 w-40 shrink-0">
                            {x.account} {x.period_start}
                          </span>
                          <span>{x.reason}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {(integrity.summary.proved_by_pairing || 0) > 0 && (
                    <div className="px-4 py-1.5 text-[11.5px] text-gray-400 border-t border-divider">
                      {integrity.summary.proved_by_pairing} cannot be added up in dollars — foreign rows carry no
                      printed USD amount — but every payment on them matches a funding leg of the same amount and
                      currency, so nothing was dropped on its own. A pair missing on both sides would not show up,
                      and nothing printed on those statements could catch it.
                    </div>
                  )}
                  {integrity.summary.proved_by_chain > 0 && (
                    <div className="px-4 py-1.5 text-[11.5px] text-gray-400 border-t border-divider">
                      {integrity.summary.proved_by_chain} of them add up only against the previous statement's closing
                      balance rather than their own opening one — which a gap in coverage would silently disable.
                      {integrity.summary.backfillable > 0 && ' Carrying the balance forward fixes that.'}
                    </div>
                  )}
                  {integrity.summary.row_count_mismatches > 0 && (
                    <div className="px-4 py-1.5 text-[12px] text-rose-600 border-t border-divider">
                      {integrity.summary.row_count_mismatches} statement{integrity.summary.row_count_mismatches === 1 ? '' : 's'} store
                      fewer rows than the parser reported — rows were lost on import.
                    </div>
                  )}
                </div>
              )}
              <div className="bg-card border border-rule rounded-xl overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2 border-b border-divider">
                  <CheckCircle2 size={14} className={months.length && recCount === months.length ? 'text-emerald-500' : 'text-gray-400'} />
                  <span className="text-sm font-bold text-ink">Statements by month</span>
                  <span className="text-xs text-gray-400 tabular-nums">{recCount}/{months.length || keys.length} reconciled</span>
                </div>
                {processing.map((st) => (
                  <div key={st.id} className="flex items-center gap-3 px-4 py-1.5 border-b border-divider text-[13px]">
                    {st.status === 'error'
                      ? <AlertCircle size={13} className="text-rose-500 shrink-0" />
                      : <Loader size={13} className="animate-spin text-amber-500 shrink-0" />}
                    <span className="font-medium text-ink truncate">{st.filename}</span>
                    {st.status === 'error'
                      ? <span className="text-xs text-rose-600 truncate" title={st.error}>parse failed — {st.error}</span>
                      : <span className="text-xs text-gray-400">AI parsing…</span>}
                    <button onClick={() => deleteStatement(st)} className="ml-auto text-gray-300 hover:text-rose-600 p-1"><Trash2 size={13} /></button>
                  </div>
                ))}
                {keys.map((mk) => {
                  const m = monthOf[mk]
                  const sts = (stByMonth.get(mk) || []).sort((a, b) => a.account.localeCompare(b.account) || a.id - b.id)
                  const [y, mo] = mk.split('-')
                  const label = `${MONTH_FULL[Number(mo) - 1]} ${y}`
                  const missing = m ? ['bofa', 'paypal'].filter((a) => !m.accounts.includes(a)) : []
                  // The month's figures reduce over the statements RENDERED
                  // BELOW IT — not over a second query. /statements/months
                  // groups by txn_date and this list groups by period_start, so
                  // a second source would let a header disagree with its own
                  // rows for any transaction dated outside its statement's
                  // period. Same set, same number.
                  const mr = recon ? rollUp(recon, sts.map((x) => x.id)) : null
                  const mOut = mr && pick(mr.debits, [...ACCOUNTED, ...LEFT_KEYS])
                  const mLeft = mr && pick(mr.debits, LEFT_KEYS)
                  const mUnbooked = mr && pick(mr.credits, ['open'])
                  // The reconcile gate is UNCHANGED: rows with no ledger entry
                  // at all, which is what m.open_debits has always counted (the
                  // fixture asserts the two still agree per statement). Booked
                  // rows still owed an invoice are shown as work but do not
                  // block a close — tightening that is a policy change, not a
                  // reporting one. Falls back to the old column if the
                  // reconciliation request failed, so a dead request can never
                  // silently lock the button.
                  const openNoEntry = mr ? (mr.debits.open?.n || 0) : (m ? m.open_debits : 0)
                  const ready = m && openNoEntry === 0 && missing.length === 0
                  const expanded = monthExpanded.has(mk)
                  const acctSeen = {}
                  return (
                    <div key={mk} className="border-b border-divider last:border-0">
                      <div role="button" tabIndex={0}
                        onClick={() => setMonthExpanded((prev) => { const n = new Set(prev); n.has(mk) ? n.delete(mk) : n.add(mk); return n })}
                        className="w-full flex items-center gap-3 px-4 py-2 text-left cursor-pointer hover:bg-gray-50/60">
                        {expanded ? <ChevronDown size={14} className="text-gray-400 shrink-0" /> : <ChevronRight size={14} className="text-gray-400 shrink-0" />}
                        <span className="text-[13.5px] font-semibold text-ink w-32 shrink-0">{label}</span>
                        {missing.length > 0 && (
                          <span className="text-[10px] font-bold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5"
                            title={`No ${missing.map(acctLabel).join(' or ')} statement covers this month`}>
                            {missing.map(acctLabel).join(' + ')} missing
                          </span>
                        )}
                        {sts.some((s) => s.overlaps_with) && (
                          <span className="text-[10px] font-bold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5"
                            title="A statement's date range overlaps another — duplicates were skipped on upload, but double-check coverage.">
                            overlaps
                          </span>
                        )}
                        <span className="flex-1" />
                        {/* Money, then how much of it is answered. The bar was
                            /statements/months' coverage — (matched + dismissed)
                            / debits — which counts a booked row as matched and
                            so reported a month nearly clear while Bank Matching,
                            one click away, held hundreds of rows of work on the
                            same statements. Measured on a fixture: 86% against
                            a true 50%. */}
                        {mr && (
                          <>
                            <span className="text-[12px] text-gray-400 w-24 text-right tabular-nums shrink-0 hidden lg:block">{fmt(mOut.value)}</span>
                            <span className="w-28 h-1 rounded-full bg-gray-100 overflow-hidden shrink-0 hidden sm:block">
                              <span className={`block h-full rounded-full ${covTone(coverageOf(mr.debits))}`} style={{ width: `${coverageOf(mr.debits)}%` }} />
                            </span>
                            <span className="text-[12px] font-semibold text-ink w-10 text-right tabular-nums shrink-0">{coverageOf(mr.debits)}%</span>
                            <span className={`text-[12px] w-24 text-right tabular-nums shrink-0 ${mLeft.n > 0 ? 'text-gray-400' : 'text-emerald-600'}`}
                              title={mLeft.n > 0 ? `${mLeft.n} line${mLeft.n === 1 ? '' : 's'} still to answer${mUnbooked.n ? `, and ${mUnbooked.n} deposit${mUnbooked.n === 1 ? '' : 's'} to book` : ''}` : 'Every line on these statements is accounted for'}>
                              {mLeft.n > 0 ? `${fmt(mLeft.value)} left` : mUnbooked.n > 0 ? `${mUnbooked.n} to book` : 'clear'}
                            </span>
                          </>
                        )}
                        <span className="w-44 text-right shrink-0 hidden md:block">
                          {m?.reconciled_at ? (
                            <span className="inline-flex items-center gap-1">
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700"
                                title={`Reconciled by ${m.reconciled_by} on ${fmtDate(m.reconciled_at)}`}>
                                <CheckCircle2 size={12} /> Reconciled
                              </span>
                              <button onClick={(e) => { e.stopPropagation(); reconcileMonth(mk, true) }} title="Un-reconcile this month"
                                className="text-gray-300 hover:text-rose-600 p-0.5"><X size={11} /></button>
                            </span>
                          ) : ready ? (
                            <button onClick={(e) => { e.stopPropagation(); reconcileMonth(mk, false) }}
                              className="text-[11px] font-bold px-2 py-1 rounded border text-emerald-700 border-emerald-300 hover:bg-emerald-50">
                              Mark reconciled
                            </button>
                          ) : null}
                        </span>
                      </div>
                      {expanded && sts.map((st) => {
                        acctSeen[st.account] = (acctSeen[st.account] || 0) + 1
                        const copyN = acctSeen[st.account]
                        const dupCount = sts.filter((s) => s.account === st.account).length
                        // This statement's own slice of the same roll-up the
                        // month header above reduces over. `st.matched/st.debits`
                        // is gone from the row: matched_expense_id is set on a
                        // booked row too, so the fraction counted an invented
                        // entry as a settled invoice.
                        const sr = recon ? rollUp(recon, [st.id]) : null
                        const sOut = sr && pick(sr.debits, [...ACCOUNTED, ...LEFT_KEYS])
                        const sLeft = sr && pick(sr.debits, LEFT_KEYS)
                        const pct = sr ? coverageOf(sr.debits) : 0
                        const showBreakdown = stmtExpanded.has(st.id)
                        return (
                          <Fragment key={st.id}>
                          <div
                            className={`flex items-center gap-3 pl-11 pr-4 py-1.5 border-t border-divider group text-[13px] ${st.status === 'parsing' ? 'opacity-70' : 'cursor-pointer hover:bg-gray-50/60'}`}
                            onClick={() => { if (st.status !== 'parsing') openStatement(st.id) }}>
                            {/* The disclosure replaces the decorative dot rather
                                than sitting beside it — a second affordance in
                                the same 8px would be two controls where the eye
                                expects one. Clicking the ROW still opens the
                                statement in Bank Matching; only this toggles. */}
                            {sr && st.status === 'ready' ? (
                              <button
                                onClick={(e) => { e.stopPropagation(); setStmtExpanded((prev) => { const n = new Set(prev); n.has(st.id) ? n.delete(st.id) : n.add(st.id); return n }) }}
                                title={showBreakdown ? 'Hide what this statement has answered' : 'Show what this statement has answered'}
                                className="shrink-0 -my-1 p-1 text-gray-300 hover:text-ink">
                                {showBreakdown ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                              </button>
                            ) : (
                              <span className="w-2 h-2 rounded-full shrink-0 bg-gray-300" />
                            )}
                            <span className="text-[12.5px] font-medium text-ink w-32 shrink-0 truncate" title={st.filename}>
                              {acctLabel(st.account)}{dupCount > 1 ? ` · copy ${copyN}` : ''}
                            </span>
                            {st.status === 'parsing' ? (
                              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-600"><Loader size={12} className="animate-spin" /> AI parsing…</span>
                            ) : st.status === 'error' ? (
                              <span className="text-xs font-semibold text-rose-600 truncate" title={st.error}>parse failed — {st.error}</span>
                            ) : (
                              <>
                                <span className="text-[12px] text-gray-400 w-44 shrink-0 hidden sm:inline tabular-nums">{fmtDate(st.period_start)} – {fmtDate(st.period_end)}</span>
                                {sr && (
                                  <>
                                    <span className="text-[12px] text-gray-400 w-24 text-right tabular-nums shrink-0 hidden lg:inline">{fmt(sOut.value)}</span>
                                    <span className="w-24 h-1 rounded-full bg-gray-100 overflow-hidden shrink-0">
                                      <span className={`block h-full rounded-full ${covTone(pct)}`} style={{ width: `${pct}%` }} />
                                    </span>
                                    <span className="text-[12px] font-semibold text-ink w-10 text-right tabular-nums shrink-0">{pct}%</span>
                                    <span className={`text-[12px] w-16 text-right tabular-nums shrink-0 ${sLeft.n > 0 ? 'text-gray-400' : 'text-emerald-600'}`}>
                                      {sLeft.n > 0 ? `${sLeft.n} left` : 'clear'}
                                    </span>
                                  </>
                                )}
                                {/* Red only when the statement's own arithmetic
                                    disagrees with what we hold. "Can't check"
                                    stays grey — it is an absence of evidence,
                                    not a finding. */}
                                {(() => {
                                  const e = extrasFor(st.id)
                                  if (!e) return null
                                  if (!e.reconciles) return (
                                    <span className="text-[11px] text-gray-300 shrink-0" title={e.reason}>not checked</span>
                                  )
                                  // A misfiled row is invisible to the count above by
                                  // construction, so this must be its own indicator — a
                                  // statement can read "✓ matches" and still have $10,000
                                  // filed against a company that was never paid.
                                  const mis = e.misfiled_count > 0 ? (
                                    <button onClick={(ev) => { ev.stopPropagation(); openMisfiled(st.id) }}
                                      title={`${e.misfiled_count} row(s) repeat another payment's reference while a payment the statement charges is missing. The month still reconciles — the money is right and the vendor is wrong.`}
                                      className="text-[11px] font-extrabold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 shrink-0 hover:bg-amber-100">
                                      {e.misfiled_count} misfiled · {fmt(e.misfiled_value)}
                                    </button>
                                  ) : null
                                  if (!e.extraCount) return mis || (
                                    <span className="text-[11px] font-semibold text-emerald-600 shrink-0" title={`All ${e.expected} transactions match the statement's balances.`}>✓ matches</span>
                                  )
                                  // A surplus AND a shortfall together means the rows are
                                  // RELABELLED, not duplicated — the same transaction keyed
                                  // differently on each side. PayPal showed this: the app
                                  // holds every row as USD while the statement names six
                                  // currencies. Amber, and never the word "extra": calling
                                  // it extra invites a deletion that would destroy real
                                  // transactions.
                                  if (e.missingCount > 0) return (
                                    <button onClick={(ev) => { ev.stopPropagation(); setExtrasOpen(extrasOpen === st.id ? null : st.id) }}
                                      title={`The statement proves ${e.expected} transactions and the app holds ${e.held}, but ${e.missingCount} don't line up — recorded under different details, commonly the wrong currency. Not duplicates; re-parsing corrects them.`}
                                      className="text-[11px] font-extrabold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 shrink-0 hover:bg-amber-100">
                                      {e.missingCount} mismatched
                                    </button>
                                  )
                                  return (
                                    <button onClick={(ev) => { ev.stopPropagation(); setExtrasOpen(extrasOpen === st.id ? null : st.id) }}
                                      title={`The statement's balances prove ${e.expected} transactions; the app holds ${e.held}.`}
                                      className="text-[11px] font-extrabold px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 shrink-0 hover:bg-rose-100">
                                      {e.extraCount} extra · {fmt(e.extraValue)}
                                    </button>
                                  )
                                })()}
                              </>
                            )}
                            <span className="ml-auto flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                              {st.r2_key && (
                                <button onClick={(e) => { e.stopPropagation(); viewStmtFile(st.id) }} title="View the original statement file"
                                  className="text-gray-300 hover:text-ink p-1"><FileText size={14} /></button>
                              )}
                              {/* Re-parse the stored original and add anything the
                                  first pass missed. Additive only — see the
                                  endpoint comment. Needs the file, so it's hidden
                                  when nothing was stored. */}
                              {st.r2_key && st.status !== 'parsing' && (
                                <button onClick={(e) => { e.stopPropagation(); reparseStatement(st) }}
                                  disabled={reparsing === st.id}
                                  title="Re-parse the original file and add any transactions the first pass missed. Never deletes or duplicates."
                                  className="text-gray-300 hover:text-boom-600 p-1 disabled:opacity-40">
                                  {reparsing === st.id ? <Loader size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                                </button>
                              )}
                              <button onClick={(e) => { e.stopPropagation(); deleteStatement(st) }}
                                className="text-gray-300 hover:text-rose-600 p-1"><Trash2 size={14} /></button>
                            </span>
                          </div>
                          {/* What this statement has answered, and in what money.
                              Money out and money in are stacked and never
                              summed: a credit matches artist_income, not an
                              invoice, and a statement carrying unbooked deposits
                              is not reconciled — which a debits-only view could
                              not say at all. */}
                          {showBreakdown && sr && (() => {
                            const d = sr.debits
                            const acc = pick(d, ACCOUNTED)
                            const left = pick(d, LEFT_KEYS)
                            const exc = pick(d, ['excluded'])
                            const inn = sr.credits
                            const inTotal = pick(inn, ['booked', 'open', 'excluded'])
                            // Share of money out that is IN SCOPE — excluded rows
                            // are out of the denominator on the bar above, so
                            // they must be out of it here too or the lines and
                            // the bar describe different totals.
                            const scope = acc.value + left.value
                            const share = (v) => (scope > 0 ? Math.round((v / scope) * 1000) / 10 : 0)
                            const link = (f) => `/bk/bank-matching?statement=${st.id}&filter=${f}`
                            const g = (k) => d[k] || { n: 0, value: 0 }
                            const c = (k) => inn[k] || { n: 0, value: 0 }
                            return (
                              <div className="pl-[4.4rem] pr-4 py-2 border-t border-divider bg-gray-50/40" onClick={(ev) => ev.stopPropagation()}>
                                <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-gray-400 pb-1 pr-4">
                                  <span className="flex-1">Money out</span>
                                  <span className="w-12 text-right">lines</span>
                                  <span className="w-28 text-right">{fmt(sOut.value)}</span>
                                  <span className="w-10" /><span className="w-3" />
                                </div>
                                <BucketLine label="Accounted for" n={acc.n} value={acc.value} share={share(acc.value)} strong to={link('categorized')} />
                                <BucketLine label="matched to an invoice" n={g('matched').n} value={g('matched').value} share={share(g('matched').value)} sub />
                                <BucketLine label="creator payments — no invoice exists" n={g('creator').n} value={g('creator').value} share={share(g('creator').value)} sub />
                                <BucketLine label="no invoice due, by rule" n={g('no_invoice_due').n} value={g('no_invoice_due').value} share={share(g('no_invoice_due').value)} sub />
                                <BucketLine label="Left to match" n={left.n} value={left.value} share={share(left.value)} strong to={link('open')} />
                                <BucketLine label="booked, still owed an invoice" n={g('needs_invoice').n} value={g('needs_invoice').value} share={share(g('needs_invoice').value)} sub to={link('needs-invoice')} />
                                <BucketLine label="no ledger entry at all" n={g('open').n} value={g('open').value} share={share(g('open').value)} sub />
                                <BucketLine label="Excluded" n={exc.n} value={exc.value} to={link('dismissed')} />

                                {inTotal.n > 0 && (
                                  <>
                                    <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-gray-400 pt-2 pb-1 pr-4 border-t border-divider mt-1.5">
                                      <span className="flex-1">Money in</span>
                                      <span className="w-12 text-right">lines</span>
                                      <span className="w-28 text-right">{fmt(inTotal.value)}</span>
                                      <span className="w-10" /><span className="w-3" />
                                    </div>
                                    <BucketLine label="Booked to income" n={c('booked').n} value={c('booked').value} strong />
                                    <BucketLine label="Not booked" n={c('open').n} value={c('open').value} strong />
                                    <BucketLine label="Excluded" n={c('excluded').n} value={c('excluded').value} />
                                    {c('open').n > 0 && (
                                      <div className="text-[11px] text-gray-400 pt-1 pr-4">
                                        Money in has no filter of its own on Bank Matching — these are reachable from
                                        its Flagged and Reversals views, or by searching the statement.
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                            )
                          })()}
                          {/* Extra-items review. Shows the statement's own count
                              against ours for every disagreeing group, so the
                              claim can be checked against the PDF before
                              anything is deleted. */}
                          {misfiledOpen === st.id && (() => {
                            const d = misfiled[st.id]
                            if (misfiledBusy === st.id) return (
                              <div className="pl-11 pr-4 py-2 border-t border-divider text-[12px] text-gray-400">Re-reading the statement…</div>
                            )
                            if (!d?.repairs?.length) return null
                            return (
                              <div className="pl-11 pr-4 py-2 border-t border-divider bg-amber-50/30" onClick={(ev) => ev.stopPropagation()}>
                                <div className="text-[12px] text-ink mb-1.5">
                                  These rows repeat another payment’s reference. The statement charges each reference once,
                                  and for every repeat a payment it does charge is missing — so the month still balances
                                  while the money sits under the wrong name.
                                </div>
                                <div className="max-h-64 overflow-y-auto rounded-lg border border-amber-200 bg-card">
                                  <table className="w-full text-[12px]">
                                    <thead className="text-gray-400">
                                      <tr className="border-b border-divider">
                                        <th className="text-left font-semibold px-2 py-1">Date</th>
                                        <th className="text-right font-semibold px-2 py-1">Amount</th>
                                        <th className="text-left font-semibold px-2 py-1">Recorded as</th>
                                        <th className="text-left font-semibold px-2 py-1">Actually</th>
                                        <th className="text-left font-semibold px-2 py-1">Match</th>
                                      </tr>
                                    </thead>
                                    <tbody className="tabular-nums">
                                      {d.repairs.map((r) => (
                                        <tr key={r.txn_id} className="border-b border-divider last:border-0">
                                          <td className="px-2 py-1 text-gray-500">{fmtDate(r.txn_date)}</td>
                                          <td className="px-2 py-1 text-right text-ink">{fmt(r.amount)}</td>
                                          <td className="px-2 py-1 text-gray-500 truncate max-w-[14rem]" title={r.currently_reads}>{r.currently_payee || r.currently_reads}</td>
                                          <td className="px-2 py-1 truncate max-w-[14rem] font-semibold text-ink" title={r.should_read}>
                                            {r.should_payee || r.should_read}
                                            {!r.payee_changes && <span className="ml-1 font-normal text-gray-400">(same vendor — reference only)</span>}
                                          </td>
                                          <td className="px-2 py-1 text-[11px] text-gray-400">
                                            {r.matched_expense_id
                                              ? (r.payee_changes ? `entry ${r.matched_expense_id} — will be released` : `entry ${r.matched_expense_id} — kept`)
                                              : '—'}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                                <div className="flex items-center gap-3 mt-2">
                                  <button onClick={() => repairMisfiled(st)} disabled={misfiledFixing === st.id}
                                    className="flex items-center gap-1.5 text-[12px] font-extrabold px-2.5 py-1 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50">
                                    {misfiledFixing === st.id ? <Loader size={12} className="animate-spin" /> : <Search size={12} />}
                                    Repair {d.repairs.length} row{d.repairs.length === 1 ? '' : 's'}
                                  </button>
                                  {st.r2_key && (
                                    <button onClick={() => viewStmtFile(st.id)} className="text-[12px] text-gray-500 hover:text-ink underline">
                                      Open the statement to check
                                    </button>
                                  )}
                                  {d.unclear?.length > 0 && (
                                    <span className="text-[11px] text-gray-400">
                                      {d.unclear.length} more look wrong but which payment they should be is a guess — left alone.
                                    </span>
                                  )}
                                </div>
                              </div>
                            )
                          })()}
                          {extrasOpen === st.id && (() => {
                            const e = extrasFor(st.id)
                            if (!e?.groups?.length) return null
                            const ledger = [...new Set(e.groups.flatMap((g) => g.matched_expense_ids))]
                            return (
                              <div className="pl-11 pr-4 py-2 border-t border-divider bg-rose-50/30" onClick={(ev) => ev.stopPropagation()}>
                                <div className="text-[12px] text-ink mb-1.5">
                                  This statement’s opening and closing balances prove <b>{e.expected}</b> transactions. The app holds <b>{e.held}</b>.
                                  {' '}The {e.extraCount} extra {e.extraCount === 1 ? 'row' : 'rows'} below {e.extraCount === 1 ? 'is' : 'are'} not supported by the statement.
                                </div>
                                <div className="max-h-64 overflow-y-auto rounded-lg border border-rose-200 bg-card">
                                  <table className="w-full text-[12px]">
                                    <thead className="text-gray-400">
                                      <tr className="border-b border-divider">
                                        <th className="text-left font-semibold px-2 py-1">Date</th>
                                        <th className="text-right font-semibold px-2 py-1">Amount</th>
                                        <th className="text-left font-semibold px-2 py-1">Description</th>
                                        <th className="text-right font-semibold px-2 py-1" title="How many the statement charges">Statement</th>
                                        <th className="text-right font-semibold px-2 py-1" title="How many the app holds">App</th>
                                        <th className="text-right font-semibold px-2 py-1">Extra</th>
                                      </tr>
                                    </thead>
                                    <tbody className="tabular-nums">
                                      {e.groups.map((g, i) => (
                                        <tr key={i} className="border-b border-divider last:border-0">
                                          <td className="px-2 py-1 text-gray-500">{fmtDate(g.txn_date)}</td>
                                          <td className="px-2 py-1 text-right text-ink">{fmt(g.amount)}</td>
                                          <td className="px-2 py-1 text-gray-500 truncate max-w-[22rem]" title={g.description}>{g.payee_guess || g.description}</td>
                                          <td className="px-2 py-1 text-right text-gray-500">{g.expected}</td>
                                          <td className="px-2 py-1 text-right text-gray-500">{g.held}</td>
                                          <td className="px-2 py-1 text-right font-extrabold text-rose-700">{g.extra}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                                <div className="flex items-center gap-3 mt-2">
                                  <button onClick={() => removeExtras(st)} disabled={extrasRemoving === st.id}
                                    className="flex items-center gap-1.5 text-[12px] font-extrabold px-2.5 py-1 rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50">
                                    {extrasRemoving === st.id ? <Loader size={12} className="animate-spin" /> : <Trash2 size={12} />}
                                    Remove {e.extraCount} extra · {fmt(e.extraValue)}
                                  </button>
                                  {st.r2_key && (
                                    <button onClick={() => viewStmtFile(st.id)} className="text-[12px] text-gray-500 hover:text-ink underline">
                                      Open the statement to check
                                    </button>
                                  )}
                                  {ledger.length > 0 && (
                                    <span className="text-[11px] text-gray-400">
                                      {ledger.length} ledger entr{ledger.length === 1 ? 'y' : 'ies'} will lose a bank match — nothing in the ledger is deleted.
                                    </span>
                                  )}
                                </div>
                              </div>
                            )
                          })()}
                        </Fragment>
                        )
                      })}
                      {expanded && m && !m.reconciled_at && !ready && (
                        <div className="pl-11 pr-4 pb-2 text-[11px] text-gray-400">
                          {/* Names the gate's OWN condition, which is narrower
                              than the "left" figure in the header above. Saying
                              "N left" here would promise that clearing the
                              needs-invoice pile unlocks the button, and it does
                              not. */}
                          Reconcile unlocks when {[openNoEntry > 0 ? `${openNoEntry} line${openNoEntry === 1 ? '' : 's'} with no ledger entry ${openNoEntry === 1 ? 'is' : 'are'} resolved` : '', missing.length ? `the ${missing.map(acctLabel).join(' + ')} statement is uploaded` : ''].filter(Boolean).join(' and ')}.
                          {mr && pick(mr.debits, ['needs_invoice']).n > 0 && (
                            <> {' '}The {pick(mr.debits, ['needs_invoice']).n} booked line{pick(mr.debits, ['needs_invoice']).n === 1 ? '' : 's'} still owed an invoice {pick(mr.debits, ['needs_invoice']).n === 1 ? 'does' : 'do'} not block it.</>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              </>
            )
          })()}
        </div>
      ))}

      {/* Detail — the statement as a mini-ledger: one table, every debit a
          row with a disposition; buckets became filter chips. Categorizing an
          open row books it into the master ledger immediately (single source
          of truth — the statement view is ledger-shaped, the data isn't). */}

      {/* Flags subpage — cross-statement integrity checks: balance continuity,
          missing months, duplicate rows, suspect matches, broken ledger links.
          Every flag is a worklist item: jump to it, fix it in one click,
          or acknowledge it as known-fine. Opened via the header chip;
          replaces the library like statement focus mode does. */}
      {flagsView && (
        <>
        <div className="flex items-center gap-2 mb-4 mt-2">
          <button onClick={() => setFlagsView(false)}
            className="inline-flex items-center gap-1 text-[13px] font-semibold text-gray-500 hover:text-ink border border-rule rounded-lg px-2.5 py-1.5">
            <ChevronRight size={14} className="rotate-180" /> Statements
          </button>
          <span className="text-sm font-extrabold text-ink">Flags — potential errors</span>
        </div>
        <div className="bg-card border border-rule rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5">
            <Flag size={14} className={flags.length ? 'text-rose-500' : 'text-gray-400'} />
            <span className="text-sm font-bold text-gray-500">
              {flags.length === 0 ? 'All clear' : `${flags.length} open flag${flags.length === 1 ? '' : 's'}`}
            </span>
            {flags.length > 0 && (
              <span className="text-[11px] font-extrabold px-1.5 py-0.5 rounded bg-rose-50 text-rose-700">{flags.length}</span>
            )}
            {flags.length > 0 && (
              <ListSearch
                value={flagSearch}
                onChange={setFlagSearch}
                placeholder="Filter flags — payee, amount, check type…"
                count={flagsShown.length}
                total={flags.length}
                className="ml-3"
                width={280}
              />
            )}
            <button onClick={fetchFlags} disabled={flagsLoading} title="Re-run checks"
              className="ml-auto text-gray-300 hover:text-gray-500 p-1">
              <RefreshCw size={13} className={flagsLoading ? 'animate-spin' : ''} />
            </button>
          </div>
          {flags.length === 0 ? (
            <div className="px-4 pb-3 text-[13px] text-gray-400">
              {flagsLoading ? 'Checking…' : 'No issues detected — balances reconcile, no duplicates, matches look consistent.'}
            </div>
          ) : (() => {
            // Grouped by check type — 60 similar findings read as one
            // worklist section with a count, not a wall.
            const LABELS = {
              'booked-duplicate': 'Booked duplicates of existing invoices',
              'stolen-match': 'Invoices held by the wrong payment',
              'name-disagreement': 'Nothing links the payment to the invoice',
              'lesson-disagreement': 'Learned links that name somebody else',
              'vendor-link': 'Bank payees that are an existing vendor',
              'no-document-match': 'Matched to an expense with no document',
              'paid-no-match': 'Paid on the ledger, no bank match',
              'suspect-currency': 'Probably the wrong currency',
              'double-funding': 'Counted twice — PayPal funding pairs',
              'reversal-still-matched': 'Reversed but still matched',
              'reversal-booked-income': 'Reversals/refunds booked as income',
              'reversal-pair': 'Reversed / refunded payments',
              'amount-drift': 'Matched amounts disagree',
              'date-drift': 'Matched dates far apart',
              'currency-mismatch': 'Currency mismatch on a match',
              'broken-link': 'Broken ledger links',
              'duplicate-rows': 'Possible duplicate rows',
              'balance-gap': 'Balance continuity',
              'missing-month': 'Missing statements',
              'no-paypal-statement': 'PayPal statement missing',
              'stale-coverage': 'Low coverage',
              'reopened-month': 'Reconciled month changed',
              'round-trip': 'Money round-trips',
            }
            // Filter matched nothing: say so, rather than rendering a header
            // with no sections under it, which reads as "all clear".
            if (flagsShown.length === 0) {
              return (
                <div className="px-4 pb-4 pt-1">
                  <p className="text-[13px] text-gray-500">No flags match “{flagSearch}”.</p>
                  <button onClick={() => setFlagSearch('')}
                    className="mt-1 text-[12px] font-bold text-boom-600 hover:text-boom-700">Clear filter</button>
                </div>
              )
            }
            const byType = new Map()
            for (const f of flagsShown) { if (!byType.has(f.type)) byType.set(f.type, []); byType.get(f.type).push(f) }
            const sections = [...byType.entries()].sort((a, b) => {
              const errA = a[1].some((f) => f.severity === 'error') ? 0 : 1
              const errB = b[1].some((f) => f.severity === 'error') ? 0 : 1
              return errA - errB || b[1].length - a[1].length
            })
            const flagRow = (f) => (
              <div key={f.fingerprint} className="flex items-start gap-3 px-4 py-2 border-t border-divider">
                {f.severity === 'error'
                  ? <AlertCircle size={14} className="text-rose-500 mt-0.5 shrink-0" />
                  : <AlertTriangle size={14} className="text-amber-500 mt-0.5 shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className={`text-[13px] font-semibold ${f.severity === 'error' ? 'text-rose-700' : 'text-amber-700'}`}>{f.title}</div>
                  <div className="text-[12px] text-gray-500 mt-0.5">{f.detail}</div>
                  {f.descriptor && (
                    <div className="text-[11px] text-gray-400 mt-1 font-mono break-all"
                      title="What the bank actually printed — the payee column is only a guess at this">
                      {f.descriptor}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {f.ledger_id && (
                    <a href={`/bk/ledger?focus=${f.ledger_id}`}
                      className="text-[11px] font-bold text-gray-500 hover:text-ink px-2 py-1 rounded border border-rule hover:border-gray-300">
                      ledger →
                    </a>
                  )}
                  {f.statement_id && (
                    <button onClick={() => openFlag(f)}
                      className="text-[11px] font-bold text-gray-500 hover:text-ink px-2 py-1 rounded border border-rule hover:border-gray-300">
                      View
                    </button>
                  )}
                  {f.action?.kind === 'unmatch' && (
                    <button onClick={() => flagAction(f)}
                      className="text-[11px] font-bold text-gray-500 hover:text-rose-600 px-2 py-1 rounded border border-rule">
                      Unmatch
                    </button>
                  )}
                  {f.action?.kind === 'dismiss-pair' && (
                    <button onClick={() => flagAction(f)}
                      className="text-[11px] font-bold text-gray-500 hover:text-rose-600 px-2 py-1 rounded border border-rule">
                      Dismiss both
                    </button>
                  )}
                  {f.action?.kind === 'unbook-income' && (
                    <button onClick={() => flagAction(f)}
                      className="text-[11px] font-bold text-gray-500 hover:text-rose-600 px-2 py-1 rounded border border-rule">
                      Unbook
                    </button>
                  )}
                  {f.action?.kind === 'mark-unpaid' && (
                    <button onClick={() => flagAction(f)} title="The bank never shows this payment because it didn't happen — set the ledger back to Unpaid"
                      className="text-[11px] font-bold text-gray-500 hover:text-rose-600 px-2 py-1 rounded border border-rule">
                      Mark unpaid
                    </button>
                  )}
                  {f.action?.kind === 'unbook-rematch' && (
                    <button onClick={() => flagAction(f)} title="Remove the booked copy and match the bank debit to the original invoice"
                      className="text-[11px] font-bold text-emerald-700 hover:text-emerald-800 px-2 py-1 rounded border border-emerald-300 hover:bg-emerald-50">
                      Fix — match original
                    </button>
                  )}
                  {f.action?.kind === 'relink' && (
                    <button onClick={() => flagAction(f)}
                      title={`Repoint the learned link${(f.action.bank_payees || []).length > 1 ? `s (${f.action.bank_payees.length})` : ''} at ${f.action.ledger_payee}`}
                      className="text-[11px] font-bold text-emerald-700 hover:text-emerald-800 px-2 py-1 rounded border border-emerald-300 hover:bg-emerald-50">
                      Point at {f.action.ledger_payee}
                    </button>
                  )}
                  {f.alt_action?.kind === 'alias' && (
                    <button onClick={() => aliasAction(f)}
                      title={`Same vendor, different spelling — record "${f.alt_action.bank_payee}" as another name for ${f.alt_action.ledger_payee} and keep the match`}
                      className="text-[11px] font-bold text-emerald-700 hover:text-emerald-800 px-2 py-1 rounded border border-emerald-300 hover:bg-emerald-50">
                      Same vendor
                    </button>
                  )}
                  <button onClick={() => ackFlag(f)} title="Acknowledge — this is fine, stop flagging it"
                    className="text-[11px] font-bold text-gray-400 hover:text-gray-600 px-2 py-1 rounded border border-rule">
                    OK
                  </button>
                </div>
              </div>
            )
            return sections.map(([type, list]) => {
              const hasError = list.some((f) => f.severity === 'error')
              const open = flagSecToggles[type] ?? (hasError || list.length <= 6)
              return (
                <div key={type}>
                  <button onClick={() => setFlagSecToggles((prev) => ({ ...prev, [type]: !open }))}
                    className="w-full flex items-center gap-2 px-4 py-2 border-t border-rule bg-gray-50/50 text-left">
                    {open ? <ChevronDown size={13} className="text-gray-400 shrink-0" /> : <ChevronRight size={13} className="text-gray-400 shrink-0" />}
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${hasError ? 'bg-rose-500' : 'bg-amber-400'}`} />
                    <span className="text-[12.5px] font-bold text-ink">{LABELS[type] || type}</span>
                    <span className="text-[11px] font-extrabold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 tabular-nums">{list.length}</span>
                  </button>
                  {open && list.map(flagRow)}
                </div>
              )
            })
          })()}
          {ackedFlags.length > 0 && (
            <>
              <button onClick={() => setShowAcked(!showAcked)}
                className="w-full flex items-center gap-2 px-4 py-2 border-t border-divider text-[12px] text-gray-400 hover:text-gray-500">
                {showAcked ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {ackedFlags.length} acknowledged
              </button>
              {showAcked && ackedFlags.map((f) => (
                <div key={f.fingerprint} className="flex items-start gap-3 px-4 py-2.5 border-t border-divider opacity-50">
                  <CheckCircle2 size={14} className="text-gray-400 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-gray-500">{f.title}</div>
                    <div className="text-[12px] text-gray-400 mt-0.5">{f.detail}</div>
                  </div>
                  <button onClick={() => unackFlag(f)}
                    className="text-[11px] font-bold text-gray-400 hover:text-gray-600 px-2 py-1 rounded border border-rule shrink-0">
                    Un-ignore
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
        </>
      )}

      {/* Batch review — every open debit across every statement, grouped by
          vendor. Each row is pre-checked with a proposal (match when a live
          suggestion clears 70%, else book-as-category); uncheck outliers,
          one Apply per group. Select-all-WITH-review: every row still
          passes the operator's eyes. */}

      {/* Reminders — recurring nudges (bell + email). Managed here because
          "upload the statement and match it" is the flagship use. */}
      {!flagsView && !batchView && (
      <div className="bg-card border border-rule rounded-xl overflow-hidden mt-5">
        <button onClick={() => setRemindersOpen(!remindersOpen)} className="w-full flex items-center gap-2 px-4 py-2 text-left">
          <Clock size={14} className="text-gray-400" />
          <span className="text-sm font-bold text-gray-500">Reminders{reminders.length > 0 ? ` — ${reminders.length}` : ''}</span>
          <span className="text-xs text-gray-400">delivered to your notification bell and email when due</span>
          {remindersOpen ? <ChevronDown size={14} className="ml-auto text-gray-400" /> : <ChevronRight size={14} className="ml-auto text-gray-400" />}
        </button>
        {remindersOpen && reminders.map((r) => (
          <div key={r.id} className={`flex items-center gap-3 px-4 py-2 border-t border-divider text-[13px] ${r.active ? '' : 'opacity-50'}`}>
            <span className="font-semibold text-ink min-w-0 flex-1 truncate">{r.title}</span>
            <span className="text-[11px] text-gray-400 whitespace-nowrap">
              {r.cadence === 'monthly' ? `monthly · day ${r.day_of_month}` : r.cadence} · next {fmtDate(r.next_due)}
            </span>
            <button onClick={() => toggleReminder(r)}
              className={`text-[11px] font-bold px-2 py-1 rounded border ${r.active ? 'text-emerald-700 border-emerald-200 bg-emerald-50' : 'text-gray-400 border-rule'}`}>
              {r.active ? 'On' : 'Off'}
            </button>
            <button onClick={() => deleteReminder(r)} className="text-gray-300 hover:text-rose-600 p-1"><Trash2 size={13} /></button>
          </div>
        ))}
        {remindersOpen && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-divider">
          {reminders.length === 0 && (
            <button onClick={() => addReminder('Upload bank statements & re-run matching', 5)} disabled={reminderBusy}
              className="inline-flex items-center gap-1.5 text-[12px] font-bold text-gray-600 border border-rule rounded-lg px-3 py-1.5 hover:text-ink hover:border-gray-300">
              <Plus size={13} /> Monthly statement reminder (day 5)
            </button>
          )}
          <input value={reminderTitle} onChange={(e) => setReminderTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addReminder(reminderTitle, reminderDay)}
            placeholder="Custom reminder…"
            className="flex-1 min-w-[180px] border border-rule rounded-lg px-3 py-1.5 text-[13px] bg-card text-ink" />
          <label className="flex items-center gap-1 text-[12px] text-gray-500">
            monthly on day
            <input type="number" min="1" max="31" value={reminderDay}
              onChange={(e) => setReminderDay(Math.min(31, Math.max(1, Number(e.target.value) || 1)))}
              className="w-14 border border-rule rounded-lg px-2 py-1.5 text-[13px] bg-card text-ink" />
          </label>
          <button onClick={() => addReminder(reminderTitle, reminderDay)} disabled={reminderBusy || !reminderTitle.trim()}
            className="inline-flex items-center gap-1 bg-ink text-card hover:opacity-85 rounded-lg px-3 py-1.5 text-[12px] font-bold disabled:opacity-40">
            <Plus size={13} /> Add
          </button>
        </div>
        )}
      </div>
      )}
    </div>
  )
}
