import { useState, useEffect, useMemo, useRef, Fragment } from 'react'
import { Loader, AlertCircle, Search, Redo2, ChevronsUpDown, Download, ExternalLink, FileText, ChevronDown, ChevronLeft, ChevronRight, Upload, CheckCircle2, Send, CalendarDays, Undo2, Pencil, Save, X, Trash2, Sheet, Mail, Receipt, Plus, Zap, Pause, Scissors } from 'lucide-react'
import api from '../api'
import usePageShortcuts from '../hooks/usePageShortcuts'
import useListKeys, { focusFilter } from '../hooks/useListKeys'
import { useShortcuts } from '../context/ShortcutsContext'
import { useToast } from '../context/ToastContext'
import FilePreview from '../components/FilePreview'
// The one split dialog, shared with the Ledger so the two pages cannot disagree
// about what a split is — see components/SplitInvoiceModal.jsx.
import SplitInvoiceModal from '../components/SplitInvoiceModal'
import BankEvidenceDot from '../components/BankEvidenceDot'
import CcChipInput from '../components/CcChipInput'
import EmailPreviewModal from '../components/EmailPreviewModal'
import getDarkColors from '../utils/darkColors'
import { useTheme } from '../context/ThemeContext'
import { PAYMENT_METHODS as CANONICAL_PAYMENT_METHODS } from '../constants'
import { useCategories } from '../context/CategoriesContext'
import { useBoomReps } from '../context/BoomRepsContext'
import { useAuth } from '../context/AuthContext'
import PaymentDetailPanel from '../components/PaymentDetailPanel'
import useUndoStack from '../hooks/useUndoStack'

// The ledger fields the detail panel lets you edit. A SUBSET of the `allowed`
// list on PUT /bk/entries/:id, deliberately — everything the VENDOR submitted
// stays read-only there (it records what somebody stated when asking to be
// paid), and the bank columns are mirrored in an encrypted profile this page
// has no write path to, so an editable cell would let the two disagree with
// nothing to say which is true.
const PANEL_EDITABLE = [
  'category', 'artist', 'song', 'invoice_number',
  'payment_terms', 'payment_method', 'boom_rep', 'notes',
]
import { useFxRates } from '../context/FxRatesContext'
import { usdSuffixForEntry, usdItemsSuffix, fmtUsdItems, toUsd, entryToUsd, parseAmountQuery, isPastLocal, daysUntilLocal } from '../utils'
import useIsMobile from '../hooks/useIsMobile'
import PaymentCard from '../components/mobile/PaymentCard'
import PaymentSheet from '../components/mobile/PaymentSheet'
import FilterSheet, { FilterField } from '../components/mobile/FilterSheet'
import EmptyState from '../components/EmptyState'
import NextStepPrompt, { useNextStep } from '../components/NextStepPrompt'
import { Link } from 'react-router-dom'

const RED = '#334155'
const GREEN = '#16a34a'
// Payment Dashboard adds an "Other" bucket for legacy/manual entries — keep
// it page-local so the canonical list stays in sync with the AI prompts.
const PAYMENT_METHODS = [...CANONICAL_PAYMENT_METHODS, 'Other']
// 'Group by Vendor' is offered, never forced: John pays some vendors as one
// batched transfer and others invoice-by-invoice, so the grouping is a way to
// READ the queue, not a claim about how the money leaves.
const GROUP_OPTIONS = ['Group by Vendor', 'Group by Method', 'Group by Status', 'No grouping']
// Page scope: unpaid + paid-in-last-14-days (enforced server-side).
// The `Paid` chip here filters the already-scoped list to just the recent
// paid subset — useful for confirmation-email follow-up.
// 'Multi-invoice' sits before the two terminal states so the workflow filters
// stay together.
//
// There was a 'No bank match' chip here — a reconciliation WORKLIST (paid rows
// with no matching bank transaction), and the only filter that had to refetch
// because it opted out of this page's 14-day scope server-side. Removed: this
// page answers "who do we pay next", and a task queue for a different job made
// its own scope conditional. Reconciliation belongs on Statements / Flags.
//
// The per-row BankEvidenceDot stays. It is context on a row you are already
// reading ("this payment is matched to the bank"), not a queue to work, and it
// needs no filter to be useful. `/bk/payments?bank=unverified` is retained
// server-side with no caller — that query is what the parked "paid with no bank
// evidence" worklist will need when it lands on Flags.
const QUICK_FILTERS = ['All', 'Unpaid', 'Due Soon', 'Overdue', 'Rush', 'Hold', 'Multi-invoice', 'Paid']
// Desktop splits that one control across two widgets: five of those values are
// SCOPE and are carried by the stat cards, which were previously inert numbers
// sitting under chips that repeated them. These three are workflow states with
// no card, so they stay chips. Mobile keeps the flat QUICK_FILTERS row — it has
// no stat cards to hang the other five on.
const WORKFLOW_FILTERS = ['Rush', 'Hold', 'Multi-invoice', 'Blocked']

// Why an unpaid invoice cannot be finished right now. Returns the reasons, so
// the chip can count them and the row can say WHICH — "blocked" with no reason
// is a worklist you have to open every row of.
//
// Deliberately NOT included: missing bank details (payment_last4 /
// paypal_handle / payment_snapshot). Those columns are only populated by the
// vendor portal, so on the live queue 133 of 161 open rows have none — that
// flags "did not come through the portal", not "cannot be paid", and a chip
// carrying 83% of the queue is the rush flag's problem all over again.
// The two below are 17 rows, and every one of them is a real stop.
function blockedReasons(entry) {
  if (entry.payment_status === 'Paid') return []
  const out = []
  // Can't decide how to send it.
  if (!entry.payment_method) out.push('no payment method')
  // Can be paid, but the confirmation has nowhere to go.
  if (!entry.vendor_email) out.push('no vendor email')
  return out
}
// 'Amount: high to low' / 'low to high' use a family-aware USD-equivalent
// comparator (see `sortableUsd` in the filtered useMemo below). Raw-amount
// sorting was confusing in two ways: a €1,000 row would beat a $5,000 row
// because the numeric value was bigger; and a $10k invoice split into 4
// children would sort by the parent's leftover portion rather than the
// family total. The helper converts via fx_rate_to_usd (or live rate)
// against family_amount before comparing.
const SORT_OPTIONS = ['Priority', 'Due Date', 'Amount: high to low', 'Amount: low to high', 'Payee A-Z', 'Date Added', 'Recently Paid']

const PAID_BADGE = {
  Paid:    { bg: '#d1fae5', color: '#065f46' },
  Unpaid:  { bg: '#fee2e2', color: '#991b1b' },
  Partial: { bg: '#fef9c3', color: '#92400e' },
}
const METHOD_BADGE = {
  Wire:          { bg: '#dbeafe', color: '#1e40af' },
  ACH:           { bg: '#fef3c7', color: '#92400e' },
  PayPal:        { bg: '#e0e7ff', color: '#3730a3' },
  Check:         { bg: '#f3e8ff', color: '#6b21a8' },
  'Credit Card': { bg: '#fce7f3', color: '#9d174d' },
  Cash:          { bg: '#d1fae5', color: '#065f46' },
}
const badgeBase = { display: 'inline-flex', alignItems: 'center', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }

function fmt(v, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(v || 0)
}
// Group amounts by currency so a €1000 entry isn't silently summed into a USD
// total. Returns a map of { currency: amount }.
function groupByCurrency(entries) {
  const map = {}
  for (const e of entries) {
    const cur = (e.currency || 'USD').toUpperCase()
    map[cur] = (map[cur] || 0) + parseFloat(e.amount || 0)
  }
  return map
}
// Family-aware total: dedupes by family root and uses `family_amount` so
// selecting the parent of a split invoice counts the full billed amount,
// not just the parent's share. Selecting both parent and child of the same
// family counts it once. Falls back to bare amount when family_amount isn't
// present (e.g. non-split rows, or older API responses).
function groupByCurrencyByFamily(entries) {
  const seen = new Set()
  const map = {}
  for (const e of entries) {
    const familyKey = e.parent_id != null ? e.parent_id : e.id
    if (seen.has(familyKey)) continue
    seen.add(familyKey)
    const cur = (e.currency || 'USD').toUpperCase()
    const amt = parseFloat(e.family_amount ?? e.amount ?? 0)
    map[cur] = (map[cur] || 0) + (Number.isFinite(amt) ? amt : 0)
  }
  return map
}

// Family-deduplicated USD-equivalent sum honoring per-row locked rates.
// Mirrors groupByCurrencyByFamily's dedup so the selection / filtered-unpaid
// rollups don't double-count split children. Returns null when nothing could
// be converted (callers hide the line).
function familyUsdSuffix(entries, rates, opts = {}) {
  if (!entries || !entries.length) return ''
  const seen = new Set()
  let total = 0, anyConverted = false, hasNonUsd = false
  for (const e of entries) {
    const familyKey = e.parent_id != null ? e.parent_id : e.id
    if (seen.has(familyKey)) continue
    seen.add(familyKey)
    if ((e.currency || 'USD').toUpperCase() !== 'USD') hasNonUsd = true
    const amt = parseFloat(e.family_amount ?? e.amount ?? 0)
    const v = toUsd(amt, e.currency, rates, e.fx_rate_to_usd)
    if (v != null) { total += v; anyConverted = true }
  }
  if (!hasNonUsd || !anyConverted) return ''
  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: opts.precise ? 2 : 0,
    maximumFractionDigits: opts.precise ? 2 : 0,
  })
  return ` (≈ ${fmt.format(total)} USD)`
}
// "$1,234.56" (single currency) or "$1,234.56 + €1,000.00" (mixed). USD sorts first.
function fmtTotals(totals) {
  const parts = Object.entries(totals).filter(([, v]) => v)
  if (!parts.length) return fmt(0)
  parts.sort(([a], [b]) => a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b))
  return parts.map(([cur, amt]) => fmt(amt, cur)).join(' + ')
}
function fmtDate(d) {
  if (!d) return '—'
  const s = String(d).slice(0, 10)
  const parts = s.split('-')
  if (parts.length !== 3) return '—'
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[parseInt(parts[1],10)-1]} ${parseInt(parts[2],10)}, ${parts[0]}`
}

// Local-calendar comparisons (utils helpers) — new Date('YYYY-MM-DD') is
// UTC midnight, which made everything due TODAY read as overdue all day
// in US timezones. Due today = due soon, not overdue.
function isOverdue(entry) {
  if (entry.payment_status === 'Paid') return false
  return isPastLocal(entry.scheduled_payment_date)
}
function isDueSoon(entry) {
  if (entry.payment_status === 'Paid') return false
  const diff = daysUntilLocal(entry.scheduled_payment_date)
  return diff != null && diff >= 0 && diff <= 7
}

// ── Priority ordering ────────────────────────────────────────────────────────
//
// The default sort answers "what do we pay next", which due-date-ascending
// does not: it interleaves a rushed invoice that is three weeks late with one
// that is merely scheduled. Rush alone can't order it either — 83 of the 160
// open rows carry the flag, and John confirmed that is real rather than flag
// inflation. So rush is the first cut and the ordering INSIDE it does the rest.
//
// Bands are mutually exclusive and checked in order. `on_hold` is tested before
// anything else because a held row is deliberately paused — every other surface
// on this page (stat cards, quick filters, row tint) already treats hold as
// overriding overdue/due-soon, and sinking it here keeps that consistent.
// Rush and hold are mutex server-side (setting hold clears rush), so a held row
// can't also be claiming a rush band.
const BAND_RUSH_OVERDUE = 0
const BAND_RUSH         = 1
const BAND_OVERDUE      = 2
const BAND_DUE_SOON     = 3
const BAND_SCHEDULED    = 4
const BAND_HOLD         = 5
const BAND_PAID         = 6
const BAND_LABELS = {
  [BAND_RUSH_OVERDUE]: 'Rush · overdue',
  [BAND_RUSH]:         'Rush',
  [BAND_OVERDUE]:      'Overdue',
  [BAND_DUE_SOON]:     'Due within 7 days',
  [BAND_SCHEDULED]:    'Scheduled',
  [BAND_HOLD]:         'On hold',
  [BAND_PAID]:         'Paid',
}
function priorityBand(entry) {
  if (entry.payment_status === 'Paid') return BAND_PAID
  if (entry.on_hold) return BAND_HOLD
  const overdue = isOverdue(entry)
  if (entry.rush_requested) return overdue ? BAND_RUSH_OVERDUE : BAND_RUSH
  if (overdue) return BAND_OVERDUE
  if (isDueSoon(entry)) return BAND_DUE_SOON
  return BAND_SCHEDULED
}

// Family-aware USD-equivalent for comparisons. Uses family_amount when present
// (a split parent holds only its own slice, so its bare `amount` under-reports
// the invoice), converts via the row's locked fx_rate_to_usd when it has one —
// a paid row keeps its payment-day rate forever — else the live rate. Falls
// back to the native amount when no rate is available, so missing-rate rows
// don't all collapse to 0 and pile up at one end.
function sortableUsd(e, rates) {
  const native = parseFloat(e.family_amount ?? e.amount ?? 0)
  if (!native) return 0
  const cur = e.currency || 'USD'
  if (cur === 'USD') return native
  const locked = parseFloat(e.fx_rate_to_usd)
  const rate = (Number.isFinite(locked) && locked > 0) ? locked : rates?.[cur]
  if (!rate || !isFinite(rate) || rate <= 0) return native
  return native / rate
}

export default function BkPayments() {
  // The hand-off, once per visit: marking something paid is a claim; the bank
  // statement is the proof. The first mark-paid says so and points at the
  // upload; the rest of the session does not repeat it.
  const [nextStep, showNextStep, clearNextStep] = useNextStep()
  const [statementPrompted, setStatementPrompted] = useState(false)
  const promptStatement = () => {
    if (statementPrompted) return
    setStatementPrompted(true)
    showNextStep({
      title: 'Marked paid',
      body: 'The bank statement is what proves it left the account. Upload it when it arrives and the line matches this payment on Bank › For review.',
      to: '/bk/statements',
      label: 'Open Statements',
    })
  }
  const { theme } = useTheme()
  const { rates: fxRates } = useFxRates()
  const BOOM_REPS = useBoomReps()
  const C = getDarkColors(theme)
  const { user } = useAuth()
  const isBkAdmin = ['Admin', 'Superadmin'].includes(user?.role)

  // Which rows have their detail panel open. A Set, not a single id — comparing
  // two invoices side by side is the ordinary reason to open one.
  const [detailOpen, setDetailOpen] = useState(() => new Set())
  const toggleDetail = (id) => setDetailOpen((s) => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const TH = {
    background: C.thBg, color: C.thText, fontSize: 10, fontWeight: 800,
    letterSpacing: '0.07em', textTransform: 'uppercase', padding: '8px 12px',
    textAlign: 'left', borderBottom: '1px solid ' + C.thBorder, whiteSpace: 'nowrap',
    position: 'sticky', top: 0, zIndex: 2,
  }
  const TD = { padding: '10px 12px', verticalAlign: 'middle', borderBottom: '1px solid ' + C.tdBorder, fontSize: 13 }
  const selectSty = {
    background: C.inputBg, border: '1.5px solid ' + C.inputBorder, borderRadius: 8,
    padding: '7px 28px 7px 10px', color: C.text, fontSize: 13, fontFamily: 'inherit',
    outline: 'none', cursor: 'pointer', appearance: 'none',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center',
  }
  const inputSty = {
    background: C.inputBg, border: '1.5px solid ' + C.inputBorder, borderRadius: 8,
    padding: '7px 10px', color: C.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', width: 220,
  }
  const MENU_ITEM = {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
    padding: '8px 10px', borderRadius: 6, border: 'none', background: 'transparent',
    color: C.text, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
  }
  // Frozen-column widths — four virtual cells render inside ONE sticky <td>
  // with an internal flex layout (§6.1 single-cell pattern). Splitting into
  // separate sticky <td>s causes sub-pixel gaps during horizontal scroll.
  const FW = { check: 36, date: 100, payee: 180, amount: 110 }
  const FROZEN_TOTAL = FW.check + FW.date + FW.payee + FW.amount
  const fCell = { padding: '0 8px', display: 'flex', alignItems: 'center', flexShrink: 0, minWidth: 0 }
  const fHeaderCell = {
    ...fCell, fontWeight: 800, fontSize: 10, color: '#9ca3af',
    letterSpacing: '0.07em', textTransform: 'uppercase',
  }
  const edgeShadow = C.isDark ? '2px 0 4px rgba(0,0,0,.3)' : '2px 0 4px rgba(0,0,0,.08)'
  const toast = useToast()
  const [entries, setEntries] = useState([])

  // ONE writer for every panel edit, undo and redo, so all three carry the same
  // expectation and land in the same place. `expect` goes into the UPDATE's own
  // WHERE clause server-side; a 409 means the row moved under us and NOTHING
  // was written.
  const applyFieldWrite = async ({ id, field, value, expect }) => {
    try {
      const body = { [field]: value }
      if (expect !== undefined) body.expect = { field, value: expect }
      const { data } = await api.put(`/bk/entries/${id}`, body)
      const row = data?.data
      if (row) setEntries((list) => list.map((e) => (e.id === id ? { ...e, ...row } : e)))
      return { ok: true }
    } catch (err) {
      if (err.response?.status === 409) return { conflict: err.response.data?.conflict || { field } }
      throw err
    }
  }

  const undoStack = useUndoStack({ apply: applyFieldWrite })
  // Keys (lib/shortcuts): j/k move over the rows, p/h/u/Enter act on the focused
  // one by its entry id, x selects, f finds the search box, . reloads.
  const listKeys = useListKeys()
  const focusedEntry = () => { const id = Number(listKeys.focused()?.getAttribute('data-entry-id')); return entries.find((e) => e.id === id) || null }
  usePageShortcuts('/bk/payments', {
    j: listKeys.next, k: listKeys.prev, x: () => listKeys.verb('x'), f: focusFilter,
    p: () => { const e = focusedEntry(); if (e && e.payment_status !== 'Paid') handleMarkPaid(e.id) },
    h: () => { if (!listKeys.verb('h')) { const e = focusedEntry(); if (e && e.payment_status !== 'Paid') { setHoldModalEntry(e); setHoldReason('') } } },
    u: () => { if (!listKeys.verb('u')) { const e = focusedEntry(); if (e && e.payment_status !== 'Paid') { setRushModalEntry(e); setRushReason('') } } },
    Enter: () => { const e = focusedEntry(); if (e) startEdit(e) },
    '.': () => fetchEntries(),
  })

  // A panel edit: write it, then record what it was so it can be walked back.
  const editField = async (entry, field, value) => {
    const from = entry[field] ?? null
    const to = value ?? null
    const res = await applyFieldWrite({ id: entry.id, field, value: to, expect: from })
    if (res?.conflict) {
      toast?.error?.(`${field} changed since this page loaded — nothing was written.`)
      return
    }
    undoStack.push(`${field} on ${entry.payee || 'invoice'}`, [{ id: entry.id, field, from, to }])
  }

  const [loading, setLoading] = useState(true)
  
  const [savingId, setSavingId] = useState(null)
  const [savingRepId, setSavingRepId] = useState(null)
  const [savingArtistId, setSavingArtistId] = useState(null)
  // Status popover — id of the row whose Paid/Partial/Unpaid menu is
  // currently open. Only one open at a time.
  const [statusMenuId, setStatusMenuId] = useState(null)
  const statusMenuRef = useRef(null)
  const exportMenuRef = useRef(null)

  const [search, setSearch] = useState('')
  const [amountQuery, setAmountQuery] = useState('')
  const [methodFilter, setMethodFilter] = useState('All')
  const [statusFilter, setStatusFilter] = useState('All')
  const [repFilter, setRepFilter] = useState('All')
  const [groupBy, setGroupBy] = useState('No grouping')
  const [quickFilter, setQuickFilter] = useState('All')
  const [sortBy, setSortBy] = useState('Priority')
  const [selectedIds, setSelectedIds] = useState(new Set())
  // Mobile card view (<768px). Sheet keys off the id, not the object, so a
  // window-focus refetch (file-picker round-trips fire it) can't strand a
  // stale entry inside the open drawer.
  const isMobileView = useIsMobile()
  const [sheetPaymentId, setSheetPaymentId] = useState(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [uploadingId, setUploadingId] = useState(null)
  const [sendingConfirmId, setSendingConfirmId] = useState(null)
  const [showCalendar, setShowCalendar] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [calMonth, setCalMonth] = useState(new Date().getMonth())
  const [calYear, setCalYear] = useState(new Date().getFullYear())
  const [showBatchModal, setShowBatchModal] = useState(false)
  const [batchForm, setBatchForm] = useState({ payment_method: '', payment_ref: '', payment_date: new Date().toISOString().split('T')[0] })
  const [undoAction, setUndoAction] = useState(null) // { message, undo: async fn, timer }
  const undoTimerRef = useRef(null)
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState({})
  const [savingEdit, setSavingEdit] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  // Which invoice the split dialog is open on. The family ROOT only — a child
  // is a slice of a split that already exists, and re-cutting it would make a
  // slice of a slice, which nothing downstream (family totals, the confirmation
  // email, recoupment) is built to read.
  const [splitEntry, setSplitEntry] = useState(null)
  const [batchProofFile, setBatchProofFile] = useState(null)
  // Rush-payment request: per-row request to expedite. `rushModalEntry` opens
  // the reason modal; `submittingRush` blocks double-submit. The badge shown
  // after the request lives on entry.rush_requested (server-truth).
  const [rushModalEntry, setRushModalEntry] = useState(null)
  const [rushReason, setRushReason] = useState('')
  const [submittingRush, setSubmittingRush] = useState(false)
  // Grace period for rush-flagged rows after they're marked paid. Without
  // this, marking paid immediately drops the row out of the Rush filter,
  // which means the "send confirmation" affordance vanishes before the
  // user can click it. Keep the row visible for 10s so they can send a
  // vendor-confirmation email from the same context. Set holds entry
  // IDs; the ref holds their pending removal timeouts so we can clean
  // them up on unmount.
  const [rushGraceIds, setRushGraceIds] = useState(() => new Set())
  const rushGraceTimeoutsRef = useRef(new Map())
  const RUSH_GRACE_MS = 10_000
  const startRushGracePeriod = (id) => {
    // Reset the countdown if the same row gets re-flipped within the window
    // (e.g. paid → undo → paid again). Any existing timeout for this id
    // gets replaced so the row stays visible for a fresh 10 seconds.
    const existing = rushGraceTimeoutsRef.current.get(id)
    if (existing) clearTimeout(existing)
    const handle = setTimeout(() => {
      rushGraceTimeoutsRef.current.delete(id)
      setRushGraceIds(prev => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }, RUSH_GRACE_MS)
    rushGraceTimeoutsRef.current.set(id, handle)
    setRushGraceIds(prev => prev.has(id) ? prev : new Set(prev).add(id))
  }
  useEffect(() => () => {
    // Clean up any in-flight grace-period timeouts on unmount.
    for (const h of rushGraceTimeoutsRef.current.values()) clearTimeout(h)
    rushGraceTimeoutsRef.current.clear()
  }, [])
  // Bulk rush — opens on a list of selected eligible entries (unpaid +
  // not-already-rushed). One shared reason for the whole batch. No
  // notification email is sent; the rush badges on the dashboard +
  // the "Rush" quick-filter are the entire signal.
  const [bulkRushOpen, setBulkRushOpen] = useState(false)
  const [bulkRushReason, setBulkRushReason] = useState('')
  const [submittingBulkRush, setSubmittingBulkRush] = useState(false)
  // Hold: opposite intent of rush ("pause, don't pay yet"). Mirrors the
  // rush state shape. Reason is optional (rush requires one; hold is a
  // lighter pause signal). Server enforces mutex — placing hold clears
  // rush and vice versa.
  const [holdModalEntry, setHoldModalEntry] = useState(null)
  const [holdReason, setHoldReason] = useState('')
  const [submittingHold, setSubmittingHold] = useState(false)
  const [bulkHoldOpen, setBulkHoldOpen] = useState(false)
  const [bulkHoldReason, setBulkHoldReason] = useState('')
  const [submittingBulkHold, setSubmittingBulkHold] = useState(false)
  const [showApprovalModal, setShowApprovalModal] = useState(false)
  // Holds the dry-run preview payload while the EmailPreviewModal is open.
  const [approvalPreview, setApprovalPreview] = useState(null)
  // Per-vendor wizard queue for bulk confirmations. Each entry is a preview
  // payload; Send/Skip/Cancel advances to the next.
  const [confirmQueue, setConfirmQueue] = useState([])
  const advanceConfirmQueue = () => setConfirmQueue(q => q.slice(1))
  const [sendingApproval, setSendingApproval] = useState(false)
  const [approvalRecipients, setApprovalRecipients] = useState('both') // 'both' | 'felipe' | 'jesse'
  const [approvalMessage, setApprovalMessage] = useState('')
  const [messageEdited, setMessageEdited] = useState(false)
  const [approvalSubject, setApprovalSubject] = useState('')
  const [expandedGroups, setExpandedGroups] = useState(new Set())
  const toggleGroup = (id) => setExpandedGroups(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const { registerUndo } = useShortcuts()
  const showUndo = (message, undoFn) => {
    registerUndo(undoFn) // ⌘Z, while the toast stands or after
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    setUndoAction({ message, undo: undoFn })
    undoTimerRef.current = setTimeout(() => setUndoAction(null), 6000)
  }

  const executeUndo = async () => {
    if (!undoAction) return
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    try { await undoAction.undo() } catch {}
    setUndoAction(null)
  }

  // CC-the-rep toggle — persisted in localStorage so the preference sticks
  // across reloads. Default: OFF (reps generally don't want to be CC'd).
  // Check the box to CC the invoice's assigned Market Street rep on the confirmation.
  const [ccRep, setCcRep] = useState(() => localStorage.getItem('pay_dash_cc_rep') === 'true')
  useEffect(() => { localStorage.setItem('pay_dash_cc_rep', String(ccRep)) }, [ccRep])

  // Close the status popover on outside click / Escape. Menu closes
  // itself when an option is chosen, so this is only for the
  // dismissed-without-choosing path.
  useEffect(() => {
    if (statusMenuId == null) return
    const onDown = (e) => {
      if (statusMenuRef.current && statusMenuRef.current.contains(e.target)) return
      setStatusMenuId(null)
    }
    const onKey = (e) => { if (e.key === 'Escape') setStatusMenuId(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [statusMenuId])

  // Same dismissal contract for the export menu. Both handlers are attached
  // only while the menu is open, so a closed page carries no listeners.
  useEffect(() => {
    if (!exportOpen) return
    const onDown = (e) => {
      if (exportMenuRef.current && exportMenuRef.current.contains(e.target)) return
      setExportOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setExportOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [exportOpen])

  // Default CC list — emails that get pre-filled into the CC chips on every
  // payment-confirmation send (single + bulk). Persisted in localStorage so
  // the same set sticks across sessions. Stored as a JSON array so a user
  // who CCs the same 3 teammates every time doesn't have to re-add them.
  const [defaultCcEmails, setDefaultCcEmails] = useState(() => {
    try {
      const raw = localStorage.getItem('pay_dash_cc_default')
      const arr = raw ? JSON.parse(raw) : []
      return Array.isArray(arr) ? arr.filter(e => typeof e === 'string' && e.trim()) : []
    } catch { return [] }
  })
  useEffect(() => {
    try { localStorage.setItem('pay_dash_cc_default', JSON.stringify(defaultCcEmails)) } catch {}
  }, [defaultCcEmails])

  // Team roster — fetched once for autocomplete suggestions on the CC field.
  const [teamRoster, setTeamRoster] = useState([])
  useEffect(() => {
    let cancelled = false
    api.get('/team').then(r => {
      if (cancelled) return
      const list = Array.isArray(r.data?.data) ? r.data.data : (Array.isArray(r.data) ? r.data : [])
      setTeamRoster(list.filter(u => u && u.email))
    }).catch(() => { /* roster is best-effort */ })
    return () => { cancelled = true }
  }, [])

  // CC field input/parse helpers. The backend wants a comma-joined string in
  // confirmForm.cc — but the UI now operates on a chip array. parseCcList and
  // joinCcList are the two sides of that conversion.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const parseCcList = (s) => {
    if (!s) return []
    return String(s).split(/[,;\n]/).map(p => p.trim()).filter(Boolean)
  }
  const joinCcList = (arr) => (arr || []).filter(Boolean).join(', ')
  const dedupeCi = (arr) => {
    const seen = new Set(); const out = []
    for (const v of arr || []) {
      const k = String(v || '').toLowerCase().trim()
      if (!k || seen.has(k)) continue
      seen.add(k); out.push(v)
    }
    return out
  }

  // Confirmation-email modal. Single-row "Send" now opens a preview/edit
  // modal instead of firing immediately. The modal shows the rendered HTML
  // (server-rendered via /confirmation-preview) and lets the user edit
  // To / CC / Subject / personal message before sending.
  const [confirmEntry, setConfirmEntry] = useState(null) // entry object or null
  const [confirmForm, setConfirmForm] = useState({ to: '', cc: '', subject: '', message: '' })
  const [confirmMeta, setConfirmMeta] = useState(null) // { amount, currency, invoiceNumber, paymentDate, paymentMethod, hasInvoice, hasProof, boomRep }
  const [confirmHtml, setConfirmHtml] = useState('')
  const [confirmLoading, setConfirmLoading] = useState(false)
  const [previewEdited, setPreviewEdited] = useState(false)
  const previewIframeRef = useRef(null)

  // Installments modal — multi-payment invoices. Opens on the Receipt icon
  // next to a row's payment-status badge. Server keeps payment_status in
  // sync from the installment rows (Unpaid / Partial / Paid).
  const [installmentsEntry, setInstallmentsEntry] = useState(null)
  const [installmentsData, setInstallmentsData] = useState(null) // { familyTotal, installmentsTotal, remaining, installments[] }
  const [installmentsLoading, setInstallmentsLoading] = useState(false)
  const [installmentsSubmitting, setInstallmentsSubmitting] = useState(false)
  const [installmentForm, setInstallmentForm] = useState({
    amount: '', payment_date: '', payment_method: '', payment_ref: '',
    paid_by: '', notes: '', file: null,
  })

  const fetchInstallments = async (entryId) => {
    setInstallmentsLoading(true)
    try {
      const r = await api.get(`/bk/payments/${entryId}/installments`)
      setInstallmentsData(r.data?.data || null)
    } catch (err) {
      toast.error('Failed to load installments: ' + (err.response?.data?.error || err.message))
    } finally {
      setInstallmentsLoading(false)
    }
  }

  const openInstallmentsModal = async (entry) => {
    setInstallmentsEntry(entry)
    setInstallmentsData(null)
    setInstallmentForm({
      amount: '', payment_date: new Date().toISOString().slice(0, 10),
      payment_method: entry.payment_method || '', payment_ref: '',
      paid_by: '', notes: '', file: null,
    })
    await fetchInstallments(entry.id)
  }

  const closeInstallmentsModal = () => {
    if (installmentsSubmitting) return
    setInstallmentsEntry(null)
    setInstallmentsData(null)
  }

  const submitInstallment = async () => {
    if (!installmentsEntry) return
    const amt = parseFloat(installmentForm.amount)
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error('Enter a positive amount')
      return
    }
    setInstallmentsSubmitting(true)
    try {
      const fd = new FormData()
      fd.append('amount', String(amt))
      if (installmentForm.payment_date)   fd.append('payment_date',   installmentForm.payment_date)
      if (installmentForm.payment_method) fd.append('payment_method', installmentForm.payment_method)
      if (installmentForm.payment_ref)    fd.append('payment_ref',    installmentForm.payment_ref)
      if (installmentForm.paid_by)        fd.append('paid_by',        installmentForm.paid_by)
      if (installmentForm.notes)          fd.append('notes',          installmentForm.notes)
      if (installmentForm.file)           fd.append('proof',          installmentForm.file)

      const r = await api.post(`/bk/payments/${installmentsEntry.id}/installments`, fd)
      const summary = r.data?.data?.summary || {}

      // Refresh the modal + reflect the new status / paid_amount on the row.
      await fetchInstallments(installmentsEntry.id)
      setEntries(prev => prev.map(e => {
        const sameFamily = e.id === installmentsEntry.id
          || (e.parent_id && e.parent_id === installmentsEntry.id)
          || (installmentsEntry.parent_id && (e.id === installmentsEntry.parent_id || e.parent_id === installmentsEntry.parent_id))
        if (!sameFamily) return e
        return {
          ...e,
          payment_status: summary.status || e.payment_status,
          installments_total: summary.paid ?? e.installments_total,
          installment_count: summary.count ?? e.installment_count,
          family_amount: summary.familyTotal ?? e.family_amount,
        }
      }))
      setInstallmentForm(f => ({
        amount: '', payment_date: new Date().toISOString().slice(0, 10),
        payment_method: f.payment_method, payment_ref: '',
        paid_by: '', notes: '', file: null,
      }))
      toast(`Installment recorded · status: ${summary.status || 'Unpaid'}`)
    } catch (err) {
      toast.error('Failed to record installment: ' + (err.response?.data?.error || err.message))
    } finally {
      setInstallmentsSubmitting(false)
    }
  }

  const deleteInstallment = async (installmentId) => {
    if (!installmentsEntry) return
    setInstallmentsSubmitting(true)
    try {
      const r = await api.delete(`/bk/installments/${installmentId}`)
      const summary = r.data?.data?.summary || {}
      await fetchInstallments(installmentsEntry.id)
      setEntries(prev => prev.map(e => {
        const sameFamily = e.id === installmentsEntry.id
          || (e.parent_id && e.parent_id === installmentsEntry.id)
          || (installmentsEntry.parent_id && (e.id === installmentsEntry.parent_id || e.parent_id === installmentsEntry.parent_id))
        if (!sameFamily) return e
        return {
          ...e,
          payment_status: summary.status || e.payment_status,
          installments_total: summary.paid ?? 0,
          installment_count: summary.count ?? 0,
        }
      }))
    } catch (err) {
      toast.error('Failed to remove installment: ' + (err.response?.data?.error || err.message))
    } finally {
      setInstallmentsSubmitting(false)
    }
  }

  const openConfirmModal = async (entry) => {
    setConfirmEntry(entry)
    setConfirmHtml('')
    setConfirmMeta(null)
    setConfirmForm({ to: '', cc: '', subject: '', message: '' })
    setPreviewEdited(false)
    setConfirmLoading(true)
    try {
      const r = await api.post(`/bk/payments/${entry.id}/confirmation-preview`, { cc_rep: ccRep })
      const d = r.data?.data || {}
      // Merge:
      //   1) whatever the server resolved (rep email when cc_rep is on)
      //   2) the user's persisted defaultCcEmails
      // De-duplicate case-insensitively. Drops anything that exactly matches
      // the `to` recipient so we don't CC the same person we're sending to.
      const serverCcList = parseCcList(d.cc)
      const merged = dedupeCi([...serverCcList, ...defaultCcEmails])
        .filter(e => e.toLowerCase() !== String(d.to || '').toLowerCase())
      setConfirmForm({
        to: d.to || '',
        cc: joinCcList(merged),
        subject: d.subject || '',
        message: d.message || '',
      })
      setConfirmMeta({
        amount: d.amount, currency: d.currency, invoiceNumber: d.invoiceNumber,
        paymentDate: d.paymentDate, paymentMethod: d.paymentMethod,
        hasInvoice: !!d.hasInvoice, hasProof: !!d.hasProof, boomRep: d.boomRep,
      })
      setConfirmHtml(d.html || '')
    } catch (err) {
      toast.error('Failed to load preview: ' + (err.response?.data?.error || err.message))
      setConfirmEntry(null)
    } finally {
      setConfirmLoading(false)
    }
  }

  // Re-render the preview when subject/message change. To/CC don't affect the
  // body, so we skip those to keep refresh cheap. 350ms debounce. Suppressed
  // once the user has hand-edited the preview inline — re-fetching would
  // clobber their edits.
  useEffect(() => {
    if (!confirmEntry) return
    if (previewEdited) return
    const id = setTimeout(async () => {
      try {
        const r = await api.post(`/bk/payments/${confirmEntry.id}/confirmation-preview`, {
          to: confirmForm.to,
          cc: confirmForm.cc,
          subject: confirmForm.subject,
          message: confirmForm.message,
        })
        const d = r.data?.data || {}
        setConfirmHtml(d.html || '')
      } catch { /* leave previous html */ }
    }, 350)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmForm.message, confirmEntry?.id, previewEdited])

  const closeConfirmModal = () => {
    if (sendingConfirmId === confirmEntry?.id) return
    setConfirmEntry(null)
    setConfirmHtml('')
    setConfirmMeta(null)
    setPreviewEdited(false)
  }

  // Wire the preview iframe up for direct editing each time its HTML reloads.
  // sandbox="allow-same-origin" lets us reach into contentDocument; no scripts
  // run inside, so this stays inert from the iframe's side.
  const handlePreviewLoad = () => {
    const ifr = previewIframeRef.current
    if (!ifr) return
    let doc
    try { doc = ifr.contentDocument } catch { return }
    if (!doc || !doc.body) return
    doc.body.contentEditable = 'true'
    doc.body.spellcheck = true
    doc.body.style.outline = 'none'
    doc.body.style.cursor = 'text'
    doc.body.addEventListener('input', () => setPreviewEdited(true))
  }

  const resetPreview = async () => {
    if (!confirmEntry) return
    setPreviewEdited(false)
    setConfirmLoading(true)
    try {
      const r = await api.post(`/bk/payments/${confirmEntry.id}/confirmation-preview`, {
        to: confirmForm.to,
        cc: confirmForm.cc,
        subject: confirmForm.subject,
        message: confirmForm.message,
      })
      setConfirmHtml(r.data?.data?.html || '')
    } catch { /* leave current */ }
    finally { setConfirmLoading(false) }
  }

  const submitConfirmModal = async () => {
    if (!confirmEntry) return
    const entryId = confirmEntry.id
    setSendingConfirmId(entryId)

    // If the admin hand-edited the inline preview, grab its current HTML and
    // ship it as the email body instead of letting the server re-render from
    // the template + form fields.
    let htmlOverride
    if (previewEdited && previewIframeRef.current) {
      try {
        const doc = previewIframeRef.current.contentDocument
        if (doc && doc.body) htmlOverride = doc.body.innerHTML
      } catch { /* ignore — fall back to server render */ }
    }

    try {
      await api.post(`/bk/payments/${entryId}/send-confirmation`, {
        to: confirmForm.to,
        cc: confirmForm.cc,
        subject: confirmForm.subject,
        message: confirmForm.message,
        ...(htmlOverride ? { html_override: htmlOverride } : {}),
      })
      setEntries(prev => prev.map(e => e.id === entryId ? { ...e, confirmation_sent: true } : e))
      toast(`Payment confirmation sent to ${confirmForm.to}${confirmForm.cc ? ` (CC ${confirmForm.cc})` : ''}`)
      setConfirmEntry(null)
      setConfirmHtml('')
      setConfirmMeta(null)
      setPreviewEdited(false)
    } catch (err) {
      toast.error('Failed to send: ' + (err.response?.data?.error || err.message))
    } finally {
      setSendingConfirmId(null)
    }
  }

  // Send a single combined confirmation per vendor for every paid-not-confirmed
  // entry with vendor_email + proof. Server bundles all of a vendor's invoices
  // into one email so a vendor with 5 paid invoices gets 1 email, not 5.
  const [sendingBulk, setSendingBulk] = useState(false)
  // Send confirmations only for the rows the user has checked. We refetch
  // before sending so amounts reflect any recent edits, then intersect the
  // fresh server data with the selectedIds set so we never send for
  // anything the user didn't pick.
  const sendAllPendingConfirmations = async () => {
    if (selectedIds.size === 0) {
      toast.error('Select at least one row to send confirmations for.')
      return
    }
    setSendingBulk(true)
    let fresh = []
    try {
      const r = await api.get('/bk/payments')
      fresh = r.data?.data || []
      setEntries(fresh)
    } catch {
      fresh = entries
    }
    const eligible = fresh.filter(e =>
      selectedIds.has(e.id) &&
      e.payment_status === 'Paid' &&
      !e.confirmation_sent &&
      e.vendor_email &&
      e.has_proof
    )
    const ineligibleSelected = selectedIds.size - eligible.length
    if (!eligible.length) {
      toast.error('No selected rows are eligible (need Paid + vendor email + proof of payment, not already sent).')
      setSendingBulk(false)
      return
    }
    const ids = eligible.map(e => e.id)
    // Family-aware total so the dialog matches what the server actually sends:
    // a split invoice is one line at the family total, not its parent's share.
    const grandTotal = fmtTotals(groupByCurrencyByFamily(eligible))
    const ineligibleNote = ineligibleSelected > 0
      ? `\n\n${ineligibleSelected} other selected row${ineligibleSelected === 1 ? '' : 's'} skipped (already sent, missing proof, missing email, or not yet Paid).`
      : ''
    const ok = window.confirm(
      `Send payment confirmations for ${ids.length} selected invoice${ids.length === 1 ? '' : 's'} — ${grandTotal} total?\n\n` +
      `Multiple invoices for the same vendor will be combined into one email.` + ineligibleNote
    )
    if (!ok) { setSendingBulk(false); return }
    try {
      // Per-vendor wizard: group eligible entries by vendor_email, then walk
      // through them as a queue of EmailPreviewModal opens. Each entry is a
      // preview payload pre-rendered by /api/email/preview using the same
      // dispatch logic as the legacy bulk endpoint.
      const groups = new Map()
      for (const e of eligible) {
        const k = e.vendor_email.toLowerCase().trim()
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push(e)
      }
      const queue = []
      for (const [, group] of groups) {
        const kind = group.length === 1 ? 'payment_confirmation' : 'bulk_payment_confirmation'
        const context = group.length === 1
          ? { entryId: group[0].id, cc_rep: ccRep }
          : { entryIds: group.map(g => g.id), cc_rep: ccRep }
        try {
          const r = await api.post('/email/preview', { kind, context })
          const d = r.data?.data || {}
          queue.push({
            kind, context,
            ids: group.map(g => g.id),
            to: d.to, cc: d.cc, subject: d.subject, html: d.html,
            attachmentLabels: d.attachmentLabels || [],
            vendorEmail: group[0].vendor_email,
            count: group.length,
          })
        } catch (err) {
          console.warn('bulk preview failed for vendor', group[0].vendor_email, err.message)
        }
      }
      if (!queue.length) {
        toast.error('Could not prepare any previews.')
      } else {
        setConfirmQueue(queue)
      }
    } finally {
      setSendingBulk(false)
    }
  }
  const [dragOverId, setDragOverId] = useState(null)
  const [previewFile, setPreviewFile] = useState(null)
  const fileInputRefs = useRef({})

  const uploadProof = async (entryId, file) => {
    if (!file) return
    setUploadingId(entryId)
    try {
      const formData = new FormData()
      formData.append('file', file)
      await api.post(`/bk/entries/${entryId}/file/proof`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      // Immediately mark as paid + has_proof in UI
      const today = new Date().toISOString().split('T')[0]
      setEntries(prev => {
        const next = prev.map(e => e.id === entryId ? { ...e, has_proof: true, payment_status: 'Paid', payment_date: e.payment_date || today } : e)
        // If this row was rush-flagged, keep it visible in the Rush filter
        // for a few seconds so the user can send a confirmation email.
        if (next.find(e => e.id === entryId)?.rush_requested) startRushGracePeriod(entryId)
        return next
      })
      toast('Proof uploaded — AI scanning for payment details...')
      // Pick up what the background scan wrote — and NOTHING ELSE.
      //
      // This used to be `setEntries(res.data.data)`: the whole list replaced by
      // a snapshot the server took when the GET went out, four seconds after the
      // upload. Anything answered inside that window was silently rolled back to
      // the pre-answer value — measured on entry #1611, where a confirmation
      // email sent 5s after the proof upload was recorded in the ledger
      // (bk_audit_log 21:08:49, confirmation_sent = TRUE) while the row on
      // screen went back to offering "Send" ten seconds later. The email had
      // gone; only the page disagreed. A longer delay is the same race with
      // different odds, which is why the fix is in what gets applied.
      //
      // So: patch the fields `scanProofInBackground` actually writes, on the
      // rows it writes them to (the family, since the proof covers the whole
      // invoice), and leave every other row and field as the user left them.
      // Anything not in this list is not the scan's to say.
      setTimeout(async () => {
        try {
          const res = await api.get('/bk/payments')
          const fresh = res.data.data || []
          const byId = new Map(fresh.map((e) => [e.id, e]))
          setEntries((prev) => {
            const target = prev.find((e) => e.id === entryId)
            if (!target) return prev
            const rootId = target.parent_id || entryId
            return prev.map((e) => {
              if (e.id !== rootId && e.parent_id !== rootId && e.id !== entryId) return e
              const f = byId.get(e.id)
              if (!f) return e
              return {
                ...e,
                payment_status: f.payment_status,
                payment_date: f.payment_date,
                payment_ref: f.payment_ref,
                payment_method: f.payment_method,
                paid_by: f.paid_by,
                // The scan clears both when it flips a row to Paid.
                rush_requested: f.rush_requested,
                on_hold: f.on_hold,
              }
            })
          })
        } catch {}
      }, 4000)
    } catch (err) {
      toast.error('Upload failed: ' + (err.response?.data?.error || err.message))
    } finally {
      setUploadingId(null)
    }
  }

  // One scope, one fetch. Every quick filter now narrows the rows already
  // loaded — the removed 'No bank match' chip was the only one that had to
  // refetch, because it opted out of this page's unpaid + last-14-days-paid
  // window server-side.
  const fetchEntries = async () => {
    try {
      setLoading(true)
      const res = await api.get('/bk/payments')
      setEntries(res.data.data || [])
    } catch (err) {
      toast.error('Failed to load payments: ' + (err.response?.data?.error || err.message))
    } finally { setLoading(false) }
  }

  useEffect(() => { fetchEntries() }, [])

  // Submit a rush-payment request from the modal. Server flips rush_requested
  // + emails the superadmin. Optimistic update so the badge appears immediately;
  // rolls back on failure.
  const submitRushRequest = async () => {
    if (!rushModalEntry || submittingRush) return
    setSubmittingRush(true)
    const entryId = rushModalEntry.id
    const reason = rushReason.trim()
    const nowIso = new Date().toISOString()
    try {
      const { data } = await api.post(`/bk/payments/${entryId}/rush`, { reason })
      const row = data?.data || {}
      setEntries(prev => prev.map(e => e.id === entryId ? {
        ...e,
        rush_requested: true,
        rush_requested_at: row.rush_requested_at || nowIso,
        rush_requested_by: row.rush_requested_by || 'You',
        rush_reason: row.rush_reason || reason || null,
      } : e))
      setRushModalEntry(null)
      setRushReason('')
      toast('Rush requested')
    } catch (err) {
      toast.error('Failed to request rush: ' + (err.response?.data?.error || err.message))
    } finally {
      setSubmittingRush(false)
    }
  }

  // Bulk variant of submitRushRequest. Eligible = currently selected, unpaid,
  // not-already-rushed. Server filters again (visibility + paid + already-
  // rushed) and returns the rows it actually flipped — we mirror those
  // into local state. No notification email is sent.
  const submitBulkRushRequest = async () => {
    if (submittingBulkRush) return
    const eligible = entries.filter(e =>
      selectedIds.has(e.id) && e.payment_status !== 'Paid' && !e.rush_requested
    )
    if (!eligible.length) {
      toast.error('No selected items are eligible for rush')
      return
    }
    setSubmittingBulkRush(true)
    const reason = bulkRushReason.trim()
    try {
      const { data } = await api.post('/bk/payments/rush/bulk', {
        ids: eligible.map(e => e.id),
        reason,
      })
      const rushed = data?.data?.rushed || []
      const rushedSet = new Set(rushed.map(r => r.id))
      const nowIso = new Date().toISOString()
      setEntries(prev => prev.map(e => rushedSet.has(e.id) ? {
        ...e,
        rush_requested: true,
        rush_requested_at: e.rush_requested_at || nowIso,
        rush_requested_by: e.rush_requested_by || 'You',
        rush_reason: e.rush_reason || reason || null,
      } : e))
      const skipped = (data?.data?.skipped || 0) + (data?.data?.invisible || 0)
      const n = data?.data?.rushedCount ?? rushed.length
      toast(skipped > 0
        ? `Rushed ${n} payment${n === 1 ? '' : 's'} — ${skipped} skipped (paid / already rushed)`
        : `Rushed ${n} payment${n === 1 ? '' : 's'}`)
      setBulkRushOpen(false)
      setBulkRushReason('')
    } catch (err) {
      toast.error('Failed to bulk rush: ' + (err.response?.data?.error || err.message))
    } finally {
      setSubmittingBulkRush(false)
    }
  }

  const handleClearRush = async (entryId) => {
    const entry = entries.find(e => e.id === entryId)
    if (!entry) return
    const prev = {
      rush_requested: entry.rush_requested,
      rush_requested_at: entry.rush_requested_at,
      rush_requested_by: entry.rush_requested_by,
      rush_reason: entry.rush_reason,
    }
    setEntries(p => p.map(e => e.id === entryId
      ? { ...e, rush_requested: false, rush_requested_at: null, rush_requested_by: null, rush_reason: null }
      : e))
    try {
      await api.delete(`/bk/payments/${entryId}/rush`)
      toast('Rush request cleared')
    } catch (err) {
      setEntries(p => p.map(e => e.id === entryId ? { ...e, ...prev } : e))
      toast.error('Failed to clear rush: ' + (err.response?.data?.error || err.message))
    }
  }

  // Hold handlers — mirror the rush handlers above. Server enforces the
  // rush/hold mutex; on success we also locally clear the opposite flag
  // so the optimistic UI matches what the server just wrote.
  const submitHoldRequest = async () => {
    if (!holdModalEntry || submittingHold) return
    setSubmittingHold(true)
    const entryId = holdModalEntry.id
    const reason = holdReason.trim()
    const nowIso = new Date().toISOString()
    try {
      const { data } = await api.post(`/bk/payments/${entryId}/hold`, { reason })
      const row = data?.data || {}
      setEntries(prev => prev.map(e => e.id === entryId ? {
        ...e,
        on_hold: true,
        hold_at: row.hold_at || nowIso,
        hold_by: row.hold_by || 'You',
        hold_reason: row.hold_reason || reason || null,
        rush_requested: false,
        rush_requested_at: null,
        rush_requested_by: null,
        rush_reason: null,
      } : e))
      setHoldModalEntry(null)
      setHoldReason('')
      toast('Hold placed')
    } catch (err) {
      toast.error('Failed to place hold: ' + (err.response?.data?.error || err.message))
    } finally {
      setSubmittingHold(false)
    }
  }

  const submitBulkHoldRequest = async () => {
    if (submittingBulkHold) return
    const eligible = entries.filter(e =>
      selectedIds.has(e.id) && e.payment_status !== 'Paid' && !e.on_hold
    )
    if (!eligible.length) {
      toast.error('No selected items are eligible for hold')
      return
    }
    setSubmittingBulkHold(true)
    const reason = bulkHoldReason.trim()
    try {
      const { data } = await api.post('/bk/payments/hold/bulk', {
        ids: eligible.map(e => e.id),
        reason,
      })
      const held = data?.data?.held || []
      const heldSet = new Set(held.map(r => r.id))
      const nowIso = new Date().toISOString()
      setEntries(prev => prev.map(e => heldSet.has(e.id) ? {
        ...e,
        on_hold: true,
        hold_at: e.hold_at || nowIso,
        hold_by: e.hold_by || 'You',
        hold_reason: e.hold_reason || reason || null,
        rush_requested: false,
        rush_requested_at: null,
        rush_requested_by: null,
        rush_reason: null,
      } : e))
      const skipped = (data?.data?.skipped || 0) + (data?.data?.invisible || 0)
      const n = data?.data?.heldCount ?? held.length
      toast(skipped > 0
        ? `Held ${n} payment${n === 1 ? '' : 's'} — ${skipped} skipped (paid / already held)`
        : `Held ${n} payment${n === 1 ? '' : 's'}`)
      setBulkHoldOpen(false)
      setBulkHoldReason('')
    } catch (err) {
      toast.error('Failed to bulk hold: ' + (err.response?.data?.error || err.message))
    } finally {
      setSubmittingBulkHold(false)
    }
  }

  const handleClearHold = async (entryId) => {
    const entry = entries.find(e => e.id === entryId)
    if (!entry) return
    const prev = {
      on_hold: entry.on_hold,
      hold_at: entry.hold_at,
      hold_by: entry.hold_by,
      hold_reason: entry.hold_reason,
    }
    setEntries(p => p.map(e => e.id === entryId
      ? { ...e, on_hold: false, hold_at: null, hold_by: null, hold_reason: null }
      : e))
    try {
      await api.delete(`/bk/payments/${entryId}/hold`)
      toast('Hold released')
    } catch (err) {
      setEntries(p => p.map(e => e.id === entryId ? { ...e, ...prev } : e))
      toast.error('Failed to release hold: ' + (err.response?.data?.error || err.message))
    }
  }

  const handleMarkPaid = async (entryId) => {
    try {
      setSavingId(entryId)
      const entry = entries.find(e => e.id === entryId)
      const prevStatus = entry?.payment_status
      const prevDate = entry?.payment_date
      const prevPaidBy = entry?.paid_by
      const today = new Date().toISOString().split('T')[0]
      // Server cascades payment flips to the whole split family — mirror
      // that locally (parent + siblings) so expanded families don't show
      // stale status until a refetch.
      const rootId = entry?.parent_id || entryId
      const inFamily = (e) => e.id === rootId || e.parent_id === rootId
      await api.put(`/bk/payments/${entryId}`, { payment_status: 'Paid', payment_date: today })
      setEntries(prev => prev.map(e => inFamily(e) ? { ...e, payment_status: 'Paid', payment_date: today } : e))
      promptStatement()
      if (entry?.rush_requested) startRushGracePeriod(entryId)
      showUndo(`Marked ${entry?.payee || 'invoice'} as paid`, async () => {
        await api.put(`/bk/payments/${entryId}`, { payment_status: prevStatus || 'Unpaid', payment_date: prevDate || null, paid_by: prevPaidBy || null })
        setEntries(prev => prev.map(e => inFamily(e) ? { ...e, payment_status: prevStatus || 'Unpaid', payment_date: prevDate || null, paid_by: prevPaidBy || null } : e))
      })
    } catch (err) { toast.error('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setSavingId(null) }
  }

  // Inline artist edit on the Payment Dashboard — commits on blur or Enter.
  // Server-side, PUT /bk/entries/:id also re-runs autoLinkRelease so the
  // expense's release_id updates if the new artist + song match a release.
  const handleArtistChange = async (entryId, rawArtist) => {
    const entry = entries.find(e => e.id === entryId)
    const prevArtist = entry?.artist || ''
    const next = (rawArtist || '').trim()
    if (next === prevArtist) return
    setSavingArtistId(entryId)
    setEntries(prev => prev.map(e => e.id === entryId ? { ...e, artist: next } : e))
    try {
      await api.put(`/bk/entries/${entryId}`, { artist: next })
      showUndo(next ? `Artist set to "${next}"` : 'Cleared artist', async () => {
        await api.put(`/bk/entries/${entryId}`, { artist: prevArtist })
        setEntries(prev => prev.map(e => e.id === entryId ? { ...e, artist: prevArtist } : e))
      })
    } catch (err) {
      setEntries(prev => prev.map(e => e.id === entryId ? { ...e, artist: prevArtist } : e))
      toast.error('Failed to update artist: ' + (err.response?.data?.error || err.message))
    } finally { setSavingArtistId(null) }
  }

  // Move a due date from the row itself, rather than through the pencil's
  // whole-row edit. This page IS the due-date queue — it sorts strictly by this
  // column — so "when is this due" is the thing most often wrong on it, and
  // re-dating an invoice should not mean entering an edit mode over nine fields.
  //
  // Family-wide, and the server does the cascading: a vendor gives one date for
  // one invoice and the split into per-artist rows is our own bookkeeping, so
  // the sibling rows on this very page must not be left showing the old date.
  // (Measured before this shipped: 8 of 110 split families already held two
  // different due dates.) The local patch mirrors that so the list agrees with
  // the database without a refetch.
  const [savingDueId, setSavingDueId] = useState(null)
  const handleDueDateChange = async (entryId, nextDate) => {
    const entry = entries.find(e => e.id === entryId)
    if (!entry) return
    const prev = entry.scheduled_payment_date ? String(entry.scheduled_payment_date).slice(0, 10) : ''
    const next = nextDate || ''
    if (next === prev) return
    const rootId = entry.parent_id || entry.id
    const inFamily = (e) => e.id === rootId || e.parent_id === rootId
    const patch = (value) => setEntries(prevRows => prevRows.map(e =>
      (inFamily(e) ? { ...e, scheduled_payment_date: value || null } : e)))
    setSavingDueId(entryId)
    patch(next)
    try {
      await api.put(`/bk/entries/${entryId}`, { scheduled_payment_date: next || null })
      const siblings = entries.filter(e => inFamily(e) && e.id !== entryId).length
      showUndo(
        next
          ? `Due ${fmtDate(next)}${siblings ? ` (all ${siblings + 1} rows of this invoice)` : ''}`
          : 'Due date cleared',
        async () => {
          await api.put(`/bk/entries/${entryId}`, { scheduled_payment_date: prev || null })
          patch(prev)
        })
    } catch (err) {
      patch(prev)
      toast.error('Failed to update the due date: ' + (err.response?.data?.error || err.message))
    } finally { setSavingDueId(null) }
  }

  const handleRepChange = async (entryId, newRep) => {
    const entry = entries.find(e => e.id === entryId)
    const prevRep = entry?.boom_rep || ''
    if (prevRep === newRep) return
    setSavingRepId(entryId)
    setEntries(prev => prev.map(e => e.id === entryId ? { ...e, boom_rep: newRep } : e))
    try {
      await api.put(`/bk/entries/${entryId}`, { boom_rep: newRep })
      showUndo(newRep ? `Set rep to ${newRep}` : 'Cleared rep', async () => {
        await api.put(`/bk/entries/${entryId}`, { boom_rep: prevRep })
        setEntries(prev => prev.map(e => e.id === entryId ? { ...e, boom_rep: prevRep } : e))
      })
    } catch (err) {
      setEntries(prev => prev.map(e => e.id === entryId ? { ...e, boom_rep: prevRep } : e))
      toast.error('Failed to update rep: ' + (err.response?.data?.error || err.message))
    } finally { setSavingRepId(null) }
  }

  const handleMarkUnpaid = async (entryId) => {
    try {
      setSavingId(entryId)
      const entry = entries.find(e => e.id === entryId)
      const prevStatus = entry?.payment_status
      const prevDate = entry?.payment_date
      const prevPaidBy = entry?.paid_by
      const rootId = entry?.parent_id || entryId
      const inFamily = (e) => e.id === rootId || e.parent_id === rootId
      await api.put(`/bk/payments/${entryId}`, { payment_status: 'Unpaid', payment_date: null, paid_by: null })
      setEntries(prev => prev.map(e => inFamily(e) ? { ...e, payment_status: 'Unpaid', payment_date: null, paid_by: null } : e))
      showUndo(`Marked ${entry?.payee || 'invoice'} as unpaid`, async () => {
        await api.put(`/bk/payments/${entryId}`, { payment_status: prevStatus || 'Paid', payment_date: prevDate || null, paid_by: prevPaidBy || null })
        setEntries(prev => prev.map(e => inFamily(e) ? { ...e, payment_status: prevStatus || 'Paid', payment_date: prevDate || null, paid_by: prevPaidBy || null } : e))
      })
    } catch (err) { toast.error('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setSavingId(null) }
  }

  const handleBulkMarkPaid = async () => {
    // Filter to only the UNPAID selected rows — paid rows can now also be
    // selected (for the bulk Send Confirmation flow) but Mark Paid is a no-op
    // on them.
    const unpaidIds = entries.filter(e => selectedIds.has(e.id) && e.payment_status !== 'Paid').map(e => e.id)
    if (unpaidIds.length === 0) return
    // If multiple selected, show batch modal for payment details
    if (unpaidIds.length > 1) {
      // Defaulted ON only when the selection COULD be one payment — one vendor,
      // two or more invoices. Never guessed on for a mixed-vendor selection: a
      // declaration nobody made is the thing this feature exists to stop being
      // absent, and inventing one is worse than missing one.
      setBatchForm({ payment_method: '', payment_ref: '', one_payment: canBeOnePayment,
        payment_date: new Date().toISOString().split('T')[0] })
      setBatchProofFile(null)
      setShowBatchModal(true)
      return
    }
    // Single item — mark paid directly
    setSavingId('bulk')
    const today = new Date().toISOString().split('T')[0]
    try {
      const id = unpaidIds[0]
      const entry = entries.find(e => e.id === id)
      const prevSnap = { payment_status: entry?.payment_status, payment_date: entry?.payment_date, paid_by: entry?.paid_by }
      await api.put(`/bk/payments/${id}`, { payment_status: 'Paid', payment_date: today })
      setEntries(p => p.map(e => e.id === id ? { ...e, payment_status: 'Paid', payment_date: today } : e))
      promptStatement()
      if (entry?.rush_requested) startRushGracePeriod(id)
      setSelectedIds(s => { const n = new Set(s); n.delete(id); return n })
      showUndo(`Marked ${entry?.payee || 'invoice'} as paid`, async () => {
        await api.put(`/bk/payments/${id}`, { payment_status: prevSnap.payment_status || 'Unpaid', payment_date: prevSnap.payment_date || null, paid_by: prevSnap.paid_by || null })
        setEntries(p => p.map(e => e.id === id ? { ...e, ...prevSnap, payment_status: prevSnap.payment_status || 'Unpaid' } : e))
      })
    } catch (err) {
      const detail = err.response?.data?.error || err.message
      toast.error(detail ? `Failed to update — ${detail}` : 'Failed to update')
      console.error('mark-paid failed:', err.response?.data || err)
    }
    finally { setSavingId(null) }
  }

  const handleBatchConfirm = async () => {
    // Only the unpaid subset — paid rows in the selection are skipped here
    // (they belong to the bulk Send Confirmation flow).
    const affectedIds = entries.filter(e => selectedIds.has(e.id) && e.payment_status !== 'Paid').map(e => e.id)
    if (affectedIds.length === 0) return
    // Snapshotted BEFORE the writes: `selectedIds` is cleared further down, and
    // reading the roots off it afterwards would post an empty group.
    const rootIds = [...new Set(entries.filter(e => affectedIds.includes(e.id))
      .map(e => e.parent_id || e.id))]
    setSavingId('bulk')
    setShowBatchModal(false)
    const payload = {
      payment_status: 'Paid',
      payment_date: batchForm.payment_date || new Date().toISOString().split('T')[0],
    }
    if (batchForm.payment_method) payload.payment_method = batchForm.payment_method
    if (batchForm.payment_ref) payload.payment_ref = batchForm.payment_ref
    try {
      // Mark all as paid
      await Promise.all(affectedIds.map(id =>
        api.put(`/bk/payments/${id}`, payload)
      ))
      // Upload proof to all entries if provided
      if (batchProofFile) {
        await Promise.all(affectedIds.map(id => {
          const fd = new FormData()
          fd.append('file', batchProofFile)
          return api.post(`/bk/entries/${id}/file/proof`, fd, {
            headers: { 'Content-Type': 'multipart/form-data' }
          }).catch(() => {})
        }))
      }
      // Save previous state for undo
      const prevStates = {}
      affectedIds.forEach(id => {
        const e = entries.find(x => x.id === id)
        if (e) prevStates[id] = { payment_status: e.payment_status, payment_date: e.payment_date, paid_by: e.paid_by, payment_method: e.payment_method, payment_ref: e.payment_ref }
      })
      const affectedSet = new Set(affectedIds)
      // Grace-period any rush-flagged rows in the batch — same reason as
      // the single-row paths above: give the user a window to send
      // confirmation emails before the rows drop out of the Rush filter.
      for (const id of affectedIds) {
        if (entries.find(e => e.id === id)?.rush_requested) startRushGracePeriod(id)
      }
      setEntries(prev => prev.map(e => affectedSet.has(e.id) ? { ...e, ...payload, has_proof: batchProofFile ? true : e.has_proof } : e))
      setSelectedIds(s => { const n = new Set(s); for (const id of affectedIds) n.delete(id); return n })
      setBatchProofFile(null)

      // ── Declare the single payment ─────────────────────────────────────
      //
      // Runs only AFTER every mark-paid above resolved — the Promise.all would
      // have thrown otherwise and we would be in the catch. A half-applied batch
      // must never be recorded as one payment: that would tell the matcher to
      // settle a bank line with invoices that are not all paid.
      //
      // The group is what makes this reconcile later. Without it the statement
      // arrives as one debit and matches nothing, which is the state 300 live
      // invoices are already in.
      let group = null
      let groupError = null
      if (batchForm.one_payment && rootIds.length > 1) {
        try {
          const { data } = await api.post('/bk/settlement-groups', { expense_ids: rootIds })
          group = data?.data?.group || null
          setEntries(prev => prev.map(e =>
            rootIds.includes(e.parent_id || e.id) ? { ...e, settlement_group: group } : e))
        } catch (err) {
          // Said out loud. An invoice marked paid but NOT grouped is the failure
          // that reads as success — the batch says "8 paid" and the bank line
          // still matches nothing, with nothing anywhere explaining why.
          groupError = err.response?.data?.error || err.message
        }
      }
      if (groupError) {
        toast.error(`Marked paid, but not recorded as one payment — ${groupError}`)
      }

      showUndo(
        group
          ? `Paid ${affectedIds.length} invoices as one payment`
          : `Batch paid ${affectedIds.length} invoices`,
        async () => {
          // Undo takes the declaration back too. Leaving the group behind would
          // leave the matcher waiting for a payment that, as far as the ledger
          // now says, never went out.
          if (group) await api.delete(`/bk/settlement-groups/${group}`).catch(() => {})
          await Promise.all(affectedIds.map(id =>
            api.put(`/bk/payments/${id}`, prevStates[id] || { payment_status: 'Unpaid', payment_date: null, paid_by: null })
          ))
          setEntries(prev => prev.map(e => ({
            ...e,
            ...(prevStates[e.id] || {}),
            ...(group && rootIds.includes(e.parent_id || e.id) ? { settlement_group: null } : {}),
          })))
        })
    } catch (err) {
      // Say what the SERVER said. A bare "Failed to bulk update" hid a 500 —
      // "COALESCE types date and text cannot be matched" — for eight weeks,
      // because the one person who could act on the message never saw it.
      const detail = err.response?.data?.error || err.message
      toast.error(detail ? `Failed to bulk update — ${detail}` : 'Failed to bulk update')
      console.error('bulk mark-paid failed:', err.response?.data || err)
    }
    finally { setSavingId(null) }
  }

  const startEdit = (entry) => {
    setEditingId(entry.id)
    setEditForm({
      payee: entry.payee || '',
      artist: entry.artist || '',
      song: entry.song || '',
      amount: entry.amount || '',
      invoice_date: entry.invoice_date ? String(entry.invoice_date).slice(0, 10) : '',
      invoice_number: entry.invoice_number || '',
      category: entry.category || '',
      payment_method: entry.payment_method || '',
      notes: entry.notes || '',
      scheduled_payment_date: entry.scheduled_payment_date ? String(entry.scheduled_payment_date).slice(0, 10) : '',
      boom_rep: entry.boom_rep || '',
    })
  }

  const cancelEdit = () => { setEditingId(null); setEditForm({}) }

  const saveEdit = async (entryId) => {
    // Number('') === 0 — a cleared Amount field silently zeroed the invoice.
    const amt = Number(editForm.amount)
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error('Amount must be a number greater than zero.')
      return
    }
    setSavingEdit(true)
    try {
      await api.put(`/bk/entries/${entryId}`, {
        payee: editForm.payee,
        artist: editForm.artist,
        song: editForm.song,
        amount: Number(editForm.amount),
        invoice_date: editForm.invoice_date || null,
        invoice_number: editForm.invoice_number,
        category: editForm.category,
        payment_method: editForm.payment_method,
        notes: editForm.notes,
        scheduled_payment_date: editForm.scheduled_payment_date || null,
        boom_rep: editForm.boom_rep,
      })
      setEntries(prev => prev.map(e => e.id === entryId ? { ...e, ...editForm, amount: Number(editForm.amount) } : e))
      setEditingId(null)
      setEditForm({})
      showUndo('Entry updated', async () => { fetchEntries() })
    } catch (err) {
      toast.error('Failed to save: ' + (err.response?.data?.error || err.message))
    } finally { setSavingEdit(false) }
  }

  const handleDelete = async (entryId) => {
    const entry = entries.find(e => e.id === entryId)
    if (!window.confirm(`Delete entry for ${entry?.payee || 'this vendor'}? This can be restored from the ledger.`)) return
    setDeletingId(entryId)
    try {
      await api.delete(`/bk/entries/${entryId}`)
      setEntries(prev => prev.filter(e => e.id !== entryId))
      showUndo(`Deleted ${entry?.payee || 'entry'}`, async () => {
        await api.post(`/bk/entries/${entryId}/restore`)
        fetchEntries()
      })
    } catch (err) {
      toast.error('Failed to delete: ' + (err.response?.data?.error || err.message))
    } finally { setDeletingId(null) }
  }

  // Was an inline copy of the expense list; now the live vocabulary so the
  // inline editor can offer (and render) user-created categories.
  const EDIT_CATEGORIES = useCategories()

  // ── Vendors with more than one invoice waiting ────────────────────────────
  //
  // Worth flagging because several open invoices for one vendor is one transfer,
  // not several — and paying them separately means several sets of wire fees and
  // several chances to pay the same thing twice.
  //
  // Counted by FAMILY (`parent_id || id`), not by row. A split invoice is many
  // rows but ONE payable, and counting rows gets this exactly backwards: Music
  // Viral LLC shows 10 rows that are a single split invoice, so a row-based count
  // would urge you to batch something that is already one payment. Measured on
  // live data, rows would have falsely flagged 8 of 24 vendors.
  //
  // Derived from `entries` — the FULL set — never from `filtered`. If it followed
  // the filtered list, narrowing the view would silently change the counts and a
  // vendor could stop being flagged just because you'd clicked Overdue.
  //
  // On-hold rows are excluded: a held invoice isn't payable today, so including
  // it would describe a batch you can't actually send. The held count is carried
  // for the tooltip so it isn't simply hidden.
  const vendorOpen = useMemo(() => {
    const map = new Map()
    const keyOf = (e) => (e.payee || '').trim().toLowerCase()
    for (const e of entries) {
      if (e.payment_status === 'Paid') continue
      const k = keyOf(e)
      if (!k) continue
      let v = map.get(k)
      if (!v) { v = { families: new Map(), held: 0, currencies: new Set(), methods: new Set() }; map.set(k, v) }
      if (e.on_hold) { v.held += 1; continue }
      const root = e.parent_id || e.id
      v.families.set(root, (v.families.get(root) || 0) + Number(e.amount || 0))
      v.currencies.add((e.currency || 'USD').toUpperCase())
      if (e.payment_method) v.methods.add(e.payment_method)
    }
    const out = new Map()
    for (const [k, v] of map) {
      out.set(k, {
        count: v.families.size,
        total: [...v.families.values()].reduce((a, b) => a + b, 0),
        held: v.held,
        currencies: [...v.currencies],
        methods: [...v.methods],
      })
    }
    return out
  }, [entries])
  const openFor = (e) => vendorOpen.get((e.payee || '').trim().toLowerCase())

  // The four workflow filters, defined ONCE.
  //
  // `filtered` and the chip badges both have to answer "which rows are on
  // hold?", and until now each had its own typed copy — the comment above the
  // badges claimed they reused these predicates and they did not. A chip whose
  // number disagrees with the list it opens is worse than a chip with no
  // number, and adding MONEY to those badges is exactly the change that would
  // have made a drift expensive rather than merely wrong.
  //
  // Declared above `filtered`, not below it: a const read from inside a
  // useMemo that runs first is a temporal-dead-zone throw, and this page has
  // taken a white screen from that shape before.
  const workflowPredicates = useMemo(() => ({
    // Rush keeps a just-paid row visible for a moment (rushGraceIds) so the
    // queue doesn't yank a line out from under the person who just paid it.
    'Rush': (e) => e.rush_requested && (e.payment_status !== 'Paid' || rushGraceIds.has(e.id)),
    'Hold': (e) => e.on_hold && e.payment_status !== 'Paid',
    // Vendors holding more than one payable invoice — the batching worklist.
    'Multi-invoice': (e) => (vendorOpen.get((e.payee || '').trim().toLowerCase())?.count || 0) > 1,
    'Blocked': (e) => blockedReasons(e).length > 0,
  }), [vendorOpen, rushGraceIds])

  const filtered = useMemo(() => {
    let list = [...entries]
    if (quickFilter === 'Unpaid') list = list.filter(e => e.payment_status !== 'Paid')
    // Held rows drop out of Overdue + Due Soon — they're intentionally
    // paused, so treating them as "needs attention now" defeats the point.
    // They're still counted in Total Unpaid via the summary stats (money
    // owed is money owed).
    else if (quickFilter === 'Overdue') list = list.filter(e => isOverdue(e) && !e.on_hold)
    else if (quickFilter === 'Due Soon') list = list.filter(e => isDueSoon(e) && !e.on_hold)
    else if (quickFilter === 'Paid') list = list.filter(e => e.payment_status === 'Paid')
    // Rush / Hold / Multi-invoice / Blocked — the same functions the chips
    // above reduce over, so the badge and this list cannot disagree.
    else if (workflowPredicates[quickFilter]) list = list.filter(workflowPredicates[quickFilter])
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(e =>
        (e.payee || '').toLowerCase().includes(q) ||
        (e.artist || '').toLowerCase().includes(q) ||
        (e.invoice_number || '').toLowerCase().includes(q)
      )
    }
    // Amount filter — supports "500", "500-1000", ">500", "<=250".
    // parseAmountQuery returns null for empty / invalid input, so a
    // typo won't wipe the list.
    const amountMatcher = parseAmountQuery(amountQuery)
    if (amountMatcher) list = list.filter(e => amountMatcher(Number(e.amount)))
    if (methodFilter !== 'All') list = list.filter(e => e.payment_method === methodFilter)
    if (statusFilter !== 'All') list = list.filter(e => e.payment_status === statusFilter)
    if (repFilter !== 'All') list = list.filter(e => repFilter === 'No rep' ? !e.boom_rep : e.boom_rep === repFilter)

    // Sort
    if (sortBy === 'Priority') {
      // Band first (see priorityBand), then the oldest obligation inside the
      // band, then the largest. Tiebreak on id so the order is stable across
      // re-renders — without it two rows sharing a due date can swap places
      // every time the list recomputes.
      list.sort((a, b) => {
        const ab = priorityBand(a), bb = priorityBand(b)
        if (ab !== bb) return ab - bb
        // Paid rows read newest-first. "What did we just pay" is the question
        // asked of them; "which is oldest" is the question asked of the queue.
        if (ab === BAND_PAID) {
          const aP = a.payment_date || '0000'
          const bP = b.payment_date || '0000'
          if (aP !== bP) return aP < bP ? 1 : -1
          return (b.id || 0) - (a.id || 0)
        }
        const aDate = a.scheduled_payment_date || '9999'
        const bDate = b.scheduled_payment_date || '9999'
        if (aDate !== bDate) return aDate < bDate ? -1 : 1
        const byAmount = sortableUsd(b, fxRates) - sortableUsd(a, fxRates)
        if (byAmount) return byAmount
        return (a.id || 0) - (b.id || 0)
      })
    } else if (sortBy === 'Due Date') {
      // Strict ascending by scheduled_payment_date. Net-30 backfill on the
      // server means every row should have one; the '9999' sentinel only
      // kicks in for truly date-less edge cases (invoice_date also null),
      // which we shove to the end. Tiebreakers: invoice_date, then id.
      list.sort((a, b) => {
        const aDate = a.scheduled_payment_date || '9999'
        const bDate = b.scheduled_payment_date || '9999'
        if (aDate !== bDate) return aDate < bDate ? -1 : 1
        const aInv = a.invoice_date || '9999'
        const bInv = b.invoice_date || '9999'
        if (aInv !== bInv) return aInv < bInv ? -1 : 1
        return (a.id || 0) - (b.id || 0)
      })
    } else if (sortBy === 'Amount: high to low' || sortBy === 'Amount: low to high') {
      // (b - a) is already descending, so "high to low" is dir = 1. The
      // old dir = -1 had both amount sorts inverted.
      const dir = sortBy === 'Amount: high to low' ? 1 : -1
      list.sort((a, b) => dir * (sortableUsd(b, fxRates) - sortableUsd(a, fxRates)))
    } else if (sortBy === 'Payee A-Z') {
      list.sort((a, b) => (a.payee || '').localeCompare(b.payee || ''))
    } else if (sortBy === 'Date Added') {
      list.sort((a, b) => {
        const aD = a.invoice_date || '0000'
        const bD = b.invoice_date || '0000'
        return bD < aD ? -1 : bD > aD ? 1 : 0
      })
    } else if (sortBy === 'Recently Paid') {
      list.sort((a, b) => {
        const aD = a.payment_date || '0000'
        const bD = b.payment_date || '0000'
        return bD < aD ? -1 : bD > aD ? 1 : (b.id - a.id)
      })
    }

    // Keep split children immediately under their parent regardless of sort.
    // Same flatten pattern used on the Ledger page: parents present in the
    // filtered list anchor their children; children whose parent dropped out
    // (different filter/status) are surfaced as their own rows.
    const inSet = new Set(list.map(e => e.id))
    const childrenOf = {}
    const roots = []
    list.forEach(e => {
      if (e.parent_id && inSet.has(e.parent_id)) {
        (childrenOf[e.parent_id] = childrenOf[e.parent_id] || []).push(e)
      } else {
        roots.push(e)
      }
    })
    const flat = []
    roots.forEach(e => { flat.push(e); (childrenOf[e.id] || []).forEach(c => flat.push(c)) })
    return flat
    // vendorOpen only changes with `entries`, which is already a dep — listed
    // explicitly so the Multi-invoice branch can't be broken by a future edit
    // that decouples the two.
  }, [entries, vendorOpen, search, amountQuery, methodFilter, statusFilter, repFilter, quickFilter, sortBy, fxRates, rushGraceIds, workflowPredicates])

  // Rep filter options: configured reps plus any legacy values still on entries
  const repOptions = useMemo(() => {
    const set = new Set(BOOM_REPS)
    entries.forEach(e => { if (e.boom_rep) set.add(e.boom_rep) })
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [entries, BOOM_REPS])

  // Stats
  // Total Unpaid includes held rows (money owed is money owed). Overdue
  // and Due Soon exclude held rows — they mirror the quick-filter
  // semantics so the numbers on the cards match the counts you get
  // when you click them.
  const unpaidEntries = entries.filter(e => e.payment_status !== 'Paid')
  const overdueEntries = entries.filter(e => isOverdue(e) && !e.on_hold)
  const dueSoonEntries = entries.filter(e => isDueSoon(e) && !e.on_hold)
  // This card used to read "paid this month" and count payment_date inside the
  // current calendar month. It could never be that: the page is scoped
  // SERVER-side to unpaid plus the last 14 days paid, so on the 28th the card
  // claimed a month while holding a fortnight, and under-reported without
  // saying so. It now counts what the page actually has, and says so — which
  // also makes it equal to the `Paid` filter it now clicks through to.
  const paidRecent = entries.filter(e => e.payment_status === 'Paid')
  // Per-currency totals — never blindly add €500 to a USD bucket. fmtTotals
  // shows the native breakdown; usdTotalSuffix adds the ≈USD equivalent.
  const totalUnpaid = groupByCurrency(unpaidEntries)
  const totalOverdue = groupByCurrency(overdueEntries)
  const totalDueSoon = groupByCurrency(dueSoonEntries)
  const totalPaidRecent = groupByCurrency(paidRecent)

  // The chip badges — HOW MUCH, then how many.
  //
  // John, 2026-09-15: "I want to be able to see the amount that is labeled
  // rush, amount labeled as hold." A count answers how many lines are waiting;
  // it does not say whether Rush is $4,000 or $400,000, which is the thing that
  // decides what you do this afternoon. Every other headline on this page is
  // money and these four were the exception.
  //
  // Reduced over the SAME predicate functions `filtered` applies, so the
  // number on the chip is a promise about the list it opens — the rule the
  // stat cards above already hold themselves to.
  //
  // Over `entries`, so they describe the whole queue exactly as the cards do.
  // Search / method / rep narrow the list below without moving these; a
  // scoreboard that follows the search box is a second copy of the list.
  const workflowFilterStats = useMemo(() => {
    const out = {}
    for (const [key, pred] of Object.entries(workflowPredicates)) {
      const items = entries.filter(pred)
      out[key] = {
        n: items.length,
        // USD-equivalent headline, honouring each row's locked fx_rate_to_usd —
        // the same helper and the same precedence as the stat cards, so Rush
        // and OVERDUE cannot value one euro two ways.
        usd: fmtUsdItems(items, fxRates),
        // The native breakdown for the tooltip. A chip has no room for
        // "$126,000 + €2,400", and rendering only the converted figure with no
        // way to see what it is made of is how a mixed-currency total starts
        // reading as dollars. Absent when everything is USD — there is nothing
        // to disclose then.
        native: items.some(e => (e.currency || 'USD').toUpperCase() !== 'USD')
          ? fmtTotals(groupByCurrency(items)) : '',
      }
    }
    return out
  }, [entries, workflowPredicates, fxRates])
  const totalAll = groupByCurrency(entries)

  // Grouping
  // Groups are emitted in the order their FIRST row appears in `filtered`, so
  // whatever the sort decided still governs: under Priority, the vendor holding
  // the most urgent invoice heads the list. A Map, not an object literal —
  // integer-like keys (a payee named "88 Ventures", a numeric method) reorder
  // themselves in plain objects, which would silently undo that.
  const grouped = useMemo(() => {
    // Priority mode labels its own bands when nothing else is grouping, which
    // is what makes the queue readable top-down: the header says WHY a row is
    // where it is. An explicit grouping choice wins over it.
    if (groupBy === 'No grouping') {
      if (sortBy !== 'Priority' || !filtered.length) return [{ label: null, items: filtered }]
      // A split child inherits the band of the parent it is rendered under, so
      // a family is never torn across two headers. `filtered` has already
      // anchored children beneath their parent; only a child whose parent fell
      // outside this page's 14-day scope stands alone, and that one bands on
      // its own values.
      const byId = new Map(filtered.map(e => [e.id, e]))
      const bands = new Map()
      for (const e of filtered) {
        const anchor = (e.parent_id != null && byId.has(e.parent_id)) ? byId.get(e.parent_id) : e
        const band = priorityBand(anchor)
        if (!bands.has(band)) bands.set(band, [])
        bands.get(band).push(e)
      }
      // A single band means the label explains nothing — the quick filters land
      // here constantly (the Rush chip is one band by construction).
      if (bands.size < 2) return [{ label: null, items: filtered }]
      return [...bands.entries()].map(([band, items]) => ({ label: BAND_LABELS[band], items }))
    }

    if (groupBy === 'Group by Vendor') {
      const groups = new Map()
      filtered.forEach(e => {
        // Same key the page's own vendor rollup uses, so a group and the
        // per-row "N open" badge can never disagree about who one vendor is.
        const key = (e.payee || '').trim().toLowerCase()
        let g = groups.get(key)
        if (!g) { g = { label: e.payee || 'Unknown vendor', items: [], vendor: true }; groups.set(key, g) }
        g.items.push(e)
      })
      return [...groups.values()]
    }

    const key = groupBy === 'Group by Method' ? 'payment_method' : 'payment_status'
    const groups = new Map()
    filtered.forEach(e => {
      const g = e[key] || 'Unknown'
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g).push(e)
    })
    return [...groups.entries()].map(([label, items]) => ({ label, items }))
  }, [filtered, groupBy, sortBy])

  const toggleSelect = (id) => {
    const s = new Set(selectedIds)
    if (s.has(id)) s.delete(id); else s.add(id)
    setSelectedIds(s)
  }
  const selectAll = () => {
    // Membership check, not count equality — paid rows are also selectable
    // (bulk confirmations), so N selected paid rows used to make this read
    // as "all selected" and CLEAR the selection instead of selecting.
    const unpaid = filtered.filter(e => e.payment_status !== 'Paid')
    const allSelected = unpaid.length > 0 && unpaid.every(e => selectedIds.has(e.id))
    if (allSelected) {
      setSelectedIds(prev => { const n = new Set(prev); unpaid.forEach(e => n.delete(e.id)); return n })
    } else {
      setSelectedIds(prev => { const n = new Set(prev); unpaid.forEach(e => n.add(e.id)); return n })
    }
  }
  // Vendor group header action: take this vendor's payable rows as the whole
  // selection and open the batch dialog on them — the click it replaces is
  // ticking a checkbox per row. Measured on the live queue: 21 vendors hold
  // more than one payable INVOICE (families, not rows — a split invoice is
  // still one thing to pay), covering 63 of them, the largest carrying seven.
  //
  // HELD rows are excluded. A hold is a deliberate pause, and sweeping one
  // into a batch payment because it shares a payee would defeat it silently.
  // The vendor rollup that feeds the per-row badge draws the same line, so the
  // header's count and the badge's count agree.
  const payVendorTogether = (rows) => {
    const payable = rows.filter(e => e.payment_status !== 'Paid' && !e.on_hold)
    if (payable.length < 2) return
    setSelectedIds(new Set(payable.map(e => e.id)))
    const rootIds = new Set(payable.map(e => e.parent_id || e.id))
    setBatchForm({
      payment_method: '', payment_ref: '',
      // One vendor by construction, so this is exactly `canBeOnePayment` —
      // deliberately not a second, more clever rule about what may be paid
      // together. Still a default the user can clear before writing.
      one_payment: rootIds.size > 1,
      payment_date: new Date().toISOString().split('T')[0],
    })
    setBatchProofFile(null)
    setShowBatchModal(true)
  }
  // Paid + has proof + vendor email + confirmation not yet sent. These rows
  // are the eligibility set for the bulk Send Confirmation action (which
  // groups by vendor_email into one combined email per vendor).
  const isPendingConfirmation = (e) =>
    e.payment_status === 'Paid' && e.has_proof && e.vendor_email && !e.confirmation_sent
  const selectAllPendingConfirmations = () => {
    const pending = filtered.filter(isPendingConfirmation)
    const ids = new Set(pending.map(e => e.id))
    const allAlreadySelected = pending.length > 0 && pending.every(e => selectedIds.has(e.id))
    if (allAlreadySelected) {
      const next = new Set(selectedIds)
      for (const id of ids) next.delete(id)
      setSelectedIds(next)
    } else {
      const next = new Set(selectedIds)
      for (const id of ids) next.add(id)
      setSelectedIds(next)
    }
  }

  // Child-total lookup: parent id -> sum of ALL its children's amounts.
  // How much of each split family is actually ON THIS PAGE. Built from
  // `entries` (not `filtered`) so a client-side filter that hides a child
  // doesn't make the parent's collapsed total undercount.
  //
  // The COUNT is the load-bearing part. This page is scoped SERVER-side to
  // unpaid + paid-in-the-last-14-days, so a split parent can be here while its
  // children are not — the family straddles the window. Before this, the page
  // rendered an expand triangle for those parents with nothing behind it:
  // clicking did nothing, which is exactly what "splits don't expand" looks
  // like from the outside.
  const familyOnPage = useMemo(() => {
    const map = {}
    for (const e of entries) {
      if (!e.parent_id) continue
      const m = map[e.parent_id] || (map[e.parent_id] = { sum: 0, count: 0 })
      m.sum += parseFloat(e.amount || 0)
      m.count += 1
    }
    return map
  }, [entries])

  // Which rows the page actually holds — a child whose PARENT is out of scope
  // has no parent row to expand, so it has to stand on its own.
  const idsOnPage = useMemo(() => new Set(entries.map(e => e.id)), [entries])

  const selectedEntries = filtered.filter(e => selectedIds.has(e.id))
  // Subset used by approval + mark-paid flows — paid rows in the selection
  // belong to the bulk Send Confirmation flow and shouldn't be counted here.
  const selectedUnpaidEntries = selectedEntries.filter(e => e.payment_status !== 'Paid')
  // Selection totals are family-aware: a split invoice is summed at its
  // family total (matching what the row displays) — selecting both parent
  // and child of the same family counts once.
  const selectedTotals = groupByCurrencyByFamily(selectedEntries)
  const filteredUnpaidTotals = groupByCurrencyByFamily(filtered.filter(e => e.payment_status !== 'Paid'))
  const selectedTotalsDisplay = fmtTotals(selectedTotals)
  const filteredUnpaidTotalsDisplay = fmtTotals(filteredUnpaidTotals)
  const selectedUnpaidTotalsDisplay = fmtTotals(groupByCurrencyByFamily(selectedUnpaidEntries))

  // ── "These went out as ONE payment" ──────────────────────────────────────
  //
  // The batch flow already marks N invoices Paid with a shared date, method and
  // reference. What it never recorded is that they were a SINGLE payment — and
  // that is the fact the bank statement needs. Every matcher tier pairs 1:1 on an
  // amount equal to the cent, so one wire covering eight invoices matches
  // NOTHING: each invoice is smaller than the debit.
  //
  // Measured on production 2026-08-28: 112 batches covering 300 paid invoices
  // worth $473,714.58 share a payee and a paid date — almost certainly one wire
  // each — and exactly ZERO of them carry a settlement group.
  //
  // Declaring it here writes that group (POST /bk/settlement-groups), which the
  // matcher then settles against the single debit when the statement lands.
  //
  // FAMILY ROOTS, not the selected rows: a split invoice settles as one payment
  // at its root, and the server refuses a child outright ("group its parent").
  const selectedUnpaidRootIds = [...new Set(selectedUnpaidEntries.map(e => e.parent_id || e.id))]
  // One payment goes to ONE payee, so a selection spanning two vendors cannot be
  // one payment. Squashed the same way the server's validator squashes it, so
  // the checkbox and the endpoint agree about what "same vendor" means.
  const vendorKey = (e) => String(e.payee || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  const selectedVendors = [...new Set(selectedUnpaidEntries.map(vendorKey).filter(Boolean))]
  const oneVendor = selectedVendors.length === 1
  const canBeOnePayment = oneVendor && selectedUnpaidRootIds.length > 1
  // Per-vendor totals, for the modal to show WHY it cannot be one payment.
  const selectedByVendor = (() => {
    const m = new Map()
    for (const e of selectedUnpaidEntries) {
      const k = vendorKey(e)
      if (!m.has(k)) m.set(k, { payee: e.payee, rows: [] })
      m.get(k).rows.push(e)
    }
    return [...m.values()]
  })()

  // Approval emails are sent per-INVOICE (family), not per-slice. The dashboard
  // hides split children under a collapsed parent, so the user usually selects
  // only the parent — whose `amount` is just its own slice. Expand each
  // selected unpaid row to its full family (parent + every child, pulled from
  // `entries` which carries them all) so the preview totals match the server-
  // rendered email, which does the same expansion. Deduped by id.
  const approvalFamilyEntries = (() => {
    const out = []
    const seen = new Set()
    const add = (e) => { if (e && !seen.has(e.id)) { seen.add(e.id); out.push(e) } }
    for (const e of selectedUnpaidEntries) {
      const rootId = e.parent_id || e.id
      for (const x of entries) {
        if (x.id === rootId || x.parent_id === rootId) add(x)
      }
    }
    return out
  })()
  // Distinct invoices (families) in the selection — what the approver actually approves.
  const approvalInvoiceCount = new Set(selectedUnpaidEntries.map(e => e.parent_id || e.id)).size
  const approvalGrandTotalDisplay = fmtTotals(groupByCurrency(approvalFamilyEntries))

  // Artist totals for the "Send for Approval" preview — grouped by (artist, currency).
  // Built from the family-expanded set so per-artist slices of a split invoice
  // are all represented and reconcile to the full grand total.
  const artistTotals = (() => {
    const map = {}
    for (const e of approvalFamilyEntries) {
      const artist = (e.artist && e.artist.trim()) || '(no artist)'
      const cur = e.currency || 'USD'
      const key = artist + '||' + cur
      if (!map[key]) map[key] = { artist, currency: cur, amount: 0 }
      map[key].amount += parseFloat(e.amount || 0)
    }
    return Object.values(map).sort((a, b) => {
      if (a.artist === b.artist) return a.currency === 'USD' ? -1 : b.currency === 'USD' ? 1 : a.currency.localeCompare(b.currency)
      return b.amount - a.amount
    })
  })()
  // How many UNIQUE invoice PDFs will be attached (splits share a parent PDF)
  const selectedWithPdf = new Set(
    selectedUnpaidEntries.filter(e => e.has_invoice).map(e => e.file_entry_id || e.id)
  ).size

  const defaultApprovalMessage = (recipients) => {
    return `Hey team,\n\nHere are some pending invoices for your approval. Summary is attached as an excel with pdfs for each invoice. Let me know if you have any questions.`
  }

  // Default subject mirrors the server fallback: "<n> line items for approval
  // — <total> total". Computed client-side from the current selection so the
  // field is pre-filled the moment the modal opens; the user can overwrite it.
  const defaultApprovalSubject = () => {
    const n = approvalInvoiceCount
    return `${n} invoice${n === 1 ? '' : 's'} for approval — ${approvalGrandTotalDisplay} total`
  }

  // When the modal opens, seed the message + subject from the defaults.
  // When the recipient changes, refresh the greeting unless the user edited it.
  useEffect(() => {
    if (showApprovalModal) {
      setApprovalMessage(defaultApprovalMessage(approvalRecipients))
      setMessageEdited(false)
      setApprovalSubject(defaultApprovalSubject())
    }
  }, [showApprovalModal]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (showApprovalModal && !messageEdited) {
      setApprovalMessage(defaultApprovalMessage(approvalRecipients))
    }
  }, [approvalRecipients]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSendApproval = async () => {
    // Approval emails are about unpaid invoices — drop any paid rows the
    // user may have selected for the confirmation flow.
    const ids = entries.filter(e => selectedIds.has(e.id) && e.payment_status !== 'Paid').map(e => e.id)
    if (ids.length === 0) return
    setSendingApproval(true)
    try {
      // Two-step flow: dry_run returns the rendered HTML + recipients, then
      // we open EmailPreviewModal so the admin can review + edit inline.
      const preview = await api.post('/bk/payments/send-approval-email', {
        ids,
        recipients: approvalRecipients,
        body: approvalMessage,
        subject: approvalSubject.trim() || undefined,
        dry_run: true,
      })
      const d = preview.data?.data || {}
      setApprovalPreview({
        ids,
        recipients: approvalRecipients,
        body: approvalMessage,
        to: d.to,
        cc: d.cc,
        // Prefer the user's edited subject; fall back to whatever the server
        // rendered (which already honors subjectOverride when we sent one).
        subject: approvalSubject.trim() || d.subject,
        html: d.html,
        attachmentLabels: d.attachmentLabels || [],
        count: d.count,
      })
      setShowApprovalModal(false)
    } catch (err) {
      toast.error('Failed to load preview: ' + (err.response?.data?.error || err.message))
    } finally { setSendingApproval(false) }
  }

  if (loading) {
    const Sk = ({ w = 'w-full', h = 'h-3' }) => <div className={`animate-pulse bg-gray-200 rounded ${w} ${h}`} />
    return (
      <div style={{ minHeight: '100%', background: C.pageBg }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '28px 24px' }} className="space-y-6">
          <div className="space-y-2"><Sk w="w-48" h="h-7" /><Sk w="w-72" h="h-3" /></div>
          <div className="grid grid-cols-5 gap-3">
            {[1,2,3,4,5].map(i => <div key={i} className="card px-4 py-4 space-y-2"><Sk w="w-20" h="h-2" /><Sk w="w-16" h="h-6" /></div>)}
          </div>
          <div className="card p-4 space-y-3"><Sk w="w-24" h="h-5" /><Sk w="w-full" h="h-8" /></div>
          <div className="space-y-2">{[1,2,3,4,5].map(i => <div key={i} className="flex gap-4 p-3"><Sk w="w-16" /><Sk w="w-32" /><Sk w="w-20" /><Sk w="w-16" /><Sk w="w-16" /></div>)}</div>
        </div>
      </div>
    )
  }

  // Shared overlays — modals, file preview, undo toast. Rendered by BOTH
  // the desktop and mobile trees so the mobile branch reuses the same
  // batch-paid / rush / hold / approval / confirmation flows.
  const overlays = (
    <>
      {/* Rush-payment request modal */}
      {rushModalEntry && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={() => { if (!submittingRush) { setRushModalEntry(null); setRushReason('') } }}
        >
          <div
            style={{ background: C.cardBg, borderRadius: 12, padding: 28, width: 440, boxShadow: C.shadow, color: C.text }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: '#fef3c7', color: '#92400e', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Zap style={{ width: 18, height: 18 }} fill="currentColor" />
              </div>
              <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>Request Rush Payment</h3>
            </div>
            <p style={{ color: C.textMuted, fontSize: 13, margin: '8px 0 18px', lineHeight: 1.5 }}>
              This flags the invoice on the Payment Dashboard and surfaces it under the Rush quick-filter. Adding a reason helps the payer prioritise.
            </p>
            <div style={{ background: C.elevBg, border: '1px solid ' + C.border, borderRadius: 8, padding: '10px 12px', marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>Invoice</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                {rushModalEntry.payee || rushModalEntry.vendor_name || '—'}
                <span style={{ fontWeight: 500, color: C.textMuted, marginLeft: 8 }}>
                  {fmt(rushModalEntry.amount, rushModalEntry.currency)}
                </span>
              </div>
              {rushModalEntry.invoice_number && (
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                  Invoice #{rushModalEntry.invoice_number}
                </div>
              )}
            </div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: C.textMuted, marginBottom: 4 }}>
              Reason <span style={{ color: '#bbb', fontWeight: 400 }}>— optional, but helps</span>
            </label>
            <textarea
              autoFocus
              value={rushReason}
              onChange={e => setRushReason(e.target.value.slice(0, 500))}
              placeholder="e.g. Vendor leaving for tour Friday, needs payment confirmed first"
              rows={3}
              style={{
                ...inputSty, width: '100%', resize: 'vertical', minHeight: 64,
                fontFamily: 'inherit', lineHeight: 1.5,
              }}
            />
            <div style={{ fontSize: 10, color: C.textFaint, textAlign: 'right', marginTop: 2 }}>
              {rushReason.length}/500
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button
                onClick={submitRushRequest}
                disabled={submittingRush}
                style={{
                  background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 8,
                  padding: '10px 20px', fontSize: 13, fontWeight: 800, fontFamily: 'inherit',
                  cursor: submittingRush ? 'not-allowed' : 'pointer',
                  flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  opacity: submittingRush ? 0.6 : 1,
                }}
              >
                {submittingRush ? <Loader style={{ width: 14, height: 14, animation: 'spin 0.8s linear infinite' }} /> : <Zap style={{ width: 14, height: 14 }} fill="currentColor" />}
                {submittingRush ? 'Sending…' : 'Request Rush'}
              </button>
              <button
                onClick={() => { if (!submittingRush) { setRushModalEntry(null); setRushReason('') } }}
                disabled={submittingRush}
                style={{
                  background: C.elevBg, color: C.text, border: 'none', borderRadius: 8,
                  padding: '10px 20px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                  cursor: submittingRush ? 'not-allowed' : 'pointer',
                  opacity: submittingRush ? 0.5 : 1,
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Rush modal — mirrors the single-row rush modal chrome but
          summarises the selected eligible rows (count + currency-grouped
          totals + a preview of payees) instead of one specific invoice.
          Server enforces ineligible-row skipping; client just filters
          for sane UX. */}
      {bulkRushOpen && (() => {
        const eligible = entries.filter(e =>
          selectedIds.has(e.id) &&
          e.payment_status !== 'Paid' &&
          !e.rush_requested
        )
        // Group native amounts by currency so an EUR + USD bulk doesn't
        // misleadingly sum across currencies.
        const totalsByCurrency = {}
        for (const e of eligible) {
          const cur = e.currency || 'USD'
          totalsByCurrency[cur] = (totalsByCurrency[cur] || 0) + parseFloat(e.amount || 0)
        }
        const totalsLine = Object.entries(totalsByCurrency)
          .filter(([, v]) => v)
          .sort(([a], [b]) => a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b))
          .map(([cur, amt]) => `${cur} ${amt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
          .join(' + ')
        // Show the first three payees as a "preview" so the user can
        // sanity-check they're rushing what they think they're rushing.
        const previewPayees = eligible.slice(0, 3).map(e => e.payee || e.vendor_name || '—')
        const remaining = eligible.length - previewPayees.length
        return (
          <div
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
            onClick={() => { if (!submittingBulkRush) { setBulkRushOpen(false); setBulkRushReason('') } }}
          >
            <div
              style={{ background: C.cardBg, borderRadius: 12, padding: 28, width: 460, boxShadow: C.shadow, color: C.text }}
              onClick={e => e.stopPropagation()}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: '#fef3c7', color: '#92400e', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Zap style={{ width: 18, height: 18 }} fill="currentColor" />
                </div>
                <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>Request Rush on {eligible.length} Payment{eligible.length === 1 ? '' : 's'}</h3>
              </div>
              <p style={{ color: C.textMuted, fontSize: 13, margin: '8px 0 18px', lineHeight: 1.5 }}>
                Each invoice gets a RUSH badge on the dashboard and surfaces under the Rush quick-filter. Adding a reason gives the payer context.
              </p>
              <div style={{ background: C.elevBg, border: '1px solid ' + C.border, borderRadius: 8, padding: '10px 12px', marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>Total</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{totalsLine || '—'}</div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6 }}>
                  {previewPayees.join(', ')}
                  {remaining > 0 ? ` + ${remaining} more` : ''}
                </div>
              </div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: C.textMuted, marginBottom: 4 }}>
                Reason <span style={{ color: '#bbb', fontWeight: 400 }}>— optional, applied to all</span>
              </label>
              <textarea
                autoFocus
                value={bulkRushReason}
                onChange={e => setBulkRushReason(e.target.value.slice(0, 500))}
                placeholder="e.g. Quarter-end deadline — these all need to clear before Friday"
                rows={3}
                style={{
                  ...inputSty, width: '100%', resize: 'vertical', minHeight: 64,
                  fontFamily: 'inherit', lineHeight: 1.5,
                }}
              />
              <div style={{ fontSize: 10, color: C.textFaint, textAlign: 'right', marginTop: 2 }}>
                {bulkRushReason.length}/500
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
                <button
                  onClick={submitBulkRushRequest}
                  disabled={submittingBulkRush || eligible.length === 0}
                  style={{
                    background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 8,
                    padding: '10px 20px', fontSize: 13, fontWeight: 800, fontFamily: 'inherit',
                    cursor: submittingBulkRush ? 'not-allowed' : 'pointer',
                    flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    opacity: submittingBulkRush ? 0.6 : 1,
                  }}
                >
                  {submittingBulkRush ? <Loader style={{ width: 14, height: 14, animation: 'spin 0.8s linear infinite' }} /> : <Zap style={{ width: 14, height: 14 }} fill="currentColor" />}
                  {submittingBulkRush ? 'Sending…' : `Request Rush (${eligible.length})`}
                </button>
                <button
                  onClick={() => { if (!submittingBulkRush) { setBulkRushOpen(false); setBulkRushReason('') } }}
                  disabled={submittingBulkRush}
                  style={{
                    background: C.elevBg, color: C.text, border: 'none', borderRadius: 8,
                    padding: '10px 20px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                    cursor: submittingBulkRush ? 'not-allowed' : 'pointer',
                    opacity: submittingBulkRush ? 0.5 : 1,
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Hold modal — mirrors the rush modal. Reason is optional. */}
      {holdModalEntry && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={() => { if (!submittingHold) { setHoldModalEntry(null); setHoldReason('') } }}
        >
          <div
            style={{ background: C.cardBg, borderRadius: 12, padding: 28, width: 440, boxShadow: C.shadow, color: C.text }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: '#f1f5f9', color: '#475569', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Pause style={{ width: 18, height: 18 }} fill="currentColor" />
              </div>
              <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>Place Payment on Hold</h3>
            </div>
            <p style={{ color: C.textMuted, fontSize: 13, margin: '8px 0 18px', lineHeight: 1.5 }}>
              Held payments drop out of the Overdue and Due Soon views but remain in Total Unpaid. Adding a reason gives context to anyone reviewing the row later.
            </p>
            <div style={{ background: C.elevBg, border: '1px solid ' + C.border, borderRadius: 8, padding: '10px 12px', marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>Invoice</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                {holdModalEntry.payee || holdModalEntry.vendor_name || '—'}
                <span style={{ fontWeight: 500, color: C.textMuted, marginLeft: 8 }}>
                  {fmt(holdModalEntry.amount, holdModalEntry.currency)}
                </span>
              </div>
              {holdModalEntry.invoice_number && (
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                  Invoice #{holdModalEntry.invoice_number}
                </div>
              )}
            </div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: C.textMuted, marginBottom: 4 }}>
              Reason <span style={{ color: '#bbb', fontWeight: 400 }}>— optional</span>
            </label>
            <textarea
              autoFocus
              value={holdReason}
              onChange={e => setHoldReason(e.target.value.slice(0, 500))}
              placeholder="e.g. Waiting on artist confirmation for the line-item breakdown"
              rows={3}
              style={{
                ...inputSty, width: '100%', resize: 'vertical', minHeight: 64,
                fontFamily: 'inherit', lineHeight: 1.5,
              }}
            />
            <div style={{ fontSize: 10, color: C.textFaint, textAlign: 'right', marginTop: 2 }}>
              {holdReason.length}/500
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button
                onClick={submitHoldRequest}
                disabled={submittingHold}
                style={{
                  background: '#64748b', color: '#fff', border: 'none', borderRadius: 8,
                  padding: '10px 20px', fontSize: 13, fontWeight: 800, fontFamily: 'inherit',
                  cursor: submittingHold ? 'not-allowed' : 'pointer',
                  flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  opacity: submittingHold ? 0.6 : 1,
                }}
              >
                {submittingHold ? <Loader style={{ width: 14, height: 14, animation: 'spin 0.8s linear infinite' }} /> : <Pause style={{ width: 14, height: 14 }} fill="currentColor" />}
                {submittingHold ? 'Placing…' : 'Place Hold'}
              </button>
              <button
                onClick={() => { if (!submittingHold) { setHoldModalEntry(null); setHoldReason('') } }}
                disabled={submittingHold}
                style={{
                  background: C.elevBg, color: C.text, border: 'none', borderRadius: 8,
                  padding: '10px 20px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                  cursor: submittingHold ? 'not-allowed' : 'pointer',
                  opacity: submittingHold ? 0.5 : 1,
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Hold modal — mirrors Bulk Rush chrome + summary block. */}
      {bulkHoldOpen && (() => {
        const eligible = entries.filter(e =>
          selectedIds.has(e.id) &&
          e.payment_status !== 'Paid' &&
          !e.on_hold
        )
        const totalsByCurrency = {}
        for (const e of eligible) {
          const cur = e.currency || 'USD'
          totalsByCurrency[cur] = (totalsByCurrency[cur] || 0) + parseFloat(e.amount || 0)
        }
        const totalsLine = Object.entries(totalsByCurrency)
          .filter(([, v]) => v)
          .sort(([a], [b]) => a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b))
          .map(([cur, amt]) => `${cur} ${amt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
          .join(' + ')
        const previewPayees = eligible.slice(0, 3).map(e => e.payee || e.vendor_name || '—')
        const remaining = eligible.length - previewPayees.length
        return (
          <div
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
            onClick={() => { if (!submittingBulkHold) { setBulkHoldOpen(false); setBulkHoldReason('') } }}
          >
            <div
              style={{ background: C.cardBg, borderRadius: 12, padding: 28, width: 460, boxShadow: C.shadow, color: C.text }}
              onClick={e => e.stopPropagation()}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: '#f1f5f9', color: '#475569', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Pause style={{ width: 18, height: 18 }} fill="currentColor" />
                </div>
                <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>Hold {eligible.length} Payment{eligible.length === 1 ? '' : 's'}</h3>
              </div>
              <p style={{ color: C.textMuted, fontSize: 13, margin: '8px 0 18px', lineHeight: 1.5 }}>
                Each invoice gets a HOLD badge on the dashboard and surfaces under the Hold quick-filter. They drop out of Overdue and Due Soon views.
              </p>
              <div style={{ background: C.elevBg, border: '1px solid ' + C.border, borderRadius: 8, padding: '10px 12px', marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>Total</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{totalsLine || '—'}</div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6 }}>
                  {previewPayees.join(', ')}
                  {remaining > 0 ? ` + ${remaining} more` : ''}
                </div>
              </div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: C.textMuted, marginBottom: 4 }}>
                Reason <span style={{ color: '#bbb', fontWeight: 400 }}>— optional, applied to all</span>
              </label>
              <textarea
                autoFocus
                value={bulkHoldReason}
                onChange={e => setBulkHoldReason(e.target.value.slice(0, 500))}
                placeholder="e.g. Waiting on legal review of the batch"
                rows={3}
                style={{
                  ...inputSty, width: '100%', resize: 'vertical', minHeight: 64,
                  fontFamily: 'inherit', lineHeight: 1.5,
                }}
              />
              <div style={{ fontSize: 10, color: C.textFaint, textAlign: 'right', marginTop: 2 }}>
                {bulkHoldReason.length}/500
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
                <button
                  onClick={submitBulkHoldRequest}
                  disabled={submittingBulkHold || eligible.length === 0}
                  style={{
                    background: '#64748b', color: '#fff', border: 'none', borderRadius: 8,
                    padding: '10px 20px', fontSize: 13, fontWeight: 800, fontFamily: 'inherit',
                    cursor: submittingBulkHold ? 'not-allowed' : 'pointer',
                    flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    opacity: submittingBulkHold ? 0.6 : 1,
                  }}
                >
                  {submittingBulkHold ? <Loader style={{ width: 14, height: 14, animation: 'spin 0.8s linear infinite' }} /> : <Pause style={{ width: 14, height: 14 }} fill="currentColor" />}
                  {submittingBulkHold ? 'Placing…' : `Hold (${eligible.length})`}
                </button>
                <button
                  onClick={() => { if (!submittingBulkHold) { setBulkHoldOpen(false); setBulkHoldReason('') } }}
                  disabled={submittingBulkHold}
                  style={{
                    background: C.elevBg, color: C.text, border: 'none', borderRadius: 8,
                    padding: '10px 20px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                    cursor: submittingBulkHold ? 'not-allowed' : 'pointer',
                    opacity: submittingBulkHold ? 0.5 : 1,
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Batch payment modal */}
      {showBatchModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setShowBatchModal(false)}>
          <div style={{ background: C.cardBg, borderRadius: 12, padding: 28, width: 420, boxShadow: C.shadow }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>Pay these together</h3>
            {/* The SUM leads. "Paid out in one sum" is the thing being recorded,
                so the figure that will hit the bank is the headline rather than a
                note under the count. */}
            <div style={{ fontSize: 26, fontWeight: 900, letterSpacing: '-0.5px', color: C.text, lineHeight: 1.1 }}>
              {selectedUnpaidTotalsDisplay}
            </div>
            <p style={{ color: '#777', fontSize: 13, marginTop: 4, marginBottom: 16 }}>
              {selectedUnpaidEntries.length} invoice{selectedUnpaidEntries.length === 1 ? '' : 's'}
              {oneVendor && selectedByVendor[0]?.payee ? ` to ${selectedByVendor[0].payee}` : ''}
            </p>

            {/* ── The declaration ───────────────────────────────────────────
                Marking rows paid says WHEN the money left. This says it left as
                ONE payment — which is what the bank statement will show, and
                what the matcher needs to settle that single debit against all of
                them. Without it the line matches nothing, because every tier
                pairs 1:1 on an amount equal to the cent. */}
            {selectedUnpaidRootIds.length > 1 && (
              <div style={{
                border: '1.5px solid ' + (batchForm.one_payment ? '#c7d2fe' : C.border),
                background: batchForm.one_payment ? (C.isDark ? '#1b1f30' : '#f5f7ff') : 'transparent',
                borderRadius: 8, padding: '10px 12px', marginBottom: 16,
              }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8,
                  cursor: oneVendor ? 'pointer' : 'default', opacity: oneVendor ? 1 : 0.65 }}>
                  <input
                    type="checkbox"
                    checked={!!batchForm.one_payment}
                    disabled={!oneVendor}
                    onChange={e => setBatchForm(f => ({ ...f, one_payment: e.target.checked }))}
                    style={{ marginTop: 2, width: 14, height: 14, accentColor: '#4f46e5' }}
                  />
                  <span style={{ fontSize: 12.5, color: C.text, fontWeight: 600 }}>
                    These went out as ONE payment
                    <span style={{ display: 'block', fontSize: 11.5, fontWeight: 400, color: '#888', marginTop: 2 }}>
                      {oneVendor
                        ? 'The bank line for this total will settle all of them automatically when the statement is uploaded.'
                        : `A single payment goes to one vendor, and this selection spans ${selectedVendors.length}. Mark them paid here, then group each vendor's invoices from the ledger.`}
                    </span>
                  </span>
                </label>
                {!oneVendor && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid ' + C.border,
                    fontSize: 11.5, color: '#888', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {selectedByVendor.map((v) => (
                      <div key={v.payee} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.payee}</span>
                        <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                          {fmtTotals(groupByCurrencyByFamily(v.rows))}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#555', marginBottom: 4 }}>Payment Date</label>
                <input
                  type="date"
                  value={batchForm.payment_date}
                  onChange={e => setBatchForm(f => ({ ...f, payment_date: e.target.value }))}
                  style={{ ...inputSty, width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#555', marginBottom: 4 }}>Payment Method</label>
                <select
                  value={batchForm.payment_method}
                  onChange={e => setBatchForm(f => ({ ...f, payment_method: e.target.value }))}
                  style={{ ...selectSty, width: '100%' }}
                >
                  <option value="">— Same as invoice —</option>
                  {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#555', marginBottom: 4 }}>Payment Reference <span style={{ color: '#bbb', fontWeight: 400 }}>— check #, wire ref, etc.</span></label>
                <input
                  type="text"
                  value={batchForm.payment_ref}
                  onChange={e => setBatchForm(f => ({ ...f, payment_ref: e.target.value }))}
                  placeholder="e.g. CHK-1234, Wire 04/09"
                  style={{ ...inputSty, width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#555', marginBottom: 4 }}>Proof of Payment <span style={{ color: '#bbb', fontWeight: 400 }}>— attached to all invoices</span></label>
                <div
                  onClick={() => {
                    const input = document.createElement('input')
                    input.type = 'file'
                    input.accept = '.pdf,.jpg,.jpeg,.png'
                    input.onchange = e => { if (e.target.files?.[0]) setBatchProofFile(e.target.files[0]) }
                    input.click()
                  }}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); if (e.dataTransfer.files?.[0]) setBatchProofFile(e.dataTransfer.files[0]) }}
                  style={{
                    border: `1.5px dashed ${batchProofFile ? GREEN : '#d1d5db'}`,
                    borderRadius: 8, padding: '10px 14px', cursor: 'pointer',
                    background: batchProofFile ? '#f0fdf4' : C.elevBg,
                    display: 'flex', alignItems: 'center', gap: 8,
                    fontSize: 12, color: batchProofFile ? GREEN : '#888',
                    transition: 'all 0.15s',
                  }}
                >
                  {batchProofFile ? (
                    <>
                      <CheckCircle2 style={{ width: 14, height: 14, flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{batchProofFile.name}</span>
                      <button onClick={e => { e.stopPropagation(); setBatchProofFile(null) }} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}>×</button>
                    </>
                  ) : (
                    <>
                      <Upload style={{ width: 14, height: 14, flexShrink: 0 }} />
                      <span>Drop file or click to upload</span>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
              <button
                onClick={handleBatchConfirm}
                style={{ background: GREEN, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', flex: 1 }}
              >
                Mark {selectedUnpaidEntries.length} Paid
              </button>
              <button
                onClick={() => setShowBatchModal(false)}
                style={{ background: C.elevBg, color: C.text, border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Send for approval modal — the modal IS the email preview */}
      {showApprovalModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={() => !sendingApproval && setShowApprovalModal(false)}>
          <div style={{ background: C.cardBg, borderRadius: 14, padding: 24, width: 620, maxHeight: '90vh', overflowY: 'auto', boxShadow: C.shadow }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 800, marginBottom: 4, color: C.text }}>Send {approvalInvoiceCount} invoice{approvalInvoiceCount === 1 ? '' : 's'} for approval</h3>
            <p style={{ color: C.textMuted, fontSize: 12, marginBottom: 16 }}>
              Preview the email below and edit the message before sending. Excel summary + {selectedWithPdf} invoice PDF{selectedWithPdf === 1 ? '' : 's'} attached automatically.
            </p>

            {/* Recipient selector */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint, marginBottom: 6 }}>Send to</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {[
                  { key: 'both',   label: 'Approver + backup' },
                  { key: 'felipe', label: 'Approver only' },
                  { key: 'jesse',  label: 'Backup only' },
                ].map(opt => {
                  const active = approvalRecipients === opt.key
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setApprovalRecipients(opt.key)}
                      disabled={sendingApproval}
                      style={{
                        flex: 1, padding: '8px 10px', borderRadius: 8,
                        border: '1.5px solid ' + (active ? '#2563eb' : C.border),
                        background: active ? 'rgba(37,99,235,0.08)' : C.cardBg,
                        color: active ? '#2563eb' : C.textMuted,
                        fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                        cursor: sendingApproval ? 'default' : 'pointer',
                        opacity: sendingApproval ? 0.5 : 1,
                      }}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Subject line — editable. Seeded from the default on open. */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint, marginBottom: 6 }}>Subject</div>
              <input
                value={approvalSubject}
                onChange={e => setApprovalSubject(e.target.value)}
                disabled={sendingApproval}
                placeholder="Email subject line"
                style={{ ...inputSty, width: '100%' }}
              />
            </div>

            {/* Email preview */}
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint, marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>Email preview</span>
              {messageEdited && (
                <button
                  onClick={() => { setApprovalMessage(defaultApprovalMessage(approvalRecipients)); setMessageEdited(false) }}
                  disabled={sendingApproval}
                  style={{ background: 'none', border: 'none', color: '#2563eb', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}
                >
                  Reset to default
                </button>
              )}
            </div>
            <div style={{ border: '1px solid ' + C.border, borderRadius: 10, overflow: 'hidden', marginBottom: 16, background: '#f9f9f9' }}>
              {/* Header banner */}
              <div style={{ background: '#334155', padding: '14px 20px' }}>
                <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: 2, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase' }}>Market Street</p>
                <h1 style={{ margin: '4px 0 0', fontSize: 18, fontWeight: 700, color: '#fff' }}>Invoices for Approval</h1>
              </div>
              {/* Body (editable) */}
              <div style={{ padding: 20 }}>
                <textarea
                  value={approvalMessage}
                  onChange={e => { setApprovalMessage(e.target.value); setMessageEdited(true) }}
                  disabled={sendingApproval}
                  rows={Math.max(4, approvalMessage.split('\n').length + 1)}
                  style={{
                    width: '100%', border: '1px dashed #d1d5db', borderRadius: 6,
                    padding: '10px 12px', fontSize: 13, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
                    color: '#111', background: '#fff', outline: 'none', resize: 'vertical',
                    lineHeight: 1.5,
                  }}
                  onFocus={e => e.currentTarget.style.borderColor = '#2563eb'}
                  onBlur={e => e.currentTarget.style.borderColor = '#d1d5db'}
                />
                {/* Totals table (auto-generated, read-only) */}
                <div style={{ fontSize: 10, fontWeight: 800, color: '#666', textTransform: 'uppercase', letterSpacing: '.05em', margin: '16px 0 6px' }}>Totals by Artist</div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, background: '#fff' }}>
                  <thead>
                    <tr>
                      <th style={{ padding: '6px 10px', border: '1px solid #e5e5e5', textAlign: 'left', fontSize: 10, fontWeight: 800, color: '#666', textTransform: 'uppercase', letterSpacing: '.05em' }}>Artist</th>
                      <th style={{ padding: '6px 10px', border: '1px solid #e5e5e5', textAlign: 'right', fontSize: 10, fontWeight: 800, color: '#666', textTransform: 'uppercase', letterSpacing: '.05em' }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {artistTotals.map(row => (
                      <tr key={row.artist + '||' + row.currency}>
                        <td style={{ padding: '6px 10px', border: '1px solid #e5e5e5', color: '#111' }}>
                          {row.artist}
                          {row.currency !== 'USD' && <span style={{ fontSize: 9, fontWeight: 700, color: '#999', marginLeft: 6 }}>{row.currency}</span>}
                        </td>
                        <td style={{ padding: '6px 10px', border: '1px solid #e5e5e5', textAlign: 'right', fontWeight: 700 }}>{fmt(row.amount, row.currency)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td style={{ padding: '8px 10px', border: '1px solid #e5e5e5', background: '#fef2f2', fontWeight: 800 }}>GRAND TOTAL</td>
                      <td style={{ padding: '8px 10px', border: '1px solid #e5e5e5', background: '#fef2f2', textAlign: 'right', fontWeight: 900, color: '#334155', fontSize: 14 }}>{approvalGrandTotalDisplay}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowApprovalModal(false)} disabled={sendingApproval}
                style={{ background: C.elevBg, color: C.text, border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: sendingApproval ? 'default' : 'pointer', opacity: sendingApproval ? 0.5 : 1 }}>
                Cancel
              </button>
              <button onClick={handleSendApproval} disabled={sendingApproval || !approvalMessage.trim()}
                style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: sendingApproval ? 'default' : 'pointer', opacity: sendingApproval || !approvalMessage.trim() ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Mail style={{ width: 14, height: 14 }} /> {sendingApproval
                  ? 'Sending…'
                  : approvalRecipients === 'both' ? 'Send to approver + backup'
                  : approvalRecipients === 'felipe' ? 'Send to approver'
                  : 'Send to backup'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmQueue.length > 0 && (() => {
        const head = confirmQueue[0]
        const rest = confirmQueue.length - 1
        const subtitle = rest > 0
          ? `Vendor ${confirmQueue.length === 1 ? '' : `(${rest} more after)`} · ${head.count} invoice${head.count === 1 ? '' : 's'}`
          : `${head.count} invoice${head.count === 1 ? '' : 's'}`
        return (
          <EmailPreviewModal
            open
            title="Send payment confirmation"
            subtitle={subtitle}
            previewKind={head.kind}
            previewContext={head.context}
            initialTo={head.to}
            initialCc={head.cc}
            initialSubject={head.subject}
            initialHtml={head.html}
            attachmentLabels={head.attachmentLabels}
            team={teamRoster}
            defaultCcEmails={defaultCcEmails}
            onClose={() => setConfirmQueue([])}
            onSent={() => {
              setEntries(prev => prev.map(e => head.ids.includes(e.id) ? { ...e, confirmation_sent: true } : e))
              advanceConfirmQueue()
            }}
            onSkipped={() => advanceConfirmQueue()}
            skipLabel="Skip this vendor"
          />
        )
      })()}

      {approvalPreview && (
        <EmailPreviewModal
          open
          title="Send invoices for approval"
          subtitle={`${approvalPreview.count} line item${approvalPreview.count === 1 ? '' : 's'} · ${approvalPreview.attachmentLabels.length} attachment${approvalPreview.attachmentLabels.length === 1 ? '' : 's'}`}
          initialTo={approvalPreview.to}
          initialCc={approvalPreview.cc}
          initialSubject={approvalPreview.subject}
          initialHtml={approvalPreview.html}
          attachmentLabels={approvalPreview.attachmentLabels}
          team={teamRoster}
          onClose={() => setApprovalPreview(null)}
          onSent={() => {
            const lbl = approvalPreview.recipients === 'both' ? 'the approver (cc backup)'
                      : approvalPreview.recipients === 'felipe' ? 'the approver' : 'the backup approver'
            toast(`Sent ${approvalPreview.count} line item${approvalPreview.count === 1 ? '' : 's'} to ${lbl}`)
            setSelectedIds(new Set())
            setApprovalPreview(null)
          }}
          customSend={async (payload) => {
            await api.post('/bk/payments/send-approval-email', {
              ids: approvalPreview.ids,
              recipients: approvalPreview.recipients,
              body: approvalPreview.body,
              to: payload.to,
              cc: payload.cc,
              subject: payload.subject,
              html_override: payload.html_override,
            })
          }}
        />
      )}

      {confirmEntry && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={closeConfirmModal}>
          <div style={{ background: C.cardBg, borderRadius: 14, padding: 24, width: 760, maxWidth: '100%', maxHeight: '92vh', overflowY: 'auto', boxShadow: C.shadow }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 800, marginBottom: 4, color: C.text }}>
              Send Payment Confirmation
            </h3>
            <p style={{ color: C.textMuted, fontSize: 12, marginBottom: 16 }}>
              {confirmEntry.payee}
              {confirmMeta?.invoiceNumber ? ` · Invoice #${confirmMeta.invoiceNumber}` : ''}
              {confirmMeta ? ` · ${fmt(confirmMeta.amount, confirmMeta.currency)}` : ''}
              {confirmMeta?.hasInvoice && confirmMeta?.hasProof
                ? ' · Invoice + Proof attached'
                : confirmMeta?.hasProof
                  ? ' · Proof attached'
                  : confirmMeta?.hasInvoice
                    ? ' · Invoice attached'
                    : ''}
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10, marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint, marginBottom: 4 }}>To</div>
                <input
                  value={confirmForm.to}
                  onChange={e => setConfirmForm(f => ({ ...f, to: e.target.value }))}
                  disabled={sendingConfirmId === confirmEntry.id}
                  style={{ ...inputSty, width: '100%' }}
                />
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span>CC</span>
                  {(() => {
                    const currentList = parseCcList(confirmForm.cc)
                    const sameAsDefault = currentList.length === defaultCcEmails.length
                      && currentList.every((e, i) => e.toLowerCase() === (defaultCcEmails[i] || '').toLowerCase())
                    if (sameAsDefault && currentList.length === defaultCcEmails.length) return null
                    return (
                      <button
                        type="button"
                        onClick={() => {
                          setDefaultCcEmails(dedupeCi(currentList))
                          toast(currentList.length ? `Saved ${currentList.length} default CC${currentList.length === 1 ? '' : 's'}` : 'Cleared default CCs')
                        }}
                        disabled={sendingConfirmId === confirmEntry.id}
                        title="Pre-fill these emails on every payment-confirmation send (single + bulk)"
                        style={{
                          fontWeight: 600, textTransform: 'none', letterSpacing: 0,
                          background: 'transparent', border: 'none', color: '#2563eb',
                          fontSize: 11, cursor: 'pointer', padding: 0, fontFamily: 'inherit',
                          textDecoration: 'underline', textUnderlineOffset: 2,
                        }}
                      >
                        Save as default
                      </button>
                    )
                  })()}
                </div>
                <CcChipInput
                  value={parseCcList(confirmForm.cc)}
                  onChange={(arr) => setConfirmForm(f => ({ ...f, cc: joinCcList(arr) }))}
                  disabled={sendingConfirmId === confirmEntry.id}
                  team={teamRoster}
                  excludeEmail={confirmForm.to}
                  placeholder={confirmMeta?.boomRep ? `Add CCs — e.g. ${confirmMeta.boomRep}'s email` : 'Type a name or email, press Enter'}
                  inputSty={inputSty}
                  C={C}
                />
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint, marginBottom: 4 }}>Subject</div>
                <input
                  value={confirmForm.subject}
                  onChange={e => setConfirmForm(f => ({ ...f, subject: e.target.value }))}
                  disabled={sendingConfirmId === confirmEntry.id}
                  style={{ ...inputSty, width: '100%' }}
                />
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint, marginBottom: 4 }}>
                  Personal Note <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: C.textFaint }}>(optional — appears above the details table)</span>
                </div>
                <textarea
                  value={confirmForm.message}
                  onChange={e => setConfirmForm(f => ({ ...f, message: e.target.value }))}
                  disabled={sendingConfirmId === confirmEntry.id}
                  rows={3}
                  placeholder="e.g. Thanks for your patience — please find your payment attached."
                  style={{ ...inputSty, width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                />
              </div>
            </div>

            <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>Email Preview</span>
              <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: C.textFaint }}>
                — click any text to edit
              </span>
              {confirmLoading && <Loader style={{ width: 11, height: 11, animation: 'spin 0.8s linear infinite' }} />}
              {previewEdited && (
                <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 700, color: '#d97706' }}>Edited</span>
                  <button
                    type="button"
                    onClick={resetPreview}
                    disabled={sendingConfirmId === confirmEntry.id}
                    style={{
                      background: 'transparent', color: C.text, border: '1px solid ' + C.border,
                      borderRadius: 6, padding: '3px 10px', fontSize: 11, fontWeight: 700,
                      textTransform: 'none', letterSpacing: 0, fontFamily: 'inherit',
                      cursor: sendingConfirmId === confirmEntry.id ? 'default' : 'pointer',
                      opacity: sendingConfirmId === confirmEntry.id ? 0.5 : 1,
                    }}
                  >
                    Reset preview
                  </button>
                </span>
              )}
            </div>
            <div style={{ border: '1px solid ' + C.border, borderRadius: 10, overflow: 'hidden', marginBottom: 16, background: '#fff' }}>
              <iframe
                ref={previewIframeRef}
                onLoad={handlePreviewLoad}
                title="Payment confirmation preview"
                srcDoc={confirmHtml}
                sandbox="allow-same-origin"
                style={{ width: '100%', height: 460, border: 'none', background: '#f9f9f9', display: 'block' }}
              />
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={closeConfirmModal} disabled={sendingConfirmId === confirmEntry.id}
                style={{ background: C.elevBg, color: C.text, border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: sendingConfirmId === confirmEntry.id ? 'default' : 'pointer', opacity: sendingConfirmId === confirmEntry.id ? 0.5 : 1 }}>
                Cancel
              </button>
              <button
                onClick={submitConfirmModal}
                disabled={sendingConfirmId === confirmEntry.id || !confirmForm.to.trim() || !confirmForm.subject.trim()}
                style={{
                  background: GREEN, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px',
                  fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                  cursor: sendingConfirmId === confirmEntry.id ? 'default' : 'pointer',
                  opacity: (sendingConfirmId === confirmEntry.id || !confirmForm.to.trim() || !confirmForm.subject.trim()) ? 0.5 : 1,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {sendingConfirmId === confirmEntry.id
                  ? <Loader style={{ width: 13, height: 13, animation: 'spin 0.8s linear infinite' }} />
                  : <Send style={{ width: 13, height: 13 }} />}
                {sendingConfirmId === confirmEntry.id ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}

      {installmentsEntry && (() => {
        const familyTotal   = installmentsData?.familyTotal ?? (installmentsEntry.family_amount || installmentsEntry.amount || 0)
        const paidTotal     = installmentsData?.installmentsTotal ?? 0
        const remaining     = Math.max(0, familyTotal - paidTotal)
        const overpaid      = paidTotal > familyTotal + 0.005
        const fullyPaid     = !overpaid && remaining < 0.005 && (installmentsData?.installments?.length || 0) > 0
        const list          = installmentsData?.installments || []
        return (
          <div
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
            onClick={closeInstallmentsModal}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{ background: C.cardBg, borderRadius: 14, padding: 24, width: 720, maxWidth: '100%', maxHeight: '92vh', overflowY: 'auto', boxShadow: C.shadow }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                <div>
                  <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0, color: C.text }}>Payment Installments</h3>
                  <p style={{ color: C.textMuted, fontSize: 12, margin: '4px 0 0' }}>
                    {installmentsEntry.payee}
                    {installmentsEntry.invoice_number ? ` · Invoice #${installmentsEntry.invoice_number}` : ''}
                  </p>
                </div>
                <button
                  onClick={closeInstallmentsModal}
                  disabled={installmentsSubmitting}
                  style={{ background: 'transparent', border: 'none', color: C.textMuted, cursor: 'pointer', padding: 4, fontFamily: 'inherit' }}
                  title="Close"
                >
                  <X style={{ width: 16, height: 16 }} />
                </button>
              </div>

              {/* Totals bar */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, margin: '12px 0 18px' }}>
                <div style={{ background: C.elevBg, borderRadius: 10, padding: '10px 14px' }}>
                  <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint }}>Invoice total</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>{fmt(familyTotal, installmentsEntry.currency)}</div>
                </div>
                <div style={{ background: C.elevBg, borderRadius: 10, padding: '10px 14px' }}>
                  <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint }}>Paid so far</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: fullyPaid ? GREEN : (paidTotal > 0 ? '#d97706' : C.text) }}>
                    {fmt(paidTotal, installmentsEntry.currency)}
                  </div>
                </div>
                <div style={{ background: C.elevBg, borderRadius: 10, padding: '10px 14px' }}>
                  <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint }}>
                    {overpaid ? 'Overpaid by' : 'Remaining'}
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: overpaid ? RED : (fullyPaid ? GREEN : C.text) }}>
                    {fmt(overpaid ? paidTotal - familyTotal : remaining, installmentsEntry.currency)}
                  </div>
                </div>
              </div>

              {/* Installments list */}
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>Recorded payments</span>
                  {installmentsLoading && <Loader style={{ width: 11, height: 11, animation: 'spin 0.8s linear infinite' }} />}
                </div>
                {list.length === 0 ? (
                  <div style={{ padding: 14, border: '1px dashed ' + C.border, borderRadius: 10, color: C.textMuted, fontSize: 13, textAlign: 'center' }}>
                    No installments yet. Add the first payment below — multiple entries will mark the invoice as Partial until the total is reached.
                  </div>
                ) : (
                  <div style={{ border: '1px solid ' + C.border, borderRadius: 10, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: C.elevBg }}>
                          <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700, color: C.textFaint, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em' }}>Date</th>
                          <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 700, color: C.textFaint, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em' }}>Amount</th>
                          <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700, color: C.textFaint, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em' }}>Method</th>
                          <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700, color: C.textFaint, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em' }}>Ref</th>
                          <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700, color: C.textFaint, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em' }}>Paid by</th>
                          <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700, color: C.textFaint, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em' }}>Proof</th>
                          <th style={{ padding: '8px 10px' }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map(inst => (
                          <tr key={inst.id} style={{ borderTop: '1px solid ' + C.tdBorder }}>
                            <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', color: C.text }}>{fmtDate(inst.payment_date)}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: C.text }}>{fmt(inst.amount, installmentsEntry.currency)}</td>
                            <td style={{ padding: '8px 10px', color: C.text }}>
                              {inst.payment_method
                                ? <span style={{ ...badgeBase, ...(METHOD_BADGE[inst.payment_method] || { bg: C.badgeNeutralBg, color: C.text }) }}>{inst.payment_method}</span>
                                : '—'}
                            </td>
                            <td style={{ padding: '8px 10px', color: C.text, fontFamily: 'monospace', fontSize: 11 }}>{inst.payment_ref || '—'}</td>
                            <td style={{ padding: '8px 10px', color: C.textMuted }}>{inst.paid_by || '—'}</td>
                            <td style={{ padding: '8px 10px' }}>
                              {inst.has_proof ? (
                                <button
                                  onClick={() => setPreviewFile({ url: `/api/bk/installments/${inst.id}/proof?token=${localStorage.getItem('token')}`, filename: inst.proof_filename || `Proof-${installmentsEntry.payee}` })}
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: GREEN, fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: 'inherit', padding: 0 }}
                                >
                                  <CheckCircle2 style={{ width: 11, height: 11 }} /> View
                                </button>
                              ) : (
                                <span style={{ color: C.textFaint, fontSize: 11 }}>—</span>
                              )}
                            </td>
                            <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                              <button
                                onClick={() => deleteInstallment(inst.id)}
                                disabled={installmentsSubmitting}
                                title="Remove installment"
                                style={{ background: 'transparent', border: 'none', color: C.textMuted, cursor: installmentsSubmitting ? 'default' : 'pointer', padding: 4 }}
                              >
                                <Trash2 style={{ width: 12, height: 12 }} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Add-payment form */}
              <div style={{ borderTop: '1px solid ' + C.tdBorder, paddingTop: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint, marginBottom: 8 }}>Record a payment</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 2 }}>Amount *</div>
                    <input type="number" step="0.01" min="0" value={installmentForm.amount}
                      onChange={e => setInstallmentForm(f => ({ ...f, amount: e.target.value }))}
                      placeholder={remaining > 0 ? `e.g. ${remaining.toFixed(2)}` : '0.00'}
                      style={{ ...inputSty, width: '100%' }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 2 }}>Date</div>
                    <input type="date" value={installmentForm.payment_date}
                      onChange={e => setInstallmentForm(f => ({ ...f, payment_date: e.target.value }))}
                      style={{ ...inputSty, width: '100%' }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 2 }}>Method</div>
                    <select value={installmentForm.payment_method}
                      onChange={e => setInstallmentForm(f => ({ ...f, payment_method: e.target.value }))}
                      style={{ ...selectSty, width: '100%' }}
                    >
                      <option value="">—</option>
                      {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 2 }}>Reference</div>
                    <input value={installmentForm.payment_ref}
                      onChange={e => setInstallmentForm(f => ({ ...f, payment_ref: e.target.value }))}
                      placeholder="Transaction / check #"
                      style={{ ...inputSty, width: '100%' }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 2 }}>Paid by</div>
                    <input value={installmentForm.paid_by}
                      onChange={e => setInstallmentForm(f => ({ ...f, paid_by: e.target.value }))}
                      placeholder="(defaults to you)"
                      style={{ ...inputSty, width: '100%' }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 2 }}>Proof file (optional)</div>
                    <input type="file" accept=".pdf,.png,.jpg,.jpeg"
                      onChange={e => setInstallmentForm(f => ({ ...f, file: e.target.files?.[0] || null }))}
                      style={{ ...inputSty, width: '100%', padding: '5px 6px', fontSize: 11 }}
                    />
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 2 }}>Notes</div>
                    <textarea rows={2} value={installmentForm.notes}
                      onChange={e => setInstallmentForm(f => ({ ...f, notes: e.target.value }))}
                      placeholder="Optional — context for this installment"
                      style={{ ...inputSty, width: '100%', fontFamily: 'inherit', resize: 'vertical' }}
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
                  <button
                    onClick={closeInstallmentsModal}
                    disabled={installmentsSubmitting}
                    style={{ background: C.elevBg, color: C.text, border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: installmentsSubmitting ? 'default' : 'pointer', opacity: installmentsSubmitting ? 0.5 : 1 }}
                  >
                    Close
                  </button>
                  <button
                    onClick={submitInstallment}
                    disabled={installmentsSubmitting || !installmentForm.amount}
                    style={{
                      background: GREEN, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px',
                      fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                      cursor: (installmentsSubmitting || !installmentForm.amount) ? 'default' : 'pointer',
                      opacity: (installmentsSubmitting || !installmentForm.amount) ? 0.5 : 1,
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                    }}
                  >
                    {installmentsSubmitting
                      ? <Loader style={{ width: 13, height: 13, animation: 'spin 0.8s linear infinite' }} />
                      : <Plus style={{ width: 13, height: 13 }} />}
                    {installmentsSubmitting ? 'Saving…' : 'Record payment'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {previewFile && (
        <FilePreview url={previewFile.url} filename={previewFile.filename} onClose={() => setPreviewFile(null)} />
      )}

      {/* Split between artists / songs.
          `family_amount` comes off the row, so the dialog shows what the vendor
          BILLED even when the parent has already been cut down to its own share
          — this page never loads a family separately, and dividing the parent's
          leftover would quietly shrink the invoice.
          A full refetch afterwards, deliberately: the split rewrites the parent
          and creates rows that were not in the list a moment ago, and unlike the
          post-upload timer this runs in response to the action, so there is
          nothing newer on screen for it to overwrite. */}
      {splitEntry && (
        <SplitInvoiceModal
          entry={splitEntry}
          // The slices this page has loaded. It shows every family member it is
          // scoped to, so on an ordinary invoice this is the whole family — but
          // the scope is unpaid + 14 days of paid, so it can be a subset, which
          // is why the authoritative total comes from the server instead of a
          // sum of these and the dialog warns when the two disagree.
          family={entries.filter(e => e.id === splitEntry.id || e.parent_id === splitEntry.id)}
          familyTotal={splitEntry.family_amount}
          C={C}
          onClose={() => setSplitEntry(null)}
          onError={(msg) => toast.error(msg)}
          onDone={async (n) => {
            setSplitEntry(null)
            await fetchEntries()
            toast(`${splitEntry.payee} split into ${n} rows`)
          }}
        />
      )}

      {/* Undo toast */}
      {/* ── The edit history ──────────────────────────────────────────────────
          Sits apart from the 6-second toast above, which stays: that one is for
          "I just did the wrong thing" on ONE action and expires. This is the
          walk-back for panel edits, and it holds every one of them for as long
          as the page is open.

          Only rendered once there is something to undo — an empty pair of
          greyed arrows is furniture. */}
      {(undoStack.canUndo || undoStack.canRedo) && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 1000,
          background: C.cardBg, border: '1px solid ' + C.border, borderRadius: 10,
          boxShadow: '0 8px 30px rgba(0,0,0,0.18)', padding: '8px 10px',
          display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
        }}>
          <button
            onClick={undoStack.undo}
            disabled={!undoStack.canUndo || undoStack.busy}
            title={undoStack.nextUndoLabel ? `Undo ${undoStack.nextUndoLabel}  (\u2318Z)` : 'Nothing to undo'}
            style={{
              background: 'none', border: '1px solid ' + C.border, borderRadius: 6,
              padding: '3px 8px', cursor: undoStack.canUndo ? 'pointer' : 'default',
              color: undoStack.canUndo ? C.text : C.textFaint, display: 'flex',
              alignItems: 'center', gap: 4, fontWeight: 700,
            }}>
            <Undo2 style={{ width: 12, height: 12 }} /> Undo
          </button>
          <button
            onClick={undoStack.redo}
            disabled={!undoStack.canRedo || undoStack.busy}
            title={undoStack.nextRedoLabel ? `Redo ${undoStack.nextRedoLabel}  (\u21e7\u2318Z)` : 'Nothing to redo'}
            style={{
              background: 'none', border: '1px solid ' + C.border, borderRadius: 6,
              padding: '3px 8px', cursor: undoStack.canRedo ? 'pointer' : 'default',
              color: undoStack.canRedo ? C.text : C.textFaint, display: 'flex',
              alignItems: 'center', gap: 4, fontWeight: 700,
            }}>
            <Redo2 style={{ width: 12, height: 12 }} /> Redo
          </button>
          <span style={{ color: C.textFaint, fontSize: 11 }}>
            {undoStack.depth} of {undoStack.total} edit{undoStack.total === 1 ? '' : 's'}
          </span>
          {undoStack.busy && <Loader style={{ width: 12, height: 12 }} className="animate-spin" />}
        </div>
      )}

      {/* A refused undo says WHAT changed and that nothing was written. The
          alternative — applying anyway — silently overwrites whoever moved it. */}
      {undoStack.conflict && (
        <div style={{
          position: 'fixed', bottom: 78, right: 24, zIndex: 1001, maxWidth: 340,
          background: '#7f1d1d', color: '#fff', borderRadius: 10, padding: '10px 12px',
          boxShadow: '0 8px 30px rgba(0,0,0,0.25)', fontSize: 12, lineHeight: 1.45,
        }}>
          <b>Undo refused — nothing was written.</b>
          <div style={{ marginTop: 4, opacity: 0.9 }}>
            {undoStack.conflict.field} is now
            {' '}<b>{String(undoStack.conflict.actual ?? '(blank)')}</b>, not
            {' '}<b>{String(undoStack.conflict.expected ?? '(blank)')}</b> —
            somebody changed it since this edit.
            {undoStack.conflict.applied > 0 && (
              <> {undoStack.conflict.applied} of {undoStack.conflict.total} parts of this
              action had already been undone.</>
            )}
          </div>
          <button onClick={undoStack.dismissConflict}
            style={{ marginTop: 6, background: 'none', border: '1px solid rgba(255,255,255,0.35)',
              borderRadius: 5, color: '#fff', padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}>
            Dismiss
          </button>
        </div>
      )}

      {undoAction && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: '#1f2937', color: '#fff', borderRadius: 12, padding: '12px 20px',
          display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, fontWeight: 600,
          boxShadow: '0 8px 30px rgba(0,0,0,0.25)', zIndex: 1000, minWidth: 300,
          animation: 'slideUp 0.2s ease-out',
        }}>
          <span style={{ flex: 1 }}>{undoAction.message}</span>
          <button
            onClick={executeUndo}
            style={{
              background: 'none', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 6,
              padding: '4px 12px', color: '#fbbf24', fontSize: 12, fontWeight: 700,
              cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            <Undo2 style={{ width: 13, height: 13 }} /> Undo
          </button>
          <button
            onClick={() => { if (undoTimerRef.current) clearTimeout(undoTimerRef.current); setUndoAction(null) }}
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', padding: 0, fontSize: 16, lineHeight: 1 }}
          >
            &#x2715;
          </button>
        </div>
      )}
      <style>{`@keyframes slideUp { from { transform: translateX(-50%) translateY(20px); opacity: 0 } to { transform: translateX(-50%) translateY(0); opacity: 1 } }`}</style>
    </>
  )

  // ── Mobile card view (<768px) — separate render branch, same state ──────
  // The desktop table below is untouched; this reuses filtered/selection/
  // handler state and renders the shared `overlays` for all modal flows.
  if (isMobileView) {
    const sheetEntry = sheetPaymentId != null ? entries.find(e => e.id === sheetPaymentId) : null
    const mobileActiveFilters = [methodFilter !== 'All', statusFilter !== 'All', repFilter !== 'All', !!amountQuery, sortBy !== 'Due Date'].filter(Boolean).length
    const mobileStats = [
      { label: 'Overdue', items: overdueEntries, totals: totalOverdue, cls: 'text-red-600' },
      { label: 'Due 7 days', items: dueSoonEntries, totals: totalDueSoon, cls: 'text-orange-600' },
      { label: 'Total unpaid', items: unpaidEntries, totals: totalUnpaid, cls: 'text-ink' },
      { label: 'Paid · last 14 days', items: paidRecent, totals: totalPaidRecent, cls: 'text-ink' },
    ]
    // Fold split children into their parent's card (desktop collapses them
    // too); the parent card shows the combined family amount + a Split badge.
    const visibleIds = new Set(filtered.map(e => e.id))
    const mobileRows = filtered.filter(e => !(e.parent_id && visibleIds.has(e.parent_id)))
    const mobileChildCount = {}
    filtered.forEach(e => {
      if (e.parent_id && visibleIds.has(e.parent_id)) mobileChildCount[e.parent_id] = (mobileChildCount[e.parent_id] || 0) + 1
    })
    const selectedConfirmEligible = selectedEntries.filter(isPendingConfirmation).length

    return (
      <div style={{ minHeight: '100%', background: C.pageBg }} className="px-3 pt-4 pb-28">
        <NextStepPrompt prompt={nextStep} onClose={clearNextStep} />
        <h1 className="text-xl font-extrabold text-ink mb-0.5">Payments</h1>
        <p className="text-[11px] text-gray-400 -mt-0.5 mb-1">
          Marked paid is a claim; the statement is the proof.{' '}
          <Link to="/bk/statements" className="underline hover:text-ink" data-link="bank">Upload statements on Bank →</Link>
        </p>
        <p className="text-xs text-gray-500 mb-3">Unpaid + paid in the last 14 days. Older payments live in the ledger.</p>

        {/* Quick filter chips */}
        <div className="flex gap-1.5 overflow-x-auto -mx-3 px-3 pb-2 mb-1" style={{ WebkitOverflowScrolling: 'touch' }}>
          {QUICK_FILTERS.map(qf => (
            <button
              key={qf}
              onClick={() => setQuickFilter(qf)}
              className={`shrink-0 px-3.5 py-1.5 rounded-full text-[12px] font-semibold border-[1.5px] bg-card ${
                quickFilter === qf ? 'border-boom-600 text-boom-600' : 'border-rule text-gray-500'
              }`}
            >
              {qf}
            </button>
          ))}
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          {mobileStats.map(s => {
            const usdHeadline = fmtUsdItems(s.items, fxRates) || fmtTotals(s.totals)
            return (
              <div key={s.label} className="bg-card border border-rule rounded-xl px-3 py-2.5">
                <div className="text-[9px] font-extrabold uppercase tracking-wider text-gray-400">{s.label}</div>
                <div className={`text-[15px] font-black mt-0.5 whitespace-nowrap ${s.cls}`}>{usdHeadline}</div>
                <div className="text-[10px] text-gray-400">{s.items.length} invoice{s.items.length === 1 ? '' : 's'}</div>
              </div>
            )
          })}
        </div>

        {/* Search + filters */}
        <div className="flex gap-2 mb-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              data-filter
              placeholder="Search payee, artist, invoice #"
              className="w-full pl-8 pr-3 py-2.5 rounded-xl border border-rule bg-card text-[13px] text-ink outline-none"
            />
          </div>
          <button
            onClick={() => setFiltersOpen(true)}
            className="relative shrink-0 px-3.5 py-2.5 rounded-xl border border-rule bg-card text-[13px] font-semibold text-gray-600"
          >
            Filters
            {mobileActiveFilters > 0 && (
              <span className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-boom-600 text-white text-[10px] font-bold flex items-center justify-center">
                {mobileActiveFilters}
              </span>
            )}
          </button>
        </div>

        {/* Card list */}
        <div className="flex flex-col gap-2">
          {mobileRows.length === 0 && (
            <div className="text-center text-sm text-gray-400 py-12">No payments match the current filters.</div>
          )}
          {mobileRows.map(e => (
            <PaymentCard
              key={e.id}
              entry={e}
              // Family total from the server, same reason as the desktop table:
              // summing only the children this page holds under-reports a split
              // whose siblings fell outside the 14-day window.
              displayAmount={e.family_amount != null
                ? e.family_amount
                : parseFloat(e.amount || 0) + (familyOnPage[e.id]?.sum || 0)}
              currency={e.currency}
              fmt={fmt}
              fmtDate={fmtDate}
              overdue={isOverdue(e) && !e.on_hold}
              dueSoon={isDueSoon(e) && !e.on_hold}
              splitCount={mobileChildCount[e.id] || 0}
              selected={selectedIds.has(e.id)}
              onToggleSelect={() => toggleSelect(e.id)}
              onOpen={() => setSheetPaymentId(e.id)}
            />
          ))}
        </div>

        {/* Sticky bulk-action bar (above BottomNav on phones) */}
        {selectedIds.size > 0 && (
          <div
            className="fixed left-0 right-0 bottom-14 sm:bottom-0 z-40 bg-card border-t border-rule px-3 py-2 shadow-2xl"
            style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-bold text-gray-600">
                {selectedIds.size} selected · {selectedTotalsDisplay}
              </span>
              <button onClick={() => setSelectedIds(new Set())} className="text-[11px] font-bold text-gray-400">
                Clear
              </button>
            </div>
            <div className="flex gap-1.5 overflow-x-auto" style={{ WebkitOverflowScrolling: 'touch' }}>
              {selectedUnpaidEntries.length > 0 && (
                <button
                  onClick={handleBulkMarkPaid}
                  disabled={savingId === 'bulk'}
                  className="shrink-0 px-3 py-2 rounded-lg bg-emerald-600 text-white text-[12px] font-bold disabled:opacity-50"
                >
                  Mark Paid ({selectedUnpaidEntries.length})
                </button>
              )}
              {selectedConfirmEligible > 0 && (
                <button
                  onClick={sendAllPendingConfirmations}
                  disabled={sendingBulk}
                  className="shrink-0 px-3 py-2 rounded-lg bg-blue-600 text-white text-[12px] font-bold disabled:opacity-50"
                >
                  {sendingBulk ? 'Preparing…' : `Confirmations (${selectedConfirmEligible})`}
                </button>
              )}
              {selectedUnpaidEntries.length > 0 && (
                <>
                  <button
                    onClick={() => setBulkRushOpen(true)}
                    className="shrink-0 px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 text-[12px] font-bold"
                  >
                    Rush
                  </button>
                  <button
                    onClick={() => setBulkHoldOpen(true)}
                    className="shrink-0 px-3 py-2 rounded-lg border border-rule bg-card text-gray-600 text-[12px] font-bold"
                  >
                    Hold
                  </button>
                </>
              )}
              <button
                onClick={selectAll}
                className="shrink-0 px-3 py-2 rounded-lg border border-rule bg-card text-gray-600 text-[12px] font-bold"
              >
                All/None
              </button>
            </div>
          </div>
        )}

        {/* Filters drawer */}
        <FilterSheet
          open={filtersOpen}
          onClose={() => setFiltersOpen(false)}
          activeCount={mobileActiveFilters}
          onClearAll={() => { setAmountQuery(''); setMethodFilter('All'); setStatusFilter('All'); setRepFilter('All'); setSortBy('Due Date') }}
        >
          <FilterField label="Amount">
            <input
              value={amountQuery}
              onChange={e => setAmountQuery(e.target.value)}
              placeholder={'e.g. 500, 500-1000, >250'}
              className="w-full py-2.5 px-3 rounded-xl border border-rule bg-card text-[13px] text-ink outline-none"
            />
          </FilterField>
          <FilterField label="Payment method">
            <select value={methodFilter} onChange={e => setMethodFilter(e.target.value)} className="w-full py-2.5 px-3 rounded-xl border border-rule bg-card text-[13px] text-ink outline-none">
              {['All', ...PAYMENT_METHODS].map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </FilterField>
          <FilterField label="Status">
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="w-full py-2.5 px-3 rounded-xl border border-rule bg-card text-[13px] text-ink outline-none">
              {['All', 'Unpaid', 'Paid', 'Partial'].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </FilterField>
          <FilterField label="Market Street rep">
            <select value={repFilter} onChange={e => setRepFilter(e.target.value)} className="w-full py-2.5 px-3 rounded-xl border border-rule bg-card text-[13px] text-ink outline-none">
              <option value="All">All</option>
              <option value="No rep">No rep</option>
              {repOptions.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </FilterField>
          <FilterField label="Sort by">
            <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="w-full py-2.5 px-3 rounded-xl border border-rule bg-card text-[13px] text-ink outline-none">
              {SORT_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </FilterField>
        </FilterSheet>

        {/* Payment detail drawer */}
        <PaymentSheet
          entry={sheetEntry}
          onClose={() => setSheetPaymentId(null)}
          fmt={fmt}
          fmtDate={fmtDate}
          displayAmount={sheetEntry
            ? (sheetEntry.family_amount != null
                ? sheetEntry.family_amount
                : parseFloat(sheetEntry.amount || 0) + (familyOnPage[sheetEntry.id]?.sum || 0))
            : null}
          busy={sheetEntry ? savingId === sheetEntry.id : false}
          uploading={sheetEntry ? uploadingId === sheetEntry.id : false}
          onMarkPaid={() => sheetEntry && handleMarkPaid(sheetEntry.id)}
          onMarkUnpaid={() => sheetEntry && handleMarkUnpaid(sheetEntry.id)}
          onSendConfirmation={() => sheetEntry && openConfirmModal(sheetEntry)}
          onRush={() => sheetEntry && setRushModalEntry(sheetEntry)}
          onClearRush={() => sheetEntry && handleClearRush(sheetEntry.id)}
          onHold={() => sheetEntry && setHoldModalEntry(sheetEntry)}
          onClearHold={() => sheetEntry && handleClearHold(sheetEntry.id)}
          onUploadProof={(file) => sheetEntry && uploadProof(sheetEntry.id, file)}
          onViewInvoice={() => sheetEntry && setPreviewFile({ url: `/api/bk/entries/${sheetEntry.id}/file/invoice?token=${localStorage.getItem('token')}`, filename: `Invoice-${sheetEntry.payee}` })}
          onViewProof={() => sheetEntry && setPreviewFile({ url: `/api/bk/entries/${sheetEntry.id}/file/proof?token=${localStorage.getItem('token')}`, filename: `Proof-${sheetEntry.payee}` })}
        />

        {overlays}
      </div>
    )
  }

  return (
    <div style={{ height: 'calc(100vh - 120px)', background: C.pageBg, display: 'flex', flexDirection: 'column' }} data-tour="payments">
      {/* Scrollable middle: all chrome + the invoices card scroll together
          inside this area, leaving the action bar below permanently visible. */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '28px 24px' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: C.text, margin: 0 }}>Payment Dashboard</h1>
            <p style={{ color: '#888', fontSize: 13, margin: '4px 0 0' }}>Unpaid invoices and anything paid in the last 14 days. Older payments live in the ledger.</p>
          </div>
          <div ref={exportMenuRef} style={{ display: 'flex', gap: 6, position: 'relative' }}>
            {/* One export control. CSV and Excel are the same request with two
                file formats, and two buttons of equal weight in the page's top
                corner read as two features. */}
            <button
              onClick={() => setExportOpen(v => !v)}
              style={{
                padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600,
                fontFamily: 'inherit', cursor: 'pointer', border: '1.5px solid',
                borderColor: exportOpen ? '#6366f1' : C.border,
                background: exportOpen ? '#eef2ff' : C.cardBg,
                color: exportOpen ? '#6366f1' : C.textMuted,
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <Download style={{ width: 13, height: 13 }} /> Export
              <ChevronDown style={{ width: 12, height: 12 }} />
            </button>
            {exportOpen && (
              <div
                style={{
                  position: 'absolute', top: 36, right: 96, zIndex: 40, minWidth: 190,
                  background: C.cardBg, border: '1px solid ' + C.border, borderRadius: 10,
                  boxShadow: C.shadow, overflow: 'hidden', padding: 4,
                }}
              >
            <button
              onClick={() => {
                setExportOpen(false)
                const csv = ['Date,Payee,Artist,Rep,Invoice #,Amount,Method,Status,Due Date,Paid Date,Bank']
                filtered.forEach(e => csv.push([fmtDate(e.invoice_date),`"${(e.payee||'').replace(/"/g,'""')}"`,`"${(e.artist||'').replace(/"/g,'""')}"`,e.boom_rep||'',e.invoice_number||'',e.amount||0,e.payment_method||'',e.payment_status||'',fmtDate(e.scheduled_payment_date),fmtDate(e.payment_date),`"${(e.vendor_bank||'').replace(/"/g,'""')}"`].join(',')))
                const blob = new Blob([csv.join('\n')], { type: 'text/csv' })
                const filterLabel = quickFilter === 'All' ? 'payments' : quickFilter.toLowerCase().replace(/\s+/g, '-')
                const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `marketst-${filterLabel}.csv`; a.click()
              }}
              style={MENU_ITEM}
              onMouseEnter={e => e.currentTarget.style.background = C.elevBg}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <Download style={{ width: 13, height: 13 }} /> CSV — what is on screen
            </button>
            <button
              onClick={async () => {
                setExportOpen(false)
                const filterMap = { 'All': 'all', 'Unpaid': 'unpaid', 'Overdue': 'overdue', 'Due Soon': 'due_soon' }
                const f = filterMap[quickFilter] || 'all'
                try {
                  const res = await api.get(`/bk/payments/export?filter=${f}`, { responseType: 'blob' })
                  const url = URL.createObjectURL(res.data)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `marketst-${f === 'all' ? 'payments' : f}-${new Date().toISOString().slice(0,10)}.xlsx`
                  a.click()
                  URL.revokeObjectURL(url)
                } catch (err) { toast.error('Export failed') }
              }}
              style={MENU_ITEM}
              onMouseEnter={e => e.currentTarget.style.background = C.elevBg}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <Sheet style={{ width: 13, height: 13 }} /> Excel — full history
            </button>
              </div>
            )}
            <button
              onClick={() => setShowCalendar(v => !v)}
              style={{
                padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600,
                fontFamily: 'inherit', cursor: 'pointer', border: '1.5px solid',
                borderColor: showCalendar ? '#6366f1' : C.border,
                background: showCalendar ? '#eef2ff' : C.cardBg,
                color: showCalendar ? '#6366f1' : '#777',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <CalendarDays style={{ width: 13, height: 13 }} /> Calendar
            </button>
          </div>
        </div>

        {/* Stat cards — these ARE the scope filters.
            There used to be five inert cards here and, directly above them,
            eight chips of which four (All / Unpaid / Due Soon / Overdue) named
            the same sets the cards were counting. The card now performs the
            filter it describes, and those four chips are gone.

            Each card's `filter` must select exactly the set the card counted,
            or the number is a promise the list breaks. That cost the "paid"
            card its old label — see `paidRecent`. */}
        <div data-tour="payments-stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 12 }}>
          {[
            { label: 'OVERDUE', filter: 'Overdue', totals: totalOverdue, items: overdueEntries, count: overdueEntries.length, unit: 'invoices', color: RED },
            { label: 'DUE WITHIN 7 DAYS', filter: 'Due Soon', totals: totalDueSoon, items: dueSoonEntries, count: dueSoonEntries.length, unit: 'invoices', color: '#ea580c' },
            { label: 'TOTAL UNPAID', filter: 'Unpaid', totals: totalUnpaid, items: unpaidEntries, count: unpaidEntries.length, unit: 'invoices', color: C.text },
            { label: 'PAID · LAST 14 DAYS', filter: 'Paid', totals: totalPaidRecent, items: paidRecent, count: paidRecent.length, unit: 'paid', color: C.text },
            { label: 'ALL INVOICES', filter: 'All', totals: totalAll, items: entries, countAsValue: entries.length, unit: 'total', color: C.text },
          ].map(stat => {
            // USD-equivalent is the headline number across the app (matches
            // Recoupments). Native breakdown drops to a small caption and
            // only renders when there's a non-USD currency in the mix.
            // Honors per-row locked fx_rate_to_usd via the items-aware
            // fmtUsdItems helper, so paid invoices keep their frozen
            // payment-day rate forever — identical to Recoupments behavior.
            const hasNonUsd = (stat.items || []).some(e => (e?.currency || 'USD').toUpperCase() !== 'USD')
            const usdHeadline = fmtUsdItems(stat.items, fxRates) || fmtTotals(stat.totals)
            const nativeCaption = fmtTotals(stat.totals)
            const active = quickFilter === stat.filter
            return (
              <button
                key={stat.label}
                onClick={() => setQuickFilter(stat.filter)}
                aria-pressed={active}
                title={`Show ${stat.label.toLowerCase()}`}
                style={{
                  background: C.cardBg, borderRadius: 10, padding: '14px 16px',
                  border: '1.5px solid ' + (active ? stat.color : C.border),
                  boxShadow: active ? `inset 0 0 0 1px ${stat.color}` : 'none',
                  textAlign: 'left', fontFamily: 'inherit', cursor: 'pointer',
                  display: 'block', width: '100%',
                }}
              >
                <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: active ? stat.color : C.textFaint, marginBottom: 6 }}>{stat.label}</div>
                {stat.countAsValue != null ? (
                  <>
                    <div style={{ fontSize: 22, fontWeight: 900, color: stat.color }}>{String(stat.countAsValue)}</div>
                    <div style={{ fontSize: 12, color: '#aaa', marginTop: 2 }}>{usdHeadline} {stat.unit}</div>
                    {hasNonUsd && (
                      <div style={{ fontSize: 11, color: '#aaa', marginTop: 1 }}>{nativeCaption}</div>
                    )}
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 22, fontWeight: 900, color: stat.color, whiteSpace: 'nowrap', tabularNums: true }}>{usdHeadline}</div>
                    {hasNonUsd && (
                      <div style={{ fontSize: 11, color: '#aaa', marginTop: 2 }}>{nativeCaption}</div>
                    )}
                    <div style={{ fontSize: 12, color: '#aaa', marginTop: 2 }}>{stat.count} {stat.unit}</div>
                  </>
                )}
              </button>
            )
          })}
        </div>

        {/* The filters with no card of their own. Same single `quickFilter`
            control as the cards above — selecting one clears whichever card is
            lit, which is what it has always done; it is now just visible in two
            places instead of eight chips in one. */}
        <div data-tour="payments-chips" style={{ display: 'flex', gap: 6, marginBottom: 24, alignItems: 'center' }}>
          {WORKFLOW_FILTERS.map(qf => {
            const active = quickFilter === qf
            const st = workflowFilterStats[qf] || { n: 0, usd: '', native: '' }
            const n = st.n
            return (
              <button
                key={qf}
                onClick={() => setQuickFilter(active ? 'All' : qf)}
                aria-pressed={active}
                title={st.native
                  ? `${qf}: ${st.native} across ${n} invoice${n === 1 ? '' : 's'} — shown as ${st.usd} converted`
                  : `${qf}: ${n} invoice${n === 1 ? '' : 's'}`}
                style={{
                  padding: '5px 12px', borderRadius: 20, fontSize: 12.5, fontWeight: 600,
                  fontFamily: 'inherit', cursor: 'pointer', border: '1.5px solid',
                  borderColor: active ? RED : C.border,
                  background: C.cardBg,
                  color: active ? RED : C.textMuted,
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}
              >
                {qf}
                {/* Money first, count second: "how much" is the question, "how
                    many" is the detail. Both are withheld at zero — a chip
                    reading "$0.00 · 0" is noise where an unadorned label says
                    the same thing. */}
                {n > 0 && st.usd && (
                  <span style={{ fontSize: 11.5, fontWeight: 800, color: active ? RED : C.text, fontVariantNumeric: 'tabular-nums' }}>
                    {st.usd}
                  </span>
                )}
                <span style={{ fontSize: 11, fontWeight: 800, color: active ? RED : C.textFaint }}>{n}</span>
              </button>
            )
          })}
        </div>

        {/* Calendar view */}
        {showCalendar && (() => {
          const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
          const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
          const firstDay = new Date(calYear, calMonth, 1).getDay()
          const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate()
          const today = new Date()
          const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`

          // Build map: date string → entries
          const dateMap = {}
          entries.forEach(e => {
            const due = e.scheduled_payment_date ? String(e.scheduled_payment_date).slice(0,10) : null
            const paid = e.payment_date ? String(e.payment_date).slice(0,10) : null
            const inv = e.invoice_date ? String(e.invoice_date).slice(0,10) : null
            // Show on due date if unpaid, on paid date if paid, fallback to invoice date
            const dateKey = e.payment_status === 'Paid' ? (paid || due || inv) : (due || inv)
            if (!dateKey) return
            if (!dateMap[dateKey]) dateMap[dateKey] = []
            dateMap[dateKey].push(e)
          })

          const prevMonth = () => { if (calMonth === 0) { setCalMonth(11); setCalYear(y => y - 1) } else setCalMonth(m => m - 1) }
          const nextMonth = () => { if (calMonth === 11) { setCalMonth(0); setCalYear(y => y + 1) } else setCalMonth(m => m + 1) }

          return (
            <div style={{ background: C.cardBg, borderRadius: 12, border: '1px solid ' + C.border, overflow: 'hidden', marginBottom: 24 }}>
              {/* Calendar header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid ' + C.tdBorder }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <button onClick={prevMonth} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#777' }}><ChevronLeft style={{ width: 16, height: 16 }} /></button>
                  <span style={{ fontSize: 15, fontWeight: 800, color: C.text, minWidth: 160, textAlign: 'center' }}>{MONTHS[calMonth]} {calYear}</span>
                  <button onClick={nextMonth} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#777' }}><ChevronRight style={{ width: 16, height: 16 }} /></button>
                  <button onClick={() => { setCalMonth(today.getMonth()); setCalYear(today.getFullYear()) }}
                    style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, background: 'none', border: '1px solid ' + C.border, borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontFamily: 'inherit' }}>Today</button>
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#999' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: RED, display: 'inline-block' }} />Overdue</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: '#f59e0b', display: 'inline-block' }} />Due</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: GREEN, display: 'inline-block' }} />Paid</span>
                </div>
              </div>
              {/* Day headers */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', borderBottom: '1px solid #f0f0f0' }}>
                {DAYS.map(d => (
                  <div key={d} style={{ padding: '8px 0', textAlign: 'center', fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{d}</div>
                ))}
              </div>
              {/* Calendar grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
                {Array.from({ length: firstDay }).map((_, i) => (
                  <div key={`empty-${i}`} style={{ minHeight: 80, background: C.elevBg, borderBottom: '1px solid ' + C.tdBorder, borderRight: '1px solid ' + C.tdBorder }} />
                ))}
                {Array.from({ length: daysInMonth }).map((_, i) => {
                  const day = i + 1
                  const dateStr = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`
                  const dayEntries = dateMap[dateStr] || []
                  const isToday = dateStr === todayStr
                  return (
                    <div key={day} style={{
                      minHeight: 80, padding: '4px 6px', borderBottom: '1px solid #f5f5f5', borderRight: '1px solid #f5f5f5',
                      background: isToday ? '#eff6ff' : '#fff',
                    }}>
                      <div style={{ fontSize: 11, fontWeight: isToday ? 800 : 600, color: isToday ? '#2563eb' : '#555', marginBottom: 3 }}>{day}</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {dayEntries.slice(0, 3).map(e => {
                          const isPaid = e.payment_status === 'Paid'
                          const isOver = !isPaid && isPastLocal(e.scheduled_payment_date)
                          const bg = isPaid ? '#dcfce7' : isOver ? '#fef2f2' : '#fefce8'
                          const color = isPaid ? '#15803d' : isOver ? '#dc2626' : '#a16207'
                          return (
                            <div key={e.id} title={`${e.payee} — ${fmt(e.amount)} (${e.payment_status || 'Unpaid'})`}
                              style={{ fontSize: 10, fontWeight: 600, color, background: bg, borderRadius: 3, padding: '1px 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'default' }}>
                              {e.payee?.slice(0, 14)} · {fmt(e.amount)}
                            </div>
                          )
                        })}
                        {dayEntries.length > 3 && (
                          <div style={{ fontSize: 9, color: '#999', fontWeight: 600 }}>+{dayEntries.length - 3} more</div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })()}

        {/* Invoices section — grows with content so the page scrolls naturally. */}
        <div data-tour="payments-table" style={{ background: C.cardBg, borderRadius: 12, border: '1px solid ' + C.border, overflow: 'hidden' }}>

          {/* Section header + filters */}
          <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid ' + C.tdBorder }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 15, fontWeight: 800, color: C.text }}>Invoices</span>
              <span style={{ background: C.elevBg, color: C.text, fontSize: 12, fontWeight: 700, padding: '1px 8px', borderRadius: 10 }}>{filtered.length}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input type="text" data-filter placeholder="Search payee, artist, inv #..." value={search} onChange={e => setSearch(e.target.value)} style={inputSty} />
              {/* Amount filter — accepts "500", "500-1000", ">500",
                  "<=250". parseAmountQuery returns null for empty /
                  invalid input so a typo doesn't wipe the list. Amber
                  border signals unrecognized input. */}
              <input
                type="text"
                placeholder="Amount: 500 or >1000"
                value={amountQuery}
                onChange={e => setAmountQuery(e.target.value)}
                style={{
                  ...inputSty,
                  width: 150,
                  borderColor: amountQuery && !parseAmountQuery(amountQuery) ? '#f59e0b' : (inputSty.borderColor || C.border),
                }}
                title={
                  amountQuery && !parseAmountQuery(amountQuery)
                    ? 'Unrecognized amount query — supports "500", "500-1000", ">500", "<=250"'
                    : 'Filter by amount. Accepts 500 · 500-1000 · >500 · <=250'
                }
              />
              <select style={selectSty} value={methodFilter === 'All' ? 'All Methods' : methodFilter} onChange={e => setMethodFilter(e.target.value === 'All Methods' ? 'All' : e.target.value)}>
                <option>All Methods</option>
                {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <select style={selectSty} value={statusFilter === 'All' ? 'All Statuses' : statusFilter} onChange={e => setStatusFilter(e.target.value === 'All Statuses' ? 'All' : e.target.value)}>
                <option>All Statuses</option>
                <option value="Unpaid">Unpaid</option>
                <option value="Paid">Paid</option>
                <option value="Partial">Partial</option>
              </select>
              <select style={selectSty} value={repFilter === 'All' ? 'All Reps' : repFilter} onChange={e => setRepFilter(e.target.value === 'All Reps' ? 'All' : e.target.value)}>
                <option>All Reps</option>
                <option value="No rep">No rep</option>
                {repOptions.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <select style={selectSty} value={sortBy} onChange={e => setSortBy(e.target.value)}>
                {SORT_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <select style={selectSty} value={groupBy} onChange={e => setGroupBy(e.target.value)}>
                {GROUP_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          </div>

          {/* Table — horizontal scroll only; vertical growth is unrestricted so the page scrolls. */}
          <div style={{ overflowX: 'auto' }}>
            {filtered.length === 0 ? (
              entries.length === 0 ? (
                <EmptyState
                  title="Nothing due yet"
                  body="Approved invoices land here on their due date, ordered by what to pay first. Approve one on Approvals, or add one yourself."
                  action={{ label: 'Add invoice', to: '/bk/add' }}
                  source={{ label: 'Approvals', to: '/bk/approvals' }}
                />
              ) : (
                <div style={{ textAlign: 'center', padding: '60px 20px', color: '#999', fontSize: 14 }}>No payments match the current filters.</div>
              )
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    {/* Frozen columns — one sticky <th> with an internal flex
                        layout holds checkbox, Date, Payee, Amount. */}
                    <th style={{
                      ...TH, position: 'sticky', left: 0, zIndex: 3,
                      background: C.thBg, width: FROZEN_TOTAL, padding: 0,
                      boxShadow: edgeShadow,
                    }}>
                      <div style={{ display: 'flex', height: '100%' }}>
                        <div style={{ ...fCell, width: FW.check, justifyContent: 'center' }}>
                          <input
                            type="checkbox"
                            checked={(() => { const u = filtered.filter(e => e.payment_status !== 'Paid'); return u.length > 0 && u.every(e => selectedIds.has(e.id)) })()}
                            onChange={selectAll}
                            style={{ cursor: 'pointer', accentColor: RED }}
                          />
                        </div>
                        <div style={{ ...fHeaderCell, width: FW.date }}>Date</div>
                        <div style={{ ...fHeaderCell, width: FW.payee }}>Payee</div>
                        <div style={{ ...fHeaderCell, width: FW.amount, justifyContent: 'flex-end' }}>Amount</div>
                      </div>
                    </th>
                    <th style={TH}>Artist</th>
                    <th style={TH}>Rep</th>
                    <th style={TH}>Inv #</th>
                    <th style={TH}>Method</th>
                    <th style={TH}>Due Date</th>
                    <th style={TH}>Status</th>
                    <th style={TH}>Bank</th>
                    <th style={TH}>Invoice</th>
                    <th style={TH}>Proof</th>
                    <th style={TH}></th>
                    <th style={TH}></th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.map((group, gi) => (
                    <Fragment key={group.label ?? '__all__'}>
                      {group.label && (
                        <tr key={`g-${gi}`}>
                          <td colSpan="12" style={{ padding: '10px 12px 6px', background: C.elevBg, borderBottom: '1px solid ' + C.tdBorder }}>
                            {group.vendor ? (() => {
                              const payable = group.items.filter(e => e.payment_status !== 'Paid' && !e.on_hold)
                              const held = group.items.filter(e => e.payment_status !== 'Paid' && e.on_hold).length
                              // Families, not rows: a $10k invoice split four
                              // ways is one invoice to pay, and counting its
                              // slices would tell you to cut four transfers.
                              const roots = new Set(payable.map(e => e.parent_id || e.id)).size
                              // What this vendor has open across the whole
                              // page, so a filter narrowing the group reads as
                              // "3 of 13" rather than quietly as "3".
                              const openAll = openFor(group.items[0])?.count || 0
                              const methods = [...new Set(payable.map(e => e.payment_method).filter(Boolean))]
                              return (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: 12.5, fontWeight: 800, color: C.text }}>{group.label}</span>
                                  {roots > 0 && (
                                    <span style={{ fontSize: 11, color: '#999' }}>
                                      {roots}{openAll > roots ? ` of ${openAll}` : ''} open invoice{roots === 1 ? '' : 's'}
                                      {' · '}
                                      <span style={{ fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{fmtTotals(groupByCurrencyByFamily(payable))}</span>
                                      <span style={{ color: '#aaa' }}>{familyUsdSuffix(payable, fxRates)}</span>
                                    </span>
                                  )}
                                  {methods.length > 0 && (
                                    <span style={{ fontSize: 11, color: '#aaa' }}>{methods.join(' · ')}</span>
                                  )}
                                  {held > 0 && (
                                    <span
                                      title="Held invoices are excluded from this total and from Pay all."
                                      style={{ fontSize: 11, fontWeight: 700, color: '#64748b' }}
                                    >
                                      {held} on hold
                                    </span>
                                  )}
                                  {roots > 1 && (
                                    <button
                                      onClick={() => payVendorTogether(group.items)}
                                      title={`Select this vendor's ${roots} payable invoices and record them together.`}
                                      style={{
                                        marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5,
                                        fontSize: 11, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
                                        color: GREEN, background: 'transparent',
                                        border: '1px solid ' + GREEN, borderRadius: 6, padding: '3px 10px',
                                      }}
                                    >
                                      <CheckCircle2 style={{ width: 11, height: 11 }} /> Pay all ({roots})
                                    </button>
                                  )}
                                </div>
                              )
                            })() : (
                              <>
                                <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#888' }}>{group.label}</span>
                                <span style={{ fontSize: 11, color: '#bbb', marginLeft: 8 }}>{group.items.length} invoice{group.items.length !== 1 ? 's' : ''}</span>
                              </>
                            )}
                          </td>
                        </tr>
                      )}
                      {group.items.map(entry => {
                        // Held rows deliberately don't render in red/orange — they're
                        // paused, not "action needed now". Matches the stat-card and
                        // quick-filter semantics: on_hold overrides overdue/due-soon
                        // in every surface.
                        const overdue = isOverdue(entry) && !entry.on_hold
                        const dueSoon = isDueSoon(entry) && !entry.on_hold
                        const isChild  = !!entry.parent_id
                        const isParent = entry.is_split && !entry.parent_id
                        // Hide children of collapsed split parents — but ONLY when the
                        // parent is on this page to be collapsed. A child whose parent
                        // fell outside the 14-day scope has no disclosure to open, and
                        // the old unconditional guard hid it forever: the flatten above
                        // deliberately surfaces such rows as roots, and this line was
                        // silently throwing them away again.
                        const parentOnPage = isChild && idsOnPage.has(entry.parent_id)
                        if (isChild && parentOnPage && !expandedGroups.has(entry.parent_id)) return null
                        // Only offer the disclosure when there is something behind it.
                        const kidsHere = familyOnPage[entry.id]?.count || 0
                        const canExpand = isParent && kidsHere > 0
                        const expanded = expandedGroups.has(entry.id) && canExpand
                        const baseBg = isChild ? C.elevBg : C.rowBg
                        const detailShown = detailOpen.has(entry.id)
                        return (
                          <Fragment key={entry.id}>
                          <tr
                            data-row data-entry-id={entry.id}
                            style={{ background: baseBg }}
                            onMouseEnter={e => e.currentTarget.style.background = C.rowHover}
                            onMouseLeave={e => e.currentTarget.style.background = baseBg}
                          >
                            {/* Frozen columns (single <td>, no gaps): checkbox + date + payee + amount.
                                Edit inputs fill the virtual cells when editingId matches; otherwise display. */}
                            <td style={{
                              padding: 0, position: 'sticky', left: 0, zIndex: 1,
                              background: baseBg, borderBottom: '1px solid ' + C.tdBorder,
                              boxShadow: edgeShadow,
                            }}>
                              <div style={{ display: 'flex', alignItems: 'center', minHeight: 44 }}>
                                {/* Checkbox */}
                                <div style={{ ...fCell, width: FW.check, justifyContent: 'center' }}>
                                  {editingId !== entry.id && (
                                    entry.payment_status !== 'Paid' ||
                                    (entry.has_proof && entry.vendor_email && !entry.confirmation_sent)
                                  ) && (
                                    <input type="checkbox" data-key="x" checked={selectedIds.has(entry.id)} onChange={() => toggleSelect(entry.id)} style={{ cursor: 'pointer', accentColor: RED }} />
                                  )}
                                </div>
                                {/* Date */}
                                <div style={{ ...fCell, width: FW.date }}>
                                  {editingId === entry.id ? (
                                    <input type="date" value={editForm.invoice_date} onChange={e => setEditForm(f => ({ ...f, invoice_date: e.target.value }))}
                                      style={{ ...inputSty, width: '100%', padding: '4px 6px', fontSize: 12 }} />
                                  ) : (
                                    <span style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{fmtDate(entry.invoice_date)}</span>
                                  )}
                                </div>
                                {/* Payee */}
                                <div style={{ ...fCell, width: FW.payee }}>
                                  {editingId === entry.id ? (
                                    <input value={editForm.payee} onChange={e => setEditForm(f => ({ ...f, payee: e.target.value }))}
                                      style={{ ...inputSty, width: '100%', padding: '4px 6px', fontSize: 12, fontWeight: 700 }} />
                                  ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, width: '100%' }}>
                                      <div style={{ fontWeight: 700, color: C.text, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                                        {canExpand && (
                                          <button
                                            onClick={() => toggleGroup(entry.id)}
                                            title={expanded ? 'Collapse splits' : `Expand ${kidsHere} split${kidsHere === 1 ? '' : 's'}`}
                                            style={{
                                              background: 'none', border: 'none', cursor: 'pointer',
                                              padding: 0, fontSize: 10, color: '#a5b4fc',
                                              fontFamily: 'inherit', lineHeight: 1, flexShrink: 0,
                                            }}
                                          >
                                            {expanded ? '▼' : '▶'}
                                          </button>
                                        )}
                                        {isChild ? (
                                          <span style={{ color: C.textFaint, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.payee}</span>
                                        ) : (
                                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.payee}</span>
                                        )}
                                        {/* Several invoices waiting for this vendor — one transfer,
                                            not several. Only on the family ROOT: repeating it on
                                            every split child would imply each child is its own
                                            payable, which is the miscount this whole thing avoids.
                                            Clicking isolates the vendor through the existing search
                                            box, so there's no second filtering path to disagree
                                            with the first. */}
                                        {!isChild && (openFor(entry)?.count || 0) > 1 && (() => {
                                          const v = openFor(entry)
                                          const mixed = v.currencies.length > 1 || v.methods.length > 1
                                          return (
                                            <button
                                              onClick={(ev) => { ev.stopPropagation(); setSearch(entry.payee || '') }}
                                              title={[
                                                // Currency only when the vendor bills in one — PINK
                                                // PANTHERS is EUR, and defaulting to USD would
                                                // misstate the batch total outright.
                                                `${v.count} invoices awaiting payment for ${entry.payee} — ${v.currencies.length === 1 ? fmt(v.total, v.currencies[0]) : `${v.total.toLocaleString()} across ${v.currencies.join(' + ')}`}`,
                                                v.methods.length ? `via ${v.methods.join(' / ')}` : 'no payment method set',
                                                v.currencies.length > 1 ? `MIXED CURRENCY (${v.currencies.join(' / ')}) — cannot be sent as one transfer` : null,
                                                v.methods.length > 1 ? 'Mixed methods — cannot be sent as one transfer' : null,
                                                v.held ? `${v.held} more on hold, not counted` : null,
                                                'Click to show just this vendor',
                                              ].filter(Boolean).join('\n')}
                                              style={{
                                                fontSize: 9, fontWeight: 800, letterSpacing: '0.04em',
                                                background: mixed ? '#fef3c7' : '#dbeafe',
                                                color: mixed ? '#92400e' : '#1d4ed8',
                                                border: 'none', padding: '1px 6px', borderRadius: 3,
                                                whiteSpace: 'nowrap', flexShrink: 0, cursor: 'pointer',
                                                fontFamily: 'inherit',
                                              }}
                                            >
                                              {v.count} OPEN{mixed ? ' ⚠' : ''}
                                            </button>
                                          )
                                        })()}
                                        {isParent && (
                                          <span title={canExpand
                                            ? `Multi-artist split invoice — ${kidsHere} split${kidsHere === 1 ? '' : 's'}`
                                            // No disclosure on this row: the rest of the family sits outside
                                            // this page's unpaid + last-14-days window. Say so, rather than
                                            // offering a control that does nothing.
                                            : 'Multi-artist split invoice — the other splits are older than this page’s 14-day window; open it in the Ledger to see them'} style={{
                                            fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em',
                                            background: '#ede9fe', color: '#6d28d9',
                                            padding: '1px 6px', borderRadius: 3, whiteSpace: 'nowrap', flexShrink: 0,
                                          }}>
                                            Split
                                          </span>
                                        )}
                                      </div>
                                      {!isChild && entry.vendor_email && (
                                        <div style={{ fontSize: 11, color: GREEN, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.vendor_email}</div>
                                      )}
                                    </div>
                                  )}
                                </div>
                                {/* Amount */}
                                <div style={{ ...fCell, width: FW.amount, justifyContent: 'flex-end' }}>
                                  {editingId === entry.id ? (
                                    <input type="number" step="0.01" value={editForm.amount} onChange={e => setEditForm(f => ({ ...f, amount: e.target.value }))}
                                      style={{ ...inputSty, width: '100%', padding: '4px 6px', fontSize: 12, fontWeight: 700, textAlign: 'right' }} />
                                  ) : (() => {
                                    // A collapsed parent stands for the whole invoice, so it
                                    // shows the FAMILY total — and that total comes from the
                                    // server's family_amount, not from summing the children
                                    // this page happens to hold. Summing locally quietly
                                    // under-reported the invoice by every split that fell
                                    // outside the 14-day window ($250 shown for a $2,500
                                    // invoice), which is worse than the missing disclosure:
                                    // a wrong number reads as a right one.
                                    const displayAmt = isParent && !expanded
                                      ? (entry.family_amount != null
                                          ? entry.family_amount
                                          : parseFloat(entry.amount || 0) + (familyOnPage[entry.id]?.sum || 0))
                                      : entry.amount
                                    // Compute USD via a synthetic entry so the
                                    // locked rate on the row applies even when
                                    // we're showing a roll-up amount (family
                                    // members share currency + locked rate).
                                    const synthetic = { amount: displayAmt, currency: entry.currency, fx_rate_to_usd: entry.fx_rate_to_usd }
                                    const usd = usdSuffixForEntry(synthetic, fxRates)
                                    return (
                                      <span
                                        style={{ fontWeight: 900, whiteSpace: 'nowrap', display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end' }}
                                        title={usdSuffixForEntry(synthetic, fxRates, { precise: true }).trim().replace(/^\(|\)$/g, '') || undefined}
                                      >
                                        <span>{fmt(displayAmt, entry.currency)}</span>
                                        {usd && <span style={{ fontWeight: 500, fontSize: 10, color: '#9ca3af' }}>{usd.trim().replace(/^\(|\)$/g, '')}</span>}
                                      </span>
                                    )
                                  })()}
                                </div>
                              </div>
                            </td>
                            {editingId === entry.id ? (
                              <>
                                <td style={TD}><input value={editForm.artist} onChange={e => setEditForm(f => ({ ...f, artist: e.target.value }))} style={{ ...inputSty, width: 100, padding: '4px 6px', fontSize: 12 }} /></td>
                                <td style={TD}>
                                  <select value={editForm.boom_rep} onChange={e => setEditForm(f => ({ ...f, boom_rep: e.target.value }))} style={{ ...selectSty, padding: '4px 24px 4px 6px', fontSize: 11, width: 90 }}>
                                    <option value="">—</option>
                                    {BOOM_REPS.map(r => <option key={r} value={r}>{r}</option>)}
                                  </select>
                                </td>
                                <td style={TD}><input value={editForm.invoice_number} onChange={e => setEditForm(f => ({ ...f, invoice_number: e.target.value }))} style={{ ...inputSty, width: 80, padding: '4px 6px', fontSize: 12 }} /></td>
                                <td style={TD}>
                                  <select value={editForm.payment_method} onChange={e => setEditForm(f => ({ ...f, payment_method: e.target.value }))} style={{ ...selectSty, padding: '4px 24px 4px 6px', fontSize: 11, width: 90 }}>
                                    <option value="">—</option>
                                    {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                                  </select>
                                </td>
                                <td style={TD}><input type="date" value={editForm.scheduled_payment_date} onChange={e => setEditForm(f => ({ ...f, scheduled_payment_date: e.target.value }))} style={{ ...inputSty, width: 120, padding: '4px 6px', fontSize: 12 }} /></td>
                              </>
                            ) : (
                              <>
                                <td style={{ ...TD, fontSize: 12, paddingLeft: isChild ? 24 : undefined }}>
                                  <div style={{ display: 'flex', alignItems: 'center' }}>
                                    {isChild && <span style={{ color: '#a5b4fc', marginRight: 4, flexShrink: 0 }}>↳</span>}
                                    {/* Inline-editable artist. Uncontrolled input keyed by entry id so an
                                        external entries refetch reflows it cleanly; commits on blur or Enter,
                                        Escape reverts. The handler skips no-op edits and rolls back on failure. */}
                                    <input
                                      key={`${entry.id}|${entry.artist || ''}`}
                                      type="text"
                                      defaultValue={entry.artist || ''}
                                      placeholder="—"
                                      disabled={savingArtistId === entry.id}
                                      onBlur={(e) => {
                                        e.currentTarget.style.borderColor = 'transparent'
                                        e.currentTarget.style.background = 'transparent'
                                        handleArtistChange(entry.id, e.currentTarget.value)
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') { e.currentTarget.blur() }
                                        else if (e.key === 'Escape') {
                                          e.currentTarget.value = entry.artist || ''
                                          e.currentTarget.blur()
                                        }
                                      }}
                                      onFocus={(e) => {
                                        e.currentTarget.style.borderColor = C.inputBorder
                                        e.currentTarget.style.background = C.inputBg
                                      }}
                                      onMouseEnter={(e) => {
                                        if (document.activeElement !== e.currentTarget) e.currentTarget.style.borderColor = C.inputBorder
                                      }}
                                      onMouseLeave={(e) => {
                                        if (document.activeElement !== e.currentTarget) e.currentTarget.style.borderColor = 'transparent'
                                      }}
                                      onClick={(e) => e.stopPropagation()}
                                      style={{
                                        background: 'transparent', border: '1px solid transparent',
                                        borderRadius: 4, padding: '2px 4px',
                                        color: entry.artist ? '#555' : '#9ca3af',
                                        fontSize: 12, fontFamily: 'inherit',
                                        width: '100%', minWidth: 70, outline: 'none',
                                        opacity: savingArtistId === entry.id ? 0.5 : 1,
                                      }}
                                    />
                                  </div>
                                </td>
                                <td style={{ ...TD, fontSize: 12 }}>
                                  <select
                                    value={entry.boom_rep || ''}
                                    onChange={e => handleRepChange(entry.id, e.target.value)}
                                    disabled={savingRepId === entry.id}
                                    style={{
                                      background: 'transparent',
                                      border: '1px solid transparent',
                                      borderRadius: 4,
                                      padding: '2px 18px 2px 4px',
                                      color: entry.boom_rep ? C.text : '#9ca3af',
                                      fontSize: 12,
                                      fontFamily: 'inherit',
                                      cursor: 'pointer',
                                      appearance: 'none',
                                      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
                                      backgroundRepeat: 'no-repeat',
                                      backgroundPosition: 'right 2px center',
                                      opacity: savingRepId === entry.id ? 0.5 : 1,
                                    }}
                                    onMouseEnter={e => { e.currentTarget.style.borderColor = C.inputBorder }}
                                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent' }}
                                    onClick={e => e.stopPropagation()}
                                  >
                                    <option value="">—</option>
                                    {BOOM_REPS.map(r => <option key={r} value={r}>{r}</option>)}
                                  </select>
                                </td>
                                <td style={{ ...TD, color: '#555' }}>{entry.invoice_number || '—'}</td>
                                <td style={TD}>
                                  {entry.payment_method ? (
                                    <span style={{ ...badgeBase, ...(METHOD_BADGE[entry.payment_method] || { bg: C.badgeNeutralBg, color: C.text }) }}>{entry.payment_method}</span>
                                  ) : '—'}
                                </td>
                                {/* Editable in place. A bare date input rather
                                    than a click-to-reveal control: the value is
                                    what you are here to change, and hiding it
                                    behind a click is what sent people into the
                                    pencil's whole-row edit for one field.
                                    Transparent chrome keeps the column reading
                                    as text until you touch it, and the overdue /
                                    due-soon colouring survives — it is the only
                                    thing on the row saying this one is late. */}
                                <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                                  <input
                                    type="date"
                                    value={entry.scheduled_payment_date ? String(entry.scheduled_payment_date).slice(0, 10) : ''}
                                    disabled={savingDueId === entry.id}
                                    onChange={e => handleDueDateChange(entry.id, e.target.value)}
                                    onClick={e => e.stopPropagation()}
                                    title={entry.is_split
                                      ? 'Due date — applies to every row of this invoice'
                                      : 'Due date'}
                                    style={{
                                      fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                                      color: overdue ? RED : dueSoon ? '#ea580c' : '#9ca3af',
                                      background: 'transparent', border: '1px solid transparent',
                                      borderRadius: 5, padding: '2px 4px', cursor: 'pointer',
                                      opacity: savingDueId === entry.id ? 0.5 : 1,
                                      colorScheme: C.isDark ? 'dark' : 'light',
                                    }}
                                    onMouseEnter={e => { e.currentTarget.style.borderColor = C.border }}
                                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent' }}
                                  />
                                </td>
                              </>
                            )}
                            <td style={TD}>
                              <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, position: 'relative' }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                <button
                                  onClick={() => {
                                    if ((entry.installment_count || 0) > 0) {
                                      // Installments drive the status server-side; route the click into the modal.
                                      openInstallmentsModal(entry)
                                    } else {
                                      // Open the three-option status picker
                                      // (Paid / Partial / Unpaid). Partial
                                      // opens the installments modal so the
                                      // paid-so-far amount gets recorded.
                                      setStatusMenuId(prev => prev === entry.id ? null : entry.id)
                                    }
                                  }}
                                  disabled={savingId === entry.id}
                                  style={{ ...badgeBase, ...(PAID_BADGE[entry.payment_status] || PAID_BADGE.Unpaid), border: 'none', cursor: 'pointer', fontFamily: 'inherit', opacity: savingId === entry.id ? 0.5 : 1, gap: 4 }}
                                  title={(entry.installment_count || 0) > 0
                                    ? `Paid ${fmt(entry.installments_total || 0, entry.currency)} of ${fmt(entry.family_amount || entry.amount, entry.currency)} — click to manage installments`
                                    : 'Click to change payment status'}
                                >
                                  {savingId === entry.id ? 'Saving…' : (entry.payment_status || 'Unpaid')}
                                  {(entry.installment_count || 0) === 0 && savingId !== entry.id && (
                                    <span style={{ fontSize: 8, opacity: 0.7, marginLeft: 1 }}>▼</span>
                                  )}
                                </button>
                                <BankEvidenceDot row={entry} />
                                </span>
                                {statusMenuId === entry.id && (entry.installment_count || 0) === 0 && (
                                  <div
                                    ref={statusMenuRef}
                                    style={{
                                      position: 'absolute',
                                      top: '100%',
                                      left: 0,
                                      marginTop: 4,
                                      background: C.cardBg,
                                      border: `1px solid ${C.border}`,
                                      borderRadius: 6,
                                      boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
                                      zIndex: 20,
                                      minWidth: 170,
                                      padding: 4,
                                      display: 'flex',
                                      flexDirection: 'column',
                                    }}
                                  >
                                    {[
                                      { value: 'Paid',    label: 'Mark as Paid',    hint: 'Full amount paid' },
                                      { value: 'Partial', label: 'Partially Paid…', hint: 'Record part-payment' },
                                      { value: 'Unpaid',  label: 'Mark as Unpaid',  hint: 'Reset to unpaid'    },
                                    ].map(opt => {
                                      const isCurrent = (entry.payment_status || 'Unpaid') === opt.value
                                      return (
                                        <button
                                          key={opt.value}
                                          onClick={() => {
                                            setStatusMenuId(null)
                                            if (opt.value === 'Paid'    && entry.payment_status !== 'Paid')    handleMarkPaid(entry.id)
                                            else if (opt.value === 'Unpaid' && entry.payment_status !== 'Unpaid') handleMarkUnpaid(entry.id)
                                            else if (opt.value === 'Partial') openInstallmentsModal(entry)
                                          }}
                                          disabled={isCurrent && opt.value !== 'Partial'}
                                          style={{
                                            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                                            padding: '6px 10px',
                                            background: 'transparent',
                                            border: 'none',
                                            borderRadius: 4,
                                            cursor: (isCurrent && opt.value !== 'Partial') ? 'default' : 'pointer',
                                            fontFamily: 'inherit',
                                            fontSize: 12,
                                            fontWeight: 600,
                                            color: (isCurrent && opt.value !== 'Partial') ? '#9ca3af' : C.text,
                                            textAlign: 'left',
                                            whiteSpace: 'nowrap',
                                          }}
                                          onMouseEnter={e => { if (!(isCurrent && opt.value !== 'Partial')) e.currentTarget.style.background = C.hoverBg || 'rgba(0,0,0,0.05)' }}
                                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                                        >
                                          <span>
                                            <span style={{ ...badgeBase, ...(PAID_BADGE[opt.value] || PAID_BADGE.Unpaid), padding: '1px 6px', fontSize: 10, marginRight: 6 }}>{opt.value}</span>
                                            {opt.label}
                                          </span>
                                          {isCurrent && opt.value !== 'Partial' && <span style={{ fontSize: 10, color: '#9ca3af' }}>current</span>}
                                        </button>
                                      )
                                    })}
                                  </div>
                                )}
                                {(entry.installment_count || 0) > 0 && (
                                  <span style={{ fontSize: 10, color: '#d97706', fontWeight: 700, whiteSpace: 'nowrap' }}>
                                    {fmt(entry.installments_total || 0, entry.currency)} / {fmt(entry.family_amount || entry.amount, entry.currency)}
                                  </span>
                                )}
                                {/* What is stopping this one. The chip counts the same
                                    reasons blockedReasons() gives, and NAMES them — a
                                    "blocked" marker you have to open the row to understand
                                    is a second click on every row of the worklist. */}
                                {(() => {
                                  const why = blockedReasons(entry)
                                  if (!why.length) return null
                                  return (
                                    <span
                                      title={`Cannot be completed: ${why.join(' · ')}`}
                                      style={{
                                        ...badgeBase,
                                        background: '#fff7ed', color: '#9a3412',
                                        border: '1px solid #fdba74',
                                        display: 'inline-flex', alignItems: 'center', gap: 3,
                                      }}
                                    >
                                      <AlertCircle style={{ width: 10, height: 10 }} />
                                      {why[0].toUpperCase()}
                                    </span>
                                  )
                                })()}
                                {/* Rush / Hold — surfaced only on unpaid rows. Buttons show
                                    when neither flag is set; badge with clear action shows
                                    when the corresponding flag is set. Server enforces mutex
                                    (rush ⇔ hold), so at most one flag is set at any time and
                                    the conditionals below never overlap. */}
                                {entry.payment_status !== 'Paid' && !entry.rush_requested && !entry.on_hold && (
                                  <button
                                    data-key="u"
                                    onClick={() => { setRushModalEntry(entry); setRushReason('') }}
                                    title="Request this payment be paid ASAP — alerts John"
                                    style={{
                                      background: 'transparent', border: 'none',
                                      padding: '1px 2px', cursor: 'pointer',
                                      color: '#d97706',
                                      display: 'inline-flex', alignItems: 'center', gap: 3,
                                      fontFamily: 'inherit', fontSize: 11, fontWeight: 700,
                                      whiteSpace: 'nowrap',
                                    }}
                                    onMouseEnter={e => { e.currentTarget.style.color = '#b45309' }}
                                    onMouseLeave={e => { e.currentTarget.style.color = '#d97706' }}
                                  >
                                    <Zap style={{ width: 11, height: 11 }} fill="currentColor" />
                                    Request rush
                                  </button>
                                )}
                                {entry.payment_status !== 'Paid' && !entry.rush_requested && !entry.on_hold && (
                                  <button
                                    data-key="h"
                                    onClick={() => { setHoldModalEntry(entry); setHoldReason('') }}
                                    title="Place this payment on hold — pauses it without changing anything else"
                                    style={{
                                      background: 'transparent', border: 'none',
                                      padding: '1px 2px', cursor: 'pointer',
                                      color: '#475569',
                                      display: 'inline-flex', alignItems: 'center', gap: 3,
                                      fontFamily: 'inherit', fontSize: 11, fontWeight: 700,
                                      whiteSpace: 'nowrap',
                                    }}
                                    onMouseEnter={e => { e.currentTarget.style.color = '#1e293b' }}
                                    onMouseLeave={e => { e.currentTarget.style.color = '#475569' }}
                                  >
                                    <Pause style={{ width: 11, height: 11 }} fill="currentColor" />
                                    Hold
                                  </button>
                                )}
                                {entry.rush_requested && (
                                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                    <span
                                      title={`Rush requested by ${entry.rush_requested_by || 'unknown'}${entry.rush_requested_at ? ' on ' + fmtDate(entry.rush_requested_at) : ''}${entry.rush_reason ? '\n\nReason: ' + entry.rush_reason : ''}`}
                                      style={{
                                        ...badgeBase,
                                        background: '#fef3c7', color: '#92400e',
                                        border: '1px solid #fcd34d',
                                        display: 'inline-flex', alignItems: 'center', gap: 3,
                                      }}
                                    >
                                      <Zap style={{ width: 10, height: 10 }} fill="currentColor" />
                                      RUSH
                                    </span>
                                    <button
                                      onClick={() => handleClearRush(entry.id)}
                                      title="Clear rush request"
                                      style={{
                                        background: 'transparent', border: 'none',
                                        padding: 0, cursor: 'pointer', color: '#9ca3af',
                                        display: 'inline-flex', alignItems: 'center',
                                        fontSize: 11,
                                      }}
                                      onMouseEnter={e => { e.currentTarget.style.color = '#dc2626' }}
                                      onMouseLeave={e => { e.currentTarget.style.color = '#9ca3af' }}
                                    >
                                      <X style={{ width: 11, height: 11 }} />
                                    </button>
                                  </div>
                                )}
                                {entry.on_hold && (
                                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                    <span
                                      title={`Held by ${entry.hold_by || 'unknown'}${entry.hold_at ? ' on ' + fmtDate(entry.hold_at) : ''}${entry.hold_reason ? '\n\nReason: ' + entry.hold_reason : ''}`}
                                      style={{
                                        ...badgeBase,
                                        background: '#f1f5f9', color: '#475569',
                                        border: '1px solid #cbd5e1',
                                        display: 'inline-flex', alignItems: 'center', gap: 3,
                                      }}
                                    >
                                      <Pause style={{ width: 10, height: 10 }} fill="currentColor" />
                                      HOLD
                                    </span>
                                    <button
                                      onClick={() => handleClearHold(entry.id)}
                                      title="Release hold"
                                      style={{
                                        background: 'transparent', border: 'none',
                                        padding: 0, cursor: 'pointer', color: '#9ca3af',
                                        display: 'inline-flex', alignItems: 'center',
                                        fontSize: 11,
                                      }}
                                      onMouseEnter={e => { e.currentTarget.style.color = '#dc2626' }}
                                      onMouseLeave={e => { e.currentTarget.style.color = '#9ca3af' }}
                                    >
                                      <X style={{ width: 11, height: 11 }} />
                                    </button>
                                  </div>
                                )}
                                {/* Always show an explicit, labeled link so the multi-payment
                                    workflow is discoverable. Hides only when the row is already
                                    cleanly Paid with no installments — nothing more to record. */}
                                {!(entry.payment_status === 'Paid' && (entry.installment_count || 0) === 0) && (
                                  <button
                                    onClick={() => openInstallmentsModal(entry)}
                                    title={(entry.installment_count || 0) > 0
                                      ? `Manage ${entry.installment_count} payment${entry.installment_count === 1 ? '' : 's'}`
                                      : 'Record a partial payment / multi-payment plan'}
                                    style={{
                                      background: 'transparent',
                                      border: 'none',
                                      borderRadius: 4, padding: '1px 2px', cursor: 'pointer',
                                      color: (entry.installment_count || 0) > 0 ? '#d97706' : '#2563eb',
                                      display: 'inline-flex', alignItems: 'center', gap: 3,
                                      fontFamily: 'inherit', fontSize: 11, fontWeight: 700,
                                      textDecoration: 'underline', textUnderlineOffset: 2,
                                      whiteSpace: 'nowrap',
                                    }}
                                  >
                                    <Receipt style={{ width: 11, height: 11 }} />
                                    {(entry.installment_count || 0) > 0
                                      ? `${entry.installment_count} payment${entry.installment_count === 1 ? '' : 's'}`
                                      : 'Mark partial'}
                                  </button>
                                )}
                              </div>
                            </td>
                            {/* Bank — vendor-supplied routing bank, read-only here.
                                Edits to bank info live on the Vendors page so a single change propagates. */}
                            <td style={{ ...TD, color: '#aaa', fontSize: 12, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                title={entry.vendor_bank || ''}>
                              {entry.vendor_bank || '—'}
                            </td>
                            <td style={TD}>
                              <div style={{ display: 'flex', gap: 6 }}>
                                {entry.has_invoice && (
                                  <button onClick={() => setPreviewFile({ url: `/api/bk/entries/${entry.id}/file/invoice?token=${localStorage.getItem('token')}`, filename: `Invoice-${entry.payee}` })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#2563eb', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 3, fontFamily: 'inherit' }}>
                                    View
                                  </button>
                                )}
                              </div>
                            </td>
                            {/* Proof */}
                            <td style={TD}>
                              {entry.has_proof ? (
                                <button
                                  onClick={() => setPreviewFile({ url: `/api/bk/entries/${entry.id}/file/proof?token=${localStorage.getItem('token')}`, filename: `Proof-${entry.payee}` })}
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: GREEN, fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 3, fontFamily: 'inherit' }}
                                >
                                  <CheckCircle2 style={{ width: 12, height: 12 }} /> View
                                </button>
                              ) : (
                                <div
                                  onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOverId(entry.id) }}
                                  onDragLeave={e => { e.stopPropagation(); setDragOverId(null) }}
                                  onDrop={e => {
                                    e.preventDefault(); e.stopPropagation(); setDragOverId(null)
                                    const file = e.dataTransfer.files?.[0]
                                    if (file) uploadProof(entry.id, file)
                                  }}
                                  onClick={() => fileInputRefs.current[entry.id]?.click()}
                                  style={{
                                    border: `1.5px dashed ${dragOverId === entry.id ? '#6366f1' : '#d1d5db'}`,
                                    borderRadius: 8, padding: '10px 16px', cursor: 'pointer',
                                    background: dragOverId === entry.id ? '#eef2ff' : C.elevBg,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                                    fontSize: 12, color: '#888', whiteSpace: 'nowrap',
                                    transition: 'all 0.15s', minWidth: 100,
                                  }}
                                >
                                  {uploadingId === entry.id ? (
                                    <Loader style={{ width: 12, height: 12, animation: 'spin 0.8s linear infinite' }} />
                                  ) : (
                                    <Upload style={{ width: 12, height: 12 }} />
                                  )}
                                  {uploadingId === entry.id ? 'Uploading…' : 'Drop file'}
                                  <input
                                    ref={el => { fileInputRefs.current[entry.id] = el }}
                                    type="file"
                                    accept=".pdf,.png,.jpg,.jpeg"
                                    style={{ display: 'none' }}
                                    onChange={e => {
                                      const file = e.target.files?.[0]
                                      if (file) uploadProof(entry.id, file)
                                      e.target.value = ''
                                    }}
                                  />
                                </div>
                              )}
                            </td>
                            {/* Send Confirmation */}
                            <td style={TD}>
                              {entry.payment_status === 'Paid' && !entry.confirmation_sent && (
                                <>
                                  {/* When proof or an address is missing the Send button
                                      simply does not render, and the cell goes quiet — the
                                      row reads as finished. 22 of the 51 recently-paid rows
                                      are in that state. Say which is missing instead. */}
                                  {!(entry.has_proof && entry.vendor_email) && (
                                    <span
                                      title={!entry.has_proof
                                        ? 'No payment proof on this invoice, so no confirmation can be sent. Drop a file on the Proof cell.'
                                        : 'No vendor email on this invoice, so there is nowhere to send a confirmation.'}
                                      style={{
                                        ...badgeBase,
                                        background: '#fff7ed', color: '#9a3412',
                                        border: '1px solid #fdba74',
                                        display: 'inline-flex', alignItems: 'center', gap: 3,
                                      }}
                                    >
                                      <AlertCircle style={{ width: 10, height: 10 }} />
                                      {!entry.has_proof ? 'NEEDS PROOF' : 'NO EMAIL'}
                                    </span>
                                  )}
                                  {entry.has_proof && entry.vendor_email && (
                                    <button
                                      onClick={() => openConfirmModal(entry)}
                                      disabled={sendingConfirmId === entry.id || confirmEntry?.id === entry.id}
                                      style={{
                                        background: 'none', border: `1.5px solid ${GREEN}`, borderRadius: 6,
                                        padding: '4px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
                                        fontSize: 11, fontWeight: 700, color: GREEN, fontFamily: 'inherit',
                                        opacity: sendingConfirmId === entry.id ? 0.5 : 1,
                                        whiteSpace: 'nowrap',
                                      }}
                                      onMouseEnter={e => { e.currentTarget.style.background = GREEN; e.currentTarget.style.color = '#fff' }}
                                      onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = GREEN }}
                                      title="Preview & send payment confirmation"
                                    >
                                      {sendingConfirmId === entry.id
                                        ? <Loader style={{ width: 12, height: 12, animation: 'spin 0.8s linear infinite' }} />
                                        : <Send style={{ width: 12, height: 12 }} />
                                      }
                                      {sendingConfirmId === entry.id ? 'Sending…' : 'Send'}
                                    </button>
                                  )}
                                  <button
                                    onClick={async () => {
                                      await api.post(`/bk/payments/${entry.id}/mark-sent`)
                                      setEntries(prev => prev.map(e => e.id === entry.id ? { ...e, confirmation_sent: true } : e))
                                      toast('Marked as sent')
                                    }}
                                    style={{
                                      background: 'none', border: '1.5px solid ' + C.border, borderRadius: 6,
                                      padding: '4px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
                                      fontSize: 11, fontWeight: 600, color: '#999', fontFamily: 'inherit',
                                      whiteSpace: 'nowrap',
                                    }}
                                    title="Mark as manually sent"
                                  >
                                    Mark Sent
                                  </button>
                                </>
                              )}
                              {entry.payment_status === 'Paid' && entry.confirmation_sent && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: '#16a34a' }}>
                                    <CheckCircle2 style={{ width: 12, height: 12 }} /> Sent
                                  </span>
                                  <button
                                    onClick={async () => {
                                      if (!window.confirm(`Reset "${entry.payee}" so the confirmation can be re-sent?`)) return
                                      try {
                                        await api.post(`/bk/payments/${entry.id}/mark-unsent`)
                                        setEntries(prev => prev.map(e => e.id === entry.id ? { ...e, confirmation_sent: false } : e))
                                        toast('Reset to pending — Send button will appear.')
                                      } catch (err) {
                                        toast.error('Failed to reset: ' + (err.response?.data?.error || err.message))
                                      }
                                    }}
                                    title="Reset so the confirmation can be re-sent (e.g. amount was wrong)"
                                    style={{
                                      background: 'none', border: '1px solid ' + C.border, borderRadius: 4,
                                      padding: '2px 6px', fontSize: 10, fontWeight: 600, color: C.textMuted,
                                      cursor: 'pointer', fontFamily: 'inherit',
                                    }}
                                  >
                                    Undo
                                  </button>
                                </div>
                              )}
                            </td>
                            {/* Actions: Edit / Delete */}
                            <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                              {editingId === entry.id ? (
                                <div style={{ display: 'flex', gap: 4 }}>
                                  <button
                                    onClick={() => saveEdit(entry.id)}
                                    disabled={savingEdit}
                                    style={{ background: '#2563eb', border: 'none', borderRadius: 5, padding: '4px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 700, color: '#fff', fontFamily: 'inherit', opacity: savingEdit ? 0.5 : 1 }}
                                  >
                                    <Save style={{ width: 11, height: 11 }} /> Save
                                  </button>
                                  <button
                                    onClick={cancelEdit}
                                    style={{ background: C.elevBg, border: '1px solid ' + C.border, borderRadius: 5, padding: '4px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 600, color: C.textMuted, fontFamily: 'inherit' }}
                                  >
                                    <X style={{ width: 11, height: 11 }} />
                                  </button>
                                </div>
                              ) : (
                                <div style={{ display: 'flex', gap: 4 }}>
                                  <button
                                    onClick={() => startEdit(entry)}
                                    title="Edit entry"
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', padding: 3, display: 'flex' }}
                                    onMouseEnter={e => e.currentTarget.style.color = '#2563eb'}
                                    onMouseLeave={e => e.currentTarget.style.color = '#ccc'}
                                  >
                                    <Pencil style={{ width: 13, height: 13 }} />
                                  </button>
                                  {/* Split between artists / songs. Only on a
                                      family root: 99 of the 312 rows here are
                                      already children of one. */}
                                  {!entry.parent_id && (
                                    <button
                                      onClick={() => setSplitEntry(entry)}
                                      title={entry.is_split
                                        ? 'Re-split this invoice between artists'
                                        : 'Split this invoice between artists / songs'}
                                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: entry.is_split ? '#6366f1' : '#ccc', padding: 3, display: 'flex' }}
                                      onMouseEnter={e => e.currentTarget.style.color = '#6366f1'}
                                      onMouseLeave={e => e.currentTarget.style.color = entry.is_split ? '#6366f1' : '#ccc'}
                                    >
                                      <Scissors style={{ width: 13, height: 13 }} />
                                    </button>
                                  )}
                                  <button
                                    onClick={() => handleDelete(entry.id)}
                                    disabled={deletingId === entry.id}
                                    title="Delete entry"
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', padding: 3, display: 'flex', opacity: deletingId === entry.id ? 0.3 : 1 }}
                                    onMouseEnter={e => e.currentTarget.style.color = RED}
                                    onMouseLeave={e => e.currentTarget.style.color = '#ccc'}
                                  >
                                    <Trash2 style={{ width: 13, height: 13 }} />
                                  </button>
                                  {/* The whole invoice, under the row. Separate
                                      from the split-family disclosure on the
                                      left: that one reveals other ROWS, this
                                      reveals the rest of THIS one. */}
                                  <button
                                    onClick={() => toggleDetail(entry.id)}
                                    title={detailShown ? 'Hide details' : 'Show everything on this invoice'}
                                    aria-expanded={detailShown}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: detailShown ? '#6366f1' : '#ccc', padding: 3, display: 'flex' }}
                                    onMouseEnter={e => e.currentTarget.style.color = '#6366f1'}
                                    onMouseLeave={e => e.currentTarget.style.color = detailShown ? '#6366f1' : '#ccc'}
                                  >
                                    <ChevronsUpDown style={{ width: 13, height: 13 }} />
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                          {detailShown && (
                            <PaymentDetailPanel
                              entry={entry}
                              colSpan={14}
                              isAdmin={isBkAdmin}
                              onEdit={editField}
                              editableFields={PANEL_EDITABLE}
                            />
                          )}
                          </Fragment>
                        )
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

      </div>{/* /scrollable middle: maxWidth content wrapper */}
      </div>{/* /scrollable middle: overflow:auto wrapper */}

      {/* Bottom bar — outside the scroll area so it's always at viewport
          bottom and can never overlap the table rows above. */}
      <div data-tour="payments-actions" style={{ flexShrink: 0, padding: '0 24px 24px', background: C.pageBg }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <div style={{
          background: C.cardBg, borderRadius: 12, border: '1px solid ' + C.border,
          padding: '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', gap: 32 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: C.textFaint }}>Filtered Unpaid</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: RED }}>{filteredUnpaidTotalsDisplay}<span style={{ fontSize: 12, fontWeight: 600, color: C.textFaint }}>{familyUsdSuffix(filtered.filter(e => e.payment_status !== 'Paid'), fxRates)}</span></div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: C.textFaint }}>Selected Total</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: C.text }}>{selectedTotalsDisplay}<span style={{ fontSize: 12, fontWeight: 600, color: C.textFaint }}>{familyUsdSuffix(selectedEntries, fxRates)}</span></div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* Selection, as one control instead of three peer buttons.
                Select All / Select Pending / Clear each occupied the same
                visual weight as "Mark Selected Paid", so the bar could show
                seven equally-loud buttons and none of them read as the one you
                came for. These are quiet links; the writes stay buttons. */}
            {(() => {
              const unpaidRows = filtered.filter(e => e.payment_status !== 'Paid')
              const pending = filtered.filter(isPendingConfirmation)
              const allSelected = unpaidRows.length > 0 && unpaidRows.every(e => selectedIds.has(e.id))
              const allPendingSelected = pending.length > 0 && pending.every(e => selectedIds.has(e.id))
              const link = (tone) => ({
                background: 'none', border: 'none', padding: 0, fontFamily: 'inherit',
                fontSize: 12, fontWeight: 700, cursor: 'pointer', color: tone,
                textDecoration: 'underline', textUnderlineOffset: 3,
              })
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: selectedIds.size ? C.text : C.textFaint, whiteSpace: 'nowrap' }}>
                    {selectedIds.size} selected
                  </span>
                  {unpaidRows.length > 0 && (
                    <button onClick={selectAll} style={link(allSelected ? RED : C.textMuted)}>
                      {allSelected ? 'None' : `All ${unpaidRows.length}`}
                    </button>
                  )}
                  {pending.length > 0 && (
                    <button
                      onClick={selectAllPendingConfirmations}
                      style={link(allPendingSelected ? GREEN : C.textMuted)}
                      title="Select every paid row that's waiting on a confirmation email"
                    >
                      {allPendingSelected ? 'No pending' : `Pending ${pending.length}`}
                    </button>
                  )}
                  {selectedIds.size > 0 && (
                    <button onClick={() => setSelectedIds(new Set())} style={link(C.textFaint)}>Clear</button>
                  )}
                </div>
              )
            })()}
            {/* CC-the-rep moved off the FILTER toolbar, where it was the one
                control among eight that changed what an email says rather than
                which rows are listed. It shows when a confirmation is actually
                sendable from this view — it drives both the single-row preview
                and the bulk send, so it has to be set BEFORE either. Default
                stays OFF and still persists in localStorage. */}
            {filtered.some(isPendingConfirmation) && (
              <label
                title="When checked, each payment-confirmation email CCs the invoice's assigned Market Street rep. Leave unchecked to send only to the vendor."
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                  fontSize: 12, fontWeight: 600, color: ccRep ? '#1e40af' : C.textMuted,
                  padding: '6px 10px', borderRadius: 8,
                  border: '1px solid ' + (ccRep ? '#bfdbfe' : C.border),
                  background: ccRep ? '#eff6ff' : 'transparent',
                  whiteSpace: 'nowrap',
                }}
              >
                <input
                  type="checkbox"
                  checked={ccRep}
                  onChange={e => setCcRep(e.target.checked)}
                  style={{ cursor: 'pointer', accentColor: RED }}
                />
                CC rep{ccRep && <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}> on</span>}
              </label>
            )}
            {(() => {
              // Approval + Mark-Paid only apply to selected UNPAID rows. Paid
              // rows can now also be selected (for the bulk confirmation
              // button below) so we gate the unpaid-only buttons here.
              const unpaidSelectedCount = filtered.filter(e => selectedIds.has(e.id) && e.payment_status !== 'Paid').length
              const hasUnpaidSelected = unpaidSelectedCount > 0
              return (
                <>
                  <button
                    onClick={() => setShowApprovalModal(true)}
                    disabled={!hasUnpaidSelected}
                    style={{
                      background: hasUnpaidSelected ? '#2563eb' : '#e5e5e5',
                      color: hasUnpaidSelected ? '#fff' : '#aaa',
                      border: 'none', borderRadius: 8, padding: '8px 16px',
                      fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                      cursor: hasUnpaidSelected ? 'pointer' : 'default',
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}
                    title="Email the approver an Excel summary + invoice PDFs for the selected unpaid entries"
                  >
                    <Mail style={{ width: 14, height: 14 }} /> Send for Approval{hasUnpaidSelected && unpaidSelectedCount < selectedIds.size ? ` (${unpaidSelectedCount})` : ''}
                  </button>
                  <button
                    onClick={handleBulkMarkPaid}
                    disabled={!hasUnpaidSelected || savingId === 'bulk'}
                    style={{
                      background: hasUnpaidSelected ? GREEN : '#e5e5e5',
                      color: hasUnpaidSelected ? '#fff' : '#aaa',
                      border: 'none', borderRadius: 8, padding: '8px 20px',
                      fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                      cursor: hasUnpaidSelected ? 'pointer' : 'default',
                      opacity: savingId === 'bulk' ? 0.5 : 1,
                    }}
                  >
                    {savingId === 'bulk' ? 'Marking…' : `Mark Selected Paid${hasUnpaidSelected && unpaidSelectedCount < selectedIds.size ? ` (${unpaidSelectedCount})` : ''}`}
                  </button>
                </>
              )
            })()}
            {/* Bulk Request Rush — only rows that are unpaid AND not already
                rushed are eligible. Button is hidden when there's nothing
                rushable so the toolbar doesn't carry dead chrome. */}
            {(() => {
              const eligible = filtered.filter(e =>
                selectedIds.has(e.id) &&
                e.payment_status !== 'Paid' &&
                !e.rush_requested
              )
              if (!eligible.length) return null
              return (
                <button
                  onClick={() => { setBulkRushOpen(true); setBulkRushReason('') }}
                  style={{
                    background: '#f59e0b', color: '#fff',
                    border: 'none', borderRadius: 8, padding: '8px 16px',
                    fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                    cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}
                  title={`Request rush on ${eligible.length} selected unrushed payment${eligible.length === 1 ? '' : 's'}.`}
                >
                  <Zap style={{ width: 14, height: 14 }} fill="currentColor" /> Request Rush ({eligible.length})
                </button>
              )
            })()}
            {/* Bulk Hold — mirrors Bulk Rush. Eligible = selected + unpaid +
                not-already-held. Rush and hold are mutex, so a rushed row
                is still hold-eligible (setting hold will clear rush). */}
            {(() => {
              const eligible = filtered.filter(e =>
                selectedIds.has(e.id) &&
                e.payment_status !== 'Paid' &&
                !e.on_hold
              )
              if (!eligible.length) return null
              return (
                <button
                  onClick={() => { setBulkHoldOpen(true); setBulkHoldReason('') }}
                  style={{
                    background: '#64748b', color: '#fff',
                    border: 'none', borderRadius: 8, padding: '8px 16px',
                    fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                    cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}
                  title={`Place ${eligible.length} selected payment${eligible.length === 1 ? '' : 's'} on hold.`}
                >
                  <Pause style={{ width: 14, height: 14 }} fill="currentColor" /> Hold ({eligible.length})
                </button>
              )
            })()}
            {/* Bulk-send selected confirmations — only acts on rows the user
                has checked. Multi-invoice vendors are bundled into one email. */}
            {(() => {
              const eligible = filtered.filter(e =>
                selectedIds.has(e.id) &&
                e.payment_status === 'Paid' && !e.confirmation_sent &&
                e.vendor_email && e.has_proof
              )
              if (!eligible.length) return null
              const vendorCount = new Set(eligible.map(e => (e.vendor_email || '').toLowerCase().trim())).size
              return (
                <button
                  onClick={sendAllPendingConfirmations}
                  disabled={sendingBulk}
                  style={{
                    background: sendingBulk ? '#a3a3a3' : GREEN,
                    color: '#fff',
                    border: 'none', borderRadius: 8, padding: '8px 20px',
                    fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                    cursor: sendingBulk ? 'wait' : 'pointer',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}
                  title={`${eligible.length} selected invoice${eligible.length === 1 ? '' : 's'} pending confirmation across ${vendorCount} vendor${vendorCount === 1 ? '' : 's'}. Multi-invoice vendors get one combined email.`}
                >
                  <Send style={{ width: 14, height: 14 }} />
                  {sendingBulk
                    ? 'Sending…'
                    : `Send ${eligible.length} Selected${vendorCount < eligible.length ? ` (${vendorCount} email${vendorCount === 1 ? '' : 's'})` : ''}`}
                </button>
              )
            })()}
          </div>
        </div>
      </div>{/* /bar centering */}
      </div>{/* /bar wrapper */}

      {overlays}
    </div>
  )
}
