import { Fragment, useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Loader, AlertCircle, Trash2, Undo2, Download, ExternalLink, Scissors, Plus, Receipt, Ban, RotateCcw, AlertTriangle, ChevronDown, ChevronUp, Copy, ClipboardList } from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import api from '../api'
import { PAYMENT_METHODS, CURRENCIES, CATEGORIES, SOCIAL_PLATFORMS } from '../constants'
import { useCategories, useIncomeCategories } from '../context/CategoriesContext'
import { useBoomReps } from '../context/BoomRepsContext'
import FilePreview from '../components/FilePreview'
// Shared with the Payments dashboard so the two pages cannot drift on what a
// split is — see components/SplitInvoiceModal.jsx.
import SplitInvoiceModal from '../components/SplitInvoiceModal'
import FlagButton from '../components/FlagButton'
import BankEvidenceDot from '../components/BankEvidenceDot'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import useHotkeys from '../hooks/useHotkeys'
import SearchableSelect from '../components/SearchableSelect'
import getDarkColors from '../utils/darkColors'
import { useFxRates } from '../context/FxRatesContext'
import { usdSuffixForEntry, usdItemsSuffix, normalizeArtistKey, parseAmountQuery, filterSocialsForArtist, familyArtists, isPastLocal, isBankStatementRow, normalizeInvoiceNum } from '../utils'
import { dispositionOf, summariseStatement, extraTransactions } from '../lib/statementLens'
// The statement display vocabulary, shared with Bank Matching and the
// Statements library — one answer to "what is this account called" and "what is
// this statement called", rather than a third copy here.
import { acctLabel, stmtLabel, fmtDate, isChannelOnlyPayee, txVendorLinkName } from '../utils/bankDisplay'
// The bank month, held outside the component tree so it survives switching to
// another Banking tab (each tab is its own route, so this page unmounts).
import { useBankScope, fetchStatements, fetchStatementDetail, reloadBankDetail } from '../lib/bankScope'
import PayeeLink from '../components/PayeeLink'
import { loadPlan } from '../lib/recoupmentPlan'
import useIsMobile from '../hooks/useIsMobile'
import LedgerCard from '../components/mobile/LedgerCard'
import LedgerEntrySheet from '../components/mobile/LedgerEntrySheet'
import FilterSheet, { FilterField } from '../components/mobile/FilterSheet'

// A stable identity for the invoiced half, which reads no statements. A fresh
// [] here would be a new dependency on every render for the memos below it.
const EMPTY_STATEMENTS = []

// Inline-editable cells use a "blank choice" sentinel — REP_OPTIONS now
// gets built inside the component since BOOM_REPS is admin-curated at
// runtime. METHOD_OPTIONS stays static (no admin curation of methods).
const METHOD_OPTIONS = ['', ...PAYMENT_METHODS]
const PAYMENT_TERMS  = ['', 'Net 15', 'Net 30', 'Hold', 'Custom']

function calcDueDate(invoiceDate, terms) {
  if (!invoiceDate || !terms) return null
  if (terms === 'Hold' || terms === 'Custom') return null
  const days = terms === 'Net 15' ? 15 : terms === 'Net 30' ? 30 : 0
  if (!days) return null
  const d = new Date(invoiceDate)
  if (isNaN(d)) return null
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}
const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$', MXN: 'MX$', JPY: '¥', BRL: 'R$', CHF: 'Fr ' }

const RED = '#334155'

function fmt(v, currency = 'USD') {
  if (!v && v !== 0) return '—'
  const num = Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const code = (currency || 'USD').toUpperCase()
  const sym = CURRENCY_SYMBOLS[code]
  return sym ? sym + num : code + '\u00a0' + num
}

function fmtShortDate(dateStr) {
  if (!dateStr) return '—'
  const s = String(dateStr).slice(0, 10)
  const parts = s.split('-')
  if (parts.length !== 3) return '—'
  return `${parts[1]}/${parts[2]}/${parts[0].slice(2)}`
}

// ── Column definitions ──────────────────────────────────────────────────────
// Always shown: Date, Payee, Category, Artist, Amount, Notes, Paid?, QB?
// Toggleable (default visible): Song, Inv #, Currency, Market Street Rep, Method, Reimb?, Recoupable?, UFR?, Cobrand?, Inv, W9, Proof, Receipt
// Toggleable columns — default visibility set per column
const TOGGLEABLE_COLS = [
  // Identity
  { key: 'Description', label: 'Description', defaultOn: true  },
  // What for
  { key: 'Song',        label: 'Song',        defaultOn: true  },
  { key: 'Inv #',       label: 'Inv #',       defaultOn: true  },
  // Money
  { key: 'Currency',    label: 'Currency',    defaultOn: false },
  // Vendor contact
  { key: 'Email',       label: 'Email',       defaultOn: true  },
  { key: 'Address',     label: 'Address',     defaultOn: false },
  { key: 'Bank',        label: 'Bank',        defaultOn: true  },
  { key: 'Socials',     label: 'Socials',     defaultOn: true  },
  { key: 'Market Street Rep',    label: 'Market Street Rep',    defaultOn: true  },
  // Payment
  { key: 'Method',      label: 'Method',      defaultOn: true  },
  { key: 'Terms',       label: 'Terms',       defaultOn: false },
  { key: 'Due Date',    label: 'Due Date',    defaultOn: false },
  { key: 'Paid By',     label: 'Paid By',     defaultOn: true  },
  { key: 'Date Paid',   label: 'Date Paid',   defaultOn: false },
  { key: 'Pay Ref',     label: 'Pay Ref',     defaultOn: false },
  // Documents
  { key: 'Inv',         label: 'Inv',         defaultOn: true  },
  { key: 'W9',          label: 'W9',          defaultOn: true  },
  { key: 'Proof',       label: 'Proof',       defaultOn: true  },
  { key: 'Receipt',     label: 'Receipt',     defaultOn: true  },
  // Tracking
  { key: 'QB?',         label: 'QB?',         defaultOn: false },
  { key: 'Recoupable?', label: 'Recoupable?', defaultOn: false },
  { key: 'UFR?',        label: 'UFR?',        defaultOn: false },
  { key: 'Campaign?',   label: 'Campaign?',   defaultOn: false },
  { key: 'Tone Labels', label: 'Tone Labels', defaultOn: true  },
  { key: 'Reimb?',      label: 'Reimb?',      defaultOn: true  },
  { key: 'Cobrand?',    label: 'Cobrand?',    defaultOn: false },
  { key: 'Bulk Deal?',  label: 'Bulk Deal?',  defaultOn: false },
  // Meta
  { key: 'Source',      label: 'Source',      defaultOn: true  },
  { key: 'Approved By', label: 'Approved By', defaultOn: false },
  { key: 'Uploaded',    label: 'Uploaded',    defaultOn: false },
  // ── What the vendor typed on the submit form ─────────────────────────────
  //
  // John, 2026-09-01: "all information thats submitted via the vendor form
  // should have its own column in the ledger." Most of the form already had
  // one — payee, email, address, bank, socials, artist, song, amount, currency,
  // category, rep, terms, the four documents. These are the rest of it, and
  // until now they were only visible on Approvals, or not at all.
  //
  // ALL DEFAULT OFF, and grouped behind their own heading in the Columns menu
  // with a one-click preset. Thirteen more columns switched on by default would
  // push Amount off the right of a 1440px screen; the ask was that the data be
  // reachable, not that the table become unreadable.
  //
  // Most of them read `payment_snapshot` — the per-invoice copy of how this one
  // was to be paid. It only started being written on 2026-08-31, and the newest
  // submission at the time of writing predates that deploy, so on today's 383
  // vendor rows these are EMPTY and the heading says so. Blank means "submitted
  // before we asked", never "no answer given" — which is why nothing falls back
  // to the vendor's current profile: that would print today's account details
  // onto an invoice from March, the exact confusion the snapshot exists to stop.
  { key: 'Vendor Name',   label: 'Vendor Name (as typed)', defaultOn: false, group: 'Vendor form' },
  { key: 'CC Emails',     label: 'CC Emails',              defaultOn: false, group: 'Vendor form' },
  { key: 'Acct Type',     label: 'Account Type',           defaultOn: false, group: 'Vendor form' },
  { key: 'Acct Holder',   label: 'Name on Account',        defaultOn: false, group: 'Vendor form' },
  { key: 'Acct Last4',    label: 'Account (last 4)',       defaultOn: false, group: 'Vendor form' },
  { key: 'Wire Scope',    label: 'Wire Scope',             defaultOn: false, group: 'Vendor form' },
  { key: 'Bank Address',  label: 'Bank Address',           defaultOn: false, group: 'Vendor form' },
  { key: 'Benef Address', label: 'Beneficiary Address',    defaultOn: false, group: 'Vendor form' },
  { key: 'Intermediary',  label: 'Intermediary Bank',      defaultOn: false, group: 'Vendor form' },
  { key: 'PayPal',        label: 'PayPal Handle',          defaultOn: false, group: 'Vendor form' },
  { key: 'Pay Check',     label: 'Details vs Invoice',     defaultOn: false, group: 'Vendor form' },
  { key: 'Off Roster?',   label: 'Off-roster Artist?',     defaultOn: false, group: 'Vendor form' },
  { key: 'Attachments',   label: 'Extra Files',            defaultOn: false, group: 'Vendor form' },
]

// The vendor-form block above, as a one-click preset.
const VENDOR_FORM_COLS = TOGGLEABLE_COLS.filter(c => c.group === 'Vendor form').map(c => c.key)

// Account and routing numbers, IBANs and SWIFT codes are deliberately NOT in
// that list, and this is the note saying so rather than an oversight.
//
// They are the one part of a submission that never lands on the invoice: they
// live encrypted in `vendor_payment_details`, single-copy, and the only route
// that decrypts them is admin-only and writes an audit row PER READ. A ledger
// column would fire that audit for every rendered row and put a bank account
// number in every screenshot of this page. `Account (last 4)` says which account
// a payment pointed at, and the full value stays one deliberate click away on
// the vendor page.

// Columns that only mean anything on a bank-created entry, so they are only
// OFFERED there. On the invoiced half they would be three empty columns and
// three more toggles in a menu that already has 28.
//
// All three read `bank_evidence`, which every /bk/entries row already carries —
// the shared bankEvidenceCols() helper resolves the transaction through
// COALESCE(parent_id, id), so a split child shows its family's bank line rather
// than nothing.
const BANK_ONLY_COLS = [
  { key: 'Statement',   label: 'Statement',   defaultOn: true },
  { key: 'Bank line',   label: 'Bank line',   defaultOn: true },
  { key: 'Inv wanted?', label: 'Inv wanted?', defaultOn: true },
]

const DEFAULT_HIDDEN = TOGGLEABLE_COLS.filter(c => !c.defaultOn).map(c => c.key)

// ── The two halves of the ledger ─────────────────────────────────────────────
//
// `bank` mode lists the entries the app CREATED by booking a bank debit —
// measured at 2,326 of 3,692 rows, 62%, $3,640,421. Every one of them has no
// invoice number, no file, no flag and no artist, and is already approved and
// Paid. So a dozen of the 28 toggleable columns are structurally empty there,
// and the page's invoice controls have nothing to act on.
//
// John, 2026-08-20: "I want the bank ledger to be more similar to the normal
// ledger." So this is no longer the default — the bank half opens with the same
// columns as the invoiced one, and you hide what you don't want.
//
// The list stays, as a one-click PRESET in the column menu, because it is
// measured knowledge rather than a guess: on 1,972 live bank rows, nine of these
// hold a value on ZERO of them (Inv #, Inv, W9, Proof, Receipt, Address, Bank,
// Reimb?, Bulk Deal?), Email on exactly one, and Terms/Campaign? on all of them
// but only because the columns default to 'Net 30' and 'Yes'. Deleting the list
// would throw that measurement away; demoting it to a preset makes it optional.
//
// The four DOCUMENT cells are the reason the default had to change: they are
// where a late-arriving invoice goes, and hiding them meant attaching one
// required a detour through this menu first.
const BANK_MODE_HIDDEN = [
  'Inv #', 'Inv', 'W9', 'Proof', 'Receipt',     // no document exists, by definition
  'Email', 'Address', 'Bank', 'Socials',        // vendor contact: never captured for a descriptor
  'Terms', 'Due Date',                          // nothing was ever scheduled; the money already left
  'Reimb?', 'Cobrand?', 'Bulk Deal?', 'Campaign?',
  'Source',                                     // every row says 'bank_statement'
]
// Separate keys, deliberately. One key would make hiding a column on one half
// silently rearrange the other — and the two halves want almost opposite
// defaults, so the collision would be constant rather than occasional.
// The bank key is VERSIONED. Its stored value is what an earlier default wrote,
// not a choice anybody made, so reading it would show the old 16-hidden view
// forever and the change would look like it did nothing. `_v2` starts the bank
// half from the new default once; every hide after that persists as normal. The
// invoiced key is untouched — its default has not changed, so its stored values
// are real preferences.
const colStorageKey = (bank) => (bank ? 'bk_bank_ledger_hidden_cols_v2' : 'bk_ledger_hidden_cols')
// Both halves now start from the same place.
const loadHiddenColsDefault = () => DEFAULT_HIDDEN
function loadHiddenCols(bank = false) {
  const fallback = loadHiddenColsDefault()
  try {
    const stored = localStorage.getItem(colStorageKey(bank))
    return stored ? JSON.parse(stored) : fallback
  } catch { return fallback }
}

// ── Badge helpers ────────────────────────────────────────────────────────────
const PAID_BADGE = {
  Paid:    { bg: '#d1fae5', color: '#065f46' },
  Unpaid:  { bg: '#fee2e2', color: '#991b1b' },
  Partial: { bg: '#fef9c3', color: '#92400e' },
}
const YN_YES = { bg: '#d1fae5', color: '#065f46' }
const YN_NO  = { bg: '#f3f4f6', color: '#6b7280' }

// ── Source buckets: ONE definition ───────────────────────────────────────────
//
// "Which bucket is this row in" was answered by two hand-copied ternaries —
// one in the Source column, one in the filter predicate — plus three more
// copies of the label list (desktop select, mobile select, active-chip tint).
// Five places, and adding a bucket meant finding all five.
//
// It had already gone wrong. `entry_source = 'bank_statement'` is set on every
// row booked from a bank statement, and no branch tested for it, so all 2,325
// of them fell through the residual and rendered as **Admin** — visually
// identical to a hand-keyed invoice, despite having no invoice document and no
// invoice number. That is the whole reason the ledger read as undifferentiated.
//
// Order is priority order: entry_source is explicit (the row was born on a
// specific page) and outranks vendor_submitted; 'admin' is the residual.
// bank_statement sits above vendor because a statement-born row is never
// vendor-submitted — stated rather than assumed, so the branch is safe if that
// ever stops being true.
//
// `tint` is the toolbar select's border/text when that bucket is filtered to;
// `bg`/`color` are the badge. `bgDark`/`colorDark` are optional — Vendor
// deliberately has none and keeps its light chip in both themes, which is how
// it has always rendered.
const SOURCE_BUCKETS = [
  {
    key: 'recoupments', label: 'Recoupment',
    title: 'Added from the Recoupments page',
    bg: '#f3e8ff', color: '#6b21a8', bgDark: '#3b1d5c', colorDark: '#e9d5ff',
    tint: { borderColor: '#a855f7', color: '#6b21a8' },
  },
  {
    key: 'artist_campaigns', label: 'Campaign',
    title: 'Added from the Artist Campaigns page',
    bg: '#e0e7ff', color: '#3730a3', bgDark: '#1e3a5f', colorDark: '#c7d2fe',
    tint: { borderColor: '#6366f1', color: '#3730a3' },
  },
  {
    key: 'bank_statement', label: 'Bank',
    title: 'Booked from a bank statement — direct spend, no invoice document behind it',
    bg: '#d1fae5', color: '#065f46', bgDark: '#0d3b2e', colorDark: '#a7f3d0',
    tint: { borderColor: '#10b981', color: '#047857' },
  },
  {
    key: 'vendor', label: 'Vendor',
    title: 'Submitted through the public vendor form',
    bg: '#dbeafe', color: '#1e40af',
    tint: { borderColor: '#3b82f6', color: '#1e40af' },
  },
  {
    key: 'admin', label: 'Admin',
    title: 'Entered directly by staff (Add Invoice, Bulk Upload, etc.)',
    // Neutral is the one bucket that reads from the theme tokens rather than a
    // fixed pair, so it recedes against whatever the row stripe is.
    neutral: true,
    tint: { borderColor: '#9ca3af', color: '#4b5563' },
  },
]

// The residual is last in SOURCE_BUCKETS, so this cannot fall off the end.
function sourceBucketKey(e) {
  if (e.entry_source === 'recoupments')      return 'recoupments'
  if (e.entry_source === 'artist_campaigns') return 'artist_campaigns'
  if (e.entry_source === 'bank_statement')   return 'bank_statement'
  if (e.vendor_submitted)                    return 'vendor'
  return 'admin'
}

function sourceBucket(key) {
  return SOURCE_BUCKETS.find(b => b.key === key) || SOURCE_BUCKETS[SOURCE_BUCKETS.length - 1]
}

// ── Invoices vs direct bank spend ────────────────────────────────────────────
//
// The one predicate behind the view switch. 'invoices' is its COMPLEMENT
// rather than its own whitelist, which is what guarantees the two views
// partition the ledger — a whitelist pair drifts and starts losing rows out
// of both sides, and a row missing from the ledger is the one bug here that
// nobody would notice.
//
// A statement-born row and an invoice row are both real spend and both live in
// `expenses`, which is why every report reads one table. They are not the same
// KIND of record though: these have no invoice document and no invoice number,
// so the A/P questions ("what do we owe, against what paper") don't apply.
//
// The predicate itself lives in utils.js — the Recoupments and Artist Campaigns
// surfaces exclude the same rows, and a second copy here is exactly the drift
// that left bank_statement out of the Source buckets above.
const isBankRow = isBankStatementRow

const LEDGER_VIEWS = [
  {
    key: 'all', label: 'All spend',
    title: 'Everything — invoices plus spend booked straight off a bank statement. This is the ledger total.',
  },
  {
    key: 'invoices', label: 'Invoices',
    title: 'Rows backed by an invoice document: vendor submissions, staff-entered invoices, recoupment and campaign spend.',
  },
  {
    key: 'bank', label: 'Bank items',
    title: 'Rows booked directly from a bank statement — no invoice behind them.',
  },
]

// Segmented control over LEDGER_VIEWS. Rendered on both the desktop toolbar
// and the mobile header, so it lives here rather than being inlined twice.
function LedgerViewSwitch({ value, onChange, counts, C, isDark }) {
  return (
    <div
      role="tablist"
      aria-label="Ledger view"
      style={{
        display: 'inline-flex', alignItems: 'center', flexShrink: 0,
        border: `1px solid ${C.border}`, borderRadius: 6,
        background: C.selectBg, overflow: 'hidden',
      }}
    >
      {LEDGER_VIEWS.map((v, i) => {
        const on = value === v.key
        return (
          <button
            key={v.key}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(v.key)}
            title={v.title}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '5px 10px', fontSize: 12, whiteSpace: 'nowrap',
              border: 'none', borderLeft: i === 0 ? 'none' : `1px solid ${C.border}`,
              cursor: 'pointer',
              background: on ? (isDark ? '#312e46' : '#eef2ff') : 'transparent',
              color: on ? (isDark ? '#c7d2fe' : '#3730a3') : (C.textMuted || '#777'),
              fontWeight: on ? 700 : 500,
            }}
          >
            {v.label}
            <span style={{ fontSize: 11, opacity: 0.7, fontVariantNumeric: 'tabular-nums' }}>
              {(counts[v.key] || 0).toLocaleString()}
            </span>
          </button>
        )
      })}
    </div>
  )
}

const badgeBase = {
  cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
  padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700,
  whiteSpace: 'nowrap', userSelect: 'none',
}

function PaidBadge({ status, onClick }) {
  const s = status || 'Unpaid'
  const style = PAID_BADGE[s] || PAID_BADGE.Unpaid
  return (
    <span onClick={onClick} title="Click to cycle" style={{ ...badgeBase, background: style.bg, color: style.color }}>
      {s}
    </span>
  )
}

const YN_BLUE_YES = { bg: '#dbeafe', color: '#1e40af' }

function YNBadge({ value, trueValue = 'Yes', onClick, yesStyle }) {
  const isYes = value === trueValue || (trueValue === true && value === true)
  const style = isYes ? (yesStyle || YN_YES) : YN_NO
  return (
    <span onClick={onClick} title="Click to toggle" style={{ ...badgeBase, background: style.bg, color: style.color }}>
      {isYes ? 'Yes' : 'No'}
    </span>
  )
}

// `isShared` means the file appears here only because a sibling expense for
// the same vendor has it on record (currently used by the W9 column). In that
// case the cell still shows "View" but the Replace/Remove buttons don't apply
// to this row, so we surface an explicit "Upload" action instead so the user
// can add a W9 directly to this entry without hunting for the ↻ icon.
function FileCell({ hasFile, href, entryId, fileType, onUploaded, onPreview, onDeleted, isShared }) {
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const inputRef = useRef(null)

  const handleUpload = async (file) => {
    if (!file) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const api = (await import('../api')).default
      await api.post(`/bk/entries/${entryId}/file/${fileType}`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      if (onUploaded) onUploaded(entryId, fileType)
    } catch {} finally { setUploading(false) }
  }

  const handleDelete = async () => {
    if (!window.confirm(`Remove this ${fileType} file?`)) return
    setDeleting(true)
    try {
      const api = (await import('../api')).default
      await api.delete(`/bk/entries/${entryId}/file/${fileType}`)
      if (onDeleted) onDeleted(entryId, fileType)
    } catch {} finally { setDeleting(false) }
  }

  const token = localStorage.getItem('token')
  const authHref = href ? `${href}${href.includes('?') ? '&' : '?'}token=${token}` : '#'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'center' }} onClick={e => e.stopPropagation()}>
      {uploading || deleting ? (
        <span style={{ fontSize: 11, color: '#999' }}>...</span>
      ) : hasFile ? (
        <>
          <button
            onClick={() => onPreview ? onPreview(authHref, `${fileType}-${entryId}`) : window.open(authHref, '_blank')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#15803d', fontWeight: 700, fontSize: 12, fontFamily: 'inherit' }}>
            View
          </button>
          {isShared ? (
            // W9 is on a sibling expense — surface an explicit Upload action
            // so the user can add a W9 directly to this row.
            <button
              onClick={() => inputRef.current?.click()}
              title="Upload a new W9 directly to this row"
              style={{ background: 'none', border: '1px solid #b45309', color: '#b45309', borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Upload
            </button>
          ) : (
            <>
              <button
                onClick={() => inputRef.current?.click()}
                title="Replace file"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: 10, padding: 0 }}
                onMouseEnter={e => e.currentTarget.style.color = '#6366f1'}
                onMouseLeave={e => e.currentTarget.style.color = '#999'}
              >
                ↻
              </button>
              <button
                onClick={handleDelete}
                title="Remove file"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: 10, padding: 0 }}
                onMouseEnter={e => e.currentTarget.style.color = '#334155'}
                onMouseLeave={e => e.currentTarget.style.color = '#999'}
              >
                ✕
              </button>
            </>
          )}
        </>
      ) : (
        <button
          onClick={() => inputRef.current?.click()}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#b45309', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}
        >
          Upload
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png"
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = '' }}
      />
    </div>
  )
}

// Editable socials cell. The summary text is a button; clicking opens a small
// editor (platform + handle rows) in a portal so the popover isn't clipped by
// the horizontally-scrolling table container. Saves the [{platform,handle}]
// array via onSave (→ PUT /entries/:id { social_handles }) on Done / click-away,
// but only when the value actually changed so we don't spam saves/undo entries.
function SocialsCell({ entry, onSave, C, familyArtists: familyArtistsList = [] }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState([])
  const [rect, setRect] = useState(null)
  const [saving, setSaving] = useState(false)
  const btnRef = useRef(null)

  const handles = Array.isArray(entry.social_handles) ? entry.social_handles : []
  const summary = handles
    .map(s => `${s.platform ? s.platform + ' ' : ''}${s.handle || ''}${s.artist ? ` · ${s.artist}` : ''}`)
    .join(', ')
  // Show the artist dropdown only when the invoice has more than one
  // artist in its split family — otherwise there's nothing to
  // disambiguate and the extra selector reads as clutter.
  const hasSplit = familyArtistsList.length > 1

  const openEditor = (e) => {
    e.stopPropagation()
    setRows(handles.length
      ? handles.map(s => ({ platform: s?.platform || 'Instagram', handle: s?.handle || '', artist: s?.artist || '', amount: s?.amount ?? '' }))
      : [{ platform: 'Instagram', handle: '', artist: '', amount: '' }])
    if (btnRef.current) setRect(btnRef.current.getBoundingClientRect())
    setOpen(true)
  }

  const saveAndClose = async () => {
    const cleaned = rows
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
    // Normalize the pre-edit list the same way so the "nothing changed"
    // check treats missing / empty artist tags identically.
    const normOld = handles
      .map(s => {
        const platform = (s.platform || '').trim()
        const handle = (s.handle || '').trim()
        const artist = (s.artist || '').trim()
        if (!handle) return null
        const row = { platform, handle }
        if (artist) row.artist = artist
        const amountNum = parseFloat(s.amount)
        if (Number.isFinite(amountNum) && amountNum > 0) row.amount = amountNum
        return row
      })
      .filter(Boolean)
    if (JSON.stringify(cleaned) !== JSON.stringify(normOld)) {
      setSaving(true)
      try { await onSave(entry.id, cleaned) } finally { setSaving(false) }
    }
    setOpen(false)
  }

  const selSty = { background: C.selectBg, border: `1.5px solid ${C.border}`, borderRadius: 6, padding: '5px 6px', color: C.text, fontSize: 12, fontFamily: 'inherit', flex: '0 0 116px', outline: 'none', cursor: 'pointer' }
  const inpSty = { background: C.selectBg, border: `1.5px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', color: C.text, fontSize: 12, fontFamily: 'inherit', flex: 1, minWidth: 0, outline: 'none' }

  return (
    <>
      <button
        ref={btnRef}
        onClick={openEditor}
        title={summary || 'Add socials'}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
          fontSize: 12, color: summary ? '#777' : '#bbb', padding: 0, textAlign: 'left',
          maxWidth: 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          display: 'inline-block',
        }}
      >
        {summary || '+ add'}
      </button>
      {open && rect && createPortal(
        <>
          <div onClick={saveAndClose} style={{ position: 'fixed', inset: 0, zIndex: 1000 }} />
          <div
            onClick={e => e.stopPropagation()}
            style={{
              position: 'fixed',
              top: Math.min(rect.bottom + 4, window.innerHeight - 280),
              left: Math.min(rect.left, window.innerWidth - 320),
              width: 300, zIndex: 1001,
              background: C.cardBg, border: `1.5px solid ${C.border}`, borderRadius: 10,
              boxShadow: '0 10px 36px rgba(0,0,0,.18)', padding: 12,
            }}
          >
            <div style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>Socials</div>
            {rows.length === 0 && <div style={{ fontSize: 12, color: C.textFaint, marginBottom: 8 }}>No socials yet.</div>}
            {rows.map((row, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <select
                    value={row.platform || 'Instagram'}
                    onChange={e => setRows(rs => rs.map((r, idx) => idx === i ? { ...r, platform: e.target.value } : r))}
                    style={selSty}
                  >
                    {SOCIAL_PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <input
                    type="text"
                    value={row.handle || ''}
                    onChange={e => setRows(rs => rs.map((r, idx) => idx === i ? { ...r, handle: e.target.value } : r))}
                    placeholder="@handle or url"
                    style={inpSty}
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={row.amount || ''}
                    onChange={e => setRows(rs => rs.map((r, idx) => idx === i ? { ...r, amount: e.target.value } : r))}
                    placeholder="$"
                    title="Amount paid to this creator (optional)"
                    style={{ ...inpSty, flex: '0 0 72px', width: 72 }}
                  />
                  <button
                    onClick={() => setRows(rs => rs.filter((_, idx) => idx !== i))}
                    title="Remove"
                    style={{ background: 'none', border: 'none', color: C.textMuted, cursor: 'pointer', padding: 2, display: 'inline-flex' }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                {/* Per-row artist tag — only surfaces on split invoices
                    where different handles belong to different artists.
                    Empty means "shared / all artists" (renders on every
                    child row); tagged means "only this artist's row(s)". */}
                {hasSplit && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingLeft: 4 }}>
                    <span style={{ fontSize: 10, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700, minWidth: 62 }}>For artist</span>
                    <select
                      value={row.artist || ''}
                      onChange={e => setRows(rs => rs.map((r, idx) => idx === i ? { ...r, artist: e.target.value } : r))}
                      style={{ ...selSty, flex: 1, minWidth: 0 }}
                    >
                      <option value="">All artists (untagged)</option>
                      {familyArtistsList.map(a => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </div>
                )}
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
              <button
                disabled={false}
                onClick={() => setRows(rs => [...rs, { platform: 'Instagram', handle: '', artist: '', amount: '' }])}
                style={{ background: 'none', border: `1px dashed ${C.border}`, color: C.text, borderRadius: 6, padding: '5px 9px', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', opacity: 1, display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <Plus size={12} /> Add
              </button>
              <button
                onClick={saveAndClose}
                disabled={saving}
                style={{ background: RED, border: 'none', color: '#fff', borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' }}
              >
                {saving ? 'Saving…' : 'Done'}
              </button>
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  )
}

// Receipt cell for reimbursement rows. Shows the existing receipt count (click
// to preview) and always exposes an upload action so users can add/reupload a
// receipt even when one is already on file. New uploads go to the multi-file
// entity_files path (POST /entries/:id/receipts); the legacy single receipt_data
// file still counts toward the total and previews alongside the new ones.
function ReceiptCell({ entry, apiBase, onView, onViewMulti, onUploaded, onRemoved, C }) {
  const [busy, setBusy] = useState(false)
  const [manage, setManage] = useState(null) // { rect, files } | null while picking which to remove
  const inputRef = useRef(null)
  const count = (entry.receipt_count || 0) + (entry.has_receipt ? 1 : 0)

  // Receipts come from two stores: the legacy single receipt_data blob on the
  // expense row, and zero+ entity_files rows. Build a unified list so view and
  // remove treat both the same way.
  const loadFiles = async () => {
    const token = localStorage.getItem('token')
    const files = []
    if (entry.has_receipt) {
      files.push({ kind: 'legacy', id: null, label: entry.receipt_filename || `Receipt-${entry.payee}`, url: `${apiBase}/bk/entries/${entry.id}/file/receipt?token=${token}` })
    }
    if (entry.receipt_count > 0) {
      try {
        const res = await api.get(`/bk/entries/${entry.id}/receipts`)
        for (const f of (res.data.data || [])) {
          files.push({ kind: 'entity', id: f.id, label: f.original_name, url: `${apiBase}/bk/entries/${entry.id}/receipts/${f.id}?token=${token}` })
        }
      } catch {}
    }
    return files
  }

  const handleView = async () => {
    const files = await loadFiles()
    if (files.length === 1) onView(files[0].url, files[0].label)
    else if (files.length > 1) onViewMulti(files.map(f => ({ url: f.url, filename: f.label })))
  }

  const handleUpload = async (file) => {
    if (!file) return
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      await api.post(`/bk/entries/${entry.id}/receipts`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      if (onUploaded) onUploaded(entry.id)
    } catch {} finally { setBusy(false) }
  }

  const deleteOne = async (f) => {
    setBusy(true)
    try {
      if (f.kind === 'legacy') await api.delete(`/bk/entries/${entry.id}/file/receipt`)
      else await api.delete(`/bk/entries/${entry.id}/receipts/${f.id}`)
      if (onRemoved) onRemoved(entry.id, f.kind)
    } catch {} finally { setBusy(false) }
  }

  const handleRemove = async (e) => {
    const rect = e.currentTarget.getBoundingClientRect() // capture before await — synthetic event is reused
    const files = await loadFiles()
    if (files.length === 0) return
    if (files.length === 1) {
      if (window.confirm('Remove this receipt?')) await deleteOne(files[0])
      return
    }
    setManage({ rect, files }) // ambiguous which one — let the user pick
  }

  const removeFromManage = async (f) => {
    await deleteOne(f)
    setManage(m => {
      if (!m) return null
      const remaining = m.files.filter(x => x !== f)
      return remaining.length ? { ...m, files: remaining } : null
    })
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'center' }} onClick={e => e.stopPropagation()}>
      {busy ? (
        <span style={{ fontSize: 11, color: '#999' }}>...</span>
      ) : count > 0 ? (
        <>
          <button onClick={handleView} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#15803d', fontWeight: 700, fontSize: 12, fontFamily: 'inherit' }}>
            {count} file{count !== 1 ? 's' : ''}
          </button>
          <button
            onClick={() => inputRef.current?.click()}
            title="Add another receipt"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: 10, padding: 0 }}
            onMouseEnter={e => e.currentTarget.style.color = '#6366f1'}
            onMouseLeave={e => e.currentTarget.style.color = '#999'}
          >
            ↻
          </button>
          <button
            onClick={handleRemove}
            title={count > 1 ? 'Remove a receipt' : 'Remove receipt'}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: 10, padding: 0 }}
            onMouseEnter={e => e.currentTarget.style.color = '#334155'}
            onMouseLeave={e => e.currentTarget.style.color = '#999'}
          >
            ✕
          </button>
        </>
      ) : (
        <button
          onClick={() => inputRef.current?.click()}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#b45309', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}
        >
          Upload
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png"
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = '' }}
      />
      {manage && createPortal(
        <>
          <div onClick={() => setManage(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000 }} />
          <div
            onClick={e => e.stopPropagation()}
            style={{
              position: 'fixed',
              top: Math.min(manage.rect.bottom + 4, window.innerHeight - 240),
              left: Math.max(8, Math.min(manage.rect.left - 200, window.innerWidth - 300)),
              width: 280, zIndex: 1001,
              background: C.cardBg, border: `1.5px solid ${C.border}`, borderRadius: 10,
              boxShadow: '0 10px 36px rgba(0,0,0,.18)', padding: 12,
            }}
          >
            <div style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>Remove a receipt</div>
            {manage.files.map((f, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                <a href={f.url} target="_blank" rel="noreferrer" style={{ flex: 1, minWidth: 0, fontSize: 12, color: C.text, textDecoration: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={f.label}>
                  {f.label}
                </a>
                <button
                  onClick={() => removeFromManage(f)}
                  title="Remove this receipt"
                  style={{ background: 'none', border: 'none', color: '#334155', cursor: 'pointer', padding: 2, display: 'inline-flex', flexShrink: 0 }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </>,
        document.body
      )}
    </div>
  )
}

// ── Duplicate-invoice flag banner ─────────────────────────────────────────────
// Surfaces the same `duplicate_invoices` category the /duplicates page uses,
// rendered as a thin amber banner above the ledger so the operator catches
// dupes during normal review instead of only when they remember to visit
// the dedicated page. Hidden when there are no live (non-dismissed) groups.
function DuplicateInvoicesFlag({ C }) {
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.get('/flags').then(res => {
      if (cancelled) return
      const cats = res.data?.data?.categories || []
      const dup = cats.find(c => c.kind === 'duplicate_invoices')
      // Server already filters dismissed groups by default; the redundant
      // filter here protects against future behavior changes.
      setGroups((dup?.groups || []).filter(g => !g.dismissed))
    }).catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  if (loading || groups.length === 0) return null

  const fmtMoney = (amount, currency) => {
    const n = Number(amount)
    if (!Number.isFinite(n)) return '—'
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: (currency || 'USD').toUpperCase() }).format(n)
    } catch {
      return `${(currency || 'USD').toUpperCase()} ${n.toFixed(2)}`
    }
  }

  return (
    <div style={{
      background: '#fffbeb',
      borderBottom: '1px solid #fde68a',
      padding: '8px 16px',
      fontSize: 13,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <AlertTriangle size={14} style={{ color: '#b45309', flexShrink: 0 }} />
        <span style={{ fontWeight: 700, color: '#92400e' }}>
          {groups.length} potential duplicate invoice {groups.length === 1 ? 'group' : 'groups'}
        </span>
        <span style={{ color: '#92400e', opacity: 0.8 }}>
          — review and delete the wrong copy, or dismiss the group if it's legit.
        </span>
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          style={{
            marginLeft: 'auto',
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: 'transparent', color: '#92400e',
            border: '1px solid #fcd34d', borderRadius: 6,
            padding: '3px 8px', fontSize: 11, fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          {expanded ? <><ChevronUp size={11} /> Collapse</> : <><ChevronDown size={11} /> Show details</>}
        </button>
        <Link
          to="/duplicates"
          style={{
            color: '#92400e', fontSize: 11, fontWeight: 700,
            textDecoration: 'underline', textDecorationStyle: 'dotted',
          }}
        >
          Manage on Duplicates page →
        </Link>
      </div>
      {expanded && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {groups.map((g, idx) => (
            <div key={g.group_key || idx} style={{
              background: '#fff', border: '1px solid #fde68a', borderRadius: 6, padding: '8px 10px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                <Copy size={11} style={{ color: '#dc2626' }} />
                {(g.reasons || []).map((r, i) => (
                  <span key={i} style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 6px',
                    borderRadius: 999, background: '#fee2e2', color: '#991b1b',
                  }}>{r}</span>
                ))}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {(g.entries || []).map(e => (
                  <div key={e.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                    fontSize: 12, color: C.text,
                  }}>
                    <span style={{ fontFamily: 'ui-monospace, monospace', color: '#6b7280' }}>#{e.id}</span>
                    <span style={{ fontWeight: 700 }}>{e.payee || '—'}</span>
                    {e.invoice_number && (
                      <span style={{
                        fontFamily: 'ui-monospace, monospace', fontSize: 11,
                        background: '#f3f4f6', padding: '1px 5px', borderRadius: 4, color: '#374151',
                      }}>#{e.invoice_number}</span>
                    )}
                    <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtMoney(e.amount, e.currency)}</span>
                    {e.invoice_date && (
                      <span style={{ color: '#9ca3af', fontSize: 11 }}>{String(e.invoice_date).slice(0, 10)}</span>
                    )}
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
                      ...(String(e.payment_status || '').toLowerCase() === 'paid'
                        ? { background: '#d1fae5', color: '#065f46' }
                        : { background: '#fef3c7', color: '#92400e' }),
                    }}>
                      {String(e.payment_status || 'Unpaid')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
// ── A bank line with no editable row on this page ────────────────────────────
//
// One of four things, and it says which: matched to a real invoice (the expense is
// on the invoiced ledger), booked as income, dismissed, or still open. Plus the
// whole credit side, which the expenses table cannot hold at all.
//
// Deliberately NOT a ledger row. No inline editors, no bulk checkbox: there is no
// expense id behind it, so an editor would `PUT /bk/entries/undefined` on blur and
// a checkbox would hand the bulk endpoint an id it cannot use. Every cell here is
// read-only except the buttons, and the buttons act on the TRANSACTION.
const DISPO_CHIP = {
  matched:   { label: 'invoice',    bg: 'rgba(99,102,241,.12)',  fg: '#4338ca' },
  income:    { label: 'income',     bg: 'rgba(16,185,129,.12)',  fg: '#047857' },
  dismissed: { label: 'dismissed',  bg: 'rgba(107,114,128,.14)', fg: '#4b5563' },
  open:      { label: 'open',       bg: 'rgba(245,158,11,.14)',  fg: '#b45309' },
  booked:    { label: 'booked',     bg: 'rgba(107,114,128,.14)', fg: '#4b5563' },
}
function ExtraTxRow({ t, disposition, C, RED, FW, fCell, TD, busy, canAct,
  onDismiss, onUndismiss, onBookIncome, onUnbookIncome, onMatch }) {
  const isCredit = t.direction === 'credit'
  const chip = DISPO_CHIP[disposition] || DISPO_CHIP.open
  const usd = Math.abs(Number(t.usd ?? t.amount_usd ?? t.amount ?? 0))
  const money = usd.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  const btn = {
    padding: '3px 7px', borderRadius: 6, fontSize: 11, fontWeight: 700,
    fontFamily: 'inherit', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1,
    background: 'transparent', color: C.textMuted, border: `1px solid ${C.border}`,
  }
  return (
    <tr style={{ background: C.cardBg, opacity: disposition === 'dismissed' ? 0.7 : 1 }}>
      {/* The frozen cell, same single-<td> layout as a ledger row so the columns
          line up. The checkbox slot is deliberately EMPTY, not a disabled input:
          a control that cannot do anything is worse than no control. */}
      <td style={{
        padding: 0, position: 'sticky', left: 0, zIndex: 1, background: C.cardBg,
        borderBottom: `1px solid ${C.tdBorder}`, boxShadow: C.shadow,
        borderLeft: `3px solid ${isCredit ? '#10b981' : 'transparent'}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', minHeight: 40 }}>
          <div style={{ ...fCell, width: FW.pick }} aria-hidden="true" />
          <div style={{ ...fCell, width: FW.flag, justifyContent: 'center' }}>
            <span title={isCredit ? 'Money in' : 'Money out'}
              style={{ fontSize: 12, color: isCredit ? '#059669' : C.textFaint }}>
              {isCredit ? '↓' : '↑'}
            </span>
          </div>
          <div style={{ ...fCell, width: FW.date, fontSize: 11, color: C.textFaint }}>
            {String(t.txn_date || '').slice(0, 10)}
          </div>
          {/* Payee, with the same vendor link the full rows above carry — this
              is the one column where a reduced row and a ledger row say the
              same kind of thing, so the affordance is the same too.

              The DESCRIPTION is never linked. It is a fallback for display
              only; a sentence makes a nonsense vendor page. And this is the
              surface where bank descriptors are most common, so the
              channel-only suppression matters most here: PAYPAL, ACH and WIRE
              name a rail, not a counterparty. */}
          <div style={{ ...fCell, width: FW.payee, fontSize: 12, fontWeight: 600, color: C.text, gap: 4 }}
            title={t.description || ''}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.payee_guess || t.description || '—'}
            </span>
            {(() => {
              const name = txVendorLinkName(t)
              if (!name) return null
              return (
                <PayeeLink payee={name}
                  style={{ flexShrink: 0, color: '#6366f1', display: 'inline-flex', alignItems: 'center', padding: '2px', borderRadius: 3, opacity: 0.65, transition: 'opacity 120ms' }}
                  onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                  onMouseLeave={e => e.currentTarget.style.opacity = '0.65'}
                >
                  <ExternalLink size={11} />
                </PayeeLink>
              )
            })()}
          </div>
          <div style={{ ...fCell, width: FW.artist, fontSize: 11, color: C.textFaint }}>
            {t.income?.artist_name || ''}
          </div>
          <div style={{ ...fCell, width: FW.amount, justifyContent: 'flex-end', fontSize: 12, fontWeight: 700,
            color: isCredit ? '#047857' : C.text }}>
            {isCredit ? '+' : '−'}{money.replace('$', '$')}
          </div>
        </div>
      </td>

      {/* Everything else in ONE cell. The reduced row has nothing to say in 28
          ledger columns, and spreading five facts across them would read as a row
          whose data failed to load. */}
      <td colSpan={40} style={{ ...TD }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
            background: chip.bg, color: chip.fg, textTransform: 'uppercase', letterSpacing: '.04em',
          }}>
            {chip.label}
          </span>

          {disposition === 'matched' && (
            <span style={{ fontSize: 11.5, color: C.textMuted }}>
              settled by an invoice ·{' '}
              <a href={`/bk/ledger?focus=${t.matched_expense_id}`} target="_blank" rel="noopener noreferrer"
                style={{ color: RED, fontWeight: 700, textDecoration: 'none' }}>
                open it on the ledger →
              </a>
            </span>
          )}
          {disposition === 'income' && (
            <span style={{ fontSize: 11.5, color: C.textMuted }}>
              {t.income?.income_type || 'income'}
              {t.income?.artist_name ? ` · ${t.income.artist_name}` : ''}
            </span>
          )}
          {disposition === 'dismissed' && (
            <span style={{ fontSize: 11.5, color: C.textFaint }}>
              {t.dismissed_reason || 'no entry needed'}
            </span>
          )}
          {disposition === 'open' && (
            <span style={{ fontSize: 11.5, color: '#b45309' }}>
              nothing decided yet
            </span>
          )}
          {/* Two rows for one amount is normally a duplicate. A reversal is the
              case where it is correct, so it is labelled rather than left to look
              like an error. */}
          {t.looks_like_reversal && (
            <span style={{ fontSize: 10.5, fontWeight: 700, color: '#4338ca' }}
              title="This looks like a reversal of another line — a refund or a returned payment. Two rows for one amount is right here.">
              reversal
            </span>
          )}
          {t.reference && (
            <span style={{ fontSize: 10.5, color: C.textFaint }}>ref {t.reference}</span>
          )}

          {canAct && (
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
              {disposition === 'open' && !isCredit && (
                <>
                  <button type="button" style={btn} disabled={busy} onClick={onMatch}
                    title="Find the invoice this payment settles">Match an invoice</button>
                  <button type="button" style={btn} disabled={busy} onClick={onDismiss}
                    title="No ledger entry is needed for this line">Dismiss</button>
                </>
              )}
              {disposition === 'open' && isCredit && (
                <>
                  <button type="button" style={btn} disabled={busy} onClick={onBookIncome}
                    title="Record this credit as income">Book as income</button>
                  <button type="button" style={btn} disabled={busy} onClick={onDismiss}
                    title="An internal transfer or something else that is not income">Dismiss</button>
                </>
              )}
              {disposition === 'dismissed' && (
                <button type="button" style={btn} disabled={busy} onClick={onUndismiss}
                  title="Put this line back — it needs an answer after all">Undismiss</button>
              )}
              {disposition === 'income' && (
                <button type="button" style={btn} disabled={busy} onClick={onUnbookIncome}
                  title="Remove the income record and reopen this line">Unbook income</button>
              )}
            </span>
          )}
        </div>
      </td>
    </tr>
  )
}

// ── Answer a vendor, once, and have it remembered ────────────────────────────
//
// The selection grouped by payee, because that is the unit the money comes in:
// measured on production, 252 vendors hold the 1,214 unattributed booked rows
// ($1,759,152.75) and the top TWELVE are 81.6% of it. Answering "SPOTIFY USA INC
// is label-level" once settles 168 rows.
//
// It writes through POST /statements/artist-rules, NOT the generic bulk endpoint,
// and the difference is the whole point of using it:
//
//   - it writes HISTORY BY EXPENSE ID and keeps the PATTERN only for the future.
//     A pattern is a substring test, and vendor names collide exactly where it
//     costs most — "TONE" ($615k) inside "Tone Pay, Inc", "Dean St" inside "Dean
//     Street Media". So the ids sent are the ones on screen, and the remembered
//     pattern only ever decides one NEW row at a time on a future statement.
//   - `is_overhead` is a real ANSWER, not a blank. It records "this vendor never
//     belongs to an artist", writes nothing to the rows, and stops the vendor
//     being asked about again.
function BulkVendorPanel({ rows, C, RED, busy, setBusy, roster, onDone, showToast }) {
  const [values, setValues] = useState({})   // vendorKey -> artist being typed
  const [done, setDone] = useState({})       // vendorKey -> what was answered

  // Group by payee. The key is lowercased so two spellings of one vendor are one
  // question; the label is the most-used spelling, which is the rule the rest of
  // the app follows when it has to pick a display name.
  const groups = useMemo(() => {
    const m = new Map()
    for (const r of rows) {
      const name = String(r.payee || '').trim()
      if (!name) continue
      const k = name.toLowerCase()
      if (!m.has(k)) m.set(k, { key: k, spellings: new Map(), rows: [] })
      const g = m.get(k)
      g.rows.push(r)
      g.spellings.set(name, (g.spellings.get(name) || 0) + 1)
    }
    return Array.from(m.values()).map(g => ({
      ...g,
      vendor: Array.from(g.spellings.entries()).sort((a, b) => b[1] - a[1])[0][0],
      total: g.rows.reduce((t, r) => t + (Number(r.amount) || 0), 0),
      // A vendor whose rows already agree on one artist is shown as such rather
      // than asked about again.
      existing: [...new Set(g.rows.map(r => (r.artist || '').trim()).filter(Boolean))],
    })).sort((a, b) => b.total - a.total)
  }, [rows])

  const answer = async (g, { overhead }) => {
    const artist = (values[g.key] || '').trim()
    if (!overhead && !artist) {
      showToast('Name the artist, or answer overhead', true)
      return
    }
    setBusy(true)
    try {
      const { data } = await api.post('/statements/artist-rules', {
        pattern: g.vendor,
        artist: overhead ? null : artist,
        is_overhead: !!overhead,
        // The ids actually on screen. Never the pattern — see the note above.
        entry_ids: g.rows.map(r => r.id),
      })
      const n = data?.data?.updated ?? g.rows.length
      setDone(d => ({ ...d, [g.key]: overhead ? 'overhead' : artist }))
      showToast(overhead
        ? `${g.vendor} recorded as overhead — it will not be asked about again`
        : `${g.vendor}: ${n} row${n === 1 ? '' : 's'} set to ${artist}, and remembered for future statements`)
    } catch (err) {
      showToast(err.response?.data?.error || err.message, true)
    } finally { setBusy(false) }
  }

  const answered = Object.keys(done).length
  return (
    <div style={{ marginTop: 9, paddingTop: 9, borderTop: `1px solid ${C.borderLight}` }}>
      <div style={{ fontSize: 11, color: C.textFaint, marginBottom: 7, lineHeight: 1.5 }}>
        One answer per vendor. It is written to the {rows.length.toLocaleString()} selected
        row{rows.length === 1 ? '' : 's'} <b>by id</b>, and the vendor name is remembered so the
        next statement books the same way — a name is only ever matched loosely on a
        future row, never used to sweep history.
      </div>
      <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {groups.map(g => {
          const settled = done[g.key]
          return (
            <div key={g.key} style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              padding: '6px 8px', borderRadius: 7,
              background: settled ? 'rgba(16,185,129,.10)' : C.elevBg,
              border: `1px solid ${settled ? 'rgba(16,185,129,.35)' : C.borderLight}`,
            }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: C.text, minWidth: 160, flex: '0 1 220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {g.vendor}
              </span>
              <span style={{ fontSize: 11, color: C.textFaint, fontVariantNumeric: 'tabular-nums' }}>
                {g.rows.length} row{g.rows.length === 1 ? '' : 's'} ·{' '}
                {g.total.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
              </span>
              {g.existing.length > 0 && (
                <span style={{ fontSize: 10.5, color: C.textFaint }}
                  title="Some of these rows already name an artist. Answering overwrites nothing that disagrees — it sets the ones that are blank.">
                  already: {g.existing.join(', ')}
                </span>
              )}
              {settled ? (
                <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, color: '#047857' }}>
                  {settled === 'overhead' ? 'overhead' : settled} ✓
                </span>
              ) : (
                <>
                  <input
                    list="bulk-artists"
                    value={values[g.key] || ''}
                    onChange={e => setValues(v => ({ ...v, [g.key]: e.target.value }))}
                    placeholder="Artist"
                    style={{ marginLeft: 'auto', width: 160, padding: '5px 7px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', background: C.inputBg, color: C.text, border: `1.5px solid ${C.border}` }}
                  />
                  <button type="button" disabled={busy} onClick={() => answer(g, { overhead: false })}
                    style={{ padding: '5px 9px', borderRadius: 6, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', background: RED, color: '#fff', border: `1.5px solid ${RED}`, opacity: busy ? 0.5 : 1 }}>
                    Set
                  </button>
                  <button type="button" disabled={busy} onClick={() => answer(g, { overhead: true })}
                    title="This vendor is overhead — it never belongs to an artist. Recorded as an answer, so it stops being asked."
                    style={{ padding: '5px 9px', borderRadius: 6, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', background: 'transparent', color: C.textMuted, border: `1.5px solid ${C.border}`, opacity: busy ? 0.5 : 1 }}>
                    Overhead
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <a href="/bk/statements" target="_blank" rel="noopener noreferrer"
          style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textDecoration: 'none' }}>
          Every unanswered vendor, not just the selection →
        </a>
        {answered > 0 && (
          <button type="button" onClick={onDone}
            style={{ marginLeft: 'auto', padding: '5px 10px', borderRadius: 6, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', background: 'transparent', color: C.text, border: `1.5px solid ${C.border}` }}>
            Done — {answered} vendor{answered === 1 ? '' : 's'} answered
          </button>
        )}
      </div>
    </div>
  )
}

export default function BkLedger({ bank = false }) {
  // Live expense categories. Bound to the same name the module-level
  // import used, so every CATEGORIES reference in this component now
  // reads the vocabulary from context (which falls back to that same
  // constant if the fetch fails). Categories are user-created on the
  // Statements and Reports pages — a hardcoded list here would leave
  // this dropdown unable to render its own rows' values.
  const CATEGORIES = useCategories()
  // Live income vocabulary, for booking a bank credit. Same rule as the expense
  // categories: the table is the source, the constant is only the offline fallback.
  const INCOME_TYPES = useIncomeCategories()
  const { user: currentUser } = useAuth()
  const BOOM_REPS = useBoomReps()
  const REP_OPTIONS = ['', ...BOOM_REPS]
  // Approver is bookkeeping-admin equivalent — gets the same ledger tools.
  const isAdmin = ['Admin', 'Superadmin', 'Approver'].includes(currentUser?.role)
  const apiBase = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) || '/api'
  const { theme } = useTheme()
  const { rates: fxRates } = useFxRates()
  const isDark = theme === 'dark'

  // Dark-aware color palette. Base tokens come from the shared design system
  // (utils/darkColors.js → same CSS variables as the Tailwind aliases), with
  // ledger-specific overrides layered on top: parent/child row tints, the
  // transparent-input chrome, the focused-input background, a lighter
  // select background than the card's, and the table-sticky shadow which is
  // a horizontal edge shadow (2px 0) rather than the default card shadow.
  const C = {
    ...getDarkColors(theme),
    rowChild:   isDark ? '#1a1d28' : '#f5f5ff',
    rowParent:  isDark ? '#1c1f2a' : '#fafaff',
    inputBg:    'transparent',
    inputFocus: isDark ? '#1f222c' : '#fffbfa',
    selectBg:   isDark ? '#1f222c' : '#fafafa',
    shadow:     isDark ? '2px 0 4px rgba(0,0,0,.3)' : '2px 0 4px rgba(0,0,0,.08)',
  }

  // ── Data ────────────────────────────────────────────────────────────────────
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [toast, setToast]     = useState(null) // { msg, isError }
  const toastTimerRef = useRef(null)
  // Roster snapshot — drives the Artist-column hyperlink. Loaded once on mount.
  const [roster, setRoster]   = useState([])

  // ── UI state ────────────────────────────────────────────────────────────────
  const [sortDir,        setSortDir]        = useState('desc')
  const [sortField,      setSortField]      = useState('invoice_date')
  const [hiddenCols,     setHiddenCols]     = useState(() => loadHiddenCols(bank))
  const [colPanelOpen,   setColPanelOpen]   = useState(false)
  const [expandedNotes,  setExpandedNotes]  = useState(new Set())
  const [expandedGroups, setExpandedGroups] = useState(new Set())
  // Mobile card view (<768px). Sheet keys off the id and re-derives the
  // entry each render so a window-focus refetch can't strand stale data
  // in the open drawer.
  const isMobileView = useIsMobile()
  const [sheetEntryId, setSheetEntryId] = useState(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [mobileVisibleCount, setMobileVisibleCount] = useState(100)
  const [mobileNotesSaving, setMobileNotesSaving] = useState(false)
  // Entry id currently in the focus spotlight — set from a ?focus=<id>
  // query param (used by the "Open existing entry" duplicate warning
  // on Add Invoice, plus anywhere else that wants to deep-link a row).
  // Once the entries load and the row is found we scroll it into view,
  // expand its split parent if the row is a child, and highlight it
  // amber for a moment before clearing focus + the URL param.
  const [focusId, setFocusId] = useState(null)
  // A ?focus= id that exists in neither half — surfaced rather than swallowed.
  const [focusMissing, setFocusMissing] = useState(null)
  const location = useLocation()
  const navigate = useNavigate()
  // Rows currently staged in the recoupment plan (localStorage, same
  // browser) get a link into the Planning drill-down. Rehydrated on
  // window focus since the Recoupments tab can stage more items.
  const [planIds, setPlanIds] = useState(() => new Set(Object.keys(loadPlan()).map(Number)))
  useEffect(() => {
    const rehydrate = () => setPlanIds(new Set(Object.keys(loadPlan()).map(Number)))
    window.addEventListener('focus', rehydrate)
    return () => window.removeEventListener('focus', rehydrate)
  }, [])
  // ID of the leaf-row amount cell currently being edited. The cell
  // renders as a formatted span ($28,000.00) by default and only swaps
  // to a raw <input type="number"> while editing — so the ledger reads
  // uniformly without losing inline-editable behaviour.
  const [editingAmountId, setEditingAmountId] = useState(null)
  const [pendingDelete,  setPendingDelete]  = useState(null)
  const [splitEntry,     setSplitEntry]     = useState(null) // entry being split
  // splitRows / splitting moved into SplitInvoiceModal with the dialog — the
  // rows are its state, not the page's.
  // Fee-vs-reimbursement carve-out modal
  const [feeReimbEntry,  setFeeReimbEntry]  = useState(null)
  const [feeAmount,      setFeeAmount]      = useState('')
  const [reimbAmount,    setReimbAmount]    = useState('')
  const [feeReimbReceipt, setFeeReimbReceipt] = useState(null)
  const [feeReimbBusy,   setFeeReimbBusy]   = useState(false)

  // File preview
  const [previewFile, setPreviewFile] = useState(null) // { url, filename } | { files: [...] }
  const openPreview = (url, filename) => setPreviewFile({ url, filename })
  const openPreviewMulti = (files) => setPreviewFile({ files })

  // ── Undo history ──────────────────────────────────────────────────────────
  const [undoStack, setUndoStack] = useState([]) // [{ id, field, oldValue, newValue, payee }]

  // ── Filters (client-side) ─────────────────────────────────────────────────
  const [search,       setSearch]       = useState('')
  const [amountQuery,  setAmountQuery]  = useState('')
  const [filterQB,     setFilterQB]     = useState('')
  const [filterRecoup,   setFilterRecoup]   = useState('')
  const [filterCat,    setFilterCat]    = useState('')
  const [filterArtist, setFilterArtist] = useState('')
  const [filterPaid,   setFilterPaid]   = useState('')
  const [filterMethod, setFilterMethod] = useState('')
  // '' = all, 'Yes' = flagged only, 'No' = unflagged only. Same shape as
  // filterRecoup so the surrounding <select> UI matches.
  const [filterFlag,   setFilterFlag]   = useState('')
  const [filterBulk,   setFilterBulk]   = useState('')
  // Filter by row origin — one of SOURCE_BUCKETS' keys, or '' for all.
  // Shares sourceBucketKey() with the Source column so the two cannot
  // disagree about which badge a row carries.
  const [filterSource, setFilterSource] = useState('')

  // ── Selection, for the bulk bar ───────────────────────────────────────────
  //
  // The ledger had inline editing and nothing else. That is fine on the invoiced
  // half, where 1,414 of 1,478 rows arrive already carrying an artist; on the
  // bank half it is the whole problem — 1,919 of 1,972 statement-born rows name
  // nobody and none names a song, so answering them meant 1,919 separate edits.
  //
  // On BOTH halves deliberately: it is one component, the absence was identical,
  // and a control that exists on one URL and not the other is a thing to explain
  // forever.
  //
  // Declared HERE, above `selectedRows` — that derivation runs during render and
  // reads this Set inside a .filter callback, so a declaration below it is a
  // temporal-dead-zone throw the moment the ledger has a single row.
  const [selected, setSelected] = useState(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkPanel, setBulkPanel] = useState(null) // 'artist' | 'song' | 'category' | 'vendors' | null
  const [bulkValue, setBulkValue] = useState('')


  // ── The statement lens ────────────────────────────────────────────────────
  //
  // A bank ledger's job is a month at a time: this is what the account did in
  // June, and here is the proof it adds up. The page had no period control at
  // all, and — more to the point — it could only ever show the debits this app
  // BOOKED into entries. Measured 2026-08-20: 1,964 of 3,175 debits, 61.9%. The
  // other 1,211 are 749 matched to invoices (they live on the invoiced half),
  // 429 dismissed and 33 still open, and those two thousand-odd rows appear
  // nowhere in the app's ledger surfaces.
  //
  // So selecting a statement pulls that statement's OWN transactions and merges
  // them in. `stmtTx` is keyed by txn id; ledger rows already carry
  // `bank_evidence.txn_id` from bankEvidenceCols(), which is the join.
  // The statement lens reads the SHARED bank scope, not local state.
  //
  // /bk/bank-ledger is one tab of the Banking family; the other three are
  // separate routes, so switching to For review unmounts this page and any
  // month held in useState dies with it. lib/bankScope.js holds it outside the
  // tree — see its header for why not the URL, localStorage or a provider.
  //
  // This hook MUST stay above line ~2142, where `stmtId` is read inside a
  // .filter() callback. That is exactly the ARRAY_CALLBACK_TDZ shape smoke
  // greps for, and it has blanked this page once already.
  //
  // The invoiced half must not read the scope at all: `/bk/ledger` and
  // `/bk/bank-ledger` are the same component, and a statement lens over the
  // invoiced ledger answers a question that page is not asked. The `bank ?`
  // guard is what keeps `/bk/ledger` behaving exactly as it did.
  const bankScope = useBankScope()
  const statements = bank ? bankScope.statements : EMPTY_STATEMENTS
  const stmtId = bank ? (bankScope.statementId ?? '') : ''
  const stmtDetail = bank ? bankScope.detail : null
  const stmtLoading = bank ? bankScope.detailLoading : false
  // Out · In · Both. Defaults to Out so the page opens exactly as it did.
  const [direction, setDirection] = useState('out')

  // ── Coarse cut: invoices vs direct bank spend ───────────────────────────
  //
  // The ledger is 63% rows booked from bank statements and 33% real A/P
  // documents, and both are legitimately "spend" — which is why they share
  // one table, and why every report reads that one table. But they are not
  // the same *kind* of record, and the day-to-day question ("what do we owe
  // against an invoice") only concerns the second.
  //
  // So: one table, three views. 'all' is exactly today's behaviour and is
  // the default, because total spend genuinely is invoices + direct bank
  // spend and that is the honest headline. Composes with filterSource
  // rather than replacing it — this is the coarse cut, that is the fine one.
  //
  // Deliberately NOT persisted, unlike the hidden-columns preference. Which
  // COLUMNS you last chose is cosmetic; which ROWS you last narrowed to is
  // not, and a remembered narrow view is how someone concludes a row has
  // vanished from the ledger.
  const [ledgerView, setLedgerView] = useState('all')
  // Compile amount query once per render — the matcher tests each row's
  // native amount. Null result means "invalid input or empty" — treat
  // that as no filter (so a typo doesn't wipe the list to zero rows).
  const amountMatcher = parseAmountQuery(amountQuery)

  const colPanelRef = useRef(null)
  // Export dropdown — collapses the four admin export buttons into one menu.
  const exportMenuRef = useRef(null)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)

  useHotkeys([
    { key: 'z', handler: () => handleUndo() },
    { key: 'c', handler: () => setColPanelOpen(v => !v) },
    { key: 'x', handler: () => {
      const token = localStorage.getItem('token')
      // The export contains the page. A workbook that silently included the
      // other 2,326 rows would disagree with the screen it came from — and this
      // one goes to the accountant.
      window.open(`${apiBase}/bk/export?token=${token}&source=${bank ? 'bank' : 'invoices'}`, '_blank')
    }},
  ])

  // ── Lifecycle ────────────────────────────────────────────────────────────
  const lastFetchRef = useRef(0)
  useEffect(() => { fetchEntries() }, [])

  // The statement list and the selected statement's transactions both come from
  // the shared store now. It single-flights and caches per id, so the header
  // above this page and the page itself cost ONE 703KB read between them
  // instead of two — and moving between the four banking tabs with a month
  // selected costs none at all.
  useEffect(() => { if (bank) fetchStatements() }, [bank])
  useEffect(() => { if (bank && stmtId) fetchStatementDetail(stmtId) }, [bank, stmtId])

  // Read ?focus=<id> from the URL so deep-links (e.g. the "Open existing
  // entry" affordance on Add Invoice's duplicate-warning card) land the
  // user on the exact row, not just the ledger. Also runs when the URL
  // changes so multiple deep-links in a session keep working.
  useEffect(() => {
    const id = Number(new URLSearchParams(location.search).get('focus'))
    if (id) setFocusId(id)
  }, [location.search])

  // Once entries are loaded AND we have a focus id, scroll the row into
  // view, expand its split parent if the row is a child (otherwise it'd
  // be hidden by the split-family collapse), and clear the search
  // filter so an active search doesn't hide the row. The highlight is
  // PERSISTENT — once focused, the row stays gently marked until the
  // component unmounts or the user navigates away, so a rep can jump
  // back to it after scrolling around the ledger without losing it.
  // The URL param IS stripped right after the initial scroll so a
  // refresh doesn't re-scroll the page.
  useEffect(() => {
    if (!focusId || loading) return
    const row = entries.find(e => e.id === focusId)
    // ── The row might be in the OTHER half ──────────────────────────────────
    //
    // `?focus=<id>` is linked from ten files — Bank Matching's "ledger →" on
    // every booked row, plus BkStatements, BkApprovals, Recoupments,
    // ArtistCampaigns, Duplicates, BkVendorsAdded — and a great many of those
    // ids are bank-created entries. After the split each of those links would
    // land on a page that cannot show its target, and the old code's response to
    // a missing row was `return`: a silent dead end on a link that used to work.
    //
    // Fixed HERE rather than at the ten call sites, so a link written anywhere
    // lands in the right half without knowing which half that is.
    //
    // `xhalf` caps it at ONE hop. Redirecting on "not found" without a marker
    // would bounce a genuinely unknown id between the two pages forever.
    if (!row) {
      const here = new URL(window.location.href)
      if (!here.searchParams.has('xhalf')) {
        navigate(`${bank ? '/bk/ledger' : '/bk/bank-ledger'}?focus=${focusId}&xhalf=1`, { replace: true })
        return
      }
      // BOTH halves checked and the row is in neither. Silence here was a dead
      // end: the link looked live, the page loaded, and nothing happened —
      // which is what John met following "Open existing entry" to a PENDING
      // invoice. The ledger lists approved entries only, so an entry awaiting
      // approval can never appear here however hard the page looks.
      setFocusMissing(focusId)
      return
    }
    setFocusMissing(null)
    // Clear the search so a stale query can't filter the row out.
    if (search) setSearch('')
    // If it's a split child, expand its parent's group.
    if (row.parent_id) {
      setExpandedGroups(prev => {
        if (prev.has(row.parent_id)) return prev
        const next = new Set(prev)
        next.add(row.parent_id)
        return next
      })
    }
    // Delay long enough for the row to render (fresh state → next paint),
    // then scroll it into view + strip the ?focus= param so refresh
    // doesn't re-trigger the scroll. Focus state stays set so the
    // highlight persists.
    // RETRY rather than one shot. Reaching a deep row can take an extra paint or
    // two — the render window stretches, and a split child's parent group has to
    // expand first — and a single 80ms attempt that missed left the link looking
    // broken with no way to tell whether the row was absent or merely late.
    let tries = 0
    const tick = () => {
      const el = document.querySelector(`[data-entry-id="${focusId}"]`)
      if (!el) {
        // ~1.2s of patience, then give up quietly: the highlight state stays set,
        // so the row is still marked when the reader scrolls to it themselves.
        if (tries++ < 12) { timer = setTimeout(tick, 100); return }
      } else {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      const url = new URL(window.location.href)
      if (url.searchParams.has('focus') || url.searchParams.has('xhalf')) {
        url.searchParams.delete('focus')
        // The one-hop marker goes too, or a later link into this page would be
        // treated as already-redirected and dead-end again.
        url.searchParams.delete('xhalf')
        navigate(url.pathname + (url.search ? url.search : '') + url.hash, { replace: true })
      }
    }
    let timer = setTimeout(tick, 80)
    return () => { clearTimeout(timer) }
  }, [focusId, loading, entries.length, bank])
  // Refetch when the tab/window regains focus so edits made on the
  // Recoupments page (song / category renames, label edits, recoupable
  // toggles, etc.) show up the next time the user comes back to the
  // Ledger without needing a hard refresh. Throttled to one fetch per
  // 10s AND silent (keeps existing rows on screen instead of flashing
  // the skeleton) so quick refocus events from clicking around the page
  // don't read as full reloads.
  useEffect(() => {
    const maybeRefetch = () => {
      if (Date.now() - lastFetchRef.current < 10_000) return
      fetchEntries({ silent: true })
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
  // Pull the full roster once so artist names can hyperlink to /artists/:id.
  // limit=10000 covers any plausible roster size; the response is small
  // (name + id) and only fetched on mount.
  useEffect(() => {
    api.get('/artists?limit=10000')
      .then(r => setRoster(r.data?.data || []))
      .catch(() => { /* link affordance just won't render — no broken link */ })
  }, [])

  // Pull the full release list so the inline Song cell can offer autocomplete
  // suggestions. in_catalog=any so older releases that have moved to catalog
  // are still suggestible (vendors invoice for old songs too). Best-effort —
  // a fetch failure just means no suggestions, the input stays editable.
  const [releases, setReleases] = useState([])
  useEffect(() => {
    api.get('/releases?in_catalog=any')
      .then(r => setReleases(Array.isArray(r.data?.data) ? r.data.data : []))
      .catch(() => { /* fall through to entry-derived suggestions only */ })
  }, [])

  // Case-insensitive name → artist lookup. Built once per roster change.
  // Conflicting duplicates (same name, different casing) keep the first match.
  const artistByName = (() => {
    const map = new Map()
    for (const a of roster) {
      const key = String(a.name || '').trim().toLowerCase()
      if (key && !map.has(key)) map.set(key, a)
    }
    return map
  })()
  const artistLinkFor = (name) => {
    const key = String(name || '').trim().toLowerCase()
    return key ? artistByName.get(key) : null
  }

  // ── Song autocomplete catalog ──────────────────────────────────────────
  // Two sources stitched together: releases.project_name (canonical song list)
  // and existing ledger entries' song values (covers songs that vendors have
  // invoiced for but don't have a release yet). De-duplicated case-insensitively
  // — the most common spelling wins as the displayed option label. Keyed by
  // lowercased artist name so the per-row datalist can show only that artist's
  // songs. An empty-key bucket holds the union of every song for rows with no
  // artist set.
  const songCatalog = useMemo(() => {
    const byArtist = new Map() // artistKeyLC -> Map<songLC, { name, count }>
    const all = new Map()
    const bump = (artistKey, songRaw) => {
      const name = String(songRaw || '').trim()
      if (!name) return
      const songKey = name.toLowerCase()
      if (!byArtist.has(artistKey)) byArtist.set(artistKey, new Map())
      const m = byArtist.get(artistKey)
      const existing = m.get(songKey) || { name, count: 0 }
      if (existing.count === 0) existing.name = name
      else if (name.length < existing.name.length) existing.name = name
      existing.count += 1
      m.set(songKey, existing)
      const a = all.get(songKey) || { name, count: 0 }
      a.count += 1
      if (a.count === 1) a.name = name
      all.set(songKey, a)
    }
    for (const r of releases) {
      bump(normalizeArtistKey(r.artist_name), r.project_name)
    }
    for (const e of entries) {
      if (!e?.song) continue
      bump(normalizeArtistKey(e.artist), e.song)
    }
    const toSortedList = (m) =>
      Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name)).map(v => v.name)
    const perArtist = {}
    for (const [k, m] of byArtist) perArtist[k] = toSortedList(m)
    return { perArtist, all: toSortedList(all) }
  }, [releases, entries])

  // Artist vocabulary for the bulk picker. Two sources, same reasoning as the
  // song catalog: the roster is the canonical list, but the ledger holds names
  // that predate a roster row — 200 distinct artists carry recoupable spend
  // against a 50-artist roster. Most-used spelling first, so the option offered
  // is the one the rest of the app shows. Free text is still accepted: a bank
  // descriptor's artist can be one nobody has typed yet.
  const artistCatalog = useMemo(() => {
    const counts = new Map()
    const bump = (raw) => {
      const name = String(raw || '').trim()
      if (!name) return
      const k = name.toLowerCase()
      const cur = counts.get(k) || { name, n: 0 }
      cur.n += 1
      counts.set(k, cur)
    }
    for (const e of entries) bump(e.artist)
    for (const a of roster) bump(a.name)
    return Array.from(counts.values())
      .sort((x, y) => y.n - x.n || x.name.localeCompare(y.name))
      .map(v => v.name)
  }, [entries, roster])

  // Stable datalist id slugger so artist names that include odd characters
  // still produce valid DOM ids. Falls back to the catch-all list when the
  // artist key isn't present in the per-artist catalog (e.g. a freshly-
  // typed artist in the split modal that doesn't yet have any songs).
  const songListId = (artistName) => {
    const key = normalizeArtistKey(artistName)
    if (!key || !songCatalog.perArtist[key]) return 'ledger-songs-_all'
    // normalizeArtistKey already strips non-alphanumerics, so the key
    // is HTML-id-safe. No further escaping needed.
    return 'ledger-songs-' + key
  }

  // Render datalist elements once per artist present in entries plus a
  // catch-all. Each row's <input list="..."> references one of these.
  const songDatalists = useMemo(() => {
    const artistKeys = new Set([''])
    for (const e of entries) artistKeys.add(normalizeArtistKey(e.artist))
    return Array.from(artistKeys).map(k => {
      const id = k ? songListId(k) : 'ledger-songs-_all'
      const list = k ? (songCatalog.perArtist[k] || []) : songCatalog.all
      return { id, options: list }
    })
  }, [songCatalog, entries])

  useEffect(() => {
    const handler = (e) => {
      if (colPanelRef.current && !colPanelRef.current.contains(e.target)) setColPanelOpen(false)
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target)) setExportMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  async function fetchEntries(opts = {}) {
    const { silent = false } = opts
    try {
      if (!silent) setLoading(true)
      if (!silent) setError('')
      // include_voided=true keeps the ledger as the ONLY page that shows
      // voided rows (with the dimmed strikethrough styling). Every other
      // page that pulls /bk/entries — Recoupments, etc. — omits this
      // flag and gets voided rows filtered out server-side.
      // view=ledger trims the response to the 59 fields this page and its
      // children actually read, from 99. On ~3,650 rows that is most of an
      // 8.67 MB payload — and mostly key names, not values, since 99 JSON keys
      // repeat on every row. The other four pages on /bk/entries are unaffected;
      // the default response shape is unchanged.
      // &source= splits the ledger in two. OPT-IN server-side, so the twenty
      // other callers of /bk/entries are untouched; each half of this page names
      // its own half explicitly rather than relying on a default.
      const res = await api.get(`/bk/entries?status=approved&deleted=false&include_voided=true&view=ledger&source=${bank ? 'bank' : 'invoices'}`)
      setEntries(res.data.data || [])
      lastFetchRef.current = Date.now()
    } catch (err) {
      if (!silent) setError('Failed to load: ' + (err.response?.data?.error || err.message))
    } finally {
      if (!silent) setLoading(false)
    }
  }

  function showToast(msg, isError = false, undoFn = null) {
    // Clear the previous toast's timer — back-to-back saves (some controls
    // fire two saveFields per interaction) let toast #1's timer dismiss
    // toast #2 early, cutting its 5s Undo window to a fraction.
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast({ msg, isError, undoFn })
    toastTimerRef.current = setTimeout(() => setToast(null), undoFn ? 5000 : 2800)
  }

  // Revert one specific edit record. The toast Undo must not call
  // handleUndo(): that closure's undoStack snapshot predates the entry it
  // was created for — first-edit Undo no-op'd, later ones reverted the
  // PREVIOUS edit while consuming the newest stack record.
  async function revertEdit(rec) {
    try {
      await api.put(`/bk/entries/${rec.id}`, { [rec.field]: rec.oldValue })
      setEntries(prev => prev.map(e => e.id === rec.id ? { ...e, [rec.field]: rec.oldValue } : e))
      setUndoStack(prev => {
        for (let i = prev.length - 1; i >= 0; i--) {
          const r = prev[i]
          if (r.id === rec.id && r.field === rec.field && r.newValue === rec.newValue) {
            return [...prev.slice(0, i), ...prev.slice(i + 1)]
          }
        }
        return prev
      })
      showToast(`Undid change to ${rec.payee}`)
    } catch (err) {
      showToast('Undo failed: ' + (err.response?.data?.error || err.message), true)
    }
  }

  // ── Inline save ───────────────────────────────────────────────────────────
  async function saveField(id, field, value) {
    const entry = entries.find(e => e.id === id)
    const oldValue = entry ? entry[field] : undefined
    try {
      const res = await api.put(`/bk/entries/${id}`, { [field]: value })
      const fresh = res.data?.data || {}
      setEntries(prev => prev.map(e => e.id === id
        ? {
            ...e,
            [field]: value,
            // Server-side autoLinkRelease may have updated release_id when
            // song or artist changed — pick that up so the inline link
            // indicator (and the existing release_id-aware UI bits) update.
            release_id: 'release_id' in fresh ? fresh.release_id : e.release_id,
          }
        : e))
      const rec = { id, field, oldValue, newValue: value, payee: entry?.payee || '' }
      setUndoStack(prev => [...prev.slice(-19), rec])
      const linkNote = (field === 'song' || field === 'artist') && fresh.release_id && fresh.release_id !== entry?.release_id
        ? ' — linked to release'
        : ''
      showToast(`Updated ${field} on ${entry?.payee || 'entry'}${linkNote}`, false, () => revertEdit(rec))
    } catch (err) {
      showToast('Save failed: ' + (err.response?.data?.error || err.message), true)
    }
  }

  async function handleUndo() {
    if (undoStack.length === 0) return
    const last = undoStack[undoStack.length - 1]
    if (last.bulk) { await revertBulk(last); return }
    try {
      await api.put(`/bk/entries/${last.id}`, { [last.field]: last.oldValue })
      setEntries(prev => prev.map(e => e.id === last.id ? { ...e, [last.field]: last.oldValue } : e))
      setUndoStack(prev => prev.slice(0, -1))
      showToast(`Undid change to ${last.payee}`)
    } catch (err) {
      showToast('Undo failed: ' + (err.response?.data?.error || err.message), true)
    }
  }

  // Undo a bulk edit: one action in, one action out.
  //
  // The rows are regrouped by the value they HELD, so restoring a mixed
  // selection is one call per distinct old value rather than one per row —
  // typically two or three calls for a selection of hundreds.
  //
  // It replays only what the server reported as changed. A row that already held
  // the new value never entered `previous`, so undo cannot "restore" it to a
  // value it never had.
  async function revertBulk(rec) {
    const byValue = new Map()
    for (const p of rec.entries || []) {
      const k = JSON.stringify(p.value ?? null)
      if (!byValue.has(k)) byValue.set(k, { value: p.value ?? null, ids: [] })
      byValue.get(k).ids.push(p.id)
    }
    try {
      for (const g of byValue.values()) {
        await api.post('/bk/entries/bulk', { ids: g.ids, field: rec.field, value: g.value })
      }
      setUndoStack(prev => prev.filter(r => r !== rec))
      showToast(`Undid the ${rec.label} change on ${rec.entries.length} row${rec.entries.length === 1 ? '' : 's'}`)
      await fetchEntries({ silent: true })
    } catch (err) {
      showToast('Undo failed: ' + (err.response?.data?.error || err.message), true)
    }
  }

  // Flag-for-review — POST /bk/entries/:id/flag. Optimistic update:
  // flip the row now, roll back on failure. Reason is optional; server
  // clears it automatically when unflagging so we don't have to.
  async function toggleFlag(entryId, nextFlagged, reason = null) {
    setEntries(prev => prev.map(e => e.id === entryId ? {
      ...e,
      flagged: nextFlagged,
      flag_reason: nextFlagged ? (reason ?? e.flag_reason ?? null) : null,
      flagged_at: nextFlagged ? new Date().toISOString() : null,
    } : e))
    try {
      const body = { flagged: nextFlagged }
      if (reason != null) body.flag_reason = reason
      const { data } = await api.post(`/bk/entries/${entryId}/flag`, body)
      if (data?.data) {
        setEntries(prev => prev.map(e => e.id === entryId ? { ...e, ...data.data } : e))
      }
    } catch (err) {
      showToast(`Couldn't ${nextFlagged ? 'flag' : 'unflag'} entry: ${err?.response?.data?.error || err.message}`, true)
      // Roll back — refetch to re-sync from source of truth
      fetchEntries()
    }
  }
  async function saveFlagReason(entryId, reason) {
    setEntries(prev => prev.map(e => e.id === entryId ? { ...e, flag_reason: reason || null } : e))
    try {
      await api.post(`/bk/entries/${entryId}/flag`, { flagged: true, flag_reason: reason || '' })
    } catch (err) {
      showToast(`Couldn't save reason: ${err?.response?.data?.error || err.message}`, true)
    }
  }

  function handleFileUploaded(entryId, fileType) {
    const key = fileType === 'invoice' ? 'has_invoice' : fileType === 'w9' ? 'has_w9' : fileType === 'receipt' ? 'has_receipt' : 'has_proof'
    setEntries(prev => prev.map(e => e.id === entryId ? { ...e, [key]: true } : e))
    showToast(`${fileType.charAt(0).toUpperCase() + fileType.slice(1)} uploaded`)
    // When proof is uploaded, AI scans in background — re-fetch to pick up date/ref/status
    if (fileType === 'proof') {
      showToast('Proof uploaded — AI scanning for payment details...')
      setTimeout(() => fetchEntries(), 4000)
    }
  }

  function handleFileDeleted(entryId, fileType) {
    const key = fileType === 'invoice' ? 'has_invoice' : fileType === 'w9' ? 'has_w9' : fileType === 'receipt' ? 'has_receipt' : 'has_proof'
    setEntries(prev => prev.map(e => e.id === entryId ? { ...e, [key]: false } : e))
    showToast(`${fileType.charAt(0).toUpperCase() + fileType.slice(1)} removed`)
  }

  // Multi-file receipts land in entity_files; bump the count so the cell flips
  // to "N files" without a full refetch.
  function handleReceiptUploaded(entryId) {
    setEntries(prev => prev.map(e => e.id === entryId ? { ...e, receipt_count: (e.receipt_count || 0) + 1 } : e))
    showToast('Receipt uploaded')
  }

  // Receipts live in two stores: the legacy receipt_data blob (has_receipt) and
  // entity_files (receipt_count). Decrement the right one so the cell count stays
  // accurate without a refetch.
  function handleReceiptRemoved(entryId, kind) {
    setEntries(prev => prev.map(e => {
      if (e.id !== entryId) return e
      return kind === 'legacy'
        ? { ...e, has_receipt: false }
        : { ...e, receipt_count: Math.max(0, (e.receipt_count || 0) - 1) }
    }))
    showToast('Receipt removed')
  }

  async function handleDelete() {
    if (!pendingDelete) return
    try {
      await api.delete(`/bk/entries/${pendingDelete.id}`)
      setEntries(prev => prev.filter(e => e.id !== pendingDelete.id))
      showToast('Deleted')
    } catch (err) {
      showToast('Delete failed: ' + (err.response?.data?.error || err.message), true)
    }
    setPendingDelete(null)
  }

  // The dialog derives its own rows from the family it is handed, so opening it
  // is just naming the invoice.
  function openSplitModal(entry) { setSplitEntry(entry) }

  async function unsplitEntry(entry) {
    // Pre-compute the comma-joined song so the user can edit it before confirming.
    // Fall back to the parent's artist_breakdown when no child rows are loaded
    // (e.g. the user is filtering to just the parent or is on a sort that hides
    // them) — server-side handles either case.
    const childSongsFromEntries = entries
      .filter(e => e.parent_id === entry.id && !e.deleted)
      .map(e => (e.song || '').trim())
    const childSongsFromBreakdown = Array.isArray(entry.artist_breakdown)
      ? entry.artist_breakdown.map(s => (s.song || '').trim())
      : []
    const childSongs = (childSongsFromEntries.length ? childSongsFromEntries : childSongsFromBreakdown).filter(Boolean)
    const seen = new Set()
    const combined = [(entry.song || '').trim(), ...childSongs]
      .filter(s => {
        if (!s) return false
        const k = s.toLowerCase()
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      .join(', ')
    const song = window.prompt(
      'Unsplit this entry — combine children back into one row.\n\nSong name for the combined row:',
      combined
    )
    if (song === null) return // user cancelled
    try {
      await api.delete(`/bk/entries/${entry.id}/splits`, { data: { song: song.trim() } })
      await fetchEntries()
      showToast('Entry unsplit')
    } catch (err) {
      showToast('Unsplit failed: ' + (err.response?.data?.error || err.message), true)
    }
  }

  function openFeeReimbModal(entry) {
    setFeeReimbEntry(entry)
    setFeeAmount('')
    setReimbAmount('')
    setFeeReimbReceipt(null)
  }

  async function toggleVoid(entry) {
    const isVoided = !!entry.voided
    if (!isVoided) {
      const ok = window.confirm(
        `Void this invoice for ${entry.payee || 'this vendor'}?\n\n` +
        `It stays on the ledger for the audit trail but is removed from the Payment Dashboard. ` +
        `You can un-void it later from the same row.`
      )
      if (!ok) return
    }
    try {
      await api.post(`/bk/entries/${entry.id}/${isVoided ? 'unvoid' : 'void'}`)
      // Optimistic update — also flip any children of a split family in place.
      setEntries(prev => prev.map(e =>
        e.id === entry.id || e.parent_id === entry.id
          ? { ...e, voided: !isVoided, voided_at: isVoided ? null : new Date().toISOString(), voided_by: isVoided ? null : currentUser?.name }
          : e
      ))
      showToast(isVoided ? 'Invoice un-voided' : 'Invoice voided')
    } catch (err) {
      showToast((isVoided ? 'Un-void' : 'Void') + ' failed: ' + (err.response?.data?.error || err.message), true)
    }
  }

  async function handleFeeReimbSplit() {
    if (!feeReimbEntry) return
    const fee   = parseFloat(feeAmount)
    const reimb = parseFloat(reimbAmount)
    if (!fee || !reimb || fee <= 0 || reimb <= 0) {
      showToast('Enter both amounts', true); return
    }
    if (!feeReimbReceipt) {
      showToast('Attach the receipt for the reimbursement portion', true); return
    }
    const total = parseFloat(feeReimbEntry.amount) || 0
    if (Math.abs((fee + reimb) - total) > 0.01) {
      showToast(`Fee + reimb (${fmt(fee + reimb)}) must equal the invoice total (${fmt(total)})`, true); return
    }
    setFeeReimbBusy(true)
    try {
      const fd = new FormData()
      fd.append('fee_amount', String(fee))
      fd.append('reimb_amount', String(reimb))
      fd.append('receipt_file', feeReimbReceipt)
      await api.post(`/bk/entries/${feeReimbEntry.id}/split-fee-reimb`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      await fetchEntries()
      showToast('Carved out reimbursement portion')
      setFeeReimbEntry(null)
    } catch (err) {
      showToast('Split failed: ' + (err.response?.data?.error || err.message), true)
    }
    setFeeReimbBusy(false)
  }

  // ── Derived data ──────────────────────────────────────────────────────────
  const allCats    = [...new Set(entries.map(e => e.category).filter(Boolean))].sort()
  // Deduplicate artists, keep most common spelling. Punctuation-aware
  // key so "LIFE/LINE" and "LIFELINE" collapse into one dropdown entry.
  const allArtists = (() => {
    const map = {}
    entries.forEach(e => {
      if (!e.artist) return
      const key = normalizeArtistKey(e.artist)
      if (!map[key]) map[key] = {}
      map[key][e.artist] = (map[key][e.artist] || 0) + 1
    })
    return Object.values(map).map(v => Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]).sort()
  })()

  // How many rows are painted. Grows on scroll; resets whenever the result set
  // changes, or a new search would inherit the previous scroll's grown cap and
  // paint thousands of rows again.
  const RENDER_PAGE = 150
  const [renderCap, setRenderCap] = useState(RENDER_PAGE)
  // Set when marking Paid looks like it created a duplicate of a bank row already
  // booked from a statement. Reported after the fact, never blocking.
  const [dupWarning, setDupWarning] = useState(null)
  const growSentinelRef = useRef(null)

  // Every filter EXCEPT the invoices/bank view. Split out so the view switch
  // can label each segment with the count it would actually show — a segment
  // reading "2,325" while a live search has narrowed the table to twelve rows
  // is worse than no number at all.
  // The typed query as an INVOICE NUMBER, so the stored form and the typed form
  // do not have to agree on punctuation.
  //
  // 465 of the 1,311 numbers in the ledger carry a prefix or leading zeros —
  // "INV454", "#inv-2026-08-06", "00307", "Invoice 7260", "INV-0DIDT6Y0-0007".
  // A substring test already finds the ones where what you type is contained in
  // what is stored ("307" finds "00307"), and misses the reverse: type "INV-454"
  // against a stored "INV454", or "#307" against "00307", and there is no
  // contiguous run to find. So the normalized forms are compared too, through the
  // SAME normalizeInvoiceNum the duplicate detector and the vendor-submit gate
  // use — one definition of what an invoice number is.
  //
  // Two characters minimum: prefix-only numbers collapse to "0" by design, and a
  // one-character key would match on nothing anybody meant.
  const searchInvNum = (() => {
    const n = normalizeInvoiceNum(search.trim())
    return n && n.length >= 2 ? n : ''
  })()
  const preView = entries.filter(e => {
    const q = search.toLowerCase()
    if (q) {
      const hay = `${e.payee} ${e.artist} ${e.song} ${e.description} ${e.invoice_number}`.toLowerCase()
      const byNumber = searchInvNum && normalizeInvoiceNum(e.invoice_number) === searchInvNum
      if (!hay.includes(q) && !byNumber) return false
    }
    if (amountMatcher && !amountMatcher(Number(e.amount))) return false
    if (filterQB     && e.in_quickbooks    !== filterQB)                return false
    if (filterRecoup === 'Yes' && !e.recoupable)                           return false
    if (filterRecoup === 'No'  && e.recoupable)                            return false
    if (filterCat    && e.category         !== filterCat)               return false
    if (filterArtist && normalizeArtistKey(e.artist) !== normalizeArtistKey(filterArtist)) return false
    if (filterPaid   && (e.payment_status || 'Unpaid') !== filterPaid) return false
    if (filterMethod && (e.payment_method || '') !== filterMethod) return false
    if (filterFlag === 'Yes' && !e.flagged) return false
    if (filterFlag === 'No'  &&  e.flagged) return false
    if (filterBulk === 'Yes' && !e.is_bulk_deal) return false
    if (filterBulk === 'No'  &&  e.is_bulk_deal) return false
    // Same function the Source column renders from — see SOURCE_BUCKETS.
    if (filterSource && sourceBucketKey(e) !== filterSource) return false
    // The statement lens narrows the LEDGER rows too. Without this, picking June
    // would show June's unbooked lines beside every month's booked ones, and the
    // tie-out header would sit above a row set that is not the month it describes.
    // bank_evidence.statement_id is the row's own line, resolved through the
    // family root — the same join the merge uses.
    if (stmtId && String(e.bank_evidence?.statement_id ?? '') !== String(stmtId)) return false
    return true
  })

  // Segment counts, and the coarse cut itself. `isBankRow` is the single
  // predicate: 'invoices' is its complement, not a narrower whitelist, so the
  // two views always partition the set — no row can be in neither or both.
  const viewCounts = {
    all:      preView.length,
    bank:     preView.filter(isBankRow).length,
    invoices: preView.filter(e => !isBankRow(e)).length,
  }

  // ── The all/bank/invoices switch is SUPERSEDED by the page split ───────────
  //
  // It was the earlier, weaker version of this feature: one page, three
  // segments. Now that the server filters by source per page, two of its three
  // segments are meaningless on either half — the Bank Ledger would offer
  // "Invoices 0" and the ledger "Bank 0", which reads as a broken filter rather
  // than an empty one. Leaving a control whose only remaining states are "all"
  // and "nothing" is how a page accumulates dead surfaces.
  //
  // The cut still runs, so the code path stays exercised; it just has nothing
  // left to remove, because the fetch already removed it.
  const showViewSwitch = false
  const filtered = preView.filter(e => (
    ledgerView === 'bank'     ? isBankRow(e) :
    ledgerView === 'invoices' ? !isBankRow(e) :
    true
  )).sort((a, b) => {
    const da = a[sortField] || '', db = b[sortField] || ''
    // Push empty values to the end regardless of sort direction
    if (!da && db) return 1
    if (da && !db) return -1
    if (da < db) return sortDir === 'desc' ? 1 : -1
    if (da > db) return sortDir === 'desc' ? -1 : 1
    return sortDir === 'desc' ? b.id - a.id : a.id - b.id
  })

  // Split group structure
  const inSet = new Set(filtered.map(e => e.id))
  const childrenOf = {}
  const roots = []
  filtered.forEach(e => {
    if (e.parent_id && inSet.has(e.parent_id)) {
      (childrenOf[e.parent_id] = childrenOf[e.parent_id] || []).push(e)
    } else {
      roots.push(e)
    }
  })
  const flat = []
  roots.forEach(e => { flat.push(e); (childrenOf[e.id] || []).forEach(c => flat.push(c)) })

  // ── Incremental render ────────────────────────────────────────────────────
  //
  // Every row used to go into the DOM — ~3,650 of them, each a frozen cell with
  // an internal flex layout, so the browser paid for the whole ledger to show
  // one screenful. Paint a window and grow it as you scroll.
  //
  // Only the PAINT is capped. `filtered` still drives the TOTAL row, the
  // currency breakdown and the "N of M" count, so every figure on the page
  // still describes the full matching set — capping those instead would be a
  // silently wrong total, which is far worse than a slow page.
  //
  // Hand-rolled rather than react-window: a new dependency is the documented way
  // a Railway build fails while /health keeps serving the old bundle, and the
  // single-sticky-cell row layout doesn't fit a windowing library's fixed-height
  // row contract without being torn apart.
  const renderable = flat.filter(e => !(e.parent_id && inSet.has(e.parent_id))
    || expandedGroups.has(e.parent_id))
  // A ?focus= target BEYOND the render window has to be painted, or the deep-link
  // scroll queries the DOM for a row that was never rendered and silently does
  // nothing. The mobile branch below already stretched its window for this; the
  // desktop table did not, and its comment said so — "the desktop table is
  // untouched" — which read as a scope note rather than the bug it was.
  //
  // John, 2026-08-18: Add Invoice's duplicate warning links to entry #300, which
  // sits ~1,100 rows into the invoice half. The link resolved, the row existed,
  // the effect ran, and nothing moved.
  //
  // DERIVED, not state: an effect above resets renderCap whenever the visible set
  // changes, so growing the state here would be undone on the next render.
  let effectiveCap = renderCap
  if (focusId != null) {
    const idx = renderable.findIndex(e => e.id === focusId)
    if (idx >= effectiveCap) effectiveCap = idx + 10
  }
  const shown = renderable.slice(0, effectiveCap)
  const moreToRender = renderable.length - shown.length

  // ── The statement lens ────────────────────────────────────────────────────
  //
  // The rules live in lib/statementLens.js: what a bank line IS, and whether a
  // month adds up. Pure, so they are tested against real statement payloads in
  // node rather than by looking at a screen, and in one place, because money rules
  // in this file have a history of existing in three.
  const stmtTx = stmtDetail?.transactions || []

  // Ledger rows on this half, by the transaction they settle. `bank_evidence`
  // resolves through COALESCE(parent_id, id), so a split child maps to its
  // family's line — right, because one bank line should be one row here.
  //
  // Built from the FILTERED set, not all entries: a line whose row the current
  // filters hide has no row on screen, and must therefore appear in the extra
  // list rather than vanishing from a page that claims to account for the month.
  const rowByTxn = useMemo(() => {
    const m = new Map()
    for (const e of filtered) {
      const tid = e.bank_evidence?.txn_id
      if (tid != null && !m.has(tid)) m.set(tid, e)
    }
    return m
  }, [filtered])

  const stmtSummary = useMemo(
    () => (stmtDetail ? summariseStatement(stmtDetail.statement, stmtTx) : null),
    [stmtDetail, stmtTx])

  const extraTx = useMemo(
    () => (stmtDetail ? extraTransactions(stmtTx, rowByTxn, direction) : []),
    [stmtDetail, stmtTx, rowByTxn, direction])

  // ── The selection, and what it is a selection OF ──────────────────────────
  //
  // `renderable` — every row the current filters admit — not `shown`, which is
  // the ~150 painted so far. A bar reading "12 selected" while writing to 1,900
  // is the band-and-list failure this page has shipped twice, so select-all takes
  // the filtered set and the bar SAYS when that is more than is on screen.
  //
  // Kept as an id Set filtered against `renderable` on every read, so changing a
  // filter cannot leave a hidden row selected and then write to it.
  const selectableIds = renderable.map(e => e.id)
  const selectedRows = renderable.filter(e => selected.has(e.id))
  const selCount = selectedRows.length
  const allSelected = selCount > 0 && selCount === selectableIds.length
  const someSelected = selCount > 0 && !allSelected
  const selectedOffscreen = selectedRows.filter(e => !shown.some(s => s.id === e.id)).length

  const toggleRow = (id) => setSelected(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const toggleAll = () => setSelected(prev => (
    prev.size >= selectableIds.length && selectableIds.every(id => prev.has(id))
      ? new Set()
      : new Set(selectableIds)
  ))
  const clearSelection = () => { setSelected(new Set()); setBulkPanel(null); setBulkValue('') }

  // One field, many rows, through POST /bk/entries/bulk — which whitelists the
  // column, refuses a comma in a song (that would auto-split every selected row)
  // and hands back the previous values so this is ONE undo, not N.
  const applyBulk = async (field, value, label) => {
    if (!selCount || bulkBusy) return
    const ids = selectedRows.map(e => e.id)
    setBulkBusy(true)
    try {
      const { data } = await api.post('/bk/entries/bulk', { ids, field, value })
      const d = data?.data || {}
      // Optimistic, then a silent refetch: the server decides which rows changed
      // (a voided row is skipped), so the authoritative answer is its `previous`
      // list, not the ids we sent.
      const changedIds = new Set((d.previous || []).map(p => p.id))
      setEntries(prev => prev.map(e => (changedIds.has(e.id) ? { ...e, [field]: value } : e)))
      const rec = d.previous?.length
        ? { bulk: true, field, entries: d.previous, label: label || field }
        : null
      if (rec) setUndoStack(st => [...st.slice(-19), rec])
      showToast(
        `${d.changed} ${label || field} updated`
        + (d.already ? ` · ${d.already} already were` : '')
        + (d.skipped ? ` · ${d.skipped} skipped` : '')
        + (d.relinked ? ` · ${d.relinked} relinked to a release` : ''),
        false,
        rec ? () => revertBulk(rec) : null)
      setBulkPanel(null); setBulkValue('')
      await fetchEntries({ silent: true })
    } catch (err) {
      showToast(err.response?.data?.error || err.message, true)
    } finally { setBulkBusy(false) }
  }

  // ── "One payment": mark the selection as invoices paid TOGETHER ────────────
  //
  // John: "when 2 invoices are sent in one payment, how can I make note of this
  // when uploading their invoices so it's an easy match when statements are
  // uploaded?" This is the route for the ones already in the ledger — 465
  // same-payee-same-date groups of 2+ invoices are sitting here unconnected —
  // and the only way to correct a group afterwards.
  //
  // Its OWN endpoint, not /bk/entries/bulk: that route writes one whitelisted
  // column across a selection, and a settlement group is a validated
  // relationship between rows (same vendor, family roots, 2+ members, none
  // already settled elsewhere). The server owns those rules, so the button sends
  // the ids and SHOWS whatever it says — the refusals are full sentences
  // naming the invoice at fault, which is more use than anything this file
  // could re-derive.
  const markOnePayment = async () => {
    if (selCount < 2 || bulkBusy) return
    const ids = selectedRows.map(e => e.id)
    setBulkBusy(true)
    try {
      const { data } = await api.post('/bk/settlement-groups', { expense_ids: ids })
      const d = data?.data || {}
      showToast(
        `${(d.members || ids).length} invoices marked as one payment`
        + ' — the matcher will settle a bank line that totals them exactly',
        false,
        // Undo is the inverse endpoint, not a field restore: ungrouping is the
        // only thing that reverses this, and it never touches a match.
        () => api.delete(`/bk/settlement-groups/${d.group}`)
          .then(() => fetchEntries({ silent: true }))
          .catch(err => showToast(err.response?.data?.error || err.message, true)))
      clearSelection()
      await fetchEntries({ silent: true })
    } catch (err) {
      showToast(err.response?.data?.error || err.message, true)
    } finally { setBulkBusy(false) }
  }

  // Clear a marker. Deliberately does NOT unmatch: if the group already settled
  // a bank line, that settle stands on its own link rows, and tearing it down
  // here would unreconcile a payment as a side effect of tidying a label.
  const ungroupPayment = async (group) => {
    if (bulkBusy || !group) return
    setBulkBusy(true)
    try {
      await api.delete(`/bk/settlement-groups/${group}`)
      showToast('No longer marked as one payment')
      await fetchEntries({ silent: true })
    } catch (err) {
      showToast(err.response?.data?.error || err.message, true)
    } finally { setBulkBusy(false) }
  }

  // How many live rows share each marker, so a chip can say "1 of 3" rather than
  // just "grouped". Counted off the loaded set — the group's own members are
  // always in the same ledger, so this is the whole group unless a filter hides
  // part of it, which is exactly when the count is worth showing.
  const groupSizes = useMemo(() => {
    const m = new Map()
    for (const e of entries) {
      if (!e.settlement_group) continue
      m.set(e.settlement_group, (m.get(e.settlement_group) || 0) + 1)
    }
    return m
  }, [entries])

  // Back to the top of the window whenever the visible set changes. Keyed on the
  // COUNT rather than the array so it doesn't fire on every render. ledgerView
  // is keyed explicitly because switching views can coincidentally leave the
  // count unchanged, and inheriting a grown cap would paint the whole new view.
  useEffect(() => { setRenderCap(RENDER_PAGE) }, [renderable.length, ledgerView])

  // Grow when the sentinel at the bottom of the painted rows comes into view.
  // IntersectionObserver rather than a scroll listener: no dependency, and it
  // doesn't fire on every scroll frame.
  useEffect(() => {
    const node = growSentinelRef.current
    if (!node || moreToRender <= 0) return
    const io = new IntersectionObserver((es) => {
      if (es.some(e => e.isIntersecting)) setRenderCap(c => c + RENDER_PAGE)
    }, { rootMargin: '600px' })
    io.observe(node)
    return () => io.disconnect()
  }, [moreToRender])

  // Parent lookup for fields that live on the parent only (e.g. social_handles
  // are stored on the vendor-submitted invoice; auto-split children inherit
  // nothing). Children always have their parent in `inSet` (otherwise the
  // child gets promoted to a root above), so building from `filtered` is safe.
  const entryById = {}
  filtered.forEach(e => { entryById[e.id] = e })

  // Computed from the full entries list (not filters) so the fee/reimb gate
  // doesn't accidentally enable on a hidden-parent split.
  const idsWithChildren = new Set(entries.filter(e => e.parent_id).map(e => e.parent_id))

  // Totals
  const byCurrency = {}
  filtered.forEach(e => {
    if (!e.amount) return
    const c = (e.currency || 'USD').toUpperCase()
    byCurrency[c] = (byCurrency[c] || 0) + Number(e.amount)
  })
  const sortedCurrencies = Object.keys(byCurrency).sort((a, b) => byCurrency[b] - byCurrency[a])

  // ── Column helpers ──────────────────────────────────────────────────────
  const vis = (key) => !hiddenCols.includes(key)

  function toggleCol(key) {
    const next = hiddenCols.includes(key) ? hiddenCols.filter(c => c !== key) : [...hiddenCols, key]
    setHiddenCols(next)
    localStorage.setItem(colStorageKey(bank), JSON.stringify(next))
  }

  function resetCols() {
    // Both halves share one default now. The bank half's old, narrower default
    // is the preset below rather than what Reset gives you.
    const base = loadHiddenColsDefault()
    setHiddenCols(base)
    localStorage.setItem(colStorageKey(bank), JSON.stringify(base))
  }

  // The old bank-half default, kept as a preset rather than a default. See
  // BANK_MODE_HIDDEN for the measurement behind the list.
  const applyBankTidyPreset = () => {
    const next = [...new Set([...DEFAULT_HIDDEN, ...BANK_MODE_HIDDEN])]
    setHiddenCols(next)
    localStorage.setItem(colStorageKey(bank), JSON.stringify(next))
    setColPanelOpen(false)
  }

  // The vendor-form block, all at once. Thirteen checkboxes is not a workflow —
  // you either want to see what the vendor stated or you don't. Toggles as a
  // set, and leaves the menu open so the effect is visible behind it.
  const toggleVendorFormCols = () => {
    const allShown = VENDOR_FORM_COLS.every(k => !hiddenCols.includes(k))
    const next = allShown
      ? [...new Set([...hiddenCols, ...VENDOR_FORM_COLS])]
      : hiddenCols.filter(k => !VENDOR_FORM_COLS.includes(k))
    setHiddenCols(next)
    localStorage.setItem(colStorageKey(bank), JSON.stringify(next))
  }

  // ── Interaction handlers ─────────────────────────────────────────────────
  async function cyclePayment(entry) {
    const cycle = ['Unpaid', 'Paid', 'Partial']
    const cur = entry.payment_status || 'Unpaid'
    const next = cycle[(cycle.indexOf(cur) + 1) % cycle.length]
    // ONE PUT carrying every field of the flip. Three concurrent
    // single-field PUTs each fired the server's split-family cascade and
    // raced each other — siblings could land Paid with a stale/partial
    // snapshot (e.g. no payment_date yet).
    const patch = next === 'Paid'
      ? { payment_status: next, paid_by: currentUser?.name || '', payment_date: new Date().toISOString().slice(0, 10) }
      : { payment_status: next }
    const oldValue = entry.payment_status
    try {
      const res = await api.put(`/bk/entries/${entry.id}`, patch)
      // A bank row for this payee and amount is already booked from the
      // statement, so this row is probably the second copy of one payment. The
      // mark has already gone through — this reports, it doesn't ask. Advisory
      // because a hard gate would fire on ~1 in 6 mark-paid actions, most of
      // them on recurring vendors who legitimately bill the same amount.
      const dw = res.data?.duplicate_warning
      if (dw?.count) setDupWarning({ entry, ...dw })
      // Mirror the server's split-family cascade locally — the PUT writes
      // the parent and every sibling, so an expanded family showed stale
      // status on the other rows until a refetch.
      const rootId = entry.parent_id || entry.id
      setEntries(prev => prev.map(e => (e.id === rootId || e.parent_id === rootId) ? { ...e, ...patch } : e))
      const rec = { id: entry.id, field: 'payment_status', oldValue, newValue: next, payee: entry?.payee || '' }
      setUndoStack(prev => [...prev.slice(-19), rec])
      showToast(`Updated payment_status on ${entry?.payee || 'entry'}`, false, () => revertEdit(rec))
    } catch (err) {
      showToast('Save failed: ' + (err.response?.data?.error || err.message), true)
    }
  }

  // ── Bank match: review, and fix it either way ─────────────────────────────
  //
  // An Unpaid row wearing a green dot is a contradiction — a bank transaction
  // says the money left, the ledger says it never did. There are two opposite
  // causes and therefore two opposite fixes, which is why both live here: the
  // match is wrong (unmatch it) or the match is right and nobody updated the
  // status (mark it paid). Offering only one would get it used when the other
  // was correct.
  //
  // The server gate on DELETE /statements/tx/:id/match is Admin|Superadmin —
  // NARROWER than this page, which Approvers can also use. Gate the control the
  // same way or an Approver gets a button that always 403s.
  const canUnmatch = ['Admin', 'Superadmin'].includes(currentUser?.role)
  const [matchPop, setMatchPop] = useState(null)   // { entry, rect }
  const [txMatch, setTxMatch] = useState(null)   // { t } — matching an open line
  const [incomePick, setIncomePick] = useState(null) // { t } — booking a credit
  const [rematchQuery, setRematchQuery] = useState('')
  const [rematchResults, setRematchResults] = useState([])
  const [matchBusy, setMatchBusy] = useState(false)

  // Evidence is inherited by every child through COALESCE(parent_id, id), so a
  // change has to be mirrored across the whole family — clearing only the
  // clicked row leaves siblings showing a dot for a match that no longer
  // exists. Same cascade cyclePayment does, and for the same reason.
  const patchFamily = (entry, patch) => {
    const rootId = entry.parent_id || entry.id
    setEntries(prev => prev.map(e => (e.id === rootId || e.parent_id === rootId) ? { ...e, ...patch } : e))
  }

  async function unmatchBank(entry) {
    const ev = entry?.bank_evidence
    if (!ev?.txn_id || matchBusy) return
    setMatchBusy(true)
    try {
      await api.delete(`/statements/tx/${ev.txn_id}/match`)
      patchFamily(entry, { bank_evidence: null })
      setMatchPop(null)
      // No undo offered on purpose. The server records this as a rejection so
      // the matcher never re-proposes the pair — undoing it means re-matching
      // from the statements page, which a toast button can't honestly do.
      showToast(`Unmatched ${entry.payee || 'entry'} — the bank row is back on the statements page`)
    } catch (err) {
      showToast('Unmatch failed: ' + (err.response?.data?.error || err.message), true)
    } finally { setMatchBusy(false) }
  }

  // ── Booked → matched, from the row you noticed it on ──────────────────────
  //
  // A booked row is an entry this app INVENTED from a bank line: it has a ledger
  // id and `match_method = 'created'`, but no document behind it. Turning it into
  // a real match is what /bk/statements exists for — and the Bank Ledger is where
  // you are actually looking when you realise the invoice arrived. Three answers,
  // all against routes that already exist.
  //
  // The invoice search is the SAME query Bank Matching uses:
  // `source=invoices&roots=1`. Both filters are load-bearing — without
  // `source=invoices` the box answers "which invoice settles this?" with other
  // bank lines (measured: 139 of 141 results for one vendor), and `roots=1` keeps
  // split children out, which the server would refuse anyway.
  const searchInvoices = async (q) => {
    if (!q || q.trim().length < 2) { setRematchResults([]); return }
    try {
      const res = await api.get(`/bk/entries?source=invoices&roots=1&search=${encodeURIComponent(q.trim())}`)
      setRematchResults((res.data.data || []).filter(e => !e.parent_id).slice(0, 8))
    } catch { setRematchResults([]) }
  }

  // ONE call, deliberately: /tx/:id/match refuses a booked row ("unbook it
  // first"), so doing this as unbook-then-match from the client means a failure
  // between the two deletes the ledger entry and leaves the bank row open with
  // nothing recorded. The server orders it so the failure mode is safe.
  async function rematchToInvoice(entry, invoice) {
    const ev = entry?.bank_evidence
    if (!ev?.txn_id || matchBusy) return
    setMatchBusy(true)
    try {
      await api.post(`/statements/tx/${ev.txn_id}/rematch`, { expense_id: invoice.id })
      setMatchPop(null); setRematchQuery(''); setRematchResults([])
      showToast(`Matched to ${invoice.payee}${invoice.invoice_number ? ` inv ${invoice.invoice_number}` : ''} — the booked entry is gone and the invoice is settled`)
      await fetchEntries({ silent: true })
    } catch (err) {
      showToast(err.response?.data?.error || err.message, true)
    } finally { setMatchBusy(false) }
  }

  async function unbookRow(entry) {
    const ev = entry?.bank_evidence
    if (!ev?.txn_id || matchBusy) return
    const money = Number(entry.amount ?? 0).toLocaleString('en-US', { style: 'currency', currency: entry.currency || 'USD' })
    if (!window.confirm(
      `Unbook ${entry.payee || 'this entry'} (${money})?\n\n`
      + 'The ledger entry this app created from the bank line is deleted, and the '
      + 'bank row goes back to Bank Matching as unmatched. Its spend moves to '
      + 'Unorganized on the P&L until it is booked again.')) return
    setMatchBusy(true)
    try {
      await api.post(`/statements/tx/${ev.txn_id}/unbook`)
      setMatchPop(null)
      showToast(`Unbooked ${entry.payee || 'entry'} — the bank row is open again`)
      await fetchEntries({ silent: true })
    } catch (err) {
      showToast(err.response?.data?.error || err.message, true)
    } finally { setMatchBusy(false) }
  }

  // "No invoice is ever coming for this" — the answer that lets the
  // needs-invoice queue reach zero rather than sitting at $3.26M forever. A 409
  // means the server wants a scope confirmed (a vendor or category rule it would
  // create); it comes back with candidates, so pass the confirmation through
  // rather than swallowing it.
  async function markNoInvoice(entry, confirmNew = false) {
    const ev = entry?.bank_evidence
    if (!ev?.txn_id || matchBusy) return
    setMatchBusy(true)
    try {
      const { data } = await api.post(`/statements/tx/${ev.txn_id}/no-invoice`,
        confirmNew ? { confirm_new: true } : {})
      setMatchPop(null)
      showToast(data?.data?.message || `${entry.payee || 'Entry'} marked as never needing an invoice`)
      await fetchEntries({ silent: true })
    } catch (err) {
      if (err.response?.status === 409 && !confirmNew) {
        if (window.confirm((err.response.data?.error || 'This will create a new rule.')
          + '\n\nApply it?')) return markNoInvoice(entry, true)
        setMatchBusy(false)
        return
      }
      showToast(err.response?.data?.error || err.message, true)
    } finally { setMatchBusy(false) }
  }

  // ── Answers for a bank line that has no ledger row here ───────────────────
  //
  // All four hit routes that already exist on /statements/tx/:id. After each, the
  // statement is re-read rather than patched locally: the server decides the new
  // disposition (dismissing a line can also record a rejection, booking income
  // creates an artist_income row), and a locally-guessed state that disagrees with
  // it is worse than a 250ms refetch.
  // Through the store, so ONE refetch feeds both this table and the tie-out in
  // the header above it. Two independent reads is how a band and the list under
  // it start disagreeing.
  const reloadStatement = () => reloadBankDetail()

  async function dismissTx(t, undo) {
    if (matchBusy) return
    setMatchBusy(true)
    try {
      await api.post(`/statements/tx/${t.id}/dismiss`, undo ? { undo: true } : {})
      showToast(undo
        ? `${t.payee_guess || 'Line'} is back — it needs an answer`
        : `${t.payee_guess || 'Line'} dismissed — no entry needed`)
      await reloadStatement()
      await fetchEntries({ silent: true })
    } catch (err) {
      showToast(err.response?.data?.error || err.message, true)
    } finally { setMatchBusy(false) }
  }

  // Booking a credit needs an income TYPE, and that is a live vocabulary
  // (`bk_categories` where kind='income'), not free text. The server validates
  // against it and REJECTS an unknown value rather than coercing — a typo coerced
  // to 'Other Income' would look like a successful booking onto the wrong P&L
  // line. So the page offers the real list, which is also the rule every other
  // category picker here follows: read the vocabulary, never hardcode it.
  async function bookIncomeTx(t, incomeType) {
    if (matchBusy) return
    const type = String(incomeType || '').trim()
    if (!type) { showToast('Pick an income type', true); return }
    setMatchBusy(true)
    try {
      await api.post(`/statements/tx/${t.id}/book-income`, { income_type: type })
      showToast(`${t.payee_guess || 'Credit'} booked as ${type}`)
      setIncomePick(null)
      await reloadStatement()
    } catch (err) {
      showToast(err.response?.data?.error || err.message, true)
    } finally { setMatchBusy(false) }
  }

  async function unbookIncomeTx(t) {
    if (matchBusy) return
    setMatchBusy(true)
    try {
      await api.post(`/statements/tx/${t.id}/unbook-income`)
      showToast(`Income record removed — the line is open again`)
      await reloadStatement()
    } catch (err) {
      showToast(err.response?.data?.error || err.message, true)
    } finally { setMatchBusy(false) }
  }

  // Match an OPEN line to an invoice. Same picker as the booked-row popover, and
  // the same two filters for the same reason: source=invoices because the question
  // is "which invoice settles this", and roots=1 because a split child is not an
  // invoice you can attach and the server refuses one.
  async function matchTxToInvoice(t, invoice) {
    if (matchBusy) return
    setMatchBusy(true)
    try {
      await api.post(`/statements/tx/${t.id}/match`, { expense_id: invoice.id })
      setTxMatch(null); setRematchQuery(''); setRematchResults([])
      showToast(`Matched to ${invoice.payee}${invoice.invoice_number ? ` inv ${invoice.invoice_number}` : ''}`)
      await reloadStatement()
      await fetchEntries({ silent: true })
    } catch (err) {
      showToast(err.response?.data?.error || err.message, true)
    } finally { setMatchBusy(false) }
  }

  async function markPaidFromBank(entry) {
    const ev = entry?.bank_evidence
    if (!ev || matchBusy) return
    // The BANK's date, not today's. The whole premise here is that the
    // statement knows when the payment happened; stamping today would record a
    // date we already know is wrong and file the expense in the wrong P&L
    // month. This is the one deliberate difference from cyclePayment.
    const date = String(ev.txn_date || '').slice(0, 10)
    if (!date) { showToast('That match has no transaction date', true); return }
    const patch = { payment_status: 'Paid', paid_by: currentUser?.name || '', payment_date: date }
    const oldValue = entry.payment_status
    setMatchBusy(true)
    try {
      await api.put(`/bk/entries/${entry.id}`, patch)
      patchFamily(entry, patch)
      setMatchPop(null)
      const rec = { id: entry.id, field: 'payment_status', oldValue, newValue: 'Paid', payee: entry?.payee || '' }
      setUndoStack(prev => [...prev.slice(-19), rec])
      showToast(`Marked ${entry.payee || 'entry'} paid ${date} (bank date)`, false, () => revertEdit(rec))
    } catch (err) {
      showToast('Save failed: ' + (err.response?.data?.error || err.message), true)
    } finally { setMatchBusy(false) }
  }

  function toggleGroup(id) {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleNotes(id, e) {
    e.stopPropagation()
    setExpandedNotes(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // ── Shared styles ─────────────────────────────────────────────────────────
  const selectSty = {
    background: C.selectBg, border: `1.5px solid ${C.border}`, borderRadius: 7,
    padding: '6px 10px', color: C.text, fontSize: 13, fontFamily: 'inherit',
    outline: 'none', cursor: 'pointer',
  }
  // Compact variant for the toolbar's second row — the nine filter selects
  // read as one quiet strip under the search/sort row instead of a wall of
  // full-size controls wrapping raggedly.
  const filterSty = {
    ...selectSty, fontSize: 12, padding: '4px 8px', borderWidth: 1,
    color: C.textMuted, background: 'transparent',
  }
  const toolbarBtn = {
    background: 'none', border: `1.5px solid ${C.border}`, color: C.textMuted,
    padding: '6px 12px', borderRadius: 7, fontSize: 13, fontWeight: 600,
    fontFamily: 'inherit', cursor: 'pointer',
  }
  const TH = {
    background: C.thBg, color: C.thText, fontSize: 10, fontWeight: 800,
    letterSpacing: '0.07em', textTransform: 'uppercase', padding: '10px 12px',
    textAlign: 'left', borderBottom: `1px solid ${C.thBorder}`, whiteSpace: 'nowrap',
    position: 'sticky', top: 0, zIndex: 1,
  }
  // position: relative on every TD so that the focused-input expansion (below) can
  // anchor a position: absolute overlay to the cell.
  const TD = { padding: '10px 12px', verticalAlign: 'middle', borderBottom: `1px solid ${C.tdBorder}`, position: 'relative' }

  // Frozen columns rendered as ONE <td> with internal flex layout.
  // Single cell = single opaque background = no gaps for content to bleed through.
  // `flag` is a compact chip column on the far left — width just enough for
  // the amber circle + a little breathing room; header slot is empty.
  // `pick` is the bulk-selection checkbox. It lives INSIDE the single frozen
  // <td> like every other frozen column — that cell holds Date/Payee/Artist/
  // Amount/Currency in ONE <td> with an internal flex layout precisely to avoid
  // sub-pixel gaps between sticky cells, and splitting it back out is the one
  // thing this table's layout must not do.
  // payee went 120 → 138 for the vendor-page icon (a 15px box plus the cell's
  // gap). CHANGE a value here, never ADD a key: frozenTotal below and the TOTAL
  // row's two spanning widths are both arithmetic over FW, so a widened column
  // propagates to the header, the rows and the footer on its own — a new key
  // has to be added to all three or the footer stops lining up.
  const FW = { pick: 26, flag: 34, date: 100, payee: 138, artist: 90, amount: 100, currency: 52 }
  const frozenTotal = FW.pick + FW.flag + FW.date + FW.payee + FW.artist + FW.amount + (vis('Currency') ? FW.currency : 0)
  // position: relative so a focused-input expansion (position: absolute) inside
  // a frozen column anchors to the fCell rather than skipping up to the sticky <td>.
  const fCell = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '0 8px', display: 'flex', alignItems: 'center', flexShrink: 0, position: 'relative' }
  const inlineSelect = {
    border: 'none', background: 'transparent',
    fontSize: 12, color: C.textMuted, padding: '1px 2px',
    outline: 'none', cursor: 'pointer', fontFamily: 'inherit',
    appearance: 'none', WebkitAppearance: 'none',
  }
  const inlineInput = {
    border: 'none', background: 'transparent',
    fontSize: 13, color: C.text, padding: '1px 2px', width: '100%',
    outline: 'none', fontFamily: 'inherit',
  }
  const inlineInputFocus = { background: C.inputFocus, borderRadius: 3, boxShadow: `0 0 0 1px ${RED}22` }

  // Expand a truncated cell input on focus so long values stay readable.
  // Position the input absolutely (so it can overflow the cell width) and lift
  // the immediate parent's overflow:hidden so the absolute child isn't clipped.
  // Restore both on blur. parentElement is the TD for most columns and the
  // frozen-column fCell div for Payee/Artist — both have position: relative
  // so the absolute input anchors where it was rather than jumping.
  const inlineFocusExpand = (e, width = 320) => {
    Object.assign(e.target.style, inlineInputFocus)
    e.target.style.width = `${width}px`
    e.target.style.position = 'absolute'
    e.target.style.zIndex = '10'
    const parent = e.target.parentElement
    if (parent) {
      parent.dataset.prevOverflow = parent.style.overflow || ''
      parent.style.overflow = 'visible'
    }
  }
  const inlineBlurCollapse = (e) => {
    e.target.style.background = 'transparent'
    e.target.style.boxShadow = 'none'
    e.target.style.width = ''
    e.target.style.position = ''
    e.target.style.zIndex = ''
    const parent = e.target.parentElement
    if (parent) {
      parent.style.overflow = parent.dataset.prevOverflow || ''
      delete parent.dataset.prevOverflow
    }
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '24rem' }}>
        <div style={{ textAlign: 'center' }}>
          <Loader style={{ width: 28, height: 28, color: RED, margin: '0 auto 8px', animation: 'spin 0.8s linear infinite' }} />
          <p style={{ color: '#777', fontSize: 14 }}>Loading entries…</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    )
  }

  // ── Mobile card view (<768px) — separate render branch, same state ──────
  // The desktop table below is untouched. Cards render from the same
  // `flat` list (split children fold under their expanded parent), and the
  // ?focus= effect finds cards via the same data-entry-id attribute.
  if (isMobileView) {
    const sheetEntry = sheetEntryId != null ? entries.find(e => e.id === sheetEntryId) : null
    const mobileFilters = [amountQuery, filterQB, filterRecoup, filterCat, filterArtist, filterPaid, filterMethod, filterFlag, filterBulk, filterSource]
    const mobileActiveFilters = mobileFilters.filter(Boolean).length
    const childCountOf = (id) => (childrenOf[id] || []).length
    // Same visibility rule as the desktop rows: children render only when
    // their parent's group is expanded.
    const visibleRows = flat.filter(e => {
      const isChild = e.parent_id && inSet.has(e.parent_id)
      return !isChild || expandedGroups.has(e.parent_id)
    })
    // A ?focus= target beyond the pagination window must still render or
    // the deep-link scroll finds nothing — stretch the window to reach it.
    let effectiveCount = mobileVisibleCount
    if (focusId != null) {
      const idx = visibleRows.findIndex(e => e.id === focusId)
      if (idx >= effectiveCount) effectiveCount = idx + 10
    }
    const pagedRows = visibleRows.slice(0, effectiveCount)

    const mobileSelectCls = 'w-full py-2.5 px-3 rounded-xl border border-rule bg-card text-[13px] text-ink outline-none'
    const viewEntryFile = (type) => {
      if (!sheetEntry) return
      const fileEntryId = type === 'w9' ? (sheetEntry.w9_entry_id || sheetEntry.id) : sheetEntry.id
      const token = localStorage.getItem('token')
      setPreviewFile({ url: `${apiBase}/bk/entries/${fileEntryId}/file/${type}?token=${token}`, filename: `${type}-${sheetEntry.id}` })
    }

    return (
      <div style={{ minHeight: '100%', background: C.pageBg }} className="px-3 pt-4 pb-24">
        <h1 className="text-xl font-extrabold text-ink mb-0.5">{bank ? 'Bank Ledger' : 'Ledger'}</h1>
        <p className="text-xs text-gray-500 mb-2">
          {filtered.length} of {entries.length} entries
          {sortedCurrencies.length > 0 && (
            <> · {sortedCurrencies.map(c => fmt(byCurrency[c], c)).join(' + ')}</>
          )}
        </p>
        {/* Same coarse cut as the desktop toolbar. Scrolls on narrow screens
            rather than wrapping — three segments read as one control. */}
        {showViewSwitch && (
          <div className="mb-3 -mx-3 px-3 overflow-x-auto">
            <LedgerViewSwitch
              value={ledgerView}
              onChange={setLedgerView}
              counts={viewCounts}
              C={C}
              isDark={isDark}
            />
          </div>
        )}

        {/* Search / Filters / Undo */}
        <div className="sticky top-0 z-20 -mx-3 px-3 py-2 flex gap-2" style={{ background: C.pageBg }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search payee, artist, song, invoice #…"
            className="flex-1 min-w-0 px-3 py-2.5 rounded-xl border border-rule bg-card text-[13px] text-ink outline-none"
          />
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
          {undoStack.length > 0 && (
            <button
              onClick={handleUndo}
              className="shrink-0 px-3 py-2.5 rounded-xl border border-rule bg-card text-gray-600"
              title={`Undo: ${undoStack[undoStack.length - 1]?.field} on ${undoStack[undoStack.length - 1]?.payee}`}
            >
              <Undo2 size={15} />
            </button>
          )}
        </div>

        {/* Card list */}
        <div className="flex flex-col gap-2 mt-2">
          {pagedRows.length === 0 && (
            <div className="text-center text-sm text-gray-400 py-12">No entries match the current filters.</div>
          )}
          {pagedRows.map(e => {
            const isChild = !!(e.parent_id && inSet.has(e.parent_id))
            return (
              <LedgerCard
                key={e.id}
                entry={e}
                isChild={isChild}
                splitCount={childCountOf(e.id)}
                expanded={expandedGroups.has(e.id)}
                focused={focusId === e.id}
                inPlan={planIds.has(e.id)}
                fmt={fmt}
                onOpen={() => setSheetEntryId(e.id)}
                onCyclePaid={() => cyclePayment(e)}
                onToggleGroup={() => toggleGroup(e.id)}
              />
            )
          })}
          {visibleRows.length > effectiveCount && (
            <button
              onClick={() => setMobileVisibleCount(effectiveCount + 100)}
              className="py-3 rounded-xl border border-rule bg-card text-[13px] font-bold text-gray-600"
            >
              Load more ({visibleRows.length - effectiveCount} remaining)
            </button>
          )}
        </div>

        {/* Filters drawer — the full desktop filter set, stacked */}
        <FilterSheet
          open={filtersOpen}
          onClose={() => setFiltersOpen(false)}
          activeCount={mobileActiveFilters}
          onClearAll={() => { setAmountQuery(''); setFilterQB(''); setFilterRecoup(''); setFilterCat(''); setFilterArtist(''); setFilterPaid(''); setFilterMethod(''); setFilterFlag(''); setFilterBulk(''); setFilterSource('') }}
        >
          <FilterField label="Amount">
            <input
              value={amountQuery}
              onChange={e => setAmountQuery(e.target.value)}
              placeholder={'e.g. 500, 500-1000, >250'}
              className={mobileSelectCls}
            />
          </FilterField>
          <FilterField label="Artist">
            <select value={filterArtist} onChange={e => setFilterArtist(e.target.value)} className={mobileSelectCls}>
              <option value="">All artists</option>
              {allArtists.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </FilterField>
          <FilterField label="Category">
            <select value={filterCat} onChange={e => setFilterCat(e.target.value)} className={mobileSelectCls}>
              <option value="">All categories</option>
              {allCats.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </FilterField>
          <FilterField label="Payment status">
            <select value={filterPaid} onChange={e => setFilterPaid(e.target.value)} className={mobileSelectCls}>
              <option value="">All payments</option>
              <option value="Unpaid">Unpaid</option>
              <option value="Partial">Partial</option>
              <option value="Paid">Paid</option>
            </select>
          </FilterField>
          <FilterField label="Payment method">
            <select value={filterMethod} onChange={e => setFilterMethod(e.target.value)} className={mobileSelectCls}>
              <option value="">All methods</option>
              {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </FilterField>
          <FilterField label="Recoupable">
            <select value={filterRecoup} onChange={e => setFilterRecoup(e.target.value)} className={mobileSelectCls}>
              <option value="">All Recoup</option>
              <option value="Yes">Recoupable</option>
              <option value="No">Not Recoupable</option>
            </select>
          </FilterField>
          <FilterField label="QuickBooks">
            <select value={filterQB} onChange={e => setFilterQB(e.target.value)} className={mobileSelectCls}>
              <option value="">All QB</option>
              <option value="No">QB — Pending</option>
              <option value="Yes">QB — Done</option>
            </select>
          </FilterField>
          <FilterField label="Flags">
            <select value={filterFlag} onChange={e => setFilterFlag(e.target.value)} className={mobileSelectCls}>
              <option value="">All flags</option>
              <option value="Yes">Flagged only</option>
              <option value="No">Unflagged only</option>
            </select>
          </FilterField>
          <FilterField label="Bulk deals">
            <select value={filterBulk} onChange={e => setFilterBulk(e.target.value)} className={mobileSelectCls}>
              <option value="">All deals</option>
              <option value="Yes">Bulk deals only</option>
              <option value="No">Non-bulk only</option>
            </select>
          </FilterField>
          <FilterField label="Source">
            <select value={filterSource} onChange={e => setFilterSource(e.target.value)} className={mobileSelectCls}>
              <option value="">All sources</option>
              {SOURCE_BUCKETS.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
            </select>
          </FilterField>
          <FilterField label="Sort">
            <select
              value={`${sortField}:${sortDir}`}
              onChange={e => { const [f, d] = e.target.value.split(':'); setSortField(f); setSortDir(d) }}
              className={mobileSelectCls}
            >
              <option value="invoice_date:desc">Date: newest</option>
              <option value="invoice_date:asc">Date: oldest</option>
              <option value="scheduled_payment_date:asc">Due date: soonest</option>
              <option value="scheduled_payment_date:desc">Due date: latest</option>
              <option value="payment_date:desc">Paid: latest</option>
              <option value="payment_date:asc">Paid: earliest</option>
              <option value="created_at:desc">Uploaded: newest</option>
              <option value="created_at:asc">Uploaded: oldest</option>
            </select>
          </FilterField>
        </FilterSheet>

        {/* Entry detail drawer */}
        <LedgerEntrySheet
          entry={sheetEntry}
          onClose={() => setSheetEntryId(null)}
          fmt={fmt}
          onCyclePaid={() => sheetEntry && cyclePayment(sheetEntry)}
          savingNotes={mobileNotesSaving}
          onSaveNotes={async (val) => {
            if (!sheetEntry) return
            setMobileNotesSaving(true)
            try { await saveField(sheetEntry.id, 'notes', val) } finally { setMobileNotesSaving(false) }
          }}
          onToggleFlag={(next, reason) => sheetEntry && toggleFlag(sheetEntry.id, next, reason ?? null)}
          onSaveFlagReason={(reason) => sheetEntry && saveFlagReason(sheetEntry.id, reason)}
          onViewFile={viewEntryFile}
        />

        {/* Toast — above the BottomNav */}
        {toast && (
          <div
            className="fixed left-3 right-3 bottom-20 sm:bottom-6 z-[80] rounded-xl px-4 py-3 text-white text-[13px] font-semibold flex items-center gap-3 shadow-2xl"
            style={{ background: toast.isError ? '#dc2626' : toast.undoFn ? '#111' : '#16a34a', marginBottom: 'env(safe-area-inset-bottom)' }}
          >
            <span className="flex-1">{toast.msg}</span>
            {toast.undoFn && (
              <button
                onClick={() => { toast.undoFn(); setToast(null) }}
                className="px-3 py-1 rounded-lg bg-white/20 text-white text-[12px] font-bold"
              >
                Undo
              </button>
            )}
          </div>
        )}

        {/* File preview modal (same component as desktop) */}
        {previewFile && (
          <FilePreview
            url={previewFile.url}
            filename={previewFile.filename}
            files={previewFile.files}
            onClose={() => setPreviewFile(null)}
          />
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.pageBg, fontSize: 14 }}>

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div style={{
        padding: '10px 16px', display: 'flex', gap: 12, alignItems: 'flex-start',
        justifyContent: 'space-between', borderBottom: `1px solid ${C.border}`,
        background: C.cardBg, flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 10,
      }}>
        {/* Left: two stacked rows — primary controls, then a quiet filter strip */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            style={{ ...selectSty, width: 230 }}
            placeholder="Search payee, artist, song, invoice #…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onFocus={e => { e.target.style.borderColor = RED; e.target.style.background = '#fff' }}
            onBlur={e  => { e.target.style.borderColor = C.border; e.target.style.background = C.selectBg }}
          />
          {/* Amount filter — accepts an exact amount (e.g. "500"), a
              range ("500-1000"), or a comparison (">500", "<=250").
              amountMatcher returns null for invalid input, so a typo
              becomes "no filter" instead of "zero rows". */}
          <input
            style={{
              ...selectSty,
              width: 130,
              borderColor: amountQuery && !amountMatcher ? '#f59e0b' : C.border,
            }}
            placeholder="Amount: 500 or >1000"
            value={amountQuery}
            onChange={e => setAmountQuery(e.target.value)}
            onFocus={e => { e.target.style.borderColor = RED; e.target.style.background = '#fff' }}
            onBlur={e  => { e.target.style.borderColor = amountQuery && !amountMatcher ? '#f59e0b' : C.border; e.target.style.background = C.selectBg }}
            title={
              amountQuery && !amountMatcher
                ? 'Unrecognized amount query — supports "500", "500-1000", ">500", "<=250"'
                : 'Filter by amount. Accepts 500 · 500-1000 · >500 · <=250'
            }
          />
          <select style={selectSty} value={`${sortField}:${sortDir}`} onChange={e => {
            const [f, d] = e.target.value.split(':')
            setSortField(f)
            setSortDir(d)
          }}>
            <option value="invoice_date:desc">Date: newest</option>
            <option value="invoice_date:asc">Date: oldest</option>
            <option value="scheduled_payment_date:asc">Due date: soonest</option>
            <option value="scheduled_payment_date:desc">Due date: latest</option>
            <option value="payment_date:desc">Paid: latest</option>
            <option value="payment_date:asc">Paid: earliest</option>
            <option value="created_at:desc">Uploaded: newest</option>
            <option value="created_at:asc">Uploaded: oldest</option>
          </select>
        </div>
        {/* Filter strip */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Leads the strip: the coarse cut comes before the fine filters,
              and its counts show the ledger's composition at a glance. */}
          {showViewSwitch && (
            <>
              <LedgerViewSwitch
                value={ledgerView}
                onChange={setLedgerView}
                counts={viewCounts}
                C={C}
                isDark={isDark}
              />
              <div style={{ width: 1, height: 22, background: C.border, flexShrink: 0 }} />
            </>
          )}
          {/* The statement lens. Bank half only — a month-of-the-account view over
              the invoiced ledger would be answering a question that page is not
              asked. Blank = every statement, which is how the page behaved before
              this existed. */}
          {bank && (
            <>
              {/* The statement picker lives in the Banking header above, not
                  here: it scopes all four tabs, and two selectors for one
                  choice is what made these pages read as two. */}
              {/* Out · In · Both. A bank ledger that shows only debits cannot
                  answer "what came in", and 523 credits worth $6,064,037 were
                  invisible here. Only offered with a statement selected, because
                  the credit side is transaction-driven and the ledger fetch has
                  no credits in it at all. */}
              {stmtId && (
                <span style={{ display: 'inline-flex', border: `1px solid ${C.border}`, borderRadius: 7, overflow: 'hidden' }}>
                  {[['out', 'Out'], ['in', 'In'], ['both', 'Both']].map(([k, label]) => (
                    <button key={k} type="button" onClick={() => setDirection(k)}
                      title={k === 'out' ? 'Money leaving the account'
                        : k === 'in' ? 'Money arriving — credits, refunds, royalty income'
                        : 'Both directions, subtotalled separately'}
                      style={{
                        padding: '4px 9px', fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                        cursor: 'pointer', border: 'none',
                        background: direction === k ? RED : 'transparent',
                        color: direction === k ? '#fff' : C.textMuted,
                      }}>
                      {label}
                    </button>
                  ))}
                </span>
              )}
              <div style={{ width: 1, height: 22, background: C.border, flexShrink: 0 }} />
            </>
          )}
          <select style={filterSty} value={filterQB}     onChange={e => setFilterQB(e.target.value)}>
            <option value="">All QB</option>
            <option value="No">QB — Pending</option>
            <option value="Yes">QB — Done</option>
          </select>
          <select style={filterSty} value={filterRecoup}   onChange={e => setFilterRecoup(e.target.value)}>
            <option value="">All Recoup</option>
            <option value="Yes">Recoupable</option>
            <option value="No">Not Recoupable</option>
          </select>
          {/* Flag filter — mirrors the shape of All Recoup so the toolbar
              stays visually consistent. "Flagged" is the primary use case;
              "Unflagged" is included for completeness. */}
          <select
            style={{
              ...filterSty,
              ...(filterFlag === 'Yes' ? { borderColor: '#f59e0b', color: '#b45309', fontWeight: 700 } : null),
            }}
            value={filterFlag}
            onChange={e => setFilterFlag(e.target.value)}
            title="Filter by flag-for-review status"
          >
            <option value="">All flags</option>
            <option value="Yes">Flagged only</option>
            <option value="No">Unflagged only</option>
          </select>
          {/* Filter by row origin — options, order and tint all come from
              SOURCE_BUCKETS, so this list can't fall behind the column. */}
          <select
            style={{
              ...filterSty,
              ...(filterSource ? { ...sourceBucket(filterSource).tint, fontWeight: 700 } : null),
            }}
            value={filterSource}
            onChange={e => setFilterSource(e.target.value)}
            title="Filter by where the row was created"
          >
            <option value="">All sources</option>
            {SOURCE_BUCKETS.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
          </select>
          {/* Bulk-deal filter — matches the teal Bulk key in the Source
              column. Tints when active, same pattern as the others. */}
          <select
            style={{
              ...filterSty,
              ...(filterBulk === 'Yes' ? { borderColor: '#0d9488', color: '#0f766e', fontWeight: 700 } : null),
            }}
            value={filterBulk}
            onChange={e => setFilterBulk(e.target.value)}
            title="Filter bulk deals"
          >
            <option value="">All deals</option>
            <option value="Yes">Bulk deals only</option>
            <option value="No">Non-bulk only</option>
          </select>
          <select style={filterSty} value={filterCat}    onChange={e => setFilterCat(e.target.value)}>
            <option value="">All categories</option>
            {allCats.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <SearchableSelect
            value={filterArtist}
            onChange={setFilterArtist}
            options={allArtists}
            placeholder="All artists"
            allLabel="All artists"
            style={filterSty}
          />
          <select style={filterSty} value={filterPaid}   onChange={e => setFilterPaid(e.target.value)}>
            <option value="">All payments</option>
            <option value="Unpaid">Unpaid</option>
            <option value="Partial">Partial</option>
            <option value="Paid">Paid</option>
          </select>
          <select style={filterSty} value={filterMethod} onChange={e => setFilterMethod(e.target.value)}>
            <option value="">All methods</option>
            {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          <span style={{ color: '#777', fontSize: 12, whiteSpace: 'nowrap' }}>
            {filtered.length} of {entries.length}
          </span>
          {/* WHICH HALF, and the door to the other one.
              The ledger used to hold both kinds of row, so after the split its
              total drops by $3.6M and the Bank Ledger's count appears from
              nowhere. Without a line saying which half you are standing in, the
              honest reaction to either page is "where did my rows go?" — so each
              names itself and points at the other. */}
          <a
            href={bank ? '/bk/ledger' : '/bk/bank-ledger'}
            title={bank
              ? 'These are the entries the app created from bank lines — nobody invoiced us for them. The invoiced ledger is the other half.'
              : 'These are the invoiced entries. The entries created from bank lines live in the Bank Ledger.'}
            style={{ color: '#777', fontSize: 12, whiteSpace: 'nowrap', textDecoration: 'none', fontWeight: 600 }}
            onMouseEnter={e => { e.currentTarget.style.color = '#111'; e.currentTarget.style.textDecoration = 'underline' }}
            onMouseLeave={e => { e.currentTarget.style.color = '#777'; e.currentTarget.style.textDecoration = 'none' }}
          >
            {bank ? 'from bank lines · invoiced ledger →' : 'invoiced · bank ledger →'}
          </a>
          <div style={{ width: 1, height: 20, background: '#e2e2e2' }} />
          {undoStack.length > 0 && (
            <button
              style={{ ...toolbarBtn, display: 'flex', alignItems: 'center', gap: 4 }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = '#6366f1'; e.currentTarget.style.color = '#6366f1' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#e2e2e2'; e.currentTarget.style.color = '#777' }}
              onClick={handleUndo}
              title={`Undo: ${undoStack[undoStack.length - 1]?.field} on ${undoStack[undoStack.length - 1]?.payee}`}
            >
              <Undo2 style={{ width: 13, height: 13 }} /> Undo
            </button>
          )}
          <button
            style={toolbarBtn}
            onMouseEnter={e => { e.currentTarget.style.borderColor = RED; e.currentTarget.style.color = RED }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#e2e2e2'; e.currentTarget.style.color = '#777' }}
            onClick={() => { setSearch(''); setAmountQuery(''); setFilterQB(''); setFilterRecoup(''); setFilterCat(''); setFilterArtist(''); setFilterPaid(''); setFilterMethod(''); setFilterFlag(''); setFilterSource(''); setFilterBulk('') }}
          >
            Clear
          </button>

          {/* Export menu — the four admin downloads behind one button */}
          {isAdmin && (
            <div style={{ position: 'relative' }} ref={exportMenuRef}>
              <button
                style={{ ...toolbarBtn, display: 'flex', alignItems: 'center', gap: 4, ...(exportMenuOpen ? { borderColor: '#16a34a', color: '#16a34a' } : null) }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#16a34a'; e.currentTarget.style.color = '#16a34a' }}
                onMouseLeave={e => { if (!exportMenuOpen) { e.currentTarget.style.borderColor = '#e2e2e2'; e.currentTarget.style.color = '#777' } }}
                onClick={() => setExportMenuOpen(v => !v)}
              >
                <Download style={{ width: 13, height: 13 }} /> Export <ChevronDown style={{ width: 12, height: 12 }} />
              </button>
              {exportMenuOpen && (
                <div style={{
                  position: 'absolute', right: 0, top: 'calc(100% + 6px)',
                  background: C.cardBg, border: `1.5px solid ${C.border}`, borderRadius: 10,
                  boxShadow: '0 8px 32px rgba(0,0,0,.14)', zIndex: 200, minWidth: 190, overflow: 'hidden',
                }}>
                  {[
                    // Excel and CSV carry the page's own half via ?source=.
                    // The two ZIPs deliberately do NOT: they bundle invoice and
                    // W9 FILES, and a bank-created entry has neither, so on this
                    // half they are hidden rather than offered as empty archives.
                    { label: `${bank ? 'Bank ledger' : 'Ledger'} — Excel`, path: '/bk/export', source: true,
                      title: bank
                        ? 'The bank-created entries as .xlsx — the rows nobody invoiced us for'
                        : 'The invoiced ledger as .xlsx — opens in Excel, imports cleanly into Google Sheets' },
                    { label: `${bank ? 'Bank ledger' : 'Ledger'} — CSV`, path: '/bk/export-csv', source: true,
                      title: bank ? 'The bank-created entries as CSV' : 'The invoiced ledger as CSV' },
                    ...(bank ? [] : [
                      { label: 'Invoices ZIP', path: '/bk/export-invoices-zip', title: "Every approved invoice, files named '<Payee> - <Date> - <Invoice #>'" },
                      { label: 'W9s ZIP', path: '/bk/export-w9s-zip', title: "Every vendor's most recent W9/W8 — one file per vendor" },
                      // The FILTERED file download, inherited from the Expense
                      // Lookup page when it was removed. The two ZIPs above are
                      // all-or-nothing — every invoice, every W9 — and there was
                      // no way to get "the files for this artist" without them.
                      //
                      // Only the filters the SERVER understands narrow it:
                      // artist, category and the search box. The rest of this
                      // page's filters run in the browser over already-fetched
                      // rows, so passing them would be a promise the endpoint
                      // cannot keep — hence the label says which ones apply.
                      { label: 'Files ZIP — artist / category / search',
                        path: '/bk/download-files', filtered: true,
                        title: 'Invoices, proofs, W9s and receipts for the rows matching the artist, category and search filters above. The other filters are applied in the browser and do not narrow this.' },
                    ]),
                  ].map(item => (
                    <button
                      key={item.path}
                      title={item.title}
                      onClick={() => {
                        const token = localStorage.getItem('token')
                        const q = new URLSearchParams({ token })
                        if (item.source) q.set('source', bank ? 'bank' : 'invoices')
                        if (item.filtered) {
                          if (filterArtist) q.set('artist', filterArtist)
                          if (filterCat) q.set('category', filterCat)
                          if (search.trim()) q.set('search', search.trim())
                        }
                        window.open(`${apiBase}${item.path}?${q}`, '_blank')
                        setExportMenuOpen(false)
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                        background: 'none', border: 'none', textAlign: 'left',
                        padding: '9px 14px', fontSize: 13, fontWeight: 600, color: C.text,
                        cursor: 'pointer', fontFamily: 'inherit',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = C.elevBg}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}
                    >
                      <Download style={{ width: 13, height: 13, color: '#16a34a' }} /> {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Columns panel */}
          <div style={{ position: 'relative' }} ref={colPanelRef}>
            <button
              style={toolbarBtn}
              onMouseEnter={e => { e.currentTarget.style.borderColor = RED; e.currentTarget.style.color = RED }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#e2e2e2'; e.currentTarget.style.color = '#777' }}
              onClick={() => setColPanelOpen(v => !v)}
            >
              Columns
            </button>
            {colPanelOpen && (
              <div style={{
                position: 'absolute', right: 0, top: 'calc(100% + 6px)',
                background: C.cardBg, border: `1.5px solid ${C.border}`, borderRadius: 10,
                boxShadow: '0 8px 32px rgba(0,0,0,.14)', zIndex: 200,
                minWidth: 180, maxHeight: 400, overflowY: 'auto',
              }}>
                {[...(bank ? BANK_ONLY_COLS : []), ...TOGGLEABLE_COLS].map((col, i, list) => (
                  <Fragment key={col.key}>
                    {/* A heading where the group changes. Thirteen vendor-form
                        columns dropped into a flat list of 28 would read as
                        thirteen unexplained toggles; this says what they are
                        and why they can be empty. */}
                    {col.group && col.group !== list[i - 1]?.group && (
                      <div style={{
                        padding: '10px 16px 4px', fontSize: 10, fontWeight: 800,
                        letterSpacing: '0.06em', textTransform: 'uppercase', color: C.textMuted,
                        background: C.elevBg, borderBottom: `1px solid ${C.borderLight}`,
                      }}>
                        {col.group}
                        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0, textTransform: 'none', marginTop: 2, color: C.textMuted }}>
                          Empty before 31 Aug 2026 — the form did not collect it yet
                        </div>
                      </div>
                    )}
                    <label style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '9px 16px', borderBottom: `1px solid ${C.borderLight}`,
                      fontSize: 13, cursor: 'pointer',
                    }}>
                      <input type="checkbox" checked={vis(col.key)} onChange={() => toggleCol(col.key)}
                        style={{ accentColor: RED, cursor: 'pointer' }} />
                      {col.label}
                    </label>
                  </Fragment>
                ))}
                <div style={{ padding: '10px 16px', borderTop: `1px solid ${C.borderLight}`, background: C.elevBg, borderRadius: '0 0 10px 10px', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  <button onClick={resetCols} style={{ background: 'none', border: 'none', color: RED, fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
                    Reset to default
                  </button>
                  <button onClick={toggleVendorFormCols}
                    title="Every field the vendor submit form collects that is not already a column — payment details, CC addresses, their own spelling of their name, extra files."
                    style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
                    {VENDOR_FORM_COLS.every(k => vis(k)) ? 'Hide the vendor-form columns' : 'Show everything the vendor submitted'}
                  </button>
                  {bank && (
                    <button onClick={applyBankTidyPreset}
                      title="Hide the columns no bank-created row fills. Measured on 1,972 rows: nine of them are empty on every single one."
                      style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
                      Hide what a bank row never fills
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* The tie-out — opened · in · out · closed, ✓ ties / off by $N —
          and the disposition breakdown moved into the Banking header
          above. It describes the STATEMENT, not this table, and the other
          three tabs need it just as much: keeping it here meant three of
          the four surfaces of one bank month could not tell you whether
          that month added up. See components/BankShell.jsx. */}

      {/* ── Duplicate invoices flag ──────────────────────────────────────── */}
      <DuplicateInvoicesFlag C={C} />

      {/* ── Error ────────────────────────────────────────────────────────── */}
      {error && (
        <div style={{ margin: '10px 16px 0', background: '#fef2f2', border: '1px solid #fca5a5', color: '#991b1b', padding: '10px 14px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <AlertCircle style={{ width: 16, height: 16, flexShrink: 0 }} />
          {error}
          <button onClick={() => setError('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#b45309', fontSize: 14, cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {/* A deep link that cannot land. Amber, not red: nothing is broken — the
          row is simply somewhere else, and the useful thing is saying where. */}
      {focusMissing != null && (
        <div style={{ margin: '10px 16px 0', background: '#fffbeb', border: '1px solid #fcd34d', color: '#92400e', padding: '10px 14px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <AlertCircle style={{ width: 16, height: 16, flexShrink: 0 }} />
          <span>
            Entry <strong>#{focusMissing}</strong> is not in this ledger or the {bank ? 'invoice' : 'bank'} one.
            {' '}The ledger lists <strong>approved</strong> entries, so an invoice still awaiting approval will not appear here —
            {' '}<a href="/bk/approvals" style={{ textDecoration: 'underline', fontWeight: 700 }}>check Approvals</a>.
          </span>
          <button onClick={() => setFocusMissing(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#b45309', fontSize: 14, cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {/* ── Bulk bar ─────────────────────────────────────────────────────────
          Appears only with a selection. Sticky, because a selection made at row
          800 is acted on from wherever you happen to be.

          It states the selection TWICE when the two differ — "40 selected" and
          "31 of them below the visible rows" — because select-all takes the
          filtered set while the table paints ~150 at a time, and a bar that
          reports only what is on screen while writing to everything is how this
          page has shipped a wrong total before. */}
      {selCount > 0 && (
        <div style={{
          position: 'sticky', top: 8, zIndex: 40, marginBottom: 10,
          background: C.cardBg, border: `1.5px solid ${RED}`, borderRadius: 10,
          boxShadow: '0 6px 24px rgba(0,0,0,.10)', padding: '9px 12px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: C.text }}>
              {selCount.toLocaleString()} selected
            </span>
            <span style={{ fontSize: 11.5, color: C.textFaint, fontVariantNumeric: 'tabular-nums' }}>
              {usdItemsSuffix(selectedRows, fxRates)}
            </span>
            {selectedOffscreen > 0 && (
              <span style={{ fontSize: 11, color: '#b45309' }}
                title="Selected rows the table has not painted yet. A bulk edit applies to all of them, not only what you can see.">
                {selectedOffscreen.toLocaleString()} below the visible rows
              </span>
            )}

            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
              {[
                ['artist',   'Set artist'],
                ['song',     'Set song'],
                ['category', 'Set category'],
              ].map(([key, label]) => (
                <button key={key} type="button" disabled={bulkBusy}
                  onClick={() => { setBulkPanel(bulkPanel === key ? null : key); setBulkValue('') }}
                  style={{
                    padding: '6px 10px', borderRadius: 7, fontSize: 12, fontWeight: 700,
                    fontFamily: 'inherit', cursor: 'pointer',
                    background: bulkPanel === key ? RED : 'transparent',
                    color: bulkPanel === key ? '#fff' : C.text,
                    border: `1.5px solid ${bulkPanel === key ? RED : C.border}`,
                    opacity: bulkBusy ? 0.5 : 1,
                  }}>
                  {label}
                </button>
              ))}
              {/* canUnmatch, not just `bank`: /statements/artist-rules is behind
                  isStrictAdmin, so offering this to an Approver would be a panel
                  whose every button 403s. */}
              {bank && canUnmatch && (
                <button type="button" disabled={bulkBusy}
                  onClick={() => setBulkPanel(bulkPanel === 'vendors' ? null : 'vendors')}
                  title="Answer one vendor at a time — the answer is remembered for future statements"
                  style={{
                    padding: '6px 10px', borderRadius: 7, fontSize: 12, fontWeight: 700,
                    fontFamily: 'inherit', cursor: 'pointer',
                    background: bulkPanel === 'vendors' ? RED : 'transparent',
                    color: bulkPanel === 'vendors' ? '#fff' : C.text,
                    border: `1.5px solid ${bulkPanel === 'vendors' ? RED : C.border}`,
                    opacity: bulkBusy ? 0.5 : 1,
                  }}>
                  By vendor…
                </button>
              )}
              <button type="button" disabled={bulkBusy}
                onClick={() => applyBulk('in_quickbooks', true, 'marked in QuickBooks')}
                style={{ padding: '6px 10px', borderRadius: 7, fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', background: 'transparent', color: C.text, border: `1.5px solid ${C.border}`, opacity: bulkBusy ? 0.5 : 1 }}>
                QB ✓
              </button>
              {/* Invoiced rows only. A bank-created entry is not an invoice and
                  the endpoint refuses it, so offering the button on that half
                  would be a control whose every press 400s. */}
              {!bank && (
                <button type="button" disabled={bulkBusy || selCount < 2}
                  onClick={markOnePayment}
                  title={selCount < 2
                    ? 'Select two or more invoices from the same vendor'
                    : 'These invoices were sent in ONE payment — the matcher will settle a bank line that totals them exactly'}
                  style={{ padding: '6px 10px', borderRadius: 7, fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: selCount < 2 ? 'default' : 'pointer', background: 'transparent', color: C.text, border: `1.5px solid ${C.border}`, opacity: (bulkBusy || selCount < 2) ? 0.45 : 1 }}>
                  One payment
                </button>
              )}
              <button type="button" disabled={bulkBusy}
                onClick={() => applyBulk('recoupable', false, 'marked not recoupable')}
                title="Clear the recoupable flag on these rows"
                style={{ padding: '6px 10px', borderRadius: 7, fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', background: 'transparent', color: C.text, border: `1.5px solid ${C.border}`, opacity: bulkBusy ? 0.5 : 1 }}>
                Not recoupable
              </button>
              <button type="button" onClick={clearSelection}
                style={{ padding: '6px 10px', borderRadius: 7, fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', background: 'transparent', color: C.textFaint, border: `1.5px solid transparent` }}>
                Clear
              </button>
            </div>
          </div>

          {/* One value, applied to the selection. A datalist rather than a
              select for artist and song: the vocabulary helps, but a bank
              descriptor's artist may be one nobody has typed yet. */}
          {(bulkPanel === 'artist' || bulkPanel === 'song' || bulkPanel === 'category') && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, paddingTop: 9, borderTop: `1px solid ${C.borderLight}`, flexWrap: 'wrap' }}>
              <datalist id="bulk-artists">
                {artistCatalog.map(a => <option key={a} value={a} />)}
              </datalist>
              <datalist id="bulk-songs">
                {songCatalog.all.map(sg => <option key={sg} value={sg} />)}
              </datalist>
              {bulkPanel === 'category' ? (
                <select value={bulkValue} onChange={e => setBulkValue(e.target.value)}
                  style={{ padding: '6px 8px', borderRadius: 7, fontSize: 12.5, fontFamily: 'inherit', background: C.inputBg, color: C.text, border: `1.5px solid ${C.border}`, minWidth: 200 }}>
                  <option value="">Pick a category…</option>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <input
                  list={bulkPanel === 'artist' ? 'bulk-artists' : 'bulk-songs'}
                  value={bulkValue}
                  onChange={e => setBulkValue(e.target.value)}
                  placeholder={bulkPanel === 'artist'
                    ? `Artist for all ${selCount.toLocaleString()} rows`
                    : `Song for all ${selCount.toLocaleString()} rows`}
                  style={{ flex: 1, minWidth: 220, padding: '6px 8px', borderRadius: 7, fontSize: 12.5, fontFamily: 'inherit', background: C.inputBg, color: C.text, border: `1.5px solid ${C.border}` }}
                />
              )}
              <button type="button" disabled={bulkBusy || !bulkValue.trim()}
                onClick={() => applyBulk(bulkPanel, bulkValue.trim(),
                  bulkPanel === 'artist' ? 'artist set' : bulkPanel === 'song' ? 'song set' : 'recategorized')}
                style={{ padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', background: RED, color: '#fff', border: `1.5px solid ${RED}`, opacity: (bulkBusy || !bulkValue.trim()) ? 0.5 : 1 }}>
                Apply to {selCount.toLocaleString()}
              </button>
              {bulkPanel === 'song' && (
                <span style={{ fontSize: 10.5, color: C.textFaint }}>
                  One song. A comma splits an entry per song, which stays a per-row edit.
                </span>
              )}
            </div>
          )}

          {bulkPanel === 'vendors' && (
            <BulkVendorPanel
              rows={selectedRows} C={C} RED={RED} busy={bulkBusy} setBusy={setBulkBusy}
              roster={roster}
              onDone={async () => { setBulkPanel(null); clearSelection(); await fetchEntries({ silent: true }) }}
              showToast={showToast}
            />
          )}
        </div>
      )}

      {/* ── Table ────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowX: 'auto', overflowY: 'auto' }}>
        {flat.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: '#777', fontSize: 14 }}>
            No entries found.
          </div>
        ) : (
          <table className="ledger-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {/* ── Frozen columns (single cell) ── */}
                <th style={{ ...TH, position: 'sticky', left: 0, zIndex: 3, background: C.thBg, width: frozenTotal, padding: 0, boxShadow: C.shadow }}>
                  <div style={{ display: 'flex', height: '100%' }}>
                    {/* Flag column — empty header; chip rendered per row */}
                    <div style={{ ...fCell, width: FW.pick, justifyContent: 'center', padding: 0 }}>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={el => { if (el) el.indeterminate = someSelected }}
                        onChange={toggleAll}
                        title={allSelected
                          ? 'Clear the selection'
                          : `Select all ${selectableIds.length.toLocaleString()} rows the current filters show`}
                        style={{ accentColor: RED, cursor: 'pointer' }}
                      />
                    </div>
                    <div style={{ ...fCell, width: FW.flag, justifyContent: 'center', padding: 0 }} aria-hidden="true"></div>
                    <div style={{ ...fCell, width: FW.date, cursor: 'pointer', userSelect: 'none', fontWeight: 800, fontSize: 10, color: '#9ca3af', letterSpacing: '0.07em', textTransform: 'uppercase' }}
                      onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}>
                      Date <span style={{ fontSize: 9, opacity: 0.6, marginLeft: 3 }}>{sortDir === 'desc' ? '▼' : '▲'}</span>
                    </div>
                    <div style={{ ...fCell, width: FW.payee, fontWeight: 800, fontSize: 10, color: '#9ca3af', letterSpacing: '0.07em', textTransform: 'uppercase' }}>Payee</div>
                    <div style={{ ...fCell, width: FW.artist, fontWeight: 800, fontSize: 10, color: '#9ca3af', letterSpacing: '0.07em', textTransform: 'uppercase' }}>Artist</div>
                    <div style={{ ...fCell, width: FW.amount, fontWeight: 800, fontSize: 10, color: '#9ca3af', letterSpacing: '0.07em', textTransform: 'uppercase', justifyContent: 'flex-end' }}>Amount</div>
                    {vis('Currency') && <div style={{ ...fCell, width: FW.currency, fontWeight: 800, fontSize: 10, color: '#9ca3af', letterSpacing: '0.07em', textTransform: 'uppercase' }}>Cur.</div>}
                  </div>
                </th>
                {/* ── Scrollable columns ── */}
                {vis('Description') && <th style={{ ...TH, maxWidth: 180 }}>Description</th>}
                <th style={TH}>Category</th>
                {vis('Song')        && <th style={TH}>Song</th>}
                {vis('Inv #')       && <th style={TH}>Inv #</th>}
                {/* Vendor */}
                {vis('Email')       && <th style={TH}>Email</th>}
                {vis('Address')     && <th style={{ ...TH, maxWidth: 150 }}>Address</th>}
                {vis('Bank')        && <th style={{ ...TH, maxWidth: 150 }}>Bank</th>}
                {vis('Socials')     && <th style={{ ...TH, maxWidth: 200 }}>Socials</th>}
                {vis('Market Street Rep')    && <th style={TH}>Rep</th>}
                {/* Payment */}
                {vis('Method')      && <th style={TH}>Method</th>}
                {vis('Terms')       && <th style={TH}>Terms</th>}
                {vis('Due Date')    && <th style={TH}>Due Date</th>}
                <th style={TH}>Paid?</th>
                {vis('Paid By')     && <th style={TH}>Paid By</th>}
                {vis('Date Paid')   && <th style={TH}>Date Paid</th>}
                {vis('Pay Ref')     && <th style={TH}>Pay Ref</th>}
                {/* Documents */}
                {vis('Inv')         && <th style={{ ...TH, textAlign: 'center' }}>Inv</th>}
                {vis('W9')          && <th style={{ ...TH, textAlign: 'center' }}>W9</th>}
                {vis('Proof')       && <th style={{ ...TH, textAlign: 'center' }}>Proof</th>}
                {vis('Receipt')     && <th style={{ ...TH, textAlign: 'center' }}>Receipt</th>}
                {/* Tracking */}
                {vis('Reimb?')      && <th style={TH}>Reimb?</th>}
                {vis('QB?')         && <th style={TH}>QB?</th>}
                {vis('Recoupable?') && <th style={TH}>Recoup?</th>}
                {vis('UFR?')        && <th style={TH}>UFR?</th>}
                {vis('Campaign?')   && <th style={TH}>Campaign?</th>}
                {vis('Tone Labels') && <th style={TH}>Tone Labels</th>}
                {vis('Cobrand?')    && <th style={TH}>CB?</th>}
                {vis('Bulk Deal?')  && <th style={TH}>Bulk?</th>}
                {/* Meta */}
                <th style={{ ...TH, maxWidth: 180 }}>Notes</th>
                {/* Bank-only, and only in bank mode. Where the row came from,
                    what the bank line said, and whether anyone still expects a
                    document for it. */}
                {bank && vis('Statement')   && <th style={TH}>Statement</th>}
                {bank && vis('Bank line')   && <th style={TH}>Bank line</th>}
                {bank && vis('Inv wanted?') && <th style={{ ...TH, textAlign: 'center' }}>Inv wanted?</th>}
                {vis('Source')      && <th style={TH}>Source</th>}
                {vis('Approved By') && <th style={TH}>Appr. By</th>}
                {vis('Uploaded')    && <th style={TH}>Uploaded</th>}
                {/* What the vendor typed on the submit form. Last, because they
                    are answers about the counterparty rather than the invoice —
                    and all default off. */}
                {vis('Vendor Name')   && <th style={TH}>Vendor Name</th>}
                {vis('CC Emails')     && <th style={TH}>CC Emails</th>}
                {vis('Acct Type')     && <th style={TH}>Acct Type</th>}
                {vis('Acct Holder')   && <th style={TH}>Name on Acct</th>}
                {vis('Acct Last4')    && <th style={TH}>Acct ••</th>}
                {vis('Wire Scope')    && <th style={TH}>Wire</th>}
                {vis('Bank Address')  && <th style={TH}>Bank Addr</th>}
                {vis('Benef Address') && <th style={TH}>Benef. Addr</th>}
                {vis('Intermediary')  && <th style={TH}>Intermediary</th>}
                {vis('PayPal')        && <th style={TH}>PayPal</th>}
                {vis('Pay Check')     && <th style={TH}>Details vs Inv</th>}
                {vis('Off Roster?')   && <th style={TH}>Off Roster?</th>}
                {vis('Attachments')   && <th style={{ ...TH, textAlign: 'center' }}>Files</th>}
                <th style={TH}></th>
              </tr>
            </thead>
            <tbody>
              {shown.map(entry => {
                const children  = childrenOf[entry.id] || []
                const isParent  = children.length > 0
                const isChild   = !!entry.parent_id && inSet.has(entry.parent_id)
                const visible   = !isChild || expandedGroups.has(entry.parent_id)
                if (!visible) return null

                const rowBg = isChild ? C.rowChild : isParent ? C.rowParent : C.rowBg
                const rowHover = isChild ? (isDark ? '#22253a' : '#eceeff') : isParent ? (isDark ? '#1e2138' : '#f0f1ff') : C.rowHover

                const isFocused = focusId === entry.id
                return (
                  <tr
                    key={entry.id}
                    data-entry-id={entry.id}
                    style={{
                      // Focused deep-link row: subtle amber wash + a 4px
                      // inset amber rail on the left. Kept gentle (not
                      // shouty) since the highlight is now persistent —
                      // a rep can scroll around the ledger and jump back
                      // to it easily. The rail is the primary anchor;
                      // the wash is a soft secondary cue.
                      background: isFocused ? (isDark ? '#2f2717' : '#fffbeb') : rowBg,
                      boxShadow: isFocused ? 'inset 4px 0 0 #f59e0b' : undefined,
                      transition: 'background 0.3s',
                      cursor: isParent ? 'pointer' : undefined,
                      borderTop:  isParent ? '2px solid #c7d2fe' : undefined,
                      // Voided rows are dimmed + struck through so they read as
                      // archived without dropping off the ledger.
                      opacity: entry.voided ? 0.55 : undefined,
                      textDecoration: entry.voided ? 'line-through' : undefined,
                    }}
                    // Skip the hover-tint override while the row is
                    // in the focus spotlight — otherwise the mouseenter
                    // handler clobbers the amber wash.
                    onMouseEnter={e => { if (!isFocused) e.currentTarget.style.background = rowHover }}
                    onMouseLeave={e => { if (!isFocused) e.currentTarget.style.background = rowBg }}
                    onClick={isParent ? () => toggleGroup(entry.id) : undefined}
                    title={entry.voided ? `Voided${entry.voided_by ? ` by ${entry.voided_by}` : ''} — excluded from the Payment Dashboard` : undefined}
                  >
                    {/* ── Frozen columns (single cell, no gaps) ── */}
                    {/* Left-border accent — 3px stripe on the frozen cell
                        marks rows that were born on the Recoupments or
                        Artist Campaigns page. Purple = Recoupments, indigo
                        = Campaigns. Same palette the Source badge uses so
                        the two signals agree at a glance. Falls through to
                        the existing 2px parent border for split parents so
                        the split visual isn't clobbered. */}
                    <td style={{
                      padding: 0, position: 'sticky', left: 0, zIndex: 1,
                      // Frozen cell inherits the focus-spotlight amber
                      // when the row is in focus — otherwise the sticky
                      // <td>'s opaque background paints over the amber
                      // wash on the <tr>. Kept as the softer amber-50
                      // tone to match the <tr>-level tint.
                      background: isFocused ? (isDark ? '#2f2717' : '#fffbeb') : rowBg,
                      borderBottom: `1px solid ${C.tdBorder}`,
                      boxShadow: C.shadow,
                      borderLeft: entry.entry_source === 'recoupments'
                        ? '6px solid #a855f7'
                        : entry.entry_source === 'artist_campaigns'
                          ? '6px solid #6366f1'
                          : undefined,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', minHeight: 40 }}>
                        {/* Bulk-selection checkbox. stopPropagation because the
                            row itself is clickable — on a split parent a click
                            toggles the group open. */}
                        <div style={{ ...fCell, width: FW.pick, justifyContent: 'center', padding: 0 }}
                          onClick={e => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selected.has(entry.id)}
                            onChange={e => { e.stopPropagation(); toggleRow(entry.id) }}
                            title="Select for a bulk edit"
                            style={{ accentColor: RED, cursor: 'pointer' }}
                          />
                        </div>
                        {/* Flag-for-review chip. alwaysVisible so the outlined
                            state sits inline like the other action affordances;
                            popover is portaled so the sticky <td>'s clipping
                            can't hide it. */}
                        <div style={{ ...fCell, width: FW.flag, justifyContent: 'center', padding: 0 }} onClick={e => e.stopPropagation()}>
                          <FlagButton
                            flagged={!!entry.flagged}
                            reason={entry.flag_reason || ''}
                            onToggle={(next, reason) => toggleFlag(entry.id, next, reason ?? null)}
                            onSaveReason={(reason) => saveFlagReason(entry.id, reason)}
                            size="sm"
                            alwaysVisible
                          />
                        </div>
                        {/* Date */}
                        <div style={{ ...fCell, width: FW.date }}>
                          <input
                            type="date"
                            value={entry.invoice_date ? String(entry.invoice_date).slice(0, 10) : ''}
                            onChange={e => { e.stopPropagation(); saveField(entry.id, 'invoice_date', e.target.value) }}
                            onClick={e => e.stopPropagation()}
                            style={{ ...inlineSelect, fontWeight: 600, width: '100%', fontSize: 11, color: '#9ca3af' }}
                          />
                        </div>
                        {/* Payee — inline-editable, plus a link out to the
                            vendor's own page. The text cannot BE the link (it is
                            an input), so the link is an icon beside it, exactly
                            as the Artist cell two columns over already does.
                            John, 2026-09-02: "i also want links to each payees
                            vendor page inside."

                            A split CHILD shows no payee text — deliberately, so
                            the name is not repeated down a family — but it does
                            get the icon, resolved through its parent. It was the
                            only row in a split family from which the vendor was
                            unreachable, and a child is a slice of one vendor's
                            invoice like every other row in the group.

                            PayeeLink, so it opens in a NEW TAB: leaving costs
                            the bulk selection, the ~150 rows painted so far and
                            any inline edit mid-flight. (The Artist link below is
                            an in-place <Link> with the same problem. Left alone
                            on purpose — changing it is not what was asked, and
                            it is noted here so the inconsistency is not "fixed"
                            in the wrong direction.) */}
                        <div style={{ ...fCell, width: FW.payee, gap: 4 }}>
                          {isChild ? (
                            <span style={{ color: '#aaa', fontSize: 11, flex: 1, minWidth: 0 }}></span>
                          ) : (
                            <input
                              type="text"
                              value={entry.payee || ''}
                              onChange={e => { e.stopPropagation(); setEntries(prev => prev.map(x => x.id === entry.id ? { ...x, payee: e.target.value } : x)) }}
                              onBlur={e => { saveField(entry.id, 'payee', e.target.value); inlineBlurCollapse(e) }}
                              onClick={e => e.stopPropagation()}
                              style={{ ...inlineInput, fontWeight: 700, flex: 1, minWidth: 0 }}
                              onFocus={e => inlineFocusExpand(e, 280)}
                            />
                          )}
                          {(() => {
                            // A child carries no payee of its own, so resolve
                            // through the family root. entryById is built from
                            // `filtered` and isChild already requires the parent
                            // to be in that set, so this cannot miss.
                            const name = isChild
                              ? (entryById[entry.parent_id]?.payee || '')
                              : (entry.payee || '')
                            // Bank-half rows carry a cleaned bank descriptor as
                            // their payee, so PAYPAL / ACH / WIRE rows exist
                            // here too and must not offer a link to a page about
                            // a payment rail.
                            if (!name.trim() || isChannelOnlyPayee(name)) return null
                            return (
                              <PayeeLink payee={name}
                                style={{ flexShrink: 0, color: '#6366f1', display: 'inline-flex', alignItems: 'center', padding: '2px', borderRadius: 3, opacity: 0.65, transition: 'opacity 120ms' }}
                                onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                                onMouseLeave={e => e.currentTarget.style.opacity = '0.65'}
                              >
                                <ExternalLink size={11} />
                              </PayeeLink>
                            )
                          })()}
                          {isParent && (
                            <>
                              <span style={{ display: 'inline-block', background: '#dbeafe', color: '#1d4ed8', fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 20, marginLeft: 4, letterSpacing: '0.02em', flexShrink: 0 }}>
                                {children.length + 1}
                              </span>
                              <span style={{ fontSize: 10, color: '#a5b4fc', marginLeft: 3, flexShrink: 0 }}>
                                {expandedGroups.has(entry.id) ? '▼' : '▶'}
                              </span>
                            </>
                          )}
                        </div>
                        {/* Artist — inline-editable text + hyperlink to /artists/:id when name matches the roster.
                            Link only renders for known artists so typos / "feat." strings don't surface a broken affordance.
                            Children of a split each get their own link from their own entry.artist. Collapsed-split parents
                            stay rendered as "Multi" with no link (the underlying breakdown can have multiple artists). */}
                        <div style={{ ...fCell, width: FW.artist, paddingLeft: isChild ? 20 : 8, gap: 4 }}>
                          {isChild && <span style={{ color: '#a5b4fc', fontSize: 11, marginRight: 3, flexShrink: 0 }}>↳</span>}
                          {isParent && !expandedGroups.has(entry.id)
                            ? <span style={{ color: '#6366f1', fontWeight: 700, fontSize: 12 }}>Multi</span>
                            : (() => {
                                const matched = artistLinkFor(entry.artist)
                                return (
                                  <>
                                    <input
                                      type="text"
                                      value={entry.artist || ''}
                                      onChange={e => { e.stopPropagation(); setEntries(prev => prev.map(x => x.id === entry.id ? { ...x, artist: e.target.value } : x)) }}
                                      onBlur={e => { saveField(entry.id, 'artist', e.target.value); inlineBlurCollapse(e) }}
                                      onClick={e => e.stopPropagation()}
                                      style={{ ...inlineInput, flex: 1, minWidth: 0 }}
                                      onFocus={e => inlineFocusExpand(e, 240)}
                                    />
                                    {matched && (
                                      <Link
                                        to={`/artists/${matched.id}`}
                                        onClick={e => e.stopPropagation()}
                                        title={`Open ${matched.name}'s profile`}
                                        style={{ flexShrink: 0, color: '#6366f1', display: 'inline-flex', alignItems: 'center', padding: '2px', borderRadius: 3, opacity: 0.65, transition: 'opacity 120ms' }}
                                        onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                                        onMouseLeave={e => e.currentTarget.style.opacity = '0.65'}
                                      >
                                        <ExternalLink size={11} />
                                      </Link>
                                    )}
                                  </>
                                )
                              })()
                          }
                        </div>
                        {/* Amount */}
                        <div style={{ ...fCell, width: FW.amount, justifyContent: 'flex-end' }}>
                          {isParent && !expandedGroups.has(entry.id)
                            ? (() => {
                                // Family total in the parent's currency, USD
                                // suffix uses the locked rate that's stamped
                                // on every row of a paid family — fall back
                                // to live rates if not yet locked.
                                const total = children.reduce((s, c) => s + (Number(c.amount) || 0), Number(entry.amount) || 0)
                                const usd = usdSuffixForEntry({ amount: total, currency: entry.currency, fx_rate_to_usd: entry.fx_rate_to_usd }, fxRates, { precise: true })
                                return <span
                                  style={{ fontWeight: 900, color: RED, fontSize: 13, letterSpacing: '-0.01em' }}
                                  title={usd ? `Estimated USD${usd.trim().replace(/^\(|\)$/g, '').replace(/^≈\s*/, ': ')}` : undefined}
                                >{fmt(total, entry.currency)}</span>
                              })()
                            : editingAmountId === entry.id
                              ? (
                                <input
                                  type="number"
                                  step="0.01"
                                  autoFocus
                                  value={entry.amount || ''}
                                  onChange={e => { e.stopPropagation(); setEntries(prev => prev.map(x => x.id === entry.id ? { ...x, amount: e.target.value } : x)) }}
                                  onBlur={e => {
                                    saveField(entry.id, 'amount', e.target.value)
                                    e.target.style.background = 'transparent'
                                    e.target.style.boxShadow = 'none'
                                    setEditingAmountId(null)
                                  }}
                                  onKeyDown={e => { if (e.key === 'Escape' || e.key === 'Enter') e.target.blur() }}
                                  onClick={e => e.stopPropagation()}
                                  style={{ ...inlineInput, textAlign: 'right', fontWeight: 900, color: RED, width: '100%' }}
                                  onFocus={e => Object.assign(e.target.style, inlineInputFocus)}
                                  title={(() => {
                                    const u = usdSuffixForEntry(entry, fxRates, { precise: true })
                                    return u ? `Estimated USD${u.trim().replace(/^\(|\)$/g, '').replace(/^≈\s*/, ': ')}` : undefined
                                  })()}
                                />
                              )
                              : (
                                // Default view — formatted ($28,000.00) so the
                                // ledger column reads uniformly. Click swaps in
                                // the raw editable <input> above.
                                <span
                                  onClick={e => { e.stopPropagation(); setEditingAmountId(entry.id) }}
                                  style={{
                                    fontWeight: 900, color: RED, fontSize: 13,
                                    letterSpacing: '-0.01em', cursor: 'text',
                                    textAlign: 'right', width: '100%',
                                    fontVariantNumeric: 'tabular-nums',
                                  }}
                                  title={(() => {
                                    const u = usdSuffixForEntry(entry, fxRates, { precise: true })
                                    return u ? `Estimated USD${u.trim().replace(/^\(|\)$/g, '').replace(/^≈\s*/, ': ')}` : 'Click to edit'
                                  })()}
                                >{fmt(entry.amount, entry.currency)}</span>
                              )
                          }
                        </div>
                        {/* Currency */}
                        {vis('Currency') && (
                          <div style={{ ...fCell, width: FW.currency }}>
                            <select
                              value={(entry.currency || 'USD').toUpperCase()}
                              onChange={e => { e.stopPropagation(); saveField(entry.id, 'currency', e.target.value) }}
                              onClick={e => e.stopPropagation()}
                              style={{ ...inlineSelect, fontSize: 11, fontWeight: 700, color: '#9ca3af', width: '100%' }}
                            >
                              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                          </div>
                        )}
                      </div>
                    </td>

                    {/* ── Scrollable columns ── */}

                    {/* Description */}
                    {vis('Description') && (
                      <td style={{ ...TD, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', position: 'relative' }}>
                        {isChild ? '' : (
                          <input
                            type="text"
                            value={entry.description || ''}
                            onChange={e => { e.stopPropagation(); setEntries(prev => prev.map(x => x.id === entry.id ? { ...x, description: e.target.value } : x)) }}
                            onBlur={e => { saveField(entry.id, 'description', e.target.value); inlineBlurCollapse(e) }}
                            onClick={e => e.stopPropagation()}
                            placeholder="—"
                            title={entry.description || 'Click to edit'}
                            style={{ ...inlineInput, fontSize: 12, color: '#777' }}
                            onFocus={e => inlineFocusExpand(e, 320)}
                          />
                        )}
                      </td>
                    )}

                    {/* Category */}
                    <td style={{ ...TD, whiteSpace: 'nowrap', minWidth: 90 }}>
                      {isChild ? '' : (
                        <select
                          value={entry.category || ''}
                          onChange={e => { e.stopPropagation(); saveField(entry.id, 'category', e.target.value) }}
                          onClick={e => e.stopPropagation()}
                          style={{ ...inlineSelect, fontSize: 12 }}
                        >
                          <option value="">—</option>
                          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      )}
                    </td>

                    {/* Song */}
                    {vis('Song') && (
                      <td style={{ ...TD, minWidth: 140 }}>
                        {isParent && !expandedGroups.has(entry.id)
                          ? <span style={{ color: '#a5b4fc', fontWeight: 700 }}>Multi</span>
                          : (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              <input
                                type="text"
                                value={entry.song || ''}
                                onChange={e => { e.stopPropagation(); setEntries(prev => prev.map(x => x.id === entry.id ? { ...x, song: e.target.value } : x)) }}
                                onBlur={e => { saveField(entry.id, 'song', e.target.value); inlineBlurCollapse(e) }}
                                onClick={e => e.stopPropagation()}
                                style={{ ...inlineInput, fontSize: 12, color: entry.release_id ? RED : '#777' }}
                                onFocus={e => inlineFocusExpand(e, 280)}
                                // Native datalist suggests songs from releases
                                // + ledger entries, scoped to the row's artist
                                // when one is set, falling back to all songs.
                                // Free-typed values still save as-is.
                                list={songListId(entry.artist)}
                                autoComplete="off"
                              />
                              {entry.release_id && (
                                <Link
                                  to={`/releases/${entry.release_id}`}
                                  onClick={e => e.stopPropagation()}
                                  title="View release"
                                  style={{ flexShrink: 0, color: RED, display: 'flex' }}
                                >
                                  <ExternalLink style={{ width: 12, height: 12 }} />
                                </Link>
                              )}
                            </div>
                          )}
                      </td>
                    )}

                    {/* Inv # — and the "paid together" marker, which belongs
                        beside the invoice number because that is what a group
                        IS: several invoice numbers, one payment. */}
                    {vis('Inv #') && (
                      <td style={{ ...TD, minWidth: 80 }}>
                        <input
                          type="text"
                          value={entry.invoice_number || ''}
                          onChange={e => { e.stopPropagation(); setEntries(prev => prev.map(x => x.id === entry.id ? { ...x, invoice_number: e.target.value } : x)) }}
                          onBlur={e => { saveField(entry.id, 'invoice_number', e.target.value); inlineBlurCollapse(e) }}
                          onClick={e => e.stopPropagation()}
                          style={{ ...inlineInput, fontSize: 12, color: '#777' }}
                          onFocus={e => inlineFocusExpand(e, 240)}
                        />
                        {entry.settlement_group && (
                          <button type="button" disabled={bulkBusy}
                            onClick={e => { e.stopPropagation(); ungroupPayment(entry.settlement_group) }}
                            title={`Paid together with ${Math.max(1, (groupSizes.get(entry.settlement_group) || 2) - 1)} other invoice(s) — click to unmark`}
                            style={{
                              marginTop: 2, display: 'block', padding: '1px 5px', borderRadius: 5,
                              fontSize: 9.5, fontWeight: 800, letterSpacing: 0.3, fontFamily: 'inherit',
                              cursor: 'pointer', background: 'transparent', color: C.textFaint,
                              border: `1px solid ${C.border}`,
                            }}>
                            ONE PAYMENT · {groupSizes.get(entry.settlement_group) || 2} INVOICES
                          </button>
                        )}
                      </td>
                    )}

                    {/* ── Vendor ── */}

                    {/* Email */}
                    {vis('Email') && (
                      <td style={{ ...TD, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', position: 'relative' }}>
                        {isChild ? '' : (
                          <input
                            type="text"
                            value={entry.vendor_email || ''}
                            onChange={e => { e.stopPropagation(); setEntries(prev => prev.map(x => x.id === entry.id ? { ...x, vendor_email: e.target.value } : x)) }}
                            onBlur={e => { saveField(entry.id, 'vendor_email', e.target.value); inlineBlurCollapse(e) }}
                            onClick={e => e.stopPropagation()}
                            placeholder="—"
                            title={entry.vendor_email || ''}
                            style={{ ...inlineInput, fontSize: 12, color: '#16a34a' }}
                            onFocus={e => inlineFocusExpand(e, 320)}
                          />
                        )}
                      </td>
                    )}

                    {/* Address */}
                    {vis('Address') && (
                      <td style={{ ...TD, maxWidth: 150 }}>
                        {isChild ? '' : (
                          <input
                            type="text"
                            value={entry.vendor_address || ''}
                            onChange={e => { e.stopPropagation(); setEntries(prev => prev.map(x => x.id === entry.id ? { ...x, vendor_address: e.target.value } : x)) }}
                            onBlur={e => { saveField(entry.id, 'vendor_address', e.target.value); inlineBlurCollapse(e) }}
                            onClick={e => e.stopPropagation()}
                            placeholder="—"
                            title={entry.vendor_address || 'Click to edit'}
                            style={{ ...inlineInput, fontSize: 12, color: '#777' }}
                            onFocus={e => inlineFocusExpand(e, 360)}
                          />
                        )}
                      </td>
                    )}

                    {/* Bank */}
                    {vis('Bank') && (
                      <td style={{ ...TD, maxWidth: 150 }}>
                        {isChild ? '' : (
                          <input
                            type="text"
                            value={entry.vendor_bank || ''}
                            onChange={e => { e.stopPropagation(); setEntries(prev => prev.map(x => x.id === entry.id ? { ...x, vendor_bank: e.target.value } : x)) }}
                            onBlur={e => { saveField(entry.id, 'vendor_bank', e.target.value); inlineBlurCollapse(e) }}
                            onClick={e => e.stopPropagation()}
                            placeholder="—"
                            title={entry.vendor_bank || 'Click to edit'}
                            style={{ ...inlineInput, fontSize: 12, color: '#777' }}
                            onFocus={e => inlineFocusExpand(e, 280)}
                          />
                        )}
                      </td>
                    )}

                    {/* Socials — editable; vendor-supplied on submit, editable here.
                        Split children inherit (read-only) from the parent invoice,
                        filtered to entries tagged for THIS child's artist
                        (or untagged = shared). Socials live on the parent
                        row only. Parent row renders every handle so the
                        operator can retag as needed. */}
                    {vis('Socials') && (
                      <td style={{ ...TD, maxWidth: 200, fontSize: 12, color: '#777' }} onClick={e => e.stopPropagation()}>
                        {isChild ? (() => {
                          const parentHandles = Array.isArray(entryById[entry.parent_id]?.social_handles)
                            ? entryById[entry.parent_id].social_handles
                            : []
                          const relevant = filterSocialsForArtist(parentHandles, entry.artist)
                          if (!relevant.length) return '—'
                          const summary = relevant
                            .map(s => `${s.platform ? s.platform + ' ' : ''}${s.handle || ''}`)
                            .join(', ')
                          return (
                            <span
                              title={`${summary} (from parent invoice — filtered to ${entry.artist || 'this artist'})`}
                              style={{
                                fontSize: 12, color: '#9ca3af', maxWidth: 200,
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                display: 'inline-block',
                              }}
                            >
                              {summary}
                            </span>
                          )
                        })() : (
                          <SocialsCell
                            entry={entry}
                            C={C}
                            onSave={(id, handles) => saveField(id, 'social_handles', handles)}
                            familyArtists={familyArtists(entry)}
                          />
                        )}
                      </td>
                    )}

                    {/* Market Street Rep */}
                    {vis('Market Street Rep') && (
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        {isChild ? '' : (
                          <select
                            value={entry.boom_rep || ''}
                            onChange={e => { e.stopPropagation(); saveField(entry.id, 'boom_rep', e.target.value) }}
                            onClick={e => e.stopPropagation()}
                            style={{ ...inlineSelect, fontWeight: 600 }}
                          >
                            {REP_OPTIONS.map(r => <option key={r} value={r}>{r || '—'}</option>)}
                          </select>
                        )}
                      </td>
                    )}

                    {/* ── Payment ── */}

                    {/* Method */}
                    {vis('Method') && (
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        {isChild ? '' : (
                          <select
                            value={entry.payment_method || ''}
                            onChange={e => { e.stopPropagation(); saveField(entry.id, 'payment_method', e.target.value) }}
                            onClick={e => e.stopPropagation()}
                            style={inlineSelect}
                          >
                            {METHOD_OPTIONS.map(m => <option key={m} value={m}>{m || '—'}</option>)}
                          </select>
                        )}
                      </td>
                    )}

                    {/* Terms */}
                    {vis('Terms') && (
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        {isChild ? '' : (
                          <select
                            value={entry.payment_terms || ''}
                            onChange={e => {
                              e.stopPropagation()
                              const terms = e.target.value
                              saveField(entry.id, 'payment_terms', terms)
                              if (terms === 'Net 15' || terms === 'Net 30') {
                                const due = calcDueDate(entry.invoice_date, terms)
                                if (due) saveField(entry.id, 'scheduled_payment_date', due)
                              } else if (terms === 'Hold') {
                                saveField(entry.id, 'scheduled_payment_date', '')
                              }
                            }}
                            onClick={e => e.stopPropagation()}
                            style={{ ...inlineSelect, fontWeight: 600, color: entry.payment_terms === 'Hold' ? '#dc2626' : '#9ca3af' }}
                          >
                            {PAYMENT_TERMS.map(t => <option key={t} value={t}>{t || '—'}</option>)}
                          </select>
                        )}
                      </td>
                    )}

                    {/* Due Date */}
                    {vis('Due Date') && (
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        {isChild ? '' : (() => {
                          const due = entry.scheduled_payment_date ? String(entry.scheduled_payment_date).slice(0, 10) : ''
                          const isOverdue = entry.payment_status !== 'Paid' && isPastLocal(due)
                          return (
                            <input
                              type="date"
                              value={due}
                              onChange={e => {
                                e.stopPropagation()
                                saveField(entry.id, 'scheduled_payment_date', e.target.value)
                                if (e.target.value && entry.payment_terms !== 'Net 15' && entry.payment_terms !== 'Net 30') {
                                  saveField(entry.id, 'payment_terms', 'Custom')
                                }
                              }}
                              onClick={e => e.stopPropagation()}
                              style={{ ...inlineSelect, fontWeight: 600, width: 110, color: isOverdue ? '#dc2626' : '#9ca3af' }}
                            />
                          )
                        })()}
                      </td>
                    )}

                    {/* Paid? — the dot answers "and did it leave the bank?" */}
                    <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <PaidBadge
                          status={entry.payment_status}
                          onClick={e => { e.stopPropagation(); cyclePayment(entry) }}
                        />
                        <BankEvidenceDot
                          row={entry}
                          onClick={canUnmatch && entry.bank_evidence
                            ? (ev) => setMatchPop({ entry, rect: ev.currentTarget.getBoundingClientRect() })
                            : null}
                        />
                      </span>
                    </td>

                    {/* Paid By */}
                    {vis('Paid By') && (
                      <td style={{ ...TD, minWidth: 70 }}>
                        <input
                          type="text"
                          value={entry.paid_by || ''}
                          onChange={e => { e.stopPropagation(); setEntries(prev => prev.map(x => x.id === entry.id ? { ...x, paid_by: e.target.value } : x)) }}
                          onBlur={e => { saveField(entry.id, 'paid_by', e.target.value); inlineBlurCollapse(e) }}
                          onClick={e => e.stopPropagation()}
                          placeholder="—"
                          style={{ ...inlineInput, fontSize: 12, fontWeight: 700, color: entry.paid_by ? '#15803d' : '#ccc' }}
                          onFocus={e => inlineFocusExpand(e, 200)}
                        />
                      </td>
                    )}

                    {/* Date Paid */}
                    {vis('Date Paid') && (
                      <td style={{ ...TD, fontSize: 12, color: '#9ca3af', whiteSpace: 'nowrap' }}>
                        <input
                          type="date"
                          value={entry.payment_date ? String(entry.payment_date).slice(0, 10) : ''}
                          onChange={e => { e.stopPropagation(); saveField(entry.id, 'payment_date', e.target.value) }}
                          onClick={e => e.stopPropagation()}
                          style={{ ...inlineSelect, fontWeight: 600, width: 90, fontSize: 11, color: '#9ca3af' }}
                        />
                      </td>
                    )}

                    {/* Pay Ref */}
                    {vis('Pay Ref') && (
                      <td style={{ ...TD, minWidth: 80 }}>
                        <input
                          type="text"
                          value={entry.payment_ref || ''}
                          onChange={e => { e.stopPropagation(); setEntries(prev => prev.map(x => x.id === entry.id ? { ...x, payment_ref: e.target.value } : x)) }}
                          onBlur={e => { saveField(entry.id, 'payment_ref', e.target.value); inlineBlurCollapse(e) }}
                          onClick={e => e.stopPropagation()}
                          placeholder="—"
                          title={entry.payment_ref || 'Payment reference'}
                          style={{ ...inlineInput, fontSize: 12, color: '#6366f1', fontWeight: 600 }}
                          onFocus={e => inlineFocusExpand(e, 240)}
                        />
                      </td>
                    )}

                    {/* ── Documents ── */}

                    {/* Inv */}
                    {vis('Inv') && (
                      <td style={{ ...TD, textAlign: 'center', whiteSpace: 'nowrap' }}>
                        <FileCell
                          // Split children never carry the family invoice —
                          // gate on the parent's flag so children show View
                          // (the href already targets the parent) instead of
                          // an Upload that silently replaced the family PDF.
                          hasFile={entry.has_invoice || (entry.parent_id ? !!entryById[entry.parent_id]?.has_invoice : false)}
                          href={`${apiBase}/bk/entries/${entry.parent_id || entry.id}/file/invoice`}
                          entryId={entry.parent_id || entry.id}
                          fileType="invoice"
                          onUploaded={handleFileUploaded}
                          onDeleted={handleFileDeleted}
                          onPreview={openPreview}
                        />
                      </td>
                    )}

                    {/* W9 */}
                    {vis('W9') && (
                      <td style={{ ...TD, textAlign: 'center', whiteSpace: 'nowrap' }}>
                        <FileCell
                          hasFile={entry.has_w9 || !!entry.w9_entry_id}
                          // 'shared' = W9 is on a different expense for the
                          // same vendor. Upload action targets this row so
                          // it ends up with its own W9 file.
                          isShared={!entry.has_w9 && !!entry.w9_entry_id}
                          href={`${apiBase}/bk/entries/${entry.w9_entry_id || entry.id}/file/w9`}
                          entryId={entry.id}
                          fileType="w9"
                          onUploaded={handleFileUploaded}
                          onDeleted={handleFileDeleted}
                          onPreview={openPreview}
                        />
                      </td>
                    )}

                    {/* Proof */}
                    {vis('Proof') && (
                      <td style={{ ...TD, textAlign: 'center', whiteSpace: 'nowrap' }}>
                        <FileCell
                          hasFile={entry.has_proof}
                          href={`${apiBase}/bk/entries/${entry.id}/file/proof`}
                          entryId={entry.id}
                          fileType="proof"
                          onUploaded={handleFileUploaded}
                          onDeleted={handleFileDeleted}
                          onPreview={openPreview}
                        />
                      </td>
                    )}

                    {/* Receipt */}
                    {vis('Receipt') && (
                      <td style={{ ...TD, textAlign: 'center', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                        {/* Reimbursements always get the cell (upload is part of
                            the flow). An INVOICE gets it only once it actually
                            has files — which it now can, because the vendor
                            submit form grew an "Additional Files" box and those
                            land here as entity_files. Before this, a vendor
                            could attach nine supporting documents to an invoice
                            and the ledger showed "N/A". */}
                        {entry.is_reimbursement || entry.receipt_count > 0 ? (
                          <ReceiptCell
                            entry={entry}
                            apiBase={apiBase}
                            C={C}
                            onView={openPreview}
                            onViewMulti={openPreviewMulti}
                            onUploaded={handleReceiptUploaded}
                            onRemoved={handleReceiptRemoved}
                          />
                        ) : (
                          <span style={{ fontSize: 11, color: '#9ca3af' }}>N/A</span>
                        )}
                      </td>
                    )}

                    {/* ── Tracking ── */}

                    {/* Reimb? */}
                    {vis('Reimb?') && (
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        {isChild ? '' : (
                          <YNBadge
                            value={entry.is_reimbursement}
                            trueValue={true}
                            onClick={e => { e.stopPropagation(); saveField(entry.id, 'is_reimbursement', !entry.is_reimbursement) }}
                          />
                        )}
                      </td>
                    )}

                    {/* QB? */}
                    {vis('QB?') && (
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        {isChild ? '' : (
                          <YNBadge
                            value={entry.in_quickbooks}
                            onClick={e => { e.stopPropagation(); saveField(entry.id, 'in_quickbooks', entry.in_quickbooks === 'Yes' ? 'No' : 'Yes') }}
                          />
                        )}
                      </td>
                    )}

                    {/* Recoupable? */}
                    {/* Recoupable / UFR / Campaign / Cobrand / Bulk render
                        on split CHILDREN too — these are per-row columns,
                        and a split invoice is often mixed: half recoupable
                        half not, half campaign spend half not. Each slice
                        carries its own toggle. */}
                    {vis('Recoupable?') && (
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        <YNBadge
                          value={entry.recoupable}
                          trueValue={true}
                          onClick={e => { e.stopPropagation(); saveField(entry.id, 'recoupable', !entry.recoupable) }}
                        />
                      </td>
                    )}

                    {/* UFR? */}
                    {vis('UFR?') && (
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        {!entry.recoupable ? (
                          <span style={{ ...badgeBase, background: '#f3f4f6', color: '#9ca3af' }}>N/A</span>
                        ) : (
                          <YNBadge
                            value={entry.ufr}
                            onClick={e => { e.stopPropagation(); saveField(entry.id, 'ufr', entry.ufr === 'Yes' ? 'No' : 'Yes') }}
                          />
                        )}
                      </td>
                    )}

                    {/* Artist Campaign? — curator's Y/N tag for whether
                        this row is artist marketing spend. Independent
                        of UFR / recoupable.
                        Three states: 'Yes', 'No', or null (unset). Null
                        renders as a subtle dash to distinguish "no
                        answer yet" from an explicit 'No'. Click cycles:
                        unset → Yes → No → unset. */}
                    {vis('Campaign?') && (
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        {(() => {
                          const v = entry.artist_campaign
                          const cycle = v === 'Yes' ? 'No' : v === 'No' ? null : 'Yes'
                          const style = v === 'Yes' ? YN_YES : v === 'No' ? YN_NO : { bg: '#f9fafb', color: '#d1d5db' }
                          const label = v === 'Yes' ? 'Yes' : v === 'No' ? 'No' : '—'
                          return (
                            <span
                              onClick={e => { e.stopPropagation(); saveField(entry.id, 'artist_campaign', cycle) }}
                              title={v ? `Marked ${v} — click to change` : 'Unclassified — click to mark Yes'}
                              style={{ ...badgeBase, background: style.bg, color: style.color, cursor: 'pointer' }}
                            >
                              {label}
                            </span>
                          )
                        })()}
                      </td>
                    )}

                    {/* Recoupment label (aka "Tone Labels" in the UI) — set
                        on the Recoupments page; read-only here so the Ledger
                        acts as the verification surface when the user batch-
                        labels items for recoupment upload. */}
                    {vis('Tone Labels') && (
                      <td style={{ ...TD, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={entry.recoupment_label || ''}>
                        {entry.recoupment_label
                          ? <span style={{ ...badgeBase, background: '#e0e7ff', color: '#3730a3', fontSize: 11, fontWeight: 600 }}>{entry.recoupment_label}</span>
                          : <span style={{ color: '#d1d5db' }}>—</span>}
                      </td>
                    )}

                    {/* Cobrand? */}
                    {vis('Cobrand?') && (
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        <YNBadge
                          value={entry.cobrand}
                          trueValue={true}
                          yesStyle={YN_BLUE_YES}
                          onClick={e => {
                            e.stopPropagation()
                            const turningOn = !entry.cobrand
                            saveField(entry.id, 'cobrand', turningOn)
                            // Server forces category=Marketing on cobrand — mirror locally.
                            if (turningOn) setEntries(prev => prev.map(x => x.id === entry.id ? { ...x, category: 'Marketing' } : x))
                          }}
                        />
                      </td>
                    )}

                    {/* Bulk Deal? */}
                    {vis('Bulk Deal?') && (
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        <YNBadge
                          value={entry.is_bulk_deal}
                          trueValue={true}
                          yesStyle={YN_BLUE_YES}
                          onClick={e => { e.stopPropagation(); saveField(entry.id, 'is_bulk_deal', !entry.is_bulk_deal) }}
                        />
                      </td>
                    )}

                    {/* ── Meta ── */}

                    {/* Notes */}
                    <td style={{ ...TD, minWidth: 100, maxWidth: 200 }}>
                      <input
                        type="text"
                        value={entry.notes || ''}
                        onChange={e => { e.stopPropagation(); setEntries(prev => prev.map(x => x.id === entry.id ? { ...x, notes: e.target.value } : x)) }}
                        onBlur={e => { saveField(entry.id, 'notes', e.target.value); inlineBlurCollapse(e) }}
                        onClick={e => e.stopPropagation()}
                        placeholder="—"
                        style={{ ...inlineInput, fontSize: 12, color: '#777' }}
                        onFocus={e => inlineFocusExpand(e, 400)}
                      />
                    </td>


                    {/* Source — how the row landed on the ledger. Label,
                        palette, tooltip and priority all come from
                        SOURCE_BUCKETS + sourceBucketKey(), which the Source
                        filter reads too, so the column and the filter answer
                        the question identically by construction. The flag
                        column stays separate from any of these badges. */}
                    {/* ── Bank-only cells ────────────────────────────────
                        All three read entry.bank_evidence, already on every
                        /bk/entries row via the shared bankEvidenceCols() helper —
                        no extra join and no extra request. It resolves a split
                        child through COALESCE(parent_id, id), so a child shows
                        its family's bank line instead of a blank. */}
                    {bank && vis('Statement') && (
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        {entry.bank_evidence ? (
                          <a
                            href={`/bk/bank-matching?statement=${entry.bank_evidence.statement_id}`}
                            title="Open Bank Matching on the statement this entry was created from"
                            style={{ color: C.textMuted || '#777', textDecoration: 'none', fontSize: 12 }}
                          >
                            {acctLabel(entry.bank_evidence.account)}
                            {entry.bank_evidence.period_start
                              ? ` ${stmtLabel({ period_start: entry.bank_evidence.period_start })}`
                              : ''}
                          </a>
                        ) : (
                          /* Stated, not blank. A bank-created entry with no live
                             transaction behind it means the row was dismissed or
                             re-parsed away — which is a real thing to notice, not
                             an empty cell. */
                          <span style={{ color: '#b91c1c', fontSize: 11, fontWeight: 700 }}
                            title="No live bank transaction points at this entry any more — its statement row may have been dismissed or removed by a re-parse.">
                            no bank line
                          </span>
                        )}
                      </td>
                    )}
                    {bank && vis('Bank line') && (
                      <td style={{ ...TD, whiteSpace: 'nowrap', fontSize: 12, color: C.textMuted || '#777' }}>
                        {entry.bank_evidence ? (
                          <a
                            href={`/bk/bank-matching?q=${encodeURIComponent(entry.payee || '')}&filter=booked`}
                            title="Find this line on Bank Matching — where unbooking and finding its invoice live"
                            style={{ color: 'inherit', textDecoration: 'none' }}
                          >
                            {fmtDate(entry.bank_evidence.txn_date)}
                          </a>
                        ) : ''}
                      </td>
                    )}
                    {bank && vis('Inv wanted?') && (
                      <td style={{ ...TD, textAlign: 'center' }}>
                        {/* no_invoice_expected is bank-mode only on the server, so
                            it is undefined on the invoiced half — hence the
                            explicit === true rather than a truthiness test. */}
                        {entry.no_invoice_expected === true ? (
                          <span style={{ fontSize: 10, fontWeight: 700, color: '#4b5563' }}
                            title="Answered: no document is coming for this one. It still counts as spending.">
                            no
                          </span>
                        ) : (
                          // The answer is now reachable from the question. This
                          // cell used to say "work it on Bank Matching", which is
                          // the detour the popover removes.
                          <button
                            type="button"
                            onClick={ev2 => {
                              ev2.stopPropagation()
                              // Same gate as the evidence dot: every action in
                              // that popover is behind isStrictAdmin on the
                              // server, so opening it for an Approver would offer
                              // four buttons that all come back 403.
                              if (!canUnmatch || !entry.bank_evidence) return
                              setMatchPop({ entry, rect: ev2.currentTarget.getBoundingClientRect() })
                            }}
                            title={canUnmatch && entry.bank_evidence
                              ? 'Still counted as needing a real invoice — attach one, or answer that none is coming'
                              : 'Still counted as needing a real invoice'}
                            style={{
                              fontSize: 10, fontWeight: 700, color: '#b45309',
                              background: 'none', border: 'none', padding: 0,
                              fontFamily: 'inherit',
                              cursor: (canUnmatch && entry.bank_evidence) ? 'pointer' : 'default',
                              textDecoration: (canUnmatch && entry.bank_evidence) ? 'underline dotted' : 'none',
                              textUnderlineOffset: 2,
                            }}>
                            yes
                          </button>
                        )}
                      </td>
                    )}
                    {vis('Source') && (
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        {isChild ? '' : (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {(() => {
                          const b = sourceBucket(sourceBucketKey(entry))
                          return (
                            <span
                              style={{
                                display: 'inline-flex', alignItems: 'center',
                                padding: '2px 8px', borderRadius: 4,
                                fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
                                textTransform: 'uppercase',
                                background: b.neutral
                                  ? (C.badgeNeutralBg || '#e5e7eb')
                                  : (isDark && b.bgDark ? b.bgDark : b.bg),
                                color: b.neutral
                                  ? (C.badgeNeutralText || '#4b5563')
                                  : (isDark && b.colorDark ? b.colorDark : b.color),
                              }}
                              title={b.title}
                            >
                              {b.label}
                            </span>
                          )
                        })()}
                        {/* Bulk-deal key — coexists with the source badge
                            since a bulk deal can arrive from any origin, but
                            NOT with the Bulk? column, which says the same thing
                            one cell to the left. John, 2026-09-01: "in the
                            ledger bulk appears twice." The chip stays for the
                            common case, because Source is on by default and
                            Bulk? is not; turning that column on is what makes
                            the chip redundant. */}
                        {entry.is_bulk_deal && !vis('Bulk Deal?') && (
                          <span
                            style={{
                              display: 'inline-flex', alignItems: 'center',
                              padding: '2px 8px', borderRadius: 4,
                              fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
                              textTransform: 'uppercase',
                              background: isDark ? '#123f3c' : '#ccfbf1',
                              color: isDark ? '#99f6e4' : '#0f766e',
                            }}
                            title={`Bulk deal${entry.bulk_deal_quantity ? ` — ${entry.bulk_deal_quantity} ${entry.bulk_deal_unit || 'deliverables'}` : ''} — tracked on the Bulk Deals page`}
                          >
                            Bulk
                          </span>
                        )}
                        </span>
                        )}
                      </td>
                    )}

                    {/* Approved By */}
                    {vis('Approved By') && (
                      <td style={{ ...TD, fontSize: 12, whiteSpace: 'nowrap' }}>
                        {isChild ? '' : (
                          entry.approved_by
                            ? <span style={{ color: '#15803d', fontWeight: 700 }}>{entry.approved_by}</span>
                            : <span style={{ color: '#ccc' }}>—</span>
                        )}
                      </td>
                    )}

                    {/* Uploaded */}
                    {vis('Uploaded') && (
                      <td style={{ ...TD, fontSize: 12, color: '#9ca3af', whiteSpace: 'nowrap' }}>
                        {isChild ? '' : fmtShortDate(entry.created_at || entry.date_uploaded)}
                      </td>
                    )}

                    {/* ── What the vendor typed on the submit form ──────────
                        READ-ONLY, unlike the vendor-contact columns above.
                        These are a record of what somebody stated when they
                        asked to be paid; the bank fields in particular are
                        mirrored in an encrypted profile that the ledger has no
                        write path to, so an editable cell here would let the
                        two disagree with no way to tell which is true. Correct
                        them where they were entered.

                        A split CHILD shows the family's answers rather than
                        blanks: the submission belongs to the whole invoice, and
                        the child rows are our own internal division of it. */}
                    {(() => {
                      // Every cell below reads the same two places, so resolve
                      // them once per row rather than per column.
                      const src = isChild ? (entryById[entry.parent_id] || entry) : entry
                      const snap = (src.payment_snapshot && typeof src.payment_snapshot === 'object')
                        ? src.payment_snapshot : {}
                      const cell = (value, extra = {}) => (
                        <td style={{ ...TD, fontSize: 12, color: '#777', maxWidth: 170, whiteSpace: 'nowrap',
                          overflow: 'hidden', textOverflow: 'ellipsis', ...extra.td }}
                          title={value ? String(value) : extra.emptyTitle}>
                          {value ? String(value) : <span style={{ color: '#ccc' }}>—</span>}
                        </td>
                      )
                      // One sentence, used on every empty payment cell: the
                      // difference between "they didn't say" and "we hadn't
                      // started asking" is the whole reason these read blank on
                      // older invoices.
                      const notCaptured = 'Blank means this invoice was submitted before the form collected it '
                        + '(the per-invoice payment record starts 2026-08-31). It is not a missing answer, and it '
                        + 'deliberately does not fall back to the vendor’s current details.'
                      const payCheck = (src.payment_check && typeof src.payment_check === 'object')
                        ? src.payment_check : null
                      const verdictStyle = {
                        match:     { color: '#15803d', label: 'Match' },
                        mismatch:  { color: '#dc2626', label: 'Mismatch' },
                        absent:    { color: '#9ca3af', label: 'Not on invoice' },
                        unscanned: { color: '#9ca3af', label: 'Not scanned' },
                      }
                      return (
                        <>
                          {vis('Vendor Name')   && cell(src.vendor_name,
                            { emptyTitle: 'The name typed on the submit form. Blank on rows that did not come from it.' })}
                          {vis('CC Emails')     && cell(src.vendor_cc_emails,
                            { emptyTitle: 'Extra addresses this vendor asked us to copy. Saved per vendor, so they follow every invoice of theirs.' })}
                          {vis('Acct Type')     && cell(snap.account_type, { emptyTitle: notCaptured })}
                          {vis('Acct Holder')   && cell(snap.holder_name, { emptyTitle: notCaptured })}
                          {vis('Acct Last4')    && cell(
                            (src.payment_last4 || snap.last4) ? `••${src.payment_last4 || snap.last4}` : '',
                            { emptyTitle: notCaptured,
                              td: { fontVariantNumeric: 'tabular-nums', maxWidth: 90 } })}
                          {vis('Wire Scope')    && cell(snap.wire_scope, { emptyTitle: notCaptured })}
                          {vis('Bank Address')  && cell(snap.bank_address, { emptyTitle: notCaptured })}
                          {vis('Benef Address') && cell(snap.beneficiary_address, { emptyTitle: notCaptured })}
                          {vis('Intermediary')  && cell(snap.intermediary_bank, { emptyTitle: notCaptured })}
                          {vis('PayPal')        && cell(snap.paypal, { emptyTitle: notCaptured })}
                          {/* Did the invoice they uploaded agree with the
                              details they typed? A mismatch is the one state
                              here worth red — it is the redirected-payment
                              shape. The other three are facts, not problems. */}
                          {vis('Pay Check') && (
                            <td style={{ ...TD, fontSize: 12, whiteSpace: 'nowrap' }}
                              title={payCheck
                                ? `Typed ••${payCheck.typed_last4 || '?'}`
                                  + (payCheck.doc_last4 ? ` · invoice shows ••${payCheck.doc_last4}` : ' · the invoice showed none')
                                  + (payCheck.doc_other_methods?.length
                                    ? ` (it did show ${payCheck.doc_other_methods.join(', ')} details)` : '')
                                : 'Checked at submission, on invoices sent since the form started asking for payment details.'}>
                              {payCheck
                                ? <span style={{ fontWeight: 700, color: (verdictStyle[payCheck.verdict] || {}).color || '#9ca3af' }}>
                                    {(verdictStyle[payCheck.verdict] || {}).label || payCheck.verdict}
                                  </span>
                                : <span style={{ color: '#ccc' }}>—</span>}
                            </td>
                          )}
                          {/* An artist the vendor typed that is not on the
                              roster. Worth a column because it is the one
                              answer on the form nobody else validates. */}
                          {vis('Off Roster?') && (
                            <td style={{ ...TD, fontSize: 12, whiteSpace: 'nowrap' }}>
                              {src.off_roster_artist
                                ? <span style={{ fontWeight: 700, color: '#b45309' }}
                                    title="The artist named on this submission was not on the roster when it arrived.">Yes</span>
                                : <span style={{ color: '#ccc' }}>—</span>}
                            </td>
                          )}
                          {/* Supporting documents the vendor attached alongside
                              the invoice itself — counted apart from an
                              admin-added reimbursement receipt by the label
                              vendor-submit writes. */}
                          {vis('Attachments') && (
                            <td style={{ ...TD, fontSize: 12, textAlign: 'center', whiteSpace: 'nowrap' }}
                              title={src.vendor_file_count
                                ? `${src.vendor_file_count} supporting file${src.vendor_file_count === 1 ? '' : 's'} the vendor attached — open the entry to view them.`
                                : 'No extra files came with this submission.'}>
                              {src.vendor_file_count
                                ? <span style={{ fontWeight: 700, color: C.text }}>{src.vendor_file_count}</span>
                                : <span style={{ color: '#ccc' }}>—</span>}
                            </td>
                          )}
                        </>
                      )
                    })()}


                    {/* Actions */}
                    <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                            {/* Staged in the recoupment plan (this browser) —
                                deep-link to its spot on the Planning page.
                                Renders on children too: plan items are
                                per-row, not per-family. */}
                            {planIds.has(entry.id) && (
                              <button
                                onClick={e => { e.stopPropagation(); navigate(`/recoupments/planning?artist=${encodeURIComponent((entry.artist || '').trim().toLowerCase())}&focus=${entry.id}`) }}
                                title="In the recoupment plan — open on the Planning page"
                                style={{ background: 'none', border: '1.5px solid transparent', color: '#a855f7', borderRadius: 5, padding: '4px 7px', cursor: 'pointer', transition: 'all 0.15s', display: 'flex', alignItems: 'center' }}
                                onMouseEnter={e => { e.currentTarget.style.borderColor = '#a855f7'; e.currentTarget.style.background = '#faf5ff' }}
                                onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.background = 'none' }}
                              >
                                <ClipboardList style={{ width: 13, height: 13 }} />
                              </button>
                            )}
                            {!isChild && (
                            <>
                            <button
                              onClick={e => { e.stopPropagation(); openSplitModal(entry) }}
                              title="Split between artists"
                              style={{ background: 'none', border: '1.5px solid transparent', color: '#ccc', borderRadius: 5, padding: '4px 7px', cursor: 'pointer', transition: 'all 0.15s', display: 'flex', alignItems: 'center' }}
                              onMouseEnter={e => { e.currentTarget.style.borderColor = '#6366f1'; e.currentTarget.style.color = '#6366f1'; e.currentTarget.style.background = '#eef2ff' }}
                              onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.color = '#ccc'; e.currentTarget.style.background = 'none' }}
                            >
                              <Scissors style={{ width: 13, height: 13 }} />
                            </button>
                            {isAdmin && (idsWithChildren.has(entry.id) || (Array.isArray(entry.artist_breakdown) && entry.artist_breakdown.length >= 2)) && (
                              <button
                                onClick={e => { e.stopPropagation(); unsplitEntry(entry) }}
                                title="Unsplit — combine children back into one row (use when commas in a song name were misread as separators)"
                                style={{ background: 'none', border: '1.5px solid transparent', color: '#ccc', borderRadius: 5, padding: '4px 7px', cursor: 'pointer', transition: 'all 0.15s', display: 'flex', alignItems: 'center' }}
                                onMouseEnter={e => { e.currentTarget.style.borderColor = '#a855f7'; e.currentTarget.style.color = '#a855f7'; e.currentTarget.style.background = '#faf5ff' }}
                                onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.color = '#ccc'; e.currentTarget.style.background = 'none' }}
                              >
                                <Undo2 style={{ width: 13, height: 13 }} />
                              </button>
                            )}
                            {isAdmin && !entry.is_reimbursement && !entry.parent_id && !idsWithChildren.has(entry.id) && (
                              <button
                                onClick={e => { e.stopPropagation(); openFeeReimbModal(entry) }}
                                title="Carve off reimbursement portion"
                                style={{ background: 'none', border: '1.5px solid transparent', color: '#ccc', borderRadius: 5, padding: '4px 7px', cursor: 'pointer', transition: 'all 0.15s', display: 'flex', alignItems: 'center' }}
                                onMouseEnter={e => { e.currentTarget.style.borderColor = '#0ea5e9'; e.currentTarget.style.color = '#0ea5e9'; e.currentTarget.style.background = '#f0f9ff' }}
                                onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.color = '#ccc'; e.currentTarget.style.background = 'none' }}
                              >
                                <Receipt style={{ width: 13, height: 13 }} />
                              </button>
                            )}
                            {isAdmin && (
                            <>
                            <button
                              onClick={e => { e.stopPropagation(); toggleVoid(entry) }}
                              title={entry.voided
                                ? `Un-void (currently voided${entry.voided_by ? ` by ${entry.voided_by}` : ''}). Returns to the Payment Dashboard.`
                                : 'Void invoice — keeps it on the ledger but removes it from the Payment Dashboard.'}
                              style={{
                                background: entry.voided ? '#f3f4f6' : 'none',
                                border: '1.5px solid ' + (entry.voided ? '#9ca3af' : 'transparent'),
                                color: entry.voided ? '#6b7280' : '#ccc',
                                borderRadius: 5, padding: '4px 7px', cursor: 'pointer', transition: 'all 0.15s', display: 'flex', alignItems: 'center',
                              }}
                              onMouseEnter={e => { e.currentTarget.style.borderColor = '#6b7280'; e.currentTarget.style.color = '#6b7280'; e.currentTarget.style.background = '#f3f4f6' }}
                              onMouseLeave={e => { e.currentTarget.style.borderColor = entry.voided ? '#9ca3af' : 'transparent'; e.currentTarget.style.color = entry.voided ? '#6b7280' : '#ccc'; e.currentTarget.style.background = entry.voided ? '#f3f4f6' : 'none' }}
                            >
                              {entry.voided ? <RotateCcw style={{ width: 13, height: 13 }} /> : <Ban style={{ width: 13, height: 13 }} />}
                            </button>
                            <button
                              onClick={e => { e.stopPropagation(); setPendingDelete(entry) }}
                              style={{ background: 'none', border: '1.5px solid transparent', color: '#ccc', borderRadius: 5, padding: '4px 7px', cursor: 'pointer', transition: 'all 0.15s', display: 'flex', alignItems: 'center' }}
                              onMouseEnter={e => { e.currentTarget.style.borderColor = '#dc2626'; e.currentTarget.style.color = '#dc2626'; e.currentTarget.style.background = '#fef2f2' }}
                              onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.color = '#ccc'; e.currentTarget.style.background = 'none' }}
                            >
                              <Trash2 style={{ width: 13, height: 13 }} />
                            </button>
                            </>
                            )}
                            </>
                            )}
                          </div>
                      </td>
                  </tr>
                )
              })}
              {/* Sentinel. Coming into view (600px early) paints the next 150
                  rows. The row count is stated rather than left to guess, so a
                  short-looking ledger reads as "still painting", not "missing
                  data" — the TOTAL below already covers every matching row. */}
              {moreToRender > 0 && (
                <tr ref={growSentinelRef}>
                  <td colSpan={40} style={{ padding: '10px 12px', textAlign: 'center', fontSize: 11.5, color: C.textFaint }}>
                    showing {shown.length.toLocaleString()} of {renderable.length.toLocaleString()} rows — scroll for more
                  </td>
                </tr>
              )}

              {/* ── The bank lines with no editable row on this half ───────────
                  The 38% the page could not show: matched to an invoice (their
                  expense lives on the invoiced ledger), dismissed, still open, and
                  the whole credit side.

                  REDUCED on purpose. These have no expense id, so they get no
                  inline editors and no bulk checkbox — an editor here would fire
                  `PUT /bk/entries/undefined` on blur, and a checkbox would feed
                  the bulk endpoint an id it cannot use. What they get instead is
                  the answer each one actually needs. */}
              {extraTx.length > 0 && (
                <>
                  <tr>
                    <td colSpan={40} style={{
                      padding: '8px 12px', background: C.elevBg,
                      borderTop: `2px solid ${C.border}`, borderBottom: `1px solid ${C.tdBorder}`,
                      fontSize: 10.5, fontWeight: 700, color: C.textFaint,
                      textTransform: 'uppercase', letterSpacing: '.05em',
                    }}>
                      {extraTx.length} more line{extraTx.length === 1 ? '' : 's'} on this statement — no ledger row here
                      <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400, marginLeft: 8 }}>
                        matched invoices live on the ledger; dismissed and open lines never had an entry
                      </span>
                    </td>
                  </tr>
                  {extraTx.map(t => (
                    <ExtraTxRow
                      key={`tx-${t.id}`}
                      t={t}
                      disposition={dispositionOf(t)}
                      C={C} RED={RED} FW={FW} fCell={fCell} TD={TD}
                      busy={matchBusy}
                      canAct={canUnmatch}
                      onDismiss={() => dismissTx(t, false)}
                      onUndismiss={() => dismissTx(t, true)}
                      onBookIncome={() => setIncomePick({ t })}
                      onUnbookIncome={() => unbookIncomeTx(t)}
                      onMatch={() => setTxMatch({ t })}
                    />
                  ))}
                </>
              )}
            </tbody>

            {/* Totals footer */}
            {sortedCurrencies.length > 0 && (
              <tfoot>
                <tr>
                  <td style={{ padding: 0, position: 'sticky', left: 0, zIndex: 1, background: C.elevBg, borderTop: `2px solid ${C.border}`, boxShadow: C.shadow }}>
                    <div style={{ display: 'flex', alignItems: 'center', padding: '10px 0' }}>
                      <div style={{ width: FW.pick + FW.flag + FW.date + FW.payee + FW.artist, textAlign: 'right', padding: '0 8px', fontSize: 12, fontWeight: 700, color: '#555' }}>TOTAL</div>
                      <div style={{ width: FW.amount + (vis('Currency') ? FW.currency : 0), textAlign: 'right', padding: '0 8px', fontWeight: 900, color: RED, whiteSpace: 'nowrap' }}>
                        {fmt(byCurrency[sortedCurrencies[0]], sortedCurrencies[0])}
                        {sortedCurrencies.length > 1 && (
                          <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400, marginLeft: 6 }}>
                            + {sortedCurrencies.slice(1).map(c => fmt(byCurrency[c], c)).join(' + ')}
                          </span>
                        )}
                        {/* USD-equivalent line — shows whenever the ledger
                            isn't already USD-only so the user has a single
                            number to think with even on mixed-currency views. */}
                        {usdItemsSuffix(filtered, fxRates) && (
                          <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 500, marginTop: 2 }}>
                            {usdItemsSuffix(filtered, fxRates).trim().replace(/^\(|\)$/g, '')}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td colSpan={99} style={{ borderTop: `2px solid ${C.border}`, background: C.elevBg }}>
                    {/* The TOTAL above sums the LEDGER rows — money out, in the
                        currencies they were paid in. With a statement selected the
                        page also lists lines that have no ledger row, and on the
                        In/Both settings it lists credits, so the footer has to say
                        what it is NOT counting.

                        In and out are stated apart and never netted. A single
                        "net" figure over a bank month is a number nobody can use:
                        it is neither what was spent nor what the balance did, and
                        the balance is already in the header above. */}
                    {bank && stmtId && stmtSummary && (
                      <div style={{ padding: '6px 12px', fontSize: 11, color: C.textFaint, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                        <span>
                          ledger rows above: <b style={{ color: C.textMuted }}>{filtered.length.toLocaleString()}</b>
                        </span>
                        {extraTx.length > 0 && (
                          <span>
                            plus <b style={{ color: C.textMuted }}>{extraTx.length.toLocaleString()}</b> line
                            {extraTx.length === 1 ? '' : 's'} with no ledger row, not in the total
                          </span>
                        )}
                        {(direction === 'in' || direction === 'both') && (
                          <span style={{ color: '#047857' }}>
                            money in this statement:{' '}
                            <b>{Number(stmtSummary.moneyIn.usd).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</b>
                            {' '}({stmtSummary.moneyIn.n} line{stmtSummary.moneyIn.n === 1 ? '' : 's'}) — counted apart, never netted
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>

      {/* ── Toast ────────────────────────────────────────────────────────── */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24,
          background: toast.isError ? '#dc2626' : toast.undoFn ? '#111' : '#16a34a',
          color: '#fff', padding: '12px 20px', borderRadius: 10,
          fontWeight: 600, fontSize: 13, zIndex: 999,
          boxShadow: '0 4px 20px rgba(0,0,0,.25)',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span>{toast.msg}</span>
          {toast.undoFn && (
            <button
              onClick={() => { toast.undoFn(); setToast(null) }}
              style={{ background: 'rgba(255,255,255,.2)', border: 'none', color: '#fff', padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Undo
            </button>
          )}
        </div>
      )}

      {/* ── Possible duplicate payment ─────────────────────────────────────
          Sits above the toast, not in it: the toast auto-dismisses and this
          needs to stay until it's read or acted on. 40 of the 184 known
          duplicate pairs were made exactly this way. */}
      {dupWarning && (
        <div style={{
          position: 'fixed', bottom: 84, right: 24, width: 380, zIndex: 999,
          background: C.cardBg, border: '1.5px solid rgba(139,92,246,.5)', borderRadius: 10,
          boxShadow: '0 8px 28px rgba(0,0,0,.2)', padding: 14,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: '#7c3aed' }}>Possible duplicate payment</span>
            <button onClick={() => setDupWarning(null)}
              style={{ background: 'none', border: 'none', color: C.textFaint, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>
              Dismiss
            </button>
          </div>
          <p style={{ fontSize: 12, color: C.text, margin: '6px 0 0', lineHeight: 1.45 }}>
            {dupWarning.count === 1 ? 'A bank row' : `${dupWarning.count} bank rows`} for{' '}
            <strong>{dupWarning.entry?.payee}</strong> at this amount{' '}
            {dupWarning.count === 1 ? 'is' : 'are'} already booked from a statement.
            This entry may be a second record of one payment.
          </p>
          <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', fontSize: 11.5, color: C.textFaint }}>
            {(dupWarning.candidates || []).slice(0, 3).map(c => (
              <li key={c.txn_id} style={{ fontFamily: 'ui-monospace, monospace' }}>
                {String(c.account || '').toUpperCase()} {c.txn_date} · ${Number(c.amount).toLocaleString()} · booked as #{c.holder_id}
              </li>
            ))}
            {(dupWarning.candidates || []).length > 3 && (
              <li>…and {dupWarning.count - 3} more</li>
            )}
          </ul>
          <a href="/flags?cat=duplicate_payments" style={{ display: 'inline-block', marginTop: 10, fontSize: 12, fontWeight: 800, color: '#7c3aed', textDecoration: 'none' }}>
            Review duplicate payments →
          </a>
        </div>
      )}

      {/* ── Delete confirm ────────────────────────────────────────────────── */}
      {pendingDelete && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 28, width: 360, boxShadow: '0 8px 32px rgba(0,0,0,.25)' }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Delete entry?</h3>
            <p style={{ color: '#777', fontSize: 13, marginBottom: 20, lineHeight: 1.5 }}>
              {pendingDelete.payee} — {fmt(pendingDelete.amount, pendingDelete.currency)}
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={handleDelete}
                style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 7, padding: '9px 18px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' }}>
                Delete
              </button>
              <button onClick={() => setPendingDelete(null)}
                style={{ background: '#f3f4f6', color: '#111', border: 'none', borderRadius: 7, padding: '9px 18px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Split modal ─────────────────────────────────────────────── */}
      {/* The dialog itself moved to components/SplitInvoiceModal.jsx when the
          Payments dashboard needed it too (John, 2026-09-01). Same component,
          same POST, so the two pages cannot drift on what a split is. What stays
          here is what this page knows: its own children (for the family total
          and the existing slices) and its song datalist. */}
      {splitEntry && (
        <SplitInvoiceModal
          entry={splitEntry}
          family={[splitEntry, ...entries.filter(e => e.parent_id === splitEntry.id && !e.deleted)]}
          C={C}
          songListId={songListId}
          onClose={() => setSplitEntry(null)}
          onError={(msg) => showToast(msg, true)}
          onDone={async (n) => {
            setSplitEntry(null)
            await fetchEntries()
            showToast(`Split into ${n} entries`)
          }}
        />
      )}

      {/* ── Fee + reimbursement carve-out modal ─────────────────────── */}
      {feeReimbEntry && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => !feeReimbBusy && setFeeReimbEntry(null)}>
          <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 28, width: 480, maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,.25)' }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Split fee + reimbursement</h3>
            <p style={{ color: '#777', fontSize: 13, marginBottom: 18, lineHeight: 1.5 }}>
              {feeReimbEntry.payee} — {fmt(feeReimbEntry.amount, feeReimbEntry.currency)}
              <br />
              <span style={{ fontSize: 12 }}>The invoice will stay as the fee portion. A reimbursement child will be created with the receipt you upload.</span>
            </p>

            <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: '#777', marginBottom: 4 }}>Fee amount</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={feeAmount}
                  onChange={e => setFeeAmount(e.target.value)}
                  placeholder="0.00"
                  style={{ width: '100%', padding: '8px 10px', border: '1.5px solid #e2e2e2', borderRadius: 7, fontSize: 13, fontFamily: 'inherit', outline: 'none', textAlign: 'right' }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: '#777', marginBottom: 4 }}>Reimbursement</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={reimbAmount}
                  onChange={e => setReimbAmount(e.target.value)}
                  placeholder="0.00"
                  style={{ width: '100%', padding: '8px 10px', border: '1.5px solid #e2e2e2', borderRadius: 7, fontSize: 13, fontFamily: 'inherit', outline: 'none', textAlign: 'right' }}
                />
              </div>
            </div>

            {(() => {
              const sum = (parseFloat(feeAmount) || 0) + (parseFloat(reimbAmount) || 0)
              const total = parseFloat(feeReimbEntry.amount) || 0
              const match = sum > 0 && Math.abs(sum - total) < 0.01
              return sum > 0 ? (
                <div style={{ fontSize: 12, fontWeight: 700, color: match ? '#15803d' : '#b45309', marginBottom: 14 }}>
                  Sum: {fmt(sum, feeReimbEntry.currency)}
                  {!match && <span style={{ fontWeight: 400, color: '#999', marginLeft: 6 }}>(invoice: {fmt(total, feeReimbEntry.currency)})</span>}
                </div>
              ) : null
            })()}

            <div style={{ marginBottom: 18 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: '#777', marginBottom: 4 }}>Receipt (PDF/JPG/PNG)</label>
              <input
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                onChange={e => setFeeReimbReceipt(e.target.files?.[0] || null)}
                style={{ width: '100%', fontSize: 13, fontFamily: 'inherit' }}
              />
              {feeReimbReceipt && (
                <div style={{ fontSize: 12, color: '#777', marginTop: 4 }}>{feeReimbReceipt.name}</div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={handleFeeReimbSplit}
                disabled={feeReimbBusy}
                style={{ background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 7, padding: '9px 18px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', opacity: feeReimbBusy ? 0.5 : 1 }}
              >
                {feeReimbBusy ? 'Splitting…' : 'Split'}
              </button>
              <button
                onClick={() => setFeeReimbEntry(null)}
                disabled={feeReimbBusy}
                style={{ background: '#f3f4f6', color: '#111', border: 'none', borderRadius: 7, padding: '9px 18px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* File preview modal */}
      {previewFile && (
        <FilePreview
          url={previewFile.url}
          filename={previewFile.filename}
          files={previewFile.files}
          onClose={() => setPreviewFile(null)}
        />
      )}

      {/* Bank-match popover. Portaled for the same reason SocialsCell and
          FlagButton are: this table scrolls horizontally and its sticky cells
          clip their children, so an in-flow popover would be cut off. */}
      {/* Matching an OPEN bank line to an invoice. A modal rather than the row's
          own popover: an open line is at the bottom of the table under the ledger
          rows, and a popover anchored there would open off-screen. */}
      {/* Booking a credit as income. A picker off the live vocabulary, not a text
          box: the server validates the type and refuses an unknown one rather
          than coercing it, so a free-text typo would be a rejected write at best
          and money on the wrong P&L line at worst. */}
      {incomePick && createPortal(
        (() => {
          const t = incomePick.t
          const money = Math.abs(Number(t.usd ?? t.amount_usd ?? t.amount ?? 0))
            .toLocaleString('en-US', { style: 'currency', currency: 'USD' })
          // The parser's guess goes FIRST when it is a real type, because it is
          // usually right and this is a list of a dozen.
          const suggested = t.suggested_income_type
            && INCOME_TYPES.some(x => x.toLowerCase() === String(t.suggested_income_type).toLowerCase())
            ? t.suggested_income_type : null
          const ordered = suggested
            ? [suggested, ...INCOME_TYPES.filter(x => x !== suggested)]
            : INCOME_TYPES
          return (
            <>
              <div onClick={() => setIncomePick(null)}
                style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 1000 }} />
              <div style={{
                position: 'fixed', top: '20vh', left: '50%', transform: 'translateX(-50%)',
                width: 'min(420px, 92vw)', zIndex: 1001, background: C.cardBg,
                border: `1.5px solid ${C.border}`, borderRadius: 12,
                boxShadow: '0 18px 48px rgba(0,0,0,.24)', padding: 16,
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                  Book this credit as income
                </div>
                <div style={{ fontSize: 14, fontWeight: 800, color: '#047857', marginTop: 4 }}>
                  {t.payee_guess || '—'} · +{money}
                </div>
                <div style={{ fontSize: 11, color: C.textFaint, marginBottom: 10 }}>
                  {String(t.txn_date || '').slice(0, 10)}
                  {t.description ? ` · ${String(t.description).slice(0, 80)}` : ''}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {ordered.map(type => (
                    <button key={type} type="button" disabled={matchBusy}
                      onClick={() => bookIncomeTx(t, type)}
                      style={{
                        padding: '6px 10px', borderRadius: 7, fontSize: 12, fontWeight: 700,
                        fontFamily: 'inherit', cursor: 'pointer',
                        background: type === suggested ? '#059669' : 'transparent',
                        color: type === suggested ? '#fff' : C.text,
                        border: `1.5px solid ${type === suggested ? '#059669' : C.border}`,
                        opacity: matchBusy ? 0.5 : 1,
                      }}>
                      {type}
                      {type === suggested && (
                        <span style={{ fontWeight: 400, opacity: 0.85 }}> · suggested</span>
                      )}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
                  <button type="button" onClick={() => setIncomePick(null)}
                    style={{ ...toolbarBtn, fontSize: 12, padding: '6px 12px' }}>Cancel</button>
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, color: C.textFaint }}>
                    Not income? Dismiss the line as a transfer.
                  </span>
                </div>
              </div>
            </>
          )
        })(),
        document.body
      )}

      {txMatch && createPortal(
        (() => {
          const t = txMatch.t
          const money = Math.abs(Number(t.usd ?? t.amount_usd ?? t.amount ?? 0))
            .toLocaleString('en-US', { style: 'currency', currency: 'USD' })
          return (
            <>
              <div onClick={() => { setTxMatch(null); setRematchQuery(''); setRematchResults([]) }}
                style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 1000 }} />
              <div style={{
                position: 'fixed', top: '18vh', left: '50%', transform: 'translateX(-50%)',
                width: 'min(520px, 92vw)', zIndex: 1001, background: C.cardBg,
                border: `1.5px solid ${C.border}`, borderRadius: 12,
                boxShadow: '0 18px 48px rgba(0,0,0,.24)', padding: 16,
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                  Which invoice does this settle?
                </div>
                <div style={{ fontSize: 14, fontWeight: 800, color: C.text, marginTop: 4 }}>
                  {t.payee_guess || '—'} · {money}
                </div>
                <div style={{ fontSize: 11, color: C.textFaint, marginBottom: 10 }}>
                  {String(t.txn_date || '').slice(0, 10)}
                  {t.description ? ` · ${String(t.description).slice(0, 90)}` : ''}
                </div>
                <input
                  autoFocus
                  value={rematchQuery}
                  onChange={e => { setRematchQuery(e.target.value); searchInvoices(e.target.value) }}
                  placeholder="Search invoices — payee or number"
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', background: C.inputBg, color: C.text, border: `1.5px solid ${C.border}` }}
                />
                <div style={{ marginTop: 8, maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {rematchResults.map(inv => (
                    <button key={inv.id} type="button" disabled={matchBusy}
                      onClick={() => matchTxToInvoice(t, inv)}
                      style={{ textAlign: 'left', padding: '7px 9px', borderRadius: 7, fontSize: 12.5, fontFamily: 'inherit', cursor: 'pointer', background: C.elevBg, color: C.text, border: `1px solid ${C.borderLight}` }}>
                      <span style={{ fontWeight: 700 }}>{inv.payee}</span>
                      <span style={{ color: C.textFaint }}>
                        {inv.invoice_number ? ` · inv ${inv.invoice_number}` : ''}
                        {' · '}{Number(inv.amount ?? 0).toLocaleString('en-US', { style: 'currency', currency: inv.currency || 'USD' })}
                        {inv.invoice_date ? ` · ${String(inv.invoice_date).slice(0, 10)}` : ''}
                      </span>
                    </button>
                  ))}
                  {rematchQuery.trim().length >= 2 && rematchResults.length === 0 && (
                    <div style={{ fontSize: 12, color: C.textFaint, padding: '6px 2px' }}>
                      No invoice matches. Only an invoiced row with a document can settle a bank line.
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button type="button" onClick={() => { setTxMatch(null); setRematchQuery(''); setRematchResults([]) }}
                    style={{ ...toolbarBtn, fontSize: 12, padding: '6px 12px' }}>
                    Cancel
                  </button>
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, color: C.textFaint, alignSelf: 'center' }}>
                    No invoice coming? Dismiss the line instead.
                  </span>
                </div>
              </div>
            </>
          )
        })(),
        document.body
      )}

      {matchPop && matchPop.entry.bank_evidence && createPortal(
        (() => {
          const e = matchPop.entry
          const ev = e.bank_evidence
          const acct = ev.account === 'bofa' ? 'Bank of America' : ev.account === 'paypal' ? 'PayPal' : String(ev.account || '').toUpperCase()
          const day = String(ev.txn_date || '').slice(0, 10)
          const btn = {
            flex: 1, borderRadius: 7, padding: '7px 10px', fontSize: 12, fontWeight: 700,
            fontFamily: 'inherit', cursor: matchBusy ? 'default' : 'pointer', opacity: matchBusy ? 0.5 : 1,
          }
          return (
            <>
              <div onClick={() => setMatchPop(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000 }} />
              <div
                onClick={ev2 => ev2.stopPropagation()}
                style={{
                  position: 'fixed',
                  top: Math.min(matchPop.rect.bottom + 6, window.innerHeight - 210),
                  left: Math.min(Math.max(matchPop.rect.left - 130, 8), window.innerWidth - 300),
                  width: 288, zIndex: 1001,
                  background: C.cardBg, border: `1.5px solid ${C.border}`, borderRadius: 10,
                  boxShadow: '0 10px 36px rgba(0,0,0,.18)', padding: 12,
                }}
              >
                <div style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
                  Bank-matched
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
                  {acct} · {day}
                </div>
                <div style={{ fontSize: 12, color: C.textFaint, marginBottom: 10 }}>
                  {Number(ev.amount ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
                  {ev.method ? ` · ${ev.method}` : ''}
                  {e.parent_id ? ' · matched on the parent invoice' : ''}
                </div>

                {/* Only say this when the two sources actually disagree. On a
                    correctly-Paid row the popover is just a review of the
                    match, and a warning there would be noise. */}
                {e.payment_status !== 'Paid' && (
                  <div style={{ fontSize: 11.5, lineHeight: 1.45, color: C.text, background: 'rgba(245,158,11,.12)', border: '1px solid rgba(245,158,11,.35)', borderRadius: 7, padding: '6px 8px', marginBottom: 10 }}>
                    The bank says this was paid, the ledger says {String(e.payment_status || 'Unpaid').toLowerCase()}. Either the match is wrong, or the status was never updated.
                  </div>
                )}

                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => unmatchBank(e)}
                    disabled={matchBusy}
                    title="The match is wrong — clear it. The bank row returns to the statements page and its spend moves to Unorganized on the P&L until it's booked again."
                    style={{ ...btn, background: 'transparent', color: '#e11d48', border: '1.5px solid rgba(225,29,72,.45)' }}
                  >
                    Unmatch
                  </button>
                  {e.payment_status !== 'Paid' && (
                    <button
                      onClick={() => markPaidFromBank(e)}
                      disabled={matchBusy}
                      title={`The match is right — mark this paid, dated ${day} from the statement`}
                      style={{ ...btn, background: '#059669', color: '#fff', border: '1.5px solid #059669' }}
                    >
                      Mark paid
                    </button>
                  )}
                </div>
                {/* ── Booked, not matched ────────────────────────────────
                    `method: 'created'` means this app INVENTED the entry from
                    the bank line: it has a ledger id but no document behind it.
                    Those are the only rows these three answers apply to — a real
                    match already has its invoice, and offering "attach one" there
                    would be a way to break it. */}
                {ev.method === 'created' && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.borderLight}` }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
                      No invoice behind it
                    </div>
                    <input
                      value={rematchQuery}
                      onChange={ev3 => { setRematchQuery(ev3.target.value); searchInvoices(ev3.target.value) }}
                      placeholder="Find the invoice — payee or number"
                      style={{ width: '100%', padding: '6px 8px', borderRadius: 7, fontSize: 12, fontFamily: 'inherit', background: C.inputBg, color: C.text, border: `1.5px solid ${C.border}`, marginBottom: 6 }}
                    />
                    {rematchResults.length > 0 && (
                      <div style={{ maxHeight: 132, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 7 }}>
                        {rematchResults.map(inv => (
                          <button key={inv.id} type="button" disabled={matchBusy}
                            onClick={() => rematchToInvoice(e, inv)}
                            title="Swap the invented booking for this invoice, in one operation"
                            style={{ textAlign: 'left', padding: '5px 7px', borderRadius: 6, fontSize: 11.5, fontFamily: 'inherit', cursor: 'pointer', background: C.elevBg, color: C.text, border: `1px solid ${C.borderLight}` }}>
                            <span style={{ fontWeight: 700 }}>{inv.payee}</span>
                            <span style={{ color: C.textFaint }}>
                              {inv.invoice_number ? ` · inv ${inv.invoice_number}` : ''}
                              {' · '}{Number(inv.amount ?? 0).toLocaleString('en-US', { style: 'currency', currency: inv.currency || 'USD' })}
                              {inv.invoice_date ? ` · ${String(inv.invoice_date).slice(0, 10)}` : ''}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                    {rematchQuery.trim().length >= 2 && rematchResults.length === 0 && (
                      <div style={{ fontSize: 11, color: C.textFaint, marginBottom: 7 }}>
                        No invoice matches. Only invoiced rows with a document can settle a bank line.
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => markNoInvoice(e)}
                        disabled={matchBusy}
                        title="No invoice is ever coming for this — payroll, rent, a card charge. Recorded as an answer so it leaves the needs-invoice queue."
                        style={{ ...btn, background: 'transparent', color: C.text, border: `1.5px solid ${C.border}` }}
                      >
                        No invoice needed
                      </button>
                      <button
                        onClick={() => unbookRow(e)}
                        disabled={matchBusy}
                        title="This booking should not exist — delete the entry and send the bank row back to Bank Matching"
                        style={{ ...btn, background: 'transparent', color: '#e11d48', border: '1.5px solid rgba(225,29,72,.45)' }}
                      >
                        Unbook
                      </button>
                    </div>
                  </div>
                )}
                <div style={{ fontSize: 10.5, color: C.textFaint, marginTop: 8, lineHeight: 1.4 }}>
                  Unmatching is remembered — the matcher won't propose this pair again.
                </div>
              </div>
            </>
          )
        })(),
        document.body,
      )}

      {/* Datalists for the Song cell. One per artist key visible in entries
          plus an `_all` fallback. Each row's <input list="..."> references
          one of these so the browser shows that artist's songs first. */}
      {songDatalists.map(dl => (
        <datalist key={dl.id} id={dl.id}>
          {dl.options.map(opt => <option key={opt} value={opt} />)}
        </datalist>
      ))}
    </div>
  )
}
